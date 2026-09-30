import { isIP } from 'node:net';
import pg from 'pg';
import { fetch, type Dispatcher } from 'undici';
import { addressProblem, checkHost, guardedAgent, parseAllowList, type AllowList } from '../mcp/hosts.js';
import type { Classification } from './classify.js';

/** What the service hands a driver: the endpoint and the opened credential. */
export interface ConnectionSpec {
  engine: 'postgres' | 'opensearch';
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
  /** Rows of one allow-listed object after a watermark, ordered by it (knowledge sources). */
  rows(object: string, opts: { watermarkColumn: string | null; after: string | null; limit: number; timeoutMs: number }): Promise<QueryResult>;
}

export type DriverFactory = (spec: ConnectionSpec) => DataDriver;

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

  async rows(object: string, opts: { watermarkColumn: string | null; after: string | null; limit: number; timeoutMs: number }): Promise<QueryResult> {
    return this.client(opts.timeoutMs, (c) =>
      this.readOnly(c, opts.timeoutMs, async () => {
        const wm = opts.watermarkColumn ? quoteIdent(opts.watermarkColumn) : null;
        const text = `SELECT * FROM ${quoteIdent(object)}${wm && opts.after != null ? ` WHERE ${wm} > $1` : ''}${wm ? ` ORDER BY ${wm}` : ''} LIMIT ${opts.limit + 1}`;
        const r = await c.query({ text, values: wm && opts.after != null ? [opts.after] : [], rowMode: 'array' });
        return { columns: r.fields.map((f) => f.name), rows: (r.rows as unknown[][]).slice(0, opts.limit), capped: r.rows.length > opts.limit, estimate: null };
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
  opensearch: (spec) => new OpenSearchDriver(spec, allow)
});

export const defaultDrivers = createDrivers(parseAllowList(''));
