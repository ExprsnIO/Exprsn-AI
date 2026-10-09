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
import { ToolPending, type CalleeResult, type ToolCallContext, type ToolDispatcher, type WorkflowToolRunner } from '../registry/dispatch.js';
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
import type { StoredForm, WorkflowStepKit } from './steps/index.js';
import type { AllowList } from '../mcp/hosts.js';
import { ChainLimit, chainScope, type ChainCtx, type ChainErrorType, type ChainKind, type ChainRef, type ChainService } from '../chain/context.js';
import { workflowEdges, type ChainRefs } from '../chain/refs.js';
import type { ToolDef } from '../registry/dispatch.js';
import { RESUMES, STEP_RUNNERS, StepBlocked, StepFailed, WAIT, isStepKind, type AgentStepRunner, type ChildResult, type ChildSpec, type StepCall, type StepHost, type StepResult } from './steps/registry.js';
import { stepEnv } from './steps/env.js';
import { modelWithSkills, type ChatTurn } from './steps/skills.js';

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
  /** Sprint 32: the run's node in its chain (B-4101) and the parent step it reports to (B-3901). */
  caller_node?: string | null;
  chain_id?: string | null;
  chain_node?: string | null;
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
  /** B-3907: the app form the approver fills in (JSON StoredForm) and their answers (sealed). */
  form?: string | null;
  answers?: string | null;
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
  /** Sprint 32 (B-4101): the chain context; unset, runs keep only their own limits. */
  chains?: ChainService;
  /** Sprint 32 (B-3902): agent steps start and await agent runs here (read at use, so it may be installed later). */
  agents?: () => AgentStepRunner | null;
  /** Sprint 34 (B-4105): the reference graph checked at publish and before a workflow is deleted. */
  refs?: ChainRefs;
}

/** Sprint 32 (B-4101): where a new run sits in a chain: under `parent`, behind a `via` node (a plugin action, an app trigger). */
export interface RunChain {
  parent?: ChainRef | null;
  via?: { kind: ChainKind; ref?: string; callee?: string | null };
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
  runStep(p: Principal, step: RecordStep, ctx: { label: Label; workflowId: string; runId: string; depth: number; chain?: ChainRef | null }): Promise<{ output: Record<string, unknown>; label: Label }>;
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

// StepBlocked (a step that cannot run with the data it would receive), StepFailed (the run stops) and WAIT (the step
// paused) come from steps/host.ts, shared with the Workflows 2 step runners.

const n0 = (v: unknown) => (v == null ? null : Number(v));
/** Steps whose time is a child's (a sub-workflow or agent run, map items that are workflows): the child charges it. */
const delegates = (n: WfNode) => n.kind === 'sub' || n.kind === 'agent' || ((n.kind === 'map' || n.kind === 'loop') && !!(n.config as { workflow?: unknown }).workflow);
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
  /** Child runs a parent step is executing in this process (their end needs no resume of the parent). */
  private readonly inline = new Set<string>();
  private lifecycle: WorkflowLifecycle = {};
  /** Sprint 32c (B-3907, B-3908): notify and webhook steps and approval forms. */
  private kit: WorkflowStepKit | null = null;

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

  /** Sprint 32c: the notify and webhook steps and approval forms. */
  useStepKit(kit: WorkflowStepKit): void {
    this.kit = kit;
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
  private async env(scope: WfScope, g: WfGraph, label: Label, self?: { id: string; name: string }) {
    const rows = await this.d.gateway.repo.profiles(scope.tenantId);
    const steps = await stepEnv(this.d.db, this.d.registry, scope, g);
    const names = [...new Set([...g.nodes.filter((n) => n.kind === 'tool').map((n) => String(n.config.tool ?? '').trim()), ...steps.tools].filter(Boolean))];
    const tools = new Map<string, ToolInfo | { missing: string }>();
    for (const name of names) tools.set(name, await this.toolInfo(scope, name));
    return {
      label,
      profile: (name: string) => {
        let t = rows.find((x) => x.name === name || x.id === name);
        for (let i = 0; t?.alias_of && i < 5; i++) t = rows.find((x) => x.id === t!.alias_of);
        return t && !t.alias_of && t.status === 'published' ? { label: t.label } : undefined;
      },
      tool: (name: string) => tools.get(name),
      workflow: steps.workflow,
      agent: steps.agent,
      skill: steps.skill,
      ...(self ? { self } : {})
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

  async validate(scope: WfScope, g: WfGraph, label: Label, self?: { id: string; name: string }): Promise<Validation> {
    return validateGraph(g, await this.env(scope, g, label, self));
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
      validation: await this.validate(scopeOf(w), draft, w.label, w),
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
    // Sprint 32c (B-3908, B-3907): webhook endpoints on the outbound host rules, approval forms that exist.
    if (this.kit) await this.kit.checkSave(p, g);
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
    const v = await this.validate(scopeOf(w), g, w.label, w);
    // B-4105: the reference graph from this version: a cycle of steps that always run cannot terminate.
    if (v.ok && this.d.refs) {
      const c = await this.d.refs.check(w.tenant_id, { kind: 'workflow', name: w.name, id: w.id, label: w.label, workspaceId: w.workspace_id, edges: workflowEdges(g) });
      for (const x of c.problems) v.errors.push({ code: 'chain', message: `${x.message[0]!.toUpperCase()}${x.message.slice(1)}.`, ...(x.path ? { path: x.path } : {}) });
      for (const x of c.warnings) v.warnings.push({ code: 'chain', message: `${x.message[0]!.toUpperCase()}${x.message.slice(1)}.`, ...(x.path ? { path: x.path } : {}) });
      if (c.problems.length) v.ok = false;
    }
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
    // B-4105: a workflow that a published agent or workflow uses stays until they stop using it.
    const live = (await this.usedBy(w)).filter((u) => u.live && u.kind !== 'tool');
    if (live.length) throw new HttpProblem(409, 'Still in use', `${w.name} is used by ${[...new Set(live.map((u) => `${u.kind} ${u.name}`))].join(', ')}; change ${live.length === 1 ? 'it' : 'them'} to stop using it before deleting it.`, { extensions: { usedBy: live } });
    await this.d.db('workflows').where({ id: w.id }).delete();
    await this.kit?.removed(w.tenant_id, w.id);
    return w;
  }

  /** B-4105: what references the workflow (by id or name): agents that list it, workflow tools, other workflows. */
  async usedBy(w: Pick<WorkflowRow, 'id' | 'name' | 'tenant_id'>) {
    return this.d.refs ? this.d.refs.usedBy(w.tenant_id, { kind: 'workflow', name: w.name, id: w.id }) : [];
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
  /** 1.6.0 (B-8202): `caller` names what awaits the run (an app deployment); `onCallerDone` hears of its end. */
  async start(p: Principal, id: string, input: { input: Record<string, unknown>; dry: boolean; trigger?: string; chain?: RunChain; caller?: { kind: string; id: string; node: string } }) {
    const w = await this.workflow(p, id);
    let graph: WfGraph;
    if (input.dry) {
      graph = this.graphOf(w);
      const v = await this.validate(scopeOf(w), graph, w.label, w);
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
    return this.createRun(w, p, { graph, version: input.dry ? null : w.published_version, draftRev: input.dry ? w.draft_rev : null, mode: input.dry ? 'dry' : 'run', trigger: input.trigger ?? 'manual', input: input.input, label: w.label, ...(input.chain ? { chain: input.chain } : {}), ...(input.caller ? { caller: input.caller } : {}) });
  }

  /**
   * B-4101: the run's node, a child of `chain.parent` (behind `chain.via` when given) or the root of a new chain whose
   * budgets are the graph's limits. Dry runs are not chained. The label returned is the run's: at least the chain's
   * high-water mark, which the principal must be cleared for.
   */
  private async chainRun(w: WorkflowRow, p: Principal, runId: string, o: { graph: WfGraph; mode: 'run' | 'dry'; label: Label; chain?: RunChain }): Promise<{ node: ChainCtx | null; label: Label }> {
    const chains = this.d.chains;
    if (!chains || o.mode === 'dry') return { node: null, label: o.label };
    let parent = o.chain?.parent ?? null;
    if (o.chain?.via) parent = await chains.begin(w.tenant_id, { kind: o.chain.via.kind, ...(o.chain.via.ref ? { ref: o.chain.via.ref } : {}), callee: o.chain.via.callee ?? null, principal: p.userId, label: o.label, parent });
    const node = await chains.begin(w.tenant_id, { kind: 'workflow-run', ref: runId, callee: w.id, principal: p.userId, label: o.label, parent, budgets: { tokens: o.graph.limits.tokens ?? LIMITS.maxTokens, wallMs: o.graph.limits.timeoutMs ?? LIMITS.maxRunTimeoutMs } });
    if (!clears(p.clearance, node.label)) {
      await chains.finish(node, 'refused', 'above the clearance');
      throw forbidden(`The chain carries ${node.label} data; your clearance is ${p.clearance}.`, { step: 'clearance' });
    }
    return { node, label: node.label };
  }

  /** `jobRunAt` delays the run's job: a caller executing the run itself leaves the job as a backstop for a restart. */
  private async createRun(w: WorkflowRow, p: Principal, o: { graph: WfGraph; version: number | null; draftRev: number | null; mode: 'run' | 'dry'; trigger: string; input: unknown; label: Label; replayOf?: string; replayFrom?: string; reuse?: StepRow[]; jobRunAt?: number; chain?: RunChain; caller?: { kind: string; id: string; node: string } }) {
    const id = ulid();
    const version = o.mode === 'run' ? (o.version ?? w.published_version) : null;
    const { node, label } = await this.chainRun(w, p, id, o);
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
      label,
      created_by: p.userId,
      job_id: null,
      replay_of: o.replayOf ?? null,
      replay_from: o.replayFrom ?? null,
      error: null,
      tokens: 0,
      locked_until: null,
      created_at: Date.now(),
      started_at: null,
      finished_at: null,
      chain_id: node?.chain ?? null,
      chain_node: node?.node ?? null,
      caller_kind: o.caller?.kind ?? null,
      caller_id: o.caller?.id ?? null,
      caller_node: o.caller?.node ?? null
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
    await this.chainFinish(after, 'cancelled', 'Cancelled');
    await this.cancelChildren(after, `Run ${run.id} of the parent workflow was cancelled.`);
    return after;
  }

  /** B-3901, B-3902: a cancelled run's sub-workflow and agent runs stop with it. */
  private async cancelChildren(run: RunRow, reason: string): Promise<void> {
    const kids = ((await this.d.db('workflow_runs').where({ tenant_id: run.tenant_id, caller_kind: 'workflow-run', caller_id: run.id }).whereNotIn('state', TERMINAL)) as Record<string, unknown>[]).map(runFrom);
    for (const k of kids) {
      await this.d.db('workflow_runs').where({ id: k.id }).whereNotIn('state', TERMINAL).update({ state: 'cancelled', finished_at: Date.now(), error: reason.slice(0, 1000), locked_until: null });
      await this.d.db('workflow_approvals').where({ run_id: k.id, state: 'pending' }).update({ state: 'expired', decided_at: Date.now() });
      if (k.job_id) await this.d.jobs.cancel(k.tenant_id, k.job_id);
      await this.chainFinish(k, 'cancelled', reason);
      await this.cancelChildren(k, reason);
    }
    const agents = this.d.agents?.();
    if (!agents) return;
    const runs = (await this.d.db('agent_runs').where({ tenant_id: run.tenant_id, caller_kind: 'workflow-run', caller_id: run.id }).select('id')) as { id: string }[];
    for (const a of runs) await agents.cancelForStep(run.tenant_id, a.id, reason);
  }

  private chainOf(run: Pick<RunRow, 'chain_id' | 'chain_node'>): ChainRef | null {
    return this.d.chains && run.chain_id && run.chain_node ? { chain: run.chain_id, node: run.chain_node } : null;
  }

  private async chainFinish(run: Pick<RunRow, 'chain_id' | 'chain_node'>, state: 'succeeded' | 'failed' | 'waiting' | 'cancelled' | 'running', error: string | null = null): Promise<void> {
    const ref = this.chainOf(run);
    if (ref) await this.d.chains!.finish(ref, state, error);
  }

  /** B-3901, B-3902: a child (a sub-workflow run, an agent run) this run waits on ended: the run continues. */
  async resumeFromCaller(tenantId: string, runId: string): Promise<void> {
    const run = await this.runRow(runId);
    if (!run || run.tenant_id !== tenantId || TERMINAL.includes(run.state)) return;
    await this.resume(run);
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
    return { id: r.id, workflowId: r.workflow_id, version: r.version, draftRev: r.draft_rev, mode: r.mode, trigger: r.trigger, state: r.state, label: r.label, createdBy: r.created_by, createdByName: names.get(r.created_by) ?? null, replayOf: r.replay_of, replayFrom: r.replay_from, error: r.error, tokens: r.tokens, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at, chain: r.chain_id ? { id: r.chain_id, node: r.chain_node ?? null } : null, caller: r.caller_kind && r.caller_id ? { kind: r.caller_kind, id: r.caller_id, node: r.caller_node ?? null } : null };
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
      approvals: await Promise.all(approvals.map((a) => this.approvalView(p, a, run, names))),
      // Sprint 32: the sub-workflow and agent runs this run started (B-3901, B-3902), and its map and loop items.
      children: [
        ...((await this.d.db('workflow_runs').where({ tenant_id: run.tenant_id, caller_kind: 'workflow-run', caller_id: run.id }).orderBy('created_at').select('id', 'workflow_id', 'caller_node', 'state', 'label', 'error')) as { id: string; workflow_id: string; caller_node: string | null; state: string; label: Label; error: string | null }[]).filter((k) => clears(p.clearance, k.label)).map((k) => ({ kind: 'workflow-run', id: k.id, workflowId: k.workflow_id, step: k.caller_node, state: k.state, label: k.label, error: k.error })),
        ...((await this.d.db('agent_runs').where({ tenant_id: run.tenant_id, caller_kind: 'workflow-run', caller_id: run.id }).orderBy('created_at').select('id', 'agent_name', 'caller_node', 'state', 'label', 'error')) as { id: string; agent_name: string; caller_node: string | null; state: string; label: Label; error: string | null }[]).filter((k) => clears(p.clearance, k.label)).map((k) => ({ kind: 'agent-run', id: k.id, agent: k.agent_name, step: k.caller_node, state: k.state, label: k.label, error: k.error }))
      ],
      items: ((await this.d.db('workflow_items').where({ run_id: run.id }).orderBy('node_id').orderBy('idx').select('node_id', 'idx', 'state', 'error', 'child_run', 'tokens')) as { node_id: string; idx: number; state: string; error: string | null; child_run: string | null; tokens: number }[]).map((i) => ({ nodeId: i.node_id, index: Number(i.idx), state: i.state, error: i.error, childRun: i.child_run, tokens: Number(i.tokens) }))
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
      // B-3907: the form the approver fills in, and the answers once given.
      form: a.form && this.kit ? await this.kit.describeForm(a.tenant_id, json<StoredForm>(a.form, {} as StoredForm)) : null,
      answers: a.answers && clears(p.clearance, run.label) ? await this.open(a.tenant_id, `wfanswers:${a.id}`, a.answers, null) : null,
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
  /**
   * 1.7.0 (B-4009): a run's end for the conversation that started it: its state, the outputs of its passed steps as
   * JSON (opened with the tenant key), its error and label.
   */
  async stateOfRun(tenantId: string, runId: string): Promise<{ state: RunState; output: string | null; error: string | null; label: Label } | null> {
    const run = await this.runRow(runId);
    if (!run || run.tenant_id !== tenantId) return null;
    if (!TERMINAL.includes(run.state)) return { state: run.state, output: null, error: run.error, label: run.label };
    const steps = (await this.d.db('workflow_steps').where({ run_id: run.id }).orderBy('started_at')) as { id: string; node_id: string; state: StepState; output: string | null; tenant_id: string }[];
    const graph = JSON.parse(run.graph) as WfGraph;
    const outputs: Record<string, unknown> = {};
    for (const st of steps) {
      if (st.state !== 'passed' || !st.output) continue;
      const node = graph.nodes.find((n) => n.id === st.node_id);
      outputs[node?.title ?? st.node_id] = await this.open(run.tenant_id, `wfstep:${st.id}`, st.output, null);
    }
    return { state: run.state, output: run.state === 'succeeded' ? JSON.stringify(outputs).slice(0, 64 * 1024) : null, error: run.error, label: run.label };
  }

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

  async decide(p: Principal, approvalId: string, input: { decision: 'approve' | 'reject'; reason?: string | null; answers?: Record<string, unknown> | undefined }, ip: string | null = null) {
    const a = (await this.d.db('workflow_approvals').where({ tenant_id: p.tenantId, id: approvalId }).first()) as ApprovalRow | undefined;
    if (!a) throw notFound('Approval');
    const run = (await this.runRow(a.run_id))!;
    if (!clears(p.clearance, run.label)) throw forbidden(`The run is ${run.label}; your clearance is ${p.clearance}.`, { step: 'clearance' });
    if (!this.mayDecide(p, a, run)) throw forbidden(`This step waits on the ${a.role} role.`, { step: 'role' });
    if (a.state !== 'pending') throw conflict(`This approval is already ${a.state}.`);
    const approved = input.decision === 'approve';
    // B-3907: approving a step with a form takes the approver's answers, validated like a submission.
    let answers: Record<string, unknown> | null = null;
    if (approved && a.form) {
      if (!this.kit) throw conflict('Approval forms cannot be read on this server.');
      answers = (await this.kit.answers(p, a.tenant_id, json<StoredForm>(a.form, {} as StoredForm), input.answers ?? {}, ip)).values;
    } else if (input.answers && !a.form) throw badRequest('This approval has no form; send the decision without answers.');
    const n = await this.d.db('workflow_approvals').where({ id: a.id, state: 'pending' }).update({ state: approved ? 'approved' : 'rejected', decided_by: p.userId, decided_at: Date.now(), reason: input.reason ? await this.seal(a.tenant_id, `wfreason:${a.id}`, input.reason) : null, ...(answers ? { answers: await this.seal(a.tenant_id, `wfanswers:${a.id}`, answers) } : {}) });
    if (n !== 1) throw conflict('Someone decided this approval a moment ago.');
    const step = stepFrom(await this.d.db('workflow_steps').where({ run_id: run.id, node_id: a.node_id }).first());
    const pending = await this.open<Record<string, unknown>>(step.tenant_id, `wfstep:${step.id}`, step.output, {});
    const kind = (JSON.parse(run.graph) as WfGraph).nodes.find((n) => n.id === a.node_id)?.kind;
    if (kind === 'model' && json<Record<string, unknown>>(step.detail, {}).skillHold) {
      // B-4106: a call a skill's tool held: the step runs again and continues; a rejection goes back to the model.
      await this.d.db('workflow_steps').where({ id: step.id }).update({ detail: JSON.stringify({ ...json<Record<string, unknown>>(step.detail, {}), holdDecision: { decision: approved ? 'approved' : 'rejected', by: p.displayName, byId: p.userId, note: input.reason ?? null } }) });
    } else if (approved && kind === 'tool') {
      // The call has not happened yet: the step stays waiting and runs again, approved, when the run resumes.
      await this.d.db('workflow_steps').where({ id: step.id }).update({ detail: JSON.stringify({ ...json<Record<string, unknown>>(step.detail, {}), approvedBy: p.userId }) });
    } else if (approved) {
      await this.finishStep(run, step, 'passed', { output: { ...pending, approved: true, by: p.displayName, ...(answers ? { answers } : {}) }, detail: { approvedBy: p.userId, ...(answers ? { answered: Object.keys(answers) } : {}) } });
    } else {
      await this.finishStep(run, step, 'failed', { error: `Rejected by ${p.displayName}${input.reason ? `: ${input.reason}` : ''}`.slice(0, 1000), detail: { rejected: true, rejectedBy: p.userId } });
    }
    this.toApprovers(run, 'workflow.approval', { approvalId: a.id, runId: run.id, workflowId: run.workflow_id, nodeId: a.node_id, role: a.role, state: approved ? 'approved' : 'rejected' });
    if (!TERMINAL.includes(run.state)) await this.resume(run);
    if (run.created_by !== p.userId) {
      const w = await this.workflowById(run.workflow_id);
      await this.d.notifications.notify({ tenantId: run.tenant_id, userIds: [run.created_by], kind: 'workflow', title: `${w?.name ?? 'Workflow'}: ${approved ? 'approved' : 'rejected'}`, body: `${p.displayName} ${approved ? 'approved' : 'rejected'} a step of run ${run.id.slice(-6)}.`, route: 'workflows', label: run.label });
    }
    return { approval: a.id, state: approved ? 'approved' : 'rejected', run: run.id, workflowId: run.workflow_id, label: run.label, ...(answers ? { answers } : {}) };
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

  private async finishStep(run: RunRow, step: StepRow, state: StepState, o: { output?: unknown; error?: string; detail?: Record<string, unknown>; label?: Label } = {}): Promise<StepRow> {
    const detail = { ...json<Record<string, unknown>>(step.detail, {}), ...(o.detail ?? {}) };
    const patch: Partial<StepRow> = { state, finished_at: Date.now(), error: o.error?.slice(0, 1000) ?? null, detail: JSON.stringify(detail), resume_at: null, ...(o.label ? { label: o.label } : {}) };
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
      await this.chainFinish(run, state === 'succeeded' ? 'succeeded' : state === 'cancelled' ? 'cancelled' : 'failed', error);
      // Whoever awaited this run (an agent run that called it as a tool, a parent workflow's step) picks the result up now.
      const caller = (await this.d.db('workflow_runs').where({ id: run.id }).first('caller_kind', 'caller_id')) as { caller_kind: string | null; caller_id: string | null } | undefined;
      if (caller?.caller_kind === 'workflow-run' && caller.caller_id) {
        // A child the parent is running inline right now hands its result back directly.
        if (!this.inline.has(run.id)) await this.resumeFromCaller(run.tenant_id, caller.caller_id).catch((err: unknown) => this.d.log.warn({ run: run.id, err: (err as Error).message }, 'could not resume the parent of a workflow run'));
      } else if (caller?.caller_kind && caller.caller_id) await this.d.onCallerDone?.(run.tenant_id, caller.caller_kind, caller.caller_id).catch((err: unknown) => this.d.log.warn({ run: run.id, err: (err as Error).message }, 'could not resume the caller of a workflow run'));
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
    await this.chainFinish(run, 'running');
    try {
      // B-4101: the run's chain node is the in-process scope of what it causes (events, tool calls), inside the
      // lifecycle's scope (32b's chain of workflows for the event loop rule).
      const ref = this.chainOf(run);
      const walk = () => (ref ? chainScope.run(ref, () => this.walk(run, ctx)) : this.walk(run, ctx));
      return await (this.lifecycle.scope ? this.lifecycle.scope(run, walk) : walk());
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
      else if (s.state === 'failed' && handlesFailure(g, s.node_id)) outputs[s.node_id] = { error: s.error ?? '', step: s.node_id, type: json<{ errorType?: string }>(s.detail, {}).errorType ?? 'failed' };
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
        // Approvals change state when decided; a tool step someone approved runs again below and makes the call;
        // a step waiting on a child (a sub-workflow or agent run, map items) runs again and picks up where it was.
        // B-4106: a model step whose held call was decided runs again and continues from its checkpoint.
        const decided = n.kind === 'tool' ? await this.toolApproved(run.id, id) : n.kind === 'model' ? !!json<{ holdDecision?: unknown }>(row.detail, {}).holdDecision : false;
        if (!RESUMES.has(n.kind) && !decided) continue;
      }
      const chain = this.chainOf(run);
      if (chain) {
        const over = await this.d.chains!.check(chain);
        if (over) return this.finishRun(run, 'failed', over);
      }

      if (Date.now() - (run.started_at ?? Date.now()) > timeoutMs) return this.finishRun(run, 'failed', `The run went past its timeout of ${Math.round(timeoutMs / 60_000)} minutes.`);

      const again = row?.state === 'waiting' && RESUMES.has(n.kind) && retryAt == null;
      let step = await this.upsertStep(run, id, { state: 'running', label, attempts: again ? row!.attempts : (row?.attempts ?? 0) + 1, ...(again ? {} : { started_at: Date.now() }), error: null, ...(retryAt != null ? { resume_at: null, detail: JSON.stringify({ ...json<Record<string, unknown>>(row!.detail, {}), retryAt: undefined }) } : {}) });
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
        step = await this.finishStep(run, step, 'passed', { output: result.output, detail: { ms: Date.now() - t0, ...(result.detail ?? {}) }, ...(result.label ? { label: highest(label, result.label) } : {}) });
        steps.set(id, step);
        outputs[id] = result.output;
        if (result.label && chain) await this.d.chains!.raise(chain, result.label);
        if (result.tokens) {
          run.tokens += result.tokens;
          await this.d.db('workflow_runs').where({ id: run.id }).update({ tokens: run.tokens });
          if (run.tokens > tokenBudget) return this.finishRun(run, 'failed', `The run used ${run.tokens.toLocaleString('en-US')} tokens, over its budget of ${tokenBudget.toLocaleString('en-US')}.`);
        }
        if (chain) {
          // B-4101: the step is charged to the chain's root (a child run or agent charges its own work).
          // A used-up root stops the run before its next step.
          await this.d.chains!.charge(chain, { steps: 1, tokens: result.charged ? 0 : (result.tokens ?? 0), wallMs: delegates(n) ? 0 : Date.now() - t0, gpuMs: Number(result.detail?.gpuMs ?? 0) || 0 });
        }
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        const e = err as Error;
        const timedOut = e.name === 'TimeoutError' || /aborted due to timeout/i.test(e.message);
        const message = timedOut ? `${n.title} took longer than ${Math.round((n.timeoutMs ?? LIMITS.defaultStepTimeoutMs) / 1000)} s.` : err instanceof HttpProblem ? (err.detail ?? err.title) : e.message;
        const blocked = err instanceof StepBlocked;
        // B-4106: the typed error a failure edge reads.
        const errorType: ChainErrorType = err instanceof StepFailed ? err.type : err instanceof ChainLimit ? 'chain_limit' : timedOut ? 'timeout' : 'failed';
        // B-3906: a step with a retry policy waits and is tried again, durably, before it fails for good.
        const again = !blocked && retryable(message) ? nextRetryAt(n, step.attempts) : null;
        if (again != null) {
          step = await this.retryLater(run, step, again, message);
          steps.set(id, step);
          continue;
        }
        step = await this.finishStep(run, step, blocked ? 'blocked' : 'failed', { error: message, detail: { ms: Date.now() - t0, ...(blocked ? {} : { errorType }) } });
        steps.set(id, step);
        if (chain) await this.d.chains!.charge(chain, { steps: 1, wallMs: delegates(n) ? 0 : Date.now() - t0 });
        // B-3906: a failure edge takes the failure instead of the run.
        if (!blocked && handlesFailure(g, id)) {
          outputs[id] = { error: message, step: id, type: errorType };
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
      await this.chainFinish(run, 'waiting');
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

  private async runNode(run: RunRow, p: Principal, n: WfNode, step: StepRow, c: { scope: TemplateScope; merged: Record<string, unknown>; input: unknown; label: Label; signal: AbortSignal }): Promise<StepResult | typeof WAIT> {
    const dry = run.mode === 'dry';
    switch (n.kind) {
      case 'trigger':
        return { output: c.input };
      case 'model':
        return dry ? { output: n.config.format === 'json' ? sampleOf(n.output ?? { type: 'object' }) : { text: `Mocked answer for ${n.title}.` }, detail: { mocked: true } } : this.runModel(run, p, n, c, step);
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
        // B-3907: the form is resolved as the run's owner when the approval opens.
        if (cfg.form && !this.kit) throw new StepFailed('Approval forms are not available on this server.');
        const form = cfg.form ? await this.kit!.resolveForm(p, cfg.form) : undefined;
        return this.pauseForApproval(run, n, step, cfg.role, cfg.timeoutMs, c.merged, shown, form);
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
          const r = await this.records.runStep(p, rendered, { label: c.label, workflowId: run.workflow_id, runId: run.id, depth, chain: this.chainOf(run) });
          return { output: r.output, detail: { action: cfg.action, app: cfg.app, entity: cfg.entity, record: r.output.id } };
        } catch (err) {
          if (err instanceof HttpProblem && err.status === 403 && /label/i.test(err.detail ?? '')) throw new StepBlocked(err.detail ?? err.title);
          throw err;
        }
      }
      case 'notify':
      case 'webhook': {
        // Sprint 32c (B-3908): a dry run sends nothing.
        if (dry) return { output: n.kind === 'notify' ? { notified: 0, skipped: 0 } : { webhook: 'mock', delivery: null, event: String(n.config.event ?? 'workflow.webhook') }, detail: { mocked: true } };
        if (!this.kit) throw new StepFailed(`${n.kind} steps are not available on this server.`);
        return this.kit[n.kind]({ run, node: n, principal: p, label: c.label, scope: c.scope, merged: c.merged });
      }
      default:
        // Sprint 32: the Workflows 2 kinds (sub, agent, map, loop) run in steps/; see steps/registry.ts.
        if (isStepKind(n.kind)) return STEP_RUNNERS[n.kind]({ run, p, n, step, ...c }, this.host);
        throw new StepBlocked(`${n.title}: steps of kind ${String(n.kind)} are not available on this server.`);
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

  private async pauseForApproval(run: RunRow, n: WfNode, step: StepRow, role: string, timeoutMs: number, pending: unknown, shown: unknown, form?: StoredForm): Promise<typeof WAIT> {
    const id = ulid();
    const due = Date.now() + timeoutMs;
    await this.d.db('workflow_approvals').insert({ id, tenant_id: run.tenant_id, run_id: run.id, node_id: n.id, role, state: 'pending', shown: await this.seal(run.tenant_id, `wfapproval:${id}`, shown), decided_by: null, reason: null, due_at: due, created_at: Date.now(), decided_at: null, ...(form ? { form: JSON.stringify(form) } : {}) });
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

  private async runModel(run: RunRow, p: Principal, n: WfNode, c: { scope: TemplateScope; merged?: Record<string, unknown>; input?: unknown; label: Label; signal: AbortSignal }, step: StepRow): Promise<{ output: unknown; detail: Record<string, unknown>; tokens: number } | typeof WAIT> {
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

    let prompt = 0;
    let output = 0;
    let gpuMs = 0;
    let instance: string | null = null;
    /** One model call, metered as the run's (a step with skills makes several). */
    const chatOnce = async (msgs: ChatMessage[], tools: ToolDef[]): Promise<ChatTurn> => {
      let lease: Lease | null = null;
      let text = '';
      let pt = 0;
      let ot = 0;
      let gm = 0;
      const calls: ChatTurn['toolCalls'] = [];
      try {
        lease = await this.d.gateway.acquire(r.profile, r.model, c.label, { signal: c.signal });
        for await (const chunk of lease.client.chat({ ...req, messages: msgs, ...(tools.length ? { tools } : {}) }, c.signal)) {
          if (chunk.message?.content) text += chunk.message.content;
          for (const tc of chunk.message?.tool_calls ?? []) if (tc?.function?.name) calls.push({ name: tc.function.name, arguments: (tc.function.arguments ?? {}) as Record<string, unknown> });
          if (chunk.done) {
            pt += chunk.prompt_eval_count ?? 0;
            ot += chunk.eval_count ?? 0;
            gm += ((chunk.prompt_eval_duration ?? 0) + (chunk.eval_duration ?? 0) + (chunk.load_duration ?? 0)) / 1e6;
          }
        }
      } finally {
        lease?.release();
      }
      if (!pt && !ot) {
        pt = Math.ceil(msgs.reduce((a, m) => a + m.content.length, 0) / 4);
        ot = Math.ceil(text.length / 4);
      }
      instance = lease?.instance.name ?? instance;
      await this.d.quotas.record({ tenantId: run.tenant_id, workspaceId: run.workspace_id, userId: run.created_by, kind: 'workflow', profileId: r.profile.id, model: r.model.name, poolId: lease?.pool.id ?? null, promptTokens: pt, outputTokens: ot, gpuMs: gm });
      prompt += pt;
      output += ot;
      gpuMs += gm;
      return { text, toolCalls: calls, tokens: pt + ot, gpuMs: gm };
    };
    let text: string;
    let extra: Record<string, unknown> = {};
    if (cfg.skills?.length) {
      // B-3902, B-4103: the skills' closure, its instructions and tools, through the dispatcher (steps/skills.ts).
      const out = await modelWithSkills({ run, p, n, step, scope: c.scope, merged: c.merged ?? {}, input: c.input ?? null, label: c.label, signal: c.signal }, this.host, { skills: cfg.skills, messages, toolsCapable: r.model.capabilities.includes('tools') && !r.model.evaluation?.toolsWithheld, trustMarking: r.profile.trust_marking !== false, chat: chatOnce, approverRole: cfg.approverRole ?? 'workflow-admin', approvalTimeoutMs: cfg.approvalTimeoutMs ?? 24 * 3_600_000 });
      // B-4106: a held call pauses the step.
      if (out === WAIT) return WAIT;
      text = out.text;
      extra = out.detail;
      prompt += out.carried.tokens;
      gpuMs += out.carried.gpuMs;
    } else text = (await chatOnce(messages, [])).text;
    let value: unknown = { text };
    if (cfg.format === 'json') {
      try {
        value = parseJsonAnswer(text);
      } catch {
        throw new StepFailed("The model's answer is not valid JSON.");
      }
    }
    return { output: value, detail: { profile: r.profile.name, model: r.model.name, instance, tokens: prompt + output, promptTokens: prompt, outputTokens: output, gpuMs: Math.round(gpuMs), ...extra }, tokens: prompt + output };
  }

  // ---------- Sprint 32: what the Workflows 2 step runners use (steps/host.ts) ----------

  private readonly host: StepHost = ((self: WorkflowService) => ({
    get registry() {
      return self.d.registry;
    },
    get tools() {
      return self.d.tools;
    },
    get chains() {
      return self.d.chains ?? null;
    },
    get agents() {
      return self.d.agents?.() ?? null;
    },
    seal: (t, aad, v) => this.seal(t, aad, v),
    open: (t, aad, sealed, fallback) => this.open(t, aad, sealed, fallback),
    chainOf: (run) => this.chainOf(run),
    child: (c, spec) => this.runChild(c, spec),
    prompt: async (c, spec) => {
      const node: WfNode = { ...c.n, kind: 'model', config: { profile: spec.profile, prompt: spec.prompt, format: spec.format }, output: undefined };
      const r = await this.runModel(c.run as RunRow, c.p, node, { scope: spec.scope, label: c.label, signal: c.signal }, c.step as StepRow);
      if (r === WAIT) throw new StepFailed('A prompt cannot pause.');
      return { output: r.output, tokens: r.tokens, gpuMs: Number(r.detail.gpuMs ?? 0) };
    },
    wait: async (c, detail) => {
      const step = c.step as StepRow;
      const merged = { ...json<Record<string, unknown>>(step.detail, {}), ...detail };
      await this.d.db('workflow_steps').where({ id: step.id }).update({ state: 'waiting', detail: JSON.stringify(merged), output: await this.seal(step.tenant_id, `wfstep:${step.id}`, c.merged) });
      this.emitStep(c.run as RunRow, { ...step, state: 'waiting', detail: merged });
      return WAIT;
    },
    hold: async (c, state, shown, o) => {
      const step = stepFrom(await this.d.db('workflow_steps').where({ id: c.step.id }).first());
      await this.pauseForApproval(c.run as RunRow, c.n, step, o.role, o.timeoutMs, state, shown);
      const a = (await this.d.db('workflow_approvals').where({ run_id: c.run.id, node_id: c.n.id, state: 'pending' }).orderBy('created_at', 'desc').first('id')) as { id: string } | undefined;
      const merged = { ...json<Record<string, unknown>>(step.detail, {}), skillHold: { approval: a?.id ?? null, tool: shown.tool ?? null, since: Date.now() }, holdDecision: undefined };
      await this.d.db('workflow_steps').where({ id: step.id }).update({ detail: JSON.stringify(merged) });
      return WAIT;
    },
    takeHold: async <T>(c: StepCall) => {
      const row = (await this.d.db('workflow_steps').where({ id: c.step.id }).first()) as Record<string, unknown> | undefined;
      if (!row) return null;
      const s = stepFrom(row);
      const detail = json<Record<string, unknown>>(s.detail, {});
      const d = detail.holdDecision as { decision: 'approved' | 'rejected'; by: string | null; note: string | null } | undefined;
      if (!detail.skillHold || !d) return null;
      const state = await this.open<T | null>(s.tenant_id, `wfstep:${s.id}`, s.output, null);
      if (!state) return null;
      const { skillHold: _h, holdDecision: _d, ...rest } = detail;
      await this.d.db('workflow_steps').where({ id: s.id }).update({ detail: JSON.stringify({ ...rest, holds: [...(Array.isArray(rest.holds) ? rest.holds : []), { ...(_h as object), ...d }] }) });
      (c.step as StepRow).detail = JSON.stringify(rest);
      return { state, decision: d.decision, by: d.by, note: d.note };
    },
    note: async (c, detail) => {
      const row = (await this.d.db('workflow_steps').where({ id: c.step.id }).first('detail')) as { detail: string | null } | undefined;
      const merged = { ...json<Record<string, unknown>>(row?.detail ?? null, {}), ...detail };
      await this.d.db('workflow_steps').where({ id: c.step.id }).update({ detail: JSON.stringify(merged) });
      (c.step as StepRow).detail = JSON.stringify(merged);
    },
    items: {
      list: async (c) => {
        const rows = (await this.d.db('workflow_items').where({ run_id: c.run.id, node_id: c.n.id }).orderBy('idx')) as { id: string; idx: number; state: string; output: string | null; error: string | null; child_run: string | null }[];
        return Promise.all(rows.map(async (r) => ({ idx: Number(r.idx), state: r.state, output: r.state === 'passed' ? await this.open(c.run.tenant_id, `wfitem:${r.id}`, r.output, null) : null, error: r.error, childRun: r.child_run })));
      },
      save: async (c, idx, row) => {
        const existing = (await this.d.db('workflow_items').where({ run_id: c.run.id, node_id: c.n.id, idx }).first('id')) as { id: string } | undefined;
        const id = existing?.id ?? ulid();
        const values = { state: row.state, output: row.output === undefined ? null : await this.seal(c.run.tenant_id, `wfitem:${id}`, row.output), error: row.error?.slice(0, 1000) ?? null, child_run: row.childRun ?? null, tokens: Math.round(row.tokens ?? 0), finished_at: row.state === 'waiting' ? null : Date.now() };
        if (existing) await this.d.db('workflow_items').where({ id }).update(values);
        else await this.d.db('workflow_items').insert({ id, tenant_id: c.run.tenant_id, run_id: c.run.id, node_id: c.n.id, idx, created_at: Date.now(), ...values });
      },
      countOthers: async (c) => {
        const g = graphSchema.parse(JSON.parse(c.run.graph));
        const maps = g.nodes.filter((x) => x.kind === 'map' && x.id !== c.n.id).map((x) => x.id);
        if (!maps.length) return 0;
        const r = (await this.d.db('workflow_items').where({ run_id: c.run.id }).whereIn('node_id', maps).count({ n: '*' }).first()) as { n: number | string } | undefined;
        return Number(r?.n ?? 0);
      }
    }
  }))(this);

  /**
   * B-3901: a child run of a published workflow for a step (or one item of a map or loop): found again by its parent
   * step on every pass, created once (as the parent's principal, under the higher of the two labels, in the parent's
   * chain) and executed here while it can go on. A child waiting on an approval leaves the parent step waiting; its
   * end resumes the parent (`finishRun`).
   */
  private async runChild(c: StepCall, spec: ChildSpec): Promise<ChildResult> {
    const parent = c.run as RunRow;
    const failed = (error: string, blocked = false): ChildResult => ({ state: 'failed', run: null, error, blocked });
    const row = (await this.d.db('workflow_runs').where({ tenant_id: parent.tenant_id, caller_kind: 'workflow-run', caller_id: parent.id, caller_node: spec.key }).orderBy('created_at', 'desc').first()) as Record<string, unknown> | undefined;
    let child = row ? runFrom(row) : undefined;
    let w: WorkflowRow | undefined;
    if (!child) {
      try {
        w = await this.workflow(c.p, spec.workflow);
      } catch {
        return failed(`${spec.workflow} is not a workflow in this workspace.`);
      }
      if (w.id === parent.workflow_id) return failed('A workflow cannot run itself as a sub-workflow.');
      const version = spec.version ?? w.published_version;
      if (!version) return failed(`${w.name} has no published version.`);
      const v = await this.version(w.id, version);
      if (!v) return failed(`Version ${version} of ${w.name} does not exist.`);
      const label = highest(w.label, spec.label);
      if (!clears(c.p.clearance, label)) return failed(`A run of ${w.name} is ${label}, above the run owner's clearance.`, true);
      const trigger = v.graph.nodes.find((x) => x.kind === 'trigger');
      const bad = trigger?.output ? checkValue(spec.input, trigger.output) : null;
      if (bad) return failed(`The input does not match the trigger of ${w.name}: ${bad}.`);
      try {
        child = await this.createRun(w, c.p, { graph: v.graph, version, draftRev: null, mode: 'run', trigger: `workflow:${parent.id}`, input: spec.input, label, jobRunAt: Date.now() + spec.timeoutMs + 30_000, caller: { kind: 'workflow-run', id: parent.id, node: spec.key }, chain: { parent: this.chainOf(parent) } });
      } catch (err) {
        if (err instanceof ChainLimit) return failed(err.message);
        if (err instanceof HttpProblem) return failed(err.detail ?? err.title, err.status === 403);
        throw err;
      }
      await this.d.audit.append({ tenantId: parent.tenant_id, action: 'workflow.run.started', kind: 'system', actor: { service: 'workflows', user: parent.created_by }, target: { workflow: w.id, run: child.id }, label: child.label, detail: { version, parentRun: parent.id, parentWorkflow: parent.workflow_id, step: spec.key, chain: child.chain_id ?? null } });
    }
    if (!TERMINAL.includes(child.state) && child.state !== 'waiting') {
      this.inline.add(child.id);
      try {
        await this.execute(child.id, { signal: c.signal });
      } finally {
        this.inline.delete(child.id);
      }
      child = (await this.runRow(child.id))!;
    }
    const version = child.version ?? 0;
    if (child.state === 'succeeded') {
      const out = await this.runOutput(child, graphSchema.parse(JSON.parse(child.graph)));
      return { state: 'succeeded', run: child.id, output: out.value, label: out.label, version };
    }
    if (TERMINAL.includes(child.state)) {
      w ??= await this.workflowById(child.workflow_id);
      return { state: 'failed', run: child.id, error: `Run ${child.id} of ${w?.name ?? 'the sub-workflow'} ${child.state}${child.error ? `: ${child.error}` : ''}` };
    }
    return { state: 'waiting', run: child.id, version };
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

  /**
   * Sprint 32: what the Workflows 2 steps may call from the caller's workspace, for the editor: published workflows
   * (sub steps, map and loop items) with their input schema, published agents (agent steps) and skills (model steps),
   * within the caller's clearance.
   */
  async callees(p: Principal) {
    const rows = ((await this.d.db('workflows').where(this.scope(p)).whereNotNull('published_version').orderBy('name')) as Record<string, unknown>[]).map(wfFrom).filter((w) => clears(p.clearance, w.label));
    const workflows = [];
    for (const w of rows) {
      const v = await this.version(w.id, w.published_version!);
      workflows.push({ id: w.id, name: w.name, label: w.label, version: w.published_version, input: v?.graph.nodes.find((n) => n.kind === 'trigger')?.output ?? null });
    }
    const visible = (kind: 'agent' | 'skill') => this.d.registry.list(p.tenantId, { kind }).then((list) => {
      const seen = new Set<string>();
      return list.filter((e) => (e.status === 'published' || e.status === 'deprecated') && e.approved_hash === e.schema_hash && this.d.registry.visibleTo(e, p) && clears(p.clearance, e.label) && !seen.has(e.name) && seen.add(e.name));
    });
    const agents = (await visible('agent')).map((e) => ({ name: e.name, version: e.version, description: e.description, label: e.label, budgets: (e.definition as { budgets?: unknown }).budgets ?? null }));
    const skills = (await visible('skill')).map((e) => ({ name: e.name, version: e.version, description: e.description, label: e.label, tools: Array.isArray(e.definition.tools) ? e.definition.tools : [] }));
    return { workflows, agents, skills, limits: { chainMaxDepth: this.d.chains?.limits.maxDepth ?? null, workflowMaxDepth: this.d.chains?.limits.kindCaps['workflow-run'] ?? null, maxItems: LIMITS.maxItems, maxParallel: LIMITS.maxParallel } };
  }

  // ---------- workflows published as registry tools ----------

  /** The side-effect class the steps of a graph imply: an HTTP write or a write tool makes the workflow write, and so on. */
  private async impliedSideEffect(w: WorkflowRow, g: WfGraph): Promise<{ sideEffect: SideEffect; because: string | null }> {
    let best: SideEffect = 'read';
    let because: string | null = null;
    for (const n of g.nodes) {
      let se: SideEffect = 'read';
      if (n.kind === 'http' && String(n.config.method ?? 'GET') !== 'GET') se = 'write';
      if (n.kind === 'notify' || n.kind === 'webhook') se = 'write';
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
    // An agent run that calls it is its caller from the start (its children list it; it awaits it if it pauses).
    const caller = ctx.source?.kind === 'agent-run' ? { caller: { kind: 'agent-run', id: ctx.source.id, node: ctx.chain?.node ?? '' } } : {};
    const run = await this.createRun(w, p, { graph: v.graph, version, draftRev: null, mode: 'run', trigger: 'tool', input: args, label, jobRunAt: Date.now() + limit + 30_000, chain: { parent: ctx.chain ?? null }, ...caller });
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
  async toolResult(ctx: ToolCallContext, entry: EntryRow, runId: string): Promise<CalleeResult> {
    const run = await this.runRow(runId);
    const w = run ? await this.workflowById(run.workflow_id) : undefined;
    if (!run || !w || run.tenant_id !== ctx.principal.tenantId || w.id !== String(entry.definition.workflowId ?? '')) return { state: 'failed', error: 'child_failed: The workflow run behind this call no longer exists.', type: 'failed' };
    if (!TERMINAL.includes(run.state)) return { state: 'pending' };
    // B-4106: the caller gets a typed error: rejected, cancelled, failed, or a result above its label.
    if (run.state === 'rejected') return { state: 'failed', error: `child_rejected: Run ${run.id} of ${w.name} was rejected${run.error ? `: ${run.error}` : '.'}`, type: 'rejected' };
    if (run.state === 'cancelled') return { state: 'failed', error: `child_cancelled: Run ${run.id} of ${w.name} was cancelled${run.error ? `: ${run.error}` : '.'}`, type: 'cancelled' };
    if (run.state !== 'succeeded') return { state: 'failed', error: `child_${/root's budget/.test(run.error ?? '') ? 'budget' : 'failed'}: Run ${run.id} of ${w.name} ${run.state}${run.error ? `: ${run.error}` : ''}.`, type: /root's budget/.test(run.error ?? '') ? 'budget' : 'failed' };
    try {
      return { state: 'done', result: await this.toolOutput(ctx, w, run, JSON.parse(run.graph) as WfGraph) };
    } catch (err) {
      return { state: 'failed', error: `child_label: ${(err as Error).message}`, type: 'label' };
    }
  }

  /**
   * B-4104: a workflow an agent lists, offered to it as the tool `workflow:<name>` without being published as one:
   * the version published in the caller's workspace now, its trigger's schema as the input, the side-effect class its
   * steps imply (a write workflow is held for approval like a write tool), the workspace's ceiling as the most the
   * call may carry, and, when it ends in one step with an output schema, that schema for the typed answer.
   */
  async asCallee(p: Principal, name: string): Promise<EntryRow | { missing: string }> {
    const r = await this.d.db('workflows').where(this.scope(p)).andWhere((q) => q.where({ name }).orWhere({ id: name })).first();
    if (!r) return { missing: 'is not a workflow in this workspace' };
    const w = wfFrom(r);
    if (!w.published_version) return { missing: 'has no published version' };
    const v = await this.version(w.id, w.published_version);
    if (!v) return { missing: `version ${w.published_version} no longer exists` };
    const trigger = v.graph.nodes.find((n) => n.kind === 'trigger');
    if (trigger?.output?.type !== 'object') return { missing: 'its trigger has no object output schema to call it with' };
    if (!clears(p.clearance, w.label)) return { missing: `it is ${w.label}, above the clearance it runs with` };
    const implied = await this.impliedSideEffect(w, v.graph);
    const ws = w.workspace_id ? ((await this.d.db('workspaces').where({ id: w.workspace_id }).first('label_ceiling')) as { label_ceiling: Label } | undefined) : undefined;
    const sinks = v.graph.nodes.filter((n) => !outgoing(v.graph, n.id).length);
    const t = Date.now();
    return {
      id: w.id,
      tenant_id: w.tenant_id,
      workspace_id: w.workspace_id,
      kind: 'tool',
      name: `workflow:${w.name}`,
      version: String(w.published_version),
      description: w.description?.trim() ? `Starts the workflow ${w.name} and waits for its result. ${w.description}` : `Starts the workflow ${w.name} and waits for its result.`,
      impl: 'workflow',
      side_effect: implied.sideEffect,
      confirm: implied.sideEffect === 'read' ? 'never' : 'always',
      rate_per_hour: null,
      label: ws?.label_ceiling ?? 'restricted',
      input_schema: jsonSchema(trigger.output),
      // The result is `{run, output}`; its output is typed by the last step's schema when the workflow ends in one.
      output_schema: sinks.length === 1 && sinks[0]!.output ? { type: 'object', properties: { run: { type: 'string' }, output: jsonSchema(sinks[0]!.output) }, required: ['run', 'output'] } : null,
      definition: { workflowId: w.id, workflowName: w.name, version: w.published_version, listed: true },
      status: 'published',
      schema_hash: `workflow:${w.id}:${w.published_version}`,
      approved_hash: `workflow:${w.id}:${w.published_version}`,
      checks: [],
      checked_at: t,
      owner_id: w.created_by,
      owner_name: null,
      submitted_at: null,
      reviewed_by: null,
      reviewed_at: null,
      review_note: null,
      publish_scope: 'workspace',
      publish_workspaces: w.workspace_id ? [w.workspace_id] : [],
      replacement: null,
      created_at: w.created_at,
      updated_at: w.updated_at
    };
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
