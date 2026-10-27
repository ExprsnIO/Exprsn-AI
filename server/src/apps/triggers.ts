import { ulid } from 'ulid';
import { actorFrom } from '../audit/chain.js';
import { clears, highest, labelRank, type Label } from '../authz/labels.js';
import { authorize, type Principal } from '../authz/policy.js';
import { PLATFORM_TENANT } from '../audit/chain.js';
import { HttpProblem, badRequest, conflict, notFound } from '../http/problem.js';
import { loadPrincipal, workspacesFor } from '../http/middleware.js';
import type { Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import { describeCron, nextCron, parseCron } from '../training/calendar.js';
import type { RecordStep, RecordStepRunner } from '../workflows/service.js';
import type { Actor, AppRow, AppService, EntityRow, RecordEvent, RecordRow } from './service.js';
import { ChainLimit, chainRefOf, type ChainRef } from '../chain/context.js';

/*
 * Triggers (B-2206). A record trigger starts a published workflow when a record of its entity is created, updated,
 * deleted or moved to another state; a schedule trigger starts it on a five-field UTC cron (the training calendar's
 * parser). Either runs as the trigger's owner with what they hold at that moment (like scheduled agents): a disabled
 * owner, one who lost `agents:run` or `records:read`, left the workflow's workspace, or whose clearance no longer
 * covers the record gets a skip, audited, instead of a run. A record above the workflow's label is skipped too.
 *
 * Firing is a job per trigger and event, so a slow workflow never holds up the write. Chains end: a run started by a
 * trigger carries its depth, record steps pass it on, and nothing fires past APPS_TRIGGER_MAX_DEPTH; a workflow's own
 * record steps never fire that same workflow's triggers.
 *
 * Workflows reach records through the record step (`kind: record`): create, update or transition a record as the run's
 * owner, within the run's label.
 */

export const RECORD_EVENTS: RecordEvent[] = ['created', 'updated', 'deleted', 'transitioned'];

export interface TriggerRow {
  id: string;
  tenant_id: string;
  app_id: string;
  entity_id: string;
  kind: 'record' | 'schedule';
  events: string | null;
  cron: string | null;
  workflow_id: string;
  workspace_id: string | null;
  owner_id: string;
  enabled: boolean;
  next_run_at: number | null;
  last_run_at: number | null;
  last_run_id: string | null;
  last_result: string | null;
  created_at: number;
  updated_at: number;
}

const num = (v: unknown) => (v == null ? null : Number(v));
const triggerFrom = (r: Record<string, unknown>): TriggerRow => ({ ...(r as unknown as TriggerRow), enabled: !!r.enabled, next_run_at: num(r.next_run_at), last_run_at: num(r.last_run_at), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });

export const triggerView = (t: TriggerRow, entity: string, workflow: string | null) => ({
  id: t.id,
  kind: t.kind,
  entity,
  events: t.events ? t.events.split(',') : [],
  cron: t.cron,
  schedule: t.cron ? describeCron(t.cron) : null,
  workflowId: t.workflow_id,
  workflow,
  ownerId: t.owner_id,
  enabled: t.enabled,
  nextRunAt: t.next_run_at,
  lastRunAt: t.last_run_at,
  lastRunId: t.last_run_id,
  lastResult: t.last_result,
  createdAt: t.created_at,
  updatedAt: t.updated_at
});

export class AppTriggers implements RecordStepRunner {
  constructor(
    private readonly s: () => Services,
    private readonly apps: AppService
  ) {}

  private get db() {
    return this.s().db;
  }

  registerJobs(): void {
    const jobs = this.s().jobs;
    jobs.register('apps.trigger', (p) => this.fireRecord(p), { timeoutMs: 5 * 60_000 });
    jobs.register('apps.schedules', async () => this.tick(), { timeoutMs: 10 * 60_000 });
  }

  schedule(scheduler: Scheduler, everyMs: number): void {
    scheduler.every('apps.schedules', everyMs, async () => [{ tenantId: PLATFORM_TENANT, key: 'all' }]);
  }

  // ---------- design ----------

  async list(app: AppRow) {
    const rows = ((await this.db('app_triggers').where({ app_id: app.id }).orderBy('created_at')) as Record<string, unknown>[]).map(triggerFrom);
    const entities = new Map((await this.apps.entities(app)).map((e) => [e.id, e.name]));
    const wfs = new Map(((await this.db('workflows').whereIn('id', [...new Set(rows.map((r) => r.workflow_id))]).select('id', 'name')) as { id: string; name: string }[]).map((w) => [w.id, w.name]));
    return rows.map((t) => triggerView(t, entities.get(t.entity_id) ?? '', wfs.get(t.workflow_id) ?? null));
  }

  private cron(expr: string): void {
    try {
      parseCron(expr);
    } catch (err) {
      throw badRequest(`The schedule is not a valid cron expression: ${(err as Error).message}`);
    }
    if (nextCron(expr, Date.now()) == null) throw badRequest('This cron expression never matches within a year.');
  }

  async create(actor: Actor & { principal: Principal }, appRef: string, input: { entity: string; kind: 'record' | 'schedule'; events?: RecordEvent[]; cron?: string; workflow: string; enabled?: boolean }) {
    const p = actor.principal;
    const app = await this.apps.app(p, appRef);
    const entity = await this.apps.entityOf(app, input.entity);
    // The designer must be able to see the workflow, in their current workspace, and it must be published.
    const w = await this.s().workflows.workflow(p, input.workflow);
    if (!w.published_version) throw conflict(`${w.name} has no published version; publish it first.`);
    if (input.kind === 'record' && !input.events?.length) throw badRequest('A record trigger lists the events it fires on.');
    if (input.kind === 'schedule') {
      if (!input.cron) throw badRequest('A schedule trigger has a cron expression.');
      this.cron(input.cron);
    }
    const t = Date.now();
    const enabled = input.enabled ?? true;
    const row: TriggerRow = { id: ulid(), tenant_id: p.tenantId, app_id: app.id, entity_id: entity.id, kind: input.kind, events: input.kind === 'record' ? [...new Set(input.events)].join(',') : null, cron: input.kind === 'schedule' ? input.cron! : null, workflow_id: w.id, workspace_id: w.workspace_id, owner_id: p.userId, enabled, next_run_at: input.kind === 'schedule' && enabled ? nextCron(input.cron!, t) : null, last_run_at: null, last_run_id: null, last_result: null, created_at: t, updated_at: t };
    await this.db('app_triggers').insert(row);
    await this.audit(actor, 'app.trigger.created', { app: app.id, trigger: row.id, entity: entity.id, workflow: w.id }, { kind: row.kind, events: row.events, cron: row.cron });
    return triggerView(row, entity.name, w.name);
  }

  private async row(app: AppRow, id: string): Promise<TriggerRow> {
    const r = await this.db('app_triggers').where({ app_id: app.id, id }).first();
    if (!r) throw notFound('Trigger');
    return triggerFrom(r);
  }

  async update(actor: Actor & { principal: Principal }, appRef: string, id: string, patch: { enabled?: boolean; events?: RecordEvent[]; cron?: string }) {
    const app = await this.apps.app(actor.principal, appRef);
    const t = await this.row(app, id);
    const upd: Partial<TriggerRow> = { updated_at: Date.now() };
    if (patch.events) {
      if (t.kind !== 'record' || !patch.events.length) throw badRequest('Only a record trigger has events, at least one.');
      upd.events = [...new Set(patch.events)].join(',');
    }
    if (patch.cron) {
      if (t.kind !== 'schedule') throw badRequest('Only a schedule trigger has a cron expression.');
      this.cron(patch.cron);
      upd.cron = patch.cron;
    }
    if (patch.enabled !== undefined) upd.enabled = patch.enabled;
    const enabled = upd.enabled ?? t.enabled;
    if (t.kind === 'schedule') upd.next_run_at = enabled ? nextCron(upd.cron ?? t.cron!, Date.now()) : null;
    await this.db('app_triggers').where({ id: t.id }).update(upd);
    const after = { ...t, ...upd };
    await this.audit(actor, 'app.trigger.updated', { app: app.id, trigger: t.id }, { enabled: after.enabled, events: after.events, cron: after.cron });
    const entity = await this.apps.entityById(app.tenant_id, t.entity_id);
    return triggerView(after, entity?.name ?? '', null);
  }

  async remove(actor: Actor & { principal: Principal }, appRef: string, id: string) {
    const app = await this.apps.app(actor.principal, appRef);
    const t = await this.row(app, id);
    await this.db('app_triggers').where({ id: t.id }).delete();
    await this.audit(actor, 'app.trigger.deleted', { app: app.id, trigger: t.id, workflow: t.workflow_id }, { kind: t.kind });
  }

  private audit(actor: Actor & { principal: Principal }, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>) {
    return this.s().audit.append({ tenantId: actor.principal.tenantId, action, kind: 'admin', actor: actorFrom(actor.principal, actor.ip ?? null), target, ...(detail ? { detail } : {}), traceId: actor.traceId ?? null });
  }

  // ---------- firing ----------

  /** After a record write: one job per matching enabled trigger. */
  async onRecordEvent(app: AppRow, entity: EntityRow, r: RecordRow, event: RecordEvent, extra: Record<string, unknown>, actor: Actor): Promise<number> {
    const depth = actor.depth ?? 0;
    const rows = ((await this.db('app_triggers').where({ tenant_id: app.tenant_id, entity_id: entity.id, kind: 'record', enabled: true })) as Record<string, unknown>[]).map(triggerFrom).filter((t) => (t.events ?? '').split(',').includes(event));
    let queued = 0;
    for (const t of rows) {
      if (actor.causedBy && actor.causedBy === t.workflow_id) continue;
      if (depth >= this.apps.o.triggerMaxDepth) {
        await this.skip(t, `the chain of triggers is ${depth} deep (APPS_TRIGGER_MAX_DEPTH)`, r.label, { record: r.id, event });
        continue;
      }
      await this.s().jobs.enqueue({
        tenantId: app.tenant_id,
        type: 'apps.trigger',
        payload: { triggerId: t.id, recordId: r.id, label: r.label, state: r.state, event, depth: depth + 1, ...(actor.chain ? { chain: actor.chain } : {}), ...(event === 'updated' ? { fields: ((extra.fields as string[] | undefined) ?? []).slice(0, 100) } : {}), ...(event === 'transitioned' ? { from: extra.from ?? null, to: extra.to ?? null } : {}) },
        createdBy: t.owner_id,
        maxAttempts: 3
      });
      queued++;
    }
    return queued;
  }

  private async skip(t: TriggerRow, reason: string, label: Label, target: Record<string, unknown>): Promise<{ skipped: string }> {
    await this.db('app_triggers').where({ id: t.id }).update({ last_result: `skipped: ${reason}`.slice(0, 300) });
    await this.s().audit.append({ tenantId: t.tenant_id, action: 'app.trigger.skipped', kind: 'system', actor: { service: 'apps.triggers', user: t.owner_id }, target: { trigger: t.id, workflow: t.workflow_id, ...target }, label, detail: { reason } });
    return { skipped: reason };
  }

  /** The owner as a principal now, in the workflow's workspace; a string says why nothing can start. */
  private async owner(t: TriggerRow): Promise<Principal | string> {
    const s = this.s();
    const p = await loadPrincipal(s, t.tenant_id, t.owner_id, {});
    if (!p) return 'the owner is disabled or no longer exists';
    if (!authorize(p, 'agents:run').allow) return 'the owner may no longer run workflows';
    if (!authorize(p, 'records:read').allow) return 'the owner may no longer read records';
    if (t.workspace_id) {
      if (!(await workspacesFor(s, p)).some((w) => w.id === t.workspace_id)) return "the owner is no longer a member of the workflow's workspace";
      p.workspaceId = t.workspace_id;
    } else p.workspaceId = null;
    return p;
  }

  private async start(t: TriggerRow, p: Principal, input: Record<string, unknown>, label: Label, trigger: 'record' | 'schedule', target: Record<string, unknown>, parent: ChainRef | null = null): Promise<unknown> {
    const s = this.s();
    let w;
    try {
      w = await s.workflows.workflow(p, t.workflow_id);
    } catch {
      return this.skip(t, 'the workflow is gone or out of reach', label, target);
    }
    if (labelRank(label) > labelRank(w.label)) return this.skip(t, `the record is ${label}; ${w.name} handles data up to ${w.label}`, label, target);
    try {
      // B-4101: the trigger is a node of the chain the run joins: the chain of the run whose record step fired it, or a new one.
      // A trigger owned by someone else than the chain's principal acts as its owner, so it starts a chain of its own.
      const begin = (from: ChainRef | null) => s.workflows.start(p, w.id, { input, dry: false, trigger, chain: { parent: from, via: { kind: 'app-trigger', callee: t.id } } });
      const run = await begin(parent).catch((err: unknown) => {
        if (err instanceof ChainLimit && err.code === 'principal') return begin(null);
        throw err;
      });
      await this.db('app_triggers').where({ id: t.id }).update({ last_run_at: Date.now(), last_run_id: run.id, last_result: 'started' });
      await s.audit.append({ tenantId: t.tenant_id, action: 'app.trigger.fired', kind: 'system', actor: { service: 'apps.triggers', user: t.owner_id }, target: { trigger: t.id, workflow: w.id, run: run.id, ...target }, label: highest(label, run.label), detail: { kind: t.kind } });
      return { run: run.id };
    } catch (err) {
      if (err instanceof HttpProblem && err.status < 500) return this.skip(t, err.detail ?? err.title, label, target);
      if (err instanceof ChainLimit) return this.skip(t, err.message, label, target);
      throw err;
    }
  }

  private async fireRecord(payload: Record<string, unknown>): Promise<unknown> {
    const raw = await this.db('app_triggers').where({ id: String(payload.triggerId) }).first();
    if (!raw) return { skipped: 'trigger gone' };
    const t = triggerFrom(raw);
    if (!t.enabled) return { skipped: 'disabled' };
    const label = (payload.label as Label | undefined) ?? 'internal';
    const event = String(payload.event) as RecordEvent;
    const target = { record: String(payload.recordId), event };
    const p = await this.owner(t);
    if (typeof p === 'string') return this.skip(t, p, label, target);
    const app = await this.apps.appById(t.tenant_id, t.app_id);
    const entity = await this.apps.entityById(t.tenant_id, t.entity_id);
    if (!app || !entity) return { skipped: 'app gone' };
    if (!clears(p.clearance, label)) return this.skip(t, `the record is ${label}; the owner's clearance is ${p.clearance}`, label, target);
    let record: Record<string, unknown> = { id: String(payload.recordId), state: payload.state ?? null, label };
    if (event !== 'deleted') {
      const r = await this.db('app_records').where({ tenant_id: t.tenant_id, id: String(payload.recordId) }).first();
      if (!r) return { skipped: 'record gone' };
      const row = { ...(r as RecordRow), hidden: !!r.hidden, version: Number(r.version) };
      if (row.hidden) return { skipped: 'record hidden' };
      record = { id: row.id, state: row.state, label: row.label, version: row.version, values: await this.apps.open(row) };
    }
    const input = {
      event,
      app: app.name,
      entity: entity.name,
      record,
      ...(payload.fields ? { fields: payload.fields } : {}),
      ...(event === 'transitioned' ? { from: payload.from ?? null, to: payload.to ?? null } : {}),
      trigger: { id: t.id, depth: Number(payload.depth ?? 1) }
    };
    return this.start(t, p, input, label, 'record', target, chainRefOf(payload.chain));
  }

  /** Due schedule triggers; each due time is claimed with one conditional update, so one instance fires it. */
  async tick(now = Date.now()): Promise<{ fired: number; skipped: number }> {
    const due = ((await this.db('app_triggers').where({ kind: 'schedule', enabled: true }).whereNotNull('next_run_at').andWhere('next_run_at', '<=', now).orderBy('next_run_at').limit(200)) as Record<string, unknown>[]).map(triggerFrom);
    let fired = 0;
    let skipped = 0;
    for (const t of due) {
      const claimed = await this.db('app_triggers').where({ id: t.id, next_run_at: t.next_run_at, enabled: true }).update({ next_run_at: nextCron(t.cron!, now), last_run_at: now });
      if (!claimed) continue;
      const out = await this.fireSchedule(t).catch((err: Error) => {
        this.s().log.warn({ trigger: t.id, err: err.message }, 'app schedule trigger failed');
        return { skipped: err.message };
      });
      if ('run' in (out as object)) fired++;
      else skipped++;
    }
    return { fired, skipped };
  }

  private async fireSchedule(t: TriggerRow): Promise<unknown> {
    const app = await this.apps.appById(t.tenant_id, t.app_id);
    const entity = await this.apps.entityById(t.tenant_id, t.entity_id);
    if (!app || !entity) return { skipped: 'app gone' };
    const p = await this.owner(t);
    if (typeof p === 'string') return this.skip(t, p, entity.label, { entity: entity.id });
    return this.start(t, p, { event: 'schedule', app: app.name, entity: entity.name, dueAt: new Date(t.next_run_at ?? Date.now()).toISOString(), trigger: { id: t.id, depth: 1 } }, entity.label, 'schedule', { entity: entity.id });
  }

  // ---------- the workflow record step (B-2206) ----------

  /**
   * Creates, updates or moves a record as the run's owner. The data the run carries is `label`: a new record is at
   * least that, and an existing record below it is refused (writing it there would lower the data's label).
   */
  async runStep(p: Principal, step: RecordStep, ctx: { label: Label; workflowId: string; runId: string; depth: number; chain?: ChainRef | null }): Promise<{ output: Record<string, unknown>; label: Label }> {
    if (!authorize(p, 'records:write').allow) throw new HttpProblem(403, 'Forbidden', 'The run owner may not write records.');
    const app = await this.apps.app(p, step.app);
    const entity = await this.apps.entityOf(app, step.entity);
    const actor: Actor = { principal: p, source: 'workflow', depth: ctx.depth, causedBy: ctx.workflowId, service: 'workflows', chain: ctx.chain ?? null };
    if (step.action === 'create') {
      const label = highest(entity.label, ctx.label);
      const rec = await this.apps.createRecord(actor, app, entity, { values: step.values, label });
      return { output: { id: rec.id, state: rec.state, label: rec.label, values: rec.values }, label: rec.label };
    }
    if (!step.record) throw badRequest('The step names no record.');
    const current = await this.apps.readable(p, entity, step.record);
    if (labelRank(ctx.label) > labelRank(current.label)) throw new HttpProblem(403, 'Forbidden', `Blocked by label: the record is ${current.label}; the run carries ${ctx.label} data.`, { extensions: { step: 'clearance' } });
    const rec = step.action === 'update' ? await this.apps.updateRecord(actor, app, entity, current.id, { values: step.values }) : await this.apps.transition(actor, app, entity, current.id, step.to ?? '');
    return { output: { id: rec.id, state: rec.state, label: rec.label, values: rec.values }, label: rec.label };
  }
}
