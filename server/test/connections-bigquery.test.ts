/*
 * 1.9.0: BigQuery connections. The classifier (GoogleSQL lexing rewritten for the shared parser, every refusal
 * family), the driver against an in-process fake of the token endpoint and the BigQuery REST API (the JWT bearer
 * grant verified with the key's public half, synchronous answers, a job that finishes after polling, one that never
 * does and is cancelled, pageToken paging, typed positional parameters, Google's error shape, the guard on address
 * literals), saved-query binding in the bigquery dialect, and a connection registered, tested, introspected,
 * allow-listed and queried through the service.
 */
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BigQueryDriver, bigQueryParam, decodeBigQuery } from '../src/connections/bigquery.js';
import { classifyBigQuery } from '../src/connections/classify-bigquery.js';
import type { ConnectionSpec } from '../src/connections/drivers.js';
import { renderSql, sqlPieces } from '../src/connections/saved-queries.js';
import { parseAllowList } from '../src/mcp/hosts.js';
import { localUser, loginAdmin, type Harness } from './helpers.js';
import { harnessWith } from './retrieval-seed.js';

describe('BigQuery classification', () => {
  it('reads GoogleSQL: backtick paths, UNNEST, wildcard tables, comments and every string form', () => {
    expect(classifyBigQuery('SELECT name FROM `my-proj.Sales.Orders` WHERE region = "EU"')).toMatchObject({ kind: 'read', verb: 'SELECT', objects: ['my-proj.sales.orders'] });
    expect(classifyBigQuery('SELECT o.id FROM `my-proj`.`sales`.`orders` AS o JOIN sales.customers c ON c.id = o.cid').objects).toEqual(['my-proj.sales.orders', 'sales.customers']);
    expect(classifyBigQuery('SELECT t.id, tag FROM sales.orders AS t, UNNEST(t.tags) AS tag CROSS JOIN UNNEST([1, 2, 3]) AS n')).toMatchObject({ kind: 'read', objects: ['sales.orders'] });
    expect(classifyBigQuery('SELECT * FROM UNNEST(ARRAY(SELECT id FROM secret.vault))').objects).toEqual(['secret.vault']);
    expect(classifyBigQuery('SELECT * FROM `analytics.events_*` WHERE _TABLE_SUFFIX > "2026"')).toMatchObject({ kind: 'read', objects: ['analytics.events_*'] });
    expect(classifyBigQuery("SELECT 1 FROM ds.t # DELETE FROM ds.t\n-- DROP TABLE ds.t\n/* TRUNCATE TABLE ds.t */ WHERE x = '''DELETE FROM ds.t;\nDROP TABLE x''' AND y = r'\\d+' AND z = b\"\\x00\"")).toMatchObject({ kind: 'read', objects: ['ds.t'] });
    expect(classifyBigQuery("SELECT 'it\\'s; DELETE' AS a FROM ds.t")).toMatchObject({ kind: 'read', objects: ['ds.t'] });
    expect(classifyBigQuery('SELECT * FROM ds.t FOR SYSTEM_TIME AS OF TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)')).toMatchObject({ kind: 'read', objects: ['ds.t'] });
    expect(classifyBigQuery('SELECT a, ROW_NUMBER() OVER (PARTITION BY a ORDER BY b) AS rn FROM ds.t QUALIFY rn = 1')).toMatchObject({ kind: 'read', objects: ['ds.t'] });
    expect(classifyBigQuery('WITH x AS (SELECT * FROM ds.a) SELECT * EXCEPT (secret) FROM x')).toMatchObject({ kind: 'read', objects: ['ds.a'] });
    expect(classifyBigQuery('SELECT * FROM `region-eu`.INFORMATION_SCHEMA.TABLES').objects).toEqual(['region-eu.information_schema.tables']);
  });

  it('refuses scripting, writes, DDL, several statements and functions that reach other systems', () => {
    for (const q of ['DECLARE x INT64 DEFAULT 1', 'SET x = 2', 'BEGIN SELECT 1; END', 'IF TRUE THEN SELECT 1; END IF', "EXECUTE IMMEDIATE 'DROP TABLE ds.t'", 'CALL ds.proc()', 'ASSERT (SELECT COUNT(*) FROM ds.t) > 0', 'LOOP SELECT 1; END LOOP', 'WHILE TRUE DO SELECT 1; END WHILE', "RAISE USING MESSAGE = 'x'"]) {
      expect(['ddl', 'write'], q).toContain(classifyBigQuery(q).kind);
    }
    expect(classifyBigQuery('INSERT INTO ds.t (a) VALUES (1)')).toMatchObject({ kind: 'write', verb: 'INSERT' });
    expect(classifyBigQuery('UPDATE ds.t SET a = 1 WHERE TRUE')).toMatchObject({ kind: 'write' });
    expect(classifyBigQuery('DELETE FROM ds.t WHERE TRUE')).toMatchObject({ kind: 'write' });
    expect(classifyBigQuery('MERGE ds.t USING ds.s ON FALSE WHEN NOT MATCHED THEN INSERT ROW')).toMatchObject({ kind: 'write', verb: 'MERGE' });
    expect(classifyBigQuery('TRUNCATE TABLE ds.t')).toMatchObject({ kind: 'ddl' });
    expect(classifyBigQuery("EXPORT DATA OPTIONS (uri = 'gs://b/*.csv', format = 'CSV') AS SELECT * FROM ds.t")).toMatchObject({ kind: 'write', verb: 'EXPORT DATA' });
    expect(classifyBigQuery("LOAD DATA INTO ds.t FROM FILES (format = 'CSV', uris = ['gs://b/x.csv'])")).toMatchObject({ kind: 'write', verb: 'LOAD DATA' });
    expect(classifyBigQuery('CREATE TABLE ds.copy AS SELECT * FROM ds.t')).toMatchObject({ kind: 'ddl', verb: 'CREATE' });
    expect(classifyBigQuery('CREATE TEMP FUNCTION f() AS (1); SELECT f()')).toMatchObject({ kind: 'multiple' });
    for (const q of ['ALTER TABLE ds.t ADD COLUMN x INT64', 'DROP TABLE ds.t', 'UNDROP SCHEMA ds', 'GRANT `roles/bigquery.dataViewer` ON TABLE ds.t TO "user:a@b.c"', 'REVOKE `roles/bigquery.dataViewer` ON TABLE ds.t FROM "user:a@b.c"']) expect(classifyBigQuery(q).kind, q).toBe('ddl');
    expect(classifyBigQuery('SELECT 1 FROM ds.t; SELECT 2 FROM ds.t')).toMatchObject({ kind: 'multiple' });
    expect(classifyBigQuery("SELECT * FROM EXTERNAL_QUERY('proj.eu.pg', 'SELECT * FROM users')")).toMatchObject({ kind: 'denied', denied: 'external_query()' });
    expect(classifyBigQuery("SELECT * FROM `EXTERNAL_QUERY`('proj.eu.pg', 'SELECT 1')")).toMatchObject({ kind: 'denied' });
    expect(classifyBigQuery('SELECT EXTERNAL_OBJECT_TRANSFORM(TABLE ds.objs, ["SIGNED_URL"])')).toMatchObject({ kind: 'denied' });
    expect(classifyBigQuery('SELECT * FROM ML.PREDICT(MODEL ds.m, TABLE ds.secret)')).toMatchObject({ kind: 'unparsed' });
    expect(classifyBigQuery("SELECT * FROM AI.GENERATE_TABLE(MODEL ds.m, (SELECT 'x' AS prompt))")).toMatchObject({ kind: 'unparsed' });
    expect(classifyBigQuery('SELECT * FROM VECTOR_SEARCH(TABLE ds.secret, "emb", TABLE ds.q, "emb")')).toMatchObject({ kind: 'unparsed' });
    expect(classifyBigQuery('#legacySQL\nSELECT * FROM [proj:ds.t]')).toMatchObject({ kind: 'denied' });
  });

  it('never ends a string where BigQuery would not', () => {
    // A triple-quoted string hides keywords and semicolons; a raw string with a backslash before its quote is ambiguous.
    expect(classifyBigQuery('SELECT """a; DELETE FROM ds.t; "quoted" """ AS x FROM ds.t')).toMatchObject({ kind: 'read', objects: ['ds.t'] });
    expect(classifyBigQuery("SELECT r'\\' AS x, 1 FROM ds.t WHERE y = '; DELETE FROM ds.t --'")).toMatchObject({ kind: 'unparsed' });
    expect(classifyBigQuery("SELECT 'unterminated FROM ds.t")).toMatchObject({ kind: 'unparsed' });
    expect(classifyBigQuery("SELECT 'line\nbreak' FROM ds.t")).toMatchObject({ kind: 'unparsed' });
    expect(classifyBigQuery('SELECT * FROM `ds..t`')).toMatchObject({ kind: 'unparsed' });
  });

  it('binds saved-query parameters with one ? per use, skipping strings, triple quotes and # comments', () => {
    const names = new Set(['tier', 'ids']);
    const sql = "SELECT * FROM `ds.t` WHERE tier = :tier AND id IN (:ids) AND note = ''':tier''' # :nope\nAND alt = :tier AND s = \":tier\"";
    const { pieces, used } = sqlPieces(sql, 'bigquery', names);
    expect([...used].sort()).toEqual(['ids', 'tier']);
    const defs = [
      { name: 'tier', type: 'string' as const, required: true },
      { name: 'ids', type: 'list' as const, required: true }
    ];
    expect(renderSql(pieces, 'bigquery', defs as never, { tier: 'gold', ids: [1, 2] })).toEqual({ text: "SELECT * FROM `ds.t` WHERE tier = ? AND id IN (?, ?) AND note = ''':tier''' # :nope\nAND alt = ? AND s = \":tier\"", params: ['gold', 1, 2, 'gold'] });
  });
});

describe('BigQuery values', () => {
  it('types parameters and decodes cells', () => {
    expect(bigQueryParam(5)).toEqual({ parameterType: { type: 'INT64' }, parameterValue: { value: '5' } });
    expect(bigQueryParam(1.5)).toMatchObject({ parameterType: { type: 'FLOAT64' } });
    expect(bigQueryParam(true)).toEqual({ parameterType: { type: 'BOOL' }, parameterValue: { value: 'true' } });
    expect(bigQueryParam(null)).toEqual({ parameterType: { type: 'STRING' }, parameterValue: {} });
    expect(bigQueryParam(new Date(0))).toMatchObject({ parameterType: { type: 'TIMESTAMP' }, parameterValue: { value: '1970-01-01T00:00:00.000Z' } });
    expect(bigQueryParam(['a', 'b'])).toEqual({ parameterType: { type: 'ARRAY', arrayType: { type: 'STRING' } }, parameterValue: { arrayValues: [{ value: 'a' }, { value: 'b' }] } });
    expect(decodeBigQuery({ name: 'n', type: 'INT64' }, '9007199254740993')).toBe('9007199254740993');
    expect(decodeBigQuery({ name: 'n', type: 'INTEGER' }, '42')).toBe(42);
    expect(decodeBigQuery({ name: 'n', type: 'NUMERIC' }, '1.10')).toBe('1.10');
    expect(decodeBigQuery({ name: 'n', type: 'TIMESTAMP' }, '1.7E9')).toBe('2023-11-14T22:13:20.000Z');
    expect(decodeBigQuery({ name: 'r', type: 'RECORD', mode: 'REPEATED', fields: [{ name: 'k', type: 'STRING' }] }, [{ v: { f: [{ v: 'x' }] } }])).toEqual([{ k: 'x' }]);
  });
});

/** The token endpoint and enough of the BigQuery REST API. */
class FakeGoogle {
  server!: Server;
  url = '';
  readonly keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  readonly email = 'reader@proj.iam.gserviceaccount.com';
  tokenCalls = 0;
  bodies: Record<string, unknown>[] = [];
  polls = 0;
  cancels: string[] = [];

  key(): string {
    return JSON.stringify({ type: 'service_account', client_email: this.email, private_key: this.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), token_uri: `${this.url}/token` });
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }

  private send(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private rowsOf(values: unknown[][]) {
    return values.map((r) => ({ f: r.map((v) => ({ v })) }));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    let raw = '';
    for await (const c of req) raw += String(c);
    const u = new URL(req.url ?? '/', this.url);
    if (u.pathname === '/token') {
      const f = new URLSearchParams(raw);
      const [h, c, sig] = (f.get('assertion') ?? '').split('.');
      const ok = f.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer' && !!sig && createVerify('RSA-SHA256').update(`${h}.${c}`).verify(this.keys.publicKey, sig, 'base64url');
      const claims = JSON.parse(Buffer.from(c ?? '', 'base64url').toString() || '{}') as Record<string, unknown>;
      if (!ok || claims.iss !== this.email || claims.aud !== `${this.url}/token` || claims.scope !== 'https://www.googleapis.com/auth/bigquery' || Number(claims.exp) - Number(claims.iat) > 3600) return this.send(res, 400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
      this.tokenCalls++;
      return this.send(res, 200, { access_token: `ya29.fake-${this.tokenCalls}`, expires_in: 3599, token_type: 'Bearer' });
    }
    if (!/^Bearer ya29\.fake-\d+$/.test(req.headers.authorization ?? '')) return this.send(res, 401, { error: { code: 401, message: 'Request is missing required authentication credential.', status: 'UNAUTHENTICATED' } });
    if (u.pathname === '/bigquery/v2/projects/proj/datasets') return this.send(res, 200, { datasets: [{ datasetReference: { datasetId: 'sales' } }] });
    const cancel = /^\/bigquery\/v2\/projects\/proj\/jobs\/([^/]+)\/cancel$/.exec(u.pathname);
    if (cancel && req.method === 'POST') {
      this.cancels.push(cancel[1]!);
      return this.send(res, 200, { job: {} });
    }
    const people = { schema: { fields: [{ name: 'id', type: 'INTEGER' }, { name: 'name', type: 'STRING' }, { name: 'email', type: 'STRING' }, { name: 'score', type: 'FLOAT' }, { name: 'active', type: 'BOOLEAN' }, { name: 'at', type: 'TIMESTAMP' }, { name: 'tags', type: 'STRING', mode: 'REPEATED' }] } };
    const peopleRows = (from: number, n: number) => this.rowsOf(Array.from({ length: n }, (_, i) => [String(from + i + 1), `Person ${from + i + 1}`, `p${from + i + 1}@example.org`, '1.5', 'true', '1.7E9', [{ v: 'a' }, { v: 'b' }]]));
    const results = /^\/bigquery\/v2\/projects\/proj\/queries\/([^/]+)$/.exec(u.pathname);
    if (results) {
      const job = results[1]!;
      if (job === 'job-never') return this.send(res, 200, { jobComplete: false, jobReference: { jobId: job, location: 'EU' } });
      if (job === 'job-slow') {
        this.polls++;
        if (this.polls < 2) return this.send(res, 200, { jobComplete: false, jobReference: { jobId: job, location: 'EU' } });
        return this.send(res, 200, { jobComplete: true, jobReference: { jobId: job, location: 'EU' }, ...people, rows: peopleRows(0, 3), totalRows: '3' });
      }
      if (job === 'job-paged' && u.searchParams.get('pageToken') === 'p2') return this.send(res, 200, { jobComplete: true, ...people, rows: peopleRows(2, 3), totalRows: '5' });
      return this.send(res, 404, { error: { code: 404, message: `Not found: Job proj:${job}`, status: 'NOT_FOUND' } });
    }
    if (u.pathname !== '/bigquery/v2/projects/proj/queries' || req.method !== 'POST') return this.send(res, 404, { error: { code: 404, message: 'Not found', status: 'NOT_FOUND' } });
    const body = JSON.parse(raw) as { query: string; dryRun?: boolean };
    this.bodies.push(body);
    const q = body.query;
    if (body.dryRun) return this.send(res, 200, { jobComplete: true, totalBytesProcessed: '0', jobReference: { location: 'EU' } });
    if (q.includes('broken')) return this.send(res, 400, { error: { code: 400, message: 'Syntax error: Unexpected keyword broken at [1:8]', status: 'INVALID_ARGUMENT' } });
    if (q.includes('INFORMATION_SCHEMA.COLUMNS AS c')) {
      const fields = ['s', 'n', 'c', 't', 'k'].map((name) => ({ name, type: 'STRING' }));
      return this.send(res, 200, { jobComplete: true, schema: { fields }, rows: this.rowsOf([['sales', 'people', 'id', 'INT64', 'BASE TABLE'], ['sales', 'people', 'name', 'STRING', 'BASE TABLE'], ['sales', 'people', 'email', 'STRING', 'BASE TABLE'], ['sales', 'v_totals', 'total', 'NUMERIC', 'VIEW']]), totalRows: '4' });
    }
    if (q.includes('data_type FROM')) return this.send(res, 200, { jobComplete: true, schema: { fields: [{ name: 'data_type', type: 'STRING' }] }, rows: this.rowsOf([['TIMESTAMP']]) });
    if (q.includes('slow_table')) return this.send(res, 200, { jobComplete: false, jobReference: { jobId: 'job-slow', location: 'EU' } });
    if (q.includes('never_done')) return this.send(res, 200, { jobComplete: false, jobReference: { jobId: 'job-never', location: 'EU' } });
    if (q.includes('paged')) return this.send(res, 200, { jobComplete: true, jobReference: { jobId: 'job-paged', location: 'EU' }, ...people, rows: peopleRows(0, 2), pageToken: 'p2', totalRows: '5' });
    return this.send(res, 200, { jobComplete: true, jobReference: { jobId: 'job-1', location: 'EU' }, ...people, rows: peopleRows(0, 3), totalRows: '3' });
  }
}

describe('BigQueryDriver', () => {
  let g: FakeGoogle;
  beforeAll(async () => {
    g = await new FakeGoogle().start();
  });
  afterAll(async () => {
    await g.stop();
  });
  const spec = (extra: Partial<ConnectionSpec> = {}): ConnectionSpec => ({ engine: 'bigquery', endpoint: 'bigquery.googleapis.com', database: 'proj', tls: true, username: null, password: g.key(), options: { location: 'EU', maximumBytesBilled: 50_000_000 }, ...extra });
  const driver = (extra: Partial<ConnectionSpec> = {}) => new BigQueryDriver(spec(extra), parseAllowList(''), { baseUrl: g.url, allowHttp: true });

  it('signs in with the JWT bearer grant, runs a dry-run test, and keeps the token', async () => {
    const before = g.tokenCalls;
    const t = await driver().test(5000);
    expect(t).toMatchObject({ readOnly: true, health: 'healthy', version: 'BigQuery (project proj)' });
    expect(t.detail).toContain(g.email);
    await driver().test(5000);
    expect(g.tokenCalls - before).toBeLessThanOrEqual(1);
    expect(g.bodies.at(-1)).toMatchObject({ query: 'SELECT 1', dryRun: true, useLegacySql: false, location: 'EU', maximumBytesBilled: '50000000' });
  });

  it('runs a capped read with typed positional parameters and decodes the rows', async () => {
    const r = await driver().query({ kind: 'read', verb: 'SELECT', objects: ['sales.people'] }, 'SELECT * FROM sales.people WHERE id > ? AND name <> ?;', { limit: 2, timeoutMs: 5000, params: [0, 'x'], offset: 4 });
    expect(r.columns).toEqual(['id', 'name', 'email', 'score', 'active', 'at', 'tags']);
    expect(r.rows).toEqual([
      [1, 'Person 1', 'p1@example.org', 1.5, true, '2023-11-14T22:13:20.000Z', ['a', 'b']],
      [2, 'Person 2', 'p2@example.org', 1.5, true, '2023-11-14T22:13:20.000Z', ['a', 'b']]
    ]);
    expect(r.capped).toBe(true);
    const body = g.bodies.at(-1)!;
    expect(body).toMatchObject({ query: 'SELECT * FROM (SELECT * FROM sales.people WHERE id > ? AND name <> ?\n) AS exprsn_q LIMIT 3 OFFSET 4', maxResults: 3, parameterMode: 'POSITIONAL', labels: { client: 'exprsn-ai' } });
    expect(body.queryParameters).toEqual([bigQueryParam(0), bigQueryParam('x')]);
    expect(body.requestId).toMatch(/^[0-9A-Z]{26}$/);
  });

  it('polls a job until it finishes, pages by pageToken, and cancels one that outlasts the timeout', async () => {
    const slow = await driver().query({ kind: 'read', verb: 'SELECT', objects: [] }, 'SELECT * FROM ds.slow_table', { limit: 10, timeoutMs: 5000 });
    expect(slow.rows).toHaveLength(3);
    expect(g.polls).toBeGreaterThanOrEqual(2);
    const paged = await driver().query({ kind: 'read', verb: 'SELECT', objects: [] }, 'SELECT * FROM ds.paged', { limit: 10, timeoutMs: 5000 });
    expect(paged.rows.map((r) => r[0])).toEqual([1, 2, 3, 4, 5]);
    expect(paged.capped).toBe(false);
    await expect(driver().query({ kind: 'read', verb: 'SELECT', objects: [] }, 'SELECT * FROM ds.never_done', { limit: 10, timeoutMs: 1200 })).rejects.toThrow(/was cancelled/);
    expect(g.cancels).toContain('job-never');
  });

  it("reports Google's errors, refuses keys that are not keys, and never echoes the key", async () => {
    await expect(driver().query({ kind: 'read', verb: 'SELECT', objects: [] }, 'SELECT broken', { limit: 1, timeoutMs: 5000 })).rejects.toThrow(/BigQuery 400 INVALID_ARGUMENT: Syntax error/);
    await expect(driver({ password: 'not json' }).test(5000)).rejects.toThrow('The credential is not a service account JSON key.');
    await expect(driver({ username: 'someone@else.iam.gserviceaccount.com' }).test(5000)).rejects.toThrow(/belongs to reader@proj/);
    const err = await driver({ password: JSON.stringify({ client_email: 'x@y.z', private_key: 'garbage-key-material', token_uri: `${g.url}/token` }) })
      .test(5000)
      .catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain('garbage-key-material');
  });

  it('introspects a region and reads rows after a watermark in the column type', async () => {
    const schema = await driver().introspect(5000);
    expect(schema).toEqual([
      { name: 'sales.people', kind: 'table', columns: [{ name: 'id', type: 'INT64' }, { name: 'name', type: 'STRING' }, { name: 'email', type: 'STRING' }] },
      { name: 'sales.v_totals', kind: 'view', columns: [{ name: 'total', type: 'NUMERIC' }] }
    ]);
    expect(g.bodies.at(-1)!.query).toContain('`proj`.`region-eu`.INFORMATION_SCHEMA.COLUMNS');
    const noLoc = await new BigQueryDriver(spec({ options: {} }), parseAllowList(''), { baseUrl: g.url, allowHttp: true }).introspect(5000);
    expect(noLoc.map((o) => o.name)).toEqual(['sales.people', 'sales.v_totals']);
    expect(g.bodies.at(-1)!.query).toContain('`proj`.`sales`.INFORMATION_SCHEMA.COLUMNS');
    const rows = await driver().rows('sales.people', { watermarkColumn: 'at', after: '2026-01-01T00:00:00.000Z', limit: 2, timeoutMs: 5000 });
    expect(rows.capped).toBe(true);
    const body = g.bodies.at(-1)!;
    expect(body.query).toBe('SELECT * FROM `sales`.`people` WHERE `at` > CAST(? AS TIMESTAMP) ORDER BY `at` LIMIT 3');
    expect(body.queryParameters).toEqual([bigQueryParam('2026-01-01T00:00:00.000Z')]);
  });

  it('refuses a public address literal before anything is sent', async () => {
    const d = new BigQueryDriver(spec(), parseAllowList(''), { baseUrl: 'http://8.8.8.8', allowHttp: true });
    await expect(d.test(2000)).rejects.toThrow(/public address/);
    await expect(new BigQueryDriver(spec(), parseAllowList(''), { baseUrl: g.url }).test(2000)).rejects.toThrow(/is not https/);
  });
});

describe('BigQuery connections through the service', () => {
  let g: FakeGoogle;
  let h: Harness;
  beforeEach(async () => {
    g = await new FakeGoogle().start();
    h = await harnessWith({ drivers: { bigquery: (s) => new BigQueryDriver(s, parseAllowList(''), { baseUrl: g.url, allowHttp: true }) } }, { OLLAMA_POLL_MS: '600000' });
  });
  afterEach(async () => {
    await h.close();
    await g.stop();
  });

  it('registers, tests, introspects, allow-lists and runs masked reads; refuses what the classifier refuses', async () => {
    await localUser(h, 'bqadmin', ['connection-admin', 'member'], 'confidential');
    const a = await loginAdmin(h, 'bqadmin');
    const post = (p: string, b: object = {}) => a.agent.post(p).set('x-csrf-token', a.csrf).send(b);
    const put = (p: string, b: object) => a.agent.put(p).set('x-csrf-token', a.csrf).send(b);
    await post('/api/admin/connections', { name: 'bq', engine: 'bigquery', endpoint: 'bigquery.googleapis.com', password: g.key() }).expect(409);
    const conn = (await post('/api/admin/connections', { name: 'bq', engine: 'bigquery', endpoint: 'bigquery.googleapis.com', database: 'proj', label: 'internal', password: g.key(), options: { location: 'EU' } }).expect(201)).body;
    expect(conn).toMatchObject({ engine: 'bigquery', tls: true, options: { location: 'EU' }, hasCredential: true });
    expect(JSON.stringify(conn)).not.toContain('PRIVATE KEY');
    expect((await post(`/api/admin/connections/${conn.id}/test`).expect(200)).body).toMatchObject({ ok: true, health: 'healthy' });
    expect((await post(`/api/admin/connections/${conn.id}/schema`).expect(200)).body).toMatchObject({ objects: 2 });
    await put(`/api/admin/connections/${conn.id}/allow-list`, { objects: ['sales.people'], piiColumns: [] }).expect(200);
    const r = (await post(`/api/admin/connections/${conn.id}/query`, { query: 'SELECT id, name, email FROM `proj.sales.people`' }).expect(200)).body;
    expect(r.rows[0][2]).toMatch(/^••••/);
    expect(r.masked).toContain('email');
    expect((await post(`/api/admin/connections/${conn.id}/query`, { query: 'SELECT * FROM sales.v_totals' }).expect(422)).body).toMatchObject({ kind: 'denied' });
    expect((await post(`/api/admin/connections/${conn.id}/query`, { query: 'SELECT * FROM `other-proj.sales.people`' }).expect(422)).body).toMatchObject({ kind: 'denied' });
    expect((await post(`/api/admin/connections/${conn.id}/query`, { query: 'DELETE FROM sales.people WHERE TRUE' }).expect(422)).body).toMatchObject({ kind: 'write' });
    expect((await post(`/api/admin/connections/${conn.id}/query`, { query: "SELECT * FROM EXTERNAL_QUERY('x', 'SELECT 1')" }).expect(422)).body).toMatchObject({ kind: 'denied' });
  });
});
