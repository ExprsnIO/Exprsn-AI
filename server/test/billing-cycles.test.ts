/*
 * Sprint 51 (B-163): statements per billing cycle. Cycle arithmetic with anchors, the window a month's statement
 * covers, plan and seats in advance, usage beyond allowances in arrears, proration from `periods()`, price book
 * versions inside a cycle, and tenants without a subscription priced exactly as before.
 */
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cycleBounds, cycleOf, mulDiv, prorate } from '../src/billing/cycles.js';
import { CALENDAR_MONTH } from '../src/billing/types.js';
import { harness, type Harness } from './helpers.js';
import { billingSchema, fakeSubscription, promptItem, use, utc } from './billing-sprint51-helpers.js';

const sum = (xs: { amount: number }[]) => xs.reduce((a, l) => a + l.amount, 0);

describe('B-163 cycle arithmetic', () => {
  it('counts monthly, quarterly, annual and custom cycles from their anchor', () => {
    const m = cycleOf('monthly', 15);
    expect(cycleBounds(m, utc(2026, 3, 15), utc(2026, 4, 2))).toEqual({ start: utc(2026, 3, 15), end: utc(2026, 4, 15) });
    expect(cycleBounds(m, utc(2026, 3, 15), utc(2026, 4, 15))).toEqual({ start: utc(2026, 4, 15), end: utc(2026, 5, 15) });
    const q = cycleOf('quarterly', 1);
    expect(cycleBounds(q, utc(2026, 1, 1), utc(2026, 2, 20))).toEqual({ start: utc(2026, 1, 1), end: utc(2026, 4, 1) });
    expect(cycleBounds(q, utc(2026, 1, 1), utc(2026, 11, 30))).toEqual({ start: utc(2026, 10, 1), end: utc(2027, 1, 1) });
    const y = cycleOf('annual', 1);
    expect(cycleBounds(y, utc(2025, 7, 1), utc(2026, 6, 30))).toEqual({ start: utc(2025, 7, 1), end: utc(2026, 7, 1) });
    const c = cycleOf('custom', 10, 2);
    expect(c.months).toBe(2);
    expect(cycleBounds(c, utc(2026, 1, 10), utc(2026, 3, 9))).toEqual({ start: utc(2026, 1, 10), end: utc(2026, 3, 10) });
    // A start between anchors: the first cycle starts at the anchor before it.
    expect(cycleBounds(m, utc(2026, 3, 20), utc(2026, 3, 20))).toEqual({ start: utc(2026, 3, 15), end: utc(2026, 4, 15) });
    expect(() => cycleOf('custom', 1, 37)).toThrow();
    expect(() => cycleOf('monthly', 32)).toThrow();
  });

  it('keeps the anchor day through short months: the 31st becomes the 28th of February, then the 31st again', () => {
    const m = cycleOf('monthly', 31);
    expect(cycleBounds(m, utc(2027, 1, 31), utc(2027, 2, 10))).toEqual({ start: utc(2027, 1, 31), end: utc(2027, 2, 28) });
    expect(cycleBounds(m, utc(2027, 1, 31), utc(2027, 3, 1))).toEqual({ start: utc(2027, 2, 28), end: utc(2027, 3, 31) });
    // Anchored on the 28th: February's 28th exists, so nothing moves.
    expect(cycleBounds(cycleOf('monthly', 28), utc(2027, 1, 28), utc(2027, 2, 27))).toEqual({ start: utc(2027, 1, 28), end: utc(2027, 2, 28) });
    // In a leap year an anchor of 30 lands on the 29th.
    expect(cycleBounds(cycleOf('monthly', 30), utc(2028, 1, 30), utc(2028, 2, 5))).toEqual({ start: utc(2028, 1, 30), end: utc(2028, 2, 29) });
  });

  it('rounds exactly: half away from zero, no floating-point shares', () => {
    expect(mulDiv(5, 1, 2)).toBe(3);
    expect(mulDiv(-5, 1, 2)).toBe(-3);
    expect(mulDiv(1_000_000_000_000, 2_678_400_000, 2_678_400_000)).toBe(1_000_000_000_000);
    // 31.00 for 16 of 31 days, to the cent: 16.00 exactly; 10.00 for 16/31 is 5.1612… → 5.16.
    expect(prorate(31_000_000, { num: 16, den: 31 }, 2)).toBe(16_000_000);
    expect(prorate(10_000_000, { num: 16, den: 31 }, 2)).toBe(5_160_000);
    expect(prorate(1_000_000, { num: 1, den: 2 }, 0)).toBe(1_000_000); // 0.5 yen rounds away from zero
  });
});

describe('B-163 statements per cycle', () => {
  let h: Harness;
  let bookId: string;
  beforeEach(async () => {
    h = await harness();
    await billingSchema(h);
    bookId = (await h.s.billing.createBook('admin', { name: 'Book', currency: 'USD', isDefault: true, items: [promptItem(2_000_000)] })).id;
  });
  afterEach(async () => {
    await h.close();
  });

  it('a tenant without a subscription keeps exactly the monthly statement', async () => {
    const bare = await harness();
    try {
      for (const x of [h, bare]) {
        if (x !== h) await x.s.billing.createBook('admin', { name: 'Book', currency: 'USD', isDefault: true, items: [promptItem(2_000_000)] });
        await use(x, utc(2026, 5, 3), { promptTokens: 600_000 });
        await use(x, utc(2026, 5, 20), { kind: 'api', promptTokens: 400_000 });
        await use(x, utc(2026, 5, 20), { kind: 'embed', model: 'bge', promptTokens: 0, outputTokens: 0 });
      }
      // The same usage on a database without the 1.9.0 tables (the code before its migrations) and with them.
      const before = await bare.s.billing.compute(bare.tenantId, 202605);
      const after = await h.s.billing.compute(h.tenantId, 202605);
      for (const k of ['lines', 'totals', 'taxes', 'subtotal_micros', 'tax_micros', 'total_micros', 'currency', 'month'] as const) expect(after[k]).toEqual(before[k]);
      expect(after).toMatchObject({ pricing: 'monthly', period_start: utc(2026, 5, 1), period_end: utc(2026, 6, 1), cycle: CALENDAR_MONTH, total_micros: 2_000_000 });
      expect(after.lines.filter((l) => l.meter === 'prompt_tokens').map((l) => l.amountMicros)).toEqual([1_200_000, 800_000]);
      expect(after.lines.filter((l) => l.meter === 'requests').every((l) => !l.priced && l.amountMicros === 0)).toBe(true);
      // The line model is derived from the lines, not stored.
      expect(after.charges.map((l) => [l.kind, l.amount])).toEqual([['usage', 1_200_000], ['usage', 800_000]]);
      const st = await h.s.billing.save(h.tenantId, 202605);
      const row = await h.s.db('billing_statements').where({ id: st.id }).first();
      expect(row).toMatchObject({ pricing: 'monthly', charges: null });
      expect(st.state).toBe('closed');
      const bareRow = await bare.s.billing.save(bare.tenantId, 202605);
      expect(bareRow.total_micros).toBe(st.total_micros);
    } finally {
      await bare.close();
    }
  });

  it('reads a statement stored before 1.9.0 as a one-month cycle without rewriting it', async () => {
    const id = ulid();
    const lines = [{ kind: 'chat', model: 'm', profile: null, meter: 'prompt_tokens', quantity: 1_000_000, perUnits: 1_000_000, unitPriceMicros: 1_000_000, amountMicros: 1_000_000, priced: true }];
    await h.s.db('billing_statements').insert({ id, tenant_id: h.tenantId, month: 202604, book_id: bookId, book_name: 'Book', currency: 'USD', total_micros: 1_000_000, subtotal_micros: 1_000_000, tax_micros: 0, taxes: '[]', lines: JSON.stringify(lines), totals: '{}', state: 'pushed', provider_ref: 'in_1', computed_at: 1, pushed_at: 2 });
    const st = (await h.s.billing.statement(h.tenantId, 202604))!;
    expect(st).toMatchObject({ pricing: 'monthly', period_start: utc(2026, 4, 1), period_end: utc(2026, 5, 1), cycle: CALENDAR_MONTH, discount_micros: 0 });
    expect(st.charges).toEqual([expect.objectContaining({ kind: 'usage', amount: 1_000_000, meter: 'prompt_tokens' })]);
    await expect(h.s.billing.save(h.tenantId, 202604)).rejects.toMatchObject({ status: 409 });
    expect(await h.s.db('billing_statements').where({ id }).first()).toMatchObject({ period_start: null, charges: null, cycle: null, total_micros: 1_000_000 });
  });

  it('charges the plan and seats in advance and usage beyond the allowance in arrears, with tax after', async () => {
    await h.s.integrations.set(h.tenantId, { taxRates: [{ name: 'VAT', ratePpm: 100_000 }] }, 'admin');
    h.s.billing.useSubscriptions(fakeSubscription(h.tenantId, cycleOf('monthly', 1), utc(2026, 5, 1), [{ from: utc(2026, 5, 1), to: utc(2027, 1, 1), planId: 'plan_pro', planName: 'Pro', priceMinor: 2000, seats: 5, includedSeats: 3, seatPriceMinor: 500, allowances: { prompt_tokens: 1_000_000 } }]));
    await use(h, utc(2026, 5, 2), { promptTokens: 900_000 });
    await use(h, utc(2026, 5, 30), { promptTokens: 600_000 });
    const c = await h.s.billing.compute(h.tenantId, 202605);
    expect(c.pricing).toBe('cycle');
    expect(c.charges.map((l) => [l.kind, l.amount, l.timing])).toEqual([
      ['plan', 20_000_000, 'advance'],
      ['seats', 10_000_000, 'advance'],
      ['usage', 1_000_000, 'arrears'],
      ['tax', 3_100_000, undefined]
    ]);
    const usage = c.charges.find((l) => l.kind === 'usage')!;
    expect(usage).toMatchObject({ meter: 'prompt_tokens', quantity: 0.5, unit: '1000000 prompt tokens', unitAmount: 2_000_000 });
    expect(usage.description).toMatch(/beyond the 1000000 included/);
    expect(c).toMatchObject({ subtotal_micros: 31_000_000, tax_micros: 3_100_000, total_micros: 34_100_000, cycle: { kind: 'monthly', planId: 'plan_pro', planName: 'Pro' } });
    // Totals are the sums of the lines.
    expect(sum(c.charges.filter((l) => l.kind !== 'tax'))).toBe(c.subtotal_micros);
    expect(sum(c.charges)).toBe(c.total_micros);
    // The metered detail stays in `lines`, with no money of its own.
    expect(c.lines.map((l) => [l.meter, l.quantity, l.amountMicros, l.priced])).toEqual([['prompt_tokens', 1_500_000, 0, true], ['requests', 2, 0, false]]);
    const st = await h.s.billing.save(h.tenantId, 202605);
    const row = await h.s.db('billing_statements').where({ id: st.id }).first();
    expect(row.pricing).toBe('cycle');
    expect(JSON.parse(row.charges)).toHaveLength(4);
    expect(st.charges).toEqual(c.charges);
  });

  it('one statement per quarter: the months inside resolve to the statement of the month it ends in', async () => {
    h.s.billing.useSubscriptions(fakeSubscription(h.tenantId, cycleOf('quarterly', 1), utc(2026, 1, 1), [{ from: utc(2026, 1, 1), to: utc(2027, 1, 1), planId: 'p', planName: 'Team', priceMinor: 9000 }]));
    for (const m of [202601, 202602, 202603]) expect(await h.s.billing.windowFor(h.tenantId, m)).toEqual({ month: 202603, from: utc(2026, 1, 1), to: utc(2026, 4, 1) });
    expect(await h.s.billing.windowFor(h.tenantId, 202604)).toEqual({ month: 202606, from: utc(2026, 4, 1), to: utc(2026, 7, 1) });
    await use(h, utc(2026, 1, 5), { promptTokens: 500_000 });
    await use(h, utc(2026, 3, 31, 23), { promptTokens: 500_000 });
    await use(h, utc(2026, 4, 1), { promptTokens: 9_000_000 });
    const c = await h.s.billing.compute(h.tenantId, 202602);
    expect(c.month).toBe(202603);
    expect(c.charges.map((l) => [l.kind, l.amount])).toEqual([['plan', 90_000_000], ['usage', 2_000_000]]);
    expect(c.totals.promptTokens).toBe(1_000_000);
    const st = await h.s.billing.save(h.tenantId, 202601);
    expect(st.month).toBe(202603);
    expect((await h.s.billing.statements(h.tenantId)).map((x) => x.month)).toEqual([202603]);
  });

  it('annual and custom cycles, and a cycle anchored on the 15th with the days before the subscription', async () => {
    h.s.billing.useSubscriptions(fakeSubscription(h.tenantId, cycleOf('annual', 1), utc(2025, 7, 1), [{ from: utc(2025, 7, 1), to: utc(2030, 1, 1), planId: 'p', planName: 'Year', priceMinor: 100_000 }]));
    expect(await h.s.billing.windowFor(h.tenantId, 202601)).toEqual({ month: 202606, from: utc(2025, 7, 1), to: utc(2026, 7, 1) });
    h.s.billing.useSubscriptions(fakeSubscription(h.tenantId, cycleOf('custom', 10, 2), utc(2026, 1, 10), [{ from: utc(2026, 1, 10), to: utc(2030, 1, 1), planId: 'p', planName: 'Two', priceMinor: 100 }]));
    expect(await h.s.billing.windowFor(h.tenantId, 202602)).toEqual({ month: 202603, from: utc(2026, 1, 10), to: utc(2026, 3, 10) });
    // Before the start: the days of January up to the 10th are a statement of their own.
    expect(await h.s.billing.windowFor(h.tenantId, 202601)).toEqual({ month: 202601, from: utc(2026, 1, 1), to: utc(2026, 1, 10) });

    h.s.billing.useSubscriptions(fakeSubscription(h.tenantId, cycleOf('monthly', 15), utc(2026, 3, 15), [{ from: utc(2026, 3, 15), to: utc(2030, 1, 1), planId: 'p', planName: 'Mid', priceMinor: 1000, allowances: { prompt_tokens: 1_000_000 } }]));
    expect(await h.s.billing.windowFor(h.tenantId, 202603)).toEqual({ month: 202603, from: utc(2026, 3, 1), to: utc(2026, 3, 15) });
    expect(await h.s.billing.windowFor(h.tenantId, 202604)).toEqual({ month: 202604, from: utc(2026, 3, 15), to: utc(2026, 4, 15) });
    // Usage before the subscription is priced without the allowance; usage under it uses the allowance.
    await use(h, utc(2026, 3, 10), { promptTokens: 1_000_000 });
    await use(h, utc(2026, 3, 20), { promptTokens: 1_000_000 });
    const gap = await h.s.billing.compute(h.tenantId, 202603);
    expect(gap.charges.map((l) => [l.kind, l.amount])).toEqual([['usage', 2_000_000]]);
    const cyc = await h.s.billing.compute(h.tenantId, 202604);
    expect(cyc.charges.map((l) => [l.kind, l.amount])).toEqual([['plan', 10_000_000]]);

    // Anchored on the 31st and on the 28th through February 2027.
    h.s.billing.useSubscriptions(fakeSubscription(h.tenantId, cycleOf('monthly', 31), utc(2027, 1, 31), [{ from: utc(2027, 1, 31), to: utc(2030, 1, 1), planId: 'p', planName: 'End', priceMinor: 1 }]));
    expect(await h.s.billing.windowFor(h.tenantId, 202702)).toEqual({ month: 202702, from: utc(2027, 1, 31), to: utc(2027, 2, 28) });
    expect(await h.s.billing.windowFor(h.tenantId, 202703)).toEqual({ month: 202703, from: utc(2027, 2, 28), to: utc(2027, 3, 31) });
    h.s.billing.useSubscriptions(fakeSubscription(h.tenantId, cycleOf('monthly', 28), utc(2027, 1, 28), [{ from: utc(2027, 1, 28), to: utc(2030, 1, 1), planId: 'p', planName: 'Late', priceMinor: 1 }]));
    expect(await h.s.billing.windowFor(h.tenantId, 202702)).toEqual({ month: 202702, from: utc(2027, 1, 28), to: utc(2027, 2, 28) });
  });

  it('a price book version that takes effect inside a cycle splits it', async () => {
    await h.s.db('price_book_versions').insert({ id: ulid(), book_id: bookId, items: JSON.stringify([promptItem(6_000_000)]), effective_from: utc(2026, 5, 16), created_by: 'admin', created_at: Date.now() });
    h.s.billing.useSubscriptions(fakeSubscription(h.tenantId, cycleOf('monthly', 1), utc(2026, 5, 1), [{ from: utc(2026, 5, 1), to: utc(2027, 1, 1), planId: 'p', planName: 'Pay', priceMinor: 0 }]));
    await use(h, utc(2026, 5, 2), { promptTokens: 1_000_000 });
    await use(h, utc(2026, 5, 20), { promptTokens: 2_000_000 });
    const c = await h.s.billing.compute(h.tenantId, 202605);
    const usage = c.charges.filter((l) => l.kind === 'usage');
    // 1M at 2.00 before the change, 2M at 6.00 after: 14.00, not 18.00 or 6.00.
    expect(usage.map((l) => [l.amount, l.from, l.to])).toEqual([
      [2_000_000, utc(2026, 5, 1), utc(2026, 5, 16)],
      [12_000_000, utc(2026, 5, 16), utc(2026, 6, 1)]
    ]);
    expect(c.lines.every((l) => l.from != null)).toBe(true);
    expect(c.subtotal_micros).toBe(14_000_000);
  });

  it('prorates a plan change and a seat change in the middle of the cycle from periods()', async () => {
    h.s.billing.useSubscriptions(
      fakeSubscription(h.tenantId, cycleOf('monthly', 1), utc(2026, 5, 1), [
        { from: utc(2026, 5, 1), to: utc(2026, 5, 16), planId: 'basic', planName: 'Basic', priceMinor: 1000, seats: 2, includedSeats: 2, seatPriceMinor: 700 },
        { from: utc(2026, 5, 16), to: utc(2027, 1, 1), planId: 'pro', planName: 'Pro', priceMinor: 3100, seats: 4, includedSeats: 2, seatPriceMinor: 700 }
      ])
    );
    const c = await h.s.billing.compute(h.tenantId, 202605);
    // 16 of May's 31 days remain after the change: Basic 10.00 in advance, 5.16 back, Pro 31.00 × 16/31 = 16.00,
    // and two seats above the included at 7.00 each for 16/31: 7.23 (14.00 × 16/31 = 7.2258…).
    expect(c.charges.map((l) => [l.kind, l.amount])).toEqual([
      ['plan', 10_000_000],
      ['proration', -5_160_000],
      ['proration', 16_000_000],
      ['proration', 7_230_000]
    ]);
    expect(c.charges[1]!.description).toMatch(/^Unused Basic plan, 2026-05-16 to 2026-06-01/);
    expect(c.subtotal_micros).toBe(28_070_000);
    expect(sum(c.charges)).toBe(c.total_micros);
    for (const l of c.charges) expect(Math.abs(l.amount % 10_000)).toBe(0);
  });
});

describe('B-163 before migrations 125 and 126', () => {
  it('on a database migrated only to 124, compute, save, push and close behave as before Sprint 51', async () => {
    const h = await harness();
    try {
      // The harness applies only the registered migrations; make sure this database has none of 125 and 126.
      for (const c of ['period_start', 'period_end', 'cycle', 'charges', 'pricing', 'discount_micros']) if (await h.s.db.schema.hasColumn('billing_statements', c)) await h.s.db.schema.alterTable('billing_statements', (t) => t.dropColumn(c));
      for (const t of ['billing_discount_policy', 'billing_discount_approvals', 'billing_promo_redemptions', 'billing_promo_codes', 'billing_discount_rules']) await h.s.db.schema.dropTableIfExists(t);
      await h.s.billing.createBook('admin', { name: 'Book', currency: 'USD', isDefault: true, items: [promptItem(2_000_000)] });
      const now = new Date();
      const last = now.getUTCMonth() === 0 ? (now.getUTCFullYear() - 1) * 100 + 12 : now.getUTCFullYear() * 100 + now.getUTCMonth();
      const lastTs = Date.UTC(Math.floor(last / 100), (last % 100) - 1, 10);
      await use(h, lastTs, { promptTokens: 1_000_000 });
      const c = await h.s.billing.compute(h.tenantId, last);
      expect(c).toMatchObject({ pricing: 'monthly', subtotal_micros: 2_000_000, total_micros: 2_000_000 });
      expect(c.lines.find((l) => l.meter === 'prompt_tokens')!.amountMicros).toBe(2_000_000);
      expect(await h.s.billing.closePrevious(h.tenantId)).toMatchObject({ totalMicros: 2_000_000 });
      const st = (await h.s.billing.statement(h.tenantId, last))!;
      expect(st).toMatchObject({ state: 'closed', total_micros: 2_000_000, pricing: 'monthly', charges: [expect.objectContaining({ amount: 2_000_000 })] });
      // No provider configured: push refuses exactly as before, not with a database error.
      await expect(h.s.billing.push(h.tenantId, last)).rejects.toMatchObject({ status: 409 });
      expect(await h.s.billing.statements(h.tenantId)).toHaveLength(1);
    } finally {
      await h.close();
    }
  });
});
