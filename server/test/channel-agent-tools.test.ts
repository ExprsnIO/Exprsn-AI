import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';
import { seedGateway } from './seed-gateway.js';

/** A chat channel bound to an agent that runs the agent's read tools as a member account (`agentTools`, `runAs`). */
describe('Channels that run their agent\'s tools', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let wsId: string;

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    ollama = await new FakeOllama().start();
    ollama.chatDelayMs = 0;
    await seedGateway(h, ollama);
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Support', 'confidential')).id;
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  const admin = async (name: string, role: string) => {
    const u = await localUser(h, name, [role], 'confidential');
    const c = await loginAdmin(h, name);
    return { id: u.id, post: (p: string, b: object = {}) => c.agent.post(p).set('x-csrf-token', c.csrf).send(b), patch: (p: string, b: object = {}) => c.agent.patch(p).set('x-csrf-token', c.csrf).send(b), get: (p: string) => c.agent.get(p) };
  };
  const pub = () => request(h.app);
  const customer = (token: string) => ({
    send: (text: string) => pub().post('/api/public/channels/session/messages').set('authorization', `Bearer ${token}`).send({ text }),
    view: (after = 0) => pub().get(`/api/public/channels/session?after=${after}`).set('authorization', `Bearer ${token}`)
  });

  it('offers the read tools only, runs them as the run-as account, and delivers the answer on the next read', async () => {
    // An agent with a read tool and a write tool, published by two tool admins.
    const [author, reviewer] = [await admin('author', 'tool-admin'), await admin('reviewer', 'tool-admin')];
    const e = (await author.post('/api/admin/registry', { kind: 'agent', name: 'Desk', version: '1.0.0', description: 'Answers the questions of customers and computes what they ask for exactly.', label: 'confidential', definition: { profile: 'general', systemPrompt: 'Be exact.', tools: ['calculate', 'memory_save'], budgets: { steps: 5, tokens: 10000, wallSeconds: 60, toolCalls: 2 } } }).expect(201)).body as { id: string };
    await author.post(`/api/admin/registry/${e.id}/submit`).expect(200);
    await reviewer.post(`/api/admin/registry/${e.id}/review`, { decision: 'approve' }).expect(200);

    const a = await admin('ta', 'tenant-admin');
    const svc = await localUser(h, 'svc', ['member'], 'internal');
    const body = { workspaceId: wsId, kind: 'chat', name: 'Desk', label: 'internal', target: { kind: 'agent', name: 'Desk' }, reviewMode: 'never', agentTools: true };
    // The binding is checked when it is saved: an agent, an account, a member of the workspace, no admin permission.
    await a.post('/api/channels', body).expect(400);
    await a.post('/api/channels', { ...body, target: { kind: 'profile', name: 'general' }, runAs: svc.id }).expect(400);
    expect((await a.post('/api/channels', { ...body, runAs: a.id }).expect(422)).body).toMatchObject({ step: 'run-as', detail: expect.stringContaining('admin permissions') });
    expect((await a.post('/api/channels', { ...body, runAs: svc.id }).expect(422)).body.detail).toMatch(/not a member of the channel's workspace/);
    await h.s.tenants.addMember(wsId, svc.id);
    const ch = (await a.post('/api/channels', { ...body, runAs: svc.id }).expect(201)).body as { id: string; publicKey: string; agentTools: boolean; runAs: string };
    expect(ch).toMatchObject({ agentTools: true, runAs: svc.id });

    ollama.reply = (messages) => {
      const last = messages[messages.length - 1]!;
      if (last.role === 'tool') return { content: `The total is ${JSON.parse(last.content).decimal}.` };
      return { content: '', toolCall: { name: 'calculate', arguments: { expression: '19 * 21' } } };
    };
    const start = (await pub().post('/api/public/channels/sessions').send({ channel: ch.publicKey }).expect(201)).body as { token: string };
    const cu = customer(start.token);
    // The answer is queued: the request does not wait for the tools.
    expect((await cu.send('What is 19 times 21?').expect(201)).body).toMatchObject({ pending: true, reply: null });
    await h.s.jobs.runDue();
    const view = (await cu.view().expect(200)).body as { messages: { role: string; text: string }[] };
    expect(view.messages.map((m) => [m.role, m.text])).toEqual([['customer', 'What is 19 times 21?'], ['assistant', 'The total is 399.']]);

    // The model was offered the read tool, never the write; the skills-and-limits note is in its system prompt.
    const chats = ollama.requests.filter((r) => r.path === '/api/chat').map((r) => r.body as { tools?: { function: { name: string } }[]; messages: { role: string; content: string }[] });
    expect(chats[0]!.tools!.map((t) => t.function.name)).toEqual(['calculate']);
    expect(chats[0]!.messages[0]!.content).toMatch(/Be exact\.[\s\S]*you cannot change, send or save anything from this channel/);
    const audit = await h.s.audit.list(h.tenantId, { action: 'channel.reply.tools' });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.detail).toMatchObject({ agent: 'Desk', runAs: svc.id, tools: [{ name: 'calculate', ok: true }] });
    expect(await h.s.db('usage_records').where({ kind: 'channel', workspace_id: wsId }).count({ n: '*' })).toEqual([{ n: 2 }]);

    // An account that gains an admin permission stops serving: the customer is told a person follows up.
    await h.s.db('user_roles').insert({ user_id: svc.id, role: 'knowledge-curator', source: 'manual', created_at: Date.now() });
    await cu.send('And 2 + 2?').expect(201);
    await h.s.jobs.runDue();
    const after = (await cu.view().expect(200)).body as { session: { state: string }; messages: { role: string }[] };
    expect(after.messages[after.messages.length - 1]!.role).toBe('notice');
    expect(after.session.state).toBe('escalated');

    // With the tools off the channel answers in the request again, from the agent's prompt alone, and lets go of the account.
    expect((await a.patch(`/api/channels/${ch.id}`, { agentTools: false }).expect(200)).body).toMatchObject({ agentTools: false, runAs: null });
    ollama.reply = () => ({ content: 'Plain answer.' });
    const second = (await pub().post('/api/public/channels/sessions').send({ channel: ch.publicKey }).expect(201)).body as { token: string };
    expect((await customer(second.token).send('Hello').expect(201)).body.reply).toMatchObject({ role: 'assistant', text: 'Plain answer.' });
  });
});
