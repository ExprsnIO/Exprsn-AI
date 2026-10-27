import { ulid } from 'ulid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountSpend, budgetBurn, estimatedBetween } from '../src/cloud/billing-spend.js';
import { CloudCosts, spreadOverDays } from '../src/cloud/costs.js';
import type { CloudAccount, Provider, ProviderIds } from '../src/cloud/types.js';
import { seedAccount } from './cloud-credentials-helpers.js';
import { FakeAws } from './fake-aws.js';
import { FakeAzure } from './fake-azure.js';
import { FakeDigitalOcean } from './fake-do.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';

/*
 * 1.9.99-final, Sprint 59 (B-10603): billing ingestion against the fakes only (AWS Cost Explorer `GetCostAndUsage`,
 * Azure Cost Management `query`, DigitalOcean balance and invoices); never a real cloud (EXPRSN_TESTS_OFFLINE refuses
 * their hosts). Daily rows in `cloud_costs`, revisions overwrite, currencies kept, one Cost Explorer request per account
 * and day, estimate against actual per deployment, the routes, and budgets on actuals. Migrations 146, 148, 152 and 155
 * are applied here when the harness lacks them (155 is not registered yet).
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-20T08:00:00Z');
const VALIDATED = (billing = 'ok') => ({ at: T0, ok: true, identity: { ok: true }, features: [{ feature: 'billing', name: 'Billing read', status: billing, required: [], missing: [], reason: null }] });

async function install(h: Harness): Promise<void> {
  const db = h.s.db;
  if (!(await db.schema.hasTable('cloud_accounts'))) await (await import('../src/db/migrations/146_cloud_accounts.js')).up(db);
  if (!(await db.schema.hasTable('cloud_deployments'))) await (await import('../src/db/migrations/148_cloud_journal.js')).up(db);
  if (!(await db.schema.hasTable('cloud_budgets'))) await (await import('../src/db/migrations/152_cloud_budgets.js')).up(db);
  if (!(await db.schema.hasTable('cloud_costs'))) await (await import('../src/db/migrations/155_cloud_costs.js')).up(db);
  h.s.cloud.accounts.resetSchemaCache();
  h.s.cloud.deployments.resetSchemaCache();
  h.s.cloud.budgets.resetSchemaCache();
  h.s.cloud.costs.resetSchemaCache();
}

describe('billing ingestion (B-10603)', () => {
  let h: Harness;
  let costs: CloudCosts;
  let clock = T0;
  const fakes = { aws: new FakeAws(), azure: new FakeAzure(), digitalocean: new FakeDigitalOcean() };
  let awsKey: { accessKeyId: string; secretAccessKey: string };
  let doToken: string;
  const azTenant = '11111111-2222-3333-4444-555555555555';
  const azSub = '99999999-8888-7777-6666-555555555555';
  const azToken = `az-${ulid()}`;
  const acc: Record<string, CloudAccount> = {};
  const dep: Record<string, string> = {};

  const account = async (provider: Provider, name: string, providerIds: ProviderIds, billing = 'ok'): Promise<CloudAccount> => {
    const a = await seedAccount(h, { provider, mode: 'vaulted', name, providerIds });
    await h.s.db('cloud_accounts').where({ id: a.id }).update({ validation: JSON.stringify(VALIDATED(billing)) });
    return (await h.s.cloud.accounts.get(a.id))!;
  };
  const deployment = async (a: CloudAccount, name: string): Promise<string> => {
    const id = ulid();
    await h.s.db('cloud_deployments').insert({ id, tenant_id: h.tenantId, scope: 'platform', account_id: a.id, provider: a.provider, name, region: 'eu-central-1', label: 'internal', state: 'ready', health: 'healthy', observed_version: 0, created_at: T0, updated_at: T0 });
    return id;
  };
  /** An applied plan with a monthly estimate (what the estimate side of estimate-vs-actual reads). */
  const applied = async (deploymentId: string, at: number, monthly: number, currency = 'USD') => {
    await h.s.db('cloud_plans').insert({ id: ulid(), deployment_id: deploymentId, tenant_id: h.tenantId, hash: ulid() + ulid(), purpose: 'apply', desired: '[]', steps: '[]', summary: '{}', estimate: JSON.stringify({ monthly, delta: monthly, currency, prices: [] }), observed_version: 0, observed_digest: 'x', state: 'applied', applicable: true, created_at: at, expires_at: at + 3_600_000, applied_at: at });
  };

  beforeAll(async () => {
    await Promise.all(Object.values(fakes).map((f) => f.start()));
    h = await harness({ SERVICE_ALLOWED_HOSTS: '127.0.0.1' });
    await install(h);
    awsKey = fakes.aws.addUser({ userName: 'exprsn-billing' });
    doToken = fakes.digitalocean.addToken(['billing:read']);
    fakes.azure.addSubscription(azSub, azTenant);
    fakes.azure.tokens.set(azToken, { tenantId: azTenant, clientId: 'billing-app', scope: 'https://management.azure.com/.default', exp: Date.now() + 10 * DAY });
    const purposes: string[] = [];
    (h.s.cloud as { credentials: unknown }).credentials = {
      for: async (a: CloudAccount, purpose: string) => {
        purposes.push(purpose);
        if (purpose !== 'billing') throw new Error('only the billing credential is used');
        if (a.provider === 'aws') return { kind: 'aws', accessKeyId: awsKey.accessKeyId, secretAccessKey: awsKey.secretAccessKey, expiresAt: null };
        if (a.provider === 'azure') return { kind: 'azure', tenantId: azTenant, getToken: async (scope: string) => (scope === 'https://management.azure.com/.default' ? { token: azToken, expiresAt: Date.now() + DAY } : Promise.reject(new Error('scope'))) };
        return { kind: 'token', token: doToken };
      }
    };
    acc.aws = await account('aws', 'aws-bill', { awsAccountId: fakes.aws.account });
    acc.azure = await account('azure', 'az-bill', { azureTenantId: azTenant, azureSubscriptionId: azSub });
    acc.do = await account('digitalocean', 'do-bill', { doTeamId: 'team-1' });
    acc.nobill = await account('aws', 'aws-nobill', { awsAccountId: '210987654321' }, 'missing');
    dep.lab = await deployment(acc.aws!, 'lab');
    dep.web = await deployment(acc.azure!, 'web');
    dep.doapp = await deployment(acc.do!, 'doapp');
    await h.s.db('cloud_resources').insert({ id: ulid(), deployment_id: dep.doapp, key: 'app', type: 'vm', region: 'fra1', provider_id: '424242', desired: JSON.stringify({ key: 'app', type: 'vm', spec: {} }), depends_on: '[]', tags: '{}', state: 'ready', created_at: T0, updated_at: T0 });
  }, 120_000);

  afterAll(async () => {
    await h?.close();
    await Promise.all(Object.values(fakes).map((f) => f.stop()));
  });

  beforeEach(async () => {
    for (const f of Object.values(fakes)) f.reset();
    clock = T0;
    costs = new CloudCosts(() => h.s, { endpoints: { awsCostExplorer: fakes.aws.url, azureArm: fakes.azure.url, digitalocean: fakes.digitalocean.url }, now: () => clock, transport: { sleep: async () => {}, random: () => 0.5 } });
    (h.s.cloud as { costs: CloudCosts }).costs = costs;
    await h.s.db('cloud_costs').del();
    await h.s.db('cloud_cost_fetches').del();
    fakes.aws.costs.length = 0;
    fakes.aws.costPageSize = 500;
    fakes.azure.costs.length = 0;
    fakes.digitalocean.billing.invoices = [];
  });

  it('AWS: one GetCostAndUsage by tag and service; yesterday\'s cost for a deployment equals Cost Explorer\'s figure for its tag', async () => {
    fakes.aws.addCost({ day: '2026-10-19', service: 'Amazon Elastic Compute Cloud - Compute', amount: '12.3456789', tags: { 'exprsn:deployment': 'lab', 'exprsn:account': 'aws-bill' }, estimated: true });
    fakes.aws.addCost({ day: '2026-10-19', service: 'Amazon Relational Database Service', amount: '3.21', tags: { 'exprsn:deployment': 'lab' } });
    fakes.aws.addCost({ day: '2026-10-19', service: 'Tax', amount: '1.5' });
    fakes.aws.addCost({ day: '2026-10-02', service: 'Amazon Elastic Compute Cloud - Compute', amount: '11', tags: { 'exprsn:deployment': 'lab' } });
    fakes.aws.addCost({ day: '2026-10-19', service: 'Amazon Elastic Compute Cloud - Compute', amount: '99', tags: { 'exprsn:deployment': 'lab' }, linkedAccount: '000000000000' }); // another linked account

    const r = await costs.ingestAccount(acc.aws!.id);
    expect(r).toMatchObject({ state: 'ok', requests: 1, window: { from: '2026-10-01', to: '2026-10-20' } });
    const calls = fakes.aws.calls('ce:GetCostAndUsage');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.authorization).toMatch(/Credential=[^/]+\/\d{8}\/us-east-1\/ce\/aws4_request/);
    expect(calls[0]!.headers['x-amz-target']).toBe('AWSInsightsIndexService.GetCostAndUsage');
    expect(JSON.parse(calls[0]!.body)).toEqual({ TimePeriod: { Start: '2026-10-01', End: '2026-10-20' }, Granularity: 'DAILY', Metrics: ['UnblendedCost'], GroupBy: [{ Type: 'TAG', Key: 'exprsn:deployment' }, { Type: 'DIMENSION', Key: 'SERVICE' }], Filter: { Dimensions: { Key: 'LINKED_ACCOUNT', Values: [fakes.aws.account] } } });

    // What Cost Explorer itself says for the tag yesterday (asked of the fake directly, outside the code under test).
    const ce = fakes.aws.costs.filter((c) => c.day === '2026-10-19' && c.tags['exprsn:deployment'] === 'lab' && c.linkedAccount === fakes.aws.account).reduce((n, c) => n + Number(c.amount), 0);
    const rows = await costs.rows(acc.aws!.id, { from: '2026-10-19', to: '2026-10-20', deploymentId: dep.lab });
    expect(rows.reduce((n, x) => n + x.amount, 0)).toBeCloseTo(ce, 6);
    // The full row.
    expect(rows.find((x) => x.service === 'Amazon Elastic Compute Cloud - Compute')).toEqual({ accountId: acc.aws!.id, provider: 'aws', deploymentId: dep.lab, allocation: 'lab', service: 'Amazon Elastic Compute Cloud - Compute', day: '2026-10-19', amount: 12.345679, currency: 'USD', source: 'aws-cost-explorer', estimated: true, fetchedAt: T0 });
    // Untagged costs are kept, unattributed.
    expect((await costs.rows(acc.aws!.id, { from: '2026-10-19', to: '2026-10-20' })).find((x) => x.service === 'Tax')).toMatchObject({ deploymentId: null, allocation: '', amount: 1.5 });
    expect(await costs.grouped(acc.aws!.id, { from: '2026-10-01', to: '2026-11-01', by: 'deployment' })).toEqual([
      { key: '', deploymentId: null, currency: 'USD', amount: 1.5, estimated: true }, // Cost Explorer flags a whole day as estimated
      { key: dep.lab, deploymentId: dep.lab, currency: 'USD', amount: 26.56, estimated: true }
    ]);
    // Audited, and the fetch is recorded with its window and request count.
    expect((await h.s.audit.list(h.tenantId, { action: 'cloud.costs.ingested' })).length).toBeGreaterThan(0);
    expect((await costs.fetches(acc.aws!.id))[0]).toMatchObject({ state: 'ok', requests: 1, rows: 4, key: '2026-10-20', totals: { USD: 28.06 } });
  });

  it('one Cost Explorer request per account per day: re-runs the same day are cached; the next day re-fetches and revisions overwrite', async () => {
    fakes.aws.addCost({ day: '2026-10-19', service: 'EC2', amount: '10', tags: { 'exprsn:deployment': 'lab' } });
    // The daily run: every eligible account (aws-bill, az-bill, do-bill; not aws-nobill), each once.
    expect(await costs.ingest()).toMatchObject({ accounts: 3, fetched: 3, failed: 0 });
    const after1 = (await costs.rows(acc.aws!.id, { from: '2026-10-01', to: '2026-11-01' })).length;
    for (let i = 0; i < 3; i++) {
      const again = await costs.ingestAccount(acc.aws!.id);
      expect(again).toMatchObject({ state: 'skipped', reason: 'cached', requests: 0 });
    }
    expect(await costs.ingest()).toMatchObject({ accounts: 3, fetched: 0, skipped: 3 });
    expect(fakes.aws.calls('ce:GetCostAndUsage')).toHaveLength(1);
    expect((await costs.rows(acc.aws!.id, { from: '2026-10-01', to: '2026-11-01' })).length).toBe(after1);

    // The next day: Cost Explorer revised the 19th; one more request, the 19th is overwritten (not duplicated).
    clock = T0 + DAY;
    fakes.aws.addCost({ day: '2026-10-19', service: 'EC2', amount: '10.75', tags: { 'exprsn:deployment': 'lab' } });
    fakes.aws.addCost({ day: '2026-10-20', service: 'EC2', amount: '4', tags: { 'exprsn:deployment': 'lab' } });
    expect(await costs.ingestAccount(acc.aws!.id)).toMatchObject({ state: 'ok', requests: 1, window: { from: '2026-10-01', to: '2026-10-21' } });
    expect(fakes.aws.calls('ce:GetCostAndUsage')).toHaveLength(2);
    const nineteenth = await costs.rows(acc.aws!.id, { from: '2026-10-19', to: '2026-10-20' });
    expect(nineteenth).toHaveLength(1);
    expect(nineteenth[0]).toMatchObject({ amount: 10.75, fetchedAt: T0 + DAY });
    // Idempotent: a manual re-fetch of the same answer writes the same rows.
    const before = (await costs.rows(acc.aws!.id, { from: '2026-10-01', to: '2026-11-01' })).map(({ fetchedAt: _f, ...x }) => x);
    expect(await costs.ingestAccount(acc.aws!.id, { manual: true })).toMatchObject({ state: 'ok', requests: 1 });
    expect((await costs.rows(acc.aws!.id, { from: '2026-10-01', to: '2026-11-01' })).map(({ fetchedAt: _f, ...x }) => x)).toEqual(before);
    // A second manual fetch within the hour calls nothing.
    expect(await costs.ingestAccount(acc.aws!.id, { manual: true })).toMatchObject({ state: 'skipped', reason: 'cached' });
    expect(fakes.aws.calls('ce:GetCostAndUsage')).toHaveLength(3);
  });

  it('pages only when Cost Explorer says so; an account without billing access, Cloudflare and the unvalidated are never called', async () => {
    for (let d = 1; d <= 6; d++) fakes.aws.addCost({ day: `2026-10-0${d}`, service: 'EC2', amount: '1', tags: { 'exprsn:deployment': 'lab' } });
    fakes.aws.costPageSize = 4;
    const r = await costs.ingestAccount(acc.aws!.id);
    expect(r).toMatchObject({ state: 'ok', requests: 2, rows: 6 });
    expect(JSON.parse(fakes.aws.calls('ce:GetCostAndUsage')[1]!.body).NextPageToken).toBe('4');
    fakes.aws.reset();
    expect(await costs.ingestAccount(acc.nobill!.id)).toMatchObject({ state: 'skipped', reason: expect.stringMatching(/^not_eligible: .*billing read access/) });
    expect(fakes.aws.requests).toHaveLength(0);
    // Sprint 61 (B-10608): Cloudflare accounts are fetched too, once they carry their Cloudflare account id.
    expect(costs.eligibility({ ...acc.aws!, provider: 'cloudflare' })).toMatch(/no Cloudflare account id/);
  });

  it('a failed fetch is recorded, retried by the next run, and gives up after three attempts that day', async () => {
    fakes.aws.fail(403, { __type: 'AccessDeniedException', message: 'User is not authorized to perform: ce:GetCostAndUsage' }, { op: 'ce:GetCostAndUsage', times: 3 });
    const a = await costs.ingestAccount(acc.aws!.id);
    expect(a).toMatchObject({ state: 'failed', error: expect.stringMatching(/Cost Explorer answered 403: User is not authorized/) });
    expect((await h.s.audit.list(h.tenantId, { action: 'cloud.costs.failed' })).length).toBeGreaterThan(0);
    expect((await costs.ingestAccount(acc.aws!.id)).state).toBe('failed');
    expect((await costs.ingestAccount(acc.aws!.id)).state).toBe('failed');
    expect(await costs.ingestAccount(acc.aws!.id)).toMatchObject({ state: 'skipped', reason: 'attempts_spent' });
    expect(fakes.aws.calls('ce:GetCostAndUsage')).toHaveLength(3);
    expect(await costs.billingState(acc.aws!.id)).toMatchObject({ billing: false });
  });

  it('Azure: Cost Management by the exprsn:deployment tag and service; the currency is kept, never converted', async () => {
    fakes.azure.addCost({ subscriptionId: azSub, day: '2026-10-19', service: 'Virtual Machines', cost: 7.5, currency: 'EUR', tags: { 'exprsn:deployment': 'web' } });
    fakes.azure.addCost({ subscriptionId: azSub, day: '2026-10-19', service: 'Storage', cost: 0.25, currency: 'EUR', tags: { 'exprsn:deployment': 'web' } });
    fakes.azure.addCost({ subscriptionId: azSub, day: '2026-10-18', service: 'Bandwidth', cost: 1.1, currency: 'EUR' });
    fakes.azure.costPageSize = 2;
    const r = await costs.ingestAccount(acc.azure!.id);
    expect(r).toMatchObject({ state: 'ok', requests: 2, totals: { EUR: 8.85 } });
    const call = fakes.azure.calls('cost:query')[0]!;
    expect(call.path).toBe(`/subscriptions/${azSub}/providers/Microsoft.CostManagement/query`);
    expect(call.headers.authorization).toBe(`Bearer ${azToken}`);
    expect(JSON.parse(call.body)).toMatchObject({ type: 'ActualCost', timeframe: 'Custom', timePeriod: { from: '2026-10-01T00:00:00Z', to: '2026-10-19T23:59:59Z' }, dataset: { granularity: 'Daily', grouping: [{ type: 'TagKey', name: 'exprsn:deployment' }, { type: 'Dimension', name: 'ServiceName' }] } });
    const rows = await costs.rows(acc.azure!.id, { from: '2026-10-01', to: '2026-11-01' });
    expect(rows.find((x) => x.service === 'Virtual Machines')).toMatchObject({ provider: 'azure', deploymentId: dep.web, allocation: 'web', day: '2026-10-19', amount: 7.5, currency: 'EUR', source: 'azure-cost-management' });
    expect(rows.find((x) => x.service === 'Bandwidth')).toMatchObject({ deploymentId: null, currency: 'EUR' });
    // A USD comparison leaves the EUR rows apart.
    const eva = await costs.estimateVsActual(acc.azure!, { from: '2026-10-01', to: '2026-11-01' });
    expect(eva).toMatchObject({ currency: 'USD', otherCurrencies: { EUR: 8.85 }, total: { actual: 0 } });
    expect(await new AccountSpend(() => h.s).actualMonthToDate(acc.azure!.id, { currency: 'USD', now: clock })).toMatchObject({ source: 'billing', amount: 0, excluded: expect.arrayContaining([{ deploymentId: dep.web, reason: 'Billed in EUR, not USD; not converted.' }, { deploymentId: '', reason: 'Billed in EUR, not USD; not converted.' }]) });
    expect((await new AccountSpend(() => h.s).actualMonthToDate(acc.azure!.id, { currency: 'EUR', now: clock })).amount).toBe(8.85);
  });

  it('DigitalOcean: the balance and invoices; items attributed by resource id and spread over their days; a final month fetched once', async () => {
    fakes.digitalocean.addInvoice({ period: '2026-09', items: [{ product: 'Droplets', amount: '30.00', resource_id: '424242', start_time: '2026-09-01T00:00:00Z', end_time: '2026-10-01T00:00:00Z' }, { product: 'Spaces', amount: '5.00', resource_uuid: 'aaaa-unknown', start_time: '2026-09-16T00:00:00Z', end_time: '2026-10-01T00:00:00Z' }] });
    fakes.digitalocean.addInvoice({ period: '2026-10', preview: true, items: [{ product: 'Droplets', amount: '19.00', resource_id: '424242', start_time: '2026-10-01T00:00:00Z', end_time: '2026-10-20T00:00:00Z' }] });
    const r = await costs.ingestAccount(acc.do!.id);
    expect(r).toMatchObject({ state: 'ok', totals: { USD: 54 } });
    expect(fakes.digitalocean.calls('GET /customers/my/balance')).toHaveLength(1);
    expect(fakes.digitalocean.calls('GET /customers/my/invoices')).toHaveLength(1);
    expect(fakes.digitalocean.calls(/^GET \/customers\/my\/invoices\/\{id\}$/)).toHaveLength(2);
    const sept = await costs.rows(acc.do!.id, { from: '2026-09-01', to: '2026-10-01' });
    expect(sept.filter((x) => x.service === 'Droplets')).toHaveLength(30);
    expect(sept.filter((x) => x.service === 'Droplets').reduce((n, x) => n + x.amount, 0)).toBeCloseTo(30, 6);
    expect(sept.find((x) => x.service === 'Droplets')).toMatchObject({ deploymentId: dep.doapp, allocation: '424242', amount: 1, source: 'digitalocean-invoice', estimated: false });
    expect(sept.find((x) => x.service === 'Spaces')).toMatchObject({ deploymentId: null, allocation: 'aaaa-unknown', day: '2026-09-16' });
    const oct = await costs.rows(acc.do!.id, { from: '2026-10-01', to: '2026-11-01' });
    expect(oct).toHaveLength(19);
    expect(oct[18]).toMatchObject({ day: '2026-10-19', amount: 1, source: 'digitalocean-preview', estimated: true, deploymentId: dep.doapp });
    expect((await costs.fetches(acc.do!.id))[0]!.note).toMatchObject({ balance: { monthToDateUsage: '19.00' }, previewTotal: 19 });
    // The next day: the preview grew; September is final and not fetched again.
    clock = T0 + DAY;
    fakes.digitalocean.reset();
    fakes.digitalocean.addInvoice({ period: '2026-10', preview: true, items: [{ product: 'Droplets', amount: '20.00', resource_id: '424242', start_time: '2026-10-01T00:00:00Z', end_time: '2026-10-21T00:00:00Z' }] });
    await costs.ingestAccount(acc.do!.id);
    expect(fakes.digitalocean.calls(/^GET \/customers\/my\/invoices\/\{id\}$/)).toHaveLength(1);
    expect((await costs.rows(acc.do!.id, { from: '2026-10-01', to: '2026-11-01' })).reduce((n, x) => n + x.amount, 0)).toBeCloseTo(20, 6);
    expect((await costs.rows(acc.do!.id, { from: '2026-09-01', to: '2026-10-01' })).reduce((n, x) => n + x.amount, 0)).toBeCloseTo(35, 6);
    // The invoice CSV and billing history answer too (the items carry the resource ids the CSV lacks).
    const inv = fakes.digitalocean.billing.invoices[0]!;
    const csv = await fetch(`${fakes.digitalocean.url}/v2/customers/my/invoices/${inv.invoice_uuid}/csv`, { headers: { authorization: `Bearer ${doToken}` } });
    expect(await csv.text()).toMatch(/^product,group_description,description,hours,start,end,USD,project_name,category\nDroplets,/);
  });

  it('spreads an amount over its days exactly', () => {
    const parts = spreadOverDays(10, Date.parse('2026-10-01T12:00:00Z'), Date.parse('2026-10-04T00:00:00Z'));
    expect(parts.map((p) => p.day)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    expect(parts.reduce((n, p) => n + p.amount, 0)).toBeCloseTo(10, 9);
    expect(parts[0]!.amount).toBeCloseTo(2, 6);
  });

  it('estimate against actual per deployment; budgets switch to actuals when billing data exists', async () => {
    await h.s.db('cloud_plans').del();
    await applied(dep.lab!, Date.parse('2026-09-01T00:00:00Z'), 310);
    fakes.aws.addCost({ day: '2026-10-05', service: 'EC2', amount: '9', tags: { 'exprsn:deployment': 'lab' } });
    fakes.aws.addCost({ day: '2026-10-19', service: 'EC2', amount: '11', tags: { 'exprsn:deployment': 'lab' } });
    fakes.aws.addCost({ day: '2026-10-19', service: 'Support', amount: '2' });
    // Before any fetch the budget reads the estimates, and says why.
    const spend = new AccountSpend(() => h.s);
    const est = await spend.actualMonthToDate(acc.aws!.id, { currency: 'USD', now: clock });
    expect(est).toMatchObject({ source: 'estimate', basis: 'No billing data has been fetched for this account yet.' });
    expect(est.amount).toBeCloseTo((310 * (clock - Date.parse('2026-10-01T00:00:00Z'))) / (31 * DAY), 1);

    await costs.ingestAccount(acc.aws!.id);
    const eva = await costs.estimateVsActual(acc.aws!, { from: '2026-10-01', to: '2026-11-01' });
    const lab = eva.deployments.find((d) => d.deploymentId === dep.lab)!;
    expect(lab.actual).toBe(20);
    expect(lab.estimate).toBeCloseTo((310 * (clock - Date.parse('2026-10-01T00:00:00Z'))) / (31 * DAY), 1);
    expect(lab.difference).toBeCloseTo(20 - lab.estimate, 2);
    expect(eva).toMatchObject({ unattributed: 2, total: { actual: 22 } });
    expect((await estimatedBetween(() => h.s, [dep.lab!], Date.parse('2026-10-01T00:00:00Z'), Date.parse('2026-11-01T00:00:00Z'), 'USD')).get(dep.lab!)).toMatchObject({ amount: 310, runRate: 310 });

    const actual = await spend.actualMonthToDate(acc.aws!.id, { currency: 'USD', now: clock });
    expect(actual).toMatchObject({ source: 'billing', amount: 22, billedThrough: '2026-10-19', deployments: 1 });
    // Forecast: the actuals plus the plans' run rate from the end of the last billed day to the month's end.
    const fc = await spend.forecast(acc.aws!.id, { currency: 'USD', now: clock });
    expect(fc.amount).toBeCloseTo(22 + (310 * (Date.parse('2026-11-01T00:00:00Z') - Date.parse('2026-10-20T00:00:00Z'))) / (31 * DAY), 1);
    expect(fc.runRate).toBe(310);

    // The budget view says which source; burn is exported for the metrics.
    await h.s.cloud.budgets.set({ principal: { kind: 'user', userId: ulid(), tenantId: h.tenantId, tenantSlug: h.s.cfg.DEFAULT_TENANT, username: 'x', displayName: 'x', roles: ['system-admin'], clearance: 'restricted', scopes: null, sessionId: null, apiKeyId: null, mfa: true }, ip: '127.0.0.1' }, acc.aws!.id, { amount: 100, hardStop: 'actual' });
    const b = (await h.s.cloud.budgets.get(acc.aws!.id))!;
    const st = await h.s.cloud.budgets.statusOf(b, clock);
    expect(st.actual.source).toBe('billing');
    expect(st.source).toMatch(/^Billing data from the provider/);
    const burn = await budgetBurn(h.s, clock);
    expect(burn.find((x) => x.accountId === acc.aws!.id)).toMatchObject({ source: 'billing', budget: 100, currency: 'USD' });
    // Stale billing data (older than three days) falls back to the estimates, and says so.
    await h.s.db('cloud_cost_fetches').where({ account_id: acc.aws!.id }).update({ finished_at: clock - 4 * DAY });
    const stale = await h.s.cloud.budgets.statusOf(b, clock);
    expect(stale.actual).toMatchObject({ source: 'estimate', basis: 'The last billing fetch is older than 3 days.' });
    expect(stale.source).toMatch(/^Estimated from the applied plans/);
    await h.s.cloud.budgets.remove({ principal: { kind: 'user', userId: ulid(), tenantId: h.tenantId, tenantSlug: h.s.cfg.DEFAULT_TENANT, username: 'x', displayName: 'x', roles: ['system-admin'], clearance: 'restricted', scopes: null, sessionId: null, apiKeyId: null, mfa: true }, ip: '127.0.0.1' }, acc.aws!.id);
  });

  it('routes: finops:read or cloud:read read; finops:manage fetches now, once an hour; the job is registered and scheduled daily', async () => {
    await localUser(h, 'finroot', ['system-admin'], 'restricted');
    await localUser(h, 'analyst', ['finops-analyst'], 'internal');
    const root = await loginAdmin(h, 'finroot');
    const analyst = await loginAdmin(h, 'analyst');
    fakes.aws.addCost({ day: '2026-10-19', service: 'EC2', amount: '5', tags: { 'exprsn:deployment': 'lab' } });
    await costs.ingestAccount(acc.aws!.id);
    const base = `/api/admin/cloud/accounts/${acc.aws!.id}/costs`;
    const sum = await analyst.agent.get('/api/admin/cloud/costs').expect(200);
    expect(sum.body.accounts.find((a: { account: { id: string } }) => a.account.id === acc.aws!.id)).toMatchObject({ budgetSource: 'billing', eligible: null, lastFetch: { state: 'ok' } });
    expect(sum.body.accounts.find((a: { account: { id: string } }) => a.account.id === acc.nobill!.id)).toMatchObject({ budgetSource: 'estimate', eligible: expect.stringMatching(/billing read access/) });
    const rows = await analyst.agent.get(`${base}?from=2026-10-01&to=2026-11-01`).expect(200);
    expect(rows.body.rows).toEqual(expect.arrayContaining([expect.objectContaining({ day: '2026-10-19', amount: 5, deploymentId: dep.lab })]));
    expect((await analyst.agent.get(`${base}?from=2026-10-01&to=2026-11-01&by=service`).expect(200)).body.groups).toEqual([{ key: 'EC2', deploymentId: null, currency: 'USD', amount: 5, estimated: false }]);
    await analyst.agent.get(`${base}?from=2026-10-05&to=2026-10-01`).expect(400);
    await analyst.agent.get(`${base}/estimate-vs-actual?from=2026-10-01&to=2026-11-01`).expect(200);
    expect((await analyst.agent.get(`/api/admin/cloud/deployments/${dep.lab}/costs?from=2026-10-01&to=2026-11-01`).expect(200)).body).toMatchObject({ deployment: { id: dep.lab, name: 'lab' }, deployments: [expect.objectContaining({ actual: 5 })] });
    expect((await analyst.agent.get(`${base}/fetches`).expect(200)).body.fetches[0]).toMatchObject({ state: 'ok', requests: 1 });
    // Fetch now: finops:manage only; one an hour.
    await analyst.agent.post(`${base}/fetch`).set('x-csrf-token', analyst.csrf).expect(403);
    const q = await root.agent.post(`${base}/fetch`).set('x-csrf-token', root.csrf).expect(202);
    expect(q.body.jobId).toBeTruthy();
    expect((await h.s.audit.list(h.tenantId, { action: 'cloud.costs.fetch.requested' })).length).toBe(1);
    await costs.ingestAccount(acc.aws!.id, { manual: true, requestedBy: null });
    const again = await root.agent.post(`${base}/fetch`).set('x-csrf-token', root.csrf).expect(409);
    expect(again.body.reason ?? again.body.extensions?.reason).toBe('costs_recent');
    await root.agent.post(`/api/admin/cloud/accounts/${acc.nobill!.id}/costs/fetch`).set('x-csrf-token', root.csrf).expect(409);
    expect(h.s.jobs.types().map((x) => x.type)).toContain('cloud.costs.ingest');
    h.s.cloud.costs.schedule(h.s.scheduler);
    expect(h.s.scheduler.list().find((e) => e.name === 'cloud.costs.ingest')).toMatchObject({ everyMs: DAY });
  });
});

describe('without migration 155', () => {
  it('nothing is fetched, the routes answer 503 migration_pending, and budgets stay on estimates', async () => {
    const h = await harness({ SERVICE_ALLOWED_HOSTS: '127.0.0.1' });
    try {
      await install(h);
      await (await import('../src/db/migrations/155_cloud_costs.js')).down(h.s.db);
      h.s.cloud.costs.resetSchemaCache();
      const a = await seedAccount(h, { provider: 'aws', mode: 'vaulted', name: 'aws-none', providerIds: { awsAccountId: '123456789012' } });
      await h.s.db('cloud_accounts').where({ id: a.id }).update({ validation: JSON.stringify(VALIDATED()) });
      (h.s.cloud as { credentials: unknown }).credentials = { for: async () => Promise.reject(new Error('must not be asked')) };
      expect(await h.s.cloud.costs.ingestAccount(a.id)).toMatchObject({ state: 'skipped', reason: 'migration_pending' });
      expect(await h.s.cloud.costs.ingest()).toMatchObject({ accounts: 0 });
      expect(await new AccountSpend(() => h.s).actualMonthToDate(a.id)).toMatchObject({ source: 'estimate', basis: expect.stringMatching(/migration 155_cloud_costs/) });
      await localUser(h, 'root', ['system-admin'], 'restricted');
      const c = await loginAdmin(h, 'root');
      const r = await c.agent.get('/api/admin/cloud/costs').expect(503);
      expect(r.body.reason ?? r.body.extensions?.reason).toBe('migration_pending');
      await c.agent.post(`/api/admin/cloud/accounts/${a.id}/costs/fetch`).set('x-csrf-token', c.csrf).expect(503);
    } finally {
      await h.close();
    }
  });
});
