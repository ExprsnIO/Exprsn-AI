import { actorFrom } from '../audit/chain.js';
import type { Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import type { Services } from '../services.js';

/*
 * 1.9.0, Sprint 50 (B-158): guardrail and moderation metrics, kept as aggregates per tenant and UTC day in
 * `moderation_metrics_daily` (no content, no ids of people):
 *
 * - `rule.hit` per rule (`<rule id>|<rule name>`) and `set.hit` per rule set: findings in recorded guardrail decisions,
 *   enforced or shadow, each rule once per decision;
 * - `decision` per effective action, with `action` per family: `block`, `redact`, `annotate` (log, warn, flag),
 *   `hold` (require-approval) and `allow`;
 * - `appeal.decided` and `appeal.upheld` per appeal kind: the false-positive rate is upheld over decided;
 * - `ttd` per queue (`flags`, `held`, `appeals`): decisions that day (`n`) and the milliseconds from filing to
 *   decision (`total`), so the mean time to decision is total over n;
 * - `spam.response` and `spam.lifted` per response kind.
 *
 * The job `moderation.metrics.rollup` rewrites today and yesterday every hour from the source tables; reading a trend
 * computes today afresh.
 */

export const ROLLUP_JOB = 'moderation.metrics.rollup';
const DAY = 86_400_000;
const PAGE = 2000;

export interface MetricRow {
  day: string;
  metric: string;
  dim: string;
  n: number;
  total: number;
}

export const dayOf = (t: number): string => new Date(t).toISOString().slice(0, 10);
const dayStart = (day: string): number => Date.parse(`${day}T00:00:00.000Z`);

const FAMILY: Record<string, string> = { block: 'block', redact: 'redact', log: 'annotate', warn: 'annotate', flag: 'annotate', 'require-approval': 'hold', allow: 'allow' };

export class ModerationMetrics {
  constructor(
    private readonly s: () => Services,
    private readonly now: () => number = Date.now
  ) {}

  private get db() {
    return this.s().db;
  }

  registerJobs(): void {
    this.s().jobs.register(ROLLUP_JOB, async (p, ctx) => {
      const tenantId = String(p.tenantId ?? ctx.job.tenant_id);
      const t = this.now();
      await this.rollup(tenantId, dayOf(t - DAY));
      await this.rollup(tenantId, dayOf(t));
    });
  }

  schedule(): void {
    const s = this.s();
    s.scheduler.every(ROLLUP_JOB, 3_600_000, async () => (await s.tenants.list()).filter((t) => t.state === 'active').map((t) => ({ tenantId: t.id, payload: { tenantId: t.id } })));
  }

  /** The aggregates of one day, computed from the source tables (nothing stored). */
  async compute(tenantId: string, day: string): Promise<MetricRow[]> {
    const from = dayStart(day);
    const to = from + DAY;
    const acc = new Map<string, MetricRow>();
    const add = (metric: string, dim: string, n = 1, total = 0) => {
      const d = dim.slice(0, 200);
      const k = `${metric}\u0000${d}`;
      const r = acc.get(k) ?? { day, metric, dim: d, n: 0, total: 0 };
      r.n += n;
      r.total += total;
      acc.set(k, r);
    };

    // Guardrail decisions, paged by id so a busy day is read in slices.
    let after = '';
    for (;;) {
      const rows = (await this.db('guard_decisions').where({ tenant_id: tenantId }).andWhere('created_at', '>=', from).andWhere('created_at', '<', to).andWhere('id', '>', after).orderBy('id').limit(PAGE).select('id', 'action', 'findings')) as { id: string; action: string; findings: unknown }[];
      for (const r of rows) {
        add('decision', r.action);
        add('action', FAMILY[r.action] ?? 'other');
        const seenRule = new Set<string>();
        const seenSet = new Set<string>();
        for (const f of json<{ ruleId?: string; ruleName?: string; setId?: string }[]>(r.findings, [])) {
          if (f.ruleId && !seenRule.has(f.ruleId)) {
            seenRule.add(f.ruleId);
            add('rule.hit', `${f.ruleId}|${f.ruleName ?? ''}`);
          }
          if (f.setId && !seenSet.has(f.setId)) {
            seenSet.add(f.setId);
            add('set.hit', f.setId);
          }
        }
      }
      if (rows.length < PAGE) break;
      after = rows[rows.length - 1]!.id;
    }

    const appeals = (await this.db('moderation_appeals').where({ tenant_id: tenantId }).whereIn('state', ['upheld', 'denied']).andWhere('decided_at', '>=', from).andWhere('decided_at', '<', to).select('kind', 'state', 'created_at', 'decided_at')) as { kind: string; state: string; created_at: number | string; decided_at: number | string }[];
    for (const a of appeals) {
      add('appeal.decided', a.kind);
      if (a.state === 'upheld') add('appeal.upheld', a.kind);
      add('ttd', 'appeals', 1, Math.max(0, Number(a.decided_at) - Number(a.created_at)));
    }
    const flags = (await this.db('guard_flags').where({ tenant_id: tenantId }).whereNotNull('decided_at').andWhere('decided_at', '>=', from).andWhere('decided_at', '<', to).select('created_at', 'decided_at')) as { created_at: number | string; decided_at: number | string }[];
    for (const f of flags) add('ttd', 'flags', 1, Math.max(0, Number(f.decided_at) - Number(f.created_at)));
    const held = (await this.db('held_writes').where({ tenant_id: tenantId }).whereNotNull('decided_at').andWhere('decided_at', '>=', from).andWhere('decided_at', '<', to).select('created_at', 'decided_at')) as { created_at: number | string; decided_at: number | string }[];
    for (const h of held) add('ttd', 'held', 1, Math.max(0, Number(h.decided_at) - Number(h.created_at)));

    const made = (await this.db('spam_responses').where({ tenant_id: tenantId }).andWhere('created_at', '>=', from).andWhere('created_at', '<', to).select('kind').catch(() => [])) as { kind: string }[];
    for (const r of made) add('spam.response', r.kind);
    const lifted = (await this.db('spam_responses').where({ tenant_id: tenantId, state: 'lifted' }).andWhere('lifted_at', '>=', from).andWhere('lifted_at', '<', to).select('kind').catch(() => [])) as { kind: string }[];
    for (const r of lifted) add('spam.lifted', r.kind);
    return [...acc.values()];
  }

  /** Rewrites one day's aggregates. */
  async rollup(tenantId: string, day: string): Promise<number> {
    const rows = await this.compute(tenantId, day);
    const t = this.now();
    await this.db.transaction(async (trx) => {
      await trx('moderation_metrics_daily').where({ tenant_id: tenantId, day }).delete();
      for (let i = 0; i < rows.length; i += 200) await trx('moderation_metrics_daily').insert(rows.slice(i, i + 200).map((r) => ({ tenant_id: tenantId, ...r, rolled_at: t })));
    });
    return rows.length;
  }

  /** The stored days of the range, with today computed afresh. */
  async rows(tenantId: string, days: number): Promise<MetricRow[]> {
    const today = dayOf(this.now());
    const first = dayOf(this.now() - (days - 1) * DAY);
    const stored = ((await this.db('moderation_metrics_daily').where({ tenant_id: tenantId }).andWhere('day', '>=', first).andWhere('day', '<', today).orderBy(['day', 'metric', 'dim'])) as Record<string, unknown>[]).map((r) => ({ day: String(r.day), metric: String(r.metric), dim: String(r.dim ?? ''), n: Number(r.n), total: Number(r.total) }));
    return [...stored, ...(await this.compute(tenantId, today))];
  }

  /** Trends for the Overview card and the Moderation screen. */
  async trend(p: Principal, days = 14) {
    const rows = await this.rows(p.tenantId, days);
    const series: Record<string, { day: string; decisions: number; block: number; redact: number; annotate: number; hold: number; appealsDecided: number; appealsUpheld: number; ttd: Record<string, { n: number; meanMs: number | null }>; spam: Record<string, number> }> = {};
    for (let i = days - 1; i >= 0; i--) {
      const day = dayOf(this.now() - i * DAY);
      series[day] = { day, decisions: 0, block: 0, redact: 0, annotate: 0, hold: 0, appealsDecided: 0, appealsUpheld: 0, ttd: {}, spam: {} };
    }
    const rules = new Map<string, number>();
    const sets = new Map<string, number>();
    const ttdAll: Record<string, { n: number; total: number }> = {};
    for (const r of rows) {
      const d = series[r.day];
      if (!d) continue;
      if (r.metric === 'decision') d.decisions += r.n;
      else if (r.metric === 'action' && (r.dim === 'block' || r.dim === 'redact' || r.dim === 'annotate' || r.dim === 'hold')) d[r.dim] += r.n;
      else if (r.metric === 'appeal.decided') d.appealsDecided += r.n;
      else if (r.metric === 'appeal.upheld') d.appealsUpheld += r.n;
      else if (r.metric === 'ttd') {
        d.ttd[r.dim] = { n: r.n, meanMs: r.n ? Math.round(r.total / r.n) : null };
        const a = (ttdAll[r.dim] ??= { n: 0, total: 0 });
        a.n += r.n;
        a.total += r.total;
      } else if (r.metric === 'spam.response') d.spam[r.dim] = (d.spam[r.dim] ?? 0) + r.n;
      else if (r.metric === 'rule.hit') rules.set(r.dim, (rules.get(r.dim) ?? 0) + r.n);
      else if (r.metric === 'set.hit') sets.set(r.dim, (sets.get(r.dim) ?? 0) + r.n);
    }
    const list = Object.values(series);
    const sum = (k: 'decisions' | 'block' | 'redact' | 'annotate' | 'hold' | 'appealsDecided' | 'appealsUpheld') => list.reduce((a, d) => a + d[k], 0);
    const decisions = sum('decisions');
    const decided = sum('appealsDecided');
    const setNames = new Map(((sets.size ? await this.db('guard_rule_sets').whereIn('id', [...sets.keys()]).select('id', 'name') : []) as { id: string; name: string }[]).map((x) => [x.id, x.name]));
    const spamTotals: Record<string, number> = {};
    for (const d of list) for (const [k, v] of Object.entries(d.spam)) spamTotals[k] = (spamTotals[k] ?? 0) + v;
    return {
      days,
      series: list,
      totals: {
        decisions,
        rates: { block: decisions ? sum('block') / decisions : 0, redact: decisions ? sum('redact') / decisions : 0, annotate: decisions ? sum('annotate') / decisions : 0, hold: decisions ? sum('hold') / decisions : 0 },
        appealsDecided: decided,
        appealsUpheld: sum('appealsUpheld'),
        falsePositiveRate: decided ? sum('appealsUpheld') / decided : null,
        timeToDecision: Object.fromEntries(Object.entries(ttdAll).map(([k, v]) => [k, { n: v.n, meanMs: v.n ? Math.round(v.total / v.n) : null }])),
        spamResponses: spamTotals
      },
      topRules: [...rules].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([dim, n]) => ({ ruleId: dim.split('|')[0], name: dim.slice(dim.indexOf('|') + 1) || null, hits: n })),
      topSets: [...sets].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, n]) => ({ setId: id, name: setNames.get(id) ?? null, hits: n }))
    };
  }

  /** The aggregates as CSV (`moderation.metrics.exported`). */
  async csv(p: Principal, days: number, ctx: { ip?: string | null; traceId?: string | null } = {}): Promise<string> {
    const rows = await this.rows(p.tenantId, days);
    const cell = (v: string | number) => {
      const s = String(v);
      // Spreadsheet formula injection: a cell starting with = + - @ is quoted as text.
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const lines = ['day,metric,dim,n,total', ...rows.map((r) => [r.day, r.metric, r.dim, r.n, r.total].map(cell).join(','))];
    await this.s().audit.append({ tenantId: p.tenantId, action: 'moderation.metrics.exported', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { metrics: 'moderation' }, label: 'internal', detail: { days, rows: rows.length, format: 'csv' }, traceId: ctx.traceId ?? null });
    return lines.join('\r\n') + '\r\n';
  }
}
