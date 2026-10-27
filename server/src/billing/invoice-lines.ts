import { createHash } from 'node:crypto';
import { json } from '../db/knex.js';
import { minorDigits, monthBounds, monthToText, partText, toMinor } from './service.js';

/*
 * 1.9.0, Sprint 51 (B-166): a stored statement read the same way by the PDF and the Stripe push, whatever its lines.
 *
 * A statement from before 1.9.0 (or a monthly one without a subscription) keeps usage lines in `lines`
 * (`StatementLine`: a usage kind, a meter, `amountMicros`) and taxes in `taxes`. A cycle statement keeps every line
 * in `charges` (`ChargeLine` in `types.ts`: `kind` plan, seats, proration, usage, discount, credit or tax, `amount`
 * in micros). When `charges` has lines they are the statement; otherwise `lines` and `taxes` are. Unknown kinds are
 * kept, under "Other", so nothing on a statement is ever left off its PDF.
 */

export type LineGroup = 'subscription' | 'usage' | 'discount' | 'tax' | 'credit' | 'other';

export interface NormLine {
  group: LineGroup;
  kind: string;
  description: string;
  quantity: number | null;
  unit: string | null;
  /** Micros per unit (or parts per million for a percentage), when the line has one. */
  unitAmount: number | null;
  amountMicros: number;
  meter: string | null;
  tier: string | null;
  model: string | null;
  profile: string | null;
  ruleId: string | null;
  from: number | null;
  to: number | null;
  /** A legacy usage line the price book could not price (kept at zero). */
  unpriced: boolean;
  /** True for a `ChargeLine`; false for a legacy usage or tax line. */
  charge: boolean;
}

export interface StatementDoc {
  id: string;
  tenantId: string;
  currency: string;
  state: string;
  month: number | null;
  periodStart: number | null;
  periodEnd: number | null;
  periodText: string;
  bookName: string | null;
  lines: NormLine[];
  subtotalMicros: number;
  taxMicros: number;
  totalMicros: number;
  creditedMicros: number;
  refundedMicros: number;
  disputedMicros: number;
  credits: { id: string; amountMicros: number; state: string }[];
  providerRef: string | null;
  computedAt: number | null;
}

const GROUP: Record<string, LineGroup> = { plan: 'subscription', seats: 'subscription', proration: 'subscription', subscription: 'subscription', usage: 'usage', discount: 'discount', promotion: 'discount', commitment: 'discount', tax: 'tax', credit: 'credit' };

const num = (x: unknown): number | null => (x == null || x === '' || Number.isNaN(Number(x)) ? null : Number(x));
const str = (x: unknown): string | null => (x == null || x === '' ? null : String(x));

const legacyDescription = (l: Record<string, unknown>): string => `${String(l.kind ?? 'usage')}${l.model ? ` ${String(l.model)}` : ''}${l.profile ? ` (${String(l.profile)})` : ''}: ${String(l.meter ?? '').replace(/_/g, ' ')}`;

/** Reads a `billing_statements` row (any version of it) into the shape the PDF and the push use. */
export function readStatement(r: Record<string, unknown>): StatementDoc {
  const currency = String(r.currency ?? 'USD');
  const month = num(r.month);
  const charges = json<Record<string, unknown>[]>(r.charges, []);
  const legacy = json<Record<string, unknown>[]>(r.lines, []);
  const taxes = json<{ name: string; ratePpm: number; amountMicros: number }[]>(r.taxes, []);
  const useCharges = Array.isArray(charges) && charges.length > 0;
  const lines: NormLine[] = [];
  // A `lines` array that already holds charge lines (an `amount`, no `amountMicros`) is read as charges too.
  const asCharge = (l: Record<string, unknown>) => typeof l.amount === 'number' && l.amountMicros === undefined;
  for (const l of useCharges ? charges : legacy) {
    if (useCharges || asCharge(l)) {
      const kind = String(l.kind ?? 'other');
      lines.push({ group: GROUP[kind] ?? 'other', kind, description: String(l.description ?? kind), quantity: num(l.quantity), unit: str(l.unit), unitAmount: num(l.unitAmount), amountMicros: Math.round(Number(l.amount ?? 0)), meter: str(l.meter), tier: str(l.tier), model: str(l.model), profile: str(l.profile), ruleId: str(l.ruleId), from: num(l.from), to: num(l.to), unpriced: false, charge: true });
    } else {
      lines.push({ group: 'usage', kind: String(l.kind ?? 'usage'), description: legacyDescription(l), quantity: num(l.quantity), unit: l.perUnits ? `${Number(l.perUnits).toLocaleString('en-US')} ${String(l.meter ?? '').replace(/_/g, ' ')}` : null, unitAmount: num(l.unitPriceMicros), amountMicros: Math.round(Number(l.amountMicros ?? 0)), meter: str(l.meter), tier: str(l.tier), model: str(l.model), profile: str(l.profile), ruleId: null, from: num(l.from), to: num(l.to), unpriced: l.priced === false, charge: false });
    }
  }
  if (!useCharges) for (const x of taxes) lines.push({ group: 'tax', kind: 'tax', description: `${x.name} ${(x.ratePpm / 10_000).toFixed(4).replace(/\.?0+$/, '')}%`, quantity: null, unit: null, unitAmount: x.ratePpm, amountMicros: Math.round(Number(x.amountMicros)), meter: null, tier: null, model: null, profile: null, ruleId: null, from: null, to: null, unpriced: false, charge: false });
  const periodStart = num(r.period_start) ?? num(r.cycle_start) ?? (month ? monthBounds(month).from : null);
  const periodEnd = num(r.period_end) ?? num(r.cycle_end) ?? (month ? monthBounds(month).to : null);
  const explicit = num(r.period_start) ?? num(r.cycle_start);
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const periodText = explicit != null && periodEnd != null ? `${day(explicit)} to ${day(periodEnd - 1)}` : month ? monthToText(month) : 'Unknown period';
  const total = num(r.total_micros) ?? 0;
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    currency,
    state: String(r.state ?? 'open'),
    month,
    periodStart,
    periodEnd,
    periodText,
    bookName: str(r.book_name),
    lines,
    subtotalMicros: num(r.subtotal_micros) ?? total,
    taxMicros: num(r.tax_micros) ?? 0,
    totalMicros: total,
    creditedMicros: num(r.credited_micros) ?? 0,
    refundedMicros: num(r.refunded_micros) ?? 0,
    disputedMicros: num(r.disputed_micros) ?? 0,
    credits: json<{ id: string; amountMicros: number; state: string }[]>(r.credits, []),
    providerRef: str(r.provider_ref),
    computedAt: num(r.computed_at)
  };
}

/** A stable key for a charge line: a digest of what it is, numbered when two lines are the same. */
const keyOf = (l: NormLine): string => createHash('sha256').update(JSON.stringify([l.kind, l.description, l.meter, l.tier, l.ruleId, l.model, l.profile, l.from, l.to, l.quantity, l.amountMicros])).digest('hex').slice(0, 24);

/**
 * The invoice items for a statement. Legacy statements give exactly what the push always sent (priced usage lines
 * above zero, then taxes, keyed by position). Charge lines each become an item, subscription and discount lines
 * included (a discount or a proration credit is a negative item), each with its own idempotency key; credit-note
 * lines are the provider's own and are not sent back.
 */
export function invoiceLines(doc: StatementDoc): { description: string; amountMinor: number; key?: string }[] {
  const prefix = doc.month ? monthToText(doc.month) : doc.periodText;
  const out: { description: string; amountMinor: number; key?: string }[] = [];
  const seen = new Map<string, number>();
  for (const l of doc.lines) {
    if (!l.charge) {
      if (l.group === 'usage' && (l.unpriced || l.amountMicros <= 0)) continue;
      if (l.group === 'tax' && l.amountMicros <= 0) continue;
      // Word for word what the push sent before 1.9.0, so a retried push of an older statement matches its items.
      const desc = l.group === 'tax' ? `${prefix} ${l.description}` : `${l.from != null && l.to != null ? partText(l.from, l.to) : prefix} ${l.kind}${l.model ? ` ${l.model}` : ''}${l.profile ? ` (${l.profile})` : ''}: ${l.quantity ?? 0} ${(l.meter ?? '').replace(/_/g, ' ')}`;
      out.push({ description: desc, amountMinor: toMinor(l.amountMicros, doc.currency) });
      continue;
    }
    if (l.group === 'credit') continue;
    const amountMinor = toMinor(l.amountMicros, doc.currency);
    if (amountMinor === 0) continue;
    const base = `${l.kind}-${keyOf(l)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({ description: `${prefix} ${l.description}`.slice(0, 500), amountMinor, key: n > 1 ? `${base}-${n}` : base });
  }
  return out;
}

/** Micros as money text in the currency's minor digits, rounded half away from zero, with thousands separators. */
export function moneyText(micros: number, currency: string): string {
  const digits = minorDigits(currency);
  const step = 10 ** (6 - digits);
  const neg = micros < 0;
  const a = Math.abs(Math.round(micros));
  const minorUnits = Math.floor((a + step / 2) / step);
  const whole = Math.floor(minorUnits / 10 ** digits);
  const frac = digits ? `.${String(minorUnits % 10 ** digits).padStart(digits, '0')}` : '';
  return `${neg && minorUnits ? '-' : ''}${whole.toLocaleString('en-US')}${frac} ${currency.toUpperCase()}`;
}

/** A unit price in micros, with as many decimals as it needs (at most six). */
export function unitText(micros: number, currency: string): string {
  const neg = micros < 0;
  const a = Math.abs(Math.round(micros));
  const whole = Math.floor(a / 1e6);
  const frac = String(a % 1e6).padStart(6, '0').replace(/0+$/, '');
  const digits = minorDigits(currency);
  const shown = frac.length < digits ? frac.padEnd(digits, '0') : frac;
  return `${neg ? '-' : ''}${whole.toLocaleString('en-US')}${shown ? `.${shown}` : ''} ${currency.toUpperCase()}`;
}
