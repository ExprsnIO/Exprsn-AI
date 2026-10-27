/*
 * 1.9.99-final, Sprint 58 (B-10203): EKS for `fake-aws.ts` (REST JSON, routed by the SigV4 scope `eks`): clusters
 * (CREATING until `settleAfter` describes, then ACTIVE, with the fake Kubernetes API as their endpoint), node groups,
 * update-config, tags, deletes (DELETING, then gone) and the client request token. `verifyToken` checks a kubeconfig
 * token as the EKS authenticator would: `k8s-aws-v1.` + a presigned STS `GetCallerIdentity` URL, signed for no more
 * than 60 s, with `x-k8s-aws-id` among its signed headers, at most 15 minutes old, by a key the fake knows (and its
 * session token). It is never the real EKS.
 */
import type { RecordedRequest, Reply } from './fake-cloud-base.js';

interface Cluster { name: string; arn: string; status: string; version: string; endpoint: string; certificateAuthority: { data: string }; resourcesVpcConfig: Record<string, unknown>; tags: Record<string, string>; roleArn: string; describes: number; clientRequestToken?: string; accessConfig?: unknown }
interface Nodegroup { nodegroupName: string; nodegroupArn: string; clusterName: string; status: string; instanceTypes: string[]; scalingConfig: { minSize: number; maxSize: number; desiredSize: number }; labels: Record<string, string>; taints: { key: string; value?: string; effect: string }[]; tags: Record<string, string>; subnets: string[]; nodeRole: string; amiType: string; describes: number; launchTemplate?: { id?: string; name?: string; version?: string } }

export class FakeEks {
  readonly clusters = new Map<string, Cluster>();
  readonly nodegroups = new Map<string, Nodegroup>();
  /** Clusters' API endpoint (the fake Kubernetes API). */
  kubeServer = 'https://kube.example.test';
  settleAfter = 1;

  constructor(private readonly account: () => string) {}

  private err(status: number, type: string, message: string): Reply {
    return { status, headers: { 'x-amzn-errortype': type }, body: { __type: type, message } };
  }

  handle(r: RecordedRequest): Reply {
    const seg = r.path.replace(/^\//, '').split('/').map(decodeURIComponent);
    const b = (() => {
      try {
        return r.body ? (JSON.parse(r.body) as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    })();
    if (seg[0] === 'tags') {
      const arn = seg.slice(1).join('/');
      const target = [...this.clusters.values()].find((c) => c.arn === arn) ?? [...this.nodegroups.values()].find((g) => g.nodegroupArn === arn);
      if (!target) return this.err(404, 'ResourceNotFoundException', 'No resource found');
      Object.assign(target.tags, (b.tags as Record<string, string>) ?? {});
      return { status: 200, body: {} };
    }
    if (seg[0] !== 'clusters') return this.err(404, 'ResourceNotFoundException', 'Not found');
    const name = seg[1];
    if (!name) {
      if (r.method === 'GET') return { status: 200, body: { clusters: [...this.clusters.keys()] } };
      const n = String(b.name ?? '');
      const existing = this.clusters.get(n);
      if (existing) return existing.clientRequestToken === b.clientRequestToken ? { status: 200, body: { cluster: this.view(existing) } } : this.err(409, 'ResourceInUseException', `Cluster already exists with name: ${n}`);
      const c: Cluster = { name: n, arn: `arn:aws:eks:eu-central-1:${this.account()}:cluster/${n}`, status: 'CREATING', version: String(b.version ?? '1.31'), endpoint: this.kubeServer, certificateAuthority: { data: Buffer.from('-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n').toString('base64') }, resourcesVpcConfig: { ...((b.resourcesVpcConfig as object) ?? {}), vpcId: 'vpc-fake' }, tags: (b.tags as Record<string, string>) ?? {}, roleArn: String(b.roleArn ?? ''), describes: 0, ...(b.clientRequestToken ? { clientRequestToken: String(b.clientRequestToken) } : {}), accessConfig: b.accessConfig };
      this.clusters.set(n, c);
      return { status: 200, body: { cluster: this.view(c) } };
    }
    const c = this.clusters.get(name);
    if (!c) return this.err(404, 'ResourceNotFoundException', `No cluster found for name: ${name}.`);
    if (seg[2] !== 'node-groups') {
      if (r.method === 'GET') {
        c.describes += 1;
        if (c.status === 'CREATING' && c.describes > this.settleAfter) c.status = 'ACTIVE';
        if (c.status === 'DELETING' && c.describes > this.settleAfter) {
          this.clusters.delete(name);
          return this.err(404, 'ResourceNotFoundException', `No cluster found for name: ${name}.`);
        }
        return { status: 200, body: { cluster: this.view(c) } };
      }
      if (r.method === 'DELETE') {
        if ([...this.nodegroups.values()].some((g) => g.clusterName === name)) return this.err(409, 'ResourceInUseException', 'Cluster has nodegroups attached');
        c.status = 'DELETING';
        c.describes = 0;
        return { status: 200, body: { cluster: this.view(c) } };
      }
    }
    const ng = seg[3];
    if (!ng) {
      if (r.method === 'GET') return { status: 200, body: { nodegroups: [...this.nodegroups.values()].filter((g) => g.clusterName === name).map((g) => g.nodegroupName) } };
      const n = String(b.nodegroupName ?? '');
      const key = `${name}/${n}`;
      if (this.nodegroups.has(key)) return this.err(409, 'ResourceInUseException', `NodeGroup already exists with name ${n} and cluster name ${name}`);
      if (!b.nodeRole || !(b.subnets as unknown[])?.length) return this.err(400, 'InvalidParameterException', 'nodeRole and subnets are required');
      const g: Nodegroup = { nodegroupName: n, nodegroupArn: `arn:aws:eks:eu-central-1:${this.account()}:nodegroup/${name}/${n}/fake`, clusterName: name, status: 'CREATING', instanceTypes: (b.instanceTypes as string[]) ?? [], scalingConfig: b.scalingConfig as Nodegroup['scalingConfig'], labels: (b.labels as Record<string, string>) ?? {}, taints: (b.taints as Nodegroup['taints']) ?? [], tags: (b.tags as Record<string, string>) ?? {}, subnets: (b.subnets as string[]) ?? [], nodeRole: String(b.nodeRole), amiType: String(b.amiType ?? ''), describes: 0, ...(b.launchTemplate ? { launchTemplate: b.launchTemplate as Nodegroup['launchTemplate'] } : {}) };
      this.nodegroups.set(key, g);
      return { status: 200, body: { nodegroup: this.ngView(g) } };
    }
    const g = this.nodegroups.get(`${name}/${ng}`);
    if (!g) return this.err(404, 'ResourceNotFoundException', `No node group found for name: ${ng}.`);
    if (seg[4] === 'update-config' && r.method === 'POST') {
      if (b.scalingConfig) g.scalingConfig = b.scalingConfig as Nodegroup['scalingConfig'];
      const labels = (b.labels as { addOrUpdateLabels?: Record<string, string> } | undefined)?.addOrUpdateLabels;
      if (labels) Object.assign(g.labels, labels);
      const t = b.taints as { addOrUpdateTaints?: Nodegroup['taints']; removeTaints?: Nodegroup['taints'] } | undefined;
      if (t) {
        const k = (x: { key: string; effect: string }) => `${x.key}:${x.effect}`;
        g.taints = [...g.taints.filter((x) => !(t.removeTaints ?? []).some((y) => k(y) === k(x)) && !(t.addOrUpdateTaints ?? []).some((y) => k(y) === k(x))), ...(t.addOrUpdateTaints ?? [])];
      }
      return { status: 200, body: { update: { id: 'upd-1', status: 'Successful', type: 'ConfigUpdate' } } };
    }
    if (r.method === 'GET') {
      g.describes += 1;
      if (g.status === 'CREATING' && g.describes > this.settleAfter) g.status = 'ACTIVE';
      if (g.status === 'DELETING' && g.describes > this.settleAfter) {
        this.nodegroups.delete(`${name}/${ng}`);
        return this.err(404, 'ResourceNotFoundException', `No node group found for name: ${ng}.`);
      }
      return { status: 200, body: { nodegroup: this.ngView(g) } };
    }
    if (r.method === 'DELETE') {
      g.status = 'DELETING';
      g.describes = 0;
      return { status: 200, body: { nodegroup: this.ngView(g) } };
    }
    return this.err(400, 'InvalidRequestException', `${r.method} ${r.path} is not something this fake answers`);
  }

  private view(c: Cluster): Record<string, unknown> {
    const { describes: _d, clientRequestToken: _t, ...rest } = c;
    return { ...rest, endpoint: c.status === 'CREATING' ? undefined : c.endpoint };
  }

  private ngView(g: Nodegroup): Record<string, unknown> {
    const { describes: _d, ...rest } = g;
    return rest;
  }

  /**
   * Checks a kubeconfig token as the EKS authenticator does (without the signature: the fake knows the key and its
   * session token, and the presign's shape and age are what matter here). Null when accepted, else why not.
   */
  verifyToken(token: string, keys: Map<string, { secretAccessKey: string; sessionToken?: string; status: string; expiresAt?: number }>, clusterName?: string): string | null {
    if (!token.startsWith('k8s-aws-v1.')) return 'not an EKS token';
    let u: URL;
    try {
      u = new URL(Buffer.from(token.slice('k8s-aws-v1.'.length), 'base64url').toString('utf8'));
    } catch {
      return 'not a URL';
    }
    const q = u.searchParams;
    if (q.get('Action') !== 'GetCallerIdentity' || q.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256') return 'not a presigned GetCallerIdentity';
    if (Number(q.get('X-Amz-Expires')) > 60) return 'signed for too long';
    if (!(q.get('X-Amz-SignedHeaders') ?? '').split(';').includes('x-k8s-aws-id')) return 'x-k8s-aws-id is not signed';
    if (!q.get('X-Amz-Signature')) return 'unsigned';
    const date = q.get('X-Amz-Date') ?? '';
    const at = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`);
    if (!Number.isFinite(at) || Date.now() - at > 15 * 60_000) return 'expired';
    const keyId = (q.get('X-Amz-Credential') ?? '').split('/')[0] ?? '';
    const key = keys.get(keyId);
    if (!key || key.status !== 'Active' || (key.expiresAt && key.expiresAt < Date.now())) return 'unknown key';
    if (key.sessionToken && q.get('X-Amz-Security-Token') !== key.sessionToken) return 'wrong session token';
    if (clusterName && !this.clusters.has(clusterName)) return 'no such cluster';
    return null;
  }
}
