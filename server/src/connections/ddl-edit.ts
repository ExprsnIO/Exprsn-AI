import { z } from 'zod';
import { canonical, dialect, type NameContext } from './dialects.js';
import { engineInfo, type DialectId, type Engine } from './engines.js';
import { findType, renderType, stringLiteral, type TypeChoice, type VendorType } from './ddl-types.js';
import {
  buildSqlIndex,
  columnSpec,
  cosmosContainerBody,
  cosmosContainerSpec,
  DdlProblem,
  ddlKinds,
  dynamoTableSpec,
  expressionProblem,
  familyOf,
  fold,
  foreignKeyClause,
  foreignKeySpec,
  identityClause,
  literalFor,
  MAX_IDENT,
  mongoCollectionSpec,
  mysqlNeedsExprDefault,
  Names,
  searchFieldMapping,
  searchIndexSpec,
  shortName,
  sqlIndexSpec,
  streamGroupSpec,
  TRANSACTIONAL,
  type AdminOp,
  type DdlKind,
  type DdlPlan
} from './ddl.js';
import {
  alterTableSpec,
  dropSpec,
  EDIT_KINDS,
  editObjectSpec,
  replaceIndexSpec,
  type DescribedColumn,
  type DescribedDefault,
  type DescribeKind,
  type DocumentDescription,
  type EditKind,
  type ObjectDescription,
  type TableDescription
} from './ddl-edit-types.js';

/*
 * 2.0.x: plans that edit or drop existing objects (ddl-edit-types.ts has the contract). `buildEditPlan` diffs an
 * edited definition against the object's description, read from the database just before planning, and writes each
 * dialect's ALTER, DROP and RENAME statements, or the non-SQL operations. Like create plans (ddl.ts), nothing here is
 * free text: names are validated and quoted, literals escaped by type, expressions scanned with `expressionProblem`.
 *
 * ddl.ts imports this module and this module imports ddl.ts: nothing from ddl.ts is used at module load, only inside
 * functions, so either may be loaded first.
 *
 * Statement order of an altered table: drop removed or changed constraints (foreign keys, checks, uniques, primary
 * key), drop removed columns, rename columns, alter changed columns, add new columns, add new or changed
 * constraints, the table comment, and the table's own rename last.
 */

export const isEditKind = (k: string): k is EditKind => (EDIT_KINDS as readonly string[]).includes(k);

type Plan = Omit<DdlPlan, 'hash'>;
type EditColumn = z.infer<typeof columnSpec> & { from?: string };
type ForeignKey = z.infer<typeof foreignKeySpec>;

const DNAME: Record<DialectId, string> = { postgres: 'PostgreSQL', mysql: 'MySQL', tsql: 'SQL Server', oracle: 'Oracle', snowflake: 'Snowflake', bigquery: 'BigQuery', sqlite: 'SQLite' };
const COMMITS_NOTE = 'This database commits each DDL statement on its own: if a later statement fails, the earlier ones stay.';
const json = (v: unknown) => JSON.stringify(v, null, 2);
const low = (s: string) => s.toLowerCase();

function parseWith<T extends z.ZodTypeAny>(schema: T, raw: unknown, prefix = ''): z.infer<T> {
  const r = schema.safeParse(raw);
  if (!r.success) throw new DdlProblem(r.error.issues.map((i) => `${[prefix, i.path.join('.')].filter(Boolean).join('.') || 'definition'}: ${i.message}`));
  return r.data;
}

let editColumnSchema: z.ZodTypeAny | null = null;
const editColumn = () => (editColumnSchema ??= columnSpec.extend({ from: z.string().trim().min(1).max(255).optional() }).strict());

// ---------------------------------------------------------------------------------------------------------------
// What an engine offers, and what must be described first
// ---------------------------------------------------------------------------------------------------------------

/** The edit kinds an engine offers (SQL: alter-table, replace-index; the rest: the object kinds `edit` takes), and the object kinds it can drop. */
export function editKinds(engine: Engine): { edit: string[]; drop: string[] } {
  const d = engineInfo(engine).dialect;
  switch (familyOf(engine)) {
    case 'sql': {
      const kinds = ddlKinds(engine).map((k) => k.kind as string);
      const drop = ['table', 'view', ...kinds.filter((k) => k !== 'table')];
      // A routine is edited by creating it again with orReplace (MySQL: dropped and created).
      const routines = kinds.filter((k) => k === 'procedure' || k === 'function');
      return { edit: [...(d === 'snowflake' ? ['alter-table'] : ['alter-table', 'replace-index']), ...routines], drop };
    }
    case 'mongo':
      return { edit: ['collection'], drop: ['collection', 'index'] };
    case 'opensearch':
      return { edit: ['search-index'], drop: ['search-index'] };
    case 'dynamodb':
      return { edit: ['table'], drop: ['table', 'index'] };
    case 'cosmos':
      return { edit: ['container'], drop: ['container', 'dataset'] };
    case 'influx':
      return { edit: [], drop: ['dataset'] };
    case 'redis':
      return { edit: ['stream-group'], drop: ['stream-group'] };
    case 'rabbitmq':
      return { edit: [], drop: ['queue', 'exchange', 'binding'] };
    default:
      return { edit: [], drop: [] };
  }
}

/**
 * What must be described before an edit can be planned: an altered table, the table of a replaced index, the object
 * of a non-SQL edit. Null for drops and creates (a routine is edited by creating it again with orReplace). A stream
 * group's edit describes its stream (`definition.key`), whose description lists the groups.
 */
export function describeTarget(_engine: Engine, raw: unknown): { kind: DescribeKind; name: string } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  switch (r.kind) {
    case 'alter-table': {
      const name = str(r.name);
      return name ? { kind: 'table', name } : null;
    }
    case 'replace-index': {
      const name = str(r.table);
      return name ? { kind: 'table', name } : null;
    }
    case 'edit': {
      const name = str(r.name);
      const kind = str(r.objectKind);
      if (!name || !kind || !['collection', 'search-index', 'table', 'container', 'stream-group'].includes(kind)) return null;
      if (kind === 'stream-group') {
        const key = str((r.definition as Record<string, unknown> | undefined)?.key);
        return key ? { kind: 'stream-group', name: key } : null;
      }
      return { kind: kind as DescribeKind, name };
    }
    default:
      return null;
  }
}

export function buildEditPlan(engine: Engine, ctx: NameContext, raw: unknown, current: ObjectDescription | null): Plan {
  const kind = (raw as { kind?: string } | null)?.kind as EditKind;
  const family = familyOf(engine);
  const title = engineInfo(engine).title;
  const offered = editKinds(engine);
  if (kind === 'drop') return dropPlan(engine, ctx, raw);
  if (family === 'sql') {
    const d = engineInfo(engine).dialect!;
    if (kind === 'edit') throw new DdlProblem([`${title} tables are edited with alter-table, not edit.`]);
    if (!offered.edit.includes(kind)) throw new DdlProblem([`${title} offers ${offered.edit.join(', ')}, not ${kind}.`]);
    if (kind === 'alter-table') return alterTable(engine, d, ctx, raw, current);
    return replaceIndex(engine, d, ctx, raw, current);
  }
  if (kind !== 'edit') throw new DdlProblem([`${title} has no ${kind === 'alter-table' ? 'tables to alter' : 'indexes to replace'}; ${offered.edit.length ? `it edits ${offered.edit.join(', ')}` : 'its objects are only created and dropped'}.`]);
  const objectKind = (raw as { objectKind?: unknown }).objectKind;
  if (family === 'rabbitmq' && (objectKind === 'queue' || objectKind === 'exchange')) {
    throw new DdlProblem([`RabbitMQ cannot change a ${objectKind} once it is declared: its type, durability and arguments are fixed. Drop it and declare it again${objectKind === 'queue' ? ' (the messages in it are lost)' : ''}, or set limits such as TTL and length through a policy.`]);
  }
  const spec = parseWith(editObjectSpec, raw);
  if (!offered.edit.includes(spec.objectKind)) throw new DdlProblem([offered.edit.length ? `${title} edits ${offered.edit.join(', ')}, not ${spec.objectKind}.` : `${title} objects are created and dropped, not edited.`]);
  return editObject(engine, ctx, spec, current);
}

// ---------------------------------------------------------------------------------------------------------------
// Comparing a described column with the form's
// ---------------------------------------------------------------------------------------------------------------

const normType = (c: TypeChoice) =>
  JSON.stringify({ type: c.type.trim().toLowerCase().replace(/\s+/g, ' '), length: c.length ?? null, precision: c.precision ?? null, scale: c.scale ?? null, values: c.values?.length ? c.values : null, unsigned: !!c.unsigned, array: !!c.array });
const squash = (s: string) => s.toLowerCase().replace(/\s+/g, '');

/** True when the form leaves a column's type as it is: the same TypeChoice, the same rendered text, or (an uncatalogued type) the same text as the database reports. */
function sameType(d: DialectId, cur: DescribedColumn, to: TypeChoice): boolean {
  if (cur.type) {
    if (normType(cur.type) === normType(to)) return true;
    const a = renderType(d, cur.type);
    const b = renderType(d, to);
    return 'text' in a && 'text' in b && a.text === b.text;
  }
  const b = renderType(d, to);
  return 'text' in b && squash(b.text) === squash(cur.rawType);
}

/** Strips brackets that wrap the whole expression (SQL Server reports `((0))`), case and spacing. */
export function normExpr(s: string): string {
  let t = s.trim().replace(/\s+/g, ' ');
  for (;;) {
    if (!(t.startsWith('(') && t.endsWith(')'))) break;
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '(') depth++;
      else if (t[i] === ')') depth--;
      if (depth === 0 && i < t.length - 1) {
        wraps = false;
        break;
      }
    }
    if (!wraps) break;
    t = t.slice(1, -1).trim();
  }
  return t.toLowerCase().replace(/\s*([(),])\s*/g, '$1');
}

const NUMERIC = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

function sameLiteral(v: string | number | boolean, s: string): boolean {
  const x = s.trim();
  if (typeof v === 'boolean') return v ? /^(true|1|t|b'1')$/i.test(x) : /^(false|0|f|b'0')$/i.test(x);
  const sv = String(v);
  if (NUMERIC.test(sv.trim()) && NUMERIC.test(x)) return Number(sv) === Number(x);
  return sv === s;
}

type FormDefault = EditColumn['default'];

function sameDefault(cur: DescribedDefault | null, form: FormDefault): boolean {
  const f = form && !(form.kind === 'literal' && form.value === null) ? form : null;
  const c = cur && !(cur.kind === 'expression' && /^null$/i.test(cur.value.trim())) && !(cur.kind === 'literal' && cur.value === null) ? cur : null;
  if (!f || !c) return !f && !c;
  if (f.kind === 'literal' && c.kind === 'literal') return sameLiteral(f.value as string | number | boolean, c.value);
  if (f.kind === 'expression' && c.kind === 'expression') return normExpr(f.sql) === normExpr(c.value);
  // A literal the database reports as an expression (or the other way round): compare the texts.
  const ft = f.kind === 'literal' ? String(f.value) : f.sql;
  return normExpr(ft) === normExpr(c.value) || normExpr(`'${ft}'`) === normExpr(c.value);
}

// ---------------------------------------------------------------------------------------------------------------
// Type changes: which widen (keep every value) and which a vendor allows in place
// ---------------------------------------------------------------------------------------------------------------

const INT_RANK: Partial<Record<DialectId, string[]>> = {
  postgres: ['smallint', 'integer', 'bigint'],
  mysql: ['TINYINT', 'SMALLINT', 'MEDIUMINT', 'INT', 'BIGINT'],
  tsql: ['TINYINT', 'SMALLINT', 'INT', 'BIGINT'],
  snowflake: ['SMALLINT', 'INTEGER', 'BIGINT']
};
const INT_DIGITS: Record<string, number> = { tinyint: 3, smallint: 5, mediumint: 8, int: 10, integer: 10, bigint: 19, int64: 19 };
const FLOAT_RANK: Partial<Record<DialectId, string[]>> = { postgres: ['real', 'double precision'], mysql: ['FLOAT', 'DOUBLE'], tsql: ['REAL', 'FLOAT'], oracle: ['BINARY_FLOAT', 'BINARY_DOUBLE'] };
const TEXT_RANK: Partial<Record<DialectId, string[]>> = { mysql: ['TINYTEXT', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT'] };
/** Types whose length may be left out for "as long as the type allows". */
const UNBOUNDED_WITHOUT_LENGTH = new Set(['postgres:varchar', 'snowflake:VARCHAR', 'snowflake:BINARY', 'bigquery:STRING', 'bigquery:BYTES']);
/** Decimal types and the integer digits they hold when no precision is given (Infinity: unbounded). */
const DECIMAL_DEFAULT_DIGITS: Record<string, number> = { 'postgres:numeric': Infinity, 'mysql:DECIMAL': 10, 'tsql:DECIMAL': 18, 'tsql:NUMERIC': 18, 'oracle:NUMBER': Infinity, 'snowflake:NUMBER': 38, 'bigquery:NUMERIC': 29, 'bigquery:BIGNUMERIC': 38 };

const has = (v: unknown) => v !== undefined && v !== null;

function lengthGrows(d: DialectId, vt: VendorType, from: TypeChoice, to: TypeChoice): boolean {
  if (to.length === 'max') return true;
  if (from.length === 'max') return false;
  const unbounded = UNBOUNDED_WITHOUT_LENGTH.has(`${d}:${vt.name}`);
  if (!has(to.length)) return unbounded || !has(from.length);
  if (!has(from.length)) return false;
  return Number(to.length) >= Number(from.length);
}

function decimalGrows(d: DialectId, vt: VendorType, from: TypeChoice, to: TypeChoice): boolean {
  if (!has(to.precision)) return !has(from.precision) || DECIMAL_DEFAULT_DIGITS[`${d}:${vt.name}`] === Infinity;
  if (!has(from.precision)) return false;
  const fs = from.scale ?? 0;
  const ts = to.scale ?? 0;
  return to.precision! >= from.precision! && ts >= fs && to.precision! - ts >= from.precision! - fs;
}

/** True when every value of `from` fits `to` unchanged (a pure widening within one type family). */
export function widens(d: DialectId, from: TypeChoice | null, to: TypeChoice): boolean {
  if (!from) return false;
  const fv = findType(d, from.type);
  const tv = findType(d, to.type);
  if (!fv || !tv) return false;
  if (!!from.array !== !!to.array) return false;
  if (fv.name === tv.name) {
    if (!!from.unsigned !== !!to.unsigned) return false;
    switch (fv.params) {
      case 'none':
        return true;
      case 'length':
        return lengthGrows(d, fv, from, to);
      case 'precision':
        if (!has(to.precision)) return !has(from.precision) || fv.group === 'time' || fv.group === 'timestamp' || fv.group === 'float';
        return has(from.precision) ? to.precision! >= from.precision! : false;
      case 'precision-scale':
        return decimalGrows(d, fv, from, to);
      case 'values': {
        const a = from.values ?? [];
        const b = to.values ?? [];
        return a.every((v, i) => b[i] === v);
      }
    }
  }
  const rank = (list: string[] | undefined, a: string, b: string) => !!list && list.indexOf(a) >= 0 && list.indexOf(b) > list.indexOf(a);
  if (fv.group === 'integer' && tv.group === 'integer') {
    if (from.unsigned && !to.unsigned && d === 'mysql') return rank(INT_RANK[d], fv.name, tv.name);
    if (!from.unsigned && to.unsigned) return false;
    if (d === 'snowflake') return true; // all NUMBER(38, 0)
    return rank(INT_RANK[d], fv.name, tv.name);
  }
  if (fv.group === 'integer' && tv.group === 'decimal' && tv.params === 'precision-scale') {
    const need = INT_DIGITS[low(fv.name)] ?? 38;
    const room = has(to.precision) ? to.precision! - (to.scale ?? 0) : (DECIMAL_DEFAULT_DIGITS[`${d}:${tv.name}`] ?? 0);
    return room >= need;
  }
  if (fv.group === 'float' && tv.group === 'float') return d === 'snowflake' || rank(FLOAT_RANK[d], fv.name, tv.name) || (d === 'tsql' && fv.name === 'FLOAT' && tv.name === 'FLOAT');
  if (d === 'bigquery' && fv.name === 'NUMERIC' && tv.name === 'BIGNUMERIC') return !has(from.precision) || decimalGrows(d, tv, from, to);
  if (fv.group === 'text' && tv.group === 'text') {
    switch (d) {
      case 'postgres':
        return tv.name === 'text' || (tv.name === 'citext' && fv.name !== 'char');
      case 'mysql':
        if (rank(TEXT_RANK[d], fv.name, tv.name)) return true;
        return (fv.name === 'VARCHAR' || fv.name === 'CHAR') && (tv.name === 'MEDIUMTEXT' || tv.name === 'LONGTEXT');
      case 'tsql':
        return fv.name === 'VARCHAR' && tv.name === 'NVARCHAR' && (to.length === 'max' || (from.length !== 'max' && Number(to.length ?? 1) >= Number(from.length ?? 1)));
      case 'oracle':
        return (fv.name === 'VARCHAR2' && tv.name === 'CLOB') || (fv.name === 'NVARCHAR2' && tv.name === 'NCLOB');
      case 'snowflake':
        return ['VARCHAR', 'STRING', 'TEXT'].includes(fv.name) && ['VARCHAR', 'STRING', 'TEXT'].includes(tv.name) && (tv.name !== 'VARCHAR' || !has(to.length));
      default:
        return false;
    }
  }
  return false;
}

/** Snowflake changes a column's type in place only to a longer VARCHAR or a NUMBER of more precision and the same scale. */
function snowflakeTypeProblem(from: TypeChoice | null, to: TypeChoice, col: string): string | null {
  const refuse = `${col}: Snowflake changes a column's type in place only to a longer VARCHAR or a NUMBER with more precision and the same scale; add a new column and copy the values instead.`;
  if (!from) return refuse;
  const fv = findType('snowflake', from.type);
  const tv = findType('snowflake', to.type);
  if (!fv || !tv || fv.name !== tv.name) return refuse;
  if (fv.name === 'VARCHAR') return lengthGrows('snowflake', fv, from, to) ? null : refuse;
  if (fv.name === 'NUMBER') {
    const fp = from.precision ?? 38;
    const tp = to.precision ?? 38;
    return (from.scale ?? 0) === (to.scale ?? 0) && tp >= fp ? null : refuse;
  }
  return refuse;
}

/** BigQuery's in-place coercions: INT64 to NUMERIC, BIGNUMERIC or FLOAT64; NUMERIC to BIGNUMERIC or FLOAT64; longer STRING and BYTES; more precision. */
function bigqueryTypeProblem(from: TypeChoice | null, to: TypeChoice, col: string): string | null {
  const refuse = `${col}: BigQuery changes a column's type only by widening it (INT64 to NUMERIC, BIGNUMERIC or FLOAT64; NUMERIC to BIGNUMERIC or FLOAT64; a longer STRING or BYTES; more precision); anything else needs the table rewritten with a query.`;
  if (!from) return refuse;
  const fv = findType('bigquery', from.type);
  const tv = findType('bigquery', to.type);
  if (!fv || !tv) return refuse;
  if (fv.name === tv.name) {
    if (fv.params === 'length') return lengthGrows('bigquery', fv, from, to) ? null : refuse;
    if (fv.params === 'precision-scale') return decimalGrows('bigquery', fv, from, to) ? null : refuse;
    return refuse;
  }
  if (fv.name === 'INT64' && ['NUMERIC', 'BIGNUMERIC', 'FLOAT64'].includes(tv.name)) return tv.name === 'FLOAT64' || widens('bigquery', from, to) ? null : refuse;
  if (fv.name === 'NUMERIC' && (tv.name === 'BIGNUMERIC' || tv.name === 'FLOAT64')) return tv.name === 'FLOAT64' || widens('bigquery', from, to) ? null : refuse;
  return refuse;
}

// ---------------------------------------------------------------------------------------------------------------
// alter-table
// ---------------------------------------------------------------------------------------------------------------

function isTable(c: ObjectDescription | null): c is TableDescription {
  return !!c && 'columns' in c && Array.isArray((c as TableDescription).columns);
}

/** A raw type as the database reported it, kept as written for a column whose type the designer does not offer. */
const RAW_TYPE = /^[A-Za-z0-9_ (),.'"[\]]{1,200}$/;

/**
 * The edited definition as the console sends it, made regular: a constraint whose name came back empty (SQLite keeps
 * none) is unnamed; an existing column sent without a type keeps its type (its raw type when uncatalogued).
 */
function regularise(raw: unknown, current: ObjectDescription | null): { raw: unknown; keepRaw: Set<string> } {
  const keepRaw = new Set<string>();
  if (!raw || typeof raw !== 'object') return { raw, keepRaw };
  const r = { ...(raw as Record<string, unknown>) };
  const unname = (list: unknown) => (Array.isArray(list) ? list.map((x) => (x && typeof x === 'object' && !(x as { name?: unknown }).name ? Object.fromEntries(Object.entries(x as Record<string, unknown>).filter(([k]) => k !== 'name')) : x)) : list);
  r.uniques = unname(r.uniques);
  r.foreignKeys = unname(r.foreignKeys);
  r.checks = unname(r.checks);
  if (Array.isArray(r.columns) && isTable(current)) {
    r.columns = r.columns.map((c) => {
      if (!c || typeof c !== 'object') return c;
      const x = { ...(c as Record<string, unknown>) };
      if (typeof x.from === 'string' && x.type === undefined) {
        const cur = current.columns.find((cc) => low(cc.name) === low(String(x.from)));
        if (cur?.type) x.type = cur.type;
        else if (cur) {
          keepRaw.add(low(String(x.name ?? x.from)));
          x.type = { type: cur.rawType.slice(0, 60) || 'raw' };
        }
      }
      return x;
    });
  }
  return { raw: r, keepRaw };
}

function alterTable(engine: Engine, d: DialectId, ctx: NameContext, rawIn: unknown, current: ObjectDescription | null): Plan {
  const { raw, keepRaw } = regularise(rawIn, current);
  const spec = parseWith(alterTableSpec, raw);
  if (!isTable(current)) throw new DdlProblem([`The table ${spec.name} does not exist.`]);
  if (current.kind === 'view') throw new DdlProblem([`${spec.name} is a view; a view is dropped and created again, not altered.`]);
  const cols = spec.columns.map((c, i) => parseWith(editColumn(), c, `columns.${i}`) as EditColumn);
  const fks = spec.foreignKeys.map((f, i) => parseWith(foreignKeySpec, f, `foreignKeys.${i}`));
  const n = new Names(d, ctx);
  const P = n.problems;
  const notes: string[] = [];
  const D = DNAME[d];
  const t = n.object(spec.name, 'The table', { needSchema: d === 'bigquery' });
  const T = `ALTER TABLE ${t.sql}`;
  const q = (existing: string) => dialect(d).quoteIdent(existing);
  const lit = (s: string) => stringLiteral(d, s);
  const tableBase = t.parts[t.parts.length - 1] ?? 'table';
  const max = MAX_IDENT[d];
  const caseInsensitive = d === 'mysql' || d === 'tsql' || d === 'bigquery' || d === 'sqlite';
  let destructive = false;
  const rebuild = (what: string) => P.push(`SQLite cannot ${what} without rebuilding the table, which the designer does not do; make a new table and copy the rows instead.`);

  // Phases, in the order they run.
  const dropCons: string[] = [];
  const dropCols: string[] = [];
  const renames: string[] = [];
  const alters: string[] = [];
  const adds: string[] = [];
  const addCons: string[] = [];
  const tableComment: string[] = [];
  const renameTable: string[] = [];
  const touches = new Set<string>([spec.name]);

  // Which existing column each form column was.
  const curByName = new Map(current.columns.map((c) => [low(c.name), c]));
  const formNames = new Set<string>();
  const used = new Set<string>();
  const matched: { form: EditColumn; cur: DescribedColumn; renamed: boolean; ref: string }[] = [];
  const added: EditColumn[] = [];
  for (const c of cols) {
    if (formNames.has(low(c.name))) P.push(`The column ${c.name} is listed twice.`);
    formNames.add(low(c.name));
    if (c.from === undefined) {
      added.push(c);
      continue;
    }
    const cur = curByName.get(low(c.from));
    if (!cur) P.push(`${c.from} is not a column of ${spec.name}.`);
    else if (used.has(low(cur.name))) P.push(`The column ${cur.name} is the source of two columns.`);
    else {
      used.add(low(cur.name));
      const renamed = !(c.name === cur.name || fold(d, c.name) === cur.name || (caseInsensitive && low(c.name) === low(cur.name)));
      matched.push({ form: c, cur, renamed, ref: renamed ? n.one(c.name, 'The column') : q(cur.name) });
    }
  }
  const dropped = current.columns.filter((c) => !used.has(low(c.name)));
  const newNameOf = new Map(matched.map((m) => [low(m.cur.name), m.form.name]));
  const mapCols = (cs: string[]) => cs.map((c) => low(newNameOf.get(low(c)) ?? `\u0000dropped:${c}`));
  const sameCols = (described: string[], form: string[]) => {
    const a = mapCols(described);
    return a.length === form.length && a.every((x, i) => x === low(form[i]!));
  };
  const known = (c: string, where: string) => {
    if (!formNames.has(low(c))) P.push(`${where} names ${c}, which is not a column of the table.`);
  };
  for (const m of matched) {
    if (!m.renamed) continue;
    const clash = curByName.get(low(m.form.name));
    if (clash && used.has(low(clash.name)) && clash !== m.cur) P.push(`${m.cur.name} cannot be renamed to ${m.form.name} while ${clash.name} is still a column; rename one of them in a separate change.`);
  }

  const defaultSql = (vt: VendorType, def: NonNullable<FormDefault>, col: string): string => {
    if (def.kind === 'expression') {
      const bad = expressionProblem(d, def.sql);
      if (bad) P.push(`The default of ${col}: ${bad}`);
      return d === 'sqlite' || (d === 'mysql' && mysqlNeedsExprDefault(vt.name)) ? `(${def.sql})` : def.sql;
    }
    let v = literalFor(d, vt.name, def.value, P, col);
    if (d === 'mysql' && mysqlNeedsExprDefault(vt.name) && v !== 'NULL') v = `(${v})`;
    return v;
  };
  const typeOf = (c: EditColumn): { text: string; vt: VendorType } | null => {
    const ty = renderType(d, c.type as TypeChoice);
    if ('problem' in ty) {
      P.push(`${c.name}: ${ty.problem}`);
      return null;
    }
    return { text: ty.text, vt: findType(d, c.type.type)! };
  };
  const formNullable = (c: EditColumn) => (c.identity && d !== 'sqlite' ? false : c.nullable);
  const hasDefault = (def: FormDefault) => !!def && !(def.kind === 'literal' && def.value === null);
  const dfName = (col: string) => n.one(shortName('df', tableBase, [col], max), 'The constraint name');
  const identityOk = (c: EditColumn, vt: VendorType) => {
    if (!c.identity) return;
    if (!vt.identity) P.push(`${c.name}: a ${vt.name} column cannot be an identity column in ${D}.`);
    if (hasDefault(c.default)) P.push(`${c.name}: an identity column takes no default.`);
    if (d === 'mysql' && !spec.primaryKey.map(low).includes(low(c.name))) P.push(`${c.name}: MySQL needs an AUTO_INCREMENT column in the primary key.`);
  };

  // 2. Columns no longer listed.
  for (const c of dropped) {
    destructive = true;
    const ref = q(c.name);
    if (d === 'sqlite') {
      const inPk = current.primaryKey?.columns.some((x) => low(x) === low(c.name));
      const inIndex = current.indexes.some((ix) => ix.columns.some((x) => low(x.name) === low(c.name)));
      const inFk = current.foreignKeys.some((fk) => fk.columns.some((x) => low(x) === low(c.name)));
      const inUnique = current.uniques.some((u) => u.columns.some((x) => low(x) === low(c.name)));
      if (inPk || inIndex || inFk || inUnique) rebuild(`drop ${c.name}, which is part of ${inPk ? 'the primary key' : inFk ? 'a foreign key' : inUnique ? 'a unique constraint' : 'an index'},`);
    }
    if (d === 'tsql') {
      if (c.default) {
        if (c.defaultConstraint) dropCols.push(`${T} DROP CONSTRAINT ${q(c.defaultConstraint)}`);
        else P.push(`The name of ${c.name}'s default constraint is not known, so the column cannot be dropped here.`);
      }
      for (const ix of current.indexes) if (!ix.constraint && ix.columns.some((x) => low(x.name) === low(c.name))) dropCols.push(`DROP INDEX ${q(ix.name)} ON ${t.sql}`);
    }
    dropCols.push(d === 'oracle' ? `${T} DROP (${ref})` : `${T} DROP COLUMN ${ref}`);
  }

  // 3 and 4. Renames, then changes of the columns kept.
  for (const m of matched) {
    const { form: c, cur, ref } = m;
    if (m.renamed) {
      if (d === 'tsql') renames.push(`EXEC sp_rename N${lit(`${spec.name}.${cur.name}`)}, N${lit(n.part(c.name, 'The column'))}, N'COLUMN'`);
      else renames.push(`${T} RENAME COLUMN ${q(cur.name)} TO ${ref}`);
    }
    const kept = keepRaw.has(low(c.name));
    if (kept && !RAW_TYPE.test(cur.rawType)) {
      P.push(`${c.name}: its type ${cur.rawType} cannot be restated here; choose a type for it.`);
      continue;
    }
    const ty = kept ? { text: cur.rawType, vt: { name: cur.rawType, group: 'other' as const, params: 'none' as const } } : typeOf(c);
    if (!ty) continue;
    if (!kept) identityOk(c, ty.vt);
    const typeChanged = kept ? false : !sameType(d, cur, c.type as TypeChoice);
    const nullable = formNullable(c);
    const nullChanged = nullable !== cur.nullable;
    const defChanged = !sameDefault(cur.default, c.default);
    const newComment = c.comment ? c.comment : null;
    const commentChanged = newComment !== (cur.comment || null);
    const identityChanged = c.identity !== cur.identity;
    const dv = hasDefault(c.default) ? defaultSql(ty.vt, c.default!, c.name) : null;
    if (typeChanged && !widens(d, cur.type, c.type as TypeChoice)) {
      destructive = true;
      notes.push(`Changing ${cur.name} from ${cur.rawType} to ${ty.text} can lose data: it is not a pure widening of the type.`);
    }
    if (typeChanged && d === 'snowflake') {
      const p = snowflakeTypeProblem(cur.type, c.type as TypeChoice, cur.name);
      if (p) P.push(p);
    }
    if (typeChanged && d === 'bigquery') {
      const p = bigqueryTypeProblem(cur.type, c.type as TypeChoice, cur.name);
      if (p) P.push(p);
    }
    const using = spec.using[c.name] ?? spec.using[cur.name];
    if (using !== undefined) {
      if (d !== 'postgres') P.push('USING applies to PostgreSQL type changes only.');
      else if (!typeChanged) P.push(`USING is given for ${c.name}, whose type does not change.`);
      const bad = expressionProblem(d, using);
      if (bad) P.push(`The USING expression of ${c.name}: ${bad}`);
    }
    const A = (clause: string) => alters.push(`${T} ALTER COLUMN ${ref} ${clause}`);
    switch (d) {
      case 'postgres': {
        if (identityChanged && !c.identity) A('DROP IDENTITY');
        if (typeChanged) {
          const fromGroup = cur.type ? findType(d, cur.type.type)?.group : undefined;
          const u = using ?? (fromGroup !== ty.vt.group ? `${ref}::${ty.text}` : null);
          A(`TYPE ${ty.text}${u ? ` USING ${u}` : ''}`);
        }
        if (nullChanged) A(nullable ? 'DROP NOT NULL' : 'SET NOT NULL');
        if (defChanged) A(dv ? `SET DEFAULT ${dv}` : 'DROP DEFAULT');
        if (identityChanged && c.identity) A(`ADD ${identityClause(d)}`);
        if (commentChanged) alters.push(`COMMENT ON COLUMN ${t.sql}.${ref} IS ${newComment === null ? 'NULL' : lit(newComment)}`);
        break;
      }
      case 'mysql':
        if (typeChanged || nullChanged || defChanged || commentChanged || identityChanged) {
          alters.push(`${T} MODIFY COLUMN ${ref} ${ty.text}${c.identity ? ` ${identityClause(d)}` : ''}${nullable ? ' NULL' : ' NOT NULL'}${dv ? ` DEFAULT ${dv}` : ''}${newComment ? ` COMMENT ${lit(newComment)}` : ''}`);
        }
        break;
      case 'tsql':
        if (identityChanged) P.push(`${c.name}: SQL Server cannot make an existing column an identity column or stop one being one; add a new column instead.`);
        if (typeChanged || nullChanged) A(`${ty.text} ${nullable ? 'NULL' : 'NOT NULL'}`);
        if (defChanged) {
          if (cur.default) {
            if (cur.defaultConstraint) alters.push(`${T} DROP CONSTRAINT ${q(cur.defaultConstraint)}`);
            else P.push(`The name of ${cur.name}'s default constraint is not known, so its default cannot be changed here.`);
          }
          if (dv) alters.push(`${T} ADD CONSTRAINT ${dfName(c.name)} DEFAULT ${dv} FOR ${ref}`);
        }
        if (commentChanged) notes.push(`SQL Server keeps no column comments here; ${c.name}'s comment is left out.`);
        break;
      case 'oracle': {
        const M = (clause: string) => alters.push(`${T} MODIFY (${ref} ${clause})`);
        if (identityChanged) {
          if (c.identity) P.push(`${c.name}: Oracle cannot make an existing column an identity column; add a new column instead.`);
          else M('DROP IDENTITY');
        }
        if (typeChanged) M(ty.text);
        if (nullChanged) M(nullable ? 'NULL' : 'NOT NULL');
        if (defChanged) M(`DEFAULT ${dv ?? 'NULL'}`);
        if (commentChanged) alters.push(`COMMENT ON COLUMN ${t.sql}.${ref} IS ${lit(newComment ?? '')}`);
        break;
      }
      case 'snowflake':
        if (identityChanged) P.push(`${c.name}: Snowflake cannot make an existing column an identity column or stop one being one; add a new column instead.`);
        if (typeChanged) A(`SET DATA TYPE ${ty.text}`);
        if (nullChanged) A(nullable ? 'DROP NOT NULL' : 'SET NOT NULL');
        if (defChanged) {
          if (dv) P.push(`${c.name}: Snowflake cannot give an existing column a new default (only a sequence); add a new column with the default instead.`);
          else A('DROP DEFAULT');
        }
        if (commentChanged) A(newComment === null ? 'UNSET COMMENT' : `COMMENT ${lit(newComment)}`);
        break;
      case 'bigquery':
        if (c.identity) P.push('BigQuery has no identity columns; use GENERATE_UUID() as a default instead.');
        if (typeChanged) A(`SET DATA TYPE ${ty.text}`);
        if (nullChanged) {
          if (nullable) A('DROP NOT NULL');
          else P.push(`${c.name}: BigQuery cannot make an existing column NOT NULL (REQUIRED).`);
        }
        if (defChanged) A(dv ? `SET DEFAULT ${dv}` : 'DROP DEFAULT');
        if (commentChanged) A(`SET OPTIONS(description=${newComment === null ? 'NULL' : lit(newComment)})`);
        break;
      case 'sqlite':
        if (typeChanged) rebuild(`change the type of ${c.name}`);
        if (nullChanged) rebuild(`change whether ${c.name} takes NULL`);
        if (defChanged) rebuild(`change the default of ${c.name}`);
        if (identityChanged) rebuild(`change whether ${c.name} is an identity column`);
        if (commentChanged) notes.push(`SQLite keeps no column comments; ${c.name}'s comment is left out.`);
        break;
    }
  }

  // 5. New columns.
  for (const c of added) {
    const ty = typeOf(c);
    if (!ty) continue;
    identityOk(c, ty.vt);
    const name = n.one(c.name, 'The column');
    const notNull = !formNullable(c);
    const dv = hasDefault(c.default) ? defaultSql(ty.vt, c.default!, c.name) : null;
    const idc = c.identity && identityClause(d) ? ` ${identityClause(d)}` : '';
    const comment = c.comment || null;
    if (d === 'postgres' && notNull && !dv && !c.identity) notes.push(`Adding ${c.name} as NOT NULL without a default fails if the table has rows.`);
    switch (d) {
      case 'postgres':
        adds.push(`${T} ADD COLUMN ${name} ${ty.text}${idc}${notNull ? ' NOT NULL' : ''}${dv ? ` DEFAULT ${dv}` : ''}`);
        if (comment) adds.push(`COMMENT ON COLUMN ${t.sql}.${name} IS ${lit(comment)}`);
        break;
      case 'mysql':
        adds.push(`${T} ADD COLUMN ${name} ${ty.text}${idc}${notNull ? ' NOT NULL' : ''}${dv ? ` DEFAULT ${dv}` : ''}${comment ? ` COMMENT ${lit(comment)}` : ''}`);
        break;
      case 'tsql':
        adds.push(`${T} ADD ${name} ${ty.text}${idc} ${notNull ? 'NOT NULL' : 'NULL'}${dv ? ` CONSTRAINT ${dfName(c.name)} DEFAULT ${dv}` : ''}`);
        if (notNull && !dv && !c.identity) notes.push(`Adding ${c.name} as NOT NULL without a default fails if the table has rows.`);
        if (comment) notes.push(`SQL Server keeps no column comments here; ${c.name}'s comment is left out.`);
        break;
      case 'oracle':
        adds.push(`${T} ADD (${name} ${ty.text}${idc}${dv ? ` DEFAULT ${dv}` : ''}${notNull ? ' NOT NULL' : ''})`);
        if (comment) adds.push(`COMMENT ON COLUMN ${t.sql}.${name} IS ${lit(comment)}`);
        break;
      case 'snowflake':
        adds.push(`${T} ADD COLUMN ${name} ${ty.text}${idc}${notNull ? ' NOT NULL' : ''}${dv ? ` DEFAULT ${dv}` : ''}${comment ? ` COMMENT ${lit(comment)}` : ''}`);
        if (c.identity) notes.push('Snowflake adds an identity column only to an empty table.');
        break;
      case 'bigquery':
        if (c.identity) P.push('BigQuery has no identity columns; use GENERATE_UUID() as a default instead.');
        if (notNull) P.push(`${c.name}: BigQuery cannot add a NOT NULL (REQUIRED) column to an existing table.`);
        adds.push(`${T} ADD COLUMN ${name} ${ty.text}${dv ? ` DEFAULT ${dv}` : ''}${comment ? ` OPTIONS(description=${lit(comment)})` : ''}`);
        break;
      case 'sqlite':
        if (c.identity) P.push(`${c.name}: SQLite cannot add a primary key or identity column to an existing table.`);
        if (notNull && (!dv || dv === 'NULL')) P.push(`${c.name}: SQLite adds a NOT NULL column only with a default other than NULL.`);
        if (c.default?.kind === 'expression') P.push(`${c.name}: SQLite cannot add a column whose default is an expression.`);
        adds.push(`${T} ADD COLUMN ${name} ${ty.text}${notNull ? ' NOT NULL' : ''}${dv ? ` DEFAULT ${dv}` : ''}`);
        if (comment) notes.push(`SQLite keeps no column comments; ${c.name}'s comment is left out.`);
        break;
    }
  }

  // 1 and 6. Constraints: matched by name; changed ones dropped and added again.
  const taken = new Set<string>();
  const fresh = (prefix: string, cols: string[]) => {
    let name = shortName(prefix, tableBase, cols, max);
    for (let k = 2; taken.has(low(name)); k++) name = shortName(prefix, tableBase, [...cols, String(k)], max);
    taken.add(low(name));
    return name;
  };
  const conName = (given: string | undefined, prefix: string, cols: string[]) => {
    if (given) taken.add(low(given));
    return n.one(given ?? fresh(prefix, cols), 'The constraint name');
  };
  const sqliteConstraints = () => rebuild('add, drop or change constraints');
  const dropConstraint = (name: string, mysqlForm: string) => dropCons.push(d === 'mysql' ? `${T} DROP ${mysqlForm} ${q(name)}` : `${T} DROP CONSTRAINT ${q(name)}`);
  const fkDrops: string[] = [];
  const ckDrops: string[] = [];
  const uqDrops: string[] = [];

  // Names that stay are taken; names of constraints being dropped are free again.
  const formUniqueNames = new Set(spec.uniques.flatMap((u) => (u.name ? [low(u.name)] : [])));
  const formFkNames = new Set(fks.flatMap((f) => (f.name ? [low(f.name)] : [])));
  const formCheckNames = new Set(spec.checks.flatMap((c) => (c.name ? [low(c.name)] : [])));
  for (const u of current.uniques) if (formUniqueNames.has(low(u.name))) taken.add(low(u.name));
  for (const f of current.foreignKeys) if (formFkNames.has(low(f.name))) taken.add(low(f.name));
  for (const c of current.checks) if (formCheckNames.has(low(c.name))) taken.add(low(c.name));
  for (const ix of current.indexes) taken.add(low(ix.name));

  // Primary key.
  spec.primaryKey.forEach((c) => known(c, 'The primary key'));
  const curPk = current.primaryKey && current.primaryKey.columns.length ? current.primaryKey : null;
  const pkChanged = curPk ? !sameCols(curPk.columns, spec.primaryKey) : spec.primaryKey.length > 0;
  let pkDrop: string | null = null;
  if (pkChanged) {
    if (d === 'sqlite') sqliteConstraints();
    if (curPk) {
      if (d === 'postgres' || d === 'tsql') {
        if (curPk.name) pkDrop = `${T} DROP CONSTRAINT ${q(curPk.name)}`;
        else P.push('The name of the primary key constraint is not known, so it cannot be dropped here.');
      } else pkDrop = `${T} DROP PRIMARY KEY`;
    }
    if (spec.primaryKey.length) {
      const cols = spec.primaryKey.map((c) => n.one(c)).join(', ');
      if (d === 'bigquery') addCons.push(`${T} ADD PRIMARY KEY (${cols}) NOT ENFORCED`);
      else addCons.push(`${T} ADD CONSTRAINT ${conName(curPk?.name ?? undefined, 'pk', [])} PRIMARY KEY (${cols})`);
      if (d === 'snowflake') notes.push('Snowflake records primary, unique and foreign keys but does not enforce them (NOT NULL is enforced).');
    }
  }

  // Uniques.
  const curUniques = new Map(current.uniques.map((u) => [low(u.name), u]));
  // An existing constraint without a name (SQLite) is matched by what it says, not by name.
  const unnamedUq = new Set(spec.uniques.filter((x) => !x.name && current.uniques.some((u) => !u.name && sameCols(u.columns, x.columns))));
  for (const u of current.uniques) {
    if (!u.name) {
      if (!spec.uniques.some((x) => unnamedUq.has(x) && sameCols(u.columns, x.columns))) uqDrops.push(u.name);
      continue;
    }
    const form = spec.uniques.find((x) => x.name && low(x.name) === low(u.name));
    if (!form || !sameCols(u.columns, form.columns)) uqDrops.push(u.name);
  }
  for (const u of spec.uniques) {
    u.columns.forEach((c) => known(c, 'A unique constraint'));
    if (unnamedUq.has(u)) continue;
    const cur = u.name ? curUniques.get(low(u.name)) : undefined;
    if (cur && sameCols(cur.columns, u.columns)) continue;
    if (d === 'bigquery') {
      P.push('BigQuery has no unique constraints.');
      continue;
    }
    addCons.push(`${T} ADD CONSTRAINT ${conName(u.name, 'uq', u.columns)} UNIQUE (${u.columns.map((c) => n.one(c)).join(', ')})`);
  }

  // Foreign keys.
  const action = (a: string | null | undefined) => (a ?? 'NO ACTION').toUpperCase().replace(/_/g, ' ');
  const sameTable = (a: string, b: string) => low(a) === low(b) || canonical(a, ctx) === canonical(b, ctx);
  const curFks = new Map(current.foreignKeys.map((f) => [low(f.name), f]));
  const sameFk = (cur: TableDescription['foreignKeys'][number], f: ForeignKey) =>
    sameCols(cur.columns, f.columns) && sameTable(cur.refTable, f.refTable) && cur.refColumns.length === f.refColumns.length && cur.refColumns.every((c, i) => low(c) === low(f.refColumns[i]!)) && action(cur.onDelete) === action(f.onDelete) && action(cur.onUpdate) === action(f.onUpdate);
  const unnamedFk = new Set(fks.filter((x) => !x.name && current.foreignKeys.some((f) => !f.name && sameFk(f, x))));
  for (const f of current.foreignKeys) {
    if (!f.name) {
      if (!fks.some((x) => unnamedFk.has(x) && sameFk(f, x))) fkDrops.push(f.name);
      continue;
    }
    const form = fks.find((x) => x.name && low(x.name) === low(f.name));
    if (!form || !sameFk(f, form)) fkDrops.push(f.name);
  }
  for (const f of fks) {
    f.columns.forEach((c) => known(c, 'A foreign key'));
    if (unnamedFk.has(f)) continue;
    const cur = f.name ? curFks.get(low(f.name)) : undefined;
    if (cur && sameFk(cur, f)) continue;
    touches.add(f.refTable);
    addCons.push(`${T} ADD CONSTRAINT ${conName(f.name, 'fk', f.columns)} ${foreignKeyClause(d, f, n, notes)}`);
  }

  // Checks.
  const checkText = (s: string) => normExpr(s.replace(/^\s*CHECK\s*/i, ''));
  const curChecks = new Map(current.checks.map((c) => [low(c.name), c]));
  const unnamedCk = new Set(spec.checks.filter((x) => !x.name && current.checks.some((c) => !c.name && checkText(c.expression) === checkText(x.expression))));
  for (const c of current.checks) {
    if (!c.name) {
      if (!spec.checks.some((x) => unnamedCk.has(x) && checkText(c.expression) === checkText(x.expression))) ckDrops.push(c.name);
      continue;
    }
    const form = spec.checks.find((x) => x.name && low(x.name) === low(c.name));
    if (!form || checkText(form.expression) !== checkText(c.expression)) ckDrops.push(c.name);
  }
  spec.checks.forEach((ck, i) => {
    if (unnamedCk.has(ck)) return;
    const cur = ck.name ? curChecks.get(low(ck.name)) : undefined;
    if (cur && checkText(cur.expression) === checkText(ck.expression)) return;
    if (d === 'bigquery' || d === 'snowflake') {
      P.push(`${D} has no CHECK constraints.`);
      return;
    }
    const bad = expressionProblem(d, ck.expression);
    if (bad) P.push(`A CHECK constraint: ${bad}`);
    addCons.push(`${T} ADD CONSTRAINT ${conName(ck.name, 'ck', [String(i + 1)])} CHECK (${ck.expression})`);
  });

  if (d === 'sqlite' && (fkDrops.length || ckDrops.length || uqDrops.length || addCons.length)) sqliteConstraints();
  for (const name of fkDrops) dropConstraint(name, 'FOREIGN KEY');
  for (const name of ckDrops) dropConstraint(name, 'CHECK');
  for (const name of uqDrops) dropConstraint(name, 'INDEX');
  if (pkDrop) dropCons.push(pkDrop);

  // 7. The table's comment (left as it is when the definition has none).
  if (spec.comment !== undefined) {
    const c = spec.comment || null;
    if (c !== (current.comment || null)) {
      switch (d) {
        case 'postgres':
          tableComment.push(`COMMENT ON TABLE ${t.sql} IS ${c === null ? 'NULL' : lit(c)}`);
          break;
        case 'oracle':
          tableComment.push(`COMMENT ON TABLE ${t.sql} IS ${lit(c ?? '')}`);
          break;
        case 'mysql':
          tableComment.push(`${T} COMMENT = ${lit(c ?? '')}`);
          break;
        case 'snowflake':
          tableComment.push(c === null ? `${T} UNSET COMMENT` : `${T} SET COMMENT = ${lit(c)}`);
          break;
        case 'bigquery':
          tableComment.push(`${T} SET OPTIONS(description=${c === null ? 'NULL' : lit(c)})`);
          break;
        case 'tsql':
          notes.push('SQL Server keeps comments as extended properties, which the designer does not write; the comment is left out.');
          break;
        case 'sqlite':
          notes.push('SQLite keeps no table comments; the comment is left out.');
          break;
      }
    }
  }

  // 8. The table's new name, last.
  if (spec.rename !== undefined) {
    const part = n.part(spec.rename, 'The new table name');
    const current = t.parts[t.parts.length - 1] ?? '';
    if (part !== current && !(caseInsensitive && low(part) === low(current))) {
      const newQ = dialect(d).quoteIdent(part);
      const sameSchema = t.parts.length > 1 ? `${t.parts.slice(0, -1).map((p) => dialect(d).quoteIdent(p)).join('.')}.${newQ}` : newQ;
      switch (d) {
        case 'mysql':
          renameTable.push(`RENAME TABLE ${t.sql} TO ${sameSchema}`);
          break;
        case 'tsql':
          renameTable.push(`EXEC sp_rename N${lit(spec.name)}, N${lit(part)}`);
          break;
        case 'snowflake':
          renameTable.push(`${T} RENAME TO ${sameSchema}`);
          break;
        default:
          renameTable.push(`${T} RENAME TO ${newQ}`);
      }
      notes.push(`The allow-list entry for ${spec.name} moves to the new name ${spec.rename} once the change runs.`);
    }
  }

  const statements = [...dropCons, ...dropCols, ...renames, ...alters, ...adds, ...addCons, ...tableComment, ...renameTable];
  if (!P.length && !statements.length) P.push('Nothing to change.');
  if (P.length) throw new DdlProblem([...new Set(P)]);
  const transactional = TRANSACTIONAL[d];
  if (!transactional && statements.length > 1) notes.push(COMMITS_NOTE);
  void engine;
  return { engine, kind: 'alter-table', object: spec.name, statements, ops: [], transactional, touches: [...touches], notes: [...new Set(notes)], destructive, confirmName: destructive ? spec.name : null };
}

// ---------------------------------------------------------------------------------------------------------------
// replace-index
// ---------------------------------------------------------------------------------------------------------------

/** The statement that drops an index in a dialect; `name` is the index as named now (quoted as is), `table` its table. */
function dropIndexSql(d: DialectId, n: Names, name: string, table: { sql: string; parts: string[] } | null, opts: { ifExists?: boolean; cascade?: boolean; concurrently?: boolean; schema?: string | null } = {}): string {
  const q = (s: string) => dialect(d).quoteIdent(s);
  const ie = opts.ifExists ? ' IF EXISTS' : '';
  const qualifiedIx = opts.schema ? `${q(opts.schema)}.${q(name)}` : q(name);
  switch (d) {
    case 'postgres':
      return `DROP INDEX${opts.concurrently ? ' CONCURRENTLY' : ''}${ie} ${qualifiedIx}${opts.cascade ? ' CASCADE' : ''}`;
    case 'oracle':
      return `DROP INDEX ${qualifiedIx}`;
    case 'mysql':
      return `DROP INDEX ${q(name)} ON ${table!.sql}`;
    case 'tsql':
      return `DROP INDEX${ie} ${q(name)} ON ${table!.sql}`;
    case 'bigquery':
      return `DROP SEARCH INDEX${ie} ${q(name)} ON ${table!.sql}`;
    default:
      void n;
      return `DROP INDEX${ie} ${q(name)}`;
  }
}

function replaceIndex(engine: Engine, d: DialectId, ctx: NameContext, raw: unknown, current: ObjectDescription | null): Plan {
  const head = parseWith(replaceIndexSpec, raw);
  const { from, ...rest } = head as { from: string } & Record<string, unknown>;
  const spec = parseWith(sqlIndexSpec, { ...rest, kind: 'index' });
  if (!isTable(current)) throw new DdlProblem([`The table ${spec.table} does not exist.`]);
  const old = current.indexes.find((ix) => low(ix.name) === low(from));
  if (!old) throw new DdlProblem([`${from} is not an index of ${spec.table}.`]);
  if (old.constraint) throw new DdlProblem([`${old.name} backs the primary key or a unique constraint; edit the constraint instead.`]);
  const n = new Names(d, ctx);
  const notes: string[] = [];
  const t = n.object(spec.table, 'The table', { needSchema: d === 'bigquery' });
  const schema = d === 'postgres' ? (t.parts.length > 1 ? t.parts[0]! : null) : d === 'oracle' ? n.schemaOf(t.parts) : null;
  const drop = dropIndexSql(d, n, old.name, t, { concurrently: spec.concurrently, schema });
  const made = buildSqlIndex(d, spec, n, notes);
  if (n.problems.length) throw new DdlProblem([...new Set(n.problems)]);
  const statements = [drop, ...made.statements];
  notes.unshift(`${old.name} is dropped and built again: queries that use it are slower until the new index is built.`);
  if (spec.concurrently) notes.push('DROP INDEX CONCURRENTLY runs outside a transaction too.');
  const transactional = made.transactional ?? TRANSACTIONAL[d];
  if (!transactional && statements.length > 1) notes.push(COMMITS_NOTE);
  return { engine, kind: 'replace-index', object: `${spec.table}:${spec.name}`, statements, ops: [], transactional, touches: [spec.table], notes, destructive: false, confirmName: null };
}

// ---------------------------------------------------------------------------------------------------------------
// drop
// ---------------------------------------------------------------------------------------------------------------

function dropPlan(engine: Engine, ctx: NameContext, raw: unknown): Plan {
  const spec = parseWith(dropSpec, raw);
  const title = engineInfo(engine).title;
  const allowed = editKinds(engine).drop;
  if (!allowed.includes(spec.objectKind)) throw new DdlProblem([allowed.length ? `${title} can drop ${allowed.join(', ')}, not ${spec.objectKind}.` : `${title} connections have no schema changes.`]);
  const family = familyOf(engine);
  const done = (r: { statements: string[]; ops?: AdminOp[]; touches: string[]; object: string; notes?: string[]; transactional?: boolean }, problems: string[]): Plan => {
    if (problems.length) throw new DdlProblem([...new Set(problems)]);
    return { engine, kind: 'drop' as DdlKind, object: r.object, statements: r.statements, ops: r.ops ?? [], transactional: r.transactional ?? false, touches: r.touches, notes: r.notes ?? [], destructive: true, confirmName: spec.name };
  };
  if (family === 'sql') return done(...dropSql(engine, engineInfo(engine).dialect!, ctx, spec));
  return done(...dropOther(engine, family, ctx, spec));
}

type DropSpec = z.infer<typeof dropSpec>;
type DropOut = [{ statements: string[]; ops?: AdminOp[]; touches: string[]; object: string; notes: string[]; transactional?: boolean }, string[]];

function dropSql(engine: Engine, d: DialectId, ctx: NameContext, s: DropSpec): DropOut {
  const n = new Names(d, ctx);
  const P = n.problems;
  const notes: string[] = [];
  const D = DNAME[d];
  const ie = s.ifExists ? ' IF EXISTS' : '';
  if (s.signature !== undefined && !(s.objectKind === 'procedure' || s.objectKind === 'function')) P.push('A signature names a routine.');
  if (s.on !== undefined && s.objectKind !== 'index') P.push(`${s.objectKind === 'table' ? 'A table' : 'This object'} is not dropped "on" another.`);
  if (s.destination !== undefined || s.destinationType !== undefined || s.propertiesKey !== undefined) P.push('Destinations and properties keys are RabbitMQ binding settings.');
  const noIfExists = () => {
    if (s.ifExists && d === 'oracle') P.push('Oracle before 23ai has no DROP … IF EXISTS; leave it off.');
  };
  const cascade = (what: string, word = ' CASCADE'): string => {
    if (!s.cascade) return '';
    if (d === 'postgres' || d === 'snowflake') return word;
    if (d === 'oracle' && (what === 'table' || what === 'view')) return ' CASCADE CONSTRAINTS';
    P.push(`${D} has no CASCADE for ${what === 'dataset' ? 'this drop' : `DROP ${what.toUpperCase()}`}; drop what depends on it first.`);
    return '';
  };
  let statements: string[] = [];
  const ops: AdminOp[] = [];
  let touches = [s.name];
  let object = s.name;
  switch (s.objectKind) {
    case 'table':
    case 'view': {
      noIfExists();
      const t = n.object(s.name, `The ${s.objectKind}`, { needSchema: d === 'bigquery' });
      statements = [`DROP ${s.objectKind.toUpperCase()}${ie} ${t.sql}${cascade(s.objectKind)}`];
      if (s.objectKind === 'table') notes.push(`Every row of ${s.name} is deleted with it.`);
      break;
    }
    case 'index': {
      const needsOn = d === 'mysql' || d === 'tsql' || d === 'bigquery';
      if (needsOn && !s.on) P.push(`${D} names an index with its table: give the table (on).`);
      if (s.ifExists && (d === 'mysql' || d === 'oracle')) P.push(`${D} has no DROP INDEX IF EXISTS; leave it off.`);
      if (s.cascade && d !== 'postgres') P.push(`${D} has no CASCADE for DROP INDEX; drop what depends on it first.`);
      const table = s.on ? n.object(s.on, 'The table', { needSchema: d === 'bigquery' }) : null;
      const ix = n.object(s.name, 'The index', { parts: d === 'postgres' || d === 'oracle' ? 2 : 1 });
      const ixName = ix.parts[ix.parts.length - 1] ?? s.name;
      let schema: string | null = null;
      if (d === 'postgres') schema = ix.parts.length > 1 ? ix.parts[0]! : table && table.parts.length > 1 ? table.parts[0]! : null;
      if (d === 'oracle') schema = ix.parts.length > 1 ? ix.parts[0]! : n.schemaOf(table?.parts ?? []);
      if (!P.length) statements = [dropIndexSql(d, n, ixName, table, { ifExists: s.ifExists, cascade: s.cascade, schema })];
      touches = [s.on ?? s.name];
      object = s.on ? `${s.on}:${s.name}` : s.name;
      break;
    }
    case 'procedure':
    case 'function': {
      noIfExists();
      const word = s.objectKind.toUpperCase();
      const r = n.object(s.name, `The ${s.objectKind}`, { needSchema: d === 'bigquery' });
      if (s.signature !== undefined) {
        if (d !== 'postgres' && d !== 'snowflake') P.push('A routine signature applies to PostgreSQL and Snowflake.');
        const bad = expressionProblem(d, s.signature);
        if (bad) P.push(`The signature: ${bad}`);
      }
      if (d === 'bigquery') {
        if (s.cascade) P.push('BigQuery has no CASCADE for routines.');
        statements = [`DROP ${word}${ie} ${r.sql}`];
        ops.push({ op: 'bigquery.deleteRoutine', datasetId: r.parts[0] ?? '', routineId: r.parts[1] ?? '' });
        notes.push('Sent to BigQuery through its routines API.');
        break;
      }
      const sig = d === 'postgres' ? (s.signature !== undefined ? `(${s.signature})` : '') : d === 'snowflake' ? `(${s.signature ?? ''})` : '';
      if (d === 'snowflake' && s.signature === undefined) notes.push('Snowflake names a routine with its argument types; with no signature this drops the one that takes no arguments.');
      statements = [`DROP ${word}${ie} ${r.sql}${sig}${s.cascade && d === 'postgres' ? ' CASCADE' : ''}`];
      if (s.cascade && d !== 'postgres') P.push(`${D} has no CASCADE for DROP ${word}.`);
      break;
    }
    case 'dataset': {
      const name = n.one(s.name, 'The name');
      switch (d) {
        case 'postgres':
          statements = [`DROP SCHEMA${ie} ${name}${cascade('dataset')}`];
          break;
        case 'snowflake':
          statements = [`DROP SCHEMA${ie} ${name}${cascade('dataset')}`];
          break;
        case 'mysql':
          if (s.cascade) P.push('MySQL has no CASCADE for DROP DATABASE: it always drops every table in the database.');
          statements = [`DROP DATABASE${ie} ${name}`];
          notes.push(`DROP DATABASE deletes every table in ${s.name}.`);
          break;
        case 'tsql':
          cascade('dataset');
          statements = [`DROP SCHEMA${ie} ${name}`];
          notes.push('SQL Server drops a schema only when it is empty.');
          break;
        case 'bigquery':
          statements = [`DROP SCHEMA${ie} ${name}${s.cascade ? ' CASCADE' : ''}`];
          ops.push({ op: 'bigquery.deleteDataset', datasetId: n.part(s.name, 'The dataset'), deleteContents: s.cascade });
          notes.push(s.cascade ? 'Every table in the dataset is deleted with it.' : 'BigQuery refuses to delete a dataset that still has tables unless CASCADE is chosen.');
          break;
        default:
          P.push(`${D} has no datasets to drop.`);
      }
      break;
    }
    default:
      P.push(`${D} has no ${s.objectKind} to drop.`);
  }
  void engine;
  const transactional = TRANSACTIONAL[d] && !ops.length;
  return [{ statements, ops, touches, object, notes, transactional }, P];
}

function dropOther(engine: Engine, family: ReturnType<typeof familyOf>, ctx: NameContext, s: DropSpec): DropOut {
  const P: string[] = [];
  const notes: string[] = [];
  const title = engineInfo(engine).title;
  const check = (ok: boolean, msg: string) => {
    if (!ok) P.push(msg);
  };
  const needOn = (what: string): string => {
    if (!s.on) P.push(`Give the ${what} (on).`);
    return s.on ?? '';
  };
  if (s.cascade) P.push(`${title} has no CASCADE.`);
  if (s.signature !== undefined) P.push('A signature names a SQL routine.');
  if (family !== 'rabbitmq' && (s.destination !== undefined || s.destinationType !== undefined || s.propertiesKey !== undefined)) P.push('Destinations and properties keys are RabbitMQ binding settings.');
  if (s.ifExists && family !== 'rabbitmq') notes.push('A missing object is reported by the service; IF EXISTS is not sent.');
  const k = s.objectKind;
  switch (family) {
    case 'mongo': {
      const coll = /^[A-Za-z_][A-Za-z0-9_.-]{0,119}$/;
      if (k === 'collection') {
        check(coll.test(s.name), `${s.name} is not a collection name.`);
        return [{ statements: [`db.${s.name}.drop()`], ops: [{ op: 'mongo.dropCollection', name: s.name }], touches: [s.name], object: s.name, notes: [...notes, `Every document in ${s.name} and its indexes are deleted.`] }, P];
      }
      const on = needOn('collection');
      check(!on || coll.test(on), `${on} is not a collection name.`);
      check(/^[A-Za-z0-9_.-]{1,127}$/.test(s.name) && s.name !== '*', `${s.name} is not an index name.`);
      check(s.name !== '_id_', 'The _id index cannot be dropped.');
      return [{ statements: [`db.${on}.dropIndex(${JSON.stringify(s.name)})`], ops: [{ op: 'mongo.dropIndex', collection: on, index: s.name }], touches: [on], object: `${on}:${s.name}`, notes }, P];
    }
    case 'opensearch':
      // A single concrete index: no wildcards, lists or _all, which DELETE would expand.
      check(/^[a-z0-9][a-z0-9._-]{0,254}$/.test(s.name), `${s.name} is not one index name (no wildcards, commas or _all).`);
      return [{ statements: [`DELETE /${s.name}`], ops: [{ op: 'opensearch.deleteIndex', index: s.name }], touches: [s.name], object: s.name, notes: [...notes, `Every document in ${s.name} is deleted.`] }, P];
    case 'dynamodb': {
      const dyn = /^[A-Za-z0-9_.-]{3,255}$/;
      check(dyn.test(s.name), `${s.name} is not a DynamoDB ${k === 'index' ? 'index' : 'table'} name.`);
      if (k === 'table') return [{ statements: [`DeleteTable ${json({ TableName: s.name })}`], ops: [{ op: 'dynamodb.deleteTable', input: { TableName: s.name } }], touches: [s.name], object: s.name, notes: [...notes, `Every item in ${s.name} is deleted.`] }, P];
      const on = needOn('table');
      check(!on || dyn.test(on), `${on} is not a DynamoDB table name.`);
      const input = { TableName: on, GlobalSecondaryIndexUpdates: [{ Delete: { IndexName: s.name } }] };
      return [{ statements: [`UpdateTable ${json(input)}`], ops: [{ op: 'dynamodb.updateTable', input }], touches: [on], object: `${on}:${s.name}`, notes }, P];
    }
    case 'cosmos':
      check(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,254}$/.test(s.name), `${s.name} is not a Cosmos DB id.`);
      if (k === 'container') return [{ statements: [`DELETE /dbs/${ctx.database ?? '<database>'}/colls/${s.name}`], ops: [{ op: 'cosmos.deleteContainer', id: s.name }], touches: [s.name], object: s.name, notes: [...notes, `Every item in ${s.name} is deleted.`] }, P];
      return [{ statements: [`DELETE /dbs/${s.name}`], ops: [{ op: 'cosmos.deleteDatabase', id: s.name }], touches: [s.name], object: s.name, notes: [...notes, `Every container in ${s.name} is deleted.`] }, P];
    case 'influx': {
      check(/^[A-Za-z0-9_.-]{1,64}$/.test(s.name), 'An InfluxDB database name takes letters, digits, _, . and -.');
      if (String(ctx.options.version ?? 'v2') === 'v2') P.push('InfluxDB 2.x deletes buckets in its own UI or API with an org token; the designer drops databases on 1.x and 3.');
      return [{ statements: [`DROP DATABASE "${s.name}"`], ops: [{ op: 'influx.dropDatabase', name: s.name }], touches: [s.name], object: s.name, notes: [...notes, `Every series in ${s.name} is deleted.`] }, P];
    }
    case 'redis': {
      const key = needOn('stream key');
      check(!key || /^[^\s*?[\]]{1,512}$/.test(key), 'The stream key cannot contain spaces or glob characters.');
      check(/^[A-Za-z0-9_.:-]{1,200}$/.test(s.name), `${s.name} is not a consumer group name.`);
      return [{ statements: [`XGROUP DESTROY ${key} ${s.name}`], ops: [{ op: 'redis.xgroupDestroy', key, group: s.name }], touches: [key], object: `${key}:${s.name}`, notes: [...notes, 'The group and its pending entries list are removed; the stream itself stays.'] }, P];
    }
    case 'rabbitmq': {
      const vh = (s.on ?? ctx.database ?? '/').replace(/%2F/gi, '/');
      check(/^[A-Za-z0-9_./:@-]+$/.test(vh), `${vh} is not a virtual host name.`);
      const rabbit = /^[A-Za-z0-9_.:@-][A-Za-z0-9_.:@/-]*$/;
      check(rabbit.test(s.name) && s.name.length <= 255, `${s.name} is not a RabbitMQ name.`);
      if (s.ifExists) notes.push('RabbitMQ answers 404 for a missing object; IF EXISTS is not sent.');
      const path = (name: string) => `${encodeURIComponent(vh)}/${encodeURIComponent(name)}`;
      if (k === 'queue') {
        const qs = s.ifEmpty ? '?if-empty=true&if-unused=true' : '';
        if (s.ifEmpty) notes.push('The broker refuses if the queue still has messages or consumers.');
        else notes.push('The queue is deleted with any messages in it.');
        return [{ statements: [`DELETE /api/queues/${path(s.name)}${qs}`], ops: [{ op: 'rabbit.deleteQueue', vhost: vh, name: s.name, ifEmpty: s.ifEmpty, ifUnused: s.ifEmpty }], touches: [`${vh}/${s.name}`], object: `${vh}/${s.name}`, notes }, P];
      }
      if (/^amq\./.test(s.name)) P.push(`Names starting amq. are reserved by RabbitMQ (${s.name}).`);
      if (k === 'exchange') {
        return [{ statements: [`DELETE /api/exchanges/${path(s.name)}${s.ifEmpty ? '?if-unused=true' : ''}`], ops: [{ op: 'rabbit.deleteExchange', vhost: vh, name: s.name, ifUnused: s.ifEmpty }], touches: [`${vh}/${s.name}`], object: `${vh}/${s.name}`, notes: [...notes, ...(s.ifEmpty ? ['The broker refuses if the exchange is still bound.'] : ['The exchange is deleted with its bindings.'])] }, P];
      }
      // A binding: from the source exchange (name) to a queue or exchange, identified by its properties key.
      if (!s.destination) P.push('Give the binding\'s destination.');
      else check(rabbit.test(s.destination), `${s.destination} is not a RabbitMQ name.`);
      if (!s.destinationType) P.push('Give the binding\'s destination type (queue or exchange).');
      // The management API's properties key: "~" for an empty routing key without arguments, else the routing key (and a hash with arguments).
      const props = s.propertiesKey ?? '~';
      const t = s.destinationType === 'exchange' ? 'e' : 'q';
      const dest = s.destination ?? '';
      return [
        {
          statements: [`DELETE /api/bindings/${encodeURIComponent(vh)}/e/${encodeURIComponent(s.name)}/${t}/${encodeURIComponent(dest)}/${encodeURIComponent(props)}`],
          ops: [{ op: 'rabbit.unbind', vhost: vh, source: s.name, destination: dest, destinationType: t, propertiesKey: props }],
          touches: [t === 'q' ? `${vh}/${dest}` : `${vh}/${s.name}`],
          object: `${vh}/${s.name}->${dest}`,
          notes
        },
        P
      ];
    }
    default:
      P.push(`${title} connections have no schema changes.`);
      return [{ statements: [], touches: [], object: s.name, notes }, P];
  }
}

// ---------------------------------------------------------------------------------------------------------------
// edit (non-SQL objects)
// ---------------------------------------------------------------------------------------------------------------

type EditSpec = z.infer<typeof editObjectSpec>;

function isDocument(c: ObjectDescription | null): c is DocumentDescription {
  return !!c && 'definition' in c && typeof (c as DocumentDescription).definition === 'object';
}

/**
 * The description's definition read with the create schema. A store can report values the designer does not offer
 * (an unusual bsonType): then the description is taken as it is, over the schema's defaults.
 */
function readCurrent<T extends z.ZodObject<z.ZodRawShape>>(schema: T, def: Record<string, unknown>, defaults: Record<string, unknown>): z.infer<T> {
  const r = schema.strip().safeParse(def);
  return (r.success ? r.data : { ...defaults, ...def }) as z.infer<T>;
}

/**
 * The edited definition read with the create schema, except that an item of a list left exactly as the description
 * has it (a field of an unusual type the person did not touch) is not checked again.
 */
function readWanted<T extends z.ZodTypeAny>(schema: T, want: Record<string, unknown>, have: Record<string, unknown>, defaults: Record<string, unknown>): z.infer<T> {
  const r = schema.safeParse(want);
  if (r.success) return r.data;
  const untouched = (path: PropertyKey[]) => {
    const [key, idx] = path;
    if (typeof key !== 'string' || typeof idx !== 'number') return false;
    const item = (want[key] as unknown[] | undefined)?.[idx];
    const before = have[key];
    return Array.isArray(before) && before.some((b) => same(b, item));
  };
  const left = r.error.issues.filter((i) => !untouched(i.path));
  if (left.length) throw new DdlProblem(left.map((i) => `definition.${i.path.join('.') || 'definition'}: ${i.message}`));
  return { ...defaults, ...want } as z.infer<T>;
}

const MONGO_DEFAULTS = { fields: [], additionalProperties: true, validationLevel: 'strict', validationAction: 'error' };
const SEARCH_DEFAULTS = { shards: 1, replicas: 1, dynamic: 'true', fields: [] };
const DYNAMO_DEFAULTS = { billingMode: 'PAY_PER_REQUEST', indexes: [] };
const COSMOS_DEFAULTS = { uniqueKeys: [], excludedPaths: [] };

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function editObject(engine: Engine, ctx: NameContext, spec: EditSpec, current: ObjectDescription | null): Plan {
  const family = familyOf(engine);
  const k = spec.objectKind;
  if (!isDocument(current)) throw new DdlProblem([`The ${k} ${spec.name} does not exist.`]);
  if (current.kind !== k) throw new DdlProblem([`${spec.name} is a ${current.kind}, not a ${k}.`]);
  const P: string[] = [];
  const notes: string[] = [];
  const ops: AdminOp[] = [];
  const statements: string[] = [];
  let destructive = false;
  let object = spec.name;
  let touches = [spec.name];
  const def = spec.definition;

  if (family === 'mongo' && k === 'collection') {
    const haveRaw = { ...current.definition, kind: 'collection', name: spec.name };
    const want = readWanted(mongoCollectionSpec, { ...def, kind: 'collection', name: spec.name }, haveRaw, MONGO_DEFAULTS);
    const have = readCurrent(mongoCollectionSpec, haveRaw, MONGO_DEFAULTS);
    if (!same(want.capped, have.capped)) P.push('Whether a collection is capped, and its size, cannot be changed; make a new collection.');
    if (!same(want.timeseries, have.timeseries)) P.push('A time series collection\'s settings cannot be changed; make a new collection.');
    const validation = (s: typeof want) => {
      if (!s.fields.length) return null;
      const properties: Record<string, unknown> = {};
      for (const f of s.fields) {
        if (f.name.includes('.')) {
          P.push(`${f.name}: the validator describes top-level fields; nested paths go inside an object field.`);
          continue;
        }
        properties[f.name] = { bsonType: f.bsonType, ...(f.description ? { description: f.description } : {}) };
      }
      const required = s.fields.filter((f) => f.required).map((f) => f.name);
      return { validator: { $jsonSchema: { bsonType: 'object', ...(required.length ? { required } : {}), properties, ...(s.additionalProperties ? {} : { additionalProperties: false }) } }, validationLevel: s.validationLevel, validationAction: s.validationAction };
    };
    const a = validation(want);
    const b = validation(have);
    const options: Record<string, unknown> = {};
    if (!same(a, b)) {
      if (a) Object.assign(options, a);
      else Object.assign(options, { validator: {}, validationLevel: 'off' });
      if (!want.additionalProperties && want.fields.length && !want.fields.some((f) => f.name === '_id')) P.push('With no other fields allowed, list _id as a field too.');
      notes.push('A new validator applies to inserts and updates from now on; documents already stored are not checked.');
    }
    if (want.expireAfterSeconds !== have.expireAfterSeconds) {
      if (!want.timeseries) P.push('expireAfterSeconds on a collection is for time series; use a TTL index otherwise.');
      options.expireAfterSeconds = want.expireAfterSeconds ?? 'off';
    }
    if (Object.keys(options).length) {
      ops.push({ op: 'mongo.collMod', name: spec.name, options });
      statements.push(`db.runCommand(${json({ collMod: spec.name, ...options })})`);
    }
  } else if (family === 'opensearch' && k === 'search-index') {
    const haveRaw = { ...current.definition, kind: 'search-index', name: spec.name };
    const want = readWanted(searchIndexSpec, { ...def, kind: 'search-index', name: spec.name }, haveRaw, SEARCH_DEFAULTS);
    const have = readCurrent(searchIndexSpec, haveRaw, SEARCH_DEFAULTS);
    if (want.shards !== have.shards) P.push('The number of primary shards is fixed when an index is created; reindex into a new index (or use the split and shrink APIs) to change it.');
    const wantFields = new Map(want.fields.map((f) => [f.name, f]));
    const haveFields = new Map(have.fields.map((f) => [f.name, f]));
    const scratch: string[] = [];
    for (const [name, f] of haveFields) {
      const w = wantFields.get(name);
      if (!w) P.push(`${name}: OpenSearch cannot remove a mapped field; reindex into a new index without it.`);
      else if (!same(searchFieldMapping(w, scratch), searchFieldMapping(f, scratch))) P.push(`${name}: OpenSearch cannot change a mapped field in place; reindex into a new index with the new mapping.`);
    }
    const properties: Record<string, unknown> = {};
    let knn = false;
    for (const f of want.fields) {
      if (haveFields.has(f.name)) continue;
      if (f.name in properties) P.push(`${f.name} is listed twice.`);
      properties[f.name] = searchFieldMapping(f, P);
      if (f.type === 'knn_vector') knn = true;
    }
    if (knn && !have.fields.some((f) => f.type === 'knn_vector')) P.push('A knn_vector field needs an index made with knn enabled; reindex into a new index.');
    const mapping: Record<string, unknown> = {};
    if (want.dynamic !== have.dynamic) mapping.dynamic = want.dynamic;
    if (Object.keys(properties).length) mapping.properties = properties;
    if (Object.keys(mapping).length) {
      ops.push({ op: 'opensearch.putMapping', index: spec.name, body: mapping });
      statements.push(`PUT /${spec.name}/_mapping\n${json(mapping)}`);
    }
    if (want.replicas !== have.replicas) {
      const body = { index: { number_of_replicas: want.replicas } };
      ops.push({ op: 'opensearch.putSettings', index: spec.name, body });
      statements.push(`PUT /${spec.name}/_settings\n${json(body)}`);
    }
  } else if (family === 'dynamodb' && k === 'table') {
    // GSIs are diffed against definition.indexes (the description repeats them in `indexes`).
    const haveRaw = { ...current.definition, kind: 'table', name: spec.name };
    const want = readWanted(dynamoTableSpec, { ...def, kind: 'table', name: spec.name }, haveRaw, DYNAMO_DEFAULTS);
    const have = readCurrent(dynamoTableSpec, haveRaw, DYNAMO_DEFAULTS);
    if (!same(want.partitionKey, have.partitionKey) || !same(want.sortKey, have.sortKey)) P.push('A DynamoDB table\'s key cannot be changed; make a new table and copy the items.');
    const prov = want.billingMode === 'PROVISIONED';
    const haveIx = new Map(have.indexes.map((g) => [g.name, g]));
    const wantIx = new Map(want.indexes.map((g) => [g.name, g]));
    const keyOf = (g: (typeof want.indexes)[number]) => ({ pk: g.partitionKey, sk: g.sortKey ?? null, p: g.projection ?? 'ALL', a: g.nonKeyAttributes ?? [] });
    // Billing mode and capacity, with the capacity of the indexes that stay.
    const update: Record<string, unknown> = {};
    if (want.billingMode !== have.billingMode) update.BillingMode = want.billingMode;
    if (prov) {
      if (!want.readCapacity || !want.writeCapacity) P.push('The table needs read and write capacity with provisioned billing.');
      if (want.billingMode !== have.billingMode || want.readCapacity !== have.readCapacity || want.writeCapacity !== have.writeCapacity) update.ProvisionedThroughput = { ReadCapacityUnits: want.readCapacity ?? 1, WriteCapacityUnits: want.writeCapacity ?? 1 };
    } else if (want.readCapacity || want.writeCapacity) P.push('The table takes capacity only with provisioned billing.');
    const gsiUpdates: Record<string, unknown>[] = [];
    for (const [name, g] of wantIx) {
      const h = haveIx.get(name);
      if (!h) continue;
      if (!same(keyOf(g), keyOf(h))) P.push(`${name}: a global secondary index's keys and projection cannot be changed; drop it and add one under a new name.`);
      if (prov) {
        if (!g.readCapacity || !g.writeCapacity) P.push(`${name} needs read and write capacity with provisioned billing.`);
        if (want.billingMode !== have.billingMode || g.readCapacity !== h.readCapacity || g.writeCapacity !== h.writeCapacity) gsiUpdates.push({ Update: { IndexName: name, ProvisionedThroughput: { ReadCapacityUnits: g.readCapacity ?? 1, WriteCapacityUnits: g.writeCapacity ?? 1 } } });
      } else if (g.readCapacity || g.writeCapacity) P.push(`${name} takes capacity only with provisioned billing.`);
    }
    if (Object.keys(update).length || gsiUpdates.length) {
      const input = { TableName: spec.name, ...update, ...(gsiUpdates.length ? { GlobalSecondaryIndexUpdates: gsiUpdates } : {}) };
      ops.push({ op: 'dynamodb.updateTable', input });
      if (want.billingMode !== have.billingMode) notes.push('DynamoDB allows switching billing mode once every 24 hours.');
    }
    // Indexes removed, then added: one per UpdateTable call.
    for (const [name] of haveIx) {
      if (wantIx.has(name)) continue;
      destructive = true;
      ops.push({ op: 'dynamodb.updateTable', input: { TableName: spec.name, GlobalSecondaryIndexUpdates: [{ Delete: { IndexName: name } }] } });
    }
    for (const [name, g] of wantIx) {
      if (haveIx.has(name)) continue;
      const attrs = new Map<string, string>();
      for (const key of [g.partitionKey, g.sortKey]) if (key) attrs.set(key.name, key.type);
      if (g.projection === 'INCLUDE' && !g.nonKeyAttributes.length) P.push(`${name}: INCLUDE needs the attributes to include.`);
      if (g.projection !== 'INCLUDE' && g.nonKeyAttributes.length) P.push(`${name}: attributes are listed only with INCLUDE.`);
      if (prov && (!g.readCapacity || !g.writeCapacity)) P.push(`${name} needs read and write capacity with provisioned billing.`);
      if (!prov && (g.readCapacity || g.writeCapacity)) P.push(`${name} takes capacity only with provisioned billing.`);
      const create = {
        IndexName: name,
        KeySchema: [{ AttributeName: g.partitionKey.name, KeyType: 'HASH' }, ...(g.sortKey ? [{ AttributeName: g.sortKey.name, KeyType: 'RANGE' }] : [])],
        Projection: { ProjectionType: g.projection, ...(g.projection === 'INCLUDE' ? { NonKeyAttributes: g.nonKeyAttributes } : {}) },
        ...(prov ? { ProvisionedThroughput: { ReadCapacityUnits: g.readCapacity ?? 1, WriteCapacityUnits: g.writeCapacity ?? 1 } } : {})
      };
      ops.push({ op: 'dynamodb.updateTable', input: { TableName: spec.name, AttributeDefinitions: [...attrs].map(([AttributeName, AttributeType]) => ({ AttributeName, AttributeType })), GlobalSecondaryIndexUpdates: [{ Create: create }] } });
      notes.push('DynamoDB builds a new index in the background; it reads as CREATING until it is backfilled.');
    }
    if (ops.filter((o) => o.op === 'dynamodb.updateTable').length > 1) notes.push('DynamoDB takes one index change per UpdateTable call; each call waits until the table is ACTIVE again.');
    // Time to live.
    if (want.ttlAttribute !== have.ttlAttribute) {
      if (want.ttlAttribute && have.ttlAttribute) P.push(`Time to live is on ${have.ttlAttribute}; turn it off first, and on for ${want.ttlAttribute} in a later change (DynamoDB allows one TTL change an hour).`);
      else {
        const input = { TableName: spec.name, TimeToLiveSpecification: want.ttlAttribute ? { Enabled: true, AttributeName: want.ttlAttribute } : { Enabled: false, AttributeName: have.ttlAttribute! } };
        ops.push({ op: 'dynamodb.updateTimeToLive', input });
        if (!want.ttlAttribute) notes.push('With time to live off, expired items are no longer deleted.');
      }
    }
    for (const o of ops) statements.push(`${o.op === 'dynamodb.updateTimeToLive' ? 'UpdateTimeToLive' : 'UpdateTable'} ${json((o as { input: unknown }).input)}`);
  } else if (family === 'cosmos' && k === 'container') {
    const haveRaw = { ...current.definition, kind: 'container', name: spec.name };
    const want = readWanted(cosmosContainerSpec, { ...def, kind: 'container', name: spec.name }, haveRaw, COSMOS_DEFAULTS);
    const have = readCurrent(cosmosContainerSpec, haveRaw, COSMOS_DEFAULTS);
    if (!same(want.partitionKeyPaths, have.partitionKeyPaths)) P.push('A container\'s partition key cannot be changed; make a new container and copy the items.');
    if (!same(want.uniqueKeys, have.uniqueKeys)) P.push('A container\'s unique keys cannot be changed; make a new container and copy the items.');
    if (want.throughput !== undefined && want.throughput !== have.throughput) P.push('The designer does not change a container\'s throughput; use the account\'s tools.');
    if (want.defaultTtl === 0) P.push('defaultTtl is -1 (on, no default) or a number of seconds; 0 is not allowed.');
    if (want.defaultTtl !== have.defaultTtl || !same(want.excludedPaths, have.excludedPaths)) {
      const body = cosmosContainerBody(want);
      ops.push({ op: 'cosmos.replaceContainer', body });
      statements.push(`PUT /dbs/${ctx.database ?? '<database>'}/colls/${spec.name}\n${json(body)}`);
      if (!same(want.excludedPaths, have.excludedPaths)) notes.push('Cosmos DB rebuilds the index in the background after an indexing policy change; queries may miss results until it finishes.');
    }
  } else if (family === 'redis' && k === 'stream-group') {
    // The edited definition is {key, group, startId}; the description is the stream's: {key, groups: [{name, lastDeliveredId, …}]}.
    const want = parseWith(streamGroupSpec, { mkstream: false, ...def, kind: 'stream-group', group: (def.group as string | undefined) ?? spec.name }, 'definition');
    const haveKey = typeof current.definition.key === 'string' ? current.definition.key : null;
    const groups = Array.isArray(current.definition.groups) ? (current.definition.groups as { name?: unknown; lastDeliveredId?: unknown }[]) : [];
    if (haveKey !== null && haveKey !== want.key) P.push(`The description is of the stream ${haveKey}, not ${want.key}.`);
    const group = groups.find((g) => g.name === want.group);
    if (!group) P.push(`${want.group} is not a consumer group of the stream ${want.key}.`);
    object = want.key;
    touches = [want.key];
    if (group && want.startId !== group.lastDeliveredId) {
      ops.push({ op: 'redis.xgroupSetId', key: want.key, group: want.group, id: want.startId });
      statements.push(`XGROUP SETID ${want.key} ${want.group} ${want.startId}`);
      notes.push(want.startId === '0' ? 'The group reads the whole stream again from the start.' : want.startId === '$' ? 'The group skips every entry already in the stream.' : `The group's next read starts after ${want.startId}.`);
    }
  } else {
    P.push(`${engineInfo(engine).title} does not edit ${k}.`);
  }
  if (!P.length && !ops.length) P.push('Nothing to change.');
  if (P.length) throw new DdlProblem([...new Set(P)]);
  return { engine, kind: 'edit', object, statements, ops, transactional: false, touches, notes: [...new Set(notes)], destructive, confirmName: destructive ? spec.name : null };
}

