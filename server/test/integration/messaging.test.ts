/*
 * Sprint 28b (1.4.0), social relations and messaging, against real databases. Each block runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 030b_social; blocks, mutes, follows and lists; two instances, each with
 *                                  its own connection pool, starting the same direct conversation at once get one
 *                                  conversation (the unique pair key); messages sealed, edited, threaded, reacted to,
 *                                  deleted (a tombstone and an audit entry without the text); keyword search over the
 *                                  keyed-hash terms; a block hides each other's messages; a muted conversation sends
 *                                  no notification
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
  describe.skipIf(!d.url)(`social relations and messaging on ${d.name}`, () => {
    it('migrates 030b_social and runs relations, a raced direct conversation, messages, search, blocks and mutes', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      const db2 = createDb(cfg);
      const s2 = createServices(cfg, db2, createLogger('silent', false), new Metrics());
      try {
        for (const t of ['social_blocks', 'social_lists', 'dm_conversations', 'dm_messages', 'dm_terms']) expect(await db.schema.hasTable(t)).toBe(true);
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const ws = await s.tenants.createWorkspace(tenant.id, 'Studio', 'confidential');
        const person = async (username: string, on = s) => {
          const u = await s.users.create(tenant.id, { username, displayName: username.toUpperCase(), clearance: 'internal' });
          await s.users.update(tenant.id, u.id, { clearance_direct: 'internal' });
          await s.users.setRoles(u.id, 'direct', ['member']);
          await s.tenants.addMember(ws.id, u.id);
          const p = (await loadPrincipal(on, tenant.id, u.id, {}))!;
          p.workspaceId = ws.id;
          return { u, ctx: { p, ip: null } };
        };
        const ann = await person('ann');
        const ben = await person('ben');
        const cy = await person('cy');

        // relations
        await s.social.follow(ann.ctx, ben.u.id);
        await s.social.follow(ben.ctx, ann.u.id);
        await s.social.mute(ann.ctx, cy.u.id, Date.now() + 60_000);
        const list = await s.social.createList(ann.ctx, { name: 'Press' });
        await s.social.addToList(ann.ctx, list.id, ben.u.id);
        await expect(s.social.createList(ann.ctx, { name: 'PRESS' })).rejects.toMatchObject({ status: 409 });
        expect(await s.social.listMembers(tenant.id, ann.u.id, list.id)).toEqual([ben.u.id]);
        expect(await s.social.mutedBy(tenant.id, ann.u.id)).toEqual(new Set([cy.u.id]));

        // two instances race for the same pair
        const benOn2 = { p: (await loadPrincipal(s2, tenant.id, ben.u.id, {}))!, ip: null };
        const [x, y] = await Promise.all([s.messaging.direct(ann.ctx, ben.u.id), s2.messaging.direct(benOn2, ann.u.id)]);
        expect(x.conversation.id).toBe(y.conversation.id);
        expect([x.created, y.created].filter(Boolean)).toHaveLength(1);
        expect(await db('dm_conversations').where({ kind: 'direct' })).toHaveLength(1);

        const g = await s.messaging.createGroup(ann.ctx, { workspaceId: ws.id, title: 'Press week', memberIds: [ben.u.id, cy.u.id] });
        const one = await s.messaging.send(ann.ctx, g.id, { body: 'Paper stock arrives Monday' });
        expect((await db('dm_messages').where({ id: one.id }).first()).body).not.toContain('Paper');
        await s.messaging.send(ben.ctx, g.id, { body: 'Which paper weight?', threadId: one.id });
        await s.messaging.react(cy.ctx, one.id, '👍', true);
        await s.messaging.edit(ann.ctx, one.id, 'Paper stock arrives Tuesday');
        const hits = await s.messagingInsights.search(cy.ctx.p, g.id, { q: 'paper stock', mode: 'keyword' });
        expect(hits[0]!.id).toBe(one.id);

        // a block hides each other's messages; a muted conversation notifies nobody
        await s.social.block(cy.ctx, ann.u.id);
        expect(await s.social.isBlocked(tenant.id, ann.u.id, cy.u.id)).toBe(true);
        expect((await s.messaging.messages(cy.ctx.p, g.id, {})).map((m) => m.id)).not.toContain(one.id);
        await s.messaging.settings(ben.ctx, g.id, { muted: true });
        const before = await db('notifications').where({ user_id: ben.u.id, kind: 'message' });
        await s.messaging.send(ann.ctx, g.id, { body: 'Ink too' });
        expect(await db('notifications').where({ user_id: ben.u.id, kind: 'message' })).toHaveLength(before.length);

        await s.messaging.delete(ann.ctx, one.id);
        expect(await db('dm_messages').where({ id: one.id }).first()).toMatchObject({ state: 'deleted', body: null });
        expect(await db('dm_terms').where({ message_id: one.id })).toHaveLength(0);
        const audit = await db('audit_events').where({ tenant_id: tenant.id, action: 'messaging.message.deleted' });
        expect(audit).toHaveLength(1);
        expect(JSON.stringify(audit)).not.toContain('Paper');
      } finally {
        await s2.close();
        await s.close();
        await db2.destroy();
        await db.destroy();
      }
    });
  });
}
