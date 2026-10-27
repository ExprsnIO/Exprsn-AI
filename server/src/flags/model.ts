import { createHash } from 'node:crypto';
import { z } from 'zod';

/*
 * 1.9.0, Sprint 52 (B-167, B-168): feature flags, the pure part. A flag has a key, a type (`boolean` for on/off,
 * `variant` for one of named strings, `number`), a default value, a description, an owner and a life cycle
 * (`planned` → `active` → `deprecated` → `removed`). Values are set at four levels, the most specific winning:
 * workspace over tenant over plan over platform, and the flag's default under them all. A value at any level may
 * reach only a percentage of the people (or workspaces, or tenants) under it: the rollout is sticky, decided by a
 * hash of the flag key and the unit's id, so a person keeps the answer they got while the percentage only grows.
 *
 * Life cycle and evaluation: a `planned` flag is not live, so it answers its default everywhere (values may be set
 * ahead and take effect once it is active); `active` and `deprecated` flags evaluate every level; a `removed` flag
 * answers its default and takes no new values. Code that asks for a flag the database does not know (or a database
 * without the tables) gets its built-in default (`BUILTIN_FLAGS`), or off/null for an undeclared key.
 */

export const FLAG_TYPES = ['boolean', 'variant', 'number'] as const;
export type FlagType = (typeof FLAG_TYPES)[number];
export const FLAG_STATES = ['planned', 'active', 'deprecated', 'removed'] as const;
export type FlagState = (typeof FLAG_STATES)[number];
export const LEVELS = ['workspace', 'tenant', 'plan', 'platform'] as const;
export type Level = (typeof LEVELS)[number];
export const ROLLOUT_BY = ['user', 'workspace', 'tenant'] as const;
export type RolloutBy = (typeof ROLLOUT_BY)[number];
export type FlagValue = boolean | number | string;

/** Which states move to which (a removed flag may come back only as deprecated, to be cleaned up again). */
export const NEXT_STATES: Record<FlagState, FlagState[]> = {
  planned: ['active', 'removed'],
  active: ['deprecated', 'removed'],
  deprecated: ['active', 'removed'],
  removed: ['deprecated']
};

/** A key: lower case letters, digits and `. _ -`, starting with a letter (it also names a plan entitlement `flag.<key>`). */
export const flagKey = z.string().regex(/^[a-z][a-z0-9._-]{1,55}$/, 'a flag key is 2 to 56 lower case letters, digits and . _ -, starting with a letter');
export const variantName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, 'a variant is lower case letters, digits, _ and -');

export const optionsSchema = z
  .object({
    variants: z.array(variantName).min(2).max(20).optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional()
  })
  .strict();
export type FlagOptions = z.infer<typeof optionsSchema>;

export interface FlagDef {
  key: string;
  type: FlagType;
  defaultValue: FlagValue;
  options: FlagOptions;
  description: string;
  owner: string;
  state: FlagState;
  stateChangedAt: number;
  reviewAt: number | null;
  client: boolean;
  overridable: boolean;
  rolloutBy: RolloutBy;
  createdBy: string | null;
  createdAt: number;
  updatedBy: string | null;
  updatedAt: number;
}

export interface LevelValue {
  id: string;
  flagKey: string;
  scope: Level;
  /** `*` for the platform, a plan key, a tenant id or a workspace id. */
  scopeId: string;
  tenantId: string | null;
  value: FlagValue;
  /** Percentage of units reached (0 to 100); null reaches everyone at the level. */
  rollout: number | null;
  note: string | null;
  updatedBy: string | null;
  updatedAt: number;
}

/** Built-in flags: what code that asks for these keys gets while the database has no row for them. */
export interface BuiltinFlag {
  key: string;
  type: FlagType;
  defaultValue: FlagValue;
  description: string;
  options?: FlagOptions;
}
export const BUILTIN_FLAGS = new Map<string, BuiltinFlag>();

/** Declares a flag code reads, with its built-in default. Declaring is idempotent; the first declaration wins. */
export function declareFlag(f: BuiltinFlag): BuiltinFlag {
  const parsed = flagKey.safeParse(f.key);
  if (!parsed.success) throw new Error(`Invalid flag key ${f.key}`);
  const err = valueProblem(f.type, f.options ?? {}, f.defaultValue);
  if (err) throw new Error(`Flag ${f.key}: ${err}`);
  if (!BUILTIN_FLAGS.has(f.key)) BUILTIN_FLAGS.set(f.key, f);
  return BUILTIN_FLAGS.get(f.key)!;
}

/** What is wrong with a value for a flag of this type and these options, or null. */
export function valueProblem(type: FlagType, options: FlagOptions, v: unknown): string | null {
  switch (type) {
    case 'boolean':
      return typeof v === 'boolean' ? null : 'an on/off flag takes true or false';
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) return 'a number flag takes a number';
      if (options.min !== undefined && v < options.min) return `at least ${options.min}`;
      if (options.max !== undefined && v > options.max) return `at most ${options.max}`;
      return null;
    case 'variant':
      if (typeof v !== 'string') return 'a variant flag takes one of its variants';
      return (options.variants ?? []).includes(v) ? null : `one of ${(options.variants ?? []).join(', ')}`;
  }
}

/** What is wrong with options for a type, or null. */
export function optionsProblem(type: FlagType, o: FlagOptions): string | null {
  if (type === 'variant') {
    if (!o.variants) return 'a variant flag names its variants (at least two)';
    if (new Set(o.variants).size !== o.variants.length) return 'variants are named once each';
    if (o.min !== undefined || o.max !== undefined) return 'only a number flag has bounds';
  } else if (type === 'number') {
    if (o.variants) return 'only a variant flag has variants';
    if (o.min !== undefined && o.max !== undefined && o.min > o.max) return 'the lower bound is above the upper one';
  } else if (o.variants || o.min !== undefined || o.max !== undefined) return 'an on/off flag has no options';
  return null;
}

/** Whether a value counts as "on": true, a number above 0, a variant other than `off`. */
export const isOn = (v: FlagValue | null | undefined): boolean => (typeof v === 'boolean' ? v : typeof v === 'number' ? v > 0 : typeof v === 'string' ? v !== '' && v !== 'off' : false);

/** The sticky bucket of a unit for a flag: 0.00 to 99.99, from SHA-256 of `<key>:<unit>`. */
export function bucketOf(key: string, unit: string): number {
  const d = createHash('sha256').update(`${key}:${unit}`, 'utf8').digest();
  return (d.readUInt32BE(0) % 10_000) / 100;
}

export const inRollout = (rollout: number | null, bucket: number): boolean => rollout === null || rollout >= 100 || bucket < rollout;

export interface EvalContext {
  tenantId: string;
  workspaceId?: string | null;
  userId?: string | null;
}

/** What the evaluator knows about one tenant: its plan, and the values at each level for one flag. */
export interface Inputs {
  def: FlagDef | null;
  builtin: BuiltinFlag | null;
  plan: { key: string; entitlements: Record<string, FlagValue> } | null;
  values: Partial<Record<Level, LevelValue>>;
}

export interface Step {
  level: Level;
  /** Whether a value is set at the level for this tenant (or its workspace, or its plan). */
  set: boolean;
  value?: FlagValue;
  rollout?: number | null;
  /** From the plan's entitlement `flag.<key>` rather than a value set on the flag. */
  fromEntitlement?: boolean;
  bucket?: number;
  reached?: boolean;
  /** Why the level did not count although set (outside the rollout, not overridable, wrong type). */
  skipped?: string;
}

export interface Evaluation {
  key: string;
  value: FlagValue | null;
  on: boolean;
  /** The winning level, `default` (the flag's own default) or `builtin` (no row: the code's default, or none). */
  level: Level | 'default' | 'builtin';
  reason: string;
  state: FlagState | null;
  steps: Step[];
  /** The unit a rollout was decided by. */
  unit: { by: RolloutBy; id: string } | null;
}

/** The unit a rollout is sticky by, falling back to the nearest one the context has. */
export function unitOf(by: RolloutBy, ctx: EvalContext): { by: RolloutBy; id: string } {
  if (by === 'user' && ctx.userId) return { by: 'user', id: ctx.userId };
  if ((by === 'user' || by === 'workspace') && ctx.workspaceId) return { by: 'workspace', id: ctx.workspaceId };
  return { by: 'tenant', id: ctx.tenantId };
}

const LEVEL_WORD: Record<Level, string> = { workspace: 'the workspace', tenant: 'the tenant', plan: 'the plan', platform: 'the platform' };

/** Evaluates one flag for one context, with the account of every level ("why does this tenant see this"). */
export function evaluate(key: string, ctx: EvalContext, inp: Inputs): Evaluation {
  const def = inp.def;
  if (!def) {
    const b = inp.builtin;
    return { key, value: b ? b.defaultValue : null, on: b ? isOn(b.defaultValue) : false, level: 'builtin', reason: b ? 'Not defined in the database: the built-in default.' : 'No such flag: off.', state: null, steps: [], unit: null };
  }
  if (def.state === 'planned' || def.state === 'removed') {
    return { key, value: def.defaultValue, on: isOn(def.defaultValue), level: 'default', reason: def.state === 'planned' ? 'The flag is planned, not live yet: its default.' : 'The flag is removed: its default.', state: def.state, steps: [], unit: null };
  }
  const unit = unitOf(def.rolloutBy, ctx);
  const bucket = bucketOf(def.key, unit.id);
  const steps: Step[] = [];
  let winner: { level: Level; value: FlagValue; step: Step } | null = null;
  for (const level of LEVELS) {
    if (level === 'workspace' && !ctx.workspaceId) {
      steps.push({ level, set: false, skipped: 'no workspace' });
      continue;
    }
    let v = inp.values[level];
    let fromEntitlement = false;
    if (!v && level === 'plan' && inp.plan && Object.prototype.hasOwnProperty.call(inp.plan.entitlements, `flag.${def.key}`)) {
      const ev = inp.plan.entitlements[`flag.${def.key}`]!;
      v = { id: '', flagKey: def.key, scope: 'plan', scopeId: inp.plan.key, tenantId: null, value: ev, rollout: null, note: null, updatedBy: null, updatedAt: 0 };
      fromEntitlement = true;
    }
    if (!v) {
      steps.push({ level, set: false });
      continue;
    }
    const step: Step = { level, set: true, value: v.value, rollout: v.rollout, ...(fromEntitlement ? { fromEntitlement } : {}) };
    steps.push(step);
    if (winner) {
      step.skipped = `a more specific level (${winner.level}) decided`;
      continue;
    }
    if ((level === 'workspace' || level === 'tenant') && !def.overridable) {
      step.skipped = 'the flag is locked to the platform and plans';
      continue;
    }
    const problem = valueProblem(def.type, def.options, v.value);
    if (problem) {
      step.skipped = `the value no longer fits the flag (${problem})`;
      continue;
    }
    if (v.rollout !== null && v.rollout < 100) {
      step.bucket = bucket;
      step.reached = inRollout(v.rollout, bucket);
      if (!step.reached) {
        step.skipped = `outside the ${v.rollout}% rollout (bucket ${bucket.toFixed(2)} by ${unit.by})`;
        continue;
      }
    }
    winner = { level, value: v.value, step };
  }
  if (winner) {
    const r = winner.step.rollout;
    const why = `Set at ${LEVEL_WORD[winner.level]}${winner.step.fromEntitlement ? ` (the plan's entitlement flag.${def.key})` : ''}${r !== null && r !== undefined && r < 100 ? `, inside its ${r}% rollout` : ''}.`;
    return { key, value: winner.value, on: isOn(winner.value), level: winner.level, reason: why, state: def.state, steps, unit };
  }
  return { key, value: def.defaultValue, on: isOn(def.defaultValue), level: 'default', reason: 'No level sets it here: the flag\'s default.', state: def.state, steps, unit };
}

export interface StaleWarning {
  code: 'deprecated-long' | 'unchanged' | 'planned-long' | 'review-due' | 'fully-rolled-out';
  message: string;
}

export const STALE_DAYS = { deprecated: 30, unchanged: 90, planned: 90, rolledOut: 30 };
const DAY = 86_400_000;

/**
 * Why a flag looks stale: deprecated for over 30 days (remove it), active and unchanged for over 90, planned for over
 * 90, past its review date, or rolled out to everyone at the platform level (a value other than the default, no
 * rollout limit) for over 30 days. A removed flag is never stale.
 */
export function staleWarnings(def: FlagDef, platform: LevelValue | null, now = Date.now()): StaleWarning[] {
  const out: StaleWarning[] = [];
  if (def.state === 'removed') return out;
  const days = (t: number) => Math.floor((now - t) / DAY);
  if (def.state === 'deprecated' && days(def.stateChangedAt) > STALE_DAYS.deprecated) out.push({ code: 'deprecated-long', message: `Deprecated ${days(def.stateChangedAt)} days ago: remove it from the code and mark it removed.` });
  if (def.state === 'planned' && days(def.stateChangedAt) > STALE_DAYS.planned) out.push({ code: 'planned-long', message: `Planned for ${days(def.stateChangedAt)} days and never made active.` });
  const lastChange = Math.max(def.updatedAt, platform?.updatedAt ?? 0);
  if (def.state === 'active' && days(lastChange) > STALE_DAYS.unchanged) out.push({ code: 'unchanged', message: `Active and unchanged for ${days(lastChange)} days: is it still needed?` });
  if (def.reviewAt !== null && def.reviewAt <= now) out.push({ code: 'review-due', message: `Its review date passed on ${new Date(def.reviewAt).toISOString().slice(0, 10)}.` });
  if (def.state === 'active' && platform && (platform.rollout === null || platform.rollout >= 100) && platform.value !== def.defaultValue && days(platform.updatedAt) > STALE_DAYS.rolledOut)
    out.push({ code: 'fully-rolled-out', message: `Rolled out to everyone on the platform ${days(platform.updatedAt)} days ago: make the value its default in the code and retire the flag.` });
  return out;
}
