import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachRealtime } from '../src/realtime/socket.js';
import { FakeMcp } from './fake-mcp.js';
import { FakeOllama } from './fake-ollama.js';
import { seedGateway } from './seed-gateway.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';

interface Step {
  n: number;
  lane: string;
  title: string;
  state: string;
  meta: Record<string, unknown>;
  detail: Record<string, unknown>;
}

describe('agent runs', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let mcp: FakeMcp;

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000', MCP_TIMEOUT_MS: '3000' });
    ollama = await new FakeOllama().start();
    ollama.chatDelayMs = 0;
    mcp = await new FakeMcp().start();
    mcp.tools = [
      { name: 'create_issue', description: 'Creates an issue.', inputSchema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] }, run: () => ({ key: 'FIN-1188' }) },
      { name: 'delete_branch', description: 'Deletes a branch.', inputSchema: { type: 'object', properties: { branch: { type: 'string' } } }, annotations: { destructiveHint: true }, run: () => ({ deleted: true }) }
    ];
    await seedGateway(h, ollama);
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
    await mcp.stop();
  });

  async function admin(name: string, roles = ['tool-admin']) {
    await localUser(h, name, roles, 'confidential');
    const c = await loginAdmin(h, name);
    return { ...c, post: (path: string, body: object = {}) => c.agent.post(path).set('x-csrf-token', c.csrf).send(body) };
  }
  async function member(name = 'mem') {
    await localUser(h, name, ['member'], 'confidential');
    const c = await login(h, name);
    return { ...c, post: (path: string, body: object = {}) => c.agent.post(path).set('x-csrf-token', c.csrf).send(body) };
  }

  /** Publishes an agent through the registry: authored by one tool admin, approved by another. */
  async function publishAgent(tools: string[], budgets = { steps: 20, tokens: 10000, wallSeconds: 120, toolCalls: 8 }, name = 'Data analyst') {
    const a = await admin(`author${Math.random().toString(36).slice(2, 7)}`);
    const b = await admin(`reviewer${Math.random().toString(36).slice(2, 7)}`);
    const e = (await a.post('/api/admin/registry', { kind: 'agent', name, version: '1.0.0', description: 'Answers finance questions and computes variances exactly with the calculator.', label: 'confidential', definition: { profile: 'general', systemPrompt: 'Be exact.', tools, budgets } }).expect(201)).body;
    await a.post(`/api/admin/registry/${e.id}/submit`).expect(200);
    await b.post(`/api/admin/registry/${e.id}/review`, { decision: 'approve' }).expect(200);
    return { entry: e, author: a, reviewer: b };
  }

  async function registerJira(approver: Awaited<ReturnType<typeof admin>>) {
    const reg = (await approver.post('/api/admin/mcp-servers', { name: 'jira', url: mcp.url }).expect(201)).body;
    await approver.post(`/api/admin/mcp-servers/${reg.id}/tools/create_issue/approve`, { sideEffect: 'write', confirm: 'always', label: 'confidential' }).expect(200);
    await approver.post(`/api/admin/mcp-servers/${reg.id}/tools/delete_branch/approve`, { sideEffect: 'destructive', confirm: 'always', label: 'confidential' }).expect(200);
    return reg;
  }

  const view = async (c: { agent: { get: (p: string) => { expect: (n: number) => Promise<{ body: Record<string, unknown> }> } } }, id: string) => (await c.agent.get(`/api/runs/${id}`).expect(200)).body as { state: string; steps: Step[]; output: string | null; error: string | null; usage: Record<string, number>; checkpoints: number[]; lanes: Record<string, Record<string, number>>; budgets: Record<string, number>; replayOf: string | null };

  it('runs think, calc and think steps with checkpoints, pushed live to the owner', async () => {
    await publishAgent(['calculate']);
    ollama.reply = (messages) => {
      const last = messages[messages.length - 1]!;
      if (last.role === 'tool') return { content: `The overrun is ${JSON.parse(last.content).decimal}.` };
      return { content: 'I will compute it.', toolCall: { name: 'calculate', arguments: { expression: '(412880 - 361500) / 361500 * 100' } } };
    };
    const m = await member();
    const server: Server = createServer(h.app);
    attachRealtime(server, h.s);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const sock: Socket = ioClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { path: '/socket.io', transports: ['websocket'], reconnection: false, extraHeaders: { cookie: m.cookie } });
    try {
      await new Promise((r) => sock.on('ready', r));
      const live: { event: string; data: Record<string, unknown> }[] = [];
      for (const e of ['run.step', 'run.state']) sock.on(e, (data: Record<string, unknown>) => live.push({ event: e, data }));

      expect((await m.agent.get('/api/agents').expect(200)).body).toEqual([expect.objectContaining({ name: 'Data analyst', profile: 'general', tools: ['calculate'] })]);
      const run = (await m.post('/api/runs', { agent: 'Data analyst', input: 'How far over budget is travel?', label: 'confidential' }).expect(202)).body;
      expect(run).toMatchObject({ state: 'queued', agent: 'Data analyst', label: 'confidential', budgets: { steps: 20 } });
      await h.s.jobs.runDue();
      const v = await view(m, run.id);
      expect(v.state).toBe('succeeded');
      expect(v.output).toMatch(/^The overrun is 14\.2130013831/);
      expect(v.steps.map((s) => [s.n, s.lane, s.title, s.state])).toEqual([[1, 'think', 'Plan', 'ok'], [2, 'calc', 'calculate', 'ok'], [3, 'think', 'Answer', 'ok']]);
      expect(v.steps[0]!.meta).toMatchObject({ profile: 'general', model: 'llama3.1:8b', proposal: ['calculate'] });
      expect(v.steps[1]!.detail).toMatchObject({ arguments: { expression: '(412880 - 361500) / 361500 * 100' }, result: { exact: false } });
      expect(v.checkpoints).toEqual([0, 1, 2, 3]);
      expect(v.usage).toMatchObject({ steps: 3, toolCalls: 1, calcCalls: 1 });
      expect(v.usage.tokens).toBeGreaterThan(0);
      expect(v.lanes).toMatchObject({ think: { steps: 2 }, calc: { results: 1 } });
      // The model got the system prompt, then the calculator's result as a tool message.
      const second = ollama.requests.filter((r) => r.path === '/api/chat')[1]!.body.messages as { role: string; content: string }[];
      expect(second.map((x) => x.role)).toEqual(['system', 'user', 'assistant', 'tool']);
      // Sealed at rest.
      const raw = await h.s.db('agent_steps').where({ n: 3 }).first();
      expect(raw.detail).toMatch(/^v2\./);
      expect((await h.s.db('agent_runs').where({ id: run.id }).first()).output).not.toContain('overrun');
      const usage = await h.s.db('usage_records').where({ kind: 'agent' });
      expect(usage).toHaveLength(2);
      for (let i = 0; i < 50 && !live.some((e) => e.event === 'run.state' && e.data.state === 'succeeded'); i++) await new Promise((r) => setTimeout(r, 10));
      expect(live.filter((e) => e.event === 'run.step').map((e) => e.data.n)).toEqual([1, 2, 3]);
      expect(live.filter((e) => e.event === 'run.state').map((e) => e.data.state)).toEqual(['queued', 'running', 'succeeded']);
    } finally {
      sock.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });

  it('pauses write calls for approval, continues after it, and returns a rejection to the model as data', async () => {
    const ta = await admin('approver');
    await registerJira(ta);
    await publishAgent(['jira.create_issue', 'jira.delete_branch']);
    ollama.reply = (messages) => {
      const last = messages[messages.length - 1]!;
      if (last.role === 'tool') return { content: `Result: ${last.content}` };
      if (last.content.includes('delete')) return { content: '', toolCall: { name: 'jira_delete_branch', arguments: { branch: 'old' } } };
      return { content: '', toolCall: { name: 'jira_create_issue', arguments: { summary: 'Q3 variance review' } } };
    };
    const m = await member();
    const run = (await m.post('/api/runs', { agent: 'Data analyst', input: 'File the review issue.', label: 'internal' }).expect(202)).body;
    await h.s.jobs.runDue();
    let v = await view(m, run.id);
    expect(v.state).toBe('waiting');
    expect(v.steps.map((s) => [s.lane, s.title, s.state])).toEqual([['think', 'Plan', 'ok'], ['do', 'jira.create_issue', 'waiting']]);
    expect(v.steps[1]!.meta).toMatchObject({ sideEffect: 'write', approvers: 'the run\'s owner or a tool admin' });
    expect(mcp.calls).toHaveLength(0);
    const owner = (await h.s.users.byUsername(h.tenantId, 'mem'))!;
    expect((await h.s.notifications.list(owner.id)).some((n) => /waiting on approval/.test(n.title))).toBe(true);
    // Tool admins see the waiting run.
    expect((await ta.agent.get('/api/runs?state=waiting').expect(200)).body.map((r: { id: string }) => r.id)).toEqual([run.id]);

    // The owner confirms the write call; the run continues from the checkpoint.
    await m.post(`/api/runs/${run.id}/steps/2/decision`, { decision: 'approve' }).expect(200);
    await m.post(`/api/runs/${run.id}/steps/2/decision`, { decision: 'approve' }).expect(409);
    await h.s.jobs.runDue();
    v = await view(m, run.id);
    expect(v.state).toBe('succeeded');
    expect(v.steps.map((s) => [s.n, s.lane, s.state])).toEqual([[1, 'think', 'ok'], [2, 'do', 'ok'], [3, 'think', 'ok']]);
    expect(v.steps[1]!.meta.approval).toMatchObject({ decision: 'approved', by: 'MEM' });
    expect(v.output).toBe('Result: {"key":"FIN-1188"}');
    expect(mcp.calls).toEqual([expect.objectContaining({ name: 'create_issue', arguments: { summary: 'Q3 variance review' } })]);
    expect(v.usage).toMatchObject({ steps: 3, toolCalls: 1 });

    // A destructive call: the owner cannot approve it; a tool admin rejects it, and the model hears why.
    const run2 = (await m.post('/api/runs', { agent: 'Data analyst', input: 'Please delete the old branch.', label: 'internal' }).expect(202)).body;
    await h.s.jobs.runDue();
    const own = await m.post(`/api/runs/${run2.id}/steps/2/decision`, { decision: 'approve' }).expect(403);
    expect(own.body.step).toBe('dual-control');
    await ta.post(`/api/runs/${run2.id}/steps/2/decision`, { decision: 'reject', note: 'Branches are kept for audit.' }).expect(200);
    await h.s.jobs.runDue();
    v = await view(m, run2.id);
    expect(v.state).toBe('succeeded');
    expect(v.steps[1]).toMatchObject({ state: 'rejected', detail: { error: 'Rejected by APPROVER: Branches are kept for audit.. Nothing was run.' } });
    expect(mcp.calls.map((c) => c.name)).toEqual(['create_issue']);
    expect((await h.s.audit.list(h.tenantId, { action: 'agent.call.' })).map((e) => e.action).sort()).toEqual(['agent.call.approved', 'agent.call.rejected']);
  });

  it('applies the tool-call guardrail: a block is returned as data, a hold waits for approval', async () => {
    await publishAgent(['calculate']);
    let n = 0;
    ollama.reply = (messages) => {
      const last = messages[messages.length - 1]!;
      if (last.role === 'tool') return { content: `Tool said ${last.content}` };
      return { content: '', toolCall: { name: 'calculate', arguments: { expression: `${++n} + 1` } } };
    };
    const metas: Record<string, unknown>[] = [];
    h.s.guardrails = { check: async (i) => (i.checkpoint === 'tool-call' ? (metas.push(i.meta ?? {}), i.text.includes('"1 + 1"') ? { action: 'block', text: i.text, findings: [], reason: 'No additions.' } : { action: 'require-approval', text: i.text, findings: [], reason: 'Held for review.' }) : { action: 'allow', text: i.text, findings: [] }) };
    const m = await member();
    const r1 = (await m.post('/api/runs', { agent: 'Data analyst', input: 'Add.' }).expect(202)).body;
    await h.s.jobs.runDue();
    let v = await view(m, r1.id);
    expect(v.state).toBe('succeeded');
    expect(v.steps[1]).toMatchObject({ lane: 'calc', state: 'denied', detail: { error: 'Blocked by the tool-call guardrail: No additions.' } });
    expect(metas[0]).toMatchObject({ tool: 'calculate', sideEffect: 'read', toolLabel: 'restricted' });
    const r2 = (await m.post('/api/runs', { agent: 'Data analyst', input: 'Add again.' }).expect(202)).body;
    await h.s.jobs.runDue();
    v = await view(m, r2.id);
    expect(v.state).toBe('waiting');
    await m.post(`/api/runs/${r2.id}/steps/2/decision`, { decision: 'approve' }).expect(200);
    await h.s.jobs.runDue();
    v = await view(m, r2.id);
    expect(v.state).toBe('succeeded');
    expect(v.steps[1]).toMatchObject({ lane: 'calc', state: 'ok' });
  });

  it('stops at its budget, resumes with a raised limit, and replays from a checkpoint as a new run', async () => {
    await publishAgent(['calculate'], { steps: 4, tokens: 100000, wallSeconds: 120, toolCalls: 20 });
    let loop = true;
    ollama.reply = (messages) => {
      const last = messages[messages.length - 1]!;
      if (!loop && last.role === 'tool') return { content: 'Done.' };
      return { content: '', toolCall: { name: 'calculate', arguments: { expression: '2 * 21' } } };
    };
    const m = await member();
    const run = (await m.post('/api/runs', { agent: 'Data analyst', input: 'Loop.' }).expect(202)).body;
    await h.s.jobs.runDue();
    let v = await view(m, run.id);
    expect(v.state).toBe('budget');
    expect(v.error).toBe('Stopped at 4 of 4 steps.');
    expect(v.steps).toHaveLength(4);
    await m.post(`/api/runs/${run.id}/resume`, { budgets: { steps: 4 } }).expect(409);
    const raised = (await m.post(`/api/runs/${run.id}/resume`, { budgets: { steps: 6 } }).expect(200)).body;
    expect(raised.budgets.steps).toBe(6);
    await h.s.jobs.runDue();
    v = await view(m, run.id);
    expect(v.state).toBe('budget');
    expect(v.steps).toHaveLength(6);
    expect(v.checkpoints).toEqual([0, 1, 2, 3, 4, 5, 6]);

    // Replay from step 3: steps 1 and 2 are reused, the rest runs again.
    loop = false;
    const replay = (await m.post(`/api/runs/${run.id}/replay`, { fromStep: 3 }).expect(202)).body;
    expect(replay).toMatchObject({ replayOf: run.id, replayFrom: 3, state: 'queued' });
    await h.s.jobs.runDue();
    const rv = await view(m, replay.id);
    expect(rv.state).toBe('succeeded');
    expect(rv.steps.map((s) => [s.n, s.lane, !!s.meta.reused])).toEqual([[1, 'think', true], [2, 'calc', true], [3, 'think', false]]);
    expect(rv.output).toBe('Done.');
    expect(rv.budgets.steps).toBe(6);
  });

  it('cancels a run, keeps other people\'s runs private, and refuses runs above the agent\'s ceiling', async () => {
    await publishAgent(['calculate']);
    const m = await member();
    const run = (await m.post('/api/runs', { agent: 'Data analyst', input: 'Hi.' }).expect(202)).body;
    const other = await member('other');
    await other.agent.get(`/api/runs/${run.id}`).expect(404);
    await other.post(`/api/runs/${run.id}/cancel`).expect(404);
    expect((await other.agent.get('/api/runs').expect(200)).body).toEqual([]);
    expect((await m.post(`/api/runs/${run.id}/cancel`).expect(200)).body.state).toBe('cancelled');
    await h.s.jobs.runDue();
    expect((await view(m, run.id)).state).toBe('cancelled');
    await m.post(`/api/runs/${run.id}/cancel`).expect(409);
    // Running: a cancel aborts the model call.
    let release!: () => void;
    ollama.hold = new Promise<void>((r) => (release = r));
    const run2 = (await m.post('/api/runs', { agent: 'Data analyst', input: 'Hi.' }).expect(202)).body;
    const worker = h.s.jobs.runDue();
    for (let i = 0; i < 100 && (await view(m, run2.id)).state !== 'running'; i++) await new Promise((r) => setTimeout(r, 10));
    await m.post(`/api/runs/${run2.id}/cancel`).expect(200);
    release();
    await worker;
    expect((await view(m, run2.id)).state).toBe('cancelled');
    const job = await h.s.jobs.get(h.tenantId, (await h.s.db('agent_runs').where({ id: run2.id }).first()).job_id);
    expect(job?.state).toBe('cancelled');

    await m.post('/api/runs', { agent: 'Data analyst', input: 'x', label: 'restricted' }).expect(403);
    await m.post('/api/runs', { agent: 'Nobody', input: 'x' }).expect(404);
  });
});
