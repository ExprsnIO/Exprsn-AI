/*
 * 1.9.0: Snowflake connections. The classifier (Snowflake's lexing, its refusals, casts and semi-structured paths),
 * `:name` placeholders in the snowflake dialect, and the SQL API driver against an in-process fake that checks the
 * key-pair JWT (signature, issuer fingerprint, subject), answers at once, after a 202 and polling, across partitions
 * and with an error, and records the bindings and session settings it was sent.
 */
import { createHash, createPublicKey, generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifySnowflake } from '../src/connections/classify-snowflake.js';
import { renderSql, sqlPieces } from '../src/connections/saved-queries.js';
import { publicKeyFingerprint, snowflakeAccount, snowflakeBindings, SnowflakeDriver } from '../src/connections/snowflake.js';
import { parseAllowList } from '../src/mcp/hosts.js';

describe('Snowflake classifier', () => {
  const read = (sql: string) => classifySnowflake(sql);

  it('reads selects with Snowflake strings, comments, casts and semi-structured paths', () => {
    expect(read("SELECT id, name FROM sales.orders WHERE note = 'it\\'s' -- :x\n")).toMatchObject({ kind: 'read', objects: ['sales.orders'] });
    expect(read('SELECT $$ DELETE FROM t; $$ AS s FROM orders // trailing comment')).toMatchObject({ kind: 'read', objects: ['orders'] });
    expect(read('SELECT v:customer.name::varchar AS n, v:"Total"::number(12, 2), v[\'x\'] FROM ANALYTICS.RAW.EVENTS')).toMatchObject({ kind: 'read', objects: ['analytics.raw.events'] });
    expect(read('SELECT a::variant, b::timestamp_ntz, c::object, d::array, e::float, f::date FROM "Mixed"."Case"')).toMatchObject({ kind: 'read', objects: ['mixed.case'] });
    expect(read('SELECT o.id, f.value FROM orders o, LATERAL FLATTEN(input => o.items) f QUALIFY ROW_NUMBER() OVER (PARTITION BY o.id ORDER BY f.index) = 1')).toMatchObject({ kind: 'read', objects: ['orders'] });
    expect(read('SELECT f.value FROM orders o, TABLE(FLATTEN(o.items)) f')).toMatchObject({ kind: 'read', objects: ['orders'] });
    expect(read('WITH x AS (SELECT * FROM a) SELECT TOP 10 * FROM x JOIN b ON x.id = b.id')).toMatchObject({ kind: 'read', objects: ['a', 'b'] });
  });

  it('refuses writes, DDL, session verbs, listings and several statements', () => {
    for (const [sql, kind] of [
      ['INSERT INTO t VALUES (1)', 'write'],
      ['INSERT OVERWRITE INTO t SELECT * FROM s', 'write'],
      ['UPDATE t SET a = 1', 'write'],
      ['MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE', 'write'],
      ['COPY INTO t FROM @stage', 'write'],
      ['PUT file:///tmp/x @~', 'write'],
      ['GET @~/x file:///tmp', 'write'],
      ['REMOVE @~/x', 'write'],
      ['CALL refresh()', 'write'],
      ['EXECUTE IMMEDIATE $$ SELECT 1 $$', 'write'],
      ['EXECUTE TASK nightly', 'write'],
      ['CREATE TABLE x AS SELECT * FROM t', 'ddl'],
      ['DROP TABLE t', 'ddl'],
      ['ALTER SESSION SET QUERY_TAG = \'x\'', 'ddl'],
      ['USE ROLE ACCOUNTADMIN', 'ddl'],
      ['SET x = 1', 'ddl'],
      ['UNDROP TABLE t', 'ddl'],
      ['GRANT SELECT ON t TO ROLE r', 'ddl'],
      ['BEGIN', 'ddl'],
      ['SHOW TABLES', 'denied'],
      ['DESCRIBE TABLE t', 'denied'],
      ['LIST @stage', 'denied'],
      ['SELECT 1 FROM a; SELECT 2 FROM b', 'multiple'],
      ['WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x', 'write']
    ] as const) {
      expect(read(sql).kind, sql).toBe(kind);
    }
  });

  it('denies SYSTEM$ functions, RESULT_SCAN, IDENTIFIER() and stages; table functions need confirming', () => {
    expect(read("SELECT SYSTEM$WAIT(10) FROM t")).toMatchObject({ kind: 'denied', denied: 'system$wait()' });
    expect(read("SELECT system$allowlist()")).toMatchObject({ kind: 'denied' });
    expect(read("SELECT * FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()))")).toMatchObject({ kind: 'denied', denied: 'result_scan()' });
    expect(read("SELECT * FROM IDENTIFIER('secret.table')")).toMatchObject({ kind: 'denied', denied: 'identifier()' });
    expect(read('SELECT $1 FROM @my_stage/data.csv')).toMatchObject({ kind: 'denied', denied: '@stage' });
    expect(read('SELECT * FROM TABLE(GENERATOR(ROWCOUNT => 10))')).toMatchObject({ kind: 'unparsed' });
    expect(read('SELECT * FROM orders o, LATERAL FLATTEN(input => (SELECT items FROM secret))')).toMatchObject({ kind: 'unparsed' });
    expect(read("SELECT 'x")).toMatchObject({ kind: 'unparsed' });
    expect(read('SELECT $$ x')).toMatchObject({ kind: 'unparsed' });
  });

  it('binds :name placeholders as ? per use, never inside $$ text or // comments', () => {
    const defs = [
      { name: 'tier', type: 'string' as const, required: true },
      { name: 'ids', type: 'list' as const, required: false, itemType: 'number' as const }
    ];
    const sql = "SELECT * FROM orders WHERE tier = :tier AND note <> $$ :tier $$ AND id IN (:ids) AND v:path = :tier // :nothing\n AND x::number = 1";
    const p = sqlPieces(sql, 'snowflake', new Set(['tier', 'ids']));
    expect([...p.used].sort()).toEqual(['ids', 'tier']);
    const r = renderSql(p.pieces, 'snowflake', defs, { tier: 'gold', ids: [1, 2] });
    expect(r.text).toBe("SELECT * FROM orders WHERE tier = ? AND note <> $$ :tier $$ AND id IN (?, ?) AND v:path = ? // :nothing\n AND x::number = 1");
    expect(r.params).toEqual(['gold', 1, 2, 'gold']);
    expect(classifySnowflake(r.text)).toMatchObject({ kind: 'read', objects: ['orders'] });
  });
});

/** The SQL API, as much of it as the driver uses. */
class FakeSnowflake {
  server!: Server;
  url = '';
  readonly key: KeyObject;
  readonly pem: string;
  bodies: Record<string, unknown>[] = [];
  cancelled: string[] = [];
  polls = 0;
  readonly user = 'SVC_REPORTS';
  /** Grants of the base role: SELECT only, unless a test adds a write. */
  baseGrants: string[][] = [['SELECT', 'TABLE', 'ANALYTICS.SALES.ORDERS']];

  constructor() {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.key = privateKey;
    this.pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  }

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

  /** Checks the key-pair JWT as Snowflake does: signature, issuer with the key's fingerprint, subject, lifetime. */
  private authorized(req: IncomingMessage): string | null {
    if (req.headers['x-snowflake-authorization-token-type'] === 'PROGRAMMATIC_ACCESS_TOKEN') return req.headers.authorization === 'Bearer pat-123' ? null : 'bad token';
    if (req.headers['x-snowflake-authorization-token-type'] !== 'KEYPAIR_JWT') return 'token type';
    const jwt = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const [h, b, s] = jwt.split('.');
    if (!h || !b || !s) return 'not a JWT';
    if (!verify('sha256', Buffer.from(`${h}.${b}`), createPublicKey(this.key), Buffer.from(s, 'base64url'))) return 'signature';
    const claims = JSON.parse(Buffer.from(b, 'base64url').toString()) as { iss: string; sub: string; iat: number; exp: number };
    const fp = `SHA256:${createHash('sha256').update(createPublicKey(this.key).export({ type: 'spki', format: 'der' })).digest('base64')}`;
    if (claims.sub !== `ORGNAME-ACCT.${this.user}` && claims.sub !== `127.${this.user}`) return `sub ${claims.sub}`;
    if (claims.iss !== `${claims.sub}.${fp}`) return 'iss';
    if (claims.exp - claims.iat > 3600) return 'lifetime';
    return null;
  }

  private result(rowType: { name: string; type: string; scale?: number }[], data: (string | null)[][], extra: Record<string, unknown> = {}) {
    return { code: '090001', message: 'Statement executed successfully.', statementHandle: 'h-1', resultSetMetaData: { numRows: data.length, rowType, partitionInfo: [{ rowCount: data.length }] }, data, ...extra };
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    let raw = '';
    for await (const c of req) raw += String(c);
    const problem = this.authorized(req);
    if (problem) return this.send(res, 401, { code: '390144', message: `JWT token is invalid (${problem}).` });
    const u = new URL(req.url ?? '/', this.url);
    const handle = /^\/api\/v2\/statements\/([^/]+)(\/cancel)?$/.exec(u.pathname);
    if (handle && handle[2]) {
      this.cancelled.push(handle[1]!);
      return this.send(res, 200, { code: '000604', message: 'cancelled' });
    }
    if (handle) {
      if (handle[1] === 'slow') {
        this.polls++;
        return this.polls < 2 ? this.send(res, 202, { code: '333334', statementHandle: 'slow' }) : this.send(res, 200, this.result([{ name: 'N', type: 'fixed', scale: 0 }], [['42']]));
      }
      if (handle[1] === 'never') return this.send(res, 202, { code: '333334', statementHandle: 'never' });
      if (handle[1] === 'big') {
        const p = Number(u.searchParams.get('partition'));
        return this.send(res, 200, { data: [[String(p * 2 + 1)], [String(p * 2 + 2)]] });
      }
      return this.send(res, 404, { message: 'no such statement' });
    }
    if (req.method !== 'POST' || u.pathname !== '/api/v2/statements') return this.send(res, 404, { message: 'not found' });
    const body = JSON.parse(raw) as { statement: string; bindings?: Record<string, { type: string; value: string | null }> };
    this.bodies.push(body);
    const st = body.statement;
    if (st.startsWith('SELECT CURRENT_VERSION()')) return this.send(res, 200, this.result(['VERSION', 'USER_NAME', 'ROLE_NAME', 'WAREHOUSE', 'DATABASE_NAME'].map((name) => ({ name, type: 'text' })), [['9.31.2', this.user, 'REPORTER', 'REPORTING_WH', 'ANALYTICS']]));
    if (st.startsWith('SHOW GRANTS TO ROLE')) {
      const role = st.replace('SHOW GRANTS TO ROLE ', '');
      const cols = ['created_on', 'privilege', 'granted_on', 'name', 'granted_to', 'grantee_name'].map((name) => ({ name, type: 'text' }));
      const rows = role === 'REPORTER' ? [['t', 'USAGE', 'WAREHOUSE', 'REPORTING_WH', 'ROLE', 'REPORTER'], ['t', 'USAGE', 'ROLE', 'BASE_READER', 'ROLE', 'REPORTER']] : this.baseGrants.map(([p, on, n]) => ['t', p!, on!, n!, 'ROLE', role]);
      return this.send(res, 200, this.result(cols, rows));
    }
    if (st.includes('INFORMATION_SCHEMA.TABLES')) return this.send(res, 200, this.result(['TABLE_SCHEMA', 'TABLE_NAME', 'TABLE_TYPE'].map((name) => ({ name, type: 'text' })), [['SALES', 'ORDERS', 'BASE TABLE'], ['SALES', 'ORDER_TOTALS', 'VIEW']]));
    if (st.includes('INFORMATION_SCHEMA.COLUMNS')) return this.send(res, 200, this.result(['TABLE_SCHEMA', 'TABLE_NAME', 'COLUMN_NAME', 'DATA_TYPE'].map((name) => ({ name, type: 'text' })), [['SALES', 'ORDERS', 'ID', 'NUMBER'], ['SALES', 'ORDERS', 'EMAIL', 'TEXT'], ['SALES', 'ORDER_TOTALS', 'TOTAL', 'NUMBER']]));
    if (st.includes('boom')) return this.send(res, 422, { code: '002003', sqlState: '02000', message: "SQL compilation error: Object 'BOOM' does not exist or not authorized.", statementHandle: 'e-1' });
    if (st.includes('slow')) return this.send(res, 202, { code: '333334', message: 'Asynchronous execution in progress.', statementHandle: 'slow' });
    if (st.includes('never')) return this.send(res, 202, { code: '333334', statementHandle: 'never' });
    if (st.includes('big')) return this.send(res, 200, { ...this.result([{ name: 'N', type: 'fixed', scale: 0 }], [['-1'], ['0']]), statementHandle: 'big', resultSetMetaData: { numRows: 8, rowType: [{ name: 'N', type: 'fixed', scale: 0 }], partitionInfo: [{ rowCount: 2 }, { rowCount: 2 }, { rowCount: 2 }, { rowCount: 2 }] } });
    // Anything else: three orders with every converted type.
    return this.send(res, 200, this.result([{ name: 'ID', type: 'fixed', scale: 0 }, { name: 'AMOUNT', type: 'fixed', scale: 2 }, { name: 'RATE', type: 'real' }, { name: 'PAID', type: 'boolean' }, { name: 'NOTE', type: 'text' }, { name: 'BIG', type: 'fixed', scale: 0 }], [['1', '10.50', '0.25', 'true', 'first', '12345678901234567890'], ['2', '3.00', '1.5', 'false', null, '7'], ['3', '0.10', '2', 'true', 'third', '8']]));
  }
}

describe('Snowflake driver (SQL API)', () => {
  let fake: FakeSnowflake;
  const allow = parseAllowList('');
  const spec = (over: Partial<{ password: string; username: string; options: Record<string, unknown>; endpoint: string }> = {}) => ({ engine: 'snowflake' as const, endpoint: fake.url, database: 'ANALYTICS', tls: true, username: fake.user, password: fake.pem, options: { auth: 'key-pair', warehouse: 'REPORTING_WH', role: 'REPORTER', schema: 'SALES' }, ...over });
  const driver = (over: Parameters<typeof spec>[0] = {}) => new SnowflakeDriver(spec(over), allow, { allowHttp: true, pollMs: 20 });

  beforeAll(async () => {
    fake = await new FakeSnowflake().start();
  });
  afterAll(async () => {
    await fake.stop();
  });

  it('names the account from its host and the key by its fingerprint', () => {
    expect(snowflakeAccount('orgname-acct.snowflakecomputing.com')).toBe('ORGNAME-ACCT');
    expect(snowflakeAccount('xy12345.eu-west-1.snowflakecomputing.com')).toBe('XY12345');
    expect(snowflakeAccount('orgname-acct.privatelink.snowflakecomputing.com')).toBe('ORGNAME-ACCT');
    expect(publicKeyFingerprint(fake.key)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}=$/);
    expect(snowflakeBindings(['a', 1, 1.5, true, null, 10n])).toEqual({ '1': { type: 'TEXT', value: 'a' }, '2': { type: 'FIXED', value: '1' }, '3': { type: 'REAL', value: '1.5' }, '4': { type: 'BOOLEAN', value: 'true' }, '5': { type: 'TEXT', value: null }, '6': { type: 'FIXED', value: '10' } });
  });

  it('refuses http:// without the test switch, and a key that is not a PEM key', async () => {
    await expect(new SnowflakeDriver(spec(), allow).test(2000)).rejects.toThrow(/https:\/\/ only/);
    await expect(driver({ password: 'not a key' }).test(2000)).rejects.toThrow(/not an unencrypted PEM key/);
  });

  it('tests with a signed JWT: version, user, role, warehouse, and the role\'s grants followed down', async () => {
    const t = await driver().test(5000);
    expect(t).toMatchObject({ version: 'Snowflake 9.31.2', readOnly: true, health: 'healthy' });
    expect(t.detail).toMatch(/SVC_REPORTS with role REPORTER on warehouse REPORTING_WH, database ANALYTICS holds no write privileges/);
    expect(t.detail).toMatch(/no read-only transaction/);
    expect(fake.bodies.some((b) => b.statement === 'SHOW GRANTS TO ROLE BASE_READER')).toBe(true);
    fake.baseGrants = [['SELECT', 'TABLE', 'ANALYTICS.SALES.ORDERS'], ['INSERT', 'TABLE', 'ANALYTICS.SALES.ORDERS']];
    const w = await driver().test(5000);
    expect(w.readOnly).toBe(false);
    expect(w.detail).toMatch(/holds 1 write privilege \(INSERT on table ANALYTICS.SALES.ORDERS\)/);
    fake.baseGrants = [['SELECT', 'TABLE', 'ANALYTICS.SALES.ORDERS']];
  });

  it('runs a read with the session settings and positional bindings, converting the typed values', async () => {
    fake.bodies = [];
    const r = await driver().query(classifySnowflake('SELECT * FROM orders WHERE tier = ?'), 'SELECT * FROM orders WHERE tier = ? AND n > ?;', { limit: 2, timeoutMs: 5000, params: ['gold', 3], offset: 4 });
    expect(r.columns).toEqual(['ID', 'AMOUNT', 'RATE', 'PAID', 'NOTE', 'BIG']);
    expect(r.rows).toEqual([
      [1, '10.50', 0.25, true, 'first', '12345678901234567890'],
      [2, '3.00', 1.5, false, null, 7]
    ]);
    expect(r.capped).toBe(true);
    const sent = fake.bodies[0] as { statement: string; bindings: unknown; database: string; schema: string; warehouse: string; role: string; parameters: Record<string, string>; timeout: number };
    expect(sent.statement).toBe('SELECT * FROM (SELECT * FROM orders WHERE tier = ? AND n > ?\n) AS exprsn_q LIMIT 3 OFFSET 4');
    expect(sent.bindings).toEqual({ '1': { type: 'TEXT', value: 'gold' }, '2': { type: 'FIXED', value: '3' } });
    expect(sent).toMatchObject({ database: 'ANALYTICS', schema: 'SALES', warehouse: 'REPORTING_WH', role: 'REPORTER', timeout: 5, parameters: { MULTI_STATEMENT_COUNT: '1', QUERY_TAG: 'exprsn-ai' } });
  });

  it('polls a statement still running, reads further partitions, and cancels one past the timeout', async () => {
    const slow = await driver().query(classifySnowflake('SELECT 1 FROM slow'), 'SELECT 1 FROM slow', { limit: 10, timeoutMs: 5000 });
    expect(slow.rows).toEqual([[42]]);
    expect(fake.polls).toBe(2);
    const big = await driver().query(classifySnowflake('SELECT n FROM big'), 'SELECT n FROM big', { limit: 5, timeoutMs: 5000 });
    expect(big.rows.map((r) => r[0])).toEqual([-1, 0, 3, 4, 5]);
    expect(big.capped).toBe(true);
    await expect(driver().query(classifySnowflake('SELECT 1 FROM never'), 'SELECT 1 FROM never', { limit: 10, timeoutMs: 1200 })).rejects.toThrow(/did not finish within 2 s; it was cancelled/);
    expect(fake.cancelled).toContain('never');
  });

  it('reports Snowflake\'s error message, never the token', async () => {
    const err = await driver().query(classifySnowflake('SELECT * FROM boom'), 'SELECT * FROM boom', { limit: 10, timeoutMs: 5000 }).catch((e: Error) => e);
    expect(String(err)).toMatch(/Snowflake 422: 002003: SQL compilation error: Object 'BOOM' does not exist/);
    expect(String(err)).not.toMatch(/eyJ/);
    const bad = await driver({ username: 'SOMEONE_ELSE' }).test(2000).catch((e: Error) => e);
    expect(String(bad)).toMatch(/Snowflake 401: 390144: JWT token is invalid \(sub/);
  });

  it('accepts a programmatic access token', async () => {
    const t = await driver({ password: 'pat-123', options: { auth: 'pat', role: 'REPORTER' } }).test(5000);
    expect(t.version).toBe('Snowflake 9.31.2');
    await expect(driver({ password: 'wrong', options: { auth: 'pat' } }).test(2000)).rejects.toThrow(/401/);
  });

  it('lists tables and views as SCHEMA.TABLE and reads rows by watermark with quoted names', async () => {
    const schema = await driver().introspect(5000);
    expect(schema).toEqual([
      { name: 'SALES.ORDERS', kind: 'table', columns: [{ name: 'ID', type: 'number' }, { name: 'EMAIL', type: 'text' }] },
      { name: 'SALES.ORDER_TOTALS', kind: 'view', columns: [{ name: 'TOTAL', type: 'number' }] }
    ]);
    expect(String(fake.bodies.find((b) => String(b.statement).includes('INFORMATION_SCHEMA.TABLES'))?.statement)).toContain('FROM ANALYTICS.INFORMATION_SCHEMA.TABLES');
    fake.bodies = [];
    const r = await driver().rows('SALES.ORDERS', { watermarkColumn: 'UPDATED_AT', after: '2026-01-01', limit: 2, timeoutMs: 5000 });
    expect(r.rows).toHaveLength(2);
    expect(r.capped).toBe(true);
    expect(fake.bodies[0]).toMatchObject({ statement: 'SELECT * FROM "SALES"."ORDERS" WHERE "UPDATED_AT" > ? ORDER BY "UPDATED_AT" LIMIT 3', bindings: { '1': { type: 'TEXT', value: '2026-01-01' } } });
  });

  it('refuses a public address that is not on the allow-list', async () => {
    await expect(new SnowflakeDriver(spec({ endpoint: 'https://8.8.8.8' }), allow).test(2000)).rejects.toThrow(/public address/);
  });
});
