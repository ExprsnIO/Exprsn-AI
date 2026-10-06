import type { Label } from '../../authz/labels.js';
import type { Principal } from '../../authz/policy.js';
import type { ChainErrorType, ChainRef, ChainService } from '../../chain/context.js';
import type { ToolDispatcher } from '../../registry/dispatch.js';
import type { AgentBudgets, RegistryService } from '../../registry/service.js';
import type { TemplateScope, WfNode } from '../graph.js';

/*
 * What a Workflows 2 step runner gets from the workflow service (Sprint 32). Runners live in `steps/` so the service
 * keeps only the dispatch: `runNode` hands every kind it does not handle itself to `STEP_RUNNERS[kind]` with a
 * `StepCall` (the run, its principal, the step and the data arriving) and the service's `StepHost`.
 */

/** A step that cannot run with the data it would receive (label ceiling, unavailable kind): it is blocked, the run goes on. */
export class StepBlocked extends Error {}
/**
 * A step that failed; the run stops unless a failure edge takes it. B-4106: `type` is the typed error a failure edge
 * reads (`{error, step, type}`): a child agent stopped at its budget is `budget`, a refused call `chain_limit`, and so on.
 */
export class StepFailed extends Error {
  constructor(
    message: string,
    readonly type: ChainErrorType = 'failed'
  ) {
    super(message);
  }
}
/** A step paused (approval, wait, a child run); the run resumes when it is decided, due or done. */
export const WAIT = Symbol('wait');

/** The run row fields a runner reads. */
export interface StepRun {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  workflow_id: string;
  mode: 'run' | 'dry';
  label: Label;
  created_by: string;
  graph: string;
  chain_id?: string | null;
  chain_node?: string | null;
}

export interface StepRowRef {
  id: string;
  tenant_id: string;
  node_id: string;
  detail: string | null;
}

export interface StepCall {
  run: StepRun;
  p: Principal;
  n: WfNode;
  step: StepRowRef;
  scope: TemplateScope;
  merged: Record<string, unknown>;
  input: unknown;
  label: Label;
  signal: AbortSignal;
}

export interface StepResult {
  output: unknown;
  detail?: Record<string, unknown>;
  /** Tokens this run's own work used (added to the run's token budget). */
  tokens?: number;
  /** The label of the output, when the step brings in data above what arrived (a child run's result). */
  label?: Label;
  /** Steps and tokens the runner already charged to the chain itself (map items, loop iterations). */
  charged?: { steps: number; tokens: number };
}

/** A child workflow run for a step or one item of it. */
export interface ChildSpec {
  workflow: string;
  version?: number;
  input: unknown;
  label: Label;
  /** Which part of the step the child belongs to: the step id, or `<step>#<item>`. */
  key: string;
  timeoutMs: number;
}

export type ChildResult =
  | { state: 'succeeded'; run: string; output: unknown; label: Label; version: number }
  | { state: 'waiting'; run: string; version: number }
  | { state: 'failed'; run: string | null; error: string; blocked?: boolean };

/** One model prompt through a profile (map and loop items). */
export interface PromptSpec {
  profile: string;
  /** The prompt template, rendered against `scope` (never rendered twice, so item data cannot add placeholders). */
  prompt: string;
  format: 'text' | 'json';
  scope: TemplateScope;
}

/** Agent runs a workflow step starts and awaits (B-3902), implemented by the agent service. */
export interface AgentStepRunner {
  startForStep(p: Principal, input: { agent: string; input: string; label: Label; budgets?: Partial<AgentBudgets> }, caller: { runId: string; node: string; chain: ChainRef | null }): Promise<{ id: string; label: Label }>;
  stateForStep(tenantId: string, runId: string): Promise<{ state: string; output: string | null; error: string | null; label: Label; tokens: number } | null>;
  cancelForStep(tenantId: string, runId: string, reason: string): Promise<void>;
}

export interface StepHost {
  registry: RegistryService;
  tools: ToolDispatcher;
  chains: ChainService | null;
  agents: AgentStepRunner | null;
  seal(tenantId: string, aad: string, value: unknown): Promise<string>;
  open<T>(tenantId: string, aad: string, sealed: string | null, fallback: T): Promise<T>;
  /** The run's own chain node, if it has one. */
  chainOf(run: StepRun): ChainRef | null;
  /** Runs (or picks up) a child run of a published workflow, executed in this call while it can go on. */
  child(c: StepCall, spec: ChildSpec): Promise<ChildResult>;
  /** One model call through a published profile, metered as the run's. */
  prompt(c: StepCall, spec: PromptSpec): Promise<{ output: unknown; tokens: number; gpuMs: number }>;
  /** Pauses the step (waiting) with a detail patch; the run resumes when the service is told the child is done. */
  wait(c: StepCall, detail: Record<string, unknown>): Promise<typeof WAIT>;
  /** Merges into the step's detail (a checkpoint of what the step started). */
  note(c: StepCall, detail: Record<string, unknown>): Promise<void>;
  /**
   * B-4106: pauses the step on an approval for a call it holds (a write tool a skill offered): `state` (sealed) is what
   * the step needs to continue, `shown` what the approver sees. The step runs again once someone decides.
   */
  hold(c: StepCall, state: unknown, shown: Record<string, unknown>, o: { role: string; timeoutMs: number }): Promise<typeof WAIT>;
  /** The decided hold the step resumes from (once: it is cleared), or null. */
  takeHold<T>(c: StepCall): Promise<{ state: T; decision: 'approved' | 'rejected'; by: string | null; note: string | null } | null>;
  /** Per-item checkpoints of a map or loop. */
  items: {
    list(c: StepCall): Promise<{ idx: number; state: string; output: unknown; error: string | null; childRun: string | null }[]>;
    save(c: StepCall, idx: number, row: { state: 'passed' | 'failed' | 'waiting'; output?: unknown; error?: string | null; childRun?: string | null; tokens?: number }): Promise<void>;
    /** Items the run's other maps fanned out over (toward LIMITS.maxItems). */
    countOthers(c: StepCall): Promise<number>;
  };
}

export type StepRunner = (c: StepCall, host: StepHost) => Promise<StepResult | typeof WAIT>;

/** The step's detail, parsed. */
export function detailOf(c: Pick<StepCall, 'step'>): Record<string, unknown> {
  try {
    return c.step.detail ? (JSON.parse(c.step.detail) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The comparison a branch step makes (shared with loop conditions). */
export function compare(op: string, left: unknown, right: unknown): boolean {
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

/** Runs `fn` over `items` with at most `limit` in flight; returns the highest number that were. */
export async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>, stop?: () => boolean): Promise<number> {
  let next = 0;
  let inFlight = 0;
  let peak = 0;
  const worker = async () => {
    for (;;) {
      if (stop?.()) return;
      const i = next++;
      if (i >= items.length) return;
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        await fn(items[i]!);
      } finally {
        inFlight--;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return peak;
}
