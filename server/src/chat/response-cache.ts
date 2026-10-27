import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { actorFrom } from '../audit/chain.js';
import { clears, isLabel, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { notFound } from '../http/problem.js';
import type { Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';

/*
 * 1.7.0, Sprint 43 (B-99, decision D11a): an exact-match answer cache for chat and `/v1` turns, opt-in per profile.
 *
 * The key is a SHA-256 over everything that could change the answer or who may see it: the tenant, the workspace,
 * the conversation's label, the profile and its version, the model and its digest (or the server's model id), the
 * versions of the guardrail rule sets that apply, the parameters (think level, context size, temperature, tools
 * offered) and the whole message list sent to the model, retrieved context included. So the same question in two
 * tenants never shares an entry, and publishing a new rule set version misses the cache.
 *
 * What is cached: an answer that completed, passed the output check unchanged, was not held, and (unless the
 * profile's `cache_lenient` says so) made no tool call, had no attachment and ran at temperature 0. Entries are
 * sealed with the tenant key (associated data `response-cache:<id>`) and expire after the profile's
 * `cache_ttl_seconds`. A hit is served only to a caller cleared for the entry's label; it still passed the
 * user-input checkpoint (that runs at send) and passes the output check again; it is metered as a cache hit with no
 * model tokens and audited. Entries are purged per tenant, profile or entry.
 */

export const CACHE_SWEEP_JOB = 'chat.cache.sweep';

export interface CacheParts {
  tenantId: string;
  workspaceId: string | null;
  label: Label;
  profileId: string;
  profileVersion: number;
  model: string;
  modelDigest: string | null;
  guardrails: string;
  params: Record<string, unknown>;
  messages: unknown;
}

export interface CacheEntry {
  id: string;
  content: string;
  thinking: string;
  label: Label;
  model: string;
  createdAt: number;
  /** The answer's citations (JSON), restored on the message a hit answers. */
  citations: string | null;
}

export interface CachePolicy {
  ttlSeconds: number;
  lenient: boolean;
}

/** A canonical JSON (sorted keys) so equal inputs hash equal. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as Record<string, unknown>).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

export const cacheKey = (parts: CacheParts): string => createHash('sha256').update(canonical({ v: 1, ...parts })).digest('hex');

/** The profile's cache settings, or null when the profile does not cache. */
export function cachePolicy(profile: { cache_ttl_seconds?: number | null; cache_lenient?: boolean | number | null }): CachePolicy | null {
  const ttl = Number(profile.cache_ttl_seconds ?? 0);
  return ttl > 0 ? { ttlSeconds: ttl, lenient: !!profile.cache_lenient } : null;
}

export class ResponseCache {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  /** A live entry for the key that the caller may read, or null. Counts the hit. */
  async get(p: Principal, key: string): Promise<CacheEntry | null> {
    const r = (await this.db('chat_response_cache').where({ tenant_id: p.tenantId, key_hash: key }).first()) as Record<string, unknown> | undefined;
    if (!r) return null;
    if (Number(r.expires_at) <= Date.now()) {
      await this.db('chat_response_cache').where({ id: r.id }).delete();
      return null;
    }
    const label = String(r.label);
    if (!isLabel(label) || !clears(p.clearance, label)) return null;
    const id = String(r.id);
    const keys = this.s().keys;
    const content = await keys.open(p.tenantId, String(r.content), `response-cache:${id}`);
    const thinking = r.thinking ? await keys.open(p.tenantId, String(r.thinking), `response-cache:${id}:thinking`) : '';
    const citations = r.citations ? await keys.open(p.tenantId, String(r.citations), `response-cache:${id}:citations`) : null;
    await this.db('chat_response_cache').where({ id }).update({ hits: Number(r.hits ?? 0) + 1, last_hit_at: Date.now() });
    return { id, content, thinking, label, model: String(r.model), createdAt: Number(r.created_at), citations };
  }

  /** Stores an answer under the key (replacing an expired or older entry of the same key). */
  async put(input: { tenantId: string; workspaceId: string | null; profileId: string; key: string; label: Label; model: string; content: string; thinking: string; citations?: string | null; ttlSeconds: number; source: 'chat' | 'v1' }): Promise<string> {
    const id = ulid();
    const keys = this.s().keys;
    const t = Date.now();
    const row = {
      id,
      tenant_id: input.tenantId,
      workspace_id: input.workspaceId,
      profile_id: input.profileId,
      key_hash: input.key,
      label: input.label,
      model: input.model,
      source: input.source,
      content: await keys.seal(input.tenantId, input.content, `response-cache:${id}`),
      thinking: input.thinking ? await keys.seal(input.tenantId, input.thinking, `response-cache:${id}:thinking`) : null,
      citations: input.citations ? await keys.seal(input.tenantId, input.citations, `response-cache:${id}:citations`) : null,
      hits: 0,
      created_at: t,
      expires_at: t + input.ttlSeconds * 1000,
      last_hit_at: null
    };
    await this.db.transaction(async (trx) => {
      await trx('chat_response_cache').where({ tenant_id: input.tenantId, key_hash: input.key }).delete();
      await trx('chat_response_cache').insert(row);
    });
    return id;
  }

  /** Purges a tenant's entries, a profile's, or one entry. Returns how many went. Audited by the caller's route. */
  async purge(p: Principal, scope: { profileId?: string; entryId?: string } = {}, ctx: { ip?: string | null; traceId?: string | null } = {}): Promise<number> {
    if (scope.entryId && !(await this.db('chat_response_cache').where({ tenant_id: p.tenantId, id: scope.entryId }).first('id'))) throw notFound('Cache entry');
    const n = await this.db('chat_response_cache').where({ tenant_id: p.tenantId }).modify((q) => {
      if (scope.profileId) void q.where({ profile_id: scope.profileId });
      if (scope.entryId) void q.where({ id: scope.entryId });
    }).delete();
    await this.s().audit.append({ tenantId: p.tenantId, action: 'chat.cache.purged', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { ...(scope.profileId ? { profile: scope.profileId } : {}), ...(scope.entryId ? { entry: scope.entryId } : {}), ...(!scope.profileId && !scope.entryId ? { tenant: p.tenantId } : {}) }, detail: { removed: Number(n) }, traceId: ctx.traceId ?? null });
    return Number(n);
  }

  /** Expired entries go (the sweep). */
  async sweep(): Promise<number> {
    return Number(await this.db('chat_response_cache').where('expires_at', '<=', Date.now()).delete());
  }

  registerJobs(): void {
    this.s().jobs.register(CACHE_SWEEP_JOB, async () => ({ removed: await this.sweep() }));
  }

  /** Every ten minutes, when an entry has expired. */
  schedule(scheduler: Scheduler): void {
    scheduler.every(CACHE_SWEEP_JOB, 10 * 60_000, async () => ((await this.db('chat_response_cache').where('expires_at', '<=', Date.now()).first('tenant_id')) as { tenant_id: string } | undefined) ? [{ tenantId: 'platform', key: 'all' }] : []);
  }

  /**
   * Per profile: entries, hits stored on the entries, and the hit rate over the last `days` of metered turns
   * (cache hits over all turns of the profile in `usage_records`).
   */
  async stats(tenantId: string, days = 7) {
    const since = Date.now() - days * 86_400_000;
    const entries = (await this.db('chat_response_cache').where({ tenant_id: tenantId }).where('expires_at', '>', Date.now()).groupBy('profile_id').select('profile_id').count({ n: '*' }).sum({ hits: 'hits' })) as { profile_id: string; n: number | string; hits: number | string | null }[];
    const turns = (await this.db('usage_records').where({ tenant_id: tenantId }).where('ts', '>=', since).whereIn('kind', ['chat', 'compare', 'api']).whereNotNull('profile_id').groupBy('profile_id', 'cache_hit').select('profile_id', 'cache_hit').count({ n: '*' })) as { profile_id: string; cache_hit: boolean | number | null; n: number | string }[];
    const ids = [...new Set([...entries.map((e) => e.profile_id), ...turns.map((t) => t.profile_id)])];
    const names = new Map(((await this.db('profiles').whereIn('id', ids.length ? ids : ['']).select('id', 'name', 'cache_ttl_seconds')) as { id: string; name: string; cache_ttl_seconds: number | null }[]).map((p) => [p.id, p]));
    return ids.map((id) => {
      const e = entries.find((x) => x.profile_id === id);
      const hits = turns.filter((t) => t.profile_id === id && !!t.cache_hit).reduce((a, t) => a + Number(t.n), 0);
      const all = turns.filter((t) => t.profile_id === id).reduce((a, t) => a + Number(t.n), 0);
      return { profileId: id, profile: names.get(id)?.name ?? id, ttlSeconds: names.get(id)?.cache_ttl_seconds ?? null, entries: Number(e?.n ?? 0), storedHits: Number(e?.hits ?? 0), turns: all, hits, hitRate: all ? hits / all : 0, days };
    }).sort((a, b) => a.profile.localeCompare(b.profile));
  }
}
