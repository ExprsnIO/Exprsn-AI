import { generateKeyPairSync, randomBytes, X509Certificate, type KeyObject } from 'node:crypto';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { gpuNodes } from '../src/cloud/cloud-metrics.js';
import type { Deployment } from '../src/cloud/graph.js';
import { ENROL_PATH, ENROL_SECRET, GPU_NAMESPACE, gpuBootstrapScript, mirrorRef, mirrorRefProblem, renderGpuNodeInit } from '../src/cloud/gpu-node.js';
import { GpuQuotas, awsVcpus, azureFamily, isCapacityError } from '../src/cloud/gpu-quotas.js';
import type { GpuPoolLink } from '../src/cloud/gpu-pools.js';
import { fieldChanges } from '../src/cloud/planner.js';
import { CloudProviderError, type CloudProvider, type OperationResult, type ResourceSpec } from '../src/cloud/providers/types.js';
import { renderGraph } from '../src/cloud/render.js';
import type { DeploymentSpec } from '../src/cloud/spec.js';
import { deployed, drain, kubeSpec, kubeWorld, PROVIDERS, type KubeProvider, type KubeWorld } from './cloud-kubernetes-helpers.js';
import { signerFixture } from './cloud-credentials-helpers.js';
import { FakeGpuNode, tokenFromUserData } from './fake-gpu-node.js';
import { FakeOllama } from './fake-ollama.js';

/*
 * 1.9.99-final, Sprint 60 (B-10401, B-10404, B-10405): cloud GPU node groups and GPU VMs as gateway pools, against
 * the AWS, Azure and DigitalOcean fakes and their fake Kubernetes APIs only (127.0.0.1, never a real cloud). The
 * nodes are played in-process (`fake-gpu-node.ts`): they enrol with their single-use token, serve a fake Ollama
 * behind their own mTLS proxy, and warm up from the mirror. The deployments use the network 127.0.0.0/16 so the
 * nodes' addresses (127.0.0.1, each on its own port) are inside it, as a node's private address is in a real one.
 */

vi.setConfig({ testTimeout: 240_000, hookTimeout: 300_000 });

const GPU: Record<KubeProvider, 'l4' | 'a10' | 'h100'> = { aws: 'l4', azure: 'a10', digitalocean: 'h100' };
const IMAGES = { ollama: `ghcr.io/ollama/ollama@sha256:${'1'.repeat(64)}`, proxy: `ghcr.io/exprsn/gpu-proxy@sha256:${'2'.repeat(64)}` };
const MIRROR = 'https://models.mirror.internal:5000/';
const MODEL = 'llama3.1:8b';

let w: KubeWorld;
let signer: Awaited<ReturnType<typeof signerFixture>>;
const nodes: FakeGpuNode[] = [];
const ollamas: FakeOllama[] = [];

async function node(name: string): Promise<FakeGpuNode> {
  const o = await new FakeOllama().start();
  ollamas.push(o);
  const n = await new FakeGpuNode(name, o).listen();
  nodes.push(n);
  return n;
}

const gpuSpec = (p: KubeProvider, name: string, over: Record<string, unknown> = {}): DeploymentSpec => kubeSpec(w, p, name, { network: { cidr: '127.0.0.0/16' }, gpuPools: [{ name: 'chat', gpu: GPU[p], min: 1, max: 2, images: IMAGES, ...over }] } as never);

/** Seeds a Kubernetes node of a node group in the fake cluster (what the provider's autoscaler would register). */
function addKubeNode(p: KubeProvider, group: string, name: string): void {
  w.kube[p].objects.set(`/api/v1/nodes/${name}`, { apiVersion: 'v1', kind: 'Node', metadata: { name, creationTimestamp: new Date(Date.now() - 60_000).toISOString(), labels: { 'exprsn.ai/node-group': group, 'exprsn.ai/role': 'gpu' } }, status: { addresses: [{ type: 'InternalIP', address: '127.0.0.1' }] } });
}

/** The node's token, from the Secret the reconcile job wrote. */
function secretToken(p: KubeProvider, nodeName: string): { token: string; url: string; mirror: string | null; expiresAt: number } | null {
  const sec = w.kube[p].objects.get(`/api/v1/namespaces/${GPU_NAMESPACE}/secrets/${ENROL_SECRET}`) as { stringData?: Record<string, string> } | undefined;
  const v = sec?.stringData?.[nodeName];
  return v ? JSON.parse(v) : null;
}

/** Lets a drain started in the background by the interruption route settle. */
const drainPending = () => new Promise((r) => setTimeout(r, 300));

async function approveOn(poolId: string): Promise<void> {
  const g = w.h.s.gateway.repo;
  const m = (await g.modelByName(MODEL)) ?? (await g.createModel({ name: MODEL, source: 'Ollama library', expectedDigest: null, license: { name: 'Llama 3.1 Community' }, label: 'internal', notes: null, requestedBy: 'seed', requestedTenant: w.h.tenantId }));
  await g.updateModel(m.id, { state: 'approved', digest: `sha256:${'c'.repeat(64)}` });
  if (!(await g.placements()).some((x) => x.pool_id === poolId && x.model_id === m.id)) await g.place(m.id, poolId, 'warm', 'seed');
}

beforeAll(async () => {
  // The CA's keys live in the signer (it never holds a private key itself).
  signer = await signerFixture();
  w = await kubeWorld(signer.env);
  const s = w.h.s;
  if (!(await s.db.schema.hasTable('cloud_gpu_pool_links'))) await (await import('../src/db/migrations/157_cloud_gpu_pools.js')).up(s.db);
  s.cloud.gpuPools.reset();
  const by = { tenantId: w.h.tenantId, userId: null, actor: { service: 'test' } };
  await s.pki.createRoot(by, { commonName: 'GPU Pools Test Root', keyType: 'ecdsa-p256', days: 3650 });
  await s.pki.createIntermediate(by, w.h.tenantId, { keyType: 'ecdsa-p256', days: 1825 });
  // The model mirror (Platform › Mirrors, kind models).
  const t = Date.now();
  await s.db('platform_mirrors').insert({ id: '01JMIRRORMODELS00000000000', name: 'models', kind: 'models', store: 'registry', url: MIRROR, consumer: null, max_age_days: null, created_by: null, created_at: t, updated_at: t });
});

afterAll(async () => {
  for (const n of nodes) await n.stop();
  for (const o of ollamas) await o.stop();
  await w?.stop();
  await signer?.close();
});

describe('rendering the node bootstrap (B-10401, B-10404)', () => {
  it('renders a GPU node group with its capacity list and a GPU VM whose user data enrols with a single-use token placeholder', async () => {
    const zones = await w.h.s.zones.current();
    const kube = renderGraph(gpuSpec('aws', 'r-k8s', { fallbackTypes: ['g5.xlarge'] }), { zones, corporateCidrs: [] }).resources.find((r) => r.key === 'gpu-chat')!;
    expect(kube.spec).toMatchObject({ role: 'gpu', size: 'g6.xlarge', capacity: { sizes: ['g6.xlarge', 'g5.xlarge'] }, warmup: { source: 'mirror' }, gpuNode: { pool: 'chat', images: IMAGES } });
    for (const p of PROVIDERS) {
      const spec = { ...gpuSpec(p, `r-vm-${p}`), compute: { shape: 'vm' as const, size: 'small' as const } };
      const vm = renderGraph(spec, { zones, corporateCidrs: [] }).resources.find((r) => r.key === 'gpu-chat-1')!;
      const ud = String(vm.spec.userData);
      expect(vm.spec).toMatchObject({ role: 'gpu', imdsV2: true, metadataHopLimit: 1, publicIp: false });
      expect(ud).toMatch(/^#cloud-config\n/);
      expect(ud).toContain("content: '@@EXPRSN_ENROL:chat:gpu-chat-1@@'");
      expect(ud).toContain('Environment=OLLAMA_HOST=127.0.0.1:11434');
      expect(ud).toContain('policy drop;'); // the egress guard
      expect(ud).toContain('mirror_ok "$ref" || exit 1');
      expect(ud).toContain('ssl_verify_client on');
      expect(ud).not.toMatch(/exe1_/); // no token in the graph
    }
    // A snapshot warm-up mounts the pre-seeded volume and points Ollama at it.
    const snap = renderGpuNodeInit({ deployment: 'd', pool: 'chat', key: 'gpu-chat-1', warmup: { source: 'snapshot', snapshotId: 'snap-0123' } });
    expect(snap).toContain('LABEL=exprsn-models');
    expect(snap).toContain('OLLAMA_MODELS=/var/lib/exprsn-models');
  });

  it('refuses every pull reference that is not on the mirror', () => {
    const host = 'models.mirror.internal:5000';
    expect(mirrorRef(host, MODEL)).toBe(`${host}/library/${MODEL}`);
    expect(mirrorRefProblem(host, `${host}/library/${MODEL}`)).toBeNull();
    expect(mirrorRefProblem(host, `registry.ollama.ai/library/${MODEL}`)).toMatch(/not on the mirror/);
    expect(mirrorRefProblem(host, `${host}.evil.example/library/x`)).toMatch(/not on the mirror/);
    expect(mirrorRefProblem(null, MODEL)).toMatch(/no model mirror/);
    const script = gpuBootstrapScript({ deployment: 'd', pool: 'chat', warmup: { source: 'mirror' }, tokenFile: '/x', nodeName: 'n' }).join('\n');
    expect(script).toContain('case "$1" in "$MIRROR_HOST"/*) return 0');
  });
});

describe('node groups as pools on EKS, AKS and DOKS (B-10401, B-10404)', () => {
  const state: Partial<Record<KubeProvider, { d: Deployment; link: GpuPoolLink; group: string }>> = {};

  for (const p of PROVIDERS) {
    it(`${p}: the GPU node group applies, links to a gateway pool, and two nodes join with no manual registration`, async () => {
      const s = w.h.s;
      const d = await deployed(w, gpuSpec(p, `gpu-${p === 'digitalocean' ? 'do' : p}`));
      const [link] = await s.cloud.gpuPools.nodeGroupsFor(d.id);
      expect(link).toMatchObject({ kind: 'node_group', poolName: 'chat', state: 'active', min: 1, max: 2, warmup: { source: 'mirror' } });
      expect(link!.providerId).toBeTruthy();
      expect(link!.gatewayPoolId).toBeTruthy();
      expect(link!.clientCertId).toBeTruthy();
      expect(link!.priceHourly).toBeGreaterThan(0);
      expect(await s.cloud.gpuPools.linkFor(link!.gatewayPoolId!)).toMatchObject({ id: link!.id });
      const pool = await s.gateway.repo.pool(link!.gatewayPoolId!);
      expect(pool).toMatchObject({ name: `${d.name}-chat`, accelerator: 'cuda', zone: 'inference' });
      // The DaemonSet on the group's nodes, tolerating the GPU taint, host network, its images by digest.
      const group = `${d.name}-gpu-chat`;
      const ds = w.kube[p].objects.get(`/apis/apps/v1/namespaces/${GPU_NAMESPACE}/daemonsets/exprsn-gpu-chat`) as { spec: { template: { spec: Record<string, unknown> } } } | undefined;
      expect(ds?.spec.template.spec).toMatchObject({ hostNetwork: true, nodeSelector: { 'exprsn.ai/node-group': group }, tolerations: [{ key: 'exprsn.ai/gpu' }] });
      expect(JSON.stringify(ds)).toContain(IMAGES.ollama);
      await approveOn(link!.gatewayPoolId!);

      // One node: a token in the Secret, bound to it; it enrols, serves through mTLS, and warms up from the mirror.
      addKubeNode(p, group, `${p}-n1`);
      expect((await s.cloud.gpuPools.nodes.reconcileAll(d.id)).minted).toBe(1);
      const t1 = secretToken(p, `${p}-n1`)!;
      expect(t1.token).toMatch(/^exe1_/);
      expect(t1.mirror).toBe('models.mirror.internal:5000');
      expect(await s.db('cloud_gpu_enrolments').where({ link_id: link!.id }).first()).not.toHaveProperty('token', expect.anything());
      const n1 = await node(`${p}-n1`);
      const r1 = await n1.enrol(w.h.app, t1);
      expect(r1.status, JSON.stringify(r1.body)).toBe(201);
      const cert = new X509Certificate(n1.enrolled!.certificate);
      expect(cert.subjectAltName).toBe('IP Address:127.0.0.1');
      expect(cert.checkIssued(new X509Certificate(n1.enrolled!.chain[0]!))).toBe(true);
      // The node's key never left it: the certificate is for the public key it made.
      expect(cert.checkPrivateKey(n1.key)).toBe(true);
      const inst1 = (await s.gateway.repo.instance(n1.enrolled!.instance.id))!;
      expect(inst1).toMatchObject({ deploy: 'cloud', pool_id: link!.gatewayPoolId, url: `https://127.0.0.1:${n1.port}`, tls: { identity: `gpu-pool:${link!.id}`, pinSha256: cert.fingerprint256.replace(/:/g, '').toLowerCase() } });
      // Warm-up: the approved placement, from the mirror only; nothing else pulled.
      expect(n1.enrolled!.warmup.models).toEqual([{ name: MODEL, ref: `models.mirror.internal:5000/library/${MODEL}`, digest: `sha256:${'c'.repeat(64)}` }]);
      expect(n1.pulled).toEqual([`models.mirror.internal:5000/library/${MODEL}`]);
      expect(n1.refused).toEqual([]);
      // The gateway reaches it with the pool's client certificate, and trusts it by its own certificate.
      await s.gateway.pollOne(inst1.id);
      expect((await s.gateway.repo.instance(inst1.id))!.health).toBe('healthy');
      const client = (await s.pki.certificate(link!.tenantId, link!.clientCertId!))!;
      expect(n1.clients[0]).toBe(new X509Certificate(client.certificate_pem).fingerprint256);
      expect(n1.rejected).toBe(0);
      expect(n1.pullsSeen()).toEqual([]); // the node served its placement without any pull through the gateway
      // Boot to healthy recorded.
      expect(await s.cloud.gpuPools.nodes.observe()).toBeGreaterThanOrEqual(1);
      const [timing] = await s.cloud.gpuPools.nodes.timings(link!.id);
      expect(timing).toMatchObject({ node: `${p}-n1`, source: 'mirror' });
      expect(timing!.healthyAt).not.toBeNull();
      expect(timing!.seconds).toBeGreaterThanOrEqual(0);
      expect(timing!.bootedAt).toBeLessThanOrEqual(timing!.enrolledAt);

      // The group scaled from one to two nodes: the second node gets its own token, n1 none again; both healthy.
      addKubeNode(p, group, `${p}-n2`);
      expect((await s.cloud.gpuPools.nodes.reconcileAll(d.id)).minted).toBe(1);
      expect(secretToken(p, `${p}-n1`)).toBeNull();
      const n2 = await node(`${p}-n2`);
      expect((await n2.enrol(w.h.app, secretToken(p, `${p}-n2`)!)).status).toBe(201);
      await s.gateway.pollOne(n2.enrolled!.instance.id);
      const healthy = (await s.gateway.repo.instances(link!.gatewayPoolId!)).filter((i) => i.health === 'healthy' && i.deploy === 'cloud');
      expect(healthy.map((i) => i.name).sort()).toEqual([`${d.name}-chat-${p}-n1-${n1.port}`, `${d.name}-chat-${p}-n2-${n2.port}`].sort()); // a node on another port than 11435 is named with it
      state[p] = { d, link: link!, group };
      // Audited.
      const actions = ((await s.db('audit_events').where({ tenant_id: w.h.tenantId }).select('action')) as { action: string }[]).map((x) => x.action);
      expect(actions).toEqual(expect.arrayContaining(['cloud.gpu.pool.linked', 'cloud.gpu.node.enrolled']));
    });
  }

  it('enrolment tokens are single use: replayed, expired, unknown and another node\'s tokens are refused', async () => {
    const s = w.h.s;
    const { d, link, group } = state.aws!;
    addKubeNode('aws', group, 'aws-n3');
    await s.cloud.gpuPools.nodes.reconcileAll(d.id);
    const t3 = secretToken('aws', 'aws-n3')!;
    const n3 = await node('aws-n3');
    // Another node presenting n3's token is refused, and (B-10803) the token is not spent, so it cannot be burnt.
    const wrong = await n3.enrol(w.h.app, t3, { node: 'aws-n1' });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toMatchObject({ reason: 'enrolment_refused', why: 'node_mismatch' });
    expect((await n3.enrol(w.h.app, t3)).status).toBe(201);
    // Replayed: the same token again.
    const again = await n3.enrol(w.h.app, t3);
    expect(again.body).toMatchObject({ why: 'replayed' });
    // A token used once successfully cannot enrol a second node either.
    const fresh = await s.cloud.gpuPools.nodes.mint(link, {});
    const n4 = await node('aws-n4');
    expect((await n4.enrol(w.h.app, fresh)).status).toBe(201);
    const n5 = await node('aws-n5');
    expect((await n5.enrol(w.h.app, fresh)).body).toMatchObject({ why: 'replayed' });
    // Expired.
    s.cloud.gpuPools.nodes.options.tokenTtlMs = -1000;
    const old = await s.cloud.gpuPools.nodes.mint(link, {});
    s.cloud.gpuPools.nodes.options.tokenTtlMs = 30 * 60_000;
    expect((await n5.enrol(w.h.app, old)).body).toMatchObject({ why: 'expired' });
    // Unknown.
    expect((await n5.enrol(w.h.app, { token: `exe1_${randomBytes(32).toString('base64url')}` })).body).toMatchObject({ why: 'unknown' });
    expect((await n5.enrol(w.h.app, { token: 'nonsense' })).status).toBe(401);
    // An address outside the deployment's network.
    const outside = await s.cloud.gpuPools.nodes.mint(link, {});
    expect((await n5.enrol(w.h.app, outside, { address: '192.0.2.10' })).body).toMatchObject({ why: 'address_outside' });
    // B-10803: a token bound to no node cannot take over the instance another node enrolled at another address.
    const unbound = await s.cloud.gpuPools.nodes.mint(link, {});
    const n4row = (await s.gateway.repo.instances(link.gatewayPoolId!)).find((i) => i.name.includes('aws-n4'))!;
    const own5 = n5.port;
    n5.port = Number(new URL(n4row.url).port);
    const takeover = await n5.enrol(w.h.app, unbound, { node: 'aws-n4', address: '127.0.0.9' });
    n5.port = own5;
    expect(takeover.body).toMatchObject({ why: 'node_mismatch' });
    expect((await s.gateway.repo.instance(n4row.id))!.url).toBe(n4row.url);
    // A malformed request is refused before any token is looked at.
    expect((await request(w.h.app).post(ENROL_PATH).send({ token: 'x' })).status).toBe(400);
    const refused = ((await s.db('audit_events').where({ action: 'cloud.gpu.node.refused' }).select('detail')) as { detail: string }[]).map((r) => JSON.parse(r.detail).why);
    expect(refused).toEqual(expect.arrayContaining(['node_mismatch', 'replayed', 'expired', 'address_outside']));
  });

  it('the metrics count joined and idle nodes of node groups through their link', async () => {
    const s = w.h.s;
    const { d } = state.azure!;
    // The provider reports three nodes in the group; two enrolled and healthy.
    const row = (await s.db('cloud_resources').where({ deployment_id: d.id, key: 'gpu-chat' }).first()) as { id: string; observed: string };
    const observed = JSON.parse(row.observed) as { props: Record<string, unknown> };
    observed.props.count = 3;
    await s.db('cloud_resources').where({ id: row.id }).update({ observed: JSON.stringify(observed) });
    const c = (await gpuNodes(s)).azure;
    expect(c.joined).toBe(2);
    expect(c.provisioned - c.joined).toBe(1); // idle
    // An unhealthy instance is not joined.
    const [one] = (await s.gateway.repo.instances(state.azure!.link.gatewayPoolId!)).filter((i) => i.deploy === 'cloud');
    await s.gateway.repo.updateInstance(one!.id, { health: 'unreachable' });
    expect((await gpuNodes(s)).azure.joined).toBe(1);
    await s.gateway.repo.updateInstance(one!.id, { health: 'healthy' });
  });

  // B-10403: the node's enrolment certificate carries clientAuth too, so its spot watcher posts over mTLS with it.
  it('a node posts an interruption notice over mTLS with its enrolment certificate; another certificate is refused', async () => {
    const s = w.h.s;
    if (!(await s.db.schema.hasTable('cloud_scale_policies'))) await (await import('../src/db/migrations/158_cloud_autoscale.js')).up(s.db);
    s.cloud.autoscale.resetSchemaCache();
    const { link } = state.aws!;
    await s.cloud.autoscale.ensurePolicy(link);
    const n1 = nodes.find((n) => n.name === 'aws-n1' && n.enrolled)!;
    const e = n1.enrolled!;
    expect(new X509Certificate(e.certificate).keyUsage).toEqual(expect.arrayContaining(['1.3.6.1.5.5.7.3.1', '1.3.6.1.5.5.7.3.2']));
    // This server on TLS, asking for client certificates from the tenant's CA (the node's certificate serves it too).
    const ca = [...e.chain, ...e.gateway.caChain];
    const server = createHttpsServer({ key: n1.key.export({ type: 'pkcs8', format: 'pem' }), cert: e.certificate + e.chain.join(''), ca, requestCert: true, rejectUnauthorized: false }, w.h.app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const post = (key: KeyObject, cert: string) =>
      new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
        const req = httpsRequest({ host: '127.0.0.1', port, method: 'POST', path: '/cloud/v1/nodes/interruptions', key: key.export({ type: 'pkcs8', format: 'pem' }), cert, ca, headers: { 'content-type': 'application/json' } }, (res) => {
          let text = '';
          res.on('data', (c: Buffer) => (text += c.toString()));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }));
        });
        req.on('error', reject);
        req.end(JSON.stringify({ kind: 'ec2_rebalance', eventId: 'rebalance-1' }));
      });
    try {
      const ok = await post(n1.key, e.certificate);
      expect(ok.status, JSON.stringify(ok.body)).toBe(202);
      expect(ok.body).toMatchObject({ duplicate: false, state: 'draining' });
      expect((await s.gateway.repo.instance(e.instance.id))!.state).toBe('draining');
      // A certificate from the same CA that was not issued to a node of this pool at enrolment: refused.
      const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const issuer = (await s.pki.activeIntermediate(w.h.tenantId))!;
      const profile = (await s.pki.profiles(w.h.tenantId)).find((x) => x.id === link.clientProfileId)!;
      const by = { tenantId: w.h.tenantId, userId: null, actor: { service: 'test' } };
      const stray = await s.pki.issueKey(by, issuer, profile, { spki: other.publicKey.export({ type: 'spki', format: 'der' }), keyType: 'ec-p256', commonName: 'stray', sans: [{ type: 'uri', value: 'exprsn-gpu://gateway/stray' }] });
      const refused = await post(other.privateKey, stray.cert.certificate_pem);
      expect(refused.status).toBe(401);
      expect(refused.body).toMatchObject({ reason: 'node_certificate' });
    } finally {
      await new Promise((r) => server.close(r));
      await drainPending();
      await s.gateway.undrain(e.instance.id);
    }
  });

  it('routes: the pools with their nodes and boot timings; a hand-minted token is shown once and audited', async () => {
    const { link } = state.digitalocean!;
    const list = await w.alice.client.agent.get('/api/admin/cloud/gpu-pools').expect(200);
    const mine = (list.body.pools as { id: string; nodes: { healthy: number }; bootToHealthy: { samples: number } }[]).find((x) => x.id === link.id)!;
    expect(mine.nodes.healthy).toBe(2);
    expect(mine.bootToHealthy.samples).toBeGreaterThanOrEqual(1);
    const one = await w.alice.client.agent.get(`/api/admin/cloud/gpu-pools/${link.id}`).expect(200);
    expect(one.body.warmup.models[0].ref).toContain('models.mirror.internal:5000/');
    expect(JSON.stringify(one.body)).not.toMatch(/client_key_sealed|PRIVATE KEY/);
    const minted = await w.alice.client.agent.post(`/api/admin/cloud/gpu-pools/${link.id}/enrolments`).set('x-csrf-token', w.alice.client.csrf).send({ node: 'hand-1' });
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    expect(minted.body.token).toMatch(/^exe1_/);
    const ev = (await w.h.s.db('audit_events').where({ action: 'cloud.gpu.enrolment.minted' }).orderBy('seq', 'desc').first()) as { detail: string };
    expect(ev.detail).not.toContain(minted.body.token);
  });
});

describe('GPU VMs on EC2, Azure and DigitalOcean (B-10401)', () => {
  for (const p of PROVIDERS) {
    it(`${p}: the GPU VM is created with a single-use token in its user data, and the VM enrols with it`, async () => {
      const s = w.h.s;
      const spec = { ...gpuSpec(p, `vm-${p === 'digitalocean' ? 'do' : p}`), compute: { shape: 'vm' as const, size: 'small' as const }, release: { tarball: { url: 'https://releases.example.test/x.tar.gz', sha256: 'a'.repeat(64) } }, keys: { provider: 'openbao' as const, addr: 'https://bao.example.test', transitMount: 'transit' } };
      const d = await s.cloud.deployments.create(w.alice, { name: spec.name, accountId: spec.target.accountId, region: spec.target.region, label: spec.label, spec: spec as unknown as Record<string, unknown> });
      const [link] = await s.cloud.gpuPools.nodes.ensureLinks(d, w.alice.principal.userId);
      expect(link).toMatchObject({ kind: 'vm', state: 'active' });
      await approveOn(link!.gatewayPoolId!);
      const desired = renderGraph(spec, { zones: await s.zones.current(), corporateCidrs: [] }).resources.find((r) => r.key === 'gpu-chat-1')!;
      const c = await s.cloud.deployments.context(d, 'deploy');
      const ids = new Map<string, string>(desired.dependsOn.map((k) => [k, `fake-${k}`]));
      if (desired.network) ids.set(desired.network, p === 'digitalocean' ? [...w.do.vpcs.keys()][0] ?? 'vpc-1' : `fake-${desired.network}`);
      const rs = s.cloud.deployments.specFor(d, c.account, desired, `vm-${p}-step`, ids as Map<string, string | null>);
      const ctx = { ...c.ctx(spec.target.region), secrets: { value: async () => 'unused', wrap: async () => null, enrol: (pool: string, key: string) => s.cloud.gpuPools.nodes.enrolForVm(d, pool, key) } };
      await c.provider.create(ctx, rs).catch((err: unknown) => {
        throw new Error(`${p} create: ${(err as Error).message}`);
      });
      const ud = p === 'aws' ? Buffer.from([...w.aws.compute.instances.values()].at(-1)!.UserData ?? '', 'base64').toString('utf8') : p === 'azure' ? azureCustomData() : String(w.do.userData.get([...w.do.droplets.keys()].at(-1)!) ?? '');
      expect(ud).not.toContain('@@EXPRSN_ENROL');
      const payload = tokenFromUserData(ud)!;
      expect(payload.token).toMatch(/^exe1_/);
      const n = await node('gpu-chat-1');
      const r = await n.enrol(w.h.app, payload);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      await s.gateway.pollOne(n.enrolled!.instance.id);
      expect((await s.gateway.repo.instance(n.enrolled!.instance.id))!).toMatchObject({ deploy: 'cloud', health: 'healthy' });
      expect(n.pulled).toEqual([`models.mirror.internal:5000/library/${MODEL}`]);
    });
  }
});

/** The custom data of the last Azure VM the fake was given. */
function azureCustomData(): string {
  const vms = [...(w.azure as unknown as { resources: Map<string, { type: string; body: { properties?: { osProfile?: { customData?: string } } } }> }).resources.values()].filter((r) => r.type.toLowerCase() === 'microsoft.compute/virtualmachines');
  return Buffer.from(vms.at(-1)?.body.properties?.osProfile?.customData ?? '', 'base64').toString('utf8');
}

describe('GPU quotas and capacity (B-10405)', () => {
  it('a plan past the GPU quota is refused at plan time with the quota\'s name and the requested and available numbers', async () => {
    const s = w.h.s;
    // AWS: G and VT on-demand vCPUs; 8 requested (two g6.xlarge), 4 left.
    w.aws.serviceQuotas.set('L-DB2E81BA', { name: 'Running On-Demand G and VT instances', value: 4 });
    const aws = gpuSpec('aws', 'quota-aws');
    const da = await s.cloud.deployments.create(w.alice, { name: aws.name, accountId: aws.target.accountId, region: aws.target.region, label: aws.label, spec: aws as unknown as Record<string, unknown> });
    const pa = await s.cloud.plans.create(w.alice, da.id, renderGraph(aws, { zones: await s.zones.current(), corporateCidrs: [] }).resources);
    expect(pa.applicable, `${pa.note} | ${pa.blockers.join(" ; ")}`).toBe(false);
    const ga = [...w.aws.compute.instances.values()].filter((i) => /^g\d/.test(i.InstanceType) && i.State !== 'terminated').reduce((n, i) => n + awsVcpus(i.InstanceType), 0);
    expect(pa.blockers.join('\n')).toContain(`the GPU quota "Running On-Demand G and VT instances" (L-DB2E81BA) in eu-central-1 does not fit: requested 8 vCPUs, available ${Math.max(0, 4 - ga)} (limit 4, in use ${ga})`);
    expect(pa.blockers.join('\n')).toContain('servicequotas/home/services/ec2/quotas/L-DB2E81BA');
    expect(w.aws.calls('servicequotas:GetServiceQuota').length).toBeGreaterThan(0);
    w.aws.serviceQuotas.set('L-DB2E81BA', { name: 'Running On-Demand G and VT instances', value: 64 });

    // Azure: the family's vCPUs (two NV36ads A10 v5 = 72; 36 allowed).
    w.azure.computeUsages.set('westeurope', [{ family: 'standardNVADSA10v5Family', localized: 'Standard NVADS A10 v5 Family vCPUs', current: 0, limit: 36 }]);
    const az = gpuSpec('azure', 'quota-az');
    const dz = await s.cloud.deployments.create(w.alice, { name: az.name, accountId: az.target.accountId, region: az.target.region, label: az.label, spec: az as unknown as Record<string, unknown> });
    const pz = await s.cloud.plans.create(w.alice, dz.id, renderGraph(az, { zones: await s.zones.current(), corporateCidrs: [] }).resources);
    expect(pz.blockers.join('\n')).toContain('the GPU quota "Standard NVADS A10 v5 Family vCPUs" (standardNVADSA10v5Family) in westeurope does not fit: requested 72 vCPUs, available 36 (limit 36, in use 0)');
    w.azure.computeUsages.delete('westeurope');

    // DigitalOcean: the droplet limit.
    w.do.dropletLimit = w.do.droplets.size + 1;
    const dop = gpuSpec('digitalocean', 'quota-do');
    const dd = await s.cloud.deployments.create(w.alice, { name: dop.name, accountId: dop.target.accountId, region: dop.target.region, label: dop.label, spec: dop as unknown as Record<string, unknown> });
    const pd = await s.cloud.plans.create(w.alice, dd.id, renderGraph(dop, { zones: await s.zones.current(), corporateCidrs: [] }).resources);
    expect(pd.blockers.join('\n')).toMatch(/the GPU quota "Droplet limit" \(droplet_limit\) in fra1 does not fit: requested 2 droplets, available 1/);
    w.do.dropletLimit = 25;
    // A plan without GPU nodes reads no quota.
    const before = w.aws.calls('servicequotas:GetServiceQuota').length;
    const plain = kubeSpec(w, 'aws', 'quota-none');
    const dn = await s.cloud.deployments.create(w.alice, { name: plain.name, accountId: plain.target.accountId, region: plain.target.region, label: plain.label, spec: plain as unknown as Record<string, unknown> });
    const pn = await s.cloud.plans.create(w.alice, dn.id, renderGraph(plain, { zones: await s.zones.current(), corporateCidrs: [] }).resources);
    expect(pn.blockers.filter((b) => b.includes('GPU quota'))).toEqual([]);
    expect(w.aws.calls('servicequotas:GetServiceQuota').length).toBe(before);
  });

  it('a capacity error falls back to the next allowed instance type, then zone; other errors do not', async () => {
    const spec: ResourceSpec = { type: 'vm', name: 'gpu', idempotencyKey: 'k', tags: {}, props: { role: 'gpu', size: 'g6.xlarge', image: 'ubuntu-24.04-gpu', capacity: { sizes: ['g6.xlarge', 'g5.xlarge'], zones: ['eu-central-1a', 'eu-central-1b'] } } as never };
    const seen: string[] = [];
    const ok: OperationResult = { done: true, resource: { type: 'vm', providerId: 'i-1', name: 'gpu', state: 'ready', tags: {}, props: {} } };
    const flaky = async (sp: ResourceSpec) => {
      const p = sp.props as { size: string; zone?: string };
      seen.push(`${p.size}@${p.zone ?? '-'}:${sp.idempotencyKey}`);
      if (seen.length < 3) throw new CloudProviderError('AWS answered 500 (InsufficientInstanceCapacity): We currently do not have sufficient g6.xlarge capacity.', 'aws', 500, 'InsufficientInstanceCapacity');
      return ok;
    };
    const fell: string[] = [];
    expect(await GpuQuotas.withFallback(spec, flaky, (from, to) => void fell.push(`${from.size}->${to.size}@${to.zone}`))).toBe(ok);
    expect(seen).toEqual(['g6.xlarge@eu-central-1a:k#c0', 'g5.xlarge@eu-central-1a:k#c1', 'g6.xlarge@eu-central-1b:k#c2']);
    expect(fell).toEqual(['g6.xlarge->g5.xlarge@eu-central-1a', 'g5.xlarge->g6.xlarge@eu-central-1b']);
    // Azure's SkuNotAvailable is a capacity error; a permission error is not, and is thrown at once.
    expect(isCapacityError(new CloudProviderError('ARM answered 409 (SkuNotAvailable)', 'azure', 409, 'SkuNotAvailable'))).toBe(true);
    let calls = 0;
    await expect(GpuQuotas.withFallback(spec, async () => {
      calls++;
      throw new CloudProviderError('AccessDenied', 'aws', 403, 'UnauthorizedOperation');
    })).rejects.toThrow(/AccessDenied/);
    expect(calls).toBe(1);
    // Every allowed type and zone tried and none had capacity: the last refusal stands.
    await expect(GpuQuotas.withFallback(spec, async () => {
      throw new CloudProviderError('no capacity', 'aws', 500, 'InsufficientInstanceCapacity');
    })).rejects.toThrow(/no capacity/);
  });

  it('against the EC2 fake: RunInstances refused for capacity is retried with the next type, and the fallback size is not drift', async () => {
    const s = w.h.s;
    const adapter = (await s.cloud.providers.adapter('aws')) as unknown as CloudProvider;
    const cred = await (s.cloud.credentials as { for: (a: unknown) => Promise<never> }).for(w.accounts.aws);
    const ctx = { account: w.accounts.aws, cred, region: 'eu-central-1' };
    w.aws.fail(500, `<?xml version="1.0" encoding="UTF-8"?><Response><Errors><Error><Code>InsufficientInstanceCapacity</Code><Message>We currently do not have sufficient g6.xlarge capacity in the Availability Zone you requested.</Message></Error></Errors><RequestID>r-cap</RequestID></Response>`, { op: 'ec2:RunInstances', times: 1 });
    const spec: ResourceSpec = { type: 'vm', name: 'gpu-fallback', idempotencyKey: 'fb-step', tags: { 'exprsn:managed': 'true' }, props: { role: 'gpu', size: 'g6.xlarge', image: 'ubuntu-24.04-gpu', imdsV2: true, metadataHopLimit: 1, publicIp: false, capacity: { sizes: ['g6.xlarge', 'g5.xlarge'], zones: [] } } as never };
    const out = await GpuQuotas.withFallback(spec, (sp) => adapter.create(ctx as never, sp));
    const made = [...w.aws.compute.instances.values()].find((i) => i.InstanceId === (out.done ? out.resource!.providerId : out.operation.ref.providerId))!;
    expect(made.InstanceType).toBe('g5.xlarge');
    const want = { key: 'gpu-chat-1', type: 'vm' as const, spec: spec.props as Record<string, unknown>, dependsOn: [], protect: false, region: null };
    expect(fieldChanges(want, 'eu-central-1', null, { type: 'vm', providerId: made.InstanceId, name: 'gpu', state: 'ready', tags: {}, props: { size: 'g5.xlarge' } }).filter((c) => c.path === 'size')).toEqual([]);
    expect(fieldChanges(want, 'eu-central-1', null, { type: 'vm', providerId: made.InstanceId, name: 'gpu', state: 'ready', tags: {}, props: { size: 'p5.48xlarge' } }).map((c) => c.path)).toContain('size');
  });

  it('maps provider sizes to their quota families', () => {
    expect(awsVcpus('g6.xlarge')).toBe(4);
    expect(awsVcpus('p5.48xlarge')).toBe(192);
    expect(azureFamily('Standard_NC40ads_H100_v5')).toEqual({ family: 'standardNCADSH100v5Family', vcpus: 40 });
    expect(azureFamily('Standard_NV36ads_A10_v5')).toEqual({ family: 'standardNVADSA10v5Family', vcpus: 36 });
  });
});

describe('nothing changes until a GPU node group is planned', () => {
  it('a deployment without GPU pools gets no link, no gateway pool and no reconcile job', async () => {
    const s = w.h.s;
    const pools = (await s.gateway.repo.pools()).length;
    const d = await deployed(w, kubeSpec(w, 'digitalocean', 'plain-do'));
    expect(await s.cloud.gpuPools.nodeGroupsFor(d.id)).toEqual([]);
    expect((await s.gateway.repo.pools()).length).toBe(pools);
    await drain(w);
    expect(await s.db('jobs').where({ type: 'cloud.gpu.reconcile' }).andWhere('payload', 'like', `%${d.id}%`).first()).toBeUndefined();
  });
});
