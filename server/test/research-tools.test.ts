import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Label } from '../src/authz/labels.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, type Harness } from './helpers.js';
import { client, drain, seedRetrieval } from './retrieval-seed.js';

type Client = Awaited<ReturnType<typeof client>>;

describe('The research built-in tools (migration 042)', () => {
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

  const upload = (c: Client, kbId: string, name: string, data: Buffer) =>
    c.agent.put(`/api/knowledge/bases/${kbId}/uploads?name=${encodeURIComponent(name)}&label=public`).set('x-csrf-token', c.csrf).set('content-type', 'application/octet-stream').send(data);

  /** Calls a built-in as the user, from data at `label`; `approved` as an agent run's approval gives it. */
  const caller = async (c: Client) => {
    const p = (await loadPrincipal(h.s, h.tenantId, c.user.id, {}))!;
    return async (name: string, args: Record<string, unknown>, opts: { label?: Label; approved?: boolean } = {}) => {
      const label = opts.label ?? 'internal';
      const { tools } = await h.s.tools.resolve(p, [name], label);
      return h.s.tools.call({ principal: p, label, approved: opts.approved ?? false, source: { kind: 'agent-run', id: 'R1' } }, tools[0]!, args);
    };
  };

  async function setup() {
    await seedRetrieval(h, ollama);
    const curator = await client(h, 'cura', ['member', 'knowledge-curator'], 'confidential');
    const kb = (await curator.post('/api/knowledge/bases', { name: 'Handbook', label: 'internal', embedModel: 'nomic-embed-text' }).expect(201)).body as { id: string };
    await curator.patch(`/api/knowledge/bases/${kb.id}`, { status: 'published' }).expect(200);
    return { curator, kb, call: await caller(curator) };
  }

  it('is seeded as platform entries: three reads and two writes', async () => {
    const rows = (await h.s.db('registry_entries').where({ impl: 'builtin' }).whereIn('name', ['knowledge_list', 'knowledge_read', 'knowledge_save', 'memory_search', 'memory_save']).orderBy('name')) as { name: string; side_effect: string; status: string; tenant_id: string | null }[];
    expect(rows.map((r) => [r.name, r.side_effect, r.status, r.tenant_id])).toEqual([
      ['knowledge_list', 'read', 'published', null],
      ['knowledge_read', 'read', 'published', null],
      ['knowledge_save', 'write', 'published', null],
      ['memory_save', 'write', 'published', null],
      ['memory_search', 'read', 'published', null]
    ]);
  });

  it('knowledge_list and knowledge_read: the bases, their documents and one document in order, at the label of the call', async () => {
    const { curator, kb, call } = await setup();
    const paragraphs = Array.from({ length: 30 }, (_, i) => `## Section ${i + 1}\n\n${`Rule ${i + 1} of the travel policy covers case ${i + 1}. `.repeat(12)}`);
    await upload(curator, kb.id, 'travel.md', Buffer.from(`# Travel policy\n\nFIRST-MARKER opens the policy.\n\n${paragraphs.join('\n\n')}\n\nLAST-MARKER closes the policy.`)).expect(202);
    const draft = (await curator.post('/api/knowledge/bases', { name: 'Drafts', label: 'internal', embedModel: 'nomic-embed-text' }).expect(201)).body as { id: string };
    await drain(h);

    const bases = (await call('knowledge_list', {})).result as { bases: { id: string; name: string }[]; ceiling: string };
    expect(bases.bases.map((b) => b.name)).toEqual(['Handbook']);
    expect(bases.ceiling).toBe('internal');
    const listed = (await call('knowledge_list', { kbId: kb.id, q: 'travel' })).result as { documents: { id: string; name: string; sections: number }[] };
    expect(listed.documents).toMatchObject([{ name: 'travel.md' }]);
    expect((await call('knowledge_list', { kbId: draft.id })).error).toMatch(/not published/);

    // knowledge_search without kbIds searches every published base the caller may read.
    const hits = (await call('knowledge_search', { query: 'travel policy rule 7' })).result as { hits: { kb: string; document: string }[] };
    expect(hits.hits.length).toBeGreaterThan(0);
    expect(new Set(hits.hits.map((x) => `${x.kb}/${x.document}`))).toEqual(new Set(['Handbook/travel.md']));

    const id = listed.documents[0]!.id;
    type Read = { document: { name: string; kb: string }; sections: { n: number; text?: string }[]; total: number; next: number | null };
    let part = (await call('knowledge_read', { documentId: id, maxChars: 1500 })).result as Read;
    expect(part.document).toMatchObject({ name: 'travel.md', kb: 'Handbook' });
    expect(part.total).toBeGreaterThan(1);
    expect(part.next).not.toBeNull();
    const seen = [...part.sections];
    for (let i = 0; part.next != null && i < 100; i++) {
      part = (await call('knowledge_read', { documentId: id, from: part.next, maxChars: 1500 })).result as Read;
      seen.push(...part.sections);
    }
    expect(seen.map((s) => s.n)).toEqual(Array.from({ length: part.total }, (_, i) => i));
    const text = seen.map((s) => s.text).join('\n');
    expect(text).toContain('FIRST-MARKER');
    expect(text).toContain('LAST-MARKER');

    // Called from public data, the reader is public: the internal document is not there to read or list.
    expect((await call('knowledge_read', { documentId: id }, { label: 'public' })).error).toMatch(/not found/i);
    expect(((await call('knowledge_list', { kbId: kb.id }, { label: 'public' })).result as { documents: unknown[] }).documents).toEqual([]);
  });

  it('a built-in refused for its arguments says which one and why, so a model can correct the call', async () => {
    const { call } = await setup();
    const bad = await call('records.aggregate', { app: 'crm', entity: 'deals', metrics: [{ op: 'count', field: 'id' }] });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/Invalid request: The request did not validate\. metrics\.0/);
    const shaped = await call('records.query', { app: 'crm', entity: 'deals', filter: { state: 'open' } });
    expect(shaped.error).toMatch(/The filter did not validate\. A filter is one condition \{"field"/);
  });

  it('knowledge_save: a write that needs approval, for a base the caller may manage, scanned like an upload', async () => {
    const { kb, call } = await setup();
    const args = { kbId: kb.id, title: 'Vendor review: findings', content: 'The vendor meets the retention requirement.' };
    expect(await call('knowledge_save', args)).toMatchObject({ ok: false, needsApproval: true });
    const saved = (await call('knowledge_save', args, { approved: true })).result as { document: string; name: string; state: string; label: string };
    expect(saved).toMatchObject({ name: 'Vendor review: findings.md', state: 'quarantined', label: 'internal' });
    await drain(h);
    const docs = ((await call('knowledge_list', { kbId: kb.id })).result as { documents: { id: string; name: string }[] }).documents;
    expect(docs.map((d) => d.name)).toEqual(['Vendor review: findings.md']);
    const read = (await call('knowledge_read', { documentId: saved.document })).result as { sections: { text?: string }[] };
    expect(read.sections.map((s) => s.text).join('\n')).toContain('retention requirement');
    const audit = (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'knowledge.uploaded' })) as { detail: string }[];
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.detail)).toMatchObject({ via: 'tool', source: { kind: 'agent-run', id: 'R1' } });

    const member = await caller(await client(h, 'mem', ['member'], 'internal'));
    expect((await member('knowledge_save', args, { approved: true })).error).toMatch(/curator|manage/);
  });

  it('memory_save and memory_search: the caller\'s own memories, at the label of the call', async () => {
    const { call } = await setup();
    expect(await call('memory_save', { text: 'Prefers summaries of at most five lines.' })).toMatchObject({ ok: false, needsApproval: true });
    const saved = (await call('memory_save', { text: 'Prefers summaries of at most five lines.' }, { approved: true })).result as { memory: string };
    expect(saved).toMatchObject({ scope: 'user', type: 'user', state: 'active', label: 'internal' });
    expect((await call('memory_save', { text: 'The team says "the ledger" for the GL.', scope: 'workspace', type: 'episodic' }, { approved: true })).error).toMatch(/convention, glossary, contact/);
    expect((await call('memory_save', { text: 'password: hunter2hunter2' }, { approved: true })).ok).toBe(false);

    const found = (await call('memory_search', { query: 'how long should summaries be' })).result as { memories: { id: string; scope: string; text: string }[] };
    expect(found.memories).toMatchObject([{ id: saved.memory, scope: 'user', text: 'Prefers summaries of at most five lines.' }]);
    expect(((await call('memory_search', { query: 'summaries', scope: 'workspace' })).result as typeof found).memories).toEqual([]);
    // An internal memory is not recalled into public data.
    expect((await call('memory_search', { query: 'summaries' }, { label: 'public' })).result).toMatchObject({ memories: [], ceiling: 'public' });
    expect(await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'memory.added' }).count({ n: '*' })).toEqual([{ n: 1 }]);
  });
});
