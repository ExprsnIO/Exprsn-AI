/*
 * Sprint 34a: chaining agents, skills, tools and workflows. Agents delegate to agents (B-4102), skills compose
 * (B-4103), agents start the workflows they list (B-4104), chain checks at publish and the "used by" view (B-4105),
 * approvals and failures through the chain (B-4106) and the chain view (B-4107).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { WfGraph, WfNode } from '../src/workflows/graph.js';
import { FakeOllama } from './fake-ollama.js';
import { seedGateway } from './seed-gateway.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

const TOPIC = { type: 'object' as const, properties: { topic: { type: 'string' as const } }, required: ['topic'] };
const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);
const put = (c: Client, url: string, body: object) => c.agent.put(url).set('x-csrf-token', c.csrf).send(body);
const trigger = (output: WfNode['output'] = TOPIC): WfNode => ({ id: 'trigger', kind: 'trigger', title: 'Trigger', x: 20, y: 24, config: { source: 'api' }, ...(output ? { output } : {}) });
const node = (id: string, kind: string, config: Record<string, unknown>, extra: Partial<WfNode> = {}): WfNode => ({ id, kind: kind as WfNode['kind'], title: id, x: 20, y: 24, config, ...extra });
const line = (nodes: WfNode[], extraEdges: WfGraph['edges'] = []): WfGraph => ({ nodes, edges: [...nodes.slice(1).map((n, i) => ({ from: nodes[i]!.id, to: n.id })), ...extraEdges], limits: {} });
const BUDGETS = { steps: 20, tokens: 10_000, wallSeconds: 600, toolCalls: 8 };

type TreeNode = { id: string; kind: string; name: string | null; state: string; errorType: string | null; decision: string | null; usage: { tokens: number }; subtree: { tokens: number; nodes: number }; held: unknown[]; replay: unknown; links: { run: string | null; audit: string | null }; children: TreeNode[] };
const flat = (n: TreeNode): TreeNode[] => [n, ...n.children.flatMap(flat)];

async function drain(h: Harness, rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) if (!(await h.s.jobs.runDue())) break;
}

describe('Sprint 34a: chaining agents, skills, tools and workflows', () => {
  let h: Harness;
  let ollama: FakeOllama;
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  async function setup(env: Record<string, string> = {}) {
    h = await harness({ OLLAMA_POLL_MS: '600000', ...env });
    ollama = await new FakeOllama().start();
    ollama.chatDelayMs = 0;
    await seedGateway(h, ollama);
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Ops', 'confidential')).id;
    const users = [await localUser(h, 'wadmin', ['workflow-admin', 'member'], 'confidential'), await localUser(h, 'tadmin', ['tool-admin', 'agent-admin'], 'confidential'), await localUser(h, 'tadmin2', ['tool-admin', 'agent-admin'], 'confidential'), await localUser(h, 'mem', ['member'], 'confidential'), await localUser(h, 'other', ['member'], 'confidential')];
    for (const u of users) await h.s.tenants.addMember(ws, u.id);
    const c = { admin: await loginAdmin(h, 'wadmin'), t: await loginAdmin(h, 'tadmin'), t2: await loginAdmin(h, 'tadmin2'), m: await login(h, 'mem'), o: await login(h, 'other'), ws };
    for (const x of [c.admin, c.t, c.t2, c.m, c.o]) await put(x, '/api/me/workspace', { workspaceId: ws }).expect(200);
    return c;
  }
  type Ctx = Awaited<ReturnType<typeof setup>>;

  async function publishEntry(c: Ctx, body: Record<string, unknown>) {
    const e = (await post(c.t, '/api/admin/registry', body).expect(201)).body;
    await post(c.t, `/api/admin/registry/${e.id}/submit`).expect(200);
    const r = await post(c.t2, `/api/admin/registry/${e.id}/review`, { decision: 'approve' });
    return { ...e, review: r };
  }
  const agent = (name: string, systemPrompt: string, def: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ kind: 'agent', name, version: '1.0.0', description: `${name}: works on the task it is given and reports the result plainly.`, label: 'confidential', ...extra, definition: { profile: 'general', systemPrompt, tools: [], budgets: BUDGETS, ...def } });
  const skill = (name: string, def: Record<string, unknown>, label = 'confidential') => ({ kind: 'skill', name, version: '1.0.0', description: `${name}: instructions for the close, with the arithmetic done by tools.`, label, definition: { instructions: `Follow ${name}.`, tools: [], ...def } });
  async function workflow(c: Ctx, name: string, g: WfGraph, label = 'internal') {
    const w = (await post(c.admin, '/api/workflows', { name, label }).expect(201)).body;
    await put(c.admin, `/api/workflows/${w.id}/draft`, { graph: g }).expect(200);
    const r = await post(c.admin, `/api/workflows/${w.id}/publish`);
    return { id: w.id as string, publish: { status: r.status, body: r.body as Record<string, unknown> } };
  }
  const run = async (c: Ctx, id: string) => (await c.m.agent.get(`/api/runs/${id}`).expect(200)).body;
  const byAgent = async (name: string) => (await h.s.db('agent_runs').where({ agent_name: name }).orderBy('created_at')) as { id: string; state: string; budgets: string; usage: string; caller_kind: string | null; caller_id: string | null; chain_id: string; error: string | null }[];

  it('B-4102, B-4106, B-4107: a write tool held three levels down is approved from the root run and the chain resumes', async () => {
    const c = await setup();
    await publishEntry(c, agent('Clerk', 'C.', { tools: ['feed.post'] }));
    const broker = await publishEntry(c, agent('Broker', 'B.', { agents: ['Clerk'] }));
    expect(broker.checks.find((x: { name: string }) => x.name === 'Chain references')).toMatchObject({ ok: true });
    await publishEntry(c, agent('Planner', 'A.', { agents: ['Broker'] }));
    ollama.reply = (messages) => {
      const who = messages[0]!.content.slice(0, 2);
      const last = messages[messages.length - 1]!;
      if (last.role === 'tool') return { content: `${who} done: ${last.content}` };
      if (who === 'A.') return { content: '', toolCall: { name: 'agent_Broker', arguments: { task: 'Get the close notice posted.' } } };
      if (who === 'B.') return { content: '', toolCall: { name: 'agent_Clerk', arguments: { task: 'Post the close notice.' } } };
      return { content: '', toolCall: { name: 'feed_post', arguments: { body: 'September close is done.' } } };
    };
    const root = (await post(c.m, '/api/runs', { agent: 'Planner', input: 'Announce the close.', label: 'internal' }).expect(202)).body;
    await drain(h);

    const [a] = await byAgent('Planner');
    const [b] = await byAgent('Broker');
    const [cl] = await byAgent('Clerk');
    expect([a!.state, b!.state, cl!.state]).toEqual(['waiting', 'waiting', 'waiting']);
    expect(b).toMatchObject({ caller_kind: 'agent-run', caller_id: a!.id, chain_id: root.chain.id });
    expect(cl).toMatchObject({ caller_kind: 'agent-run', caller_id: b!.id, chain_id: root.chain.id });
    // The child's budgets are what the parent had left (20 steps: one thinking step and this call used).
    expect(JSON.parse(b!.budgets).steps).toBe(18);
    expect(JSON.parse(cl!.budgets).steps).toBe(16);
    const aStep1 = (await h.s.db('agent_steps').where({ run_id: a!.id, n: 1 }).first()) as { meta: string };
    expect(JSON.parse(b!.budgets).tokens).toBe(10_000 - Number(JSON.parse(aStep1.meta).tokens));
    expect(await h.s.db('feed_posts').count({ n: '*' }).first()).toMatchObject({ n: 0 });

    // The root run shows the held call with its path; so does the chain view.
    const rv = await run(c, root.id);
    expect(rv.held).toHaveLength(1);
    const held = rv.held[0];
    expect(held).toMatchObject({ at: { kind: 'agent-run', run: cl!.id }, tool: 'feed.post', sideEffect: 'write', canDecide: true });
    expect(held.path.map((x: { kind: string; name: string }) => `${x.kind}:${x.name}`)).toEqual(['agent-run:Planner', 'tool-call:Broker@1.0.0', 'agent-run:Broker', 'tool-call:Clerk@1.0.0', 'agent-run:Clerk']);
    expect(rv.children).toEqual([expect.objectContaining({ kind: 'agent-run', id: b!.id, agent: 'Broker', state: 'waiting' })]);
    const tree = (await c.m.agent.get(`/api/chains/${root.chain.id}`).expect(200)).body;
    expect(tree.held).toHaveLength(1);
    const nodes = flat(tree.root);
    expect(nodes.map((n) => `${n.kind}:${n.state}`)).toEqual(['agent-run:waiting', 'tool-call:waiting', 'agent-run:waiting', 'tool-call:waiting', 'agent-run:waiting']);
    expect(nodes[4]!.held).toHaveLength(1);
    // Someone else cannot see the chain nor decide what it holds.
    await c.o.agent.get(`/api/chains/${root.chain.id}`).expect(404);
    await post(c.o, `/api/chains/${root.chain.id}/held/${held.node}/decision`, { decision: 'approve' }).expect(404);

    await post(c.m, `/api/chains/${root.chain.id}/held/${held.node}/decision`, { decision: 'approve', note: 'Go ahead.' }).expect(200);
    await drain(h);
    const states = [(await byAgent('Planner'))[0]!.state, (await byAgent('Broker'))[0]!.state, (await byAgent('Clerk'))[0]!.state];
    expect(states).toEqual(['succeeded', 'succeeded', 'succeeded']);
    const posted = (await h.s.db('feed_posts').first('source_kind', 'source_id', 'body')) as { source_kind: string; source_id: string };
    expect(posted).toMatchObject({ source_kind: 'agent-run', source_id: cl!.id });
    const done = await run(c, root.id);
    expect(done.output).toMatch(/^A\. done: .*B\. done: .*C\. done/);
    expect(done.held).toEqual([]);

    // The tree's token total is what the chain metered, and what the three runs' thinking steps used.
    const after = (await c.m.agent.get(`/api/chains/${root.chain.id}`).expect(200)).body;
    expect(after.state).toBe('done');
    expect(after.totals.tokens).toBe(after.used.tokens);
    expect(after.root.subtree.tokens).toBe(after.used.tokens);
    const think = (await h.s.db('agent_steps').whereIn('run_id', [a!.id, b!.id, cl!.id]).where({ lane: 'think' }).select('meta')) as { meta: string }[];
    expect(after.used.tokens).toBe(think.reduce((t, s) => t + Number(JSON.parse(s.meta).tokens ?? 0), 0));
    const all = flat(after.root);
    expect(all.map((n) => `${n.kind}:${n.state}`)).toEqual(['agent-run:succeeded', 'tool-call:succeeded', 'agent-run:succeeded', 'tool-call:succeeded', 'agent-run:succeeded', 'tool-call:succeeded']);
    expect(all[1]!.decision).toBe('allow');
    expect(all[0]!.links).toEqual({ run: `/api/runs/${a!.id}`, audit: `/api/admin/audit?target=${a!.id}` });
    expect(all[0]!.replay).toMatchObject({ href: `/api/chains/${root.chain.id}/nodes/${all[0]!.id}/replay`, fromStep: expect.arrayContaining([1]) });
    expect(all[5]!.replay).toBeNull();

    // Audited: the delegations, the decision from the chain and the approval where it waited.
    const actions = (await h.s.audit.list(h.tenantId, { limit: 500 })).map((e) => e.action);
    expect(actions.filter((x) => x === 'agent.run.delegated')).toHaveLength(2);
    expect(actions).toEqual(expect.arrayContaining(['chain.held.decided', 'agent.call.approved']));
    // The audit link finds the run's entries.
    expect((await h.s.audit.list(h.tenantId, { target: cl!.id })).map((e) => e.action)).toEqual(expect.arrayContaining(['agent.run.delegated', 'agent.call.approved']));

    // Replay from a node starts a new chain of its own.
    const rp = (await post(c.m, `/api/chains/${root.chain.id}/nodes/${all[0]!.id}/replay`, { fromStep: 1 }).expect(202)).body;
    expect(rp).toMatchObject({ kind: 'agent-run', run: expect.any(String) });
    expect(rp.chain).not.toBe(root.chain.id);
    await post(c.m, `/api/chains/${root.chain.id}/nodes/${all[1]!.id}/replay`, { fromStep: 1 }).expect(409);
  });

  it('B-4102: a delegate cannot spend more than the parent has left nor read above the chain\'s ceiling; answers are typed', async () => {
    const c = await setup();
    await publishEntry(c, agent('Low', 'L.', {}, { label: 'internal' }));
    await publishEntry(c, agent('Typed', 'T.', {}, { outputSchema: { type: 'object', properties: { total: { type: 'number' } }, required: ['total'] } }));
    await publishEntry(c, agent('Tiny', 'Y.', { tools: ['calculate'], budgets: { ...BUDGETS, steps: 1 } }));
    await publishEntry(c, agent('Boss', 'P.', { agents: ['Low', 'Typed', 'Tiny'] }));
    await publishEntry(c, agent('Starved', 'S.', { agents: ['Typed'], budgets: { ...BUDGETS, steps: 2 } }));
    let typedAnswer = '{"total": 4}';
    let plan: { name: string; arguments: Record<string, unknown> }[] = [];
    ollama.reply = (messages) => {
      const who = messages[0]!.content.slice(0, 2);
      const last = messages[messages.length - 1]!;
      if (who === 'T.') return { content: typedAnswer };
      if (who === 'Y.') return { content: '', toolCall: { name: 'calculate', arguments: { expression: '2+2' } } };
      if (last.role === 'tool' || !plan.length) return { content: `got ${last.content}` };
      return { content: '', toolCall: plan.shift()! };
    };

    // Above the chain's ceiling: a confidential run cannot hand its data to an internal delegate.
    plan = [{ name: 'agent_Low', arguments: { task: 'x' } }];
    const r1 = (await post(c.m, '/api/runs', { agent: 'Boss', input: 'go', label: 'confidential' }).expect(202)).body;
    await drain(h);
    const v1 = await run(c, r1.id);
    expect(v1.state).toBe('succeeded');
    expect(v1.steps[1]).toMatchObject({ title: 'agent_Low', state: 'denied', detail: { error: expect.stringMatching(/hidden: agent:Low, its ceiling is internal; the data is confidential/) } });
    expect(await byAgent('Low')).toHaveLength(0);

    // A typed answer comes back parsed; one that does not match the schema is a typed error.
    plan = [{ name: 'agent_Typed', arguments: { task: 'Add 2 and 2.' } }];
    const r2 = (await post(c.m, '/api/runs', { agent: 'Boss', input: 'go', label: 'internal' }).expect(202)).body;
    await drain(h);
    const v2 = await run(c, r2.id);
    expect(v2.steps[1]).toMatchObject({ title: 'Typed', state: 'ok', detail: { result: { agent: 'Typed', answer: { total: 4 } } } });
    typedAnswer = 'four';
    plan = [{ name: 'agent_Typed', arguments: { task: 'Add 2 and 2.' } }];
    const r3 = (await post(c.m, '/api/runs', { agent: 'Boss', input: 'go', label: 'internal' }).expect(202)).body;
    await drain(h);
    const v3 = await run(c, r3.id);
    expect(v3.steps[1]).toMatchObject({ state: 'failed', detail: { errorType: 'output', error: expect.stringMatching(/^child_output: .*not the JSON its output schema asks for/) } });

    // A delegate stopped at its own budget is a typed error to its parent, and cannot be resumed behind it.
    plan = [{ name: 'agent_Tiny', arguments: { task: 'Add.' } }];
    const r4 = (await post(c.m, '/api/runs', { agent: 'Boss', input: 'go', label: 'internal' }).expect(202)).body;
    await drain(h);
    const v4 = await run(c, r4.id);
    expect(v4.state).toBe('succeeded');
    expect(v4.steps[1]).toMatchObject({ state: 'failed', detail: { errorType: 'budget', error: expect.stringMatching(/^child_budget: Tiny run .* stopped at its budget/) } });
    const [tiny] = await byAgent('Tiny');
    expect(tiny!.state).toBe('budget');
    const refused = await post(c.m, `/api/runs/${tiny!.id}/resume`, { budgets: { steps: 5 } }).expect(409);
    expect(refused.body.detail).toMatch(/took its budget stop as an error and went on/);
    const tree = (await c.m.agent.get(`/api/chains/${r4.chain.id}`).expect(200)).body;
    expect(flat(tree.root).map((n) => `${n.kind}:${n.state}:${n.errorType ?? ''}`)).toEqual(['agent-run:succeeded:', 'tool-call:failed:budget', 'agent-run:failed:budget']);

    // A parent with too little left does not start the child at all.
    plan = [{ name: 'agent_Typed', arguments: { task: 'Add.' } }];
    const r5 = (await post(c.m, '/api/runs', { agent: 'Starved', input: 'go', label: 'internal' }).expect(202)).body;
    await drain(h);
    const v5 = await run(c, r5.id);
    expect(v5.steps[1]).toMatchObject({ state: 'failed', detail: { error: expect.stringMatching(/^child_budget: Starved has too little of its budget left/) } });
    expect(v5.state).toBe('budget');
  });

  it('B-4103: a skill offers the tools its sub-skills need and the closure loads each skill once', async () => {
    const c = await setup();
    await publishEntry(c, skill('ledger-basics', { tools: ['calculate'] }));
    await publishEntry(c, skill('variance', { skills: ['ledger-basics'] }));
    // A second version of ledger-basics builds on variance: a loop of sub-skills, which ends by itself.
    const v2 = await publishEntry(c, { ...skill('ledger-basics', { tools: ['calculate'], skills: ['variance'] }), version: '2.0.0' });
    expect(v2.checks.find((x: { name: string }) => x.name === 'Chain references')).toMatchObject({ ok: true, detail: expect.stringMatching(/each skill loads once/) });
    expect(v2.review.status).toBe(200);
    // An unpublished sub-skill fails the check, and approval waits for it.
    const bad = await publishEntry(c, skill('broken', { skills: ['missing-skill'] }));
    expect(bad.checks.find((x: { name: string }) => x.name === 'Chain references')).toMatchObject({ ok: false, detail: expect.stringMatching(/skill missing-skill is not published/i) });
    expect(bad.review.status).toBe(409);

    await publishEntry(c, agent('Analyst', 'N.', { skills: ['variance', 'ledger-basics'] }));
    let offered: string[] = [];
    let system = '';
    ollama.reply = (messages, opts) => {
      offered = (opts.tools as { function: { name: string } }[]).map((t) => t.function.name);
      system = messages[0]!.content;
      const last = messages[messages.length - 1]!;
      if (last.role === 'tool') return { content: `It is ${JSON.parse(last.content).decimal}.` };
      return { content: '', toolCall: { name: 'calculate', arguments: { expression: '412880 - 361500' } } };
    };
    const r = (await post(c.m, '/api/runs', { agent: 'Analyst', input: 'Explain the variance.', label: 'internal' }).expect(202)).body;
    await drain(h);
    const v = await run(c, r.id);
    expect(v.state).toBe('succeeded');
    expect(v.output).toBe('It is 51380.');
    expect(offered).toEqual(['calculate']);
    // Dependencies first: variance builds on ledger-basics, whose instructions come before it, each once.
    expect(system.indexOf('Skill variance')).toBeGreaterThan(system.indexOf('Skill ledger-basics'));
    expect(system.match(/Skill ledger-basics/g)).toHaveLength(1);
    const chain = (await h.s.chains.view(h.tenantId, r.chain.id))!;
    expect(chain.nodes.filter((n) => n.kind === 'skill-load').map((n) => n.callee).sort()).toEqual(['ledger-basics@2.0.0', 'variance@1.0.0']);
  });

  it('B-4104: an agent starts a workflow it lists and receives its output; one it does not list is refused', async () => {
    const c = await setup();
    const shape = await workflow(c, 'shape-notes', line([trigger(), node('out', 'transform', { fields: { summary: 'Notes on {{input.topic}}' } }, { output: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } })]));
    expect(shape.publish.status).toBe(200);
    await workflow(c, 'other-flow', line([trigger(), node('out', 'transform', { fields: { x: '1' } })]));
    const lister = await publishEntry(c, agent('Lister', 'W.', { workflows: ['shape-notes'] }));
    expect(lister.review.status).toBe(200);
    let plan: { name: string; arguments: Record<string, unknown> }[] = [];
    let offered: string[] = [];
    ollama.reply = (messages, opts) => {
      offered = (opts.tools as { function: { name: string } }[]).map((t) => t.function.name);
      const last = messages[messages.length - 1]!;
      if (last.role === 'tool' || !plan.length) return { content: `got ${last.content}` };
      return { content: '', toolCall: plan.shift()! };
    };
    plan = [{ name: 'workflow_shape-notes', arguments: { topic: 'budgets' } }];
    const r = (await post(c.m, '/api/runs', { agent: 'Lister', input: 'Shape notes.', label: 'internal' }).expect(202)).body;
    await drain(h);
    const v = await run(c, r.id);
    expect(offered).toEqual(['workflow_shape-notes']);
    expect(v.state).toBe('succeeded');
    expect(v.steps[1]).toMatchObject({ title: 'workflow:shape-notes', state: 'ok', meta: { impl: 'workflow', valid: true }, detail: { result: { output: { summary: 'Notes on budgets' } } } });
    expect(v.children).toEqual([expect.objectContaining({ kind: 'workflow-run', workflowId: shape.id, state: 'succeeded' })]);
    const chain = (await h.s.chains.view(h.tenantId, r.chain.id))!;
    expect(chain.nodes.map((n) => n.kind)).toEqual(['agent-run', 'tool-call', 'workflow-run']);

    plan = [{ name: 'workflow_other-flow', arguments: { topic: 'x' } }];
    const r2 = (await post(c.m, '/api/runs', { agent: 'Lister', input: 'Other.', label: 'internal' }).expect(202)).body;
    await drain(h);
    const v2 = await run(c, r2.id);
    expect(v2.steps[1]).toMatchObject({ state: 'denied', detail: { error: expect.stringMatching(/^tool_unavailable: workflow_other-flow is not one of this agent's tools/) } });
    expect(await h.s.db('workflow_runs').where({ workflow_id: (await h.s.db('workflows').where({ name: 'other-flow' }).first('id')).id }).count({ n: '*' }).first()).toMatchObject({ n: 0 });

    // The workflow's callers list the agent; it cannot be deleted while the agent uses it.
    const callers = (await c.admin.agent.get(`/api/workflows/${shape.id}/callers`).expect(200)).body;
    expect(callers.agents).toEqual([expect.objectContaining({ name: 'Lister', status: 'published' })]);
    const used = (await c.admin.agent.get(`/api/workflows/${shape.id}/used-by`).expect(200)).body;
    expect(used).toMatchObject({ deleteBlocked: true, usedBy: [expect.objectContaining({ kind: 'agent', name: 'Lister', via: 'workflow', live: true })] });
    const del = await c.admin.agent.delete(`/api/workflows/${shape.id}`).set('x-csrf-token', c.admin.csrf).expect(409);
    expect(del.body.detail).toMatch(/shape-notes is used by agent Lister/);
  });

  it('B-4105: chain checks at publish and the "used by" view; retiring a skill a published agent uses is refused', async () => {
    const c = await setup();
    const sk = await publishEntry(c, skill('close-checklist', {}));
    await publishEntry(c, agent('Closer', 'K.', { skills: ['close-checklist'] }));
    await post(c.t, `/api/admin/registry/${sk.id}/lifecycle`, { to: 'deprecated' }).expect(200);
    const used = (await c.t.agent.get(`/api/admin/registry/${sk.id}/used-by`).expect(200)).body;
    expect(used).toMatchObject({ name: 'close-checklist', retireBlocked: true, usedBy: [expect.objectContaining({ kind: 'agent', name: 'Closer', via: 'skill', live: true })] });
    const refused = await post(c.t, `/api/admin/registry/${sk.id}/lifecycle`, { to: 'retired' }).expect(409);
    expect(refused.body.detail).toMatch(/close-checklist is used by agent Closer 1\.0\.0/);
    expect(refused.body.usedBy).toEqual([expect.objectContaining({ name: 'Closer' })]);
    // Once the agent stops using it (retired), the skill retires.
    const closer = (await h.s.registry.list(h.tenantId, { kind: 'agent' })).find((e) => e.name === 'Closer')!;
    await post(c.t, `/api/admin/registry/${closer.id}/lifecycle`, { to: 'deprecated' }).expect(200);
    await post(c.t, `/api/admin/registry/${closer.id}/lifecycle`, { to: 'retired' }).expect(200);
    await post(c.t, `/api/admin/registry/${sk.id}/lifecycle`, { to: 'retired' }).expect(200);

    // Unpublished delegates and workflows, and a delegate above the agent's ceiling, fail the chain check.
    const loose = await publishEntry(c, agent('Loose', 'X.', { agents: ['Ghost'], workflows: ['no-such-flow'] }));
    expect(loose.checks.find((x: { name: string }) => x.name === 'Chain references')).toMatchObject({ ok: false, detail: expect.stringMatching(/agent Ghost is not published.*workflow no-such-flow is not published in this workspace/i) });
    expect(loose.review.status).toBe(409);
    await publishEntry(c, agent('Secret', 'S.', {}, { label: 'confidential' }));
    const lowAgent = await publishEntry(c, agent('LowBoss', 'L.', { agents: ['Secret'] }, { label: 'internal' }));
    expect(lowAgent.checks.find((x: { name: string }) => x.name === 'Chain references')).toMatchObject({ ok: false, detail: expect.stringMatching(/agent Secret handles confidential data, above this agent's ceiling \(internal\)/i) });
    // An agent that delegates to itself can stop (the model chooses): a warning, not a refusal.
    await publishEntry(c, agent('Recur', 'R.', {}));
    const recur = (await h.s.registry.list(h.tenantId, { kind: 'agent' })).find((e) => e.name === 'Recur')!;
    const v2 = (await post(c.t, `/api/admin/registry/${recur.id}/versions`, { version: '2.0.0' }).expect(201)).body;
    const patched = (await c.t.agent.patch(`/api/admin/registry/${v2.id}`).set('x-csrf-token', c.t.csrf).send({ definition: { profile: 'general', systemPrompt: 'R.', tools: [], budgets: BUDGETS, agents: ['Recur'] } }).expect(200)).body;
    expect(patched.checks.find((x: { name: string }) => x.name === 'Chain references')).toMatchObject({ ok: true, detail: expect.stringMatching(/agent Recur delegates to agent Recur: a model chooses each call/i) });

    // Workflows: a cycle of sub-workflows always runs, so it cannot terminate, and is refused at publish.
    const leaf = await workflow(c, 'loop-b', line([trigger(), node('out', 'transform', { fields: { x: '{{input.topic}}' } })]));
    expect(leaf.publish.status).toBe(200);
    const a = await workflow(c, 'loop-a', line([trigger(), node('b', 'sub', { workflow: 'loop-b', input: { topic: '{{input.topic}}' } })]));
    expect(a.publish.status).toBe(200);
    // loop-b now runs loop-a: loop-b → loop-a → loop-b.
    await put(c.admin, `/api/workflows/${leaf.id}/draft`, { graph: line([trigger(), node('a', 'sub', { workflow: 'loop-a', input: { topic: '{{input.topic}}' } })]) }).expect(200);
    const cyc = await post(c.admin, `/api/workflows/${leaf.id}/publish`).expect(422);
    expect(cyc.body.errors).toEqual([expect.objectContaining({ code: 'chain', message: expect.stringMatching(/^Workflow loop-b runs workflow loop-a runs workflow loop-b: every step of the cycle always runs, so it cannot terminate/), path: [`workflow:${leaf.id}`, `workflow:${a.id}`, `workflow:${leaf.id}`] })]);
    // An agent step whose agent can start the workflow again is bounded at run time: published with a warning.
    const loopC = await workflow(c, 'loop-c', line([trigger(), node('out', 'transform', { fields: { x: '{{input.topic}}' } })]));
    expect(loopC.publish.status).toBe(200);
    expect((await publishEntry(c, agent('Looper', 'O.', { workflows: ['loop-c'] }))).review.status).toBe(200);
    await put(c.admin, `/api/workflows/${loopC.id}/draft`, { graph: line([trigger(), node('ask', 'agent', { agent: 'Looper', input: '{{input.topic}}' })]) }).expect(200);
    const again = (await post(c.admin, `/api/workflows/${loopC.id}/publish`).expect(200)).body;
    expect((again.warnings as { code: string; message: string }[]).find((w) => w.code === 'chain')?.message).toMatch(/^Workflow loop-c runs agent Looper starts workflow loop-c: a model chooses each call/);
    const registryUsed = (await c.t.agent.get(`/api/admin/registry/${(await h.s.registry.list(h.tenantId, { kind: 'agent' })).find((e) => e.name === 'Looper')!.id}/used-by`).expect(200)).body;
    expect(registryUsed.usedBy).toEqual([expect.objectContaining({ kind: 'workflow', name: 'loop-c', via: 'agent-step', live: true })]);
  });

  it('B-4106: a budget-stopped agent step is a typed error its failure edge takes; a skill\'s held call pauses the step and is approved from the chain', async () => {
    const c = await setup();
    await publishEntry(c, agent('Tiny', 'Y.', { tools: ['calculate'], budgets: { ...BUDGETS, steps: 1 } }));
    await publishEntry(c, skill('announce', { tools: ['feed.post'] }));
    ollama.reply = (messages) => {
      const who = messages[0]!.content.slice(0, 2);
      const last = messages[messages.length - 1]!;
      if (who === 'Y.') return { content: '', toolCall: { name: 'calculate', arguments: { expression: '2+2' } } };
      if (last.role === 'tool') return { content: `Posted: ${last.content}` };
      return { content: '', toolCall: { name: 'feed_post', arguments: { body: 'Close is done.' } } };
    };
    const g: WfGraph = { nodes: [trigger(), node('ask', 'agent', { agent: 'Tiny', input: 'Add {{input.topic}}' }), node('recover', 'transform', { fields: { note: 'failed as {{steps.ask.type}}' } }), node('after', 'transform', { fields: { ok: 'yes' } })], edges: [{ from: 'trigger', to: 'ask' }, { from: 'ask', to: 'recover', branch: 'failure' }, { from: 'ask', to: 'after' }], limits: {} };
    const w = await workflow(c, 'tiny-flow', g);
    expect(w.publish.status).toBe(200);
    const started = (await post(c.admin, `/api/workflows/${w.id}/runs`, { input: { topic: '2+2' } }).expect(202)).body;
    await drain(h);
    const v = (await c.admin.agent.get(`/api/workflow-runs/${started.id}`).expect(200)).body;
    expect(v.state).toBe('succeeded');
    expect(v.steps.find((s: { nodeId: string }) => s.nodeId === 'ask')).toMatchObject({ state: 'failed', detail: { errorType: 'budget' } });
    expect(v.steps.find((s: { nodeId: string }) => s.nodeId === 'recover').output).toEqual({ note: 'failed as budget' });
    const [tiny] = await byAgent('Tiny');
    await post(c.admin, `/api/runs/${tiny!.id}/resume`, { budgets: { steps: 5 } }).expect(409);

    // A model step's skill holds a write call: the step waits on an approval, decided from the chain.
    const m = await workflow(c, 'announcer', line([trigger(), node('say', 'model', { profile: 'general', prompt: 'Announce {{input.topic}}.', skills: ['announce'] })]));
    expect(m.publish.status).toBe(200);
    const r = (await post(c.admin, `/api/workflows/${m.id}/runs`, { input: { topic: 'the close' } }).expect(202)).body;
    await drain(h);
    let rv = (await c.admin.agent.get(`/api/workflow-runs/${r.id}`).expect(200)).body;
    expect(rv.state).toBe('waiting');
    expect(rv.steps.find((s: { nodeId: string }) => s.nodeId === 'say')).toMatchObject({ state: 'waiting', detail: { skillHold: { tool: 'feed.post' } } });
    expect(await h.s.db('feed_posts').count({ n: '*' }).first()).toMatchObject({ n: 0 });
    expect(rv.held).toEqual([expect.objectContaining({ at: expect.objectContaining({ kind: 'workflow-run', run: r.id, step: 'say' }), tool: 'feed.post', sideEffect: 'write', approvers: 'the workflow-admin role' })]);
    // The run's owner is a workflow admin, which the step's approver role asks for; the approver decides from the chain.
    await post(c.admin, `/api/chains/${rv.chain.id}/held/${rv.held[0].node}/decision`, { decision: 'approve' }).expect(200);
    await drain(h);
    rv = (await c.admin.agent.get(`/api/workflow-runs/${r.id}`).expect(200)).body;
    expect(rv.state).toBe('succeeded');
    const say = rv.steps.find((s: { nodeId: string }) => s.nodeId === 'say');
    expect(say.output.text).toMatch(/^Posted: /);
    expect(say.detail.toolCalls).toEqual([expect.objectContaining({ tool: 'feed.post', ok: true, approvedBy: 'WADMIN' })]);
    expect(await h.s.db('feed_posts').count({ n: '*' }).first()).toMatchObject({ n: 1 });
    const actions = (await h.s.audit.list(h.tenantId, { limit: 500 })).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['chain.held.decided', 'workflow.approval.approved']));

    // Rejected, the model is told and nothing runs.
    const r2 = (await post(c.admin, `/api/workflows/${m.id}/runs`, { input: { topic: 'again' } }).expect(202)).body;
    await drain(h);
    const [a2] = (await c.admin.agent.get('/api/workflow-approvals').expect(200)).body;
    expect(a2.runId).toBe(r2.id);
    await post(c.admin, `/api/workflow-approvals/${a2.id}`, { decision: 'reject', reason: 'Not today.' }).expect(200);
    await drain(h);
    const rv2 = (await c.admin.agent.get(`/api/workflow-runs/${r2.id}`).expect(200)).body;
    expect(rv2.state).toBe('succeeded');
    expect(rv2.steps.find((s: { nodeId: string }) => s.nodeId === 'say').output.text).toMatch(/Rejected by WADMIN: Not today\. Nothing was run\./);
    expect(await h.s.db('feed_posts').count({ n: '*' }).first()).toMatchObject({ n: 1 });
  });
});
