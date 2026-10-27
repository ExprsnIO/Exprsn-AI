/*
 * 1.9.0: Prometheus connections. The PromQL classifier (every selector names an allow-listed metric; ranges capped;
 * JSON requests with times), the driver against an in-process fake HTTP API (instant and range queries with the step
 * raised to the point cap, label values and metadata for the schema, build info, errors, authentication), and the
 * connection end to end through the admin API.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ConnectionSpec } from '../src/connections/drivers.js';
import { classifyPrometheus, nameRegexObjects, PrometheusDriver, promDuration, promqlObjects, promRows, promTime } from '../src/connections/prometheus.js';
import { parseAllowList } from '../src/mcp/hosts.js';
import { localUser, loginAdmin, type Harness } from './helpers.js';
import { harnessWith } from './retrieval-seed.js';

const ctx = { database: null, options: { defaultRange: '1h', maxPoints: 100 } };
const cls = (q: string) => classifyPrometheus(q, null, ctx);

describe('PromQL classification', () => {
  it('finds every metric a query reads', () => {
    expect(cls('up')).toMatchObject({ kind: 'read', verb: 'QUERY', objects: ['up'], op: { kind: 'instant', query: 'up' } });
    expect(cls('sum by (job, instance) (rate(http_requests_total{job="api", code=~"5.."}[5m])) / ignoring(code) group_left sum(rate(http_requests_total[5m]))').objects).toEqual(['http_requests_total']);
    expect(cls('rate(node_cpu_seconds_total{mode!="idle"}[5m]) * on(instance) group_left(nodename) node_uname_info').objects).toEqual(['node_cpu_seconds_total', 'node_uname_info']);
    expect(cls('{__name__="up", job="x"}').objects).toEqual(['up']);
    expect(cls('{__name__=~"node_cpu.*"}').objects).toEqual(['node_cpu*']);
    expect(cls('{__name__=~"up|scrape_duration_seconds"}').objects).toEqual(['up', 'scrape_duration_seconds']);
    expect(cls('{"http.server.duration", le="1"}').objects).toEqual(['http.server.duration']);
    expect(cls('max_over_time(up[1h:5m]) offset 1d @ end()').objects).toEqual(['up']);
    expect(cls('histogram_quantile(0.9, sum by (le) (rate(req_bucket[5m]))) > bool 0.5').objects).toEqual(['req_bucket']);
    expect(cls('label_replace(up, "dst", "$1", "src", "(.*)")').objects).toEqual(['up']);
  });

  it('refuses selectors without a metric, unreadable regexes, long ranges and long queries', () => {
    expect(cls('{job="api"}')).toMatchObject({ kind: 'denied', reason: expect.stringMatching(/name the metric/) });
    expect(cls('{__name__!="up"}')).toMatchObject({ kind: 'denied' });
    expect(cls('{__name__=~".*"}')).toMatchObject({ kind: 'denied', reason: expect.stringMatching(/cannot be checked/) });
    expect(cls('{__name__=~"(up|.*secret.*)"}')).toMatchObject({ kind: 'denied' });
    expect(cls('rate(up[45d])')).toMatchObject({ kind: 'denied', denied: '45d' });
    expect(cls('max_over_time(up[60d:1h])')).toMatchObject({ kind: 'denied' });
    expect(cls(`up + ${'x'.repeat(10_001)}`)).toMatchObject({ kind: 'denied', denied: 'length' });
    expect(cls('up; drop')).toMatchObject({ kind: 'unparsed' });
    expect(cls('rate(up[5m]')).toMatchObject({ kind: 'unparsed' });
    expect(cls('vector(1)')).toMatchObject({ kind: 'unparsed' });
    expect(cls('{job="a"')).toMatchObject({ kind: 'unparsed' });
  });

  it('reads JSON requests: ranges, instants and their times', () => {
    expect(cls('{"query": "up", "start": "now-2h", "end": "now", "step": "1m"}')).toMatchObject({ kind: 'read', verb: 'QUERY_RANGE', op: { kind: 'range', query: 'up', start: 'now-2h', end: 'now', step: '1m' } });
    expect(cls('{"query": "up", "time": "2026-10-01T00:00:00Z"}')).toMatchObject({ kind: 'read', op: { kind: 'instant', time: '2026-10-01T00:00:00Z' } });
    expect(cls('{"query": "up", "start": "now-40d"}')).toMatchObject({ kind: 'denied', denied: 'range' });
    expect(cls('{"query": "up", "start": "yesterday"}')).toMatchObject({ kind: 'unparsed' });
    expect(cls('{"query": "up", "start": "now", "end": "now-1h"}')).toMatchObject({ kind: 'unparsed' });
    expect(cls('{"query": "up", "step": "fast"}')).toMatchObject({ kind: 'unparsed' });
    expect(cls('{"query": "up", "admin": true}')).toMatchObject({ kind: 'unparsed' });
    expect(cls('{"query": "{job=\\"x\\"}"}')).toMatchObject({ kind: 'denied' });
  });

  it('parses durations, times, regexes and answers', () => {
    expect(promDuration('1h30m')).toBe(5_400_000);
    expect(promDuration('5x')).toBeNull();
    expect(promTime('now-1h', 10_000_000)).toBe(6_400_000);
    expect(promTime(1700000000)).toBe(1_700_000_000_000);
    expect(promTime('2026-10-01T00:00:00Z')).toBe(Date.parse('2026-10-01T00:00:00Z'));
    expect(nameRegexObjects('^(a|b)$')).toEqual(['a', 'b']);
    expect(nameRegexObjects('a.+')).toBeNull();
    expect(promqlObjects('sum(up)')).toEqual({ objects: ['up'] });
    expect(promRows({ resultType: 'scalar', result: [1700000000, '2'] })).toEqual({ columns: ['time', 'value'], rows: [['2023-11-14T22:13:20.000Z', 2]], total: 1 });
    expect(promRows({ resultType: 'vector', result: [{ metric: { job: 'a', __name__: 'up' }, value: [1700000000, 'NaN'] }] }).rows[0]).toEqual(['up', 'a', '2023-11-14T22:13:20.000Z', 'NaN']);
  });
});

/** A small Prometheus HTTP API. */
class FakeProm {
  server!: Server;
  url = '';
  seen: { path: string; query: Record<string, string>; auth: string | undefined }[] = [];

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      const q = Object.fromEntries(u.searchParams);
      this.seen.push({ path: u.pathname, query: q, auth: req.headers.authorization });
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization && req.headers.authorization !== 'Bearer prom-token' && req.headers.authorization !== `Basic ${Buffer.from('reader:pw').toString('base64')}`) return send(401, { status: 'error', errorType: 'unauthorized', error: 'bad credentials' });
      switch (u.pathname) {
        case '/api/v1/status/buildinfo':
          return send(200, { status: 'success', data: { version: '3.1.0' } });
        case '/api/v1/label/__name__/values':
          return send(200, { status: 'success', data: ['up', 'http_requests_total', 'secret_metric'] });
        case '/api/v1/metadata':
          return send(200, { status: 'success', data: { up: [{ type: 'gauge', help: 'Target up', unit: '' }], http_requests_total: [{ type: 'counter', help: 'Requests', unit: 'requests' }] } });
        case '/api/v1/query':
          if (q.query === 'boom') return send(400, { status: 'error', errorType: 'bad_data', error: 'parse error' });
          return send(200, { status: 'success', data: { resultType: 'vector', result: [{ metric: { __name__: 'up', job: 'api', instance: 'a:9090' }, value: [1700000000, '1'] }, { metric: { __name__: 'up', job: 'db', instance: 'b:9090' }, value: [1700000000, '0'] }] } });
        case '/api/v1/query_range': {
          const start = Number(q.start);
          const step = Number(q.step);
          const points = Math.floor((Number(q.end) - start) / step) + 1;
          return send(200, { status: 'success', data: { resultType: 'matrix', result: [{ metric: { __name__: 'up', job: 'api' }, values: Array.from({ length: Math.min(points, 500) }, (_, i) => [start + i * step, String(i % 2)]) }] } });
        }
        default:
          return send(404, { status: 'error', errorType: 'not_found', error: 'no such path' });
      }
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

describe('Prometheus driver', () => {
  let p: FakeProm;
  beforeAll(async () => {
    p = await new FakeProm().start();
  });
  afterAll(async () => p.stop());
  beforeEach(() => {
    p.seen = [];
  });
  const spec = (over: Partial<ConnectionSpec> = {}): ConnectionSpec => ({ engine: 'prometheus', endpoint: p.url, database: null, tls: false, username: null, password: null, options: { defaultRange: '1h', maxPoints: 100 }, ...over });
  const driver = (over: Partial<ConnectionSpec> = {}) => new PrometheusDriver(spec(over), parseAllowList(''));

  it('tests, introspects and runs instant and range queries', async () => {
    expect(await driver().test(5000)).toMatchObject({ version: 'Prometheus 3.1.0', readOnly: true, health: 'healthy' });
    const schema = await driver().introspect(5000);
    expect(schema.find((o) => o.name === 'http_requests_total')).toEqual({ name: 'http_requests_total', kind: 'metric', columns: [{ name: 'value', type: 'counter' }, { name: 'unit', type: 'requests' }] });
    expect(schema.find((o) => o.name === 'secret_metric')!.columns).toEqual([{ name: 'value', type: 'untyped' }]);

    const inst = await driver().query(cls('up'), 'up', { limit: 1, timeoutMs: 5000 });
    expect(inst).toEqual({ columns: ['__name__', 'instance', 'job', 'time', 'value'], rows: [['up', 'a:9090', 'api', '2023-11-14T22:13:20.000Z', 1]], capped: true, estimate: 2 });
    expect(p.seen.at(-1)!.query).toMatchObject({ query: 'up', timeout: '5s' });

    // 2 hours at a 1s step would be 7,201 points: the step grows so at most 100 come back.
    const range = await driver().query(cls('{"query": "up", "start": "now-2h", "end": "now", "step": "1s"}'), '', { limit: 1000, timeoutMs: 5000 });
    const sent = p.seen.at(-1)!;
    expect(sent.path).toBe('/api/v1/query_range');
    expect(Number(sent.query.step)).toBe(72);
    expect(range.rows.length).toBeLessThanOrEqual(101);
    expect(range.columns).toEqual(['__name__', 'job', 'time', 'value']);
  });

  it('sends basic or bearer authentication, and reports errors', async () => {
    await driver({ username: 'reader', password: 'pw' }).test(5000);
    expect(p.seen.at(-1)!.auth).toBe(`Basic ${Buffer.from('reader:pw').toString('base64')}`);
    await driver({ password: 'prom-token' }).test(5000);
    expect(p.seen.at(-1)!.auth).toBe('Bearer prom-token');
    await expect(driver({ password: 'wrong' }).introspect(5000)).rejects.toThrow(/Prometheus 401: unauthorized: bad credentials/);
    await expect(driver().query({ kind: 'read', verb: 'QUERY', objects: ['boom'], op: { kind: 'instant', query: 'boom' } }, '', { limit: 10, timeoutMs: 5000 })).rejects.toThrow(/bad_data: parse error/);
    await expect(driver({ endpoint: 'http://8.8.8.8:9090' }).test(2000)).rejects.toThrow(/public address/);
  });
});

describe('Prometheus connections through the API', () => {
  let h: Harness;
  let p: FakeProm;
  beforeEach(async () => {
    p = await new FakeProm().start();
    h = await harnessWith({}, { OLLAMA_POLL_MS: '600000' });
  });
  afterEach(async () => {
    await h.close();
    await p.stop();
  });

  it('registers, tests, lists metrics, and runs only allow-listed reads', async () => {
    await localUser(h, 'promadmin', ['connection-admin', 'member'], 'confidential');
    const a = await loginAdmin(h, 'promadmin');
    const post = (path: string, b: object = {}) => a.agent.post(path).set('x-csrf-token', a.csrf).send(b);
    const put = (path: string, b: object) => a.agent.put(path).set('x-csrf-token', a.csrf).send(b);
    const conn = (await post('/api/admin/connections', { name: 'metrics', engine: 'prometheus', endpoint: p.url, zone: 'data', label: 'internal', options: { maxPoints: 50 } }).expect(201)).body;
    expect(conn).toMatchObject({ engine: 'prometheus', family: 'timeseries', options: { defaultRange: '1h', maxPoints: 50 } });
    expect((await post(`/api/admin/connections/${conn.id}/test`).expect(200)).body).toMatchObject({ ok: true, version: 'Prometheus 3.1.0', readOnly: true });
    expect((await post(`/api/admin/connections/${conn.id}/schema`).expect(200)).body).toMatchObject({ objects: 3 });
    await put(`/api/admin/connections/${conn.id}/allow-list`, { objects: ['up', 'http_*'] }).expect(200);
    const r = (await post(`/api/admin/connections/${conn.id}/query`, { query: 'sum by (job) (up)' }).expect(200)).body;
    expect(r).toMatchObject({ columns: ['__name__', 'instance', 'job', 'time', 'value'], label: 'internal' });
    expect(r.rows).toHaveLength(2);
    const before = p.seen.length;
    expect((await post(`/api/admin/connections/${conn.id}/query`, { query: 'secret_metric' }).expect(422)).body.title).toBe('Object outside the allow-list');
    expect((await post(`/api/admin/connections/${conn.id}/query`, { query: '{job="api"}' }).expect(422)).body.title).toBe('Object outside the allow-list');
    expect((await post(`/api/admin/connections/${conn.id}/query`, { query: 'rate(up[5m]', confirmUnparsed: true }).expect(422)).body.title).toBe('Request refused');
    expect(p.seen.length).toBe(before); // nothing refused reached Prometheus
    expect((await post(`/api/admin/connections/${conn.id}/query`, { query: '{__name__=~"http_.*"}' }).expect(200)).body.rows.length).toBe(2);
  });
});
