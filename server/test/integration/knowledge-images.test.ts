/*
 * Sprint 36c (1.6.0), image classification in Knowledge (B-8801 to B-8805), against real databases. Each block runs
 * when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 038c_knowledge_images (the new columns and knowledge_doc_labels, the
 *                                  knowledge_search built-in); an image upload described by the vision profile and
 *                                  found by its text; a Word document's picture as its part; a vision classifier's
 *                                  image cases counted; labels written by the classify job, filtered in search and
 *                                  in the documents list (boolean hits, float scores, distinct counts), re-written
 *                                  after a new classifier version (found by the JSON column), and following the
 *                                  image's label
 */
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import type { ProfileRow } from '../../src/gateway/repo.js';
import { createApp } from '../../src/http/app.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { FakeOllama, markedPng } from '../fake-ollama.js';
import { testConfig, type Harness } from '../helpers.js';
import { client, drain, seedRetrieval, zip } from '../retrieval-seed.js';

const GB = 1_000_000_000;

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`image classification in Knowledge on ${d.name}`, () => {
    it('migrates 038c_knowledge_images, indexes images and their parts, and stores, filters and re-writes their labels', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url!, OLLAMA_POLL_MS: '600000' });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      const ollama = await new FakeOllama().start();
      ollama.chatDelayMs = 0;
      try {
        expect(await db.schema.hasTable('knowledge_doc_labels')).toBe(true);
        for (const c of ['parent_id', 'media', 'vision', 'safety_score']) expect(await db.schema.hasColumn('knowledge_documents', c)).toBe(true);
        expect(await db.schema.hasColumn('knowledge_bases', 'image_classifiers')).toBe(true);
        expect(await db.schema.hasColumn('eval_cases', 'media_key')).toBe(true);
        expect(await db('registry_entries').where({ name: 'knowledge_search', impl: 'builtin' }).first('id')).toBeTruthy();
        await bootstrap(s);
        const h: Harness = { s, app: createApp(s), tenantId: (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!.id, close: async () => undefined };
        const { pool } = await seedRetrieval(h, ollama);
        const repo = s.gateway.repo;
        ollama.addAvailable({ name: 'gemma3:12b', size: 8 * GB, capabilities: ['completion', 'vision'] });
        const m = await repo.createModel({ name: 'gemma3:12b', source: 'Ollama library', expectedDigest: null, license: { name: 'test' }, label: 'confidential', notes: null, requestedBy: 'x', requestedTenant: h.tenantId });
        await repo.updateModel(m.id, { state: 'approved', import_state: 'pulled', capabilities: ['completion', 'vision'], size_bytes: 8 * GB });
        await repo.place(m.id, pool.id, 'warm', 'x');
        const t = Date.now();
        const see: ProfileRow = { id: 'SEE'.padEnd(26, '0'), tenant_id: h.tenantId, name: 'see', display_name: 'See', description: null, alias_of: null, model_id: m.id, pool_id: pool.id, num_ctx: 8192, temperature: 0, think_default: 'off', think_ceiling: 'off', system_prompt: null, fallback: null, canary: null, tools: [], label: 'confidential', status: 'published', version: 1, updated_by: null, created_at: t, updated_at: t };
        await repo.createProfile(see);
        await s.gateway.pollAll();

        const curator = await client(h, 'cura', ['member', 'knowledge-curator'], 'confidential');
        const kb = (await curator.post('/api/knowledge/bases', { name: 'Screens', label: 'internal', embedModel: 'nomic-embed-text' }).expect(201)).body;
        await curator.patch(`/api/knowledge/bases/${kb.id}`, { visionProfile: 'see' }).expect(200);
        const up = (name: string, data: Buffer) => curator.agent.put(`/api/knowledge/bases/${kb.id}/uploads?name=${name}`).set('x-csrf-token', curator.csrf).set('content-type', 'application/octet-stream').send(data).expect(202);
        const receipt = (await up('taxi.png', markedPng({ caption: 'A taxi receipt', ocr: 'Fare 42.00 EUR', scores: { receipt: 0.88, diagram: 0.02 } }))).body;
        const word = zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Network</w:t></w:r></w:p></w:body></w:document>', 'word/media/image1.png': markedPng({ caption: 'A network diagram', ocr: 'Fare zones on the network map', scores: { receipt: 0.3, diagram: 0.77 } }, 24, 4) });
        const docx = (await up('net.docx', word)).body;
        await drain(h);
        const parts = (await curator.get(`/api/knowledge/documents/${docx.id}`).expect(200)).body.parts;
        expect(parts).toHaveLength(1);
        expect(parts[0]).toMatchObject({ state: 'indexed', media: 'image' });
        const found = (await curator.post('/api/knowledge/search', { kbIds: [kb.id], query: 'fare', rerank: false }).expect(200)).body;
        const docsFound = found.hits.map((x: { document: string }) => x.document);
        expect(docsFound).toContain('taxi.png');
        expect(docsFound).toContain('net.docx, image 1');

        // A vision classifier with image cases (published here directly; the publish gate is covered on SQLite).
        const c = await s.guard.classifiers.create(h.tenantId, { name: 'Image kinds', engine: 'vision', labels: ['receipt', 'diagram'], profile: 'see' }, { userId: curator.user.id, name: 'cura' });
        await s.guard.classifiers.addImageCases(h.tenantId, c.dataset!, [{ data: markedPng({ scores: { receipt: 1 } }), type: 'image/png', expected: 'receipt' }], null);
        expect(await s.guard.classifiers.sampleCounts(h.tenantId, c)).toEqual({ receipt: 1 });
        await db('classifiers').where({ id: c.id }).update({ status: 'published' });
        await curator.patch(`/api/knowledge/bases/${kb.id}`, { imageClassifiers: [c.id] }).expect(200);
        await drain(h);
        const labels = (await curator.get(`/api/knowledge/documents/${receipt.id}`).expect(200)).body.labels;
        expect(labels[0]).toMatchObject({ label: 'receipt', score: 0.88, hit: true, version: 1 });
        const fare = (labels: object) => curator.post('/api/knowledge/search', { kbIds: [kb.id], query: 'fare', rerank: false, labels }).expect(200);
        expect([...new Set((await fare({ any: ['receipt'] })).body.hits.map((x: { document: string }) => x.document))]).toEqual(['taxi.png']);
        expect([...new Set((await fare({ all: ['receipt', 'diagram'], minScore: 0.25 })).body.hits.map((x: { document: string }) => x.document))]).toEqual(['net.docx, image 1']);
        expect((await curator.get(`/api/knowledge/bases/${kb.id}/labels`).expect(200)).body).toEqual([{ label: 'diagram', documents: 1 }, { label: 'receipt', documents: 1 }]);
        expect((await curator.get(`/api/knowledge/bases/${kb.id}/documents?labels=diagram`).expect(200)).body.map((x: { name: string }) => x.name)).toEqual(['net.docx, image 1']);

        // A new version re-labels; the labels follow the image's label; removing the document removes its part's labels.
        const fresh = (await s.guard.classifiers.get(h.tenantId, c.id))!;
        await s.guard.classifiers.update(fresh, { thresholds: { diagram: 0.8 } }, curator.user.id);
        await drain(h);
        expect((await db('knowledge_doc_labels').where({ document_id: parts[0].id, label: 'diagram' }).first()).classifier_version).toBe(2);
        await curator.patch(`/api/knowledge/documents/${receipt.id}`, { label: 'confidential' }).expect(200);
        expect(new Set((await db('knowledge_doc_labels').where({ document_id: receipt.id }).select('label_rank')).map((r: { label_rank: number }) => Number(r.label_rank)))).toEqual(new Set([3])); // confidential
        await curator.del(`/api/knowledge/documents/${docx.id}`).expect(204);
        expect(Number(((await db('knowledge_doc_labels').where({ document_id: parts[0].id }).count({ n: '*' })) as { n: number | string }[])[0]!.n)).toBe(0);
      } finally {
        await ollama.stop();
        await s.close();
        await db.destroy();
      }
    });
  });
}
