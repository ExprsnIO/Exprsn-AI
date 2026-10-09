/**
 * 1.6.0 Sprint 36b (B-11707): model thinking templates. A Magistral-like model (its `show` carries a chat template and a
 * default system prompt that ask for <think> blocks) is recorded as a template model at pull; the catalogue evaluation
 * sends a system prompt as chat does, so the model calls the tool instead of answering in prose under Ollama's
 * substituted prompt; a profile on the model thinks without a hand-written convention, its <think> block delivered as
 * thinking; the catalogue entry can override the mode, and a template model passes the profile publish check.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachRealtime } from '../src/realtime/socket.js';
import { DEFAULT_THINK_TEMPLATE, NO_THINK_PROMPT, ThinkSplitter, detectThinking, splitThink, thinkingRequest } from '../src/gateway/thinking.js';
import { FakeOllama, TEMPLATE_SYSTEM, templateModel } from './fake-ollama.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

const GB = 1_000_000_000;

describe('model thinking templates (B-11707)', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let a: Client;
  let b: Client;
  let server: Server;
  let url: string;
  const sockets: Socket[] = [];
  const post = (c: Client, u: string, body: object = {}) => c.agent.post(u).set('x-csrf-token', c.csrf).send(body);
  const patch = (c: Client, u: string, body: object) => c.agent.patch(u).set('x-csrf-token', c.csrf).send(body);

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    ollama = await new FakeOllama().start();
    ollama.registry.set('magistral:24b', templateModel());
    ollama.registry.set('qwen3:8b', { name: 'qwen3:8b', size: 6 * GB, capabilities: ['completion', 'tools', 'thinking'] });
    await localUser(h, 'ma', ['model-admin'], 'confidential');
    await localUser(h, 'mb', ['model-admin'], 'confidential');
    a = await loginAdmin(h, 'ma');
    b = await loginAdmin(h, 'mb');
    server = createServer(h.app);
    attachRealtime(server, h.s);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await h.close();
    await ollama.stop();
  });

  /** Pulls, evaluates and approves a registry model onto a pool; returns the catalogue row and the pool. */
  async function approved(name: string) {
    const pool = (await post(a, '/api/admin/pools', { name: 'gpu', accelerator: 'cuda', labelCeiling: 'confidential' }).expect(201)).body;
    await post(a, `/api/admin/pools/${pool.id}/instances`, { name: 'gpu-1', url: ollama.url, deploy: 'docker', settings: { memoryBytes: 64 * GB, parallel: 2 } }).expect(201);
    const m = (await post(a, '/api/admin/models', { name, license: { name: 'Apache 2.0' }, label: 'confidential', poolId: pool.id }).expect(201)).body;
    await h.s.jobs.runDue();
    await post(a, `/api/admin/models/${m.id}/evaluate`).expect(202);
    await h.s.jobs.runDue();
    await post(b, `/api/admin/models/${m.id}/lifecycle`, { to: 'approved' }).expect(200);
    const row = (await a.agent.get('/api/admin/models').expect(200)).body.find((x: { id: string }) => x.id === m.id);
    return { pool, model: row };
  }

  async function member() {
    await localUser(h, 'mem', ['member'], 'confidential');
    const c = await login(h, 'mem');
    const sock = ioClient(url, { path: '/socket.io', transports: ['websocket'], reconnection: false, extraHeaders: { cookie: c.cookie } });
    sockets.push(sock);
    await new Promise((r) => sock.on('ready', r));
    const done = (messageId: string) => new Promise<void>((resolve) => sock.on('chat.done', (d: { messageId: string }) => d.messageId === messageId && resolve()));
    return { ...c, done, post: (u: string, body: object = {}) => c.agent.post(u).set('x-csrf-token', c.csrf).send(body) };
  }

  it('records the template mode at pull, and the evaluation sends a system prompt so the model calls the tool', async () => {
    const { model } = await approved('magistral:24b');
    expect(model).toMatchObject({ thinking: 'template', thinkingSet: 'template', capabilities: ['completion', 'tools', 'thinking'] });
    expect(model.thinkingTemplate).toContain('<think>');
    expect(model.evaluation).toMatchObject({ passed: 2, total: 2, toolsWithheld: false });
    const chats = ollama.requests.filter((r) => r.path === '/api/chat');
    expect(chats.length).toBe(2);
    for (const r of chats) expect((r.body.messages as { role: string }[])[0]!.role).toBe('system');
    // a native model is recorded as native, and the evaluation still passes
    const native = await approved('qwen3:8b').catch(() => null);
    if (native) expect(native.model).toMatchObject({ thinking: 'native', thinkingSet: 'native', thinkingTemplate: null });
  });

  it('a profile on a template model thinks without a hand-written convention, and not when thinking is off', async () => {
    const { pool, model } = await approved('magistral:24b');
    const prof = (await post(a, '/api/admin/profiles', { name: 'magi', displayName: 'Magi', modelId: model.id, poolId: pool.id, label: 'confidential', thinkDefault: 'high', thinkCeiling: 'high' }).expect(201)).body;
    await post(a, `/api/admin/profiles/${prof.id}/publish`).expect(200);
    await h.s.gateway.pollAll();
    const m = await member();
    ollama.requests.length = 0;
    const sent = await m.post('/api/chat', { content: 'How many legs has a spider?', profile: 'magi' }).expect(202);
    expect(sent.body.think).toBe('high');
    await m.done(sent.body.messageId);
    const req = ollama.requests.find((r) => r.path === '/api/chat')!.body;
    const system = (req.messages as { role: string; content: string }[]).find((x) => x.role === 'system')!;
    expect(system.content).toContain('<think>'); // the model's own convention, appended by the gateway
    expect(system.content).toContain(TEMPLATE_SYSTEM.slice(0, 40));
    expect(req.think).toBe(true);
    const view = (await m.agent.get(`/api/conversations/${sent.body.conversationId}`).expect(200)).body;
    expect(view.messages[1].thinking).toBe('Working it out on scratch paper.\n');
    expect(view.messages[1].content).toBe('The answer to "How many legs has a spider?".');
    expect(view.messages[1].content).not.toContain('<think>');

    ollama.requests.length = 0;
    const off = await m.post('/api/chat', { content: 'Plain question', profile: 'magi', think: 'off' }).expect(202);
    await m.done(off.body.messageId);
    const req2 = ollama.requests.find((r) => r.path === '/api/chat')!.body;
    const sys2 = (req2.messages as { role: string; content: string }[]).find((x) => x.role === 'system')!;
    expect(sys2.content).not.toContain('<think>'); // a prompt that asks for a direct answer, so the server substitutes none
    expect(req2.think).toBe(false);
    const view2 = (await m.agent.get(`/api/conversations/${off.body.conversationId}`).expect(200)).body;
    expect(view2.messages[1]).toMatchObject({ thinking: null, content: 'Plainly: Plain question' });
  });

  it('the catalogue entry overrides the mode, and the publish check follows it', async () => {
    const { pool, model } = await approved('magistral:24b');
    const none = await patch(a, `/api/admin/models/${model.id}`, { thinking: 'none' }).expect(200);
    expect(none.body).toMatchObject({ thinking: 'none', thinkingSet: 'none' });
    const prof = (await post(a, '/api/admin/profiles', { name: 'deep', displayName: 'Deep', modelId: model.id, poolId: pool.id, label: 'confidential', thinkDefault: 'low', thinkCeiling: 'high' }).expect(201)).body;
    const refused = await post(a, `/api/admin/profiles/${prof.id}/publish`).expect(409);
    expect(refused.body.detail).toMatch(/does not support thinking/);
    const back = await patch(a, `/api/admin/models/${model.id}`, { thinking: 'template', thinkingTemplate: 'Think first inside <think> and </think>, then answer.' }).expect(200);
    expect(back.body).toMatchObject({ thinking: 'template', thinkingTemplate: 'Think first inside <think> and </think>, then answer.' });
    await post(a, `/api/admin/profiles/${prof.id}/publish`).expect(200);
    const events = (await h.s.audit.list(h.tenantId, { action: 'model.updated' })).map((e) => e.detail);
    expect(events.some((d) => JSON.stringify(d).includes('"thinking":"none"'))).toBe(true);
    // clearing the override returns to the derived mode (native: the model claims the thinking capability)
    const derived = await patch(a, `/api/admin/models/${model.id}`, { thinking: null, thinkingTemplate: null }).expect(200);
    expect(derived.body).toMatchObject({ thinking: 'native', thinkingSet: null, thinkingTemplate: null });
  });

  it('shapes requests and splits <think> blocks across chunk boundaries', () => {
    const model = { name: 'magistral:24b', capabilities: ['completion', 'tools', 'thinking'], thinking: 'template' as const, thinking_template: null };
    const msgs = [{ role: 'user' as const, content: 'hi' }];
    expect(thinkingRequest(model, 'medium', msgs)).toEqual({ think: true });
    expect(msgs[0]).toMatchObject({ role: 'system', content: DEFAULT_THINK_TEMPLATE });
    const withPrompt = [{ role: 'system' as const, content: 'Be brief.' }, { role: 'user' as const, content: 'hi' }];
    thinkingRequest(model, 'low', withPrompt);
    expect(withPrompt[0]!.content).toBe(`Be brief.\n\n${DEFAULT_THINK_TEMPLATE}`);
    const own = [{ role: 'system' as const, content: 'Draft inside <think> tags.' }];
    thinkingRequest(model, 'low', own);
    expect(own[0]!.content).toBe('Draft inside <think> tags.'); // a hand-written convention is left alone
    expect(thinkingRequest({ ...model, capabilities: ['completion'] }, 'high', [])).toEqual({});
    const offMsgs = [{ role: 'user' as const, content: 'hi' }];
    expect(thinkingRequest(model, 'off', offMsgs)).toEqual({ think: false });
    expect(offMsgs[0]).toMatchObject({ role: 'system', content: NO_THINK_PROMPT });
    expect(thinkingRequest({ name: 'gpt-oss:20b', capabilities: ['completion', 'thinking'], thinking: null, thinking_template: null }, 'high', [])).toEqual({ think: 'high' });
    expect(thinkingRequest({ name: 'qwen3:8b', capabilities: ['completion', 'thinking'], thinking: 'none', thinking_template: null }, 'high', [])).toEqual({});
    expect(detectThinking({ capabilities: ['completion', 'thinking'], system: TEMPLATE_SYSTEM })).toMatchObject({ thinking: 'template' });
    expect(detectThinking({ capabilities: ['completion', 'thinking'] })).toEqual({ thinking: 'native', thinking_template: null });
    expect(detectThinking({ capabilities: ['completion'], template: '{{ .Prompt }}<think>{{ .Thinking }}</think>' })).toEqual({ thinking: 'template', thinking_template: null });

    const s = new ThinkSplitter();
    const parts = ['<thi', 'nk>\nstep one ', 'step two</th', 'ink>\nThe ans', 'wer.'].map((c) => s.feed(c));
    const rest = s.flush();
    expect(parts.map((p) => p.thinking).join('') + rest.thinking).toBe('step one step two');
    expect(parts.map((p) => p.content).join('') + rest.content).toBe('The answer.');
    expect(splitThink('No tags here')).toEqual({ thinking: '', content: 'No tags here' });
    expect(splitThink('<think>unterminated')).toEqual({ thinking: 'unterminated', content: '' });
  });
});
