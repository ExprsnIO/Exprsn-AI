import { z } from 'zod';
import type { Issue, PortSchema, WfEdge, WfGraph, WfNode } from './graph.js';

/*
 * Sprint 32b (B-3906): failure handling.
 *
 * - A per-step retry policy (`retry: {max, delayMs, backoff}`): a step that fails is tried again up to `max` more
 *   times. Between attempts the step waits durably like a wait step (the run is `waiting` with the step's
 *   `resume_at`, no worker held), so a retry survives a restart. Label-ceiling blocks, guardrail blocks and rejections
 *   are never retried: trying again cannot change them.
 * - An on-failure edge (`branch: 'failure'`): when a step fails for good, the steps on its failure edges run with
 *   `{error, step}` as their input instead of the run failing; its other edges are skipped. A failure that a failure
 *   edge handles does not fail the run.
 * - Runs that fail for good are dead letters (`dead-letters.ts`), redriven from the failed step.
 */

/** Kinds a retry makes no sense for: they pause or decide rather than fail. */
const NO_RETRY = new Set(['trigger', 'approval', 'wait', 'branch']);

export const retryPolicySchema = z
  .object({
    /** Further attempts after the first. */
    max: z.number().int().min(1).max(5),
    /** The wait before the first retry. */
    delayMs: z.number().int().min(1000).max(3_600_000).default(5000),
    /** `exponential` doubles the wait each attempt; `fixed` keeps it. */
    backoff: z.enum(['fixed', 'exponential']).default('exponential')
  })
  .strict();
export type RetryPolicy = z.infer<typeof retryPolicySchema>;

/** What a step on a failure edge receives from the step that failed. */
export const FAILURE_PORT: PortSchema = { type: 'object', properties: { error: { type: 'string' }, step: { type: 'string' } }, required: ['error', 'step'] };

export const isFailureEdge = (e: Pick<WfEdge, 'branch'>): boolean => e.branch === 'failure';

/** True when a failure of this step goes down a failure edge instead of failing the run. */
export const handlesFailure = (g: Pick<WfGraph, 'edges'>, id: string): boolean => g.edges.some((e) => e.from === id && isFailureEdge(e));

/** Errors a retry cannot change: label ceilings, guardrail blocks, rejections, a missing tool. */
export function retryable(message: string): boolean {
  return !/^Blocked by (label|guardrails)|Rejected by |is not published|not available on this server/i.test(message);
}

/**
 * When the step that just failed on attempt `attempts` (1 for the first) runs again, or null when its policy is
 * spent (or it has none).
 */
export function nextRetryAt(n: Pick<WfNode, 'retry'>, attempts: number, now = Date.now()): number | null {
  const p = n.retry;
  if (!p || attempts > p.max) return null;
  const wait = p.backoff === 'exponential' ? p.delayMs * 2 ** (attempts - 1) : p.delayMs;
  return now + Math.min(wait, 3_600_000);
}

/** Publish checks for retry policies and failure edges. */
export function failureIssues(g: WfGraph): { errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  for (const n of g.nodes) {
    if (!n.retry) continue;
    if (NO_RETRY.has(n.kind)) errors.push({ code: 'config', nodeId: n.id, message: `${n.title}: a ${n.kind} step cannot have a retry policy.` });
    else if ((n.kind === 'http' && String(n.config.method ?? 'GET') !== 'GET') || n.kind === 'record') warnings.push({ code: 'config', nodeId: n.id, message: `${n.title} writes to another system; a retry may send it again.` });
  }
  for (const e of g.edges) {
    if (!isFailureEdge(e)) continue;
    const from = byId.get(e.from);
    if (from?.kind === 'trigger') errors.push({ code: 'structure', nodeId: e.from, edge: e, message: 'The trigger has no failure edge: it cannot fail.' });
  }
  return { errors, warnings };
}
