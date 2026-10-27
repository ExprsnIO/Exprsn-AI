/**
 * 1.9.99-final, Sprint 62 (B-10706): the cloud state the Cloud accounts, Deployments, Cloud data and Cloud compute
 * screens read, made through the real services against the DigitalOcean fake on 127.0.0.1 (the suite runs offline for
 * the clouds: EXPRSN_TESTS_OFFLINE refuses every real provider host). It adds one platform account `do-lab` (vaulted
 * token, fra1 and ams3) and three deployments rendered from deployment specs and planned by the planner:
 *
 *   nw-lab      applied (VMs, a managed PostgreSQL with deletion protection, a cache, a bucket); a firewall then gains
 *               SSH from anywhere at the fake, so the drift check holds one open field finding
 *   nw-staging  planned, not applied: its open plan is the one the plan review shows
 *   nw-old      applied by the job worker once the server runs, for the destroy with the protected database's approval
 *
 * Zones are not seeded (the Zones spec seeds them through the screen): the graphs are rendered against the default zone
 * set in memory. Nothing here changes server code.
 */
import type { Principal } from '../server/src/authz/policy.js';
import type { CloudActor } from '../server/src/cloud/accounts.js';
import { renderGraph } from '../server/src/cloud/render.js';
import { deploymentSpecSchema } from '../server/src/cloud/spec.js';
import { ProviderRegistry } from '../server/src/cloud/providers/registry.js';
import { loadPrincipal } from '../server/src/http/middleware.js';
import { servicePolicy } from '../server/src/platform/egress.js';
import type { Services } from '../server/src/services.js';
import { DEFAULT_ZONES } from '../server/src/zones/spec.js';
import { FakeDigitalOcean } from '../server/test/fake-do.js';

export const CLOUD_LAB_ACCOUNT = '01JE2EC1DSEEDACC0000000001';
const FEATURES = ['deploy', 'data', 'compute', 'models', 'billing'] as const;

export interface CloudSeed {
  account: string;
  deployments: Record<'lab' | 'staging' | 'old', string>;
  fake: string;
  stop(): Promise<void>;
}

export async function seedCloudScreens(s: Services, o: { tenantId: string; rootId: string; awsUrl?: string }): Promise<CloudSeed> {
  const db = s.db;
  const fake = await new FakeDigitalOcean().start();
  fake.settleAfter = 1;
  const token = fake.addToken();
  // Every DigitalOcean adapter call goes to the fake (the other providers keep their endpoints). Prices stay on the
  // price sheet, as the Pools card's spec expects.
  s.cloud.providers.setEndpoints({ digitalocean: { api: fake.url } });
  // Discovery reads the providers' database APIs itself: DigitalOcean's fake, and the AWS fake for the Bedrock account.
  s.cloud.discovery.setEndpoints({ digitalocean: { api: fake.url }, ...(o.awsUrl ? { aws: { rds: o.awsUrl, dynamodb: o.awsUrl } } : {}) });
  // A cluster Exprsn-AI did not build, for Connect existing (its password is the fake's and never leaves it).
  fake.databases.push({ id: '7d1c2a4e-5b6f-4a70-8c9d-0e1f2a3b4c5d', name: 'finance-archive-pg', engine: 'pg', region: 'fra1', status: 'online', connection: { host: 'finance-archive-pg.db.do.test.internal', port: 25060, user: 'doadmin', password: 'fake-only', database: 'archive', ssl: true }, private_connection: { host: 'private-finance-archive-pg.db.do.test.internal', port: 25060, user: 'doadmin', password: 'fake-only', database: 'archive', ssl: true } });

  const now = Date.now();
  const validation = { at: now, ok: true, identity: { ok: true }, features: FEATURES.map((f) => ({ feature: f, name: f, status: 'ok', required: [], missing: [], reason: null })) };
  await db('cloud_accounts').insert({ id: CLOUD_LAB_ACCOUNT, name: 'do-lab', provider: 'digitalocean', scope: 'platform', tenant_id: null, scope_key: 'platform', provider_ids: JSON.stringify({ doTeamId: fake.account.team.uuid }), credential_mode: 'vaulted', default_region: 'fra1', state: 'active', description: 'Lab deployments for the console suite', validation: JSON.stringify(validation), validated_at: now, created_by: null, created_tenant: o.tenantId, created_at: now, updated_at: now });
  await db('cloud_account_regions').insert([
    { account_id: CLOUD_LAB_ACCOUNT, region: 'fra1', zone: 'cloud-eu', ceiling: 'internal', geo: 'eu', is_default: true, updated_at: now },
    { account_id: CLOUD_LAB_ACCOUNT, region: 'ams3', zone: 'cloud-eu', ceiling: 'internal', geo: 'eu', is_default: false, updated_at: now }
  ]);
  await db('cloud_credentials').insert({ account_id: CLOUD_LAB_ACCOUNT, mode: 'vaulted', params: '{}', refs: JSON.stringify({ token: 'vault:cloud/do-lab#token' }), updated_by: null, updated_at: now });
  const creds = s.cloud.credentials!;
  const prior = creds.for.bind(creds);
  creds.for = async (a, purpose) => (a.id === CLOUD_LAB_ACCOUNT ? { kind: 'token', token } : prior(a, purpose));
  s.cloud.accounts.resetSchemaCache?.();

  const p = (await loadPrincipal(s, o.tenantId, o.rootId, {}))!;
  const actor: CloudActor = { principal: { ...p, mfa: true } as Principal, ip: '127.0.0.1' };
  const zones = new Map(DEFAULT_ZONES.map((z) => [z.id, { version: 1, spec: structuredClone(z.spec) }]));

  const drain = async () => {
    for (let i = 0; i < 60; i++) {
      const ran = await s.jobs.runDue();
      await s.cloud.lifecycle.idle?.();
      if (!ran) {
        const due = await db('jobs').where({ state: 'queued' }).andWhere('run_at', '<=', Date.now()).first();
        if (!due) return;
      }
    }
  };

  // The release VMs install (the installer checks its sha256; nothing is fetched here: the fake runs no cloud-init).
  const release = { version: '1.0.0', tarball: { url: 'https://releases.northwind-example.com/exprsn-ai-1.0.0.tar.gz', sha256: 'a3f1c2d4e5b60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00' } };
  const deploy = async (name: string, host: string, apply: 'drain' | 'queue' | false): Promise<string> => {
    const spec = deploymentSpecSchema.parse({ name, target: { provider: 'digitalocean', accountId: CLOUD_LAB_ACCOUNT, region: 'fra1' }, compute: { shape: 'vm', size: 'small' }, frontDoor: { kind: 'byo', hostname: host }, release });
    const g = renderGraph(spec, { zones, corporateCidrs: [] });
    const d = await s.cloud.deployments.create(actor, { name, accountId: CLOUD_LAB_ACCOUNT, region: 'fra1', label: spec.label, spec: spec as unknown as Record<string, unknown> });
    // DigitalOcean's Spaces bucket is not built yet (its capability is `not_yet`): leave out what the adapter cannot
    // create, and what depends on it, so the plan is applicable.
    let desired = g.resources;
    let plan = await s.cloud.plans.create(actor, d.id, desired);
    // A standalone load balancer (VMs) is not built yet either; the apply would stop there.
    const out = new Set(plan.steps.filter((x) => x.unavailable || x.type === 'load_balancer').map((x) => x.key));
    if (out.size) {
      for (let grew = true; grew; ) {
        grew = false;
        for (const r of desired) if (!out.has(r.key) && (r.dependsOn.some((k) => out.has(k)) || (r.network && out.has(r.network)))) (out.add(r.key), (grew = true));
      }
      desired = desired.filter((r) => !out.has(r.key));
      plan = await s.cloud.plans.create(actor, d.id, desired);
    }
    if (!plan.applicable) throw new Error(`${name}: ${plan.blockers.join('; ')}`);
    if (apply) {
      await s.cloud.plans.apply(actor, plan.id, plan.hash);
      if (apply === 'drain') await drain();
    }
    return d.id;
  };

  // The fake settles at once: no poll waits and no rate-limit pacing while seeding (a registry of its own, as the
  // unit tests use; the server's registry and the engine's sleep are put back afterwards).
  const sleep = s.cloud.engine.options.sleep;
  s.cloud.engine.options.sleep = async () => undefined;
  const registry = s.cloud.providers;
  const quick = new ProviderRegistry({ policy: servicePolicy(s.cfg), endpoints: { digitalocean: { api: fake.url } }, transport: { sleep: async () => undefined, random: () => 0.5 } });
  Object.defineProperty(s.cloud, 'providers', { value: quick, configurable: true, writable: true });
  const lab = await deploy('nw-lab', 'lab.ai.northwind-example.com', 'drain');
  const staging = await deploy('nw-staging', 'staging.ai.northwind-example.com', false);
  const old = await deploy('nw-old', 'old.ai.northwind-example.com', 'queue');

  // Out of band, at the provider: SSH from anywhere on one of nw-lab's firewalls; the drift check finds it.
  const graph = await s.cloud.deployments.graph(actor.principal, lab);
  const fw = (graph as { resources: { type: string; providerId: string | null }[] }).resources.find((r) => r.type === 'firewall' && r.providerId && fake.firewalls.has(r.providerId));
  if (fw) {
    fake.firewalls.get(fw.providerId!)!.inbound_rules.push({ protocol: 'tcp', ports: '22', sources: { addresses: ['0.0.0.0/0'] } });
    await s.cloud.lifecycle.drift.detect((await s.cloud.deployments.get(lab))!);
  }
  s.cloud.engine.options.sleep = sleep;
  Object.defineProperty(s.cloud, 'providers', { value: registry, configurable: true, writable: true });
  return { account: CLOUD_LAB_ACCOUNT, deployments: { lab, staging, old }, fake: fake.url, stop: () => fake.stop() };
}
