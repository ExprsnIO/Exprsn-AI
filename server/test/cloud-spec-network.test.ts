import type request from 'supertest';
import { ulid } from 'ulid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '../src/authz/policy.js';
import type { DesiredResource } from '../src/cloud/graph.js';
import { publicDataProblems, renderNetwork } from '../src/cloud/network.js';
import { AWS_CAPABILITIES, AZURE_CAPABILITIES, DO_CAPABILITIES } from '../src/cloud/providers/capabilities.js';
import { supportOf } from '../src/cloud/providers/registry.js';
import { graphProblems, renderGraph, unavailableIn } from '../src/cloud/render.js';
import { deploymentSpecSchema, PROVIDER_SKUS, SIZE_PRESETS, validateSpec, type DeploymentSpec, type DeploymentSpecInput } from '../src/cloud/spec.js';
import type { CloudFeature, Provider } from '../src/cloud/types.js';
import { renderNftables, type RenderZone } from '../src/zones/render.js';
import { DEFAULT_ZONES, type ZoneSpec } from '../src/zones/spec.js';
import { FakeAws } from './fake-aws.js';
import { FakeAzure } from './fake-azure.js';
import { FakeDigitalOcean } from './fake-do.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';

/*
 * 1.9.99-final, Sprint 57 (B-10201, B-10202): the deployment spec (schema, presets, validation before any provider
 * call), the network foundation rendered from the zone specs (the cloud firewalls equal the zone's nftables rules, per
 * provider), no data resource with a public address, and unsupported types shown as unavailable. Fakes only.
 */

const DEPLOYMENTS = '/api/admin/cloud/deployments';
const CORPORATE = ['192.168.10.0/24'];

interface Api {
  get(p: string): request.Test;
  post(p: string, b?: object): request.Test;
}

async function signIn(h: Harness, name: string, roles: string[]): Promise<Api> {
  await localUser(h, name, roles, 'restricted');
  const c = await loginAdmin(h, name);
  return { get: (p) => c.agent.get(p), post: (p, b = {}) => c.agent.post(p).set('x-csrf-token', c.csrf).send(b) };
}

const FEATURES: Record<Provider, CloudFeature[]> = { aws: ['deploy', 'data', 'compute', 'models', 'billing'], azure: ['deploy', 'data', 'compute', 'models', 'billing'], digitalocean: ['deploy', 'data', 'compute', 'models', 'billing'], cloudflare: ['frontdoor', 'apptier', 'data', 'models', 'billing'] };

/** An active platform account with a passing validation report, written to the tables directly. */
async function seedAccount(h: Harness, o: { name: string; provider: Provider; regions: { region: string; zone: string; geo: string; ceiling?: string }[]; ids: Record<string, unknown>; missing?: Partial<Record<CloudFeature, string[]>> }): Promise<string> {
  const id = ulid();
  const t = Date.now();
  const validation = { at: t, ok: !o.missing, identity: { ok: true }, features: FEATURES[o.provider].map((f) => ({ feature: f, name: f, status: o.missing?.[f] ? 'missing' : 'ok', required: [], missing: o.missing?.[f] ?? [], reason: null })) };
  await h.s.db('cloud_accounts').insert({ id, name: o.name, provider: o.provider, scope: 'platform', tenant_id: null, scope_key: 'platform', provider_ids: JSON.stringify(o.ids), credential_mode: 'vaulted', default_region: o.regions[0]!.region, state: 'active', description: null, validation: JSON.stringify(validation), validated_at: t, created_by: null, created_tenant: h.tenantId, created_at: t, updated_at: t });
  for (const r of o.regions) await h.s.db('cloud_account_regions').insert({ account_id: id, region: r.region, zone: r.zone, ceiling: r.ceiling ?? 'internal', geo: r.geo, is_default: r === o.regions[0], updated_at: t });
  await h.s.db('cloud_credentials').insert({ account_id: id, mode: 'vaulted', params: '{}', refs: JSON.stringify({ token: 'vault:cloud/test#token' }), updated_by: null, updated_at: t });
  return id;
}

const zoneMap = (): Map<string, { version: number; spec: ZoneSpec }> => new Map(DEFAULT_ZONES.map((z) => [z.id, { version: 1, spec: structuredClone(z.spec) }]));

const spec = (over: Partial<DeploymentSpecInput> & { target: DeploymentSpecInput['target'] }): DeploymentSpec =>
  deploymentSpecSchema.parse({ name: 'lab', compute: { shape: 'kubernetes', size: 'medium' }, frontDoor: { kind: 'acme', hostname: 'ai.example.com', zone: 'example.com' }, ...over });

/** The rules an nftables table renders, as (chain, label) → { cidrs, ports }. */
function nftRules(text: string): Map<string, { cidrs: string[]; ports: number[] }> {
  const out = new Map<string, { cidrs: string[]; ports: number[] }>();
  let chain = '';
  for (const line of text.split('\n')) {
    const c = /chain (input|output)/.exec(line);
    if (c) chain = c[1]!;
    const m = /^\s+ip6? [sd]addr \{ ([^}]+) \}(?: tcp dport \{ ([^}]+) \})? accept comment "([^"]+)"/.exec(line);
    if (!m) continue;
    const key = `${chain}|${m[3]}`;
    const prev = out.get(key) ?? { cidrs: [], ports: [] };
    prev.cidrs.push(...m[1]!.split(', '));
    if (m[2]) prev.ports = m[2].split(', ').map(Number);
    out.set(key, prev);
  }
  return out;
}

/** The same rules from a cloud firewall's ingress and egress (one rule per port, merged back by label). */
function cloudRules(fw: { ingress: { protocol: string; ports?: string; sources: string[]; description?: string }[]; egress: { protocol: string; ports?: string; destinations: string[]; description?: string }[] }): Map<string, { cidrs: string[]; ports: number[] }> {
  const out = new Map<string, { cidrs: string[]; ports: number[] }>();
  const add = (chain: string, label: string, cidrs: string[], port?: string) => {
    const key = `${chain}|${label}`;
    const prev = out.get(key) ?? { cidrs: [...cidrs], ports: [] };
    if (port) prev.ports.push(Number(port));
    out.set(key, prev);
  };
  for (const r of fw.ingress) add('input', r.description!, r.sources, r.ports);
  for (const r of fw.egress) add('output', r.description!, r.destinations, r.ports);
  return out;
}

const sorted = (m: Map<string, { cidrs: string[]; ports: number[] }>) => new Map([...m].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, { cidrs: [...v.cidrs].sort(), ports: [...v.ports].sort((x, y) => x - y) }]));

describe('deployment spec and presets (B-10201)', () => {
  it('parses a minimal spec with its defaults; the presets size up to HA', () => {
    const s = spec({ target: { provider: 'aws', accountId: ulid(), region: 'eu-central-1' } });
    expect(s.label).toBe('internal');
    expect(s.data).toEqual({ mode: 'provision', engine: 'postgres', cache: true });
    expect(s.zones).toEqual({ edge: 'edge', app: 'app', data: 'data', inference: 'inference' });
    expect(s.network.cidr).toBe('10.64.0.0/16');
    expect(s.gpuPools).toEqual([]);
    expect(SIZE_PRESETS.small).toMatchObject({ ha: false, azs: 1, app: { replicas: 1 } });
    expect(SIZE_PRESETS.medium).toMatchObject({ ha: false, azs: 2, app: { replicas: 2 } });
    expect(SIZE_PRESETS.large).toMatchObject({ ha: true, azs: 3, app: { replicas: 3 }, database: { ha: true }, cache: { ha: true } });
    expect(PROVIDER_SKUS.aws.app.large).toBe('m6i.2xlarge');
    expect(PROVIDER_SKUS.digitalocean.gpu.a10).toBeNull();
  });

  it('refuses malformed specs in the schema', () => {
    const base = { name: 'lab', target: { provider: 'aws', accountId: ulid(), region: 'eu-central-1' }, compute: { shape: 'vm', size: 'small' }, frontDoor: { kind: 'byo', hostname: 'ai.example.com' } };
    expect(deploymentSpecSchema.safeParse(base).success).toBe(true);
    expect(deploymentSpecSchema.safeParse({ ...base, target: { ...base.target, provider: 'cloudflare' } }).success).toBe(false);
    expect(deploymentSpecSchema.safeParse({ ...base, compute: { shape: 'vm', size: 'huge' } }).success).toBe(false);
    expect(deploymentSpecSchema.safeParse({ ...base, network: { cidr: 'not-a-cidr' } }).success).toBe(false);
    expect(deploymentSpecSchema.safeParse({ ...base, data: { mode: 'existing', databaseUrlRef: 'postgres://user:pw@db/x' } }).success).toBe(false);
    expect(deploymentSpecSchema.safeParse({ ...base, data: { mode: 'existing', databaseUrlRef: 'vault:cloud/db#url' } }).success).toBe(true);
    expect(deploymentSpecSchema.safeParse({ ...base, gpuPools: Array.from({ length: 5 }, (_, i) => ({ name: `p${i}`, gpu: 'l4' })) }).success).toBe(false);
    expect(deploymentSpecSchema.safeParse({ ...base, extra: true }).success).toBe(false);
  });
});

describe('network foundation from the zone specs (B-10202)', () => {
  for (const provider of ['aws', 'azure', 'digitalocean'] as const) {
    it(`renders ${provider} firewalls whose rules equal the zone's rules`, () => {
      const zones = zoneMap();
      const s = spec({ target: { provider, accountId: ulid(), region: provider === 'aws' ? 'eu-central-1' : provider === 'azure' ? 'westeurope' : 'fra1' }, compute: { shape: 'kubernetes', size: 'large' }, gpuPools: provider === 'azure' ? [{ name: 'chat', gpu: 'a10', max: 2 }] : [{ name: 'chat', gpu: 'h100', max: 2 }] });
      const g = renderGraph(s, { zones, corporateCidrs: CORPORATE });
      const fwZones = g.network.firewalls.map((f) => f.zone).sort();
      expect(fwZones).toEqual(['app', 'data', 'edge', 'inference']);
      for (const fw of g.network.firewalls) {
        const z = g.network.context.zones.get(fw.zone)!;
        // The cloud firewall equals the nftables table rendered for the zone's hosts, rule for rule.
        expect(sorted(cloudRules(fw))).toEqual(sorted(nftRules(renderNftables(z, g.network.context))));
        // And it carries exactly the zone spec's rules: itself, then each accepted source, and its egress allow-list.
        const spec0 = zones.get(fw.zone)!.spec;
        const labels = new Set(fw.ingress.map((r) => r.description));
        for (const t of spec0.accepts) {
          const label = `from ${t.kind === 'zone' ? t.zone : t.kind === 'cidr' ? t.cidr : 'corporate network'}`;
          expect(labels.has(label)).toBe(true);
          expect(fw.ingress.filter((r) => r.description === label).map((r) => Number(r.ports)).sort()).toEqual(t.ports.length ? [...t.ports].sort((a, b) => a - b) : [NaN]);
        }
        expect(labels.size).toBe(1 + spec0.accepts.length);
        expect(fw.egressDenied).toBe(spec0.egress.mode === 'deny');
        if (spec0.egress.mode === 'deny') expect(fw.egress.map((r) => r.description)).toEqual([`within ${fw.zone}`]);
      }
      // The data zone accepts the app's subnets on 5432 and 6379 only.
      const data = g.network.firewalls.find((f) => f.zone === 'data')!;
      const fromApp = data.ingress.filter((r) => r.description === 'from app');
      expect(fromApp.map((r) => r.ports).sort()).toEqual(['5432', '6379']);
      expect(fromApp[0]!.sources).toEqual(g.network.placement.app!.cidrs);
      // The deployed zones' addresses come out of the deployment's network; an undeployed zone keeps its own.
      for (const t of ['edge', 'app', 'data', 'inference'] as const) for (const c of g.network.placement[t]!.cidrs) expect(c.startsWith('10.64.')).toBe(true);
      expect(g.network.context.zones.get('directory')!.spec.cidrs).toEqual(['10.31.0.0/24']);
      if (provider === 'digitalocean') {
        expect(g.resources.filter((r) => r.type === 'subnet')).toEqual([]);
        expect(g.resources.filter((r) => r.type === 'network').map((r) => r.key).sort()).toEqual(['net-app', 'net-data', 'net-edge', 'net-inference']);
      } else {
        expect(g.resources.filter((r) => r.type === 'subnet')).toHaveLength(4 * 3);
        expect(g.resources.find((r) => r.key === 'net')!.spec).toMatchObject({ cidr: '10.64.0.0/16' });
      }
    });
  }

  it('keeps a zone that renders no CIDR rule out of the firewall, as nftables does', () => {
    const g = renderNetwork({ spec: spec({ target: { provider: 'aws', accountId: ulid(), region: 'eu-central-1' } }), provider: 'aws', region: 'eu-central-1', zones: zoneMap(), corporateCidrs: [] });
    const edge = g.firewalls.find((f) => f.zone === 'edge')!;
    expect(edge.ingress.map((r) => r.description)).toEqual(['within edge']); // corporate network unset: nothing admitted
    expect(nftRules(renderNftables(g.context.zones.get('edge') as RenderZone, g.context)).has('input|from corporate network')).toBe(false);
  });

  it('places no data resource at a public address; the check finds one that does', () => {
    const g = renderGraph(spec({ target: { provider: 'aws', accountId: ulid(), region: 'eu-central-1' } }), { zones: zoneMap(), corporateCidrs: CORPORATE });
    expect(graphProblems(g.resources)).toEqual([]);
    const db = g.resources.find((r) => r.type === 'database')!;
    expect(db).toMatchObject({ protect: true, network: 'net', spec: { publicAccess: false, privateEndpoint: true } });
    for (const k of db.spec.subnets as string[]) expect(g.resources.find((r) => r.key === k)!.spec).toMatchObject({ private: true, public: false, exprsnZone: 'data' });
    expect(g.resources.find((r) => r.key.startsWith('subnet-edge'))!.spec).toMatchObject({ public: true }); // the load balancer's
    const edgeSubnet = g.resources.find((r) => r.key.startsWith('subnet-edge'))!.key;
    const mutate = (f: (r: DesiredResource[]) => void) => {
      const copy = structuredClone(g.resources);
      f(copy);
      return publicDataProblems(copy);
    };
    expect(mutate((r) => (r.find((x) => x.key === 'db')!.spec.publicAccess = true))).toEqual(['db (database) does not turn public access off.']);
    expect(mutate((r) => (r.find((x) => x.key === 'cache')!.spec.subnets = [edgeSubnet]))).toEqual([`cache (cache) is placed in ${edgeSubnet}, a public subnet.`]);
    expect(mutate((r) => delete r.find((x) => x.key === 'db')!.network)).toEqual(['db (database) is not placed in a private network.']);
    expect(mutate((r) => (r.find((x) => x.key === 'blobs')!.spec.publicAccess = undefined))).toEqual(['blobs (bucket) does not turn public access off.']);
    // A Cloudflare front door dials out through a tunnel: no public subnet at all.
    const cf = renderGraph(spec({ target: { provider: 'aws', accountId: ulid(), region: 'eu-central-1' }, frontDoor: { kind: 'cloudflare', accountId: ulid(), hostname: 'ai.example.com', zone: 'example.com' } }), { zones: zoneMap(), corporateCidrs: CORPORATE });
    expect(cf.resources.filter((r) => r.type === 'subnet' && r.spec.public)).toEqual([]);
    expect(cf.frontDoor).toMatchObject({ planned: false, resources: [{ key: 'tunnel', type: 'tunnel' }, { key: 'dns-app', type: 'dns_record', spec: { proxied: true, record: 'ai' } }] });
  });

  it('shows the types an adapter does not build as unavailable, never as an error', () => {
    const tables = { aws: AWS_CAPABILITIES, azure: AZURE_CAPABILITIES, digitalocean: DO_CAPABILITIES };
    for (const provider of ['aws', 'azure', 'digitalocean'] as const) {
      const g = renderGraph(spec({ target: { provider, accountId: ulid(), region: 'x' } }), { zones: zoneMap(), corporateCidrs: CORPORATE });
      const u = unavailableIn(g.resources, (t) => supportOf(tables[provider], t, 'create'), (t) => tables[provider][t].note);
      const keys = u.map((x) => x.key);
      // Sprint 59 (B-10301, B-10305): the managed database and the cache are built everywhere.
      for (const key of ['db', 'cache']) expect(keys).not.toContain(key);
      // Sprint 58 (B-10203): the cluster, its node groups and the cluster-made load balancer are built everywhere.
      for (const key of ['cluster', 'nodes-app', 'lb']) expect(keys).not.toContain(key);
      expect(u.every((x) => x.support === 'not_yet' && x.reason.length > 0)).toBe(true);
      // The network foundation is built everywhere.
      for (const r of g.resources.filter((x) => ['network', 'subnet', 'firewall'].includes(x.type))) expect(keys).not.toContain(r.key);
      if (provider === 'digitalocean') expect(keys).toContain('blobs');
    }
  });
});

describe('validation and the deployment routes (B-10201)', () => {
  let h: Harness;
  let sys: Api;
  let operator: Api;
  let aws: string;
  let cf: string;
  let azure: string;
  const fakes = { aws: new FakeAws(), azure: new FakeAzure(), digitalocean: new FakeDigitalOcean() };
  const credCalls: string[] = [];
  const allRequests = () => fakes.aws.requests.length + fakes.azure.requests.length + fakes.digitalocean.requests.length;

  beforeAll(async () => {
    await Promise.all(Object.values(fakes).map((f) => f.start()));
    h = await harness({ SERVICE_ALLOWED_HOSTS: '127.0.0.1' });
    if (!(await h.s.db.schema.hasTable('cloud_deployments'))) await (await import('../src/db/migrations/148_cloud_journal.js')).up(h.s.db);
    if (!(await h.s.db.schema.hasTable('cloud_prices'))) await (await import('../src/db/migrations/150_cloud_prices.js')).up(h.s.db);
    (h.s.cloud as { deployments?: { resetSchemaCache(): void } }).deployments?.resetSchemaCache();
    h.s.cloud.accounts.resetSchemaCache();
    // Every provider call would land on a fake and be counted; none is expected before validation passes.
    h.s.cloud.providers.setEndpoints({ aws: { sts: fakes.aws.url, iam: fakes.aws.url, ec2: fakes.aws.url, s3: fakes.aws.url, route53: fakes.aws.url, eks: fakes.aws.url, ecs: fakes.aws.url, elbv2: fakes.aws.url, secretsmanager: fakes.aws.url, rds: fakes.aws.url, elasticache: fakes.aws.url, memorydb: fakes.aws.url, cloudtrail: fakes.aws.url }, azure: { arm: fakes.azure.url }, digitalocean: { api: fakes.digitalocean.url } });
    h.s.cloud.prices!.setEndpoints({ awsPricing: fakes.aws.url, azureRetail: `${fakes.azure.url}/api/retail/prices`, digitalocean: fakes.digitalocean.url });
    (h.s.cloud as { credentials: unknown }).credentials = { for: async (a: { name: string }, purpose: string) => (credCalls.push(`${a.name}:${purpose}`), { kind: 'token', token: 'stub-token-not-real', accountId: null }) };
    await h.s.zones.seedDefaults({ userId: 'seed' } as Principal);
    aws = await seedAccount(h, { name: 'aws-lab', provider: 'aws', ids: { awsAccountId: '123456789012' }, regions: [{ region: 'eu-central-1', zone: 'cloud-eu', geo: 'eu' }, { region: 'us-east-1', zone: 'cloud-us', geo: 'us' }] });
    azure = await seedAccount(h, { name: 'azure-lab', provider: 'azure', ids: { azureTenantId: '00000000-0000-4000-8000-000000000001', azureSubscriptionId: '00000000-0000-4000-8000-000000000002' }, regions: [{ region: 'westeurope', zone: 'cloud-eu', geo: 'eu', ceiling: 'restricted' }], missing: { compute: ['Microsoft.Compute/virtualMachines/write'] } });
    cf = await seedAccount(h, { name: 'cf-edge', provider: 'cloudflare', ids: { cloudflareAccountId: '0123456789abcdef0123456789abcdef' }, regions: [{ region: 'global', zone: 'edge', geo: 'global' }] });
    sys = await signIn(h, 'root', ['system-admin']);
    operator = await signIn(h, 'ops', ['cloud-operator']);
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    await Promise.all(Object.values(fakes).map((f) => f.stop()));
  });

  beforeEach(() => {
    for (const f of Object.values(fakes)) f.reset();
    credCalls.length = 0;
  });

  const body = (over: Record<string, unknown> = {}) => ({ name: 'lab', target: { provider: 'aws', accountId: aws, region: 'eu-central-1' }, compute: { shape: 'kubernetes', size: 'medium' }, frontDoor: { kind: 'acme', hostname: 'ai.example.com', zone: 'example.com' }, ...over });
  const principal = async (): Promise<Principal> => ({ kind: 'user', userId: 'root-user', tenantId: h.tenantId, tenantSlug: h.s.cfg.DEFAULT_TENANT, username: 'root', displayName: 'root', roles: ['system-admin'], clearance: 'restricted', scopes: null, sessionId: null, apiKeyId: null, mfa: true });

  it('refuses a region outside the allow-list before any provider call', async () => {
    const res = await sys.post(DEPLOYMENTS, body({ target: { provider: 'aws', accountId: aws, region: 'us-west-2' } })).expect(403);
    expect(res.headers['content-type']).toMatch(/problem\+json/);
    expect(res.body).toMatchObject({ step: 'zone', check: 'region', reason: 'placement_refused' });
    expect(res.body.detail).toMatch(/us-west-2 is not on aws-lab's allow-list/);
    expect(allRequests()).toBe(0);
    expect(credCalls).toEqual([]);
    expect(await h.s.db('cloud_deployments').count({ n: '*' }).first()).toMatchObject({ n: 0 });
    // The dry run says the same, and calls nothing either.
    const dry = await sys.post(`${DEPLOYMENTS}/validate-spec`, body({ target: { provider: 'aws', accountId: aws, region: 'us-west-2' } })).expect(200);
    expect(dry.body.valid).toBe(false);
    expect(dry.body.problems).toEqual([expect.objectContaining({ path: 'target.region', check: 'region' })]);
    expect(allRequests()).toBe(0);
  });

  it('is platform-only: cloud:deploy alone is refused', async () => {
    const res = await operator.post(DEPLOYMENTS, body()).expect(403);
    expect(res.body).toMatchObject({ step: 'role' });
    await operator.post(`${DEPLOYMENTS}/validate-spec`, body()).expect(403);
    expect(allRequests()).toBe(0);
  });

  it('checks label ceilings, residency, zone ceilings, permissions and the front door', async () => {
    const p = await principal();
    const v = (over: Record<string, unknown>) => validateSpec(h.s, p, deploymentSpecSchema.parse(body(over)));
    // The region's ceiling (internal) refuses confidential data.
    const conf = await v({ label: 'confidential' });
    expect(conf.problems).toEqual([expect.objectContaining({ path: 'label', check: expect.stringMatching(/ceiling|residency/) })]);
    // Azure's region is raised to restricted, but the inference zone holds at most confidential, and compute is missing.
    const az = await v({ target: { provider: 'azure', accountId: azure, region: 'westeurope' }, label: 'restricted', gpuPools: [{ name: 'chat', gpu: 'a10' }] });
    const checks = az.problems.map((x) => `${x.path}:${x.check}`);
    expect(checks).toContain('zones.inference:ceiling');
    expect(checks).toContain('target.accountId:permission');
    // A GPU the provider does not offer.
    const l4 = await v({ target: { provider: 'azure', accountId: azure, region: 'westeurope' }, gpuPools: [{ name: 'chat', gpu: 'l4' }] });
    expect(l4.problems.map((x) => `${x.path}:${x.check}`)).toContain('gpuPools.0.gpu:offer');
    // A Cloudflare front door caps the deployment at confidential, and its hostname must be in its zone.
    const fd = await v({ target: { provider: 'azure', accountId: azure, region: 'westeurope' }, label: 'restricted', frontDoor: { kind: 'cloudflare', accountId: cf, hostname: 'ai.other.org', zone: 'example.com' } });
    expect(fd.problems.map((x) => `${x.path}:${x.check}`)).toEqual(expect.arrayContaining(['frontDoor.kind:ceiling', 'frontDoor.hostname:front_door']));
    // The wrong provider, and a provider-account mismatch.
    expect((await v({ target: { provider: 'azure', accountId: aws, region: 'eu-central-1' } })).problems.map((x) => x.check)).toContain('provider');
    // On-prem data must be reachable by the app zone's egress, as the zone spec says.
    const onprem = await v({ data: { mode: 'onprem', cidrs: ['172.20.0.0/24'] } });
    expect(onprem.problems).toEqual([expect.objectContaining({ path: 'data.cidrs.0', check: 'zone' })]);
    expect((await v({ data: { mode: 'onprem', cidrs: ['10.31.0.0/24'] } })).valid).toBe(true); // the directory zone the app may reach
    // A valid one resolves its account and region.
    const ok = await v({});
    expect(ok).toMatchObject({ valid: true, problems: [], resolved: { account: { name: 'aws-lab' }, region: { region: 'eu-central-1', ceiling: 'internal' } } });
    expect(allRequests()).toBe(0);
  });

  it('validate-spec renders the graph, the firewalls, the unavailable types and an estimate, calling nothing', async () => {
    const res = await sys.post(`${DEPLOYMENTS}/validate-spec`, body({ gpuPools: [{ name: 'chat', gpu: 'l4', max: 2 }] })).expect(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.firewalls.map((f: { zone: string }) => f.zone).sort()).toEqual(['app', 'data', 'edge', 'inference']);
    // Sprint 59 (B-10301, B-10305): the data tier is built on AWS, so nothing of this spec is unavailable.
    expect(res.body.unavailable.map((u: { key: string }) => u.key)).not.toContain('db');
    expect(res.body.unavailable.map((u: { key: string }) => u.key)).not.toContain('cluster');
    expect(res.body.estimate.monthly).toBeGreaterThan(0);
    expect(res.body.estimate.prices.every((p: { date: string; source: string }) => /^\d{4}-\d{2}-\d{2}$/.test(p.date) && p.source === 'price-sheet')).toBe(true);
    expect(allRequests()).toBe(0);
    expect(credCalls).toEqual([]);
  });

  it('creates the deployment from a valid spec and returns the plan the planner made from the rendered graph', async () => {
    const plans = (h.s.cloud as { plans?: unknown }).plans;
    const seen: DesiredResource[][] = [];
    // The planner is the engine's (refreshes through the adapters); here it records the graph it was given.
    (h.s.cloud as { plans?: unknown }).plans = { create: async (_a: unknown, deploymentId: string, desired: DesiredResource[]) => (seen.push(desired), { id: 'plan-1', deploymentId, desired, steps: [], applicable: false, estimate: await h.s.cloud.estimatePlan!({ id: 'p', deploymentId, desired, steps: [], purpose: 'apply' } as never) }) };
    try {
      const res = await sys.post(DEPLOYMENTS, body({ name: 'lab-one' })).expect(201);
      expect(res.body.deployment).toMatchObject({ name: 'lab-one', provider: 'aws', region: 'eu-central-1', label: 'internal', state: 'draft', spec: { compute: { shape: 'kubernetes', size: 'medium' } } });
      expect(seen[0]!.map((r) => r.key)).toEqual(expect.arrayContaining(['net', 'fw-app', 'fw-data', 'fw-edge', 'cluster', 'db', 'cache', 'blobs', 'lb', 'dns-app']));
      expect(res.body.plan.estimate).toMatchObject({ currency: 'USD', assumptions: { hours: 730, storageGb: 100, egressGb: 500 } });
      expect(res.body.firewalls).toHaveLength(3);
      const audit = await h.s.db('audit_events').where({ action: 'cloud.deployment.spec' }).first();
      expect(audit).toBeTruthy();
      // The name is now taken.
      const again = await sys.post(`${DEPLOYMENTS}/validate-spec`, body({ name: 'lab-one' })).expect(200);
      expect(again.body.problems).toEqual([expect.objectContaining({ path: 'name', check: 'name' })]);
    } finally {
      (h.s.cloud as { plans?: unknown }).plans = plans;
    }
  });

  it('plans through the engine: every rendered type plans (the data tier since Sprint 59); the plan carries the estimate', async () => {
    const key = fakes.aws.addUser({ userName: 'exprsn-deploy' });
    (h.s.cloud as { credentials: unknown }).credentials = { for: async (a: { name: string; provider: string }, purpose: string) => (credCalls.push(`${a.name}:${purpose}`), { kind: 'aws', accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey, expiresAt: null }) };
    fakes.aws.setPrice('AmazonEC2', 'm6i.xlarge', 'eu-central-1', '0.2140000000', '2026-10-01');
    if (![...fakes.aws.zones.values()].some((z) => z.Name === 'example.com.')) fakes.aws.addZone('example.com');
    const res = await sys.post(DEPLOYMENTS, body({ name: 'lab-two' })).expect(201);
    const plan = res.body.plan;
    // Sprint 59 (B-10301, B-10305): the database and the cache are built on AWS, so nothing is unavailable.
    const unavailable = plan.steps.filter((x: { unavailable?: unknown }) => x.unavailable).map((x: { key: string }) => x.key);
    expect(unavailable).toEqual([]);
    expect(plan.steps.find((x: { key: string }) => x.key === 'db')).toMatchObject({ action: 'create', type: 'database' });
    expect(plan.steps.filter((x: { key: string }) => x.key === 'net' || x.key.startsWith('fw-') || x.key.startsWith('subnet-')).every((x: { action: string; unavailable?: unknown }) => x.action === 'create' && !x.unavailable)).toBe(true);
    expect(plan.estimate).toMatchObject({ currency: 'USD', delta: plan.estimate.monthly, before: 0 });
    const ec2 = plan.estimate.prices.find((p: { sku: string }) => p.sku === 'ec2:m6i.xlarge');
    expect(ec2).toMatchObject({ price: 0.214, source: 'aws-price-list', date: '2026-10-01', region: 'eu-central-1' });
    expect(fakes.aws.calls('pricing:GetProducts').length).toBeGreaterThan(0);
  }, 60_000);
});
