/*
 * Sprint 51 (B-164): tiered pricing in price books: flat, graduated, volume and package, at the edges of each tier;
 * a cycle's minimum and cap; exact minor units on the statement; validation of tiered items.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PriceItem } from '../src/billing/service.js';
import { minimumOrCap, priceItemCycle, tierIndex } from '../src/billing/tiers.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';
import { billingSchema, promptItem, use, utc } from './billing-sprint51-helpers.js';

const tiers = [
  { upTo: 1_000_000, unitPriceMicros: 1_000_000 },
  { upTo: 5_000_000, unitPriceMicros: 500_000 },
  { upTo: null, unitPriceMicros: 250_000 }
];
const item = (o: Partial<PriceItem>): PriceItem => ({ ...promptItem(0), ...o });
const once = (it: PriceItem, q: number) => priceItemCycle([{ item: it, quantity: q, from: 0, to: 1 }]);
const total = (ps: { amountMicros: number }[]) => ps.reduce((a, p) => a + p.amountMicros, 0);

describe('B-164 pricing models', () => {
  it('flat is quantity × price / perUnits, as before', () => {
    expect(total(once(item({ unitPriceMicros: 2_000_000 }), 1_500_000))).toBe(3_000_000);
    expect(total(once(item({ pricing: 'flat', unitPriceMicros: 3 }), 1))).toBe(0); // 3/1,000,000 of a micro rounds to 0
  });

  it('graduated: each tier prices its own units; a tier bound is inclusive', () => {
    const g = item({ pricing: 'graduated', tiers });
    expect(once(g, 1_000_000).map((p) => [p.tier, p.quantity, p.amountMicros])).toEqual([[1, 1_000_000, 1_000_000]]);
    // One unit past the bound: 0.5 micro, rounded half up to 1.
    expect(once(g, 1_000_001).map((p) => [p.tier, p.quantity, p.amountMicros])).toEqual([[1, 1_000_000, 1_000_000], [2, 1, 1]]);
    expect(once(g, 5_000_000).map((p) => p.amountMicros)).toEqual([1_000_000, 2_000_000]);
    expect(once(g, 6_000_000).map((p) => [p.tier, p.amountMicros])).toEqual([[1, 1_000_000], [2, 2_000_000], [3, 250_000]]);
    expect(once(g, 0)).toEqual([]);
    // A tier's fixed amount, once, when a unit reaches it.
    const flat = item({ pricing: 'graduated', tiers: [tiers[0]!, { ...tiers[1]!, flatMicros: 100_000 }, tiers[2]!] });
    expect(total(once(flat, 1_000_000))).toBe(1_000_000);
    expect(total(once(flat, 2_000_000))).toBe(1_600_000);
  });

  it('volume: the tier the whole quantity reaches prices every unit', () => {
    const v = item({ pricing: 'volume', tiers });
    expect(tierIndex(tiers, 1_000_000)).toBe(0);
    expect(tierIndex(tiers, 1_000_001)).toBe(1);
    expect(once(v, 1_000_000).map((p) => [p.tier, p.amountMicros])).toEqual([[1, 1_000_000]]);
    expect(once(v, 1_000_001).map((p) => [p.tier, p.amountMicros])).toEqual([[2, 500_001]]);
    expect(once(v, 5_000_000).map((p) => [p.tier, p.amountMicros])).toEqual([[2, 2_500_000]]);
    expect(once(v, 5_000_001).map((p) => [p.tier, p.amountMicros])).toEqual([[3, 1_250_000]]);
  });

  it('package: per block of perUnits, a part block rounded up', () => {
    const p = item({ pricing: 'package', perUnits: 1000, unitPriceMicros: 2_000_000 });
    expect(once(p, 1).map((x) => [x.blocks, x.amountMicros])).toEqual([[1, 2_000_000]]);
    expect(once(p, 1000).map((x) => [x.blocks, x.amountMicros])).toEqual([[1, 2_000_000]]);
    expect(once(p, 1001).map((x) => [x.blocks, x.amountMicros])).toEqual([[2, 4_000_000]]);
    expect(once(p, 0)).toEqual([]);
  });

  it('tiers carry over price book segments inside a cycle', () => {
    const g = item({ pricing: 'graduated', tiers });
    const g2 = item({ pricing: 'graduated', tiers: tiers.map((t) => ({ ...t, unitPriceMicros: t.unitPriceMicros * 2 })) });
    const two = priceItemCycle([{ item: g, quantity: 600_000, from: 0, to: 1 }, { item: g2, quantity: 600_000, from: 1, to: 2 }]);
    // The second segment continues the ladder at 600,000: 400,000 in tier 1 and 200,000 in tier 2, at its own prices.
    expect(two.map((p) => [p.from, p.tier, p.quantity, p.amountMicros])).toEqual([[0, 1, 600_000, 600_000], [1, 1, 400_000, 800_000], [1, 2, 200_000, 200_000]]);
    const pk = item({ pricing: 'package', perUnits: 1000, unitPriceMicros: 1_000_000 });
    expect(priceItemCycle([{ item: pk, quantity: 600, from: 0, to: 1 }, { item: pk, quantity: 600, from: 1, to: 2 }]).map((p) => p.blocks)).toEqual([1, 1]);
    expect(priceItemCycle([{ item: pk, quantity: 300, from: 0, to: 1 }, { item: pk, quantity: 300, from: 1, to: 2 }]).map((p) => p.blocks)).toEqual([1, 0]);
    const v = item({ pricing: 'volume', tiers });
    expect(priceItemCycle([{ item: v, quantity: 600_000, from: 0, to: 1 }, { item: v, quantity: 600_000, from: 1, to: 2 }]).map((p) => [p.tier, p.amountMicros])).toEqual([[2, 300_000], [2, 300_000]]);
  });

  it('a minimum raises an item to it and a cap lowers it, per cycle', () => {
    expect(minimumOrCap({ minimumMicros: 5_000_000 }, 1_500_000)).toEqual({ tier: 'minimum', amountMicros: 3_500_000 });
    expect(minimumOrCap({ minimumMicros: 5_000_000 }, 5_000_000)).toBeNull();
    expect(minimumOrCap({ capMicros: 1_000_000 }, 3_000_000)).toEqual({ tier: 'cap', amountMicros: -2_000_000 });
    expect(minimumOrCap({ capMicros: 1_000_000 }, 1_000_000)).toBeNull();
    expect(minimumOrCap({}, 9)).toBeNull();
  });
});

describe('B-164 tiered statements', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
    await billingSchema(h);
  });
  afterEach(async () => {
    await h.close();
  });

  it('prices tiers, minimums and caps on the statement in exact minor units', async () => {
    await h.s.billing.createBook('admin', {
      name: 'Tiered',
      currency: 'USD',
      isDefault: true,
      items: [
        item({ pricing: 'graduated', tiers, minimumMicros: 5_000_000 }),
        { match: 'any', value: null, usage: '*', meter: 'output_tokens', perUnits: 1_000_000, unitPriceMicros: 1_000_000, capMicros: 1_000_000 },
        { match: 'any', value: null, usage: '*', meter: 'thinking_tokens', perUnits: 1_000_000, unitPriceMicros: 1_000_000, minimumMicros: 750_000 },
        { match: 'any', value: null, usage: '*', meter: 'requests', perUnits: 10, unitPriceMicros: 1_000_000, pricing: 'package' }
      ]
    });
    await use(h, utc(2026, 5, 3), { promptTokens: 1_000_001, outputTokens: 3_000_000 });
    await use(h, utc(2026, 5, 4), { promptTokens: 999_999 });
    await use(h, utc(2026, 5, 5), {});
    const c = await h.s.billing.compute(h.tenantId, 202605);
    // No subscription, but tiered prices: a cycle statement of the calendar month.
    expect(c).toMatchObject({ pricing: 'cycle', period_start: utc(2026, 5, 1), period_end: utc(2026, 6, 1) });
    expect(c.charges.map((l) => [l.meter, l.tier ?? null, l.amount])).toEqual([
      ['prompt_tokens', 1, 1_000_000],
      ['prompt_tokens', 2, 500_000],
      ['prompt_tokens', 'minimum', 3_500_000],
      ['output_tokens', null, 3_000_000],
      ['output_tokens', 'cap', -2_000_000],
      ['thinking_tokens', 'minimum', 750_000],
      ['requests', null, 1_000_000]
    ]);
    expect(c.charges.find((l) => l.meter === 'requests')).toMatchObject({ quantity: 1, unit: 'block of 10 requests' });
    // 5.00 + 1.00 + 1.00 + 0.75, each line a whole cent and the total their sum.
    expect(c.subtotal_micros).toBe(7_750_000);
    for (const l of c.charges) expect(Math.abs(l.amount % 10_000)).toBe(0);
    expect(c.charges.reduce((a, l) => a + l.amount, 0)).toBe(c.total_micros);
  });

  it('a fraction of a cent on a tier rounds once per line, half away from zero', async () => {
    await h.s.billing.createBook('admin', { name: 'G', currency: 'USD', isDefault: true, items: [item({ pricing: 'graduated', tiers: [{ upTo: 1_000_000, unitPriceMicros: 1_000_000 }, { upTo: null, unitPriceMicros: 10_001 }] })] });
    await use(h, utc(2026, 5, 3), { promptTokens: 1_500_000 });
    const c = await h.s.billing.compute(h.tenantId, 202605);
    // Tier 2: 500,000 × 0.010001 / 1,000,000 = 0.0050005 → 0.01.
    expect(c.charges.filter((l) => l.kind === 'usage').map((l) => l.amount)).toEqual([1_000_000, 10_000]);
    expect(c.total_micros).toBe(1_010_000);
  });

  it('checks tiered items when a price book is saved, and keeps flat items as they were', async () => {
    await localUser(h, 'root', ['system-admin'], 'restricted');
    const root = await loginAdmin(h, 'root');
    const post = (items: unknown[]) => root.agent.post('/api/admin/billing/price-books').set('x-csrf-token', root.csrf).send({ name: `B${Math.random()}`, items });
    await post([item({ pricing: 'graduated' })]).expect(400);
    await post([item({ pricing: 'volume', tiers: [{ upTo: 10, unitPriceMicros: 1 }] })]).expect(400);
    await post([item({ pricing: 'graduated', tiers: [{ upTo: 10, unitPriceMicros: 1 }, { upTo: 5, unitPriceMicros: 1 }, { upTo: null, unitPriceMicros: 1 }] })]).expect(400);
    await post([item({ pricing: 'flat', unitPriceMicros: 1, minimumMicros: 10, capMicros: 5 })]).expect(400);
    const ok = (await post([item({ pricing: 'volume', tiers }), promptItem(5)]).expect(201)).body;
    expect(ok.items[0]).toMatchObject({ pricing: 'volume', tiers });
    expect(ok.items[1]).toEqual(promptItem(5));
  });
});
