/*
 * 1.9.0, Sprint 52 (B-170 to B-172) on PostgreSQL and MySQL: migrations 138 and 139 (applied here until they are
 * registered), the prefix table's insert-or-ignore, booleans and the cursor column, the backfill, phrases and prefixes,
 * post search with its filters, and a key rotation, with no sample word in the index tables.
 */
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { down as down138, up as up138 } from '../../src/db/migrations/138_search_index.js';
import { down as down139, up as up139 } from '../../src/db/migrations/139_search_state.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import type { Ctx } from '../../src/messaging/service.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { testConfig } from '../helpers.js';

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`search index on ${d.name}`, () => {
    it('backfills, searches by words, phrases and prefixes, filters posts and rotates its key', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      await down139(db).catch(() => undefined);
      await down138(db).catch(() => undefined);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      await up138(db);
      await up139(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const ws = await s.tenants.createWorkspace(tenant.id, 'Studio', 'internal');
        const person = async (username: string, roles = ['member']): Promise<Ctx> => {
          const u = await s.users.create(tenant.id, { username, displayName: username.toUpperCase(), clearance: 'internal' });
          await s.users.update(tenant.id, u.id, { clearance_direct: 'internal' });
          await s.users.setRoles(u.id, 'direct', roles);
          await s.tenants.addMember(ws.id, u.id);
          const p = (await loadPrincipal(s, tenant.id, u.id, {}))!;
          p.workspaceId = ws.id;
          return { p, ip: null };
        };
        const [alice, bob, admin] = [await person('alice'), await person('bob'), await person('boss', ['tenant-admin'])];
        const conv = await s.messaging.createGroup(alice, { workspaceId: ws.id, title: 'Crew', memberIds: [bob.p.userId] });
        const before = await s.messaging.send(alice, conv.id, { body: 'the quick brown fox and the zanzibarquokka' });
        const post = await s.feed.createPost(alice, { workspaceId: ws.id, body: 'marmalade roadmap #plans' });
        const run = async () => {
          await s.search.index.drain();
          for (let i = 0; i < 20; i++) if (!(await s.jobs.runDue())) break;
          await s.search.index.drain();
        };
        await run();
        expect(await db('search_postings').count({ n: '*' }).then((r) => Number((r as { n: number }[])[0]!.n))).toBe(0);

        await s.search.index.enable(admin);
        await run();
        expect(await s.search.index.status(tenant.id)).toMatchObject({ state: 'ready', activeVersion: 1 });
        const after = await s.messaging.send(bob, conv.id, { body: 'brown quick fox, then marmalade' });
        await run();
        const chats = async (q: string) => (await s.search.chats.search(bob.p, { q, mode: 'keyword' })).items.map((x) => x.id);
        expect(await chats('"quick brown"')).toEqual([before.id]);
        expect((await chats('quick brown')).sort()).toEqual([before.id, after.id].sort());
        expect(await chats('zanzib*')).toEqual([before.id]);
        const posts = await s.search.posts.search(bob.p, { q: 'marm*', tag: 'plans' });
        expect(posts.items.map((x) => x.id)).toEqual([post.id]);
        expect(posts.engine).toBe('index');

        await s.search.index.rotate(admin);
        await run();
        expect(await s.search.index.status(tenant.id)).toMatchObject({ state: 'ready', activeVersion: 2, buildingVersion: null });
        expect(await db('search_postings').where({ key_version: 1 }).count({ n: '*' }).then((r) => Number((r as { n: number }[])[0]!.n))).toBe(0);
        expect(await chats('zanzibarquokka')).toEqual([before.id]);

        for (const t of ['search_postings', 'search_prefixes', 'search_docs', 'search_keys', 'search_state']) {
          const text = JSON.stringify(await db(t).select('*')).toLowerCase();
          for (const w of ['zanzibarquokka', 'marmalade', 'quick', 'brown']) expect(text.includes(w), `${t}: ${w}`).toBe(false);
        }
      } finally {
        await s.close();
        await down139(db).catch(() => undefined);
        await down138(db).catch(() => undefined);
        await db.destroy();
      }
    }, 120_000);
  });
}
