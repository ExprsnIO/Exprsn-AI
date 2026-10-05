/*
 * MongoDB data connections: the read-only query model (find and allow-listed aggregation stages, no server-side
 * JavaScript), the driver's host checks, caps and timeouts over an in-memory stand-in for the official driver, the
 * connection API (register, test, schema, allow-list, masked queries, refusals and their audit), and a collection as
 * a knowledge source with a watermark and an access field. The real-server path is test/integration/mongodb.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Document } from 'mongodb';
import { parseAllowList } from '../src/mcp/hosts.js';
import { allowedCollection, classifyMongo, mongoAccount, MongoDriver, type MongoBackend, type MongoDial } from '../src/connections/mongo.js';
import type { ConnectionSpec } from '../src/connections/drivers.js';
import { FakeOllama } from './fake-ollama.js';
import { loginAdmin, localUser, type Harness } from './helpers.js';
import { rowItem } from '../src/knowledge/service.js';
import { client, drain, harnessWith, seedRetrieval } from './retrieval-seed.js';

// ---------- an in-memory MongoDB ----------

type Privilege = { resource: { db?: string; collection?: string; anyResource?: boolean }; actions: string[] };

const cmp = (a: unknown, b: unknown): number | null => {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  const oa = (a as { _bsontype?: string } | null)?._bsontype === 'ObjectId';
  const ob = (b as { _bsontype?: string } | null)?._bsontype === 'ObjectId';
  if (oa && ob) return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  return null; // different BSON types never compare, as in MongoDB's query brackets
};
const at = (d: Document, path: string): unknown => path.split('.').reduce<unknown>((cur, k) => (cur && typeof cur === 'object' ? (cur as Document)[k] : undefined), d);

function matches(d: Document, f: Document): boolean {
  return Object.entries(f).every(([k, v]) => {
    if (k === '$or') return (v as Document[]).some((x) => matches(d, x));
    if (k === '$and') return (v as Document[]).every((x) => matches(d, x));
    const val = at(d, k);
    if (v && typeof v === 'object' && !(v instanceof Date) && Object.keys(v).some((o) => o.startsWith('$'))) {
      return Object.entries(v as Document).every(([op, x]) => {
        const c = cmp(val, x);
        if (op === '$gt') return c != null && c > 0;
        if (op === '$gte') return c != null && c >= 0;
        if (op === '$lt') return c != null && c < 0;
        if (op === '$in') return (x as unknown[]).some((y) => cmp(val, y) === 0);
        if (op === '$eq') return c === 0;
        throw new Error(`fake: unsupported operator ${op}`);
      });
    }
    return cmp(val, v) === 0;
  });
}

function project(d: Document, p: Document | undefined): Document {
  if (!p) return d;
  const out: Document = {};
  if (p._id !== 0) out._id = d._id;
  for (const [k, v] of Object.entries(p)) {
    if (!v || k === '_id') continue;
    const val = at(d, k);
    if (val === undefined) continue;
    const parts = k.split('.');
    let cur = out;
    for (const part of parts.slice(0, -1)) cur = (cur[part] ??= {}) as Document;
    cur[parts[parts.length - 1]!] = val;
  }
  return out;
}

class FakeMongo {
  collections = new Map<string, Document[]>();
  views = new Set<string>();
  dials: MongoDial[] = [];
  calls: { op: string; collection?: string; filter?: Document; pipeline?: Document[]; opts?: Document; cmd?: Document }[] = [];
  users: { user: string; db: string }[] = [{ user: 'reader', db: 'admin' }];
  privileges: Privilege[] = [{ resource: { db: 'shop', collection: '' }, actions: ['find', 'listCollections', 'collStats'] }];
  refuseAuth = false;

  opener = async (d: MongoDial): Promise<MongoBackend> => {
    this.dials.push(d);
    if (this.refuseAuth) throw new Error('Authentication failed.');
    const sorted = (docs: Document[], sort?: Document) =>
      sort
        ? [...docs].sort((a, b) => {
            for (const [k, dir] of Object.entries(sort)) {
              const c = cmp(at(a, k), at(b, k)) ?? 0;
              if (c) return c * (dir === -1 ? -1 : 1);
            }
            return 0;
          })
        : docs;
    return {
      command: async (cmd) => {
        this.calls.push({ op: 'command', cmd });
        if ('ping' in cmd) return { ok: 1 };
        if ('buildInfo' in cmd) return { version: '8.0.17', ok: 1 };
        if ('connectionStatus' in cmd) return { authInfo: { authenticatedUsers: this.users, authenticatedUserPrivileges: this.privileges }, ok: 1 };
        throw new Error(`fake: unsupported command ${Object.keys(cmd)[0]}`);
      },
      listCollections: async () => [...this.collections.keys()].map((name) => ({ name, type: this.views.has(name) ? 'view' : 'collection' })),
      find: async (collection, filter, o) => {
        this.calls.push({ op: 'find', collection, filter, opts: o });
        const docs = sorted((this.collections.get(collection) ?? []).filter((d) => matches(d, filter)), o.sort);
        return docs.slice(o.skip ?? 0, (o.skip ?? 0) + o.limit).map((d) => project(d, o.projection));
      },
      aggregate: async (collection, pipeline, o) => {
        this.calls.push({ op: 'aggregate', collection, pipeline, opts: o });
        let docs = this.collections.get(collection) ?? [];
        for (const st of pipeline) {
          const [name, spec] = Object.entries(st)[0]!;
          if (name === '$match') docs = docs.filter((d) => matches(d, spec as Document));
          else if (name === '$limit') docs = docs.slice(0, spec as number);
          else if (name === '$sort') docs = sorted(docs, spec as Document);
          else if (name === '$project') docs = docs.map((d) => project(d, spec as Document));
          else if (name === '$count') docs = [{ [spec as string]: docs.length }];
          else throw new Error(`fake: unsupported stage ${name}`);
        }
        return docs;
      },
      close: async () => undefined
    };
  };
}

const spec = (over: Partial<ConnectionSpec> = {}): ConnectionSpec => ({ engine: 'mongodb', endpoint: '10.20.0.5:27017', database: 'shop', tls: false, username: 'reader', password: 'pw', ...over });

// ---------- the query model ----------

describe('MongoDB query model', () => {
  it('reads find and aggregate, and a bare filter on the picked collection', () => {
    expect(classifyMongo('{"find": "orders", "filter": {"status": "open"}, "projection": {"note": 1}, "sort": {"updatedAt": -1}, "limit": 5}', null)).toMatchObject({ kind: 'read', verb: 'find', objects: ['orders'], mongo: { op: 'find', collection: 'orders', filter: { status: 'open' }, limit: 5 } });
    expect(classifyMongo('{"aggregate": "orders", "pipeline": [{"$match": {"status": "open"}}, {"$group": {"_id": "$customer", "n": {"$sum": 1}}}]}', null)).toMatchObject({ kind: 'read', verb: 'aggregate', objects: ['orders'] });
    expect(classifyMongo('{"status": "open"}', 'orders')).toMatchObject({ kind: 'read', verb: 'find', objects: ['orders'], mongo: { filter: { status: 'open' } } });
    expect(classifyMongo('{"status": "open"}', null)).toMatchObject({ kind: 'unparsed' });
    // Collections read through $lookup, $graphLookup, $unionWith and inside $facet are checked too.
    const cl = classifyMongo(JSON.stringify({ aggregate: 'orders', pipeline: [{ $lookup: { from: 'customers', localField: 'c', foreignField: '_id', as: 'cust', pipeline: [{ $unionWith: { coll: 'archive', pipeline: [] } }] } }, { $facet: { a: [{ $graphLookup: { from: 'parts', startWith: '$p', connectFromField: 'p', connectToField: 'id', as: 'g' } }] } }] }), null);
    expect(cl).toMatchObject({ kind: 'read', objects: ['orders', 'customers', 'archive', 'parts'] });
  });

  it('refuses writes, DDL, write stages and server-side JavaScript', () => {
    expect(classifyMongo('db.orders.insertOne({"a": 1})', null)).toMatchObject({ kind: 'write', verb: 'insertOne', objects: ['orders'] });
    expect(classifyMongo('db.orders.deleteMany({})', null)).toMatchObject({ kind: 'write' });
    expect(classifyMongo('db.orders.drop()', null)).toMatchObject({ kind: 'ddl', verb: 'drop' });
    expect(classifyMongo('db.orders.find({})', null)).toMatchObject({ kind: 'unparsed' });
    expect(classifyMongo('{"insert": "orders", "documents": [{}]}', null)).toMatchObject({ kind: 'write', verb: 'insert' });
    expect(classifyMongo('{"update": "orders", "updates": []}', null)).toMatchObject({ kind: 'write', verb: 'update' });
    expect(classifyMongo('{"findAndModify": "orders", "update": {}}', null)).toMatchObject({ kind: 'write' });
    expect(classifyMongo('{"drop": "orders"}', null)).toMatchObject({ kind: 'ddl', verb: 'drop' });
    expect(classifyMongo('{"createIndexes": "orders", "indexes": []}', null)).toMatchObject({ kind: 'ddl' });
    expect(classifyMongo('{"aggregate": "orders", "pipeline": [{"$match": {}}, {"$out": "copy"}]}', null)).toMatchObject({ kind: 'write', verb: '$out' });
    expect(classifyMongo('{"aggregate": "orders", "pipeline": [{"$merge": {"into": "copy"}}]}', null)).toMatchObject({ kind: 'write', verb: '$merge' });
    expect(classifyMongo('{"aggregate": "orders", "pipeline": [{"$facet": {"x": [{"$out": "copy"}]}}]}', null)).toMatchObject({ kind: 'write' });
    expect(classifyMongo('{"find": "orders", "filter": {"$where": "this.a > 1"}}', null)).toMatchObject({ kind: 'denied', denied: '$where' });
    expect(classifyMongo('{"find": "orders", "filter": {"$expr": {"$function": {"body": "function() { return true }", "args": [], "lang": "js"}}}}', null)).toMatchObject({ kind: 'denied', denied: '$function' });
    expect(classifyMongo('{"aggregate": "orders", "pipeline": [{"$group": {"_id": null, "x": {"$accumulator": {}}}}]}', null)).toMatchObject({ kind: 'denied', denied: '$accumulator' });
    expect(classifyMongo('{"find": "orders", "filter": {"a": {"$code": "sleep(1000)"}}}', null)).toMatchObject({ kind: 'denied', denied: '$code' });
    expect(classifyMongo('{"mapReduce": "orders", "map": "", "reduce": ""}', null)).toMatchObject({ kind: 'denied', verb: 'mapReduce' });
  });

  it('refuses stages off the allow-list, other databases and system collections', () => {
    expect(classifyMongo('{"aggregate": "orders", "pipeline": [{"$currentOp": {}}]}', null)).toMatchObject({ kind: 'denied', denied: '$currentOp' });
    expect(classifyMongo('{"aggregate": "orders", "pipeline": [{"$collStats": {}}]}', null)).toMatchObject({ kind: 'denied' });
    expect(classifyMongo('{"aggregate": "orders", "pipeline": [{"$lookup": {"from": {"db": "other", "coll": "x"}, "as": "y", "pipeline": []}}]}', null)).toMatchObject({ kind: 'denied' });
    expect(classifyMongo('{"find": "system.users"}', null)).toMatchObject({ kind: 'denied' });
    expect(classifyMongo('{"find": "orders", "batchSize": 5}', null)).toMatchObject({ kind: 'unparsed' });
    expect(classifyMongo('{"find": "orders", "limit": -1}', null)).toMatchObject({ kind: 'unparsed' });
    expect(classifyMongo('{ not json', 'orders')).toMatchObject({ kind: 'unparsed' });
    expect(allowedCollection('orders', ['orders'])).toBe(true);
    expect(allowedCollection('orders_2026', ['orders_*'])).toBe(true);
    expect(allowedCollection('Orders', ['orders'])).toBe(false);
    expect(allowedCollection('customers', ['orders'])).toBe(false);
  });
});

// ---------- the driver ----------

describe('MongoDriver', () => {
  it('authenticates against the connection database unless the username names another', () => {
    expect(mongoAccount('reader', 'shop')).toEqual({ user: 'reader', authSource: 'shop' });
    expect(mongoAccount('admin/root', 'shop')).toEqual({ user: 'root', authSource: 'admin' });
    expect(mongoAccount(null, 'shop')).toEqual({ user: null, authSource: 'shop' });
  });


  it('dials only checked internal addresses, pinned for the connection', async () => {
    const fake = new FakeMongo();
    await expect(new MongoDriver(spec({ endpoint: '169.254.169.254:27017' }), parseAllowList(''), fake.opener).test(1000)).rejects.toThrow(/link-local/);
    await expect(new MongoDriver(spec({ endpoint: '8.8.8.8:27017' }), parseAllowList(''), fake.opener).test(1000)).rejects.toThrow(/public address/);
    expect(fake.dials).toHaveLength(0);
    await new MongoDriver(spec({ endpoint: '8.8.8.8' }), parseAllowList('8.8.8.8'), fake.opener).test(1000);
    await new MongoDriver(spec({ endpoint: 'localhost:27019', tls: true }), parseAllowList(''), fake.opener).test(1000);
    expect(fake.dials.map((d) => [d.host, d.port, d.tls, d.database])).toEqual([['8.8.8.8', 27017, false, 'shop'], ['localhost', 27019, true, 'shop']]);
    expect(['127.0.0.1', '::1']).toContain(fake.dials[1]!.address);
    await expect(new MongoDriver(spec({ database: null }), parseAllowList(''), fake.opener).test(1000)).rejects.toThrow(/names its database/);
  });

  it('caps documents, sets maxTimeMS, appends a $limit and converts extended JSON', async () => {
    const fake = new FakeMongo();
    fake.collections.set('orders', Array.from({ length: 30 }, (_, i) => ({ _id: i + 1, n: i, at: new Date(Date.UTC(2026, 8, 1 + i)) })));
    const d = new MongoDriver(spec(), parseAllowList(''), fake.opener);
    const r = await d.query(classifyMongo('{"find": "orders", "filter": {"at": {"$gte": {"$date": "2026-09-20T00:00:00Z"}}}, "sort": {"n": 1}}', null), '', { limit: 5, timeoutMs: 2500 });
    expect(r).toMatchObject({ columns: ['_id', 'n', 'at'], capped: true });
    expect(r.rows).toHaveLength(5);
    expect(r.rows[0]).toEqual([20, 19, new Date('2026-09-20T00:00:00Z')]);
    const find = fake.calls.find((c) => c.op === 'find')!;
    expect(find.filter!.at.$gte).toBeInstanceOf(Date);
    expect(find.opts).toMatchObject({ limit: 6, maxTimeMS: 2500 });
    // The query's own smaller limit is kept and is not reported as capped.
    expect((await d.query(classifyMongo('{"find": "orders", "limit": 3}', null), '', { limit: 5, timeoutMs: 1000 })).capped).toBe(false);
    const a = await d.query(classifyMongo('{"aggregate": "orders", "pipeline": [{"$match": {"n": {"$lt": 10}}}]}', null), '', { limit: 4, timeoutMs: 1500 });
    expect(a).toMatchObject({ capped: true });
    const agg = fake.calls.find((c) => c.op === 'aggregate')!;
    expect(agg.pipeline!.at(-1)).toEqual({ $limit: 5 });
    expect(agg.opts).toMatchObject({ maxTimeMS: 1500 });
    // The driver checks again: a request that is not a read never reaches the server.
    const forged = { kind: 'read' as const, verb: 'aggregate', objects: ['orders'], mongo: { op: 'aggregate' as const, collection: 'orders', pipeline: [{ $out: 'x' }] } };
    await expect(d.query(forged, '', { limit: 5, timeoutMs: 1000 })).rejects.toThrow(/not a read/);
    await expect(d.query({ ...forged, mongo: { op: 'aggregate', collection: 'orders', pipeline: [{ $currentOp: {} }] } }, '', { limit: 5, timeoutMs: 1000 })).rejects.toThrow(/not a read/);
  });

  it('reports reachability, authentication and write privileges', async () => {
    const fake = new FakeMongo();
    const d = new MongoDriver(spec(), parseAllowList(''), fake.opener);
    expect(await d.test(1000)).toMatchObject({ version: 'MongoDB 8.0.17', readOnly: true, health: 'healthy', detail: expect.stringContaining('reader@admin is read-only') });
    fake.privileges = [{ resource: { db: 'shop', collection: '' }, actions: ['find', 'insert', 'update'] }];
    expect(await d.test(1000)).toMatchObject({ readOnly: false, detail: expect.stringContaining('insert, update') });
    fake.privileges = [{ resource: { db: 'other', collection: '' }, actions: ['find'] }];
    expect(await d.test(1000)).toMatchObject({ health: 'degraded', detail: expect.stringContaining('no find privilege on shop') });
    fake.users = [];
    expect(await d.test(1000)).toMatchObject({ readOnly: false, detail: expect.stringContaining('without an account') });
    fake.refuseAuth = true;
    await expect(d.test(1000)).rejects.toThrow(/Authentication failed/);
  });
});

// ---------- through the API ----------

describe('MongoDB connections and knowledge sources', () => {
  let h: Harness;
  let ollama: FakeOllama | undefined;
  let fake: FakeMongo;

  afterEach(async () => {
    await h?.close();
    await ollama?.stop();
    ollama = undefined;
  });

  async function setup(withKnowledge = false) {
    fake = new FakeMongo();
    const now = Date.UTC(2026, 8, 20);
    fake.collections.set('tickets', [
      { _id: 't1', subject: 'Payroll run', body: 'The payroll batch for October closes on the 28th.', email: 'fin@northwind.example', contact: { name: 'Ada', mail: 'ada@northwind.example' }, groups: ['Finance', 'HR'], updatedAt: new Date(now) },
      { _id: 't2', subject: 'Switch upgrade', body: 'The core switch upgrade happens on the 28th at night.', email: 'ops@northwind.example', contact: { name: 'Bo', mail: 'bo@northwind.example' }, groups: ['ops'], updatedAt: new Date(now + 3600_000) }
    ]);
    fake.collections.set('payroll', [{ _id: 'p1', amount: 1 }]);
    h = await harnessWith({ drivers: { mongodb: (sp: ConnectionSpec) => new MongoDriver(sp, parseAllowList(''), fake.opener) } }, { OLLAMA_POLL_MS: '600000', KNOWLEDGE_REPLICATION_TICK_MS: '200' });
    if (withKnowledge) {
      ollama = await new FakeOllama().start();
      await seedRetrieval(h, ollama);
    }
    await localUser(h, 'connadmin', ['connection-admin', 'member'], 'confidential');
    const a = await loginAdmin(h, 'connadmin');
    const post = (p: string, b: object) => a.agent.post(p).set('x-csrf-token', a.csrf).send(b);
    const base = { name: 'helpdesk', engine: 'mongodb', endpoint: '10.20.0.5:27017', label: 'internal', username: 'reader', password: 'S3cret-pw' };
    expect((await post('/api/admin/connections', base).expect(409)).body.detail).toMatch(/names the database/);
    expect((await post('/api/admin/connections', { ...base, database: 'shop', username: null, password: null, baoRole: 'ro' }).expect(409)).body.detail).toMatch(/PostgreSQL and MySQL/);
    const conn = (await post('/api/admin/connections', { ...base, database: 'shop' }).expect(201)).body;
    expect(conn).toMatchObject({ engine: 'mongodb', database: 'shop', account: 'reader', hasCredential: true });
    return { a, post, conn };
  }

  it('registers, tests, introspects, and runs only allow-listed masked reads', async () => {
    const { a, post, conn } = await setup();
    await a.agent.put(`/api/admin/connections/${conn.id}/credential`).set('x-csrf-token', a.csrf).send({ baoRole: 'ro' }).expect(409);
    expect((await post(`/api/admin/connections/${conn.id}/test`, {}).expect(200)).body).toMatchObject({ ok: true, readOnly: true, health: 'healthy', version: 'MongoDB 8.0.17' });
    expect(fake.dials.at(-1)).toMatchObject({ address: '10.20.0.5', username: 'reader', password: 'S3cret-pw' });
    const sch = (await post(`/api/admin/connections/${conn.id}/schema`, {}).expect(200)).body;
    expect(sch).toMatchObject({ objects: 2, allowed: 0 });
    const tickets = sch.connection.schema.find((o: { name: string }) => o.name === 'tickets');
    expect(tickets.columns.map((c: { name: string; type: string }) => [c.name, c.type])).toEqual(expect.arrayContaining([['_id', 'string'], ['groups', 'array'], ['updatedAt', 'date'], ['contact', 'object']]));
    expect(tickets.columns.find((c: { name: string }) => c.name === 'email').pii).toBe(true);
    await a.agent.put(`/api/admin/connections/${conn.id}/allow-list`).set('x-csrf-token', a.csrf).send({ objects: ['tickets'], piiColumns: ['tickets.subject'] }).expect(200);

    const q = (query: string, object?: string) => post(`/api/admin/connections/${conn.id}/query`, { query, ...(object ? { object } : {}) });
    const r = (await q('{"find": "tickets", "sort": {"updatedAt": 1}}').expect(200)).body;
    expect(r.columns).toEqual(['_id', 'subject', 'body', 'email', 'contact', 'groups', 'updatedAt']);
    expect(r.rows[0][0]).toBe('t1');
    expect(r.rows[0][1]).toMatch(/^••••/); // marked by the admin
    expect(r.rows[0][3]).toMatch(/^••••/); // named like personal data
    expect(JSON.parse(r.rows[0][4])).toEqual({ name: 'Ada', mail: expect.stringMatching(/^••••/) }); // inside a sub-document
    expect(r.rows[0][6]).toBe('2026-09-20T00:00:00.000Z');
    expect(r.masked).toEqual(expect.arrayContaining(['subject', 'email', 'contact']));
    expect(r.label).toBe('internal');
    expect((await q('{"subject": "Switch upgrade"}', 'tickets').expect(200)).body.rows).toHaveLength(1);

    // Refusals: never sent, each audited.
    const before = fake.calls.filter((c) => c.op !== 'command').length;
    expect((await q('{"find": "payroll"}').expect(422)).body).toMatchObject({ kind: 'denied', object: 'payroll' });
    expect((await q('{"aggregate": "tickets", "pipeline": [{"$lookup": {"from": "payroll", "localField": "a", "foreignField": "b", "as": "c"}}]}').expect(422)).body).toMatchObject({ kind: 'denied', object: 'payroll' });
    expect((await q('db.tickets.updateMany({}, {"$set": {"x": 1}})').expect(422)).body).toMatchObject({ kind: 'write', verb: 'updateMany' });
    expect((await q('{"aggregate": "tickets", "pipeline": [{"$out": "copy"}]}').expect(422)).body).toMatchObject({ kind: 'write', verb: '$out' });
    expect((await q('{"find": "tickets", "filter": {"$where": "sleep(100)"}}').expect(422)).body).toMatchObject({ kind: 'denied' });
    expect((await q('{"drop": "tickets"}').expect(422)).body).toMatchObject({ kind: 'ddl' });
    // A request the parser cannot read is refused outright, even when confirmed.
    expect((await post(`/api/admin/connections/${conn.id}/query`, { query: 'db.tickets.find({})', confirmUnparsed: true }).expect(422)).body).toMatchObject({ kind: 'unparsed' });
    expect(fake.calls.filter((c) => c.op !== 'command').length).toBe(before);
    const refused = await h.s.db('audit_events').where({ action: 'connection.query.refused' });
    expect(refused).toHaveLength(7);
    expect(await h.s.db('audit_events').where({ action: 'connection.query' })).toHaveLength(2);
    // The export goes through the same checks.
    const csv = await post(`/api/admin/connections/${conn.id}/export`, { query: '{"find": "tickets"}' }).expect(200);
    expect(csv.text).toContain('_id,subject,body');
    expect(csv.text).not.toContain('fin@northwind.example');
  });

  it('a collection feeds a knowledge base by watermark, with row access from a field', async () => {
    const { a, post, conn } = await setup(true);
    await post(`/api/admin/connections/${conn.id}/schema`, {}).expect(200);
    await a.agent.put(`/api/admin/connections/${conn.id}/allow-list`).set('x-csrf-token', a.csrf).send({ objects: ['tick*'], piiColumns: [] }).expect(200);
    const curator = await client(h, 'cura', ['member', 'knowledge-curator'], 'confidential');
    expect((await curator.get('/api/knowledge/connections').expect(200)).body).toEqual([expect.objectContaining({ id: conn.id, engine: 'mongodb', objects: ['tickets'], columns: { tickets: expect.arrayContaining(['subject', 'body', 'groups']) } })]);
    const kb = (await curator.post('/api/knowledge/bases', { name: 'Helpdesk', label: 'internal', embedModel: 'nomic-embed-text', sharing: 'members' }).expect(201)).body;
    await curator.patch(`/api/knowledge/bases/${kb.id}`, { status: 'published' }).expect(200);
    const add = (b: object) => curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 'database', connectionId: conn.id, ...b });
    await add({ location: 'mongo: payroll', fields: ['amount'] }).expect(409); // not allow-listed
    await add({ location: 'mongo: tickets', fields: ['body'], replication: true }).expect(409);
    await add({ location: 'mongo: tickets', fields: ['body'], watermarkColumn: '$where' }).expect(400);
    const src = (await add({ location: 'mongo: tickets', fields: ['subject', 'body'], accessColumn: 'groups' }).expect(201)).body;
    expect(src).toMatchObject({ location: 'mongo: tickets', config: { engine: 'mongodb', object: 'tickets', fields: ['subject', 'body'], idColumn: '_id', watermarkColumn: 'updatedAt', accessColumn: 'groups', accessKind: 'group' } });
    await drain(h);
    const find = fake.calls.filter((c) => c.op === 'find' && c.collection === 'tickets').at(-1)!;
    expect(find.opts).toMatchObject({ projection: { _id: 1, subject: 1, body: 1, updatedAt: 1, groups: 1 }, sort: { updatedAt: 1, _id: 1 }, limit: 5001 });
    const docs = (await h.s.db('knowledge_documents').where({ source_id: src.id }).orderBy('name')) as { name: string; acl: string; label: string }[];
    expect(docs.map((d) => [d.name, JSON.parse(d.acl), d.label])).toEqual([
      ['tickets #t1', ['g:finance', 'g:hr'], 'internal'],
      ['tickets #t2', ['g:ops'], 'internal']
    ]);
    const view = (await curator.get(`/api/knowledge/bases/${kb.id}`).expect(200)).body.sources[0];
    expect(view).toMatchObject({ state: 'idle', documents: 2, watermark: '2026-09-20T01:00:00.000Z' });
    // Only the named fields are indexed; the id, watermark and access fields are read beside them.
    const text = (await rowItem(src.config, 't9', ['_id', 'subject', 'body', 'updatedAt', 'groups'], ['t9', 'Hello', 'World', '2026-09-20T00:00:00.000Z', '["ops"]'], ['ops']).read()).toString();
    expect(text).toBe('# tickets t9\n\nsubject: Hello\nbody: World');

    // A newer document is read alone, after the watermark compared as a date.
    fake.collections.get('tickets')!.push({ _id: 't3', subject: 'Badge office', body: 'Badges are printed on Tuesdays.', groups: 'ops', updatedAt: new Date(Date.UTC(2026, 8, 21)) });
    await curator.post(`/api/knowledge/sources/${src.id}/sync`).expect(202);
    await drain(h);
    const last = fake.calls.filter((c) => c.op === 'find' && c.collection === 'tickets').at(-1)!;
    expect(JSON.stringify(last.filter)).toContain('$gt');
    const job = (await h.s.db('jobs').where({ type: 'knowledge.sync' }).orderBy('created_at', 'desc').first()) as { result: string };
    expect(JSON.parse(job.result)).toMatchObject({ added: 1, changed: 0 });
    expect(await h.s.db('knowledge_documents').where({ source_id: src.id })).toHaveLength(3);
    // Without fields, the text fields of the sampled schema are indexed (not the id); a bare collection name is enough,
    // and an explicit null watermark keeps none.
    const kb2 = (await curator.post('/api/knowledge/bases', { name: 'Helpdesk 2', label: 'internal', embedModel: 'nomic-embed-text', sharing: 'members' }).expect(201)).body;
    const plain = (await curator.post(`/api/knowledge/bases/${kb2.id}/sources`, { kind: 'database', connectionId: conn.id, location: 'tickets', idColumn: '_id', watermarkColumn: 'updatedAt' }).expect(201)).body;
    expect(plain).toMatchObject({ location: 'mongo: tickets', config: { fields: ['subject', 'body', 'email'], idColumn: '_id', watermarkColumn: 'updatedAt' } });
    const nowm = (await curator.post(`/api/knowledge/bases/${kb2.id}/sources`, { kind: 'database', connectionId: conn.id, location: 'mongo: tickets', fields: ['body'], watermarkColumn: null }).expect(201)).body;
    expect(nowm.config).toMatchObject({ fields: ['body'], watermarkColumn: null });
    await drain(h);
    const plainDocs = (await h.s.db('knowledge_documents').where({ source_id: plain.id })) as { name: string }[];
    expect(plainDocs).toHaveLength(3);

    // The connection cannot be removed while the source reads from it.
    await a.agent.delete(`/api/admin/connections/${conn.id}`).set('x-csrf-token', a.csrf).expect(409);
  });
});
