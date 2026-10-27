/*
 * 1.6.0, Sprint 37c (B-4802): MongoDB leases on a real server (TEST_MONGODB_URL, an account that may create users, such
 * as mongodb://root:root@127.0.0.1:27017/?authSource=admin, CI's mongo:8 service). A throwaway admin login with
 * userAdminAnyDatabase is made for the engine; a lease is issued, reads but cannot write, is renewed, and once expired
 * the sweeper drops it: the user no longer exists and its password no longer signs in. Databases and users made here
 * are named exprsn_it_lease* / exai_* and removed afterwards; nothing else on the server is touched. The engine's
 * metadata is kept in each application database the run has: SQLite always, PostgreSQL with TEST_PG_URL and MySQL
 * with TEST_MYSQL_URL.
 */
import { randomBytes } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { testConfig } from '../helpers.js';

const URL_ = process.env.TEST_MONGODB_URL;

for (const d of [
  { name: 'SQLite', client: 'sqlite' as const, url: 'memory' },
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!URL_ || !d.url)(`MongoDB leases on a real server, metadata on ${d.name}`, () => {
    it('issues a read-only account, renews it, and an expired lease\'s user no longer exists', async () => {
      const u = new URL(URL_!);
      const host = u.hostname;
      const port = Number(u.port) || 27017;
      const tag = randomBytes(3).toString('hex');
      const DB = `exprsn_it_lease_${tag}`;
      const admin = `exai_it_admin_${tag}`;
      const adminPw = `It-${randomBytes(12).toString('hex')}`;
      const made: string[] = [admin];
      const root = new MongoClient(URL_!);
      await root.connect();
      const userExists = async (name: string) => (((await root.db('admin').command({ usersInfo: { user: name, db: 'admin' } })) as { users: unknown[] }).users.length > 0);
      const asLease = async (username: string, password: string) => {
        const c = new MongoClient(`mongodb://${host}:${port}/?directConnection=true`, { auth: { username, password }, authSource: 'admin', serverSelectionTimeoutMS: 5000 });
        await c.connect();
        return c;
      };

      const cfg = testConfig({ OLLAMA_POLL_MS: '600000', CONNECTIONS_ALLOWED_HOSTS: host, ...(d.client === 'sqlite' ? {} : { DB_CLIENT: d.client, DATABASE_URL: d.url! }) });
      const db = createDb(cfg);
      if (d.client !== 'sqlite') await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        // The target: one collection, and an admin login that may create users (userAdminAnyDatabase).
        await root.db(DB).collection('items').insertOne({ _id: 1 as never, name: 'widget' });
        await root.db('admin').command({ createUser: admin, pwd: adminPw, roles: [{ role: 'userAdminAnyDatabase', db: 'admin' }] });

        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const user = await s.users.create(tenant.id, { username: 'leaser', displayName: 'Leaser', clearance: 'internal' });
        await s.users.setRoles(user.id, 'direct', ['system-admin']);
        const p = (await loadPrincipal(s, tenant.id, user.id, {}))!;
        await s.vault.createGrant(await s.vault.callerFor(p), { subjectKind: 'user', subject: user.id, path: 'database', capabilities: ['read', 'list'], effect: 'allow' });

        const engine = await s.dbLeases.registerEngine(p, { name: 'mongo-it', dialect: 'mongodb', endpoint: `${host}:${port}`, database: null, tls: false, zone: 'data', label: 'internal', adminUsername: `admin/${admin}`, adminPassword: adminPw, userHost: '%', defaultTtlSeconds: 60, maxTtlSeconds: 600, check: true });
        expect(engine).toMatchObject({ dialect: 'mongodb', database: 'admin', check: { canCreate: true, version: expect.stringMatching(/^MongoDB 8\./) } });
        await s.dbLeases.putRole(p, 'mongo-it', 'reader', { privileges: 'read', schemas: [DB] });

        // Issue: the user exists, reads, and cannot write.
        const lease = await s.dbLeases.issue(p, 'mongo-it', 'reader', { ttlSeconds: 30 });
        made.push(lease.username);
        expect(await userExists(lease.username)).toBe(true);
        const c = await asLease(lease.username, lease.password);
        try {
          expect(await c.db(DB).collection('items').findOne({ _id: 1 as never })).toMatchObject({ name: 'widget' });
          await expect(c.db(DB).collection('items').insertOne({ _id: 2 as never, name: 'nope' })).rejects.toThrow(/not authorized|Unauthorized/i);
        } finally {
          await c.close();
        }
        const info = (await root.db('admin').command({ usersInfo: { user: lease.username, db: 'admin' } })) as { users: { customData?: { validUntil?: string }; roles: { role: string; db: string }[] }[] };
        expect(info.users[0]!.roles).toEqual([{ role: 'read', db: DB }]);
        expect(Date.parse(info.users[0]!.customData!.validUntil!)).toBe(lease.expiresAt);

        // Renew: the expiry recorded on the user moves.
        const renewed = await s.dbLeases.renew(p, lease.id, 120);
        const after = (await root.db('admin').command({ usersInfo: { user: lease.username, db: 'admin' } })) as { users: { customData?: { validUntil?: string } }[] };
        expect(Date.parse(after.users[0]!.customData!.validUntil!)).toBe(renewed.expiresAt);

        // Revoke one; expire the other: the sweeper drops it and its password no longer signs in.
        const other = await s.dbLeases.issue(p, 'mongo-it', 'reader', {});
        made.push(other.username);
        await s.dbLeases.revoke(p, other.id);
        expect(await userExists(other.username)).toBe(false);
        await s.db('vault_db_leases').where({ id: lease.id }).update({ expires_at: Date.now() - 1000 });
        expect(await s.dbLeases.sweep(tenant.id)).toEqual({ ended: 1, failed: 0 });
        expect(await userExists(lease.username)).toBe(false);
        expect((await s.dbLeases.getLease(p, lease.id)).state).toBe('expired');
        await expect(asLease(lease.username, lease.password)).rejects.toThrow(/Authentication failed|auth/i);

        // Removing the engine revokes whatever is still live.
        const last = await s.dbLeases.issue(p, 'mongo-it', 'reader', {});
        made.push(last.username);
        await s.dbLeases.removeEngine(p, 'mongo-it');
        expect(await userExists(last.username)).toBe(false);
      } finally {
        await s.close();
        await db.destroy();
        for (const name of made) await root.db('admin').command({ dropUser: name }).catch(() => undefined);
        await root.db(DB).dropDatabase().catch(() => undefined);
        await root.close();
      }
    }, 120_000);
  });
}
