import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { HttpProblem } from '../http/problem.js';
import type { Services } from '../services.js';
import { HOOK_MAX_BYTES, SIGNATURE_HEADER, TIMESTAMP_HEADER } from '../workflows/signed-hooks.js';

/*
 * 1.8.0, Sprint 46 (B-130): the webhook trigger of every workflow, mounted at the root outside /api like the app
 * flows' (no session, no CSRF; the HMAC signature over the timestamp and the body is the authentication,
 * `workflows/hooks.ts` on `workflows/signed-hooks.ts`):
 *
 *   POST /hooks/workflows/:tenant/:workflow   a signed JSON object starts the published version; 202 {run}
 *
 * The body is read as bytes (what was signed), never through the JSON parser, and capped at HOOK_MAX_BYTES.
 */
export function workflowHookPublicRoutes(s: Services): Router {
  const r = Router();
  const raw = express.raw({ type: () => true, limit: HOOK_MAX_BYTES });
  const params = (req: Request) => ({ tenant: String(req.params.tenant), workflowId: String(req.params.workflow), signature: req.get(SIGNATURE_HEADER), timestamp: req.get(TIMESTAMP_HEADER), ip: req.ip ?? null, ...(req.traceId ? { traceId: req.traceId } : {}) });

  // A body over the cap is refused (and audited for a known workflow) before the handler.
  const body = (req: Request, res: Response, next: NextFunction) => {
    raw(req, res, (err?: unknown) => {
      if (!err) return next();
      if ((err as { type?: string }).type === 'entity.too.large') {
        s.workflowHooks.oversize(params(req)).catch((e: unknown) => next(e));
        return;
      }
      next(err);
    });
  };

  r.post('/hooks/workflows/:tenant/:workflow', body, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!/^application\/json\b/i.test(req.get('content-type') ?? '')) throw new HttpProblem(415, 'Unsupported media type', 'A webhook body is JSON (Content-Type: application/json).');
    const out = await s.workflowHooks.receive({ ...params(req), raw: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0) });
    res.status(202).json(out);
  });

  return r;
}
