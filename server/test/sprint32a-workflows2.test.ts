/*
 * Sprint 32a: the chain context (B-4101), the sub-workflow step (B-3901), the agent step and skills on model steps
 * (B-3902), and map and loop steps (B-3905).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ChainLimit, ChainService } from '../src/chain/context.js';
import type { WfGraph, WfNode } from '../src/workflows/graph.js';
import { FakeMcp } from './fake-mcp.js';
import { FakeOllama } from './fake-ollama.js';
import { seedGateway } from './seed-gateway.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

const TOPIC = { type: 'object' as const, properties: { topic: { type: 'string' as const } }, required: ['topic'] };
const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);
const put = (c: Client, url: string, body: object) => c.agent.put(url).set('x-csrf-token', c.csrf).send(body);
const trigger = (output: WfNode['output'] = TOPIC): WfNode => ({ id: 'trigger', kind: 'trigger', title: 'Trigger', x: 20, y: 24, config: { source: 'api' }, ...(output ? { output } : {}) });
const node = (id: string, kind: string, config: Record<string, unknown>, extra: Partial<WfNode> = {}): WfNode => ({ id, kind: kind as WfNode['kind'], title: id, x: 20, y: 24, config, ...extra });
const chainOf = (nodes: WfNode[], extraEdges: WfGraph['edges'] = []): WfGraph => ({ nodes, edges: [...nodes.slice(1).map((n, i) => ({ from: nodes[i]!.id, to: n.id })), ...extraEdges], limits: {} });

async function drain(h: Harness, rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) if (!(await h.s.jobs.runDue())) break;
}

async function workflow(admin: Client, name: string, g: WfGraph, label = 'internal'): Promise<{ id: string; publish: { status: number; body: Record<string, unknown> } }> {
  const w = (await post(admin, '/api/workflows', { name, label }).expect(201)).body;
  await put(admin, `/api/workflows/${w.id}/draft`, { graph: g }).expect(200);
  const r = await post(admin, `/api/workflows/${w.id}/publish`);
  return { id: w.id, publish: { status: r.status, body: r.body } };
}

describe('B-4101: the chain context', () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it('caps depth across kinds and per kind, keeps the principal, raises the label and answers alike on every instance', async () => {
    h = await harness({ CHAIN_MAX_DEPTH: '4', WORKFLOW_MAX_DEPTH: '2' });
    const c = h.s.chains;
    const root = await c.begin(h.tenantId, { kind: 'agent-run', ref: 'R1', callee: 'Planner', principal: 'U1', label: 'internal', budgets: { tokens: 1000, steps: 10 } });
    expect(root).toMatchObject({ depth: 0, root: root.node, parent: null, resumed: false });
    // A retried job begins the same invocation again and gets the node it had.
    expect(await c.begin(h.tenantId, { kind: 'agent-run', ref: 'R1', principal: 'U1', label: 'internal' })).toMatchObject({ node: root.node, resumed: true });
    await expect(c.begin(h.tenantId, { kind: 'tool-call', principal: 'U2', label: 'internal', parent: root })).rejects.toMatchObject({ code: 'principal' });
    const w1 = await c.begin(h.tenantId, { kind: 'workflow-run', ref: 'W1', callee: 'a', principal: 'U1', label: 'confidential', parent: root });
    expect(await c.label(root)).toBe('confidential');
    // The label only rises: a child asking for less gets the chain's mark.
    const w2 = await c.begin(h.tenantId, { kind: 'workflow-run', ref: 'W2', callee: 'b', principal: 'U1', label: 'public', parent: w1 });
    expect(w2.label).toBe('confidential');
    const err = await c.begin(h.tenantId, { kind: 'workflow-run', ref: 'W3', callee: 'c', principal: 'U1', label: 'internal', parent: w2 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainLimit);
    expect(err).toMatchObject({ code: 'kind-depth', message: expect.stringMatching(/WORKFLOW_MAX_DEPTH is 2/) });
    const t3 = await c.begin(h.tenantId, { kind: 'tool-call', principal: 'U1', label: 'internal', parent: w2 });
    const t4 = await c.begin(h.tenantId, { kind: 'skill-load', principal: 'U1', label: 'internal', parent: t3 });
    expect(t4.depth).toBe(4);
    await expect(c.begin(h.tenantId, { kind: 'tool-call', principal: 'U1', label: 'internal', parent: t4 })).rejects.toMatchObject({ code: 'depth', message: expect.stringMatching(/CHAIN_MAX_DEPTH is 4/) });

    // Usage anywhere in the chain is charged to the root's budgets.
    await c.charge(t3, { tokens: 600, steps: 2 });
    expect((await c.charge(w2, { tokens: 500 })).exceeded).toMatch(/1,100 of its root's 1,000 tokens/);
    const other = new ChainService(h.s.db, c.limits); // a second instance reading the same database
    expect(await other.check(w1)).toMatch(/root's budget/);
    await expect(other.begin(h.tenantId, { kind: 'tool-call', principal: 'U1', label: 'internal', parent: w1 })).rejects.toMatchObject({ code: 'stopped' });
    const v = (await c.view(h.tenantId, root.chain))!;
    expect(v).toMatchObject({ state: 'stopped', label: 'confidential', used: { tokens: 1100, steps: 2 }, budgets: { tokens: 1000, steps: 10 } });
    expect(v.nodes.map((n) => [n.kind, n.depth])).toEqual([['agent-run', 0], ['workflow-run', 1], ['workflow-run', 2], ['tool-call', 3], ['skill-load', 4]]);
    // Only the root may raise the budgets; then the chain runs again.
    expect(await c.rebudget(w1, { tokens: 5000 })).toBe(false);
    expect(await c.rebudget(root, { tokens: 5000 })).toBe(true);
    expect(await c.check(w1)).toBeNull();
  });
});

describe('Sprint 32a: chained agents and workflows', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let mcp: FakeMcp | null = null;
  afterEach(async () => {
    await h.close();
    await ollama.stop();
    await mcp?.stop();
    mcp = null;
  });

  async function setup(env: Record<string, string> = {}) {
    h = await harness({ OLLAMA_POLL_MS: '600000', MCP_TIMEOUT_MS: '5000', ...env });
    ollama = await new FakeOllama().start();
    ollama.chatDelayMs = 0;
    await seedGateway(h, ollama);
    await localUser(h, 'wadmin', ['workflow-admin', 'member'], 'confidential');
    await localUser(h, 'tadmin', ['tool-admin', 'agent-admin'], 'confidential');
    await localUser(h, 'tadmin2', ['tool-admin', 'agent-admin'], 'confidential');
    return { admin: await loginAdmin(h, 'wadmin'), t: await loginAdmin(h, 'tadmin'), t2: await loginAdmin(h, 'tadmin2') };
  }

  async function publishEntry(t: Client, t2: Client, body: Record<string, unknown>) {
    const e = (await post(t, '/api/admin/registry', body).expect(201)).body;
    await post(t, `/api/admin/registry/${e.id}/submit`).expect(200);
    await post(t2, `/api/admin/registry/${e.id}/review`, { decision: 'approve' }).expect(200);
    return e;
  }

  const agentBody = (name: string, systemPrompt: string, tools: string[], budgets = { steps: 20, tokens: 10_000, wallSeconds: 600, toolCalls: 8 }) => ({ kind: 'agent', name, version: '1.0.0', description: `${name}: answers with the tools it lists and reports the result plainly.`, label: 'confidential', definition: { profile: 'general', systemPrompt, tools, budgets } });

  /** agent (Planner) → workflow.delegate (tool) → workflow run → agent step (Calculator) → calculate. */
  async function mixedChain(c: Awaited<ReturnType<typeof setup>>, outerBudgets?: { steps: number; tokens: number; wallSeconds: number; toolCalls: number }) {
    await publishEntry(c.t, c.t2, agentBody('Calculator', 'Inner.', ['calculate']));
    const w = await workflow(c.admin, 'delegate', chainOf([trigger(), node('ask', 'agent', { agent: 'Calculator', input: 'Compute {{input.topic}}' })]));
    expect(w.publish.status).toBe(200);
    const entry = (await post(c.admin, `/api/workflows/${w.id}/tool`, { name: 'workflow.delegate', description: 'Hands a calculation to the calculator agent and returns what it answered.' }).expect(201)).body;
    await post(c.t, `/api/admin/registry/${entry.id}/review`, { decision: 'approve' }).expect(200);
    await publishEntry(c.t, c.t2, agentBody('Planner', 'Outer.', ['workflow.delegate'], outerBudgets));
    ollama.reply = (messages) => {
      const outer = messages[0]!.content.startsWith('Outer.');
      const last = messages[messages.length - 1]!;
      if (last.role === 'tool') return { content: `${outer ? 'Planner' : 'Calculator'} got ${last.content}` };
      return outer ? { content: 'Delegating.', toolCall: { name: 'workflow_delegate', arguments: { topic: '2+2' } } } : { content: 'Calculating.', toolCall: { name: 'calculate', arguments: { expression: '2+2' } } };
    };
    await localUser(h, 'mem', ['member'], 'confidential');
    const m = await login(h, 'mem');
    const run = (await post(m, '/api/runs', { agent: 'Planner', input: 'What is 2+2?', label: 'internal' }).expect(202)).body;
    await drain(h);
    return { m, run, workflowId: w.id };
  }

  it('a mixed chain (agent → workflow → agent → tool) stops at the depth limit', async () => {
    const c = await setup({ CHAIN_MAX_DEPTH: '3' });
    const { m, run } = await mixedChain(c);
    const outer = (await m.agent.get(`/api/runs/${run.id}`).expect(200)).body;
    expect(outer.state).toBe('succeeded');
    const chain = (await h.s.chains.view(h.tenantId, outer.chain.id))!;
    expect(chain.nodes.map((n) => [n.kind, n.depth, n.state])).toEqual([
      ['agent-run', 0, 'succeeded'],
      ['tool-call', 1, 'succeeded'],
      ['workflow-run', 2, 'succeeded'],
      ['agent-run', 3, 'succeeded'],
      ['tool-call', 4, 'refused']
    ]);
    expect(chain.nodes[4]!.error).toMatch(/CHAIN_MAX_DEPTH is 3/);
    const inner = (await h.s.db('agent_runs').where({ agent_name: 'Calculator' }).first()) as { id: string; chain_id: string; caller_kind: string };
    expect(inner).toMatchObject({ chain_id: outer.chain.id, caller_kind: 'workflow-run' });
    const iv = (await c.t.agent.get(`/api/runs/${inner.id}`).expect(200)).body;
    expect(iv.steps[1]).toMatchObject({ title: 'calculate', state: 'denied', detail: { error: expect.stringMatching(/^chain_limit: .*CHAIN_MAX_DEPTH/) } });
    // The calculator never ran: its answer reached the planner through the workflow.
    expect(outer.output).toMatch(/Planner got .*chain_limit/);
    // Every node is the same principal's.
    expect(new Set(chain.nodes.map(() => chain.principal)).size).toBe(1);
  });

  it('the same chain stops at the root agent\'s budget, whatever depth it is at', async () => {
    const c = await setup();
    const { m, run } = await mixedChain(c, { steps: 3, tokens: 10_000, wallSeconds: 600, toolCalls: 4 });
    const outer = (await m.agent.get(`/api/runs/${run.id}`).expect(200)).body;
    expect(outer.state).toBe('budget');
    expect(outer.error).toMatch(/root's budget: the chain took \d+ of its root's 3 steps/);
    const inner = (await h.s.db('agent_runs').where({ agent_name: 'Calculator' }).first()) as { state: string; error: string };
    expect(inner.state).toBe('budget');
    expect(inner.error).toMatch(/root's budget/);
    const wr = (await h.s.db('workflow_runs').first()) as { state: string; error: string };
    expect(wr).toMatchObject({ state: 'failed', error: expect.stringMatching(/root's budget/) });
    const chain = (await h.s.chains.view(h.tenantId, outer.chain.id))!;
    expect(chain.state).toBe('stopped');
    expect(chain.used.steps).toBeGreaterThanOrEqual(3);
  });

  it('B-3901: a parent run resumes with the child\'s output after the child\'s approval is decided', async () => {
    const c = await setup();
    const child = await workflow(c.admin, 'child-notes', chainOf([trigger(), node('ok', 'approval', { role: 'workflow-admin', timeoutMs: 3_600_000, show: 'Notes on {{input.topic}}' }), node('shape', 'transform', { fields: { summary: 'Approved notes on {{input.topic}}' } })]), 'confidential');
    expect(child.publish.status).toBe(200);
    // Publish checks: unknown workflows, itself, and an input that does not fit the child's trigger.
    const bad = await workflow(c.admin, 'bad-parent', chainOf([trigger(), node('sub', 'sub', { workflow: 'nope' }), node('me', 'sub', { workflow: 'bad-parent' }), node('wrong', 'sub', { workflow: 'child-notes', input: { other: '{{input.topic}}' } })]));
    expect(bad.publish.status).toBe(422);
    const codes = (bad.publish.body.errors as { code: string; nodeId: string }[]).map((e) => [e.nodeId, e.code]);
    expect(codes).toEqual(expect.arrayContaining([['sub', 'unavailable'], ['me', 'config'], ['wrong', 'schema']]));

    const parent = await workflow(c.admin, 'parent', chainOf([trigger(), node('notes', 'sub', { workflow: 'child-notes', input: { topic: '{{input.topic}}' } }), node('out', 'transform', { fields: { text: 'Parent saw {{steps.notes.output.summary}}' } })]));
    expect(parent.publish.status).toBe(200);
    const started = (await post(c.admin, `/api/workflows/${parent.id}/runs`, { input: { topic: 'budgets' } }).expect(202)).body;
    await drain(h);
    let v = (await c.admin.agent.get(`/api/workflow-runs/${started.id}`).expect(200)).body;
    expect(v.state).toBe('waiting');
    expect(v.steps.find((s: { nodeId: string }) => s.nodeId === 'notes')).toMatchObject({ state: 'waiting', detail: { child: expect.any(String) } });
    const childRunId = v.children[0].id as string;
    expect(v.children).toEqual([expect.objectContaining({ kind: 'workflow-run', workflowId: child.id, step: 'notes', state: 'waiting', label: 'confidential' })]);
    const cr = await h.s.db('workflow_runs').where({ id: childRunId }).first();
    expect(cr).toMatchObject({ caller_kind: 'workflow-run', caller_id: started.id, caller_node: 'notes', created_by: (await h.s.users.byUsername(h.tenantId, 'wadmin'))!.id, chain_id: v.chain.id, trigger: `workflow:${started.id}` });

    const [a] = (await c.admin.agent.get('/api/workflow-approvals').expect(200)).body;
    expect(a.runId).toBe(childRunId);
    await post(c.admin, `/api/workflow-approvals/${a.id}`, { decision: 'approve' }).expect(200);
    await drain(h);
    v = (await c.admin.agent.get(`/api/workflow-runs/${started.id}`).expect(200)).body;
    expect(v.state).toBe('succeeded');
    const notes = v.steps.find((s: { nodeId: string }) => s.nodeId === 'notes');
    expect(notes).toMatchObject({ state: 'passed', label: 'confidential', output: { run: childRunId, output: { summary: 'Approved notes on budgets' } } });
    expect(v.steps.find((s: { nodeId: string }) => s.nodeId === 'out').output).toEqual({ text: 'Parent saw Approved notes on budgets' });
    // The child sits under the parent in one chain, and its start is audited with the parent.
    const chain = (await h.s.chains.view(h.tenantId, v.chain.id))!;
    expect(chain.nodes.map((n) => [n.kind, n.depth, n.state])).toEqual([['workflow-run', 0, 'succeeded'], ['workflow-run', 1, 'succeeded']]);
    expect(chain.label).toBe('confidential');
    const audit = await h.s.db('audit_events').where({ action: 'workflow.run.started' });
    expect(audit.some((e: { detail: string }) => JSON.parse(e.detail).parentRun === started.id)).toBe(true);
  });

  it('B-3901: cancelling a parent cancels the child it waits on; nesting stops at WORKFLOW_MAX_DEPTH', async () => {
    const c = await setup({ WORKFLOW_MAX_DEPTH: '2' });
    await workflow(c.admin, 'gate', chainOf([trigger(), node('ok', 'approval', { role: 'workflow-admin' })]));
    await workflow(c.admin, 'middle', chainOf([trigger(), node('g', 'sub', { workflow: 'gate' })]));
    const top = await workflow(c.admin, 'top', chainOf([trigger(), node('m', 'sub', { workflow: 'middle' })]));
    expect(top.publish.status).toBe(200);
    const started = (await post(c.admin, `/api/workflows/${top.id}/runs`, { input: { topic: 'x' } }).expect(202)).body;
    await drain(h);
    const v = (await c.admin.agent.get(`/api/workflow-runs/${started.id}`).expect(200)).body;
    // top (1) → middle (2) → gate would be the third nested workflow run.
    expect(v.state).toBe('failed');
    expect(v.error).toMatch(/WORKFLOW_MAX_DEPTH is 2/);

    const mid = await workflow(c.admin, 'top2', chainOf([trigger(), node('g', 'sub', { workflow: 'gate' })]));
    const r2 = (await post(c.admin, `/api/workflows/${mid.id}/runs`, { input: { topic: 'x' } }).expect(202)).body;
    await drain(h);
    const kid = ((await c.admin.agent.get(`/api/workflow-runs/${r2.id}`).expect(200)).body.children[0]) as { id: string; state: string };
    expect(kid.state).toBe('waiting');
    await post(c.admin, `/api/workflow-runs/${r2.id}/cancel`).expect(200);
    expect((await h.s.db('workflow_runs').where({ id: kid.id }).first()).state).toBe('cancelled');
    expect((await h.s.db('workflow_approvals').where({ run_id: kid.id }).first()).state).toBe('expired');
  });

  it('B-3902: an agent step runs a registry agent within its budgets and the run resumes with its answer', async () => {
    const c = await setup();
    await publishEntry(c.t, c.t2, agentBody('Summariser', 'Summarise.', [], { steps: 4, tokens: 5000, wallSeconds: 60, toolCalls: 0 }));
    const bad = await workflow(c.admin, 'bad-agent', chainOf([trigger(), node('a', 'agent', { agent: 'Nobody' })]));
    expect(bad.publish.status).toBe(422);
    expect((bad.publish.body.errors as { code: string }[])[0]!.code).toBe('unavailable');
    ollama.reply = (messages) => ({ content: `Summary of ${messages[messages.length - 1]!.content}` });
    const w = await workflow(c.admin, 'summarise', chainOf([trigger(), node('a', 'agent', { agent: 'Summariser', input: 'the topic {{input.topic}}', budgets: { steps: 2 } }), node('out', 'transform', { fields: { text: '{{steps.a.text}}' } })]));
    expect(w.publish.status).toBe(200);
    const started = (await post(c.admin, `/api/workflows/${w.id}/runs`, { input: { topic: 'travel' } }).expect(202)).body;
    await drain(h);
    const v = (await c.admin.agent.get(`/api/workflow-runs/${started.id}`).expect(200)).body;
    expect(v.state).toBe('succeeded');
    const step = v.steps.find((s: { nodeId: string }) => s.nodeId === 'a');
    expect(step.output).toMatchObject({ run: expect.any(String), text: 'Summary of the topic travel' });
    const ar = (await c.admin.agent.get(`/api/runs/${step.output.run}`).expect(200)).body;
    expect(ar).toMatchObject({ state: 'succeeded', budgets: { steps: 2 }, caller: { kind: 'workflow-run', id: started.id, node: 'a' }, chain: { id: v.chain.id } });
    expect(v.children).toEqual([expect.objectContaining({ kind: 'agent-run', agent: 'Summariser', step: 'a', state: 'succeeded' })]);
  });

  it('B-3902: a model step with a skill calls one of the skill\'s tools through the tool-call checkpoint', async () => {
    const c = await setup();
    await publishEntry(c.t, c.t2, { kind: 'skill', name: 'variance-analysis', version: '1.0.0', description: 'Explains budget variances by cost centre, with the arithmetic done by the calculator.', label: 'confidential', definition: { instructions: 'Compute actual minus budget with the calculator.', tools: ['calculate'] } });
    const checks: { checkpoint: string; source?: { kind: string }; text: string }[] = [];
    const real = h.s.guardrails;
    h.s.guardrails = { check: async (i) => (checks.push({ checkpoint: i.checkpoint, ...(i.source ? { source: i.source } : {}), text: i.text }), real.check(i)) };
    ollama.reply = (messages) => {
      const last = messages[messages.length - 1]!;
      if (last.role === 'tool') return { content: `The variance is ${JSON.parse(last.content).decimal}.` };
      return { content: '', toolCall: { name: 'calculate', arguments: { expression: '412880 - 361500' } } };
    };
    const missing = await workflow(c.admin, 'no-skill', chainOf([trigger(), node('m', 'model', { profile: 'general', prompt: 'x', skills: ['nope'] })]));
    expect((missing.publish.body.errors as { code: string }[])[0]).toMatchObject({ code: 'unavailable', message: expect.stringMatching(/skill nope/) });
    const w = await workflow(c.admin, 'variance', chainOf([trigger(), node('m', 'model', { profile: 'general', prompt: 'Explain the variance for {{input.topic}}.', skills: ['variance-analysis'] })]));
    expect(w.publish.status).toBe(200);
    const callees = (await c.admin.agent.get('/api/workflow-callees').expect(200)).body;
    expect(callees.skills).toEqual([expect.objectContaining({ name: 'variance-analysis', tools: ['calculate'] })]);
    expect(callees.workflows.map((x: { name: string }) => x.name)).toContain('variance');
    expect(callees.limits).toMatchObject({ chainMaxDepth: 8, workflowMaxDepth: 3, maxItems: 200, maxParallel: 20 });
    const started = (await post(c.admin, `/api/workflows/${w.id}/runs`, { input: { topic: 'travel' } }).expect(202)).body;
    await drain(h);
    const v = (await c.admin.agent.get(`/api/workflow-runs/${started.id}`).expect(200)).body;
    expect(v.state).toBe('succeeded');
    const m = v.steps.find((s: { nodeId: string }) => s.nodeId === 'm');
    expect(m.output).toEqual({ text: 'The variance is 51380.' });
    expect(m.detail).toMatchObject({ skills: [{ name: 'variance-analysis', version: '1.0.0' }], tools: ['calculate'], toolCalls: [{ tool: 'calculate', ok: true }] });
    expect(checks.some((x) => x.checkpoint === 'tool-call' && x.source?.kind === 'workflow-step' && x.text.includes('412880 - 361500'))).toBe(true);
    // The skill's instructions reached the model.
    const sys = (ollama.requests.filter((r) => r.path === '/api/chat')[0]!.body.messages as { role: string; content: string }[]).find((x) => x.role === 'system');
    expect(sys?.content).toMatch(/Skill variance-analysis 1\.0\.0:\nCompute actual minus budget/);
    const chain = (await h.s.chains.view(h.tenantId, v.chain.id))!;
    expect(chain.nodes.map((n) => n.kind)).toEqual(['workflow-run', 'skill-load', 'tool-call']);
  });

  it('B-3905: a map over 200 items runs 20 at a time, and a run cannot fan out further', async () => {
    const c = await setup();
    mcp = await new FakeMcp().start();
    mcp.callDelayMs = 40;
    mcp.tools = [{ name: 'lookup', description: 'Looks an item up.', inputSchema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] }, run: (a) => ({ value: Number(a.n) * 2 }) }];
    const reg = (await post(c.t, '/api/admin/mcp-servers', { name: 'kb', url: mcp.url }).expect(201)).body;
    await post(c.t, `/api/admin/mcp-servers/${reg.id}/tools/lookup/approve`, { sideEffect: 'read', confirm: 'never', label: 'confidential' }).expect(200);
    const LIST = { type: 'object' as const, properties: { items: { type: 'array' as const, items: { type: 'integer' as const } } }, required: ['items'] };
    const over = await workflow(c.admin, 'too-wide', chainOf([trigger(LIST), node('a', 'map', { over: '{{input.items}}', tool: 'kb.lookup', args: { n: '{{item}}' }, maxItems: 150 }), node('b', 'map', { over: '{{input.items}}', tool: 'kb.lookup', args: { n: '{{item}}' }, maxItems: 100 })]));
    expect(over.publish.status).toBe(422);
    expect((over.publish.body.errors as { code: string; message: string }[])[0]).toMatchObject({ code: 'limit', message: expect.stringMatching(/up to 250 items/) });
    const w = await workflow(c.admin, 'wide', chainOf([trigger(LIST), node('each', 'map', { over: '{{input.items}}', tool: 'kb.lookup', args: { n: '{{item}}' }, maxParallel: 20, as: 'values' })]));
    expect(w.publish.status).toBe(200);
    const items = Array.from({ length: 200 }, (_, i) => i);
    const started = (await post(c.admin, `/api/workflows/${w.id}/runs`, { input: { items } }).expect(202)).body;
    await drain(h);
    const v = (await c.admin.agent.get(`/api/workflow-runs/${started.id}`).expect(200)).body;
    expect(v.state).toBe('succeeded');
    const each = v.steps.find((s: { nodeId: string }) => s.nodeId === 'each');
    expect(each.output.count).toBe(200);
    expect(each.output.values[7]).toEqual({ value: 14 });
    expect(each.detail).toMatchObject({ items: 200, maxParallel: 20, peak: 20, ran: 200 });
    expect(mcp.peak).toBe(20);
    expect(mcp.calls).toHaveLength(200);
    expect(v.items).toHaveLength(200);
    // Every item is a step of the chain (with the trigger and the map step itself).
    expect((await h.s.chains.view(h.tenantId, v.chain.id))!.used.steps).toBe(202);
    const big = (await post(c.admin, `/api/workflows/${w.id}/runs`, { input: { items: [...items, 200] } }).expect(202)).body;
    await drain(h);
    expect((await c.admin.agent.get(`/api/workflow-runs/${big.id}`).expect(200)).body.error).toMatch(/201 items; this map takes at most 200/);
  });

  it('B-3905: a loop stops at its cap or when its condition fails, and its iterations count toward the step limit', async () => {
    const c = await setup();
    const tooLong = await workflow(c.admin, 'too-long', chainOf([trigger(), node('l', 'loop', { tool: 'calculate', args: { expression: '{{iteration}} + 1' }, max: 40 })]));
    expect((tooLong.publish.body.errors as { code: string; message: string }[])[0]).toMatchObject({ code: 'limit', message: expect.stringMatching(/2 steps and 39 more loop iterations/) });
    const capped = await workflow(c.admin, 'capped', chainOf([trigger(), node('l', 'loop', { tool: 'calculate', args: { expression: '{{iteration}} * 10' }, max: 3, while: { left: '{{iteration}}', op: 'lt', right: 100 } })]));
    expect(capped.publish.status).toBe(200);
    const r1 = (await post(c.admin, `/api/workflows/${capped.id}/runs`, { input: { topic: 'x' } }).expect(202)).body;
    await drain(h);
    const l1 = (await c.admin.agent.get(`/api/workflow-runs/${r1.id}`).expect(200)).body.steps.find((s: { nodeId: string }) => s.nodeId === 'l');
    expect(l1.output).toMatchObject({ iterations: 3, stopped: 'max', last: { decimal: '20' } });
    const cond = await workflow(c.admin, 'cond', chainOf([trigger(), node('l', 'loop', { tool: 'calculate', args: { expression: '{{iteration}} + 1' }, max: 10, while: { left: '{{iteration}}', op: 'lt', right: 2 } })]));
    const r2 = (await post(c.admin, `/api/workflows/${cond.id}/runs`, { input: { topic: 'x' } }).expect(202)).body;
    await drain(h);
    const l2 = (await c.admin.agent.get(`/api/workflow-runs/${r2.id}`).expect(200)).body.steps.find((s: { nodeId: string }) => s.nodeId === 'l');
    expect(l2.output).toMatchObject({ iterations: 2, stopped: 'condition' });
    expect(l2.output.results.map((x: { decimal: string }) => x.decimal)).toEqual(['1', '2']);
  });

  it('B-3905: map items that are workflows wait on their approvals, and finished items are not run again', async () => {
    const c = await setup();
    const ITEM = { type: 'object' as const, properties: { item: { type: 'string' as const }, index: { type: 'integer' as const } }, required: ['item'] };
    await workflow(c.admin, 'per-item', chainOf([trigger(ITEM), node('ok', 'approval', { role: 'workflow-admin', show: '{{input.item}}' }), node('t', 'transform', { fields: { done: 'checked {{input.item}}' } })]));
    ollama.reply = (messages) => ({ content: `caption: ${messages[messages.length - 1]!.content}` });
    const LIST = { type: 'object' as const, properties: { items: { type: 'array' as const, items: { type: 'string' as const } } }, required: ['items'] };
    const w = await workflow(c.admin, 'fan', chainOf([trigger(LIST), node('cap', 'map', { over: '{{input.items}}', profile: 'general', prompt: 'Caption {{item}} ({{index}})', maxParallel: 2, as: 'captions' }), node('each', 'map', { over: '{{input.items}}', workflow: 'per-item', maxParallel: 3 })]));
    expect(w.publish.body.errors ?? []).toEqual([]);
    expect(w.publish.status).toBe(200);
    const started = (await post(c.admin, `/api/workflows/${w.id}/runs`, { input: { items: ['a', 'b', 'c'] } }).expect(202)).body;
    await drain(h);
    let v = (await c.admin.agent.get(`/api/workflow-runs/${started.id}`).expect(200)).body;
    expect(v.state).toBe('waiting');
    expect(v.steps.find((s: { nodeId: string }) => s.nodeId === 'cap').output.captions.map((x: { text: string }) => x.text)).toEqual(['caption: Caption a (0)', 'caption: Caption b (1)', 'caption: Caption c (2)']);
    expect(v.steps.find((s: { nodeId: string }) => s.nodeId === 'each')).toMatchObject({ state: 'waiting', detail: { waiting: 3 } });
    expect(v.children.filter((k: { kind: string }) => k.kind === 'workflow-run')).toHaveLength(3);
    const approvals = (await c.admin.agent.get('/api/workflow-approvals').expect(200)).body as { id: string }[];
    expect(approvals).toHaveLength(3);
    await post(c.admin, `/api/workflow-approvals/${approvals[0]!.id}`, { decision: 'approve' }).expect(200);
    await drain(h);
    v = (await c.admin.agent.get(`/api/workflow-runs/${started.id}`).expect(200)).body;
    expect(v.state).toBe('waiting');
    expect(v.items.filter((i: { nodeId: string; state: string }) => i.nodeId === 'each' && i.state === 'passed')).toHaveLength(1);
    for (const a of approvals.slice(1)) await post(c.admin, `/api/workflow-approvals/${a.id}`, { decision: 'approve' }).expect(200);
    await drain(h);
    v = (await c.admin.agent.get(`/api/workflow-runs/${started.id}`).expect(200)).body;
    expect(v.state).toBe('succeeded');
    const each = v.steps.find((s: { nodeId: string }) => s.nodeId === 'each');
    expect(each.output.results).toEqual([{ done: 'checked a' }, { done: 'checked b' }, { done: 'checked c' }]);
    // Three captions, each through the model once.
    expect(ollama.requests.filter((r) => r.path === '/api/chat')).toHaveLength(3);
    expect(v.children.filter((k: { kind: string }) => k.kind === 'workflow-run')).toHaveLength(3);
  });

  it('dry runs mock the new kinds and call nothing', async () => {
    const c = await setup();
    const w = (await post(c.admin, '/api/workflows', { name: 'dry', label: 'internal' }).expect(201)).body;
    await put(c.admin, `/api/workflows/${w.id}/draft`, { graph: chainOf([trigger(), node('s', 'sub', { workflow: 'missing' }), node('a', 'agent', { agent: 'Missing' }), node('m', 'map', { over: '{{input.topic}}', tool: 'calculate', args: { expression: '{{item}}' } })]) }).expect(200);
    const run = (await post(c.admin, `/api/workflows/${w.id}/dry-run`, { input: { topic: 'x' } }).expect(202)).body;
    await drain(h);
    const v = (await c.admin.agent.get(`/api/workflow-runs/${run.id}`).expect(200)).body;
    expect(v.state).toBe('succeeded');
    expect(v.steps.filter((s: { detail: { mocked?: boolean } }) => s.detail.mocked).map((s: { nodeId: string }) => s.nodeId).sort()).toEqual(['a', 'm', 's']);
    expect(v.chain).toBeNull();
  });
});
