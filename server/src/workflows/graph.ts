import { z } from 'zod';
import { highest, labelRank, LABELS, type Label } from '../authz/labels.js';
import { isRole } from '../authz/permissions.js';
import { CHECKPOINTS } from '../guardrails/types.js';

/*
 * Workflow graphs: typed nodes joined by edges, validated before publishing. A node's input is the merge of the
 * outputs of the steps feeding it; templates (`{{input.x}}`, `{{steps.<id>.y}}`) read the run input and any earlier
 * step. Validation reports every problem with the node (and edge) it belongs to, so the editor can point at it.
 */

export const NODE_KINDS = ['trigger', 'model', 'transform', 'branch', 'guardrail', 'approval', 'http', 'calc', 'wait', 'tool'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

/** Limits a published workflow must stay within (the board's "40 steps, 200k tokens, 2 h"). */
export const LIMITS = {
  maxSteps: 40,
  maxFanOut: 10,
  maxStepTimeoutMs: 30 * 60_000,
  defaultStepTimeoutMs: 5 * 60_000,
  maxRunTimeoutMs: 2 * 3_600_000,
  maxTokens: 200_000,
  maxApprovalMs: 7 * 24 * 3_600_000,
  maxWaitMs: 7 * 24 * 3_600_000
} as const;

export type SchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'any';
export interface PortSchema {
  type: SchemaType;
  properties?: Record<string, PortSchema>;
  required?: string[];
  items?: PortSchema;
}

const propName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/, 'Property names are letters, digits and _');
export const portSchema: z.ZodType<PortSchema> = z.lazy(() =>
  z
    .object({
      type: z.enum(['string', 'number', 'integer', 'boolean', 'array', 'object', 'any']),
      properties: z.record(propName, portSchema).optional(),
      required: z.array(propName).max(50).optional(),
      items: portSchema.optional()
    })
    .strict()
);

const nodeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/, 'Step ids are letters, digits, _ and -');
const template = z.string().max(20_000);

export const nodeSchema = z
  .object({
    id: nodeId,
    kind: z.enum(NODE_KINDS),
    title: z.string().trim().min(1).max(100),
    x: z.number().min(0).max(20_000).default(20),
    y: z.number().min(0).max(20_000).default(20),
    config: z.record(z.string(), z.unknown()).default({}),
    input: portSchema.optional(),
    output: portSchema.optional(),
    /** The highest label this step may handle (e.g. the ceiling of the system an HTTP step writes to). */
    ceiling: z.enum(LABELS).optional(),
    /** The label of data this step brings in (an HTTP answer from a confidential system raises the run). */
    raises: z.enum(LABELS).optional(),
    timeoutMs: z.number().int().min(1000).max(LIMITS.maxStepTimeoutMs).optional()
  })
  .strict();

export const edgeSchema = z.object({ from: nodeId, to: nodeId, branch: z.enum(['true', 'false']).optional() }).strict();

export const graphSchema = z
  .object({
    nodes: z.array(nodeSchema).max(200),
    edges: z.array(edgeSchema).max(1000),
    limits: z.object({ timeoutMs: z.number().int().min(1000).optional(), tokens: z.number().int().min(0).optional() }).strict().default({})
  })
  .strict();

export type WfNode = z.infer<typeof nodeSchema>;
export type WfEdge = z.infer<typeof edgeSchema>;
export type WfGraph = z.infer<typeof graphSchema>;

// ---------- per-kind configuration ----------

const THINK = z.enum(['off', 'low', 'medium', 'high']);
const METHODS = ['GET', 'POST', 'PUT'] as const;
const HEADER = /^(content-type|accept|authorization|x-[a-z0-9-]{1,60})$/i;

/**
 * Sprint 25 (B-1705): a header value that is a vault reference, optionally after an authorization scheme
 * (`vault:apps/crm#token`, `Bearer vault:apps/crm#token`). It is resolved when the step runs, as the run's principal,
 * under the vault policies; the value never enters the graph, the step's output or its detail.
 */
export function headerVaultRef(value: string): { prefix: string; ref: string } | null {
  const m = /^((?:Bearer|Basic|Token) )?(vault:\S+)$/.exec(value);
  return m ? { prefix: m[1] ?? '', ref: m[2]! } : null;
}

/** An HTTP step that would store a credential in the graph: Authorization must be a vault reference (checked at save). */
export function literalAuthorization(g: { nodes: { kind: string; title?: string; config: unknown }[] }): string | null {
  for (const n of g.nodes) {
    if (n.kind !== 'http') continue;
    const headers = ((n.config ?? {}) as { headers?: Record<string, unknown> }).headers ?? {};
    for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === 'authorization' && !(typeof v === 'string' && headerVaultRef(v))) return `${n.title ?? 'An HTTP step'}: Authorization takes a vault reference (vault:path#key, optionally after Bearer, Basic or Token), never a literal credential.`;
  }
  return null;
}

/** Every vault reference in a graph's HTTP steps. */
export function graphVaultRefs(g: { nodes: { kind: string; config: unknown }[] }): string[] {
  const out: string[] = [];
  for (const n of g.nodes) {
    if (n.kind !== 'http') continue;
    const headers = ((n.config ?? {}) as { headers?: Record<string, unknown> }).headers ?? {};
    for (const v of Object.values(headers)) {
      const r = typeof v === 'string' ? headerVaultRef(v) : null;
      if (r) out.push(r.ref);
    }
  }
  return out;
}

export const CONFIGS = {
  trigger: z.object({ source: z.enum(['manual', 'api']).default('manual') }).strict(),
  model: z.object({ profile: z.string().min(1).max(63), prompt: template.min(1), think: THINK.optional(), format: z.enum(['text', 'json']).default('text') }).strict(),
  transform: z.object({ fields: z.record(propName, template).refine((f) => Object.keys(f).length > 0 && Object.keys(f).length <= 50, 'Between 1 and 50 fields') }).strict(),
  branch: z.object({ left: template.min(1), op: z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'truthy', 'exists']), right: z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]).optional() }).strict(),
  guardrail: z.object({ checkpoint: z.enum(CHECKPOINTS).default('context'), text: template.min(1), approverRole: z.string().max(63).default('workflow-admin'), approvalTimeoutMs: z.number().int().min(60_000).max(LIMITS.maxApprovalMs).default(24 * 3_600_000) }).strict(),
  approval: z.object({ role: z.string().min(1).max(63), timeoutMs: z.number().int().min(60_000).max(LIMITS.maxApprovalMs).default(24 * 3_600_000), show: template.default('') }).strict(),
  http: z
    .object({
      method: z.enum(METHODS).default('GET'),
      url: z.string().min(1).max(2000),
      body: template.optional(),
      headers: z
        .record(z.string().regex(HEADER, 'Only Content-Type, Accept, Authorization and X- headers'), z.string().max(1000))
        .default({})
        // Credentials never sit in a graph: Authorization only takes a vault reference.
        .refine((h) => Object.entries(h).every(([k, v]) => k.toLowerCase() !== 'authorization' || !!headerVaultRef(v)), 'Authorization takes a vault reference: vault:path#key, optionally after Bearer, Basic or Token')
    })
    .strict(),
  calc: z.object({ expression: template.min(1).max(2000) }).strict(),
  wait: z.object({ ms: z.number().int().min(1000).max(LIMITS.maxWaitMs) }).strict(),
  /** `args` maps the tool's argument names to templates; without it the step passes on the matching fields of its input. */
  tool: z.object({ tool: z.string().max(200).default(''), args: z.union([z.record(propName, template), template]).optional(), approverRole: z.string().max(63).default('workflow-admin'), approvalTimeoutMs: z.number().int().min(60_000).max(LIMITS.maxApprovalMs).default(24 * 3_600_000) }).strict()
} satisfies Record<NodeKind, z.ZodType>;

export type NodeConfig<K extends NodeKind> = z.infer<(typeof CONFIGS)[K]>;

export function configOf<K extends NodeKind>(n: WfNode & { kind: K }): NodeConfig<K> {
  return CONFIGS[n.kind].parse(n.config) as NodeConfig<K>;
}

// ---------- port schemas ----------

const obj = (properties: Record<string, PortSchema>, required = Object.keys(properties)): PortSchema => ({ type: 'object', properties, required });
const ANY: PortSchema = { type: 'any' };
const PASS_THROUGH: NodeKind[] = ['branch', 'guardrail', 'approval', 'wait'];

export function mergeSchemas(list: PortSchema[]): PortSchema {
  const properties: Record<string, PortSchema> = {};
  const required = new Set<string>();
  for (const s of list) {
    if (s.type !== 'object') continue;
    Object.assign(properties, s.properties ?? {});
    for (const r of s.required ?? []) required.add(r);
  }
  return { type: 'object', properties, required: [...required] };
}

const PORT_TYPES: SchemaType[] = ['string', 'number', 'integer', 'boolean', 'array', 'object'];

/** A JSON Schema (a registry tool's input or output) as a port schema; anything it cannot express is `any`. */
export function portFromJsonSchema(js: unknown): PortSchema {
  if (!js || typeof js !== 'object' || Array.isArray(js)) return ANY;
  const s = js as Record<string, unknown>;
  const type = PORT_TYPES.find((t) => t === s.type);
  if (!type) return ANY;
  const out: PortSchema = { type };
  if (type === 'object' && s.properties && typeof s.properties === 'object' && !Array.isArray(s.properties)) {
    out.properties = Object.fromEntries(Object.entries(s.properties as Record<string, unknown>).map(([k, v]) => [k, portFromJsonSchema(v)]));
  }
  if (type === 'object' && Array.isArray(s.required)) out.required = (s.required as unknown[]).filter((r): r is string => typeof r === 'string');
  if (type === 'array' && s.items) out.items = portFromJsonSchema(s.items);
  return out;
}

/** A published registry tool as a tool step sees it (from the validation environment). */
export interface ToolInfo {
  name: string;
  version: string;
  impl: string;
  /** The tool's ceiling: the highest label it may receive. */
  label: Label;
  sideEffect: 'read' | 'write' | 'destructive';
  confirm: 'always' | 'never';
  inputSchema: Record<string, unknown> | null;
  outputSchema: Record<string, unknown> | null;
}

/** What a tool step outputs: the tool's result when it is an object, otherwise `{result}`. */
export function toolOutputPort(t: Pick<ToolInfo, 'outputSchema'>): PortSchema {
  if (!t.outputSchema) return { type: 'object' };
  const p = portFromJsonSchema(t.outputSchema);
  return p.type === 'object' ? p : obj({ result: p });
}

/** Write and destructive tools, and tools that always ask for confirmation, need an approval before they are called. */
export const toolNeedsApproval = (t: Pick<ToolInfo, 'sideEffect' | 'confirm'>): boolean => t.sideEffect !== 'read' || t.confirm === 'always';

/** The output a node produces, given the merged output of the steps feeding it (and, for tool steps, the tool). */
export function outputSchemaOf(n: WfNode, incoming: PortSchema, tool?: ToolInfo): PortSchema {
  const own = (): PortSchema => {
    switch (n.kind) {
      case 'trigger':
        return n.output ?? { type: 'object' };
      case 'model':
        return n.config.format === 'json' ? (n.output ?? { type: 'object' }) : obj({ text: { type: 'string' } });
      case 'transform':
        return n.output ?? obj(Object.fromEntries(Object.keys((n.config.fields as Record<string, string>) ?? {}).map((k) => [k, ANY])));
      case 'branch':
        return obj({ result: { type: 'boolean' } });
      case 'guardrail':
        return obj({ text: { type: 'string' }, action: { type: 'string' } });
      case 'approval':
        return obj({ approved: { type: 'boolean' }, by: { type: 'string' } });
      case 'http':
        return obj({ status: { type: 'integer' }, body: ANY });
      case 'calc':
        return obj({ value: { type: 'string' }, fraction: { type: 'string' }, exact: { type: 'boolean' } });
      case 'wait':
        return obj({});
      case 'tool':
        return n.output ?? (tool ? toolOutputPort(tool) : { type: 'object' });
    }
  };
  return PASS_THROUGH.includes(n.kind) ? mergeSchemas([incoming, own()]) : own();
}

/** True when a value shaped like `from` satisfies `to`. */
export function compatible(from: PortSchema, to: PortSchema, path = ''): string | null {
  if (to.type === 'any' || from.type === 'any') return null;
  if (to.type === 'number' && from.type === 'integer') return null;
  if (to.type !== from.type) return `${path || 'the value'} is ${from.type} but ${to.type} is expected`;
  if (to.type === 'array' && to.items && from.items) return compatible(from.items, to.items, `${path}[]`);
  if (to.type === 'object') {
    for (const k of to.required ?? []) {
      const f = from.properties?.[k];
      if (!f) return `${path ? path + '.' : ''}${k} is expected but not provided`;
    }
    for (const [k, t] of Object.entries(to.properties ?? {})) {
      const f = from.properties?.[k];
      if (!f) continue;
      const err = compatible(f, t, path ? `${path}.${k}` : k);
      if (err) return err;
    }
  }
  return null;
}

/** Checks a runtime value against a port schema. */
export function checkValue(v: unknown, s: PortSchema, path = ''): string | null {
  const at = path || 'the value';
  switch (s.type) {
    case 'any':
      return null;
    case 'string':
      return typeof v === 'string' ? null : `${at} should be a string`;
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? null : `${at} should be a number`;
    case 'integer':
      return Number.isInteger(v) ? null : `${at} should be an integer`;
    case 'boolean':
      return typeof v === 'boolean' ? null : `${at} should be true or false`;
    case 'array': {
      if (!Array.isArray(v)) return `${at} should be a list`;
      if (s.items) for (const [i, x] of v.entries()) {
        const e = checkValue(x, s.items, `${path}[${i}]`);
        if (e) return e;
      }
      return null;
    }
    case 'object': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return `${at} should be an object`;
      const o = v as Record<string, unknown>;
      for (const k of s.required ?? []) if (o[k] === undefined) return `${path ? path + '.' : ''}${k} is missing`;
      for (const [k, ps] of Object.entries(s.properties ?? {})) {
        if (o[k] === undefined) continue;
        const e = checkValue(o[k], ps, path ? `${path}.${k}` : k);
        if (e) return e;
      }
      return null;
    }
  }
}

/** A plausible value for a schema, used as mocked output in dry runs. */
export function sampleOf(s: PortSchema, name = 'value'): unknown {
  switch (s.type) {
    case 'string':
      return `mock ${name}`;
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return true;
    case 'array':
      return s.items ? [sampleOf(s.items, name)] : [];
    case 'object':
      return Object.fromEntries(Object.entries(s.properties ?? {}).map(([k, v]) => [k, sampleOf(v, k)]));
    default:
      return null;
  }
}

// ---------- templates ----------

const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w-]*(?:\.[\w-]+|\[\d+\])*)\s*\}\}/g;

export interface TemplateScope {
  input: unknown;
  steps: Record<string, unknown>;
}

/** Reads `input.a.b[0]` or `steps.n2.text` from the scope. */
export function readPath(scope: TemplateScope, path: string): unknown {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.');
  let cur: unknown = scope;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, p)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** A template that is a single placeholder keeps the value's type; anything else is string interpolation. */
export function render(tpl: string, scope: TemplateScope): unknown {
  const only = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/.exec(tpl);
  if (only && !tpl.slice(tpl.indexOf('}}') + 2).includes('{{')) return readPath(scope, only[1]!.trim());
  return tpl.replace(PLACEHOLDER, (_m, path: string) => {
    const v = readPath(scope, path);
    return v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  });
}

export const renderText = (tpl: string, scope: TemplateScope): string => {
  const v = render(tpl, scope);
  return v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
};

/** A URL template: every placeholder is percent-encoded, so values cannot change the host or add path segments. */
export const renderUrl = (tpl: string, scope: TemplateScope): string =>
  tpl.replace(PLACEHOLDER, (_m, path: string) => {
    const v = readPath(scope, path);
    return encodeURIComponent(v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v));
  });

/** The step ids a template reads (`steps.<id>…`) and whether it reads anything else than input/steps. */
export function references(tpl: string): { steps: string[]; bad: string[] } {
  const steps: string[] = [];
  const bad: string[] = [];
  for (const m of tpl.matchAll(PLACEHOLDER)) {
    const path = m[1]!;
    const head = path.split(/[.[]/)[0];
    if (head === 'steps') {
      const id = path.split('.')[1];
      if (id) steps.push(id.replace(/\[.*$/, ''));
      else bad.push(path);
    } else if (head !== 'input') bad.push(path);
  }
  return { steps, bad };
}

function templatesOf(n: WfNode): string[] {
  const c = n.config as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ['prompt', 'text', 'show', 'left', 'url', 'body', 'expression', 'args']) if (typeof c[k] === 'string') out.push(c[k] as string);
  for (const k of ['fields', 'args']) if (c[k] && typeof c[k] === 'object') for (const v of Object.values(c[k] as Record<string, unknown>)) if (typeof v === 'string') out.push(v);
  if (c.headers && typeof c.headers === 'object') for (const v of Object.values(c.headers as Record<string, unknown>)) if (typeof v === 'string') out.push(v);
  return out;
}

// ---------- graph helpers ----------

export const incoming = (g: WfGraph, id: string) => g.edges.filter((e) => e.to === id);
export const outgoing = (g: WfGraph, id: string) => g.edges.filter((e) => e.from === id);

/** Topological order (Kahn), or null when the graph has a cycle. Ties keep the order nodes were listed in. */
export function topoOrder(g: WfGraph): string[] | null {
  const indeg = new Map(g.nodes.map((n) => [n.id, 0]));
  for (const e of g.edges) if (indeg.has(e.to)) indeg.set(e.to, indeg.get(e.to)! + 1);
  const ready = g.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const out: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    out.push(id);
    for (const e of outgoing(g, id)) {
      const d = indeg.get(e.to)! - 1;
      indeg.set(e.to, d);
      if (d === 0) ready.push(e.to);
    }
  }
  return out.length === g.nodes.length ? out : null;
}

/** An edge that closes a cycle (a back edge in depth-first order), for the editor to highlight. */
export function backEdge(g: WfGraph): WfEdge | null {
  const state = new Map<string, 1 | 2>();
  let found: WfEdge | null = null;
  const visit = (id: string): void => {
    state.set(id, 1);
    for (const e of outgoing(g, id)) {
      if (found) return;
      const s = state.get(e.to);
      if (s === 1) found = e;
      else if (!s) visit(e.to);
    }
    state.set(id, 2);
  };
  for (const n of g.nodes) if (!state.get(n.id) && !found) visit(n.id);
  return found;
}

/**
 * True when every path from the trigger to `id` passes through an Approval step, so by the time the step runs a
 * person has approved the run on its way there.
 */
export function guardedByApproval(g: WfGraph, id: string): boolean {
  const trigger = g.nodes.find((n) => n.kind === 'trigger');
  if (!trigger) return false;
  const kind = new Map(g.nodes.map((n) => [n.id, n.kind]));
  const seen = new Set<string>([trigger.id]);
  const stack = [trigger.id];
  while (stack.length) {
    for (const e of outgoing(g, stack.pop()!)) {
      if (e.to === id) return false;
      if (seen.has(e.to) || kind.get(e.to) === 'approval') continue;
      seen.add(e.to);
      stack.push(e.to);
    }
  }
  return true;
}

/** Every node downstream of `id`, including itself. */
export function descendants(g: WfGraph, id: string): Set<string> {
  const out = new Set<string>([id]);
  const stack = [id];
  while (stack.length) {
    for (const e of outgoing(g, stack.pop()!)) {
      if (out.has(e.to)) continue;
      out.add(e.to);
      stack.push(e.to);
    }
  }
  return out;
}

export function ancestors(g: WfGraph, id: string): Set<string> {
  const out = new Set<string>();
  const stack = [id];
  while (stack.length) {
    for (const e of incoming(g, stack.pop()!)) {
      if (out.has(e.from)) continue;
      out.add(e.from);
      stack.push(e.from);
    }
  }
  return out;
}

// ---------- validation ----------

export type IssueCode = 'structure' | 'cycle' | 'config' | 'schema' | 'label' | 'limit' | 'reference' | 'unavailable' | 'unreachable';

export interface Issue {
  code: IssueCode;
  message: string;
  nodeId?: string;
  edge?: { from: string; to: string };
  /** For schema mismatches: what the step expects and what arrives. */
  expected?: PortSchema;
  actual?: PortSchema;
}

export interface ValidationEnv {
  /** The label the run's input carries. */
  label: Label;
  /** Published profiles by name: their label ceiling. Undefined when the profile does not exist or is not published. */
  profile(name: string): { label: Label } | undefined;
  /** Registry tools callable from the workflow's workspace, or why a name is not (missing: "is a draft"). */
  tool?(name: string): ToolInfo | { missing: string } | undefined;
}

export interface Validation {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  /** The label each step handles, for the editor ("Label in"). */
  labels: Record<string, Label>;
}

/** Errors that make a graph impossible to execute at all (a dry run needs none of these). */
export const BLOCKING: IssueCode[] = ['structure', 'cycle', 'config', 'reference'];

export function validateGraph(g: WfGraph, env: ValidationEnv): Validation {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const labels: Record<string, Label> = {};
  const byId = new Map<string, WfNode>();
  const title = (id: string) => byId.get(id)?.title ?? id;

  for (const n of g.nodes) {
    if (byId.has(n.id)) errors.push({ code: 'structure', nodeId: n.id, message: `Two steps share the id ${n.id}.` });
    byId.set(n.id, n);
  }
  const seen = new Set<string>();
  for (const e of g.edges) {
    const key = `${e.from}>${e.to}`;
    if (!byId.has(e.from) || !byId.has(e.to)) errors.push({ code: 'structure', edge: e, message: `An edge refers to a step that does not exist (${e.from} to ${e.to}).` });
    else if (e.from === e.to) errors.push({ code: 'cycle', nodeId: e.from, edge: e, message: `${title(e.from)} connects to itself.` });
    else if (seen.has(key)) errors.push({ code: 'structure', edge: e, nodeId: e.to, message: `${title(e.from)} is connected to ${title(e.to)} twice.` });
    seen.add(key);
  }
  const triggers = g.nodes.filter((n) => n.kind === 'trigger');
  if (triggers.length !== 1) errors.push({ code: 'structure', ...(triggers[1] ? { nodeId: triggers[1].id } : {}), message: triggers.length ? 'A workflow has exactly one trigger.' : 'Add a trigger: every workflow starts from one.' });
  for (const t of triggers) if (incoming(g, t.id).length) errors.push({ code: 'structure', nodeId: t.id, message: 'Nothing can feed into the trigger.' });

  // Limits.
  if (g.nodes.length > LIMITS.maxSteps) errors.push({ code: 'limit', message: `${g.nodes.length} steps; the limit is ${LIMITS.maxSteps}.` });
  for (const n of g.nodes) {
    const fan = outgoing(g, n.id).length;
    if (fan > LIMITS.maxFanOut) errors.push({ code: 'limit', nodeId: n.id, message: `${n.title} fans out to ${fan} steps; the limit is ${LIMITS.maxFanOut}.` });
  }
  if (g.limits.timeoutMs != null && g.limits.timeoutMs > LIMITS.maxRunTimeoutMs) errors.push({ code: 'limit', message: `The run timeout is above the limit of ${LIMITS.maxRunTimeoutMs / 3_600_000} h.` });
  if (g.limits.tokens != null && g.limits.tokens > LIMITS.maxTokens) errors.push({ code: 'limit', message: `The token budget is above the limit of ${LIMITS.maxTokens.toLocaleString('en-US')}.` });

  // Configuration of each step.
  for (const n of g.nodes) {
    const r = CONFIGS[n.kind].safeParse(n.config);
    if (!r.success) {
      const i = r.error.issues[0]!;
      errors.push({ code: 'config', nodeId: n.id, message: `${n.title}: ${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}` });
      continue;
    }
    if (n.kind === 'tool') {
      const cfg = r.data as NodeConfig<'tool'>;
      if (!cfg.tool.trim()) errors.push({ code: 'config', nodeId: n.id, message: `${n.title}: choose a published tool.` });
      if (!isRole(cfg.approverRole)) errors.push({ code: 'config', nodeId: n.id, message: `${n.title}: there is no role ${cfg.approverRole}.` });
    }
    if (n.kind === 'approval' && !isRole(String(n.config.role))) errors.push({ code: 'config', nodeId: n.id, message: `${n.title}: there is no role ${String(n.config.role)}.` });
    if (n.kind === 'guardrail' && !isRole(String((r.data as { approverRole: string }).approverRole))) errors.push({ code: 'config', nodeId: n.id, message: `${n.title}: there is no role ${String(n.config.approverRole)}.` });
    if (n.kind === 'http') {
      const u = String(n.config.url);
      let parsed: URL | null = null;
      try {
        parsed = new URL(u.replace(PLACEHOLDER, 'x'));
      } catch {
        /* reported below */
      }
      if (!parsed || !/^https?:$/.test(parsed.protocol)) errors.push({ code: 'config', nodeId: n.id, message: `${n.title}: the URL must be http:// or https://.` });
      else if (/\{\{/.test(u.split('/').slice(0, 3).join('/'))) errors.push({ code: 'config', nodeId: n.id, message: `${n.title}: the host cannot come from a template.` });
      else if (parsed.username || parsed.password) errors.push({ code: 'config', nodeId: n.id, message: `${n.title}: credentials in the URL are not allowed.` });
      if (String(n.config.method ?? 'GET') !== 'GET') warnings.push({ code: 'config', nodeId: n.id, message: `${n.title} writes to another system; a replay sends it again.` });
    }
  }

  // Acyclic.
  const order = topoOrder(g);
  if (!order) {
    const e = backEdge(g);
    errors.push({ code: 'cycle', ...(e ? { nodeId: e.from, edge: e } : {}), message: e ? `${title(e.from)} feeds back into ${title(e.to)}. Workflows must be acyclic.` : 'The graph has a cycle. Workflows must be acyclic.' });
  }

  // Branch edges.
  for (const e of g.edges) {
    const from = byId.get(e.from);
    if (!from) continue;
    if (from.kind === 'branch' && !e.branch) errors.push({ code: 'structure', nodeId: e.from, edge: e, message: `The edge from ${from.title} to ${title(e.to)} needs a branch: true or false.` });
    if (from.kind !== 'branch' && e.branch) errors.push({ code: 'structure', nodeId: e.from, edge: e, message: `Only a branch step's edges take true or false.` });
  }

  // Template references: only the run input and steps upstream.
  for (const n of g.nodes) {
    const up = ancestors(g, n.id);
    for (const t of templatesOf(n)) {
      const ref = references(t);
      for (const b of ref.bad) errors.push({ code: 'reference', nodeId: n.id, message: `${n.title}: {{${b}}} is not input.… or steps.….` });
      for (const s of ref.steps) {
        if (!byId.has(s)) errors.push({ code: 'reference', nodeId: n.id, message: `${n.title} reads steps.${s}, which does not exist.` });
        else if (!up.has(s)) errors.push({ code: 'reference', nodeId: n.id, message: `${n.title} reads ${title(s)}, which does not run before it.` });
      }
    }
  }

  if (order && triggers.length === 1) {
    const reach = descendants(g, triggers[0]!.id);
    for (const n of g.nodes) if (!reach.has(n.id)) errors.push({ code: 'unreachable', nodeId: n.id, message: `${n.title} is not connected to the trigger, so it never runs.` });

    // Port schemas along every edge, and labels along every path.
    const outs = new Map<string, PortSchema>();
    for (const id of order) {
      const n = byId.get(id)!;
      const preds = incoming(g, id);
      const merged = mergeSchemas(preds.map((e) => outs.get(e.from) ?? { type: 'object' }));
      if (n.input && preds.length) {
        const err = compatible(merged, n.input);
        if (err) {
          const single = preds.length === 1 ? preds[0] : undefined;
          errors.push({ code: 'schema', nodeId: id, ...(single ? { edge: { from: single.from, to: single.to } } : {}), message: `Schema mismatch at ${n.title}: ${err}.`, expected: n.input, actual: merged });
        }
      }
      const tool = n.kind === 'tool' ? checkToolStep(g, n, merged, preds, env, errors, warnings) : undefined;
      outs.set(id, outputSchemaOf(n, merged, tool));

      const label = highest(env.label, ...preds.map((e) => labels[e.from] ?? env.label), ...(n.raises ? [n.raises] : []));
      let ceiling: Label | undefined = n.ceiling;
      if (tool) ceiling = ceiling && labelRank(ceiling) < labelRank(tool.label) ? ceiling : tool.label;
      if (n.kind === 'model' && typeof n.config.profile === 'string') {
        const p = env.profile(n.config.profile);
        if (!p) errors.push({ code: 'config', nodeId: id, message: `${n.title}: profile ${n.config.profile} is not published.` });
        else ceiling = ceiling && labelRank(ceiling) < labelRank(p.label) ? ceiling : p.label;
      }
      if (ceiling && labelRank(label) > labelRank(ceiling)) {
        errors.push({ code: 'label', nodeId: id, message: `Blocked by label ceiling: ${n.title} has ceiling ${ceiling}; the data arriving is ${label}.` });
      }
      labels[id] = label;
    }
  }

  return { ok: errors.length === 0, errors, warnings, labels };
}

/**
 * A tool step against the registry: the tool is published and in the workflow's workspace, it is not itself a
 * workflow, the arguments it receives fit its input schema, and a write or destructive tool is either behind an
 * Approval step on every path or pauses for one (a warning). Returns the tool when it can be called.
 */
function checkToolStep(g: WfGraph, n: WfNode, merged: PortSchema, preds: WfEdge[], env: ValidationEnv, errors: Issue[], warnings: Issue[]): ToolInfo | undefined {
  const cfg = CONFIGS.tool.safeParse(n.config);
  if (!cfg.success || !cfg.data.tool.trim()) return undefined;
  const name = cfg.data.tool.trim();
  const t = env.tool?.(name);
  if (!t || 'missing' in t) {
    errors.push({ code: 'unavailable', nodeId: n.id, message: `${n.title}: ${name} ${t ? t.missing : 'is not in the registry'}.` });
    return undefined;
  }
  if (t.impl === 'workflow') {
    errors.push({ code: 'config', nodeId: n.id, message: `${n.title}: ${name} is a workflow published as a tool; a workflow cannot call another workflow.` });
    return undefined;
  }
  const args = cfg.data.args;
  // A string template is only known at run time, where the dispatcher checks the arguments against the schema.
  const given = args === undefined ? merged : typeof args === 'string' ? null : obj(Object.fromEntries(Object.keys(args).map((k) => [k, ANY])));
  if (given) {
    const expected = portFromJsonSchema(t.inputSchema ?? { type: 'object' });
    const err = compatible(given, expected);
    const single = args === undefined && preds.length === 1 ? preds[0] : undefined;
    if (err) errors.push({ code: 'schema', nodeId: n.id, ...(single ? { edge: { from: single.from, to: single.to } } : {}), message: `Schema mismatch at ${n.title}: ${err} (the input schema of ${name}).`, expected, actual: given });
  }
  if (toolNeedsApproval(t) && !guardedByApproval(g, n.id)) {
    warnings.push({ code: 'config', nodeId: n.id, message: `${n.title} calls ${name}, a ${t.sideEffect} tool${t.sideEffect === 'read' ? ' that asks for confirmation' : ''}: no Approval step comes before it on every path, so the run pauses for the ${cfg.data.approverRole} role before the call.` });
  }
  return t;
}

/** A new workflow: just a manual trigger. */
export const emptyGraph = (): WfGraph => ({ nodes: [{ id: 'trigger', kind: 'trigger', title: 'Trigger: manual', x: 20, y: 24, config: { source: 'manual' } }], edges: [], limits: {} });
