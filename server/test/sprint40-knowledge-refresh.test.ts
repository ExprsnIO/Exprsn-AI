import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SourceItem } from '../src/knowledge/sources.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';
import { drain, seedRetrieval } from './retrieval-seed.js';
import { startFakeCkan, type FakeCkan } from './sprint30-imports-fakes.js';

/**
 * Sprint 40 (1.7.0), B-3805: a refresh of a dataset source builds the next index version beside the serving one and
 * swaps it in. Search answers from the last good rows until the swap; a refresh that fails or is cancelled leaves
 * the serving version as it was. The first load comes through the import wizard's API from the CKAN fake; the
 * refreshes hand rows to the knowledge service directly, so a test can hold one in the middle.
 */

const send = (c: Client, method: 'post' | 'put', url: string, body: unknown = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body as object);
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const ctx = () => ({ signal: new AbortController().signal, progress: async () => {} });
const row = (key: string, name: string, text: string, read?: () => Promise<Buffer>): SourceItem => ({ key, name, version: sha(text), size: text.length, read: read ?? (async () => Buffer.from(`# ${name}\n\n${text}\n`)) });

describe('Sprint 40, B-3805: a dataset refresh swaps in a new index version', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let ckan: FakeCkan;
  let a: Client;
  let b: Client;
  let kbId: string;
  let sourceId: string;

  const search = async (query: string) => (await send(a, 'post', '/api/knowledge/search', { kbIds: [kbId], query, rerank: false }).expect(200)).body.hits as { document: string; text: string }[];
  const kbRow = async () => (await h.s.db('knowledge_bases').where({ id: kbId }).first()) as { serving_index_id: string };
  const indexes = async () => (await h.s.db('knowledge_indexes').where({ kb_id: kbId }).orderBy('version')) as { id: string; version: number; state: string; source_id: string | null; chunks: number }[];
  const count = async (table: string, where: Record<string, unknown>) => Number(((await h.s.db(table).where(where).count({ n: '*' })) as { n: number }[])[0]!.n);
  const listed = async () => ((await a.agent.get(`/api/knowledge/bases/${kbId}/documents?limit=200`).expect(200)).body as { name: string }[]).map((d) => d.name);
  const source = () => h.s.knowledge.source(h.tenantId, sourceId);

  beforeAll(async () => {
    [ollama, ckan] = await Promise.all([new FakeOllama().start(), startFakeCkan()]);
    h = await harness({ IMPORT_ALLOWED_HOSTS: '127.0.0.1', IMPORT_HARVEST_TICK_MINUTES: '0', IMPORT_BUNDLE_POLL_MINUTES: '0', IMPORT_REFRESH_TICK_MINUTES: '0', OLLAMA_POLL_MS: '600000' });
    await seedRetrieval(h, ollama);
    await localUser(h, 'kra', ['model-admin', 'knowledge-curator'], 'restricted');
    await localUser(h, 'krb', ['model-admin'], 'restricted');
    [a, b] = [await loginAdmin(h, 'kra'), await loginAdmin(h, 'krb')];
    const repo = await send(a, 'post', '/api/imports/repositories', { name: 'data.gov (fake)', type: 'ckan', baseUrl: `${ckan.url}/api/3`, region: 'US' }).expect(201);
    await send(b, 'post', `/api/imports/repositories/${repo.body.id}/confirm`, {}).expect(200);
    await drain(h);
    kbId = (await send(a, 'post', '/api/knowledge/bases', { name: 'Banks', label: 'internal', embedModel: 'nomic-embed-text' }).expect(201)).body.id;
    // A document of another source in the same base: every new index version has to carry it over.
    await a.agent.put(`/api/knowledge/bases/${kbId}/uploads?name=${encodeURIComponent('Handbook.md')}&label=internal`).set('x-csrf-token', a.csrf).set('content-type', 'application/octet-stream').send(Buffer.from('# Handbook\n\nThe quorum of the settlement committee is seven members.\n')).expect(202);
    await drain(h);
    const res = await send(a, 'post', '/api/imports/datasets', { repositoryId: repo.body.id, item: 'failed-banks', target: 'knowledge', label: 'internal', knowledge: { knowledgeBaseId: kbId, titleColumn: 'Bank Name', textColumns: ['Bank Name', 'City', 'Acquiring Institution'], idColumn: 'Cert', refresh: 'manual' } });
    if (res.status !== 201) throw new Error(`${res.status} ${JSON.stringify(res.body)}`);
    await drain(h);
    const imp = (await a.agent.get(`/api/imports/${res.body.id}`).expect(200)).body;
    expect(imp.result.knowledge).toMatchObject({ documents: 12, added: 12 });
    // The first load fills the serving index: there is nothing to keep answering from yet.
    expect(imp.result.knowledge.indexVersion).toBeUndefined();
    sourceId = imp.result.knowledge.sourceId;
  }, 180_000);

  afterAll(async () => {
    await h.close();
    await Promise.all([ckan.close(), ollama.stop()]);
  });

  it('answers from the old rows while the new version builds, then swaps in one step', async () => {
    const first = (await kbRow()).serving_index_id;
    expect(await indexes()).toMatchObject([{ id: first, version: 1, state: 'serving' }]);
    expect((await search('Bank 3 Tulsa Acquirer')).some((x) => x.document.startsWith('Bank 3'))).toBe(true);

    // The publisher replaced the whole table. The second row is held half-way, with the first already indexed.
    let reached!: () => void;
    let release!: () => void;
    const atSecond = new Promise<void>((r) => (reached = r));
    const held = new Promise<void>((r) => (release = r));
    const beta = '# Ledger beta\n\nThe beta ledger closes on Wednesday.\n';
    const items = [
      row('r1', 'Ledger alpha', 'The alpha ledger closes on Tuesday.'),
      row('r2', 'Ledger beta', 'The beta ledger closes on Wednesday.', async () => {
        reached();
        await held;
        return Buffer.from(beta);
      }),
      row('r3', 'Ledger gamma', 'The gamma ledger closes on Thursday.')
    ];
    const run = h.s.knowledge.applyDataset(await source(), items, ctx());
    await atSecond;
    // Mid-build: the new version exists beside the serving one, which still answers with the old rows only.
    const mid = await indexes();
    expect(mid).toMatchObject([{ id: first, version: 1, state: 'serving' }, { version: 2, state: 'building', source_id: sourceId }]);
    expect(await count('knowledge_chunks', { index_id: mid[1]!.id })).toBeGreaterThan(0);
    expect((await kbRow()).serving_index_id).toBe(first);
    expect((await search('Bank 3 Tulsa Acquirer')).some((x) => x.document.startsWith('Bank 3'))).toBe(true);
    expect((await search('alpha ledger closes Tuesday')).some((x) => x.document === 'Ledger alpha')).toBe(false);
    // The staged row is not a document of the base yet.
    const before = await listed();
    expect(before).toHaveLength(13);
    expect(before).not.toContain('Ledger alpha');
    const kb = (await a.agent.get(`/api/knowledge/bases/${kbId}`).expect(200)).body;
    expect(kb.sources.find((s: { id: string }) => s.id === sourceId)).toMatchObject({ documents: 12 });
    // A second build beside it is refused while this one runs.
    await send(a, 'post', `/api/knowledge/bases/${kbId}/reindex`, {}).expect(409);

    release();
    expect(await run).toEqual({ added: 3, changed: 0, unchanged: 0, removed: 12, indexVersion: 2, retiredVersion: 1 });
    const second = (await kbRow()).serving_index_id;
    expect(second).toBe(mid[1]!.id);
    const now = await indexes();
    expect(now).toMatchObject([{ id: first, version: 1, state: 'retired', chunks: 0 }, { id: second, version: 2, state: 'serving' }]);
    // The retired version holds nothing; the new one has a vector and keyword terms for every chunk.
    expect(await count('knowledge_chunks', { index_id: first })).toBe(0);
    expect(await count('vectors', { collection: first })).toBe(0);
    expect(await count('knowledge_terms', { index_id: first })).toBe(0);
    const chunks = await count('knowledge_chunks', { index_id: second });
    expect(chunks).toBe(4);
    expect(now[1]!.chunks).toBe(4);
    expect(await count('vectors', { collection: second })).toBe(chunks);
    expect(await count('knowledge_terms', { index_id: second })).toBeGreaterThan(chunks);
    // Search now answers from the new rows, and from the other source's document, carried over without its text
    // being embedded again.
    expect((await search('Bank 3 Tulsa Acquirer')).some((x) => x.document.startsWith('Bank'))).toBe(false);
    expect((await search('alpha ledger closes Tuesday')).some((x) => x.document === 'Ledger alpha' && x.text.includes('Tuesday'))).toBe(true);
    expect((await search('quorum of the settlement committee')).some((x) => x.document === 'Handbook.md' && x.text.includes('seven members'))).toBe(true);
    // The staged rows are ordinary documents under their own keys; the replaced ones are gone.
    const docs = (await h.s.db('knowledge_documents').where({ source_id: sourceId }).orderBy('name')) as { name: string; external_key: string; staged_index_id: string | null; staged_key: string | null; state: string }[];
    expect(docs.map((d) => [d.name, d.external_key, d.staged_index_id, d.staged_key, d.state])).toEqual([
      ['Ledger alpha', sha('r1'), null, null, 'indexed'],
      ['Ledger beta', sha('r2'), null, null, 'indexed'],
      ['Ledger gamma', sha('r3'), null, null, 'indexed']
    ]);
    expect((await listed()).sort()).toEqual(['Handbook.md', 'Ledger alpha', 'Ledger beta', 'Ledger gamma']);
  });

  it('carries unchanged rows over, replaces changed ones, drops removed ones', async () => {
    const embedsBefore = ollama.requests.filter((c) => c.path === '/api/embed').length;
    const out = await h.s.knowledge.applyDataset(await source(), [
      row('r1', 'Ledger alpha', 'The alpha ledger closes on Tuesday.'),
      row('r2', 'Ledger beta', 'The beta ledger closes on Friday.'),
      row('r4', 'Ledger delta', 'The delta ledger closes on Sunday.')
    ], ctx());
    expect(out).toEqual({ added: 1, changed: 1, unchanged: 1, removed: 1, indexVersion: 3, retiredVersion: 2 });
    // Only the changed and the new row were embedded (one call each, before the searches below).
    expect(ollama.requests.filter((c) => c.path === '/api/embed').length - embedsBefore).toBe(2);
    expect((await indexes()).map((i) => [i.version, i.state])).toEqual([[1, 'retired'], [2, 'retired'], [3, 'serving']]);
    const beta = await search('beta ledger closes');
    expect(beta.some((x) => x.document === 'Ledger beta' && x.text.includes('Friday'))).toBe(true);
    expect(beta.some((x) => x.text.includes('Wednesday'))).toBe(false);
    expect((await search('alpha ledger closes Tuesday')).some((x) => x.document === 'Ledger alpha')).toBe(true);
    expect((await search('gamma ledger closes Thursday')).some((x) => x.document === 'Ledger gamma')).toBe(false);
    expect((await search('delta ledger closes Sunday')).some((x) => x.document === 'Ledger delta')).toBe(true);
    expect((await search('quorum of the settlement committee')).some((x) => x.document === 'Handbook.md')).toBe(true);
    expect(await count('knowledge_documents', { source_id: sourceId })).toBe(3);
    const serving = (await kbRow()).serving_index_id;
    expect(await count('vectors', { collection: serving })).toBe(await count('knowledge_chunks', { index_id: serving }));
  });

  it('keeps the last good version when a refresh fails or its build is cancelled', async () => {
    const serving = (await kbRow()).serving_index_id;
    const chunks = await count('knowledge_chunks', { index_id: serving });
    const same = async () => {
      expect((await kbRow()).serving_index_id).toBe(serving);
      expect((await indexes()).filter((i) => i.state === 'building')).toHaveLength(0);
      expect(await count('knowledge_chunks', { index_id: serving })).toBe(chunks);
      expect(await count('knowledge_chunks', { kb_id: kbId })).toBe(chunks);
      expect(await count('vectors', { collection: serving })).toBe(chunks);
      expect(await count('knowledge_documents', { source_id: sourceId })).toBe(3);
      expect(await h.s.db('knowledge_documents').where({ source_id: sourceId }).whereNotNull('staged_index_id')).toHaveLength(0);
      const beta = await search('beta ledger closes');
      expect(beta.some((x) => x.document === 'Ledger beta' && x.text.includes('Friday'))).toBe(true);
      expect(beta.some((x) => x.text.includes('Saturday'))).toBe(false);
      expect((await search('delta ledger closes Sunday')).some((x) => x.document === 'Ledger delta')).toBe(true);
    };

    // The second changed row cannot be read: the refresh fails after the first was staged and indexed.
    await expect(
      h.s.knowledge.applyDataset(await source(), [
        row('r1', 'Ledger alpha', 'The alpha ledger closes on Tuesday.'),
        row('r2', 'Ledger beta', 'The beta ledger closes on Saturday.'),
        row('r5', 'Ledger epsilon', 'The epsilon ledger closes on Monday.', async () => {
          throw new Error('the publisher hung up');
        })
      ], ctx())
    ).rejects.toThrow('the publisher hung up');
    expect((await indexes()).at(-1)).toMatchObject({ version: 4, state: 'failed', chunks: 0 });
    await same();

    // A curator cancels the build from the Knowledge screen while a row is being read.
    let reached!: () => void;
    let release!: () => void;
    const atSecond = new Promise<void>((r) => (reached = r));
    const held = new Promise<void>((r) => (release = r));
    const run = h.s.knowledge.applyDataset(await source(), [
      row('r1', 'Ledger alpha', 'The alpha ledger closes on Tuesday.'),
      row('r2', 'Ledger beta', 'The beta ledger closes on Saturday.'),
      row('r4', 'Ledger delta', 'The delta ledger closes on a day nobody knows.', async () => {
        reached();
        await held;
        return Buffer.from('# Ledger delta\n\nThe delta ledger closes on a day nobody knows.\n');
      })
    ], ctx());
    const settled = run.then(() => null, (err: Error) => err);
    await atSecond;
    await send(a, 'post', `/api/knowledge/bases/${kbId}/cancel-build`, {}).expect(200);
    release();
    expect((await settled)?.message).toMatch(/cancelled/);
    expect((await indexes()).at(-1)).toMatchObject({ version: 5, state: 'cancelled' });
    await same();

    // The next refresh starts clean and swaps as usual.
    const out = await h.s.knowledge.applyDataset(await source(), [
      row('r1', 'Ledger alpha', 'The alpha ledger closes on Tuesday.'),
      row('r2', 'Ledger beta', 'The beta ledger closes on Saturday.'),
      row('r4', 'Ledger delta', 'The delta ledger closes on Sunday.')
    ], ctx());
    expect(out).toEqual({ added: 0, changed: 1, unchanged: 2, removed: 0, indexVersion: 6, retiredVersion: 3 });
    expect((await search('beta ledger closes')).some((x) => x.document === 'Ledger beta' && x.text.includes('Saturday'))).toBe(true);
    expect((await search('quorum of the settlement committee')).some((x) => x.document === 'Handbook.md')).toBe(true);
  });
});
