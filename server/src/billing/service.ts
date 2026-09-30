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
export const USAGE_KINDS = ['chat', 'compare', 'api', 'load', 'embed', 'training', 'agent', 'workflow', 'image', 'media'] as const;

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
  state: 'open' | 'closed' | 'pushed' | 'push failed';
  provider_ref: string | null;
  push_error: string | null;
  computed_at: number;
  pushed_at: number | null;
}

const bookFromRow = (r: Record<string, unknown>): PriceBookRow => ({ ...(r as unknown as PriceBookRow), is_default: !!r.is_default, items: json<PriceItem[]>(r.items, []), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
const statementFromRow = (r: Record<string, unknown>): StatementRow => ({ ...(r as unknown as StatementRow), month: Number(r.month), total_micros: Number(r.total_micros), lines: json<StatementLine[]>(r.lines, []), totals: json<UsageTotals>(r.totals, { promptTokens: 0, outputTokens: 0, thinkingTokens: 0, gpuSeconds: 0, requests: 0, calcCalls: 0 }), computed_at: Number(r.computed_at), pushed_at: r.pushed_at == null ? null : Number(r.pushed_at) });

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

export const monthToText = (m: number): string => `${String(m).slice(0, 4)}-${String(m).slice(4, 6)}`;
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

  async books(): Promise<PriceBookRow[]> {
    return ((await this.db('price_books').orderBy('name', 'asc')) as Record<string, unknown>[]).map(bookFromRow);
  }

  async book(id: string): Promise<PriceBookRow> {
    const r = await this.db('price_books').where({ id }).first();
    if (!r) throw notFound('Price book');
    return bookFromRow(r);
  }

  async createBook(by: string, input: { name: string; currency: string; isDefault: boolean; items: PriceItem[] }): Promise<PriceBookRow> {
    const id = ulid();
    const t = Date.now();
    try {
      await this.db.transaction(async (trx) => {
        if (input.isDefault) await trx('price_books').update({ is_default: false });
        await trx('price_books').insert({ id, name: input.name, currency: input.currency.toUpperCase(), is_default: input.isDefault, state: 'active', items: JSON.stringify(input.items), updated_by: by, created_at: t, updated_at: t });
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A price book named ${input.name} already exists.`);
      throw err;
    }
    return this.book(id);
  }

  async updateBook(id: string, by: string, patch: { name?: string; currency?: string; isDefault?: boolean; items?: PriceItem[]; state?: 'active' | 'retired' }): Promise<{ before: PriceBookRow; after: PriceBookRow }> {
    const before = await this.book(id);
    if (patch.state === 'retired' && (patch.isDefault ?? before.is_default)) throw conflict('The default price book cannot be retired; make another one the default first.');
    const upd: Record<string, unknown> = { updated_by: by, updated_at: Date.now() };
    if (patch.name !== undefined) upd.name = patch.name;
    if (patch.currency !== undefined) upd.currency = patch.currency.toUpperCase();
    if (patch.isDefault !== undefined) upd.is_default = patch.isDefault;
    if (patch.items !== undefined) upd.items = JSON.stringify(patch.items);
    if (patch.state !== undefined) upd.state = patch.state;
    try {
      await this.db.transaction(async (trx) => {
        if (patch.isDefault) await trx('price_books').whereNot({ id }).update({ is_default: false });
        await trx('price_books').where({ id }).update(upd);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A price book named ${patch.name ?? ''} already exists.`);
      throw err;
    }
    return { before, after: await this.book(id) };
  }

  /** The book a tenant is billed from: its assigned one while active, else the default, else none. */
  async bookFor(tenantId: string): Promise<PriceBookRow | null> {
    const { priceBookId } = await this.s().integrations.get(tenantId);
    const books = await this.books();
    return books.find((b) => b.id === priceBookId && b.state === 'active') ?? books.find((b) => b.is_default && b.state === 'active') ?? null;
  }

  // ---------- statements ----------

  /** Prices a tenant's month from the usage meter. Nothing is stored. */
  async compute(tenantId: string, month: number): Promise<Omit<StatementRow, 'id' | 'state' | 'provider_ref' | 'push_error' | 'pushed_at'>> {
    const book = await this.bookFor(tenantId);
    const groups = (await this.db('usage_records')
      .where({ tenant_id: tenantId, month })
      .groupBy('kind', 'model', 'profile_id')
      .select('kind', 'model', 'profile_id')
      .sum({ p: 'prompt_tokens', o: 'output_tokens', t: 'thinking_tokens', c: 'calc_calls', g: 'gpu_ms' })
      .count({ n: '*' })) as Record<string, unknown>[];
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
        const it = book ? priceFor(book.items, meter, kind, model, profile) : null;
        const amount = it ? Math.round((quantity * it.unitPriceMicros) / it.perUnits) : 0;
        lines.push({ kind, model, profile, meter, quantity: meter === 'gpu_seconds' ? Math.round(quantity * 1000) / 1000 : quantity, perUnits: it?.perUnits ?? null, unitPriceMicros: it?.unitPriceMicros ?? null, amountMicros: amount, priced: !!it });
      }
    }
    totals.gpuSeconds = Math.round(gpuMsTotal) / 1000;
    lines.sort((a, b) => b.amountMicros - a.amountMicros || a.kind.localeCompare(b.kind) || String(a.model).localeCompare(String(b.model)) || METERS.indexOf(a.meter) - METERS.indexOf(b.meter));
    return { tenant_id: tenantId, month, book_id: book?.id ?? null, book_name: book?.name ?? null, currency: book?.currency ?? 'USD', total_micros: lines.reduce((a, l) => a + l.amountMicros, 0), lines, totals, computed_at: Date.now() };
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
    if (existing?.state === 'pushed') throw conflict(`The ${monthToText(month)} statement was sent to ${this.provider?.name ?? 'the billing provider'} and is final.`);
    const c = await this.compute(tenantId, month);
    const state = opts.close || month < monthOf(Date.now()) ? 'closed' : 'open';
    const row = { ...c, lines: JSON.stringify(c.lines), totals: JSON.stringify(c.totals), state };
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
    if (st?.state === 'pushed') throw conflict(`The ${monthToText(month)} statement was already sent (${st.provider_ref ?? ''}).`);
    st = await this.save(tenantId, month, { close: true });
    const { billingCustomer } = await this.s().integrations.get(tenantId);
    if (!billingCustomer) throw conflict('This tenant has no billing customer; set one first.');
    try {
      const ref = await this.provider.invoice({ customer: billingCustomer, statementId: st.id, tenantId, month: monthToText(month), currency: st.currency, lines: st.lines.filter((l) => l.priced && l.amountMicros > 0).map((l) => ({ description: `${monthToText(month)} ${l.kind}${l.model ? ` ${l.model}` : ''}${l.profile ? ` (${l.profile})` : ''}: ${l.quantity} ${l.meter.replace(/_/g, ' ')}`, amountMinor: toMinor(l.amountMicros, st.currency) })) });
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

  toCsv(st: Pick<StatementRow, 'month' | 'currency' | 'lines' | 'total_micros'>): string {
    const money = (m: number) => (m / 1e6).toFixed(6);
    let out = csvLine(['month', 'kind', 'model', 'profile', 'meter', 'quantity', 'per_units', 'unit_price', 'amount', 'currency', 'priced']);
    for (const l of st.lines) out += csvLine([monthToText(st.month), l.kind, l.model, l.profile, l.meter, l.quantity, l.perUnits, l.unitPriceMicros == null ? '' : money(l.unitPriceMicros), money(l.amountMicros), st.currency, l.priced ? 'yes' : 'no']);
    out += csvLine([monthToText(st.month), 'total', '', '', '', '', '', '', money(st.total_micros), st.currency, '']);
    return out;
  }
}

export const bookView = (b: PriceBookRow) => ({ id: b.id, name: b.name, currency: b.currency, isDefault: b.is_default, state: b.state, items: b.items, updatedAt: b.updated_at });

export const statementView = (st: Omit<StatementRow, 'id' | 'state' | 'provider_ref' | 'push_error' | 'pushed_at'> & Partial<Pick<StatementRow, 'id' | 'state' | 'provider_ref' | 'push_error' | 'pushed_at'>>) => ({
  id: st.id ?? null,
  month: monthToText(st.month),
  state: st.state ?? 'preview',
  book: st.book_id ? { id: st.book_id, name: st.book_name } : null,
  currency: st.currency,
  totalMicros: st.total_micros,
  total: (st.total_micros / 1e6).toFixed(2),
  totals: st.totals,
  lines: st.lines,
  providerRef: st.provider_ref ?? null,
  pushError: st.push_error ?? null,
  computedAt: st.computed_at,
  pushedAt: st.pushed_at ?? null
});
