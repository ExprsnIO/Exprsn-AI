import { z } from 'zod';
import { labelRank, type Label } from '../../authz/labels.js';
import type { Issue, PortSchema, ValidationEnv, WfEdge, WfGraph, WfNode } from '../graph.js';

/*
 * Workflows 2 step kinds (Sprint 32): the publish-time half of each kind, registered with the graph through
 * `STEP_KINDS`. This module is a leaf (zod and types only) because `graph.ts` imports it while it is being evaluated;
 * the run-time half of each kind lives next to it (`sub.ts`, `agent.ts`, `map.ts`) and is reached from the
 * workflow service's `runNode`.
 *
 * Registering a kind (the hook for other parts of Sprint 32): add a `StepKindDef` to `STEP_KINDS` below with its zod
 * config, the templates it reads, its output port and any publish checks; `NODE_KINDS`, `CONFIGS`, `outputSchemaOf`
 * and `validateGraph` pick it up. Then give it a runner in `steps/index.ts` (`STEP_RUNNERS`), which `runNode`
 * dispatches to for every kind it does not handle itself.
 */

export const stepPropName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/, 'Property names are letters, digits and _');
export const stepTemplate = z.string().max(20_000);
const entryRef = z.string().trim().min(1).max(200);

/** What a sub-workflow step (or a map or loop item) sees of the workflow it runs. */
export interface WorkflowRefInfo {
  id: string;
  name: string;
  label: Label;
  version: number;
  /** The trigger's output schema: the input the child run must match. */
  input: PortSchema | null;
}
export interface AgentRefInfo {
  name: string;
  version: string;
  label: Label;
}
export interface SkillRefInfo {
  name: string;
  version: string;
  label: Label;
  tools: string[];
}

/** What publish checks can use: the graph's helpers (passed in, so this module stays a leaf). */
export interface StepCheckContext {
  g: WfGraph;
  merged: PortSchema;
  preds: WfEdge[];
  env: ValidationEnv;
  errors: Issue[];
  warnings: Issue[];
  compatible(from: PortSchema, to: PortSchema): string | null;
  portFromJsonSchema(js: unknown): PortSchema;
  guardedByApproval(g: WfGraph, id: string): boolean;
}

export interface StepKindDef {
  config: z.ZodType;
  /** Templates in the (parsed) config that read the run scope, with item-local placeholders removed. */
  templates(config: Record<string, unknown>): string[];
  output(n: WfNode, incoming: PortSchema): PortSchema;
  /** Checks against the environment at publish; returns the ceiling the arriving data must stay under, if any. */
  check?(n: WfNode, config: Record<string, unknown>, c: StepCheckContext): Label | undefined;
  /** Steps this one counts for beyond itself toward the 40-step limit (a loop's iterations). */
  extraSteps?(config: Record<string, unknown>): number;
  /** Items this step declares it may fan out over (from its raw config), toward the run's item limit (a map's). */
  items?(config: Record<string, unknown>): number;
  /** Names it references, for the validation environment: published workflows, agents, tools, profiles. */
  refs?(config: Record<string, unknown>): StepRefs;
}

export interface StepRefs {
  workflows?: { ref: string; version?: number }[];
  agents?: string[];
  tools?: string[];
}

/** Item-local placeholders (`{{item…}}`, `{{index}}`, `{{iteration}}`, `{{last…}}`, `{{results…}}`) stripped before the reference check. */
const LOCAL = /\{\{\s*(?:item|index|iteration|last|results)(?:[.[][^}]*)?\s*\}\}/g;
const stripLocal = (t: string) => t.replace(LOCAL, '');

const obj = (properties: Record<string, PortSchema>, required = Object.keys(properties)): PortSchema => ({ type: 'object', properties, required });
const ANY: PortSchema = { type: 'any' };

/** The run limits Workflows 2 adds: items a run may fan out over, items at once, iterations of one loop. */
export const STEP_LIMITS = { maxItems: 200, maxParallel: 20, maxIterations: 40 } as const;

const subInput = z.union([z.record(stepPropName, stepTemplate), stepTemplate]);

// ---------- sub (B-3901) ----------

const subConfig = z
  .object({
    /** The workflow's name or id, in the same workspace. */
    workflow: entryRef,
    /** Pins a published version; without it the step runs the version published when the run reaches it. */
    version: z.number().int().min(1).optional(),
    /** The child run's input: field templates, one template rendering to an object, or (omitted) this step's input. */
    input: subInput.optional()
  })
  .strict();

function inputTemplates(input: unknown): string[] {
  if (typeof input === 'string') return [stripLocal(input)];
  if (input && typeof input === 'object') return Object.values(input as Record<string, unknown>).filter((v): v is string => typeof v === 'string').map(stripLocal);
  return [];
}

/** A child workflow reference against the environment: published, not this workflow, input fitting its trigger. */
function checkWorkflowRef(n: WfNode, cfg: { workflow: string; version?: number; input?: unknown }, c: StepCheckContext, what: string): void {
  const self = c.env.self;
  if (self && (cfg.workflow === self.id || cfg.workflow === self.name)) {
    c.errors.push({ code: 'config', nodeId: n.id, message: `${n.title}: a workflow cannot run itself as ${what}.` });
    return;
  }
  const w = c.env.workflow?.(cfg.workflow, cfg.version);
  if (!w || 'missing' in w) {
    c.errors.push({ code: 'unavailable', nodeId: n.id, message: `${n.title}: ${cfg.workflow}${cfg.version ? ` version ${cfg.version}` : ''} ${w ? w.missing : 'is not a workflow in this workspace'}.` });
    return;
  }
  if (labelRank(c.env.label) > labelRank(w.label)) c.warnings.push({ code: 'label', nodeId: n.id, message: `${n.title}: ${w.name} is ${w.label}; it runs here under this workflow's ${c.env.label} label, and its steps' ceilings still apply.` });
  if (w.input && cfg.input !== undefined && typeof cfg.input !== 'string') {
    const given = obj(Object.fromEntries(Object.keys(cfg.input as Record<string, string>).map((k) => [k, ANY])));
    const err = c.compatible(given, w.input);
    if (err) c.errors.push({ code: 'schema', nodeId: n.id, message: `Schema mismatch at ${n.title}: ${err} (the trigger of ${w.name}).`, expected: w.input, actual: given });
  } else if (w.input && cfg.input === undefined && what === 'a sub-workflow') {
    const err = c.compatible(c.merged, w.input);
    const single = c.preds.length === 1 ? c.preds[0] : undefined;
    if (err) c.errors.push({ code: 'schema', nodeId: n.id, ...(single ? { edge: { from: single.from, to: single.to } } : {}), message: `Schema mismatch at ${n.title}: ${err} (the trigger of ${w.name}).`, expected: w.input, actual: c.merged });
  }
}

const sub: StepKindDef = {
  config: subConfig,
  templates: (cfg) => inputTemplates(cfg.input),
  output: (n) => n.output ?? obj({ run: { type: 'string' }, output: ANY }),
  check(n, cfg, c) {
    checkWorkflowRef(n, cfg as z.infer<typeof subConfig>, c, 'a sub-workflow');
    return undefined;
  },
  refs: (cfg) => ({ workflows: [{ ref: String(cfg.workflow), ...(cfg.version ? { version: Number(cfg.version) } : {}) }] })
};

// ---------- agent (B-3902) ----------

const budgetRaise = z.object({ steps: z.number().int().min(1).max(100), tokens: z.number().int().min(1).max(200_000), wallSeconds: z.number().int().min(1).max(3600), toolCalls: z.number().int().min(0).max(100) }).partial().strict();
const agentConfig = z
  .object({
    /** The registry agent's name. */
    agent: entryRef,
    /** The task the agent gets: a template (the step's input as JSON when omitted). */
    input: stepTemplate.optional(),
    /** The run's budgets, raised from (or lowered below) the agent's own up to the registry maximum. */
    budgets: budgetRaise.optional()
  })
  .strict();

const agent: StepKindDef = {
  config: agentConfig,
  templates: (cfg) => (typeof cfg.input === 'string' ? [cfg.input] : []),
  output: (n) => n.output ?? obj({ run: { type: 'string' }, text: { type: 'string' } }),
  check(n, cfg, c) {
    const a = c.env.agent?.(String(cfg.agent));
    if (!a || 'missing' in a) {
      c.errors.push({ code: 'unavailable', nodeId: n.id, message: `${n.title}: agent ${String(cfg.agent)} ${a ? a.missing : 'is not in the registry'}.` });
      return undefined;
    }
    return a.label;
  },
  refs: (cfg) => ({ agents: [String(cfg.agent)] })
};

// ---------- map and loop (B-3905) ----------

/** What a map runs for each item, or a loop each iteration: a model prompt, a registry tool or a workflow. */
const action = {
  profile: z.string().min(1).max(63).optional(),
  prompt: stepTemplate.optional(),
  format: z.enum(['text', 'json']).optional(),
  tool: z.string().trim().min(1).max(200).optional(),
  args: z.record(stepPropName, stepTemplate).optional(),
  workflow: entryRef.optional(),
  version: z.number().int().min(1).optional(),
  input: subInput.optional()
};
type Action = { profile?: string; prompt?: string; format?: 'text' | 'json'; tool?: string; args?: Record<string, string>; workflow?: string; version?: number; input?: unknown };

const oneAction = (c: Action) => [c.profile, c.tool, c.workflow].filter(Boolean).length === 1;
const ONE_ACTION = 'Run exactly one thing per item: a profile with a prompt, a tool, or a workflow';
const promptWithProfile = (c: Action) => !c.profile || !!c.prompt;

export const branchOps = z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'truthy', 'exists']);

const mapConfig = z
  .object({
    /** A template that renders to the list (a single placeholder, such as {{steps.frames.frames}}). */
    over: stepTemplate.min(1),
    /** The output field holding the results, in the order of the items. */
    as: stepPropName.default('results'),
    maxParallel: z.number().int().min(1).max(STEP_LIMITS.maxParallel).default(10),
    maxItems: z.number().int().min(1).max(STEP_LIMITS.maxItems).default(STEP_LIMITS.maxItems),
    ...action
  })
  .strict()
  .refine(oneAction, ONE_ACTION)
  .refine(promptWithProfile, 'A profile needs a prompt (use {{item}} for the item)');

const loopConfig = z
  .object({
    /** The most iterations (each counts toward the run's 40-step limit). */
    max: z.number().int().min(1).max(STEP_LIMITS.maxIterations).default(5),
    /** Checked before every iteration; the loop ends when it is false (or at `max`). */
    while: z.object({ left: stepTemplate.min(1), op: branchOps, right: z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]).optional() }).strict().optional(),
    ...action
  })
  .strict()
  .refine(oneAction, ONE_ACTION)
  .refine(promptWithProfile, 'A profile needs a prompt (use {{iteration}} and {{last}})');

function actionTemplates(c: Action): string[] {
  const out: string[] = [];
  if (c.prompt) out.push(stripLocal(c.prompt));
  if (c.args) out.push(...Object.values(c.args).map(stripLocal));
  out.push(...inputTemplates(c.input));
  return out;
}

/** The item action against the environment; returns its ceiling. */
function checkAction(n: WfNode, c: Action, ctx: StepCheckContext): Label | undefined {
  if (c.profile) {
    const p = ctx.env.profile(c.profile);
    if (!p) ctx.errors.push({ code: 'config', nodeId: n.id, message: `${n.title}: profile ${c.profile} is not published.` });
    return p?.label;
  }
  if (c.tool) {
    const t = ctx.env.tool?.(c.tool);
    if (!t || 'missing' in t) {
      ctx.errors.push({ code: 'unavailable', nodeId: n.id, message: `${n.title}: ${c.tool} ${t ? t.missing : 'is not in the registry'}.` });
      return undefined;
    }
    if (t.impl === 'workflow') {
      ctx.errors.push({ code: 'config', nodeId: n.id, message: `${n.title}: ${c.tool} is a workflow published as a tool; run the workflow itself (workflow) instead.` });
      return undefined;
    }
    if ((t.sideEffect !== 'read' || t.confirm === 'always') && !ctx.guardedByApproval(ctx.g, n.id)) {
      ctx.errors.push({ code: 'config', nodeId: n.id, message: `${n.title} calls ${c.tool}, a ${t.sideEffect} tool, for every item: put an Approval step before it on every path (items never pause one by one).` });
    }
    if (c.args && t.inputSchema) {
      const given = obj(Object.fromEntries(Object.keys(c.args).map((k) => [k, ANY])));
      const err = ctx.compatible(given, ctx.portFromJsonSchema(t.inputSchema));
      if (err) ctx.errors.push({ code: 'schema', nodeId: n.id, message: `Schema mismatch at ${n.title}: ${err} (the input schema of ${c.tool}).` });
    }
    return t.label;
  }
  if (c.workflow) checkWorkflowRef(n, { workflow: c.workflow, ...(c.version ? { version: c.version } : {}), ...(c.input !== undefined ? { input: c.input } : {}) }, ctx, 'an item');
  return undefined;
}

const actionRefs = (c: Action): StepRefs => ({ ...(c.tool ? { tools: [c.tool] } : {}), ...(c.workflow ? { workflows: [{ ref: c.workflow, ...(c.version ? { version: c.version } : {}) }] } : {}) });

const map: StepKindDef = {
  config: mapConfig,
  templates: (cfg) => [String(cfg.over), ...actionTemplates(cfg as Action)],
  output: (n) => {
    const as = String((n.config as { as?: unknown }).as ?? 'results');
    return n.output ?? obj({ [as]: { type: 'array', items: ANY }, count: { type: 'integer' } });
  },
  check: (n, cfg, c) => checkAction(n, cfg as Action, c),
  items: (cfg) => (typeof cfg.maxItems === 'number' ? cfg.maxItems : 0),
  refs: (cfg) => actionRefs(cfg as Action)
};

const loop: StepKindDef = {
  config: loopConfig,
  templates: (cfg) => [...(cfg.while ? [stripLocal(String((cfg.while as { left: string }).left))] : []), ...actionTemplates(cfg as Action)],
  output: (n) => n.output ?? obj({ iterations: { type: 'integer' }, last: ANY, results: { type: 'array', items: ANY }, stopped: { type: 'string' } }),
  check: (n, cfg, c) => checkAction(n, cfg as Action, c),
  extraSteps: (cfg) => Math.max(0, Number(cfg.max ?? 5) - 1),
  refs: (cfg) => actionRefs(cfg as Action)
};

/** The Workflows 2 kinds, by name. Add a kind here (and its runner in `steps/index.ts`). */
export const STEP_KINDS = { sub, agent, map, loop } satisfies Record<string, StepKindDef>;
export const STEP_KIND_NAMES = ['sub', 'agent', 'map', 'loop'] as const;
export type StepKindName = (typeof STEP_KIND_NAMES)[number];
export const isStepKind = (k: string): k is StepKindName => (STEP_KIND_NAMES as readonly string[]).includes(k);

export type SubConfig = z.infer<typeof subConfig>;
export type AgentStepConfig = z.infer<typeof agentConfig>;
export type MapConfig = z.infer<typeof mapConfig>;
export type LoopConfig = z.infer<typeof loopConfig>;
export type ItemAction = Action;

/** Skills on a model step (B-3902): each must be published to the workspace; the step's ceiling is the lowest of theirs. */
export function checkModelSkills(n: WfNode, skills: string[], env: ValidationEnv, errors: Issue[]): Label | undefined {
  let ceiling: Label | undefined;
  for (const name of skills) {
    const s = env.skill?.(name);
    if (!s || 'missing' in s) {
      errors.push({ code: 'unavailable', nodeId: n.id, message: `${n.title}: skill ${name} ${s ? s.missing : 'is not in the registry'}.` });
      continue;
    }
    if (!ceiling || labelRank(s.label) < labelRank(ceiling)) ceiling = s.label;
  }
  return ceiling;
}
