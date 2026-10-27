/*
 * 2.0.x: schema plans (`applyDdl`) and the Queues tab (`queues`) on the non-SQL drivers, against in-process fakes:
 * MongoDB (and DocumentDB) collections and indexes through the backend seam, DynamoDB CreateTable / UpdateTable /
 * UpdateTimeToLive signed like the reads, Cosmos DB databases and containers with the master-key signature over the
 * right resource type and link, InfluxDB databases (1.x form-POSTed InfluxQL, 3 configure API, 2 refused), Redis
 * XGROUP CREATE and the queue walk (lists, streams with groups, BullMQ, pub/sub, the allow-list), and RabbitMQ
 * declarations, bindings and the queue listing (kinds, dead-letter exchange from a policy, paging, the allow-list).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Document } from 'mongodb';
import { buildPlan, type AdminOp, type DdlPlan } from '../src/connections/ddl.js';
import type { ConnectionSpec } from '../src/connections/drivers.js';
import type { Engine } from '../src/connections/engines.js';
import { MongoDriver, type MongoBackend, type MongoDial } from '../src/connections/mongo.js';
import { MONGO_SERVICES } from '../src/connections/mongo-services.js';
import { DynamoDriver } from '../src/connections/dynamodb.js';
import { CosmosDriver, masterKeyAuth } from '../src/connections/cosmos.js';
import { InfluxDriver } from '../src/connections/influxdb.js';
import { RedisDriver } from '../src/connections/redis.js';
import { RabbitDriver } from '../src/connections/rabbitmq.js';
import { allowedPattern } from '../src/connections/patterns.js';
import type { GuardedRequest, GuardedResponse } from '../src/platform/egress.js';
import { parseAllowList } from '../src/mcp/hosts.js';

const plan = (engine: Engine, raw: unknown, ctx: { database?: string | null; options?: Record<string, unknown> } = {}): DdlPlan => buildPlan(engine, { engine, database: ctx.database ?? null, account: null, options: ctx.options ?? {} }, raw);
const opsPlan = (engine: Engine, ops: AdminOp[]): DdlPlan => ({ engine, kind: 'table', object: 'x', statements: [], ops, transactional: false, touches: [], notes: [], destructive: false, confirmName: null, hash: '' });

// ---------------------------------------------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------------------------------------------

class FakeMongo {
  collections = new Map<string, { options: Document; indexes: { name: string; keys: Document; options: Document }[] }>();
  calls: { op: string; args: unknown[] }[] = [];
  opener = async (_d: MongoDial): Promise<MongoBackend> => ({
    command: async () => ({ ok: 1 }),
    listCollections: async () => [...this.collections.keys()].map((name) => ({ name, type: 'collection' })),
    find: async () => [],
    aggregate: async () => [],
    createCollection: async (name, options, timeoutMs) => {
      this.calls.push({ op: 'createCollection', args: [name, options, timeoutMs] });
      if (this.collections.has(name)) throw new Error(`Collection shop.${name} already exists. (NamespaceExists)`);
      this.collections.set(name, { options, indexes: [] });
    },
    createIndex: async (collection, keys, options, timeoutMs) => {
      this.calls.push({ op: 'createIndex', args: [collection, keys, options, timeoutMs] });
      const c = this.collections.get(collection) ?? { options: {}, indexes: [] };
      this.collections.set(collection, c);
      const name = String(options.name ?? Object.entries(keys).map(([k, v]) => `${k}_${String(v)}`).join('_'));
      const same = c.indexes.find((i) => i.name === name);
      if (same && JSON.stringify(same.options) !== JSON.stringify(options)) throw new Error(`An existing index has the same name as the requested index (IndexOptionsConflict)`);
      c.indexes.push({ name, keys, options });
      return name;
    },
    close: async () => undefined
  });
}

describe('MongoDB schema plans', () => {
  const spec = (over: Partial<ConnectionSpec> = {}): ConnectionSpec => ({ engine: 'mongodb', endpoint: '127.0.0.1:27017', database: 'shop', tls: false, username: 'admin/root', password: 'pw', options: {}, ...over });

  it('creates a collection with its validator, then an index', async () => {
    const f = new FakeMongo();
    const d = new MongoDriver(spec(), parseAllowList(''), f.opener);
    const p = plan('mongodb', { kind: 'collection', name: 'orders', fields: [{ name: '_id', bsonType: 'objectId' }, { name: 'total', bsonType: 'double', required: true }], additionalProperties: false });
    expect(await d.applyDdl(p, 5000)).toMatchObject({ applied: 1, detail: /collection orders/ });
    const opts = f.collections.get('orders')!.options;
    expect(opts).toMatchObject({ validator: { $jsonSchema: { bsonType: 'object', required: ['total'], additionalProperties: false } }, validationLevel: 'strict' });

    const ix = plan('mongodb', { kind: 'index', collection: 'orders', name: 'by_placed', keys: [{ field: 'placedAt', order: -1 }], partialFilter: { total: { $gt: 0 } } });
    expect(await d.applyDdl(ix, 5000)).toMatchObject({ applied: 1, detail: /index by_placed on orders/ });
    const made = f.calls.find((c) => c.op === 'createIndex')!;
    expect(made.args[1]).toEqual({ placedAt: -1 });
    expect(made.args[2]).toEqual({ name: 'by_placed', partialFilterExpression: { total: { $gt: 0 } } });
    // Extended JSON in options is read into BSON values (the builder refuses $date today; the driver copes anyway).
    await d.applyDdl(opsPlan('mongodb', [{ op: 'mongo.createIndex', collection: 'orders', keys: { at: 1 }, options: { name: 'by_at', partialFilterExpression: { at: { $gt: { $date: '2026-01-01T00:00:00Z' } } } } }]), 5000);
    expect(((f.calls.at(-1)!.args[2] as Document).partialFilterExpression as Document).at.$gt).toBeInstanceOf(Date);

    await expect(d.applyDdl(p, 5000)).rejects.toThrow(/collection orders already exists/);
    await expect(d.applyDdl(opsPlan('mongodb', [{ op: 'mongo.createCollection', name: 'system.users', options: {} }]), 5000)).rejects.toThrow(/system collections/);
    await expect(d.applyDdl(opsPlan('mongodb', [{ op: 'redis.xgroupCreate', key: 'k', group: 'g', id: '$', mkstream: true }]), 5000)).rejects.toThrow(/do not perform redis\.xgroupCreate/);
  });

  it('counts the operations applied before a failure, and serves the managed services', async () => {
    const f = new FakeMongo();
    f.collections.set('taken', { options: {}, indexes: [] });
    const d = new MongoDriver(spec({ engine: 'documentdb' }), parseAllowList(''), f.opener, MONGO_SERVICES.documentdb);
    const two = opsPlan('documentdb', [
      { op: 'mongo.createCollection', name: 'fresh', options: {} },
      { op: 'mongo.createCollection', name: 'taken', options: {} }
    ]);
    await expect(d.applyDdl(two, 5000)).rejects.toThrow(/1 of 2 operations were applied before it/);
    expect(f.collections.has('fresh')).toBe(true);
    // A stand-in backend without the schema methods says so instead of failing oddly.
    const bare = new MongoDriver(spec(), parseAllowList(''), async () => ({ command: async () => ({}), listCollections: async () => [], find: async () => [], aggregate: async () => [], close: async () => undefined }));
    await expect(bare.applyDdl(two, 5000)).rejects.toThrow(/cannot create collections/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// DynamoDB and Cosmos DB (through the guarded-send seam)
// ---------------------------------------------------------------------------------------------------------------

const respond = (status: number, body: unknown, headers: Record<string, string> = {}): GuardedResponse => ({ status, contentType: 'application/json', body: Buffer.from(body === undefined ? '' : JSON.stringify(body)), address: '127.0.0.1', headers });

describe('DynamoDB schema plans', () => {
  const spec: ConnectionSpec = { engine: 'dynamodb', endpoint: 'http://127.0.0.1:8000', database: null, tls: false, username: 'AKIDADMIN', password: 'admin-secret', options: { region: 'eu-west-1' } };

  it('signs CreateTable, waits for ACTIVE, then UpdateTimeToLive; UpdateTable for an index', async () => {
    const sent: { target: string; body: Record<string, unknown>; auth: string }[] = [];
    let describes = 0;
    const send = async (r: GuardedRequest) => {
      const target = r.headers['x-amz-target']!;
      const body = JSON.parse(String(r.body)) as Record<string, unknown>;
      sent.push({ target, body, auth: r.headers.authorization ?? r.headers.Authorization ?? '' });
      if (target.endsWith('.DescribeTable')) return respond(200, { Table: { TableName: body.TableName, TableStatus: ++describes < 2 ? 'CREATING' : 'ACTIVE' } });
      if (target.endsWith('.CreateTable')) return respond(200, { TableDescription: { TableStatus: 'CREATING' } });
      if (target.endsWith('.UpdateTimeToLive')) return respond(200, { TimeToLiveSpecification: body.TimeToLiveSpecification });
      if (target.endsWith('.UpdateTable')) return respond(400, { __type: 'com.amazonaws.dynamodb.v20120810#ResourceNotFoundException', message: 'Requested resource not found' });
      return respond(400, { __type: '#UnknownOperationException' });
    };
    const d = new DynamoDriver(spec, parseAllowList(''), send);
    const p = plan('dynamodb', { kind: 'table', name: 'orders', partitionKey: { name: 'pk', type: 'S' }, sortKey: { name: 'sk', type: 'S' }, ttlAttribute: 'expiresAt' });
    expect(p.ops.map((o) => o.op)).toEqual(['dynamodb.createTable', 'dynamodb.updateTimeToLive']);
    expect(await d.applyDdl(p, 10_000)).toMatchObject({ applied: 2, detail: /CREATING/ });
    expect(sent.map((s) => s.target)).toEqual(['DynamoDB_20120810.CreateTable', 'DynamoDB_20120810.DescribeTable', 'DynamoDB_20120810.DescribeTable', 'DynamoDB_20120810.UpdateTimeToLive']);
    expect(sent[0]!.body).toMatchObject({ TableName: 'orders', BillingMode: 'PAY_PER_REQUEST', KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }] });
    expect(sent[3]!.body).toEqual({ TableName: 'orders', TimeToLiveSpecification: { Enabled: true, AttributeName: 'expiresAt' } });
    expect(sent.every((s) => /^AWS4-HMAC-SHA256 Credential=AKIDADMIN\/\d{8}\/eu-west-1\/dynamodb\/aws4_request/.test(s.auth))).toBe(true);

    sent.length = 0;
    const ix = plan('dynamodb', { kind: 'index', table: 'missing', name: 'by_status', partitionKey: { name: 'status', type: 'S' } });
    await expect(d.applyDdl(ix, 5000)).rejects.toThrow(/refused UpdateTable \(ResourceNotFoundException\)/);
    expect(sent[0]!.body).toMatchObject({ TableName: 'missing', GlobalSecondaryIndexUpdates: [{ Create: { IndexName: 'by_status' } }] });
    await expect(d.applyDdl(opsPlan('dynamodb', [{ op: 'cosmos.createDatabase', id: 'x', throughput: null }]), 5000)).rejects.toThrow(/do not perform cosmos\.createDatabase/);
  });

  it('says how far a plan got when a later operation fails', async () => {
    const send = async (r: GuardedRequest) => {
      const target = r.headers['x-amz-target']!;
      if (target.endsWith('.DescribeTable')) return respond(200, { Table: { TableStatus: 'ACTIVE' } });
      if (target.endsWith('.UpdateTimeToLive')) return respond(400, { __type: '#ValidationException', message: 'TimeToLive is already enabled' });
      return respond(200, {});
    };
    const d = new DynamoDriver(spec, parseAllowList(''), send);
    const p = plan('dynamodb', { kind: 'table', name: 'orders', partitionKey: { name: 'pk', type: 'S' }, ttlAttribute: 'exp' });
    await expect(d.applyDdl(p, 5000)).rejects.toThrow(/ValidationException.*1 of 2 operations were applied before it/);
  });
});

describe('Cosmos DB schema plans', () => {
  const key = Buffer.from('cosmos-admin-key-0123456789').toString('base64');
  const spec = (over: Partial<ConnectionSpec> = {}): ConnectionSpec => ({ engine: 'cosmos-nosql', endpoint: 'https://127.0.0.1:8081', database: 'shop', tls: true, username: null, password: key, options: {}, ...over });

  it('creates a database and a container, signed over the right resource type and link', async () => {
    const sent: GuardedRequest[] = [];
    const send = async (r: GuardedRequest) => {
      sent.push(r);
      if (r.url.pathname === '/dbs') return respond(201, { id: JSON.parse(String(r.body)).id });
      if (r.url.pathname === '/dbs/shop/colls') return JSON.parse(String(r.body)).id === 'taken' ? respond(409, { code: 'Conflict', message: 'Resource with specified id already exists.' }) : respond(201, { id: 'orders' });
      return respond(404, { code: 'NotFound', message: 'no' });
    };
    const d = new CosmosDriver(spec(), parseAllowList(''), { send });
    expect(await d.applyDdl(plan('cosmos-nosql', { kind: 'dataset', name: 'analytics', throughput: 1000 }, { database: 'shop' }), 5000)).toMatchObject({ applied: 1 });
    const db = sent[0]!;
    expect(db.method).toBe('POST');
    expect(db.headers['x-ms-offer-throughput']).toBe('1000');
    expect(db.headers['content-type']).toBe('application/json');
    expect(JSON.parse(String(db.body))).toEqual({ id: 'analytics' });
    expect(db.headers.authorization).toBe(masterKeyAuth({ verb: 'POST', resourceType: 'dbs', resourceLink: '', date: db.headers['x-ms-date']!, key }));

    const c = plan('cosmos-nosql', { kind: 'container', name: 'orders', partitionKeyPaths: ['/tenantId'], defaultTtl: -1 }, { database: 'shop' });
    expect(await d.applyDdl(c, 5000)).toMatchObject({ applied: 1, detail: /container orders/ });
    const coll = sent[1]!;
    expect(coll.url.pathname).toBe('/dbs/shop/colls');
    expect(coll.headers['x-ms-offer-throughput']).toBeUndefined();
    expect(JSON.parse(String(coll.body))).toMatchObject({ id: 'orders', partitionKey: { paths: ['/tenantId'], kind: 'Hash', version: 2 }, defaultTtl: -1 });
    expect(coll.headers.authorization).toBe(masterKeyAuth({ verb: 'POST', resourceType: 'colls', resourceLink: 'dbs/shop', date: coll.headers['x-ms-date']!, key }));

    await expect(d.applyDdl(plan('cosmos-nosql', { kind: 'container', name: 'taken', partitionKeyPaths: ['/id'] }, { database: 'shop' }), 5000)).rejects.toThrow(/container taken already exists.*409/);
    await expect(d.applyDdl(opsPlan('cosmos-nosql', [{ op: 'influx.createDatabase', name: 'x', duration: null }]), 5000)).rejects.toThrow(/do not perform influx\.createDatabase/);
  });

  it('explains a 403 for an Entra token', async () => {
    const send = async () => respond(403, { code: 'Forbidden', message: 'Request blocked by Auth: cannot be authorized by AAD token in data plane' });
    const d = new CosmosDriver(spec({ password: null, bearer: 'entra-token' }), parseAllowList(''), { send });
    await expect(d.applyDdl(plan('cosmos-nosql', { kind: 'dataset', name: 'analytics' }), 5000)).rejects.toThrow(/Entra tokens cannot create databases/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// InfluxDB (in-process HTTP)
// ---------------------------------------------------------------------------------------------------------------

class FakeHttp {
  server!: Server;
  url = '';
  requests: { method: string; path: string; headers: IncomingMessage['headers']; body: string }[] = [];
  constructor(private readonly handle: (r: { method: string; path: string; body: string }, res: ServerResponse) => void) {}
  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const r = { method: req.method!, path: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
        this.requests.push(r);
        this.handle(r, res);
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  async stop(): Promise<void> {
    await new Promise((r) => this.server.close(r));
  }
}

const json = (res: ServerResponse, status: number, body?: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

describe('InfluxDB schema plans', () => {
  let http: FakeHttp;
  const dbs = new Set<string>(['existing']);
  beforeEach(async () => {
    http = await new FakeHttp((r, res) => {
      if (r.method === 'POST' && r.path === '/query') {
        const q = new URLSearchParams(r.body).get('q') ?? '';
        if (!/^CREATE DATABASE "[^"]+"( WITH DURATION \w+)?$/.test(q)) return json(res, 400, { error: `error parsing query: ${q}` });
        return json(res, 200, { results: [{ statement_id: 0 }] });
      }
      if (r.method === 'POST' && r.path === '/api/v3/configure/database') {
        const db = (JSON.parse(r.body) as { db: string }).db;
        if (dbs.has(db)) return json(res, 409, { error: 'attempted to create a resource that already exists' });
        dbs.add(db);
        return json(res, 200);
      }
      json(res, 404, { error: 'not found' });
    }).start();
  });
  afterEach(async () => http.stop());

  const spec = (version: string): ConnectionSpec => ({ engine: 'influxdb', endpoint: http.url, database: 'telemetry', tls: false, username: version === 'v1' ? 'admin' : null, password: 'secret', options: { version } });

  it('1.x: CREATE DATABASE with the duration, POSTed as a form', async () => {
    const p = plan('influxdb', { kind: 'dataset', name: 'metrics', duration: '30d' }, { options: { version: 'v1' } });
    expect(await new InfluxDriver(spec('v1')).applyDdl(p, 5000)).toEqual({ applied: 1 });
    const r = http.requests[0]!;
    expect(r.method).toBe('POST');
    expect(r.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(new URLSearchParams(r.body).get('q')).toBe('CREATE DATABASE "metrics" WITH DURATION 30d');
    expect(r.headers.authorization).toBe('Basic ' + Buffer.from('admin:secret').toString('base64'));
    await expect(new InfluxDriver(spec('v1')).applyDdl(opsPlan('influxdb', [{ op: 'influx.createDatabase', name: 'x', duration: '30 days; DROP' }]), 5000)).rejects.toThrow(/not a retention duration/);
  });

  it('3: the configure API; 2.x refused', async () => {
    const p = plan('influxdb', { kind: 'dataset', name: 'events' }, { options: { version: 'v3' } });
    expect(await new InfluxDriver(spec('v3')).applyDdl(p, 5000)).toEqual({ applied: 1 });
    expect(http.requests[0]).toMatchObject({ method: 'POST', path: '/api/v3/configure/database', body: '{"db":"events"}' });
    expect(http.requests[0]!.headers.authorization).toBe('Bearer secret');
    await expect(new InfluxDriver(spec('v3')).applyDdl(plan('influxdb', { kind: 'dataset', name: 'existing' }, { options: { version: 'v3' } }), 5000)).rejects.toThrow(/409.*already exists/);
    await expect(new InfluxDriver(spec('v2')).applyDdl(opsPlan('influxdb', [{ op: 'influx.createDatabase', name: 'x', duration: null }]), 5000)).rejects.toThrow(/2\.x makes buckets/);
    expect(http.requests).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Redis (an in-process RESP2 fake)
// ---------------------------------------------------------------------------------------------------------------

type Val =
  | { t: 'string'; v: string }
  | { t: 'hash'; v: Record<string, string> }
  | { t: 'list'; v: string[] }
  | { t: 'zset'; v: [string, number][] }
  | { t: 'set'; v: string[] }
  | { t: 'stream'; v: [string, string[]][]; groups: { name: string; consumers: number; pending: number; last: string; lag: number }[] };

class FakeRedis {
  server!: TcpServer;
  port = 0;
  seen: string[][] = [];
  sockets = new Set<Socket>();
  data = new Map<string, Val>();
  channels = new Map<string, number>();
  pubsubAllowed = true;

  async start(): Promise<this> {
    this.server = createTcpServer((sock) => this.serve(sock));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }
  async stop(): Promise<void> {
    for (const x of this.sockets) x.destroy();
    await new Promise((r) => this.server.close(r));
  }

  private serve(sock: Socket) {
    this.sockets.add(sock);
    sock.on('close', () => this.sockets.delete(sock));
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      for (;;) {
        const parsed = this.parse(buf);
        if (!parsed) break;
        buf = buf.subarray(parsed.used);
        this.seen.push(parsed.args);
        sock.write(this.reply(parsed.args));
        if (parsed.args[0]?.toUpperCase() === 'QUIT') sock.end();
      }
    });
    sock.on('error', () => undefined);
  }

  private parse(b: Buffer): { args: string[]; used: number } | null {
    const s = b.toString('latin1');
    if (!s.startsWith('*')) return null;
    let i = s.indexOf('\r\n');
    if (i < 0) return null;
    const n = Number(s.slice(1, i));
    i += 2;
    const args: string[] = [];
    for (let k = 0; k < n; k++) {
      const e = s.indexOf('\r\n', i);
      if (e < 0) return null;
      const len = Number(s.slice(i + 1, e));
      if (s.length < e + 2 + len + 2) return null;
      args.push(Buffer.from(s.slice(e + 2, e + 2 + len), 'latin1').toString('utf8'));
      i = e + 2 + len + 2;
    }
    return { args, used: Buffer.byteLength(s.slice(0, i), 'latin1') };
  }

  private enc(v: unknown): string {
    if (v === null || v === undefined) return '$-1\r\n';
    if (typeof v === 'number') return `:${v}\r\n`;
    if (Array.isArray(v)) return `*${v.length}\r\n` + v.map((x) => this.enc(x)).join('');
    const str = String(v);
    return `$${Buffer.byteLength(str)}\r\n${str}\r\n`;
  }

  static glob = (p: string) => new RegExp('^' + p.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');

  private reply(a: string[]): string {
    const cmd = a[0]!.toUpperCase();
    const val = (k: string) => this.data.get(k);
    const wrong = '-WRONGTYPE Operation against a key holding the wrong kind of value\r\n';
    switch (cmd) {
      case 'AUTH':
        return a[2] === 'pw' || a[1] === 'pw' ? '+OK\r\n' : '-WRONGPASS invalid username-password pair\r\n';
      case 'SELECT':
      case 'QUIT':
        return '+OK\r\n';
      case 'EXISTS':
        return this.enc(a.slice(1).filter((k) => this.data.has(k)).length);
      case 'TYPE':
        return `+${val(a[1]!)?.t ?? 'none'}\r\n`;
      case 'PTTL':
        return this.data.has(a[1]!) ? ':-1\r\n' : ':-2\r\n';
      case 'LLEN': {
        const x = val(a[1]!);
        return x ? (x.t === 'list' ? this.enc(x.v.length) : wrong) : ':0\r\n';
      }
      case 'ZCARD': {
        const x = val(a[1]!);
        return x ? (x.t === 'zset' ? this.enc(x.v.length) : wrong) : ':0\r\n';
      }
      case 'HGET': {
        const x = val(a[1]!);
        return this.enc(x?.t === 'hash' ? (x.v[a[2]!] ?? null) : null);
      }
      case 'SCAN': {
        const m = a.findIndex((y) => y.toUpperCase() === 'MATCH');
        const re = m >= 0 ? FakeRedis.glob(a[m + 1]!) : /.*/;
        const keys = [...this.data.keys()].sort();
        const half = Math.ceil(keys.length / 2);
        const page = a[1] === '0' ? keys.slice(0, half) : keys.slice(half);
        return this.enc([a[1] === '0' && half < keys.length ? '7' : '0', page.filter((k) => re.test(k))]);
      }
      case 'XINFO': {
        const x = val(a[2]!);
        if (!x || x.t !== 'stream') return '-ERR no such key\r\n';
        if (a[1]!.toUpperCase() === 'STREAM') {
          const first = x.v[0] ?? null;
          const last = x.v[x.v.length - 1] ?? null;
          return this.enc(['length', x.v.length, 'radix-tree-keys', 1, 'last-generated-id', last?.[0] ?? '0-0', 'groups', x.groups.length, 'first-entry', first, 'last-entry', last]);
        }
        return this.enc(x.groups.map((g) => ['name', g.name, 'consumers', g.consumers, 'pending', g.pending, 'last-delivered-id', g.last, 'entries-read', 1, 'lag', g.lag]));
      }
      case 'XGROUP': {
        if (a[1]!.toUpperCase() !== 'CREATE') return '-ERR unknown subcommand\r\n';
        const [, , key, group] = a;
        let x = val(key!);
        if (!x) {
          if (!a.slice(5).some((y) => y.toUpperCase() === 'MKSTREAM')) return '-ERR The XGROUP subcommand requires the key to exist. Note that for CREATE you may want to use the MKSTREAM option to create an empty stream automatically.\r\n';
          x = { t: 'stream', v: [], groups: [] };
          this.data.set(key!, x);
        }
        if (x.t !== 'stream') return wrong;
        if (x.groups.some((g) => g.name === group)) return '-BUSYGROUP Consumer Group name already exists\r\n';
        x.groups.push({ name: group!, consumers: 0, pending: 0, last: a[4]!, lag: 0 });
        return '+OK\r\n';
      }
      case 'PUBSUB': {
        if (!this.pubsubAllowed) return "-NOPERM User reader has no permissions to run the 'pubsub|channels' command\r\n";
        if (a[1]!.toUpperCase() === 'CHANNELS') {
          const re = a[2] ? FakeRedis.glob(a[2]) : /.*/;
          return this.enc([...this.channels.keys()].filter((c) => re.test(c)));
        }
        return this.enc(a.slice(2).flatMap((c) => [c, this.channels.get(c) ?? 0]));
      }
      default:
        return `-ERR unknown command '${a[0]}'\r\n`;
    }
  }
}

describe('Redis schema plans and queues', () => {
  let fake: FakeRedis;
  beforeEach(async () => {
    fake = await new FakeRedis().start();
    fake.data.set('queue:jobs', { t: 'list', v: ['a', 'b', 'c'] });
    fake.data.set('queue:secret', { t: 'list', v: ['x'] });
    fake.data.set('queue:retry-delayed', { t: 'zset', v: [['j1', 1], ['j2', 2]] });
    fake.data.set('queue:scores', { t: 'zset', v: [['a', 1]] });
    fake.data.set('queue:settings', { t: 'hash', v: { a: '1' } });
    fake.data.set('events:orders', {
      t: 'stream',
      v: [
        ['1700000000000-0', ['order', '1']],
        ['1700000000001-0', ['order', '2']],
        ['1700000000002-0', ['order', '3']]
      ],
      groups: [
        { name: 'billing', consumers: 2, pending: 1, last: '1700000000001-0', lag: 1 },
        { name: 'shipping', consumers: 1, pending: 2, last: '1700000000000-0', lag: 2 }
      ]
    });
    // A BullMQ queue `bull:emails`: its state keys and two jobs (job hashes, a lock and logs).
    fake.data.set('bull:emails:meta', { t: 'hash', v: { 'opts.maxLenEvents': '10000', version: 'bullmq:5.12.0', paused: '1' } });
    fake.data.set('bull:emails:id', { t: 'string', v: '12' });
    fake.data.set('bull:emails:wait', { t: 'list', v: ['11', '12'] });
    fake.data.set('bull:emails:active', { t: 'list', v: ['10'] });
    fake.data.set('bull:emails:paused', { t: 'list', v: ['9'] });
    fake.data.set('bull:emails:delayed', { t: 'zset', v: [['8', 1]] });
    fake.data.set('bull:emails:completed', { t: 'zset', v: [['1', 1], ['2', 2], ['3', 3]] });
    fake.data.set('bull:emails:failed', { t: 'zset', v: [['4', 1]] });
    fake.data.set('bull:emails:events', { t: 'stream', v: [['1-0', ['event', 'added']]], groups: [] });
    fake.data.set('bull:emails:10', { t: 'hash', v: { name: 'send', data: '{}' } });
    fake.data.set('bull:emails:10:lock', { t: 'string', v: 'token' });
    fake.data.set('bull:emails:9:logs', { t: 'list', v: ['log'] });
    // Another BullMQ queue (not paused, a custom prefix) and one the allow-list leaves out.
    fake.data.set('jobs:reports:meta', { t: 'hash', v: { 'opts.maxLenEvents': '10000' } });
    fake.data.set('jobs:reports:prioritized', { t: 'zset', v: [['5', 1], ['6', 2]] });
    fake.data.set('bull:private:meta', { t: 'hash', v: {} });
    fake.data.set('bull:private:wait', { t: 'list', v: ['1'] });
    fake.channels.set('notify:orders', 3);
    fake.channels.set('notify:admin', 1);
  });
  afterEach(async () => fake.stop());

  const driver = (over: Partial<ConnectionSpec> = {}) => new RedisDriver({ engine: 'redis', endpoint: `127.0.0.1:${fake.port}`, database: '0', tls: false, username: 'reader', password: 'pw', options: { scanLimit: 10_000 }, ...over });
  const allow = ['queue:*', 'events:orders', 'bull:emails', 'jobs:reports:*', 'notify:orders', 'bull:private:x'];
  const refused = ['queue:secret'];
  const allowed = (n: string) => !refused.includes(n) && allowedPattern(n, allow);

  it('XGROUP CREATE: exactly that one command; BUSYGROUP and a missing stream said plainly', async () => {
    const p = plan('redis', { kind: 'stream-group', key: 'events:orders', group: 'audit', startId: '0', mkstream: false });
    fake.seen = [];
    expect(await driver({ username: 'admin' }).applyDdl(p, 3000)).toMatchObject({ applied: 1 });
    expect(fake.seen.filter((x) => !['AUTH', 'SELECT', 'QUIT'].includes(x[0]!.toUpperCase()))).toEqual([['XGROUP', 'CREATE', 'events:orders', 'audit', '0']]);
    await expect(driver().applyDdl(p, 3000)).rejects.toThrow(/^The group already exists\.$/);
    await expect(driver().applyDdl(plan('redis', { kind: 'stream-group', key: 'events:new', group: 'g', mkstream: false }), 3000)).rejects.toThrow(/does not exist \(create it with MKSTREAM\)/);
    expect(await driver().applyDdl(plan('redis', { kind: 'stream-group', key: 'events:new', group: 'g' }), 3000)).toMatchObject({ applied: 1 });
    expect(fake.seen.at(-2)).toEqual(['XGROUP', 'CREATE', 'events:new', 'g', '$', 'MKSTREAM']);
    await expect(driver().applyDdl(opsPlan('redis', [{ op: 'mongo.createCollection', name: 'x', options: {} }]), 3000)).rejects.toThrow(/do not perform mongo\.createCollection/);
  });

  it('lists lists, streams with their groups, BullMQ queues and channels on the allow-list, sending only reads', async () => {
    fake.seen = [];
    const r = await driver().queues({ allowed, patterns: allow, limit: 50, timeoutMs: 5000 });
    expect(r.queues.map((q) => [q.name, q.kind])).toEqual([
      ['bull:emails', 'bullmq'],
      ['events:orders', 'stream'],
      ['jobs:reports', 'bullmq'],
      ['notify:orders', 'pubsub'],
      ['queue:jobs', 'list'],
      ['queue:retry-delayed', 'zset']
    ]);
    const by = Object.fromEntries(r.queues.map((q) => [q.name, q]));
    expect(by['queue:jobs']).toMatchObject({ depth: 3, inFlight: null });
    expect(by['queue:retry-delayed']).toMatchObject({ depth: 2 });
    expect(by['events:orders']).toMatchObject({
      depth: 3,
      inFlight: 3,
      consumers: 3,
      groups: [
        { name: 'billing', consumers: 2, pending: 1, lastDeliveredId: '1700000000001-0', lag: 1 },
        { name: 'shipping', consumers: 1, pending: 2, lastDeliveredId: '1700000000000-0', lag: 2 }
      ],
      details: { firstEntryId: '1700000000000-0', lastEntryId: '1700000000002-0' }
    });
    expect(by['bull:emails']).toMatchObject({ depth: 3, inFlight: 1, state: 'paused', counts: { wait: 2, active: 1, paused: 1, delayed: 1, prioritized: 0, completed: 3, failed: 1, 'waiting-children': 0 } });
    expect(by['jobs:reports']).toMatchObject({ depth: 2, inFlight: 0, state: 'running', counts: { prioritized: 2 } });
    expect(by['notify:orders']).toMatchObject({ consumers: 3, depth: null });
    // queue:secret is refused by the allow-list; the zset of scores and the hash are not queues.
    expect(r.outside).toBe(1);
    expect(r.capped).toBe(false);
    const sent = new Set(fake.seen.map((x) => (x[0]!.toUpperCase() === 'XINFO' || x[0]!.toUpperCase() === 'PUBSUB' ? `${x[0]} ${x[1]}` : x[0]!.toUpperCase())));
    expect([...sent].sort()).toEqual(['AUTH', 'EXISTS', 'HGET', 'LLEN', 'PTTL', 'PUBSUB CHANNELS', 'PUBSUB NUMSUB', 'QUIT', 'SCAN', 'TYPE', 'XINFO GROUPS', 'XINFO STREAM', 'ZCARD'].sort());
    // Globs are walked with MATCH; exact names are probed, never scanned.
    expect(fake.seen.filter((x) => x[0] === 'SCAN').every((x) => ['queue:*', 'jobs:reports:*'].includes(x[3]!))).toBe(true);
  });

  it('caps at the limit, skips pub/sub when the ACL refuses it, and counts BullMQ keys outside the allow-list', async () => {
    fake.pubsubAllowed = false;
    const r = await driver().queues({ allowed, patterns: allow, limit: 2, timeoutMs: 5000 });
    expect(r.queues).toHaveLength(2);
    expect(r.capped).toBe(true);
    expect(r.queues.some((q) => q.kind === 'pubsub')).toBe(false);
    // A glob over bull:* sees bull:private's keys: the queue is refused, so its keys count as outside.
    const r2 = await driver().queues({ allowed: (n) => allowedPattern(n, ['bull:emails']), patterns: ['bull:*'], limit: 50, timeoutMs: 5000 });
    expect(r2.queues.map((q) => q.name)).toEqual(['bull:emails']);
    expect(r2.outside).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// RabbitMQ (in-process management API)
// ---------------------------------------------------------------------------------------------------------------

describe('RabbitMQ schema plans and queues', () => {
  let http: FakeHttp;
  const queues: Record<string, unknown>[] = [];
  const declared = new Map<string, Record<string, unknown>>();
  beforeEach(async () => {
    queues.length = 0;
    declared.clear();
    queues.push(
      { name: 'orders', vhost: '/', type: 'quorum', state: 'running', durable: true, auto_delete: false, arguments: { 'x-queue-type': 'quorum' }, policy: 'dlx', effective_policy_definition: { 'dead-letter-exchange': 'dlx.orders' }, messages_ready: 7, messages_unacknowledged: 2, consumers: 3, consumer_utilisation: 0.9, message_stats: { publish_details: { rate: 1.5 }, deliver_get_details: { rate: 1.25 } } },
      { name: 'audit', vhost: '/', type: 'stream', state: 'running', durable: true, auto_delete: false, arguments: { 'x-queue-type': 'stream' }, effective_policy_definition: [], messages_ready: 100, messages_unacknowledged: 0, consumers: 0 },
      { name: 'mail', vhost: '/', type: 'classic', state: 'idle', durable: false, auto_delete: true, arguments: { 'x-dead-letter-exchange': 'own.dlx' }, effective_policy_definition: { 'dead-letter-exchange': 'policy.dlx' }, messages_ready: 0, messages_unacknowledged: 0, consumers: 1, idle_since: '2026-10-26T10:00:00Z' },
      { name: 'secret', vhost: '/', type: 'classic', messages_ready: 1 },
      { name: 'billing', vhost: 'shop', type: 'quorum', messages_ready: 4, messages_unacknowledged: 1, consumers: 1 }
    );
    http = await new FakeHttp((r, res) => {
      const u = new URL(r.path, 'http://x');
      const m = /^\/api\/queues(?:\/([^/]+))?(?:\/([^/]+))?$/.exec(u.pathname);
      if (r.method === 'GET' && m && !m[2]) {
        const vhost = m[1] ? decodeURIComponent(m[1]) : null;
        const all = queues.filter((q) => !vhost || q.vhost === vhost);
        const size = Number(u.searchParams.get('page_size') ?? 100);
        const page = Number(u.searchParams.get('page') ?? 1);
        // Two per page, to make the driver page.
        const per = Math.min(size, 2);
        return json(res, 200, { items: all.slice((page - 1) * per, page * per), page, page_size: per, page_count: Math.ceil(all.length / per), total_count: all.length });
      }
      if (r.method === 'PUT' && m && m[2]) {
        const key = `${decodeURIComponent(m[1]!)}/${decodeURIComponent(m[2])}`;
        const body = JSON.parse(r.body) as Record<string, unknown>;
        const had = declared.get(key);
        if (had && JSON.stringify(had) !== JSON.stringify(body)) return json(res, 400, { error: 'bad_request', reason: `PRECONDITION_FAILED - inequivalent arg 'x-queue-type' for queue '${m[2]}' in vhost '${m[1]}': received 'classic' but current is 'quorum'` });
        declared.set(key, body);
        res.writeHead(had ? 204 : 201);
        return res.end();
      }
      if (r.method === 'PUT' && /^\/api\/exchanges\/[^/]+\/[^/]+$/.test(u.pathname)) {
        res.writeHead(201);
        return res.end();
      }
      if (r.method === 'POST' && /^\/api\/bindings\//.test(u.pathname)) {
        if (u.pathname.endsWith('/missing')) return json(res, 404, { error: 'Object Not Found', reason: 'Not Found' });
        res.writeHead(201, { location: 'x' });
        return res.end();
      }
      json(res, 405, { error: 'Method Not Allowed', reason: 'no' });
    }).start();
  });
  afterEach(async () => http.stop());

  const driver = (over: Partial<ConnectionSpec> = {}) => new RabbitDriver({ engine: 'rabbitmq', endpoint: http.url, database: null, tls: false, username: 'admin', password: 'pw', options: {}, ...over });

  it('declares queues and exchanges and binds, encoding the vhost and names', async () => {
    const q = plan('rabbitmq', { kind: 'queue', name: 'orders.v2', type: 'quorum', arguments: { deadLetterExchange: 'dlx' } });
    expect(await driver().applyDdl(q, 5000)).toMatchObject({ applied: 1, detail: /queue \/\/orders\.v2/ });
    expect(http.requests[0]).toMatchObject({ method: 'PUT', path: '/api/queues/%2F/orders.v2' });
    expect(JSON.parse(http.requests[0]!.body)).toEqual({ durable: true, auto_delete: false, arguments: { 'x-queue-type': 'quorum', 'x-dead-letter-exchange': 'dlx' } });
    expect(http.requests[0]!.headers.authorization).toBe('Basic ' + Buffer.from('admin:pw').toString('base64'));

    const ex = plan('rabbitmq', { kind: 'exchange', vhost: 'shop', name: 'events/topic', type: 'topic' });
    await driver().applyDdl(ex, 5000);
    expect(http.requests[1]).toMatchObject({ method: 'PUT', path: '/api/exchanges/shop/events%2Ftopic' });
    const b = plan('rabbitmq', { kind: 'binding', vhost: 'shop', source: 'events/topic', destination: 'orders.v2', routingKey: 'order.*' });
    await driver().applyDdl(b, 5000);
    expect(http.requests[2]).toMatchObject({ method: 'POST', path: '/api/bindings/shop/e/events%2Ftopic/q/orders.v2' });
    expect(JSON.parse(http.requests[2]!.body)).toEqual({ routing_key: 'order.*', arguments: {} });

    // The same queue with other arguments: PRECONDITION_FAILED, said as such.
    const other = plan('rabbitmq', { kind: 'queue', name: 'orders.v2', type: 'classic' });
    await expect(driver().applyDdl(other, 5000)).rejects.toThrow(/already exists with different settings \(RabbitMQ PRECONDITION_FAILED\).*inequivalent arg/);
    // Part-way failure: one applied before it.
    const two = opsPlan('rabbitmq', [
      { op: 'rabbit.declareExchange', vhost: '/', name: 'x', body: { type: 'direct', durable: true, auto_delete: false, internal: false, arguments: {} } },
      { op: 'rabbit.bind', vhost: '/', source: 'x', destination: 'missing', destinationType: 'q', body: { routing_key: '', arguments: {} } }
    ]);
    await expect(driver().applyDdl(two, 5000)).rejects.toThrow(/RabbitMQ 404: Not Found \(1 of 2 operations were applied before it\.\)/);
    await expect(driver().applyDdl(opsPlan('rabbitmq', [{ op: 'redis.xgroupCreate', key: 'k', group: 'g', id: '$', mkstream: true }]), 5000)).rejects.toThrow(/do not perform redis\.xgroupCreate/);
  });

  it('lists queues by page with columns, filtered to the allow-list, with kinds, rates and the dead-letter exchange', async () => {
    const d = driver({ username: 'reader' });
    const r = await d.queues({ allowed: (n) => allowedPattern(n, ['//*', 'shop/billing']) && n !== '//secret', patterns: [], limit: 50, timeoutMs: 5000 });
    expect(r.queues.map((q) => [q.name, q.kind])).toEqual([
      ['//audit', 'stream-queue'],
      ['//mail', 'classic'],
      ['//orders', 'quorum'],
      ['shop/billing', 'quorum']
    ]);
    expect(r.outside).toBe(1);
    expect(r.capped).toBe(false);
    const orders = r.queues.find((q) => q.name === '//orders')!;
    expect(orders).toMatchObject({ depth: 7, inFlight: 2, consumers: 3, state: 'running', rateIn: 1.5, rateOut: 1.25, details: { durable: true, autoDelete: false, policy: 'dlx', deadLetterExchange: 'dlx.orders', consumerUtilisation: 0.9 } });
    // An argument on the queue wins over the policy.
    expect(r.queues.find((q) => q.name === '//mail')!.details).toMatchObject({ deadLetterExchange: 'own.dlx', autoDelete: true, idleSince: '2026-10-26T10:00:00Z' });
    expect(r.queues.find((q) => q.name === '//audit')!.details).toMatchObject({ deadLetterExchange: null });
    // Only GETs, paged, with the columns.
    expect(d.sent.every((s) => s.method === 'GET')).toBe(true);
    expect(d.sent).toHaveLength(3);
    expect(decodeURIComponent(d.sent[0]!.path)).toMatch(/^\/api\/queues\?page=1&page_size=500&columns=name,vhost,type,.*message_stats\.publish_details\.rate/);

    const shop = driver({ username: 'reader', database: 'shop' });
    const r2 = await shop.queues({ allowed: () => true, patterns: [], limit: 50, timeoutMs: 5000 });
    expect(r2.queues.map((q) => q.name)).toEqual(['shop/billing']);
    expect(shop.sent[0]!.path).toMatch(/^\/api\/queues\/shop\?/);

    const capped = await driver().queues({ allowed: () => true, patterns: [], limit: 2, timeoutMs: 5000 });
    expect(capped).toMatchObject({ capped: true });
    expect(capped.queues).toHaveLength(2);
  });
});
