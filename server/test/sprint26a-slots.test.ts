import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProfileRow } from '../src/gateway/repo.js';
import { TOPICS } from '../src/platform/bus.js';
import { FakeOllama } from './fake-ollama.js';
import { seedGateway } from './seed-gateway.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * Sprint 26a: the two places left from "Before Sprint 24" that held a gateway slot while asking for another (Backlog
 * 1.4.0, Progress). With one slot per instance:
 *
 * - the guard model screening a stream asked for a slot while the answer held the only one, so no verdict could come
 *   back until the answer had finished: nothing was released while the model was still writing;
 * - a tool result in a chat tool round was screened by the guard model while the turn held the slot, so the screen
 *   waited out the queue and the result was withheld as "the guardrail check could not run".
 *
 * A turn's own requests now ride on the slot the turn holds (the gateway's turn context), so neither waits on it.
 */

const GB = 1_000_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function addGuardProfile(h: Harness, ollama: FakeOllama, poolId: string) {
  const repo = h.s.gateway.repo;
  ollama.addAvailable({ name: 'llama-guard3:8b', size: 5 * GB, capabilities: ['completion'] });
  const m = await repo.createModel({ name: 'llama-guard3:8b', source: 'Ollama library', expectedDigest: null, license: { name: 'test' }, label: 'confidential', notes: null, requestedBy: 'x', requestedTenant: h.tenantId });
  await repo.updateModel(m.id, { state: 'approved', import_state: 'pulled', capabilities: ['completion'], size_bytes: 5 * GB });
  await repo.place(m.id, poolId, 'warm', 'x');
  const t = Date.now();
  const row: ProfileRow = { id: 'LLAMAGUARD'.padEnd(26, '0'), tenant_id: h.tenantId, name: 'llama-guard', display_name: 'Guard', description: null, alias_of: null, model_id: m.id, pool_id: poolId, num_ctx: 8192, temperature: 0, think_default: 'off', think_ceiling: 'off', system_prompt: null, fallback: null, canary: null, tools: [], label: 'confidential', status: 'published', version: 1, updated_by: null, created_at: t, updated_at: t };
  await repo.createProfile(row);
}

async function oneSlot(h: Harness, poolId: string) {
  const [inst] = (await h.s.gateway.repo.instances()).filter((i) => i.pool_id === poolId);
  await h.s.gateway.repo.updateInstance(inst!.id, { settings: { ...inst!.settings, parallel: 1 } });
  await h.s.gateway.pollAll();
  expect((await h.s.gateway.snapshot())[0]!.instances[0]!.parallel).toBe(1);
}

const send = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);

async function publishGuardModelRule(admin: Client) {
  const set = (await send(admin, '/api/admin/guardrails/sets', { name: 'Guard model', scope: 'tenant' }).expect(201)).body;
  await admin.agent
    .put(`/api/admin/guardrails/sets/${set.id}/draft`)
    .set('x-csrf-token', admin.csrf)
    .send({ rules: [{ id: 'safety', name: 'Safety categories', checkpoint: 'model-output', type: 'guard model', mechanism: { kind: 'guard-model', profile: 'llama-guard' }, action: 'block', stage: 'enforce' }] })
    .expect(200);
  await send(admin, `/api/admin/guardrails/sets/${set.id}/draft/publish`).expect(200);
}

async function finished(h: Harness, messageId: string, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const m = await h.s.db('messages').where({ id: messageId }).first();
    if (m?.completed_at) return m as Record<string, unknown>;
    if (Date.now() > end) throw new Error('the answer did not finish');
    await sleep(20);
  }
}

describe('a turn never waits on the slot it holds (one slot per instance)', () => {
  let h: Harness;
  let ollama: FakeOllama;

  beforeEach(async () => {
    ollama = await new FakeOllama().start();
    h = await harness({ OLLAMA_POLL_MS: '600000', OLLAMA_QUEUE_TIMEOUT_MS: '4000' });
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  it('the guard model screens a streaming answer while the answer holds the only slot', async () => {
    const { pool } = await seedGateway(h, ollama, { label: 'internal' });
    await addGuardProfile(h, ollama, pool.id);
    await oneSlot(h, pool.id);
    await localUser(h, 'ga', ['guardrail-admin'], 'confidential');
    await publishGuardModelRule(await loginAdmin(h, 'ga'));
    await localUser(h, 'writer', ['member']);
    const m = await login(h, 'writer');
    const c: Client = { agent: m.agent, csrf: m.csrf, cookie: m.cookie };

    // A long answer, streamed slowly, so there is plenty of time for verdicts while the model is still writing.
    ollama.chatDelayMs = 15;
    ollama.reply = () => ({ content: Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is fine.`).join(' ') });
    const chunks: number[] = [];
    h.s.bus.on<{ event: string; data: Record<string, unknown> }>(TOPICS.chatEvent, (e) => {
      if (e.event === 'chat.chunk' && e.data.delta) chunks.push(Date.now());
    });
    // When the answer gives its slot back (a borrowed slot is not counted).
    let freedAt = 0;
    let busy = false;
    const watching = (async () => {
      const end = Date.now() + 20_000;
      while (!freedAt && Date.now() < end) {
        const inflight = (await h.s.gateway.snapshot())[0]!.instances[0]!.inflight;
        if (inflight > 0) busy = true;
        else if (busy) freedAt = Date.now();
        await sleep(5);
      }
    })();
    const sent = (await send(c, '/api/chat', { content: 'Write a lot', profile: 'general' }).expect(202)).body;
    const done = await finished(h, sent.messageId);
    await watching;
    expect(done.state).toBe('complete');
    expect(freedAt).toBeGreaterThan(0);
    // Verdicts came back, and text was released, while the answer still held its slot.
    expect(ollama.requests.filter((x) => x.path === '/api/chat' && x.body.model === 'llama-guard3:8b').length).toBeGreaterThan(1);
    // (Before the fix every verdict waited for the slot, so the whole answer went out at once after the slot was freed.)
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks[0]!).toBeLessThan(freedAt - 100);
    // Guardrail order is unchanged: the full check on the finished answer still ran, and passed it whole.
    const view = (await c.agent.get(`/api/conversations/${sent.conversationId}`).expect(200)).body;
    expect(view.messages[1].content).toContain('Sentence number 29 is fine.');
    expect((await h.s.gateway.snapshot())[0]!.instances[0]!.inflight).toBe(0);
  }, 60_000);

  it("chat's tool rounds screen tool results with the guard model without waiting for the turn's own slot", async () => {
    const { pool } = await seedGateway(h, ollama, { tools: ['calculate'], label: 'internal' });
    await addGuardProfile(h, ollama, pool.id);
    await oneSlot(h, pool.id);
    await localUser(h, 'ga', ['guardrail-admin'], 'confidential');
    await publishGuardModelRule(await loginAdmin(h, 'ga'));
    await localUser(h, 'calc', ['member']);
    const m = await login(h, 'calc');
    const c: Client = { agent: m.agent, csrf: m.csrf, cookie: m.cookie };
    ollama.reply = (messages) => (messages[messages.length - 1]!.role === 'tool' ? { content: 'The answer is 84.' } : { content: '', toolCall: { name: 'calculate', arguments: { expression: '12 * 7' } } });
    const t0 = Date.now();
    const sent = (await send(c, '/api/chat', { content: 'Compute', profile: 'general' }).expect(202)).body;
    const done = await finished(h, sent.messageId);
    expect(done.state).toBe('complete');
    const view = (await c.agent.get(`/api/conversations/${sent.conversationId}`).expect(200)).body;
    // The result was screened by the guard model and shown (before the fix: withheld after the queue timeout).
    expect(view.messages[1].tools).toEqual([{ name: 'calculate', expression: '12 * 7', result: { decimal: '84', exact: true, fraction: '84' } }]);
    expect(view.messages[1].content).toBe('The answer is 84.');
    const guardCalls = ollama.requests.filter((x) => x.path === '/api/chat' && x.body.model === 'llama-guard3:8b');
    expect(guardCalls.some((x) => JSON.stringify(x.body.messages).includes('12 * 7'))).toBe(true);
    // Well inside the queue timeout: nothing waited for the slot the turn held.
    expect(Date.now() - t0).toBeLessThan(4000);
    expect((await h.s.gateway.snapshot())[0]!.instances[0]!.inflight).toBe(0);
  }, 60_000);
});
