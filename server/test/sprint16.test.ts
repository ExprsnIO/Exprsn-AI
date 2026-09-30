import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { io as ioClient, type Socket } from 'socket.io-client';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachRealtime } from '../src/realtime/socket.js';
import { TOPICS } from '../src/platform/bus.js';
import { CheckLimiter, StreamGuard, type Release } from '../src/guardrails/stream.js';
import type { GuardAction, GuardDecision } from '../src/guardrails/types.js';
import type { ProfileRow } from '../src/gateway/repo.js';
import { FakeOllama } from './fake-ollama.js';
import { seedGateway } from './seed-gateway.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';
import { client, drain, seedRetrieval } from './retrieval-seed.js';

const GB = 1_000_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(10);
  }
}

/** A screen that fires `action` when `trigger` appears in the text, after `delayMs` (a slow guard model). */
function screen(trigger: string | null, action: GuardAction = 'block', delayMs = 0) {
  const seen: string[] = [];
  const fn = async (text: string): Promise<GuardDecision> => {
    seen.push(text);
    if (delayMs) await sleep(delayMs);
    const at = trigger ? text.indexOf(trigger) : -1;
    if (at < 0) return { action: 'allow', text, findings: [] };
    return { action, text, findings: [{ ruleId: 'g', ruleName: 'Guard model', action, stage: 'enforce' }], reason: `${action} by the guard model` };
  };
  return Object.assign(fn, { seen });
}

const allow = async (text: string): Promise<GuardDecision> => ({ action: 'allow', text, findings: [] });

async function finished(h: Harness, messageId: string) {
  return until(async () => {
    const m = await h.s.db('messages').where({ id: messageId }).first();
    return m?.completed_at || m?.state === 'interrupted' ? m : null;
  }, 8000);
}

async function apiKey(h: Harness, userId: string) {
  return (await h.s.apiKeys.create({ tenantId: h.tenantId, userId, name: `k-${ulid()}`, scopes: ['inference:invoke', 'models:read', 'chat:read'] as never[], ttlDays: 30 })).key;
}

const send = (c: Client, method: 'post' | 'put' | 'patch' | 'delete', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);

async function publishRules(admin: Client, rules: object[], name = 'Sprint 16 rules') {
  const set = (await send(admin, 'post', '/api/admin/guardrails/sets', { name, scope: 'tenant' }).expect(201)).body;
  await send(admin, 'put', `/api/admin/guardrails/sets/${set.id}/draft`, { rules }).expect(200);
  await send(admin, 'post', `/api/admin/guardrails/sets/${set.id}/draft/publish`).expect(200);
  return set as { id: string };
}

/** A guard-model profile (llama-guard) beside the seeded pool's general profile. */
async function addGuardProfile(h: Harness, ollama: FakeOllama, poolId: string) {
  const repo = h.s.gateway.repo;
  ollama.addAvailable({ name: 'llama-guard3:8b', size: 5 * GB, capabilities: ['completion'] });
  const m = await repo.createModel({ name: 'llama-guard3:8b', source: 'Ollama library', expectedDigest: null, license: { name: 'test' }, label: 'confidential', notes: null, requestedBy: 'x', requestedTenant: h.tenantId });
  await repo.updateModel(m.id, { state: 'approved', import_state: 'pulled', capabilities: ['completion'], size_bytes: 5 * GB });
  await repo.place(m.id, poolId, 'warm', 'x');
  const t = Date.now();
  const row: ProfileRow = { id: 'LLAMAGUARD'.padEnd(26, '0'), tenant_id: h.tenantId, name: 'llama-guard', display_name: 'Guard', description: null, alias_of: null, model_id: m.id, pool_id: poolId, num_ctx: 8192, temperature: 0, think_default: 'off', think_ceiling: 'off', system_prompt: null, fallback: null, canary: null, tools: [], label: 'confidential', status: 'published', version: 1, updated_by: null, created_at: t, updated_at: t };
  await repo.createProfile(row);
  await h.s.gateway.pollAll();
}

// ---------------------------------------------------------------------------------------------------------------

describe('guard model while streaming (B-703): the stream guard', () => {
  it('holds a screened window until a clean verdict covers it, and never releases what the verdict blocks', async () => {
    const releases: Release[] = [];
    const model = screen('SECRETX', 'block', 15);
    const g = new StreamGuard(allow, undefined, { screen: model, holdback: 1, limiter: new CheckLimiter(4), onRelease: (r) => void releases.push(r) });
    // window 1 waits for its verdict; generation goes on (hold-back 1)
    expect((await g.push('Fine start. ')).text).toBe('');
    // window 2 is the second waiting window: the stream waits for the verdict on window 1, which releases it
    expect(await g.push('Then SECRETX here. ')).toMatchObject({ text: '' });
    expect(releases.map((r) => r.text).join('')).toBe('Fine start. ');
    // window 3: the verdict over windows 1 and 2 blocks, and nothing after window 1 is ever released
    const third = await g.push('And more. ');
    expect(third.halted).toBe(true);
    expect(releases.some((r) => r.halted)).toBe(true);
    await g.finish();
    expect(g.released).toBe('Fine start. ');
    expect(g.unreleased).toBe('');
    expect(model.seen.every((t) => !t.includes('And more'))).toBe(true);
  });

  it('with hold-back 0 releases at once and lets a verdict stop only what follows', async () => {
    const releases: Release[] = [];
    const g = new StreamGuard(allow, undefined, { screen: screen('SECRETX', 'block', 5), holdback: 0, limiter: new CheckLimiter(4), onRelease: (r) => void releases.push(r) });
    expect((await g.push('Then SECRETX here. ')).text).toBe('Then SECRETX here. ');
    await until(() => releases.some((r) => r.halted));
    expect((await g.push('After. ')).halted).toBe(true);
    expect(g.released).toBe('Then SECRETX here. ');
  });

  it('keeps the last windows for the full check, and a failed check stops release', async () => {
    const g = new StreamGuard(allow, undefined, { screen: screen(null, 'block', 5), holdback: 2, limiter: new CheckLimiter(1), onRelease: () => undefined });
    await g.push('One. ');
    await g.push('Two. ');
    await g.push('Three');
    await g.finish();
    expect(g.released + g.unreleased).toBe('One. Two. Three');
    g.markReleased();
    expect(g.released).toBe('One. Two. Three');
    const failing = new StreamGuard(allow, undefined, { screen: async () => Promise.reject(new Error('down')), holdback: 1, limiter: new CheckLimiter(1), onRelease: () => undefined });
    await failing.push('A. ');
    await failing.push('B. ');
    await failing.push('C. ');
    expect(failing.released).toBe('');
    await failing.finish();
    expect(failing.unreleased).toBe('A. B. C. ');
  });

  it('bounds the background checks an instance runs at once', async () => {
    const limiter = new CheckLimiter(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        limiter.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await sleep(5);
          active--;
        })
      )
    );
    expect(peak).toBe(2);
    expect(limiter.stats).toMatchObject({ started: 8, peak: 2 });
  });
});

describe('sprint 16: chat and AI depth', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let ga: Client;

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000', SHARE_ANONYMOUS_PER_MINUTE: '5' });
    ollama = await new FakeOllama().start();
    ollama.chatDelayMs = 2;
    await localUser(h, 'ga', ['guardrail-admin'], 'confidential');
    ga = await loginAdmin(h, 'ga');
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  async function member(name: string, clearance: 'public' | 'internal' | 'confidential' = 'internal') {
    const user = await localUser(h, name, ['member'], clearance);
    const c = await login(h, name);
    return { user, agent: c.agent, csrf: c.csrf, cookie: c.cookie, post: (url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body) };
  }

  const tap = () => {
    const events: { userId: string; event: string; data: Record<string, unknown> }[] = [];
    h.s.bus.on<{ userId: string; event: string; data: Record<string, unknown> }>(TOPICS.chatEvent, (e) => void events.push(e));
    return events;
  };

  // ---------- B-701 ----------

  it('/v1 cites a knowledge base the caller may read, and never one they may not (B-701)', async () => {
    await seedRetrieval(h, ollama);
    const curator = await client(h, 'cura', ['member', 'knowledge-curator'], 'confidential');
    const kb = async (name: string, sharing: 'members' | 'curators', doc: string) => {
      const b = (await curator.post('/api/knowledge/bases', { name, label: 'internal', embedModel: 'nomic-embed-text', sharing }).expect(201)).body;
      await curator.agent.put(`/api/knowledge/bases/${b.id}/uploads?name=${encodeURIComponent(name)}.md&label=internal`).set('x-csrf-token', curator.csrf).set('content-type', 'application/octet-stream').send(Buffer.from(doc)).expect(202);
      await drain(h);
      await curator.patch(`/api/knowledge/bases/${b.id}`, { status: 'published' }).expect(200);
      return b as { id: string };
    };
    const finance = await kb('Finance', 'members', 'Q3 travel: budget 361,500, actual 412,880. The Lisbon onboarding overran.');
    const board = await kb('Board', 'curators', 'Board minutes: the Lisbon acquisition price is 9,900,000.');
    const reader = await client(h, 'reader', ['member'], 'confidential');
    const key = await apiKey(h, reader.user.id);
    ollama.reply = () => ({ content: 'Travel came in at 412,880 against 361,500 [1].' });
    const ok = await request(h.app).post('/v1/chat/completions').set('authorization', `Bearer ${key}`).set('x-exprsn-knowledge', finance.id).send({ model: 'general', messages: [{ role: 'user', content: 'How much did the Lisbon travel overrun?' }] });
    expect(ok.body.error ?? null).toBeNull();
    expect(ok.body.choices[0].message.content).toBe('Travel came in at 412,880 against 361,500 [1].');
    expect(ok.body.exprsn.label).toBe('internal');
    expect(ok.body.exprsn.citations[0]).toMatchObject({ n: 1, kind: 'knowledge', kbId: finance.id, kb: 'Finance', label: 'internal' });
    expect(ok.body.exprsn.citations[0].passage).toContain('412,880');
    const toModel = ollama.requests.filter((x) => x.path === '/api/chat').pop()!.body.messages as { role: string; content: string }[];
    expect(toModel.find((m) => m.role === 'system' && m.content.includes('<context id="1"'))!.content).toContain('412,880');
    // a base the caller may not read is refused as if it did not exist, before anything reaches the model
    const before = ollama.requests.filter((x) => x.path === '/api/chat').length;
    const denied = await request(h.app).post('/v1/chat/completions').set('authorization', `Bearer ${key}`).set('x-exprsn-knowledge', `${finance.id},${board.id}`).send({ model: 'general', messages: [{ role: 'user', content: 'What is the Lisbon acquisition price?' }] }).expect(404);
    expect(denied.body.error).toMatchObject({ code: 'knowledge_base_not_found', param: 'X-Exprsn-Knowledge' });
    expect(ollama.requests.filter((x) => x.path === '/api/chat').length).toBe(before);
    expect(JSON.stringify(ollama.requests.filter((x) => x.path === '/api/chat'))).not.toContain('9,900,000');
    await request(h.app).post('/v1/chat/completions').set('authorization', `Bearer ${key}`).set('x-exprsn-knowledge', 'not-an-id').send({ model: 'general', messages: [{ role: 'user', content: 'x' }] }).expect(400);
    // without the header nothing is retrieved and no extension field is added
    const plain = await request(h.app).post('/v1/chat/completions').set('authorization', `Bearer ${key}`).send({ model: 'general', messages: [{ role: 'user', content: 'Hello' }] }).expect(200);
    expect(plain.body.exprsn).toBeUndefined();
    // the caller's memories, on request
    await reader.post('/api/memory', { text: 'Prefers answers in euros.', scope: 'user', label: 'internal' }).expect(201);
    const withMemory = await request(h.app).post('/v1/chat/completions').set('authorization', `Bearer ${key}`).set('x-exprsn-memory', 'on').send({ model: 'general', messages: [{ role: 'user', content: 'Which currency do I like?' }] }).expect(200);
    expect(withMemory.body.exprsn.citations[0]).toMatchObject({ kind: 'memory', scope: 'user' });
    expect(JSON.stringify(ollama.requests.filter((x) => x.path === '/api/chat').pop()!.body.messages)).toContain('Prefers answers in euros.');
    // streamed: the citations come with the last chunk
    const streamed = await request(h.app).post('/v1/chat/completions').set('authorization', `Bearer ${key}`).set('x-exprsn-knowledge', finance.id).send({ model: 'general', stream: true, messages: [{ role: 'user', content: 'How much did the Lisbon travel overrun?' }] }).expect(200);
    const chunks = streamed.text.split('\n\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)) as { exprsn?: { citations: { kbId: string }[] } });
    expect(chunks.find((c) => c.exprsn)!.exprsn!.citations[0]!.kbId).toBe(finance.id);
  });

  // ---------- B-702 ----------

  it('/v1 runs the profile tools on the server and returns only the final answer (B-702)', async () => {
    await seedGateway(h, ollama, { tools: ['calculate'], label: 'internal' });
    const m = await member('calc');
    const key = await apiKey(h, m.user.id);
    ollama.reply = (messages) => {
      const last = messages[messages.length - 1]!;
      if (last.role === 'tool') return { content: `The answer is ${(JSON.parse(last.content) as { decimal: string }).decimal}.` };
      return { content: '', toolCall: { name: 'calculate', arguments: { expression: '12 * (3 + 4)' } } };
    };
    const res = await request(h.app).post('/v1/chat/completions').set('authorization', `Bearer ${key}`).set('x-exprsn-tools', 'profile').send({ model: 'general', messages: [{ role: 'user', content: 'What is 12 times 7?' }] }).expect(200);
    expect(res.body.choices[0]).toMatchObject({ finish_reason: 'stop', message: { role: 'assistant', content: 'The answer is 84.' } });
    expect(res.body.choices[0].message.tool_calls).toBeUndefined();
    expect(res.body.exprsn.tools).toEqual([{ name: 'calculate', ok: true }]);
    // the model was offered the profile's tool, and saw the result on the second round
    const calls = ollama.requests.filter((x) => x.path === '/api/chat');
    expect((calls[calls.length - 2]!.body.tools as { function: { name: string } }[]).map((t) => t.function.name)).toEqual(['calculate']);
    expect((calls[calls.length - 1]!.body.messages as { role: string }[]).some((x) => x.role === 'tool')).toBe(true);
    const usage = await h.s.db('usage_records').where({ kind: 'api' }).first();
    expect(Number(usage.calc_calls)).toBe(1);
    // client tools and server tools together are refused
    const both = await request(h.app).post('/v1/chat/completions').set('authorization', `Bearer ${key}`).set('x-exprsn-tools', 'profile').send({ model: 'general', messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'f' } }] }).expect(400);
    expect(both.body.error.code).toBe('tools_conflict');
  });

  // ---------- B-703 ----------

  it('never releases a phrase only the guard model blocks, with the default hold-back (B-703)', async () => {
    const { pool } = await seedGateway(h, ollama, { label: 'internal' });
    await addGuardProfile(h, ollama, pool.id);
    await publishRules(ga, [{ id: 'safety', name: 'Safety categories', checkpoint: 'model-output', type: 'guard model', mechanism: { kind: 'guard-model', profile: 'llama-guard' }, action: 'block', stage: 'enforce' }]);
    const m = await member('mem');
    const events = tap();
    ollama.chatDelayMs = 5;
    ollama.reply = () => ({ content: 'Fine first sentence. Then UNSAFE-TEST appears here. ' + 'More filler text. '.repeat(20) });
    const sent = (await m.post('/api/chat', { content: 'Tell me', profile: 'general' }).expect(202)).body;
    await finished(h, sent.messageId);
    const chunks = events.filter((e) => e.event === 'chat.chunk' && e.data.messageId === sent.messageId);
    expect(chunks.map((e) => String(e.data.delta ?? '')).join('')).toBe('Fine first sentence. ');
    expect(JSON.stringify(events)).not.toContain('UNSAFE-TEST');
    const view = (await m.agent.get(`/api/conversations/${sent.conversationId}`).expect(200)).body;
    expect(view.messages[1].content).toMatch(/^This answer was withheld\. Blocked by the guardrail "Safety categories"/);
    // the model was stopped early: it did not produce the whole answer
    expect(ollama.requests.filter((x) => x.path === '/api/chat' && x.body.model === 'llama-guard3:8b').length).toBeGreaterThan(0);
    // a safe answer streams in full, each sentence after a clean verdict
    events.length = 0;
    ollama.reply = () => ({ content: 'One fine sentence. Another fine sentence. The end.' });
    const ok = (await m.post('/api/chat', { content: 'Again', profile: 'general' }).expect(202)).body;
    await finished(h, ok.messageId);
    expect(events.filter((e) => e.event === 'chat.chunk' && e.data.messageId === ok.messageId).map((e) => String(e.data.delta ?? '')).join('')).toBe('One fine sentence. Another fine sentence. The end.');
  });

  it('screens tool results shown in chat (B-703)', async () => {
    await seedGateway(h, ollama, { tools: ['calculate'], label: 'internal' });
    await publishRules(ga, [{ id: 'no-84', name: 'No eighty-four', checkpoint: 'model-output', type: 'pattern', mechanism: { kind: 'pattern', pattern: '\\b84\\b' }, action: 'block', stage: 'enforce' }]);
    const m = await member('tool');
    const events = tap();
    ollama.reply = (messages) => (messages[messages.length - 1]!.role === 'tool' ? { content: 'Done.' } : { content: '', toolCall: { name: 'calculate', arguments: { expression: '12 * 7' } } });
    const sent = (await m.post('/api/chat', { content: 'Compute', profile: 'general' }).expect(202)).body;
    await finished(h, sent.messageId);
    const tool = events.find((e) => e.event === 'chat.chunk' && e.data.messageId === sent.messageId && e.data.tool)!.data.tool as { name: string; error?: string; result?: unknown };
    expect(tool.name).toBe('calculate');
    expect(tool.error).toMatch(/withheld/);
    expect(JSON.stringify(tool)).not.toMatch(/\b84\b/);
    const view = (await m.agent.get(`/api/conversations/${sent.conversationId}`).expect(200)).body;
    expect(JSON.stringify(view.messages[1].tools)).not.toMatch(/\b84\b/);
    expect(view.messages[1].content).toBe('Done.');
  });

  // ---------- B-704 ----------

  it('holds a prompt for review: nothing is generated until approved, and a rejection tells the user (B-704)', async () => {
    await seedGateway(h, ollama, { label: 'internal' });
    await publishRules(ga, [{ id: 'wire', name: 'Wire transfers', checkpoint: 'user-input', type: 'pattern', mechanism: { kind: 'pattern', pattern: '(?i)wire transfer' }, action: 'require-approval', stage: 'enforce' }]);
    const m = await member('asker');
    const chatCalls = () => ollama.requests.filter((x) => x.path === '/api/chat').length;
    const before = chatCalls();
    const sent = (await m.post('/api/chat', { content: 'Please prepare a wire transfer to Contoso', profile: 'general' }).expect(202)).body;
    expect(sent).toMatchObject({ state: 'awaiting' });
    await sleep(100);
    expect(chatCalls()).toBe(before);
    let view = (await m.agent.get(`/api/conversations/${sent.conversationId}`).expect(200)).body;
    expect(view.messages[0]).toMatchObject({ role: 'user', state: 'held', content: 'Please prepare a wire transfer to Contoso' });
    expect(view.messages[1]).toMatchObject({ role: 'assistant', state: 'awaiting', content: '' });
    // regenerating cannot skip the review
    await m.post(`/api/conversations/${sent.conversationId}/messages/${sent.messageId}/regenerate`, {}).expect(409);
    const queue = (await ga.agent.get('/api/flags').expect(200)).body;
    const item = queue.items.find((f: { kind: string; checkpoint: string }) => f.kind === 'hold' && f.checkpoint === 'user-input');
    expect(item).toMatchObject({ action: 'require-approval', rule: 'Wire transfers', conversationId: sent.conversationId });
    const detail = (await ga.agent.get(`/api/flags/${item.ref}`).expect(200)).body;
    expect(detail.held).toMatchObject({ messageId: sent.userMessageId, content: 'Please prepare a wire transfer to Contoso' });
    // the asker cannot approve their own prompt; the reviewer approves and the answer is generated
    await send(ga, 'post', `/api/flags/${item.ref}/decide`, { decision: 'approved' }).expect(200);
    const answer = await finished(h, sent.messageId);
    expect(answer.state).toBe('complete');
    view = (await m.agent.get(`/api/conversations/${sent.conversationId}`).expect(200)).body;
    expect(view.messages[0].state).toBe('complete');
    expect(view.messages[1].content).toBe('You said: Please prepare a wire transfer to Contoso');
    // rejected
    const second = (await m.post(`/api/conversations/${sent.conversationId}/messages`, { content: 'Another wire transfer please', profile: 'general' }).expect(202)).body;
    const calls = chatCalls();
    const item2 = (await ga.agent.get('/api/flags').expect(200)).body.items.find((f: { kind: string; state: string }) => f.kind === 'hold' && f.state === 'open');
    await send(ga, 'post', `/api/flags/${item2.ref}/decide`, { decision: 'rejected', reason: 'Not by chat' }).expect(200);
    const rejected = await h.s.db('messages').where({ id: second.messageId }).first();
    expect(rejected.state).toBe('withdrawn');
    view = (await m.agent.get(`/api/conversations/${sent.conversationId}`).expect(200)).body;
    expect(view.messages.find((x: { id: string }) => x.id === second.messageId).content).toMatch(/not sent to the model: a reviewer rejected it/);
    expect(chatCalls()).toBe(calls);
    const notes = (await m.agent.get('/api/me/notifications').expect(200)).body;
    expect(JSON.stringify(notes)).toMatch(/held for review was rejected/);
    // the rejected question is left out of what the model sees next
    ollama.reply = (messages) => ({ content: `Seen ${messages.filter((x) => x.role === 'user').length} questions.` });
    const third = (await m.post(`/api/conversations/${sent.conversationId}/messages`, { content: 'Hello', profile: 'general' }).expect(202)).body;
    await finished(h, third.messageId);
    const last = ollama.requests.filter((x) => x.path === '/api/chat').pop()!.body.messages as { role: string; content: string }[];
    expect(last.map((x) => x.content).join(' ')).not.toContain('Another wire transfer');
  });

  // ---------- B-706 ----------

  it('anonymous links open a public conversation signed-out, never an internal one (B-706)', async () => {
    await seedGateway(h, ollama, { label: 'internal' });
    await localUser(h, 'ta', ['tenant-admin'], 'internal');
    const ta = await loginAdmin(h, 'ta');
    const owner = await member('owner');
    const conv = (await owner.post('/api/conversations', { title: 'Opening hours', label: 'public' }).expect(201)).body;
    const sent = (await owner.post(`/api/conversations/${conv.id}/messages`, { content: 'When do we open?', profile: 'general', label: 'public' }).expect(202)).body;
    await finished(h, sent.messageId);
    // off by default
    const off = await owner.post(`/api/conversations/${conv.id}/shares`, { kind: 'link', expiresInHours: 24, anonymous: true }).expect(403);
    expect(off.body.detail).toMatch(/turned off/);
    await send(ta, 'put', `/api/admin/tenants/${h.tenantId}/sharing`, { anonymousLinks: true, anonymousMaxHours: 48 }).expect(200);
    await owner.post(`/api/conversations/${conv.id}/shares`, { kind: 'link', expiresInHours: 72, anonymous: true }).expect(400);
    const link = (await owner.post(`/api/conversations/${conv.id}/shares`, { kind: 'link', expiresInHours: 24, anonymous: true }).expect(201)).body;
    expect(link.url).toMatch(/\/#\/shared\?t=exs_/);
    expect(link.anonymous).toBe(true);
    const sessions = (await h.s.db('sessions').count({ n: '*' }))[0]!.n;
    const opened = await request(h.app).post('/api/public/shared-links/open').send({ token: link.token }).expect(200);
    expect(opened.headers['set-cookie']).toBeUndefined();
    expect(opened.body).toMatchObject({ title: 'Opening hours', label: 'public', readOnly: true });
    expect(opened.body.owner).toBeUndefined();
    expect(opened.body.messages.map((x: { content: string }) => x.content)).toEqual(['When do we open?', 'You said: When do we open?']);
    expect((await h.s.db('sessions').count({ n: '*' }))[0]!.n).toBe(sessions);
    const audit = await h.s.db('audit_events').where({ action: 'conversation.share.opened' }).orderBy('seq', 'desc').first();
    expect(JSON.parse(audit.detail)).toMatchObject({ anonymous: true });
    // an internal conversation never gets one, and raising the label ends a link at once
    const internal = (await owner.post('/api/conversations', { title: 'Internal', label: 'internal' }).expect(201)).body;
    await owner.post(`/api/conversations/${internal.id}/shares`, { kind: 'link', expiresInHours: 24, anonymous: true }).expect(403);
    await owner.agent.patch(`/api/conversations/${conv.id}`).set('x-csrf-token', owner.csrf).send({ label: 'internal' }).expect(200);
    await request(h.app).post('/api/public/shared-links/open').send({ token: link.token }).expect(404);
    // an ordinary (signed-in) link is not an anonymous one
    const pub2 = (await owner.post('/api/conversations', { title: 'Second', label: 'public' }).expect(201)).body;
    const plain = (await owner.post(`/api/conversations/${pub2.id}/shares`, { kind: 'link', expiresInHours: 24 }).expect(201)).body;
    await request(h.app).post('/api/public/shared-links/open').send({ token: plain.token }).expect(404);
    // turning the setting off ends every anonymous link
    const link2 = (await owner.post(`/api/conversations/${pub2.id}/shares`, { kind: 'link', expiresInHours: 24, anonymous: true }).expect(201)).body;
    await send(ta, 'put', `/api/admin/tenants/${h.tenantId}/sharing`, { anonymousLinks: false }).expect(200);
    await request(h.app).post('/api/public/shared-links/open').send({ token: link2.token }).expect(404);
    // rate-limited per address (5 per minute in this harness)
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await request(h.app).post('/api/public/shared-links/open').send({ token: link2.token })).status);
    expect(statuses).toContain(429);
  });

  // ---------- B-707 ----------

  it('a workspace with a shorter retention period purges its conversations first (B-707)', async () => {
    await localUser(h, 'ta', ['tenant-admin'], 'internal');
    const ta = await loginAdmin(h, 'ta');
    const m = await member('keeper');
    const ws = await h.s.tenants.createWorkspace(h.tenantId, 'Short memory', 'confidential');
    const day = 86_400_000;
    const conv = async (title: string, workspaceId: string | null, ageDays: number, userId = m.user.id) => {
      const c = (await m.post('/api/conversations', { title }).expect(201)).body;
      await h.s.db('conversations').where({ id: c.id }).update({ workspace_id: workspaceId, updated_at: Date.now() - ageDays * day, user_id: userId });
      return c.id as string;
    };
    const inWs = await conv('in workspace', ws.id, 20);
    const outside = await conv('elsewhere', null, 20);
    const fresh = await conv('recent in workspace', ws.id, 2);
    const other = await localUser(h, 'short', ['member'], 'internal');
    const byUser = await conv('by a user with a short period', null, 8, other.id);
    await send(ta, 'put', `/api/admin/tenants/${h.tenantId}/retention`, { conversationDays: 365 }).expect(200);
    await send(ta, 'put', `/api/admin/tenants/${h.tenantId}/retention/scopes`, { scope: 'workspace', scopeId: ws.id, conversationDays: 10 }).expect(200);
    const view = (await send(ta, 'put', `/api/admin/tenants/${h.tenantId}/retention/scopes`, { scope: 'user', scopeId: other.id, conversationDays: 7 }).expect(200)).body;
    expect(view.scopes.map((x: { scope: string; name: string; conversationDays: number }) => [x.scope, x.name, x.conversationDays])).toEqual([
      ['user', 'SHORT', 7],
      ['workspace', 'Short memory', 10]
    ]);
    await send(ta, 'put', `/api/admin/tenants/${h.tenantId}/retention/scopes`, { scope: 'workspace', scopeId: ulid(), conversationDays: 3 }).expect(404);
    const r = await h.s.chat.purgeExpired(h.tenantId);
    expect(r).toMatchObject({ days: 365, conversations: 2, scopes: 2 });
    const left = ((await h.s.db('conversations').whereIn('id', [inWs, outside, fresh, byUser]).select('id')) as { id: string }[]).map((x) => x.id).sort();
    expect(left).toEqual([outside, fresh].sort());
    const ev = await h.s.db('audit_events').where({ action: 'tenant.retention.scope.updated' }).first();
    expect(ev).toBeTruthy();
    // removing the workspace period leaves the tenant's
    const after = (await send(ta, 'put', `/api/admin/tenants/${h.tenantId}/retention/scopes`, { scope: 'workspace', scopeId: ws.id, conversationDays: null }).expect(200)).body;
    expect(after.scopes).toHaveLength(1);
  });

  // ---------- B-708 ----------

  it('a template containing a blocked secret cannot be saved or published (B-708)', async () => {
    await localUser(h, 'pm', ['tenant-admin'], 'internal');
    const pm = await loginAdmin(h, 'pm');
    const secret = 'Use key sk_' + 'live_4eC39HqLyjWDarjtT1zdp7dc to call the API about {{topic}}.';
    // saved before the rule existed
    const early = (await send(pm, 'post', '/api/prompts', { name: 'Early', body: secret }).expect(201)).body;
    await publishRules(ga, [{ id: 'no-keys', name: 'No API keys', checkpoint: 'user-input', type: 'pattern', mechanism: { kind: 'pattern', pattern: 'sk_live_[A-Za-z0-9]{16,}' }, action: 'block', stage: 'enforce' }]);
    const refused = await send(pm, 'post', `/api/prompts/${early.id}/state`, { state: 'published' }).expect(422);
    expect(refused.body).toMatchObject({ title: 'Blocked by guardrail', rules: ['No API keys'] });
    expect(refused.body.detail).toMatch(/cannot be published/);
    expect((await h.s.db('prompt_templates').where({ id: early.id }).first()).state).toBe('draft');
    await send(pm, 'post', '/api/prompts', { name: 'Late', body: secret }).expect(422);
    const clean = (await send(pm, 'post', '/api/prompts', { name: 'Clean', body: 'Summarise {{topic}} in three lines.' }).expect(201)).body;
    await send(pm, 'post', `/api/prompts/${clean.id}/versions`, { body: secret }).expect(422);
    await send(pm, 'post', `/api/prompts/${clean.id}/state`, { state: 'published' }).expect(200);
  });
});

// ---------------------------------------------------------------------------------------------------------------

describe('live sharing (B-705)', () => {
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

  async function person(name: string) {
    const user = await localUser(h, name, ['member'], 'internal');
    const c = await login(h, name);
    const sock = ioClient(url, { path: '/socket.io', transports: ['websocket'], reconnection: false, extraHeaders: { cookie: c.cookie } });
    sockets.push(sock);
    await new Promise((r) => sock.on('ready', r));
    return { user, sock, post: (u: string, b: object = {}) => c.agent.post(u).set('x-csrf-token', c.csrf).send(b), del: (u: string) => c.agent.delete(u).set('x-csrf-token', c.csrf), get: (u: string) => c.agent.get(u) };
  }

  const watch = (sock: Socket, conversationId: string) => new Promise<{ ok: boolean; owner?: boolean; error?: string }>((r) => sock.emit('shared.watch', { conversationId }, r));

  it('a shared reader receives chat.chunk for the owner streaming answer, and loses it at once on revoke', async () => {
    await seedGateway(h, ollama, { label: 'internal' });
    const owner = await person('owner');
    const reader = await person('reader');
    const stranger = await person('stranger');
    const conv = (await owner.post('/api/conversations', { title: 'Live', label: 'internal' }).expect(201)).body;
    // not shared yet: refused, and the room is never joined
    expect(await watch(reader.sock, conv.id)).toMatchObject({ ok: false });
    const share = (await owner.post(`/api/conversations/${conv.id}/shares`, { kind: 'user', userId: reader.user.id }).expect(201)).body;
    expect(await watch(reader.sock, conv.id)).toMatchObject({ ok: true });
    expect(await watch(stranger.sock, conv.id)).toMatchObject({ ok: false });
    const got: { event: string; data: Record<string, unknown>; at: number }[] = [];
    let revokedAt = 0;
    for (const ev of ['chat.chunk', 'chat.status', 'chat.done']) reader.sock.on(ev, (data: Record<string, unknown>) => void got.push({ event: ev, data, at: Date.now() }));
    reader.sock.on('shared.revoked', () => (revokedAt = Date.now()));
    const strangerChunks: unknown[] = [];
    stranger.sock.on('chat.chunk', (d: unknown) => void strangerChunks.push(d));
    ollama.chatDelayMs = 15;
    ollama.reply = () => ({ content: 'Word '.repeat(200), thinking: 'private thoughts ' });
    const sent = (await owner.post(`/api/conversations/${conv.id}/messages`, { content: 'Go', profile: 'general' }).expect(202)).body;
    await until(() => got.filter((x) => x.event === 'chat.chunk').length >= 5);
    const first = got.find((x) => x.event === 'chat.chunk')!.data;
    expect(first).toMatchObject({ conversationId: conv.id, messageId: sent.messageId });
    expect(first.delta).toBeTruthy();
    expect(JSON.stringify(got)).not.toContain('private thoughts');
    // catch-up for a reader who joined late: screened answer text, no thinking
    const caught = (await reader.get(`/api/shared-conversations/${conv.id}/messages/${sent.messageId}/stream?after=0`).expect(200)).body;
    expect(caught.thinking ?? null).toBeNull();
    // revoke: the reader leaves the room before the next chunk is relayed
    await owner.del(`/api/conversations/${conv.id}/shares/${share.id}`).expect(204);
    await until(() => revokedAt > 0);
    const countAtRevoke = got.filter((x) => x.event === 'chat.chunk').length;
    await until(async () => (await h.s.db('messages').where({ id: sent.messageId }).first())?.completed_at);
    await sleep(50);
    expect(got.filter((x) => x.event === 'chat.chunk').length).toBe(countAtRevoke);
    expect(got.filter((x) => x.at > revokedAt && x.event === 'chat.chunk')).toHaveLength(0);
    expect(strangerChunks).toHaveLength(0);
    await reader.get(`/api/shared-conversations/${conv.id}/messages/${sent.messageId}/stream?after=0`).expect(404);
  });
});
