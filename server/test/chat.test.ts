import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachRealtime } from '../src/realtime/socket.js';
import type { ProfileRow } from '../src/gateway/repo.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, login, type Harness } from './helpers.js';

const GB = 1_000_000_000;

/** A pool on the fake Ollama with approved models and published profiles, created through the repositories. */
async function seed(h: Harness, ollama: FakeOllama) {
  const repo = h.s.gateway.repo;
  ollama.addAvailable({ name: 'llama3.1:8b', size: 5 * GB, capabilities: ['completion', 'tools'] });
  ollama.addAvailable({ name: 'qwen3:8b', size: 6 * GB, capabilities: ['completion', 'thinking'] });
  const pool = await repo.createPool({ name: 'gpu', accelerator: 'cuda', zone: 'inference', labelCeiling: 'confidential' });
  await repo.createInstance({ poolId: pool.id, name: 'gpu-1', url: ollama.url, deploy: 'docker', settings: { parallel: 4 } });
  const models = [];
  for (const [name, caps] of [['llama3.1:8b', ['completion', 'tools']], ['qwen3:8b', ['completion', 'thinking']]] as const) {
    const m = await repo.createModel({ name, source: 'Ollama library', expectedDigest: null, license: { name: 'test' }, label: 'confidential', notes: null, requestedBy: 'x', requestedTenant: h.tenantId });
    await repo.updateModel(m.id, { state: 'approved', import_state: 'pulled', capabilities: [...caps], size_bytes: 5 * GB });
    await repo.place(m.id, pool.id, 'warm', 'x');
    models.push(m);
  }
  const profile = async (name: string, modelId: string, extra: Partial<ProfileRow> = {}) => {
    const t = Date.now();
    const row: ProfileRow = { id: `${name.toUpperCase().padEnd(26, '0')}`.slice(0, 26), tenant_id: h.tenantId, name, display_name: name, description: null, alias_of: null, model_id: modelId, pool_id: pool.id, num_ctx: 8192, temperature: 0.2, think_default: 'off', think_ceiling: 'off', system_prompt: 'Be brief.', fallback: null, canary: null, tools: [], label: 'internal', status: 'published', version: 1, updated_by: null, created_at: t, updated_at: t, ...extra };
    await repo.createProfile(row);
    return row;
  };
  const general = await profile('general', models[0]!.id, { tools: ['calculate'] });
  const thinker = await profile('thinker', models[1]!.id, { think_default: 'low', think_ceiling: 'medium' });
  const secret = await profile('secret', models[0]!.id, { label: 'confidential' });
  await h.s.gateway.pollAll();
  return { pool, general, thinker, secret };
}

describe('chat', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let server: Server;
  let url: string;
  let sockets: Socket[];

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    ollama = await new FakeOllama().start();
    server = createServer(h.app);
    attachRealtime(server, h.s);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    sockets = [];
  });
  afterEach(async () => {
    for (const s of sockets) s.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await h.close();
    await ollama.stop();
  });

  async function member(name = 'mem', clearance: 'internal' | 'confidential' = 'internal') {
    await localUser(h, name, ['member'], clearance);
    const c = await login(h, name);
    const sock = ioClient(url, { path: '/socket.io', transports: ['websocket'], reconnection: false, extraHeaders: { cookie: c.cookie } });
    sockets.push(sock);
    await new Promise((r) => sock.on('ready', r));
    const events: { event: string; data: Record<string, unknown> }[] = [];
    for (const e of ['chat.chunk', 'chat.status', 'chat.done', 'attachment.state']) sock.on(e, (data: Record<string, unknown>) => events.push({ event: e, data }));
    const done = (messageId: string) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const hit = events.find((x) => x.event === 'chat.done' && x.data.messageId === messageId);
        if (hit) return resolve(hit.data);
        sock.on('chat.done', (d: Record<string, unknown>) => d.messageId === messageId && resolve(d));
      });
    const post = (path: string, body: object = {}) => c.agent.post(path).set('x-csrf-token', c.csrf).send(body);
    return { ...c, sock, events, done, post };
  }

  it('lists only the profiles the caller is cleared for', async () => {
    await seed(h, ollama);
    const m = await member();
    const list = (await m.agent.get('/api/chat/profiles').expect(200)).body;
    expect(list.map((x: { name: string }) => x.name).sort()).toEqual(['general', 'thinker']);
    expect(list.find((x: { name: string }) => x.name === 'thinker')).toMatchObject({ thinkCeiling: 'medium', residency: 'cold' });
    const r = await m.post('/api/chat', { content: 'hi', profile: 'secret' }).expect(403);
    expect(r.body.step).toBe('clearance');
  });

  it('streams an answer with sequence numbers, seals it at rest, and meters it on the final chunk', async () => {
    await seed(h, ollama);
    const m = await member();
    const sent = await m.post('/api/chat', { content: 'Hello there', profile: 'general' }).expect(202);
    expect(sent.body).toMatchObject({ profile: 'general', model: 'llama3.1:8b', think: 'off' });
    const done = await m.done(sent.body.messageId);
    expect(done).toMatchObject({ state: 'complete', model: 'llama3.1:8b' });
    const chunks = m.events.filter((e) => e.event === 'chat.chunk' && e.data.messageId === sent.body.messageId).map((e) => e.data);
    expect(chunks.map((c) => c.seq)).toEqual(chunks.map((_, i) => i + 1));
    expect(chunks.map((c) => c.delta).join('')).toBe('You said: Hello there');
    const statuses = m.events.filter((e) => e.event === 'chat.status').map((e) => e.data.state);
    expect(statuses).toContain('loading'); // the model was cold
    expect(ollama.requests.find((r) => r.path === '/api/chat')!.body).toMatchObject({ model: 'llama3.1:8b', options: { num_ctx: 8192, temperature: 0.2 }, messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hello there' }] });

    const view = (await m.agent.get(`/api/conversations/${sent.body.conversationId}`).expect(200)).body;
    expect(view).toMatchObject({ title: 'Hello there', headId: sent.body.messageId });
    expect(view.messages[1]).toMatchObject({ role: 'assistant', content: 'You said: Hello there', state: 'complete', usage: { outputTokens: 4 } });
    const raw = await h.s.db('messages').where({ id: sent.body.messageId }).first();
    expect(raw.content).toMatch(/^v2\./);
    expect(raw.content).not.toContain('Hello');
    const usage = await h.s.db('usage_records').where({ message_id: sent.body.messageId });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ kind: 'chat', model: 'llama3.1:8b', output_tokens: 4 });
    expect(Number(usage[0].gpu_ms)).toBeGreaterThan(0);

    // a client that missed chunks catches up
    const resume = (await m.agent.get(`/api/conversations/${sent.body.conversationId}/messages/${sent.body.messageId}/stream?after=2`).expect(200)).body;
    expect(resume.state).toBe('complete');
    expect(resume.chunks.map((c: { seq: number }) => c.seq)).toEqual([3, 4]);
  });

  it('stops a stream, keeps what was produced, and estimates its usage', async () => {
    await seed(h, ollama);
    const m = await member();
    ollama.chatDelayMs = 40;
    ollama.reply = () => ({ content: 'one two three four five six seven eight nine ten eleven twelve' });
    const sent = await m.post('/api/chat', { content: 'count', profile: 'general' }).expect(202);
    await new Promise<void>((resolve) => {
      const check = () => (m.events.some((e) => e.event === 'chat.chunk' && e.data.messageId === sent.body.messageId) ? resolve() : setTimeout(check, 10));
      check();
    });
    await m.post(`/api/conversations/${sent.body.conversationId}/messages/${sent.body.messageId}/stop`).expect(200);
    const done = await m.done(sent.body.messageId);
    expect(done.state).toBe('stopped');
    const view = (await m.agent.get(`/api/conversations/${sent.body.conversationId}`).expect(200)).body;
    const msg = view.messages[1];
    expect(msg.state).toBe('stopped');
    expect(msg.content.length).toBeGreaterThan(0);
    expect(msg.content.length).toBeLessThan('one two three four five six seven eight nine ten eleven twelve'.length);
    expect((await h.s.db('usage_records').where({ message_id: sent.body.messageId }))[0].output_tokens).toBeGreaterThan(0);
  });

  it('branches: regenerate adds a sibling answer, edit adds a sibling question, and the head can move', async () => {
    await seed(h, ollama);
    const m = await member();
    const first = await m.post('/api/chat', { content: 'Question one', profile: 'general' }).expect(202);
    const cid = first.body.conversationId;
    await m.done(first.body.messageId);
    const regen = await m.post(`/api/conversations/${cid}/messages/${first.body.messageId}/regenerate`, { profile: 'thinker' }).expect(202);
    await m.done(regen.body.messageId);
    const edit = await m.post(`/api/conversations/${cid}/messages/${first.body.userMessageId}/edit`, { content: 'Question one, rephrased' }).expect(202);
    await m.done(edit.body.messageId);
    let view = (await m.agent.get(`/api/conversations/${cid}`).expect(200)).body;
    expect(view.messages).toHaveLength(5);
    const roots = view.messages.filter((x: { parentId: string | null }) => x.parentId === null);
    expect(roots.map((x: { content: string }) => x.content)).toEqual(['Question one', 'Question one, rephrased']);
    const answers = view.messages.filter((x: { parentId: string }) => x.parentId === first.body.userMessageId);
    expect(answers.map((x: { profile: string }) => x.profile)).toEqual(['general', 'thinker']);
    expect(view.headId).toBe(edit.body.messageId);
    await m.agent.patch(`/api/conversations/${cid}`).set('x-csrf-token', m.csrf).send({ headId: first.body.userMessageId }).expect(200);
    view = (await m.agent.get(`/api/conversations/${cid}`).expect(200)).body;
    expect(view.headId).toBe(regen.body.messageId); // the newest leaf under that question

    // a follow-up goes under the head
    const next = await m.post(`/api/conversations/${cid}/messages`, { content: 'And then?', profile: 'general' }).expect(202);
    await m.done(next.body.messageId);
    const history = ollama.requests.filter((r) => r.path === '/api/chat').pop()!.body.messages as { role: string; content: string }[];
    expect(history.map((x) => x.content)).toEqual(['Be brief.', 'Question one', 'You said: Question one', 'And then?']);
  });

  it('caps thinking at the profile ceiling and streams thinking separately', async () => {
    await seed(h, ollama);
    const m = await member();
    ollama.reply = () => ({ thinking: 'Let me think about it. ', content: 'Done.' });
    const sent = await m.post('/api/chat', { content: 'think', profile: 'thinker', think: 'high' }).expect(202);
    expect(sent.body.think).toBe('medium');
    await m.done(sent.body.messageId);
    expect(ollama.requests.find((r) => r.path === '/api/chat')!.body.think).toBe(true);
    const view = (await m.agent.get(`/api/conversations/${sent.body.conversationId}`).expect(200)).body;
    expect(view.messages[1]).toMatchObject({ thinking: 'Let me think about it. ', content: 'Done.', think: 'medium' });
    expect(view.messages[1].usage.thinkingTokens).toBeGreaterThan(0);
    const off = await m.post('/api/chat', { content: 'no think', profile: 'thinker', think: 'off' }).expect(202);
    await m.done(off.body.messageId);
    expect(ollama.requests.filter((r) => r.path === '/api/chat').pop()!.body.think).toBe(false);
  });

  it('hands calculations to the exact-calculation worker through the calculate tool', async () => {
    await seed(h, ollama);
    const m = await member();
    ollama.reply = (msgs) => {
      const last = msgs[msgs.length - 1]!;
      if (last.role === 'tool') return { content: `The monthly amount is ${JSON.parse(last.content).decimal.slice(0, 6)}.` };
      return { content: '', toolCall: { name: 'calculate', arguments: { expression: '(1250 * 1.07) / 12' } } };
    };
    const sent = await m.post('/api/chat', { content: 'What is 1250 plus 7 percent, per month?', profile: 'general' }).expect(202);
    await m.done(sent.body.messageId);
    const view = (await m.agent.get(`/api/conversations/${sent.body.conversationId}`).expect(200)).body;
    expect(view.messages[1].tools).toEqual([{ name: 'calculate', expression: '(1250 * 1.07) / 12', result: { fraction: '2675/24', decimal: '111.4583333333333333333333333333333333333333', exact: false } }]);
    expect(view.messages[1].content).toBe('The monthly amount is 111.45.');
    expect(view.messages[1].usage.calcCalls).toBe(1);
    const calc = await m.post('/api/calculate', { expression: '0.1 + 0.2' }).expect(200);
    expect(calc.body).toEqual({ fraction: '3/10', decimal: '0.3', exact: true });
    await m.post('/api/calculate', { expression: '1/0' }).expect(400);
  });

  it('refuses requests over the workspace quota with 429 and Retry-After', async () => {
    await seed(h, ollama);
    const w = await h.s.tenants.createWorkspace(h.tenantId, 'Field Sales', 'internal', { visibility: 'tenant' });
    const m = await member();
    const first = await m.post('/api/chat', { content: 'one', profile: 'general' }).expect(202);
    await m.done(first.body.messageId);
    await h.s.quotas.set(h.tenantId, w.id, { tokensPerDay: 5 }, 'test');
    const r = await m.post('/api/chat', { content: 'two', profile: 'general' }).expect(429);
    expect(r.headers['retry-after']).toBeDefined();
    expect(r.body).toMatchObject({ limit: 'tokens_per_day', scope: 'workspace', raised_by: 'a tenant admin' });
    expect(r.body.detail).toMatch(/Field Sales used/);
  });

  it('compares 2–4 profiles in parallel, metering each column', async () => {
    await seed(h, ollama);
    const m = await member();
    const cmp = await m.post('/api/compare', { prompt: 'Summarise', profiles: ['general', 'thinker'] }).expect(202);
    expect(cmp.body.columns.map((c: { profile: string }) => c.profile)).toEqual(['general', 'thinker']);
    await Promise.all(cmp.body.columns.map((c: { messageId: string }) => m.done(c.messageId)));
    const usage = await h.s.db('usage_records').where({ conversation_id: cmp.body.conversationId });
    expect(usage.map((u: { kind: string }) => u.kind)).toEqual(['compare', 'compare']);
    expect(new Set(usage.map((u: { model: string }) => u.model))).toEqual(new Set(['llama3.1:8b', 'qwen3:8b']));
    await m.post('/api/compare', { prompt: 'x', profiles: ['general'] }).expect(400);
    const list = (await m.agent.get('/api/conversations?kind=compare').expect(200)).body;
    expect(list).toHaveLength(1);
  });

  it('keeps data above a profile\'s label out of it', async () => {
    await seed(h, ollama);
    const m = await member('conf', 'confidential');
    const conv = await m.post('/api/conversations', { label: 'confidential' }).expect(201);
    const r = await m.post(`/api/conversations/${conv.body.id}/messages`, { content: 'secret numbers', profile: 'general' }).expect(403);
    expect(r.body.step).toBe('zone');
    const ok = await m.post(`/api/conversations/${conv.body.id}/messages`, { content: 'secret numbers', profile: 'secret' }).expect(202);
    await m.done(ok.body.messageId);
  });

  it('quarantines, scans and classifies attachments before a chat can use them', async () => {
    await seed(h, ollama);
    const m = await member();
    const up = (name: string, data: Buffer | string, type = 'text/plain') => m.agent.put(`/api/attachments?name=${encodeURIComponent(name)}`).set('x-csrf-token', m.csrf).set('content-type', type).send(Buffer.from(data));
    const notes = await up('notes.md', '# Q3\nRevenue grew in the north region.').expect(202);
    expect(notes.body.state).toBe('quarantined');
    const early = await m.post('/api/chat', { content: 'Summarise', profile: 'general', attachments: [notes.body.id] }).expect(409);
    expect(early.body.detail).toMatch(/quarantined/);
    const card = await up('cards.txt', 'Card on file: 4111 1111 1111 1111').expect(202);
    const bin = await up('archive.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]), 'application/zip').expect(202);
    const json = await up('data.json', '{"a": 1}', 'application/json').expect(202);
    await h.s.jobs.runDue();
    const get = async (id: string) => (await m.agent.get(`/api/attachments/${id}`).expect(200)).body;
    expect(await get(notes.body.id)).toMatchObject({ state: 'ready', type: 'text/markdown', label: 'internal' });
    expect(await get(card.body.id)).toMatchObject({ state: 'rejected', reason: 'Classified confidential, above your clearance.', findings: { detections: { payment_card: 1 } } });
    expect(await get(bin.body.id)).toMatchObject({ state: 'rejected' });
    expect(await get(json.body.id)).toMatchObject({ state: 'ready', type: 'application/json' });
    // nothing stays in quarantine; the stored file is sealed
    const row = await h.s.db('attachments').where({ id: notes.body.id }).first();
    expect(row.blob_key).toMatch(/^attachments\//);
    expect((await h.s.blobs.get(row.blob_key))!.toString()).toMatch(/^v2\./);

    const sent = await m.post('/api/chat', { content: 'Summarise', profile: 'general', attachments: [notes.body.id] }).expect(202);
    await m.done(sent.body.messageId);
    const last = ollama.requests.filter((r) => r.path === '/api/chat').pop()!.body.messages as { content: string }[];
    expect(last[1]!.content).toContain('<attachment name="notes.md" label="internal">');
    expect(last[1]!.content).toContain('Revenue grew');
  });

  it('falls back to another profile after the queue wait', async () => {
    const { general, thinker } = await seed(h, ollama);
    await h.s.gateway.repo.updateProfile(h.tenantId, general.id, { fallback: { profileId: thinker.id, afterQueueWaitMs: 50 } });
    await h.s.gateway.repo.updateInstance((await h.s.gateway.repo.instances())[0]!.id, { settings: { parallel: 1 } });
    await h.s.gateway.pollAll();
    const m = await member();
    let release!: () => void;
    ollama.hold = new Promise((r) => (release = r));
    const a = await m.post('/api/chat', { content: 'first', profile: 'general' }).expect(202);
    await new Promise((r) => setTimeout(r, 30));
    ollama.hold = null;
    const b = await m.post('/api/chat', { content: 'second', profile: 'general' }).expect(202);
    await new Promise((r) => setTimeout(r, 150));
    release();
    await m.done(a.body.messageId);
    const bd = await m.done(b.body.messageId);
    expect(bd).toMatchObject({ state: 'complete' });
    const statuses = m.events.filter((e) => e.event === 'chat.status' && e.data.messageId === b.body.messageId).map((e) => e.data);
    expect(statuses.some((s) => s.state === 'queued' && s.position === 1)).toBe(true);
    // the only slot was busy, so it waited in line; the fallback's model also shares that slot, so it completes after
    expect(statuses.some((s) => s.state === 'fallback' && s.profile === 'thinker')).toBe(true);
  });
});

