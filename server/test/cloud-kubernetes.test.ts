import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chartValues, splitImage } from '../src/cloud/chart-values.js';
import { chartDir, Helm, HELM_PINNED } from '../src/cloud/helm.js';
import { kubeconfigYaml, withKubeconfig } from '../src/cloud/kubeconfig.js';
import { eksToken } from '../src/cloud/providers/aws-eks.js';
import { renderGraph } from '../src/cloud/render.js';
import { deploymentSpecSchema } from '../src/cloud/spec.js';
import { DIGEST_A, deployed, helmCalls, kubeSpec, kubeWorld, PROVIDERS, realHelm, REPO, type KubeProvider, type KubeWorld } from './cloud-kubernetes-helpers.js';

/*
 * 1.9.99-final, Sprint 58 (B-10203): the Kubernetes target on the EKS, AKS and DOKS fakes. A medium deployment per
 * provider: the network, the cluster and its app node group are created through the adapters; the release is
 * installed by the deploy worker with a short-lived kubeconfig (an EKS presigned-STS token, an AKS Entra token, DOKS
 * credentials) in a private file deleted afterwards; the values come from the spec; the secrets reach the pods from
 * one Kubernetes Secret; the chart's migrate Job runs as its hook; the app answers `/readyz` and the deployment is
 * ready. The chart renders and lints clean with the pinned Helm for each provider's values (skipped, saying so, when
 * HELM_BIN does not point at Helm 3.19.0). Fakes only: no cloud, no cluster.
 */

let w: KubeWorld;
const d: Partial<Record<KubeProvider, Awaited<ReturnType<typeof deployed>>>> = {};

beforeAll(async () => {
  w = await kubeWorld();
  for (const p of PROVIDERS) d[p] = await deployed(w, kubeSpec(w, p, `k8s-${p === 'digitalocean' ? 'do' : p}`));
}, 300_000);

afterAll(async () => {
  await w?.stop();
});

describe('clusters and node groups per provider (B-10203)', () => {
  it('EKS: the cluster with access entries and the app node group on the private subnets, ACTIVE and ready', async () => {
    const [c] = [...w.aws.eks.clusters.values()];
    expect(c).toMatchObject({ name: 'exprsn-aws-k8s-k8s-aws-cluster', status: 'ACTIVE', roleArn: `arn:aws:iam::${w.aws.account}:role/exprsn-aws-k8s-eks-cluster`, accessConfig: { authenticationMode: 'API', bootstrapClusterCreatorAdminPermissions: true } });
    expect(c!.tags).toMatchObject({ 'exprsn:managed': 'true', 'exprsn:account': 'aws-k8s', 'exprsn:deployment': 'k8s-aws' });
    expect((c!.resourcesVpcConfig.subnetIds as string[]).every((s) => w.aws.subnets.has(s))).toBe(true);
    const groups = [...w.aws.eks.nodegroups.values()];
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ status: 'ACTIVE', instanceTypes: ['m6i.xlarge'], scalingConfig: { minSize: 2, maxSize: 4, desiredSize: 2 }, labels: { 'exprsn.ai/role': 'app' }, amiType: 'AL2023_x86_64_STANDARD' });
    const rows = await w.h.s.cloud.deployments.resources(d.aws!.id);
    expect(rows.filter((r) => ['kubernetes_cluster', 'node_group', 'load_balancer'].includes(r.type)).map((r) => [r.key, r.state])).toEqual([
      ['cluster', 'ready'],
      ['lb', 'ready'],
      ['nodes-app', 'ready']
    ]);
  });

  it('AKS: Entra-only access, application routing, the app pool made with the cluster and adopted, and the deployer as cluster admin', async () => {
    const clusters = [...w.azure.resources.values()].filter((r) => r.type === 'Microsoft.ContainerService/managedClusters');
    expect(clusters).toHaveLength(1);
    const props = clusters[0]!.body.properties as Record<string, unknown>;
    expect(props).toMatchObject({ disableLocalAccounts: true, aadProfile: { managed: true, enableAzureRBAC: true }, ingressProfile: { webAppRouting: { enabled: true } }, provisioningState: 'Succeeded' });
    expect(clusters[0]!.tags).toMatchObject({ 'exprsn:deployment': 'k8s-azure' });
    const pools = [...w.azure.resources.values()].filter((r) => r.type.endsWith('/agentPools'));
    expect(pools.map((p) => p.name)).toEqual(['app']);
    expect(pools[0]!.body.properties).toMatchObject({ vmSize: 'Standard_D4s_v5', enableAutoScaling: true, minCount: 2, maxCount: 4, nodeLabels: { 'exprsn.ai/role': 'app' } });
    // The deployer becomes cluster admin by a role assignment named from the cluster and its principal (the object id
    // in a real Entra token; the fake's tokens are not JWTs, so here there is no principal to assign).
    expect(w.azure.aks.roleAssignments.size).toBe(0);
    const rows = await w.h.s.cloud.deployments.resources(d.azure!.id);
    expect(rows.find((r) => r.key === 'nodes-app')).toMatchObject({ state: 'ready' });
  });

  it('DOKS: the cluster in the app VPC with the app pool (adopted by its step), autoscaled 2 to 4', async () => {
    const [c] = [...w.do.doks.clusters.values()];
    expect(c).toMatchObject({ name: 'exprsn-do-k8s-k8s-do-cluster', state: 'running', ha: false });
    expect(w.do.vpcs.has(c!.vpc_uuid)).toBe(true);
    expect(c!.tags).toEqual(expect.arrayContaining(['exprsn:managed:true', 'exprsn:account:do-k8s', 'exprsn:deployment:k8s-do', 'exprsn:name:k8s-do-cluster']));
    const pools = [...c!.pools.values()];
    expect(pools).toHaveLength(1);
    expect(pools[0]).toMatchObject({ name: 'exprsn-do-k8s-k8s-do-nodes-app', size: 's-4vcpu-8gb', auto_scale: true, min_nodes: 2, max_nodes: 4, labels: { 'exprsn.ai/role': 'app' } });
  });

  it('plans the cluster, its node group and the cluster-made load balancer as built, and a GPU pool as a tainted node group', async () => {
    const spec = kubeSpec(w, 'aws', 'gpu-lab', { gpuPools: [{ name: 'chat', gpu: 'l4', min: 0, max: 2 }] });
    const g = renderGraph(spec, { zones: await w.h.s.zones.current(), corporateCidrs: [] }).resources;
    const by = Object.fromEntries(g.map((r) => [r.key, r]));
    expect(by.cluster!.spec).toMatchObject({ initialPool: { name: 'gpu-lab-nodes-app', count: 2, poolName: 'app' } });
    expect(by['gpu-chat']).toMatchObject({ type: 'node_group', spec: { role: 'gpu', size: 'g6.xlarge', min: 0, max: 2, taints: ['exprsn.ai/gpu=true:NoSchedule'], cluster: 'gpu-lab-cluster' }, dependsOn: expect.arrayContaining(['cluster']) });
    expect(by.lb).toMatchObject({ type: 'load_balancer', spec: { managedBy: 'cluster' } });
  });
});

describe('kubeconfig per provider (B-10203)', () => {
  it('is short-lived, private while it exists, accepted by the cluster, and deleted after each operation', async () => {
    for (const p of PROVIDERS) {
      const calls = helmCalls(w, p, 'upgrade');
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) {
        expect(c.kubeconfig).toMatchObject({ mode: 0o600, server: w.kube[p].url, tokenAccepted: true });
        expect(existsSync(c.kubeconfig!.path)).toBe(false);
      }
      // helm runs with its own environment: nothing of this process (no cloud credential, no secret) reaches it.
      expect(Object.keys(calls[0]!.env).sort()).toEqual(['HELM_CACHE_HOME', 'HELM_CONFIG_HOME', 'HELM_DATA_HOME', 'HELM_NO_PLUGINS', 'HOME', 'LANG', 'PATH']);
    }
    expect(w.kubeconfigs.length).toBeGreaterThanOrEqual(3);
    expect(w.kubeconfigs.some((k) => existsSync(k))).toBe(false);
    // The cluster's API saw only authorized calls from the worker.
    for (const p of PROVIDERS) expect(w.kube[p].requests.length > 0 && w.kube[p].requests.every((r) => r.authorized)).toBe(true);
  });

  it('EKS: a presigned STS GetCallerIdentity with the cluster in a signed header, valid 15 minutes', () => {
    const t = eksToken({ clusterName: 'c1', region: 'eu-central-1', keys: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'x', sessionToken: 'st' }, stsUrl: 'https://sts.eu-central-1.amazonaws.com' });
    expect(t.token.startsWith('k8s-aws-v1.')).toBe(true);
    const u = new URL(Buffer.from(t.token.slice(11), 'base64url').toString('utf8'));
    expect(u.host).toBe('sts.eu-central-1.amazonaws.com');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ Action: 'GetCallerIdentity', 'X-Amz-Expires': '60', 'X-Amz-SignedHeaders': 'host;x-k8s-aws-id', 'X-Amz-Security-Token': 'st' });
    expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(t.expiresAt - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    // A token is never kept: not in the graph, the journal or the audit chain.
    return (async () => {
      for (const table of ['cloud_resources', 'cloud_operations', 'cloud_releases', 'audit_events', 'cloud_deployments']) {
        const rows = await w.h.s.db(table).select('*');
        expect(JSON.stringify(rows)).not.toMatch(/k8s-aws-v1\.|doks-[0-9a-f]{20}|eyJ\.fake-azure/);
      }
    })();
  });

  it('AKS: an Entra token for the AKS server application; DOKS: credentials that end on their own', () => {
    expect(w.azure.aks.credentialReads.length).toBeGreaterThan(0);
    expect([...w.azure.tokens.values()].some((t) => t.scope.startsWith('6dae42f8-4368-4678-94ff-3960e28e3630'))).toBe(true);
    const doTokens = [...w.do.doks.tokens.values()];
    expect(doTokens.length).toBeGreaterThan(0);
    expect(doTokens.every((t) => t.expiresAt - Date.now() <= 10 * 60_000 + 5000)).toBe(true);
  });

  it('deletes the file even when the operation fails', async () => {
    let seen = '';
    await expect(withKubeconfig({ server: 'https://x', caData: null, token: 't', expiresAt: Date.now() + 60_000, clusterName: 'c' }, async (path) => ((seen = path), Promise.reject(new Error('boom'))))).rejects.toThrow('boom');
    expect(existsSync(seen)).toBe(false);
    expect(kubeconfigYaml({ server: 'https://x', caData: 'Q0E=', token: 't', expiresAt: 0, clusterName: 'c' })).toMatch(/certificate-authority-data: Q0E=/);
    await expect(withKubeconfig({ server: 'https://x', caData: null, token: 't', expiresAt: Date.now() - 1, clusterName: 'c' }, async () => 1)).rejects.toThrow(/expired/);
  });
});

describe('values from the spec, the secrets path and the migrate Job (B-10203)', () => {
  it('derives image, replicas, the public URL, the ingress or load balancer and the policies from the spec, with no secret in them', () => {
    for (const p of PROVIDERS) {
      const v = helmCalls(w, p, 'upgrade')[0]!.values!;
      expect(v).toMatchObject({ image: { repository: REPO, digest: DIGEST_A }, replicaCount: 2, config: { publicUrl: `https://k8s-${p === 'digitalocean' ? 'do' : p}.example.com`, kms: { provider: 'local' } }, migrations: { mode: 'job' }, nodeSelector: { 'exprsn.ai/role': 'app' }, podDisruptionBudget: { enabled: true } });
      expect((v.secrets as Record<string, { name: string; key: string }>).DATABASE_URL).toEqual({ name: 'exprsn-ai-secrets', key: 'database_url' });
      expect(JSON.stringify(v)).not.toContain(w.dbUrl);
      expect(JSON.stringify(v)).not.toContain(w.redisUrl);
      expect(JSON.stringify(v)).not.toMatch(/data_key":"[A-Za-z0-9+/]{40}/);
    }
    expect(helmCalls(w, 'aws', 'upgrade')[0]!.values!.ingress).toMatchObject({ enabled: true, className: 'alb', annotations: { 'alb.ingress.kubernetes.io/scheme': 'internet-facing', 'alb.ingress.kubernetes.io/target-type': 'ip' } });
    expect(helmCalls(w, 'azure', 'upgrade')[0]!.values!.ingress).toMatchObject({ enabled: true, className: 'webapprouting.kubernetes.azure.com' });
    expect(helmCalls(w, 'digitalocean', 'upgrade')[0]!.values!).toMatchObject({ ingress: { enabled: false }, service: { type: 'LoadBalancer', annotations: { 'service.beta.kubernetes.io/do-loadbalancer-healthcheck-path': '/readyz' } } });
  });

  it('writes the one Kubernetes Secret from the vault: the session secret, the key, the database and Redis URLs', async () => {
    for (const p of PROVIDERS) {
      const secret = w.kube[p].secret()!;
      expect(Object.keys(secret).sort()).toEqual(['data_key', 'database_url', 'redis_url', 'session_secret']);
      expect(secret).toMatchObject({ database_url: w.dbUrl, redis_url: w.redisUrl });
      expect(secret.session_secret).toMatch(/^[0-9a-f]{64}$/);
      expect(Buffer.from(secret.data_key!, 'base64')).toHaveLength(32);
      expect(w.kube[p].requests.find((r) => r.path.endsWith('/secrets/exprsn-ai-secrets'))).toMatchObject({ method: 'PATCH', contentType: 'application/apply-patch+yaml' });
    }
    // Each deployment has its own key, kept sealed in the vault (made once).
    expect(w.kube.aws.secret()!.data_key).not.toBe(w.kube.azure.secret()!.data_key);
    // With the cloud KMS by workload identity there is no DATA_KEY anywhere: the token is projected by the chart.
    const spec = kubeSpec(w, 'aws', 'kms-lab', { clusterKeys: { provider: 'aws-kms', region: 'eu-central-1', roleArn: `arn:aws:iam::${w.aws.account}:role/exprsn-kms` } });
    const v = chartValues({ spec, provider: 'aws', accountName: 'aws-k8s', image: splitImage(spec.release!.image!), placement: renderGraph(spec, { zones: await w.h.s.zones.current(), corporateCidrs: [] }).network.placement, redis: true });
    expect(v).toMatchObject({ config: { kms: { provider: 'aws-kms' }, extra: { KMS_AWS_ROLE_ARN: `arn:aws:iam::${w.aws.account}:role/exprsn-kms`, KMS_AWS_WEB_IDENTITY_TOKEN_FILE: '/var/run/secrets/exprsn/aws/token' } }, secrets: { DATA_KEY: { name: '' } }, extraVolumes: [{ projected: { sources: [{ serviceAccountToken: { audience: 'sts.amazonaws.com' } }] } }] });
  });

  it('runs the chart’s migrate Job as its pre-install hook', () => {
    for (const p of PROVIDERS) expect(w.kube[p].objects.get('/apis/batch/v1/namespaces/exprsn-ai/jobs/exprsn-ai-migrate')).toMatchObject({ metadata: { annotations: { 'helm.sh/hook': 'pre-install,pre-upgrade' } } });
  });

  it('renders and lints the chart clean with each provider’s values (the pinned Helm)', async (ctx) => {
    const bin = await realHelm();
    if (!bin) {
      ctx.skip(`HELM_BIN does not point at Helm ${HELM_PINNED}: the render and lint checks need it (toolchain/helm/bin/helm; docs/deploy.md).`);
      return;
    }
    const helm = new Helm({ bin, pinned: HELM_PINNED });
    for (const p of PROVIDERS) {
      const values = helmCalls(w, p, 'upgrade')[0]!.values!;
      const lint = await helm.lint({ chart: chartDir(), values, kubeVersion: '1.31.0' });
      expect(lint.ok, lint.output).toBe(true);
      const out = await helm.template({ chart: chartDir(), release: 'exprsn-ai', namespace: 'exprsn-ai', values, kubeVersion: '1.31.0' });
      expect(out).toMatch(/kind: Job[\s\S]*helm.sh\/hook: pre-install,pre-upgrade/);
      expect(out).toContain(`image: ${REPO}@${DIGEST_A}`);
      expect(out).toContain('secretName: exprsn-ai-secrets'.replace('secretName', 'name'));
      expect(out).not.toContain(w.dbUrl);
      if (p === 'digitalocean') expect(out).toMatch(/type: LoadBalancer/);
      else expect(out).toMatch(/kind: Ingress/);
    }
    // The KMS-by-workload-identity values lint clean too.
    const spec = deploymentSpecSchema.parse({ ...kubeSpec(w, 'azure', 'kv-lab'), clusterKeys: { provider: 'azure-keyvault', vaultUrl: 'https://exprsn.vault.azure.net', tenantId: '00000000-0000-4000-8000-000000000001', clientId: '00000000-0000-4000-8000-000000000002' } });
    const v = chartValues({ spec, provider: 'azure', accountName: 'azure-k8s', image: splitImage(spec.release!.image!), placement: renderGraph(spec, { zones: await w.h.s.zones.current(), corporateCidrs: [] }).network.placement, redis: true });
    const lint = await helm.lint({ chart: chartDir(), values: v, kubeVersion: '1.31.0' });
    expect(lint.ok, lint.output).toBe(true);
  }, 120_000);
});

describe('verify answers /readyz (B-10203)', () => {
  it('records the release and the load balancer’s address, and the deployment is ready with the app’s /readyz passing', async () => {
    for (const p of PROVIDERS) {
      const dep = (await w.h.s.cloud.deployments.get(d[p]!.id))!;
      expect(dep.state).toBe('ready');
      expect(dep.health).toBe('healthy');
      expect(dep.verify!.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'app.readyz', status: 'pass' }), expect.objectContaining({ id: 'app.database', status: 'pass' }), expect.objectContaining({ id: 'app.redis', status: 'pass' })]));
      const [rel] = await w.h.s.cloud.releases.list(w.alice.principal, dep.id);
      expect(rel).toMatchObject({ state: 'deployed', reason: 'install', revision: 1, digest: DIGEST_A, repository: REPO });
      expect(rel!.address).toEqual(p === 'digitalocean' ? '203.0.113.10' : expect.stringMatching(/\.lb\.example\.test$/));
      expect((await w.h.s.cloud.deployments.resource(dep.id, 'lb'))!.locator).toMatchObject({ address: rel!.address });
      expect(w.app[p].hits).toBeGreaterThan(0);
    }
    expect(await w.h.s.db('audit_events').where({ action: 'cloud.release.deployed' })).toHaveLength(3);
  });

  it('lists releases over the API and answers 503 without migration 151', async () => {
    const res = await w.alice.client.agent.get(`/api/admin/cloud/deployments/${d.aws!.id}/releases`).expect(200);
    expect(res.body.releases[0]).toMatchObject({ digest: DIGEST_A, state: 'deployed' });
    const dir = mkdtempSync(join(tmpdir(), 'exs-k8s-'));
    try {
      await w.h.s.db.schema.renameTable('cloud_releases', 'cloud_releases_off');
      w.h.s.cloud.releases.reset();
      const off = await w.alice.client.agent.get(`/api/admin/cloud/deployments/${d.aws!.id}/releases`).expect(503);
      expect(off.body.reason).toBe('migration_pending');
    } finally {
      await w.h.s.db.schema.renameTable('cloud_releases_off', 'cloud_releases');
      w.h.s.cloud.releases.reset();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
