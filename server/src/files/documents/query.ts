import { z } from 'zod';
import { compileFormula, FormulaError } from '../../apps/formula.js';
import { serialDate } from '../../imports/xlsx.js';
import { COLUMN_TYPES, DOC_LIMITS, type CellValue, type ColumnType, type Sheet } from './model.js';
import { inferColumnType, parseBoolean, parseDate, parseDateTime, parseNumber } from './normalize.js';

/*
 * The table builder's query engine (Files, Power Query style). A query is a source table and a list of applied steps;
 * running it gives a table. Everything here is a pure function of tables: the service (`queries-service.ts`) reads
 * the files, checks access and labels, and writes the result.
 *
 * - A table is named, typed columns and rows of plain values (text, number, true or false, empty). Dates are ISO text
 *   (YYYY-MM-DD, or YYYY-MM-DDTHH:MM:SS), as in the Workbook model.
 * - A step is one entry of a fixed vocabulary (`stepSchema`), with options zod checks. There is no code: a custom
 *   column is a formula of the apps formula language (`apps/formula.ts`), which reads only the row's columns.
 * - A step that cannot run (a column it names is gone) stops the query there: the result is the table before it and
 *   the step's error, as Power Query shows it, so the person can fix or delete that step.
 * - Values a step cannot convert become empty and are counted in the step's warnings; nothing fails silently.
 * - Every table is held to the document limits (cells and columns), so a join cannot grow without bound.
 */

export class QueryError extends Error {}

export type QType = ColumnType | 'any';
export interface QColumn {
  name: string;
  type: QType;
}
export interface QTable {
  columns: QColumn[];
  rows: CellValue[][];
}

export const MAX_STEPS = 100;
const MAX_NEW_COLUMNS = 500;
const L = DOC_LIMITS;

// ---------- definitions ----------

const id26 = z.string().length(26);
const col = z.string().trim().min(1).max(200);
const cols = z.array(col).min(1).max(L.maxColumns);
const scalar = z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]);

export const sourceSchema = z.discriminatedUnion('kind', [
  /** A sheet of a spreadsheet file (the first when no sheet is named), or a CSV, TSV or JSON file. */
  z.object({ kind: z.literal('file'), fileId: id26, sheet: z.string().max(31).nullable().optional(), header: z.boolean().default(true) }).strict(),
  /** The result of another saved query (Power Query's Reference). */
  z.object({ kind: z.literal('query'), queryId: id26 }).strict()
]);
export type SourceRef = z.infer<typeof sourceSchema>;

export const FILTER_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'not-contains', 'starts', 'ends', 'empty', 'not-empty', 'in'] as const;
export const AGG_FNS = ['count', 'count-rows', 'count-distinct', 'sum', 'avg', 'min', 'max', 'median', 'first', 'last', 'concat'] as const;
export const JOIN_KINDS = ['left', 'inner', 'right', 'full', 'left-anti', 'right-anti'] as const;

const condition = z.object({ column: col, op: z.enum(FILTER_OPS), value: scalar.optional(), values: z.array(scalar).max(1000).optional(), caseSensitive: z.boolean().default(false) }).strict();

export const stepSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('promote-headers') }).strict(),
  z.object({ op: z.literal('demote-headers') }).strict(),
  z.object({ op: z.literal('change-type'), columns: z.array(z.object({ column: col, type: z.enum(COLUMN_TYPES) }).strict()).min(1).max(L.maxColumns), dayFirst: z.boolean().default(false) }).strict(),
  z.object({ op: z.literal('rename'), columns: z.array(z.object({ from: col, to: col }).strict()).min(1).max(L.maxColumns) }).strict(),
  z.object({ op: z.literal('remove-columns'), columns: cols }).strict(),
  /** Choose columns: only these, in this order. */
  z.object({ op: z.literal('keep-columns'), columns: cols }).strict(),
  /** These columns first, in this order; the rest after them as they were. */
  z.object({ op: z.literal('reorder'), columns: cols }).strict(),
  z.object({ op: z.literal('duplicate-column'), column: col, as: col }).strict(),
  z.object({ op: z.literal('filter'), match: z.enum(['all', 'any']).default('all'), conditions: z.array(condition).min(1).max(20) }).strict(),
  z.object({ op: z.literal('sort'), keys: z.array(z.object({ column: col, desc: z.boolean().default(false) }).strict()).min(1).max(10) }).strict(),
  /** Remove duplicates: rows equal in these columns (all when none are named) keep the first. */
  z.object({ op: z.literal('distinct'), columns: z.array(col).max(L.maxColumns).default([]) }).strict(),
  z.object({ op: z.literal('keep-rows'), mode: z.enum(['top', 'bottom', 'range']), count: z.number().int().min(0).max(L.maxCells), from: z.number().int().min(1).max(L.maxCells).default(1) }).strict(),
  z.object({ op: z.literal('remove-rows'), mode: z.enum(['top', 'bottom', 'blank', 'alternate']), count: z.number().int().min(0).max(L.maxCells).default(1), keep: z.number().int().min(1).max(L.maxCells).default(1) }).strict(),
  z.object({ op: z.literal('fill'), columns: cols, direction: z.enum(['down', 'up']).default('down') }).strict(),
  z.object({ op: z.literal('replace'), columns: cols, find: z.string().max(1000), replace: z.string().max(1000), match: z.enum(['whole', 'contains']).default('whole'), caseSensitive: z.boolean().default(false) }).strict(),
  z.object({ op: z.literal('replace-empty'), columns: cols, value: scalar }).strict(),
  z.object({ op: z.literal('text'), columns: cols, fn: z.enum(['trim', 'clean', 'lower', 'upper', 'title', 'prefix', 'suffix', 'length', 'first', 'last']), value: z.string().max(1000).optional(), count: z.number().int().min(0).max(32_767).optional() }).strict(),
  z.object({ op: z.literal('number'), columns: cols, fn: z.enum(['round', 'abs', 'add', 'subtract', 'multiply', 'divide', 'percent-of', 'negate']), value: z.number().optional(), digits: z.number().int().min(0).max(15).optional() }).strict(),
  z.object({ op: z.literal('split'), column: col, delimiter: z.string().min(1).max(20), mode: z.enum(['each', 'first', 'last']).default('each'), into: z.array(col).max(50).optional() }).strict(),
  z.object({ op: z.literal('merge-columns'), columns: z.array(col).min(2).max(50), separator: z.string().max(20).default(' '), as: col }).strict(),
  /** A column computed by a formula; `[Column name]` reads a column, bare names work for names without spaces. */
  z.object({ op: z.literal('custom'), as: col, formula: z.string().min(1).max(2000), type: z.enum(COLUMN_TYPES).optional() }).strict(),
  z.object({ op: z.literal('conditional'), as: col, rules: z.array(z.object({ column: col, op: z.enum(FILTER_OPS), value: scalar.optional(), values: z.array(scalar).max(1000).optional(), caseSensitive: z.boolean().default(false), then: scalar }).strict()).min(1).max(20), otherwise: scalar.default(null) }).strict(),
  z.object({ op: z.literal('index'), as: col.default('Index'), start: z.number().int().default(1), step: z.number().int().default(1) }).strict(),
  z.object({ op: z.literal('group'), by: z.array(col).max(20), aggregates: z.array(z.object({ as: col, fn: z.enum(AGG_FNS), column: col.optional(), separator: z.string().max(20).optional() }).strict()).min(1).max(50) }).strict(),
  /** The values of `column` become columns holding `values` aggregated by `fn`, one row per combination of the rest. */
  z.object({ op: z.literal('pivot'), column: col, values: col, fn: z.enum(AGG_FNS).default('sum') }).strict(),
  /** These columns (or, with `others`, every column but these) become attribute and value rows. */
  z.object({ op: z.literal('unpivot'), columns: cols, others: z.boolean().default(false), attribute: col.default('Attribute'), value: col.default('Value') }).strict(),
  z.object({ op: z.literal('transpose') }).strict(),
  /** Rows of other tables after these, columns matched by name (a column one table lacks is empty there). */
  z.object({ op: z.literal('append'), sources: z.array(sourceSchema).min(1).max(10) }).strict(),
  /** Merge queries: a join on key columns; the other table's other columns (or those named) come in with `prefix`. */
  z
    .object({ op: z.literal('merge'), source: sourceSchema, left: z.array(col).min(1).max(10), right: z.array(col).min(1).max(10), kind: z.enum(JOIN_KINDS).default('left'), columns: z.array(col).max(L.maxColumns).optional(), prefix: z.string().max(60).optional(), caseSensitive: z.boolean().default(true) })
    .strict()
    .refine((s) => s.left.length === s.right.length, 'a merge pairs as many key columns on each side')
]);
export type Step = z.infer<typeof stepSchema>;

export const definitionSchema = z.object({ source: sourceSchema, steps: z.array(stepSchema).max(MAX_STEPS).default([]) }).strict();
export type QueryDefinition = z.infer<typeof definitionSchema>;

/** An untrusted definition from a request, checked; a QueryError says where it is wrong. */
export function validateDefinition(input: unknown): QueryDefinition {
  const r = definitionSchema.safeParse(input);
  if (!r.success) {
    const issue = r.error.issues[0]!;
    const at = issue.path.length ? issue.path.join('.') : 'its top level';
    throw new QueryError(`The query is not valid at ${at}: ${issue.message}`);
  }
  return r.data;
}

/** A key for a source, the same for two references to the same table. */
export const sourceKey = (s: SourceRef): string => (s.kind === 'query' ? `q:${s.queryId}` : `f:${s.fileId}:${s.sheet ?? ''}:${s.header ? 1 : 0}`);

/** Every source a definition reads: its own and those its append and merge steps name. */
export function sourcesOf(def: QueryDefinition): SourceRef[] {
  const out = new Map<string, SourceRef>([[sourceKey(def.source), def.source]]);
  for (const s of def.steps) {
    if (s.op === 'append') for (const x of s.sources) out.set(sourceKey(x), x);
    if (s.op === 'merge') out.set(sourceKey(s.source), s.source);
  }
  return [...out.values()];
}

// ---------- tables from sheets ----------

/** Unique, non-empty column names (Power Query's Column1, Column2 … for empty ones; "Name (2)" for repeats). */
export function uniqueNames(raw: string[]): string[] {
  const seen = new Set<string>();
  return raw.map((n, i) => {
    let base = (n ?? '').trim().slice(0, 200) || `Column${i + 1}`;
    if (seen.has(base.toLowerCase())) {
      let k = 2;
      while (seen.has(`${base} (${k})`.toLowerCase())) k++;
      base = `${base} (${k})`;
    }
    seen.add(base.toLowerCase());
    return base;
  });
}

const typeOfValues = (values: CellValue[]): QType => {
  const vals = values.filter((v) => v != null && v !== '');
  if (!vals.length) return 'any';
  if (vals.every((v) => typeof v === 'number')) return vals.every((v) => Number.isInteger(v)) ? 'integer' : 'number';
  if (vals.every((v) => typeof v === 'boolean')) return 'boolean';
  return 'any';
};

/** A sheet of the Workbook model as a table: the first row as names when `header`, values as stored. */
export function sheetTable(sheet: Sheet, header: boolean): QTable {
  const width = Math.max(0, ...sheet.rows.map((r) => r.length), header ? 0 : sheet.columns.length);
  const valueRows = sheet.rows.map((r) => Array.from({ length: width }, (_, c) => r[c]?.v ?? null));
  const head = header && valueRows.length ? valueRows.shift()! : null;
  const names = uniqueNames(Array.from({ length: width }, (_, c) => (head ? (head[c] == null ? '' : String(head[c])) : `Column${c + 1}`)));
  return { columns: names.map((name, c) => ({ name, type: typeOfValues(valueRows.map((r) => r[c] ?? null)) })), rows: valueRows };
}

/** A JSON file as a table: an array of objects (keys as columns) or of arrays; nested values as JSON text. */
export function jsonTable(text: string): QTable {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new QueryError('The JSON file could not be read.');
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    // One array property (an API's { "items": [...] }) is read as the table.
    const arrays = Object.values(data as Record<string, unknown>).filter(Array.isArray);
    data = arrays.length === 1 ? arrays[0] : [data];
  }
  if (!Array.isArray(data)) throw new QueryError('A JSON file is read as a table when it holds an array of objects.');
  const flat = (v: unknown): CellValue => (v == null ? null : typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : JSON.stringify(v).slice(0, L.maxCellChars));
  if (data.every((r) => Array.isArray(r))) {
    const width = Math.max(0, ...data.map((r: unknown[]) => r.length));
    const t: QTable = { columns: uniqueNames(Array.from({ length: width }, (_, i) => `Column${i + 1}`)).map((name) => ({ name, type: 'any' })), rows: data.map((r: unknown[]) => Array.from({ length: width }, (_, i) => flat(r[i]))) };
    check(t);
    return t;
  }
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const r of data) {
    if (!r || typeof r !== 'object') continue;
    for (const k of Object.keys(r)) if (!seen.has(k)) {
      seen.add(k);
      keys.push(k);
      if (keys.length > L.maxColumns) throw new QueryError(`The JSON has more than ${L.maxColumns} keys.`);
    }
  }
  const names = uniqueNames(keys);
  const rows = data.map((r) => keys.map((k) => (r && typeof r === 'object' ? flat((r as Record<string, unknown>)[k]) : null)));
  const t: QTable = { columns: names.map((name, i) => ({ name, type: typeOfValues(rows.map((x) => x[i] ?? null)) })), rows };
  check(t);
  return t;
}

/** A table as one sheet of the Workbook model, with a header row of its names and the column types. */
export function tableSheet(t: QTable, name: string): Sheet {
  return {
    name,
    header: true,
    columns: t.columns.map((c) => ({ name: c.name, type: c.type === 'any' ? 'text' : c.type })),
    rows: [t.columns.map((c) => ({ v: c.name })), ...t.rows.map((r) => r.map((v) => ({ v })))]
  };
}

// ---------- values ----------

const isEmpty = (v: CellValue): boolean => v == null || (typeof v === 'string' && v.trim() === '');
const text = (v: CellValue): string => (v == null ? '' : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? 'true' : 'false') : v);
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Order of two values: empty last, numbers by size, text in a natural order. */
export function compareValues(a: CellValue, b: CellValue): number {
  const ea = isEmpty(a);
  const eb = isEmpty(b);
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  if (typeof a === 'number' && typeof b === 'string') {
    const n = parseNumber(b);
    if (n != null) return a - n;
  }
  if (typeof b === 'number' && typeof a === 'string') {
    const n = parseNumber(a);
    if (n != null) return n - b;
  }
  return collator.compare(text(a), text(b));
}

/** A value as a column of `type` holds it, or `undefined` when it does not convert. */
export function convert(v: CellValue, type: ColumnType, dayFirst = false): CellValue | undefined {
  if (v == null) return null;
  if (typeof v === 'string' && v.trim() === '' && type !== 'text') return null;
  switch (type) {
    case 'text':
      return text(v);
    case 'number':
    case 'integer': {
      const n = typeof v === 'number' ? v : typeof v === 'boolean' ? Number(v) : parseNumber(v);
      if (n == null || !Number.isFinite(n)) return undefined;
      return type === 'integer' ? Math.round(n) : n;
    }
    case 'boolean':
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : undefined;
      return parseBoolean(v) ?? undefined;
    case 'date':
    case 'datetime': {
      if (typeof v === 'boolean') return undefined;
      if (typeof v === 'number') {
        const d = serialDate(v, false);
        if (!d) return undefined;
        return type === 'date' ? d.slice(0, 10) : d.length === 10 ? `${d}T00:00:00` : d;
      }
      const s = v.trim();
      const dt = parseDateTime(s, dayFirst);
      const d = parseDate(s, dayFirst);
      if (type === 'date') return d ?? (dt ? dt.slice(0, 10) : undefined);
      return dt ?? (d ? `${d}T00:00:00` : undefined);
    }
    case 'email': {
      const s = text(v).trim();
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : undefined;
    }
    case 'url': {
      const s = text(v).trim();
      return /^https?:\/\/[^\s]+$/i.test(s) ? s : undefined;
    }
  }
}

// ---------- the engine ----------

export interface StepWarning {
  step: number;
  message: string;
}
export interface RunResult {
  table: QTable;
  /** How many steps ran: all of them, or those before the one that failed. */
  applied: number;
  error: { step: number; message: string } | null;
  warnings: StepWarning[];
}

function check(t: QTable): void {
  if (t.columns.length > L.maxColumns) throw new QueryError(`The table would have more than ${L.maxColumns.toLocaleString('en-US')} columns.`);
  const cells = t.rows.length * Math.max(1, t.columns.length);
  if (cells > L.maxCells) throw new QueryError(`The table would have more than ${L.maxCells.toLocaleString('en-US')} cells (${t.rows.length.toLocaleString('en-US')} rows of ${t.columns.length} columns).`);
}

const lower = (s: string) => s.toLowerCase();

function indexOf(t: QTable, name: string): number {
  let i = t.columns.findIndex((c) => c.name === name);
  if (i < 0) i = t.columns.findIndex((c) => lower(c.name) === lower(name));
  if (i < 0) throw new QueryError(`There is no column ${name}. Columns: ${t.columns.slice(0, 12).map((c) => c.name).join(', ')}${t.columns.length > 12 ? ', …' : ''}.`);
  return i;
}

function assertFree(t: QTable, name: string, except = -1): void {
  if (t.columns.some((c, i) => i !== except && lower(c.name) === lower(name))) throw new QueryError(`A column named ${name} already exists.`);
}

/** A test on one value; the filter, conditional column and merge use the same one. */
function tester(c: { op: (typeof FILTER_OPS)[number]; value?: CellValue; values?: CellValue[]; caseSensitive: boolean }): (v: CellValue) => boolean {
  const cs = c.caseSensitive;
  const norm = (s: string) => (cs ? s : s.toLowerCase());
  const want = c.value ?? null;
  const wantText = norm(text(want));
  switch (c.op) {
    case 'empty':
      return isEmpty;
    case 'not-empty':
      return (v) => !isEmpty(v);
    case 'eq': {
      // Numbers equal by value ('1,200' = 1200); everything else by its text.
      const wantNum = typeof want === 'number' ? want : typeof want === 'string' ? parseNumber(want) : null;
      return (v) => {
        if (isEmpty(want)) return isEmpty(v);
        if (isEmpty(v)) return false;
        if (wantNum != null) {
          const n = typeof v === 'number' ? v : typeof v === 'string' ? parseNumber(v) : null;
          if (n != null) return n === wantNum;
        }
        return norm(text(v)) === wantText;
      };
    }
    case 'ne': {
      const eq = tester({ ...c, op: 'eq' });
      return (v) => !eq(v);
    }
    case 'gt':
      return (v) => !isEmpty(v) && compareValues(v, want) > 0;
    case 'gte':
      return (v) => !isEmpty(v) && compareValues(v, want) >= 0;
    case 'lt':
      return (v) => !isEmpty(v) && compareValues(v, want) < 0;
    case 'lte':
      return (v) => !isEmpty(v) && compareValues(v, want) <= 0;
    case 'contains':
      return (v) => norm(text(v)).includes(wantText);
    case 'not-contains':
      return (v) => !norm(text(v)).includes(wantText);
    case 'starts':
      return (v) => norm(text(v)).startsWith(wantText);
    case 'ends':
      return (v) => norm(text(v)).endsWith(wantText);
    case 'in': {
      const set = new Set((c.values ?? []).map((x) => norm(text(x))));
      return (v) => set.has(norm(text(v)));
    }
  }
}

const keyOf = (row: CellValue[], at: number[], cs = true): string => JSON.stringify(at.map((i) => { const v = row[i] ?? null; return typeof v === 'string' && !cs ? v.toLowerCase() : v; }));

function aggregate(fn: (typeof AGG_FNS)[number], values: CellValue[], rows: number, sep = ', '): CellValue {
  const present = values.filter((v) => !isEmpty(v));
  const nums = present.map((v) => (typeof v === 'number' ? v : typeof v === 'string' ? parseNumber(v) : null)).filter((n): n is number => n != null);
  switch (fn) {
    case 'count-rows':
      return rows;
    case 'count':
      return present.length;
    case 'count-distinct':
      return new Set(present.map((v) => JSON.stringify(v))).size;
    case 'sum':
      return nums.length ? round15(nums.reduce((a, b) => a + b, 0)) : null;
    case 'avg':
      return nums.length ? round15(nums.reduce((a, b) => a + b, 0) / nums.length) : null;
    case 'median': {
      if (!nums.length) return null;
      const s = [...nums].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      return s.length % 2 ? s[m]! : round15((s[m - 1]! + s[m]!) / 2);
    }
    case 'min':
      return present.length ? present.reduce((a, b) => (compareValues(b, a) < 0 ? b : a)) : null;
    case 'max':
      return present.length ? present.reduce((a, b) => (compareValues(b, a) > 0 ? b : a)) : null;
    case 'first':
      return values[0] ?? null;
    case 'last':
      return values.length ? (values[values.length - 1] ?? null) : null;
    case 'concat':
      return present.map(text).join(sep).slice(0, L.maxCellChars);
  }
}

/** Sums of decimals without the binary tail (0.1 + 0.2 is 0.3). */
const round15 = (n: number): number => (Number.isFinite(n) ? Number(n.toPrecision(15)) : n);

const toTitle = (s: string) => s.toLowerCase().replace(/(^|[\s\-_/(])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());

/** `[Column name]` in a formula as identifiers the formula language reads; brackets inside quotes are left alone. */
function rewriteFormula(src: string, t: QTable): { src: string; fields: Map<string, number> } {
  const fields = new Map<string, number>();
  t.columns.forEach((c, i) => {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.name)) fields.set(c.name, i);
  });
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < src.length && (src[j] !== ch || src[j + 1] === ch)) j += src[j] === ch ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === '[') {
      const end = src.indexOf(']', i + 1);
      if (end < 0) throw new QueryError('A [column] in the formula is not closed.');
      const name = src.slice(i + 1, end).trim();
      const c = indexOf(t, name);
      const id = `__c${c}`;
      fields.set(id, c);
      out += id;
      i = end;
      continue;
    }
    out += ch;
  }
  return { src: out, fields };
}

/** Runs one step on a table; `others` holds the tables of append and merge sources. */
function apply(t: QTable, s: Step, others: ReadonlyMap<string, QTable>, warn: (m: string) => void): QTable {
  const other = (ref: SourceRef): QTable => {
    const o = others.get(sourceKey(ref));
    if (!o) throw new QueryError('A table this step reads could not be loaded.');
    return o;
  };
  const at = (names: string[]) => names.map((n) => indexOf(t, n));
  const mapCols = (names: string[], f: (v: CellValue, c: number) => CellValue): QTable => {
    const idx = new Set(at(names));
    return { columns: t.columns, rows: t.rows.map((r) => r.map((v, c) => (idx.has(c) ? f(v ?? null, c) : v))) };
  };

  switch (s.op) {
    case 'promote-headers': {
      if (!t.rows.length) return t;
      const [head, ...rest] = t.rows;
      const names = uniqueNames(t.columns.map((_, c) => text(head![c] ?? null)));
      return { columns: names.map((name, c) => ({ name, type: typeOfValues(rest.map((r) => r[c] ?? null)) })), rows: rest };
    }
    case 'demote-headers':
      return { columns: t.columns.map((_, i) => ({ name: `Column${i + 1}`, type: 'any' })), rows: [t.columns.map((c) => c.name), ...t.rows] };
    case 'change-type': {
      const columns = [...t.columns];
      const plan = s.columns.map((x) => ({ c: indexOf(t, x.column), type: x.type }));
      const failed = new Map<number, number>();
      for (const p of plan) columns[p.c] = { ...columns[p.c]!, type: p.type };
      const rows = t.rows.map((r) => {
        const out = [...r];
        for (const p of plan) {
          const v = convert(r[p.c] ?? null, p.type, s.dayFirst);
          if (v === undefined) {
            failed.set(p.c, (failed.get(p.c) ?? 0) + 1);
            out[p.c] = null;
          } else out[p.c] = v;
        }
        return out;
      });
      for (const [c, n] of failed) warn(`${n.toLocaleString('en-US')} value${n === 1 ? '' : 's'} in ${t.columns[c]!.name} could not be read as ${columns[c]!.type} and ${n === 1 ? 'is' : 'are'} now empty.`);
      return { columns, rows };
    }
    case 'rename': {
      const columns = t.columns.map((c) => ({ ...c }));
      for (const x of s.columns) {
        const i = indexOf({ columns, rows: [] }, x.from);
        assertFree({ columns, rows: [] }, x.to, i);
        columns[i]!.name = x.to;
      }
      return { columns, rows: t.rows };
    }
    case 'remove-columns': {
      const drop = new Set(at(s.columns));
      const keep = t.columns.map((_, i) => i).filter((i) => !drop.has(i));
      return { columns: keep.map((i) => t.columns[i]!), rows: t.rows.map((r) => keep.map((i) => r[i] ?? null)) };
    }
    case 'keep-columns':
    case 'reorder': {
      const first = at(s.columns);
      if (new Set(first).size !== first.length) throw new QueryError('A column is named twice.');
      const order = s.op === 'keep-columns' ? first : [...first, ...t.columns.map((_, i) => i).filter((i) => !first.includes(i))];
      return { columns: order.map((i) => t.columns[i]!), rows: t.rows.map((r) => order.map((i) => r[i] ?? null)) };
    }
    case 'duplicate-column': {
      const c = indexOf(t, s.column);
      assertFree(t, s.as);
      return { columns: [...t.columns, { name: s.as, type: t.columns[c]!.type }], rows: t.rows.map((r) => [...r, r[c] ?? null]) };
    }
    case 'filter': {
      const tests = s.conditions.map((c) => ({ i: indexOf(t, c.column), f: tester(c) }));
      const rows = t.rows.filter((r) => (s.match === 'all' ? tests.every((x) => x.f(r[x.i] ?? null)) : tests.some((x) => x.f(r[x.i] ?? null))));
      return { columns: t.columns, rows };
    }
    case 'sort': {
      const keys = s.keys.map((k) => ({ i: indexOf(t, k.column), d: k.desc ? -1 : 1 }));
      const rows = t.rows.map((r, n) => ({ r, n }));
      rows.sort((a, b) => {
        for (const k of keys) {
          const va = a.r[k.i] ?? null;
          const vb = b.r[k.i] ?? null;
          // Empty values stay last whichever way the column is sorted.
          if (isEmpty(va) || isEmpty(vb)) {
            const c = compareValues(va, vb);
            if (c) return c;
            continue;
          }
          const c = compareValues(va, vb) * k.d;
          if (c) return c;
        }
        return a.n - b.n;
      });
      return { columns: t.columns, rows: rows.map((x) => x.r) };
    }
    case 'distinct': {
      const idx = s.columns.length ? at(s.columns) : t.columns.map((_, i) => i);
      const seen = new Set<string>();
      const rows = t.rows.filter((r) => {
        const k = keyOf(r, idx);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      if (rows.length < t.rows.length) warn(`${(t.rows.length - rows.length).toLocaleString('en-US')} duplicate rows removed.`);
      return { columns: t.columns, rows };
    }
    case 'keep-rows':
      return { columns: t.columns, rows: s.mode === 'top' ? t.rows.slice(0, s.count) : s.mode === 'bottom' ? t.rows.slice(Math.max(0, t.rows.length - s.count)) : t.rows.slice(s.from - 1, s.from - 1 + s.count) };
    case 'remove-rows': {
      if (s.mode === 'top') return { columns: t.columns, rows: t.rows.slice(s.count) };
      if (s.mode === 'bottom') return { columns: t.columns, rows: t.rows.slice(0, Math.max(0, t.rows.length - s.count)) };
      if (s.mode === 'blank') return { columns: t.columns, rows: t.rows.filter((r) => !r.every((v) => isEmpty(v ?? null))) };
      // Alternate: remove `count` rows, keep `keep` rows, repeating.
      const period = s.count + s.keep;
      return { columns: t.columns, rows: s.count ? t.rows.filter((_, n) => n % period >= s.count) : t.rows };
    }
    case 'fill': {
      const idx = at(s.columns);
      const rows = t.rows.map((r) => [...r]);
      for (const c of idx) {
        let last: CellValue = null;
        const order = s.direction === 'down' ? rows : [...rows].reverse();
        for (const r of order) {
          if (isEmpty(r[c] ?? null)) r[c] = last;
          else last = r[c] ?? null;
        }
      }
      return { columns: t.columns, rows };
    }
    case 'replace': {
      const find = s.caseSensitive ? s.find : s.find.toLowerCase();
      let n = 0;
      const out = mapCols(s.columns, (v) => {
        if (s.match === 'whole') {
          const hit = s.find === '' ? isEmpty(v) : (s.caseSensitive ? text(v) : text(v).toLowerCase()) === find;
          if (!hit) return v;
          n++;
          return s.replace;
        }
        if (v == null || s.find === '') return v;
        const src = text(v);
        const hay = s.caseSensitive ? src : src.toLowerCase();
        if (!hay.includes(find)) return v;
        n++;
        let res = '';
        let from = 0;
        for (let k = hay.indexOf(find); k >= 0; k = hay.indexOf(find, k + find.length)) {
          res += src.slice(from, k) + s.replace;
          from = k + find.length;
        }
        return (res + src.slice(from)).slice(0, L.maxCellChars);
      });
      warn(`${n.toLocaleString('en-US')} value${n === 1 ? '' : 's'} replaced.`);
      return out;
    }
    case 'replace-empty':
      return mapCols(s.columns, (v) => (isEmpty(v) ? s.value : v));
    case 'text': {
      const value = s.value ?? '';
      const count = s.count ?? 1;
      const out = mapCols(s.columns, (v) => {
        if (v == null) return v;
        const x = text(v);
        switch (s.fn) {
          case 'trim':
            return x.trim();
          case 'clean':
            // Power Query's Clean: control characters out.
            return [...x].filter((ch) => { const c = ch.charCodeAt(0); return c >= 32 && c !== 127; }).join('');
          case 'lower':
            return x.toLowerCase();
          case 'upper':
            return x.toUpperCase();
          case 'title':
            return toTitle(x);
          case 'prefix':
            return (value + x).slice(0, L.maxCellChars);
          case 'suffix':
            return (x + value).slice(0, L.maxCellChars);
          case 'length':
            return [...x].length;
          case 'first':
            return [...x].slice(0, count).join('');
          case 'last':
            return count ? [...x].slice(-count).join('') : '';
        }
      });
      if (s.fn === 'length') return { columns: out.columns.map((c, i) => (at(s.columns).includes(i) ? { ...c, type: 'integer' } : c)), rows: out.rows };
      return { columns: out.columns.map((c, i) => (at(s.columns).includes(i) && c.type !== 'any' ? { ...c, type: 'text' } : c)), rows: out.rows };
    }
    case 'number': {
      if (s.fn !== 'round' && s.fn !== 'abs' && s.fn !== 'negate' && s.value == null) throw new QueryError(`${s.fn} needs a value.`);
      const k = s.value ?? 0;
      let skipped = 0;
      const out = mapCols(s.columns, (v) => {
        if (isEmpty(v)) return null;
        const n = typeof v === 'number' ? v : typeof v === 'string' ? parseNumber(v) : null;
        if (n == null) {
          skipped++;
          return v;
        }
        const r =
          s.fn === 'round' ? Number(n.toFixed(s.digits ?? 0))
          : s.fn === 'abs' ? Math.abs(n)
          : s.fn === 'negate' ? -n
          : s.fn === 'add' ? n + k
          : s.fn === 'subtract' ? n - k
          : s.fn === 'multiply' ? n * k
          : s.fn === 'divide' ? (k === 0 ? null : n / k)
          : k === 0 ? null : (n / k) * 100;
        return r == null || !Number.isFinite(r) ? null : round15(r);
      });
      if (skipped) warn(`${skipped.toLocaleString('en-US')} value${skipped === 1 ? ' is' : 's are'} not a number and ${skipped === 1 ? 'was' : 'were'} left as ${skipped === 1 ? 'it was' : 'they were'}.`);
      const idx = at(s.columns);
      return { columns: out.columns.map((c, i) => (idx.includes(i) ? { ...c, type: s.fn === 'round' && !(s.digits ?? 0) ? 'integer' : 'number' } : c)), rows: out.rows };
    }
    case 'split': {
      const c = indexOf(t, s.column);
      const parts = t.rows.map((r) => {
        const v = r[c] ?? null;
        if (v == null) return [] as string[];
        const x = text(v);
        if (s.mode === 'each') return x.split(s.delimiter);
        const k = s.mode === 'first' ? x.indexOf(s.delimiter) : x.lastIndexOf(s.delimiter);
        return k < 0 ? [x] : [x.slice(0, k), x.slice(k + s.delimiter.length)];
      });
      const width = s.into?.length ?? Math.min(50, Math.max(1, ...parts.map((p) => p.length)));
      const names = s.into ?? Array.from({ length: width }, (_, i) => `${t.columns[c]!.name}.${i + 1}`);
      const rest = t.columns.filter((_, i) => i !== c);
      for (const n of names) assertFree({ columns: rest, rows: [] }, n);
      // The last new column takes whatever is left.
      const fit = (p: string[]) => (p.length > width ? [...p.slice(0, width - 1), p.slice(width - 1).join(s.delimiter)] : p);
      const columns = [...t.columns.slice(0, c), ...names.map((name) => ({ name, type: 'any' as const })), ...t.columns.slice(c + 1)];
      const rows = t.rows.map((r, n) => {
        const p = fit(parts[n]!);
        return [...r.slice(0, c), ...Array.from({ length: width }, (_, i) => p[i] ?? null), ...r.slice(c + 1)];
      });
      const out = { columns, rows };
      check(out);
      return out;
    }
    case 'merge-columns': {
      const idx = at(s.columns);
      const first = Math.min(...idx);
      const drop = new Set(idx);
      const keep = t.columns.map((_, i) => i).filter((i) => !drop.has(i));
      const rest = keep.map((i) => t.columns[i]!);
      assertFree({ columns: rest, rows: [] }, s.as);
      const pos = keep.filter((i) => i < first).length;
      const columns = [...rest.slice(0, pos), { name: s.as, type: 'text' as const }, ...rest.slice(pos)];
      const rows = t.rows.map((r) => {
        const merged = idx.map((i) => r[i] ?? null).filter((v) => !isEmpty(v)).map(text).join(s.separator).slice(0, L.maxCellChars);
        const kept = keep.map((i) => r[i] ?? null);
        return [...kept.slice(0, pos), merged, ...kept.slice(pos)];
      });
      return { columns, rows };
    }
    case 'custom': {
      assertFree(t, s.as);
      const { src, fields } = rewriteFormula(s.formula, t);
      let f;
      try {
        f = compileFormula(src, new Set(fields.keys()));
      } catch (err) {
        if (err instanceof FormulaError) throw new QueryError(`The formula is not valid: ${err.message.replace(/__c(\d+)/g, (_m, n: string) => `[${t.columns[Number(n)]?.name ?? n}]`)}`);
        throw err;
      }
      const reads = f.refs.map((name) => [name, fields.get(name)!] as const);
      let failed = 0;
      const values = t.rows.map((r) => {
        const m = new Map<string, unknown>(reads.map(([name, i]) => [name, r[i] ?? null]));
        try {
          const v = f.evaluate(m);
          return typeof v === 'string' ? v.slice(0, L.maxCellChars) : v;
        } catch {
          failed++;
          return null;
        }
      });
      if (failed) warn(`The formula could not finish for ${failed.toLocaleString('en-US')} row${failed === 1 ? '' : 's'}; ${failed === 1 ? 'it is' : 'they are'} empty.`);
      let type: QType = s.type ?? typeOfValues(values);
      let out = values;
      if (s.type) {
        let bad = 0;
        out = values.map((v) => {
          const c = convert(v, s.type!);
          if (c === undefined) {
            bad++;
            return null;
          }
          return c;
        });
        if (bad) warn(`${bad.toLocaleString('en-US')} result${bad === 1 ? '' : 's'} could not be read as ${s.type} and ${bad === 1 ? 'is' : 'are'} empty.`);
        type = s.type;
      }
      return { columns: [...t.columns, { name: s.as, type }], rows: t.rows.map((r, n) => [...r, out[n] ?? null]) };
    }
    case 'conditional': {
      assertFree(t, s.as);
      const rules = s.rules.map((r) => ({ i: indexOf(t, r.column), f: tester(r), then: r.then }));
      const values = t.rows.map((r) => {
        for (const x of rules) if (x.f(r[x.i] ?? null)) return x.then;
        return s.otherwise;
      });
      return { columns: [...t.columns, { name: s.as, type: typeOfValues(values) }], rows: t.rows.map((r, n) => [...r, values[n] ?? null]) };
    }
    case 'index': {
      assertFree(t, s.as);
      return { columns: [...t.columns, { name: s.as, type: 'integer' }], rows: t.rows.map((r, n) => [...r, s.start + n * s.step]) };
    }
    case 'group': {
      const by = at(s.by);
      const aggs = s.aggregates.map((a) => {
        if (a.fn !== 'count-rows' && !a.column) throw new QueryError(`${a.as}: ${a.fn} needs a column.`);
        return { ...a, i: a.column ? indexOf(t, a.column) : -1 };
      });
      const names = [...by.map((i) => t.columns[i]!.name), ...aggs.map((a) => a.as)];
      if (new Set(names.map(lower)).size !== names.length) throw new QueryError('Two columns of the grouped table have the same name.');
      const groups = new Map<string, CellValue[][]>();
      for (const r of t.rows) {
        const k = keyOf(r, by);
        const g = groups.get(k);
        if (g) g.push(r);
        else groups.set(k, [r]);
      }
      if (!by.length && !groups.size) groups.set('[]', []);
      const rows = [...groups.values()].map((g) => [...by.map((i) => g[0]?.[i] ?? null), ...aggs.map((a) => aggregate(a.fn, a.i >= 0 ? g.map((r) => r[a.i] ?? null) : [], g.length, a.separator))]);
      const columns: QColumn[] = [...by.map((i) => t.columns[i]!), ...aggs.map((a, k) => ({ name: a.as, type: a.fn.startsWith('count') ? ('integer' as const) : typeOfValues(rows.map((r) => r[by.length + k] ?? null)) }))];
      return { columns, rows };
    }
    case 'pivot': {
      const pc = indexOf(t, s.column);
      const vc = indexOf(t, s.values);
      const rest = t.columns.map((_, i) => i).filter((i) => i !== pc && i !== vc);
      const heads: string[] = [];
      const headAt = new Map<string, number>();
      for (const r of t.rows) {
        const h = isEmpty(r[pc] ?? null) ? '(empty)' : text(r[pc] ?? null);
        if (!headAt.has(h)) {
          if (heads.length >= MAX_NEW_COLUMNS) throw new QueryError(`${t.columns[pc]!.name} has more than ${MAX_NEW_COLUMNS} different values; a pivot makes one column of each.`);
          headAt.set(h, heads.length);
          heads.push(h);
        }
      }
      const groups = new Map<string, { key: CellValue[]; cells: CellValue[][] }>();
      for (const r of t.rows) {
        const k = keyOf(r, rest);
        let g = groups.get(k);
        if (!g) {
          g = { key: rest.map((i) => r[i] ?? null), cells: heads.map(() => []) };
          groups.set(k, g);
        }
        g.cells[headAt.get(isEmpty(r[pc] ?? null) ? '(empty)' : text(r[pc] ?? null))!]!.push(r[vc] ?? null);
      }
      const newNames = uniqueNames([...rest.map((i) => t.columns[i]!.name), ...heads]).slice(rest.length);
      const rows = [...groups.values()].map((g) => [...g.key, ...g.cells.map((c) => (c.length ? aggregate(s.fn, c, c.length) : null))]);
      const out: QTable = { columns: [...rest.map((i) => t.columns[i]!), ...newNames.map((name, k) => ({ name, type: typeOfValues(rows.map((r) => r[rest.length + k] ?? null)) }))], rows };
      check(out);
      return out;
    }
    case 'unpivot': {
      const named = new Set(at(s.columns));
      const turn = t.columns.map((_, i) => i).filter((i) => (s.others ? !named.has(i) : named.has(i)));
      const keep = t.columns.map((_, i) => i).filter((i) => !turn.includes(i));
      const keptCols = keep.map((i) => t.columns[i]!);
      assertFree({ columns: keptCols, rows: [] }, s.attribute);
      assertFree({ columns: [...keptCols, { name: s.attribute, type: 'text' }], rows: [] }, s.value);
      const rows: CellValue[][] = [];
      for (const r of t.rows) {
        for (const i of turn) {
          const v = r[i] ?? null;
          if (isEmpty(v)) continue;
          rows.push([...keep.map((k) => r[k] ?? null), t.columns[i]!.name, v]);
          if (rows.length * (keep.length + 2) > L.maxCells) throw new QueryError(`The unpivoted table would have more than ${L.maxCells.toLocaleString('en-US')} cells.`);
        }
      }
      return { columns: [...keptCols, { name: s.attribute, type: 'text' }, { name: s.value, type: typeOfValues(rows.map((r) => r[keep.length + 1] ?? null)) }], rows };
    }
    case 'transpose': {
      if (t.rows.length > L.maxColumns) throw new QueryError(`A table with more than ${L.maxColumns} rows cannot be transposed (each row becomes a column).`);
      const rows = t.columns.map((_, c) => t.rows.map((r) => r[c] ?? null));
      return { columns: uniqueNames(t.rows.map((_, i) => `Column${i + 1}`)).map((name, i) => ({ name, type: typeOfValues(rows.map((r) => r[i] ?? null)) })), rows };
    }
    case 'append': {
      const columns = t.columns.map((c) => ({ ...c }));
      const tables = [t, ...s.sources.map(other)];
      for (const o of tables.slice(1)) for (const c of o.columns) if (!columns.some((x) => lower(x.name) === lower(c.name))) columns.push({ ...c });
      const rows: CellValue[][] = [];
      for (const o of tables) {
        const map = columns.map((c) => o.columns.findIndex((x) => lower(x.name) === lower(c.name)));
        for (const r of o.rows) rows.push(map.map((i) => (i < 0 ? null : (r[i] ?? null))));
      }
      columns.forEach((c, i) => {
        const types = new Set(tables.map((o) => o.columns.find((x) => lower(x.name) === lower(c.name))?.type).filter(Boolean));
        if (types.size > 1) c.type = typeOfValues(rows.map((r) => r[i] ?? null));
      });
      const out = { columns, rows };
      check(out);
      return out;
    }
    case 'merge': {
      const o = other(s.source);
      const li = at(s.left);
      const ri = s.right.map((n) => indexOf(o, n));
      const bring = (s.columns ?? o.columns.map((c) => c.name).filter((_, i) => !ri.includes(i))).map((n) => indexOf(o, n));
      const anti = s.kind === 'left-anti' || s.kind === 'right-anti';
      const prefix = s.prefix ?? '';
      const brought = bring.map((i) => ({ name: `${prefix}${o.columns[i]!.name}`, type: o.columns[i]!.type }));
      if (s.kind === 'right-anti') return { columns: o.columns, rows: rightOnly(t, o, li, ri, s.caseSensitive) };
      const columns = anti ? t.columns : [...t.columns, ...brought];
      if (!anti) {
        const seen = new Set<string>();
        for (const c of columns) {
          if (seen.has(lower(c.name))) throw new QueryError(`Both tables have a column ${c.name}; give the merge a prefix for the other table's columns.`);
          seen.add(lower(c.name));
        }
      }
      const index = new Map<string, number[]>();
      o.rows.forEach((r, n) => {
        if (ri.some((i) => isEmpty(r[i] ?? null))) return;
        const k = keyOf(r, ri, s.caseSensitive);
        const l = index.get(k);
        if (l) l.push(n);
        else index.set(k, [n]);
      });
      const rows: CellValue[][] = [];
      const matched = new Set<number>();
      const width = columns.length;
      for (const r of t.rows) {
        const hits = li.some((i) => isEmpty(r[i] ?? null)) ? undefined : index.get(keyOf(r, li, s.caseSensitive));
        if (s.kind === 'left-anti') {
          if (!hits) rows.push(r);
          continue;
        }
        if (hits) {
          for (const n of hits) {
            matched.add(n);
            rows.push([...r, ...bring.map((i) => o.rows[n]![i] ?? null)]);
            if (rows.length * width > L.maxCells) throw new QueryError(`The merged table would have more than ${L.maxCells.toLocaleString('en-US')} cells; the keys match too many rows.`);
          }
        } else if (s.kind === 'left' || s.kind === 'full') rows.push([...r, ...bring.map(() => null)]);
      }
      if (s.kind === 'right' || s.kind === 'full') {
        o.rows.forEach((r, n) => {
          if (matched.has(n)) return;
          // The other table's key fills this table's key columns, so a right join still shows its keys.
          const left: CellValue[] = t.columns.map(() => null);
          li.forEach((l, k) => (left[l] = r[ri[k]!] ?? null));
          rows.push([...left, ...bring.map((i) => r[i] ?? null)]);
        });
      }
      if (s.kind === 'inner' || s.kind === 'right') {
        const unmatched = t.rows.length - t.rows.filter((r) => !li.some((i) => isEmpty(r[i] ?? null)) && index.has(keyOf(r, li, s.caseSensitive))).length;
        if (unmatched) warn(`${unmatched.toLocaleString('en-US')} row${unmatched === 1 ? '' : 's'} had no match and ${unmatched === 1 ? 'was' : 'were'} left out.`);
      }
      const out = { columns, rows };
      check(out);
      return out;
    }
  }
}

function rightOnly(t: QTable, o: QTable, li: number[], ri: number[], cs: boolean): CellValue[][] {
  const keys = new Set(t.rows.filter((r) => !li.some((i) => isEmpty(r[i] ?? null))).map((r) => keyOf(r, li, cs)));
  return o.rows.filter((r) => ri.some((i) => isEmpty(r[i] ?? null)) || !keys.has(keyOf(r, ri, cs)));
}

/**
 * Runs a query on tables already loaded (`tables`, by `sourceKey`), up to `upto` steps when given (the preview of a
 * step selected in Applied steps). A failing step stops the run and is reported; the error is never thrown.
 */
export function runQuery(def: QueryDefinition, tables: ReadonlyMap<string, QTable>, o: { upto?: number } = {}): RunResult {
  const base = tables.get(sourceKey(def.source));
  if (!base) return { table: { columns: [], rows: [] }, applied: 0, error: { step: -1, message: 'The source table could not be loaded.' }, warnings: [] };
  const warnings: StepWarning[] = [];
  let t = base;
  const n = Math.min(def.steps.length, o.upto ?? def.steps.length);
  for (let i = 0; i < n; i++) {
    try {
      t = apply(t, def.steps[i]!, tables, (message) => warnings.push({ step: i, message }));
      check(t);
    } catch (err) {
      if (err instanceof QueryError) return { table: t, applied: i, error: { step: i, message: err.message }, warnings };
      throw err;
    }
  }
  return { table: t, applied: n, error: null, warnings };
}

/** The types the values of each column read as (Detect data types), for a change-type step. */
export function detectTypes(t: QTable): { column: string; type: ColumnType }[] {
  return t.columns.map((c, i) => ({ column: c.name, type: inferColumnType(t.rows.slice(0, 2000).map((r) => r[i] ?? null)) }));
}

/** Distinct values of one column with their counts (the filter menu's list), the most common first. */
export function columnValues(t: QTable, column: string, limit = 200): { values: { value: CellValue; count: number }[]; distinct: number } {
  const i = indexOf(t, column);
  const counts = new Map<string, { value: CellValue; count: number }>();
  for (const r of t.rows) {
    const v = r[i] ?? null;
    const k = JSON.stringify(v);
    const e = counts.get(k);
    if (e) e.count++;
    else counts.set(k, { value: v, count: 1 });
  }
  const all = [...counts.values()].sort((a, b) => b.count - a.count || compareValues(a.value, b.value));
  return { values: all.slice(0, limit), distinct: all.length };
}

/** A short summary of each column: empty, distinct, and for numbers the smallest and largest (column quality). */
export function profileTable(t: QTable): { column: string; empty: number; distinct: number; min: CellValue; max: CellValue }[] {
  return t.columns.map((c, i) => {
    const vals = t.rows.map((r) => r[i] ?? null);
    const present = vals.filter((v) => !isEmpty(v));
    const sorted = [...present].sort(compareValues);
    return { column: c.name, empty: vals.length - present.length, distinct: new Set(present.map((v) => JSON.stringify(v))).size, min: sorted[0] ?? null, max: sorted[sorted.length - 1] ?? null };
  });
}
