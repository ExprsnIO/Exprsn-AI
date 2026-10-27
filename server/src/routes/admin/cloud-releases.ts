import { Router, type Request } from 'express';
import { z } from 'zod';
import type { CloudActor } from '../../cloud/accounts.js';
import { restoreSchema, upgradeApplySchema, upgradeSchema } from '../../cloud/upgrades.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission, requireRecentAuth } from '../../http/middleware.js';
import type { Services } from '../../services.js';

/*
 * 1.9.99-final, Sprint 58 (B-10203, B-10207): a Kubernetes deployment's Helm releases, its upgrades by image digest,
 * and the database snapshots taken before them with their dual-controlled restore (`cloud/releases.ts`,
 * `cloud/upgrades.ts`). Reads need `cloud:read`; installing again, planning and applying an upgrade, and asking for a
 * restore `cloud:deploy` (applying and asking with a recent sign-in); approving or refusing a restore `cloud:admin`,
 * approving with a recent sign-in and never by the person who asked. A platform deployment also needs
 * `platform:manage` (checked in the services). Without migration 151 every route answers 503 `migration_pending`.
 *
 *   GET  /admin/cloud/deployments/:id/releases                                    the release's revisions
 *   POST /admin/cloud/deployments/:id/releases/install                            → 202 { job } (again, after a failure)
 *   GET  /admin/cloud/deployments/:id/upgrades
 *   POST /admin/cloud/deployments/:id/upgrades                                    { image | imageDigest, externalBackup? } → 201 { upgrade, plan }
 *   GET  /admin/cloud/deployments/:id/upgrades/:upgradeId
 *   POST /admin/cloud/deployments/:id/upgrades/:upgradeId/apply                   { hash } → 202 { upgrade, job }
 *   GET  /admin/cloud/deployments/:id/snapshots
 *   POST /admin/cloud/deployments/:id/snapshots/:snapshotId/restore               { note? } (ask)
 *   POST /admin/cloud/deployments/:id/snapshots/:snapshotId/restore/approve       { note? } (a second cloud admin) → 202
 *   POST /admin/cloud/deployments/:id/snapshots/:snapshotId/restore/reject        { note? }
 */

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
const actorOf = (req: Request): CloudActor => ({ principal: principalOf(req), ip: ip(req), traceId: req.traceId });

export function cloudReleaseRoutes(s: Services): Router {
  const r = Router();
  const read = [noStore, requireAuth(), requirePermission(s, 'cloud:read')];
  const deploy = [noStore, requireAuth(), requirePermission(s, 'cloud:deploy')];
  const freshDeploy = [noStore, requireAuth({ sessionOnly: true }), requirePermission(s, 'cloud:deploy'), requireRecentAuth(s)];
  const admin = [noStore, requireAuth(), requirePermission(s, 'cloud:admin')];
  const freshAdmin = [noStore, requireAuth({ sessionOnly: true }), requirePermission(s, 'cloud:admin'), requireRecentAuth(s)];
  const rel = () => s.cloud.releases;

  r.get('/cloud/deployments/:id/releases', ...read, async (req, res) => {
    res.json({ releases: await rel().list(principalOf(req), parseBody(id26, req.params.id)) });
  });

  r.post('/cloud/deployments/:id/releases/install', ...freshDeploy, async (req, res) => {
    const p = principalOf(req);
    await rel().need();
    const d = await s.cloud.deployments.getFor(p, parseBody(id26, req.params.id));
    s.cloud.deployments.assertCanDeploy(p, d);
    rel().specOf(d);
    const job = await s.jobs.enqueue({ tenantId: d.tenantId, type: 'cloud.release', payload: { deploymentId: d.id }, createdBy: p.userId, maxAttempts: 2 });
    res.status(202).json({ job: { id: job.id, type: 'cloud.release' } });
  });

  r.get('/cloud/deployments/:id/upgrades', ...read, async (req, res) => {
    res.json({ upgrades: await rel().upgrades.list(principalOf(req), parseBody(id26, req.params.id)) });
  });

  r.post('/cloud/deployments/:id/upgrades', ...deploy, async (req, res) => {
    const body = parseBody(upgradeSchema, req.body ?? {});
    const out = await rel().upgrades.plan(actorOf(req), parseBody(id26, req.params.id), body);
    res.status(201).json(out);
  });

  r.get('/cloud/deployments/:id/upgrades/:upgradeId', ...read, async (req, res) => {
    res.json({ upgrade: await rel().upgrades.getFor(principalOf(req), parseBody(id26, req.params.id), parseBody(id26, req.params.upgradeId)) });
  });

  r.post('/cloud/deployments/:id/upgrades/:upgradeId/apply', ...freshDeploy, async (req, res) => {
    const body = parseBody(upgradeApplySchema, req.body ?? {});
    const out = await rel().upgrades.apply(actorOf(req), parseBody(id26, req.params.id), parseBody(id26, req.params.upgradeId), body.hash);
    res.status(202).json({ upgrade: out.upgrade, job: { id: out.jobId, type: 'cloud.apply' } });
  });

  r.get('/cloud/deployments/:id/snapshots', ...read, async (req, res) => {
    res.json({ snapshots: await rel().upgrades.snapshots(principalOf(req), parseBody(id26, req.params.id)) });
  });

  r.post('/cloud/deployments/:id/snapshots/:snapshotId/restore', ...freshDeploy, async (req, res) => {
    const body = parseBody(restoreSchema, req.body ?? {});
    res.json({ snapshot: await rel().upgrades.requestRestore(actorOf(req), parseBody(id26, req.params.id), parseBody(id26, req.params.snapshotId), body.note ?? null) });
  });

  r.post('/cloud/deployments/:id/snapshots/:snapshotId/restore/approve', ...freshAdmin, async (req, res) => {
    const body = parseBody(restoreSchema, req.body ?? {});
    const out = await rel().upgrades.approveRestore(actorOf(req), parseBody(id26, req.params.id), parseBody(id26, req.params.snapshotId), body.note ?? null);
    res.status(202).json({ snapshot: out.snapshot, job: { id: out.jobId, type: 'cloud.snapshot.restore' } });
  });

  r.post('/cloud/deployments/:id/snapshots/:snapshotId/restore/reject', ...admin, async (req, res) => {
    const body = parseBody(restoreSchema, req.body ?? {});
    res.json({ snapshot: await rel().upgrades.rejectRestore(actorOf(req), parseBody(id26, req.params.id), parseBody(id26, req.params.snapshotId), body.note ?? null) });
  });

  return r;
}
