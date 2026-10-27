/*
 * 1.9.0, Sprint 51 (B-162): the plan catalogue with dual control, tenants' subscriptions (trial, renewal, cancel at
 * period end, pause and resume), proration now or at renewal in exact minor units, the history read back by `at()`
 * and `periods()`, a tenant without a subscription left as it was, and the audit trail.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';
import { up as m124 } from '../src/db/migrations/124_billing_plans_subscriptions.js';
import { periodAt, prorate, type SubscriptionActor } from '../src/billing/subscriptions.js';
import type { PlanActor } from '../src/billing/plans.js';

const D = (iso: string) => Date.parse(iso);
const DAY = 86_400_000;

describe('B-162 pure parts', () => {
  it('prorates exactly, half away from zero', () => {
    expect(prorate(3, 1, 2)).toBe(2);
    expect(prorate(-3, 1, 2)).toBe(-2);
    expect(prorate(1000, 1, 3)).toBe(333);
    expect(prorate(2000, 1, 3)).toBe(667);
    expect(prorate(1000, 3, 3)).toBe(1000);
    expect(prorate(1000, 0, 3)).toBe(0);
    // No floating-point drift on large amounts: 10^12 × 1/3.
    expect(prorate(1e12, 1, 3)).toBe(333_333_333_333);
  });

  it('starts the first period at the start and ends it at the first anchor', () => {
    const c = { kind: 'monthly' as const, months: 1, anchorDay: 1 };
    expect(periodAt(D('2026-01-10T12:00:00Z'), c, D('2026-01-20T00:00:00Z'))).toEqual({ start: D('2026-01-10T12:00:00Z'), end: D('2026-02-01T00:00:00Z'), fullStart: D('2026-01-01T00:00:00Z') });
    expect(periodAt(D('2026-01-10T12:00:00Z'), c, D('2026-03-05T00:00:00Z'))).toEqual({ start: D('2026-03-01T00:00:00Z'), end: D('2026-04-01T00:00:00Z'), fullStart: D('2026-03-01T00:00:00Z') });
    const q = { kind: 'quarterly' as const, months: 3, anchorDay: 15 };
    expect(periodAt(D('2026-02-20T00:00:00Z'), q, D('2026-06-01T00:00:00Z'))).toEqual({ start: D('2026-05-15T00:00:00Z'), end: D('2026-08-15T00:00:00Z'), fullStart: D('2026-05-15T00:00:00Z') });
  });
});

describe('B-162 plans and subscriptions', () => {
  let h: Harness;
  let a: PlanActor;
  let b: PlanActor;
  let platform: SubscriptionActor;

  const price = (priceMinor: number, seatPriceMinor = 0, includedSeats = 0, currency = 'USD', months = 1) => ({ currency, months, priceMinor, seatPriceMinor, includedSeats });
  /** A plan approved by a second admin, in force from the epoch (so dated tests see it). */
  const plan = async (key: string, prices: ReturnType<typeof price>[], opts: { trialDays?: number; visibility?: 'visible' | 'private'; allowances?: Record<string, number> } = {}) => {
    const { plan: p } = await h.s.plans.create(a, { key, name: key.toUpperCase(), visibility: opts.visibility ?? 'visible', trialDays: opts.trialDays ?? 0, prices, allowances: opts.allowances ?? {}, entitlements: { 'feature.x': true } });
    await h.s.plans.approve(b, p.id, 1, null);
    await h.s.db('billing_plan_versions').where({ plan_id: p.id }).update({ effective_from: 0 });
    return p;
  };

  beforeEach(async () => {
    h = await harness();
    await m124(h.s.db);
    const ua = await localUser(h, 'pa', ['system-admin'], 'restricted');
    const ub = await localUser(h, 'pb', ['system-admin'], 'restricted');
    a = { tenantId: h.tenantId, userId: ua.id, actor: { user: ua.id, username: 'pa' } };
    b = { tenantId: h.tenantId, userId: ub.id, actor: { user: ub.id, username: 'pb' } };
    platform = { ...a, platform: true };
  });
  afterEach(async () => {
    await h.close();
  });

  it('keeps the catalogue under dual control for platform admins, in a fresh sign-in', async () => {
    const pa = await loginAdmin(h, 'pa');
    const pb = await loginAdmin(h, 'pb');
    const send = (c: typeof pa, m: 'post' | 'patch', p: string, body: object = {}) => c.agent[m](p).set('x-csrf-token', c.csrf).send(body);
    const created = (await send(pa, 'post', '/api/admin/billing/plans', { key: 'team', name: 'Team', prices: [price(5000, 1000, 3)], allowances: { prompt_tokens: 1_000_000 }, entitlements: { 'seats.max': 50 } }).expect(201)).body;
    expect(created).toMatchObject({ key: 'team', currentVersion: null, subscribable: false, pending: { version: 1, state: 'pending' } });
    // The proposer cannot approve; a second platform admin does.
    const own = await send(pa, 'post', `/api/admin/billing/plans/${created.id}/versions/1/approve`).expect(403);
    expect(own.body.step).toBe('dual-control');
    const approved = (await send(pb, 'post', `/api/admin/billing/plans/${created.id}/versions/1/approve`, { note: 'checked' }).expect(200)).body;
    expect(approved).toMatchObject({ currentVersion: 1, subscribable: true, current: { prices: [price(5000, 1000, 3)], allowances: { prompt_tokens: 1_000_000 } } });
    // A price change is a new version; only one waits at a time; the proposer withdraws, another rejects.
    await send(pb, 'post', `/api/admin/billing/plans/${created.id}/versions`, { prices: [price(6000, 1000, 3)] }).expect(201);
    await send(pa, 'post', `/api/admin/billing/plans/${created.id}/versions`, { prices: [price(7000)] }).expect(409);
    expect((await send(pb, 'post', `/api/admin/billing/plans/${created.id}/versions/2/reject`).expect(200)).body.state).toBe('withdrawn');
    await send(pb, 'post', `/api/admin/billing/plans/${created.id}/versions`, { prices: [price(6000, 1000, 3)] }).expect(201);
    expect((await send(pa, 'post', `/api/admin/billing/plans/${created.id}/versions/3/reject`, { note: 'too much' }).expect(200)).body.state).toBe('rejected');
    // Bad input: one price per currency and cycle, closed entitlements.
    await send(pa, 'post', `/api/admin/billing/plans/${created.id}/versions`, { prices: [price(1), price(2)] }).expect(400);
    await send(pa, 'post', `/api/admin/billing/plans/${created.id}/versions`, { prices: [price(1)], entitlements: { nested: { a: 1 } } }).expect(400);
    // Name, visibility and state change at once.
    expect((await send(pa, 'patch', `/api/admin/billing/plans/${created.id}`, { name: 'Team plan', visibility: 'private' }).expect(200)).body).toMatchObject({ name: 'Team plan', visibility: 'private', currentVersion: 1 });
    // A stale sign-in is asked to step up.
    await h.s.db('sessions').update({ auth_at: Date.now() - 2 * 3600_000, created_at: Date.now() - 2 * 3600_000 });
    const stale = await send(pa, 'patch', `/api/admin/billing/plans/${created.id}`, { name: 'X' });
    expect(stale.status).toBe(401);
    expect(stale.body.step_up).toBe(true);

    // A tenant admin reads only visible, subscribable plans and cannot change the catalogue.
    await localUser(h, 'ta', ['tenant-admin'], 'internal');
    const ta = await loginAdmin(h, 'ta');
    await plan('starter', [price(1000)]);
    const list = (await ta.agent.get('/api/admin/billing/plans').expect(200)).body;
    expect(list.canManage).toBe(false);
    expect(list.plans.map((p: { key: string }) => p.key)).toEqual(['starter']);
    expect(list.plans[0].versions).toBeUndefined();
    await ta.agent.get(`/api/admin/billing/plans/${created.id}`).expect(404);
    await send(ta, 'post', '/api/admin/billing/plans', { key: 'mine', name: 'Mine', prices: [price(1)] }).expect(403);

    const actions = ((await h.s.db('audit_events').where('action', 'like', 'billing.plan.%').orderBy('seq')) as { action: string }[]).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['billing.plan.created', 'billing.plan.approved', 'billing.plan.proposed', 'billing.plan.withdrawn', 'billing.plan.rejected', 'billing.plan.updated']));
  });

  it('turns a trial into active at its end and renews on the anchor', async () => {
    const p = await plan('trial', [price(3000)], { trialDays: 14, allowances: { prompt_tokens: 1000 } });
    const t0 = D('2026-01-10T00:00:00Z');
    const { subscription } = await h.s.subscriptions.subscribe(platform, h.tenantId, { planId: p.id, seats: 1, currency: 'usd', cycle: { kind: 'monthly', anchorDay: 1 } }, t0);
    expect(subscription).toMatchObject({ state: 'trialing', trialEnd: t0 + 14 * DAY, periodStart: t0, periodEnd: D('2026-02-01T00:00:00Z') });
    const during = await h.s.subscriptions.at(h.tenantId, t0 + DAY);
    expect(during).toMatchObject({ state: 'trialing', priceMinor: 0, planKey: 'trial', allowances: { prompt_tokens: 1000 }, periodStart: D('2026-01-01T00:00:00Z'), periodEnd: D('2026-02-01T00:00:00Z') });
    const after = await h.s.subscriptions.at(h.tenantId, t0 + 15 * DAY);
    expect(after).toMatchObject({ state: 'active', priceMinor: 3000, cycleAmountMinor: 3000 });
    // The tick writes what time brought, dated when it happened.
    const moved = await h.s.subscriptions.tick(h.tenantId, D('2026-02-03T00:00:00Z'));
    expect(moved).toEqual({ moved: 1, state: 'active' });
    const kinds = (await h.s.subscriptions.history(h.tenantId)).map((e) => [e.kind, e.at]).reverse();
    expect(kinds).toEqual([['created', t0], ['trial-ended', t0 + 14 * DAY], ['renewed', D('2026-02-01T00:00:00Z')]]);
    // The engine's stretches: trial at no charge, then active for the rest of January, then February.
    const st = await h.s.subscriptions.periods(h.tenantId, D('2026-01-01T00:00:00Z'), D('2026-03-01T00:00:00Z'));
    expect(st.map((x) => [x.state, x.from, x.to, x.priceMinor])).toEqual([
      ['trialing', t0, t0 + 14 * DAY, 0],
      ['active', t0 + 14 * DAY, D('2026-02-01T00:00:00Z'), 3000],
      ['active', D('2026-02-01T00:00:00Z'), D('2026-03-01T00:00:00Z'), 3000]
    ]);
    expect(st[1]!.fraction).toEqual({ num: 8 * 86400, den: 31 * 86400 });
    const detail = await h.s.subscriptions.cycleDetail(h.tenantId, D('2026-01-01T00:00:00Z'), D('2026-02-01T00:00:00Z'));
    // Opening 0 (trialing), then the trial's end charges the 8 days left of 31: round(3000 × 8/31) = 774.
    expect(detail[0]!.opening.chargeMinor).toBe(0);
    expect(detail[0]!.changes).toMatchObject([{ kind: 'trial-ended', creditMinor: 0, chargeMinor: 774, netMinor: 774 }]);
    const audits = ((await h.s.db('audit_events').where('action', 'like', 'billing.subscription.%').orderBy('seq')) as { action: string; kind: string }[]).map((x) => `${x.action}:${x.kind}`);
    expect(audits).toEqual(['billing.subscription.created:admin', 'billing.subscription.trial-ended:system', 'billing.subscription.renewed:system']);
  });

  it('cancels at the period end, and offers no second trial', async () => {
    const p = await plan('cancel', [price(3100)], { trialDays: 7 });
    const t0 = D('2026-03-01T00:00:00Z');
    await h.s.subscriptions.subscribe({ ...platform, platform: true }, h.tenantId, { planId: p.id, seats: 1, currency: 'USD', cycle: { kind: 'monthly', anchorDay: 1 }, trialDays: 0 }, t0);
    const { subscription } = await h.s.subscriptions.cancel(platform, h.tenantId, 'period-end', D('2026-03-10T00:00:00Z'));
    expect(subscription.cancelAtPeriodEnd).toBe(true);
    expect(await h.s.subscriptions.at(h.tenantId, D('2026-03-31T23:59:59Z'))).toMatchObject({ state: 'active', cancelAtPeriodEnd: true });
    expect(await h.s.subscriptions.at(h.tenantId, D('2026-04-01T00:00:00Z'))).toBeNull();
    // Undone, then done again; the tick ends it on 1 April.
    await h.s.subscriptions.keep(platform, h.tenantId, D('2026-03-11T00:00:00Z'));
    await h.s.subscriptions.cancel(platform, h.tenantId, 'period-end', D('2026-03-12T00:00:00Z'));
    await h.s.subscriptions.tick(h.tenantId, D('2026-04-02T00:00:00Z'));
    expect(await h.s.subscriptions.current(h.tenantId)).toBeNull();
    const last = (await h.s.subscriptions.history(h.tenantId, { limit: 1 }))[0]!;
    expect([last.kind, last.at, last.snapshot.state]).toEqual(['cancelled', D('2026-04-01T00:00:00Z'), 'cancelled']);
    const periods = await h.s.subscriptions.cycleDetail(h.tenantId, t0, D('2026-06-01T00:00:00Z'));
    expect(periods).toHaveLength(1);
    expect(periods[0]).toMatchObject({ final: true, opening: { chargeMinor: 3100 }, changes: [] });
    // A new subscription after it gets no trial (the plan offers one only on a first subscription).
    const again = await h.s.subscriptions.subscribe({ ...platform, platform: false }, h.tenantId, { planId: p.id, seats: 1, currency: 'USD', cycle: { kind: 'monthly' } }, D('2026-05-03T00:00:00Z'));
    expect(again.subscription).toMatchObject({ state: 'active', trialEnd: null, cycle: { anchorDay: 3 } });
  });

  it('pauses and resumes with the paused time credited', async () => {
    const p = await plan('pause', [price(3000)], { allowances: { requests: 310 } });
    const t0 = D('2026-03-01T00:00:00Z');
    await h.s.subscriptions.subscribe(platform, h.tenantId, { planId: p.id, seats: 1, currency: 'USD', cycle: { kind: 'monthly', anchorDay: 1 } }, t0);
    const paused = await h.s.subscriptions.pause(platform, h.tenantId, D('2026-03-11T00:00:00Z'));
    // 21 of 31 days left: credit round(3000 × 21/31) = 2032.
    expect(paused.proration).toMatchObject({ remainingSeconds: 21 * 86400, periodSeconds: 31 * 86400, creditMinor: -2032, chargeMinor: 0, netMinor: -2032 });
    await expect(h.s.subscriptions.change(platform, h.tenantId, { seats: 2, when: 'now' }, D('2026-03-12T00:00:00Z'))).rejects.toMatchObject({ status: 409 });
    expect(await h.s.subscriptions.at(h.tenantId, D('2026-03-15T00:00:00Z'))).toMatchObject({ state: 'paused', priceMinor: 0, allowances: {} });
    const resumed = await h.s.subscriptions.resume(platform, h.tenantId, D('2026-03-21T00:00:00Z'));
    // 11 days left: charge round(3000 × 11/31) = 1065 (1064.516…).
    expect(resumed.proration).toMatchObject({ creditMinor: 0, chargeMinor: 1065, netMinor: 1065 });
    const [c] = await h.s.subscriptions.cycleDetail(h.tenantId, t0, D('2026-04-01T00:00:00Z'));
    expect(c!.segments.map((s) => [s.state, s.amountMinor])).toEqual([['active', 968], ['paused', 0], ['active', 1065]]);
    // Allowances follow the stretches that count (10 + 11 of 31 days of 310).
    expect(c!.allowances).toEqual({ requests: 210 });
    expect(c!.opening.chargeMinor + c!.changes.reduce((x, ch) => x + ch.netMinor, 0)).toBe(3000 - 2032 + 1065);
  });

  it('prorates a seat change now and applies a plan change at renewal', async () => {
    const small = await plan('small', [price(3000, 1000, 1)]);
    const big = await plan('big', [price(9000, 500, 5)]);
    const t0 = D('2026-03-01T00:00:00Z');
    await h.s.subscriptions.subscribe(platform, h.tenantId, { planId: small.id, seats: 1, currency: 'USD', cycle: { kind: 'monthly', anchorDay: 1 } }, t0);
    const at = D('2026-03-11T00:00:00Z');
    const preview = await h.s.subscriptions.preview(platform, h.tenantId, { seats: 3, when: 'now' }, at);
    // 3000 → 5000 a cycle, 21 of 31 days left: credit −round(2032.26) = −2032, charge round(3387.10) = 3387.
    expect(preview).toMatchObject({ creditMinor: -2032, chargeMinor: 3387, netMinor: 1355, before: { cycleAmountMinor: 3000 }, after: { cycleAmountMinor: 5000, seats: 3 } });
    const changed = await h.s.subscriptions.change(platform, h.tenantId, { seats: 3, when: 'now' }, at);
    expect(changed.proration).toEqual({ remainingSeconds: 21 * 86400, periodSeconds: 31 * 86400, creditMinor: -2032, chargeMinor: 3387, netMinor: 1355 });
    // At renewal: nothing charged now; April starts on the big plan.
    const sched = await h.s.subscriptions.preview(platform, h.tenantId, { planId: big.id, when: 'renewal' }, D('2026-03-20T00:00:00Z'));
    expect(sched).toMatchObject({ when: 'renewal', netMinor: 0, at: D('2026-04-01T00:00:00Z'), nextCycleAmountMinor: 9000 });
    await h.s.subscriptions.change(platform, h.tenantId, { planId: big.id, when: 'renewal' }, D('2026-03-20T00:00:00Z'));
    expect(await h.s.subscriptions.at(h.tenantId, D('2026-03-31T00:00:00Z'))).toMatchObject({ planKey: 'small', seats: 3, priceMinor: 3000, seatPriceMinor: 1000 });
    expect(await h.s.subscriptions.at(h.tenantId, D('2026-04-02T00:00:00Z'))).toMatchObject({ planKey: 'big', seats: 3, includedSeats: 5, cycleAmountMinor: 9000 });

    const stretches = await h.s.subscriptions.periods(h.tenantId, t0, D('2026-05-01T00:00:00Z'));
    expect(stretches.map((x) => [x.planKey, x.seats, x.from, x.to, x.fraction])).toEqual([
      ['small', 1, t0, at, { num: 10 * 86400, den: 31 * 86400 }],
      ['small', 3, at, D('2026-04-01T00:00:00Z'), { num: 21 * 86400, den: 31 * 86400 }],
      ['big', 3, D('2026-04-01T00:00:00Z'), D('2026-05-01T00:00:00Z'), { num: 30 * 86400, den: 30 * 86400 }]
    ]);
    const detail = await h.s.subscriptions.cycleDetail(h.tenantId, t0, D('2026-05-01T00:00:00Z'));
    expect(detail.map((c) => [c.opening.chargeMinor, c.changes.map((x) => [x.kind, x.netMinor])])).toEqual([[3000, [['seats', 1355]]], [9000, []]]);
    // Undoing a scheduled change; changing to the same thing is refused.
    await h.s.subscriptions.tick(h.tenantId, D('2026-04-02T00:00:00Z'));
    await h.s.subscriptions.change(platform, h.tenantId, { planId: small.id, when: 'renewal' }, D('2026-04-05T00:00:00Z'));
    expect((await h.s.subscriptions.unschedule(platform, h.tenantId, D('2026-04-06T00:00:00Z'))).pendingChange).toBeNull();
    await expect(h.s.subscriptions.change(platform, h.tenantId, { seats: 3, when: 'now' }, D('2026-04-07T00:00:00Z'))).rejects.toMatchObject({ status: 409 });
    const actions = ((await h.s.db('audit_events').where('action', 'like', 'billing.subscription.%').orderBy('seq')) as { action: string }[]).map((x) => x.action);
    expect(actions).toEqual(['billing.subscription.created', 'billing.subscription.seats-changed', 'billing.subscription.change-scheduled', 'billing.subscription.renewed', 'billing.subscription.change-scheduled', 'billing.subscription.change-unscheduled']);
  });

  it('leaves a tenant without a subscription as it was', async () => {
    await plan('unused', [price(1000)]);
    expect(await h.s.subscriptions.at(h.tenantId, Date.now())).toBeNull();
    expect(await h.s.subscriptions.periods(h.tenantId, 0, Date.now())).toEqual([]);
    expect(await h.s.subscriptions.dueTenants()).toEqual([]);
    expect(await h.s.subscriptions.tick(h.tenantId)).toEqual({ moved: 0, state: null });
    const admin = await loginAdmin(h, 'pa');
    expect((await admin.agent.get('/api/admin/billing/subscription').expect(200)).body).toMatchObject({ subscription: null, history: [] });
  });

  it('lets a tenant admin subscribe and change seats, but not use private plans or set a trial', async () => {
    const pub = await plan('pub', [price(2000, 500, 1)], { trialDays: 5 });
    const priv = await plan('priv', [price(1)], { visibility: 'private' });
    await localUser(h, 'ta', ['tenant-admin'], 'internal');
    await localUser(h, 'mem', ['member'], 'internal');
    const ta = await loginAdmin(h, 'ta');
    const send = (m: 'post' | 'patch', p: string, body: object = {}) => ta.agent[m](p).set('x-csrf-token', ta.csrf).send(body);
    await send('post', '/api/admin/billing/subscription', { planId: priv.id, currency: 'USD', cycle: { kind: 'monthly' } }).expect(404);
    await send('post', '/api/admin/billing/subscription', { planId: pub.id, currency: 'USD', cycle: { kind: 'monthly' }, trialDays: 30 }).expect(403);
    await send('post', '/api/admin/billing/subscription', { planId: pub.id, currency: 'USD', cycle: { kind: 'custom' } }).expect(400);
    const made = (await send('post', '/api/admin/billing/subscription', { planId: pub.id, seats: 2, currency: 'USD', cycle: { kind: 'monthly', anchorDay: 1 } }).expect(201)).body;
    expect(made.subscription).toMatchObject({ state: 'trialing', seats: 2, cycleAmountMinor: 2500, plan: { key: 'pub' } });
    await send('post', '/api/admin/billing/subscription', { planId: pub.id, currency: 'USD', cycle: { kind: 'monthly' } }).expect(409);
    const pv = (await send('post', '/api/admin/billing/subscription/preview', { seats: 4 }).expect(200)).body;
    expect(pv).toMatchObject({ when: 'now', creditMinor: 0, chargeMinor: 0, after: { cycleAmountMinor: 3500 } });
    expect((await send('patch', '/api/admin/billing/subscription', { seats: 4 }).expect(200)).body.subscription.seats).toBe(4);
    expect((await send('post', '/api/admin/billing/subscription/cancel', { when: 'period-end' }).expect(200)).body.subscription.cancelAtPeriodEnd).toBe(true);
    await send('post', '/api/admin/billing/subscription/pause').expect(409);
    const view = (await ta.agent.get('/api/admin/billing/subscription').expect(200)).body;
    expect(view.history.map((e: { kind: string }) => e.kind)).toEqual(['cancel-scheduled', 'seats-changed', 'created']);
    const periods = (await ta.agent.get(`/api/admin/billing/subscription/periods?from=${new Date(Date.now() - DAY).toISOString()}&to=${new Date(Date.now() + 40 * DAY).toISOString()}`).expect(200)).body;
    expect(periods.periods.length).toBeGreaterThanOrEqual(1);
    // A member has no billing permission; another tenant is for system admins.
    const mem = await (await import('./helpers.js')).login(h, 'mem');
    await mem.agent.get('/api/admin/billing/subscription').expect(403);
    await ta.agent.get(`/api/admin/billing/subscription?tenant=${'0'.repeat(26)}`).expect(403);
  });
});
