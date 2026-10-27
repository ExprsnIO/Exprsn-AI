import { ulid } from 'ulid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DesiredResource, Plan } from '../src/cloud/graph.js';
import { CloudPrices, presetSkus, sheetPrice, sheetPrices, usageOf, type Estimate } from '../src/cloud/prices.js';
import { renderGraph } from '../src/cloud/render.js';
import { deploymentSpecSchema, type DeploymentSpec, type DeploymentSpecInput } from '../src/cloud/spec.js';
import type { CloudAccount, Provider } from '../src/cloud/types.js';
import { DEFAULT_ZONES, type ZoneSpec } from '../src/zones/spec.js';
import { FakeAws } from './fake-aws.js';
import { FakeAzure } from './fake-azure.js';
import { FakeDigitalOcean } from './fake-do.js';
import { harness, type Harness } from './helpers.js';

/*
 * 1.9.99-final, Sprint 57 (B-10601): the price catalogue against the fakes (AWS Price List `GetProducts`, the Azure
 * Retail Prices API, DigitalOcean `/v2/sizes`) and the maintained price sheet; the daily cache and its refresh job;
 * estimates with their assumptions and dated prices; the upgrade delta; the currency. Never a real price API.
 */

const zones = (): Map<string, { version: number; spec: ZoneSpec }> => new Map(DEFAULT_ZONES.map((z) => [z.id, { version: 1, spec: structuredClone(z.spec) }]));

const account = (provider: Provider, name: string, extra: Partial<CloudAccount> & { billingCurrency?: string } = {}): CloudAccount => ({
  id: ulid(),
  name,
  provider,
  scope: 'platform',
  tenantId: null,
  providerIds: {},
  credentialMode: 'vaulted',
  defaultRegion: null,
  state: 'active',
  description: null,
  regions: [],
  validation: null,
  createdBy: null,
  createdAt: 0,
  updatedAt: 0,
  ...extra
});

const spec = (over: Partial<DeploymentSpecInput> & { target: DeploymentSpecInput['target'] }): DeploymentSpec =>
  deploymentSpecSchema.parse({ name: 'lab', compute: { shape: 'kubernetes', size: 'medium' }, frontDoor: { kind: 'acme', hostname: 'ai.example.com', zone: 'example.com' }, ...over });

const graph = (s: DeploymentSpec): DesiredResource[] => renderGraph(s, { zones: zones(), corporateCidrs: [] }).resources;

describe('the price sheet', () => {
  it('dates and sources every entry, in USD', () => {
    const all = sheetPrices();
    expect(all.length).toBeGreaterThan(40);
    for (const p of all) {
      expect(p.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.ref).toMatch(/^https:\/\/(aws\.amazon\.com|pricing\.us-east-1\.amazonaws\.com|azure\.microsoft\.com|prices\.azure\.com|www\.digitalocean\.com|docs\.digitalocean\.com|www\.cloudflare\.com|developers\.cloudflare\.com)\//);
      expect(p.currency).toBe('USD');
      expect(p.source).toBe('price-sheet');
      expect(Number.isFinite(p.price) && p.price >= 0).toBe(true);
    }
    // What has no API: DigitalOcean databases, Cloudflare plans.
    expect(sheetPrice('digitalocean', 'do-db:db-s-2vcpu-4gb', 'month', 'fra1')).toMatchObject({ price: 60.9, source: 'price-sheet' });
    expect(sheetPrice('cloudflare', 'cf:zone-pro', 'month', 'global')).toMatchObject({ price: 25 });
    // Every preset SKU has a fallback in the sheet.
    for (const p of ['aws', 'azure', 'digitalocean'] as const) {
      for (const sku of presetSkus(p)) {
        const unit = p === 'digitalocean' && !sku.includes('gpu') ? 'month' : 'hour';
        expect(sheetPrice(p, sku, unit, 'x'), `${p} ${sku}`).not.toBeNull();
      }
    }
  });
});

describe('price sources, cache and estimates (B-10601)', () => {
  let h: Harness;
  let prices: CloudPrices;
  let clock = Date.parse('2026-10-20T08:00:00Z');
  const fakes = { aws: new FakeAws(), azure: new FakeAzure(), digitalocean: new FakeDigitalOcean() };
  let awsKey: { accessKeyId: string; secretAccessKey: string };
  let doToken: string;
  const aws = account('aws', 'aws-lab');
  const azure = account('azure', 'azure-lab');
  const doAcc = account('digitalocean', 'do-lab');

  beforeAll(async () => {
    await Promise.all(Object.values(fakes).map((f) => f.start()));
    h = await harness({ SERVICE_ALLOWED_HOSTS: '127.0.0.1' });
    if (!(await h.s.db.schema.hasTable('cloud_prices'))) await (await import('../src/db/migrations/150_cloud_prices.js')).up(h.s.db);
    if (!(await h.s.db.schema.hasTable('cloud_deployments'))) await (await import('../src/db/migrations/148_cloud_journal.js')).up(h.s.db);
    awsKey = fakes.aws.addUser({ userName: 'exprsn-billing' });
    doToken = fakes.digitalocean.addToken();
    (h.s.cloud as { credentials: unknown }).credentials = {
      for: async (a: CloudAccount) => (a.provider === 'aws' ? { kind: 'aws', accessKeyId: awsKey.accessKeyId, secretAccessKey: awsKey.secretAccessKey, expiresAt: null } : { kind: 'token', token: doToken, accountId: null })
    };
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    await Promise.all(Object.values(fakes).map((f) => f.stop()));
  });

  beforeEach(async () => {
    for (const f of Object.values(fakes)) f.reset();
    fakes.aws.prices.clear();
    fakes.azure.retailPrices.length = 0;
    clock = Date.parse('2026-10-20T08:00:00Z');
    prices = new CloudPrices(() => h.s, { endpoints: { awsPricing: fakes.aws.url, azureRetail: `${fakes.azure.url}/api/retail/prices`, digitalocean: fakes.digitalocean.url }, now: () => clock, transport: { sleep: async () => {}, random: () => 0.5 } });
    await h.s.db('cloud_prices').del();
  });

  it('AWS: the Price List Query API (GetProducts, signed for pricing), cached for a day', async () => {
    fakes.aws.setPrice('AmazonEC2', 'm6i.xlarge', 'eu-central-1', '0.2140000000', '2026-10-01');
    const p = await prices.lookup('aws', 'eu-central-1', 'ec2:m6i.xlarge', 'hour', { account: aws, currency: 'USD' });
    expect(p).toMatchObject({ price: 0.214, currency: 'USD', source: 'aws-price-list', date: '2026-10-01', region: 'eu-central-1' });
    const calls = fakes.aws.calls('pricing:GetProducts');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.authorization).toMatch(/Credential=[^/]+\/\d{8}\/us-east-1\/pricing\/aws4_request/);
    const q = JSON.parse(calls[0]!.body) as { ServiceCode: string; Filters: { Field: string; Value: string }[] };
    expect(q.ServiceCode).toBe('AmazonEC2');
    expect(Object.fromEntries(q.Filters.map((f) => [f.Field, f.Value]))).toMatchObject({ instanceType: 'm6i.xlarge', regionCode: 'eu-central-1', operatingSystem: 'Linux', tenancy: 'Shared' });
    // Cached: the same lookup within the day calls nothing.
    clock += 23 * 3_600_000;
    expect(await prices.lookup('aws', 'eu-central-1', 'ec2:m6i.xlarge', 'hour', { account: aws, currency: 'USD' })).toMatchObject({ price: 0.214 });
    expect(fakes.aws.calls('pricing:GetProducts')).toHaveLength(1);
    // A day later it is fetched again.
    clock += 2 * 3_600_000;
    fakes.aws.setPrice('AmazonEC2', 'm6i.xlarge', 'eu-central-1', '0.2200000000', '2026-10-21');
    expect(await prices.lookup('aws', 'eu-central-1', 'ec2:m6i.xlarge', 'hour', { account: aws, currency: 'USD' })).toMatchObject({ price: 0.22, date: '2026-10-21' });
    expect(fakes.aws.calls('pricing:GetProducts')).toHaveLength(2);
    // RDS for PostgreSQL and ElastiCache are queried with their own service codes.
    fakes.aws.setPrice('AmazonRDS', 'db.m6g.large', 'eu-central-1', '0.1680000000');
    expect(await prices.lookup('aws', 'eu-central-1', 'rds:db.m6g.large', 'hour', { account: aws, currency: 'USD' })).toMatchObject({ price: 0.168, source: 'aws-price-list' });
    expect(JSON.parse(fakes.aws.calls('pricing:GetProducts').at(-1)!.body).Filters).toEqual(expect.arrayContaining([{ Type: 'TERM_MATCH', Field: 'databaseEngine', Value: 'PostgreSQL' }]));
  });

  it('falls back to the stale cache, then to the sheet, when the API fails', async () => {
    const flaky = account('aws', 'aws-flaky'); // its own breaker: the failures below must not hold other tests' calls
    fakes.aws.setPrice('AmazonEC2', 'm6i.xlarge', 'eu-central-1', '0.2140000000', '2026-10-01');
    await prices.lookup('aws', 'eu-central-1', 'ec2:m6i.xlarge', 'hour', { account: flaky, currency: 'USD' });
    clock += 2 * 86_400_000;
    fakes.aws.fail(500, { __type: 'InternalFailure', message: 'boom' }, { op: 'pricing:GetProducts', times: 10 });
    expect(await prices.lookup('aws', 'eu-central-1', 'ec2:m6i.xlarge', 'hour', { account: flaky, currency: 'USD' })).toMatchObject({ price: 0.214, stale: true, source: 'aws-price-list' });
    // Nothing cached for another SKU: the sheet answers, with its page and date.
    expect(await prices.lookup('aws', 'eu-central-1', 'ec2:m6i.2xlarge', 'hour', { account: flaky, currency: 'USD' })).toMatchObject({ price: 0.384, source: 'price-sheet', date: '2026-10-20', ref: 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/current/us-east-1/index.json' });
    // What has no API never calls one.
    fakes.aws.reset();
    expect(await prices.lookup('aws', 'eu-central-1', 'eks:cluster', 'hour', { account: flaky, currency: 'USD' })).toMatchObject({ price: 0.1, source: 'price-sheet' });
    expect(fakes.aws.requests).toHaveLength(0);
  });

  it('Azure: the Retail Prices API (no credential), Linux consumption meters in the account currency', async () => {
    fakes.azure.addRetailPrice({ armSkuName: 'Standard_D4s_v5', armRegionName: 'westeurope', retailPrice: 0.23, effectiveStartDate: '2026-09-15T00:00:00Z' });
    fakes.azure.addRetailPrice({ armSkuName: 'Standard_D4s_v5', armRegionName: 'westeurope', retailPrice: 0.4, productName: 'Virtual Machines Dsv5 Series Windows' });
    fakes.azure.addRetailPrice({ armSkuName: 'Standard_D4s_v5', armRegionName: 'westeurope', retailPrice: 0.05, skuName: 'D4s v5 Spot' });
    const p = await prices.lookup('azure', 'westeurope', 'vm:Standard_D4s_v5', 'hour', { account: azure, currency: 'USD' });
    expect(p).toMatchObject({ price: 0.23, source: 'azure-retail-prices', date: '2026-09-15', currency: 'USD' });
    const call = fakes.azure.calls('retail:prices')[0]!;
    expect(call.headers.authorization).toBeUndefined();
    expect(call.query.get('currencyCode')).toBe('USD');
    expect(call.query.get('$filter')).toBe("serviceName eq 'Virtual Machines' and armRegionName eq 'westeurope' and armSkuName eq 'Standard_D4s_v5' and priceType eq 'Consumption'");
  });

  it('DigitalOcean: /v2/sizes in one call, monthly and hourly, dated the day fetched', async () => {
    const m = await prices.lookup('digitalocean', 'fra1', 'droplet:s-4vcpu-8gb', 'month', { account: doAcc, currency: 'USD' });
    expect(m).toMatchObject({ price: 48, source: 'digitalocean-sizes', date: '2026-10-20' });
    expect(fakes.digitalocean.calls('GET /sizes')).toHaveLength(1);
    expect(fakes.digitalocean.calls('GET /sizes')[0]!.headers.authorization).toBe(`Bearer ${doToken}`);
    // Every size came with it: the GPU size's hourly price is cached too.
    expect(await prices.lookup('digitalocean', 'tor1', 'droplet:gpu-h100x1-80gb', 'hour', { account: doAcc, currency: 'USD' })).toMatchObject({ price: 3.39, source: 'digitalocean-sizes' });
    expect(fakes.digitalocean.calls('GET /sizes')).toHaveLength(1);
    // Databases have no price API: the sheet.
    expect(await prices.lookup('digitalocean', 'fra1', 'do-db:db-s-4vcpu-8gb', 'month', { account: doAcc, currency: 'USD' })).toMatchObject({ price: 122.1, source: 'price-sheet' });
  });

  it('the daily refresh fills the cache for accounts with a deployment only', async () => {
    const t = Date.now();
    const row = (a: CloudAccount, regions: string[]) => [
      { id: a.id, name: a.name, provider: a.provider, scope: 'platform', tenant_id: null, scope_key: 'platform', provider_ids: '{}', credential_mode: 'vaulted', default_region: regions[0], state: 'active', description: null, validation: null, validated_at: null, created_by: null, created_tenant: h.tenantId, created_at: t, updated_at: t },
      regions.map((r, i) => ({ account_id: a.id, region: r, zone: 'cloud-eu', ceiling: 'internal', geo: 'eu', is_default: i === 0, updated_at: t }))
    ] as const;
    for (const [a, regions] of [[aws, ['eu-central-1']], [doAcc, ['fra1']]] as const) {
      const [acc, regs] = row(a, [...regions]);
      if (!(await h.s.db('cloud_accounts').where({ id: a.id }).first())) {
        await h.s.db('cloud_accounts').insert(acc);
        await h.s.db('cloud_account_regions').insert(regs);
      }
    }
    h.s.cloud.accounts.resetSchemaCache();
    // No deployment yet: nothing is fetched.
    expect(await prices.refresh()).toMatchObject({ fetched: 0, accounts: 0 });
    expect(fakes.aws.requests.length + fakes.digitalocean.requests.length).toBe(0);
    await h.s.db('cloud_deployments').insert({ id: ulid(), tenant_id: h.tenantId, scope: 'platform', account_id: aws.id, provider: 'aws', name: 'lab', region: 'eu-central-1', label: 'internal', state: 'draft', health: 'unknown', spec: null, endpoints: '{}', observed_version: 0, created_at: t, updated_at: t });
    fakes.aws.setPrice('AmazonEC2', 't3.medium', 'eu-central-1', '0.0480000000');
    const out = await prices.refresh();
    expect(out.accounts).toBe(1);
    expect(fakes.aws.calls('pricing:GetProducts').length).toBe(presetSkus('aws').filter((s) => /^(ec2|rds|elasticache):/.test(s)).length);
    expect(out.fetched).toBe(1); // only the price the fake knows
    expect(await h.s.db('cloud_prices').where({ provider: 'aws', sku: 'ec2:t3.medium', region: 'eu-central-1' }).first()).toMatchObject({ price: '0.048', source: 'aws-price-list' });
    expect(fakes.digitalocean.requests).toHaveLength(0);
    // The job is registered, and its schedule is daily (`startSchedules` adds it in a running server).
    expect(h.s.jobs.types().map((x) => x.type)).toContain('cloud.prices.refresh');
    h.s.cloud.prices!.schedule(h.s.scheduler);
    expect(h.s.scheduler.list().find((e) => e.name === 'cloud.prices.refresh')).toMatchObject({ everyMs: 86_400_000 });
  });

  it('estimates a plan: monthly, assumptions, every price used with its source and date', async () => {
    fakes.aws.setPrice('AmazonEC2', 'm6i.xlarge', 'eu-central-1', '0.2140000000', '2026-10-01');
    const s = spec({ target: { provider: 'aws', accountId: aws.id, region: 'eu-central-1' } });
    const e = await prices.estimate({ provider: 'aws', region: 'eu-central-1', account: aws, before: [], after: graph(s), spec: s });
    expect(e.currency).toBe('USD');
    expect(e.assumptions).toMatchObject({ hours: 730, storageGb: 100, egressGb: 500 });
    expect(e.assumptions.notes.join(' ')).toMatch(/730 hours/);
    expect(e.before).toBe(0);
    expect(e.delta).toBe(e.monthly);
    const total = e.lines.reduce((n, l) => n + (l.monthly ?? 0), 0);
    expect(Math.abs(total - e.monthly)).toBeLessThan(0.05);
    expect(e.lines.every((l) => l.monthly != null)).toBe(true);
    for (const p of e.prices) {
      expect(p).toEqual(expect.objectContaining({ sku: expect.any(String), unit: expect.any(String), price: expect.any(Number), source: expect.any(String), date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }));
    }
    // Two app nodes on the API's price, all month.
    expect(e.prices.find((p) => p.sku === 'ec2:m6i.xlarge')).toMatchObject({ price: 0.214, source: 'aws-price-list', date: '2026-10-01' });
    expect(e.lines.find((l) => l.key === 'nodes-app')).toMatchObject({ quantity: 1460, monthly: 312.44 });
    // The EKS fee, the database's hours and storage, internet egress and NAT-free deny egress.
    expect(e.lines.map((l) => l.sku)).toEqual(expect.arrayContaining(['eks:cluster', 'rds:db.m6g.large', 'rds:storage-gp3', 'elasticache:cache.m6g.large', 'elb:alb', 's3:standard', 'egress:internet']));
    expect(e.lines.find((l) => l.sku === 'egress:internet')).toMatchObject({ quantity: 500, monthly: 45 });
  });

  it('gives the delta of an upgrade, and of a scale-down and a destroy', async () => {
    const small = spec({ target: { provider: 'digitalocean', accountId: doAcc.id, region: 'fra1' }, compute: { shape: 'kubernetes', size: 'small' } });
    const large = spec({ target: { provider: 'digitalocean', accountId: doAcc.id, region: 'fra1' }, compute: { shape: 'kubernetes', size: 'large' } });
    const a = await prices.estimate({ provider: 'digitalocean', region: 'fra1', account: doAcc, before: [], after: graph(small), spec: small });
    const up = await prices.estimate({ provider: 'digitalocean', region: 'fra1', account: doAcc, before: graph(small), after: graph(large), spec: large, beforeSpec: small });
    expect(up.before).toBeCloseTo(a.monthly, 1);
    expect(up.delta).toBeGreaterThan(0);
    expect(up.delta).toBeCloseTo(up.monthly - up.before, 1);
    const down = await prices.estimate({ provider: 'digitalocean', region: 'fra1', account: doAcc, before: graph(large), after: graph(small), spec: small, beforeSpec: large });
    expect(down.delta).toBeLessThan(0);
    // HA doubles the database, and the HA control plane costs its monthly fee.
    expect(up.lines.find((l) => l.key === 'db')).toMatchObject({ sku: 'do-db:db-s-6vcpu-16gb', quantity: 2, monthly: 488.7 });
    expect(up.lines.find((l) => l.key === 'cluster')).toMatchObject({ sku: 'doks:ha', monthly: 40 });

    // Through the planner's hook: the plan's desired graph against the deployment's graph as it stands.
    const id = ulid();
    const t = Date.now();
    await h.s.db('cloud_deployments').insert({ id, tenant_id: h.tenantId, scope: 'platform', account_id: doAcc.id, provider: 'digitalocean', name: `do-${id.slice(-6).toLowerCase()}`, region: 'fra1', label: 'internal', state: 'ready', health: 'healthy', spec: JSON.stringify(small), endpoints: '{}', observed_version: 1, created_at: t, updated_at: t });
    for (const r of graph(small)) await h.s.db('cloud_resources').insert({ id: ulid(), deployment_id: id, key: r.key, type: r.type, region: 'fra1', provider_id: `p-${r.key}`, desired: JSON.stringify(r), depends_on: JSON.stringify(r.dependsOn), protect: r.protect, tags: '{}', state: 'ready', created_at: t, updated_at: t });
    const plan = { id: ulid(), deploymentId: id, purpose: 'apply', desired: graph(large), steps: [] } as unknown as Plan;
    const viaHook = (await prices.estimatePlan(plan)) as Estimate;
    expect(viaHook.before).toBeCloseTo(a.monthly, 1);
    expect(viaHook.delta).toBeGreaterThan(0);
    const destroy = (await prices.estimatePlan({ ...plan, purpose: 'destroy', desired: [] } as Plan)) as Estimate;
    expect(destroy.monthly).toBe(0);
    expect(destroy.delta).toBeCloseTo(-a.monthly, 1);
    // `s.cloud.estimatePlan` is the hook the planner calls.
    expect(typeof h.s.cloud.estimatePlan).toBe('function');
  });

  it('prices GPU pools at their minimum plus busy hours, and a Cloudflare front door from the sheet', async () => {
    const s = spec({ target: { provider: 'aws', accountId: aws.id, region: 'eu-central-1' }, gpuPools: [{ name: 'chat', gpu: 'l4', min: 0, max: 2, busyHours: 100 }], frontDoor: { kind: 'cloudflare', accountId: ulid(), hostname: 'ai.example.com', zone: 'example.com', plan: 'pro' } });
    const e = await prices.estimate({ provider: 'aws', region: 'eu-central-1', account: aws, before: [], after: graph(s), spec: s });
    expect(e.lines.find((l) => l.key === 'gpu-chat')).toMatchObject({ sku: 'ec2:g6.xlarge', quantity: 100 });
    expect(e.lines.find((l) => l.key === '(front door)')).toMatchObject({ sku: 'cf:zone-pro', monthly: 25 });
    expect(e.prices.find((p) => p.sku === 'cf:zone-pro')).toMatchObject({ source: 'price-sheet', ref: 'https://www.cloudflare.com/plans/network-cdn/' });
    expect(e.assumptions.notes.join(' ')).toMatch(/GPU pools/);
    const node = graph(s).find((r) => r.key === 'gpu-chat')!;
    expect(usageOf({ ...node, spec: { ...node.spec, min: 1 } }, 'aws', { hours: 730, storageGb: 0 })).toEqual([expect.objectContaining({ quantity: 830 })]);
  });

  it('uses the account currency with no conversion', async () => {
    const eur = account('azure', 'azure-eur', { billingCurrency: 'EUR' });
    fakes.azure.addRetailPrice({ armSkuName: 'Standard_D4s_v5', armRegionName: 'swedencentral', retailPrice: 0.21, currencyCode: 'EUR' });
    const s = spec({ target: { provider: 'azure', accountId: eur.id, region: 'swedencentral' }, compute: { shape: 'vm', size: 'medium' } });
    const e = await prices.estimate({ provider: 'azure', region: 'swedencentral', account: eur, before: [], after: graph(s), spec: s });
    expect(e.currency).toBe('EUR');
    expect(fakes.azure.calls('retail:prices').every((c) => c.query.get('currencyCode') === 'EUR')).toBe(true);
    // The VMs are priced in EUR; the sheet's USD prices are listed but left out of the total, not converted.
    expect(e.lines.find((l) => l.key === 'app-1')).toMatchObject({ sku: 'vm:Standard_D4s_v5', monthly: 153.3 });
    const usd = e.lines.filter((l) => l.note?.includes('not converted'));
    expect(usd.length).toBeGreaterThan(0);
    expect(e.monthly).toBeCloseTo(153.3 * 2, 1);
    // An account without one is USD.
    const plain = await prices.estimate({ provider: 'azure', region: 'swedencentral', account: azure, before: [], after: graph(s), spec: s, fetch: false });
    expect(plain.currency).toBe('USD');
    expect(plain.assumptions.notes.join(' ')).toMatch(/USD, the default billing currency/);
  });

  it('without migration 150 estimates use the price sheet only, and say so', async () => {
    await (await import('../src/db/migrations/150_cloud_prices.js')).down(h.s.db);
    try {
      const bare = new CloudPrices(() => h.s, { endpoints: { awsPricing: fakes.aws.url } });
      fakes.aws.setPrice('AmazonEC2', 'm6i.xlarge', 'eu-central-1', '0.2140000000');
      const s = spec({ target: { provider: 'aws', accountId: aws.id, region: 'eu-central-1' } });
      const e = await bare.estimate({ provider: 'aws', region: 'eu-central-1', account: aws, before: [], after: graph(s), spec: s });
      expect(e.cache).toBe(false);
      expect(e.prices.every((p) => p.source === 'price-sheet')).toBe(true);
      expect(e.assumptions.notes.join(' ')).toMatch(/not installed \(migration 150_cloud_prices\)/);
      expect(fakes.aws.requests).toHaveLength(0);
      expect(await bare.refresh()).toMatchObject({ skipped: expect.stringMatching(/not installed/) });
    } finally {
      await (await import('../src/db/migrations/150_cloud_prices.js')).up(h.s.db);
    }
  });
});
