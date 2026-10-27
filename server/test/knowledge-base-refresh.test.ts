/*
 * A manual refresh of a whole knowledge base (POST /api/knowledge/bases/:id/refresh): `all` syncs every source again
 * (a web source's pages and their images), `images` has the vision profile describe every image document again.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ProfileRow } from '../src/gateway/repo.js';
import { FakeOllama, markedPng } from './fake-ollama.js';
import { type Harness } from './helpers.js';
import { client, drain, harnessWith, seedRetrieval } from './retrieval-seed.js';
import { FakeSite } from './sprint23-fakes.js';

const GB = 1_000_000_000;
const page = (title: string, text: string, extra = '') => `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>${text}</p>${extra}</body></html>`;

describe('Manual refresh of a knowledge base', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let site: FakeSite;

  afterEach(async () => {
    await h?.s.knowledge.replication.close();
    await h?.close();
    await ollama?.stop();
    await site?.stop();
  });

  it('syncs every source again, or describes every image again, for a curator only', async () => {
    h = await harnessWith({}, { OLLAMA_POLL_MS: '600000' });
    ollama = await new FakeOllama().start();
    ollama.chatDelayMs = 0;
    const { pool } = await seedRetrieval(h, ollama);
    const repo = h.s.gateway.repo;
    ollama.addAvailable({ name: 'gemma3:12b', size: 8 * GB, capabilities: ['completion', 'vision'] });
    const m = await repo.createModel({ name: 'gemma3:12b', source: 'Ollama library', expectedDigest: null, license: { name: 'test' }, label: 'confidential', notes: null, requestedBy: 'x', requestedTenant: h.tenantId });
    await repo.updateModel(m.id, { state: 'approved', import_state: 'pulled', capabilities: ['completion', 'vision'], size_bytes: 8 * GB });
    await repo.place(m.id, pool.id, 'warm', 'x');
    const t = Date.now();
    const see: ProfileRow = { id: 'SEE'.padEnd(26, '0'), tenant_id: h.tenantId, name: 'see', display_name: 'See', description: null, alias_of: null, model_id: m.id, pool_id: pool.id, num_ctx: 8192, temperature: 0, think_default: 'off', think_ceiling: 'off', system_prompt: null, fallback: null, canary: null, tools: [], label: 'confidential', status: 'published', version: 1, updated_by: null, created_at: t, updated_at: t };
    await repo.createProfile(see);
    await h.s.gateway.pollAll();
    const curator = await client(h, 'cura', ['member', 'knowledge-curator'], 'confidential');
    const reader = await client(h, 'read', ['member'], 'confidential');
    const kb = (await curator.post('/api/knowledge/bases', { name: 'Wikipedia', label: 'internal', embedModel: 'nomic-embed-text', sharing: 'members' }).expect(201)).body as { id: string };
    await curator.patch(`/api/knowledge/bases/${kb.id}`, { status: 'published' }).expect(200);

    // Without a vision profile there is nothing to describe.
    expect((await curator.post(`/api/knowledge/bases/${kb.id}/refresh`, { what: 'images' }).expect(409)).body.detail).toMatch(/no vision profile/);
    await curator.patch(`/api/knowledge/bases/${kb.id}`, { visionProfile: 'see' }).expect(200);

    site = await new FakeSite().start();
    site.pages.set('/diagram.png', { type: 'image/png', data: markedPng({ caption: 'A map of the Moon', ocr: 'Mare Tranquillitatis' }, 64), etag: '"d-1"' });
    site.pages.set('/', { type: 'text/html', etag: '"home-1"', body: page('Moon', 'The Moon is Earth\'s only natural satellite.', '<img src="/diagram.png">') });
    await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 'web', location: `${site.url}/`, maxDepth: 0, maxPages: 1, sitemap: false, schedule: 'manual', media: true, maxMedia: 5, changes: true }).expect(201);
    await drain(h);
    const docs = async () => ((await curator.get(`/api/knowledge/bases/${kb.id}/documents`).expect(200)).body as { name: string; state: string; media: string | null }[]).map((d) => [d.name.replace(/^127\.0\.0\.1:\d+/, ''), d.state, d.media]).sort();
    expect(await docs()).toEqual([['/', 'indexed', null], ['/diagram.png', 'indexed', 'image']]);

    // A member who does not manage the base may not refresh it.
    await reader.post(`/api/knowledge/bases/${kb.id}/refresh`, { what: 'all' }).expect(403);
    await reader.post(`/api/knowledge/bases/${kb.id}/refresh`, { what: 'everything' }).expect(400);

    // Text and images: the page and its picture are fetched again and the change is recorded.
    site.pages.set('/', { type: 'text/html', etag: '"home-2"', body: page('Moon', 'The Moon is Earth\'s only natural satellite. It is tidally locked.', '<img src="/diagram.png">') });
    expect((await curator.post(`/api/knowledge/bases/${kb.id}/refresh`, { what: 'all' }).expect(202)).body).toMatchObject({ what: 'all', sources: 1, images: 0, jobs: 1 });
    await drain(h);
    const changes = (await curator.get(`/api/knowledge/bases/${kb.id}/changes`).expect(200)).body as { kind: string; document: string }[];
    expect(changes.map((c) => [c.kind, c.document.replace(/^127\.0\.0\.1:\d+/, '')])).toEqual([['changed', '/']]);

    // Images only: nothing is fetched; the vision profile reads the stored picture again.
    const fetched = site.requests.length;
    const vision = () => ollama.requests.filter((r) => r.path === '/api/chat' && JSON.stringify(r.body).includes('Describe this image')).length;
    const before = vision();
    expect((await curator.post(`/api/knowledge/bases/${kb.id}/refresh`, { what: 'images' }).expect(202)).body).toMatchObject({ what: 'images', sources: 0, images: 1, jobs: 1 });
    await drain(h);
    expect(site.requests.length).toBe(fetched);
    expect(vision()).toBeGreaterThan(before);
    expect(await docs()).toEqual([['/', 'indexed', null], ['/diagram.png', 'indexed', 'image']]);
    const audit = (await h.s.db('audit_events').where({ action: 'knowledge.refreshed' })) as unknown[];
    expect(audit).toHaveLength(2);
  }, 120_000);
});
