/*
 * Tools and scripts in workflows: the `script` step kind (a tenant script run directly, by name and version, in the
 * script sandbox), and tool steps calling MCP and script-backed registry tools through the dispatcher.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '../src/authz/policy.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { HttpProblem } from '../src/http/problem.js';
import type { WfGraph, WfNode } from '../src/workflows/graph.js';
import { FakeMcp } from './fake-mcp.js';
import { FakeRunner } from './fake-runner.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';

const SUM = 'import json, sys\nd = json.load(sys.stdin)\nprint(json.dumps({"total": sum(d["values"])}))';
const VALUES = { type: 'object' as const, properties: { values: { type: 'array' as const, items: { type: 'number' as const } } }, required: ['values'] };
const trigger = (): WfNode => ({ id: 'trigger', kind: 'trigger', title: 'Trigger', x: 20, y: 20, config: { source: 'api' }, output: VALUES });
const node = (id: string, kind: string, config: Record<string, unknown>, extra: Partial<WfNode> = {}): WfNode => ({ id, kind: kind as WfNode['kind'], title: id, x: 200, y: 20, config, ...extra });
const graph = (nodes: WfNode[], edges?: WfGraph['edges']): WfGraph => ({ nodes, edges: edges ?? nodes.slice(1).map((n, i) => ({ from: nodes[i]!.id, to: n.id })), limits: {} });
const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);

describe('workflow script steps', () => {
  let h: Harness;
  let runner: FakeRunner;
  let p: Principal;
  let mcp: FakeMcp | null = null;

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000', MCP_TIMEOUT_MS: '5000' });
    runner = new FakeRunner();
    h.s.scripts.runner = runner;
    runner.handler = (req) => ({ stdout: JSON.stringify({ total: ((JSON.parse(req.stdin || '{"values":[]}') as { values: number[] }).values ?? []).reduce((a, b) => a + b, 0) }) });
    const u = await localUser(h, 'wadmin', ['workflow-admin', 'member'], 'confidential');
    p = (await loadPrincipal(h.s, h.tenantId, u.id, {}))!;
  });
  afterEach(async () => {
    await h.close();
    await mcp?.stop();
    mcp = null;
  });

  async function drain(rounds = 10): Promise<void> {
    for (let i = 0; i < rounds; i++) if (!(await h.s.jobs.runDue())) break;
  }

  /** A script whose version 1 ran cleanly once (tested). */
  async function tested(name: string, label: 'internal' | 'confidential' = 'internal') {
    const s = await h.s.scripts.create(p, { name, language: 'python', source: SUM, label, limits: { timeoutSeconds: 30, memoryMb: 256, cpus: 1, pids: 32, outputKb: 64 } });
    await h.s.scripts.run(p, s, '{"values":[1]}');
    await drain();
    return h.s.scripts.get(p, s.id);
  }

  async function publishError(name: string, g: WfGraph, label: 'internal' | 'confidential' = 'internal', as: Principal = p): Promise<{ errors: { code: string; message: string; nodeId?: string }[] }> {
    const w = await h.s.workflows.create(p, { name, label, graph: g });
    const err = await h.s.workflows.publish(as, w.id, null).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(HttpProblem);
    expect((err as HttpProblem).status).toBe(422);
    return (err as HttpProblem).extensions as { errors: { code: string; message: string }[] };
  }

  const runOf = async (workflowId: string) => (await h.s.db('workflow_runs').where({ workflow_id: workflowId }).orderBy('created_at', 'desc').first()) as { id: string; state: string; error: string | null };
  const stepsOf = async (runId: string) => Object.fromEntries(((await h.s.db('workflow_steps').where({ run_id: runId })) as { node_id: string; state: string; error: string | null; attempts: number }[]).map((s) => [s.node_id, s]));
  const outputOf = async (runId: string, nodeId: string) => ((await h.s.workflows.runView(p, runId)) as unknown as { steps: { nodeId: string; output: Record<string, unknown>; detail: Record<string, unknown> }[] }).steps.find((s) => s.nodeId === nodeId)!;

  it('refuses at publish a missing script, an untested or unreviewed version, a script above the workflow label, and a publisher without scripts:run', async () => {
    let r = await publishError('missing', graph([trigger(), node('run', 'script', { script: 'nope.py' })]));
    expect(r.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'unavailable', nodeId: 'run', message: expect.stringMatching(/script nope\.py is not a script in this workspace/) })]));

    const fresh = await h.s.scripts.create(p, { name: 'fresh.py', language: 'python', source: SUM, label: 'internal', limits: { timeoutSeconds: 30, memoryMb: 256, cpus: 1, pids: 32, outputKb: 64 } });
    r = await publishError('unreviewed', graph([trigger(), node('run', 'script', { script: fresh.name })]));
    expect(r.errors[0]!.message).toMatch(/has no reviewed version/);
    r = await publishError('untested', graph([trigger(), node('run', 'script', { script: fresh.name, version: 1 })]));
    expect(r.errors[0]!.message).toMatch(/version 1 has not run cleanly yet/);
    r = await publishError('noversion', graph([trigger(), node('run', 'script', { script: fresh.name, version: 7 })]));
    expect(r.errors[0]!.message).toMatch(/has no version 7/);

    const secret = await tested('secret.py', 'confidential');
    r = await publishError('above', graph([trigger(), node('run', 'script', { script: secret.name, version: 1 })]), 'internal');
    expect(r.errors).toEqual([expect.objectContaining({ code: 'label', message: expect.stringMatching(/secret\.py is confidential, above this workflow's internal label/) })]);
    // The same script in a confidential workflow publishes.
    const ok = await h.s.workflows.create(p, { name: 'within', label: 'confidential', graph: graph([trigger(), node('run', 'script', { script: secret.name, version: 1 })]) });
    expect((await h.s.workflows.publish(p, ok.id, null)).version).toBe(1);

    // A publisher without scripts:run (here: a member) is refused; a dry run of the draft still works (mocked).
    const memberP: Principal = { ...p, roles: ['member'] };
    r = await publishError('noperm', graph([trigger(), node('run', 'script', { script: secret.name, version: 1 })]), 'confidential', memberP);
    expect(r.errors).toEqual([expect.objectContaining({ code: 'unavailable', message: expect.stringMatching(/needs the scripts:run permission/) })]);
    const v = await h.s.workflows.validate({ tenantId: h.tenantId, workspaceId: p.workspaceId ?? null }, graph([trigger(), node('run', 'script', { script: secret.name, version: 1 })]), 'confidential', undefined, p);
    expect(v.ok).toBe(true);
  });

  it('runs a tested script version in the sandbox, feeds its JSON output to the next step and records the run', async () => {
    const s = await tested('sum.py');
    runner.requests = [];
    const g = graph([trigger(), node('sum', 'script', { script: 'sum.py', version: 1, args: { values: '{{input.values}}' } }), node('report', 'transform', { fields: { total: '{{steps.sum.total}}', line: 'Total {{steps.sum.total}}' } })]);
    const w = await h.s.workflows.create(p, { name: 'adder', label: 'internal', graph: g });
    await h.s.workflows.publish(p, w.id, null);
    const run = await h.s.workflows.start(p, w.id, { input: { values: [2, 3, 4] }, dry: false });
    await drain();
    expect(await runOf(w.id)).toMatchObject({ state: 'succeeded' });
    expect(runner.requests).toHaveLength(1);
    expect(runner.requests[0]).toMatchObject({ language: 'python', source: SUM, stdin: '{"values":[2,3,4]}', limits: { timeoutSeconds: 30, memoryMb: 256, cpus: 1, pids: 32, outputKb: 64 } });
    const sum = await outputOf(run.id, 'sum');
    expect(sum.output).toEqual({ total: 9 });
    expect(sum.detail).toMatchObject({ script: 'sum.py', version: 1, basis: 'tested', exitCode: 0 });
    expect((await outputOf(run.id, 'report')).output).toEqual({ total: 9, line: 'Total 9' });
    // The run is in the script's history (sealed), and audited as the workflow's.
    const sr = (await h.s.db('script_runs').where({ script_id: s.id }).orderBy('created_at', 'desc').first()) as { state: string; stdout: string; created_by: string };
    expect(sr).toMatchObject({ state: 'succeeded', created_by: p.userId });
    expect(sr.stdout).not.toContain('total');
    const audit = (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'workflow.script.ran' })) as { target: string }[];
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.target)).toMatchObject({ workflow: w.id, run: run.id, node: 'sum', script: s.id, version: 1 });

    // Text output becomes {text}; a dry run calls nothing.
    runner.handler = () => ({ stdout: 'plain words\n' });
    const run2 = await h.s.workflows.start(p, w.id, { input: { values: [1] }, dry: false });
    await drain();
    expect((await outputOf(run2.id, 'sum')).output).toEqual({ text: 'plain words' });
    const before = runner.requests.length;
    await h.s.workflows.start(p, w.id, { input: { values: [1] }, dry: true });
    await drain();
    expect(runner.requests).toHaveLength(before);
  });

  it('takes the failure branch when the script fails, after its retries', async () => {
    await tested('flaky.py');
    runner.handler = () => ({ exitCode: 1, stderr: 'Traceback\nValueError: bad input' });
    const g = graph(
      [trigger(), node('run', 'script', { script: 'flaky.py', version: 1 }, { retry: { max: 1, delayMs: 1000, backoff: 'fixed' } }), node('recover', 'transform', { fields: { note: 'failed: {{steps.run.error}}', type: '{{steps.run.type}}' } }), node('after', 'transform', { fields: { ok: 'yes' } })],
      [{ from: 'trigger', to: 'run' }, { from: 'run', to: 'recover', branch: 'failure' }, { from: 'run', to: 'after' }]
    );
    const w = await h.s.workflows.create(p, { name: 'fallible', label: 'internal', graph: g });
    await h.s.workflows.publish(p, w.id, null);
    const run = await h.s.workflows.start(p, w.id, { input: { values: [1] }, dry: false });
    await drain();
    expect((await stepsOf(run.id)).run).toMatchObject({ state: 'waiting', attempts: 1 });
    const now = Date.now();
    await h.s.db('jobs').where('run_at', '>', now).update({ run_at: now - 1 });
    await h.s.db('workflow_steps').where({ state: 'waiting' }).whereNotNull('resume_at').update({ resume_at: now - 1 });
    await drain();
    expect(await runOf(w.id)).toMatchObject({ state: 'succeeded', error: null });
    expect(await stepsOf(run.id)).toMatchObject({ run: { state: 'failed', attempts: 2 }, recover: { state: 'passed' }, after: { state: 'skipped' } });
    expect((await outputOf(run.id, 'recover')).output).toMatchObject({ note: expect.stringMatching(/^failed: flaky\.py exited with 1: Traceback ValueError: bad input$/), type: 'failed' });
    expect(runner.requests.filter((r) => r.source === SUM)).toHaveLength(3); // the clean run, then two attempts
  });

  it('runs the reviewed version by default and holds a write script behind an Approval step', async () => {
    await localUser(h, 'tadmin', ['tool-admin'], 'confidential');
    const ta = await loginAdmin(h, 'tadmin');
    const s = await tested('total.py');
    const promo = { toolName: 'numbers.total', version: '1.0.0', description: 'Adds a list of numbers and returns the total as a number.', sideEffect: 'read' as const, label: 'confidential' as const, inputSchema: VALUES, outputSchema: { type: 'object', properties: { total: { type: 'number' } }, required: ['total'] } };
    const entry = await h.s.scripts.promote(p, s, promo);
    await post(ta, `/api/admin/registry/${entry.id}/review`, { decision: 'approve' }).expect(200);
    // A later edit (v2) does not change what an unpinned step runs: the reviewed v1.
    await h.s.scripts.update(p, (await h.s.scripts.get(p, s.id)), { source: SUM + '\n# v2' });
    runner.requests = [];
    const g = graph([trigger(), node('sum', 'script', { script: 'total.py', args: { values: '{{input.values}}' } })]);
    const w = await h.s.workflows.create(p, { name: 'reviewed', label: 'internal', graph: g });
    await h.s.workflows.publish(p, w.id, null);
    const run = await h.s.workflows.start(p, w.id, { input: { values: [5, 6] }, dry: false });
    await drain();
    expect(await runOf(w.id)).toMatchObject({ state: 'succeeded' });
    expect(runner.requests[0]!.source).toBe(SUM);
    expect((await outputOf(run.id, 'sum')).detail).toMatchObject({ basis: 'reviewed', tool: 'numbers.total', version: 1, valid: true });
    // An argument the reviewed tool's input schema does not name is refused at publish.
    const bad = await publishError('badargs', graph([trigger(), node('sum', 'script', { script: 'total.py', args: { numbers: '{{input.values}}' } })]));
    expect(bad.errors[0]).toMatchObject({ code: 'schema' });

    // A reviewed tool declared as a write needs an Approval step before the script step on every path.
    const w2 = await tested('writer.py');
    const e2 = await h.s.scripts.promote(p, w2, { ...promo, toolName: 'numbers.write', sideEffect: 'write' });
    await post(ta, `/api/admin/registry/${e2.id}/review`, { decision: 'approve' }).expect(200);
    const unguarded = await publishError('unguarded', graph([trigger(), node('run', 'script', { script: 'writer.py' })]));
    expect(unguarded.errors[0]!.message).toMatch(/put an Approval step before it on every path/);
    const guarded = await h.s.workflows.create(p, { name: 'guarded', label: 'internal', graph: graph([trigger(), node('ok', 'approval', { role: 'workflow-admin' }), node('run', 'script', { script: 'writer.py' })]) });
    expect((await h.s.workflows.publish(p, guarded.id, null)).version).toBe(1);
  });

  it('offers scripts in the editor callees and calls MCP and script tools from tool steps', async () => {
    await tested('listed.py');
    const callees = (await h.s.workflows.callees(p)) as unknown as { scripts: { name: string; reviewed: unknown; versions: { version: number }[] }[] };
    expect(callees.scripts).toEqual([expect.objectContaining({ name: 'listed.py', reviewed: null, versions: [expect.objectContaining({ version: 1, reviewed: false })] })]);
    expect(((await h.s.workflows.callees({ ...p, roles: ['member'] })) as unknown as { scripts: unknown[] }).scripts).toEqual([]);

    await localUser(h, 'tadmin', ['tool-admin'], 'confidential');
    const ta = await loginAdmin(h, 'tadmin');
    mcp = await new FakeMcp().start();
    mcp.tools = [{ name: 'lookup', description: 'Looks an item up.', inputSchema: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] }, run: (a) => ({ value: Number(a.n) * 2 }) }];
    const reg = (await post(ta, '/api/admin/mcp-servers', { name: 'kb', url: mcp.url }).expect(201)).body;
    await post(ta, `/api/admin/mcp-servers/${reg.id}/tools/lookup/approve`, { sideEffect: 'read', confirm: 'never', label: 'confidential' }).expect(200);
    const tools = await h.s.workflows.callableTools(p);
    expect(tools.find((t) => t.name === 'kb.lookup')).toMatchObject({ impl: 'mcp', sideEffect: 'read' });

    const g = graph([{ ...trigger(), output: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] } }, node('look', 'tool', { tool: 'kb.lookup', args: { n: '{{input.n}}' } }), node('out', 'transform', { fields: { doubled: '{{steps.look.value}}' } })]);
    const w = await h.s.workflows.create(p, { name: 'mcp-call', label: 'internal', graph: g });
    await h.s.workflows.publish(p, w.id, null);
    const run = await h.s.workflows.start(p, w.id, { input: { n: 21 }, dry: false });
    await drain();
    expect(await runOf(w.id)).toMatchObject({ state: 'succeeded' });
    expect((await outputOf(run.id, 'out')).output).toEqual({ doubled: 42 });
    expect(mcp.calls).toHaveLength(1);
  });
});
