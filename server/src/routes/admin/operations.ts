import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../../audit/chain.js';
import { ip, noStore, parseBody, principalOf, requireAnyPermission, requireAuth, requirePermission, requireRecentAuth } from '../../http/middleware.js';
import { JOB_STATES } from '../../platform/jobs.js';
import { isPlatformAdmin, scopeFor } from '../../ops/jobs-admin.js';
import type { Services } from '../../services.js';

/*
 * 1.6.0 (B-4202, B-4203): the Overview and Jobs and queues screens.
 *
 *   tenant:manage or platform:manage   read the Overview, jobs, queues, schedules, dead letters and the cache;
 *                                      acknowledge alerts (tenant-wide), cancel and retry jobs in scope, redrive and
 *                                      discard dead letters (with the domain's own permission), invalidate a cache
 *                                      namespace of the tenant
 *   platform:manage                    drain an instance (with a recent sign-in), pause and resume a job type, run,
 *                                      pause and resume a schedule: these act on every tenant
 *
 * A system admin sees every tenant's jobs and may filter by `tenant`; a tenant admin sees their own tenant's (Q9).
 */

const WINDOWS = { '1h': 3600_000, '24h': 24 * 3600_000, '7d': 7 * 24 * 3600_000 } as const;
const windowParam = z.enum(['1h', '24h', '7d']);
const id26 = z.string().regex(/^[0-9A-Za-z]{26}$/);
const tenantParam = z.string().regex(/^[0-9A-Za-z]{26}$/).optional();
const jobType = z.string().regex(/^[a-z][a-z0-9._-]{0,99}$/);
const reason = z.string().trim().max(500).optional();

export function operationsAdminRoutes(s: Services): Router {
  const r = Router();
  const read = requireAnyPermission(s, ['tenant:manage', 'platform:manage']);
  const platform = requirePermission(s, 'platform:manage');
  r.use(['/overview', '/jobs', '/queues', '/schedules', '/dead-letters', '/cache'], noStore, requireAuth());
  const who = (req: Request) => ({ p: principalOf(req), ip: ip(req), trace: req.traceId });

  // ---------- B-4202: Overview ----------

  r.get('/overview', read, async (req, res) => {
    const q = parseBody(z.object({ window: windowParam.default('24h') }).strict(), req.query);
    const p = principalOf(req);
    const sys = isPlatformAdmin(p);
    const [alerts, counters, schedules, audit, instances, capacity] = await Promise.all([
      s.overview.alerts(p),
      s.overview.counters(p, WINDOWS[q.window]),
      s.jobsAdmin.nextSchedules(6),
      s.overview.recentAudit(p),
      sys ? s.instances.list() : Promise.resolve(null),
      sys ? s.overview.capacity() : Promise.resolve(null)
    ]);
    res.json({
      scope: sys ? 'platform' : 'tenant', window: q.window, alerts, counters, schedules, audit,
      instances, heartbeatSeconds: Math.round(s.instances.heartbeatMs / 1000), capacity,
      metricsUrl: sys ? `${s.cfg.PUBLIC_URL.replace(/\/$/, '')}/metrics` : null, metricsToken: !!s.cfg.METRICS_TOKEN
    });
  });

  r.post('/overview/alerts/acknowledge', read, async (req, res) => {
    const body = parseBody(z.object({ keys: z.array(z.string().min(1).max(200)).min(1).max(50) }).strict(), req.body ?? {});
    const { p, ip: addr, trace } = who(req);
    res.json({ alerts: await s.overview.acknowledge(p, body.keys, addr, trace) });
  });

  // Q14: from the console, with a confirm and a recent sign-in.
  r.post('/overview/instances/:id/drain', requireAuth({ sessionOnly: true }), platform, requireRecentAuth(s), async (req, res) => {
    const id = parseBody(z.string().min(1).max(100), req.params.id);
    const p = principalOf(req);
    res.json(await s.instances.drain({ tenantId: p.tenantId, actor: actorFrom(p, ip(req)), userId: p.userId, traceId: req.traceId }, id));
  });

  // ---------- B-4203: Jobs and queues ----------

  r.get('/queues', read, async (req, res) => {
    const q = parseBody(z.object({ tenant: tenantParam }).strict(), req.query);
    res.json(await s.jobsAdmin.queues(scopeFor(principalOf(req), q.tenant)));
  });

  r.post('/queues/:type/pause', platform, async (req, res) => {
    const type = parseBody(jobType, req.params.type);
    const body = parseBody(z.object({ reason }).strict(), req.body ?? {});
    const { p, ip: addr, trace } = who(req);
    await s.jobsAdmin.pauseType(p, type, body.reason || null, addr, trace);
    res.json(await s.jobsAdmin.queues(scopeFor(p)));
  });

  r.post('/queues/:type/resume', platform, async (req, res) => {
    const type = parseBody(jobType, req.params.type);
    const { p, ip: addr, trace } = who(req);
    await s.jobsAdmin.resumeType(p, type, addr, trace);
    res.json(await s.jobsAdmin.queues(scopeFor(p)));
  });

  r.get('/jobs', read, async (req, res) => {
    const q = parseBody(z.object({
      state: z.enum(JOB_STATES).optional(), type: jobType.optional(), window: windowParam.optional(), tenant: tenantParam,
      q: z.string().trim().regex(/^[0-9A-Za-z]{1,32}$/, 'A job id or a trace id').optional(), limit: z.coerce.number().int().min(1).max(500).optional()
    }).strict(), req.query);
    res.json(await s.jobsAdmin.list(scopeFor(principalOf(req), q.tenant), { ...(q.state ? { state: q.state } : {}), ...(q.type ? { type: q.type } : {}), ...(q.window ? { windowMs: WINDOWS[q.window] } : {}), ...(q.q ? { q: q.q } : {}), ...(q.limit ? { limit: q.limit } : {}) }));
  });

  r.post('/jobs/retry-failed', read, async (req, res) => {
    const body = parseBody(z.object({ type: jobType.optional(), window: windowParam.default('24h'), tenant: tenantParam }).strict(), req.body ?? {});
    const { p, ip: addr, trace } = who(req);
    res.json(await s.jobsAdmin.retryFailed(p, scopeFor(p, body.tenant), { ...(body.type ? { type: body.type } : {}), windowMs: WINDOWS[body.window] }, addr, trace));
  });

  r.get('/jobs/:id', read, async (req, res) => {
    res.json(await s.jobsAdmin.get(scopeFor(principalOf(req)), parseBody(id26, req.params.id)));
  });

  r.post('/jobs/:id/cancel', read, async (req, res) => {
    const id = parseBody(id26, req.params.id);
    const body = parseBody(z.object({ reason }).strict(), req.body ?? {});
    const { p, ip: addr, trace } = who(req);
    res.json(await s.jobsAdmin.cancel(p, scopeFor(p), id, body.reason || null, addr, trace));
  });

  r.post('/jobs/:id/retry', read, async (req, res) => {
    const id = parseBody(id26, req.params.id);
    parseBody(z.object({}).strict(), req.body ?? {});
    const { p, ip: addr, trace } = who(req);
    res.json(await s.jobsAdmin.retry(p, scopeFor(p), id, addr, trace));
  });

  r.get('/schedules', read, async (_req, res) => {
    res.json(await s.jobsAdmin.schedules());
  });

  const scheduleName = z.string().regex(/^[a-z][a-z0-9._-]{0,99}$/);
  r.post('/schedules/:name/run', platform, async (req, res) => {
    const name = parseBody(scheduleName, req.params.name);
    const { p, ip: addr, trace } = who(req);
    res.status(202).json(await s.jobsAdmin.runSchedule(p, name, addr, trace));
  });

  r.post('/schedules/:name/pause', platform, async (req, res) => {
    const name = parseBody(scheduleName, req.params.name);
    const body = parseBody(z.object({ reason }).strict(), req.body ?? {});
    const { p, ip: addr, trace } = who(req);
    await s.jobsAdmin.pauseSchedule(p, name, body.reason || null, addr, trace);
    res.json(await s.jobsAdmin.schedules());
  });

  r.post('/schedules/:name/resume', platform, async (req, res) => {
    const name = parseBody(scheduleName, req.params.name);
    const { p, ip: addr, trace } = who(req);
    await s.jobsAdmin.resumeSchedule(p, name, addr, trace);
    res.json(await s.jobsAdmin.schedules());
  });

  const source = z.enum(['moderation', 'workflow']);
  r.get('/dead-letters', read, async (req, res) => {
    res.json(await s.jobsAdmin.deadLetters(principalOf(req)));
  });

  r.post('/dead-letters/:source/:id/redrive', read, async (req, res) => {
    const src = parseBody(source, req.params.source);
    const id = parseBody(id26, req.params.id);
    const { p, ip: addr, trace } = who(req);
    res.status(201).json(await s.jobsAdmin.redrive(p, src, id, addr, trace));
  });

  r.post('/dead-letters/:source/:id/discard', read, async (req, res) => {
    const src = parseBody(source, req.params.source);
    const id = parseBody(id26, req.params.id);
    const body = parseBody(z.object({ reason: z.string().trim().min(1, 'Say why it is discarded.').max(500) }).strict(), req.body ?? {});
    const { p, ip: addr, trace } = who(req);
    await s.jobsAdmin.discard(p, src, id, body.reason, addr, trace);
    res.json(await s.jobsAdmin.deadLetters(p));
  });

  r.get('/cache', read, async (req, res) => {
    res.json(await s.jobsAdmin.cache(principalOf(req)));
  });

  r.post('/cache/:ns/invalidate', read, async (req, res) => {
    const ns = parseBody(z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/), req.params.ns);
    const { p, ip: addr, trace } = who(req);
    await s.jobsAdmin.invalidate(p, ns, addr, trace);
    res.json(await s.jobsAdmin.cache(p));
  });

  return r;
}
