/*
 * Sprint 27c (1.4.0), groups and events, against real databases. Each block runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 029c_groups; a group with a request and an invitation (one pending per
 *                                  user, enforced by the unique key); posts sealed; an event with RSVPs; a reminder
 *                                  claimed by two instances, each with its own connection pool, polling at once (one
 *                                  sends it); cancelling notifies the attendees; a signed feed renders and a bad
 *                                  signature does not
 */
import { describe, expect, it, vi } from 'vitest';
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
  describe.skipIf(!d.url)(`groups and events on ${d.name}`, () => {
    it('migrates 029c_groups and runs groups, requests, posts, events, reminders on one instance, and feeds', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      // a second instance: its own pool, job queue and bus, the same database
      const db2 = createDb(cfg);
      const s2 = createServices(cfg, db2, createLogger('silent', false), new Metrics());
      try {
        expect(await db.schema.hasTable('group_event_reminders')).toBe(true);
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
        const owner = await person('gia');
        const ben = await person('ben');
        const cy = await person('cy');

        const g = await s.groups.create(owner.ctx, { workspaceId: ws.id, name: 'Letterpress', description: 'Ink & paper', visibility: 'private', joinMode: 'request' });
        const asked = await s.groups.join(ben.ctx, g.id);
        expect('requested' in asked && asked.request.state).toBe('pending');
        // one pending request or invitation per user and group, held by the unique key
        await expect(s.groups.invite(owner.ctx, g.id, ben.u.id, 'member')).rejects.toMatchObject({ status: 409 });
        await s.groups.decide(owner.ctx, (asked as { request: { id: string } }).request.id, 'accept');
        const inv = await s.groups.invite(owner.ctx, g.id, cy.u.id, 'member');
        await s.groups.decide(cy.ctx, inv.id, 'accept');
        expect((await s.groups.members(owner.ctx.p, g.id)).map((m) => m.role).sort()).toEqual(['member', 'member', 'owner']);

        const post = await s.groups.createPost(ben.ctx, g.id, 'A proof of the new face');
        expect(String((await db('group_posts').where({ id: post.id }).first()).body)).not.toContain('proof');
        expect((await s.groups.posts(cy.ctx.p, g.id, {}))[0]!.body).toBe('A proof of the new face');

        const start = Date.now() + 2 * 3_600_000;
        const ev = await s.calendar.create(owner.ctx, g.id, { title: 'Print day', start: new Date(start).toISOString(), timeZone: 'America/Chicago', reminders: [60], capacity: 10 });
        await s.calendar.rsvp(ben.ctx, ev.id, { response: 'going', guests: 0 });
        await s.calendar.rsvp(cy.ctx, ev.id, { response: 'maybe' });
        const reminder = (await db('group_event_reminders').where({ event_id: ev.id }).first()) as { id: string; fire_at: number | string };

        const a = vi.spyOn(s.calendar, 'fireReminder');
        const b = vi.spyOn(s2.calendar, 'fireReminder');
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Number(reminder.fire_at) + 1000);
        try {
          await Promise.all([s.jobs.runDue(), s2.jobs.runDue(), s.jobs.runDue(), s2.jobs.runDue()]);
        } finally {
          vi.useRealTimers();
        }
        expect(a.mock.calls.length + b.mock.calls.length).toBe(1);
        expect(await db('group_event_reminders').where({ id: reminder.id }).first()).toMatchObject({ state: 'sent', recipients: 2 });
        expect(await db('notifications').where({ tenant_id: tenant.id, kind: 'event.reminder' })).toHaveLength(2);

        const feed = await s.calendar.createFeed(ben.ctx, { kind: 'group', targetId: g.id });
        const [, id, sig] = /\/calendar\/feeds\/([^/]+)\/([^.]+)\.ics$/.exec(feed.url!)!;
        expect((await s.calendar.renderFeed(id!, sig!))?.body).toContain('SUMMARY:Print day');
        expect(await s.calendar.renderFeed(id!, sig!.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')))).toBeNull();

        const out = await s.calendar.cancel(owner.ctx, ev.id, null);
        expect(out.notified).toBe(2);
        expect(await db('notifications').where({ tenant_id: tenant.id, kind: 'event.cancelled' })).toHaveLength(2);
      } finally {
        await s2.close();
        await db2.destroy();
        await s.close();
        await db.destroy();
      }
    });
  });
}
