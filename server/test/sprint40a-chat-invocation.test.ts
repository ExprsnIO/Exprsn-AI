/*
 * 1.7.0, Sprint 40a (B-4001 to B-4006, B-4009): agents, tools, skills and workflows called from a conversation.
 *
 *   B-4001 capabilities: a conversation lists the published agents, tools and skills the caller may use there; an
 *          entry above the conversation's ceiling is never listed, and calling it by name is refused the same way.
 *   B-4002 /tool: a person's call goes through the dispatcher and the tool-call guardrail; the call and its result
 *          join the conversation as a tool turn the model sees next; a held call waits for a reviewer in the queue.
 *   B-4003 write tools behind a card: a write tool runs only after its card is approved; a denied card leaves no
 *          side effect; a destructive tool a rule flags needs the reviewer too; expired cards are recorded.
 *   B-4004 @agent: a run bound to the conversation whose answer is a turn attributed to the agent, visible in Runs
 *          with a link back, and cancelled from the chat.
 *   B-4005 +skill: a skill's instructions ride into the system prompt; removed, they are out of the very next turn.
 *   B-4006 the model hands a turn to an agent on the profile's list; the chain's depth limit stops it starting
 *          itself again.
 *   B-4009 /workflow: a workflow started from chat pauses on an approval card in the conversation; approving it
 *          there resumes the chain and its outcome is a turn.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WfGraph } from '../src/workflows/graph.js';
import { FakeMcp } from './fake-mcp.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';
import { seedGateway } from './seed-gateway.js';

type Client = { agent: Awaited<ReturnType<typeof login>>['agent']; csrf: string; cookie: string };
const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);
const put = (c: Client, url: string, body: object = {}) => c.agent.put(url).set('x-csrf-token', c.csrf).send(body);
const del = (c: Client, url: string) => c.agent.delete(url).set('x-csrf-token', c.csrf);

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface Msg {
  id: string;
  parentId: string | null;
  role: string;
  content: string;
  state: string;
  turn: string | null;
  profile: string | null;
  invocationId: string | null;
  tools: { name: string; expression: string; output?: unknown; error?: string }[];
  label: string;
}

describe('Sprint 40a: agents, tools, skills and workflows in chat', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let mcp: FakeMcp;

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000', MCP_TIMEOUT_MS: '3000', CHAT_AGENT_WAIT_SECONDS: '5', AGENT_MAX_DEPTH: '2' });
    ollama = await new FakeOllama().start();
    ollama.chatDelayMs = 0;
    mcp = await new FakeMcp().start();
    mcp.tools = [
      { name: 'lookup_invoice', description: 'Looks up an invoice.', inputSchema: { type: 'object', properties: { number: { type: 'string' } }, required: ['number'] }, annotations: { readOnlyHint: true }, run: (a) => ({ invoice: a.number, total: 1188 }) },
      { name: 'create_issue', description: 'Creates an issue.', inputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] }, run: () => ({ key: 'FIN-1188' }) },
      { name: 'delete_branch', description: 'Deletes a branch.', inputSchema: { type: 'object', properties: { branch: { type: 'string' } } }, annotations: { destructiveHint: true }, run: () => ({ deleted: true }) }
    ];
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
    await mcp.stop();
  });

  async function setup(profile: Record<string, unknown> = {}) {
    await seedGateway(h, ollama, { tools: ['calculate', 'jira.lookup_invoice', 'jira.create_issue', 'jira.delete_branch'], ...profile });
    await localUser(h, 'tadmin', ['tool-admin', 'agent-admin'], 'confidential');
    await localUser(h, 'tadmin2', ['tool-admin', 'agent-admin'], 'confidential');
    await localUser(h, 'wadmin', ['workflow-admin', 'member'], 'confidential');
    await localUser(h, 'reviewer', ['flag-reviewer'], 'confidential');
    await localUser(h, 'mem', ['member'], 'confidential');
    const t = await loginAdmin(h, 'tadmin');
    const t2 = await loginAdmin(h, 'tadmin2');
    const w = await loginAdmin(h, 'wadmin');
    const reviewer = await login(h, 'reviewer');
    const m = await login(h, 'mem');
    const reg = (await post(t, '/api/admin/mcp-servers', { name: 'jira', url: mcp.url }).expect(201)).body;
    await post(t, `/api/admin/mcp-servers/${reg.id}/tools/lookup_invoice/approve`, { sideEffect: 'read', confirm: 'never', label: 'confidential' }).expect(200);
    await post(t, `/api/admin/mcp-servers/${reg.id}/tools/create_issue/approve`, { sideEffect: 'write', confirm: 'always', label: 'confidential' }).expect(200);
    await post(t, `/api/admin/mcp-servers/${reg.id}/tools/delete_branch/approve`, { sideEffect: 'destructive', confirm: 'always', label: 'confidential' }).expect(200);
    return { t, t2, w, reviewer, m };
  }
  type Ctx = Awaited<ReturnType<typeof setup>>;

  async function publishEntry(c: Ctx, body: Record<string, unknown>) {
    const e = (await post(c.t, '/api/admin/registry', body).expect(201)).body;
    await post(c.t, `/api/admin/registry/${e.id}/submit`).expect(200);
    await post(c.t2, `/api/admin/registry/${e.id}/review`, { decision: 'approve' }).expect(200);
    return e;
  }
  const agent = (name: string, systemPrompt: string, def: Record<string, unknown> = {}, label = 'confidential') => ({ kind: 'agent', name, version: '1.0.0', description: `${name}: works on the task it is given and reports the result plainly.`, label, definition: { profile: 'general', systemPrompt, tools: [], budgets: { steps: 8, tokens: 4000, wallSeconds: 60, toolCalls: 4 }, ...def } });
  const skill = (name: string, instructions: string, label = 'confidential') => ({ kind: 'skill', name, version: '1.0.0', description: `${name}: instructions the conversation's model follows while it is on.`, label, definition: { instructions, tools: [] } });

  /** Starts a conversation with one question and waits for the answer. */
  async function converse(m: Client, content: string, profile = 'general') {
    const r = (await post(m, '/api/chat', { content, profile }).expect(202)).body as { conversationId: string; messageId: string };
    await answered(m, r.conversationId, r.messageId);
    return r;
  }
  const view = async (m: Client, id: string) => (await m.agent.get(`/api/conversations/${id}`).expect(200)).body as { headId: string; messages: Msg[]; skills: { name: string; mode: string }[] };
  const answered = (m: Client, cid: string, mid: string) => until(async () => (await view(m, cid)).messages.find((x) => x.id === mid && !['queued', 'streaming'].includes(x.state)));
  const cards = async (m: Client, id: string) => (await m.agent.get(`/api/conversations/${id}/invocations`).expect(200)).body as Record<string, unknown>[];
  const lastSystem = () => ((ollama.requests.filter((r) => r.path === '/api/chat').at(-1)!.body.messages as { role: string; content: string }[]).find((x) => x.role === 'system')?.content ?? '');
  const lastMessages = () => ollama.requests.filter((r) => r.path === '/api/chat').at(-1)!.body.messages as { role: string; content: string; tool_calls?: unknown[] }[];
  async function drain(rounds = 12) {
    for (let i = 0; i < rounds; i++) if (!(await h.s.jobs.runDue())) break;
  }

  it('B-4001: lists what the conversation may call, hides entries above its ceiling, and refuses them by name', async () => {
    const c = await setup({ label: 'confidential' });
    await publishEntry(c, agent('Clerk', 'You are the clerk.'));
    await publishEntry(c, agent('Vault keeper', 'You keep the vault.', {}, 'internal'));
    await publishEntry(c, skill('Tone', 'Answer in one sentence.'));
    await publishEntry(c, skill('Low', 'A public skill.', 'internal'));
    const { conversationId } = await converse(c.m, 'Hello');
    // A confidential conversation: the internal-ceiling agent and skill are hidden, with the reason.
    await h.s.db('conversations').where({ id: conversationId }).update({ label: 'confidential' });
    const caps = (await c.m.agent.get(`/api/conversations/${conversationId}/capabilities`).expect(200)).body;
    expect(caps.label).toBe('confidential');
    expect(caps.tools.map((t: { name: string; sideEffect: string; confirm: string }) => [t.name, t.sideEffect, t.confirm])).toEqual([['calculate', 'read', 'never'], ['jira.lookup_invoice', 'read', 'never'], ['jira.create_issue', 'write', 'always'], ['jira.delete_branch', 'destructive', 'always']]);
    expect(caps.tools[1].inputSchema).toMatchObject({ properties: { number: { type: 'string' } } });
    expect(caps.agents.map((a: { name: string }) => a.name)).toEqual(['Clerk']);
    expect(caps.skills.map((s: { name: string }) => s.name)).toEqual(['Tone']);
    expect(caps.hidden).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'agent:Vault keeper' }), expect.objectContaining({ name: 'skill:Low' })]));
    // Calling the hidden ones by name is refused the same way.
    expect((await post(c.m, `/api/conversations/${conversationId}/agent-runs`, { agent: 'Vault keeper', input: 'Open up.' }).expect(403)).body.step).toBe('zone');
    expect((await put(c.m, `/api/conversations/${conversationId}/skills`, { name: 'Low' }).expect(403)).body.detail).toMatch(/ceiling is internal/);
    // A tool that is not on the profile's list cannot be called either.
    expect((await post(c.m, `/api/conversations/${conversationId}/tool-calls`, { name: 'jira.nothing', arguments: {} }).expect(403)).body.detail).toMatch(/not on profile/);
  });

  it('B-4002: a person calls a read tool; the call and its result become a tool turn the model sees next', async () => {
    const c = await setup();
    const { conversationId } = await converse(c.m, 'Hello');
    const out = (await post(c.m, `/api/conversations/${conversationId}/tool-calls`, { name: 'jira.lookup_invoice', arguments: { number: 'INV-7' } }).expect(202)).body;
    expect(out).toMatchObject({ kind: 'tool', name: 'jira.lookup_invoice', state: 'done', proposedBy: 'user', arguments: { number: 'INV-7' } });
    expect(mcp.calls).toEqual([expect.objectContaining({ name: 'lookup_invoice', arguments: { number: 'INV-7' } })]);
    const v = await view(c.m, conversationId);
    const turn = v.messages.find((x) => x.id === out.messageId)!;
    expect(turn).toMatchObject({ role: 'assistant', turn: 'tool', profile: 'jira.lookup_invoice', state: 'complete', invocationId: out.id });
    expect(turn.tools[0]).toMatchObject({ name: 'jira.lookup_invoice', output: { invoice: 'INV-7', total: 1188 } });
    expect(v.headId).toBe(turn.id);
    // The next question follows the turn, and the model sees the call and its result.
    const next = (await post(c.m, `/api/conversations/${conversationId}/messages`, { content: 'What was the total?', profile: 'general' }).expect(202)).body;
    await answered(c.m, conversationId, next.messageId);
    const roles = lastMessages().map((x) => x.role);
    expect(roles).toEqual(['user', 'assistant', 'assistant', 'tool', 'user']);
    expect(lastMessages()[2]!.tool_calls).toEqual([{ function: { name: 'jira.lookup_invoice', arguments: { number: 'INV-7' } } }]);
    expect(lastMessages()[3]!.content).toContain('1188');
    const audit = await h.s.db('audit_events').where({ action: 'chat.tool.called' });
    expect(audit).toHaveLength(1);
    // Sealed at rest.
    const raw = await h.s.db('chat_invocations').where({ id: out.id }).first();
    expect(raw.arguments).not.toContain('INV-7');
    expect(raw.state).toBe('done');
  });

  it('B-4002: free text becomes arguments through the profile\'s model', async () => {
    const c = await setup();
    const { conversationId } = await converse(c.m, 'Hello');
    ollama.reply = (messages, opts) => {
      if ((opts.tools as { function: { name: string } }[])?.some((t) => t.function.name === 'jira_lookup_invoice') && messages[0]!.content.startsWith('Call the tool')) return { content: '', toolCall: { name: 'jira_lookup_invoice', arguments: { number: 'INV-9' } } };
      return { content: `Fake answer to: ${messages.at(-1)!.content}` };
    };
    const out = (await post(c.m, `/api/conversations/${conversationId}/tool-calls`, { name: 'jira.lookup_invoice', text: 'look up invoice nine' }).expect(202)).body;
    expect(out).toMatchObject({ state: 'done', arguments: { number: 'INV-9' } });
  });

  it('B-4002: a call the guardrail holds shows as held, and runs only when a reviewer approves it in the flag queue', async () => {
    const c = await setup();
    const { conversationId } = await converse(c.m, 'Hello');
    h.s.guardrails = { check: async (i: { checkpoint: string; text: string }) => (i.checkpoint === 'tool-call' ? { action: 'require-approval', text: i.text, findings: [{ stage: 'enforce', action: 'require-approval', ruleId: 'r1', ruleName: 'Invoices need a look', setId: null, setName: null, span: null, detail: null }], reason: 'Held for review.' } : { action: 'allow', text: i.text, findings: [] }) } as unknown as typeof h.s.guardrails;
    const out = (await post(c.m, `/api/conversations/${conversationId}/tool-calls`, { name: 'jira.lookup_invoice', arguments: { number: 'INV-8' } }).expect(202)).body;
    expect(out).toMatchObject({ state: 'held', approval: 'reviewer' });
    expect(mcp.calls).toHaveLength(0);
    const flagsBody = (await c.reviewer.agent.get('/api/flags').expect(200)).body;
    const flags = (Array.isArray(flagsBody) ? flagsBody : flagsBody.flags ?? flagsBody.items) as { ref: string; kind: string; checkpoint: string }[];
    const flag = flags.find((f) => f.checkpoint === 'tool-call')!;
    expect(flag).toMatchObject({ kind: 'hold' });
    const fv = (await c.reviewer.agent.get(`/api/flags/${flag.ref}`).expect(200)).body;
    expect(fv.held).toMatchObject({ content: expect.stringContaining('INV-8') });
    await post(c.reviewer, `/api/flags/${flag.ref}/decide`, { decision: 'approved' }).expect(200);
    expect(mcp.calls).toEqual([expect.objectContaining({ name: 'lookup_invoice' })]);
    const [card] = await cards(c.m, conversationId);
    expect(card).toMatchObject({ state: 'done', decidedBy: expect.any(String) });
    const turn = (await view(c.m, conversationId)).messages.find((x) => x.turn === 'tool')!;
    expect(turn.tools[0]).toMatchObject({ output: { invoice: 'INV-8' } });
    // The audit names the hold and the reviewer's approval.
    const actions = (await h.s.db('audit_events').whereIn('action', ['chat.tool.held', 'chat.tool.approved', 'chat.tool.called']).orderBy('seq')).map((a: { action: string }) => a.action);
    expect(actions).toEqual(['chat.tool.held', 'chat.tool.approved', 'chat.tool.called']);
  });

  it('B-4003: a write tool runs only after its card is approved; a denied card leaves no side effect; a rule-flagged destructive tool needs the reviewer too', async () => {
    const c = await setup();
    const { conversationId } = await converse(c.m, 'Hello');
    // The person asks for a write tool: a card, nothing runs.
    const card = (await post(c.m, `/api/conversations/${conversationId}/tool-calls`, { name: 'jira.create_issue', arguments: { summary: 'Q3 variance review' } }).expect(202)).body;
    expect(card).toMatchObject({ state: 'awaiting', approval: 'owner', sideEffect: 'write' });
    expect(card.expiresAt).toBeGreaterThan(Date.now());
    expect(mcp.calls).toHaveLength(0);
    // Someone else cannot decide it.
    await localUser(h, 'other', ['member'], 'confidential');
    const other = await login(h, 'other');
    await post(other, `/api/conversations/${conversationId}/invocations/${card.id}/decide`, { decision: 'approve' }).expect(404);
    // Denied: no side effect, recorded as a turn and in the audit.
    const denied = (await post(c.m, `/api/conversations/${conversationId}/invocations/${card.id}/decide`, { decision: 'deny' }).expect(200)).body;
    expect(denied).toMatchObject({ state: 'denied' });
    expect(mcp.calls).toHaveLength(0);
    expect((await view(c.m, conversationId)).messages.find((x) => x.invocationId === card.id)!.tools[0]!.error).toMatch(/denied/);
    await post(c.m, `/api/conversations/${conversationId}/invocations/${card.id}/decide`, { decision: 'approve' }).expect(409);
    // Approved: it runs, once.
    const card2 = (await post(c.m, `/api/conversations/${conversationId}/tool-calls`, { name: 'jira.create_issue', arguments: { summary: 'Q3 variance review' } }).expect(202)).body;
    const ok = (await post(c.m, `/api/conversations/${conversationId}/invocations/${card2.id}/decide`, { decision: 'approve' }).expect(200)).body;
    expect(ok).toMatchObject({ state: 'done' });
    expect(mcp.calls).toEqual([expect.objectContaining({ name: 'create_issue', arguments: { summary: 'Q3 variance review' } })]);
    // The model proposes a write call mid-answer: the card waits for the owner; the model is told and finishes.
    ollama.reply = (messages) => {
      const last = messages.at(-1)!;
      if (last.role === 'tool') return { content: `Noted: ${last.content.slice(0, 80)}` };
      if (/file an issue/i.test(last.content)) return { content: '', toolCall: { name: 'jira_create_issue', arguments: { summary: 'From the model' } } };
      return { content: `Fake answer to: ${last.content}` };
    };
    const q = (await post(c.m, `/api/conversations/${conversationId}/messages`, { content: 'Please file an issue about this.', profile: 'general' }).expect(202)).body;
    const answer = await answered(c.m, conversationId, q.messageId);
    expect(answer.state).toBe('complete');
    expect(answer.content).toMatch(/needs the person's approval/);
    const proposed = (await cards(c.m, conversationId)).find((x) => x.proposedBy === 'model')!;
    expect(proposed).toMatchObject({ state: 'awaiting', approval: 'owner', name: 'jira.create_issue', answerId: q.messageId });
    expect(mcp.calls).toHaveLength(1);
    await post(c.m, `/api/conversations/${conversationId}/invocations/${proposed.id}/decide`, { decision: 'approve' }).expect(200);
    expect(mcp.calls).toHaveLength(2);
    expect(mcp.calls[1]).toMatchObject({ arguments: { summary: 'From the model' } });
    // A destructive, always-confirm tool the guardrail also flags: the owner first, then the reviewer.
    h.s.guardrails = { check: async (i: { checkpoint: string; text: string }) => (i.checkpoint === 'tool-call' && i.text.includes('delete_branch') ? { action: 'require-approval', text: i.text, findings: [{ stage: 'enforce', action: 'require-approval', ruleId: 'r2', ruleName: 'Deletions are reviewed', setId: null, setName: null, span: null, detail: null }], reason: 'Deletions are reviewed.' } : { action: 'allow', text: i.text, findings: [] }) } as unknown as typeof h.s.guardrails;
    const card3 = (await post(c.m, `/api/conversations/${conversationId}/tool-calls`, { name: 'jira.delete_branch', arguments: { branch: 'old' } }).expect(202)).body;
    expect(card3).toMatchObject({ state: 'awaiting', approval: 'owner+reviewer' });
    const held = (await post(c.m, `/api/conversations/${conversationId}/invocations/${card3.id}/decide`, { decision: 'approve' }).expect(200)).body;
    expect(held).toMatchObject({ state: 'held' });
    expect(mcp.calls).toHaveLength(2);
    const fb = (await c.reviewer.agent.get('/api/flags').expect(200)).body;
    const flag = ((Array.isArray(fb) ? fb : fb.flags ?? fb.items) as { ref: string; checkpoint: string; state: string }[]).find((f) => f.checkpoint === 'tool-call' && f.state === 'open')!;
    await post(c.reviewer, `/api/flags/${flag.ref}/decide`, { decision: 'approved' }).expect(200);
    expect(mcp.calls).toHaveLength(3);
    expect(mcp.calls[2]).toMatchObject({ name: 'delete_branch' });
    // Expired cards are recorded.
    const card4 = (await post(c.m, `/api/conversations/${conversationId}/tool-calls`, { name: 'jira.create_issue', arguments: { summary: 'Late' } }).expect(202)).body;
    await h.s.db('chat_invocations').where({ id: card4.id }).update({ expires_at: Date.now() - 1 });
    expect(await h.s.chatInvocations.expireCards(h.tenantId)).toBe(1);
    expect((await post(c.m, `/api/conversations/${conversationId}/invocations/${card4.id}/decide`, { decision: 'approve' }).expect(409)).body.detail).toMatch(/expired/);
    expect((await cards(c.m, conversationId)).find((x) => x.id === card4.id)).toMatchObject({ state: 'expired' });
    expect(await h.s.db('audit_events').where({ action: 'chat.tool.expired' })).toHaveLength(1);
    expect(mcp.calls).toHaveLength(3);
  });

  it('B-4004: @agent starts a run bound to the conversation; its answer is a turn attributed to the agent; Runs links back; cancel stops it', async () => {
    const c = await setup();
    await publishEntry(c, agent('Clerk', 'You are the clerk.'));
    ollama.reply = (messages) => {
      const system = messages[0]!.role === 'system' ? messages[0]!.content : '';
      if (system.includes('clerk')) return { content: `Clerk answer about: ${messages.at(-1)!.content.split('\n')[0]}` };
      return { content: `Fake answer to: ${messages.at(-1)!.content}` };
    };
    const { conversationId } = await converse(c.m, 'The invoice INV-7 is late.');
    const started = (await post(c.m, `/api/conversations/${conversationId}/agent-runs`, { agent: 'Clerk', input: 'Chase it.', includeTurns: true }).expect(202)).body;
    expect(started).toMatchObject({ kind: 'agent', name: 'Clerk', state: 'running', run: { kind: 'agent-run' } });
    const v = await view(c.m, conversationId);
    const placeholder = v.messages.find((x) => x.id === started.messageId)!;
    expect(placeholder).toMatchObject({ role: 'assistant', turn: 'agent', profile: 'Clerk', state: 'queued' });
    expect(v.messages.find((x) => x.id === started.userMessageId)).toMatchObject({ role: 'user', content: '@Clerk: Chase it.' });
    await drain();
    const done = await answered(c.m, conversationId, started.messageId);
    expect(done).toMatchObject({ state: 'complete', content: 'Clerk answer about: Chase it.', turn: 'agent', profile: 'Clerk' });
    // The run got the message and the recent turns within its label.
    const runRow = await h.s.db('agent_runs').where({ id: started.runId }).first();
    expect(runRow).toMatchObject({ state: 'succeeded', caller_kind: 'chat-turn', caller_id: started.messageId });
    const input = JSON.parse(await h.s.keys.open(h.tenantId, runRow.input, `agent-run-input:${started.runId}`)) as string;
    expect(input).toContain('Recent turns of the conversation');
    expect(input).toContain('INV-7 is late');
    // Runs shows it with a link back to the conversation.
    const rv = (await c.m.agent.get(`/api/runs/${started.runId}`).expect(200)).body;
    expect(rv.caller).toMatchObject({ kind: 'chat-turn', id: started.messageId });
    expect((await cards(c.m, conversationId))[0]).toMatchObject({ state: 'done', run: { id: started.runId } });
    // The next question follows the agent's turn, attributed in what the model sees.
    const q = (await post(c.m, `/api/conversations/${conversationId}/messages`, { content: 'Thanks.', profile: 'general' }).expect(202)).body;
    await answered(c.m, conversationId, q.messageId);
    expect(lastMessages().map((x) => x.content)).toEqual(expect.arrayContaining([expect.stringContaining('[Answer by agent Clerk]')]));
    // Cancelling from the chat stops a run that has not finished.
    ollama.hold = new Promise(() => undefined);
    const second = (await post(c.m, `/api/conversations/${conversationId}/agent-runs`, { agent: 'Clerk', input: 'Again.' }).expect(202)).body;
    void h.s.jobs.runDue();
    await until(async () => (await h.s.db('agent_runs').where({ id: second.runId }).first()).state === 'running');
    const cancelled = (await post(c.m, `/api/conversations/${conversationId}/invocations/${second.id}/cancel`).expect(200)).body;
    expect(cancelled.state).toBe('cancelled');
    const stopped = await answered(c.m, conversationId, second.messageId);
    expect(stopped).toMatchObject({ state: 'stopped', turn: 'agent' });
    expect((await h.s.db('agent_runs').where({ id: second.runId }).first()).state).toBe('cancelled');
  });

  it('B-4005: a skill\'s instructions ride in the system prompt; removed, they are out of the very next turn; once-skills last one turn; the profile can restrict them', async () => {
    const c = await setup();
    await publishEntry(c, skill('Tone', 'ALWAYS answer in one sentence.'));
    await publishEntry(c, skill('Brief', 'Be brief.'));
    const { conversationId } = await converse(c.m, 'Hello');
    expect(lastSystem()).not.toContain('one sentence');
    const added = (await put(c.m, `/api/conversations/${conversationId}/skills`, { name: 'Tone' }).expect(200)).body;
    expect(added.skills).toEqual([{ name: 'Tone', mode: 'sticky' }]);
    await put(c.m, `/api/conversations/${conversationId}/skills`, { name: 'Brief', mode: 'once' }).expect(200);
    let q = (await post(c.m, `/api/conversations/${conversationId}/messages`, { content: 'One', profile: 'general' }).expect(202)).body;
    await answered(c.m, conversationId, q.messageId);
    expect(lastSystem()).toContain('Skill Tone 1.0.0:\nALWAYS answer in one sentence.');
    expect(lastSystem()).toContain('Be brief.');
    expect((await view(c.m, conversationId)).skills).toEqual([{ name: 'Tone', mode: 'sticky' }]); // the once-skill came off
    q = (await post(c.m, `/api/conversations/${conversationId}/messages`, { content: 'Two', profile: 'general' }).expect(202)).body;
    await answered(c.m, conversationId, q.messageId);
    expect(lastSystem()).toContain('one sentence');
    expect(lastSystem()).not.toContain('Be brief.');
    await del(c.m, `/api/conversations/${conversationId}/skills/Tone`).expect(200);
    q = (await post(c.m, `/api/conversations/${conversationId}/messages`, { content: 'Three', profile: 'general' }).expect(202)).body;
    await answered(c.m, conversationId, q.messageId);
    expect(lastSystem()).not.toContain('one sentence');
    expect((await c.m.agent.get(`/api/conversations/${conversationId}/capabilities`).expect(200)).body.skills.map((s: { name: string; active: string | null }) => [s.name, s.active])).toEqual([['Brief', null], ['Tone', null]]);
    // The profile's allow-list restricts what a conversation may add.
    await h.s.gateway.repo.updateProfile(h.tenantId, 'GENERAL0000000000000000000', { skills: ['Brief'] });
    expect((await put(c.m, `/api/conversations/${conversationId}/skills`, { name: 'Tone' }).expect(403)).body.detail).toMatch(/allows only these skills: Brief/);
    expect((await c.m.agent.get(`/api/conversations/${conversationId}/capabilities`).expect(200)).body.skills.map((s: { name: string }) => s.name)).toEqual(['Brief']);
  });

  it('B-4006: the model hands a turn to an agent on the profile\'s list; the chain\'s depth limit stops agents starting agents past it', async () => {
    const c = await setup({ agents: ['Clerk'] });
    // Clerk delegates to Scribe, Scribe to Runner: with the agent depth cap at 2, Runner may not start under the chat turn.
    await publishEntry(c, agent('Runner', 'You are the runner.'));
    await publishEntry(c, agent('Scribe', 'You are the scribe.', { agents: ['Runner'] }));
    await publishEntry(c, agent('Clerk', 'You are the clerk.', { agents: ['Scribe'] }));
    ollama.reply = (messages, opts) => {
      const last = messages.at(-1)!;
      const offered = (opts.tools as { function: { name: string } }[] | undefined)?.map((t) => t.function.name) ?? [];
      if (last.role === 'tool') return { content: `Got: ${last.content.slice(0, 160)}` };
      const next = offered.find((n) => n.startsWith('agent_'));
      if (next) return { content: '', toolCall: { name: next, arguments: { task: 'Pass it on.' } } };
      return { content: `Fake answer to: ${last.content}` };
    };
    const r = (await post(c.m, '/api/chat', { content: 'Please hand this to the clerk.', profile: 'general' }).expect(202)).body as { conversationId: string; messageId: string };
    // The chat turn waits for the run; the runs need the job queue meanwhile.
    const pump = (async () => {
      for (let i = 0; i < 80; i++) {
        await h.s.jobs.runDue();
        await new Promise((x) => setTimeout(x, 40));
      }
    })();
    const answer = await answered(c.m, r.conversationId, r.messageId);
    await pump;
    expect(answer.state).toBe('complete');
    expect(answer.content).toMatch(/^Got: /);
    const runs = (await h.s.db('agent_runs').orderBy('created_at')) as { agent_name: string; state: string; caller_kind: string; chain_id: string }[];
    expect(runs.map((x) => [x.agent_name, x.state, x.caller_kind])).toEqual([['Clerk', 'succeeded', 'chat-turn'], ['Scribe', 'succeeded', 'agent-run']]);
    // Scribe's delegation to Runner was refused by the chain's agent depth cap: a refused node under its call.
    const nodes = (await h.s.db('chain_nodes').orderBy('depth')) as { kind: string; callee: string | null; state: string; error: string | null }[];
    const refused = nodes.filter((n) => n.callee === 'Runner@1.0.0');
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.some((n) => /chain_limit|depth/i.test(n.error ?? ''))).toBe(true);
    expect(new Set(runs.map((x) => x.chain_id)).size).toBe(1);
    const node = await h.s.db('chain_nodes').where({ kind: 'chat-turn' }).first();
    expect(node).toMatchObject({ ref: r.messageId });
  });

  it('B-4009: a workflow started from chat pauses on an approval card in the conversation; approving it there resumes the chain and its outcome is a turn', async () => {
    const c = await setup();
    const TOPIC = { type: 'object' as const, properties: { topic: { type: 'string' as const } }, required: ['topic'] };
    const g: WfGraph = {
      nodes: [
        { id: 'trigger', kind: 'trigger', title: 'Trigger', x: 20, y: 24, config: { source: 'api' }, output: TOPIC },
        { id: 'ok', kind: 'approval', title: 'Sign-off', x: 230, y: 24, config: { role: 'workflow-admin', timeoutMs: 3_600_000, show: 'Notes on {{input.topic}}' } },
        { id: 'shape', kind: 'transform', title: 'Shape', x: 440, y: 24, config: { fields: { summary: 'Approved notes on {{input.topic}}' } } }
      ],
      edges: [{ from: 'trigger', to: 'ok' }, { from: 'ok', to: 'shape' }],
      limits: {}
    };
    const w = (await post(c.w, '/api/workflows', { name: 'signed-notes', label: 'internal' }).expect(201)).body;
    await put(c.w, `/api/workflows/${w.id}/draft`, { graph: g }).expect(200);
    await post(c.w, `/api/workflows/${w.id}/publish`).expect(200);
    const { conversationId } = await converse(c.w, 'Hello');
    expect((await c.w.agent.get(`/api/conversations/${conversationId}/capabilities`).expect(200)).body.workflows).toEqual([expect.objectContaining({ name: 'signed-notes', inputSchema: expect.objectContaining({ required: ['topic'] }) })]);
    const started = (await post(c.w, `/api/conversations/${conversationId}/workflow-runs`, { workflow: 'signed-notes', input: { topic: 'Q3' } }).expect(202)).body;
    expect(started).toMatchObject({ kind: 'workflow', name: 'signed-notes', state: 'running' });
    await drain();
    // The run waits on its approval; the card shows it.
    const card = (await cards(c.w, conversationId))[0]!;
    expect(card).toMatchObject({ state: 'running', runState: 'waiting' });
    expect(card.approvals).toEqual([expect.objectContaining({ runId: started.runId, step: 'Sign-off' })]);
    await post(c.w, `/api/workflow-approvals/${(card.approvals as { id: string }[])[0]!.id}`, { decision: 'approve' }).expect(200);
    await drain();
    const turn = await answered(c.w, conversationId, started.messageId);
    expect(turn).toMatchObject({ state: 'complete', turn: 'workflow', profile: 'signed-notes' });
    expect(turn.content).toContain('Approved notes on Q3');
    expect((await cards(c.w, conversationId))[0]).toMatchObject({ state: 'done' });
    expect((await h.s.db('workflow_runs').where({ id: started.runId }).first()).caller_kind).toBe('chat-turn');
  });
});
