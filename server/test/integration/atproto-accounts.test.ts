/*
 * Sprint 26 (B-1807): AT-Protocol user DIDs on PostgreSQL and MySQL. Claims are one per user; a DID is bound to one
 * user per tenant even when two instances bind it at the same time (the unique index on verified_did, which allows
 * any number of unfinished claims); bindings list with their usernames.
 */
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { testConfig } from '../helpers.js';
import { FakePlcDirectory } from '../sprint25b-fakes.js';
import { FakePds } from '../sprint26b-fakes.js';

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`AT-Protocol accounts on ${d.name}`, () => {
    it('binds a DID to one user per tenant, also when two instances race', async () => {
      const plc = new FakePlcDirectory();
      await plc.start();
      const pds = new FakePds(async () => ({}));
      await pds.start();
      const did = `did:plc:${'shared'.padEnd(24, 'a')}`;
      pds.register(plc, { did, handle: 'shared.example.com' });
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url!, ATPROTO_PLC_URL: plc.url });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const one = createServices(cfg, db, createLogger('silent', false), new Metrics());
      const two = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        await bootstrap(one);
        const tenant = (await one.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const users = await Promise.all(['ann', 'ben', 'cid'].map((u) => one.users.create(tenant.id, { username: u, displayName: u })));
        const by = (userId: string) => ({ tenantId: tenant.id, userId, actor: { user: userId } });

        // Unfinished claims of the same DID do not collide.
        for (const u of users.slice(0, 2)) await one.atprotoAccounts.claim(by(u.id), u.id, did);
        expect((await one.atprotoAccounts.list(tenant.id, { verified: false, limit: 10, offset: 0 })).length).toBe(2);

        // Two instances bind it at once: exactly one wins.
        const results = await Promise.allSettled([
          one.atprotoAccounts.bind(by(users[0]!.id), users[0]!.id, { did, pds: pds.url, proof: 'oauth', handle: null }),
          two.atprotoAccounts.bind(by(users[1]!.id), users[1]!.id, { did, pds: pds.url, proof: 'oauth', handle: null })
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.status)).toEqual([409]);
        const bound = await one.atprotoAccounts.list(tenant.id, { verified: true, limit: 10, offset: 0 });
        expect(bound).toHaveLength(1);
        expect(['ann', 'ben']).toContain(bound[0]!.username);
        expect(await two.atprotoAccounts.boundUser(tenant.id, did)).toBe(bound[0]!.user_id);
        // A third user cannot claim it any more.
        await expect(one.atprotoAccounts.claim(by(users[2]!.id), users[2]!.id, did)).rejects.toMatchObject({ status: 409 });
      } finally {
        await one.close();
        await two.close();
        await db.destroy();
        await pds.stop();
        await plc.stop();
      }
    }, 120_000);
  });
}
