import { ulid } from 'ulid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CF_USAGE_RATES, cloudflareWindow } from '../src/cloud/cloudflare-billing.js';
import { CloudCosts } from '../src/cloud/costs.js';
import { workersAiNeurons } from '../src/cloud/model-backends.js';
import type { CloudAccount } from '../src/cloud/types.js';
import { seedAccount } from './cloud-credentials-helpers.js';
import { FakeCloudflare } from './fake-cloudflare.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';

/*
 * 1.9.99-final, Sprint 61 (B-10608): Cloudflare billing against `fake-cloudflare.ts` (with
 * `fake-cloudflare-billing.ts`) only; the real Cloudflare is refused in tests (EXPRSN_TESTS_OFFLINE). Two GraphQL
 * Analytics requests (one aliased dataset per product and month; Workers AI alone in the second) and one account
 * billing history request per account and day become daily `cloud_costs` rows per product (Workers, Containers, R2, Workers AI), finished months are reconciled with what was charged, and
 * the Workers AI neurons in the analytics match the metered neurons on `usage_records` within 1 %, a mismatch being
 * reported by the check job. Migrations 146, 148, 152, 155 and 160 are applied here when the harness lacks them.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-20T08:00:00Z');
const VALIDATED = { at: T0, ok: true, identity: { ok: true }, features: [{ feature: 'billing', name: 'Billing read', status: 'ok', required: [], missing: [], reason: null }] };
const MODEL = '@cf/meta/llama-3.1-8b-instruct';

async function install(h: Harness): Promise<void> {
  const db = h.s.db;
  if (!(await db.schema.hasTable('cloud_accounts'))) await (await import('../src/db/migrations/146_cloud_accounts.js')).up(db);
  if (!(await db.schema.hasTable('cloud_deployments'))) await (await import('../src/db/migrations/148_cloud_journal.js')).up(db);
  if (!(await db.schema.hasTable('cloud_budgets'))) await (await import('../src/db/migrations/152_cloud_budgets.js')).up(db);
  if (!(await db.schema.hasTable('cloud_costs'))) await (await import('../src/db/migrations/155_cloud_costs.js')).up(db);
  if (!(await db.schema.hasColumn('usage_records', 'neurons'))) await (await import('../src/db/migrations/160_cloud_model_servers.js')).up(db);
  h.s.cloud.accounts.resetSchemaCache();
  h.s.cloud.deployments.resetSchemaCache();
  h.s.cloud.budgets.resetSchemaCache();
  h.s.cloud.costs.resetSchemaCache();
}

describe('Cloudflare billing (B-10608)', () => {
  let h: Harness;
  let cf: FakeCloudflare;
  let costs: CloudCosts;
  let clock = T0;
  let account: CloudAccount;
  let token: string;
  let dep: string;
  let poolId: string;

  const sum = (rows: { amount: number }[]) => Math.round(rows.reduce((n, r) => n + r.amount, 0) * 1e6) / 1e6;

  beforeAll(async () => {
    cf = await new FakeCloudflare().start();
    h = await harness({ SERVICE_ALLOWED_HOSTS: '127.0.0.1' });
    await install(h);
    token = cf.addToken(['Billing Read', 'Account Analytics Read'], { accountOwned: true }).value;
    (h.s.cloud as { credentials: unknown }).credentials = {
      for: async (_a: CloudAccount, purpose: string) => {
        if (purpose !== 'billing') throw new Error('only the billing credential is used');
        return { kind: 'token', token, accountId: cf.accountId };
      }
    };
    account = await seedAccount(h, { provider: 'cloudflare', mode: 'vaulted', name: 'cf-bill', providerIds: { cloudflareAccountId: cf.accountId } });
    await h.s.db('cloud_accounts').where({ id: account.id }).update({ validation: JSON.stringify(VALIDATED) });
    account = (await h.s.cloud.accounts.get(account.id))!;
    dep = ulid();
    await h.s.db('cloud_deployments').insert({ id: dep, tenant_id: h.tenantId, scope: 'platform', account_id: account.id, provider: 'cloudflare', name: 'web', region: 'global', label: 'internal', state: 'ready', health: 'healthy', observed_version: 0, created_at: T0, updated_at: T0 });
    // An R2 bucket of the deployment, found by its provider id (the bucket's name).
    await h.s.db('cloud_resources').insert({ id: ulid(), deployment_id: dep, key: 'assets', type: 'bucket', region: 'global', provider_id: 'media-bucket', desired: JSON.stringify({ key: 'assets', type: 'bucket', spec: {} }), depends_on: '[]', tags: '{}', state: 'ready', created_at: T0, updated_at: T0 });
    // The pool that holds this account's Workers AI instance: the metered neurons are its records'.
    const pool = await h.s.gateway.repo.createPool({ name: 'cf-edge-bill', accelerator: 'cpu', zone: 'inference', labelCeiling: 'internal' });
    poolId = pool.id;
    await h.s.gateway.repo.createInstance({ poolId, name: 'workers-ai', url: `${cf.url}/client/v4/accounts/${cf.accountId}/ai`, deploy: 'cloud', kind: 'openai', settings: { cloud: { provider: 'cloudflare', accountId: account.id, region: 'global', flavour: 'workers-ai' } } });
  }, 180_000);

  afterAll(async () => {
    await h?.close();
    await cf?.stop();
  });

  beforeEach(async () => {
    cf.reset();
    cf.billing.clear();
    clock = T0;
    costs = new CloudCosts(() => h.s, { endpoints: { cloudflare: cf.url }, now: () => clock, transport: { sleep: async () => {}, random: () => 0.5 } });
    (h.s.cloud as { costs: CloudCosts }).costs = costs;
    await h.s.db('cloud_costs').del();
    await h.s.db('cloud_cost_fetches').del();
    await h.s.db('usage_records').where({ pool_id: poolId }).del();
  });

  it('turns the GraphQL analytics of every product into daily rows, in two analytics and one billing request', async () => {
    cf.billing.workers('2026-10-19', 'exprsn-cf-bill-web-api', 2_000_000, 10_000_000_000); // 2 M requests, 10 M CPU ms
    cf.billing.containers('2026-10-19', 'exprsn-cf-bill-web-app', 3600, 7200 * 2 ** 30, 0); // 7200 GiB-seconds, in byte-seconds
    cf.billing.r2Storage('2026-10-19', 'media-bucket', 310e9); // 310 GB
    cf.billing.r2Operations('2026-10-19', 'media-bucket', 'PutObject', 1_000_000);
    cf.billing.r2Operations('2026-10-19', 'media-bucket', 'GetObject', 10_000_000);
    cf.billing.r2Operations('2026-10-19', 'media-bucket', 'DeleteObject', 5_000_000); // free
    cf.billing.neurons('2026-10-19', MODEL, 500_000);
    cf.billing.workers('2026-08-30', 'exprsn-cf-bill-web-api', 1_000_000, 0); // outside the window

    const r = await costs.ingestAccount(account.id);
    expect(r).toMatchObject({ state: 'ok', requests: 3, window: { from: '2026-09-01', to: '2026-10-20' } });
    expect(r.partial).toBeUndefined();
    expect(cloudflareWindow(costs.window(T0), T0)).toEqual({ from: '2026-09-01', to: '2026-10-20' });
    const gql = cf.calls('POST /graphql');
    expect(gql).toHaveLength(2);
    const [body, aiBody] = gql.map((g) => {
      expect(g.headers.authorization).toBe(`Bearer ${token}`);
      return JSON.parse(g.body) as { query: string; variables: Record<string, string> };
    });
    // One piece per calendar month: Cloudflare answers at most 31 days per dataset query.
    for (const b of [body!, aiBody!]) expect(b.variables).toEqual({ accountTag: cf.accountId, from0: '2026-09-01', to0: '2026-10-01', from1: '2026-10-01', to1: '2026-10-20' });
    for (const ds of ['workersInvocationsAdaptive', 'containersUsageAdaptiveGroups', 'r2StorageAdaptiveGroups', 'r2OperationsAdaptiveGroups']) expect(body!.query).toContain(ds);
    // Workers AI (no public schema page) goes alone, so a wrong field there cannot fail the other products.
    expect(body!.query).not.toContain('aiInferenceAdaptiveGroups');
    expect(aiBody!.query).toContain('aiInferenceAdaptiveGroups');
    expect(aiBody!.query).not.toMatch(/workersInvocationsAdaptive|containersUsageAdaptiveGroups|r2StorageAdaptiveGroups|r2OperationsAdaptiveGroups/);
    expect(body!.query).not.toMatch(/containersMetricsAdaptiveGroups|cloudflareTunnelsAnalyticsAdaptiveGroups/);
    expect(cf.calls('GET /accounts/{id}/billing/history')).toHaveLength(1);
    expect(costs.calls.cloudflare).toBe(3);

    const rows = await costs.rows(account.id, { from: '2026-10-19', to: '2026-10-20' });
    const by = (service: string) => rows.filter((x) => x.service === service);
    // Workers: USD 0.30 per M requests and 0.02 per M CPU ms, attributed by the script's name prefix.
    expect(by('Workers')).toEqual([{ accountId: account.id, provider: 'cloudflare', deploymentId: dep, allocation: 'exprsn-cf-bill-web-api', service: 'Workers', day: '2026-10-19', amount: 0.8, currency: 'USD', source: 'cloudflare-analytics', estimated: true, fetchedAt: T0 }]);
    // Containers: vCPU-seconds and GiB-seconds (allocated memory comes in byte-seconds).
    expect(by('Containers')[0]).toMatchObject({ deploymentId: dep, amount: Math.round((3600 * CF_USAGE_RATES.containersVcpuSecond + 7200 * CF_USAGE_RATES.containersGibSecond) * 1e6) / 1e6 });
    // R2: storage for the day (GB-month over the month's days) plus Class A and Class B operations, by the bucket's provider id.
    expect(by('R2')).toHaveLength(1);
    expect(by('R2')[0]).toMatchObject({ deploymentId: dep, allocation: 'media-bucket', amount: Math.round(((310 * 0.015) / 31 + 4.5 + 3.6) * 1e6) / 1e6 });
    // Workers AI: neurons at USD 0.011 per 1,000, not a deployment's resource.
    expect(by('Workers AI')).toEqual([expect.objectContaining({ deploymentId: null, allocation: MODEL, amount: 5.5 })]);
    // Tunnel costs nothing and is not queried: no row.
    expect(by('Tunnel')).toEqual([]);
    const [f] = await costs.fetches(account.id, 1);
    expect(f!.note).toMatchObject({ analytics: { neurons: true, days: { '2026-10-19': { neurons: 500_000, workersRequests: 2_000_000, r2ClassA: 1_000_000, r2ClassB: 10_000_000 } } }, charges: 0 });
    expect(f!.note).not.toHaveProperty('partial');
    expect(await costs.rows(account.id, { from: '2026-08-01', to: '2026-09-01' })).toEqual([]);
    // The neuron check is queued as its own job.
    expect((await h.s.jobs.list(h.tenantId, { type: 'cloud.costs.neurons.check' })).length).toBeGreaterThan(0);
  });

  it('fetches each account once a UTC day; a re-run that day calls nothing, the next day fetches again', async () => {
    cf.billing.neurons('2026-10-18', MODEL, 1000);
    expect(await costs.ingestAccount(account.id)).toMatchObject({ state: 'ok', requests: 3 });
    cf.reset();
    expect(await costs.ingestAccount(account.id)).toMatchObject({ state: 'skipped', reason: 'cached', requests: 0 });
    expect(await costs.ingest()).toMatchObject({ accounts: 1, fetched: 0, skipped: 1 });
    expect(cf.requests).toHaveLength(0);
    clock = T0 + DAY;
    expect(await costs.ingestAccount(account.id)).toMatchObject({ state: 'ok', requests: 3 });
    expect(cf.calls('POST /graphql')).toHaveLength(2);
    // The same answer again writes the same rows (idempotent).
    expect(sum(await costs.rows(account.id, { from: '2026-10-01', to: '2026-11-01' }))).toBe(0.011);
  });

  it('reconciles a finished month with what was charged, and keeps another currency apart', async () => {
    for (let d = 1; d <= 30; d++) cf.billing.neurons(`2026-09-${String(d).padStart(2, '0')}`, MODEL, 100_000); // USD 1.10 a day
    cf.billing.charge('2026-09-30T23:00:00Z', 40, 'Workers usage, September'); // 33 from analytics, 7 more billed
    cf.billing.charge('2026-10-01T00:30:00Z', 5, 'Workers Paid, October'); // the current month: not reconciled yet
    cf.billing.historyPageSize = 1; // paged to the end (the order is not documented)
    const r = await costs.ingestAccount(account.id);
    expect(r.state).toBe('ok');
    const sept = await costs.rows(account.id, { from: '2026-09-01', to: '2026-10-01' });
    expect(sum(sept)).toBe(40);
    expect(sum(sept.filter((x) => x.source === 'cloudflare-analytics'))).toBe(33);
    const adj = sept.filter((x) => x.source === 'cloudflare-billing');
    expect(adj).toHaveLength(30);
    expect(adj.every((x) => x.deploymentId === null && x.service === 'Cloudflare billing' && !x.estimated)).toBe(true);
    expect((await costs.rows(account.id, { from: '2026-10-01', to: '2026-11-01' })).filter((x) => x.source === 'cloudflare-billing')).toEqual([]);
    const [f] = await costs.fetches(account.id, 1);
    expect(f!.note).toMatchObject({ billing: [{ month: '2026-09', currency: 'USD', charged: 40, analytics: 33, adjustment: 7 }] });

    // Billed in EUR: the month's charges stand on their own, never converted, and its USD analytics rows go.
    cf.billing.clear();
    for (let d = 1; d <= 30; d++) cf.billing.neurons(`2026-09-${String(d).padStart(2, '0')}`, MODEL, 100_000);
    cf.billing.charge('2026-09-30T23:00:00Z', 30, 'Workers usage, September', 'EUR');
    clock = T0 + DAY;
    await costs.ingestAccount(account.id);
    const eur = await costs.rows(account.id, { from: '2026-09-01', to: '2026-10-01' });
    expect([...new Set(eur.map((x) => x.currency))]).toEqual(['EUR']);
    expect(sum(eur)).toBe(30);
  });

  it('Workers AI neurons in the analytics for a day match the metered neurons on usage_records within 1 %; a mismatch is reported', async () => {
    // Metered as the gateway meters a Workers AI turn: the model's neurons per million input and output tokens.
    const turns = [[1000, 500], [4000, 1200], [250, 90]] as const;
    let metered19 = 0;
    for (const [p, o] of turns) {
      const n = workersAiNeurons(MODEL, p, o)!;
      metered19 += n;
      await h.s.db('usage_records').insert({ id: ulid(), tenant_id: h.tenantId, workspace_id: null, user_id: null, kind: 'chat', model: MODEL, pool_id: poolId, prompt_tokens: p, output_tokens: o, thinking_tokens: 0, calc_calls: 0, gpu_ms: 0, day: 20261019, month: 202610, ts: Date.parse('2026-10-19T12:00:00Z'), neurons: n, cost_micros: n * 11, currency: 'USD', price_id: 'workers-ai:neurons@test' });
    }
    await h.s.db('usage_records').insert({ id: ulid(), tenant_id: h.tenantId, workspace_id: null, user_id: null, kind: 'chat', model: MODEL, pool_id: poolId, prompt_tokens: 0, output_tokens: 0, thinking_tokens: 0, calc_calls: 0, gpu_ms: 0, day: 20261018, month: 202610, ts: Date.parse('2026-10-18T12:00:00Z'), neurons: 1000, cost_micros: 11000, currency: 'USD', price_id: 'workers-ai:neurons@test' });
    // A record on another pool is not this account's.
    await h.s.db('usage_records').insert({ id: ulid(), tenant_id: h.tenantId, workspace_id: null, user_id: null, kind: 'chat', model: MODEL, pool_id: 'elsewhere', prompt_tokens: 0, output_tokens: 0, thinking_tokens: 0, calc_calls: 0, gpu_ms: 0, day: 20261019, month: 202610, ts: Date.parse('2026-10-19T12:00:00Z'), neurons: 99_999, cost_micros: 0, currency: 'USD', price_id: 'x' });
    // The fake's analytics are consistent with the metered usage on the 19th (within rounding), and 5 % high on the 18th.
    cf.billing.neurons('2026-10-19', MODEL, Math.round(metered19 * 1.004));
    cf.billing.neurons('2026-10-18', MODEL, 1050);
    await costs.ingestAccount(account.id);

    const r = await costs.neuronCheck(account.id, { from: '2026-10-18', to: '2026-10-20' });
    const d19 = r.days.find((d) => d.day === '2026-10-19')!;
    expect(d19).toMatchObject({ analytics: cf.billing.neuronsOn('2026-10-19'), metered: metered19, ok: true });
    expect(Math.abs(d19.analytics! - d19.metered) / d19.metered).toBeLessThanOrEqual(0.01);
    expect(r.mismatches).toEqual([expect.objectContaining({ day: '2026-10-18', analytics: 1050, metered: 1000, ok: false })]);

    // The check job reports the mismatch (audited) and nothing for a matching day.
    const jobs = await h.s.jobs.list(h.tenantId, { type: 'cloud.costs.neurons.check' });
    expect(jobs.length).toBeGreaterThan(0);
    const job = await h.s.jobs.enqueue({ tenantId: h.tenantId, type: 'cloud.costs.neurons.check', payload: { accountId: account.id, from: '2026-10-18', to: '2026-10-20' } });
    await h.s.jobs.runNow(job.id);
    expect((await h.s.jobs.get(h.tenantId, job.id))).toMatchObject({ state: 'succeeded' });
    const events = await h.s.audit.list(h.tenantId, { action: 'cloud.costs.neurons.mismatch' });
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events[0])).toContain('2026-10-18');
    expect(JSON.stringify(events[0])).not.toContain('2026-10-19');
  });

  it('a failing Workers AI query still writes the other products, marks the fetch partial, and the neuron check says unavailable', async () => {
    cf.billing.workers('2026-10-19', 'exprsn-cf-bill-web-api', 2_000_000, 10_000_000_000);
    cf.billing.containers('2026-10-19', 'exprsn-cf-bill-web-app', 3600, 0, 0);
    cf.billing.r2Storage('2026-10-19', 'media-bucket', 310e9);
    cf.billing.neurons('2026-10-19', MODEL, 500_000);
    await h.s.db('usage_records').insert({ id: ulid(), tenant_id: h.tenantId, workspace_id: null, user_id: null, kind: 'chat', model: MODEL, pool_id: poolId, prompt_tokens: 0, output_tokens: 0, thinking_tokens: 0, calc_calls: 0, gpu_ms: 0, day: 20261019, month: 202610, ts: Date.parse('2026-10-19T12:00:00Z'), neurons: 1000, cost_micros: 11000, currency: 'USD', price_id: 'workers-ai:neurons@test' });
    // The Workers AI dataset turns out not to be in the schema: Cloudflare answers an unknown-field error.
    cf.billing.unknownDatasets.add('aiInferenceAdaptiveGroups');

    const r = await costs.ingestAccount(account.id);
    expect(r).toMatchObject({ state: 'ok', requests: 3, partial: { workersAi: expect.stringMatching(/^Workers AI neurons were unavailable: .*unknown field "aiInferenceAdaptiveGroups"/) } });
    expect(r.partial!.workersAi).not.toContain(token);
    expect(cf.calls('POST /graphql')).toHaveLength(2);
    expect(cf.calls('GET /accounts/{id}/billing/history')).toHaveLength(1);

    const rows = await costs.rows(account.id, { from: '2026-10-19', to: '2026-10-20' });
    expect([...new Set(rows.map((x) => x.service))].sort()).toEqual(['Containers', 'R2', 'Workers']);
    const [f] = await costs.fetches(account.id, 1);
    expect(f).toMatchObject({ state: 'ok', note: { partial: { workersAi: expect.stringContaining('Workers AI neurons were unavailable') }, analytics: { neurons: false } } });
    const audits = await h.s.audit.list(h.tenantId, { action: 'cloud.costs.ingested' });
    const detail = JSON.stringify(audits);
    expect(detail).toContain('Workers AI neurons were unavailable');
    expect(detail).not.toContain(token);

    // The neuron check: the day's analytics are unavailable, not a mismatch (the job audits nothing).
    const check = await costs.neuronCheck(account.id, { from: '2026-10-19', to: '2026-10-20' });
    expect(check.mismatches).toEqual([]);
    expect(check.unavailable).toEqual([expect.objectContaining({ day: '2026-10-19', analytics: null, metered: 1000, state: 'unavailable' })]);
    const before = (await h.s.audit.list(h.tenantId, { action: 'cloud.costs.neurons.mismatch' })).length;
    const job = await h.s.jobs.enqueue({ tenantId: h.tenantId, type: 'cloud.costs.neurons.check', payload: { accountId: account.id, from: '2026-10-19', to: '2026-10-20' } });
    await h.s.jobs.runNow(job.id);
    expect(await h.s.jobs.get(h.tenantId, job.id)).toMatchObject({ state: 'succeeded' });
    expect((await h.s.audit.list(h.tenantId, { action: 'cloud.costs.neurons.mismatch' })).length).toBe(before);
  });

  it('serves the neuron check over the API to cost readers, for Cloudflare accounts only', async () => {
    cf.billing.neurons('2026-10-19', MODEL, 10);
    await costs.ingestAccount(account.id);
    await localUser(h, 'cfanalyst', ['finops-analyst'], 'internal');
    const analyst = await loginAdmin(h, 'cfanalyst');
    const res = await analyst.agent.get(`/api/admin/cloud/accounts/${account.id}/costs/neurons?from=2026-10-01&to=2026-10-20`).expect(200);
    expect(res.body).toMatchObject({ account: { id: account.id, provider: 'cloudflare' }, tolerance: 0.01, mismatches: [expect.objectContaining({ day: '2026-10-19', analytics: 10, metered: 0 })] });
    const other = await seedAccount(h, { provider: 'aws', mode: 'vaulted', name: 'aws-nocf', providerIds: { awsAccountId: '123456789012' } });
    await analyst.agent.get(`/api/admin/cloud/accounts/${other.id}/costs/neurons`).expect(400);
  });

  it('a token without Account Analytics Read fails the fetch, recorded, and calls nothing more', async () => {
    const weak = cf.addToken(['Billing Read'], { accountOwned: true }).value;
    const keep = token;
    token = weak;
    try {
      const r = await costs.ingestAccount(account.id);
      expect(r).toMatchObject({ state: 'failed', error: expect.stringMatching(/Cloudflare billing answered 403/) });
      expect(cf.calls('GET /accounts/{id}/billing/history')).toHaveLength(0);
    } finally {
      token = keep;
    }
  });
});
