import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Principal } from '../src/authz/policy.js';
import { costReasons, gpuScaleUp, OVERRIDE_MAX_HOURS } from '../src/cloud/budgets.js';
import type { DesiredResource, Plan, PlanStep } from '../src/cloud/graph.js';
import { capabilityTable, type CloudProvider, type ObservedResource, type ResourceSpec } from '../src/cloud/providers/types.js';
import { AccountSpend } from '../src/cloud/billing-spend.js';
import { EstimatedSpend, monthOf, type SpendFigure, type SpendSource } from '../src/cloud/spend.js';
import type { CloudAccount } from '../src/cloud/types.js';
import { seedAccount } from './cloud-credentials-helpers.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';

/*
 * 1.9.99-final, Sprint 58 (B-10602): budgets per cloud account. Alerts at 50, 80 and 100 % of actual and of forecast
 * spend as notices and webhooks, once each per month; the hard stop refuses a plan that adds monthly cost with
 * `budget_exceeded` (scale-down and destroy always allowed; a GPU node group above its minimum counts, open decision
 * 10); an override under dual control, with a reason, for at most 7 days. The provider is an in-memory adapter that
 * builds every type (no network, no real cloud); spend comes from a test source, and the estimate source is checked on
 * applied plans. Migrations 146, 148 and 152 are applied here by hand until they are registered. Sprint 59 (B-10603):
 * budgets read billing data (`AccountSpend`) for an account with a fresh billing fetch, estimates otherwise (155 applied by hand).
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const DAY = 86_400_000;

/** An adapter that builds every type in memory, at once. */
class MemProvider implements CloudProvider {
  readonly kind = 'digitalocean' as const;
  readonly capabilities = capabilityTable({});
  readonly store = new Map<string, ObservedResource>();
  supports() {
    return 'built' as const;
  }
  async identity() {
    return { ok: true } as never;
  }
  async checkPermissions() {
    return [];
  }
  private observe(spec: ResourceSpec, id = `mem-${spec.type}-${spec.name}`): ObservedResource {
    return { type: spec.type, providerId: id, name: spec.name, state: 'ready', tags: spec.tags, props: { ...(spec.props as Record<string, unknown>) } };
  }
  async find(_ctx: unknown, spec: ResourceSpec) {
    return [...this.store.values()].find((o) => o.type === spec.type && o.name === spec.name) ?? null;
  }
  async describe(_ctx: unknown, ref: { providerId: string }) {
    return this.store.get(ref.providerId) ?? null;
  }
  async list() {
    return [...this.store.values()];
  }
  async create(_ctx: unknown, spec: ResourceSpec) {
    const o = this.observe(spec);
    this.store.set(o.providerId, o);
    return { done: true as const, resource: o };
  }
  async update(_ctx: unknown, ref: { providerId: string }, spec: ResourceSpec) {
    const o = this.observe(spec, ref.providerId);
    this.store.set(o.providerId, o);
    return { done: true as const, resource: o };
  }
  async delete(_ctx: unknown, ref: { providerId: string }) {
    this.store.delete(ref.providerId);
    return { done: true as const, resource: null };
  }
  async poll() {
    return { state: 'succeeded' as const, resource: null };
  }
}

/** A month's cost per resource, for the test estimate. */
const costOf = (r: DesiredResource): number => {
  const s = r.spec as Record<string, unknown>;
  if (r.type === 'database') return 60;
  if (r.type === 'node_group') return s.gpu ? 100 * Number(s.min ?? 0) + (Number(s.max ?? 0) > Number(s.min ?? 0) ? 20 : 0) : 24 * Number(s.count ?? 1);
  if (r.type === 'vm') return 24;
  return 0;
};

/** A spend source the test sets. */
class TestSpend implements SpendSource {
  actual = 0;
  forecastAmount = 0;
  private fig(amount: number, currency = 'USD', now = Date.now()): SpendFigure {
    return { amount, currency, source: 'estimate', deployments: 1, excluded: [], month: monthOf(now).key, at: now };
  }
  async actualMonthToDate(_id: string, o: { currency?: string; now?: number } = {}) {
    return this.fig(this.actual, o.currency, o.now);
  }
  async forecast(_id: string, o: { currency?: string; now?: number } = {}) {
    return this.fig(this.forecastAmount, o.currency, o.now);
  }
}

const VALIDATED = { at: Date.now(), ok: true, identity: { ok: true }, features: [{ feature: 'deploy', name: 'Deploy', status: 'ok', required: [], missing: [], reason: null }] };

const principal = (h: Harness, userId: string, username: string): Principal => ({ kind: 'user', userId, tenantId: h.tenantId, tenantSlug: h.s.cfg.DEFAULT_TENANT, username, displayName: username, roles: ['system-admin'], clearance: 'restricted', scopes: null, sessionId: null, apiKeyId: null, mfa: true });

async function install(h: Harness, withBudgets = true): Promise<void> {
  if (!(await h.s.db.schema.hasTable('cloud_accounts'))) await (await import('../src/db/migrations/146_cloud_accounts.js')).up(h.s.db);
  if (!(await h.s.db.schema.hasTable('cloud_deployments'))) await (await import('../src/db/migrations/148_cloud_journal.js')).up(h.s.db);
  if (withBudgets && !(await h.s.db.schema.hasTable('cloud_budgets'))) await (await import('../src/db/migrations/152_cloud_budgets.js')).up(h.s.db);
  h.s.cloud.accounts.resetSchemaCache();
  h.s.cloud.deployments.resetSchemaCache();
  h.s.cloud.budgets.resetSchemaCache();
}

interface World {
  h: Harness;
  clients: Map<string, Awaited<ReturnType<typeof loginAdmin>>>;
  mem: MemProvider;
  spend: TestSpend;
  account: CloudAccount;
  a1: { principal: Principal; ip: string };
  a2: { principal: Principal; ip: string };
}

async function world(): Promise<World> {
  const h = await harness({ SERVICE_ALLOWED_HOSTS: '127.0.0.1' });
  await install(h);
  const mem = new MemProvider();
  Object.defineProperty(h.s.cloud, 'providers', { value: { providerFor: () => mem }, configurable: true });
  (h.s.cloud as { credentials: unknown }).credentials = { for: async () => ({ kind: 'token', token: 'test' }) };
  h.s.cloud.engine.options.sleep = async () => undefined;
  // The estimate: the desired graph's cost against what the deployment has now (no price API is called).
  (h.s.cloud as { estimatePlan: unknown }).estimatePlan = async (plan: Plan) => {
    const rows = (await h.s.cloud.deployments.resources(plan.deploymentId)).filter((r) => !['deleted', 'missing', 'planned'].includes(r.state));
    const before = rows.reduce((n, r) => n + costOf(r.desired), 0);
    const deleted = new Set(plan.steps.filter((x) => x.action === 'delete').map((x) => x.key));
    const after = plan.purpose === 'destroy' ? 0 : plan.desired.filter((r) => !deleted.has(r.key)).reduce((n, r) => n + costOf(r), 0);
    return { monthly: after, delta: after - before, currency: 'USD', prices: [] };
  };
  const spend = new TestSpend();
  h.s.cloud.budgets.spend = spend;
  const seeded = await seedAccount(h, { provider: 'digitalocean', mode: 'vaulted', name: 'do-budget', providerIds: { doTeamId: 'team-1' }, refs: { token: 'vault:cloud/do-budget#token' } });
  await h.s.db('cloud_accounts').where({ id: seeded.id }).update({ validation: JSON.stringify(VALIDATED) });
  const account = (await h.s.cloud.accounts.get(seeded.id))!;
  const u1 = await localUser(h, 'root', ['system-admin'], 'restricted');
  const u2 = await localUser(h, 'root2', ['system-admin'], 'restricted');
  return { h, clients: new Map(), mem, spend, account, a1: { principal: principal(h, u1.id, 'root'), ip: '127.0.0.1' }, a2: { principal: principal(h, u2.id, 'root2'), ip: '127.0.0.1' } };
}

const net: DesiredResource = { key: 'core', type: 'network', spec: { cidr: '10.20.0.0/20' }, dependsOn: [], protect: false, region: null };
// Sprint 59 (B-10307): created without deletion protection, so the scale-down below may delete it by plan.
const db: DesiredResource = { key: 'db', type: 'database', spec: { engine: 'postgres', size: 'db-s-2vcpu-4gb', publicAccess: false, privateEndpoint: true, deletionProtection: false }, dependsOn: [], network: 'core', protect: false, region: null };
const gpu = (min: number, max: number): DesiredResource => ({ key: 'gpu-l4', type: 'node_group', spec: { role: 'gpu', gpu: 'h100', size: 'gpu-h100x1-80gb', min, max, busyHours: 0 }, dependsOn: [], protect: false, region: null });

/** A signed-in admin (enrolled once per harness, then reused). */
async function admin(w: World, username: string) {
  let c = w.clients.get(username);
  if (!c) {
    c = await loginAdmin(w.h, username);
    w.clients.set(username, c);
  }
  return c;
}

let seq = 0;
async function applyNow(w: World, deploymentId: string, desired: DesiredResource[], a = w.a1) {
  const plan = await w.h.s.cloud.plans.create(a, deploymentId, desired);
  const { jobId } = await w.h.s.cloud.plans.apply(a, plan.id, plan.hash);
  const outcome = await w.h.s.cloud.engine.apply(plan.id, { jobId, onBehalfOf: a.principal.userId });
  return { plan, outcome };
}

// ---------------------------------------------------------------- what counts as adding cost (pure)

describe('what adds monthly cost (B-10602, open decision 10)', () => {
  const step = (o: Partial<PlanStep>): PlanStep => ({ key: 'x', type: 'database', region: 'fra1', protect: false, dependsOn: [], providerId: null, action: 'create', changes: [], ...o });
  const plan = (o: Partial<Pick<Plan, 'purpose' | 'estimate' | 'steps' | 'desired'>>) => ({ purpose: 'apply' as const, estimate: null, steps: [], desired: [], ...o });

  it('a positive delta adds cost; a zero or negative one does not; destroy never does', () => {
    expect(costReasons(plan({ estimate: { monthly: 60, delta: 60, currency: 'USD', prices: [] } }), 'USD')[0]).toMatch(/adds 60.00 USD a month/);
    expect(costReasons(plan({ estimate: { monthly: 10, delta: 0, currency: 'USD', prices: [] } }), 'USD')).toEqual([]);
    expect(costReasons(plan({ estimate: { monthly: 10, delta: -50, currency: 'USD', prices: [] } }), 'USD')).toEqual([]);
    expect(costReasons(plan({ purpose: 'destroy', estimate: { monthly: 0, delta: -50, currency: 'USD', prices: [] }, steps: [step({ action: 'delete' })] }), 'USD')).toEqual([]);
    // No estimate: creating something priced counts; a firewall or a record does not.
    expect(costReasons(plan({ steps: [step({ type: 'database' })] }), 'USD')[0]).toMatch(/no estimate/);
    expect(costReasons(plan({ steps: [step({ type: 'firewall' })] }), 'USD')).toEqual([]);
    // An estimate in another currency cannot show the plan adds nothing (open decision 17: no conversion).
    expect(costReasons(plan({ estimate: { monthly: 10, delta: 0, currency: 'EUR', prices: [] } }), 'USD')[0]).toMatch(/EUR/);
  });

  it('a GPU node group scaled above its minimum counts whatever the estimate says', () => {
    const g = gpu(0, 2);
    expect(gpuScaleUp(step({ key: g.key, type: 'node_group', action: 'update', changes: [{ path: 'min', before: 0, after: 1, forcesReplace: false }] }), g.spec)).toMatch(/scales up \(min 0 → 1\)/);
    expect(gpuScaleUp(step({ key: g.key, type: 'node_group', action: 'update', changes: [{ path: 'max', before: 2, after: 4, forcesReplace: false }] }), g.spec)).toMatch(/max 2 → 4/);
    expect(gpuScaleUp(step({ key: g.key, type: 'node_group', action: 'update', changes: [{ path: 'min', before: 2, after: 0, forcesReplace: false }] }), g.spec)).toBeNull();
    expect(gpuScaleUp(step({ key: g.key, type: 'node_group', action: 'create' }), g.spec)).toMatch(/adds nodes/);
    expect(gpuScaleUp(step({ key: 'app', type: 'node_group', action: 'update', changes: [{ path: 'count', before: 2, after: 3, forcesReplace: false }] }), { role: 'app', count: 3 })).toBeNull();
    const up = { estimate: { monthly: 100, delta: 0, currency: 'USD', prices: [] }, steps: [step({ key: g.key, type: 'node_group', action: 'update', changes: [{ path: 'min', before: 0, after: 1, forcesReplace: false }] })], desired: [gpu(1, 2)] };
    expect(costReasons(plan(up), 'USD')).toEqual([expect.stringMatching(/GPU node group gpu-l4 scales up/)]);
  });
});

// ---------------------------------------------------------------- the service and routes

describe('budgets, alerts, the hard stop and overrides (B-10602)', () => {
  let w: World;

  beforeAll(async () => {
    w = await world();
  });
  afterAll(async () => {
    await w.h.close();
  });

  it('nothing changes without a budget: no alert, no plan refused', async () => {
    const d = await w.h.s.cloud.deployments.create(w.a1, { name: `dep-${++seq}`, accountId: w.account.id });
    w.spend.actual = 10_000;
    w.spend.forecastAmount = 10_000;
    expect(await w.h.s.cloud.budgets.evaluate(w.account.id)).toEqual([]);
    const plan = await w.h.s.cloud.plans.create(w.a1, d.id, [net, db]);
    expect(plan.blockers).toEqual([]);
    expect(plan.applicable).toBe(true);
  });

  it('alerts at 50, 80 and 100 % of actual and of forecast, as notices and webhooks, once each per month', async () => {
    const h = w.h;
    const fin = await localUser(h, 'finops', ['finops-analyst']);
    const { row: hook } = await h.s.webhooks.create(h.tenantId, 'test', { name: 'budgets', url: 'http://127.0.0.1:9/hook', events: ['cloud.budget.*'], maxLabel: 'internal' });
    w.spend.actual = 0;
    w.spend.forecastAmount = 0;
    const set = await h.s.cloud.budgets.set(w.a1, w.account.id, { amount: 1000, hardStop: 'actual' });
    expect(set).toMatchObject({ budget: { amount: 1000, currency: 'USD', hardStop: 'actual' }, pctActual: 0, stopped: false, alerts: [] });
    const now = Date.UTC(2026, 9, 20, 12);
    w.spend.actual = 550;
    w.spend.forecastAmount = 850;
    const first = await h.s.cloud.budgets.evaluate(w.account.id, now);
    expect(first.map((a) => `${a.basis}:${a.threshold}`).sort()).toEqual(['actual:50', 'forecast:50', 'forecast:80']);
    // The same spend again sends nothing.
    expect(await h.s.cloud.budgets.evaluate(w.account.id, now + 60_000)).toEqual([]);
    w.spend.actual = 1010;
    w.spend.forecastAmount = 1400;
    const second = await h.s.cloud.budgets.evaluate(w.account.id, now + 2 * DAY);
    expect(second.map((a) => `${a.basis}:${a.threshold}`).sort()).toEqual(['actual:100', 'actual:80', 'forecast:100']);
    expect(await h.s.cloud.budgets.evaluate(w.account.id, now + 3 * DAY)).toEqual([]);
    // Notices to FinOps readers and cloud admins, kind cloud.budget; the 100 % ones by email too.
    const notes = (await h.s.db('notifications').where({ kind: 'cloud.budget', user_id: fin.id })) as { title: string }[];
    expect(notes).toHaveLength(6);
    expect(notes.map((n) => n.title)).toEqual(expect.arrayContaining(['do-budget: 50 % of its budget spent', 'do-budget: 80 % of its budget forecast', 'do-budget: 100 % of its budget spent']));
    // The audit event cloud.budget.alert, which the webhook subscribed to cloud.budget.* receives.
    const audits = await h.s.audit.list(h.tenantId, { action: 'cloud.budget.alert' });
    expect(audits).toHaveLength(6);
    expect(audits.map((e) => e.detail)).toEqual(expect.arrayContaining([expect.objectContaining({ basis: 'actual', threshold: 100, spend: 1010, amount: 1000, currency: 'USD', stopped: true })]));
    await new Promise((r) => setTimeout(r, 100));
    const deliveries = (await h.s.db('webhook_deliveries').where({ webhook_id: hook.id })) as { id: string; payload: string }[];
    const types = await Promise.all(deliveries.map(async (d) => (JSON.parse(await h.s.keys.open(h.tenantId, d.payload, `webhook-delivery:${d.id}`)) as { type: string }).type));
    expect(types.filter((t) => t === 'cloud.budget.alert')).toHaveLength(6);
    // A new month starts afresh.
    const next = await h.s.cloud.budgets.evaluate(w.account.id, Date.UTC(2026, 10, 2));
    expect(next).toHaveLength(6);
    // A changed amount starts this month's alerts afresh too.
    await h.s.cloud.budgets.set(w.a1, w.account.id, { amount: 5000, hardStop: 'actual' });
    const st = await h.s.cloud.budgets.statusOf((await h.s.cloud.budgets.get(w.account.id))!);
    expect(st).toMatchObject({ pctActual: 20.2, pctForecast: 28, stopped: false });
  });

  it('past 100 %, a plan adding a database is refused with budget_exceeded; it is accepted after a second admin approves an override', async () => {
    const h = w.h;
    const d = await h.s.cloud.deployments.create(w.a1, { name: `dep-${++seq}`, accountId: w.account.id });
    await applyNow(w, d.id, [net]);
    await h.s.cloud.budgets.set(w.a1, w.account.id, { amount: 100, hardStop: 'actual' });
    w.spend.actual = 120;
    w.spend.forecastAmount = 200;
    const plan = await h.s.cloud.plans.create(w.a1, d.id, [net, db]);
    expect(plan.estimate).toMatchObject({ delta: 60 });
    expect(plan.applicable).toBe(false);
    expect(plan.blockers).toEqual([expect.stringMatching(/^budget_exceeded: the account is at 120 % of its 100\.00 USD monthly budget .*adds 60\.00 USD a month/)]);
    const refused = await h.s.cloud.plans.apply(w.a1, plan.id, plan.hash).catch((e: unknown) => e);
    expect(refused).toMatchObject({ status: 409, extensions: { reason: 'budget_exceeded', budget: { amount: 100, actual: 120, stopped: true, hardStop: 'actual' } } });
    expect((await h.s.audit.list(h.tenantId, { action: 'cloud.plan.refused' })).map((e) => e.detail)).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'budget_exceeded' })]));

    // The override, through the routes: a reason, at most 7 days, approved only by a second admin with a recent sign-in.
    const c1 = await admin(w, 'root');
    const c2 = await admin(w, 'root2');
    const base = `/api/admin/cloud/accounts/${w.account.id}/budget`;
    const status = await c1.agent.get(base).expect(200);
    expect(status.body).toMatchObject({ installed: true, budget: { amount: 100 }, status: { stopped: true, pctActual: 120 }, mayChange: true });
    await c1.agent.post(`${base}/overrides`).set('x-csrf-token', c1.csrf).send({ reason: 'short', hours: 24 }).expect(400);
    await c1.agent.post(`${base}/overrides`).set('x-csrf-token', c1.csrf).send({ reason: 'Quarter-end load test needs a database', hours: OVERRIDE_MAX_HOURS + 1 }).expect(400);
    const prop = await c1.agent.post(`${base}/overrides`).set('x-csrf-token', c1.csrf).send({ reason: 'Quarter-end load test needs a database', hours: 48 }).expect(202);
    expect(prop.body).toMatchObject({ state: 'pending', hours: 48, active: false });
    await c1.agent.post(`${base}/overrides`).set('x-csrf-token', c1.csrf).send({ reason: 'A second one at the same time', hours: 4 }).expect(409);
    const self = await c1.agent.post(`${base}/overrides/${prop.body.id}/approve`).set('x-csrf-token', c1.csrf).send({}).expect(403);
    expect(self.body.detail).toMatch(/Dual control/);
    // Still refused while it waits.
    expect(await h.s.cloud.plans.apply(w.a1, plan.id, plan.hash).catch((e: unknown) => (e as { extensions?: { reason?: string } }).extensions?.reason)).toBe('budget_exceeded');
    const ok = await c2.agent.post(`${base}/overrides/${prop.body.id}/approve`).set('x-csrf-token', c2.csrf).send({ note: 'agreed' }).expect(200);
    expect(ok.body).toMatchObject({ state: 'approved', active: true });
    expect(ok.body.expiresAt - ok.body.startsAt).toBe(48 * 3_600_000);
    const audits = (await h.s.audit.list(h.tenantId, {})).filter((e) => e.action.startsWith('cloud.budget.override.')).map((e) => e.action);
    expect(audits).toEqual(expect.arrayContaining(['cloud.budget.override.proposed', 'cloud.budget.override.approved']));
    // The same plan, by its hash, is accepted now.
    const { jobId } = await h.s.cloud.plans.apply(w.a1, plan.id, plan.hash);
    const out = await h.s.cloud.engine.apply(plan.id, { jobId, onBehalfOf: w.a1.principal.userId });
    expect(out.state).toBe('applied');
    expect([...w.mem.store.values()].some((o) => o.type === 'database')).toBe(true);

    // The override ends by itself: past its end the stop applies again, and the check marks it expired once.
    const later = ok.body.expiresAt + 1000;
    expect(await h.s.cloud.budgets.decide({ purpose: 'apply', estimate: { monthly: 200, delta: 60, currency: 'USD', prices: [] }, steps: [], desired: [] }, d, later)).toMatchObject({ refused: true });
    expect(await h.s.cloud.budgets.expire(later)).toEqual([ok.body.id]);
    expect(await h.s.cloud.budgets.expire(later)).toEqual([]);
    expect((await h.s.cloud.budgets.overrides(w.account.id))[0]).toMatchObject({ id: ok.body.id, state: 'expired', active: false });
  });

  it('scale-down and destroy are always allowed past the stop; a GPU node group above its minimum is refused', async () => {
    const h = w.h;
    await h.s.cloud.budgets.set(w.a1, w.account.id, { amount: 100, hardStop: 'actual' });
    w.spend.actual = 500;
    const d = await h.s.cloud.deployments.create(w.a1, { name: `dep-${++seq}`, accountId: w.account.id });
    // Before the stop (spend low), build a database and a GPU group at its minimum of 0.
    w.spend.actual = 0;
    await applyNow(w, d.id, [net, db, gpu(0, 0)]);
    w.spend.actual = 500;
    // Scaling the GPU group above its minimum: refused, whatever the estimate.
    const scale = await h.s.cloud.plans.create(w.a1, d.id, [net, db, gpu(1, 2)]);
    expect(scale.blockers.join(' ')).toMatch(/budget_exceeded: .*GPU node group gpu-l4/);
    // Scale-down (the database removed): allowed.
    const down = await h.s.cloud.plans.create(w.a1, d.id, [net, gpu(0, 0)]);
    expect(down.estimate).toMatchObject({ delta: -60 });
    expect(down.blockers).toEqual([]);
    const { jobId } = await h.s.cloud.plans.apply(w.a1, down.id, down.hash);
    expect((await h.s.cloud.engine.apply(down.id, { jobId, onBehalfOf: w.a1.principal.userId })).state).toBe('applied');
    // Destroy: allowed.
    const destroy = await h.s.cloud.plans.destroyAll(w.a1, d.id);
    expect(destroy.blockers).toEqual([]);
    await h.s.cloud.plans.apply(w.a1, destroy.id, destroy.hash);
    // hardStop off: alerts only.
    await h.s.cloud.budgets.set(w.a1, w.account.id, { amount: 100, hardStop: 'off' });
    const d2 = await h.s.cloud.deployments.create(w.a1, { name: `dep-${++seq}`, accountId: w.account.id });
    expect((await h.s.cloud.plans.create(w.a1, d2.id, [net, db])).blockers).toEqual([]);
    // hardStop forecast: stops on the forecast.
    await h.s.cloud.budgets.set(w.a1, w.account.id, { amount: 100, hardStop: 'forecast' });
    w.spend.actual = 10;
    w.spend.forecastAmount = 150;
    expect((await h.s.cloud.plans.create(w.a1, d2.id, [net, db])).blockers.join(' ')).toMatch(/budget_exceeded: the account is at 150 %/);
  });

  it('who may do what: finops:manage sets, finops:read reads, a revoked override ends at once', async () => {
    const h = w.h;
    const reader = await localUser(h, 'reader', ['finops-analyst']);
    const { login } = await import('./helpers.js');
    const r = await login(h, 'reader');
    const base = `/api/admin/cloud/accounts/${w.account.id}/budget`;
    const got = await r.agent.get(base).expect(200);
    // A platform account: a FinOps analyst reads it but changes nothing.
    expect(got.body).toMatchObject({ budget: { amount: 100 }, mayChange: false });
    await r.agent.put(base).set('x-csrf-token', r.res.body.csrf).send({ amount: 10 }).expect(403);
    expect((await r.agent.get('/api/admin/cloud/budgets').expect(200)).body.budgets[0]).toMatchObject({ account: { id: w.account.id, name: 'do-budget' }, status: { budget: { amount: 100 } }, pending: [] });
    expect(reader.id).toBeTruthy();
    // An override proposed by one, approved by the other, then revoked at once.
    w.spend.forecastAmount = 150;
    const o = await h.s.cloud.budgets.propose(w.a2, w.account.id, { reason: 'Second override for the revoke path', hours: 2 });
    await expect(h.s.cloud.budgets.approve(w.a2, w.account.id, o.id, null)).rejects.toMatchObject({ status: 403 });
    const ap = await h.s.cloud.budgets.approve(w.a1, w.account.id, o.id, null);
    expect(ap.active).toBe(true);
    const rv = await h.s.cloud.budgets.revoke(w.a2, w.account.id, o.id, 'done');
    expect(rv).toMatchObject({ state: 'revoked', active: false });
    expect(await h.s.cloud.budgets.activeOverride(w.account.id)).toBeNull();
    const rm = await admin(w, 'root');
    await rm.agent.delete(base).set('x-csrf-token', rm.csrf).expect(204);
    expect(await h.s.cloud.budgets.get(w.account.id)).toBeNull();
    expect((await h.s.audit.list(h.tenantId, { action: 'cloud.budget.removed' })).length).toBe(1);
  });

  it('the job and the schedule: cloud.budgets.check is registered and runs every CLOUD_BUDGET_CHECK_MINUTES', async () => {
    expect(w.h.s.jobs.types().map((x) => x.type)).toContain('cloud.budgets.check');
    // `startSchedules` adds it in a running server.
    w.h.s.cloud.budgets.schedule(w.h.s.scheduler, w.h.s.cfg.CLOUD_BUDGET_CHECK_MINUTES);
    expect(w.h.s.scheduler.list().find((e) => e.name === 'cloud.budgets.check')).toMatchObject({ everyMs: 60 * 60_000 });
    expect(await w.h.s.cloud.budgets.check()).toMatchObject({ accounts: 0 });
  });
});

// ---------------------------------------------------------------- spend from applied plans' estimates

describe('the estimate spend source (until billing data arrives in Sprint 59)', () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
  });
  afterAll(async () => {
    await w.h.close();
  });

  it('prorates each applied plan\'s monthly estimate over the UTC month, and forecasts at the current run rate', async () => {
    const h = w.h;
    const d = await h.s.cloud.deployments.create(w.a1, { name: `dep-${++seq}`, accountId: w.account.id });
    const one = await applyNow(w, d.id, [net, db]); // 60 a month
    const two = await applyNow(w, d.id, [net, db, gpu(1, 1)]); // 160 a month
    const oct1 = Date.UTC(2026, 9, 1);
    await h.s.db('cloud_plans').where({ id: one.plan.id }).update({ applied_at: Date.UTC(2026, 8, 20) }); // last month
    await h.s.db('cloud_plans').where({ id: two.plan.id }).update({ applied_at: oct1 + 15 * DAY });
    const src = new EstimatedSpend(() => h.s);
    const now = oct1 + 20 * DAY;
    const len = 31 * DAY;
    const actual = await src.actualMonthToDate(w.account.id, { currency: 'USD', now });
    expect(actual).toMatchObject({ source: 'estimate', month: '2026-10', deployments: 1, excluded: [] });
    expect(actual.amount).toBeCloseTo((60 * 15 * DAY) / len + (160 * 5 * DAY) / len, 1);
    const fc = await src.forecast(w.account.id, { currency: 'USD', now });
    expect(fc.amount).toBeCloseTo(actual.amount + (160 * 11 * DAY) / len, 1);
    // Another currency is left out, not converted.
    const eur = await src.actualMonthToDate(w.account.id, { currency: 'EUR', now });
    expect(eur.amount).toBe(0);
    expect(eur.excluded[0]).toMatchObject({ reason: expect.stringMatching(/Estimated in USD, not EUR/) });
    // A destroy ends the run rate.
    const destroy = await h.s.cloud.plans.destroyAll(w.a1, d.id);
    const { jobId } = await h.s.cloud.plans.apply(w.a1, destroy.id, destroy.hash);
    await h.s.cloud.engine.apply(destroy.id, { jobId, onBehalfOf: w.a1.principal.userId });
    await h.s.db('cloud_plans').where({ id: destroy.id }).update({ applied_at: oct1 + 18 * DAY });
    const after = await src.forecast(w.account.id, { currency: 'USD', now });
    expect(after.amount).toBeCloseTo((60 * 15 * DAY) / len + (160 * 3 * DAY) / len, 1);
  });
});

// ---------------------------------------------------------------- spend from billing data (Sprint 59, B-10603)

describe('budgets on actuals: billing data when present, estimates otherwise, and the view says which (B-10603)', () => {
  let w: World;
  beforeAll(async () => {
    w = await world();
    if (!(await w.h.s.db.schema.hasTable('cloud_costs'))) await (await import('../src/db/migrations/155_cloud_costs.js')).up(w.h.s.db);
    w.h.s.cloud.costs.resetSchemaCache();
    w.h.s.cloud.budgets.spend = new AccountSpend(() => w.h.s);
  });
  afterAll(async () => {
    await w.h.close();
  });

  it('an account with a fresh billing fetch reads its ingested rows; one without reads the estimates; the hard stop works on either', async () => {
    const h = w.h;
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10);
    const d = await h.s.cloud.deployments.create(w.a1, { name: `dep-${++seq}`, accountId: w.account.id });
    await applyNow(w, d.id, [net, db]); // 60 a month, estimated
    await h.s.cloud.budgets.set(w.a1, w.account.id, { amount: 100, hardStop: 'actual' });

    // No billing data yet: the estimates, and the view says why.
    let st = (await h.s.cloud.budgets.view(w.a1.principal, w.account.id)).status!;
    expect(st.actual).toMatchObject({ source: 'estimate', basis: 'No billing data has been fetched for this account yet.' });
    expect(st.source).toMatch(/^Estimated from the applied plans of the account's deployments, prorated over the month\. No billing data/);
    expect(st.stopped).toBe(false);

    // Billing rows for today and a successful fetch: the budget reads the bill (120 > 100: the hard stop engages).
    await h.s.db('cloud_costs').insert([
      { id: ulid(), account_id: w.account.id, provider: 'digitalocean', deployment_id: d.id, allocation: '1', service: 'Droplets', day: today, amount: '110.5', currency: 'USD', source: 'digitalocean-preview', estimated: true, fetched_at: now },
      { id: ulid(), account_id: w.account.id, provider: 'digitalocean', deployment_id: null, allocation: '', service: 'Spaces', day: today, amount: '9.5', currency: 'USD', source: 'digitalocean-preview', estimated: true, fetched_at: now },
      { id: ulid(), account_id: w.account.id, provider: 'digitalocean', deployment_id: null, allocation: '', service: 'Other', day: today, amount: '50', currency: 'EUR', source: 'digitalocean-preview', estimated: true, fetched_at: now }
    ]);
    await h.s.db('cloud_cost_fetches').insert({ id: ulid(), account_id: w.account.id, provider: 'digitalocean', fetch_key: today, manual: false, state: 'ok', attempts: 1, requests: 3, rows: 3, started_at: now, finished_at: now });
    st = (await h.s.cloud.budgets.view(w.a1.principal, w.account.id)).status!;
    expect(st.actual).toMatchObject({ source: 'billing', amount: 120, billedThrough: today, excluded: [{ deploymentId: '', reason: 'Billed in EUR, not USD; not converted.' }] });
    expect(st.source).toMatch(/^Billing data from the provider, billed through \d{4}-\d{2}-\d{2}; the forecast adds the applied plans' run rate/);
    expect(st.forecast.amount).toBeGreaterThanOrEqual(120);
    expect(st.stopped).toBe(true);
    // The route shows the same.
    const c = await admin(w, 'root');
    const view = await c.agent.get(`/api/admin/cloud/accounts/${w.account.id}/budget`).expect(200);
    expect(view.body.status.actual.source).toBe('billing');
    expect(view.body.status.source).toMatch(/^Billing data/);
    // The hard stop and the alerts did not change: a plan adding cost is refused on the billed spend.
    const decision = await h.s.cloud.budgets.decide({ purpose: 'apply', estimate: { monthly: 120, delta: 60, currency: 'USD', prices: [] }, steps: [], desired: [] }, { accountId: w.account.id });
    expect(decision).toMatchObject({ refused: true });
    expect((await h.s.cloud.budgets.evaluate(w.account.id)).map((a) => `${a.basis}:${a.threshold}`)).toEqual(expect.arrayContaining(['actual:50', 'actual:80', 'actual:100']));
    expect((await h.s.audit.list(h.tenantId, { action: 'cloud.budget.alert' })).at(-1)!.detail).toMatchObject({ source: 'billing' });
    await h.s.cloud.budgets.remove(w.a1, w.account.id);
  });
});

// ---------------------------------------------------------------- without migration 152

describe('without migration 152', () => {
  it('the routes answer 503 migration_pending and no plan is refused', async () => {
    const h = await harness({ SERVICE_ALLOWED_HOSTS: '127.0.0.1' });
    try {
      await install(h, false);
      // 152 is registered (2026-10-20), so the harness has it: roll it back to see the service without it.
      await (await import('../src/db/migrations/152_cloud_budgets.js')).down(h.s.db);
      h.s.cloud.budgets.resetSchemaCache();
      const seeded = await seedAccount(h, { provider: 'digitalocean', mode: 'vaulted', name: 'do-none', providerIds: { doTeamId: 't' }, refs: { token: 'vault:cloud/do-none#token' } });
      await localUser(h, 'root', ['system-admin'], 'restricted');
      const c = await loginAdmin(h, 'root');
      const r = await c.agent.get(`/api/admin/cloud/accounts/${seeded.id}/budget`).expect(503);
      expect(r.body.reason ?? r.body.extensions?.reason).toBe('migration_pending');
      await c.agent.put(`/api/admin/cloud/accounts/${seeded.id}/budget`).set('x-csrf-token', c.csrf).send({ amount: 10 }).expect(503);
      expect(await h.s.cloud.budgets.decide({ purpose: 'apply', estimate: { monthly: 1, delta: 1, currency: 'USD', prices: [] }, steps: [], desired: [] }, { accountId: seeded.id })).toBeNull();
      expect(await h.s.cloud.budgets.evaluate(seeded.id)).toEqual([]);
      expect(await h.s.cloud.budgets.check()).toEqual({ accounts: 0, alerts: 0, expired: 0 });
    } finally {
      await h.close();
    }
  });
});
