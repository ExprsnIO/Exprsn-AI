import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as m144 from '../src/db/migrations/144_knowledge_document_creator.js';
import { forgetDefaultWorkspace } from '../src/tenancy/default-workspace.js';
import { forgetUsageAttribution } from '../src/tenancy/usage-attribution.js';
import { FakeOllama } from './fake-ollama.js';
import type { Harness } from './helpers.js';
import { client, drain, harnessWith, seedRetrieval } from './retrieval-seed.js';

/*
 * QA-1 (migration 144_knowledge_document_creator, not registered yet): a knowledge document records who uploaded it,
 * and indexing it again later (a reindex of the base) is metered for that person, not for whoever added the base's
 * upload source. Without the column the build behaves as before (the source's creator).
 */

interface UsageRow {
  user_id: string | null;
  workspace_id: string | null;
}

describe('knowledge documents: created_by and the attribution of reindexing', () => {
  let h: Harness;
  let ollama: FakeOllama;

  beforeEach(async () => {
    ollama = await new FakeOllama().start();
    ollama.chatDelayMs = 0;
    h = await harnessWith({}, { OLLAMA_POLL_MS: '600000' });
    await seedRetrieval(h, ollama);
    forgetUsageAttribution(h.s.db);
    forgetDefaultWorkspace(h.s.db);
  }, 60_000);
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  const usage = async (): Promise<UsageRow[]> => (await h.s.db('usage_records').where({ tenant_id: h.tenantId, kind: 'embed' })) as UsageRow[];
  const fresh = async () => {
    await h.s.db('usage_records').delete();
    await h.s.db('embedding_cache').delete();
  };
  const upload = (c: Awaited<ReturnType<typeof client>>, kbId: string, name: string, text: string) =>
    c.agent.put(`/api/knowledge/bases/${kbId}/uploads?name=${encodeURIComponent(name)}&label=public`).set('x-csrf-token', c.csrf).set('content-type', 'application/octet-stream').send(Buffer.from(text));

  /** Two curators upload one document each; the first upload creates the base's upload source (as Ana). */
  async function twoUploads() {
    const ana = await client(h, 'ana', ['member', 'knowledge-curator'], 'confidential');
    const bo = await client(h, 'bo', ['member', 'knowledge-curator'], 'confidential');
    const kb = (await ana.post('/api/knowledge/bases', { name: 'Handbook', label: 'internal', embedModel: 'nomic-embed-text', workspaceId: null }).expect(201)).body;
    await ana.post(`/api/knowledge/bases/${kb.id}/access`, { kind: 'user', id: bo.user.id, access: 'manage' }).expect(201);
    await upload(ana, kb.id, 'travel.md', '# Travel\n\nTrains are booked in second class.').expect(202);
    await upload(bo, kb.id, 'meals.md', '# Meals\n\nMeals are covered up to 40 EUR a day.').expect(202);
    await drain(h);
    return { ana, bo, kb };
  }

  it('records the uploader and meters a later reindex of the base per document, for its uploader', async () => {
    if (!(await h.s.db.schema.hasColumn('knowledge_documents', 'created_by'))) await m144.up(h.s.db);
    const { ana, bo, kb } = await twoUploads();
    const docs = (await h.s.db('knowledge_documents').where({ kb_id: kb.id }).select('name', 'created_by', 'state')) as { name: string; created_by: string | null; state: string }[];
    expect(Object.fromEntries(docs.map((d) => [d.name, d.created_by]))).toEqual({ 'travel.md': ana.user.id, 'meals.md': bo.user.id });
    expect(docs.every((d) => d.state === 'indexed')).toBe(true);

    // A reindex of the whole base runs in the background: each document's embeddings are for whoever uploaded it.
    await fresh();
    await ana.post(`/api/knowledge/bases/${kb.id}/reindex`, {}).expect((r) => expect(r.status).toBeLessThan(300));
    await drain(h);
    const rows = await usage();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(new Set(rows.map((r) => r.user_id))).toEqual(new Set([ana.user.id, bo.user.id]));
  });

  it('without the column (144 not applied), uploads still work and a reindex credits the source\'s creator', async () => {
    if (await h.s.db.schema.hasColumn('knowledge_documents', 'created_by')) await m144.down(h.s.db);
    expect(await h.s.knowledge.hasDocumentCreator()).toBe(false);
    const { ana, kb } = await twoUploads();
    expect((await h.s.db('knowledge_documents').where({ kb_id: kb.id })).length).toBe(2);
    await fresh();
    await ana.post(`/api/knowledge/bases/${kb.id}/reindex`, {}).expect((r) => expect(r.status).toBeLessThan(300));
    await drain(h);
    const rows = await usage();
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(new Set(rows.map((r) => r.user_id))).toEqual(new Set([ana.user.id]));
  });

  it('migration 144 goes up and down and up again', async () => {
    const db = h.s.db;
    await m144.up(db);
    await m144.up(db);
    expect(await db.schema.hasColumn('knowledge_documents', 'created_by')).toBe(true);
    await m144.down(db);
    await m144.down(db);
    expect(await db.schema.hasColumn('knowledge_documents', 'created_by')).toBe(false);
    await m144.up(db);
    expect(await db.schema.hasColumn('knowledge_documents', 'created_by')).toBe(true);
  });
});
