import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom, type AuditEvent, type AuditQuery } from '../../audit/chain.js';
import { clears, LABELS, type Label } from '../../authz/labels.js';
import { effectivePermissions } from '../../authz/policy.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import { forbidden, HttpProblem, notFound } from '../../http/problem.js';
import type { ExportRow } from '../../audit/exports.js';
import type { Services } from '../../services.js';

/** Events above the reader's clearance keep their place in the chain but lose their content. */
export const redact = (e: AuditEvent, clearance: Label) =>
  clears(clearance, e.label) ? e : { id: e.id, seq: e.seq, ts: e.ts, action: e.action, kind: e.kind, label: e.label, hash: e.hash, prev_hash: e.prev_hash, corrects: e.corrects, redacted: true };

const filters = z.object({
  kind: z.enum(['auth', 'decision', 'admin', 'correction', 'system']).optional(),
  action: z.string().max(100).regex(/^[a-z0-9._]*$/).optional(),
  from: z.coerce.number().int().min(0).optional(),
  to: z.coerce.number().int().min(0).optional(),
  label: z.enum(LABELS).optional(),
  actor: z.string().max(190).optional()
});

export const exportView = (x: ExportRow) => ({ id: x.id, kind: x.kind, file: x.file, scope: x.scope, maxLabel: x.max_label, state: x.state, rows: x.rows, omitted: x.omitted, jobId: x.job_id, createdBy: x.created_by, createdAt: x.created_at });

export function auditAdminRoutes(s: Services): Router {
  const r = Router();
  r.use('/audit', noStore, requireAuth(), requirePermission(s, 'audit:read'));
  r.use('/exports', noStore, requireAuth());

  const audit = (req: Request, action: string, kind: 'admin' | 'system', target: Record<string, unknown>, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind, actor: actorFrom(p, ip(req)), target, ...(detail ? { detail } : {}), traceId: req.traceId });
  };

  r.get('/audit', async (req, res) => {
    const p = principalOf(req);
    const q = parseBody(filters.extend({ limit: z.coerce.number().int().min(1).max(500).default(100), before: z.coerce.number().int().min(1).optional() }), req.query);
    const events = await s.audit.list(p.tenantId, q);
    res.json(events.map((e) => redact(e, p.clearance)));
  });

  r.get('/audit/summary', async (req, res) => {
    const p = principalOf(req);
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const [head, checkpoint, today] = await Promise.all([s.audit.head(p.tenantId), s.checkpoints.latest(p.tenantId), s.audit.countSince(p.tenantId, since.getTime())]);
    const lastVerify = (await s.audit.list(p.tenantId, { action: 'audit.chain.verified', limit: 1 }))[0];
    res.json({
      head,
      eventsToday: today,
      checkpoint: checkpoint ? { seq: checkpoint.seq, hash: checkpoint.hash, ts: checkpoint.ts, key: checkpoint.key, store: s.blobs.kind } : null,
      lastVerification: lastVerify ? { ts: lastVerify.ts, ...(lastVerify.detail ?? {}) } : null,
      siem: s.siem.view()
    });
  });

  r.get('/audit/checkpoints', async (req, res) => {
    res.json((await s.checkpoints.list(principalOf(req).tenantId)).map((c) => ({ id: c.id, seq: c.seq, hash: c.hash, ts: c.ts, key: c.key, createdBy: c.created_by })));
  });

  r.post('/audit/checkpoints', async (req, res) => {
    const p = principalOf(req);
    const c = await s.checkpoints.create(p.tenantId, p.username);
    if (c) await audit(req, 'audit.checkpoint.signed', 'system', { seq: c.seq, hash: c.hash }, { key: c.key });
    res.status(c ? 201 : 200).json(c ? { id: c.id, seq: c.seq, hash: c.hash, ts: c.ts } : { skipped: 'The head is already checkpointed.' });
  });

  r.post('/audit/verify', async (req, res) => {
    const p = principalOf(req);
    const result = await s.checkpoints.verify(p.tenantId);
    let notified: string[] = [];
    if (result.status === 'broken') {
      s.log.error({ tenant: p.tenantId, brokenAt: result.brokenAt }, 'audit chain verification failed');
      const people = await s.notifications.usersWithRoles(p.tenantId, ['tenant-admin', 'auditor', 'system-admin']);
      const rows = await s.notifications.notify({ tenantId: p.tenantId, userIds: people, kind: 'audit.broken', title: `Audit chain verification failed at sequence ${result.brokenAt?.seq}`, body: result.brokenAt?.reason, route: 'usage-audit', email: true });
      notified = (await s.db('users').whereIn('id', rows.map((x) => x.user_id)).select('username')).map((u: { username: string }) => u.username);
    }
    await audit(req, 'audit.chain.verified', 'system', {}, { status: result.status, checked: result.checked, checkpoints: result.checkpoints.checked, lastGoodCheckpoint: result.lastGoodCheckpoint, ...(result.brokenAt ? { brokenAt: result.brokenAt, notified } : {}) });
    res.json({ ...result, notified });
  });

  r.get('/audit/stream', (_req, res) => {
    res.json(s.siem.view());
  });

  r.get('/audit/:id', async (req, res) => {
    const p = principalOf(req);
    const e = await s.audit.get(p.tenantId, String(req.params.id));
    if (!e) throw notFound('Audit event');
    const corrections = await s.audit.list(p.tenantId, { corrects: e.id, limit: 50 });
    res.json({ ...redact(e, p.clearance), correctedBy: corrections.map((c) => ({ id: c.id, seq: c.seq, ts: c.ts })) });
  });

  /**
   * A correction is a new row that references the row it corrects; the original is never edited. Allowed for the
   * original actor, or a tenant admin, and only for rows the caller is cleared to read.
   */
  r.post('/audit/:id/corrections', async (req, res) => {
    const p = principalOf(req);
    const e = await s.audit.get(p.tenantId, String(req.params.id));
    if (!e) throw notFound('Audit event');
    if (!clears(p.clearance, e.label)) throw forbidden('This event is above your clearance.', { step: 'clearance' });
    if (e.actor.user !== p.userId && !effectivePermissions(p).has('tenant:manage')) throw forbidden('Only the original actor or a tenant admin can correct an event.', { step: 'role' });
    if (e.kind === 'correction') throw forbidden('Correct the original event, not a correction.', { step: 'correction' });
    const body = parseBody(z.object({ reason: z.string().trim().min(5).max(500), correction: z.record(z.string(), z.unknown()).default({}) }), req.body);
    const row = await s.audit.append({ tenantId: p.tenantId, action: 'audit.correction', kind: 'correction', actor: actorFrom(p, ip(req)), target: { event: e.id, seq: e.seq, action: e.action }, label: e.label, detail: { reason: body.reason, correction: body.correction }, corrects: e.id, traceId: req.traceId });
    res.status(201).json(row);
  });

  // ---------- exports ----------

  r.post('/audit/exports', async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(filters.extend({ filtered: z.boolean().default(false) }), req.body);
    const q: AuditQuery = { ...(body.kind ? { kind: body.kind } : {}), ...(body.action ? { action: body.action } : {}), ...(body.from ? { from: body.from } : {}), ...(body.to ? { to: body.to } : {}), ...(body.label ? { label: body.label } : {}), ...(body.actor ? { actor: body.actor } : {}) };
    const counts = await s.exports.auditAbove(p.tenantId, q, p.clearance);
    if (counts.above > 0 && !body.filtered) {
      await audit(req, 'audit.export.blocked', 'system', {}, { ...counts, clearance: p.clearance });
      throw new HttpProblem(403, 'Export blocked', `The selection includes ${counts.above} events above your ${p.clearance} clearance. Export ${p.clearance} and below instead, or ask someone cleared for them.`, {
        extensions: { step: 'clearance', total: counts.total, above: counts.above, clearance: p.clearance }
      });
    }
    const range = body.from || body.to ? `${body.from ? new Date(body.from).toISOString().slice(0, 10) : 'start'} to ${body.to ? new Date(body.to).toISOString().slice(0, 10) : 'now'}` : 'all time';
    const x = await s.exports.request({ tenantId: p.tenantId, tenantSlug: p.tenantSlug, kind: 'audit', params: { ...q }, scope: `Audit, ${range}, ${p.clearance} and below${body.kind ? `, ${body.kind}` : ''}`, maxLabel: p.clearance, userId: p.userId });
    await audit(req, 'audit.export.requested', 'admin', { export: x.id }, { ...counts, filtered: counts.above > 0, filter: q });
    res.status(202).json({ ...exportView(x), total: counts.total, omitted: counts.above });
  });

  const canSeeExports = (req: Request) => {
    const perms = effectivePermissions(principalOf(req));
    if (!perms.has('audit:read') && !perms.has('usage:read')) throw forbidden('Exports need audit:read or usage:read.', { step: 'role', action: 'audit:read' });
    return perms;
  };

  r.get('/exports', async (req, res) => {
    const perms = canSeeExports(req);
    const p = principalOf(req);
    const rows = (await s.exports.list(p.tenantId)).filter((x) => (x.kind === 'audit' ? perms.has('audit:read') : perms.has('usage:read')));
    const names = new Map((await s.db('users').whereIn('id', [...new Set(rows.map((x) => x.created_by))]).select('id', 'display_name')).map((u: { id: string; display_name: string }) => [u.id, u.display_name]));
    res.json(rows.map((x) => ({ ...exportView(x), createdByName: names.get(x.created_by) ?? null })));
  });

  r.get('/exports/:id/download', async (req, res) => {
    const perms = canSeeExports(req);
    const p = principalOf(req);
    const x = await s.exports.get(p.tenantId, String(req.params.id));
    if (!x || !(x.kind === 'audit' ? perms.has('audit:read') : perms.has('usage:read'))) throw notFound('Export');
    if (!clears(p.clearance, x.max_label)) throw forbidden(`This export holds ${x.max_label} rows, above your clearance.`, { step: 'clearance' });
    if (x.state !== 'ready') throw new HttpProblem(409, 'Not ready', 'The export is still being prepared.');
    const content = await s.exports.content(x);
    if (!content) throw notFound('Export file');
    await audit(req, 'export.downloaded', 'admin', { export: x.id, file: x.file }, { rows: x.rows });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${x.file}"`);
    res.send(content);
  });

  return r;
}
