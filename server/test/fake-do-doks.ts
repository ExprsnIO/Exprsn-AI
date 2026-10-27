/*
 * 1.9.99-final, Sprint 58 (B-10203): DOKS for `fake-do.ts`: `/v2/kubernetes/clusters` (provisioning until
 * `settleAfter` reads, then running, with the fake Kubernetes API as its endpoint), node pools with their nodes,
 * `destroy_with_associated_resources/dangerous`, and the credentials endpoint, whose tokens end after
 * `expiry_seconds`; `acceptsToken` is what a cluster's API asks. It is never the real DigitalOcean.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { RecordedRequest, Reply } from './fake-cloud-base.js';

interface Pool { id: string; name: string; size: string; count: number; auto_scale: boolean; min_nodes: number; max_nodes: number; tags: string[]; labels: Record<string, string>; taints: { key: string; value?: string; effect: string }[]; reads: number }
interface Cluster { id: string; name: string; region: string; version: string; vpc_uuid: string; ha: boolean; tags: string[]; state: string; reads: number; pools: Map<string, Pool>; endpoint: string; deletedWith?: boolean }

export class FakeDoks {
  readonly clusters = new Map<string, Cluster>();
  /** Credentials handed out: token → its cluster and expiry. */
  readonly tokens = new Map<string, { clusterId: string; expiresAt: number }>();
  kubeServer = 'https://doks.example.test';

  constructor(private readonly settleAfter: () => number) {}

  private nf(): Reply {
    return { status: 404, body: { id: 'not_found', message: 'The resource you were accessing could not be found.' } };
  }

  private poolView(c: Cluster, p: Pool) {
    const { reads: _r, ...rest } = p;
    const running = c.state === 'running' && p.reads > this.settleAfter();
    return { ...rest, nodes: Array.from({ length: p.count }, (_, i) => ({ id: `${p.id}-${i}`, name: `${p.name}-${i}`, status: { state: running ? 'running' : 'provisioning' } })) };
  }

  private view(c: Cluster) {
    return { id: c.id, name: c.name, region: c.region, version: c.version, vpc_uuid: c.vpc_uuid, ha: c.ha, tags: [...c.tags, 'k8s', `k8s:${c.id}`], status: { state: c.state }, endpoint: c.state === 'provisioning' ? '' : c.endpoint, node_pools: [...c.pools.values()].map((p) => this.poolView(c, p)) };
  }

  private pool(b: Record<string, unknown>): Pool {
    return { id: randomUUID(), name: String(b.name), size: String(b.size), count: Number(b.count ?? 1), auto_scale: !!b.auto_scale, min_nodes: Number(b.min_nodes ?? 0), max_nodes: Number(b.max_nodes ?? 0), tags: (b.tags as string[]) ?? [], labels: (b.labels as Record<string, string>) ?? {}, taints: (b.taints as Pool['taints']) ?? [], reads: 0 };
  }

  route(r: RecordedRequest, seg: string[], b: Record<string, unknown>, page: (key: string, items: unknown[]) => Reply): Reply {
    // seg: ['kubernetes', 'clusters', id?, ...]
    if (seg[1] !== 'clusters') return this.nf();
    const id = seg[2];
    if (!id) {
      if (r.method === 'GET') return page('kubernetes_clusters', [...this.clusters.values()].map((c) => this.view(c)));
      if (!b.name || !b.region || !(b.node_pools as unknown[])?.length) return { status: 422, body: { id: 'unprocessable_entity', message: 'name, region and at least one node pool are required' } };
      if ([...this.clusters.values()].some((c) => c.name === b.name)) return { status: 422, body: { id: 'unprocessable_entity', message: `a cluster with the name ${String(b.name)} already exists` } };
      const c: Cluster = { id: randomUUID(), name: String(b.name), region: String(b.region), version: String(b.version === 'latest' ? '1.31.1-do.0' : b.version), vpc_uuid: String(b.vpc_uuid ?? ''), ha: !!b.ha, tags: (b.tags as string[]) ?? [], state: 'provisioning', reads: 0, pools: new Map(), endpoint: this.kubeServer };
      for (const p of b.node_pools as Record<string, unknown>[]) {
        const pool = this.pool(p);
        c.pools.set(pool.id, pool);
      }
      this.clusters.set(c.id, c);
      return { status: 201, body: { kubernetes_cluster: this.view(c) } };
    }
    const c = this.clusters.get(id);
    if (!c) return this.nf();
    if (seg[3] === 'destroy_with_associated_resources' && seg[4] === 'dangerous' && r.method === 'DELETE') {
      c.state = 'deleting';
      c.reads = 0;
      c.deletedWith = true;
      return { status: 204 };
    }
    if (seg[3] === 'credentials' && r.method === 'GET') {
      const seconds = Math.min(Number(r.query.get('expiry_seconds') ?? 604800), 604800);
      const token = `doks-${randomBytes(24).toString('hex')}`;
      const expiresAt = Date.now() + seconds * 1000;
      this.tokens.set(token, { clusterId: c.id, expiresAt });
      return { status: 200, body: { server: c.endpoint, certificate_authority_data: Buffer.from('-----BEGIN CERTIFICATE-----\nfake-doks\n-----END CERTIFICATE-----\n').toString('base64'), client_certificate_data: null, client_key_data: null, token, expires_at: new Date(expiresAt).toISOString() } };
    }
    if (seg[3] === 'node_pools') {
      const pid = seg[4];
      if (!pid) {
        if (r.method === 'GET') return page('node_pools', [...c.pools.values()].map((p) => this.poolView(c, p)));
        if ([...c.pools.values()].some((p) => p.name === b.name)) return { status: 422, body: { id: 'unprocessable_entity', message: 'node pool name already in use' } };
        const p = this.pool(b);
        c.pools.set(p.id, p);
        return { status: 201, body: { node_pool: this.poolView(c, p) } };
      }
      const p = c.pools.get(pid);
      if (!p) return this.nf();
      if (r.method === 'GET') {
        p.reads += 1;
        return { status: 200, body: { node_pool: this.poolView(c, p) } };
      }
      if (r.method === 'PUT') {
        Object.assign(p, { name: String(b.name ?? p.name), count: Number(b.count ?? p.count), auto_scale: !!b.auto_scale, min_nodes: Number(b.min_nodes ?? 0), max_nodes: Number(b.max_nodes ?? 0), tags: (b.tags as string[]) ?? p.tags, labels: (b.labels as Record<string, string>) ?? p.labels, taints: (b.taints as Pool['taints']) ?? p.taints });
        return { status: 202, body: { node_pool: this.poolView(c, p) } };
      }
      if (r.method === 'DELETE') {
        c.pools.delete(pid);
        return { status: 204 };
      }
    }
    if (r.method === 'GET') {
      c.reads += 1;
      if (c.state === 'provisioning' && c.reads > this.settleAfter()) c.state = 'running';
      if (c.state === 'deleting' && c.reads > this.settleAfter()) {
        this.clusters.delete(id);
        return this.nf();
      }
      for (const p of c.pools.values()) if (c.state === 'running') p.reads += 1;
      return { status: 200, body: { kubernetes_cluster: this.view(c) } };
    }
    if (r.method === 'PUT') {
      Object.assign(c, { name: String(b.name ?? c.name), tags: (b.tags as string[]) ?? c.tags, ...(b.ha ? { ha: true } : {}) });
      return { status: 202, body: { kubernetes_cluster: this.view(c) } };
    }
    return { status: 405, body: { id: 'method_not_allowed', message: 'Not allowed' } };
  }

  acceptsToken(token: string): boolean {
    const t = this.tokens.get(token);
    return !!t && t.expiresAt > Date.now() && this.clusters.has(t.clusterId);
  }
}
