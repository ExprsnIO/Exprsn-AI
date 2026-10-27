import { Router } from 'express';
import { z } from 'zod';
import { LABELS } from '../../authz/labels.js';
import { entryView } from '../../cloud/model-import.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import type { Services } from '../../services.js';

/*
 * 1.9.99-final, Sprint 60 (B-10504): the cloud catalogue import (`cloud/model-import.ts`). Every route needs
 * `cloud:read` (the account, one the caller may see: `s.cloud.accounts.getFor`) and `models:manage` (it lists from,
 * and registers drafts for, the model catalogue). Without migration 159 the import answers 503 `migration_pending`.
 * Nothing here approves or publishes a model: drafts go through evaluation and dual-control approval in Models, which
 * refuse a label above the entry's ceiling.
 *
 *   GET  /admin/cloud/accounts/:id/model-import?region   what the account offers: access state, routing regions, the ceiling, whether catalogued
 *   POST /admin/cloud/accounts/:id/model-import          { region?, ids?, instanceId?, label? } → drafts; one result per listing (registered, updated, unchanged, skipped and why)
 *   GET  /admin/cloud/model-entries?account              the cloud entries of catalogue models
 */

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
const region = z.string().trim().regex(/^[a-z0-9-]{2,40}$/, 'a region');

export function cloudModelImportRoutes(s: Services): Router {
  const r = Router();
  const manage = [noStore, requireAuth(), requirePermission(s, 'cloud:read'), requirePermission(s, 'models:manage')];
  const m = () => s.cloud.modelImport;

  r.get('/cloud/accounts/:id/model-import', ...manage, async (req, res) => {
    const q = parseBody(z.object({ region: region.optional() }).strict(), req.query);
    res.json(await m().preview(principalOf(req), parseBody(id26, req.params.id), q.region ? { region: q.region } : {}));
  });

  r.post('/cloud/accounts/:id/model-import', ...manage, async (req, res) => {
    const body = parseBody(z.object({ region: region.optional(), ids: z.array(z.string().trim().min(1).max(200)).min(1).max(200).optional(), instanceId: id26.optional(), label: z.enum(LABELS).optional() }).strict(), req.body ?? {});
    const out = await m().import(principalOf(req), parseBody(id26, req.params.id), { ...body, ip: ip(req), traceId: req.traceId });
    res.status(out.results.some((x) => x.outcome === 'registered') ? 201 : 200).json(out);
  });

  r.get('/cloud/model-entries', ...manage, async (req, res) => {
    const q = parseBody(z.object({ account: id26.optional() }).strict(), req.query);
    if (!(await m().installed())) return void res.json({ installed: false, entries: [] });
    if (q.account) await s.cloud.accounts.getFor(principalOf(req), q.account);
    const visible = new Set((await s.cloud.accounts.list(principalOf(req))).map((a) => a.id));
    res.json({ installed: true, entries: (await m().entries(q.account)).filter((e) => visible.has(e.accountId)).map(entryView) });
  });

  return r;
}
