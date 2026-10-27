import { DecisionError, evaluate } from '../../decisions/table.js';
import { render } from '../graph.js';
import { StepBlocked, StepFailed, type StepCall, type StepHost, type StepResult } from './host.js';
import { STEP_KINDS, type DecisionStepConfig } from './kinds.js';

/*
 * The decision step (Sprint 46, B-131), run-time half (the publish checks are in choose-kinds.ts): the table is read
 * as the run's owner (a table above their clearance blocks the step), evaluated with the mapped inputs (pure, no code
 * runs; a dry run evaluates it too, since nothing is written), and its outputs are the step's output with the rules
 * that matched in `matched`. A broken unique or any hit policy, or an input of the wrong type, fails the step, so a
 * failure edge or the retry policy handles it; the output carries the table's label.
 */

export async function runDecision(c: StepCall, host: StepHost): Promise<StepResult> {
  const cfg = STEP_KINDS.decision.config.parse(c.n.config) as DecisionStepConfig;
  if (!host.decisions) throw new StepFailed('Decision tables are not available on this server.');
  const t = await host.decisions.forStep(c.p, cfg.table, cfg.version);
  if ('missing' in t) {
    const msg = `Decision table ${cfg.table}${cfg.version ? ` version ${cfg.version}` : ''} ${t.missing}.`;
    if (t.blocked) throw new StepBlocked(msg);
    throw new StepFailed(msg);
  }
  const inputs: Record<string, unknown> = {};
  const from = cfg.source !== undefined ? render(cfg.source, c.scope) : c.merged;
  const fields = from && typeof from === 'object' && !Array.isArray(from) ? (from as Record<string, unknown>) : {};
  for (const col of t.definition.inputs) inputs[col.name] = cfg.inputs ? (cfg.inputs[col.name] === undefined ? undefined : render(cfg.inputs[col.name]!, c.scope)) : fields[col.name];
  let r;
  try {
    r = evaluate(t.definition, inputs);
  } catch (err) {
    if (err instanceof DecisionError) throw new StepFailed(`${t.name} v${t.version}: ${err.message}`);
    throw err;
  }
  if (!r.matched.length && cfg.noMatch === 'fail') throw new StepFailed(`${t.name} v${t.version}: no rule matched.`);
  const map = cfg.outputs ?? Object.fromEntries(t.definition.outputs.map((o) => [o.name, o.name]));
  const values = Object.fromEntries(Object.entries(map).map(([field, col]) => [field, r.outputs ? (r.outputs[col] ?? null) : null]));
  return {
    output: { ...values, matched: r.matched.map((m) => m.rule), ...(r.rows ? { rows: r.rows } : {}) },
    detail: { table: t.name, tableId: t.id, version: t.version, hitPolicy: r.hitPolicy, matched: r.matched.map((m) => m.rule), summary: r.summary.slice(0, 500) },
    label: t.label
  };
}
