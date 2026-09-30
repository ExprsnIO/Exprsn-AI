import type { Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';

/**
 * The seam every feature calls at its guardrail checkpoint. Sprint 5 provides the rule-set engine behind it; until a
 * tenant has rules, `check` allows everything and returns the text unchanged.
 */
export const CHECKPOINTS = ['user-input', 'context', 'tool-call', 'model-output', 'image', 'context-transfer', 'memory', 'script', 'db-query', 'media', 'export'] as const;
export type Checkpoint = (typeof CHECKPOINTS)[number];

/** Ordered from least to most severe; the effective action of a check is the most severe enforced finding. */
export const GUARD_ACTIONS = ['allow', 'log', 'warn', 'flag', 'redact', 'require-approval', 'block'] as const;
export type GuardAction = (typeof GUARD_ACTIONS)[number];

export interface GuardInput {
  tenantId: string;
  workspaceId: string | null;
  checkpoint: Checkpoint;
  /** The text under inspection (prompt, answer, chunk, tool arguments as JSON, SQL, script source…). */
  text: string;
  label: Label;
  principal?: Principal;
  /** What the text belongs to, for flags and audit (e.g. `{ kind: 'message', id }`). */
  source?: { kind: string; id: string };
  /** Checkpoint-specific facts rules may test (tool side-effect class, target label, token count…). */
  meta?: Record<string, unknown>;
}

export interface GuardFinding {
  ruleId: string;
  ruleName: string;
  action: GuardAction;
  stage: 'shadow' | 'enforce';
  /** Character offsets in the inspected text, when the rule matched a span. */
  span?: [number, number];
  score?: number;
  /** The rule set the rule belongs to. */
  setId?: string;
  /** What matched or failed, safe to show a reviewer (a detector kind, hazard categories, "guard model unavailable"). */
  detail?: string;
}

export interface GuardDecision {
  /** The effective action: the most severe finding in `enforce`; shadow findings never change it. */
  action: GuardAction;
  /** The text to carry on with (redacted when the action is `redact`). */
  text: string;
  findings: GuardFinding[];
  /** Plain-language reason for a block or hold, safe to show the user. */
  reason?: string;
}

export interface Guardrails {
  check(input: GuardInput): Promise<GuardDecision>;
  /**
   * Fast screening for streamed output (Sprint 12): the enforced deterministic rules (patterns, detectors, lists,
   * labels, budgets, meta) at a checkpoint, loaded once, as a function over the text so far. Nothing is recorded and
   * no model or classifier is called; `check` still runs on the finished text. Null when no such rule applies.
   */
  streamScreen?(input: Omit<GuardInput, 'text'>): Promise<((text: string) => Promise<GuardDecision>) | null>;
}

export const allowAll: Guardrails = {
  check: async (input) => ({ action: 'allow', text: input.text, findings: [] })
};
