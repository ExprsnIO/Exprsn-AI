import { ulid } from 'ulid';
import { json } from '../db/knex.js';
import type { Principal } from '../authz/policy.js';
import { HttpProblem, notFound } from '../http/problem.js';
import type { Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import type { CloudActor } from './accounts.js';
import { anomalyMetrics } from './anomaly-metrics.js';
import { cloudAudit } from './audit.js';
import { dayOf, dayStart, type CostRow } from './costs.js';
import { TAG_PREFIX } from './tags.js';
import type { CloudAccount, Provider } from './types.js';

/*
 * 1.9.99-final, Sprint 62 (B-10606): spend anomalies, `s.cloud.anomalies`.
 *
 * After every successful billing fetch (`cloud.costs.ingest` queues `cloud.anomalies.detect` for the account), and
 * once a day for every account as a fallback, each of the last ANOMALY_CHECK_DAYS ingested days is compared, per
 * service and currency (never converted, open decision 17), with that service's daily spend over the 14 days before
 * it in the same account (`cloud_costs`).
 *
 * The baseline is robust, so one earlier spike or a quiet weekend does not move it: the **median** of the 14 daily
 * totals (a day the account has ingested rows for but not this service counts as 0; a day with no rows at all for
 * the account is not part of the baseline), and the **median absolute deviation** (MAD) scaled by 1.4826, which is the
 * standard deviation for normally distributed spend. A day is an anomaly when all three hold:
 *
 *   - its robust score (actual − median) / max(1.4826 × MAD, 5 % of the median, 0.01) is at least 4;
 *   - it is at least 50 % above the median (actual ≥ 1.5 × median);
 *   - it is at least 50 (in the rows' currency) above the median, so small services never page anyone.
 *
 * With fewer than 7 baseline days holding data (a new account, a gap in ingestion) nothing is decided.
 *
 * An anomaly names its top contributors, each with the day's actual, its own baseline median and the extra: the
 * service, the deployments (from the row's attribution), the regions (the resource's, else the deployment's, else the
 * account's default region) and the tags (`exprsn:workspace`, `exprsn:pool`, `exprsn:tenant` and other `exprsn:` tags
 * the resources share). It is stored once per account, day, service and currency (a unique key, so re-runs and other
 * instances never repeat it), announced as the audit event `cloud.anomaly.detected` (which every webhook subscribed to
 * `cloud.*`, `cloud.anomaly.*` or `*` receives) and as a notice of kind `cloud.anomaly` to the tenant's FinOps readers
 * and cloud admins, and counted in `exprsn_cloud_anomalies_total`. Acknowledging one (`finops:manage`) stops repeat
 * notices: an anomaly of the same account and service within the next ANOMALY_QUIET_DAYS days is stored as
 * acknowledged (`suppressed_by`, audited `cloud.anomaly.suppressed`) without a notice; after that it opens again.
 *
 * Without migration 166 nothing is detected and the routes answer 503 `migration_pending`.
 */

const DAY = 86_400_000;
export const ANOMALY_BASELINE_DAYS = 14;
export const ANOMALY_MIN_HISTORY_DAYS = 7;
export const ANOMALY_MIN_SCORE = 4;
export const ANOMALY_MIN_RATIO = 1.5;
export const ANOMALY_MIN_DELTA = 50;
export const ANOMALY_CHECK_DAYS = 3;
export const ANOMALY_QUIET_DAYS = 3;
const MAD_SCALE = 1.4826;
const TOP_PER_DIMENSION = 3;
/** Tags that say what Exprsn-AI manages, not who caused the cost; left out of the tag contributors. */
const NOT_CONTRIBUTOR_TAGS = new Set([`${TAG_PREFIX}managed`, `${TAG_PREFIX}account`, `${TAG_PREFIX}deployment`]);

export const anomaliesMissing = () => new HttpProblem(503, 'Not installed', 'Spend anomalies need the database migration 166_cloud_anomalies, which has not been applied.', { extensions: { reason: 'migration_pending' } });

export type AnomalyState = 'open' | 'acknowledged';
export type ContributorDimension = 'service' | 'deployment' | 'region' | 'tag';

export interface Contributor {
  dimension: ContributorDimension;
  /** The deployment id ('' unattributed), the region, the tag as `key=value`, or the service. */
  key: string;
  name: string;
  actual: number;
  baseline: number;
  extra: number;
}

export interface Anomaly {
  id: string;
  account: { id: string; name: string; provider: Provider } | null;
  accountId: string;
  tenantId: string;
  provider: Provider;
  day: string;
  service: string;
  currency: string;
  actual: number;
  baseline: number;
  mad: number;
  score: number;
  /** actual / baseline; null when the baseline is 0. */
  ratio: number | null;
  /** Percent above the baseline; null when the baseline is 0. */
  increasePct: number | null;
  historyDays: number;
  contributors: Contributor[];
  /** The deployment, region and tag that added most, or null. */
  top: { deployment: Contributor | null; region: Contributor | null; tag: Contributor | null };
  state: AnomalyState;
  suppressedBy: string | null;
  acknowledgedBy: string | null;
  acknowledgedAt: number | null;
  note: string | null;
  auditId: string | null;
  detectedAt: number;
}

export interface Assessment {
  anomalous: boolean;
  median: number;
  mad: number;
  sigma: number;
  score: number;
  ratio: number | null;
  /** Why it is not an anomaly (empty when it is). */
  reasons: string[];
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const round2 = (n: number) => Math.round(n * 100) / 100;

export function median(values: number[]): number {
  if (!values.length) return 0;
  const v = [...values].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

/** The median and the median absolute deviation of a baseline. */
export function robustBaseline(values: number[]): { median: number; mad: number } {
  const m = median(values);
  return { median: m, mad: median(values.map((x) => Math.abs(x - m))) };
}

/** Whether a day's actual spend is an anomaly against its baseline days (see the header for the rule). */
export function assess(actual: number, baseline: number[], o: { minScore?: number; minRatio?: number; minDelta?: number; minHistory?: number } = {}): Assessment {
  const { median: m, mad } = robustBaseline(baseline);
  const sigma = Math.max(MAD_SCALE * mad, 0.05 * m, 0.01);
  const score = (actual - m) / sigma;
  const ratio = m > 0 ? actual / m : null;
  const reasons: string[] = [];
  if (baseline.length < (o.minHistory ?? ANOMALY_MIN_HISTORY_DAYS)) reasons.push(`only ${baseline.length} baseline days`);
  if (score < (o.minScore ?? ANOMALY_MIN_SCORE)) reasons.push(`score ${score.toFixed(2)} below ${o.minScore ?? ANOMALY_MIN_SCORE}`);
  if (m > 0 && actual < (o.minRatio ?? ANOMALY_MIN_RATIO) * m) reasons.push(`less than ${Math.round(((o.minRatio ?? ANOMALY_MIN_RATIO) - 1) * 100)} % above the baseline`);
  if (actual - m < (o.minDelta ?? ANOMALY_MIN_DELTA)) reasons.push(`less than ${o.minDelta ?? ANOMALY_MIN_DELTA} above the baseline`);
  return { anomalous: reasons.length === 0, median: round6(m), mad: round6(mad), sigma: round6(sigma), score: Math.round(score * 100) / 100, ratio: ratio == null ? null : Math.round(ratio * 1000) / 1000, reasons };
}

function anomalyFrom(r: Record<string, unknown>, accounts?: Map<string, { id: string; name: string; provider: Provider }>): Anomaly {
  const contributors = json<Contributor[]>(r.contributors, []);
  const best = (d: ContributorDimension) => contributors.filter((c) => c.dimension === d).sort((a, b) => b.extra - a.extra)[0] ?? null;
  const baseline = Number(r.baseline);
  const actual = Number(r.actual);
  return {
    id: String(r.id),
    account: accounts?.get(String(r.account_id)) ?? null,
    accountId: String(r.account_id),
    tenantId: String(r.tenant_id),
    provider: r.provider as Provider,
    day: String(r.day),
    service: String(r.service),
    currency: String(r.currency),
    actual,
    baseline,
    mad: Number(r.mad),
    score: Number(r.score),
    ratio: r.ratio == null ? null : Number(r.ratio),
    increasePct: baseline > 0 ? Math.round(((actual - baseline) / baseline) * 100) : null,
    historyDays: Number(r.history_days),
    contributors,
    top: { deployment: best('deployment'), region: best('region'), tag: best('tag') },
    state: r.state as AnomalyState,
    suppressedBy: (r.suppressed_by as string | null) ?? null,
    acknowledgedBy: (r.acknowledged_by as string | null) ?? null,
    acknowledgedAt: r.acknowledged_at == null ? null : Number(r.acknowledged_at),
    note: (r.note as string | null) ?? null,
    auditId: (r.audit_id as string | null) ?? null,
    detectedAt: Number(r.detected_at)
  };
}

/** Where a cost row comes from: its deployment, region and tags. */
interface RowFacts {
  deploymentKey: string;
  deploymentName: string;
  region: string;
  tags: string[];
}

export class CloudAnomalies {
  private schema: { ok: boolean; at: number } | null = null;

  constructor(
    private readonly s: () => Services,
    private readonly o: { now?: () => number } = {}
  ) {}

  private get db() {
    return this.s().db;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  async installed(): Promise<boolean> {
    const t = Date.now();
    if (this.schema && (this.schema.ok || t - this.schema.at < 30_000)) return this.schema.ok;
    let ok: boolean;
    try {
      ok = await this.db.schema.hasTable('cloud_anomalies');
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
    await this.s().cloud.costs.need();
    if (!(await this.installed())) throw anomaliesMissing();
  }

  // ---------- detection ----------

  /**
   * Checks the last ANOMALY_CHECK_DAYS days before `now` (UTC) of one account and stores, announces and returns the
   * new anomalies. Idempotent: what is stored already is never stored or announced again.
   */
  async detectAccount(accountId: string, o: { now?: number; jobId?: string | null } = {}): Promise<Anomaly[]> {
    if (!(await this.installed()) || !(await this.s().cloud.costs.installed())) return [];
    const account = await this.s().cloud.accounts.get(accountId);
    if (!account) return [];
    const now = o.now ?? this.now();
    const today = dayStart(dayOf(now));
    const checkDays = Array.from({ length: ANOMALY_CHECK_DAYS }, (_, i) => dayOf(today - (ANOMALY_CHECK_DAYS - i) * DAY));
    const from = dayOf(dayStart(checkDays[0]!) - ANOMALY_BASELINE_DAYS * DAY);
    const rows = await this.s().cloud.costs.rows(account.id, { from, to: dayOf(today) });
    if (!rows.length) return [];
    const withData = new Set(rows.map((r) => r.day));
    const facts = await this.factsFor(account);
    const out: Anomaly[] = [];
    for (const day of checkDays) {
      if (!withData.has(day)) continue;
      const history: string[] = [];
      for (let t = dayStart(day) - ANOMALY_BASELINE_DAYS * DAY; t < dayStart(day); t += DAY) if (withData.has(dayOf(t))) history.push(dayOf(t));
      if (history.length < ANOMALY_MIN_HISTORY_DAYS) continue;
      const inWindow = rows.filter((r) => r.day === day || history.includes(r.day));
      const series = new Set(inWindow.filter((r) => r.day === day).map((r) => `${r.service}\u0000${r.currency}`));
      for (const key of series) {
        const [service, currency] = key.split('\u0000') as [string, string];
        const mine = inWindow.filter((r) => r.service === service && r.currency === currency);
        const actual = round6(mine.filter((r) => r.day === day).reduce((n, r) => n + r.amount, 0));
        const baseline = history.map((d) => round6(mine.filter((r) => r.day === d).reduce((n, r) => n + r.amount, 0)));
        const a = assess(actual, baseline);
        if (!a.anomalous) continue;
        const contributors = this.contributors(mine, day, history, facts, service);
        const stored = await this.store(account, { day, service, currency, actual, assessment: a, historyDays: history.length, contributors }, now, o.jobId ?? null);
        if (stored) out.push(stored);
      }
    }
    return out;
  }

  /** Every account with ingested costs (the daily fallback). */
  async detect(o: { now?: number; jobId?: string | null } = {}): Promise<{ accounts: number; anomalies: number }> {
    if (!(await this.installed()) || !(await this.s().cloud.costs.installed())) return { accounts: 0, anomalies: 0 };
    const ids = ((await this.db('cloud_costs').distinct('account_id')) as { account_id: string }[]).map((r) => String(r.account_id));
    let anomalies = 0;
    for (const id of ids) anomalies += (await this.detectAccount(id, o)).length;
    return { accounts: ids.length, anomalies };
  }

  /** Deployment names and regions, and each resource's region and tags, for attributing rows. */
  private async factsFor(account: CloudAccount): Promise<(r: CostRow) => RowFacts> {
    const deps = (await this.db('cloud_deployments').where({ account_id: account.id }).select('id', 'name', 'region').catch(() => [])) as { id: string; name: string; region: string }[];
    const res = (await this.db('cloud_resources as r').join('cloud_deployments as d', 'd.id', 'r.deployment_id').where('d.account_id', account.id).select('r.deployment_id', 'r.provider_id', 'r.region', 'r.tags').catch(() => [])) as { deployment_id: string; provider_id: string | null; region: string | null; tags: unknown }[];
    const depById = new Map(deps.map((d) => [String(d.id), d]));
    const byProviderId = new Map<string, { region: string | null; tags: Record<string, string> }>();
    const shared = new Map<string, Record<string, string>>();
    const regions = new Map<string, Set<string>>();
    for (const r of res) {
      const tags = json<Record<string, string>>(r.tags, {});
      if (r.provider_id) byProviderId.set(String(r.provider_id), { region: r.region ?? null, tags });
      const had = shared.get(r.deployment_id);
      // The tags every resource of the deployment shares.
      shared.set(r.deployment_id, had ? Object.fromEntries(Object.entries(had).filter(([k, v]) => tags[k] === v)) : { ...tags });
      if (r.region) regions.set(r.deployment_id, (regions.get(r.deployment_id) ?? new Set()).add(r.region));
    }
    const tagList = (t: Record<string, string>) => Object.entries(t).filter(([k, v]) => k.startsWith(TAG_PREFIX) && !NOT_CONTRIBUTOR_TAGS.has(k) && v).map(([k, v]) => `${k}=${v}`).sort();
    return (r: CostRow) => {
      const dep = r.deploymentId ? depById.get(r.deploymentId) : undefined;
      const resource = r.allocation ? byProviderId.get(r.allocation) : undefined;
      const tags = { ...(dep ? (shared.get(dep.id) ?? {}) : {}), ...(resource?.tags ?? {}) };
      const region = resource?.region || dep?.region || account.defaultRegion || 'unknown';
      return { deploymentKey: r.deploymentId ?? '', deploymentName: dep?.name ?? (r.allocation ? `unattributed (${r.allocation})` : 'unattributed'), region, tags: tagList(tags) };
    };
  }

  /** Per dimension, what each value added on the day over its own baseline median, largest first. */
  private contributors(rows: CostRow[], day: string, history: string[], facts: (r: CostRow) => RowFacts, service: string): Contributor[] {
    const dims: { dimension: ContributorDimension; keys: (f: RowFacts, r: CostRow) => { key: string; name: string }[] }[] = [
      { dimension: 'deployment', keys: (f) => [{ key: f.deploymentKey, name: f.deploymentName }] },
      { dimension: 'region', keys: (f) => [{ key: f.region, name: f.region }] },
      { dimension: 'tag', keys: (f) => f.tags.map((t) => ({ key: t, name: t })) }
    ];
    const out: Contributor[] = [];
    const dayActual = round6(rows.filter((r) => r.day === day).reduce((n, r) => n + r.amount, 0));
    const svcBase = median(history.map((d) => rows.filter((r) => r.day === d).reduce((n, r) => n + r.amount, 0)));
    out.push({ dimension: 'service', key: service, name: service, actual: round2(dayActual), baseline: round2(svcBase), extra: round2(dayActual - svcBase) });
    const withFacts = rows.map((r) => ({ r, f: facts(r) }));
    for (const d of dims) {
      const sums = new Map<string, { name: string; byDay: Map<string, number> }>();
      for (const { r, f } of withFacts)
        for (const k of d.keys(f, r)) {
          const e = sums.get(k.key) ?? { name: k.name, byDay: new Map<string, number>() };
          e.byDay.set(r.day, (e.byDay.get(r.day) ?? 0) + r.amount);
          sums.set(k.key, e);
        }
      const list = [...sums].map(([key, e]) => {
        const actual = e.byDay.get(day) ?? 0;
        const base = median(history.map((h) => e.byDay.get(h) ?? 0));
        return { dimension: d.dimension, key, name: e.name, actual: round2(actual), baseline: round2(base), extra: round2(actual - base) };
      });
      out.push(...list.filter((c) => c.extra > 0).sort((a, b) => b.extra - a.extra || a.key.localeCompare(b.key)).slice(0, TOP_PER_DIMENSION));
    }
    return out;
  }

  private async store(account: CloudAccount, a: { day: string; service: string; currency: string; actual: number; assessment: Assessment; historyDays: number; contributors: Contributor[] }, now: number, jobId: string | null): Promise<Anomaly | null> {
    const s = this.s();
    const tenantId = await s.cloud.budgets.tenantOf(account);
    // An acknowledgement in the last quiet days stops repeat notices for the same account and service.
    const quietFrom = dayOf(dayStart(a.day) - ANOMALY_QUIET_DAYS * DAY);
    const acked = (await this.db('cloud_anomalies').where({ account_id: account.id, service: a.service, currency: a.currency, state: 'acknowledged' }).whereNotNull('acknowledged_at').whereNull('suppressed_by').where('day', '>=', quietFrom).where('day', '<', a.day).orderBy('day', 'desc').first('id')) as { id?: string } | undefined;
    const suppressedBy = acked?.id ?? null;
    const id = ulid();
    const x = a.assessment;
    try {
      await this.db('cloud_anomalies').insert({
        id,
        account_id: account.id,
        tenant_id: tenantId,
        provider: account.provider,
        day: a.day,
        service: a.service.slice(0, 200),
        currency: a.currency,
        actual: String(round6(a.actual)),
        baseline: String(x.median),
        mad: String(x.mad),
        score: String(x.score),
        ratio: x.ratio == null ? null : String(x.ratio),
        history_days: a.historyDays,
        contributors: JSON.stringify(a.contributors),
        state: suppressedBy ? 'acknowledged' : 'open',
        suppressed_by: suppressedBy,
        acknowledged_by: null,
        acknowledged_at: null,
        note: null,
        audit_id: null,
        detected_at: now
      });
    } catch {
      return null; // stored already (a re-run, or another instance)
    }
    const row = anomalyFrom((await this.db('cloud_anomalies').where({ id }).first()) as Record<string, unknown>, new Map([[account.id, { id: account.id, name: account.name, provider: account.provider }]]));
    const dep = row.top.deployment;
    const audit = await cloudAudit(s, {
      tenantId,
      action: suppressedBy ? 'cloud.anomaly.suppressed' : 'cloud.anomaly.detected',
      actor: { service: 'cloud.anomalies', jobId },
      deploymentId: dep?.key || null,
      deploymentName: dep && dep.key ? dep.name : null,
      detail: { anomaly: id, account: account.id, name: account.name, provider: account.provider, day: a.day, service: a.service, currency: a.currency, actual: round2(a.actual), baseline: round2(x.median), mad: round2(x.mad), score: x.score, ratio: x.ratio, historyDays: a.historyDays, contributors: a.contributors.slice(0, 12), ...(suppressedBy ? { acknowledgedAnomaly: suppressedBy } : {}) }
    });
    await this.db('cloud_anomalies').where({ id }).update({ audit_id: audit.id });
    row.auditId = audit.id;
    if (suppressedBy) return row;
    anomalyMetrics(s.metrics.registry).detected(account.provider);
    await this.tell(account, tenantId, row);
    return row;
  }

  private async tell(account: CloudAccount, tenantId: string, a: Anomaly): Promise<void> {
    const s = this.s();
    const userIds = await s.cloud.budgets.watchers(tenantId);
    if (!userIds.length) return;
    const up = a.increasePct == null ? 'new spend' : `up ${a.increasePct} %`;
    const title = `${account.name}: ${a.service} ${up} on ${a.day}`;
    const names = [a.top.deployment ? `deployment ${a.top.deployment.name} (+${a.top.deployment.extra.toFixed(2)})` : null, a.top.region ? `region ${a.top.region.name}` : null, a.top.tag ? `tag ${a.top.tag.name}` : null].filter(Boolean).join(', ');
    const body = `${a.actual.toFixed(2)} ${a.currency} that day against a baseline of ${a.baseline.toFixed(2)} ${a.currency} a day (median of ${a.historyDays} days).${names ? ` Top contributors: ${names}.` : ''}`;
    await s.notifications.notify({ tenantId, userIds, kind: 'cloud.anomaly', title: title.slice(0, 200), body: body.slice(0, 300), route: `cloud-spend?tab=anomalies&anomaly=${a.id}`, label: 'internal' }).catch((err: unknown) => s.log.warn({ err }, 'cloud anomaly notice failed'));
  }

  // ---------- reads and the acknowledgement ----------

  async list(p: Principal, o: { state?: AnomalyState; accountId?: string; from?: string; to?: string; limit?: number } = {}): Promise<Anomaly[]> {
    await this.need();
    const accounts = await this.s().cloud.accounts.list(p);
    const byId = new Map(accounts.map((a) => [a.id, { id: a.id, name: a.name, provider: a.provider }]));
    const ids = o.accountId ? accounts.filter((a) => a.id === o.accountId).map((a) => a.id) : accounts.map((a) => a.id);
    if (!ids.length) return [];
    const q = this.db('cloud_anomalies').whereIn('account_id', ids);
    if (o.state) q.where({ state: o.state });
    if (o.from) q.where('day', '>=', o.from);
    if (o.to) q.where('day', '<', o.to);
    const rows = (await q.orderBy([{ column: 'day', order: 'desc' }, { column: 'detected_at', order: 'desc' }]).limit(Math.max(1, Math.min(500, o.limit ?? 200)))) as Record<string, unknown>[];
    return rows.map((r) => anomalyFrom(r, byId));
  }

  async get(p: Principal, id: string): Promise<Anomaly> {
    await this.need();
    const r = (await this.db('cloud_anomalies').where({ id }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Anomaly');
    const a = await this.s().cloud.accounts.getFor(p, String(r.account_id)).catch(() => null);
    if (!a) throw notFound('Anomaly');
    return anomalyFrom(r, new Map([[a.id, { id: a.id, name: a.name, provider: a.provider }]]));
  }

  /** Acknowledges an open anomaly with an optional note; repeat notices for its account and service stop for a while. */
  async acknowledge(a: CloudActor, id: string, note: string | null): Promise<Anomaly> {
    await this.need();
    const before = await this.get(a.principal, id);
    const acct = await this.s().cloud.accounts.getFor(a.principal, before.accountId);
    this.s().cloud.accounts.assertCanChange(a.principal, acct);
    if (before.state !== 'open') throw new HttpProblem(409, 'Conflict', 'This anomaly is already acknowledged.', { extensions: { reason: 'anomaly_acknowledged' } });
    const at = this.now();
    const n = await this.db('cloud_anomalies').where({ id, state: 'open' }).update({ state: 'acknowledged', acknowledged_by: a.principal.userId, acknowledged_at: at, note: note ? note.slice(0, 500) : null });
    if (!n) throw new HttpProblem(409, 'Conflict', 'This anomaly is already acknowledged.', { extensions: { reason: 'anomaly_acknowledged' } });
    await cloudAudit(this.s(), { tenantId: before.tenantId, action: 'cloud.anomaly.acknowledged', actor: a, deploymentId: before.top.deployment?.key || null, detail: { anomaly: id, account: acct.id, name: acct.name, day: before.day, service: before.service, note: note ?? null } });
    return this.get(a.principal, id);
  }

  // ---------- jobs ----------

  registerJobs(): void {
    this.s().jobs.register('cloud.anomalies.detect', async (p, ctx) => {
      if (p.accountId) {
        const found = await this.detectAccount(String(p.accountId), { jobId: ctx.job.id });
        await ctx.progress(100, found.length ? `${found.length} anomalies` : 'no anomalies');
        return { anomalies: found.length };
      }
      const r = await this.detect({ jobId: ctx.job.id });
      await ctx.progress(100, `${r.anomalies} anomalies in ${r.accounts} accounts`);
      return r;
    });
  }

  /** Daily, as the platform tenant, once some cost has been ingested (each ingest also queues its account's check). */
  schedule(scheduler: Scheduler): void {
    scheduler.every('cloud.anomalies.detect', DAY, async () => {
      if (!(await this.installed()) || !(await this.s().cloud.costs.installed())) return [];
      const any = await this.db('cloud_costs').first('id').catch(() => null);
      if (!any) return [];
      const t = await this.s().tenants.bySlug(this.s().cfg.DEFAULT_TENANT);
      return t ? [{ tenantId: t.id, payload: {} }] : [];
    });
  }
}
