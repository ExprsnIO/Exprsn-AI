/*
 * 1.9.99-final, Sprint 58 (B-10203, B-10207): a stand-in for a managed cluster's Kubernetes API and for the `helm`
 * commands that need a cluster. It is never a real cluster.
 *
 * - `FakeKubeCluster`: one HTTP server on 127.0.0.1 answering what the deploy worker calls itself: `/version`,
 *   server-side apply (PATCH with `application/apply-patch+yaml` and a field manager) of any object, GET and DELETE by
 *   path, a Job's status (settles after `jobSettle` reads, with the exit code `exitCodeFor(job)` on its pod), the
 *   pods of a Job, and the Deployment, Ingress and Service the fake `helm` writes. Every request needs a bearer token
 *   the cloud fake that made the cluster accepts (`authenticate`: an EKS presigned-STS token, an AKS Entra token, DOKS
 *   credentials).
 * - `kubeHelm(cluster, real)`: a `HelmExec` that runs `version`, `template` and `lint` with the real pinned binary
 *   when there is one, and plays `upgrade --install`, `rollback` and `history` against the fake cluster: it checks
 *   the kubeconfig it is handed (private, the cluster's server, a token the cluster accepts), reads the values file,
 *   writes the Deployment (the image by digest), the release's Ingress or LoadBalancer Service with an address, and
 *   records the chart's migrate hook Job.
 * - `FakeApp`: the deployed app's `/readyz`, healthy unless the running image is one the test marked bad.
 */
import { readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parse as parseYaml } from 'yaml';
import { execHelm, type HelmExec } from '../src/cloud/helm.js';

type Obj = Record<string, unknown> & { metadata?: Record<string, unknown>; status?: Record<string, unknown>; spec?: Record<string, unknown> };

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export interface KubeRequest {
  method: string;
  path: string;
  query: string;
  contentType: string | undefined;
  authorized: boolean;
}

export class FakeKubeCluster {
  url = '';
  readonly objects = new Map<string, Obj>();
  readonly requests: KubeRequest[] = [];
  /** Does a bearer token belong to this cluster? Set by the cloud fake that made it. */
  authenticate: (token: string) => boolean = () => false;
  /** Reads of a Job before it finishes. */
  jobSettle = 1;
  /** The exit code of a Job's only container (the migrate check answers 2: expand-only migrations pending). */
  exitCodeFor: (job: Obj) => number = (job) => (JSON.stringify(job).includes('--check') ? 2 : 0);
  private readonly reads = new Map<string, number>();
  private server: Server | null = null;

  async start(): Promise<this> {
    this.server = createServer(async (req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      const text = await body(req);
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
      const authorized = !!token && this.authenticate(token);
      this.requests.push({ method: req.method ?? '', path: u.pathname, query: u.search, contentType: req.headers['content-type'], authorized });
      const send = (status: number, obj: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
      if (!authorized) return send(401, { kind: 'Status', status: 'Failure', reason: 'Unauthorized', message: 'Unauthorized', code: 401 });
      if (u.pathname === '/version') return send(200, { major: '1', minor: '31', gitVersion: 'v1.31.0' });
      if (/\/pods$/.test(u.pathname) && req.method === 'GET') {
        const job = /job-name=([^,&]+)/.exec(decodeURIComponent(u.search))?.[1];
        const ns = u.pathname.split('/')[4]!;
        const j = job ? this.objects.get(`/apis/batch/v1/namespaces/${ns}/jobs/${job}`) : undefined;
        const done = j?.status && (j.status.succeeded || j.status.failed);
        return send(200, { kind: 'PodList', items: done ? [{ metadata: { name: `${job}-pod` }, status: { phase: j!.status!.succeeded ? 'Succeeded' : 'Failed', containerStatuses: [{ state: { terminated: { exitCode: this.exitCodeFor(j!) } } }] } }] : [] });
      }
      const path = u.pathname;
      if (req.method === 'GET') {
        const o = this.objects.get(path);
        // Sprint 60 (B-10401): a collection read (`/api/v1/nodes?labelSelector=k=v`) lists the objects under it.
        if (!o && [...this.objects.keys()].some((k) => k.startsWith(`${path}/`))) {
          const sel = (u.searchParams.get('labelSelector') ?? '').split(',').filter(Boolean).map((x) => x.split('=') as [string, string]);
          const items = [...this.objects.entries()].filter(([k, v]) => k.startsWith(`${path}/`) && !k.slice(path.length + 1).includes('/') && sel.every(([lk, lv]) => (v.metadata?.labels as Record<string, string> | undefined)?.[lk] === lv)).map(([, v]) => v);
          return send(200, { kind: 'List', items });
        }
        if (!o) return send(404, { kind: 'Status', reason: 'NotFound', code: 404 });
        if (o.kind === 'Job' && !(o.status?.succeeded || o.status?.failed)) {
          const n = (this.reads.get(path) ?? 0) + 1;
          this.reads.set(path, n);
          if (n > this.jobSettle) o.status = this.exitCodeFor(o) === 0 ? { succeeded: 1 } : { failed: 1 };
        }
        return send(200, o);
      }
      if (req.method === 'PATCH') {
        if (req.headers['content-type'] !== 'application/apply-patch+yaml') return send(415, { kind: 'Status', reason: 'UnsupportedMediaType', code: 415 });
        if (!u.searchParams.get('fieldManager')) return send(422, { kind: 'Status', reason: 'Invalid', message: 'fieldManager is required for apply', code: 422 });
        const obj = JSON.parse(text) as Obj;
        const existed = this.objects.has(path);
        this.objects.set(path, { ...obj, metadata: { ...obj.metadata, uid: `uid-${this.objects.size}`, managedFields: [{ manager: u.searchParams.get('fieldManager'), operation: 'Apply' }] }, ...(existed && obj.kind === 'Job' ? { status: this.objects.get(path)!.status } : {}) });
        return send(existed ? 200 : 201, this.objects.get(path));
      }
      if (req.method === 'DELETE') {
        this.objects.delete(path);
        this.reads.delete(path);
        return send(200, { kind: 'Status', status: 'Success' });
      }
      return send(405, { kind: 'Status', reason: 'MethodNotAllowed', code: 405 });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise((r) => this.server?.close(r));
  }

  /** The image the release's Deployment runs now. */
  image(namespace = 'exprsn-ai', name = 'exprsn-ai'): string | null {
    const d = this.objects.get(`/apis/apps/v1/namespaces/${namespace}/deployments/${name}`) as { spec?: { template?: { spec?: { containers?: { image?: string }[] } } } } | undefined;
    return d?.spec?.template?.spec?.containers?.[0]?.image ?? null;
  }

  secret(namespace = 'exprsn-ai', name = 'exprsn-ai-secrets'): Record<string, string> | null {
    const s = this.objects.get(`/api/v1/namespaces/${namespace}/secrets/${name}`) as { data?: Record<string, string> } | undefined;
    return s?.data ? Object.fromEntries(Object.entries(s.data).map(([k, v]) => [k, Buffer.from(v, 'base64').toString('utf8')])) : null;
  }
}

export interface HelmCall {
  args: string[];
  /** The kubeconfig as handed over: its path, mode, server and whether the cluster accepted its token. */
  kubeconfig: { path: string; mode: number; server: string; tokenAccepted: boolean } | null;
  values: Record<string, unknown> | null;
  env: Record<string, string>;
}

interface Revision {
  revision: number;
  status: string;
  values: Record<string, unknown>;
}

/** The `helm` the deploy worker runs, played against a fake cluster (and the real binary for render and lint). */
export function kubeHelm(cluster: FakeKubeCluster, real: string | null, o: { failFor?: (image: string) => boolean } = {}): HelmExec & { calls: HelmCall[]; history: Revision[] } {
  const calls: HelmCall[] = [];
  const history: Revision[] = [];
  const exec = (async (bin, args, opt) => {
    const at = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1]! : null);
    const kcPath = at('--kubeconfig');
    const valuesPath = at('--values');
    let kubeconfig: HelmCall['kubeconfig'] = null;
    if (kcPath) {
      const doc = parseYaml(readFileSync(kcPath, 'utf8')) as { clusters: { cluster: { server: string } }[]; users: { user: { token: string } }[] };
      kubeconfig = { path: kcPath, mode: statSync(kcPath).mode & 0o777, server: doc.clusters[0]!.cluster.server, tokenAccepted: cluster.authenticate(doc.users[0]!.user.token) };
    }
    const values = valuesPath ? (parseYaml(readFileSync(valuesPath, 'utf8')) as Record<string, unknown>) : null;
    calls.push({ args: [...args], kubeconfig, values, env: { ...opt.env } });
    const cmd = args[0];
    if (cmd === 'version' || cmd === 'template' || cmd === 'lint') {
      if (real) return execHelm(real, args, opt);
      return { code: 0, stdout: cmd === 'version' ? 'v3.19.0+gfake\n' : '', stderr: '' };
    }
    if (!kubeconfig || kubeconfig.server !== cluster.url || !kubeconfig.tokenAccepted) return { code: 1, stdout: '', stderr: 'Error: Kubernetes cluster unreachable: the server has asked for the client to provide credentials' };
    const ns = at('--namespace') ?? 'default';
    if (cmd === 'upgrade') {
      const name = args[2]!;
      const v = values ?? {};
      const img = v.image as { repository: string; digest: string };
      const image = `${img.repository}@${img.digest}`;
      if (o.failFor?.(image)) {
        history.push({ revision: history.length + 1, status: 'failed', values: v });
        return { code: 1, stdout: '', stderr: `Error: UPGRADE FAILED: context deadline exceeded (${name})` };
      }
      write(cluster, ns, name, v);
      for (const r of history) if (r.status === 'deployed') r.status = 'superseded';
      history.push({ revision: history.length + 1, status: 'deployed', values: v });
      return { code: 0, stdout: JSON.stringify({ name, namespace: ns, version: history.length, info: { status: 'deployed' }, chart: { metadata: { version: '1.7.0', appVersion: '1.7.0' } } }), stderr: '' };
    }
    if (cmd === 'rollback') {
      const name = args[1]!;
      const to = history.find((r) => r.revision === Number(args[2]));
      if (!to) return { code: 1, stdout: '', stderr: `Error: release: not found (revision ${args[2]})` };
      write(cluster, ns, name, to.values);
      for (const r of history) if (r.status === 'deployed' || r.status === 'failed') r.status = 'superseded';
      history.push({ revision: history.length + 1, status: 'deployed', values: to.values });
      return { code: 0, stdout: 'Rollback was a success! Happy Helming!\n', stderr: '' };
    }
    if (cmd === 'history') return { code: 0, stdout: JSON.stringify(history.map((r) => ({ revision: r.revision, status: r.status, chart: 'exprsn-ai-1.7.0', app_version: '1.7.0' }))), stderr: '' };
    return { code: 1, stdout: '', stderr: `fake helm: ${cmd} is not played` };
  }) as HelmExec & { calls: HelmCall[]; history: Revision[] };
  exec.calls = calls;
  exec.history = history;
  return exec;
}

/** What `helm upgrade` would have made in the cluster: the Deployment, the hook Job, the ingress or LoadBalancer Service. */
function write(cluster: FakeKubeCluster, ns: string, name: string, v: Record<string, unknown>): void {
  const img = v.image as { repository: string; digest: string };
  const replicas = Number(v.replicaCount ?? 1);
  cluster.objects.set(`/apis/apps/v1/namespaces/${ns}/deployments/${name}`, { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: ns }, spec: { replicas, template: { spec: { containers: [{ name: 'server', image: `${img.repository}@${img.digest}` }] } } }, status: { readyReplicas: replicas, updatedReplicas: replicas } });
  if ((v.migrations as { mode?: string } | undefined)?.mode === 'job') cluster.objects.set(`/apis/batch/v1/namespaces/${ns}/jobs/${name}-migrate`, { apiVersion: 'batch/v1', kind: 'Job', metadata: { name: `${name}-migrate`, namespace: ns, annotations: { 'helm.sh/hook': 'pre-install,pre-upgrade' } }, spec: { template: { spec: { containers: [{ image: `${img.repository}@${img.digest}`, command: ['/usr/bin/tini', '--', 'node', 'server/dist/cli.js', 'migrate'] }] } } }, status: { succeeded: 1 } });
  const ingress = v.ingress as { enabled?: boolean; className?: string } | undefined;
  const service = v.service as { type?: string } | undefined;
  if (ingress?.enabled) cluster.objects.set(`/apis/networking.k8s.io/v1/namespaces/${ns}/ingresses/${name}`, { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name, namespace: ns }, spec: { ingressClassName: ingress.className }, status: { loadBalancer: { ingress: [{ hostname: `${ingress.className === 'alb' ? 'k8s-exprsnai-0123456789' : 'aks'}.lb.example.test` }] } } });
  cluster.objects.set(`/api/v1/namespaces/${ns}/services/${name}`, { apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: ns }, spec: { type: service?.type ?? 'ClusterIP' }, status: service?.type === 'LoadBalancer' ? { loadBalancer: { ingress: [{ ip: '203.0.113.10' }] } } : {} });
}

/** The deployed app's `/readyz`: ready unless the image the fake cluster runs is marked bad. */
export class FakeApp {
  url = '';
  readonly bad = new Set<string>();
  hits = 0;
  private server: Server | null = null;
  constructor(private readonly cluster: FakeKubeCluster) {}

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      this.hits += 1;
      const image = this.cluster.image();
      const ok = !!image && !this.bad.has(image.split('@')[1] ?? '');
      res.writeHead(req.url === '/readyz' ? (ok ? 200 : 503) : 404, { 'content-type': 'application/json' }).end(JSON.stringify(ok ? { status: 'ready', checks: { database: 'ok', redis: 'ok' } } : { status: 'not ready', checks: { database: 'migration_failed', redis: 'ok' } }));
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise((r) => this.server?.close(r));
  }
}
