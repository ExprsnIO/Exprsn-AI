import { createRequire } from 'node:module';
import { checkHost, parseAllowList, type AllowList } from '../mcp/hosts.js';
import type { Classification } from './classify.js';
import type { DdlPlan } from './ddl.js';
import type { DescribedIndex, DescribeKind, ObjectDescription, RoutineDescription, TableDescription } from './ddl-edit-types.js';
import { parseType } from './ddl-types.js';
import { checkExpression, classifyDefault, emptyRoutine, emptyTable, fkAction, oracleRoutineBody, oracleTypeText, paramMode, splitQualified, unquoteIdent } from './describe-sql.js';
import { hostPort, refuseOps, runStatements, type ConnectionSpec, type DataDriver, type QueryResult, type SchemaObject, type TestResult } from './drivers.js';

/*
 * 1.9.0: Oracle Database through node-oracledb in thin mode (pure JavaScript; the Instant Client is never loaded).
 *
 * - The host is resolved and checked once (internal hosts, or the operator's CONNECTIONS_ALLOWED_HOSTS) and the
 *   checked address is dialled, as for PostgreSQL and MySQL. With TLS the host name therefore cannot be matched
 *   against the certificate, so a TLS connection needs the server certificate's full distinguished name
 *   (`options.sslServerCertDN`), which is matched instead; without it the connection is refused before dialling.
 * - Every read runs in `SET TRANSACTION READ ONLY` (rolled back after), with the call timeout, so the database refuses
 *   DML even if the classifier missed it, and is wrapped as `SELECT * FROM (<query>) OFFSET … FETCH NEXT …`.
 * - NUMBER values that do not fit a double exactly come back as strings; LOBs as text (BLOB as base64), capped.
 */

/** The parts of node-oracledb this driver uses (the package ships no types). */
interface OraConnection {
  execute(sql: string, binds?: unknown[] | Record<string, unknown>, opts?: Record<string, unknown>): Promise<{ rows?: unknown[][]; metaData?: { name: string }[]; warning?: { message?: string; code?: string } }>;
  close(): Promise<void>;
  callTimeout: number;
  oracleServerVersionString?: string;
}
interface OraMeta {
  dbType: unknown;
}
interface OracleDb {
  getConnection(o: Record<string, unknown>): Promise<OraConnection>;
  OUT_FORMAT_ARRAY: number;
  DB_TYPE_NUMBER: unknown;
  DB_TYPE_CLOB: unknown;
  DB_TYPE_NCLOB: unknown;
  DB_TYPE_BLOB: unknown;
  STRING: unknown;
  BUFFER: unknown;
}

let lib: OracleDb | null = null;
const oracledb = (): OracleDb => (lib ??= createRequire(import.meta.url)('oracledb') as OracleDb);

/** A LOB longer than this is cut. */
const LOB_MAX = 1024 * 1024;

const SERVICE = /^[A-Za-z0-9_.$#-]{1,128}$/;

/** Schemas Oracle maintains, for databases without ALL_USERS.ORACLE_MAINTAINED (before 12c). */
const SYSTEM_SCHEMAS = ['SYS', 'SYSTEM', 'XDB', 'MDSYS', 'CTXSYS', 'ORDSYS', 'ORDDATA', 'ORDPLUGINS', 'SI_INFORMTN_SCHEMA', 'OUTLN', 'DBSNMP', 'APPQOSSYS', 'WMSYS', 'LBACSYS', 'GSMADMIN_INTERNAL', 'GSMCATUSER', 'GSMUSER', 'OJVMSYS', 'DVSYS', 'DVF', 'AUDSYS', 'OLAPSYS', 'EXFSYS', 'ANONYMOUS', 'DIP', 'REMOTE_SCHEDULER_AGENT', 'SYSBACKUP', 'SYSDG', 'SYSKM', 'SYSRAC', 'XS$NULL', 'MDDATA', 'SPATIAL_CSW_ADMIN_USR', 'FLOWS_FILES', 'APEX_PUBLIC_USER', 'DGPDB_INT', 'GGSYS', 'PDBADMIN'];

export const quoteOracleIdent = (name: string): string =>
  name
    .split('.')
    .map((p) => {
      if (p.includes('"')) throw new Error('An Oracle name cannot contain a double quote.');
      return `"${p}"`;
    })
    .join('.');

/**
 * The connect descriptor for the checked address: the address, the port and the service name, TCPS with TLS.
 * Pure, so it is tested without a server.
 */
export function oracleDescriptor(o: { address: string; port: number; service: string; tls: boolean }): string {
  if (!SERVICE.test(o.service)) throw new Error('The service name may hold letters, digits, _ . $ # and - only.');
  if (!/^[0-9A-Fa-f.:]+$/.test(o.address)) throw new Error('The checked address is not an IP address.');
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw new Error('The port is not valid.');
  return `(DESCRIPTION=(ADDRESS=(PROTOCOL=${o.tls ? 'TCPS' : 'TCP'})(HOST=${o.address})(PORT=${o.port}))(CONNECT_DATA=(SERVICE_NAME=${o.service})))`;
}

/** The getConnection options for one dial of the checked address, refused before dialling when TLS has no DN. */
export function oracleConnectOptions(spec: ConnectionSpec, address: string, port: number, timeoutMs: number): Record<string, unknown> {
  if (!spec.database) throw new Error('An Oracle connection names its service name.');
  const dn = typeof spec.options?.sslServerCertDN === 'string' && spec.options.sslServerCertDN.trim() ? spec.options.sslServerCertDN.trim() : null;
  if (spec.tls && !dn) throw new Error('TLS to Oracle needs the server certificate\'s distinguished name (Server certificate DN): the checked address is dialled, so the host name cannot be matched against the certificate.');
  const secs = Math.max(1, Math.ceil(Math.min(timeoutMs, 10_000) / 1000));
  return {
    user: spec.username ?? undefined,
    password: spec.password ?? undefined,
    connectString: oracleDescriptor({ address, port, service: spec.database, tls: spec.tls }),
    connectTimeout: secs,
    transportConnectTimeout: secs,
    ...(spec.tls ? { sslServerDNMatch: true, sslServerCertDN: dn } : {})
  };
}

/** A fetched value as JSON can carry it. */
function plain(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return v.toString('base64');
  return v;
}

/** NUMBER as a JavaScript number when it survives the round trip, otherwise as its exact text. */
export function oracleNumber(v: string | null): number | string | null {
  if (v == null) return null;
  const digits = v.replace(/^-/, '').replace('.', '').replace(/^0+/, '');
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  if (/^-?\d+$/.test(v)) return Number.isSafeInteger(n) ? n : v;
  return digits.length <= 15 ? n : v;
}

export class OracleDriver implements DataDriver {
  constructor(
    private readonly spec: ConnectionSpec,
    /** Internal hosts only, unless CONNECTIONS_ALLOWED_HOSTS names the host or its network. */
    private readonly allow: AllowList = parseAllowList('')
  ) {}

  private async client<T>(timeoutMs: number, fn: (c: OraConnection) => Promise<T>): Promise<T> {
    const { host, port } = hostPort(this.spec.endpoint, 1521);
    // Fail before resolving or dialling when the settings cannot work.
    oracleConnectOptions(this.spec, '127.0.0.1', port, timeoutMs);
    const { addresses } = await checkHost(host, this.allow);
    const db = oracledb();
    const c = await db.getConnection(oracleConnectOptions(this.spec, addresses[0]!, port, timeoutMs));
    try {
      c.callTimeout = Math.max(1, Math.floor(timeoutMs));
      return await fn(c);
    } finally {
      await c.close().catch(() => undefined);
    }
  }

  /** Inside a read-only transaction, rolled back after. */
  private async readOnly<T>(c: OraConnection, fn: () => Promise<T>): Promise<T> {
    await c.execute('SET TRANSACTION READ ONLY');
    try {
      return await fn();
    } finally {
      await c.execute('ROLLBACK').catch(() => undefined);
    }
  }

  private fetchOpts(maxRows?: number): Record<string, unknown> {
    const db = oracledb();
    return {
      outFormat: db.OUT_FORMAT_ARRAY,
      ...(maxRows ? { maxRows } : {}),
      fetchTypeHandler: (m: OraMeta) => {
        if (m.dbType === db.DB_TYPE_NUMBER) return { type: db.STRING, converter: oracleNumber };
        if (m.dbType === db.DB_TYPE_CLOB || m.dbType === db.DB_TYPE_NCLOB) return { type: db.STRING, converter: (v: string | null) => (v == null ? v : v.slice(0, LOB_MAX)) };
        if (m.dbType === db.DB_TYPE_BLOB) return { type: db.BUFFER, converter: (v: Buffer | null) => (v == null ? v : v.subarray(0, LOB_MAX)) };
        return undefined;
      }
    };
  }

  private result(r: { rows?: unknown[][]; metaData?: { name: string }[] }, limit: number): QueryResult {
    const rows = (r.rows ?? []).map((row) => row.map(plain));
    return { columns: (r.metaData ?? []).map((m) => m.name), rows: rows.slice(0, limit), capped: rows.length > limit, estimate: null };
  }

  async test(timeoutMs: number): Promise<TestResult> {
    return this.client(timeoutMs, async (c) => {
      const one = async (sql: string): Promise<unknown> => ((await c.execute(sql, [], { outFormat: oracledb().OUT_FORMAT_ARRAY }).catch(() => ({ rows: [] }))).rows?.[0]?.[0] ?? null);
      const user = String((await one('SELECT USER FROM dual')) ?? this.spec.username ?? '');
      const banner = (await one("SELECT banner_full FROM v$version WHERE ROWNUM = 1")) ?? (await one('SELECT banner FROM v$version WHERE ROWNUM = 1'));
      const version = banner ? String(banner).split('\n')[0]!.slice(0, 80) : `Oracle ${c.oracleServerVersionString ?? 'unknown'}`;
      const privs = ((await c.execute('SELECT privilege FROM session_privs', [], { outFormat: oracledb().OUT_FORMAT_ARRAY }).catch(() => ({ rows: [] }))).rows ?? []).map((r) => String(r[0]));
      // CREATE SESSION is needed to sign in; SELECT/READ ANY read. Anything else with ANY, or to create, alter or drop, can change data.
      const systemWrites = privs.filter((x) => x !== 'CREATE SESSION' && x !== 'SET CONTAINER' && !/^(SELECT|READ) ANY /.test(x) && (/ ANY /.test(` ${x} `) || /^(CREATE|ALTER|DROP|GRANT|EXECUTE|INSERT|UPDATE|DELETE|BECOME|ADMINISTER)\b/.test(x)));
      const objectWrites = Number((await one("SELECT count(*) FROM user_tab_privs WHERE grantee = USER AND privilege IN ('INSERT', 'UPDATE', 'DELETE', 'ALTER', 'INDEX', 'EXECUTE')")) ?? 0) + Number((await one("SELECT count(*) FROM role_tab_privs WHERE privilege IN ('INSERT', 'UPDATE', 'DELETE', 'ALTER', 'INDEX', 'EXECUTE')")) ?? 0);
      const owned = Number((await one('SELECT count(*) FROM user_tables')) ?? 0);
      const readOnly = !systemWrites.length && !objectWrites && !owned;
      const why = [systemWrites.length ? `${systemWrites.length} system privilege${systemWrites.length === 1 ? '' : 's'} beyond reading (${systemWrites.slice(0, 3).join(', ')})` : '', objectWrites ? `${objectWrites} object grant${objectWrites === 1 ? '' : 's'} to write or execute` : '', owned ? `${owned} table${owned === 1 ? '' : 's'} of its own` : ''].filter(Boolean);
      return { version, readOnly, health: 'healthy', detail: readOnly ? `Account ${user} is read-only; no write privileges and no tables of its own.` : `Account ${user} holds ${why.join(', ')}. Reads still run in a read-only transaction; use an account with SELECT grants only.` };
    });
  }

  async introspect(timeoutMs: number): Promise<SchemaObject[]> {
    return this.client(timeoutMs, (c) =>
      this.readOnly(c, async () => {
        const arr = { outFormat: oracledb().OUT_FORMAT_ARRAY };
        let exclude = "owner NOT IN (SELECT username FROM all_users WHERE oracle_maintained = 'Y')";
        const probe = await c.execute(`SELECT count(*) FROM all_users WHERE oracle_maintained = 'Y'`, [], arr).catch(() => null);
        if (!probe) exclude = `owner NOT IN (${SYSTEM_SCHEMAS.map((x) => `'${x}'`).join(', ')})`;
        const t = await c.execute(
          `SELECT owner, table_name, 'TABLE' FROM all_tables WHERE ${exclude} AND table_name NOT LIKE 'BIN$%' UNION ALL SELECT owner, view_name, 'VIEW' FROM all_views WHERE ${exclude} ORDER BY 1, 2 FETCH FIRST 2000 ROWS ONLY`,
          [],
          arr
        );
        const byName = new Map<string, SchemaObject>();
        for (const r of t.rows ?? []) byName.set(`${r[0]}.${r[1]}`, { name: `${r[0]}.${r[1]}`, kind: r[2] === 'VIEW' ? 'view' : 'table', columns: [] });
        const cols = await c.execute(`SELECT owner, table_name, column_name, data_type FROM all_tab_columns WHERE ${exclude} ORDER BY owner, table_name, column_id FETCH FIRST 200000 ROWS ONLY`, [], arr);
        for (const r of cols.rows ?? []) byName.get(`${r[0]}.${r[1]}`)?.columns.push({ name: String(r[2]), type: String(r[3]).toLowerCase() });
        return [...byName.values()];
      })
    );
  }

  async query(_c: Classification, text: string, opts: { limit: number; timeoutMs: number; params?: unknown[]; offset?: number }): Promise<QueryResult> {
    const inner = text.trim().replace(/;\s*$/, '').replace(/\n\s*\/\s*$/, '');
    const binds = [...(opts.params ?? [])];
    const offset = opts.offset && opts.offset > 0 ? Math.floor(opts.offset) : 0;
    binds.push(offset, opts.limit + 1);
    const sql = `SELECT * FROM (${inner}\n) exprsn_q OFFSET :${binds.length - 1} ROWS FETCH NEXT :${binds.length} ROWS ONLY`;
    return this.client(opts.timeoutMs, (c) => this.readOnly(c, async () => this.result(await c.execute(sql, binds, this.fetchOpts()), opts.limit)));
  }

  async rows(object: string, opts: { watermarkColumn: string | null; after: string | null; limit: number; timeoutMs: number; fields?: string[] | null }): Promise<QueryResult> {
    const wm = opts.watermarkColumn ? quoteOracleIdent(opts.watermarkColumn) : null;
    const cols = opts.fields?.length ? opts.fields.map(quoteOracleIdent).join(', ') : '*';
    // A watermark the platform wrote is an ISO time; bound as a date, so Oracle compares it as one.
    const after = opts.after != null && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(opts.after) && !Number.isNaN(Date.parse(opts.after)) ? new Date(opts.after) : opts.after;
    const sql = `SELECT ${cols} FROM ${quoteOracleIdent(object)}${wm && after != null ? ` WHERE ${wm} > :1` : ''}${wm ? ` ORDER BY ${wm}` : ''} FETCH FIRST ${Math.floor(opts.limit) + 1} ROWS ONLY`;
    return this.client(opts.timeoutMs, (c) => this.readOnly(c, async () => this.result(await c.execute(sql, wm && after != null ? [after] : [], this.fetchOpts()), opts.limit)));
  }

  /**
   * 2.0.x: a schema change on the admin account. Oracle commits each DDL statement on its own, so the statements run
   * in order (a normal session, not the read-only transaction) under the call timeout and stop at the first failure.
   * Each text goes to execute alone and verbatim: plain DDL has no trailing `;`, a PL/SQL routine ends with its own
   * `END;`. A routine that compiles with errors is still created (ORA-24344 comes back as a warning), INVALID, so
   * that is reported as a failure of its statement.
   */
  async applyDdl(plan: DdlPlan, timeoutMs: number): Promise<{ applied: number }> {
    refuseOps(plan, 'Oracle');
    return this.client(timeoutMs, async (c) => ({
      applied: await runStatements(plan.statements, async (sql) => {
        const r = await c.execute(sql);
        if (r.warning) throw new Error(`Created with compilation errors, so it is INVALID (see USER_ERRORS): ${r.warning.message ?? r.warning.code ?? 'warning'}`);
      })
    }));
  }

  /** 2.0.x editing: a table, view or routine read back from the ALL_ data dictionary views, in a read-only transaction. */
  async describe(object: string, kind: DescribeKind, timeoutMs: number): Promise<ObjectDescription | null> {
    if (kind !== 'table' && kind !== 'view' && kind !== 'procedure' && kind !== 'function') throw new Error(`Oracle has no ${kind} to describe.`);
    return this.client(timeoutMs, (c) => this.readOnly<ObjectDescription | null>(c, () => (kind === 'table' || kind === 'view' ? this.describeTable(c, object) : this.describeRoutine(c, object, kind))));
  }

  private async rowsOf(c: OraConnection, sql: string, binds: unknown[]): Promise<unknown[][]> {
    const db = oracledb();
    // LONG columns (DATA_DEFAULT, SEARCH_CONDITION, TEXT) come back as strings; LOBs as text.
    return (await c.execute(sql, binds, { outFormat: db.OUT_FORMAT_ARRAY, fetchTypeHandler: (m: OraMeta) => (m.dbType === db.DB_TYPE_CLOB || m.dbType === db.DB_TYPE_NCLOB ? { type: db.STRING } : undefined) })).rows ?? [];
  }

  private async owner(c: OraConnection, given: string | null): Promise<string> {
    if (given) return given;
    return String((await this.rowsOf(c, "SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') FROM dual", []))[0]?.[0] ?? '');
  }

  private async describeTable(c: OraConnection, object: string): Promise<TableDescription | null> {
    const [given, table] = splitQualified(object);
    const owner = await this.owner(c, given);
    const found = (await this.rowsOf(c, "SELECT 'TABLE' FROM all_tables WHERE owner = :1 AND table_name = :2 UNION ALL SELECT 'VIEW' FROM all_views WHERE owner = :3 AND view_name = :4", [owner, table, owner, table]))[0];
    if (!found) return null;
    const view = found[0] === 'VIEW';
    const out = emptyTable(view ? 'view' : 'table', `${owner}.${table}`);
    out.comment = ((await this.rowsOf(c, 'SELECT comments FROM all_tab_comments WHERE owner = :1 AND table_name = :2', [owner, table]))[0]?.[0] as string | null) ?? null;
    const cols = await this.rowsOf(
      c,
      'SELECT c.column_name, c.data_type, c.data_length, c.char_length, c.char_used, c.data_precision, c.data_scale, c.nullable, c.data_default, c.identity_column, cc.comments FROM all_tab_columns c LEFT JOIN all_col_comments cc ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name WHERE c.owner = :1 AND c.table_name = :2 ORDER BY c.column_id',
      [owner, table]
    );
    const num = (v: unknown) => (v == null ? null : Number(v));
    for (const r of cols) {
      const [name, dataType, dataLength, charLength, charUsed, precision, scale, nullable, def, identity, comment] = r as [string, string, unknown, unknown, string | null, unknown, unknown, string, string | null, string | null, string | null];
      const raw = oracleTypeText({ dataType, dataLength: num(dataLength), charLength: num(charLength) || null, charUsed, precision: num(precision), scale: num(scale) });
      const isIdentity = identity === 'YES';
      out.columns.push({ name, type: parseType('oracle', raw), rawType: raw, nullable: nullable === 'Y', default: isIdentity ? null : classifyDefault(def?.trim()), identity: isIdentity, comment: comment ?? null });
    }
    if (view) {
      out.definition = ((await this.rowsOf(c, 'SELECT text FROM all_views WHERE owner = :1 AND view_name = :2', [owner, table]))[0]?.[0] as string | null)?.trim() ?? null;
      return out;
    }
    const cons = await this.rowsOf(
      c,
      `SELECT k.constraint_name, k.constraint_type, cc.column_name, k.delete_rule, k.search_condition, k.generated, k.index_name, r.owner, r.table_name, rc.column_name
       FROM all_constraints k
       LEFT JOIN all_cons_columns cc ON cc.owner = k.owner AND cc.constraint_name = k.constraint_name
       LEFT JOIN all_constraints r ON r.owner = k.r_owner AND r.constraint_name = k.r_constraint_name
       LEFT JOIN all_cons_columns rc ON rc.owner = r.owner AND rc.constraint_name = r.constraint_name AND rc.position = cc.position
       WHERE k.owner = :1 AND k.table_name = :2 AND k.constraint_type IN ('P', 'U', 'R', 'C')
       ORDER BY k.constraint_name, cc.position`,
      [owner, table]
    );
    const byName = new Map<string, { type: string; cols: string[]; refCols: string[]; del: string | null; cond: string | null; generated: string | null; ref: string | null }>();
    const backing = new Set<string>();
    for (const [name, type, col, del, cond, generated, indexName, rOwner, rTable, rCol] of cons as [string, string, string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null][]) {
      let e = byName.get(name!);
      if (!e) byName.set(name!, (e = { type: type!, cols: [], refCols: [], del, cond, generated, ref: rTable ? `${rOwner}.${rTable}` : null }));
      if (col && !e.cols.includes(col)) e.cols.push(col);
      if (rCol) e.refCols.push(rCol);
      if (indexName && (type === 'P' || type === 'U')) backing.add(indexName);
    }
    for (const [name, e] of byName) {
      if (e.type === 'P') out.primaryKey = { name, columns: e.cols };
      else if (e.type === 'U') out.uniques.push({ name, columns: e.cols });
      else if (e.type === 'R') out.foreignKeys.push({ name, columns: e.cols, refTable: e.ref ?? '', refColumns: e.refCols, onDelete: fkAction(e.del), onUpdate: null });
      else {
        const cond = (e.cond ?? '').trim();
        // NOT NULL is kept as a system-named CHECK; it is the column's nullability, not a constraint to edit.
        if (e.generated === 'GENERATED NAME' && /^"?[^"\s]+"? IS NOT NULL$/i.test(cond)) continue;
        out.checks.push({ name, expression: checkExpression(cond) });
      }
    }
    const idx = await this.rowsOf(
      c,
      `SELECT i.index_name, i.index_type, i.uniqueness, ic.column_name, ic.descend, ie.column_expression
       FROM all_indexes i JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name
       LEFT JOIN all_ind_expressions ie ON ie.index_owner = ic.index_owner AND ie.index_name = ic.index_name AND ie.column_position = ic.column_position
       WHERE i.table_owner = :1 AND i.table_name = :2 AND i.index_type IN ('NORMAL', 'BITMAP', 'FUNCTION-BASED NORMAL', 'FUNCTION-BASED BITMAP', 'NORMAL/REV')
       ORDER BY i.index_name, ic.column_position`,
      [owner, table]
    );
    const idxMap = new Map<string, DescribedIndex>();
    for (const [name, type, uniqueness, col, descend, expr] of idx as [string, string | null, string | null, string | null, string | null, string | null][]) {
      let e = idxMap.get(name!);
      if (!e) idxMap.set(name!, (e = { name: name!, columns: [], unique: uniqueness === 'UNIQUE', method: /BITMAP/.test(type ?? '') ? 'bitmap' : 'btree', where: null, include: [], constraint: backing.has(name!) }));
      // A DESC column is kept as a hidden function-based column; its expression is the column's quoted name.
      const colName = expr ? unquoteIdent(expr.trim()) : col!;
      e.columns.push({ name: colName, order: descend === 'DESC' ? 'desc' : 'asc' });
    }
    out.indexes = [...idxMap.values()];
    return out;
  }

  private async describeRoutine(c: OraConnection, object: string, kind: 'procedure' | 'function'): Promise<RoutineDescription | null> {
    const [given, name] = splitQualified(object);
    const owner = await this.owner(c, given);
    const type = kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION';
    const p = (await this.rowsOf(c, 'SELECT object_id, deterministic FROM all_procedures WHERE owner = :1 AND object_name = :2 AND object_type = :3 AND procedure_name IS NULL', [owner, name, type]))[0];
    if (!p) return null;
    const out = emptyRoutine(kind, `${owner}.${name}`);
    const args = await this.rowsOf(c, 'SELECT argument_name, position, data_type, in_out FROM all_arguments WHERE object_id = :1 AND data_level = 0 AND package_name IS NULL ORDER BY position', [p[0]]);
    for (const [argName, position, dataType, inOut] of args as [string | null, number, string | null, string | null][]) {
      if (!dataType) continue; // a routine without parameters has one empty row
      if (Number(position) === 0) out.returns = { type: parseType('oracle', dataType), rawType: dataType };
      else out.params.push({ name: argName ?? '', type: parseType('oracle', dataType), rawType: dataType, mode: paramMode(inOut) });
    }
    const src = await this.rowsOf(c, 'SELECT text FROM all_source WHERE owner = :1 AND name = :2 AND type = :3 ORDER BY line', [owner, name, type]);
    out.body = oracleRoutineBody(src.map((r) => String(r[0] ?? '')).join(''));
    // PL/SQL is the one language the designer offers for Oracle, as `sql` (ddl.ts routineLanguages).
    out.language = 'sql';
    out.deterministic = p[1] === 'YES';
    return out;
  }

  /** 2.0.x editing: standalone procedures and functions outside the schemas Oracle maintains. */
  async routines(timeoutMs: number): Promise<{ name: string; kind: 'procedure' | 'function'; signature?: string | null }[]> {
    return this.client(timeoutMs, (c) =>
      this.readOnly(c, async () => {
        let exclude = "owner NOT IN (SELECT username FROM all_users WHERE oracle_maintained = 'Y')";
        const probe = await this.rowsOf(c, "SELECT count(*) FROM all_users WHERE oracle_maintained = 'Y'", []).catch(() => null);
        if (!probe) exclude = `owner NOT IN (${SYSTEM_SCHEMAS.map((x) => `'${x}'`).join(', ')})`;
        const r = await this.rowsOf(c, `SELECT owner, object_name, object_type FROM all_objects WHERE object_type IN ('PROCEDURE', 'FUNCTION') AND ${exclude} ORDER BY 1, 2 FETCH FIRST 2000 ROWS ONLY`, []);
        return (r as string[][]).map(([o, n, t]) => ({ name: `${o}.${n}`, kind: t === 'PROCEDURE' ? ('procedure' as const) : ('function' as const) }));
      })
    );
  }
}
