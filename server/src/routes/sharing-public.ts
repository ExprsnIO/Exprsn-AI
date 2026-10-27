import express, { Router } from 'express';
import { z } from 'zod';
import { ip, noStore, parseBody } from '../http/middleware.js';
import { notFound, tooManyRequests } from '../http/problem.js';
import { Limiter } from '../platform/ratelimit.js';
import type { Services } from '../services.js';

/**
 * Anonymous share links (Sprint 16, B-706), at `/api/public`, before the authenticated API: no session is read or
 * created and no cookie is set. A link opens only while the tenant allows anonymous links and the conversation is
 * `public`; every open is audited with the address, and opens are rate-limited per address in the shared counters.
 * The token travels in the body (the console keeps it in the URL fragment), never in a URL a proxy could log.
 */
export function publicSharingRoutes(s: Services): Router {
  const r = Router();
  const limiter = new Limiter(s.counters, 'share-anon', s.cfg.SHARE_ANONYMOUS_PER_MINUTE, 60_000);
  r.use(noStore);
  r.use((_req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  });
  r.use(express.json({ limit: '4kb', strict: true }));

  r.post('/shared-links/open', async (req, res) => {
    const l = await limiter.consume(ip(req) ?? 'unknown');
    if (!l.allowed) throw tooManyRequests('Too many shared links opened from this address; try again in a minute.', l.resetMs / 1000);
    const { token } = parseBody(z.object({ token: z.string().regex(/^exs_[A-Za-z0-9_-]{20,100}$/) }).strict(), req.body);
    res.json({ ...(await s.sharing.openAnonymous(token, ip(req), req.traceId)), readOnly: true });
  });

  /**
   * 1.6.0 (B-8001): one artifact version rendered for a sandboxed iframe. The URL is a short-lived capability minted
   * with the artifact list; no session is read. The response's own CSP sandboxes the document: it may run its scripts
   * and styles, but cannot reach the console's origin, cookies, API or storage, nor navigate the page that frames it.
   */
  r.get('/artifacts/:vid/raw', async (req, res) => {
    const token = String(req.query.t ?? '');
    const got = token.length <= 200 ? await s.chatArtifacts.raw(token) : null;
    if (!got) throw notFound('Artifact');
    const html = got.artifact.kind === 'html';
    res.setHeader('Content-Security-Policy', "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'");
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Type', html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="${got.artifact.key.replace(/[^\w.-]/g, '_')}"`);
    res.send(got.content);
  });

  r.use(() => {
    throw notFound('API route');
  });
  return r;
}
