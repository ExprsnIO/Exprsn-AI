import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractProposals } from '../src/memory/service.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, type Harness } from './helpers.js';
import { client, drain, seedRetrieval } from './retrieval-seed.js';

describe('memory proposals from text', () => {
  it('proposes from explicit phrases only', () => {
    expect(extractProposals('Please remember that I report travel figures in EUR, net of VAT. Thanks!')).toEqual(['I report travel figures in EUR, net of VAT']);
    expect(extractProposals('I prefer tables over prose for variance analysis.')).toEqual(['Prefers tables over prose for variance analysis']);
    expect(extractProposals("I'm working on the Q3 close for Finance Ops")).toEqual(['Current project: the Q3 close for Finance Ops']);
    expect(extractProposals('My manager is Priya Nair.')).toEqual(['Manager: Priya Nair']);
    expect(extractProposals('What was the Q3 travel overrun?')).toEqual([]);
  });
});

describe('memory', () => {
  let h: Harness;
  let ollama: FakeOllama;

  beforeEach(async () => {
    ollama = await new FakeOllama().start();
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    await seedRetrieval(h, ollama);
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  async function waitDone(c: Awaited<ReturnType<typeof client>>, conversationId: string, messageId: string) {
    for (let i = 0; i < 200; i++) {
      const m = (await c.get(`/api/conversations/${conversationId}`)).body.messages.find((x: { id: string }) => x.id === messageId);
      if (m && m.state !== 'queued' && m.state !== 'streaming') return m;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('answer did not finish');
  }

  it('adds, edits with versions, refuses restricted and credentials, and forgets everywhere', async () => {
    const me = await client(h, 'mara', ['member'], 'confidential');
    const added = (await me.post('/api/memory', { text: 'Current project: Q3 close for Finance Ops', label: 'internal', expiresAt: Date.now() + 86_400_000 }).expect(201)).body;
    expect(added).toMatchObject({ scope: 'user', type: 'user', state: 'active', origin: 'manual', label: 'internal', embedded: true, version: 1, author: 'MARA' });
    expect(added.history).toEqual([expect.objectContaining({ version: 1, note: 'added here', actor: 'MARA' })]);
    const raw = await h.s.db('memories').where({ id: added.id }).first();
    expect(raw.content).toMatch(/^v2\./);
    expect(raw.content).not.toContain('Finance Ops');
    expect(await h.s.db('vectors').where({ collection: 'memory', id: added.id })).toHaveLength(1);

    const restricted = (await me.post('/api/memory', { text: 'Supplier IBAN for Contoso payments', label: 'restricted' }).expect(403)).body;
    expect(restricted.step).toBe('clearance');
    const boss = await client(h, 'boss', ['member'], 'restricted');
    expect((await boss.post('/api/memory', { text: 'Supplier IBAN for Contoso payments', label: 'restricted' }).expect(422)).body.detail).toMatch(/Tenant policy does not allow restricted memories/);
    expect((await me.post('/api/memory', { text: 'My password for the ledger is hunter2', label: 'internal' }).expect(422)).body.detail).toMatch(/credential/);

    const edited = (await me.patch(`/api/memory/${added.id}`, { text: 'Current project: Q3 and Q4 close', label: 'confidential' }).expect(200)).body;
    expect(edited).toMatchObject({ text: 'Current project: Q3 and Q4 close', label: 'confidential', version: 2 });
    expect(edited.history[0]).toMatchObject({ version: 2, note: 'edited, relabelled confidential' });
    await me.patch(`/api/memory/${added.id}`, { text: 'api key is abc' }).expect(422);
    const exp = (await me.patch(`/api/memory/${added.id}`, { expiresAt: null }).expect(200)).body;
    expect(exp).toMatchObject({ expiresAt: null, version: 3 });

    // export, then forget: the record, its versions, its vector and the export file all go
    const x = (await me.post('/api/memory/exports', { tab: 'mine', format: 'json' }).expect(202)).body;
    await drain(h);
    expect((await me.get(`/api/memory/exports/${x.id}`).expect(200)).body).toMatchObject({ state: 'ready', rows: 1, label: 'confidential' });
    const file = await me.get(`/api/memory/exports/${x.id}/download`).expect(200);
    expect(JSON.parse(file.text).memories[0]).toMatchObject({ text: 'Current project: Q3 and Q4 close', label: 'confidential' });
    const other = await client(h, 'other', ['member']);
    await other.get(`/api/memory/exports/${x.id}`).expect(404);
    await other.del(`/api/memory/${added.id}`).expect(404);

    const forgot = (await me.del(`/api/memory/${added.id}`).expect(200)).body;
    expect(forgot).toMatchObject({ vectors: 1, versions: 3, exports: 1 });
    expect(await h.s.db('memories').where({ id: added.id })).toHaveLength(0);
    expect(await h.s.db('memory_versions').where({ memory_id: added.id })).toHaveLength(0);
    expect(await h.s.db('vectors').where({ collection: 'memory', id: added.id })).toHaveLength(0);
    expect((await me.get(`/api/memory/exports/${x.id}`)).body.state).toBe('purged');
    await me.get(`/api/memory/exports/${x.id}/download`).expect(409);
    const audit = (await h.s.db('audit_events').whereLike('action', 'memory.%').select('action')).map((a: { action: string }) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['memory.added', 'memory.edited', 'memory.exported', 'memory.forgotten']));
  });

  it('lets members propose workspace memories and curators accept them', async () => {
    const ws = await h.s.tenants.createWorkspace(h.tenantId, 'Finance Ops', 'confidential', { visibility: 'tenant' });
    const member = await client(h, 'sam', ['member'], 'internal');
    const curator = await client(h, 'cura', ['member', 'knowledge-curator'], 'confidential');
    const p = (await member.post('/api/memory', { scope: 'workspace', type: 'contact', text: 'Treasury contact for FX rates: the treasury desk', label: 'internal' }).expect(201)).body;
    expect(p).toMatchObject({ scope: 'workspace', ownerId: ws.id, state: 'proposed' });
    await member.post(`/api/memory/${p.id}/accept`).expect(403);
    const other = await client(h, 'lena', ['member'], 'internal');
    expect((await other.get('/api/memory?tab=workspace').expect(200)).body.items).toEqual([]);
    const list = (await curator.get('/api/memory?tab=workspace').expect(200)).body;
    expect(list).toMatchObject({ curator: true, workspace: { name: 'Finance Ops' }, counts: { workspace: 1 } });
    expect(list.items[0]).toMatchObject({ state: 'proposed', author: 'SAM' });
    const ok = (await curator.post(`/api/memory/${p.id}/accept`).expect(200)).body;
    expect(ok).toMatchObject({ state: 'active', acceptedBy: 'CURA', version: 2 });
    expect((await other.get('/api/memory?tab=workspace').expect(200)).body.items[0]).toMatchObject({ text: 'Treasury contact for FX rates: the treasury desk', author: 'SAM' });
    const conv = (await curator.post('/api/memory', { scope: 'workspace', type: 'convention', text: 'Variance is actual minus budget', label: 'internal' }).expect(201)).body;
    expect(conv.state).toBe('active');
    await member.patch(`/api/memory/${conv.id}`, { text: 'x' }).expect(403);
    await curator.post('/api/memory', { scope: 'workspace', type: 'user', text: 'x', label: 'internal' }).expect(400);
  });

  it('proposes memories from chat, respects rejections, and recalls accepted memories into later turns', async () => {
    const me = await client(h, 'mara', ['member'], 'confidential');
    const first = (await me.post('/api/chat', { content: 'Please remember that I report travel figures in EUR, net of VAT.', profile: 'general', label: 'internal' }).expect(202)).body;
    await waitDone(me, first.conversationId, first.messageId);
    await drain(h);
    let mine = (await me.get('/api/memory?tab=mine').expect(200)).body;
    expect(mine.items).toHaveLength(1);
    const proposal = mine.items[0];
    expect(proposal).toMatchObject({ text: 'I report travel figures in EUR, net of VAT', state: 'proposed', origin: 'extraction', label: 'internal', sourceLabel: 'internal', source: { conversationId: first.conversationId, title: 'Please remember that I report travel figures in EUR, net of VAT.' } });
    await me.patch(`/api/memory/${proposal.id}`, { label: 'public' }).expect(409);

    // rejected: not proposed again
    await me.post(`/api/memory/${proposal.id}/reject`).expect(200);
    const again = (await me.post(`/api/conversations/${first.conversationId}/messages`, { content: 'Remember that I report travel figures in EUR, net of VAT.', profile: 'general' }).expect(202)).body;
    await waitDone(me, first.conversationId, again.messageId);
    await drain(h);
    expect((await me.get('/api/memory?tab=mine')).body.items).toEqual([]);

    const pref = (await me.post(`/api/conversations/${first.conversationId}/messages`, { content: 'I prefer tables over prose for variance analysis.', profile: 'general' }).expect(202)).body;
    await waitDone(me, first.conversationId, pref.messageId);
    await drain(h);
    mine = (await me.get('/api/memory?tab=mine')).body;
    const accepted = (await me.post(`/api/memory/${mine.items[0].id}/accept`).expect(200)).body;
    expect(accepted).toMatchObject({ text: 'Prefers tables over prose for variance analysis', state: 'active', embedded: true });

    const later = (await me.post('/api/chat', { content: 'Show the variance analysis for Q3.', profile: 'general', label: 'internal' }).expect(202)).body;
    const answer = await waitDone(me, later.conversationId, later.messageId);
    const req = ollama.requests.filter((r) => r.path === '/api/chat').pop()!.body as { messages: { role: string; content: string }[] };
    const ctx = req.messages.find((m) => m.role === 'system' && m.content.includes('<memory'))!;
    expect(ctx.content).toMatch(/<memory id="1" label="internal" scope="user" type="user">\nPrefers tables over prose for variance analysis\n<\/memory>/);
    expect(answer.citations).toEqual([expect.objectContaining({ n: 1, kind: 'memory', memoryId: accepted.id })]);

    // another user's memories never reach this user's prompts
    const other = await client(h, 'other', ['member'], 'confidential');
    const o = (await other.post('/api/chat', { content: 'Show the variance analysis for Q3.', profile: 'general', label: 'internal' }).expect(202)).body;
    await waitDone(other, o.conversationId, o.messageId);
    const req2 = ollama.requests.filter((r) => r.path === '/api/chat').pop()!.body as { messages: { role: string; content: string }[] };
    expect(JSON.stringify(req2.messages)).not.toContain('Prefers tables');
  });

  it('purges expired memories from every backend', async () => {
    const me = await client(h, 'mara', ['member'], 'internal');
    const m = (await me.post('/api/memory', { text: 'Manager is covering approvals until 30 Sep', label: 'internal', expiresAt: Date.now() + 60_000 }).expect(201)).body;
    await h.s.db('memories').where({ id: m.id }).update({ expires_at: Date.now() - 1 });
    expect(await h.s.memory.purgeExpired(h.tenantId)).toEqual({ purged: 1 });
    expect(await h.s.db('vectors').where({ collection: 'memory' })).toHaveLength(0);
    expect((await me.get('/api/memory')).body.items).toEqual([]);
  });
});
