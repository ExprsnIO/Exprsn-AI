import { z } from 'zod';
import { labelRank, type Label } from '../authz/labels.js';
import { aiGatewayLabel, type AiGatewayHop } from '../gateway/ai-gateway-hop.js';
import type { InstanceRow } from '../gateway/repo.js';
import { conflict } from '../http/problem.js';
import type { Services } from '../services.js';
import { CloudProviderError } from './providers/types.js';
import type { CloudAccount } from './types.js';

/*
 * 1.9.99-final, Sprint 61 (B-10908): Cloudflare AI Gateway as an optional proxy in front of a cloud model backend
 * (`s.cloud.aiGateway`). Per instance (`settings.cloud.aiGateway`), a Bedrock, Azure OpenAI, DigitalOcean GenAI or
 * Workers AI server sends its inference calls through `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/
 * <provider>/...`, for the gateway's caching, logs, rate limits and analytics. It is an extra layer only:
 *
 * - Exprsn-AI's gateway, guardrails, metering and profile fallback stay authoritative. Exprsn-AI never asks the
 *   gateway for a fallback (no Universal endpoint, no model list), and an answer the gateway served from another
 *   step or model (`cf-aig-step` other than 0, `cf-aig-model` not the requested model) is refused, so the profile's
 *   own fallback decides what serves next. An AI Gateway fallback never selects a model the profile does not allow.
 * - Caching and logging follow the label of the conversation a call serves: up to `internal` the instance's settings
 *   decide (`cache`, `logs`, both on by default); above `internal` both are off (`cf-aig-skip-cache: true`,
 *   `cf-aig-collect-log: false`) unless an administrator turned them on for `confidential` explicitly; `restricted`
 *   is never cached or logged. A call outside a lease (the poller, an evaluation) counts as above `internal`.
 * - The gateway is called with the Cloudflare account's token (`cf-aig-authorization`, an authenticated gateway);
 *   the provider's own credential (SigV4, an Entra token, a key) still goes with the request, as AI Gateway passes it on.
 * - Rate limits are the gateway's own (`ensure` writes them with the gateway: requests per interval, fixed or
 *   sliding); a 429 from it is a failure of the call like any other, and the profile's fallback applies.
 *
 * Nothing here runs until an instance names a gateway.
 */

export const AI_GATEWAY_ORIGIN = 'https://gateway.ai.cloudflare.com/v1';

/** `settings.cloud.aiGateway` of a cloud instance. */
export const aiGatewaySettingsSchema = z
  .object({
    /** The Cloudflare cloud account (Exprsn-AI's id) whose gateway it is; its token authenticates the gateway. */
    accountId: z.string().length(26),
    /** The gateway's id (its slug in the dashboard). */
    gatewayId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'lower case letters, digits, dashes and underscores'),
    /** Up to `internal`: may the gateway cache answers (default true), with this TTL in seconds (else the gateway's). */
    cache: z.boolean().default(true),
    cacheTtl: z.number().int().min(60).max(31 * 24 * 3600).nullable().default(null),
    /** Up to `internal`: may the gateway log prompts and answers (default true). */
    logs: z.boolean().default(true),
    /** `confidential` calls: off unless turned on here explicitly. `restricted` calls are never cached or logged. */
    confidential: z.object({ cache: z.boolean().default(false), logs: z.boolean().default(false) }).strict().default({ cache: false, logs: false }),
    /** DigitalOcean GenAI has no native AI Gateway provider: the custom provider's slug (`custom-<slug>`). */
    customProvider: z.string().regex(/^custom-[a-z0-9-]{1,40}$/).optional()
  })
  .strict();
export type AiGatewaySettings = z.infer<typeof aiGatewaySettingsSchema>;

/** The gateway's own settings (`POST /accounts/<id>/ai-gateway/gateways`), as `ensure` writes them. */
export const aiGatewayConfigSchema = z
  .object({
    gatewayId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
    /** Requests per interval the gateway lets through (null: no limit). */
    rateLimit: z.object({ limit: z.number().int().min(1).max(1_000_000), intervalSeconds: z.number().int().min(10).max(3600), technique: z.enum(['fixed', 'sliding']).default('sliding') }).strict().nullable().default(null),
    /** The gateway's default cache TTL (0: off) and logs (off by default: requests turn them on for what may be logged). */
    cacheTtl: z.number().int().min(0).max(31 * 24 * 3600).default(0),
    logs: z.boolean().default(false),
    /** An authenticated gateway takes only requests with a Cloudflare token (default on). */
    authentication: z.boolean().default(true)
  })
  .strict();
export type AiGatewayConfig = z.infer<typeof aiGatewayConfigSchema>;

/** Whether a call of this label may be cached and logged by the gateway, from the instance's settings. */
export function aiGatewayPolicy(settings: AiGatewaySettings, label: Label | null): { cache: boolean; logs: boolean } {
  if (label === 'restricted') return { cache: false, logs: false };
  if (!label || labelRank(label) > labelRank('internal')) return { cache: settings.confidential.cache && label === 'confidential', logs: settings.confidential.logs && label === 'confidential' };
  return { cache: settings.cache, logs: settings.logs };
}

/** The request headers that carry that decision. */
export function aiGatewayPolicyHeaders(settings: AiGatewaySettings, label: Label | null): Record<string, string> {
  const p = aiGatewayPolicy(settings, label);
  return {
    'cf-aig-collect-log': p.logs ? 'true' : 'false',
    ...(p.cache ? (settings.cacheTtl ? { 'cf-aig-cache-ttl': String(settings.cacheTtl) } : {}) : { 'cf-aig-skip-cache': 'true' })
  };
}

/** The kind of backend an instance is, as AI Gateway names its provider. */
export type AiGatewayBackend = 'bedrock' | 'azure' | 'digitalocean' | 'workers-ai';

export function backendOf(row: Pick<InstanceRow, 'kind' | 'settings'>): AiGatewayBackend | null {
  if (row.kind === 'bedrock') return 'bedrock';
  const f = row.settings.cloud?.flavour;
  return f === 'azure' || f === 'digitalocean' || f === 'workers-ai' ? f : null;
}

const INFERENCE = /(^|\/)(chat\/completions|embeddings|converse|converse-stream|invoke)(\?|$)/;

/**
 * The gateway path of an inference call (after `/v1/<account>/<gateway>`), or null for a call that does not go
 * through the gateway (listing models, health).
 *
 *   workers-ai    /workers-ai/v1/chat/completions
 *   azure         /azure-openai/<resource>/<deployment>/chat/completions?api-version=...
 *   digitalocean  /custom-digitalocean/v1/chat/completions (a custom provider whose base is the inference endpoint)
 *   bedrock       /aws-bedrock/bedrock-runtime/<region>/model/<id>/converse
 */
export function aiGatewayPath(backend: AiGatewayBackend, base: string, path: string, o: { region?: string; customProvider?: string } = {}): string | null {
  if (!INFERENCE.test(path.replace(/\?.*$/, '')) && !INFERENCE.test(path)) return null;
  switch (backend) {
    case 'workers-ai':
      return `/workers-ai${path}`;
    case 'digitalocean':
      return `/${o.customProvider ?? 'custom-digitalocean'}${path}`;
    case 'bedrock':
      if (!o.region) return null;
      return `/aws-bedrock/bedrock-runtime/${encodeURIComponent(o.region)}${path}`;
    case 'azure': {
      const m = /^\/openai\/deployments\/([^/]+)\/(.*)$/.exec(path);
      if (!m) return null;
      let resource: string;
      try {
        resource = new URL(base).hostname.split('.')[0]!;
      } catch {
        return null;
      }
      return `/azure-openai/${encodeURIComponent(resource)}/${m[1]}/${m[2]}`;
    }
  }
}

/*
 * The header names are Cloudflare's, checked 2026-10-21: `cf-aig-step` (the fallback step that answered, 0 the
 * primary; developers.cloudflare.com/ai-gateway/usage/universal/#response-header-cf-aig-step) and `cf-aig-model`
 * (the model a dynamic route used; developers.cloudflare.com/ai-gateway/features/dynamic-routing/usage/#response-metadata).
 */
/** Why an answer the gateway gave may not be used: it came from a fallback step or another model. */
export function aiGatewayAnswerProblem(header: (name: string) => string | null | undefined, model: string | null): string | null {
  const step = header('cf-aig-step');
  if (step != null && step !== '' && step !== '0') return `AI Gateway answered from its fallback step ${step}; Exprsn-AI's profile fallback decides which model serves, so the answer is refused.`;
  const served = header('cf-aig-model');
  if (served && model && served !== model && !served.endsWith(`/${model}`)) return `AI Gateway answered with ${served}, not ${model}; a model the profile did not choose is never used.`;
  return null;
}

export interface AiGatewayEndpoints {
  /** The gateway origin with its `/v1` (default `https://gateway.ai.cloudflare.com/v1`). */
  gateway?: string;
  /** The Cloudflare API with `/client/v4` (default `https://api.cloudflare.com/client/v4`), for `ensure`. */
  api?: string;
}

export class CloudAiGateway {
  endpoints: AiGatewayEndpoints = {};

  constructor(private readonly s: () => Services) {}

  /** Wires the gateway's model servers to this (createServices calls it once). */
  install(): void {
    this.s().gateway.aiGateway = { hop: (row) => this.hop(row) };
  }

  private async account(id: string): Promise<CloudAccount> {
    const a = await this.s().cloud.accounts.get(id);
    if (!a) throw new CloudProviderError('The Cloudflare account of this AI Gateway no longer exists.', 'cloudflare', 404, 'no_account');
    if (a.provider !== 'cloudflare') throw new CloudProviderError(`${a.name} is not a Cloudflare account; AI Gateway needs one.`, 'cloudflare', 409, 'wrong_provider');
    if (a.state === 'disabled' || a.state === 'pending') throw new CloudProviderError(`${a.name} is ${a.state}.`, 'cloudflare', 409, 'account_unusable');
    if (!a.providerIds.cloudflareAccountId) throw new CloudProviderError(`${a.name} names no Cloudflare account id.`, 'cloudflare', 409, 'no_account_id');
    return a;
  }

  private async token(a: CloudAccount): Promise<string> {
    const c = this.s().cloud.credentials;
    if (!c) throw new CloudProviderError('Cloud credentials are not available on this server.', 'cloudflare', 503, 'cloud_component_missing');
    const cred = (await c.for(a, 'read')) as { kind: string; token?: string };
    if (cred.kind !== 'token' || !cred.token) throw new CloudProviderError(`${a.name} has no Cloudflare token.`, 'cloudflare', 409, 'wrong_credential');
    return cred.token;
  }

  /** The hop of an instance with `settings.cloud.aiGateway`, or null without one. */
  async hop(row: InstanceRow): Promise<AiGatewayHop | null> {
    const raw = row.settings.cloud?.aiGateway;
    const backend = backendOf(row);
    if (!raw || !backend) return null;
    const settings = aiGatewaySettingsSchema.parse(raw);
    const account = await this.account(settings.accountId);
    const token = await this.token(account);
    const origin = `${(this.endpoints.gateway ?? AI_GATEWAY_ORIGIN).replace(/\/+$/, '')}/${encodeURIComponent(account.providerIds.cloudflareAccountId!)}/${encodeURIComponent(settings.gatewayId)}`;
    const region = row.settings.cloud?.region;
    return {
      url: (base, path) => {
        const p = aiGatewayPath(backend, base, path, { ...(region ? { region } : {}), ...(settings.customProvider ? { customProvider: settings.customProvider } : {}) });
        return p ? `${origin}${p}` : null;
      },
      headers: () => ({ 'cf-aig-authorization': `Bearer ${token}`, ...aiGatewayPolicyHeaders(settings, aiGatewayLabel()) }),
      // Azure names deployments, not models, in the request: only the fallback step is compared there.
      answerProblem: (header, model) => aiGatewayAnswerProblem(header, backend === 'azure' ? null : model)
    };
  }

  /**
   * Creates the gateway on the Cloudflare account, or updates it: rate limits, the default cache TTL, logs (off by
   * default) and authentication. Calls Cloudflare through the adapter's transport (egress guard, rate limiter).
   */
  async ensure(accountId: string, input: AiGatewayConfig): Promise<{ id: string; created: boolean }> {
    const a = await this.account(accountId);
    const token = await this.token(a);
    const t = (await this.s().cloud.providers.adapter('cloudflare')).transport;
    const api = (this.endpoints.api ?? 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');
    const base = `${api}/accounts/${encodeURIComponent(a.providerIds.cloudflareAccountId!)}/ai-gateway/gateways`;
    const body = {
      id: input.gatewayId,
      cache_ttl: input.cacheTtl,
      cache_invalidate_on_update: true,
      collect_logs: input.logs,
      authentication: input.authentication,
      rate_limiting_interval: input.rateLimit?.intervalSeconds ?? 0,
      rate_limiting_limit: input.rateLimit?.limit ?? 0,
      rate_limiting_technique: input.rateLimit?.technique ?? 'sliding'
    };
    const describe = (status: number, b: unknown) => {
      const e = ((b ?? {}) as { errors?: { code?: number; message?: string }[] }).errors?.[0];
      return { message: `Cloudflare answered ${status}${e?.code != null ? ` (${e.code})` : ''}: ${(e?.message ?? 'no detail').slice(0, 300)}`, code: e?.code != null ? String(e.code) : null };
    };
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    let exists = false;
    try {
      await t.json({ method: 'GET', url: `${base}/${encodeURIComponent(input.gatewayId)}`, headers, accountId: a.id }, describe);
      exists = true;
    } catch (err) {
      if (!(err instanceof CloudProviderError) || err.status !== 404) throw err;
    }
    if (exists) await t.json({ method: 'PUT', url: `${base}/${encodeURIComponent(input.gatewayId)}`, headers, body: JSON.stringify(body), accountId: a.id }, describe);
    else await t.json({ method: 'POST', url: base, headers, body: JSON.stringify(body), accountId: a.id }, describe);
    return { id: input.gatewayId, created: !exists };
  }

  /** Checks a gateway setting for an instance: a cloud instance, a usable Cloudflare account the principal may see. */
  async check(row: InstanceRow, settings: AiGatewaySettings, canSee: (a: CloudAccount) => boolean): Promise<void> {
    if (!backendOf(row)) throw conflict('AI Gateway goes in front of a cloud model server only (Bedrock, Azure OpenAI, DigitalOcean GenAI or Workers AI).');
    const a = await this.s().cloud.accounts.get(settings.accountId);
    if (!a || !canSee(a)) throw conflict('The Cloudflare account does not exist.');
    if (a.provider !== 'cloudflare') throw conflict(`${a.name} is not a Cloudflare account; AI Gateway needs one.`);
    if (!a.providerIds.cloudflareAccountId) throw conflict(`${a.name} names no Cloudflare account id.`);
    if (a.state === 'pending' || a.state === 'disabled') throw conflict(`${a.name} is ${a.state}.`);
    // B-10803: the hop puts every prompt through Cloudflare's edge in the clear, so the pool may serve no label the
    // Cloudflare account's region does not admit (as for Workers AI); a tenant's own account never sees a shared pool.
    if (a.scope === 'tenant') throw conflict(`${a.name} is a tenant account; gateway pools serve every tenant, so only a platform Cloudflare account carries AI Gateway.`);
    const pool = await this.s().gateway.repo.pool(row.pool_id);
    if (pool) await this.s().cloud.accounts.assertRegionAllows(a, a.defaultRegion ?? 'global', pool.label_ceiling, { use: 'models' });
  }
}
