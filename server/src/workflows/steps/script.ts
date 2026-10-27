import { labelRank } from '../../authz/labels.js';
import { coerceArgs, graphSchema, guardedByApproval, render, sampleOf } from '../graph.js';
import { StepBlocked, StepFailed, type StepCall, type StepHost, type StepResult, type WAIT } from './host.js';
import { STEP_KINDS, type ScriptStepConfig } from './kinds.js';

/*
 * The script step: a tenant script (Scripts screen) run directly, by name and version, in the same sandbox and with
 * the same limits as every other run of it (`ScriptService.runForStep` over the `ScriptRunner`). Only a version that
 * may run unattended is resolved: the one its published registry tool pins (reviewed by a tool admin), or a pinned
 * version that passed its checks and ran cleanly once, wired in by a publisher holding `scripts:run`. The arguments
 * go in as JSON on stdin; the JSON on stdout (an object as is, anything else as `{result}`, text as `{text}`) is the
 * step's output. A failing script fails the step, so the retry policy and a `failure` edge handle it like any other.
 */

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The arguments: `args` templates (typed by a reviewed tool's input schema), one template rendering to an object, or the step's input. */
function scriptArgs(cfg: ScriptStepConfig, c: StepCall, schema: Record<string, unknown> | null): Record<string, unknown> {
  if (cfg.args === undefined) return { ...c.merged };
  if (typeof cfg.args !== 'string') return coerceArgs(Object.fromEntries(Object.entries(cfg.args).map(([k, t]) => [k, render(t, c.scope)])), schema);
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

export async function runScript(c: StepCall, host: StepHost): Promise<StepResult | typeof WAIT> {
  const cfg = STEP_KINDS.script.config.parse(c.n.config) as ScriptStepConfig;
  if (c.run.mode === 'dry') return { output: sampleOf(c.n.output ?? { type: 'object' }), detail: { mocked: true, script: cfg.script, version: cfg.version ?? null } };
  if (!host.scripts) throw new StepFailed('Script steps are not available on this server.');
  const info = await host.scripts.refInfo({ tenantId: c.run.tenant_id, workspaceId: c.run.workspace_id }, cfg.script, cfg.version);
  if ('missing' in info) throw new StepFailed(`Script ${cfg.script}${cfg.version ? ` version ${cfg.version}` : ''} ${info.missing}.`);
  if (info.ceiling && labelRank(c.label) > labelRank(info.ceiling)) {
    throw new StepBlocked(`Blocked by label ceiling: ${info.tool ?? info.name} takes data up to ${info.ceiling}; the data arriving is ${c.label}.`);
  }
  const args = scriptArgs(cfg, c, info.inputSchema);
  const approved = guardedByApproval(graphSchema.parse(JSON.parse(c.run.graph)), c.n.id);
  const base = { script: info.name, scriptId: info.id, version: info.version, basis: info.basis, ...(info.tool ? { tool: info.tool } : {}) };
  const r = await host.scripts.runForStep(c.p, info, args, { label: c.label, approved, source: { kind: 'workflow-step', id: c.step.id }, signal: c.signal });
  await host.audit(c, 'workflow.script.ran', { script: info.id, version: info.version, ...(r.run ? { scriptRun: r.run } : {}) }, { ...base, ok: r.ok, ...(r.ok ? { exitCode: r.exitCode, durationMs: r.durationMs } : { error: r.error.slice(0, 300) }) });
  if (!r.ok) {
    if (r.blocked) throw new StepBlocked(r.error);
    throw new StepFailed(r.error, r.type);
  }
  return { output: r.output, detail: { ...base, scriptRun: r.run, exitCode: r.exitCode, scriptMs: r.durationMs, truncated: r.truncated, valid: r.valid } };
}
