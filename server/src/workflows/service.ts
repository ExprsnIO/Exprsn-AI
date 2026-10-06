import { ulid } from 'ulid';
import type { Logger } from 'pino';
import { json, type Db } from '../db/knex.js';
import { clears, highest, labelRank, type Label } from '../authz/labels.js';
import { authorize, effectivePermissions, type Principal } from '../authz/policy.js';
import { actorFrom, isUniqueViolation, type AuditLog } from '../audit/chain.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { TOPICS, type Bus } from '../platform/bus.js';
import type { DataKeys } from '../platform/datakeys.js';
import type { JobContext, JobQueue } from '../platform/jobs.js';
import type { Notifications } from '../platform/notifications.js';
import type { QuotaService } from '../tenancy/quotas.js';
import type { Gateway, Lease } from '../gateway/gateway.js';
import { THINK_LEVELS, type ThinkLevel } from '../gateway/repo.js';
import type { ChatMessage, ChatRequest } from '../gateway/ollama.js';
import type { CalcWorker } from '../chat/calc.js';
import type { Guardrails } from '../guardrails/types.js';
import { ToolPending, type ToolCallContext, type ToolDispatcher, type WorkflowToolRunner } from '../registry/dispatch.js';
import { runChecks } from '../registry/checks.js';
import type { EntryRow, RegistryService, SideEffect } from '../registry/service.js';
import {
  BLOCKING,
  checkValue,
  configOf,
  descendants,
  emptyGraph,
  graphSchema,
  guardedByApproval,
  incoming,
  outgoing,
  LIMITS,
  render,
  renderText,
  renderUrl,
  graphVaultRefs,
  headerVaultRef,
  literalAuthorization,
  sampleOf,
  topoOrder,
  toolOutputPort,
  validateGraph,
  type NodeConfig,
  type PortSchema,
  type TemplateScope,
  type ToolInfo,
  type Validation,
  type WfGraph,
  type WfNode
} from './graph.js';
import { internalRequest } from './http.js';
import { handlesFailure, isFailureEdge, nextRetryAt, retryable } from './retry.js';
import type { AllowList } from '../mcp/hosts.js';

export type RunState = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'rejected' | 'cancelled';
export type StepState = 'running' | 'passed' | 'failed' | 'skipped' | 'waiting' | 'blocked';

export interface WorkflowRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  name: string;
  description: string | null;
  label: Label;
  draft: string;
  draft_rev: number;
  published_version: number | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface RunRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  workflow_id: string;
  version: number | null;
  draft_rev: number | null;
  graph: string;
  mode: 'run' | 'dry';
  trigger: string;
  state: RunState;
  input: string | null;
  label: Label;
  created_by: string;
  job_id: string | null;
  replay_of: string | null;
  replay_from: string | null;
  error: string | null;
  tokens: number;
  locked_until: number | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  /** B-1006: who awaits this run's result (an agent run that called the workflow as a tool). */
  caller_kind?: string | null;
  caller_id?: string | null;
}

interface StepRow {
  id: string;
  run_id: string;
  tenant_id: string;
  node_id: string;
  state: StepState;
  output: string | null;
  label: Label;
  attempts: number;
  detail: string | null;
  error: string | null;
  resume_at: number | null;
  started_at: number | null;
  finished_at: number | null;
}

interface ApprovalRow {
  id: string;
  tenant_id: string;
  run_id: string;
  node_id: string;
  role: string;
  state: 'pending' | 'approved' | 'rejected' | 'expired';
  shown: string | null;
  decided_by: string | null;
  reason: string | null;
  due_at: number;
  created_at: number;
  decided_at: number | null;
}

export interface WorkflowDeps {
  db: Db;
  keys: DataKeys;
  gateway: Gateway;
  quotas: QuotaService;
  audit: AuditLog;
  bus: Bus;
  jobs: JobQueue;
  notifications: Notifications;
  calc: CalcWorker;
  /** Sprint 7: tool steps call published registry tools through the dispatcher. */
  registry: RegistryService;
  tools: ToolDispatcher;
  log: Logger;
  /** Read at each check, so a guardrail engine installed after start-up is used. */
  guardrails: () => Guardrails;
  /** The run owner as a principal (null when disabled): runs act with the owner's roles and clearance. */
  principalFor: (tenantId: string, userId: string) => Promise<Principal | null>;
  http: { hosts: string[]; allowLoopback: boolean };
  /** The tenant's outbound host allow-list (Sprint 13), consulted by HTTP steps. */
  tenantHosts?: (tenantId: string) => Promise<AllowList | null>;
  /** B-1006: a run someone awaits (an agent run) finished; the caller picks the result up. */
  onCallerDone?: (tenantId: string, kind: string, id: string) => Promise<void>;
  /**
   * Sprint 25 (B-1705): vault references in HTTP step headers. `check` refuses, at save, a reference the saving
   * principal could not read; `read` resolves one, at use, as the run's principal.
   */
  vault?: { check(p: Principal, refs: string[]): Promise<void>; read(p: Principal, ref: string, via: string): Promise<string> };
}

/** 1.4.0 (B-2206): a record step with its templates rendered. */
export interface RecordStep {
  action: 'create' | 'update' | 'transition';
  app: string;
  entity: string;
  record: string | null;
  values: Record<string, unknown>;
  to: string | null;
}

/** 1.4.0 (B-2206): what runs a record step (the low-code apps), installed with `useRecords`. */
export interface RecordStepRunner {
  runStep(p: Principal, step: RecordStep, ctx: { label: Label; workflowId: string; runId: string; depth: number }): Promise<{ output: Record<string, unknown>; label: Label }>;
}

/**
 * Sprint 32b: what the trigger, dead-letter and chain modules hook into (`useLifecycle`): a version was published (its
 * trigger may start runs by itself, B-3903), a run failed for good (a dead letter, B-3906), and the scope a run
 * executes in (the chain of workflows that caused it, so events its steps cause carry the chain).
 */
export interface WorkflowLifecycle {
  published?(w: WorkflowRow, version: number, g: WfGraph, p: Principal): Promise<void>;
  failed?(run: RunRow, error: string | null): Promise<void>;
  scope?<T>(run: RunRow, fn: () => Promise<T>): Promise<T>;
}

const TERMINAL: RunState[] = ['succeeded', 'failed', 'rejected', 'cancelled'];
const DONE: StepState[] = ['passed', 'failed', 'skipped', 'blocked'];
const JOB = 'workflow.run';
const RUN_JOB_TIMEOUT = LIMITS.maxRunTimeoutMs;
/** How long a caller waits for a workflow published as a tool before the call fails (the run's own limit may be lower). */
export const WORKFLOW_TOOL_TIMEOUT_MS = 5 * 60_000;
const SIDE_RANK: Record<SideEffect, number> = { read: 0, write: 1, destructive: 2 };

/** Where a workflow lives: the scope its tools are resolved in. */
interface WfScope {
  tenantId: string;
  workspaceId: string | null;
}
const scopeOf = (w: Pick<WorkflowRow, 'tenant_id' | 'workspace_id'>): WfScope => ({ tenantId: w.tenant_id, workspaceId: w.workspace_id });
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A step that cannot run with the data it would receive (label ceiling, unavailable kind). */
class StepBlocked extends Error {}
/** A step that failed; the run stops. */
class StepFailed extends Error {}
/** A step paused (approval, wait); the run resumes when it is decided or due. */
const WAIT = Symbol('wait');

const n0 = (v: unknown) => (v == null ? null : Number(v));
const runFrom = (r: Record<string, unknown>): RunRow => ({ ...(r as unknown as RunRow), tokens: Number(r.tokens ?? 0), locked_until: n0(r.locked_until), created_at: Number(r.created_at), started_at: n0(r.started_at), finished_at: n0(r.finished_at), version: n0(r.version), draft_rev: n0(r.draft_rev) });
const stepFrom = (r: Record<string, unknown>): StepRow => ({ ...(r as unknown as StepRow), attempts: Number(r.attempts ?? 0), resume_at: n0(r.resume_at), started_at: n0(r.started_at), finished_at: n0(r.finished_at) });
const wfFrom = (r: Record<string, unknown>): WorkflowRow => ({ ...(r as unknown as WorkflowRow), draft_rev: Number(r.draft_rev), published_version: n0(r.published_version), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });

/** PortSchema to the JSON Schema Ollama takes as `format` for structured output. */
function jsonSchema(s: PortSchema): Record<string, unknown> {
  if (s.type === 'any') return {};
  const out: Record<string, unknown> = { type: s.type };
  if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, jsonSchema(v)]));
  if (s.required) out.required = s.required;
  if (s.items) out.items = jsonSchema(s.items);
  return out;
}

/** The first JSON object or array in a model's answer (tolerates a fenced code block). */
function parseJsonAnswer(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced ? fenced[1]! : text).trim();
  return JSON.parse(body);
}

function compare(op: string, left: unknown, right: unknown): boolean {
  switch (op) {
    case 'truthy':
      return !!left && !(Array.isArray(left) && !left.length);
    case 'exists':
      return left !== undefined && left !== null;
    case 'contains':
      return Array.isArray(left) ? left.some((x) => x === right || String(x) === String(right)) : String(left ?? '').includes(String(right ?? ''));
    case 'eq':
      return left === right || String(left) === String(right);
    case 'ne':
      return !(left === right || String(left) === String(right));
    default: {
      const a = Number(left);
      const b = Number(right);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      return op === 'gt' ? a > b : op === 'gte' ? a >= b : op === 'lt' ? a < b : a <= b;
    }
  }
}

/**
 * Workflows: graphs edited as a draft and published as immutable versions, and runs executed as jobs. Every step's
 * output is persisted (sealed with the tenant key) before the next one starts, so a run that stops half way (an
 * instance restarts, a job is retried) resumes after its last checkpoint and completed steps never run twice.
 * Approvals and waits pause a run without holding a worker; deciding or reaching the time enqueues it again.
 */
export class WorkflowService implements WorkflowToolRunner {
  private records: RecordStepRunner | null = null;
  private lifecycle: WorkflowLifecycle = {};

  constructor(private readonly d: WorkflowDeps) {
    d.jobs.register(JOB, (p, ctx) => this.execute(String(p.runId), ctx), { timeoutMs: RUN_JOB_TIMEOUT });
    d.jobs.register('workflow.approval-timeout', (p) => this.expireApproval(String(p.approvalId)), { timeoutMs: 60_000 });
  }

  /** 1.4.0 (B-2206): record steps go to the low-code apps. */
  useRecords(r: RecordStepRunner): void {
    this.records = r;
  }

  /** Sprint 32b: triggers, dead letters and the run scope (see WorkflowLifecycle). */
  useLifecycle(l: WorkflowLifecycle): void {
    this.lifecycle = { ...this.lifecycle, ...l };
  }

  // ---------- sealing ----------

  private seal(tenantId: string, aad: string, value: unknown): Promise<string> {
    return this.d.keys.seal(tenantId, JSON.stringify(value ?? null), aad);
  }

  private async open<T>(tenantId: string, aad: string, sealed: string | null, fallback: T): Promise<T> {
    if (sealed == null) return fallback;
    return json<T>(await this.d.keys.open(tenantId, sealed, aad), fallback);
  }

  // ---------- workflows ----------

  private scope(p: Principal) {
    return p.workspaceId ? { tenant_id: p.tenantId, workspace_id: p.workspaceId } : { tenant_id: p.tenantId, workspace_id: null };
  }

  async workflow(p: Principal, id: string): Promise<WorkflowRow> {
    const r = await this.d.db('workflows').where(this.scope(p)).andWhere((q) => q.where({ id }).orWhere({ name: id })).first();
    if (!r) throw notFound('Workflow');
    const w = wfFrom(r);
    if (!clears(p.clearance, w.label)) throw notFound('Workflow');
    return w;
  }

  private graphOf(w: WorkflowRow): WfGraph {
    return graphSchema.parse(json(w.draft, emptyGraph()));
  }

  private async version(workflowId: string, version: number): Promise<{ graph: WfGraph; state: string } | undefined> {
    const v = await this.d.db('workflow_versions').where({ workflow_id: workflowId, version }).first();
    return v ? { graph: graphSchema.parse(json(v.graph, emptyGraph())), state: String(v.state) } : undefined;
  }

  /**
   * The validation environment: published profiles (aliases followed), the registry tools the graph's tool steps
   * name as resolved in the workflow's workspace, and the workflow's input label.
   */
  private async env(scope: WfScope, g: WfGraph, label: Label) {
    const rows = await this.d.gateway.repo.profiles(scope.tenantId);
    const names = [...new Set(g.nodes.filter((n) => n.kind === 'tool').map((n) => String(n.config.tool ?? '').trim()).filter(Boolean))];
    const tools = new Map<string, ToolInfo | { missing: string }>();
    for (const name of names) tools.set(name, await this.toolInfo(scope, name));
    return {
      label,
      profile: (name: string) => {
        let t = rows.find((x) => x.name === name || x.id === name);
        for (let i = 0; t?.alias_of && i < 5; i++) t = rows.find((x) => x.id === t!.alias_of);
        return t && !t.alias_of && t.status === 'published' ? { label: t.label } : undefined;
      },
      tool: (name: string) => tools.get(name)
    };
  }

  /** A registry tool as a step sees it, or why it cannot be called from the workspace. */
  private async toolInfo(scope: WfScope, name: string): Promise<ToolInfo | { missing: string }> {
    const e = await this.d.registry.resolve(scope, name);
    if (e) return { name: e.name, version: e.version, impl: e.impl, label: e.label, sideEffect: e.side_effect ?? 'read', confirm: e.confirm, inputSchema: e.input_schema, outputSchema: e.output_schema };
    const [ref] = await this.d.registry.referenceStatus(scope.tenantId, [name]);
    const status = ref?.status ?? null;
    if (!status) return { missing: 'is not in the registry' };
    if (status === 'published' || status === 'deprecated') return { missing: 'is not published to this workspace' };
    return { missing: `is ${status.replace('_', ' ')}, not published` };
  }

  async validate(scope: WfScope, g: WfGraph, label: Label): Promise<Validation> {
    return validateGraph(g, await this.env(scope, g, label));
  }

  async list(p: Principal) {
    const rows = ((await this.d.db('workflows').where(this.scope(p)).orderBy('updated_at', 'desc')) as Record<string, unknown>[]).map(wfFrom).filter((w) => clears(p.clearance, w.label));
    const waiting = (await this.d.db('workflow_runs').where({ tenant_id: p.tenantId, state: 'waiting' }).select('workflow_id')) as { workflow_id: string }[];
    return rows.map((w) => ({ ...this.summary(w), waiting: waiting.filter((x) => x.workflow_id === w.id).length }));
  }

  private summary(w: WorkflowRow) {
    return { id: w.id, name: w.name, description: w.description, label: w.label, draftRev: w.draft_rev, publishedVersion: w.published_version, workspaceId: w.workspace_id, createdBy: w.created_by, updatedBy: w.updated_by, createdAt: w.created_at, updatedAt: w.updated_at };
  }

  async view(p: Principal, id: string) {
    const w = await this.workflow(p, id);
    const draft = this.graphOf(w);
    const versions = (await this.d.db('workflow_versions').where({ workflow_id: w.id }).orderBy('version', 'desc')) as Record<string, unknown>[];
    const published = versions.find((v) => Number(v.version) === w.published_version);
    const dirty = !published || JSON.stringify(json(published.graph, null)) !== JSON.stringify(draft);
    return {
      ...this.summary(w),
      draft,
      dirty,
      validation: await this.validate(scopeOf(w), draft, w.label),
      limits: LIMITS,
      tools: (await this.d.registry.workflowEntries(w.tenant_id, w.id)).map((e) => ({ id: e.id, name: e.name, version: e.version, status: e.status, workflowVersion: Number(e.definition.version), sideEffect: e.side_effect, label: e.label })),
      versions: versions.map((v) => ({ version: Number(v.version), state: String(v.state), note: (v.note as string | null) ?? null, publishedBy: (v.published_by as string | null) ?? null, publishedAt: Number(v.published_at), graph: json<WfGraph>(v.graph, emptyGraph()) }))
    };
  }

  async create(p: Principal, input: { name: string; description?: string | null; label: Label; graph?: WfGraph }): Promise<WorkflowRow> {
    if (!clears(p.clearance, input.label)) throw forbidden(`Your clearance is ${p.clearance}; a ${input.label} workflow is above it.`, { step: 'clearance' });
    await this.checkWorkspace(p, input.label);
    if (input.graph) await this.checkRefs(p, input.graph);
    const t = Date.now();
    const row: WorkflowRow = { id: ulid(), tenant_id: p.tenantId, workspace_id: p.workspaceId ?? null, name: input.name, description: input.description ?? null, label: input.label, draft: JSON.stringify(input.graph ?? emptyGraph()), draft_rev: 1, published_version: null, created_by: p.userId, updated_by: p.userId, created_at: t, updated_at: t };
    try {
      await this.d.db('workflows').insert(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A workflow named ${input.name} exists.`);
      throw err;
    }
    return row;
  }

  /** Sprint 25 (B-1705): no literal Authorization in a graph, and every vault reference readable by the saver. */
  private async checkRefs(p: Principal, g: WfGraph): Promise<void> {
    const literal = literalAuthorization(g);
    if (literal) throw badRequest(literal);
    const refs = graphVaultRefs(g);
    if (refs.length && !this.d.vault) throw badRequest('Vault references cannot be resolved on this server.');
    if (refs.length) await this.d.vault!.check(p, refs);
  }

  private async checkWorkspace(p: Principal, label: Label): Promise<void> {
    if (!p.workspaceId) return;
    const ws = (await this.d.db('workspaces').where({ id: p.workspaceId }).first('label_ceiling')) as { label_ceiling: Label } | undefined;
    if (ws && labelRank(label) > labelRank(ws.label_ceiling)) throw forbidden(`This workspace's ceiling is ${ws.label_ceiling}.`, { step: 'zone' });
  }

  /** Saves the draft. `rev` (the revision the editor started from) guards against overwriting someone else's save. */
  async saveDraft(p: Principal, id: string, input: { graph?: WfGraph; description?: string | null; label?: Label; rev?: number }) {
    const w = await this.workflow(p, id);
    if (input.rev != null && input.rev !== w.draft_rev) throw conflict(`The draft changed since you opened it (revision ${w.draft_rev}, you have ${input.rev}). Reload it and apply your change again.`);
    const upd: Record<string, unknown> = { draft_rev: w.draft_rev + 1, updated_by: p.userId, updated_at: Date.now() };
    if (input.graph) {
      await this.checkRefs(p, input.graph);
      upd.draft = JSON.stringify(input.graph);
    }
    if (input.description !== undefined) upd.description = input.description;
    if (input.label) {
      if (!clears(p.clearance, input.label)) throw forbidden('Above your clearance.', { step: 'clearance' });
      await this.checkWorkspace(p, input.label);
      upd.label = input.label;
    }
    const n = await this.d.db('workflows').where({ id: w.id, draft_rev: w.draft_rev }).update(upd);
    if (n !== 1) throw conflict('The draft changed while saving. Reload it and apply your change again.');
    return this.view(p, w.id);
  }

  /** Validates the draft and publishes it as the next version. Invalid graphs are refused with every problem. */
  async publish(p: Principal, id: string, note: string | null) {
    const w = await this.workflow(p, id);
    const g = this.graphOf(w);
    await this.checkRefs(p, g);
    const v = await this.validate(scopeOf(w), g, w.label);
    if (!v.ok) {
      throw new HttpProblem(422, 'Workflow invalid', `Publishing failed: ${v.errors[0]!.message}${v.errors.length > 1 ? ` (${v.errors.length - 1} more)` : ''}`, { extensions: { errors: v.errors, warnings: v.warnings } });
    }
    const version = (w.published_version ?? 0) + 1;
    const last = (await this.d.db('workflow_versions').where({ workflow_id: w.id }).max({ v: 'version' }).first()) as { v: number | null } | undefined;
    const next = Math.max(version, Number(last?.v ?? 0) + 1);
    await this.d.db.transaction(async (trx) => {
      await trx('workflow_versions').where({ workflow_id: w.id, state: 'published' }).update({ state: 'deprecated' });
      await trx('workflow_versions').insert({ id: ulid(), workflow_id: w.id, tenant_id: w.tenant_id, version: next, graph: JSON.stringify(g), state: 'published', note, published_by: p.userId, published_at: Date.now() });
      await trx('workflows').where({ id: w.id }).update({ published_version: next, updated_at: Date.now(), updated_by: p.userId });
    });
    await this.lifecycle.published?.(w, next, g, p);
    return { version: next, warnings: v.warnings };
  }

  async remove(p: Principal, id: string): Promise<WorkflowRow> {
    const w = await this.workflow(p, id);
    const active = await this.d.db('workflow_runs').where({ workflow_id: w.id }).whereIn('state', ['queued', 'running', 'waiting']).first('id');
    if (active) throw conflict('Runs of this workflow are still in progress or waiting; cancel them first.');
    await this.d.db('workflows').where({ id: w.id }).delete();
    return w;
  }

  // ---------- runs ----------

  private async runRow(id: string): Promise<RunRow | undefined> {
    const r = await this.d.db('workflow_runs').where({ id }).first();
    return r ? runFrom(r) : undefined;
  }

  private async stepRows(runId: string): Promise<Map<string, StepRow>> {
    const rows = ((await this.d.db('workflow_steps').where({ run_id: runId })) as Record<string, unknown>[]).map(stepFrom);
    return new Map(rows.map((r) => [r.node_id, r]));
  }

  /** Starts a run of the published version, or a dry run of the draft (mocked models and calls, no side effects). */
  async start(p: Principal, id: string, input: { input: Record<string, unknown>; dry: boolean; trigger?: string }) {
    const w = await this.workflow(p, id);
    let graph: WfGraph;
    if (input.dry) {
      graph = this.graphOf(w);
      const v = await this.validate(scopeOf(w), graph, w.label);
      const blocking = v.errors.filter((e) => BLOCKING.includes(e.code));
      if (blocking.length) throw new HttpProblem(422, 'Workflow invalid', `The draft cannot run: ${blocking[0]!.message}`, { extensions: { errors: v.errors, warnings: v.warnings } });
    } else {
      if (!w.published_version) throw conflict(`${w.name} has no published version yet; publish it or start a dry run.`);
      graph = (await this.version(w.id, w.published_version))!.graph;
    }
    if (!clears(p.clearance, w.label)) throw forbidden('Above your clearance.', { step: 'clearance' });
    const trigger = graph.nodes.find((n) => n.kind === 'trigger')!;
    if (trigger.output) {
      const err = checkValue(input.input, trigger.output);
      if (err) throw new HttpProblem(400, 'Invalid request', `The run input does not match the trigger: ${err}.`);
    }
    return this.createRun(w, p, { graph, version: input.dry ? null : w.published_version, draftRev: input.dry ? w.draft_rev : null, mode: input.dry ? 'dry' : 'run', trigger: input.trigger ?? 'manual', input: input.input, label: w.label });
  }

  /** `jobRunAt` delays the run's job: a caller executing the run itself leaves the job as a backstop for a restart. */
  private async createRun(w: WorkflowRow, p: Principal, o: { graph: WfGraph; version: number | null; draftRev: number | null; mode: 'run' | 'dry'; trigger: string; input: unknown; label: Label; replayOf?: string; replayFrom?: string; reuse?: StepRow[]; jobRunAt?: number }) {
    const id = ulid();
    const version = o.mode === 'run' ? (o.version ?? w.published_version) : null;
    const row: RunRow = {
      id,
      tenant_id: w.tenant_id,
      workspace_id: w.workspace_id,
      workflow_id: w.id,
      version,
      draft_rev: o.draftRev,
      graph: JSON.stringify(o.graph),
      mode: o.mode,
      trigger: o.trigger,
      state: 'queued',
      input: await this.seal(w.tenant_id, `wfrun:${id}`, o.input),
      label: o.label,
      created_by: p.userId,
      job_id: null,
      replay_of: o.replayOf ?? null,
      replay_from: o.replayFrom ?? null,
      error: null,
      tokens: 0,
      locked_until: null,
      created_at: Date.now(),
      started_at: null,
      finished_at: null
    };
    await this.d.db('workflow_runs').insert(row);
    for (const s of o.reuse ?? []) {
      const stepId = ulid();
      const output = await this.open(s.tenant_id, `wfstep:${s.id}`, s.output, null);
      await this.d.db('workflow_steps').insert({ ...s, id: stepId, run_id: id, output: s.output == null ? null : await this.seal(s.tenant_id, `wfstep:${stepId}`, output), detail: JSON.stringify({ ...json<Record<string, unknown>>(s.detail, {}), reused: s.run_id }), attempts: 0 });
    }
    const job = await this.d.jobs.enqueue({ tenantId: w.tenant_id, type: JOB, payload: { runId: id }, createdBy: p.userId, maxAttempts: 5, ...(o.jobRunAt ? { runAt: o.jobRunAt } : {}) });
    await this.d.db('workflow_runs').where({ id }).update({ job_id: job.id });
    row.job_id = job.id;
    this.emitRun(row, w.name);
    return row;
  }

  /** A new run from a chosen step: steps upstream of it keep their checkpoints, it and everything after run again. */
  async replay(p: Principal, runId: string, fromNode: string) {
    const run = await this.visibleRun(p, runId);
    if (run.created_by !== p.userId && !effectivePermissions(p).has('workflows:manage')) throw forbidden('Only the person who started the run or a workflow admin can replay it.', { step: 'role' });
    if (!TERMINAL.includes(run.state)) throw conflict('Replay a run once it has finished, failed or been cancelled.');
    const w = (await this.workflowById(run.workflow_id))!;
    const g = graphSchema.parse(JSON.parse(run.graph));
    const node = g.nodes.find((n) => n.id === fromNode);
    if (!node) throw notFound('Step');
    if (node.kind === 'trigger') throw conflict('Replay from a step after the trigger; to change the input, start a new run.');
    const again = descendants(g, fromNode);
    const steps = await this.stepRows(run.id);
    const reuse = [...steps.values()].filter((s) => !again.has(s.node_id) && (s.state === 'passed' || s.state === 'skipped'));
    const input = await this.open(run.tenant_id, `wfrun:${run.id}`, run.input, {});
    return this.createRun(w, p, { graph: g, version: run.version, draftRev: run.draft_rev, mode: run.mode, trigger: 'replay', input, label: run.label, replayOf: run.id, replayFrom: fromNode, reuse });
  }

  async cancel(p: Principal, runId: string): Promise<RunRow> {
    const run = await this.visibleRun(p, runId);
    if (TERMINAL.includes(run.state)) return run;
    if (run.created_by !== p.userId && !effectivePermissions(p).has('workflows:manage')) throw forbidden('Only the person who started the run or a workflow admin can cancel it.', { step: 'role' });
    await this.d.db('workflow_runs').where({ id: run.id }).whereNotIn('state', TERMINAL).update({ state: 'cancelled', finished_at: Date.now(), error: 'Cancelled', locked_until: null });
    await this.d.db('workflow_approvals').where({ run_id: run.id, state: 'pending' }).update({ state: 'expired', decided_at: Date.now() });
    if (run.job_id) await this.d.jobs.cancel(run.tenant_id, run.job_id);
    const after = (await this.runRow(run.id))!;
    this.emitRun(after);
    return after;
  }

  private async workflowById(id: string): Promise<WorkflowRow | undefined> {
    const r = await this.d.db('workflows').where({ id }).first();
    return r ? wfFrom(r) : undefined;
  }

  /** Runs a principal may see: their own, every run for workflow admins, and runs waiting on an approval they can give. */
  private async visibleRun(p: Principal, id: string): Promise<RunRow> {
    const run = await this.runRow(id);
    if (!run || run.tenant_id !== p.tenantId) throw notFound('Run');
    if (!clears(p.clearance, run.label)) throw notFound('Run');
    if (run.created_by === p.userId || effectivePermissions(p).has('workflows:manage')) return run;
    const roles = p.roles.includes('system-admin') ? null : p.roles;
    const q = this.d.db('workflow_approvals').where({ run_id: run.id });
    if (roles) q.whereIn('role', roles);
    if (await q.first('id')) return run;
    throw notFound('Run');
  }

  async runs(p: Principal, workflowId: string, limit = 50) {
    const w = await this.workflow(p, workflowId);
    const q = this.d.db('workflow_runs').where({ workflow_id: w.id });
    if (!effectivePermissions(p).has('workflows:manage')) q.andWhere({ created_by: p.userId });
    const rows = ((await q.orderBy('created_at', 'desc').limit(limit)) as Record<string, unknown>[]).map(runFrom).filter((r) => clears(p.clearance, r.label));
    const names = await this.userNames(rows.map((r) => r.created_by));
    const counts = rows.length ? ((await this.d.db('workflow_steps').whereIn('run_id', rows.map((r) => r.id)).select('run_id', 'node_id', 'state')) as { run_id: string; node_id: string; state: StepState }[]) : [];
    return rows.map((r) => ({ ...this.runSummary(r, names), steps: Object.fromEntries(counts.filter((c) => c.run_id === r.id).map((c) => [c.node_id, c.state])) }));
  }

  private async userNames(ids: string[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids.filter(Boolean))];
    if (!uniq.length) return new Map();
    const rows = (await this.d.db('users').whereIn('id', uniq).select('id', 'display_name', 'username')) as { id: string; display_name: string | null; username: string }[];
    return new Map(rows.map((u) => [u.id, u.display_name || u.username]));
  }

  private runSummary(r: RunRow, names: Map<string, string>) {
    return { id: r.id, workflowId: r.workflow_id, version: r.version, draftRev: r.draft_rev, mode: r.mode, trigger: r.trigger, state: r.state, label: r.label, createdBy: r.created_by, createdByName: names.get(r.created_by) ?? null, replayOf: r.replay_of, replayFrom: r.replay_from, error: r.error, tokens: r.tokens, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at };
  }

  /** One run with its steps (outputs above the caller's clearance withheld) and approvals. */
  async runView(p: Principal, id: string) {
    const run = await this.visibleRun(p, id);
    const steps = [...(await this.stepRows(run.id)).values()];
    const approvals = ((await this.d.db('workflow_approvals').where({ run_id: run.id }).orderBy('created_at')) as ApprovalRow[]).map((a) => ({ ...a, due_at: Number(a.due_at), created_at: Number(a.created_at), decided_at: n0(a.decided_at) }));
    const names = await this.userNames([run.created_by, ...approvals.map((a) => a.decided_by ?? '')]);
    return {
      ...this.runSummary(run, names),
      graph: JSON.parse(run.graph) as WfGraph,
      input: clears(p.clearance, run.label) ? await this.open(run.tenant_id, `wfrun:${run.id}`, run.input, null) : null,
      steps: await Promise.all(
        steps.map(async (s) => ({
          nodeId: s.node_id,
          state: s.state,
          label: s.label,
          attempts: s.attempts,
          detail: json<Record<string, unknown>>(s.detail, {}),
          error: s.error,
          output: s.state === 'passed' || s.state === 'waiting' ? (clears(p.clearance, s.label) ? await this.open(s.tenant_id, `wfstep:${s.id}`, s.output, null) : { withheld: `Labelled ${s.label}, above your clearance.` }) : null,
          resumeAt: s.resume_at,
          startedAt: s.started_at,
          finishedAt: s.finished_at
        }))
      ),
      approvals: await Promise.all(approvals.map((a) => this.approvalView(p, a, run, names)))
    };
  }

  private async approvalView(p: Principal, a: ApprovalRow, run: RunRow, names: Map<string, string>) {
    return {
      id: a.id,
      runId: a.run_id,
      nodeId: a.node_id,
      role: a.role,
      state: a.state,
      shown: clears(p.clearance, run.label) ? await this.open(a.tenant_id, `wfapproval:${a.id}`, a.shown, null) : null,
      decidedBy: a.decided_by,
      decidedByName: a.decided_by ? (names.get(a.decided_by) ?? null) : null,
      reason: a.reason ? await this.open(a.tenant_id, `wfreason:${a.id}`, a.reason, null) : null,
      dueAt: a.due_at,
      createdAt: a.created_at,
      decidedAt: a.decided_at,
      canDecide: a.state === 'pending' && this.mayDecide(p, a, run)
    };
  }

  private mayDecide(p: Principal, a: ApprovalRow, run: RunRow): boolean {
    if (!clears(p.clearance, run.label)) return false;
    if (p.roles.includes(a.role) || p.roles.includes('system-admin')) return true;
    // A dry run has no audience: whoever started it decides its approvals.
    return run.mode === 'dry' && run.created_by === p.userId;
  }

  /** Approvals waiting on the caller (by role, or their own dry runs). */
  async pendingApprovals(p: Principal) {
    const rows = ((await this.d.db('workflow_approvals').where({ tenant_id: p.tenantId, state: 'pending' }).orderBy('created_at')) as ApprovalRow[]).map((a) => ({ ...a, due_at: Number(a.due_at), created_at: Number(a.created_at), decided_at: null }));
    const out = [];
    for (const a of rows) {
      const run = await this.runRow(a.run_id);
      if (!run || !this.mayDecide(p, a, run)) continue;
      const w = await this.workflowById(run.workflow_id);
      const node = (JSON.parse(run.graph) as WfGraph).nodes.find((n) => n.id === a.node_id);
      out.push({ ...(await this.approvalView(p, a, run, new Map())), workflowId: run.workflow_id, workflow: w?.name ?? null, step: node?.title ?? a.node_id, label: run.label, mode: run.mode });
    }
    return out;
  }

  async decide(p: Principal, approvalId: string, input: { decision: 'approve' | 'reject'; reason?: string | null }) {
    const a = (await this.d.db('workflow_approvals').where({ tenant_id: p.tenantId, id: approvalId }).first()) as ApprovalRow | undefined;
    if (!a) throw notFound('Approval');
    const run = (await this.runRow(a.run_id))!;
    if (!clears(p.clearance, run.label)) throw forbidden(`The run is ${run.label}; your clearance is ${p.clearance}.`, { step: 'clearance' });
    if (!this.mayDecide(p, a, run)) throw forbidden(`This step waits on the ${a.role} role.`, { step: 'role' });
    if (a.state !== 'pending') throw conflict(`This approval is already ${a.state}.`);
    const approved = input.decision === 'approve';
    const n = await this.d.db('workflow_approvals').where({ id: a.id, state: 'pending' }).update({ state: approved ? 'approved' : 'rejected', decided_by: p.userId, decided_at: Date.now(), reason: input.reason ? await this.seal(a.tenant_id, `wfreason:${a.id}`, input.reason) : null });
    if (n !== 1) throw conflict('Someone decided this approval a moment ago.');
    const step = stepFrom(await this.d.db('workflow_steps').where({ run_id: run.id, node_id: a.node_id }).first());
    const pending = await this.open<Record<string, unknown>>(step.tenant_id, `wfstep:${step.id}`, step.output, {});
    const kind = (JSON.parse(run.graph) as WfGraph).nodes.find((n) => n.id === a.node_id)?.kind;
    if (approved && kind === 'tool') {
      // The call has not happened yet: the step stays waiting and runs again, approved, when the run resumes.
      await this.d.db('workflow_steps').where({ id: step.id }).update({ detail: JSON.stringify({ ...json<Record<string, unknown>>(step.detail, {}), approvedBy: p.userId }) });
    } else if (approved) {
      await this.finishStep(run, step, 'passed', { output: { ...pending, approved: true, by: p.displayName }, detail: { approvedBy: p.userId } });
    } else {
      await this.finishStep(run, step, 'failed', { error: `Rejected by ${p.displayName}${input.reason ? `: ${input.reason}` : ''}`.slice(0, 1000), detail: { rejected: true, rejectedBy: p.userId } });
    }
    this.toApprovers(run, 'workflow.approval', { approvalId: a.id, runId: run.id, workflowId: run.workflow_id, nodeId: a.node_id, role: a.role, state: approved ? 'approved' : 'rejected' });
    if (!TERMINAL.includes(run.state)) await this.resume(run);
    if (run.created_by !== p.userId) {
      const w = await this.workflowById(run.workflow_id);
      await this.d.notifications.notify({ tenantId: run.tenant_id, userIds: [run.created_by], kind: 'workflow', title: `${w?.name ?? 'Workflow'}: ${approved ? 'approved' : 'rejected'}`, body: `${p.displayName} ${approved ? 'approved' : 'rejected'} a step of run ${run.id.slice(-6)}.`, route: 'workflows', label: run.label });
    }
    return { approval: a.id, state: approved ? 'approved' : 'rejected', run: run.id, workflowId: run.workflow_id, label: run.label };
  }

  private async expireApproval(approvalId: string) {
    const a = (await this.d.db('workflow_approvals').where({ id: approvalId }).first()) as ApprovalRow | undefined;
    if (!a || a.state !== 'pending') return { skipped: a?.state ?? 'missing' };
    if (Number(a.due_at) > Date.now()) return { skipped: 'not due' };
    const n = await this.d.db('workflow_approvals').where({ id: a.id, state: 'pending' }).update({ state: 'expired', decided_at: Date.now() });
    if (n !== 1) return { skipped: 'decided' };
    const run = (await this.runRow(a.run_id))!;
    const step = stepFrom(await this.d.db('workflow_steps').where({ run_id: run.id, node_id: a.node_id }).first());
    await this.finishStep(run, step, 'failed', { error: 'Nobody decided in time; the approval expired.' });
    if (!TERMINAL.includes(run.state)) await this.resume(run);
    return { expired: a.id };
  }

  /** Puts a paused run back in the queue. */
  private async resume(run: RunRow, runAt?: number): Promise<void> {
    // A run being executed right now keeps its state; the job below finds it busy and looks again once it pauses.
    if (!runAt) await this.d.db('workflow_runs').where({ id: run.id, state: 'waiting' }).update({ state: 'queued' });
    const job = await this.d.jobs.enqueue({ tenantId: run.tenant_id, type: JOB, payload: { runId: run.id }, createdBy: run.created_by, maxAttempts: 5, ...(runAt ? { runAt, dedupeKey: `wf-wait:${run.id}:${runAt}` } : {}) });
    await this.d.db('workflow_runs').where({ id: run.id }).update({ job_id: job.id });
  }

  // ---------- events ----------

  private emitRun(run: RunRow, name?: string): void {
    const data = { runId: run.id, workflowId: run.workflow_id, workflow: name, state: run.state, mode: run.mode, error: run.error };
    this.d.bus.publish(TOPICS.chatEvent, { userId: run.created_by, event: 'workflow.run', data });
    this.toApprovers(run, 'workflow.run', data);
  }

  private emitStep(run: RunRow, s: Pick<StepRow, 'node_id' | 'state' | 'error' | 'label' | 'attempts'> & { detail?: unknown }): void {
    const data = { runId: run.id, workflowId: run.workflow_id, nodeId: s.node_id, state: s.state, error: s.error, label: s.label, attempts: s.attempts, detail: s.detail ?? null };
    this.d.bus.publish(TOPICS.chatEvent, { userId: run.created_by, event: 'workflow.step', data });
    this.toApprovers(run, 'workflow.step', data);
  }

  /**
   * B-1006: the run's approvers follow it live too: holders of the role of any approval the run asked for, cleared
   * for the run's label, other than the person who started it. Dry runs have no audience but their owner.
   */
  private toApprovers(run: Pick<RunRow, 'id' | 'tenant_id' | 'created_by' | 'label' | 'mode'>, event: string, data: Record<string, unknown>): void {
    if (run.mode === 'dry') return;
    void this.approverIds(run)
      .then((ids) => {
        for (const userId of ids) this.d.bus.publish(TOPICS.chatEvent, { userId, event, data });
      })
      .catch(() => undefined);
  }

  private async approverIds(run: Pick<RunRow, 'id' | 'tenant_id' | 'created_by' | 'label'>): Promise<string[]> {
    const rows = (await this.d.db('workflow_approvals').where({ run_id: run.id }).select('role')) as { role: string }[];
    if (!rows.length) return [];
    // The same people who may open the run (visibleRun): holders of an approval's role.
    const ids = new Set<string>(await this.d.notifications.usersWithRoles(run.tenant_id, [...new Set(rows.map((r) => r.role))]));
    ids.delete(run.created_by);
    if (!ids.size) return [];
    const users = (await this.d.db('users').where({ tenant_id: run.tenant_id, state: 'active' }).whereIn('id', [...ids]).select('id', 'clearance')) as { id: string; clearance: Label }[];
    return users.filter((u) => clears(u.clearance, run.label)).map((u) => u.id);
  }

  // ---------- execution ----------

  private async upsertStep(run: RunRow, nodeId: string, patch: Partial<StepRow>): Promise<StepRow> {
    const existing = await this.d.db('workflow_steps').where({ run_id: run.id, node_id: nodeId }).first();
    if (existing) {
      await this.d.db('workflow_steps').where({ id: existing.id }).update(patch);
      return stepFrom({ ...existing, ...patch });
    }
    const row = { id: ulid(), run_id: run.id, tenant_id: run.tenant_id, node_id: nodeId, state: 'running', output: null, label: run.label, attempts: 0, detail: null, error: null, resume_at: null, started_at: null, finished_at: null, ...patch };
    await this.d.db('workflow_steps').insert(row);
    return stepFrom(row);
  }

  private async finishStep(run: RunRow, step: StepRow, state: StepState, o: { output?: unknown; error?: string; detail?: Record<string, unknown> } = {}): Promise<StepRow> {
    const detail = { ...json<Record<string, unknown>>(step.detail, {}), ...(o.detail ?? {}) };
    const patch: Partial<StepRow> = { state, finished_at: Date.now(), error: o.error?.slice(0, 1000) ?? null, detail: JSON.stringify(detail), resume_at: null };
    if (o.output !== undefined) patch.output = await this.seal(step.tenant_id, `wfstep:${step.id}`, o.output);
    await this.d.db('workflow_steps').where({ id: step.id }).update(patch);
    const after = { ...step, ...patch };
    this.emitStep(run, { ...after, detail });
    return after;
  }

  private async finishRun(run: RunRow, state: RunState, error: string | null = null): Promise<{ state: RunState }> {
    await this.d.db('workflow_runs').where({ id: run.id }).update({ state, error: error?.slice(0, 1000) ?? null, finished_at: TERMINAL.includes(state) ? Date.now() : null, locked_until: null });
    const after = { ...run, state, error };
    this.emitRun(after);
    if (TERMINAL.includes(state)) {
      // Whoever awaited this run (an agent run that called it as a tool) picks the result up now.
      const caller = (await this.d.db('workflow_runs').where({ id: run.id }).first('caller_kind', 'caller_id')) as { caller_kind: string | null; caller_id: string | null } | undefined;
      if (caller?.caller_kind && caller.caller_id) await this.d.onCallerDone?.(run.tenant_id, caller.caller_kind, caller.caller_id).catch((err: unknown) => this.d.log.warn({ run: run.id, err: (err as Error).message }, 'could not resume the caller of a workflow run'));
    }
    if (TERMINAL.includes(state) && state !== 'succeeded' && state !== 'cancelled') {
      await this.d.audit.append({ tenantId: run.tenant_id, action: `workflow.run.${state}`, kind: 'system', actor: { service: 'workflows' }, target: { workflow: run.workflow_id, run: run.id }, label: run.label, detail: { error, mode: run.mode } });
    }
    if (state === 'failed' && run.mode === 'run') await this.lifecycle.failed?.({ ...run, state, error }, error).catch((err: unknown) => this.d.log.warn({ run: run.id, err: (err as Error).message }, 'could not record a dead letter'));
    return { state };
  }

  /** The job: claims the run, walks the graph in topological order and runs every step that is ready. */
  private async execute(runId: string, ctx: Pick<JobContext, 'signal'>): Promise<unknown> {
    const now = Date.now();
    const claimed = await this.d.db('workflow_runs')
      .where({ id: runId })
      .andWhere((q) => q.whereIn('state', ['queued', 'waiting']).orWhere((q2) => q2.where({ state: 'running' }).andWhere((q3) => q3.whereNull('locked_until').orWhere('locked_until', '<', now))))
      .update({ state: 'running', locked_until: now + RUN_JOB_TIMEOUT + 20_000 });
    const run = await this.runRow(runId);
    if (!run) return { skipped: 'missing' };
    if (claimed !== 1) {
      if (TERMINAL.includes(run.state)) return { state: run.state };
      // Another instance is executing it: look again shortly, when it has finished or paused.
      await this.d.jobs.enqueue({ tenantId: run.tenant_id, type: JOB, payload: { runId }, createdBy: run.created_by, runAt: Date.now() + 2000, maxAttempts: 5 });
      return { busy: true };
    }
    run.state = 'running';
    if (!run.started_at) {
      run.started_at = now;
      await this.d.db('workflow_runs').where({ id: run.id }).update({ started_at: now });
    }
    this.emitRun(run);
    try {
      return await (this.lifecycle.scope ? this.lifecycle.scope(run, () => this.walk(run, ctx)) : this.walk(run, ctx));
    } catch (err) {
      const reason = String((ctx.signal.reason as Error | undefined)?.message ?? '');
      if (ctx.signal.aborted && /cancel/.test(reason)) return this.finishRun(run, 'cancelled', 'Cancelled');
      if (ctx.signal.aborted && /shutting down/.test(reason)) {
        // The instance is stopping: give the run back; the job is requeued and resumes after the last checkpoint.
        await this.d.db('workflow_runs').where({ id: run.id }).update({ state: 'queued', locked_until: null });
        throw err;
      }
      this.d.log.warn({ run: run.id, err: (err as Error).message }, 'workflow run crashed');
      return this.finishRun(run, 'failed', `The run stopped unexpectedly: ${(err as Error).message}`);
    }
  }

  private async walk(run: RunRow, ctx: Pick<JobContext, 'signal'>): Promise<unknown> {
    const g = graphSchema.parse(JSON.parse(run.graph));
    const p = await this.d.principalFor(run.tenant_id, run.created_by);
    if (!p) return this.finishRun(run, 'failed', 'The person who started the run is no longer active.');
    p.workspaceId = run.workspace_id;
    const order = topoOrder(g);
    if (!order) return this.finishRun(run, 'failed', 'The graph has a cycle.');
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const steps = await this.stepRows(run.id);
    const input = await this.open<unknown>(run.tenant_id, `wfrun:${run.id}`, run.input, {});
    const outputs: Record<string, unknown> = {};
    for (const s of steps.values()) {
      if (s.state === 'passed') outputs[s.node_id] = await this.open(s.tenant_id, `wfstep:${s.id}`, s.output, null);
      // B-3906: a failure a failure edge handles is what the steps on that edge read.
      else if (s.state === 'failed' && handlesFailure(g, s.node_id)) outputs[s.node_id] = { error: s.error ?? '', step: s.node_id };
    }
    const timeoutMs = g.limits.timeoutMs ?? LIMITS.maxRunTimeoutMs;
    const tokenBudget = g.limits.tokens ?? LIMITS.maxTokens;
    const scope: TemplateScope = { input, steps: outputs };

    for (const id of order) {
      if (ctx.signal.aborted) throw ctx.signal.reason as Error;
      const n = byId.get(id)!;
      const row = steps.get(id);
      if (row && DONE.includes(row.state)) continue;
      const preds = incoming(g, id);
      if (preds.some((e) => !DONE.includes(steps.get(e.from)?.state as StepState))) continue; // upstream still waiting
      const live = preds.filter((e) => {
        const r = steps.get(e.from)!;
        // B-3906: a failure edge is taken when its step failed for good (not when an approver rejected it).
        if (isFailureEdge(e)) return r.state === 'failed' && !json<{ rejected?: boolean }>(r.detail, {}).rejected;
        if (r.state !== 'passed') return false;
        if (byId.get(e.from)!.kind !== 'branch') return true;
        return String((outputs[e.from] as { result?: unknown } | null)?.result === true) === e.branch;
      });
      if (n.kind !== 'trigger' && !live.length) {
        const s = await this.upsertStep(run, id, { state: 'skipped', label: run.label, finished_at: Date.now() });
        steps.set(id, s);
        this.emitStep(run, s);
        continue;
      }
      const label = highest(run.label, ...live.map((e) => steps.get(e.from)!.label), ...(n.raises ? [n.raises] : []));
      const merged = Object.assign({}, ...live.map((e) => (outputs[e.from] && typeof outputs[e.from] === 'object' ? outputs[e.from] : {}))) as Record<string, unknown>;

      const retryAt = row?.state === 'waiting' ? json<{ retryAt?: number }>(row.detail, {}).retryAt : undefined;
      if (row?.state === 'waiting' && retryAt != null) {
        // B-3906: a step waiting to be tried again runs once its time comes.
        if ((row.resume_at ?? 0) > Date.now()) continue;
      } else if (row?.state === 'waiting') {
        if (n.kind === 'wait' && row.resume_at != null && row.resume_at <= Date.now()) {
          const done = await this.finishStep(run, row, 'passed', { output: merged });
          steps.set(id, done);
          outputs[id] = merged;
        }
        // Approvals change state when decided; a tool step someone approved runs again below and makes the call.
        if (n.kind !== 'tool' || !(await this.toolApproved(run.id, id))) continue;
      }

      if (Date.now() - (run.started_at ?? Date.now()) > timeoutMs) return this.finishRun(run, 'failed', `The run went past its timeout of ${Math.round(timeoutMs / 60_000)} minutes.`);

      let step = await this.upsertStep(run, id, { state: 'running', label, attempts: (row?.attempts ?? 0) + 1, started_at: Date.now(), error: null, ...(retryAt != null ? { resume_at: null, detail: JSON.stringify({ ...json<Record<string, unknown>>(row!.detail, {}), retryAt: undefined }) } : {}) });
      steps.set(id, step);
      this.emitStep(run, step);
      const t0 = Date.now();
      try {
        if (n.ceiling && labelRank(label) > labelRank(n.ceiling)) throw new StepBlocked(`Blocked by label ceiling: ${n.title} has ceiling ${n.ceiling}; the data arriving is ${label}.`);
        const stepSignal = AbortSignal.any([ctx.signal, AbortSignal.timeout(n.timeoutMs ?? LIMITS.defaultStepTimeoutMs)]);
        const result = await this.runNode(run, p, n, step, { scope, merged, input, label, signal: stepSignal });
        if (result === WAIT) {
          steps.set(id, stepFrom(await this.d.db('workflow_steps').where({ id: step.id }).first()));
          continue;
        }
        if (n.output && (n.kind !== 'model' || n.config.format === 'json')) {
          const err = checkValue(result.output, n.output);
          if (err) throw new StepFailed(`The output does not match the step's schema: ${err}.`);
        }
        step = await this.finishStep(run, step, 'passed', { output: result.output, detail: { ms: Date.now() - t0, ...(result.detail ?? {}) } });
        steps.set(id, step);
        outputs[id] = result.output;
        if (result.tokens) {
          run.tokens += result.tokens;
          await this.d.db('workflow_runs').where({ id: run.id }).update({ tokens: run.tokens });
          if (run.tokens > tokenBudget) return this.finishRun(run, 'failed', `The run used ${run.tokens.toLocaleString('en-US')} tokens, over its budget of ${tokenBudget.toLocaleString('en-US')}.`);
        }
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        const e = err as Error;
        const timedOut = e.name === 'TimeoutError' || /aborted due to timeout/i.test(e.message);
        const message = timedOut ? `${n.title} took longer than ${Math.round((n.timeoutMs ?? LIMITS.defaultStepTimeoutMs) / 1000)} s.` : err instanceof HttpProblem ? (err.detail ?? err.title) : e.message;
        const blocked = err instanceof StepBlocked;
        // B-3906: a step with a retry policy waits and is tried again, durably, before it fails for good.
        const again = !blocked && retryable(message) ? nextRetryAt(n, step.attempts) : null;
        if (again != null) {
          step = await this.retryLater(run, step, again, message);
          steps.set(id, step);
          continue;
        }
        step = await this.finishStep(run, step, blocked ? 'blocked' : 'failed', { error: message, detail: { ms: Date.now() - t0 } });
        steps.set(id, step);
        // B-3906: a failure edge takes the failure instead of the run.
        if (!blocked && handlesFailure(g, id)) {
          outputs[id] = { error: message, step: id };
          continue;
        }
        // A blocked step skips what depends on it and lets other branches finish; a failure stops the run.
        if (!blocked) return this.finishRun(run, 'failed', `${n.title}: ${message}`);
      }
    }

    const all = [...steps.values()];
    const waitingOn = all.filter((s) => s.state === 'waiting');
    if (waitingOn.length) {
      await this.d.db('workflow_runs').where({ id: run.id }).update({ state: 'waiting', locked_until: null });
      this.emitRun({ ...run, state: 'waiting' });
      const due = waitingOn.map((s) => s.resume_at).filter((x): x is number => x != null);
      if (due.length) await this.resume(run, Math.min(...due));
      return { state: 'waiting', on: waitingOn.map((s) => s.node_id) };
    }
    if (all.some((s) => s.state === 'failed' && json<{ rejected?: boolean }>(s.detail, {}).rejected)) return this.finishRun(run, 'rejected', 'An approver rejected a step.');
    const failed = all.find((s) => (s.state === 'failed' && !handlesFailure(g, s.node_id)) || s.state === 'blocked');
    if (failed) return this.finishRun(run, 'failed', `${byId.get(failed.node_id)?.title ?? failed.node_id}: ${failed.error ?? failed.state}`);
    return this.finishRun(run, 'succeeded');
  }

  /** B-3906: the step waits until `at` and is tried again (the run resumes then, on any instance). */
  private async retryLater(run: RunRow, step: StepRow, at: number, message: string): Promise<StepRow> {
    const detail = { ...json<Record<string, unknown>>(step.detail, {}), retryAt: at, retries: step.attempts, lastError: message.slice(0, 300) };
    const patch: Partial<StepRow> = { state: 'waiting', resume_at: at, error: message.slice(0, 1000), detail: JSON.stringify(detail) };
    await this.d.db('workflow_steps').where({ id: step.id }).update(patch);
    const after = { ...step, ...patch };
    this.emitStep(run, { ...after, detail });
    return after;
  }

  private async runNode(run: RunRow, p: Principal, n: WfNode, step: StepRow, c: { scope: TemplateScope; merged: Record<string, unknown>; input: unknown; label: Label; signal: AbortSignal }): Promise<{ output: unknown; detail?: Record<string, unknown>; tokens?: number } | typeof WAIT> {
    const dry = run.mode === 'dry';
    switch (n.kind) {
      case 'trigger':
        return { output: c.input };
      case 'model':
        return dry ? { output: n.config.format === 'json' ? sampleOf(n.output ?? { type: 'object' }) : { text: `Mocked answer for ${n.title}.` }, detail: { mocked: true } } : this.runModel(run, p, n, c);
      case 'transform': {
        const cfg = configOf(n as WfNode & { kind: 'transform' });
        return { output: Object.fromEntries(Object.entries(cfg.fields).map(([k, t]) => [k, render(t, c.scope)])) };
      }
      case 'branch': {
        const cfg = configOf(n as WfNode & { kind: 'branch' });
        const result = compare(cfg.op, render(cfg.left, c.scope), cfg.right);
        return { output: { ...c.merged, result }, detail: { result } };
      }
      case 'guardrail': {
        const cfg = configOf(n as WfNode & { kind: 'guardrail' });
        const text = renderText(cfg.text, c.scope);
        if (dry) return { output: { ...c.merged, text, action: 'allow' }, detail: { mocked: true } };
        const d = await this.d.guardrails().check({ tenantId: run.tenant_id, workspaceId: run.workspace_id, checkpoint: cfg.checkpoint, text, label: c.label, principal: p, source: { kind: 'workflow-step', id: step.id }, meta: { workflow: run.workflow_id, run: run.id, node: n.id } });
        const detail = { action: d.action, findings: d.findings.map((f) => ({ rule: f.ruleName, action: f.action, stage: f.stage })) };
        if (d.action === 'block') throw new StepFailed(`Blocked by guardrails${d.reason ? `: ${d.reason}` : '.'}`);
        const out = { ...c.merged, text: d.action === 'redact' ? d.text : text, action: d.action };
        if (d.action === 'require-approval') return this.pauseForApproval(run, n, step, cfg.approverRole, cfg.approvalTimeoutMs, out, `${n.title}: ${d.reason ?? 'guardrails asked for an approval'}`);
        return { output: out, detail };
      }
      case 'approval': {
        const cfg = configOf(n as WfNode & { kind: 'approval' });
        const shown = cfg.show ? render(cfg.show, c.scope) : c.merged;
        return this.pauseForApproval(run, n, step, cfg.role, cfg.timeoutMs, c.merged, shown);
      }
      case 'http': {
        const cfg = configOf(n as WfNode & { kind: 'http' });
        const url = renderUrl(cfg.url, c.scope);
        if (dry) return { output: { status: 200, body: null }, detail: { mocked: true, url } };
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(cfg.headers)) {
          const vr = headerVaultRef(v);
          if (!vr) {
            headers[k] = renderText(v, c.scope);
            continue;
          }
          // B-1705: resolved as the run's principal under the vault policies; a denial fails the step.
          if (!this.d.vault) throw new StepFailed(`${n.title}: vault references cannot be resolved on this server.`);
          try {
            headers[k] = vr.prefix + (await this.d.vault.read(p, vr.ref, `workflow:${run.workflow_id}`));
          } catch (err) {
            throw new StepFailed(`${n.title}: ${vr.ref} could not be read from the vault: ${(err as Error).message}`);
          }
        }
        const body = cfg.body != null ? renderText(cfg.body, c.scope) : undefined;
        const res = await internalRequest({ method: cfg.method, url, headers, ...(body != null ? { body } : {}), timeoutMs: n.timeoutMs ?? 30_000, signal: c.signal, allowHosts: this.d.http.hosts, allowLoopback: this.d.http.allowLoopback, tenantAllow: (await this.d.tenantHosts?.(run.tenant_id)) ?? null });
        if (res.status >= 400) throw new StepFailed(`${cfg.method} ${new URL(url).host} answered ${res.status}.`);
        return { output: { status: res.status, body: res.body }, detail: { url, status: res.status } };
      }
      case 'calc': {
        const cfg = configOf(n as WfNode & { kind: 'calc' });
        const r = await this.d.calc.evaluate(renderText(cfg.expression, c.scope));
        return { output: { value: r.decimal, fraction: r.fraction, exact: r.exact }, detail: { exact: r.exact } };
      }
      case 'wait': {
        const cfg = configOf(n as WfNode & { kind: 'wait' });
        if (dry) return { output: c.merged, detail: { mocked: true, skippedWaitMs: cfg.ms } };
        const resumeAt = Date.now() + cfg.ms;
        await this.d.db('workflow_steps').where({ id: step.id }).update({ state: 'waiting', resume_at: resumeAt, output: await this.seal(step.tenant_id, `wfstep:${step.id}`, c.merged) });
        this.emitStep(run, { ...step, state: 'waiting', detail: { resumeAt } });
        return WAIT;
      }
      case 'tool':
        return this.runTool(run, p, n, step, c);
      case 'record': {
        const cfg = configOf(n as WfNode & { kind: 'record' });
        const rendered: RecordStep = { action: cfg.action, app: cfg.app, entity: cfg.entity, record: cfg.record != null ? renderText(cfg.record, c.scope) : null, values: Object.fromEntries(Object.entries(cfg.values).map(([k, t]) => [k, render(t, c.scope)])), to: cfg.to ?? null };
        if (dry) return { output: { id: rendered.record ?? 'mock-record', state: rendered.to, label: c.label, values: rendered.values }, detail: { mocked: true, action: cfg.action } };
        if (!this.records) throw new StepFailed('Record steps are not available on this server.');
        // A run a trigger started carries its depth; the record step passes it on so chains of triggers end.
        const depth = Number((c.input as { trigger?: { depth?: unknown } } | null)?.trigger?.depth ?? 0) || 0;
        try {
          const r = await this.records.runStep(p, rendered, { label: c.label, workflowId: run.workflow_id, runId: run.id, depth });
          return { output: r.output, detail: { action: cfg.action, app: cfg.app, entity: cfg.entity, record: r.output.id } };
        } catch (err) {
          if (err instanceof HttpProblem && err.status === 403 && /label/i.test(err.detail ?? '')) throw new StepBlocked(err.detail ?? err.title);
          throw err;
        }
      }
    }
  }

  private async toolApproved(runId: string, nodeId: string): Promise<boolean> {
    return !!(await this.d.db('workflow_approvals').where({ run_id: runId, node_id: nodeId, state: 'approved' }).first('id'));
  }

  /** The arguments a tool step sends: its `args` templates, or the fields of its input the tool's schema names. */
  private toolArgs(cfg: NodeConfig<'tool'>, c: { scope: TemplateScope; merged: Record<string, unknown> }, schema: Record<string, unknown> | null): Record<string, unknown> {
    if (cfg.args === undefined) {
      const props = isObject(schema?.properties) ? Object.keys(schema.properties) : null;
      return props ? Object.fromEntries(Object.entries(c.merged).filter(([k]) => props.includes(k))) : { ...c.merged };
    }
    if (typeof cfg.args !== 'string') return Object.fromEntries(Object.entries(cfg.args).map(([k, t]) => [k, render(t, c.scope)]));
    let v = render(cfg.args, c.scope);
    if (typeof v === 'string') {
      try {
        v = JSON.parse(v);
      } catch {
        throw new StepFailed('The arguments template does not render to a JSON object.');
      }
    }
    if (!isObject(v)) throw new StepFailed('The arguments template does not render to a JSON object.');
    return v;
  }

  /**
   * A tool step calls a published registry tool through the dispatcher, as the run owner in the run's workspace:
   * the tool must be visible there with a ceiling at least the data's label, the arguments must match its input
   * schema, and the call passes the `tool-call` guardrail checkpoint and the tool's rate limit. A write or
   * destructive tool (or one the checkpoint holds) is called as approved when an Approval step comes before it on
   * every path; otherwise the step pauses for its approver role like an Approval step, and runs again, approved, once
   * someone decides. Dry runs mock the result from the tool's output schema and call nothing.
   */
  private async runTool(run: RunRow, p: Principal, n: WfNode, step: StepRow, c: { scope: TemplateScope; merged: Record<string, unknown>; label: Label; signal: AbortSignal }): Promise<{ output: unknown; detail?: Record<string, unknown> } | typeof WAIT> {
    const cfg = configOf(n as WfNode & { kind: 'tool' });
    const name = cfg.tool.trim();
    const entry = await this.d.registry.resolve(p, name);
    if (!entry) throw new StepFailed(`${name} is not published to this workspace.`);
    if (entry.impl === 'workflow') throw new StepFailed(`${name} is a workflow published as a tool; a workflow cannot call another workflow.`);
    if (labelRank(c.label) > labelRank(entry.label)) throw new StepBlocked(`Blocked by label ceiling: ${name} takes data up to ${entry.label}; the data arriving is ${c.label}.`);
    const base = { tool: entry.name, version: entry.version, sideEffect: entry.side_effect ?? 'read' };
    if (run.mode === 'dry') {
      const port = n.output ?? toolOutputPort({ outputSchema: entry.output_schema });
      return { output: sampleOf(port), detail: { ...base, mocked: true } };
    }
    const { tools, hidden } = await this.d.tools.resolve(p, [name], c.label);
    const tool = tools[0];
    if (!tool) throw new StepFailed(`${name} cannot be called: ${hidden[0]?.reason ?? 'not published to this workspace'}.`);
    const args = this.toolArgs(cfg, c, entry.input_schema);
    const guarded = guardedByApproval(graphSchema.parse(JSON.parse(run.graph)), n.id);
    const decided = !guarded && (await this.toolApproved(run.id, n.id));
    const outcome = await this.d.tools.call({ principal: p, label: c.label, source: { kind: 'workflow-step', id: step.id }, signal: c.signal, approved: guarded || decided }, tool, args);
    if (outcome.needsApproval) {
      return this.pauseForApproval(run, n, step, cfg.approverRole, cfg.approvalTimeoutMs, c.merged, { tool: entry.name, version: entry.version, sideEffect: base.sideEffect, arguments: outcome.arguments, reason: outcome.error });
    }
    if (outcome.denied && /ceiling/.test(outcome.error ?? '')) throw new StepBlocked(`Blocked by label ceiling: ${outcome.error}`);
    if (!outcome.ok) throw new StepFailed(outcome.error ?? `${name} failed.`);
    if (tool.sideEffect !== 'read') {
      await this.d.audit.append({ tenantId: run.tenant_id, action: 'workflow.tool.called', kind: 'system', actor: { service: 'workflows', user: run.created_by }, target: { workflow: run.workflow_id, run: run.id, node: n.id, tool: entry.name, version: entry.version }, label: c.label, detail: { sideEffect: tool.sideEffect, approved: guarded ? 'approval step' : 'at this step', decision: outcome.decision } });
    }
    return {
      output: isObject(outcome.result) ? outcome.result : { result: outcome.result ?? null },
      detail: { ...base, decision: outcome.decision, valid: outcome.valid ?? null, approvedBy: guarded ? 'an approval step' : decided ? 'this step' : null, toolMs: outcome.durationMs, ...(tool.warning ? { warning: tool.warning } : {}) }
    };
  }

  private async pauseForApproval(run: RunRow, n: WfNode, step: StepRow, role: string, timeoutMs: number, pending: unknown, shown: unknown): Promise<typeof WAIT> {
    const id = ulid();
    const due = Date.now() + timeoutMs;
    await this.d.db('workflow_approvals').insert({ id, tenant_id: run.tenant_id, run_id: run.id, node_id: n.id, role, state: 'pending', shown: await this.seal(run.tenant_id, `wfapproval:${id}`, shown), decided_by: null, reason: null, due_at: due, created_at: Date.now(), decided_at: null });
    await this.d.db('workflow_steps').where({ id: step.id }).update({ state: 'waiting', output: await this.seal(step.tenant_id, `wfstep:${step.id}`, pending) });
    this.emitStep(run, { ...step, state: 'waiting', detail: { approval: id, role, dueAt: due } });
    this.toApprovers(run, 'workflow.approval', { approvalId: id, runId: run.id, workflowId: run.workflow_id, nodeId: n.id, role, state: 'pending', dueAt: due });
    await this.d.jobs.enqueue({ tenantId: run.tenant_id, type: 'workflow.approval-timeout', payload: { approvalId: id }, runAt: due, maxAttempts: 3 });
    this.d.bus.emitLocal(TOPICS.integrationEvent, { tenantId: run.tenant_id, type: 'approval.requested', label: run.label, id: `workflow-approval:${id}`, data: { kind: 'workflow', workflow: run.workflow_id, run: run.id, step: n.id, role, dueAt: due } });
    if (run.mode === 'run') {
      const w = await this.workflowById(run.workflow_id);
      const users = (await this.d.notifications.usersWithRoles(run.tenant_id, [role])).filter((u) => u !== run.created_by);
      await this.d.notifications.notify({ tenantId: run.tenant_id, userIds: users, kind: 'workflow', title: 'Workflow approval pending', body: `${w?.name ?? 'A workflow'}, step ${n.title} waits on the ${role} role.`, route: 'workflows', label: run.label, email: true });
    }
    return WAIT;
  }

  private async runModel(run: RunRow, p: Principal, n: WfNode, c: { scope: TemplateScope; label: Label; signal: AbortSignal }): Promise<{ output: unknown; detail: Record<string, unknown>; tokens: number }> {
    const cfg = configOf(n as WfNode & { kind: 'model' });
    const r = await this.d.gateway.resolve(run.tenant_id, cfg.profile);
    if (r.model.state !== 'approved' && r.model.state !== 'deprecated') throw new StepFailed(`Profile ${r.profile.name} routes to ${r.model.name}, which is ${r.model.state}.`);
    const decision = authorize(p, 'inference:invoke', { tenantId: run.tenant_id, label: c.label, zoneCeiling: r.profile.label });
    if (!decision.allow) {
      if (decision.step === 'zone') throw new StepBlocked(`Blocked by label ceiling: profile ${r.profile.name} handles data up to ${r.profile.label}; the data arriving is ${c.label}.`);
      throw new StepFailed(decision.reason);
    }
    const [tenant, ws] = await Promise.all([this.d.db('tenants').where({ id: run.tenant_id }).first('name'), run.workspace_id ? this.d.db('workspaces').where({ id: run.workspace_id }).first('name') : undefined]);
    await this.d.quotas.admit(run.tenant_id, run.workspace_id, { tenantName: tenant?.name, workspaceName: ws?.name });

    const want: ThinkLevel = cfg.think ?? r.profile.think_default;
    const think = THINK_LEVELS.indexOf(want) > THINK_LEVELS.indexOf(r.profile.think_ceiling) ? r.profile.think_ceiling : want;
    const messages: ChatMessage[] = [];
    if (r.profile.system_prompt) messages.push({ role: 'system', content: r.profile.system_prompt });
    messages.push({ role: 'user', content: renderText(cfg.prompt, c.scope) });
    const options: Record<string, unknown> = {};
    if (r.profile.num_ctx) options.num_ctx = r.profile.num_ctx;
    if (r.profile.temperature != null) options.temperature = r.profile.temperature;
    const req: ChatRequest & { format?: unknown } = { model: r.model.name, messages, options };
    if (r.model.capabilities.includes('thinking')) req.think = think === 'off' ? false : r.model.name.startsWith('gpt-oss') ? think : true;
    if (cfg.format === 'json') req.format = n.output ? jsonSchema(n.output) : 'json';

    let lease: Lease | null = null;
    let text = '';
    let prompt = 0;
    let output = 0;
    let gpuMs = 0;
    try {
      lease = await this.d.gateway.acquire(r.profile, r.model, c.label, { signal: c.signal });
      for await (const chunk of lease.client.chat(req, c.signal)) {
        if (chunk.message?.content) text += chunk.message.content;
        if (chunk.done) {
          prompt += chunk.prompt_eval_count ?? 0;
          output += chunk.eval_count ?? 0;
          gpuMs += ((chunk.prompt_eval_duration ?? 0) + (chunk.eval_duration ?? 0) + (chunk.load_duration ?? 0)) / 1e6;
        }
      }
    } finally {
      lease?.release();
    }
    if (!prompt && !output) {
      prompt = Math.ceil(messages.reduce((a, m) => a + m.content.length, 0) / 4);
      output = Math.ceil(text.length / 4);
    }
    await this.d.quotas.record({ tenantId: run.tenant_id, workspaceId: run.workspace_id, userId: run.created_by, kind: 'workflow', profileId: r.profile.id, model: r.model.name, poolId: lease?.pool.id ?? null, promptTokens: prompt, outputTokens: output, gpuMs });
    let value: unknown = { text };
    if (cfg.format === 'json') {
      try {
        value = parseJsonAnswer(text);
      } catch {
        throw new StepFailed("The model's answer is not valid JSON.");
      }
    }
    return { output: value, detail: { profile: r.profile.name, model: r.model.name, instance: lease?.instance.name ?? null, tokens: prompt + output, promptTokens: prompt, outputTokens: output, gpuMs: Math.round(gpuMs) }, tokens: prompt + output };
  }

  /**
   * Tools a tool step in the caller's workspace can call: published (or deprecated) registry tools visible there with
   * their approved schema, newest version per name. Workflow tools are left out, as workflows do not nest.
   */
  async callableTools(p: Principal) {
    const rows = (await this.d.registry.list(p.tenantId, { kind: 'tool' })).filter((e) => (e.status === 'published' || e.status === 'deprecated') && e.approved_hash === e.schema_hash && e.impl !== 'workflow' && this.d.registry.visibleTo(e, p));
    const byName = new Map<string, EntryRow>();
    for (const e of rows.sort((a, b) => b.created_at - a.created_at)) if (!byName.has(e.name) || (byName.get(e.name)!.status !== 'published' && e.status === 'published')) byName.set(e.name, e);
    return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map((e) => ({ name: e.name, version: e.version, description: e.description, impl: e.impl, sideEffect: e.side_effect ?? 'read', confirm: e.confirm, label: e.label, status: e.status, inputSchema: e.input_schema, outputSchema: e.output_schema }));
  }

  // ---------- workflows published as registry tools ----------

  /** The side-effect class the steps of a graph imply: an HTTP write or a write tool makes the workflow write, and so on. */
  private async impliedSideEffect(w: WorkflowRow, g: WfGraph): Promise<{ sideEffect: SideEffect; because: string | null }> {
    let best: SideEffect = 'read';
    let because: string | null = null;
    for (const n of g.nodes) {
      let se: SideEffect = 'read';
      if (n.kind === 'http' && String(n.config.method ?? 'GET') !== 'GET') se = 'write';
      if (n.kind === 'tool') {
        const t = await this.toolInfo(scopeOf(w), String(n.config.tool ?? '').trim());
        if (!('missing' in t)) se = t.sideEffect;
      }
      if (SIDE_RANK[se] > SIDE_RANK[best]) {
        best = se;
        because = n.title;
      }
    }
    return { sideEffect: best, because };
  }

  /**
   * Offers the published version of a workflow as a registry tool (`impl: workflow`) pinned to that version, whose
   * input schema is the trigger's. The registry's automated checks run first (a failing check refuses it, naming
   * the check, as the entry has nothing to edit but what this form sends); then it is submitted for review, and a
   * tool admin other than the author approves it on the Registry screen before anything can call it. The
   * side-effect class cannot be declared below what the steps do.
   */
  async publishAsTool(p: Principal, id: string, input: { name: string; version: string; description: string | null; sideEffect?: SideEffect; label?: Label; ratePerHour?: number | null }): Promise<{ entry: EntryRow; workflow: WorkflowRow }> {
    const w = await this.workflow(p, id);
    if (!w.published_version) throw conflict(`${w.name} has no published version yet; publish it first.`);
    const v = (await this.version(w.id, w.published_version))!;
    const trigger = v.graph.nodes.find((n) => n.kind === 'trigger');
    if (trigger?.output?.type !== 'object') throw conflict(`Give the trigger of ${w.name} an output schema that is an object and publish again: it becomes the tool's input schema.`);
    const implied = await this.impliedSideEffect(w, v.graph);
    const sideEffect = input.sideEffect ?? implied.sideEffect;
    if (SIDE_RANK[sideEffect] < SIDE_RANK[implied.sideEffect]) throw conflict(`${implied.because ?? 'A step'} makes ${w.name} ${implied.sideEffect}; declare ${implied.sideEffect}${implied.sideEffect === 'write' ? ' or destructive' : ''}.`);
    const label = input.label ?? w.label;
    if (labelRank(label) < labelRank(w.label)) throw conflict(`${w.name} is ${w.label}; the tool's max label cannot be lower.`);
    const tool = { name: input.name, version: input.version, description: input.description, sideEffect, inputSchema: jsonSchema(trigger.output), outputSchema: null, definition: { workflowId: w.id, workflowName: w.name, version: w.published_version } };
    const failing = runChecks({ kind: 'tool', ...tool }).filter((c) => !c.ok);
    if (failing.length) throw new HttpProblem(422, 'Checks failed', failing.map((c) => `${c.name}: ${c.detail}`).join(' '), { extensions: { checks: failing } });
    const entry = await this.d.registry.create(p, { kind: 'tool', impl: 'workflow', ratePerHour: input.ratePerHour ?? null, label, ...tool });
    return { entry: await this.d.registry.submit(entry), workflow: w };
  }

  /** Why a workflow tool cannot run: its workflow or its pinned version is gone. */
  async unavailable(entry: EntryRow): Promise<string | null> {
    const w = await this.workflowById(String(entry.definition.workflowId ?? ''));
    if (!w || w.tenant_id !== entry.tenant_id) return 'its workflow was deleted';
    if (!(await this.version(w.id, Number(entry.definition.version)))) return `version ${String(entry.definition.version)} of ${w.name} no longer exists`;
    return null;
  }

  /**
   * The dispatcher runs a workflow tool here: a run of the pinned version as the caller, with the arguments as its
   * input, executed in this call (so a caller that is itself a job never waits on a free worker) within
   * `WORKFLOW_TOOL_TIMEOUT_MS` or the workflow's own shorter limit. The result is `{run, output}`, the output of the
   * steps nothing follows. A run that pauses on an approval carries on without the caller, which gets an error
   * naming the run. Workflows do not call workflows, and a result above the caller's label is not returned.
   */
  async runAsTool(ctx: ToolCallContext, entry: EntryRow, args: Record<string, unknown>): Promise<unknown> {
    if (ctx.source?.kind === 'workflow-step') throw new Error('A workflow cannot call another workflow.');
    const p = ctx.principal;
    const w = await this.workflowById(String(entry.definition.workflowId ?? ''));
    if (!w || w.tenant_id !== p.tenantId) throw new Error('The workflow behind this tool no longer exists.');
    const version = Number(entry.definition.version);
    const v = await this.version(w.id, version);
    if (!v) throw new Error(`Version ${version} of ${w.name} no longer exists.`);
    const label = highest(w.label, ctx.label);
    if (!clears(p.clearance, label)) throw new Error(`A run of ${w.name} is ${label}, above your clearance.`);
    const trigger = v.graph.nodes.find((n) => n.kind === 'trigger');
    const bad = trigger?.output ? checkValue(args, trigger.output) : null;
    if (bad) throw new Error(`The arguments do not match the trigger of ${w.name}: ${bad}.`);
    const limit = Math.min(v.graph.limits.timeoutMs ?? WORKFLOW_TOOL_TIMEOUT_MS, WORKFLOW_TOOL_TIMEOUT_MS);
    const run = await this.createRun(w, p, { graph: v.graph, version, draftRev: null, mode: 'run', trigger: 'tool', input: args, label, jobRunAt: Date.now() + limit + 30_000 });
    await this.d.audit.append({ tenantId: w.tenant_id, action: 'workflow.run.started', kind: 'system', actor: { service: 'tools', user: p.userId }, target: { workflow: w.id, run: run.id }, label, detail: { version, tool: entry.name, source: ctx.source ?? null } });

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error(`${entry.name} went past its time limit of ${Math.round(limit / 1000)} s`)), limit);
    const onAbort = () => ac.abort(ctx.signal!.reason);
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await this.execute(run.id, { signal: ac.signal });
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
    }
    const after = (await this.runRow(run.id))!;
    if (after.state === 'waiting') {
      // B-1006: an agent run awaits the result; it resumes when this run finishes. Other callers cannot wait.
      if (ctx.source?.kind === 'agent-run') {
        await this.d.db('workflow_runs').where({ id: run.id }).update({ caller_kind: 'agent-run', caller_id: ctx.source.id });
        throw new ToolPending({ kind: 'workflow-run', id: run.id }, `Run ${run.id} of ${w.name} is waiting on an approval. This run pauses and continues with its result once the workflow finishes.`);
      }
      throw new ToolPending({ kind: 'workflow-run', id: run.id }, `Run ${run.id} of ${w.name} is waiting on an approval. It continues once someone decides; its result does not come back to this call.`);
    }
    return this.toolOutput(ctx, w, after, v.graph);
  }

  private async toolOutput(ctx: ToolCallContext, w: WorkflowRow, run: RunRow, g: WfGraph): Promise<{ run: string; output: unknown }> {
    if (run.state !== 'succeeded') throw new Error(`Run ${run.id} of ${w.name} ${run.state}${run.error ? `: ${run.error}` : ''}.`);
    const out = await this.runOutput(run, g);
    if (labelRank(out.label) > labelRank(ctx.label)) throw new Error(`The result of ${w.name} is labelled ${out.label}, above the ${ctx.label} data it was called from.`);
    return { run: run.id, output: out.value };
  }

  /**
   * The result of a workflow tool run that paused (B-1006), for the caller that awaited it: pending while it runs or
   * waits, its output once it succeeded (under the same label rule as an immediate result), or why it did not.
   */
  async toolResult(ctx: ToolCallContext, entry: EntryRow, runId: string): Promise<{ state: 'pending' } | { state: 'done'; result: unknown } | { state: 'failed'; error: string }> {
    const run = await this.runRow(runId);
    const w = run ? await this.workflowById(run.workflow_id) : undefined;
    if (!run || !w || run.tenant_id !== ctx.principal.tenantId || w.id !== String(entry.definition.workflowId ?? '')) return { state: 'failed', error: 'The workflow run behind this call no longer exists.' };
    if (!TERMINAL.includes(run.state)) return { state: 'pending' };
    try {
      return { state: 'done', result: await this.toolOutput(ctx, w, run, JSON.parse(run.graph) as WfGraph) };
    } catch (err) {
      return { state: 'failed', error: (err as Error).message };
    }
  }

  /** A finished run's result: the outputs of the passed steps nothing follows, merged, and the highest of their labels. */
  private async runOutput(run: RunRow, g: WfGraph): Promise<{ value: unknown; label: Label }> {
    const steps = await this.stepRows(run.id);
    const sinks = g.nodes.filter((n) => !outgoing(g, n.id).length).map((n) => steps.get(n.id)).filter((s): s is StepRow => s?.state === 'passed');
    const values = await Promise.all(sinks.map((s) => this.open<unknown>(s.tenant_id, `wfstep:${s.id}`, s.output, null)));
    const value = values.length === 1 ? values[0] : Object.assign({}, ...values.filter(isObject));
    return { value, label: highest(run.label, ...sinks.map((s) => s.label)) };
  }

  /** Audit helper for routes. */
  audit(p: Principal, action: string, target: Record<string, unknown>, o: { label?: Label; detail?: Record<string, unknown>; ip?: string | null; traceId?: string } = {}) {
    return this.d.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, o.ip), target, ...(o.label ? { label: o.label } : {}), ...(o.detail ? { detail: o.detail } : {}), traceId: o.traceId ?? null });
  }
}
