/*
 * 1.7.0, Sprint 40 (B-40): agents, tools and skills in chat. What a conversation may call (B-4001), `/tool` through
 * the dispatcher and the tool-call guardrail (B-4002), approval cards for write and destructive tools (B-4003),
 * `@agent` (B-4004), `+skill` (B-4005) and `/workflow` with its approvals decided from the conversation (B-4009).
 * The refusals are tested beside the successes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { WfGraph, WfNode } from '../src/workflows/graph.js';
import { FakeMcp } from './fake-mcp.js';
import { FakeOllama } from './fake-ollama.js';
import { seedGateway } from './seed-gateway.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);
const put = (c: Client, url: string, body: object = {}) => c.agent.put(url).set('x-csrf-token', c.csrf).send(body);
const del = (c: Client, url: string) => c.agent.delete(url).set('x-csrf-token', c.csrf);
const BUDGETS = { steps: 20, tokens: 10_000, wallSeconds: 600, toolCalls: 8 };
const names = (list: { name: string }[]) => list.map((x) => x.name);

interface Msg {
  id: string;
  parentId: string | null;
  role: string;
  content: string;
  state: string;
  kind: string | null;
  invocationId: string | null;
  label: string;
  tools: { name: string; expression: string; output?: unknown }[];
}
interface Inv {
  id: string;
  kind: string;
  name: string;
  state: string;
  label: string;
  arguments: Record<string, unknown> | null;
  input: string | null;
  fromText: boolean;
  result: unknown;
  error: string | null;
  messageId: string;
  userMessageId: string;
  approval: { needs: string[]; caller: { decision: string } | null; reviewer: { decision: string; by: string } | null; flag: string | null; reason: string | null; expiresAt: number | null } | null;
  run: { kind: string; id: string; state: string; chain: string | null; usage: { steps: number } | null; steps: { title: string; state: string }[] } | null;
  held: { node: string; tool: string; sideEffect: string | null; canDecide: boolean; at: { kind: string; step?: number; approval?: string }; path: { kind: string; name: string }[] }[];
}

describe('agents, tools and skills in chat (B-40)', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let mcp: FakeMcp;

  afterEach(async () => {
    await h.close();
    await ollama.stop();
    await mcp.stop();
  });

  async function drain(rounds = 40): Promise<void> {
    for (let i = 0; i < rounds; i++) if (!(await h.s.jobs.runDue())) break;
  }

  async function setup(profile: Record<string, unknown> = {}) {
    h = await harness({ OLLAMA_POLL_MS: '600000', MCP_TIMEOUT_MS: '3000' });
    ollama = await new FakeOllama().start();
    ollama.chatDelayMs = 0;
    mcp = await new FakeMcp().start();
    mcp.tools = [
      { name: 'create_issue', description: 'Creates an issue.', inputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] }, run: (a: Record<string, unknown>) => ({ key: 'FIN-1188', summary: a.summary }) },
      { name: 'delete_branch', description: 'Deletes a branch.', inputSchema: { type: 'object', properties: { branch: { type: 'string' } } }, annotations: { destructiveHint: true }, run: () => ({ deleted: true }) },
      { name: 'search', description: 'Searches issues.', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, annotations: { readOnlyHint: true }, run: () => ({ hits: ['FIN-1'] }) }
    ];
    await seedGateway(h, ollama, profile);
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Ops', 'confidential')).id;
    const users = [await localUser(h, 'wadmin', ['workflow-admin', 'member'], 'confidential'), await localUser(h, 'tadmin', ['tool-admin', 'agent-admin'], 'confidential'), await localUser(h, 'tadmin2', ['tool-admin', 'agent-admin'], 'confidential'), await localUser(h, 'mem', ['member'], 'confidential'), await localUser(h, 'reviewer', ['flag-reviewer', 'member'], 'confidential'), await localUser(h, 'low', ['member'], 'internal'), await localUser(h, 'reviewer2', ['flag-reviewer', 'member'], 'confidential')];
    for (const u of users) await h.s.tenants.addMember(ws, u.id);
    const c = { admin: await loginAdmin(h, 'wadmin'), t: await loginAdmin(h, 'tadmin'), t2: await loginAdmin(h, 'tadmin2'), m: await login(h, 'mem'), r: await login(h, 'reviewer'), r2: await login(h, 'reviewer2'), low: await login(h, 'low'), ws };
    for (const x of [c.admin, c.t, c.t2, c.m, c.r, c.r2, c.low]) await put(x, '/api/me/workspace', { workspaceId: ws }).expect(200);
    const reg = (await post(c.t, '/api/admin/mcp-servers', { name: 'jira', url: mcp.url }).expect(201)).body;
    await post(c.t, `/api/admin/mcp-servers/${reg.id}/tools/create_issue/approve`, { sideEffect: 'write', confirm: 'always', label: 'confidential' }).expect(200);
    await post(c.t, `/api/admin/mcp-servers/${reg.id}/tools/delete_branch/approve`, { sideEffect: 'destructive', confirm: 'always', label: 'confidential' }).expect(200);
    // A read tool whose ceiling is internal: it may not receive confidential data.
    await post(c.t, `/api/admin/mcp-servers/${reg.id}/tools/search/approve`, { sideEffect: 'read', confirm: 'never', label: 'internal' }).expect(200);
    return c;
  }
  type Ctx = Awaited<ReturnType<typeof setup>>;

  async function publishEntry(c: Ctx, body: Record<string, unknown>) {
    const made = await post(c.t, '/api/admin/registry', body);
    expect(made.body.errors ?? made.body.detail ?? null, JSON.stringify(made.body)).toBeNull();
    const e = made.body;
    await post(c.t, `/api/admin/registry/${e.id}/submit`).expect(200);
    await post(c.t2, `/api/admin/registry/${e.id}/review`, { decision: 'approve' }).expect(200);
    return e as { id: string; name: string };
  }
  const agent = (name: string, def: Record<string, unknown> = {}, label = 'confidential') => ({ kind: 'agent', name, version: '1.0.0', description: `${name}: works on the task it is given and reports the result plainly.`, label, definition: { profile: 'general', systemPrompt: `You are ${name}.`, tools: [], budgets: BUDGETS, ...def } });
  const skill = (name: string, instructions: string, label = 'confidential') => ({ kind: 'skill', name, version: '1.0.0', description: `${name}: instructions for how answers are written in this workspace.`, label, definition: { instructions, tools: [] } });

  const conversation = async (c: Client, label = 'internal') => (await post(c, '/api/conversations', { label }).expect(201)).body.id as string;
  const view = async (c: Client, id: string) => (await c.agent.get(`/api/conversations/${id}`).expect(200)).body as { label: string; headId: string; messages: Msg[] };
  const invocations = async (c: Client, id: string) => (await c.agent.get(`/api/conversations/${id}/invocations`).expect(200)).body as { invocations: Inv[]; skills: { name: string; mode: string; available: boolean }[] };
  const caps = async (c: Client, id: string, q = '') => (await c.agent.get(`/api/conversations/${id}/capabilities${q}`).expect(200)).body as { conversation: { label: string; ceiling: string; profile: string | null }; may: Record<string, boolean>; restricted: Record<string, boolean>; tools: { name: string; sideEffect: string; approval: string; inputSchema: unknown; ceiling: string }[]; agents: { name: string }[]; skills: { name: string; active: string | null }[]; workflows: { name: string; label: string }[] };
  /** Sends a message and waits for its answer; returns the messages the model was given. */
  async function ask(c: Client, id: string, content: string) {
    const before = ollama.requests.filter((r) => r.path === '/api/chat').length;
    const sent = (await post(c, `/api/conversations/${id}/messages`, { content, profile: 'general' }).expect(202)).body;
    for (let i = 0; i < 200; i++) {
      const m = (await view(c, id)).messages.find((x) => x.id === sent.messageId);
      if (m && m.state !== 'queued' && m.state !== 'streaming') break;
      await new Promise((r) => setTimeout(r, 10));
    }
    return ollama.requests.filter((r) => r.path === '/api/chat')[before]!.body.messages as { role: string; content: string; tool_calls?: { function: { name: string; arguments: unknown } }[]; tool_name?: string }[];
  }
  const audits = async (prefix: string) => (await h.s.audit.list(h.tenantId, { limit: 500 })).filter((e) => e.action.startsWith(prefix)).map((e) => e.action);

  it('B-4001: lists what the caller may call, with schemas and side-effect classes; an entry whose ceiling the conversation exceeds is neither listed nor callable', async () => {
    const c = await setup();
    await publishEntry(c, agent('Data analyst'));
    await publishEntry(c, agent('Public helper', {}, 'internal'));
    await publishEntry(c, skill('house-style', 'Write in British English.'));
    const internal = await conversation(c.m, 'internal');
    const confidential = await conversation(c.m, 'confidential');

    const a = await caps(c.m, internal, '?profile=general');
    expect(a.conversation).toEqual({ id: internal, label: 'internal', ceiling: 'confidential', profile: 'general' });
    expect(a.may).toEqual({ tools: true, agents: true, skills: true, workflows: true });
    expect(names(a.tools)).toEqual(expect.arrayContaining(['calculate', 'jira.create_issue', 'jira.delete_branch', 'jira.search']));
    expect(a.tools.find((t) => t.name === 'jira.create_issue')).toMatchObject({ sideEffect: 'write', approval: 'caller', ceiling: 'confidential', inputSchema: { type: 'object', required: ['summary'] } });
    expect(a.tools.find((t) => t.name === 'jira.delete_branch')).toMatchObject({ sideEffect: 'destructive', approval: 'caller' });
    expect(a.tools.find((t) => t.name === 'jira.search')).toMatchObject({ sideEffect: 'read', approval: 'none', ceiling: 'internal' });
    expect(names(a.agents)).toEqual(['Data analyst', 'Public helper']);
    expect(a.skills).toEqual([expect.objectContaining({ name: 'house-style', active: null })]);

    // The confidential conversation is above the ceiling of jira.search and of Public helper: neither is listed.
    const b = await caps(c.m, confidential, '?profile=general');
    expect(names(b.tools)).not.toContain('jira.search');
    expect(names(b.tools)).toContain('jira.create_issue');
    expect(names(b.agents)).toEqual(['Data analyst']);
    // Calling them by name is refused the same way as a name that does not exist, and nothing reaches the tool.
    const refused = await post(c.m, `/api/conversations/${confidential}/tools`, { tool: 'jira.search', arguments: { q: 'x' } }).expect(404);
    const unknown = await post(c.m, `/api/conversations/${confidential}/tools`, { tool: 'no.such.tool', arguments: {} }).expect(404);
    expect(refused.body.title).toBe(unknown.body.title);
    expect(refused.body.detail).toBe(unknown.body.detail);
    await post(c.m, `/api/conversations/${confidential}/agents`, { agent: 'Public helper', input: 'Hello.' }).expect(404);
    await drain();
    expect(mcp.calls).toHaveLength(0);
    expect((await view(c.m, confidential)).messages).toHaveLength(0);

    // The conversation the composer's next message would start.
    expect((await caps(c.m, 'new')).conversation).toMatchObject({ id: null, label: 'internal' });
    // Another person's conversation is not found; a profile the caller may not use is not found.
    await c.r.agent.get(`/api/conversations/${internal}/capabilities`).expect(404);
    await c.m.agent.get(`/api/conversations/${internal}/capabilities?profile=nope`).expect(404);
  });

  it('B-4001: the profile\'s allow-list restricts each kind, and a call outside it is refused like an unknown name', async () => {
    const c = await setup({ chat_capabilities: { tools: ['calculate'], agents: [], skills: ['house-style'] } });
    await publishEntry(c, agent('Data analyst'));
    await publishEntry(c, skill('house-style', 'Write in British English.'));
    await publishEntry(c, skill('legal-tone', 'Write like a contract.'));
    const id = await conversation(c.m);
    const a = await caps(c.m, id, '?profile=general');
    expect(a.restricted).toEqual({ tools: true, agents: true, skills: true, workflows: false });
    expect(names(a.tools)).toEqual(['calculate']);
    expect(a.agents).toEqual([]);
    expect(names(a.skills)).toEqual(['house-style']);
    await post(c.m, `/api/conversations/${id}/tools`, { tool: 'jira.create_issue', arguments: { summary: 'x' }, profile: 'general' }).expect(404);
    await post(c.m, `/api/conversations/${id}/agents`, { agent: 'Data analyst', input: 'Hi.', profile: 'general' }).expect(404);
    await put(c.m, `/api/conversations/${id}/skills/${encodeURIComponent('legal-tone')}`, { mode: 'sticky', profile: 'general' }).expect(404);
    await put(c.m, `/api/conversations/${id}/skills/${encodeURIComponent('house-style')}`, { mode: 'sticky', profile: 'general' }).expect(200);
    expect(mcp.calls).toHaveLength(0);
  });

  it('B-4002: a read tool runs through the dispatcher and joins the conversation as a tool turn the model sees next', async () => {
    const c = await setup();
    const id = await conversation(c.m);
    const bad = await post(c.m, `/api/conversations/${id}/tools`, { tool: 'calculate', arguments: { expression: 7 } }).expect(400);
    expect(bad.body.errors[0].path).toBe('arguments');
    const inv = (await post(c.m, `/api/conversations/${id}/tools`, { tool: 'calculate', arguments: { expression: '(412880 - 361500) / 361500 * 100' } }).expect(202)).body as Inv;
    expect(inv).toMatchObject({ kind: 'tool', name: 'calculate', state: 'running', approval: null, arguments: { expression: '(412880 - 361500) / 361500 * 100' } });
    let v = await view(c.m, id);
    expect(v.messages.map((m) => [m.role, m.kind, m.state])).toEqual([['user', 'tool', 'complete'], ['assistant', 'tool', 'awaiting']]);
    await drain();
    const done = (await invocations(c.m, id)).invocations[0]!;
    expect(done.state).toBe('succeeded');
    expect((done.result as { decimal: string }).decimal).toMatch(/^14\.213/);
    v = await view(c.m, id);
    expect(v.messages[1]).toMatchObject({ state: 'complete', invocationId: inv.id, tools: [{ name: 'calculate' }] });
    expect(v.headId).toBe(v.messages[1]!.id);

    // The next turn: the model reads the call and its result.
    const given = await ask(c.m, id, 'How far over is that?');
    expect(given.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(given[0]!.content).toContain('Called the tool calculate');
    expect(given[1]!.tool_calls![0]!.function).toMatchObject({ name: 'calculate', arguments: { expression: '(412880 - 361500) / 361500 * 100' } });
    expect(given[2]!.content).toContain('14.213');
    // A turn made by a call is not regenerated or edited.
    await post(c.m, `/api/conversations/${id}/messages/${v.messages[1]!.id}/regenerate`, {}).expect(409);
    await post(c.m, `/api/conversations/${id}/messages/${v.messages[0]!.id}/edit`, { content: 'Again.' }).expect(409);

    // Audited, sealed at rest, and recorded in a chain rooted at the chat turn.
    expect(await audits('chat.tool.')).toEqual(expect.arrayContaining(['chat.tool.called', 'chat.tool.succeeded']));
    const raw = await h.s.db('chat_invocations').where({ id: inv.id }).first();
    expect(raw.args).toMatch(/^v2\./);
    expect(raw.args).not.toContain('412880');
    expect(raw.result).toMatch(/^v2\./);
    expect(await h.s.db('chain_nodes').where({ kind: 'chat-turn', ref: inv.messageId }).first()).toBeTruthy();
  });

  it('B-4003: a write tool runs only after its card is approved, with the exact arguments it showed', async () => {
    const c = await setup();
    const id = await conversation(c.m);
    const inv = (await post(c.m, `/api/conversations/${id}/tools`, { tool: 'jira.create_issue', arguments: { summary: 'Q3 variance review' } }).expect(202)).body as Inv;
    expect(inv).toMatchObject({ state: 'pending', sideEffect: 'write', arguments: { summary: 'Q3 variance review' }, approval: { needs: ['caller'], caller: null, reviewer: null } });
    expect(inv.approval!.expiresAt).toBeGreaterThan(Date.now());
    await drain();
    expect(mcp.calls).toHaveLength(0);
    // Only the conversation's owner sees or decides the card.
    await post(c.r, `/api/conversations/${id}/invocations/${inv.id}/decision`, { decision: 'approve' }).expect(404);
    expect(mcp.calls).toHaveLength(0);

    const approved = (await post(c.m, `/api/conversations/${id}/invocations/${inv.id}/decision`, { decision: 'approve' }).expect(200)).body as Inv;
    expect(approved).toMatchObject({ state: 'running', approval: { caller: { decision: 'approved' } } });
    await post(c.m, `/api/conversations/${id}/invocations/${inv.id}/decision`, { decision: 'approve' }).expect(409);
    await drain();
    expect(mcp.calls).toEqual([expect.objectContaining({ name: 'create_issue', arguments: { summary: 'Q3 variance review' } })]);
    const done = (await invocations(c.m, id)).invocations[0]!;
    expect(done).toMatchObject({ state: 'succeeded', result: { key: 'FIN-1188' } });
    expect(await audits('chat.tool.')).toEqual(expect.arrayContaining(['chat.tool.called', 'chat.tool.approved', 'chat.tool.succeeded']));
  });

  it('B-4003: a denied card and an expired card are recorded and leave no side effect', async () => {
    const c = await setup();
    const id = await conversation(c.m);
    const denied = (await post(c.m, `/api/conversations/${id}/tools`, { tool: 'jira.delete_branch', arguments: { branch: 'main' } }).expect(202)).body as Inv;
    expect(denied).toMatchObject({ state: 'pending', sideEffect: 'destructive' });
    expect((await post(c.m, `/api/conversations/${id}/invocations/${denied.id}/decision`, { decision: 'deny', note: 'Wrong branch.' }).expect(200)).body).toMatchObject({ state: 'denied', approval: { caller: { decision: 'denied' } } });
    // A denied card cannot be approved afterwards.
    await post(c.m, `/api/conversations/${id}/invocations/${denied.id}/decision`, { decision: 'approve' }).expect(409);

    const stale = (await post(c.m, `/api/conversations/${id}/tools`, { tool: 'jira.create_issue', arguments: { summary: 'Late' } }).expect(202)).body as Inv;
    await h.s.db('chat_invocations').where({ id: stale.id }).update({ expires_at: Date.now() - 1000 });
    // Approving a card past its time is refused, and the expiry is what is recorded.
    await post(c.m, `/api/conversations/${id}/invocations/${stale.id}/decision`, { decision: 'approve' }).expect(409);
    await drain();
    expect(mcp.calls).toHaveLength(0);
    const list = (await invocations(c.m, id)).invocations;
    expect(list.map((x) => x.state)).toEqual(['denied', 'expired']);
    expect(await audits('chat.tool.')).toEqual(expect.arrayContaining(['chat.tool.denied', 'chat.tool.expired']));
    // Neither call is given to the model: their turns are withdrawn.
    const v = await view(c.m, id);
    expect(v.messages.map((m) => m.state)).toEqual(['withdrawn', 'withdrawn', 'withdrawn', 'withdrawn']);
    const given = await ask(c.m, id, 'What happened?');
    expect(given.map((m) => m.role)).toEqual(['user']);
    // The sweep expires cards too.
    const third = (await post(c.m, `/api/conversations/${id}/tools`, { tool: 'jira.create_issue', arguments: { summary: 'Later' } }).expect(202)).body as Inv;
    await h.s.db('chat_invocations').where({ id: third.id }).update({ expires_at: Date.now() - 1000 });
    expect(await h.s.chatCapabilities.expire(h.tenantId)).toBe(1);
    expect(mcp.calls).toHaveLength(0);
  });

  it('B-4002: a call the guardrail holds shows as held and runs only when a reviewer other than the caller approves it in the flag queue', async () => {
    const c = await setup();
    const engine = h.s.guardrails;
    h.s.guardrails = { ...engine, check: async (i) => (i.checkpoint === 'tool-call' && i.text.includes('budget') ? { action: 'require-approval', text: i.text, findings: [], reason: 'Budget questions are reviewed.' } : i.checkpoint === 'tool-call' && i.text.includes('forbidden') ? { action: 'block', text: i.text, findings: [], reason: 'Not this one.' } : engine.check(i)) };
    const id = await conversation(c.r);
    // A read tool nobody has to approve: the guardrail holds it for a reviewer.
    const inv = (await post(c.r, `/api/conversations/${id}/tools`, { tool: 'jira.search', arguments: { q: 'budget' } }).expect(202)).body as Inv;
    await drain();
    let held = (await invocations(c.r, id)).invocations[0]!;
    expect(held).toMatchObject({ state: 'held', approval: { needs: ['reviewer'], reviewer: null, reason: expect.stringContaining('held by the tool-call guardrail') } });
    expect(held.approval!.flag).toMatch(/^F-\d+$/);
    expect(mcp.calls).toHaveLength(0);
    // The caller cannot approve their own held call, as a card or in the queue (they are a reviewer here).
    await post(c.r, `/api/conversations/${id}/invocations/${inv.id}/decision`, { decision: 'approve' }).expect(409);
    const r2 = c.r2;
    const own = await post(c.r, `/api/flags/${held.approval!.flag}/decide`, { decision: 'approved' }).expect(403);
    expect(own.body.step).toBe('dual-control');
    await drain();
    expect(mcp.calls).toHaveLength(0);
    // The reviewer reads the tool and the exact arguments, then approves; the call runs as its caller.
    const detail = (await r2.agent.get(`/api/flags/${held.approval!.flag}`).expect(200)).body;
    expect(detail).toMatchObject({ kind: 'hold', checkpoint: 'tool-call' });
    expect(JSON.parse(detail.held.content)).toMatchObject({ tool: 'jira.search', arguments: { q: 'budget' } });
    await post(r2, `/api/flags/${held.approval!.flag}/decide`, { decision: 'approved' }).expect(200);
    await drain();
    expect(mcp.calls).toEqual([expect.objectContaining({ name: 'search', arguments: { q: 'budget' } })]);
    held = (await invocations(c.r, id)).invocations[0]!;
    expect(held).toMatchObject({ state: 'succeeded', approval: { reviewer: { decision: 'approved' } } });

    // A write tool a rule holds needs the caller and the reviewer; a rejection runs nothing.
    const w = (await post(c.r, `/api/conversations/${id}/tools`, { tool: 'jira.create_issue', arguments: { summary: 'budget issue' } }).expect(202)).body as Inv;
    expect(w).toMatchObject({ state: 'pending', approval: { needs: ['caller', 'reviewer'] } });
    const after = (await post(c.r, `/api/conversations/${id}/invocations/${w.id}/decision`, { decision: 'approve' }).expect(200)).body as Inv;
    expect(after.state).toBe('held');
    await drain();
    expect(mcp.calls).toHaveLength(1);
    await post(r2, `/api/flags/${after.approval!.flag}/decide`, { decision: 'rejected', reason: 'No.' }).expect(200);
    await drain();
    expect(mcp.calls).toHaveLength(1);
    expect((await invocations(c.r, id)).invocations[1]).toMatchObject({ state: 'rejected', approval: { reviewer: { decision: 'rejected' } } });

    // A block is recorded and runs nothing.
    const blocked = (await post(c.r, `/api/conversations/${id}/tools`, { tool: 'jira.create_issue', arguments: { summary: 'forbidden' } }).expect(202)).body as Inv;
    expect(blocked).toMatchObject({ state: 'blocked', error: expect.stringContaining('Not this one.') });
    await post(c.r, `/api/conversations/${id}/tools`, { tool: 'jira.search', arguments: { q: 'forbidden' } }).expect(202);
    await drain();
    expect((await invocations(c.r, id)).invocations.map((x) => x.state)).toEqual(['succeeded', 'rejected', 'blocked', 'blocked']);
    expect(mcp.calls).toHaveLength(1);
    expect(await audits('chat.tool.')).toEqual(expect.arrayContaining(['chat.tool.held', 'chat.tool.approved', 'chat.tool.rejected', 'chat.tool.blocked', 'chat.tool.hold.approved', 'chat.tool.hold.rejected']));
  });

  it('B-4002: text the profile turns into arguments is shown on a card before anything runs, and is metered to the conversation', async () => {
    const c = await setup();
    const id = await conversation(c.m);
    ollama.reply = (messages, opts) => (opts.tools.length ? { content: '', toolCall: { name: 'jira_search', arguments: { q: 'travel' } } } : { content: `You said: ${messages[messages.length - 1]!.content}` });
    const inv = (await post(c.m, `/api/conversations/${id}/tools`, { tool: 'jira.search', text: 'find the travel issues', profile: 'general' }).expect(202)).body as Inv;
    expect(inv).toMatchObject({ state: 'pending', fromText: true, arguments: { q: 'travel' }, approval: { needs: ['caller'] } });
    await drain();
    expect(mcp.calls).toHaveLength(0);
    expect(await h.s.db('usage_records').where({ conversation_id: id, kind: 'chat' })).toHaveLength(1);
    await post(c.m, `/api/conversations/${id}/invocations/${inv.id}/decision`, { decision: 'approve' }).expect(200);
    await drain();
    expect(mcp.calls).toEqual([expect.objectContaining({ name: 'search', arguments: { q: 'travel' } })]);
    // Arguments the model wrote that do not match the schema are refused; nothing is added to the conversation.
    ollama.reply = () => ({ content: '', toolCall: { name: 'jira_search', arguments: { query: 5 } } });
    await post(c.m, `/api/conversations/${id}/tools`, { tool: 'jira.search', text: 'anything', profile: 'general' }).expect(400);
    expect((await invocations(c.m, id)).invocations).toHaveLength(1);
  });

  it('B-4005: a skill\'s instructions join the system prompt until it is removed, and are out of the very next turn', async () => {
    const c = await setup();
    await publishEntry(c, skill('house-style', 'Write in British English and cite the ledger.'));
    await publishEntry(c, skill('one-shot', 'Answer in exactly one sentence.'));
    const id = await conversation(c.m);
    const system = (given: { role: string; content: string }[]) => given.filter((m) => m.role === 'system').map((m) => m.content).join('\n');

    expect(system(await ask(c.m, id, 'First.'))).toBe('');
    const added = (await put(c.m, `/api/conversations/${id}/skills/${encodeURIComponent('house-style')}`, { mode: 'sticky' }).expect(200)).body;
    expect(added.skills).toEqual([expect.objectContaining({ name: 'house-style', mode: 'sticky', available: true })]);
    await put(c.m, `/api/conversations/${id}/skills/${encodeURIComponent('one-shot')}`, { mode: 'once' }).expect(200);
    expect((await caps(c.m, id)).skills.map((s) => [s.name, s.active])).toEqual([['house-style', 'sticky'], ['one-shot', 'once']]);

    const second = system(await ask(c.m, id, 'Second.'));
    expect(second).toContain('Skill house-style 1.0.0:\nWrite in British English and cite the ledger.');
    expect(second).toContain('Answer in exactly one sentence.');
    // The once skill applied to one turn and is gone; the sticky one stays.
    const third = system(await ask(c.m, id, 'Third.'));
    expect(third).toContain('Write in British English');
    expect(third).not.toContain('exactly one sentence');
    expect((await invocations(c.m, id)).skills.map((s) => s.name)).toEqual(['house-style']);

    // Removed: its instructions are left out of the very next turn.
    expect((await del(c.m, `/api/conversations/${id}/skills/${encodeURIComponent('house-style')}`).expect(200)).body.skills).toEqual([]);
    expect(system(await ask(c.m, id, 'Fourth.'))).toBe('');
    await del(c.m, `/api/conversations/${id}/skills/${encodeURIComponent('house-style')}`).expect(404);
    // A skill that is not published is not found; another person cannot change this conversation's skills.
    await put(c.m, `/api/conversations/${id}/skills/Nope`, { mode: 'sticky' }).expect(404);
    await put(c.r, `/api/conversations/${id}/skills/${encodeURIComponent('house-style')}`, { mode: 'sticky' }).expect(404);
    expect(await audits('chat.skill.')).toEqual(expect.arrayContaining(['chat.skill.added', 'chat.skill.applied', 'chat.skill.removed']));
  });

  it('B-4004: @agent starts a run bound to the conversation; its answer becomes a turn, it shows in Runs with a link back, and is metered to the conversation', async () => {
    const c = await setup();
    await publishEntry(c, agent('Data analyst', { tools: ['calculate'] }));
    const id = await conversation(c.m);
    await ask(c.m, id, 'Travel was 412880 against 361500.');
    ollama.reply = (messages) => {
      const last = messages[messages.length - 1]!;
      if (last.role === 'tool') return { content: `The overrun is ${JSON.parse(last.content).decimal}.` };
      return { content: 'I will compute it.', toolCall: { name: 'calculate', arguments: { expression: '(412880 - 361500) / 361500 * 100' } } };
    };
    const inv = (await post(c.m, `/api/conversations/${id}/agents`, { agent: 'Data analyst', input: 'How far over budget is travel?', context: 4 }).expect(202)).body as Inv;
    expect(inv).toMatchObject({ kind: 'agent', name: 'Data analyst', state: 'running', input: 'How far over budget is travel?', run: { kind: 'agent-run', state: 'queued' } });
    // The person can go on writing while the run works: the awaiting turn is not given to the model.
    ollama.reply = (messages) => ({ content: `You said: ${messages[messages.length - 1]!.content}` });
    const meanwhile = await ask(c.m, id, 'Meanwhile, hello.');
    expect(meanwhile.map((m) => m.content).join('\n')).not.toContain('@Data analyst');
    ollama.reply = (messages) => {
      const last = messages[messages.length - 1]!;
      if (last.role === 'tool') return { content: `The overrun is ${JSON.parse(last.content).decimal}.` };
      return { content: 'I will compute it.', toolCall: { name: 'calculate', arguments: { expression: '(412880 - 361500) / 361500 * 100' } } };
    };
    await drain();
    const done = (await invocations(c.m, id)).invocations[0]!;
    expect(done).toMatchObject({ state: 'succeeded', run: { state: 'succeeded' } });
    expect(done.run!.steps.map((s) => [s.title, s.state])).toEqual([['Plan', 'ok'], ['calculate', 'ok'], ['Answer', 'ok']]);
    expect(done.run!.chain).toMatch(/^[0-9A-Z]{26}$/);
    const turn = (await view(c.m, id)).messages.find((m) => m.id === done.messageId)!;
    expect(turn).toMatchObject({ role: 'assistant', kind: 'agent', state: 'complete' });
    expect(turn.content).toMatch(/^The overrun is 14\.213/);
    // The agent was given the turns the person allowed, and its first message is the request.
    const first = ollama.requests.filter((r) => r.path === '/api/chat').map((r) => r.body.messages as { role: string; content: string }[]).find((m) => m[0]!.content === 'You are Data analyst.')!;
    expect(first[1]!.content).toContain('Travel was 412880 against 361500.');
    expect(first[1]!.content).toContain('The request:\nHow far over budget is travel?');
    // In Runs, with a link back to the conversation.
    const run = (await c.m.agent.get(`/api/runs/${done.run!.id}`).expect(200)).body;
    expect(run).toMatchObject({ state: 'succeeded', conversation: { id, invocation: inv.id }, caller: { kind: 'chat-invocation', id: inv.id } });
    expect((await c.m.agent.get('/api/runs').expect(200)).body[0]).toMatchObject({ id: done.run!.id, conversation: { id } });
    expect(await h.s.db('usage_records').where({ kind: 'agent', conversation_id: id })).toHaveLength(2);
    expect(await audits('chat.agent.')).toContain('chat.agent.succeeded');
    expect((await h.s.db('chat_invocations').where({ id: inv.id }).first()).args).toMatch(/^v2\./);
  });

  it('B-4004: a run started from chat respects its budgets, pauses on a write call decided from the conversation, and is cancelled from the conversation', async () => {
    const c = await setup();
    await publishEntry(c, agent('Filer', { tools: ['jira.create_issue'] }));
    await publishEntry(c, agent('Looper', { tools: ['calculate'], budgets: { ...BUDGETS, steps: 2 } }));
    const id = await conversation(c.m);

    // Budgets: the run stops at its step limit; the conversation shows it and no answer joins it.
    ollama.reply = () => ({ content: '', toolCall: { name: 'calculate', arguments: { expression: '1 + 1' } } });
    const loop = (await post(c.m, `/api/conversations/${id}/agents`, { agent: 'Looper', input: 'Keep adding.' }).expect(202)).body as Inv;
    await drain();
    let list = (await invocations(c.m, id)).invocations;
    expect(list[0]).toMatchObject({ state: 'budget', run: { state: 'budget', usage: { steps: 2 } } });
    expect((await view(c.m, id)).messages.find((m) => m.id === loop.messageId)!.state).toBe('awaiting');
    // Budgets asked for above the maximum are refused.
    await post(c.m, `/api/conversations/${id}/agents`, { agent: 'Looper', input: 'More.', budgets: { steps: 100_000 } }).expect(400);
    expect((await post(c.m, `/api/conversations/${id}/invocations/${loop.id}/cancel`).expect(200)).body).toMatchObject({ state: 'cancelled' });

    // Approvals: a write call pauses the run; the card in the conversation lists it and decides it.
    ollama.reply = (messages) => (messages[messages.length - 1]!.role === 'tool' ? { content: 'Filed.' } : { content: '', toolCall: { name: 'jira_create_issue', arguments: { summary: 'Q3 review' } } });
    const filer = (await post(c.m, `/api/conversations/${id}/agents`, { agent: 'Filer', input: 'File the review issue.' }).expect(202)).body as Inv;
    await drain();
    list = (await invocations(c.m, id)).invocations;
    const waiting = list.find((x) => x.id === filer.id)!;
    expect(waiting).toMatchObject({ state: 'waiting', run: { state: 'waiting' } });
    expect(waiting.held).toEqual([expect.objectContaining({ tool: 'jira.create_issue', sideEffect: 'write', canDecide: true, at: expect.objectContaining({ kind: 'agent-run', step: 2 }) })]);
    expect(mcp.calls).toHaveLength(0);
    // Someone else cannot decide it from this conversation.
    await post(c.r, `/api/conversations/${id}/invocations/${filer.id}/held`, { node: waiting.held[0]!.node, decision: 'approve' }).expect(404);
    await post(c.m, `/api/conversations/${id}/invocations/${filer.id}/held`, { node: waiting.held[0]!.node, decision: 'approve' }).expect(200);
    await drain();
    expect(mcp.calls).toHaveLength(1);
    expect((await invocations(c.m, id)).invocations.find((x) => x.id === filer.id)).toMatchObject({ state: 'succeeded', held: [] });

    // Cancel: a waiting run is stopped from the conversation, and its held call never runs.
    const second = (await post(c.m, `/api/conversations/${id}/agents`, { agent: 'Filer', input: 'File another.' }).expect(202)).body as Inv;
    await drain();
    expect((await invocations(c.m, id)).invocations.find((x) => x.id === second.id)!.state).toBe('waiting');
    expect((await post(c.m, `/api/conversations/${id}/invocations/${second.id}/cancel`).expect(200)).body).toMatchObject({ state: 'cancelled', run: { state: 'cancelled' } });
    await drain();
    expect(mcp.calls).toHaveLength(1);
    expect((await c.m.agent.get(`/api/runs/${second.run!.id}`).expect(200)).body.state).toBe('cancelled');
    expect((await view(c.m, id)).messages.find((m) => m.id === second.messageId)!.state).toBe('withdrawn');
    await post(c.m, `/api/conversations/${id}/invocations/${second.id}/cancel`).expect(409);
    expect(await audits('chain.held.')).toContain('chain.held.decided');
  });

  it('B-4009: a workflow started from chat pauses on an approval card in the conversation, and approving it there resumes the chain', async () => {
    const c = await setup();
    const node = (nid: string, kind: string, config: Record<string, unknown>, extra: Partial<WfNode> = {}): WfNode => ({ id: nid, kind: kind as WfNode['kind'], title: nid, x: 20, y: 24, config, ...extra });
    const graph = (nodes: WfNode[]): WfGraph => ({ nodes, edges: nodes.slice(1).map((n, i) => ({ from: nodes[i]!.id, to: n.id })), limits: {} });
    const trigger = node('trigger', 'trigger', { source: 'api' }, { output: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] } });
    const publish = async (name: string, g: WfGraph, label: string) => {
      const w = (await post(c.admin, '/api/workflows', { name, label }).expect(201)).body;
      await put(c.admin, `/api/workflows/${w.id}/draft`, { graph: g }).expect(200);
      await post(c.admin, `/api/workflows/${w.id}/publish`).expect(200);
      return w.id as string;
    };
    await publish('signoff', graph([trigger, node('ok', 'approval', { role: 'workflow-admin', show: 'Sign off {{input.topic}}' })]), 'internal');
    await publish('secret', graph([trigger, node('ok', 'approval', { role: 'workflow-admin' })]), 'confidential');

    // `low` is cleared for internal only: the confidential workflow is above the conversation's ceiling for them.
    const lowConv = await conversation(c.low);
    expect(names((await caps(c.low, lowConv)).workflows)).toEqual(['signoff']);
    await post(c.low, `/api/conversations/${lowConv}/workflows`, { workflow: 'secret', input: { topic: 'x' } }).expect(404);
    expect(await h.s.db('workflow_runs')).toHaveLength(0);

    // The admin holds the approval's role: the conversation's card lists the approval and decides it.
    const id = await conversation(c.admin);
    expect((await caps(c.admin, id)).workflows.map((w) => [w.name, w.label])).toEqual([['secret', 'confidential'], ['signoff', 'internal']]);
    await post(c.admin, `/api/conversations/${id}/workflows`, { workflow: 'signoff', input: {} }).expect(400);
    expect((await view(c.admin, id)).messages).toHaveLength(0);
    const inv = (await post(c.admin, `/api/conversations/${id}/workflows`, { workflow: 'signoff', input: { topic: 'Q3 close' } }).expect(202)).body as Inv;
    expect(inv).toMatchObject({ kind: 'workflow', name: 'signoff', arguments: { topic: 'Q3 close' }, run: { kind: 'workflow-run' } });
    await drain();
    const waiting = (await invocations(c.admin, id)).invocations[0]!;
    expect(waiting).toMatchObject({ state: 'waiting', run: { state: 'waiting' } });
    expect(waiting.held).toEqual([expect.objectContaining({ canDecide: true, at: expect.objectContaining({ kind: 'workflow-run', step: 'ok' }) })]);
    expect((await view(c.admin, id)).messages.find((m) => m.id === inv.messageId)!.state).toBe('awaiting');
    await post(c.admin, `/api/conversations/${id}/invocations/${inv.id}/held`, { node: waiting.held[0]!.node, decision: 'approve', approval: waiting.held[0]!.at.approval }).expect(200);
    await drain();
    const done = (await invocations(c.admin, id)).invocations[0]!;
    expect(done).toMatchObject({ state: 'succeeded', run: { state: 'succeeded' }, held: [] });
    expect(done.result).toMatchObject({ approved: true });
    const turn = (await view(c.admin, id)).messages.find((m) => m.id === inv.messageId)!;
    expect(turn).toMatchObject({ kind: 'workflow', state: 'complete', tools: [{ name: 'workflow:signoff' }] });
    // The chain tree the run card opens.
    expect((await c.admin.agent.get(`/api/chains/${done.run!.chain}`).expect(200)).body.root).toMatchObject({ kind: 'workflow-run', state: 'succeeded' });
    expect(await audits('workflow.approval.')).toContain('workflow.approval.approved');

    // A run carries its workflow's label: the conversation rises to the higher of the two.
    const second = (await post(c.admin, `/api/conversations/${id}/workflows`, { workflow: 'secret', input: { topic: 'Payroll' } }).expect(202)).body as Inv;
    expect(second.label).toBe('confidential');
    expect((await view(c.admin, id)).label).toBe('confidential');
    // A member without the approval's role sees the approval held but may not decide it.
    const mine = await conversation(c.m);
    const held = (await post(c.m, `/api/conversations/${mine}/workflows`, { workflow: 'signoff', input: { topic: 'Mine' } }).expect(202)).body as Inv;
    await drain();
    const w = (await invocations(c.m, mine)).invocations[0]!;
    expect(w.held).toEqual([expect.objectContaining({ canDecide: false })]);
    await post(c.m, `/api/conversations/${mine}/invocations/${held.id}/held`, { node: w.held[0]!.node, decision: 'approve' }).expect(403);
    // Rejected from the admin's side, the run ends rejected and nothing joins the conversation for the model.
    await post(c.admin, `/api/workflow-approvals/${w.held[0]!.at.approval}`, { decision: 'reject', reason: 'No.' }).expect(200);
    await drain();
    expect(['rejected', 'failed']).toContain((await invocations(c.m, mine)).invocations[0]!.state);
    expect((await view(c.m, mine)).messages.find((m) => m.id === held.messageId)!.state).not.toBe('complete');
  });
});
