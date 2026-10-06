import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { systemActor } from '../src/ops/common.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * Sprint 35b (1.6.0), the Overview and Jobs and queues screens. The "done when" of each item is a test below:
 *   B-4202 draining an instance from the screen stops it claiming jobs;
 *   B-4203 a paused type stops claiming within one poll and resumes from the screen.
 * Also: alerts acknowledged tenant-wide and audited (Q15), the drain's recent sign-in (Q14), who sees which jobs (Q9),
 * cancel and retry, schedules run now and paused, dead letters redriven and discarded, the cache tab (Q1).
 */

const send = (c: Client, method: 'post' | 'patch', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);
const audits = async (h: Harness, action: string) => (await h.s.db('audit_events').where({ action })) as { tenant_id: string; detail: string | null; target: string; actor: string }[];

describe('Overview (B-4202)', () => {
  let h: Harness;
  let root: Client;
  let tara: Client;

  beforeEach(async () => {
    h = await harness();
    await localUser(h, 'root', ['system-admin']);
    await localUser(h, 'tara', ['tenant-admin']);
    root = await loginAdmin(h, 'root');
    tara = await loginAdmin(h, 'tara');
    await h.s.instances.beat();
  }, 60_000);
  afterEach(async () => {
    await h.close();
  });

  it('shows a system admin the instances, alerts, counters, schedules, audit and capacity; a tenant admin their tenant', async () => {
    const res = await root.agent.get('/api/admin/overview?window=1h');
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('platform');
    expect(res.body.window).toBe('1h');
    expect(res.body.instances).toHaveLength(1);
    const self = res.body.instances[0];
    expect(self).toMatchObject({ id: h.s.instances.id, self: true, state: 'ready', role: 'api, jobs', drain: false });
    expect(self.checks).toMatchObject({ database: 'ok', migrations: 'ok', schema: 'ok', kms: 'ok', blobs: 'ok', shutdown: 'ok' });
    expect(self.runtime.rateLimit.kind).toBe('memory');
    expect(res.body.counters).toMatchObject({ jobsScope: 'all tenants', flags: { open: 0, overdue: 0 }, heldReplies: 0 });
    expect(typeof res.body.counters.signins).toBe('number');
    expect(res.body.capacity.database.client).toBe('sqlite');
    expect(res.body.capacity.database.bytes).toBeGreaterThan(0);
    expect(res.body.audit.length).toBeGreaterThan(0);
    expect(res.body.metricsUrl).toBe('http://localhost:8080/metrics');

    const t = await tara.agent.get('/api/admin/overview');
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ scope: 'tenant', instances: null, capacity: null, metricsUrl: null });
    expect(t.body.counters.jobsScope).toBe('your tenant');

    // A member is refused, and the window is validated.
    await localUser(h, 'mia', ['member']);
    const mia = await (await import('./helpers.js')).login(h, 'mia');
    expect((await mia.agent.get('/api/admin/overview')).status).toBe(403);
    expect((await root.agent.get('/api/admin/overview')).body.counters.signins).toBeGreaterThan(res.body.counters.signins);
    expect((await root.agent.get('/api/admin/overview?window=2d')).status).toBe(400);
  });

  it('raises platform alerts from the watches; acknowledging hides them tenant-wide, audited, until a new occurrence', async () => {
    // Another instance behind the schema, and the backup RPO missed (there is no backup yet).
    const now = Date.now();
    await h.s.db('platform_instances').insert({ id: 'node-b:917', node: 'node-b', pid: 917, role: 'api, jobs', version: '1.5.0', state: 'not ready', checks: JSON.stringify({ schema: 'behind: migration 037b_platform_ops is unknown' }), runtime: JSON.stringify({ rateLimit: { kind: 'memory', degraded: false, since: null, detail: null } }), schema_state: 'behind', schema_detail: 'migration 037b_platform_ops is in the database and not in this build', jobs_claimed: 0, sockets: 0, drain: false, started_at: now - 60_000, heartbeat_at: now });
    await h.s.ops.backups.watch(systemActor(h.tenantId));

    const first = (await root.agent.get('/api/admin/overview')).body;
    const kinds = first.alerts.map((a: { kind: string }) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(['schema', 'rpo']));
    const schema = first.alerts.find((a: { kind: string }) => a.kind === 'schema');
    expect(schema).toMatchObject({ tone: 'danger', title: 'Instance node-b:917 is behind the schema', open: { instance: 'node-b:917' } });
    // The instances counter shows it not ready, and the queue says it claims nothing.
    expect(first.instances.find((i: { id: string }) => i.id === 'node-b:917').state).toBe('not ready');

    // A tenant admin sees no platform alert.
    expect((await tara.agent.get('/api/admin/overview')).body.alerts).toEqual([]);
    // ... and cannot acknowledge one.
    expect((await send(tara, 'post', '/api/admin/overview/alerts/acknowledge', { keys: [schema.key] })).status).toBe(409);

    const ack = await send(root, 'post', '/api/admin/overview/alerts/acknowledge', { keys: [schema.key] });
    expect(ack.status).toBe(200);
    expect(ack.body.alerts.map((a: { kind: string }) => a.kind)).not.toContain('schema');
    const [event] = await audits(h, 'platform.alert.acknowledged');
    expect(JSON.parse(event!.target).alerts).toEqual([schema.key]);
    expect(JSON.parse(event!.detail!).titles).toEqual(['Instance node-b:917 is behind the schema']);
    // Hidden for every administrator of the tenant, and a second acknowledgement is refused.
    await localUser(h, 'root2', ['system-admin']);
    const root2 = await loginAdmin(h, 'root2');
    expect((await root2.agent.get('/api/admin/overview')).body.alerts.map((a: { kind: string }) => a.kind)).not.toContain('schema');
    expect((await send(root2, 'post', '/api/admin/overview/alerts/acknowledge', { keys: [schema.key] })).status).toBe(409);

    // A new occurrence (another migration) is a new key and shows again.
    await h.s.db('platform_instances').where({ id: 'node-b:917' }).update({ schema_detail: 'migration 038_next is in the database and not in this build', heartbeat_at: Date.now() });
    expect((await root.agent.get('/api/admin/overview')).body.alerts.map((a: { kind: string }) => a.kind)).toContain('schema');

    // An instance that stopped reporting is shown as not answering, with its own alert.
    await h.s.db('platform_instances').where({ id: 'node-b:917' }).update({ heartbeat_at: Date.now() - 10 * 60_000 });
    const later = (await root.agent.get('/api/admin/overview')).body;
    expect(later.instances.find((i: { id: string }) => i.id === 'node-b:917').state).toBe('not answering');
    expect(later.alerts.map((a: { kind: string }) => a.kind)).toContain('instance');
  });

  it('draining an instance from the screen stops it claiming jobs (done when), after a confirm and a recent sign-in', async () => {
    let ran = 0;
    h.s.jobs.register('test.echo', async () => {
      ran++;
      return { ok: true };
    });
    const id = h.s.instances.id;
    // A tenant admin may not drain.
    expect((await send(tara, 'post', `/api/admin/overview/instances/${encodeURIComponent(id)}/drain`)).status).toBe(403);
    // An unknown instance is 404.
    expect((await send(root, 'post', '/api/admin/overview/instances/nowhere%3A1/drain')).status).toBe(404);

    const before = await h.s.jobs.enqueue({ tenantId: h.tenantId, type: 'test.echo' });
    expect(await h.s.jobs.runDue()).toBe(1);
    expect((await h.s.jobs.get(h.tenantId, before.id))!.state).toBe('succeeded');

    const res = await send(root, 'post', `/api/admin/overview/instances/${encodeURIComponent(id)}/drain`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, drain: true, state: 'draining' });
    expect(h.s.instances.draining).toBe(true);

    const after = await h.s.jobs.enqueue({ tenantId: h.tenantId, type: 'test.echo' });
    expect(await h.s.jobs.runDue()).toBe(0);
    expect((await h.s.jobs.get(h.tenantId, after.id))!.state).toBe('queued');
    expect(ran).toBe(1);

    // Readiness answers 503 with checks.shutdown "draining", and the heartbeat keeps it so.
    const ready = await request(h.app).get('/readyz');
    expect(ready.status).toBe(503);
    expect(ready.body.checks.shutdown).toBe('draining');
    await h.s.instances.beat();
    expect((await root.agent.get('/api/admin/overview')).body.instances[0].state).toBe('draining');

    // A second drain is refused; the drain is audited with what was in flight.
    expect((await send(root, 'post', `/api/admin/overview/instances/${encodeURIComponent(id)}/drain`)).status).toBe(409);
    const [event] = await audits(h, 'platform.instance.drained');
    expect(JSON.parse(event!.target)).toEqual({ instance: id });

    // The queue shows the instance as not claiming.
    const queues = (await root.agent.get('/api/admin/queues')).body;
    expect(queues.instances.notClaiming).toEqual([{ id, state: 'draining', reason: 'draining' }]);
  });

  it('asks for a recent sign-in before draining', async () => {
    const id = h.s.instances.id;
    // Age the session's sign-in past the step-up window.
    const old = Date.now() - (h.s.cfg.STEPUP_WINDOW_SECONDS + 60) * 1000;
    await h.s.db('sessions').update({ auth_at: old });
    const res = await send(root, 'post', `/api/admin/overview/instances/${encodeURIComponent(id)}/drain`);
    expect(res.status).toBe(401);
    expect(res.body.step_up).toBe(true);
    expect(h.s.instances.draining).toBe(false);
  });
});

describe('Jobs and queues (B-4203)', () => {
  let h: Harness;
  let root: Client;
  let tara: Client;
  let other: string;

  beforeEach(async () => {
    h = await harness();
    await localUser(h, 'root', ['system-admin']);
    await localUser(h, 'tara', ['tenant-admin']);
    root = await loginAdmin(h, 'root');
    tara = await loginAdmin(h, 'tara');
    other = (await h.s.tenants.create({ slug: 'other', name: 'Other' })).id;
    await h.s.instances.beat();
  }, 60_000);
  afterEach(async () => {
    await h.close();
  });

  it('a paused type stops claiming within one poll and resumes from the screen (done when)', async () => {
    h.s.jobs.register('test.echo', async () => ({ ok: true }), { timeoutMs: 30_000 });
    const job = await h.s.jobs.enqueue({ tenantId: h.tenantId, type: 'test.echo', payload: { workspaceId: 'x', secret: 'not shown' } });

    // Only a system admin pauses a type (it acts on every tenant); a reason is optional; an unknown type is 404.
    expect((await send(tara, 'post', '/api/admin/queues/test.echo/pause', {})).status).toBe(403);
    expect((await send(root, 'post', '/api/admin/queues/no.such/pause', {})).status).toBe(404);
    const paused = await send(root, 'post', '/api/admin/queues/test.echo/pause', { reason: 'CHG-1 downstream maintenance' });
    expect(paused.status).toBe(200);
    const row = paused.body.items.find((t: { type: string }) => t.type === 'test.echo');
    expect(row).toMatchObject({ paused: true, queued: 1, running: 0, timeoutMs: 30_000, domain: 'Platform operations', pause: { reason: 'CHG-1 downstream maintenance', byName: 'ROOT' } });
    expect((await send(root, 'post', '/api/admin/queues/test.echo/pause', {})).status).toBe(409);

    // Another instance's queue (a fresh set of pauses) reads the pause at its next poll.
    h.s.jobs.setPaused([]);
    expect(await h.s.jobs.runDue()).toBe(0);
    expect(h.s.jobs.isPaused('test.echo')).toBe(true);
    expect((await h.s.jobs.get(h.tenantId, job.id))!.state).toBe('queued');

    const resumed = await send(root, 'post', '/api/admin/queues/test.echo/resume');
    expect(resumed.status).toBe(200);
    expect(resumed.body.items.find((t: { type: string }) => t.type === 'test.echo').paused).toBe(false);
    expect(await h.s.jobs.runDue()).toBe(1);
    expect((await h.s.jobs.get(h.tenantId, job.id))!.state).toBe('succeeded');
    expect((await send(root, 'post', '/api/admin/queues/test.echo/resume')).status).toBe(409);

    expect((await audits(h, 'jobs.type.paused')).map((e) => JSON.parse(e.detail!))).toEqual([{ reason: 'CHG-1 downstream maintenance', queued: 1 }]);
    expect(await audits(h, 'jobs.type.resumed')).toHaveLength(1);

    // The queue view: p50 and p95 from the succeeded job, and the series over the last day.
    const q = (await root.agent.get('/api/admin/queues')).body;
    expect(q.backend).toBe('db');
    const t = q.items.find((x: { type: string }) => x.type === 'test.echo');
    expect(t.succeeded24h).toBe(1);
    expect(t.p95Ms).toBeGreaterThanOrEqual(0);
    expect(t.series).toHaveLength(8);
  });

  it('a system admin sees every tenant with a filter; a tenant admin only their own (Q9); payloads are keys only', async () => {
    h.s.jobs.register('test.echo', async () => ({ ok: true }));
    const mine = await h.s.jobs.enqueue({ tenantId: h.tenantId, type: 'test.echo', payload: { kbId: 'k1', reason: 'text that is content' } });
    const theirs = await h.s.jobs.enqueue({ tenantId: other, type: 'test.echo' });

    const all = (await root.agent.get('/api/admin/jobs')).body;
    expect(all.items.map((j: { id: string }) => j.id)).toEqual(expect.arrayContaining([mine.id, theirs.id]));
    const one = all.items.find((j: { id: string }) => j.id === mine.id);
    expect(one).toMatchObject({ type: 'test.echo', state: 'queued', tenantName: expect.any(String), payloadKeys: ['kbId', 'reason'] });
    expect(JSON.stringify(one)).not.toContain('text that is content');
    expect(all.counts.queued).toBe(2);

    const filtered = (await root.agent.get(`/api/admin/jobs?tenant=${other}`)).body;
    expect(filtered.items.map((j: { id: string }) => j.id)).toEqual([theirs.id]);

    const own = (await tara.agent.get('/api/admin/jobs')).body;
    expect(own.items.map((j: { id: string }) => j.id)).toEqual([mine.id]);
    expect((await tara.agent.get(`/api/admin/jobs?tenant=${other}`)).status).toBe(403);
    expect((await tara.agent.get(`/api/admin/jobs/${theirs.id}`)).status).toBe(404);
    expect((await send(tara, 'post', `/api/admin/jobs/${theirs.id}/cancel`, {})).status).toBe(404);

    // Filters: state, type, window and search by id.
    expect((await root.agent.get('/api/admin/jobs?state=failed')).body.items).toEqual([]);
    expect((await root.agent.get(`/api/admin/jobs?q=${mine.id.toLowerCase()}`)).body.items.map((j: { id: string }) => j.id)).toEqual([mine.id]);
    expect((await root.agent.get('/api/admin/jobs?q=bad%25id')).status).toBe(400);
    // The queues of a tenant admin count their tenant only.
    expect((await tara.agent.get('/api/admin/queues')).body.items.find((t: { type: string }) => t.type === 'test.echo').queued).toBe(1);
  });

  it('cancels a queued job and queues a failed one again, singly or every failed job of a type', async () => {
    let fail = true;
    h.s.jobs.register('test.flaky', async () => {
      if (fail) throw new Error('downstream answered 503');
      return { ok: true };
    });
    h.s.jobs.register('test.slow', async () => ({ ok: true }));
    const q = await h.s.jobs.enqueue({ tenantId: h.tenantId, type: 'test.slow' });
    const cancelled = await send(tara, 'post', `/api/admin/jobs/${q.id}/cancel`, { reason: 'wrong file' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.state).toBe('cancelled');
    expect((await send(tara, 'post', `/api/admin/jobs/${q.id}/cancel`, {})).status).toBe(409);
    expect(JSON.parse((await audits(h, 'jobs.cancelled'))[0]!.detail!)).toMatchObject({ type: 'test.slow', state: 'queued', reason: 'wrong file' });

    const a = await h.s.jobs.enqueue({ tenantId: h.tenantId, type: 'test.flaky', maxAttempts: 1 });
    const b = await h.s.jobs.enqueue({ tenantId: other, type: 'test.flaky', maxAttempts: 1 });
    await h.s.jobs.runDue();
    const failed = (await root.agent.get(`/api/admin/jobs/${a.id}`)).body;
    expect(failed).toMatchObject({ state: 'failed', error: 'downstream answered 503', attempts: 1 });
    expect(failed.timeline.map((e: { title: string }) => e.title)).toEqual(['queued', expect.stringMatching(/^claimed by /), 'failed']);

    // A succeeded job cannot be queued again; a failed one can, with a fresh attempt count.
    fail = false;
    const retried = await send(tara, 'post', `/api/admin/jobs/${a.id}/retry`);
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ state: 'queued', attempts: 0, message: 'Queued again by TARA' });
    await h.s.jobs.runDue();
    expect((await h.s.jobs.get(h.tenantId, a.id))!.state).toBe('succeeded');
    expect((await send(tara, 'post', `/api/admin/jobs/${a.id}/retry`)).status).toBe(409);

    // Retry failed of a type: a tenant admin's covers their tenant only; a system admin's every tenant.
    expect((await send(tara, 'post', '/api/admin/jobs/retry-failed', { type: 'test.flaky' })).body).toEqual({ retried: 0 });
    expect((await send(root, 'post', '/api/admin/jobs/retry-failed', { type: 'test.flaky', window: '1h' })).body).toEqual({ retried: 1 });
    expect((await h.s.jobs.get(other, b.id))!.state).toBe('queued');
    expect((await audits(h, 'jobs.retried')).length).toBe(2);
  });

  it('lists the schedules with their last runs; runs one now and pauses it (system admins only)', async () => {
    let runs = 0;
    h.s.jobs.register('test.tick', async (_p, ctx) => {
      runs++;
      await ctx.progress(100, 'ok, 3 checked');
      return null;
    });
    h.s.scheduler.every('test.tick', 3600_000, async () => [{ tenantId: h.tenantId, key: 'platform' }]);
    // every() queues the current bucket at once.
    await new Promise((r) => setTimeout(r, 50));
    await h.s.jobs.runDue();
    expect(runs).toBe(1);

    const list = (await tara.agent.get('/api/admin/schedules')).body.items;
    const sched = list.find((x: { name: string }) => x.name === 'test.tick');
    expect(sched).toMatchObject({ type: 'test.tick', everyMs: 3600_000, targets: 'platform', paused: false, last: { state: 'succeeded', result: 'ok, 3 checked', manual: false } });
    expect(sched.nextAt).toBeGreaterThan(Date.now());

    expect((await send(tara, 'post', '/api/admin/schedules/test.tick/run')).status).toBe(403);
    const run = await send(root, 'post', '/api/admin/schedules/test.tick/run');
    expect(run.status).toBe(202);
    expect(run.body.queued).toBe(1);
    await h.s.jobs.runDue();
    expect(runs).toBe(2);
    const after = (await root.agent.get('/api/admin/schedules')).body.items.find((x: { name: string }) => x.name === 'test.tick');
    expect(after.runs).toHaveLength(2);
    expect(after.last.manual).toBe(true);

    const paused = await send(root, 'post', '/api/admin/schedules/test.tick/pause', { reason: 'noisy' });
    expect(paused.status).toBe(200);
    expect(paused.body.items.find((x: { name: string }) => x.name === 'test.tick')).toMatchObject({ paused: true, nextAt: null, pause: { reason: 'noisy' } });
    expect(await h.s.scheduler.isPaused!('test.tick')).toBe(true);
    expect((await send(root, 'post', '/api/admin/schedules/test.tick/pause', {})).status).toBe(409);
    expect((await send(root, 'post', '/api/admin/schedules/test.tick/resume')).status).toBe(200);
    expect((await send(root, 'post', '/api/admin/schedules/no.such/run')).status).toBe(404);
    for (const a of ['jobs.schedule.run', 'jobs.schedule.paused', 'jobs.schedule.resumed']) expect(await audits(h, a)).toHaveLength(1);

    // The Overview lists the next schedules.
    const ov = (await root.agent.get('/api/admin/overview')).body;
    expect(ov.schedules.items.map((x: { name: string }) => x.name)).toContain('test.tick');
  });

  it('redrives a moderation dead letter as a job and discards another with a reason', async () => {
    const t = Date.now();
    const row = (id: string) => ({ id, tenant_id: h.tenantId, job_id: '01J0000000000000000000JOB' + id.slice(-1), type: 'moderation.provider', payload: JSON.stringify({ flagId: 'f1' }), error: 'provider timed out 3 times', attempts: 3, state: 'open', failed_at: t, redriven_by: null, redriven_at: null, redrive_job_id: null });
    await h.s.db('moderation_dead_letters').insert([row('01J00000000000000000000DL1'), row('01J00000000000000000000DL2')]);

    const list = (await tara.agent.get('/api/admin/dead-letters')).body;
    expect(list.sources).toContain('moderation');
    expect(list.items.map((d: { id: string }) => d.id).sort()).toEqual(['01J00000000000000000000DL1', '01J00000000000000000000DL2']);
    expect(list.items[0]).toMatchObject({ source: 'moderation', reason: 'provider timed out 3 times', attempts: 3, redrivesAs: 'moderation.provider' });

    const redriven = await send(tara, 'post', '/api/admin/dead-letters/moderation/01J00000000000000000000DL1/redrive');
    expect(redriven.status).toBe(201);
    const job = await h.s.jobs.get(h.tenantId, redriven.body.jobId);
    expect(job).toMatchObject({ type: 'moderation.provider', state: 'queued', payload: { flagId: 'f1' } });
    expect(await audits(h, 'moderation.job.redriven')).toHaveLength(1);

    expect((await send(tara, 'post', '/api/admin/dead-letters/moderation/01J00000000000000000000DL2/discard', {})).status).toBe(400);
    const discarded = await send(tara, 'post', '/api/admin/dead-letters/moderation/01J00000000000000000000DL2/discard', { reason: 'flag closed by hand' });
    expect(discarded.status).toBe(200);
    expect(discarded.body.items).toEqual([]);
    expect((await h.s.db('moderation_dead_letters').where({ id: '01J00000000000000000000DL2' }).first()).state).toBe('discarded');
    expect(JSON.parse((await audits(h, 'jobs.deadletter.discarded'))[0]!.detail!)).toMatchObject({ reason: 'flag closed by hand', type: 'moderation.provider' });
    expect((await send(tara, 'post', '/api/admin/dead-letters/moderation/01J00000000000000000000DL2/discard', { reason: 'again' })).status).toBe(409);
    expect((await send(tara, 'post', '/api/admin/dead-letters/elsewhere/01J00000000000000000000DL2/redrive')).status).toBe(400);
  });

  it('shows the tenant cache by namespace and invalidates one, broadcast and audited (Q1)', async () => {
    let loads = 0;
    const read = () => h.s.cache.get(h.tenantId, 'plugins', 'test-key', 'medium', async () => ++loads);
    await read();
    await read();
    const c = (await tara.agent.get('/api/admin/cache')).body;
    expect(c.store).toBe('memory');
    const ns = c.items.find((x: { ns: string }) => x.ns === 'plugins');
    expect(ns).toMatchObject({ tier: 'medium', description: expect.any(String) });
    expect(ns.entries).toBeGreaterThanOrEqual(1);
    expect(ns.requests).toBeGreaterThanOrEqual(2);
    expect(ns.hits).toBeGreaterThanOrEqual(1);
    expect(c.items.map((x: { ns: string }) => x.ns)).toEqual(expect.arrayContaining(['plugins', 'sanctions', 'workflow-triggers']));

    const inv = await send(tara, 'post', '/api/admin/cache/plugins/invalidate');
    expect(inv.status).toBe(200);
    expect(inv.body.items.find((x: { ns: string }) => x.ns === 'plugins').entries).toBe(0);
    await read();
    expect(loads).toBe(2);
    expect(JSON.parse((await audits(h, 'jobs.cache.invalidated'))[0]!.target)).toEqual({ namespace: 'plugins' });
    expect((await send(tara, 'post', '/api/admin/cache/unknown-ns/invalidate')).status).toBe(404);
  });
});
