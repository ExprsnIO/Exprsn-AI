import { ulid } from 'ulid';
import { z } from 'zod';
import { permissionsFor } from '../authz/permissions.js';
import type { Principal } from '../authz/policy.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import type { CloudActor } from './accounts.js';
import { cloudAudit } from './audit.js';
import type { Deployment, Plan, PlanStep } from './graph.js';
import { currencyFor } from './prices.js';
import { AccountSpend, spendSourceText } from './billing-spend.js';
import { monthOf, type SpendFigure, type SpendSource } from './spend.js';
import type { CloudAccount } from './types.js';
import { cloudPlaneMetrics } from './cloud-metrics.js';

/*
 * 1.9.99-final, Sprint 58 (B-10602): budgets per cloud account, `s.cloud.budgets`.
 *
 * - A monthly budget per account (`PUT /api/admin/cloud/accounts/:id/budget`, finops:manage; a platform account also
 *   platform:manage), in the account's billing currency (open decision 17: USD unless the account names another,
 *   never converted).
 * - Alerts at 50, 80 and 100 % of actual (month-to-date) and of forecast spend, each once per account and month
 *   (`cloud_budget_alerts`), as a notice (kind `cloud.budget`) to the account tenant's FinOps readers and cloud admins
 *   and as the audit event `cloud.budget.alert`, which every webhook subscribed to `cloud.*` (or `*`) receives. The
 *   job `cloud.budgets.check` runs every CLOUD_BUDGET_CHECK_MINUTES and after every successful apply.
 * - The hard stop: at or past 100 % (of actual spend by default; `hardStop: forecast` stops on the forecast, `off`
 *   alerts only), a plan that adds monthly cost is refused with `budget_exceeded` (a blocker on the plan, and apply
 *   refuses it again with 409). Scale-down and destroy are always allowed; a zero or negative delta is allowed; scaling
 *   a GPU node group above its minimum counts as adding cost whatever the estimate says (open decision 10).
 * - An override lifts the hard stop for at most 7 days: proposed with a reason, approved by a second admin
 *   (finops:manage or cloud:admin, a recent sign-in; a platform account also platform:manage), never by the proposer.
 *   It runs from approval for its hours and then expires by itself; it can be revoked at once.
 * - Spend comes from `spend` (`SpendSource`): this sprint the applied plans' estimates, prorated (`cloud/spend.ts`);
 *   since Sprint 59 the ingested billing rows for an account with fresh billing data (B-10603, `AccountSpend` in
 *   `cloud/billing-spend.ts`), the estimates for the others; `status.source` says which.
 *
 * Nothing changes until someone sets a budget: with no budget (or without migration 152) no alert is sent and no plan
 * is refused.
 */

export const BUDGET_THRESHOLDS = [50, 80, 100] as const;
export const BUDGET_BASES = ['actual', 'forecast'] as const;
export type BudgetBasis = (typeof BUDGET_BASES)[number];
export const HARD_STOPS = ['actual', 'forecast', 'off'] as const;
export type HardStop = (typeof HARD_STOPS)[number];
/** An override lasts at most 7 days. */
export const OVERRIDE_MAX_HOURS = 7 * 24;
const HOUR = 3_600_000;
const TABLES = ['cloud_budgets', 'cloud_budget_alerts', 'cloud_budget_overrides'] as const;
const SCHEMA_RECHECK_MS = 30_000;

export const budgetsMissing = () => new HttpProblem(503, 'Not installed', 'Cloud budgets need the database migration 152_cloud_budgets, which has not been applied.', { extensions: { reason: 'migration_pending' } });

export const setBudgetSchema = z
  .object({
    amount: z.number().positive().max(1_000_000_000),
    currency: z.string().regex(/^[A-Z]{3}$/, 'an ISO 4217 code such as USD').optional(),
    hardStop: z.enum(HARD_STOPS).default('actual')
  })
  .strict();
export const overrideSchema = z
  .object({
    reason: z.string().trim().min(10, 'say why, in at least 10 characters').max(500),
    hours: z.number().int().min(1).max(OVERRIDE_MAX_HOURS).default(OVERRIDE_MAX_HOURS)
  })
  .strict();

export interface Budget {
  accountId: string;
  tenantId: string;
  amount: number;
  currency: string;
  hardStop: HardStop;
  updatedBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export type OverrideState = 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'expired' | 'revoked';
export interface BudgetOverride {
  id: string;
  accountId: string;
  tenantId: string;
  state: OverrideState;
  /** True while approved and not yet expired. */
  active: boolean;
  reason: string;
  hours: number;
  proposedBy: string;
  proposedAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  note: string | null;
  startsAt: number | null;
  expiresAt: number | null;
}

export interface BudgetAlert {
  month: string;
  basis: BudgetBasis;
  threshold: number;
  spend: number;
  amount: number;
  currency: string;
  firedAt: number;
}

export interface BudgetStatus {
  budget: Budget;
  actual: SpendFigure;
  forecast: SpendFigure;
  /** Percent of the budget, rounded to one decimal. */
  pctActual: number;
  pctForecast: number;
  /** The hard stop is engaged: plans that add cost are refused unless an override is active. */
  stopped: boolean;
  override: BudgetOverride | null;
  alerts: BudgetAlert[];
  /** Where the figures come from and what changes next sprint. */
  source: string;
}

export interface BudgetDecision {
  refused: boolean;
  addsCost: boolean;
  /** Why the plan counts as adding cost (or not). */
  reasons: string[];
  status: Pick<BudgetStatus, 'pctActual' | 'pctForecast' | 'stopped'> & { amount: number; currency: string; actual: number; forecast: number; hardStop: HardStop; override: string | null };
  message: string;
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const pct = (spend: number, amount: number) => (amount > 0 ? Math.round((spend / amount) * 1000) / 10 : 0);

function budgetFrom(r: Record<string, unknown>): Budget {
  return { accountId: String(r.account_id), tenantId: String(r.tenant_id), amount: Number(r.amount), currency: String(r.currency), hardStop: (r.hard_stop as HardStop) ?? 'actual', updatedBy: (r.updated_by as string | null) ?? null, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) };
}

function overrideFrom(r: Record<string, unknown>, now = Date.now()): BudgetOverride {
  const expiresAt = num(r.expires_at);
  const state = r.state as OverrideState;
  const lapsed = state === 'approved' && expiresAt != null && expiresAt <= now;
  return {
    id: String(r.id),
    accountId: String(r.account_id),
    tenantId: String(r.tenant_id),
    state: lapsed ? 'expired' : state,
    active: state === 'approved' && !lapsed,
    reason: String(r.reason),
    hours: Number(r.hours),
    proposedBy: String(r.proposed_by),
    proposedAt: Number(r.proposed_at),
    decidedBy: (r.decided_by as string | null) ?? null,
    decidedAt: num(r.decided_at),
    note: (r.note as string | null) ?? null,
    startsAt: num(r.starts_at),
    expiresAt
  };
}

/** Types that cost nothing on their own (the estimate leaves them out too). */
const FREE_TYPES = new Set(['subnet', 'firewall', 'dns_record', 'tunnel']);

/**
 * Why a plan adds monthly cost (empty: it does not). A positive estimated delta in the budget's currency adds cost; a
 * plan without an estimate adds cost when it creates or replaces anything that is priced; scaling a GPU node group
 * above its minimum (a new GPU node group that can run nodes, a higher min, count or max) adds cost whatever the
 * estimate says (open decision 10). Destroy plans never add cost.
 */
export function costReasons(plan: Pick<Plan, 'purpose' | 'estimate' | 'steps' | 'desired'>, currency: string): string[] {
  if (plan.purpose === 'destroy') return [];
  const out: string[] = [];
  const e = plan.estimate;
  if (e && (!e.currency || e.currency === currency)) {
    if (Number(e.delta) > 0) out.push(`The plan adds ${Number(e.delta).toFixed(2)} ${currency} a month.`);
  } else if (!e) {
    const priced = plan.steps.filter((s) => (s.action === 'create' || s.action === 'replace') && !FREE_TYPES.has(s.type));
    if (priced.length) out.push(`The plan has no estimate and creates ${priced.map((s) => s.key).slice(0, 5).join(', ')}.`);
  } else {
    out.push(`The estimate is in ${e.currency}, not the budget's ${currency}, so it cannot show the plan adds nothing.`);
  }
  for (const s of plan.steps) {
    const g = gpuScaleUp(s, plan.desired.find((r) => r.key === s.key)?.spec ?? {});
    if (g) out.push(g);
  }
  return out;
}

const n = (v: unknown) => (v == null || v === '' ? null : Number(v));

/** Open decision 10: a GPU node group scaled above its minimum, or able to be (a reason), or null. */
export function gpuScaleUp(step: PlanStep, spec: Record<string, unknown>): string | null {
  if (step.type !== 'node_group' || !spec.gpu) return null;
  if (step.action === 'create' || step.action === 'replace') {
    const min = n(spec.min) ?? 0;
    const max = n(spec.max) ?? min;
    const count = n(spec.count) ?? n(spec.desired) ?? min;
    if (min > 0 || max > min || count > 0) return `GPU node group ${step.key} adds nodes (minimum ${min}, maximum ${max}).`;
    return null;
  }
  if (step.action !== 'update') return null;
  for (const c of step.changes) {
    if (!['min', 'max', 'count', 'desired'].includes(c.path)) continue;
    const before = n(c.before);
    const after = n(c.after);
    if (after != null && (before == null || after > before)) return `GPU node group ${step.key} scales up (${c.path} ${before ?? 'unset'} → ${after}).`;
  }
  const min = n(spec.min) ?? 0;
  const count = n(spec.count) ?? n(spec.desired);
  if (count != null && count > min) return `GPU node group ${step.key} runs ${count} nodes, above its minimum of ${min}.`;
  return null;
}

export class CloudBudgets {
  /** Where spend comes from: billing data per account when fresh (B-10603), else the applied plans' estimates. */
  spend: SpendSource;
  private schema: { ok: boolean; at: number } | null = null;
  private listening: (() => void) | null = null;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly s: () => Services) {
    this.spend = new AccountSpend(s);
  }

  async installed(): Promise<boolean> {
    const t = Date.now();
    if (this.schema && (this.schema.ok || t - this.schema.at < SCHEMA_RECHECK_MS)) return this.schema.ok;
    let ok = true;
    try {
      for (const name of TABLES) if (!(await this.s().db.schema.hasTable(name))) ok = false;
    } catch {
      ok = false;
    }
    this.schema = { ok, at: t };
    return ok;
  }

  resetSchemaCache(): void {
    this.schema = null;
  }

  async need(): Promise<void> {
    await this.s().cloud.accounts.need();
    if (!(await this.installed())) throw budgetsMissing();
  }

  private get db() {
    return this.s().db;
  }

  /** The tenant an account's budget belongs to: its own, or for a platform account the platform tenant. */
  async tenantOf(account: Pick<CloudAccount, 'tenantId'>): Promise<string> {
    if (account.tenantId) return account.tenantId;
    const t = await this.s().tenants.bySlug(this.s().cfg.DEFAULT_TENANT);
    if (!t) throw conflict('The platform tenant is missing.');
    return t.id;
  }

  // ---------- budgets ----------

  async get(accountId: string): Promise<Budget | null> {
    if (!(await this.installed())) return null;
    const r = (await this.db('cloud_budgets').where({ account_id: accountId }).first()) as Record<string, unknown> | undefined;
    return r ? budgetFrom(r) : null;
  }

  /** Every budget on the accounts a principal may see. */
  async list(p: Principal): Promise<{ account: Pick<CloudAccount, 'id' | 'name' | 'provider' | 'scope'>; status: BudgetStatus; pending: BudgetOverride[] }[]> {
    await this.need();
    const accounts = await this.s().cloud.accounts.list(p);
    const rows = (await this.db('cloud_budgets').whereIn('account_id', accounts.map((a) => a.id))) as Record<string, unknown>[];
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const out: { account: Pick<CloudAccount, 'id' | 'name' | 'provider' | 'scope'>; status: BudgetStatus; pending: BudgetOverride[] }[] = [];
    for (const r of rows) {
      const a = byId.get(String(r.account_id));
      if (a) out.push({ account: { id: a.id, name: a.name, provider: a.provider, scope: a.scope }, status: await this.statusOf(budgetFrom(r)), pending: (await this.overrides(a.id)).filter((o) => o.state === 'pending') });
    }
    return out;
  }

  async view(p: Principal, accountId: string): Promise<{ installed: true; account: { id: string; name: string; currency: string }; budget: Budget | null; status: BudgetStatus | null; overrides: BudgetOverride[]; mayChange: boolean }> {
    await this.need();
    const a = await this.s().cloud.accounts.getFor(p, accountId);
    const b = await this.get(a.id);
    let mayChange = true;
    try {
      this.s().cloud.accounts.assertCanChange(p, a);
    } catch {
      mayChange = false;
    }
    return { installed: true, account: { id: a.id, name: a.name, currency: currencyFor(a) }, budget: b, status: b ? await this.statusOf(b) : null, overrides: await this.overrides(a.id), mayChange };
  }

  /** Sets (or changes) an account's monthly budget. A changed amount or currency starts the month's alerts afresh. */
  async set(a: CloudActor, accountId: string, input: z.infer<typeof setBudgetSchema>): Promise<BudgetStatus> {
    await this.need();
    const acct = await this.s().cloud.accounts.getFor(a.principal, accountId);
    this.s().cloud.accounts.assertCanChange(a.principal, acct);
    const before = await this.get(acct.id);
    const currency = input.currency ?? before?.currency ?? currencyFor(acct);
    const t = Date.now();
    const tenantId = await this.tenantOf(acct);
    const row = { tenant_id: tenantId, amount: String(input.amount), currency, hard_stop: input.hardStop, updated_by: a.principal.userId, updated_at: t };
    if (before) await this.db('cloud_budgets').where({ account_id: acct.id }).update(row);
    else await this.db('cloud_budgets').insert({ account_id: acct.id, created_at: t, ...row });
    if (before && (before.amount !== input.amount || before.currency !== currency)) await this.db('cloud_budget_alerts').where({ account_id: acct.id, month: monthOf(t).key }).delete();
    await cloudAudit(this.s(), { tenantId, action: before ? 'cloud.budget.updated' : 'cloud.budget.set', actor: a, detail: { account: acct.id, name: acct.name, before: before ? { amount: before.amount, currency: before.currency, hardStop: before.hardStop } : null, after: { amount: input.amount, currency, hardStop: input.hardStop } } });
    const b = (await this.get(acct.id))!;
    await this.evaluate(acct.id);
    return this.statusOf(b);
  }

  async remove(a: CloudActor, accountId: string): Promise<void> {
    await this.need();
    const acct = await this.s().cloud.accounts.getFor(a.principal, accountId);
    this.s().cloud.accounts.assertCanChange(a.principal, acct);
    const before = await this.get(acct.id);
    if (!before) throw notFound('Budget');
    await this.db('cloud_budgets').where({ account_id: acct.id }).delete();
    cloudPlaneMetrics(this.s().metrics.registry).budgetStatus(acct.id, null);
    await this.db('cloud_budget_alerts').where({ account_id: acct.id }).delete();
    await cloudAudit(this.s(), { tenantId: await this.tenantOf(acct), action: 'cloud.budget.removed', actor: a, detail: { account: acct.id, name: acct.name, before: { amount: before.amount, currency: before.currency, hardStop: before.hardStop } } });
  }

  /** The budget against this month's actual and forecast spend, the active override and the alerts sent. */
  async statusOf(b: Budget, now = Date.now()): Promise<BudgetStatus> {
    const [actual, forecast] = await Promise.all([this.spend.actualMonthToDate(b.accountId, { currency: b.currency, now }), this.spend.forecast(b.accountId, { currency: b.currency, now })]);
    const override = await this.activeOverride(b.accountId, now);
    const pa = pct(actual.amount, b.amount);
    const pf = pct(forecast.amount, b.amount);
    const stopped = b.hardStop === 'off' ? false : b.hardStop === 'forecast' ? pf >= 100 : pa >= 100;
    const alerts = ((await this.db('cloud_budget_alerts').where({ account_id: b.accountId, month: monthOf(now).key }).orderBy('fired_at')) as Record<string, unknown>[]).map((r) => ({ month: String(r.month), basis: r.basis as BudgetBasis, threshold: Number(r.threshold), spend: Number(r.spend), amount: Number(r.amount), currency: String(r.currency), firedAt: Number(r.fired_at) }));
    return { budget: b, actual, forecast, pctActual: pa, pctForecast: pf, stopped, override, alerts, source: spendSourceText(actual) };
  }

  // ---------- alerts ----------

  /** Who hears about an account's budget: its tenant's active users holding finops:read or cloud:admin. */
  async watchers(tenantId: string): Promise<string[]> {
    const rows = (await this.db('users as u').join('user_roles as r', 'r.user_id', 'u.id').where({ 'u.tenant_id': tenantId, 'u.state': 'active' }).select('u.id', 'r.role')) as { id: string; role: string }[];
    const roles = new Map<string, string[]>();
    for (const r of rows) roles.set(r.id, [...(roles.get(r.id) ?? []), r.role]);
    return [...roles]
      .filter(([, list]) => {
        const perms = permissionsFor(list, tenantId);
        return perms.has('finops:read') || perms.has('cloud:admin');
      })
      .map(([id]) => id);
  }

  /**
   * Sends the alerts an account's spend has crossed this month and not yet sent: 50, 80 and 100 % of actual and of
   * forecast spend, each once (a unique row per account, month, basis and threshold, so two instances never both
   * send one). Returns what was sent.
   */
  async evaluate(accountId: string, now = Date.now()): Promise<BudgetAlert[]> {
    if (!(await this.installed())) return [];
    const b = await this.get(accountId);
    if (!b) return [];
    const account = await this.s().cloud.accounts.get(accountId);
    if (!account) return [];
    const status = await this.statusOf(b, now);
    // B-10702: budget burn and the hard stop, per provider, from this evaluation.
    const metrics = cloudPlaneMetrics(this.s().metrics.registry);
    metrics.budgetStatus(accountId, { provider: account.provider, pctActual: status.pctActual, pctForecast: status.pctForecast, stopped: status.stopped && !status.override, source: status.actual.source });
    const month = monthOf(now).key;
    const sent: BudgetAlert[] = [];
    for (const basis of BUDGET_BASES) {
      const spend = basis === 'actual' ? status.actual.amount : status.forecast.amount;
      const p = basis === 'actual' ? status.pctActual : status.pctForecast;
      for (const threshold of BUDGET_THRESHOLDS) {
        if (p < threshold) continue;
        if (status.alerts.some((x) => x.basis === basis && x.threshold === threshold)) continue;
        const id = ulid();
        try {
          await this.db('cloud_budget_alerts').insert({ id, account_id: accountId, month, basis, threshold, spend: String(spend), amount: String(b.amount), currency: b.currency, audit_id: null, fired_at: now });
        } catch {
          continue; // another instance sent it
        }
        const alert: BudgetAlert = { month, basis, threshold, spend, amount: b.amount, currency: b.currency, firedAt: now };
        const audit = await cloudAudit(this.s(), {
          tenantId: b.tenantId,
          action: 'cloud.budget.alert',
          actor: { service: 'cloud.budgets' },
          detail: { account: account.id, name: account.name, month, basis, threshold, percent: p, spend, amount: b.amount, currency: b.currency, source: status.actual.source, hardStop: b.hardStop, stopped: status.stopped }
        });
        await this.db('cloud_budget_alerts').where({ id }).update({ audit_id: audit.id });
        await this.tell(account, b.tenantId, alert, p, status.stopped && threshold === 100, status.actual.source);
        metrics.budgetAlert(basis, threshold);
        sent.push(alert);
      }
    }
    return sent;
  }

  private async tell(account: CloudAccount, tenantId: string, a: BudgetAlert, p: number, stopped: boolean, source: SpendFigure['source'] = 'estimate'): Promise<void> {
    const s = this.s();
    const userIds = await this.watchers(tenantId);
    if (!userIds.length) return;
    const what = a.basis === 'actual' ? 'spent so far this month' : 'forecast for this month';
    const title = `${account.name}: ${a.threshold} % of its budget ${a.basis === 'actual' ? 'spent' : 'forecast'}`;
    const body = `${a.spend.toFixed(2)} ${a.currency} ${what}, ${p} % of the ${a.amount.toFixed(2)} ${a.currency} budget.${stopped ? ' Plans that add cost are refused until next month or an approved override.' : ''} ${source === 'billing' ? 'From billing data.' : 'Estimated from applied plans; no billing data yet.'}`;
    await s.notifications.notify({ tenantId, userIds, kind: 'cloud.budget', title, body: body.slice(0, 300), route: 'cloud', label: 'internal', email: a.threshold === 100 }).catch((err: unknown) => s.log.warn({ err }, 'cloud budget notice failed'));
  }

  // ---------- the hard stop ----------

  /**
   * The budget's answer to a plan (null: no budget, or the tables are missing). Refused when the plan adds monthly
   * cost while the hard stop is engaged and no override is active.
   */
  async decide(plan: Pick<Plan, 'purpose' | 'estimate' | 'steps' | 'desired'>, d: Pick<Deployment, 'accountId'>, now = Date.now()): Promise<BudgetDecision | null> {
    if (!(await this.installed())) return null;
    const b = await this.get(d.accountId);
    if (!b) return null;
    const reasons = costReasons(plan, b.currency);
    const addsCost = reasons.length > 0;
    const status = await this.statusOf(b, now);
    const refused = addsCost && status.stopped && !status.override;
    const basis = b.hardStop === 'forecast' ? `forecast ${status.forecast.amount.toFixed(2)}` : `spent ${status.actual.amount.toFixed(2)}`;
    const message = refused
      ? `budget_exceeded: the account is at ${b.hardStop === 'forecast' ? status.pctForecast : status.pctActual} % of its ${b.amount.toFixed(2)} ${b.currency} monthly budget (${basis} ${b.currency}) and this plan adds cost (${reasons.join(' ')}). Scale down, destroy, or ask a second admin to approve an override.`
      : addsCost && status.override
        ? `The budget is past its hard stop; an override approved until ${new Date(status.override.expiresAt ?? now).toISOString()} lets this plan through.`
        : addsCost
          ? 'The plan adds cost; the budget allows it.'
          : 'The plan adds no monthly cost.';
    return {
      refused,
      addsCost,
      reasons,
      message,
      status: { amount: b.amount, currency: b.currency, actual: status.actual.amount, forecast: status.forecast.amount, pctActual: status.pctActual, pctForecast: status.pctForecast, stopped: status.stopped, hardStop: b.hardStop, override: status.override?.id ?? null }
    };
  }

  /**
   * 1.9.99-final, Sprint 60 (B-10402): the budget's answer to a GPU node group scaled by the gateway's autoscaler or
   * from Pools, outside a plan. Open decision 10: scaling up (above the minimum) adds cost and is refused while the
   * hard stop is engaged and no override is active; scaling down (or staying) is always allowed (null: no decision
   * needed, no budget, or the tables are missing).
   */
  async decideScale(accountId: string, input: { key: string; from: number; to: number; min: number; max: number }, now = Date.now()): Promise<BudgetDecision | null> {
    if (input.to <= input.from) return null;
    const step = { key: input.key, action: 'update', changes: [{ path: 'desired', before: input.from, after: input.to }], type: 'node_group', region: '', protect: false, dependsOn: [], providerId: null } as unknown as PlanStep;
    const desired = [{ key: input.key, type: 'node_group', spec: { gpu: true, min: input.min, max: input.max, desired: input.to }, dependsOn: [], protect: false, region: null }];
    return this.decide({ purpose: 'apply', estimate: null, steps: [step], desired } as unknown as Pick<Plan, 'purpose' | 'estimate' | 'steps' | 'desired'>, { accountId }, now);
  }

  // ---------- overrides (dual control) ----------

  async overrides(accountId: string, now = Date.now()): Promise<BudgetOverride[]> {
    if (!(await this.installed())) return [];
    return ((await this.db('cloud_budget_overrides').where({ account_id: accountId }).orderBy('proposed_at', 'desc').limit(50)) as Record<string, unknown>[]).map((r) => overrideFrom(r, now));
  }

  async activeOverride(accountId: string, now = Date.now()): Promise<BudgetOverride | null> {
    const r = (await this.db('cloud_budget_overrides').where({ account_id: accountId, state: 'approved' }).where('expires_at', '>', now).orderBy('expires_at', 'desc').first()) as Record<string, unknown> | undefined;
    return r ? overrideFrom(r, now) : null;
  }

  private async override(accountId: string, id: string): Promise<BudgetOverride> {
    const r = (await this.db('cloud_budget_overrides').where({ id, account_id: accountId }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Override');
    return overrideFrom(r);
  }

  private async watchersBut(account: CloudAccount, tenantId: string, but: string | null): Promise<string[]> {
    const admins = await this.s().cloud.accounts.cloudAdmins(tenantId, account.scope === 'platform');
    const finops = await this.watchers(tenantId);
    return [...new Set([...admins, ...finops])].filter((u) => u !== but);
  }

  /** Proposes lifting the hard stop for up to 7 days, with a reason; a second admin approves. */
  async propose(a: CloudActor, accountId: string, input: z.infer<typeof overrideSchema>): Promise<BudgetOverride> {
    await this.need();
    const p = a.principal;
    if (p.kind !== 'user' || !p.userId) throw forbidden('Only a person can propose a budget override.', { step: 'credential' });
    const acct = await this.s().cloud.accounts.getFor(p, accountId);
    this.s().cloud.accounts.assertCanChange(p, acct);
    if (!(await this.get(acct.id))) throw conflict(`${acct.name} has no budget, so there is nothing to override.`);
    if (await this.db('cloud_budget_overrides').where({ account_id: acct.id, state: 'pending' }).first('id')) throw new HttpProblem(409, 'Conflict', 'An override is already waiting for approval; approve, reject or withdraw it first.', { extensions: { reason: 'override_pending' } });
    const active = await this.activeOverride(acct.id);
    if (active) throw new HttpProblem(409, 'Conflict', `An override is active until ${new Date(active.expiresAt!).toISOString()}.`, { extensions: { reason: 'override_active', override: active.id } });
    const tenantId = await this.tenantOf(acct);
    const row = { id: ulid(), account_id: acct.id, tenant_id: tenantId, state: 'pending', reason: input.reason, hours: Math.min(input.hours, OVERRIDE_MAX_HOURS), proposed_by: p.userId, proposed_at: Date.now(), decided_by: null, decided_at: null, note: null, starts_at: null, expires_at: null };
    await this.db('cloud_budget_overrides').insert(row);
    await cloudAudit(this.s(), { tenantId, action: 'cloud.budget.override.proposed', actor: a, detail: { account: acct.id, name: acct.name, override: row.id, reason: input.reason, hours: row.hours } });
    const others = await this.watchersBut(acct, tenantId, p.userId);
    if (others.length) await this.s().notifications.notify({ tenantId, userIds: others, kind: 'cloud.budget', title: `${acct.name}: a budget override waits for approval`, body: `Lift the hard stop for ${row.hours} hours. Reason: ${input.reason}`.slice(0, 300), route: 'cloud', label: 'internal' }).catch(() => undefined);
    return overrideFrom(row as unknown as Record<string, unknown>);
  }

  private async decideOverride(a: CloudActor, accountId: string, id: string, to: 'approved' | 'rejected' | 'withdrawn' | 'revoked', note: string | null): Promise<BudgetOverride> {
    await this.need();
    const p = a.principal;
    const acct = await this.s().cloud.accounts.getFor(p, accountId);
    const o = await this.override(acct.id, id);
    if (to === 'withdrawn') {
      if (o.proposedBy !== p.userId) throw forbidden('Only the admin who proposed an override can withdraw it; reject it instead.', { step: 'dual-control' });
      if (o.state !== 'pending') throw conflict(`The override is ${o.state}.`);
    } else if (to === 'revoked') {
      this.s().cloud.accounts.assertCanChange(p, acct);
      if (!o.active) throw conflict(`The override is ${o.state}, not active.`);
    } else {
      this.s().cloud.accounts.assertCanChange(p, acct);
      if (o.state !== 'pending') throw conflict(`The override is ${o.state}.`);
      if (o.proposedBy === p.userId) throw forbidden(to === 'approved' ? 'Dual control: you cannot approve your own override. Another admin must approve it.' : 'This is your own proposal: withdraw it instead.', { step: 'dual-control' });
    }
    const t = Date.now();
    const patch: Record<string, unknown> = { state: to, decided_by: p.userId, decided_at: t, note };
    if (to === 'approved') Object.assign(patch, { starts_at: t, expires_at: t + Math.min(o.hours, OVERRIDE_MAX_HOURS) * HOUR });
    if (to === 'revoked') Object.assign(patch, { expires_at: t });
    const from = to === 'revoked' ? 'approved' : 'pending';
    const changed = await this.db('cloud_budget_overrides').where({ id: o.id, state: from }).update(patch);
    if (changed !== 1) throw conflict('The override was decided by someone else.');
    const after = await this.override(acct.id, o.id);
    await cloudAudit(this.s(), { tenantId: o.tenantId, action: `cloud.budget.override.${to}`, actor: a, detail: { account: acct.id, name: acct.name, override: o.id, proposedBy: o.proposedBy, reason: o.reason, hours: o.hours, note, ...(after.expiresAt ? { expiresAt: after.expiresAt } : {}) } });
    if (to === 'approved' || to === 'rejected') await this.s().notifications.notify({ tenantId: o.tenantId, userIds: [o.proposedBy], kind: 'cloud.budget', title: `${acct.name}: your budget override was ${to}`, body: to === 'approved' ? `The hard stop is lifted until ${new Date(after.expiresAt!).toISOString()}.` : (note ?? o.reason).slice(0, 300), route: 'cloud', label: 'internal' }).catch(() => undefined);
    return after;
  }

  approve(a: CloudActor, accountId: string, id: string, note: string | null): Promise<BudgetOverride> {
    return this.decideOverride(a, accountId, id, 'approved', note);
  }

  reject(a: CloudActor, accountId: string, id: string, note: string | null): Promise<BudgetOverride> {
    return this.decideOverride(a, accountId, id, 'rejected', note);
  }

  withdraw(a: CloudActor, accountId: string, id: string): Promise<BudgetOverride> {
    return this.decideOverride(a, accountId, id, 'withdrawn', null);
  }

  revoke(a: CloudActor, accountId: string, id: string, note: string | null): Promise<BudgetOverride> {
    return this.decideOverride(a, accountId, id, 'revoked', note);
  }

  /** Marks approved overrides past their end as expired, once each (audited). */
  async expire(now = Date.now()): Promise<string[]> {
    if (!(await this.installed())) return [];
    const rows = (await this.db('cloud_budget_overrides').where({ state: 'approved' }).where('expires_at', '<=', now)) as Record<string, unknown>[];
    const out: string[] = [];
    for (const r of rows) {
      const n2 = await this.db('cloud_budget_overrides').where({ id: r.id, state: 'approved' }).update({ state: 'expired' });
      if (n2 !== 1) continue;
      out.push(String(r.id));
      await cloudAudit(this.s(), { tenantId: String(r.tenant_id), action: 'cloud.budget.override.expired', actor: { service: 'cloud.budgets' }, detail: { account: String(r.account_id), override: String(r.id), expiresAt: Number(r.expires_at) } });
    }
    return out;
  }

  // ---------- jobs ----------

  /** The check: every budget's alerts, and overrides that ended. */
  async check(now = Date.now()): Promise<{ accounts: number; alerts: number; expired: number }> {
    if (!(await this.installed())) return { accounts: 0, alerts: 0, expired: 0 };
    const expired = await this.expire(now);
    let alerts = 0;
    const rows = (await this.db('cloud_budgets').select('account_id')) as { account_id: string }[];
    for (const r of rows) alerts += (await this.evaluate(r.account_id, now).catch((err: unknown) => (this.s().log.warn({ err, account: r.account_id }, 'cloud budget check failed'), []))).length;
    return { accounts: rows.length, alerts, expired: expired.length };
  }

  registerJobs(): void {
    const s = this.s();
    s.jobs.register('cloud.budgets.check', async (p, ctx) => {
      const out = p.accountId ? { accounts: 1, alerts: (await this.evaluate(String(p.accountId))).length, expired: (await this.expire()).length } : await this.check();
      await ctx.progress(100, `${out.accounts} budgets checked, ${out.alerts} alerts sent, ${out.expired} overrides expired`);
      return out;
    }, { timeoutMs: 10 * 60_000 });
    // After a successful apply the account's spend changed: check its budget at once.
    this.listening ??= s.audit.onAppend((e) => {
      if (e.action !== 'cloud.apply.succeeded') return;
      const deploymentId = (e.target as { deployment?: string } | null)?.deployment;
      if (!deploymentId) return;
      const p = (async () => {
        if (!(await this.installed())) return;
        const d = await s.cloud.deployments.get(deploymentId).catch(() => null);
        if (d && (await this.get(d.accountId))) await this.evaluate(d.accountId);
      })().catch((err: unknown) => s.log.warn({ err }, 'cloud budget check after apply failed'));
      this.pending.add(p);
      void p.finally(() => this.pending.delete(p));
    });
  }

  /** Waits for the checks queued by applies that ended (tests; shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  schedule(scheduler: Scheduler, minutes: number): void {
    if (minutes <= 0) return;
    scheduler.every('cloud.budgets.check', minutes * 60_000, async () => {
      if (!(await this.installed())) return [];
      const any = await this.db('cloud_budgets').first('tenant_id');
      return any ? [{ tenantId: String(any.tenant_id), payload: {} }] : [];
    });
  }
}
