import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeOllama } from './fake-ollama.js';
import { harness, type Harness } from './helpers.js';
import { client, drain, seedRetrieval } from './retrieval-seed.js';

/**
 * The gateway slot deadlock (Backlog-1.4.0, "Before Sprint 24"): with one slot per instance, a chat turn that leased
 * the slot and then asked the knowledge provider for context waited for its own slot (the embedding and the reranker
 * need one too), so retrieval ran into the queue timeout and the answer went out without its context. Context is
 * now built before the chat lease.
 */
describe('chat with one slot per instance', () => {
  let h: Harness;
  let ollama: FakeOllama;

  beforeEach(async () => {
    ollama = await new FakeOllama().start();
    h = await harness({ OLLAMA_POLL_MS: '600000', OLLAMA_QUEUE_TIMEOUT_MS: '1500' });
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  it('retrieves knowledge context without waiting for the slot the turn itself holds', async () => {
    const { pool } = await seedRetrieval(h, ollama);
    const curator = await client(h, 'cura', ['member', 'knowledge-curator'], 'confidential');
    const kb = (await curator.post('/api/knowledge/bases', { name: 'Finance KB', label: 'internal', embedModel: 'nomic-embed-text', reranker: 'llama3.1:8b' }).expect(201)).body;
    await curator.agent
      .put(`/api/knowledge/bases/${kb.id}/uploads?name=Travel.md&label=public`)
      .set('x-csrf-token', curator.csrf)
      .set('content-type', 'application/octet-stream')
      .send(Buffer.from('# Travel budget\n\nQ3 travel: budget 361,500, actual 412,880. The Lisbon onboarding overran.'))
      .expect(202);
    await drain(h);
    await curator.patch(`/api/knowledge/bases/${kb.id}`, { status: 'published' }).expect(200);

    // one slot on the only instance
    const [inst] = (await h.s.gateway.repo.instances()).filter((i) => i.pool_id === pool.id);
    await h.s.gateway.repo.updateInstance(inst!.id, { settings: { ...inst!.settings, parallel: 1 } });
    await h.s.gateway.pollAll();
    const snap = await h.s.gateway.snapshot();
    expect(snap[0]!.instances[0]!.parallel).toBe(1);

    const conv = (await curator.post('/api/conversations', { title: 'Q3', label: 'internal' }).expect(201)).body;
    await curator.put(`/api/conversations/${conv.id}/knowledge`, { kbIds: [kb.id] }).expect(200);
    const before = { embed: ollama.requests.filter((r) => r.path === '/api/embed').length, chat: ollama.requests.filter((r) => r.path === '/api/chat').length };
    const sent = (await curator.post(`/api/conversations/${conv.id}/messages`, { content: 'How much did the Lisbon travel overrun?', profile: 'general' }).expect(202)).body;
    let state = '';
    for (let i = 0; i < 300 && state !== 'complete'; i++) {
      state = (await curator.get(`/api/conversations/${conv.id}`)).body.messages.find((x: { id: string }) => x.id === sent.messageId)?.state;
      if (state !== 'complete') await new Promise((r) => setTimeout(r, 20));
    }
    expect(state).toBe('complete');
    // the question was embedded and the candidates reranked (before the fix both waited out the queue for the slot the
    // turn held, so retrieval fell back to keywords and the reranker never ran)
    expect(ollama.requests.filter((r) => r.path === '/api/embed').length).toBeGreaterThan(before.embed);
    expect(ollama.requests.filter((r) => r.path === '/api/chat').length).toBeGreaterThan(before.chat + 1);
    const chat = ollama.requests.filter((r) => r.path === '/api/chat').pop()!.body as { messages: { role: string; content: string }[] };
    expect(chat.messages[0]).toEqual({ role: 'system', content: 'Be brief.' });
    expect(chat.messages[1]!.role).toBe('system');
    expect(chat.messages[1]!.content).toContain('412,880');
    const answer = (await curator.get(`/api/conversations/${conv.id}`)).body.messages.find((x: { id: string }) => x.id === sent.messageId);
    expect(answer.citations[0]).toMatchObject({ n: 1, kind: 'knowledge', kbId: kb.id });
    // the slot is free again
    expect((await h.s.gateway.snapshot())[0]!.instances[0]!.inflight).toBe(0);
  });
});
