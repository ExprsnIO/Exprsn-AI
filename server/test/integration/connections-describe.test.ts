/*
 * 2.0.x editing: `describe` and `routines` of the SQL drivers on real servers. Each block runs when its variable is
 * set (the same accounts as connections-ddl.test.ts: one that may create schemas, tables and routines):
 *
 *   TEST_PG_URL      postgres://user:password@host:5432/database   (a throwaway schema, dropped after)
 *   TEST_MYSQL_URL   mysql://user:password@host:3306/database      (throwaway names in that database, dropped after)
 *   TEST_MSSQL_URL   mssql://user:password@host:1433/database      (a throwaway schema, dropped after)
 *   TEST_ORACLE_URL  oracle://user:password@host:1521/SERVICE      (throwaway names in the account's schema)
 *
 * Each creates a table with every feature the designer writes (identity, defaults, comments, primary key, unique,
 * foreign key, check, indexes) through buildPlan and applyDdl, describes it and checks the description, and
 * round-trips a routine: described, created again with orReplace from the description's body, described again.
 */
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { buildPlan } from '../../src/connections/ddl.js';
import type { RoutineDescription, TableDescription } from '../../src/connections/ddl-edit-types.js';
import type { NameContext } from '../../src/connections/dialects.js';
import { MysqlDriver, PostgresDriver, type ConnectionSpec } from '../../src/connections/drivers.js';
import { MssqlDriver } from '../../src/connections/mssql.js';
import { OracleDriver } from '../../src/connections/oracle.js';
import { parseAllowList } from '../../src/mcp/hosts.js';

const allow = parseAllowList('127.0.0.1,localhost,::1');
const tag = randomBytes(3).toString('hex');
const ctxOf = (engine: ConnectionSpec['engine'], database: string | null): NameContext => ({ engine, database, account: null, options: {} });

describe.skipIf(!process.env.TEST_PG_URL)('PostgreSQL describe (TEST_PG_URL)', () => {
  const u = new URL(process.env.TEST_PG_URL ?? 'postgres://x:y@127.0.0.1/x');
  const spec: ConnectionSpec = { engine: 'postgres', endpoint: `${u.hostname}:${u.port || 5432}`, database: u.pathname.slice(1), tls: false, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
  const driver = new PostgresDriver(spec, allow);
  const ctx = ctxOf('postgres', spec.database);
  const schema = `desc_${tag}`;
  const sql = async (text: string) => {
    const c = new pg.Client({ connectionString: process.env.TEST_PG_URL });
    await c.connect();
    try {
      return (await c.query(text)).rows;
    } finally {
      await c.end();
    }
  };
  afterAll(async () => {
    await sql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  });

  it('describes a table with every feature, its indexes and a view', async () => {
    await driver.applyDdl(buildPlan('postgres', ctx, { kind: 'dataset', name: schema }), 10_000);
    await driver.applyDdl(buildPlan('postgres', ctx, { kind: 'table', name: `${schema}.customers`, columns: [{ name: 'id', type: { type: 'bigint' }, identity: true }, { name: 'email', type: { type: 'varchar', length: 200 }, nullable: false }], primaryKey: ['id'] }), 10_000);
    const orders = buildPlan('postgres', ctx, {
      kind: 'table',
      name: `${schema}.orders`,
      columns: [
        { name: 'id', type: { type: 'integer' }, identity: true },
        { name: 'customer_id', type: { type: 'bigint' }, nullable: false },
        { name: 'code', type: { type: 'char', length: 3 }, default: { kind: 'literal', value: 'abc' } },
        { name: 'total', type: { type: 'numeric', precision: 12, scale: 2 }, nullable: false, default: { kind: 'literal', value: 0 } },
        { name: 'tags', type: { type: 'text', array: true } },
        { name: 'placed', type: { type: 'timestamptz', precision: 3 }, default: { kind: 'expression', sql: 'now()' } },
        { name: 'note', type: { type: 'varchar', length: 200 }, comment: 'A note' }
      ],
      primaryKey: ['id'],
      uniques: [{ name: 'uq_orders_code', columns: ['customer_id', 'code'] }],
      foreignKeys: [{ name: 'fk_orders_customer', columns: ['customer_id'], refTable: `${schema}.customers`, refColumns: ['id'], onDelete: 'CASCADE' }],
      checks: [{ name: 'ck_orders_total', expression: 'total >= 0' }],
      comment: 'Orders'
    });
    await driver.applyDdl(orders, 10_000);
    await driver.applyDdl(buildPlan('postgres', ctx, { kind: 'index', name: 'ix_orders_open', table: `${schema}.orders`, columns: [{ name: 'placed', order: 'desc' }], include: ['note'], where: 'total > 0' }), 10_000);
    await driver.applyDdl(buildPlan('postgres', ctx, { kind: 'index', name: 'ix_orders_tags', table: `${schema}.orders`, columns: [{ name: 'tags' }], method: 'gin' }), 10_000);
    await sql(`CREATE VIEW ${schema}.big AS SELECT id, total FROM ${schema}.orders WHERE total > 100`);

    const t = (await driver.describe(`${schema}.orders`, 'table', 10_000)) as TableDescription;
    expect(t).toMatchObject({ kind: 'table', name: `${schema}.orders`, comment: 'Orders' });
    expect(t.columns.map((c) => [c.name, c.type, c.rawType, c.nullable, c.default, c.identity])).toEqual([
      ['id', { type: 'integer' }, 'integer', false, null, true],
      ['customer_id', { type: 'bigint' }, 'bigint', false, null, false],
      ['code', { type: 'char', length: 3 }, 'character(3)', true, { kind: 'literal', value: 'abc' }, false],
      ['total', { type: 'numeric', precision: 12, scale: 2 }, 'numeric(12,2)', false, { kind: 'literal', value: '0' }, false],
      ['tags', { type: 'text', array: true }, 'text[]', true, null, false],
      ['placed', { type: 'timestamptz', precision: 3 }, 'timestamp(3) with time zone', true, { kind: 'expression', value: 'now()' }, false],
      ['note', { type: 'varchar', length: 200 }, 'character varying(200)', true, null, false]
    ]);
    expect(t.columns.find((c) => c.name === 'note')!.comment).toBe('A note');
    expect(t.primaryKey?.columns).toEqual(['id']);
    expect(t.uniques).toEqual([{ name: 'uq_orders_code', columns: ['customer_id', 'code'] }]);
    expect(t.foreignKeys).toEqual([{ name: 'fk_orders_customer', columns: ['customer_id'], refTable: `${schema}.customers`, refColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'NO ACTION' }]);
    expect(t.checks).toEqual([{ name: 'ck_orders_total', expression: 'total >= 0::numeric' }]);
    expect(t.indexes.find((i) => i.name === 'ix_orders_open')).toEqual({ name: 'ix_orders_open', columns: [{ name: 'placed', order: 'desc' }], unique: false, method: 'btree', where: 'total > 0::numeric', include: ['note'], constraint: false });
    expect(t.indexes.find((i) => i.name === 'ix_orders_tags')).toMatchObject({ method: 'gin', columns: [{ name: 'tags' }] });
    expect(t.indexes.find((i) => i.name === 'uq_orders_code')).toMatchObject({ unique: true, constraint: true });
    expect(t.indexes.find((i) => i.name === t.primaryKey!.name)).toMatchObject({ constraint: true });

    const v = (await driver.describe(`${schema}.big`, 'view', 10_000)) as TableDescription;
    expect(v.kind).toBe('view');
    expect(v.definition).toMatch(/total > 100/);
    expect(await driver.describe(`${schema}.missing`, 'table', 10_000)).toBeNull();
  });

  it('round-trips a function and lists routines with their signatures', async () => {
    const fn = { kind: 'function', name: `${schema}.add_tax`, params: [{ name: 'amount', type: { type: 'numeric' } }, { name: 'rate', type: { type: 'numeric' } }], returns: { type: 'numeric' }, language: 'plpgsql', volatility: 'immutable', body: 'BEGIN\n  RETURN amount * (1 + rate);\nEND;' };
    await driver.applyDdl(buildPlan('postgres', ctx, fn), 10_000);
    const d = (await driver.describe(`${schema}.add_tax`, 'function', 10_000)) as RoutineDescription;
    expect(d).toMatchObject({ kind: 'function', language: 'plpgsql', volatility: 'immutable', signature: 'amount numeric, rate numeric', body: fn.body, returns: { type: { type: 'numeric' }, rawType: 'numeric' } });
    expect(d.params).toEqual([{ name: 'amount', type: { type: 'numeric' }, rawType: 'numeric', mode: 'in' }, { name: 'rate', type: { type: 'numeric' }, rawType: 'numeric', mode: 'in' }]);
    await driver.applyDdl(buildPlan('postgres', ctx, { ...fn, body: d.body, orReplace: true }), 10_000);
    expect(((await driver.describe(`${schema}.add_tax(numeric, numeric)`, 'function', 10_000)) as RoutineDescription).body).toBe(fn.body);
    expect(await driver.describe(`${schema}.add_tax(integer)`, 'function', 10_000)).toBeNull();
    const list = await driver.routines(10_000);
    expect(list).toContainEqual({ name: `${schema}.add_tax`, kind: 'function', signature: 'amount numeric, rate numeric' });
    expect(list.some((r) => r.name.startsWith('pg_catalog.'))).toBe(false);
  });
});

describe.skipIf(!process.env.TEST_MYSQL_URL)('MySQL describe (TEST_MYSQL_URL)', () => {
  const u = new URL(process.env.TEST_MYSQL_URL ?? 'mysql://x:y@127.0.0.1/x');
  const spec: ConnectionSpec = { engine: 'mysql', endpoint: `${u.hostname}:${u.port || 3306}`, database: u.pathname.slice(1), tls: false, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
  const driver = new MysqlDriver(spec, allow);
  const ctx = ctxOf('mysql', spec.database);
  const parent = `desc_c_${tag}`;
  const table = `desc_o_${tag}`;
  const proc = `desc_p_${tag}`;
  const sql = async (text: string) => {
    const c = await mysql.createConnection(process.env.TEST_MYSQL_URL!);
    try {
      return (await c.query(text))[0] as Record<string, unknown>[];
    } finally {
      await c.end();
    }
  };
  afterAll(async () => {
    for (const s of [`DROP PROCEDURE IF EXISTS ${proc}`, `DROP TABLE IF EXISTS ${table}`, `DROP TABLE IF EXISTS ${parent}`]) await sql(s).catch(() => undefined);
  });

  it('describes a table with every feature', async () => {
    await driver.applyDdl(buildPlan('mysql', ctx, { kind: 'table', name: parent, columns: [{ name: 'id', type: { type: 'BIGINT', unsigned: true }, identity: true }], primaryKey: ['id'] }), 10_000);
    await driver.applyDdl(
      buildPlan('mysql', ctx, {
        kind: 'table',
        name: table,
        columns: [
          { name: 'id', type: { type: 'INT', unsigned: true }, identity: true },
          { name: 'customer_id', type: { type: 'BIGINT', unsigned: true }, nullable: false },
          { name: 'status', type: { type: 'ENUM', values: ['new', 'paid'] }, default: { kind: 'literal', value: 'new' } },
          { name: 'total', type: { type: 'DECIMAL', precision: 12, scale: 2 }, nullable: false, default: { kind: 'literal', value: 0 } },
          { name: 'paid', type: { type: 'BOOLEAN' }, default: { kind: 'literal', value: false } },
          { name: 'placed', type: { type: 'DATETIME', precision: 3 }, default: { kind: 'expression', sql: 'CURRENT_TIMESTAMP(3)' } },
          { name: 'note', type: { type: 'VARCHAR', length: 200 }, comment: 'A note' }
        ],
        primaryKey: ['id'],
        uniques: [{ name: 'uq_code', columns: ['customer_id', 'placed'] }],
        foreignKeys: [{ name: `fk_${tag}`, columns: ['customer_id'], refTable: parent, refColumns: ['id'], onDelete: 'CASCADE' }],
        checks: [{ name: `ck_${tag}`, expression: 'total >= 0' }],
        comment: 'Orders',
        options: { engine: 'InnoDB' }
      }),
      10_000
    );
    await driver.applyDdl(buildPlan('mysql', ctx, { kind: 'index', name: 'ix_placed', table, columns: [{ name: 'placed', order: 'desc' }, { name: 'status' }] }), 10_000);
    const t = (await driver.describe(table, 'table', 10_000)) as TableDescription;
    expect(t).toMatchObject({ kind: 'table', name: `${spec.database}.${table}`, comment: 'Orders', options: { engine: 'InnoDB' } });
    expect(t.columns.map((c) => [c.name, c.type, c.nullable, c.default, c.identity])).toEqual([
      ['id', { type: 'INT', unsigned: true }, false, null, true],
      ['customer_id', { type: 'BIGINT', unsigned: true }, false, null, false],
      ['status', { type: 'ENUM', values: ['new', 'paid'] }, true, { kind: 'literal', value: 'new' }, false],
      ['total', { type: 'DECIMAL', precision: 12, scale: 2 }, false, { kind: 'literal', value: '0.00' }, false],
      ['paid', { type: 'BOOLEAN' }, true, { kind: 'literal', value: 'false' }, false],
      ['placed', { type: 'DATETIME', precision: 3 }, true, { kind: 'expression', value: 'CURRENT_TIMESTAMP(3)' }, false],
      ['note', { type: 'VARCHAR', length: 200 }, true, null, false]
    ]);
    expect(t.columns.find((c) => c.name === 'note')!.comment).toBe('A note');
    expect(t.primaryKey).toEqual({ name: 'PRIMARY', columns: ['id'] });
    expect(t.uniques).toEqual([{ name: 'uq_code', columns: ['customer_id', 'placed'] }]);
    expect(t.foreignKeys).toEqual([{ name: `fk_${tag}`, columns: ['customer_id'], refTable: `${spec.database}.${parent}`, refColumns: ['id'], onDelete: 'CASCADE', onUpdate: expect.stringMatching(/NO ACTION|RESTRICT/) }]);
    expect(t.checks).toEqual([{ name: `ck_${tag}`, expression: expect.stringMatching(/`total` >= 0/) }]);
    expect(t.indexes.find((i) => i.name === 'ix_placed')).toMatchObject({ columns: [{ name: 'placed', order: 'desc' }, { name: 'status', order: 'asc' }], unique: false, method: 'btree', constraint: false });
    expect(t.indexes.find((i) => i.name === 'PRIMARY')).toMatchObject({ unique: true, constraint: true });
    expect(await driver.describe(`${table}_missing`, 'table', 10_000)).toBeNull();
  });

  it('round-trips a procedure', async () => {
    const p = { kind: 'procedure', name: proc, params: [{ name: 'step', type: { type: 'INT' } }, { name: 'result', type: { type: 'INT' }, mode: 'out' }], body: 'SET result = step + 1;' };
    await driver.applyDdl(buildPlan('mysql', ctx, p), 10_000);
    const d = (await driver.describe(proc, 'procedure', 10_000)) as RoutineDescription;
    expect(d.body).toBe('BEGIN\nSET result = step + 1;\nEND');
    expect(d.params).toEqual([{ name: 'step', type: { type: 'INT' }, rawType: 'int', mode: 'in' }, { name: 'result', type: { type: 'INT' }, rawType: 'int', mode: 'out' }]);
    await sql(`DROP PROCEDURE ${proc}`);
    await driver.applyDdl(buildPlan('mysql', ctx, { ...p, body: d.body }), 10_000);
    expect(((await driver.describe(proc, 'procedure', 10_000)) as RoutineDescription).body).toBe(d.body);
    expect(await driver.routines(10_000)).toContainEqual({ name: `${spec.database}.${proc}`, kind: 'procedure' });
  });
});

describe.skipIf(!process.env.TEST_MSSQL_URL)('SQL Server describe (TEST_MSSQL_URL)', () => {
  const u = new URL(process.env.TEST_MSSQL_URL ?? 'mssql://x:y@127.0.0.1/x');
  const spec: ConnectionSpec = { engine: 'mssql', endpoint: `${u.hostname}:${u.port || 1433}`, database: u.pathname.slice(1) || 'master', tls: u.searchParams.get('encrypt') === 'true', username: decodeURIComponent(u.username), password: decodeURIComponent(u.password), options: { applicationIntent: 'ReadOnly' } };
  const driver = new MssqlDriver(spec, allow);
  const ctx = ctxOf('mssql', spec.database);
  const schema = `desc_${tag}`;
  const admin = driver as unknown as { session: <T>(ms: number, fn: (c: unknown) => Promise<T>, rw?: boolean) => Promise<T>; exec: (c: unknown, sql: string, params?: unknown[], stop?: number, batch?: boolean) => Promise<{ rows: unknown[][] }> };
  const sql = (text: string) => admin.session(10_000, (c) => admin.exec(c, text, [], Infinity, true), true);
  afterAll(async () => {
    for (const s of [`DROP PROCEDURE IF EXISTS [${schema}].[bump]`, `DROP TABLE IF EXISTS [${schema}].[orders]`, `DROP TABLE IF EXISTS [${schema}].[customers]`, `DROP SCHEMA IF EXISTS [${schema}]`]) await sql(s).catch(() => undefined);
  });

  it('describes a table with every feature', async () => {
    await driver.applyDdl(buildPlan('mssql', ctx, { kind: 'dataset', name: schema }), 10_000);
    await driver.applyDdl(buildPlan('mssql', ctx, { kind: 'table', name: `${schema}.customers`, columns: [{ name: 'id', type: { type: 'INT' }, identity: true }], primaryKey: ['id'] }), 10_000);
    await driver.applyDdl(
      buildPlan('mssql', ctx, {
        kind: 'table',
        name: `${schema}.orders`,
        columns: [
          { name: 'id', type: { type: 'INT' }, identity: true },
          { name: 'customer_id', type: { type: 'INT' }, nullable: false },
          { name: 'name', type: { type: 'NVARCHAR', length: 200 }, default: { kind: 'literal', value: 'x' } },
          { name: 'body', type: { type: 'NVARCHAR', length: 'max' } },
          { name: 'total', type: { type: 'DECIMAL', precision: 12, scale: 2 }, nullable: false, default: { kind: 'literal', value: 0 } },
          { name: 'placed', type: { type: 'DATETIME2', precision: 7 }, default: { kind: 'expression', sql: 'getdate()' } }
        ],
        primaryKey: ['id'],
        uniques: [{ name: 'uq_orders_name', columns: ['customer_id', 'name'] }],
        foreignKeys: [{ name: 'fk_orders_customer', columns: ['customer_id'], refTable: `${schema}.customers`, refColumns: ['id'], onDelete: 'CASCADE' }],
        checks: [{ name: 'ck_orders_total', expression: 'total >= 0' }]
      }),
      10_000
    );
    await driver.applyDdl(buildPlan('mssql', ctx, { kind: 'index', name: 'ix_orders_open', table: `${schema}.orders`, columns: [{ name: 'placed', order: 'desc' }], include: ['total'], where: 'total > 0' }), 10_000);
    const t = (await driver.describe(`${schema}.orders`, 'table', 10_000)) as TableDescription;
    expect(t.columns.map((c) => [c.name, c.type, c.rawType, c.nullable, c.default, c.identity])).toEqual([
      ['id', { type: 'INT' }, 'int', false, null, true],
      ['customer_id', { type: 'INT' }, 'int', false, null, false],
      ['name', { type: 'NVARCHAR', length: 200 }, 'nvarchar(200)', true, { kind: 'literal', value: 'x' }, false],
      ['body', { type: 'NVARCHAR', length: 'max' }, 'nvarchar(max)', true, null, false],
      ['total', { type: 'DECIMAL', precision: 12, scale: 2 }, 'decimal(12,2)', false, { kind: 'literal', value: '0' }, false],
      ['placed', { type: 'DATETIME2', precision: 7 }, 'datetime2(7)', true, { kind: 'expression', value: 'getdate()' }, false]
    ]);
    expect(t.columns.find((c) => c.name === 'name')!.defaultConstraint).toMatch(/^DF_/);
    expect(t.primaryKey?.columns).toEqual(['id']);
    expect(t.uniques).toEqual([{ name: 'uq_orders_name', columns: ['customer_id', 'name'] }]);
    expect(t.foreignKeys).toEqual([{ name: 'fk_orders_customer', columns: ['customer_id'], refTable: `${schema}.customers`, refColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'NO ACTION' }]);
    expect(t.checks).toEqual([{ name: 'ck_orders_total', expression: '[total]>=(0)' }]);
    expect(t.indexes.find((i) => i.name === 'ix_orders_open')).toEqual({ name: 'ix_orders_open', columns: [{ name: 'placed', order: 'desc' }], unique: false, method: 'nonclustered', where: '[total]>(0)', include: ['total'], constraint: false });
    expect(t.indexes.find((i) => i.name === t.primaryKey!.name)).toMatchObject({ method: 'clustered', constraint: true });
  });

  it('round-trips a procedure', async () => {
    const p = { kind: 'procedure', name: `${schema}.bump`, params: [{ name: 'step', type: { type: 'INT' } }, { name: 'out', type: { type: 'INT' }, mode: 'out' }], body: 'SET @out = @step + 1;' };
    await driver.applyDdl(buildPlan('mssql', ctx, p), 10_000);
    const d = (await driver.describe(`${schema}.bump`, 'procedure', 10_000)) as RoutineDescription;
    expect(d.body).toBe(p.body);
    expect(d.params).toEqual([{ name: 'step', type: { type: 'INT' }, rawType: 'int', mode: 'in' }, { name: 'out', type: { type: 'INT' }, rawType: 'int', mode: 'out' }]);
    await driver.applyDdl(buildPlan('mssql', ctx, { ...p, body: d.body, orReplace: true }), 10_000);
    expect(((await driver.describe(`${schema}.bump`, 'procedure', 10_000)) as RoutineDescription).body).toBe(p.body);
    expect(await driver.routines(10_000)).toContainEqual({ name: `${schema}.bump`, kind: 'procedure' });
  });
});

describe.skipIf(!process.env.TEST_ORACLE_URL)('Oracle describe (TEST_ORACLE_URL)', () => {
  const u = new URL(process.env.TEST_ORACLE_URL ?? 'oracle://x:y@127.0.0.1:1521/X');
  const spec: ConnectionSpec = { engine: 'oracle', endpoint: `${u.hostname}:${u.port || 1521}`, database: u.pathname.slice(1), tls: false, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password), options: {} };
  const driver = new OracleDriver(spec, allow);
  const ctx = ctxOf('oracle', spec.database);
  const parent = `DESC_C_${tag}`.toUpperCase();
  const table = `DESC_O_${tag}`.toUpperCase();
  const proc = `DESC_P_${tag}`.toUpperCase();
  interface Conn {
    execute(sql: string, binds?: unknown[], opts?: Record<string, unknown>): Promise<{ rows?: unknown[][] }>;
    close(): Promise<void>;
  }
  const sql = async (text: string) => {
    const oracledb = createRequire(import.meta.url)('oracledb') as { getConnection(o: Record<string, unknown>): Promise<Conn> };
    const c = await oracledb.getConnection({ user: spec.username, password: spec.password, connectString: `${spec.endpoint}/${spec.database}` });
    try {
      return await c.execute(text);
    } finally {
      await c.close();
    }
  };
  afterAll(async () => {
    for (const s of [`DROP PROCEDURE "${proc}"`, `DROP TABLE "${table}" PURGE`, `DROP TABLE "${parent}" PURGE`]) await sql(s).catch(() => undefined);
  });

  it('describes a table with every feature', async () => {
    await driver.applyDdl(buildPlan('oracle', ctx, { kind: 'table', name: parent, columns: [{ name: 'ID', type: { type: 'NUMBER', precision: 12, scale: 0 }, identity: true }], primaryKey: ['ID'] }), 20_000);
    await driver.applyDdl(
      buildPlan('oracle', ctx, {
        kind: 'table',
        name: table,
        columns: [
          { name: 'ID', type: { type: 'NUMBER', precision: 12, scale: 0 }, identity: true },
          { name: 'CUSTOMER_ID', type: { type: 'NUMBER', precision: 12, scale: 0 }, nullable: false },
          { name: 'NAME', type: { type: 'VARCHAR2', length: 200 }, default: { kind: 'literal', value: 'x' }, comment: 'The name' },
          { name: 'TOTAL', type: { type: 'NUMBER', precision: 12, scale: 2 }, nullable: false, default: { kind: 'literal', value: 0 } },
          { name: 'PLACED', type: { type: 'TIMESTAMP WITH TIME ZONE', precision: 6 }, default: { kind: 'expression', sql: 'SYSTIMESTAMP' } }
        ],
        primaryKey: ['ID'],
        uniques: [{ name: `UQ_${tag}`.toUpperCase(), columns: ['CUSTOMER_ID', 'NAME'] }],
        foreignKeys: [{ name: `FK_${tag}`.toUpperCase(), columns: ['CUSTOMER_ID'], refTable: parent, refColumns: ['ID'], onDelete: 'CASCADE' }],
        checks: [{ name: `CK_${tag}`.toUpperCase(), expression: 'TOTAL >= 0' }],
        comment: 'Orders'
      }),
      20_000
    );
    await driver.applyDdl(buildPlan('oracle', ctx, { kind: 'index', name: `IX_${tag}`.toUpperCase(), table, columns: [{ name: 'PLACED', order: 'desc' }, { name: 'NAME' }] }), 20_000);
    const t = (await driver.describe(table, 'table', 20_000)) as TableDescription;
    expect(t).toMatchObject({ kind: 'table', comment: 'Orders' });
    expect(t.columns.map((c) => [c.name, c.type, c.nullable, c.default, c.identity])).toEqual([
      ['ID', { type: 'NUMBER', precision: 12, scale: 0 }, false, null, true],
      ['CUSTOMER_ID', { type: 'NUMBER', precision: 12, scale: 0 }, false, null, false],
      ['NAME', { type: 'VARCHAR2', length: 200 }, true, { kind: 'literal', value: 'x' }, false],
      ['TOTAL', { type: 'NUMBER', precision: 12, scale: 2 }, false, { kind: 'literal', value: '0' }, false],
      ['PLACED', { type: 'TIMESTAMP WITH TIME ZONE', precision: 6 }, true, { kind: 'expression', value: 'SYSTIMESTAMP' }, false]
    ]);
    expect(t.columns.find((c) => c.name === 'NAME')!.comment).toBe('The name');
    expect(t.primaryKey?.columns).toEqual(['ID']);
    expect(t.uniques).toEqual([{ name: `UQ_${tag}`.toUpperCase(), columns: ['CUSTOMER_ID', 'NAME'] }]);
    expect(t.foreignKeys).toEqual([{ name: `FK_${tag}`.toUpperCase(), columns: ['CUSTOMER_ID'], refTable: expect.stringMatching(new RegExp(`\\.${parent}$`)), refColumns: ['ID'], onDelete: 'CASCADE', onUpdate: null }]);
    expect(t.checks).toEqual([{ name: `CK_${tag}`.toUpperCase(), expression: 'TOTAL >= 0' }]);
    expect(t.indexes.find((i) => i.name === `IX_${tag}`.toUpperCase())).toMatchObject({ columns: [{ name: 'PLACED', order: 'desc' }, { name: 'NAME', order: 'asc' }], method: 'btree', constraint: false });
  });

  it('round-trips a procedure', async () => {
    const p = { kind: 'procedure', name: proc, params: [{ name: 'N', type: { type: 'NUMBER' }, mode: 'inout' }], body: 'N := N + 1;' };
    await driver.applyDdl(buildPlan('oracle', ctx, p), 20_000);
    const d = (await driver.describe(proc, 'procedure', 20_000)) as RoutineDescription;
    expect(d.body).toBe('BEGIN\nN := N + 1;\nEND;');
    expect(d.params).toEqual([{ name: 'N', type: { type: 'NUMBER' }, rawType: 'NUMBER', mode: 'inout' }]);
    await driver.applyDdl(buildPlan('oracle', ctx, { ...p, body: d.body, orReplace: true }), 20_000);
    expect(((await driver.describe(proc, 'procedure', 20_000)) as RoutineDescription).body).toBe(d.body);
    expect((await driver.routines(20_000)).some((r) => r.name.endsWith(`.${proc}`) && r.kind === 'procedure')).toBe(true);
  });
});
