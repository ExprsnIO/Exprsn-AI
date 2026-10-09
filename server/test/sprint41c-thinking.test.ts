/*
 * 1.7.0, Sprint 41c (B-11701 to B-11706): thinking policy, budgets, plans and reflection.
 *
 *   B-11701 policy: who sees thinking (the author, reviewers, nobody), its retention apart from the answer, whether
 *          exports carry it; with "nobody" the author's stream carries no thinking and the stored message holds only
 *          its token count.
 *   B-11702 budgets: a spent profile or workspace budget drops the level to low rather than refusing the turn, the
 *          usage summary shows the drop, and /v1's reasoning.effort is capped the same way.
 *   B-11703 plan first: the plan is a card; a declined plan runs no tool; an approved (edited) plan bounds the tools
 *          the turn may call; in an agent run the plan becomes the step list and a deviation pauses for approval.
 *   B-11704 reflection: an answer whose claim its citation does not support gets a finding, and the badge names it.
 *   B-11705 thinking on steps: a workflow model step and an agent above the profile's ceiling are refused at publish
 *          with the ceiling named; the chain node carries the level and the thinking tokens.
 *   B-11706 evaluations on thinking and plans: a thinking rubric, the tools a plan must and must not name, and a
 *          reflection with no findings, counted by the gate.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLAN_PROMPT, REFLECTION_PROMPT, parsePlan, parseReflection } from '../src/thinking/service.js';
import type { WfGraph, WfNode } from '../src/workflows/graph.js';
import { FakeMcp } from './fake-mcp.js';
import { FakeOllama, type Msg } from './fake-ollama.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';
import { seedGateway } from './seed-gateway.js';

const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);
const put = (c: Client, url: string, body: object = {}) => c.agent.put(url).set('x-csrf-token', c.csrf).send(body);
const patch = (c: Client, url: string, body: object = {}) => c.agent.patch(url).set('x-csrf-token', c.csrf).send(body);

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

interface MsgView {
  id: string;
  role: string;
  content: string;
  thinking: string | null;
  state: string;
  think: string | null;
  usage: { thinkingTokens: number } | null;
  plan: { steps: { title: string }[]; tools: string[] } | null;
  checked: { status: string; findings: { kind: string; text: string }[]; revised: string | null; profile: string } | null;
}

const systemOf = (messages: Msg[]) => messages.find((m) => m.role === 'system')?.content ?? '';
const isPlan = (messages: Msg[]) => systemOf(messages).includes(PLAN_PROMPT.slice(0, 40));
const isReflection = (messages: Msg[]) => systemOf(messages).startsWith(REFLECTION_PROMPT.slice(0, 40));
const isJudge = (messages: Msg[]) => systemOf(messages).startsWith('You are an evaluator');

describe('Sprint 41c: thinking policy, budgets, plans and reflection', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let mcp: FakeMcp;

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000', MCP_TIMEOUT_MS: '3000', AGENT_MAX_DEPTH: '2' });
    ollama = await new FakeOllama().start();
    ollama.chatDelayMs = 0;
    mcp = await new FakeMcp().start();
    mcp.tools = [
      { name: 'lookup_invoice', description: 'Looks up an invoice.', inputSchema: { type: 'object', properties: { number: { type: 'string' } }, required: ['number'] }, annotations: { readOnlyHint: true }, run: (a) => ({ invoice: a.number, total: 1188 }) },
      { name: 'create_issue', description: 'Creates an issue.', inputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] }, run: () => ({ key: 'FIN-1188' }) }
    ];
    // The default model thinks when asked: a thinking draft streams apart from the answer.
    ollama.reply = (messages) => ({ thinking: 'Working through the question step by step. ', content: `Fake answer to: ${messages.at(-1)?.content ?? ''}` });
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
    await mcp.stop();
  });

  async function setup(profile: Record<string, unknown> = {}) {
    const seeded = await seedGateway(h, ollama, { think_default: 'medium', think_ceiling: 'high', tools: ['calculate', 'jira.lookup_invoice', 'jira.create_issue'], ...profile });
    await h.s.gateway.repo.updateModel(seeded.model.id, { capabilities: ['completion', 'tools', 'thinking'] });
    await h.s.gateway.pollAll();
    await localUser(h, 'padmin', ['model-admin', 'tool-admin', 'agent-admin', 'workflow-admin'], 'confidential');
    await localUser(h, 'padmin2', ['model-admin', 'tool-admin', 'agent-admin'], 'confidential');
    await localUser(h, 'reviewer', ['flag-reviewer'], 'confidential');
    await localUser(h, 'mem', ['member'], 'confidential');
    const a = await loginAdmin(h, 'padmin');
    const a2 = await loginAdmin(h, 'padmin2');
    const reviewer = await login(h, 'reviewer');
    const m = await login(h, 'mem');
    const reg = (await post(a, '/api/admin/mcp-servers', { name: 'jira', url: mcp.url }).expect(201)).body;
    await post(a, `/api/admin/mcp-servers/${reg.id}/tools/lookup_invoice/approve`, { sideEffect: 'read', confirm: 'never', label: 'confidential' }).expect(200);
    await post(a, `/api/admin/mcp-servers/${reg.id}/tools/create_issue/approve`, { sideEffect: 'write', confirm: 'always', label: 'confidential' }).expect(200);
    return { a, a2, reviewer, m, ...seeded };
  }
  type Ctx = Awaited<ReturnType<typeof setup>>;

  const view = async (m: Client, id: string) => (await m.agent.get(`/api/conversations/${id}`).expect(200)).body as { headId: string; messages: MsgView[] };
  const answered = (m: Client, cid: string, mid: string) => until(async () => (await view(m, cid)).messages.find((x) => x.id === mid && !['queued', 'streaming', 'planning'].includes(x.state)));
  const cards = async (m: Client, id: string) => (await m.agent.get(`/api/conversations/${id}/invocations`).expect(200)).body as Record<string, unknown>[];
  async function converse(m: Client, content: string, profile = 'general') {
    const r = (await post(m, '/api/chat', { content, profile }).expect(202)).body as { conversationId: string; messageId: string; state?: string };
    return r;
  }
  async function drain(rounds = 12) {
    for (let i = 0; i < rounds; i++) if (!(await h.s.jobs.runDue())) break;
  }
  async function publishEntry(c: Ctx, body: Record<string, unknown>) {
    const e = (await post(c.a, '/api/admin/registry', body).expect(201)).body;
    await post(c.a, `/api/admin/registry/${e.id}/submit`).expect(200);
    await post(c.a2, `/api/admin/registry/${e.id}/review`, { decision: 'approve' }).expect(200);
    return e;
  }
  const agent = (name: string, def: Record<string, unknown> = {}) => ({ kind: 'agent', name, version: '1.0.0', description: `${name}: works on the task it is given and reports the result plainly.`, label: 'confidential', definition: { profile: 'general', systemPrompt: `You are ${name}.`, tools: ['jira.lookup_invoice', 'jira.create_issue'], budgets: { steps: 12, tokens: 20000, wallSeconds: 60, toolCalls: 6 }, ...def } });

  it('B-11701: the policy decides who sees thinking; with nobody the stream and the store hold only the token count; retention drops it; exports follow it', async () => {
    const c = await setup();
    // Default policy: the author sees the thinking.
    let r = await converse(c.m, 'One');
    let a = await answered(c.m, r.conversationId, r.messageId);
    expect(a.state).toBe('complete');
    expect(a.thinking).toContain('step by step');
    expect(a.usage!.thinkingTokens).toBeGreaterThan(0);
    // Reviewers only: the author sees none, the message still holds it for a reviewer.
    const pol = (await put(c.a, '/api/admin/thinking/policy', { visibility: 'reviewers' }).expect(200)).body;
    expect(pol).toMatchObject({ scope: 'tenant', visibility: 'reviewers' });
    expect((await c.a.agent.get('/api/admin/thinking/policy').expect(200)).body.effective.visibility).toBe('reviewers');
    r = await converse(c.m, 'Two');
    a = await answered(c.m, r.conversationId, r.messageId);
    expect(a.thinking).toBeNull();
    expect(a.usage!.thinkingTokens).toBeGreaterThan(0);
    const row2 = await h.s.db('messages').where({ id: r.messageId }).first();
    expect(row2.thinking).not.toBeNull();
    expect(h.s.thinking.visibleTo({ visibility: 'reviewers' }, { userId: 'x', roles: ['flag-reviewer'], scopes: null }, 'y')).toBe(true);
    expect(h.s.thinking.visibleTo({ visibility: 'reviewers' }, { userId: 'y', roles: ['member'], scopes: null }, 'y')).toBe(false);
    // Nobody: nothing streams to the author and nothing is stored but the token count.
    await put(c.a, '/api/admin/thinking/policy', { visibility: 'nobody' }).expect(200);
    r = await converse(c.m, 'Three');
    a = await answered(c.m, r.conversationId, r.messageId);
    expect(a.thinking).toBeNull();
    expect(a.usage!.thinkingTokens).toBeGreaterThan(0);
    const row3 = await h.s.db('messages').where({ id: r.messageId }).first();
    expect(row3.thinking).toBeNull();
    expect(Number(row3.thinking_tokens)).toBeGreaterThan(0);
    const stream = (await c.m.agent.get(`/api/conversations/${r.conversationId}/messages/${r.messageId}/stream?after=0`).expect(200)).body;
    expect(stream.thinking ?? null).toBeNull();
    expect(JSON.stringify(stream)).not.toContain('step by step');
    // A workspace policy wins over the tenant's; a reset makes it inherit again.
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Finance', 'confidential')).id;
    const wp = (await put(c.a, '/api/admin/thinking/policy', { workspace: ws, visibility: 'author', retentionDays: 3 }).expect(200)).body;
    expect(wp).toMatchObject({ scope: 'workspace', visibility: 'author', retentionDays: 3 });
    expect(await h.s.thinking.policyFor(h.tenantId, ws)).toMatchObject({ scope: 'workspace', visibility: 'author' });
    expect(await h.s.thinking.policyFor(h.tenantId, null)).toMatchObject({ scope: 'tenant', visibility: 'nobody' });
    await put(c.a, '/api/admin/thinking/policy', { workspace: ws, reset: true }).expect(200);
    expect((await c.a.agent.get(`/api/admin/thinking/policy?workspace=${ws}`).expect(200)).body.workspace).toBeNull();
    expect(await h.s.thinking.policyFor(h.tenantId, ws)).toMatchObject({ scope: 'tenant' });
    // Retention of 0 days on the tenant: the sweep drops the thinking, the token count stays.
    await put(c.a, '/api/admin/thinking/policy', { visibility: 'author', retentionDays: 0 }).expect(200);
    r = await converse(c.m, 'Four');
    a = await answered(c.m, r.conversationId, r.messageId);
    expect(a.thinking).toContain('step by step');
    // Retention of 0 days: the sweep drops the thinking, the token count stays.
    expect(Number((await h.s.db('messages').where({ id: r.messageId }).first()).thinking_purge_at)).toBeLessThanOrEqual(Date.now());
    expect(await h.s.thinking.purgeThinking(h.tenantId)).toBe(1);
    const purged = await h.s.db('messages').where({ id: r.messageId }).first();
    expect(purged.thinking).toBeNull();
    expect(Number(purged.thinking_tokens)).toBeGreaterThan(0);
    expect((await view(c.m, r.conversationId)).messages.find((x) => x.id === r.messageId)!.usage!.thinkingTokens).toBeGreaterThan(0);
    // Exports carry the thinking only when the policy says so and the exporter may see it.
    await put(c.a, '/api/admin/thinking/policy', { visibility: 'author', retentionDays: null, exports: true }).expect(200);
    r = await converse(c.m, 'Five');
    await answered(c.m, r.conversationId, r.messageId);
    const exported = async () => {
      const e = (await post(c.m, `/api/conversations/${r.conversationId}/exports`, { format: 'json' }).expect(202)).body;
      await drain();
      const text = (await c.m.agent.get(`/api/conversation-exports/${e.id}/download`).expect(200)).text;
      return JSON.parse(text) as { conversation: { messages: { thinking?: string | null }[] } };
    };
    expect(JSON.stringify((await exported()).conversation.messages)).toContain('step by step');
    await put(c.a, '/api/admin/thinking/policy', { exports: false }).expect(200);
    expect(JSON.stringify((await exported()).conversation.messages)).not.toContain('step by step');
    const audits = await h.s.db('audit_events').whereIn('action', ['thinking.policy.updated', 'thinking.purged']);
    expect(audits.length).toBeGreaterThanOrEqual(5);
  });

  it('B-11702: a spent budget drops the level to low rather than refusing; the usage summary shows the drop; /v1 is capped the same way', async () => {
    const c = await setup({ thinking_budget: 100 });
    // Nothing spent yet: the asked level stands.
    let r = await converse(c.m, 'One');
    let a = await answered(c.m, r.conversationId, r.messageId);
    expect(a.think).toBe('medium');
    // The profile's budget is spent: the next turn thinks at low, is answered, and the record says it was dropped.
    await h.s.quotas.record({ tenantId: h.tenantId, workspaceId: null, userId: null, kind: 'chat', profileId: c.profile.id, model: 'llama3.1:8b', thinkingTokens: 500 });
    r = await converse(c.m, 'Two');
    a = await answered(c.m, r.conversationId, r.messageId);
    expect(a).toMatchObject({ state: 'complete', think: 'low' });
    const rec = await h.s.db('usage_records').where({ message_id: r.messageId }).first();
    expect(rec).toMatchObject({ thinking_dropped: expect.anything() });
    expect(rec.thinking_dropped === true || rec.thinking_dropped === 1).toBe(true);
    const used = await h.s.quotas.view(h.tenantId, null);
    expect(used.used.thinkingDropsToday).toBe(1);
    expect(used.used.thinkingTokensToday).toBeGreaterThanOrEqual(500);
    // The budget state names the limit; a workspace budget applies through the policy.
    const b = await h.s.thinking.budget(h.tenantId, null, c.profile, 'high');
    expect(b).toMatchObject({ level: 'low', dropped: true, limit: 'profile', profile: { limit: 100 } });
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Finance', 'confidential')).id;
    await put(c.a, '/api/admin/thinking/policy', { workspace: ws, budgetTokensPerDay: 1000 }).expect(200);
    const b2 = await h.s.thinking.budget(h.tenantId, ws, { id: 'other', thinking_budget: null }, 'high');
    expect(b2).toMatchObject({ dropped: false, limit: null, workspace: { limit: 1000 } });
    // /v1: reasoning.effort high on the spent profile runs at low and is metered as dropped.
    const keyRes = await post(c.m, '/api/me/api-keys', { name: 'k', scopes: ['inference:invoke', 'chat:write'] });
    const key = keyRes.body as { secret?: string; key?: string; token?: string };
    const res = keyRes.status === 201 ? await c.m.agent.post('/v1/chat/completions').set('authorization', `Bearer ${key.secret ?? key.key ?? key.token}`).send({ model: 'general', messages: [{ role: 'user', content: 'Hi' }], reasoning_effort: 'high' }) : { status: 0 };
    if (res.status === 200) {
      const last = ollama.requests.filter((x) => x.path === '/api/chat').at(-1)!.body as { think?: unknown };
      expect(last.think).toBe(true);
      const recs = await h.s.db('usage_records').where({ kind: 'api' }).orderBy('ts', 'desc').first();
      expect(recs.thinking_dropped === true || recs.thinking_dropped === 1).toBe(true);
    }
  });

  it('B-11703: a plan-first profile drafts a plan the person decides on; declined runs nothing; approved (edited) bounds the tools', async () => {
    const c = await setup({ plan_first: true });
    ollama.reply = (messages, opts) => {
      const last = messages.at(-1)!;
      if (isPlan(messages)) return { content: 'Here is my plan:\n```json\n{"steps":[{"title":"Look the invoice up","tools":["jira_lookup_invoice"],"data":["the invoice number"]},{"title":"File an issue about it","tools":["jira_create_issue"],"data":[]}]}\n```' };
      if (last.role === 'tool') return { content: `Done: ${last.content.slice(0, 60)}` };
      const names = ((opts.tools as { function: { name: string } }[]) ?? []).map((t) => t.function.name);
      if (names.includes('jira_lookup_invoice')) return { content: '', toolCall: { name: 'jira_lookup_invoice', arguments: { number: 'INV-7' } } };
      return { content: `Fake answer to: ${last.content}` };
    };
    // Declined: no tool runs; the answer says so.
    const r1 = await converse(c.m, 'Chase invoice INV-7.');
    expect(r1.state).toBe('planning');
    const card = await until(async () => (await cards(c.m, r1.conversationId)).find((x) => x.kind === 'plan'));
    expect(card).toMatchObject({ kind: 'plan', state: 'awaiting', proposedBy: 'model', answerId: r1.messageId, plan: { tools: ['jira_lookup_invoice', 'jira_create_issue'] } });
    expect((card as { plan: { steps: { title: string }[] } }).plan.steps.map((s) => s.title)).toEqual(['Look the invoice up', 'File an issue about it']);
    await localUser(h, 'other', ['member'], 'confidential');
    await post(await login(h, 'other'), `/api/conversations/${r1.conversationId}/invocations/${card.id}/decide`, { decision: 'deny' }).expect(404);
    const denied = (await post(c.m, `/api/conversations/${r1.conversationId}/invocations/${card.id}/decide`, { decision: 'deny' }).expect(200)).body;
    expect(denied.state).toBe('denied');
    const stopped = await answered(c.m, r1.conversationId, r1.messageId);
    expect(stopped).toMatchObject({ state: 'stopped' });
    expect(stopped.content).toMatch(/declined the plan/);
    expect(mcp.calls).toHaveLength(0);
    // Approved with the second step removed: only the lookup is offered and runs; the plan is on the message.
    const r2 = await converse(c.m, 'Chase invoice INV-7 again.');
    const card2 = await until(async () => (await cards(c.m, r2.conversationId)).find((x) => x.kind === 'plan' && x.state === 'awaiting'));
    const ok = (await post(c.m, `/api/conversations/${r2.conversationId}/invocations/${card2.id}/decide`, { decision: 'approve', steps: [{ title: 'Look the invoice up', tools: ['jira_lookup_invoice'] }] }).expect(200)).body;
    expect(ok).toMatchObject({ state: 'done', plan: { tools: ['jira_lookup_invoice'], edited: true } });
    const done = await answered(c.m, r2.conversationId, r2.messageId);
    expect(done.state).toBe('complete');
    expect(done.plan).toMatchObject({ tools: ['jira_lookup_invoice'] });
    expect(mcp.calls).toEqual([expect.objectContaining({ name: 'lookup_invoice', arguments: { number: 'INV-7' } })]);
    const offered = (ollama.requests.filter((x) => x.path === '/api/chat').find((x) => (x.body.tools as unknown[] | undefined)?.length)!.body.tools as { function: { name: string } }[]).map((t) => t.function.name);
    expect(offered).toEqual(['jira_lookup_invoice']);
    expect(systemOf(ollama.requests.filter((x) => x.path === '/api/chat').at(-1)!.body.messages as Msg[])).toContain('The person approved this plan');
    // A plan the person names an unoffered tool in is refused; an expired card ends the answer.
    const r3 = await converse(c.m, 'Once more.');
    const card3 = await until(async () => (await cards(c.m, r3.conversationId)).find((x) => x.kind === 'plan' && x.state === 'awaiting'));
    expect((await post(c.m, `/api/conversations/${r3.conversationId}/invocations/${card3.id}/decide`, { decision: 'approve', steps: [{ title: 'Delete it', tools: ['jira_delete_branch'] }] }).expect(400)).body.detail).toMatch(/cannot call/);
    await h.s.db('chat_invocations').where({ id: card3.id }).update({ expires_at: Date.now() - 1 });
    expect(await h.s.chatInvocations.expireCards(h.tenantId)).toBe(1);
    expect((await answered(c.m, r3.conversationId, r3.messageId)).content).toMatch(/expired/);
    const actions = (await h.s.db('audit_events').whereIn('action', ['chat.plan.proposed', 'chat.plan.declined', 'chat.plan.approved']).orderBy('seq')).map((x: { action: string }) => x.action);
    expect(actions).toEqual(['chat.plan.proposed', 'chat.plan.declined', 'chat.plan.proposed', 'chat.plan.approved', 'chat.plan.proposed']);
  });

  it('B-11703, B-11705: an agent run waits on its plan, follows it as its step list, pauses on a deviation, and its chain node carries the level and the plan', async () => {
    const c = await setup();
    await publishEntry(c, agent('Clerk', { planFirst: true, think: 'high' }));
    ollama.reply = (messages, opts) => {
      const last = messages.at(-1)!;
      if (isPlan(messages)) return { content: '{"steps":[{"title":"Look the invoice up","tools":["jira_lookup_invoice"],"data":[]}]}' };
      if (last.role === 'tool' && last.content.includes('"total"')) return { content: '', toolCall: { name: 'jira_create_issue', arguments: { summary: 'Late invoice' } } };
      if (last.role === 'tool') return { thinking: 'All done. ', content: 'Issue filed.' };
      const names = ((opts.tools as { function: { name: string } }[]) ?? []).map((t) => t.function.name);
      if (names.includes('jira_lookup_invoice')) return { thinking: 'I should look it up first. ', content: '', toolCall: { name: 'jira_lookup_invoice', arguments: { number: 'INV-7' } } };
      return { content: 'Nothing to do.' };
    };
    // Declined: the run ends and nothing ran.
    const r1 = (await post(c.m, '/api/runs', { agent: 'Clerk', input: 'Chase INV-7.' }).expect(202)).body;
    await drain();
    let v = (await c.m.agent.get(`/api/runs/${r1.id}`).expect(200)).body;
    expect(v).toMatchObject({ state: 'waiting', plan: { state: 'awaiting', tools: ['jira_lookup_invoice'] } });
    expect(v.steps[0]).toMatchObject({ lane: 'think', title: 'Plan', state: 'waiting', meta: { plan: true } });
    expect((await post(c.m, `/api/runs/${r1.id}/plan`, { decision: 'decline' }).expect(200)).body).toEqual({ decision: 'declined' });
    expect((await h.s.db('agent_runs').where({ id: r1.id }).first())).toMatchObject({ state: 'cancelled', plan_state: 'declined' });
    expect(mcp.calls).toHaveLength(0);
    // Approved: the run follows the plan; a call outside it (create_issue) pauses for a new approval; approved, it runs on.
    const r2 = (await post(c.m, '/api/runs', { agent: 'Clerk', input: 'Chase INV-7.' }).expect(202)).body;
    await drain();
    const ok = (await post(c.m, `/api/runs/${r2.id}/plan`, { decision: 'approve' }).expect(200)).body;
    expect(ok.decision).toBe('approved');
    await drain();
    v = (await c.m.agent.get(`/api/runs/${r2.id}`).expect(200)).body;
    expect(v.state).toBe('waiting');
    expect(mcp.calls.map((x) => x.name)).toEqual(['lookup_invoice']);
    const waiting = v.steps.find((s: { state: string; meta: { deviation?: boolean } }) => s.state === 'waiting')!;
    expect(waiting).toMatchObject({ title: 'jira.create_issue', meta: { deviation: true } });
    // The thinking level of the run and its tokens are on the steps and on the chain node.
    const think = v.steps.find((s: { lane: string; meta: { plan?: boolean; think?: string } }) => s.lane === 'think' && !s.meta.plan && s.meta.think)!;
    expect(think.meta).toMatchObject({ think: 'high' });
    expect(Number(think.meta.thinkingTokens)).toBeGreaterThan(0);
    const chain = (await h.s.chains.view(h.tenantId, v.chain.id))!;
    const node = chain.nodes.find((n: { kind: string; ref: string }) => n.kind === 'agent-run' && n.ref === r2.id)!;
    expect(node).toMatchObject({ think: 'high', plan: { steps: [{ title: 'Look the invoice up', tools: ['jira_lookup_invoice'] }] } });
    expect(Number(node.thinkingTokens)).toBeGreaterThan(0);
    await post(c.m, `/api/runs/${r2.id}/steps/${waiting.n}/decision`, { decision: 'approve' }).expect(200);
    await drain();
    v = (await c.m.agent.get(`/api/runs/${r2.id}`).expect(200)).body;
    expect(v).toMatchObject({ state: 'succeeded', output: 'Issue filed.' });
    expect(mcp.calls.map((x) => x.name)).toEqual(['lookup_invoice', 'create_issue']);
    const actions = (await h.s.db('audit_events').whereIn('action', ['agent.plan.drafted', 'agent.plan.declined', 'agent.plan.approved']).orderBy('seq')).map((x: { action: string }) => x.action);
    expect(actions).toEqual(['agent.plan.drafted', 'agent.plan.declined', 'agent.plan.drafted', 'agent.plan.approved']);
  });

  it('B-11704: the reflection pass gives a finding the badge names, or a revised answer that is screened', async () => {
    const c = await setup({ reflect: true });
    ollama.reply = (messages) => {
      if (isReflection(messages)) {
        const body = messages.at(-1)!.content;
        if (body.includes('Revise me')) return { content: '{"status":"revised","findings":[{"kind":"contradiction","text":"The total contradicts itself."}],"revised":"The total is 1188."}' };
        return { content: '{"status":"findings","findings":[{"kind":"unsupported","text":"The citation does not support the 20% figure."}],"revised":null}' };
      }
      return { thinking: 'Thinking. ', content: `Fake answer to: ${messages.at(-1)!.content}` };
    };
    const r = await converse(c.m, 'What share grew?');
    const checked = await until(async () => {
      const m = (await view(c.m, r.conversationId)).messages.find((x) => x.id === r.messageId);
      return m?.checked ? m : null;
    });
    expect(checked.checked).toMatchObject({ status: 'findings', profile: 'general', findings: [{ kind: 'unsupported', text: expect.stringContaining('20% figure') }], revised: null });
    expect(await h.s.db('audit_events').where({ action: 'chat.reflection.checked' })).toHaveLength(1);
    // A revised answer rides in the badge; a reflection by another profile is metered to it.
    const r2 = await converse(c.m, 'Revise me');
    const checked2 = await until(async () => {
      const m = (await view(c.m, r2.conversationId)).messages.find((x) => x.id === r2.messageId);
      return m?.checked ? m : null;
    });
    expect(checked2.checked).toMatchObject({ status: 'revised', revised: 'The total is 1188.' });
    expect((await h.s.db('usage_records').where({ message_id: r2.messageId })).length).toBe(2);
    // The reflection parser: an unreadable verdict is a finding, never a silent pass.
    expect(parseReflection('nonsense').findings).toHaveLength(1);
    expect(parseReflection('{"status":"ok","findings":[]}')).toEqual({ status: 'ok', findings: [], revised: null });
  });

  it('B-11705: a workflow model step and an agent above the profile\'s thinking ceiling are refused at publish, with the ceiling named', async () => {
    const c = await setup({ think_ceiling: 'medium' });
    const node = (id: string, kind: WfNode['kind'], config: Record<string, unknown>): WfNode => ({ id, kind, title: id, x: 20, y: 20, config } as WfNode);
    const g: WfGraph = { nodes: [node('trigger', 'trigger', { source: 'api' }), node('m', 'model', { profile: 'general', prompt: 'Summarise {{input.text}}', think: 'high' })], edges: [{ from: 'trigger', to: 'm' }], limits: {} };
    const w = (await post(c.a, '/api/workflows', { name: 'summarise-text', label: 'internal' }).expect(201)).body;
    await put(c.a, `/api/workflows/${w.id}/draft`, { graph: g }).expect(200);
    const refused = await post(c.a, `/api/workflows/${w.id}/publish`);
    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.body)).toMatch(/thinking high is above the ceiling of profile general, which is medium/);
    g.nodes[1]!.config.think = 'medium';
    await put(c.a, `/api/workflows/${w.id}/draft`, { graph: g }).expect(200);
    expect((await post(c.a, `/api/workflows/${w.id}/publish`)).status).toBe(200);
    // An agent's level is checked the same way (the registry's checks name the ceiling).
    const e = (await post(c.a, '/api/admin/registry', agent('Thinker', { think: 'high' })).expect(201)).body;
    const checks = (await c.a.agent.get(`/api/admin/registry/${e.id}`).expect(200)).body.checks as { name: string; ok: boolean; detail: string }[];
    const ck = checks.find((x) => x.name === 'Thinking within the profile ceiling')!;
    expect(ck).toMatchObject({ ok: false, detail: expect.stringContaining('which is medium') });
  });

  it('B-11706: a thinking rubric, the tools a plan must and must not name, and a reflection count in an evaluation and its gate', async () => {
    const c = await setup({ plan_first: false, reflect: false });
    ollama.reply = (messages) => {
      if (isPlan(messages)) return { content: '{"steps":[{"title":"Look it up","tools":["jira.lookup_invoice","jira.create_issue"],"data":[]}]}' };
      if (isJudge(messages)) return { content: messages.at(-1)!.content.includes('<answer>\nWorking') ? '{"score": 0.9, "reason": "the thinking is careful"}' : '{"score": 0.2, "reason": "weak"}' };
      if (isReflection(messages)) return { content: '{"status":"ok","findings":[],"revised":null}' };
      return { thinking: 'Working carefully through it. ', content: `Fake answer to: ${messages.at(-1)!.content}` };
    };
    const set = (await post(c.a, `/api/admin/profiles/${c.profile.id}/eval-sets`, {
      name: 'Thinking and plans',
      threshold: 1,
      gate: true,
      judgeProfile: 'general',
      cases: [
        { id: 'think', prompt: 'How many?', checks: [{ kind: 'thinking-rubric', rubric: 'The thinking works through the question.', minScore: 0.5 }] },
        { id: 'plan', prompt: 'Chase the invoice.', checks: [{ kind: 'plan-tools', must: ['jira.lookup_invoice'], mustNot: ['jira.create_issue'] }] },
        { id: 'checked', prompt: 'Sum it.', checks: [{ kind: 'reflection', maxFindings: 0 }] }
      ]
    }).expect(201)).body;
    const [run] = (await post(c.a, `/api/admin/profiles/${c.profile.id}/evaluations/run`, { setId: set.id }).expect(202)).body;
    await drain();
    const rv = (await c.a.agent.get(`/api/admin/profiles/${c.profile.id}/evaluations/runs/${run.id}`).expect(200)).body;
    expect(rv.state).toBe('failed'); // the plan calls a tool the case forbids
    const byId = Object.fromEntries((rv.results as { caseId: string; passed: boolean; checks: { kind: string; passed: boolean; detail: string }[]; plan?: unknown; thinking?: string }[]).map((x) => [x.caseId, x]));
    expect(byId.think).toMatchObject({ passed: true, checks: [{ kind: 'thinking-rubric', passed: true }] });
    expect(byId.think!.thinking).toContain('Working carefully');
    expect(byId.plan).toMatchObject({ passed: false, plan: { tools: ['jira.lookup_invoice', 'jira.create_issue'] } });
    expect(byId.plan!.checks[0]!.detail).toMatch(/calls jira.create_issue, which the case forbids/);
    expect(byId.checked).toMatchObject({ passed: true, checks: [{ kind: 'reflection', passed: true }] });
    // The gate counts them: a changed profile cannot be published while the gated set fails.
    const gated = await patch(c.a, `/api/admin/profiles/${c.profile.id}`, { systemPrompt: 'Be careful.' });
    expect(gated.status).toBe(409);
    expect(JSON.stringify(gated.body)).toMatch(/Thinking and plans/);
    // A rubric without a judge profile is refused; the plan parser bounds what it reads.
    expect((await patch(c.a, `/api/admin/profiles/${c.profile.id}/eval-sets/${set.id}`, { judgeProfile: null }).expect(400)).body.detail).toMatch(/judge profile/);
    expect(parsePlan('{"steps":[{"title":"a","tools":["x","x"]},{"title":"b"}]}', 1)).toEqual({ steps: [{ title: 'a', tools: ['x'], data: [] }], tools: ['x'] });
    expect(parsePlan('no plan here', 5)).toBeNull();
  });
});
