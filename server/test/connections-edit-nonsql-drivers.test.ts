/*
 * 2.0.x schema editing on the non-SQL drivers, against in-process fakes: the edit and drop operations (`applyDdl`
 * with the EditOp kinds of ddl-edit-types.ts) and `describe`, which reads an object back in the shape of its create
 * form. MongoDB collMod / drop / dropIndexes and listCollections + listIndexes through the backend seam; DynamoDB
 * DeleteTable, UpdateTable (a GSI deleted, billing changed, waiting between changes) and DescribeTable +
 * DescribeTimeToLive; Cosmos DB container replace and delete and database delete signed over the right resource type
 * and link, and the container read back; InfluxDB DROP DATABASE (1.x InfluxQL, 3 configure API, 2 refused); Redis
 * XGROUP DESTROY / SETID and the groups read with TYPE + XINFO GROUPS only; RabbitMQ queue, exchange and binding
 * deletes (percent-encoded, if-empty / if-unused, 404 and 400 explained) and queues and exchanges read with one GET.
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
import { DynamoDriver } from '../src/connections/dynamodb.js';
import { CosmosDriver, masterKeyAuth } from '../src/connections/cosmos.js';
import { InfluxDriver } from '../src/connections/influxdb.js';
import { RedisDriver } from '../src/connections/redis.js';
import { RabbitDriver } from '../src/connections/rabbitmq.js';
import type { GuardedRequest, GuardedResponse } from '../src/platform/egress.js';
import { parseAllowList } from '../src/mcp/hosts.js';

const opsPlan = (engine: Engine, ops: AdminOp[]): DdlPlan => ({ engine, kind: 'drop', object: 'x', statements: [], ops, transactional: false, touches: [], notes: [], destructive: true, confirmName: null, hash: '' });
const createPlan = (engine: Engine, raw: unknown, ctx: { database?: string | null } = {}): DdlPlan => buildPlan(engine, { engine, database: ctx.database ?? null, account: null, options: {} }, raw);

// ---------------------------------------------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------------------------------------------

interface FakeColl {
  options: Document;
  indexes: Document[];
}

class FakeMongo {
  collections = new Map<string, FakeColl>();
  calls: { op: string; args: unknown[] }[] = [];
  commands: Document[] = [];
  opener = async (_d: MongoDial): Promise<MongoBackend> => ({
    command: async (cmd) => {
      this.commands.push(cmd);
      if ('listCollections' in cmd) {
        const name = (cmd.filter as { name?: string } | undefined)?.name;
        const batch = [...this.collections].filter(([n]) => !name || n === name).map(([n, c]) => ({ name: n, type: c.options.viewOn ? 'view' : 'collection', options: c.options, info: { readOnly: false } }));
        return { cursor: { id: 0, ns: 'shop.$cmd.listCollections', firstBatch: batch }, ok: 1 };
      }
      if ('listIndexes' in cmd) {
        const c = this.collections.get(String(cmd.listIndexes));
        if (!c) throw new Error('ns does not exist: shop.' + String(cmd.listIndexes) + ' (NamespaceNotFound)');
        return { cursor: { id: 0, firstBatch: c.indexes }, ok: 1 };
      }
      return { ok: 1 };
    },
    listCollections: async () => [...this.collections.keys()].map((name) => ({ name, type: 'collection' })),
    find: async () => [],
    aggregate: async () => [],
    collMod: async (name, options, timeoutMs) => {
      this.calls.push({ op: 'collMod', args: [name, options, timeoutMs] });
      const c = this.collections.get(name);
      if (!c) throw new Error(`ns does not exist (NamespaceNotFound)`);
      Object.assign(c.options, options);
    },
    dropCollection: async (name, timeoutMs) => {
      this.calls.push({ op: 'dropCollection', args: [name, timeoutMs] });
      if (!this.collections.delete(name)) throw new Error('ns not found (NamespaceNotFound)');
    },
    dropIndex: async (collection, index, timeoutMs) => {
      this.calls.push({ op: 'dropIndex', args: [collection, index, timeoutMs] });
      const c = this.collections.get(collection);
      if (!c) throw new Error('ns not found (NamespaceNotFound)');
      const at = c.indexes.findIndex((i) => i.name === index);
      if (at < 0) throw new Error(`index not found with name [${index}] (IndexNotFound)`);
      c.indexes.splice(at, 1);
    },
    close: async () => undefined
  });
}

describe('MongoDB edits and descriptions', () => {
  const spec = (over: Partial<ConnectionSpec> = {}): ConnectionSpec => ({ engine: 'mongodb', endpoint: '127.0.0.1:27017', database: 'shop', tls: false, username: 'admin/root', password: 'pw', options: {}, ...over });
  const seed = (f: FakeMongo) => {
    f.collections.set('orders', {
      options: {
        validator: { $jsonSchema: { bsonType: 'object', required: ['total'], properties: { _id: { bsonType: 'objectId' }, total: { bsonType: 'double', description: 'In cents' }, tags: { bsonType: ['array', 'null'] } }, additionalProperties: false } },
        validationLevel: 'moderate',
        validationAction: 'warn'
      },
      indexes: [
        { v: 2, key: { _id: 1 }, name: '_id_' },
        { v: 2, key: { placedAt: -1, status: 1 }, name: 'by_placed', unique: true, partialFilterExpression: { at: { $gt: new Date('2026-01-01T00:00:00Z') } } },
        { v: 2, key: { _fts: 'text', _ftsx: 1 }, name: 'search', weights: { title: 1, body: 1 } },
        { v: 2, key: { loc: '2dsphere' }, name: 'near', sparse: true },
        { v: 2, key: { seenAt: 1 }, name: 'ttl', expireAfterSeconds: 3600 }
      ]
    });
    f.collections.set('ticks', { options: { timeseries: { timeField: 'at', metaField: 'sensor', granularity: 'minutes', bucketMaxSpanSeconds: 86400 }, expireAfterSeconds: 600 }, indexes: [] });
    f.collections.set('log', { options: { capped: true, size: 1_048_576, max: 1000 }, indexes: [{ v: 2, key: { _id: 1 }, name: '_id_' }] });
  };

  it('collMod, dropIndex and dropCollection on the backend, in order, with the extended JSON read', async () => {
    const f = new FakeMongo();
    seed(f);
    const d = new MongoDriver(spec(), parseAllowList(''), f.opener);
    const r = await d.applyDdl(
      opsPlan('mongodb', [
        { op: 'mongo.collMod', name: 'orders', options: { validator: { $jsonSchema: { bsonType: 'object', properties: { at: { bsonType: 'date' } } } }, validationLevel: 'strict', validationAction: 'error' } },
        { op: 'mongo.collMod', name: 'ticks', options: { expireAfterSeconds: 1200 } },
        { op: 'mongo.dropIndex', collection: 'orders', index: 'by_placed' },
        { op: 'mongo.dropCollection', name: 'log' }
      ]),
      5000
    );
    expect(r).toEqual({ applied: 4, detail: 'Changed collection orders, changed collection ticks, dropped index by_placed on orders, dropped collection log.' });
    expect(f.calls.map((c) => c.op)).toEqual(['collMod', 'collMod', 'dropIndex', 'dropCollection']);
    expect(f.calls[0]!.args[1]).toEqual({ validator: { $jsonSchema: { bsonType: 'object', properties: { at: { bsonType: 'date' } } } }, validationLevel: 'strict', validationAction: 'error' });
    expect(f.collections.get('ticks')!.options.expireAfterSeconds).toBe(1200);
    expect(f.collections.get('orders')!.indexes.map((i) => i.name)).not.toContain('by_placed');
    expect(f.collections.has('log')).toBe(false);

    await d.applyDdl(opsPlan('mongodb', [{ op: 'mongo.collMod', name: 'orders', options: { validator: { at: { $gt: { $date: '2026-01-01T00:00:00Z' } } } } }]), 5000);
    expect(((f.calls.at(-1)!.args[1] as Document).validator as Document).at.$gt).toBeInstanceOf(Date);
  });

  it('refuses system collections, server-side JavaScript, the _id index and unknown operations; says what is missing', async () => {
    const f = new FakeMongo();
    seed(f);
    const d = new MongoDriver(spec(), parseAllowList(''), f.opener);
    await expect(d.applyDdl(opsPlan('mongodb', [{ op: 'mongo.dropCollection', name: 'system.users' }]), 5000)).rejects.toThrow(/system collections are refused/);
    await expect(d.applyDdl(opsPlan('mongodb', [{ op: 'mongo.collMod', name: 'system.views', options: {} }]), 5000)).rejects.toThrow(/system collections are refused/);
    await expect(d.applyDdl(opsPlan('mongodb', [{ op: 'mongo.dropIndex', collection: 'system.profile', index: 'x' }]), 5000)).rejects.toThrow(/system collections are refused/);
    await expect(d.applyDdl(opsPlan('mongodb', [{ op: 'mongo.collMod', name: 'orders', options: { validator: { $where: 'this.total > 0' } } }]), 5000)).rejects.toThrow(/Server-side JavaScript is not sent/);
    await expect(d.applyDdl(opsPlan('mongodb', [{ op: 'mongo.collMod', name: 'orders', options: { validator: { $expr: { $function: { body: 'x', args: [], lang: 'js' } } } } }]), 5000)).rejects.toThrow(/Server-side JavaScript/);
    await expect(d.applyDdl(opsPlan('mongodb', [{ op: 'mongo.dropIndex', collection: 'orders', index: '_id_' }]), 5000)).rejects.toThrow(/_id index cannot be dropped/);
    await expect(d.applyDdl(opsPlan('mongodb', [{ op: 'mongo.dropIndex', collection: 'orders', index: '*' }]), 5000)).rejects.toThrow(/by its name/);
    await expect(d.applyDdl(opsPlan('mongodb', [{ op: 'mongo.dropIndex', collection: 'orders', index: 'nope' }]), 5000)).rejects.toThrow(/The index nope does not exist on orders/);
    await expect(d.applyDdl(opsPlan('mongodb', [{ op: 'mongo.dropCollection', name: 'gone' }]), 5000)).rejects.toThrow(/The collection gone does not exist/);
    await expect(d.applyDdl(opsPlan('mongodb', [{ op: 'rabbit.deleteQueue', vhost: '/', name: 'q', ifEmpty: true, ifUnused: true }]), 5000)).rejects.toThrow(/do not perform rabbit\.deleteQueue/);
    expect(f.calls).toHaveLength(2);
    // Part-way: one applied before it.
    await expect(d.applyDdl(opsPlan('mongodb', [{ op: 'mongo.dropIndex', collection: 'orders', index: 'ttl' }, { op: 'mongo.dropCollection', name: 'gone' }]), 5000)).rejects.toThrow(/1 of 2 operations were applied before it/);
    const bare = new MongoDriver(spec(), parseAllowList(''), async () => ({ command: async () => ({}), listCollections: async () => [], find: async () => [], aggregate: async () => [], close: async () => undefined }));
    await expect(bare.applyDdl(opsPlan('mongodb', [{ op: 'mongo.dropCollection', name: 'orders' }]), 5000)).rejects.toThrow(/cannot drop collections/);
  });

  it('describes a collection in the create form shape, with its indexes, sending only listCollections and listIndexes', async () => {
    const f = new FakeMongo();
    seed(f);
    const d = new MongoDriver(spec({ username: 'reader' }), parseAllowList(''), f.opener);
    const o = await d.describe('orders', 'collection', 5000);
    expect(o).toEqual({
      kind: 'collection',
      name: 'orders',
      definition: {
        name: 'orders',
        fields: [
          { name: '_id', bsonType: 'objectId', required: false },
          { name: 'total', bsonType: 'double', required: true, description: 'In cents' },
          { name: 'tags', bsonType: 'array', required: false }
        ],
        additionalProperties: false,
        validationLevel: 'moderate',
        validationAction: 'warn'
      },
      indexes: [
        { collection: 'orders', name: 'by_placed', keys: [{ field: 'placedAt', order: -1 }, { field: 'status', order: 1 }], unique: true, sparse: false, partialFilter: { at: { $gt: { $date: '2026-01-01T00:00:00Z' } } } },
        { collection: 'orders', name: 'search', keys: [{ field: 'title', order: 'text' }, { field: 'body', order: 'text' }], unique: false, sparse: false },
        { collection: 'orders', name: 'near', keys: [{ field: 'loc', order: '2dsphere' }], unique: false, sparse: true },
        { collection: 'orders', name: 'ttl', keys: [{ field: 'seenAt', order: 1 }], unique: false, sparse: false, expireAfterSeconds: 3600 }
      ]
    });
    expect(await d.describe('ticks', 'collection', 5000)).toMatchObject({ definition: { fields: [], additionalProperties: true, validationLevel: 'strict', timeseries: { timeField: 'at', metaField: 'sensor', granularity: 'minutes' }, expireAfterSeconds: 600 }, indexes: [] });
    expect((await d.describe('log', 'collection', 5000))!.definition).toMatchObject({ capped: { size: 1_048_576, max: 1000 } });
    expect(await d.describe('missing', 'collection', 5000)).toBeNull();
    expect(f.commands.every((c) => 'listCollections' in c || 'listIndexes' in c)).toBe(true);
    expect(f.commands[0]).toMatchObject({ listCollections: 1, filter: { name: 'orders' } });
    expect(f.calls).toHaveLength(0);
    await expect(d.describe('system.users', 'collection', 5000)).rejects.toThrow(/System collections/);
    await expect(d.describe('orders', 'table', 5000)).rejects.toThrow(/describe collections, not table/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// DynamoDB and Cosmos DB (through the guarded-send seam)
// ---------------------------------------------------------------------------------------------------------------

const respond = (status: number, body: unknown, headers: Record<string, string> = {}): GuardedResponse => ({ status, contentType: 'application/json', body: Buffer.from(body === undefined ? '' : JSON.stringify(body)), address: '127.0.0.1', headers });

describe('DynamoDB edits and descriptions', () => {
  const spec: ConnectionSpec = { engine: 'dynamodb', endpoint: 'http://127.0.0.1:8000', database: null, tls: false, username: 'AKIDADMIN', password: 'admin-secret', options: { region: 'eu-west-1' } };

  it('UpdateTable deletes a GSI, waits for the indexes to settle, then changes billing; DeleteTable', async () => {
    const sent: { target: string; body: Record<string, unknown> }[] = [];
    let describes = 0;
    const send = async (r: GuardedRequest) => {
      const target = r.headers['x-amz-target']!.split('.')[1]!;
      const body = JSON.parse(String(r.body)) as Record<string, unknown>;
      sent.push({ target, body });
      if (target === 'DescribeTable') return respond(200, { Table: { TableName: body.TableName, TableStatus: 'ACTIVE', GlobalSecondaryIndexes: ++describes < 2 ? [{ IndexName: 'by_status', IndexStatus: 'DELETING' }] : [] } });
      if (target === 'UpdateTable') return respond(200, { TableDescription: { TableStatus: 'UPDATING' } });
      if (target === 'DeleteTable') return body.TableName === 'gone' ? respond(400, { __type: 'com.amazonaws.dynamodb.v20120810#ResourceNotFoundException', message: 'Requested resource not found' }) : respond(200, { TableDescription: { TableStatus: 'DELETING' } });
      return respond(400, { __type: '#UnknownOperationException' });
    };
    const d = new DynamoDriver(spec, parseAllowList(''), send);
    const r = await d.applyDdl(
      opsPlan('dynamodb', [
        { op: 'dynamodb.updateTable', input: { TableName: 'orders', GlobalSecondaryIndexUpdates: [{ Delete: { IndexName: 'by_status' } }] } },
        { op: 'dynamodb.updateTable', input: { TableName: 'orders', BillingMode: 'PROVISIONED', ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 } } }
      ]),
      10_000
    );
    expect(r).toMatchObject({ applied: 2, detail: /DELETING/ });
    expect(sent.map((s) => s.target)).toEqual(['UpdateTable', 'DescribeTable', 'DescribeTable', 'UpdateTable']);
    expect(sent[0]!.body).toEqual({ TableName: 'orders', GlobalSecondaryIndexUpdates: [{ Delete: { IndexName: 'by_status' } }] });
    expect(sent[3]!.body).toEqual({ TableName: 'orders', BillingMode: 'PROVISIONED', ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 } });

    sent.length = 0;
    expect(await d.applyDdl(opsPlan('dynamodb', [{ op: 'dynamodb.deleteTable', input: { TableName: 'orders' } }]), 5000)).toMatchObject({ applied: 1, detail: /deletes the table in the background/ });
    expect(sent).toEqual([{ target: 'DeleteTable', body: { TableName: 'orders' } }]);
    await expect(d.applyDdl(opsPlan('dynamodb', [{ op: 'dynamodb.deleteTable', input: { TableName: 'gone' } }]), 5000)).rejects.toThrow(/The table gone does not exist.*ResourceNotFoundException/);
    await expect(d.applyDdl(opsPlan('dynamodb', [{ op: 'dynamodb.deleteTable', input: { TableName: 'x' } }]), 5000)).rejects.toThrow(/not a DynamoDB table name/);
    await expect(d.applyDdl(opsPlan('dynamodb', [{ op: 'dynamodb.deleteTable', input: { TableName: 'orders', Extra: 1 } as never }]), 5000)).rejects.toThrow(/only the table name/);
    await expect(d.applyDdl(opsPlan('dynamodb', [{ op: 'cosmos.deleteContainer', id: 'x' }]), 5000)).rejects.toThrow(/do not perform cosmos\.deleteContainer/);
  });

  it('describes a table as dynamoTableSpec: keys with types, billing, GSIs, TTL; reads only', async () => {
    const sent: string[] = [];
    let ttlAllowed = true;
    const send = async (r: GuardedRequest) => {
      const target = r.headers['x-amz-target']!.split('.')[1]!;
      const body = JSON.parse(String(r.body)) as Record<string, unknown>;
      sent.push(target);
      if (target === 'DescribeTable') {
        if (body.TableName === 'missing') return respond(400, { __type: 'com.amazonaws.dynamodb.v20120810#ResourceNotFoundException', message: 'Requested resource not found: Table: missing not found' });
        if (body.TableName === 'ondemand') return respond(200, { Table: { TableName: 'ondemand', TableStatus: 'ACTIVE', AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'N' }], KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }], ProvisionedThroughput: { ReadCapacityUnits: 0, WriteCapacityUnits: 0 } } });
        return respond(200, {
          Table: {
            TableName: 'orders',
            TableStatus: 'ACTIVE',
            AttributeDefinitions: [
              { AttributeName: 'pk', AttributeType: 'S' },
              { AttributeName: 'sk', AttributeType: 'N' },
              { AttributeName: 'status', AttributeType: 'S' },
              { AttributeName: 'blob', AttributeType: 'B' }
            ],
            KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
            BillingModeSummary: { BillingMode: 'PROVISIONED' },
            ProvisionedThroughput: { ReadCapacityUnits: 10, WriteCapacityUnits: 4 },
            GlobalSecondaryIndexes: [
              { IndexName: 'by_status', IndexStatus: 'ACTIVE', KeySchema: [{ AttributeName: 'status', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }], Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: ['total'] }, ProvisionedThroughput: { ReadCapacityUnits: 2, WriteCapacityUnits: 1 } },
              { IndexName: 'by_blob', IndexStatus: 'ACTIVE', KeySchema: [{ AttributeName: 'blob', KeyType: 'HASH' }], Projection: { ProjectionType: 'KEYS_ONLY' }, ProvisionedThroughput: { ReadCapacityUnits: 1, WriteCapacityUnits: 1 } }
            ]
          }
        });
      }
      if (target === 'DescribeTimeToLive') return ttlAllowed ? respond(200, { TimeToLiveDescription: { TimeToLiveStatus: 'ENABLED', AttributeName: 'expiresAt' } }) : respond(400, { __type: 'com.amazon.coral.service#AccessDeniedException', message: 'not authorized to perform: dynamodb:DescribeTimeToLive' });
      return respond(400, { __type: '#UnknownOperationException' });
    };
    const d = new DynamoDriver({ ...spec, username: 'AKIDREAD' }, parseAllowList(''), send);
    const o = await d.describe('orders', 'table', 5000);
    const indexes = [
      { name: 'by_status', partitionKey: { name: 'status', type: 'S' }, sortKey: { name: 'sk', type: 'N' }, projection: 'INCLUDE', nonKeyAttributes: ['total'], readCapacity: 2, writeCapacity: 1 },
      { name: 'by_blob', partitionKey: { name: 'blob', type: 'B' }, projection: 'KEYS_ONLY', nonKeyAttributes: [], readCapacity: 1, writeCapacity: 1 }
    ];
    expect(o).toEqual({
      kind: 'table',
      name: 'orders',
      definition: { name: 'orders', partitionKey: { name: 'pk', type: 'S' }, sortKey: { name: 'sk', type: 'N' }, billingMode: 'PROVISIONED', readCapacity: 10, writeCapacity: 4, indexes, ttlAttribute: 'expiresAt' },
      indexes
    });
    expect(sent).toEqual(['DescribeTable', 'DescribeTimeToLive']);
    ttlAllowed = false;
    expect(await d.describe('ondemand', 'table', 5000)).toEqual({ kind: 'table', name: 'ondemand', definition: { name: 'ondemand', partitionKey: { name: 'id', type: 'N' }, billingMode: 'PAY_PER_REQUEST', indexes: [] }, indexes: [] });
    expect(await d.describe('missing', 'table', 5000)).toBeNull();
    expect(sent.every((t) => t === 'DescribeTable' || t === 'DescribeTimeToLive')).toBe(true);
    await expect(d.describe('orders', 'collection', 5000)).rejects.toThrow(/describe tables, not collection/);
  });
});

describe('Cosmos DB edits and descriptions', () => {
  const key = Buffer.from('cosmos-admin-key-0123456789').toString('base64');
  const spec = (over: Partial<ConnectionSpec> = {}): ConnectionSpec => ({ engine: 'cosmos-nosql', endpoint: 'https://127.0.0.1:8081', database: 'shop', tls: true, username: null, password: key, options: {}, ...over });

  it('replaces and deletes a container and deletes a database, signed over the right resource type and link', async () => {
    const sent: GuardedRequest[] = [];
    const send = async (r: GuardedRequest) => {
      sent.push(r);
      if (r.method === 'PUT' && r.url.pathname === '/dbs/shop/colls/orders') return respond(200, JSON.parse(String(r.body)));
      if (r.method === 'PUT' && r.url.pathname === '/dbs/shop/colls/locked') return respond(400, { code: 'BadRequest', message: 'Partition key paths cannot be changed.' });
      if (r.method === 'DELETE' && (r.url.pathname === '/dbs/shop/colls/old-orders' || r.url.pathname === '/dbs/analytics')) return respond(204, undefined);
      return respond(404, { code: 'NotFound', message: 'Resource Not Found' });
    };
    const d = new CosmosDriver(spec(), parseAllowList(''), { send });
    const body = { id: 'orders', partitionKey: { paths: ['/tenantId'], kind: 'Hash', version: 2 }, defaultTtl: 3600, indexingPolicy: { indexingMode: 'consistent', automatic: true, includedPaths: [{ path: '/*' }], excludedPaths: [{ path: '/blob/*' }] } };
    const r = await d.applyDdl(
      opsPlan('cosmos-nosql', [
        { op: 'cosmos.replaceContainer', body },
        { op: 'cosmos.deleteContainer', id: 'old-orders' },
        { op: 'cosmos.deleteDatabase', id: 'analytics' }
      ]),
      5000
    );
    expect(r).toEqual({ applied: 3, detail: 'Replaced container orders, deleted container old-orders, deleted database analytics.' });
    const [put, delC, delD] = sent;
    expect(put!.method).toBe('PUT');
    expect(put!.url.pathname).toBe('/dbs/shop/colls/orders');
    expect(JSON.parse(String(put!.body))).toEqual(body);
    expect(put!.headers['content-type']).toBe('application/json');
    expect(put!.headers.authorization).toBe(masterKeyAuth({ verb: 'PUT', resourceType: 'colls', resourceLink: 'dbs/shop/colls/orders', date: put!.headers['x-ms-date']!, key }));
    expect(delC!.method).toBe('DELETE');
    expect(delC!.body).toBeUndefined();
    expect(delC!.headers.authorization).toBe(masterKeyAuth({ verb: 'DELETE', resourceType: 'colls', resourceLink: 'dbs/shop/colls/old-orders', date: delC!.headers['x-ms-date']!, key }));
    expect(delD!.url.pathname).toBe('/dbs/analytics');
    expect(delD!.headers.authorization).toBe(masterKeyAuth({ verb: 'DELETE', resourceType: 'dbs', resourceLink: 'dbs/analytics', date: delD!.headers['x-ms-date']!, key }));

    await expect(d.applyDdl(opsPlan('cosmos-nosql', [{ op: 'cosmos.deleteContainer', id: 'gone' }]), 5000)).rejects.toThrow(/The container gone does not exist.*404/);
    await expect(d.applyDdl(opsPlan('cosmos-nosql', [{ op: 'cosmos.replaceContainer', body: { ...body, id: 'locked' } }]), 5000)).rejects.toThrow(/partition key and unique keys cannot change.*400/);
    await expect(d.applyDdl(opsPlan('cosmos-nosql', [{ op: 'cosmos.deleteContainer', id: 'a/b' }]), 5000)).rejects.toThrow(/not a Cosmos DB container id/);
    await expect(d.applyDdl(opsPlan('cosmos-nosql', [{ op: 'cosmos.deleteDatabase', id: 'analytics' }, { op: 'cosmos.deleteDatabase', id: 'nope' }]), 5000)).rejects.toThrow(/1 of 2 operations were applied before it/);
    await expect(d.applyDdl(opsPlan('cosmos-nosql', [{ op: 'mongo.dropCollection', name: 'x' }]), 5000)).rejects.toThrow(/do not perform mongo\.dropCollection/);
    const entra = new CosmosDriver(spec({ password: null, bearer: 'entra-token' }), parseAllowList(''), { send: async () => respond(403, { code: 'Forbidden', message: 'blocked' }) });
    await expect(entra.applyDdl(opsPlan('cosmos-nosql', [{ op: 'cosmos.deleteContainer', id: 'orders' }]), 5000)).rejects.toThrow(/Entra tokens cannot/);
  });

  it('describes a container as cosmosContainerSpec with one signed GET', async () => {
    const sent: GuardedRequest[] = [];
    const send = async (r: GuardedRequest) => {
      sent.push(r);
      if (r.url.pathname === '/dbs/shop/colls/orders')
        return respond(200, {
          id: 'orders',
          _rid: 'x',
          partitionKey: { paths: ['/tenantId', '/userId'], kind: 'MultiHash', version: 2 },
          defaultTtl: -1,
          uniqueKeyPolicy: { uniqueKeys: [{ paths: ['/email'] }, { paths: ['/sku', '/region'] }] },
          indexingPolicy: { indexingMode: 'consistent', automatic: true, includedPaths: [{ path: '/*' }], excludedPaths: [{ path: '/blob/*' }, { path: '/"_etag"/?' }] }
        });
      if (r.url.pathname === '/dbs/shop/colls/plain') return respond(200, { id: 'plain', partitionKey: { paths: ['/id'], kind: 'Hash' }, indexingPolicy: { excludedPaths: [{ path: '/"_etag"/?' }] } });
      return respond(404, { code: 'NotFound', message: 'Resource Not Found' });
    };
    const d = new CosmosDriver(spec(), parseAllowList(''), { send });
    expect(await d.describe('orders', 'container', 5000)).toEqual({ kind: 'container', name: 'orders', definition: { name: 'orders', partitionKeyPaths: ['/tenantId', '/userId'], defaultTtl: -1, uniqueKeys: [['/email'], ['/sku', '/region']], excludedPaths: ['/blob/*'] } });
    expect(sent[0]!.method).toBe('GET');
    expect(sent[0]!.headers.authorization).toBe(masterKeyAuth({ verb: 'GET', resourceType: 'colls', resourceLink: 'dbs/shop/colls/orders', date: sent[0]!.headers['x-ms-date']!, key }));
    expect(await d.describe('plain', 'container', 5000)).toEqual({ kind: 'container', name: 'plain', definition: { name: 'plain', partitionKeyPaths: ['/id'], uniqueKeys: [], excludedPaths: [] } });
    expect(await d.describe('missing', 'container', 5000)).toBeNull();
    expect(sent.every((s) => s.method === 'GET')).toBe(true);
    await expect(d.describe('orders', 'table', 5000)).rejects.toThrow(/describe containers, not table/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// InfluxDB and RabbitMQ (in-process HTTP)
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

describe('InfluxDB database drops', () => {
  let http: FakeHttp;
  const dbs = new Set<string>();
  beforeEach(async () => {
    dbs.clear();
    dbs.add('metrics');
    http = await new FakeHttp((r, res) => {
      const u = new URL(r.path, 'http://x');
      if (r.method === 'POST' && u.pathname === '/query') {
        const q = new URLSearchParams(r.body).get('q') ?? '';
        if (!/^DROP DATABASE "[^"]+"$/.test(q)) return json(res, 400, { error: `error parsing query: ${q}` });
        return json(res, 200, { results: [{ statement_id: 0 }] });
      }
      if (r.method === 'DELETE' && u.pathname === '/api/v3/configure/database') {
        const db = u.searchParams.get('db') ?? '';
        if (!dbs.delete(db)) return json(res, 404, { error: 'database not found' });
        res.writeHead(200);
        return res.end();
      }
      json(res, 404, { error: 'not found' });
    }).start();
  });
  afterEach(async () => http.stop());

  const spec = (version: string): ConnectionSpec => ({ engine: 'influxdb', endpoint: http.url, database: 'telemetry', tls: false, username: version === 'v1' ? 'admin' : null, password: 'secret', options: { version } });

  it('1.x: DROP DATABASE as a form POST; 3: DELETE with ?db=; 2.x refused; names checked', async () => {
    expect(await new InfluxDriver(spec('v1')).applyDdl(opsPlan('influxdb', [{ op: 'influx.dropDatabase', name: 'old.metrics' }]), 5000)).toEqual({ applied: 1 });
    expect(http.requests[0]).toMatchObject({ method: 'POST', path: '/query' });
    expect(http.requests[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(new URLSearchParams(http.requests[0]!.body).get('q')).toBe('DROP DATABASE "old.metrics"');

    expect(await new InfluxDriver(spec('v3')).applyDdl(opsPlan('influxdb', [{ op: 'influx.dropDatabase', name: 'metrics' }]), 5000)).toEqual({ applied: 1 });
    expect(http.requests[1]).toMatchObject({ method: 'DELETE', path: '/api/v3/configure/database?db=metrics', body: '' });
    expect(http.requests[1]!.headers.authorization).toBe('Bearer secret');
    await expect(new InfluxDriver(spec('v3')).applyDdl(opsPlan('influxdb', [{ op: 'influx.dropDatabase', name: 'metrics' }]), 5000)).rejects.toThrow(/404.*does not exist/);

    await expect(new InfluxDriver(spec('v2')).applyDdl(opsPlan('influxdb', [{ op: 'influx.dropDatabase', name: 'x' }]), 5000)).rejects.toThrow(/2\.x makes buckets/);
    await expect(new InfluxDriver(spec('v1')).applyDdl(opsPlan('influxdb', [{ op: 'influx.dropDatabase', name: 'x"; DROP' }]), 5000)).rejects.toThrow(/not an InfluxDB database name/);
    await expect(new InfluxDriver(spec('v1')).applyDdl(opsPlan('influxdb', [{ op: 'redis.xgroupDestroy', key: 'k', group: 'g' }]), 5000)).rejects.toThrow(/do not perform redis\.xgroupDestroy/);
    expect(http.requests).toHaveLength(3);
  });
});

describe('RabbitMQ deletes and descriptions', () => {
  let http: FakeHttp;
  beforeEach(async () => {
    http = await new FakeHttp((r, res) => {
      const u = new URL(r.path, 'http://x');
      const seg = u.pathname.split('/').slice(1).map(decodeURIComponent);
      if (r.method === 'DELETE' && seg[1] === 'queues') {
        if (seg[3] === 'missing') return json(res, 404, { error: 'Object Not Found', reason: 'Not Found' });
        if (seg[3] === 'busy' && u.searchParams.get('if-empty') === 'true') return json(res, 400, { error: 'bad_request', reason: "PRECONDITION_FAILED - queue 'busy' in vhost '/' not empty" });
        res.writeHead(204);
        return res.end();
      }
      if (r.method === 'DELETE' && seg[1] === 'exchanges') {
        if (seg[3] === 'bound' && u.searchParams.get('if-unused') === 'true') return json(res, 400, { error: 'bad_request', reason: "PRECONDITION_FAILED - exchange 'bound' in use" });
        res.writeHead(204);
        return res.end();
      }
      if (r.method === 'DELETE' && seg[1] === 'bindings') {
        if (seg[7] === 'nope') return json(res, 404, { error: 'Object Not Found', reason: 'Not Found' });
        res.writeHead(204);
        return res.end();
      }
      if (r.method === 'GET' && seg[1] === 'queues' && seg.length === 4) {
        if (seg[3] === 'orders')
          return json(res, 200, {
            name: 'orders',
            vhost: seg[2],
            type: 'quorum',
            durable: true,
            auto_delete: false,
            arguments: { 'x-queue-type': 'quorum', 'x-dead-letter-exchange': 'dlx', 'x-delivery-limit': 5, 'x-max-length': 1000, 'x-overflow': 'reject-publish', 'x-custom': 'kept out' },
            messages_ready: 3
          });
        if (seg[3] === 'mail') return json(res, 200, { name: 'mail', vhost: seg[2], type: 'classic', durable: false, auto_delete: true, arguments: { 'x-max-priority': 10 } });
        return json(res, 404, { error: 'Object Not Found', reason: 'Not Found' });
      }
      if (r.method === 'GET' && seg[1] === 'exchanges' && seg.length === 4) {
        if (seg[3] === 'events/topic') return json(res, 200, { name: 'events/topic', vhost: seg[2], type: 'topic', durable: true, auto_delete: false, internal: false, arguments: { 'alternate-exchange': 'unrouted' } });
        return json(res, 404, { error: 'Object Not Found', reason: 'Not Found' });
      }
      json(res, 405, { error: 'Method Not Allowed', reason: 'no' });
    }).start();
  });
  afterEach(async () => http.stop());

  const driver = (over: Partial<ConnectionSpec> = {}) => new RabbitDriver({ engine: 'rabbitmq', endpoint: http.url, database: null, tls: false, username: 'admin', password: 'pw', options: {}, ...over });

  it('deletes queues, exchanges and bindings with the guards, percent-encoding every part', async () => {
    const d = driver();
    const r = await d.applyDdl(
      opsPlan('rabbitmq', [
        { op: 'rabbit.unbind', vhost: 'shop', source: 'events/topic', destination: 'orders.v2', destinationType: 'q', propertiesKey: 'order.*' },
        { op: 'rabbit.deleteQueue', vhost: '/', name: 'orders.v2', ifEmpty: true, ifUnused: true },
        { op: 'rabbit.deleteQueue', vhost: '/', name: 'scratch', ifEmpty: false, ifUnused: false },
        { op: 'rabbit.deleteExchange', vhost: 'shop', name: 'events/topic', ifUnused: true }
      ]),
      5000
    );
    expect(r).toMatchObject({ applied: 4, detail: /^Removed binding events\/topic → orders\.v2, deleted queue \/\/orders\.v2, deleted queue \/\/scratch, deleted exchange shop\/events\/topic\.$/ });
    expect(d.sent).toEqual([
      { method: 'DELETE', path: '/api/bindings/shop/e/events%2Ftopic/q/orders.v2/order.*' },
      { method: 'DELETE', path: '/api/queues/%2F/orders.v2?if-empty=true&if-unused=true' },
      { method: 'DELETE', path: '/api/queues/%2F/scratch' },
      { method: 'DELETE', path: '/api/exchanges/shop/events%2Ftopic?if-unused=true' }
    ]);
    expect(http.requests[0]!.headers.authorization).toBe('Basic ' + Buffer.from('admin:pw').toString('base64'));
    // Exchange-to-exchange, and a properties key with characters to encode.
    await d.applyDdl(opsPlan('rabbitmq', [{ op: 'rabbit.unbind', vhost: '/', source: 'a', destination: 'b', destinationType: 'e', propertiesKey: 'k~x/y%' }]), 5000);
    expect(d.sent.at(-1)).toEqual({ method: 'DELETE', path: '/api/bindings/%2F/e/a/e/b/k~x%2Fy%25' });
  });

  it('explains 404s and the if-empty / if-unused refusals, and refuses what is not deleted', async () => {
    const d = driver();
    await expect(d.applyDdl(opsPlan('rabbitmq', [{ op: 'rabbit.deleteQueue', vhost: '/', name: 'missing', ifEmpty: true, ifUnused: true }]), 5000)).rejects.toThrow(/^The queue \/\/missing does not exist\. RabbitMQ 404/);
    await expect(d.applyDdl(opsPlan('rabbitmq', [{ op: 'rabbit.deleteQueue', vhost: '/', name: 'busy', ifEmpty: true, ifUnused: false }]), 5000)).rejects.toThrow(/The queue \/\/busy was kept: it still has messages\..*PRECONDITION_FAILED/);
    await expect(d.applyDdl(opsPlan('rabbitmq', [{ op: 'rabbit.deleteQueue', vhost: '/', name: 'busy', ifEmpty: true, ifUnused: true }]), 5000)).rejects.toThrow(/still has messages or consumers/);
    await expect(d.applyDdl(opsPlan('rabbitmq', [{ op: 'rabbit.deleteExchange', vhost: '/', name: 'bound', ifUnused: true }]), 5000)).rejects.toThrow(/exchange \/\/bound was kept: it still has bindings/);
    await expect(d.applyDdl(opsPlan('rabbitmq', [{ op: 'rabbit.unbind', vhost: '/', source: 'x', destination: 'q', destinationType: 'q', propertiesKey: 'nope' }]), 5000)).rejects.toThrow(/The binding x → q does not exist/);
    await expect(d.applyDdl(opsPlan('rabbitmq', [{ op: 'rabbit.deleteExchange', vhost: '/', name: 'amq.topic', ifUnused: true }]), 5000)).rejects.toThrow(/RabbitMQ's own exchanges/);
    await expect(d.applyDdl(opsPlan('rabbitmq', [{ op: 'rabbit.deleteExchange', vhost: '/', name: '', ifUnused: true }]), 5000)).rejects.toThrow(/default exchange/);
    await expect(d.applyDdl(opsPlan('rabbitmq', [{ op: 'rabbit.unbind', vhost: '/', source: 'x', destination: 'q', destinationType: 'q', propertiesKey: '' }]), 5000)).rejects.toThrow(/properties key/);
    await expect(d.applyDdl(opsPlan('rabbitmq', [{ op: 'rabbit.deleteQueue', vhost: '/', name: 'ok', ifEmpty: false, ifUnused: false }, { op: 'rabbit.deleteQueue', vhost: '/', name: 'missing', ifEmpty: false, ifUnused: false }]), 5000)).rejects.toThrow(/1 of 2 operations were applied before it/);
    await expect(d.applyDdl(opsPlan('rabbitmq', [{ op: 'influx.dropDatabase', name: 'x' }]), 5000)).rejects.toThrow(/do not perform influx\.dropDatabase/);
  });

  it('describes queues and exchanges in the create form shape with GETs only', async () => {
    const d = driver({ username: 'reader', database: 'shop' });
    expect(await d.describe('//orders', 'queue', 5000)).toEqual({
      kind: 'queue',
      name: '//orders',
      definition: { vhost: '/', name: 'orders', type: 'quorum', durable: true, autoDelete: false, arguments: { deadLetterExchange: 'dlx', deliveryLimit: 5, maxLength: 1000, overflow: 'reject-publish' } }
    });
    expect(d.sent.at(-1)).toEqual({ method: 'GET', path: '/api/queues/%2F/orders' });
    // A bare name is in the connection's vhost.
    expect(await d.describe('mail', 'queue', 5000)).toEqual({ kind: 'queue', name: 'shop/mail', definition: { vhost: 'shop', name: 'mail', type: 'classic', durable: false, autoDelete: true, arguments: { maxPriority: 10 } } });
    expect(await d.describe('shop/events/topic', 'exchange', 5000)).toEqual({ kind: 'exchange', name: 'shop/events/topic', definition: { vhost: 'shop', name: 'events/topic', type: 'topic', durable: true, autoDelete: false, internal: false, alternateExchange: 'unrouted' } });
    expect(d.sent.at(-1)).toEqual({ method: 'GET', path: '/api/exchanges/shop/events%2Ftopic' });
    expect(await d.describe('//missing', 'queue', 5000)).toBeNull();
    expect(await d.describe('//missing', 'exchange', 5000)).toBeNull();
    expect(d.sent.every((s) => s.method === 'GET')).toBe(true);
    await expect(d.describe('//orders', 'stream-group', 5000)).rejects.toThrow(/describe queues and exchanges/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Redis (an in-process RESP2 fake)
// ---------------------------------------------------------------------------------------------------------------

interface Group {
  name: string;
  consumers: number;
  pending: number;
  last: string;
}

class FakeRedis {
  server!: TcpServer;
  port = 0;
  seen: string[][] = [];
  sockets = new Set<Socket>();
  streams = new Map<string, Group[]>();
  strings = new Set<string>();

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

  private reply(a: string[]): string {
    const cmd = a[0]!.toUpperCase();
    switch (cmd) {
      case 'AUTH':
        return a[2] === 'pw' || a[1] === 'pw' ? '+OK\r\n' : '-WRONGPASS invalid username-password pair\r\n';
      case 'SELECT':
      case 'QUIT':
        return '+OK\r\n';
      case 'TYPE':
        return `+${this.streams.has(a[1]!) ? 'stream' : this.strings.has(a[1]!) ? 'string' : 'none'}\r\n`;
      case 'XINFO': {
        const g = this.streams.get(a[2]!);
        if (!g) return '-ERR no such key\r\n';
        return this.enc(g.map((x) => ['name', x.name, 'consumers', x.consumers, 'pending', x.pending, 'last-delivered-id', x.last, 'entries-read', 1, 'lag', 0]));
      }
      case 'XGROUP': {
        const sub = a[1]!.toUpperCase();
        const g = this.streams.get(a[2]!);
        if (sub === 'DESTROY') {
          if (!g) return '-ERR The XGROUP subcommand requires the key to exist. Note that for CREATE you may want to use the MKSTREAM option to create an empty stream automatically.\r\n';
          const at = g.findIndex((x) => x.name === a[3]);
          if (at < 0) return ':0\r\n';
          g.splice(at, 1);
          return ':1\r\n';
        }
        if (sub === 'SETID') {
          if (!g) return '-ERR The XGROUP subcommand requires the key to exist. Note that for CREATE you may want to use the MKSTREAM option to create an empty stream automatically.\r\n';
          const x = g.find((y) => y.name === a[3]);
          if (!x) return `-NOGROUP No such consumer group '${a[3]}' for key name '${a[2]}'\r\n`;
          x.last = a[4]!;
          return '+OK\r\n';
        }
        return '-ERR unknown subcommand\r\n';
      }
      default:
        return `-ERR unknown command '${a[0]}'\r\n`;
    }
  }
}

describe('Redis stream group edits and descriptions', () => {
  let fake: FakeRedis;
  beforeEach(async () => {
    fake = await new FakeRedis().start();
    fake.streams.set('events:orders', [
      { name: 'billing', consumers: 2, pending: 1, last: '1700000000001-0' },
      { name: 'shipping', consumers: 1, pending: 0, last: '0-0' }
    ]);
    fake.strings.add('plain');
  });
  afterEach(async () => fake.stop());

  const driver = (over: Partial<ConnectionSpec> = {}) => new RedisDriver({ engine: 'redis', endpoint: `127.0.0.1:${fake.port}`, database: '0', tls: false, username: 'admin', password: 'pw', options: {}, ...over });
  const sent = () => fake.seen.filter((x) => !['AUTH', 'SELECT', 'QUIT', 'CLIENT', 'INFO'].includes(x[0]!.toUpperCase()));

  it('XGROUP SETID and DESTROY: exactly those commands; a missing group or stream said plainly', async () => {
    fake.seen = [];
    expect(
      await driver().applyDdl(
        opsPlan('redis', [
          { op: 'redis.xgroupSetId', key: 'events:orders', group: 'shipping', id: '$' },
          { op: 'redis.xgroupDestroy', key: 'events:orders', group: 'billing' }
        ]),
        3000
      )
    ).toEqual({ applied: 2, detail: 'Set group shipping on events:orders to $, removed group billing from events:orders.' });
    expect(sent()).toEqual([
      ['XGROUP', 'SETID', 'events:orders', 'shipping', '$'],
      ['XGROUP', 'DESTROY', 'events:orders', 'billing']
    ]);
    expect(fake.streams.get('events:orders')!.map((g) => [g.name, g.last])).toEqual([['shipping', '$']]);

    await expect(driver().applyDdl(opsPlan('redis', [{ op: 'redis.xgroupDestroy', key: 'events:orders', group: 'billing' }]), 3000)).rejects.toThrow(/^The group does not exist\.$/);
    await expect(driver().applyDdl(opsPlan('redis', [{ op: 'redis.xgroupSetId', key: 'events:orders', group: 'nope', id: '0' }]), 3000)).rejects.toThrow(/^The group does not exist\.$/);
    await expect(driver().applyDdl(opsPlan('redis', [{ op: 'redis.xgroupDestroy', key: 'events:none', group: 'g' }]), 3000)).rejects.toThrow(/^The stream events:none does not exist\.$/);
    await expect(driver().applyDdl(opsPlan('redis', [{ op: 'redis.xgroupSetId', key: 'events:orders', group: 'shipping', id: '0; FLUSHALL' }]), 3000)).rejects.toThrow(/an id \(\$, 0 or an entry id\)/);
    await expect(driver().applyDdl(opsPlan('redis', [{ op: 'redis.xgroupSetId', key: 'events:orders', group: 'shipping', id: '1-0' }, { op: 'redis.xgroupDestroy', key: 'events:orders', group: 'nope' }]), 3000)).rejects.toThrow(/does not exist\. \(1 of 2 operations were applied before it\.\)/);
    await expect(driver().applyDdl(opsPlan('redis', [{ op: 'rabbit.unbind', vhost: '/', source: 'a', destination: 'b', destinationType: 'q', propertiesKey: '~' }]), 3000)).rejects.toThrow(/do not perform rabbit\.unbind/);
  });

  it('describes a stream\'s groups with TYPE and XINFO GROUPS only', async () => {
    fake.seen = [];
    const d = driver({ username: 'reader' });
    expect(await d.describe('events:orders', 'stream-group', 3000)).toEqual({
      kind: 'stream-group',
      name: 'events:orders',
      definition: {
        key: 'events:orders',
        groups: [
          { name: 'billing', lastDeliveredId: '1700000000001-0', consumers: 2, pending: 1 },
          { name: 'shipping', lastDeliveredId: '0-0', consumers: 1, pending: 0 }
        ]
      }
    });
    expect(await d.describe('events:none', 'stream-group', 3000)).toBeNull();
    await expect(d.describe('plain', 'stream-group', 3000)).rejects.toThrow(/plain is a string, not a stream/);
    expect(sent()).toEqual([['TYPE', 'events:orders'], ['XINFO', 'GROUPS', 'events:orders'], ['TYPE', 'events:none'], ['TYPE', 'plain']]);
    await expect(d.describe('events:orders', 'queue', 3000)).rejects.toThrow(/describe stream groups, not queue/);
  });
});

// The create path still describes what it made in the same words (a smoke check that plans and edits share a driver).
describe('create plans still apply alongside edits', () => {
  it('a Mongo create plan reports as before', async () => {
    const f = new FakeMongo();
    const d = new MongoDriver({ engine: 'mongodb', endpoint: '127.0.0.1:27017', database: 'shop', tls: false, username: 'admin/root', password: 'pw', options: {} }, parseAllowList(''), async (x) => ({ ...(await f.opener(x)), createCollection: async () => undefined }));
    expect(await d.applyDdl(createPlan('mongodb', { kind: 'collection', name: 'fresh' }), 5000)).toEqual({ applied: 1, detail: 'Created collection fresh.' });
  });
});
