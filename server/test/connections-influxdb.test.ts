/*
 * 1.9.0: InfluxDB connections. The InfluxQL classifier (SELECT without INTO, schema SHOW statements, tag values and
 * series only FROM named measurements, writes and administration refused, measurements from FROM, anchored regexes as
 * globs, the connection's own database), v3 SQL through the SQL classifier, JSON requests with bound parameters, the
 * driver against an in-process fake of the v1, v2 and v3 APIs, and the connection end to end through the admin API.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ConnectionSpec } from '../src/connections/drivers.js';
import { classifyInflux, classifyInfluxQL, InfluxDriver, measurementRegexObjects, seriesRows } from '../src/connections/influxdb.js';
import { parseAllowList } from '../src/mcp/hosts.js';
import { localUser, loginAdmin, type Harness } from './helpers.js';
import { harnessWith } from './retrieval-seed.js';

const ql = (q: string) => classifyInfluxQL(q, 'telemetry');

describe('InfluxQL classification', () => {
  it('reads SELECT, EXPLAIN and the schema SHOW statements, with their measurements', () => {
    expect(ql('SELECT mean("usage_idle") FROM "cpu" WHERE time > now() - 1h GROUP BY time(5m), host fill(null)')).toMatchObject({ kind: 'read', verb: 'SELECT', objects: ['cpu'] });
    expect(ql('SELECT * FROM cpu, mem LIMIT 10').objects).toEqual(['cpu', 'mem']);
    expect(ql('SELECT * FROM telemetry.autogen.cpu').objects).toEqual(['cpu']);
    expect(ql('SELECT * FROM telemetry..cpu').objects).toEqual(['cpu']);
    expect(ql('SELECT * FROM autogen."disk.io"').objects).toEqual(['disk.io']);
    expect(ql('SELECT * FROM /^cpu/').objects).toEqual(['cpu*']);
    expect(ql('SELECT * FROM /^(cpu|mem)$/').objects).toEqual(['cpu', 'mem']);
    expect(ql('SELECT max(m) FROM (SELECT mean(v) AS m FROM sensors GROUP BY time(1m)), other').objects).toEqual(['sensors', 'other']);
    expect(ql('SELECT a / b FROM cpu WHERE host =~ /web.*/').objects).toEqual(['cpu']);
    expect(ql('EXPLAIN ANALYZE SELECT * FROM cpu')).toMatchObject({ kind: 'read', verb: 'EXPLAIN', objects: ['cpu'] });
    expect(ql('SHOW MEASUREMENTS')).toMatchObject({ kind: 'read', verb: 'SHOW MEASUREMENTS', objects: [] });
    expect(ql('SHOW FIELD KEYS FROM cpu')).toMatchObject({ kind: 'read', verb: 'SHOW FIELD KEYS', objects: ['cpu'] });
    expect(ql('SHOW TAG VALUES FROM cpu WITH KEY = "host"')).toMatchObject({ kind: 'read', objects: ['cpu'] });
    expect(ql("SELECT * FROM cpu WHERE host = 'DROP TABLE' -- INTO x")).toMatchObject({ kind: 'read', objects: ['cpu'] });
  });

  it('refuses writes, administration, data SHOWs without FROM, other databases and loose regexes', () => {
    expect(ql('SELECT * INTO copy FROM cpu')).toMatchObject({ kind: 'write', verb: 'SELECT INTO' });
    expect(ql('DELETE FROM cpu WHERE time < now() - 1d')).toMatchObject({ kind: 'write', verb: 'DELETE' });
    expect(ql('DROP MEASUREMENT cpu')).toMatchObject({ kind: 'ddl', verb: 'DROP' });
    expect(ql('CREATE DATABASE x')).toMatchObject({ kind: 'ddl' });
    expect(ql('GRANT ALL TO bob')).toMatchObject({ kind: 'ddl' });
    expect(ql('KILL QUERY 3')).toMatchObject({ kind: 'ddl' });
    expect(ql("SET PASSWORD FOR bob = 'x'")).toMatchObject({ kind: 'ddl' });
    expect(ql('SHOW USERS')).toMatchObject({ kind: 'denied', verb: 'SHOW USERS' });
    expect(ql('SHOW QUERIES')).toMatchObject({ kind: 'denied' });
    expect(ql('SHOW TAG VALUES WITH KEY = "host"')).toMatchObject({ kind: 'denied', reason: expect.stringMatching(/name them with FROM/) });
    expect(ql('SHOW SERIES')).toMatchObject({ kind: 'denied' });
    expect(ql('SELECT * FROM other.autogen.cpu')).toMatchObject({ kind: 'denied', denied: 'other.autogen.cpu' });
    expect(ql('SELECT * FROM /cpu/')).toMatchObject({ kind: 'denied' });
    expect(ql('SELECT * FROM /^c.u$/')).toMatchObject({ kind: 'denied' });
    expect(ql('SELECT * FROM cpu; DROP DATABASE telemetry')).toMatchObject({ kind: 'multiple' });
    expect(ql('SELECT 1')).toMatchObject({ kind: 'unparsed' });
    expect(ql("SELECT * FROM cpu WHERE a = 'x")).toMatchObject({ kind: 'unparsed' });
  });

  it('reads JSON with parameters, and v3 SQL through the SQL classifier', () => {
    const v2 = { database: 'telemetry', options: { version: 'v2' } };
    expect(classifyInflux('{"query": "SELECT * FROM cpu WHERE host = $host", "params": {"host": "web-1"}}', null, v2)).toMatchObject({ kind: 'read', objects: ['cpu'], op: { lang: 'influxql', query: 'SELECT * FROM cpu WHERE host = $host', params: { host: 'web-1' } } });
    expect(classifyInflux('{"query": "SELECT * FROM cpu", "params": {"host": {"$ne": 1}}}', null, v2)).toMatchObject({ kind: 'unparsed' });
    expect(classifyInflux('{"query": "SELECT * FROM cpu", "db": "other"}', null, v2)).toMatchObject({ kind: 'unparsed' });
    const sql = { database: 'telemetry', options: { version: 'v3', language: 'sql' } };
    expect(classifyInflux('SELECT host, avg(usage) FROM iox.cpu GROUP BY host', null, sql)).toMatchObject({ kind: 'read', objects: ['cpu'], op: { lang: 'sql' } });
    expect(classifyInflux('DELETE FROM cpu', null, sql)).toMatchObject({ kind: 'write' });
    // v3 with InfluxQL stays InfluxQL.
    expect(classifyInflux('SELECT * FROM cpu', null, { database: 'telemetry', options: { version: 'v3', language: 'influxql' } })).toMatchObject({ op: { lang: 'influxql' } });
  });

  it('turns regexes into globs and series into rows', () => {
    expect(measurementRegexObjects('^cpu.*$')).toEqual(['cpu*']);
    expect(measurementRegexObjects('^cpu$')).toEqual(['cpu']);
    expect(measurementRegexObjects('cpu')).toBeNull();
    expect(seriesRows([{ name: 'cpu', tags: { host: 'a' }, columns: ['time', 'v'], values: [[1700000000000, 1]] }, { name: 'mem', tags: { host: 'b', dc: 'x' }, columns: ['time', 'w'], values: [[1700000000000, 2]] }])).toEqual({
      columns: ['measurement', 'dc', 'host', 'time', 'v', 'w'],
      rows: [
        ['cpu', null, 'a', '2023-11-14T22:13:20.000Z', 1, null],
        ['mem', 'x', 'b', '2023-11-14T22:13:20.000Z', null, 2]
      ]
    });
  });
});

/** A small InfluxDB: v1 and v2 /query, v3 query_sql and query_influxql, ping. */
class FakeInflux {
  server!: Server;
  url = '';
  admin = false;
  seen: { path: string; method: string; q: string; db: string | null; auth: string | undefined; params: unknown }[] = [];

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const u = new URL(req.url ?? '/', 'http://x');
        const body = raw ? (JSON.parse(raw) as { db?: string; q?: string; params?: unknown }) : {};
        const q = u.searchParams.get('q') ?? body.q ?? '';
        this.seen.push({ path: u.pathname, method: req.method ?? '', q, db: u.searchParams.get('db') ?? body.db ?? null, auth: req.headers.authorization, params: u.searchParams.get('params') ? JSON.parse(u.searchParams.get('params')!) : body.params });
        const send = (status: number, b: unknown, headers: Record<string, string> = {}) => {
          res.writeHead(status, { 'content-type': 'application/json', ...headers });
          res.end(b === undefined ? '' : JSON.stringify(b));
        };
        const okAuth = [`Basic ${Buffer.from('reader:pw').toString('base64')}`, 'Token v2-token', 'Bearer v3-token'];
        if (u.pathname === '/ping') return u.searchParams.has('v3') ? send(200, { version: '3.0.1' }) : send(204, undefined, { 'x-influxdb-version': '1.11.8' });
        if (!okAuth.includes(req.headers.authorization ?? '')) return send(401, { error: 'authorization failed' });
        if (u.pathname === '/query') {
          if (/^SHOW USERS/.test(q)) return this.admin ? send(200, { results: [{ series: [{ columns: ['user', 'admin'], values: [['reader', true]] }] }] }) : send(200, { results: [{ error: 'error authorizing query: reader not authorized to execute statement \'SHOW USERS\', requires admin privilege' }] });
          if (/^SHOW GRANTS/.test(q)) return send(200, { results: [{ error: 'requires admin privilege' }] });
          if (/^SHOW MEASUREMENTS/.test(q)) return send(200, { results: [{ series: [{ name: 'measurements', columns: ['name'], values: [['cpu'], ['secret']] }] }] });
          if (q === 'SHOW FIELD KEYS') return send(200, { results: [{ series: [{ name: 'cpu', columns: ['fieldKey', 'fieldType'], values: [['usage', 'float']] }, { name: 'secret', columns: ['fieldKey', 'fieldType'], values: [['pin', 'string']] }] }] });
          if (q === 'SHOW TAG KEYS') return send(200, { results: [{ series: [{ name: 'cpu', columns: ['tagKey'], values: [['host']] }] }] });
          if (/FROM cpu/.test(q)) return send(200, { results: [{ series: [{ name: 'cpu', tags: { host: 'web-1' }, columns: ['time', 'usage'], values: [[1700000000000, 12.5], [1700000060000, 13]] }] }] });
          return send(200, { results: [{ error: `unexpected: ${q}` }] });
        }
        if (u.pathname === '/api/v3/query_sql') {
          if (/information_schema\.columns/.test(q)) return send(200, [{ table_name: 'cpu', column_name: 'host', data_type: 'Dictionary(Int32, Utf8)' }, { table_name: 'cpu', column_name: 'usage', data_type: 'Float64' }]);
          if (/information_schema\.tables/.test(q)) return send(200, [{ table_name: 'cpu' }]);
          if (/cpu/.test(q)) return send(200, [{ host: 'web-1', time: '2026-10-01T00:00:00', usage: 12.5 }]);
          return send(400, { error: 'table not found' });
        }
        if (u.pathname === '/api/v3/query_influxql') return send(200, [{ 'iox::measurement': 'cpu', time: '2026-10-01T00:00:00', usage: 1 }]);
        send(404, { error: 'not found' });
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }
}

describe('InfluxDB driver', () => {
  let f: FakeInflux;
  beforeAll(async () => {
    f = await new FakeInflux().start();
  });
  afterAll(async () => f.stop());
  beforeEach(() => {
    f.seen = [];
    f.admin = false;
  });
  const spec = (over: Partial<ConnectionSpec> = {}): ConnectionSpec => ({ engine: 'influxdb', endpoint: f.url, database: 'telemetry', tls: false, username: 'reader', password: 'pw', options: { version: 'v1', retentionPolicy: 'autogen' }, ...over });
  const driver = (over: Partial<ConnectionSpec> = {}) => new InfluxDriver(spec(over), parseAllowList(''));
  const ctxOf = (s: ConnectionSpec) => ({ database: s.database, options: s.options ?? {} });

  it('v1: tests (admin or not), introspects and reads with basic authentication', async () => {
    expect(await driver().test(5000)).toMatchObject({ version: 'InfluxDB 1.11.8', readOnly: true, detail: expect.stringMatching(/not an admin/) });
    f.admin = true;
    expect(await driver().test(5000)).toMatchObject({ readOnly: false, detail: expect.stringMatching(/is an InfluxDB admin/) });
    const schema = await driver().introspect(5000);
    expect(schema).toEqual([
      { name: 'cpu', kind: 'measurement', columns: [{ name: 'usage', type: 'float' }, { name: 'host', type: 'tag' }] },
      { name: 'secret', kind: 'measurement', columns: [{ name: 'pin', type: 'string' }] }
    ]);
    const s = spec();
    const r = await driver().query(classifyInflux('{"query": "SELECT usage FROM cpu WHERE host = $h", "params": {"h": "web-1"}}', null, ctxOf(s)), '', { limit: 1, timeoutMs: 5000 });
    expect(r).toEqual({ columns: ['host', 'time', 'usage'], rows: [['web-1', '2023-11-14T22:13:20.000Z', 12.5]], capped: true, estimate: 2 });
    expect(f.seen.at(-1)).toMatchObject({ path: '/query', db: 'telemetry', params: { h: 'web-1' }, auth: `Basic ${Buffer.from('reader:pw').toString('base64')}` });
  });

  it('v2 sends a token to the compatibility API; v3 reads SQL and InfluxQL with a bearer token', async () => {
    const v2 = spec({ username: null, password: 'v2-token', options: { version: 'v2' } });
    expect(await new InfluxDriver(v2, parseAllowList('')).test(5000)).toMatchObject({ readOnly: true, detail: expect.stringMatching(/read-only token/) });
    expect(f.seen.at(-1)).toMatchObject({ path: '/query', auth: 'Token v2-token' });

    const v3 = spec({ endpoint: f.url, username: null, password: 'v3-token', options: { version: 'v3', language: 'sql' } });
    const d3 = new InfluxDriver(v3, parseAllowList(''));
    expect(await d3.introspect(5000)).toEqual([{ name: 'cpu', kind: 'measurement', columns: [{ name: 'host', type: 'tag' }, { name: 'usage', type: 'Float64' }] }]);
    const r = await d3.query(classifyInflux('SELECT host, usage FROM cpu', null, ctxOf(v3)), '', { limit: 10, timeoutMs: 5000 });
    expect(r.rows).toEqual([['web-1', '2026-10-01T00:00:00', 12.5]]);
    expect(f.seen.at(-1)).toMatchObject({ path: '/api/v3/query_sql', method: 'POST', db: 'telemetry', auth: 'Bearer v3-token' });
    const v3ql = spec({ username: null, password: 'v3-token', options: { version: 'v3', language: 'influxql' } });
    const r2 = await new InfluxDriver(v3ql, parseAllowList('')).query(classifyInflux('SELECT usage FROM cpu', null, ctxOf(v3ql)), '', { limit: 10, timeoutMs: 5000 });
    expect(r2.columns).toEqual(['iox::measurement', 'time', 'usage']);
  });

  it('reports errors without the credential, and keeps to allowed addresses', async () => {
    await expect(driver({ password: 'wrong' }).test(5000)).rejects.toThrow(/InfluxDB 401: authorization failed/);
    const s = spec();
    await expect(driver().query(classifyInflux('SELECT * FROM nothing', null, ctxOf(s)), '', { limit: 10, timeoutMs: 5000 })).rejects.toThrow(/InfluxDB 200: unexpected/);
    await expect(driver({ endpoint: 'http://8.8.8.8:8086' }).test(2000)).rejects.toThrow(/public address/);
  });
});

describe('InfluxDB connections through the API', () => {
  let h: Harness;
  let f: FakeInflux;
  beforeEach(async () => {
    f = await new FakeInflux().start();
    h = await harnessWith({}, { OLLAMA_POLL_MS: '600000' });
  });
  afterEach(async () => {
    await h.close();
    await f.stop();
  });

  it('registers, tests, lists measurements, and runs only allow-listed reads', async () => {
    await localUser(h, 'influxadmin', ['connection-admin', 'member'], 'confidential');
    const a = await loginAdmin(h, 'influxadmin');
    const post = (path: string, b: object = {}) => a.agent.post(path).set('x-csrf-token', a.csrf).send(b);
    const put = (path: string, b: object) => a.agent.put(path).set('x-csrf-token', a.csrf).send(b);
    expect((await post('/api/admin/connections', { name: 'tsdb', engine: 'influxdb', endpoint: f.url, zone: 'data', label: 'internal', username: null, password: 'v2-token' }).expect(409)).body.detail).toMatch(/names the database or bucket it reads/);
    const conn = (await post('/api/admin/connections', { name: 'tsdb', engine: 'influxdb', endpoint: f.url, database: 'telemetry', zone: 'data', label: 'internal', username: null, password: 'v2-token', options: { version: 'v2' } }).expect(201)).body;
    expect(conn).toMatchObject({ family: 'timeseries', options: { version: 'v2', language: 'influxql' } });
    expect((await post(`/api/admin/connections/${conn.id}/test`).expect(200)).body).toMatchObject({ ok: true, readOnly: true });
    expect((await post(`/api/admin/connections/${conn.id}/schema`).expect(200)).body).toMatchObject({ objects: 2 });
    await put(`/api/admin/connections/${conn.id}/allow-list`, { objects: ['cpu'] }).expect(200);
    const r = (await post(`/api/admin/connections/${conn.id}/query`, { query: 'SELECT usage FROM cpu' }).expect(200)).body;
    expect(r).toMatchObject({ columns: ['host', 'time', 'usage'], label: 'internal' });
    const before = f.seen.length;
    expect((await post(`/api/admin/connections/${conn.id}/query`, { query: 'SELECT * FROM secret' }).expect(422)).body.title).toBe('Object outside the allow-list');
    expect((await post(`/api/admin/connections/${conn.id}/query`, { query: 'DROP MEASUREMENT cpu' }).expect(422)).body.title).toBe('DDL refused');
    expect((await post(`/api/admin/connections/${conn.id}/query`, { query: 'SELECT * INTO x FROM cpu' }).expect(422)).body.title).toBe('Write refused');
    expect(f.seen.length).toBe(before);
  });
});
