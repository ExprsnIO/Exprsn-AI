import { z } from 'zod';
import { labelRank, type Label } from '../../authz/labels.js';
import type { PortSchema } from '../graph.js';
import type { StepKindDef } from './kinds.js';

/*
 * Sprint 46: the publish-time half of the `switch` (B-132) and `decision` (B-131) step kinds, registered in
 * `STEP_KINDS` by `kinds.ts`. A leaf like `kinds.ts` (zod and types only; `kinds.ts` imports it while it is being
 * evaluated, so nothing here reads a value of `kinds.ts`). The run-time halves are `switch.ts` and `decision.ts`.
 *
 * - `switch`: one value (a template: a context path such as {{input.amount}}, or text built from several) compared
 *   against ordered cases (`equals` a value, `in` a list, a number `range` from `min` up to but not including
 *   `max`); the first case that matches is taken, else `default`. Each edge out of the step names its case
 *   (`case`), so exactly one edge is taken. Publishing needs unique case labels, an edge for every case and a
 *   default edge.
 * - `decision`: evaluates a published decision table (by name, a pinned version or the latest) with inputs mapped
 *   from the run (`inputs`: column to template; left out, the fields of the same names of `source`, a template giving
 *   an object, or of the step's input) and puts the
 *   outputs into the run (`outputs`: field to output column; left out, every output under its own name), with the
 *   rules that matched in `matched`.
 */

const template = z.string().max(20_000);
const propName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/, 'Property names are letters, digits and _');
const scalar = z.union([z.string().max(500), z.number().finite(), z.boolean()]);

const obj = (properties: Record<string, PortSchema>, required = Object.keys(properties)): PortSchema => ({ type: 'object', properties, required });
const ANY: PortSchema = { type: 'any' };

// ---------- switch (B-132) ----------

/** The edge label of a switch's default branch. */
export const DEFAULT_CASE = 'default';
export const caseLabel = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,59}$/, 'Case labels are letters, digits, spaces and _ . : - (up to 60)');

export const switchCaseSchema = z.discriminatedUnion('match', [
  z.object({ label: caseLabel, match: z.literal('equals'), value: z.union([scalar, z.null()]) }).strict(),
  z.object({ label: caseLabel, match: z.literal('in'), values: z.array(z.union([scalar, z.null()])).min(1).max(50) }).strict(),
  z.object({ label: caseLabel, match: z.literal('range'), min: z.number().finite().optional(), max: z.number().finite().optional() }).strict()
]);
export type SwitchCase = z.infer<typeof switchCaseSchema>;

const switchConfig = z
  .object({
    /** What is compared: a template (a single placeholder keeps the value's type). */
    value: template.min(1),
    /** Checked in order; the first that matches is taken. At most 9: with the default, a step fans out to at most 10. */
    cases: z.array(switchCaseSchema).min(1, 'Add at least one case').max(9, 'At most 9 cases besides the default (a step fans out to at most 10 steps)')
  })
  .strict();
export type SwitchConfig = z.infer<typeof switchConfig>;

export const switchKind: StepKindDef = {
  config: switchConfig,
  templates: (cfg) => [String(cfg.value)],
  // A switch passes its input on and adds the case it took.
  output: (_n, incoming) => {
    const base = incoming.type === 'object' ? incoming : obj({});
    return { type: 'object', properties: { ...(base.properties ?? {}), case: { type: 'string' } }, required: [...new Set([...(base.required ?? []), 'case'])] };
  },
  check(n, cfg, c) {
    const x = cfg as SwitchConfig;
    const seen = new Map<string, string>();
    for (const k of x.cases) {
      const key = k.label.toLowerCase();
      if (key === DEFAULT_CASE) c.errors.push({ code: 'config', nodeId: n.id, message: `${n.title}: "${DEFAULT_CASE}" is the label of the default edge; name the case otherwise.` });
      else if (seen.has(key)) c.errors.push({ code: 'config', nodeId: n.id, message: `${n.title}: two cases are labelled ${k.label}; case labels are unique.` });
      seen.set(key, k.label);
      if (k.match === 'range') {
        if (k.min === undefined && k.max === undefined) c.errors.push({ code: 'config', nodeId: n.id, message: `${n.title}: case ${k.label} is a range without a minimum or a maximum.` });
        else if (k.min !== undefined && k.max !== undefined && k.min >= k.max) c.errors.push({ code: 'config', nodeId: n.id, message: `${n.title}: case ${k.label} runs from ${k.min} up to ${k.max}, which holds no number.` });
      }
    }
    // Every edge out (but a failure edge) names a case; every case and the default have exactly one.
    const out = c.g.edges.filter((e) => e.from === n.id && e.branch !== 'failure');
    const taken = new Map<string, number>();
    for (const e of out) {
      if (!e.case) continue; // graph.ts reports an edge without a case
      const key = e.case.toLowerCase();
      if (key !== DEFAULT_CASE && !seen.has(key)) c.errors.push({ code: 'structure', nodeId: n.id, edge: { from: e.from, to: e.to }, message: `${n.title}: the edge to ${e.to} names the case ${e.case}, which the step does not have.` });
      taken.set(key, (taken.get(key) ?? 0) + 1);
    }
    for (const [key, count] of taken) if (count > 1) c.errors.push({ code: 'structure', nodeId: n.id, message: `${n.title}: ${count} edges take the case ${key === DEFAULT_CASE ? DEFAULT_CASE : seen.get(key)}; exactly one edge is taken for each.` });
    for (const [key, label] of seen) if (key !== DEFAULT_CASE && !taken.has(key)) c.errors.push({ code: 'structure', nodeId: n.id, message: `${n.title}: case ${label} is not connected; connect it to the step it leads to.` });
    if (!taken.has(DEFAULT_CASE)) c.errors.push({ code: 'structure', nodeId: n.id, message: `${n.title} needs a default edge: the step taken when no case matches.` });
    return undefined;
  }
};

/** The case a value takes: the first whose test it passes, else the default. */
export function switchCaseOf(cases: SwitchCase[], value: unknown): string {
  const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null) || (a != null && b != null && typeof a !== 'object' && String(a) === String(b));
  for (const k of cases) {
    if (k.match === 'equals' && same(value, k.value)) return k.label;
    if (k.match === 'in' && k.values.some((v) => same(value, v))) return k.label;
    if (k.match === 'range') {
      const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
      if (Number.isFinite(n) && (k.min === undefined || n >= k.min) && (k.max === undefined || n < k.max)) return k.label;
    }
  }
  return DEFAULT_CASE;
}

// ---------- decision (B-131) ----------

/** A published decision table as a decision step sees it at publish. */
export interface DecisionRefInfo {
  id: string;
  name: string;
  label: Label;
  version: number;
  hitPolicy: string;
  aggregation: string | null;
  inputs: { name: string; type: string }[];
  outputs: { name: string; type: string }[];
}

const decisionConfig = z
  .object({
    /** The table's name (or id), in the tenant. */
    table: z.string().trim().min(1).max(200),
    /** Pins a published version; without it the step evaluates the version published when the run reaches it. */
    version: z.number().int().min(1).optional(),
    /** Input column to template; left out, each column reads the step's input field of the same name. */
    inputs: z.record(propName, template).refine((v) => Object.keys(v).length <= 30, 'At most 30 inputs').optional(),
    /** Without `inputs`: a template rendering to an object whose fields the columns read by name (left out: the step's input). */
    source: template.optional(),
    /** Output field of the step to output column; left out, every output column under its own name. */
    outputs: z.record(propName, propName).refine((v) => Object.keys(v).length <= 20, 'At most 20 outputs').optional(),
    /** When no rule matches: go on (outputs null, or the table's defaults) or fail the step. */
    noMatch: z.enum(['continue', 'fail']).default('continue')
  })
  .strict();
export type DecisionStepConfig = z.infer<typeof decisionConfig>;

type DecisionEnv = { decision?(ref: string, version?: number): DecisionRefInfo | { missing: string } | undefined };

export const decisionKind: StepKindDef = {
  config: decisionConfig,
  templates: (cfg) => [...Object.values((cfg.inputs as Record<string, string> | undefined) ?? {}), ...(typeof cfg.source === 'string' ? [cfg.source] : [])],
  output: (n) => {
    const outs = (n.config as { outputs?: Record<string, string> }).outputs;
    return n.output ?? obj({ ...Object.fromEntries(Object.keys(outs ?? {}).map((k) => [k, ANY])), matched: { type: 'array', items: { type: 'string' } } }, ['matched']);
  },
  check(n, cfg, c) {
    const x = cfg as DecisionStepConfig;
    const what = `${x.table}${x.version ? ` version ${x.version}` : ''}`;
    const d = (c.env as DecisionEnv).decision?.(x.table, x.version);
    if (!d || 'missing' in d) {
      c.errors.push({ code: 'unavailable', nodeId: n.id, message: `${n.title}: decision table ${what} ${d ? d.missing : 'is not available here'}.` });
      return undefined;
    }
    if (labelRank(d.label) > labelRank(c.env.label)) c.errors.push({ code: 'label', nodeId: n.id, message: `${n.title}: decision table ${d.name} is ${d.label}, above this workflow's ${c.env.label} label.` });
    const ins = new Set(d.inputs.map((i) => i.name));
    const outs = new Set(d.outputs.map((o) => o.name));
    for (const k of Object.keys(x.inputs ?? {})) if (!ins.has(k)) c.errors.push({ code: 'config', nodeId: n.id, message: `${n.title}: ${d.name} has no input column ${k} (it has ${[...ins].join(', ') || 'none'}).` });
    for (const [field, col] of Object.entries(x.outputs ?? {})) if (!outs.has(col)) c.errors.push({ code: 'config', nodeId: n.id, message: `${n.title}: ${field} reads ${col}, which is not an output column of ${d.name} (it has ${[...outs].join(', ')}).` });
    if (x.inputs && x.source) c.errors.push({ code: 'config', nodeId: n.id, message: `${n.title}: map the inputs one by one or read them from one source object, not both.` });
    if (!x.inputs && !x.source && c.merged.type === 'object' && c.merged.properties) {
      const missing = d.inputs.filter((i) => !(i.name in c.merged.properties!)).map((i) => i.name);
      if (missing.length) c.warnings.push({ code: 'config', nodeId: n.id, message: `${n.title} reads ${missing.join(', ')} from its input, which the steps before it do not give; map the inputs, or those columns are empty.` });
    }
    return undefined;
  },
  refs: (cfg) => ({ decisions: [{ ref: String(cfg.table), ...(cfg.version ? { version: Number(cfg.version) } : {}) }] })
};
