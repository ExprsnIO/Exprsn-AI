import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scheduleFor } from '../src/imports/datasets.js';
import { FakeOllama } from './fake-ollama.js';
import { localUser, loginAdmin, type Client } from './helpers.js';
import { drain as drainAll, harnessWith, seedRetrieval } from './retrieval-seed.js';
import type { Harness } from './helpers.js';
import { startFakePortal, type FakePortal } from './sprint40b-fakes.js';

/**
 * Sprint 40b (1.7.0), B-3805: knowledge sets. A monthly SDMX table becomes a knowledge base with one source of kind
 * `dataset`, a refresh schedule that follows the publisher, one document per row (or per group) with a citation back
 * to the row; a refresh re-reads the source and swaps changed rows only, with the rest serving throughout.
 */

const send = (c: Client, method: 'post' | 'patch' | 'put' | 'delete', url: string, body: unknown = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body as object);

describe('Sprint 40b: knowledge sets from datasets', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let portal: FakePortal;
  let a: Client;
  let b: Client;
  let sdmxId: string;
  let ckanId: string;
  const drain = () => drainAll(h);
  const confirmed = async (body: object) => {
    const p = await send(a, 'post', '/api/imports/repositories', body);
    if (p.status !== 201) throw new Error(JSON.stringify(p.body));
    await send(b, 'post', `/api/imports/repositories/${p.body.id}/confirm`, {}).expect(200);
    await drain();
    return p.body.id as string;
  };

  beforeAll(async () => {
    [ollama, portal] = await Promise.all([new FakeOllama().start(), startFakePortal()]);
    h = await harnessWith({}, { IMPORT_ALLOWED_HOSTS: '127.0.0.1', IMPORT_HARVEST_TICK_MINUTES: '0', IMPORT_BUNDLE_POLL_MINUTES: '0', OLLAMA_POLL_MS: '600000' });
    await seedRetrieval(h, ollama);
    await localUser(h, 'ksa', ['model-admin', 'tenant-admin', 'knowledge-curator'], 'restricted');
    await localUser(h, 'ksb', ['model-admin'], 'restricted');
    [a, b] = [await loginAdmin(h, 'ksa'), await loginAdmin(h, 'ksb')];
    sdmxId = await confirmed({ name: 'Eurostat (fake)', type: 'sdmx', baseUrl: `${portal.url}/sdmx`, region: 'EU', options: { licence: 'cc-by-4.0' }, harvestMinutes: null });
    ckanId = await confirmed({ name: 'portal (fake)', type: 'ckan', baseUrl: `${portal.url}/api/3`, region: 'US', harvestMinutes: null });
  }, 120_000);

  afterAll(async () => {
    await h.close();
    await Promise.all([ollama.stop(), portal.close()]);
  });

  it('maps a publisher\'s update frequency to a refresh schedule', () => {
    expect(scheduleFor('monthly')).toBe('monthly');
    expect(scheduleFor('quarterly')).toBe('monthly');
    expect(scheduleFor('weekly')).toBe('weekly');
    expect(scheduleFor('daily')).toBe('daily');
    expect(scheduleFor(null)).toBe('manual');
  });

  it('a monthly SDMX table becomes a knowledge set that refreshes on schedule and swaps rows without downtime', async () => {
    const detail = (await a.agent.get(`/api/imports/repositories/${sdmxId}/dataset?id=ESTAT,PRC_HICP_MIDX,1.0`).expect(200)).body;
    expect(detail.resources[0]).toMatchObject({ api: 'sdmx', format: 'api' });
    const body = { repositoryId: sdmxId, item: 'ESTAT,PRC_HICP_MIDX,1.0', target: 'knowledge', label: 'internal', knowledge: { name: 'Euro area inflation', embedModel: 'nomic-embed-text', titleColumn: 'TIME_PERIOD', metadataColumns: ['geo', 'FREQ'], schedule: 'publisher' } };
    const plan = (await send(a, 'post', '/api/imports/dataset-plan', body).expect(200)).body;
    expect(plan.blocked, JSON.stringify(plan.checks)).toBe(false);
    expect(plan.schedule).toBe('monthly');
    expect(plan.schema.columns.map((c: { name: string }) => c.name)).toEqual(['DATAFLOW', 'FREQ', 'geo', 'TIME_PERIOD', 'OBS_VALUE']);
    const created = (await send(a, 'post', '/api/imports/datasets', body).expect(201)).body;
    await drain();
    const imp = (await a.agent.get(`/api/imports/${created.id}`).expect(200)).body;
    expect(imp.state, JSON.stringify(imp.log)).toBe('complete');
    expect(imp.result.knowledge).toMatchObject({ kbName: 'Euro area inflation', schedule: 'monthly' });
    expect(imp.kbId).toBeTruthy();
    const src = await h.s.knowledge.source(h.tenantId, imp.sourceId);
    expect(src).toMatchObject({ kind: 'dataset', schedule: 'monthly', state: 'idle' });
    expect(src.config.dataset).toMatchObject({ importId: created.id, item: 'ESTAT,PRC_HICP_MIDX,1.0', titleColumn: 'TIME_PERIOD', frequency: 'monthly' });

    // One document per row, named by the title column and the row, with a citation back to the row in its text.
    const docs = (await a.agent.get(`/api/knowledge/bases/${imp.kbId}/documents?limit=500`).expect(200)).body;
    expect(docs.length).toBe(24);
    expect(docs.every((d: { state: string }) => d.state === 'indexed')).toBe(true);
    expect(docs.map((d: { name: string }) => d.name).sort()[0]).toMatch(/^2026-01 \(row \d+\)$/);
    const hit = (await send(a, 'post', '/api/knowledge/search', { kbIds: [imp.kbId], query: 'HICP 2026-03 DE', k: 3, rerank: false }).expect(200)).body;
    expect(hit.hits.length).toBeGreaterThan(0);
    expect(hit.hits[0].source).toContain('dataset: Eurostat (fake)');
    expect(hit.hits.some((x: { text: string }) => /Source: Eurostat \(fake\), .*PRC_HICP_MIDX.*row \d+/.test(x.text))).toBe(true);

    // The publisher changes one value, adds a month and withdraws one: a refresh swaps exactly those documents.
    const docById = new Map(docs.map((d: { id: string; name: string; sha256: string }) => [d.name, d]));
    portal.hicp[3]!.OBS_VALUE = '999.9';
    portal.hicp.push({ DATAFLOW: 'ESTAT:PRC_HICP_MIDX(1.0)', FREQ: 'M', geo: 'FR', TIME_PERIOD: '2027-01', OBS_VALUE: '110.0' });
    const dropped = portal.hicp.splice(10, 1)[0]!;
    await send(a, 'post', `/api/knowledge/sources/${imp.sourceId}/sync`).expect(202);
    await drain();
    const after = (await a.agent.get(`/api/knowledge/bases/${imp.kbId}/documents?limit=500`).expect(200)).body as { id: string; name: string; sha256: string; state: string }[];
    expect(after.length).toBe(24);
    expect(after.some((d) => d.name.startsWith('2027-01 '))).toBe(true);
    // The row keyed by its position: the changed row's document kept its id and changed its hash; an untouched row kept both.
    const changedName = docs.find((d: { name: string }) => d.name.startsWith(`${portal.hicp[3]!.TIME_PERIOD} (row 4)`)).name;
    expect(after.find((d) => d.name === changedName)!.id).toBe((docById.get(changedName) as { id: string }).id);
    expect(after.find((d) => d.name === changedName)!.sha256).not.toBe((docById.get(changedName) as { sha256: string }).sha256);
    const untouched = docs.find((d: { name: string }) => d.name.endsWith('(row 1)')) as { id: string; sha256: string; name: string };
    expect(after.find((d) => d.name === untouched.name)).toMatchObject({ id: untouched.id, sha256: untouched.sha256 });
    void dropped;
    expect((await h.s.knowledge.source(h.tenantId, imp.sourceId)).state).toBe('idle');
    // The source is due again only after a month.
    expect(await (h.s.knowledge as unknown as { syncDue(t: string): Promise<{ queued: number }> }).syncDue(h.tenantId)).toMatchObject({ queued: 0 });
  }, 120_000);

  it('groups rows by a column into one document per group, drops flagged PII columns, and reaches an existing base', async () => {
    const kb = (await send(a, 'post', '/api/knowledge/bases', { name: 'Complaints KB', label: 'confidential', embedModel: 'nomic-embed-text', reranker: null }).expect(201)).body;
    const body = { repositoryId: ckanId, item: 'consumer-complaints', resources: ['complaints-json'], target: 'knowledge', label: 'confidential', sample: 40, knowledge: { kbId: kb.id, titleColumn: 'product', textColumns: ['narrative'], metadataColumns: ['region', 'received'], groupBy: 'product', dropPii: true, schedule: 'manual' } };
    const created = (await send(a, 'post', '/api/imports/datasets', body).expect(201)).body;
    await drain();
    const imp = (await a.agent.get(`/api/imports/${created.id}`).expect(200)).body;
    expect(imp.state, JSON.stringify(imp.log)).toBe('complete');
    expect(imp.kbId).toBe(kb.id);
    const docs = (await a.agent.get(`/api/knowledge/bases/${kb.id}/documents?limit=500`).expect(200)).body as { id: string; name: string }[];
    expect(docs.map((d) => d.name).sort()).toEqual(['product: auto loan (10 rows)', 'product: checking (10 rows)', 'product: credit card (10 rows)', 'product: mortgage (10 rows)']);
    const hits = (await send(a, 'post', '/api/knowledge/search', { kbIds: [kb.id], query: 'mortgage statement wrong', k: 8, rerank: false }).expect(200)).body.hits as { text: string; document: string }[];
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((x) => x.document.startsWith('product: mortgage'))).toBe(true);
    expect(hits.some((x) => /Row \d+/.test((x as { heading?: string }).heading ?? '') || /Row \d+/.test(x.text))).toBe(true);
    expect(hits.some((x) => x.text.includes('region: '))).toBe(true);
    expect(hits.every((x) => !x.text.includes('@example.org'))).toBe(true);
    expect((await h.s.knowledge.source(h.tenantId, imp.sourceId)).schedule).toBe('manual');
  }, 120_000);
});
