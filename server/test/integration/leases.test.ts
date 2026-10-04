/*
 * Sprint 25 (B-1704 to B-1706) on real servers. The app database is the server under test (so migration 027c runs on
 * the dialect), and the same server is the target of the built-in lease engine: an admin login with CREATEROLE (or
 * CREATE USER) is made here, a lease is issued, used, renewed and left to expire, and after the sweeper the account
 * no longer exists in the database.
 *
 *   TEST_PG_URL      a superuser URL, e.g. postgres://postgres:postgres@localhost:5432/exprsn_test
 *   TEST_MYSQL_URL   a URL whose account may CREATE USER and GRANT, e.g. mysql://root:root@localhost:3306/exprsn_test
 */
import { randomBytes } from 'node:crypto';
import knexFactory from 'knex';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { hashPassword } from '../../src/identity/passwords.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { testConfig } from '../helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, dialect: 'postgres' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, dialect: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`database leases on ${d.name}`, () => {
    it('issues a working account, renews it, and the sweeper drops it once expired', async () => {
      const url = new URL(d.url!);
      const host = url.hostname;
      const port = Number(url.port) || (d.dialect === 'postgres' ? 5432 : 3306);
      const database = url.pathname.replace(/^\//, '');
      const admin = `exai_it_admin_${randomBytes(3).toString('hex')}`;
      const adminPw = `It-${randomBytes(12).toString('hex')}`;
      const schema = d.dialect === 'postgres' ? `it_leases_${randomBytes(3).toString('hex')}` : database;
      const raw = knexFactory({ client: d.client === 'pg' ? 'pg' : 'mysql2', connection: d.url! });

      // The target: an admin login that may create accounts, owning (or granting on) one table.
      if (d.dialect === 'postgres') {
        await raw.raw(`CREATE ROLE "${admin}" WITH LOGIN CREATEROLE PASSWORD '${adminPw}'`);
        await raw.raw(`CREATE SCHEMA "${schema}" AUTHORIZATION "${admin}"`);
        await raw.raw(`CREATE TABLE "${schema}".items (id int primary key, name text)`);
        await raw.raw(`ALTER TABLE "${schema}".items OWNER TO "${admin}"`);
        await raw.raw(`INSERT INTO "${schema}".items VALUES (1, 'widget')`);
      } else {
        await raw.raw(`CREATE USER '${admin}'@'%' IDENTIFIED BY '${adminPw}'`);
        await raw.raw(`GRANT CREATE USER ON *.* TO '${admin}'@'%'`);
        await raw.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON \`${database}\`.* TO '${admin}'@'%' WITH GRANT OPTION`);
        await raw.raw('CREATE TABLE IF NOT EXISTS it_lease_items (id int primary key, name varchar(50))');
        await raw.raw("INSERT IGNORE INTO it_lease_items VALUES (1, 'widget')");
      }

      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url!, CONNECTIONS_ALLOWED_HOSTS: host });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      const asLease = async (username: string, password: string, sql: string) => {
        if (d.dialect === 'postgres') {
          const c = new pg.Client({ host, port, database, user: username, password });
          await c.connect();
          try {
            return (await c.query(sql)).rows as unknown[];
          } finally {
            await c.end();
          }
        }
        const c = await mysql.createConnection({ host, port, database, user: username, password });
        try {
          return (await c.query(sql))[0] as unknown[];
        } finally {
          await c.end();
        }
      };
      const exists = async (username: string) =>
        d.dialect === 'postgres'
          ? ((await raw.raw('SELECT 1 FROM pg_roles WHERE rolname = ?', [username])) as { rows: unknown[] }).rows.length > 0
          : ((await raw.raw('SELECT 1 FROM mysql.user WHERE User = ?', [username])) as unknown[][])[0]!.length > 0;
      try {
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const user = await s.users.create(tenant.id, { username: 'leaser', displayName: 'Leaser', clearance: 'internal' });
        const local = (await s.providers.list(tenant.id)).find((p) => p.kind === 'local')!;
        await s.db('local_credentials').insert({ user_id: user.id, password_hash: await hashPassword('x'), updated_at: Date.now() });
        await s.users.upsertIdentity(user.id, local.id, user.id, []);
        await s.users.setRoles(user.id, 'direct', ['system-admin']);
        const p = (await loadPrincipal(s, tenant.id, user.id, {}))!;
        await s.vault.createGrant(await s.vault.callerFor(p), { subjectKind: 'user', subject: user.id, path: 'database', capabilities: ['read', 'list'], effect: 'allow' });

        const engine = await s.dbLeases.registerEngine(p, { name: 'it', dialect: d.dialect, endpoint: `${host}:${port}`, database, tls: false, zone: 'data', label: 'internal', adminUsername: admin, adminPassword: adminPw, userHost: '%', defaultTtlSeconds: 60, maxTtlSeconds: 600, check: true });
        expect(engine).toMatchObject({ name: 'it', check: { canCreate: true } });
        const table = d.dialect === 'postgres' ? `"${schema}".items` : 'it_lease_items';
        await s.dbLeases.putRole(p, 'it', 'reader', { privileges: 'read', schemas: [schema] });

        // Issue: the account exists and can read, but not write.
        const lease = await s.dbLeases.issue(p, 'it', 'reader', { ttlSeconds: 2 });
        expect(await exists(lease.username)).toBe(true);
        expect(await asLease(lease.username, lease.password, `SELECT name FROM ${table} WHERE id = 1`)).toEqual([{ name: 'widget' }]);
        await expect(asLease(lease.username, lease.password, `INSERT INTO ${table} VALUES (2, 'nope')`)).rejects.toThrow(/denied/i);
        if (d.dialect === 'postgres') {
          const until = ((await raw.raw('SELECT rolvaliduntil FROM pg_roles WHERE rolname = ?', [lease.username])) as { rows: { rolvaliduntil: Date }[] }).rows[0]!.rolvaliduntil;
          expect(new Date(until).getTime()).toBe(lease.expiresAt);
        }

        // Renew, revoke.
        const other = await s.dbLeases.issue(p, 'it', 'reader', { ttlSeconds: 30 });
        const renewed = await s.dbLeases.renew(p, other.id, 120);
        expect(renewed.expiresAt).toBeGreaterThan(other.expiresAt);
        if (d.dialect === 'postgres') {
          const until = ((await raw.raw('SELECT rolvaliduntil FROM pg_roles WHERE rolname = ?', [other.username])) as { rows: { rolvaliduntil: Date }[] }).rows[0]!.rolvaliduntil;
          expect(new Date(until).getTime()).toBe(renewed.expiresAt);
        }
        await s.dbLeases.revoke(p, other.id);
        expect(await exists(other.username)).toBe(false);

        // Expire, sweep: the account is gone from the database.
        await sleep(2200);
        expect(await exists(lease.username)).toBe(true);
        expect(await s.dbLeases.sweep(tenant.id)).toEqual({ ended: 1, failed: 0 });
        expect(await exists(lease.username)).toBe(false);
        expect((await s.dbLeases.getLease(p, lease.id)).state).toBe('expired');
        await expect(asLease(lease.username, lease.password, 'SELECT 1')).rejects.toThrow();

        // Removing the engine revokes whatever is still live.
        const last = await s.dbLeases.issue(p, 'it', 'reader', {});
        await s.dbLeases.removeEngine(p, 'it');
        expect(await exists(last.username)).toBe(false);
      } finally {
        await s.close();
        await db.destroy();
        if (d.dialect === 'postgres') {
          await raw.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
          await raw.raw(`DROP ROLE IF EXISTS "${admin}"`).catch(() => undefined);
        } else {
          await raw.raw('DROP TABLE IF EXISTS it_lease_items').catch(() => undefined);
          await raw.raw(`DROP USER IF EXISTS '${admin}'@'%'`).catch(() => undefined);
        }
        await raw.destroy();
      }
    });
  });
}
