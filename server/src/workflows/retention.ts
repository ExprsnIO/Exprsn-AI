import { ulid } from 'ulid';
import { actorFrom, PLATFORM_TENANT } from '../audit/chain.js';
import { clears, isLabel, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import type { Kept } from '../compliance/evidence.js';
import type { Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';

/*
 * Run retention (1.8.0, Sprint 46, B-135; migration 086). Finished workflow runs are pruned by policy, with their
 * steps (the sealed checkpoints), map and loop items, approvals and their redriven dead letters:
 *
 * - The tenant's policy, with defaults: finished runs kept RETENTION_DEFAULTS.runDays days, failed runs
 *   RETENTION_DEFAULTS.failedDays, and at most RETENTION_DEFAULTS.maxRuns finished runs per workflow (the oldest
 *   beyond that go). A workflow may override any of the three; what it leaves out falls back to the tenant's.
 * - Never pruned: runs that are queued, running or waiting (an approval or a wait), runs that finished within the
 *   last RETENTION_GRACE_MS (a caller may still be reading the result), dry runs are pruned like the others, runs
 *   with an open dead letter, and runs under a legal hold (`s.legalHolds.held`: their owner or their workspace) or
 *   kept as evidence (`s.evidence.keptOf(tenant, 'workflow-run')`, a hold of scope `object` on one run). What a
 *   hold or evidence keeps is told to `s.evidence.recordSkip` once per run and reason.
 * - The job `workflow.retention` runs every RETENTION_SWEEP_MS per active tenant; an admin may prune now or ask
 *   for a dry run's counts. Each prune that removes anything (and each prune by an admin) writes one summary audit
 *   entry, `workflow.retention.pruned`.
 */

export const RETENTION_DEFAULTS = { runDays: 90, failedDays: 180, maxRuns: 1000 } as const;
export const RETENTION_JOB = 'workflow.retention';
export const RETENTION_SWEEP_MS = 6 * 3_600_000;
export const RETENTION_GRACE_MS = 24 * 3_600_000;
/** The moderated object type of a workflow run, so a legal hold of scope `object` can name one. */
export const RUN_OBJECT = 'workflow-run';
const PATH = 'workflow.retention';
const TERMINAL = ['succeeded', 'failed', 'rejected', 'cancelled'];
const BATCH = 200;
const DAY = 86_400_000;

export interface RetentionPolicy {
  runDays: number;
  failedDays: number;
  maxRuns: number;
}
export type RetentionOverride = { [K in keyof RetentionPolicy]: number | null };

interface PolicyRow {
  id: string;
  tenant_id: string;
  scope: 'tenant' | 'workflow';
  scope_id: string;
  run_days: number | null;
  failed_days: number | null;
  max_runs: number | null;
  last_run_at: number | null;
  last_pruned: number | null;
  updated_by: string | null;
  updated_at: number;
}

export interface PruneResult {
  dryRun: boolean;
  runs: number;
  steps: number;
  items: number;
  approvals: number;
  deadLetters: number;
  workflows: number;
  kept: { active: number; deadLetter: number; legalHold: number; evidence: number; recent: number };
}

const n0 = (v: unknown) => (v == null ? null : Number(v));
const overrideOf = (r: PolicyRow | undefined): RetentionOverride => ({ runDays: n0(r?.run_days), failedDays: n0(r?.failed_days), maxRuns: n0(r?.max_runs) });
const fill = (o: RetentionOverride, base: RetentionPolicy): RetentionPolicy => ({ runDays: o.runDays ?? base.runDays, failedDays: o.failedDays ?? base.failedDays, maxRuns: o.maxRuns ?? base.maxRuns });
const count = async (q: Promise<unknown>): Promise<number> => Number(((await q) as { n?: number | string }[])[0]?.n ?? 0);

interface Ctx {
  ip?: string | null;
  traceId?: string;
}

export class WorkflowRetention {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  registerJobs(): void {
    this.s().jobs.register(RETENTION_JOB, async (p, ctx) => this.prune(String(p.tenantId ?? ctx.job.tenant_id), { dryRun: false }), { timeoutMs: 30 * 60_000 });
  }

  schedule(scheduler: Scheduler): void {
    scheduler.every(RETENTION_JOB, RETENTION_SWEEP_MS, async () => (await this.s().tenants.list()).filter((t) => t.state === 'active' && t.id !== PLATFORM_TENANT).map((t) => ({ tenantId: t.id, payload: { tenantId: t.id } })));
  }

  /** A workflow run as a moderated object, so compliance can place a legal hold of scope `object` on one run. */
  install(): void {
    const reg = this.s().moderation.registry;
    if (reg.get(RUN_OBJECT)) return;
    reg.register({
      type: RUN_OBJECT,
      description: 'A workflow run (its input, steps and outputs); holds keep it from run retention',
      resolve: async (tenantId, id) => {
        const r = (await this.db('workflow_runs').where({ tenant_id: tenantId, id }).first('id', 'workspace_id', 'label', 'created_by', 'state')) as { id: string; workspace_id: string | null; label: string; created_by: string; state: string } | undefined;
        return r ? { type: RUN_OBJECT, id: r.id, tenantId, workspaceId: r.workspace_id, label: isLabel(r.label) ? r.label : 'internal', ownerId: r.created_by, state: r.state } : null;
      },
      canRead: async (p, o, workspaces) => clears(p.clearance, o.label) && (!o.workspaceId || workspaces.includes(o.workspaceId))
    });
  }

  // ---------- policies ----------

  private async rowOf(tenantId: string, scope: 'tenant' | 'workflow', scopeId: string): Promise<PolicyRow | undefined> {
    return (await this.db('workflow_retention').where({ tenant_id: tenantId, scope, scope_id: scopeId }).first()) as PolicyRow | undefined;
  }

  /** The tenant's policy with the defaults filled in. */
  async tenantPolicy(tenantId: string): Promise<RetentionPolicy> {
    return fill(overrideOf(await this.rowOf(tenantId, 'tenant', tenantId)), RETENTION_DEFAULTS);
  }

  async tenantView(p: Principal) {
    const r = await this.rowOf(p.tenantId, 'tenant', p.tenantId);
    return { policy: fill(overrideOf(r), RETENTION_DEFAULTS), set: overrideOf(r), defaults: RETENTION_DEFAULTS, graceHours: RETENTION_GRACE_MS / 3_600_000, sweepHours: RETENTION_SWEEP_MS / 3_600_000, lastRunAt: n0(r?.last_run_at), lastPruned: n0(r?.last_pruned), updatedAt: n0(r?.updated_at), updatedBy: r?.updated_by ?? null };
  }

  private async upsert(tenantId: string, scope: 'tenant' | 'workflow', scopeId: string, o: RetentionOverride, by: string): Promise<void> {
    const values = { run_days: o.runDays, failed_days: o.failedDays, max_runs: o.maxRuns, updated_by: by, updated_at: Date.now() };
    const n = await this.db('workflow_retention').where({ tenant_id: tenantId, scope, scope_id: scopeId }).update(values);
    if (!n) await this.db('workflow_retention').insert({ id: ulid(), tenant_id: tenantId, scope, scope_id: scopeId, ...values });
  }

  async setTenant(p: Principal, o: RetentionOverride, ctx: Ctx = {}) {
    const before = overrideOf(await this.rowOf(p.tenantId, 'tenant', p.tenantId));
    await this.upsert(p.tenantId, 'tenant', p.tenantId, o, p.userId);
    await this.s().audit.append({ tenantId: p.tenantId, action: 'workflow.retention.updated', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { tenant: p.tenantId }, detail: { scope: 'tenant', before, after: o }, traceId: ctx.traceId ?? null });
    return this.tenantView(p);
  }

  /** A workflow's override and the policy in force for it. */
  async workflowView(p: Principal, ref: string) {
    const w = await this.s().workflows.workflow(p, ref);
    const tenant = await this.tenantPolicy(w.tenant_id);
    const r = await this.rowOf(w.tenant_id, 'workflow', w.id);
    const o = overrideOf(r);
    return { workflowId: w.id, override: o, tenant, effective: fill(o, tenant), updatedAt: n0(r?.updated_at), updatedBy: r?.updated_by ?? null };
  }

  async setWorkflow(p: Principal, ref: string, o: RetentionOverride, ctx: Ctx = {}) {
    const w = await this.s().workflows.workflow(p, ref);
    const before = overrideOf(await this.rowOf(w.tenant_id, 'workflow', w.id));
    if (o.runDays == null && o.failedDays == null && o.maxRuns == null) await this.db('workflow_retention').where({ tenant_id: w.tenant_id, scope: 'workflow', scope_id: w.id }).delete();
    else await this.upsert(w.tenant_id, 'workflow', w.id, o, p.userId);
    await this.s().audit.append({ tenantId: p.tenantId, action: 'workflow.retention.updated', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { workflow: w.id }, label: w.label, detail: { scope: 'workflow', before, after: o }, traceId: ctx.traceId ?? null });
    return this.workflowView(p, w.id);
  }

  // ---------- pruning ----------

  /** Active legal holds on users and workspaces, by subject, with the hold that keeps them (for `recordSkip`). */
  private async holds(tenantId: string): Promise<{ users: Map<string, string>; workspaces: Map<string, string> }> {
    const held = await this.s().legalHolds.held(tenantId);
    const out = { users: new Map<string, string>(), workspaces: new Map<string, string>() };
    if (!held.users.length && !held.workspaces.length) return out;
    // `held()` answers who is held; the hold's id is what a skip records as its reason.
    const rows = (await this.db('legal_holds').where({ tenant_id: tenantId, state: 'active' }).whereIn('scope', ['user', 'workspace']).select('id', 'scope', 'scope_id')) as { id: string; scope: 'user' | 'workspace'; scope_id: string }[];
    for (const r of rows) (r.scope === 'user' ? out.users : out.workspaces).set(r.scope_id, r.id);
    for (const u of held.users) if (!out.users.has(u)) out.users.set(u, `user:${u}`);
    for (const ws of held.workspaces) if (!out.workspaces.has(ws)) out.workspaces.set(ws, `workspace:${ws}`);
    return out;
  }

  /**
   * Prunes (or, with `dryRun`, counts) the tenant's runs past their policy. `workflow` limits it to one workflow;
   * `actor` is the admin who asked (the scheduled job has none).
   */
  async prune(tenantId: string, o: { dryRun: boolean; workflow?: string; actor?: Principal; ctx?: Ctx }): Promise<PruneResult> {
    const s = this.s();
    const now = Date.now();
    const tenant = await this.tenantPolicy(tenantId);
    const overrides = new Map(((await this.db('workflow_retention').where({ tenant_id: tenantId, scope: 'workflow' })) as PolicyRow[]).map((r) => [r.scope_id, overrideOf(r)]));
    const wq = this.db('workflows').where({ tenant_id: tenantId });
    if (o.workflow) wq.andWhere({ id: o.workflow });
    let workflows = (await wq.select('id', 'label', 'workspace_id')) as { id: string; label: Label; workspace_id: string | null }[];
    // An admin's "prune now" reaches the workflows they may open (their workspace's and the tenant's, within their
    // clearance); the scheduled sweep reaches every workflow of the tenant.
    const a = o.actor;
    if (a) workflows = workflows.filter((w) => clears(a.clearance, w.label) && (!w.workspace_id || w.workspace_id === a.workspaceId));
    const holds = await this.holds(tenantId);
    const evidence = await s.evidence.keptOf(tenantId, RUN_OBJECT);
    const out: PruneResult = { dryRun: o.dryRun, runs: 0, steps: 0, items: 0, approvals: 0, deadLetters: 0, workflows: 0, kept: { active: 0, deadLetter: 0, legalHold: 0, evidence: 0, recent: 0 } };
    const skips: { id: string; k: Kept }[] = [];

    for (const w of workflows) {
      const pol = fill(overrides.get(w.id) ?? { runDays: null, failedDays: null, maxRuns: null }, tenant);
      const due = new Set<string>();
      // By age: finished runs past their period (failed runs have their own).
      const old = (await this.db('workflow_runs')
        .where({ tenant_id: tenantId, workflow_id: w.id })
        .andWhere((q) => q.where((x) => x.where({ state: 'failed' }).andWhereRaw('coalesce(finished_at, created_at) < ?', [now - pol.failedDays * DAY])).orWhere((x) => x.whereIn('state', ['succeeded', 'rejected', 'cancelled']).andWhereRaw('coalesce(finished_at, created_at) < ?', [now - pol.runDays * DAY])))
        .select('id')) as { id: string }[];
      for (const r of old) due.add(r.id);
      // By count: the finished runs beyond the newest maxRuns.
      const over = (await this.db('workflow_runs').where({ tenant_id: tenantId, workflow_id: w.id }).whereIn('state', TERMINAL).orderBy('created_at', 'desc').orderBy('id', 'desc').offset(pol.maxRuns).limit(100_000).select('id')) as { id: string }[];
      for (const r of over) due.add(r.id);
      // Runs that are still going and would be due by age are counted as kept.
      out.kept.active += await count(this.db('workflow_runs').where({ tenant_id: tenantId, workflow_id: w.id }).whereNotIn('state', TERMINAL).andWhere('created_at', '<', now - pol.runDays * DAY).count({ n: '*' }));
      if (!due.size) continue;

      const ids = [...due];
      const rows: { id: string; created_by: string; workspace_id: string | null; finished_at: number | null }[] = [];
      for (let i = 0; i < ids.length; i += 500) rows.push(...((await this.db('workflow_runs').whereIn('id', ids.slice(i, i + 500)).select('id', 'created_by', 'workspace_id', 'finished_at')) as typeof rows));
      const openDead = new Set<string>();
      for (let i = 0; i < ids.length; i += 500) for (const d of (await this.db('workflow_dead_letters').whereIn('run_id', ids.slice(i, i + 500)).andWhere({ state: 'open' }).select('run_id')) as { run_id: string }[]) openDead.add(d.run_id);
      const prune: string[] = [];
      for (const r of rows) {
        if (r.finished_at != null && Number(r.finished_at) > now - RETENTION_GRACE_MS) {
          out.kept.recent++;
          continue;
        }
        if (openDead.has(r.id)) {
          out.kept.deadLetter++;
          continue;
        }
        const ev = evidence.get(r.id);
        if (ev) {
          if (ev.reason === 'legal-hold') out.kept.legalHold++;
          else out.kept.evidence++;
          skips.push({ id: r.id, k: ev });
          continue;
        }
        const hold = holds.users.get(r.created_by) ?? (r.workspace_id ? holds.workspaces.get(r.workspace_id) : undefined);
        if (hold) {
          out.kept.legalHold++;
          skips.push({ id: r.id, k: { reason: 'legal-hold', ref: hold } });
          continue;
        }
        prune.push(r.id);
      }
      if (!prune.length) continue;
      out.workflows++;
      for (let i = 0; i < prune.length; i += BATCH) {
        const batch = prune.slice(i, i + BATCH);
        if (o.dryRun) {
          out.steps += await count(this.db('workflow_steps').whereIn('run_id', batch).count({ n: '*' }));
          out.items += await count(this.db('workflow_items').whereIn('run_id', batch).count({ n: '*' }));
          out.approvals += await count(this.db('workflow_approvals').whereIn('run_id', batch).count({ n: '*' }));
          out.deadLetters += await count(this.db('workflow_dead_letters').whereIn('run_id', batch).count({ n: '*' }));
          out.runs += batch.length;
          continue;
        }
        // Children first (no database relies on the cascade), then the runs; the sealed outputs go with their rows.
        out.items += await this.db('workflow_items').whereIn('run_id', batch).delete();
        out.steps += await this.db('workflow_steps').whereIn('run_id', batch).delete();
        out.approvals += await this.db('workflow_approvals').whereIn('run_id', batch).delete();
        out.deadLetters += await this.db('workflow_dead_letters').whereIn('run_id', batch).whereNot({ state: 'open' }).delete();
        // A run still waiting or with an open dead letter never reaches here; the state is checked again on delete.
        out.runs += await this.db('workflow_runs').whereIn('id', batch).whereIn('state', TERMINAL).delete();
      }
    }

    if (!o.dryRun) {
      for (const x of skips) await s.evidence.recordSkip(tenantId, RUN_OBJECT, x.id, PATH, x.k);
      const mark = { last_run_at: now, last_pruned: out.runs };
      if (!(await this.db('workflow_retention').where({ tenant_id: tenantId, scope: 'tenant', scope_id: tenantId }).update(mark))) await this.db('workflow_retention').insert({ id: ulid(), tenant_id: tenantId, scope: 'tenant', scope_id: tenantId, run_days: null, failed_days: null, max_runs: null, updated_by: null, updated_at: now, ...mark });
    }
    if (o.actor || (!o.dryRun && out.runs)) {
      await s.audit.append({
        tenantId,
        action: 'workflow.retention.pruned',
        kind: o.actor ? 'admin' : 'system',
        actor: o.actor ? actorFrom(o.actor, o.ctx?.ip ?? null) : { service: PATH },
        target: o.workflow ? { workflow: o.workflow } : { tenant: tenantId },
        detail: { ...out, policy: tenant, overrides: overrides.size },
        traceId: o.ctx?.traceId ?? null
      });
    }
    return out;
  }

  /** "Prune now" from the console: the tenant's runs, or one workflow's, as the admin; a dry run only counts. */
  async pruneNow(p: Principal, o: { dryRun: boolean; workflow?: string }, ctx: Ctx = {}) {
    const workflow = o.workflow ? (await this.s().workflows.workflow(p, o.workflow)).id : undefined;
    return this.prune(p.tenantId, { dryRun: o.dryRun, ...(workflow ? { workflow } : {}), actor: p, ctx });
  }
}
