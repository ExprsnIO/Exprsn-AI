import { json } from '../db/knex.js';
import type { Services } from '../services.js';
import type { PlanEstimate } from './graph.js';
import { EstimatedSpend, monthOf, type SpendFigure, type SpendOptions, type SpendSource } from './spend.js';

/*
 * 1.9.99-final, Sprint 59 (B-10603): budgets on actuals.
 *
 * - `BillingSpend`: a `SpendSource` over the ingested daily rows (`cloud_costs`, `cloud/costs.ts`).
 *     actual month to date = Σ rows of the account in the budget's currency, days of this month up to today (UTC)
 *     forecast             = actual + the current run rate × (month end − billed through) / month length
 *   where the run rate is the sum of the latest applied plan's `estimate.monthly` of each of the account's
 *   deployments (a destroy's is 0), and "billed through" is the end of the last day with rows this month (the month
 *   start when there are none, `now` at most). So the days not billed yet, today included, are forecast at the plans'
 *   rate; rows in another currency are listed in `excluded`, never converted (open decision 17).
 * - `AccountSpend`: what `s.cloud.budgets.spend` is. Per account, billing data when the account has a successful
 *   billing fetch in the last three days (`CloudCosts.billingState`), else `EstimatedSpend` (Sprint 58); the figure
 *   says which (`source`) and why (`basis`). Without migration 155 every account stays on estimates.
 * - `budgetBurn`: every budget against its spend (for the metrics: the budget burn gauge).
 */

const DAY = 86_400_000;
const round = (n: number) => Math.round(n * 100) / 100;
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The cost of a monthly rate over [from, to), month by month (each UTC month's own length). */
function prorate(monthly: number, from: number, to: number): number {
  let amount = 0;
  for (let t = from; t < to; ) {
    const m = monthOf(t);
    const end = Math.min(to, m.end);
    amount += (monthly * (end - t)) / (m.end - m.start);
    t = end;
  }
  return amount;
}

/**
 * Per deployment, the applied plans' estimates prorated over [from, to) (in `currency`; others listed as excluded,
 * never converted), and the run rate after the last plan applied by `to`.
 */
export async function estimatedBetween(s: () => Services, deploymentIds: string[], from: number, to: number, currency: string): Promise<Map<string, { amount: number; runRate: number; excluded: string[] }>> {
  const out = new Map<string, { amount: number; runRate: number; excluded: string[] }>();
  if (!deploymentIds.length) return out;
  const db = s().db;
  let rows: Record<string, unknown>[];
  try {
    if (!(await db.schema.hasTable('cloud_plans'))) return out;
    rows = (await db('cloud_plans').whereIn('deployment_id', deploymentIds).where({ state: 'applied' }).whereNotNull('applied_at').where('applied_at', '<=', to).orderBy('applied_at', 'asc').select('deployment_id', 'applied_at', 'estimate', 'purpose')) as Record<string, unknown>[];
  } catch {
    return out;
  }
  const byDep = new Map<string, { at: number; monthly: number | null; currency: string | null }[]>();
  for (const r of rows) {
    const e = json<PlanEstimate | null>(r.estimate, null);
    const monthly = r.purpose === 'destroy' ? 0 : e && Number.isFinite(Number(e.monthly)) ? Number(e.monthly) : null;
    const list = byDep.get(String(r.deployment_id)) ?? [];
    list.push({ at: Number(r.applied_at), monthly, currency: e?.currency ?? (r.purpose === 'destroy' ? null : 'USD') });
    byDep.set(String(r.deployment_id), list);
  }
  for (const [id, list] of byDep) {
    const line = { amount: 0, runRate: 0, excluded: [] as string[] };
    for (let i = 0; i < list.length; i++) {
      const a = list[i]!;
      const last = i === list.length - 1;
      const start = Math.max(a.at, from);
      const end = Math.min(last ? to : list[i + 1]!.at, to);
      if (a.monthly == null) {
        if (end > start || last) line.excluded.push('An applied plan has no estimate.');
        continue;
      }
      if (a.monthly > 0 && a.currency && a.currency !== currency) {
        line.excluded.push(`Estimated in ${a.currency}, not ${currency}; not converted.`);
        continue;
      }
      if (end > start) line.amount += prorate(a.monthly, start, end);
      if (last) line.runRate = a.monthly;
    }
    line.excluded = [...new Set(line.excluded)];
    out.set(id, line);
  }
  return out;
}

/** The source over the ingested daily rows (B-10603). */
export class BillingSpend implements SpendSource {
  constructor(private readonly s: () => Services) {}

  private async reckon(accountId: string, currency: string, now: number, forecast: boolean): Promise<SpendFigure> {
    const m = monthOf(now);
    const db = this.s().db;
    const rows = (await db('cloud_costs').where({ account_id: accountId }).where('day', '>=', dayOf(m.start)).where('day', '<=', dayOf(now)).select('deployment_id', 'day', 'amount', 'currency')) as { deployment_id: string | null; day: string; amount: string; currency: string }[];
    let amount = 0;
    let lastDay: string | null = null;
    const deployments = new Set<string>();
    const excluded: SpendFigure['excluded'] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      if (!lastDay || r.day > lastDay) lastDay = r.day;
      if (r.currency !== currency) {
        const k = `${r.deployment_id ?? ''}|${r.currency}`;
        if (!seen.has(k)) excluded.push({ deploymentId: r.deployment_id ?? '', reason: `Billed in ${r.currency}, not ${currency}; not converted.` });
        seen.add(k);
        continue;
      }
      amount += Number(r.amount);
      if (r.deployment_id) deployments.add(r.deployment_id);
    }
    const billedThrough = lastDay ? Math.min(now, Date.parse(`${lastDay}T00:00:00Z`) + DAY) : m.start;
    let runRate: number | undefined;
    if (forecast && now < m.end) {
      const deps = ((await db('cloud_deployments').where({ account_id: accountId }).select('id').catch(() => [])) as { id: string }[]).map((d) => d.id);
      const est = await estimatedBetween(this.s, deps, m.start, now, currency);
      runRate = [...est.values()].reduce((n, e) => n + e.runRate, 0);
      amount += (runRate * (m.end - billedThrough)) / (m.end - m.start);
    }
    return { amount: round(amount), currency, source: 'billing', deployments: deployments.size, excluded, month: m.key, at: now, billedThrough: lastDay, ...(runRate != null ? { runRate: round(runRate) } : {}) };
  }

  actualMonthToDate(accountId: string, opts: SpendOptions = {}): Promise<SpendFigure> {
    return this.reckon(accountId, opts.currency ?? 'USD', opts.now ?? Date.now(), false);
  }

  forecast(accountId: string, opts: SpendOptions = {}): Promise<SpendFigure> {
    return this.reckon(accountId, opts.currency ?? 'USD', opts.now ?? Date.now(), true);
  }
}

/** `s.cloud.budgets.spend`: billing data per account when there is fresh data, the estimates otherwise. */
export class AccountSpend implements SpendSource {
  readonly billing: BillingSpend;
  readonly estimate: EstimatedSpend;

  constructor(private readonly s: () => Services) {
    this.billing = new BillingSpend(s);
    this.estimate = new EstimatedSpend(s);
  }

  /** Which source an account's budget reads now, and why. */
  async pick(accountId: string, now = Date.now()): Promise<{ source: SpendSource; basis: string; lastFetchedAt: number | null }> {
    const costs = this.s().cloud.costs;
    const st = costs ? await costs.billingState(accountId, now).catch(() => null) : null;
    if (st?.billing) return { source: this.billing, basis: st.reason, lastFetchedAt: st.lastFetchedAt };
    return { source: this.estimate, basis: st?.reason ?? 'Billing ingestion is not available in this build.', lastFetchedAt: st?.lastFetchedAt ?? null };
  }

  async actualMonthToDate(accountId: string, opts: SpendOptions = {}): Promise<SpendFigure> {
    const p = await this.pick(accountId, opts.now);
    return { ...(await p.source.actualMonthToDate(accountId, opts)), basis: p.basis, lastFetchedAt: p.lastFetchedAt };
  }

  async forecast(accountId: string, opts: SpendOptions = {}): Promise<SpendFigure> {
    const p = await this.pick(accountId, opts.now);
    return { ...(await p.source.forecast(accountId, opts)), basis: p.basis, lastFetchedAt: p.lastFetchedAt };
  }
}

/** What the budget view says about where a figure comes from. */
export function spendSourceText(f: Pick<SpendFigure, 'source' | 'basis' | 'billedThrough'>): string {
  if (f.source === 'billing') return `Billing data from the provider${f.billedThrough ? `, billed through ${f.billedThrough}` : ', nothing billed this month yet'}; the forecast adds the applied plans' run rate for the days not billed yet.`;
  return `Estimated from the applied plans of the account's deployments, prorated over the month. ${f.basis ?? 'No billing data for this account.'}`.trim();
}

export interface BudgetBurn {
  accountId: string;
  name: string;
  provider: string;
  currency: string;
  budget: number;
  actual: number;
  forecast: number;
  pctActual: number;
  pctForecast: number;
  /** `billing` or `estimate`: where the spend came from. */
  source: SpendFigure['source'];
  stopped: boolean;
}

/**
 * Every budget against its spend this month (UTC), for the budget burn metric (B-10702): one entry per account with a
 * budget, through `s.cloud.budgets.statusOf` (so the same source, alerts and hard stop the budgets use). Empty without
 * migration 152 or when no budget is set.
 */
export async function budgetBurn(s: Services, now = Date.now()): Promise<BudgetBurn[]> {
  const b = s.cloud.budgets;
  if (!(await b.installed())) return [];
  const rows = (await s.db('cloud_budgets').select('account_id')) as { account_id: string }[];
  const out: BudgetBurn[] = [];
  for (const r of rows) {
    const budget = await b.get(r.account_id);
    const account = await s.cloud.accounts.get(r.account_id).catch(() => null);
    if (!budget || !account) continue;
    const st = await b.statusOf(budget, now);
    out.push({ accountId: account.id, name: account.name, provider: account.provider, currency: budget.currency, budget: budget.amount, actual: st.actual.amount, forecast: st.forecast.amount, pctActual: st.pctActual, pctForecast: st.pctForecast, source: st.actual.source, stopped: st.stopped });
  }
  return out;
}
