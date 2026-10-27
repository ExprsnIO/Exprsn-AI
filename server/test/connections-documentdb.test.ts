/*
 * 1.9.99-final, Sprint 59 (B-10304): the MongoDB-compatible managed services through the one MongoDB driver: Amazon
 * DocumentDB (SCRAM-SHA-1, the RDS CA bundle, replicas first, no privileges report, stages it does not run refused),
 * Azure Cosmos DB for MongoDB vCore (TLS always, SCRAM-SHA-256) and DigitalOcean Managed MongoDB (TLS always with the
 * cluster's CA). Unit tests with a stand-in backend (as `mongodb.test.ts`), and, when TEST_MONGODB_URL is set, the
 * DocumentDB engine against a real MongoDB as its local stand-in.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Document } from 'mongodb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConnectionSpec } from '../src/connections/drivers.js';
import { classifyMongoFor, MongoDriver, openMongo, type MongoBackend, type MongoDial } from '../src/connections/mongo.js';
import { MONGO_SERVICES } from '../src/connections/mongo-services.js';
import { parseAllowList } from '../src/mcp/hosts.js';
import { localUser, loginAdmin, type Harness } from './helpers.js';
import { harnessWith } from './retrieval-seed.js';

const CA = '-----BEGIN CERTIFICATE-----\nMIIBfakeCAforTests\n-----END CERTIFICATE-----\n';

class StandIn {
  dials: MongoDial[] = [];
  calls: { op: string; collection?: string; pipeline?: Document[]; limit?: number }[] = [];
  docs: Document[] = Array.from({ length: 4 }, (_, i) => ({ _id: `d${i}`, sku: `s-${i}`, owner_email: `o${i}@example.org` }));
  privileges = false;
  opener = async (d: MongoDial): Promise<MongoBackend> => {
    this.dials.push(d);
    return {
      command: async (cmd) => {
        this.calls.push({ op: Object.keys(cmd)[0]! });
        if ('ping' in cmd) return { ok: 1 };
        if ('buildInfo' in cmd) return { version: '5.0.0', ok: 1 };
        if ('connectionStatus' in cmd) {
          if (!this.privileges) throw new Error('Feature not supported: showPrivileges');
          return { authInfo: { authenticatedUsers: [{ user: 'reader', db: 'admin' }], authenticatedUserPrivileges: [{ resource: { db: 'catalog', collection: '' }, actions: ['find'] }] } };
        }
        throw new Error('unsupported');
      },
      listCollections: async () => [{ name: 'items', type: 'collection' }],
      find: async (collection, _filter, o) => {
        this.calls.push({ op: 'find', collection, limit: o.limit });
        return this.docs.slice(0, o.limit);
      },
      aggregate: async (collection, pipeline) => {
        this.calls.push({ op: 'aggregate', collection, pipeline });
        return this.docs;
      },
      close: async () => undefined
    };
  };
}

const spec = (o: Partial<ConnectionSpec> = {}): ConnectionSpec => ({ engine: 'documentdb', endpoint: '10.0.4.20:27017', database: 'catalog', tls: true, username: 'reader', password: 'pw', options: { readPreference: 'secondaryPreferred' }, ...o });

describe('MongoDB-compatible services: classification', () => {
  it('refuses the stages each service does not run, naming it', () => {
    const doc = MONGO_SERVICES.documentdb;
    expect(classifyMongoFor(doc, '{"aggregate": "items", "pipeline": [{"$setWindowFields": {"output": {}}}]}', null)).toMatchObject({ kind: 'denied', denied: '$setWindowFields', reason: 'Amazon DocumentDB does not run the $setWindowFields stage.' });
    expect(classifyMongoFor(doc, '{"aggregate": "items", "pipeline": [{"$facet": {"a": [{"$graphLookup": {"from": "items", "startWith": "$x", "connectFromField": "x", "connectToField": "y", "as": "z"}}]}}]}', null)).toMatchObject({ kind: 'denied', denied: '$graphLookup' });
    expect(classifyMongoFor(doc, '{"aggregate": "items", "pipeline": [{"$out": "copy"}]}', null).kind).toBe('write');
    expect(classifyMongoFor(doc, 'db.items.deleteMany({})', null).kind).toBe('write');
    expect(classifyMongoFor(doc, '{"find": "items", "filter": {"$where": "1"}}', null).kind).toBe('denied');
    expect(classifyMongoFor(doc, '{"find": "items", "filter": {"sku": "s-1"}}', null)).toMatchObject({ kind: 'read', objects: ['items'] });
    expect(classifyMongoFor(MONGO_SERVICES['do-mongodb'], '{"aggregate": "items", "pipeline": [{"$setWindowFields": {"output": {}}}]}', null).kind).toBe('read');
  });
});

describe('MongoDB-compatible services: the driver', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'exs-docdb-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('dials DocumentDB with SCRAM-SHA-1, replicas first and the RDS CA bundle, and says privileges cannot be read', async () => {
    const f = new StandIn();
    const file = path.join(dir, 'rds-global-bundle.pem');
    writeFileSync(file, CA);
    const d = new MongoDriver(spec({ options: { readPreference: 'secondaryPreferred', tlsCaFile: file } }), parseAllowList(''), f.opener, MONGO_SERVICES.documentdb);
    const t = await d.test(5000);
    expect(t).toMatchObject({ version: 'Amazon DocumentDB 5.0.0', readOnly: true, health: 'healthy', detail: expect.stringMatching(/does not report/) });
    expect(f.dials[0]).toMatchObject({ address: '10.0.4.20', tls: true, authMechanism: 'SCRAM-SHA-1', readPreference: 'secondaryPreferred' });
    expect(String(f.dials[0]!.ca)).toBe(CA);
    // A CA bundle carried by the connection's cloud link wins over the setting.
    await new MongoDriver(spec({ ca: 'LINKED', options: { tlsCaFile: file } }), parseAllowList(''), f.opener, MONGO_SERVICES.documentdb).test(5000);
    expect(f.dials.at(-1)!.ca).toBe('LINKED');
    // Without TLS no bundle is read.
    await new MongoDriver(spec({ tls: false, options: { tlsCaFile: path.join(dir, 'missing.pem') } }), parseAllowList(''), f.opener, MONGO_SERVICES.documentdb).test(5000);
    expect(f.dials.at(-1)!.ca).toBeUndefined();
  });

  it('caps reads, refuses an unsupported stage at the driver too, and keeps to the address guard', async () => {
    const f = new StandIn();
    const d = new MongoDriver(spec(), parseAllowList(''), f.opener, MONGO_SERVICES.documentdb);
    const r = await d.query(classifyMongoFor(MONGO_SERVICES.documentdb, '{"find": "items"}', null), '', { limit: 2, timeoutMs: 5000 });
    expect(r).toMatchObject({ columns: ['_id', 'sku', 'owner_email'], capped: true });
    expect(r.rows).toHaveLength(2);
    await expect(d.query({ kind: 'read', verb: 'aggregate', objects: ['items'], mongo: { op: 'aggregate', collection: 'items', pipeline: [{ $densify: {} }] } }, '', { limit: 2, timeoutMs: 5000 })).rejects.toThrow(/not a read|does not run/);
    expect(f.calls.filter((c) => c.op === 'aggregate')).toHaveLength(0);
    await expect(new MongoDriver(spec({ endpoint: '169.254.169.254:27017' }), parseAllowList(''), f.opener, MONGO_SERVICES.documentdb).test(1000)).rejects.toThrow(/metadata|link-local/);
    await expect(new MongoDriver(spec({ endpoint: '8.8.8.8:27017' }), parseAllowList(''), f.opener, MONGO_SERVICES.documentdb).test(1000)).rejects.toThrow(/public address/);
  });

  it('dials Cosmos DB for MongoDB vCore with SCRAM-SHA-256 and DigitalOcean with its CA, reporting privileges where it can', async () => {
    const f = new StandIn();
    await new MongoDriver(spec({ engine: 'cosmos-mongodb', endpoint: '10.1.0.9:10260', options: {} }), parseAllowList(''), f.opener, MONGO_SERVICES['cosmos-mongodb']).test(5000);
    expect(f.dials.at(-1)).toMatchObject({ port: 10260, authMechanism: 'SCRAM-SHA-256', tls: true });
    f.privileges = true;
    const t = await new MongoDriver(spec({ engine: 'do-mongodb', endpoint: '10.2.0.3:27017', ca: CA, options: {} }), parseAllowList(''), f.opener, MONGO_SERVICES['do-mongodb']).test(5000);
    expect(t).toMatchObject({ version: 'DigitalOcean Managed MongoDB 5.0.0', readOnly: true, detail: expect.stringMatching(/read-only on catalog/) });
    expect(f.dials.at(-1)).toMatchObject({ ca: CA });
    expect(f.dials.at(-1)!.authMechanism).toBeUndefined();
  });
});

describe('DocumentDB connections through the service', () => {
  let h: Harness;
  let f: StandIn;
  beforeEach(async () => {
    f = new StandIn();
    h = await harnessWith({ drivers: { documentdb: (sp: ConnectionSpec) => new MongoDriver(sp, parseAllowList(''), f.opener, MONGO_SERVICES.documentdb) } }, { OLLAMA_POLL_MS: '600000' });
  });
  afterEach(async () => h.close());

  it('registers, reads masked documents and refuses writes and unsupported stages before anything is sent', async () => {
    await localUser(h, 'docs', ['connection-admin', 'member'], 'confidential');
    const c = await loginAdmin(h, 'docs');
    const post = (p: string, b: object = {}) => c.agent.post(p).set('x-csrf-token', c.csrf).send(b);
    const conn = (await post('/api/admin/connections', { name: 'catalog', engine: 'documentdb', endpoint: '10.0.4.20:27017', database: 'catalog', zone: 'data', label: 'internal', tls: false, username: 'reader', password: 'pw', options: { tlsCaFile: '/etc/exprsn/ca/rds-global-bundle.pem' } }).expect(201)).body;
    expect(conn).toMatchObject({ engine: 'documentdb', engineTitle: 'Amazon DocumentDB', family: 'document', options: { readPreference: 'secondaryPreferred', tlsCaFile: '/etc/exprsn/ca/rds-global-bundle.pem' } });
    expect((await post('/api/admin/connections', { name: 'bad', engine: 'documentdb', endpoint: '10.0.4.20:27017', database: 'catalog', zone: 'data', label: 'internal', username: 'r', password: 'p', options: { tlsCaFile: 'relative.pem' } }).expect(422)).body.title).toBe('Invalid settings');
    // TLS is always on for the vCore and DigitalOcean services.
    const vcore = (await post('/api/admin/connections', { name: 'vcore', engine: 'cosmos-mongodb', endpoint: '10.1.0.9:10260', database: 'catalog', zone: 'data', label: 'internal', tls: false, username: 'reader', password: 'pw' }).expect(201)).body;
    expect(vcore.tls).toBe(true);
    await post(`/api/admin/connections/${conn.id}/schema`).expect(200);
    await c.agent.put(`/api/admin/connections/${conn.id}/allow-list`).set('x-csrf-token', c.csrf).send({ objects: ['items'], piiColumns: [] }).expect(200);
    f.calls = [];
    expect((await post(`/api/admin/connections/${conn.id}/query`, { query: '{"aggregate": "items", "pipeline": [{"$merge": "copy"}]}' }).expect(422)).body.title).toBe('Write refused');
    expect((await post(`/api/admin/connections/${conn.id}/query`, { query: '{"aggregate": "items", "pipeline": [{"$fill": {}}]}' }).expect(422)).body.detail).toMatch(/Amazon DocumentDB does not run the \$fill stage/);
    expect(f.calls).toEqual([]);
    const r = (await post(`/api/admin/connections/${conn.id}/query`, { query: '{"find": "items"}' }).expect(200)).body;
    expect(r.masked).toEqual(['owner_email']);
    expect(r.rows[0][2]).toBe('••••.org');
  });
});

const URL_ = process.env.TEST_MONGODB_URL;

describe.skipIf(!URL_)('DocumentDB engine against a real MongoDB stand-in (TEST_MONGODB_URL)', () => {
  it('connects with SCRAM-SHA-1 and reads', async () => {
    const u = new URL(URL_!);
    const d = new MongoDriver({ engine: 'documentdb', endpoint: `${u.hostname}:${u.port || 27017}`, database: 'admin', tls: false, username: `admin/${decodeURIComponent(u.username)}`, password: decodeURIComponent(u.password), options: { readPreference: 'primary' } }, parseAllowList(''), openMongo, MONGO_SERVICES.documentdb);
    const t = await d.test(10_000);
    expect(t.version).toMatch(/^Amazon DocumentDB \d/);
    expect(Array.isArray(await d.introspect(10_000))).toBe(true);
  });
});
