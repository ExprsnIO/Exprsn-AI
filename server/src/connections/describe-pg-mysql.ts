import type pg from 'pg';
import type mysql from 'mysql2/promise';
import type { DescribedIndex, RoutineDescription, TableDescription } from './ddl-edit-types.js';
import { parseType } from './ddl-types.js';
import { checkExpression, classifyDefault, emptyRoutine, emptyTable, fkAction, paramMode, mysqlBodyFromCreate, routineName, splitQualified, trimBody, unquoteIdent, unwrapParens } from './describe-sql.js';

/*
 * 2.0.x editing: `describe` and `routines` for PostgreSQL and MySQL, from pg_catalog and information_schema. Each
 * runs on the driver's read-only transaction (the caller opens it).
 */

export type RoutineListing = { name: string; kind: 'procedure' | 'function'; signature?: string | null }[];

// ---------------------------------------------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------------------------------------------

const PG_ACTIONS: Record<string, string> = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };

export async function pgDescribeTable(c: pg.Client, object: string): Promise<TableDescription | null> {
  const [schema, table] = splitQualified(object);
  const rel = (
    await c.query<{ oid: number; nsp: string; rel: string; kind: string; comment: string | null; persistence: string }>(
      "SELECT c.oid::int AS oid, n.nspname AS nsp, c.relname AS rel, c.relkind AS kind, obj_description(c.oid, 'pg_class') AS comment, c.relpersistence AS persistence FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = coalesce($1, current_schema()) AND c.relname = $2 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')",
      [schema, table]
    )
  ).rows[0];
  if (!rel) return null;
  const view = rel.kind === 'v' || rel.kind === 'm';
  const out = emptyTable(view ? 'view' : 'table', `${rel.nsp}.${rel.rel}`);
  out.comment = rel.comment;
  const cols = (
    await c.query<{ num: number; name: string; type: string; notnull: boolean; def: string | null; identity: string; generated: string; comment: string | null }>(
      "SELECT a.attnum::int AS num, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull, pg_get_expr(d.adbin, d.adrelid) AS def, a.attidentity::text AS identity, a.attgenerated::text AS generated, col_description(a.attrelid, a.attnum) AS comment FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum",
      [rel.oid]
    )
  ).rows;
  for (const col of cols) {
    const serial = !!col.def && /^nextval\(/i.test(col.def);
    const identity = col.identity === 'a' || col.identity === 'd' || serial;
    out.columns.push({ name: col.name, type: parseType('postgres', col.type), rawType: col.type, nullable: !col.notnull, default: identity ? null : classifyDefault(col.def), identity, comment: col.comment });
  }
  if (view) {
    out.definition = (await c.query<{ def: string }>('SELECT pg_get_viewdef($1::oid, true) AS def', [rel.oid])).rows[0]?.def?.trim() ?? null;
    return out;
  }
  if (rel.persistence === 'u') out.options.unlogged = true;
  const cons = (
    await c.query<{ name: string; type: string; cols: string[]; refcols: string[]; ref: string | null; del: string; upd: string; def: string }>(
      `SELECT con.conname AS name, con.contype::text AS type,
        ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(n, i) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.i) AS cols,
        ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(n, i) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.i) AS refcols,
        CASE WHEN con.confrelid <> 0 THEN fn.nspname || '.' || fc.relname END AS ref, con.confdeltype::text AS del, con.confupdtype::text AS upd, pg_get_constraintdef(con.oid, true) AS def
       FROM pg_constraint con LEFT JOIN pg_class fc ON fc.oid = con.confrelid LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
       WHERE con.conrelid = $1 ORDER BY con.conname`,
      [rel.oid]
    )
  ).rows;
  for (const k of cons) {
    if (k.type === 'p') out.primaryKey = { name: k.name, columns: k.cols };
    else if (k.type === 'u') out.uniques.push({ name: k.name, columns: k.cols });
    else if (k.type === 'f') out.foreignKeys.push({ name: k.name, columns: k.cols, refTable: k.ref ?? '', refColumns: k.refcols, onDelete: PG_ACTIONS[k.del] ?? null, onUpdate: PG_ACTIONS[k.upd] ?? null });
    else if (k.type === 'c') out.checks.push({ name: k.name, expression: checkExpression(k.def) });
  }
  const idx = (
    await c.query<{ name: string; unique: boolean; method: string; pred: string | null; nkey: number; cols: string[]; opts: number[]; backing: boolean }>(
      `SELECT ic.relname AS name, ix.indisunique AS unique, am.amname AS method, pg_get_expr(ix.indpred, ix.indrelid, true) AS pred, ix.indnkeyatts::int AS nkey,
        ARRAY(SELECT pg_get_indexdef(ix.indexrelid, k, true) FROM generate_series(1, ix.indnatts) k ORDER BY k) AS cols,
        ix.indoption::int2[] AS opts,
        EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = ix.indexrelid AND k.conrelid = ix.indrelid AND k.contype IN ('p', 'u', 'x')) AS backing
       FROM pg_index ix JOIN pg_class ic ON ic.oid = ix.indexrelid JOIN pg_am am ON am.oid = ic.relam WHERE ix.indrelid = $1 ORDER BY ic.relname`,
      [rel.oid]
    )
  ).rows;
  for (const i of idx) {
    const keys = i.cols.slice(0, i.nkey);
    const index: DescribedIndex = {
      name: i.name,
      columns: keys.map((name, n) => ({ name: unquoteIdent(name), order: ((i.opts?.[n] ?? 0) & 1) === 1 ? 'desc' : 'asc' })),
      unique: i.unique,
      method: i.method,
      where: i.pred ? unwrapParens(i.pred) : null,
      include: i.cols.slice(i.nkey).map(unquoteIdent),
      constraint: i.backing
    };
    out.indexes.push(index);
  }
  return out;
}

export async function pgDescribeRoutine(c: pg.Client, object: string, kind: 'procedure' | 'function'): Promise<RoutineDescription | null> {
  const { name: qualified, signature } = routineName(object);
  const [schema, name] = splitQualified(qualified);
  const found = (
    await c.query<{ oid: number; nsp: string; name: string; kind: string; lang: string; src: string; vol: string; sig: string; result: string | null; comment: string | null }>(
      `SELECT p.oid::int AS oid, n.nspname AS nsp, p.proname AS name, p.prokind::text AS kind, l.lanname AS lang, p.prosrc AS src, p.provolatile::text AS vol, pg_get_function_identity_arguments(p.oid) AS sig,
        CASE WHEN p.prokind = 'f' THEN pg_get_function_result(p.oid) END AS result, obj_description(p.oid, 'pg_proc') AS comment
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
       WHERE n.nspname = coalesce($1, current_schema()) AND p.proname = $2 AND p.prokind = $3 ORDER BY p.oid`,
      [schema, name, kind === 'procedure' ? 'p' : 'f']
    )
  ).rows;
  const norm = (s: string) => s.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim().toLowerCase();
  const r = signature != null ? found.find((x) => norm(x.sig) === norm(signature)) : found[0];
  if (!r) return null;
  const out = emptyRoutine(kind, `${r.nsp}.${r.name}`);
  const args = (
    await c.query<{ name: string; type: string; mode: string }>(
      "SELECT coalesce(p.proargnames[k.i], '') AS name, format_type(k.t, NULL) AS type, coalesce(p.proargmodes[k.i]::text, 'i') AS mode FROM pg_proc p, unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) WITH ORDINALITY k(t, i) WHERE p.oid = $1 ORDER BY k.i",
      [r.oid]
    )
  ).rows;
  // Table-function columns ('t') are part of the result, not parameters.
  out.params = args.filter((a) => a.mode !== 't').map((a) => ({ name: a.name, type: parseType('postgres', a.type), rawType: a.type, mode: a.mode === 'v' ? 'in' : paramMode(a.mode) }));
  out.returns = r.result ? { type: parseType('postgres', r.result), rawType: r.result } : null;
  out.language = r.lang;
  out.body = trimBody(r.src);
  out.signature = r.sig;
  out.volatility = r.vol === 'i' ? 'immutable' : r.vol === 's' ? 'stable' : 'volatile';
  out.deterministic = null;
  out.comment = r.comment;
  return out;
}

export async function pgRoutines(c: pg.Client): Promise<RoutineListing> {
  const r = await c.query<{ nsp: string; name: string; kind: string; sig: string }>(
    `SELECT n.nspname AS nsp, p.proname AS name, p.prokind::text AS kind, pg_get_function_identity_arguments(p.oid) AS sig
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prokind IN ('f', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp%'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
     ORDER BY 1, 2, 4 LIMIT 2000`
  );
  return r.rows.map((x) => ({ name: `${x.nsp}.${x.name}`, kind: x.kind === 'p' ? 'procedure' : 'function', signature: x.sig }));
}

// ---------------------------------------------------------------------------------------------------------------
// MySQL
// ---------------------------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;
const q = async (c: mysql.Connection, sql: string, args: unknown[] = []): Promise<Row[]> => ((await c.query(sql, args)) as unknown as [Row[]])[0];
const str = (v: unknown): string | null => (v == null ? null : Buffer.isBuffer(v) ? v.toString('utf8') : String(v));

/** MySQL's COLUMN_DEFAULT: unquoted for literals, an expression when EXTRA says DEFAULT_GENERATED (8.0.13+). */
export function mysqlDefault(raw: unknown, extra: string, columnType: string): ReturnType<typeof classifyDefault> {
  const v = str(raw);
  if (v == null) return null;
  if (/DEFAULT_GENERATED/i.test(extra) || /^(CURRENT_TIMESTAMP|NOW|LOCALTIME|LOCALTIMESTAMP)\b/i.test(v)) return { kind: 'expression', value: unwrapParens(v) };
  // MariaDB quotes string defaults and spells a missing one NULL.
  if (/^'.*'$/s.test(v)) return { kind: 'literal', value: v.slice(1, -1).replace(/''/g, "'") };
  if (/^b'[01]*'$/i.test(v)) return { kind: 'expression', value: v };
  if (/^tinyint\(1\)/i.test(columnType) && (v === '0' || v === '1')) return { kind: 'literal', value: v === '1' ? 'true' : 'false' };
  return { kind: 'literal', value: v };
}

export async function mysqlDescribeTable(c: mysql.Connection, object: string, home: string | null): Promise<TableDescription | null> {
  const [s, table] = splitQualified(object);
  const schema = s ?? home ?? str((await q(c, 'SELECT DATABASE() AS db'))[0]?.db);
  const t = (await q(c, "SELECT t.TABLE_TYPE AS type, t.ENGINE AS engine, t.TABLE_COLLATION AS coll, t.TABLE_COMMENT AS comment, (SELECT cs.CHARACTER_SET_NAME FROM information_schema.COLLATION_CHARACTER_SET_APPLICABILITY cs WHERE cs.COLLATION_NAME = t.TABLE_COLLATION LIMIT 1) AS charset FROM information_schema.TABLES t WHERE t.TABLE_SCHEMA = ? AND t.TABLE_NAME = ?", [schema, table]))[0];
  if (!t) return null;
  const view = str(t.type) === 'VIEW';
  const out = emptyTable(view ? 'view' : 'table', `${schema}.${table}`);
  out.comment = view ? null : str(t.comment) || null;
  const cols = await q(c, 'SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS def, EXTRA AS extra, COLUMN_COMMENT AS comment FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION', [schema, table]);
  for (const col of cols) {
    const extra = str(col.extra) ?? '';
    const type = str(col.type) ?? '';
    const identity = /auto_increment/i.test(extra);
    out.columns.push({ name: str(col.name)!, type: parseType('mysql', type), rawType: type, nullable: str(col.nullable) === 'YES', default: identity ? null : mysqlDefault(col.def, extra, type), identity, comment: str(col.comment) || null });
  }
  if (view) {
    out.definition = str((await q(c, 'SELECT VIEW_DEFINITION AS def FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [schema, table]))[0]?.def)?.trim() ?? null;
    return out;
  }
  if (t.engine) out.options.engine = str(t.engine);
  if (t.charset) out.options.charset = str(t.charset);
  if (t.coll) out.options.collation = str(t.coll);
  const keys = await q(
    c,
    `SELECT tc.CONSTRAINT_NAME AS name, tc.CONSTRAINT_TYPE AS type, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_SCHEMA AS rs, k.REFERENCED_TABLE_NAME AS rt, k.REFERENCED_COLUMN_NAME AS rc, rc.DELETE_RULE AS del, rc.UPDATE_RULE AS upd
     FROM information_schema.TABLE_CONSTRAINTS tc
     JOIN information_schema.KEY_COLUMN_USAGE k ON k.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND k.TABLE_NAME = tc.TABLE_NAME
     LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS rc ON rc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND rc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND rc.TABLE_NAME = tc.TABLE_NAME
     WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY')
     ORDER BY tc.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
    [schema, table]
  );
  const byName = new Map<string, { type: string; cols: string[]; ref: string | null; refCols: string[]; del: string | null; upd: string | null }>();
  for (const k of keys) {
    const name = str(k.name)!;
    let e = byName.get(name);
    if (!e) byName.set(name, (e = { type: str(k.type)!, cols: [], ref: k.rt ? `${str(k.rs)}.${str(k.rt)}` : null, refCols: [], del: str(k.del), upd: str(k.upd) }));
    e.cols.push(str(k.col)!);
    if (k.rc) e.refCols.push(str(k.rc)!);
  }
  for (const [name, e] of byName) {
    if (e.type === 'PRIMARY KEY') out.primaryKey = { name, columns: e.cols };
    else if (e.type === 'UNIQUE') out.uniques.push({ name, columns: e.cols });
    else out.foreignKeys.push({ name, columns: e.cols, refTable: e.ref ?? '', refColumns: e.refCols, onDelete: fkAction(e.del), onUpdate: fkAction(e.upd) });
  }
  // CHECK constraints: MySQL 8.0.16 and later.
  const checks = await q(c, "SELECT cc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS clause FROM information_schema.TABLE_CONSTRAINTS tc JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE = 'CHECK' ORDER BY cc.CONSTRAINT_NAME", [schema, table]).catch(() => [] as Row[]);
  for (const k of checks) out.checks.push({ name: str(k.name)!, expression: checkExpression(str(k.clause) ?? '') });
  const stats = await q(c, 'SELECT * FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX', [schema, table]);
  const backed = new Set([...(out.primaryKey ? ['PRIMARY'] : []), ...out.uniques.map((u) => u.name)]);
  const idx = new Map<string, DescribedIndex>();
  for (const s1 of stats) {
    const get = (k: string) => s1[k] ?? s1[k.toLowerCase()];
    const name = str(get('INDEX_NAME'))!;
    let i = idx.get(name);
    if (!i) idx.set(name, (i = { name, columns: [], unique: Number(get('NON_UNIQUE')) === 0, method: (str(get('INDEX_TYPE')) ?? 'BTREE').toLowerCase(), where: null, include: [], constraint: backed.has(name) }));
    const col = str(get('COLUMN_NAME')) ?? (get('EXPRESSION') != null ? `(${str(get('EXPRESSION'))})` : '');
    const coll = str(get('COLLATION'));
    i.columns.push({ name: col, ...(coll === 'D' ? { order: 'desc' as const } : coll === 'A' ? { order: 'asc' as const } : {}) });
  }
  out.indexes = [...idx.values()];
  return out;
}

export async function mysqlDescribeRoutine(c: mysql.Connection, object: string, kind: 'procedure' | 'function', home: string | null): Promise<RoutineDescription | null> {
  const [s, name] = splitQualified(object);
  const schema = s ?? home ?? str((await q(c, 'SELECT DATABASE() AS db'))[0]?.db);
  const type = kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION';
  const r = (await q(c, 'SELECT ROUTINE_DEFINITION AS def, DTD_IDENTIFIER AS ret, IS_DETERMINISTIC AS det, ROUTINE_COMMENT AS comment, ROUTINE_BODY AS lang FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ? AND ROUTINE_TYPE = ?', [schema, name, type]))[0];
  if (!r) return null;
  const out = emptyRoutine(kind, `${schema}.${name}`);
  const params = await q(c, 'SELECT PARAMETER_NAME AS name, PARAMETER_MODE AS mode, DTD_IDENTIFIER AS type FROM information_schema.PARAMETERS WHERE SPECIFIC_SCHEMA = ? AND SPECIFIC_NAME = ? AND ROUTINE_TYPE = ? AND ORDINAL_POSITION > 0 ORDER BY ORDINAL_POSITION', [schema, name, type]);
  out.params = params.map((p) => ({ name: str(p.name) ?? '', type: parseType('mysql', str(p.type) ?? ''), rawType: str(p.type) ?? '', mode: paramMode(str(p.mode)) }));
  const ret = str(r.ret);
  out.returns = kind === 'function' && ret ? { type: parseType('mysql', ret), rawType: ret } : null;
  out.language = (str(r.lang) ?? 'SQL').toLowerCase();
  let body = str(r.def);
  if (body == null) {
    // ROUTINE_DEFINITION is NULL for an account that is not the definer: SHOW CREATE shows it with SHOW_ROUTINE.
    const [rows] = (await c.query(`SHOW CREATE ${type} \`${String(schema).replace(/`/g, '``')}\`.\`${name.replace(/`/g, '``')}\``).catch(() => [[]])) as unknown as [Row[]];
    const create = str(rows[0]?.[`Create ${kind === 'procedure' ? 'Procedure' : 'Function'}`]);
    body = create ? mysqlBodyFromCreate(create) : '';
  }
  out.body = body.replace(/\r\n/g, '\n').trim();
  out.deterministic = str(r.det) === 'YES';
  out.comment = str(r.comment) || null;
  return out;
}

export async function mysqlRoutines(c: mysql.Connection, home: string | null): Promise<RoutineListing> {
  const where = home ? 'ROUTINE_SCHEMA = ?' : "ROUTINE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')";
  const rows = await q(c, `SELECT ROUTINE_SCHEMA AS s, ROUTINE_NAME AS n, ROUTINE_TYPE AS t FROM information_schema.ROUTINES WHERE ${where} ORDER BY 1, 2 LIMIT 2000`, home ? [home] : []);
  return rows.map((r) => ({ name: `${str(r.s)}.${str(r.n)}`, kind: str(r.t) === 'PROCEDURE' ? 'procedure' : 'function' }));
}
