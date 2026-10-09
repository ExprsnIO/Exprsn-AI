/*
 * 1.7.0, Sprint 40a against real databases. Each block runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 042_chat_invocation; a conversation's skills (text JSON), a tool turn
 *                                  (`messages.turn`, `invocation_id`), a card row with sealed arguments and bigint
 *                                  expiry that the sweep expires, and a profile's agents and skills lists round-trip.
 */
import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { testConfig } from '../helpers.js';

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`Sprint 40a on ${d.name}`, () => {
    it('migrates 042_chat_invocation; stores a tool turn and a card; expires the card; keeps a profile\'s agents and skills', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        expect(await db.schema.hasTable('chat_invocations')).toBe(true);
        for (const [t, c] of [['messages', 'turn'], ['messages', 'invocation_id'], ['conversations', 'skills'], ['profiles', 'agents'], ['profiles', 'skills']] as const) expect(await db.schema.hasColumn(t, c), `${t}.${c}`).toBe(true);
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const u = await s.users.create(tenant.id, { username: 'owner', displayName: 'OWNER', clearance: 'internal' });
        await s.users.setRoles(u.id, 'direct', ['member']);

        const now = Date.now();
        const conv = ulid();
        await db('conversations').insert({ id: conv, tenant_id: tenant.id, workspace_id: null, user_id: u.id, kind: 'chat', title: await s.keys.seal(tenant.id, 'Tools', `title:${conv}`), label: 'internal', head_id: null, created_at: now, updated_at: now, archived_at: null, skills: JSON.stringify([{ name: 'Tone', mode: 'sticky' }]) });
        const c = (await s.chat.conversationRow(tenant.id, conv))!;
        expect(s.chatInvocations.skillsOf(c)).toEqual([{ name: 'Tone', mode: 'sticky' }]);

        // A tool turn, as a call records it: the head moves to it and the view shows the turn.
        const inv = ulid();
        const turn = await s.chat.appendTurn(c, { parentId: null, turn: 'tool', name: 'jira.lookup_invoice', invocationId: inv, content: 'Called jira.lookup_invoice.', tools: [{ name: 'jira.lookup_invoice', expression: '{"number":"INV-7"}', output: { total: 1188 } }], label: 'internal', state: 'complete' });
        const stored = await db('messages').where({ id: turn.id }).first();
        expect(stored).toMatchObject({ turn: 'tool', invocation_id: inv, state: 'complete', profile_name: 'jira.lookup_invoice' });
        expect(String(stored.tools)).toMatch(/^v2\./);
        expect((await db('conversations').where({ id: conv }).first()).head_id).toBe(turn.id);

        // A card past its expiry, sealed arguments, bigint times.
        await db('chat_invocations').insert({ id: inv, tenant_id: tenant.id, conversation_id: conv, user_id: u.id, kind: 'tool', name: 'jira.create_issue', entry_id: null, version: '1', side_effect: 'write', proposed_by: 'user', arguments: await s.keys.seal(tenant.id, JSON.stringify({ summary: 'x' }), `chat-invocation:${inv}:arguments`), state: 'awaiting', approval: 'owner', expires_at: now - 1000, label: 'internal', created_at: now, updated_at: now });
        expect(await s.chatInvocations.expireCards(tenant.id)).toBe(1);
        const after = await db('chat_invocations').where({ id: inv }).first();
        expect(after.state).toBe('expired');
        expect(Number(after.expires_at)).toBe(now - 1000);
        expect(String(after.arguments)).not.toContain('summary');

        // A profile's agents and skills lists round-trip through the repo.
        const pool = await s.gateway.repo.createPool({ name: 'p', accelerator: 'cuda', zone: 'inference', labelCeiling: 'internal' });
        const pid = ulid();
        await s.gateway.repo.createProfile({ id: pid, tenant_id: tenant.id, name: 'helper', display_name: 'Helper', description: null, alias_of: null, model_id: null, pool_id: pool.id, num_ctx: null, temperature: null, think_default: 'off', think_ceiling: 'off', system_prompt: null, fallback: null, canary: null, tools: ['calculate'], agents: ['Clerk'], skills: ['Tone'], label: 'internal', status: 'draft', version: 1, updated_by: null, created_at: now, updated_at: now });
        const prof = (await s.gateway.repo.profile(tenant.id, pid))!;
        expect(prof.agents).toEqual(['Clerk']);
        expect(prof.skills).toEqual(['Tone']);
        await s.gateway.repo.updateProfile(tenant.id, pid, { skills: null });
        expect((await s.gateway.repo.profile(tenant.id, pid))!.skills).toBeNull();
      } finally {
        await db.destroy();
      }
    }, 120_000);
  });
}
