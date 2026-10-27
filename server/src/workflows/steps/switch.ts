import { render } from '../graph.js';
import type { StepCall, StepHost, StepResult } from './host.js';
import { STEP_KINDS, switchCaseOf, type SwitchConfig } from './kinds.js';

/*
 * The switch step (Sprint 46, B-132), run-time half (the publish checks are in choose-kinds.ts): the value is rendered
 * from the run, compared with the cases in order, and the first that matches (else `default`) is the step's `case`.
 * The workflow service takes only the edge whose `case` is that one (`switchTaken`); the steps behind the other edges
 * are skipped. Deterministic, so a dry run decides the same way and a retry policy is not offered.
 */

export async function runSwitch(c: StepCall, _host: StepHost): Promise<StepResult> {
  const cfg = STEP_KINDS.switch.config.parse(c.n.config) as SwitchConfig;
  const value = render(cfg.value, c.scope);
  const taken = switchCaseOf(cfg.cases, value);
  const shown = value === undefined ? null : typeof value === 'string' ? value.slice(0, 200) : typeof value === 'object' ? JSON.stringify(value).slice(0, 200) : value;
  return { output: { ...c.merged, case: taken }, detail: { case: taken, value: shown } };
}

/** Whether the edge out of a switch is the one its output took. */
export const switchTaken = (e: { case?: string | undefined }, output: unknown): boolean => {
  const taken = (output as { case?: unknown } | null)?.case;
  return typeof taken === 'string' && typeof e.case === 'string' && e.case.toLowerCase() === taken.toLowerCase();
};
