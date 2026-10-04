/*
 * Sprint 26 (B-1901 to B-1905): moderation on PostgreSQL and MySQL. Two instances share one database: the same object
 * checked on both at once makes one flag (the generation claim), a long AT-Protocol URI is flagged under its hash, a
 * block hides the object and an upheld appeal restores it, a sanction made on one instance is enforced by the other
 * and ended by the sweep, and a routed flag past its SLA escalates once.
 */
import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { ModerationService, type ModCtx } from '../../src/moderation/service.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import type { Principal } from '../../src/authz/policy.js';
import { testConfig } from '../helpers.js';

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`Moderation on ${d.name}`, () => {
    it('makes one flag per object across instances, hides and restores, enforces sanctions and escalates', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url!, MODERATION_SWEEP_SECONDS: '0' });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const one = createServices(cfg, db, createLogger('silent', false), new Metrics());
      const two = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        await bootstrap(one);
        const tenant = (await one.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const ws = await one.tenants.createWorkspace(tenant.id, 'Community', 'confidential', { visibility: 'members' });
        const mk = async (username: string, roles: string[]) => {
          const u = await one.users.create(tenant.id, { username, displayName: username, clearance: 'confidential' });
          await one.users.update(tenant.id, u.id, { clearance_direct: 'confidential' });
          await one.users.setRoles(u.id, 'direct', roles);
          await one.tenants.addMember(ws.id, u.id);
          return u;
        };
        const admin = await mk('modadmin', ['tenant-admin', 'guardrail-admin']);
        const reviewer = await mk('modreview', ['guardrail-admin']);
        const alice = await mk('alice', ['member']);
        const bob = await mk('bob', ['member']);
        const ctxOf = async (s: typeof one, userId: string): Promise<ModCtx & { principal: Principal }> => {
          const p = (await loadPrincipal(s, tenant.id, userId, {}))!;
          p.workspaceId = ws.id;
          return ModerationService.ctxFor(p, '127.0.0.1') as ModCtx & { principal: Principal };
        };
        const a1 = await ctxOf(one, admin.id);
        const a2 = await ctxOf(two, admin.id);

        // A tenant rule set: a blocked word and a flagged link.
        const set = await one.guard.sets.create(tenant.id, { name: 'Community rules', scope: 'tenant' }, admin.id);
        await one.guard.sets.saveDraft(set, [
          { id: 'forbidden', name: 'Forbidden word', checkpoint: 'user-input', type: 'pattern', mechanism: { kind: 'pattern', pattern: 'FORBIDDENWORD' }, action: 'block', stage: 'enforce', severity: 'high' },
          { id: 'spam-link', name: 'Spam links', checkpoint: 'user-input', type: 'pattern', mechanism: { kind: 'pattern', pattern: 'SPAMLINK' }, action: 'flag', stage: 'enforce', severity: 'medium' }
        ], admin.id);
        await one.guard.sets.publish(await one.guard.sets.get(tenant.id, set.id), admin.id);
        const message = async (text: string) => {
          const t = Date.now();
          const cid = ulid();
          const mid = ulid();
          await db('conversations').insert({ id: cid, tenant_id: tenant.id, workspace_id: ws.id, user_id: alice.id, kind: 'chat', title: null, label: 'internal', created_at: t, updated_at: t });
          await db('messages').insert({ id: mid, conversation_id: cid, tenant_id: tenant.id, role: 'user', content: await one.keys.seal(tenant.id, text, `content:${mid}`), state: 'complete', label: 'internal', created_at: t, seq: 0 });
          return mid;
        };

        // B-1901: one object checked on both instances at once, twice over: one flag.
        const m1 = await message('see SPAMLINK now');
        const results = await Promise.all([one.moderation.check(a1, { type: 'message', id: m1 }), two.moderation.check(a2, { type: 'message', id: m1 }), one.moderation.check(a1, { type: 'message', id: m1 }), two.moderation.check(a2, { type: 'message', id: m1 })]);
        expect(new Set(results.map((r) => r.flag?.id)).size).toBe(1);
        expect(results.filter((r) => r.flag?.created)).toHaveLength(1);
        expect((await db('guard_flags').where({ tenant_id: tenant.id, source_id: m1 })).length).toBe(1);

        // A long AT-Protocol URI, not registered: flagged under its hash, deduplicated.
        const uri = `at://did:plc:${'x'.repeat(40)}/app.bsky.feed.post/${'y'.repeat(60)}`;
        const u1 = await one.moderation.check(a1, { type: 'atproto-post', id: uri, text: 'SPAMLINK', workspaceId: ws.id });
        const u2 = await two.moderation.check(a2, { type: 'atproto-post', id: uri, text: 'SPAMLINK', workspaceId: ws.id });
        expect(u2.flag!.id).toBe(u1.flag!.id);
        expect((await db('guard_flags').where({ id: u1.flag!.id }).first()).source_id).toMatch(/^h:[0-9a-f]{64}$/);

        // B-1903: a block hides the message; an upheld appeal (by another reviewer) restores it and reopens the flag.
        const m2 = await message('the FORBIDDENWORD');
        const blocked = await one.moderation.check(a1, { type: 'message', id: m2 });
        expect(blocked.action).toMatchObject({ action: 'hide', state: 'applied' });
        expect((await db('messages').where({ id: m2 }).first()).state).toBe('hidden');
        await one.guard.flags.decide(a1.principal, blocked.flag!.id, [ws.id], 'confirmed', 'yes');
        const appeal = await two.moderation.appeal(await ctxOf(two, alice.id), { actionId: blocked.action!.id, statement: 'a quotation' });
        const decided = await two.moderation.decideAppeal(await ctxOf(two, reviewer.id), appeal.ref, 'upheld', null);
        expect(decided.effects).toMatchObject({ restored: true, flagReopened: blocked.flag!.ref });
        expect((await db('messages').where({ id: m2 }).first()).state).toBe('complete');

        // B-1904: a suspension made on one instance keeps the user out on the other; the sweep ends it. (Without Redis
        // each instance caches its answer for the short tier; these two share no bus, so bob is not looked up first.)
        const sanction = await one.moderation.sanction(a1, { userId: bob.id, kind: 'suspend', durationMinutes: 30, reason: 'spam' });
        expect(await two.moderation.blocking(tenant.id, bob.id)).toMatchObject({ kind: 'suspend', id: sanction.id });
        expect(await loadPrincipal(two, tenant.id, bob.id, {})).toBeNull();
        await db('moderation_sanctions').where({ id: sanction.id }).update({ ends_at: Date.now() - 1000 });
        expect((await two.moderation.sweep(tenant.id)).expired).toBe(1);
        expect(await two.moderation.blocking(tenant.id, bob.id)).toBeNull();
        expect((await db('moderation_sanctions').where({ id: sanction.id }).first()).state).toBe('expired');

        // B-1905: a routed flag past its SLA escalates once, whichever instance sweeps.
        const q = await one.moderation.saveQueue(a1, null, { name: 'Spam', rules: ['spam-link'], slaMinutes: 5, escalateTo: 'tenant' });
        const m3 = await message('more SPAMLINK');
        const routed = await one.moderation.check(a1, { type: 'message', id: m3 });
        expect(routed.flag!.queueId).toBe(q.id);
        await db('guard_flags').where({ id: routed.flag!.id }).update({ due_at: Date.now() - 60_000 });
        const swept = await Promise.all([one.moderation.sweep(tenant.id), two.moderation.sweep(tenant.id)]);
        expect(swept[0].escalated + swept[1].escalated).toBe(1);
        expect((await db('guard_flags').where({ id: routed.flag!.id }).first()).escalated_to).toBe('tenant');
      } finally {
        await one.close();
        await two.close();
        await db.destroy();
      }
    }, 120_000);
  });
}
