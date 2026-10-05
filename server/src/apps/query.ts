import type { Knex } from 'knex';
import { z } from 'zod';
import { badRequest } from '../http/problem.js';
import { comparable, dateMs, INDEX_TEXT_MAX, normText, type EntityDefinition, type Field } from './schema.js';

/*
 * The record query builder (B-2202): a tested subset of operators over the clear index, the same on SQLite, MySQL and
 * PostgreSQL. Records are sealed, so the database never sees `data`; every condition is an EXISTS over
 * `app_record_values`, whose values were normalised before they were written (schema.ts). Text compares byte-wise on
 * lower-cased NFC (MySQL's column is utf8mb4_bin; PostgreSQL compares and sorts it with COLLATE "C", as its value
 * indexes are built), numbers as doubles, and empty values sort last in both directions. Conditions on fields that are
 * not indexed are refused, not scanned. Pages come from an offset or a cursor (keyset paging, B-3601).
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

type SystemField = { col: string; kind: 'text' | 'num' | 'id'; nullable: boolean };
const SYSTEM_FIELDS: Record<string, SystemField> = {
  id: { col: 'r.id', kind: 'id', nullable: false },
  state: { col: 'r.state', kind: 'text', nullable: true },
  createdAt: { col: 'r.created_at', kind: 'num', nullable: false },
  updatedAt: { col: 'r.updated_at', kind: 'num', nullable: false },
  createdBy: { col: 'r.created_by', kind: 'id', nullable: true }
};
/** A system field by name (own properties only: `constructor` is not one). */
const system = (name: string) => (Object.hasOwn(SYSTEM_FIELDS, name) ? SYSTEM_FIELDS[name] : undefined);

const NUMERIC_TYPES = ['number', 'boolean', 'date'];
const DEFAULT_SORT: Sort = [{ field: 'createdAt', dir: 'asc' }];

export interface QueryContext {
  db: Knex;
  def: EntityDefinition;
  /** The entity whose records are queried: every lookup in `app_record_values` names it, as its indexes begin with it. */
  entityId: string;
  /** PostgreSQL compares and sorts text with its locale unless told otherwise, and has NULLS LAST. */
  pg: boolean;
}

/** Text in byte order: PostgreSQL needs `COLLATE "C"` (also what its value indexes are built with, 031b). */
const bytes = (ctx: QueryContext, expr: string) => (ctx.pg ? `${expr} collate "C"` : expr);

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

type Leaf = { field: string; op: Op; value?: unknown };

/**
 * A condition's test of one value row (`alias`, the row of `app_record_values` for the condition's field), checked now
 * so a bad value is a 400 before any query runs. `exists` has none (the row is the test); `ne` tests equality, which
 * the caller negates.
 */
function valueTest(field: Field, f: Leaf, ctx: QueryContext): ((s: Knex.QueryBuilder, alias: string) => void) | null {
  const col = (alias: string, c: 'v_norm' | 'v_num') => (c === 'v_norm' ? bytes(ctx, `${alias}.v_norm`) : `${alias}.v_num`);
  switch (f.op) {
    case 'exists':
      return null;
    case 'eq':
    case 'ne':
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const o = operand(field, f.value);
      const op = SQL_OP[f.op === 'ne' ? 'eq' : f.op]!;
      return (s, alias) => void s.andWhereRaw(`${col(alias, o.col)} ${op} ?`, [o.val]);
    }
    case 'in': {
      if (!Array.isArray(f.value) || !f.value.length) throw badRequest(`${field.name}: in takes a list of 1 to 100 values.`);
      const os = f.value.map((x) => operand(field, x));
      const c = os[0]!.col;
      return (s, alias) => void s.andWhereRaw(`${col(alias, c)} in (${os.map(() => '?').join(', ')})`, os.map((o) => o.val));
    }
    case 'contains':
    case 'startsWith': {
      if (typeof f.value !== 'string' || !f.value) throw badRequest(`${field.name}: ${f.op} takes text.`);
      const o = operand(field, f.value);
      if (o.col !== 'v_norm') throw badRequest(`${field.name}: ${f.op} works on text fields.`);
      const pat = f.op === 'contains' ? `%${likeEscape(String(o.val))}%` : `${likeEscape(String(o.val))}%`;
      return (s, alias) => void s.andWhereRaw(`${col(alias, 'v_norm')} like ? escape ?`, [pat, '\\']);
    }
  }
}

/**
 * Adds a filter to a query over `app_records as r`. `skip` names conditions of the top level that the caller already
 * applies another way (a page reading the sort field's index tests them on that index row).
 */
export function applyFilter(q: Knex.QueryBuilder, f: Filter, ctx: QueryContext, skip?: ReadonlySet<Filter>): void {
  if (skip?.has(f)) return;
  if ('and' in f) {
    const kids = skip ? f.and.filter((k) => !skip.has(k)) : f.and;
    if (!kids.length) return;
    q.where((w) => {
      for (const k of kids) w.andWhere((x) => applyFilter(x, k, ctx));
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
  const test = valueTest(field, f, ctx);
  const db = ctx.db;
  const sub = (withTest: boolean) =>
    function (this: Knex.QueryBuilder) {
      this.select(db.raw('1')).from('app_record_values as v').whereRaw('v.record_id = r.id').andWhere('v.field', field.name);
      if (withTest && test) test(this, 'v');
    };
  if (f.op === 'exists' && f.value === false) q.whereNotExists(sub(false));
  else if (f.op === 'ne') q.whereNotExists(sub(true));
  else q.whereExists(sub(true));
}

function applySystem(q: Knex.QueryBuilder, sys: SystemField, f: Leaf, ctx: QueryContext): void {
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
      // Text ranges in byte order, as on the other dialects; equality and numbers can use the column's indexes.
      if (sys.kind === 'num' || f.op === 'eq') q.where(sys.col, SQL_OP[f.op]!, norm(f.value));
      else q.whereRaw(`${bytes(ctx, sys.col)} ${SQL_OP[f.op]!} ?`, [norm(f.value)]);
  }
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

// ---------- sorting and paging ----------

/** One column of an ordering. Empty values (NULL) sort last in both directions. */
interface SortCol {
  expr: string;
  dir: 'asc' | 'desc';
  num: boolean;
  nullable: boolean;
}

/** The value rows a sort joins (`s<i>` for the i-th sort key) and its columns; the last column is the record id. */
function sortPlan(sort: Sort, ctx: QueryContext): { joins: { alias: string; field: string }[]; cols: SortCol[] } {
  const joins: { alias: string; field: string }[] = [];
  const cols: SortCol[] = [];
  sort.forEach((s, i) => {
    const sys = system(s.field);
    if (sys) {
      cols.push({ expr: sys.kind === 'num' ? sys.col : bytes(ctx, sys.col), dir: s.dir, num: sys.kind === 'num', nullable: sys.nullable });
      return;
    }
    const f = fieldOf(ctx, s.field);
    const alias = `s${i}`;
    joins.push({ alias, field: f.name });
    const num: SortCol = { expr: `${alias}.v_num`, dir: s.dir, num: true, nullable: true };
    const text: SortCol = { expr: bytes(ctx, `${alias}.v_norm`), dir: s.dir, num: false, nullable: true };
    // A formula may give numbers or text: numbers first, then text, each in order.
    if (f.type === 'formula') cols.push(num, text);
    else cols.push(NUMERIC_TYPES.includes(f.type) ? num : text);
  });
  cols.push({ expr: bytes(ctx, 'r.id'), dir: 'asc', num: false, nullable: false });
  return { joins, cols };
}

function joinValues(q: Knex.QueryBuilder, joins: { alias: string; field: string }[], ctx: QueryContext): void {
  const db = ctx.db;
  for (const j of joins) {
    q.leftJoin(`app_record_values as ${j.alias}`, function () {
      this.on(`${j.alias}.record_id`, '=', 'r.id').andOn(`${j.alias}.field`, '=', db.raw('?', [j.field]));
    });
  }
}

/** Empty values last: NULLS LAST on PostgreSQL; elsewhere NULL sorts first, so a key puts it last. */
function orderBy(q: Knex.QueryBuilder, cols: SortCol[], ctx: QueryContext): void {
  for (const c of cols) {
    if (ctx.pg) q.orderByRaw(`${c.expr} ${c.dir}${c.nullable ? ' nulls last' : ''}`);
    else {
      if (c.nullable) q.orderByRaw(`case when ${c.expr} is null then 1 else 0 end`);
      q.orderByRaw(`${c.expr} ${c.dir}`);
    }
  }
}

/** Orders a query over `app_records as r`: the requested sorts (empty values last), then the id. */
export function applySort(q: Knex.QueryBuilder, sort: Sort, ctx: QueryContext): void {
  const plan = sortPlan(sort, ctx);
  joinValues(q, plan.joins, ctx);
  orderBy(q, plan.cols, ctx);
}

/*
 * Cursors (keyset paging): the sort values of the last record of a page and its id, with the sort they belong to,
 * as base64url JSON. They are opaque to clients; a cursor for another sort is refused.
 */
interface Cursor {
  keys: (string | number | null)[];
  id: string;
}
const sortKey = (sort: Sort) => sort.map((s) => `${s.field}:${s.dir}`).join(',');
const encodeCursor = (sort: Sort, keys: (string | number | null)[], id: string) => Buffer.from(JSON.stringify({ s: sortKey(sort), k: keys, id }), 'utf8').toString('base64url');

function decodeCursor(raw: string, sort: Sort, cols: SortCol[]): Cursor {
  const bad = () => badRequest('The cursor is not one this server gave out for this sort.');
  let c: { s?: unknown; k?: unknown; id?: unknown };
  try {
    c = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as typeof c;
  } catch {
    throw bad();
  }
  if (!c || typeof c !== 'object' || c.s !== sortKey(sort) || !Array.isArray(c.k) || c.k.length !== cols.length - 1) throw bad();
  if (typeof c.id !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(c.id)) throw bad();
  const keys = c.k as unknown[];
  keys.forEach((v, i) => {
    const col = cols[i]!;
    if (v === null ? !col.nullable : col.num ? typeof v !== 'number' || !Number.isFinite(v) : typeof v !== 'string' || v.length > INDEX_TEXT_MAX) throw bad();
  });
  return { keys: keys as (string | number | null)[], id: c.id };
}

/** Keeps the records that sort after the cursor: a later value in the first column that differs, else a later id. */
function applyAfter(q: Knex.QueryBuilder, cols: SortCol[], c: Cursor): void {
  const vals = [...c.keys, c.id];
  const ors: string[] = [];
  const binds: (string | number)[] = [];
  cols.forEach((col, i) => {
    const v = vals[i];
    if (v == null) return; // only a later column can sort after an empty value
    const and: string[] = [];
    for (let j = 0; j < i; j++) {
      const pv = vals[j];
      if (pv == null) and.push(`${cols[j]!.expr} is null`);
      else {
        and.push(`${cols[j]!.expr} = ?`);
        binds.push(pv);
      }
    }
    const cmp = col.dir === 'asc' ? '>' : '<';
    and.push(col.nullable ? `(${col.expr} ${cmp} ? or ${col.expr} is null)` : `${col.expr} ${cmp} ?`);
    binds.push(v);
    ors.push(`(${and.join(' and ')})`);
  });
  q.whereRaw(`(${ors.join(' or ')})`, binds);
}

/** Conditions of the filter's top level (one condition, or the members of a top-level `and`). */
function topLeaves(filter: Filter | undefined): Leaf[] {
  if (!filter) return [];
  if ('field' in filter) return [filter];
  return 'and' in filter ? filter.and.filter((f): f is Leaf => 'field' in f) : [];
}

/** Top-level conditions that test only `field` and so can be tested on its row of `app_record_values`. */
const ON_ROW: readonly Op[] = ['eq', 'in', 'startsWith', 'gt', 'gte', 'lt', 'lte', 'contains'];
const onField = (filter: Filter | undefined, field: string) => topLeaves(filter).filter((f) => f.field === field && ON_ROW.includes(f.op));

/** Who reads: the tenant, and the labels the reader is cleared for. */
export interface Scope {
  tenantId: string;
  labels: readonly string[];
}

interface Lead {
  field: Field;
  /** The column the lead reads; the query says it is not null, which picks its value index (031b). */
  col: 'v_num' | 'v_norm';
  tests: Leaf[];
}

/**
 * The records the caller may read that a filter and search match, as `app_records as r`.
 *
 * With a `lead`, the query starts from the rows of `app_record_values` for one field (`s0`, read from the value index
 * by entity and field, 031b; the lead's conditions are tested on that row), each joined to its record by id. The
 * record's entity is the row's, so `r` is not also matched by tenant and entity: that leaves PostgreSQL only the
 * primary key to reach the record by, and the other conditions only the value primary key, whatever its statistics
 * say. (An entity loaded in the last minute has none yet, and then every condition looks like it matches one row:
 * offered an index on `r` by tenant and entity, the planner would scan the entity's records once per value row.)
 */
function scoped(scope: Scope, input: { filter?: Filter; q?: string }, ctx: QueryContext, lead?: Lead): Knex.QueryBuilder {
  const db = ctx.db;
  let q: Knex.QueryBuilder;
  if (!lead) q = db('app_records as r').where('r.tenant_id', scope.tenantId).andWhere('r.entity_id', ctx.entityId);
  else {
    q = db('app_record_values as s0').join('app_records as r', 'r.id', 's0.record_id').where('s0.entity_id', ctx.entityId).andWhere('s0.field', lead.field.name).whereNotNull(`s0.${lead.col}`).andWhere('r.tenant_id', scope.tenantId);
    for (const t of lead.tests) valueTest(lead.field, t, ctx)?.(q, 's0');
  }
  q.andWhere('r.hidden', false).whereIn('r.label', [...scope.labels]);
  if (input.filter) applyFilter(q, input.filter, ctx, lead ? new Set<Filter>(lead.tests) : undefined);
  if (input.q) applySearch(q, input.q, ctx);
  return q;
}

/** Which top-level condition a count starts from: equality first, then lists, prefixes and ranges. */
const LEAD_RANK: Partial<Record<Op, number>> = { eq: 0, in: 1, startsWith: 2, gt: 3, gte: 3, lt: 3, lte: 3 };

/** How many records the caller may read match a filter and search. */
export async function countRecords(scope: Scope, input: { filter?: Filter; q?: string }, ctx: QueryContext): Promise<number> {
  const leaves = topLeaves(input.filter).filter((f) => !system(f.field) && LEAD_RANK[f.op] != null);
  const best = leaves.reduce<Leaf | undefined>((a, b) => (!a || LEAD_RANK[b.op]! < LEAD_RANK[a.op]! ? b : a), undefined);
  let lead: Lead | undefined;
  if (best) {
    const field = fieldOf(ctx, best.field);
    const col = best.op === 'startsWith' ? 'v_norm' : operand(field, Array.isArray(best.value) ? best.value[0] : best.value).col;
    lead = { field, col, tests: onField(input.filter, field.name) };
  }
  const rows = (await scoped(scope, input, ctx, lead).count({ n: '*' })) as Record<string, unknown>[];
  return Number(rows[0]?.n ?? 0);
}

export interface PageInput {
  filter?: Filter;
  q?: string;
  sort: Sort;
  limit: number;
  offset: number;
  cursor?: string;
}

/**
 * One page of records in the sort's order (default: created, oldest first), from an offset or after a cursor, and the
 * cursor of the next page (null on the last).
 *
 * When the first sort key is a value field (not a formula), the page is read in two parts, so the database walks the
 * field's value index (031b) in order and stops at the page: the records with a value, starting from that index
 * (`scoped` with the field as lead), then the records without one, in the order of the other keys. That is the order
 * a single query sorting empty values last gives, on every dialect.
 */
export async function pageRecords(scope: Scope, input: PageInput, ctx: QueryContext): Promise<{ rows: Record<string, unknown>[]; nextCursor: string | null }> {
  const sort = input.sort.length ? input.sort : DEFAULT_SORT;
  const plan = sortPlan(sort, ctx);
  const cursor = input.cursor ? decodeCursor(input.cursor, sort, plan.cols) : null;
  if (cursor && input.offset) throw badRequest('Page with a cursor or with an offset, not both.');
  const want = input.limit + 1;
  const keyCols = plan.cols.slice(0, -1);
  const select = (q: Knex.QueryBuilder, cols: SortCol[]) => q.select('r.*', ...cols.slice(0, -1).map((c, i) => ctx.db.raw(`${c.expr} as k${i}`)));
  const first = sort[0]!;
  const lead = system(first.field) ? null : fieldOf(ctx, first.field);
  let rows: Record<string, unknown>[] = [];

  if (!lead || lead.type === 'formula') {
    const q = scoped(scope, input, ctx);
    joinValues(q, plan.joins, ctx);
    if (cursor) applyAfter(q, plan.cols, cursor);
    orderBy(q, plan.cols, ctx);
    rows = (await select(q, plan.cols).limit(want).offset(input.offset)) as Record<string, unknown>[];
  } else {
    const col = NUMERIC_TYPES.includes(lead.type) ? 'v_num' : 'v_norm';
    const tests = onField(input.filter, lead.name);
    // Records with a value: s0 is never empty here, and gives the id order too, so its index serves the whole sort.
    const valued = () => {
      const q = scoped(scope, input, ctx, { field: lead, col, tests });
      joinValues(q, plan.joins.slice(1), ctx);
      return q;
    };
    const valuedCols: SortCol[] = [{ ...plan.cols[0]!, nullable: false }, ...plan.cols.slice(1, -1), { ...plan.cols.at(-1)!, expr: bytes(ctx, 's0.record_id') }];
    if (!cursor || cursor.keys[0] != null) {
      const q = valued();
      if (cursor) {
        q.whereRaw(`${valuedCols[0]!.expr} ${first.dir === 'asc' ? '>=' : '<='} ?`, [cursor.keys[0]!]);
        applyAfter(q, valuedCols, cursor);
      }
      orderBy(q, valuedCols, ctx);
      rows = (await select(q, valuedCols).limit(want).offset(input.offset)) as Record<string, unknown>[];
    }
    // Records without a value come last; a condition on the field means there are none.
    if (rows.length < want && !tests.length) {
      let skip = 0;
      if (input.offset && !rows.length) {
        const n = Number(((await valued().count({ n: '*' })) as Record<string, unknown>[])[0]?.n ?? 0);
        skip = Math.max(0, input.offset - n);
      }
      const q = scoped(scope, input, ctx);
      joinValues(q, plan.joins, ctx);
      q.whereNull(`s0.${col}`);
      if (cursor) applyAfter(q, plan.cols, cursor);
      orderBy(q, plan.cols.slice(1), ctx);
      rows.push(...((await select(q, plan.cols).limit(want - rows.length).offset(skip)) as Record<string, unknown>[]));
    }
  }

  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > input.limit && last
      ? encodeCursor(
          sort,
          keyCols.map((c, i) => {
            const v = last[`k${i}`];
            return v == null ? null : c.num ? Number(v) : String(v);
          }),
          String(last.id)
        )
      : null;
  for (const r of page) for (let i = 0; i < keyCols.length; i++) delete r[`k${i}`];
  return { rows: page, nextCursor };
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
