import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cacheCompatibility, cacheProblems, dataTierPath, normalisePolicy, observedCompatibility, readinessWord, redisCompatibility, redisUrl } from '../src/cloud/caches.js';
import { CloudVault } from '../src/cloud/cloud-vault.js';
import type { DesiredResource, GraphResource } from '../src/cloud/graph.js';
import { AwsProvider, AzureProvider, DigitalOceanProvider, type AdapterCredential, type CallContext, type CloudProvider, type OperationResult, type ResourceSpec, type SecretBinding } from '../src/cloud/providers/index.js';
import { ProviderRegistry } from '../src/cloud/providers/registry.js';
import { renderGraph } from '../src/cloud/render.js';
import { deploymentSpecSchema, type DeploymentSpec } from '../src/cloud/spec.js';
import { cloudTags } from '../src/cloud/tags.js';
import type { CloudAccount, Provider } from '../src/cloud/types.js';
import { createLogger } from '../src/observability/index.js';
import { Bus } from '../src/platform/bus.js';
import { servicePolicy } from '../src/platform/egress.js';
import { DEFAULT_ZONES, type ZoneSpec } from '../src/zones/spec.js';
import { ALLOWED, drain, kubeWorld, type KubeWorld } from './cloud-kubernetes-helpers.js';
import { FakeAws } from './fake-aws.js';
import { FakeAzure } from './fake-azure.js';
import { FakeDigitalOcean } from './fake-do.js';
import { FakeRedis } from './sprint22-fakes.js';
import { harness, type Harness } from './helpers.js';

/*
 * 1.9.99-final, Sprint 59 (B-10305): managed caches as REDIS_URL, against the AWS, Azure and DigitalOcean fakes on
 * 127.0.0.1 (never a real cloud). Per provider: the cache is created with cluster mode off, maxmemory-policy
 * noeviction and TLS; its URL is rediss:// with the token from the vault (ElastiCache: the AUTH token Exprsn-AI chose
 * and handed over through the secret broker; Azure: the listKeys key; DigitalOcean: the generated password). A cache
 * in cluster mode or with an evicting policy is refused with the reason by the planner, by the adapter and when it is
 * wired as REDIS_URL, and /readyz reports a running Redis that does not suit BullMQ and the bus.
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const policy = servicePolicy({ SERVICE_ALLOWED_HOSTS: '127.0.0.1' });
const transport = { sleep: async () => undefined, random: () => 0.5, maxRetryWaitMs: 60_000 };
const zones = (): Map<string, { version: number; spec: ZoneSpec }> => new Map(DEFAULT_ZONES.map((z) => [z.id, { version: 1, spec: structuredClone(z.spec) }]));
const REGION: Record<Provider, string> = { aws: 'eu-central-1', azure: 'westeurope', digitalocean: 'fra1', cloudflare: 'global' };
const TOKEN = 'a'.repeat(32) + 'b'.repeat(32);

function spec(provider: 'aws' | 'azure' | 'digitalocean', name = 'lab'): DeploymentSpec {
  return deploymentSpecSchema.parse({ name, target: { provider, accountId: '01JA0000000000000000000000', region: REGION[provider] }, compute: { shape: 'kubernetes', size: 'small' }, frontDoor: { kind: 'byo', hostname: 'ai.example.test' }, release: { image: `ghcr.io/exprsn/exprsn-ai@sha256:${'a'.repeat(64)}` } });
}
const cacheOf = (s: DeploymentSpec) => renderGraph(s, { zones: zones(), corporateCidrs: [] }).resources.find((r) => r.type === 'cache')!;
const account = (provider: CloudAccount['provider'], name: string, ids: CloudAccount['providerIds']): CloudAccount => ({ id: `acc-${name}`, name, provider, scope: 'platform', tenantId: null, providerIds: ids, credentialMode: 'vaulted', defaultRegion: REGION[provider], state: 'active', description: null, regions: [], validation: null, createdBy: null, createdAt: 0, updatedAt: 0 });

const broker = { value: async (b: SecretBinding) => (b.name === 'cache_auth_token' ? TOKEN : `value-of-${b.name}`), wrap: async () => null };

function specOf(r: DesiredResource, name: string, networkId?: string): ResourceSpec {
  const refs = Object.fromEntries(r.dependsOn.map((k) => [k, `id-${k}`]));
  return { type: r.type, name, idempotencyKey: `${name}-step`, tags: cloudTags({ account: 'lab', deployment: 'lab' }), parent: { ...(networkId ? { networkId } : {}), refs }, props: r.spec as never };
}

const settle = async (p: CloudProvider, ctx: CallContext, r: OperationResult, rounds = 30) => {
  if (r.done) return r.resource;
  for (let i = 0; i < rounds; i++) {
    const s = await p.poll(ctx, JSON.parse(JSON.stringify(r.operation)));
    if (s.state === 'succeeded') return s.resource;
    if (s.state === 'failed') throw Object.assign(new Error(s.error), { code: s.code });
  }
  throw new Error('still pending');
};

const azureCred = (fake: FakeAzure, tenant: string): AdapterCredential => {
  const app = fake.addApp({ tenantId: tenant, secret: true });
  return {
    kind: 'azure',
    tenantId: tenant,
    getToken: async (scope) => {
      const r = await fetch(`${fake.url}/${tenant}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: app.clientId, client_secret: app.secret!, scope }) });
      const j = (await r.json()) as { access_token: string; expires_in: number };
      return { token: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
    }
  };
};

// ---------------------------------------------------------------- the rules

describe('the compatibility rules BullMQ and the bus need (B-10305)', () => {
  it('refuses cluster mode, an evicting policy, plain connections and public access, each with the reason', () => {
    expect(cacheCompatibility({ clusterMode: false, evictionPolicy: 'noeviction', tls: true, publicAccess: false })).toEqual([]);
    const all = cacheCompatibility({ clusterMode: true, evictionPolicy: 'allkeys-lru', tls: false, publicAccess: true });
    expect(all.map((p) => p.code)).toEqual(['cluster_mode', 'eviction_policy', 'tls_off', 'public_access']);
    expect(all[0]!.reason).toMatch(/CROSSSLOT/);
    expect(all[1]!.reason).toBe('maxmemory-policy is allkeys-lru: under memory pressure Redis would evict queued jobs, their locks and the shared counters without an error; set it to noeviction.');
    expect(cacheCompatibility({ service: 'memorydb' })[0]).toMatchObject({ code: 'cluster_mode', reason: expect.stringMatching(/MemoryDB always runs in cluster mode/) });
    // Provider spellings: DigitalOcean's underscores, Azure Managed Redis's NoEviction.
    expect(['ALLKEYS_LRU', 'allkeys_lru', 'AllKeysLRU', 'NoEviction', 'volatile-ttl'].map(normalisePolicy)).toEqual(['allkeys-lru', 'allkeys-lru', 'allkeys-lru', 'noeviction', 'volatile-ttl']);
    // Unknown is not a problem (a provider that does not report a field).
    expect(cacheCompatibility({ clusterMode: null, evictionPolicy: null })).toEqual([]);
  });

  it('renders the cache cluster mode off, noeviction and TLS on every provider; the planner refuses one that is not', () => {
    for (const p of ['aws', 'azure', 'digitalocean'] as const) {
      const c = cacheOf(spec(p));
      expect(c.spec).toMatchObject({ clusterMode: false, evictionPolicy: 'noeviction', tls: true, publicAccess: false, service: { aws: 'elasticache', azure: 'azure-cache', digitalocean: 'do-valkey' }[p] });
      expect(cacheProblems([c])).toEqual([]);
    }
    const c = cacheOf(spec('aws'));
    const evicting = { ...c, spec: { ...c.spec, evictionPolicy: 'allkeys-lru' } };
    expect(cacheProblems([evicting])).toEqual(['cache: refused as REDIS_URL (eviction_policy): maxmemory-policy is allkeys-lru: under memory pressure Redis would evict queued jobs, their locks and the shared counters without an error; set it to noeviction.']);
    expect(cacheProblems([{ ...c, spec: { ...c.spec, clusterMode: true } }])[0]).toMatch(/^cache: refused as REDIS_URL \(cluster_mode\)/);
    expect(cacheProblems([{ ...c, spec: { ...c.spec, service: 'memorydb' } }])[0]).toMatch(/MemoryDB always runs in cluster mode/);
    // The app's URL is always rediss://, its token percent-encoded.
    expect(redisUrl({ host: 'h.example', port: 6380, token: 'k/ey+=', username: null })).toBe('rediss://:k%2Fey%2B%3D@h.example:6380');
    expect(redisUrl({ host: 'h.example', port: 25061, token: 'pw', username: 'default' })).toBe('rediss://default:pw@h.example:25061');
  });
});

// ---------------------------------------------------------------- the adapters

describe('caches on the fakes (B-10305)', () => {
  const aws = new FakeAws();
  const az = new FakeAzure();
  const dof = new FakeDigitalOcean();
  const tenant = '00000000-0000-4000-8000-0000000000c5';
  const sub = '00000000-0000-4000-8000-0000000000c6';
  let pa: AwsProvider;
  let pz: AzureProvider;
  let pd: DigitalOceanProvider;
  let ca: CallContext;
  let cz: CallContext;
  let cd: CallContext;

  beforeAll(async () => {
    await aws.start();
    await az.start();
    await dof.start();
    aws.settleAfter = 1;
    dof.settleAfter = 1;
    az.publicOrigin = 'https://management.azure.com';
    az.addSubscription(sub, tenant);
    const key = aws.addUser({ userName: 'exprsn' });
    pa = new AwsProvider({ policy, ...transport, endpoints: { sts: aws.url, elasticache: aws.url, memorydb: aws.url } });
    ca = { account: account('aws', 'lab', { awsAccountId: aws.account }), cred: { kind: 'aws', accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey, expiresAt: null }, region: 'eu-central-1', secrets: broker };
    pz = new AzureProvider({ policy, ...transport, testOrigins: { 'https://management.azure.com': az.url } });
    cz = { account: account('azure', 'lab', { azureTenantId: tenant, azureSubscriptionId: sub }), cred: azureCred(az, tenant), region: 'westeurope', secrets: broker };
    pd = new DigitalOceanProvider({ policy, ...transport, endpoints: { api: dof.url } });
    cd = { account: account('digitalocean', 'lab', { doTeamId: 'team' }), cred: { kind: 'token', token: dof.addToken() }, region: 'fra1', secrets: broker };
  });
  afterAll(async () => {
    await aws.stop();
    await az.stop();
    await dof.stop();
  });

  it('ElastiCache: a replication group with cluster mode off, the vault token as AUTH, TLS, and the account’s noeviction parameter group', async () => {
    expect(pa.supports('cache', 'create')).toBe('built');
    const s = specOf(cacheOf(spec('aws')), 'lab-cache');
    const o = await settle(pa, ca, await pa.create(ca, s));
    expect(o).toMatchObject({ type: 'cache', state: 'ready', providerId: 'exprsn-lab-lab-cache', props: { service: 'elasticache', clusterMode: false, evictionPolicy: 'noeviction', tls: true, authToken: true, publicAccess: false, port: 6379 } });
    const g = aws.caches.groups.get(o!.providerId)!;
    expect(g).toMatchObject({ clusterEnabled: false, tls: true, authToken: TOKEN, members: ['exprsn-lab-lab-cache-001'], subnetGroup: expect.stringMatching(/^exprsn-lab-lab-cache-subnets$/) });
    expect(aws.caches.paramGroups.get(g.paramGroup)!.params['maxmemory-policy']).toBe('noeviction');
    expect(g.paramGroup).not.toMatch(/^default\./);
    expect(aws.caches.subnetGroups.get(g.subnetGroup!)).toEqual(s.props && (s.props as { subnets: string[] }).subnets.map((k) => `id-${k}`));
    expect(g.securityGroups).toEqual([`id-${(s.props as { firewall: string }).firewall}`]);
    expect(g.tags).toMatchObject({ 'exprsn:managed': 'true', 'exprsn:account': 'lab', 'exprsn:name': 'lab-cache' });
    // The token went to ElastiCache only: never in the observed state.
    expect(JSON.stringify(o)).not.toContain(TOKEN);
    // A retried create adopts what is there (no second CreateReplicationGroup).
    const again = await pa.create(ca, s);
    expect(again).toMatchObject({ done: true, adopted: true });
    expect(aws.calls('elasticache:CreateReplicationGroup')).toHaveLength(1);
    // Its address for REDIS_URL: no token from the provider (it is Exprsn-AI's own, in the vault).
    const access = await pa.cacheAccess(ca, o!);
    expect(access).toEqual({ host: `master.${o!.providerId}.abc123.euc1.cache.amazonaws.com`, port: 6379, username: null, token: null });
    expect(redisUrl({ ...access, token: TOKEN })).toBe(`rediss://:${TOKEN}@${access.host}:6379`);
  });

  it('ElastiCache: an evicting or clustered cache is refused before anything is created; one made by hand is reported incompatible; MemoryDB is listed and refused', async () => {
    const base = cacheOf(spec('aws'));
    const before = aws.calls('elasticache:CreateReplicationGroup').length;
    await expect(pa.create(ca, specOf({ ...base, spec: { ...base.spec, evictionPolicy: 'allkeys-lru' } }, 'evicting'))).rejects.toMatchObject({ code: 'cache_incompatible', message: expect.stringMatching(/maxmemory-policy is allkeys-lru/) });
    await expect(pa.create(ca, specOf({ ...base, spec: { ...base.spec, clusterMode: true } }, 'sharded'))).rejects.toMatchObject({ code: 'cache_incompatible' });
    expect(aws.calls('elasticache:CreateReplicationGroup')).toHaveLength(before);
    aws.caches.addGroup({ id: 'legacy-sessions', policy: 'allkeys-lru' });
    const legacy = await pa.describe(ca, { type: 'cache', providerId: 'legacy-sessions' });
    expect(legacy!.props).toMatchObject({ evictionPolicy: 'allkeys-lru', clusterMode: false });
    expect(observedCompatibility(legacy!).map((p) => p.code)).toEqual(['eviction_policy']);
    aws.caches.addMemoryDb('mem-sessions');
    const listed = await pa.list(ca, 'cache');
    const mem = listed.find((x) => x.props.service === 'memorydb')!;
    expect(mem).toMatchObject({ providerId: 'mem-sessions', props: { clusterMode: true } });
    expect(observedCompatibility(mem)[0]!.reason).toMatch(/MemoryDB always runs in cluster mode/);
    await expect(pa.create(ca, specOf({ ...base, spec: { ...base.spec, service: 'memorydb' } }, 'mem'))).rejects.toMatchObject({ code: 'cache_incompatible' });
  });

  it('Azure Cache for Redis: TLS only, public access off with a private endpoint, noeviction, the access key from listKeys', async () => {
    expect(pz.supports('cache', 'create')).toBe('built');
    const s = specOf(cacheOf(spec('azure')), 'lab-cache');
    const o = await settle(pz, cz, await pz.create(cz, s));
    expect(o).toMatchObject({ type: 'cache', state: 'ready', props: { service: 'azure-cache', clusterMode: false, evictionPolicy: 'noeviction', tls: true, publicAccess: false, port: 6380, privateEndpoint: expect.stringMatching(/\/privateEndpoints\/exprsn-lab-lab-cache-pe$/) } });
    const put = az.calls(/arm:PUT Microsoft\.Cache\/redis/).at(-1)!;
    const body = JSON.parse(put.body) as { properties: Record<string, unknown> };
    expect(body.properties).toMatchObject({ enableNonSslPort: false, minimumTlsVersion: '1.2', publicNetworkAccess: 'Disabled', redisConfiguration: { 'maxmemory-policy': 'noeviction' }, sku: { name: 'Basic', family: 'C', capacity: 1 } });
    const pe = JSON.parse(az.calls(/arm:PUT Microsoft\.Network\/privateEndpoints/).at(-1)!.body) as { properties: { subnet: { id: string }; privateLinkServiceConnections: { properties: { groupIds: string[]; privateLinkServiceId: string } }[] } };
    expect(pe.properties.subnet.id).toMatch(/^id-/);
    expect(pe.properties.privateLinkServiceConnections[0]!.properties).toMatchObject({ groupIds: ['redisCache'], privateLinkServiceId: o!.providerId });
    const access = await pz.cacheAccess(cz, o!);
    expect(access).toMatchObject({ host: 'exprsn-lab-lab-cache.redis.cache.windows.net', port: 6380, username: null });
    expect(access.token).toBe(az.caches.keys.get(o!.providerId.toLowerCase()));
    expect(JSON.stringify(o)).not.toContain(access.token!);
  });

  it('Azure Managed Redis: the NoCluster policy and NoEviction on port 10000', async () => {
    const c = cacheOf(spec('azure'));
    const s = specOf({ ...c, spec: { ...c.spec, size: 'Balanced_B1', service: 'azure-managed-redis' } }, 'lab-amr');
    const o = await settle(pz, cz, await pz.create(cz, s));
    expect(o).toMatchObject({ state: 'ready', props: { service: 'azure-managed-redis', clusterMode: false, evictionPolicy: 'noeviction', tls: true, port: 10000 } });
    const db = JSON.parse(az.calls(/arm:PUT Microsoft\.Cache\/redisEnterprise\/databases/).at(-1)!.body) as { properties: Record<string, unknown> };
    expect(db.properties).toEqual({ clientProtocol: 'Encrypted', port: 10000, clusteringPolicy: 'NoCluster', evictionPolicy: 'NoEviction' });
    expect((await pz.cacheAccess(cz, o!)).port).toBe(10000);
  });

  it('DigitalOcean Managed Valkey: in the VPC, the eviction policy set to noeviction once online, the generated password read back', async () => {
    expect(pd.supports('cache', 'create')).toBe('built');
    const s = specOf(cacheOf(spec('digitalocean')), 'lab-cache', 'vpc-uuid-1');
    const o = await settle(pd, cd, await pd.create(cd, s));
    expect(o).toMatchObject({ type: 'cache', state: 'ready', props: { service: 'do-valkey', engine: 'valkey', clusterMode: false, evictionPolicy: 'noeviction', tls: true, publicAccess: false, networkId: 'vpc-uuid-1' } });
    const c = dof.caches.clusters.get(o!.providerId)!;
    expect(c).toMatchObject({ engine: 'valkey', private_network_uuid: 'vpc-uuid-1', eviction_policy: 'noeviction' });
    expect(c.tags).toEqual(expect.arrayContaining(['exprsn:managed:true', 'exprsn:account:lab', 'exprsn:name:lab-cache']));
    expect(dof.calls('PUT /databases/{id}/eviction_policy')).toHaveLength(1); // DigitalOcean's default evicts
    const access = await pd.cacheAccess(cd, o!);
    expect(access).toEqual({ host: `private-${c.name}-do-user-1.f.db.ondigitalocean.com`, port: 25061, username: 'default', token: (c.private_connection as { password: string }).password });
    expect(JSON.stringify(o)).not.toContain(access.token!);
    expect(redisUrl({ ...access, token: access.token! })).toMatch(/^rediss:\/\/default:AVNS_[^@]+@private-/);
  });
});

// ---------------------------------------------------------------- through the services

describe('a deployment’s cache wired as REDIS_URL (B-10305)', () => {
  let w: KubeWorld;
  beforeAll(async () => {
    w = await kubeWorld();
    // The cache adapters' endpoints too: nothing may leave 127.0.0.1.
    const registry = new ProviderRegistry({ policy: servicePolicy({ SERVICE_ALLOWED_HOSTS: ALLOWED }), endpoints: { aws: { sts: w.aws.url, iam: w.aws.url, ec2: w.aws.url, s3: w.aws.url, route53: w.aws.url, eks: w.aws.url, elasticache: w.aws.url, memorydb: w.aws.url }, digitalocean: { api: w.do.url } }, transport: { sleep: async () => undefined, random: () => 0.5, testOrigins: { 'https://management.azure.com': w.azure.url } } });
    Object.defineProperty(w.h.s.cloud, 'providers', { value: registry, configurable: true });
  });
  afterAll(async () => w?.stop());

  const graph = (cache: Record<string, unknown> = {}): DesiredResource[] => [
    { key: 'net', type: 'network', spec: { cidr: '10.64.0.0/16' }, dependsOn: [], protect: false, region: null },
    { key: 'sub', type: 'subnet', spec: { cidr: '10.64.1.0/24', zone: 'eu-central-1a', private: true }, dependsOn: [], network: 'net', protect: false, region: null },
    { key: 'fw', type: 'firewall', spec: { ingress: [] }, dependsOn: [], network: 'net', protect: false, region: null },
    { key: 'cache', type: 'cache', spec: { engine: 'redis', service: 'elasticache', size: 'cache.t4g.small', ha: false, clusterMode: false, evictionPolicy: 'noeviction', tls: true, publicAccess: false, privateEndpoint: true, subnets: ['sub'], firewall: 'fw', ...cache }, dependsOn: ['sub', 'fw'], network: 'net', protect: false, region: null }
  ];

  it('applies an ElastiCache cache with the generated AUTH token and wires rediss:// with that token into the vault only', async () => {
    const s = w.h.s;
    const d = await s.cloud.deployments.create(w.alice, { name: 'cachelab', accountId: w.accounts.aws.id, region: 'eu-central-1', label: 'internal' });
    const plan = await s.cloud.plans.create(w.alice, d.id, graph());
    expect(plan.blockers).toEqual([]);
    await s.cloud.plans.apply(w.alice, plan.id, plan.hash);
    await drain(w);
    expect((await s.cloud.plans.load(plan.id))?.state).toBe('applied');
    const row = (await s.cloud.deployments.resources(d.id)).find((r) => r.key === 'cache')!;
    expect(row.state).toBe('ready');
    const group = w.aws.caches.groups.get(row.providerId!)!;
    // The token was generated once into the vault (platform scope) and handed to ElastiCache through the broker.
    const vault = new CloudVault(() => s);
    const stored = await vault.readAll(dataTierPath(d.id));
    expect(stored.cache_auth_token).toMatch(/^[0-9a-f]{64}$/);
    expect(group.authToken).toBe(stored.cache_auth_token);
    expect(JSON.stringify(row)).not.toContain(stored.cache_auth_token);
    const journal = await s.db('cloud_operations').where({ deployment_id: d.id });
    expect(JSON.stringify(journal)).not.toContain(stored.cache_auth_token);

    const wired = await s.cloud.caches.wire((await s.cloud.deployments.get(d.id))!, row, w.alice);
    expect(wired.ref).toBe(`vault:${dataTierPath(d.id)}#redis_url`);
    const after = await vault.readAll(dataTierPath(d.id));
    expect(after.redis_url).toBe(`rediss://:${stored.cache_auth_token}@master.${row.providerId}.abc123.euc1.cache.amazonaws.com:6379`);
    const audit = await s.db('audit_events').where({ action: 'cloud.cache.wired' });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(stored.cache_auth_token);
  });

  it('refuses an evicting cache in the plan and at apply, and an observed one as REDIS_URL, with the reason', async () => {
    const s = w.h.s;
    const d = await s.cloud.deployments.create(w.alice, { name: 'evicting', accountId: w.accounts.aws.id, region: 'eu-central-1', label: 'internal' });
    const plan = await s.cloud.plans.create(w.alice, d.id, graph({ evictionPolicy: 'allkeys-lru' }));
    expect(plan.applicable).toBe(false);
    expect(plan.blockers).toContain('cache: refused as REDIS_URL (eviction_policy): maxmemory-policy is allkeys-lru: under memory pressure Redis would evict queued jobs, their locks and the shared counters without an error; set it to noeviction.');
    await expect(s.cloud.plans.apply(w.alice, plan.id, plan.hash)).rejects.toMatchObject({ status: 409 });
    // A cache someone made by hand with an evicting policy is refused when it is wired as REDIS_URL.
    w.aws.caches.addGroup({ id: 'by-hand', policy: 'volatile-lru' });
    const observed = (await s.cloud.providers.providerFor('aws').describe({ account: w.accounts.aws, cred: await s.cloud.credentials!.for(w.accounts.aws, 'read') as AdapterCredential, region: 'eu-central-1' }, { type: 'cache', providerId: 'by-hand' }))!;
    const row = { id: 'r', deploymentId: d.id, key: 'cache', type: 'cache', region: 'eu-central-1', providerId: 'by-hand', locator: null, desired: graph()[3]!, observed, observedHash: null, observedAt: Date.now(), dependsOn: [], protect: false, tags: {}, state: 'ready', createdByOperation: null, createdByAudit: null, lastVerified: null, createdAt: 0, updatedAt: 0 } as GraphResource;
    await expect(s.cloud.caches.wire(d, row, w.alice)).rejects.toMatchObject({ status: 409, extensions: { reason: 'cache_incompatible', problems: [{ code: 'eviction_policy' }] } });
    const refused = await s.db('audit_events').where({ action: 'cloud.cache.refused' });
    expect(refused).toHaveLength(1);
    expect(JSON.parse(refused[0].detail).problems[0].reason).toMatch(/maxmemory-policy is volatile-lru/);
  });
});

// ---------------------------------------------------------------- readiness

describe('/readyz reports a Redis that does not suit BullMQ and the bus (B-10305)', () => {
  let h: Harness;
  const redis = new FakeRedis();
  beforeAll(async () => {
    await redis.start();
    h = await harness();
  });
  afterAll(async () => {
    await h?.close();
    await redis.stop();
  });

  it('reads cluster mode and maxmemory-policy over INFO from a running Redis', async () => {
    redis.infoSections = { cluster: '# Cluster\r\ncluster_enabled:1\r\n', memory: '# Memory\r\nused_memory:1000\r\nmaxmemory_policy:allkeys-lru\r\n' };
    const bus = new Bus(createLogger('silent', false), `redis://127.0.0.1:${redis.port}`);
    try {
      const c = await bus.compatibility(0);
      expect(c).toMatchObject({ clusterMode: true, evictionPolicy: 'allkeys-lru' });
      expect(c!.problems.map((p) => p.code)).toEqual(['cluster_mode', 'eviction_policy']);
      expect(readinessWord(c)).toBe('incompatible: cluster mode, maxmemory-policy allkeys-lru');
      redis.infoSections = { cluster: 'cluster_enabled:0\r\n', memory: 'maxmemory_policy:noeviction\r\n' };
      expect(readinessWord(await bus.compatibility(0))).toBe('ok');
      // Cached a minute: a probe does not ask every time.
      redis.infoSections = { memory: 'maxmemory_policy:volatile-lru\r\n' };
      expect(readinessWord(await bus.compatibility())).toBe('ok');
    } finally {
      await bus.close();
    }
  });

  it('reports `incompatible: ...` in checks.redis without failing readiness, and `ok` for a suitable one', async () => {
    const s = h.s;
    const health = s.bus.health.bind(s.bus);
    const compat = s.bus.compatibility.bind(s.bus);
    s.bus.health = async () => ({ ok: true, detail: 'ok' });
    try {
      s.bus.compatibility = async () => redisCompatibility({ info: async (section) => (section === 'memory' ? 'maxmemory_policy:allkeys-lru\r\n' : 'cluster_enabled:0\r\n') });
      const r = await request(h.app).get('/readyz').expect(200);
      expect(r.body.checks.redis).toBe('incompatible: maxmemory-policy allkeys-lru');
      s.bus.compatibility = async () => redisCompatibility({ info: async (section) => (section === 'memory' ? 'maxmemory_policy:noeviction\r\n' : 'cluster_enabled:0\r\n') });
      expect((await request(h.app).get('/readyz').expect(200)).body.checks.redis).toBe('ok');
    } finally {
      s.bus.health = health;
      s.bus.compatibility = compat;
    }
  });
});
