/*
 * 2.0.x: schema changes through the SQL drivers' applyDdl on real servers. Each block runs when its variable is set
 * (an account that may create schemas or tables and routines there):
 *
 *   TEST_PG_URL      postgres://user:password@host:5432/database   (a throwaway schema, dropped after)
 *   TEST_MYSQL_URL   mysql://user:password@host:3306/database      (throwaway names in that database, dropped after)
 *   TEST_MSSQL_URL   mssql://user:password@host:1433/database      (a throwaway schema, dropped after)
 *   TEST_ORACLE_URL  oracle://user:password@host:1521/SERVICE      (throwaway names in the account's schema)
 *
 * Plans come from `buildPlan`: a table, an index and a function. PostgreSQL and SQL Server also show a failing
 * transactional plan leaving nothing behind, and PostgreSQL CREATE INDEX CONCURRENTLY running outside a transaction.
 */
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { buildPlan } from '../../src/connections/ddl.js';
import type { NameContext } from '../../src/connections/dialects.js';
import { MysqlDriver, PostgresDriver, type ConnectionSpec } from '../../src/connections/drivers.js';
import { MssqlDriver } from '../../src/connections/mssql.js';
import { OracleDriver } from '../../src/connections/oracle.js';
import { parseAllowList } from '../../src/mcp/hosts.js';

const allow = parseAllowList('127.0.0.1,localhost,::1');
const tag = randomBytes(3).toString('hex');
const ctxOf = (engine: ConnectionSpec['engine'], database: string | null): NameContext => ({ engine, database, account: null, options: {} });

describe.skipIf(!process.env.TEST_PG_URL)('PostgreSQL applyDdl (TEST_PG_URL)', () => {
  const u = new URL(process.env.TEST_PG_URL ?? 'postgres://x:y@127.0.0.1/x');
  const spec: ConnectionSpec = { engine: 'postgres', endpoint: `${u.hostname}:${u.port || 5432}`, database: u.pathname.slice(1), tls: false, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
  const driver = new PostgresDriver(spec, allow);
  const ctx = ctxOf('postgres', spec.database);
  const schema = `ddl_${tag}`;
  const sql = async <T extends pg.QueryResultRow>(text: string, values: unknown[] = []) => {
    const c = new pg.Client({ connectionString: process.env.TEST_PG_URL });
    await c.connect();
    try {
      return (await c.query<T>(text, values)).rows;
    } finally {
      await c.end();
    }
  };

  afterAll(async () => {
    await sql(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  });

  it('creates a schema, a table with comments, an index and a function', async () => {
    expect(await driver.applyDdl(buildPlan('postgres', ctx, { kind: 'dataset', name: schema, comment: 'DDL test' }), 10_000)).toEqual({ applied: 2 });
    const table = buildPlan('postgres', ctx, { kind: 'table', name: `${schema}.notes`, columns: [{ name: 'id', type: { type: 'bigint' }, identity: true }, { name: 'body', type: { type: 'text' }, nullable: false, comment: 'The text' }, { name: 'at', type: { type: 'timestamptz' }, default: { kind: 'expression', sql: 'now()' } }], primaryKey: ['id'], comment: 'Notes' });
    expect(table.transactional).toBe(true);
    expect(await driver.applyDdl(table, 10_000)).toEqual({ applied: 3 });
    expect(await driver.applyDdl(buildPlan('postgres', ctx, { kind: 'index', name: 'notes_at', table: `${schema}.notes`, columns: [{ name: 'at', order: 'desc' }] }), 10_000)).toEqual({ applied: 1 });
    const fn = buildPlan('postgres', ctx, { kind: 'function', name: `${schema}.add_tax`, params: [{ name: 'amount', type: { type: 'numeric' } }], returns: { type: 'numeric' }, language: 'sql', volatility: 'immutable', body: 'SELECT amount * 1.2' });
    expect(await driver.applyDdl(fn, 10_000)).toEqual({ applied: 1 });
    expect((await sql<{ v: string }>(`SELECT ${schema}.add_tax(10)::text AS v`))[0]!.v).toBe('12.0');
    expect((await sql<{ d: string }>(`SELECT obj_description('${schema}.notes'::regclass) AS d`))[0]!.d).toBe('Notes');
  });

  it('runs CREATE INDEX CONCURRENTLY outside a transaction', async () => {
    const plan = buildPlan('postgres', ctx, { kind: 'index', name: 'notes_body', table: `${schema}.notes`, columns: [{ name: 'body' }], concurrently: true });
    expect(plan.transactional).toBe(false);
    expect(await driver.applyDdl(plan, 10_000)).toEqual({ applied: 1 });
    expect(await sql(`SELECT 1 FROM pg_indexes WHERE schemaname = $1 AND indexname = 'notes_body'`, [schema])).toHaveLength(1);
  });

  it('rolls a failing transactional plan back whole, and refuses two commands in one text', async () => {
    const t = buildPlan('postgres', ctx, { kind: 'table', name: `${schema}.gone`, columns: [{ name: 'a', type: { type: 'integer' } }] });
    await expect(driver.applyDdl({ ...t, statements: [t.statements[0]!, `CREATE INDEX x ON ${schema}.missing (a)`] }, 10_000)).rejects.toThrow(/^Statement 2 of 2 failed; the transaction was rolled back and nothing was applied/);
    expect(await sql(`SELECT 1 FROM pg_tables WHERE schemaname = $1 AND tablename = 'gone'`, [schema])).toHaveLength(0);
    await expect(driver.applyDdl({ ...t, statements: [`CREATE TABLE ${schema}.two (a int); CREATE TABLE ${schema}.three (a int)`] }, 10_000)).rejects.toThrow(/multiple commands/);
    expect(await sql(`SELECT 1 FROM pg_tables WHERE schemaname = $1 AND tablename IN ('two', 'three')`, [schema])).toHaveLength(0);
  });
});

describe.skipIf(!process.env.TEST_MYSQL_URL)('MySQL applyDdl (TEST_MYSQL_URL)', () => {
  const u = new URL(process.env.TEST_MYSQL_URL ?? 'mysql://x:y@127.0.0.1/x');
  const spec: ConnectionSpec = { engine: 'mysql', endpoint: `${u.hostname}:${u.port || 3306}`, database: u.pathname.slice(1), tls: false, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
  const driver = new MysqlDriver(spec, allow);
  const ctx = ctxOf('mysql', spec.database);
  const table = `ddl_notes_${tag}`;
  const fnName = `ddl_tax_${tag}`;
  const sql = async (text: string) => {
    const c = await mysql.createConnection(process.env.TEST_MYSQL_URL!);
    try {
      return (await c.query(text))[0] as Record<string, unknown>[];
    } finally {
      await c.end();
    }
  };

  afterAll(async () => {
    await sql(`DROP FUNCTION IF EXISTS ${fnName}`);
    await sql(`DROP TABLE IF EXISTS ${table}`);
  });

  it('creates a table, an index and a function, each statement on its own', async () => {
    expect(await driver.applyDdl(buildPlan('mysql', ctx, { kind: 'table', name: table, columns: [{ name: 'id', type: { type: 'BIGINT' }, identity: true }, { name: 'body', type: { type: 'VARCHAR', length: 200 }, nullable: false }], primaryKey: ['id'], comment: 'Notes' }), 10_000)).toEqual({ applied: 1 });
    expect(await driver.applyDdl(buildPlan('mysql', ctx, { kind: 'index', name: 'notes_body', table, columns: [{ name: 'body' }] }), 10_000)).toEqual({ applied: 1 });
    const fn = buildPlan('mysql', ctx, { kind: 'function', name: fnName, params: [{ name: 'amount', type: { type: 'DECIMAL', precision: 12, scale: 2 } }], returns: { type: 'DECIMAL', precision: 12, scale: 2 }, deterministic: true, body: 'DECLARE r DECIMAL(12, 2);\nSET r = amount * 1.2;\nRETURN r;' });
    expect(await driver.applyDdl(fn, 10_000)).toEqual({ applied: 1 });
    expect(String((await sql(`SELECT ${fnName}(10) AS v`))[0]!.v)).toBe('12.00');
  });

  it('stops at the first failure and refuses two statements in one text', async () => {
    const t = buildPlan('mysql', ctx, { kind: 'table', name: table, columns: [{ name: 'a', type: { type: 'INT' } }] });
    await expect(driver.applyDdl({ ...t, statements: [`CREATE INDEX x ON ${table}_missing (a)`] }, 10_000)).rejects.toThrow(/^Statement 1 of 1 failed after 0 applied/);
    await expect(driver.applyDdl({ ...t, statements: [`CREATE TABLE ${table}_a (a int); CREATE TABLE ${table}_b (a int)`] }, 10_000)).rejects.toThrow(/syntax/i);
  });
});

describe.skipIf(!process.env.TEST_MSSQL_URL)('SQL Server applyDdl (TEST_MSSQL_URL)', () => {
  const u = new URL(process.env.TEST_MSSQL_URL ?? 'mssql://x:y@127.0.0.1/x');
  // ApplicationIntent ReadOnly in the settings: applyDdl still asks for ReadWrite.
  const spec: ConnectionSpec = { engine: 'mssql', endpoint: `${u.hostname}:${u.port || 1433}`, database: u.pathname.slice(1) || 'master', tls: u.searchParams.get('encrypt') === 'true', username: decodeURIComponent(u.username), password: decodeURIComponent(u.password), options: { applicationIntent: 'ReadOnly' } };
  const driver = new MssqlDriver(spec, allow);
  const ctx = ctxOf('mssql', spec.database);
  const schema = `ddl_${tag}`;
  const admin = driver as unknown as { session: <T>(ms: number, fn: (c: unknown) => Promise<T>, rw?: boolean) => Promise<T>; exec: (c: unknown, sql: string, params?: unknown[], stop?: number, batch?: boolean) => Promise<{ rows: unknown[][] }> };
  const sql = (text: string) => admin.session(10_000, (c) => admin.exec(c, text, [], Infinity, true), true);

  afterAll(async () => {
    for (const s of [`DROP FUNCTION IF EXISTS [${schema}].[add_tax]`, `DROP TABLE IF EXISTS [${schema}].[notes]`, `DROP TABLE IF EXISTS [${schema}].[gone]`, `DROP SCHEMA IF EXISTS [${schema}]`]) await sql(s).catch(() => undefined);
  });

  it('creates a schema, a table, an index and a function', async () => {
    expect(await driver.applyDdl(buildPlan('mssql', ctx, { kind: 'dataset', name: schema }), 10_000)).toEqual({ applied: 1 });
    expect(await driver.applyDdl(buildPlan('mssql', ctx, { kind: 'table', name: `${schema}.notes`, columns: [{ name: 'id', type: { type: 'INT' }, identity: true }, { name: 'body', type: { type: 'NVARCHAR', length: 200 }, nullable: false }], primaryKey: ['id'] }), 10_000)).toEqual({ applied: 1 });
    expect(await driver.applyDdl(buildPlan('mssql', ctx, { kind: 'index', name: 'notes_body', table: `${schema}.notes`, columns: [{ name: 'body' }] }), 10_000)).toEqual({ applied: 1 });
    expect(await driver.applyDdl(buildPlan('mssql', ctx, { kind: 'function', name: `${schema}.add_tax`, params: [{ name: 'amount', type: { type: 'DECIMAL', precision: 12, scale: 2 } }], returns: { type: 'DECIMAL', precision: 12, scale: 2 }, body: 'RETURN @amount * 1.2;' }), 10_000)).toEqual({ applied: 1 });
    expect(String((await sql(`SELECT [${schema}].[add_tax](10)`)).rows[0]![0])).toMatch(/^12(\.0+)?$/);
  });

  it('rolls a failing transactional plan back whole', async () => {
    const t = buildPlan('mssql', ctx, { kind: 'table', name: `${schema}.gone`, columns: [{ name: 'a', type: { type: 'INT' } }] });
    await expect(driver.applyDdl({ ...t, statements: [t.statements[0]!, `CREATE INDEX x ON [${schema}].[missing] (a)`] }, 10_000)).rejects.toThrow(/^Statement 2 of 2 failed; the transaction was rolled back/);
    expect((await sql(`SELECT OBJECT_ID('[${schema}].[gone]')`)).rows[0]![0]).toBeNull();
  });
});

describe.skipIf(!process.env.TEST_ORACLE_URL)('Oracle applyDdl (TEST_ORACLE_URL)', () => {
  const u = new URL(process.env.TEST_ORACLE_URL ?? 'oracle://x:y@127.0.0.1:1521/X');
  const spec: ConnectionSpec = { engine: 'oracle', endpoint: `${u.hostname}:${u.port || 1521}`, database: u.pathname.slice(1), tls: false, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password), options: {} };
  const driver = new OracleDriver(spec, allow);
  const ctx = ctxOf('oracle', spec.database);
  const table = `DDL_NOTES_${tag}`.toUpperCase();
  const proc = `DDL_TOUCH_${tag}`.toUpperCase();
  const fnName = `DDL_TAX_${tag}`.toUpperCase();
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
    for (const s of [`DROP FUNCTION "${fnName}"`, `DROP PROCEDURE "${proc}"`, `DROP TABLE "${table}" PURGE`]) await sql(s).catch(() => undefined);
  });

  it('creates a table with comments, an index, a function and a procedure, each statement verbatim', async () => {
    const t = buildPlan('oracle', ctx, { kind: 'table', name: table, columns: [{ name: 'id', type: { type: 'NUMBER', precision: 12, scale: 0 }, identity: true }, { name: 'body', type: { type: 'VARCHAR2', length: 200 }, nullable: false, comment: 'The text' }], primaryKey: ['id'], comment: 'Notes' });
    expect(await driver.applyDdl(t, 20_000)).toEqual({ applied: 3 });
    expect(await driver.applyDdl(buildPlan('oracle', ctx, { kind: 'index', name: `${table}_B`, table, columns: [{ name: 'body' }] }), 20_000)).toEqual({ applied: 1 });
    const fn = buildPlan('oracle', ctx, { kind: 'function', name: fnName, params: [{ name: 'amount', type: { type: 'NUMBER' } }], returns: { type: 'NUMBER' }, body: 'RETURN amount * 1.2;' });
    expect(fn.statements[0]).toMatch(/END;$/);
    expect(await driver.applyDdl(fn, 20_000)).toEqual({ applied: 1 });
    expect(Number((await sql(`SELECT "${fnName}"(10) FROM dual`)).rows![0]![0])).toBe(12);
    expect(await driver.applyDdl(buildPlan('oracle', ctx, { kind: 'procedure', name: proc, params: [{ name: 'n', type: { type: 'NUMBER' }, mode: 'inout' }], body: 'n := n + 1;' }), 20_000)).toEqual({ applied: 1 });
  });

  it('reports a routine that compiled with errors', async () => {
    const bad = buildPlan('oracle', ctx, { kind: 'procedure', name: proc, params: [], body: 'no_such_thing();', orReplace: true });
    await expect(driver.applyDdl(bad, 20_000)).rejects.toThrow(/compilation errors/);
  });
});
