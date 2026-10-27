/*
 * 1.9.99-final, Sprint 58 (B-10203, B-10207): the world the Kubernetes and upgrade suites share: a harness with the
 * cloud migrations 148, 149 and 151 applied by hand, the AWS, Azure and DigitalOcean fakes on 127.0.0.1 (each with a
 * fake Kubernetes API for its clusters and a fake app answering `/readyz`), platform accounts on them, two cloud
 * admins, a database URL and a Redis URL in the vault, and `helm` played by `kubeHelm` (the real pinned binary for
 * `version`, `template` and `lint` when `HELM_BIN` points at it). Nothing reaches a real cloud or cluster.
 */
import { existsSync } from 'node:fs';
import { expect } from 'vitest';
import type { Principal } from '../src/authz/policy.js';
import type { CloudActor } from '../src/cloud/accounts.js';
import type { Deployment } from '../src/cloud/graph.js';
import { Helm, HELM_PINNED, type HelmExec } from '../src/cloud/helm.js';
import { ProviderRegistry } from '../src/cloud/providers/registry.js';
import type { AdapterCredential } from '../src/cloud/providers/types.js';
import { renderGraph } from '../src/cloud/render.js';
import { deploymentSpecSchema, type DeploymentSpec, type DeploymentSpecInput } from '../src/cloud/spec.js';
import type { CloudAccount, Provider } from '../src/cloud/types.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { servicePolicy } from '../src/platform/egress.js';
import { seedAccount } from './cloud-credentials-helpers.js';
import { FakeAws } from './fake-aws.js';
import { FakeAzure } from './fake-azure.js';
import { FakeDigitalOcean } from './fake-do.js';
import { FakeApp, FakeKubeCluster, kubeHelm, type HelmCall } from './fake-kube.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';

export const ALLOWED = '127.0.0.1,::1,localhost';
export const DIGEST_A = `sha256:${'a'.repeat(64)}`;
export const DIGEST_B = `sha256:${'b'.repeat(64)}`;
export const REPO = 'ghcr.io/exprsnio/exprsn-ai';
const VALIDATED = { at: Date.now(), ok: true, identity: { ok: true }, features: ['deploy', 'data', 'compute'].map((f) => ({ feature: f, name: f, status: 'ok', required: [], missing: [], reason: null })) };
export const PROVIDERS = ['aws', 'azure', 'digitalocean'] as const;
export type KubeProvider = (typeof PROVIDERS)[number];
const REGION: Record<KubeProvider, string> = { aws: 'eu-central-1', azure: 'westeurope', digitalocean: 'fra1' };

/** The pinned helm, when HELM_BIN names it (the render and lint checks skip without it). */
export async function realHelm(): Promise<string | null> {
  const bin = process.env.HELM_BIN;
  if (!bin || !existsSync(bin)) return null;
  return (await new Helm({ bin, pinned: HELM_PINNED }).available()) ? bin : null;
}

export interface Person extends CloudActor {
  client: Client;
}

export interface KubeWorld {
  h: Harness;
  aws: FakeAws;
  azure: FakeAzure;
  do: FakeDigitalOcean;
  kube: Record<KubeProvider, FakeKubeCluster>;
  app: Record<KubeProvider, FakeApp>;
  accounts: Record<KubeProvider, CloudAccount>;
  helm: Record<KubeProvider, ReturnType<typeof kubeHelm>>;
  /** Every kubeconfig path the deploy worker wrote. */
  kubeconfigs: string[];
  realHelm: string | null;
  alice: Person;
  bob: Person;
  dbUrl: string;
  redisUrl: string;
  stop(): Promise<void>;
}

async function person(h: Harness, name: string): Promise<Person> {
  const u = await localUser(h, name, ['system-admin'], 'restricted');
  const client = await loginAdmin(h, name);
  const p = (await loadPrincipal(h.s, h.tenantId, u.id, {}))!;
  const principal: Principal = { ...p, mfa: true };
  return { principal, ip: '127.0.0.1', client };
}

/** `env`: more settings for the harness (Sprint 60's GPU pools suite gives the signer, for the CA's keys). */
export async function kubeWorld(env: Record<string, string> = {}): Promise<KubeWorld> {
  const h = await harness({ SERVICE_ALLOWED_HOSTS: ALLOWED, ...env });
  if (!(await h.s.db.schema.hasTable('cloud_deployments'))) await (await import('../src/db/migrations/148_cloud_journal.js')).up(h.s.db);
  if (!(await h.s.db.schema.hasTable('cloud_drift_findings'))) await (await import('../src/db/migrations/149_cloud_lifecycle.js')).up(h.s.db);
  if (!(await h.s.db.schema.hasTable('cloud_releases'))) await (await import('../src/db/migrations/151_cloud_releases.js')).up(h.s.db);
  h.s.cloud.deployments.resetSchemaCache();
  h.s.cloud.lifecycle.schema.reset();
  h.s.cloud.releases.reset();
  await h.s.zones.seedDefaults({ userId: 'seed' } as Principal);

  const aws = await new FakeAws().start();
  const azure = await new FakeAzure().start();
  const dof = await new FakeDigitalOcean().start();
  aws.settleAfter = 1;
  azure.settleAfter = 1;
  dof.settleAfter = 1;
  azure.publicOrigin = 'https://management.azure.com';
  const kube = { aws: await new FakeKubeCluster().start(), azure: await new FakeKubeCluster().start(), digitalocean: await new FakeKubeCluster().start() };
  aws.eks.kubeServer = kube.aws.url;
  azure.aks.kubeServer = kube.azure.url;
  dof.doks.kubeServer = kube.digitalocean.url;
  kube.aws.authenticate = (t) => aws.eks.verifyToken(t, aws.keys) === null;
  kube.azure.authenticate = (t) => azure.aks.acceptsToken(t);
  kube.digitalocean.authenticate = (t) => dof.doks.acceptsToken(t);
  const app = { aws: await new FakeApp(kube.aws).start(), azure: await new FakeApp(kube.azure).start(), digitalocean: await new FakeApp(kube.digitalocean).start() };

  const registry = new ProviderRegistry({
    policy: servicePolicy({ SERVICE_ALLOWED_HOSTS: ALLOWED }),
    endpoints: { aws: { sts: aws.url, iam: aws.url, ec2: aws.url, s3: aws.url, route53: aws.url, eks: aws.url, rds: aws.url, elasticache: aws.url, memorydb: aws.url, servicequotas: aws.url, cloudtrail: aws.url }, digitalocean: { api: dof.url } },
    transport: { sleep: async () => undefined, random: () => 0.5, testOrigins: { 'https://management.azure.com': azure.url } }
  });
  Object.defineProperty(h.s.cloud, 'providers', { value: registry, configurable: true });
  // The price catalogue's sources too: every price API is a fake (no call may leave 127.0.0.1).
  h.s.cloud.prices!.setEndpoints({ awsPricing: aws.url, azureRetail: `${azure.url}/api/retail/prices`, digitalocean: dof.url });

  // Credentials: an IAM key, an Entra app with a secret, a DigitalOcean token (the fakes').
  const key = aws.addUser({ userName: 'exprsn-deploy' });
  const tenant = '00000000-0000-4000-8000-00000000a2e5';
  const sub = '00000000-0000-4000-8000-0000000000bb';
  azure.addSubscription(sub, tenant);
  const entra = azure.addApp({ tenantId: tenant, secret: true });
  const doToken = dof.addToken();
  const creds: Record<KubeProvider, AdapterCredential> = {
    aws: { kind: 'aws', accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey, expiresAt: null },
    azure: {
      kind: 'azure',
      tenantId: tenant,
      getToken: async (scope) => {
        const r = await fetch(`${azure.url}/${tenant}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: entra.clientId, client_secret: entra.secret!, scope }) });
        const j = (await r.json()) as { access_token: string; expires_in: number };
        return { token: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
      }
    },
    digitalocean: { kind: 'token', token: doToken }
  };
  (h.s.cloud as { credentials: unknown }).credentials = { for: async (a: { provider: Provider }) => creds[a.provider as KubeProvider] };

  const seed = async (provider: KubeProvider, providerIds: Record<string, string>) => {
    const a = await seedAccount(h, { provider, mode: 'vaulted', name: `${provider === 'digitalocean' ? 'do' : provider}-k8s`, providerIds, refs: { token: 'vault:cloud/k8s#token' } });
    await h.s.db('cloud_accounts').where({ id: a.id }).update({ validation: JSON.stringify(VALIDATED) });
    return (await h.s.cloud.accounts.get(a.id))!;
  };
  const accounts = { aws: await seed('aws', { awsAccountId: aws.account }), azure: await seed('azure', { azureTenantId: tenant, azureSubscriptionId: sub }), digitalocean: await seed('digitalocean', { doTeamId: dof.account.team.uuid }) };

  // helm: one played per cluster, chosen by the kubeconfig's server; the real binary renders and lints.
  const real = await realHelm();
  const helm = { aws: kubeHelm(kube.aws, real), azure: kubeHelm(kube.azure, real), digitalocean: kubeHelm(kube.digitalocean, real) };
  const router: HelmExec = async (bin, args, o) => {
    const i = args.indexOf('--kubeconfig');
    if (i >= 0) {
      const text = (await import('node:fs')).readFileSync(args[i + 1]!, 'utf8');
      for (const p of PROVIDERS) if (text.includes(kube[p].url)) return helm[p](bin, args, o);
    }
    return helm.aws(bin, args, o);
  };
  h.s.cloud.releases.helm = new Helm({ bin: real ?? '/nonexistent/helm', pinned: HELM_PINNED, exec: router });
  const kubeconfigs: string[] = [];
  Object.assign(h.s.cloud.releases.options, { sleep: async () => undefined, addressWaitMs: 0, addressPolls: 3, publicUrlFor: (d: Deployment) => app[d.provider as KubeProvider].url, onKubeconfig: (p: string) => kubeconfigs.push(p) });
  Object.assign(h.s.cloud.releases.upgrades.options, { sleep: async () => undefined, checkWaitMs: 0, snapshotWaitMs: 0 });
  h.s.cloud.engine.options.sleep = async () => undefined;
  h.s.cloud.lifecycle.destroys.options.sleep = async () => undefined;

  const alice = await person(h, 'alice');
  const bob = await person(h, 'bob');
  // The database and Redis URLs, in alice's vault (the spec names them by reference).
  const dbUrl = 'postgres://exprsn:p4ss-not-logged@db.data.internal:5432/exprsn';
  const redisUrl = 'rediss://:r3dis-not-logged@cache.data.internal:6380';
  const send = (path: string, b: object, method: 'post' | 'put' = 'post') => alice.client.agent[method](path).set('x-csrf-token', alice.client.csrf).send(b);
  await send('/api/vault/policies', { subjectKind: 'user', subject: alice.principal.userId, path: '*', capabilities: ['*'] });
  const put = await send('/api/vault/kv/data/apps/deploy', { data: { db: dbUrl, redis: redisUrl } }, 'put');
  expect([200, 201]).toContain(put.status);

  return {
    h,
    aws,
    azure,
    do: dof,
    kube,
    app,
    accounts,
    helm,
    kubeconfigs,
    realHelm: real,
    alice,
    bob,
    dbUrl,
    redisUrl,
    async stop() {
      for (const p of PROVIDERS) {
        await kube[p].stop();
        await app[p].stop();
      }
      await aws.stop();
      await azure.stop();
      await dof.stop();
      await h.close();
    }
  };
}

/** A medium Kubernetes spec on a provider: an existing database and Redis (by reference), a front door brought along. */
export function kubeSpec(w: KubeWorld, provider: KubeProvider, name: string, over: Partial<DeploymentSpecInput> = {}): DeploymentSpec {
  return deploymentSpecSchema.parse({ name, target: { provider, accountId: w.accounts[provider].id, region: REGION[provider] }, compute: { shape: 'kubernetes', size: 'medium' }, data: { mode: 'existing', databaseUrlRef: 'vault:apps/deploy#db', redisUrlRef: 'vault:apps/deploy#redis' }, frontDoor: { kind: 'byo', hostname: `${name}.example.com` }, release: { image: `${REPO}@${DIGEST_A}` }, ...over });
}

/** Runs queued jobs (and the follow-ups of applies that ended) until nothing is left. */
export async function drain(w: KubeWorld): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const ran = await w.h.s.jobs.runDue();
    await w.h.s.cloud.lifecycle.idle();
    if (!ran) {
      const due = await w.h.s.db('jobs').where({ state: 'queued' }).andWhere('run_at', '<=', Date.now()).first();
      if (!due) return;
    }
  }
}

/** Creates the deployment from its spec, plans the rendered graph, applies it and drains every job after it. */
export async function deployed(w: KubeWorld, spec: DeploymentSpec): Promise<Deployment> {
  const s = w.h.s;
  const d = await s.cloud.deployments.create(w.alice, { name: spec.name, accountId: spec.target.accountId, region: spec.target.region, label: spec.label, spec: spec as unknown as Record<string, unknown> });
  const g = renderGraph(spec, { zones: await s.zones.current(), corporateCidrs: [] });
  const plan = await s.cloud.plans.create(w.alice, d.id, g.resources);
  expect(plan.blockers).toEqual([]);
  // Nothing leaves 127.0.0.1: the estimate's price calls reached the fakes, not a real price API.
  expect(plan.note ?? '').not.toMatch(/blocked|refused/);
  expect(plan.applicable).toBe(true);
  await s.cloud.plans.apply(w.alice, plan.id, plan.hash);
  await drain(w);
  expect((await s.cloud.plans.load(plan.id))?.state).toBe('applied');
  return (await s.cloud.deployments.get(d.id))!;
}

/** The helm calls of one kind. */
export const helmCalls = (w: KubeWorld, p: KubeProvider, cmd: string): HelmCall[] => w.helm[p].calls.filter((c) => c.args[0] === cmd);
