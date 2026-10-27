import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Label } from '../src/authz/labels.js';
import type { ProfileRow } from '../src/gateway/repo.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { categoryAncestors, categoryFilter, categoryPath, categoryPaths, labelCategory } from '../src/knowledge/categories.js';
import { FakeOllama, markedPng } from './fake-ollama.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';
import { client, drain, seedRetrieval } from './retrieval-seed.js';

const GB = 1024 ** 3;
type Client = Awaited<ReturnType<typeof client>>;

describe('Knowledge categories (migration 043)', () => {
  let h: Harness;
  let ollama: FakeOllama;

  beforeEach(async () => {
    ollama = await new FakeOllama().start();
    ollama.chatDelayMs = 0;
    h = await harness({ OLLAMA_POLL_MS: '600000' });
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  const upload = (c: Client, kbId: string, name: string, data: Buffer | string, categories?: string) =>
    c.agent.put(`/api/knowledge/bases/${kbId}/uploads?${new URLSearchParams({ name, label: 'public', ...(categories ? { categories } : {}) }).toString()}`).set('x-csrf-token', c.csrf).set('content-type', 'application/octet-stream').send(Buffer.from(data));

  const caller = async (c: Client) => {
    const p = (await loadPrincipal(h.s, h.tenantId, c.user.id, {}))!;
    return async (name: string, args: Record<string, unknown>, opts: { label?: Label; approved?: boolean } = {}) => {
      const label = opts.label ?? 'internal';
      const { tools } = await h.s.tools.resolve(p, [name], label);
      return h.s.tools.call({ principal: p, label, approved: opts.approved ?? true, source: { kind: 'agent-run', id: 'R1' } }, tools[0]!, args);
    };
  };

  /** The retrieval seed plus a vision model behind the published profile `see`, for image documents. */
  async function setup() {
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
    const kb = (await curator.post('/api/knowledge/bases', { name: 'Library', label: 'internal', embedModel: 'nomic-embed-text' }).expect(201)).body as { id: string };
    await curator.patch(`/api/knowledge/bases/${kb.id}`, { status: 'published' }).expect(200);
    return { curator, kb, call: await caller(curator) };
  }

  it('stores a category in one spelling, with the categories it is under', () => {
    expect(categoryPath(' Finance / Quarterly Reports > 2026_Q3 ')).toBe('finance/quarterly-reports/2026-q3');
    expect(categoryPath('R&D/C++')).toBe('r&d/c++');
    expect(categoryAncestors('a/b/c')).toEqual(['a', 'a/b', 'a/b/c']);
    // A category another one in the list is under is dropped: filing under a/b files under a.
    expect(categoryPaths(['Finance', 'finance/reports', 'Finance/Reports', 'hr'])).toEqual(['finance/reports', 'hr']);
    expect(() => categoryPath('finance//reports')).toThrow(/name each level/);
    expect(() => categoryPath('a/b/c/d/e/f/g')).toThrow(/at most 6/);
    expect(() => categoryPath('!!!')).toThrow(/not a category/);
    expect(() => categoryPaths(Array.from({ length: 13 }, (_, i) => `c${i}`))).toThrow(/at most 12/);
    expect(categoryFilter(['Finance'], undefined)).toEqual({ any: ['finance'] });
    expect(categoryFilter([], [])).toBeUndefined();
  });

  it('is seeded: three knowledge tools and files.search, and the changed schemas of the search, list and save tools', async () => {
    const rows = (await h.s.db('registry_entries').where({ impl: 'builtin' }).whereIn('name', ['knowledge_add', 'knowledge_categorize', 'knowledge_categories', 'files.search']).orderBy('name')) as { name: string; side_effect: string; status: string }[];
    expect(rows.map((r) => [r.name, r.side_effect, r.status])).toEqual([
      ['files.search', 'read', 'published'],
      ['knowledge_add', 'write', 'published'],
      ['knowledge_categories', 'read', 'published'],
      ['knowledge_categorize', 'write', 'published']
    ]);
    for (const name of ['knowledge_search', 'knowledge_list', 'knowledge_save']) {
      const row = (await h.s.db('registry_entries').where({ impl: 'builtin', name }).first('input_schema')) as { input_schema: string };
      expect(Object.keys(JSON.parse(row.input_schema).properties)).toContain('categories');
    }
  });

  it('files uploads under categories, filters documents and search by them, and counts the tree', async () => {
    const { curator, kb } = await setup();
    const a = (await upload(curator, kb.id, 'q3.md', '# Q3 report\n\nRevenue grew by nine percent in the third quarter.', 'Finance/Reports/Quarterly, Board').expect(202)).body as { id: string; categories: string[] };
    expect(a.categories).toEqual(['board', 'finance/reports/quarterly']);
    const b = (await upload(curator, kb.id, 'budget.md', '# Budget\n\nThe budget for revenue operations is set each quarter.', 'finance/budget').expect(202)).body as { id: string };
    const c = (await upload(curator, kb.id, 'leave.md', '# Leave\n\nRevenue staff take leave by quarter as everyone does.').expect(202)).body as { id: string };
    await upload(curator, kb.id, 'bad.md', 'x', 'finance//x').expect(400);
    await drain(h);

    const names = async (q: string) => ((await curator.get(`/api/knowledge/bases/${kb.id}/documents?${q}`).expect(200)).body as { name: string; categories: string[] }[]).map((d) => d.name).sort();
    expect(await names('')).toEqual(['budget.md', 'leave.md', 'q3.md']);
    expect(await names('categories=finance')).toEqual(['budget.md', 'q3.md']);
    expect(await names('categories=Finance/Reports')).toEqual(['q3.md']);
    expect(await names('categories=finance/budget,board')).toEqual(['budget.md', 'q3.md']);
    expect(await names('categoriesAll=finance,board')).toEqual(['q3.md']);
    expect(await names('categories=legal')).toEqual([]);

    expect((await curator.get(`/api/knowledge/bases/${kb.id}/categories`).expect(200)).body).toEqual([
      { path: 'board', depth: 1, documents: 1, direct: 1 },
      { path: 'finance', depth: 1, documents: 2, direct: 0 },
      { path: 'finance/budget', depth: 2, documents: 1, direct: 1 },
      { path: 'finance/reports', depth: 2, documents: 1, direct: 0 },
      { path: 'finance/reports/quarterly', depth: 3, documents: 1, direct: 1 }
    ]);
    expect(((await curator.get('/api/knowledge/categories').expect(200)).body as { path: string }[]).map((x) => x.path)).toContain('finance/budget');

    const search = async (categories?: object) => ((await curator.post('/api/knowledge/search', { kbIds: [kb.id], query: 'revenue quarter', rerank: false, ...(categories ? { categories } : {}) }).expect(200)).body as { hits: { document: string; categories?: string[] }[] }).hits;
    expect(new Set((await search()).map((x) => x.document))).toEqual(new Set(['q3.md', 'budget.md', 'leave.md']));
    const inFinance = await search({ any: ['finance'] });
    expect(new Set(inFinance.map((x) => x.document))).toEqual(new Set(['q3.md', 'budget.md']));
    expect(inFinance.find((x) => x.document === 'q3.md')!.categories).toEqual(['board', 'finance/reports/quarterly']);
    expect((await search({ all: ['finance', 'board'] })).map((x) => x.document)).toEqual(['q3.md']);
    expect(await search({ any: ['legal'] })).toEqual([]);

    // Filing afterwards: set, add, remove (with the subcategories), audited.
    expect((await curator.put(`/api/knowledge/documents/${c.id}/categories`, { categories: ['HR/Leave'] }).expect(200)).body.categories).toEqual(['hr/leave']);
    expect((await curator.put(`/api/knowledge/documents/${c.id}/categories`, { categories: ['hr/leave/annual', 'policies'], mode: 'add' }).expect(200)).body.categories).toEqual(['hr/leave/annual', 'policies']);
    expect((await curator.put(`/api/knowledge/documents/${c.id}/categories`, { categories: ['hr'], mode: 'remove' }).expect(200)).body.categories).toEqual(['policies']);
    expect((await curator.get(`/api/knowledge/documents/${c.id}`).expect(200)).body.categories).toEqual(['policies']);
    expect((await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'knowledge.document.categorised' })) as unknown[]).toHaveLength(3);
    const member = await client(h, 'mem', ['member'], 'internal');
    await member.put(`/api/knowledge/documents/${c.id}/categories`, { categories: ['x'] }).expect(403);

    // A removed document leaves no rows behind.
    await curator.del(`/api/knowledge/documents/${b.id}`).expect(204);
    expect((await h.s.db('knowledge_doc_categories').where({ document_id: b.id })) as unknown[]).toHaveLength(0);
    expect(await names('categories=finance')).toEqual(['q3.md']);
  });

  it('knowledge_add: text, a file and an image from Files, each filed under categories a search then filters by', async () => {
    const { curator, kb, call } = await setup();
    await curator.patch(`/api/knowledge/bases/${kb.id}`, { visionProfile: 'see' }).expect(200);

    expect(await call('knowledge_add', { kbId: kb.id, title: 'Retention', content: 'Records are retained for seven years.', categories: ['Compliance/Retention'] }, { approved: false })).toMatchObject({ ok: false, needsApproval: true });
    const text = (await call('knowledge_add', { kbId: kb.id, title: 'Retention', content: 'Records are retained for seven years.', categories: ['Compliance/Retention', 'legal'] })).result as { document: string; name: string; categories: string[] };
    expect(text).toMatchObject({ name: 'Retention.md', categories: ['compliance/retention', 'legal'] });
    expect((await call('knowledge_add', { kbId: kb.id, title: 'x', content: 'y', categories: ['a//b'] })).error).toMatch(/name each level/);
    expect((await call('knowledge_add', { kbId: kb.id, categories: ['a'] })).error).toMatch(/title and content, or a fileId/);

    // A document and an image in Files, found with files.search and added by id.
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Research', 'internal')).id;
    await h.s.tenants.addMember(ws, curator.user.id);
    const put = (name: string, data: Buffer) => curator.agent.put(`/api/files/uploads?${new URLSearchParams({ name, workspace: ws }).toString()}`).set('x-csrf-token', curator.csrf).set('content-type', 'application/octet-stream').send(data).expect(202);
    await put('survey-results.csv', Buffer.from('region,score\nnorth,7\nsouth,9\n'));
    await put('floor-plan.png', markedPng({ caption: 'A floor plan of the Lisbon office', ocr: 'Meeting room Tagus' }));
    await drain(h);
    const call2 = await caller(curator);
    const found = ((await call2('files.search', { q: 'survey' })).result as { files: { id: string; name: string }[] }).files;
    expect(found.map((f) => f.name)).toEqual(['survey-results.csv']);
    const csv = (await call2('knowledge_add', { kbId: kb.id, fileId: found[0]!.id, categories: ['research/surveys/2026'] })).result as { document: string; name: string };
    expect(csv.name).toBe('survey-results.csv');
    const plan = ((await call2('files.search', { q: 'floor' })).result as { files: { id: string }[] }).files[0]!;
    const image = (await call2('knowledge_add', { kbId: kb.id, fileId: plan.id, title: 'Lisbon floor plan', categories: ['facilities/offices/lisbon'] })).result as { document: string; name: string };
    expect(image.name).toBe('Lisbon floor plan.png');
    expect((await call2('knowledge_add', { kbId: kb.id, fileId: plan.id, content: 'both', categories: ['x'] })).error).toMatch(/not both/);
    await drain(h);

    const listed = ((await call2('knowledge_list', { kbId: kb.id })).result as { documents: { name: string; categories: string[] }[] }).documents;
    expect(Object.fromEntries(listed.map((d) => [d.name, d.categories]))).toEqual({ 'Retention.md': ['compliance/retention', 'legal'], 'survey-results.csv': ['research/surveys/2026'], 'Lisbon floor plan.png': ['facilities/offices/lisbon'] });
    expect(((await call2('knowledge_list', { kbId: kb.id, categories: ['Research'] })).result as { documents: { name: string }[] }).documents.map((d) => d.name)).toEqual(['survey-results.csv']);

    const tree = (await call2('knowledge_categories', {})).result as { categories: { category: string; documents: number; filedHere: number }[] };
    expect(tree.categories).toContainEqual({ category: 'facilities/offices', documents: 1, filedHere: 0 });
    expect(tree.categories).toContainEqual({ category: 'research/surveys/2026', documents: 1, filedHere: 1 });
    expect(((await call2('knowledge_categories', { under: 'Facilities', depth: 2 })).result as { categories: { category: string }[] }).categories.map((x) => x.category)).toEqual(['facilities', 'facilities/offices']);

    const hits = ((await call2('knowledge_search', { query: 'office floor plan meeting room', categories: ['facilities'] })).result as { hits: { document: string; categories: string[]; image?: unknown }[] }).hits;
    expect(hits.map((x) => x.document)).toEqual(['Lisbon floor plan.png']);
    expect(hits[0]!.categories).toEqual(['facilities/offices/lisbon']);
    expect(hits[0]!.image).toBeTruthy();
    expect(((await call2('knowledge_search', { query: 'retained seven years', categoriesAll: ['compliance', 'legal'] })).result as { hits: { document: string }[] }).hits.map((x) => x.document)).toEqual(['Retention.md']);
    expect(((await call2('knowledge_search', { query: 'retained seven years', categories: ['facilities'] })).result as { hits: { document: string }[] }).hits.map((x) => x.document)).not.toContain('Retention.md');

    // knowledge_categorize: add by default, audited as the route does.
    const filed = (await call2('knowledge_categorize', { documentId: text.document, categories: ['Policies/Records'] })).result as { categories: string[]; before: string[] };
    expect(filed).toMatchObject({ before: ['compliance/retention', 'legal'], categories: ['compliance/retention', 'legal', 'policies/records'] });
    expect(((await call2('knowledge_categorize', { documentId: text.document, categories: ['legal'], mode: 'set' })).result as { categories: string[] }).categories).toEqual(['legal']);
    const member = await caller(await client(h, 'mem', ['member'], 'internal'));
    expect((await member('knowledge_categorize', { documentId: text.document, categories: ['x'] })).error).toMatch(/curator|manage/);
    expect((await member('knowledge_add', { kbId: kb.id, title: 'x', content: 'y', categories: ['x'] })).error).toMatch(/curator|manage/);
  });

  it('migration 046: a draft vision classifier labels provisionally, and its labels file the image under images/<classifier>/<label>', async () => {
    const { curator, kb } = await setup();
    await curator.patch(`/api/knowledge/bases/${kb.id}`, { visionProfile: 'see' }).expect(200);
    await localUser(h, 'ga', ['guardrail-admin'], 'confidential');
    const admin = await loginAdmin(h, 'ga');
    const post = (path: string, body: object = {}) => admin.agent.post(path).set('x-csrf-token', admin.csrf).send(body);
    const kind = (await post('/api/admin/classifiers', { name: 'Image kind', slug: 'image-kind', engine: 'vision', labels: ['receipt', 'diagram'], profile: 'see' }).expect(201)).body as { id: string; status: string };
    expect(kind.status).toBe('draft');
    expect(labelCategory('image-kind', 'Scanned document')).toBe('images/kind/scanned-document');
    expect(labelCategory('document-type', 'form')).toBe('images/document-type/form');

    // A draft may be named: its labels are provisional, and so are the categories they file the image under.
    expect((await curator.patch(`/api/knowledge/bases/${kb.id}`, { imageClassifiers: ['image-kind'] }).expect(200)).body.imageClassifiers).toEqual([kind.id]);
    const taxi = (await upload(curator, kb.id, 'taxi.png', markedPng({ caption: 'A taxi receipt', ocr: 'Fare 42.00 EUR', scores: { receipt: 0.88, diagram: 0.02 } }, 24, 3), 'finance/expenses').expect(202)).body as { id: string };
    const net = (await upload(curator, kb.id, 'net.png', markedPng({ caption: 'A network diagram', ocr: 'Fare zones', scores: { receipt: 0.3, diagram: 0.77 } }, 24, 4)).expect(202)).body as { id: string };
    await drain(h);
    const doc = (await curator.get(`/api/knowledge/documents/${taxi.id}`).expect(200)).body;
    expect(doc.labels[0]).toMatchObject({ label: 'receipt', hit: true, classifier: 'Image kind', provisional: true });
    expect(doc.categories).toEqual(['finance/expenses', 'images/kind/receipt']);
    expect(doc.filedByClassifier).toEqual([{ category: 'images/kind/receipt', classifierId: kind.id, classifier: 'Image kind', provisional: true }]);
    const names = async (q: string) => ((await curator.get(`/api/knowledge/bases/${kb.id}/documents?${q}`).expect(200)).body as { name: string }[]).map((d) => d.name).sort();
    expect(await names('categories=images/kind')).toEqual(['net.png', 'taxi.png']);
    expect(await names('categories=images/kind/diagram')).toEqual(['net.png']);
    expect(await names('categoriesAll=images,finance')).toEqual(['taxi.png']);
    const hits = ((await curator.post('/api/knowledge/search', { kbIds: [kb.id], query: 'fare', rerank: false, categories: { any: ['images/kind/receipt'] } }).expect(200)).body as { hits: { document: string }[] }).hits;
    expect([...new Set(hits.map((x) => x.document))]).toEqual(['taxi.png']);

    // What a person files does not disturb what the classifier filed, and the other way round.
    expect((await curator.put(`/api/knowledge/documents/${taxi.id}/categories`, { categories: ['travel/taxi'] }).expect(200)).body.categories).toEqual(['images/kind/receipt', 'travel/taxi']);
    expect((await curator.put(`/api/knowledge/documents/${taxi.id}/categories`, { categories: ['images'], mode: 'remove' }).expect(200)).body.categories).toEqual(['images/kind/receipt', 'travel/taxi']);

    // A new version of the draft re-labels: a higher threshold takes the diagram's category away.
    await admin.agent.patch(`/api/admin/classifiers/${kind.id}`).set('x-csrf-token', admin.csrf).send({ thresholds: { diagram: 0.8 } }).expect(200);
    await drain(h);
    expect((await curator.get(`/api/knowledge/documents/${net.id}`).expect(200)).body.categories).toEqual([]);
    expect(await names('categories=images/kind')).toEqual(['taxi.png']);

    // A classifier the base no longer names takes its labels and the categories they filed with it.
    await curator.patch(`/api/knowledge/bases/${kb.id}`, { imageClassifiers: [] }).expect(200);
    const after = (await curator.get(`/api/knowledge/documents/${taxi.id}`).expect(200)).body;
    expect(after.labels).toEqual([]);
    expect(after.categories).toEqual(['travel/taxi']);
    expect(after.filedByClassifier).toEqual([]);
  });
});
