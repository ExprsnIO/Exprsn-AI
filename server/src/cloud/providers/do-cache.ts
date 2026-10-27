import { createHash } from 'node:crypto';
import { REQUIRED_EVICTION_POLICY, cacheCompatibility, normalisePolicy, type CacheAccess, type CacheProps } from '../caches.js';
import { namePrefix } from '../tags.js';
import { CloudProviderError, type CallContext, type ListFilter, type ObservedResource, type OperationHandle, type OperationResult, type PollResult, type ResourceRef, type ResourceSpec } from './types.js';

/*
 * 1.9.99-final, Sprint 59 (B-10305): DigitalOcean Managed Valkey through the DigitalOcean adapter
 * (`digitalocean.ts` hands its `cache` type here), over `/v2/databases` with `engine: valkey`.
 *
 * The cluster lives in the deployment VPC (`private_network_uuid`), is found again by its name
 * (`exprsn-<account>-<name>`), carries the `exprsn:*` tags, and is followed by describing until `online`. Then its
 * eviction policy is set to `noeviction` (`PUT .../eviction_policy`; DigitalOcean's default evicts) and, with
 * `allowCidrs`, its trusted sources are set. Managed Valkey has no cluster mode. The password DigitalOcean generates
 * is read back from the cluster's private connection for `cloud/caches.ts` only (never into observed state).
 */

export interface DoCacheHost {
  call<T>(ctx: CallContext, method: string, path: string, body?: unknown): Promise<{ status: number; body: T; requestId: string | null }>;
  all<T>(ctx: CallContext, path: string, key: string): Promise<T[]>;
  region(ctx: CallContext, spec?: ResourceSpec): string;
}

interface DoConnection { host?: string; port?: number; user?: string; password?: string; ssl?: boolean }
interface DoDatabase { id: string; name: string; engine: string; version?: string; status: string; size: string; region: string; num_nodes: number; tags?: string[] | null; private_network_uuid?: string; connection?: DoConnection; private_connection?: DoConnection }

const CACHE_ENGINES = new Set(['valkey', 'redis']);
const tagStrings = (tags: Record<string, string>) => Object.entries(tags).map(([k, v]) => `${k}:${v}`);
function parseTags(list: string[] | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of list ?? []) {
    const m = /^(exprsn:[a-z_]+):(.*)$/.exec(t);
    if (m && m[1] !== 'exprsn:name') out[m[1]!] = m[2]!;
  }
  return out;
}

const stateOf = (s: string): ObservedResource['state'] => (s === 'online' ? 'ready' : s === 'resizing' || s === 'migrating' ? 'updating' : 'creating');

interface Phase {
  phase: 'cluster' | 'settings';
  evictionPolicy: string;
  allowCidrs: string[];
}

export class DoCaches {
  constructor(private readonly h: DoCacheHost) {}

  clusterName(ctx: CallContext, spec: { name: string }): string {
    const n = `${namePrefix(ctx.account.name)}${spec.name}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    return n.length <= 63 ? n : `${n.slice(0, 54)}-${createHash('sha256').update(n).digest('hex').slice(0, 8)}`;
  }

  private async eviction(ctx: CallContext, id: string): Promise<string | null> {
    try {
      const r = await this.h.call<{ eviction_policy?: string }>(ctx, 'GET', `/v2/databases/${id}/eviction_policy`);
      return r.body.eviction_policy ? normalisePolicy(r.body.eviction_policy) : null;
    } catch (err) {
      if (err instanceof CloudProviderError && err.status === 404) return null;
      throw err;
    }
  }

  private async observed(ctx: CallContext, d: DoDatabase): Promise<ObservedResource> {
    const c = d.private_connection ?? d.connection ?? {};
    const tags = d.tags ?? [];
    return {
      type: 'cache',
      providerId: d.id,
      name: tags.find((t) => t.startsWith('exprsn:name:'))?.slice('exprsn:name:'.length) ?? d.name,
      region: d.region,
      state: stateOf(d.status),
      tags: parseTags(tags),
      props: { service: 'do-valkey', engine: d.engine, version: d.version ?? null, size: d.size, ha: d.num_nodes > 1, clusterMode: false, evictionPolicy: d.status === 'online' ? await this.eviction(ctx, d.id) : null, tls: c.ssl !== false, publicAccess: !d.private_network_uuid, host: c.host ?? null, port: Number(c.port ?? 25061), networkId: d.private_network_uuid ?? null, status: d.status },
      locator: { service: 'do-valkey' }
    };
  }

  async describe(ctx: CallContext, ref: ResourceRef): Promise<ObservedResource | null> {
    try {
      const r = await this.h.call<{ database: DoDatabase }>(ctx, 'GET', `/v2/databases/${ref.providerId}`);
      return CACHE_ENGINES.has(r.body.database.engine) ? this.observed(ctx, r.body.database) : null;
    } catch (err) {
      if (err instanceof CloudProviderError && err.status === 404) return null;
      throw err;
    }
  }

  async find(ctx: CallContext, spec: ResourceSpec): Promise<ObservedResource | null> {
    const name = this.clusterName(ctx, spec);
    const d = (await this.h.all<DoDatabase>(ctx, '/v2/databases', 'databases')).find((x) => x.name === name && CACHE_ENGINES.has(x.engine));
    return d ? this.observed(ctx, d) : null;
  }

  async list(ctx: CallContext, filter: ListFilter): Promise<ObservedResource[]> {
    const out: ObservedResource[] = [];
    for (const d of await this.h.all<DoDatabase>(ctx, '/v2/databases', 'databases')) if (CACHE_ENGINES.has(d.engine)) out.push(await this.observed(ctx, d));
    return filter.managedOnly ? out.filter((o) => o.tags['exprsn:managed'] === 'true' && o.tags['exprsn:account'] === ctx.account.name) : out;
  }

  private refuseIncompatible(p: CacheProps): void {
    const problems = cacheCompatibility({ clusterMode: p.clusterMode ?? false, evictionPolicy: p.evictionPolicy ?? REQUIRED_EVICTION_POLICY, tls: p.tls ?? true, publicAccess: p.publicAccess ?? false });
    if (problems.length) throw new CloudProviderError(`Refused as REDIS_URL: ${problems.map((x) => x.reason).join(' ')}`, 'digitalocean', 409, 'cache_incompatible');
  }

  private phase(p: CacheProps): Phase {
    return { phase: 'cluster', evictionPolicy: (p.evictionPolicy ?? REQUIRED_EVICTION_POLICY).replace(/-/g, '_'), allowCidrs: p.allowCidrs ?? [] };
  }

  async create(ctx: CallContext, spec: ResourceSpec, handle: (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string) => OperationHandle): Promise<OperationResult> {
    const p = spec.props as CacheProps;
    this.refuseIncompatible(p);
    const existing = await this.find(ctx, spec);
    if (existing) return { done: false, operation: handle('create', existing, 'describe', JSON.stringify(this.phase(p))), resource: existing, adopted: true };
    if (!spec.parent?.networkId) throw new CloudProviderError('A managed Valkey cluster lives in the deployment VPC (parent.networkId).', 'digitalocean', 400, 'parent_required');
    const r = await this.h.call<{ database: DoDatabase }>(ctx, 'POST', '/v2/databases', { name: this.clusterName(ctx, spec), engine: p.engine === 'redis' ? 'redis' : 'valkey', ...(p.version ? { version: p.version } : {}), size: p.size, region: this.h.region(ctx, spec), num_nodes: p.ha ? 2 : 1, private_network_uuid: spec.parent.networkId, tags: [...tagStrings(spec.tags), `exprsn:name:${spec.name}`] });
    const ref: ResourceRef = { type: 'cache', providerId: r.body.database.id, region: r.body.database.region, locator: { service: 'do-valkey' } };
    return { done: false, operation: handle('create', ref, 'describe', JSON.stringify(this.phase(p))), ...(r.requestId ? { requestId: r.requestId } : {}) };
  }

  async update(ctx: CallContext, ref: ResourceRef, spec: ResourceSpec, handle: (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string) => OperationHandle): Promise<OperationResult> {
    const p = spec.props as CacheProps;
    this.refuseIncompatible(p);
    const current = await this.describe(ctx, ref);
    if (!current) throw new CloudProviderError(`${ref.providerId} no longer exists.`, 'digitalocean', 404, 'not_found');
    if (current.props.size !== p.size || current.props.ha !== !!p.ha) await this.h.call(ctx, 'PUT', `/v2/databases/${ref.providerId}/resize`, { size: p.size, num_nodes: p.ha ? 2 : 1 });
    return { done: false, operation: handle('update', ref, 'describe', JSON.stringify(this.phase(p))) };
  }

  async delete(ctx: CallContext, ref: ResourceRef): Promise<OperationResult> {
    try {
      await this.h.call(ctx, 'DELETE', `/v2/databases/${ref.providerId}`);
    } catch (err) {
      if (!(err instanceof CloudProviderError && err.status === 404)) throw err;
    }
    return { done: true, resource: null };
  }

  async poll(ctx: CallContext, h: OperationHandle): Promise<PollResult> {
    const o = await this.describe(ctx, h.ref);
    if (h.op === 'delete') return o ? { state: 'pending', waitMs: 5000 } : { state: 'succeeded', resource: null };
    if (!o) return { state: 'failed', error: `${h.ref.providerId} disappeared while it was being made.`, code: 'not_found' };
    if (o.state !== 'ready') return { state: 'pending', waitMs: 10_000 };
    let ph: Phase = { phase: 'cluster', evictionPolicy: REQUIRED_EVICTION_POLICY, allowCidrs: [] };
    try {
      ph = JSON.parse(h.token) as Phase;
    } catch {
      /* default */
    }
    // Once online: the eviction policy (DigitalOcean's spelling uses underscores) and the trusted sources, then read back.
    if (o.props.evictionPolicy !== normalisePolicy(ph.evictionPolicy)) await this.h.call(ctx, 'PUT', `/v2/databases/${h.ref.providerId}/eviction_policy`, { eviction_policy: ph.evictionPolicy });
    if (ph.allowCidrs.length) await this.h.call(ctx, 'PUT', `/v2/databases/${h.ref.providerId}/firewall`, { rules: ph.allowCidrs.map((value) => ({ type: 'ip_addr', value })) });
    return { state: 'succeeded', resource: await this.describe(ctx, h.ref) };
  }

  /** The private host and port, the user and the password DigitalOcean generated. */
  async access(ctx: CallContext, ref: ResourceRef): Promise<CacheAccess> {
    const r = await this.h.call<{ database: DoDatabase }>(ctx, 'GET', `/v2/databases/${ref.providerId}`);
    const d = r.body.database;
    const c = d.private_connection ?? d.connection;
    if (d.status !== 'online' || !c?.host || !c.password) throw new CloudProviderError(`${d.name} is not online yet.`, 'digitalocean', 409, 'cache_not_ready');
    return { host: c.host, port: Number(c.port ?? 25061), username: c.user ?? 'default', token: c.password };
  }
}
