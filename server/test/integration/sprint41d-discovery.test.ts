/*
 * 1.7.0, Sprint 41d against real databases. Each block runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 043d_discovery; a registry entry's catalogue fields (examples as JSON)
 *                                  round-trip and stay out of the schema hash; publish notices claimed once per
 *                                  person and entry through the unique key (a second announce notifies nobody), the
 *                                  clearance filter, the weekly digest; a dismissal stored once; the profile's
 *                                  suggestions flag as a boolean.
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
  describe.skipIf(!d.url)(`Sprint 41d on ${d.name}`, () => {
    it('migrates 043d_discovery; keeps catalogue fields out of the hash; notifies once per person and entry; digests weekly; stores a dismissal once', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        for (const t of ['catalog_notices', 'catalog_preferences', 'catalog_vectors', 'catalog_dismissals']) expect(await db.schema.hasTable(t), t).toBe(true);
        for (const [t, c] of [['registry_entries', 'purpose'], ['registry_entries', 'examples'], ['registry_entries', 'category'], ['workflows', 'purpose'], ['workflows', 'examples'], ['workflows', 'category'], ['profiles', 'suggestions']] as const) {
          expect(await db.schema.hasColumn(t, c), `${t}.${c}`).toBe(true);
        }
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const ws = await s.tenants.createWorkspace(tenant.id, 'Legal', 'confidential');
        const users = [];
        for (const [name, clearance] of [['author', 'confidential'], ['ines', 'confidential'], ['jo', 'internal'], ['kai', 'confidential']] as const) {
          const u = await s.users.create(tenant.id, { username: name, displayName: name.toUpperCase(), clearance });
          await s.users.update(tenant.id, u.id, { clearance_direct: clearance });
          await s.users.setRoles(u.id, 'direct', ['member', 'tool-admin']);
          await s.tenants.addMember(ws.id, u.id);
          users.push(u);
        }
        const [author, ines, jo, kai] = users as [(typeof users)[0], (typeof users)[0], (typeof users)[0], (typeof users)[0]];
        const p = { kind: 'user' as const, userId: author.id, tenantId: tenant.id, tenantSlug: tenant.slug, username: 'author', displayName: 'AUTHOR', roles: ['member', 'tool-admin'], clearance: 'confidential' as const, scopes: null, sessionId: null, apiKeyId: null, mfa: true, workspaceId: ws.id };

        // Catalogue fields round-trip (examples as JSON) and do not change the schema hash.
        const e = await s.registry.create(p, { kind: 'skill', name: 'concise', version: '1.0.0', description: 'Answers in one sentence.', impl: 'archive', sideEffect: null, label: 'confidential', inputSchema: null, outputSchema: null, definition: { instructions: 'One sentence.', tools: [] }, purpose: 'Short answers.', examples: ['What is the refund window?'], category: 'Writing' });
        const read = (await s.registry.get(tenant.id, e.id))!;
        expect(read).toMatchObject({ purpose: 'Short answers.', examples: ['What is the refund window?'], category: 'Writing' });
        const next = await s.registry.setDiscovery(read, { examples: ['One', 'Two'], category: 'Style' });
        expect((await s.registry.get(tenant.id, e.id))!).toMatchObject({ examples: ['One', 'Two'], category: 'Style', schema_hash: read.schema_hash });
        expect(next.schema_hash).toBe(read.schema_hash);

        // Notices: once per person and entry; nobody below the label; the author excluded.
        await s.discovery.setPreferences({ ...p, userId: kai.id }, 'digest');
        const item = { kind: 'skill' as const, name: 'concise', version: '1.0.0', label: 'confidential' as const, description: 'Answers in one sentence.', scope: [ws.id], exclude: [author.id] };
        expect(await s.discovery.announce(tenant.id, item)).toEqual({ notified: 1, digest: 1, skipped: 0 });
        expect(await s.discovery.announce(tenant.id, item)).toEqual({ notified: 0, digest: 0, skipped: 0 });
        expect(await db('notifications').where({ user_id: ines.id, kind: 'catalog' })).toHaveLength(1);
        expect(await db('notifications').where({ user_id: jo.id, kind: 'catalog' })).toHaveLength(0);
        expect(await db('catalog_notices').where({ tenant_id: tenant.id, entry_key: 'skill:concise' })).toHaveLength(2);
        expect(await s.discovery.sendDigests(tenant.id, Date.now() + 8 * 86_400_000)).toEqual({ digests: 1, entries: 1 });
        expect(await db('notifications').where({ user_id: kai.id, kind: 'catalog' })).toHaveLength(1);

        // A dismissal is stored once.
        const conv = ulid();
        await db('conversations').insert({ id: conv, tenant_id: tenant.id, workspace_id: ws.id, user_id: ines.id, kind: 'chat', title: await s.keys.seal(tenant.id, 'T', `title:${conv}`), label: 'internal', head_id: null, created_at: Date.now(), updated_at: Date.now(), archived_at: null });
        const pi = { ...p, userId: ines.id, username: 'ines' };
        await s.discovery.dismiss(pi, conv, 'skill:concise');
        expect((await s.discovery.dismiss(pi, conv, 'skill:concise')).dismissed).toEqual(['skill:concise']);

        // A vector row per entry version and model.
        await db('catalog_vectors').insert({ tenant_id: tenant.id, entry_key: 'skill:concise', version: '1.0.0', model: 'nomic-embed-text', text_hash: 'h', vector: 'AAAA', created_at: Date.now() });
        expect(await db('catalog_vectors').where({ tenant_id: tenant.id })).toHaveLength(1);

        // The profile's suggestions flag defaults on and reads back as a boolean.
        const pool = await s.gateway.repo.createPool({ name: 'p', accelerator: 'cuda', zone: 'inference', labelCeiling: 'internal' });
        const t = Date.now();
        const row = { id: ulid(), tenant_id: tenant.id, name: 'quiet', display_name: 'Quiet', description: null, alias_of: null, model_id: null, pool_id: pool.id, num_ctx: null, temperature: null, think_default: 'off' as const, think_ceiling: 'off' as const, system_prompt: null, fallback: null, canary: null, tools: [], agents: [], skills: null, label: 'internal' as const, status: 'draft' as const, version: 1, updated_by: null, created_at: t, updated_at: t };
        await s.gateway.repo.createProfile(row);
        expect((await s.gateway.repo.profile(tenant.id, row.id))!.suggestions).toBe(true);
        await s.gateway.repo.updateProfile(tenant.id, row.id, { suggestions: false });
        expect((await s.gateway.repo.profile(tenant.id, row.id))!.suggestions).toBe(false);
      } finally {
        await db.destroy();
      }
    }, 120_000);
  });
}
