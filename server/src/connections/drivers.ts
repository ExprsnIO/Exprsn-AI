import { isIP } from 'node:net';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { fetch, type Dispatcher } from 'undici';
import { addressProblem, checkHost, guardedAgent, parseAllowList, type AllowList } from '../mcp/hosts.js';
import type { Classification } from './classify.js';
import { MongoDriver } from './mongo.js';
import { dropSlot, PgReplicationStream, type ReplicationOptions, type ReplicationStream } from './replication.js';

/** What the service hands a driver: the endpoint and the opened credential. */
export interface ConnectionSpec {
  engine: 'postgres' | 'opensearch' | 'mysql' | 'mongodb';
  endpoint: string;
  database: string | null;
  tls: boolean;
  username: string | null;
  password: string | null;
}

export interface SchemaColumn {
  name: string;
  type: string;
}

export interface SchemaObject {
  name: string;
  kind: 'table' | 'view' | 'index';
  columns: SchemaColumn[];
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  /** More rows exist than the limit. */
  capped: boolean;
  /** The planner's or the engine's estimate of the full result, when capped. */
  estimate: number | null;
}

export interface TestResult {
  version: string;
  /** False when the account holds write grants (the read-only transaction still applies). */
  readOnly: boolean;
  detail: string;
  health: 'healthy' | 'degraded';
}

/**
 * One engine. Every call opens and closes its own connection; reads run in a read-only transaction with the
 * statement timeout, so the database refuses a write even if the parser missed one.
 */
export interface DataDriver {
  test(timeoutMs: number): Promise<TestResult>;
  introspect(timeoutMs: number): Promise<SchemaObject[]>;
  /** Runs a classified read. `limit` rows at most; one more is fetched to know whether the result is capped. */
  query(c: Classification, text: string, opts: { limit: number; timeoutMs: number }): Promise<QueryResult>;
  /**
   * Rows of one allow-listed object after a watermark, ordered by it (knowledge sources). With `role` (PostgreSQL,
   * B-1503) the read runs as that database role (`SET LOCAL ROLE` inside the read-only transaction), so the
   * database's grants and row security policies for the role decide which rows come back.
   */
  rows(object: string, opts: { watermarkColumn: string | null; after: string | null; limit: number; timeoutMs: number; role?: string | null; fields?: string[] | null }): Promise<QueryResult>;
  /** Checks that the connection's account can read an object as each role, and that row security applies (B-1503). */
  roleCheck?(object: string, roles: string[], timeoutMs: number): Promise<RoleCheck>;
  /** A logical replication stream of one table (PostgreSQL only, B-1003). */
  replicate?(opts: ReplicationOptions): Promise<ReplicationStream>;
  /** Drops a replication slot this platform created; false when there was none (or it is in use). */
  dropReplicationSlot?(slot: string, timeoutMs: number): Promise<boolean>;
  /**
   * One row written to an allow-listed table for an app entity backed by it (1.6.0, B-8501): an insert of `values`,
   * an update of `values` where the key column equals `key`, or a delete by key. Parameterised, in its own
   * transaction with the statement timeout; returns how many rows the statement touched.
   */
  mutate?(object: string, op: RowMutation, timeoutMs: number): Promise<{ affected: number }>;
}

export interface RowMutation {
  kind: 'insert' | 'update' | 'delete';
  keyColumn: string;
  key: unknown;
  values: Record<string, unknown>;
}

const COLUMN_NAME = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

/** Column names a mutation may touch: plain identifiers only, so quoting is enough. */
export function checkMutation(op: RowMutation): void {
  if (!COLUMN_NAME.test(op.keyColumn)) throw new Error(`The key column ${op.keyColumn} is not a plain column name.`);
  for (const k of Object.keys(op.values)) if (!COLUMN_NAME.test(k)) throw new Error(`The column ${k} is not a plain column name.`);
  if (op.kind !== 'delete' && !Object.keys(op.values).length && op.kind === 'update') throw new Error('Nothing to update.');
}

export type DriverFactory = (spec: ConnectionSpec) => DataDriver;

/** What PostgreSQL says about reading an object as mapped roles (B-1503). */
export interface RoleCheck {
  account: string;
  object: { kind: 'table' | 'view' | 'other' | 'missing'; rowSecurity: boolean; forced: boolean; owner: string | null; securityInvoker: boolean };
  roles: { role: string; exists: boolean; member: boolean; bypass: boolean; canSelect: boolean }[];
}

/** A database role name as accepted for row security mappings (B-1503). */
export const ROLE_NAME = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;

const hostPort = (endpoint: string, defaultPort: number): { host: string; port: number } => {
  const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(endpoint.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, ''));
  return { host: m?.[1] ?? endpoint, port: m?.[2] ? Number(m[2]) : defaultPort };
};

export const quoteIdent = (name: string): string =>
  name
    .split('.')
    .map((p) => '"' + p.replace(/"/g, '""') + '"')
    .join('.');

/** PostgreSQL through node-postgres. */
export class PostgresDriver implements DataDriver {
  constructor(
    private readonly spec: ConnectionSpec,
    /** Internal hosts only, unless CONNECTIONS_ALLOWED_HOSTS names the host or its network. */
    private readonly allow: AllowList = parseAllowList('')
  ) {}

  private async client<T>(timeoutMs: number, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const { host, port } = hostPort(this.spec.endpoint, 5432);
    // Resolve and check once, then dial the checked address (TLS still verifies the name), so DNS cannot rebind.
    const { addresses } = await checkHost(host, this.allow);
    const c = new pg.Client({
      host: addresses[0],
      port,
      database: this.spec.database ?? undefined,
      user: this.spec.username ?? undefined,
      password: this.spec.password ?? undefined,
      ssl: this.spec.tls ? { rejectUnauthorized: true, ...(isIP(host) ? {} : { servername: host }) } : undefined,
      connectionTimeoutMillis: Math.min(timeoutMs, 10_000),
      statement_timeout: timeoutMs,
      query_timeout: timeoutMs + 2000,
      application_name: 'exprsn-ai'
    });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end().catch(() => undefined);
    }
  }

  private async readOnly<T>(c: pg.Client, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    await c.query('BEGIN TRANSACTION READ ONLY');
    try {
      await c.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
      return await fn();
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
    }
  }

  async test(timeoutMs: number): Promise<TestResult> {
    return this.client(timeoutMs, async (c) => {
      const v = await c.query<{ version: string; user: string; superuser: boolean }>('SELECT version() AS version, current_user AS user, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser');
      const g = await c.query<{ n: string }>("SELECT count(*) AS n FROM information_schema.role_table_grants WHERE grantee = current_user AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')");
      const row = v.rows[0]!;
      const grants = Number(g.rows[0]?.n ?? 0);
      const readOnly = !row.superuser && grants === 0;
      const version = /PostgreSQL [\d.]+/.exec(row.version)?.[0] ?? row.version.slice(0, 40);
      return { version, readOnly, health: 'healthy', detail: readOnly ? `Account ${row.user} is read-only; no write grants.` : `Account ${row.user} ${row.superuser ? 'is a superuser' : `holds ${grants} write grant${grants === 1 ? '' : 's'}`}. Reads still run in a read-only transaction; use a read-only account.` };
    });
  }

  async introspect(timeoutMs: number): Promise<SchemaObject[]> {
    return this.client(timeoutMs, async (c) => {
      const t = await c.query<{ s: string; n: string; k: string }>("SELECT table_schema AS s, table_name AS n, table_type AS k FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg_toast%' ORDER BY 1, 2 LIMIT 2000");
      const cols = await c.query<{ s: string; n: string; c: string; t: string }>("SELECT table_schema AS s, table_name AS n, column_name AS c, data_type AS t FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name, ordinal_position");
      const byName = new Map<string, SchemaObject>();
      for (const r of t.rows) byName.set(`${r.s}.${r.n}`, { name: `${r.s}.${r.n}`, kind: r.k === 'VIEW' ? 'view' : 'table', columns: [] });
      for (const r of cols.rows) byName.get(`${r.s}.${r.n}`)?.columns.push({ name: r.c, type: r.t });
      return [...byName.values()];
    });
  }

  async query(_c: Classification, text: string, opts: { limit: number; timeoutMs: number }): Promise<QueryResult> {
    const inner = text.trim().replace(/;\s*$/, '');
    return this.client(opts.timeoutMs, (c) =>
      this.readOnly(c, opts.timeoutMs, async () => {
        const r = await c.query({ text: `SELECT * FROM (${inner}\n) AS exprsn_q LIMIT ${opts.limit + 1}`, rowMode: 'array' });
        const capped = r.rows.length > opts.limit;
        let estimate: number | null = null;
        if (capped) {
          const e = await c.query<{ 'QUERY PLAN': { Plan: { 'Plan Rows': number } }[] }>(`EXPLAIN (FORMAT JSON) ${inner}`).catch(() => null);
          estimate = e?.rows[0]?.['QUERY PLAN']?.[0]?.Plan['Plan Rows'] ?? null;
        }
        return { columns: r.fields.map((f) => f.name), rows: (r.rows as unknown[][]).slice(0, opts.limit), capped, estimate };
      })
    );
  }

  /** The endpoint to dial for replication: the checked address, as for queries. */
  private async endpoint() {
    const { host, port } = hostPort(this.spec.endpoint, 5432);
    const { addresses } = await checkHost(host, this.allow);
    return { host, address: addresses[0]!, port, database: this.spec.database, user: this.spec.username, password: this.spec.password, tls: this.spec.tls };
  }

  async replicate(opts: ReplicationOptions): Promise<ReplicationStream> {
    return new PgReplicationStream(await this.endpoint(), opts);
  }

  async dropReplicationSlot(slot: string, timeoutMs: number): Promise<boolean> {
    return dropSlot(await this.endpoint(), slot, timeoutMs);
  }

  async roleCheck(object: string, roles: string[], timeoutMs: number): Promise<RoleCheck> {
    return this.client(timeoutMs, (c) => this.readOnly(c, timeoutMs, () => pgRoleCheck(c, object, roles)));
  }

  async mutate(object: string, op: RowMutation, timeoutMs: number): Promise<{ affected: number }> {
    checkMutation(op);
    return this.client(timeoutMs, async (c) => {
      await c.query('BEGIN');
      try {
        await c.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
        const cols = Object.keys(op.values);
        let r: pg.QueryResult;
        if (op.kind === 'insert') {
          const all = cols.includes(op.keyColumn) ? cols : [op.keyColumn, ...cols];
          const vals = all.map((k) => (k === op.keyColumn && !cols.includes(k) ? op.key : op.values[k]));
          r = await c.query(`INSERT INTO ${quoteIdent(object)} (${all.map(quoteIdent).join(', ')}) VALUES (${all.map((_, i) => `$${i + 1}`).join(', ')})`, vals);
        } else if (op.kind === 'update') {
          r = await c.query(`UPDATE ${quoteIdent(object)} SET ${cols.map((k, i) => `${quoteIdent(k)} = $${i + 1}`).join(', ')} WHERE ${quoteIdent(op.keyColumn)} = $${cols.length + 1}`, [...cols.map((k) => op.values[k]), op.key]);
        } else r = await c.query(`DELETE FROM ${quoteIdent(object)} WHERE ${quoteIdent(op.keyColumn)} = $1`, [op.key]);
        await c.query('COMMIT');
        return { affected: r.rowCount ?? 0 };
      } catch (err) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
    });
  }

  async rows(object: string, opts: { watermarkColumn: string | null; after: string | null; limit: number; timeoutMs: number; role?: string | null }): Promise<QueryResult> {
    return this.client(opts.timeoutMs, (c) =>
      this.readOnly(c, opts.timeoutMs, async () => {
        if (opts.role) {
          if (!ROLE_NAME.test(opts.role)) throw new Error('The role name is not valid.');
          // Ends with the transaction (ROLLBACK), so the connection never keeps the role.
          await c.query(`SET LOCAL ROLE ${quoteIdent(opts.role)}`);
        }
        const wm = opts.watermarkColumn ? quoteIdent(opts.watermarkColumn) : null;
        const text = `SELECT * FROM ${quoteIdent(object)}${wm && opts.after != null ? ` WHERE ${wm} > $1` : ''}${wm ? ` ORDER BY ${wm}` : ''} LIMIT ${opts.limit + 1}`;
        const r = await c.query({ text, values: wm && opts.after != null ? [opts.after] : [], rowMode: 'array' });
        return { columns: r.fields.map((f) => f.name), rows: (r.rows as unknown[][]).slice(0, opts.limit), capped: r.rows.length > opts.limit, estimate: null };
      })
    );
  }
}

/** PostgreSQL's view of reading `object` as each role (B-1503). */
async function pgRoleCheck(c: pg.Client, object: string, roles: string[]): Promise<RoleCheck> {
  const me = (await c.query<{ u: string }>('SELECT current_user AS u')).rows[0]!.u;
  const rel = (
    await c.query<{ kind: string; rls: boolean; forced: boolean; owner: string; opts: string[] | null }>(
      'SELECT c.relkind AS kind, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced, pg_get_userbyid(c.relowner) AS owner, c.reloptions AS opts FROM pg_class c WHERE c.oid = to_regclass($1)',
      [object]
    )
  ).rows[0];
  const kind = !rel ? 'missing' : rel.kind === 'r' || rel.kind === 'p' ? 'table' : rel.kind === 'v' ? 'view' : 'other';
  const securityInvoker = !!rel?.opts?.some((o) => /^security_invoker=(true|on|1|yes)$/i.test(o));
  const found = (
    await c.query<{ role: string; member: boolean; bypass: boolean; can: boolean | null }>(
      "SELECT r.rolname AS role, pg_has_role(current_user, r.oid, 'MEMBER') AS member, (r.rolsuper OR r.rolbypassrls) AS bypass, CASE WHEN to_regclass($2) IS NULL THEN NULL ELSE has_table_privilege(r.oid, to_regclass($2), 'SELECT') END AS can FROM pg_roles r WHERE r.rolname = ANY($1::text[])",
      [roles, object]
    )
  ).rows;
  const byName = new Map(found.map((r) => [r.role, r]));
  return {
    account: me,
    object: { kind, rowSecurity: !!rel?.rls, forced: !!rel?.forced, owner: rel?.owner ?? null, securityInvoker },
    roles: roles.map((role) => {
      const r = byName.get(role);
      return { role, exists: !!r, member: !!r?.member, bypass: !!r?.bypass, canSelect: !!r?.can };
    })
  };
}

export const quoteMysqlIdent = (name: string): string =>
  name
    .split('.')
    .map((p) => '`' + p.replace(/`/g, '``') + '`')
    .join('.');

const WRITE_GRANT = /\b(ALL PRIVILEGES|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|INDEX|EXECUTE|FILE|SUPER|GRANT OPTION|TRIGGER|EVENT|CREATE ROUTINE|ALTER ROUTINE|LOCK TABLES|RELOAD|SHUTDOWN|PROCESS|REFERENCES|CREATE USER)\b/i;

/**
 * MySQL (and MariaDB) through mysql2 (B-416). As with PostgreSQL: the host is checked and the checked address is
 * dialled (TLS still verifies the name), and every read runs in `START TRANSACTION READ ONLY` with
 * MAX_EXECUTION_TIME, so the server refuses a write even if the parser missed one.
 */
export class MysqlDriver implements DataDriver {
  constructor(
    private readonly spec: ConnectionSpec,
    private readonly allow: AllowList = parseAllowList('')
  ) {}

  private async client<T>(timeoutMs: number, fn: (c: mysql.Connection) => Promise<T>): Promise<T> {
    const { host, port } = hostPort(this.spec.endpoint, 3306);
    const { addresses } = await checkHost(host, this.allow);
    const c = await mysql.createConnection({
      host: addresses[0],
      port,
      database: this.spec.database ?? undefined,
      user: this.spec.username ?? undefined,
      password: this.spec.password ?? undefined,
      ssl: this.spec.tls ? { rejectUnauthorized: true, ...(isIP(host) ? {} : { servername: host }) } : undefined,
      connectTimeout: Math.min(timeoutMs, 10_000),
      multipleStatements: false,
      supportBigNumbers: true,
      dateStrings: true,
      charset: 'utf8mb4'
    });
    try {
      return await fn(c);
    } finally {
      await c.end().catch(() => undefined);
    }
  }

  private async readOnly<T>(c: mysql.Connection, timeoutMs: number, fn: () => Promise<T>): Promise<T> {
    await c.query(`SET SESSION MAX_EXECUTION_TIME = ${Math.max(1, Math.floor(timeoutMs))}`).catch(() => undefined); // MariaDB has max_statement_time instead
    await c.query('START TRANSACTION READ ONLY');
    try {
      return await fn();
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
    }
  }

  async test(timeoutMs: number): Promise<TestResult> {
    return this.client(timeoutMs, async (c) => {
      const [rows] = (await c.query('SELECT VERSION() AS version, CURRENT_USER() AS user')) as unknown as [{ version: string; user: string }[]];
      const [grants] = (await c.query('SHOW GRANTS FOR CURRENT_USER()')) as unknown as [Record<string, string>[]];
      const lines = grants.map((g) => Object.values(g)[0] ?? '');
      // USAGE and SELECT (and SHOW VIEW) only: anything else can change data or the server.
      const writes = lines.filter((l) => WRITE_GRANT.test(l.replace(/^GRANT\s+/i, '').split(/\s+ON\s+/i)[0] ?? ''));
      const row = rows[0]!;
      const readOnly = writes.length === 0;
      return { version: `MySQL ${row.version}`, readOnly, health: 'healthy', detail: readOnly ? `Account ${row.user} is read-only; no write grants.` : `Account ${row.user} holds ${writes.length} grant${writes.length === 1 ? '' : 's'} beyond SELECT. Reads still run in a read-only transaction; use a read-only account.` };
    });
  }

  async introspect(timeoutMs: number): Promise<SchemaObject[]> {
    return this.client(timeoutMs, async (c) => {
      const where = this.spec.database ? 'table_schema = ?' : "table_schema NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')";
      const args = this.spec.database ? [this.spec.database] : [];
      const [t] = (await c.query(`SELECT table_schema AS s, table_name AS n, table_type AS k FROM information_schema.tables WHERE ${where} ORDER BY 1, 2 LIMIT 2000`, args)) as unknown as [{ s: string; n: string; k: string }[]];
      const [cols] = (await c.query(`SELECT table_schema AS s, table_name AS n, column_name AS c, data_type AS t FROM information_schema.columns WHERE ${where} ORDER BY table_schema, table_name, ordinal_position`, args)) as unknown as [{ s: string; n: string; c: string; t: string }[]];
      const byName = new Map<string, SchemaObject>();
      for (const r of t) byName.set(`${r.s}.${r.n}`, { name: `${r.s}.${r.n}`, kind: r.k === 'VIEW' ? 'view' : 'table', columns: [] });
      for (const r of cols) byName.get(`${r.s}.${r.n}`)?.columns.push({ name: r.c, type: r.t });
      return [...byName.values()];
    });
  }

  async query(_c: Classification, text: string, opts: { limit: number; timeoutMs: number }): Promise<QueryResult> {
    const inner = text.trim().replace(/;\s*$/, '');
    return this.client(opts.timeoutMs, (c) =>
      this.readOnly(c, opts.timeoutMs, async () => {
        const [rows, fields] = (await c.query({ sql: `SELECT * FROM (${inner}\n) AS exprsn_q LIMIT ${opts.limit + 1}`, rowsAsArray: true, timeout: opts.timeoutMs + 2000 })) as unknown as [unknown[][], { name: string }[]];
        return { columns: fields.map((f) => f.name), rows: rows.slice(0, opts.limit), capped: rows.length > opts.limit, estimate: null };
      })
    );
  }

  async mutate(object: string, op: RowMutation, timeoutMs: number): Promise<{ affected: number }> {
    checkMutation(op);
    return this.client(timeoutMs, async (c) => {
      await c.query('START TRANSACTION');
      try {
        const cols = Object.keys(op.values);
        const q = (sql: string, values: unknown[]) => c.query({ sql, values, timeout: timeoutMs + 2000 }) as unknown as Promise<[{ affectedRows?: number }]>;
        let r: [{ affectedRows?: number }];
        if (op.kind === 'insert') {
          const all = cols.includes(op.keyColumn) ? cols : [op.keyColumn, ...cols];
          const vals = all.map((k) => (k === op.keyColumn && !cols.includes(k) ? op.key : op.values[k]));
          r = await q(`INSERT INTO ${quoteMysqlIdent(object)} (${all.map(quoteMysqlIdent).join(', ')}) VALUES (${all.map(() => '?').join(', ')})`, vals);
        } else if (op.kind === 'update') {
          r = await q(`UPDATE ${quoteMysqlIdent(object)} SET ${cols.map((k) => `${quoteMysqlIdent(k)} = ?`).join(', ')} WHERE ${quoteMysqlIdent(op.keyColumn)} = ?`, [...cols.map((k) => op.values[k]), op.key]);
        } else r = await q(`DELETE FROM ${quoteMysqlIdent(object)} WHERE ${quoteMysqlIdent(op.keyColumn)} = ?`, [op.key]);
        await c.query('COMMIT');
        return { affected: r[0]?.affectedRows ?? 0 };
      } catch (err) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
    });
  }

  async rows(object: string, opts: { watermarkColumn: string | null; after: string | null; limit: number; timeoutMs: number }): Promise<QueryResult> {
    return this.client(opts.timeoutMs, (c) =>
      this.readOnly(c, opts.timeoutMs, async () => {
        const wm = opts.watermarkColumn ? quoteMysqlIdent(opts.watermarkColumn) : null;
        const sql = `SELECT * FROM ${quoteMysqlIdent(object)}${wm && opts.after != null ? ` WHERE ${wm} > ?` : ''}${wm ? ` ORDER BY ${wm}` : ''} LIMIT ${opts.limit + 1}`;
        const [rows, fields] = (await c.query({ sql, rowsAsArray: true, timeout: opts.timeoutMs + 2000, values: wm && opts.after != null ? [opts.after] : [] })) as unknown as [unknown[][], { name: string }[]];
        return { columns: fields.map((f) => f.name), rows: rows.slice(0, opts.limit), capped: rows.length > opts.limit, estimate: null };
      })
    );
  }
}

/** OpenSearch over its REST API with basic authentication. */
export class OpenSearchDriver implements DataDriver {
  private readonly base: string;
  private dispatcher: Dispatcher | null = null;

  constructor(
    private readonly spec: ConnectionSpec,
    /** Internal hosts only, unless CONNECTIONS_ALLOWED_HOSTS names the host or its network. */
    private readonly allow: AllowList = parseAllowList('')
  ) {
    const e = spec.endpoint.replace(/\/+$/, '');
    this.base = /^https?:\/\//.test(e) ? e : `${spec.tls ? 'https' : 'http'}://${e}`;
  }

  /** Names are checked in the guarded dispatcher's DNS lookup at dial time; address literals never reach it. */
  private guard(timeoutMs: number): Dispatcher {
    const host = new URL(this.base).hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) {
      const problem = addressProblem(host, host, this.allow);
      if (problem) throw new Error(problem);
    }
    this.dispatcher ??= guardedAgent(this.allow, timeoutMs);
    return this.dispatcher;
  }

  private async call(method: string, path: string, body: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.spec.username) headers.authorization = 'Basic ' + Buffer.from(`${this.spec.username}:${this.spec.password ?? ''}`).toString('base64');
    const dispatcher = this.guard(timeoutMs);
    const res = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs), dispatcher, redirect: 'error' });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      // not JSON
    }
    if (!res.ok) {
      const err = data.error as { reason?: string; type?: string } | string | undefined;
      throw new Error(`OpenSearch ${res.status}: ${typeof err === 'string' ? err : (err?.reason ?? err?.type ?? text.slice(0, 200))}`);
    }
    return data;
  }

  async test(timeoutMs: number): Promise<TestResult> {
    const root = await this.call('GET', '/', undefined, timeoutMs);
    const health = await this.call('GET', '/_cluster/health', undefined, timeoutMs).catch(() => ({ status: 'unknown' }) as Record<string, unknown>);
    const version = `OpenSearch ${String((root.version as { number?: string } | undefined)?.number ?? 'unknown')}`;
    const status = String(health.status ?? 'unknown');
    const unassigned = Number(health.unassigned_shards ?? 0);
    return { version, readOnly: true, health: status === 'green' ? 'healthy' : 'degraded', detail: `Cluster status ${status}${unassigned ? `: ${unassigned} replica${unassigned === 1 ? '' : 's'} unassigned` : ''}. Only _search and _count are sent.` };
  }

  async introspect(timeoutMs: number): Promise<SchemaObject[]> {
    const m = await this.call('GET', '/_mapping', undefined, timeoutMs);
    const out: SchemaObject[] = [];
    for (const [index, v] of Object.entries(m)) {
      if (index.startsWith('.')) continue;
      const props = ((v as { mappings?: { properties?: Record<string, { type?: string; properties?: unknown; dimension?: number }> } }).mappings?.properties ?? {}) as Record<string, { type?: string; properties?: unknown; dimension?: number }>;
      out.push({ name: index, kind: 'index', columns: Object.entries(props).map(([name, p]) => ({ name, type: p.type ? (p.type === 'knn_vector' && p.dimension ? `knn_vector ${p.dimension}` : p.type) : 'object' })) });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  async query(c: Classification, _text: string, opts: { limit: number; timeoutMs: number }): Promise<QueryResult> {
    const req = c.request!;
    if (req.endpoint === '_count') {
      const r = await this.call('POST', req.path, req.body ?? undefined, opts.timeoutMs);
      return { columns: ['count'], rows: [[Number(r.count ?? 0)]], capped: false, estimate: null };
    }
    const body = { ...(req.body ?? {}), size: Math.min(Number((req.body?.size as number | undefined) ?? 10), opts.limit), track_total_hits: true, timeout: `${Math.ceil(opts.timeoutMs / 1000)}s` };
    const r = await this.call('POST', req.path, body, opts.timeoutMs);
    const hits = ((r.hits as { hits?: { _id: string; _source?: Record<string, unknown> }[] } | undefined)?.hits ?? []).slice(0, opts.limit);
    const t = (r.hits as { total?: number | { value?: number } } | undefined)?.total;
    const total = typeof t === 'number' ? t : Number(t?.value ?? hits.length);
    const cols: string[] = ['_id'];
    for (const h of hits) for (const k of Object.keys(h._source ?? {})) if (!cols.includes(k)) cols.push(k);
    const rows = hits.map((h) => cols.map((k) => (k === '_id' ? h._id : (h._source?.[k] ?? null))));
    return { columns: cols, rows, capped: total > hits.length && hits.length >= Math.min(opts.limit, Number(body.size)), estimate: total > hits.length ? total : null };
  }

  async rows(): Promise<QueryResult> {
    throw new Error('OpenSearch indexes are not a knowledge source; use the index as the retrieval index instead.');
  }
}

/** The real drivers, confined to internal hosts plus `allow` (CONNECTIONS_ALLOWED_HOSTS). */
export const createDrivers = (allow: AllowList): Record<ConnectionSpec['engine'], DriverFactory> => ({
  postgres: (spec) => new PostgresDriver(spec, allow),
  opensearch: (spec) => new OpenSearchDriver(spec, allow),
  mysql: (spec) => new MysqlDriver(spec, allow),
  mongodb: (spec) => new MongoDriver(spec, allow)
});

export const defaultDrivers = createDrivers(parseAllowList(''));
