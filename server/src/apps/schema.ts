import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isRole } from '../authz/permissions.js';
import { compilePattern } from '../guardrails/regex.js';
import { compileFormula, FormulaError, MAX_FORMULA_LENGTH, type Formula } from './formula.js';

/*
 * Entity definitions (B-2201, B-2203, B-2204): typed fields, an optional state machine, and the rules that turn a
 * record's values into the clear index rows (`app_record_values`) and unique keys (`app_unique_values`).
 *
 * Normalisation is the same on every dialect and in JavaScript: text-like values (string, enum, and the ids of
 * references, lookups and files) are compared lower-cased after Unicode NFC, numbers as doubles, dates as epoch
 * milliseconds (UTC), booleans as 0 and 1. So "the same filter returns the same rows" holds on SQLite, MySQL and
 * PostgreSQL: the database only compares bytes and doubles it was given already normalised.
 */

export const FIELD_TYPES = ['string', 'number', 'boolean', 'date', 'enum', 'reference', 'lookup', 'file', 'json', 'formula', 'ai'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const NAME = /^[a-z][a-z0-9_]{0,62}$/;
export const nameSchema = z.string().regex(NAME, 'lower-case letters, digits and _, starting with a letter, at most 63 characters');
/** Names a field cannot take: the record's own properties in API answers and filters. */
export const RESERVED = new Set(['id', 'state', 'label', 'version', 'created_at', 'updated_at', 'created_by', 'updated_by', 'createdat', 'updatedat', 'createdby', 'updatedby']);
/** Indexed text is at most this long (the index column). */
export const INDEX_TEXT_MAX = 255;

const base = {
  name: nameSchema.refine((n) => !RESERVED.has(n), 'that name is reserved'),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  required: z.boolean().default(false),
  /** In the clear index: filterable, sortable, searchable, aggregatable. The value is then stored unsealed there. */
  indexed: z.boolean().default(false),
  unique: z.boolean().default(false)
};

const option = z.object({ value: z.string().trim().min(1).max(100), label: z.string().max(200).optional() }).strict();

export const fieldSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('string'), minLength: z.number().int().min(0).max(100_000).optional(), maxLength: z.number().int().min(1).max(100_000).default(1000), pattern: z.string().max(500).optional(), multiline: z.boolean().optional() }).strict(),
  z.object({ ...base, type: z.literal('number'), min: z.number().optional(), max: z.number().optional(), integer: z.boolean().default(false) }).strict(),
  z.object({ ...base, type: z.literal('boolean') }).strict(),
  z.object({ ...base, type: z.literal('date'), withTime: z.boolean().default(false) }).strict(),
  z.object({ ...base, type: z.literal('enum'), options: z.array(option).min(1).max(200) }).strict(),
  z.object({ ...base, type: z.literal('reference'), entity: nameSchema }).strict(),
  z.object({ ...base, type: z.literal('lookup'), source: z.enum(['static', 'entity', 'user', 'workspace']), options: z.array(option).max(500).optional(), entity: nameSchema.optional(), display: nameSchema.optional() }).strict(),
  z.object({ ...base, type: z.literal('file') }).strict(),
  z.object({ ...base, type: z.literal('json'), maxBytes: z.number().int().min(2).max(100_000).default(10_000) }).strict(),
  z.object({ ...base, type: z.literal('formula'), expression: z.string().min(1).max(MAX_FORMULA_LENGTH) }).strict(),
  z.object({ ...base, type: z.literal('ai'), profile: z.string().min(1).max(63), prompt: z.string().min(1).max(4000), maxLength: z.number().int().min(1).max(20_000).default(2000) }).strict()
]);
export type Field = z.infer<typeof fieldSchema>;

const stateName = z.string().regex(/^[a-z][a-z0-9_-]{0,59}$/, 'lower-case letters, digits, _ and -, at most 60 characters');
export const statesSchema = z
  .object({
    initial: stateName,
    states: z.array(z.object({ name: stateName, title: z.string().max(100).optional() }).strict()).min(1).max(50),
    transitions: z
      .array(
        z
          .object({
            name: stateName.optional(),
            /** The states this transition leaves from; `*` is any state. */
            from: z.array(z.union([stateName, z.literal('*')])).min(1).max(50),
            to: stateName,
            /** Only holders of one of these roles may take it (any `records:write` holder when absent). */
            roles: z.array(z.string().max(63)).max(13).optional()
          })
          .strict()
      )
      .max(200)
  })
  .strict();
export type StateMachine = z.infer<typeof statesSchema>;

export const entityDefinitionSchema = z
  .object({
    fields: z.array(fieldSchema).min(1).max(200),
    states: statesSchema.optional(),
    /** The field shown as a record's title in lookups (the first string field when absent). */
    titleField: nameSchema.optional()
  })
  .strict();
export type EntityDefinition = z.infer<typeof entityDefinitionSchema>;

const UNIQUE_TYPES: FieldType[] = ['string', 'number', 'date', 'enum', 'reference', 'lookup', 'file'];
const NO_INDEX: FieldType[] = ['json'];
const COMPUTED: FieldType[] = ['formula', 'ai'];

/**
 * Checks a definition beyond its shape: names, formulas (their references exist and are not computed themselves),
 * state machines, references to other entities (`entities` are the names in the app, this one included).
 * Returns the problems; empty when it is valid.
 */
export function checkDefinition(def: EntityDefinition, entities: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const f of def.fields) {
    if (names.has(f.name)) problems.push(`Two fields are named ${f.name}.`);
    names.add(f.name);
  }
  const plain = new Set(def.fields.filter((f) => !COMPUTED.includes(f.type)).map((f) => f.name));
  for (const f of def.fields) {
    if (f.unique && !UNIQUE_TYPES.includes(f.type)) problems.push(`${f.name}: a ${f.type} field cannot be unique.`);
    if (f.indexed && NO_INDEX.includes(f.type)) problems.push(`${f.name}: a ${f.type} field cannot be indexed.`);
    if (f.required && COMPUTED.includes(f.type)) problems.push(`${f.name}: a computed field cannot be required.`);
    if (f.type === 'string') {
      if ((f.indexed || f.unique) && f.maxLength > INDEX_TEXT_MAX) problems.push(`${f.name}: an indexed or unique text field has a maxLength of at most ${INDEX_TEXT_MAX}.`);
      if (f.minLength != null && f.minLength > f.maxLength) problems.push(`${f.name}: minLength is above maxLength.`);
      if (f.pattern) {
        const c = compilePattern(f.pattern);
        if (!c.ok) problems.push(`${f.name}: the pattern is not valid (${c.error.msg}).`);
      }
    }
    if (f.type === 'number' && f.min != null && f.max != null && f.min > f.max) problems.push(`${f.name}: min is above max.`);
    if (f.type === 'enum' && new Set(f.options.map((o) => o.value.toLowerCase())).size !== f.options.length) problems.push(`${f.name}: two options have the same value.`);
    if (f.type === 'reference' && !entities.has(f.entity)) problems.push(`${f.name}: there is no entity ${f.entity} in this app.`);
    if (f.type === 'lookup') {
      if (f.source === 'static' && !f.options?.length) problems.push(`${f.name}: a static lookup lists its options.`);
      if (f.source === 'entity' && (!f.entity || !entities.has(f.entity))) problems.push(`${f.name}: an entity lookup names an entity of this app.`);
    }
    if (f.type === 'formula') {
      try {
        compileFormula(f.expression, plain);
      } catch (err) {
        problems.push(`${f.name}: ${err instanceof FormulaError ? err.message : 'the formula is not valid.'}`);
      }
    }
    if (f.type === 'ai') {
      for (const m of f.prompt.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) if (!plain.has(m[1]!)) problems.push(`${f.name}: the prompt reads {{${m[1]}}}, which is not a field it can read.`);
    }
  }
  if (def.titleField && !names.has(def.titleField)) problems.push(`titleField: there is no field ${def.titleField}.`);
  if (def.states) problems.push(...checkStates(def.states));
  return problems;
}

function checkStates(sm: StateMachine): string[] {
  const out: string[] = [];
  const names = new Set(sm.states.map((s) => s.name));
  if (names.size !== sm.states.length) out.push('states: two states have the same name.');
  if (!names.has(sm.initial)) out.push(`states: the initial state ${sm.initial} is not listed.`);
  for (const t of sm.transitions) {
    for (const f of t.from) if (f !== '*' && !names.has(f)) out.push(`states: a transition leaves from ${f}, which is not a state.`);
    if (!names.has(t.to)) out.push(`states: a transition goes to ${t.to}, which is not a state.`);
    for (const r of t.roles ?? []) if (!isRole(r)) out.push(`states: there is no role ${r}.`);
  }
  return out;
}

/** The transition that takes a record from `from` to `to`, or null when the state machine has none (illegal). */
export function transitionFor(sm: StateMachine, from: string | null, to: string) {
  return sm.transitions.find((t) => t.to === to && (t.from.includes('*') || (from != null && t.from.includes(from)))) ?? null;
}

// ---------- values ----------

export class ValueError extends Error {
  constructor(readonly problems: { field: string; message: string }[]) {
    super(problems.map((p) => `${p.field}: ${p.message}`).join('; '));
  }
}

export type Values = Record<string, unknown>;

export const normText = (s: string): string => s.normalize('NFC').toLowerCase();

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/** A date value's instant (epoch ms, UTC), or null when it is not a date. */
export function dateMs(v: unknown, withTime: boolean): number | null {
  if (typeof v !== 'string') return null;
  if (DATE.test(v)) {
    const t = Date.parse(`${v}T00:00:00Z`);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v ? t : null;
  }
  if (withTime && DATETIME.test(v)) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * Checks one value against its field and returns it in its stored form (dates as written, ids upper-cased, enum
 * values as the option spells them). Throws a message for the caller to collect.
 */
export function checkValue(f: Field, v: unknown): unknown {
  if (v === null || v === undefined || v === '') return null;
  switch (f.type) {
    case 'string': {
      if (typeof v !== 'string') throw new Error('should be text');
      const s = v.normalize('NFC');
      const n = [...s].length;
      if (n > f.maxLength) throw new Error(`is longer than ${f.maxLength} characters`);
      if (f.minLength != null && n < f.minLength) throw new Error(`is shorter than ${f.minLength} characters`);
      if (!f.multiline && /[\r\n]/.test(s)) throw new Error('should be one line');
      if (f.pattern) {
        const c = compilePattern(f.pattern);
        if (c.ok && !c.re.test(s)) throw new Error('does not match the pattern');
      }
      return s;
    }
    case 'number': {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      if (!Number.isFinite(n)) throw new Error('should be a number');
      if (f.integer && !Number.isInteger(n)) throw new Error('should be a whole number');
      if (f.min != null && n < f.min) throw new Error(`is below ${f.min}`);
      if (f.max != null && n > f.max) throw new Error(`is above ${f.max}`);
      return n;
    }
    case 'boolean': {
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === '1' || v === 1) return true;
      if (v === 'false' || v === '0' || v === 0) return false;
      throw new Error('should be true or false');
    }
    case 'date': {
      if (dateMs(v, f.withTime) == null) throw new Error(f.withTime ? 'should be a date (YYYY-MM-DD) or a date and time with a zone' : 'should be a date (YYYY-MM-DD)');
      return v;
    }
    case 'enum': {
      if (typeof v !== 'string') throw new Error('should be one of the options');
      const o = f.options.find((x) => normText(x.value) === normText(v));
      if (!o) throw new Error(`should be one of ${f.options.map((x) => x.value).slice(0, 10).join(', ')}`);
      return o.value;
    }
    case 'lookup': {
      if (f.source === 'static') {
        if (typeof v !== 'string') throw new Error('should be one of the options');
        const o = (f.options ?? []).find((x) => normText(x.value) === normText(v));
        if (!o) throw new Error('is not one of the options');
        return o.value;
      }
      if (typeof v !== 'string' || !ID.test(v)) throw new Error('should be an id');
      return v.toUpperCase();
    }
    case 'reference':
    case 'file':
      if (typeof v !== 'string' || !ID.test(v)) throw new Error('should be an id');
      return v.toUpperCase();
    case 'json': {
      const s = JSON.stringify(v);
      if (Buffer.byteLength(s) > f.maxBytes) throw new Error(`is larger than ${f.maxBytes} bytes as JSON`);
      return JSON.parse(s) as unknown;
    }
    case 'formula':
    case 'ai':
      throw new Error('is computed and cannot be set');
  }
}

/**
 * Validates input values for a write. `partial` (an update) checks only the fields given and the required ones that
 * end up empty; unknown and computed fields are refused. Returns the merged values (computed fields untouched).
 */
export function validateValues(def: EntityDefinition, input: Values, o: { existing?: Values; partial?: boolean } = {}): Values {
  const byName = new Map(def.fields.map((f) => [f.name, f]));
  const problems: { field: string; message: string }[] = [];
  const out: Values = { ...(o.existing ?? {}) };
  for (const [k, v] of Object.entries(input)) {
    const f = byName.get(k);
    if (!f) {
      problems.push({ field: k, message: 'is not a field of this entity' });
      continue;
    }
    try {
      const c = checkValue(f, v);
      if (c === null) delete out[k];
      else out[k] = c;
    } catch (err) {
      problems.push({ field: k, message: (err as Error).message });
    }
  }
  for (const f of def.fields) if (f.required && (out[f.name] == null || out[f.name] === '') && !problems.some((p) => p.field === f.name)) problems.push({ field: f.name, message: 'is required' });
  if (problems.length) throw new ValueError(problems);
  return out;
}

/** CSV cells are text: turn one into the value its field expects (numbers, booleans, JSON), empty as null. */
export function fromCell(f: Field, cell: string): unknown {
  if (cell === '') return null;
  if (f.type === 'number') return Number.isFinite(Number(cell)) ? Number(cell) : cell;
  if (f.type === 'json') {
    try {
      return JSON.parse(cell) as unknown;
    } catch {
      return cell;
    }
  }
  return cell;
}

const formulaCache = new Map<string, Formula>();

/** Computes the formula fields of a record from its other values (in place; a failed formula gives null). */
export function computeFormulas(def: EntityDefinition, values: Values): Values {
  const plain = new Set(def.fields.filter((f) => !COMPUTED.includes(f.type)).map((f) => f.name));
  const input = new Map<string, unknown>(Object.entries(values).filter(([k]) => plain.has(k)));
  for (const f of def.fields) {
    if (f.type !== 'formula') continue;
    const key = `${[...plain].join(',')}\n${f.expression}`;
    let c = formulaCache.get(key);
    if (!c) {
      try {
        c = compileFormula(f.expression, plain);
      } catch {
        delete values[f.name];
        continue;
      }
      if (formulaCache.size > 500) formulaCache.clear();
      formulaCache.set(key, c);
    }
    const v = c.evaluate(input);
    if (v == null) delete values[f.name];
    else values[f.name] = v;
  }
  return values;
}

// ---------- the clear index and unique keys ----------

export interface IndexRow {
  field: string;
  v_norm: string | null;
  v_num: number | null;
}

/** The comparable form of a value for its field: text lower-cased, or a number. Null when it has none. */
export function comparable(f: Field, v: unknown): { norm: string | null; num: number | null } | null {
  if (v == null || v === '') return null;
  switch (f.type) {
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? { norm: null, num: v } : null;
    case 'boolean':
      return typeof v === 'boolean' ? { norm: null, num: v ? 1 : 0 } : null;
    case 'date': {
      const t = dateMs(v, f.withTime);
      return t == null ? null : { norm: null, num: t };
    }
    case 'formula':
      if (typeof v === 'number' && Number.isFinite(v)) return { norm: null, num: v };
      if (typeof v === 'boolean') return { norm: null, num: v ? 1 : 0 };
      return typeof v === 'string' ? { norm: normText(v).slice(0, INDEX_TEXT_MAX), num: null } : null;
    case 'json':
      return null;
    default:
      return typeof v === 'string' ? { norm: normText(v).slice(0, INDEX_TEXT_MAX), num: null } : null;
  }
}

/** Index rows for the indexed fields of a record. */
export function indexRows(def: EntityDefinition, values: Values): IndexRow[] {
  const out: IndexRow[] = [];
  for (const f of def.fields) {
    if (!f.indexed && !f.unique) continue;
    const c = comparable(f, values[f.name]);
    if (c) out.push({ field: f.name, v_norm: c.norm, v_num: c.num });
  }
  return out;
}

/** One key per unique field with a value: a hash of the entity, field and normalised value. */
export function uniqueKeys(entityId: string, def: EntityDefinition, values: Values): { field: string; hash: string }[] {
  const out: { field: string; hash: string }[] = [];
  for (const f of def.fields) {
    if (!f.unique) continue;
    const v = values[f.name];
    if (v == null || v === '') continue;
    const c = f.type === 'string' || f.type === 'enum' || f.type === 'reference' || f.type === 'lookup' || f.type === 'file' ? normText(String(v)) : f.type === 'date' ? String(dateMs(v, f.withTime)) : String(v);
    out.push({ field: f.name, hash: createHash('sha256').update(`${entityId}\n${f.name}\n${c}`).digest('hex') });
  }
  return out;
}

export const isComputed = (f: Field): boolean => COMPUTED.includes(f.type);

/** The field shown as a record's title: `titleField`, else the first string field. */
export function titleFieldOf(def: EntityDefinition): string | null {
  return def.titleField ?? def.fields.find((f) => f.type === 'string')?.name ?? null;
}
