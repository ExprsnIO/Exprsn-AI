import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { actorFrom } from '../../audit/chain.js';
import { assertPlatformKind as assertKindAllowed, governanceFor, DUAL_CONTROL_MODES, EXPORT_INLINE_MAX, exportName, STORE_BACKUP_UPLOAD_MAX_BYTES, type GovActor, type StoreGovernance } from '../../identity/store-governance.js';
import { storeAdminFor } from '../../identity/store-admin.js';
import { storeBackupsFor } from '../../identity/store-backups.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission, requireRecentAuth } from '../../http/middleware.js';
import { HttpProblem, notFound } from '../../http/problem.js';
import type { ProviderRow } from '../../repos/providers.js';
import type { Services } from '../../services.js';

/*
 * 1.9.9-qa, Sprint QA-1 (Sprint 54 leftovers): the governance of user stores (`identity/store-governance.ts`):
 * settings, proposals under dual control, purge, scheduled backups, the CSV export of a store's users and the raw
 * upload of a large backup. Mounted from `identityStoreRoutes`; every route needs `identity:manage` (a platform store
 * also `platform:manage`); approving, purging and changing the settings need a recent sign-in; the export also needs
 * `users:manage`. Without migration 142 they answer 503 `migration_pending` (the upload needs only 141).
 *
 *   GET    /admin/identity-store-governance                    settings, dual control in force, its warning
 *   PUT    /admin/identity-store-governance                    { dualControl?, purgeAfterDays?, reason? } (off while on: 202, a proposal)
 *   GET    /admin/identity-store-proposals                     ?state=&providerId=
 *   POST   /admin/identity-store-proposals/:id/approve         { note? }: another identity admin, recent sign-in
 *   POST   /admin/identity-store-proposals/:id/reject          { note? }
 *   POST   /admin/identity-store-proposals/:id/withdraw        the proposer only
 *   POST   /admin/identity-providers/:id/purge                 an archived store past its retention (202 under dual control)
 *   GET    /admin/identity-store-backup-schedules              every schedule of the tenant
 *   GET    /admin/identity-providers/:id/backup-schedule
 *   PUT    /admin/identity-providers/:id/backup-schedule       { frequency, keepCount?, keepDays?, enabled? }
 *   DELETE /admin/identity-providers/:id/backup-schedule
 *   POST   /admin/identity-providers/:id/backup-schedule/run   one scheduled run now, as a job (202)
 *   POST   /admin/identity-providers/:id/users-export          { job? }: CSV now, or a job for a large store (202)
 *   GET    /admin/identity-store-exports/:jobId                the finished job's CSV (the requester only)
 *   PUT    /admin/identity-store-backups/upload                a raw backup file of up to 50 MB, kept for restore by id
 */

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
const noteBody = z.object({ note: z.string().trim().max(500).optional() }).strict();

export const actorOf = (req: Request): GovActor => ({ principal: principalOf(req), ip: ip(req), traceId: req.traceId });

/** What the console gets for a proposal: no payload beyond references, ids and the diff. */
const proposalView = (g: StoreGovernance, req: Request) => (x: Parameters<StoreGovernance['view']>[0]) => g.view(x, principalOf(req).userId ?? null);

export function identityStoreGovernanceRoutes(s: Services): Router {
  const r = Router();
  const gate = [noStore, requireAuth(), requirePermission(s, 'identity:manage')];
  const fresh = [noStore, requireAuth({ sessionOnly: true }), requirePermission(s, 'identity:manage'), requireRecentAuth(s)];
  const exporting = [noStore, requireAuth(), requirePermission(s, 'identity:manage'), requirePermission(s, 'users:manage')];
  const g = governanceFor(s);
  const backups = storeBackupsFor(s, storeAdminFor(s));

  const audit = (req: Request, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, ...(detail ? { detail } : {}), traceId: req.traceId });
  };

  const load = async (req: Request): Promise<ProviderRow> => {
    const row = await s.providers.get(principalOf(req).tenantId, String(req.params.id));
    if (!row) throw notFound('User store');
    assertKindAllowed(principalOf(req), row.kind);
    return row;
  };

  // ---------- settings ----------

  r.get('/identity-store-governance', ...gate, async (req, res) => {
    const tenantId = principalOf(req).tenantId;
    res.json({ available: await g.installed(), settings: await g.settings(tenantId), dualControl: await g.dualControl(tenantId), backups: await backups.installed(), uploadMaxBytes: STORE_BACKUP_UPLOAD_MAX_BYTES, exportInlineMax: EXPORT_INLINE_MAX });
  });

  r.put('/identity-store-governance', ...fresh, async (req, res) => {
    const body = parseBody(z.object({ dualControl: z.enum(DUAL_CONTROL_MODES).optional(), purgeAfterDays: z.number().int().min(1).max(3650).optional(), reason: z.string().trim().max(500).optional() }).strict(), req.body);
    const out = await g.setSettings(actorOf(req), body);
    const tenantId = principalOf(req).tenantId;
    res.status(out.proposal ? 202 : 200).json({ settings: out.settings, dualControl: await g.dualControl(tenantId), proposal: out.proposal ? proposalView(g, req)(out.proposal) : null });
  });

  // ---------- proposals ----------

  r.get('/identity-store-proposals', ...gate, async (req, res) => {
    const q = parseBody(z.object({ state: z.enum(['pending', 'approved', 'rejected', 'withdrawn', 'superseded']).optional(), providerId: id26.optional() }).strict(), req.query);
    await g.need();
    res.json((await g.list(principalOf(req).tenantId, q)).map(proposalView(g, req)));
  });

  r.post('/identity-store-proposals/:id/approve', ...fresh, async (req, res) => {
    const body = parseBody(noteBody, req.body ?? {});
    const out = await g.approve(actorOf(req), parseBody(id26, req.params.id), body.note ?? null);
    res.json({ proposal: proposalView(g, req)(out.proposal), result: out.result });
  });

  r.post('/identity-store-proposals/:id/reject', ...gate, async (req, res) => {
    const body = parseBody(noteBody, req.body ?? {});
    res.json(proposalView(g, req)(await g.reject(actorOf(req), parseBody(id26, req.params.id), body.note ?? null)));
  });

  r.post('/identity-store-proposals/:id/withdraw', ...gate, async (req, res) => {
    res.json(proposalView(g, req)(await g.withdraw(actorOf(req), parseBody(id26, req.params.id))));
  });

  // ---------- purge ----------

  r.post('/identity-providers/:id/purge', ...fresh, async (req, res) => {
    await g.need();
    const row = await load(req);
    const body = parseBody(z.object({ reason: z.string().trim().max(500).optional() }).strict(), req.body ?? {});
    const out = await purgeOrPropose(g, req, row, body.reason);
    res.status(out.status).json(out.body);
  });

  // ---------- scheduled backups ----------

  r.get('/identity-store-backup-schedules', ...gate, async (req, res) => {
    res.json({ available: (await g.installed()) && (await backups.installed()), schedules: await g.schedules(principalOf(req).tenantId) });
  });

  r.get('/identity-providers/:id/backup-schedule', ...gate, async (req, res) => {
    const row = await load(req);
    res.json({ available: (await g.installed()) && (await backups.installed()), schedule: await g.scheduleOf(row.tenant_id, row.id) });
  });

  r.put('/identity-providers/:id/backup-schedule', ...gate, async (req, res) => {
    const row = await load(req);
    const body = parseBody(
      z
        .object({ frequency: z.enum(['daily', 'weekly']), keepCount: z.number().int().min(1).max(365).nullable().default(null), keepDays: z.number().int().min(1).max(3650).nullable().default(null), enabled: z.boolean().default(true) })
        .strict(),
      req.body
    );
    res.json(await g.setSchedule(actorOf(req), row, body));
  });

  r.delete('/identity-providers/:id/backup-schedule', ...gate, async (req, res) => {
    const row = await load(req);
    if (!(await g.removeSchedule(actorOf(req), row))) throw notFound('Backup schedule');
    res.status(204).end();
  });

  r.post('/identity-providers/:id/backup-schedule/run', ...gate, async (req, res) => {
    const p = principalOf(req);
    const row = await load(req);
    if (!(await g.scheduleOf(row.tenant_id, row.id))) throw notFound('Backup schedule');
    const job = await s.jobs.enqueue({ tenantId: p.tenantId, type: 'identity.store.backup.run', payload: { tenantId: p.tenantId, providerId: row.id }, createdBy: p.userId, maxAttempts: 1 });
    await audit(req, 'identity.store.backup.run_requested', { provider: row.id, name: row.name }, { job: job.id });
    res.status(202).json({ jobId: job.id });
  });

  // ---------- CSV export of the store's users ----------

  r.post('/identity-providers/:id/users-export', ...exporting, async (req, res) => {
    const p = principalOf(req);
    await g.need();
    const row = await load(req);
    const body = parseBody(z.object({ job: z.boolean().default(false) }).strict(), req.body ?? {});
    const count = await g.linkCount(p.tenantId, row.id);
    if (body.job || count > EXPORT_INLINE_MAX) {
      // The requester's clearance from the session goes with the job, so the file holds what they may see.
      const job = await s.jobs.enqueue({ tenantId: p.tenantId, type: 'identity.store.users.export', payload: { providerId: row.id, clearance: p.clearance }, createdBy: p.userId, maxAttempts: 1 });
      await audit(req, 'identity.store.users.export_requested', { provider: row.id, name: row.name }, { job: job.id, accounts: count, clearance: p.clearance });
      return void res.status(202).json({ jobId: job.id, accounts: count });
    }
    const out = await g.exportCsv(p.tenantId, row.id, p.clearance);
    await audit(req, 'identity.store.users.exported', { provider: row.id, name: row.name }, { rows: out.rows, omitted: out.omitted, clearance: p.clearance, via: 'direct' });
    sendCsv(res, exportName(row.name), out);
  });

  r.get('/identity-store-exports/:jobId', ...exporting, async (req, res) => {
    const p = principalOf(req);
    await g.need();
    const out = await g.exportFile(p.tenantId, parseBody(id26, req.params.jobId), p.userId ?? null);
    const row = out.providerId ? await s.providers.get(p.tenantId, out.providerId) : null;
    if (row) assertKindAllowed(p, row.kind);
    await audit(req, 'identity.store.users.exported', { provider: out.providerId, name: row?.name ?? null, job: String(req.params.jobId) }, { rows: out.rows, omitted: out.omitted, clearance: p.clearance, via: 'job' });
    sendCsv(res, out.name, out);
  });

  // ---------- a large backup, uploaded raw ----------

  /** The body is the backup file itself (app.ts skips its JSON parser for this path), streamed to the blob store. */
  r.put('/identity-store-backups/upload', ...gate, async (req, res) => {
    const p = principalOf(req);
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > STORE_BACKUP_UPLOAD_MAX_BYTES) throw new HttpProblem(413, 'Too large', `A store backup upload is at most ${STORE_BACKUP_UPLOAD_MAX_BYTES / 1024 / 1024} MB.`, { extensions: { reason: 'too_large', maxBytes: STORE_BACKUP_UPLOAD_MAX_BYTES } });
    let saved;
    try {
      saved = await backups.upload(p.tenantId, p.userId ?? null, req as AsyncIterable<Buffer>, STORE_BACKUP_UPLOAD_MAX_BYTES);
    } catch (err) {
      if (err instanceof HttpProblem && (err.status === 422 || err.status === 413)) await audit(req, 'identity.store.backup.refused', { upload: true }, { reason: (err.extensions as Record<string, unknown> | undefined)?.reason ?? null, detail: err.detail });
      throw err;
    }
    try {
      assertKindAllowed(p, saved.source.store.kind);
    } catch (err) {
      await backups.remove(p.tenantId, saved.id);
      throw err;
    }
    await audit(req, 'identity.store.backup.uploaded', { backup: saved.id, archive: saved.archiveId, provider: saved.source.store.id, name: saved.source.store.name }, { bytes: saved.bytes, sha256: saved.sha256, counts: saved.counts, sourceTenant: saved.source.tenant.id });
    res.status(201).json(saved);
  });

  return r;
}

function sendCsv(res: Response, name: string, out: { csv: string; rows: number; omitted: number }): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('X-Rows', String(out.rows));
  res.setHeader('X-Omitted', String(out.omitted));
  res.send(out.csv);
}

/**
 * Removes an archived store past its retention: at once when dual control is not in force (the caller has a recent
 * sign-in), else as a proposal (202). Refused (409) before the retention period passes, with the date.
 */
export async function purgeOrPropose(g: StoreGovernance, req: Request, row: ProviderRow, reason?: string): Promise<{ status: number; body: unknown }> {
  const a = actorOf(req);
  await g.assertPurgeable(row);
  if ((await g.dualControl(row.tenant_id)).on) {
    const proposal = await g.propose(a, { kind: 'store.purge', providerId: row.id, name: row.name, payload: { ...(reason ? { reason } : {}) }, summary: `Purge the archived store ${row.name} (${row.kind}): its identity links, group mappings and versions go; the accounts stay.${reason ? ` Reason: ${reason}` : ''}` });
    return { status: 202, body: { proposal: g.view(proposal, a.principal.userId ?? null) } };
  }
  return { status: 200, body: { purged: true, ...(await g.purge(a, row)) } };
}
