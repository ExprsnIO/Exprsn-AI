/*
 * 2.0.x editing: reading objects back through connections. `parseType` (a type as each database reports it, read
 * into the designer's catalogue), the shared helpers of describe-sql.ts (defaults, CHECKs, routine bodies that
 * round-trip through buildPlan), and `describe` / `routines` against fakes: D1 on a real SQLite catalog
 * (better-sqlite3 behind the injected send), Snowflake's SQL API, BigQuery's REST API, OpenSearch's mapping and
 * settings, plus the new OpenSearch and BigQuery edit operations. PostgreSQL, MySQL, SQL Server and Oracle are in
 * test/integration/connections-describe.test.ts.
 */
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BigQueryDriver } from '../src/connections/bigquery.js';
import { D1Driver } from '../src/connections/d1.js';
import { buildPlan, type DdlPlan } from '../src/connections/ddl.js';
import type { RoutineDescription, TableDescription } from '../src/connections/ddl-edit-types.js';
import { parseType, renderType } from '../src/connections/ddl-types.js';
import { checkExpression, classifyDefault, indexPredicate, mysqlBodyFromCreate, oracleRoutineBody, sqliteCreateParts, trimBody, tsqlRoutineBody, tsqlTypeText, oracleTypeText, snowflakeTypeText, viewSelect } from '../src/connections/describe-sql.js';
import { mysqlDefault } from '../src/connections/describe-pg-mysql.js';
import type { NameContext } from '../src/connections/dialects.js';
import { OpenSearchDriver } from '../src/connections/drivers.js';
import { SnowflakeDriver } from '../src/connections/snowflake.js';
import { parseAllowList } from '../src/mcp/hosts.js';
import type { GuardedRequest, GuardedResponse } from '../src/platform/egress.js';

const allow = parseAllowList('');

async function serve(handler: (req: IncomingMessage, body: string, res: ServerResponse) => void): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += String(c)));
    req.on('end', () => handler(req, raw, res));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}
const stop = async (s: Server) => {
  s.closeAllConnections();
  await new Promise((r) => s.close(r));
};
const send = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

describe('parseType', () => {
  it('PostgreSQL: format_type and information_schema spellings', () => {
    const p = (raw: string) => parseType('postgres', raw);
    expect(p('character varying(200)')).toEqual({ type: 'varchar', length: 200 });
    expect(p('character varying')).toEqual({ type: 'varchar' });
    expect(p('varchar(10)')).toEqual({ type: 'varchar', length: 10 });
    expect(p('character(3)')).toEqual({ type: 'char', length: 3 });
    expect(p('bpchar')).toEqual({ type: 'char' });
    expect(p('timestamp with time zone')).toEqual({ type: 'timestamptz' });
    expect(p('timestamp(3) with time zone')).toEqual({ type: 'timestamptz', precision: 3 });
    expect(p('timestamp without time zone')).toEqual({ type: 'timestamp' });
    expect(p('time(6) without time zone')).toEqual({ type: 'time', precision: 6 });
    expect(p('time with time zone')).toEqual({ type: 'timetz' });
    for (const x of ['int4', 'integer', 'int', 'serial']) expect(p(x)).toEqual({ type: 'integer' });
    expect(p('int8')).toEqual({ type: 'bigint' });
    expect(p('bigserial')).toEqual({ type: 'bigint' });
    expect(p('int2')).toEqual({ type: 'smallint' });
    expect(p('numeric(12,2)')).toEqual({ type: 'numeric', precision: 12, scale: 2 });
    expect(p('numeric(12, 2)')).toEqual({ type: 'numeric', precision: 12, scale: 2 });
    expect(p('numeric(7)')).toEqual({ type: 'numeric', precision: 7 });
    expect(p('numeric')).toEqual({ type: 'numeric' });
    expect(p('decimal(5,1)')).toEqual({ type: 'numeric', precision: 5, scale: 1 });
    expect(p('double precision')).toEqual({ type: 'double precision' });
    expect(p('float8')).toEqual({ type: 'double precision' });
    expect(p('float4')).toEqual({ type: 'real' });
    expect(p('bool')).toEqual({ type: 'boolean' });
    expect(p('_text')).toEqual({ type: 'text', array: true });
    expect(p('text[]')).toEqual({ type: 'text', array: true });
    expect(p('integer[]')).toEqual({ type: 'integer', array: true });
    expect(p('character varying(20)[]')).toEqual({ type: 'varchar', length: 20, array: true });
    expect(p('_int4')).toEqual({ type: 'integer', array: true });
    expect(p('jsonb')).toEqual({ type: 'jsonb' });
    expect(p('uuid')).toEqual({ type: 'uuid' });
    expect(p('pg_catalog.int4')).toEqual({ type: 'integer' });
    expect(p('ARRAY')).toBeNull();
    expect(p('USER-DEFINED')).toBeNull();
    expect(p('bit varying(5)')).toBeNull();
    expect(p('void')).toBeNull();
    expect(p('')).toBeNull();
  });

  it('MySQL: COLUMN_TYPE with unsigned, display widths, ENUM and SET, TINYINT(1)', () => {
    const m = (raw: string) => parseType('mysql', raw);
    expect(m('int unsigned')).toEqual({ type: 'INT', unsigned: true });
    expect(m('int(11)')).toEqual({ type: 'INT' });
    expect(m('int(10) unsigned zerofill')).toEqual({ type: 'INT', unsigned: true });
    expect(m('bigint(20) unsigned')).toEqual({ type: 'BIGINT', unsigned: true });
    expect(m('varchar(255)')).toEqual({ type: 'VARCHAR', length: 255 });
    expect(m('char(36)')).toEqual({ type: 'CHAR', length: 36 });
    expect(m("enum('a','b')")).toEqual({ type: 'ENUM', values: ['a', 'b'] });
    expect(m("enum('it''s','a,b','x\\\\y')")).toEqual({ type: 'ENUM', values: ["it's", 'a,b', 'x\\y'] });
    expect(m("set('red','green')")).toEqual({ type: 'SET', values: ['red', 'green'] });
    expect(m('tinyint(1)')).toEqual({ type: 'BOOLEAN' });
    expect(m('tinyint(4)')).toEqual({ type: 'TINYINT' });
    expect(m('tinyint unsigned')).toEqual({ type: 'TINYINT', unsigned: true });
    expect(m('decimal(12,2)')).toEqual({ type: 'DECIMAL', precision: 12, scale: 2 });
    expect(m('decimal(12,2) unsigned')).toEqual({ type: 'DECIMAL', precision: 12, scale: 2 });
    expect(m('datetime(6)')).toEqual({ type: 'DATETIME', precision: 6 });
    expect(m('timestamp')).toEqual({ type: 'TIMESTAMP' });
    expect(m('double')).toEqual({ type: 'DOUBLE' });
    expect(m('float(10,2)')).toEqual({ type: 'FLOAT' });
    expect(m('bit(1)')).toEqual({ type: 'BIT', precision: 1 });
    expect(m('json')).toEqual({ type: 'JSON' });
    expect(m('longtext')).toEqual({ type: 'LONGTEXT' });
    expect(m('varbinary(16)')).toEqual({ type: 'VARBINARY', length: 16 });
    expect(m('year')).toEqual({ type: 'YEAR' });
    expect(m('varchar(20) CHARSET utf8mb4 COLLATE utf8mb4_bin')).toEqual({ type: 'VARCHAR', length: 20 });
    expect(m('linestring')).toBeNull();
  });

  it('T-SQL: max, character lengths, precision', () => {
    const t = (raw: string) => parseType('tsql', raw);
    expect(t('nvarchar(max)')).toEqual({ type: 'NVARCHAR', length: 'max' });
    expect(t('varchar(-1)')).toEqual({ type: 'VARCHAR', length: 'max' });
    expect(t('nvarchar(200)')).toEqual({ type: 'NVARCHAR', length: 200 });
    expect(t('varbinary(max)')).toEqual({ type: 'VARBINARY', length: 'max' });
    expect(t('datetime2(7)')).toEqual({ type: 'DATETIME2', precision: 7 });
    expect(t('datetimeoffset(3)')).toEqual({ type: 'DATETIMEOFFSET', precision: 3 });
    expect(t('decimal(12,2)')).toEqual({ type: 'DECIMAL', precision: 12, scale: 2 });
    expect(t('numeric(18,0)')).toEqual({ type: 'NUMERIC', precision: 18, scale: 0 });
    expect(t('float(53)')).toEqual({ type: 'FLOAT', precision: 53 });
    expect(t('int')).toEqual({ type: 'INT' });
    expect(t('bit')).toEqual({ type: 'BIT' });
    expect(t('uniqueidentifier')).toEqual({ type: 'UNIQUEIDENTIFIER' });
    expect(t('timestamp')).toEqual({ type: 'ROWVERSION' });
    expect(t('sysname')).toEqual({ type: 'NVARCHAR', length: 128 });
    expect(t('text')).toBeNull();
    // sys.columns lengths: nvarchar in bytes (2 a character), -1 for max.
    expect(tsqlTypeText('nvarchar', 400, 0, 0)).toBe('nvarchar(200)');
    expect(tsqlTypeText('nvarchar', -1, 0, 0)).toBe('nvarchar(max)');
    expect(tsqlTypeText('varchar', 50, 0, 0)).toBe('varchar(50)');
    expect(tsqlTypeText('decimal', 9, 12, 2)).toBe('decimal(12,2)');
    expect(tsqlTypeText('datetime2', 8, 27, 7)).toBe('datetime2(7)');
    expect(tsqlTypeText('int', 4, 10, 0)).toBe('int');
  });

  it('Oracle: NUMBER, VARCHAR2 with BYTE or CHAR, TIMESTAMP WITH TIME ZONE, intervals', () => {
    const o = (raw: string) => parseType('oracle', raw);
    expect(o('NUMBER(12,2)')).toEqual({ type: 'NUMBER', precision: 12, scale: 2 });
    expect(o('NUMBER(10)')).toEqual({ type: 'NUMBER', precision: 10 });
    expect(o('NUMBER(*,0)')).toEqual({ type: 'NUMBER', precision: 38, scale: 0 });
    expect(o('NUMBER')).toEqual({ type: 'NUMBER' });
    expect(o('INTEGER')).toEqual({ type: 'NUMBER', precision: 38, scale: 0 });
    expect(o('VARCHAR2(200 BYTE)')).toEqual({ type: 'VARCHAR2', length: 200 });
    expect(o('VARCHAR2(50 CHAR)')).toEqual({ type: 'VARCHAR2', length: 50 });
    expect(o('NVARCHAR2(30)')).toEqual({ type: 'NVARCHAR2', length: 30 });
    expect(o('TIMESTAMP(6) WITH TIME ZONE')).toEqual({ type: 'TIMESTAMP WITH TIME ZONE', precision: 6 });
    expect(o('TIMESTAMP(3) WITH LOCAL TIME ZONE')).toEqual({ type: 'TIMESTAMP WITH LOCAL TIME ZONE', precision: 3 });
    expect(o('TIMESTAMP(6)')).toEqual({ type: 'TIMESTAMP', precision: 6 });
    expect(o('INTERVAL DAY(2) TO SECOND(6)')).toEqual({ type: 'INTERVAL DAY TO SECOND' });
    expect(o('INTERVAL YEAR(2) TO MONTH')).toEqual({ type: 'INTERVAL YEAR TO MONTH' });
    expect(o('FLOAT(126)')).toEqual({ type: 'FLOAT', precision: 126 });
    expect(o('RAW(16)')).toEqual({ type: 'RAW', length: 16 });
    expect(o('DATE')).toEqual({ type: 'DATE' });
    expect(o('CLOB')).toEqual({ type: 'CLOB' });
    expect(o('VARCHAR')).toEqual({ type: 'VARCHAR2' });
    expect(o('LONG')).toBeNull();
    expect(oracleTypeText({ dataType: 'VARCHAR2', dataLength: 800, charLength: 200, charUsed: 'C', precision: null, scale: null })).toBe('VARCHAR2(200 CHAR)');
    expect(oracleTypeText({ dataType: 'NUMBER', dataLength: 22, charLength: 0, charUsed: null, precision: null, scale: 0 })).toBe('NUMBER(*,0)');
    expect(oracleTypeText({ dataType: 'NUMBER', dataLength: 22, charLength: 0, charUsed: null, precision: 12, scale: 2 })).toBe('NUMBER(12,2)');
  });

  it('Snowflake: NUMBER(38,0), VARCHAR(16777216), TIMESTAMP_NTZ(9)', () => {
    const s = (raw: string) => parseType('snowflake', raw);
    expect(s('NUMBER(38,0)')).toEqual({ type: 'NUMBER', precision: 38, scale: 0 });
    expect(s('VARCHAR(16777216)')).toEqual({ type: 'VARCHAR', length: 16777216 });
    expect(s('TIMESTAMP_NTZ(9)')).toEqual({ type: 'TIMESTAMP_NTZ', precision: 9 });
    expect(s('TIMESTAMP_TZ(3)')).toEqual({ type: 'TIMESTAMP_TZ', precision: 3 });
    expect(s('TIMESTAMP')).toEqual({ type: 'TIMESTAMP_NTZ' });
    expect(s('DECIMAL(10,2)')).toEqual({ type: 'NUMBER', precision: 10, scale: 2 });
    expect(s('INT')).toEqual({ type: 'INTEGER' });
    expect(s('TEXT')).toEqual({ type: 'TEXT' });
    expect(s('FLOAT')).toEqual({ type: 'FLOAT' });
    expect(s('BINARY(8388608)')).toEqual({ type: 'BINARY', length: 8388608 });
    expect(s('VARIANT')).toEqual({ type: 'VARIANT' });
    expect(s('BOOLEAN')).toEqual({ type: 'BOOLEAN' });
    expect(s('VECTOR(FLOAT, 3)')).toBeNull();
    expect(snowflakeTypeText({ dataType: 'TEXT', length: 16777216, precision: null, scale: null, datetimePrecision: null })).toBe('VARCHAR(16777216)');
    expect(snowflakeTypeText({ dataType: 'NUMBER', length: null, precision: 38, scale: 0, datetimePrecision: null })).toBe('NUMBER(38,0)');
    expect(snowflakeTypeText({ dataType: 'TIMESTAMP_NTZ', length: null, precision: null, scale: null, datetimePrecision: 9 })).toBe('TIMESTAMP_NTZ(9)');
  });

  it('BigQuery: parameterised types and the legacy names', () => {
    const b = (raw: string) => parseType('bigquery', raw);
    expect(b('STRING(10)')).toEqual({ type: 'STRING', length: 10 });
    expect(b('STRING')).toEqual({ type: 'STRING' });
    expect(b('NUMERIC(12, 2)')).toEqual({ type: 'NUMERIC', precision: 12, scale: 2 });
    expect(b('BIGNUMERIC(40, 2)')).toEqual({ type: 'BIGNUMERIC', precision: 40, scale: 2 });
    expect(b('INT64')).toEqual({ type: 'INT64' });
    expect(b('INTEGER')).toEqual({ type: 'INT64' });
    expect(b('FLOAT')).toEqual({ type: 'FLOAT64' });
    expect(b('BOOLEAN')).toEqual({ type: 'BOOL' });
    expect(b('BYTES(5)')).toEqual({ type: 'BYTES', length: 5 });
    expect(b('TIMESTAMP')).toEqual({ type: 'TIMESTAMP' });
    expect(b('ARRAY<STRING>')).toBeNull();
    expect(b('STRUCT<a INT64>')).toBeNull();
  });

  it('SQLite: the affinity of any declared type', () => {
    const q = (raw: string) => parseType('sqlite', raw);
    expect(q('INTEGER')).toEqual({ type: 'INTEGER' });
    expect(q('int')).toEqual({ type: 'INTEGER' });
    expect(q('BIGINT')).toEqual({ type: 'INTEGER' });
    expect(q('VARCHAR(20)')).toEqual({ type: 'TEXT' });
    expect(q('NVARCHAR(5)')).toEqual({ type: 'TEXT' });
    expect(q('CLOB')).toEqual({ type: 'TEXT' });
    expect(q('BLOB')).toEqual({ type: 'BLOB' });
    expect(q('REAL')).toEqual({ type: 'REAL' });
    expect(q('DOUBLE PRECISION')).toEqual({ type: 'REAL' });
    expect(q('FLOAT')).toEqual({ type: 'REAL' });
    expect(q('DECIMAL(10,5)')).toEqual({ type: 'NUMERIC' });
    expect(q('BOOLEAN')).toEqual({ type: 'NUMERIC' });
    expect(q('DATETIME')).toEqual({ type: 'NUMERIC' });
    expect(q('ANY')).toEqual({ type: 'ANY' });
    expect(q('')).toBeNull();
  });

  it('every parsed type renders again in its dialect', () => {
    const cases: [Parameters<typeof parseType>[0], string][] = [
      ['postgres', 'character varying(200)'], ['postgres', 'numeric(12,2)'], ['postgres', 'timestamp(3) with time zone'], ['postgres', '_text'],
      ['mysql', 'int unsigned'], ['mysql', "enum('a','b')"], ['mysql', 'decimal(12,2)'], ['mysql', 'tinyint(1)'],
      ['tsql', 'nvarchar(max)'], ['tsql', 'datetime2(7)'], ['tsql', 'decimal(12,2)'],
      ['oracle', 'NUMBER(12,2)'], ['oracle', 'VARCHAR2(200 BYTE)'], ['oracle', 'TIMESTAMP(6) WITH TIME ZONE'],
      ['snowflake', 'NUMBER(38,0)'], ['snowflake', 'VARCHAR(16777216)'], ['snowflake', 'TIMESTAMP_NTZ(9)'],
      ['bigquery', 'STRING(10)'], ['bigquery', 'NUMERIC(12, 2)'], ['sqlite', 'VARCHAR(10)']
    ];
    for (const [d, raw] of cases) {
      const t = parseType(d, raw)!;
      expect(renderType(d, t), `${d} ${raw}`).toHaveProperty('text');
    }
    expect(renderType('oracle', parseType('oracle', 'TIMESTAMP(6) WITH TIME ZONE')!)).toEqual({ text: 'TIMESTAMP(6) WITH TIME ZONE' });
    expect(renderType('tsql', parseType('tsql', 'nvarchar(max)')!)).toEqual({ text: 'NVARCHAR(MAX)' });
    expect(renderType('postgres', parseType('postgres', '_text')!)).toEqual({ text: 'text[]' });
  });
});

describe('description helpers', () => {
  it('classifies defaults: literals without quotes or casts, expressions as reported', () => {
    expect(classifyDefault("'abc'::character varying")).toEqual({ kind: 'literal', value: 'abc' });
    expect(classifyDefault("'it''s'::text")).toEqual({ kind: 'literal', value: "it's" });
    expect(classifyDefault('0')).toEqual({ kind: 'literal', value: '0' });
    expect(classifyDefault("'-1'::integer")).toEqual({ kind: 'literal', value: '-1' });
    expect(classifyDefault('(0)::numeric')).toEqual({ kind: 'literal', value: '0' });
    expect(classifyDefault('12.50')).toEqual({ kind: 'literal', value: '12.50' });
    expect(classifyDefault('true')).toEqual({ kind: 'literal', value: 'true' });
    expect(classifyDefault('FALSE')).toEqual({ kind: 'literal', value: 'false' });
    expect(classifyDefault("'{}'::jsonb")).toEqual({ kind: 'literal', value: '{}' });
    expect(classifyDefault("'2026-01-01 00:00:00'::timestamp without time zone")).toEqual({ kind: 'literal', value: '2026-01-01 00:00:00' });
    expect(classifyDefault('((0))')).toEqual({ kind: 'literal', value: '0' });
    expect(classifyDefault("(N'abc')")).toEqual({ kind: 'literal', value: 'abc' });
    expect(classifyDefault("('x')")).toEqual({ kind: 'literal', value: 'x' });
    expect(classifyDefault('now()')).toEqual({ kind: 'expression', value: 'now()' });
    expect(classifyDefault('(getdate())')).toEqual({ kind: 'expression', value: 'getdate()' });
    expect(classifyDefault('CURRENT_TIMESTAMP')).toEqual({ kind: 'expression', value: 'CURRENT_TIMESTAMP' });
    expect(classifyDefault("nextval('t_id_seq'::regclass)")).toEqual({ kind: 'expression', value: "nextval('t_id_seq'::regclass)" });
    expect(classifyDefault("'a' || 'b'")).toEqual({ kind: 'expression', value: "'a' || 'b'" });
    expect(classifyDefault("(datetime('now'))")).toEqual({ kind: 'expression', value: "datetime('now')" });
    expect(classifyDefault('NULL')).toBeNull();
    expect(classifyDefault('NULL::character varying')).toBeNull();
    expect(classifyDefault(null)).toBeNull();
    expect(mysqlDefault('abc', '', 'varchar(10)')).toEqual({ kind: 'literal', value: 'abc' });
    expect(mysqlDefault('CURRENT_TIMESTAMP', 'DEFAULT_GENERATED', 'timestamp')).toEqual({ kind: 'expression', value: 'CURRENT_TIMESTAMP' });
    expect(mysqlDefault('(uuid())', 'DEFAULT_GENERATED', 'char(36)')).toEqual({ kind: 'expression', value: 'uuid()' });
    expect(mysqlDefault('1', '', 'tinyint(1)')).toEqual({ kind: 'literal', value: 'true' });
    expect(mysqlDefault(null, '', 'int')).toBeNull();
  });

  it('reads CHECK expressions and index predicates', () => {
    expect(checkExpression('CHECK ((amount > (0)::numeric))')).toBe('(amount > (0)::numeric)');
    expect(checkExpression('CHECK (amount > 0) NOT VALID')).toBe('amount > 0');
    expect(checkExpression('([amount]>(0))')).toBe('[amount]>(0)');
    expect(checkExpression('(`qty` >= 0)')).toBe('`qty` >= 0');
    expect(checkExpression('"QTY" > 0')).toBe('"QTY" > 0');
    expect(indexPredicate('CREATE INDEX t_open ON t (a) WHERE deleted = 0')).toBe('deleted = 0');
    expect(indexPredicate("CREATE INDEX t_x ON t (a, (lower(b)))")).toBeNull();
    expect(viewSelect('CREATE VIEW big AS SELECT id FROM t')).toBe('SELECT id FROM t');
  });

  it('routine bodies round-trip through the designer\'s CREATE', () => {
    const ctx = (engine: NameContext['engine']): NameContext => ({ engine, database: 'db', account: null, options: {} });
    // SQL Server: the procedure wrapper (AS BEGIN SET NOCOUNT ON; … END) and the function one come off.
    const procBody = 'UPDATE dbo.t SET n = n + @step;\nSELECT @step AS s;';
    const proc = buildPlan('mssql', ctx('mssql'), { kind: 'procedure', name: 'dbo.bump', params: [{ name: 'step', type: { type: 'INT' } }], body: procBody });
    expect(tsqlRoutineBody(proc.statements[0]!, 'procedure')).toBe(procBody);
    const fnBody = 'RETURN @a * 2;';
    const fn = buildPlan('mssql', ctx('mssql'), { kind: 'function', name: 'dbo.twice', params: [{ name: 'a', type: { type: 'INT' } }], returns: { type: 'INT' }, body: fnBody });
    expect(tsqlRoutineBody(fn.statements[0]!, 'function')).toBe(fnBody);
    // A routine written by hand: the text after AS.
    expect(tsqlRoutineBody('CREATE PROCEDURE [dbo].[p] @x int AS\nSELECT @x', 'procedure')).toBe('SELECT @x');
    expect(tsqlRoutineBody('create function dbo.f(@a int) returns table as return (select @a as a)', 'function')).toBe('return (select @a as a)');
    // Oracle: ALL_SOURCE has the text without CREATE; the body after IS/AS.
    const oraBody = 'BEGIN\n  UPDATE t SET n = n + p_step;\nEND;';
    const ora = buildPlan('oracle', ctx('oracle'), { kind: 'procedure', name: 'APP.BUMP', params: [{ name: 'P_STEP', type: { type: 'NUMBER' } }], body: oraBody });
    expect(oracleRoutineBody(ora.statements[0]!.replace(/^CREATE\s+/, ''))).toBe(oraBody);
    expect(oracleRoutineBody('FUNCTION "F" (A IN NUMBER) RETURN NUMBER IS\n  v NUMBER;\nBEGIN\n  RETURN a;\nEND;')).toBe('  v NUMBER;\nBEGIN\n  RETURN a;\nEND;');
    // PostgreSQL: prosrc is the text between the dollar quotes.
    const pgBody = 'BEGIN\n  RETURN a * 2;\nEND;';
    const pg = buildPlan('postgres', ctx('postgres'), { kind: 'function', name: 'public.twice', params: [{ name: 'a', type: { type: 'integer' } }], returns: { type: 'integer' }, language: 'plpgsql', body: pgBody });
    const prosrc = /\$exprsn\$([\s\S]*)\$exprsn\$/.exec(pg.statements[0]!)![1]!;
    expect(trimBody(prosrc)).toBe(pgBody);
    // MySQL: from SHOW CREATE when ROUTINE_DEFINITION is hidden.
    expect(mysqlBodyFromCreate('CREATE DEFINER=`root`@`%` PROCEDURE `bump`(IN step INT)\nBEGIN\n  UPDATE t SET n = n + step;\nEND')).toBe('BEGIN\n  UPDATE t SET n = n + step;\nEND');
  });

  it('reads SQLite CREATE text: named constraints, checks, STRICT and WITHOUT ROWID', () => {
    const p = sqliteCreateParts('CREATE TABLE "t" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "qty" INTEGER CHECK (qty >= 0), "a" TEXT, CONSTRAINT "uq_t_a" UNIQUE ("a"), CONSTRAINT ck_t_1 CHECK ((length(a) > 0) AND a <> \'x)\'), CONSTRAINT "fk_t" FOREIGN KEY ("a") REFERENCES "o" ("a") ON DELETE CASCADE) STRICT');
    expect(p.checks).toEqual([{ name: '', expression: 'qty >= 0' }, { name: 'ck_t_1', expression: "(length(a) > 0) AND a <> 'x)'" }]);
    expect(p.named).toEqual([{ kind: 'unique', name: 'uq_t_a', columns: ['a'] }, { kind: 'fk', name: 'fk_t', columns: ['a'] }]);
    expect(p).toMatchObject({ strict: true, withoutRowid: false, autoincrement: true });
    expect(sqliteCreateParts('CREATE TABLE k (a TEXT PRIMARY KEY) WITHOUT ROWID')).toMatchObject({ strict: false, withoutRowid: true });
  });
});

describe('D1 describe (a real SQLite catalog)', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, CONSTRAINT uq_customers_email UNIQUE (email)) STRICT;
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      total NUMERIC(12,2) NOT NULL DEFAULT 0,
      status TEXT DEFAULT 'new',
      placed TEXT DEFAULT (datetime('now')),
      deleted INTEGER NOT NULL DEFAULT 0,
      CONSTRAINT uq_orders_ref UNIQUE (customer_id, placed),
      CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE,
      CONSTRAINT ck_orders_1 CHECK (total >= 0)
    );
    CREATE INDEX ix_orders_open ON orders (placed DESC, status) WHERE deleted = 0;
    CREATE TABLE lines (order_id INTEGER REFERENCES orders ON DELETE SET NULL, n INTEGER CHECK (n > 0), PRIMARY KEY (order_id, n)) WITHOUT ROWID;
    CREATE VIEW open_orders AS SELECT id, total FROM orders WHERE deleted = 0;
  `);
  const sent: string[] = [];
  const fake = async (r: GuardedRequest): Promise<GuardedResponse> => {
    const body = JSON.parse(String(r.body)) as { sql: string; params?: unknown[] };
    sent.push(body.sql);
    const reply = (status: number, doc: unknown) => ({ status, headers: {}, body: Buffer.from(JSON.stringify(doc)) }) as unknown as GuardedResponse;
    try {
      const st = db.prepare(body.sql);
      const columns = st.columns().map((c) => c.name);
      const rows = st.raw(true).all(...((body.params ?? []) as never[])) as unknown[][];
      return reply(200, { success: true, errors: [], result: [{ success: true, results: { columns, rows }, meta: {} }] });
    } catch (err) {
      return reply(400, { success: false, errors: [{ code: 7500, message: (err as Error).message }], result: null });
    }
  };
  const driver = () => new D1Driver({ engine: 'cloudflare-d1', endpoint: 'https://api.cloudflare.com', database: 'db-1', tls: true, username: 'acct-1', password: 'tok' }, allow, fake);

  it('describes a table with its keys, constraints, partial index and options, sending only reads', async () => {
    const t = (await driver().describe('orders', 'table', 5000)) as TableDescription;
    expect(t.kind).toBe('table');
    expect(t.columns.map((c) => [c.name, c.type?.type, c.nullable, c.default, c.identity])).toEqual([
      ['id', 'INTEGER', false, null, true],
      ['customer_id', 'INTEGER', false, null, false],
      ['total', 'NUMERIC', false, { kind: 'literal', value: '0' }, false],
      ['status', 'TEXT', true, { kind: 'literal', value: 'new' }, false],
      ['placed', 'TEXT', true, { kind: 'expression', value: "datetime('now')" }, false],
      ['deleted', 'INTEGER', false, { kind: 'literal', value: '0' }, false]
    ]);
    expect(t.columns[2]!.rawType).toBe('NUMERIC(12,2)');
    expect(t.primaryKey).toEqual({ name: null, columns: ['id'] });
    expect(t.uniques).toEqual([{ name: 'uq_orders_ref', columns: ['customer_id', 'placed'] }]);
    expect(t.foreignKeys).toEqual([{ name: 'fk_orders_customer', columns: ['customer_id'], refTable: 'customers', refColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'NO ACTION' }]);
    expect(t.checks).toEqual([{ name: 'ck_orders_1', expression: 'total >= 0' }]);
    const open = t.indexes.find((i) => i.name === 'ix_orders_open')!;
    expect(open).toEqual({ name: 'ix_orders_open', columns: [{ name: 'placed', order: 'desc' }, { name: 'status', order: 'asc' }], unique: false, method: 'btree', where: 'deleted = 0', include: [], constraint: false });
    expect(t.indexes.find((i) => i.name.startsWith('sqlite_autoindex'))).toMatchObject({ unique: true, constraint: true });
    expect(t.options).toEqual({});
    expect(await driver().describe('customers', 'table', 5000)).toMatchObject({ options: { strict: true }, uniques: [{ name: 'uq_customers_email', columns: ['email'] }] });
    expect(sent.every((s) => /^SELECT /.test(s))).toBe(true);
  });

  it('a WITHOUT ROWID table with a composite key, an implicit reference and a column CHECK', async () => {
    const t = (await driver().describe('main.lines', 'table', 5000)) as TableDescription;
    expect(t.primaryKey).toEqual({ name: null, columns: ['order_id', 'n'] });
    expect(t.columns.every((c) => !c.identity)).toBe(true);
    expect(t.foreignKeys).toEqual([{ name: '', columns: ['order_id'], refTable: 'orders', refColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'NO ACTION' }]);
    expect(t.checks).toEqual([{ name: '', expression: 'n > 0' }]);
    expect(t.options).toEqual({ withoutRowid: true });
  });

  it('a view, a missing table, and no routines', async () => {
    const v = (await driver().describe('open_orders', 'view', 5000)) as TableDescription;
    expect(v).toMatchObject({ kind: 'view', name: 'open_orders', definition: 'SELECT id, total FROM orders WHERE deleted = 0' });
    expect(v.columns.map((c) => c.name)).toEqual(['id', 'total']);
    expect(await driver().describe('nope', 'table', 5000)).toBeNull();
    expect(await driver().describe('other.orders', 'table', 5000)).toBeNull();
    await expect(driver().describe('f', 'function', 5000)).rejects.toThrow(/no stored procedures/);
    expect(await driver().routines()).toEqual([]);
  });
});

/** Snowflake's SQL API: INFORMATION_SCHEMA and SHOW … KEYS answers for one table, a view and a procedure. */
describe('Snowflake describe', () => {
  let fake: { url: string; server: Server };
  const statements: { statement: string; bindings?: Record<string, { value: string | null }> }[] = [];
  const result = (cols: string[], data: (string | null)[][]) => ({ code: '090001', statementHandle: 'h', resultSetMetaData: { numRows: data.length, rowType: cols.map((name) => ({ name, type: 'text' })), partitionInfo: [{ rowCount: data.length }] }, data });
  beforeAll(async () => {
    fake = await serve((req, raw, res) => {
      if (req.headers.authorization !== 'Bearer pat-123') return send(res, 401, { message: 'bad token' });
      const body = JSON.parse(raw) as { statement: string; bindings?: Record<string, { value: string | null }> };
      statements.push(body);
      const st = body.statement;
      const arg = (n: number) => body.bindings?.[String(n)]?.value ?? null;
      if (st.includes('INFORMATION_SCHEMA.TABLES')) {
        const rows: Record<string, (string | null)[]> = { ORDERS: ['BASE TABLE', 'YES', 'LINEAR(REGION, PLACED)', 'All orders'], OPEN_ORDERS: ['VIEW', 'NO', null, null] };
        const r = arg(1) === 'SALES' ? rows[String(arg(2))] : undefined;
        return send(res, 200, result(['TABLE_TYPE', 'IS_TRANSIENT', 'CLUSTERING_KEY', 'COMMENT'], r ? [r] : []));
      }
      if (st.includes('INFORMATION_SCHEMA.COLUMNS')) {
        const cols = ['COLUMN_NAME', 'DATA_TYPE', 'CHARACTER_MAXIMUM_LENGTH', 'NUMERIC_PRECISION', 'NUMERIC_SCALE', 'DATETIME_PRECISION', 'IS_NULLABLE', 'COLUMN_DEFAULT', 'IS_IDENTITY', 'COMMENT'];
        if (arg(2) === 'OPEN_ORDERS') return send(res, 200, result(cols, [['ID', 'NUMBER', null, '38', '0', null, 'YES', null, 'NO', null]]));
        return send(res, 200, result(cols, [
          ['ID', 'NUMBER', null, '38', '0', null, 'NO', null, 'YES', null],
          ['CUSTOMER_ID', 'NUMBER', null, '38', '0', null, 'NO', null, 'NO', null],
          ['REGION', 'TEXT', '16777216', null, null, null, 'YES', "'EU'", 'NO', 'Sales region'],
          ['TOTAL', 'NUMBER', null, '12', '2', null, 'NO', '0', 'NO', null],
          ['PLACED', 'TIMESTAMP_NTZ', null, null, null, '9', 'YES', 'CURRENT_TIMESTAMP()', 'NO', null]
        ]));
      }
      if (st.includes('INFORMATION_SCHEMA.VIEWS')) return send(res, 200, result(['VIEW_DEFINITION'], [['create view OPEN_ORDERS as select ID from ORDERS;']]));
      if (st.startsWith('SHOW PRIMARY KEYS')) return send(res, 200, result(['created_on', 'database_name', 'schema_name', 'table_name', 'column_name', 'key_sequence', 'constraint_name'], [['t', 'ANALYTICS', 'SALES', 'ORDERS', 'ID', '1', 'PK_ORDERS']]));
      if (st.startsWith('SHOW UNIQUE KEYS')) return send(res, 200, result(['created_on', 'column_name', 'key_sequence', 'constraint_name'], [['t', 'PLACED', '2', 'UQ_ORDERS'], ['t', 'CUSTOMER_ID', '1', 'UQ_ORDERS']]));
      if (st.startsWith('SHOW IMPORTED KEYS')) return send(res, 200, result(['pk_schema_name', 'pk_table_name', 'pk_column_name', 'fk_column_name', 'key_sequence', 'update_rule', 'delete_rule', 'fk_name'], [['SALES', 'CUSTOMERS', 'ID', 'CUSTOMER_ID', '1', 'NO ACTION', 'CASCADE', 'FK_ORDERS_CUSTOMER']]));
      if (st.includes('INFORMATION_SCHEMA.PROCEDURES') && st.includes('ARGUMENT_SIGNATURE AS SIG')) return send(res, 200, result(['S', 'N', 'SIG'], [['SALES', 'BUMP', '(STEP NUMBER, NOTE VARCHAR)']]));
      if (st.includes('INFORMATION_SCHEMA.FUNCTIONS') && st.includes('ARGUMENT_SIGNATURE AS SIG')) return send(res, 200, result(['S', 'N', 'SIG'], [['SALES', 'ADD_TAX', '(AMOUNT NUMBER)']]));
      if (st.includes('INFORMATION_SCHEMA.PROCEDURES')) return send(res, 200, result(['ARGUMENT_SIGNATURE', 'DATA_TYPE', 'LANG', 'DEF', 'COMMENT'], arg(2) === 'BUMP' ? [['(STEP NUMBER, NOTE VARCHAR)', 'VARCHAR', 'SQL', '\nBEGIN\n  RETURN \'ok\';\nEND;\n', 'Bumps']] : []));
      return send(res, 400, { message: `unexpected ${st}` });
    });
  });
  afterAll(() => stop(fake.server));
  const driver = () => new SnowflakeDriver({ engine: 'snowflake', endpoint: fake.url, database: 'ANALYTICS', tls: true, username: 'SVC', password: 'pat-123', options: { auth: 'pat', schema: 'SALES', warehouse: 'WH' } }, allow, { allowHttp: true });

  it('describes a table: types, identity, defaults, keys from SHOW … KEYS, transient and clustering', async () => {
    const t = (await driver().describe('ORDERS', 'table', 5000)) as TableDescription;
    expect(t).toMatchObject({ kind: 'table', name: 'SALES.ORDERS', comment: 'All orders', options: { transient: true, clusterBy: ['REGION', 'PLACED'] }, indexes: [], checks: [] });
    expect(t.columns.map((c) => [c.name, c.rawType, c.type, c.nullable, c.default, c.identity])).toEqual([
      ['ID', 'NUMBER(38,0)', { type: 'NUMBER', precision: 38, scale: 0 }, false, null, true],
      ['CUSTOMER_ID', 'NUMBER(38,0)', { type: 'NUMBER', precision: 38, scale: 0 }, false, null, false],
      ['REGION', 'VARCHAR(16777216)', { type: 'VARCHAR', length: 16777216 }, true, { kind: 'literal', value: 'EU' }, false],
      ['TOTAL', 'NUMBER(12,2)', { type: 'NUMBER', precision: 12, scale: 2 }, false, { kind: 'literal', value: '0' }, false],
      ['PLACED', 'TIMESTAMP_NTZ(9)', { type: 'TIMESTAMP_NTZ', precision: 9 }, true, { kind: 'expression', value: 'CURRENT_TIMESTAMP()' }, false]
    ]);
    expect(t.columns[2]!.comment).toBe('Sales region');
    expect(t.primaryKey).toEqual({ name: 'PK_ORDERS', columns: ['ID'] });
    expect(t.uniques).toEqual([{ name: 'UQ_ORDERS', columns: ['CUSTOMER_ID', 'PLACED'] }]);
    expect(t.foreignKeys).toEqual([{ name: 'FK_ORDERS_CUSTOMER', columns: ['CUSTOMER_ID'], refTable: 'SALES.CUSTOMERS', refColumns: ['ID'], onDelete: 'CASCADE', onUpdate: 'NO ACTION' }]);
    expect(statements.some((s) => s.statement === 'SHOW PRIMARY KEYS IN TABLE ANALYTICS.SALES.ORDERS')).toBe(true);
  });

  it('a view with its definition, a missing table, a procedure and the routine list', async () => {
    expect(await driver().describe('SALES.OPEN_ORDERS', 'view', 5000)).toMatchObject({ kind: 'view', definition: 'create view OPEN_ORDERS as select ID from ORDERS;' });
    expect(await driver().describe('SALES.NOPE', 'table', 5000)).toBeNull();
    const p = (await driver().describe('SALES.BUMP', 'procedure', 5000)) as RoutineDescription;
    expect(p).toMatchObject({ kind: 'procedure', name: 'SALES.BUMP', language: 'sql', body: "BEGIN\n  RETURN 'ok';\nEND;", comment: 'Bumps', returns: { type: { type: 'VARCHAR' }, rawType: 'VARCHAR' }, signature: 'NUMBER, VARCHAR' });
    expect(p.params).toEqual([{ name: 'STEP', type: { type: 'NUMBER' }, rawType: 'NUMBER', mode: 'in' }, { name: 'NOTE', type: { type: 'VARCHAR' }, rawType: 'VARCHAR', mode: 'in' }]);
    expect(await driver().describe('SALES.MISSING', 'procedure', 5000)).toBeNull();
    expect(await driver().routines(5000)).toEqual([{ name: 'SALES.ADD_TAX', kind: 'function', signature: 'NUMBER' }, { name: 'SALES.BUMP', kind: 'procedure', signature: 'NUMBER, VARCHAR' }]);
  });
});

/** BigQuery's REST API: tables.get, routines.get and list, search indexes as a query, and the delete operations. */
describe('BigQuery describe and delete operations', () => {
  let fake: { url: string; server: Server };
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const calls: string[] = [];
  const datasets = new Set(['sales', 'staging']);
  const routines = new Map<string, Record<string, unknown>>([
    ['sales.add_tax', { routineReference: { routineId: 'add_tax' }, routineType: 'SCALAR_FUNCTION', language: 'SQL', arguments: [{ name: 'amount', dataType: { typeKind: 'NUMERIC' } }], returnType: { typeKind: 'NUMERIC' }, definitionBody: 'amount * 1.2', description: 'Tax', determinismLevel: 'DETERMINISTIC' }],
    ['sales.touch', { routineReference: { routineId: 'touch' }, routineType: 'PROCEDURE', language: 'SQL', arguments: [{ name: 'n', dataType: { typeKind: 'INT64' }, mode: 'INOUT' }], definitionBody: 'BEGIN\nSET n = n + 1;\nEND' }]
  ]);
  const key = () => JSON.stringify({ client_email: 'svc@proj.iam.gserviceaccount.com', private_key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), token_uri: `${fake.url}/token` });
  beforeAll(async () => {
    fake = await serve((req, raw, res) => {
      const u = new URL(req.url ?? '/', fake.url);
      if (u.pathname === '/token') {
        const [h, c, sig] = (new URLSearchParams(raw).get('assertion') ?? '').split('.');
        return createVerify('RSA-SHA256').update(`${h}.${c}`).verify(keys.publicKey, sig ?? '', 'base64url') ? send(res, 200, { access_token: 'ya29.x', expires_in: 3599 }) : send(res, 400, { error: 'invalid_grant' });
      }
      if (req.headers.authorization !== 'Bearer ya29.x') return send(res, 401, { error: { code: 401, message: 'no', status: 'UNAUTHENTICATED' } });
      calls.push(`${req.method} ${u.pathname}${u.search}`);
      const notFound = () => send(res, 404, { error: { code: 404, message: 'Not found', status: 'NOT_FOUND' } });
      const base = '/bigquery/v2/projects/proj';
      if (req.method === 'GET' && u.pathname === `${base}/datasets/sales/tables/orders`)
        return send(res, 200, {
          type: 'TABLE',
          description: 'Orders',
          schema: { fields: [
            { name: 'id', type: 'INTEGER', mode: 'REQUIRED' },
            { name: 'note', type: 'STRING', maxLength: '10', description: 'A note', defaultValueExpression: "'none'" },
            { name: 'amount', type: 'NUMERIC', precision: '12', scale: '2' },
            { name: 'placed', type: 'TIMESTAMP', defaultValueExpression: 'CURRENT_TIMESTAMP()' },
            { name: 'tags', type: 'STRING', mode: 'REPEATED' }
          ] },
          timePartitioning: { type: 'DAY', field: 'placed' },
          clustering: { fields: ['id'] },
          tableConstraints: { primaryKey: { columns: ['id'] }, foreignKeys: [{ name: 'fk_cust', referencedTable: { projectId: 'proj', datasetId: 'sales', tableId: 'customers' }, columnReferences: [{ referencingColumn: 'id', referencedColumn: 'cid' }] }] }
        });
      if (req.method === 'GET' && u.pathname === `${base}/datasets/sales/tables/v_orders`) return send(res, 200, { type: 'VIEW', schema: { fields: [{ name: 'id', type: 'INT64' }] }, view: { query: 'SELECT id FROM sales.orders' } });
      if (req.method === 'POST' && u.pathname === `${base}/queries`) {
        const body = JSON.parse(raw) as { query: string };
        if (!body.query.includes('SEARCH_INDEXES')) return send(res, 400, { error: { code: 400, message: 'unexpected', status: 'INVALID_ARGUMENT' } });
        return send(res, 200, { jobComplete: true, jobReference: { jobId: 'j' }, schema: { fields: [{ name: 'index_name', type: 'STRING' }, { name: 'index_column_name', type: 'STRING' }] }, rows: [{ f: [{ v: 'orders_search' }, { v: 'note' }] }, { f: [{ v: 'orders_search' }, { v: 'tags' }] }] });
      }
      if (req.method === 'GET' && u.pathname === `${base}/datasets`) return send(res, 200, { datasets: [...datasets].map((d) => ({ datasetReference: { datasetId: d } })) });
      const rl = new RegExp(`^${base}/datasets/([^/]+)/routines$`).exec(u.pathname);
      if (req.method === 'GET' && rl) return send(res, 200, { routines: [...routines].filter(([k]) => k.startsWith(`${rl[1]}.`)).map(([, v]) => v) });
      const r = new RegExp(`^${base}/datasets/([^/]+)/routines/([^/]+)$`).exec(u.pathname);
      if (r) {
        const k = `${r[1]}.${r[2]}`;
        if (!routines.has(k)) return notFound();
        if (req.method === 'DELETE') {
          routines.delete(k);
          return send(res, 204, {});
        }
        return send(res, 200, routines.get(k));
      }
      const d = new RegExp(`^${base}/datasets/([^/]+)$`).exec(u.pathname);
      if (d && req.method === 'DELETE') {
        if (!datasets.has(d[1]!)) return notFound();
        datasets.delete(d[1]!);
        return send(res, 204, {});
      }
      return notFound();
    });
  });
  afterAll(() => stop(fake.server));
  const driver = () => new BigQueryDriver({ engine: 'bigquery', endpoint: 'bigquery.googleapis.com', database: 'proj', tls: true, username: null, password: key(), options: {} }, allow, { baseUrl: fake.url, allowHttp: true });
  const plan = (ops: DdlPlan['ops']): DdlPlan => ({ engine: 'bigquery', kind: 'drop', object: 'x', statements: [], ops, transactional: false, touches: [], notes: [], destructive: true, confirmName: 'x', hash: 'h' }) as DdlPlan;

  it('describes a table from tables.get with its search index', async () => {
    const t = (await driver().describe('sales.orders', 'table', 5000)) as TableDescription;
    expect(t).toMatchObject({ kind: 'table', name: 'sales.orders', comment: 'Orders', options: { partitionBy: 'placed', partitionGranularity: 'DAY', clusterBy: ['id'] }, primaryKey: { name: null, columns: ['id'] } });
    expect(t.columns.map((c) => [c.name, c.rawType, c.type, c.nullable, c.default])).toEqual([
      ['id', 'INTEGER', { type: 'INT64' }, false, null],
      ['note', 'STRING(10)', { type: 'STRING', length: 10 }, true, { kind: 'literal', value: 'none' }],
      ['amount', 'NUMERIC(12, 2)', { type: 'NUMERIC', precision: 12, scale: 2 }, true, null],
      ['placed', 'TIMESTAMP', { type: 'TIMESTAMP' }, true, { kind: 'expression', value: 'CURRENT_TIMESTAMP()' }],
      ['tags', 'ARRAY<STRING>', null, false, null]
    ]);
    expect(t.columns[1]!.comment).toBe('A note');
    expect(t.foreignKeys).toEqual([{ name: 'fk_cust', columns: ['id'], refTable: 'sales.customers', refColumns: ['cid'], onDelete: null, onUpdate: null }]);
    expect(t.indexes).toEqual([{ name: 'orders_search', columns: [{ name: 'note' }, { name: 'tags' }], unique: false, method: 'search', where: null, include: [], constraint: false }]);
  });

  it('a view, a missing table, routines read back and listed', async () => {
    expect(await driver().describe('sales.v_orders', 'view', 5000)).toMatchObject({ kind: 'view', definition: 'SELECT id FROM sales.orders' });
    expect(await driver().describe('sales.nope', 'table', 5000)).toBeNull();
    expect(await driver().describe('sales.add_tax', 'function', 5000)).toEqual({ kind: 'function', name: 'sales.add_tax', params: [{ name: 'amount', type: { type: 'NUMERIC' }, rawType: 'NUMERIC', mode: 'in' }], returns: { type: { type: 'NUMERIC' }, rawType: 'NUMERIC' }, language: 'sql', body: 'amount * 1.2', deterministic: true, comment: 'Tax' });
    expect(await driver().describe('sales.touch', 'procedure', 5000)).toMatchObject({ params: [{ name: 'n', mode: 'inout' }], body: 'BEGIN\nSET n = n + 1;\nEND', returns: null });
    expect(await driver().describe('sales.touch', 'function', 5000)).toBeNull();
    expect(await driver().routines(5000)).toEqual([{ name: 'sales.add_tax', kind: 'function' }, { name: 'sales.touch', kind: 'procedure' }]);
  });

  it('deletes a routine and a dataset; a missing one does not exist', async () => {
    calls.length = 0;
    expect(await driver().applyDdl(plan([{ op: 'bigquery.deleteRoutine', datasetId: 'sales', routineId: 'touch' }]), 5000)).toEqual({ applied: 1 });
    expect(await driver().applyDdl(plan([{ op: 'bigquery.deleteDataset', datasetId: 'staging', deleteContents: true }]), 5000)).toEqual({ applied: 1 });
    expect(calls).toEqual(['DELETE /bigquery/v2/projects/proj/datasets/sales/routines/touch', 'DELETE /bigquery/v2/projects/proj/datasets/staging?deleteContents=true']);
    await expect(driver().applyDdl(plan([{ op: 'bigquery.deleteRoutine', datasetId: 'sales', routineId: 'touch' }]), 5000)).rejects.toThrow(/^Operation 1 of 1 failed after 0 applied: Routine sales.touch does not exist/);
    await expect(driver().applyDdl(plan([{ op: 'bigquery.deleteDataset', datasetId: 'staging', deleteContents: false }]), 5000)).rejects.toThrow(/Dataset staging does not exist/);
  });
});

describe('OpenSearch describe and edit operations', () => {
  let fake: { url: string; server: Server };
  const seen: { method: string; path: string; body: unknown }[] = [];
  beforeAll(async () => {
    fake = await serve((req, raw, res) => {
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
      seen.push({ method: req.method ?? '', path, body: raw ? JSON.parse(raw) : null });
      const missing = () => send(res, 404, { error: { type: 'index_not_found_exception', reason: `no such index [${path.split('/')[1]}]` }, status: 404 });
      if (!path.startsWith('/tickets')) return missing();
      if (req.method === 'GET' && path === '/tickets/_mapping') return send(res, 200, { tickets: { mappings: { dynamic: 'strict', properties: { title: { type: 'text', analyzer: 'english' }, opened: { type: 'date', format: 'strict_date_optional_time' }, emb: { type: 'knn_vector', dimension: 4 }, price: { type: 'scaled_float', scaling_factor: 100 }, meta: { properties: { a: { type: 'keyword' } } } } } } });
      if (req.method === 'GET' && path === '/tickets/_settings') return send(res, 200, { tickets: { settings: { index: { number_of_shards: '2', number_of_replicas: '0', knn: 'true' } } } });
      if (req.method === 'PUT' || req.method === 'DELETE') return send(res, 200, { acknowledged: true });
      return missing();
    });
  });
  afterAll(() => stop(fake.server));
  const driver = () => new OpenSearchDriver({ engine: 'opensearch', endpoint: fake.url, database: null, tls: false, username: 'admin', password: 'pw' }, allow);

  it('describes an index as the create form takes it, and a missing one as null', async () => {
    expect(await driver().describe('tickets', 'search-index', 5000)).toEqual({
      kind: 'search-index',
      name: 'tickets',
      definition: { name: 'tickets', shards: 2, replicas: 0, dynamic: 'strict', fields: [{ name: 'title', type: 'text', analyzer: 'english' }, { name: 'opened', type: 'date', format: 'strict_date_optional_time' }, { name: 'emb', type: 'knn_vector', dimension: 4 }, { name: 'price', type: 'scaled_float', scalingFactor: 100 }, { name: 'meta', type: 'object' }] }
    });
    expect(await driver().describe('nope', 'search-index', 5000)).toBeNull();
    await expect(driver().describe('tickets', 'table', 5000)).rejects.toThrow(/search indexes/);
  });

  it('puts mappings and settings and deletes an index; a missing index does not exist', async () => {
    seen.length = 0;
    const plan = (ops: DdlPlan['ops']): DdlPlan => ({ engine: 'opensearch', kind: 'edit', object: 'tickets', statements: [], ops, transactional: false, touches: [], notes: [], destructive: false, confirmName: null, hash: 'h' }) as DdlPlan;
    expect(await driver().applyDdl(plan([{ op: 'opensearch.putMapping', index: 'tickets', body: { properties: { tag: { type: 'keyword' } } } }, { op: 'opensearch.putSettings', index: 'tickets', body: { index: { number_of_replicas: 1 } } }, { op: 'opensearch.deleteIndex', index: 'tickets' }]), 5000)).toEqual({ applied: 3 });
    expect(seen).toEqual([
      { method: 'PUT', path: '/tickets/_mapping', body: { properties: { tag: { type: 'keyword' } } } },
      { method: 'PUT', path: '/tickets/_settings', body: { index: { number_of_replicas: 1 } } },
      { method: 'DELETE', path: '/tickets', body: null }
    ]);
    await expect(driver().applyDdl(plan([{ op: 'opensearch.deleteIndex', index: 'gone' }]), 5000)).rejects.toThrow(/^Operation 1 of 1 failed after 0 applied: gone does not exist/);
    await expect(driver().applyDdl(plan([{ op: 'mongo.dropCollection', name: 'x' }]), 5000)).rejects.toThrow(/OpenSearch does not perform mongo.dropCollection/);
  });
});
