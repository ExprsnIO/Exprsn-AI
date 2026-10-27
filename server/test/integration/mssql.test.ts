/*
 * 1.9.0: SQL Server data connections against a real server.
 *
 *   TEST_MSSQL_URL   mssql://user:password@host:1433/database (an account that may create a table there), e.g. the
 *                    mcr.microsoft.com/mssql/server image with `sa`. `?encrypt=true` turns TLS on (the server's
 *                    certificate must then verify against the host name).
 *
 * The driver tests the account, lists the schema, caps a read at the row limit (cancelling the request), skips an
 * offset, binds @pN parameters, reads rows after a watermark, and runs every read in a transaction that is rolled
 * back: a write sent straight through the driver's read path, bypassing the classifier, leaves no trace.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { classifyTsql } from '../../src/connections/classify-tsql.js';
import { MssqlDriver } from '../../src/connections/mssql.js';
import { parseAllowList } from '../../src/mcp/hosts.js';

const URL_ = process.env.TEST_MSSQL_URL;

describe.skipIf(!URL_)('SQL Server data connections', () => {
  const table = `orders_${randomBytes(4).toString('hex')}`;
  const u = URL_ ? new URL(URL_) : null;
  const spec = u
    ? { engine: 'mssql' as const, endpoint: `${u.hostname}:${u.port || 1433}`, database: u.pathname.slice(1) || 'master', tls: u.searchParams.get('encrypt') === 'true', username: decodeURIComponent(u.username), password: decodeURIComponent(u.password), options: { schema: 'dbo', applicationIntent: 'ReadWrite' } }
    : null;
  const driver = spec ? new MssqlDriver(spec, parseAllowList('127.0.0.1,localhost,::1')) : null;
  // The driver's own request path, used here as an administrator to set up and inspect the table.
  const admin = driver as unknown as { session: <T>(ms: number, fn: (c: unknown) => Promise<T>) => Promise<T>; exec: (c: unknown, sql: string, params?: unknown[], stop?: number, batch?: boolean) => Promise<{ rows: unknown[][] }>; readOnly: <T>(c: unknown, ms: number, fn: () => Promise<T>) => Promise<T> };

  afterAll(async () => {
    await admin?.session(5000, (c) => admin.exec(c, `IF OBJECT_ID('dbo.${table}') IS NOT NULL DROP TABLE dbo.${table}`, [], Infinity, true)).catch(() => undefined);
  });

  it('tests, introspects, caps, binds, pages and rolls every read back', async () => {
    await admin.session(10_000, async (c) => {
      await admin.exec(c, `CREATE TABLE dbo.${table} (id INT PRIMARY KEY, total DECIMAL(10,2), email NVARCHAR(200), updated_at DATETIME2)`, [], Infinity, true);
      await admin.exec(c, `INSERT INTO dbo.${table} VALUES (1, 9.99, N'a@example.org', '2026-01-01'), (2, 20.00, N'b@example.org', '2026-01-02'), (3, 5.50, N'c@example.org', '2026-01-03')`, [], Infinity, true);
    });
    const t = await driver!.test(10_000);
    expect(t.version).toMatch(/^(SQL Server|Azure SQL) /);
    expect(t.health).toBe('healthy');
    const schema = await driver!.introspect(10_000);
    expect(schema.find((o) => o.name === `dbo.${table}`)?.columns.map((x) => x.name)).toEqual(['id', 'total', 'email', 'updated_at']);

    const sql = `SELECT id, total FROM dbo.${table} WHERE total > @p1 ORDER BY id`;
    const r = await driver!.query(classifyTsql(sql), sql, { limit: 1, timeoutMs: 10_000, params: [1] });
    expect(r).toMatchObject({ columns: ['id', 'total'], rows: [[1, 9.99]], capped: true });
    const page2 = await driver!.query(classifyTsql(sql), sql, { limit: 5, timeoutMs: 10_000, params: [1], offset: 1 });
    expect(page2.rows.map((x) => x[0])).toEqual([2, 3]);
    expect(page2.capped).toBe(false);

    const after = await driver!.rows(`dbo.${table}`, { watermarkColumn: 'updated_at', after: '2026-01-01T12:00:00Z', limit: 10, timeoutMs: 10_000 });
    expect(after.rows.map((x) => x[0])).toEqual([2, 3]);

    // Straight at the read path, bypassing the classifier: the transaction is rolled back.
    await admin.session(10_000, (c) => admin.readOnly(c, 10_000, () => admin.exec(c, `UPDATE dbo.${table} SET total = 0`)));
    const check = await admin.session(10_000, (c) => admin.exec(c, `SELECT total FROM dbo.${table} WHERE id = 1`));
    expect(Number(check.rows[0]![0])).toBe(9.99);
  }, 60_000);
});
