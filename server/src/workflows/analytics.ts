import type { Knex } from 'knex';
import { z } from 'zod';
import { clears, LABELS, type Label } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { json, type Db } from '../db/knex.js';
import { badRequest } from '../http/problem.js';
import type { Services } from '../services.js';
import type { WfGraph } from './graph.js';

/*
 * 1.8.0, Sprint 47 (B-139): workflow analytics and the tenant's "running now" board.
 *
 * Every figure is a SQL aggregate over `workflow_runs` (and `workflow_steps` for the slowest steps), bounded by a date
 * range on `created_at` and served by the indexes `(tenant_id, workflow_id, created_at)`, `(tenant_id, created_at)`
 * and `(tenant_id, state)` (migration 095). Percentiles are one ordered row each (`LIMIT 1 OFFSET k`), and days are
 * UTC days (`created_at - created_at % 86400000`), which all three dialects compute alike.
 *
 * Who sees what follows the run history (`WorkflowService.runs`): only workflows the viewer may open (their
 * workspace's and the tenant's own, at or below their clearance), only runs at or below their clearance, and, unless
 * they hold `workflows:manage`, only the runs they started. Dry runs are left out unless asked for.
 */

const DAY = 86_400_000;
const FINISHED = ['succeeded', 'failed', 'rejected', 'cancelled'] as const;
const ACTIVE = ['queued', 'running', 'waiting'] as const;
const DAY_EXPR = `(created_at - (created_at % ${DAY}))`;

export const rangeSchema = z
  .object({
    from: z.coerce.number().int().min(0).optional(),
    to: z.coerce.number().int().min(0).optional(),
    days: z.coerce.number().int().min(1).max(366).optional(),
    dry: z.enum(['true', 'false']).optional()
  })
  .strict();
export type RangeQuery = z.infer<typeof rangeSchema>;

const n = (v: unknown) => (v == null ? 0 : Number(v));
const nOrNull = (v: unknown) => (v == null ? null : Math.round(Number(v)));
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface Range {
  from: number;
  to: number;
  dry: boolean;
}

/** The range asked for: `from`/`to` (ms), or the last `days` (30 by default), at most 366 days. */
export function rangeOf(q: RangeQuery, now = Date.now()): Range {
  const to = q.to ?? now;
  const from = q.from ?? to - (q.days ?? 30) * DAY;
  if (from >= to) throw badRequest('The range starts after it ends: give a from earlier than to.');
  if (to - from > 366 * DAY) throw badRequest('The range is longer than 366 days; choose a shorter one.');
  return { from, to, dry: q.dry === 'true' };
}

export class WorkflowAnalytics {
  constructor(private readonly s: () => Services) {}

  private get db(): Db {
    return this.s().db;
  }

  private cleared(p: Principal): Label[] {
    return LABELS.filter((l) => clears(p.clearance, l));
  }

  /** Runs of the given workflows the viewer may count, in the range. */
  private runs(p: Principal, workflowIds: string[], r: Range, alias = '') {
    const c = (col: string) => (alias ? `${alias}.${col}` : col);
    return (q: Knex.QueryBuilder) => {
      q.where(c('tenant_id'), p.tenantId).whereIn(c('workflow_id'), workflowIds).whereIn(c('label'), this.cleared(p)).andWhere(c('created_at'), '>=', r.from).andWhere(c('created_at'), '<', r.to);
      if (!r.dry) q.andWhere(c('mode'), 'run');
      if (!effectivePermissions(p).has('workflows:manage')) q.andWhere(c('created_by'), p.userId);
      return q;
    };
  }

  /** The p-th percentile of finished runs' durations: one ordered row. */
  private async percentile(where: (q: Knex.QueryBuilder) => Knex.QueryBuilder, count: number, pct: number): Promise<number | null> {
    if (!count) return null;
    const k = Math.min(count - 1, Math.max(0, Math.ceil(pct * count) - 1));
    const row = (await where(this.db('workflow_runs')).whereIn('state', FINISHED).whereNotNull('started_at').whereNotNull('finished_at').select(this.db.raw('(finished_at - started_at) as d')).orderByRaw('(finished_at - started_at) asc').limit(1).offset(k).first()) as { d: unknown } | undefined;
    return row ? nOrNull(row.d) : null;
  }

  /** Counts by outcome, success rate, p50 and p95 duration of the runs `where` selects. */
  private async outcome(where: (q: Knex.QueryBuilder) => Knex.QueryBuilder) {
    const rows = (await where(this.db('workflow_runs')).select('state').count({ c: '*' }).groupBy('state')) as { state: string; c: unknown }[];
    const counts: Record<string, number> = { queued: 0, running: 0, waiting: 0, succeeded: 0, failed: 0, rejected: 0, cancelled: 0 };
    for (const x of rows) counts[x.state] = n(x.c);
    const finished = FINISHED.reduce((a, k) => a + (counts[k] ?? 0), 0);
    const timed = (await where(this.db('workflow_runs')).whereIn('state', FINISHED).whereNotNull('started_at').whereNotNull('finished_at').count({ c: '*' }).avg({ a: this.db.raw('(finished_at - started_at)') }).first()) as { c: unknown; a: unknown } | undefined;
    const tn = n(timed?.c);
    return {
      runs: Object.values(counts).reduce((a, b) => a + b, 0),
      counts,
      finished,
      successRate: finished ? Math.round((counts.succeeded! / finished) * 1000) / 1000 : null,
      duration: { measured: tn, avgMs: nOrNull(timed?.a), p50Ms: await this.percentile(where, tn, 0.5), p95Ms: await this.percentile(where, tn, 0.95) }
    };
  }

  /** Runs and outcomes by UTC day over the range, every day present. */
  private async trend(where: (q: Knex.QueryBuilder) => Knex.QueryBuilder, r: Range) {
    const rows = (await where(this.db('workflow_runs')).select(this.db.raw(`${DAY_EXPR} as day`), 'state').count({ c: '*' }).avg({ a: this.db.raw('(finished_at - started_at)') }).groupByRaw(`${DAY_EXPR}, state`)) as { day: unknown; state: string; c: unknown; a: unknown }[];
    const days = new Map<number, { runs: number; succeeded: number; failed: number; other: number; durSum: number; durN: number }>();
    for (let d = r.from - (r.from % DAY); d < r.to; d += DAY) days.set(d, { runs: 0, succeeded: 0, failed: 0, other: 0, durSum: 0, durN: 0 });
    for (const x of rows) {
      const d = days.get(n(x.day));
      if (!d) continue;
      const c = n(x.c);
      d.runs += c;
      if (x.state === 'succeeded') d.succeeded += c;
      else if (x.state === 'failed' || x.state === 'rejected') d.failed += c;
      else d.other += c;
      if (x.a != null && (FINISHED as readonly string[]).includes(x.state)) {
        d.durSum += Number(x.a) * c;
        d.durN += c;
      }
    }
    return [...days.entries()].map(([day, d]) => ({ day, date: isoDay(day), runs: d.runs, succeeded: d.succeeded, failed: d.failed, other: d.other, successRate: d.succeeded + d.failed ? Math.round((d.succeeded / (d.succeeded + d.failed)) * 1000) / 1000 : null, avgMs: d.durN ? Math.round(d.durSum / d.durN) : null }));
  }

  /** One workflow's metrics over the range. */
  async workflow(p: Principal, ref: string, q: RangeQuery) {
    const s = this.s();
    const w = await s.workflows.workflow(p, ref);
    const r = rangeOf(q);
    const where = this.runs(p, [w.id], r);
    const sum = await this.outcome(where);
    // Step titles from the published version (or the draft).
    const g = w.published_version ? ((await this.db('workflow_versions').where({ workflow_id: w.id, version: w.published_version }).first('graph')) as { graph: string } | undefined) : undefined;
    const graph = json<WfGraph>(g?.graph ?? w.draft, { nodes: [], edges: [], limits: {} });
    const title = (id: string) => graph.nodes.find((x) => x.id === id)?.title ?? id;
    const kind = (id: string) => graph.nodes.find((x) => x.id === id)?.kind ?? null;
    const runsIn = this.runs(p, [w.id], r, 'r');
    const stepRows = (await runsIn(this.db('workflow_steps as s').join('workflow_runs as r', 'r.id', 's.run_id')).whereNotNull('s.started_at').whereNotNull('s.finished_at').whereIn('s.state', ['passed', 'failed']).select('s.node_id').count({ c: '*' }).avg({ a: this.db.raw('(s.finished_at - s.started_at)') }).max({ m: this.db.raw('(s.finished_at - s.started_at)') }).groupBy('s.node_id').orderByRaw('avg(s.finished_at - s.started_at) desc').limit(5)) as { node_id: string; c: unknown; a: unknown; m: unknown }[];
    const failing = (await runsIn(this.db('workflow_steps as s').join('workflow_runs as r', 'r.id', 's.run_id')).where('s.state', 'failed').select('s.node_id').count({ c: '*' }).groupBy('s.node_id').orderByRaw('count(*) desc').limit(5)) as { node_id: string; c: unknown }[];
    const reasons = (await where(this.db('workflow_runs')).whereIn('state', ['failed', 'rejected']).select('error', 'state').count({ c: '*' }).max({ last: 'created_at' }).groupBy('error', 'state').orderByRaw('count(*) desc').limit(5)) as { error: string | null; state: string; c: unknown; last: unknown }[];
    return {
      workflowId: w.id,
      name: w.name,
      label: w.label,
      range: { from: r.from, to: r.to, dry: r.dry },
      scope: effectivePermissions(p).has('workflows:manage') ? 'all runs' : 'your runs',
      ...sum,
      slowestSteps: stepRows.map((x) => ({ nodeId: x.node_id, title: title(x.node_id), kind: kind(x.node_id), runs: n(x.c), avgMs: nOrNull(x.a), maxMs: nOrNull(x.m) })),
      failingSteps: failing.map((x) => ({ nodeId: x.node_id, title: title(x.node_id), failures: n(x.c) })),
      failureReasons: reasons.map((x) => ({ reason: x.error ? x.error.slice(0, 300) : x.state === 'rejected' ? 'Rejected by an approver' : 'No reason recorded', state: x.state, runs: n(x.c), lastAt: nOrNull(x.last) })),
      trend: await this.trend(where, r)
    };
  }

  /** The tenant's workflows the viewer may open, with counts, success rate and average duration over the range. */
  async summary(p: Principal, q: RangeQuery) {
    const s = this.s();
    const visible = (await s.workflows.list(p)) as { id: string; name: string; label: Label; publishedVersion: number | null; workspaceId: string | null }[];
    const r = rangeOf(q);
    const ids = visible.map((w) => w.id);
    const where = this.runs(p, ids.length ? ids : ['-'], r);
    const per = (await where(this.db('workflow_runs')).select('workflow_id', 'state').count({ c: '*' }).avg({ a: this.db.raw('(finished_at - started_at)') }).groupBy('workflow_id', 'state')) as { workflow_id: string; state: string; c: unknown; a: unknown }[];
    const rows = visible.map((w) => {
      const mine = per.filter((x) => x.workflow_id === w.id);
      const count = (st: string) => n(mine.find((x) => x.state === st)?.c);
      const finished = FINISHED.reduce((a, k) => a + count(k), 0);
      const timed = mine.filter((x) => (FINISHED as readonly string[]).includes(x.state) && x.a != null);
      const tn = timed.reduce((a, x) => a + n(x.c), 0);
      return { workflowId: w.id, name: w.name, label: w.label, publishedVersion: w.publishedVersion, runs: mine.reduce((a, x) => a + n(x.c), 0), succeeded: count('succeeded'), failed: count('failed') + count('rejected'), active: ACTIVE.reduce((a, k) => a + count(k), 0), successRate: finished ? Math.round((count('succeeded') / finished) * 1000) / 1000 : null, avgMs: tn ? Math.round(timed.reduce((a, x) => a + Number(x.a) * n(x.c), 0) / tn) : null };
    });
    return { range: { from: r.from, to: r.to, dry: r.dry }, scope: effectivePermissions(p).has('workflows:manage') ? 'all runs' : 'your runs', ...(await this.outcome(where)), workflows: rows.sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name)), trend: await this.trend(where, r) };
  }

  /** Runs queued, running or waiting now (approval, wait, retry or a child), with age, current step and owner. */
  async running(p: Principal, q: { limit?: number; workflow?: string } = {}) {
    const s = this.s();
    const visible = (await s.workflows.list(p)) as { id: string; name: string; label: Label }[];
    const names = new Map(visible.map((w) => [w.id, w]));
    const ids = q.workflow ? visible.filter((w) => w.id === q.workflow || w.name === q.workflow).map((w) => w.id) : visible.map((w) => w.id);
    const now = Date.now();
    const base = this.db('workflow_runs').where({ tenant_id: p.tenantId }).whereIn('state', ACTIVE).whereIn('workflow_id', ids.length ? ids : ['-']).whereIn('label', this.cleared(p));
    if (!effectivePermissions(p).has('workflows:manage')) base.andWhere({ created_by: p.userId });
    const counts = (await base.clone().select('state').count({ c: '*' }).groupBy('state')) as { state: string; c: unknown }[];
    const runs = (await base.clone().orderBy('created_at', 'asc').limit(q.limit ?? 100).select('id', 'workflow_id', 'version', 'mode', 'state', 'label', 'trigger', 'created_by', 'created_at', 'started_at', 'graph', 'error')) as { id: string; workflow_id: string; version: number | null; mode: string; state: string; label: Label; trigger: string; created_by: string; created_at: unknown; started_at: unknown; graph: string; error: string | null }[];
    const runIds = runs.map((r) => r.id);
    const steps = runIds.length ? ((await this.db('workflow_steps').whereIn('run_id', runIds).whereIn('state', ['running', 'waiting', 'blocked']).select('run_id', 'node_id', 'state', 'started_at', 'resume_at', 'detail')) as { run_id: string; node_id: string; state: string; started_at: unknown; resume_at: unknown; detail: string | null }[]) : [];
    const approvals = runIds.length ? ((await this.db('workflow_approvals').whereIn('run_id', runIds).where({ state: 'pending' }).select('run_id', 'node_id', 'role', 'due_at', 'breach_at', 'escalated_role')) as { run_id: string; node_id: string; role: string; due_at: unknown; breach_at: unknown; escalated_role: string | null }[]) : [];
    const users = runs.length ? ((await this.db('users').whereIn('id', [...new Set(runs.map((r) => r.created_by))]).select('id', 'display_name', 'username')) as { id: string; display_name: string | null; username: string }[]) : [];
    const items = runs.map((r) => {
      const graph = json<WfGraph>(r.graph, { nodes: [], edges: [], limits: {} });
      const mine = steps.filter((x) => x.run_id === r.id).sort((a, b) => n(b.started_at) - n(a.started_at));
      const cur = mine[0];
      const node = cur ? graph.nodes.find((x) => x.id === cur.node_id) : undefined;
      const appr = approvals.find((a) => a.run_id === r.id);
      const detail = cur ? json<{ retryAt?: number }>(cur.detail, {}) : {};
      const waitingOn = r.state !== 'waiting' ? null : appr ? 'approval' : node?.kind === 'wait' ? 'wait' : detail.retryAt != null ? 'retry' : node && ['sub', 'agent', 'map', 'loop'].includes(node.kind) ? 'child' : cur ? 'step' : 'resume';
      const u = users.find((x) => x.id === r.created_by);
      const created = n(r.created_at);
      return {
        runId: r.id,
        workflowId: r.workflow_id,
        workflow: names.get(r.workflow_id)?.name ?? r.workflow_id,
        version: r.version,
        mode: r.mode,
        state: r.state,
        label: r.label,
        trigger: r.trigger.split(':')[0],
        waitingOn,
        step: cur ? { id: cur.node_id, title: node?.title ?? cur.node_id, kind: node?.kind ?? null, state: cur.state, since: nOrNull(cur.started_at) } : null,
        approval: appr ? { role: appr.escalated_role ?? appr.role, dueAt: nOrNull(appr.breach_at) ?? nOrNull(appr.due_at), expiresAt: nOrNull(appr.due_at) } : null,
        resumeAt: cur ? (nOrNull(cur.resume_at) ?? (detail.retryAt != null ? Number(detail.retryAt) : null)) : null,
        ageMs: now - created,
        createdAt: created,
        startedAt: nOrNull(r.started_at),
        owner: { id: r.created_by, name: u ? u.display_name || u.username : null }
      };
    });
    const c: Record<string, number> = { queued: 0, running: 0, waiting: 0 };
    for (const x of counts) c[x.state] = n(x.c);
    return { at: now, scope: effectivePermissions(p).has('workflows:manage') ? 'all runs' : 'your runs', counts: c, total: c.queued! + c.running! + c.waiting!, items };
  }
}
