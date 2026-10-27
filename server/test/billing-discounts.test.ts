/*
 * Sprint 51 (B-165): discount tables. Every scope and kind, validity, tenant targeting, promotion codes with expiry
 * and redemption limits (concurrent redemptions never pass the limit), negotiated discounts, the stacking order and
 * the cap, dual control above the threshold, one line per discount, exact totals, and the audit trail.
 */
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cycleOf } from '../src/billing/cycles.js';
import type { RuleInput } from '../src/billing/discounts.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';
import { billingSchema, fakeSubscription, promptItem, use, utc } from './billing-sprint51-helpers.js';

const M = 202605;
const rule = (o: Partial<RuleInput>): RuleInput => ({ name: 'R', source: 'rule', scope: 'statement', scopeValue: null, kind: 'percent', terms: { percentPpm: 100_000 }, currency: null, validFrom: null, validTo: null, target: { kind: 'all' }, stackOrder: 100, note: null, ...o });
const sum = (xs: { amount: number }[]) => xs.reduce((a, l) => a + l.amount, 0);

describe('B-165 discounts on statements', () => {
  let h: Harness;
  const subscribe = (cycle = cycleOf('monthly', 1), priceMinor = 10_000) =>
    h.s.billing.useSubscriptions(fakeSubscription(h.tenantId, cycle, utc(2026, 1, 1), [{ from: utc(2026, 1, 1), to: utc(2030, 1, 1), planId: 'plan_pro', planName: 'Pro', priceMinor, seats: 4, includedSeats: 2, seatPriceMinor: 1000 }]));
  /** A rule made by one admin and, when it needs one, approved by another. */
  const add = async (o: Partial<RuleInput>) => {
    const out = await h.s.billing.discounts.create('admin_a', rule(o));
    if (out.approval) await h.s.billing.discounts.decide('admin_b', out.approval.id, 'approve', null);
    return out.rule.id;
  };
  const retire = (id: string) => h.s.billing.discounts.update('admin_a', id, { state: 'retired' });
  const discounts = async () => (await h.s.billing.compute(h.tenantId, M)).charges.filter((l) => l.kind === 'discount');

  beforeEach(async () => {
    h = await harness();
    await billingSchema(h);
    // Thresholds out of the way for these tests (dual control has its own test).
    await h.s.billing.discounts.setPolicy('admin_a', { approvalPercentPpm: 1_000_000, approvalAmountMinor: 1_000_000_000 });
    await h.s.billing.createBook('admin', { name: 'Book', currency: 'USD', isDefault: true, items: [promptItem(2_000_000), { match: 'any', value: null, usage: '*', meter: 'output_tokens', perUnits: 1_000_000, unitPriceMicros: 1_000_000 }] });
    subscribe();
    // Plan 100.00, two extra seats 20.00, prompt 2M on llama 4.00 and 1M on qwen 2.00, output 1M on llama 1.00: 127.00.
    await use(h, utc(2026, 5, 3), { model: 'llama3.1:8b', promptTokens: 2_000_000, outputTokens: 1_000_000 });
    await use(h, utc(2026, 5, 4), { model: 'qwen2:7b', promptTokens: 1_000_000 });
  });
  afterEach(async () => {
    await h.close();
  });

  it('applies every scope and kind, each as its own line naming its rule', async () => {
    const before = await h.s.billing.compute(h.tenantId, M);
    expect(before.subtotal_micros).toBe(127_000_000);
    const cases: [Partial<RuleInput>, number][] = [
      [{ scope: 'plan', kind: 'percent', terms: { percentPpm: 100_000 } }, -10_000_000],
      [{ scope: 'seats', kind: 'amount', terms: { amountMinor: 500 }, currency: 'USD' }, -5_000_000],
      [{ scope: 'meter', scopeValue: 'prompt_tokens', terms: { percentPpm: 500_000 } }, -3_000_000],
      // The llama share of the prompt line (4.00 of 6.00) and its output line (1.00): 10% of 5.00.
      [{ scope: 'model', scopeValue: 'llama3.1:8b', terms: { percentPpm: 100_000 } }, -500_000],
      [{ scope: 'family', scopeValue: 'qwen2', terms: { percentPpm: 500_000 } }, -1_000_000],
      [{ scope: 'statement', terms: { percentPpm: 100_000 } }, -12_700_000],
      // Free units, valued at what they would have cost: 1.5M prompt tokens at 2.00 per million.
      [{ scope: 'meter', scopeValue: 'prompt_tokens', kind: 'allowance', terms: { quantity: 1_500_000 } }, -3_000_000],
      [{ scope: 'family', scopeValue: 'qwen2', kind: 'allowance', terms: { quantity: 400_000, meter: 'prompt_tokens' } }, -800_000],
      // Volume by quantity: 3M prompt tokens reach the 20% tier (from 2.5M).
      [{ scope: 'meter', scopeValue: 'prompt_tokens', kind: 'volume', terms: { measure: 'quantity', tiers: [{ from: 1_000_000, percentPpm: 50_000 }, { from: 2_500_000, percentPpm: 200_000 }] } }, -1_200_000],
      // Volume by amount: the statement's 127.00 reaches the tier from 100.00 (10,000 minor units).
      [{ scope: 'statement', kind: 'volume', terms: { tiers: [{ from: 10_000, percentPpm: 20_000 }, { from: 50_000, percentPpm: 90_000 }] } }, -2_540_000]
    ];
    for (const [o, amount] of cases) {
      const id = await add(o);
      const ds = await discounts();
      expect(ds, JSON.stringify(o)).toEqual([expect.objectContaining({ kind: 'discount', ruleId: id, amount, quantity: 1 })]);
      await retire(id);
    }
    expect(await discounts()).toEqual([]);
  });

  it('a commitment discount needs an annual cycle; a fixed amount needs the statement currency', async () => {
    const commit = await add({ scope: 'plan', kind: 'commitment', terms: { percentPpm: 150_000 }, stackOrder: 1 });
    const eur = await add({ scope: 'statement', kind: 'amount', terms: { amountMinor: 100 }, currency: 'EUR', stackOrder: 2 });
    const monthly = await h.s.billing.compute(h.tenantId, M);
    expect(monthly.charges.filter((l) => l.kind === 'discount')).toEqual([]);
    expect(monthly.discountReport!.map((x) => [x.ruleId, x.skipped])).toEqual([
      [commit, 'a commitment discount needs a cycle of 12 months or more'],
      [eur, 'the rule is in EUR; the statement is in USD']
    ]);
    subscribe(cycleOf('annual', 1), 100_000);
    // The annual cycle from January 2026 ends in December: its statement is 2026-12; 15% of the 1,000.00 plan.
    const annual = await h.s.billing.compute(h.tenantId, M);
    expect(annual.month).toBe(202612);
    expect(annual.charges.filter((l) => l.kind === 'discount').map((l) => [l.ruleId, l.amount])).toEqual([[commit, -150_000_000]]);
  });

  it('applies a rule only while it is valid and only to the tenants it targets', async () => {
    const past = await add({ validFrom: utc(2026, 3, 1), validTo: utc(2026, 5, 1) });
    const future = await add({ validFrom: utc(2026, 6, 1) });
    const other = await add({ target: { kind: 'tenants', ids: [ulid()] } });
    const wrongPlan = await add({ target: { kind: 'plans', ids: ['plan_basic'] } });
    expect(await discounts()).toEqual([]);
    const overlap = await add({ name: 'Overlap', validFrom: utc(2026, 4, 20), validTo: utc(2026, 5, 2) });
    const mine = await add({ name: 'Mine', target: { kind: 'tenants', ids: [h.tenantId] }, stackOrder: 200 });
    const plan = await add({ name: 'Plan', target: { kind: 'plans', ids: ['plan_pro'] }, stackOrder: 300 });
    expect((await discounts()).map((l) => l.ruleId)).toEqual([overlap, mine, plan]);
    void [past, future, other, wrongPlan];
    // A negotiated discount is one tenant's own.
    await expect(h.s.billing.discounts.create('admin_a', rule({ source: 'negotiated' }))).rejects.toMatchObject({ status: 400 });
    const neg = await add({ source: 'negotiated', target: { kind: 'tenants', ids: [h.tenantId] }, stackOrder: 1 });
    expect((await discounts())[0]!.ruleId).toBe(neg);
  });

  it('stacks in order, each on what the rules before it left, within the cap, with tax after', async () => {
    await h.s.integrations.set(h.tenantId, { taxRates: [{ name: 'VAT', ratePpm: 200_000 }] }, 'admin');
    const second = await add({ name: 'Second', stackOrder: 20 });
    const first = await add({ name: 'First', stackOrder: 10 });
    let c = await h.s.billing.compute(h.tenantId, M);
    // 10% of 127.00, then 10% of the 114.30 left: 12.70 and 11.43, not 12.70 twice.
    expect(c.charges.filter((l) => l.kind === 'discount').map((l) => [l.ruleId, l.amount])).toEqual([[first, -12_700_000], [second, -11_430_000]]);
    expect(c).toMatchObject({ subtotal_micros: 102_870_000, discount_micros: -24_130_000, tax_micros: 20_570_000, total_micros: 123_440_000 });
    // 20% of 102.87 is 20.574, rounded once to the cent.
    expect(sum(c.charges.filter((l) => l.kind !== 'tax'))).toBe(c.subtotal_micros);
    expect(sum(c.charges)).toBe(c.total_micros);
    // A cap of 15% of the pre-discount total (19.05): the second rule gets what is left, and says so.
    await h.s.billing.discounts.setPolicy('admin_a', { capPercentPpm: 150_000 });
    c = await h.s.billing.compute(h.tenantId, M);
    const ds = c.charges.filter((l) => l.kind === 'discount');
    expect(ds.map((l) => l.amount)).toEqual([-12_700_000, -6_350_000]);
    expect(ds[1]!.description).toMatch(/limited by the discount cap/);
    expect(c.discount_micros).toBe(-19_050_000);
    // An amount cap below both percentages: the smaller cap wins, and the second rule has no room left.
    await h.s.billing.discounts.setPolicy('admin_a', { capAmountMinor: 500 });
    c = await h.s.billing.compute(h.tenantId, M);
    expect(c.charges.filter((l) => l.kind === 'discount').map((l) => [l.ruleId, l.amount])).toEqual([[first, -5_000_000]]);
    expect(c.discountReport!.find((x) => x.ruleId === second)).toMatchObject({ skipped: 'the discount cap is reached', capped: true });
    for (const l of c.charges) expect(Math.abs(l.amount % 10_000)).toBe(0);
  });

  it('counts concurrent redemptions in one conditional update, never past the limit', async () => {
    const promo = (await h.s.billing.discounts.create('admin_a', rule({ source: 'promotion', name: 'Launch' }))).rule;
    const code = await h.s.billing.discounts.createCode('admin_a', { ruleId: promo.id, code: 'launch-3', expiresAt: null, maxRedemptions: 3 });
    expect(code.code).toBe('LAUNCH-3');
    const tenants = Array.from({ length: 8 }, () => ulid());
    const results = await Promise.allSettled(tenants.map((t) => h.s.billing.discounts.redeem(t, 'u', 'launch-3', null)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason.status === 409)).toBe(true);
    expect((await h.s.billing.discounts.code(code.id)).redemptions).toBe(3);
    expect(await h.s.db('billing_promo_redemptions').where({ code_id: code.id })).toHaveLength(3);
    // A promotion applies to the tenants that redeemed it, and to no one else.
    expect(await discounts()).toEqual([]);
  });
});

describe('B-165 discount routes, dual control and audit', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
    await billingSchema(h);
    await h.s.billing.createBook('admin', { name: 'Book', currency: 'USD', isDefault: true, items: [promptItem(2_000_000)] });
  });
  afterEach(async () => {
    await h.close();
  });

  const actions = async () => ((await h.s.db('audit_events').where('action', 'like', 'billing.%').orderBy('seq').select('action')) as { action: string }[]).map((x) => x.action);

  it('needs a second admin above the threshold; the proposer cannot approve', async () => {
    await localUser(h, 'root1', ['system-admin'], 'restricted');
    await localUser(h, 'root2', ['system-admin'], 'restricted');
    await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    const a = await loginAdmin(h, 'root1');
    const b = await loginAdmin(h, 'root2');
    const ta = await loginAdmin(h, 'ta');
    const send = (c: typeof a, m: 'post' | 'patch' | 'put', p: string, body: object = {}) => c.agent[m](p).set('x-csrf-token', c.csrf).send(body);

    await send(ta, 'post', '/api/admin/billing/discounts', { name: 'X', scope: 'statement', kind: 'percent', terms: { percentPpm: 1 } }).expect(403);
    await send(a, 'post', '/api/admin/billing/discounts', { name: 'Bad', scope: 'meter', kind: 'percent', terms: { percentPpm: 1 } }).expect(400);
    // 10% is at or below the default 20% threshold: active at once.
    const small = (await send(a, 'post', '/api/admin/billing/discounts', { name: 'Ten', scope: 'statement', kind: 'percent', terms: { percentPpm: 100_000 } }).expect(201)).body;
    expect(small).toMatchObject({ needsApproval: false, rule: { state: 'active' } });
    // 30%: proposed, and not applied until approved.
    const big = (await send(a, 'post', '/api/admin/billing/discounts', { name: 'Thirty', scope: 'statement', kind: 'percent', terms: { percentPpm: 300_000 }, stackOrder: 200, validFrom: '2026-01-01' }).expect(201)).body;
    expect(big).toMatchObject({ needsApproval: true, rule: { state: 'proposed', validFrom: '2026-01-01T00:00:00.000Z' }, reason: expect.stringMatching(/above the 20% approval threshold/) });
    expect((await h.s.billing.compute(h.tenantId, 202605)).discountReport!.map((x) => x.ruleId)).toEqual([small.rule.id]);
    const denied = await send(a, 'post', `/api/admin/billing/discount-approvals/${big.approval.id}/approve`).expect(403);
    expect(denied.body).toMatchObject({ step: 'dual-control' });
    const approved = (await send(b, 'post', `/api/admin/billing/discount-approvals/${big.approval.id}/approve`, { note: 'agreed' }).expect(200)).body;
    expect(approved).toMatchObject({ approval: { state: 'approved', decidedBy: expect.any(String) }, rule: { state: 'active' } });
    await send(b, 'post', `/api/admin/billing/discount-approvals/${big.approval.id}/reject`).expect(409);

    // Raising the 10% rule to 40% waits for approval; until then it keeps its 10%.
    const raise = (await send(a, 'patch', `/api/admin/billing/discounts/${small.rule.id}`, { terms: { percentPpm: 400_000 } }).expect(200)).body;
    expect(raise).toMatchObject({ needsApproval: true, rule: { terms: { percentPpm: 100_000 } } });
    await send(b, 'post', `/api/admin/billing/discount-approvals/${raise.approval.id}/approve`).expect(200);
    expect((await h.s.billing.discounts.rule(small.rule.id)).terms.percentPpm).toBe(400_000);
    // A rename needs nobody.
    expect((await send(a, 'patch', `/api/admin/billing/discounts/${small.rule.id}`, { name: 'Forty' }).expect(200)).body).toMatchObject({ needsApproval: false, rule: { name: 'Forty' } });

    // The threshold is configurable: an amount threshold of 10.00 makes a 50.00 discount need approval.
    await send(a, 'put', '/api/admin/billing/discount-policy', { approvalAmountMinor: 1000, capPercentPpm: 500_000 }).expect(200);
    const amt = (await send(a, 'post', '/api/admin/billing/discounts', { name: 'Fifty', scope: 'statement', kind: 'amount', terms: { amountMinor: 5000 }, currency: 'usd' }).expect(201)).body;
    expect(amt).toMatchObject({ needsApproval: true, rule: { currency: 'USD' } });
    await send(b, 'post', `/api/admin/billing/discount-approvals/${amt.approval.id}/reject`, { note: 'too much' }).expect(200);
    expect((await h.s.billing.discounts.rule(amt.rule.id)).state).toBe('rejected');
    expect((await a.agent.get('/api/admin/billing/discount-approvals?state=pending').expect(200)).body.approvals).toEqual([]);
    await send(a, 'patch', `/api/admin/billing/discounts/${small.rule.id}`, { state: 'retired' }).expect(200);

    expect(await actions()).toEqual(['billing.price-book.created', 'billing.discount.created', 'billing.discount.proposed', 'billing.discount.approval-refused', 'billing.discount.approved', 'billing.discount.change-proposed', 'billing.discount.approved', 'billing.discount.updated', 'billing.discount.policy-updated', 'billing.discount.proposed', 'billing.discount.rejected', 'billing.discount.retired'].filter((x) => x !== 'billing.price-book.created'));
  });

  it('promotion codes: a tenant admin redeems one, once, before it expires and within its limit', async () => {
    await localUser(h, 'root1', ['system-admin'], 'restricted');
    await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    await localUser(h, 'mem', ['member']);
    const a = await loginAdmin(h, 'root1');
    const ta = await loginAdmin(h, 'ta');
    const send = (c: typeof a, m: 'post' | 'patch', p: string, body: object = {}) => c.agent[m](p).set('x-csrf-token', c.csrf).send(body);
    const promo = (await send(a, 'post', '/api/admin/billing/discounts', { name: 'Spring', source: 'promotion', scope: 'statement', kind: 'percent', terms: { percentPpm: 50_000 } }).expect(201)).body.rule;
    const plain = (await send(a, 'post', '/api/admin/billing/discounts', { name: 'Plain', scope: 'statement', kind: 'percent', terms: { percentPpm: 50_000 }, target: { kind: 'tenants', ids: [ulid()] } }).expect(201)).body.rule;
    await send(a, 'post', '/api/admin/billing/promo-codes', { ruleId: plain.id, code: 'NOPE' }).expect(409);
    const code = (await send(a, 'post', '/api/admin/billing/promo-codes', { ruleId: promo.id, code: 'SPRING26', maxRedemptions: 10, expiresAt: '2099-01-01' }).expect(201)).body;
    const expired = (await send(a, 'post', '/api/admin/billing/promo-codes', { ruleId: promo.id, code: 'OLD1', expiresAt: '2020-01-01' }).expect(201)).body;
    const generated = (await send(a, 'post', '/api/admin/billing/promo-codes', { ruleId: promo.id }).expect(201)).body;
    expect(generated.code).toMatch(/^[A-Z2-9]{10}$/);

    const mem = await (await import('./helpers.js')).login(h, 'mem');
    await mem.agent.post('/api/admin/billing/promo-codes/redeem').set('x-csrf-token', mem.csrf).send({ code: 'SPRING26' }).expect(403);
    const ok = (await send(ta, 'post', '/api/admin/billing/promo-codes/redeem', { code: 'spring26' }).expect(201)).body;
    expect(ok.rule).toMatchObject({ id: promo.id, name: 'Spring' });
    // Again, expired or unknown: one answer that tells nothing about which.
    for (const c of ['SPRING26', expired.code, 'UNKNOWN1']) expect((await send(ta, 'post', '/api/admin/billing/promo-codes/redeem', { code: c }).expect(409)).body.detail).toBe('This code cannot be redeemed.');
    expect((await h.s.billing.discounts.code(code.id)).redemptions).toBe(1);
    expect((await ta.agent.get('/api/admin/billing/redemptions').expect(200)).body.redemptions).toEqual([expect.objectContaining({ codeId: code.id, tenantId: h.tenantId })]);
    // The redeemer's statement shows the promotion as its own line.
    await h.s.quotas.record({ tenantId: h.tenantId, workspaceId: null, userId: null, kind: 'chat', model: 'm', promptTokens: 1_000_000, outputTokens: 0, gpuMs: 0 });
    const month = new Date().toISOString().slice(0, 7);
    const prev = (await ta.agent.get(`/api/admin/billing/statements/${month}/preview`).expect(200)).body;
    expect(prev.charges.filter((l: { kind: string }) => l.kind === 'discount')).toEqual([expect.objectContaining({ ruleId: promo.id, amount: -100_000 })]);
    expect(prev).toMatchObject({ pricing: 'cycle', totalMicros: 1_900_000, discountMicros: -100_000, discounts: [expect.objectContaining({ ruleId: promo.id })] });
    // Retired and capped codes.
    await send(a, 'patch', `/api/admin/billing/promo-codes/${code.id}`, { state: 'retired' }).expect(200);
    await send(a, 'patch', `/api/admin/billing/promo-codes/${generated.id}`, { maxRedemptions: 1 }).expect(200);

    const all = await actions();
    expect(all).toEqual(expect.arrayContaining(['billing.promo.created', 'billing.promo.redeemed', 'billing.promo.redeem-refused', 'billing.promo.retired', 'billing.promo.updated']));
    const refused = (await h.s.db('audit_events').where({ action: 'billing.promo.redeem-refused' }).orderBy('seq')) as { detail: string }[];
    expect(refused.map((r) => JSON.parse(r.detail).reason)).toEqual(['already redeemed by this tenant', 'code expired', 'unknown code']);
  });
});
