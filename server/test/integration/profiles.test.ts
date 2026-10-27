/*
 * Sprint 34c (1.5.0), profiles and presence, against real databases. Each block runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 036b_profiles; a profile saved and read by workspace and clearance; an
 *                                  avatar through the file store's quarantine, served once ready; presence counted
 *                                  across two instances (each its own pool and connection rows), idle on both reads
 *                                  away, a chosen busy published once although both instances race to publish it, a
 *                                  blocked person left out, and the rows of an instance that went away swept
 */
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { collect } from '../../src/files/crypt.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { TOPICS } from '../../src/platform/bus.js';
import type { PresenceEvent } from '../../src/profiles/presence.js';
import { createServices } from '../../src/services.js';
import { testConfig } from '../helpers.js';
import { TINY_PNG } from '../sprint26d-fakes.js';

async function* bytes(b: Buffer) {
  yield b;
}

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`profiles and presence on ${d.name}`, () => {
    it('migrates 036b_profiles and runs profiles, an avatar through quarantine and presence across two instances', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      const db2 = createDb(cfg);
      const s2 = createServices(cfg, db2, createLogger('silent', false), new Metrics());
      const drain = async () => {
        for (let i = 0; i < 20; i++) if (!(await s.jobs.runDue())) return;
      };
      try {
        for (const t of ['user_profiles', 'user_presence', 'presence_connections']) expect(await db.schema.hasTable(t)).toBe(true);
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const ws = await s.tenants.createWorkspace(tenant.id, 'Studio', 'confidential');
        const person = async (username: string, clearance: 'internal' | 'confidential' = 'internal') => {
          const u = await s.users.create(tenant.id, { username, displayName: username.toUpperCase(), clearance });
          await s.users.update(tenant.id, u.id, { clearance_direct: clearance });
          await s.users.setRoles(u.id, 'direct', ['member']);
          await s.tenants.addMember(ws.id, u.id);
          const p = (await loadPrincipal(s, tenant.id, u.id, {}))!;
          p.workspaceId = ws.id;
          return { u, p, ctx: { p, ip: null } };
        };
        const ann = await person('ann', 'confidential');
        const ben = await person('ben');
        const cy = await person('cy');

        // a profile, narrowed by label
        await s.people.update(ann.ctx, { pronouns: 'she/her', bio: 'Letterpress.', label: 'confidential', workspaces: [ws.id] });
        expect((await db('user_profiles').where({ user_id: ann.u.id }).first()).workspaces).toContain(ws.id);
        expect(await s.people.view(ben.p, ann.u.id)).toMatchObject({ limited: 'clearance', avatar: null });
        await s.people.update(ann.ctx, { label: 'internal' });
        expect(await s2.people.view(ben.p, ann.u.id)).toMatchObject({ limited: null, bio: 'Letterpress.', pronouns: 'she/her' });

        // an avatar through the file store's quarantine
        await s.people.setAvatar(ann.ctx, { declaredType: 'image/png', declaredBytes: TINY_PNG.length }, bytes(TINY_PNG));
        expect((await s.people.own(ann.p)).avatar).toMatchObject({ state: 'quarantined', url: null });
        await expect(s.people.avatar(ben.p, ann.u.id)).rejects.toMatchObject({ status: 404 });
        await drain();
        expect((await s.people.own(ann.p)).avatar).toMatchObject({ state: 'ready' });
        const img = await s2.people.avatar(ben.p, ann.u.id);
        expect((await collect(img.stream)).equals(TINY_PNG)).toBe(true);

        // presence across two instances
        const events: PresenceEvent[] = [];
        s.bus.on<PresenceEvent>(TOPICS.presence, (e) => void events.push(e));
        s2.bus.on<PresenceEvent>(TOPICS.presence, (e) => void events.push(e));
        await s.social.block(cy.ctx, ann.u.id);
        await s.presence.connected(tenant.id, ann.u.id, 'sock-1');
        await s2.presence.connected(tenant.id, ann.u.id, 'sock-2');
        expect(await db('presence_connections').where({ user_id: ann.u.id })).toHaveLength(2);
        expect(await s2.presence.statuses(ben.p, [ann.u.id, cy.u.id])).toEqual({ [ann.u.id]: 'available', [cy.u.id]: 'offline' });
        // cy is in a block with ann: nothing about her
        expect(await s.presence.statuses(cy.p, [ann.u.id])).toEqual({});
        await s.presence.activity(tenant.id, ann.u.id, 'sock-1', true);
        expect((await s.presence.effective(tenant.id, [ann.u.id])).get(ann.u.id)).toBe('available');
        await s2.presence.activity(tenant.id, ann.u.id, 'sock-2', true);
        expect((await s.presence.effective(tenant.id, [ann.u.id])).get(ann.u.id)).toBe('away');

        // busy, and both instances race to publish it: one wins
        await db('user_presence').where({ tenant_id: tenant.id, user_id: ann.u.id }).update({ status: 'busy' });
        const before = events.length;
        await Promise.all([s.presence.publishIfChanged(tenant.id, ann.u.id), s2.presence.publishIfChanged(tenant.id, ann.u.id)]);
        const busy = events.slice(before).filter((e) => e.status === 'busy');
        expect(busy).toHaveLength(1);
        expect(busy[0]!.exceptUserIds).toEqual([cy.u.id]);
        expect(await s.presence.setStatus(ann.ctx, 'busy')).toEqual({ status: 'busy', effective: 'busy' });

        // the second instance goes away without closing: its row expires and the sweep keeps her on the first
        await db2('presence_connections').where({ instance_id: s2.presence.instanceId }).update({ seen_at: Date.now() - 600_000 });
        await s.presence.heartbeat();
        expect(await db('presence_connections').where({ user_id: ann.u.id })).toHaveLength(1);
        await s.presence.disconnected(tenant.id, ann.u.id, 'sock-1');
        expect((await s.presence.effective(tenant.id, [ann.u.id])).get(ann.u.id)).toBe('offline');
        expect(events.at(-1)).toMatchObject({ userId: ann.u.id, status: 'offline' });
        expect(await db('audit_events').where({ tenant_id: tenant.id, action: 'profile.updated' })).toHaveLength(2);
      } finally {
        await s2.close();
        await s.close();
        await db2.destroy();
        await db.destroy();
      }
    });
  });
}
