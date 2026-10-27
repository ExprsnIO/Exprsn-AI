import { LIMITS, render, sampleOf, type TemplateScope } from '../graph.js';
import type { WAIT } from './host.js';
import { StepBlocked, StepFailed, type StepCall, type StepHost, type StepResult } from './host.js';
import { STEP_KINDS, type SubConfig } from './kinds.js';

/*
 * The sub-workflow step (B-3901). A published version of another workflow in the same workspace runs as a child: as
 * the parent's principal, under the parent's label (or the child's, if higher) and in the parent's chain, so the
 * chain's depth and budgets cover it. The child runs inside the step while it can; when it pauses on an approval the
 * step waits (without a worker), and the child's end resumes the parent, which takes the child's output and label.
 */

/** A child run's input: field templates, one template that renders to an object, or the step's own input. */
export function childInput(input: unknown, scope: TemplateScope, fallback: Record<string, unknown>): Record<string, unknown> {
  if (input === undefined) return { ...fallback };
  if (typeof input !== 'string') return Object.fromEntries(Object.entries(input as Record<string, string>).map(([k, t]) => [k, render(t, scope)]));
  let v = render(input, scope);
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      throw new StepFailed('The input template does not render to a JSON object.');
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new StepFailed('The input template does not render to a JSON object.');
  return v as Record<string, unknown>;
}

export async function runSub(c: StepCall, host: StepHost): Promise<StepResult | typeof WAIT> {
  const cfg = STEP_KINDS.sub.config.parse(c.n.config) as SubConfig;
  if (c.run.mode === 'dry') return { output: { run: null, output: sampleOf(c.n.output ?? { type: 'object' }) }, detail: { mocked: true, workflow: cfg.workflow } };
  const input = childInput(cfg.input, c.scope, c.merged);
  const r = await host.child(c, { workflow: cfg.workflow, ...(cfg.version ? { version: cfg.version } : {}), input, label: c.label, key: c.n.id, timeoutMs: c.n.timeoutMs ?? LIMITS.defaultStepTimeoutMs });
  if (r.state === 'waiting') return host.wait(c, { child: r.run, workflow: cfg.workflow, version: r.version });
  if (r.state === 'failed') {
    if (r.blocked) throw new StepBlocked(r.error);
    throw new StepFailed(r.error);
  }
  return { output: { run: r.run, output: r.output }, label: r.label, detail: { child: r.run, workflow: cfg.workflow, version: r.version } };
}
