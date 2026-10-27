import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { clears, labelRank, type Label } from '../authz/labels.js';
import { isRole } from '../authz/permissions.js';
import type { Principal } from '../authz/policy.js';
import { workspacesFor } from '../http/middleware.js';
import { HttpProblem, badRequest, conflict, notFound } from '../http/problem.js';
import { treeDepth, treeLeaves, treeSchema, type Tree } from '../platform/condition-tree.js';
import { flagKey } from '../flags/model.js';
import type { Services } from '../services.js';
import { nextCron, parseCron } from '../training/calendar.js';
import { CONFIGS, graphSchema, type WfEdge, type WfGraph, type WfNode } from '../workflows/graph.js';
import { literalSecretIssue } from '../workflows/http-secrets.js';
import { generate, ModelUnavailable, parseJsonObject } from './ai.js';
import { nameSchema, type EntityDefinition } from './schema.js';
import type { Actor, AppRow, AppService, EntityRow } from './service.js';
import { RECORD_EVENTS } from './triggers.js';
import { AppFlowHooks } from './flow-hooks.js';
import { httpHostOf, integrationProblems, MESSAGE_TOOL, palette, webhookInput } from './flow-integrations.js';

export { httpHostOf, MESSAGE_TOOL };

/*
 * App flows (the exprsn-platform low-code port, docs/decisions/lowcode-port.md). A flow is an app's automation as the
 * canvas edits it: a trigger (record events, a schedule, or manual), an optional condition tree (`all`, `any`, `none`
 * groups of `{field, op, value}` leaves) and an ordered list of actions, each with its own optional condition, an
 * error policy and retries.
 *
 * A flow is not a second engine. It is compiled (`compileFlow`) into an ordinary Workflows graph, saved as the draft
 * of the workflow the flow owns and published as its next version, and its trigger is one of the app's own triggers
 * (`apps/triggers.ts`). Runs, labels, approvals, retries, failure edges, owner checks and chain limits are therefore
 * the Workflows ones. `app_flows` keeps the model and the workflow draft revision the flow last wrote, so a workflow
 * edited on the Workflows screen is noticed instead of being overwritten silently.
 */

// ---------- the model ----------

export const LEAF_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'not_contains', 'exists', 'not_exists', 'truthy', 'falsy', 'in', 'not_in'] as const;
export type LeafOp = (typeof LEAF_OPS)[number];
const NO_VALUE: LeafOp[] = ['exists', 'not_exists', 'truthy', 'falsy'];
const LIST_VALUE: LeafOp[] = ['in', 'not_in'];
/** Names a condition may test besides the entity's fields. */
export const SYSTEM_NAMES = ['state', 'label', 'event', 'from', 'to'] as const;

const scalar = z.union([z.string().max(500), z.number().finite(), z.boolean()]);
export interface Leaf {
  field: string;
  op: LeafOp;
  /** 1.9.0 (B-169): a feature flag test (`field` is then `flag`): the flag's value for the run's tenant, workspace and owner. */
  flag?: string | undefined;
  value?: string | number | boolean | (string | number | boolean)[] | undefined;
}
/** The tree shape is shared with guardrail rules (B-157): `platform/condition-tree.ts`. */
export type Condition = Tree<Leaf>;

const leafSchema = z
  .object({ field: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/, 'a field name or state, label, event, from, to'), op: z.enum(LEAF_OPS), value: z.union([scalar, z.array(scalar).max(20)]).optional(), flag: flagKey.optional() })
  .strict()
  .refine((l) => l.flag === undefined || l.field === 'flag', 'a feature flag test has field flag');
export const conditionSchema: z.ZodType<Condition> = treeSchema(leafSchema, 20);

const template = z.string().max(5000);
const propName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const values = z.record(propName, template).refine((v) => Object.keys(v).length <= 50, 'at most 50 values');
const args = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/, 'argument names are letters, digits and _'), template).refine((v) => Object.keys(v).length <= 50, 'at most 50 arguments');
const common = {
  title: z.string().trim().min(1).max(100).optional(),
  /** Runs the action only when this matches; otherwise the flow goes on with the next action. */
  when: conditionSchema.nullable().optional(),
  /** `continue`: a failure (after the retries) is recorded and the flow goes on; `stop` fails the run. */
  onError: z.enum(['stop', 'continue']).default('stop'),
  retries: z.number().int().min(0).max(3).default(0)
};
export const flowActionSchema = z.discriminatedUnion('type', [
  z.object({ ...common, type: z.literal('create'), entity: nameSchema, values }).strict(),
  z.object({ ...common, type: z.literal('update'), entity: nameSchema.optional(), record: template.max(200).optional(), values }).strict(),
  z.object({ ...common, type: z.literal('transition'), entity: nameSchema.optional(), record: template.max(200).optional(), to: z.string().regex(/^[a-z][a-z0-9_-]{0,59}$/) }).strict(),
  z.object({ ...common, type: z.literal('notify'), users: z.array(template.max(200)).max(20).default([]), roles: z.array(z.string().min(1).max(63)).max(10).default([]), title: template.min(1).max(1000), body: template.default('') }).strict(),
  z.object({ ...common, type: z.literal('approval'), role: z.string().min(1).max(63), show: template.default(''), timeoutHours: z.number().int().min(1).max(168).default(24) }).strict(),
  z.object({ ...common, type: z.literal('wait'), minutes: z.number().int().min(1).max(10_080) }).strict(),
  // Integration actions (migration 082_app_flow_integration): each compiles onto an existing workflow step kind, with
  // that step's publish checks and run-time guards (see actionNode and `integrationProblems`).
  /** A registry tool through the dispatcher (a `tool` step). A write tool needs an approval action before it. */
  z.object({ ...common, type: z.literal('tool'), tool: z.string().trim().min(1).max(200), args: args.default({}) }).strict(),
  /** A tenant script's reviewed or tested version (a `script` step). */
  z.object({ ...common, type: z.literal('script'), script: z.string().trim().min(1).max(200), version: z.number().int().min(1).optional(), args: args.default({}) }).strict(),
  /** A published registry agent (an `agent` step); `input` is its task. */
  z.object({ ...common, type: z.literal('agent'), agent: z.string().trim().min(1).max(200), input: template.min(1) }).strict(),
  /** A model call through a published profile (a `model` step); its answer is `{{steps.actN.text}}` or the JSON object. */
  z.object({ ...common, type: z.literal('ai'), profile: z.string().trim().min(1).max(63), prompt: template.min(1), format: z.enum(['text', 'json']).default('text') }).strict(),
  /** A direct message to a person, or into a conversation (a group), through the built-in `messages.send` tool. */
  z.object({ ...common, type: z.literal('message'), user: template.max(200).optional(), conversation: template.max(200).optional(), body: template.min(1) }).strict(),
  /** An HTTP request to a host on the tenant's list of allowed hosts (an `http` step); credentials are vault references. */
  z
    .object({
      ...common,
      type: z.literal('http'),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
      url: z.string().trim().min(1).max(2000),
      headers: z.record(z.string().min(1).max(100), z.string().max(1000)).refine((h) => Object.keys(h).length <= 20, 'at most 20 headers').default({}),
      query: z.record(z.string().min(1).max(100), z.string().max(1000)).refine((q) => Object.keys(q).length <= 50, 'at most 50 query parameters').optional(),
      body: template.optional()
    })
    .strict(),
  /**
   * Sprint 46 (B-131): a published decision table (a `decision` step); `inputs` maps its input columns to templates
   * (left out: the record's fields of the same names), its outputs are `{{steps.actN.<output>}}` and `matched`.
   */
  z.object({ ...common, type: z.literal('decision'), table: z.string().trim().min(1).max(200), version: z.number().int().min(1).optional(), inputs: args.default({}), noMatch: z.enum(['continue', 'fail']).default('continue') }).strict()
]);
/** The action types that compile onto an integration step (anything but record, notice, approval and wait). */
export const INTEGRATION_ACTIONS = ['tool', 'script', 'agent', 'ai', 'message', 'http', 'decision'] as const;

export type FlowAction = z.infer<typeof flowActionSchema>;

export const flowTriggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('record'), events: z.array(z.enum(RECORD_EVENTS as [string, ...string[]])).min(1).max(4) }).strict(),
  z.object({ kind: z.literal('schedule'), cron: z.string().trim().min(9).max(120) }).strict(),
  z.object({ kind: z.literal('manual') }).strict(),
  /** An incoming webhook (`/hooks/apps/<tenant>/<flow>`): signed POSTs start the flow; off until it is turned on. */
  z.object({ kind: z.literal('webhook') }).strict()
]);

export const flowInputSchema = z
  .object({
    name: nameSchema,
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    entity: nameSchema,
    trigger: flowTriggerSchema,
    enabled: z.boolean().default(true),
    match: conditionSchema.nullable().default(null),
    actions: z.array(flowActionSchema).min(1).max(12)
  })
  .strict();
export type FlowInput = z.infer<typeof flowInputSchema>;
/** A change: everything but the name, plus the overwrite of a workflow edited on the Workflows screen. */
export const flowUpdateSchema = flowInputSchema.omit({ name: true }).extend({ force: z.boolean().default(false) }).strict();

const MAX_MATCH_LEAVES = 15;
const MAX_WHEN_LEAVES = 5;
const MAX_DEPTH = 4;

// ---------- checks ----------

const leaves = (c: Condition): Leaf[] => treeLeaves(c);
const depth = (c: Condition): number => treeDepth(c);

const fieldsOf = (def: EntityDefinition) => def.fields;
const writable = (def: EntityDefinition) => new Set(fieldsOf(def).filter((f) => f.type !== 'formula' && f.type !== 'ai').map((f) => f.name));

function conditionProblems(c: Condition | null | undefined, where: string, entity: EntityRow, maxLeaves: number, record: boolean): string[] {
  if (!c) return [];
  const out: string[] = [];
  const ls = leaves(c);
  if (ls.length > maxLeaves) out.push(`${where}: at most ${maxLeaves} comparisons (it has ${ls.length}).`);
  if (depth(c) > MAX_DEPTH) out.push(`${where}: groups nest at most ${MAX_DEPTH} deep.`);
  const names = new Set(fieldsOf(entity.definition).map((f) => f.name));
  for (const l of ls) {
    const system = (SYSTEM_NAMES as readonly string[]).includes(l.field);
    if (l.flag !== undefined) {
      // A feature flag test needs no record (B-169).
    } else if (!system && !names.has(l.field)) out.push(`${where}: ${l.field} is not a field of ${entity.name}.`);
    else if (!record && l.field !== 'event') out.push(`${where}: a ${l.field} test needs a record; only a record flow has one.`);
    if (l.field === 'state' && !entity.definition.states) out.push(`${where}: ${entity.name} has no state machine.`);
    if (NO_VALUE.includes(l.op)) {
      if (l.value !== undefined) out.push(`${where}: ${l.field} ${l.op} takes no value.`);
    } else if (LIST_VALUE.includes(l.op)) {
      if (!Array.isArray(l.value) || !l.value.length) out.push(`${where}: ${l.field} ${l.op} takes a list of values.`);
    } else if (l.value === undefined || Array.isArray(l.value)) out.push(`${where}: ${l.field} ${l.op} takes one value.`);
  }
  return out;
}

/** Every problem with a flow in its app; empty when it can be compiled. */
export function flowProblems(input: Pick<FlowInput, 'entity' | 'trigger' | 'match' | 'actions'>, entities: EntityRow[], tenantId?: string): string[] {
  const out: string[] = [];
  const byName = new Map(entities.map((e) => [e.name, e]));
  const entity = byName.get(input.entity);
  if (!entity) return [`entity: ${input.entity} is not an entity of this app.`];
  const record = input.trigger.kind === 'record';
  if (input.trigger.kind === 'schedule') {
    try {
      parseCron(input.trigger.cron);
      if (nextCron(input.trigger.cron, Date.now()) == null) out.push('trigger: this cron expression never matches within a year.');
    } catch (err) {
      out.push(`trigger: the schedule is not a valid cron expression: ${(err as Error).message}`);
    }
  }
  out.push(...conditionProblems(input.match, 'condition', entity, MAX_MATCH_LEAVES, record));
  input.actions.forEach((a, i) => {
    const where = `action ${i + 1} (${a.type})`;
    out.push(...conditionProblems(a.when, `${where}, run condition`, entity, MAX_WHEN_LEAVES, record));
    if (a.type === 'create' || a.type === 'update' || a.type === 'transition') {
      const target = byName.get(a.entity ?? input.entity);
      if (!target) {
        out.push(`${where}: ${a.entity} is not an entity of this app.`);
        return;
      }
      if (a.type !== 'create' && !a.record && (!record || target.id !== entity.id)) out.push(`${where}: name the record (a template such as {{input.record.id}}); only the flow's own record is the default.`);
      if (a.type !== 'create' && !a.record && record && input.trigger.kind === 'record' && input.trigger.events.length === 1 && input.trigger.events[0] === 'deleted') out.push(`${where}: the record is deleted when this flow runs.`);
      if (a.type === 'transition') {
        const sm = target.definition.states;
        if (!sm) out.push(`${where}: ${target.name} has no state machine.`);
        else if (!sm.states.some((s) => s.name === a.to)) out.push(`${where}: ${a.to} is not a state of ${target.name}.`);
      } else {
        const ok = writable(target.definition);
        if (!Object.keys(a.values).length) out.push(`${where}: set at least one field.`);
        for (const k of Object.keys(a.values)) if (!ok.has(k)) out.push(`${where}: ${k} is not a field of ${target.name} that can be written.`);
      }
    }
    if (a.type === 'notify') {
      if (!a.users.length && !a.roles.length) out.push(`${where}: name at least one recipient: users or roles.`);
      for (const r of a.roles) if (!isRole(r, tenantId)) out.push(`${where}: there is no role ${r}.`);
    }
    if (a.type === 'approval' && !isRole(a.role, tenantId)) out.push(`${where}: there is no role ${a.role}.`);
    if (a.retries && (a.type === 'approval' || a.type === 'wait')) out.push(`${where}: an ${a.type} step is not retried.`);
    if (a.type === 'approval' && a.onError === 'continue') out.push(`${where}: an approval does not go on after a failure; a refused or expired approval ends the run.`);
    if (a.type === 'message' && !!a.user === !!a.conversation) out.push(`${where}: send to one person (user) or into one conversation, not both and not neither.`);
    if (a.type === 'http') out.push(...httpProblems(a, where));
    // Outputs of earlier actions are {{steps.act<N>…}}; a template may read only actions that run before it.
    for (const t of actionTemplates(a)) {
      for (const m of t.matchAll(/\{\{\s*steps\.([A-Za-z0-9_-]+)/g)) {
        const ref = /^act(\d+)(-failed)?$/.exec(m[1]!);
        if (!ref) out.push(`${where}: {{steps.${m[1]}}} is not an action of this flow; earlier actions are steps.act1, steps.act2 and so on.`);
        else if (Number(ref[1]) >= i + 1) out.push(`${where}: reads action ${ref[1]}, which does not run before it.`);
      }
    }
  });
  return out;
}

/** Every template an action reads (for the reference check). */
export function actionTemplates(a: FlowAction): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (v && typeof v === 'object') for (const x of Object.values(v as Record<string, unknown>)) if (typeof x === 'string') out.push(x);
  };
  for (const k of ['values', 'record', 'users', 'title', 'body', 'show', 'args', 'input', 'prompt', 'user', 'conversation', 'url', 'headers', 'query', 'inputs']) add((a as Record<string, unknown>)[k]);
  return out;
}

/** The `http` step configuration an HTTP action compiles to. */
export function httpConfigOf(a: Extract<FlowAction, { type: 'http' }>): Record<string, unknown> {
  return { method: a.method, url: a.url, headers: a.headers, ...(a.query ? { query: a.query } : {}), ...(a.body !== undefined ? { body: a.body } : {}) };
}


/** The HTTP step's own checks, in the flow's words: scheme, a fixed host, no credentials in the URL, no literal secret. */
function httpProblems(a: Extract<FlowAction, { type: 'http' }>, where: string): string[] {
  const out: string[] = [];
  const cfg = httpConfigOf(a);
  const r = CONFIGS.http.safeParse(cfg);
  if (!r.success) out.push(`${where}: ${r.error.issues[0]!.path.join('.')}${r.error.issues[0]!.path.length ? ': ' : ''}${r.error.issues[0]!.message}`);
  let parsed: URL | null = null;
  try {
    parsed = new URL(a.url.replace(/\{\{[^}]*\}\}/g, 'x'));
  } catch {
    /* reported below */
  }
  if (!parsed || !/^https?:$/.test(parsed.protocol)) out.push(`${where}: the URL must be http:// or https://.`);
  else if (/\{\{/.test(a.url.split('/').slice(0, 3).join('/'))) out.push(`${where}: the host cannot come from a template.`);
  else if (parsed.username || parsed.password) out.push(`${where}: credentials in the URL are not allowed; use a vault reference in a header or query parameter.`);
  const literal = literalSecretIssue({ nodes: [{ kind: 'http', title: where, config: cfg }] });
  if (literal) out.push(literal.message);
  return out;
}

// ---------- compiling into a Workflows graph ----------

/** The template a comparison reads: a field of the triggering record, or a name of the event. */
export function leftOf(field: string): string {
  switch (field) {
    case 'state':
      return '{{input.record.state}}';
    case 'label':
      return '{{input.record.label}}';
    case 'event':
      return '{{input.event}}';
    case 'from':
      return '{{input.from}}';
    case 'to':
      return '{{input.to}}';
    default:
      return `{{input.record.values.${field}}}`;
  }
}

const BRANCH_OP: Record<Exclude<LeafOp, 'in' | 'not_in'>, { op: string; negate: boolean }> = {
  eq: { op: 'eq', negate: false },
  ne: { op: 'ne', negate: false },
  gt: { op: 'gt', negate: false },
  gte: { op: 'gte', negate: false },
  lt: { op: 'lt', negate: false },
  lte: { op: 'lte', negate: false },
  contains: { op: 'contains', negate: false },
  not_contains: { op: 'contains', negate: true },
  exists: { op: 'exists', negate: false },
  not_exists: { op: 'exists', negate: true },
  truthy: { op: 'truthy', negate: false },
  falsy: { op: 'truthy', negate: true }
};

const OP_TEXT: Record<LeafOp, string> = { eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤', contains: 'contains', not_contains: 'does not contain', exists: 'is set', not_exists: 'is not set', truthy: 'is true', falsy: 'is false', in: 'is one of', not_in: 'is none of' };
export const leafText = (l: Leaf): string => `${l.flag !== undefined ? `flag ${l.flag}` : l.field} ${OP_TEXT[l.op]}${l.value === undefined ? '' : ` ${Array.isArray(l.value) ? l.value.join(', ') : String(l.value)}`}`;

class Builder {
  readonly nodes: WfNode[] = [];
  readonly edges: WfEdge[] = [];
  private branches = 0;
  add(n: Omit<WfNode, 'x' | 'y'>): string {
    this.nodes.push({ x: 20, y: 20, ...n } as WfNode);
    return n.id;
  }
  edge(from: string, to: string | null, branch?: 'true' | 'false' | 'failure'): void {
    if (to) this.edges.push({ from, to, ...(branch ? { branch } : {}) });
  }
  branchId(): string {
    return `if${++this.branches}`;
  }
}

/**
 * Compiles a condition into branch steps. `t` and `f` are where the flow goes when it matches and when it does not
 * (null: the run ends there); the result is the step to enter, which is `t` itself when nothing needs testing. Every
 * path through the steps is decided by one comparison at a time, so exactly one of `t` and `f` is reached, which is
 * how the engine joins: a step runs when one of the steps feeding it passed on the edge that leads to it.
 */
function compileCondition(b: Builder, c: Condition, t: string | null, f: string | null): string | null {
  if (t === f) return t;
  if ('all' in c) return c.all.reduceRight<string | null>((next, x) => compileCondition(b, x, next, f), t);
  if ('any' in c) return c.any.reduceRight<string | null>((next, x) => compileCondition(b, x, t, next), f);
  if ('none' in c) return c.none.reduceRight<string | null>((next, x) => compileCondition(b, x, f, next), t);
  if (c.op === 'in' || c.op === 'not_in') {
    const list = (Array.isArray(c.value) ? c.value : [c.value ?? '']).map((v): Condition => ({ field: c.field, op: 'eq', value: v, ...(c.flag !== undefined ? { flag: c.flag } : {}) }));
    return compileCondition(b, c.op === 'in' ? { any: list } : { none: list }, t, f);
  }
  const m = BRANCH_OP[c.op];
  const right = Array.isArray(c.value) ? null : c.value;
  const id = b.add({ id: b.branchId(), kind: 'branch', title: leafText(c).slice(0, 100), config: { ...(c.flag !== undefined ? { flag: c.flag } : { left: leftOf(c.field) }), op: m.op, ...(NO_VALUE.includes(c.op) ? {} : { right: right ?? null }) } });
  b.edge(id, m.negate ? f : t, 'true');
  b.edge(id, m.negate ? t : f, 'false');
  return id;
}

function actionTitle(a: FlowAction, flowEntity: string): string {
  if (a.title) return a.title;
  switch (a.type) {
    case 'create':
      return `Create ${a.entity}`;
    case 'update':
      return `Update ${a.entity ?? flowEntity}`;
    case 'transition':
      return `Move ${a.entity ?? flowEntity} to ${a.to}`;
    case 'notify':
      return 'Notify';
    case 'approval':
      return `Approval by ${a.role}`;
    case 'wait':
      return `Wait ${a.minutes} min`;
    case 'tool':
      return `Run ${a.tool}`;
    case 'script':
      return `Run script ${a.script}`;
    case 'agent':
      return `Ask ${a.agent}`;
    case 'ai':
      return `AI step (${a.profile})`;
    case 'message':
      return a.user ? 'Message a person' : 'Message a conversation';
    case 'http':
      return `${a.method} ${httpHostOf(a.url) ?? 'request'}`;
    case 'decision':
      return `Decide with ${a.table}`;
  }
}

function actionNode(a: FlowAction, id: string, app: AppRow, flowEntity: string): Omit<WfNode, 'x' | 'y'> {
  const title = actionTitle(a, flowEntity).slice(0, 100);
  const retry = a.retries ? { retry: { max: a.retries, delayMs: 5000, backoff: 'exponential' as const } } : {};
  const recordRef = (r: string | undefined) => r ?? '{{input.record.id}}';
  switch (a.type) {
    case 'create':
      return { id, kind: 'record', title, config: { action: 'create', app: app.id, entity: a.entity, values: a.values }, ...retry };
    case 'update':
      return { id, kind: 'record', title, config: { action: 'update', app: app.id, entity: a.entity ?? flowEntity, record: recordRef(a.record), values: a.values }, ...retry };
    case 'transition':
      return { id, kind: 'record', title, config: { action: 'transition', app: app.id, entity: a.entity ?? flowEntity, record: recordRef(a.record), to: a.to, values: {} }, ...retry };
    case 'notify':
      return { id, kind: 'notify', title, config: { users: a.users, roles: a.roles, title: a.title, body: a.body, email: false, route: `apps?app=${app.name}` }, ...retry };
    case 'approval':
      return { id, kind: 'approval', title, config: { role: a.role, timeoutMs: a.timeoutHours * 3_600_000, show: a.show } };
    case 'wait':
      return { id, kind: 'wait', title, config: { ms: a.minutes * 60_000 } };
    case 'tool':
      return { id, kind: 'tool', title, config: { tool: a.tool, args: a.args, approverRole: 'workflow-admin' }, ...retry };
    case 'script':
      return { id, kind: 'script', title, config: { script: a.script, ...(a.version ? { version: a.version } : {}), args: a.args }, ...retry };
    case 'agent':
      return { id, kind: 'agent', title, config: { agent: a.agent, input: a.input }, ...retry };
    case 'ai':
      return { id, kind: 'model', title, config: { profile: a.profile, prompt: a.prompt, format: a.format }, ...retry };
    case 'message':
      return { id, kind: 'tool', title, config: { tool: MESSAGE_TOOL, args: { body: a.body, ...(a.user ? { user: a.user } : { conversation: a.conversation! }) }, approverRole: 'workflow-admin' }, ...retry };
    case 'http':
      return { id, kind: 'http', title, config: httpConfigOf(a), ...retry };
    case 'decision':
      return { id, kind: 'decision', title, config: { table: a.table, ...(a.version ? { version: a.version } : {}), ...(Object.keys(a.inputs).length ? { inputs: a.inputs } : { source: '{{input.record.values}}' }), noMatch: a.noMatch }, ...retry };
  }
}

/** Lays the steps out left to right by their longest distance from the trigger. */
function layout(g: { nodes: WfNode[]; edges: WfEdge[] }): void {
  const level = new Map<string, number>([['trigger', 0]]);
  for (let pass = 0; pass < g.nodes.length; pass++) {
    let changed = false;
    for (const e of g.edges) {
      const from = level.get(e.from);
      if (from == null) continue;
      if ((level.get(e.to) ?? -1) < from + 1) {
        level.set(e.to, from + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const rows = new Map<number, number>();
  for (const n of g.nodes) {
    const l = level.get(n.id) ?? 0;
    const row = rows.get(l) ?? 0;
    rows.set(l, row + 1);
    n.x = Math.min(20 + l * 240, 19_000);
    n.y = Math.min(20 + row * 130, 19_000);
  }
}

/** The Workflows graph a flow runs as. The model must have passed `flowProblems`. */
export function compileFlow(app: AppRow, input: Pick<FlowInput, 'entity' | 'trigger' | 'match' | 'actions'>): WfGraph {
  const b = new Builder();
  // A webhook flow is started from outside, by the signed hook route, as a run through the API would be.
  const source = input.trigger.kind === 'record' ? 'record' : input.trigger.kind === 'schedule' ? 'schedule' : input.trigger.kind === 'webhook' ? 'api' : 'manual';
  const triggerTitle = input.trigger.kind === 'record' ? `When ${input.entity} is ${input.trigger.events.join(' or ')}` : input.trigger.kind === 'schedule' ? `On schedule ${input.trigger.cron}` : input.trigger.kind === 'webhook' ? 'On a signed webhook' : 'Started by hand';
  b.add({ id: 'trigger', kind: 'trigger', title: triggerTitle.slice(0, 100), config: { source } });
  let next: string | null = null;
  for (let i = input.actions.length - 1; i >= 0; i--) {
    const a = input.actions[i]!;
    const id = `act${i + 1}`;
    b.add(actionNode(a, id, app, input.entity));
    b.edge(id, next);
    if (a.onError === 'continue') {
      const err = b.add({ id: `${id}-failed`, kind: 'transform', title: `${actionTitle(a, input.entity)} failed`.slice(0, 100), config: { fields: { failedStep: id, error: `{{steps.${id}.error}}` } } });
      b.edge(id, err, 'failure');
      b.edge(err, next);
    }
    next = a.when ? compileCondition(b, a.when, id, next) : id;
  }
  const entry = input.match ? compileCondition(b, input.match, next, null) : next;
  b.edge('trigger', entry);
  const g = { nodes: b.nodes, edges: b.edges };
  layout(g);
  return graphSchema.parse({ ...g, limits: {} });
}

// ---------- the service ----------

export interface FlowRow {
  id: string;
  tenant_id: string;
  app_id: string;
  entity_id: string;
  name: string;
  title: string | null;
  description: string | null;
  workflow_id: string;
  workspace_id: string | null;
  trigger_id: string | null;
  enabled: boolean;
  model: string;
  draft_rev: number;
  created_by: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
  /** Migration 082: the incoming webhook of a webhook flow, off until turned on; the secret sealed under the tenant key. */
  hook_enabled?: boolean;
  hook_secret?: string | null;
  hook_secret_at?: number | null;
  hook_owner?: string | null;
}

const flowFrom = (r: Record<string, unknown>): FlowRow => ({ ...(r as unknown as FlowRow), enabled: !!r.enabled, draft_rev: Number(r.draft_rev), created_at: Number(r.created_at), updated_at: Number(r.updated_at), hook_enabled: !!r.hook_enabled, hook_secret: (r.hook_secret as string | null | undefined) ?? null, hook_secret_at: r.hook_secret_at == null ? null : Number(r.hook_secret_at), hook_owner: (r.hook_owner as string | null | undefined) ?? null });
/** Record and schedule flows have an app trigger; manual and webhook flows have none. */
const hasAppTrigger = (t: FlowInput['trigger']): t is Extract<FlowInput['trigger'], { kind: 'record' | 'schedule' }> => t.kind === 'record' || t.kind === 'schedule';
const modelOf = (r: FlowRow): Omit<FlowInput, 'name'> => JSON.parse(r.model) as Omit<FlowInput, 'name'>;

/** The workflow a flow owns: lower-case letters, digits and hyphens, at most 63 characters. */
export const workflowNameOf = (app: string, flow: string): string => `app-${app}-${flow}`.replace(/_/g, '-').slice(0, 63).replace(/-+$/, '');

const FLOW_SYSTEM = `You design automations ("flows") for a low-code app. Answer with one JSON object and nothing else:
{"name": "lower_snake_case", "title": "Title", "entity": "<entity name>", "trigger": {"kind": "record", "events": ["created" | "updated" | "deleted" | "transitioned"]} or {"kind": "schedule", "cron": "0 9 * * 1"} or {"kind": "manual"} or {"kind": "webhook"},
 "match": null or a condition, "actions": [ ... ]}
A condition is {"all": [...]}, {"any": [...]}, {"none": [...]} or a comparison {"field": "<field name or state>", "op": one of eq, ne, gt, gte, lt, lte, contains, not_contains, exists, not_exists, truthy, falsy, in, not_in, "value": ...}. Only a record flow has a record to compare; a webhook flow's data is {{input.payload.<field>}}.
Actions: {"type": "update", "values": {"field": "text or {{input.record.values.field}}"}}, {"type": "create", "entity": "...", "values": {...}}, {"type": "transition", "to": "<state>"}, {"type": "notify", "roles": ["workflow-admin"], "title": "...", "body": "..."}, {"type": "approval", "role": "workflow-admin", "show": "..."}, {"type": "wait", "minutes": 60},
 {"type": "ai", "profile": "<profile>", "prompt": "...", "format": "text" | "json"}, {"type": "agent", "agent": "<agent>", "input": "the task"}, {"type": "tool", "tool": "<tool>", "args": {"name": "template"}}, {"type": "script", "script": "<script>", "args": {...}},
 {"type": "message", "user": "<user id template>", "body": "..."} (or "conversation" instead of "user"), {"type": "http", "method": "GET" | "POST", "url": "https://<allowed host>/path", "headers": {"Authorization": "Bearer vault:path#key"}, "body": "..."}.
Only use the profiles, agents, tools and scripts listed below. A tool or script that writes needs an approval action before it. Credentials are never written out: only vault:path#key references.
Action N's output is {{steps.actN.<field>}} in later actions: an ai step gives {{steps.actN.text}} (or the JSON fields), an agent {{steps.actN.text}}, an http request {{steps.actN.status}} and {{steps.actN.body}}, a record action {{steps.actN.id}}. Any action may have "when": a condition.`;

export class AppFlows {
  /** The incoming webhooks of webhook flows (`flow-hooks.ts`). */
  readonly hooks: AppFlowHooks;

  constructor(
    private readonly s: () => Services,
    private readonly apps: AppService
  ) {
    this.hooks = new AppFlowHooks(s, apps);
  }

  private hookView(_app: AppRow, r: FlowRow) {
    return this.hooks.view(r);
  }

  private get db() {
    return this.s().db;
  }

  private async rows(app: AppRow): Promise<FlowRow[]> {
    return ((await this.db('app_flows').where({ app_id: app.id }).orderBy('name')) as Record<string, unknown>[]).map(flowFrom);
  }

  private async row(app: AppRow, ref: string): Promise<FlowRow> {
    const r = await this.db('app_flows').where({ app_id: app.id }).andWhere((q) => q.where({ id: ref }).orWhere({ name: ref })).first();
    if (!r) throw notFound('Flow');
    return flowFrom(r);
  }

  /** The designer acting in the flow's workflow's workspace, which they must belong to. */
  private async at(p: Principal, workspaceId: string | null): Promise<Principal> {
    if (p.workspaceId === workspaceId) return p;
    if (workspaceId && !(await workspacesFor(this.s(), p)).some((w) => w.id === workspaceId)) throw new HttpProblem(403, 'Forbidden', "The flow's workflow lives in a workspace you are not a member of.", { extensions: { step: 'workspace' } });
    return { ...p, workspaceId };
  }

  private async workflowOf(p: Principal, r: FlowRow) {
    const db = this.db;
    const w = await db('workflows').where({ id: r.workflow_id, tenant_id: r.tenant_id }).first('id', 'name', 'draft_rev', 'published_version', 'label');
    if (!w) return null;
    return { id: String(w.id), name: String(w.name), draftRev: Number(w.draft_rev), publishedVersion: w.published_version == null ? null : Number(w.published_version), label: w.label as Label, visible: clears(p.clearance, w.label as Label) };
  }

  private async view(p: Principal, app: AppRow, r: FlowRow, full: boolean) {
    const m = modelOf(r);
    const w = await this.workflowOf(p, r);
    const t = r.trigger_id ? await this.db('app_triggers').where({ id: r.trigger_id }).first('last_run_at', 'last_run_id', 'last_result', 'next_run_at', 'enabled') : null;
    const entity = await this.apps.entityById(app.tenant_id, r.entity_id);
    const base = {
      id: r.id,
      name: r.name,
      title: r.title,
      description: r.description,
      entity: entity?.name ?? m.entity,
      trigger: m.trigger,
      enabled: r.enabled,
      workflowId: r.workflow_id,
      workflow: w ? { name: w.name, publishedVersion: w.publishedVersion, draftRev: w.draftRev } : null,
      /** The workflow's draft moved on since the flow last wrote it: someone edited it on the Workflows screen. */
      editedElsewhere: !!w && w.draftRev !== r.draft_rev,
      triggerId: r.trigger_id,
      lastRunAt: t?.last_run_at == null ? null : Number(t.last_run_at),
      lastRunId: (t?.last_run_id as string | null | undefined) ?? null,
      lastResult: (t?.last_result as string | null | undefined) ?? null,
      nextRunAt: t?.next_run_at == null ? null : Number(t.next_run_at),
      steps: m.actions.length,
      hook: m.trigger.kind === 'webhook' ? await this.hookView(app, r) : null,
      createdBy: r.created_by,
      updatedBy: r.updated_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    };
    if (!full) return base;
    let graph: WfGraph | null = null;
    if (w?.visible) {
      const row = await this.db('workflows').where({ id: r.workflow_id }).first('draft');
      graph = row ? graphSchema.parse(JSON.parse(String(row.draft))) : null;
    }
    return { ...base, match: m.match ?? null, actions: m.actions, graph };
  }

  async list(p: Principal, appRef: string) {
    const app = await this.apps.app(p, appRef);
    return Promise.all((await this.rows(app)).map((r) => this.view(p, app, r, false)));
  }

  async get(p: Principal, appRef: string, ref: string) {
    const app = await this.apps.app(p, appRef);
    return this.view(p, app, await this.row(app, ref), true);
  }

  /** Validates a model in its app and compiles it; 400 with every problem. */
  private async compile(p: Principal, app: AppRow, input: Pick<FlowInput, 'entity' | 'trigger' | 'match' | 'actions'>) {
    const entities = await this.apps.entities(app);
    const problems = flowProblems(input, entities, app.tenant_id);
    if (problems.length) throw new HttpProblem(400, 'Invalid flow', problems[0]!, { extensions: { problems } });
    const graph = compileFlow(app, input);
    const entity = entities.find((e) => e.name === input.entity)!;
    const more = await integrationProblems(this.s(), p, entity, input.actions, graph);
    if (more.length) throw new HttpProblem(400, 'Invalid flow', more[0]!, { extensions: { problems: more } });
    return { graph, entity };
  }

  /** What the canvas's integration actions may use here: tools, scripts, agents, and profiles cleared for the entity's label. */
  async palette(p: Principal, appRef: string, entityName?: string) {
    const app = await this.apps.app(p, appRef);
    const entities = await this.apps.entities(app);
    const entity = entities.find((e) => e.name === entityName) ?? entities[0] ?? null;
    return palette(this.s(), p, entity?.label ?? app.label);
  }

  /** Publishes the workflow's draft; a refusal names the steps, in the flow's words where it can. */
  private async publish(p: Principal, workflowId: string, actor: Actor) {
    const wf = this.s().workflows;
    const w = await wf.workflow(p, workflowId);
    try {
      const out = await wf.publish(p, workflowId, 'Published from the app flow canvas');
      await wf.audit(p, 'workflow.published', { workflow: w.id, name: w.name }, { label: w.label, detail: { version: out.version, warnings: out.warnings.length, via: 'app-flow' }, ip: actor.ip ?? null, ...(actor.traceId ? { traceId: actor.traceId } : {}) });
      return out;
    } catch (err) {
      await wf.audit(p, 'workflow.publish.refused', { workflow: w.id, name: w.name }, { label: w.label, detail: { detail: (err as Error).message.slice(0, 300), via: 'app-flow' }, ip: actor.ip ?? null, ...(actor.traceId ? { traceId: actor.traceId } : {}) });
      throw err;
    }
  }

  private triggerInput(m: Pick<FlowInput, 'entity' | 'trigger' | 'enabled'>, workflowId: string) {
    // Only called for record and schedule flows (hasAppTrigger).
    return m.trigger.kind === 'record' ? { entity: m.entity, kind: 'record' as const, events: m.trigger.events as ('created' | 'updated' | 'deleted' | 'transitioned')[], workflow: workflowId, enabled: m.enabled } : { entity: m.entity, kind: 'schedule' as const, cron: (m.trigger as { cron: string }).cron, workflow: workflowId, enabled: m.enabled };
  }

  async create(actor: Actor & { principal: Principal }, appRef: string, input: FlowInput) {
    const p = actor.principal;
    const app = await this.apps.designable(p, appRef);
    if (await this.db('app_flows').where({ app_id: app.id, name: input.name }).first('id')) throw conflict(`A flow named ${input.name} exists in this app.`);
    const { graph, entity } = await this.compile(p, app, input);
    const wf = this.s().workflows;
    const name = workflowNameOf(app.name, input.name);
    const description = `Flow ${input.name} of the app ${app.title || app.name}, edited on Apps.`.slice(0, 500);
    // The workflow handles data at the entity's label: a run carrying more could not write its records, and records
    // labelled above it are skipped by the trigger (audited), as for any app trigger.
    const w = await wf.create(p, { name, description, label: entity.label, graph });
    const audit = { ip: actor.ip ?? null, ...(actor.traceId ? { traceId: actor.traceId } : {}) };
    await wf.audit(p, 'workflow.created', { workflow: w.id, name: w.name }, { label: w.label, detail: { via: 'app-flow' }, ...audit });
    let triggerId: string | null = null;
    try {
      await this.publish(p, w.id, actor);
      if (hasAppTrigger(input.trigger)) triggerId = (await this.apps.triggers.create(actor, app.id, this.triggerInput(input, w.id))).id;
    } catch (err) {
      // Nothing half made: the workflow the flow would own goes again (it never ran: it has no trigger yet).
      await this.db('workflows').where({ id: w.id }).delete();
      await this.db('workflow_versions').where({ workflow_id: w.id }).delete();
      throw err;
    }
    const t = Date.now();
    const { name: flowName, ...model } = input;
    const row: FlowRow = { id: ulid(), tenant_id: app.tenant_id, app_id: app.id, entity_id: entity.id, name: flowName, title: input.title ?? null, description: input.description ?? null, workflow_id: w.id, workspace_id: w.workspace_id, trigger_id: triggerId, enabled: input.enabled, model: JSON.stringify(model), draft_rev: w.draft_rev, created_by: p.userId, updated_by: p.userId, created_at: t, updated_at: t };
    await this.db('app_flows').insert(row);
    await this.audit(actor, 'app.flow.created', { app: app.id, flow: row.id, workflow: w.id, ...(triggerId ? { trigger: triggerId } : {}) }, app.label, { name: row.name, trigger: input.trigger.kind, actions: input.actions.length, steps: graph.nodes.length });
    return this.view(p, app, row, true);
  }

  async update(actor: Actor & { principal: Principal }, appRef: string, ref: string, input: z.infer<typeof flowUpdateSchema>) {
    const app = await this.apps.designable(actor.principal, appRef);
    const r = await this.row(app, ref);
    const p = await this.at(actor.principal, r.workspace_id);
    const pa = { ...actor, principal: p };
    const { graph, entity } = await this.compile(p, app, input);
    const wf = this.s().workflows;
    const w = await wf.workflow(p, r.workflow_id);
    if (w.draft_rev !== r.draft_rev && !input.force) throw new HttpProblem(409, 'Edited on Workflows', `${w.name} was changed on the Workflows screen since this flow last saved it (revision ${w.draft_rev}, the flow wrote ${r.draft_rev}). Saving here replaces that change; confirm to overwrite.`, { extensions: { editedElsewhere: true } });
    const saved = await wf.saveDraft(p, w.id, { graph, rev: w.draft_rev, ...(input.description !== undefined ? { description: input.description } : {}) });
    await wf.audit(p, 'workflow.draft.saved', { workflow: w.id, name: w.name }, { label: saved.label, detail: { rev: saved.draftRev, steps: graph.nodes.length, edges: graph.edges.length, via: 'app-flow' }, ip: actor.ip ?? null, ...(actor.traceId ? { traceId: actor.traceId } : {}) });
    await this.publish(p, w.id, actor);
    // The trigger: changed in place while its kind and entity stay, made again otherwise.
    const before = modelOf(r);
    let triggerId = r.trigger_id;
    const same = before.trigger.kind === input.trigger.kind && r.entity_id === entity.id;
    if (triggerId && (!same || !hasAppTrigger(input.trigger))) {
      await this.apps.triggers.remove(pa, app.id, triggerId).catch((err: unknown) => {
        if (!(err instanceof HttpProblem && err.status === 404)) throw err;
      });
      triggerId = null;
    }
    if (hasAppTrigger(input.trigger)) {
      if (triggerId) await this.apps.triggers.update(pa, app.id, triggerId, { enabled: input.enabled, ...(input.trigger.kind === 'record' ? { events: input.trigger.events as ('created' | 'updated' | 'deleted' | 'transitioned')[] } : { cron: input.trigger.cron }) });
      else triggerId = (await this.apps.triggers.create(pa, app.id, this.triggerInput(input, w.id))).id;
    }
    const { force: _force, ...model } = input;
    // A flow that is no longer a webhook flow stops taking webhooks (its secret stays, for a change back).
    const upd = { entity_id: entity.id, title: input.title ?? null, description: input.description ?? r.description, trigger_id: triggerId, enabled: input.enabled, model: JSON.stringify({ ...model, entity: input.entity }), draft_rev: saved.draftRev, updated_by: p.userId, updated_at: Date.now(), ...(input.trigger.kind !== 'webhook' && r.hook_enabled ? { hook_enabled: false } : {}) };
    await this.db('app_flows').where({ id: r.id }).update(upd);
    await this.audit(actor, 'app.flow.updated', { app: app.id, flow: r.id, workflow: w.id }, app.label, { trigger: input.trigger.kind, actions: input.actions.length, steps: graph.nodes.length, overwrote: w.draft_rev !== r.draft_rev });
    return this.view(p, app, { ...r, ...upd }, true);
  }

  /** Turns the flow's trigger on or off without republishing. */
  async setEnabled(actor: Actor & { principal: Principal }, appRef: string, ref: string, enabled: boolean) {
    const app = await this.apps.designable(actor.principal, appRef);
    const r = await this.row(app, ref);
    const p = await this.at(actor.principal, r.workspace_id);
    if (r.trigger_id) await this.apps.triggers.update({ ...actor, principal: p }, app.id, r.trigger_id, { enabled });
    const model = { ...modelOf(r), enabled };
    await this.db('app_flows').where({ id: r.id }).update({ enabled, model: JSON.stringify(model), updated_by: p.userId, updated_at: Date.now() });
    await this.audit(actor, 'app.flow.updated', { app: app.id, flow: r.id, workflow: r.workflow_id }, app.label, { enabled });
    return this.view(p, app, { ...r, enabled, model: JSON.stringify(model) }, false);
  }

  /** Deletes the flow, its trigger and its workflow (refused while runs of it are in progress or waiting). */
  async remove(actor: Actor & { principal: Principal }, appRef: string, ref: string) {
    const app = await this.apps.designable(actor.principal, appRef);
    const r = await this.row(app, ref);
    const p = await this.at(actor.principal, r.workspace_id);
    const wf = this.s().workflows;
    const w = await wf.remove(p, r.workflow_id).catch((err: unknown) => {
      if (err instanceof HttpProblem && err.status === 404) return null;
      throw err;
    });
    if (w) await wf.audit(p, 'workflow.deleted', { workflow: w.id, name: w.name }, { label: w.label, detail: { via: 'app-flow' }, ip: actor.ip ?? null, ...(actor.traceId ? { traceId: actor.traceId } : {}) });
    if (r.trigger_id) await this.db('app_triggers').where({ id: r.trigger_id }).delete();
    await this.db('app_triggers').where({ app_id: app.id, workflow_id: r.workflow_id }).delete();
    await this.db('app_flows').where({ id: r.id }).delete();
    await this.db('app_flow_hook_nonces').where({ flow_id: r.id }).delete();
    await this.audit(actor, 'app.flow.deleted', { app: app.id, flow: r.id, workflow: r.workflow_id }, app.label, { name: r.name });
  }

  /**
   * A dry run of the flow's workflow draft, with the input a trigger would give it for one record (or none): record
   * steps, notices and waits are mocked, nothing is written. The caller must be able to read the record.
   */
  async test(actor: Actor & { principal: Principal }, appRef: string, ref: string, input: { record?: string | undefined; event?: string | undefined; payload?: Record<string, unknown> | undefined }) {
    const app = await this.apps.designable(actor.principal, appRef);
    const r = await this.row(app, ref);
    const p = await this.at(actor.principal, r.workspace_id);
    const m = modelOf(r);
    const entity = await this.apps.entityById(app.tenant_id, r.entity_id);
    if (!entity) throw notFound('Entity');
    let runInput: Record<string, unknown>;
    let label: Label = entity.label;
    if (m.trigger.kind === 'schedule') runInput = { event: 'schedule', app: app.name, entity: entity.name, dueAt: new Date().toISOString(), trigger: { id: r.trigger_id ?? 'test', depth: 1 } };
    else if (m.trigger.kind === 'webhook') runInput = webhookInput(app, entity, r, input.payload ?? {});
    else {
      if (!input.record) throw badRequest('Choose a record to test the flow on.');
      const row = await this.apps.readable(actor.principal, entity, input.record);
      label = row.label;
      const event = input.event ?? (m.trigger.kind === 'record' ? m.trigger.events[0] : 'manual');
      runInput = { event, app: app.name, entity: entity.name, record: { id: row.id, state: row.state, label: row.label, version: Number(row.version), values: await this.apps.open(row) }, ...(event === 'transitioned' ? { from: row.state, to: row.state } : {}), trigger: { id: r.trigger_id ?? 'test', depth: 1 } };
    }
    const run = await this.s().workflows.start(p, r.workflow_id, { input: runInput, dry: true });
    await this.audit(actor, 'app.flow.tested', { app: app.id, flow: r.id, workflow: r.workflow_id, run: run.id, ...(input.record ? { record: input.record } : {}) }, label, { mode: 'dry' });
    return { run: run.id, state: run.state, mode: run.mode };
  }

  async runs(p: Principal, appRef: string, ref: string) {
    const app = await this.apps.app(p, appRef);
    const r = await this.row(app, ref);
    const at = await this.at(p, r.workspace_id).catch(() => null);
    if (!at) return [];
    return this.s().workflows.runs(at, r.workflow_id, 20);
  }

  /** A flow drafted by a model from a description: validated like a saved one, returned with its problems, never saved. */
  async draft(actor: Actor & { principal: Principal }, appRef: string, input: { prompt: string; profile: string }) {
    const p = actor.principal;
    const app = await this.apps.designable(p, appRef);
    const s = this.s();
    const entities = await this.apps.entities(app);
    const g = await s.guardrails.check({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, checkpoint: 'user-input', text: input.prompt, label: app.label, principal: p, source: { kind: 'app-draft', id: p.userId } });
    if (g.action === 'block' || g.action === 'require-approval') throw new HttpProblem(422, 'Description refused', `The description was refused by the content rules${g.reason ? `: ${g.reason}` : '.'}`);
    const design = entities.map((e) => `${e.name} (${e.label}): ${e.definition.fields.map((f) => `${f.name} (${f.type})`).join(', ')}${e.definition.states ? `; states ${e.definition.states.states.map((x) => x.name).join(', ')}` : ''}`).join('\n');
    // What the integration actions may use here, by name only (no schemas, no secrets), cleared for the lowest label.
    const lowest = entities.reduce<Label>((acc, e) => (labelRank(e.label) < labelRank(acc) ? e.label : acc), app.label);
    const pal = await palette(s, p, lowest);
    const names = (xs: string[]) => (xs.length ? xs.slice(0, 40).join(', ') : 'none');
    const available = [`Profiles: ${names(pal.profiles.map((x) => x.name))}`, `Agents: ${names(pal.agents.map((x) => x.name))}`, `Tools: ${names(pal.tools.map((t) => `${t.name} (${t.sideEffect})`))}`, `Scripts: ${names((pal.scripts as { name: string }[]).map((x) => x.name))}`, `Messages: ${pal.messaging ? 'available' : 'not available'}`].join('\n');
    let text: string;
    try {
      text = await generate(s, { tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, profile: input.profile, system: FLOW_SYSTEM, prompt: `The app's entities:\n${design}\n\nAvailable here:\n${available}\n\nThe flow: ${g.action === 'redact' ? g.text : input.prompt}`, label: app.label, principal: p, userId: p.userId, json: true, source: { kind: 'app-draft', id: p.userId } });
    } catch (err) {
      if (err instanceof HttpProblem) throw err;
      if (err instanceof ModelUnavailable) throw new HttpProblem(503, 'Model unavailable', err.message);
      throw new HttpProblem(503, 'Model unavailable', `The model could not be reached: ${(err as Error).message}`);
    }
    const obj = parseJsonObject(text);
    const parsed = flowInputSchema.safeParse(obj);
    const problems: string[] = [];
    if (!parsed.success) problems.push(...parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || 'flow'}: ${i.message}`));
    else {
      problems.push(...flowProblems(parsed.data, entities, app.tenant_id));
      const entity = entities.find((e) => e.name === parsed.data.entity);
      if (!problems.length && entity) problems.push(...(await integrationProblems(s, p, entity, parsed.data.actions, compileFlow(app, parsed.data))));
    }
    await this.audit(actor, 'app.flow.drafted', { app: app.id, profile: input.profile }, app.label, { valid: problems.length === 0, problems: problems.length });
    return { draft: parsed.success ? parsed.data : obj, valid: problems.length === 0, problems };
  }

  private audit(actor: Actor & { principal: Principal }, action: string, target: Record<string, unknown>, label: Label, detail?: Record<string, unknown>) {
    return this.s().audit.append({ tenantId: actor.principal.tenantId, action, kind: 'admin', actor: actorFrom(actor.principal, actor.ip ?? null), target, label, ...(detail ? { detail } : {}), traceId: actor.traceId ?? null });
  }
}
