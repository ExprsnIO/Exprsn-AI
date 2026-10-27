/*
 * 2.0.x: schema changes through the SQL-over-HTTP drivers and OpenSearch, against in-process fakes: plans built by
 * `buildPlan`, sent by each driver's `applyDdl`. Snowflake gets one request per statement (MULTI_STATEMENT_COUNT 1)
 * and stops at the first failure; BigQuery runs tables and search indexes as query jobs and datasets and routines
 * through their REST calls (409 tolerated for IF NOT EXISTS, routines.update for OR REPLACE); D1 sends a
 * transactional plan as one atomic batch; OpenSearch creates an index with PUT. PostgreSQL, MySQL, SQL Server and
 * Oracle are in test/integration/connections-ddl.test.ts.
 */
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BigQueryDriver } from '../src/connections/bigquery.js';
import { D1Driver } from '../src/connections/d1.js';
import { buildPlan, type DdlPlan } from '../src/connections/ddl.js';
import type { NameContext } from '../src/connections/dialects.js';
import { MysqlDriver, OpenSearchDriver, PostgresDriver, type ConnectionSpec } from '../src/connections/drivers.js';
import { MssqlDriver } from '../src/connections/mssql.js';
import { OracleDriver } from '../src/connections/oracle.js';
import { SnowflakeDriver } from '../src/connections/snowflake.js';
import { parseAllowList } from '../src/mcp/hosts.js';
import type { GuardedRequest, GuardedResponse } from '../src/platform/egress.js';

const allow = parseAllowList('');

/** A small HTTP fake: each test file's server answers through `handler`. */
async function serve(handler: (req: IncomingMessage, body: string, res: ServerResponse) => void): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += String(c)));
    req.on('end', () => handler(req, raw, res));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}
const stop = async (s: Server) => {
  s.closeAllConnections();
  await new Promise((r) => s.close(r));
};
const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

describe('SQL drivers refuse operations they do not perform', () => {
  const op = { engine: 'postgres', kind: 'dataset', object: 'x', statements: ['CREATE SCHEMA x'], ops: [{ op: 'mongo.createCollection', name: 'x', options: {} }], transactional: true, touches: [], notes: [], destructive: false, confirmName: null, hash: 'h' } as DdlPlan;
  const spec = (engine: ConnectionSpec['engine']): ConnectionSpec => ({ engine, endpoint: '127.0.0.1:1', database: 'd', tls: false, username: 'u', password: 'p' });

  it('names the operation before connecting anywhere', async () => {
    await expect(new PostgresDriver(spec('postgres'), allow).applyDdl(op, 1000)).rejects.toThrow(/PostgreSQL does not perform mongo\.createCollection/);
    await expect(new MysqlDriver(spec('mysql'), allow).applyDdl(op, 1000)).rejects.toThrow(/MySQL does not perform mongo\.createCollection/);
    await expect(new MssqlDriver(spec('mssql'), allow).applyDdl(op, 1000)).rejects.toThrow(/SQL Server does not perform/);
    await expect(new OracleDriver(spec('oracle'), allow).applyDdl(op, 1000)).rejects.toThrow(/Oracle does not perform/);
    await expect(new SnowflakeDriver(spec('snowflake'), allow).applyDdl(op, 1000)).rejects.toThrow(/Snowflake does not perform/);
    await expect(new D1Driver(spec('cloudflare-d1'), allow).applyDdl(op, 1000)).rejects.toThrow(/D1 does not perform/);
    await expect(new BigQueryDriver(spec('bigquery'), allow).applyDdl(op, 1000)).rejects.toThrow(/BigQuery does not perform mongo\.createCollection/);
    await expect(new OpenSearchDriver(spec('opensearch'), allow).applyDdl(op, 1000)).rejects.toThrow(/OpenSearch does not perform mongo\.createCollection/);
  });
});

describe('Snowflake applyDdl', () => {
  let fake: { url: string; server: Server };
  const bodies: { statement: string; parameters?: Record<string, string>; role?: string; timeout?: number }[] = [];
  beforeAll(async () => {
    fake = await serve((req, raw, res) => {
      if (req.headers.authorization !== 'Bearer pat-admin') return send(res, 401, { message: 'bad token' });
      if (req.method !== 'POST' || !req.url?.startsWith('/api/v2/statements?requestId=')) return send(res, 404, { message: 'not found' });
      const body = JSON.parse(raw) as (typeof bodies)[number];
      bodies.push(body);
      if (body.statement.includes('BOOM')) return send(res, 422, { code: '002003', message: "SQL compilation error: Object 'BOOM' does not exist or not authorized." });
      return send(res, 200, { code: '090001', message: 'Statement executed successfully.', statementHandle: 'h', resultSetMetaData: { numRows: 1, rowType: [{ name: 'status', type: 'text' }] }, data: [['Table created.']] });
    });
  });
  afterAll(() => stop(fake.server));

  const ctx: NameContext = { engine: 'snowflake', database: 'ANALYTICS', account: null, options: { schema: 'SALES' } };
  const driver = () => new SnowflakeDriver({ engine: 'snowflake', endpoint: fake.url, database: 'ANALYTICS', tls: true, username: 'ADMIN', password: 'pat-admin', options: { auth: 'pat', role: 'SYSADMIN', warehouse: 'WH' } }, allow, { allowHttp: true });

  it('sends each statement alone, as one statement, with the timeout and the admin role', async () => {
    const plan = buildPlan('snowflake', ctx, { kind: 'table', name: 'SALES.ORDERS2', columns: [{ name: 'id', type: { type: 'NUMBER', precision: 12, scale: 0 }, nullable: false }, { name: 'note', type: { type: 'VARCHAR' } }], primaryKey: ['id'], comment: 'Orders' });
    bodies.length = 0;
    expect(await driver().applyDdl(plan, 7000)).toEqual({ applied: 1 });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.statement).toBe(plan.statements[0]);
    expect(bodies[0]!.statement).not.toMatch(/;\s*$/);
    expect(bodies[0]).toMatchObject({ role: 'SYSADMIN', timeout: 7, parameters: { MULTI_STATEMENT_COUNT: '1' } });
  });

  it('runs statements in order and stops at the first failure, saying how many were applied', async () => {
    const schema = buildPlan('snowflake', ctx, { kind: 'dataset', name: 'staging', ifNotExists: true, comment: 'x' });
    const plan = { ...schema, statements: [schema.statements[0]!, 'CREATE TABLE BOOM (a INT)', 'CREATE TABLE AFTER_BOOM (a INT)'] };
    bodies.length = 0;
    await expect(driver().applyDdl(plan, 5000)).rejects.toThrow(/^Statement 2 of 3 failed after 1 applied: Snowflake 422: 002003: SQL compilation error/);
    expect(bodies.map((b) => b.statement)).toEqual([schema.statements[0], 'CREATE TABLE BOOM (a INT)']);
  });
});

/** The token endpoint, query jobs, datasets.insert and routines.insert and update. */
class FakeBigQuery {
  fake!: { url: string; server: Server };
  readonly keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  readonly email = 'admin@proj.iam.gserviceaccount.com';
  readonly datasets = new Map<string, Record<string, unknown>>();
  readonly routines = new Map<string, Record<string, unknown>>();
  readonly calls: { method: string; path: string; body: Record<string, unknown> }[] = [];

  key(): string {
    return JSON.stringify({ type: 'service_account', client_email: this.email, private_key: this.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), token_uri: `${this.fake.url}/token` });
  }

  async start(): Promise<this> {
    this.fake = await serve((req, raw, res) => this.handle(req, raw, res));
    return this;
  }

  private handle(req: IncomingMessage, raw: string, res: ServerResponse) {
    const u = new URL(req.url ?? '/', this.fake.url);
    if (u.pathname === '/token') {
      const [h, c, sig] = (new URLSearchParams(raw).get('assertion') ?? '').split('.');
      const ok = !!sig && createVerify('RSA-SHA256').update(`${h}.${c}`).verify(this.keys.publicKey, sig, 'base64url');
      return ok ? send(res, 200, { access_token: 'ya29.admin', expires_in: 3599 }) : send(res, 400, { error: 'invalid_grant' });
    }
    if (req.headers.authorization !== 'Bearer ya29.admin') return send(res, 401, { error: { code: 401, message: 'unauthenticated', status: 'UNAUTHENTICATED' } });
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    this.calls.push({ method: req.method ?? '', path: u.pathname, body });
    const exists = (what: string) => send(res, 409, { error: { code: 409, message: `Already Exists: ${what}`, status: 'ALREADY_EXISTS' } });
    if (u.pathname === '/bigquery/v2/projects/proj/queries' && req.method === 'POST') {
      if (String(body.query).includes('broken')) return send(res, 400, { error: { code: 400, message: 'Syntax error', status: 'INVALID_ARGUMENT' } });
      return send(res, 200, { jobComplete: true, jobReference: { jobId: 'job-ddl', location: 'EU' } });
    }
    if (u.pathname === '/bigquery/v2/projects/proj/datasets' && req.method === 'POST') {
      const id = (body.datasetReference as { datasetId: string }).datasetId;
      if (this.datasets.has(id)) return exists(`Dataset proj:${id}`);
      this.datasets.set(id, body);
      return send(res, 200, body);
    }
    const r = /^\/bigquery\/v2\/projects\/proj\/datasets\/([^/]+)\/routines(?:\/([^/]+))?$/.exec(u.pathname);
    if (r) {
      const ref = body.routineReference as { datasetId: string; routineId: string };
      if (req.method === 'POST' && !r[2]) {
        const key = `${r[1]}.${ref.routineId}`;
        if (this.routines.has(key)) return exists(`Routine proj:${key}`);
        this.routines.set(key, body);
        return send(res, 200, body);
      }
      if (req.method === 'PUT' && r[2]) {
        const key = `${r[1]}.${decodeURIComponent(r[2])}`;
        if (!this.routines.has(key)) return send(res, 404, { error: { code: 404, message: 'Not found', status: 'NOT_FOUND' } });
        this.routines.set(key, body);
        return send(res, 200, body);
      }
    }
    return send(res, 404, { error: { code: 404, message: 'Not found', status: 'NOT_FOUND' } });
  }
}

describe('BigQuery applyDdl', () => {
  let g: FakeBigQuery;
  beforeAll(async () => {
    g = await new FakeBigQuery().start();
  });
  afterAll(() => stop(g.fake.server));
  const ctx: NameContext = { engine: 'bigquery', database: 'proj', account: null, options: { location: 'EU' } };
  const driver = () => new BigQueryDriver({ engine: 'bigquery', endpoint: 'bigquery.googleapis.com', database: 'proj', tls: true, username: null, password: g.key(), options: { location: 'EU' } }, allow, { baseUrl: g.fake.url, allowHttp: true });

  it('runs a table and a search index as query jobs, one statement each', async () => {
    const table = buildPlan('bigquery', ctx, { kind: 'table', name: 'sales.notes', columns: [{ name: 'id', type: { type: 'INT64' }, nullable: false }, { name: 'body', type: { type: 'STRING' } }], comment: 'Notes' });
    const index = buildPlan('bigquery', ctx, { kind: 'index', name: 'notes_search', table: 'sales.notes', allColumns: true, method: 'search' });
    g.calls.length = 0;
    expect(await driver().applyDdl(table, 5000)).toEqual({ applied: 1 });
    expect(await driver().applyDdl(index, 5000)).toEqual({ applied: 1 });
    expect(g.calls.map((c) => c.body.query)).toEqual([table.statements[0], index.statements[0]]);
    expect(g.calls[1]!.body).toMatchObject({ useLegacySql: false, location: 'EU' });
    expect(String(g.calls[1]!.body.query)).toMatch(/^CREATE SEARCH INDEX `notes_search` ON `sales`\.`notes` \(ALL COLUMNS\)$/);
    await expect(driver().applyDdl({ ...table, statements: [table.statements[0]!, 'CREATE TABLE broken.x (a INT64)'] }, 5000)).rejects.toThrow(/^Statement 2 of 2 failed after 1 applied: BigQuery 400 INVALID_ARGUMENT: Syntax error/);
  });

  it('inserts a dataset through datasets.insert, and IF NOT EXISTS takes 409 as done', async () => {
    const plan = buildPlan('bigquery', ctx, { kind: 'dataset', name: 'staging', ifNotExists: true, comment: 'Landing', defaultTableExpirationDays: 7 });
    expect(plan.ops).toHaveLength(1);
    g.calls.length = 0;
    expect(await driver().applyDdl(plan, 5000)).toEqual({ applied: 1 });
    expect(g.calls[0]).toMatchObject({ method: 'POST', path: '/bigquery/v2/projects/proj/datasets', body: { datasetReference: { projectId: 'proj', datasetId: 'staging' }, location: 'EU', description: 'Landing', defaultTableExpirationMs: String(7 * 86_400_000) } });
    expect(g.calls.some((c) => c.body.query)).toBe(false);
    const again = await driver().applyDdl(plan, 5000);
    expect(again).toMatchObject({ applied: 1, detail: expect.stringMatching(/already exists/) });
    const strict = buildPlan('bigquery', ctx, { kind: 'dataset', name: 'staging' });
    await expect(driver().applyDdl(strict, 5000)).rejects.toThrow(/^Operation 1 of 1 failed after 0 applied: BigQuery 409 ALREADY_EXISTS: Already Exists: Dataset proj:staging/);
  });

  it('inserts routines through routines.insert, and OR REPLACE updates one that exists', async () => {
    const fn = { kind: 'function', name: 'sales.add_tax', params: [{ name: 'amount', type: { type: 'NUMERIC' } }], returns: { type: 'NUMERIC' }, body: 'amount * 1.2' };
    const plan = buildPlan('bigquery', ctx, fn);
    g.calls.length = 0;
    expect(await driver().applyDdl(plan, 5000)).toEqual({ applied: 1 });
    expect(g.calls[0]).toMatchObject({
      method: 'POST',
      path: '/bigquery/v2/projects/proj/datasets/sales/routines',
      body: { routineReference: { projectId: 'proj', datasetId: 'sales', routineId: 'add_tax' }, routineType: 'SCALAR_FUNCTION', language: 'SQL', arguments: [{ name: 'amount', dataType: { typeKind: 'NUMERIC' } }], returnType: { typeKind: 'NUMERIC' }, definitionBody: 'amount * 1.2' }
    });
    await expect(driver().applyDdl(plan, 5000)).rejects.toThrow(/409 ALREADY_EXISTS/);
    const replace = buildPlan('bigquery', ctx, { ...fn, body: 'amount * 1.25', orReplace: true });
    g.calls.length = 0;
    expect(await driver().applyDdl(replace, 5000)).toMatchObject({ applied: 1, detail: expect.stringMatching(/replaced/) });
    expect(g.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /bigquery/v2/projects/proj/datasets/sales/routines', 'PUT /bigquery/v2/projects/proj/datasets/sales/routines/add_tax']);
    expect(g.routines.get('sales.add_tax')).toMatchObject({ definitionBody: 'amount * 1.25' });
    const proc = buildPlan('bigquery', ctx, { kind: 'procedure', name: 'sales.touch', params: [{ name: 'n', type: { type: 'INT64' }, mode: 'inout' }], body: 'SET n = n + 1;' });
    await driver().applyDdl(proc, 5000);
    expect(g.routines.get('sales.touch')).toMatchObject({ routineType: 'PROCEDURE', arguments: [{ name: 'n', dataType: { typeKind: 'INT64' }, mode: 'INOUT' }] });
  });
});

describe('D1 applyDdl', () => {
  const db = new Database(':memory:');
  const seen: Record<string, unknown>[] = [];
  /** The raw endpoint on better-sqlite3: a statement, or a batch run in one transaction as D1 does. */
  const fake = async (r: GuardedRequest): Promise<GuardedResponse> => {
    const body = JSON.parse(String(r.body)) as { sql?: string; batch?: { sql: string }[] };
    seen.push(body);
    const reply = (status: number, doc: unknown) => ({ status, headers: {}, body: Buffer.from(JSON.stringify(doc)) }) as unknown as GuardedResponse;
    const ok = (n: number) => reply(200, { success: true, errors: [], result: Array.from({ length: n }, () => ({ success: true, results: { columns: [], rows: [] }, meta: {} })) });
    try {
      if (body.batch) {
        db.transaction(() => body.batch!.forEach((s) => db.prepare(s.sql).run()))();
        return ok(body.batch.length);
      }
      db.prepare(body.sql!).run();
      return ok(1);
    } catch (err) {
      return reply(400, { success: false, errors: [{ code: 7500, message: `${(err as Error).message}: SQLITE_ERROR` }], result: null });
    }
  };
  const driver = () => new D1Driver({ engine: 'cloudflare-d1', endpoint: 'https://api.cloudflare.com', database: 'db-1', tls: true, username: 'acct-1', password: 'tok' }, allow, fake);
  const ctx: NameContext = { engine: 'cloudflare-d1', database: 'db-1', account: 'acct-1', options: {} };
  const tables = () => (db.prepare("SELECT name FROM sqlite_schema WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((x) => x.name);

  it('creates a table and an index, one statement per request', async () => {
    const t = buildPlan('cloudflare-d1', ctx, { kind: 'table', name: 'notes', columns: [{ name: 'id', type: { type: 'INTEGER' }, identity: true }, { name: 'body', type: { type: 'TEXT' }, nullable: false }], primaryKey: ['id'], options: { strict: true } });
    const i = buildPlan('cloudflare-d1', ctx, { kind: 'index', name: 'notes_body', table: 'notes', columns: [{ name: 'body' }] });
    expect(await driver().applyDdl(t, 5000)).toEqual({ applied: 1 });
    expect(await driver().applyDdl(i, 5000)).toEqual({ applied: 1 });
    expect(tables()).toEqual(['notes', 'notes_body']);
    expect(seen.every((b) => typeof b.sql === 'string' && !('batch' in b))).toBe(true);
  });

  it('sends a transactional plan of several statements as one batch, rolled back whole on a failure', async () => {
    const base = buildPlan('cloudflare-d1', ctx, { kind: 'table', name: 'a1', columns: [{ name: 'x', type: { type: 'TEXT' } }] });
    expect(base.transactional).toBe(true);
    seen.length = 0;
    expect(await driver().applyDdl({ ...base, statements: [base.statements[0]!, 'CREATE INDEX a1_x ON "a1" ("x")'] }, 5000)).toEqual({ applied: 2 });
    expect(seen).toEqual([{ batch: [{ sql: base.statements[0], params: [] }, { sql: 'CREATE INDEX a1_x ON "a1" ("x")', params: [] }] }]);
    const b2 = buildPlan('cloudflare-d1', ctx, { kind: 'table', name: 'b2', columns: [{ name: 'x', type: { type: 'TEXT' } }] });
    await expect(driver().applyDdl({ ...b2, statements: [b2.statements[0]!, 'CREATE INDEX nope ON missing (x)'] }, 5000)).rejects.toThrow(/^The batch of 2 statements failed; D1 rolled it back and nothing was applied: D1 answered 400 \(7500\)/);
    expect(tables()).not.toContain('b2');
  });

  it('runs a non-transactional plan in order and stops at the first failure', async () => {
    const c = buildPlan('cloudflare-d1', ctx, { kind: 'table', name: 'c3', columns: [{ name: 'x', type: { type: 'TEXT' } }] });
    await expect(driver().applyDdl({ ...c, transactional: false, statements: [c.statements[0]!, 'CREATE INDEX nope ON missing (x)', 'CREATE TABLE never (x)'] }, 5000)).rejects.toThrow(/^Statement 2 of 3 failed after 1 applied/);
    expect(tables()).toContain('c3');
    expect(tables()).not.toContain('never');
  });
});

describe('OpenSearch applyDdl', () => {
  let fake: { url: string; server: Server };
  const puts: { path: string; auth: string | undefined; body: Record<string, unknown> }[] = [];
  beforeAll(async () => {
    fake = await serve((req, raw, res) => {
      if (req.method !== 'PUT') return send(res, 405, { error: 'method' });
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
      if (puts.some((p) => p.path === path)) return send(res, 400, { error: { type: 'resource_already_exists_exception', reason: `index [${path.slice(1)}] already exists` }, status: 400 });
      puts.push({ path, auth: req.headers.authorization, body: JSON.parse(raw) as Record<string, unknown> });
      return send(res, 200, { acknowledged: true, shards_acknowledged: true, index: path.slice(1) });
    });
  });
  afterAll(() => stop(fake.server));
  const ctx: NameContext = { engine: 'opensearch', database: null, account: null, options: {} };
  const driver = () => new OpenSearchDriver({ engine: 'opensearch', endpoint: fake.url, database: null, tls: false, username: 'admin', password: 'pw' }, allow);

  it('creates the index with PUT and the plan\'s body', async () => {
    const plan = buildPlan('opensearch', ctx, { kind: 'search-index', name: 'tickets-2026', shards: 2, replicas: 0, dynamic: 'strict', fields: [{ name: 'title', type: 'text', analyzer: 'english' }, { name: 'opened', type: 'date' }, { name: 'emb', type: 'knn_vector', dimension: 4 }] });
    expect(await driver().applyDdl(plan, 5000)).toEqual({ applied: 1 });
    expect(puts[0]).toEqual({ path: '/tickets-2026', auth: 'Basic ' + Buffer.from('admin:pw').toString('base64'), body: plan.ops[0]!.op === 'opensearch.createIndex' ? plan.ops[0]!.body : {} });
    expect(puts[0]!.body).toMatchObject({ settings: { index: { number_of_shards: 2, number_of_replicas: 0, knn: true } }, mappings: { dynamic: 'strict', properties: { title: { type: 'text', analyzer: 'english' } } } });
    await expect(driver().applyDdl(plan, 5000)).rejects.toThrow(/^Operation 1 of 1 failed after 0 applied: OpenSearch 400: index \[tickets-2026\] already exists/);
  });

  it('refuses a plan without operations, and an address outside the allowed hosts', async () => {
    const plan = buildPlan('opensearch', ctx, { kind: 'search-index', name: 'x1' });
    await expect(driver().applyDdl({ ...plan, ops: [] }, 5000)).rejects.toThrow(/no OpenSearch operations/);
    const outside = new OpenSearchDriver({ engine: 'opensearch', endpoint: 'http://8.8.8.8:9200', database: null, tls: false, username: null, password: null }, allow);
    await expect(outside.applyDdl(plan, 2000)).rejects.toThrow();
    expect(puts.map((p) => p.path)).toEqual(['/tickets-2026']);
  });
});
