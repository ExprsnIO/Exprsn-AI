import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProfileRow } from '../src/gateway/repo.js';
import { TOPICS } from '../src/platform/bus.js';
import { validateGraph, type WfGraph } from '../src/workflows/graph.js';
import { internalRequest, isInternalAddress } from '../src/workflows/http.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

const GB = 1_000_000_000;

/** A pool on the fake Ollama, an approved model and a published `general` profile (internal). */
async function seed(h: Harness, ollama: FakeOllama) {
  const repo = h.s.gateway.repo;
  ollama.addAvailable({ name: 'llama3.1:8b', size: 5 * GB, capabilities: ['completion'] });
  const pool = await repo.createPool({ name: 'gpu', accelerator: 'cuda', zone: 'inference', labelCeiling: 'confidential' });
  await repo.createInstance({ poolId: pool.id, name: 'gpu-1', url: ollama.url, deploy: 'docker', settings: { parallel: 4 } });
  const m = await repo.createModel({ name: 'llama3.1:8b', source: 'Ollama library', expectedDigest: null, license: { name: 'test' }, label: 'confidential', notes: null, requestedBy: 'x', requestedTenant: h.tenantId });
  await repo.updateModel(m.id, { state: 'approved', import_state: 'pulled', capabilities: ['completion'], size_bytes: 5 * GB });
  await repo.place(m.id, pool.id, 'warm', 'x');
  const t = Date.now();
  const row: ProfileRow = { id: 'GENERAL'.padEnd(26, '0'), tenant_id: h.tenantId, name: 'general', display_name: 'General', description: null, alias_of: null, model_id: m.id, pool_id: pool.id, num_ctx: 8192, temperature: 0.2, think_default: 'off', think_ceiling: 'off', system_prompt: null, fallback: null, canary: null, tools: [], label: 'internal', status: 'published', version: 1, updated_by: null, created_at: t, updated_at: t };
  await repo.createProfile(row);
  await h.s.gateway.pollAll();
}

const TOPIC_SCHEMA = { type: 'object' as const, properties: { topic: { type: 'string' as const } }, required: ['topic'] };

function notesGraph(hook: string): WfGraph {
  return {
    nodes: [
      { id: 'trigger', kind: 'trigger', title: 'Trigger: manual', x: 20, y: 24, config: { source: 'manual' }, output: TOPIC_SCHEMA },
      { id: 'summarise', kind: 'model', title: 'Summarise', x: 230, y: 24, config: { profile: 'general', prompt: 'Summarise {{input.topic}}' }, input: TOPIC_SCHEMA },
      { id: 'shape', kind: 'transform', title: 'Shape', x: 440, y: 24, config: { fields: { summary: '{{steps.summarise.text}}', topic: '{{input.topic}}' } } },
      { id: 'check', kind: 'branch', title: 'Has a summary', x: 440, y: 152, config: { left: '{{steps.shape.summary}}', op: 'contains', right: 'You said' } },
      { id: 'approve', kind: 'approval', title: 'Approval', x: 230, y: 282, config: { role: 'knowledge-curator', show: '{{steps.shape.summary}}' } },
      { id: 'other', kind: 'transform', title: 'Other branch', x: 440, y: 282, config: { fields: { note: 'nothing to post' } } },
      { id: 'post', kind: 'http', title: 'Post to hook', x: 20, y: 412, config: { method: 'POST', url: `${hook}/hook/{{input.topic}}`, body: '{{steps.shape}}', headers: { 'content-type': 'application/json' } }, input: { type: 'object', properties: { summary: { type: 'string' }, approved: { type: 'boolean' } }, required: ['summary', 'approved'] } }
    ],
    edges: [
      { from: 'trigger', to: 'summarise' },
      { from: 'summarise', to: 'shape' },
      { from: 'shape', to: 'check' },
      { from: 'check', to: 'approve', branch: 'true' },
      { from: 'check', to: 'other', branch: 'false' },
      { from: 'approve', to: 'post' }
    ],
    limits: {}
  };
}

const env = { label: 'internal' as const, profile: (n: string) => (n === 'general' ? { label: 'internal' as const } : undefined) };

describe('workflow graph validation', () => {
  it('accepts a well-formed graph and reports the label each step handles', () => {
    const v = validateGraph(notesGraph('http://10.0.0.5'), env);
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.labels.post).toBe('internal');
    expect(v.warnings.map((w) => w.nodeId)).toContain('post'); // a write that a replay sends again
  });

  it('rejects a cycle and points at the edge that closes it', () => {
    const g = notesGraph('http://10.0.0.5');
    g.edges.push({ from: 'shape', to: 'summarise' });
    const v = validateGraph(g, env);
    const e = v.errors.find((x) => x.code === 'cycle')!;
    expect(e.message).toBe('Shape feeds back into Summarise. Workflows must be acyclic.');
    expect(e.edge).toEqual({ from: 'shape', to: 'summarise' });
  });

  it('reports a schema mismatch at the step, with both schemas', () => {
    const g = notesGraph('http://10.0.0.5');
    g.nodes.find((n) => n.id === 'post')!.input = { type: 'object', properties: { summary: { type: 'string' }, captions: { type: 'array', items: { type: 'string' } } }, required: ['summary', 'captions'] };
    const e = validateGraph(g, env).errors.find((x) => x.code === 'schema')!;
    expect(e.nodeId).toBe('post');
    expect(e.message).toMatch(/captions is expected but not provided/);
    expect(e.edge).toEqual({ from: 'approve', to: 'post' });
    expect(e.expected?.required).toContain('captions');
    expect(Object.keys(e.actual?.properties ?? {})).toEqual(expect.arrayContaining(['summary', 'topic', 'approved', 'by', 'result']));
  });

  it('checks types along edges, label ceilings, fan-out, references and unavailable steps', () => {
    const g = notesGraph('http://10.0.0.5');
    g.nodes.find((n) => n.id === 'post')!.input = { type: 'object', properties: { approved: { type: 'string' } } };
    g.nodes.find((n) => n.id === 'post')!.ceiling = 'public';
    g.nodes.push({ id: 'tool', kind: 'tool', title: 'Notify owner', x: 0, y: 0, config: { tool: 'jira.create_issue' } });
    g.edges.push({ from: 'post', to: 'tool' });
    g.nodes.find((n) => n.id === 'shape')!.config = { fields: { x: '{{steps.post.status}}' } };
    for (let i = 0; i < 11; i++) {
      g.nodes.push({ id: `f${i}`, kind: 'transform', title: `Fan ${i}`, x: 0, y: 0, config: { fields: { a: '1' } } });
      g.edges.push({ from: 'other', to: `f${i}` });
    }
    const codes = validateGraph(g, env).errors.map((e) => `${e.code}:${e.nodeId ?? ''}`);
    expect(codes).toEqual(expect.arrayContaining(['schema:post', 'label:post', 'unavailable:tool', 'reference:shape', 'limit:other']));
    expect(validateGraph(g, env).errors.find((e) => e.code === 'label')!.message).toBe('Blocked by label ceiling: Post to hook has ceiling public; the data arriving is internal.');
  });

  it('requires branch labels on a branch step and a published profile for model steps', () => {
    const g = notesGraph('http://10.0.0.5');
    delete g.edges.find((e) => e.to === 'other')!.branch;
    g.nodes.find((n) => n.id === 'summarise')!.config = { profile: 'missing', prompt: 'x' };
    const msgs = validateGraph(g, env).errors.map((e) => e.message);
    expect(msgs).toContain('The edge from Has a summary to Other branch needs a branch: true or false.');
    expect(msgs).toContain('Summarise: profile missing is not published.');
  });
});

describe('internal HTTP calls', () => {
  it('only reaches private addresses, never link-local metadata or the public internet', async () => {
    expect(isInternalAddress('10.1.2.3', false)).toBe(true);
    expect(isInternalAddress('172.20.0.1', false)).toBe(true);
    expect(isInternalAddress('192.168.1.1', false)).toBe(true);
    expect(isInternalAddress('fd00::1', false)).toBe(true);
    expect(isInternalAddress('127.0.0.1', false)).toBe(false);
    expect(isInternalAddress('127.0.0.1', true)).toBe(true);
    expect(isInternalAddress('169.254.169.254', true)).toBe(false);
    expect(isInternalAddress('8.8.8.8', true)).toBe(false);
    expect(isInternalAddress('::ffff:8.8.8.8', true)).toBe(false);
    const base = { method: 'GET' as const, timeoutMs: 1000, allowLoopback: true };
    await expect(internalRequest({ ...base, url: 'http://8.8.8.8/x', allowHosts: [] })).rejects.toThrow(/not an internal address/);
    await expect(internalRequest({ ...base, url: 'http://169.254.169.254/latest/meta-data', allowHosts: [] })).rejects.toThrow(/not an internal address/);
    await expect(internalRequest({ ...base, url: 'http://10.0.0.1/x', allowHosts: ['.corp.internal'] })).rejects.toThrow(/not on the list/);
    await expect(internalRequest({ ...base, url: 'ftp://10.0.0.1/x', allowHosts: [] })).rejects.toThrow(/Only http/);
  });
});

describe('workflows', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let hook: Server;
  let hookUrl: string;
  let hookCalls: { path: string; body: string }[];
  let hookHold: Promise<void> | null;
  let admin: Client;
  let events: { event: string; data: Record<string, unknown> }[];
  const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);
  const put = (c: Client, url: string, body: object) => c.agent.put(url).set('x-csrf-token', c.csrf).send(body);

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000', WORKFLOW_HTTP_ALLOW_LOOPBACK: 'true' });
    ollama = await new FakeOllama().start();
    await seed(h, ollama);
    hookCalls = [];
    hookHold = null;
    hook = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        hookCalls.push({ path: req.url ?? '', body });
        if (hookHold) await hookHold;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: 'doc-1' }));
      });
    });
    await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
    hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}`;
    await localUser(h, 'wadmin', ['workflow-admin', 'member'], 'confidential');
    await localUser(h, 'mem', ['member']);
    await localUser(h, 'cur', ['knowledge-curator']);
    admin = await loginAdmin(h, 'wadmin');
    events = [];
    h.s.bus.on<{ event: string; data: Record<string, unknown> }>(TOPICS.chatEvent, (e) => events.push(e));
  });
  afterEach(async () => {
    hook.closeAllConnections();
    await new Promise((r) => hook.close(r));
    await h.close();
    await ollama.stop();
  });

  async function publishNotes() {
    const w = (await post(admin, '/api/workflows', { name: 'video-to-notes', label: 'internal' }).expect(201)).body;
    expect(w.draft.nodes.map((n: { kind: string }) => n.kind)).toEqual(['trigger']);
    await put(admin, `/api/workflows/${w.id}/draft`, { graph: notesGraph(hookUrl), rev: w.draftRev }).expect(200);
    const pub = (await post(admin, `/api/workflows/${w.id}/publish`, { note: 'first' }).expect(200)).body;
    expect(pub.version).toBe(1);
    return w.id as string;
  }

  it('refuses to publish an invalid graph, naming every problem, and publishes versions once it is fixed', async () => {
    const w = (await post(admin, '/api/workflows', { name: 'notes', label: 'internal' }).expect(201)).body;
    const g = notesGraph(hookUrl);
    g.edges.push({ from: 'shape', to: 'summarise' });
    const saved = (await put(admin, `/api/workflows/${w.id}/draft`, { graph: g, rev: w.draftRev }).expect(200)).body;
    expect(saved.validation.ok).toBe(false);
    // Someone else's revision is stale now.
    await put(admin, `/api/workflows/${w.id}/draft`, { graph: g, rev: w.draftRev }).expect(409);
    const refused = await post(admin, `/api/workflows/${w.id}/publish`).expect(422);
    expect(refused.headers['content-type']).toMatch(/problem\+json/);
    expect(refused.body.errors[0]).toMatchObject({ code: 'cycle', edge: { from: 'shape', to: 'summarise' } });
    expect(refused.body.trace_id).toBeTruthy();

    await put(admin, `/api/workflows/${w.id}/draft`, { graph: notesGraph(hookUrl), rev: saved.draftRev }).expect(200);
    expect((await post(admin, `/api/workflows/${w.id}/publish`).expect(200)).body.version).toBe(1);
    const g2 = notesGraph(hookUrl);
    g2.nodes[1]!.title = 'Summarise briefly';
    const v = (await put(admin, `/api/workflows/${w.id}/draft`, { graph: g2 }).expect(200)).body;
    expect(v.dirty).toBe(true);
    expect((await post(admin, `/api/workflows/${w.id}/publish`).expect(200)).body.version).toBe(2);
    const view = (await admin.agent.get(`/api/workflows/${w.id}`).expect(200)).body;
    expect(view.versions.map((x: { version: number; state: string }) => `${x.version}:${x.state}`)).toEqual(['2:published', '1:deprecated']);
    expect(view.dirty).toBe(false);

    // Members may run workflows but not edit them.
    await localUser(h, 'm2', ['member']);
    const m = await login(h, 'm2');
    await put(m, `/api/workflows/${w.id}/draft`, { graph: g2 }).expect(403);
    const actions = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).select('action')).map((x: { action: string }) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['workflow.created', 'workflow.draft.saved', 'workflow.publish.refused', 'workflow.published']));
  });

  it('runs durably: checkpoints each step sealed, pauses on approval, resumes when approved, and replays from a step', async () => {
    const id = await publishNotes();
    const mem = await login(h, 'mem');
    const started = (await post(mem, `/api/workflows/${id}/runs`, { input: { topic: 'budgets' } }).expect(202)).body;
    await post(mem, `/api/workflows/${id}/runs`, { input: { subject: 'x' } }).expect(400); // input must match the trigger
    await h.s.jobs.runDue();

    let run = (await mem.agent.get(`/api/workflow-runs/${started.id}`).expect(200)).body;
    expect(run.state).toBe('waiting');
    const st = Object.fromEntries(run.steps.map((s: { nodeId: string; state: string }) => [s.nodeId, s.state]));
    expect(st).toEqual({ trigger: 'passed', summarise: 'passed', shape: 'passed', check: 'passed', other: 'skipped', approve: 'waiting' });
    expect(run.steps.find((s: { nodeId: string }) => s.nodeId === 'shape').output).toEqual({ summary: 'You said: Summarise budgets', topic: 'budgets' });
    expect(run.steps.find((s: { nodeId: string }) => s.nodeId === 'summarise').detail).toMatchObject({ model: 'llama3.1:8b', profile: 'general' });
    // Tenant content is sealed at rest.
    const raw = await h.s.db('workflow_steps').where({ run_id: started.id, node_id: 'shape' }).first();
    expect(raw.output).toMatch(/^v2\./);
    expect(raw.output).not.toContain('budgets');
    expect(await h.s.db('usage_records').where({ tenant_id: h.tenantId, kind: 'workflow' })).toHaveLength(1);

    // Only the named role decides; the run owner does not hold it.
    const approval = run.approvals[0];
    expect(approval).toMatchObject({ role: 'knowledge-curator', state: 'pending', shown: 'You said: Summarise budgets', canDecide: false });
    await post(mem, `/api/workflow-approvals/${approval.id}`, { decision: 'approve' }).expect(403);
    const cur = await login(h, 'cur');
    const pending = (await cur.agent.get('/api/workflow-approvals').expect(200)).body;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ workflow: 'video-to-notes', step: 'Approval', canDecide: true });
    expect((await cur.agent.get(`/api/workflow-runs/${started.id}`).expect(200)).body.state).toBe('waiting');
    const notes = await h.s.db('notifications').where({ title: 'Workflow approval pending' });
    expect(notes).toHaveLength(1);

    await post(cur, `/api/workflow-approvals/${approval.id}`, { decision: 'approve', reason: 'fine' }).expect(200);
    await post(cur, `/api/workflow-approvals/${approval.id}`, { decision: 'approve' }).expect(409);
    await h.s.jobs.runDue();
    run = (await mem.agent.get(`/api/workflow-runs/${started.id}`).expect(200)).body;
    expect(run.state).toBe('succeeded');
    expect(hookCalls).toHaveLength(1);
    expect(hookCalls[0]!.path).toBe('/hook/budgets');
    expect(JSON.parse(hookCalls[0]!.body)).toEqual({ summary: 'You said: Summarise budgets', topic: 'budgets' });
    expect(run.steps.find((s: { nodeId: string }) => s.nodeId === 'post').output).toEqual({ status: 200, body: { ok: true, id: 'doc-1' } });
    expect(run.approvals[0]).toMatchObject({ state: 'approved', decidedByName: 'CUR', reason: 'fine' });

    // Live step updates went to the run owner.
    const stepEvents = events.filter((e) => e.event === 'workflow.step' && e.data.runId === started.id);
    expect(stepEvents.map((e) => `${e.data.nodeId}:${e.data.state}`)).toEqual(expect.arrayContaining(['summarise:running', 'summarise:passed', 'approve:waiting', 'approve:passed', 'post:passed']));
    expect(events.find((e) => e.event === 'workflow.run' && e.data.state === 'succeeded')).toBeTruthy();

    // Replay from Shape: Summarise keeps its checkpoint (no second model call); Shape and after run again.
    const chats = () => ollama.requests.filter((r) => r.path === '/api/chat').length;
    expect(chats()).toBe(1);
    const again = (await post(mem, `/api/workflow-runs/${started.id}/replay`, { from: 'shape' }).expect(202)).body;
    expect(again).toMatchObject({ replayOf: started.id, replayFrom: 'shape' });
    await h.s.jobs.runDue();
    const r2 = (await mem.agent.get(`/api/workflow-runs/${again.id}`).expect(200)).body;
    expect(r2.state).toBe('waiting');
    expect(r2.steps.find((s: { nodeId: string }) => s.nodeId === 'summarise').detail.reused).toBe(started.id);
    expect(chats()).toBe(1);
    const history = (await mem.agent.get(`/api/workflows/${id}/runs`).expect(200)).body;
    expect(history.map((x: { id: string }) => x.id)).toEqual([again.id, started.id]);
  });

  it('ends a run as rejected when the approver rejects, and skips what depends on the step', async () => {
    const id = await publishNotes();
    const mem = await login(h, 'mem');
    const started = (await post(mem, `/api/workflows/${id}/runs`, { input: { topic: 'hiring' } }).expect(202)).body;
    await h.s.jobs.runDue();
    const cur = await login(h, 'cur');
    const [a] = (await cur.agent.get('/api/workflow-approvals').expect(200)).body;
    await post(cur, `/api/workflow-approvals/${a.id}`, { decision: 'reject', reason: 'not for the KB' }).expect(200);
    await h.s.jobs.runDue();
    const run = (await mem.agent.get(`/api/workflow-runs/${started.id}`).expect(200)).body;
    expect(run.state).toBe('rejected');
    const st = Object.fromEntries(run.steps.map((s: { nodeId: string; state: string }) => [s.nodeId, s.state]));
    expect(st.approve).toBe('failed');
    expect(st.post).toBe('skipped');
    expect(hookCalls).toHaveLength(0);
    expect(await h.s.db('notifications').where({ title: 'video-to-notes: rejected' })).toHaveLength(1);
  });

  it('dry runs the draft with mocked models and calls, and lets the owner decide its approvals', async () => {
    const w = (await post(admin, '/api/workflows', { name: 'draft-only', label: 'internal' }).expect(201)).body;
    await put(admin, `/api/workflows/${w.id}/draft`, { graph: notesGraph(hookUrl) }).expect(200);
    await post(admin, `/api/workflows/${w.id}/runs`, { input: { topic: 'x' } }).expect(409); // nothing published yet
    const dry = (await post(admin, `/api/workflows/${w.id}/dry-run`, { input: { topic: 'travel' } }).expect(202)).body;
    expect(dry.mode).toBe('dry');
    await h.s.jobs.runDue();
    let run = (await admin.agent.get(`/api/workflow-runs/${dry.id}`).expect(200)).body;
    // The mocked answer does not contain "You said", so the branch goes the other way.
    expect(run.state).toBe('succeeded');
    expect(run.steps.find((s: { nodeId: string }) => s.nodeId === 'summarise')).toMatchObject({ state: 'passed', detail: { mocked: true }, output: { text: 'Mocked answer for Summarise.' } });
    expect(run.steps.find((s: { nodeId: string }) => s.nodeId === 'approve').state).toBe('skipped');

    // Force the approval branch: the owner of a dry run decides it; nothing is called or metered.
    const g = notesGraph(hookUrl);
    g.nodes.find((n) => n.id === 'check')!.config = { left: '{{steps.shape.summary}}', op: 'contains', right: 'Mocked' };
    const saved = (await put(admin, `/api/workflows/${w.id}/draft`, { graph: g }).expect(200)).body;
    const dry2 = (await post(admin, `/api/workflows/${w.id}/dry-run`, { input: { topic: 'travel' } }).expect(202)).body;
    await h.s.jobs.runDue();
    run = (await admin.agent.get(`/api/workflow-runs/${dry2.id}`).expect(200)).body;
    expect(run.state).toBe('waiting');
    expect(run.approvals[0].canDecide).toBe(true);
    await post(admin, `/api/workflow-approvals/${run.approvals[0].id}`, { decision: 'approve' }).expect(200);
    await h.s.jobs.runDue();
    run = (await admin.agent.get(`/api/workflow-runs/${dry2.id}`).expect(200)).body;
    expect(run.state).toBe('succeeded');
    expect(run.steps.find((s: { nodeId: string }) => s.nodeId === 'post')).toMatchObject({ detail: { mocked: true }, output: { status: 200, body: null } });
    expect(hookCalls).toHaveLength(0);
    expect(ollama.requests.filter((r) => r.path === '/api/chat')).toHaveLength(0);
    expect(await h.s.db('usage_records').where({ kind: 'workflow' })).toHaveLength(0);
    expect(await h.s.db('notifications').where({ title: 'Workflow approval pending' })).toHaveLength(0);
    expect(saved.draftRev).toBeGreaterThan(w.draftRev);

    // A step above its label ceiling is blocked at run time; the rest of the run is reported.
    g.nodes.find((n) => n.id === 'post')!.ceiling = 'public';
    await put(admin, `/api/workflows/${w.id}/draft`, { graph: g }).expect(200);
    const dry3 = (await post(admin, `/api/workflows/${w.id}/dry-run`, { input: { topic: 'travel' } }).expect(202)).body;
    await h.s.jobs.runDue();
    const [a3] = (await admin.agent.get('/api/workflow-approvals').expect(200)).body;
    await post(admin, `/api/workflow-approvals/${a3.id}`, { decision: 'approve' }).expect(200);
    await h.s.jobs.runDue();
    run = (await admin.agent.get(`/api/workflow-runs/${dry3.id}`).expect(200)).body;
    expect(run.state).toBe('failed');
    expect(run.steps.find((s: { nodeId: string }) => s.nodeId === 'post')).toMatchObject({ state: 'blocked', error: 'Blocked by label ceiling: Post to hook has ceiling public; the data arriving is internal.' });
  });

  it('resumes after an instance stops mid-run without running completed steps again', async () => {
    const w = (await post(admin, '/api/workflows', { name: 'resume', label: 'internal' }).expect(201)).body;
    const g: WfGraph = {
      nodes: [
        { id: 'trigger', kind: 'trigger', title: 'Trigger', x: 0, y: 0, config: {} },
        { id: 'sum', kind: 'model', title: 'Summarise', x: 0, y: 0, config: { profile: 'general', prompt: 'Summarise {{input.topic}}' } },
        { id: 'total', kind: 'calc', title: 'Total', x: 0, y: 0, config: { expression: '1250 * 1.07 / 12' } },
        { id: 'post', kind: 'http', title: 'Post', x: 0, y: 0, config: { method: 'POST', url: `${hookUrl}/slow`, body: '{{steps.total.value}}' } }
      ],
      edges: [
        { from: 'trigger', to: 'sum' },
        { from: 'sum', to: 'total' },
        { from: 'total', to: 'post' }
      ],
      limits: {}
    };
    await put(admin, `/api/workflows/${w.id}/draft`, { graph: g }).expect(200);
    await post(admin, `/api/workflows/${w.id}/publish`).expect(200);
    const started = (await post(admin, `/api/workflows/${w.id}/runs`, { input: { topic: 'q3' } }).expect(202)).body;

    let release!: () => void;
    hookHold = new Promise((r) => (release = r));
    const first = h.s.jobs.runDue(1);
    for (let i = 0; i < 200 && !hookCalls.length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(hookCalls).toHaveLength(1);
    // The instance shuts down while the HTTP step is in flight.
    await h.s.jobs.stop();
    await first;
    // The step's own abort handling gives the run back (it finishes just after the queue has moved on).
    const state = async () => (await h.s.db('workflow_runs').where({ id: started.id }).first()).state as string;
    for (let i = 0; i < 100 && (await state()) !== 'queued'; i++) await new Promise((r) => setTimeout(r, 10));
    expect(await state()).toBe('queued');
    release();
    hookHold = null;

    // Another worker picks the job up and continues from the last checkpoint.
    await h.s.jobs.runDue();
    const run = (await admin.agent.get(`/api/workflow-runs/${started.id}`).expect(200)).body;
    expect(run.state).toBe('succeeded');
    const attempts = Object.fromEntries(run.steps.map((s: { nodeId: string; attempts: number }) => [s.nodeId, s.attempts]));
    expect(attempts).toEqual({ trigger: 1, sum: 1, total: 1, post: 2 });
    expect(run.steps.find((s: { nodeId: string }) => s.nodeId === 'total').output).toEqual({ value: '111.4583333333333333333333333333333333333333', fraction: '2675/24', exact: false });
    expect(ollama.requests.filter((r) => r.path === '/api/chat')).toHaveLength(1);
    expect(hookCalls.map((c) => c.body)).toEqual(['111.4583333333333333333333333333333333333333', '111.4583333333333333333333333333333333333333']);
  });

  it('cancels a waiting run and refuses deletion while runs are active', async () => {
    const id = await publishNotes();
    const started = (await post(admin, `/api/workflows/${id}/runs`, { input: { topic: 'x' } }).expect(202)).body;
    await h.s.jobs.runDue();
    await admin.agent.delete(`/api/workflows/${id}`).set('x-csrf-token', admin.csrf).expect(409);
    expect((await post(admin, `/api/workflow-runs/${started.id}/cancel`).expect(200)).body.state).toBe('cancelled');
    const run = (await admin.agent.get(`/api/workflow-runs/${started.id}`).expect(200)).body;
    expect(run.approvals[0].state).toBe('expired');
    await admin.agent.delete(`/api/workflows/${id}`).set('x-csrf-token', admin.csrf).expect(204);
  });
});
