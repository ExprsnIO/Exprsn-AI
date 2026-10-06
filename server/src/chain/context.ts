import { AsyncLocalStorage } from 'node:async_hooks';
import { monotonicFactory } from 'ulid';

/** Node ids rise within a millisecond too, so the chain view lists siblings in the order they began. */
const ulid = monotonicFactory();
import { highest, LABELS, labelRank, type Label } from '../authz/labels.js';
import { isUniqueViolation, type AuditInput } from '../audit/chain.js';
import type { Db } from '../db/knex.js';

/*
 * The chain context (B-4101). Every invocation is a node of one chain: a chat turn, an agent run, a workflow run, a
 * tool call, a skill load, a plugin action or an app trigger. The first invocation is the root; what it causes (an
 * agent's tool call, the workflow behind that tool, the agent a workflow step runs, that agent's tool calls…) are
 * its descendants. The rules, the same on every instance because they read only the database:
 *
 * - the principal never changes: a child acts as the person or service the root acts as;
 * - the label only rises: a child's label is at least the chain's high-water mark, and raising a node raises the mark;
 * - depth: one `CHAIN_MAX_DEPTH` across kinds (the root is depth 0), with per-kind caps (`WORKFLOW_MAX_DEPTH` nested
 *   workflow runs, `AGENT_MAX_DEPTH` nested agent runs) counted from the kinds on the path from the root;
 * - budgets: tokens, steps, wall time and GPU time (the cost meter) of every node are charged to the root's budgets,
 *   with atomic increments; a node may not begin, and work in progress stops, once one is used up.
 *
 * A node is unique by `(kind, ref)` (the run id for runs), so a job retried on another instance resumes the node it
 * began instead of starting a second one, and its chain comes with the run's row. In process, the active node rides an
 * AsyncLocalStorage (`chainScope`) so work started inside it (a tool's workflow, a skill load) finds its parent.
 */

export const CHAIN_KINDS = ['chat-turn', 'agent-run', 'workflow-run', 'tool-call', 'skill-load', 'plugin-action', 'app-trigger'] as const;
export type ChainKind = (typeof CHAIN_KINDS)[number];

/** Where in a chain something runs: what a child names as its parent, carried in rows and job payloads. */
export interface ChainRef {
  chain: string;
  node: string;
}

export interface ChainBudgets {
  tokens: number;
  steps: number;
  wallMs: number;
  /** The cost meter: GPU milliseconds (priced statements stay with billing). */
  gpuMs: number;
}

export interface ChainUsage {
  tokens?: number;
  steps?: number;
  wallMs?: number;
  gpuMs?: number;
}

/** A node as its invocation sees it. */
export interface ChainCtx extends ChainRef {
  tenantId: string;
  root: string;
  parent: string | null;
  depth: number;
  kind: ChainKind;
  principal: string;
  /** The node's label: at least the chain's high-water mark when it began. */
  label: Label;
  /** True when `begin` found the node a previous attempt had begun. */
  resumed: boolean;
}

export interface ChainLimits {
  maxDepth: number;
  /** Per-kind caps on how many nodes of a kind a path may hold (the root included). */
  kindCaps: Partial<Record<ChainKind, number>>;
  defaults: ChainBudgets;
}

export type ChainRefusal = 'depth' | 'kind-depth' | 'budget' | 'principal' | 'stopped' | 'missing';

/**
 * B-4106: how a child ended when it did not succeed, as its caller receives it: an agent sees `<type>` in the tool
 * error (`child_budget: …`), a workflow step's failure edge reads `{error, step, type}`.
 */
export const CHAIN_ERROR_TYPES = ['failed', 'budget', 'cancelled', 'rejected', 'chain_limit', 'output', 'label', 'timeout'] as const;
export type ChainErrorType = (typeof CHAIN_ERROR_TYPES)[number];

/** Why an invocation may not begin or continue: `code` says which rule. */
export class ChainLimit extends Error {
  constructor(
    readonly code: ChainRefusal,
    message: string
  ) {
    super(message);
    this.name = 'ChainLimit';
  }
}

/** The node the current async work belongs to. */
export const chainScope = new AsyncLocalStorage<ChainRef>();

export interface BeginSpec {
  kind: ChainKind;
  /** The invocation's own id (a run id), unique per kind. Tool calls and skill loads get a fresh one when omitted. */
  ref?: string;
  /** What is invoked (a workflow id, an agent or tool name), for the per-kind caps and the chain view. */
  callee?: string | null;
  principal: string;
  label: Label;
  /** The parent node; null or omitted starts a new chain with this node as its root. */
  parent?: ChainRef | null;
  /** A root's own budgets (an agent run's, a workflow's limits); missing ones take the CHAIN_MAX_* defaults. */
  budgets?: Partial<ChainBudgets>;
}

interface ChainRow {
  id: string;
  tenant_id: string;
  root_node: string;
  principal_id: string;
  label: Label;
  state: string;
  stop_reason: string | null;
  budget_tokens: number;
  budget_steps: number;
  budget_wall_ms: number;
  budget_gpu_ms: number;
  tokens: number;
  steps: number;
  wall_ms: number;
  gpu_ms: number;
  created_at: number;
  updated_at: number;
}

interface NodeRow {
  id: string;
  tenant_id: string;
  chain_id: string;
  parent_id: string | null;
  depth: number;
  kind: ChainKind;
  ref: string;
  callee: string | null;
  path: string;
  principal_id: string;
  label: Label;
  state: string;
  error: string | null;
  /** Sprint 34 (036_chains): the tool-call checkpoint's action, and the typed error a caller received. */
  decision?: string | null;
  error_type?: string | null;
  tokens: number;
  steps: number;
  wall_ms: number;
  gpu_ms: number;
  created_at: number;
  finished_at: number | null;
}

const num = (v: unknown) => Number(v ?? 0);
const chainFrom = (r: Record<string, unknown>): ChainRow => ({ ...(r as unknown as ChainRow), budget_tokens: num(r.budget_tokens), budget_steps: num(r.budget_steps), budget_wall_ms: num(r.budget_wall_ms), budget_gpu_ms: num(r.budget_gpu_ms), tokens: num(r.tokens), steps: num(r.steps), wall_ms: num(r.wall_ms), gpu_ms: num(r.gpu_ms), created_at: num(r.created_at), updated_at: num(r.updated_at) });
const nodeFrom = (r: Record<string, unknown>): NodeRow => ({ ...(r as unknown as NodeRow), depth: num(r.depth), tokens: num(r.tokens), steps: num(r.steps), wall_ms: num(r.wall_ms), gpu_ms: num(r.gpu_ms), created_at: num(r.created_at), finished_at: r.finished_at == null ? null : num(r.finished_at) });

const KIND_NAMES: Record<ChainKind, string> = { 'chat-turn': 'chat turns', 'agent-run': 'agent runs', 'workflow-run': 'workflow runs', 'tool-call': 'tool calls', 'skill-load': 'skill loads', 'plugin-action': 'plugin actions', 'app-trigger': 'app triggers' };
const CAP_NAMES: Partial<Record<ChainKind, string>> = { 'workflow-run': 'WORKFLOW_MAX_DEPTH', 'agent-run': 'AGENT_MAX_DEPTH' };

/** The first budget a chain has used up, in words, or null. */
export function exhausted(c: Pick<ChainRow, 'tokens' | 'steps' | 'wall_ms' | 'gpu_ms' | 'budget_tokens' | 'budget_steps' | 'budget_wall_ms' | 'budget_gpu_ms'>): string | null {
  if (c.tokens >= c.budget_tokens) return `the chain used ${c.tokens.toLocaleString('en-US')} of its root's ${c.budget_tokens.toLocaleString('en-US')} tokens`;
  if (c.steps >= c.budget_steps) return `the chain took ${c.steps} of its root's ${c.budget_steps} steps`;
  if (c.wall_ms >= c.budget_wall_ms) return `the chain ran ${Math.round(c.wall_ms / 1000)} s of its root's ${Math.round(c.budget_wall_ms / 1000)} s`;
  if (c.gpu_ms >= c.budget_gpu_ms) return `the chain used ${Math.round(c.gpu_ms / 1000)} of its root's ${Math.round(c.budget_gpu_ms / 1000)} GPU-seconds`;
  return null;
}

export class ChainService {
  constructor(
    private readonly db: Db,
    readonly limits: ChainLimits,
    /** Refusals (`chain.refused`) and budget stops (`chain.stopped`) are audited when given. */
    private readonly audit?: { append(e: AuditInput): Promise<unknown> }
  ) {}

  private async refuse(tenantId: string, chainId: string | null, spec: BeginSpec, err: ChainLimit): Promise<never> {
    await this.audit?.append({ tenantId, action: 'chain.refused', kind: 'system', actor: { service: 'chains', user: spec.principal }, target: { chain: chainId, parent: spec.parent?.node ?? null, kind: spec.kind, callee: spec.callee ?? null }, label: spec.label, detail: { rule: err.code, reason: err.message } }).catch(() => undefined);
    throw err;
  }

  private async chainRow(id: string): Promise<ChainRow | undefined> {
    const r = await this.db('chains').where({ id }).first();
    return r ? chainFrom(r) : undefined;
  }

  private async nodeRow(id: string): Promise<NodeRow | undefined> {
    const r = await this.db('chain_nodes').where({ id }).first();
    return r ? nodeFrom(r) : undefined;
  }

  private ctxOf(n: NodeRow, c: Pick<ChainRow, 'root_node'>, resumed: boolean): ChainCtx {
    return { chain: n.chain_id, node: n.id, tenantId: n.tenant_id, root: c.root_node, parent: n.parent_id, depth: n.depth, kind: n.kind, principal: n.principal_id, label: n.label, resumed };
  }

  /** The node for an invocation already begun (a run's), or undefined. */
  async find(kind: ChainKind, ref: string): Promise<ChainCtx | undefined> {
    const r = await this.db('chain_nodes').where({ kind, ref }).first();
    if (!r) return undefined;
    const n = nodeFrom(r);
    const c = (await this.chainRow(n.chain_id))!;
    return this.ctxOf(n, c, true);
  }

  /**
   * Begins an invocation: a new chain when it has no parent, otherwise a child node, after the rules: same principal,
   * within `CHAIN_MAX_DEPTH` and the per-kind caps, the root's budgets not used up. The node's label is the higher of
   * the one asked for and the chain's high-water mark, and the mark rises to it. Begun again with the same
   * `(kind, ref)` (a retried job), it returns the node already there.
   */
  async begin(tenantId: string, spec: BeginSpec): Promise<ChainCtx> {
    const ref = spec.ref ?? ulid();
    if (spec.ref) {
      const found = await this.find(spec.kind, spec.ref);
      if (found) return found;
    }
    const t = Date.now();
    if (!spec.parent) {
      const d = this.limits.defaults;
      const b = spec.budgets ?? {};
      const chainId = ulid();
      const nodeId = ulid();
      const path = JSON.stringify([[spec.kind, spec.callee ?? null]]);
      try {
        await this.db.transaction(async (trx) => {
          await trx('chains').insert({ id: chainId, tenant_id: tenantId, root_node: nodeId, root_kind: spec.kind, principal_id: spec.principal, label: spec.label, state: 'running', stop_reason: null, budget_tokens: Math.round(b.tokens ?? d.tokens), budget_steps: Math.round(b.steps ?? d.steps), budget_wall_ms: Math.round(b.wallMs ?? d.wallMs), budget_gpu_ms: Math.round(b.gpuMs ?? d.gpuMs), tokens: 0, steps: 0, wall_ms: 0, gpu_ms: 0, nodes: 1, max_depth: 0, created_at: t, updated_at: t });
          await trx('chain_nodes').insert({ id: nodeId, tenant_id: tenantId, chain_id: chainId, parent_id: null, depth: 0, kind: spec.kind, ref, callee: spec.callee?.slice(0, 200) ?? null, path, principal_id: spec.principal, label: spec.label, state: 'running', error: null, tokens: 0, steps: 0, wall_ms: 0, gpu_ms: 0, created_at: t, finished_at: null });
        });
      } catch (err) {
        // Another instance began the same invocation a moment ago: use its node.
        if (isUniqueViolation(err) && spec.ref) return (await this.find(spec.kind, spec.ref))!;
        throw err;
      }
      return { chain: chainId, node: nodeId, tenantId, root: nodeId, parent: null, depth: 0, kind: spec.kind, principal: spec.principal, label: spec.label, resumed: false };
    }

    const parent = await this.nodeRow(spec.parent.node);
    const chain = parent ? await this.chainRow(parent.chain_id) : undefined;
    if (!parent || !chain || chain.tenant_id !== tenantId || parent.chain_id !== spec.parent.chain) return this.refuse(tenantId, null, spec, new ChainLimit('missing', 'The chain this call belongs to no longer exists.'));
    if (chain.principal_id !== spec.principal) return this.refuse(tenantId, chain.id, spec, new ChainLimit('principal', 'A chain acts as the principal that started it; this call would act as someone else.'));
    if (chain.state === 'stopped') return this.refuse(tenantId, chain.id, spec, new ChainLimit('stopped', `The chain was stopped${chain.stop_reason ? `: ${chain.stop_reason}` : '.'}`));
    const depth = parent.depth + 1;
    if (depth > this.limits.maxDepth) return this.refuse(tenantId, chain.id, spec, new ChainLimit('depth', `The chain is ${parent.depth} calls deep; CHAIN_MAX_DEPTH is ${this.limits.maxDepth}, so ${spec.callee ?? KIND_NAMES[spec.kind]} cannot be called from here.`));
    const path = [...(JSON.parse(parent.path) as [ChainKind, string | null][]), [spec.kind, spec.callee ?? null] as [ChainKind, string | null]];
    const cap = this.limits.kindCaps[spec.kind];
    const same = path.filter(([k]) => k === spec.kind).length;
    if (cap != null && same > cap) return this.refuse(tenantId, chain.id, spec, new ChainLimit('kind-depth', `The chain already holds ${same - 1} nested ${KIND_NAMES[spec.kind]}; ${CAP_NAMES[spec.kind] ?? 'the limit'} is ${cap}.`));
    const over = exhausted(chain);
    if (over) return this.refuse(tenantId, chain.id, spec, new ChainLimit('budget', `Stopped at the root's budget: ${over}.`));
    const label = highest(spec.label, chain.label);
    const nodeId = ulid();
    try {
      await this.db('chain_nodes').insert({ id: nodeId, tenant_id: tenantId, chain_id: chain.id, parent_id: parent.id, depth, kind: spec.kind, ref, callee: spec.callee?.slice(0, 200) ?? null, path: JSON.stringify(path), principal_id: spec.principal, label, state: 'running', error: null, tokens: 0, steps: 0, wall_ms: 0, gpu_ms: 0, created_at: t, finished_at: null });
    } catch (err) {
      if (isUniqueViolation(err) && spec.ref) return (await this.find(spec.kind, spec.ref))!;
      throw err;
    }
    await this.db('chains').where({ id: chain.id }).update({ nodes: this.db.raw('nodes + 1'), updated_at: t });
    await this.db('chains').where({ id: chain.id }).andWhere('max_depth', '<', depth).update({ max_depth: depth });
    await this.raise({ chain: chain.id, node: nodeId }, label);
    return { chain: chain.id, node: nodeId, tenantId, root: chain.root_node, parent: parent.id, depth, kind: spec.kind, principal: spec.principal, label, resumed: false };
  }

  /** Raises the chain's high-water mark (and the node's label) to `label`; it never goes down. */
  async raise(ref: ChainRef, label: Label): Promise<Label> {
    const lower = LABELS.filter((l) => labelRank(l) < labelRank(label));
    if (lower.length) {
      await this.db('chains').where({ id: ref.chain }).whereIn('label', lower).update({ label });
      await this.db('chain_nodes').where({ id: ref.node }).whereIn('label', lower).update({ label });
    }
    const c = await this.chainRow(ref.chain);
    return c?.label ?? label;
  }

  /** The chain's high-water mark. */
  async label(ref: ChainRef): Promise<Label | null> {
    return (await this.chainRow(ref.chain))?.label ?? null;
  }

  /**
   * Charges usage to the node and to the root's budgets (atomic increments, so instances charging at once all count),
   * and returns what is used up, if anything. A chain over a budget is marked stopped: nothing new begins in it.
   */
  async charge(ref: ChainRef, u: ChainUsage): Promise<{ exceeded: string | null }> {
    const inc = { tokens: Math.max(0, Math.round(u.tokens ?? 0)), steps: Math.max(0, Math.round(u.steps ?? 0)), wall_ms: Math.max(0, Math.round(u.wallMs ?? 0)), gpu_ms: Math.max(0, Math.round(u.gpuMs ?? 0)) };
    const set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(inc)) if (v) set[k] = this.db.raw('?? + ?', [k, v]);
    if (Object.keys(set).length) {
      await this.db('chain_nodes').where({ id: ref.node }).update(set);
      await this.db('chains').where({ id: ref.chain }).update({ ...set, updated_at: Date.now() });
    }
    return { exceeded: await this.check(ref) };
  }

  /** What stops the chain now (a used-up budget, or a stop), or null. */
  async check(ref: ChainRef): Promise<string | null> {
    const c = await this.chainRow(ref.chain);
    if (!c) return 'the chain no longer exists';
    if (c.state === 'stopped') return c.stop_reason ?? 'the chain was stopped';
    const over = exhausted(c);
    if (over) {
      const n = await this.db('chains').where({ id: c.id }).whereIn('state', ['running', 'done']).update({ state: 'stopped', stop_reason: `Stopped at the root's budget: ${over}.`.slice(0, 500), updated_at: Date.now() });
      // Audited once, by whichever instance stopped it.
      if (n === 1) await this.audit?.append({ tenantId: c.tenant_id, action: 'chain.stopped', kind: 'system', actor: { service: 'chains', user: c.principal_id }, target: { chain: c.id, root: c.root_node }, label: c.label, detail: { reason: over, used: { tokens: c.tokens, steps: c.steps, wallMs: c.wall_ms, gpuMs: c.gpu_ms }, budgets: { tokens: c.budget_tokens, steps: c.budget_steps, wallMs: c.budget_wall_ms, gpuMs: c.budget_gpu_ms } } }).catch(() => undefined);
      return `Stopped at the root's budget: ${over}.`;
    }
    return null;
  }

  /**
   * Records how the invocation ended (with the typed error its caller received, B-4106). The chain is done when its
   * root ends (unless a budget stopped it).
   */
  async finish(ref: ChainRef, state: 'succeeded' | 'failed' | 'refused' | 'waiting' | 'cancelled' | 'running', error: string | null = null, errorType: ChainErrorType | null = null): Promise<void> {
    const t = Date.now();
    const type = errorType ?? (state === 'failed' ? 'failed' : state === 'cancelled' ? 'cancelled' : state === 'refused' ? 'chain_limit' : null);
    await this.db('chain_nodes').where({ id: ref.node }).update({ state, error: error?.slice(0, 500) ?? null, error_type: type, finished_at: state === 'waiting' || state === 'running' ? null : t });
    const c = await this.chainRow(ref.chain);
    if (c && c.root_node === ref.node && c.state === 'running' && state !== 'waiting' && state !== 'running') await this.db('chains').where({ id: c.id, state: 'running' }).update({ state: 'done', updated_at: t });
    if (c && c.root_node === ref.node && (state === 'running' || state === 'waiting') && c.state === 'done') await this.db('chains').where({ id: c.id }).update({ state: 'running', updated_at: t });
  }

  /**
   * A root's budgets raised (an agent run resumed after its budget stop): only the root's own node may do this, and a
   * chain a budget stopped runs again if the new budgets cover what it used.
   */
  async rebudget(ref: ChainRef, b: Partial<ChainBudgets>): Promise<boolean> {
    const c = await this.chainRow(ref.chain);
    if (!c || c.root_node !== ref.node) return false;
    const upd: Record<string, unknown> = { updated_at: Date.now() };
    if (b.tokens != null) upd.budget_tokens = Math.round(b.tokens);
    if (b.steps != null) upd.budget_steps = Math.round(b.steps);
    if (b.wallMs != null) upd.budget_wall_ms = Math.round(b.wallMs);
    if (b.gpuMs != null) upd.budget_gpu_ms = Math.round(b.gpuMs);
    await this.db('chains').where({ id: c.id }).update(upd);
    const after = (await this.chainRow(c.id))!;
    if (after.state === 'stopped' && !exhausted(after)) await this.db('chains').where({ id: c.id }).update({ state: 'running', stop_reason: null });
    return true;
  }

  /** Notes the `tool-call` guardrail checkpoint's action on a node (the chain view shows it, B-4107). */
  async note(ref: ChainRef, n: { decision?: string | null }): Promise<void> {
    if (n.decision !== undefined) await this.db('chain_nodes').where({ id: ref.node }).update({ decision: n.decision?.slice(0, 20) ?? null });
  }

  /** The nodes from the root down to `node` (the path a held call is shown with, B-4106). */
  async pathTo(chainId: string, node: string): Promise<{ id: string; kind: ChainKind; ref: string; callee: string | null; depth: number }[]> {
    const rows = ((await this.db('chain_nodes').where({ chain_id: chainId }).select('id', 'parent_id', 'kind', 'ref', 'callee', 'depth')) as { id: string; parent_id: string | null; kind: ChainKind; ref: string; callee: string | null; depth: number }[]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out: { id: string; kind: ChainKind; ref: string; callee: string | null; depth: number }[] = [];
    for (let cur = byId.get(node); cur && out.length <= this.limits.maxDepth + 1; cur = cur.parent_id ? byId.get(cur.parent_id) : undefined) out.unshift({ id: cur.id, kind: cur.kind, ref: cur.ref, callee: cur.callee, depth: num(cur.depth) });
    return out;
  }

  /** Records a refused invocation as a node (so the chain shows where it stopped), without a budget check. */
  async refused(tenantId: string, spec: BeginSpec, reason: string): Promise<void> {
    if (!spec.parent) return;
    const parent = await this.nodeRow(spec.parent.node);
    if (!parent) return;
    const path = [...(JSON.parse(parent.path) as unknown[]), [spec.kind, spec.callee ?? null]];
    await this.db('chain_nodes').insert({ id: ulid(), tenant_id: tenantId, chain_id: parent.chain_id, parent_id: parent.id, depth: parent.depth + 1, kind: spec.kind, ref: ulid(), callee: spec.callee?.slice(0, 200) ?? null, path: JSON.stringify(path), principal_id: spec.principal, label: spec.label, state: 'refused', error: reason.slice(0, 500), error_type: 'chain_limit', tokens: 0, steps: 0, wall_ms: 0, gpu_ms: 0, created_at: Date.now(), finished_at: Date.now() });
  }

  /** A chain with its nodes, oldest first (the chain view, B-4107, builds its tree from this). */
  async view(tenantId: string, chainId: string) {
    const c = await this.chainRow(chainId);
    if (!c || c.tenant_id !== tenantId) return null;
    const nodes = ((await this.db('chain_nodes').where({ chain_id: c.id }).orderBy('created_at').orderBy('depth').orderBy('id')) as Record<string, unknown>[]).map(nodeFrom);
    return {
      id: c.id,
      rootNode: c.root_node,
      principal: c.principal_id,
      label: c.label,
      state: c.state,
      stopReason: c.stop_reason,
      budgets: { tokens: c.budget_tokens, steps: c.budget_steps, wallMs: c.budget_wall_ms, gpuMs: c.budget_gpu_ms },
      used: { tokens: c.tokens, steps: c.steps, wallMs: c.wall_ms, gpuMs: c.gpu_ms },
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      nodes: nodes.map((n) => ({ id: n.id, parent: n.parent_id, depth: n.depth, kind: n.kind, ref: n.ref, callee: n.callee, label: n.label, state: n.state, error: n.error, errorType: n.error_type ?? null, decision: n.decision ?? null, tokens: n.tokens, steps: n.steps, wallMs: n.wall_ms, gpuMs: n.gpu_ms, createdAt: n.created_at, finishedAt: n.finished_at }))
    };
  }
}

/** A chain reference from an untrusted shape (a job payload), or null. */
export function chainRefOf(v: unknown): ChainRef | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return typeof o.chain === 'string' && typeof o.node === 'string' && /^[0-9A-Z]{26}$/.test(o.chain) && /^[0-9A-Z]{26}$/.test(o.node) ? { chain: o.chain, node: o.node } : null;
}
