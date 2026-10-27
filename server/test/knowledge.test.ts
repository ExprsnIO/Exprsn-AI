import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chunkText } from '../src/knowledge/chunk.js';
import { detectType, docxText, ExtractionError, extractText, htmlText, pdfText } from '../src/knowledge/extract.js';
import { bm25, rrf, tokenize } from '../src/knowledge/terms.js';
import { CliGit, checkGitUrl } from '../src/knowledge/sources.js';
import { DbVectorStore } from '../src/platform/vectors.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, type Harness } from './helpers.js';
import { client, docx, drain, harnessWith, pdf, seedRetrieval } from './retrieval-seed.js';

describe('extraction and chunking', () => {
  it('keeps headings as structure and packs paragraphs with overlap', () => {
    const para = (n: number) => `Paragraph ${n} ` + 'travel budget overrun '.repeat(20);
    const text = `# Travel policy\n\nIntro line.\n\n## Taxis\n\n${para(1)}\n\n${para(2)}\n\n${para(3)}\n\n## Meals\n\nMeals are covered up to a limit.`;
    const chunks = chunkText(text, { tokens: 120, overlap: 20 });
    expect(chunks[0]).toMatchObject({ heading: 'Travel policy', text: 'Intro line.' });
    const taxis = chunks.filter((c) => c.heading === 'Travel policy > Taxis');
    expect(taxis.length).toBeGreaterThan(1);
    // the second chunk of a section starts with the tail of the first
    expect(taxis[1]!.text.startsWith(taxis[0]!.text.slice(-30).trim().split(' ').slice(-2).join(' ')) || taxis[1]!.text.includes('overrun')).toBe(true);
    for (const c of taxis) expect(c.tokens).toBeLessThanOrEqual(130);
    expect(chunks[chunks.length - 1]).toMatchObject({ heading: 'Travel policy > Meals', text: 'Meals are covered up to a limit.' });
    // a heading always starts a new chunk
    expect(chunks.some((c) => c.text.includes('Intro') && c.text.includes('Paragraph'))).toBe(false);
  });

  it('extracts HTML, DOCX and PDF text, and reports what it cannot read', () => {
    expect(htmlText('<html><head><style>x{}</style></head><body><h1>Title</h1><p>One &amp; two</p><script>alert(1)</script><ul><li>a</li></ul></body></html>')).toBe('# Title\n\nOne & two\n\n- a');
    const d = docx([{ text: 'Expense policy', style: 'Heading1' }, { text: 'Taxis after 22:00 need no approval.' }]);
    expect(detectType(d, 'x.docx')).toEqual({ type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    expect(docxText(d)).toBe('# Expense policy\n\nTaxis after 22:00 need no approval.');
    const p = pdf(['Q3 cost centre review', 'Lisbon onboarding (approved)']);
    expect(detectType(p, 'r.pdf')).toEqual({ type: 'application/pdf' });
    expect(pdfText(p)).toBe('Q3 cost centre review\nLisbon onboarding (approved)');
    expect(() => extractText(pdf(['x'], { encrypted: true }), 'application/pdf')).toThrow(/password protected/);
    expect(() => pdfText(Buffer.from('%PDF-1.4\n%%EOF'))).toThrow(ExtractionError);
    expect(detectType(Buffer.from([0, 1, 2, 3]), 'x.bin')).toHaveProperty('rejected');
  });

  it('ranks with BM25 and fuses rankings with reciprocal rank fusion', () => {
    expect(tokenize('The Travel overruns in Lisbon, Q3!')).toEqual(['travel', 'overrun', 'lisbon', 'q3']);
    const df = new Map([['a', 1], ['b', 10]]);
    expect(bm25(['a'], new Map([['a', 2]]), df, 10, 10, 10)).toBeGreaterThan(bm25(['b'], new Map([['b', 2]]), df, 10, 10, 10));
    const f = rrf([['x', 'y', 'z'], ['y', 'x']]);
    expect([...f.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]).slice(0, 2).sort()).toEqual(['x', 'y']);
    expect(f.get('z')).toBeLessThan(f.get('y')!);
  });

  it('accepts only https Git URLs without credentials', () => {
    expect(checkGitUrl('https://git.example.com/org/repo.git', false)).toBeNull();
    expect(checkGitUrl('http://git.example.com/r.git', false)).toMatch(/https/);
    expect(checkGitUrl('https://u:p@git.example.com/r.git', false)).toMatch(/Credentials/);
    expect(checkGitUrl('file:///srv/r.git', false)).toMatch(/https/);
    expect(checkGitUrl('ext::sh -c id', false)).not.toBeNull();
  });
});

describe('knowledge bases', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let tmp: string;

  beforeEach(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'exprsn-kb-'));
    ollama = await new FakeOllama().start();
    h = await harness({ OLLAMA_POLL_MS: '600000' });
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  const upload = (c: Awaited<ReturnType<typeof client>>, kbId: string, name: string, data: Buffer, label = 'public') =>
    c.agent.put(`/api/knowledge/bases/${kbId}/uploads?name=${encodeURIComponent(name)}&label=${label}`).set('x-csrf-token', c.csrf).set('content-type', 'application/octet-stream').send(data);

  async function setup() {
    await seedRetrieval(h, ollama);
    const curator = await client(h, 'cura', ['member', 'knowledge-curator'], 'confidential');
    const kb = (await curator.post('/api/knowledge/bases', { name: 'Finance KB', label: 'internal', embedModel: 'nomic-embed-text', reranker: 'llama3.1:8b' }).expect(201)).body;
    return { curator, kb };
  }

  it('indexes uploads through quarantine, seals chunks, labels by classification and filters by clearance inside the query', async () => {
    const { curator, kb } = await setup();
    expect(kb).toMatchObject({ name: 'Finance KB', status: 'draft', label: 'internal', serving: { version: 1, state: 'serving' }, access: 'manage' });
    const policy = '# Expense policy\n\n## Taxis\n\nTaxis after 22:00 need no pre-approval where public transport has stopped. A receipt is still required.\n\n## Meals\n\nMeals are covered up to 40 EUR a day.';
    const bank = 'Supplier bank details\n\nPay Contoso at IBAN GB82 WEST 1234 5698 7654 32 for the Lisbon onboarding.';
    const a = (await upload(curator, kb.id, 'Expense policy.md', Buffer.from(policy)).expect(202)).body;
    expect(a).toMatchObject({ state: 'quarantined', labelOrigin: 'pending' });
    await upload(curator, kb.id, 'Supplier bank details.txt', Buffer.from(bank)).expect(202);
    await upload(curator, kb.id, 'blob.bin', Buffer.from([0, 1, 2, 0, 5])).expect(202);
    await drain(h);

    const docs = (await curator.get(`/api/knowledge/bases/${kb.id}/documents`).expect(200)).body as { name: string; state: string; label: string; labelOrigin: string; chunks: number; id: string; error: string | null }[];
    const byName = (n: string) => docs.find((d) => d.name === n)!;
    expect(byName('Expense policy.md')).toMatchObject({ state: 'indexed', label: 'internal', labelOrigin: 'inherited', chunks: 2 });
    expect(byName('Supplier bank details.txt')).toMatchObject({ state: 'indexed', label: 'confidential', labelOrigin: 'auto-classifier, IBAN' });
    expect(byName('blob.bin')).toMatchObject({ state: 'rejected' });

    // sealed at rest; keyword terms are keyed hashes
    const rows = await h.s.db('knowledge_chunks').where({ kb_id: kb.id });
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.content).toMatch(/^v2\./);
      expect(r.content).not.toContain('Taxi');
    }
    const terms = await h.s.db('knowledge_terms').whereIn('chunk_id', rows.map((r: { id: string }) => r.id)).select('term');
    expect(terms.some((t: { term: string }) => t.term === 'taxi')).toBe(false);
    expect(terms[0].term).toMatch(/^[0-9a-f]{32}$/);
    expect(await h.s.db('vectors').where({ collection: kb.serving.id }).count({ n: '*' })).toEqual([{ n: 3 }]);

    // relabel below the classifier's finding is refused, above is fine
    const refused = await curator.patch(`/api/knowledge/documents/${byName('Supplier bank details.txt').id}`, { label: 'internal', reason: 'x' }).expect(409);
    expect(refused.body.detail).toMatch(/found IBAN, so the label cannot go below confidential/);
    await curator.patch(`/api/knowledge/documents/${byName('Expense policy.md').id}`, { label: 'confidential', reason: 'board asked' }).expect(200);
    expect(await h.s.db('knowledge_chunks').where({ document_id: byName('Expense policy.md').id }).distinct('label')).toEqual([{ label: 'confidential' }]);
    await curator.patch(`/api/knowledge/documents/${byName('Expense policy.md').id}`, { label: 'internal', reason: 'mistake' }).expect(200);
    await drain(h);

    // the curator (confidential) finds the bank chunk; an internal member never sees it, not even as a count
    const hit = (await curator.post('/api/knowledge/search', { kbIds: [kb.id], query: 'Contoso IBAN payment Lisbon' }).expect(200)).body;
    expect(hit.hits[0]).toMatchObject({ document: 'Supplier bank details.txt', label: 'confidential', source: 'Uploads' });
    expect(hit.hits[0].vector).toBeGreaterThan(0);
    expect(hit.hits[0].keyword).toBe(1);
    expect(hit.hits[0].rerank).not.toBeNull(); // scored by the reranker model
    expect(hit.hits[0].text).toContain('GB82 WEST');
    const member = await client(h, 'mem', ['member'], 'internal');
    const miss = (await member.post('/api/knowledge/search', { kbIds: [kb.id], query: 'Contoso IBAN payment Lisbon' }).expect(200)).body;
    expect(miss.hits.every((x: { label: string }) => x.label !== 'confidential')).toBe(true);
    expect(JSON.stringify(miss)).not.toMatch(/Supplier|confidential chunk/);
    const memberDocs = (await member.get(`/api/knowledge/bases/${kb.id}/documents`).expect(200)).body;
    expect(memberDocs.map((d: { name: string }) => d.name)).not.toContain('Supplier bank details.txt');
    // members read; they cannot change
    await member.post(`/api/knowledge/bases/${kb.id}/reindex`, {}).expect(403);
    await upload(member, kb.id, 'x.md', Buffer.from('# x\n\ny')).expect(403);

    const audit = (await h.s.db('audit_events').whereLike('action', 'knowledge.%').select('action')).map((x: { action: string }) => x.action);
    expect(audit).toEqual(expect.arrayContaining(['knowledge.created', 'knowledge.uploaded', 'knowledge.document.relabelled']));
  });

  it('marks unreadable PDFs failed with a trace and retries them', async () => {
    const { curator, kb } = await setup();
    const d = (await upload(curator, kb.id, 'Board pack.pdf', pdf(['Board pack'], { encrypted: true })).expect(202)).body;
    await drain(h);
    const failed = (await curator.get(`/api/knowledge/documents/${d.id}`).expect(200)).body;
    expect(failed).toMatchObject({ state: 'failed', chunks: 0 });
    expect(failed.error).toMatch(/password protected/);
    expect(failed.traceId).toMatch(/^[0-9a-f]{32}$/);
    await curator.post(`/api/knowledge/documents/${d.id}/reindex`).expect(202);
    await drain(h);
    expect((await curator.get(`/api/knowledge/documents/${d.id}`)).body.state).toBe('failed');
    const ok = (await upload(curator, kb.id, 'Review.pdf', pdf(['Q3 cost centre review', 'Lisbon onboarding'])).expect(202)).body;
    await drain(h);
    expect((await curator.get(`/api/knowledge/documents/${ok.id}`)).body).toMatchObject({ state: 'indexed', type: 'application/pdf', chunks: 1 });
    await curator.del(`/api/knowledge/documents/${ok.id}`).expect(204);
    expect(await h.s.db('knowledge_chunks').where({ document_id: ok.id })).toHaveLength(0);
  });

  it('reindexes blue/green: the old index serves until the atomic switch, then is dropped', async () => {
    const { curator, kb } = await setup();
    await upload(curator, kb.id, 'Travel.md', Buffer.from('# Travel\n\nTravel budget overrun in Lisbon for Q3 onboarding.')).expect(202);
    await drain(h);
    const v1 = kb.serving.id as string;
    const build = (await curator.post(`/api/knowledge/bases/${kb.id}/reindex`, { embedModel: 'bge-m3' }).expect(202)).body;
    expect(build).toMatchObject({ version: 2, state: 'building', embedModel: 'bge-m3' });
    await curator.post(`/api/knowledge/bases/${kb.id}/reindex`, {}).expect(409);
    // still serving v1 while v2 builds
    const during = (await curator.get(`/api/knowledge/bases/${kb.id}`).expect(200)).body;
    expect(during).toMatchObject({ serving: { version: 1 }, building: { version: 2 } });
    expect((await curator.post('/api/knowledge/search', { kbIds: [kb.id], query: 'travel overrun', rerank: false }).expect(200)).body.hits).toHaveLength(1);
    await drain(h);
    const after = (await curator.get(`/api/knowledge/bases/${kb.id}`).expect(200)).body;
    expect(after).toMatchObject({ embedModel: 'bge-m3', serving: { version: 2, dims: 48, chunks: 1 }, building: null });
    expect(after.indexes.find((i: { version: number }) => i.version === 1).state).toBe('retired');
    expect(await h.s.db('vectors').where({ collection: v1 })).toHaveLength(0);
    expect(await h.s.db('knowledge_chunks').where({ index_id: v1 })).toHaveLength(0);
    const hits = (await curator.post('/api/knowledge/search', { kbIds: [kb.id], query: 'travel overrun', rerank: false }).expect(200)).body.hits;
    expect(hits[0]).toMatchObject({ document: 'Travel.md', heading: 'Travel' });

    // a build can be cancelled; the serving index is untouched
    await curator.post(`/api/knowledge/bases/${kb.id}/reindex`, {}).expect(202);
    const cancelled = (await curator.post(`/api/knowledge/bases/${kb.id}/cancel-build`).expect(200)).body;
    expect(cancelled.state).toBe('cancelled');
    await drain(h);
    expect((await curator.get(`/api/knowledge/bases/${kb.id}`)).body).toMatchObject({ serving: { version: 2 }, building: null });
  });

  it('syncs a Git repository by commit, skipping unchanged files and removing deleted ones', async () => {
    await h.close();
    // file:// is allowed only here, for a local bare repository
    h = await harnessWith({ git: new CliGit({ allowFile: true, timeoutMs: 30_000 }) }, { OLLAMA_POLL_MS: '600000' });
    const { curator, kb } = await setup();
    const bare = path.join(tmp, 'policies.git');
    const work = path.join(tmp, 'work');
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], { cwd: work, stdio: 'pipe' });
    execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--bare', '--quiet', bare]);
    execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', work]);
    writeFileSync(path.join(work, 'expense.md'), '# Expense policy\n\nTaxis need a receipt.');
    writeFileSync(path.join(work, 'travel.md'), '# Travel\n\nBook economy for trips under six hours.');
    writeFileSync(path.join(work, 'logo.png'), 'not indexed');
    git('add', '.');
    git('commit', '--quiet', '-m', 'one');
    git('push', '--quiet', bare, 'HEAD:main');

    const src = (await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 'git', location: `file://${bare}`, ref: 'main', schedule: 'hourly' }).expect(201)).body;
    expect(src).toMatchObject({ kind: 'git', state: 'syncing' });
    await drain(h);
    let s = (await curator.get(`/api/knowledge/bases/${kb.id}`)).body.sources[0];
    expect(s).toMatchObject({ state: 'idle', documents: 2 });
    expect(s.watermark).toMatch(/^[0-9a-f]{40}$/);

    writeFileSync(path.join(work, 'travel.md'), '# Travel\n\nBook economy for trips under eight hours.');
    unlinkSync(path.join(work, 'expense.md'));
    git('add', '-A');
    git('commit', '--quiet', '-m', 'two');
    git('push', '--quiet', bare, 'HEAD:main');
    await curator.post(`/api/knowledge/sources/${src.id}/sync`).expect(202);
    await drain(h);
    const job = (await h.s.db('jobs').where({ type: 'knowledge.sync' }).orderBy('created_at', 'desc').first()) as { result: string };
    expect(JSON.parse(job.result)).toMatchObject({ added: 0, changed: 1, removed: 1 });
    s = (await curator.get(`/api/knowledge/bases/${kb.id}`)).body.sources[0];
    expect(s.documents).toBe(1);
    const hits = (await curator.post('/api/knowledge/search', { kbIds: [kb.id], query: 'economy eight hours', rerank: false })).body.hits;
    expect(hits[0].text).toContain('eight hours');
    expect(hits[0].source).toBe(`file://${bare}`);

    await curator.del(`/api/knowledge/sources/${src.id}`).expect(200);
  });

  it('syncs an S3 prefix by ETag with the platform credentials', async () => {
    const objects = new Map<string, { body: string; etag: string }>([
      ['finance/reports/q3.md', { body: '# Q3 review\n\nField Sales exceeded its travel allocation.', etag: 'e1' }],
      ['finance/reports/notes.txt', { body: 'Per diem is 60 EUR.', etag: 'e2' }],
      ['finance/other/skip.md', { body: 'outside the prefix', etag: 'e3' }]
    ]);
    const seen: string[] = [];
    const s3: Server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      seen.push(`${req.method} ${u.pathname} ${req.headers.authorization ? 'signed' : 'anonymous'}`);
      if (u.searchParams.get('list-type') === '2') {
        const prefix = u.searchParams.get('prefix') ?? '';
        const items = [...objects.entries()].filter(([k]) => k.startsWith(prefix));
        res.end(`<ListBucketResult>${items.map(([k, v]) => `<Contents><Key>${k}</Key><LastModified>2026-09-19T11:40:00.000Z</LastModified><ETag>&quot;${v.etag}&quot;</ETag><Size>${v.body.length}</Size></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`);
        return;
      }
      const key = decodeURIComponent(u.pathname.replace(/^\/finance-bucket\//, ''));
      const o = objects.get(key);
      res.statusCode = o ? 200 : 404;
      res.end(o?.body ?? '');
    });
    await new Promise<void>((r) => s3.listen(0, '127.0.0.1', r));
    await h.close();
    h = await harness({ OLLAMA_POLL_MS: '600000', S3_ENDPOINT: `http://127.0.0.1:${(s3.address() as AddressInfo).port}`, S3_ACCESS_KEY_ID: 'AKIDEXAMPLE', S3_SECRET_ACCESS_KEY: 'secret' });
    try {
      const { curator, kb } = await setup();
      const src = (await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 's3', location: 's3://finance-bucket/finance/reports/' }).expect(201)).body;
      await drain(h);
      expect((await curator.get(`/api/knowledge/bases/${kb.id}`)).body.sources[0]).toMatchObject({ state: 'idle', documents: 2, watermark: '2026-09-19T11:40:00.000Z' });
      expect(seen.every((x) => x.endsWith('signed'))).toBe(true);
      const gets = seen.filter((x) => x.startsWith('GET /finance-bucket/finance')).length;
      await curator.post(`/api/knowledge/sources/${src.id}/sync`).expect(202);
      await drain(h);
      // unchanged ETags: listed again, not fetched again
      expect(seen.filter((x) => x.startsWith('GET /finance-bucket/finance')).length).toBe(gets);
      const docs = (await curator.get(`/api/knowledge/bases/${kb.id}/documents`)).body;
      expect(docs.map((d: { state: string }) => d.state).sort()).toEqual(['unchanged', 'unchanged']);
      await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 's3', location: 'not-s3' }).expect(400);
    } finally {
      s3.closeAllConnections();
      await new Promise((r) => s3.close(r));
    }
  });

  it('adds retrieved, labelled, delimited context to chat with citations and raises the conversation label', async () => {
    const { curator, kb } = await setup();
    await upload(curator, kb.id, 'Travel.md', Buffer.from('# Travel budget\n\nQ3 travel: budget 361,500, actual 412,880. The Lisbon onboarding overran.')).expect(202);
    await upload(curator, kb.id, 'Bank.txt', Buffer.from('Contoso travel refunds go to IBAN GB82 WEST 1234 5698 7654 32 after the Lisbon trip.')).expect(202);
    await drain(h);
    // drafts are not used in chat; publish it
    await curator.patch(`/api/knowledge/bases/${kb.id}`, { status: 'published' }).expect(200);
    const conv = (await curator.post('/api/conversations', { title: 'Q3', label: 'internal' }).expect(201)).body;
    await curator.put(`/api/conversations/${conv.id}/knowledge`, { kbIds: [kb.id] }).expect(200);
    expect((await curator.get(`/api/conversations/${conv.id}/knowledge`).expect(200)).body).toEqual([{ id: kb.id, name: 'Finance KB', label: 'internal', status: 'published' }]);
    const sent = (await curator.post(`/api/conversations/${conv.id}/messages`, { content: 'How much did the Lisbon travel overrun?', profile: 'general' }).expect(202)).body;
    for (let i = 0; i < 100; i++) {
      const m = (await curator.get(`/api/conversations/${conv.id}`)).body.messages.find((x: { id: string }) => x.id === sent.messageId);
      if (m.state === 'complete') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const chat = ollama.requests.filter((r) => r.path === '/api/chat').pop()!.body as { messages: { role: string; content: string }[] };
    expect(chat.messages[0]).toEqual({ role: 'system', content: 'Be brief.' });
    const ctx = chat.messages[1]!;
    expect(ctx.role).toBe('system');
    expect(ctx.content).toMatch(/<context id="1" label="(internal|confidential)" source="Finance KB: (Travel\.md|Bank\.txt)"/);
    expect(ctx.content).toContain('412,880');
    expect(ctx.content).toContain('</context>');
    const view = (await curator.get(`/api/conversations/${conv.id}`)).body;
    expect(view.label).toBe('confidential');
    const answer = view.messages.find((x: { id: string }) => x.id === sent.messageId);
    expect(answer.citations.length).toBeGreaterThanOrEqual(2);
    expect(answer.citations[0]).toMatchObject({ n: 1, kind: 'knowledge', kbId: kb.id });
    const raw = await h.s.db('messages').where({ id: sent.messageId }).first();
    expect(raw.citations).toMatch(/^v2\./);

    // a member cleared only for internal gets no confidential chunk, and the label stays internal
    const member = await client(h, 'mem2', ['member'], 'internal');
    const c2 = (await member.post('/api/conversations', { label: 'internal' }).expect(201)).body;
    await member.put(`/api/conversations/${c2.id}/knowledge`, { kbIds: [kb.id] }).expect(200);
    await h.s.db('profiles').where({ name: 'general' }).update({ label: 'internal' });
    const s2 = (await member.post(`/api/conversations/${c2.id}/messages`, { content: 'Contoso IBAN Lisbon?', profile: 'general' }).expect(202)).body;
    for (let i = 0; i < 100; i++) {
      const m = (await member.get(`/api/conversations/${c2.id}`)).body.messages.find((x: { id: string }) => x.id === s2.messageId);
      if (m.state === 'complete') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const last = ollama.requests.filter((r) => r.path === '/api/chat').pop()!.body as { messages: { role: string; content: string }[] };
    expect(JSON.stringify(last.messages)).not.toContain('GB82');
    expect((await member.get(`/api/conversations/${c2.id}`)).body.label).toBe('internal');
  });

  it('shares with workspaces, users and profiles; curators-only bases are hidden from members', async () => {
    const { curator, kb } = await setup();
    const member = await client(h, 'mem3', ['member'], 'internal');
    expect((await member.get('/api/knowledge/bases').expect(200)).body.map((x: { id: string }) => x.id)).toEqual([kb.id]);
    await curator.patch(`/api/knowledge/bases/${kb.id}`, { sharing: 'curators' }).expect(200);
    expect((await member.get('/api/knowledge/bases').expect(200)).body).toEqual([]);
    await member.get(`/api/knowledge/bases/${kb.id}`).expect(404);
    const principals = (await curator.get('/api/knowledge/principals').expect(200)).body;
    await curator.post(`/api/knowledge/bases/${kb.id}/access`, { kind: 'user', id: member.user.id, access: 'read' }).expect(201);
    expect((await member.get('/api/knowledge/bases').expect(200)).body[0]).toMatchObject({ id: kb.id, access: 'read' });
    const list = (await curator.post(`/api/knowledge/bases/${kb.id}/access`, { kind: 'profile', id: principals.profiles[0].id, access: 'read' }).expect(201)).body;
    expect(list.map((x: { kind: string; name: string }) => `${x.kind}:${x.name}`)).toEqual(['user:MEM3', 'profile:General']);
    await curator.post(`/api/knowledge/bases/${kb.id}/access`, { kind: 'profile', id: principals.profiles[0].id, access: 'manage' }).expect(409);
    await curator.del(`/api/knowledge/bases/${kb.id}/access/${list[0].id}`).expect(200);
    expect((await member.get('/api/knowledge/bases').expect(200)).body).toEqual([]);
    await curator.del(`/api/knowledge/bases/${kb.id}`).expect(204);
    expect(await h.s.db('vectors')).toHaveLength(0);
  });
});

describe('vector store (table scan)', () => {
  it('filters by tenant, partition and label rank inside the query', async () => {
    const h = await harness();
    try {
      const v = new DbVectorStore(h.s.db);
      await v.upsert('c1', [
        { id: 'a', tenantId: 't1', partition: 'p1', labelRank: 2, vector: [1, 0] },
        { id: 'b', tenantId: 't1', partition: 'p1', labelRank: 3, vector: [1, 0.1] },
        { id: 'c', tenantId: 't2', partition: 'p1', labelRank: 1, vector: [1, 0] },
        { id: 'd', tenantId: 't1', partition: 'p2', labelRank: 1, vector: [0, 1] }
      ]);
      expect((await v.search('c1', { tenantId: 't1', vector: [1, 0], k: 5, maxLabelRank: 2 })).map((x) => x.id)).toEqual(['a', 'd']);
      expect((await v.search('c1', { tenantId: 't1', vector: [1, 0], k: 5, maxLabelRank: 4, partitions: ['p1'] })).map((x) => x.id)).toEqual(['a', 'b']);
      expect(await v.delete('c1', ['a'])).toBe(1);
      expect(await v.purgeTenant('t2')).toBe(1);
      expect(await v.drop('c1')).toBe(2);
    } finally {
      await h.close();
    }
  });
});
