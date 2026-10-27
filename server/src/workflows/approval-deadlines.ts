import { z } from 'zod';
import type { Logger } from 'pino';
import { json, type Db } from '../db/knex.js';
import { clears, isLabel, type Label } from '../authz/labels.js';
import { isRole } from '../authz/permissions.js';
import type { AuditLog } from '../audit/chain.js';
import type { Notifications } from '../platform/notifications.js';
import type { Issue, WfEdge, WfGraph, WfNode } from './graph.js';

/*
 * Sprint 46 (B-133): approval deadlines, reminders, escalation and quorum.
 *
 * An Approval step may carry, beside its role and its hard `timeoutMs` (after which the approval expires and the step
 * fails, as before):
 *
 * - `due`: a soft due time, `afterMs` from when the step paused or `at`, a template read from the run's context (an
 *   ISO 8601 time or epoch milliseconds). It never lies past the hard timeout.
 * - `reminders`: up to five durations before the due time at which the assignees are reminded.
 * - `onBreach`: what happens at the due time: `notify` (the default: the assignees and the run's owner hear it is
 *   overdue), `escalate` to a role or a person (who may then decide too), `reject` automatically, `approve`
 *   automatically (only with `autoApprove: true` on the step, and published with a warning), or `timeout` (the step
 *   passes with `timedOut: true` and the run goes on along its `timeout` edges only).
 * - `quorum`: `any` (one decision, as before), `all` (every eligible approver, counted when the step paused), or
 *   `count` (N distinct approvers). A reject is `final` (one reject rejects) or `counted` (the approval is rejected once
 *   the approvals still possible cannot reach the quorum). One person counts once: votes are unique per approval and
 *   person in `workflow_approval_votes`.
 *
 * Everything is stored on the approval row (migration 088): `breach_at`, `reminder_times`, `reminders_sent`,
 * `escalated_*`, `breached_at`, `outcome` and `next_check_at`, the earliest moment the tick has something to do.
 * The tick (`workflow.approvals`, scheduled like the cron triggers and run on whichever instance takes the job) claims
 * each action with one conditional update, so every reminder, breach and expiry happens once across instances and
 * survives a restart. No in-process timer is involved.
 */

export const BREACH_ACTIONS = ['notify', 'escalate', 'reject', 'approve', 'timeout'] as const;
export type BreachAction = (typeof BREACH_ACTIONS)[number];
export const QUORUM_MODES = ['any', 'all', 'count'] as const;
export type QuorumMode = (typeof QUORUM_MODES)[number];
export const REJECT_MODES = ['final', 'counted'] as const;
export type RejectMode = (typeof REJECT_MODES)[number];

const MAX_MS = 7 * 24 * 3_600_000;
const userId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'a user id');

/** The fields B-133 adds to an Approval step's configuration (spread into its schema in graph.ts). */
export const APPROVAL_DEADLINE_FIELDS = {
  due: z
    .object({ afterMs: z.number().int().min(60_000).max(MAX_MS).optional(), at: z.string().max(2000).optional() })
    .strict()
    .optional(),
  reminders: z.array(z.number().int().min(60_000).max(MAX_MS)).max(5).optional(),
  onBreach: z
    .object({ action: z.enum(BREACH_ACTIONS), role: z.string().max(63).optional(), user: userId.optional() })
    .strict()
    .optional(),
  autoApprove: z.boolean().optional(),
  quorum: z
    .object({ mode: z.enum(QUORUM_MODES), count: z.number().int().min(1).max(50).optional(), rejects: z.enum(REJECT_MODES).default('final') })
    .strict()
    .optional()
};

export interface ApprovalDeadlineConfig {
  role: string;
  timeoutMs: number;
  form?: unknown;
  due?: { afterMs?: number | undefined; at?: string | undefined } | undefined;
  reminders?: number[] | undefined;
  onBreach?: { action: BreachAction; role?: string | undefined; user?: string | undefined } | undefined;
  autoApprove?: boolean | undefined;
  quorum?: { mode: QuorumMode; count?: number | undefined; rejects: RejectMode } | undefined;
}

/** `timeout` (B-133): the edge an Approval step takes when its due time passed and its `onBreach` is `timeout`. */
export const isTimeoutEdge = (e: Pick<WfEdge, 'branch'>): boolean => (e.branch as string | undefined) === 'timeout';

/** Publish checks for the deadline, reminder, breach and quorum options, and for `timeout` edges. */
export function approvalIssues(g: WfGraph): { errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const timeoutFrom = new Set(g.edges.filter(isTimeoutEdge).map((e) => e.from));
  for (const e of g.edges.filter(isTimeoutEdge)) {
    const from = byId.get(e.from);
    if (!from) continue;
    const c = from.config as Partial<ApprovalDeadlineConfig>;
    if (from.kind !== 'approval') errors.push({ code: 'structure', nodeId: e.from, edge: e, message: `Only an Approval step has a timeout edge; ${from.title} is a ${from.kind} step.` });
    else if (c.onBreach?.action !== 'timeout') errors.push({ code: 'structure', nodeId: e.from, edge: e, message: `${from.title} has a timeout edge but does not take it: set its breach action to timeout.` });
  }
  for (const n of g.nodes) {
    if (n.kind !== 'approval') continue;
    const c = n.config as Partial<ApprovalDeadlineConfig>;
    const err = (message: string) => errors.push({ code: 'config', nodeId: n.id, message: `${n.title}: ${message}` });
    const timeoutMs = typeof c.timeoutMs === 'number' ? c.timeoutMs : 24 * 3_600_000;
    if (c.due) {
      const has = (c.due.afterMs != null ? 1 : 0) + (c.due.at?.trim() ? 1 : 0);
      if (has !== 1) err('give the due time as a duration (afterMs) or as a time from the context (at), one of the two.');
      if (c.due.afterMs != null && c.due.afterMs > timeoutMs) err(`the due time (${minutes(c.due.afterMs)}) comes after the timeout (${minutes(timeoutMs)}); the approval would expire first.`);
      if (c.due.afterMs != null && c.due.afterMs === timeoutMs && c.onBreach?.action === 'escalate') err('an escalation needs time before the timeout: make the due time earlier than the timeout.');
    }
    if (c.reminders?.length) {
      if (!c.due) err('reminders come before a due time; set one.');
      else if (c.due.afterMs != null) for (const r of c.reminders) if (r >= c.due.afterMs) err(`a reminder ${minutes(r)} before the due time would come before the step even pauses.`);
      if (new Set(c.reminders).size !== c.reminders.length) err('two reminders are at the same time.');
    }
    if (c.onBreach) {
      if (!c.due) err('a breach action needs a due time.');
      const a = c.onBreach.action;
      if (a === 'escalate') {
        if (!c.onBreach.role && !c.onBreach.user) err('choose the role or the person the approval escalates to.');
        if (c.onBreach.role && c.onBreach.user) err('escalate to a role or to a person, not both.');
        if (c.onBreach.role && !isRole(c.onBreach.role)) err(`there is no role ${c.onBreach.role}.`);
        if (c.onBreach.role && c.onBreach.role === c.role) err('it escalates to the role that already decides.');
      } else if (c.onBreach.role || c.onBreach.user) err(`a ${a} breach action takes no role or person.`);
      if (a === 'approve') {
        if (c.autoApprove !== true) err('approving automatically at the due time must be allowed explicitly on the step (autoApprove).');
        else warnings.push({ code: 'config', nodeId: n.id, message: `${n.title} approves automatically when nobody decides by its due time: what follows runs without a person's decision.` });
      }
      if (a === 'timeout' && !timeoutFrom.has(n.id)) err('its breach action is timeout, but it has no timeout edge to take.');
    }
    if (c.autoApprove && c.onBreach?.action !== 'approve') warnings.push({ code: 'config', nodeId: n.id, message: `${n.title} allows approving automatically but its breach action is not approve; the setting does nothing.` });
    if (c.quorum) {
      if (c.quorum.mode === 'count' && c.quorum.count == null) err('a quorum of N approvers needs N (count).');
      if (c.quorum.mode !== 'count' && c.quorum.count != null) err('only the count quorum takes a count.');
      if (c.quorum.mode !== 'any' && c.form) err('an approval form works with the quorum any: one approver fills it in.');
      if (c.quorum.mode !== 'any' && c.onBreach?.action === 'approve') err('a quorum of several approvers cannot be approved automatically.');
    }
  }
  return { errors, warnings };
}

const minutes = (ms: number): string => (ms % 3_600_000 === 0 ? `${ms / 3_600_000} h` : `${Math.round(ms / 60_000)} min`);

/** What an Approval step's options make of one pause: the soft due time, reminder times and quorum. */
export interface ApprovalPlan {
  breachAt: number | null;
  reminderTimes: number[];
  onBreach: { action: BreachAction; role?: string | undefined; user?: string | undefined } | null;
  quorum: QuorumMode;
  rejects: RejectMode;
  /** N for `count`; for `all`, the eligible approvers counted now (at least 1). */
  required: number;
  eligible: string[];
  /** A due time read from the context that could not be used. */
  warning: string | null;
}

/** Reads `at` (an ISO 8601 time or epoch milliseconds) as a time, or null. */
export function readTime(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    if (/^\d{10,16}$/.test(v.trim())) return Number(v.trim());
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

export function planApproval(cfg: ApprovalDeadlineConfig, now: number, hardDue: number, rendered: unknown, eligible: string[], dry: boolean): ApprovalPlan {
  let breachAt: number | null = null;
  let warning: string | null = null;
  if (cfg.due?.afterMs != null) breachAt = now + cfg.due.afterMs;
  else if (cfg.due?.at) {
    const t = readTime(rendered);
    if (t == null) warning = 'The due time read from the context is not a time; the approval has no due time, only its timeout.';
    else breachAt = Math.max(now, t);
  }
  if (breachAt != null) breachAt = Math.min(breachAt, hardDue);
  const reminderTimes = breachAt != null ? [...new Set((cfg.reminders ?? []).map((r) => breachAt! - r).filter((t) => t > now))].sort((a, b) => a - b) : [];
  // A dry run has one approver, whoever started it: its quorum is any.
  const quorum: QuorumMode = dry ? 'any' : (cfg.quorum?.mode ?? 'any');
  const required = quorum === 'count' ? (cfg.quorum?.count ?? 1) : quorum === 'all' ? Math.max(1, eligible.length) : 1;
  return { breachAt, reminderTimes, onBreach: breachAt != null ? (cfg.onBreach ?? { action: 'notify' }) : null, quorum, rejects: cfg.quorum?.rejects ?? 'final', required, eligible, warning };
}

export interface Votes {
  approve: number;
  reject: number;
}

/**
 * The outcome of the votes so far. `eligible` is the number of approvers counted when the step paused (never below
 * the quorum): with counted rejects the approval fails once the approvals still possible cannot reach the quorum.
 */
export function tally(v: Votes, q: { quorum: QuorumMode; required: number; rejects: RejectMode; eligible: number }): 'approved' | 'rejected' | 'pending' {
  if (q.quorum === 'any') return v.reject > 0 ? 'rejected' : v.approve > 0 ? 'approved' : 'pending';
  if (v.reject > 0 && q.rejects === 'final') return 'rejected';
  if (v.approve >= q.required) return 'approved';
  const m = Math.max(q.eligible, q.required);
  if (m - v.reject < q.required) return 'rejected';
  return 'pending';
}

/** The approval columns the tick reads. */
export interface DeadlineRow {
  id: string;
  tenant_id: string;
  run_id: string;
  node_id: string;
  role: string;
  state: string;
  due_at: number;
  breach_at: number | null;
  reminder_times: number[];
  reminders_sent: number;
  on_breach: { action: BreachAction; role?: string; user?: string } | null;
  breached_at: number | null;
  escalated_role: string | null;
  escalated_user: string | null;
}

export const deadlineFrom = (r: Record<string, unknown>): DeadlineRow => ({
  id: String(r.id),
  tenant_id: String(r.tenant_id),
  run_id: String(r.run_id),
  node_id: String(r.node_id),
  role: String(r.role),
  state: String(r.state),
  due_at: Number(r.due_at),
  breach_at: r.breach_at == null ? null : Number(r.breach_at),
  reminder_times: json<number[]>(r.reminder_times, []).map(Number),
  reminders_sent: Number(r.reminders_sent ?? 0),
  on_breach: json<DeadlineRow['on_breach']>(r.on_breach, null),
  breached_at: r.breached_at == null ? null : Number(r.breached_at),
  escalated_role: (r.escalated_role as string | null) ?? null,
  escalated_user: (r.escalated_user as string | null) ?? null
});

/** The earliest moment the tick has something to do for this approval. */
export function nextCheck(a: Pick<DeadlineRow, 'due_at' | 'breach_at' | 'breached_at' | 'reminder_times' | 'reminders_sent'>): number {
  const times = [a.due_at];
  if (a.breach_at != null && a.breached_at == null) {
    times.push(a.breach_at);
    const next = a.reminder_times[a.reminders_sent];
    if (next != null) times.push(next);
  }
  return Math.min(...times);
}

/** What the tick needs from the workflow service. */
export interface ApprovalHost {
  db: Db;
  audit: AuditLog;
  notifications: Notifications;
  log: Logger;
  run(runId: string): Promise<{ id: string; tenant_id: string; workflow_id: string; label: Label; mode: string; created_by: string; state: string } | undefined>;
  stepTitle(runId: string, nodeId: string): Promise<string>;
  workflowName(workflowId: string): Promise<string | null>;
  /** Decides the approval by its deadline (no person): approved, rejected, or timed out down its timeout edges. */
  settle(approvalId: string, outcome: 'approved' | 'rejected' | 'timed-out'): Promise<boolean>;
  /** Expires it at its hard timeout (the step fails, as before B-133). */
  expire(approvalId: string): Promise<unknown>;
  /** Tells the run's approvers, live, that the approval changed. */
  changed(runId: string, approvalId: string, data: Record<string, unknown>): Promise<void>;
}

/** The people an approval waits on: holders of its role (or of the role it escalated to), and the person it escalated to. */
export async function assigneesOf(db: Db, a: Pick<DeadlineRow, 'tenant_id' | 'role' | 'escalated_role' | 'escalated_user'>, label: Label): Promise<string[]> {
  const roles = [a.role, ...(a.escalated_role ? [a.escalated_role] : [])];
  const rows = (await db('users as u').join('user_roles as r', 'r.user_id', 'u.id').where({ 'u.tenant_id': a.tenant_id, 'u.state': 'active' }).whereIn('r.role', roles).distinct('u.id', 'u.clearance')) as { id: string; clearance: string }[];
  const ids = rows.filter((u) => isLabel(u.clearance) && clears(u.clearance, label)).map((u) => u.id);
  if (a.escalated_user) {
    const u = (await db('users').where({ tenant_id: a.tenant_id, id: a.escalated_user, state: 'active' }).first('id', 'clearance')) as { id: string; clearance: string } | undefined;
    if (u && isLabel(u.clearance) && clears(u.clearance, label)) ids.push(u.id);
  }
  return [...new Set(ids)];
}

/** The scheduled tick over approval deadlines (B-133). */
export class ApprovalDeadlines {
  constructor(private readonly h: ApprovalHost) {}

  async tick(now = Date.now(), limit = 200): Promise<{ reminded: number; breached: number; expired: number }> {
    const rows = ((await this.h.db('workflow_approvals').where({ state: 'pending' }).whereNotNull('next_check_at').andWhere('next_check_at', '<=', now).orderBy('next_check_at').limit(limit)) as Record<string, unknown>[]).map(deadlineFrom);
    const out = { reminded: 0, breached: 0, expired: 0 };
    for (const a of rows) {
      try {
        const r = await this.check(a, now);
        out.reminded += r.reminded;
        out.breached += r.breached;
        out.expired += r.expired;
      } catch (err) {
        this.h.log.warn({ err, approval: a.id }, 'approval deadline check failed');
      }
    }
    return out;
  }

  private async check(a: DeadlineRow, now: number): Promise<{ reminded: number; breached: number; expired: number }> {
    const db = this.h.db;
    const out = { reminded: 0, breached: 0, expired: 0 };
    const run = await this.h.run(a.run_id);
    if (!run) return out;
    // Reminders before the due time: only the latest one due is sent (a tick that was late does not send a burst).
    if (a.breach_at != null && a.breached_at == null && a.breach_at > now) {
      let next = a.reminders_sent;
      while (next < a.reminder_times.length && a.reminder_times[next]! <= now) next++;
      if (next > a.reminders_sent) {
        const n = await db('workflow_approvals').where({ id: a.id, state: 'pending', reminders_sent: a.reminders_sent }).update({ reminders_sent: next });
        if (n === 1) {
          a.reminders_sent = next;
          out.reminded++;
          await this.remind(a, run, now);
        }
      }
    }
    if (a.breach_at != null && a.breached_at == null && a.breach_at <= now) {
      const n = await db('workflow_approvals').where({ id: a.id, state: 'pending' }).whereNull('breached_at').update({ breached_at: now, reminders_sent: a.reminder_times.length });
      if (n === 1) {
        a.breached_at = now;
        a.reminders_sent = a.reminder_times.length;
        out.breached++;
        await this.breach(a, run, now);
      }
    }
    const fresh = (await db('workflow_approvals').where({ id: a.id }).first('state', 'due_at')) as { state: string; due_at: number } | undefined;
    if (fresh?.state === 'pending' && Number(fresh.due_at) <= now) {
      const r = (await this.h.expire(a.id)) as { expired?: string } | undefined;
      if (r?.expired) {
        out.expired++;
        await this.audit(a, run, 'workflow.approval.expired', { dueAt: a.due_at });
      }
    }
    await db('workflow_approvals').where({ id: a.id, state: 'pending' }).update({ next_check_at: nextCheck(a) });
    return out;
  }

  private async audit(a: DeadlineRow, run: { workflow_id: string; label: Label }, action: string, detail: Record<string, unknown>): Promise<void> {
    await this.h.audit.append({ tenantId: a.tenant_id, action, kind: 'system', actor: { service: 'workflows' }, target: { workflow: run.workflow_id, run: a.run_id, approval: a.id, node: a.node_id }, label: run.label, detail });
  }

  private async tell(a: DeadlineRow, run: { workflow_id: string; label: Label; mode: string; created_by: string }, userIds: string[], title: string, body: string, email = true): Promise<void> {
    if (run.mode !== 'run' || !userIds.length) return;
    await this.h.notifications.notify({ tenantId: a.tenant_id, userIds, kind: 'workflow', title, body, route: 'workflows', label: run.label, email });
  }

  private async remind(a: DeadlineRow, run: NonNullable<Awaited<ReturnType<ApprovalHost['run']>>>, now: number): Promise<void> {
    const name = (await this.h.workflowName(run.workflow_id)) ?? 'A workflow';
    const step = await this.h.stepTitle(a.run_id, a.node_id);
    const who = (await assigneesOf(this.h.db, a, run.label)).filter((u) => u !== run.created_by);
    const left = Math.max(1, Math.round((a.breach_at! - now) / 60_000));
    await this.tell(a, run, who, 'Workflow approval due soon', `${name}, step ${step} is due in ${left < 120 ? `${left} min` : `${Math.round(left / 60)} h`}.`);
    await this.audit(a, run, 'workflow.approval.reminded', { reminder: a.reminders_sent, of: a.reminder_times.length, dueAt: a.breach_at, notified: who.length });
    await this.h.changed(a.run_id, a.id, { reminded: a.reminders_sent });
  }

  private async breach(a: DeadlineRow, run: NonNullable<Awaited<ReturnType<ApprovalHost['run']>>>, now: number): Promise<void> {
    const name = (await this.h.workflowName(run.workflow_id)) ?? 'A workflow';
    const step = await this.h.stepTitle(a.run_id, a.node_id);
    const action = a.on_breach?.action ?? 'notify';
    if (action === 'escalate') {
      const role = a.on_breach?.role ?? null;
      const user = a.on_breach?.user ?? null;
      await this.h.db('workflow_approvals').where({ id: a.id, state: 'pending' }).update({ escalated_role: role, escalated_user: user, escalated_at: now, outcome: 'escalated' });
      a.escalated_role = role;
      a.escalated_user = user;
      const to = await assigneesOf(this.h.db, { tenant_id: a.tenant_id, role: role ?? '\u0000', escalated_role: null, escalated_user: user }, run.label);
      await this.tell(a, run, to.filter((u) => u !== run.created_by), 'Workflow approval escalated to you', `${name}, step ${step} passed its due time and now waits on ${role ? `the ${role} role` : 'you'} too.`);
      await this.audit(a, run, 'workflow.approval.escalated', { to: role ? { role } : { user }, dueAt: a.breach_at, notified: to.length });
      await this.h.changed(a.run_id, a.id, { escalated: role ? { role } : { user } });
      return;
    }
    if (action === 'reject' || action === 'approve' || action === 'timeout') {
      const outcome = action === 'reject' ? 'rejected' : action === 'approve' ? 'approved' : 'timed-out';
      const done = await this.h.settle(a.id, outcome);
      if (done) {
        await this.audit(a, run, action === 'reject' ? 'workflow.approval.auto-rejected' : action === 'approve' ? 'workflow.approval.auto-approved' : 'workflow.approval.timed-out', { dueAt: a.breach_at });
        return;
      }
      // Not settled (decided meanwhile, or an automatic approval the run's graph does not allow): only tell people.
      const now2 = (await this.h.db('workflow_approvals').where({ id: a.id }).first('state')) as { state: string } | undefined;
      if (now2?.state !== 'pending') return;
    }
    const who = (await assigneesOf(this.h.db, a, run.label)).filter((u) => u !== run.created_by);
    await this.tell(a, run, [...who, run.created_by], 'Workflow approval overdue', `${name}, step ${step} passed its due time without a decision.`);
    await this.audit(a, run, 'workflow.approval.overdue', { dueAt: a.breach_at, notified: who.length });
    await this.h.db('workflow_approvals').where({ id: a.id, state: 'pending' }).update({ outcome: 'overdue' });
    await this.h.changed(a.run_id, a.id, { overdue: true });
  }
}

/** Eligible approvers when a step pauses: active holders of the role, cleared for the run's label. */
export async function eligibleApprovers(db: Db, tenantId: string, role: string, label: Label): Promise<string[]> {
  return assigneesOf(db, { tenant_id: tenantId, role, escalated_role: null, escalated_user: null }, label);
}

export type { WfNode };
