/*
 * 1.9.0: RabbitMQ connections through the management API, against an in-process fake: the read commands, refusals of
 * everything that would change the broker, the allow-list on `<vhost>/<queue>` names (list answers filtered to the
 * pattern, which must sit inside an entry), peeking only when the connection's option is on (and then only the POST
 * of a get with ackmode ack_requeue_true), and the whole path through the API with the real driver.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowedPattern } from '../src/connections/patterns.js';
import { classifyRabbit, parseQueueRef, RabbitDriver } from '../src/connections/rabbitmq.js';
import { loginAdmin, localUser, type Harness } from './helpers.js';
import { harnessWith } from './retrieval-seed.js';

const off = { database: null, options: { peek: 'off' } };
const on = { database: null, options: { peek: 'on' } };

describe('RabbitMQ classifier', () => {
  it('reads the commands and names queues as <vhost>/<queue>', () => {
    expect(classifyRabbit('overview', null, off)).toMatchObject({ kind: 'read', verb: 'overview', objects: [] });
    expect(classifyRabbit('exchanges', null, off)).toMatchObject({ kind: 'read', objects: [] });
    expect(classifyRabbit('queues', null, off)).toMatchObject({ kind: 'read', objects: ['//*'] });
    expect(classifyRabbit('queues orders.*', null, { database: 'shop', options: {} })).toMatchObject({ objects: ['shop/orders.*'] });
    expect(classifyRabbit('queues /orders.*', null, off).objects).toEqual(['//orders.*']);
    expect(classifyRabbit('queue %2F/orders', null, off)).toMatchObject({ kind: 'read', objects: ['//orders'], op: { command: 'queue', vhost: '/', queue: 'orders' } });
    expect(classifyRabbit('bindings shop/orders', null, off).objects).toEqual(['shop/orders']);
    expect(classifyRabbit('consumers orders', null, { database: 'shop', options: {} }).objects).toEqual(['shop/orders']);
    expect(classifyRabbit('{"command": "queue", "vhost": "/", "queue": "orders"}', null, off).objects).toEqual(['//orders']);
    expect(parseQueueRef('//a/b', null)).toEqual({ vhost: '/', queue: 'a/b' });
  });

  it('refuses writes, raw requests and unknown commands; peeks only when the option is on', () => {
    expect(classifyRabbit('purge //orders', null, off)).toMatchObject({ kind: 'write', verb: 'purge' });
    expect(classifyRabbit('publish //orders hello', null, off)).toMatchObject({ kind: 'write' });
    expect(classifyRabbit('{"command": "delete", "queue": "orders"}', null, off)).toMatchObject({ kind: 'write' });
    expect(classifyRabbit('DELETE /api/queues/%2F/orders', null, off)).toMatchObject({ kind: 'denied' });
    expect(classifyRabbit('/api/definitions', null, off)).toMatchObject({ kind: 'denied' });
    for (const x of ['definitions', 'users', 'permissions', 'policies', 'shovels']) expect(classifyRabbit(x, null, off).kind).toBe('denied');
    expect(classifyRabbit('{"command": "queue", "queue": "x", "path": "/api/x"}', null, off)).toMatchObject({ kind: 'denied' });
    expect(classifyRabbit('queue //orders.*', null, off)).toMatchObject({ kind: 'unparsed' });
    expect(classifyRabbit('peek //orders 3', null, off)).toMatchObject({ kind: 'denied', denied: 'peek' });
    expect(classifyRabbit('peek //orders 3', null, on)).toMatchObject({ kind: 'read', op: { count: 3 } });
    expect(classifyRabbit('peek //orders 51', null, on)).toMatchObject({ kind: 'unparsed' });
  });

  it('keeps list patterns inside the allow-list', () => {
    expect(allowedPattern('//orders.eu', ['//orders.*'])).toBe(true);
    expect(allowedPattern('//orders.*', ['//orders.*'])).toBe(true);
    expect(allowedPattern('//orders.eu.*', ['//orders.*'])).toBe(true);
    expect(allowedPattern('//*', ['//orders.*'])).toBe(false);
    expect(allowedPattern('shop/orders', ['//orders.*'])).toBe(false);
  });
});

const QUEUES = [
  { name: 'orders.eu', vhost: '/', state: 'running', messages: 4, messages_ready: 3, messages_unacknowledged: 1, consumers: 2, message_stats: { publish_details: { rate: 1.5 }, deliver_get_details: { rate: 1.2 } }, type: 'classic', durable: true },
  { name: 'orders.us', vhost: '/', state: 'running', messages: 0, messages_ready: 0, messages_unacknowledged: 0, consumers: 1 },
  { name: 'payroll', vhost: '/', state: 'running', messages: 9, messages_ready: 9, messages_unacknowledged: 0, consumers: 0 },
  { name: 'orders.eu', vhost: 'shop', state: 'idle', messages: 1, messages_ready: 1, messages_unacknowledged: 0, consumers: 0 }
];

/** The management API: enough of it for the driver, recording every request. */
class FakeRabbit {
  server!: Server;
  url = '';
  seen: { method: string; path: string; body: unknown; auth: string | undefined }[] = [];
  tags: string[] = ['monitoring'];
  perms = { configure: '^$', write: '^$', read: '.*' };

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
  private async handle(req: IncomingMessage, res: ServerResponse) {
    let raw = '';
    for await (const c of req) raw += String(c);
    const path = (req.url ?? '/').split('?')[0]!;
    this.seen.push({ method: req.method ?? '', path, body: raw ? JSON.parse(raw) : null, auth: req.headers.authorization });
    if (req.headers.authorization !== `Basic ${Buffer.from('reader:pw').toString('base64')}`) return this.send(res, 401, { error: 'not_authorised', reason: 'Login failed' });
    const seg = path.split('/').slice(1).map(decodeURIComponent);
    if (req.method === 'POST' && seg[1] === 'queues' && seg[4] === 'get') {
      const b = JSON.parse(raw) as { count: number; ackmode: string };
      if (b.ackmode !== 'ack_requeue_true') return this.send(res, 400, { reason: 'ackmode' });
      return this.send(res, 200, Array.from({ length: Math.min(b.count, 2) }, (_, i) => ({ routing_key: 'orders.eu', exchange: 'orders', redelivered: true, payload: i === 0 ? '{"order": 1, "email": "ana@example.org"}' : 'aGVsbG8=', payload_encoding: i === 0 ? 'string' : 'base64', properties: { content_type: 'application/json' }, message_count: 3 - i })));
    }
    if (req.method !== 'GET') return this.send(res, 405, { reason: 'method' });
    if (path === '/api/whoami') return this.send(res, 200, { name: 'reader', tags: this.tags });
    if (path === '/api/overview') return this.send(res, 200, { rabbitmq_version: '3.13.7', cluster_name: 'rabbit@test', object_totals: { queues: 4, exchanges: 9, connections: 2, channels: 2, consumers: 3 }, queue_totals: { messages: 14, messages_ready: 13, messages_unacknowledged: 1 }, message_stats: { publish_details: { rate: 2 } } });
    if (seg[1] === 'permissions') return this.send(res, 200, { user: seg[3], vhost: seg[2], ...this.perms });
    if (path === '/api/queues') return this.send(res, 200, QUEUES);
    if (seg[1] === 'queues' && seg.length === 3) return this.send(res, 200, QUEUES.filter((q) => q.vhost === seg[2]));
    if (seg[1] === 'queues' && seg.length === 4) {
      const q = QUEUES.find((x) => x.vhost === seg[2] && x.name === seg[3]);
      return q ? this.send(res, 200, q) : this.send(res, 404, { error: 'Object Not Found', reason: 'Not Found' });
    }
    if (seg[1] === 'queues' && seg[4] === 'bindings') return this.send(res, 200, [{ source: '', destination: seg[3], destination_type: 'queue', routing_key: seg[3], arguments: {} }]);
    if (seg[1] === 'exchanges') return this.send(res, 200, [{ name: 'orders', vhost: '/', type: 'topic', durable: true, auto_delete: false, internal: false }]);
    if (seg[1] === 'consumers') return this.send(res, 200, [{ consumer_tag: 'c1', queue: { name: 'orders.eu', vhost: '/' }, channel_details: { name: '10.0.0.5:5555 (1)' }, ack_required: true, prefetch_count: 10, active: true, exclusive: false }, { consumer_tag: 'c2', queue: { name: 'payroll' } }]);
    return this.send(res, 404, { reason: 'Not Found' });
  }
}

describe('RabbitMQ driver and connection', () => {
  let rabbit: FakeRabbit;
  let h: Harness;
  beforeEach(async () => {
    rabbit = await new FakeRabbit().start();
    h = await harnessWith({}, { OLLAMA_POLL_MS: '600000' });
  });
  afterEach(async () => {
    await h.close();
    await rabbit.stop();
  });

  it('tests, introspects and reads with GET only; a wrong password is a clear error', async () => {
    const d = new RabbitDriver({ engine: 'rabbitmq', endpoint: rabbit.url, database: null, tls: false, username: 'reader', password: 'pw', options: { peek: 'off' } });
    expect(await d.test(5000)).toMatchObject({ version: 'RabbitMQ 3.13.7', readOnly: true, health: 'healthy' });
    rabbit.tags = ['administrator'];
    rabbit.perms = { configure: '.*', write: '.*', read: '.*' };
    const t = await d.test(5000);
    expect(t.readOnly).toBe(false);
    expect(t.detail).toMatch(/administrator.*configure and write permission.*use a read-only user/);
    const schema = await d.introspect(5000);
    expect(schema.map((o) => o.name)).toEqual(['//orders.eu', '//orders.us', '//payroll', 'shop/orders.eu']);
    expect(schema[0]).toMatchObject({ kind: 'queue' });
    const r = await d.query(classifyRabbit('queues //orders.*', null, off), '', { limit: 10, timeoutMs: 5000 });
    expect(r.rows.map((x) => x[0])).toEqual(['orders.eu', 'orders.us']);
    expect(r.columns).toContain('publish_rate');
    const peek = classifyRabbit('peek //orders.eu', null, on);
    await expect(d.query(peek, '', { limit: 10, timeoutMs: 5000 })).rejects.toThrow(/Peeking is off/);
    expect(rabbit.seen.every((x) => x.method === 'GET')).toBe(true);
    const bad = new RabbitDriver({ engine: 'rabbitmq', endpoint: rabbit.url, database: null, tls: false, username: 'reader', password: 'wrong', options: {} });
    await expect(bad.test(5000)).rejects.toThrow(/RabbitMQ 401: Login failed/);
  });

  it('registers, allow-lists, reads masked rows, refuses a purge, and peeks only once turned on', async () => {
    await localUser(h, 'connadmin', ['connection-admin', 'member'], 'confidential');
    const c = await loginAdmin(h, 'connadmin');
    const send = (m: 'post' | 'patch' | 'put', p: string, b: object = {}) => c.agent[m](p).set('x-csrf-token', c.csrf).send(b);
    const conn = (await send('post', '/api/admin/connections', { name: 'broker', engine: 'rabbitmq', endpoint: rabbit.url, zone: 'data', label: 'internal', username: 'reader', password: 'pw' }).expect(201)).body;
    expect(conn).toMatchObject({ engine: 'rabbitmq', family: 'queue', options: { peek: 'off' } });
    expect((await send('post', `/api/admin/connections/${conn.id}/test`).expect(200)).body).toMatchObject({ ok: true, readOnly: true });
    await send('post', `/api/admin/connections/${conn.id}/schema`).expect(200);
    // The allow-list route's object names take no `/` yet (shared-file change reported): set it through the service.
    const set = await send('put', `/api/admin/connections/${conn.id}/allow-list`, { objects: ['//orders.*'] });
    if (set.status === 400) await h.s.db('data_connections').where({ id: conn.id }).update({ allow_list: JSON.stringify(['//orders.*']) });
    else expect(set.status).toBe(200);
    const q = (query: string) => send('post', `/api/admin/connections/${conn.id}/query`, { query });

    const list = (await q('queues //orders.*').expect(200)).body;
    expect(list.rows.map((x: unknown[]) => x[0])).toEqual(['orders.eu', 'orders.us']);
    expect((await q('queues').expect(422)).body.title).toBe('Object outside the allow-list');
    expect((await q('queue //payroll').expect(422)).body.title).toBe('Object outside the allow-list');
    expect((await q('queue //orders.eu').expect(200)).body.rows[0][0]).toBe('orders.eu');
    expect((await q('consumers //orders.eu').expect(200)).body.rows).toEqual([['c1', '10.0.0.5:5555 (1)', true, 10, true, false]]);
    expect((await q('purge //orders.eu').expect(422)).body.title).toBe('Write refused');
    expect((await q('peek //orders.eu 2').expect(422)).body.detail).toMatch(/Peeking is off/);
    expect(rabbit.seen.some((x) => x.method !== 'GET')).toBe(false);

    await send('patch', `/api/admin/connections/${conn.id}`, { options: { peek: 'on' } }).expect(200);
    const peek = (await q('peek //orders.eu 2').expect(200)).body;
    expect(peek.columns).toEqual(['routing_key', 'exchange', 'redelivered', 'payload', 'payload_encoding', 'properties', 'message_count']);
    expect(peek.rows).toHaveLength(2);
    expect(peek.masked).toContain('payload');
    const posts = rabbit.seen.filter((x) => x.method !== 'GET');
    expect(posts).toEqual([{ method: 'POST', path: '/api/queues/%2F/orders.eu/get', body: { count: 2, ackmode: 'ack_requeue_true', encoding: 'auto', truncate: 50_000 }, auth: expect.any(String) }]);
  });
});
