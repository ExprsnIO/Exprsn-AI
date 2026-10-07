import { ulid } from 'ulid';
import { actorFrom, isUniqueViolation } from '../audit/chain.js';
import { clears, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { conflict, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import { graphSchema, topoOrder } from './graph.js';
import type { RunRow } from './service.js';

/*
 * The dead-letter view of failed workflow runs (Sprint 32b, B-3906), like moderation's dead-letter queue: every run
 * (not a dry run) that fails for good, after its steps' retries and with no failure edge to take, becomes an open dead
 * letter naming the step that failed. A workflow admin redrives it: a replay of the run from that step (the steps
 * before it keep their checkpoints), recorded on the dead letter with who redrove it, and audited. A dead letter is
 * redriven once; the new run, if it fails, is a dead letter of its own.
 */

interface DeadLetterRow {
  id: string;
  tenant_id: string;
  workflow_id: string;
  run_id: string;
  node_id: string | null;
  label: Label;
  error: string | null;
  state: 'open' | 'redriven';
  failed_at: number;
  redriven_by: string | null;
  redriven_at: number | null;
  redrive_run_id: string | null;
}

const num = (v: unknown) => (v == null ? null : Number(v));
const fromRow = (r: Record<string, unknown>): DeadLetterRow => ({ ...(r as unknown as DeadLetterRow), failed_at: Number(r.failed_at), redriven_at: num(r.redriven_at) });

export const deadLetterView = (d: DeadLetterRow, workflow?: string | null) => ({
  id: d.id,
  workflowId: d.workflow_id,
  workflow: workflow ?? null,
  runId: d.run_id,
  nodeId: d.node_id,
  label: d.label,
  error: d.error,
  state: d.state,
  failedAt: d.failed_at,
  redrivenBy: d.redriven_by,
  redrivenAt: d.redriven_at,
  redriveRunId: d.redrive_run_id
});

export class WorkflowDeadLetters {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  install(): void {
    this.s().workflows.useLifecycle({ failed: (run, error) => this.record(run, error) });
  }

  /** The step a failed run stopped at: the first failed or blocked step in graph order. */
  private async failedStep(run: Pick<RunRow, 'id' | 'graph'>): Promise<string | null> {
    const g = graphSchema.parse(JSON.parse(run.graph));
    const steps = (await this.db('workflow_steps').where({ run_id: run.id }).select('node_id', 'state')) as { node_id: string; state: string }[];
    const bad = new Set(steps.filter((s) => s.state === 'failed' || s.state === 'blocked').map((s) => s.node_id));
    return (topoOrder(g) ?? g.nodes.map((n) => n.id)).find((id) => bad.has(id)) ?? null;
  }

  async record(run: RunRow, error: string | null): Promise<void> {
    const s = this.s();
    const node = await this.failedStep(run);
    const id = ulid();
    try {
      await this.db('workflow_dead_letters').insert({ id, tenant_id: run.tenant_id, workflow_id: run.workflow_id, run_id: run.id, node_id: node, label: run.label, error: error?.slice(0, 1000) ?? null, state: 'open', failed_at: Date.now(), redriven_by: null, redriven_at: null, redrive_run_id: null });
    } catch (err) {
      if (isUniqueViolation(err)) return; // recorded already (the run's job ran its last step twice)
      throw err;
    }
    await s.audit.append({ tenantId: run.tenant_id, action: 'workflow.run.dead_lettered', kind: 'system', actor: { service: 'workflows' }, target: { workflow: run.workflow_id, run: run.id, deadLetter: id }, label: run.label, detail: { node, error: error?.slice(0, 300) ?? null } });
  }

  /** Dead letters the caller is cleared for, newest first, optionally of one workflow or in one state. */
  async list(p: Principal, q: { state?: 'open' | 'redriven'; workflow?: string; limit?: number } = {}) {
    const query = this.db('workflow_dead_letters as d').join('workflows as w', 'w.id', 'd.workflow_id').where({ 'd.tenant_id': p.tenantId }).andWhere((x) => (p.workspaceId ? x.where({ 'w.workspace_id': p.workspaceId }) : x.whereNull('w.workspace_id')));
    if (q.state) query.andWhere({ 'd.state': q.state });
    if (q.workflow) query.andWhere((x) => x.where({ 'w.id': q.workflow }).orWhere({ 'w.name': q.workflow }));
    const rows = (await query.orderBy('d.failed_at', 'desc').limit(q.limit ?? 200).select('d.*', 'w.name as wf_name')) as Record<string, unknown>[];
    return rows
      .map((r) => ({ d: fromRow(r), name: r.wf_name as string }))
      .filter(({ d }) => clears(p.clearance, d.label))
      .map(({ d, name }) => deadLetterView(d, name));
  }

  private async row(p: Principal, id: string): Promise<DeadLetterRow> {
    const r = await this.db('workflow_dead_letters').where({ tenant_id: p.tenantId, id }).first();
    if (!r) throw notFound('Dead letter');
    const d = fromRow(r);
    if (!clears(p.clearance, d.label)) throw notFound('Dead letter');
    // In the caller's workspace, as every workflow read is.
    await this.s().workflows.workflow(p, d.workflow_id);
    return d;
  }

  /** Replays the run from the step that failed (from the first step after the trigger when none did). */
  async redrive(p: Principal, id: string, ctx: { ip?: string | null; traceId?: string } = {}) {
    const s = this.s();
    const d = await this.row(p, id);
    if (d.state !== 'open') throw conflict('That run was already redriven.');
    const run = (await this.db('workflow_runs').where({ id: d.run_id }).first('graph')) as { graph: string } | undefined;
    if (!run) throw conflict('The failed run no longer exists.');
    const g = graphSchema.parse(JSON.parse(run.graph));
    const order = topoOrder(g) ?? g.nodes.map((n) => n.id);
    const trigger = g.nodes.find((n) => n.kind === 'trigger')?.id;
    const from = d.node_id && d.node_id !== trigger ? d.node_id : order.find((x) => x !== trigger);
    if (!from) throw conflict('The workflow has no step after its trigger to run again.');
    // Claimed before the replay starts, so two admins redriving at once start one run.
    const n = await this.db('workflow_dead_letters').where({ id: d.id, state: 'open' }).update({ state: 'redriven', redriven_by: p.userId, redriven_at: Date.now() });
    if (!n) throw conflict('That run was already redriven.');
    let replay;
    try {
      replay = await s.workflows.replay(p, d.run_id, from);
    } catch (err) {
      await this.db('workflow_dead_letters').where({ id: d.id }).update({ state: 'open', redriven_by: null, redriven_at: null });
      throw err;
    }
    await this.db('workflow_dead_letters').where({ id: d.id }).update({ redrive_run_id: replay.id });
    await s.audit.append({ tenantId: p.tenantId, action: 'workflow.dead_letter.redriven', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { workflow: d.workflow_id, run: d.run_id, deadLetter: d.id }, label: d.label, detail: { from, newRun: replay.id }, traceId: ctx.traceId ?? null });
    return deadLetterView({ ...d, state: 'redriven', redriven_by: p.userId, redriven_at: Date.now(), redrive_run_id: replay.id });
  }
}
