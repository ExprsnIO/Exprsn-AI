/*
 * Sprint 15 paths against real servers. Each block runs when its variable is set (CI sets them):
 *
 *   TEST_REDIS_URL   shared rate-limit and denial counters across two instances (one atomic Lua script)
 *   TEST_PG_URL      a streamed backup restored into PostgreSQL (foreign keys deferred, booleans), then verified
 *   TEST_MYSQL_URL   the same on MySQL, and the MySQL data-connection driver refusing writes in its read-only transaction
 */
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import { Redis } from 'ioredis';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { bootstrap } from '../../src/bootstrap.js';
import { Limiter, RedisCounterStore } from '../../src/platform/ratelimit.js';
import { DenialAudit } from '../../src/audit/denials.js';
import type { AuditInput, AuditLog } from '../../src/audit/chain.js';
import { MysqlDriver } from '../../src/connections/drivers.js';
import { classifyMysql } from '../../src/connections/classify.js';
import { parseAllowList } from '../../src/mcp/hosts.js';
import { testConfig } from '../helpers.js';

const REDIS = process.env.TEST_REDIS_URL;

describe.skipIf(!REDIS)('Redis counters', () => {
  it('two instances share one limit, with the window expiry set atomically', async () => {
    const a = new RedisCounterStore(REDIS!);
    const b = new RedisCounterStore(REDIS!);
    const key = `it-${randomBytes(6).toString('hex')}`;
    try {
      const la = new Limiter(a, 'api', 3, 60_000);
      const lb = new Limiter(b, 'api', 3, 60_000);
      const results = await Promise.all([la.consume(key), lb.consume(key), la.consume(key), lb.consume(key), la.consume(key)]);
      expect(results.filter((r) => r.allowed)).toHaveLength(3);
      expect(Math.max(...results.map((r) => r.count))).toBe(5);
      const redis = new Redis(REDIS!);
      const ttl = await redis.pttl(`exprsn:rl:api:${key}`);
      await redis.quit();
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60_000);
      expect((await lb.blocked(key)).blocked).toBe(true);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('caps full denial entries for the whole deployment', async () => {
    const written: AuditInput[] = [];
    const audit = { append: async (i: AuditInput) => void written.push(i) } as unknown as AuditLog;
    const a = new RedisCounterStore(REDIS!);
    const b = new RedisCounterStore(REDIS!);
    const key = `t:${randomBytes(6).toString('hex')}`;
    try {
      const one = new DenialAudit(audit, 20, 60_000, a);
      const two = new DenialAudit(audit, 20, 60_000, b);
      const input = { tenantId: 't', action: 'authz.denied', kind: 'decision' as const, actor: { user: 'u' }, target: { method: 'GET', path: '/x' } };
      for (let i = 0; i < 15; i++) await Promise.all([one.record(key, input), two.record(key, input)]);
      expect(written.filter((w) => w.action === 'authz.denied')).toHaveLength(20);
      await one.flushAll();
      await two.flushAll();
    } finally {
      await a.close();
      await b.close();
    }
  });
});

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`backup and restore on ${d.name}`, () => {
    it('restores a streamed backup into the database (replacing it under --force) and everything verifies', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      // A fresh schema: the keys in this test's config must be the ones that wrapped the tenant keys.
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        await s.audit.append({ tenantId: tenant.id, action: 'test.before-backup', kind: 'admin', actor: { service: 'test' } });
        await s.checkpoints.create(tenant.id, 'test');
        const sealed = await s.keys.seal(tenant.id, 'kept', 'aad');
        const b = await s.ops.backups.createNow({ tenantId: tenant.id, actor: { service: 'test' }, userId: null });
        // Changes after the backup disappear when it is restored.
        await s.audit.append({ tenantId: tenant.id, action: 'test.after-backup', kind: 'admin', actor: { service: 'test' } });
        await expect(s.ops.backups.restoreInto({ target: db, client: d.client, kms: s.kms, from: s.blobs, blobsTo: null, backupId: b.id, force: false })).rejects.toThrow(/not empty/);
        const r = await s.ops.backups.restoreInto({ target: db, client: d.client, kms: s.kms, from: s.blobs, blobsTo: s.blobs, backupId: b.id, force: true });
        expect(r.wiped).toBe(true);
        expect(await db('audit_events').where({ action: 'test.after-backup' }).first()).toBeUndefined();
        expect(await db('audit_events').where({ action: 'test.before-backup' }).first()).toBeTruthy();
        expect((await s.checkpoints.verify(tenant.id)).status).toBe('verified');
        expect(await s.keys.open(tenant.id, sealed, 'aad')).toBe('kept');
        const drill = await s.ops.backups.drillNow({ tenantId: tenant.id, actor: { service: 'test' }, userId: null }, b.id);
        expect(drill.state).toBe('passed');
      } finally {
        await s.close();
        await db.destroy();
      }
    }, 120_000);
  });
}

const MYSQL = process.env.TEST_MYSQL_URL;

describe.skipIf(!MYSQL)('MySQL data connections', () => {
  const table = `orders_${randomBytes(4).toString('hex')}`;
  let admin: mysql.Connection | undefined;
  afterAll(async () => {
    await admin?.query(`DROP TABLE IF EXISTS \`${table}\``).catch(() => undefined);
    await admin?.end();
  });

  it('queries read-only: a write the parser missed is refused by the server', async () => {
    admin = await mysql.createConnection(MYSQL!);
    await admin.query(`CREATE TABLE \`${table}\` (id INT PRIMARY KEY, total DECIMAL(10,2))`);
    await admin.query(`INSERT INTO \`${table}\` VALUES (1, 9.99), (2, 20.00)`);
    const u = new URL(MYSQL!);
    const driver = new MysqlDriver({ engine: 'mysql', endpoint: `${u.hostname}:${u.port || 3306}`, database: u.pathname.slice(1), tls: false, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }, parseAllowList('127.0.0.1,localhost,::1'));
    const t = await driver.test(5000);
    expect(t.version).toMatch(/^MySQL /);
    const schema = await driver.introspect(5000);
    expect(schema.find((o) => o.name.endsWith(`.${table}`))?.columns.map((c) => c.name)).toEqual(['id', 'total']);
    const sql = `SELECT id, total FROM \`${table}\` ORDER BY id`;
    const r = await driver.query(classifyMysql(sql), sql, { limit: 1, timeoutMs: 5000 });
    expect(r).toMatchObject({ columns: ['id', 'total'], rows: [[1, '9.99']], capped: true });
    // Straight at the driver's read-only transaction, bypassing the classifier: the server refuses.
    const priv = driver as unknown as { client: <T>(ms: number, fn: (c: mysql.Connection) => Promise<T>) => Promise<T>; readOnly: <T>(c: mysql.Connection, ms: number, fn: () => Promise<T>) => Promise<T> };
    await expect(priv.client(5000, (c) => priv.readOnly(c, 5000, () => c.query(`UPDATE \`${table}\` SET total = 0`)))).rejects.toThrow(/READ ONLY/i);
    const [rows] = (await admin.query(`SELECT total FROM \`${table}\` WHERE id = 1`)) as unknown as [{ total: string }[]];
    expect(rows[0]!.total).toBe('9.99');
  });
});
