import { Router, type Request } from 'express';
import { z } from 'zod';
import { planInputSchema } from '../apps/platform-import.js';
import type { Actor } from '../apps/service.js';
import type { Principal } from '../authz/policy.js';
import { ip, parseBody, principalOf, requirePermission } from '../http/middleware.js';
import type { Services } from '../services.js';

/**
 * Importing the exprsn-platform's low-code apps into Apps (`apps/platform-import.ts`, docs/decisions/lowcode-port.md
 * "Importing platform apps"). Mounted inside `routes/apps.ts`, before `/apps/:app`, behind its `/apps` guards.
 *
 * Every route needs `apps:design` (an import creates and changes apps, entities, forms and flows) and
 * `platform:manage`: the platform connection (PLATFORM_LOWCODE_URL and its token) is an operator setting shared by
 * every tenant of this server, so only the operator may use it; a tenant admin with `apps:design` alone could
 * otherwise read the platform account's apps and records into their own tenant. Starting an import is audited
 * (`app.platform-import.started`), as are dry runs, the end of each import and every write to the platform.
 */
export function appPlatformImportRoutes(s: Services): Router {
  const r = Router();
  const design = requirePermission(s, 'apps:design');
  const connect = requirePermission(s, 'platform:manage');
  const pi = s.apps.platformImport;
  const actor = (req: Request): Actor & { principal: Principal } => ({ principal: principalOf(req), source: 'import', ip: ip(req), traceId: req.traceId });

  /** The platform apps the configured account can import, with where each went before. */
  r.get('/apps/platform-import/apps', design, connect, async (req, res) => {
    res.json(await pi.list(principalOf(req)));
  });

  /** The dry run: the full mapping report, kept for an hour for `runs`. Nothing is written. */
  r.post('/apps/platform-import/plan', design, connect, async (req, res) => {
    res.json(await pi.plan(actor(req), parseBody(planInputSchema, req.body)));
  });

  /** Starts the import of a dry run as the job `apps.platform-import`. */
  r.post('/apps/platform-import/runs', design, connect, async (req, res) => {
    const body = parseBody(z.object({ planId: z.string().length(26) }).strict(), req.body);
    res.status(202).json(await pi.start(actor(req), body.planId));
  });

  r.get('/apps/platform-import/runs', design, connect, async (req, res) => {
    res.json({ runs: await pi.recent(principalOf(req)) });
  });

  /** A dry run or an import: state, the job's progress, the summary, the plan and the per-record results. */
  r.get('/apps/platform-import/runs/:id', design, connect, async (req, res) => {
    res.json(await pi.status(principalOf(req), parseBody(z.string().length(26), req.params.id)));
  });

  return r;
}
