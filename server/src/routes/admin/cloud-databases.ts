import { Router, type Request } from 'express';
import { z } from 'zod';
import type { CloudActor } from '../../cloud/accounts.js';
import { restoreToNewSchema, scheduleSchema, snapshotNowSchema } from '../../cloud/databases.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission, requireRecentAuth } from '../../http/middleware.js';
import type { Services } from '../../services.js';

/*
 * 1.9.99-final, Sprint 59 (B-10301, B-10303, B-10307): a deployment's managed databases (`cloud/databases.ts`): what
 * each is (engine, version, size, HA, storage, backups, maintenance window, deletion protection, parameters), the
 * extension check, its snapshots with their cost and retention, a snapshot now, the snapshot schedule, and a restore to
 * a new instance. Reads need `cloud:read`; a snapshot, a schedule and a restore `cloud:deploy` (the snapshot and the
 * restore with a recent sign-in). A platform deployment also needs `platform:manage` (checked in the services).
 * Without migration 153 the schedule answers 503 `migration_pending`; everything else works.
 *
 *   GET  /admin/cloud/deployments/:id/databases
 *   GET  /admin/cloud/deployments/:id/databases/:key/extensions?names=vector,postgis
 *   GET  /admin/cloud/deployments/:id/databases/:key/snapshots
 *   POST /admin/cloud/deployments/:id/databases/:key/snapshots                           { note? } → 202 { job }
 *   PUT  /admin/cloud/deployments/:id/databases/:key/schedule                            { everyHours, keep, enabled }
 *   POST /admin/cloud/deployments/:id/databases/:key/snapshots/:snapshotId/restore       { key?, size? } → 202 { job, key }
 */

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
const key = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, 'a resource key');
const snapshotId = z.string().trim().min(1).max(500);
const names = z
  .string()
  .max(200)
  .optional()
  .transform((v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined))
  .pipe(z.array(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/)).max(20).optional());
const actorOf = (req: Request): CloudActor => ({ principal: principalOf(req), ip: ip(req), traceId: req.traceId });

export function cloudDatabaseRoutes(s: Services): Router {
  const r = Router();
  const read = [noStore, requireAuth(), requirePermission(s, 'cloud:read')];
  const deploy = [noStore, requireAuth(), requirePermission(s, 'cloud:deploy')];
  const freshDeploy = [noStore, requireAuth({ sessionOnly: true }), requirePermission(s, 'cloud:deploy'), requireRecentAuth(s)];
  const db = () => s.cloud.databases;

  r.get('/cloud/deployments/:id/databases', ...read, async (req, res) => {
    res.json({ databases: await db().list(principalOf(req), parseBody(id26, req.params.id)) });
  });

  r.get('/cloud/deployments/:id/databases/:key/extensions', ...read, async (req, res) => {
    const wanted = parseBody(names, typeof req.query.names === 'string' ? req.query.names : undefined);
    res.json(await db().extensions(principalOf(req), parseBody(id26, req.params.id), parseBody(key, req.params.key), wanted));
  });

  r.get('/cloud/deployments/:id/databases/:key/snapshots', ...read, async (req, res) => {
    res.json(await db().snapshots(principalOf(req), parseBody(id26, req.params.id), parseBody(key, req.params.key)));
  });

  r.post('/cloud/deployments/:id/databases/:key/snapshots', ...freshDeploy, async (req, res) => {
    const body = parseBody(snapshotNowSchema, req.body ?? {});
    const out = await db().snapshotNow(actorOf(req), parseBody(id26, req.params.id), parseBody(key, req.params.key), body.note ?? null);
    res.status(202).json({ job: { id: out.jobId, type: 'cloud.db.snapshot' } });
  });

  r.put('/cloud/deployments/:id/databases/:key/schedule', ...deploy, async (req, res) => {
    const body = parseBody(scheduleSchema, req.body ?? {});
    res.json({ schedule: await db().setSchedule(actorOf(req), parseBody(id26, req.params.id), parseBody(key, req.params.key), body) });
  });

  r.post('/cloud/deployments/:id/databases/:key/snapshots/:snapshotId/restore', ...freshDeploy, async (req, res) => {
    const body = parseBody(restoreToNewSchema, req.body ?? {});
    const out = await db().restore(actorOf(req), parseBody(id26, req.params.id), parseBody(key, req.params.key), parseBody(snapshotId, req.params.snapshotId), body);
    res.status(202).json({ job: { id: out.jobId, type: 'cloud.db.restore' }, key: out.key });
  });

  return r;
}
