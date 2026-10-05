import type { Knex } from 'knex';
import { z } from 'zod';
import { badRequest } from '../http/problem.js';
import { comparable, dateMs, normText, type EntityDefinition, type Field } from './schema.js';

/*
 * The record query builder (B-2202): a tested subset of operators over the clear index, the same on SQLite, MySQL and
 * PostgreSQL. Records are sealed, so the database never sees `data`; every condition is an EXISTS over
 * `app_record_values`, whose values were normalised before they were written (schema.ts). Text compares byte-wise on
 * lower-cased NFC (MySQL's column is utf8mb4_bin; PostgreSQL sorts it with COLLATE "C"), numbers as doubles, and
 * empty values sort last in both directions. Conditions on fields that are not indexed are refused, not scanned.
 *
 *   {field, op, value}   op: eq, ne, gt, gte, lt, lte, in, contains, startsWith, exists
 *   {and: [...]}, {or: [...]}, {not: {...}}      at most 4 levels and 30 conditions
 *
 * `ne` and `not` include records without a value. System fields: id, state, createdAt, updatedAt, createdBy.
 */

export const OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'startsWith', 'exists'] as const;
export type Op = (typeof OPS)[number];

export type Filter = { field: string; op: Op; value?: unknown } | { and: Filter[] } | { or: Filter[] } | { not: Filter };

const scalar = z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]);
export const filterSchema: z.ZodType<Filter> = z.lazy(() =>
  z.union([
    z.object({ field: z.string().min(1).max(63), op: z.enum(OPS), value: z.union([scalar, z.array(scalar).max(100)]).optional() }).strict(),
    z.object({ and: z.array(filterSchema).min(1).max(30) }).strict(),
    z.object({ or: z.array(filterSchema).min(1).max(30) }).strict(),
    z.object({ not: filterSchema }).strict()
  ])
) as z.ZodType<Filter>;

export const sortSchema = z.array(z.object({ field: z.string().min(1).max(63), dir: z.enum(['asc', 'desc']).default('asc') }).strict()).max(3);
export type Sort = z.infer<typeof sortSchema>;

const SYSTEM_FIELDS: Record<string, { col: string; kind: 'text' | 'num' | 'id' }> = {
  id: { col: 'r.id', kind: 'id' },
  state: { col: 'r.state', kind: 'text' },
  createdAt: { col: 'r.created_at', kind: 'num' },
  updatedAt: { col: 'r.updated_at', kind: 'num' },
  createdBy: { col: 'r.created_by', kind: 'id' }
};
/** A system field by name (own properties only: `constructor` is not one). */
const system = (name: string) => (Object.hasOwn(SYSTEM_FIELDS, name) ? SYSTEM_FIELDS[name] : undefined);

export interface QueryContext {
  db: Knex;
  def: EntityDefinition;
  /** PostgreSQL sorts text with its locale unless told otherwise. */
  pg: boolean;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function depthAndCount(f: Filter, depth = 1): { depth: number; count: number } {
  if ('field' in f) return { depth, count: 1 };
  const kids = 'not' in f ? [f.not] : 'and' in f ? f.and : f.or;
  let d = depth;
  let c = 0;
  for (const k of kids) {
    const r = depthAndCount(k, depth + 1);
    d = Math.max(d, r.depth);
    c += r.count;
  }
  return { depth: d, count: c };
}

export function checkFilterSize(f: Filter): void {
  const { depth, count } = depthAndCount(f);
  if (depth > 4) throw badRequest('A filter nests at most 4 levels.');
  if (count > 30) throw badRequest('A filter has at most 30 conditions.');
}

function fieldOf(ctx: QueryContext, name: string): Field {
  const f = ctx.def.fields.find((x) => x.name === name);
  if (!f) throw badRequest(`There is no field ${name}.`);
  if (!f.indexed && !f.unique) throw badRequest(`${name} is not indexed, so records cannot be filtered or sorted by it. A designer can mark it indexed.`);
  return f;
}

/** A filter value in the field's comparable form: the column it compares and the normalised value. */
function operand(f: Field, v: unknown): { col: 'v_norm' | 'v_num'; val: string | number } {
  let raw = v;
  if (f.type === 'number' && typeof v === 'string' && v.trim() !== '') raw = Number(v);
  if (f.type === 'boolean' && typeof v === 'string') raw = v === 'true' ? true : v === 'false' ? false : v;
  if (f.type === 'date' && typeof v === 'string' && dateMs(v, true) != null && dateMs(v, f.withTime) == null) raw = v.slice(0, 10);
  const c = comparable(f, raw);
  if (!c) throw badRequest(`${JSON.stringify(v)} is not a value ${f.name} can compare with.`);
  return c.num != null ? { col: 'v_num', val: c.num } : { col: 'v_norm', val: c.norm! };
}

const SQL_OP: Partial<Record<Op, string>> = { eq: '=', gt: '>', gte: '>=', lt: '<', lte: '<=' };

/** Adds a filter to a query over `app_records as r`. */
export function applyFilter(q: Knex.QueryBuilder, f: Filter, ctx: QueryContext): void {
  if ('and' in f) {
    q.where((w) => {
      for (const k of f.and) w.andWhere((x) => applyFilter(x, k, ctx));
    });
    return;
  }
  if ('or' in f) {
    q.where((w) => {
      for (const k of f.or) w.orWhere((x) => applyFilter(x, k, ctx));
    });
    return;
  }
  if ('not' in f) {
    q.whereNot((w) => applyFilter(w, f.not, ctx));
    return;
  }
  const sys = system(f.field);
  if (sys) return applySystem(q, sys, f, ctx);
  const field = fieldOf(ctx, f.field);
  const db = ctx.db;
  const sub = (build: (s: Knex.QueryBuilder) => void) =>
    function (this: Knex.QueryBuilder) {
      this.select(db.raw('1')).from('app_record_values as v').whereRaw('v.record_id = r.id').andWhere('v.field', field.name);
      build(this);
    };
  switch (f.op) {
    case 'exists':
      if (f.value === false) q.whereNotExists(sub(() => undefined));
      else q.whereExists(sub(() => undefined));
      return;
    case 'eq':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const o = operand(field, f.value);
      q.whereExists(sub((s) => s.andWhere(`v.${o.col}`, SQL_OP[f.op]!, o.val)));
      return;
    }
    case 'ne': {
      const o = operand(field, f.value);
      q.whereNotExists(sub((s) => s.andWhere(`v.${o.col}`, o.val)));
      return;
    }
    case 'in': {
      if (!Array.isArray(f.value) || !f.value.length) throw badRequest(`${field.name}: in takes a list of 1 to 100 values.`);
      const os = f.value.map((x) => operand(field, x));
      const col = os[0]!.col;
      q.whereExists(sub((s) => s.whereIn(`v.${col}`, os.map((o) => o.val))));
      return;
    }
    case 'contains':
    case 'startsWith': {
      if (typeof f.value !== 'string' || !f.value) throw badRequest(`${field.name}: ${f.op} takes text.`);
      const o = operand(field, f.value);
      if (o.col !== 'v_norm') throw badRequest(`${field.name}: ${f.op} works on text fields.`);
      const pat = f.op === 'contains' ? `%${likeEscape(String(o.val))}%` : `${likeEscape(String(o.val))}%`;
      q.whereExists(sub((s) => s.andWhereRaw('v.v_norm like ? escape ?', [pat, '\\'])));
      return;
    }
  }
}

function applySystem(q: Knex.QueryBuilder, sys: { col: string; kind: 'text' | 'num' | 'id' }, f: { field: string; op: Op; value?: unknown }, ctx: QueryContext): void {
  const norm = (v: unknown): string | number => {
    if (sys.kind === 'num') {
      const n = typeof v === 'number' ? v : typeof v === 'string' ? (Number.isFinite(Number(v)) && v.trim() !== '' ? Number(v) : Date.parse(v)) : NaN;
      if (!Number.isFinite(n)) throw badRequest(`${f.field} compares with a number of milliseconds or a date.`);
      return n;
    }
    if (typeof v !== 'string') throw badRequest(`${f.field} compares with text.`);
    return sys.kind === 'id' ? v.toUpperCase() : normText(v);
  };
  switch (f.op) {
    case 'exists':
      if (f.value === false) q.whereNull(sys.col);
      else q.whereNotNull(sys.col);
      return;
    case 'ne':
      q.where((w) => w.whereNot(sys.col, norm(f.value)).orWhereNull(sys.col));
      return;
    case 'in':
      if (!Array.isArray(f.value) || !f.value.length) throw badRequest(`${f.field}: in takes a list of 1 to 100 values.`);
      q.whereIn(sys.col, f.value.map(norm));
      return;
    case 'contains':
    case 'startsWith': {
      if (sys.kind === 'num' || typeof f.value !== 'string') throw badRequest(`${f.field}: ${f.op} works on text.`);
      const v = String(norm(f.value));
      q.whereRaw(`${sys.col} like ? escape ?`, [f.op === 'contains' ? `%${likeEscape(v)}%` : `${likeEscape(v)}%`, '\\']);
      return;
    }
    default:
      q.where(sys.col, SQL_OP[f.op]!, norm(f.value));
  }
  void ctx;
}

/** Records whose indexed text fields contain `text` (lower-cased, wildcards literal). */
export function applySearch(q: Knex.QueryBuilder, text: string, ctx: QueryContext): void {
  const fields = ctx.def.fields.filter((f) => (f.indexed || f.unique) && ['string', 'enum', 'formula', 'ai', 'lookup'].includes(f.type)).map((f) => f.name);
  if (!fields.length) throw badRequest('This entity has no indexed text fields to search.');
  const pat = `%${likeEscape(normText(text))}%`;
  const db = ctx.db;
  q.whereExists(function () {
    this.select(db.raw('1')).from('app_record_values as v').whereRaw('v.record_id = r.id').whereIn('v.field', fields).andWhereRaw('v.v_norm like ? escape ?', [pat, '\\']);
  });
}

/** Orders a query over `app_records as r`: the requested sorts (empty values last), then the id. */
export function applySort(q: Knex.QueryBuilder, sort: Sort, ctx: QueryContext): void {
  const text = (expr: string) => (ctx.pg ? `${expr} collate "C"` : expr);
  sort.forEach((s, i) => {
    const sys = system(s.field);
    if (sys) {
      q.orderByRaw(`case when ${sys.col} is null then 1 else 0 end`);
      q.orderByRaw(`${sys.kind === 'num' ? sys.col : text(sys.col)} ${s.dir}`);
      return;
    }
    const f = fieldOf(ctx, s.field);
    const alias = `s${i}`;
    q.leftJoin(`app_record_values as ${alias}`, function () {
      this.on(`${alias}.record_id`, '=', 'r.id').andOn(`${alias}.field`, '=', ctx.db.raw('?', [f.name]));
    });
    const numeric = ['number', 'boolean', 'date'].includes(f.type);
    if (f.type === 'formula') {
      // A formula may give numbers or text: numbers first, then text, each in order.
      q.orderByRaw(`case when ${alias}.v_num is null and ${alias}.v_norm is null then 1 else 0 end`);
      q.orderByRaw(`${alias}.v_num ${s.dir}`);
      q.orderByRaw(`${text(`${alias}.v_norm`)} ${s.dir}`);
      return;
    }
    const col = numeric ? `${alias}.v_num` : `${alias}.v_norm`;
    q.orderByRaw(`case when ${col} is null then 1 else 0 end`);
    q.orderByRaw(`${numeric ? col : text(col)} ${s.dir}`);
  });
  q.orderByRaw(`${text('r.id')} asc`);
}

// ---------- aggregation ----------

export const aggregateSchema = z
  .object({
    filter: filterSchema.optional(),
    q: z.string().trim().min(1).max(200).optional(),
    groupBy: z.string().min(1).max(63).optional(),
    metrics: z
      .array(z.union([z.object({ op: z.literal('count') }).strict(), z.object({ op: z.enum(['sum', 'avg', 'min', 'max']), field: z.string().min(1).max(63) }).strict()]))
      .min(1)
      .max(10)
  })
  .strict();
export type AggregateInput = z.infer<typeof aggregateSchema>;

export interface AggregateGroup {
  key: string | number | null;
  values: (number | null)[];
}

/**
 * Aggregates over a base query of record ids (`select r.id[, r.state]`): optional grouping by an indexed field or the
 * state, and count, sum, avg, min and max over indexed numeric fields. Groups come back ordered by key (empty last),
 * at most 1000.
 */
export async function aggregate(base: Knex.QueryBuilder, input: AggregateInput, ctx: QueryContext): Promise<{ groupBy: string | null; metrics: string[]; groups: AggregateGroup[] }> {
  const db = ctx.db;
  const q = db.from(base.as('b'));
  let groupField: Field | null = null;
  let groupCol: string | null = null;
  if (input.groupBy === 'state') groupCol = 'b.state';
  else if (input.groupBy) {
    groupField = fieldOf(ctx, input.groupBy);
    q.leftJoin('app_record_values as g', function () {
      this.on('g.record_id', '=', 'b.id').andOn('g.field', '=', db.raw('?', [groupField!.name]));
    });
    groupCol = ['number', 'boolean', 'date'].includes(groupField.type) ? 'g.v_num' : 'g.v_norm';
  }
  const selects: Knex.Raw[] = [];
  input.metrics.forEach((m, i) => {
    if (m.op === 'count') {
      selects.push(db.raw(`count(*) as m${i}`));
      return;
    }
    const f = fieldOf(ctx, m.field);
    if (!['number', 'date', 'boolean', 'formula'].includes(f.type)) throw badRequest(`${m.op} works on number, date and boolean fields; ${f.name} is ${f.type}.`);
    const alias = `a${i}`;
    q.leftJoin(`app_record_values as ${alias}`, function () {
      this.on(`${alias}.record_id`, '=', 'b.id').andOn(`${alias}.field`, '=', db.raw('?', [f.name]));
    });
    selects.push(db.raw(`${m.op}(${alias}.v_num) as m${i}`));
  });
  if (groupCol) {
    q.select(db.raw(`${groupCol} as gk`), ...selects).groupBy(groupCol);
  } else q.select(...selects);
  const rows = (await q.limit(1001)) as Record<string, unknown>[];
  if (rows.length > 1000) throw badRequest('More than 1000 groups; filter the records or group by another field.');
  const enumSpelling = (v: string): string => {
    if (groupField?.type === 'enum' || (groupField?.type === 'lookup' && groupField.source === 'static')) {
      const opts = groupField.type === 'enum' ? groupField.options : (groupField.options ?? []);
      return opts.find((o) => normText(o.value) === v)?.value ?? v;
    }
    return v;
  };
  const groups: AggregateGroup[] = rows.map((r) => ({
    key: r.gk == null ? null : groupCol === 'g.v_num' ? Number(r.gk) : enumSpelling(String(r.gk)),
    values: input.metrics.map((_, i) => (r[`m${i}`] == null ? null : Number(r[`m${i}`])))
  }));
  groups.sort((a, b) => (a.key === b.key ? 0 : a.key == null ? 1 : b.key == null ? -1 : typeof a.key === 'number' && typeof b.key === 'number' ? a.key - b.key : String(a.key) < String(b.key) ? -1 : 1));
  return { groupBy: input.groupBy ?? null, metrics: input.metrics.map((m) => (m.op === 'count' ? 'count' : `${m.op}(${m.field})`)), groups };
}
