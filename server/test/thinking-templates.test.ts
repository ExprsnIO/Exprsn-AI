import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatChunk, ChatRequest } from '../src/gateway/ollama.js';
import { effectiveCapabilities, splitThinking, templateRequest, thinkingOf, ThinkSplitter, THINKING_TEMPLATES } from '../src/gateway/thinking.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

const GB = 1_000_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAGISTRAL = THINKING_TEMPLATES.magistral!;

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(10);
  }
}

async function collect(chunks: ChatChunk[], template = MAGISTRAL) {
  async function* source() {
    for (const c of chunks) yield c;
  }
  let content = '';
  let thinking = '';
  const out: ChatChunk[] = [];
  for await (const c of splitThinking(source(), template)) {
    out.push(c);
    content += c.message?.content ?? '';
    thinking += c.message?.thinking ?? '';
  }
  return { content, thinking, out };
}
const text = (s: string, done = false): ChatChunk => ({ message: { role: 'assistant', content: s }, done });

describe('model thinking templates (B-11707)', () => {
  describe('separating the thinking from the answer', () => {
    it('splits on the tags whatever the chunk boundaries, and never leaves a tag in the answer', async () => {
      const whole = '<think>\nFirst I add 2 and 2.\nThat is 4.\n</think>\n\nThe answer is 4.';
      for (const size of [1, 2, 3, 5, 7, 64]) {
        const chunks: ChatChunk[] = [];
        for (let i = 0; i < whole.length; i += size) chunks.push(text(whole.slice(i, i + size)));
        chunks.push({ message: { role: 'assistant', content: '' }, done: true, eval_count: 9 } as ChatChunk);
        const r = await collect(chunks);
        expect(r.thinking).toBe('\nFirst I add 2 and 2.\nThat is 4.\n');
        expect(r.content).toBe('The answer is 4.');
        expect(r.out.every((c) => !(c.message?.content ?? '').includes('think>'))).toBe(true);
        expect(r.out[r.out.length - 1]).toMatchObject({ done: true, eval_count: 9 });
      }
    });

    it('keeps text that only looks like the start of a tag, several blocks, and an unfinished block as thinking', async () => {
      expect((await collect([text('a < b and <th'), text('ings> stay'), text('', true)])).content).toBe('a < b and <things> stay');
      const two = await collect([text('<think>one</think>Half. <think>two</think> Done.'), text('', true)]);
      expect(two).toMatchObject({ thinking: 'onetwo', content: 'Half. Done.' });
      // Cut off inside the block (num_predict): nothing of it is an answer.
      expect(await collect([text('<think>still reasoning'), text('', true)])).toMatchObject({ thinking: 'still reasoning', content: '' });
      // A stream that ends without a final chunk still gives up what was kept back.
      expect((await collect([text('The end <thi')])).content).toBe('The end <thi');
    });

    it('starts inside the thinking for a model whose chat template wrote the opening tag', async () => {
      const r = await collect([text('reasoning here</think>Answer.'), text('', true)], { id: 'custom', name: 'Custom', system: '', open: '<think>', close: '</think>', startsOpen: true });
      expect(r).toMatchObject({ thinking: 'reasoning here', content: 'Answer.' });
    });

    it('passes tool calls and native thinking through', async () => {
      const call = { function: { name: 'calculate', arguments: { expression: '1+1' } } };
      const r = await collect([{ message: { role: 'assistant', content: '', thinking: 'native ' }, done: false }, text('<think>tagged</think>'), { message: { role: 'assistant', content: '', tool_calls: [call] }, done: false }, text('', true)]);
      expect(r.thinking).toBe('native tagged');
      expect(r.out.some((c) => c.message?.tool_calls?.[0]?.function.name === 'calculate')).toBe(true);
    });

    it('the splitter alone holds back only a possible tag', () => {
      const s = new ThinkSplitter('[THINK]', '[/THINK]');
      expect(s.push('Hello [TH')).toEqual({ content: 'Hello ', thinking: '' });
      expect(s.push('INK]hm[/THINK] there')).toEqual({ content: 'there', thinking: 'hm' });
      expect(s.end()).toEqual({ content: '', thinking: '' });
    });
  });

  describe('the request', () => {
    const req: ChatRequest = { model: 'm', messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hi' }], think: true };

    it('adds the instruction ahead of the system prompt when thinking is asked for, and never sends think', () => {
      const out = templateRequest(req, MAGISTRAL);
      expect(out).not.toHaveProperty('think');
      expect(out.messages[0]).toEqual({ role: 'system', content: `${MAGISTRAL.system}\n\nBe brief.` });
      expect(req.messages[0]!.content).toBe('Be brief.'); // the caller's messages are not changed
      expect(templateRequest({ ...req, messages: [{ role: 'user', content: 'hi' }], think: 'high' }, MAGISTRAL).messages).toEqual([{ role: 'system', content: MAGISTRAL.system }, { role: 'user', content: 'hi' }]);
    });

    it('leaves the messages alone when thinking is off', () => {
      for (const think of [false, undefined] as const) {
        const out = templateRequest({ ...req, think }, MAGISTRAL);
        expect(out).not.toHaveProperty('think');
        expect(out.messages).toEqual(req.messages);
      }
    });
  });

  describe('what a model record means', () => {
    it('reads the manifest when nothing is recorded, and the record when one is', () => {
      expect(thinkingOf({ capabilities: ['completion', 'thinking'] })).toMatchObject({ mode: 'native', recorded: false });
      expect(thinkingOf({ capabilities: ['completion'] })).toMatchObject({ mode: 'none', recorded: false });
      expect(thinkingOf({ thinking_mode: 'template', thinking_template: { id: 'magistral' }, capabilities: ['completion'] })).toMatchObject({ mode: 'template', recorded: true, template: { id: 'magistral', open: '<think>' } });
      // a template this server does not know leaves the model without thinking
      expect(thinkingOf({ thinking_mode: 'template', thinking_template: { id: 'gone' }, capabilities: ['completion'] })).toMatchObject({ mode: 'none', template: null });
      expect(effectiveCapabilities(['completion'], 'template', { id: 'magistral' })).toEqual(['completion', 'thinking']);
      expect(effectiveCapabilities(['completion', 'thinking'], 'none', null)).toEqual(['completion']);
      expect(effectiveCapabilities(['completion'], 'native', null)).toEqual(['completion', 'thinking']);
      expect(effectiveCapabilities(['completion'], null, null)).toEqual(['completion']);
    });
  });

  describe('through the server', () => {
    let h: Harness;
    let ollama: FakeOllama;
    let a: Client;
    let b: Client;
    const send = (c: Client, method: 'post' | 'put' | 'patch', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);
    const chatCalls = () => ollama.requests.filter((r) => r.path === '/api/chat' && r.body.model === 'magistral:24b').map((r) => r.body as { think?: unknown; messages: { role: string; content: string }[]; tools?: unknown[] });

    /** A stand-in for Magistral: it reasons in its tags only when told to, and calls a tool only with a system prompt. */
    const magistral = (msgs: { role: string; content: string }[], o: { tools: unknown[] }) => {
      const system = msgs.find((m) => m.role === 'system')?.content ?? '';
      if (o.tools.length) return system ? { content: '', toolCall: { name: 'calculate', arguments: { expression: '17*23' } } } : { content: 'I can work that out myself: 391.' };
      if (system.includes('Your thinking process must follow the template')) return { content: '<think>\nThe user greets me. I greet back.\n</think>\n\nHello to you.' };
      return { content: 'ready' };
    };

    beforeEach(async () => {
      h = await harness({ OLLAMA_POLL_MS: '600000' });
      ollama = await new FakeOllama().start();
      ollama.chatDelayMs = 1;
      // Magistral as Ollama lists it for this test: no native thinking.
      ollama.registry.set('magistral:24b', { name: 'magistral:24b', size: 14 * GB, capabilities: ['completion', 'tools'] });
      ollama.reply = magistral as never;
      await localUser(h, 'ma', ['model-admin'], 'confidential');
      await localUser(h, 'mb', ['model-admin'], 'confidential');
      a = await loginAdmin(h, 'ma');
      b = await loginAdmin(h, 'mb');
    });
    afterEach(async () => {
      await h.close();
      await ollama.stop();
    });

    async function pulled() {
      const pool = (await send(a, 'post', '/api/admin/pools', { name: 'gpu', accelerator: 'cuda', labelCeiling: 'confidential' }).expect(201)).body;
      await send(a, 'post', `/api/admin/pools/${pool.id}/instances`, { name: 'gpu-1', url: ollama.url, deploy: 'docker', settings: { memoryBytes: 48 * GB, parallel: 2 } }).expect(201);
      const model = (await send(a, 'post', '/api/admin/models', { name: 'magistral:24b', license: { name: 'Apache-2.0' }, label: 'internal', poolId: pool.id }).expect(201)).body;
      await h.s.jobs.runDue();
      return { pool, model };
    }
    const row = async (id: string) => ((await a.agent.get('/api/admin/models').expect(200)).body as { id: string }[]).find((m) => m.id === id) as unknown as Record<string, never> & { capabilities: string[]; thinking: { mode: string; recorded: boolean; template: { id: string; open: string } | null }; evaluation: { passed: number; total: number; toolsWithheld: boolean; tests: { name: string; ok: boolean; detail: string }[] }; state: string };

    it('records a template on a catalogue entry, with the built-ins to pick from', async () => {
      const { model } = await pulled();
      expect((await row(model.id)).thinking).toEqual({ mode: 'none', recorded: false, template: null });

      const list = (await a.agent.get('/api/admin/models/thinking-templates').expect(200)).body as { id: string; open: string; system: string }[];
      expect(list.map((t) => t.id)).toEqual(expect.arrayContaining(['magistral', 'magistral-think-tokens', 'think-tags']));
      expect(list.find((t) => t.id === 'magistral')).toMatchObject({ open: '<think>', close: '</think>' });

      await send(a, 'patch', `/api/admin/models/${model.id}`, { thinking: { mode: 'template' } }).expect(400);
      await send(a, 'patch', `/api/admin/models/${model.id}`, { thinking: { mode: 'template', template: 'no-such' } }).expect(400);
      await send(a, 'patch', `/api/admin/models/${model.id}`, { thinking: { mode: 'native', template: 'magistral' } }).expect(400);
      await send(a, 'patch', `/api/admin/models/${model.id}`, { thinking: { mode: 'template', template: { system: '', open: '<t>', close: '<t>' } } }).expect(400);
      await send(a, 'patch', `/api/admin/models/${model.id}`, { thinking: { mode: 'template', template: { system: '', open: '< t>', close: '</t>' } } }).expect(400);

      const set = (await send(a, 'patch', `/api/admin/models/${model.id}`, { thinking: { mode: 'template', template: 'magistral' } }).expect(200)).body;
      expect(set.thinking).toMatchObject({ mode: 'template', recorded: true, template: { id: 'magistral', open: '<think>', close: '</think>' } });
      expect(set.capabilities).toContain('thinking');
      expect((await h.s.audit.list(h.tenantId, { action: 'model.updated' }))[0]!.detail).toMatchObject({ after: { thinking: { mode: 'template', template: 'magistral' } } });

      const custom = (await send(a, 'patch', `/api/admin/models/${model.id}`, { thinking: { mode: 'template', template: { system: 'Reason inside the tags first.', open: '<reason>', close: '</reason>' } } }).expect(200)).body;
      expect(custom.thinking.template).toMatchObject({ id: 'custom', open: '<reason>', system: 'Reason inside the tags first.' });

      expect((await send(a, 'patch', `/api/admin/models/${model.id}`, { thinking: { mode: 'none' } }).expect(200)).body).toMatchObject({ thinking: { mode: 'none', recorded: true, template: null } });
      // forgetting the record gives the manifest its word back
      await send(a, 'patch', `/api/admin/models/${model.id}`, { thinking: { mode: 'template', template: 'magistral' } }).expect(200);
      const back = (await send(a, 'patch', `/api/admin/models/${model.id}`, { thinking: { mode: null } }).expect(200)).body;
      expect(back.thinking).toEqual({ mode: 'none', recorded: false, template: null });
      expect(back.capabilities).not.toContain('thinking');
    });

    it('passes the tool-calling evaluation with a system prompt, and checks the template (the Magistral case)', async () => {
      const { model } = await pulled();
      await send(a, 'patch', `/api/admin/models/${model.id}`, { thinking: { mode: 'template', template: 'magistral' } }).expect(200);
      await send(a, 'post', `/api/admin/models/${model.id}/evaluate`).expect(202);
      await h.s.jobs.runDue();
      const m = await row(model.id);
      expect(m.state).toBe('evaluated');
      expect(m.evaluation).toMatchObject({ passed: 3, total: 3, toolsWithheld: false });
      expect(m.evaluation.tests.map((t) => t.name)).toEqual(['Chat smoke test', 'Tool calling', 'Thinking template']);
      const calls = chatCalls();
      const tool = calls.find((c) => c.tools?.length)!;
      expect(tool.messages[0]!.role).toBe('system');
      expect(tool).not.toHaveProperty('think');
      // the template check asked for thinking, so the instruction went with it
      expect(calls[calls.length - 1]!.messages[0]!.content).toContain('Your thinking process must follow the template');
    });

    it('fails the template check for a model that does not follow its template', async () => {
      const { model } = await pulled();
      await send(a, 'patch', `/api/admin/models/${model.id}`, { thinking: { mode: 'template', template: 'magistral-think-tokens' } }).expect(200);
      // the stand-in reasons in <think> tags, not in [THINK] tokens
      await send(a, 'post', `/api/admin/models/${model.id}/evaluate`).expect(202);
      await h.s.jobs.runDue();
      const m = await row(model.id);
      expect(m.evaluation.tests.find((t) => t.name === 'Thinking template')).toMatchObject({ ok: false });
      expect(m.evaluation).toMatchObject({ passed: 2, total: 3 });
      expect(m.state).toBe('evaluated'); // the smoke test decides the state, as before
    });

    it('a profile created on the model thinks without a hand-written convention, and the tags never reach the answer', async () => {
      const { pool, model } = await pulled();
      await send(a, 'patch', `/api/admin/models/${model.id}`, { thinking: { mode: 'template', template: 'magistral' } }).expect(200);
      await send(a, 'post', `/api/admin/models/${model.id}/evaluate`).expect(202);
      await h.s.jobs.runDue();
      await send(b, 'post', `/api/admin/models/${model.id}/lifecycle`, { to: 'approved' }).expect(200);

      // no thinking levels and no system prompt given
      const created = (await send(a, 'post', '/api/admin/profiles', { name: 'reasoner', displayName: 'Reasoner', modelId: model.id, poolId: pool.id, label: 'internal' }).expect(201)).body;
      expect(created).toMatchObject({ thinkDefault: 'medium', thinkCeiling: 'high', systemPrompt: null });
      await send(a, 'post', `/api/admin/profiles/${created.id}/publish`).expect(200);
      const listed = ((await a.agent.get('/api/admin/profiles').expect(200)).body as { name: string; model: { thinking: unknown } }[]).find((p) => p.name === 'reasoner')!;
      expect(listed.model.thinking).toEqual({ mode: 'template', recorded: true, template: { id: 'magistral', name: MAGISTRAL.name } });
      // saying off still switches it off
      const quiet = (await send(a, 'post', '/api/admin/profiles', { name: 'quiet', displayName: 'Quiet', modelId: model.id, poolId: pool.id, label: 'internal', thinkDefault: 'off', thinkCeiling: 'off' }).expect(201)).body;
      expect(quiet).toMatchObject({ thinkDefault: 'off', thinkCeiling: 'off' });

      await localUser(h, 'mem', ['member'], 'internal');
      const m = await login(h, 'mem');
      const events: { event: string; data: Record<string, unknown> }[] = [];
      const { TOPICS } = await import('../src/platform/bus.js');
      h.s.bus.on<{ event: string; data: Record<string, unknown> }>(TOPICS.chatEvent, (e) => void events.push(e));
      const before = chatCalls().length;
      const sent = (await m.agent.post('/api/chat').set('x-csrf-token', m.csrf).send({ content: 'Hello', profile: 'reasoner' }).expect(202)).body;
      expect(sent.think).toBe('medium');
      await until(async () => (await h.s.db('messages').where({ id: sent.messageId }).first())?.completed_at);

      const call = chatCalls()[before]!;
      expect(call).not.toHaveProperty('think');
      expect(call.messages[0]).toMatchObject({ role: 'system' });
      expect(call.messages[0]!.content).toBe(MAGISTRAL.system);
      const view = (await m.agent.get(`/api/conversations/${sent.conversationId}`).expect(200)).body;
      expect(view.messages[1]).toMatchObject({ content: 'Hello to you.', thinking: '\nThe user greets me. I greet back.\n', state: 'complete' });
      expect(view.messages[1].usage.thinkingTokens).toBeGreaterThan(0);
      // streamed as thinking, never as answer text
      const chunks = events.filter((e) => e.event === 'chat.chunk' && e.data.messageId === sent.messageId).map((e) => e.data);
      expect(chunks.map((c) => c.delta ?? '').join('')).toBe('Hello to you.');
      expect(chunks.map((c) => c.thinking ?? '').join('')).toContain('I greet back.');
      expect(JSON.stringify(chunks)).not.toContain('think>');
      // the next turn's history holds the answer only
      const next = (await m.agent.post(`/api/conversations/${sent.conversationId}/messages`).set('x-csrf-token', m.csrf).send({ content: 'Again', parentId: sent.messageId, profile: 'reasoner', think: 'off' }).expect(202)).body;
      await until(async () => (await h.s.db('messages').where({ id: next.messageId }).first())?.completed_at);
      const second = chatCalls().pop()!;
      expect(second.messages.map((x) => x.content)).toEqual(['Hello', 'Hello to you.', 'Again']); // thinking off: no instruction
      expect(second).not.toHaveProperty('think');
    });

    it('the thinking of a template model passes the output check like native thinking', async () => {
      const { pool, model } = await pulled();
      await send(a, 'patch', `/api/admin/models/${model.id}`, { thinking: { mode: 'template', template: 'magistral' } }).expect(200);
      await send(a, 'post', `/api/admin/models/${model.id}/evaluate`).expect(202);
      await h.s.jobs.runDue();
      await send(b, 'post', `/api/admin/models/${model.id}/lifecycle`, { to: 'approved' }).expect(200);
      const created = (await send(a, 'post', '/api/admin/profiles', { name: 'reasoner', displayName: 'Reasoner', modelId: model.id, poolId: pool.id, label: 'internal' }).expect(201)).body;
      await send(a, 'post', `/api/admin/profiles/${created.id}/publish`).expect(200);
      await localUser(h, 'ga', ['guardrail-admin'], 'confidential');
      const ga = await loginAdmin(h, 'ga');
      const set = (await send(ga, 'post', '/api/admin/guardrails/sets', { name: 'Thinking rules', scope: 'tenant' }).expect(201)).body;
      await send(ga, 'put', `/api/admin/guardrails/sets/${set.id}/draft`, { rules: [{ id: 'codeword', name: 'Codeword', checkpoint: 'model-output', type: 'pattern', mechanism: { kind: 'pattern', pattern: 'ZEBRA-7' }, action: 'block', stage: 'enforce' }] }).expect(200);
      await send(ga, 'post', `/api/admin/guardrails/sets/${set.id}/draft/publish`).expect(200);

      ollama.reply = (() => ({ content: '<think>The codeword is ZEBRA-7 but I must not say it</think>A harmless answer.' })) as never;
      await localUser(h, 'mem', ['member'], 'internal');
      const m = await login(h, 'mem');
      const sent = (await m.agent.post('/api/chat').set('x-csrf-token', m.csrf).send({ content: 'Hello', profile: 'reasoner' }).expect(202)).body;
      await until(async () => (await h.s.db('messages').where({ id: sent.messageId }).first())?.completed_at);
      const view = (await m.agent.get(`/api/conversations/${sent.conversationId}`).expect(200)).body;
      expect(JSON.stringify(view.messages[1])).not.toContain('ZEBRA-7');
      expect(view.messages[1].guard).toMatchObject({ thinking: { action: 'block', rules: ['Codeword'] } });
    });
  });
});
