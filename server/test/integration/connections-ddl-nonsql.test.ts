/*
 * 2.0.x: schema plans, edits (XGROUP SETID / DESTROY, collMod, dropIndex, drop) and describe, and the Queues tab, on
 * real servers.
 *   TEST_REDIS_URL    redis://[user:password@]localhost:6379[/db]   keys under `exprsn-it-ddl:` are written and removed
 *   TEST_MONGODB_URL  an account that may create collections; a database `exprsn_it_ddl` is created and dropped
 */
import { Redis } from 'ioredis';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildPlan, type AdminOp, type DdlPlan } from '../../src/connections/ddl.js';
import { MongoDriver } from '../../src/connections/mongo.js';
import { allowedPattern } from '../../src/connections/patterns.js';
import { RedisDriver } from '../../src/connections/redis.js';
import { parseAllowList } from '../../src/mcp/hosts.js';

const REDIS = process.env.TEST_REDIS_URL;
const MONGO = process.env.TEST_MONGODB_URL;
const P = 'exprsn-it-ddl';
const opsPlan = (engine: DdlPlan['engine'], ops: AdminOp[]): DdlPlan => ({ engine, kind: 'drop', object: 'x', statements: [], ops, transactional: false, touches: [], notes: [], destructive: true, confirmName: null, hash: '' });

describe.skipIf(!REDIS)('Redis queues and XGROUP CREATE (TEST_REDIS_URL)', () => {
  const u = new URL(REDIS ?? 'redis://localhost:6379');
  const seed = new Redis(REDIS ?? '', { lazyConnect: true });
  const driver = () =>
    new RedisDriver({ engine: 'redis', endpoint: `${u.hostname}:${u.port || 6379}`, database: u.pathname.slice(1) || '0', tls: u.protocol === 'rediss:', username: decodeURIComponent(u.username) || null, password: decodeURIComponent(u.password) || null, options: { scanLimit: 100_000 } }, parseAllowList(u.hostname));
  const drop = async () => {
    const keys = await seed.keys(`${P}:*`);
    if (keys.length) await seed.del(...keys);
  };

  beforeAll(async () => {
    await seed.connect();
    await drop();
    await seed.rpush(`${P}:jobs`, 'a', 'b');
    await seed.xadd(`${P}:events`, '*', 'n', '1');
    await seed.xadd(`${P}:events`, '*', 'n', '2');
    // BullMQ's layout for a queue `<P>:bull:mail`.
    await seed.hset(`${P}:bull:mail:meta`, { 'opts.maxLenEvents': '10000', paused: '1' });
    await seed.set(`${P}:bull:mail:id`, '3');
    await seed.rpush(`${P}:bull:mail:wait`, '2', '3');
    await seed.zadd(`${P}:bull:mail:completed`, 1, '1');
    await seed.hset(`${P}:bull:mail:1`, { name: 'send' });
  });
  afterAll(async () => {
    await drop();
    await seed.quit();
  });

  it('creates a group, then lists the queues', async () => {
    const plan = buildPlan('redis', { engine: 'redis', database: null, account: null, options: {} }, { kind: 'stream-group', key: `${P}:events`, group: 'workers', startId: '0', mkstream: false });
    expect(await driver().applyDdl(plan, 5000)).toMatchObject({ applied: 1 });
    await expect(driver().applyDdl(plan, 5000)).rejects.toThrow(/^The group already exists\.$/);
    await seed.xreadgroup('GROUP', 'workers', 'c1', 'COUNT', '1', 'STREAMS', `${P}:events`, '>');

    const allow = [`${P}:*`];
    const r = await driver().queues({ allowed: (n) => allowedPattern(n, allow), patterns: allow, limit: 50, timeoutMs: 5000 });
    const by = Object.fromEntries(r.queues.map((q) => [q.name, q]));
    expect(by[`${P}:jobs`]).toMatchObject({ kind: 'list', depth: 2 });
    expect(by[`${P}:events`]).toMatchObject({ kind: 'stream', depth: 2, inFlight: 1, consumers: 1, groups: [{ name: 'workers', pending: 1 }] });
    expect(by[`${P}:bull:mail`]).toMatchObject({ kind: 'bullmq', depth: 2, state: 'paused', counts: { wait: 2, completed: 1 } });
    expect(r.outside).toBe(0);
  });

  it('describes the groups, moves one with SETID and removes it with DESTROY', async () => {
    const key = `${P}:events`;
    const before = await driver().describe(key, 'stream-group', 5000);
    expect(before).toMatchObject({ kind: 'stream-group', name: key, definition: { key, groups: [{ name: 'workers', consumers: 1, pending: 1 }] } });
    expect(await driver().describe(`${P}:absent`, 'stream-group', 5000)).toBeNull();
    await expect(driver().describe(`${P}:jobs`, 'stream-group', 5000)).rejects.toThrow(/is a list, not a stream/);

    expect(await driver().applyDdl(opsPlan('redis', [{ op: 'redis.xgroupSetId', key, group: 'workers', id: '0' }]), 5000)).toMatchObject({ applied: 1 });
    const moved = (await driver().describe(key, 'stream-group', 5000))!.definition as { groups: { name: string; lastDeliveredId: string }[] };
    expect(moved.groups[0]!.lastDeliveredId).toBe('0-0');
    await expect(driver().applyDdl(opsPlan('redis', [{ op: 'redis.xgroupSetId', key, group: 'nope', id: '0' }]), 5000)).rejects.toThrow(/^The group does not exist\.$/);

    expect(await driver().applyDdl(opsPlan('redis', [{ op: 'redis.xgroupDestroy', key, group: 'workers' }]), 5000)).toMatchObject({ applied: 1 });
    expect(((await driver().describe(key, 'stream-group', 5000))!.definition as { groups: unknown[] }).groups).toEqual([]);
    await expect(driver().applyDdl(opsPlan('redis', [{ op: 'redis.xgroupDestroy', key, group: 'workers' }]), 5000)).rejects.toThrow(/^The group does not exist\.$/);
  });
});

describe.skipIf(!MONGO)('MongoDB schema plans (TEST_MONGODB_URL)', () => {
  const db = 'exprsn_it_ddl';
  const u = new URL(MONGO ?? 'mongodb://127.0.0.1:27017');
  let admin: MongoClient;
  const driver = () => {
    const authdb = u.searchParams.get('authSource') ?? 'admin';
    const user = decodeURIComponent(u.username);
    return new MongoDriver({ engine: 'mongodb', endpoint: `${u.hostname}:${u.port || 27017}`, database: db, tls: false, username: user ? `${authdb}/${user}` : null, password: decodeURIComponent(u.password) || null, options: {} }, parseAllowList(u.hostname));
  };
  const ctx = { engine: 'mongodb' as const, database: db, account: null, options: {} };

  beforeAll(async () => {
    admin = new MongoClient(MONGO!);
    await admin.connect();
    await admin.db(db).dropDatabase();
  });
  afterAll(async () => {
    await admin.db(db).dropDatabase();
    await admin.close();
  });

  it('creates a validated collection and an index', async () => {
    const coll = buildPlan('mongodb', ctx, { kind: 'collection', name: 'orders', fields: [{ name: 'total', bsonType: 'double', required: true }] });
    expect(await driver().applyDdl(coll, 10_000)).toMatchObject({ applied: 1 });
    const info = await admin.db(db).listCollections({ name: 'orders' }).toArray();
    expect((info[0] as { options?: { validator?: unknown } }).options?.validator).toMatchObject({ $jsonSchema: { required: ['total'] } });
    await expect(driver().applyDdl(coll, 10_000)).rejects.toThrow(/already exists/);
    const ix = buildPlan('mongodb', ctx, { kind: 'index', collection: 'orders', name: 'by_total', keys: [{ field: 'total', order: -1 }], unique: true });
    expect(await driver().applyDdl(ix, 10_000)).toMatchObject({ applied: 1, detail: /by_total/ });
    expect((await admin.db(db).collection('orders').indexes()).map((i) => i.name)).toContain('by_total');
  });

  it('describes the collection, changes its validator, drops the index and the collection', async () => {
    const d = await driver().describe('orders', 'collection', 10_000);
    expect(d).toMatchObject({ kind: 'collection', name: 'orders', definition: { fields: [{ name: 'total', bsonType: 'double', required: true }], validationLevel: 'strict' }, indexes: [{ name: 'by_total', keys: [{ field: 'total', order: -1 }], unique: true }] });
    expect(await driver().describe('absent', 'collection', 10_000)).toBeNull();
    await driver().applyDdl(opsPlan('mongodb', [{ op: 'mongo.collMod', name: 'orders', options: { validator: { $jsonSchema: { bsonType: 'object', properties: { total: { bsonType: 'double' } } } }, validationLevel: 'moderate', validationAction: 'warn' } }]), 10_000);
    expect((await driver().describe('orders', 'collection', 10_000))!.definition).toMatchObject({ fields: [{ name: 'total', required: false }], validationLevel: 'moderate', validationAction: 'warn' });
    expect(await driver().applyDdl(opsPlan('mongodb', [{ op: 'mongo.dropIndex', collection: 'orders', index: 'by_total' }, { op: 'mongo.dropCollection', name: 'orders' }]), 10_000)).toMatchObject({ applied: 2 });
    expect(await admin.db(db).listCollections({ name: 'orders' }).toArray()).toEqual([]);
    await expect(driver().applyDdl(opsPlan('mongodb', [{ op: 'mongo.dropCollection', name: 'orders' }]), 10_000)).rejects.toThrow(/does not exist/);
  });
});
