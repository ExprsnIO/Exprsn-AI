import express, { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { noStore, parseBody } from '../http/middleware.js';
import { forbidden, tooManyRequests } from '../http/problem.js';
import { Limiter } from '../platform/ratelimit.js';
import type { Services } from '../services.js';
import { sealedProblem } from '../vault/seal.js';

/*
 * 1.8.0, Sprint 48 (B-145): the unseal API (public: the escrow shares are the credential) and the gate that holds
 * every other route while the vault is sealed.
 *
 *   GET  /api/public/vault/seal          sealed or not; while sealed, the escrow's k and n and this instance's progress
 *   POST /api/public/vault/unseal        one share holder's share; at k shares the vault is unsealed
 *   POST /api/public/vault/unseal/reset  forget the shares given so far on this instance
 *   POST /api/public/vault/break-glass   k shares together seal the vault at once, with a reason (no session needed)
 *
 * The POSTs allow 10 attempts a minute per address (the shares are 32-byte secrets with per-share check values, so
 * guessing is not the risk; flooding the audit chain is). Same-origin only when the browser says where it came from.
 *
 * What still answers while sealed (`sealedGate`), because none of it needs a key:
 *   - /healthz, /readyz and /metrics (mounted before the gate; readiness stays ready with `vault: sealed`, so a load
 *     balancer keeps sending the unseal page here);
 *   - the console's static files (GET and HEAD of `/`, `/index.html`, `/unseal.html`, `/css/…`, `/js/…`, `/img/…`,
 *     `/fonts/…`, `/favicon.ico`): the sign-in page renders, and says the vault is sealed;
 *   - GET /api/auth/session, answered here as "not signed in" with `sealed: true` (looking a session up needs the
 *     session key);
 *   - the unseal API above.
 * Everything else, including sign-in itself (a session needs the session key), every /api route, /v1, DAV, SCIM,
 * the protocol endpoints and the public links, answers 503 "Vault sealed" as problem+json with Retry-After.
 */

const STATIC_PREFIXES = ['/css/', '/js/', '/img/', '/fonts/'];
const STATIC_PAGES = new Set(['/', '/index.html', '/unseal.html', '/favicon.ico']);

export function sealedGate(s: Services): RequestHandler {
  return (req, res, next) => {
    if (!s.vaultSeal.sealed) return next();
    const get = req.method === 'GET' || req.method === 'HEAD';
    if (get && (STATIC_PAGES.has(req.path) || STATIC_PREFIXES.some((p) => req.path.startsWith(p)))) return next();
    if (get && req.path === '/api/auth/session') {
      res.setHeader('Cache-Control', 'no-store');
      return void res.json({ authenticated: false, stage: null, sealed: true });
    }
    next(sealedProblem());
  };
}

const share = z.string().trim().min(20).max(2000);

export function vaultSealPublicRoutes(s: Services): Router {
  const r = Router();
  const limiter = new Limiter(s.counters, 'vault-unseal', 10, 60_000);
  const json = express.json({ limit: '32kb', strict: true });
  const guard: RequestHandler = async (req, _res, next) => {
    const origin = req.headers.origin;
    if (origin && !s.cfg.ORIGINS.includes(origin)) throw forbidden('Cross-origin request refused.', { step: 'csrf' });
    const l = await limiter.consume(req.ip ?? 'unknown');
    if (!l.allowed) throw tooManyRequests('Too many attempts from this address: wait a minute.', l.resetMs / 1000);
    next();
  };
  const actor = (req: Request) => ({ ip: req.ip ?? null, service: 'vault-unseal' });

  r.get('/api/public/vault/seal', noStore, async (_req, res) => {
    res.json(await s.vaultSeal.publicStatus());
  });

  r.post('/api/public/vault/unseal', noStore, guard, json, async (req, res) => {
    const b = parseBody(z.object({ share }).strict(), req.body);
    res.json(await s.vaultSeal.submitShare(b.share, actor(req), req.traceId ?? null));
  });

  r.post('/api/public/vault/unseal/reset', noStore, guard, json, async (req, res) => {
    parseBody(z.object({}).strict(), req.body ?? {});
    res.json(await s.vaultSeal.resetProgress(actor(req), req.traceId ?? null));
  });

  r.post('/api/public/vault/break-glass', noStore, guard, json, async (req, res) => {
    const b = parseBody(z.object({ shares: z.array(share).min(2).max(255), reason: z.string().trim().min(10).max(1000) }).strict(), req.body);
    res.json(await s.vaultSeal.breakGlass(b.shares, b.reason, { ...actor(req), service: 'vault-break-glass' }, req.traceId ?? null));
  });

  return r;
}
