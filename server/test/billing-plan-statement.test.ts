import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invoiceLines, readStatement } from '../src/billing/invoice-lines.js';
import { statementPdf } from '../src/billing/pdf.js';
import type { PlanActor } from '../src/billing/plans.js';
import type { SubscriptionActor } from '../src/billing/subscriptions.js';
import { harness, localUser, type Harness } from './helpers.js';
import { promptItem, use, utc } from './billing-sprint51-helpers.js';

// Sprint 51 end to end: a real plan (approved by a second platform admin) and a real subscription (B-162) become the
// plan, seat and usage lines of a cycle statement (B-163), its PDF and its Stripe invoice lines (B-166), with
// migrations 124 to 126 applied by the ordinary migrate.
describe('a subscription on its statement', () => {
  let h: Harness;
  let a: PlanActor;
  let b: PlanActor;
  beforeEach(async () => {
    h = await harness();
    const ua = await localUser(h, 'pa', ['system-admin'], 'restricted');
    const ub = await localUser(h, 'pb', ['system-admin'], 'restricted');
    a = { tenantId: h.tenantId, userId: ua.id, actor: { user: ua.id, username: 'pa' } };
    b = { tenantId: h.tenantId, userId: ub.id, actor: { user: ub.id, username: 'pb' } };
  });
  afterEach(async () => {
    await h.close();
  });

  it('charges the plan and seats in advance and usage beyond the allowance, and carries them to the PDF and Stripe', async () => {
    await h.s.billing.createBook('pa', { name: 'Default', currency: 'USD', isDefault: true, items: [promptItem(2_000_000)] });
    const { plan } = await h.s.plans.create(a, { key: 'pro', name: 'Pro', visibility: 'visible', trialDays: 0, prices: [{ currency: 'USD', months: 1, priceMinor: 2000, seatPriceMinor: 500, includedSeats: 3 }], allowances: { prompt_tokens: 1_000_000 }, entitlements: {} });
    await h.s.plans.approve(b, plan.id, 1, null);
    await h.s.db('billing_plan_versions').where({ plan_id: plan.id }).update({ effective_from: 0 });
    const platform: SubscriptionActor = { ...a, platform: true };
    await h.s.subscriptions.subscribe(platform, h.tenantId, { planId: plan.id, seats: 5, currency: 'USD', cycle: { kind: 'monthly', anchorDay: 1 } }, utc(2026, 5, 1));
    await use(h, utc(2026, 5, 3), { promptTokens: 1_500_000 });

    const c = await h.s.billing.compute(h.tenantId, 202605);
    expect(c.pricing).toBe('cycle');
    expect(c.charges.map((l) => [l.kind, l.amount, l.timing])).toEqual([
      ['plan', 20_000_000, 'advance'],
      ['seats', 10_000_000, 'advance'],
      ['usage', 1_000_000, 'arrears']
    ]);
    expect(c.total_micros).toBe(31_000_000);

    const st = await h.s.billing.save(h.tenantId, 202605);
    const row = await h.s.db('billing_statements').where({ id: st.id }).first();
    const lines = invoiceLines(readStatement(row));
    expect(lines.map((l) => l.amountMinor)).toEqual([2000, 1000, 100]);
    expect(new Set(lines.map((l) => l.key)).size).toBe(3);

    const { pdf, filename } = await statementPdf(h.s, h.tenantId, st.id, 'pa');
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(filename).toMatch(/\.pdf$/);
  });
});
