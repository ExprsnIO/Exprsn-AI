import type { CloudAccount } from '../types.js';
import { clusterLoadBalancer, KUBE_TOKEN_SECONDS, nodeLabels, parseTaint, taintText } from './kubernetes.js';
import {
  CloudProviderError,
  type AdapterCredential,
  type CallContext,
  type ClusterAccess,
  type ListFilter,
  type ObservedResource,
  type OperationHandle,
  type OperationResult,
  type PollResult,
  type ResourceRef,
  type ResourceSpec
} from './types.js';

/*
 * 1.9.99-final, Sprint 58 (B-10203): DOKS through the DigitalOcean adapter (`digitalocean.ts` hands the Kubernetes
 * types here, with its own call path, so every request goes through the transport and the rate limiter).
 *
 * - Clusters: `POST /v2/kubernetes/clusters` in the app VPC with the app node pool (DOKS needs one at create; the
 *   graph's app `node_group` step then adopts it by name), tagged like droplets; followed by describing it until it is
 *   `running`. Deleting uses `destroy_with_associated_resources/dangerous`, so the load balancers and volumes the
 *   cluster made from the release go with it and nothing is left billed.
 * - Node pools: `/v2/kubernetes/clusters/<id>/node_pools`, found by name; ready when every node is running. Their
 *   provider id is `<cluster id>/<pool id>`.
 * - Access: `GET /v2/kubernetes/clusters/<id>/credentials?expiry_seconds=<n>`, a token that ends on its own.
 */

interface DoCluster { id: string; name: string; region: string; version?: string; endpoint?: string; ha?: boolean; vpc_uuid?: string; status?: { state?: string; message?: string }; node_pools?: DoPool[]; tags?: string[] }
interface DoPool { id: string; name: string; size: string; count: number; auto_scale?: boolean; min_nodes?: number; max_nodes?: number; tags?: string[]; labels?: Record<string, string> | null; taints?: { key: string; value?: string; effect: string }[]; nodes?: { id: string; status?: { state?: string } }[] }

export interface DoCallPath {
  call<T>(cred: AdapterCredential, account: CloudAccount, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<{ status: number; body: T; headers: Record<string, string>; requestId: string | null }>;
  all<T>(ctx: CallContext, path: string, key: string): Promise<T[]>;
  doName(ctx: CallContext, name: string): string;
  region(ctx: CallContext, spec?: ResourceSpec): string;
  tagStrings(tags: Record<string, string>): string[];
}

const clusterState = (s: string | undefined): ObservedResource['state'] => (s === 'running' || s === 'degraded' ? 'ready' : s === 'provisioning' || s === 'invalid' ? 'creating' : s === 'error' ? 'failed' : s === 'deleting' || s === 'deleted' ? 'deleting' : 'creating');

function clusterObserved(c: DoCluster, name?: string): ObservedResource {
  const tag = (c.tags ?? []).find((t) => t.startsWith('exprsn:name:'));
  const tags: Record<string, string> = {};
  for (const t of c.tags ?? []) {
    const m = /^(exprsn:[a-z]+):(.*)$/.exec(t);
    if (m && m[1] !== 'exprsn:name') tags[m[1]!] = m[2]!;
  }
  return { type: 'kubernetes_cluster', providerId: c.id, name: name ?? tag?.slice('exprsn:name:'.length) ?? c.name, region: c.region, state: clusterState(c.status?.state), tags, props: { ha: !!c.ha, version: c.version ?? null, endpoint: c.endpoint ?? null, status: c.status?.state ?? null, networkId: c.vpc_uuid ?? null } };
}

function poolObserved(clusterId: string, p: DoPool, name?: string): ObservedResource {
  const nodes = p.nodes ?? [];
  const ready = nodes.length >= Math.min(p.count, 1) && nodes.every((n) => n.status?.state === 'running');
  const labels = p.labels ?? {};
  return {
    type: 'node_group',
    providerId: `${clusterId}/${p.id}`,
    name: name ?? labels['exprsn.ai/node-group'] ?? p.name,
    state: ready ? 'ready' : 'creating',
    tags: {},
    props: { size: p.size, count: p.count, ...(p.auto_scale ? { min: p.min_nodes ?? 0, max: p.max_nodes ?? p.count } : { min: p.count, max: p.count }), role: labels['exprsn.ai/role'] ?? null, taints: (p.taints ?? []).map(taintText) },
    locator: { clusterId }
  };
}

const splitPool = (id: string): [string, string] => {
  const i = id.indexOf('/');
  if (i < 0) throw new CloudProviderError(`${id} is not a DOKS node pool id (<cluster>/<pool>).`, 'digitalocean', 400, 'bad_id');
  return [id.slice(0, i), id.slice(i + 1)];
};

export class DoksResources {
  constructor(private readonly p: DoCallPath) {}

  private handle(op: OperationHandle['op'], ref: ResourceRef): OperationHandle {
    return { provider: 'digitalocean', type: ref.type, op, kind: 'describe', ref: { type: ref.type, providerId: ref.providerId }, token: ref.providerId, startedAt: Date.now() };
  }

  private poolBody(ctx: CallContext, spec: ResourceSpec<'node_group'> | { name: string; props: { size: string; count?: number; min?: number; max?: number; role?: string; taints?: string[]; gpu?: string; poolName?: string }; tags: Record<string, string> }) {
    const p = spec.props;
    const count = p.count ?? p.min ?? 1;
    const min = p.min ?? count;
    const max = p.max ?? count;
    return {
      name: this.p.doName(ctx, spec.name),
      size: p.size,
      count: Math.max(count, min),
      tags: [...this.p.tagStrings(spec.tags), `exprsn:name:${spec.name}`],
      labels: nodeLabels(spec as ResourceSpec<'node_group'>),
      taints: (p.taints ?? []).map(parseTaint),
      ...(max > min ? { auto_scale: true, min_nodes: min, max_nodes: max } : { auto_scale: false })
    };
  }

  private clusterId(spec: ResourceSpec): string {
    const id = spec.parent?.refs?.cluster;
    if (!id) throw new CloudProviderError('A node pool needs its cluster (parent.refs.cluster).', 'digitalocean', 400, 'parent_required');
    return id;
  }

  async find(ctx: CallContext, spec: ResourceSpec): Promise<ObservedResource | null> {
    if (spec.type === 'load_balancer') return clusterLoadBalancer.find('digitalocean', spec);
    const name = this.p.doName(ctx, spec.name);
    if (spec.type === 'kubernetes_cluster') {
      const c = (await this.p.all<DoCluster>(ctx, '/v2/kubernetes/clusters', 'kubernetes_clusters')).find((x) => x.name === name);
      return c ? clusterObserved(c, spec.name) : null;
    }
    const cid = spec.parent?.refs?.cluster;
    if (!cid) return null;
    try {
      const pools = await this.p.all<DoPool>(ctx, `/v2/kubernetes/clusters/${encodeURIComponent(cid)}/node_pools`, 'node_pools');
      const pool = pools.find((x) => x.name === name);
      return pool ? poolObserved(cid, pool, spec.name) : null;
    } catch (err) {
      if (err instanceof CloudProviderError && err.status === 404) return null;
      throw err;
    }
  }

  async describe(ctx: CallContext, ref: ResourceRef): Promise<ObservedResource | null> {
    if (ref.type === 'load_balancer') return clusterLoadBalancer.describe(ref);
    try {
      if (ref.type === 'kubernetes_cluster') return clusterObserved((await this.p.call<{ kubernetes_cluster: DoCluster }>(ctx.cred, ctx.account, 'GET', `/v2/kubernetes/clusters/${encodeURIComponent(ref.providerId)}`, undefined, ctx.signal)).body.kubernetes_cluster);
      const [cid, pid] = splitPool(ref.providerId);
      return poolObserved(cid, (await this.p.call<{ node_pool: DoPool }>(ctx.cred, ctx.account, 'GET', `/v2/kubernetes/clusters/${encodeURIComponent(cid)}/node_pools/${encodeURIComponent(pid)}`, undefined, ctx.signal)).body.node_pool);
    } catch (err) {
      if (err instanceof CloudProviderError && err.status === 404) return null;
      throw err;
    }
  }

  async list(ctx: CallContext, type: 'kubernetes_cluster' | 'node_group' | 'load_balancer', filter: ListFilter = {}): Promise<ObservedResource[]> {
    if (type === 'load_balancer') return [];
    const clusters = await this.p.all<DoCluster>(ctx, filter.managedOnly ? `/v2/kubernetes/clusters` : '/v2/kubernetes/clusters', 'kubernetes_clusters');
    const mine = clusters.filter((c) => !filter.managedOnly || (c.tags ?? []).includes(`exprsn:account:${ctx.account.name}`)).filter((c) => !filter.networkId || c.vpc_uuid === filter.networkId);
    if (type === 'kubernetes_cluster') return mine.map((c) => clusterObserved(c));
    return mine.flatMap((c) => (c.node_pools ?? []).map((p) => poolObserved(c.id, p)));
  }

  async create(ctx: CallContext, spec: ResourceSpec): Promise<OperationResult> {
    if (spec.type === 'load_balancer') return clusterLoadBalancer.create('digitalocean', spec);
    const existing = await this.find(ctx, spec);
    // A node group the cluster was made with (AKS, DOKS) or an earlier attempt made: adopted, and brought to its spec at once.
    if (existing && spec.type === 'node_group') return { ...(await this.update(ctx, existing, spec)), adopted: true };
    if (existing) return existing.state === 'ready' ? { done: true, resource: existing, adopted: true } : { done: false, operation: this.handle('create', existing), resource: existing, adopted: true };
    if (spec.type === 'kubernetes_cluster') {
      const p = (spec as ResourceSpec<'kubernetes_cluster'>).props;
      const first = p.initialPool ?? { name: `${spec.name}-system`, size: 's-2vcpu-4gb', count: 1 };
      const pool = this.poolBody(ctx, { name: first.name, props: { size: first.size, count: first.count, role: p.initialPool ? 'app' : 'system' }, tags: spec.tags });
      const body = { name: this.p.doName(ctx, spec.name), region: this.p.region(ctx, spec), version: p.version ?? 'latest', ...(spec.parent?.networkId ? { vpc_uuid: spec.parent.networkId } : {}), tags: [...this.p.tagStrings(spec.tags), `exprsn:name:${spec.name}`], ha: !!p.ha, auto_upgrade: false, surge_upgrade: true, node_pools: [pool] };
      const r = await this.p.call<{ kubernetes_cluster: DoCluster }>(ctx.cred, ctx.account, 'POST', '/v2/kubernetes/clusters', body, ctx.signal);
      const o = clusterObserved(r.body.kubernetes_cluster, spec.name);
      return o.state === 'ready' ? { done: true, resource: o, ...(r.requestId ? { requestId: r.requestId } : {}) } : { done: false, operation: this.handle('create', o), resource: o, ...(r.requestId ? { requestId: r.requestId } : {}) };
    }
    const cid = this.clusterId(spec);
    const r = await this.p.call<{ node_pool: DoPool }>(ctx.cred, ctx.account, 'POST', `/v2/kubernetes/clusters/${encodeURIComponent(cid)}/node_pools`, this.poolBody(ctx, spec as ResourceSpec<'node_group'>), ctx.signal);
    const o = poolObserved(cid, r.body.node_pool, spec.name);
    return o.state === 'ready' ? { done: true, resource: o } : { done: false, operation: this.handle('create', o), resource: o, ...(r.requestId ? { requestId: r.requestId } : {}) };
  }

  async update(ctx: CallContext, ref: ResourceRef, spec: ResourceSpec): Promise<OperationResult> {
    if (ref.type === 'load_balancer') return clusterLoadBalancer.update('digitalocean', ref, spec);
    if (ref.type === 'kubernetes_cluster') {
      const p = (spec as ResourceSpec<'kubernetes_cluster'>).props;
      const r = await this.p.call<{ kubernetes_cluster: DoCluster }>(ctx.cred, ctx.account, 'PUT', `/v2/kubernetes/clusters/${encodeURIComponent(ref.providerId)}`, { name: this.p.doName(ctx, spec.name), tags: [...this.p.tagStrings(spec.tags), `exprsn:name:${spec.name}`], auto_upgrade: false, surge_upgrade: true, ...(p.ha ? { ha: true } : {}) }, ctx.signal);
      return { done: true, resource: clusterObserved(r.body.kubernetes_cluster, spec.name) };
    }
    const [cid, pid] = splitPool(ref.providerId);
    const r = await this.p.call<{ node_pool: DoPool }>(ctx.cred, ctx.account, 'PUT', `/v2/kubernetes/clusters/${encodeURIComponent(cid)}/node_pools/${encodeURIComponent(pid)}`, this.poolBody(ctx, spec as ResourceSpec<'node_group'>), ctx.signal);
    const o = poolObserved(cid, r.body.node_pool, spec.name);
    return o.state === 'ready' ? { done: true, resource: o } : { done: false, operation: this.handle('update', o), resource: o };
  }

  async delete(ctx: CallContext, ref: ResourceRef): Promise<OperationResult> {
    if (ref.type === 'load_balancer') return clusterLoadBalancer.delete();
    try {
      if (ref.type === 'kubernetes_cluster') {
        // With what the cluster made (the release's load balancer, its volumes): nothing stays billed.
        await this.p.call(ctx.cred, ctx.account, 'DELETE', `/v2/kubernetes/clusters/${encodeURIComponent(ref.providerId)}/destroy_with_associated_resources/dangerous`, undefined, ctx.signal);
      } else {
        const [cid, pid] = splitPool(ref.providerId);
        await this.p.call(ctx.cred, ctx.account, 'DELETE', `/v2/kubernetes/clusters/${encodeURIComponent(cid)}/node_pools/${encodeURIComponent(pid)}`, undefined, ctx.signal);
      }
    } catch (err) {
      if (err instanceof CloudProviderError && err.status === 404) return { done: true, resource: null };
      throw err;
    }
    return { done: false, operation: this.handle('delete', ref) };
  }

  async poll(ctx: CallContext, h: OperationHandle): Promise<PollResult> {
    const o = await this.describe(ctx, h.ref);
    if (h.op === 'delete') return o ? { state: 'pending', waitMs: 5000 } : { state: 'succeeded', resource: null };
    if (!o) return { state: 'failed', error: `${h.ref.providerId} disappeared.`, code: 'not_found' };
    if (o.state === 'failed') return { state: 'failed', error: `The ${h.ref.type === 'kubernetes_cluster' ? 'cluster' : 'node pool'} ${h.ref.providerId} is in error.`, code: 'cluster_error' };
    return o.state === 'ready' ? { state: 'succeeded', resource: o } : { state: 'pending', waitMs: 5000 };
  }

  /** Short-lived credentials for the cluster's API from the credentials endpoint. */
  async access(ctx: CallContext, ref: ResourceRef, o: { seconds?: number } = {}): Promise<ClusterAccess> {
    const seconds = Math.max(60, Math.min(o.seconds ?? KUBE_TOKEN_SECONDS, 3600));
    const c = (await this.p.call<{ kubernetes_cluster: DoCluster }>(ctx.cred, ctx.account, 'GET', `/v2/kubernetes/clusters/${encodeURIComponent(ref.providerId)}`, undefined, ctx.signal)).body.kubernetes_cluster;
    const r = await this.p.call<{ server: string; certificate_authority_data?: string; token?: string; expires_at?: string }>(ctx.cred, ctx.account, 'GET', `/v2/kubernetes/clusters/${encodeURIComponent(ref.providerId)}/credentials?expiry_seconds=${seconds}`, undefined, ctx.signal);
    if (!r.body.token) throw new CloudProviderError('DigitalOcean gave no token for the cluster (a client certificate is not used here).', 'digitalocean', 502, 'no_token');
    const expiresAt = r.body.expires_at ? Date.parse(r.body.expires_at) : Date.now() + seconds * 1000;
    return { server: r.body.server, caData: r.body.certificate_authority_data ?? null, token: r.body.token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + seconds * 1000, clusterName: c.name };
  }
}
