/*
 * 1.6.0, Sprint 39a against real databases. Each block runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 041_provenance_artifacts; B-8001: an answer's fenced blocks become
 *                                  artifacts (mediumtext content sealed with the tenant key, bigint timestamps), a
 *                                  changed block adds a version, the transcript view lists the versions of the shown
 *                                  messages, a render token opens one; B-7901: a tenant without an issuing CA gets a
 *                                  reason rather than a signer.
 */
import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { testConfig } from '../helpers.js';

const PAGE = (greeting: string) => `<!doctype html>\n<html><body><h1>${greeting}</h1><p>${'x'.repeat(200)}</p></body></html>`;

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`Sprint 39a on ${d.name}`, () => {
    it('migrates 041_provenance_artifacts; versions artifacts from answers; opens a version by token; reports a missing CA', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        for (const t of ['pki_content_signers', 'chat_artifacts', 'chat_artifact_versions']) expect(await db.schema.hasTable(t), t).toBe(true);
        expect(await db.schema.hasColumn('image_jobs', 'c2pa')).toBe(true);
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const u = await s.users.create(tenant.id, { username: 'owner', displayName: 'OWNER', clearance: 'internal' });
        await s.users.setRoles(u.id, 'direct', ['member']);
        const p = (await loadPrincipal(s, tenant.id, u.id, {}))!;

        // A conversation with two answers, as the chat service stores them (sealed content, a linear path).
        const now = Date.now();
        const conv = ulid();
        const ids = [ulid(), ulid(), ulid(), ulid()];
        const seal = (id: string, text: string) => s.keys.seal(tenant.id, text, `content:${id}`);
        await db('conversations').insert({ id: conv, tenant_id: tenant.id, workspace_id: null, user_id: u.id, kind: 'chat', title: await s.keys.seal(tenant.id, 'Page', `title:${conv}`), label: 'internal', profile_id: null, head_id: ids[3], created_at: now, updated_at: now });
        const row = async (id: string, parent: string | null, role: 'user' | 'assistant', text: string, seq: number) =>
          db('messages').insert({ id, conversation_id: conv, tenant_id: tenant.id, parent_id: parent, role, content: await seal(id, text), state: 'complete', label: 'internal', seq, canary: false, created_at: now + seq, completed_at: now + seq });
        await row(ids[0]!, null, 'user', 'A page that says Hello', 0);
        await row(ids[1]!, ids[0]!, 'assistant', `Here.\n\n\`\`\`html index.html\n${PAGE('Hello')}\n\`\`\``, 1);
        await row(ids[2]!, ids[1]!, 'user', 'Now Goodbye', 2);
        await row(ids[3]!, ids[2]!, 'assistant', `Done.\n\n\`\`\`html index.html\n${PAGE('Goodbye')}\n\`\`\``, 3);
        const ev = (messageId: string) => ({ principal: p, tenantId: tenant.id, workspaceId: null, conversationId: conv, userMessageId: null, messageId, state: 'complete', label: 'internal' as const });
        await s.chatArtifacts.onAnswer(ev(ids[1]!));
        await s.chatArtifacts.onAnswer(ev(ids[3]!));
        await s.chatArtifacts.onAnswer(ev(ids[3]!)); // again: the same content adds no version

        const all = await s.chatArtifacts.forTranscript(conv, [ids[1]!, ids[3]!], 'internal');
        expect(all.map((a) => [a.key, a.kind, a.versions.map((v) => v.version)])).toEqual([['index.html', 'html', [1, 2]]]);
        expect(await s.chatArtifacts.forTranscript(conv, [ids[1]!], 'internal')).toMatchObject([{ versions: [{ version: 1 }] }]);
        expect(await s.chatArtifacts.forTranscript(conv, [ids[1]!, ids[3]!], 'public')).toEqual([]);
        const stored = await db('chat_artifact_versions').where({ artifact_id: all[0]!.id, version: 2 }).first();
        expect(String(stored.content)).toMatch(/^v2\./);
        expect(Number(stored.bytes)).toBe(Buffer.byteLength(PAGE('Goodbye')));

        const v1 = await s.chatArtifacts.version(p, conv, all[0]!.id, 1);
        expect(v1.content).toBe(PAGE('Hello'));
        const token = decodeURIComponent(new URL(all[0]!.versions[1]!.rawUrl, 'http://x').searchParams.get('t')!);
        expect((await s.chatArtifacts.raw(token))?.content).toBe(PAGE('Goodbye'));
        expect(await s.chatArtifacts.raw(token.slice(0, -1))).toBeNull();

        // B-7901: no issuing CA, so no signer, and the reason names it.
        const signer = await s.pki.contentSigner(tenant.id);
        expect(signer.signer).toBeNull();
        expect((signer as { reason: string }).reason).toContain('issuing CA');
      } finally {
        await db.destroy();
      }
    }, 120_000);
  });
}
