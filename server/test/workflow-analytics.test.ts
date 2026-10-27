import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '../src/authz/policy.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { rangeOf } from '../src/workflows/analytics.js';
import type { WfGraph } from '../src/workflows/graph.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';

/*
 * 1.8.0, Sprint 47 (B-139): workflow analytics (workflows/analytics.ts, migration 095). Counts by outcome, success
 * rate, p50 and p95 duration, the slowest and failing steps, top failure reasons, trends by UTC day, the tenant
 * summary and the running-now board, all bounded by a date range, and only over workflows the viewer may open, runs
 * within their clearance, and their own runs unless they are a workflow admin.
 */

const DAY = 86_400_000;
const graph: WfGraph = {
  nodes: [
    { id: 'trigger', kind: 'trigger', title: 'Trigger: manual', x: 20, y: 24, config: { source: 'manual' } },
    { id: 'call', kind: 'transform', title: 'Call the CRM', x: 260, y: 24, config: { fields: { a: 'x' } } },
    { id: 'ok', kind: 'approval', title: 'Manager approves', x: 500, y: 24, config: { role: 'workflow-admin' } },
    { id: 'pause', kind: 'wait', title: 'Cool off', x: 740, y: 24, config: { ms: 60_000 } }
  ],
  edges: [{ from: 'trigger', to: 'call' }, { from: 'call', to: 'ok' }, { from: 'ok', to: 'pause' }],
  limits: {}
};

describe('workflow analytics', () => {
  let h: Harness;
  let admin: Awaited<ReturnType<typeof loginAdmin>>;
  let adminP: Principal;
  let memberId: string;
  let wsId: string;
  const now = Date.now();
  const day0 = now - (now % DAY) - 2 * DAY; // the start of the UTC day two days ago

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Ops', 'confidential')).id;
    const a = await localUser(h, 'ada', ['workflow-admin', 'member'], 'internal');
    const m = await localUser(h, 'max', ['member'], 'internal');
    memberId = m.id;
    adminP = (await loadPrincipal(h.s, h.tenantId, a.id, {}))!;
    admin = await loginAdmin(h, 'ada');
  });
  afterEach(async () => {
    await h.close();
  });

  async function run(workflowId: string, o: { state: string; at: number; ms?: number; error?: string; label?: string; by?: string; mode?: string; steps?: [string, string, number][] }) {
    const id = ulid();
    const started = o.at + 100;
    const finished = ['succeeded', 'failed', 'rejected', 'cancelled'].includes(o.state) ? started + (o.ms ?? 1000) : null;
    await h.s.db('workflow_runs').insert({ id, tenant_id: h.tenantId, workspace_id: null, workflow_id: workflowId, version: 1, draft_rev: null, graph: JSON.stringify(graph), mode: o.mode ?? 'run', trigger: 'manual', state: o.state, input: null, label: o.label ?? 'internal', created_by: o.by ?? adminP.userId, job_id: null, error: o.error ?? null, tokens: 0, created_at: o.at, started_at: o.state === 'queued' ? null : started, finished_at: finished });
    for (const [node, state, ms] of o.steps ?? []) {
      await h.s.db('workflow_steps').insert({ id: ulid(), run_id: id, tenant_id: h.tenantId, node_id: node, state, output: null, label: 'internal', attempts: 1, detail: null, error: null, resume_at: node === 'pause' && state === 'waiting' ? now + 60_000 : null, started_at: started + 10, finished_at: state === 'passed' || state === 'failed' ? started + 10 + ms : null });
    }
    return id;
  }

  async function seed() {
    const w = await h.s.workflows.create(adminP, { name: 'crm-sync', label: 'internal', graph });
    await h.s.db('workflows').where({ id: w.id }).update({ published_version: 1 });
    await h.s.db('workflow_versions').insert({ id: ulid(), workflow_id: w.id, tenant_id: h.tenantId, version: 1, graph: JSON.stringify(graph), state: 'published', note: null, published_by: adminP.userId, published_at: now });
    // 15 succeeded over three days, 1..15 s; three failures; one rejection; one waiting; plus what must not count.
    for (let i = 1; i <= 15; i++) await run(w.id, { state: 'succeeded', at: day0 + (i % 3) * DAY + i * 60_000, ms: i * 1000, steps: [['call', 'passed', 200 + i], ['ok', 'passed', 50]] });
    await run(w.id, { state: 'failed', at: day0 + 10_000, ms: 20_000, error: 'Timeout calling the CRM', steps: [['call', 'failed', 20_000]] });
    await run(w.id, { state: 'failed', at: day0 + DAY + 10_000, ms: 21_000, error: 'Timeout calling the CRM', steps: [['call', 'failed', 21_000]] });
    await run(w.id, { state: 'failed', at: day0 + 2 * DAY + 10_000, ms: 22_000, error: 'Bad input: no customer id' });
    await run(w.id, { state: 'rejected', at: day0 + 2 * DAY + 20_000, ms: 500 });
    await run(w.id, { state: 'waiting', at: day0 + 2 * DAY + 30_000, steps: [['call', 'passed', 300], ['ok', 'waiting', 0]] });
    await run(w.id, { state: 'succeeded', at: day0 + DAY, ms: 99_000, mode: 'dry' }); // a dry run
    await run(w.id, { state: 'failed', at: day0 - 40 * DAY, ms: 99_000 }); // outside the range
    await run(w.id, { state: 'failed', at: day0 + DAY, ms: 99_000, label: 'confidential', error: 'Secret failure' }); // above the viewer's clearance
    await run(w.id, { state: 'succeeded', at: day0 + DAY + 5, ms: 3000, by: memberId }); // the member's own run
    return w.id;
  }

  it('counts outcomes, success rate, p50 and p95, slowest and failing steps, failure reasons and trends by day', async () => {
    const id = await seed();
    const a = (await admin.agent.get(`/api/workflow-analytics/${id}?days=30`).expect(200)).body;
    expect(a).toMatchObject({ name: 'crm-sync', scope: 'all runs', runs: 21, counts: { succeeded: 16, failed: 3, rejected: 1, waiting: 1, queued: 0, running: 0, cancelled: 0 }, finished: 20 });
    expect(a.successRate).toBe(0.8);
    // 20 timed runs sorted: 500, 1000, 1000, 2000, 3000, 3000 … 15000, 20000, 21000, 22000 → p50 is the 10th, p95 the 19th.
    expect(a.duration).toMatchObject({ measured: 20, p50Ms: 8000, p95Ms: 21000 });
    expect(a.duration.avgMs).toBe(Math.round((500 + 3000 + 120_000 + 63_000) / 20));
    expect(a.slowestSteps[0]).toMatchObject({ nodeId: 'call', title: 'Call the CRM', kind: 'transform', runs: 18, maxMs: 21_000 });
    expect(a.slowestSteps[1]).toMatchObject({ nodeId: 'ok', title: 'Manager approves', avgMs: 50 });
    expect(a.failingSteps).toEqual([{ nodeId: 'call', title: 'Call the CRM', failures: 2 }]);
    expect(a.failureReasons.map((r: { reason: string; runs: number }) => [r.reason, r.runs])).toEqual([['Timeout calling the CRM', 2], expect.any(Array), expect.any(Array)]);
    expect(a.failureReasons.map((r: { reason: string }) => r.reason)).toEqual(expect.arrayContaining(['Bad input: no customer id', 'Rejected by an approver']));
    expect(JSON.stringify(a)).not.toContain('Secret failure');
    // Every day of the range is present; the three seeded days carry the runs.
    expect(a.trend).toHaveLength(31);
    const seeded = a.trend.filter((d: { runs: number }) => d.runs > 0);
    expect(seeded.map((d: { day: number }) => d.day)).toEqual([day0, day0 + DAY, day0 + 2 * DAY]);
    expect(seeded.reduce((s: number, d: { runs: number }) => s + d.runs, 0)).toBe(21);
    expect(seeded[2]).toMatchObject({ date: new Date(day0 + 2 * DAY).toISOString().slice(0, 10), failed: 2, other: 1 });
    // Dry runs on request; a narrower range counts less.
    expect((await admin.agent.get(`/api/workflow-analytics/${id}?days=30&dry=true`).expect(200)).body.runs).toBe(22);
    expect((await admin.agent.get(`/api/workflow-analytics/${id}?from=${day0 + 2 * DAY}&to=${day0 + 3 * DAY}`).expect(200)).body.runs).toBe(8);
    await admin.agent.get(`/api/workflow-analytics/${id}?from=${now}&to=${now - 1}`).expect(400);
    await admin.agent.get(`/api/workflow-analytics/${id}?days=400`).expect(400);
    expect(() => rangeOf({ from: 0, to: 400 * DAY })).toThrow(/longer than 366 days/);
  });

  it('the tenant summary and the running-now board', async () => {
    const id = await seed();
    const other = await h.s.workflows.create(adminP, { name: 'idle', label: 'internal', graph });
    const q = await run(other.id, { state: 'queued', at: now - 5000 });
    const r = await run(other.id, { state: 'running', at: now - 4000, steps: [['call', 'running', 0]] });
    const wt = await run(other.id, { state: 'waiting', at: now - 3000, steps: [['call', 'passed', 10], ['ok', 'passed', 10], ['pause', 'waiting', 0]] });
    const waiting = (await h.s.db('workflow_runs').where({ workflow_id: id, state: 'waiting' }).first()) as { id: string };
    await h.s.db('workflow_approvals').insert({ id: ulid(), tenant_id: h.tenantId, run_id: waiting.id, node_id: 'ok', role: 'workflow-admin', state: 'pending', shown: null, decided_by: null, reason: null, due_at: now + DAY, created_at: now, decided_at: null });

    const sum = (await admin.agent.get('/api/workflow-analytics?days=30').expect(200)).body;
    expect(sum.workflows.map((w: { name: string; runs: number }) => [w.name, w.runs])).toEqual([['crm-sync', 21], ['idle', 3]]);
    expect(sum.workflows[0]).toMatchObject({ succeeded: 16, failed: 4, active: 1, successRate: 0.8 });
    expect(sum.workflows[1]).toMatchObject({ active: 3, successRate: null, avgMs: null });
    expect(sum).toMatchObject({ runs: 24, counts: { queued: 1, running: 1, waiting: 2 } });

    const board = (await admin.agent.get('/api/workflow-activity').expect(200)).body;
    expect(board).toMatchObject({ scope: 'all runs', counts: { queued: 1, running: 1, waiting: 2 }, total: 4 });
    const at = (runId: string) => board.items.find((x: { runId: string }) => x.runId === runId);
    expect(board.items.map((x: { runId: string }) => x.runId)).toEqual([waiting.id, q, r, wt]); // oldest first
    expect(at(waiting.id)).toMatchObject({ workflow: 'crm-sync', state: 'waiting', waitingOn: 'approval', step: { id: 'ok', title: 'Manager approves', kind: 'approval', state: 'waiting' }, approval: { role: 'workflow-admin' }, owner: { id: adminP.userId, name: 'ADA' } });
    expect(at(q)).toMatchObject({ workflow: 'idle', state: 'queued', waitingOn: null, step: null });
    expect(at(r)).toMatchObject({ state: 'running', step: { id: 'call', title: 'Call the CRM', state: 'running' } });
    expect(at(wt)).toMatchObject({ waitingOn: 'wait', step: { id: 'pause', title: 'Cool off' }, resumeAt: expect.any(Number) });
    expect(at(q).ageMs).toBeGreaterThanOrEqual(5000);
    expect((await admin.agent.get('/api/workflow-activity?workflow=idle').expect(200)).body.items).toHaveLength(3);
  });

  it('counts only workflows the viewer may open, runs within their clearance, and their own runs unless they manage workflows', async () => {
    const id = await seed();
    // A confidential workflow and one in a workspace the viewer is not in.
    const conf = await localUser(h, 'cora', ['workflow-admin', 'member'], 'confidential');
    const coraP = (await loadPrincipal(h.s, h.tenantId, conf.id, {}))!;
    const secret = await h.s.workflows.create(coraP, { name: 'secret-flow', label: 'confidential', graph });
    await run(secret.id, { state: 'running', at: now - 1000, label: 'confidential', by: conf.id });
    await h.s.tenants.addMember(wsId, conf.id);
    const inWs = await h.s.workflows.create({ ...coraP, workspaceId: wsId }, { name: 'ops-only', label: 'internal', graph });
    await run(inWs.id, { state: 'queued', at: now - 900, by: conf.id });

    const sum = (await admin.agent.get('/api/workflow-analytics?days=30').expect(200)).body;
    expect(sum.workflows.map((w: { name: string }) => w.name)).toEqual(['crm-sync']);
    await admin.agent.get(`/api/workflow-analytics/${secret.id}`).expect(404);
    await admin.agent.get(`/api/workflow-analytics/${inWs.id}`).expect(404);
    expect((await admin.agent.get('/api/workflow-activity').expect(200)).body.items.map((x: { workflow: string }) => x.workflow)).toEqual(['crm-sync']);

    // Cora, cleared to confidential, sees the secret workflow and the confidential run of crm-sync.
    const cora = await loginAdmin(h, 'cora');
    const cs = (await cora.agent.get(`/api/workflow-analytics/${id}?days=30`).expect(200)).body;
    expect(cs.runs).toBe(22);
    expect(cs.failureReasons.map((r: { reason: string }) => r.reason)).toContain('Secret failure');
    expect((await cora.agent.get('/api/workflow-activity').expect(200)).body.items.map((x: { workflow: string }) => x.workflow)).toEqual(expect.arrayContaining(['secret-flow', 'crm-sync']));

    // A member without workflows:manage counts only their own runs.
    const m = await login(h, 'max');
    const mine = (await m.agent.get(`/api/workflow-analytics/${id}?days=30`).expect(200)).body;
    expect(mine).toMatchObject({ scope: 'your runs', runs: 1, counts: { succeeded: 1 }, duration: { p50Ms: 3000, p95Ms: 3000 } });
    const board = (await m.agent.get('/api/workflow-activity').expect(200)).body;
    expect(board).toMatchObject({ scope: 'your runs', total: 0, items: [] });
    // Strict query parameters.
    await m.agent.get('/api/workflow-activity?colour=red').expect(400);
    await m.agent.get(`/api/workflow-analytics/${id}?colour=red`).expect(400);
  });
});
