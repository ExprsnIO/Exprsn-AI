import { createHash } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { isIP } from 'node:net';
import { Connection, ISOLATION_LEVEL, Request, TYPES, type ConnectionConfiguration } from 'tedious';
import { fetch } from 'undici';
import { addressProblem, checkHost, guardedAgent, parseAllowList, type AllowList } from '../mcp/hosts.js';
import type { Classification } from './classify.js';
import type { DdlPlan } from './ddl.js';
import type { DescribedIndex, DescribeKind, ObjectDescription, RoutineDescription, TableDescription } from './ddl-edit-types.js';
import { parseType } from './ddl-types.js';
import { checkExpression, classifyDefault, emptyRoutine, emptyTable, fkAction, splitQualified, tsqlRoutineBody, tsqlTypeText, unwrapParens, viewSelect } from './describe-sql.js';
import { hostPort, refuseOps, runStatements, type ConnectionSpec, type DataDriver, type QueryResult, type SchemaObject, type TestResult } from './drivers.js';

/*
 * 1.9.0: SQL Server and Azure SQL through tedious (pure JavaScript TDS).
 *
 * - The host is resolved and checked (internal, or on CONNECTIONS_ALLOWED_HOSTS) and the checked address is dialled,
 *   with the host name as `serverName` so TLS still verifies the certificate against it. Azure SQL always encrypts.
 * - Azure's redirect connection policy reroutes a login to a gateway worker (`rerouting`). The worker must be a
 *   subdomain of the same parent domain as the endpoint (e.g. *.database.windows.net) and pass the same host check;
 *   tedious dials it by name, so the check runs beside the dial and nothing is sent until it has passed.
 * - Microsoft Entra service principals: an access token from login.microsoftonline.com (client credentials, the
 *   guarded dispatcher, no redirects), cached in this process until shortly before it expires.
 * - SQL Server has no read-only transaction. Every read runs in a transaction that is always rolled back, with
 *   LOCK_TIMEOUT and the request timeout; rows stream and the request is cancelled after `limit + 1`. Writes are
 *   refused by the classifier, and `test` reports an account holding write permissions as degraded: use a login with
 *   db_datareader only.
 */

/** Rerouting stays within the endpoint's parent domain: `x.database.windows.net` may reroute to `*.database.windows.net`. */
export function reroutingAllowed(original: string, routed: string): boolean {
  const o = original.toLowerCase().replace(/\.$/, '');
  const r = routed.toLowerCase().replace(/\.$/, '');
  if (!o || !r || isIP(o) || isIP(r)) return false;
  const labels = o.split('.');
  if (labels.length < 3) return false;
  const parent = labels.slice(1).join('.');
  return r.endsWith(`.${parent}`) && /^[a-z0-9.-]+$/.test(r);
}

const tokens = new Map<string, { token: string; until: number }>();

/** An Entra access token for Azure SQL by client credentials, through the guarded dispatcher. */
export async function entraToken(o: { tenantId: string; clientId: string; secret: string; allow: AllowList; timeoutMs: number; authority?: string }): Promise<string> {
  const authority = (o.authority ?? 'https://login.microsoftonline.com').replace(/\/+$/, '');
  const key = `${authority}|${o.tenantId}|${o.clientId}|${createHash('sha256').update(o.secret).digest('hex')}`;
  const hit = tokens.get(key);
  if (hit && hit.until > Date.now()) return hit.token;
  const url = new URL(`${authority}/${encodeURIComponent(o.tenantId)}/oauth2/v2.0/token`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    const p = addressProblem(host, host, o.allow);
    if (p) throw new Error(p);
  }
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: o.clientId, client_secret: o.secret, scope: 'https://database.windows.net/.default' }).toString();
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, signal: AbortSignal.timeout(o.timeoutMs), dispatcher: guardedAgent(o.allow, o.timeoutMs), redirect: 'error' });
  const text = await res.text();
  let doc: { access_token?: string; expires_in?: number | string; error?: string; error_description?: string } = {};
  try {
    doc = text ? (JSON.parse(text) as typeof doc) : {};
  } catch {
    // not JSON
  }
  if (!res.ok || !doc.access_token) throw new Error(`The Entra token request failed (${res.status}${doc.error ? `, ${doc.error}` : ''})${doc.error_description ? `: ${doc.error_description.split('\n')[0]!.slice(0, 200)}` : '.'}`);
  const ttl = Math.max(0, (Number(doc.expires_in) || 300) - 60) * 1000;
  if (tokens.size > 500) tokens.clear();
  tokens.set(key, { token: doc.access_token, until: Date.now() + ttl });
  return doc.access_token;
}

/** A row value as the other drivers return it. */
function plain(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return v.toString('base64');
  if (typeof v === 'bigint') return v.toString();
  return v;
}

/** A bound value's TDS type. */
function paramOf(v: unknown): { type: (typeof TYPES)[keyof typeof TYPES]; value: unknown } {
  if (v == null) return { type: TYPES.NVarChar, value: null };
  if (typeof v === 'boolean') return { type: TYPES.Bit, value: v };
  if (typeof v === 'bigint') return { type: TYPES.BigInt, value: v.toString() };
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return Math.abs(v) <= 2147483647 ? { type: TYPES.Int, value: v } : Number.isSafeInteger(v) ? { type: TYPES.BigInt, value: v } : { type: TYPES.Float, value: v };
    return { type: TYPES.Float, value: v };
  }
  if (v instanceof Date) return { type: TYPES.DateTime2, value: v };
  if (Buffer.isBuffer(v)) return { type: TYPES.VarBinary, value: v };
  if (typeof v === 'object') return { type: TYPES.NVarChar, value: JSON.stringify(v) };
  return { type: TYPES.NVarChar, value: String(v) };
}

export const quoteTsqlIdent = (name: string): string =>
  name
    .split('.')
    .map((p) => '[' + p.replace(/]/g, ']]') + ']')
    .join('.');

interface Run {
  columns: string[];
  rows: unknown[][];
  /** The request was cancelled once enough rows had arrived. */
  stopped: boolean;
}

export class MssqlDriver implements DataDriver {
  constructor(
    private readonly spec: ConnectionSpec,
    private readonly allow: AllowList = parseAllowList('')
  ) {}

  private get azure(): boolean {
    return this.spec.engine === 'azure-sql';
  }

  private get options(): Record<string, unknown> {
    return this.spec.options ?? {};
  }

  /** `readWrite`: schema changes, which must reach the primary whatever ApplicationIntent the reads use. */
  private async connect(timeoutMs: number, readWrite = false): Promise<Connection> {
    const { host, port } = hostPort(this.spec.endpoint, 1433);
    const { addresses } = await checkHost(host, this.allow);
    const encrypt = this.azure || this.spec.tls;
    const entra = this.azure && this.options.auth === 'entra-service-principal';
    const authentication: ConnectionConfiguration['authentication'] = entra
      ? { type: 'azure-active-directory-access-token', options: { token: await entraToken({ tenantId: String(this.options.entraTenantId ?? ''), clientId: this.spec.username ?? '', secret: this.spec.password ?? '', allow: this.allow, timeoutMs: Math.min(timeoutMs, 10_000) }) } }
      : { type: 'default', options: { userName: this.spec.username ?? undefined, password: this.spec.password ?? undefined } };
    const conn = new Connection({
      server: addresses[0]!,
      authentication,
      options: {
        port,
        database: this.spec.database ?? undefined,
        encrypt,
        trustServerCertificate: false,
        ...(isIP(host) ? {} : { serverName: host }),
        connectTimeout: Math.min(timeoutMs, 10_000),
        requestTimeout: timeoutMs,
        cancelTimeout: 5000,
        readOnlyIntent: !readWrite && (this.options.applicationIntent ?? 'ReadOnly') === 'ReadOnly',
        appName: 'exprsn-ai',
        abortTransactionOnError: true,
        rowCollectionOnRequestCompletion: false,
        useColumnNames: false,
        useUTC: true
      }
    });
    // A reroute (Azure's redirect policy) goes to a worker tedious dials by name: same parent domain, checked here.
    let rerouteCheck: Promise<void> = Promise.resolve();
    // `rerouting` is emitted before tedious dials the routed server; it is not in tedious's public typings.
    (conn as unknown as EventEmitter).on('rerouting', () => {
      const routed = (conn as unknown as { routingData?: { server: string } }).routingData?.server ?? '';
      if (!reroutingAllowed(host, routed)) {
        rerouteCheck = Promise.reject(new Error(`The server redirected the connection to ${routed.slice(0, 200) || 'another host'}, outside ${host}'s domain; it is not followed.`));
        conn.close();
        return;
      }
      // TLS verifies the worker's own name.
      (conn as unknown as { config: { options: { serverName?: string } } }).config.options.serverName = routed;
      rerouteCheck = checkHost(routed, this.allow).then(
        () => undefined,
        (err: Error) => {
          conn.close();
          throw new Error(`The server redirected the connection to ${routed}: ${err.message}`);
        }
      );
      rerouteCheck.catch(() => undefined);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        conn.on('connect', (err) => (err ? reject(err) : resolve()));
        conn.on('end', () => reject(new Error('The connection closed during login.')));
        conn.connect();
      });
      await rerouteCheck;
    } catch (err) {
      const refused = await rerouteCheck.then(() => null, (e: Error) => e);
      conn.close();
      throw refused ?? err;
    }
    return conn;
  }

  private async session<T>(timeoutMs: number, fn: (c: Connection) => Promise<T>, readWrite = false): Promise<T> {
    const c = await this.connect(timeoutMs, readWrite);
    try {
      return await fn(c);
    } finally {
      c.close();
    }
  }

  /** One request: rows stream in; `stopAfter` rows and the request is cancelled. */
  private exec(c: Connection, sql: string, params: unknown[] = [], stopAfter = Infinity, batch = false): Promise<Run> {
    return new Promise<Run>((resolve, reject) => {
      const out: Run = { columns: [], rows: [], stopped: false };
      const req = new Request(sql, (err) => {
        if (err && !(out.stopped && (err as { code?: string }).code === 'ECANCEL')) reject(err);
        else resolve(out);
      });
      params.forEach((v, i) => {
        const p = paramOf(v);
        req.addParameter(`p${i + 1}`, p.type, p.value);
      });
      req.on('columnMetadata', (cols) => {
        out.columns = (Array.isArray(cols) ? cols : Object.values(cols)).map((col) => col.colName);
      });
      req.on('row', (row) => {
        if (out.stopped) return;
        out.rows.push((row as { value: unknown }[]).map((x) => plain(x.value)));
        if (out.rows.length >= stopAfter) {
          out.stopped = true;
          c.cancel();
        }
      });
      if (batch) c.execSqlBatch(req);
      else c.execSql(req);
    });
  }

  /** A read: a transaction that is always rolled back, with LOCK_TIMEOUT. */
  private async readOnly<T>(c: Connection, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    await this.exec(c, `SET LOCK_TIMEOUT ${Math.max(1, Math.floor(timeoutMs))}`, [], Infinity, true);
    await new Promise<void>((resolve, reject) => c.beginTransaction((err) => (err ? reject(err) : resolve()), 'exprsn_read', ISOLATION_LEVEL.READ_COMMITTED));
    try {
      return await fn();
    } finally {
      await new Promise<void>((resolve) => c.rollbackTransaction(() => resolve()));
    }
  }

  async test(timeoutMs: number): Promise<TestResult> {
    return this.session(timeoutMs, async (c) => {
      const r = await this.exec(
        c,
        "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)), CAST(SERVERPROPERTY('Edition') AS nvarchar(128)), SUSER_SNAME(), USER_NAME(), ISNULL(IS_SRVROLEMEMBER('sysadmin'), 0), ISNULL(IS_ROLEMEMBER('db_owner'), 0), ISNULL(IS_ROLEMEMBER('db_datawriter'), 0), ISNULL(IS_ROLEMEMBER('db_ddladmin'), 0), (SELECT COUNT(*) FROM fn_my_permissions(NULL, 'DATABASE') WHERE permission_name IN ('INSERT', 'UPDATE', 'DELETE', 'ALTER', 'CONTROL', 'EXECUTE', 'CREATE TABLE', 'ALTER ANY SCHEMA', 'TAKE OWNERSHIP'))"
      );
      const [version, edition, login, user, sa, owner, writer, ddl, grants] = r.rows[0] ?? [];
      const roles = [Number(sa) ? 'sysadmin' : null, Number(owner) ? 'db_owner' : null, Number(writer) ? 'db_datawriter' : null, Number(ddl) ? 'db_ddladmin' : null].filter((x): x is string => !!x);
      const writes = Number(grants ?? 0);
      const readOnly = !roles.length && writes === 0;
      const who = `${String(login ?? user ?? 'unknown')}${user && user !== login ? ` (user ${String(user)})` : ''}`;
      const product = /azure/i.test(String(edition ?? '')) || this.azure ? 'Azure SQL' : 'SQL Server';
      return {
        version: `${product} ${String(version ?? '').trim()}${edition && !/azure/i.test(String(edition)) ? ` (${String(edition)})` : ''}`.trim(),
        readOnly,
        health: 'healthy',
        detail: readOnly ? `Account ${who} is read-only; no write permissions.` : `Account ${who} ${roles.length ? `is in ${roles.join(', ')}` : `holds ${writes} write permission${writes === 1 ? '' : 's'}`}. Reads still run in a transaction that is rolled back; use a login with db_datareader only.`
      };
    });
  }

  async introspect(timeoutMs: number): Promise<SchemaObject[]> {
    return this.session(timeoutMs, async (c) => {
      const t = await this.exec(c, 'SELECT TOP 2000 TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_SCHEMA, TABLE_NAME');
      const cols = await this.exec(c, 'SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION');
      const byName = new Map<string, SchemaObject>();
      for (const [s, n, k] of t.rows as string[][]) byName.set(`${s}.${n}`, { name: `${s}.${n}`, kind: k === 'VIEW' ? 'view' : 'table', columns: [] });
      for (const [s, n, col, ty] of cols.rows as string[][]) byName.get(`${s}.${n}`)?.columns.push({ name: col!, type: ty! });
      return [...byName.values()];
    });
  }

  async query(_c: Classification, text: string, opts: { limit: number; timeoutMs: number; params?: unknown[]; offset?: number }): Promise<QueryResult> {
    const sql = text.trim().replace(/;\s*$/, '');
    const offset = opts.offset && opts.offset > 0 ? Math.floor(opts.offset) : 0;
    return this.session(opts.timeoutMs, (c) =>
      this.readOnly(c, opts.timeoutMs, async () => {
        const r = await this.exec(c, sql, opts.params ?? [], offset + opts.limit + 1);
        const rows = r.rows.slice(offset);
        return { columns: r.columns, rows: rows.slice(0, opts.limit), capped: rows.length > opts.limit, estimate: null };
      })
    );
  }

  async rows(object: string, opts: { watermarkColumn: string | null; after: string | null; limit: number; timeoutMs: number; fields?: string[] | null }): Promise<QueryResult> {
    return this.session(opts.timeoutMs, (c) =>
      this.readOnly(c, opts.timeoutMs, async () => {
        const wm = opts.watermarkColumn ? quoteTsqlIdent(opts.watermarkColumn) : null;
        const cols = opts.fields?.length ? opts.fields.map(quoteTsqlIdent).join(', ') : '*';
        const filter = wm && opts.after != null;
        const sql = `SELECT TOP (${Math.floor(opts.limit) + 1}) ${cols} FROM ${quoteTsqlIdent(object)}${filter ? ` WHERE ${wm} > @p1` : ''}${wm ? ` ORDER BY ${wm}` : ''}`;
        const r = await this.exec(c, sql, filter ? [opts.after] : []);
        return { columns: r.columns, rows: r.rows.slice(0, opts.limit), capped: r.rows.length > opts.limit, estimate: null };
      })
    );
  }

  /**
   * 2.0.x: a schema change on the admin account, with ApplicationIntent ReadWrite. Each statement is its own batch
   * (CREATE PROCEDURE, FUNCTION and SCHEMA must each be alone in one), under the request timeout and LOCK_TIMEOUT;
   * a transactional plan runs in one transaction, rolled back on any failure (XACT_ABORT is on).
   */
  async applyDdl(plan: DdlPlan, timeoutMs: number): Promise<{ applied: number }> {
    refuseOps(plan, this.azure ? 'Azure SQL' : 'SQL Server');
    return this.session(
      timeoutMs,
      async (c) => {
        await this.exec(c, `SET LOCK_TIMEOUT ${Math.max(1, Math.floor(timeoutMs))}`, [], Infinity, true);
        const run = (sql: string) => this.exec(c, sql, [], Infinity, true);
        if (!plan.transactional) return { applied: await runStatements(plan.statements, run) };
        await new Promise<void>((resolve, reject) => c.beginTransaction((err) => (err ? reject(err) : resolve()), 'exprsn_ddl', ISOLATION_LEVEL.READ_COMMITTED));
        try {
          const applied = await runStatements(plan.statements, run, { transaction: true });
          await new Promise<void>((resolve, reject) => c.commitTransaction((err) => (err ? reject(err) : resolve())));
          return { applied };
        } catch (err) {
          // XACT_ABORT may have rolled back already; a second rollback's error is not the one to report.
          await new Promise<void>((resolve) => c.rollbackTransaction(() => resolve()));
          throw err;
        }
      },
      true
    );
  }

  /** 2.0.x editing: a table, view or routine read back from the sys catalog views, in the read transaction. */
  async describe(object: string, kind: DescribeKind, timeoutMs: number): Promise<ObjectDescription | null> {
    if (kind !== 'table' && kind !== 'view' && kind !== 'procedure' && kind !== 'function') throw new Error(`SQL Server has no ${kind} to describe.`);
    return this.session(timeoutMs, (c) => this.readOnly<ObjectDescription | null>(c, timeoutMs, () => (kind === 'table' || kind === 'view' ? this.describeTable(c, object) : this.describeRoutine(c, object, kind))));
  }

  private async describeTable(c: Connection, object: string): Promise<TableDescription | null> {
    const [schema, table] = splitQualified(object);
    const o = (await this.exec(c, "SELECT o.object_id, s.name, o.name, o.type, CAST(ep.value AS nvarchar(4000)) FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id LEFT JOIN sys.extended_properties ep ON ep.class = 1 AND ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description' WHERE s.name = ISNULL(@p1, SCHEMA_NAME()) AND o.name = @p2 AND o.type IN ('U', 'V')", [schema, table])).rows[0];
    if (!o) return null;
    const [id, sname, oname, otype, comment] = o as [number, string, string, string, string | null];
    const view = String(otype).trim() === 'V';
    const out = emptyTable(view ? 'view' : 'table', `${sname}.${oname}`);
    out.comment = comment ?? null;
    const cols = await this.exec(
      c,
      "SELECT c.name, TYPE_NAME(c.system_type_id), c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity, dc.name, dc.definition, CAST(ep.value AS nvarchar(4000)), c.is_computed, cc.definition FROM sys.columns c LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id LEFT JOIN sys.extended_properties ep ON ep.class = 1 AND ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description' WHERE c.object_id = @p1 ORDER BY c.column_id",
      [id]
    );
    for (const r of cols.rows) {
      const [name, typeName, maxLength, precision, scale, nullable, identity, dcName, dcDef, colComment, computed, computedDef] = r as [string, string, number, number, number, boolean, boolean, string | null, string | null, string | null, boolean, string | null];
      const raw = tsqlTypeText(String(typeName), Number(maxLength), Number(precision), Number(scale));
      out.columns.push({ name, type: parseType('tsql', raw), rawType: raw, nullable: !!nullable, default: identity ? null : computed && computedDef ? { kind: 'expression', value: unwrapParens(computedDef) } : classifyDefault(dcDef), identity: !!identity, comment: colComment ?? null, defaultConstraint: dcName ?? null });
    }
    if (view) {
      const def = (await this.exec(c, 'SELECT OBJECT_DEFINITION(@p1)', [id])).rows[0]?.[0];
      out.definition = def == null ? null : viewSelect(String(def));
      return out;
    }
    const keys = await this.exec(c, 'SELECT k.name, k.type, col.name FROM sys.key_constraints k JOIN sys.index_columns ic ON ic.object_id = k.parent_object_id AND ic.index_id = k.unique_index_id JOIN sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id WHERE k.parent_object_id = @p1 AND ic.is_included_column = 0 ORDER BY k.name, ic.key_ordinal', [id]);
    const keyMap = new Map<string, { type: string; cols: string[] }>();
    for (const [name, type, col] of keys.rows as [string, string, string][]) {
      let e = keyMap.get(name);
      if (!e) keyMap.set(name, (e = { type: String(type).trim(), cols: [] }));
      e.cols.push(col);
    }
    for (const [name, e] of keyMap) {
      if (e.type === 'PK') out.primaryKey = { name, columns: e.cols };
      else out.uniques.push({ name, columns: e.cols });
    }
    const fks = await this.exec(
      c,
      'SELECT fk.name, pc.name, OBJECT_SCHEMA_NAME(fk.referenced_object_id), OBJECT_NAME(fk.referenced_object_id), rc.name, fk.delete_referential_action_desc, fk.update_referential_action_desc FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id WHERE fk.parent_object_id = @p1 ORDER BY fk.name, fkc.constraint_column_id',
      [id]
    );
    const fkMap = new Map<string, TableDescription['foreignKeys'][number]>();
    for (const [name, col, rs, rt, rcol, del, upd] of fks.rows as string[][]) {
      let e = fkMap.get(name!);
      if (!e) fkMap.set(name!, (e = { name: name!, columns: [], refTable: `${rs}.${rt}`, refColumns: [], onDelete: fkAction(del), onUpdate: fkAction(upd) }));
      e.columns.push(col!);
      e.refColumns.push(rcol!);
    }
    out.foreignKeys = [...fkMap.values()];
    const checks = await this.exec(c, 'SELECT name, definition FROM sys.check_constraints WHERE parent_object_id = @p1 ORDER BY name', [id]);
    out.checks = (checks.rows as [string, string][]).map(([name, def]) => ({ name, expression: checkExpression(def) }));
    const idx = await this.exec(
      c,
      'SELECT i.name, i.type, i.is_unique, i.is_primary_key, i.is_unique_constraint, i.filter_definition, col.name, ic.is_descending_key, ic.is_included_column FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id JOIN sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id WHERE i.object_id = @p1 AND i.type IN (1, 2) AND i.is_hypothetical = 0 ORDER BY i.name, ic.is_included_column, ic.key_ordinal, ic.index_column_id',
      [id]
    );
    const idxMap = new Map<string, DescribedIndex>();
    for (const [name, type, unique, pk, uq, filter, col, desc, included] of idx.rows as [string, number, boolean, boolean, boolean, string | null, string, boolean, boolean][]) {
      let e = idxMap.get(name);
      if (!e) idxMap.set(name, (e = { name, columns: [], unique: !!unique, method: Number(type) === 1 ? 'clustered' : 'nonclustered', where: filter ? unwrapParens(filter) : null, include: [], constraint: !!pk || !!uq }));
      if (included) e.include.push(col);
      else e.columns.push({ name: col, order: desc ? 'desc' : 'asc' });
    }
    out.indexes = [...idxMap.values()];
    return out;
  }

  private async describeRoutine(c: Connection, object: string, kind: 'procedure' | 'function'): Promise<RoutineDescription | null> {
    const [schema, name] = splitQualified(object);
    const types = kind === 'procedure' ? "('P')" : "('FN', 'IF', 'TF')";
    const o = (await this.exec(c, `SELECT o.object_id, s.name, o.name, o.type, m.definition, CAST(ep.value AS nvarchar(4000)) FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id LEFT JOIN sys.sql_modules m ON m.object_id = o.object_id LEFT JOIN sys.extended_properties ep ON ep.class = 1 AND ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description' WHERE s.name = ISNULL(@p1, SCHEMA_NAME()) AND o.name = @p2 AND o.type IN ${types}`, [schema, name])).rows[0];
    if (!o) return null;
    const [id, sname, oname, otype, definition, comment] = o as [number, string, string, string, string | null, string | null];
    const out = emptyRoutine(kind, `${sname}.${oname}`);
    const params = await this.exec(c, 'SELECT p.parameter_id, p.name, TYPE_NAME(p.system_type_id), p.max_length, p.precision, p.scale, p.is_output FROM sys.parameters p WHERE p.object_id = @p1 ORDER BY p.parameter_id', [id]);
    for (const [pid, pname, typeName, maxLength, precision, scale, output] of params.rows as [number, string, string, number, number, number, boolean][]) {
      const raw = tsqlTypeText(String(typeName), Number(maxLength), Number(precision), Number(scale));
      if (Number(pid) === 0) out.returns = { type: parseType('tsql', raw), rawType: raw };
      else out.params.push({ name: String(pname).replace(/^@/, ''), type: parseType('tsql', raw), rawType: raw, mode: output ? 'out' : 'in' });
    }
    if (kind === 'function' && !out.returns) out.returns = { type: null, rawType: 'TABLE' };
    void otype;
    out.language = 'sql';
    out.body = definition == null ? '' : tsqlRoutineBody(String(definition), kind);
    out.comment = comment ?? null;
    return out;
  }

  /** 2.0.x editing: the procedures and functions of the database (not shipped with SQL Server). */
  async routines(timeoutMs: number): Promise<{ name: string; kind: 'procedure' | 'function'; signature?: string | null }[]> {
    return this.session(timeoutMs, (c) =>
      this.readOnly(c, timeoutMs, async () => {
        const r = await this.exec(c, "SELECT TOP 2000 s.name, o.name, o.type FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE o.type IN ('P', 'FN', 'IF', 'TF') AND o.is_ms_shipped = 0 ORDER BY s.name, o.name");
        return (r.rows as string[][]).map(([s1, n, t]) => ({ name: `${s1}.${n}`, kind: String(t).trim() === 'P' ? ('procedure' as const) : ('function' as const) }));
      })
    );
  }
}
