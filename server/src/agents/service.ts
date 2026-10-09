import { ulid } from 'ulid';
import { splitThink, thinkingMode, thinkingRequest } from '../gateway/thinking.js';
import { capLevel, normalizePlan, parsePlan, planInstruction, type Plan, type ThinkingService } from '../thinking/service.js';
import type { Logger } from 'pino';
import { json, type Db } from '../db/knex.js';
import { clears, highest, labelRank, type Label } from '../authz/labels.js';
import { noDlp, type DlpInspector } from '../compliance/dlp-types.js';
import { ChainLimit, type ChainRef, type ChainService } from '../chain/context.js';
import { authorize, effectivePermissions, type Principal } from '../authz/policy.js';
import { actorFrom, type AuditLog } from '../audit/chain.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { TOPICS, type Bus } from '../platform/bus.js';
import type { DataKeys } from '../platform/datakeys.js';
import type { JobQueue } from '../platform/jobs.js';
import type { Notifications } from '../platform/notifications.js';
import type { QuotaService } from '../tenancy/quotas.js';
import type { Gateway, ResolvedProfile } from '../gateway/gateway.js';
import type { ChatMessage } from '../gateway/ollama.js';
import { ToolPending, type CalleeResult, type PendingResult, type ToolCallContext, type ToolDispatcher, type ToolOutcome, type ResolvedTool } from '../registry/dispatch.js';
import { validateAgainst } from '../registry/schema.js';
import { MAX_BUDGETS, type AgentBudgets, type AgentDefinition, type EntryRow, type RegistryService } from '../registry/service.js';
import { skillClosure } from '../registry/skills.js';
import { toolResultContent } from '../guardrails/injection.js';

export type RunState = 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'budget';
export type Lane = 'think' | 'do' | 'calc';
export type StepState = 'ok' | 'failed' | 'waiting' | 'denied' | 'rejected';

export interface RunUsage {
  steps: number;
  tokens: number;
  toolCalls: number;
  calcCalls: number;
  wallMs: number;
  gpuMs: number;
}

interface RunRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  user_id: string;
  agent_id: string;
  agent_name: string;
  agent_version: string;
  profile: string | null;
  state: RunState;
  label: Label;
  input: string | null;
  output: string | null;
  error: string | null;
  budgets: string;
  usage: string;
  job_id: string | null;
  replay_of: string | null;
  replay_from: number | null;
  /** Sprint 21: the schedule that started the run (B-1306). */
  schedule_id?: string | null;
  /** 1.7.0 (B-11703): a plan-first run's plan (sealed JSON) and its state: awaiting, approved or declined. */
  plan?: string | null;
  plan_state?: 'awaiting' | 'approved' | 'declined' | null;
  /** Sprint 32 (B-4101): the run's node in its chain; (B-3902) the workflow step that awaits it. */
  chain_id?: string | null;
  chain_node?: string | null;
  caller_kind?: string | null;
  caller_id?: string | null;
  caller_node?: string | null;
  /** 1.6.0 (B-7801): the specialist this run handed the conversation to, whose answer became this run's answer. */
  handed_to?: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  updated_at: number;
}

const chainRefOfRun = (r: Pick<RunRow, 'chain_id' | 'chain_node'>): ChainRef | null => (r.chain_id && r.chain_node ? { chain: r.chain_id, node: r.chain_node } : null);

interface StepRow {
  id: string;
  run_id: string;
  n: number;
  lane: Lane;
  title: string;
  state: StepState;
  meta: string;
  detail: string | null;
  created_at: number;
  finished_at: number | null;
}

/** A tool call the model asked for that has not run yet (approval may be pending on it). */
interface PendingCall {
  name: string;
  arguments: Record<string, unknown>;
  step?: number;
  decision?: 'approved' | 'rejected';
  decidedBy?: string;
  note?: string | null;
  /** B-1006: the call started work that finishes later (a workflow run waiting on an approval); the run awaits it. */
  awaiting?: PendingResult;
}

/** What a checkpoint holds: everything needed to continue (or replay) from the end of a step. */
interface CheckpointState {
  messages: ChatMessage[];
  pending: PendingCall[];
}

const TERMINAL: RunState[] = ['succeeded', 'failed', 'cancelled'];
/** States in which a run has ended for whoever awaits it (a budget stop ends it for its caller, B-4106). */
const ENDED: RunState[] = [...TERMINAL, 'budget'];

/** A model's answer as JSON (a fenced block or the whole text), for a delegate whose entry declares an output schema. */
function answerJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return JSON.parse((fenced ? fenced[1]! : text).trim());
}
const EMPTY_USAGE: RunUsage = { steps: 0, tokens: 0, toolCalls: 0, calcCalls: 0, wallMs: 0, gpuMs: 0 };

class Pause extends Error {
  constructor(
    readonly state: 'waiting' | 'budget',
    message: string,
    /** Set when the run waits on a pending tool result rather than on an approval of its own. */
    readonly awaiting: PendingResult | null = null
  ) {
    super(message);
  }
}

/**
 * Agent runs. An agent (a published registry entry) names a model profile, its tools and skills, and budgets. A run
 * is a job: thinking steps call the model through the gateway, doing steps call tools through the dispatcher (the
 * `tool-call` guardrail checkpoint, side-effect class and label ceiling), calculating steps use the exact calculator.
 * A checkpoint after every step holds the conversation state, so a run continues after an approval or a raised
 * budget, and can be replayed from any step as a new run. Write and destructive calls pause the run until an
 * approver decides; a rejection goes back to the model as data. Steps are pushed live to the owner's sockets.
 */
/** Accepted memories of an agent for a run at a label (the memory service, installed after it is built). */
export type AgentMemories = (p: Principal, agent: string, label: Label) => Promise<{ id: string; type: string; text: string }[]>;
/** Files a memory proposal for an agent (the memory service's proposal flow and `memory` checkpoint). */
export type ProposeMemory = (p: Principal, input: { agent: string; runId: string; text: string; type: string; label: Label }) => Promise<{ id: string }>;
/** A run that succeeded under a memory policy allowing proposals, for the memory service's extraction (B-3701). */
export type RunFinishedForMemory = (e: { tenantId: string; workspaceId: string | null; userId: string; runId: string; agent: string; label: Label; types: string[]; remaining: number }) => void;

/** The built-in tool through which a run proposes a memory, offered only when the agent's memory policy allows it. */
export const REMEMBER_TOOL = {
  type: 'function' as const,
  function: {
    name: 'remember',
    description: 'Propose a memory for future runs of this agent: progress on a task, or a quirk of a tool or source. A curator decides whether it is kept. Never include credentials or personal data.',
    parameters: { type: 'object', properties: { text: { type: 'string', description: 'The fact to remember, one sentence.' }, type: { type: 'string', enum: ['progress', 'quirk'] } }, required: ['text', 'type'] }
  }
};

export class AgentService {
  /** Reads the agent's accepted memories into a run's first prompt; unset, runs start without them. */
  memories: AgentMemories | null = null;
  /** Proposes memories from runs whose agent's memory policy allows it; unset, runs cannot write memory. */
  proposeMemory: ProposeMemory | null = null;
  /** Extracts memory proposals from a succeeded run whose policy allows them (B-3701); unset, nothing is extracted. */
  memoryExtract: RunFinishedForMemory | null = null;
  /** B-4101: the chain context; unset, runs keep only their own budgets. */
  chains: ChainService | null = null;
  /** 1.7.0 (B-117): the thinking policy, budgets, plans and reflection (set by `services.ts`). */
  thinking: ThinkingService | null = null;
  /** B-3902: a run a workflow step awaits ended (or stopped at its budget); the workflow run is resumed. */
  onCallerDone: ((tenantId: string, kind: string, id: string) => Promise<void>) | null = null;
  /** 1.6.0 (B-7701): the principal a run acts as, narrowed to the agent's identity; unset, runs act as their owner. */
  identity: ((p: Principal, agentName: string) => Promise<Principal>) | null = null;
  /** 1.6.0 (B-7601): DLP on a run's output: its label rises, a redaction is what is stored, a hold fails the run. */
  dlp: DlpInspector = noDlp;

  constructor(
    private readonly db: Db,
    private readonly keys: DataKeys,
    private readonly gateway: Gateway,
    private readonly registry: RegistryService,
    private readonly tools: ToolDispatcher,
    private readonly quotas: QuotaService,
    private readonly audit: AuditLog,
    private readonly bus: Bus,
    private readonly jobs: JobQueue,
    private readonly notifications: Notifications,
    private readonly principalFor: (tenantId: string, userId: string, workspaceId: string | null) => Promise<Principal | null>,
    private readonly log: Logger
  ) {}

  registerJobs(): void {
    this.jobs.register('agent.run', async (p, ctx) => this.execute(String(p.runId), ctx.signal), { timeoutMs: (MAX_BUDGETS.wallSeconds + 120) * 1000 });
  }

  // ---------- sealing ----------

  private seal(tenantId: string, aad: string, value: unknown): Promise<string> {
    return this.keys.seal(tenantId, JSON.stringify(value), aad);
  }

  private async open<T>(tenantId: string, aad: string, sealed: string | null, fallback: T): Promise<T> {
    if (!sealed) return fallback;
    return JSON.parse(await this.keys.open(tenantId, sealed, aad)) as T;
  }

  // ---------- reads ----------

  private async row(tenantId: string, id: string): Promise<RunRow> {
    const r = (await this.db('agent_runs').where({ tenant_id: tenantId, id }).first()) as RunRow | undefined;
    if (!r) throw notFound('Run');
    return r;
  }

  /** Owners see their runs; agent and tool admins see every run in the tenant within their clearance. */
  private canSee(p: Principal, r: RunRow): boolean {
    if (!clears(p.clearance, r.label)) return false;
    if (r.user_id === p.userId) return true;
    const perms = effectivePermissions(p);
    return perms.has('agents:manage') || perms.has('tools:manage');
  }

  async get(p: Principal, id: string): Promise<RunRow> {
    const r = await this.row(p.tenantId, id);
    if (!this.canSee(p, r)) throw notFound('Run');
    return r;
  }

  async list(p: Principal, opts: { limit?: number; state?: RunState; all?: boolean } = {}) {
    const perms = effectivePermissions(p);
    const admin = perms.has('agents:manage') || perms.has('tools:manage');
    const q = this.db('agent_runs as r').leftJoin('users as u', 'u.id', 'r.user_id').where({ 'r.tenant_id': p.tenantId });
    if (!(opts.all && admin)) {
      q.andWhere({ 'r.user_id': p.userId });
      if (p.workspaceId) q.andWhere({ 'r.workspace_id': p.workspaceId });
      else q.whereNull('r.workspace_id');
    }
    if (opts.state) q.andWhere({ 'r.state': opts.state });
    const rows = (await q.orderBy('r.created_at', 'desc').limit(Math.min(opts.limit ?? 50, 200)).select('r.*', 'u.display_name as by_name')) as (RunRow & { by_name: string | null })[];
    return rows.filter((r) => clears(p.clearance, r.label)).map((r) => this.summary(r, r.by_name));
  }

  private summary(r: RunRow, byName: string | null) {
    return {
      id: r.id,
      agentId: r.agent_id,
      agent: r.agent_name,
      agentVersion: r.agent_version,
      profile: r.profile,
      state: r.state,
      label: r.label,
      userId: r.user_id,
      by: byName,
      error: r.error,
      budgets: json<AgentBudgets>(r.budgets, MAX_BUDGETS),
      usage: json<RunUsage>(r.usage, EMPTY_USAGE),
      replayOf: r.replay_of,
      replayFrom: r.replay_from,
      scheduleId: r.schedule_id ?? null,
      chain: r.chain_id ? { id: r.chain_id, node: r.chain_node ?? null } : null,
      caller: r.caller_kind && r.caller_id ? { kind: r.caller_kind, id: r.caller_id, node: r.caller_node ?? null } : null,
      handedTo: json<{ agent: string; run: string } | null>(r.handed_to ?? null, null),
      createdAt: Number(r.created_at),
      startedAt: r.started_at == null ? null : Number(r.started_at),
      finishedAt: r.finished_at == null ? null : Number(r.finished_at)
    };
  }

  private async stepView(tenantId: string, s: StepRow) {
    return { n: s.n, lane: s.lane, title: s.title, state: s.state, meta: json<Record<string, unknown>>(s.meta, {}), detail: await this.open<Record<string, unknown>>(tenantId, `agent-step:${s.id}`, s.detail, {}), createdAt: Number(s.created_at), finishedAt: s.finished_at == null ? null : Number(s.finished_at) };
  }

  async view(p: Principal, id: string) {
    const r = await this.get(p, id);
    const by = (await this.db('users').where({ id: r.user_id }).first('display_name')) as { display_name: string } | undefined;
    // 1.7.0 (B-4004): a run started from a conversation names it, so the Runs screen links back.
    const chatTurn = r.caller_kind === 'chat-turn' && r.caller_id ? ((await this.db('messages').where({ id: r.caller_id }).first('conversation_id')) as { conversation_id: string } | undefined) : undefined;
    const steps = await Promise.all(((await this.db('agent_steps').where({ run_id: r.id }).orderBy('n')) as StepRow[]).map((s) => this.stepView(r.tenant_id, s)));
    // 1.7.0 (B-11701): the thinking policy decides whether this reader sees a step's thinking; its token count stays.
    if (this.thinking && !this.thinking.visibleTo(await this.thinking.policyFor(r.tenant_id, r.workspace_id ?? null), p, r.user_id)) {
      for (const s of steps) if (s.detail && typeof s.detail === 'object' && 'thinking' in s.detail) (s.detail as Record<string, unknown>).thinking = null;
    }
    const lanes = { think: { steps: 0, tokens: 0 }, do: { calls: 0, ms: 0, waiting: 0, denied: 0 }, calc: { results: 0, ms: 0 } };
    for (const s of steps) {
      if (s.lane === 'think') {
        lanes.think.steps++;
        lanes.think.tokens += Number(s.meta.tokens ?? 0);
      } else if (s.lane === 'do') {
        if (s.state === 'waiting') lanes.do.waiting++;
        else if (s.state === 'denied' || s.state === 'rejected') lanes.do.denied++;
        else lanes.do.calls++;
        lanes.do.ms += Number(s.meta.durationMs ?? 0);
      } else {
        lanes.calc.results++;
        lanes.calc.ms += Number(s.meta.durationMs ?? 0);
      }
    }
    const checkpoints = ((await this.db('agent_checkpoints').where({ run_id: r.id }).orderBy('n').select('n')) as { n: number }[]).map((c) => Number(c.n));
    return {
      ...this.summary(r, by?.display_name ?? null),
      ...(chatTurn ? { caller: { kind: 'chat-turn', id: r.caller_id, node: r.caller_node ?? null, conversationId: chatTurn.conversation_id } } : {}),
      input: await this.open<string>(r.tenant_id, `agent-run-input:${r.id}`, r.input, ''),
      output: await this.open<string | null>(r.tenant_id, `agent-run-output:${r.id}`, r.output, null),
      steps,
      lanes,
      checkpoints,
      // 1.7.0 (B-11703): the plan a plan-first run drafted, and whether it waits, was approved or declined.
      plan: r.plan ? { ...(await this.open<Plan>(r.tenant_id, `agent-run-plan:${r.id}`, r.plan, { steps: [], tools: [] })), state: r.plan_state ?? null } : null,
      // Sprint 34: what this run delegated to or started and awaited (B-4102, B-4104).
      children: await this.children(p, r.id)
    };
  }

  /** Published (or deprecated) agents the caller may run in this workspace. */
  async runnable(p: Principal) {
    const rows = await this.registry.list(p.tenantId, { kind: 'agent' });
    const out = [];
    const seen = new Set<string>();
    for (const e of rows.filter((x) => (x.status === 'published' || x.status === 'deprecated') && this.registry.visibleTo(x, p))) {
      if (seen.has(e.name)) continue;
      seen.add(e.name);
      const def = e.definition as unknown as AgentDefinition;
      out.push({ id: e.id, name: e.name, version: e.version, description: e.description, label: e.label, profile: def.profile, tools: def.tools ?? [], skills: def.skills ?? [], agents: def.agents ?? [], workflows: def.workflows ?? [], outputSchema: e.output_schema, budgets: def.budgets, deprecated: e.status === 'deprecated', replacement: e.replacement });
    }
    return out;
  }

  // ---------- starting and controlling ----------

  private async resolveAgent(p: Principal, nameOrId: string): Promise<EntryRow> {
    const byId = await this.registry.get(p.tenantId, nameOrId);
    const e = byId?.kind === 'agent' ? byId : await this.registry.resolve(p, nameOrId, 'agent');
    if (!e || e.kind !== 'agent') throw notFound('Agent');
    const perms = effectivePermissions(p);
    const published = (e.status === 'published' || e.status === 'deprecated') && this.registry.visibleTo(e, p) && e.approved_hash === e.schema_hash;
    // Drafts can be tried by their author or an agent admin before review; nothing else runs unpublished.
    if (!published && !(e.status === 'draft' && (e.owner_id === p.userId || perms.has('agents:manage')))) throw conflict(`${e.name} ${e.version} is ${e.status.replace('_', ' ')}; only published agents run.`);
    return e;
  }

  /** The checks a run starts with: the agent, the label against clearance and ceilings, and the agent's profile. */
  private async prepare(p: Principal, input: { agent: string; label?: Label }) {
    const e = await this.resolveAgent(p, input.agent);
    const def = e.definition as unknown as AgentDefinition;
    const label = input.label ?? 'internal';
    if (!clears(p.clearance, label)) throw forbidden(`Your clearance is ${p.clearance}; a ${label} run is above it.`, { step: 'clearance' });
    if (labelRank(label) > labelRank(e.label)) throw forbidden(`${e.name} handles data up to ${e.label}; this run is ${label}.`, { step: 'zone' });
    const ws = p.workspaceId ? ((await this.db('workspaces').where({ id: p.workspaceId }).first('label_ceiling', 'name')) as { label_ceiling: Label; name: string } | undefined) : undefined;
    if (ws && labelRank(label) > labelRank(ws.label_ceiling)) throw forbidden(`This workspace's ceiling is ${ws.label_ceiling}.`, { step: 'zone' });
    await this.resolveProfile(p, def.profile, label);
    return { e, def, label, ws };
  }

  /** Whether `p` could start this run now (Sprint 21: a schedule is checked when it is saved). */
  async checkStart(p: Principal, input: { agent: string; label?: Label }): Promise<{ agent: string; version: string; label: Label }> {
    const { e, label } = await this.prepare(p, input);
    return { agent: e.name, version: e.version, label };
  }

  /**
   * Starts a run. B-4101: the run is a node of a chain: the chain of `opts.chain` (a workflow step's run) or a new one
   * whose root budgets are the run's. Within a chain the run's label is at least the chain's high-water mark, so the
   * agent's ceiling and the caller's clearance are checked against that.
   */
  async start(p: Principal, input: { agent: string; input: string; label?: Label; budgets?: Partial<AgentBudgets> }, opts: { scheduleId?: string; chain?: ChainRef | null; caller?: { kind: string; id: string; node: string } } = {}) {
    const mark = opts.chain && this.chains ? await this.chains.label(opts.chain) : null;
    const { e, def, label: asked, ws } = await this.prepare(p, { ...input, ...(mark ? { label: highest(input.label ?? 'internal', mark) } : {}) });
    await this.quotas.admit(p.tenantId, p.workspaceId ?? null, { ...(ws ? { workspaceName: ws.name } : {}) });
    const budgets = this.budgets(def.budgets, input.budgets);
    const id = ulid();
    const node = this.chains ? await this.chains.begin(p.tenantId, { kind: 'agent-run', ref: id, callee: e.name, principal: p.userId, label: asked, parent: opts.chain ?? null, budgets: { tokens: budgets.tokens, steps: budgets.steps, wallMs: budgets.wallSeconds * 1000 } }) : null;
    const label = node?.label ?? asked;
    const t = Date.now();
    const row: RunRow = { id, tenant_id: p.tenantId, workspace_id: p.workspaceId ?? null, user_id: p.userId, agent_id: e.id, agent_name: e.name, agent_version: e.version, profile: def.profile, state: 'queued', label, input: await this.seal(p.tenantId, `agent-run-input:${id}`, input.input), output: null, error: null, budgets: JSON.stringify(budgets), usage: JSON.stringify(EMPTY_USAGE), job_id: null, replay_of: null, replay_from: null, created_at: t, started_at: null, finished_at: null, updated_at: t, chain_id: node?.chain ?? null, chain_node: node?.node ?? null, caller_kind: opts.caller?.kind ?? null, caller_id: opts.caller?.id ?? null, caller_node: opts.caller?.node ?? null };
    await this.db('agent_runs').insert({ ...row, ...(opts.scheduleId ? { schedule_id: opts.scheduleId } : {}) });
    await this.checkpoint(row, 0, { messages: await this.initialMessages(p, e, label, input.input, chainRefOfRun(row)), pending: [] }, EMPTY_USAGE);
    await this.enqueue(row);
    return this.summary(row, p.displayName);
  }

  // ---------- B-4102: agents delegating to agents ----------

  /**
   * The dispatcher runs a delegate (`agent:<name>`) here: a child run of the published agent, started by the
   * delegating run in its chain (under the call's node) as the same principal, at the chain's label (within the
   * delegate's ceiling), with budgets no larger than what the delegating run has left. The child is a job of its own;
   * the delegating run pauses (`ToolPending`) and continues with the answer when the child ends.
   */
  async runAsTool(ctx: ToolCallContext, entry: EntryRow, args: Record<string, unknown>): Promise<unknown> {
    // 1.7.0 (B-4006): the model of a chat profile hands a turn to an agent on the profile's list: a run under the
    // chat turn's chain (its depth and budgets apply), with the agent's own budgets; the chat service awaits it.
    if (ctx.source?.kind === 'message') return this.runFromChat(ctx, entry, args);
    if (ctx.source?.kind !== 'agent-run') throw new Error(`Only an agent run can delegate to ${entry.name}.`);
    const parent = (await this.db('agent_runs').where({ tenant_id: ctx.principal.tenantId, id: ctx.source.id }).first()) as RunRow | undefined;
    if (!parent) throw new Error('The delegating run no longer exists.');
    const pdef = (await this.registry.get(parent.tenant_id, parent.agent_id))?.definition as AgentDefinition | undefined;
    if (!(pdef?.agents ?? []).includes(entry.name) && !(pdef?.handoffs ?? []).includes(entry.name)) throw new Error(`tool_unavailable: ${entry.name} is not one of ${parent.agent_name}'s delegates.`);
    const pb = json<AgentBudgets>(parent.budgets, MAX_BUDGETS);
    const pu = json<RunUsage>(parent.usage, EMPTY_USAGE);
    const own = this.budgets((entry.definition as unknown as AgentDefinition).budgets);
    // What the delegating run has left (this call is one of its steps and tool calls).
    const budgets: AgentBudgets = {
      steps: Math.min(own.steps, pb.steps - pu.steps - 1),
      tokens: Math.min(own.tokens, pb.tokens - pu.tokens),
      wallSeconds: Math.min(own.wallSeconds, Math.floor((pb.wallSeconds * 1000 - pu.wallMs) / 1000)),
      toolCalls: Math.max(0, Math.min(own.toolCalls, pb.toolCalls - pu.toolCalls - 1))
    };
    if (budgets.steps < 1 || budgets.tokens < 1 || budgets.wallSeconds < 1) throw new Error(`child_budget: ${parent.agent_name} has too little of its budget left (${Math.max(0, pb.steps - pu.steps - 1)} steps, ${Math.max(0, pb.tokens - pu.tokens)} tokens) to delegate to ${entry.name}.`);
    const task = entry.input_schema ? JSON.stringify(args) : String(args.task ?? '').trim();
    if (!task) throw new Error(`The task for ${entry.name} is empty.`);
    let child;
    try {
      child = await this.start(ctx.principal, { agent: entry.id, input: task, label: ctx.label, budgets }, { chain: ctx.chain ?? null, caller: { kind: 'agent-run', id: parent.id, node: ctx.chain?.node ?? '' } });
    } catch (err) {
      if (err instanceof ChainLimit) throw new Error(`chain_limit: ${err.message}`, { cause: err });
      if (err instanceof HttpProblem) throw new Error(`tool_unavailable: ${entry.name}: ${err.detail ?? err.title}`, { cause: err });
      throw err;
    }
    await this.audit.append({ tenantId: parent.tenant_id, action: 'agent.run.delegated', kind: 'system', actor: { service: 'agents', user: parent.user_id, agent: parent.agent_name }, target: { run: child.id, agent: child.agent, version: child.agentVersion }, label: child.label, detail: { parentRun: parent.id, parentAgent: parent.agent_name, budgets, chain: child.chain?.id ?? null } });
    throw new ToolPending({ kind: 'agent-run', id: child.id }, `${entry.name} is working on it as run ${child.id}. This run pauses and continues with its answer.`);
  }

  /** 1.7.0 (B-4006): a run the model started from a chat turn (`agent:<name>` on the profile's list). */
  private async runFromChat(ctx: ToolCallContext, entry: EntryRow, args: Record<string, unknown>): Promise<unknown> {
    const task = entry.input_schema ? JSON.stringify(args) : String(args.task ?? '').trim();
    if (!task) throw new Error(`The task for ${entry.name} is empty.`);
    let child;
    try {
      child = await this.start(ctx.principal, { agent: entry.id, input: task, label: ctx.label }, { chain: ctx.chain ?? null, caller: { kind: 'chat-turn', id: ctx.source!.id, node: ctx.chain?.node ?? '' } });
    } catch (err) {
      if (err instanceof ChainLimit) throw new Error(`chain_limit: ${err.message}`, { cause: err });
      if (err instanceof HttpProblem) throw new Error(`tool_unavailable: ${entry.name}: ${err.detail ?? err.title}`, { cause: err });
      throw err;
    }
    await this.audit.append({ tenantId: ctx.principal.tenantId, action: 'agent.run.delegated', kind: 'system', actor: { service: 'chat', user: ctx.principal.userId }, target: { run: child.id, agent: child.agent, version: child.agentVersion, message: ctx.source!.id }, label: child.label, detail: { from: 'chat-turn' } });
    throw new ToolPending({ kind: 'agent-run', id: child.id }, `${entry.name} is working on it as run ${child.id}.`);
  }

  /**
   * A delegated run's answer for the run that awaits it: pending until it ends; its answer (parsed and checked against
   * the delegate's output schema when it declares one); or a typed error (B-4106): `child_budget`, `child_failed`,
   * `child_cancelled`, `child_output` (the answer does not match the schema), `child_label`.
   */
  async toolResult(ctx: ToolCallContext, entry: EntryRow, runId: string): Promise<CalleeResult> {
    const r = (await this.db('agent_runs').where({ tenant_id: ctx.principal.tenantId, id: runId }).first()) as RunRow | undefined;
    if (!r) return { state: 'failed', error: 'child_failed: The delegated run no longer exists.', type: 'failed' };
    if (!ENDED.includes(r.state)) return { state: 'pending' };
    const what = `${r.agent_name} run ${r.id}`;
    if (r.state === 'budget') return { state: 'failed', error: `child_budget: ${what} stopped at its budget${r.error ? `: ${r.error}` : '.'}`, type: 'budget' };
    if (r.state === 'cancelled') return { state: 'failed', error: `child_cancelled: ${what} was cancelled${r.error ? `: ${r.error}` : '.'}`, type: 'cancelled' };
    if (r.state !== 'succeeded') return { state: 'failed', error: `child_failed: ${what} failed${r.error ? `: ${r.error}` : '.'}`, type: 'failed' };
    if (labelRank(r.label) > labelRank(ctx.label)) return { state: 'failed', error: `child_label: the answer of ${what} is ${r.label}, above the ${ctx.label} data it was asked from.`, type: 'label' };
    const text = (await this.open<string | null>(r.tenant_id, `agent-run-output:${r.id}`, r.output, null)) ?? '';
    if (!entry.output_schema) return { state: 'done', result: { run: r.id, agent: r.agent_name, answer: text } };
    let answer: unknown;
    try {
      answer = answerJson(text);
    } catch {
      return { state: 'failed', error: `child_output: the answer of ${what} is not the JSON its output schema asks for.`, type: 'output' };
    }
    const bad = validateAgainst(entry.output_schema, answer);
    if (bad.length) return { state: 'failed', error: `child_output: the answer of ${what} does not match its output schema: ${bad.slice(0, 3).join('; ')}.`, type: 'output' };
    return { state: 'done', result: { run: r.id, agent: r.agent_name, answer } };
  }

  /** Runs this run started and awaits or awaited: delegated agent runs and workflow runs (B-4102, B-4104). */
  async children(p: Principal, id: string) {
    const r = await this.get(p, id);
    const agents = ((await this.db('agent_runs').where({ tenant_id: r.tenant_id, caller_kind: 'agent-run', caller_id: r.id }).orderBy('created_at').select('id', 'agent_name', 'caller_node', 'state', 'label', 'error')) as { id: string; agent_name: string; caller_node: string | null; state: string; label: Label; error: string | null }[]).filter((k) => clears(p.clearance, k.label)).map((k) => ({ kind: 'agent-run' as const, id: k.id, agent: k.agent_name, node: k.caller_node, state: k.state, label: k.label, error: k.error }));
    const workflows = ((await this.db('workflow_runs').where({ tenant_id: r.tenant_id, caller_kind: 'agent-run', caller_id: r.id }).orderBy('created_at').select('id', 'workflow_id', 'state', 'label', 'error')) as { id: string; workflow_id: string; state: string; label: Label; error: string | null }[]).filter((k) => clears(p.clearance, k.label)).map((k) => ({ kind: 'workflow-run' as const, id: k.id, workflowId: k.workflow_id, node: null, state: k.state, label: k.label, error: k.error }));
    return [...agents, ...workflows];
  }

  // ---------- B-3902: runs a workflow step awaits ----------

  async startForStep(p: Principal, input: { agent: string; input: string; label: Label; budgets?: Partial<AgentBudgets> }, caller: { runId: string; node: string; chain: ChainRef | null }): Promise<{ id: string; label: Label }> {
    const r = await this.start(p, input, { chain: caller.chain, caller: { kind: 'workflow-run', id: caller.runId, node: caller.node } });
    await this.audit.append({ tenantId: p.tenantId, action: 'agent.run.started', kind: 'system', actor: { service: 'workflows', user: p.userId }, target: { run: r.id, agent: r.agent, version: r.agentVersion }, label: r.label, detail: { workflowRun: caller.runId, step: caller.node } });
    return { id: r.id, label: r.label };
  }

  async stateForStep(tenantId: string, runId: string): Promise<{ state: string; output: string | null; error: string | null; label: Label; tokens: number } | null> {
    const r = (await this.db('agent_runs').where({ tenant_id: tenantId, id: runId }).first()) as RunRow | undefined;
    if (!r) return null;
    return { state: r.state, output: r.state === 'succeeded' ? await this.open<string | null>(r.tenant_id, `agent-run-output:${r.id}`, r.output, null) : null, error: r.error, label: r.label, tokens: json<RunUsage>(r.usage, EMPTY_USAGE).tokens };
  }

  /** A workflow run that awaited this run was cancelled: the run stops too. */
  async cancelForStep(tenantId: string, runId: string, reason: string): Promise<void> {
    const r = (await this.db('agent_runs').where({ tenant_id: tenantId, id: runId }).first()) as RunRow | undefined;
    if (!r || TERMINAL.includes(r.state)) return;
    await this.finish({ ...r, caller_kind: null }, 'cancelled', { error: reason });
    if (r.job_id) await this.jobs.cancel(r.tenant_id, r.job_id);
    await this.cancelDelegates(r, reason);
  }

  private budgets(base: Partial<AgentBudgets> | undefined, raise?: Partial<AgentBudgets>): AgentBudgets {
    const b = { steps: 20, tokens: 10_000, wallSeconds: 120, toolCalls: 8, ...(base ?? {}), ...(raise ?? {}) };
    return { steps: Math.min(b.steps, MAX_BUDGETS.steps), tokens: Math.min(b.tokens, MAX_BUDGETS.tokens), wallSeconds: Math.min(b.wallSeconds, MAX_BUDGETS.wallSeconds), toolCalls: Math.min(b.toolCalls, MAX_BUDGETS.toolCalls) };
  }

  /**
   * The system prompt with the instructions of the agent's published skills and the agent's accepted memories (at or
   * below the run's label, through the memory checkpoint), then the user's request.
   */
  private async initialMessages(p: Principal, e: EntryRow, label: Label, input: string, chain: ChainRef | null = null): Promise<ChatMessage[]> {
    const def = e.definition as unknown as AgentDefinition;
    const parts: string[] = [];
    if (def.systemPrompt) parts.push(def.systemPrompt);
    // B-4103: the skills' closure (what each builds on, each once, dependencies first).
    for (const skill of (await skillClosure(this.registry, p, def.skills ?? [])).skills) {
      // B-4101: a skill load is an invocation of the run's chain.
      if (chain && this.chains) await this.chains.finish(await this.chains.begin(p.tenantId, { kind: 'skill-load', callee: `${skill.name}@${skill.version}`, principal: p.userId, label, parent: chain }), 'succeeded');
      parts.push(`Skill ${skill.name} ${skill.version}:\n${String(skill.definition.instructions ?? '')}`);
    }
    const memories = this.memories ? await this.memories(p, e.name, label) : [];
    if (memories.length) parts.push(`What you remember from earlier runs (accepted by a curator):\n${memories.map((m) => `- ${m.text.replace(/\s+/g, ' ')}`).join('\n')}`);
    return [...(parts.length ? [{ role: 'system' as const, content: parts.join('\n\n') }] : []), { role: 'user', content: input }];
  }

  private async enqueue(r: RunRow): Promise<void> {
    const job = await this.jobs.enqueue({ tenantId: r.tenant_id, type: 'agent.run', payload: { runId: r.id }, createdBy: r.user_id, maxAttempts: 1 });
    await this.db('agent_runs').where({ id: r.id }).update({ job_id: job.id, state: 'queued', updated_at: Date.now() });
    this.emit(r, 'run.state', { runId: r.id, state: 'queued' });
  }

  async cancel(p: Principal, id: string) {
    const r = await this.get(p, id);
    if (r.user_id !== p.userId && !effectivePermissions(p).has('agents:manage')) throw forbidden('Only the run\'s owner or an agent admin can cancel it.', { step: 'role' });
    if (TERMINAL.includes(r.state)) throw conflict(`The run is already ${r.state}.`);
    await this.finish(r, 'cancelled', { error: `Cancelled by ${p.displayName}.` });
    if (r.job_id) await this.jobs.cancel(r.tenant_id, r.job_id);
    await this.cancelDelegates(r, `Run ${r.id} that delegated to it was cancelled.`);
    return { state: 'cancelled' as const };
  }

  /** B-4102: a cancelled run's delegated runs stop with it, and theirs. */
  private async cancelDelegates(r: Pick<RunRow, 'id' | 'tenant_id'>, reason: string): Promise<void> {
    const kids = (await this.db('agent_runs').where({ tenant_id: r.tenant_id, caller_kind: 'agent-run', caller_id: r.id }).select('id')) as { id: string }[];
    for (const k of kids) await this.cancelForStep(r.tenant_id, k.id, reason);
  }

  /** After a budget stop: raise the limits for this run (never beyond the maximum) and continue from the last checkpoint. */
  async resume(p: Principal, id: string, raise: Partial<AgentBudgets>) {
    const r = await this.get(p, id);
    if (r.user_id !== p.userId && !effectivePermissions(p).has('agents:manage')) throw forbidden('Only the run\'s owner or an agent admin can resume it.', { step: 'role' });
    if (r.state !== 'budget') throw conflict('Only a run stopped by its budget can be resumed.');
    // B-4106: a run another run or a workflow step awaited ended for its caller when it stopped (the caller took the
    // stop as a typed error and went on); it is not resumed behind the caller's back. Replay it instead.
    if (r.caller_kind && r.caller_id) throw conflict(`This run was started by ${r.caller_kind === 'agent-run' ? 'agent run' : 'workflow run'} ${r.caller_id}, which took its budget stop as an error and went on. Replay it as a new run instead.`);
    const before = json<AgentBudgets>(r.budgets, MAX_BUDGETS);
    const budgets = this.budgets(before, raise);
    const usage = json<RunUsage>(r.usage, EMPTY_USAGE);
    if (usage.steps >= budgets.steps || usage.tokens >= budgets.tokens || usage.wallMs >= budgets.wallSeconds * 1000 || usage.toolCalls >= budgets.toolCalls) throw conflict('Raise the limit that stopped the run above what it has used.');
    await this.db('agent_runs').where({ id: r.id }).update({ budgets: JSON.stringify(budgets), error: null, updated_at: Date.now() });
    const ref = chainRefOfRun(r);
    if (ref && this.chains) await this.chains.rebudget(ref, { tokens: budgets.tokens, steps: budgets.steps, wallMs: budgets.wallSeconds * 1000 });
    await this.enqueue({ ...r, budgets: JSON.stringify(budgets) });
    return { before, budgets };
  }

  /**
   * An approver's decision on a waiting step. Write calls may be approved by the run's owner (confirmation) or a
   * tool admin; destructive calls need a tool admin other than the owner.
   */
  async decide(p: Principal, id: string, n: number, decision: 'approve' | 'reject', note: string | null) {
    const r = await this.row(p.tenantId, id);
    if (!clears(p.clearance, r.label)) throw notFound('Run');
    if (r.state !== 'waiting') throw conflict('The run is not waiting on an approval.');
    const step = (await this.db('agent_steps').where({ run_id: r.id, n }).first()) as StepRow | undefined;
    if (!step || step.state !== 'waiting') throw conflict('That step is not waiting on an approval.');
    const meta = json<Record<string, unknown>>(step.meta, {});
    if (meta.awaiting) throw conflict('That step waits on a workflow run, not on an approval here; it continues when the workflow finishes.');
    const side = String(meta.sideEffect ?? 'write');
    const toolAdmin = effectivePermissions(p).has('tools:manage');
    if (side === 'destructive' && (!toolAdmin || r.user_id === p.userId)) throw forbidden('A destructive call needs a tool admin other than the run\'s owner.', { step: 'dual-control' });
    if (side !== 'destructive' && r.user_id !== p.userId && !toolAdmin) throw forbidden('Only the run\'s owner or a tool admin can approve this call.', { step: 'role' });
    const cp = await this.latestCheckpoint(r);
    const call = cp.state.pending.find((c) => c.step === n);
    if (!call) throw conflict('The pending call was not found in the checkpoint.');
    call.decision = decision === 'approve' ? 'approved' : 'rejected';
    call.decidedBy = p.displayName;
    call.note = note;
    await this.checkpoint(r, cp.n, cp.state, json<RunUsage>(r.usage, EMPTY_USAGE));
    await this.db('agent_steps').where({ id: step.id }).update({ meta: JSON.stringify({ ...meta, approval: { decision: call.decision, by: p.displayName, byId: p.userId, at: Date.now(), note } }) });
    await this.audit.append({ tenantId: r.tenant_id, action: decision === 'approve' ? 'agent.call.approved' : 'agent.call.rejected', kind: 'admin', actor: actorFrom(p), target: { run: r.id, step: n, tool: meta.tool }, label: r.label, detail: { sideEffect: side, note } });
    await this.enqueue(r);
    return { decision: call.decision };
  }

  /**
   * 1.7.0 (B-11703): the person's decision on a plan-first run's plan. Approved (as drafted or edited), the plan
   * becomes the step list the run follows: it is told to follow it and call only the tools it names, and a call
   * outside it pauses for a new approval. Declined, the run ends and nothing ran.
   */
  async decidePlan(p: Principal, id: string, input: { decision: 'approve' | 'decline'; steps?: { title: string; tools?: string[]; data?: string[] }[] }) {
    const r = await this.get(p, id);
    if (r.user_id !== p.userId && !effectivePermissions(p).has('agents:manage')) throw forbidden('Only the run\'s owner or an agent admin decides its plan.', { step: 'role' });
    if (r.state !== 'waiting' || r.plan_state !== 'awaiting') throw conflict('The run is not waiting on its plan.');
    const step = (await this.db('agent_steps').where({ run_id: r.id, title: 'Plan', state: 'waiting' }).orderBy('n', 'desc').first()) as StepRow | undefined;
    const t = Date.now();
    if (input.decision === 'decline') {
      await this.db('agent_runs').where({ id: r.id }).update({ plan_state: 'declined', updated_at: t });
      if (step) await this.db('agent_steps').where({ id: step.id }).update({ state: 'rejected', meta: JSON.stringify({ ...json<Record<string, unknown>>(step.meta, {}), approval: { decision: 'rejected', by: p.displayName, byId: p.userId, at: t } }) });
      await this.audit.append({ tenantId: r.tenant_id, action: 'agent.plan.declined', kind: 'decision', actor: actorFrom(p), target: { run: r.id, agent: r.agent_name }, label: r.label });
      await this.finish({ ...r, plan_state: 'declined' }, 'cancelled', { error: `The plan was declined by ${p.displayName}; nothing ran.` });
      return { decision: 'declined' as const };
    }
    const stored = r.plan ? await this.open<Plan>(r.tenant_id, `agent-run-plan:${r.id}`, r.plan, { steps: [], tools: [] }) : null;
    const edited = !!input.steps;
    const plan: Plan = input.steps ? normalizePlan({ steps: input.steps }, this.thinking?.planMaxSteps() ?? 12) : (stored ?? { steps: [], tools: [] });
    if (!plan.steps.length) throw conflict('This plan has no steps to approve.');
    const cp = await this.latestCheckpoint(r);
    cp.state.messages.push({ role: 'system', content: planInstruction(plan) });
    await this.checkpoint(r, cp.n, cp.state, json<RunUsage>(r.usage, EMPTY_USAGE));
    await this.db('agent_runs').where({ id: r.id }).update({ plan: await this.seal(r.tenant_id, `agent-run-plan:${r.id}`, plan), plan_state: 'approved', updated_at: t });
    if (step) await this.db('agent_steps').where({ id: step.id }).update({ state: 'ok', meta: JSON.stringify({ ...json<Record<string, unknown>>(step.meta, {}), steps: plan.steps.map((s) => s.title), tools: plan.tools, approval: { decision: 'approved', by: p.displayName, byId: p.userId, at: t, edited } }) });
    const ref = chainRefOfRun(r);
    if (ref && this.chains) await this.chains.note(ref, { plan: { steps: plan.steps.map((s) => ({ title: s.title, tools: s.tools })), approvedBy: p.displayName } }).catch(() => undefined);
    await this.audit.append({ tenantId: r.tenant_id, action: 'agent.plan.approved', kind: 'decision', actor: actorFrom(p), target: { run: r.id, agent: r.agent_name }, label: r.label, detail: { edited, steps: plan.steps.length, tools: plan.tools } });
    await this.enqueue({ ...r, plan_state: 'approved' });
    return { decision: 'approved' as const, plan };
  }

  /**
   * B-1006: a pending tool result this run awaits is ready (the workflow run finished). The run is queued again once,
   * and picks the result up from where it paused.
   */
  async resumeAwaiting(tenantId: string, runId: string): Promise<boolean> {
    const r = (await this.db('agent_runs').where({ tenant_id: tenantId, id: runId }).first()) as RunRow | undefined;
    if (!r) return false;
    const n = await this.db('agent_runs').where({ id: r.id, state: 'waiting' }).update({ state: 'queued', updated_at: Date.now() });
    if (n !== 1) return false;
    await this.enqueue(r);
    return true;
  }

  /** Whether an awaited workflow run has reached a final state (read from its table, as the dispatcher does). */
  private async awaitedDone(p: PendingResult): Promise<boolean> {
    if (p.kind === 'agent-run') {
      const a = (await this.db('agent_runs').where({ id: p.id }).first('state')) as { state: RunState } | undefined;
      return !a || ENDED.includes(a.state);
    }
    if (p.kind !== 'workflow-run') return false;
    const w = (await this.db('workflow_runs').where({ id: p.id }).first('state')) as { state: string } | undefined;
    return !w || ['succeeded', 'failed', 'rejected', 'cancelled'].includes(w.state);
  }

  /** A new run that reuses steps before `from` and continues from the checkpoint before it, with the same label and budget. */
  async replay(p: Principal, id: string, from: number) {
    const src = await this.get(p, id);
    if (src.user_id !== p.userId && !effectivePermissions(p).has('agents:manage')) throw forbidden('Only the run\'s owner or an agent admin can replay it.', { step: 'role' });
    const cpRow = (await this.db('agent_checkpoints').where({ run_id: src.id, n: from - 1 }).first()) as { id: string; n: number; state: string; usage: string } | undefined;
    if (!cpRow) throw notFound(`Checkpoint before step ${from}`);
    await this.resolveAgent(p, src.agent_id);
    const state = await this.open<CheckpointState>(src.tenant_id, `agent-checkpoint:${src.id}:${cpRow.n}`, cpRow.state, { messages: [], pending: [] });
    // Approvals do not carry over: a replayed run asks again.
    state.pending = state.pending.map((c) => ({ name: c.name, arguments: c.arguments }));
    const usage = { ...json<RunUsage>(cpRow.usage, EMPTY_USAGE) };
    const t = Date.now();
    const nid = ulid();
    const row: RunRow = { ...src, id: nid, user_id: p.userId, workspace_id: p.workspaceId ?? src.workspace_id, state: 'queued', input: await this.seal(src.tenant_id, `agent-run-input:${nid}`, await this.open<string>(src.tenant_id, `agent-run-input:${src.id}`, src.input, '')), output: null, error: null, usage: JSON.stringify(usage), job_id: null, replay_of: src.id, replay_from: from, created_at: t, started_at: null, finished_at: null, updated_at: t, chain_id: null, chain_node: null, caller_kind: null, caller_id: null, caller_node: null };
    // A replay is a new invocation: the root of a chain of its own, with the run's budgets.
    if (this.chains) {
      const b = json<AgentBudgets>(src.budgets, MAX_BUDGETS);
      const node = await this.chains.begin(src.tenant_id, { kind: 'agent-run', ref: nid, callee: src.agent_name, principal: p.userId, label: src.label, budgets: { tokens: b.tokens, steps: b.steps, wallMs: b.wallSeconds * 1000 } });
      row.chain_id = node.chain;
      row.chain_node = node.node;
    }
    await this.db('agent_runs').insert(row);
    for (const s of (await this.db('agent_steps').where({ run_id: src.id }).andWhere('n', '<', from).orderBy('n')) as StepRow[]) {
      const sid = ulid();
      const detail = await this.open<unknown>(src.tenant_id, `agent-step:${s.id}`, s.detail, null);
      await this.db('agent_steps').insert({ ...s, id: sid, run_id: nid, meta: JSON.stringify({ ...json<Record<string, unknown>>(s.meta, {}), reused: true }), detail: detail == null ? null : await this.seal(src.tenant_id, `agent-step:${sid}`, detail) });
    }
    await this.checkpoint(row, from - 1, state, usage);
    await this.audit.append({ tenantId: src.tenant_id, action: 'agent.run.replayed', kind: 'admin', actor: actorFrom(p), target: { run: nid, source: src.id }, label: src.label, detail: { from } });
    await this.enqueue(row);
    return this.summary(row, p.displayName);
  }

  // ---------- checkpoints and steps ----------

  private async checkpoint(r: Pick<RunRow, 'id' | 'tenant_id'>, n: number, state: CheckpointState, usage: RunUsage): Promise<void> {
    const sealed = await this.seal(r.tenant_id, `agent-checkpoint:${r.id}:${n}`, state);
    await this.db('agent_checkpoints').where({ run_id: r.id, n }).delete();
    await this.db('agent_checkpoints').insert({ id: ulid(), run_id: r.id, n, state: sealed, usage: JSON.stringify(usage), created_at: Date.now() });
  }

  private async latestCheckpoint(r: RunRow): Promise<{ n: number; state: CheckpointState }> {
    const cp = (await this.db('agent_checkpoints').where({ run_id: r.id }).orderBy('n', 'desc').first()) as { n: number; state: string } | undefined;
    if (!cp) throw conflict('The run has no checkpoint.');
    return { n: Number(cp.n), state: await this.open<CheckpointState>(r.tenant_id, `agent-checkpoint:${r.id}:${cp.n}`, cp.state, { messages: [], pending: [] }) };
  }

  private async addStep(r: RunRow, n: number, s: { lane: Lane; title: string; state: StepState; meta: Record<string, unknown>; detail: unknown }): Promise<void> {
    const id = ulid();
    const t = Date.now();
    await this.db('agent_steps').where({ run_id: r.id, n }).delete();
    await this.db('agent_steps').insert({ id, run_id: r.id, n, lane: s.lane, title: s.title.slice(0, 200), state: s.state, meta: JSON.stringify(s.meta), detail: await this.seal(r.tenant_id, `agent-step:${id}`, s.detail), created_at: t, finished_at: s.state === 'waiting' ? null : t });
    this.emit(r, 'run.step', { runId: r.id, n, lane: s.lane, title: s.title, state: s.state, meta: s.meta });
  }

  private emit(r: Pick<RunRow, 'user_id' | 'tenant_id'>, event: string, data: Record<string, unknown>): void {
    this.bus.publish(TOPICS.runEvent, { userId: r.user_id, event, data });
    if (event === 'run.state' && data.state === 'waiting') this.bus.publish(TOPICS.runEvent, { tenantId: r.tenant_id, perm: 'tools:manage', event, data });
  }

  private async finish(r: RunRow, state: RunState, extra: { error?: string | null; output?: string | null; usage?: RunUsage } = {}): Promise<void> {
    const upd: Record<string, unknown> = { state, updated_at: Date.now() };
    if (TERMINAL.includes(state)) upd.finished_at = Date.now();
    if (extra.error !== undefined) upd.error = extra.error?.slice(0, 1000) ?? null;
    if (extra.output != null) upd.output = await this.seal(r.tenant_id, `agent-run-output:${r.id}`, extra.output);
    if (extra.usage) upd.usage = JSON.stringify(extra.usage);
    // A cancellation that raced the worker wins: never overwrite it.
    const q = this.db('agent_runs').where({ id: r.id });
    if (state !== 'cancelled') q.whereNot({ state: 'cancelled' });
    await q.update(upd);
    this.emit(r, 'run.state', { runId: r.id, state, error: upd.error ?? null });
    const ref = chainRefOfRun(r);
    if (ref && this.chains) await this.chains.finish(ref, state === 'budget' ? 'failed' : state === 'queued' ? 'running' : state, (upd.error as string | null | undefined) ?? null, state === 'budget' ? 'budget' : null);
    // B-3902: the workflow step awaiting this run picks up its end (a budget stop ends it for the step too).
    if ((r.caller_kind === 'workflow-run' || r.caller_kind === 'redteam-run' || r.caller_kind === 'chat-turn') && r.caller_id && ENDED.includes(state)) await this.onCallerDone?.(r.tenant_id, r.caller_kind, r.caller_id).catch((err: unknown) => this.log.warn({ run: r.id, err: (err as Error).message }, 'could not resume the workflow run awaiting an agent run'));
    // B-4102: the agent run that delegated to this one picks up its answer (or its typed error).
    if (r.caller_kind === 'agent-run' && r.caller_id && ENDED.includes(state)) await this.resumeAwaiting(r.tenant_id, r.caller_id).catch((err: unknown) => this.log.warn({ run: r.id, err: (err as Error).message }, 'could not resume the agent run that delegated to this one'));
    if (state === 'failed' || state === 'succeeded') await this.audit.append({ tenantId: r.tenant_id, action: `agent.run.${state}`, kind: 'system', actor: { service: 'agents', user: r.user_id, agent: r.agent_name }, target: { run: r.id, agent: r.agent_name, version: r.agent_version }, label: r.label, detail: { error: upd.error ?? null, usage: extra.usage ?? null } });
  }

  /** A run's task and final answer, opened, for memory extraction (B-3701). */
  async runTexts(tenantId: string, runId: string): Promise<{ agent: string; label: Label; input: string; output: string | null; userId: string; workspaceId: string | null } | null> {
    const r = (await this.db('agent_runs').where({ tenant_id: tenantId, id: runId }).first()) as RunRow | undefined;
    if (!r) return null;
    return { agent: r.agent_name, label: r.label, input: await this.open<string>(r.tenant_id, `agent-run-input:${r.id}`, r.input, ''), output: await this.open<string | null>(r.tenant_id, `agent-run-output:${r.id}`, r.output, null), userId: r.user_id, workspaceId: r.workspace_id };
  }

  private async resolveProfile(p: Principal, profile: string, label: Label): Promise<ResolvedProfile> {
    const r = await this.gateway.resolve(p.tenantId, profile);
    if (r.model.state !== 'approved' && r.model.state !== 'deprecated') throw new HttpProblem(409, 'Profile unavailable', `Profile ${r.profile.name} routes to ${r.model.name}, which is ${r.model.state}.`);
    if (!clears(p.clearance, r.profile.label)) throw forbidden(`Profile ${r.profile.name} needs ${r.profile.label} clearance.`, { step: 'clearance' });
    const d = authorize(p, 'inference:invoke', { tenantId: p.tenantId, label, zoneCeiling: r.profile.label, profiles: [profile, r.profile.name] });
    if (!d.allow) throw forbidden(d.step === 'zone' ? `This run is ${label}; profile ${r.profile.name} only handles data up to ${r.profile.label}.` : d.reason, { step: d.step, action: 'inference:invoke' });
    return r;
  }

  // ---------- execution ----------

  /** The job: continues the run from its latest checkpoint until it finishes, pauses or stops at a budget. */
  private async execute(runId: string, signal: AbortSignal): Promise<unknown> {
    const run = (await this.db('agent_runs').where({ id: runId }).first()) as RunRow | undefined;
    if (!run || run.state !== 'queued') return { skipped: run?.state ?? 'missing' };
    const segment = Date.now();
    const usage: RunUsage = { ...EMPTY_USAGE, ...json<RunUsage>(run.usage, EMPTY_USAGE) };
    const baseWall = usage.wallMs;
    const tick = () => (usage.wallMs = baseWall + (Date.now() - segment));
    await this.db('agent_runs').where({ id: run.id, state: 'queued' }).update({ state: 'running', started_at: run.started_at ?? Date.now(), updated_at: Date.now() });
    this.emit(run, 'run.state', { runId: run.id, state: 'running' });
    try {
      const p = await this.principalFor(run.tenant_id, run.user_id, run.workspace_id);
      if (!p) throw new Error('The run\'s owner is disabled.');
      // B-4101: the run's node in its chain, carried on the row across instances and retries.
      const chain = this.chains ? chainRefOfRun(run) : null;
      if (chain) await this.chains!.finish(chain, 'running');
      // What the run uses is charged to its chain's root; a used-up root stops the run before its next step.
      const charge = async (u: { tokens?: number; steps?: number; wallMs?: number; gpuMs?: number; thinkingTokens?: number }) => {
        if (chain) await this.chains!.charge(chain, u);
      };
      const perm = authorize(p, 'agents:run', { tenantId: run.tenant_id, label: run.label });
      if (!perm.allow) throw new Error(`The owner can no longer run agents: ${perm.reason}.`);
      const agent = await this.registry.get(run.tenant_id, run.agent_id);
      if (!agent || agent.status === 'retired') throw new Error(`${run.agent_name} is retired.`);
      const def = agent.definition as unknown as AgentDefinition;
      const budgets = json<AgentBudgets>(run.budgets, MAX_BUDGETS);
      // 1.6.0 (B-7701): with an identity, the run acts within the agent's roles and ceiling as well as the owner's.
      const acting = this.identity ? await this.identity(p, run.agent_name) : p;
      if (acting.agent && labelRank(run.label) > labelRank(acting.clearance)) throw new Error(`${run.agent_name}'s identity handles data up to ${acting.clearance}; this run is ${run.label}.`);
      const handoffs = def.handoffs ?? [];
      const resolved = await this.resolveProfile(acting, def.profile, run.label);
      // B-4103: the tools the agent's skills (and what they build on) need are offered with its own; B-4102, B-4104:
      // so are its delegates (`agent:<name>`) and the workflows it lists (`workflow:<name>`).
      const closure = await skillClosure(this.registry, acting, def.skills ?? []);
      const names = [...new Set([...(def.tools ?? []), ...closure.tools])];
      const own = await this.tools.resolve(acting, names, run.label);
      // 1.6.0 (B-7801): a handoff is offered like a delegate, described as handing the conversation over.
      const callees = await this.tools.resolveCallees(acting, { agents: [...new Set([...(def.agents ?? []), ...handoffs])], workflows: def.workflows ?? [] }, run.label, own.tools.map((t) => t.fn));
      for (const t of callees.tools) {
        if (t.entry.kind === 'agent' && handoffs.includes(t.entry.name) && !(def.agents ?? []).includes(t.entry.name)) {
          t.def = { ...t.def, function: { ...t.def.function, description: `Hand the conversation to ${t.entry.name}, a specialist that answers the user in your place; pass it the context it needs as the task. Your run ends with its answer. ${t.entry.description ?? ''}`.trim() } };
        }
      }
      const tools = [...own.tools, ...callees.tools];
      const hidden = [...own.hidden, ...callees.hidden];
      const offered = names.length + (def.agents?.length ?? 0) + handoffs.length + (def.workflows?.length ?? 0);
      // The agent's memory policy decides whether the run may propose memories (through the `remember` tool).
      const policy = def.memory?.write === 'propose' && this.proposeMemory ? def.memory : null;
      const toolsOn = (tools.length > 0 || !!policy) && resolved.model.capabilities.includes('tools') && !resolved.model.evaluation?.toolsWithheld;
      let proposals = Number(((await this.db('agent_steps').where({ run_id: run.id, title: 'remember', state: 'ok' }).count({ c: '*' }).first()) as { c: number | string } | undefined)?.c ?? 0);
      if (offered && !toolsOn && !hidden.length) throw new Error(`${resolved.model.name} has no tools capability; the agent's tools cannot be offered.`);
      const cp = await this.latestCheckpoint(run);
      let n = Math.max(cp.n, Number((await this.db('agent_steps').where({ run_id: run.id }).max({ m: 'n' }).first())?.m ?? 0));
      const { messages } = cp.state;
      let pending = cp.state.pending;
      // 1.7.0 (B-11705): the run's thinking level, within the profile's ceiling, noted on its chain node.
      // 1.7.0 (B-11702): a spent profile or workspace thinking budget drops the level to low, as in chat.
      const asked = capLevel(def.think ?? resolved.profile.think_default, resolved.profile.think_ceiling);
      const budget = this.thinking ? await this.thinking.budget(run.tenant_id, run.workspace_id ?? null, resolved.profile, asked).catch(() => null) : null;
      const level = budget?.level ?? asked;
      if (chain && this.chains) await this.chains.note(chain, { think: level }).catch(() => undefined);
      // 1.7.0 (B-11703): a plan-first run drafts its plan before anything runs and waits for the person's decision;
      // an approved plan bounds the tools the run may call without a new approval.
      let plan: Plan | null = run.plan ? await this.open<Plan>(run.tenant_id, `agent-run-plan:${run.id}`, run.plan, { steps: [], tools: [] }) : null;
      if (def.planFirst && this.thinking && !run.plan_state) {
        await this.quotas.admit(run.tenant_id, run.workspace_id);
        const started = Date.now();
        const planMessages = this.thinking.planMessages(null, messages, tools.map((t) => ({ name: t.fn, description: t.entry.description })));
        const lease = await this.gateway.acquire(resolved.profile, resolved.model, run.label, { signal });
        let text = '';
        let tokens = 0;
        try {
          const options: Record<string, unknown> = {};
          if (resolved.profile.num_ctx) options.num_ctx = resolved.profile.num_ctx;
          const thinkReq = thinkingRequest(resolved.model, 'off', planMessages);
          for await (const chunk of lease.client.chat({ model: resolved.model.name, messages: planMessages, ...thinkReq, options }, signal)) {
            if (chunk.message?.content) text += chunk.message.content;
            if (chunk.done) tokens = (chunk.prompt_eval_count ?? 0) + (chunk.eval_count ?? 0);
          }
          if (thinkingMode(resolved.model) === 'template') text = splitThink(text).content;
        } finally {
          lease.release(null);
        }
        if (!tokens) tokens = Math.ceil((planMessages.reduce((a, m) => a + m.content.length, 0) + text.length) / 4);
        usage.tokens += tokens;
        await this.quotas.record({ tenantId: run.tenant_id, workspaceId: run.workspace_id, userId: run.user_id, kind: 'agent', profileId: resolved.profile.id, model: resolved.model.name, poolId: lease.pool.id, promptTokens: Math.round(tokens / 2), outputTokens: tokens - Math.round(tokens / 2) });
        plan = parsePlan(text, this.thinking.planMaxSteps());
        n++;
        usage.steps++;
        const t = Date.now();
        if (plan) {
          await this.db('agent_runs').where({ id: run.id }).update({ plan: await this.seal(run.tenant_id, `agent-run-plan:${run.id}`, plan), plan_state: 'awaiting', usage: JSON.stringify(usage), updated_at: t });
          await this.addStep(run, n, { lane: 'think', title: 'Plan', state: 'waiting', meta: { plan: true, steps: plan.steps.map((s) => s.title), tools: plan.tools, tokens, waitingSince: t, approvers: "the run's owner", durationMs: t - started }, detail: { plan, text } });
          tick();
          await this.checkpoint(run, n, { messages, pending }, usage);
          await charge({ tokens, steps: 1, wallMs: t - started });
          await this.audit.append({ tenantId: run.tenant_id, action: 'agent.plan.drafted', kind: 'system', actor: { service: 'agents', user: run.user_id, agent: run.agent_name }, target: { run: run.id, agent: run.agent_name }, label: run.label, detail: { steps: plan.steps.length, tools: plan.tools } });
          throw new Pause('waiting', 'Waiting for the plan to be approved.');
        }
        // No readable plan: the run goes on without one, and says so in its first step.
        await this.db('agent_runs').where({ id: run.id }).update({ plan_state: 'declined', usage: JSON.stringify(usage), updated_at: t });
        await this.addStep(run, n, { lane: 'think', title: 'Plan', state: 'failed', meta: { plan: true, tokens, durationMs: t - started }, detail: { plan: null, text, note: 'The model gave no readable plan; the run continues without one.' } });
        tick();
        await this.checkpoint(run, n, { messages, pending }, usage);
        await charge({ tokens, steps: 1, wallMs: t - started });
        plan = null;
      }
      const planTools = run.plan_state === 'approved' && plan ? new Set(plan.tools) : null;

      const budgetStop = async (what: string) => {
        tick();
        await this.checkpoint(run, n, { messages, pending }, usage);
        throw new Pause('budget', what);
      };

      for (;;) {
        if (signal.aborted) throw signal.reason as Error;
        // Doing and calculating: the calls the model asked for in its last thinking step.
        while (pending.length) {
          const call = pending[0]!;
          if (call.name === REMEMBER_TOOL.function.name && policy && call.step == null) {
            if (usage.steps >= budgets.steps) await budgetStop(`Stopped at ${usage.steps} of ${budgets.steps} steps.`);
            const text = String(call.arguments.text ?? '');
            const type = String(call.arguments.type ?? 'progress');
            let result: Record<string, unknown> | null = null;
            let error: string | null = null;
            if (proposals >= policy.maxPerRun) error = `The agent's memory policy allows ${policy.maxPerRun} proposal${policy.maxPerRun === 1 ? '' : 's'} per run.`;
            else if (!policy.types.includes(type)) error = `The agent's memory policy does not allow ${type} memories.`;
            else {
              try {
                const mem = await this.proposeMemory!(acting, { agent: run.agent_name, runId: run.id, text, type, label: run.label });
                proposals++;
                result = { memory: mem.id, state: 'proposed', note: 'A curator decides whether it is kept.' };
              } catch (err) {
                error = err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message;
              }
            }
            n++;
            usage.steps++;
            await this.addStep(run, n, { lane: 'do', title: 'remember', state: result ? 'ok' : 'denied', meta: { tool: 'remember', memory: result?.memory ?? null, type }, detail: { arguments: call.arguments, result, error } });
            messages.push({ role: 'tool', tool_name: REMEMBER_TOOL.function.name, content: JSON.stringify(result ?? { error }) });
            pending = pending.slice(1);
            tick();
            await this.checkpoint(run, n, { messages, pending }, usage);
            await this.db('agent_runs').where({ id: run.id }).update({ usage: JSON.stringify(usage), updated_at: Date.now() });
            await charge({ steps: 1 });
            continue;
          }
          const tool = tools.find((t) => t.fn === call.name);
          // A call that already has a step is coming back from an approval; its step was counted then.
          const isNew = call.step == null;
          const stepN = call.step ?? n + 1;
          if (isNew && usage.steps >= budgets.steps) await budgetStop(`Stopped at ${usage.steps} of ${budgets.steps} steps.`);
          if (isNew && tool && usage.toolCalls >= budgets.toolCalls) await budgetStop(`Stopped at ${usage.toolCalls} of ${budgets.toolCalls} tool calls.`);
          const awaited = !!call.awaiting;
          // 1.7.0 (B-11703): a call outside the approved plan pauses for a new approval (a decided call goes on).
          if (tool && planTools && isNew && !call.decision && !planTools.has(tool.fn) && !planTools.has(tool.entry.name)) {
            usage.steps++;
            n = Math.max(n, stepN);
            call.step = stepN;
            await this.addStep(run, stepN, { lane: 'do', title: tool.entry.name, state: 'waiting', meta: { tool: tool.entry.name, version: tool.entry.version, impl: tool.entry.impl, sideEffect: tool.sideEffect, ceiling: tool.entry.label, deviation: true, waitingSince: Date.now(), approvers: "the run's owner" }, detail: { arguments: call.arguments, note: `${tool.entry.name} is not in the approved plan.` } });
            tick();
            await this.checkpoint(run, stepN, { messages, pending }, usage);
            throw new Pause('waiting', `${tool.entry.name} is not in the approved plan; it needs a new approval.`);
          }
          let outcome: ToolOutcome;
          if (tool && call.awaiting) outcome = await this.tools.awaitResult({ principal: acting, label: run.label, source: { kind: 'agent-run', id: run.id }, signal, chain }, tool, call.arguments, call.awaiting);
          else if (!tool) outcome = { name: call.name, arguments: call.arguments, ok: false, denied: true, decision: null, durationMs: 0, error: `tool_unavailable: ${call.name} is not one of this agent's tools${hidden.length ? ` (hidden: ${hidden.map((h) => `${h.name}, ${h.reason}`).join('; ')})` : ''}.` };
          else if (call.decision === 'rejected') outcome = { name: tool.entry.name, arguments: call.arguments, ok: false, denied: true, decision: null, durationMs: 0, error: `Rejected by ${call.decidedBy ?? 'the approver'}${call.note ? `: ${call.note}` : ''}. Nothing was run.` };
          else outcome = await this.tools.call({ principal: acting, label: run.label, source: { kind: 'agent-run', id: run.id }, signal, approved: call.decision === 'approved', chain }, tool, call.arguments);

          if (outcome.pending) {
            // B-1006: the call is running elsewhere (a workflow paused on an approval). Keep the step waiting and
            // pause without a worker; the run is queued again when the result is ready.
            if (!awaited) {
              if (isNew) usage.steps++;
              if (tool) usage.toolCalls++;
              n = Math.max(n, stepN);
              call.step = stepN;
              call.awaiting = outcome.pending;
              await this.addStep(run, stepN, { lane: 'do', title: tool!.entry.name, state: 'waiting', meta: this.toolMeta(tool!, outcome, { waitingSince: Date.now(), awaiting: outcome.pending, approvers: outcome.pending.kind === 'agent-run' ? `delegated run ${outcome.pending.id.slice(-6).toLowerCase()}, and the approvers of what it holds` : `the approvers of workflow run ${outcome.pending.id.slice(-6).toLowerCase()}` }), detail: { arguments: call.arguments, reason: outcome.error } });
              tick();
              await this.checkpoint(run, stepN, { messages, pending }, usage);
            }
            throw new Pause('waiting', outcome.error ?? 'Waiting on a tool result.', outcome.pending);
          }
          if (outcome.needsApproval) {
            if (isNew) usage.steps++;
            n = Math.max(n, stepN);
            call.step = stepN;
            await this.addStep(run, stepN, { lane: 'do', title: tool!.entry.name, state: 'waiting', meta: this.toolMeta(tool!, outcome, { waitingSince: Date.now(), approvers: tool!.sideEffect === 'destructive' ? 'a tool admin other than the owner' : 'the run\'s owner or a tool admin' }), detail: { arguments: call.arguments, reason: outcome.error } });
            tick();
            await this.checkpoint(run, stepN, { messages, pending }, usage);
            throw new Pause('waiting', outcome.error ?? 'Waiting on approval.');
          }
          // B-4102: what a delegate spent counts against this run's token budget too (it began within what was left).
          if (awaited && call.awaiting?.kind === 'agent-run') {
            const kid = (await this.db('agent_runs').where({ id: call.awaiting.id }).first('usage')) as { usage: string } | undefined;
            usage.tokens += json<RunUsage>(kid?.usage ?? null, EMPTY_USAGE).tokens;
          }
          n = Math.max(n, stepN);
          if (isNew) usage.steps++;
          if (tool && !awaited && !outcome.denied && isNew) usage.toolCalls++;
          else if (tool && !awaited && call.decision === 'approved') usage.toolCalls++;
          const calc = tool?.entry.impl === 'builtin' && tool.entry.definition.builtin === 'calculate';
          if (calc && outcome.ok) usage.calcCalls++;
          const state: StepState = call.decision === 'rejected' ? 'rejected' : outcome.denied ? 'denied' : outcome.ok ? 'ok' : 'failed';
          await this.addStep(run, stepN, {
            lane: calc ? 'calc' : 'do',
            title: tool?.entry.name ?? call.name,
            state,
            meta: { ...(tool ? this.toolMeta(tool, outcome) : { tool: call.name }), ...(call.decision ? { approval: { decision: call.decision, by: call.decidedBy ?? null, note: call.note ?? null } } : {}) },
            detail: { arguments: outcome.arguments, result: outcome.result ?? null, error: outcome.error ?? null, ...(outcome.errorType ? { errorType: outcome.errorType } : {}) }
          });
          // 1.6.0 (B-7801): a handoff's answer is this run's answer; the reader sees which agent answered.
          if (tool && awaited && call.awaiting?.kind === 'agent-run' && handoffs.includes(tool.entry.name) && outcome.ok) {
            const child = call.awaiting.id;
            const answer = outcome.result && typeof outcome.result === 'object' && 'answer' in outcome.result ? (outcome.result as { answer: unknown }).answer : outcome.result;
            const text = typeof answer === 'string' ? answer : JSON.stringify(answer ?? '');
            pending = pending.slice(1);
            tick();
            await this.checkpoint(run, n, { messages, pending }, usage);
            await this.db('agent_runs').where({ id: run.id }).update({ usage: JSON.stringify(usage), handed_to: JSON.stringify({ agent: tool.entry.name, run: child }), updated_at: Date.now() });
            await charge({ steps: isNew ? 1 : 0 });
            await this.audit.append({ tenantId: run.tenant_id, action: 'agent.run.handed_off', kind: 'system', actor: { service: 'agents', user: run.user_id, agent: run.agent_name }, target: { run: run.id, agent: run.agent_name, to: tool.entry.name, toRun: child }, label: run.label, detail: { step: stepN } });
            await this.finish({ ...run, handed_to: JSON.stringify({ agent: tool.entry.name, run: child }) }, 'succeeded', { output: text, usage, error: null });
            return { state: 'succeeded', steps: usage.steps, handedTo: tool.entry.name };
          }
          // B-6901: a result reaches the model as untrusted content, datamarked when the profile marks it.
          messages.push({ role: 'tool', tool_name: call.name, content: toolResultContent(outcome.ok ? outcome.result : { error: outcome.error, ...(outcome.errorType ? { type: outcome.errorType } : {}) }, { name: tool?.entry.name ?? call.name, untrusted: outcome.ok ? (outcome.untrusted ?? null) : null, marking: resolved.profile.trust_marking !== false }) });
          pending = pending.slice(1);
          tick();
          await this.checkpoint(run, n, { messages, pending }, usage);
          await this.db('agent_runs').where({ id: run.id }).update({ usage: JSON.stringify(usage), updated_at: Date.now() });
          // A workflow tool's run charges its own steps and time to the chain; other calls are this run's.
          await charge({ steps: isNew ? 1 : 0, wallMs: tool && tool.entry.impl !== 'workflow' && tool.entry.impl !== 'agent' && !awaited ? outcome.durationMs : 0 });
        }

        // Thinking: one model call.
        if (usage.steps >= budgets.steps) await budgetStop(`Stopped at ${usage.steps} of ${budgets.steps} steps.`);
        if (usage.tokens >= budgets.tokens) await budgetStop(`Stopped at ${usage.tokens} of ${budgets.tokens} tokens.`);
        tick();
        const left = budgets.wallSeconds * 1000 - usage.wallMs;
        if (left <= 0) await budgetStop(`Stopped at the ${budgets.wallSeconds} s wall-time limit.`);
        if (chain) {
          const over = await this.chains!.check(chain);
          if (over) await budgetStop(over);
        }
        await this.quotas.admit(run.tenant_id, run.workspace_id);
        const wall = AbortSignal.timeout(left);
        const stepSignal = AbortSignal.any([signal, wall]);
        const started = Date.now();
        let lease;
        try {
          lease = await this.gateway.acquire(resolved.profile, resolved.model, run.label, { signal: stepSignal });
        } catch (err) {
          if (wall.aborted && !signal.aborted) await budgetStop(`Stopped at the ${budgets.wallSeconds} s wall-time limit while waiting for the model.`);
          throw err;
        }
        let content = '';
        let thinking = '';
        const calls: NonNullable<ChatMessage['tool_calls']> = [];
        let tokens = 0;
        let gpuNs = 0;
        try {
          const options: Record<string, unknown> = {};
          if (resolved.profile.num_ctx) options.num_ctx = resolved.profile.num_ctx;
          if (resolved.profile.temperature != null) options.temperature = resolved.profile.temperature;
          const thinkReq = thinkingRequest(resolved.model, level, messages); // B-11707: by the model's thinking mode; B-11705: the run's level
          for await (const chunk of lease.client.chat({ model: resolved.model.name, messages, ...thinkReq, ...(toolsOn ? { tools: [...tools.map((t) => t.def), ...(policy ? [REMEMBER_TOOL] : [])] } : {}), options }, stepSignal)) {
            if (chunk.message?.content) content += chunk.message.content;
            if (chunk.message?.thinking) thinking += chunk.message.thinking;
            if (chunk.message?.tool_calls?.length) calls.push(...chunk.message.tool_calls);
            if (chunk.done) {
              tokens = (chunk.prompt_eval_count ?? 0) + (chunk.eval_count ?? 0);
              gpuNs = (chunk.prompt_eval_duration ?? 0) + (chunk.eval_duration ?? 0) + (chunk.load_duration ?? 0);
            }
          }
          if (thinkingMode(resolved.model) === 'template' && level !== 'off') {
            const sp = splitThink(content); // B-11707: a template model's <think> block is its thinking
            if (sp.thinking) thinking += sp.thinking;
            content = sp.content;
          }
        } catch (err) {
          if (wall.aborted && !signal.aborted) await budgetStop(`Stopped at the ${budgets.wallSeconds} s wall-time limit during a thinking step.`);
          throw err;
        } finally {
          lease.release(null);
        }
        if (!tokens) tokens = Math.ceil((messages.reduce((a, m) => a + m.content.length, 0) + content.length + thinking.length) / 4);
        const thinkingTokens = thinking ? Math.round((tokens * thinking.length) / (thinking.length + content.length || 1)) : 0; // 1.7.0 (B-11705)
        n++;
        usage.steps++;
        usage.tokens += tokens;
        usage.gpuMs += gpuNs / 1e6;
        await this.quotas.record({ tenantId: run.tenant_id, workspaceId: run.workspace_id, userId: run.user_id, kind: 'agent', profileId: resolved.profile.id, model: resolved.model.name, poolId: lease.pool.id, promptTokens: tokens, outputTokens: 0, gpuMs: gpuNs / 1e6, thinkingTokens, thinkingDropped: !!budget?.dropped });
        const toolCalls = calls.filter((c) => toolsOn && c?.function?.name);
        await this.addStep(run, n, {
          lane: 'think',
          title: toolCalls.length ? 'Plan' : 'Answer',
          state: 'ok',
          meta: { tokens, think: level, thinkingTokens, profile: resolved.profile.name, model: resolved.model.name, durationMs: Date.now() - started, proposal: toolCalls.map((c) => c.function.name) },
          detail: { content, thinking: thinking || null, toolCalls: toolCalls.map((c) => ({ name: c.function.name, arguments: c.function.arguments })) }
        });
        messages.push({ role: 'assistant', content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
        pending = toolCalls.map((c) => ({ name: c.function.name, arguments: (c.function.arguments ?? {}) as Record<string, unknown> }));
        tick();
        await this.checkpoint(run, n, { messages, pending }, usage);
        await this.db('agent_runs').where({ id: run.id }).update({ usage: JSON.stringify(usage), updated_at: Date.now() });
        await charge({ tokens, steps: 1, wallMs: Date.now() - started, gpuMs: gpuNs / 1e6, thinkingTokens });
        if (!pending.length) {
          // 1.6.0 (B-7601): DLP on the run's answer. A raised label is the run's; a hold ends the run with the reason
          // (a reviewer reads the step's detail); a redaction is the stored output.
          let output = content;
          const dlp = await this.dlp.inspect({ tenantId: run.tenant_id, text: content, scope: 'agent', label: run.label });
          if (dlp.rules.length) {
            const names = dlp.rules.map((x) => x.name).join(', ');
            if (dlp.raised) {
              run.label = dlp.label;
              await this.db('agent_runs').where({ id: run.id }).update({ label: dlp.label, updated_at: Date.now() });
            }
            await this.audit.append({ tenantId: run.tenant_id, action: 'agent.run.dlp', kind: 'system', actor: { service: 'agents', user: run.user_id }, target: { run: run.id, agent: run.agent_name }, label: run.label, detail: { rules: dlp.rules.map((x) => x.name), action: dlp.action, label: dlp.label } });
            if (dlp.action === 'hold') {
              await this.finish(run, 'failed', { error: `Held by the DLP rule ${names}: the answer is kept for review.`, usage });
              return { state: 'failed', steps: usage.steps };
            }
            if (dlp.action === 'redact') output = dlp.text;
          }
          await this.finish(run, 'succeeded', { output, usage, error: null });
          if (policy && this.memoryExtract) this.memoryExtract({ tenantId: run.tenant_id, workspaceId: run.workspace_id, userId: run.user_id, runId: run.id, agent: run.agent_name, label: run.label, types: policy.types, remaining: policy.maxPerRun - proposals });
          return { state: 'succeeded', steps: usage.steps };
        }
      }
    } catch (err) {
      tick();
      if (err instanceof Pause) {
        await this.finish(run, err.state, { error: err.message, usage });
        if (err.awaiting) {
          // The awaited run may have finished while this one was pausing: then continue at once.
          if (await this.awaitedDone(err.awaiting)) await this.resumeAwaiting(run.tenant_id, run.id);
          return { state: err.state, awaiting: err.awaiting };
        }
        if (err.state === 'waiting') {
          this.bus.emitLocal(TOPICS.integrationEvent, { tenantId: run.tenant_id, type: 'approval.requested', label: run.label, id: `agent-approval:${run.id}:${usage.steps}`, data: { kind: 'agent', run: run.id, agent: run.agent_name } });
          const approvers = await this.notifications.usersWithRoles(run.tenant_id, ['tool-admin']);
          await this.notifications.notify({ tenantId: run.tenant_id, userIds: [run.user_id, ...approvers], kind: 'agent', title: `Run ${run.id.slice(-4).toLowerCase()} of ${run.agent_name} is waiting on approval`, body: err.message, route: 'runs', label: run.label }).catch(() => undefined);
        }
        return { state: err.state };
      }
      if (signal.aborted) {
        const cur = (await this.db('agent_runs').where({ id: run.id }).first('state')) as { state: RunState } | undefined;
        if (cur?.state === 'cancelled') {
          await this.db('agent_runs').where({ id: run.id }).update({ usage: JSON.stringify(usage) });
          throw err;
        }
        // Shutdown: the job goes back to the queue; the run continues from its checkpoint on the next attempt.
        await this.db('agent_runs').where({ id: run.id }).update({ state: 'queued', usage: JSON.stringify(usage), updated_at: Date.now() });
        throw err;
      }
      const e = err as Error;
      const detail = err instanceof HttpProblem ? (err.detail ?? err.title) : e.message;
      this.log.warn({ run: run.id, err: detail }, 'agent run failed');
      await this.finish(run, 'failed', { error: detail, usage });
      return { state: 'failed', error: detail };
    }
  }

  /** 1.6.0 (B-7001): what a red-team run judges a child run by: its state, answer and the arguments of its tool calls. */
  async redTeamEvidence(tenantId: string, runId: string): Promise<{ state: RunState; output: string | null; error: string | null; toolCalls: string[] } | null> {
    const r = (await this.db('agent_runs').where({ tenant_id: tenantId, id: runId }).first()) as RunRow | undefined;
    if (!r) return null;
    const steps = (await this.db('agent_steps').where({ run_id: r.id, lane: 'do' }).orderBy('n')) as StepRow[];
    const toolCalls: string[] = [];
    for (const st of steps) {
      const d = await this.open<Record<string, unknown>>(r.tenant_id, `agent-step:${st.id}`, st.detail, {});
      toolCalls.push(`${st.title} ${JSON.stringify(d.arguments ?? {})}`);
    }
    // What the model planned but never ran (a call left pending at a budget stop or an approval) is evidence too.
    const thinks = (await this.db('agent_steps').where({ run_id: r.id, lane: 'think' }).orderBy('n')) as StepRow[];
    for (const st of thinks) {
      const d = await this.open<{ toolCalls?: { name: string; arguments: unknown }[] }>(r.tenant_id, `agent-step:${st.id}`, st.detail, {});
      for (const c of d.toolCalls ?? []) toolCalls.push(`${c.name} ${JSON.stringify(c.arguments ?? {})}`);
    }
    return { state: r.state, output: r.state === 'succeeded' ? await this.open<string | null>(r.tenant_id, `agent-run-output:${r.id}`, r.output, null) : null, error: r.error, toolCalls };
  }

  private toolMeta(tool: ResolvedTool, o: ToolOutcome, extra: Record<string, unknown> = {}) {
    return { tool: tool.entry.name, version: tool.entry.version, impl: tool.entry.impl, sideEffect: tool.sideEffect, ceiling: tool.entry.label, durationMs: o.durationMs, decision: o.decision, valid: o.valid ?? null, warning: tool.warning, ...extra };
  }
}
