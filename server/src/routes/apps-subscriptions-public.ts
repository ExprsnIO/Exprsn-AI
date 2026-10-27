import express, { Router, type Response } from 'express';
import { z } from 'zod';
import { ip, noStore } from '../http/middleware.js';
import { tooManyRequests } from '../http/problem.js';
import { escapeHtml } from '../platform/email-templates.js';
import { Limiter } from '../platform/ratelimit.js';
import type { Services } from '../services.js';

const TOKEN = z.string().min(10).max(200);

/**
 * 1.8.0, Sprint 44 (B-124): the unsubscribe link of a delivery email, at `/api/public/app-subscriptions/unsubscribe`,
 * before the authenticated API: no session is read or created, the link's HMAC signature (the platform key `link`)
 * over the subscription and the recipient is the credential, and it stops only that recipient's email copies.
 *
 * `GET ?t=` shows what the link stops and a button; it changes nothing, so a mail scanner that fetches links does not
 * unsubscribe anyone. `POST` (the button, or a mail client's RFC 8058 one-click `List-Unsubscribe-Post`) does it.
 * Rate-limited per address; an invalid or altered link says so and changes nothing.
 */
export function appSubscriptionPublicRoutes(s: Services): Router {
  const r = Router();
  const limiter = new Limiter(s.counters, 'app-unsubscribe', 30, 60_000);
  const form = express.urlencoded({ extended: false, limit: '4kb' });
  const page = (res: Response, status: number, title: string, body: string) => {
    res.status(status).setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`);
  };
  const limited = async (req: express.Request) => {
    const l = await limiter.consume(ip(req) ?? 'unknown');
    if (!l.allowed) throw tooManyRequests('Too many unsubscribe requests from this address; try again in a minute.', l.resetMs / 1000);
  };
  const tokenOf = (v: unknown): string | null => {
    const p = TOKEN.safeParse(v);
    return p.success ? p.data : null;
  };

  r.get('/app-subscriptions/unsubscribe', noStore, async (req, res) => {
    await limited(req);
    const t = tokenOf(req.query.t);
    const d = t ? await s.apps.subscriptions.describeToken(t) : null;
    if (!t || !d) return page(res, 404, 'Link not valid', '<p>This unsubscribe link is not valid, or the subscription no longer exists. Nothing was changed.</p>');
    if (d.already) return page(res, 200, 'Already unsubscribed', `<p>You no longer receive ${escapeHtml(d.name)} by email.</p>`);
    page(res, 200, 'Stop these emails', `<p>Stop your email copies of ${escapeHtml(d.name)}? Other people's copies, and the owner's other destinations, are not affected.</p><form method="post" action="unsubscribe"><input type="hidden" name="t" value="${escapeHtml(t)}"><button type="submit">Unsubscribe</button></form>`);
  });

  r.post('/app-subscriptions/unsubscribe', noStore, form, async (req, res) => {
    await limited(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const t = tokenOf(body.t) ?? tokenOf(req.query.t);
    const out = t ? await s.apps.subscriptions.unsubscribeByToken(t) : 'invalid';
    if (out === 'invalid') return page(res, 404, 'Link not valid', '<p>This unsubscribe link is not valid, or the subscription no longer exists. Nothing was changed.</p>');
    page(res, 200, 'Unsubscribed', '<p>You will not receive further email copies of this subscription. You can close this page.</p>');
  });

  return r;
}
