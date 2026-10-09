/*
 * Fixes from the live review (2026-10-09), 2 of 2: an event trigger on a job event (job.succeeded, job.failed,
 * job.cancelled, job.*) takes a job type (jobType), checked against the event's data.type before the rate limiter and
 * the enqueue, so other jobs' events cost nothing; a jobType on any other trigger is refused.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPrincipal } from '../src/http/middleware.js';
import { validateGraph, type WfGraph } from '../src/workflows/graph.js';
import { matchesJobType } from '../src/workflows/trigger-config.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';

describe('Live review 2026-10-09: event triggers on job events narrowed by job type', () => {
  const trigger = (config: Record<string, unknown>) => ({ id: 'trigger', kind: 'trigger' as const, title: 'Trigger', x: 20, y: 20, config });
  const shape = { id: 'shape', kind: 'transform' as const, title: 'Shape', x: 200, y: 20, config: { fields: { x: '1' } } };
  const g = (config: Record<string, unknown>): WfGraph => ({ nodes: [trigger(config), shape], edges: [{ from: 'trigger', to: 'shape' }], limits: {} });
  const env = { label: 'internal' as const, profile: () => undefined };
  const msgs = (config: Record<string, unknown>) => validateGraph(g(config), env).errors.map((e) => e.message);

  it('validates jobType: only on job events, as a job type or a prefix.* group', () => {
    expect(msgs({ source: 'event', event: 'job.succeeded', jobType: 'training.package' })).toEqual([]);
    expect(msgs({ source: 'event', event: 'job.*', jobType: 'training.*' })).toEqual([]);
    expect(msgs({ source: 'event', event: 'job.failed', jobType: 'ops.backup.create' })).toEqual([]);
    expect(msgs({ source: 'event', event: 'file.uploaded', jobType: 'training.package' })).toEqual(['Trigger: a job type narrows only a trigger on job.succeeded, job.failed, job.cancelled, job.*.']);
    expect(msgs({ source: 'manual', jobType: 'training.package' })).toEqual(['Trigger: a job type narrows only a trigger on job.succeeded, job.failed, job.cancelled, job.*.']);
    expect(msgs({ source: 'event', event: 'job.succeeded', jobType: '*' })[0]).toMatch(/A job type such as training.package/);
    expect(msgs({ source: 'event', event: 'job.succeeded', jobType: 'Training Package' })[0]).toMatch(/A job type such as training.package/);
    expect(matchesJobType('training.*', 'training.package')).toBe(true);
    expect(matchesJobType('training.*', 'trainingx.package')).toBe(false);
    expect(matchesJobType('training.package', 'training.tick')).toBe(false);
    expect(matchesJobType('training.package', null)).toBe(false);
  });

  let h: Harness;
  beforeEach(async () => {
    h = await harness({ WORKFLOW_EVENT_RATE_PER_MINUTE: '2', WORKFLOW_SCHEDULE_TICK_SECONDS: '0', OLLAMA_POLL_MS: '600000' });
  });
  afterEach(async () => {
    await h.close();
  });

  it('fires for the named job type and not for others, before the rate limiter and without a firing row or job', async () => {
    const u = await localUser(h, 'wadmin', ['workflow-admin', 'member'], 'confidential');
    const p = (await loadPrincipal(h.s, h.tenantId, u.id, {}))!;
    const w = await h.s.workflows.create(p, { name: 'training-packaged-notice', label: 'internal', graph: g({ source: 'event', event: 'job.succeeded', jobType: 'training.package' }) });
    await h.s.workflows.publish(p, w.id, null);
    const row = await h.s.db('workflow_triggers').where({ workflow_id: w.id }).first();
    expect(row).toMatchObject({ kind: 'event', event: 'job.succeeded', job_type: 'training.package' });
    const c = await loginAdmin(h, 'wadmin');
    expect((await c.agent.get(`/api/workflows/${w.id}/triggers`).expect(200)).body.trigger).toMatchObject({ event: 'job.succeeded', jobType: 'training.package' });

    const jobsBefore = Number((await h.s.db('jobs').where({ type: 'workflow.trigger' }).count('* as n'))[0]!.n);
    const offer = (i: number, type: string, state = 'succeeded') => h.s.workflowTriggers.offer(h.tenantId, `job.${state}`, 'internal', `job:J${i}:${state}`, { id: `J${i}`, type, state, error: null });
    // Many ticks first: none reaches the limiter (WORKFLOW_EVENT_RATE_PER_MINUTE=2), so the package job still fires.
    for (let i = 0; i < 10; i++) expect(await offer(i, 'training.tick')).toBe(0);
    expect(await offer(50, 'training.package', 'failed')).toBe(0); // a failed package is another event
    expect(await h.s.db('workflow_trigger_firings').where({ workflow_id: w.id })).toHaveLength(0);
    expect(Number((await h.s.db('jobs').where({ type: 'workflow.trigger' }).count('* as n'))[0]!.n)).toBe(jobsBefore);
    expect(await offer(100, 'training.package')).toBe(1);
    const firings = (await h.s.db('workflow_trigger_firings').where({ workflow_id: w.id })) as { event_type: string; event_id: string }[];
    expect(firings).toEqual([expect.objectContaining({ event_type: 'job.succeeded', event_id: 'job:J100:succeeded' })]);
    expect(await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'workflow.trigger.throttled' })).toHaveLength(0);

    // Republished without a job type, every job's success is offered again (and the limiter applies).
    await h.s.workflows.saveDraft(p, w.id, { graph: g({ source: 'event', event: 'job.succeeded' }) });
    await h.s.workflows.publish(p, w.id, null);
    expect((await h.s.db('workflow_triggers').where({ workflow_id: w.id }).first()).job_type).toBeNull();
    expect(await offer(200, 'training.tick')).toBe(1);
  });
});
