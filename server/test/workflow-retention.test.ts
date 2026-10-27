import { ulid } from 'ulid';
import type request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RETENTION_DEFAULTS, RUN_OBJECT } from '../src/workflows/retention.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * 1.8.0, Sprint 46 (B-135): workflow run retention (migration 086). Old finished runs are pruned with their steps,
 * items, approvals and redriven dead letters; waiting runs, runs with an open dead letter and runs under a legal hold
 * (on the owner, or on the run as an object) are kept, the held ones recorded once in retention_skips; a dry run only
 * counts; a workflow's override wins over the tenant's policy; each prune writes one summary audit entry.
 */

type Api = Client & { post: (p: string, b?: object) => request.Test; put: (p: string, b?: object) => request.Test; get: (p: string) => request.Test };
const DAY = 86_400_000;
const graph = { nodes: [{ id: 'trigger', kind: 'trigger', title: 'Trigger', x: 20, y: 20, config: { source: 'manual' } }], edges: [], limits: {} };

describe('workflow run retention (B-135)', () => {
  let h: Harness;
  let wsId: string;
  let admin: Api;
  let adminId: string;
  let heldUserId: string;

  const api = (c: Client): Api => {
    const send = (method: 'post' | 'put', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
    return { ...c, post: (p, b) => send('post', p, b), put: (p, b) => send('put', p, b), get: (p) => c.agent.get(p) };
  };

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Ops', 'internal')).id;
    adminId = (await localUser(h, 'wren', ['workflow-admin', 'member'], 'confidential')).id;
    heldUserId = (await localUser(h, 'hal', ['member'], 'internal')).id;
    for (const id of [adminId, heldUserId]) await h.s.tenants.addMember(wsId, id);
    admin = api(await loginAdmin(h, 'wren'));
    await admin.put('/api/me/workspace', { workspaceId: wsId }).expect(200);
  });
  afterEach(async () => {
    await h.close();
  });

  const workflow = async (name: string) => (await admin.post('/api/workflows', { name, label: 'internal', graph }).expect(201)).body.id as string;
  /** A run with one step, one item and one approval, finished (or created) `ageDays` ago. */
  async function run(workflowId: string, state: string, ageDays: number, o: { by?: string } = {}) {
    const id = ulid();
    const at = Date.now() - ageDays * DAY;
    const finished = ['succeeded', 'failed', 'rejected', 'cancelled'].includes(state);
    await h.s.db('workflow_runs').insert({ id, tenant_id: h.tenantId, workspace_id: wsId, workflow_id: workflowId, version: 1, draft_rev: null, graph: JSON.stringify(graph), mode: 'run', trigger: 'manual', state, input: null, label: 'internal', created_by: o.by ?? adminId, tokens: 0, created_at: at, started_at: at, finished_at: finished ? at : null });
    await h.s.db('workflow_steps').insert({ id: ulid(), run_id: id, tenant_id: h.tenantId, node_id: 'trigger', state: 'passed', output: 'sealed', label: 'internal', attempts: 1 });
    await h.s.db('workflow_items').insert({ id: ulid(), tenant_id: h.tenantId, run_id: id, node_id: 'map', idx: 0, state: 'passed', output: 'sealed', tokens: 0, created_at: at });
    await h.s.db('workflow_approvals').insert({ id: ulid(), tenant_id: h.tenantId, run_id: id, node_id: 'ok', role: 'workflow-admin', state: state === 'waiting' ? 'pending' : 'approved', due_at: at + DAY, created_at: at });
    return id;
  }
  const exists = async (id: string) => !!(await h.s.db('workflow_runs').where({ id }).first('id'));
  const children = async (id: string) => (await h.s.db('workflow_steps').where({ run_id: id })).length + (await h.s.db('workflow_items').where({ run_id: id })).length + (await h.s.db('workflow_approvals').where({ run_id: id })).length;
  const audits = async (action: string) => (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action })) as { detail: string | null; target: string; kind: string }[];

  it('prunes old runs with their child rows; keeps waiting, dead-letter and held runs, recording the held ones; a dry run only counts', async () => {
    const wf = await workflow('nightly');
    const oldOk = await run(wf, 'succeeded', 100);
    const oldCancelled = await run(wf, 'cancelled', 91);
    const recentOk = await run(wf, 'succeeded', 10);
    const failed120 = await run(wf, 'failed', 120); // failed runs keep 180 days
    const failed200 = await run(wf, 'failed', 200);
    const waiting = await run(wf, 'waiting', 300);
    const dead = await run(wf, 'failed', 365);
    await h.s.db('workflow_dead_letters').insert({ id: ulid(), tenant_id: h.tenantId, workflow_id: wf, run_id: dead, node_id: 'trigger', label: 'internal', error: 'boom', state: 'open', failed_at: Date.now() - 365 * DAY });
    const redriven = await run(wf, 'failed', 365);
    await h.s.db('workflow_dead_letters').insert({ id: ulid(), tenant_id: h.tenantId, workflow_id: wf, run_id: redriven, node_id: 'trigger', label: 'internal', error: 'boom', state: 'redriven', failed_at: Date.now() - 365 * DAY });
    const heldByUser = await run(wf, 'succeeded', 150, { by: heldUserId });
    const heldObject = await run(wf, 'succeeded', 150);

    // Legal holds, under dual control: one on a person, one on a single run (the workflow-run object type).
    const ta = api(await loginAdmin(h, (await localUser(h, 'tia', ['tenant-admin'], 'confidential')).username));
    const tbUser = await localUser(h, 'tom', ['tenant-admin'], 'confidential');
    const tb = api(await loginAdmin(h, 'tom'));
    const hold = async (body: object) => {
      const req = (await ta.post('/api/compliance/holds', { reason: 'Matter 46', approverId: tbUser.id, ...body }).expect(201)).body as { id: string };
      await tb.post(`/api/compliance/holds/${req.id}/decide`, { decision: 'approved' }).expect(200);
      return req.id;
    };
    const userHold = await hold({ scope: 'user', scopeId: heldUserId });
    const objectHold = await hold({ scope: 'object', objectType: RUN_OBJECT, objectId: heldObject });

    // The dry run counts and changes nothing.
    const dry = (await admin.post('/api/workflow-retention/prune', { dryRun: true }).expect(200)).body;
    expect(dry).toMatchObject({ dryRun: true, runs: 4, steps: 4, items: 4, approvals: 4, deadLetters: 1, kept: { active: 1, deadLetter: 1, legalHold: 2 } });
    for (const id of [oldOk, oldCancelled, failed200, redriven]) expect(await exists(id)).toBe(true);
    expect(await h.s.db('retention_skips').where({ tenant_id: h.tenantId })).toHaveLength(0);

    const out = (await admin.post('/api/workflow-retention/prune', { dryRun: false }).expect(200)).body;
    expect(out).toMatchObject({ dryRun: false, runs: 4, steps: 4, items: 4, approvals: 4, deadLetters: 1, workflows: 1 });
    for (const id of [oldOk, oldCancelled, failed200, redriven]) {
      expect(await exists(id)).toBe(false);
      expect(await children(id)).toBe(0);
    }
    for (const id of [recentOk, failed120, waiting, dead, heldByUser, heldObject]) {
      expect(await exists(id)).toBe(true);
      expect(await children(id)).toBe(3);
    }
    expect(await h.s.db('workflow_dead_letters').where({ run_id: dead, state: 'open' })).toHaveLength(1);
    // What the holds kept is recorded once per run and reason, however often the prune runs.
    const skips = async () => ((await h.s.db('retention_skips').where({ tenant_id: h.tenantId, path: 'workflow.retention' })) as { object_id: string; reason: string; ref: string }[]).map((x) => `${x.object_id}:${x.reason}:${x.ref}`).sort();
    expect(await skips()).toEqual([`${heldByUser}:legal-hold:${userHold}`, `${heldObject}:legal-hold:${objectHold}`].sort());
    await h.s.workflowRetention.prune(h.tenantId, { dryRun: false });
    expect(await skips()).toHaveLength(2);
    // One summary audit entry per prune that removed something (and per admin request, dry runs included).
    const pruned = await audits('workflow.retention.pruned');
    expect(pruned).toHaveLength(2);
    expect(JSON.parse(pruned[1]!.detail!)).toMatchObject({ runs: 4, dryRun: false });
    expect(pruned.map((a) => a.kind)).toEqual(['admin', 'admin']);
    // The scheduled job's sweep that removes nothing writes nothing.
    expect(await audits('workflow.retention.pruned')).toHaveLength(2);
    // The tenant's view records the last prune.
    expect((await admin.get('/api/workflow-retention').expect(200)).body).toMatchObject({ policy: RETENTION_DEFAULTS, lastPruned: 0 });
  });

  it('a workflow override wins over the tenant policy; at most N runs per workflow; changes audited; workflows:manage only', async () => {
    const strict = await workflow('strict');
    const loose = await workflow('loose');
    const s1 = await run(strict, 'succeeded', 5);
    const l1 = await run(loose, 'succeeded', 5);
    // The tenant keeps 30 days; strict keeps 3 days; loose falls back to the tenant.
    expect((await admin.put('/api/workflow-retention', { runDays: 30, failedDays: null, maxRuns: null }).expect(200)).body).toMatchObject({ policy: { runDays: 30, failedDays: 180, maxRuns: 1000 }, set: { runDays: 30, failedDays: null } });
    expect((await admin.put(`/api/workflows/${strict}/retention`, { runDays: 3, failedDays: null, maxRuns: 2 }).expect(200)).body).toMatchObject({ override: { runDays: 3, maxRuns: 2 }, effective: { runDays: 3, failedDays: 180, maxRuns: 2 } });
    expect((await admin.get(`/api/workflows/${loose}/retention`).expect(200)).body).toMatchObject({ override: { runDays: null }, effective: { runDays: 30 } });
    // At most two finished runs for strict: of three two days old, the oldest goes.
    const s2 = await run(strict, 'succeeded', 2.5);
    const s3 = await run(strict, 'succeeded', 2.2);
    const s4 = await run(strict, 'succeeded', 2);
    const out = (await admin.post('/api/workflow-retention/prune', { dryRun: false }).expect(200)).body;
    expect(out.runs).toBe(2);
    expect(await exists(s1)).toBe(false); // past strict's 3 days
    expect(await exists(s2)).toBe(false); // beyond the two newest
    expect(await exists(s3)).toBe(true);
    expect(await exists(s4)).toBe(true);
    expect(await exists(l1)).toBe(true); // loose keeps the tenant's 30 days
    // Prune one workflow only.
    const l2 = await run(loose, 'succeeded', 40);
    const s5 = await run(strict, 'succeeded', 10);
    expect((await admin.post('/api/workflow-retention/prune', { dryRun: false, workflow: 'loose' }).expect(200)).body.runs).toBe(1);
    expect(await exists(l2)).toBe(false);
    expect(await exists(s5)).toBe(true);
    // Removing the override (all null) puts the tenant's policy back.
    expect((await admin.put(`/api/workflows/${strict}/retention`, { runDays: null, failedDays: null, maxRuns: null }).expect(200)).body).toMatchObject({ override: { runDays: null, maxRuns: null }, effective: { runDays: 30, maxRuns: 1000 } });
    expect(await h.s.db('workflow_retention').where({ scope: 'workflow' })).toHaveLength(0);
    expect((await audits('workflow.retention.updated')).map((a) => JSON.parse(a.detail!).scope)).toEqual(['tenant', 'workflow', 'workflow']);
    // zod: out of range and unknown fields; and the permission.
    await admin.put('/api/workflow-retention', { runDays: 0, failedDays: null, maxRuns: null }).expect(400);
    await admin.put('/api/workflow-retention', { runDays: 10, failedDays: null, maxRuns: null, extra: 1 }).expect(400);
    const m = api(await (await import('./helpers.js')).login(h, 'hal'));
    await m.agent.get('/api/workflow-retention').expect(403);
    await m.post('/api/workflow-retention/prune', { dryRun: true }).expect(403);
  });
});
