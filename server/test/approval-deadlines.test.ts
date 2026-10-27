import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPrincipal } from '../src/http/middleware.js';
import { tally } from '../src/workflows/approval-deadlines.js';
import { validateGraph, type WfGraph, type WfNode } from '../src/workflows/graph.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * Sprint 46 (B-133): approval deadlines, reminders, escalation, auto-decisions, the timeout edge and quorum, fired by
 * the scheduled tick (`workflow.approvals`) from what the approval row stores.
 */

const H = 3_600_000;
const env = { label: 'internal' as const, profile: () => undefined };

function graph(approval: Record<string, unknown>, extra: { timeoutEdge?: boolean } = {}): WfGraph {
  const nodes: WfNode[] = [
    { id: 'trigger', kind: 'trigger', title: 'Trigger', x: 20, y: 20, config: { source: 'manual' } },
    { id: 'approve', kind: 'approval', title: 'Approve', x: 200, y: 20, config: { role: 'knowledge-curator', ...approval } },
    { id: 'done', kind: 'transform', title: 'Done', x: 400, y: 20, config: { fields: { result: 'approved path' } } }
  ];
  const edges: WfGraph['edges'] = [
    { from: 'trigger', to: 'approve' },
    { from: 'approve', to: 'done' }
  ];
  if (extra.timeoutEdge) {
    nodes.push({ id: 'late', kind: 'transform', title: 'Late', x: 400, y: 200, config: { fields: { result: 'timeout path' } } });
    edges.push({ from: 'approve', to: 'late', branch: 'timeout' });
  }
  return { nodes, edges, limits: {} };
}

describe('B-133 publish validation', () => {
  it('accepts the new options and checks them', () => {
    expect(validateGraph(graph({ due: { afterMs: 2 * H }, reminders: [H], onBreach: { action: 'escalate', role: 'flag-reviewer' }, quorum: { mode: 'count', count: 2, rejects: 'counted' } }), env).errors).toEqual([]);
    const msgs = (cfg: Record<string, unknown>, x?: { timeoutEdge?: boolean }) => validateGraph(graph(cfg, x), env).errors.map((e) => e.message);
    expect(msgs({ due: { afterMs: 30 * H } })).toEqual([expect.stringMatching(/comes after the timeout/)]);
    expect(msgs({ reminders: [H] })).toEqual([expect.stringMatching(/reminders come before a due time/)]);
    expect(msgs({ due: { afterMs: 2 * H }, reminders: [3 * H] })).toEqual([expect.stringMatching(/before the step even pauses/)]);
    expect(msgs({ due: { afterMs: 2 * H }, onBreach: { action: 'escalate' } })).toEqual([expect.stringMatching(/choose the role or the person/)]);
    expect(msgs({ due: { afterMs: 2 * H }, onBreach: { action: 'escalate', role: 'no-such-role' } })).toEqual([expect.stringMatching(/there is no role no-such-role/)]);
    expect(msgs({ due: { afterMs: 2 * H }, onBreach: { action: 'approve' } })).toEqual([expect.stringMatching(/allowed explicitly on the step/)]);
    expect(msgs({ due: { afterMs: 2 * H }, onBreach: { action: 'timeout' } })).toEqual([expect.stringMatching(/no timeout edge/)]);
    expect(msgs({ due: { afterMs: 2 * H } }, { timeoutEdge: true })).toEqual([expect.stringMatching(/does not take it/)]);
    expect(msgs({ quorum: { mode: 'count' } })).toEqual([expect.stringMatching(/needs N/)]);
    // Auto-approval is allowed only when the step says so, and then published with a warning.
    const ok = validateGraph(graph({ due: { afterMs: 2 * H }, onBreach: { action: 'approve' }, autoApprove: true }), env);
    expect(ok.errors).toEqual([]);
    expect(ok.warnings.map((w) => w.message)).toEqual(expect.arrayContaining([expect.stringMatching(/approves automatically/)]));
    // A timeout edge only from an approval that takes it.
    const g = graph({ due: { afterMs: 2 * H }, onBreach: { action: 'timeout' } }, { timeoutEdge: true });
    expect(validateGraph(g, env).errors).toEqual([]);
    g.edges.push({ from: 'trigger', to: 'late', branch: 'timeout' });
    expect(validateGraph(g, env).errors.map((e) => e.message)).toEqual(expect.arrayContaining([expect.stringMatching(/Only an Approval step has a timeout edge/)]));
  });

  it('tallies any, all and N-of-M quorums with final and counted rejects', () => {
    expect(tally({ approve: 1, reject: 0 }, { quorum: 'any', required: 1, rejects: 'final', eligible: 3 })).toBe('approved');
    expect(tally({ approve: 2, reject: 0 }, { quorum: 'all', required: 3, rejects: 'final', eligible: 3 })).toBe('pending');
    expect(tally({ approve: 3, reject: 0 }, { quorum: 'all', required: 3, rejects: 'final', eligible: 3 })).toBe('approved');
    expect(tally({ approve: 1, reject: 1 }, { quorum: 'count', required: 2, rejects: 'final', eligible: 4 })).toBe('rejected');
    expect(tally({ approve: 1, reject: 1 }, { quorum: 'count', required: 2, rejects: 'counted', eligible: 4 })).toBe('pending');
    expect(tally({ approve: 1, reject: 3 }, { quorum: 'count', required: 2, rejects: 'counted', eligible: 4 })).toBe('rejected');
  });
});

describe('B-133 deadlines and quorum', () => {
  let h: Harness;
  let admin: Client;
  let extra: Harness | null = null;
  afterEach(async () => {
    await h?.close();
    await extra?.close();
    extra = null;
  });

  const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);
  const put = (c: Client, url: string, body: object = {}) => c.agent.put(url).set('x-csrf-token', c.csrf).send(body);

  async function setup(overrides: Record<string, string> = {}) {
    h = await harness(overrides);
    await localUser(h, 'wadmin', ['workflow-admin', 'member'], 'confidential');
    const ids: Record<string, string> = {};
    for (const u of ['cur1', 'cur2', 'cur3']) ids[u] = (await localUser(h, u, ['knowledge-curator'])).id;
    ids.rev = (await localUser(h, 'rev', ['flag-reviewer'])).id;
    admin = await loginAdmin(h, 'wadmin');
    return ids;
  }

  const principal = async (userId: string) => (await loadPrincipal(h.s, h.tenantId, userId, {}))!;

  async function startRun(name: string, g: WfGraph): Promise<{ runId: string; approvalId: string }> {
    const w = (await post(admin, '/api/workflows', { name, label: 'internal' }).expect(201)).body;
    const saved = await put(admin, `/api/workflows/${w.id}/draft`, { graph: g }).expect(200);
    expect(saved.body.validation.errors).toEqual([]);
    await post(admin, `/api/workflows/${w.id}/publish`).expect(200);
    const run = (await post(admin, `/api/workflows/${w.id}/runs`, { input: {} }).expect(202)).body;
    await h.s.jobs.runDue();
    const a = (await h.s.db('workflow_approvals').where({ run_id: run.id }).first('id')) as { id: string };
    return { runId: run.id, approvalId: a.id };
  }

  const approval = async (id: string) => (await h.s.db('workflow_approvals').where({ id }).first()) as Record<string, unknown>;
  const runOf = async (id: string) => (await admin.agent.get(`/api/workflow-runs/${id}`).expect(200)).body;
  const audits = async (prefix: string) => ((await h.s.db('audit_events').where({ tenant_id: h.tenantId }).andWhere('action', 'like', `${prefix}%`).select('action')) as { action: string }[]).map((r) => r.action);
  const notes = async (userId: string) => ((await h.s.db('notifications').where({ user_id: userId }).select('title')) as { title: string }[]).map((r) => r.title);

  it('reminds the assignees before the due time, then escalates to another role who may then decide', async () => {
    const ids = await setup();
    const { runId, approvalId } = await startRun('remind-escalate', graph({ due: { afterMs: 2 * H }, reminders: [H], onBreach: { action: 'escalate', role: 'flag-reviewer' } }));
    const a = await approval(approvalId);
    expect(Number(a.breach_at) - Number(a.created_at)).toBe(2 * H);
    expect(JSON.parse(String(a.reminder_times))).toEqual([Number(a.breach_at) - H]);
    const t0 = Number(a.created_at);

    // Nothing to do yet.
    expect(await h.s.workflows.deadlines.tick(t0 + 10 * 60_000)).toEqual({ reminded: 0, breached: 0, expired: 0 });
    // The reminder, once.
    expect((await h.s.workflows.deadlines.tick(t0 + H + 1000)).reminded).toBe(1);
    expect((await h.s.workflows.deadlines.tick(t0 + H + 2000)).reminded).toBe(0);
    expect(await notes(ids.cur1!)).toContain('Workflow approval due soon');
    expect(await notes(ids.rev!)).not.toContain('Workflow approval escalated to you');

    // The flag reviewer cannot decide before the escalation…
    await expect(h.s.workflows.decide(await principal(ids.rev!), approvalId, { decision: 'approve' })).rejects.toMatchObject({ status: 403 });
    expect((await h.s.workflows.deadlines.tick(t0 + 2 * H + 1000)).breached).toBe(1);
    expect(await notes(ids.rev!)).toContain('Workflow approval escalated to you');
    const pending = await h.s.workflows.pendingApprovals(await principal(ids.rev!));
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: approvalId, escalated: { role: 'flag-reviewer' }, due: { overdue: true, remindersSent: 1 } });
    // …and can after it.
    const out = await h.s.workflows.decide(await principal(ids.rev!), approvalId, { decision: 'approve' });
    expect(out.state).toBe('approved');
    await h.s.jobs.runDue();
    expect((await runOf(runId)).state).toBe('succeeded');
    expect(await audits('workflow.approval.')).toEqual(expect.arrayContaining(['workflow.approval.reminded', 'workflow.approval.escalated']));
  });

  it('rejects automatically at the due time; approves automatically only where the step allows it', async () => {
    await setup();
    const r1 = await startRun('auto-reject', graph({ due: { afterMs: H }, onBreach: { action: 'reject' } }));
    const t0 = Number((await approval(r1.approvalId)).created_at);
    expect((await h.s.workflows.deadlines.tick(t0 + H + 1)).breached).toBe(1);
    expect(await approval(r1.approvalId)).toMatchObject({ state: 'rejected', outcome: 'auto-rejected', decided_by: null });
    await h.s.jobs.runDue();
    const run1 = await runOf(r1.runId);
    expect(run1.state).toBe('rejected');
    expect(run1.steps.find((s: { nodeId: string }) => s.nodeId === 'done').state).toBe('skipped');

    const r2 = await startRun('auto-approve', graph({ due: { afterMs: H }, onBreach: { action: 'approve' }, autoApprove: true }));
    const t1 = Number((await approval(r2.approvalId)).created_at);
    await h.s.workflows.deadlines.tick(t1 + H + 1);
    expect(await approval(r2.approvalId)).toMatchObject({ state: 'approved', outcome: 'auto-approved', decided_by: null });
    await h.s.jobs.runDue();
    expect((await runOf(r2.runId)).state).toBe('succeeded');
    expect(await audits('workflow.approval.auto')).toEqual(expect.arrayContaining(['workflow.approval.auto-rejected', 'workflow.approval.auto-approved']));

    // A stored automatic approval the run's own graph does not allow is never applied: people are told instead.
    const r3 = await startRun('no-auto', graph({ due: { afterMs: H } }));
    await h.s.db('workflow_approvals').where({ id: r3.approvalId }).update({ on_breach: JSON.stringify({ action: 'approve' }) });
    const t2 = Number((await approval(r3.approvalId)).created_at);
    await h.s.workflows.deadlines.tick(t2 + H + 1);
    expect(await approval(r3.approvalId)).toMatchObject({ state: 'pending', outcome: 'overdue' });
  });

  it('takes the timeout edge, and only it, when the due time passes', async () => {
    await setup();
    const { runId, approvalId } = await startRun('timeout-edge', graph({ due: { afterMs: H }, onBreach: { action: 'timeout' } }, { timeoutEdge: true }));
    const t0 = Number((await approval(approvalId)).created_at);
    await h.s.workflows.deadlines.tick(t0 + H + 1);
    expect(await approval(approvalId)).toMatchObject({ state: 'expired', outcome: 'timed-out' });
    await h.s.jobs.runDue();
    const run = await runOf(runId);
    expect(run.state).toBe('succeeded');
    const state = Object.fromEntries(run.steps.map((s: { nodeId: string; state: string }) => [s.nodeId, s.state]));
    expect(state).toMatchObject({ approve: 'passed', late: 'passed', done: 'skipped' });
    expect(run.steps.find((s: { nodeId: string }) => s.nodeId === 'late').output).toEqual({ result: 'timeout path' });

    // Decided in time, the run goes the other way.
    const r2 = await startRun('timeout-edge-2', graph({ due: { afterMs: H }, onBreach: { action: 'timeout' } }, { timeoutEdge: true }));
    const cur = (await h.s.db('users').where({ username: 'cur1' }).first('id')) as { id: string };
    await h.s.workflows.decide(await principal(cur.id), r2.approvalId, { decision: 'approve' });
    await h.s.jobs.runDue();
    const run2 = await runOf(r2.runId);
    expect(Object.fromEntries(run2.steps.map((s: { nodeId: string; state: string }) => [s.nodeId, s.state]))).toMatchObject({ done: 'passed', late: 'skipped' });
  });

  it('waits for every eligible approver under all, counting one person once', async () => {
    const ids = await setup();
    const { runId, approvalId } = await startRun('all', graph({ quorum: { mode: 'all' } }));
    expect(await approval(approvalId)).toMatchObject({ quorum: 'all', quorum_required: 3 });
    const first = await h.s.workflows.decide(await principal(ids.cur1!), approvalId, { decision: 'approve' });
    expect(first).toMatchObject({ state: 'pending', votes: { approve: 1, reject: 0, required: 3 } });
    // The same person again: counted once.
    await expect(h.s.workflows.decide(await principal(ids.cur1!), approvalId, { decision: 'approve' })).rejects.toMatchObject({ status: 409 });
    // Over HTTP, a vote that does not decide yet is answered as pending and audited as a vote.
    const c2 = await login(h, 'cur2');
    const voted = await c2.agent.post(`/api/workflow-approvals/${approvalId}`).set('x-csrf-token', c2.csrf).send({ decision: 'approve' }).expect(200);
    expect(voted.body).toMatchObject({ state: 'pending', votes: { approve: 2, required: 3 } });
    expect(await audits('workflow.approval.voted')).toHaveLength(1);
    const view = (await runOf(runId)).approvals[0];
    expect(view.quorum).toMatchObject({ mode: 'all', required: 3 });
    expect(view.votes.map((v: { userId: string }) => v.userId)).toEqual([ids.cur1, ids.cur2]);
    expect((await h.s.workflows.decide(await principal(ids.cur3!), approvalId, { decision: 'approve' })).state).toBe('approved');
    await h.s.jobs.runDue();
    expect((await runOf(runId)).state).toBe('succeeded');
  });

  it('decides N of M, with a counted reject that only fails once the quorum is out of reach', async () => {
    const ids = await setup();
    const { runId, approvalId } = await startRun('two-of-three', graph({ quorum: { mode: 'count', count: 2, rejects: 'counted' } }));
    expect((await h.s.workflows.decide(await principal(ids.cur1!), approvalId, { decision: 'reject', reason: 'not yet' })).state).toBe('pending');
    expect((await h.s.workflows.decide(await principal(ids.cur2!), approvalId, { decision: 'approve' })).state).toBe('pending');
    expect((await h.s.workflows.decide(await principal(ids.cur3!), approvalId, { decision: 'approve' })).state).toBe('approved');
    await h.s.jobs.runDue();
    expect((await runOf(runId)).state).toBe('succeeded');

    const r2 = await startRun('two-of-three-final', graph({ quorum: { mode: 'count', count: 2, rejects: 'final' } }));
    expect((await h.s.workflows.decide(await principal(ids.cur1!), r2.approvalId, { decision: 'approve' })).state).toBe('pending');
    expect((await h.s.workflows.decide(await principal(ids.cur2!), r2.approvalId, { decision: 'reject' })).state).toBe('rejected');
    await h.s.jobs.runDue();
    expect((await runOf(r2.runId)).state).toBe('rejected');
  });

  it('claims each deadline action once when two ticks run at the same moment', async () => {
    const ids = await setup();
    const { approvalId } = await startRun('claim-once', graph({ due: { afterMs: H }, reminders: [30 * 60_000], onBreach: { action: 'escalate', role: 'flag-reviewer' } }));
    const t0 = Number((await approval(approvalId)).created_at);
    const [a, b] = await Promise.all([h.s.workflows.deadlines.tick(t0 + 31 * 60_000), h.s.workflows.deadlines.tick(t0 + 31 * 60_000)]);
    expect(a.reminded + b.reminded).toBe(1);
    const [c, d] = await Promise.all([h.s.workflows.deadlines.tick(t0 + H + 1), h.s.workflows.deadlines.tick(t0 + H + 1)]);
    expect(c.breached + d.breached).toBe(1);
    expect((await notes(ids.rev!)).filter((t) => t === 'Workflow approval escalated to you')).toHaveLength(1);
    expect((await audits('workflow.approval.escalated')).length).toBe(1);
    expect((await audits('workflow.approval.reminded')).length).toBe(1);
  });

  it('fires from the stored row after a restart: a fresh server process expires what came due', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'exprsn-b133-')), 'db.sqlite');
    const keys = { SQLITE_FILENAME: file, SESSION_SECRET: randomBytes(32).toString('hex'), DATA_KEY: randomBytes(32).toString('base64') };
    await setup(keys);
    const { runId, approvalId } = await startRun('durable', graph({ timeoutMs: 60 * 60_000, due: { afterMs: 30 * 60_000 }, onBreach: { action: 'reject' } }));
    // The first process stops before anything came due.
    await h.close();
    // Time passes: the stored due and expiry are now behind us.
    extra = await harness(keys);
    const past = Date.now() - 1000;
    await extra.s.db('workflow_approvals').where({ id: approvalId }).update({ breach_at: past, due_at: past + 500, next_check_at: past });
    const out = await extra.s.workflows.deadlines.tick();
    expect(out.breached).toBe(1);
    expect(await extra.s.db('workflow_approvals').where({ id: approvalId }).first()).toMatchObject({ state: 'rejected', outcome: 'auto-rejected' });
    await extra.s.jobs.runDue();
    expect(((await extra.s.db('workflow_runs').where({ id: runId }).first()) as { state: string }).state).toBe('rejected');
    h = extra;
    extra = null;
  });

  it('expires at the hard timeout from the tick, without a job per approval', async () => {
    await setup();
    const { runId, approvalId } = await startRun('expiry', graph({}));
    expect(await h.s.db('jobs').where({ type: 'workflow.approval-timeout' }).count({ n: '*' }).first()).toMatchObject({ n: 0 });
    const past = Date.now() - 1000;
    await h.s.db('workflow_approvals').where({ id: approvalId }).update({ due_at: past, next_check_at: past });
    expect((await h.s.workflows.deadlines.tick()).expired).toBe(1);
    await h.s.jobs.runDue();
    expect((await runOf(runId)).state).toBe('failed');
    expect(await audits('workflow.approval.expired')).toHaveLength(1);
  });
});
