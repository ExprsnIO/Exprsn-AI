import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { roleView, versionView } from '../authz/custom-roles.js';
import { LABELS } from '../authz/labels.js';
import { matrixCsv, roleMatrix } from '../authz/matrix.js';
import { isPermission, PERMISSIONS, type Permission } from '../authz/permissions.js';
import { reviewView } from '../authz/reviews.js';
import { ip, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { badRequest } from '../http/problem.js';
import type { Services } from '../services.js';

/**
 * 1.5.0, Sprint 29 (B-3301 to B-3305): the role × permission matrix, custom roles, the effective-access matrix with
 * `explain` and "who can", and access reviews. Everything needs `roles:manage`, except that the reviewers assigned to
 * a campaign's items (admins, the members' directory managers, extra reviewers) list, read and decide them.
 */
export function authzRoutes(s: Services): Router {
  const r = Router();
  r.use('/authz', requireAuth());
  const manage = requirePermission(s, 'roles:manage');
  const ctx = (req: Request) => ({ p: principalOf(req), ip: ip(req), traceId: req.traceId });

  const permission = z.string().refine(isPermission, 'Unknown permission').transform((x) => x as Permission);
  const roleId = z.string().trim().min(1).max(40);
  const definition = z.object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).default(''),
    permissions: z.array(permission).min(1).max(PERMISSIONS.length),
    requiresMfa: z.boolean().optional(),
    grantableBy: z.array(roleId).min(1).max(40).optional()
  }).strict();
  const note = z.object({ note: z.string().trim().max(500).nullable().default(null) }).strict();
  const version = (req: Request) => parseBody(z.coerce.number().int().min(1), req.params.version);

  // ---------- B-3301: the role × permission matrix ----------

  r.get('/authz/matrix', manage, (req, res) => {
    const q = parseBody(z.object({ format: z.enum(['json', 'csv']).optional() }), req.query);
    const m = roleMatrix(principalOf(req).tenantId);
    const csv = q.format === 'csv' || (!q.format && req.accepts(['application/json', 'text/csv']) === 'text/csv');
    if (csv) {
      res.type('text/csv').setHeader('Content-Disposition', 'attachment; filename="role-matrix.csv"');
      res.send(matrixCsv(m));
      return;
    }
    res.json(m);
  });

  // ---------- B-3302: custom roles ----------

  r.get('/authz/roles', manage, async (req, res) => {
    const p = principalOf(req);
    const q = parseBody(z.object({ retired: z.enum(['true', 'false']).optional() }), req.query);
    const custom = await s.customRoles.list(p.tenantId, { includeRetired: q.retired === 'true' });
    res.json({ builtIn: roleMatrix().roles, custom: custom.map((c) => roleView(c.role, c.pending)) });
  });

  r.post('/authz/roles', manage, async (req, res) => {
    const body = parseBody(definition, req.body);
    const { role, version: v } = await s.customRoles.create(ctx(req), { ...body, requiresMfa: body.requiresMfa ?? true, grantableBy: body.grantableBy ?? ['system-admin', 'tenant-admin'] });
    res.status(201).json({ role: roleView(role, v.state === 'pending' ? v : null), version: versionView(v), pending: v.state === 'pending' });
  });

  r.get('/authz/roles/:id', manage, async (req, res) => {
    const p = principalOf(req);
    const role = await s.customRoles.get(p.tenantId, String(req.params.id));
    const versions = await s.customRoles.versions(p.tenantId, role.id);
    res.json({ ...roleView(role, versions.find((v) => v.state === 'pending') ?? null), versions: versions.map(versionView) });
  });

  r.patch('/authz/roles/:id', manage, async (req, res) => {
    const body = parseBody(definition.partial().refine((b) => Object.keys(b).length > 0, 'Change at least one field.'), req.body);
    const { role, version: v } = await s.customRoles.update(ctx(req), String(req.params.id), body);
    res.json({ role: roleView(role, v.state === 'pending' ? v : null), version: versionView(v), pending: v.state === 'pending' });
  });

  r.delete('/authz/roles/:id', manage, async (req, res) => {
    res.json(roleView(await s.customRoles.retire(ctx(req), String(req.params.id))));
  });

  r.get('/authz/roles/:id/versions/:version', manage, async (req, res) => {
    res.json(versionView(await s.customRoles.version(principalOf(req).tenantId, String(req.params.id), version(req))));
  });

  r.get('/authz/roles/:id/diff', manage, async (req, res) => {
    const p = principalOf(req);
    const role = await s.customRoles.get(p.tenantId, String(req.params.id));
    const q = parseBody(z.object({ from: z.coerce.number().int().min(1).optional(), to: z.coerce.number().int().min(1).optional() }), req.query);
    const to = q.to ?? (await s.customRoles.versions(p.tenantId, role.id))[0]!.version;
    const from = q.from ?? to - 1;
    if (from < 1 || from === to) throw badRequest('Give two different versions to compare (from and to).');
    res.json(await s.customRoles.diff(p.tenantId, role.id, from, to));
  });

  r.post('/authz/roles/:id/versions/:version/approve', manage, async (req, res) => {
    const body = parseBody(note, req.body ?? {});
    res.json(roleView(await s.customRoles.approve(ctx(req), String(req.params.id), version(req), body.note)));
  });

  r.post('/authz/roles/:id/versions/:version/reject', manage, async (req, res) => {
    const body = parseBody(note, req.body ?? {});
    res.json(versionView(await s.customRoles.reject(ctx(req), String(req.params.id), version(req), body.note)));
  });

  // ---------- B-3303: effective access ----------

  const permissionList = z
    .string()
    .max(4000)
    .transform((v) => v.split(',').map((x) => x.trim()).filter(Boolean))
    .refine((list) => list.every(isPermission), 'Unknown permission')
    .transform((list) => list as Permission[]);
  const id26 = z.string().length(26);

  r.get('/authz/access', manage, async (req, res) => {
    const q = parseBody(
      z.object({
        workspaceId: id26.optional(),
        permissions: permissionList.optional(),
        userId: id26.optional(),
        q: z.string().max(100).optional(),
        label: z.enum(LABELS).optional(),
        zone: z.string().max(63).optional(),
        keys: z.enum(['true', 'false']).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        offset: z.coerce.number().int().min(0).default(0)
      }),
      req.query
    );
    res.json(await s.access.matrix(principalOf(req), { ...q, keys: q.keys === 'true' }));
  });

  r.get('/authz/access/explain', manage, async (req, res) => {
    const q = parseBody(z.object({ userId: id26, apiKeyId: id26.optional(), workspaceId: id26, permission, label: z.enum(LABELS).optional(), zone: z.string().max(63).optional() }), req.query);
    res.json(await s.access.explainCell(principalOf(req), q));
  });

  r.get('/authz/who-can', manage, async (req, res) => {
    const q = parseBody(
      z.object({ permission, workspaceId: id26.optional(), label: z.enum(LABELS).optional(), zone: z.string().max(63).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }),
      req.query
    );
    res.json(await s.access.whoCan(principalOf(req), q));
  });

  // ---------- B-3305: access reviews ----------

  r.get('/authz/reviews', async (req, res) => {
    const q = parseBody(z.object({ state: z.enum(['scheduled', 'open', 'closed', 'cancelled']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) }), req.query);
    res.json((await s.accessReviews.list(principalOf(req), q)).map(reviewView));
  });

  r.post('/authz/reviews', manage, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(200),
        kinds: z.array(z.enum(['role', 'workspace'])).min(1).max(2).default(['role', 'workspace']),
        roles: z.array(roleId).max(100).nullable().default(null),
        workspaceId: id26.nullable().default(null),
        reviewerIds: z.array(id26).max(50).default([]),
        opensAt: z.iso.datetime().nullable().default(null),
        dueDays: z.number().int().min(1).max(90).default(14),
        everyDays: z.number().int().min(7).max(366).nullable().default(null)
      }).strict(),
      req.body
    );
    const review = await s.accessReviews.create(p, { ...body, opensAt: body.opensAt ? Date.parse(body.opensAt) : null }, ip(req), req.traceId);
    res.status(201).json(reviewView(review));
  });

  r.get('/authz/reviews/:id', async (req, res) => {
    const q = parseBody(z.object({ decision: z.enum(['pending', 'confirmed', 'revoked', 'expired']).optional(), limit: z.coerce.number().int().min(1).max(1000).default(200), offset: z.coerce.number().int().min(0).default(0) }), req.query);
    const p = principalOf(req);
    const review = await s.accessReviews.visible(p, String(req.params.id));
    // Holders of roles:manage see every item; a reviewer sees the items assigned to them.
    res.json({ ...reviewView(review), items: await s.accessReviews.items(review, { ...q, ...(s.accessReviews.manages(p) ? {} : { forReviewer: p.userId }) }) });
  });

  r.post('/authz/reviews/:id/items/:itemId/decision', async (req, res) => {
    const body = parseBody(z.object({ decision: z.enum(['confirm', 'revoke']), note: z.string().trim().max(500).nullable().default(null) }).strict(), req.body);
    const item = await s.accessReviews.decide(principalOf(req), String(req.params.id), String(req.params.itemId), body.decision, body.note, ip(req), req.traceId);
    res.json({ id: item.id, decision: item.decision, decidedBy: item.decided_by, decidedAt: item.decided_at, note: item.note, removed: item.removed });
  });

  r.post('/authz/reviews/:id/open', manage, async (req, res) => {
    const p = principalOf(req);
    const review = await s.accessReviews.get(p.tenantId, String(req.params.id));
    res.json(reviewView(await s.accessReviews.open(review, actorFrom(p, ip(req)), req.traceId)));
  });

  r.post('/authz/reviews/:id/close', manage, async (req, res) => {
    const p = principalOf(req);
    const review = await s.accessReviews.get(p.tenantId, String(req.params.id));
    res.json(reviewView(await s.accessReviews.close(review, actorFrom(p, ip(req)), req.traceId)));
  });

  return r;
}
