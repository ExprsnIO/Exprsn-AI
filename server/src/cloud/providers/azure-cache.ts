import { createPipelineRequest, type Pipeline } from '@azure/core-rest-pipeline';
import { REQUIRED_EVICTION_POLICY, cacheCompatibility, normalisePolicy, type CacheAccess, type CacheProps, type CacheService } from '../caches.js';
import { namePrefix } from '../tags.js';
import { azureHttpClient } from './sdk-bridges.js';
import type { CloudTransport } from './transport.js';
import { CloudProviderError, type CallContext, type ListFilter, type ObservedResource, type OperationHandle, type OperationResult, type PollResult, type ResourceRef, type ResourceSpec } from './types.js';

/*
 * 1.9.99-final, Sprint 59 (B-10305): caches through the Azure adapter, over raw ARM requests through the clients'
 * pipeline (token policy and all) and `CloudTransport`. `azure.ts` hands its `cache` type here.
 *
 * Azure Cache for Redis (`Microsoft.Cache/redis`, the default): Basic `C<n>` without HA, Standard `C<n>` with it,
 * Premium `P<n>` (never sharded: a shard count is cluster mode). The non-TLS port is off, TLS 1.2 minimum, public
 * network access off, `maxmemory-policy noeviction` in the Redis configuration (Azure's default is `volatile-lru`).
 *
 * Azure Managed Redis (`Microsoft.Cache/redisEnterprise`, sizes `Balanced_B1` and the like, or `service:
 * azure-managed-redis`): the cluster and its `default` database with the encrypted client protocol on port 10000,
 * the `NoCluster` clustering policy (the OSS and Enterprise policies shard the keyspace) and `NoEviction`.
 *
 * Both are PUT by name in the managed resource group, then followed by describing until `Succeeded`; with data
 * subnets given, a private endpoint in the first one is made once the cache exists. The access key comes from
 * `listKeys` and goes only to `cloud/caches.ts`, which writes the URL into the vault.
 */

export interface AzureCacheHost {
  transport: CloudTransport;
  arm: () => string;
  pipeline(ctx: CallContext): Pipeline;
  subscription(ctx: CallContext): string;
  rg(ctx: CallContext): string;
  location(ctx: CallContext, spec?: ResourceSpec): string;
  ensureGroup(ctx: CallContext, spec: ResourceSpec): Promise<string>;
}

const API = { redis: '2024-03-01', enterprise: '2025-04-01', network: '2024-05-01' };
const managed = (t: Record<string, string> | undefined) => Object.fromEntries(Object.entries(t ?? {}).filter(([k]) => k.startsWith('exprsn:') && k !== 'exprsn:name'));
const ENTERPRISE_SIZE = /^(Balanced|MemoryOptimized|ComputeOptimized|FlashOptimized|Enterprise|EnterpriseFlash)_/;

interface Arm<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Record<string, string>;
}

interface Phase {
  phase: 'cache' | 'endpoint';
  /** The private endpoint's subnet (provider id), when one is wanted. */
  subnet?: string | null;
  flavor: CacheService;
}

const stateOf = (s: unknown): ObservedResource['state'] => {
  const v = String(s ?? '').toLowerCase();
  if (v === 'succeeded' || v === 'running') return 'ready';
  if (v === 'failed' || v === 'canceled') return 'failed';
  if (v === 'deleting' || v === 'disabling') return 'deleting';
  if (v === 'updating' || v === 'scaling' || v === 'patching' || v === 'upgrading') return 'updating';
  return 'creating';
};

/** `C1`/`P2` to the Azure Cache for Redis SKU. */
function redisSku(size: string, ha: boolean): { name: string; family: string; capacity: number } {
  const m = /^([CP])(\d)$/i.exec(size);
  if (!m) throw new CloudProviderError(`${size} is not an Azure Cache for Redis size (C0 to C6, P1 to P5).`, 'azure', 400, 'invalid_size');
  const family = m[1]!.toUpperCase();
  return { name: family === 'P' ? 'Premium' : ha ? 'Standard' : 'Basic', family, capacity: Number(m[2]) };
}

export class AzureCaches {
  constructor(private readonly h: AzureCacheHost) {}

  flavorOf(p: Partial<CacheProps>): CacheService {
    if (p.service === 'azure-managed-redis' || p.service === 'azure-cache') return p.service;
    return ENTERPRISE_SIZE.test(p.size ?? '') ? 'azure-managed-redis' : 'azure-cache';
  }

  private armName(ctx: CallContext, spec: { name: string }): string {
    return `${namePrefix(ctx.account.name)}${spec.name}`.slice(0, 60).replace(/-$/, '');
  }

  idFor(ctx: CallContext, spec: ResourceSpec): string {
    const flavor = this.flavorOf(spec.props as CacheProps);
    return `/subscriptions/${this.h.subscription(ctx)}/resourceGroups/${this.h.rg(ctx)}/providers/Microsoft.Cache/${flavor === 'azure-managed-redis' ? 'redisEnterprise' : 'redis'}/${this.armName(ctx, spec)}`;
  }

  private endpointId(ctx: CallContext, cacheId: string): string {
    return `/subscriptions/${this.h.subscription(ctx)}/resourceGroups/${this.h.rg(ctx)}/providers/Microsoft.Network/privateEndpoints/${cacheId.split('/').pop()}-pe`;
  }

  private async send<T = Record<string, unknown>>(ctx: CallContext, method: string, url: string, body?: unknown): Promise<Arm<T>> {
    const target = new URL(url, `${this.h.arm()}/`);
    if (target.origin !== new URL(this.h.arm()).origin) throw new CloudProviderError(`Refusing an ARM call off the ARM endpoint (${target.host}).`, 'azure', 502, 'foreign_operation_url');
    const req = createPipelineRequest({ url: target.toString(), method: method as 'GET', ...(body !== undefined ? { body: JSON.stringify(body) } : {}), ...(target.protocol === 'http:' ? { allowInsecureConnection: true } : {}) });
    if (body !== undefined) req.headers.set('content-type', 'application/json');
    const res = await this.h.pipeline(ctx).sendRequest(azureHttpClient(this.h.transport, ctx.account.id), req);
    let parsed: unknown = null;
    if (res.bodyAsText) {
      try {
        parsed = JSON.parse(res.bodyAsText);
      } catch {
        parsed = res.bodyAsText;
      }
    }
    return { status: res.status, body: (parsed ?? {}) as T, headers: res.headers.toJSON() };
  }

  private fail(r: Arm<unknown>, what: string): CloudProviderError {
    const e = ((r.body as { error?: { code?: string; message?: string } }).error ?? {}) as { code?: string; message?: string };
    return new CloudProviderError(`Azure answered ${r.status} for ${what}${e.code ? ` (${e.code})` : ''}: ${(e.message ?? 'no detail').slice(0, 300)}`, 'azure', r.status, e.code ?? null, r.headers['x-ms-request-id'] ?? null, r.status === 429 ? Number(r.headers['retry-after']) || 1 : null);
  }

  // ---------- reads ----------

  private observedRedis(b: Record<string, unknown>): ObservedResource {
    const p = (b.properties ?? {}) as Record<string, unknown>;
    const sku = (p.sku ?? {}) as { name?: string; family?: string; capacity?: number };
    const cfg = (p.redisConfiguration ?? {}) as Record<string, string>;
    const tags = (b.tags ?? {}) as Record<string, string>;
    return {
      type: 'cache',
      providerId: String(b.id),
      name: tags['exprsn:name'] ?? String(b.name),
      ...(b.location ? { region: String(b.location) } : {}),
      state: stateOf(p.provisioningState),
      tags: managed(tags),
      props: { service: 'azure-cache', engine: 'redis', size: sku.family && sku.capacity != null ? `${sku.family}${sku.capacity}` : null, ha: sku.name === 'Standard' || sku.name === 'Premium', clusterMode: Number(p.shardCount ?? 0) > 0, evictionPolicy: cfg['maxmemory-policy'] ? normalisePolicy(cfg['maxmemory-policy']) : null, tls: p.enableNonSslPort !== true, publicAccess: p.publicNetworkAccess !== 'Disabled', host: p.hostName ?? null, port: Number(p.sslPort ?? 6380), status: p.provisioningState ?? null },
      locator: { service: 'azure-cache' }
    };
  }

  private async observedEnterprise(ctx: CallContext, b: Record<string, unknown>): Promise<ObservedResource> {
    const p = (b.properties ?? {}) as Record<string, unknown>;
    const tags = (b.tags ?? {}) as Record<string, string>;
    const db = await this.send<{ properties?: Record<string, unknown> }>(ctx, 'GET', `${String(b.id)}/databases/default?api-version=${API.enterprise}`);
    const d = db.status === 200 ? (db.body.properties ?? {}) : {};
    const clusterState = stateOf(p.provisioningState);
    return {
      type: 'cache',
      providerId: String(b.id),
      name: tags['exprsn:name'] ?? String(b.name),
      ...(b.location ? { region: String(b.location) } : {}),
      state: clusterState === 'ready' && db.status !== 200 ? 'creating' : clusterState === 'ready' ? stateOf(d.provisioningState ?? 'Succeeded') : clusterState,
      tags: managed(tags),
      props: { service: 'azure-managed-redis', engine: 'redis', size: (b.sku as { name?: string } | undefined)?.name ?? null, ha: (p.highAvailability ?? 'Enabled') !== 'Disabled', clusterMode: d.clusteringPolicy == null ? null : d.clusteringPolicy !== 'NoCluster', evictionPolicy: d.evictionPolicy ? normalisePolicy(String(d.evictionPolicy)) : null, tls: d.clientProtocol == null ? null : d.clientProtocol === 'Encrypted', publicAccess: p.publicNetworkAccess == null ? false : p.publicNetworkAccess !== 'Disabled', host: p.hostName ?? null, port: Number(d.port ?? 10000), status: p.provisioningState ?? null },
      locator: { service: 'azure-managed-redis' }
    };
  }

  async describe(ctx: CallContext, ref: ResourceRef): Promise<ObservedResource | null> {
    const enterprise = /\/redisEnterprise\//i.test(ref.providerId);
    const r = await this.send(ctx, 'GET', `${ref.providerId}?api-version=${enterprise ? API.enterprise : API.redis}`);
    if (r.status === 404) return null;
    if (r.status >= 300) throw this.fail(r, `the cache ${ref.providerId.split('/').pop()}`);
    return enterprise ? this.observedEnterprise(ctx, r.body) : this.observedRedis(r.body);
  }

  async find(ctx: CallContext, spec: ResourceSpec): Promise<ObservedResource | null> {
    return this.describe(ctx, { type: 'cache', providerId: this.idFor(ctx, spec) });
  }

  async list(ctx: CallContext, filter: ListFilter): Promise<ObservedResource[]> {
    const base = `/subscriptions/${this.h.subscription(ctx)}/resourceGroups/${this.h.rg(ctx)}/providers/Microsoft.Cache`;
    const out: ObservedResource[] = [];
    for (const [kind, api] of [['redis', API.redis], ['redisEnterprise', API.enterprise]] as const) {
      const r = await this.send<{ value?: Record<string, unknown>[] }>(ctx, 'GET', `${base}/${kind}?api-version=${api}`);
      if (r.status === 404) continue;
      if (r.status >= 300) throw this.fail(r, `the ${kind} caches`);
      for (const b of r.body.value ?? []) out.push(kind === 'redis' ? this.observedRedis(b) : await this.observedEnterprise(ctx, b));
    }
    return filter.managedOnly ? out.filter((o) => o.tags['exprsn:managed'] === 'true' && o.tags['exprsn:account'] === ctx.account.name) : out;
  }

  // ---------- changes ----------

  private refuseIncompatible(p: CacheProps): void {
    const problems = cacheCompatibility({ clusterMode: p.clusterMode ?? false, evictionPolicy: p.evictionPolicy ?? REQUIRED_EVICTION_POLICY, tls: p.tls ?? true, publicAccess: p.publicAccess ?? false });
    if (problems.length) throw new CloudProviderError(`Refused as REDIS_URL: ${problems.map((x) => x.reason).join(' ')}`, 'azure', 409, 'cache_incompatible');
  }

  /** The PUT by name a create and an update are; followed by describing (then the private endpoint). */
  async put(ctx: CallContext, spec: ResourceSpec, op: 'create' | 'update', handle: (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string) => OperationHandle): Promise<OperationResult> {
    const p = spec.props as CacheProps;
    this.refuseIncompatible(p);
    await this.h.ensureGroup(ctx, spec);
    const flavor = this.flavorOf(p);
    const id = this.idFor(ctx, spec);
    const location = this.h.location(ctx, spec);
    const tags = { ...spec.tags, 'exprsn:name': spec.name };
    let r: Arm;
    if (flavor === 'azure-cache') {
      r = await this.send(ctx, 'PUT', `${id}?api-version=${API.redis}`, { location, tags, properties: { sku: redisSku(p.size, !!p.ha), enableNonSslPort: false, minimumTlsVersion: '1.2', publicNetworkAccess: 'Disabled', ...(p.version ? { redisVersion: p.version } : {}), redisConfiguration: { 'maxmemory-policy': p.evictionPolicy ?? REQUIRED_EVICTION_POLICY } } });
      if (r.status >= 300) throw this.fail(r, `the cache ${spec.name}`);
    } else {
      r = await this.send(ctx, 'PUT', `${id}?api-version=${API.enterprise}`, { location, tags, sku: { name: p.size }, properties: { minimumTlsVersion: '1.2', highAvailability: p.ha === false ? 'Disabled' : 'Enabled', publicNetworkAccess: 'Disabled' } });
      if (r.status >= 300) throw this.fail(r, `the cache ${spec.name}`);
      const d = await this.send(ctx, 'PUT', `${id}/databases/default?api-version=${API.enterprise}`, { properties: { clientProtocol: 'Encrypted', port: 10000, clusteringPolicy: 'NoCluster', evictionPolicy: 'NoEviction' } });
      if (d.status >= 300) throw this.fail(d, `the cache ${spec.name}'s database`);
    }
    const subnetKey = p.subnets?.[0];
    const phase: Phase = { phase: 'cache', subnet: subnetKey ? (spec.parent?.refs?.[subnetKey] ?? null) : null, flavor };
    const ref: ResourceRef = { type: 'cache', providerId: id, region: location, locator: { service: flavor } };
    const requestId = r.headers['x-ms-request-id'];
    return { done: false, operation: handle(op, ref, 'describe', JSON.stringify(phase)), ...(requestId ? { requestId } : {}) };
  }

  async delete(ctx: CallContext, ref: ResourceRef, handle: (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string) => OperationHandle): Promise<OperationResult> {
    const enterprise = /\/redisEnterprise\//i.test(ref.providerId);
    await this.send(ctx, 'DELETE', `${this.endpointId(ctx, ref.providerId)}?api-version=${API.network}`).catch(() => undefined);
    const r = await this.send(ctx, 'DELETE', `${ref.providerId}?api-version=${enterprise ? API.enterprise : API.redis}`);
    if (r.status === 404 || r.status === 204) return { done: true, resource: null };
    if (r.status >= 300) throw this.fail(r, `deleting ${ref.providerId.split('/').pop()}`);
    return { done: false, operation: handle('delete', ref, 'describe', JSON.stringify({ phase: 'cache', flavor: enterprise ? 'azure-managed-redis' : 'azure-cache' } satisfies Phase)) };
  }

  async poll(ctx: CallContext, h: OperationHandle): Promise<PollResult> {
    let phase: Phase = { phase: 'cache', flavor: 'azure-cache' };
    try {
      phase = JSON.parse(h.token) as Phase;
    } catch {
      /* an older handle: describe only */
    }
    const o = await this.describe(ctx, h.ref);
    if (h.op === 'delete') return o ? { state: 'pending', waitMs: 10_000 } : { state: 'succeeded', resource: null };
    if (!o) return { state: 'failed', error: `${h.ref.providerId.split('/').pop()} disappeared while it was being made.`, code: 'not_found' };
    if (o.state === 'failed') return { state: 'failed', error: `${h.ref.providerId.split('/').pop()} failed (${String(o.props.status ?? 'Failed')}).` };
    if (o.state !== 'ready') return { state: 'pending', waitMs: 10_000 };
    if (!phase.subnet) return { state: 'succeeded', resource: o };
    // The private endpoint in the data subnet, once the cache exists (PUT by name: a repeated poll is the same one).
    const peId = this.endpointId(ctx, h.ref.providerId);
    const pe = await this.send<{ properties?: { provisioningState?: string } }>(ctx, 'GET', `${peId}?api-version=${API.network}`);
    if (pe.status === 404) {
      const put = await this.send(ctx, 'PUT', `${peId}?api-version=${API.network}`, { location: o.region, tags: o.tags, properties: { subnet: { id: phase.subnet }, privateLinkServiceConnections: [{ name: 'cache', properties: { privateLinkServiceId: h.ref.providerId, groupIds: [phase.flavor === 'azure-managed-redis' ? 'redisEnterprise' : 'redisCache'] } }] } });
      if (put.status >= 300) return { state: 'failed', error: this.fail(put, 'the cache’s private endpoint').message };
      return { state: 'pending', waitMs: 5000 };
    }
    if (pe.status >= 300) return { state: 'failed', error: this.fail(pe, 'the cache’s private endpoint').message };
    const st = stateOf(pe.body.properties?.provisioningState ?? 'Succeeded');
    if (st === 'failed') return { state: 'failed', error: 'The cache’s private endpoint failed.' };
    return st === 'ready' ? { state: 'succeeded', resource: { ...o, props: { ...o.props, privateEndpoint: peId } } } : { state: 'pending', waitMs: 5000 };
  }

  /** The host, the TLS port and the primary access key (`listKeys`). */
  async access(ctx: CallContext, ref: ResourceRef): Promise<CacheAccess> {
    const o = await this.describe(ctx, ref);
    if (!o || o.state !== 'ready' || !o.props.host) throw new CloudProviderError(`${ref.providerId.split('/').pop()} is not ready yet.`, 'azure', 409, 'cache_not_ready');
    const enterprise = o.props.service === 'azure-managed-redis';
    const r = await this.send<{ primaryKey?: string }>(ctx, 'POST', enterprise ? `${ref.providerId}/databases/default/listKeys?api-version=${API.enterprise}` : `${ref.providerId}/listKeys?api-version=${API.redis}`);
    if (r.status >= 300) throw this.fail(r, 'the cache’s access keys');
    if (!r.body.primaryKey) throw new CloudProviderError('Azure answered listKeys without a key.', 'azure', 502, 'malformed');
    return { host: String(o.props.host), port: Number(o.props.port), username: null, token: r.body.primaryKey };
  }
}
