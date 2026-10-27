import { isIP } from 'node:net';
import { addressProblem, parseAllowList, type AllowList } from '../mcp/hosts.js';
import { guardedRequest, type GuardedRequest, type GuardedResponse } from '../platform/egress.js';
import type { Classification } from './classify.js';
import type { DdlPlan } from './ddl.js';
import type { DescribedIndex, DescribeKind, ObjectDescription, TableDescription } from './ddl-edit-types.js';
import { parseType } from './ddl-types.js';
import { classifyDefault, emptyTable, fkAction, indexPredicate, splitQualified, sqliteCreateParts, viewSelect } from './describe-sql.js';
import { refuseOps, runStatements, type ConnectionSpec, type DataDriver, type QueryResult, type SchemaObject, type TestResult } from './drivers.js';

/*
 * 1.9.99-final, Sprint 61 (B-10907): Cloudflare D1 as a read-only data connection, over the D1 query API
 * (`POST /client/v4/accounts/<account>/d1/database/<database>/raw`, one statement and its bound values, answered
 * with columns and rows).
 *
 * - The connection's endpoint is the API origin (https://api.cloudflare.com), its account the Cloudflare account id,
 *   its database the D1 database id, its secret a scoped API token (sealed, or a vault reference). Every request goes
 *   through `guardedRequest` with the connection address rules (`addressProblem`: CONNECTIONS_ALLOWED_HOSTS must
 *   name api.cloudflare.com), resolved once, pinned, no redirects, capped; and in tests the offline guard refuses
 *   the real API before any lookup.
 * - D1 has no read-only role and the API runs no read-only transaction: the classifier (`classify-sqlite.ts`) is
 *   what keeps it read-only, and this driver also refuses to send anything not classified as a read. A refused
 *   statement never reaches Cloudflare.
 * - Reads are wrapped as `SELECT * FROM (<statement>) LIMIT <n + 1> OFFSET <m>`, so the row cap holds whatever the
 *   statement says; bound values travel apart (`params`).
 * - D1 is never Exprsn-AI's own database: it is a data connection engine only (`DB_CLIENT` is pg, mysql or sqlite).
 */

/** Bytes of one answer read at most. */
const MAX_ANSWER = 32 * 1024 * 1024;
const ID = /^[A-Za-z0-9-]{1,64}$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_$]{0,127}$/;

type Send = (r: GuardedRequest) => Promise<GuardedResponse>;

interface RawAnswer {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: { results?: { columns?: string[]; rows?: unknown[][] }; success?: boolean; meta?: Record<string, unknown> }[];
}

export class D1Error extends Error {}

/** A SQLite identifier, quoted (each part of a dotted name). */
export const sqliteIdent = (name: string): string =>
  name
    .split('.')
    .map((p) => `"${p.replace(/"/g, '""')}"`)
    .join('.');

export class D1Driver implements DataDriver {
  private readonly base: URL;

  constructor(
    private readonly spec: ConnectionSpec,
    /** Internal hosts only, unless CONNECTIONS_ALLOWED_HOSTS names the host or its network. */
    private readonly allow: AllowList = parseAllowList(''),
    private readonly send: Send = guardedRequest
  ) {
    const e = (spec.endpoint || 'https://api.cloudflare.com').trim().replace(/\/+$/, '');
    this.base = new URL(/^[a-z]+:\/\//i.test(e) ? e : `https://${e}`);
  }

  private path(): string {
    const account = this.spec.username ?? '';
    const database = this.spec.database ?? '';
    if (!ID.test(account)) throw new D1Error('A D1 connection names its Cloudflare account id as the account.');
    if (!ID.test(database)) throw new D1Error('A D1 connection names the D1 database id as its database.');
    return `/client/v4/accounts/${encodeURIComponent(account)}/d1/database/${encodeURIComponent(database)}/raw`;
  }

  private url(): URL {
    const u = new URL(this.base);
    if (u.username || u.password || u.search) throw new D1Error('The D1 endpoint is the API origin, without credentials or a query string.');
    // Plain http only to an address literal (a local stand-in); the API itself is always https.
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isIP(u.hostname.replace(/^\[|\]$/g, '')))) throw new D1Error('The D1 API is reached over https:// only.');
    const prefix = u.pathname.replace(/\/+$/, '').replace(/\/client\/v4$/, '');
    return new URL(`${prefix}${this.path()}`, `${u.origin}/`);
  }

  /** One request to the raw endpoint: a single statement, or a batch (`{ batch: [...] }`). */
  private async post(body: Record<string, unknown>, timeoutMs: number): Promise<RawAnswer> {
    const token = this.spec.password ?? '';
    if (!token) throw new D1Error('The connection has no API token.');
    const res = await this.send({
      method: 'POST',
      url: this.url(),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'exprsn-ai' },
      body: JSON.stringify(body),
      timeoutMs: Math.max(1000, timeoutMs),
      maxBytes: MAX_ANSWER,
      check: (address, host) => addressProblem(address, host, this.allow)
    });
    let doc: RawAnswer = {};
    try {
      doc = JSON.parse(res.body.toString('utf8') || '{}') as RawAnswer;
    } catch {
      /* not JSON */
    }
    if (res.status !== 200 || doc.success === false) {
      const e = doc.errors?.[0];
      throw new D1Error(`D1 answered ${res.status}${e?.code != null ? ` (${e.code})` : ''}: ${(e?.message ?? res.body.toString('utf8').slice(0, 200)) || 'no detail'}`.slice(0, 500));
    }
    return doc;
  }

  /** Runs one statement (the driver's own, or a classified read) and reads its columns and rows. */
  private async raw(sql: string, params: unknown[], timeoutMs: number): Promise<{ columns: string[]; rows: unknown[][]; meta: Record<string, unknown> }> {
    const doc = await this.post({ sql, params: params.map((v) => (v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? v.toString() : v !== null && typeof v === 'object' ? JSON.stringify(v) : v)) }, timeoutMs);
    const first = doc.result?.[0];
    return { columns: first?.results?.columns ?? [], rows: first?.results?.rows ?? [], meta: first?.meta ?? {} };
  }

  /**
   * 2.0.x: a schema change on the admin connection (its token needs D1 Write). D1 refuses BEGIN and COMMIT in SQL;
   * the API's batch form is its transaction: the statements run in order as one unit and a failure rolls all of
   * them back. So a transactional plan of several statements goes as one batch, each statement its own element
   * (never joined into one text, which D1 would also run); anything else goes one statement per request, in order,
   * stopping at the first failure.
   */
  async applyDdl(plan: DdlPlan, timeoutMs: number): Promise<{ applied: number }> {
    refuseOps(plan, 'Cloudflare D1');
    const n = plan.statements.length;
    if (plan.transactional && n > 1) {
      try {
        const doc = await this.post({ batch: plan.statements.map((sql) => ({ sql, params: [] })) }, timeoutMs);
        const failed = (doc.result ?? []).findIndex((r) => r.success === false);
        if (failed >= 0) throw new D1Error(`statement ${failed + 1} did not succeed`);
      } catch (err) {
        throw new Error(`The batch of ${n} statements failed; D1 rolled it back and nothing was applied: ${(err as Error).message}`, { cause: err });
      }
      return { applied: n };
    }
    return { applied: await runStatements(plan.statements, (sql) => this.raw(sql, [], timeoutMs)) };
  }

  async test(timeoutMs: number): Promise<TestResult> {
    const r = await this.raw('SELECT sqlite_version() AS version', [], timeoutMs);
    const v = String(r.rows[0]?.[0] ?? '');
    return { version: `Cloudflare D1 (SQLite ${v || 'unknown'})`, readOnly: true, detail: 'D1 query API. D1 has no read-only role, so every write, PRAGMA and schema change is refused here before it is sent.', health: 'healthy' };
  }

  async introspect(timeoutMs: number): Promise<SchemaObject[]> {
    const t = await this.raw("SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name LIMIT 500", [], timeoutMs);
    const out: SchemaObject[] = [];
    for (const [name, type] of t.rows as [string, string][]) {
      const cols = await this.raw('SELECT name, type FROM pragma_table_info(?)', [name], timeoutMs);
      out.push({ name, kind: type === 'view' ? 'view' : 'table', columns: (cols.rows as [string, string][]).map(([n, ty]) => ({ name: n, type: ty || 'any' })) });
    }
    return out;
  }

  async query(c: Classification, text: string, opts: { limit: number; timeoutMs: number; params?: unknown[]; offset?: number }): Promise<QueryResult> {
    // The service refuses these first; the driver refuses them too, so nothing but a read is ever sent to D1.
    if (c.kind !== 'read' && c.kind !== 'unparsed') throw new D1Error(`A ${c.verb ?? c.kind} is never sent to a D1 connection.`);
    const statement = text.trim().replace(/;+\s*$/, '');
    const limit = Math.max(1, Math.floor(opts.limit));
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    const r = await this.raw(`SELECT * FROM (${statement}) LIMIT ${limit + 1} OFFSET ${offset}`, opts.params ?? [], opts.timeoutMs);
    const capped = r.rows.length > limit;
    return { columns: r.columns, rows: capped ? r.rows.slice(0, limit) : r.rows, capped, estimate: null };
  }

  async rows(object: string, opts: { watermarkColumn: string | null; after: string | null; limit: number; timeoutMs: number; role?: string | null; fields?: string[] | null }): Promise<QueryResult> {
    if (opts.role) throw new D1Error('D1 has no database roles.');
    const parts = object.split('.');
    if (!parts.every((p) => IDENT.test(p))) throw new D1Error(`${object} is not a plain table name.`);
    if (opts.watermarkColumn && !IDENT.test(opts.watermarkColumn)) throw new D1Error(`${opts.watermarkColumn} is not a plain column name.`);
    for (const f of opts.fields ?? []) if (!IDENT.test(f)) throw new D1Error(`${f} is not a plain column name.`);
    const cols = opts.fields?.length ? opts.fields.map((f) => sqliteIdent(f)).join(', ') : '*';
    const wm = opts.watermarkColumn ? sqliteIdent(opts.watermarkColumn) : null;
    const where = wm && opts.after != null ? ` WHERE ${wm} > ?` : '';
    const limit = Math.max(1, Math.floor(opts.limit));
    const r = await this.raw(`SELECT ${cols} FROM ${sqliteIdent(object)}${where}${wm ? ` ORDER BY ${wm}` : ''} LIMIT ${limit + 1}`, where ? [opts.after] : [], opts.timeoutMs);
    const capped = r.rows.length > limit;
    return { columns: r.columns, rows: capped ? r.rows.slice(0, limit) : r.rows, capped, estimate: null };
  }

  /**
   * 2.0.x editing: a table or view from SQLite's own catalog (pragma_table_info, pragma_index_list and
   * pragma_index_xinfo, pragma_foreign_key_list, and the CREATE text in sqlite_schema for constraint names, CHECKs,
   * STRICT and WITHOUT ROWID). Only reads are sent. D1 has no procedures or functions.
   */
  async describe(object: string, kind: DescribeKind, timeoutMs: number): Promise<ObjectDescription | null> {
    if (kind !== 'table' && kind !== 'view') throw new D1Error(kind === 'procedure' || kind === 'function' ? 'D1 (SQLite) has no stored procedures or functions.' : `D1 has no ${kind} to describe.`);
    const [schema, name] = splitQualified(object);
    if (schema && schema.toLowerCase() !== 'main') return null;
    const found = (await this.raw("SELECT type, name, sql FROM sqlite_schema WHERE type IN ('table', 'view') AND name = ? COLLATE NOCASE", [name], timeoutMs)).rows[0] as [string, string, string | null] | undefined;
    if (!found) return null;
    const [type, table, createSql] = found;
    const out: TableDescription = emptyTable(type === 'view' ? 'view' : 'table', table);
    const parts = sqliteCreateParts(createSql ?? '');
    const cols = (await this.raw('SELECT cid, name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)', [table], timeoutMs)).rows as [number, string, string, number, string | null, number][];
    const pkCols = cols.filter((c) => Number(c[5]) > 0).sort((a, b) => Number(a[5]) - Number(b[5]));
    // The rowid alias: a lone INTEGER PRIMARY KEY column (AUTOINCREMENT, as the designer makes it, or not).
    const rowid = pkCols.length === 1 && String(pkCols[0]![2]).toUpperCase() === 'INTEGER' && !parts.withoutRowid ? pkCols[0]![1] : null;
    for (const [, colName, colType, notnull, dflt] of cols) {
      const identity = colName === rowid && parts.autoincrement;
      out.columns.push({ name: colName, type: parseType('sqlite', colType ?? ''), rawType: colType ?? '', nullable: !Number(notnull) && colName !== rowid, default: identity ? null : classifyDefault(dflt), identity, comment: null });
    }
    if (type === 'view') {
      out.definition = createSql ? viewSelect(createSql) : null;
      return out;
    }
    if (pkCols.length) out.primaryKey = { name: parts.named.find((n) => n.kind === 'pk')?.name ?? null, columns: pkCols.map((c) => c[1]) };
    const sameCols = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x.toLowerCase() === b[i]!.toLowerCase());
    const list = (await this.raw('SELECT seq, name, "unique", origin, partial FROM pragma_index_list(?)', [table], timeoutMs)).rows as [number, string, number, string, number][];
    const indexSql = new Map((await this.raw("SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = ?", [table], timeoutMs)).rows as [string, string | null][]);
    for (const [, indexName, unique, origin, partial] of list) {
      const xinfo = (await this.raw('SELECT seqno, cid, name, "desc", "key" FROM pragma_index_xinfo(?) ORDER BY seqno', [indexName], timeoutMs)).rows as [number, number, string | null, number, number][];
      const columns = xinfo.filter((x) => Number(x[4]) === 1).map((x) => ({ name: x[2] ?? (Number(x[1]) === -2 ? '(expression)' : 'rowid'), order: Number(x[3]) ? ('desc' as const) : ('asc' as const) }));
      const index: DescribedIndex = { name: indexName, columns, unique: !!Number(unique), method: 'btree', where: Number(partial) ? indexPredicate(indexSql.get(indexName)) : null, include: [], constraint: origin === 'pk' || origin === 'u' };
      out.indexes.push(index);
      if (origin === 'u') {
        const cs = columns.map((c) => c.name);
        out.uniques.push({ name: parts.named.find((n) => n.kind === 'unique' && sameCols(n.columns, cs))?.name ?? indexName, columns: cs });
      }
    }
    const fks = (await this.raw('SELECT id, seq, "table", "from", "to", on_update, on_delete FROM pragma_foreign_key_list(?) ORDER BY id, seq', [table], timeoutMs)).rows as [number, number, string, string, string | null, string, string][];
    const byId = new Map<number, TableDescription['foreignKeys'][number]>();
    for (const [id, , ref, from, to, onUpdate, onDelete] of fks) {
      let e = byId.get(Number(id));
      if (!e) byId.set(Number(id), (e = { name: '', columns: [], refTable: ref, refColumns: [], onDelete: fkAction(onDelete), onUpdate: fkAction(onUpdate) }));
      e.columns.push(from);
      if (to) e.refColumns.push(to);
    }
    for (const e of byId.values()) {
      // REFERENCES t without columns names t's primary key.
      if (!e.refColumns.length) e.refColumns = ((await this.raw('SELECT name, pk FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk', [e.refTable], timeoutMs)).rows as [string, number][]).map((r) => r[0]);
      e.name = parts.named.find((n) => n.kind === 'fk' && sameCols(n.columns, e.columns))?.name ?? '';
      out.foreignKeys.push(e);
    }
    out.checks = parts.checks;
    if (parts.strict) out.options.strict = true;
    if (parts.withoutRowid) out.options.withoutRowid = true;
    return out;
  }

  /** 2.0.x editing: D1 has no procedures or functions. */
  async routines(): Promise<{ name: string; kind: 'procedure' | 'function'; signature?: string | null }[]> {
    return [];
  }
}
