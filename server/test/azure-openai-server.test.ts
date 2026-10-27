/*
 * 1.9.99-final, Sprint 60 (B-10502): Azure OpenAI and AI Foundry deployments as `kind: openai` instances with the
 * `azure` flavour, against the in-process fakes only (`fake-azure-openai.ts` for the data plane, `fake-azure.ts` for
 * ARM and Entra): an Entra token for the Cognitive Services scope through the account's credential, or an API key from
 * the vault; the deployment path with its `api-version`; chat, streaming and tools; deployments discovered through
 * ARM; and the content filter on the prompt and on the completion, streamed and not, recorded as guardrail decisions
 * with the filter's categories.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OpenAIServer } from '../src/gateway/openai-server.js';
import { isProviderFiltered } from '../src/gateway/provider-filter.js';
import type { CloudAccount } from '../src/cloud/types.js';
import { servicePolicy } from '../src/platform/egress.js';
import { seedAccount } from './cloud-credentials-helpers.js';
import { chatTurn, cloudProfile, modelsWorld, type ModelsWorld } from './cloud-models-helpers.js';
import { FakeAzure } from './fake-azure.js';
import { FakeAzureOpenAI, type FilterResults } from './fake-azure-openai.js';

const tenant = '0f0e0d0c-0000-4000-8000-00000000aaaa';
const sub = '1a2b3c4d-0000-4000-8000-00000000bbbb';
const HATE: FilterResults = { hate: { filtered: true, severity: 'high' }, self_harm: { filtered: false, severity: 'safe' }, sexual: { filtered: false, severity: 'safe' }, violence: { filtered: true, severity: 'medium' } };
const JAIL: FilterResults = { hate: { filtered: false, severity: 'safe' }, jailbreak: { filtered: true, detected: true } };

async function collect(server: OpenAIServer, model: string, content: string, tools?: unknown[]) {
  let text = '';
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  let done = null as Record<string, unknown> | null;
  for await (const c of server.chat({ model, messages: [{ role: 'user', content }], ...(tools ? { tools: tools as never } : {}) }, new AbortController().signal)) {
    text += c.message?.content ?? '';
    for (const t of c.message?.tool_calls ?? []) calls.push(t.function as never);
    if (c.done) done = c as never;
  }
  return { text, calls, done };
}

describe('B-10502: the azure flavour of the Chat Completions server', () => {
  let aoai: FakeAzureOpenAI;
  const policy = servicePolicy({ SERVICE_ALLOWED_HOSTS: '127.0.0.1' });

  beforeAll(async () => {
    aoai = await new FakeAzureOpenAI().start();
    aoai.keys.add('azure-key-1');
    aoai.deployments.set('gpt4o-prod', { model: 'gpt-4o', version: '2024-08-06' });
    aoai.deployments.set('embed-small', { model: 'text-embedding-3-small' });
  }, 180_000);
  afterAll(() => aoai.stop());
  beforeEach(() => {
    aoai.reset();
    aoai.filterPrompt = () => null;
    aoai.filterCompletion = () => null;
  });

  it('calls the deployment path with its api-version and the key in api-key', async () => {
    const s = new OpenAIServer(aoai.url, { timeoutMs: 5000, policy, flavour: 'azure', apiVersion: '2024-06-01', token: async () => 'azure-key-1' });
    const r = await collect(s, 'gpt4o-prod', 'hello there');
    expect(r.text).toBe('You said: hello there');
    const call = aoai.calls('aoai:chat/completions')[0]!;
    expect(call.path).toBe('/openai/deployments/gpt4o-prod/chat/completions');
    expect(call.query.get('api-version')).toBe('2024-06-01');
    expect(call.headers['api-key']).toBe('azure-key-1');
    expect(call.headers.authorization).toBeUndefined();
    expect(JSON.parse(call.body)).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(r.done).toMatchObject({ done: true, done_reason: 'stop' });
    expect(Number(r.done!.prompt_eval_count)).toBeGreaterThan(0);
    // The version string names the flavour and API version; no /health or /props is asked of a cloud endpoint.
    expect(await s.version()).toBe('azure-openai 2024-06-01');
    expect(aoai.requests.some((x) => /health|props/.test(x.path))).toBe(false);
    // Embeddings go to the deployment's embeddings path.
    const e = await s.embed('embed-small', ['a', 'b']);
    expect(e.embeddings).toHaveLength(2);
    expect(aoai.calls('aoai:embeddings')[0]!.path).toBe('/openai/deployments/embed-small/embeddings');
    await s.close();
  });

  it('takes an Entra token per request from authHeaders, streams tool calls, and refuses a bad key', async () => {
    let asked = 0;
    aoai.acceptToken = (t) => t === 'entra-cog-token';
    const s = new OpenAIServer(aoai.url, { timeoutMs: 5000, policy, flavour: 'azure', authHeaders: async () => (asked++, { authorization: 'Bearer entra-cog-token' }) });
    const r = await collect(s, 'gpt4o-prod', 'What is 17 * 23?', [{ type: 'function', function: { name: 'calculate', description: 'calc', parameters: { type: 'object' } } }]);
    expect(r.calls).toEqual([{ name: 'calculate', arguments: { expression: '17 * 23' } }]);
    await collect(s, 'gpt4o-prod', 'again');
    expect(asked).toBe(2); // never memoised: the credential source refreshes Entra tokens
    expect(aoai.calls('aoai:chat/completions').every((c) => c.headers.authorization === 'Bearer entra-cog-token' && !c.headers['api-key'])).toBe(true);
    const bad = new OpenAIServer(aoai.url, { timeoutMs: 5000, policy, flavour: 'azure', token: async () => 'wrong' });
    await expect(collect(bad, 'gpt4o-prod', 'x')).rejects.toMatchObject({ status: 401 });
    // A deployment that does not exist is Azure's 404, not a content filter.
    await expect(collect(s, 'nope', 'x')).rejects.toThrow(/deployment/i);
  });

  it('maps the prompt filter (400 content_filter) and the completion filter (finish_reason), streamed and not', async () => {
    const s = new OpenAIServer(aoai.url, { timeoutMs: 5000, policy, flavour: 'azure', token: async () => 'azure-key-1' });
    aoai.filterPrompt = (t) => (/forbidden/.test(t) ? HATE : null);
    const err = await collect(s, 'gpt4o-prod', 'something forbidden').catch((e: unknown) => e);
    expect(isProviderFiltered(err)).toBe(true);
    expect(err).toMatchObject({ provider: 'azure', stage: 'prompt', status: 400 });
    expect((err as { categories: { category: string }[] }).categories.map((c) => c.category).sort()).toEqual(['hate', 'violence']);
    expect((err as Error).message).toBe("Azure's content filter blocked the prompt (hate (high), violence (medium)).");

    aoai.filterPrompt = () => null;
    aoai.filterCompletion = (t) => (/You said/.test(t) ? JAIL : null);
    let partial = '';
    const err2 = await (async () => {
      for await (const c of s.chat({ model: 'gpt4o-prod', messages: [{ role: 'user', content: 'tell me' }] }, new AbortController().signal)) partial += c.message?.content ?? '';
    })().catch((e: unknown) => e);
    expect(err2).toMatchObject({ stage: 'completion', partial: 'You said:' });
    expect((err2 as { categories: { category: string; detected?: boolean }[] }).categories).toEqual([{ category: 'jailbreak', filtered: true, detected: true }]);
    expect(partial).toBe('You said:');
  });

  it('treats a stream:false answer and a plain OpenAI-compatible server exactly as before', async () => {
    // Without the flavour a content_filter error is just an error (existing instances are unchanged).
    aoai.filterPrompt = () => HATE;
    const plain = new OpenAIServer(aoai.url, { timeoutMs: 5000, policy, token: async () => 'azure-key-1' });
    const e = await collect(plain, 'gpt4o-prod', 'x').catch((x: unknown) => x);
    expect(isProviderFiltered(e)).toBe(false);
    expect(aoai.requests.at(-1)!.path).toBe('/v1/chat/completions');
    expect(aoai.requests.at(-1)!.headers.authorization).toBe('Bearer azure-key-1');
  });

  it('never dials a real Azure host in tests', async () => {
    const real = new OpenAIServer('https://exprsn-test.openai.azure.com', { timeoutMs: 5000, flavour: 'azure', token: async () => 'k' });
    await expect(collect(real, 'gpt4o-prod', 'x')).rejects.toThrow(/real cloud host blocked in tests/);
  });
});

describe('B-10502: Azure deployments as instances, discovered through ARM, with filter decisions', () => {
  let w: ModelsWorld;
  let az: FakeAzure;
  let aoai: FakeAzureOpenAI;
  let account: CloudAccount;
  let resourceId: string;
  const scopes: string[] = [];

  beforeAll(async () => {
    az = await new FakeAzure().start();
    aoai = await new FakeAzureOpenAI().start();
    aoai.deployments.set('gpt4o-prod', { model: 'gpt-4o', version: '2024-08-06' });
    aoai.deployments.set('gpt4o-staging', { model: 'gpt-4o', version: '2024-11-20' });
    aoai.acceptToken = (t) => t === 'cog-token';
    aoai.keys.add('vaulted-azure-key');
    az.addSubscription(sub, tenant);
    az.tokens.set('arm-token', { tenantId: tenant, clientId: 'app', scope: 'https://management.azure.com', exp: Date.now() + 3600_000 });
    resourceId = aoai.seedArm(az, { subscription: sub, resourceGroup: 'ai', account: 'exprsn-aoai', location: 'westeurope', states: { 'gpt4o-staging': 'Creating' } });
    w = await modelsWorld();
    account = await seedAccount(w.h, { provider: 'azure', mode: 'vaulted', name: 'az-models', providerIds: { azureTenantId: tenant, azureSubscriptionId: sub }, params: { clientId: 'app' } });
    w.h.s.cloud.credentials = {
      for: async (a: CloudAccount, purpose: string) => {
        expect(purpose).toBe('read');
        expect(a.id).toBe(account.id);
        return { kind: 'azure', tenantId: tenant, getToken: async (scope: string) => (scopes.push(scope), { token: scope.startsWith('https://management') ? 'arm-token' : 'cog-token', expiresAt: Date.now() + 3600_000 }) };
      }
    };
    w.h.s.cloud.modelCatalogue.endpoints.azureArm = az.url;
  }, 180_000);
  afterAll(async () => {
    await w.h.close();
    await az.stop();
    await aoai.stop();
  });

  it('registers an Entra-authenticated instance whose models are the deployments ARM lists', async () => {
    const { inst } = await cloudProfile(w, { pool: 'azure-eu', instance: { name: 'aoai-1', url: aoai.url, cloud: { flavour: 'azure', accountId: account.id, region: 'westeurope' } }, serverModel: 'gpt4o-prod', profile: 'azure-gpt' });
    expect(inst).toMatchObject({ kind: 'openai', health: 'healthy', version: 'azure-openai 2024-10-21' });
    // Only the deployment that finished provisioning is available.
    expect(inst.available.map((x: { name: string }) => x.name)).toEqual(['gpt4o-prod']);
    const row = (await w.h.s.gateway.repo.instance(inst.id))!;
    expect(row.settings.cloud).toMatchObject({ provider: 'azure', flavour: 'azure', auth: 'account', accountId: account.id, region: 'westeurope' });
    expect(row.token_ref).toBeNull();
    expect(az.calls(/deployments/).length + az.requests.filter((r) => /CognitiveServices\/accounts$/i.test(r.path)).length).toBeGreaterThan(0);
    expect(scopes).toContain('https://management.azure.com/.default');
    expect(resourceId).toMatch(/exprsn-aoai$/);
  });

  it('chats on the profile, and records a filtered prompt as a guardrail decision with the categories', async () => {
    aoai.filterPrompt = (t) => (/forbidden/.test(t) ? HATE : null);
    aoai.filterCompletion = () => null;
    const ok = await chatTurn(w, 'azure-gpt', 'Say hello');
    expect(ok.state).toBe('complete');
    const usage = await w.h.s.db('usage_records').where({ message_id: ok.sent.messageId });
    expect(usage[0]).toMatchObject({ kind: 'chat', model: 'gpt4o-prod' });
    expect(aoai.calls('aoai:chat/completions').at(-1)!.headers.authorization).toBe('Bearer cog-token');
    expect(scopes).toContain('https://cognitiveservices.azure.com/.default');

    const bad = await chatTurn(w, 'azure-gpt', 'something forbidden please');
    expect(bad.state).toBe('failed');
    const d = await w.h.s.db('guard_decisions').where({ tenant_id: w.h.tenantId, checkpoint: 'user-input', action: 'block' }).orderBy('created_at', 'desc').first();
    expect(d).toBeTruthy();
    const findings = JSON.parse(d.findings) as { ruleId: string; ruleName: string; detail: string }[];
    expect(findings.map((f) => f.ruleId).sort()).toEqual(['provider:azure:hate', 'provider:azure:violence']);
    expect(findings[0]!.ruleName).toBe('Azure content filter');
    expect(findings.map((f) => f.detail).sort()).toEqual(['hate (severity high)', 'violence (severity medium)']);
    expect(JSON.parse(d.meta)).toMatchObject({ provider: 'azure', providerStage: 'prompt', categories: ['hate', 'violence'], model: 'gpt4o-prod' });
    expect(d.source_kind).toBe('model-instance');
    // The text is sealed, as for every decision.
    expect(String(d.text)).not.toContain('forbidden');
  });

  it('records a filtered completion at model-output with the partial answer', async () => {
    aoai.filterPrompt = () => null;
    aoai.filterCompletion = (t) => (/write it/.test(t) ? JAIL : null);
    const r = await chatTurn(w, 'azure-gpt', 'write it now');
    expect(r.state).toBe('failed');
    const d = await w.h.s.db('guard_decisions').where({ tenant_id: w.h.tenantId, checkpoint: 'model-output', action: 'block' }).orderBy('created_at', 'desc').first();
    expect(JSON.parse(d.findings).map((f: { ruleId: string }) => f.ruleId)).toEqual(['provider:azure:jailbreak']);
    expect(JSON.parse(d.meta)).toMatchObject({ providerStage: 'completion', categories: ['jailbreak'] });
  });

  it('takes the resource key from the vault instead (auth key) and lists through resourceId', async () => {
    const pool = (await w.admin.agent.post('/api/admin/pools').set('x-csrf-token', w.admin.csrf).send({ name: 'azure-key', accelerator: 'cpu', labelCeiling: 'internal' }).expect(201)).body;
    const res = await w.admin.agent.post(`/api/admin/pools/${pool.id}/instances`).set('x-csrf-token', w.admin.csrf).send({ name: 'aoai-key', kind: 'openai', url: aoai.url, deploy: 'docker', token: 'vaulted-azure-key', cloud: { flavour: 'azure', accountId: account.id, region: 'westeurope', apiVersion: '2024-06-01', resourceId } }).expect(201);
    expect(res.body.tokenRef).toMatch(/^vault:/);
    expect(JSON.stringify(res.body)).not.toContain('vaulted-azure-key');
    const row = (await w.h.s.gateway.repo.instance(res.body.id))!;
    expect(row.settings.cloud).toMatchObject({ auth: 'key', apiVersion: '2024-06-01', resourceId });
    // A pool above the region's ceiling (internal) is refused; so is another provider's account and an Azure URL missing.
    const conf = (await w.admin.agent.post('/api/admin/pools').set('x-csrf-token', w.admin.csrf).send({ name: 'azure-conf', accelerator: 'cpu', labelCeiling: 'confidential' }).expect(201)).body;
    expect((await w.admin.agent.post(`/api/admin/pools/${conf.id}/instances`).set('x-csrf-token', w.admin.csrf).send({ name: 'x', kind: 'openai', url: aoai.url, deploy: 'docker', cloud: { flavour: 'azure', accountId: account.id, region: 'westeurope' } })).status).toBe(403);
    expect((await w.admin.agent.post(`/api/admin/pools/${pool.id}/instances`).set('x-csrf-token', w.admin.csrf).send({ name: 'y', kind: 'openai', deploy: 'docker', cloud: { flavour: 'azure', accountId: account.id, region: 'westeurope' } })).status).toBe(400);
    expect((await w.admin.agent.post(`/api/admin/pools/${pool.id}/instances`).set('x-csrf-token', w.admin.csrf).send({ name: 'z', kind: 'openai', url: aoai.url, deploy: 'docker', cloud: { flavour: 'workers-ai', accountId: account.id, region: 'global' } })).status).toBe(400);
  });
});
