/*
 * Sprint 28c (1.4.0), the workspace feed, against real databases. Each block runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 030c_feed; posts sealed at rest; cursor pages in a stable order across
 *                                  equal publication times; comments refused on a deleted post; a plain repost made
 *                                  twice at once is one row (the unique key on author and original); hashtags with
 *                                  accents; the trending job's grouped counts; a block from the shared relations
 *                                  hides posts; the digest job ranks the week's posts and fails soft without a model
 */
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { testConfig } from '../helpers.js';

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`the workspace feed on ${d.name}`, () => {
    it('migrates 030c_feed and runs posts, pages, comments, reposts, tags, trending, blocks and digests', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url!, FEED_DIGEST_PROFILE: 'nowhere' });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        expect(await db.schema.hasTable('feed_digests')).toBe(true);
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const ws = await s.tenants.createWorkspace(tenant.id, 'Studio', 'confidential');
        const person = async (username: string) => {
          const u = await s.users.create(tenant.id, { username, displayName: username.toUpperCase(), clearance: 'internal' });
          await s.users.update(tenant.id, u.id, { clearance_direct: 'internal' });
          await s.users.setRoles(u.id, 'direct', ['member']);
          await s.tenants.addMember(ws.id, u.id);
          const p = (await loadPrincipal(s, tenant.id, u.id, {}))!;
          p.workspaceId = ws.id;
          return { u, ctx: { p, ip: null } };
        };
        const ann = await person('ann');
        const ben = await person('ben');
        const cy = await person('cy');

        const first = await s.feed.createPost(ann.ctx, { workspaceId: ws.id, body: 'Proofs are in #Café #type' });
        expect(String((await db('feed_posts').where({ id: first.id }).first()).body)).not.toContain('Proofs');
        expect(first.tags).toEqual(['café', 'type']);
        const made = [first.id];
        for (let i = 0; i < 4; i++) made.push((await s.feed.createPost(i % 2 ? ben.ctx : ann.ctx, { workspaceId: ws.id, body: `Note ${i} #type` })).id);
        // equal publication times still page in a stable order (by id)
        await db('feed_posts').whereIn('id', made.slice(1, 4)).update({ published_at: 1_800_000_000_000 });
        const seen: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await s.feed.workspace(cy.ctx.p, ws.id, { cursor, limit: 2 });
          seen.push(...page.items.map((x) => x.id));
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        expect(new Set(seen).size).toBe(5);
        expect(seen.slice(0, 3)).toEqual(made.slice(1, 4).sort().reverse());

        await s.feed.comment(ben.ctx, first.id, { body: 'Lovely' });
        await s.feed.react(cy.ctx, first.id, 'like');
        // two plain reposts at once are one
        const both = await Promise.all([s.feed.repost(cy.ctx, first.id), s.feed.repost(cy.ctx, first.id)]);
        expect(both[0].post.id).toBe(both[1].post.id);
        expect(await db('feed_posts').where({ repost_of: first.id }).count({ n: '*' }).then((r) => Number((r as { n: number }[])[0]!.n))).toBe(1);

        await s.feed.digests.trendingJob(tenant.id);
        const trending = await s.feed.digests.trending(cy.ctx.p, [ws.id]);
        expect(trending.tags[0]).toEqual({ tag: 'type', posts: 5, people: 2 });
        expect(trending.tags.map((t) => t.tag)).toContain('café');
        expect((await s.feed.tag(cy.ctx.p, '#CAFÉ', ws.id, {})).items.map((x) => x.id)).toEqual([first.id]);

        // the shared relations: a block hides posts both ways
        await s.social.block(cy.ctx, ann.u.id);
        expect((await s.feed.workspace(cy.ctx.p, ws.id, {})).items.every((x) => x.author.id !== ann.u.id)).toBe(true);
        expect((await s.feed.workspace(ann.ctx.p, ws.id, {})).items.every((x) => x.author.id !== cy.u.id)).toBe(true);

        // a comment on a deleted post is refused
        await s.feed.deletePost(ann.ctx, first.id);
        await expect(s.feed.comment(ben.ctx, first.id, { body: 'Still there?' })).rejects.toMatchObject({ status: 409 });

        // the digest job ranks the week and fails soft when the profile cannot answer
        await db('feed_posts').whereIn('id', made.slice(1, 4)).update({ published_at: Date.now() - 1000 });
        const weekEnd = Date.now() + 1000;
        const out = await s.feed.digests.digestJob(tenant.id, { workspaceId: ws.id, weekEnd, by: null });
        expect(out.digests).toBe(1);
        const dg = (await db('feed_digests').where({ workspace_id: ws.id }).first()) as { state: string; posts: string; error: string };
        expect(dg.state).toBe('failed');
        expect(JSON.parse(dg.posts)).toHaveLength(Math.min(cfg.FEED_DIGEST_TOP, 4));
        expect((await s.feed.digests.digestJob(tenant.id, { workspaceId: ws.id, weekEnd, by: null })).digests).toBe(0);
      } finally {
        await s.close();
        await db.destroy();
      }
    });
  });
}
