import { createHmac } from 'node:crypto';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { safeEqual } from '../crypto/index.js';
import { loadPrincipal } from '../http/middleware.js';
import type { Services } from '../services.js';

/**
 * Sandboxed media (B-413). Every preview, media file and image is served with `Content-Security-Policy: sandbox`
 * and `nosniff`, so a file that is really HTML or SVG with script runs in an opaque origin with no access to the
 * console. With MEDIA_ORIGIN set, the API answers those reads with a redirect to a signed, short-lived URL on that
 * separate origin, which serves nothing else; the console's cookies never reach it.
 */
export const SANDBOX_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";

export function sandboxHeaders(res: Response): void {
  res.setHeader('Content-Security-Policy', SANDBOX_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('X-Frame-Options', 'DENY');
}

export type MediaRef =
  | { kind: 'asset'; id: string }
  | { kind: 'preview'; id: string; i: number }
  | { kind: 'output'; id: string; i: number; download: boolean }
  | { kind: 'image'; id: string; download: boolean };

interface TokenBody {
  r: MediaRef;
  t: string;
  u: string;
  w: string | null;
  exp: number;
}

const keyOf = (secret: string) => createHmac('sha256', secret).update('exprsn-media-url/1').digest();

export function signMediaToken(secret: string, body: TokenBody): string {
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `${payload}.${createHmac('sha256', keyOf(secret)).update(payload).digest('base64url')}`;
}

export function verifyMediaToken(secret: string, token: string, now = Date.now()): TokenBody | null {
  const [payload, mac] = token.split('.');
  if (!payload || !mac) return null;
  if (!safeEqual(mac, createHmac('sha256', keyOf(secret)).update(payload).digest('base64url'))) return null;
  try {
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TokenBody;
    return typeof body.exp === 'number' && body.exp > now ? body : null;
  } catch {
    return null;
  }
}

/** The signed URL on MEDIA_ORIGIN for a read the API has already authorised, or null without a media origin. */
export function mediaUrl(s: Services, req: Request, ref: MediaRef): string | null {
  const origin = s.cfg.MEDIA_ORIGIN;
  const p = req.principal;
  if (!origin || !p) return null;
  const token = signMediaToken(s.cfg.SESSION_SECRET, { r: ref, t: p.tenantId, u: p.userId, w: p.workspaceId ?? null, exp: Date.now() + s.cfg.MEDIA_URL_TTL_SECONDS * 1000 });
  return `${origin.replace(/\/$/, '')}/media-content/${token}`;
}

/** Redirects to the media origin when one is configured; returns whether it did. */
export function redirectToMedia(s: Services, req: Request, res: Response, ref: MediaRef): boolean {
  const url = mediaUrl(s, req, ref);
  if (!url) return false;
  res.setHeader('Cache-Control', 'no-store');
  res.redirect(302, url);
  return true;
}

const hostOf = (url: string) => new URL(url).host.toLowerCase();

/**
 * On the media origin's host only /media-content and the health checks answer: no API, no console, no cookies
 * that matter. Other hosts are untouched.
 */
export function mediaHostGuard(s: Services): RequestHandler {
  const media = s.cfg.MEDIA_ORIGIN ? hostOf(s.cfg.MEDIA_ORIGIN) : null;
  const app = hostOf(s.cfg.PUBLIC_URL);
  return (req, res, next) => {
    if (!media || media === app || (req.headers.host ?? '').toLowerCase() !== media) return next();
    if (req.path.startsWith('/media-content/') || req.path === '/healthz' || req.path === '/readyz') return next();
    res.status(404).type('text/plain').send('Not found');
  };
}

/**
 * GET /media-content/<token>: the signed read. The principal is rebuilt from the token (so a disabled user or a
 * tenant that was suspended in the meantime is refused) and the same service checks run again.
 */
export function mediaOriginRoutes(s: Services, send: (req: Request, res: Response, data: Buffer, type: string, disposition: string) => void): Router {
  const r = Router();
  r.get('/media-content/:token', async (req, res) => {
    const body = s.cfg.MEDIA_ORIGIN ? verifyMediaToken(s.cfg.SESSION_SECRET, String(req.params.token)) : null;
    const p = body ? await loadPrincipal(s, body.t, body.u, {}) : null;
    if (!body || !p) {
      res.status(404).type('text/plain').send('Not found or expired');
      return;
    }
    p.workspaceId = body.w;
    res.setHeader('Cache-Control', 'private, no-store');
    const ref = body.r;
    try {
      if (ref.kind === 'asset') {
        const a = await s.media.asset(p, ref.id);
        return send(req, res, await s.media.content(a), s.media.typeOf(a), 'inline');
      }
      if (ref.kind === 'preview') {
        const a = await s.media.asset(p, ref.id);
        const pv = await s.media.preview(a, ref.i);
        return send(req, res, pv.data, pv.type, 'inline');
      }
      if (ref.kind === 'output') {
        const out = await s.media.output(p, ref.id, ref.i);
        return send(req, res, out.data, out.type, `${ref.download ? 'attachment' : 'inline'}; filename="${out.name.replace(/[^\w.() -]+/g, '_').slice(0, 120) || 'media'}"`);
      }
      const out = await s.images.image(p, ref.id);
      return send(req, res, out.data, out.type, ref.download ? `attachment; filename="image-${out.row.id.toLowerCase()}.${out.type === 'image/png' ? 'png' : 'jpg'}"` : 'inline');
    } catch {
      res.status(404).type('text/plain').send('Not found');
    }
  });
  return r;
}
