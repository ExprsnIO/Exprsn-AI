import { createHash } from 'node:crypto';
import { labelRank, type Label } from '../authz/labels.js';
import { forbidden } from '../http/problem.js';
import { signV4 } from '../platform/blob.js';
import { servicePolicy } from '../platform/egress.js';
import type { Services } from '../services.js';
import { BedrockServer, type ApplyGuardrailOutput, type BedrockBackend, type BedrockOffer, type ConverseOutput } from '../gateway/bedrock-server.js';
import type { InstanceRow } from '../gateway/repo.js';
import type { AiGatewayHop } from '../gateway/ai-gateway-hop.js';
import type { ModelServer } from '../gateway/server.js';
import { decodeEventStream, events } from './aws-event-stream.js';
import type { CloudModelListing, CloudModelLister } from './model-catalogue.js';
import { CloudTransport, type TransportOptions } from './providers/transport.js';
import { CloudProviderError } from './providers/types.js';
import type { CloudAccount } from './types.js';

/*
 * 1.9.99-final, Sprint 60 (B-10501, B-10504): Amazon Bedrock for an AWS cloud account (`s.cloud.bedrock`).
 *
 * - `BedrockApi`: the calls, each signed with SigV4 (service `bedrock`, the region of the endpoint) using the account's
 *   credential for purpose `read` (`s.cloud.credentials.for(account, 'read')`: the read role's policy carries the
 *   `ExprsnModels` statement with the invoke actions, `cloud/setup.ts`), the session token as `x-amz-security-token`,
 *   to the regional endpoints `bedrock.<region>.amazonaws.com` (control plane) and
 *   `bedrock-runtime.<region>.amazonaws.com` (runtime), and sent through the cloud transport (egress guard, rate
 *   limiter, breaker, retries of throttling). Bedrock is not S3: the canonical URI is the path encoded twice (a
 *   model id's `:` is `%3A` on the wire and `%253A` in the signature).
 * - The backend a `kind: bedrock` instance's `BedrockServer` uses (`serverFor`), with the residency guard: before a
 *   call, every region the model or inference profile may route to must be on the account's allow-list and admit the
 *   model's label (`assertRegionAllows` through `checkRegion`); a global profile is always refused.
 * - The AWS lister of the cloud model catalogue (`lister`, registered on `s.cloud.modelCatalogue`): foundation models
 *   with their model access state (`GetFoundationModelAvailability`) and the system inference profiles with the
 *   regions they route to.
 */

/** The IAM action behind each call (listed under the `models` feature in `providers/capabilities.ts`). */
export const BEDROCK_ACTIONS = {
  listFoundationModels: 'bedrock:ListFoundationModels',
  listInferenceProfiles: 'bedrock:ListInferenceProfiles',
  availability: 'bedrock:GetFoundationModelAvailability',
  converse: 'bedrock:InvokeModel',
  converseStream: 'bedrock:InvokeModelWithResponseStream',
  invoke: 'bedrock:InvokeModel',
  // Sprint 61 (B-10506): the provider guardrail layer (ApplyGuardrail, and Converse with guardrailConfig, need ApplyGuardrail).
  applyGuardrail: 'bedrock:ApplyGuardrail',
  getGuardrail: 'bedrock:GetGuardrail'
} as const;

/** What GetGuardrail says of one version (the setting route checks it exists and is ready). */
export interface GuardrailSummary {
  guardrailId?: string;
  guardrailArn?: string;
  name?: string;
  version?: string;
  status?: string;
}

export interface BedrockEndpoints {
  /** The control plane (default `https://bedrock.<region>.amazonaws.com`). */
  bedrock?: string;
  /** The runtime (default `https://bedrock-runtime.<region>.amazonaws.com`). */
  bedrockRuntime?: string;
}

export const controlEndpoint = (region: string, e: BedrockEndpoints = {}) => e.bedrock ?? `https://bedrock.${region}.amazonaws.com`;
export const runtimeEndpoint = (region: string, e: BedrockEndpoints = {}) => e.bedrockRuntime ?? `https://bedrock-runtime.${region}.amazonaws.com`;

const sha256 = (b: string) => createHash('sha256').update(b).digest('hex');
/** One path segment as Bedrock's REST paths carry it (`:` and `/` encoded). */
const seg = (s: string) => encodeURIComponent(s);

export interface AwsKeys {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface FoundationModelSummary {
  modelId: string;
  modelArn?: string;
  modelName?: string;
  providerName?: string;
  inputModalities?: string[];
  outputModalities?: string[];
  responseStreamingSupported?: boolean;
  inferenceTypesSupported?: string[];
  modelLifecycle?: { status?: string };
}

export interface InferenceProfileSummary {
  inferenceProfileId: string;
  inferenceProfileArn?: string;
  inferenceProfileName?: string;
  description?: string;
  status?: string;
  type?: string;
  models?: { modelArn?: string }[];
}

export interface ModelAvailability {
  modelId?: string;
  agreementAvailability?: { status?: string; errorMessage?: string };
  authorizationStatus?: string;
  entitlementAvailability?: string;
  regionAvailability?: string;
}

/** `granted` (authorised, entitled, agreement accepted), `pending` (the agreement is being processed), `not_granted`, `unknown`. */
export type AccessState = 'granted' | 'pending' | 'not_granted' | 'unknown';

export function accessStateOf(a: ModelAvailability | null): AccessState {
  if (!a) return 'unknown';
  if (a.regionAvailability === 'NOT_AVAILABLE') return 'not_granted';
  if (a.agreementAvailability?.status === 'PENDING') return 'pending';
  if (a.authorizationStatus === 'AUTHORIZED' && a.entitlementAvailability !== 'NOT_AVAILABLE' && (a.agreementAvailability?.status ?? 'AVAILABLE') === 'AVAILABLE') return 'granted';
  return 'not_granted';
}

/** The regions an inference profile routes to (from its models' ARNs); `*` for a global profile. */
export function profileRegions(p: InferenceProfileSummary): string[] {
  if (/^global\./.test(p.inferenceProfileId)) return ['*'];
  const out = new Set<string>();
  for (const m of p.models ?? []) {
    const region = (m.modelArn ?? '').split(':')[3];
    if (region) out.add(region);
  }
  return [...out].sort();
}

function describeBedrock(status: number, body: unknown, headers: Record<string, string> = {}): { message: string; code: string | null } {
  const b = (body && typeof body === 'object' ? body : {}) as { message?: string; Message?: string; __type?: string };
  const code = (headers['x-amzn-errortype'] ?? b.__type ?? '').split(':')[0]!.split('#').pop() || null;
  const msg = b.message ?? b.Message ?? (typeof body === 'string' ? body.slice(0, 300) : '');
  return { message: `Bedrock refused the call${code ? ` (${code})` : ''}${msg ? `: ${String(msg).slice(0, 300)}` : ''}.`, code };
}

/** The Bedrock calls for one account and region. */
export class BedrockApi {
  constructor(
    private readonly o: {
      transport: CloudTransport;
      accountId: string;
      region: string;
      credential: () => Promise<AwsKeys>;
      endpoints: () => BedrockEndpoints;
      now?: () => number;
      /** 1.9.99-final, Sprint 61 (B-10908): Cloudflare AI Gateway in front of the runtime calls, when the instance names one. */
      gateway?: (() => Promise<AiGatewayHop | null>) | undefined;
    }
  ) {}

  get region(): string {
    return this.o.region;
  }

  /** The URL and signed headers of a call. `path` is the wire path (segments already encoded). */
  private async sign(method: string, base: string, path: string, body: string, extra: Record<string, string> = {}): Promise<{ url: URL; headers: Record<string, string> }> {
    const keys = await this.o.credential();
    const url = new URL(path, base);
    // Non-S3 SigV4: the canonical URI is the (already encoded) path encoded once more.
    const signing = new URL(url);
    signing.pathname = url.pathname.split('/').map(seg).join('/');
    const headers: Record<string, string> = { ...extra, ...(body ? { 'content-type': 'application/json' } : {}), ...(keys.sessionToken ? { 'x-amz-security-token': keys.sessionToken } : {}) };
    const signed = signV4({ method, url: signing, headers, payloadHash: sha256(body), region: this.o.region, service: 'bedrock', accessKeyId: keys.accessKeyId, secretAccessKey: keys.secretAccessKey, date: new Date((this.o.now ?? Date.now)()) });
    signed.host = url.host;
    return { url, headers: signed };
  }

  private async getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    const { url, headers } = await this.sign('GET', controlEndpoint(this.o.region, this.o.endpoints()), path, '');
    const res = await this.o.transport.send({ method: 'GET', url, headers: { accept: 'application/json', ...headers }, accountId: this.o.accountId, ...(signal ? { signal } : {}) });
    return this.parse<T>(res.status, res.body, res.headers, res.requestId);
  }

  private parse<T>(status: number, raw: Buffer, headers: Record<string, string>, requestId: string | null): T {
    const text = raw.toString('utf8');
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (status >= 200 && status < 300) return body as T;
    const d = describeBedrock(status, body, headers);
    throw new CloudProviderError(d.message, 'aws', status, d.code, requestId);
  }

  async listFoundationModels(signal?: AbortSignal): Promise<FoundationModelSummary[]> {
    const r = await this.getJson<{ modelSummaries?: FoundationModelSummary[] }>('/foundation-models', signal);
    return r.modelSummaries ?? [];
  }

  async listInferenceProfiles(signal?: AbortSignal): Promise<InferenceProfileSummary[]> {
    const out: InferenceProfileSummary[] = [];
    let token: string | null = null;
    for (let page = 0; page < 20; page++) {
      const q = new URLSearchParams({ maxResults: '1000', typeEquals: 'SYSTEM_DEFINED', ...(token ? { nextToken: token } : {}) });
      const r: { inferenceProfileSummaries?: InferenceProfileSummary[]; nextToken?: string } = await this.getJson(`/inference-profiles?${q}`, signal);
      out.push(...(r.inferenceProfileSummaries ?? []));
      token = r.nextToken ?? null;
      if (!token) break;
    }
    return out;
  }

  async availability(modelId: string, signal?: AbortSignal): Promise<ModelAvailability> {
    return this.getJson<ModelAvailability>(`/foundation-model-availability/${seg(modelId)}`, signal);
  }

  private async post(path: string, body: Record<string, unknown>, o: { signal?: AbortSignal | undefined; timeoutMs: number; stream?: boolean; accept: string }) {
    const text = JSON.stringify(body);
    const base = runtimeEndpoint(this.o.region, this.o.endpoints());
    const { url, headers } = await this.sign('POST', base, path, text, { accept: o.accept });
    // B-10908: through Cloudflare AI Gateway, the request signed for the regional endpoint goes to the gateway, which
    // passes it on; the gateway's own headers say whether it may cache or log this call.
    const hop = this.o.gateway ? await this.o.gateway() : null;
    const via = hop ? hop.url(base, path) : null;
    if (via && hop) {
      delete headers.host;
      Object.assign(headers, hop.headers());
    }
    // Model calls change nothing in the account: the `read` class (retried on throttling and 5xx before any byte).
    const res = await this.o.transport.send({ method: 'POST', url: via ? new URL(via) : url, headers, body: text, accountId: this.o.accountId, apiClass: 'read', timeoutMs: o.timeoutMs, ...(o.stream ? { stream: true } : {}), ...(o.signal ? { signal: o.signal } : {}), ...(via ? { via: 'ai-gateway' as const } : {}) });
    if (via && hop && res.status >= 200 && res.status < 300) {
      const model = /^\/model\/([^/]+)\//.exec(path)?.[1];
      const problem = hop.answerProblem((n) => res.headers[n.toLowerCase()], model ? decodeURIComponent(model) : null);
      if (problem) {
        res.abort?.();
        throw new CloudProviderError(problem, 'aws', 502, 'ai_gateway_fallback', res.requestId);
      }
    }
    return res;
  }

  async converse(modelId: string, body: Record<string, unknown>, signal: AbortSignal, timeoutMs: number): Promise<ConverseOutput> {
    const res = await this.post(`/model/${seg(modelId)}/converse`, body, { signal, timeoutMs, accept: 'application/json' });
    return this.parse<ConverseOutput>(res.status, res.body, res.headers, res.requestId);
  }

  async *converseStream(modelId: string, body: Record<string, unknown>, signal: AbortSignal, timeoutMs: number): AsyncGenerator<{ type: string; body: Record<string, unknown> }> {
    const res = await this.post(`/model/${seg(modelId)}/converse-stream`, body, { signal, timeoutMs, stream: true, accept: 'application/vnd.amazon.eventstream' });
    if (!res.stream) {
      this.parse(res.status, res.body, res.headers, res.requestId);
      throw new CloudProviderError('Bedrock answered ConverseStream without a stream.', 'aws', 502, 'malformed', res.requestId);
    }
    try {
      yield* events(decodeEventStream(res.stream));
    } finally {
      res.abort?.();
    }
  }

  /** Sprint 61 (B-10506): ApplyGuardrail on the runtime: a text checked as the prompt (`INPUT`) or the answer (`OUTPUT`). */
  async applyGuardrail(id: string, version: string, source: 'INPUT' | 'OUTPUT', text: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<ApplyGuardrailOutput> {
    const res = await this.post(`/guardrail/${seg(id)}/version/${seg(version)}/apply`, { source, content: [{ text: { text } }] }, { signal, timeoutMs, accept: 'application/json' });
    return this.parse<ApplyGuardrailOutput>(res.status, res.body, res.headers, res.requestId);
  }

  /** Sprint 61 (B-10506): GetGuardrail on the control plane (the version must exist; `DRAFT` is the working draft). */
  async getGuardrail(id: string, version: string, signal?: AbortSignal): Promise<GuardrailSummary> {
    return this.getJson<GuardrailSummary>(`/guardrails/${seg(id)}?${new URLSearchParams({ guardrailVersion: version })}`, signal);
  }

  async invoke(modelId: string, body: Record<string, unknown>, signal: AbortSignal | undefined, timeoutMs: number): Promise<{ body: unknown; inputTokens: number | null }> {
    const res = await this.post(`/model/${seg(modelId)}/invoke`, body, { signal, timeoutMs, accept: 'application/json' });
    const out = this.parse<unknown>(res.status, res.body, res.headers, res.requestId);
    const n = Number(res.headers['x-amzn-bedrock-input-token-count']);
    return { body: out, inputTokens: Number.isFinite(n) && res.headers['x-amzn-bedrock-input-token-count'] != null ? n : null };
  }
}

/** The offers a server lists: on-demand foundation models and the system inference profiles that are active. */
export function offersOf(models: FoundationModelSummary[], profiles: InferenceProfileSummary[]): BedrockOffer[] {
  const out: BedrockOffer[] = [];
  for (const m of models) {
    const onDemand = (m.inferenceTypesSupported ?? ['ON_DEMAND']).includes('ON_DEMAND');
    const live = (m.modelLifecycle?.status ?? 'ACTIVE') !== 'RETIRED';
    out.push({ id: m.modelId, kind: 'foundation', provider: m.providerName ?? null, name: m.modelName ?? null, input: m.inputModalities ?? ['TEXT'], output: m.outputModalities ?? ['TEXT'], streaming: m.responseStreamingSupported !== false, available: onDemand && live, reason: !onDemand ? 'Offered only through an inference profile or provisioned throughput' : !live ? 'Retired' : null });
  }
  for (const p of profiles) {
    const base = models.find((m) => (p.models ?? []).some((x) => (x.modelArn ?? '').endsWith(`/${m.modelId}`)));
    out.push({ id: p.inferenceProfileId, kind: 'inference_profile', provider: base?.providerName ?? null, name: p.inferenceProfileName ?? null, input: base?.inputModalities ?? ['TEXT'], output: base?.outputModalities ?? ['TEXT'], streaming: base?.responseStreamingSupported !== false, available: (p.status ?? 'ACTIVE') === 'ACTIVE', reason: (p.status ?? 'ACTIVE') === 'ACTIVE' ? null : `Profile ${p.status}`, regions: profileRegions(p) });
  }
  return out;
}

const OFFERS_TTL_MS = 5 * 60_000;
const GUARD_TTL_MS = 30_000;

/** Model access and data terms of a Bedrock listing, as the catalogue import records them. */
export const BEDROCK_TERMS = (provider: string | null) => ({
  name: `${provider ?? 'Model provider'} model on Amazon Bedrock (AWS Service Terms and the model provider's end user licence agreement)`,
  url: 'https://aws.amazon.com/service-terms/',
  notes: 'Bedrock states that prompts and outputs are not used to train models nor shared with the model provider; not attested for this account (B-10507).'
});

export class CloudBedrock {
  private endpoints: BedrockEndpoints = {};
  private transportOptions: Omit<TransportOptions, 'provider' | 'policy' | 'counters'> = {};
  private transportValue: CloudTransport | null = null;
  /** Calls made, per action (tests and diagnostics). */
  readonly calls: Record<string, number> = {};

  constructor(private readonly s: () => Services) {}

  /** Points every call at other endpoints (tests: the fake). */
  setEndpoints(e: BedrockEndpoints): void {
    this.endpoints = { ...e };
  }

  /** Tests: a fast transport. */
  setTransport(o: Omit<TransportOptions, 'provider' | 'policy' | 'counters'>): void {
    this.transportOptions = o;
    this.transportValue = null;
  }

  private transport(): CloudTransport {
    const s = this.s();
    return (this.transportValue ??= new CloudTransport({ provider: 'aws', policy: servicePolicy(s.cfg), counters: s.counters, timeoutMs: s.cfg.CLOUD_HTTP_TIMEOUT_MS, ...this.transportOptions }));
  }

  private async account(id: string): Promise<CloudAccount> {
    const a = await this.s().cloud.accounts.get(id);
    if (!a) throw new CloudProviderError('The cloud account of this model server no longer exists.', 'aws', 404, 'no_account');
    if (a.provider !== 'aws') throw new CloudProviderError(`${a.name} is not an AWS account; Bedrock needs one.`, 'aws', 409, 'wrong_provider');
    return a;
  }

  /** The account's read credential, as an AWS key (the session's token included). */
  private async keys(a: CloudAccount): Promise<AwsKeys> {
    const c = this.s().cloud.credentials;
    if (!c) throw new CloudProviderError('Cloud credentials are not available in this build.', 'aws', 503, 'cloud_component_missing');
    const cred = (await c.for(a, 'read')) as { kind: string; accessKeyId?: string; secretAccessKey?: string; sessionToken?: string };
    if (cred.kind !== 'aws' || !cred.accessKeyId || !cred.secretAccessKey) throw new CloudProviderError(`${a.name}'s read credential is not an AWS key.`, 'aws', 400, 'wrong_credential');
    return { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey, ...(cred.sessionToken ? { sessionToken: cred.sessionToken } : {}) };
  }

  /** The calls for an account and region (the account is read again on every credential use). */
  api(accountId: string, region: string, gateway?: () => Promise<AiGatewayHop | null>): BedrockApi {
    const t = this.transport();
    const counted = new Proxy(t, {
      get: (target, prop, recv) => {
        if (prop !== 'send') return Reflect.get(target, prop, recv) as unknown;
        return (r: Parameters<CloudTransport['send']>[0]) => {
          const path = new URL(String(r.url)).pathname;
          const action = /\/converse-stream$/.test(path) ? 'ConverseStream' : /\/converse$/.test(path) ? 'Converse' : /\/invoke$/.test(path) ? 'InvokeModel' : /\/apply$/.test(path) ? 'ApplyGuardrail' : /^\/guardrails\//.test(path) ? 'GetGuardrail' : /foundation-model-availability/.test(path) ? 'GetFoundationModelAvailability' : /inference-profiles/.test(path) ? 'ListInferenceProfiles' : 'ListFoundationModels';
          this.calls[action] = (this.calls[action] ?? 0) + 1;
          return target.send(r);
        };
      }
    });
    return new BedrockApi({ transport: counted, accountId, region, credential: async () => this.keys(await this.account(accountId)), endpoints: () => this.endpoints, ...(gateway ? { gateway } : {}) });
  }

  /**
   * The residency check before a call (B-10501, B-10507): the regions the model may route to (the catalogue entry's,
   * else an inference profile's own, else the instance's region) must each be on the account's allow-list and admit
   * the model's label; a global profile is refused.
   */
  async assertRoutes(accountId: string, region: string, modelId: string, offer?: BedrockOffer): Promise<void> {
    const s = this.s();
    const account = await this.account(accountId);
    const model = await s.gateway.repo.modelByName(modelId).catch(() => undefined);
    const label: Label = model?.label ?? 'internal';
    const entry = model ? await s.cloud.modelImport?.entry(model.id).catch(() => null) : null;
    const routes = entry && entry.accountId === accountId ? entry.routesTo : offer?.kind === 'inference_profile' ? (offer.regions ?? ['*']) : [region];
    if (entry && entry.accountId === accountId && labelRank(label) > labelRank(entry.ceiling)) throw forbidden(`${modelId} is labelled ${label} but its cloud entry's ceiling is ${entry.ceiling}.`, { step: 'zone', region, ceiling: entry.ceiling });
    for (const r of routes) {
      if (r === '*') throw forbidden(`${modelId} is a global inference profile: it may route to regions outside ${account.name}'s allow-list.`, { step: 'zone', check: 'region', region: '*' });
      const d = await s.cloud.accounts.checkRegion(account, r, label, { use: 'models' });
      if (!d.allow) throw forbidden(`${modelId} may route to ${r}: ${d.reason}`, { step: 'zone', check: d.step, region: r, zone: d.zone, ceiling: d.ceiling });
    }
  }

  /** The backend of a `kind: bedrock` instance: listing cached for five minutes, the residency guard for thirty seconds. */
  backend(accountId: string, region: string, gateway?: () => Promise<AiGatewayHop | null>): BedrockBackend {
    const api = this.api(accountId, region, gateway);
    let offers: { at: number; list: Promise<BedrockOffer[]> } | null = null;
    const guarded = new Map<string, number>();
    const list = (signal?: AbortSignal) => {
      if (offers && Date.now() - offers.at < OFFERS_TTL_MS) return offers.list;
      const p = Promise.all([api.listFoundationModels(signal), api.listInferenceProfiles(signal).catch(() => [] as InferenceProfileSummary[])]).then(([m, pr]) => offersOf(m, pr));
      offers = { at: Date.now(), list: p };
      p.catch(() => {
        offers = null;
      });
      return p;
    };
    return {
      region,
      offers: list,
      guard: async (modelId) => {
        const at = guarded.get(modelId);
        if (at && Date.now() - at < GUARD_TTL_MS) return;
        const offer = (await list().catch(() => [] as BedrockOffer[])).find((o) => o.id === modelId);
        await this.assertRoutes(accountId, region, modelId, offer);
        guarded.set(modelId, Date.now());
      },
      converse: (m, b, sig, t) => api.converse(m, b, sig, t),
      converseStream: (m, b, sig, t) => api.converseStream(m, b, sig, t),
      invoke: (m, b, sig, t) => api.invoke(m, b, sig, t),
      applyGuardrail: (id, v, source, text, sig, t) => api.applyGuardrail(id, v, source, text, sig, t)
    };
  }

  /** The gateway's `cloudServer` hook for `kind: bedrock` rows. */
  serverFor(row: InstanceRow, onDropped: (model: string, options: string[]) => void): ModelServer {
    const c = row.settings.cloud;
    if (!c || c.provider !== 'aws') throw new Error(`${row.name} names no AWS account and region (settings.cloud)`);
    // B-10908: Converse through Cloudflare AI Gateway when the instance names one.
    const gateway = c.aiGateway ? () => this.s().cloud.aiGateway.hop(row) : undefined;
    return new BedrockServer(this.backend(c.accountId, c.region, gateway), { onDropped, loadTimeoutMs: this.s().cfg.OLLAMA_LOAD_TIMEOUT_MS, guardrail: c.guardrail ?? null });
  }

  /**
   * The AWS lister of the cloud model catalogue (B-10504): per allowed region, the foundation models with their access
   * state and the system inference profiles with their routing regions.
   */
  readonly lister: CloudModelLister = {
    listModels: async (account, opts = {}) => {
      const out: CloudModelListing[] = [];
      for (const r of account.regions) {
        const api = this.api(account.id, r.region);
        const [models, profiles] = await Promise.all([api.listFoundationModels(opts.signal), api.listInferenceProfiles(opts.signal).catch(() => [] as InferenceProfileSummary[])]);
        for (const o of offersOf(models, profiles)) {
          const kind = o.output.includes('EMBEDDING') ? 'embedding' : o.output.includes('TEXT') ? 'chat' : 'other';
          let access: AccessState = 'unknown';
          if (o.kind === 'foundation' && o.available && kind !== 'other') access = accessStateOf(await api.availability(o.id, opts.signal).catch(() => null));
          else if (o.kind === 'inference_profile') access = o.available ? 'granted' : 'not_granted';
          const available = o.available && (o.kind === 'inference_profile' || access === 'granted');
          out.push({
            provider: 'aws',
            accountId: account.id,
            flavour: 'bedrock',
            id: o.id,
            name: o.name ?? o.id,
            kind,
            region: r.region,
            endpoint: null,
            model: { name: o.id },
            available,
            reason: available ? null : o.available ? `Model access is ${access.replace('_', ' ')} in ${r.region}` : (o.reason ?? null),
            details: { offer: o.kind, accessState: access, routesTo: o.kind === 'inference_profile' ? (o.regions ?? ['*']) : [r.region], providerName: o.provider, streaming: o.streaming, terms: BEDROCK_TERMS(o.provider) }
          });
        }
      }
      return out;
    }
  };
}
