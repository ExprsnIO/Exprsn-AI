import type { Run } from '../chat/export-doc.js';
import { toPdf, type PdfBlock, type PdfDoc } from '../chat/export-pdf.js';
import { notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import { moneyText, readStatement, unitText, type NormLine, type StatementDoc } from './invoice-lines.js';

/*
 * 1.9.0, Sprint 51 (B-166): a statement as a PDF, laid out by the chat export's PDF writer (`chat/export-pdf.ts`): the
 * plan and seats, the subscription lines (plan, seats, proration), usage by meter and tier, discounts, taxes, the
 * totals, and the credit notes, refunds and disputes recorded since it was invoiced. Built from the statement's
 * stored lines only, whatever their kind (`readStatement`), so it always shows what was invoiced.
 */

const r = (text: string, bold = false): Run[] => [{ text, ...(bold ? { bold: true } : {}) }];
const day = (t: number | null) => (t == null ? '' : new Date(t).toISOString().slice(0, 10));
const span = (l: NormLine) => (l.from != null && l.to != null ? `${day(l.from)} to ${day(l.to - 1)}` : '');
const qty = (n: number | null) => (n == null ? '' : Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: 3 }));
const tierText = (t: string | null) => (t == null ? '' : t === 'minimum' ? 'Minimum' : t === 'cap' ? 'Cap' : `Tier ${t}`);
const meterText = (m: string | null) => (m ? m.replace(/_/g, ' ') : '');

const table = (header: string[], rows: string[][], opts: { widths?: number[]; align?: ('left' | 'right')[]; total?: boolean } = {}): PdfBlock => ({
  kind: 'table',
  header: header.map((h) => r(h, true)),
  rows: rows.map((row, i) => row.map((c) => r(c, !!opts.total && i === rows.length - 1))),
  ...(opts.widths ? { widths: opts.widths } : {}),
  ...(opts.align ? { align: opts.align } : {}),
  repeatHeader: true,
  size: 8.5
});

/** The PDF document for a statement (exported for tests and other formats). */
export function statementPdfDoc(doc: StatementDoc, o: { tenantName: string; by: string; plan: { name: string; seats: number; includedSeats: number; state: string } | null; label: string }): PdfDoc {
  const cur = doc.currency;
  const m = (x: number) => moneyText(x, cur);
  const blocks: PdfBlock[] = [];
  const group = (g: NormLine['group']) => doc.lines.filter((l) => l.group === g);

  blocks.push({ kind: 'heading', level: 2, text: 'Plan' });
  if (o.plan) blocks.push({ kind: 'para', runs: [{ text: `${o.plan.name}, ${o.plan.seats} seat${o.plan.seats === 1 ? '' : 's'}`, bold: true }, { text: ` (${o.plan.includedSeats} included). The subscription was ${o.plan.state} at the start of the period.` }] });
  else blocks.push({ kind: 'para', runs: r('No subscription: billed by usage alone.'), tone: 'muted' });

  const sub = group('subscription');
  if (sub.length) {
    blocks.push({ kind: 'heading', level: 2, text: 'Subscription' });
    blocks.push(table(['Line', 'Period', 'Quantity', 'Unit price', 'Amount'], sub.map((l) => [l.description, span(l), `${qty(l.quantity)}${l.unit ? ` ${l.unit}` : ''}`, l.unitAmount == null ? '' : unitText(l.unitAmount, cur), m(l.amountMicros)]), { widths: [4, 2.2, 1.6, 1.6, 1.6], align: ['left', 'left', 'right', 'right', 'right'] }));
  }

  const usage = group('usage');
  blocks.push({ kind: 'heading', level: 2, text: 'Usage by meter and tier' });
  if (usage.length) {
    const byMeter = [...new Set(usage.map((l) => l.meter ?? ''))];
    const rows: string[][] = [];
    for (const meter of byMeter) {
      const ls = usage.filter((l) => (l.meter ?? '') === meter);
      for (const l of ls) rows.push([meterText(l.meter), l.description, tierText(l.tier), span(l), qty(l.quantity), l.unitAmount == null ? (l.unpriced ? 'not priced' : '') : `${unitText(l.unitAmount, cur)}${l.unit ? ` per ${l.unit}` : ''}`, m(l.amountMicros)]);
      if (ls.length > 1) rows.push([`${meterText(meter) || 'other'} total`, '', '', '', qty(ls.reduce((a, l) => a + (l.quantity ?? 0), 0)), '', m(ls.reduce((a, l) => a + l.amountMicros, 0))]);
    }
    blocks.push(table(['Meter', 'Line', 'Tier', 'Period', 'Quantity', 'Unit price', 'Amount'], rows, { widths: [1.5, 3.2, 1, 1.9, 1.5, 2.4, 1.6], align: ['left', 'left', 'left', 'left', 'right', 'right', 'right'] }));
  } else blocks.push({ kind: 'para', runs: r('No usage in this period.'), tone: 'muted' });

  const discounts = group('discount');
  if (discounts.length) {
    blocks.push({ kind: 'heading', level: 2, text: 'Discounts' });
    blocks.push(table(['Discount', 'Rule', 'Amount'], discounts.map((l) => [l.description, l.ruleId ?? '', m(l.amountMicros)]), { widths: [5, 2.5, 1.8], align: ['left', 'left', 'right'] }));
  }

  const other = group('other');
  if (other.length) {
    blocks.push({ kind: 'heading', level: 2, text: 'Other lines' });
    blocks.push(table(['Line', 'Kind', 'Amount'], other.map((l) => [l.description, l.kind, m(l.amountMicros)]), { widths: [5, 2, 1.8], align: ['left', 'left', 'right'] }));
  }

  const taxes = group('tax');
  const discountTotal = discounts.reduce((a, l) => a + l.amountMicros, 0);
  const totals: string[][] = [['Subtotal', m(doc.subtotalMicros)]];
  if (discounts.length) totals.push(['Of which discounts', m(discountTotal)]);
  for (const t of taxes) totals.push([t.description, m(t.amountMicros)]);
  if (!taxes.length && doc.taxMicros) totals.push(['Tax', m(doc.taxMicros)]);
  totals.push(['Total', m(doc.totalMicros)]);
  blocks.push({ kind: 'heading', level: 2, text: 'Totals' });
  blocks.push(table(['', 'Amount'], totals, { widths: [6, 2], align: ['left', 'right'], total: true }));

  const credits = [...group('credit').map((l) => ({ id: l.description, state: 'issued', amountMicros: Math.abs(l.amountMicros) })), ...doc.credits];
  if (credits.length || doc.refundedMicros || doc.disputedMicros) {
    blocks.push({ kind: 'heading', level: 2, text: 'Credit notes, refunds and disputes' });
    const rows = credits.map((c) => [`Credit note ${c.id}`, c.state, m(-Math.abs(c.amountMicros))]);
    if (doc.refundedMicros) rows.push(['Refunded', '', m(-doc.refundedMicros)]);
    if (doc.disputedMicros) rows.push(['Disputed', '', m(doc.disputedMicros)]);
    rows.push(['Balance', '', m(doc.totalMicros - doc.creditedMicros - doc.refundedMicros)]);
    blocks.push(table(['', 'State', 'Amount'], rows, { widths: [5, 1.5, 2], align: ['left', 'left', 'right'], total: true }));
  }

  const meta: [string, string][] = [
    ['Tenant', o.tenantName],
    ['Period', doc.periodText],
    ['Statement', doc.id],
    ['State', doc.state],
    ['Currency', cur],
    ...(doc.bookName ? ([['Price book', doc.bookName]] as [string, string][]) : []),
    ...(doc.providerRef ? ([['Invoice', doc.providerRef]] as [string, string][]) : []),
    ['Computed', doc.computedAt ? new Date(doc.computedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : ''],
    ['Exported by', o.by]
  ];
  return { title: `Statement ${doc.periodText}`, meta, blocks, label: o.label, author: o.by, createdAt: new Date().toISOString() };
}

/** Loads a statement by id for one tenant and renders it. Another tenant's statement is not found. */
export async function statementPdf(s: Services, tenantId: string, id: string, by: string): Promise<{ pdf: Buffer; doc: StatementDoc; filename: string }> {
  const row = (await s.db('billing_statements').where({ id, tenant_id: tenantId }).first()) as Record<string, unknown> | undefined;
  if (!row) throw notFound('Statement');
  const doc = readStatement(row);
  const tenant = await s.tenants.byId(tenantId);
  const at = doc.periodStart != null ? await s.subscriptions.at(tenantId, doc.periodStart) : null;
  const plan = at ? { name: at.plan.name, seats: at.seats, includedSeats: at.includedSeats, state: at.state } : null;
  const pdf = toPdf(statementPdfDoc(doc, { tenantName: tenant?.name ?? tenantId, by, plan, label: 'internal' }), { size: 'a4', orientation: 'portrait' });
  const slug = doc.month ? String(doc.month).replace(/^(\d{4})(\d{2})$/, '$1-$2') : day(doc.periodStart);
  return { pdf, doc, filename: `statement-${tenantId.slice(-6).toLowerCase()}-${slug || doc.id.toLowerCase()}.pdf` };
}
