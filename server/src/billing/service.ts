import { ulid } from 'ulid';
import { json } from '../db/knex.js';
import { isUniqueViolation } from '../audit/chain.js';
import { csvLine } from '../audit/exports.js';
import { conflict, HttpProblem, notFound } from '../http/problem.js';
import { monthOf } from '../tenancy/quotas.js';
import type { Services } from '../services.js';
import type { BillingProvider } from './stripe.js';

/*
 * Billing (B-307): price books and monthly statements driven by the usage meter (`usage_records`, written by
 * `QuotaService.record`). A price book is platform-wide (system admins keep it) and prices meters (prompt, output and
 * thinking tokens, GPU-seconds, requests, calculator calls) per usage kind, model or profile; the most specific item
 * wins. A tenant uses its assigned book, else the default one. A statement groups the month's usage by kind, model
 * and profile, prices every meter, and keeps usage it could not price as zero-amount lines, so its totals always
 * reconcile with the usage report. Money is kept in millionths of the currency unit.
 */

export const METERS = ['prompt_tokens', 'output_tokens', 'thinking_tokens', 'gpu_seconds', 'requests', 'calc_calls'] as const;
export type Meter = (typeof METERS)[number];
export const USAGE_KINDS = ['chat', 'compare', 'api', 'load', 'embed', 'training', 'agent', 'workflow', 'image', 'media', 'channel'] as const;

export interface PriceItem {
  /** What the item prices: one model (by name), one profile (by name), or anything. */
  match: 'model' | 'profile' | 'any';
  value: string | null;
  /** A usage kind (`chat`, `api`, `embed`…) or `*` for every kind. */
  usage: string;
  meter: Meter;
  /** The price is for this many units (e.g. 1,000,000 tokens, 3,600 GPU-seconds). */
  perUnits: number;
  /** Price per `perUnits`, in millionths of the currency unit. */
  unitPriceMicros: number;
}

export interface PriceBookRow {
  id: string;
  /** B-1005: a book owned by one tenant (only it may use it), or null for a platform book. */
  tenant_id: string | null;
  name: string;
  currency: string;
  is_default: boolean;
  state: 'active' | 'retired';
  items: PriceItem[];
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface StatementLine {
  kind: string;
  model: string | null;
  profile: string | null;
  meter: Meter;
  quantity: number;
  perUnits: number | null;
  unitPriceMicros: number | null;
  amountMicros: number;
  priced: boolean;
  /** B-1505: the part of the month this line covers when a price change split it (ms, end exclusive). */
  from?: number;
  to?: number;
}

export interface UsageTotals {
  promptTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  gpuSeconds: number;
  requests: number;
  calcCalls: number;
}

export interface StatementRow {
  id: string;
  tenant_id: string;
  month: number;
  book_id: string | null;
  book_name: string | null;
  currency: string;
  total_micros: number;
  lines: StatementLine[];
  totals: UsageTotals;
  state: StatementState;
  provider_ref: string | null;
  push_error: string | null;
  computed_at: number;
  pushed_at: number | null;
  /** B-1005: the priced lines before tax, the taxes, and the provider's reconciliation. */
  subtotal_micros: number;
  tax_micros: number;
  taxes: StatementTax[];
  paid_at: number | null;
  provider_status: string | null;
  /** B-1505: money returned or disputed after payment, and credit notes issued against the invoice. */
  refunded_micros: number;
  credited_micros: number;
  disputed_micros: number;
  dispute_status: string | null;
  credits: StatementCredit[];
  provider_charge: string | null;
  provider_payment: string | null;
}

/** What `compute` gives: the priced month, before anything is stored or reconciled. */
export type ComputedStatement = Omit<StatementRow, ProviderFields>;
type ProviderFields = 'id' | 'state' | 'provider_ref' | 'push_error' | 'pushed_at' | 'paid_at' | 'provider_status' | 'refunded_micros' | 'credited_micros' | 'disputed_micros' | 'dispute_status' | 'credits' | 'provider_charge' | 'provider_payment';

export interface StatementCredit {
  id: string;
  amountMicros: number;
  state: 'issued' | 'void';
}

export type StatementState = 'open' | 'closed' | 'pushed' | 'push failed' | 'paid' | 'payment failed' | 'void' | 'partly refunded' | 'refunded' | 'disputed' | 'dispute lost';
/** States after an invoice exists: the statement is final and is never recomputed or pushed again. */
export const INVOICED: readonly StatementState[] = ['pushed', 'paid', 'payment failed', 'void', 'partly refunded', 'refunded', 'disputed', 'dispute lost'];
/** States in which the invoice has been paid (refunds and disputes apply to these). */
const PAID_STATES: readonly StatementState[] = ['paid', 'partly refunded', 'refunded', 'disputed', 'dispute lost'];

/** A provider event as the reconciliation reads it (B-1005, B-1505). Amounts are in the currency's minor unit. */
export interface ProviderEvent {
  id: string;
  type: string;
  invoiceId: string | null;
  statementId: string | null;
  amountPaidMinor: number | null;
  /** The charge and payment intent an invoice was paid with, or that a refund or dispute names. */
  chargeId?: string | null;
  paymentId?: string | null;
  /** The credit note or dispute id. */
  objectId?: string | null;
  /** Refunded so far (charge), the credit note's total, or the disputed amount. */
  amountMinor?: number | null;
  /** The charge's full amount (to tell a full refund from a partial one). */
  totalMinor?: number | null;
  /** The credit note's or dispute's status. */
  status?: string | null;
}

export interface ReconcileOutcome {
  result: string;
  duplicate: boolean;
  statement: StatementRow | null;
  transition: StatementState | null;
  /** The audit action for what changed, if anything did. */
  action: string | null;
  detail: Record<string, unknown>;
}

/** A price book's items from a moment on (B-1505): statements prorate usage by the version in effect. */
export interface PriceBookVersion {
  id: string;
  book_id: string;
  items: PriceItem[];
  effective_from: number;
  created_at: number;
}

export interface StatementTax {
  name: string;
  ratePpm: number;
  amountMicros: number;
}

const bookFromRow = (r: Record<string, unknown>): PriceBookRow => ({ ...(r as unknown as PriceBookRow), is_default: !!r.is_default, items: json<PriceItem[]>(r.items, []), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
const statementFromRow = (r: Record<string, unknown>): StatementRow => ({ ...(r as unknown as StatementRow), refunded_micros: Number(r.refunded_micros ?? 0), credited_micros: Number(r.credited_micros ?? 0), disputed_micros: Number(r.disputed_micros ?? 0), dispute_status: (r.dispute_status as string | null) ?? null, credits: json<StatementCredit[]>(r.credits, []), provider_charge: (r.provider_charge as string | null) ?? null, provider_payment: (r.provider_payment as string | null) ?? null, month: Number(r.month), total_micros: Number(r.total_micros), subtotal_micros: Number(r.subtotal_micros ?? r.total_micros), tax_micros: Number(r.tax_micros ?? 0), taxes: json<StatementTax[]>(r.taxes, []), paid_at: r.paid_at == null ? null : Number(r.paid_at), provider_status: (r.provider_status as string | null) ?? null, lines: json<StatementLine[]>(r.lines, []), totals: json<UsageTotals>(r.totals, { promptTokens: 0, outputTokens: 0, thinkingTokens: 0, gpuSeconds: 0, requests: 0, calcCalls: 0 }), computed_at: Number(r.computed_at), pushed_at: r.pushed_at == null ? null : Number(r.pushed_at) });

/** Which item prices a meter for a usage group: profile beats model beats any; an exact kind beats `*`. */
export function priceFor(items: readonly PriceItem[], meter: Meter, kind: string, model: string | null, profile: string | null): PriceItem | null {
  let best: PriceItem | null = null;
  let bestScore = -1;
  for (const it of items) {
    if (it.meter !== meter) continue;
    if (it.usage !== '*' && it.usage !== kind) continue;
    let score: number;
    if (it.match === 'profile') {
      if (!profile || it.value !== profile) continue;
      score = 30;
    } else if (it.match === 'model') {
      if (!model || it.value !== model) continue;
      score = 20;
    } else score = 10;
    if (it.usage !== '*') score += 5;
    if (score > bestScore) {
      best = it;
      bestScore = score;
    }
  }
  return best;
}

/** Minor units per major unit for a currency (Stripe's zero-decimal currencies use none). */
export const minorDigits = (currency: string): number => (['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF'].includes(currency.toUpperCase()) ? 0 : 2);
export const toMinor = (micros: number, currency: string): number => Math.round(micros / 10 ** (6 - minorDigits(currency)));
export const fromMinor = (minor: number, currency: string): number => Math.round(minor * 10 ** (6 - minorDigits(currency)));

/** The first instant of a YYYYMM month and of the month after it (UTC, ms). */
export const monthBounds = (m: number): { from: number; to: number } => {
  const y = Math.floor(m / 100);
  const mo = m % 100;
  return { from: Date.UTC(y, mo - 1, 1), to: Date.UTC(y, mo, 1) };
};

/**
 * The parts of a month each price book version covers (B-1505): the version in effect when the month starts, then
 * one part per version that took effect during it. Versions are ordered by when they take effect.
 */
export function segmentsFor(versions: readonly Pick<PriceBookVersion, 'items' | 'effective_from'>[], month: number): { from: number; to: number; items: PriceItem[] }[] {
  const { from, to } = monthBounds(month);
  const sorted = [...versions].sort((a, b) => a.effective_from - b.effective_from);
  const out: { from: number; to: number; items: PriceItem[] }[] = [];
  const atStart = sorted.filter((v) => v.effective_from <= from).at(-1);
  if (atStart) out.push({ from, to, items: atStart.items });
  for (const v of sorted.filter((x) => x.effective_from > from && x.effective_from < to)) {
    const prev = out.at(-1);
    if (prev) prev.to = v.effective_from;
    out.push({ from: v.effective_from, to, items: v.items });
  }
  // Usage before a book's first version (the book did not exist yet) is priced by that first version.
  if (out.length && !atStart) out[0]!.from = from;
  return out.filter((x) => x.to > x.from);
}

export const monthToText = (m: number): string => `${String(m).slice(0, 4)}-${String(m).slice(4, 6)}`;
/** A prorated part of a month: "2026-09-01 00:00 to 2026-09-15 13:00 UTC" (the end is exclusive). */
export const partText = (from: number, to: number): string => {
  const at = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
  return `${at(from)} to ${at(to)} UTC`;
};
export const previousMonth = (ts = Date.now()): number => {
  const d = new Date(ts);
  return monthOf(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
};

export class BillingService {
  constructor(
    private readonly s: () => Services,
    private readonly provider: BillingProvider | null
  ) {}

  private get db() {
    return this.s().db;
  }

  get providerName(): string | null {
    return this.provider?.name ?? null;
  }

  // ---------- price books ----------

  /** Every book, or those a tenant may use: platform books and its own. */
  async books(tenantId?: string): Promise<PriceBookRow[]> {
    const q = this.db('price_books').orderBy('name', 'asc');
    if (tenantId) q.where((w) => w.whereNull('tenant_id').orWhere({ tenant_id: tenantId }));
    return ((await q) as Record<string, unknown>[]).map(bookFromRow);
  }

  async book(id: string): Promise<PriceBookRow> {
    const r = await this.db('price_books').where({ id }).first();
    if (!r) throw notFound('Price book');
    return bookFromRow(r);
  }

  async createBook(by: string, input: { name: string; currency: string; isDefault: boolean; items: PriceItem[]; tenantId?: string | null }): Promise<PriceBookRow> {
    const id = ulid();
    const t = Date.now();
    const owner = input.tenantId ?? null;
    try {
      await this.db.transaction(async (trx) => {
        // One default among the platform books, and one among each tenant's own.
        if (input.isDefault) await (owner ? trx('price_books').where({ tenant_id: owner }) : trx('price_books').whereNull('tenant_id')).update({ is_default: false });
        await trx('price_books').insert({ id, tenant_id: owner, name: input.name, currency: input.currency.toUpperCase(), is_default: input.isDefault, state: 'active', items: JSON.stringify(input.items), updated_by: by, created_at: t, updated_at: t });
        await trx('price_book_versions').insert({ id: ulid(), book_id: id, items: JSON.stringify(input.items), effective_from: 0, created_by: by, created_at: t });
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A price book named ${input.name} already exists.`);
      throw err;
    }
    return this.book(id);
  }

  /**
   * Changes a book. New items take effect at `effectiveFrom` (B-1505; now by default, or earlier in the current
   * month, never in a month whose statement may be final): usage before that moment keeps the old prices, so a
   * mid-month change prorates the month. A change replaces any version that took effect at or after its moment.
   */
  async updateBook(id: string, by: string, patch: { name?: string; currency?: string; isDefault?: boolean; items?: PriceItem[]; state?: 'active' | 'retired'; effectiveFrom?: number }): Promise<{ before: PriceBookRow; after: PriceBookRow; effectiveFrom: number | null }> {
    const before = await this.book(id);
    const now = Date.now();
    let effective: number | null = null;
    // Only new prices make a version: saving the same items again changes nothing in the price history.
    if (patch.items !== undefined && JSON.stringify(patch.items) !== JSON.stringify(before.items)) {
      effective = patch.effectiveFrom ?? now;
      const startOfMonth = monthBounds(monthOf(now)).from;
      if (effective < startOfMonth) throw conflict('A price change can take effect from the start of this month at the earliest; earlier statements may already be final.');
      if (effective > now + 60_000) throw conflict('A price change cannot take effect in the future; change the book when the new prices start.');
    } else if (patch.effectiveFrom !== undefined && patch.items === undefined) throw new HttpProblem(400, 'Invalid request', 'An effective time goes with new items.');
    if (patch.state === 'retired' && (patch.isDefault ?? before.is_default)) throw conflict('The default price book cannot be retired; make another one the default first.');
    const upd: Record<string, unknown> = { updated_by: by, updated_at: Date.now() };
    if (patch.name !== undefined) upd.name = patch.name;
    if (patch.currency !== undefined) upd.currency = patch.currency.toUpperCase();
    if (patch.isDefault !== undefined) upd.is_default = patch.isDefault;
    if (patch.items !== undefined) upd.items = JSON.stringify(patch.items);
    if (patch.state !== undefined) upd.state = patch.state;
    try {
      await this.db.transaction(async (trx) => {
        if (patch.isDefault) await (before.tenant_id ? trx('price_books').where({ tenant_id: before.tenant_id }) : trx('price_books').whereNull('tenant_id')).whereNot({ id }).update({ is_default: false });
        await trx('price_books').where({ id }).update(upd);
        if (effective != null) {
          await trx('price_book_versions').where({ book_id: id }).andWhere('effective_from', '>=', effective).andWhere('effective_from', '>', 0).delete();
          await trx('price_book_versions').insert({ id: ulid(), book_id: id, items: JSON.stringify(patch.items), effective_from: effective, created_by: by, created_at: now });
        }
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A price book named ${patch.name ?? ''} already exists.`);
      throw err;
    }
    return { before, after: await this.book(id), effectiveFrom: effective };
  }

  /** A book's versions, oldest first; a book from before versions existed has its current items from the start. */
  async versions(book: PriceBookRow): Promise<PriceBookVersion[]> {
    const rows = (await this.db('price_book_versions').where({ book_id: book.id }).orderBy('effective_from', 'asc').orderBy('created_at', 'asc')) as Record<string, unknown>[];
    if (!rows.length) return [{ id: book.id, book_id: book.id, items: book.items, effective_from: 0, created_at: book.created_at }];
    return rows.map((r) => ({ id: String(r.id), book_id: String(r.book_id), items: json<PriceItem[]>(r.items, []), effective_from: Number(r.effective_from), created_at: Number(r.created_at) }));
  }

  /**
   * The book a tenant is billed from, among the active books it may use (platform books and its own) in its billing
   * currency when it has one: its assigned book, else its own default, else the platform default, else none.
   */
  async bookFor(tenantId: string): Promise<PriceBookRow | null> {
    const { priceBookId, billingCurrency } = await this.s().integrations.get(tenantId);
    const books = (await this.books(tenantId)).filter((b) => b.state === 'active' && (!billingCurrency || b.currency === billingCurrency));
    return books.find((b) => b.id === priceBookId) ?? books.find((b) => b.is_default && b.tenant_id === tenantId) ?? books.find((b) => b.is_default && b.tenant_id == null) ?? null;
  }

  /** Whether a tenant may be assigned a book: a platform book or its own, in its billing currency when it has one. */
  async checkAssignable(tenantId: string, bookId: string, currency: string | null): Promise<void> {
    const b = await this.book(bookId);
    if (b.tenant_id && b.tenant_id !== tenantId) throw notFound('Price book');
    if (currency && b.currency !== currency.toUpperCase()) throw conflict(`${b.name} is in ${b.currency}; this tenant is billed in ${currency.toUpperCase()}. There is no currency conversion.`);
  }

  // ---------- statements ----------

  /** Prices a tenant's month from the usage meter. Nothing is stored. */
  async compute(tenantId: string, month: number): Promise<ComputedStatement> {
    const book = await this.bookFor(tenantId);
    const settings = await this.s().integrations.get(tenantId);
    // B-1505: one part of the month per price book version in effect during it (one part when prices held).
    const parts = book ? segmentsFor(await this.versions(book), month) : [];
    const prorated = parts.length > 1;
    const usage = (from: number | null, to: number | null) => {
      const q = this.db('usage_records').where({ tenant_id: tenantId, month });
      if (from != null) q.andWhere('ts', '>=', from);
      if (to != null) q.andWhere('ts', '<', to);
      return q.groupBy('kind', 'model', 'profile_id').select('kind', 'model', 'profile_id').sum({ p: 'prompt_tokens', o: 'output_tokens', t: 'thinking_tokens', c: 'calc_calls', g: 'gpu_ms' }).count({ n: '*' }) as Promise<Record<string, unknown>[]>;
    };
    const groups: (Record<string, unknown> & { part: { from: number; to: number; items: PriceItem[] } | null })[] = [];
    if (!prorated) for (const g of await usage(null, null)) groups.push({ ...g, part: parts[0] ?? null });
    else
      for (const [i, part] of parts.entries()) {
        // The first and last parts are open-ended so that every record of the month is counted exactly once.
        for (const g of await usage(i === 0 ? null : part.from, i === parts.length - 1 ? null : part.to)) groups.push({ ...g, part });
      }
    const profileIds = [...new Set(groups.map((g) => g.profile_id).filter((x): x is string => typeof x === 'string'))];
    const profileNames = new Map<string, string>();
    if (profileIds.length) for (const r of (await this.db('profiles').whereIn('id', profileIds).select('id', 'name')) as { id: string; name: string }[]) profileNames.set(r.id, r.name);

    const totals: UsageTotals = { promptTokens: 0, outputTokens: 0, thinkingTokens: 0, gpuSeconds: 0, requests: 0, calcCalls: 0 };
    const lines: StatementLine[] = [];
    let gpuMsTotal = 0;
    for (const g of groups) {
      const kind = String(g.kind);
      const model = (g.model as string | null) ?? null;
      const profile = g.profile_id ? (profileNames.get(String(g.profile_id)) ?? String(g.profile_id)) : null;
      const gpuMs = Number(g.g ?? 0);
      const q: Record<Meter, number> = { prompt_tokens: Number(g.p ?? 0), output_tokens: Number(g.o ?? 0), thinking_tokens: Number(g.t ?? 0), gpu_seconds: gpuMs / 1000, requests: Number(g.n ?? 0), calc_calls: Number(g.c ?? 0) };
      totals.promptTokens += q.prompt_tokens;
      totals.outputTokens += q.output_tokens;
      totals.thinkingTokens += q.thinking_tokens;
      totals.requests += q.requests;
      totals.calcCalls += q.calc_calls;
      gpuMsTotal += gpuMs;
      for (const meter of METERS) {
        const quantity = q[meter];
        if (!quantity) continue;
        const it = book && g.part ? priceFor(g.part.items, meter, kind, model, profile) : null;
        const amount = it ? Math.round((quantity * it.unitPriceMicros) / it.perUnits) : 0;
        lines.push({ kind, model, profile, meter, quantity: meter === 'gpu_seconds' ? Math.round(quantity * 1000) / 1000 : quantity, perUnits: it?.perUnits ?? null, unitPriceMicros: it?.unitPriceMicros ?? null, amountMicros: amount, priced: !!it, ...(prorated && g.part ? { from: g.part.from, to: g.part.to } : {}) });
      }
    }
    totals.gpuSeconds = Math.round(gpuMsTotal) / 1000;
    lines.sort((a, b) => (a.from ?? 0) - (b.from ?? 0) || b.amountMicros - a.amountMicros || a.kind.localeCompare(b.kind) || String(a.model).localeCompare(String(b.model)) || METERS.indexOf(a.meter) - METERS.indexOf(b.meter));
    const subtotal = lines.reduce((a, l) => a + l.amountMicros, 0);
    // Taxes on the priced subtotal, each rounded to the micro-unit; the total includes them.
    const taxes: StatementTax[] = settings.taxRates.map((r) => ({ name: r.name, ratePpm: r.ratePpm, amountMicros: Math.round((subtotal * r.ratePpm) / 1_000_000) }));
    const tax = taxes.reduce((a, x) => a + x.amountMicros, 0);
    return { tenant_id: tenantId, month, book_id: book?.id ?? null, book_name: book?.name ?? null, currency: settings.billingCurrency ?? book?.currency ?? 'USD', subtotal_micros: subtotal, tax_micros: tax, taxes, total_micros: subtotal + tax, lines, totals, computed_at: Date.now() };
  }

  async statement(tenantId: string, month: number): Promise<StatementRow | null> {
    const r = await this.db('billing_statements').where({ tenant_id: tenantId, month }).first();
    return r ? statementFromRow(r) : null;
  }

  async statements(tenantId: string, limit = 24): Promise<StatementRow[]> {
    return ((await this.db('billing_statements').where({ tenant_id: tenantId }).orderBy('month', 'desc').limit(limit)) as Record<string, unknown>[]).map(statementFromRow);
  }

  /** Stores (or refreshes) a month's statement. A pushed statement is final and is not recomputed. */
  async save(tenantId: string, month: number, opts: { close?: boolean } = {}): Promise<StatementRow> {
    const existing = await this.statement(tenantId, month);
    if (existing && INVOICED.includes(existing.state)) throw conflict(`The ${monthToText(month)} statement was sent to ${this.provider?.name ?? 'the billing provider'} and is final.`);
    const c = await this.compute(tenantId, month);
    const state = opts.close || month < monthOf(Date.now()) ? 'closed' : 'open';
    const row = { ...c, lines: JSON.stringify(c.lines), totals: JSON.stringify(c.totals), taxes: JSON.stringify(c.taxes), state };
    if (existing) await this.db('billing_statements').where({ id: existing.id }).update({ ...row, push_error: null });
    else {
      try {
        await this.db('billing_statements').insert({ id: ulid(), ...row });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        await this.db('billing_statements').where({ tenant_id: tenantId, month }).update(row);
      }
    }
    return (await this.statement(tenantId, month))!;
  }

  /** Sends a closed statement to the billing provider as one invoice with a line per priced item. */
  async push(tenantId: string, month: number): Promise<StatementRow> {
    if (!this.provider) throw new HttpProblem(409, 'Conflict', 'No billing provider is configured (BILLING_PROVIDER).');
    if (month >= monthOf(Date.now())) throw conflict('Only a finished month can be invoiced.');
    let st = await this.statement(tenantId, month);
    if (st && INVOICED.includes(st.state)) throw conflict(`The ${monthToText(month)} statement was already sent (${st.provider_ref ?? ''}).`);
    st = await this.save(tenantId, month, { close: true });
    const { billingCustomer } = await this.s().integrations.get(tenantId);
    if (!billingCustomer) throw conflict('This tenant has no billing customer; set one first.');
    try {
      const ref = await this.provider.invoice({ customer: billingCustomer, statementId: st.id, tenantId, month: monthToText(month), currency: st.currency, lines: [
          ...st.lines.filter((l) => l.priced && l.amountMicros > 0).map((l) => ({ description: `${l.from != null && l.to != null ? partText(l.from, l.to) : monthToText(month)} ${l.kind}${l.model ? ` ${l.model}` : ''}${l.profile ? ` (${l.profile})` : ''}: ${l.quantity} ${l.meter.replace(/_/g, ' ')}`, amountMinor: toMinor(l.amountMicros, st.currency) })),
          ...st.taxes.filter((x) => x.amountMicros > 0).map((x) => ({ description: `${monthToText(month)} ${x.name} ${(x.ratePpm / 10_000).toFixed(4).replace(/\.?0+$/, '')}%`, amountMinor: toMinor(x.amountMicros, st.currency) }))
        ] });
      await this.db('billing_statements').where({ id: st.id }).update({ state: 'pushed', provider_ref: ref, pushed_at: Date.now(), push_error: null });
    } catch (err) {
      await this.db('billing_statements').where({ id: st.id }).update({ state: 'push failed', push_error: String((err as Error).message).slice(0, 500) });
      throw new HttpProblem(502, 'Billing provider error', `The invoice could not be created: ${(err as Error).message}`);
    }
    return (await this.statement(tenantId, month))!;
  }

  /** The scheduled job: closes last month's statement for a tenant (once), leaving a pushed one alone. */
  async closePrevious(tenantId: string): Promise<unknown> {
    const month = previousMonth();
    const st = await this.statement(tenantId, month);
    if (st && st.state !== 'open') return { skipped: `statement is ${st.state}` };
    const row = await this.save(tenantId, month, { close: true });
    return { month: monthToText(month), totalMicros: row.total_micros };
  }

  /**
   * Applies a provider event to the statement it concerns, once per event id.
   *
   * - B-1005: a paid invoice marks the statement paid (and remembers the charge and payment intent that paid it), a
   *   failed payment marks it `payment failed`, a voided invoice marks it void. Events that arrive out of order never
   *   undo a payment or a void.
   * - B-1505: a refunded charge records the amount refunded so far (Stripe reports the running total) and marks the
   *   statement `refunded` or `partly refunded`; a credit note is recorded by id with its amount (a voided one no
   *   longer counts); a dispute marks the statement `disputed` with the amount, and closing it returns the statement
   *   to its paid state when won, or `dispute lost`.
   *
   * The statement is found by invoice id, then by charge or payment intent, then by the statement id in metadata.
   */
  async reconcile(provider: string, event: ProviderEvent): Promise<ReconcileOutcome> {
    const db = this.db;
    const seen = await db('billing_provider_events').where({ id: event.id }).first();
    if (seen) return { result: String(seen.result), duplicate: true, statement: null, transition: null, action: null, detail: {} };
    const type = event.type;
    const kind: 'paid' | 'failed' | 'voided' | 'refund' | 'credit' | 'dispute' | null =
      type === 'invoice.paid' || type === 'invoice.payment_succeeded' ? 'paid'
      : type === 'invoice.payment_failed' ? 'failed'
      : type === 'invoice.voided' ? 'voided'
      : type === 'charge.refunded' || type === 'charge.refund.updated' ? 'refund'
      : type === 'credit_note.created' || type === 'credit_note.updated' || type === 'credit_note.voided' ? 'credit'
      : type === 'charge.dispute.created' || type === 'charge.dispute.updated' || type === 'charge.dispute.closed' ? 'dispute'
      : null;
    let st: StatementRow | null = null;
    if (kind) {
      const r =
        (event.invoiceId ? await db('billing_statements').where({ provider_ref: event.invoiceId }).first() : undefined) ??
        (event.chargeId ? await db('billing_statements').where({ provider_charge: event.chargeId }).first() : undefined) ??
        (event.paymentId ? await db('billing_statements').where({ provider_payment: event.paymentId }).first() : undefined) ??
        (event.statementId ? await db('billing_statements').where({ id: event.statementId }).first() : undefined);
      st = r ? statementFromRow(r) : null;
    }
    let result: string;
    let transition: StatementState | null = null;
    let action: string | null = null;
    const detail: Record<string, unknown> = {};
    const upd: Record<string, unknown> = {};
    const money = (minor: number | null | undefined) => (minor == null || !st ? null : fromMinor(minor, st.currency));
    /** Where a statement returns to when a dispute ends in its favour: paid, less any refund. */
    const settled = (x: StatementRow, refunded: number): StatementState => (refunded <= 0 ? 'paid' : refunded >= x.total_micros ? 'refunded' : 'partly refunded');

    if (!kind) result = 'ignored: not an invoice, refund, credit note or dispute event';
    else if (!st) result = 'ignored: no statement has this invoice';
    else if (!INVOICED.includes(st.state)) result = `ignored: the statement is ${st.state}, not invoiced`;
    else if (kind === 'paid' || kind === 'failed' || kind === 'voided') {
      const to: StatementState = kind === 'paid' ? 'paid' : kind === 'failed' ? 'payment failed' : 'void';
      // Remember what paid the invoice, so refunds and disputes (which name the charge) find the statement.
      if (kind === 'paid') {
        if (event.chargeId && !st.provider_charge) upd.provider_charge = event.chargeId.slice(0, 100);
        if (event.paymentId && !st.provider_payment) upd.provider_payment = event.paymentId.slice(0, 100);
      }
      if (PAID_STATES.includes(st.state) || st.state === 'void') result = `unchanged: the statement is already ${st.state}`;
      else {
        transition = to;
        action = to === 'paid' ? 'billing.statement.paid' : to === 'void' ? 'billing.statement.voided' : 'billing.statement.payment-failed';
        Object.assign(upd, { state: to, provider_status: type.slice(0, 40), ...(to === 'paid' ? { paid_at: Date.now() } : {}) });
        Object.assign(detail, { amountPaidMinor: event.amountPaidMinor });
        result = `statement ${st.id} ${to}`;
      }
    } else if (kind === 'refund') {
      const refunded = money(event.amountMinor);
      if (refunded == null) result = 'ignored: the event carries no refunded amount';
      else if (st.state === 'void') result = 'unchanged: the statement is void';
      else if (refunded <= st.refunded_micros) result = `unchanged: ${st.refunded_micros} already recorded as refunded`;
      else {
        const full = event.totalMinor != null ? event.amountMinor! >= event.totalMinor : refunded >= st.total_micros;
        const to: StatementState = st.state === 'disputed' || st.state === 'dispute lost' ? st.state : full ? 'refunded' : 'partly refunded';
        transition = to !== st.state ? to : null;
        action = 'billing.statement.refunded';
        Object.assign(upd, { refunded_micros: refunded, state: to, provider_status: type.slice(0, 40), ...(event.chargeId && !st.provider_charge ? { provider_charge: event.chargeId.slice(0, 100) } : {}) });
        Object.assign(detail, { refundedMicros: refunded, refundedMinor: event.amountMinor, full, charge: event.chargeId ?? null });
        result = `statement ${st.id} ${to} (${refunded} refunded)`;
      }
    } else if (kind === 'credit') {
      const id = (event.objectId ?? '').slice(0, 100);
      const amount = money(event.amountMinor);
      if (!id) result = 'ignored: the credit note has no id';
      else {
        const voided = type === 'credit_note.voided' || event.status === 'void';
        const credits = st.credits.filter((c) => c.id !== id);
        const prev = st.credits.find((c) => c.id === id);
        credits.push({ id, amountMicros: amount ?? prev?.amountMicros ?? 0, state: voided ? 'void' : 'issued' });
        const credited = credits.filter((c) => c.state === 'issued').reduce((a, c) => a + c.amountMicros, 0);
        action = voided ? 'billing.statement.credit-voided' : 'billing.statement.credited';
        Object.assign(upd, { credits: JSON.stringify(credits), credited_micros: credited, provider_status: type.slice(0, 40) });
        Object.assign(detail, { creditNote: id, amountMicros: amount, creditedMicros: credited, voided });
        result = `statement ${st.id} ${voided ? 'credit note voided' : 'credited'} (${credited} credited)`;
      }
    } else {
      const status = (event.status ?? '').slice(0, 40) || null;
      const disputed = money(event.amountMinor);
      if (st.state === 'void') result = 'unchanged: the statement is void';
      else if (type === 'charge.dispute.closed') {
        const to: StatementState = status === 'lost' ? 'dispute lost' : settled(st, st.refunded_micros);
        transition = to !== st.state ? to : null;
        action = 'billing.statement.dispute-closed';
        Object.assign(upd, { state: to, dispute_status: status, provider_status: type.slice(0, 40) });
        Object.assign(detail, { dispute: event.objectId ?? null, status, disputedMicros: st.disputed_micros });
        result = `statement ${st.id} dispute ${status ?? 'closed'}: ${to}`;
      } else if (st.state === 'dispute lost') result = 'unchanged: the dispute was lost';
      else {
        const to: StatementState = 'disputed';
        transition = to !== st.state ? to : null;
        action = type === 'charge.dispute.created' ? 'billing.statement.disputed' : 'billing.statement.dispute-updated';
        Object.assign(upd, { state: to, dispute_status: status, provider_status: type.slice(0, 40), ...(disputed != null ? { disputed_micros: disputed } : {}) });
        Object.assign(detail, { dispute: event.objectId ?? null, status, disputedMicros: disputed });
        result = `statement ${st.id} disputed (${status ?? 'open'})`;
      }
    }
    try {
      await db.transaction(async (trx) => {
        await trx('billing_provider_events').insert({ id: event.id.slice(0, 100), provider, type: type.slice(0, 100), tenant_id: st?.tenant_id ?? null, statement_id: st?.id ?? null, result: result.slice(0, 200), received_at: Date.now() });
        if (st && Object.keys(upd).length) await trx('billing_statements').where({ id: st.id }).update(upd);
      });
    } catch (err) {
      // The same event delivered twice at once: the other delivery applied it.
      if (isUniqueViolation(err)) return { result, duplicate: true, statement: null, transition: null, action: null, detail: {} };
      throw err;
    }
    return { result, duplicate: false, statement: st ? await this.statement(st.tenant_id, st.month) : null, transition, action, detail };
  }

  toCsv(st: Pick<StatementRow, 'month' | 'currency' | 'lines' | 'total_micros'> & Partial<Pick<StatementRow, 'taxes' | 'subtotal_micros'>>): string {
    const money = (m: number) => (m / 1e6).toFixed(6);
    let out = csvLine(['month', 'kind', 'model', 'profile', 'meter', 'quantity', 'per_units', 'unit_price', 'amount', 'currency', 'priced']);
    for (const l of st.lines) out += csvLine([monthToText(st.month), l.kind, l.model, l.profile, l.meter, l.quantity, l.perUnits, l.unitPriceMicros == null ? '' : money(l.unitPriceMicros), money(l.amountMicros), st.currency, l.priced ? 'yes' : 'no']);
    if (st.taxes?.length) {
      out += csvLine([monthToText(st.month), 'subtotal', '', '', '', '', '', '', money(st.subtotal_micros ?? st.total_micros), st.currency, '']);
      for (const x of st.taxes) out += csvLine([monthToText(st.month), 'tax', x.name, '', '', '', '', `${x.ratePpm / 10_000}%`, money(x.amountMicros), st.currency, '']);
    }
    out += csvLine([monthToText(st.month), 'total', '', '', '', '', '', '', money(st.total_micros), st.currency, '']);
    return out;
  }
}

export const bookView = (b: PriceBookRow) => ({ id: b.id, tenantId: b.tenant_id ?? null, name: b.name, currency: b.currency, isDefault: b.is_default, state: b.state, items: b.items, updatedAt: b.updated_at });

export const statementView = (st: ComputedStatement & Partial<Pick<StatementRow, ProviderFields>>) => ({
  id: st.id ?? null,
  month: monthToText(st.month),
  state: st.state ?? 'preview',
  book: st.book_id ? { id: st.book_id, name: st.book_name } : null,
  currency: st.currency,
  subtotalMicros: st.subtotal_micros,
  taxMicros: st.tax_micros,
  taxes: st.taxes,
  totalMicros: st.total_micros,
  total: (st.total_micros / 1e6).toFixed(2),
  totals: st.totals,
  lines: st.lines,
  providerRef: st.provider_ref ?? null,
  pushError: st.push_error ?? null,
  computedAt: st.computed_at,
  pushedAt: st.pushed_at ?? null,
  paidAt: st.paid_at ?? null,
  providerStatus: st.provider_status ?? null,
  prorated: st.lines.some((l) => l.from != null),
  refundedMicros: st.refunded_micros ?? 0,
  creditedMicros: st.credited_micros ?? 0,
  credits: st.credits ?? [],
  disputedMicros: st.disputed_micros ?? 0,
  disputeStatus: st.dispute_status ?? null
});
