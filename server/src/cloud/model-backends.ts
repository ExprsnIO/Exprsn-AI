import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { clears, LABELS, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import type { ProviderFilterEvent } from '../gateway/provider-filter.js';
import type { InstanceRow } from '../gateway/repo.js';
import type { ServerReport } from '../gateway/server.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { ToolCallContext } from '../registry/dispatch.js';
import type { EntryRow } from '../registry/service.js';
import type { Services } from '../services.js';
import type { UsageInput, UsagePrice } from '../tenancy/quotas.js';
import { isVaultRef } from '../vault/policy.js';
import { AZURE_SCOPES } from './azure-calls.js';
import type { ProviderCredential } from './credentials.js';
import type { CloudModelCatalogue, CloudModelListing } from './model-catalogue.js';
import sheetJson from './price-sheet.json' with { type: 'json' };
import type { CloudAccount, Provider } from './types.js';

/*
 * 1.9.99-final, Sprint 60 (B-10502, B-10503, B-10509): `s.cloud.modelBackends`, the cloud model APIs that speak
 * Chat Completions, as `kind: openai` instances (the gateway's `OpenAIServer` with a flavour, `settings.cloud`):
 *
 *   azure         Azure OpenAI and AI Foundry deployments. Authentication: an Entra token for the Cognitive Services
 *                 scope from the account's credential (federated or a vaulted client secret, `s.cloud.credentials`,
 *                 purpose `read`), or the resource's API key from the vault (`auth: key`, the instance's token,
 *                 sent as `api-key`). The deployments are what ARM lists for the Cognitive Services account
 *                 (`settings.cloud.resourceId`, else the one whose endpoint is the instance's URL). The content
 *                 filter's blocks are recorded as guardrail decisions (`filtered`).
 *   digitalocean  GenAI serverless inference (`https://inference.do-ai.run`) with a model access key from the vault
 *                 (the instance's token). GenAI agents become registry tools (`impl: cloud-agent`): `publishAgent`
 *                 makes the draft entry, `run` calls the agent's endpoint with its access key once the dispatcher's
 *                 checks (schema, ceiling, rate, the tool-call checkpoint, approval) have passed.
 *   workers-ai    Cloudflare's OpenAI-compatible endpoint (`/client/v4/accounts/<id>/ai/v1/...`) with the account's
 *                 scoped token. A turn's neurons and their cost are put on its usage record at metering (`priceUsage`,
 *                 since Sprint 61 the one cloud model pricer in `cloud/model-prices.ts`, which prices every flavour).
 *
 * Nothing here runs until an instance with `settings.cloud.flavour` or a `cloud-agent` tool exists.
 */

interface NeuronSheet {
  models: Record<string, { input: number; output: number }>;
}
const SHEET = sheetJson as unknown as { currency: string; workersAi?: NeuronSheet };

// Sprint 61 (B-10505): neurons are priced by the one cloud model pricer (`cloud/model-prices.ts`); re-exported here.
export { NEURON_PRICE_ID, neuronCostMicros, workersAiNeurons } from './model-prices.js';

/** The body of `POST /api/admin/cloud/accounts/:id/agent-tools`. */
export const agentToolSchema = z
  .object({
    agent: z.string().trim().min(1).max(100),
    name: z.string().trim().regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/, 'lower case letters, digits, dots, dashes and underscores'),
    description: z.string().trim().max(2000).nullable().default(null),
    keyRef: z.string().trim().max(500),
    label: z.enum(LABELS).default('internal'),
    ratePerHour: z.number().int().min(1).max(100_000).nullable().default(null)
  })
  .strict();

export const AGENT_TOOL_INPUT = { type: 'object', properties: { prompt: { type: 'string', description: 'What to ask the agent, in full: it sees nothing else of this conversation.' } }, required: ['prompt'], additionalProperties: false } as const;

type Arm = { id: string; name: string; kind?: string; location?: string; properties?: Record<string, unknown>; sku?: { name?: string; capacity?: number } };
type DoAgent = { uuid: string; name: string; region?: string; deployment?: { url?: string; status?: string; visibility?: string }; model?: { name?: string; inference_name?: string } };

const origin = (u: string) => {
  try {
    return new URL(u).origin.toLowerCase();
  } catch {
    return '';
  }
};

export class CloudModelBackends {
  constructor(
    private readonly s: () => Services,
    readonly catalogue: CloudModelCatalogue
  ) {
    catalogue.register('azure', { listModels: (a) => this.listAzure(a) });
    catalogue.register('digitalocean', { listModels: (a) => this.listDigitalOcean(a) });
    catalogue.register('cloudflare', { listModels: (a) => this.listWorkersAi(a) });
  }

  /** Wires the gateway, metering and the dispatcher to these backends (createServices calls it once). */
  install(): void {
    const s = this.s();
    s.gateway.cloudModels = { auth: (row) => this.auth(row), models: (row) => this.azureInstanceModels(row), filtered: (e) => this.filtered(e) };
    // Sprint 61 (B-10505): every cloud model record is priced by one pricer (Workers AI neurons included).
    s.quotas.pricer = (u) => this.priceUsage(u);
    s.tools.useCloudAgents({ run: (ctx, entry, args) => this.runAgent(ctx, entry, args) });
  }

  // ---------- accounts, credentials, transports ----------

  private async usable(id: string, provider: Provider): Promise<CloudAccount> {
    const account = await this.s().cloud.accounts.get(id);
    if (!account) throw new HttpProblem(409, 'Conflict', 'The cloud account of this model server is gone or the cloud plane is not installed.', { extensions: { reason: 'no_account' } });
    if (account.provider !== provider) throw conflict(`${account.name} is a ${account.provider} account, not ${provider}.`);
    if (account.state === 'pending') throw conflict(`${account.name} waits for a second cloud admin's approval; it cannot be used yet.`);
    if (account.state === 'disabled') throw conflict(`${account.name} is disabled.`);
    return account;
  }

  private async credential(account: CloudAccount): Promise<ProviderCredential> {
    const c = this.s().cloud.credentials;
    if (!c) throw new HttpProblem(503, 'Not installed', 'Cloud credentials are not available on this server.', { extensions: { reason: 'cloud_component_missing' } });
    return (await c.for(account, 'read')) as ProviderCredential;
  }

  private transport(provider: Provider) {
    return this.s().cloud.providers.adapter(provider).then((a) => a.transport);
  }

  private async armBase(): Promise<string> {
    return (this.catalogue.endpoints.azureArm ?? ((await this.s().cloud.providers.adapter('azure')) as unknown as { arm: string }).arm).replace(/\/+$/, '');
  }

  private async arm<T>(account: CloudAccount, path: string): Promise<T> {
    const cred = await this.credential(account);
    if (cred.kind !== 'azure') throw conflict('An Azure account needs an Azure credential.');
    const token = await cred.getToken(AZURE_SCOPES.arm);
    const t = await this.transport('azure');
    const r = await t.json<T>({ method: 'GET', url: `${await this.armBase()}${path}`, headers: { authorization: `Bearer ${token.token}` }, accountId: account.id }, (status, b) => {
      const e = ((b ?? {}) as { error?: { code?: string; message?: string } }).error ?? {};
      return { message: `Azure answered ${status}${e.code ? ` (${e.code})` : ''}: ${(e.message ?? 'no detail').slice(0, 300)}`, code: e.code ?? null };
    });
    return r.body;
  }

  private async tokenApi<T>(account: CloudAccount, provider: 'digitalocean' | 'cloudflare', url: string): Promise<T> {
    const cred = await this.credential(account);
    if (cred.kind !== 'token') throw conflict(`A ${provider === 'digitalocean' ? 'DigitalOcean' : 'Cloudflare'} account needs an API token.`);
    const t = await this.transport(provider);
    const r = await t.json<T>({ method: 'GET', url, headers: { authorization: `Bearer ${cred.token}` }, accountId: account.id }, (status, b) => {
      const e = (b ?? {}) as { id?: string; message?: string; errors?: { code?: number; message?: string }[] };
      const msg = e.message ?? e.errors?.[0]?.message ?? 'no detail';
      return { message: `${provider === 'digitalocean' ? 'DigitalOcean' : 'Cloudflare'} answered ${status}: ${msg.slice(0, 300)}`, code: e.id ?? (e.errors?.[0]?.code != null ? String(e.errors[0].code) : null) };
    });
    return r.body;
  }

  private doApi = () => (this.catalogue.endpoints.doApi ?? 'https://api.digitalocean.com').replace(/\/+$/, '');
  private cfApi = () => (this.catalogue.endpoints.cloudflareApi ?? 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');

  // ---------- the gateway's hooks ----------

  /** A cloud instance's headers: an Entra token (Azure), the account's token (Workers AI). */
  async auth(row: InstanceRow): Promise<Record<string, string> | null> {
    const c = row.settings.cloud;
    if (!c?.flavour) return null;
    if (c.flavour === 'digitalocean') throw new Error('DigitalOcean serverless inference takes a model access key: give it as the instance\'s token (a vault reference).');
    const account = await this.usable(c.accountId, c.flavour === 'azure' ? 'azure' : 'cloudflare');
    const cred = await this.credential(account);
    if (c.flavour === 'azure') {
      if (cred.kind !== 'azure') throw new Error(`${account.name} has no Azure credential.`);
      return { authorization: `Bearer ${(await cred.getToken(AZURE_SCOPES.cognitive)).token}` };
    }
    if (cred.kind !== 'token') throw new Error(`${account.name} has no Cloudflare token.`);
    return { authorization: `Bearer ${cred.token}` };
  }

  /** The Cognitive Services accounts of an Azure subscription that serve OpenAI models. */
  private async cognitiveAccounts(account: CloudAccount): Promise<Arm[]> {
    const sub = account.providerIds.azureSubscriptionId;
    if (!sub) throw conflict(`${account.name} names no subscription.`);
    const r = await this.arm<{ value?: Arm[] }>(account, `/subscriptions/${sub}/providers/Microsoft.CognitiveServices/accounts?api-version=2024-10-01`);
    return (r.value ?? []).filter((x) => !x.kind || /^(openai|aiservices)$/i.test(x.kind));
  }

  private endpointsOf(a: Arm): string[] {
    const p = a.properties ?? {};
    const list = [typeof p.endpoint === 'string' ? p.endpoint : null, ...Object.values((p.endpoints ?? {}) as Record<string, unknown>).filter((v): v is string => typeof v === 'string')].filter((v): v is string => !!v);
    return [...new Set(list.map(origin).filter(Boolean))];
  }

  private async deployments(account: CloudAccount, resourceId: string): Promise<Arm[]> {
    return (await this.arm<{ value?: Arm[] }>(account, `${resourceId}/deployments?api-version=2024-10-01`)).value ?? [];
  }

  /** B-10502: an Azure instance's models: the deployments ARM lists for its Cognitive Services account. */
  async azureInstanceModels(row: InstanceRow): Promise<NonNullable<ServerReport['models']>> {
    const c = row.settings.cloud;
    if (!c || c.flavour !== 'azure') return [];
    const account = await this.usable(c.accountId, 'azure');
    let resourceId = c.resourceId ?? null;
    if (!resourceId) {
      const want = origin(row.url);
      resourceId = (await this.cognitiveAccounts(account)).find((a) => this.endpointsOf(a).includes(want))?.id ?? null;
      if (!resourceId) throw new Error(`No Cognitive Services account in ${account.name}'s subscription has the endpoint ${want}.`);
    }
    return (await this.deployments(account, resourceId)).map((d) => {
      const state = String(d.properties?.provisioningState ?? 'Succeeded');
      const model = (d.properties?.model ?? {}) as { name?: string };
      return { id: d.name, available: state === 'Succeeded', reason: state === 'Succeeded' ? null : `The deployment is ${state}`, ownedBy: model.name ?? null };
    });
  }

  /** B-10502: a provider's content-filter block, recorded as a guardrail decision in the tenant whose profile asked. */
  async filtered(e: ProviderFilterEvent): Promise<void> {
    if (!e.tenantId) return; // a lease without a profile (an embedding, a guard model): nothing to attribute it to
    await this.s().guard.engine.recordProvider(
      { tenantId: e.tenantId, workspaceId: null, text: e.text, label: e.label, stage: e.stage, source: { kind: 'model-instance', id: e.instance.id }, meta: { instance: e.instance.name, model: e.model, ...(e.profileId ? { profileId: e.profileId } : {}), via: 'provider-filter', ...(e.detail ?? {}) } },
      { name: e.provider, label: e.provider === 'azure' ? 'Azure content filter' : e.provider === 'bedrock' ? 'Bedrock Guardrail' : `${e.provider} content filter`, categories: e.categories }
    );
  }

  // ---------- metering (B-10509, B-10505) ----------

  /** Forgets which pools hold cloud instances (tests, and an instance added or removed). */
  resetPools(): void {
    this.s().cloud.modelPrices.resetPools();
  }

  /**
   * A usage record's cost (and a Workers AI record's neurons), from the one cloud model pricer
   * (`s.cloud.modelPrices`, B-10505); null for every record that did not run on a cloud model server.
   */
  async priceUsage(u: UsageInput): Promise<UsagePrice | null> {
    return this.s().cloud.modelPrices.priceUsage(u);
  }

  // ---------- the listing (B-10504 builds the import over it) ----------

  async listAzure(account: CloudAccount): Promise<CloudModelListing[]> {
    const out: CloudModelListing[] = [];
    for (const a of await this.cognitiveAccounts(account)) {
      const endpoint = typeof a.properties?.endpoint === 'string' ? a.properties.endpoint.replace(/\/+$/, '') : (this.endpointsOf(a)[0] ?? null);
      for (const d of await this.deployments(account, a.id)) {
        const p = d.properties ?? {};
        const model = (p.model ?? {}) as { name?: string; version?: string; format?: string };
        const state = String(p.provisioningState ?? 'Succeeded');
        const caps = (p.capabilities ?? {}) as Record<string, string>;
        const kind = caps.embeddings === 'true' || /embed/i.test(model.name ?? '') ? 'embedding' : caps.chatCompletion === 'true' || !caps.embeddings ? 'chat' : 'other';
        out.push({ provider: 'azure', accountId: account.id, flavour: 'azure', id: d.name, name: model.name ?? d.name, kind, region: a.location ?? null, endpoint, model: { name: model.name ?? d.name, version: model.version ?? null, format: model.format ?? null }, available: state === 'Succeeded', reason: state === 'Succeeded' ? null : `The deployment is ${state}`, details: { resourceId: a.id, account: a.name, accountKind: a.kind ?? null, sku: d.sku?.name ?? null, capacity: d.sku?.capacity ?? null } });
      }
    }
    return out;
  }

  async listDigitalOcean(account: CloudAccount): Promise<CloudModelListing[]> {
    const inference = (this.catalogue.endpoints.doInference ?? 'https://inference.do-ai.run').replace(/\/+$/, '');
    const models = await this.tokenApi<{ models?: { uuid?: string; id?: string; name?: string; inference_name?: string; is_foundational?: boolean; usecases?: string[] }[] }>(account, 'digitalocean', `${this.doApi()}/v2/gen-ai/models?per_page=200`);
    const agents = await this.listAgents(account);
    return [
      ...(models.models ?? []).map((m): CloudModelListing => {
        const id = m.inference_name ?? m.id ?? m.name ?? m.uuid ?? '';
        const embed = (m.usecases ?? []).some((u) => /embed/i.test(u)) || /embed/i.test(id);
        return { provider: 'digitalocean', accountId: account.id, flavour: 'digitalocean', id, name: m.name ?? id, kind: embed ? 'embedding' : 'chat', region: null, endpoint: inference, model: { name: m.name ?? id }, available: true, reason: null, details: { uuid: m.uuid ?? null } };
      }),
      ...agents.map((a): CloudModelListing => ({ provider: 'digitalocean', accountId: account.id, flavour: 'digitalocean', id: a.uuid, name: a.name, kind: 'agent', region: a.region ?? null, endpoint: a.deployment?.url ?? null, model: a.model?.name ? { name: a.model.name } : null, available: !!a.deployment?.url && (a.deployment.status ?? 'STATUS_RUNNING') === 'STATUS_RUNNING', reason: a.deployment?.url ? null : 'The agent is not deployed', details: { visibility: a.deployment?.visibility ?? null } }))
    ];
  }

  async listWorkersAi(account: CloudAccount): Promise<CloudModelListing[]> {
    const id = account.providerIds.cloudflareAccountId;
    if (!id) throw conflict(`${account.name} names no Cloudflare account.`);
    const r = await this.tokenApi<{ result?: { id?: string; name?: string; task?: { name?: string }; description?: string }[] }>(account, 'cloudflare', `${this.cfApi()}/accounts/${encodeURIComponent(id)}/ai/models/search?per_page=1000`);
    const endpoint = `${this.cfApi()}/accounts/${id}/ai`;
    return (r.result ?? [])
      .filter((m) => typeof m.name === 'string')
      .map((m) => {
        const task = m.task?.name ?? '';
        const kind = /text generation/i.test(task) ? 'chat' : /embedding/i.test(task) ? 'embedding' : 'other';
        return { provider: 'cloudflare', accountId: account.id, flavour: 'workers-ai', id: m.name!, name: m.name!, kind, region: null, endpoint: kind === 'other' ? null : endpoint, model: { name: m.name! }, available: true, reason: null, details: { task, neurons: SHEET.workersAi?.models[m.name!] ?? null } } satisfies CloudModelListing;
      });
  }

  // ---------- DigitalOcean agents as tools (B-10503) ----------

  private async listAgents(account: CloudAccount): Promise<DoAgent[]> {
    const r = await this.tokenApi<{ agents?: DoAgent[] }>(account, 'digitalocean', `${this.doApi()}/v2/gen-ai/agents?per_page=200`);
    return r.agents ?? [];
  }

  /**
   * Makes a draft registry tool for one of the account's GenAI agents: input `{ prompt }`, side effect `read`, the
   * agent's endpoint and a vault reference to its access key in the definition. It is published like any tool, and
   * every call goes through the dispatcher's checks before `runAgent` calls the agent.
   */
  async publishAgent(p: Principal, accountId: string, input: z.infer<typeof agentToolSchema>, ctx: { ip?: string | null; traceId?: string | null } = {}): Promise<EntryRow> {
    const account = await this.s().cloud.accounts.getFor(p, accountId);
    if (account.provider !== 'digitalocean') throw badRequest('Agents as tools are DigitalOcean GenAI agents; this is not a DigitalOcean account.');
    await this.usable(account.id, 'digitalocean');
    if (account.scope === 'tenant' && account.tenantId !== p.tenantId) throw forbidden('The account belongs to another tenant.');
    if (!clears(p.clearance, input.label)) throw forbidden(`You cannot set a ceiling above your clearance (${p.clearance}).`, { step: 'clearance' });
    if (!isVaultRef(input.keyRef)) throw badRequest('The agent\'s access key is given as a vault reference (vault:<path>#<key>), never as a value.');
    await this.s().vault.assertRefsReadable(p, [input.keyRef], ctx);
    const agent = (await this.listAgents(account)).find((a) => a.uuid === input.agent || a.name === input.agent);
    if (!agent) throw notFound('Agent');
    const endpoint = agent.deployment?.url?.replace(/\/+$/, '');
    if (!endpoint) throw conflict(`${agent.name} is not deployed, so it has no endpoint to call.`);
    if (!/^https?:\/\//i.test(endpoint)) throw conflict(`${agent.name}'s endpoint is not a URL.`);
    const entry = await this.s().registry.create(p, {
      kind: 'tool',
      name: input.name,
      version: '0.1.0',
      description: input.description ?? `Asks the DigitalOcean GenAI agent ${agent.name}.`,
      impl: 'cloud-agent',
      sideEffect: 'read',
      ratePerHour: input.ratePerHour,
      label: input.label as Label,
      inputSchema: AGENT_TOOL_INPUT as unknown as Record<string, unknown>,
      outputSchema: null,
      definition: { provider: 'digitalocean', accountId: account.id, agentUuid: agent.uuid, agentName: agent.name, endpoint, keyRef: input.keyRef }
    });
    await this.s().audit.append({ tenantId: p.tenantId, action: 'registry.created', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { entry: entry.id, name: entry.name }, label: entry.label, detail: { impl: 'cloud-agent', account: account.id, agent: agent.uuid, endpoint }, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
    return entry;
  }

  /** Calls a published agent tool (after the dispatcher's checks): its endpoint's Chat Completions, its key from the vault. */
  async runAgent(ctx: ToolCallContext, entry: EntryRow, args: Record<string, unknown>): Promise<unknown> {
    const d = entry.definition as { accountId?: string; endpoint?: string; keyRef?: string; agentName?: string };
    if (!d.accountId || !d.endpoint || !d.keyRef) throw new Error(`${entry.name} is missing its agent endpoint or key.`);
    const account = await this.usable(d.accountId, 'digitalocean');
    const key = await this.s().vault.resolveFor(entry.tenant_id ?? ctx.principal.tenantId, entry.owner_id, d.keyRef, { via: `registry:${entry.name}` });
    const t = await this.transport('digitalocean');
    const body = JSON.stringify({ messages: [{ role: 'user', content: String(args.prompt ?? '') }], stream: false });
    const r = await t.json<{ choices?: { message?: { content?: string } }[]; model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number } }>({ method: 'POST', url: `${d.endpoint}/api/v1/chat/completions`, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' }, body, accountId: account.id, apiClass: 'read', ...(ctx.signal ? { signal: ctx.signal } : {}) }, (status, b) => {
      const e = (b ?? {}) as { message?: string; error?: { message?: string } | string };
      const msg = typeof e.error === 'string' ? e.error : (e.error?.message ?? e.message ?? 'no detail');
      return { message: `The agent ${d.agentName ?? entry.name} answered ${status}: ${msg.slice(0, 300)}`, code: null };
    });
    return { answer: r.body.choices?.[0]?.message?.content ?? '', agent: d.agentName ?? null, ...(r.body.model ? { model: r.body.model } : {}), ...(r.body.usage ? { usage: { promptTokens: r.body.usage.prompt_tokens ?? 0, outputTokens: r.body.usage.completion_tokens ?? 0 } } : {}) };
  }
}
