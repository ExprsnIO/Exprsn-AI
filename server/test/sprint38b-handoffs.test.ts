/*
 * 1.6.0, Sprint 38b: B-7801 agent handoffs.
 *
 *   An agent lists the specialists it may hand the conversation to (`handoffs`); the model hands over with the
 *   context it chooses as the task; the specialist's run answers, and the run that handed over ends with that answer,
 *   attributed to the specialist (`handedTo` on the run, `agent.run.handed_off` in the audit). A specialist that is
 *   not listed cannot be handed to.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';
import { seedGateway } from './seed-gateway.js';

describe('B-7801: agent handoffs', () => {
  let h: Harness;
  let ollama: FakeOllama;

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    ollama = await new FakeOllama().start();
    ollama.chatDelayMs = 0;
    await seedGateway(h, ollama);
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  async function admin(name: string) {
    await localUser(h, name, ['tool-admin'], 'confidential');
    const c = await loginAdmin(h, name);
    return { ...c, post: (path: string, body: object = {}) => c.agent.post(path).set('x-csrf-token', c.csrf).send(body) };
  }

  async function publishAgent(a: Awaited<ReturnType<typeof admin>>, b: Awaited<ReturnType<typeof admin>>, name: string, definition: Record<string, unknown>) {
    const e = (await a.post('/api/admin/registry', { kind: 'agent', name, version: '1.0.0', description: `${name}: answers customer questions in its area in two or three sentences and names the next step.`, label: 'confidential', definition: { profile: 'general', tools: [], budgets: { steps: 10, tokens: 10000, wallSeconds: 120, toolCalls: 4 }, ...definition } }).expect(201)).body;
    await a.post(`/api/admin/registry/${e.id}/submit`).expect(200);
    await b.post(`/api/admin/registry/${e.id}/review`, { decision: 'approve' }).expect(200);
    return e;
  }

  it('hands a billing question to the billing agent and attributes the answer to it', async () => {
    const a = await admin('author');
    const b = await admin('reviewer');
    await publishAgent(a, b, 'Billing agent', { systemPrompt: 'You are the billing specialist.' });
    await publishAgent(a, b, 'Shipping agent', { systemPrompt: 'You are the shipping specialist.' });
    // Handing to an unpublished specialist fails the chain check at review.
    const bad = (await a.post('/api/admin/registry', { kind: 'agent', name: 'Lost triage', version: '1.0.0', description: 'Routes customer questions to the specialist that answers them and summarises the outcome.', label: 'confidential', definition: { profile: 'general', tools: [], budgets: { steps: 10, tokens: 10000, wallSeconds: 120, toolCalls: 4 }, handoffs: ['Nobody'] } }).expect(201)).body;
    await a.post(`/api/admin/registry/${bad.id}/submit`).expect(200);
    expect((await b.post(`/api/admin/registry/${bad.id}/review`, { decision: 'approve' }).expect(409)).body.detail).toMatch(/Chain references/);
    const triage = await publishAgent(a, b, 'Triage agent', { systemPrompt: 'You are triage. Hand billing questions to the billing agent.', handoffs: ['Billing agent'] });
    expect(triage.definition.handoffs).toEqual(['Billing agent']);

    // The triage model hands over (the handoff tool is offered like a delegate, described as a handoff); the billing model answers.
    const offered: string[] = [];
    ollama.reply = (messages, opts) => {
      const system = messages.find((m) => m.role === 'system')?.content ?? '';
      const last = messages[messages.length - 1]!;
      if (system.includes('triage')) {
        offered.push(...(opts.tools as { function: { name: string; description: string } }[]).map((t) => `${t.function.name}: ${t.function.description}`));
        if (last.role === 'tool') return { content: 'This should never be asked: the run ended at the handoff.' };
        if (last.content.includes('shipping')) return { content: '', toolCall: { name: 'agent_Shipping_agent', arguments: { task: last.content } } };
        return { content: '', toolCall: { name: 'agent_Billing_agent', arguments: { task: `A customer asks: ${last.content}` } } };
      }
      return { content: 'Your invoice is due on the fifth of next month.' };
    };
    await localUser(h, 'mem', ['member'], 'confidential');
    const m = await login(h, 'mem');
    const post = (path: string, body: object) => m.agent.post(path).set('x-csrf-token', m.csrf).send(body);
    const run = (await post('/api/runs', { agent: 'Triage agent', input: 'When is my invoice due?', label: 'internal' }).expect(202)).body;
    await h.s.jobs.runDue();
    const v = (await m.agent.get(`/api/runs/${run.id}`).expect(200)).body;
    expect(v.state).toBe('succeeded');
    expect(v.output).toBe('Your invoice is due on the fifth of next month.');
    expect(v.handedTo).toMatchObject({ agent: 'Billing agent', run: expect.any(String) });
    expect(v.children).toEqual([expect.objectContaining({ id: v.handedTo.run, agent: 'Billing agent', state: 'succeeded' })]);
    expect(v.steps.map((s: { lane: string; title: string; state: string }) => [s.lane, s.title, s.state])).toEqual([['think', 'Plan', 'ok'], ['do', 'Billing agent', 'ok']]);
    expect(offered.some((t) => t.startsWith('agent_Billing_agent: Hand the conversation to Billing agent'))).toBe(true);
    const child = (await m.agent.get(`/api/runs/${v.handedTo.run}`).expect(200)).body;
    expect(child.input).toBe('A customer asks: When is my invoice due?');
    expect(child.caller).toMatchObject({ kind: 'agent-run', id: run.id });
    const ev = await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'agent.run.handed_off' }).first();
    expect(JSON.parse(ev.target)).toMatchObject({ run: run.id, agent: 'Triage agent', to: 'Billing agent', toRun: v.handedTo.run });
    expect(JSON.parse(ev.actor)).toMatchObject({ agent: 'Triage agent' });
    // The list shows who answered.
    expect((await m.agent.get('/api/runs').expect(200)).body.find((r: { id: string }) => r.id === run.id).handedTo).toMatchObject({ agent: 'Billing agent' });

    // A specialist that is not listed is not offered, and a call to it is refused as unavailable.
    const run2 = (await post('/api/runs', { agent: 'Triage agent', input: 'Where is my shipping parcel?', label: 'internal' }).expect(202)).body;
    await h.s.jobs.runDue();
    const v2 = (await m.agent.get(`/api/runs/${run2.id}`).expect(200)).body;
    expect(v2.handedTo).toBeNull();
    expect(v2.steps.find((s: { title: string }) => s.title === 'agent_Shipping_agent')).toMatchObject({ state: 'denied', detail: { error: expect.stringContaining('tool_unavailable') } });
    expect(offered.filter((t) => t.startsWith('agent_Shipping_agent'))).toEqual([]);
  });
});
