import { AsyncLocalStorage } from 'node:async_hooks';
import client from 'prom-client';
import { ulid } from 'ulid';
import { actorFrom, isUniqueViolation, PLATFORM_TENANT, type AuditEvent } from '../audit/chain.js';
import { clears, labelRank, type Label } from '../authz/labels.js';
import { authorize, type Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { HttpProblem, notFound } from '../http/problem.js';
import { loadPrincipal, workspacesFor } from '../http/middleware.js';
import { TOPICS, type IntegrationEvent } from '../platform/bus.js';
import type { JobProgressEvent, Scheduler } from '../platform/jobs.js';
import { Limiter } from '../platform/ratelimit.js';
import type { Services } from '../services.js';
import { describeCron, nextCron } from '../training/calendar.js';
import { auditData, matchesEvent } from '../webhooks/service.js';
import { configOf, type WfGraph, type WfNode } from './graph.js';
import type { RunRow, WorkflowRow } from './service.js';
import { selfTrigger } from './trigger-config.js';

/*
 * Triggers on the workflow itself (Sprint 32b, B-3903). The trigger step of a workflow's published version can start
 * runs with no app or plugin in between:
 *
 * - `event`: a catalogue event type or group. Events come from the same sources as webhooks and plugins (the audit
 *   chain, job states, flags, approvals and the domain events such as `file.uploaded`), each on the instance where it
 *   happens, so each is offered once. Fan-out follows the plugin rules:
 *   - workspace: a workflow in a workspace only receives events that name that workspace (`data.workspace` or the
 *     audit target's `workspace`); a tenant-level workflow receives the tenant's events;
 *   - label: an event above the workflow's label is not delivered, and one above the owner's clearance is skipped;
 *   - rate: WORKFLOW_EVENT_RATE_PER_MINUTE firings a minute per trigger, in the shared counter store (one limit across
 *     instances with Redis); events past it are dropped, counted and audited once a window as
 *     `workflow.trigger.throttled`;
 *   - loop chain: every run started by an event carries the chain of workflows that caused it (in its firing row, and
 *     in-process while the run executes, an AsyncLocalStorage that covers the audit entries and events its steps
 *     cause). An event caused by a chain is never delivered to a workflow already in it (so a workflow's own steps
 *     never start it again), events about a workflow's own runs never start it, and the event is dropped once the
 *     chain is WORKFLOW_EVENT_MAX_DEPTH workflows long.
 * - `schedule` with `cron`: a five-field UTC cron. Each due time is claimed with one conditional update on
 *   `next_run_at`, and the firing row is unique per due time, so two instances start one run.
 *
 * A run starts as the person who published the version (the trigger's owner) with what they hold at that moment, like
 * app triggers and scheduled agents: a disabled owner, one who lost `agents:run`, left the workflow's workspace or
 * whose clearance no longer covers the event gets a skip, recorded on the firing and audited, instead of a run.
 *
 * TODO(B-4101): the chain context (Sprint 32a) replaces the workflow-only chain here with the one chain across kinds
 * (plugins, app triggers, sub-workflows, agents) and one CHAIN_MAX_DEPTH; WORKFLOW_EVENT_MAX_DEPTH stays as this
 * kind's cap. The seams are `causeChain` (what an offered event was caused by) and `scope` (what a run executes in).
 */

/** The workflows (ids, oldest first) the work in progress was caused by. */
export interface WorkflowCause {
  chain: string[];
}

export const workflowCause = new AsyncLocalStorage<WorkflowCause>();

export interface TriggerRow {
  id: string;
  tenant_id: string;
  workflow_id: string;
  workspace_id: string | null;
  version: number;
  kind: 'event' | 'schedule';
  event: string | null;
  cron: string | null;
  owner_id: string;
  enabled: boolean;
  next_run_at: number | null;
  last_fired_at: number | null;
  last_run_id: string | null;
  last_result: string | null;
  created_at: number;
  updated_at: number;
}

interface FiringRow {
  id: string;
  tenant_id: string;
  trigger_id: string;
  workflow_id: string;
  event_type: string;
  event_id: string;
  label: Label;
  event_sealed: string | null;
  chain: string[];
  state: 'queued' | 'starting' | 'started' | 'skipped' | 'failed';
  run_id: string | null;
  reason: string | null;
  job_id: string | null;
  created_at: number;
  finished_at: number | null;
}

/** An event as a trigger receives it (the webhook and plugin envelope). */
export interface TriggerEvent {
  id: string;
  type: string;
  tenant: string;
  label: Label;
  createdAt: string;
  data: Record<string, unknown>;
}

const num = (v: unknown) => (v == null ? null : Number(v));
const triggerFrom = (r: Record<string, unknown>): TriggerRow => ({ ...(r as unknown as TriggerRow), enabled: !!r.enabled, version: Number(r.version), next_run_at: num(r.next_run_at), last_fired_at: num(r.last_fired_at), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
const firingFrom = (r: Record<string, unknown>): FiringRow => ({ ...(r as unknown as FiringRow), chain: json<string[]>(r.chain, []), created_at: Number(r.created_at), finished_at: num(r.finished_at) });
const plain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const triggerView = (t: TriggerRow) => ({
  id: t.id,
  workflowId: t.workflow_id,
  version: t.version,
  kind: t.kind,
  event: t.event,
  cron: t.cron,
  schedule: t.cron ? describeCron(t.cron) : null,
  ownerId: t.owner_id,
  enabled: t.enabled,
  nextRunAt: t.next_run_at,
  lastFiredAt: t.last_fired_at,
  lastRunId: t.last_run_id,
  lastResult: t.last_result,
  createdAt: t.created_at,
  updatedAt: t.updated_at
});

const firingView = (f: FiringRow) => ({ id: f.id, event: f.event_type, eventId: f.event_id, label: f.label, chain: f.chain, state: f.state, runId: f.run_id, reason: f.reason, createdAt: f.created_at, finishedAt: f.finished_at });

/** The workspace an event names, if any. */
function eventWorkspace(data: Record<string, unknown>): string | null {
  if (typeof data.workspace === 'string') return data.workspace;
  if (plain(data.target) && typeof data.target.workspace === 'string') return data.target.workspace;
  return null;
}

/** The workflow an event is about (an audit entry whose target names one, an approval of a workflow run). */
function eventWorkflow(data: Record<string, unknown>): string | null {
  if (plain(data.target) && typeof data.target.workflow === 'string') return data.target.workflow;
  if (data.kind === 'workflow' && typeof data.workflow === 'string') return data.workflow;
  return null;
}

export class WorkflowTriggers {
  private readonly offs: (() => void)[] = [];
  private limiterInstance: Limiter | null = null;
  readonly dropped: client.Counter<'reason'>;
  readonly firings: client.Counter<'kind' | 'result'>;

  constructor(
    private readonly s: () => Services,
    reg: client.Registry
  ) {
    const counter = <T extends string>(name: string, help: string, labelNames: T[]) => (reg.getSingleMetric(name) as client.Counter<T> | undefined) ?? new client.Counter({ name, help, labelNames, registers: [reg] });
    this.dropped = counter('exprsn_workflow_trigger_dropped_total', 'Events not delivered to a workflow trigger, by reason (rate, depth, loop)', ['reason']);
    this.firings = counter('exprsn_workflow_trigger_firings_total', 'Workflow trigger firings by kind and result (started, skipped)', ['kind', 'result']);
  }

  private get db() {
    return this.s().db;
  }

  private get limiter(): Limiter {
    return (this.limiterInstance ??= new Limiter(this.s().counters, 'wf-trigger', this.s().cfg.WORKFLOW_EVENT_RATE_PER_MINUTE, 60_000));
  }

  /** Hooks into the workflow service: publishing writes the trigger row; a run executes in its chain. */
  install(): void {
    this.s().workflows.useLifecycle({
      published: (w, version, g, p) => this.sync(w, version, g, p),
      scope: (run, fn) => this.scope(run, fn)
    });
  }

  registerJobs(): void {
    const jobs = this.s().jobs;
    jobs.register('workflow.trigger', (p) => this.fire(String(p.firingId)), { timeoutMs: 5 * 60_000 });
    jobs.register('workflow.schedules', async () => this.tick(), { timeoutMs: 10 * 60_000 });
  }

  schedule(scheduler: Scheduler): void {
    const every = this.s().cfg.WORKFLOW_SCHEDULE_TICK_SECONDS;
    if (every > 0) scheduler.every('workflow.schedules', every * 1000, async () => [{ tenantId: PLATFORM_TENANT, key: 'all' }]);
  }

  /** Subscribes to the event sources on this instance, as the webhook and plugin fan-out do. */
  listen(): void {
    const s = this.s();
    const swallow = (p: Promise<unknown>) => void p.catch((err: unknown) => s.log.warn({ err }, 'workflow trigger fan-out failed'));
    this.offs.push(
      s.audit.onAppend((e) => swallow(this.offer(e.tenant_id, e.action, e.label, `audit:${e.id}`, auditData(e), e))),
      s.bus.on<JobProgressEvent>(TOPICS.jobProgress, (e) => {
        if (!['succeeded', 'failed', 'cancelled'].includes(e.state)) return;
        // Trigger firings, plugin and webhook deliveries are never events for triggers: they would feed back.
        if (e.type.startsWith('workflow.trigger') || e.type === 'workflow.schedules' || e.type.startsWith('plugin.') || e.type.startsWith('webhook.')) return;
        swallow(this.offer(e.tenantId, `job.${e.state}`, 'internal', `job:${e.id}:${e.state}`, { id: e.id, type: e.type, state: e.state, error: e.error }));
      }),
      s.bus.on<IntegrationEvent>(TOPICS.integrationEvent, (e) => swallow(this.offer(e.tenantId, e.type, e.label, e.id, e.data)))
    );
  }

  close(): void {
    for (const off of this.offs.splice(0)) off();
  }

  // ---------- publishing ----------

  /** After a publish: the version's trigger row, or none when something else starts the workflow. */
  async sync(w: WorkflowRow, version: number, g: WfGraph, p: Principal): Promise<void> {
    const s = this.s();
    const node = g.nodes.find((n) => n.kind === 'trigger');
    const self = node ? selfTrigger(configOf(node as WfNode & { kind: 'trigger' })) : null;
    const existing = await this.db('workflow_triggers').where({ workflow_id: w.id }).first();
    const t = Date.now();
    if (!self) {
      if (existing) {
        await this.db('workflow_triggers').where({ id: existing.id }).delete();
        await this.audit(p, 'workflow.trigger.removed', { workflow: w.id, trigger: String(existing.id) }, w.label, { version });
      }
    } else {
      const enabled = existing ? !!existing.enabled : true;
      const fields = { version, kind: self.kind, event: self.kind === 'event' ? self.event : null, cron: self.kind === 'schedule' ? self.cron : null, owner_id: p.userId, workspace_id: w.workspace_id, next_run_at: self.kind === 'schedule' && enabled ? nextCron(self.cron, t) : null, updated_at: t };
      let id = existing ? String(existing.id) : ulid();
      if (existing) await this.db('workflow_triggers').where({ id }).update(fields);
      else {
        try {
          await this.db('workflow_triggers').insert({ id, tenant_id: w.tenant_id, workflow_id: w.id, enabled, last_fired_at: null, last_run_id: null, last_result: null, created_at: t, ...fields });
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          id = String((await this.db('workflow_triggers').where({ workflow_id: w.id }).first('id')).id);
          await this.db('workflow_triggers').where({ id }).update(fields);
        }
      }
      await this.audit(p, 'workflow.trigger.set', { workflow: w.id, trigger: id }, w.label, { version, kind: self.kind, event: fields.event, cron: fields.cron, enabled });
    }
    await s.cache.invalidate({ tenantId: w.tenant_id, ns: 'workflow-triggers' });
  }

  // ---------- reading and enabling ----------

  async view(p: Principal, workflowRef: string, limit = 50) {
    const w = await this.s().workflows.workflow(p, workflowRef);
    const r = await this.db('workflow_triggers').where({ workflow_id: w.id }).first();
    if (!r) return { workflowId: w.id, trigger: null, firings: [] };
    const firings = ((await this.db('workflow_trigger_firings').where({ trigger_id: r.id }).orderBy('created_at', 'desc').limit(limit)) as Record<string, unknown>[]).map(firingFrom).filter((f) => clears(p.clearance, f.label));
    return { workflowId: w.id, trigger: triggerView(triggerFrom(r)), firings: firings.map(firingView) };
  }

  async setEnabled(p: Principal, workflowRef: string, enabled: boolean, ctx: { ip?: string | null; traceId?: string } = {}) {
    const w = await this.s().workflows.workflow(p, workflowRef);
    const r = await this.db('workflow_triggers').where({ workflow_id: w.id }).first();
    if (!r) throw notFound('Trigger');
    const t = triggerFrom(r);
    const upd = { enabled, updated_at: Date.now(), next_run_at: t.kind === 'schedule' && enabled ? nextCron(t.cron!, Date.now()) : null };
    await this.db('workflow_triggers').where({ id: t.id }).update(upd);
    await this.audit(p, 'workflow.trigger.updated', { workflow: w.id, trigger: t.id }, w.label, { enabled }, ctx);
    await this.s().cache.invalidate({ tenantId: w.tenant_id, ns: 'workflow-triggers' });
    return triggerView({ ...t, ...upd });
  }

  private audit(p: Principal, action: string, target: Record<string, unknown>, label: Label, detail: Record<string, unknown>, ctx: { ip?: string | null; traceId?: string } = {}) {
    return this.s().audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target, label, detail, traceId: ctx.traceId ?? null });
  }

  // ---------- event fan-out ----------

  /** The tenant's enabled event triggers with their workflow's label (cached; invalidated on publish and enable). */
  private async eventTriggers(tenantId: string): Promise<(TriggerRow & { label: Label })[]> {
    return this.s().cache.get(tenantId, 'workflow-triggers', 'event', 'medium', async () =>
      ((await this.db('workflow_triggers as t').join('workflows as w', 'w.id', 't.workflow_id').where({ 't.tenant_id': tenantId, 't.kind': 'event', 't.enabled': true }).select('t.*', 'w.label as wf_label')) as Record<string, unknown>[]).map((r) => ({ ...triggerFrom(r), label: r.wf_label as Label }))
    );
  }

  /**
   * The chain of workflows an offered event was caused by: the run executing now (in-process), or, for an event about
   * a workflow run (its audit actions, its approvals, its job), that run's chain.
   * TODO(B-4101): read the chain context instead.
   */
  private async causeChain(tenantId: string, type: string, data: Record<string, unknown>): Promise<string[]> {
    const cause = workflowCause.getStore();
    if (cause) return cause.chain;
    const target = plain(data.target) ? data.target : null;
    let runId = typeof target?.run === 'string' ? target.run : typeof data.run === 'string' && data.kind === 'workflow' ? data.run : null;
    if (!runId && type.startsWith('job.') && data.type === 'workflow.run' && typeof data.id === 'string') runId = ((await this.db('workflow_runs').where({ tenant_id: tenantId, job_id: data.id }).first('id')) as { id: string } | undefined)?.id ?? null;
    if (!runId) return [];
    const run = (await this.db('workflow_runs').where({ tenant_id: tenantId, id: runId }).first('id', 'workflow_id', 'trigger')) as Pick<RunRow, 'id' | 'workflow_id' | 'trigger'> | undefined;
    return run ? [...(await this.chainOfRun(run)), run.workflow_id] : [];
  }

  /** The chain a run was started with: its firing's (its trigger is `event:<firing>` or `schedule:<firing>`). */
  private async chainOfRun(run: Pick<RunRow, 'trigger'>): Promise<string[]> {
    const m = /^(?:event|schedule):([0-9A-HJKMNP-TV-Z]{26})$/.exec(run.trigger);
    if (!m) return [];
    const f = (await this.db('workflow_trigger_firings').where({ id: m[1] }).first('chain')) as { chain: string } | undefined;
    return f ? json<string[]>(f.chain, []) : [];
  }

  /** What a run executes in: its chain plus its own workflow, so events its steps cause carry them (the loop rule). */
  async scope<T>(run: RunRow, fn: () => Promise<T>): Promise<T> {
    const outer = workflowCause.getStore()?.chain ?? [];
    const own = await this.chainOfRun(run);
    const chain = [...new Set([...outer, ...own, run.workflow_id])];
    return workflowCause.run({ chain }, fn);
  }

  /**
   * Offers an event to every enabled event trigger of the tenant that subscribes to it, within the workspace, label,
   * loop and rate rules: one firing row and one `workflow.trigger` job each. Returns the number queued.
   */
  async offer(tenantId: string, type: string, label: Label, eventId: string, data: Record<string, unknown>, _audit?: AuditEvent): Promise<number> {
    if (tenantId === PLATFORM_TENANT) return 0;
    const triggers = (await this.eventTriggers(tenantId)).filter((t) => t.event && matchesEvent([t.event], type));
    if (!triggers.length) return 0;
    const s = this.s();
    const workspace = eventWorkspace(data);
    const about = eventWorkflow(data);
    const want = triggers.filter((t) => (!t.workspace_id || t.workspace_id === workspace) && labelRank(label) <= labelRank(t.label));
    if (!want.length) return 0;
    const chain = await this.causeChain(tenantId, type, data);
    if (chain.length >= s.cfg.WORKFLOW_EVENT_MAX_DEPTH) {
      this.dropped.inc({ reason: 'depth' }, want.length);
      return 0;
    }
    const envelope: TriggerEvent = { id: eventId, type, tenant: tenantId, label, createdAt: new Date().toISOString(), data };
    let n = 0;
    for (const t of want) {
      if (chain.includes(t.workflow_id) || about === t.workflow_id) {
        this.dropped.inc({ reason: 'loop' });
        continue;
      }
      const r = await this.limiter.consume(`${tenantId}:${t.id}`);
      if (!r.allowed) {
        this.dropped.inc({ reason: 'rate' });
        // Audited once a window, as the workflow's own effect (so it cannot start the workflow again).
        if (r.count === this.limiter.points + 1) {
          await workflowCause.run({ chain: [...chain, t.workflow_id] }, () => s.audit.append({ tenantId, action: 'workflow.trigger.throttled', kind: 'system', actor: { service: 'workflows.triggers' }, target: { workflow: t.workflow_id, trigger: t.id }, label: 'internal', detail: { perMinute: this.limiter.points, event: type, resetMs: r.resetMs } }));
        }
        continue;
      }
      if (await this.enqueue(t, envelope, chain)) n++;
    }
    return n;
  }

  private async enqueue(t: TriggerRow, e: TriggerEvent, chain: string[]): Promise<boolean> {
    const s = this.s();
    const id = ulid();
    try {
      await this.db('workflow_trigger_firings').insert({ id, tenant_id: t.tenant_id, trigger_id: t.id, workflow_id: t.workflow_id, event_type: e.type.slice(0, 120), event_id: e.id.slice(0, 120), label: e.label, event_sealed: await s.keys.seal(t.tenant_id, JSON.stringify(e), `wf-firing:${id}`), chain: JSON.stringify(chain), state: 'queued', run_id: null, reason: null, job_id: null, created_at: Date.now(), finished_at: null });
    } catch (err) {
      if (isUniqueViolation(err)) return false; // already offered to this trigger (another instance saw it too)
      throw err;
    }
    const job = await s.jobs.enqueue({ tenantId: t.tenant_id, type: 'workflow.trigger', payload: { firingId: id }, createdBy: t.owner_id, maxAttempts: 3 });
    await this.db('workflow_trigger_firings').where({ id }).update({ job_id: job.id });
    return true;
  }

  // ---------- firing ----------

  /** The owner as a principal now, in the workflow's workspace; a string says why nothing can start. */
  private async owner(t: TriggerRow): Promise<Principal | string> {
    const s = this.s();
    const p = await loadPrincipal(s, t.tenant_id, t.owner_id, {});
    if (!p) return 'the owner is disabled or no longer exists';
    if (!authorize(p, 'agents:run').allow) return 'the owner may no longer run workflows';
    if (t.workspace_id) {
      if (!(await workspacesFor(s, p)).some((w) => w.id === t.workspace_id)) return "the owner is no longer a member of the workflow's workspace";
      p.workspaceId = t.workspace_id;
    } else p.workspaceId = null;
    return p;
  }

  private async finish(f: Pick<FiringRow, 'id' | 'tenant_id' | 'workflow_id' | 'trigger_id' | 'label' | 'event_type'>, kind: TriggerRow['kind'], o: { runId?: string; reason?: string }): Promise<{ run: string } | { skipped: string }> {
    const t = Date.now();
    const result = o.runId ? 'started' : `skipped: ${o.reason ?? ''}`.slice(0, 300);
    await this.db('workflow_trigger_firings').where({ id: f.id }).update({ state: o.runId ? 'started' : 'skipped', run_id: o.runId ?? null, reason: o.reason?.slice(0, 300) ?? null, finished_at: t });
    await this.db('workflow_triggers').where({ id: f.trigger_id }).update({ last_fired_at: t, last_result: result, ...(o.runId ? { last_run_id: o.runId } : {}) });
    this.firings.inc({ kind, result: o.runId ? 'started' : 'skipped' });
    const chain = json<string[]>((await this.db('workflow_trigger_firings').where({ id: f.id }).first('chain'))?.chain, []);
    // Audited as the workflow's own effect, so the audit event cannot start the workflow again.
    await workflowCause.run({ chain: [...chain, f.workflow_id] }, () =>
      this.s().audit.append({ tenantId: f.tenant_id, action: o.runId ? 'workflow.trigger.fired' : 'workflow.trigger.skipped', kind: 'system', actor: { service: 'workflows.triggers' }, target: { workflow: f.workflow_id, trigger: f.trigger_id, firing: f.id, ...(o.runId ? { run: o.runId } : {}) }, label: f.label, detail: { kind, event: f.event_type, ...(o.reason ? { reason: o.reason } : {}) } })
    );
    return o.runId ? { run: o.runId } : { skipped: o.reason ?? 'skipped' };
  }

  /** Starts the run of one firing as the trigger's owner, or records why it cannot. */
  private async start(t: TriggerRow, f: FiringRow, input: Record<string, unknown>): Promise<{ run: string } | { skipped: string }> {
    const s = this.s();
    const p = await this.owner(t);
    if (typeof p === 'string') return this.finish(f, t.kind, { reason: p });
    if (!clears(p.clearance, f.label)) return this.finish(f, t.kind, { reason: `the event is ${f.label}; the owner's clearance is ${p.clearance}` });
    let w;
    try {
      w = await s.workflows.workflow(p, t.workflow_id);
    } catch {
      return this.finish(f, t.kind, { reason: 'the workflow is gone or out of reach' });
    }
    if (w.published_version !== t.version) return this.finish(f, t.kind, { reason: `version ${t.version} is no longer the published version` });
    if (labelRank(f.label) > labelRank(w.label)) return this.finish(f, t.kind, { reason: `the event is ${f.label}; ${w.name} handles data up to ${w.label}` });
    try {
      // The run's trigger names the firing, so the run's scope finds its chain on any instance.
      const run = await workflowCause.run({ chain: [...f.chain, w.id] }, () => s.workflows.start(p, w.id, { input, dry: false, trigger: `${t.kind}:${f.id}` }));
      return await this.finish(f, t.kind, { runId: run.id });
    } catch (err) {
      if (err instanceof HttpProblem && err.status < 500) return this.finish(f, t.kind, { reason: err.detail ?? err.title });
      throw err;
    }
  }

  /** The job of an event firing: claimed once, then started. */
  async fire(firingId: string): Promise<unknown> {
    const raw = await this.db('workflow_trigger_firings').where({ id: firingId }).first();
    if (!raw) return { skipped: 'firing gone' };
    const claimed = await this.db('workflow_trigger_firings').where({ id: firingId, state: 'queued' }).update({ state: 'starting' });
    if (!claimed) return { skipped: `already ${String(raw.state)}` };
    const f = firingFrom({ ...raw, state: 'starting' });
    try {
      const tr = await this.db('workflow_triggers').where({ id: f.trigger_id }).first();
      if (!tr) return await this.finish(f, 'event', { reason: 'the trigger is gone' });
      const t = triggerFrom(tr);
      if (!t.enabled) return await this.finish(f, t.kind, { reason: 'the trigger is disabled' });
      const event = f.event_sealed ? json<TriggerEvent>(await this.s().keys.open(f.tenant_id, f.event_sealed, `wf-firing:${f.id}`), null as unknown as TriggerEvent) : null;
      if (!event) return await this.finish(f, t.kind, { reason: 'the event could not be read' });
      return await this.start(t, f, { event, trigger: { id: t.id, kind: 'event', depth: f.chain.length + 1 } });
    } catch (err) {
      // Given back for the job's retry; a run that started is recorded on the firing and is not started twice.
      await this.db('workflow_trigger_firings').where({ id: firingId, state: 'starting' }).whereNull('run_id').update({ state: 'queued' });
      throw err;
    }
  }

  /** Due schedule triggers; each due time is claimed with one conditional update, so one instance fires it. */
  async tick(now = Date.now()): Promise<{ fired: number; skipped: number }> {
    const due = ((await this.db('workflow_triggers').where({ kind: 'schedule', enabled: true }).whereNotNull('next_run_at').andWhere('next_run_at', '<=', now).orderBy('next_run_at').limit(200)) as Record<string, unknown>[]).map(triggerFrom);
    let fired = 0;
    let skipped = 0;
    for (const t of due) {
      const claimed = await this.db('workflow_triggers').where({ id: t.id, next_run_at: t.next_run_at, enabled: true }).update({ next_run_at: nextCron(t.cron!, now), last_fired_at: now });
      if (!claimed) continue;
      const out = await this.fireSchedule(t).catch((err: Error) => {
        this.s().log.warn({ trigger: t.id, err: err.message }, 'workflow schedule trigger failed');
        return { skipped: err.message };
      });
      if (out && 'run' in out) fired++;
      else skipped++;
    }
    return { fired, skipped };
  }

  private async fireSchedule(t: TriggerRow): Promise<{ run: string } | { skipped: string } | null> {
    const w = (await this.db('workflows').where({ id: t.workflow_id }).first('label')) as { label: Label } | undefined;
    if (!w) return null;
    const id = ulid();
    const dueAt = t.next_run_at ?? Date.now();
    try {
      await this.db('workflow_trigger_firings').insert({ id, tenant_id: t.tenant_id, trigger_id: t.id, workflow_id: t.workflow_id, event_type: 'schedule', event_id: `schedule:${dueAt}`, label: w.label, event_sealed: null, chain: '[]', state: 'starting', run_id: null, reason: null, job_id: null, created_at: Date.now(), finished_at: null });
    } catch (err) {
      if (isUniqueViolation(err)) return null; // this due time already fired
      throw err;
    }
    const f = firingFrom((await this.db('workflow_trigger_firings').where({ id }).first()) as Record<string, unknown>);
    return this.start(t, f, { event: 'schedule', dueAt: new Date(dueAt).toISOString(), trigger: { id: t.id, kind: 'schedule', depth: 1 } });
  }
}
