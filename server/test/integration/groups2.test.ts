/*
 * Sprint 36a (1.6.0), groups depth (B-4401 to B-4405), against real databases. Each block runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 038_groups2; a channel with its own members and posts, the label floor
 *                                  and the cascade on leaving; categories (a duplicate name refused by the unique
 *                                  index, removal leaving groups uncategorised in one transaction); discovery's shared
 *                                  members (nested subqueries) and activity; the trending job's grouped joins and
 *                                  posts; and the distance filter on groups and events over one fixture, which must
 *                                  give the same groups as SQLite (`server/test/sprint36a-groups.test.ts`). On
 *                                  PostgreSQL with PostGIS the filter goes through ST_DWithin and the GiST index,
 *                                  otherwise through the bounding box.
 */
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { hasPostgis, parseNear } from '../../src/groups/geo.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { testConfig } from '../helpers.js';

// The same places as the SQLite suite, plus two across the antimeridian.
const PLACES = {
  berlin: { lat: 52.52, lon: 13.405 },
  potsdam: { lat: 52.3906, lon: 13.0645 },
  hamburg: { lat: 53.5511, lon: 9.9937 },
  lisbon: { lat: 38.7223, lon: -9.1393 },
  suva: { lat: -18.1416, lon: 178.4419 },
  apia: { lat: -13.8333, lon: -171.7667 }
};

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`groups depth on ${d.name}`, () => {
    it('migrates 038_groups2 and runs channels, categories, discovery, trending and distance filters', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        for (const t of ['group_categories', 'group_trending']) expect(await db.schema.hasTable(t)).toBe(true);
        for (const c of ['parent_id', 'category_id', 'location', 'lat', 'lon']) expect(await db.schema.hasColumn('social_groups', c)).toBe(true);
        // With PostGIS the migration made the GiST indexes the distance filter uses; without, there are none.
        const postgis = await hasPostgis(db);
        if (d.client === 'pg') expect(((await db.raw("SELECT count(*)::int AS n FROM pg_indexes WHERE indexname IN ('social_groups_geog_idx', 'group_events_geog_idx')")) as { rows: { n: number }[] }).rows[0]!.n).toBe(postgis ? 2 : 0);
        else expect(postgis).toBe(false);
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const ws = await s.tenants.createWorkspace(tenant.id, 'Finance Ops', 'confidential');
        const person = async (username: string, roles: string[], clearance: 'internal' | 'confidential' = 'internal') => {
          const u = await s.users.create(tenant.id, { username, displayName: username.toUpperCase(), clearance });
          await s.users.update(tenant.id, u.id, { clearance_direct: clearance });
          await s.users.setRoles(u.id, 'direct', roles);
          await s.tenants.addMember(ws.id, u.id);
          const p = (await loadPrincipal(s, tenant.id, u.id, {}))!;
          p.workspaceId = ws.id;
          return { u, ctx: { p, ip: null } };
        };
        const ta = await person('ta', ['tenant-admin'], 'confidential');
        const ow = await person('ow', ['member'], 'confidential');
        const an = await person('an', ['member']);
        const bn = await person('bn', ['member']);

        // channels (B-4401)
        const g = await s.groups.create(ow.ctx, { workspaceId: ws.id, name: 'Close', visibility: 'private', joinMode: 'open' });
        await s.groups.join(an.ctx, g.id);
        await s.groups.join(bn.ctx, g.id);
        await expect(s.groups.createChannel(ow.ctx, g.id, { name: 'Low', label: 'public' })).rejects.toMatchObject({ status: 422 });
        const ch = await s.groups.createChannel(ow.ctx, g.id, { name: 'Accruals', visibility: 'private' });
        await s.groups.join(an.ctx, ch.id);
        expect((await s.groups.members(an.ctx.p, ch.id)).map((m) => m.username).sort()).toEqual(['an', 'ow']);
        await s.groups.createPost(an.ctx, ch.id, 'In the channel');
        expect((await s.groups.posts(an.ctx.p, ch.id, {})).map((x) => x.body)).toEqual(['In the channel']);
        expect(await s.groups.posts(an.ctx.p, g.id, {})).toEqual([]);
        await expect(s.groups.posts(bn.ctx.p, ch.id, {})).rejects.toMatchObject({ status: 403 });
        expect((await s.groups.list(an.ctx.p, {})).map((x) => x.name)).toEqual(['Close']);
        expect((await s.groups.view(an.ctx.p, g.id)).channels).toBe(1);
        expect(await s.groups.removeMember(an.ctx, g.id, an.u.id)).toMatchObject({ channels: 1 });
        expect(await db('group_members').where({ group_id: ch.id, user_id: an.u.id }).first()).toBeUndefined();

        // categories (B-4405)
        const proj = await s.groups.depth.createCategory(ta.ctx, { name: 'Projects' });
        await expect(s.groups.depth.createCategory(ta.ctx, { name: 'PROJECTS' })).rejects.toMatchObject({ status: 409 });
        const cat = await s.groups.create(ow.ctx, { workspaceId: ws.id, name: 'Catalogued', visibility: 'public', joinMode: 'open', categoryId: proj.id });
        expect((await s.groups.list(an.ctx.p, { category: proj.id })).map((x) => x.name)).toEqual(['Catalogued']);
        expect(await s.groups.depth.removeCategory(ta.ctx, proj.id)).toMatchObject({ uncategorised: 1 });
        expect(await s.groups.view(an.ctx.p, cat.id)).toMatchObject({ categoryId: null, state: 'active' });
        expect((await s.groups.list(an.ctx.p, { category: 'none' })).map((x) => x.name)).toContain('Catalogued');

        // discovery (B-4402): shared members through the nested subqueries, and activity
        const mine = await s.groups.create(ow.ctx, { workspaceId: ws.id, name: 'Mine', visibility: 'public', joinMode: 'open' });
        await s.groups.join(bn.ctx, mine.id);
        const shared = await s.groups.create(ow.ctx, { workspaceId: ws.id, name: 'Shared', visibility: 'public', joinMode: 'open' });
        await s.groups.create(ow.ctx, { workspaceId: ws.id, name: 'Above', visibility: 'public', joinMode: 'open', label: 'confidential' });
        const disc = await s.groups.depth.discover(bn.ctx.p, {});
        expect(disc.groups.find((x) => x.id === shared.id)).toMatchObject({ sharedMembers: 1, activity: { joins: 1, posts: 0 } });
        expect(disc.groups.map((x) => x.name)).not.toContain('Above');
        expect(disc.groups.map((x) => x.name)).not.toContain('Mine');

        // trending (B-4404): grouped joins and posts
        for (const n of ['t1', 't2', 't3']) await s.groups.join((await person(n, ['member'])).ctx, shared.id);
        expect(await s.groups.depth.trendingJob(tenant.id)).toMatchObject({ workspaces: 1 });
        const tr = await s.groups.depth.trending(an.ctx.p, {});
        expect(tr.groups[0]).toMatchObject({ name: 'Shared', trend: { joins: 4, posts: 0 } });

        // distance filters (B-4403): the same groups as on SQLite
        for (const [name, p] of Object.entries(PLACES)) await s.groups.create(ow.ctx, { workspaceId: ws.id, name: `At ${name}`, visibility: 'public', joinMode: 'open', location: { name, ...p } });
        const near = async (lat: number, lon: number, km: number) => (await s.groups.list(an.ctx.p, { near: parseNear(`${lat},${lon}`, km) })).map((x) => x.name);
        expect(await near(PLACES.berlin.lat, PLACES.berlin.lon, 50)).toEqual(['At berlin', 'At potsdam']);
        expect(await near(PLACES.berlin.lat, PLACES.berlin.lon, 300)).toEqual(['At berlin', 'At potsdam', 'At hamburg']);
        expect(await near(PLACES.berlin.lat, PLACES.berlin.lon, 27.5)).toEqual(['At berlin', 'At potsdam']);
        expect(await near(PLACES.berlin.lat, PLACES.berlin.lon, 26)).toEqual(['At berlin']);
        // across the antimeridian: Suva and Apia are about 1 150 km apart
        expect(await near(PLACES.suva.lat, PLACES.suva.lon, 1300)).toEqual(['At suva', 'At apia']);
        expect(await near(PLACES.suva.lat, PLACES.suva.lon, 1000)).toEqual(['At suva']);
        // events
        const host = await s.groups.create(ow.ctx, { workspaceId: ws.id, name: 'Host', visibility: 'public', joinMode: 'open' });
        await s.groups.join(an.ctx, host.id);
        await s.calendar.create(ow.ctx, host.id, { title: 'Berlin kickoff', start: '2030-05-04T10:00', timeZone: 'Europe/Berlin', ...PLACES.berlin });
        await s.calendar.create(ow.ctx, host.id, { title: 'Lisbon offsite', start: '2030-05-05T10:00', timeZone: 'Europe/Lisbon', ...PLACES.lisbon });
        const from = Date.parse('2030-05-01T00:00:00Z');
        const evs = await s.calendar.mine(an.ctx.p, { from, to: from + 30 * 86_400_000, near: parseNear(`${PLACES.potsdam.lat},${PLACES.potsdam.lon}`, 100) });
        expect(evs.map((e) => e.title)).toEqual(['Berlin kickoff']);
      } finally {
        await s.close();
        await db.destroy();
      }
    }, 120_000);
  });
}
