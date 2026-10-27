/*
 * 1.9.99-final, Sprint 61 (B-10907): Cloudflare D1 as a read-only data connection. The SQLite classifier (its
 * quoting, its writes and its own statements refused, file and schema functions denied), the driver against the D1
 * query API in `fake-d1.ts` (served by `fake-cloudflare.ts`, which checks the token), and the service: an INSERT,
 * UPDATE or schema change through a D1 connection is refused before any request reaches Cloudflare, reads are
 * allow-listed, capped and masked, the schema is listed, and D1 is never Exprsn-AI's own database. Nothing reaches
 * Cloudflare: the offline guard refuses its real API.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { classifySqlite } from '../src/connections/classify-sqlite.js';
import { D1Driver } from '../src/connections/d1.js';
import { canonical } from '../src/connections/dialects.js';
import type { ConnectionSpec } from '../src/connections/drivers.js';
import { engineInfo } from '../src/connections/engines.js';
import { renderSql, sqlPieces } from '../src/connections/saved-queries.js';
import { parseAllowList } from '../src/mcp/hosts.js';
import { FakeCloudflare } from './fake-cloudflare.js';
import { localUser, loginAdmin, testConfig, type Harness } from './helpers.js';
import { harnessWith } from './retrieval-seed.js';

const SETUP = `
  CREATE TABLE orders (id INTEGER PRIMARY KEY, customer TEXT, email TEXT, total REAL, placed TEXT);
  CREATE TABLE payroll (id INTEGER PRIMARY KEY, salary REAL);
  CREATE VIEW big_orders AS SELECT id, total FROM orders WHERE total > 100;
  INSERT INTO orders (customer, email, total, placed) VALUES ('Ana', 'ana@example.org', 42, '2026-10-01'), ('Ben', 'ben@example.org', 250, '2026-10-02'), ('Cy', 'cy@example.org', 7, '2026-10-03');
  INSERT INTO payroll (salary) VALUES (1);
`;

describe('SQLite classifier (D1)', () => {
  const read = (sql: string) => classifySqlite(sql);

  it('reads selects with SQLite quoting, comments and bound values', () => {
    expect(read("SELECT id, 'it''s' AS s FROM orders WHERE customer = ?1 -- DELETE FROM orders\n")).toMatchObject({ kind: 'read', objects: ['orders'] });
    expect(read('SELECT [total], `email` FROM "orders" o JOIN payroll p ON p.id = o.id /* ; DROP */')).toMatchObject({ kind: 'read', objects: ['orders', 'payroll'] });
    expect(read('WITH t AS (SELECT * FROM orders) SELECT replace(customer, \'a\', \'b\') FROM t WHERE total > :min')).toMatchObject({ kind: 'read', objects: ['orders'] });
    expect(read('SELECT * FROM main.orders')).toMatchObject({ kind: 'read', objects: ['main.orders'] });
  });

  it('refuses writes, SQLite statements and several statements', () => {
    for (const [sql, kind] of [
      ["INSERT INTO orders (customer) VALUES ('x')", 'write'],
      ["INSERT OR REPLACE INTO orders (id) VALUES (1)", 'write'],
      ["REPLACE INTO orders (id) VALUES (1)", 'write'],
      ['UPDATE orders SET total = 0', 'write'],
      ['DELETE FROM orders', 'write'],
      ['WITH x AS (SELECT 1) INSERT INTO orders (id) SELECT * FROM x', 'write'],
      ["INSERT INTO orders (id) VALUES (1) ON CONFLICT(id) DO UPDATE SET total = 1", 'write'],
      ['CREATE TABLE x (a)', 'ddl'],
      ['DROP TABLE orders', 'ddl'],
      ['ALTER TABLE orders ADD COLUMN x', 'ddl'],
      ["ATTACH DATABASE 'other.db' AS o", 'ddl'],
      ['DETACH o', 'ddl'],
      ['PRAGMA writable_schema = 1', 'ddl'],
      ['PRAGMA table_info(orders)', 'ddl'],
      ["VACUUM INTO '/tmp/copy.db'", 'ddl'],
      ['REINDEX', 'ddl'],
      ['BEGIN', 'ddl'],
      ['SAVEPOINT a', 'ddl'],
      ['SELECT 1 FROM orders; DELETE FROM orders', 'multiple']
    ] as const) {
      expect(read(sql).kind, sql).toBe(kind);
    }
  });

  it('denies file, extension and schema functions; the schema tables are objects like any other', () => {
    expect(read("SELECT load_extension('x')")).toMatchObject({ kind: 'denied', denied: 'load_extension()' });
    expect(read("SELECT readfile('/etc/passwd')")).toMatchObject({ kind: 'denied', denied: 'readfile()' });
    expect(read("SELECT * FROM pragma_table_info('payroll')")).toMatchObject({ kind: 'denied', denied: 'pragma_table_info()' });
    expect(read('SELECT sqlite_version()')).toMatchObject({ kind: 'denied' });
    expect(read('EXPLAIN DELETE FROM orders').kind).toBe('denied');
    expect(read('SELECT name FROM sqlite_schema')).toMatchObject({ kind: 'read', objects: ['sqlite_schema'] });
    expect(read("SELECT 'x")).toMatchObject({ kind: 'unparsed' });
  });

  it('names tables in main, binds :name as ? and quotes with double quotes', () => {
    const c = { engine: 'cloudflare-d1' as const, database: 'db', account: null, options: {} };
    expect(canonical('orders', c)).toBe('main.orders');
    expect(canonical('main.Orders', c)).toBe('main.orders');
    const r = renderSql(sqlPieces('SELECT * FROM orders WHERE customer = :who AND note <> \':who\'', 'sqlite', new Set(['who'])).pieces, 'sqlite', [{ name: 'who', type: 'string', required: true }] as never, { who: 'Ana' });
    expect(r).toEqual({ text: "SELECT * FROM orders WHERE customer = ? AND note <> ':who'", params: ['Ana'] });
  });

  it('is a SQL engine with TLS, a database id and an account id, never a database client', () => {
    expect(engineInfo('cloudflare-d1')).toMatchObject({ family: 'sql', dialect: 'sqlite', transport: 'https', tlsRequired: true, database: { label: 'Database id', required: true }, credential: { usernameLabel: 'Cloudflare account id' } });
    // Never Exprsn-AI's own database: DB_CLIENT is pg, mysql or sqlite.
    expect(() => testConfig({ DB_CLIENT: 'd1' })).toThrow();
    expect(() => testConfig({ DB_CLIENT: 'cloudflare-d1' })).toThrow();
  });
});

describe('D1 driver (query API)', () => {
  const cf = new FakeCloudflare();
  let dbId = '';
  let token = '';
  const spec = (o: Partial<ConnectionSpec> = {}): ConnectionSpec => ({ engine: 'cloudflare-d1', endpoint: cf.url, database: dbId, tls: true, username: cf.accountId, password: token, options: {}, ...o });

  beforeAll(async () => {
    await cf.start();
    dbId = cf.d1.addDatabase(SETUP);
    token = cf.addToken(['D1 Read']).value;
  });
  afterAll(async () => {
    cf.d1.close();
    await cf.stop();
  });

  it('tests, lists tables and views with their columns, and reads capped rows with bound values', async () => {
    const d = new D1Driver(spec());
    expect(await d.test(2000)).toMatchObject({ version: expect.stringMatching(/^Cloudflare D1 \(SQLite 3\./), readOnly: true });
    const schema = await d.introspect(2000);
    expect(schema.map((o) => [o.name, o.kind])).toEqual([['big_orders', 'view'], ['orders', 'table'], ['payroll', 'table']]);
    expect(schema.find((o) => o.name === 'orders')!.columns.map((c) => c.name)).toEqual(['id', 'customer', 'email', 'total', 'placed']);
    const cl = classifySqlite('SELECT customer, total FROM orders WHERE total > ? ORDER BY id');
    const r = await d.query(cl, 'SELECT customer, total FROM orders WHERE total > ? ORDER BY id;', { limit: 1, timeoutMs: 2000, params: [5] });
    expect(r).toMatchObject({ columns: ['customer', 'total'], rows: [['Ana', 42]], capped: true });
    const last = cf.d1.statements.at(-1)!;
    expect(last.sql).toBe('SELECT * FROM (SELECT customer, total FROM orders WHERE total > ? ORDER BY id) LIMIT 2 OFFSET 0');
    expect(last.params).toEqual([5]);
    const after = await d.rows('orders', { watermarkColumn: 'placed', after: '2026-10-01', limit: 10, timeoutMs: 2000, fields: ['customer', 'placed'] });
    expect(after.rows).toEqual([['Ben', '2026-10-02'], ['Cy', '2026-10-03']]);
    expect(cf.calls(/d1\/database/).at(-1)!.headers.authorization).toBe(`Bearer ${token}`);
  });

  it('never sends a write it is handed, and reports D1\'s errors without the token', async () => {
    const d = new D1Driver(spec());
    const before = cf.d1.statements.length;
    await expect(d.query(classifySqlite("INSERT INTO orders (customer) VALUES ('x')"), "INSERT INTO orders (customer) VALUES ('x')", { limit: 10, timeoutMs: 2000 })).rejects.toThrow(/never sent/);
    expect(cf.d1.statements.length).toBe(before);
    const err = await new D1Driver(spec({ password: 'wrong-token' })).test(2000).catch((e: unknown) => e as Error);
    expect(String(err)).toMatch(/D1 answered 400/);
    expect(String(err)).not.toContain(token);
  });

  it('refuses plain http to a host name and the real API in tests', async () => {
    await expect(new D1Driver(spec({ endpoint: 'http://d1.example.test' })).test(1000)).rejects.toThrow(/https:\/\/ only/);
    await expect(new D1Driver(spec({ endpoint: 'https://api.cloudflare.com' }), parseAllowList('api.cloudflare.com')).test(1000)).rejects.toThrow(/real cloud host blocked in tests/);
  });
});

describe('D1 connections through the service', () => {
  let h: Harness;
  let cf: FakeCloudflare;
  let dbId = '';
  beforeEach(async () => {
    cf = await new FakeCloudflare().start();
    dbId = cf.d1.addDatabase(SETUP);
    h = await harnessWith({}, { OLLAMA_POLL_MS: '600000' });
  });
  afterEach(async () => {
    await h.close();
    cf.d1.close();
    await cf.stop();
  });

  async function admin() {
    await localUser(h, 'd1admin', ['connection-admin', 'member'], 'confidential');
    const c = await loginAdmin(h, 'd1admin');
    const send = (m: 'post' | 'put', p: string, b: object = {}) => c.agent[m](p).set('x-csrf-token', c.csrf).send(b);
    return { post: (p: string, b?: object) => send('post', p, b), put: (p: string, b?: object) => send('put', p, b), get: (p: string) => c.agent.get(p) };
  }

  it('refuses INSERT, UPDATE and DDL before any request reaches Cloudflare; reads are allow-listed, capped and masked', async () => {
    const a = await admin();
    const token = cf.addToken(['D1 Read']).value;
    const conn = (await a.post('/api/admin/connections', { name: 'edge-db', engine: 'cloudflare-d1', endpoint: cf.url, database: dbId, zone: 'data', label: 'internal', username: cf.accountId, password: token }).expect(201)).body;
    expect(conn).toMatchObject({ engine: 'cloudflare-d1', family: 'sql', tls: true });
    expect((await a.post(`/api/admin/connections/${conn.id}/test`).expect(200)).body).toMatchObject({ ok: true, readOnly: true, health: 'healthy' });
    // Schema listing.
    expect((await a.post(`/api/admin/connections/${conn.id}/schema`).expect(200)).body).toMatchObject({ objects: 3 });
    await a.put(`/api/admin/connections/${conn.id}/allow-list`, { objects: ['orders', 'big_orders'], piiColumns: [] }).expect(200);
    const before = cf.d1.statements.length;
    const requests = cf.calls(/d1\/database/).length;

    const ins = await a.post(`/api/admin/connections/${conn.id}/query`, { query: "INSERT INTO orders (customer, email, total) VALUES ('Eve', 'eve@example.org', 1)" }).expect(422);
    expect(ins.body).toMatchObject({ title: 'Write refused', kind: 'write', verb: 'INSERT' });
    expect((await a.post(`/api/admin/connections/${conn.id}/query`, { query: 'UPDATE orders SET total = 0' }).expect(422)).body).toMatchObject({ kind: 'write', verb: 'UPDATE' });
    for (const q of ['DROP TABLE orders', 'CREATE TABLE x (a)', 'PRAGMA writable_schema = 1', "ATTACH DATABASE 'x' AS y", "REPLACE INTO orders (id) VALUES (1)"]) expect((await a.post(`/api/admin/connections/${conn.id}/query`, { query: q }).expect(422)).body.kind, q).toMatch(/ddl|write/);
    expect((await a.post(`/api/admin/connections/${conn.id}/query`, { query: 'SELECT * FROM payroll' }).expect(422)).body.title).toBe('Object outside the allow-list');
    expect((await a.post(`/api/admin/connections/${conn.id}/query`, { query: 'SELECT name FROM sqlite_schema' }).expect(422)).body.title).toBe('Object outside the allow-list');
    // Nothing reached the D1 API.
    expect(cf.d1.statements.length).toBe(before);
    expect(cf.calls(/d1\/database/).length).toBe(requests);
    expect(await h.s.db('orders' as never).count().catch(() => null)).toBeNull(); // (the app's own database has no such table)
    expect(cf.d1.databases.get(dbId)!.prepare('SELECT count(*) AS n FROM orders').get()).toEqual({ n: 3 });
    expect((await h.s.audit.list(h.tenantId, { action: 'connection.query.refused' })).length).toBe(9);

    const res = await a.post(`/api/admin/connections/${conn.id}/query`, { query: 'SELECT customer, email, total FROM orders ORDER BY id' });
    expect(res.status, res.text).toBe(200);
    expect(res.body.columns).toEqual(['customer', 'email', 'total']);
    expect(res.body.masked).toEqual(['email']);
    expect(res.body.rows[0][1]).toBe('••••.org');
    expect(res.body.rows[0][2]).toBe(42);
    expect((await a.post(`/api/admin/connections/${conn.id}/query`, { query: 'SELECT * FROM main.big_orders' }).expect(200)).body.rows).toEqual([[2, 250]]);
  });
});
