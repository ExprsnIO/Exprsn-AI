import { z } from 'zod';

/*
 * Decision tables (Sprint 46, B-131): the definition, its checks and its evaluation. Pure and deterministic: nothing
 * here runs code, reads the clock or touches the database. A table has typed input columns, output columns, ordered
 * rules and a hit policy; each rule tests some input columns with a small fixed vocabulary of comparisons and gives
 * a value for every output column.
 *
 * - Tests: `any` ("-"), `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `between` (inclusive), `in`, `not_in`, `contains`,
 *   `starts_with`, `empty`. Which ones a column takes depends on its type (`OPS_BY_TYPE`). An empty input (missing,
 *   null or "") matches only `any` and `empty`.
 * - Hit policies: `first` (the first rule that matches), `unique` (at most one rule may match: two is an error),
 *   `priority` (of the matching rules, the one whose outputs come first in the output columns' value order), `any`
 *   (every matching rule must give the same outputs: different ones are an error) and `collect` (every matching
 *   rule, in order; with `sum`, `min`, `max` or `count` over the table's one output column).
 * - Cells may be written as text (`>= 1000`, `[1..5]`, `in ("EU", "UK")`, `-`), parsed here into the structured
 *   test (`parseCell`) and written back as text by `cellText`.
 * - `checkDefinition` is the publish check: types are consistent, `unique` rules never overlap, `any` rules that
 *   overlap agree, and (a warning) a rule that an earlier one always takes first under `first` can never match. The
 *   overlap and cover questions are answered exactly over sets of values (intervals for numbers and dates, finite and
 *   co-finite sets and prefix/substring patterns for strings), never by sampling.
 */

export const COLUMN_TYPES = ['string', 'number', 'boolean', 'date'] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];
export const HIT_POLICIES = ['first', 'unique', 'priority', 'any', 'collect'] as const;
export type HitPolicy = (typeof HIT_POLICIES)[number];
export const AGGREGATIONS = ['sum', 'min', 'max', 'count'] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];
export const TEST_OPS = ['any', 'eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'between', 'in', 'not_in', 'contains', 'starts_with', 'empty'] as const;
export type TestOp = (typeof TEST_OPS)[number];

/** The comparisons each column type takes. */
export const OPS_BY_TYPE: Record<ColumnType, readonly TestOp[]> = {
  string: ['any', 'empty', 'eq', 'ne', 'in', 'not_in', 'contains', 'starts_with'],
  number: ['any', 'empty', 'eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'between', 'in', 'not_in'],
  boolean: ['any', 'empty', 'eq', 'ne'],
  date: ['any', 'empty', 'eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'between', 'in', 'not_in']
};

export const LIMITS = { inputs: 30, outputs: 20, rules: 500, listValues: 50, outputValues: 50 } as const;

export const columnName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/, 'Column names are letters, digits and _');
export const ruleId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/, 'Rule ids are letters, digits, _ and -');
const scalar = z.union([z.string().max(500), z.number().finite(), z.boolean()]);
export type Scalar = z.infer<typeof scalar>;

export const testSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('any') }).strict(),
  z.object({ op: z.literal('empty') }).strict(),
  z.object({ op: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains', 'starts_with']), value: scalar }).strict(),
  z.object({ op: z.literal('between'), min: scalar, max: scalar }).strict(),
  z.object({ op: z.enum(['in', 'not_in']), values: z.array(scalar).min(1).max(LIMITS.listValues) }).strict()
]);
export type Test = z.infer<typeof testSchema>;

export const inputColumnSchema = z.object({ name: columnName, label: z.string().trim().max(100).optional(), type: z.enum(COLUMN_TYPES) }).strict();
export const outputColumnSchema = z
  .object({
    name: columnName,
    label: z.string().trim().max(100).optional(),
    type: z.enum(COLUMN_TYPES),
    /** The values this output may take, in priority order (the `priority` hit policy ranks by it). */
    values: z.array(scalar).max(LIMITS.outputValues).optional(),
    /** Given when no rule matches (single-result policies). */
    default: scalar.nullable().optional()
  })
  .strict();
export type InputColumn = z.infer<typeof inputColumnSchema>;
export type OutputColumn = z.infer<typeof outputColumnSchema>;

const ruleSchema = z
  .object({
    id: ruleId,
    /** Tests by input column; a column left out is `any`. */
    when: z.record(columnName, testSchema).default({}),
    /** A value for each output column (null: no value). */
    then: z.record(columnName, scalar.nullable()).default({}),
    note: z.string().trim().max(300).optional()
  })
  .strict();
export type Rule = z.infer<typeof ruleSchema>;

export const definitionSchema = z
  .object({
    inputs: z.array(inputColumnSchema).max(LIMITS.inputs),
    outputs: z.array(outputColumnSchema).min(1).max(LIMITS.outputs),
    hitPolicy: z.enum(HIT_POLICIES).default('first'),
    aggregation: z.enum(AGGREGATIONS).optional(),
    rules: z.array(ruleSchema).max(LIMITS.rules)
  })
  .strict();
export type Definition = z.infer<typeof definitionSchema>;

/**
 * What the API takes: the definition with cells as structured tests or as text, and rule ids optional (new rules
 * get the next free `r<N>`). `normalize` turns it into a `Definition`.
 */
const cellInput = z.union([testSchema, z.string().max(500)]);
export const definitionInputSchema = z
  .object({
    inputs: z.array(inputColumnSchema).max(LIMITS.inputs).default([]),
    outputs: z.array(outputColumnSchema).max(LIMITS.outputs).default([]),
    hitPolicy: z.enum(HIT_POLICIES).default('first'),
    aggregation: z.enum(AGGREGATIONS).nullable().optional(),
    rules: z
      .array(z.object({ id: ruleId.optional(), when: z.record(columnName, cellInput).default({}), then: z.record(columnName, z.union([scalar, z.null()])).default({}), note: z.string().trim().max(300).optional() }).strict())
      .max(LIMITS.rules)
      .default([])
  })
  .strict();
export type DefinitionInput = z.input<typeof definitionInputSchema>;

export const emptyDefinition = (): Definition => ({ inputs: [{ name: 'amount', type: 'number' }], outputs: [{ name: 'result', type: 'string' }], hitPolicy: 'first', rules: [] });

/** A cell that does not parse: where it is and why. */
export class CellError extends Error {
  constructor(
    readonly rule: number,
    readonly column: string,
    message: string
  ) {
    super(message);
  }
}

// ---------- cells as text ----------

/** Splits `a, "b, c", d` at the commas outside quotes. */
function splitList(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (ch === '\\' && i + 1 < s.length) {
        cur += ch + s[++i];
        continue;
      }
      if (ch === quote) quote = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (quote) throw new Error('A quote is not closed.');
  out.push(cur.trim());
  return out;
}

const QUOTED = /^(["'])((?:\\.|(?!\1).)*)\1$/s;

/** A literal as the column's type reads it; text that does not read as the type stays text (the type check reports it). */
export function parseValue(raw: string, type: ColumnType): Scalar {
  const s = raw.trim();
  const q = QUOTED.exec(s);
  if (q) return q[2]!.replace(/\\(.)/g, '$1');
  if (type === 'number' && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) return Number(s);
  if (type === 'boolean' && /^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
  return s;
}

const OP_SYMBOLS: [RegExp, TestOp][] = [
  [/^(<=|≤)/, 'lte'],
  [/^(>=|≥)/, 'gte'],
  [/^(!=|<>|≠)/, 'ne'],
  [/^</, 'lt'],
  [/^>/, 'gt'],
  [/^=/, 'eq']
];

/** A cell written as text (`>= 1000`, `[1..5]`, `between 1 and 5`, `in (a, b)`, `not in (a)`, `contains x`, `starts with x`, `is empty`, `-`). */
export function parseCell(text: string, type: ColumnType): Test {
  const s = text.trim();
  if (s === '' || s === '-' || /^any$/i.test(s)) return { op: 'any' };
  if (/^(is )?empty$/i.test(s)) return { op: 'empty' };
  let m = /^not\s+in\s*\((.*)\)$/is.exec(s);
  if (m) return { op: 'not_in', values: listOf(m[1]!, type) };
  m = /^in\s*\((.*)\)$/is.exec(s);
  if (m) return { op: 'in', values: listOf(m[1]!, type) };
  m = /^\[(.+?)\s*\.\.\s*(.+)\]$/s.exec(s);
  if (m) return { op: 'between', min: parseValue(m[1]!, type), max: parseValue(m[2]!, type) };
  m = /^between\s+(.+?)\s+and\s+(.+)$/is.exec(s);
  if (m) return { op: 'between', min: parseValue(m[1]!, type), max: parseValue(m[2]!, type) };
  m = /^contains\s+(.+)$/is.exec(s);
  if (m) return { op: 'contains', value: parseValue(m[1]!, 'string') };
  m = /^starts\s+with\s+(.+)$/is.exec(s);
  if (m) return { op: 'starts_with', value: parseValue(m[1]!, 'string') };
  for (const [re, op] of OP_SYMBOLS) {
    const x = re.exec(s);
    if (!x) continue;
    const rest = s.slice(x[0].length).trim();
    if (!rest) throw new Error(`${x[0]} needs a value after it.`);
    return { op, value: parseValue(rest, type) } as Test;
  }
  // A bare list is "in"; a bare value is "=".
  if (!QUOTED.test(s) && splitList(s).length > 1) return { op: 'in', values: listOf(s, type) };
  return { op: 'eq', value: parseValue(s, type) };
}

function listOf(body: string, type: ColumnType): Scalar[] {
  const items = splitList(body).filter((x) => x !== '');
  if (!items.length) throw new Error('The list is empty.');
  if (items.length > LIMITS.listValues) throw new Error(`A list holds at most ${LIMITS.listValues} values.`);
  return items.map((x) => parseValue(x, type));
}

const lit = (v: Scalar | null | undefined): string => (v === null || v === undefined ? 'null' : typeof v === 'string' ? JSON.stringify(v) : String(v));
const SYMBOL: Partial<Record<TestOp, string>> = { eq: '=', ne: '≠', lt: '<', lte: '≤', gt: '>', gte: '≥' };

/** A test as the editor shows it. */
export function cellText(t: Test): string {
  switch (t.op) {
    case 'any':
      return '-';
    case 'empty':
      return 'is empty';
    case 'between':
      return `[${lit(t.min)}..${lit(t.max)}]`;
    case 'in':
      return `in (${t.values.map(lit).join(', ')})`;
    case 'not_in':
      return `not in (${t.values.map(lit).join(', ')})`;
    case 'contains':
      return `contains ${lit(t.value)}`;
    case 'starts_with':
      return `starts with ${lit(t.value)}`;
    default:
      return `${SYMBOL[t.op]} ${lit(t.value)}`;
  }
}

/**
 * The API's definition as stored: text cells parsed by their column's type, rule ids filled in, tests and values of
 * columns that do not exist kept (the check reports them). A cell that does not parse throws `CellError`.
 */
export function normalize(input: z.output<typeof definitionInputSchema>): Definition {
  const types = new Map(input.inputs.map((c) => [c.name, c.type]));
  const used = new Set(input.rules.map((r) => r.id).filter((x): x is string => !!x));
  let next = 1;
  const freshId = () => {
    while (used.has(`r${next}`)) next++;
    used.add(`r${next}`);
    return `r${next}`;
  };
  const rules: Rule[] = input.rules.map((r, i) => {
    const when: Record<string, Test> = {};
    for (const [col, cell] of Object.entries(r.when)) {
      if (typeof cell !== 'string') {
        if (cell.op !== 'any') when[col] = cell;
        continue;
      }
      let t: Test;
      try {
        t = parseCell(cell, types.get(col) ?? 'string');
      } catch (err) {
        throw new CellError(i, col, `Rule ${i + 1}, ${col}: ${(err as Error).message}`);
      }
      if (t.op !== 'any') when[col] = t;
    }
    return { id: r.id ?? freshId(), when, then: { ...r.then }, ...(r.note ? { note: r.note } : {}) };
  });
  return { inputs: input.inputs, outputs: input.outputs, hitPolicy: input.hitPolicy, ...(input.aggregation ? { aggregation: input.aggregation } : {}), rules };
}

// ---------- types ----------

const DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** A date literal as epoch milliseconds (a date alone is midnight UTC), or null. */
export function dateMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string' || !DATE.test(v.trim())) return null;
  const s = v.trim();
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s.replace(' ', 'T'));
  return Number.isFinite(ms) ? ms : null;
}

/** Why a literal is not of the column's type, or null. */
export function typeProblem(v: unknown, type: ColumnType): string | null {
  switch (type) {
    case 'string':
      return typeof v === 'string' ? null : `${lit(v as Scalar)} is not text`;
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? null : `${lit(v as Scalar)} is not a number`;
    case 'boolean':
      return typeof v === 'boolean' ? null : `${lit(v as Scalar)} is not true or false`;
    case 'date':
      return typeof v === 'string' && dateMs(v) != null ? null : `${lit(v as Scalar)} is not a date (YYYY-MM-DD, or an ISO date and time)`;
  }
}

/** Orders two literals of a column's type (numbers and dates). */
function ordinal(v: Scalar, type: ColumnType): number {
  return type === 'date' ? dateMs(v)! : Number(v);
}

// ---------- the check ----------

export interface DecisionIssue {
  code: 'structure' | 'type' | 'overlap' | 'unreachable' | 'policy';
  message: string;
  rule?: string;
  column?: string;
  /** The other rule of an overlap or a cover. */
  other?: string;
}

export interface DecisionCheck {
  ok: boolean;
  errors: DecisionIssue[];
  warnings: DecisionIssue[];
}

/** Every problem that stops a definition from being published, and the warnings. */
export function checkDefinition(d: Definition): DecisionCheck {
  const errors: DecisionIssue[] = [];
  const warnings: DecisionIssue[] = [];
  const dupes = (names: string[], what: string) => {
    const seen = new Set<string>();
    for (const n of names) {
      const k = n.toLowerCase();
      if (seen.has(k)) errors.push({ code: 'structure', message: `Two ${what} are named ${n}.`, ...(what === 'rules' ? { rule: n } : { column: n }) });
      seen.add(k);
    }
  };
  dupes([...d.inputs.map((c) => c.name), ...d.outputs.map((c) => c.name)], 'columns');
  dupes(d.rules.map((r) => r.id), 'rules');
  if (!d.outputs.length) errors.push({ code: 'structure', message: 'Add an output column: a table decides at least one value.' });
  if (!d.rules.length) errors.push({ code: 'structure', message: 'Add a rule: a table without rules never decides anything.' });

  const inputs = new Map(d.inputs.map((c) => [c.name, c]));
  const outputs = new Map(d.outputs.map((c) => [c.name, c]));
  for (const o of d.outputs) {
    for (const v of o.values ?? []) {
      const p = typeProblem(v, o.type);
      if (p) errors.push({ code: 'type', column: o.name, message: `Output ${o.name}: the listed value ${p}.` });
    }
    if (o.default !== undefined && o.default !== null) {
      const p = typeProblem(o.default, o.type);
      if (p) errors.push({ code: 'type', column: o.name, message: `Output ${o.name}: the default ${p}.` });
      else if (o.values?.length && !o.values.includes(o.default)) errors.push({ code: 'type', column: o.name, message: `Output ${o.name}: the default ${lit(o.default)} is not one of its listed values.` });
    }
  }

  // Policies and aggregation.
  if (d.aggregation && d.hitPolicy !== 'collect') errors.push({ code: 'policy', message: `Only the collect hit policy aggregates; ${d.hitPolicy} gives one result.` });
  if (d.hitPolicy === 'collect' && d.aggregation) {
    if (d.outputs.length !== 1) errors.push({ code: 'policy', message: `Collect with ${d.aggregation} works on one output column; this table has ${d.outputs.length}.` });
    const o = d.outputs[0];
    if (o && d.aggregation === 'sum' && o.type !== 'number') errors.push({ code: 'policy', column: o.name, message: `Collect with sum adds numbers; ${o.name} is ${o.type}.` });
    if (o && (d.aggregation === 'min' || d.aggregation === 'max') && o.type !== 'number' && o.type !== 'date') errors.push({ code: 'policy', column: o.name, message: `Collect with ${d.aggregation} compares numbers or dates; ${o.name} is ${o.type}.` });
  }
  if (d.hitPolicy === 'priority' && !d.outputs.some((o) => o.values?.length)) errors.push({ code: 'policy', message: 'The priority hit policy ranks by the order of an output column\'s values: list the values of at least one output column, highest priority first.' });

  // Every cell.
  let typed = errors.length === 0;
  d.rules.forEach((r, i) => {
    const where = `Rule ${i + 1} (${r.id})`;
    for (const [col, t] of Object.entries(r.when)) {
      const c = inputs.get(col);
      if (!c) {
        errors.push({ code: 'structure', rule: r.id, column: col, message: `${where} tests ${col}, which is not an input column.` });
        typed = false;
        continue;
      }
      const issue = testProblem(t, c.type);
      if (issue) {
        errors.push({ code: 'type', rule: r.id, column: col, message: `${where}, ${col}: ${issue}.` });
        typed = false;
      }
    }
    for (const o of d.outputs) {
      if (!(o.name in r.then)) {
        errors.push({ code: 'structure', rule: r.id, column: o.name, message: `${where} gives no value for ${o.name} (write null for none).` });
        continue;
      }
      const v = r.then[o.name];
      if (v === null || v === undefined) {
        if (d.hitPolicy === 'priority' && o.values?.length) errors.push({ code: 'policy', rule: r.id, column: o.name, message: `${where} gives no value for ${o.name}, which ranks the rules (priority).` });
        continue;
      }
      const p = typeProblem(v, o.type);
      if (p) errors.push({ code: 'type', rule: r.id, column: o.name, message: `${where}, ${o.name}: ${p}.` });
      else if (o.values?.length && !o.values.includes(v)) errors.push({ code: 'type', rule: r.id, column: o.name, message: `${where}, ${o.name}: ${lit(v)} is not one of its listed values (${o.values.map(lit).join(', ')}).` });
    }
    for (const col of Object.keys(r.then)) if (!outputs.has(col)) errors.push({ code: 'structure', rule: r.id, column: col, message: `${where} gives ${col}, which is not an output column.` });
  });

  // Overlaps (unique, any) and rules never reached (first), on a well-typed table only.
  if (typed && (d.hitPolicy === 'unique' || d.hitPolicy === 'any' || d.hitPolicy === 'first')) {
    const sets = d.rules.map((r) => d.inputs.map((c) => setOf(r.when[c.name] ?? { op: 'any' }, c.type)));
    for (let j = 0; j < d.rules.length; j++) {
      for (let i = 0; i < j; i++) {
        const a = d.rules[i]!;
        const b = d.rules[j]!;
        if (d.hitPolicy === 'first') {
          if (sets[i]!.every((s, k) => covers(s, sets[j]![k]!))) {
            warnings.push({ code: 'unreachable', rule: b.id, other: a.id, message: `Rule ${j + 1} (${b.id}) can never match: rule ${i + 1} (${a.id}) comes first and matches everything it matches.` });
            break;
          }
          continue;
        }
        if (!sets[i]!.every((s, k) => intersects(s, sets[j]![k]!))) continue;
        if (d.hitPolicy === 'unique') errors.push({ code: 'overlap', rule: b.id, other: a.id, message: `Rules ${i + 1} (${a.id}) and ${j + 1} (${b.id}) overlap: some input matches both, and the unique hit policy allows one.` });
        else {
          const diff = d.outputs.find((o) => !same(a.then[o.name], b.then[o.name]));
          if (diff) errors.push({ code: 'overlap', rule: b.id, other: a.id, message: `Rules ${i + 1} (${a.id}) and ${j + 1} (${b.id}) overlap but give different values of ${diff.name} (${lit(a.then[diff.name])} and ${lit(b.then[diff.name])}); the any hit policy needs them to agree.` });
        }
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** Why a test does not fit its column's type, or null. */
function testProblem(t: Test, type: ColumnType): string | null {
  if (!OPS_BY_TYPE[type].includes(t.op)) return `a ${type} column cannot be tested with ${t.op.replace('_', ' ')}`;
  switch (t.op) {
    case 'any':
    case 'empty':
      return null;
    case 'contains':
    case 'starts_with':
      return typeof t.value === 'string' && t.value !== '' ? null : `${t.op.replace('_', ' ')} takes some text`;
    case 'between': {
      const p = typeProblem(t.min, type) ?? typeProblem(t.max, type);
      if (p) return p;
      return ordinal(t.min, type) <= ordinal(t.max, type) ? null : `the range starts after it ends (${lit(t.min)} to ${lit(t.max)})`;
    }
    case 'in':
    case 'not_in':
      for (const v of t.values) {
        const p = typeProblem(v, type);
        if (p) return p;
      }
      return null;
    default:
      return typeProblem(t.value, type);
  }
}

const same = (a: unknown, b: unknown): boolean => (a ?? null) === (b ?? null);

// ---------- value sets (for overlap and cover) ----------

interface Interval {
  lo: number;
  hi: number;
  loIn: boolean;
  hiIn: boolean;
}
type ValueSet = { empty: boolean; kind: 'num'; iv: Interval[] } | { empty: boolean; kind: 'fin' | 'cofin'; vals: Set<string> } | { empty: boolean; kind: 'pat'; prefix?: string; contains?: string };

const ALL: Interval = { lo: -Infinity, hi: Infinity, loIn: false, hiIn: false };

/** Merges touching and overlapping intervals, in order. */
function mergeIv(list: Interval[]): Interval[] {
  const xs = list.filter((x) => x.lo < x.hi || (x.lo === x.hi && x.loIn && x.hiIn)).sort((a, b) => a.lo - b.lo || Number(b.loIn) - Number(a.loIn));
  const out: Interval[] = [];
  for (const x of xs) {
    const last = out[out.length - 1];
    if (last && (x.lo < last.hi || (x.lo === last.hi && (x.loIn || last.hiIn)))) {
      if (x.hi > last.hi) {
        last.hi = x.hi;
        last.hiIn = x.hiIn;
      } else if (x.hi === last.hi) last.hiIn = last.hiIn || x.hiIn;
    } else out.push({ ...x });
  }
  return out;
}

function setOf(t: Test, type: ColumnType): ValueSet {
  if (type === 'number' || type === 'date') {
    const n = (v: Scalar) => ordinal(v, type);
    const pts = (vs: Scalar[]) => [...new Set(vs.map(n))].sort((a, b) => a - b);
    switch (t.op) {
      case 'any':
        return { empty: true, kind: 'num', iv: [ALL] };
      case 'empty':
        return { empty: true, kind: 'num', iv: [] };
      case 'eq':
        return { empty: false, kind: 'num', iv: [{ lo: n(t.value), hi: n(t.value), loIn: true, hiIn: true }] };
      case 'ne':
        return { empty: false, kind: 'num', iv: [{ lo: -Infinity, hi: n(t.value), loIn: false, hiIn: false }, { lo: n(t.value), hi: Infinity, loIn: false, hiIn: false }] };
      case 'lt':
        return { empty: false, kind: 'num', iv: [{ lo: -Infinity, hi: n(t.value), loIn: false, hiIn: false }] };
      case 'lte':
        return { empty: false, kind: 'num', iv: [{ lo: -Infinity, hi: n(t.value), loIn: false, hiIn: true }] };
      case 'gt':
        return { empty: false, kind: 'num', iv: [{ lo: n(t.value), hi: Infinity, loIn: false, hiIn: false }] };
      case 'gte':
        return { empty: false, kind: 'num', iv: [{ lo: n(t.value), hi: Infinity, loIn: true, hiIn: false }] };
      case 'between':
        return { empty: false, kind: 'num', iv: [{ lo: n(t.min), hi: n(t.max), loIn: true, hiIn: true }] };
      case 'in':
        return { empty: false, kind: 'num', iv: mergeIv(pts(t.values).map((p) => ({ lo: p, hi: p, loIn: true, hiIn: true }))) };
      case 'not_in': {
        const ps = pts(t.values);
        const iv: Interval[] = [];
        let lo = -Infinity;
        for (const p of ps) {
          iv.push({ lo, hi: p, loIn: false, hiIn: false });
          lo = p;
        }
        iv.push({ lo, hi: Infinity, loIn: false, hiIn: false });
        return { empty: false, kind: 'num', iv };
      }
      default:
        return { empty: true, kind: 'num', iv: [ALL] };
    }
  }
  const s = (v: Scalar) => String(v);
  if (type === 'boolean') {
    const dom = ['true', 'false'];
    switch (t.op) {
      case 'empty':
        return { empty: true, kind: 'fin', vals: new Set() };
      case 'eq':
        return { empty: false, kind: 'fin', vals: new Set([s(t.value)]) };
      case 'ne':
        return { empty: false, kind: 'fin', vals: new Set(dom.filter((x) => x !== s(t.value))) };
      default:
        return { empty: true, kind: 'fin', vals: new Set(dom) };
    }
  }
  switch (t.op) {
    case 'any':
      return { empty: true, kind: 'cofin', vals: new Set() };
    case 'empty':
      return { empty: true, kind: 'fin', vals: new Set() };
    case 'eq':
      return { empty: false, kind: 'fin', vals: new Set([s(t.value)]) };
    case 'ne':
      return { empty: false, kind: 'cofin', vals: new Set([s(t.value)]) };
    case 'in':
      return { empty: false, kind: 'fin', vals: new Set(t.values.map(s)) };
    case 'not_in':
      return { empty: false, kind: 'cofin', vals: new Set(t.values.map(s)) };
    case 'contains':
      return { empty: false, kind: 'pat', contains: s(t.value) };
    case 'starts_with':
      return { empty: false, kind: 'pat', prefix: s(t.value) };
    default:
      return { empty: true, kind: 'cofin', vals: new Set() };
  }
}

const patMatch = (p: { prefix?: string; contains?: string }, v: string) => (p.prefix !== undefined ? v.startsWith(p.prefix) : v.includes(p.contains ?? ''));
const member = (a: ValueSet, v: string): boolean => (a.kind === 'fin' ? a.vals.has(v) : a.kind === 'cofin' ? !a.vals.has(v) : a.kind === 'pat' ? patMatch(a, v) : false);

function ivMeet(a: Interval, b: Interval): boolean {
  const lo = Math.max(a.lo, b.lo);
  const hi = Math.min(a.hi, b.hi);
  if (lo < hi) return true;
  if (lo > hi) return false;
  const loIn = a.lo === b.lo ? a.loIn && b.loIn : a.lo > b.lo ? a.loIn : b.loIn;
  const hiIn = a.hi === b.hi ? a.hiIn && b.hiIn : a.hi < b.hi ? a.hiIn : b.hiIn;
  return loIn && hiIn && Number.isFinite(lo);
}

/** Whether some input matches both sets. */
export function intersects(a: ValueSet, b: ValueSet): boolean {
  if (a.empty && b.empty) return true;
  if (a.kind === 'num' && b.kind === 'num') return a.iv.some((x) => b.iv.some((y) => ivMeet(x, y)));
  if (a.kind === 'num' || b.kind === 'num') return false;
  if (a.kind === 'fin') return [...a.vals].some((v) => member(b, v));
  if (b.kind === 'fin') return [...b.vals].some((v) => member(a, v));
  if (a.kind === 'pat' && b.kind === 'pat' && a.prefix !== undefined && b.prefix !== undefined) return a.prefix.startsWith(b.prefix) || b.prefix.startsWith(a.prefix);
  // Co-finite sets and patterns each hold infinitely many strings, and any two of them share one.
  return true;
}

/** Whether every input `b` matches, `a` matches too. */
export function covers(a: ValueSet, b: ValueSet): boolean {
  if (b.empty && !a.empty) return false;
  if (a.kind === 'num' && b.kind === 'num') {
    const merged = mergeIv(a.iv);
    return b.iv.every((x) => merged.some((y) => (y.lo < x.lo || (y.lo === x.lo && (y.loIn || !x.loIn))) && (y.hi > x.hi || (y.hi === x.hi && (y.hiIn || !x.hiIn)))));
  }
  if (a.kind === 'num' || b.kind === 'num') return false;
  if (b.kind === 'fin') return [...b.vals].every((v) => member(a, v));
  if (b.kind === 'cofin') return a.kind === 'cofin' && [...a.vals].every((v) => b.vals.has(v));
  // b is a pattern.
  const bp = b as { prefix?: string; contains?: string };
  if (a.kind === 'fin') return false;
  if (a.kind === 'cofin') return ![...a.vals].some((v) => patMatch(bp, v));
  const ap = a as { prefix?: string; contains?: string };
  if (ap.prefix !== undefined) return bp.prefix !== undefined && bp.prefix.startsWith(ap.prefix);
  return (bp.prefix ?? bp.contains ?? '').includes(ap.contains ?? '');
}

// ---------- evaluation ----------

/** An evaluation that cannot give a result: an input of the wrong type, or a unique or any policy broken. */
export class DecisionError extends Error {
  constructor(
    readonly code: 'input' | 'unique' | 'any',
    message: string,
    readonly rules: string[] = []
  ) {
    super(message);
  }
}

export interface TestTrace {
  column: string;
  test: string;
  value: unknown;
  passed: boolean;
}
export interface RuleTrace {
  rule: string;
  index: number;
  matched: boolean;
  /** The tests the rule makes (columns it does not test are left out); for a rule that missed, up to the first that failed. */
  tests: TestTrace[];
}
export interface Evaluation {
  hitPolicy: HitPolicy;
  aggregation: Aggregation | null;
  /** The rules that decided the result (all matching ones for collect), in table order. */
  matched: { rule: string; index: number }[];
  /** One value per output column; for collect without aggregation, a list per column. Null when nothing matched and no column has a default. */
  outputs: Record<string, unknown> | null;
  /** Collect without aggregation: each matching rule's outputs. */
  rows?: Record<string, unknown>[];
  /** Why: each rule and its tests. */
  explanation: RuleTrace[];
  summary: string;
}

const EMPTY: unique symbol = Symbol('empty');
type Value = string | number | boolean | typeof EMPTY;

/** An input as its column's type reads it. */
function coerce(v: unknown, c: InputColumn): Value {
  if (v === undefined || v === null || v === '') return EMPTY;
  switch (c.type) {
    case 'string':
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      break;
    case 'number': {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?([eE][-+]?\d+)?\s*$/.test(v)) return Number(v);
      break;
    }
    case 'boolean':
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 'false') return v === 'true';
      break;
    case 'date': {
      const ms = dateMs(v);
      if (ms != null) return ms;
      break;
    }
  }
  throw new DecisionError('input', `Input ${c.name} should be ${c.type === 'number' ? 'a number' : c.type === 'boolean' ? 'true or false' : c.type === 'date' ? 'a date (YYYY-MM-DD or ISO)' : 'text'}; it is ${JSON.stringify(v).slice(0, 80)}.`);
}

function matches(t: Test, v: Value, type: ColumnType): boolean {
  if (t.op === 'any') return true;
  if (t.op === 'empty') return v === EMPTY;
  if (v === EMPTY) return false;
  const val = (x: Scalar): string | number | boolean => (type === 'date' ? (dateMs(x) ?? NaN) : x);
  switch (t.op) {
    case 'eq':
      return v === val(t.value);
    case 'ne':
      return v !== val(t.value);
    case 'lt':
      return (v as number) < (val(t.value) as number);
    case 'lte':
      return (v as number) <= (val(t.value) as number);
    case 'gt':
      return (v as number) > (val(t.value) as number);
    case 'gte':
      return (v as number) >= (val(t.value) as number);
    case 'between':
      return (v as number) >= (val(t.min) as number) && (v as number) <= (val(t.max) as number);
    case 'in':
      return t.values.some((x) => v === val(x));
    case 'not_in':
      return !t.values.some((x) => v === val(x));
    case 'contains':
      return String(v).includes(String(t.value));
    case 'starts_with':
      return String(v).startsWith(String(t.value));
  }
}

const shown = (v: Value, c: InputColumn): unknown => (v === EMPTY ? null : c.type === 'date' ? new Date(v as number).toISOString() : v);

/** Evaluates a (checked) definition against the inputs: the matching rules, the outputs and why. */
export function evaluate(d: Definition, inputs: Record<string, unknown>): Evaluation {
  const values = new Map<string, Value>(d.inputs.map((c) => [c.name, coerce(inputs[c.name], c)]));
  const explanation: RuleTrace[] = [];
  const hits: number[] = [];
  d.rules.forEach((r, index) => {
    const tests: TestTrace[] = [];
    let matched = true;
    for (const c of d.inputs) {
      const t = r.when[c.name];
      if (!t || t.op === 'any') continue;
      const v = values.get(c.name)!;
      const passed = matches(t, v, c.type);
      tests.push({ column: c.name, test: cellText(t), value: shown(v, c), passed });
      if (!passed) {
        matched = false;
        break;
      }
    }
    explanation.push({ rule: r.id, index, matched, tests });
    if (matched) hits.push(index);
  });
  const ruleRef = (i: number) => ({ rule: d.rules[i]!.id, index: i });
  const outOf = (i: number) => Object.fromEntries(d.outputs.map((o) => [o.name, d.rules[i]!.then[o.name] ?? null]));
  const why = (i: number) => {
    const t = explanation[i]!.tests;
    return t.length ? t.map((x) => `${x.column} ${JSON.stringify(x.value)} ${x.test}`).join('; ') : 'it tests nothing, so it matches every input';
  };
  const defaults = (): Record<string, unknown> | null => (d.outputs.some((o) => o.default !== undefined) ? Object.fromEntries(d.outputs.map((o) => [o.name, o.default ?? null])) : null);
  const fmtOut = (o: Record<string, unknown> | null) => (o ? Object.entries(o).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ') : 'nothing');
  const base = { hitPolicy: d.hitPolicy, aggregation: d.aggregation ?? null, explanation };

  if (d.hitPolicy === 'collect') {
    const rows = hits.map(outOf);
    const matched = hits.map(ruleRef);
    if (d.aggregation) {
      const o = d.outputs[0]!;
      const xs = rows.map((r) => r[o.name]).filter((x): x is Scalar => x !== null && x !== undefined);
      let value: unknown;
      if (d.aggregation === 'count') value = hits.length;
      else if (d.aggregation === 'sum') value = xs.reduce<number>((a, b) => a + Number(b), 0);
      else if (!xs.length) value = null;
      else {
        const pick = d.aggregation === 'min' ? (a: Scalar, b: Scalar) => (ordinal(b, o.type) < ordinal(a, o.type) ? b : a) : (a: Scalar, b: Scalar) => (ordinal(b, o.type) > ordinal(a, o.type) ? b : a);
        value = xs.reduce(pick);
      }
      const outputs = { [o.name]: value };
      return { ...base, matched, outputs, summary: hits.length ? `${hits.length} rule${hits.length === 1 ? '' : 's'} matched (${matched.map((m) => m.rule).join(', ')}); collect with ${d.aggregation}: ${fmtOut(outputs)}.` : `No rule matched; collect with ${d.aggregation} gives ${fmtOut(outputs)}.` };
    }
    const outputs = Object.fromEntries(d.outputs.map((o) => [o.name, rows.map((r) => r[o.name])]));
    return { ...base, matched, outputs, rows, summary: hits.length ? `${hits.length} rule${hits.length === 1 ? '' : 's'} matched and were collected in order: ${matched.map((m) => m.rule).join(', ')}.` : 'No rule matched; nothing was collected.' };
  }

  if (!hits.length) {
    const outputs = defaults();
    return { ...base, matched: [], outputs, summary: outputs ? `No rule matched; the defaults apply: ${fmtOut(outputs)}.` : 'No rule matched.' };
  }
  let pick = hits[0]!;
  if (d.hitPolicy === 'unique' && hits.length > 1) {
    throw new DecisionError('unique', `The unique hit policy allows one matching rule, and ${hits.length} match: ${hits.map((i) => d.rules[i]!.id).join(', ')}.`, hits.map((i) => d.rules[i]!.id));
  }
  if (d.hitPolicy === 'any') {
    const first = JSON.stringify(outOf(hits[0]!));
    const other = hits.find((i) => JSON.stringify(outOf(i)) !== first);
    if (other !== undefined) throw new DecisionError('any', `The any hit policy needs every matching rule to give the same outputs; ${d.rules[hits[0]!]!.id} gives ${fmtOut(outOf(hits[0]!))} and ${d.rules[other]!.id} gives ${fmtOut(outOf(other))}.`, [d.rules[hits[0]!]!.id, d.rules[other]!.id]);
  }
  if (d.hitPolicy === 'priority') {
    const ranked = d.outputs.filter((o) => o.values?.length);
    const rank = (i: number) => ranked.map((o) => {
      const at = o.values!.indexOf(d.rules[i]!.then[o.name] as Scalar);
      return at < 0 ? Number.MAX_SAFE_INTEGER : at;
    });
    pick = hits.reduce((best, i) => {
      const a = rank(best);
      const b = rank(i);
      for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return b[k]! < a[k]! ? i : best;
      return best;
    }, hits[0]!);
  }
  const outputs = outOf(pick);
  const rule = d.rules[pick]!;
  const lead = d.hitPolicy === 'first' ? `Rule ${pick + 1} (${rule.id}) is the first that matches` : d.hitPolicy === 'priority' ? `${hits.length} rule${hits.length === 1 ? '' : 's'} matched; rule ${pick + 1} (${rule.id}) has the highest-priority outputs` : d.hitPolicy === 'any' ? `${hits.length} rule${hits.length === 1 ? '' : 's'} matched with the same outputs; rule ${pick + 1} (${rule.id}) is the first` : `Rule ${pick + 1} (${rule.id}) is the one rule that matches`;
  return { ...base, matched: d.hitPolicy === 'priority' || d.hitPolicy === 'first' || d.hitPolicy === 'unique' ? [ruleRef(pick)] : hits.map(ruleRef), outputs, summary: `${lead}: ${why(pick)}. Outputs: ${fmtOut(outputs)}.` };
}

/** The port type an output column gives a workflow step. */
export const portTypeOf = (t: ColumnType): 'string' | 'number' | 'boolean' => (t === 'date' ? 'string' : t);
