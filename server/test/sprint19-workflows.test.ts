/*
 * Sprint 19, workflows, images and scripts: a workflow tool that pauses gives its caller a pending result the agent
 * run awaits, and the run resumes when the workflow's approval completes; approval timeouts per step; run events
 * live to approvers (B-1006); IMAGE_SAFETY_REQUIRED withholds what nothing classified (B-1007); the gVisor runtime
 * for script containers (B-1008).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { TOPICS } from '../src/platform/bus.js';
import { ContainerRunner, DEFAULT_LIMITS, type Probe } from '../src/scripts/runner.js';
import type { WfGraph } from '../src/workflows/graph.js';
import { noSafety } from '../src/images/safety.js';
import { FakeOllama } from './fake-ollama.js';
import { seedGateway } from './seed-gateway.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';
import { FakeImageBackend, harness8 } from './sprint8-fakes.js';
import { FakeRunner } from './fake-runner.js';

const TOPIC = { type: 'object' as const, properties: { topic: { type: 'string' as const } }, required: ['topic'] };
const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);
const put = (c: Client, url: string, body: object) => c.agent.put(url).set('x-csrf-token', c.csrf).send(body);

describe('B-1006: workflows as awaited tools, approval timeouts, live approvers', () => {
  let h: Harness;
  let ollama: FakeOllama;
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  it('a calling agent run resumes when the workflow\'s approval completes', async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    ollama = await new FakeOllama().start();
    ollama.chatDelayMs = 0;
    await seedGateway(h, ollama);
    await localUser(h, 'wadmin', ['workflow-admin', 'member'], 'confidential');
    await localUser(h, 'tadmin', ['tool-admin'], 'confidential');
    await localUser(h, 'tadmin2', ['tool-admin'], 'confidential');
    await localUser(h, 'approver', ['workflow-admin'], 'confidential');
    const admin = await loginAdmin(h, 'wadmin');
    const t = await loginAdmin(h, 'tadmin');
    const t2 = await loginAdmin(h, 'tadmin2');
    const approver = await loginAdmin(h, 'approver');

    // A workflow that needs an approval before it answers, published as a read tool and reviewed.
    const g: WfGraph = {
      nodes: [
        { id: 'trigger', kind: 'trigger', title: 'Trigger', x: 20, y: 24, config: { source: 'api' }, output: TOPIC },
        { id: 'ok', kind: 'approval', title: 'Sign-off', x: 230, y: 24, config: { role: 'workflow-admin', timeoutMs: 3_600_000, show: 'Notes on {{input.topic}}' } },
        { id: 'shape', kind: 'transform', title: 'Shape', x: 440, y: 24, config: { fields: { summary: 'Approved notes on {{input.topic}}' } } }
      ],
      edges: [{ from: 'trigger', to: 'ok' }, { from: 'ok', to: 'shape' }],
      limits: {}
    };
    const w = (await post(admin, '/api/workflows', { name: 'signed-notes', label: 'internal' }).expect(201)).body;
    await put(admin, `/api/workflows/${w.id}/draft`, { graph: g }).expect(200);
    await post(admin, `/api/workflows/${w.id}/publish`).expect(200);
    const entry = (await post(admin, `/api/workflows/${w.id}/tool`, { name: 'workflow.signed-notes', description: 'Writes signed-off notes on a topic after a workflow admin approves them, and returns the summary.' }).expect(201)).body;
    await post(t, `/api/admin/registry/${entry.id}/review`, { decision: 'approve' }).expect(200);

    // An agent that calls it.
    const agent = (await post(t, '/api/admin/registry', { kind: 'agent', name: 'Note taker', version: '1.0.0', description: 'Asks the signed-notes workflow for notes on a topic and reports the summary it returns.', label: 'confidential', definition: { profile: 'general', systemPrompt: 'Be brief.', tools: ['workflow.signed-notes'], budgets: { steps: 10, tokens: 10000, wallSeconds: 600, toolCalls: 4 } } }).expect(201)).body;
    await post(t, `/api/admin/registry/${agent.id}/submit`).expect(200);
    await post(t2, `/api/admin/registry/${agent.id}/review`, { decision: 'approve' }).expect(200);
    ollama.reply = (messages) => {
      const last = messages[messages.length - 1]!;
      if (last.role === 'tool') return { content: `Result: ${last.content}` };
      return { content: 'Asking the workflow.', toolCall: { name: 'workflow_signed-notes', arguments: { topic: 'budgets' } } };
    };

    // Everything the approver's sockets would receive.
    const approverId = (await h.s.users.byUsername(h.tenantId, 'approver'))!.id;
    const toApprover: { event: string; data: Record<string, unknown> }[] = [];
    h.s.bus.on<{ userId: string; event: string; data: Record<string, unknown> }>(TOPICS.chatEvent, (e) => {
      if (e.userId === approverId) toApprover.push({ event: e.event, data: e.data });
    });

    await localUser(h, 'mem', ['member'], 'confidential');
    const m = await login(h, 'mem');
    const run = (await post(m, '/api/runs', { agent: 'Note taker', input: 'Notes on budgets please', label: 'internal' }).expect(202)).body;
    await h.s.jobs.runDue();
    let v = (await m.agent.get(`/api/runs/${run.id}`).expect(200)).body;
    expect(v.state).toBe('waiting');
    const waiting = v.steps.find((s: { state: string }) => s.state === 'waiting');
    expect(waiting).toMatchObject({ lane: 'do', title: 'workflow.signed-notes', meta: { awaiting: { kind: 'workflow-run' } } });
    const wfRunId = waiting.meta.awaiting.id as string;
    expect(await h.s.db('workflow_runs').where({ id: wfRunId }).first()).toMatchObject({ state: 'waiting', caller_kind: 'agent-run', caller_id: run.id, trigger: 'tool' });
    // The step waits on the workflow, not on an approval of the agent's own.
    const d = await post(m, `/api/runs/${run.id}/steps/${waiting.n}/decision`, { decision: 'approve' });
    expect(d.status).toBe(409);
    // The approver sees the run live and is told about the approval.
    expect(toApprover.some((e) => e.event === 'workflow.approval' && e.data.runId === wfRunId && e.data.state === 'pending')).toBe(true);
    expect(toApprover.some((e) => e.event === 'workflow.step' && e.data.runId === wfRunId && e.data.state === 'waiting')).toBe(true);

    // Nothing happens while the approval is pending.
    await h.s.jobs.runDue();
    expect((await m.agent.get(`/api/runs/${run.id}`).expect(200)).body.state).toBe('waiting');

    const [a] = (await approver.agent.get('/api/workflow-approvals').expect(200)).body;
    expect(a.runId).toBe(wfRunId);
    await post(approver, `/api/workflow-approvals/${a.id}`, { decision: 'approve' }).expect(200);
    await h.s.jobs.runDue();
    await h.s.jobs.runDue();
    v = (await m.agent.get(`/api/runs/${run.id}`).expect(200)).body;
    expect(v.state).toBe('succeeded');
    expect(v.output).toContain('Approved notes on budgets');
    expect(v.steps.map((s: { n: number; lane: string; state: string }) => [s.n, s.lane, s.state])).toEqual([[1, 'think', 'ok'], [2, 'do', 'ok'], [3, 'think', 'ok']]);
    expect(v.steps[1].detail.result).toMatchObject({ run: wfRunId, output: { summary: 'Approved notes on budgets' } });
    expect(v.usage).toMatchObject({ toolCalls: 1, steps: 3 });
    expect(toApprover.some((e) => e.event === 'workflow.run' && e.data.runId === wfRunId && e.data.state === 'succeeded')).toBe(true);
    // The approver hears about the workflow run only, never the agent run that called it.
    expect(toApprover.every((e) => e.data.runId === wfRunId)).toBe(true);
  });

  it('a rejected workflow gives the awaiting agent run its failure as the tool result', async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    ollama = await new FakeOllama().start();
    ollama.chatDelayMs = 0;
    await seedGateway(h, ollama);
    await localUser(h, 'wadmin', ['workflow-admin', 'member'], 'confidential');
    await localUser(h, 'tadmin', ['tool-admin'], 'confidential');
    await localUser(h, 'tadmin2', ['tool-admin'], 'confidential');
    const admin = await loginAdmin(h, 'wadmin');
    const t = await loginAdmin(h, 'tadmin');
    const t2 = await loginAdmin(h, 'tadmin2');
    const g: WfGraph = {
      nodes: [
        { id: 'trigger', kind: 'trigger', title: 'Trigger', x: 20, y: 24, config: { source: 'api' }, output: TOPIC },
        { id: 'ok', kind: 'approval', title: 'Sign-off', x: 230, y: 24, config: { role: 'workflow-admin' } }
      ],
      edges: [{ from: 'trigger', to: 'ok' }],
      limits: {}
    };
    const w = (await post(admin, '/api/workflows', { name: 'gate', label: 'internal' }).expect(201)).body;
    await put(admin, `/api/workflows/${w.id}/draft`, { graph: g }).expect(200);
    await post(admin, `/api/workflows/${w.id}/publish`).expect(200);
    const entry = (await post(admin, `/api/workflows/${w.id}/tool`, { name: 'workflow.gate', description: 'Passes a topic through a sign-off gate kept by the workflow admins and returns what it passed.' }).expect(201)).body;
    await post(t, `/api/admin/registry/${entry.id}/review`, { decision: 'approve' }).expect(200);
    const agent = (await post(t, '/api/admin/registry', { kind: 'agent', name: 'Gatekeeper', version: '1.0.0', description: 'Sends a topic through the sign-off gate workflow and reports what the gate decided.', label: 'confidential', definition: { profile: 'general', systemPrompt: 'Be brief.', tools: ['workflow.gate'], budgets: { steps: 10, tokens: 10000, wallSeconds: 600, toolCalls: 4 } } }).expect(201)).body;
    await post(t, `/api/admin/registry/${agent.id}/submit`).expect(200);
    await post(t2, `/api/admin/registry/${agent.id}/review`, { decision: 'approve' }).expect(200);
    ollama.reply = (messages) => {
      const last = messages[messages.length - 1]!;
      if (last.role === 'tool') return { content: `Gate said: ${last.content}` };
      return { content: 'Gate.', toolCall: { name: 'workflow_gate', arguments: { topic: 'x' } } };
    };
    await localUser(h, 'mem', ['member'], 'confidential');
    const m = await login(h, 'mem');
    const run = (await post(m, '/api/runs', { agent: 'Gatekeeper', input: 'Go', label: 'internal' }).expect(202)).body;
    await h.s.jobs.runDue();
    const [a] = (await admin.agent.get('/api/workflow-approvals').expect(200)).body;
    await post(admin, `/api/workflow-approvals/${a.id}`, { decision: 'reject', reason: 'not now' }).expect(200);
    await h.s.jobs.runDue();
    await h.s.jobs.runDue();
    const v = (await m.agent.get(`/api/runs/${run.id}`).expect(200)).body;
    expect(v.state).toBe('succeeded');
    expect(v.steps[1]).toMatchObject({ state: 'failed', detail: { error: expect.stringMatching(/rejected/) } });
    expect(v.output).toMatch(/rejected/);
  });

  it('pauses a guardrail step for its approver with the step\'s own timeout', async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    ollama = await new FakeOllama().start();
    await localUser(h, 'wadmin', ['workflow-admin', 'member'], 'confidential');
    const admin = await loginAdmin(h, 'wadmin');
    h.s.guardrails = { check: async (i) => (i.source?.kind === 'workflow-step' ? { action: 'require-approval', text: i.text, reason: 'Needs a look.', findings: [] } : { action: 'allow', text: i.text, findings: [] }) };
    const g: WfGraph = {
      nodes: [
        { id: 'trigger', kind: 'trigger', title: 'Trigger', x: 20, y: 24, config: { source: 'manual' }, output: TOPIC },
        { id: 'check', kind: 'guardrail', title: 'Check', x: 230, y: 24, config: { checkpoint: 'context', text: '{{input.topic}}', approverRole: 'workflow-admin', approvalTimeoutMs: 2 * 3_600_000 } }
      ],
      edges: [{ from: 'trigger', to: 'check' }],
      limits: {}
    };
    const w = (await post(admin, '/api/workflows', { name: 'checked', label: 'internal' }).expect(201)).body;
    const bad = await put(admin, `/api/workflows/${w.id}/draft`, { graph: { ...g, nodes: [g.nodes[0]!, { ...g.nodes[1]!, config: { ...g.nodes[1]!.config, approvalTimeoutMs: 1000 } }] } });
    expect(bad.body.validation.errors).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: 'check' })]));
    await put(admin, `/api/workflows/${w.id}/draft`, { graph: g }).expect(200);
    await post(admin, `/api/workflows/${w.id}/publish`).expect(200);
    const started = (await post(admin, `/api/workflows/${w.id}/runs`, { input: { topic: 'x' } }).expect(202)).body;
    await h.s.jobs.runDue();
    const a = (await h.s.db('workflow_approvals').where({ run_id: started.id }).first()) as { due_at: number; created_at: number };
    expect(Number(a.due_at) - Number(a.created_at)).toBeGreaterThanOrEqual(2 * 3_600_000 - 1000);
    expect(Number(a.due_at) - Number(a.created_at)).toBeLessThanOrEqual(2 * 3_600_000 + 1000);
  });
});

describe('B-1007: IMAGE_SAFETY_REQUIRED', () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it('with the setting on and no classifier, generation returns withheld', async () => {
    const backend = new FakeImageBackend();
    h = await harness8({ IMAGE_SAFETY_REQUIRED: 'true' }, { imageBackends: [backend], imageSafety: noSafety });
    await localUser(h, 'mem', ['member']);
    const m = await login(h, 'mem');
    expect((await m.agent.get('/api/images/backends').expect(200)).body.safety).toEqual({ classifier: null, threshold: 0.5, required: true });
    const out = (await post(m, '/api/images', { backend: 'fake-sdxl', width: 1024, height: 768, prompt: 'A loading bay', count: 1 }).expect(202)).body;
    await h.s.jobs.runDue();
    const img = (await m.agent.get(`/api/images/${out.images[0].id}`).expect(200)).body;
    expect(img).toMatchObject({ state: 'withheld', stage: 'Withheld: no image-safety classifier is configured', safety: null, gpuSeconds: 1.5 });
    expect((await h.s.db('image_jobs').where({ id: img.id }).first()).blob_key).toBeNull();
    const dl = await m.agent.get(`/api/images/${img.id}/download`).expect(409);
    expect(dl.body.detail).toMatch(/no image-safety classifier is configured/);
    const ev = (await h.s.db('audit_events').where({ action: 'image.withheld' }).first()) as { detail: string };
    expect(JSON.parse(ev.detail)).toMatchObject({ reason: 'not classified', required: true });
  });

  it('with the setting off, an unclassified image is kept and marked not classified', async () => {
    const backend = new FakeImageBackend();
    h = await harness8({}, { imageBackends: [backend], imageSafety: noSafety });
    await localUser(h, 'mem', ['member']);
    const m = await login(h, 'mem');
    const out = (await post(m, '/api/images', { backend: 'fake-sdxl', width: 1024, height: 768, prompt: 'A loading bay', count: 1 }).expect(202)).body;
    await h.s.jobs.runDue();
    expect((await m.agent.get(`/api/images/${out.images[0].id}`).expect(200)).body).toMatchObject({ state: 'succeeded', classified: false });
  });
});

describe('B-1008: SCRIPT_RUNTIME', () => {
  const images = { python: 'python:3.13-slim', javascript: 'node:22-slim' };
  const probe =
    (runtimes: string[]): Probe =>
    async (_bin, args) =>
      args[0] === 'version' ? { code: 0, stdout: 'ok' } : { code: 0, stdout: JSON.stringify(Object.fromEntries(runtimes.map((r) => [r, { path: r }]))) };

  it('passes --runtime=runsc to docker and reports it', async () => {
    const r = new ContainerRunner('docker', images, { runtime: 'runsc', probe: probe(['runc', 'runsc']) });
    const args = r.args({ id: '01ABC', language: 'python', source: 'print(1)', limits: DEFAULT_LIMITS });
    expect(args.slice(0, 4)).toEqual(['run', '--rm', '-i', '--runtime=runsc']);
    for (const flag of ['--network', '--read-only', '--cap-drop']) expect(args).toContain(flag);
    expect(r.name).toBe('docker (runsc)');
    expect(r.ociRuntime).toBe('runsc');
    expect(await r.available()).toBe(true);
    // Without the setting nothing changes.
    const plain = new ContainerRunner('docker', images, { probe: probe(['runc']) });
    expect(plain.args({ id: '01ABC', language: 'python', source: 'print(1)', limits: DEFAULT_LIMITS }).some((a) => a.startsWith('--runtime'))).toBe(false);
    expect(plain.name).toBe('docker');
  });

  it('refuses runs when docker does not know the runtime, rather than running under runc', async () => {
    const r = new ContainerRunner('docker', images, { runtime: 'runsc', probe: probe(['runc']) });
    expect(await r.available()).toBe(false);
    expect(r.runtimeProblem).toMatch(/does not list the runsc runtime/);
    await expect(r.run({ id: '01ABC', language: 'python', source: 'print(1)', limits: DEFAULT_LIMITS })).rejects.toThrow(/does not list the runsc runtime/);
  });

  it('shows the runtime on the scripts screen\'s runtime view', async () => {
    const h = await harness({ SCRIPT_RUNNER: 'docker', SCRIPT_RUNTIME: 'runsc' });
    try {
      expect(h.s.scripts.runner.name).toBe('docker (runsc)');
      h.s.scripts.runner = Object.assign(new FakeRunner(), { ociRuntime: 'runsc' });
      await localUser(h, 'w', ['workflow-admin', 'member'], 'confidential');
      const w = await loginAdmin(h, 'w');
      expect((await w.agent.get('/api/scripts/runtime').expect(200)).body).toMatchObject({ runner: 'fake', runtime: 'runsc', available: true });
    } finally {
      await h.close();
    }
  });
});
