import { createHash } from 'node:crypto';
import { signV4 } from '../../platform/blob.js';
import { cacheCompatibility, REQUIRED_EVICTION_POLICY, type CacheAccess, type CacheProps } from '../caches.js';
import { xmlAll, xmlText } from '../credential-http.js';
import { namePrefix } from '../tags.js';
import type { CloudTransport } from './transport.js';
import { CloudProviderError, type CallContext, type ListFilter, type ObservedResource, type OperationHandle, type OperationResult, type PollResult, type ResourceRef, type ResourceSpec } from './types.js';

/*
 * 1.9.99-final, Sprint 59 (B-10305): caches through the AWS adapter. `aws.ts` hands its `cache` type here.
 *
 * ElastiCache for Valkey or Redis OSS over the Query API (`2015-02-02`, SigV4 `elasticache`) on the adapter's
 * transport: a replication group with cluster mode off (`ClusterMode=disabled`, one node group: a primary and, with
 * HA, one replica with automatic failover and Multi-AZ), in-transit and at-rest encryption, the AUTH token Exprsn-AI
 * chose (asked of the secret broker as `cache_auth_token`, never in props, observed state or the journal), a cache
 * subnet group of the data subnets, the data zone's security group, and the account's own parameter group per engine
 * family with `maxmemory-policy noeviction` (the default groups evict: `volatile-lru`). The replication group's id is
 * `exprsn-<account>-<name>` (40 characters at most; a longer one is shortened with a digest), so a retried create
 * finds it. Long-running operations are followed by describing until `available` (`describe` handles).
 *
 * MemoryDB (JSON, `AmazonMemoryDB`) is described and listed only: a MemoryDB cluster is always in cluster mode, so
 * it is never created for, or accepted as, `REDIS_URL` (`cacheCompatibility` says why).
 */

export interface AwsCacheHost {
  transport: CloudTransport;
  /** The service endpoint for a region (tests: the fake). */
  endpoint(service: 'elasticache' | 'memorydb', region: string): string;
  region(ctx: CallContext, spec?: { region?: string }): string;
}

const VERSION = '2015-02-02';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const managed = (t: Record<string, string>) => Object.fromEntries(Object.entries(t).filter(([k]) => k.startsWith('exprsn:') && k !== 'exprsn:name'));

const stateOf = (s: string | null | undefined): ObservedResource['state'] => {
  const v = (s ?? '').toLowerCase();
  if (v === 'available' || v === 'active') return 'ready';
  if (v === 'creating') return 'creating';
  if (v === 'deleting') return 'deleting';
  if (v === 'modifying' || v === 'snapshotting' || v === 'updating') return 'updating';
  if (v === 'create-failed' || v === 'failed') return 'failed';
  return 'creating';
};

/** A Query API id: lower case letters, digits and hyphens, starting with a letter, no double or trailing hyphen. */
function cacheId(base: string, max = 40): string {
  let id = base.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!/^[a-z]/.test(id)) id = `x${id}`;
  if (id.length > max) id = `${id.slice(0, max - 13).replace(/-$/, '')}-${sha(base).slice(0, 12)}`;
  return id;
}

export class AwsCaches {
  constructor(private readonly h: AwsCacheHost) {}

  names(ctx: CallContext, spec: { name: string }, family?: string) {
    const base = `${namePrefix(ctx.account.name)}${spec.name}`;
    return { group: cacheId(base), subnets: cacheId(`${base}-subnets`, 255), params: family ? cacheId(`${namePrefix(ctx.account.name)}noeviction-${family}`, 255) : '' };
  }

  // ---------- the wire ----------

  private async query(ctx: CallContext, region: string, action: string, params: Record<string, string>): Promise<{ text: string; requestId: string | null }> {
    if (ctx.cred.kind !== 'aws') throw new CloudProviderError('An AWS account needs an AWS credential.', 'aws', 400, 'wrong_credential');
    const url = new URL(this.h.endpoint('elasticache', region));
    const body = new URLSearchParams({ Action: action, Version: VERSION, ...params }).toString();
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' };
    if (ctx.cred.sessionToken) headers['x-amz-security-token'] = ctx.cred.sessionToken;
    const signed = signV4({ method: 'POST', url, headers, payloadHash: sha(body), region, service: 'elasticache', accessKeyId: ctx.cred.accessKeyId, secretAccessKey: ctx.cred.secretAccessKey, date: new Date() });
    const res = await this.h.transport.send({ method: 'POST', url, headers: signed, body, accountId: ctx.account.id, ...(ctx.signal ? { signal: ctx.signal } : {}) });
    const text = res.body.toString('utf8');
    if (res.status >= 300) {
      const code = xmlText(text, 'Code');
      const notFound = /NotFound/.test(code ?? '');
      throw new CloudProviderError(`AWS ElastiCache answered ${res.status}${code ? ` (${code})` : ''}: ${(xmlText(text, 'Message') ?? 'no detail').slice(0, 300)}`, 'aws', notFound ? 404 : res.status, code, res.requestId);
    }
    return { text, requestId: res.requestId };
  }

  private async memorydb<T>(ctx: CallContext, region: string, action: string, body: unknown): Promise<T> {
    if (ctx.cred.kind !== 'aws') throw new CloudProviderError('An AWS account needs an AWS credential.', 'aws', 400, 'wrong_credential');
    const url = new URL(this.h.endpoint('memorydb', region));
    const payload = JSON.stringify(body ?? {});
    const headers: Record<string, string> = { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': `AmazonMemoryDB.${action}` };
    if (ctx.cred.sessionToken) headers['x-amz-security-token'] = ctx.cred.sessionToken;
    const signed = signV4({ method: 'POST', url, headers, payloadHash: sha(payload), region, service: 'memorydb', accessKeyId: ctx.cred.accessKeyId, secretAccessKey: ctx.cred.secretAccessKey, date: new Date() });
    const res = await this.h.transport.send({ method: 'POST', url, headers: signed, body: payload, accountId: ctx.account.id, ...(ctx.signal ? { signal: ctx.signal } : {}) });
    let parsed: Record<string, unknown> = {};
    try {
      parsed = res.body.length ? (JSON.parse(res.body.toString('utf8')) as Record<string, unknown>) : {};
    } catch {
      /* not JSON */
    }
    if (res.status >= 300) {
      const code = String(parsed.__type ?? '').split('#').pop() || null;
      throw new CloudProviderError(`AWS MemoryDB answered ${res.status}${code ? ` (${code})` : ''}: ${String(parsed.message ?? 'no detail').slice(0, 300)}`, 'aws', /NotFound/.test(code ?? '') ? 404 : res.status, code, res.requestId);
    }
    return parsed as T;
  }

  // ---------- reads ----------

  private async tagsOf(ctx: CallContext, region: string, arn: string | null): Promise<Record<string, string>> {
    if (!arn) return {};
    const r = await this.query(ctx, region, 'ListTagsForResource', { ResourceName: arn }).catch(() => null);
    if (!r) return {};
    return Object.fromEntries(xmlAll(r.text, 'Tag').map((t) => [xmlText(t, 'Key') ?? '', xmlText(t, 'Value') ?? '']).filter(([k]) => k));
  }

  /** `maxmemory-policy` of the group a member cluster uses (null when it cannot be read). */
  private async evictionOf(ctx: CallContext, region: string, member: string | null): Promise<{ policy: string | null; group: string | null }> {
    if (!member) return { policy: null, group: null };
    const c = await this.query(ctx, region, 'DescribeCacheClusters', { CacheClusterId: member }).catch(() => null);
    const group = c ? xmlText(xmlText(c.text, 'CacheParameterGroup') ?? '', 'CacheParameterGroupName') : null;
    if (!group) return { policy: null, group: null };
    let marker: string | null = null;
    for (let page = 0; page < 20; page++) {
      const r = await this.query(ctx, region, 'DescribeCacheParameters', { CacheParameterGroupName: group, MaxRecords: '100', ...(marker ? { Marker: marker } : {}) });
      for (const p of xmlAll(r.text, 'Parameter')) if (xmlText(p, 'ParameterName') === 'maxmemory-policy') return { policy: xmlText(p, 'ParameterValue'), group };
      marker = xmlText(r.text, 'Marker');
      if (!marker) break;
    }
    return { policy: null, group };
  }

  private async observed(ctx: CallContext, region: string, xml: string): Promise<ObservedResource> {
    const id = xmlText(xml, 'ReplicationGroupId')!;
    const arn = xmlText(xml, 'ARN');
    const members = xmlAll(xmlText(xml, 'MemberClusters') ?? '', 'ClusterId');
    const primary = xmlText(xmlText(xml, 'NodeGroup') ?? '', 'PrimaryEndpoint') ?? '';
    const tags = await this.tagsOf(ctx, region, arn);
    const ev = await this.evictionOf(ctx, region, members[0] ?? null);
    const status = xmlText(xml, 'Status');
    return {
      type: 'cache',
      providerId: id,
      name: tags['exprsn:name'] ?? id,
      region,
      state: stateOf(status),
      tags: managed(tags),
      props: {
        service: 'elasticache',
        engine: xmlText(xml, 'Engine') ?? 'redis',
        size: xmlText(xml, 'CacheNodeType'),
        ha: members.length > 1,
        clusterMode: xmlText(xml, 'ClusterEnabled') === 'true' || (xmlText(xml, 'ClusterMode') ?? '').toLowerCase() === 'enabled',
        evictionPolicy: ev.policy,
        tls: xmlText(xml, 'TransitEncryptionEnabled') === 'true',
        authToken: xmlText(xml, 'AuthTokenEnabled') === 'true',
        publicAccess: false,
        host: xmlText(primary, 'Address'),
        port: Number(xmlText(primary, 'Port') ?? 6379),
        parameterGroup: ev.group,
        status
      },
      locator: { service: 'elasticache', ...(arn ? { arn } : {}) }
    };
  }

  private async describeGroup(ctx: CallContext, region: string, id: string): Promise<ObservedResource | null> {
    try {
      const r = await this.query(ctx, region, 'DescribeReplicationGroups', { ReplicationGroupId: id });
      const g = xmlAll(r.text, 'ReplicationGroup')[0];
      return g ? await this.observed(ctx, region, g) : null;
    } catch (err) {
      if (err instanceof CloudProviderError && err.status === 404) return null;
      throw err;
    }
  }

  private memoryObserved(c: Record<string, unknown>, region: string): ObservedResource {
    const ep = (c.ClusterEndpoint ?? {}) as { Address?: string; Port?: number };
    return {
      type: 'cache',
      providerId: String(c.Name),
      name: String(c.Name),
      region,
      state: stateOf(String(c.Status ?? '')),
      tags: {},
      props: { service: 'memorydb', engine: c.Engine ?? 'redis', size: c.NodeType ?? null, ha: Number(c.NumberOfShards ?? 1) > 0 && Array.isArray(c.Shards) && (c.Shards as { NumberOfNodes?: number }[]).some((s) => Number(s.NumberOfNodes ?? 1) > 1), clusterMode: true, evictionPolicy: null, tls: c.TLSEnabled !== false, publicAccess: false, host: ep.Address ?? null, port: Number(ep.Port ?? 6379), status: c.Status ?? null },
      locator: { service: 'memorydb', ...(c.ARN ? { arn: String(c.ARN) } : {}) }
    };
  }

  private async describeMemory(ctx: CallContext, region: string, name: string): Promise<ObservedResource | null> {
    try {
      const r = await this.memorydb<{ Clusters?: Record<string, unknown>[] }>(ctx, region, 'DescribeClusters', { ClusterName: name, ShowShardDetails: true });
      const c = r.Clusters?.[0];
      return c ? this.memoryObserved(c, region) : null;
    } catch (err) {
      if (err instanceof CloudProviderError && err.status === 404) return null;
      throw err;
    }
  }

  async find(ctx: CallContext, spec: ResourceSpec): Promise<ObservedResource | null> {
    const p = spec.props as CacheProps;
    const region = this.h.region(ctx, spec);
    if (p.service === 'memorydb') return this.describeMemory(ctx, region, this.names(ctx, spec).group);
    return this.describeGroup(ctx, region, this.names(ctx, spec).group);
  }

  async describe(ctx: CallContext, ref: ResourceRef): Promise<ObservedResource | null> {
    const region = ref.region ?? this.h.region(ctx);
    return ref.locator?.service === 'memorydb' ? this.describeMemory(ctx, region, ref.providerId) : this.describeGroup(ctx, region, ref.providerId);
  }

  async list(ctx: CallContext, filter: ListFilter): Promise<ObservedResource[]> {
    const region = this.h.region(ctx);
    const out: ObservedResource[] = [];
    let marker: string | null = null;
    for (let page = 0; page < 20; page++) {
      const r = await this.query(ctx, region, 'DescribeReplicationGroups', { MaxRecords: '100', ...(marker ? { Marker: marker } : {}) });
      for (const g of xmlAll(r.text, 'ReplicationGroup')) {
        const id = xmlText(g, 'ReplicationGroupId') ?? '';
        if (filter.managedOnly && !id.startsWith(cacheId(namePrefix(ctx.account.name)).replace(/-$/, ''))) continue;
        out.push(await this.observed(ctx, region, g));
      }
      marker = xmlText(r.text, 'Marker');
      if (!marker) break;
    }
    if (!filter.managedOnly) {
      const m = await this.memorydb<{ Clusters?: Record<string, unknown>[] }>(ctx, region, 'DescribeClusters', {}).catch(() => ({ Clusters: [] }));
      for (const c of m.Clusters ?? []) out.push(this.memoryObserved(c, region));
    }
    return filter.managedOnly ? out.filter((o) => o.tags['exprsn:managed'] === 'true' && o.tags['exprsn:account'] === ctx.account.name) : out;
  }

  // ---------- changes ----------

  private family(p: CacheProps): string {
    const engine = p.engine === 'valkey' ? 'valkey' : 'redis';
    const major = (p.version ?? (engine === 'valkey' ? '8' : '7')).split('.')[0];
    return `${engine}${major}`;
  }

  /** The account's parameter group for the engine family, with `maxmemory-policy noeviction` (made once, put back if changed). */
  private async ensureParams(ctx: CallContext, region: string, spec: ResourceSpec): Promise<string> {
    const p = spec.props as CacheProps;
    const family = this.family(p);
    const name = this.names(ctx, spec, family).params;
    try {
      await this.query(ctx, region, 'CreateCacheParameterGroup', { CacheParameterGroupName: name, CacheParameterGroupFamily: family, Description: `Exprsn-AI: ${family} with maxmemory-policy noeviction (BullMQ and the bus)` });
    } catch (err) {
      if (!(err instanceof CloudProviderError && /AlreadyExists/.test(err.code ?? ''))) throw err;
    }
    await this.query(ctx, region, 'ModifyCacheParameterGroup', { CacheParameterGroupName: name, 'ParameterNameValues.ParameterNameValue.1.ParameterName': 'maxmemory-policy', 'ParameterNameValues.ParameterNameValue.1.ParameterValue': p.evictionPolicy ?? REQUIRED_EVICTION_POLICY });
    return name;
  }

  private async ensureSubnets(ctx: CallContext, region: string, spec: ResourceSpec): Promise<string> {
    const p = spec.props as CacheProps;
    const ids = (p.subnets ?? []).map((k) => spec.parent?.refs?.[k] ?? k);
    if (!ids.length) throw new CloudProviderError('An ElastiCache replication group needs the data subnets.', 'aws', 400, 'parent_required');
    const name = this.names(ctx, spec).subnets;
    const params: Record<string, string> = { CacheSubnetGroupName: name, CacheSubnetGroupDescription: `Exprsn-AI ${spec.name}` };
    ids.forEach((id, i) => (params[`SubnetIds.SubnetIdentifier.${i + 1}`] = id));
    try {
      await this.query(ctx, region, 'CreateCacheSubnetGroup', params);
    } catch (err) {
      if (!(err instanceof CloudProviderError && /AlreadyExists/.test(err.code ?? ''))) throw err;
      await this.query(ctx, region, 'ModifyCacheSubnetGroup', params);
    }
    return name;
  }

  private refuseIncompatible(p: CacheProps): void {
    const problems = cacheCompatibility({ clusterMode: p.clusterMode ?? false, evictionPolicy: p.evictionPolicy ?? REQUIRED_EVICTION_POLICY, tls: p.tls ?? true, service: p.service ?? 'elasticache', publicAccess: p.publicAccess ?? false });
    if (problems.length) throw new CloudProviderError(`Refused as REDIS_URL: ${problems.map((x) => x.reason).join(' ')}`, 'aws', 409, 'cache_incompatible');
  }

  async create(ctx: CallContext, spec: ResourceSpec, handle: (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string) => OperationHandle): Promise<OperationResult> {
    const p = spec.props as CacheProps;
    this.refuseIncompatible(p);
    const region = this.h.region(ctx, spec);
    const existing = await this.find(ctx, spec);
    if (existing) return existing.state === 'ready' ? { done: true, resource: existing, adopted: true } : { done: false, operation: handle('create', existing, 'describe', existing.providerId), resource: existing, adopted: true };
    if (!ctx.secrets) throw new CloudProviderError('An ElastiCache AUTH token comes from the deployment’s secret broker, and this call has none.', 'aws', 400, 'secrets_unavailable');
    const deployment = spec.tags['exprsn:deployment'] ?? spec.name;
    const token = await ctx.secrets.value({ name: 'cache_auth_token', env: 'REDIS_URL', ref: `vault:cloud/${deployment}#cache_auth_token` });
    const paramGroup = await this.ensureParams(ctx, region, spec);
    const subnetGroup = await this.ensureSubnets(ctx, region, spec);
    const id = this.names(ctx, spec).group;
    const params: Record<string, string> = {
      ReplicationGroupId: id,
      ReplicationGroupDescription: `Exprsn-AI ${spec.name}`,
      Engine: p.engine === 'valkey' ? 'valkey' : 'redis',
      ...(p.version ? { EngineVersion: p.version } : {}),
      CacheNodeType: p.size,
      NumCacheClusters: p.ha ? '2' : '1',
      AutomaticFailoverEnabled: p.ha ? 'true' : 'false',
      MultiAZEnabled: p.ha ? 'true' : 'false',
      ClusterMode: 'disabled',
      CacheParameterGroupName: paramGroup,
      CacheSubnetGroupName: subnetGroup,
      TransitEncryptionEnabled: 'true',
      AtRestEncryptionEnabled: 'true',
      AuthToken: token
    };
    if (p.firewall) params['SecurityGroupIds.SecurityGroupId.1'] = spec.parent?.refs?.[p.firewall] ?? p.firewall;
    Object.entries({ ...spec.tags, 'exprsn:name': spec.name }).forEach(([k, v], i) => {
      params[`Tags.Tag.${i + 1}.Key`] = k;
      params[`Tags.Tag.${i + 1}.Value`] = v;
    });
    const r = await this.query(ctx, region, 'CreateReplicationGroup', params);
    const ref: ResourceRef = { type: 'cache', providerId: id, region, locator: { service: 'elasticache' } };
    return { done: false, operation: handle('create', ref, 'describe', id), ...(r.requestId ? { requestId: r.requestId } : {}) };
  }

  async update(ctx: CallContext, ref: ResourceRef, spec: ResourceSpec, handle: (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string) => OperationHandle): Promise<OperationResult> {
    const p = spec.props as CacheProps;
    this.refuseIncompatible(p);
    if (ref.locator?.service === 'memorydb') throw new CloudProviderError('A MemoryDB cluster is not changed by Exprsn-AI.', 'aws', 409, 'cache_incompatible');
    const region = ref.region ?? this.h.region(ctx, spec);
    const current = await this.describeGroup(ctx, region, ref.providerId);
    if (!current) throw new CloudProviderError(`${ref.providerId} no longer exists.`, 'aws', 404, 'not_found');
    const paramGroup = await this.ensureParams(ctx, region, spec);
    const params: Record<string, string> = { ReplicationGroupId: ref.providerId, ApplyImmediately: 'true', CacheParameterGroupName: paramGroup };
    if (current.props.size !== p.size) params.CacheNodeType = p.size;
    const r = await this.query(ctx, region, 'ModifyReplicationGroup', params);
    return { done: false, operation: handle('update', ref, 'describe', ref.providerId), ...(r.requestId ? { requestId: r.requestId } : {}) };
  }

  async delete(ctx: CallContext, ref: ResourceRef, handle: (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string) => OperationHandle): Promise<OperationResult> {
    if (ref.locator?.service === 'memorydb') throw new CloudProviderError('A MemoryDB cluster is not deleted by Exprsn-AI (it never made one).', 'aws', 409, 'cache_incompatible');
    const region = ref.region ?? this.h.region(ctx);
    try {
      const r = await this.query(ctx, region, 'DeleteReplicationGroup', { ReplicationGroupId: ref.providerId, RetainPrimaryCluster: 'false' });
      return { done: false, operation: handle('delete', ref, 'describe', ref.providerId), ...(r.requestId ? { requestId: r.requestId } : {}) };
    } catch (err) {
      if (err instanceof CloudProviderError && err.status === 404) return { done: true, resource: null };
      throw err;
    }
  }

  async poll(ctx: CallContext, h: OperationHandle): Promise<PollResult> {
    const o = await this.describe(ctx, h.ref);
    if (h.op === 'delete') return o ? { state: 'pending', waitMs: 5000 } : { state: 'succeeded', resource: null };
    if (!o) return { state: 'failed', error: `${h.ref.providerId} disappeared while it was being ${h.op === 'create' ? 'created' : 'changed'}.`, code: 'not_found' };
    if (o.state === 'failed') return { state: 'failed', error: `${h.ref.providerId} failed (${String(o.props.status ?? 'create-failed')}).` };
    return o.state === 'ready' ? { state: 'succeeded', resource: o } : { state: 'pending', waitMs: 5000 };
  }

  /** The primary endpoint; the AUTH token is Exprsn-AI's own (in the vault), so none is returned. */
  async access(ctx: CallContext, ref: ResourceRef): Promise<CacheAccess> {
    const o = await this.describe(ctx, ref);
    if (!o || !o.props.host) throw new CloudProviderError(`${ref.providerId} has no endpoint yet.`, 'aws', 409, 'cache_not_ready');
    return { host: String(o.props.host), port: Number(o.props.port ?? 6379), username: null, token: null };
  }
}
