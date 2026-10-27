/*
 * 2.0.x: schema changes and queue inspection through data connections. The builder (ddl.ts) per dialect: vendor
 * types and their parameters, constraints, identity columns, routines, datasets, and the non-SQL operations; the
 * expression scanner that keeps a default, CHECK or predicate inside its place. Then the API: the admin account
 * (sealed, never shown, separate from the read account), preview with blockers, apply only with the previewed hash,
 * on the admin account, refreshing the schema and the allow-list, audited; and the Queues tab's read.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPlan, DdlProblem, expressionProblem, type DdlPlan } from '../src/connections/ddl.js';
import { renderType, typesOf } from '../src/connections/ddl-types.js';
import type { ConnectionSpec, DataDriver, QueueInfo, SchemaObject } from '../src/connections/drivers.js';
import type { Engine } from '../src/connections/engines.js';
import { setCustomRoles } from '../src/authz/permissions.js';
import { loginAdmin, localUser, type Harness } from './helpers.js';
import { harnessWith } from './retrieval-seed.js';

const ctx = (engine: Engine, database: string | null = 'db', options: Record<string, unknown> = {}) => ({ engine, database, account: 'app', options });
const plan = (engine: Engine, def: unknown, database: string | null = 'db', options: Record<string, unknown> = {}) => buildPlan(engine, ctx(engine, database, options), def);
const problems = (engine: Engine, def: unknown, database: string | null = 'db', options: Record<string, unknown> = {}) => {
  try {
    plan(engine, def, database, options);
  } catch (err) {
    if (err instanceof DdlProblem) return err.problems;
    throw err;
  }
  return [];
};

const orders = (t: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  kind: 'table',
  name: 'sales.orders',
  columns: [
    { name: 'id', type: { type: t.id }, identity: t.identity !== 'no', nullable: false },
    { name: 'note', type: { type: t.text, length: 200 }, default: { kind: 'literal', value: "it's" } },
    { name: 'amount', type: { type: t.dec, precision: 12, scale: 2 }, nullable: false, default: { kind: 'literal', value: 0 } }
  ],
  primaryKey: ['id'],
  ...extra
});

describe('vendor types', () => {
  it('renders types with their parameters and refuses the ones a vendor would reject', () => {
    expect(renderType('postgres', { type: 'numeric', precision: 12, scale: 2 })).toEqual({ text: 'numeric(12, 2)' });
    expect(renderType('postgres', { type: 'timestamptz', precision: 3 })).toEqual({ text: 'timestamptz(3)' });
    expect(renderType('postgres', { type: 'text', array: true })).toEqual({ text: 'text[]' });
    expect(renderType('mysql', { type: 'VARCHAR' })).toMatchObject({ problem: 'VARCHAR needs a length.' });
    expect(renderType('mysql', { type: 'INT', unsigned: true })).toEqual({ text: 'INT UNSIGNED' });
    expect(renderType('mysql', { type: 'ENUM', values: ['a', "b'c"] })).toEqual({ text: "ENUM('a', 'b''c')" });
    expect(renderType('mysql', { type: 'DECIMAL', precision: 66 })).toHaveProperty('problem');
    expect(renderType('tsql', { type: 'NVARCHAR', length: 'max' })).toEqual({ text: 'NVARCHAR(MAX)' });
    expect(renderType('tsql', { type: 'NVARCHAR', length: 4001 })).toHaveProperty('problem');
    expect(renderType('tsql', { type: 'CHAR', length: 'max' })).toHaveProperty('problem');
    expect(renderType('tsql', { type: 'DATETIME2', precision: 8 })).toHaveProperty('problem');
    expect(renderType('oracle', { type: 'TIMESTAMP WITH TIME ZONE', precision: 6 })).toEqual({ text: 'TIMESTAMP(6) WITH TIME ZONE' });
    expect(renderType('oracle', { type: 'NUMBER', precision: 10, scale: -2 })).toEqual({ text: 'NUMBER(10, -2)' });
    expect(renderType('oracle', { type: 'VARCHAR2', length: 20 }, { forRoutine: true })).toEqual({ text: 'VARCHAR2' });
    expect(renderType('bigquery', { type: 'NUMERIC', precision: 30, scale: 0 })).toHaveProperty('problem');
    expect(renderType('bigquery', { type: 'BIGNUMERIC', precision: 50, scale: 20 })).toEqual({ text: 'BIGNUMERIC(50, 20)' });
    expect(renderType('sqlite', { type: 'VARCHAR', length: 10 })).toHaveProperty('problem');
    expect(renderType('snowflake', { type: 'VARCHAR', length: 16_777_216 })).toEqual({ text: 'VARCHAR(16777216)' });
    expect(renderType('postgres', { type: 'int' })).toHaveProperty('problem');
    for (const d of ['postgres', 'mysql', 'tsql', 'oracle', 'snowflake', 'bigquery', 'sqlite'] as const) expect(typesOf(d).length).toBeGreaterThan(4);
  });
});

describe('expressions', () => {
  it('keeps a default, CHECK or predicate inside its place', () => {
    expect(expressionProblem('postgres', "status IN ('a', 'b;c')")).toBeNull();
    expect(expressionProblem('postgres', 'now()')).toBeNull();
    expect(expressionProblem('postgres', '1); DROP TABLE t; --')).not.toBeNull();
    expect(expressionProblem('postgres', '1; DROP TABLE t')).toMatch(/;/);
    expect(expressionProblem('postgres', "'open")).toMatch(/string/);
    expect(expressionProblem('postgres', 'a /* x */')).toMatch(/Comments/);
    expect(expressionProblem('postgres', '$x$ y $x$')).toMatch(/Dollar/);
    expect(expressionProblem('mysql', "'a\\'; DROP TABLE t; --'")).toBeNull(); // the backslash keeps the quote in the string
    expect(expressionProblem('mysql', 'a # b')).toMatch(/Comments/);
    expect(expressionProblem('tsql', '[a;b] > 0')).toBeNull();
    expect(expressionProblem('postgres', '((a > 0)')).toMatch(/not closed/);
  });
});

describe('the plan per dialect', () => {
  it('writes CREATE TABLE in each vendor\'s spelling', () => {
    const pg = plan('postgres', { ...orders({ id: 'bigint', text: 'varchar', dec: 'numeric' }), checks: [{ expression: 'amount >= 0' }], comment: 'Orders' });
    expect(pg.statements[0]).toBe(`CREATE TABLE "sales"."orders" (\n  "id" bigint GENERATED BY DEFAULT AS IDENTITY NOT NULL,\n  "note" varchar(200) DEFAULT 'it''s',\n  "amount" numeric(12, 2) NOT NULL DEFAULT 0,\n  CONSTRAINT "pk_orders" PRIMARY KEY ("id"),\n  CONSTRAINT "ck_orders_1" CHECK (amount >= 0)\n)`);
    expect(pg.statements[1]).toBe(`COMMENT ON TABLE "sales"."orders" IS 'Orders'`);
    expect(pg).toMatchObject({ transactional: true, object: 'sales.orders', touches: [] });
    expect(pg.hash).toMatch(/^[0-9a-f]{64}$/);

    const my = plan('mysql', orders({ id: 'BIGINT', text: 'VARCHAR', dec: 'DECIMAL' }, { options: { charset: 'utf8mb4' } }));
    expect(my.statements[0]).toContain('`id` BIGINT AUTO_INCREMENT NOT NULL');
    expect(my.statements[0]).toMatch(/\)\nENGINE=InnoDB\nDEFAULT CHARSET=utf8mb4$/);
    expect(my.transactional).toBe(false);

    const ms = plan('mssql', orders({ id: 'BIGINT', text: 'NVARCHAR', dec: 'DECIMAL' }));
    expect(ms.statements[0]).toContain('[id] BIGINT IDENTITY(1, 1) NOT NULL');
    expect(ms.statements[0]).toContain("[note] NVARCHAR(200) NULL DEFAULT N'it''s'");

    const ora = plan('oracle', orders({ id: 'NUMBER', text: 'VARCHAR2', dec: 'NUMBER' }));
    expect(ora.statements[0]).toContain('"SALES"."ORDERS"');
    expect(ora.statements[0]).toContain('"AMOUNT" NUMBER(12, 2) DEFAULT 0 NOT NULL');

    const bq = plan('bigquery', { ...orders({ id: 'INT64', text: 'STRING', dec: 'NUMERIC', identity: 'no' }), options: { clusterBy: ['id'] } });
    expect(bq.statements[0]).toContain("`note` STRING(200) DEFAULT 'it\\'s'");
    expect(bq.statements[0]).toContain('PRIMARY KEY (`id`) NOT ENFORCED');

    const d1 = plan('cloudflare-d1', { kind: 'table', name: 'items', columns: [{ name: 'id', type: { type: 'INTEGER' }, identity: true }, { name: 'at', type: { type: 'TEXT' }, default: { kind: 'expression', sql: "datetime('now')" } }], primaryKey: ['id'], options: { strict: true } });
    expect(d1.statements[0]).toBe(`CREATE TABLE "items" (\n  "id" INTEGER PRIMARY KEY AUTOINCREMENT,\n  "at" TEXT DEFAULT (datetime('now'))\n)\nSTRICT`);
  });

  it('refuses what a vendor would refuse, with every problem at once', () => {
    expect(problems('bigquery', orders({ id: 'INT64', text: 'STRING', dec: 'NUMERIC' }))).toContain('BigQuery has no identity columns; use GENERATE_UUID() as a default instead.');
    expect(problems('mysql', { ...orders({ id: 'BIGINT', text: 'VARCHAR', dec: 'DECIMAL' }), primaryKey: [] })).toContain('id: MySQL needs an AUTO_INCREMENT column in the primary key.');
    expect(problems('snowflake', { ...orders({ id: 'NUMBER', text: 'VARCHAR', dec: 'NUMBER' }), checks: [{ expression: 'amount > 0' }] })).toContain('Snowflake has no CHECK constraints.');
    expect(problems('oracle', { ...orders({ id: 'NUMBER', text: 'VARCHAR2', dec: 'NUMBER' }), ifNotExists: true }).join(' ')).toMatch(/IF NOT EXISTS/);
    const many = problems('postgres', { kind: 'table', name: 'a.b.c', columns: [{ name: 'x-y', type: { type: 'varchar', precision: 3 } }, { name: 'x', type: { type: 'integer' } }, { name: 'X', type: { type: 'integer' } }], primaryKey: ['nope'] });
    expect(many.length).toBeGreaterThanOrEqual(3);
    expect(many.join(' ')).toMatch(/too many parts/);
    expect(many.join(' ')).toMatch(/listed twice/);
    expect(many.join(' ')).toMatch(/not a column/);
    expect(problems('postgres', { kind: 'table', name: 't', columns: [{ name: 'a', type: { type: 'integer' } }], checks: [{ expression: '1) ; DROP TABLE x; --' }] }).join(' ')).toMatch(/CHECK/);
    expect(problems('postgres', { kind: 'table', name: 't', columns: [{ name: 'a', type: { type: 'integer' }, default: { kind: 'literal', value: 'x' } }] })).toContain('The default of a must be a whole number.');
    expect(problems('postgres', { kind: 'view', name: 'v' })[0]).toMatch(/^kind:/);
    expect(problems('prometheus', { kind: 'table', name: 't' })[0]).toMatch(/no schema changes/);
  });

  it('writes indexes, with the table as an object it acts on', () => {
    const p = plan('postgres', { kind: 'index', name: 'ix_open', table: 'sales.orders', columns: [{ name: 'note', order: 'desc' }], include: ['amount'], where: "note <> ''", concurrently: true });
    expect(p.statements).toEqual([`CREATE INDEX CONCURRENTLY "ix_open" ON "sales"."orders" ("note" DESC) INCLUDE ("amount") WHERE note <> ''`]);
    expect(p).toMatchObject({ transactional: false, touches: ['sales.orders'] });
    expect(plan('mssql', { kind: 'index', name: 'ix', table: 'dbo.t', columns: [{ name: 'a' }], unique: true, method: 'clustered' }).statements[0]).toBe('CREATE UNIQUE CLUSTERED INDEX [ix] ON [dbo].[t] ([a])');
    expect(plan('oracle', { kind: 'index', name: 'ix', table: 't', columns: [{ name: 'a' }], method: 'bitmap' }, 'FREEPDB1', { schema: 'hr' }).statements[0]).toBe('CREATE BITMAP INDEX "HR"."IX" ON "T" ("A")');
    expect(plan('bigquery', { kind: 'index', name: 'ix', table: 'ds.t', allColumns: true }).statements[0]).toBe('CREATE SEARCH INDEX `ix` ON `ds`.`t` (ALL COLUMNS)');
    expect(problems('snowflake', { kind: 'index', name: 'ix', table: 't', columns: [{ name: 'a' }] }).join(' ')).toMatch(/offers table, procedure/);
    expect(problems('mysql', { kind: 'index', name: 'ix', table: 't', columns: [{ name: 'a' }], where: 'a > 1' }).join(' ')).toMatch(/Partial/);
  });

  it('wraps routine bodies so they cannot leave their place', () => {
    const fn = plan('postgres', { kind: 'function', name: 'add_one', params: [{ name: 'x', type: { type: 'integer' } }], returns: { type: 'integer' }, language: 'sql', body: 'SELECT x + 1 $exprsn$', volatility: 'immutable' });
    expect(fn.statements[0]).toBe('CREATE FUNCTION "add_one"("x" integer) RETURNS integer\nLANGUAGE sql IMMUTABLE\nAS $exprsn1$\nSELECT x + 1 $exprsn$\n$exprsn1$');
    const proc = plan('mssql', { kind: 'procedure', name: 'dbo.touch', params: [{ name: 'id', type: { type: 'INT' } }, { name: 'n', type: { type: 'INT' }, mode: 'out' }], body: 'SELECT @n = 1;' });
    expect(proc.statements[0]).toContain('@n INT OUTPUT');
    expect(plan('mysql', { kind: 'procedure', name: 'p', params: [{ name: 'a', type: { type: 'INT' }, mode: 'inout' }], body: 'SET a = a + 1;' }).statements[0]).toBe('CREATE PROCEDURE `p`(INOUT `a` INT)\nBEGIN\nSET a = a + 1;\nEND');
    expect(plan('snowflake', { kind: 'procedure', name: 'p', body: "RETURN '$$';" }).statements[0]).toBe("CREATE PROCEDURE \"P\"()\nRETURNS VARCHAR\nLANGUAGE SQL\nAS 'RETURN ''$$'';'");
    const bq = plan('bigquery', { kind: 'function', name: 'ds.f', params: [{ name: 'x', type: { type: 'INT64' } }], returns: { type: 'INT64' }, language: 'javascript', body: 'return x + 1; """' });
    expect(bq.ops[0]).toMatchObject({ op: 'bigquery.insertRoutine', datasetId: 'ds', routineId: 'f', language: 'JAVASCRIPT', definitionBody: 'return x + 1; """', returnType: { typeKind: 'INT64' } });
    expect(plan('mysql', { kind: 'procedure', name: 'p', body: 'x', orReplace: true })).toMatchObject({ statements: ['DROP PROCEDURE IF EXISTS `p`', 'CREATE PROCEDURE `p`()\nBEGIN\nx\nEND'], destructive: false, transactional: false });
    expect(problems('postgres', { kind: 'function', name: 'f', params: [{ name: 'x', type: { type: 'integer' }, mode: 'out' }], returns: { type: 'integer' }, body: 'x' }).join(' ')).toMatch(/input only/);
    expect(problems('cloudflare-d1', { kind: 'procedure', name: 'p', body: 'x' }).join(' ')).toMatch(/offers table, index/);
  });

  it('makes datasets and schemas where the vendor has them', () => {
    expect(plan('postgres', { kind: 'dataset', name: 'reporting', owner: 'analyst', ifNotExists: true }).statements).toEqual(['CREATE SCHEMA IF NOT EXISTS "reporting" AUTHORIZATION "analyst"']);
    expect(plan('mysql', { kind: 'dataset', name: 'shop2', charset: 'utf8mb4', collation: 'utf8mb4_0900_ai_ci' }).statements).toEqual(['CREATE DATABASE `shop2` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci']);
    expect(plan('bigquery', { kind: 'dataset', name: 'analytics', location: 'EU', defaultTableExpirationDays: 30 }).ops[0]).toEqual({ op: 'bigquery.insertDataset', datasetId: 'analytics', location: 'EU', description: null, defaultTableExpirationMs: 2_592_000_000, ifNotExists: false });
    expect(problems('oracle', { kind: 'dataset', name: 'x' }).join(' ')).toMatch(/offers/);
    expect(problems('postgres', { kind: 'dataset', name: 'x', location: 'EU' }).join(' ')).toMatch(/does not apply/);
    expect(plan('influxdb', { kind: 'dataset', name: 'metrics', duration: '30d' }, 'telemetry', { version: 'v1' }).ops).toEqual([{ op: 'influx.createDatabase', name: 'metrics', duration: '30d' }]);
    expect(problems('influxdb', { kind: 'dataset', name: 'metrics' }, 'telemetry', { version: 'v2' }).join(' ')).toMatch(/buckets/);
    expect(plan('cosmos-nosql', { kind: 'dataset', name: 'catalog', throughput: 400 }).ops).toEqual([{ op: 'cosmos.createDatabase', id: 'catalog', throughput: 400 }]);
  });

  it('builds the operations of document, search, key-value and queue engines', () => {
    const coll = plan('mongodb', { kind: 'collection', name: 'orders', fields: [{ name: '_id', bsonType: 'objectId' }, { name: 'sku', bsonType: 'string', required: true }], additionalProperties: false });
    expect(coll.ops[0]).toEqual({ op: 'mongo.createCollection', name: 'orders', options: { validator: { $jsonSchema: { bsonType: 'object', required: ['sku'], properties: { _id: { bsonType: 'objectId' }, sku: { bsonType: 'string' } }, additionalProperties: false } }, validationLevel: 'strict', validationAction: 'error' } });
    const ix = plan('documentdb', { kind: 'index', collection: 'orders', keys: [{ field: 'sku', order: 1 }], unique: true });
    expect(ix).toMatchObject({ touches: ['orders'], ops: [{ op: 'mongo.createIndex', collection: 'orders', keys: { sku: 1 }, options: { unique: true } }] });
    expect(problems('mongodb', { kind: 'index', collection: 'o', keys: [{ field: 'a', order: 1 }], partialFilter: { $where: 'x' } }).join(' ')).toMatch(/\$where/);
    expect(plan('opensearch', { kind: 'search-index', name: 'docs', fields: [{ name: 'body', type: 'text', analyzer: 'english' }, { name: 'v', type: 'knn_vector', dimension: 384 }] }).ops[0]).toMatchObject({ op: 'opensearch.createIndex', index: 'docs', body: { settings: { index: { knn: true } }, mappings: { properties: { body: { type: 'text', analyzer: 'english' }, v: { type: 'knn_vector', dimension: 384 } } } } });
    expect(problems('dynamodb', { kind: 'table', name: 'orders', partitionKey: { name: 'pk', type: 'S' }, billingMode: 'PROVISIONED' }).join(' ')).toMatch(/capacity/);
    const gsi = plan('dynamodb', { kind: 'index', table: 'orders', name: 'by_status', partitionKey: { name: 'status', type: 'S' } });
    expect(gsi).toMatchObject({ touches: ['orders'], ops: [{ op: 'dynamodb.updateTable', input: { TableName: 'orders', GlobalSecondaryIndexUpdates: [{ Create: { IndexName: 'by_status' } }] } }] });
    expect(plan('cosmos-nosql', { kind: 'container', name: 'items', partitionKeyPaths: ['/tenantId', '/userId'] }).ops[0]).toMatchObject({ op: 'cosmos.createContainer', body: { id: 'items', partitionKey: { paths: ['/tenantId', '/userId'], kind: 'MultiHash' } } });
    expect(plan('redis', { kind: 'stream-group', key: 'jobs:email', group: 'workers' }, null)).toMatchObject({ touches: ['jobs:email'], statements: ['XGROUP CREATE jobs:email workers $ MKSTREAM'] });
    const q = plan('rabbitmq', { kind: 'queue', name: 'orders.eu', arguments: { deadLetterExchange: 'dlx', deliveryLimit: 5 } }, null);
    expect(q).toMatchObject({ object: '//orders.eu', ops: [{ op: 'rabbit.declareQueue', vhost: '/', name: 'orders.eu', body: { durable: true, auto_delete: false, arguments: { 'x-queue-type': 'quorum', 'x-dead-letter-exchange': 'dlx', 'x-delivery-limit': 5 } } }] });
    expect(plan('rabbitmq', { kind: 'queue', name: 'q' }, 'shop').statements[0]).toMatch(/^PUT \/api\/queues\/shop\/q/);
    expect(problems('rabbitmq', { kind: 'queue', name: 'q', type: 'stream', arguments: { messageTtl: 5 } }, null).join(' ')).toMatch(/Streams do not take messageTtl/);
    expect(problems('rabbitmq', { kind: 'queue', name: 'q', type: 'quorum', durable: false, arguments: { maxPriority: 5 } }, null)).toHaveLength(2);
    expect(problems('rabbitmq', { kind: 'queue', name: 'amq.x' }, null).join(' ')).toMatch(/reserved/);
    expect(plan('rabbitmq', { kind: 'binding', source: 'orders', destination: 'orders.eu', routingKey: 'eu.#' }, null)).toMatchObject({ touches: ['//orders.eu'], ops: [{ op: 'rabbit.bind', destinationType: 'q', body: { routing_key: 'eu.#' } }] });
  });
});

// ---------------------------------------------------------------------------------------------------------------

/** A database that knows its tables and records the plans its admin account runs. */
class World {
  tables: SchemaObject[] = [{ name: 'public.orders', kind: 'table', columns: [{ name: 'id', type: 'bigint' }, { name: 'status', type: 'text' }] }];
  applied: { plan: DdlPlan; account: string | null }[] = [];
  fail: string | null = null;
  queues: QueueInfo[] = [
    { name: 'jobs:email', kind: 'stream', depth: 12, inFlight: 2, consumers: 1, state: null, rateIn: null, rateOut: null, groups: [{ name: 'workers', consumers: 1, pending: 2, lastDeliveredId: '1-0', lag: 10 }] },
    { name: 'secret:queue', kind: 'list', depth: 3, inFlight: null, consumers: null, state: null, rateIn: null, rateOut: null }
  ];
  driver(spec: ConnectionSpec): DataDriver {
    return World.driverOf(this, spec);
  }
  static driverOf(w: World, spec: ConnectionSpec): DataDriver {
    return {
      async test() {
        return { version: 'fake', readOnly: true, detail: 'ok', health: 'healthy' };
      },
      async introspect() {
        return w.tables;
      },
      async query() {
        return { columns: [], rows: [], capped: false, estimate: null };
      },
      async rows() {
        return { columns: [], rows: [], capped: false, estimate: null };
      },
      async applyDdl(plan) {
        if (w.fail) throw new Error(`${w.fail} (password ${spec.password})`);
        w.applied.push({ plan, account: spec.username });
        if (plan.kind === 'table') w.tables.push({ name: plan.object.includes('.') ? plan.object : `public.${plan.object}`, kind: 'table', columns: [] });
        return { applied: plan.statements.length };
      },
      async describe(object: string) {
        const t = w.tables.find((x) => x.name === object || x.name === `public.${object}`);
        if (!t) return null;
        return { kind: 'table' as const, name: t.name, columns: t.columns.map((c) => ({ name: c.name, type: c.type === 'bigint' ? { type: 'bigint' } : { type: 'text' }, rawType: c.type, nullable: c.name !== 'id', default: null, identity: false, comment: null })), primaryKey: { name: 'orders_pkey', columns: ['id'] }, uniques: [], foreignKeys: [], checks: [], indexes: [], comment: null, options: {} };
      },
      async routines() {
        return [{ name: 'public.touch', kind: 'function' as const, signature: 'integer' }];
      },
      async queues(opts) {
        const seen = w.queues.filter((q) => opts.allowed(q.name));
        return { queues: seen, outside: w.queues.length - seen.length, capped: false };
      }
    };
  }
}

describe('schema changes and queues through the API', () => {
  let h: Harness;
  let w: World;
  beforeEach(async () => {
    w = new World();
    h = await harnessWith({ drivers: { postgres: (spec) => w.driver(spec), redis: (spec) => w.driver(spec) } }, { OLLAMA_POLL_MS: '600000' });
  });
  afterEach(async () => {
    await h.close();
  });

  async function user(name: string, roles: string[]) {
    await localUser(h, name, [...roles, 'member'], 'confidential');
    const c = await loginAdmin(h, name);
    const send = (m: 'post' | 'put' | 'delete', p: string, b: object = {}) => c.agent[m](p).set('x-csrf-token', c.csrf).send(b);
    return { post: (p: string, b?: object) => send('post', p, b), put: (p: string, b?: object) => send('put', p, b), del: (p: string) => send('delete', p), get: (p: string) => c.agent.get(p) };
  }

  const table = { kind: 'table', name: 'reports', columns: [{ name: 'id', type: { type: 'bigint' }, identity: true }, { name: 'title', type: { type: 'varchar', length: 120 }, nullable: false }], primaryKey: ['id'] };

  it('previews, refuses without an admin account, applies on it with the previewed hash, and audits', async () => {
    const a = await user('connadmin', ['connection-admin']);
    const conn = (await a.post('/api/admin/connections', { name: 'ledger', engine: 'postgres', endpoint: 'pg.internal:5432', database: 'ledger', label: 'internal', username: 'reader', password: 'read-secret' }).expect(201)).body;
    expect(conn).toMatchObject({ category: 'relational', admin: { set: false, account: null } });
    const engines = (await a.get('/api/admin/connections/engines').expect(200)).body as { id: string; category: string; designer: { kinds: { kind: string }[]; types: { name: string }[] } }[];
    const pg = engines.find((e) => e.id === 'postgres')!;
    expect(pg.category).toBe('relational');
    expect(pg.designer.kinds.map((k) => k.kind)).toEqual(['table', 'index', 'procedure', 'function', 'dataset']);
    expect(pg.designer.types.map((t) => t.name)).toContain('jsonb');
    expect(engines.find((e) => e.id === 'redis')).toMatchObject({ category: 'messaging', designer: { kinds: [{ kind: 'stream-group' }] } });

    const bad = (await a.post(`/api/admin/connections/${conn.id}/ddl/preview`, { definition: { kind: 'table', name: 'x', columns: [{ name: 'a', type: { type: 'int' } }] } }).expect(422)).body;
    expect(bad.problems).toEqual(['a: int is not a postgres type the designer offers.']);

    const pre = (await a.post(`/api/admin/connections/${conn.id}/ddl/preview`, { definition: table }).expect(200)).body;
    expect(pre.plan.statements[0]).toMatch(/^CREATE TABLE "reports"/);
    expect(pre.blockers).toEqual(['ledger has no admin account for schema changes; set one on the Settings tab.']);
    expect((await a.post(`/api/admin/connections/${conn.id}/ddl/apply`, { definition: table, hash: pre.plan.hash }).expect(409)).body.detail).toMatch(/no admin account/);
    expect(w.applied).toHaveLength(0);

    const set = (await a.put(`/api/admin/connections/${conn.id}/admin-credential`, { username: 'ledger_owner', password: 'admin-secret' }).expect(200)).body;
    expect(set.admin).toMatchObject({ set: true, account: 'ledger_owner' });
    expect(JSON.stringify(set)).not.toContain('admin-secret');
    const raw = await h.s.db('data_connections').where({ id: conn.id }).first();
    expect(raw.admin_credential).toMatch(/^v2\./);
    expect(raw.admin_credential).not.toContain('admin-secret');

    // The definition changed after the preview: refused, nothing sent.
    await a.post(`/api/admin/connections/${conn.id}/ddl/apply`, { definition: { ...table, name: 'reports2' }, hash: pre.plan.hash }).expect(409);
    expect(w.applied).toHaveLength(0);

    const done = (await a.post(`/api/admin/connections/${conn.id}/ddl/apply`, { definition: table, hash: pre.plan.hash, allowList: true }).expect(200)).body;
    expect(done).toMatchObject({ applied: 1, schemaRefreshed: true, allowListed: true });
    expect(w.applied).toEqual([{ plan: expect.objectContaining({ kind: 'table', hash: pre.plan.hash }), account: 'ledger_owner' }]);
    expect(done.connection.allowList).toContain('public.reports');

    // Queries still use the read account.
    await a.post(`/api/admin/connections/${conn.id}/test`).expect(200);

    // An index acts on an existing table: it must be allow-listed.
    const ix = { kind: 'index', name: 'ix_status', table: 'orders', columns: [{ name: 'status' }] };
    const ixPre = (await a.post(`/api/admin/connections/${conn.id}/ddl/preview`, { definition: ix }).expect(200)).body;
    expect(ixPre.blockers).toEqual(['orders is not on the schema allow-list; a change can only act on allow-listed objects.']);
    await a.post(`/api/admin/connections/${conn.id}/ddl/apply`, { definition: ix, hash: ixPre.plan.hash }).expect(409);

    // A failure is reported with the password scrubbed, and audited.
    w.fail = 'permission denied for schema public';
    const failed = (await a.post(`/api/admin/connections/${conn.id}/ddl/apply`, { definition: { ...table, name: 'other' }, hash: (await a.post(`/api/admin/connections/${conn.id}/ddl/preview`, { definition: { ...table, name: 'other' } })).body.plan.hash }).expect(502)).body;
    expect(failed.detail).toMatch(/permission denied/);
    expect(failed.detail).not.toContain('admin-secret');

    const actions = ((await h.s.db('audit_events').where({ tenant_id: h.tenantId }).whereLike('action', 'connection.%').select('action')) as { action: string }[]).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['connection.admin-credential.set', 'connection.ddl.refused', 'connection.ddl.applied', 'connection.ddl.failed']));

    const cleared = (await a.del(`/api/admin/connections/${conn.id}/admin-credential`).expect(200)).body;
    expect(cleared.admin).toMatchObject({ set: false, account: null });
  });

  it('keeps schema changes to connections:ddl; a connection manager may preview', async () => {
    const admin = await user('connadmin', ['connection-admin']);
    const conn = (await admin.post('/api/admin/connections', { name: 'ledger', engine: 'postgres', endpoint: 'pg.internal:5432', label: 'internal', username: 'reader', password: 'x' }).expect(201)).body;
    // A custom role with connections:manage and not connections:ddl.
    const id = 'custom-01k0ddlmanager0000000000000';
    setCustomRoles(h.tenantId, [{ id, tenantId: h.tenantId, name: 'Connection manager', description: 'Manage only', permissions: ['connections:manage'], requiresMfa: true, grantableBy: ['system-admin'], version: 1 }]);
    const m = await user('manager', [id]);
    await m.post(`/api/admin/connections/${conn.id}/ddl/preview`, { definition: table }).expect(200);
    await m.put(`/api/admin/connections/${conn.id}/admin-credential`, { username: 'o', password: 'p' }).expect(403);
    await m.post(`/api/admin/connections/${conn.id}/ddl/apply`, { definition: table, hash: '0'.repeat(64) }).expect(403);
  });

  it('lists the allow-listed queues of a Redis connection, and creates a stream group', async () => {
    const a = await user('connadmin', ['connection-admin']);
    const conn = (await a.post('/api/admin/connections', { name: 'cache', engine: 'redis', endpoint: 'redis.internal:6379', label: 'internal', password: 'x' }).expect(201)).body;
    expect(conn.category).toBe('messaging');
    await h.s.db('data_connections').where({ id: conn.id }).update({ allow_list: JSON.stringify(['jobs:*']) });
    const q = (await a.get(`/api/admin/connections/${conn.id}/queues`).expect(200)).body;
    expect(q.queues.map((x: QueueInfo) => x.name)).toEqual(['jobs:email']);
    expect(q).toMatchObject({ outside: 1, capped: false });
    await a.put(`/api/admin/connections/${conn.id}/admin-credential`, { username: null, password: 'writer' }).expect(200);
    const def = { kind: 'stream-group', key: 'jobs:sms', group: 'workers' };
    const pre = (await a.post(`/api/admin/connections/${conn.id}/ddl/preview`, { definition: def }).expect(200)).body;
    expect(pre.blockers).toEqual([]);
    await a.post(`/api/admin/connections/${conn.id}/ddl/apply`, { definition: def, hash: pre.plan.hash, allowList: false }).expect(200);
    expect(w.applied[0]!.plan.ops).toEqual([{ op: 'redis.xgroupCreate', key: 'jobs:sms', group: 'workers', id: '$', mkstream: true }]);
    const outside = { kind: 'stream-group', key: 'secret:queue', group: 'g' };
    expect((await a.post(`/api/admin/connections/${conn.id}/ddl/preview`, { definition: outside }).expect(200)).body.blockers[0]).toMatch(/not on the schema allow-list/);
  });
  it('edits a table against its live description, asks for the name on destructive changes, and keeps the allow-list in step', async () => {
    const a = await user('connadmin', ['connection-admin']);
    const conn = (await a.post('/api/admin/connections', { name: 'ledger', engine: 'postgres', endpoint: 'pg.internal:5432', label: 'internal', username: 'reader', password: 'r' }).expect(201)).body;
    await a.post(`/api/admin/connections/${conn.id}/schema`).expect(200);
    await a.put(`/api/admin/connections/${conn.id}/allow-list`, { objects: ['public.orders'], piiColumns: [] }).expect(200);
    await a.put(`/api/admin/connections/${conn.id}/admin-credential`, { username: 'owner', password: 'o' }).expect(200);

    const objs = (await a.get(`/api/admin/connections/${conn.id}/objects`).expect(200)).body;
    expect(objs.objects).toEqual(expect.arrayContaining([{ name: 'public.orders', kind: 'table', allowed: true }, { name: 'public.touch', kind: 'function', allowed: true, signature: 'integer' }]));
    expect(objs.editable.edit).toContain('alter-table');
    const desc = (await a.get(`/api/admin/connections/${conn.id}/objects/describe?name=public.orders&kind=table`).expect(200)).body.description;
    expect(desc.columns.map((c: { name: string }) => c.name)).toEqual(['id', 'status']);
    await a.get(`/api/admin/connections/${conn.id}/objects/describe?name=public.nope&kind=table`).expect(404);

    // Drop `status`, add `note`: destructive, so apply needs the name typed back.
    const edit = { kind: 'alter-table', name: 'public.orders', columns: [{ from: 'id', name: 'id', type: { type: 'bigint' }, nullable: false }, { name: 'note', type: { type: 'text' } }], primaryKey: ['id'] };
    const pre = (await a.post(`/api/admin/connections/${conn.id}/ddl/preview`, { definition: edit }).expect(200)).body;
    expect(pre.plan.statements.join('\n')).toMatch(/DROP COLUMN "status"/);
    expect(pre.plan.statements.join('\n')).toMatch(/ADD COLUMN "note" text/);
    expect(pre.plan).toMatchObject({ destructive: true, confirmName: 'public.orders', touches: ['public.orders'] });
    expect((await a.post(`/api/admin/connections/${conn.id}/ddl/apply`, { definition: edit, hash: pre.plan.hash }).expect(422)).body).toMatchObject({ kind: 'confirm', confirmName: 'public.orders' });
    expect(w.applied).toHaveLength(0);

    // The table changed after the preview: the diff differs, so the previewed hash is refused.
    w.tables[0]!.columns.push({ name: 'added_elsewhere', type: 'text' });
    await a.post(`/api/admin/connections/${conn.id}/ddl/apply`, { definition: edit, hash: pre.plan.hash, confirm: 'public.orders' }).expect(409);
    w.tables[0]!.columns.pop();
    await a.post(`/api/admin/connections/${conn.id}/ddl/apply`, { definition: edit, hash: pre.plan.hash, confirm: 'public.orders' }).expect(200);
    expect(w.applied.at(-1)!.plan.kind).toBe('alter-table');

    // A rename moves the allow-list entry; a drop removes it.
    const rename = { kind: 'alter-table', name: 'public.orders', rename: 'orders_2025', columns: [{ from: 'id', name: 'id', type: { type: 'bigint' }, nullable: false }, { from: 'status', name: 'status', type: { type: 'text' } }], primaryKey: ['id'] };
    const rp = (await a.post(`/api/admin/connections/${conn.id}/ddl/preview`, { definition: rename }).expect(200)).body;
    expect(rp.plan.destructive).toBe(false);
    const renamed = (await a.post(`/api/admin/connections/${conn.id}/ddl/apply`, { definition: rename, hash: rp.plan.hash }).expect(200)).body;
    expect(renamed.connection.allowList).toEqual(['public.orders_2025']);
    const drop = { kind: 'drop', objectKind: 'table', name: 'public.orders_2025' };
    const dp = (await a.post(`/api/admin/connections/${conn.id}/ddl/preview`, { definition: drop }).expect(200)).body;
    expect(dp.plan).toMatchObject({ destructive: true, confirmName: 'public.orders_2025' });
    const dropped = (await a.post(`/api/admin/connections/${conn.id}/ddl/apply`, { definition: drop, hash: dp.plan.hash, confirm: 'public.orders_2025' }).expect(200)).body;
    expect(dropped.connection.allowList).toEqual([]);
    const actions = ((await h.s.db('audit_events').where({ tenant_id: h.tenantId }).where('action', 'connection.ddl.applied').select('detail')) as { detail: string }[]).map((x) => JSON.parse(x.detail) as { kind: string; destructive: boolean });
    expect(actions.map((x) => [x.kind, x.destructive])).toEqual([['alter-table', true], ['alter-table', false], ['drop', true]]);
  });
});
