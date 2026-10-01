import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { io as ioClient, type Socket } from 'socket.io-client';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachRealtime } from '../src/realtime/socket.js';
import { TOPICS } from '../src/platform/bus.js';
import type { ProfileRow } from '../src/gateway/repo.js';
import { configHash } from '../src/evals/service.js';
import { FakeOllama } from './fake-ollama.js';
import { seedGateway } from './seed-gateway.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

const GB = 1_000_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(10);
  }
}

const send = (c: Client, method: 'post' | 'put' | 'patch' | 'delete', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);

async function publishRules(admin: Client, rules: object[], name = 'Sprint 21 rules') {
  const set = (await send(admin, 'post', '/api/admin/guardrails/sets', { name, scope: 'tenant' }).expect(201)).body;
  await send(admin, 'put', `/api/admin/guardrails/sets/${set.id}/draft`, { rules }).expect(200);
  await send(admin, 'post', `/api/admin/guardrails/sets/${set.id}/draft/publish`).expect(200);
  return set as { id: string };
}

async function drain(h: Harness): Promise<void> {
  for (let i = 0; i < 40; i++) if (!(await h.s.jobs.runDue())) return;
}

async function finished(h: Harness, messageId: string) {
  return until(async () => {
    const m = await h.s.db('messages').where({ id: messageId }).first();
    return m?.completed_at || m?.state === 'interrupted' ? m : null;
  });
}

const HOLD_RULE = { id: 'wire', name: 'Wire transfers', checkpoint: 'user-input', type: 'pattern', mechanism: { kind: 'pattern', pattern: '(?i)wire transfer' }, action: 'require-approval', stage: 'enforce' };

describe('sprint 21: AI', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let ga: Client;

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    ollama = await new FakeOllama().start();
    ollama.chatDelayMs = 1;
    await localUser(h, 'ga', ['guardrail-admin'], 'confidential');
    ga = await loginAdmin(h, 'ga');
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  async function member(name: string, roles = ['member']) {
    const user = await localUser(h, name, roles, 'internal');
    const c = await login(h, name);
    return { user, ...c, post: (url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body) };
  }
  const apiKey = async (userId: string, scopes = ['inference:invoke', 'chat:write', 'chat:read']) => (await h.s.apiKeys.create({ tenantId: h.tenantId, userId, name: `k-${ulid()}`, scopes: scopes as never[], ttlDays: 30 })).key;
  const chatCalls = () => ollama.requests.filter((x) => x.path === '/api/chat' && !String(x.body.model).includes('guard')).length;

  // ---------- B-1301 ----------

  it('holds a /v1 request a require-approval rule stops; the client fetches the answer after approval (B-1301)', async () => {
    await seedGateway(h, ollama, { label: 'internal' });
    await publishRules(ga, [HOLD_RULE]);
    const m = await member('apiuser');
    const key = await apiKey(m.user.id);
    const before = chatCalls();
    const held = await request(h.app).post('/v1/chat/completions').set('authorization', `Bearer ${key}`).send({ model: 'general', messages: [{ role: 'user', content: 'Prepare a wire transfer to Contoso' }] }).expect(202);
    expect(held.body).toMatchObject({ object: 'exprsn.held_request', status: 'held', api: 'chat.completions' });
    expect(held.headers.location).toBe(`/v1/held/${held.body.id}`);
    expect(chatCalls()).toBe(before);
    const poll = () => request(h.app).get(`/v1/held/${held.body.id}`).set('authorization', `Bearer ${key}`).expect(200);
    expect((await poll()).body.status).toBe('held');
    // another caller cannot see it
    const other = await member('other');
    await request(h.app).get(`/v1/held/${held.body.id}`).set('authorization', `Bearer ${await apiKey(other.user.id)}`).expect(404);
    // the reviewer sees the held text and approves; the request runs as its sender
    const item = (await ga.agent.get('/api/flags').expect(200)).body.items.find((f: { kind: string; checkpoint: string }) => f.kind === 'hold' && f.checkpoint === 'user-input');
    const detail = (await ga.agent.get(`/api/flags/${item.ref}`).expect(200)).body;
    expect(detail.held).toMatchObject({ content: 'Prepare a wire transfer to Contoso' });
    await send(ga, 'post', `/api/flags/${item.ref}/decide`, { decision: 'approved' }).expect(200);
    await drain(h);
    const done = (await poll()).body;
    expect(done.status).toBe('completed');
    expect(done.response).toMatchObject({ object: 'chat.completion', choices: [{ message: { content: 'You said: Prepare a wire transfer to Contoso' } }] });
    const audit = await h.s.db('audit_events').whereIn('action', ['api.request.held', 'api.hold.approved']).select('action');
    expect(audit.map((x: { action: string }) => x.action).sort()).toEqual(['api.hold.approved', 'api.request.held']);
    // a streamed request is held the same way, and a rejection is reported
    const second = await request(h.app).post('/v1/chat/completions').set('authorization', `Bearer ${key}`).send({ model: 'general', stream: true, messages: [{ role: 'user', content: 'Another wire transfer' }] }).expect(202);
    const item2 = (await ga.agent.get('/api/flags').expect(200)).body.items.find((f: { kind: string; state: string }) => f.kind === 'hold' && f.state === 'open');
    await send(ga, 'post', `/api/flags/${item2.ref}/decide`, { decision: 'rejected' }).expect(200);
    expect((await request(h.app).get(`/v1/held/${second.body.id}`).set('authorization', `Bearer ${key}`).expect(200)).body.status).toBe('rejected');
  });

  it('compare holds both columns until the prompt is approved (B-1301)', async () => {
    const { pool, model } = await seedGateway(h, ollama, { label: 'internal' });
    const t = Date.now();
    const second: ProfileRow = { id: 'SECOND00000000000000000000', tenant_id: h.tenantId, name: 'second', display_name: 'Second', description: null, alias_of: null, model_id: model.id, pool_id: pool.id, num_ctx: 8192, temperature: 0.2, think_default: 'off', think_ceiling: 'off', system_prompt: null, fallback: null, canary: null, tools: [], label: 'internal', status: 'published', version: 1, updated_by: null, created_at: t, updated_at: t };
    await h.s.gateway.repo.createProfile(second);
    await publishRules(ga, [HOLD_RULE]);
    const m = await member('comparer');
    const before = chatCalls();
    const sent = (await m.post('/api/compare', { prompt: 'Draft a wire transfer note', profiles: ['general', 'second'] }).expect(202)).body;
    expect(sent.state).toBe('awaiting');
    expect(sent.columns.map((c: { state: string }) => c.state)).toEqual(['awaiting', 'awaiting']);
    await sleep(50);
    expect(chatCalls()).toBe(before);
    const item = (await ga.agent.get('/api/flags').expect(200)).body.items.find((f: { kind: string; conversationId: string }) => f.kind === 'hold' && f.conversationId === sent.conversationId);
    expect(item).toBeTruthy();
    await send(ga, 'post', `/api/flags/${item.ref}/decide`, { decision: 'approved' }).expect(200);
    for (const c of sent.columns) expect((await finished(h, c.messageId)).state).toBe('complete');
    const view = (await m.agent.get(`/api/conversations/${sent.conversationId}`).expect(200)).body;
    expect(view.messages.filter((x: { role: string; content: string }) => x.role === 'assistant' && x.content === 'You said: Draft a wire transfer note')).toHaveLength(2);
  });

  // ---------- B-1302 ----------

  it('stores a /v1/responses exchange as a conversation that shows in Chat and can be continued (B-1302)', async () => {
    await seedGateway(h, ollama, { label: 'internal' });
    const m = await member('responder');
    const key = await apiKey(m.user.id);
    const first = (await request(h.app).post('/v1/responses').set('authorization', `Bearer ${key}`).send({ model: 'general', input: 'Hello there', instructions: 'Be brief.', store: true }).expect(200)).body;
    expect(first).toMatchObject({ object: 'response', status: 'completed', store: true, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'You said: Hello there' }] }] });
    expect(first.id).toMatch(/^resp_[0-9A-Z]{26}$/);
    expect(first.usage.total_tokens).toBeGreaterThan(0);
    // it appears in Chat, for the same user
    const list = (await m.agent.get('/api/conversations').expect(200)).body;
    expect(list).toHaveLength(1);
    const conv = (await m.agent.get(`/api/conversations/${list[0].id}`).expect(200)).body;
    expect(conv.messages.map((x: { role: string; content: string; state: string }) => [x.role, x.content, x.state])).toEqual([
      ['user', 'Hello there', 'complete'],
      ['assistant', 'You said: Hello there', 'complete']
    ]);
    // continued through the API: the model sees the earlier turn, and the turn is stored under it
    ollama.reply = (messages) => ({ content: `Turns: ${messages.filter((x) => x.role === 'user').map((x) => x.content).join(' | ')}` });
    const next = (await request(h.app).post('/v1/responses').set('authorization', `Bearer ${key}`).send({ model: 'general', input: [{ role: 'user', content: 'And again' }], previous_response_id: first.id, store: true }).expect(200)).body;
    expect(next.previous_response_id).toBe(first.id);
    expect(next.output[0].content[0].text).toBe('Turns: Hello there | And again');
    expect((await request(h.app).get(`/v1/responses/${next.id}`).set('authorization', `Bearer ${key}`).expect(200)).body).toMatchObject({ id: next.id, previous_response_id: first.id });
    // continued in Chat: a message under the stored answer
    const again = (await m.post(`/api/conversations/${list[0].id}/messages`, { content: 'From chat', profile: 'general' }).expect(202)).body;
    await finished(h, again.messageId);
    expect((await m.agent.get(`/api/conversations/${list[0].id}`).expect(200)).body.messages.at(-1).content).toBe('Turns: Hello there | And again | From chat');
    // an unstored response cannot be continued, and another user cannot continue this one
    const loose = (await request(h.app).post('/v1/responses').set('authorization', `Bearer ${key}`).send({ model: 'general', input: 'No store' }).expect(200)).body;
    await request(h.app).post('/v1/responses').set('authorization', `Bearer ${key}`).send({ model: 'general', input: 'x', previous_response_id: loose.id }).expect(404);
    const other = await member('nosy');
    const nosy = await request(h.app).post('/v1/responses').set('authorization', `Bearer ${await apiKey(other.user.id)}`).send({ model: 'general', input: 'x', previous_response_id: first.id }).expect(404);
    expect(nosy.body.error.code).toBe('response_not_found');
    // store: true needs chat:write
    const narrow = await apiKey(m.user.id, ['inference:invoke']);
    await request(h.app).post('/v1/responses').set('authorization', `Bearer ${narrow}`).send({ model: 'general', input: 'x', store: true }).expect(403);
  });

  it('streams /v1/responses with the documented events and passes function tools through (B-1302)', async () => {
    await seedGateway(h, ollama, { label: 'internal' });
    const m = await member('streamer');
    const key = await apiKey(m.user.id);
    const res = await request(h.app).post('/v1/responses').set('authorization', `Bearer ${key}`).send({ model: 'general', input: 'Stream me', stream: true }).buffer(true).parse((r, cb) => {
      let data = '';
      r.on('data', (c: Buffer) => (data += c.toString()));
      r.on('end', () => cb(null, data));
    });
    expect(res.status).toBe(200);
    const events = String(res.body).split('\n\n').filter((b) => b.startsWith('event: ')).map((b) => ({ type: b.split('\n')[0]!.slice(7), data: JSON.parse(b.split('\n')[1]!.slice(6)) as Record<string, unknown> }));
    expect(events[0]!.type).toBe('response.created');
    expect(events.at(-1)!.type).toBe('response.completed');
    expect(events.filter((e) => e.type === 'response.output_text.delta').map((e) => e.data.delta).join('')).toBe('You said: Stream me');
    expect(String(res.body)).not.toContain('[DONE]');
    // tools: the call comes back as a function_call item, and its output is accepted on the next turn
    ollama.reply = (messages) => (messages.at(-1)!.role === 'tool' ? { content: `Weather is ${messages.at(-1)!.content}` } : { content: '', toolCall: { name: 'get_weather', arguments: { city: 'Oslo' } } });
    const tools = [{ type: 'function', name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }];
    const call = (await request(h.app).post('/v1/responses').set('authorization', `Bearer ${key}`).send({ model: 'general', input: 'Weather in Oslo?', tools, store: true }).expect(200)).body;
    const fc = call.output.find((o: { type: string }) => o.type === 'function_call');
    expect(fc).toMatchObject({ name: 'get_weather', arguments: '{"city":"Oslo"}' });
    const done = (await request(h.app).post('/v1/responses').set('authorization', `Bearer ${key}`).send({ model: 'general', previous_response_id: call.id, input: [{ type: 'function_call_output', call_id: fc.call_id, output: 'sunny' }], tools, store: true }).expect(200)).body;
    expect(done.output[0].content[0].text).toBe('Weather is sunny');
  });

  // ---------- B-1303 ----------

  it('a profile version whose eval score is below its threshold cannot be published (B-1303)', async () => {
    const { model, pool } = await seedGateway(h, ollama, { label: 'internal', status: 'draft' });
    await localUser(h, 'ma', ['model-admin'], 'confidential');
    await localUser(h, 'mb', ['model-admin'], 'confidential');
    const ma = await loginAdmin(h, 'ma');
    const mb = await loginAdmin(h, 'mb');
    // a judge profile, published
    const t = Date.now();
    await h.s.gateway.repo.createProfile({ id: 'JUDGE000000000000000000000', tenant_id: h.tenantId, name: 'judge', display_name: 'Judge', description: null, alias_of: null, model_id: model.id, pool_id: pool.id, num_ctx: 8192, temperature: 0, think_default: 'off', think_ceiling: 'off', system_prompt: null, fallback: null, canary: null, tools: [], label: 'confidential', status: 'published', version: 1, updated_by: null, created_at: t, updated_at: t });
    ollama.reply = (messages) => {
      if (/You are an evaluator/.test(messages[0]?.content ?? '')) return { content: /polite/.test(messages.at(-1)!.content) ? '{"score": 0.9, "reason": "Polite enough."}' : '{"score": 0.1, "reason": "No."}' };
      const q = messages.at(-1)!.content;
      return { content: q.includes('json') ? '{"total": 42}' : `You said: ${q}` };
    };
    const pid = 'GENERAL0000000000000000000';
    const set = (await send(ma, 'post', `/api/admin/profiles/${pid}/eval-sets`, {
      name: 'Basics',
      threshold: 1,
      judgeProfile: 'judge',
      cases: [
        { id: 'echo', prompt: 'say banana', checks: [{ kind: 'contains', value: 'banana' }, { kind: 'regex', pattern: '^You said' }] },
        { id: 'json', prompt: 'reply in json', checks: [{ kind: 'json-schema', schema: { type: 'object', properties: { total: { type: 'number' } }, required: ['total'] } }] },
        { id: 'tone', prompt: 'be polite', checks: [{ kind: 'judge', rubric: 'The answer is polite.' }] },
        { id: 'miss', prompt: 'say apple', checks: [{ kind: 'contains', value: 'cherry' }] }
      ]
    }).expect(201)).body;
    expect(set).toMatchObject({ revision: 1, gate: true, judgeProfile: 'judge' });
    // not evaluated yet: publishing is refused
    const refused = await send(ma, 'post', `/api/admin/profiles/${pid}/publish`, { status: 'published' }).expect(409);
    expect(refused.body).toMatchObject({ code: 'eval_gate' });
    // a run: three of four pass, below the threshold of 1
    const runs = (await send(ma, 'post', `/api/admin/profiles/${pid}/evaluations/run`, {}).expect(202)).body;
    await drain(h);
    const run = (await ma.agent.get(`/api/admin/profiles/${pid}/evaluations/runs/${runs[0].id}`).expect(200)).body;
    expect(run).toMatchObject({ state: 'failed', passed: 3, total: 4, score: 0.75, profileVersion: 1 });
    expect(run.results.find((c: { caseId: string }) => c.caseId === 'tone').judge).toMatchObject({ score: 0.9 });
    expect(run.results.find((c: { caseId: string }) => c.caseId === 'miss')).toMatchObject({ passed: false });
    const gated = await send(ma, 'post', `/api/admin/profiles/${pid}/publish`, { status: 'published' }).expect(409);
    expect(gated.body.detail).toMatch(/0\.75 is below the threshold 1/);
    // lowering the threshold is a new revision: the old run no longer counts, a new run passes, and publishing works
    await send(ma, 'patch', `/api/admin/profiles/${pid}/eval-sets/${set.id}`, { threshold: 0.7 }).expect(200);
    await send(ma, 'post', `/api/admin/profiles/${pid}/publish`, { status: 'published' }).expect(409);
    await send(ma, 'post', `/api/admin/profiles/${pid}/evaluations/run`, {}).expect(202);
    await drain(h);
    const published = (await send(ma, 'post', `/api/admin/profiles/${pid}/publish`, { status: 'published' }).expect(200)).body;
    expect(published.status).toBe('published');
    // a published profile changed in a way that changes its answers goes through the gate again
    await send(ma, 'patch', `/api/admin/profiles/${pid}`, { systemPrompt: 'Answer in French.' }).expect(409);
    await send(ma, 'patch', `/api/admin/profiles/${pid}`, { displayName: 'General purpose' }).expect(200);
    // an override needs a second profile admin (dual control)
    await send(ma, 'post', `/api/admin/profiles/${pid}/publish`, { status: 'draft' }).expect(200);
    await send(ma, 'patch', `/api/admin/profiles/${pid}`, { systemPrompt: 'Answer in French.' }).expect(200);
    await send(ma, 'post', `/api/admin/profiles/${pid}/publish`, { status: 'published' }).expect(409);
    const o = (await send(ma, 'post', `/api/admin/profiles/${pid}/evaluations/overrides`, { reason: 'Urgent fix; evals rerun tomorrow.' }).expect(201)).body;
    const self = await send(ma, 'post', `/api/admin/profiles/${pid}/evaluations/overrides/${o.id}/decide`, { decision: 'approve' }).expect(403);
    expect(self.body.step).toBe('dual-control');
    await send(mb, 'post', `/api/admin/profiles/${pid}/evaluations/overrides/${o.id}/decide`, { decision: 'approve' }).expect(200);
    await send(ma, 'post', `/api/admin/profiles/${pid}/publish`, { status: 'published' }).expect(200);
    // scores over time
    const overview = (await ma.agent.get(`/api/admin/profiles/${pid}/evaluations`).expect(200)).body;
    expect(overview.runs.map((r: { state: string }) => r.state)).toEqual(['passed', 'failed']);
    expect(overview.overrides[0]).toMatchObject({ state: 'approved' });
    const profile = await h.s.gateway.repo.profile(h.tenantId, pid);
    expect(overview.gate.configHash).toBe(configHash(profile!));
    expect((await h.s.db('audit_events').where({ action: 'profile.eval.override.approved' }).first())).toBeTruthy();
  });

  // ---------- B-1304 ----------

  it('withholds thinking that a guard-model rule blocks, after the answer finishes (B-1304)', async () => {
    const { pool, model } = await seedGateway(h, ollama, { label: 'internal', think_default: 'low', think_ceiling: 'low' });
    await h.s.gateway.repo.updateModel(model.id, { capabilities: ['completion', 'tools', 'thinking'] });
    ollama.addAvailable({ name: 'llama-guard3:8b', size: 5 * GB, capabilities: ['completion'] });
    const g = await h.s.gateway.repo.createModel({ name: 'llama-guard3:8b', source: 'Ollama library', expectedDigest: null, license: { name: 'test' }, label: 'confidential', notes: null, requestedBy: 'x', requestedTenant: h.tenantId });
    await h.s.gateway.repo.updateModel(g.id, { state: 'approved', import_state: 'pulled', capabilities: ['completion'], size_bytes: 5 * GB });
    await h.s.gateway.repo.place(g.id, pool.id, 'warm', 'x');
    const t = Date.now();
    await h.s.gateway.repo.createProfile({ id: 'LLAMAGUARD'.padEnd(26, '0'), tenant_id: h.tenantId, name: 'llama-guard', display_name: 'Guard', description: null, alias_of: null, model_id: g.id, pool_id: pool.id, num_ctx: 8192, temperature: 0, think_default: 'off', think_ceiling: 'off', system_prompt: null, fallback: null, canary: null, tools: [], label: 'confidential', status: 'published', version: 1, updated_by: null, created_at: t, updated_at: t });
    await h.s.gateway.pollAll();
    await publishRules(ga, [{ id: 'safety', name: 'Safety categories', checkpoint: 'model-output', type: 'guard model', mechanism: { kind: 'guard-model', profile: 'llama-guard' }, action: 'block', stage: 'enforce' }]);
    const m = await member('thinker');
    const events: { event: string; data: Record<string, unknown> }[] = [];
    h.s.bus.on<{ event: string; data: Record<string, unknown> }>(TOPICS.chatEvent, (e) => void events.push(e));
    // The thinking's last window has no sentence end, so the streaming screen leaves it to the full check.
    ollama.reply = () => ({ thinking: 'Let me weigh UNSAFE-TEST quietly', content: 'A fine answer.' });
    const sent = (await m.post('/api/chat', { content: 'Think first', profile: 'general', think: 'low' }).expect(202)).body;
    const row = await finished(h, sent.messageId);
    expect(row.state).toBe('complete');
    expect(JSON.stringify(events.filter((e) => e.event === 'chat.chunk'))).not.toContain('UNSAFE-TEST');
    const view = (await m.agent.get(`/api/conversations/${sent.conversationId}`).expect(200)).body;
    expect(view.messages[1].content).toBe('A fine answer.');
    expect(view.messages[1].thinking ?? '').not.toContain('UNSAFE-TEST');
    expect(view.messages[1].guard).toMatchObject({ thinking: { action: 'block', rules: ['Safety categories'] } });
    // the full check ran on the thinking with the guard model
    expect(ollama.requests.some((x) => x.path === '/api/chat' && x.body.model === 'llama-guard3:8b' && JSON.stringify(x.body.messages).includes('UNSAFE-TEST'))).toBe(true);
    // clean thinking is kept
    ollama.reply = () => ({ thinking: 'Plain reasoning', content: 'Another answer.' });
    const ok = (await m.post('/api/chat', { content: 'Again', profile: 'general', think: 'low' }).expect(202)).body;
    await finished(h, ok.messageId);
    expect((await m.agent.get(`/api/conversations/${ok.conversationId}`).expect(200)).body.messages[1].thinking).toBe('Plain reasoning');
  });

  // ---------- B-1306 ----------

  it('a scheduled agent runs at its time with the owner\'s permissions, and is skipped when the owner is disabled (B-1306)', async () => {
    await seedGateway(h, ollama, { label: 'internal' });
    await localUser(h, 'ta', ['tool-admin'], 'confidential');
    await localUser(h, 'tb', ['tool-admin'], 'confidential');
    const ta = await loginAdmin(h, 'ta');
    const tb = await loginAdmin(h, 'tb');
    const e = (await send(ta, 'post', '/api/admin/registry', { kind: 'agent', name: 'Reporter', version: '1.0.0', description: 'Writes the morning report from the figures it is given each day.', label: 'internal', definition: { profile: 'general', systemPrompt: 'Be short.', tools: [], budgets: { steps: 5, tokens: 5000, wallSeconds: 60, toolCalls: 0 } } }).expect(201)).body;
    await send(ta, 'post', `/api/admin/registry/${e.id}/submit`).expect(200);
    await send(tb, 'post', `/api/admin/registry/${e.id}/review`, { decision: 'approve' }).expect(200);
    ollama.reply = () => ({ content: 'Report done.' });
    const m = await member('owner');
    await m.post('/api/agent-schedules', { name: 'Morning', agent: 'Reporter', cron: 'not cron', input: 'x' }).expect(400);
    const sc = (await m.post('/api/agent-schedules', { name: 'Morning', agent: 'Reporter', cron: '0 7 * * 1-5', input: 'Summarise yesterday.', label: 'internal' }).expect(201)).body;
    expect(sc).toMatchObject({ enabled: true, cronText: '0 7 * * 1-5', mine: true });
    expect(sc.nextRunAt).toBeGreaterThan(Date.now());
    // nothing is due yet
    expect(await h.s.agentSchedules.tick()).toEqual({ fired: 0, skipped: 0 });
    // its time comes
    const due = Date.now() - 1000;
    await h.s.db('agent_schedules').where({ id: sc.id }).update({ next_run_at: due });
    expect(await h.s.agentSchedules.tick()).toEqual({ fired: 1, skipped: 0 });
    // a second instance ticking at the same moment does not start it again
    expect(await h.s.agentSchedules.tick()).toEqual({ fired: 0, skipped: 0 });
    await drain(h);
    const runs = (await m.agent.get('/api/runs').expect(200)).body;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ agent: 'Reporter', userId: m.user.id, scheduleId: sc.id, state: 'succeeded' });
    let history = (await m.agent.get(`/api/agent-schedules/${sc.id}/history`).expect(200)).body;
    expect(history[0]).toMatchObject({ outcome: 'started', runId: runs[0].id, runState: 'succeeded', dueAt: due });
    // the owner loses agents:run: skipped, with the owner's permissions as they are now
    await h.s.users.setRoles(m.user.id, 'direct', ['flag-reviewer']);
    await h.s.db('agent_schedules').where({ id: sc.id }).update({ next_run_at: Date.now() - 500 });
    expect(await h.s.agentSchedules.tick()).toEqual({ fired: 0, skipped: 1 });
    await h.s.users.setRoles(m.user.id, 'direct', ['member']);
    // disabled owner: skipped, no run
    await h.s.users.update(h.tenantId, m.user.id, { state: 'disabled' });
    await h.s.db('agent_schedules').where({ id: sc.id }).update({ next_run_at: Date.now() - 100 });
    expect(await h.s.agentSchedules.tick()).toEqual({ fired: 0, skipped: 1 });
    expect(await h.s.db('agent_runs').where({ schedule_id: sc.id }).count({ n: '*' }).first()).toMatchObject({ n: 1 });
    // an agent admin sees the history of someone else's schedule
    history = (await ta.agent.get(`/api/agent-schedules/${sc.id}/history`).expect(200)).body;
    expect(history.map((x: { outcome: string }) => x.outcome)).toEqual(['skipped', 'skipped', 'started']);
    expect(history[0]!.reason).toMatch(/disabled/);
    expect(history[1]!.reason).toMatch(/may no longer run agents/);
    expect(await h.s.db('audit_events').where({ action: 'agent.schedule.skipped' }).count({ n: '*' }).first()).toMatchObject({ n: 2 });
  });
});

// ---------- B-1305 ----------

describe('membership changes end live watches (B-1305)', () => {
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
    return { user, sock, post: (u: string, b: object = {}) => c.agent.post(u).set('x-csrf-token', c.csrf).send(b), get: (u: string) => c.agent.get(u) };
  }
  const watch = (sock: Socket, conversationId: string) => new Promise<{ ok: boolean }>((r) => sock.emit('shared.watch', { conversationId }, r));

  it('removing a reader from the shared workspace ends their stream without a reload', async () => {
    await seedGateway(h, ollama, { label: 'internal' });
    const ws = await h.s.tenants.createWorkspace(h.tenantId, 'Finance', 'confidential');
    const owner = await person('owner');
    const reader = await person('reader');
    await h.s.tenants.addMember(ws.id, reader.user.id);
    await localUser(h, 'tadmin', ['tenant-admin'], 'confidential');
    const admin = await loginAdmin(h, 'tadmin');
    const conv = (await owner.post('/api/conversations', { title: 'Live', label: 'internal' }).expect(201)).body;
    await owner.post(`/api/conversations/${conv.id}/shares`, { kind: 'workspace', workspaceId: ws.id }).expect(201);
    expect(await watch(reader.sock, conv.id)).toMatchObject({ ok: true });
    const chunks: { at: number }[] = [];
    let revokedAt = 0;
    reader.sock.on('chat.chunk', () => void chunks.push({ at: Date.now() }));
    reader.sock.on('shared.revoked', () => (revokedAt = Date.now()));
    ollama.chatDelayMs = 15;
    ollama.reply = () => ({ content: 'Word '.repeat(200) });
    const sent = (await owner.post(`/api/conversations/${conv.id}/messages`, { content: 'Go', profile: 'general' }).expect(202)).body;
    await until(() => chunks.length >= 5);
    await send(admin, 'delete', `/api/admin/tenants/${h.tenantId}/workspaces/${ws.id}/members/${reader.user.id}`).expect(204);
    await until(() => revokedAt > 0);
    const atRevoke = chunks.length;
    await until(async () => (await h.s.db('messages').where({ id: sent.messageId }).first())?.completed_at);
    await sleep(50);
    expect(chunks.length).toBe(atRevoke);
    expect(chunks.filter((x) => x.at > revokedAt)).toHaveLength(0);
    await reader.get(`/api/shared-conversations/${conv.id}/messages/${sent.messageId}/stream?after=0`).expect(404);
  });

  it('a membership lost through a group mapping is published on the bus too', async () => {
    const ws = await h.s.tenants.createWorkspace(h.tenantId, 'Ops', 'internal');
    const u = await localUser(h, 'mapped', ['member'], 'internal');
    const seen: unknown[] = [];
    h.s.bus.on(TOPICS.workspaceMembership, (e) => void seen.push(e));
    await h.s.users.setWorkspaceMemberships(u.id, 'mapping', [ws.id]);
    await h.s.users.setWorkspaceMemberships(u.id, 'mapping', []);
    await until(() => seen.length > 0);
    expect(seen[0]).toEqual({ tenantId: h.tenantId, userId: u.id, workspaceIds: [ws.id] });
  });
});
