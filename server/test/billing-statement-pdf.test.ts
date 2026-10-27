/*
 * 1.9.0, Sprint 51 (B-166): a statement as PDF (its plan, subscription lines, usage by meter and tier, discounts,
 * taxes, totals and credit notes), and statement lines pushed to Stripe as invoice items, subscription and discount
 * lines included, each with its own idempotency key, against a fake Stripe only.
 */
import { inflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';
import { FakeStripe } from './sprint13-fakes.js';
import { up as m124 } from '../src/db/migrations/124_billing_plans_subscriptions.js';
import { invoiceLines, moneyText, readStatement } from '../src/billing/invoice-lines.js';
import { statementPdfDoc } from '../src/billing/pdf.js';
import { toPdf } from '../src/chat/export-pdf.js';
import { StripeProvider } from '../src/billing/stripe.js';
import { previousMonth, monthToText } from '../src/billing/service.js';

/**
 * The Sprint 51 tables, for as long as their migrations are not yet in `migrations/index.ts` (each applied only when
 * what it adds is missing, so this is a no-op once they are registered).
 */
async function sprint51Schema(h: Harness): Promise<void> {
  const db = h.s.db;
  if (!(await db.schema.hasTable('billing_subscription_events'))) await m124(db);
  if (!(await db.schema.hasColumn('billing_statements', 'charges'))) await (await import('../src/db/migrations/125_billing_cycles_tiers.js')).up(db);
  if (!(await db.schema.hasTable('billing_discount_rules'))) await (await import('../src/db/migrations/126_billing_discounts.js')).up(db);
}

/** The text of a PDF: every Flate stream inflated, and the literal strings in it. */
function pdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  let out = '';
  const re = /stream\n([\s\S]*?)\nendstream/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    try {
      out += inflateSync(Buffer.from(m[1]!, 'latin1')).toString('latin1');
    } catch {
      /* an image */
    }
  }
  return [...out.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)].map((x) => x[1]!.replace(/\\(.)/g, '$1')).join(' ');
}

/** A cycle statement row as the engine stores it (`charges`), with every kind of line. */
const chargeRow = (over: Record<string, unknown> = {}) => ({
  id: '01JZSTATEMENT0000000000001',
  tenant_id: '01JZTENANT0000000000000001',
  month: 202609,
  period_start: Date.UTC(2026, 8, 1),
  period_end: Date.UTC(2026, 9, 1),
  currency: 'USD',
  state: 'closed',
  book_name: 'Standard',
  subtotal_micros: 63_000_000,
  tax_micros: 6_300_000,
  total_micros: 69_300_000,
  credited_micros: 5_000_000,
  credits: JSON.stringify([{ id: 'cn_1', amountMicros: 5_000_000, state: 'issued' }]),
  computed_at: Date.UTC(2026, 9, 1, 1),
  lines: JSON.stringify([]),
  charges: JSON.stringify([
    { kind: 'plan', description: 'Team plan, 2026-09-01 to 2026-09-30', quantity: 1, unit: 'cycle', unitAmount: 50_000_000, amount: 50_000_000, timing: 'advance', planId: 'p1' },
    { kind: 'seats', description: '2 seats above the 3 included', quantity: 2, unit: 'seat', unitAmount: 5_000_000, amount: 10_000_000, timing: 'advance' },
    { kind: 'proration', description: 'Unused Team plan, 2026-09-16 to 2026-09-30', quantity: -0.5, unit: 'cycle', unitAmount: 2_000_000, amount: -1_000_000 },
    { kind: 'usage', description: 'Prompt tokens beyond the allowance', quantity: 1_000_000, unit: '1000000 prompt tokens', unitAmount: 3_000_000, amount: 3_000_000, meter: 'prompt_tokens', tier: 1, timing: 'arrears' },
    { kind: 'usage', description: 'Prompt tokens beyond the allowance', quantity: 2_000_000, unit: '1000000 prompt tokens', unitAmount: 2_000_000, amount: 4_000_000, meter: 'prompt_tokens', tier: 2, timing: 'arrears' },
    { kind: 'discount', description: 'WELCOME10: 5 off', quantity: 1, unit: 'amount', unitAmount: 3_000_000, amount: -3_000_000, ruleId: 'rule_welcome' },
    { kind: 'tax', description: 'VAT 10%', quantity: 1, unit: 'percent', unitAmount: 100_000, amount: 6_300_000 }
  ]),
  ...over
});

describe('B-166 statement lines', () => {
  it('reads charge lines and legacy lines alike', () => {
    const doc = readStatement(chargeRow());
    expect(doc.lines.map((l) => l.group)).toEqual(['subscription', 'subscription', 'subscription', 'usage', 'usage', 'discount', 'tax']);
    expect(doc.periodText).toBe('2026-09-01 to 2026-09-30');
    const legacy = readStatement({ id: 'x', tenant_id: 't', month: 202608, currency: 'USD', total_micros: 1_100_000, subtotal_micros: 1_000_000, lines: JSON.stringify([{ kind: 'chat', model: 'm', profile: null, meter: 'prompt_tokens', quantity: 10, perUnits: 1_000_000, unitPriceMicros: 100_000_000_000, amountMicros: 1_000_000, priced: true }]), taxes: JSON.stringify([{ name: 'VAT', ratePpm: 100_000, amountMicros: 100_000 }]) });
    expect(legacy.lines.map((l) => [l.group, l.amountMicros])).toEqual([['usage', 1_000_000], ['tax', 100_000]]);
    expect(legacy.periodText).toBe('2026-08');
    // Legacy items are word for word what the push sent before, keyed by position.
    expect(invoiceLines(legacy)).toEqual([{ description: '2026-08 chat m: 10 prompt tokens', amountMinor: 100 }, { description: '2026-08 VAT 10%', amountMinor: 10 }]);
    expect(moneyText(-1_234_567_890, 'USD')).toBe('-1,234.57 USD');
    expect(moneyText(1_500_000, 'JPY')).toBe('2 JPY');
  });

  it('gives every charge line its own invoice item and key, discounts and credits included', () => {
    const lines = invoiceLines(readStatement(chargeRow()));
    expect(lines.map((l) => l.amountMinor)).toEqual([5000, 1000, -100, 300, 400, -300, 630]);
    expect(lines.every((l) => l.key && /^[a-z]+-[0-9a-f]{24}$/.test(l.key))).toBe(true);
    expect(new Set(lines.map((l) => l.key)).size).toBe(lines.length);
    expect(lines.reduce((a, l) => a + l.amountMinor, 0)).toBe(6930);
    // The same line twice gets two keys; the keys do not depend on order.
    const twice = JSON.parse(chargeRow().charges);
    twice.push(twice[0]);
    const k2 = invoiceLines(readStatement(chargeRow({ charges: JSON.stringify(twice) }))).map((l) => l.key);
    expect(k2.at(-1)).toBe(`${k2[0]}-2`);
    const reversed = invoiceLines(readStatement(chargeRow({ charges: JSON.stringify([...JSON.parse(chargeRow().charges)].reverse()) }))).map((l) => l.key);
    expect(new Set(reversed)).toEqual(new Set(lines.map((l) => l.key)));
    // A provider's credit note line is not sent back.
    const withCredit = [...JSON.parse(chargeRow().charges), { kind: 'credit', description: 'cn_9', amount: -1_000_000, quantity: 1, unit: 'note', unitAmount: 0 }];
    expect(invoiceLines(readStatement(chargeRow({ charges: JSON.stringify(withCredit) })))).toHaveLength(7);
  });

  it('lays a statement out as a valid PDF with its lines', () => {
    const doc = readStatement(chargeRow());
    const pdf = toPdf(statementPdfDoc(doc, { tenantName: 'Acme', by: 'Pat', plan: { name: 'Team', seats: 5, includedSeats: 3, state: 'active' }, label: 'internal' }), { size: 'a4', orientation: 'portrait' });
    const raw = pdf.toString('latin1');
    expect(raw.startsWith('%PDF-1.4')).toBe(true);
    expect(raw.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(raw).toMatch(/\/Type \/Catalog/);
    // The xref offsets point at the objects.
    const start = Number(/startxref\n(\d+)/.exec(raw)![1]);
    expect(raw.slice(start, start + 4)).toBe('xref');
    const text = pdfText(pdf);
    for (const s of ['Statement 2026-09-01 to 2026-09-30', 'Plan', 'Team, 5 seats', 'Subscription', 'Team plan, 2026-09-01 to 2026-09-30', 'Usage by meter and tier', 'Tier 1', 'Tier 2', 'Discounts', 'WELCOME10: 5 off', 'rule_welcome', 'Totals', 'Subtotal', '63.00 USD', 'VAT 10%', 'Total', '69.30 USD', 'Credit note cn_1', '-5.00 USD', 'Balance', '64.30 USD']) expect(text).toContain(s);
  });
});

describe('B-166 the PDF route and the Stripe push', () => {
  let h: Harness;
  let stripe: FakeStripe;
  beforeEach(async () => {
    stripe = await new FakeStripe().start();
    h = await harness({ BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: stripe.key, STRIPE_API_URL: stripe.url });
    await sprint51Schema(h);
  });
  afterEach(async () => {
    await h.close();
    await stripe.stop();
  });

  it('serves a stored statement of the tenant as PDF, audited, and no other tenant\'s', async () => {
    await localUser(h, 'root', ['system-admin'], 'restricted');
    const root = await loginAdmin(h, 'root');
    const item = [{ match: 'any', value: null, usage: '*', meter: 'prompt_tokens', perUnits: 1_000_000, unitPriceMicros: 2_000_000 }];
    await root.agent.post('/api/admin/billing/price-books').set('x-csrf-token', root.csrf).send({ name: 'P', currency: 'USD', isDefault: true, items: item }).expect(201);
    const month = previousMonth();
    const y = Math.floor(month / 100);
    const mo = month % 100;
    await h.s.quotas.record({ tenantId: h.tenantId, workspaceId: null, userId: null, kind: 'chat', model: 'llama', promptTokens: 3_000_000, outputTokens: 0, gpuMs: 0, ts: Date.UTC(y, mo - 1, 5) });
    const st = (await root.agent.post(`/api/admin/billing/statements/${monthToText(month)}/compute`).set('x-csrf-token', root.csrf).expect(200)).body;
    const res = await root.agent.get(`/api/admin/billing/statements/${st.id}.pdf`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toMatch(/statement-.*\.pdf/);
    const text = pdfText(res.body as Buffer);
    expect(text).toContain('Usage by meter and tier');
    expect(text).toContain('No subscription: billed by usage alone.');
    expect(text).toContain('6.00 USD');
    const audit = await h.s.db('audit_events').where({ action: 'billing.statement.exported' }).first();
    expect(JSON.parse(audit.detail)).toMatchObject({ format: 'pdf' });
    // Another tenant's statement id is not found; a malformed id is refused.
    const other = await h.s.tenants.create({ slug: 'other', name: 'Other' });
    await h.s.db('billing_statements').where({ id: st.id }).update({ tenant_id: other.id });
    await root.agent.get(`/api/admin/billing/statements/${st.id}.pdf`).expect(404);
    await root.agent.get('/api/admin/billing/statements/nope.pdf').expect(400);
  });

  it('pushes subscription and discount lines as their own items, once, however often it is retried', async () => {
    const provider = new StripeProvider({ secretKey: stripe.key, apiUrl: stripe.url, timeoutMs: 5000, daysUntilDue: 30 });
    const doc = readStatement(chargeRow());
    const input = { customer: 'cus_1', statementId: doc.id, tenantId: doc.tenantId, month: '2026-09', currency: 'USD', lines: invoiceLines(doc) };
    const first = await provider.invoice(input);
    const again = await provider.invoice(input);
    expect(again).toBe(first);
    expect(stripe.items).toHaveLength(7);
    expect(stripe.invoices).toHaveLength(1);
    expect(stripe.items.map((x) => Number(x.amount))).toEqual([5000, 1000, -100, 300, 400, -300, 630]);
    const keys = stripe.requests.filter((r) => r.path === '/v1/invoiceitems').map((r) => r.idempotencyKey);
    expect(new Set(keys).size).toBe(7);
    expect(keys.every((k) => k!.startsWith(`exprsn-${doc.id}-`))).toBe(true);
    expect(stripe.items[5]).toMatchObject({ description: '2026-09 WELCOME10: 5 off', 'metadata[statement]': doc.id });
    expect(stripe.items[0]!['metadata[line]']).toMatch(/^plan-/);
  });

  it('pushes an older statement exactly as before', async () => {
    await localUser(h, 'root', ['system-admin'], 'restricted');
    const root = await loginAdmin(h, 'root');
    const item = [{ match: 'any', value: null, usage: '*', meter: 'prompt_tokens', perUnits: 1_000_000, unitPriceMicros: 1_000_000 }];
    await root.agent.post('/api/admin/billing/price-books').set('x-csrf-token', root.csrf).send({ name: 'P', currency: 'USD', isDefault: true, items: item }).expect(201);
    await root.agent.put(`/api/admin/billing/tenants/${h.tenantId}`).set('x-csrf-token', root.csrf).send({ billingCustomer: 'cus_9' }).expect(200);
    const month = previousMonth();
    const y = Math.floor(month / 100);
    const mo = month % 100;
    await h.s.quotas.record({ tenantId: h.tenantId, workspaceId: null, userId: null, kind: 'chat', model: 'm', promptTokens: 2_000_000, outputTokens: 0, gpuMs: 0, ts: Date.UTC(y, mo - 1, 3) });
    const pushed = (await root.agent.post(`/api/admin/billing/statements/${monthToText(month)}/push`).set('x-csrf-token', root.csrf).expect(200)).body;
    expect(pushed.state).toBe('pushed');
    const items = stripe.requests.filter((r) => r.path === '/v1/invoiceitems');
    expect(items.map((r) => [r.idempotencyKey, r.form.amount])).toEqual([[`exprsn-${pushed.id}-item-0`, '200']]);
    expect(items[0]!.form.description).toBe(`${monthToText(month)} chat m: 2000000 prompt tokens`);
  });
});
