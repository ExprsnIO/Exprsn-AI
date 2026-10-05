/*
 * Sprint 30 (1.5.0), model-based memory management, against real databases. Each block runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 032c_memory; the tenant's memory settings; a chat turn's proposals from the
 *                                  memory profile, and the rules when it fails; two near-duplicates become one merge
 *                                  proposal that changes nothing until accepted, then retires both with links; a
 *                                  model change reindexes every memory while recall answers by recency
 */
import { describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { FakeOllama } from '../fake-ollama.js';
import { testConfig, type Harness } from '../helpers.js';
import { seedRetrieval } from '../retrieval-seed.js';

type Msg = { role: string; content: string };

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`model-based memory management on ${d.name}`, () => {
    it('migrates 032c_memory and runs extraction, consolidation and reindex', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url!, OLLAMA_POLL_MS: '600000' });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      const ollama = await new FakeOllama().start();
      ollama.chatDelayMs = 0;
      try {
        expect(await db.schema.hasTable('memory_settings')).toBe(true);
        expect(await db.schema.hasColumn('memories', 'superseded_by')).toBe(true);
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const { general } = await seedRetrieval({ s, tenantId: tenant.id } as Harness, ollama);
        const user = await s.users.create(tenant.id, { username: 'mara', displayName: 'MARA', clearance: 'confidential' });
        await s.users.update(tenant.id, user.id, { clearance_direct: 'confidential' });
        await s.users.setRoles(user.id, 'direct', ['member', 'knowledge-curator']);
        const p = (await loadPrincipal(s, tenant.id, user.id, {}))!;

        // settings
        expect(await s.memory.settings(tenant.id)).toMatchObject({ profile: null, effectiveEmbedModel: 'bge-m3', similarity: 0.85, reindex: { state: 'idle' } });
        await s.memory.setSettings(p, null, 'trace', { profile: 'general' });

        // a chat turn: the profile proposes; when it fails, the rules do
        const conv = ulid();
        await db('conversations').insert({ id: conv, tenant_id: tenant.id, user_id: user.id, workspace_id: null, kind: 'chat', title: null, label: 'internal', created_at: Date.now(), updated_at: Date.now() });
        const say = async (text: string) => {
          const id = ulid();
          await db('messages').insert({ id, tenant_id: tenant.id, conversation_id: conv, role: 'user', content: await s.keys.seal(tenant.id, text, `content:${id}`), label: 'internal', state: 'complete', created_at: Date.now() });
          await s.jobs.enqueue({ tenantId: tenant.id, type: 'memory.extract', payload: { messageId: id, conversationId: conv, userId: user.id, workspaceId: null }, maxAttempts: 1 });
          while (await s.jobs.runDue());
        };
        ollama.reply = (m: Msg[]) => (m[0]?.content.includes('propose durable memories') ? { content: '{"memories": [{"text": "Prefers dark charts in reports"}]}' } : { content: 'ok' });
        await say('I like dark charts in my reports.');
        ollama.reply = (m: Msg[]) => (m[0]?.content.includes('propose durable memories') ? { content: 'no' } : { content: 'ok' });
        await say('Remember that the fiscal year starts in April.');
        const proposed = await s.memory.list(p, 'mine');
        expect(proposed.map((x) => x.text).sort()).toEqual(['Prefers dark charts in reports', 'The fiscal year starts in April']);

        // consolidation: two near-duplicates, one merge proposal, nothing changed until accepted
        const a = await s.memory.add(p, { text: 'Prefers tables over prose for variance analysis', scope: 'user', type: 'user', label: 'internal', expiresAt: null });
        const b = await s.memory.add(p, { text: 'Prefers tables over prose in variance analysis', scope: 'user', type: 'user', label: 'internal', expiresAt: null });
        ollama.reply = (m: Msg[]) => (m[0]?.content.startsWith('You compare two memories') ? { content: '{"relation": "same", "merged": "Prefers tables over prose for variance analysis"}' } : { content: 'ok' });
        expect((await s.memory.consolidate(tenant.id)).merges).toBe(1);
        expect((await s.memory.consolidate(tenant.id)).merges).toBe(0);
        const merge = (await db('memories').where({ tenant_id: tenant.id, origin: 'consolidation' })) as { id: string }[];
        expect(merge).toHaveLength(1);
        expect(await db('memories').whereIn('id', [a.id, b.id]).where({ state: 'active', version: 1 })).toHaveLength(2);
        const out = await s.memory.accept(p, merge[0]!.id);
        expect(out.replaced.sort()).toEqual([a.id, b.id].sort());
        expect(await db('memories').whereIn('id', [a.id, b.id]).where({ state: 'superseded', superseded_by: merge[0]!.id })).toHaveLength(2);

        // reindex with another model; recall answers by recency while it is running
        await s.memory.setSettings(p, null, 'trace', { embedModel: 'nomic-embed-text' });
        expect((await s.memory.settings(tenant.id)).reindex.state).toBe('running');
        const ctx = await s.memory.contextFor({ principal: p, tenantId: tenant.id, workspaceId: null, conversationId: conv, messageId: 'm', profile: general, query: 'variance', label: 'internal', ceiling: 'confidential' });
        expect(ctx.length).toBeGreaterThan(0);
        while (await s.jobs.runDue());
        const st = await s.memory.settings(tenant.id);
        expect(st.reindex).toMatchObject({ state: 'done', model: 'nomic-embed-text' });
        const active = (await db('memories').where({ tenant_id: tenant.id, state: 'active' })) as { embed_model: string }[];
        expect(active.length).toBeGreaterThan(0);
        expect(active.every((m) => m.embed_model === 'nomic-embed-text')).toBe(true);
      } finally {
        await ollama.stop();
        await s.close();
        await db.destroy();
      }
    });
  });
}
