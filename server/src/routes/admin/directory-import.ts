import { Router } from 'express';
import { z } from 'zod';
import { directoryImportsFor } from '../../identity/directory-import.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import { notFound } from '../../http/problem.js';
import type { Services } from '../../services.js';

/*
 * 1.9.9-qa (QA-1): the full import of a cloud directory's users before their first sign-in
 * (`identity/directory-import.ts`). Mounted from `identityAdminRoutes`; every route needs `identity:manage` and
 * `users:manage` (it makes accounts). A dry run first; the run names it.
 */

const submitSchema = z.object({ dryRun: z.boolean().default(true), fromDryRun: z.string().length(26).optional() }).strict();
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function directoryImportRoutes(s: Services): Router {
  const r = Router();
  const imports = directoryImportsFor(s);
  const guard = [noStore, requireAuth(), requirePermission(s, 'identity:manage'), requirePermission(s, 'users:manage')];

  const store = async (tenantId: string, id: string) => {
    const row = ULID.test(id) ? await s.providers.get(tenantId, id) : undefined;
    if (!row) throw notFound('User store');
    return row;
  };

  /** The store's imports, newest first (`available: false` until migration 143 is applied). */
  r.get('/identity-providers/:id/directory-imports', ...guard, async (req, res) => {
    const p = principalOf(req);
    const row = await store(p.tenantId, String(req.params.id));
    res.json(await imports.list(p.tenantId, row.id));
  });

  /** Queues a dry run (the default), or a run that names a dry run of this store from the last day. */
  r.post('/identity-providers/:id/directory-imports', ...guard, async (req, res) => {
    const p = principalOf(req);
    const row = await store(p.tenantId, String(req.params.id));
    const body = parseBody(submitSchema, req.body ?? {});
    const out = await imports.submit(p, row, { dryRun: body.dryRun, ...(body.fromDryRun ? { fromDryRun: body.fromDryRun } : {}) }, { ip: ip(req), traceId: req.traceId });
    res.status(202).json(out);
  });

  /** One import: state, progress while it runs, the counts and the per-user report. */
  r.get('/identity-providers/:id/directory-imports/:importId', ...guard, async (req, res) => {
    const p = principalOf(req);
    const row = await store(p.tenantId, String(req.params.id));
    res.json(await imports.get(p.tenantId, row.id, String(req.params.importId)));
  });

  return r;
}
