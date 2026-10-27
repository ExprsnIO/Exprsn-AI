/*
 * 1.9.0: the Oracle driver on a real database (TEST_ORACLE_URL, such as oracle://app:app@127.0.0.1:1521/FREEPDB1 for
 * the gvenzl/oracle-free image with APP_USER=app). The account owns the test table, so Test connection reports it as
 * able to write; a DELETE sent past the classifier is still refused by the read-only transaction.
 */
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyOracle } from '../../src/connections/classify-oracle.js';
import type { ConnectionSpec } from '../../src/connections/drivers.js';
import { OracleDriver } from '../../src/connections/oracle.js';
import { parseAllowList } from '../../src/mcp/hosts.js';

const URL_ = process.env.TEST_ORACLE_URL;

interface Conn {
  execute(sql: string, binds?: unknown[], opts?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

describe.skipIf(!URL_)('Oracle driver (TEST_ORACLE_URL)', () => {
  const u = new URL(URL_ ?? 'oracle://x:y@127.0.0.1:1521/X');
  const spec: ConnectionSpec = { engine: 'oracle', endpoint: `${u.hostname}:${u.port || 1521}`, database: u.pathname.slice(1), tls: false, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password), options: {} };
  const driver = new OracleDriver(spec, parseAllowList(''));
  const table = `EXPRSN_T${Date.now() % 100000}`;
  let admin: Conn;

  beforeAll(async () => {
    const oracledb = createRequire(import.meta.url)('oracledb') as { getConnection(o: Record<string, unknown>): Promise<Conn> };
    admin = await oracledb.getConnection({ user: spec.username, password: spec.password, connectString: `${spec.endpoint}/${spec.database}` });
    await admin.execute(`CREATE TABLE ${table} (id NUMBER PRIMARY KEY, name VARCHAR2(50), big NUMBER, updated_at TIMESTAMP)`);
    for (let i = 1; i <= 12; i++) await admin.execute(`INSERT INTO ${table} VALUES (:1, :2, :3, TIMESTAMP '2026-01-01 00:00:00' + NUMTODSINTERVAL(:4, 'DAY'))`, [i, `n${i}`, i === 1 ? '123456789012345678901234' : i, i]);
    await admin.execute('COMMIT');
  }, 60_000);

  afterAll(async () => {
    await admin?.execute(`DROP TABLE ${table} PURGE`).catch(() => undefined);
    await admin?.close();
  });

  it('tests and introspects', async () => {
    const t = await driver.test(10_000);
    expect(t.version).toMatch(/Oracle/);
    expect(t.readOnly).toBe(false);
    const schema = await driver.introspect(20_000);
    const o = schema.find((x) => x.name === `${spec.username!.toUpperCase()}.${table}`);
    expect(o?.columns.map((c) => c.name)).toEqual(['ID', 'NAME', 'BIG', 'UPDATED_AT']);
  });

  it('reads capped pages with binds and keeps big numbers exact', async () => {
    const q = `SELECT id, name, big FROM ${table} WHERE id > :1 ORDER BY id`;
    expect(classifyOracle(q).kind).toBe('read');
    const r = await driver.query(classifyOracle(q), q, { limit: 5, timeoutMs: 10_000, params: [0] });
    expect(r.columns).toEqual(['ID', 'NAME', 'BIG']);
    expect(r.rows[0]).toEqual([1, 'n1', '123456789012345678901234']);
    expect(r.capped).toBe(true);
    const p2 = await driver.query(classifyOracle(q), q, { limit: 5, timeoutMs: 10_000, params: [0], offset: 10 });
    expect(p2.rows.map((x) => x[0])).toEqual([11, 12]);
    expect(p2.capped).toBe(false);
  });

  it('refuses a write in the read-only transaction even past the classifier', async () => {
    const conn = driver as unknown as { client(t: number, fn: (c: Conn) => Promise<unknown>): Promise<unknown>; readOnly(c: Conn, fn: () => Promise<unknown>): Promise<unknown> };
    await expect(conn.client(10_000, (c) => conn.readOnly(c, () => c.execute(`DELETE FROM ${table}`)))).rejects.toThrow(/ORA-01456/);
  });

  it('reads rows after a watermark', async () => {
    const r = await driver.rows(`${spec.username!.toUpperCase()}.${table}`, { watermarkColumn: 'UPDATED_AT', after: '2026-01-10T00:00:00.000Z', limit: 10, timeoutMs: 10_000 });
    expect(r.rows.map((x) => x[0])).toEqual([10, 11, 12]);
  });
});
