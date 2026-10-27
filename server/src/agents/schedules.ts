import { ulid } from 'ulid';
import { clears, type Label } from '../authz/labels.js';
import { authorize, effectivePermissions, type Principal } from '../authz/policy.js';
import { PLATFORM_TENANT } from '../audit/chain.js';
import { json } from '../db/knex.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { loadPrincipal, workspacesFor } from '../http/middleware.js';
import type { Scheduler } from '../platform/jobs.js';
import type { AgentBudgets } from '../registry/service.js';
import { describeCron, nextCron, parseCron } from '../training/calendar.js';
import type { Services } from '../services.js';

/*
 * Scheduled agent runs (B-1306). A schedule belongs to a user: an agent, a five-field UTC cron expression (the
 * training calendar's parser), the request, a label and budgets. When it is due, the run starts as the owner with the
 * roles, clearance and workspace memberships they hold at that moment, never with authority the schedule saved: a
 * disabled owner, one who lost `agents:run`, left the workspace, or can no longer run the agent at that label gets a
 * skip in the schedule's history instead of a run. Firing is claimed with one conditional update per due time, so
 * several instances never start the same run twice.
 */

export interface ScheduleRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  owner_id: string;
  name: string;
  agent: string;
  cron: string;
  input: string;
  label: Label;
  budgets: string | null;
  enabled: boolean;
  next_run_at: number | null;
  last_run_at: number | null;
  last_run_id: string | null;
  last_result: string | null;
  created_at: number;
  updated_at: number;
}

const num = (v: unknown) => (v == null ? null : Number(v));
const fromRow = (r: Record<string, unknown>): ScheduleRow => ({ ...(r as unknown as ScheduleRow), enabled: !!r.enabled, next_run_at: num(r.next_run_at), last_run_at: num(r.last_run_at), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });

export interface ScheduleInput {
  name: string;
  agent: string;
  cron: string;
  input: string;
  label: Label;
  budgets?: Partial<AgentBudgets>;
  enabled?: boolean;
}

export class AgentSchedules {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  registerJobs(): void {
    this.s().jobs.register('agents.schedules', async () => this.tick(), { timeoutMs: 10 * 60_000 });
  }

  /** One tick across tenants, every AGENT_SCHEDULE_TICK_SECONDS. */
  schedule(scheduler: Scheduler): void {
    scheduler.every('agents.schedules', this.s().cfg.AGENT_SCHEDULE_TICK_SECONDS * 1000, async () => [{ tenantId: PLATFORM_TENANT, key: 'all' }]);
  }

  private isAdmin(p: Principal): boolean {
    return effectivePermissions(p).has('agents:manage');
  }

  private cron(expr: string): void {
    try {
      parseCron(expr);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
    if (nextCron(expr, Date.now()) == null) throw badRequest('This cron expression never matches within a year.');
  }

  /** The owner sees their schedules, an agent admin every schedule in the tenant within their clearance. */
  private async visible(p: Principal, id: string): Promise<ScheduleRow> {
    const r = (await this.db('agent_schedules').where({ tenant_id: p.tenantId, id }).first()) as Record<string, unknown> | undefined;
    const sc = r ? fromRow(r) : null;
    if (!sc || !clears(p.clearance, sc.label) || (sc.owner_id !== p.userId && !this.isAdmin(p))) throw notFound('Schedule');
    return sc;
  }

  async view(p: Principal, sc: ScheduleRow, ownerName?: string | null) {
    const mine = sc.owner_id === p.userId;
    return {
      id: sc.id,
      name: sc.name,
      agent: sc.agent,
      cron: sc.cron,
      cronText: describeCron(sc.cron),
      label: sc.label,
      budgets: json<Partial<AgentBudgets>>(sc.budgets, {}),
      enabled: sc.enabled,
      nextRunAt: sc.next_run_at,
      lastRunAt: sc.last_run_at,
      lastRunId: sc.last_run_id,
      lastResult: sc.last_result,
      ownerId: sc.owner_id,
      owner: ownerName ?? null,
      mine,
      workspaceId: sc.workspace_id,
      input: await this.s().keys.open(sc.tenant_id, sc.input, `agent-schedule:${sc.id}`),
      createdAt: sc.created_at,
      updatedAt: sc.updated_at
    };
  }

  async list(p: Principal, opts: { all?: boolean } = {}) {
    const q = this.db('agent_schedules as a').leftJoin('users as u', 'u.id', 'a.owner_id').where({ 'a.tenant_id': p.tenantId });
    if (!(opts.all && this.isAdmin(p))) q.andWhere({ 'a.owner_id': p.userId });
    const rows = (await q.orderBy('a.created_at', 'desc').limit(500).select('a.*', 'u.display_name as owner_name')) as Record<string, unknown>[];
    const out = [];
    for (const r of rows) {
      const sc = fromRow(r);
      if (!clears(p.clearance, sc.label)) continue;
      out.push(await this.view(p, sc, (r.owner_name as string | null) ?? null));
    }
    return out;
  }

  async get(p: Principal, id: string) {
    return this.view(p, await this.visible(p, id));
  }

  /** Creates a schedule owned by the caller; they must be able to start this run now. */
  async create(p: Principal, input: ScheduleInput) {
    this.cron(input.cron);
    await this.s().agents.checkStart(p, { agent: input.agent, label: input.label });
    if (await this.db('agent_schedules').where({ tenant_id: p.tenantId, owner_id: p.userId, name: input.name }).first('id')) throw conflict(`You already have a schedule named ${input.name}.`);
    const id = ulid();
    const t = Date.now();
    const enabled = input.enabled ?? true;
    const row: ScheduleRow = { id, tenant_id: p.tenantId, workspace_id: p.workspaceId ?? null, owner_id: p.userId, name: input.name, agent: input.agent, cron: input.cron, input: await this.s().keys.seal(p.tenantId, input.input, `agent-schedule:${id}`), label: input.label, budgets: input.budgets ? JSON.stringify(input.budgets) : null, enabled, next_run_at: enabled ? nextCron(input.cron, t) : null, last_run_at: null, last_run_id: null, last_result: null, created_at: t, updated_at: t };
    await this.db('agent_schedules').insert(row);
    return this.view(p, row, p.displayName);
  }

  /** The owner changes their schedule; an agent admin may only pause or resume someone else's. */
  async update(p: Principal, id: string, patch: Partial<Omit<ScheduleInput, 'name'>>) {
    const sc = await this.visible(p, id);
    const own = sc.owner_id === p.userId;
    if (!own && Object.keys(patch).some((k) => k !== 'enabled')) throw forbidden('Only the owner can change what a schedule runs; an agent admin can pause or resume it.', { step: 'role' });
    const upd: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.cron !== undefined) {
      this.cron(patch.cron);
      upd.cron = patch.cron;
    }
    if (patch.agent !== undefined || patch.label !== undefined) await this.s().agents.checkStart(p, { agent: patch.agent ?? sc.agent, label: patch.label ?? sc.label });
    if (patch.agent !== undefined) upd.agent = patch.agent;
    if (patch.label !== undefined) upd.label = patch.label;
    if (patch.input !== undefined) upd.input = await this.s().keys.seal(sc.tenant_id, patch.input, `agent-schedule:${sc.id}`);
    if (patch.budgets !== undefined) upd.budgets = JSON.stringify(patch.budgets);
    const enabled = patch.enabled ?? sc.enabled;
    upd.enabled = enabled;
    upd.next_run_at = enabled ? nextCron(patch.cron ?? sc.cron, Date.now()) : null;
    await this.db('agent_schedules').where({ id: sc.id }).update(upd);
    return this.get(p, sc.id);
  }

  async remove(p: Principal, id: string): Promise<ScheduleRow> {
    const sc = await this.visible(p, id);
    if (sc.owner_id !== p.userId && !this.isAdmin(p)) throw forbidden('Only the owner or an agent admin can delete a schedule.', { step: 'role' });
    await this.db('agent_schedule_runs').where({ schedule_id: sc.id }).delete();
    await this.db('agent_schedules').where({ id: sc.id }).delete();
    return sc;
  }

  /** The schedule's history: every due time, with the run it started (and its state) or why it was skipped. */
  async history(p: Principal, id: string, limit = 50) {
    const sc = await this.visible(p, id);
    const rows = (await this.db('agent_schedule_runs as h').leftJoin('agent_runs as r', 'r.id', 'h.run_id').where({ 'h.schedule_id': sc.id }).orderBy('h.due_at', 'desc').limit(Math.min(limit, 200)).select('h.*', 'r.state as run_state')) as Record<string, unknown>[];
    return rows.map((r) => ({ id: String(r.id), dueAt: Number(r.due_at), at: Number(r.at), outcome: String(r.outcome), reason: (r.reason as string | null) ?? null, runId: (r.run_id as string | null) ?? null, runState: (r.run_state as string | null) ?? null }));
  }

  // ---------- firing ----------

  /** Fires every due schedule. Idempotent: each due time is claimed once. */
  async tick(now = Date.now()): Promise<{ fired: number; skipped: number }> {
    const due = ((await this.db('agent_schedules').where({ enabled: true }).whereNotNull('next_run_at').andWhere('next_run_at', '<=', now).orderBy('next_run_at').limit(200)) as Record<string, unknown>[]).map(fromRow);
    let fired = 0;
    let skipped = 0;
    for (const sc of due) {
      const outcome = await this.fire(sc, now).catch((err: Error) => {
        this.s().log.warn({ schedule: sc.id, err: err.message }, 'agent schedule failed to fire');
        return null;
      });
      if (outcome === 'started') fired++;
      else if (outcome) skipped++;
    }
    return { fired, skipped };
  }

  /** The owner as a principal now, in the schedule's workspace; a string says why the run cannot start. */
  private async owner(sc: ScheduleRow): Promise<Principal | string> {
    const s = this.s();
    const u = (await this.db('users').where({ id: sc.owner_id, tenant_id: sc.tenant_id }).first('state')) as { state: string } | undefined;
    if (!u || u.state !== 'active') return 'the owner is disabled or no longer exists';
    const p = await loadPrincipal(s, sc.tenant_id, sc.owner_id, {});
    if (!p) return 'the owner or the tenant is no longer active';
    if (!authorize(p, 'agents:run').allow) return 'the owner may no longer run agents';
    if (sc.workspace_id) {
      if (!(await workspacesFor(s, p)).some((w) => w.id === sc.workspace_id)) return 'the owner is no longer a member of the schedule\'s workspace';
      p.workspaceId = sc.workspace_id;
    } else p.workspaceId = null;
    return p;
  }

  private async fire(sc: ScheduleRow, now: number): Promise<'started' | 'skipped' | 'failed' | null> {
    const s = this.s();
    const dueAt = sc.next_run_at!;
    const next = nextCron(sc.cron, now);
    // Claim this due time: only one instance moves the schedule on.
    const claimed = await this.db('agent_schedules').where({ id: sc.id, next_run_at: dueAt, enabled: true }).update({ next_run_at: next, last_run_at: now });
    if (!claimed) return null;
    const record = async (outcome: 'started' | 'skipped' | 'failed', reason: string | null, runId: string | null) => {
      await this.db('agent_schedule_runs').insert({ id: ulid(), schedule_id: sc.id, tenant_id: sc.tenant_id, run_id: runId, outcome, reason: reason?.slice(0, 300) ?? null, due_at: dueAt, at: now });
      await this.db('agent_schedules').where({ id: sc.id }).update({ last_result: `${outcome}${reason ? `: ${reason}` : ''}`.slice(0, 300), ...(runId ? { last_run_id: runId } : {}) });
      await s.audit.append({ tenantId: sc.tenant_id, action: `agent.schedule.${outcome}`, kind: 'system', actor: { service: 'agents.schedules', user: sc.owner_id }, target: { schedule: sc.id, name: sc.name, agent: sc.agent, ...(runId ? { run: runId } : {}) }, label: sc.label, detail: { dueAt, reason } });
      return outcome;
    };
    const p = await this.owner(sc);
    if (typeof p === 'string') return record('skipped', p, null);
    try {
      const input = await s.keys.open(sc.tenant_id, sc.input, `agent-schedule:${sc.id}`);
      const budgets = json<Partial<AgentBudgets>>(sc.budgets, {});
      const run = await s.agents.start(p, { agent: sc.agent, input, label: sc.label, ...(Object.keys(budgets).length ? { budgets } : {}) }, { scheduleId: sc.id });
      return record('started', null, run.id);
    } catch (err) {
      const message = err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message;
      // Refusals that come from the owner's standing (clearance, ceilings, the agent no longer runnable) are skips.
      return record(err instanceof HttpProblem && (err.status === 403 || err.status === 404 || err.status === 409) ? 'skipped' : 'failed', message, null);
    }
  }
}
