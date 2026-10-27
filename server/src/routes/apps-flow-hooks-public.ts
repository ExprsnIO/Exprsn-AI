import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { HOOK_MAX_BYTES, SIGNATURE_HEADER, TIMESTAMP_HEADER } from '../apps/flow-hooks.js';
import { HttpProblem } from '../http/problem.js';
import type { Services } from '../services.js';

/*
 * The incoming webhooks of app flows, mounted at the root outside /api (no session, no CSRF; the HMAC signature over
 * the timestamp and the body is the authentication, `apps/flow-hooks.ts`):
 *
 *   POST /hooks/apps/:tenant/:flow   a signed JSON body starts the flow's workflow; 202 {run}
 *
 * The body is read as bytes (what was signed), never through the JSON parser, and capped at HOOK_MAX_BYTES.
 */
export function appFlowHookPublicRoutes(s: Services): Router {
  const r = Router();
  const raw = express.raw({ type: () => true, limit: HOOK_MAX_BYTES });
  const params = (req: Request) => ({ tenant: String(req.params.tenant), flowId: String(req.params.flow), signature: req.get(SIGNATURE_HEADER), timestamp: req.get(TIMESTAMP_HEADER), ip: req.ip ?? null, ...(req.traceId ? { traceId: req.traceId } : {}) });

  // A body over the cap is refused (and audited for a known flow) before the handler.
  const body = (req: Request, res: Response, next: NextFunction) => {
    raw(req, res, (err?: unknown) => {
      if (!err) return next();
      if ((err as { type?: string }).type === 'entity.too.large') {
        s.apps.flows.hooks.oversize(params(req)).catch((e: unknown) => next(e));
        return;
      }
      next(err);
    });
  };

  r.post('/hooks/apps/:tenant/:flow', body, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!/^application\/json\b/i.test(req.get('content-type') ?? '')) throw new HttpProblem(415, 'Unsupported media type', 'A webhook body is JSON (Content-Type: application/json).');
    const out = await s.apps.flows.hooks.receive({ ...params(req), raw: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0) });
    res.status(202).json(out);
  });

  return r;
}
