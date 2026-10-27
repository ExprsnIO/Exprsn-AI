import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '../src/authz/policy.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { createLogger, Metrics } from '../src/observability/index.js';
import { createServices } from '../src/services.js';
import { validateGraph, type WfGraph } from '../src/workflows/graph.js';
import { nextRetryAt } from '../src/workflows/retry.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';
import { drain } from './retrieval-seed.js';
import { seedGateway } from './seed-gateway.js';
import { FakeClamd } from './sprint26d-fakes.js';

/*
 * Sprint 32b (1.5.0): Workflows 2, part b.
 *
 * - B-3903: triggers on the workflow itself: a `file.uploaded` event starts a run without a plugin, within the
 *   workspace, label, loop and rate rules; a cron run starts once with two instances.
 * - B-3906: per-step retries, the on-failure edge (a failed HTTP step takes it instead of failing the run), and the
 *   dead-letter view with redrive.
 * - B-3909: signed workflow bundles (`exprsn-workflow/1`) with references re-bound on import; a bundle changed after
 *   signing is refused with `422 Bundle refused`.
 */

const env = { label: 'internal' as const, profile: (n: string) => (n === 'general' ? { label: 'internal' as const } : undefined) };
const trigger = (config: Record<string, unknown>) => ({ id: 'trigger', kind: 'trigger' as const, title: 'Trigger', x: 20, y: 20, config });
const shape = (fields: Record<string, string>, id = 'shape') => ({ id, kind: 'transform' as const, title: `Shape ${id}`, x: 200, y: 20, config: { fields } });

describe('workflow triggers and failure handling at publish (B-3903, B-3906)', () => {
  const g = (nodes: WfGraph['nodes'], edges: WfGraph['edges'] = []): WfGraph => ({ nodes, edges, limits: {} });
  const msgs = (graph: WfGraph) => validateGraph(graph, env).errors.map((e) => e.message);

  it('checks event and schedule triggers against the catalogue and the cron parser', () => {
    expect(validateGraph(g([trigger({ source: 'event', event: 'file.uploaded' })]), env).ok).toBe(true);
    expect(validateGraph(g([trigger({ source: 'event', event: 'record.*' })]), env).ok).toBe(true);
    expect(validateGraph(g([trigger({ source: 'schedule', cron: '0 3 * * 1-5' })]), env).ok).toBe(true);
    expect(validateGraph(g([trigger({ source: 'schedule' })]), env).ok).toBe(true); // started by an app's schedule
    expect(msgs(g([trigger({ source: 'event' })]))).toEqual(['Trigger: name the catalogue event that starts the workflow, such as file.uploaded.']);
    expect(msgs(g([trigger({ source: 'event', event: 'nothing.here' })]))).toEqual(['Trigger: nothing.here is not an event or group in the catalogue.']);
    expect(msgs(g([trigger({ source: 'event', event: '*' })]))[0]).toMatch(/An event type such as file.uploaded, or a group/);
    expect(msgs(g([trigger({ source: 'schedule', cron: 'every day' })]))[0]).toMatch(/not a valid cron expression/);
    expect(msgs(g([trigger({ source: 'manual', cron: '0 3 * * *' })]))).toEqual(['Trigger: only a schedule trigger has a cron expression.']);
    expect(msgs(g([trigger({ source: 'manual', event: 'file.uploaded' })]))).toEqual(['Trigger: only an event trigger names an event.']);
  });

  it('types failure edges as {error, step} and limits retry policies to steps that can fail', () => {
    const call = { id: 'call', kind: 'http' as const, title: 'Call', x: 0, y: 0, config: { url: 'http://10.0.0.5/x' }, retry: { max: 2, delayMs: 1000, backoff: 'exponential' as const } };
    const needs = { ...shape({ note: '{{steps.call.error}}' }, 'recover'), input: { type: 'object' as const, properties: { error: { type: 'string' as const } }, required: ['error'] } };
    const ok = g([trigger({}), call, needs], [{ from: 'trigger', to: 'call' }, { from: 'call', to: 'recover', branch: 'failure' }]);
    expect(validateGraph(ok, env).errors).toEqual([]);
    // the same step on a normal edge does not provide `error`
    const plain = g([trigger({}), call, needs], [{ from: 'trigger', to: 'call' }, { from: 'call', to: 'recover' }]);
    expect(validateGraph(plain, env).errors.map((e) => e.code)).toEqual(['schema']);
    expect(msgs(g([trigger({}), shape({ a: '1' })], [{ from: 'trigger', to: 'shape', branch: 'failure' }]))).toEqual(['The trigger has no failure edge: it cannot fail.']);
    expect(msgs(g([trigger({}), { id: 'ok', kind: 'approval', title: 'OK', x: 0, y: 0, config: { role: 'workflow-admin' }, retry: { max: 1, delayMs: 1000, backoff: 'fixed' as const } }], [{ from: 'trigger', to: 'ok' }]))).toEqual(['OK: a approval step cannot have a retry policy.']);
    expect(msgs(g([trigger({}), shape({ a: '1' })], [{ from: 'trigger', to: 'shape', branch: 'true' }]))).toEqual(["Only a branch step's edges take true or false."]);
    // backoff
    expect(nextRetryAt({ retry: { max: 2, delayMs: 1000, backoff: 'exponential' } }, 1, 0)).toBe(1000);
    expect(nextRetryAt({ retry: { max: 2, delayMs: 1000, backoff: 'exponential' } }, 2, 0)).toBe(2000);
    expect(nextRetryAt({ retry: { max: 2, delayMs: 1000, backoff: 'exponential' } }, 3, 0)).toBeNull();
    expect(nextRetryAt({ retry: { max: 3, delayMs: 1500, backoff: 'fixed' } }, 3, 0)).toBe(1500);
    expect(nextRetryAt({}, 1, 0)).toBeNull();
  });
});

describe('Workflows 2b (Sprint 32b)', () => {
  let h: Harness;
  let clamd: FakeClamd;
  let hook: Server;
  let hookUrl: string;
  let failing: boolean;
  let flaky: number;
  let wsId: string;
  let otherWsId: string;

  beforeEach(async () => {
    clamd = await new FakeClamd().start();
    h = await harness({ CLAMD_HOST: '127.0.0.1', CLAMD_PORT: String(clamd.port), WORKFLOW_HTTP_ALLOW_LOOPBACK: 'true', WORKFLOW_EVENT_RATE_PER_MINUTE: '5', WORKFLOW_SCHEDULE_TICK_SECONDS: '0', OLLAMA_POLL_MS: '600000' });
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Finance', 'confidential')).id;
    otherWsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Legal', 'internal')).id;
    failing = true;
    flaky = 0;
    hook = createServer((req, res) => {
      const fail = req.url?.startsWith('/fail') ? failing : req.url?.startsWith('/flaky') ? flaky++ < 2 : false;
      res.writeHead(fail ? 500 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: !fail }));
    });
    await new Promise<void>((r) => hook.listen(0, '127.0.0.1', r));
    hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    hook.closeAllConnections();
    await new Promise((r) => hook.close(r));
    await h.close();
    await clamd.stop();
  });

  const audits = async (action: string) => (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action })) as { target: string; detail: string | null }[];

  async function admin(name = 'wadmin') {
    const u = await localUser(h, name, ['workflow-admin', 'member'], 'confidential');
    const c = await loginAdmin(h, name);
    const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
    const p = (await loadPrincipal(h.s, h.tenantId, u.id, {}))!;
    return { user: u, p, post: (x: string, b?: object) => send('post', x, b), patch: (x: string, b?: object) => send('patch', x, b), put: (x: string, b?: object) => send('put', x, b), get: (x: string) => c.agent.get(x) };
  }

  async function member(name: string) {
    const u = await localUser(h, name, ['member']);
    await h.s.tenants.addMember(wsId, u.id);
    const c = await login(h, name);
    return {
      user: u,
      get: (x: string) => c.agent.get(x),
      post: (x: string, b: object = {}) => c.agent.post(x).set('x-csrf-token', c.csrf).send(b),
      patch: (x: string, b: object = {}) => c.agent.patch(x).set('x-csrf-token', c.csrf).send(b),
      upload: (file: string, data: string) => c.agent.put(`/api/files/uploads?${new URLSearchParams({ name: file, workspace: wsId }).toString()}`).set('x-csrf-token', c.csrf).set('content-type', 'application/octet-stream').send(Buffer.from(data))
    };
  }

  /** Creates and publishes a workflow as `p` (in `p`'s workspace) through the service. */
  async function publish(p: Principal, name: string, graph: WfGraph, label: 'internal' | 'confidential' = 'internal') {
    const w = await h.s.workflows.create(p, { name, label, graph });
    const out = await h.s.workflows.publish(p, w.id, null);
    expect(out.version).toBe(1);
    return w.id;
  }

  /** Moves every delayed job and waiting retry to now. */
  async function fastForward() {
    const now = Date.now();
    await h.s.db('jobs').where('run_at', '>', now).update({ run_at: now - 1 });
    await h.s.db('workflow_steps').where({ state: 'waiting' }).whereNotNull('resume_at').update({ resume_at: now - 1 });
  }

  const runsOf = async (workflowId: string) => (await h.s.db('workflow_runs').where({ workflow_id: workflowId }).orderBy('created_at')) as { id: string; state: string; trigger: string; error: string | null; replay_of: string | null }[];
  const stepsOf = async (runId: string) => Object.fromEntries(((await h.s.db('workflow_steps').where({ run_id: runId })) as { node_id: string; state: string; attempts: number; error: string | null }[]).map((s) => [s.node_id, s]));

  it('B-3903: a file.uploaded event starts a run without a plugin, within the workspace, loop and enable rules', async () => {
    const a = await admin();
    const wsOwner = await localUser(h, 'wso', ['member'], 'confidential');
    await h.s.tenants.addMember(wsId, wsOwner.id);
    await h.s.tenants.addMember(otherWsId, wsOwner.id);
    const wsP = (await loadPrincipal(h.s, h.tenantId, wsOwner.id, {}))!;
    const onUpload = await publish(a.p, 'on-upload', { nodes: [trigger({ source: 'event', event: 'file.uploaded' }), shape({ file: '{{input.event.data.file}}', type: '{{input.event.type}}', depth: '{{input.trigger.depth}}' })], edges: [{ from: 'trigger', to: 'shape' }], limits: {} });
    const inWs = await publish({ ...wsP, workspaceId: wsId }, 'in-finance', { nodes: [trigger({ source: 'event', event: 'file.uploaded' }), shape({ file: '{{input.event.data.file}}' })], edges: [{ from: 'trigger', to: 'shape' }], limits: {} });
    const elsewhere = await publish({ ...wsP, workspaceId: otherWsId }, 'in-legal', { nodes: [trigger({ source: 'event', event: 'file.uploaded' }), shape({ x: '1' })], edges: [{ from: 'trigger', to: 'shape' }], limits: {} });
    // a workflow that watches workflow triggers: it runs once for on-upload's firing, never for its own
    const watcher = await publish(a.p, 'watcher', { nodes: [trigger({ source: 'event', event: 'workflow.trigger.*' }), shape({ action: '{{input.event.data.action}}' })], edges: [{ from: 'trigger', to: 'shape' }], limits: {} });

    const view = (await a.get(`/api/workflows/${onUpload}/triggers`).expect(200)).body;
    expect(view.trigger).toMatchObject({ kind: 'event', event: 'file.uploaded', version: 1, ownerId: a.user.id, enabled: true });
    expect((await audits('workflow.trigger.set')).length).toBe(4);

    const mo = await member('mo');
    const up = (await mo.upload('notes.txt', 'Quarterly notes').expect(202)).body;
    await drain(h);
    const runs = await runsOf(onUpload);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ state: 'succeeded' });
    expect(runs[0]!.trigger).toMatch(/^event:[0-9A-Z]{26}$/);
    const out = (await h.s.workflows.runView(a.p, runs[0]!.id)) as unknown as { steps: { nodeId: string; output: Record<string, unknown> }[] };
    expect(out.steps.find((s) => s.nodeId === 'shape')!.output).toEqual({ file: up.id, type: 'file.uploaded', depth: 1 });
    // the workspace rule: the Finance workflow received it, the Legal one did not
    expect((await runsOf(inWs)).map((r) => r.state)).toEqual(['succeeded']);
    expect(await runsOf(elsewhere)).toHaveLength(0);
    // the loop rule: watcher ran for the firings of on-upload and in-finance, and not for its own
    expect((await runsOf(watcher)).map((r) => r.state)).toEqual(['succeeded', 'succeeded']);
    const chains = ((await h.s.db('workflow_trigger_firings').where({ workflow_id: watcher })) as { chain: string }[]).map((f) => JSON.parse(f.chain) as string[]);
    expect(chains.map((c) => c.join()).sort()).toEqual([onUpload, inWs].sort());
    expect(await audits('workflow.trigger.fired')).toHaveLength(4);
    const fired = (await a.get(`/api/workflows/${onUpload}/triggers`).expect(200)).body;
    expect(fired.firings).toMatchObject([{ event: 'file.uploaded', state: 'started', runId: runs[0]!.id, chain: [] }]);
    expect(fired.trigger).toMatchObject({ lastRunId: runs[0]!.id, lastResult: 'started' });

    // turned off, nothing starts; members cannot turn it on
    await a.patch(`/api/workflows/${onUpload}/triggers`, { enabled: false }).expect(200);
    await mo.patch(`/api/workflows/${onUpload}/triggers`, { enabled: true }).expect(403);
    await mo.upload('more.txt', 'More notes').expect(202);
    await drain(h);
    expect(await runsOf(onUpload)).toHaveLength(1);
    expect((await audits('workflow.trigger.updated')).map((x) => JSON.parse(x.detail!).enabled)).toEqual([false]);

    // an owner who left the workflow's workspace gets a skip, audited
    await h.s.tenants.removeMember(wsId, wsOwner.id);
    await mo.upload('third.txt', 'Third').expect(202);
    await drain(h);
    expect((await runsOf(inWs)).length).toBe(2);
    const skipped = (await audits('workflow.trigger.skipped')).map((x) => JSON.parse(x.detail!).reason as string);
    expect(skipped).toContain("the owner is no longer a member of the workflow's workspace");

    // republishing as a manual workflow removes the trigger
    const g = { nodes: [trigger({ source: 'manual' }), shape({ x: '1' })], edges: [{ from: 'trigger', to: 'shape' }], limits: {} };
    await h.s.workflows.saveDraft(a.p, onUpload, { graph: g });
    await h.s.workflows.publish(a.p, onUpload, null);
    expect((await a.get(`/api/workflows/${onUpload}/triggers`).expect(200)).body).toMatchObject({ trigger: null, firings: [] });
    expect(await audits('workflow.trigger.removed')).toHaveLength(1);
  });

  it('B-3903: event fan-out keeps to the label and the rate, and stops at the chain depth', async () => {
    const a = await admin();
    const wf = await publish(a.p, 'counter', { nodes: [trigger({ source: 'event', event: 'record.created' }), shape({ x: '1' })], edges: [{ from: 'trigger', to: 'shape' }], limits: {} });
    const offer = (i: number, label: 'internal' | 'confidential' = 'internal') => h.s.workflowTriggers.offer(h.tenantId, 'record.created', label, `record.created:${i}`, { record: 'x', workspace: null });
    expect(await offer(0, 'confidential')).toBe(0); // above the workflow's label
    const got = [];
    for (let i = 1; i <= 7; i++) got.push(await offer(i));
    expect(got).toEqual([1, 1, 1, 1, 1, 0, 0]); // WORKFLOW_EVENT_RATE_PER_MINUTE=5
    expect(await audits('workflow.trigger.throttled')).toHaveLength(1);
    expect(await offer(1)).toBe(0); // the same event twice is one firing
    // an event already caused by a chain three workflows long is dropped
    const { workflowCause } = await import('../src/workflows/triggers.js');
    expect(await workflowCause.run({ chain: ['A'.repeat(26), 'B'.repeat(26), 'C'.repeat(26)] }, () => offer(99))).toBe(0);
    await drain(h);
    expect((await runsOf(wf)).length).toBe(5);
  });

  it('B-3903: a cron run starts once with two instances', async () => {
    const a = await admin();
    const wf = await publish(a.p, 'nightly', { nodes: [trigger({ source: 'schedule', cron: '0 3 * * *' }), shape({ due: '{{input.dueAt}}' })], edges: [{ from: 'trigger', to: 'shape' }], limits: {} });
    const t = await h.s.db('workflow_triggers').where({ workflow_id: wf }).first();
    const due = Number(t.next_run_at);
    expect(new Date(due).getUTCHours()).toBe(3);
    const second = createServices(h.s.cfg, h.s.db, createLogger('silent', false), new Metrics());
    try {
      const [x, y] = await Promise.all([h.s.workflowTriggers.tick(due + 1), second.workflowTriggers.tick(due + 1)]);
      expect(x.fired + y.fired).toBe(1);
      expect(await h.s.workflowTriggers.tick(due + 1)).toEqual({ fired: 0, skipped: 0 });
    } finally {
      second.workflowTriggers.close();
      second.pluginRuntime.close();
    }
    await drain(h);
    const runs = await runsOf(wf);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ state: 'succeeded' });
    expect(runs[0]!.trigger).toMatch(/^schedule:/);
    const after = await h.s.db('workflow_triggers').where({ workflow_id: wf }).first();
    expect(Number(after.next_run_at)).toBe(due + 24 * 3_600_000);
    // a disabled schedule has no due time
    await a.patch(`/api/workflows/${wf}/triggers`, { enabled: false }).expect(200);
    expect((await h.s.db('workflow_triggers').where({ workflow_id: wf }).first()).next_run_at).toBeNull();
  });

  it('B-3906: a failed HTTP step takes the on-failure edge; retries wait durably; dead letters are redriven', async () => {
    const a = await admin();
    // the on-failure edge
    const handled = await publish(a.p, 'handled', {
      nodes: [trigger({}), { id: 'call', kind: 'http', title: 'Call', x: 0, y: 0, config: { url: `${hookUrl}/fail` } }, shape({ note: 'failed: {{steps.call.error}}', step: '{{input.step}}' }, 'recover'), shape({ ok: 'yes' }, 'after')],
      edges: [{ from: 'trigger', to: 'call' }, { from: 'call', to: 'recover', branch: 'failure' }, { from: 'call', to: 'after' }],
      limits: {}
    });
    const r1 = await h.s.workflows.start(a.p, handled, { input: {}, dry: false });
    await drain(h);
    expect((await runsOf(handled))[0]).toMatchObject({ state: 'succeeded', error: null });
    const s1 = await stepsOf(r1.id);
    expect(s1).toMatchObject({ call: { state: 'failed' }, recover: { state: 'passed' }, after: { state: 'skipped' } });
    const v1 = (await h.s.workflows.runView(a.p, r1.id)) as unknown as { steps: { nodeId: string; output: Record<string, unknown> }[] };
    expect(String(v1.steps.find((s) => s.nodeId === 'recover')!.output.note)).toMatch(/^failed: GET 127\.0\.0\.1:\d+ answered 500\.$/);

    // retries: twice 500, then 200
    const retried = await publish(a.p, 'retried', { nodes: [trigger({}), { id: 'call', kind: 'http', title: 'Call', x: 0, y: 0, config: { url: `${hookUrl}/flaky` }, retry: { max: 2, delayMs: 1000, backoff: 'fixed' } }], edges: [{ from: 'trigger', to: 'call' }], limits: {} });
    const r2 = await h.s.workflows.start(a.p, retried, { input: {}, dry: false });
    await drain(h);
    expect((await runsOf(retried))[0]!.state).toBe('waiting');
    const w1 = await h.s.db('workflow_steps').where({ run_id: r2.id, node_id: 'call' }).first();
    expect(w1).toMatchObject({ state: 'waiting', attempts: 1 });
    expect(JSON.parse(w1.detail)).toMatchObject({ retries: 1, lastError: expect.stringMatching(/answered 500/) });
    await fastForward();
    await drain(h);
    expect((await stepsOf(r2.id)).call).toMatchObject({ state: 'waiting', attempts: 2 });
    await fastForward();
    await drain(h);
    expect((await runsOf(retried))[0]!.state).toBe('succeeded');
    expect((await stepsOf(r2.id)).call).toMatchObject({ state: 'passed', attempts: 3 });

    // a run that fails for good is a dead letter
    const doomed = await publish(a.p, 'doomed', { nodes: [trigger({}), { id: 'call', kind: 'http', title: 'Call', x: 0, y: 0, config: { url: `${hookUrl}/fail` }, retry: { max: 1, delayMs: 1000, backoff: 'fixed' as const } }, shape({ ok: 'yes' }, 'after')], edges: [{ from: 'trigger', to: 'call' }, { from: 'call', to: 'after' }], limits: {} });
    const r3 = await h.s.workflows.start(a.p, doomed, { input: {}, dry: false });
    await drain(h);
    await fastForward();
    await drain(h);
    expect((await runsOf(doomed))[0]).toMatchObject({ state: 'failed' });
    expect((await stepsOf(r3.id)).call).toMatchObject({ state: 'failed', attempts: 2 });
    // dry runs and handled failures are not dead letters
    expect((await h.s.db('workflow_dead_letters')).map((d: { run_id: string }) => d.run_id)).toEqual([r3.id]);
    const list = (await a.get('/api/workflow-dead-letters?state=open').expect(200)).body.items;
    expect(list).toMatchObject([{ runId: r3.id, workflow: 'doomed', nodeId: 'call', state: 'open', error: expect.stringMatching(/answered 500/) }]);
    const mo = await member('mo');
    await mo.get('/api/workflow-dead-letters').expect(403);
    await mo.post(`/api/workflow-dead-letters/${list[0].id}/redrive`).expect(403);

    failing = false;
    const redriven = (await a.post(`/api/workflow-dead-letters/${list[0].id}/redrive`).expect(201)).body;
    expect(redriven).toMatchObject({ state: 'redriven', redrivenBy: a.user.id, redriveRunId: expect.any(String) });
    await a.post(`/api/workflow-dead-letters/${list[0].id}/redrive`).expect(409);
    await drain(h);
    const again = (await runsOf(doomed)).find((r) => r.id === redriven.redriveRunId)!;
    expect(again).toMatchObject({ state: 'succeeded', replay_of: r3.id });
    expect((await a.get('/api/workflow-dead-letters?state=open').expect(200)).body.items).toEqual([]);
    expect(await audits('workflow.run.dead_lettered')).toHaveLength(1);
    expect(JSON.parse((await audits('workflow.dead_letter.redriven'))[0]!.detail!)).toMatchObject({ from: 'call', newRun: again.id });
  });

  it('B-3909: signed bundles re-bound on import; a bundle changed after signing is refused', async () => {
    const ollama = await new FakeOllama().start();
    try {
      const seeded = await seedGateway(h, ollama);
      await h.s.gateway.repo.createProfile({ ...seeded.profile, id: 'FAST'.padEnd(26, '0'), name: 'fast', display_name: 'Fast' });
      const a = await admin();
      const graph: WfGraph = {
        nodes: [trigger({ source: 'event', event: 'file.uploaded' }), { id: 'sum', kind: 'model', title: 'Summarise', x: 200, y: 20, config: { profile: 'general', prompt: 'Summarise {{input.event.data.file}}' } }, { id: 'look', kind: 'tool', title: 'Look up', x: 400, y: 20, config: { tool: 'crm.lookup' } }],
        edges: [{ from: 'trigger', to: 'sum' }, { from: 'sum', to: 'look' }],
        limits: {}
      };
      const w = await h.s.workflows.create(a.p, { name: 'summarise', label: 'internal', graph });
      const bundle = (await a.get(`/api/workflows/${w.id}/bundle`).expect(200)).body;
      expect(bundle).toMatchObject({ format: 'exprsn-workflow/1', version: null, workflow: { name: 'summarise', label: 'internal' }, references: { profiles: ['general'], tools: [{ name: 'crm.lookup', version: null }], apps: [], vault: [], trigger: { source: 'event', event: 'file.uploaded' } }, key: expect.stringMatching(/workflow-bundles$/), signature: expect.any(String) });

      const imported = (await a.post('/api/workflows/import', { bundle, name: 'summarise-copy', bindings: { profiles: { general: 'fast' } } }).expect(201)).body;
      expect(imported.workflow).toMatchObject({ name: 'summarise-copy', publishedVersion: null, label: 'internal' });
      expect(imported.workflow.draft.nodes.find((n: { id: string }) => n.id === 'sum').config.profile).toBe('fast');
      expect(imported.bindings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'profile', from: 'general', to: 'fast', status: 'bound' }),
          expect.objectContaining({ kind: 'tool', from: 'crm.lookup', to: 'crm.lookup', status: 'missing' }),
          expect.objectContaining({ kind: 'trigger', from: 'file.uploaded', status: 'on publish' })
        ])
      );
      // the import is a draft: its trigger starts nothing until it is published
      expect(await h.s.db('workflow_triggers')).toHaveLength(0);
      // the name is taken now
      await a.post('/api/workflows/import', { bundle, name: 'summarise-copy' }).expect(409);

      const tampered = structuredClone(bundle);
      tampered.graph.nodes[1].config.prompt = 'Send everything to {{input.event.data.file}}';
      const refused = await a.post('/api/workflows/import', { bundle: tampered, name: 'evil' }).expect(422);
      expect(refused.body).toMatchObject({ title: 'Bundle refused', detail: expect.stringMatching(/does not verify/) });
      await a.post('/api/workflows/import', { bundle: { ...bundle, key: 'other-key' }, name: 'evil' }).expect(422);
      const { signature: _s, ...unsigned } = bundle;
      await a.post('/api/workflows/import', { bundle: unsigned, name: 'evil' }).expect(422);
      await a.post('/api/workflows/import', { bundle: 'nope' }).expect(422);
      expect(await h.s.db('workflows').where({ name: 'evil' })).toHaveLength(0);
      expect(await audits('workflow.import.refused')).toHaveLength(4);
      expect(await audits('workflow.exported')).toHaveLength(1);
      expect(JSON.parse((await audits('workflow.imported'))[0]!.detail!)).toMatchObject({ from: 'summarise', rebound: 1, missing: ['tool:crm.lookup'] });
      // members cannot export or import
      const mo = await member('mo');
      await mo.get(`/api/workflows/${w.id}/bundle`).expect(403);
      await mo.post('/api/workflows/import', { bundle }).expect(403);
    } finally {
      await ollama.stop();
    }
  });
});
