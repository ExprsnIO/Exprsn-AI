/*
 * Sprint 35d (1.6.0), Social and messaging administration (B-4206), against real databases. Each block runs when its
 * variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 037d_platform_social; workspace policies written twice (insert, then
 *                                  update) and read back; the Feed, Groups, Messaging and Relations views (their
 *                                  grouped counts and joins); a trending exclusion honoured by the job; a calendar
 *                                  feed revoked from the admin view stops rendering; transfer and archive; a
 *                                  legal-hold export approved by a second platform admin, written by its job and
 *                                  read back by the requester
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
  describe.skipIf(!d.url)(`social and messaging administration on ${d.name}`, () => {
    it('migrates 037d_platform_social and runs the policies, views, feed revocation, archive and a dual-control export', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        for (const t of ['social_workspace_policies', 'social_tenant_settings', 'feed_trending_exclusions', 'messaging_exports']) expect(await db.schema.hasTable(t)).toBe(true);
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const ws = await s.tenants.createWorkspace(tenant.id, 'Finance Ops', 'confidential');
        const person = async (username: string, roles: string[], clearance: 'internal' | 'restricted' = 'internal') => {
          const u = await s.users.create(tenant.id, { username, displayName: username.toUpperCase(), clearance });
          await s.users.update(tenant.id, u.id, { clearance_direct: clearance });
          await s.users.setRoles(u.id, 'direct', roles);
          await s.tenants.addMember(ws.id, u.id);
          const p = (await loadPrincipal(s, tenant.id, u.id, {}))!;
          p.workspaceId = ws.id;
          return { u, ctx: { p, ip: null } };
        };
        const ta = await person('ta', ['tenant-admin'], 'restricted');
        const sa = await person('sa', ['system-admin'], 'restricted');
        const al = await person('al', ['member']);
        const bo = await person('bo', ['member']);

        // policies: insert, then update
        await s.socialAdmin.setPolicy(ta.ctx, ws.id, { feedApprover: 'moderators', contactRule: 'workspace' });
        await s.socialAdmin.setPolicy(ta.ctx, ws.id, { groupJoin: 'open', groupVisibility: 'public', eventCapacity: 40 });
        expect(await s.socialAdmin.policy(tenant.id, ws.id)).toMatchObject({ feedApprover: 'moderators', groupJoin: 'open', groupVisibility: 'public', eventCapacity: 40, feedGuard: true });
        await s.socialAdmin.setTenantSettings(ta.ctx, { digestDay: 4, digestHour: 16, digestTop: 3 });
        await s.socialAdmin.setTenantSettings(ta.ctx, { digestMaxLabel: 'internal' });
        expect(await s.socialAdmin.tenantSettings(tenant.id)).toMatchObject({ digestDay: 4, digestHour: 16, digestTop: 3, digestMaxLabel: 'internal' });

        // the feed view and trending exclusions
        await s.feed.createPost(al.ctx, { workspaceId: ws.id, body: 'Close is done #monthendclose #vendorchatter' });
        await s.feed.createPost(bo.ctx, { workspaceId: ws.id, body: 'More #vendorchatter' });
        await s.socialAdmin.exclude(ta.ctx, 'vendorchatter');
        await s.socialAdmin.exclude(ta.ctx, 'vendorchatter');
        await s.feed.digests.trendingJob(tenant.id);
        const feed = await s.socialAdmin.feed(ta.ctx.p);
        expect(feed.counters).toMatchObject({ postsToday: 2, held: 0, trendingTags: 1 });
        expect(feed.trending.tags.map((t) => `${t.tag}:${t.excluded}`)).toEqual(['monthendclose:false', 'vendorchatter:true']);

        // groups: defaults, the admin view, a revoked feed, transfer and archive
        const g = await s.groups.create(al.ctx, { workspaceId: ws.id, name: 'Month-end close' });
        expect(g).toMatchObject({ visibility: 'public', joinMode: 'open' });
        await s.groups.join(bo.ctx, g.id);
        const f = await s.calendar.createFeed(bo.ctx, { kind: 'group', targetId: g.id });
        const [, id, sig] = /\/calendar\/feeds\/([^/]+)\/([^.]+)\.ics$/.exec(f.url!)!;
        expect(await s.calendar.renderFeed(id!, sig!)).not.toBeNull();
        const view = await s.socialAdmin.groups(ta.ctx.p);
        expect(view.groups.find((x) => x.id === g.id)).toMatchObject({ members: 2, pending: 0, upcomingEvents: 0, openReports: 0, feeds: 1 });
        expect(view.feeds.map((x) => x.id)).toContain(f.id);
        await s.calendar.revokeFeed(ta.ctx, f.id, { admin: true });
        expect(await s.calendar.renderFeed(id!, sig!)).toBeNull();
        await s.groups.transferOwnership(ta.ctx, g.id, bo.u.id);
        expect((await s.groups.members(bo.ctx.p, g.id)).map((m) => `${m.username}:${m.role}`).sort()).toEqual(['al:moderator', 'bo:owner']);
        await s.groups.archive(ta.ctx, g.id);
        await expect(s.feed.createPost(bo.ctx, { groupId: g.id, body: 'Late' })).rejects.toMatchObject({ status: 409 });

        // messaging and a dual-control export
        const conv = await s.messaging.direct(al.ctx, bo.u.id);
        await s.messaging.send(al.ctx, conv.conversation.id, { body: 'Preserve this thread' });
        expect((await s.socialAdmin.conversations(ta.ctx.p)).map((c) => c.id)).toContain(conv.conversation.id);
        const m = await s.socialAdmin.messaging(ta.ctx.p);
        expect(m.relations).toMatchObject({ blocks: 0, mutedConversations: 0, exported: 0 });
        const x = await s.socialAdmin.requestExport(ta.ctx, { conversationId: conv.conversation.id, reason: 'Case LH-1: preservation notice', approverId: sa.u.id });
        await expect(s.socialAdmin.decideExport(ta.ctx, x.id, 'approved', null)).rejects.toMatchObject({ status: 403 });
        await s.socialAdmin.decideExport(sa.ctx, x.id, 'approved', null);
        expect(await s.socialAdmin.exportJob(x.id)).toMatchObject({ messages: 1 });
        const out = await s.socialAdmin.download(ta.ctx, x.id);
        expect(out.csv.toString('utf8')).toContain('Preserve this thread');

        // relations
        await s.social.block({ p: al.ctx.p, ip: null }, bo.u.id);
        const rel = await s.socialAdmin.relations(ta.ctx.p);
        expect(rel.counts).toMatchObject({ blocks: 1 });
        expect(rel.mostBlocked[0]).toMatchObject({ userId: bo.u.id, blockedBy: 1, workspace: 'Finance Ops', sanction: null });
      } finally {
        await s.close();
        await db.destroy();
      }
    });
  });
}
