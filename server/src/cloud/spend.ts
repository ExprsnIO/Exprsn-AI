import { json } from '../db/knex.js';
import type { Services } from '../services.js';
import type { PlanEstimate } from './graph.js';

/*
 * 1.9.99-final, Sprint 58 (B-10602): where a budget's spend comes from.
 *
 * `SpendSource` is the seam the budgets read: what an account has spent this month so far, and what it will have spent
 * by the end of the month. This sprint has no billing data yet (billing ingestion is B-10603, Sprint 59), so the one
 * implementation here, `EstimatedSpend`, reckons both from the estimates of the plans applied on the account's
 * deployments: each applied plan's `estimate.monthly` is the deployment's run rate from the moment it was applied until
 * the next applied plan (a destroy's monthly is 0), prorated over the month in UTC.
 *
 *   actual month to date = Σ deployments Σ intervals in [month start, now]: monthly × interval / month length
 *   forecast             = actual month to date + current run rate × (month end − now) / month length
 *
 * Only estimates in the budget's currency count (open decision 17: nothing is converted); others are listed in
 * `excluded`. Since Sprint 59 (B-10603) `s.cloud.budgets.spend` is `AccountSpend` (`cloud/billing-spend.ts`): the
 * ingested daily rows (`BillingSpend`) for an account with fresh billing data, this source for the others; the
 * budgets, alerts and the hard stop do not change.
 */

export interface SpendFigure {
  /** Spend in the currency asked for. */
  amount: number;
  currency: string;
  /** `estimate` (applied plans' estimates, prorated) or `billing` (B-10603: the ingested daily rows). */
  source: 'estimate' | 'billing';
  /** Deployments counted, and estimates left out because they are in another currency or have none. */
  deployments: number;
  excluded: { deploymentId: string; reason: string }[];
  /** The month (`YYYY-MM`, UTC) and when the figure was reckoned. */
  month: string;
  at: number;
  /** Sprint 59 (B-10603, `cloud/billing-spend.ts`): why this source was used for the account. */
  basis?: string;
  /** Billing: the last day with ingested rows this month (`YYYY-MM-DD`), or null when none yet. */
  billedThrough?: string | null;
  /** Billing forecast: the applied plans' current run rate per month used for the days not billed yet. */
  runRate?: number;
  /** When the account's billing data was last fetched, if ever. */
  lastFetchedAt?: number | null;
}

export interface SpendOptions {
  /** The currency to count in (default USD, open decision 17); spend in another currency is left out, never converted. */
  currency?: string;
  /** The moment to reckon at (default now). */
  now?: number;
}

export interface SpendSource {
  /** What the account has spent this month (UTC) up to now. */
  actualMonthToDate(accountId: string, opts?: SpendOptions): Promise<SpendFigure>;
  /** What the account will have spent by the end of this month at its current run rate. */
  forecast(accountId: string, opts?: SpendOptions): Promise<SpendFigure>;
}

/** The UTC month of a time: its start, its end and its `YYYY-MM` key. */
export function monthOf(t: number): { key: string; start: number; end: number } {
  const d = new Date(t);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { key: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`, start, end };
}

const round = (n: number) => Math.round(n * 100) / 100;

interface Applied {
  at: number;
  monthly: number | null;
  currency: string | null;
}

/** The estimate-based source (Sprint 58); since Sprint 59 the fallback of `AccountSpend` for accounts without billing data. */
export class EstimatedSpend implements SpendSource {
  constructor(private readonly s: () => Services) {}

  private async installed(): Promise<boolean> {
    try {
      return (await this.s().db.schema.hasTable('cloud_plans')) && (await this.s().db.schema.hasTable('cloud_deployments'));
    } catch {
      return false;
    }
  }

  /** Per deployment of the account: its applied plans in order (time, monthly after the plan, currency). */
  private async history(accountId: string, until: number): Promise<Map<string, Applied[]>> {
    const out = new Map<string, Applied[]>();
    if (!(await this.installed())) return out;
    const db = this.s().db;
    const deps = (await db('cloud_deployments').where({ account_id: accountId }).select('id')) as { id: string }[];
    if (!deps.length) return out;
    const rows = (await db('cloud_plans')
      .whereIn('deployment_id', deps.map((d) => d.id))
      .where({ state: 'applied' })
      .whereNotNull('applied_at')
      .where('applied_at', '<=', until)
      .orderBy('applied_at', 'asc')
      .select('deployment_id', 'applied_at', 'estimate', 'purpose')) as Record<string, unknown>[];
    for (const r of rows) {
      const e = json<PlanEstimate | null>(r.estimate, null);
      const monthly = r.purpose === 'destroy' ? 0 : e && Number.isFinite(Number(e.monthly)) ? Number(e.monthly) : null;
      const list = out.get(String(r.deployment_id)) ?? [];
      list.push({ at: Number(r.applied_at), monthly, currency: e?.currency ?? (r.purpose === 'destroy' ? null : 'USD') });
      out.set(String(r.deployment_id), list);
    }
    return out;
  }

  private async reckon(accountId: string, currency: string, now: number, forecast: boolean): Promise<SpendFigure> {
    const m = monthOf(now);
    const len = m.end - m.start;
    const excluded: SpendFigure['excluded'] = [];
    let amount = 0;
    const hist = await this.history(accountId, now);
    for (const [deploymentId, list] of hist) {
      for (let i = 0; i < list.length; i++) {
        const a = list[i]!;
        const from = Math.max(a.at, m.start);
        const to = Math.min(i + 1 < list.length ? list[i + 1]!.at : now, now);
        const last = i === list.length - 1;
        if (a.monthly == null) {
          if (to > from || last) excluded.push({ deploymentId, reason: 'An applied plan has no estimate.' });
          continue;
        }
        if (a.monthly > 0 && a.currency && a.currency !== currency) {
          excluded.push({ deploymentId, reason: `Estimated in ${a.currency}, not ${currency}; not converted.` });
          continue;
        }
        if (to > from) amount += (a.monthly * (to - from)) / len;
        if (forecast && last && now < m.end) amount += (a.monthly * (m.end - Math.max(now, a.at))) / len;
      }
    }
    return { amount: round(amount), currency, source: 'estimate', deployments: hist.size, excluded: dedupe(excluded), month: m.key, at: now };
  }

  actualMonthToDate(accountId: string, opts: SpendOptions = {}): Promise<SpendFigure> {
    return this.reckon(accountId, opts.currency ?? 'USD', opts.now ?? Date.now(), false);
  }

  forecast(accountId: string, opts: SpendOptions = {}): Promise<SpendFigure> {
    return this.reckon(accountId, opts.currency ?? 'USD', opts.now ?? Date.now(), true);
  }
}

function dedupe(list: SpendFigure['excluded']): SpendFigure['excluded'] {
  const seen = new Set<string>();
  return list.filter((x) => {
    const k = `${x.deploymentId}|${x.reason}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
