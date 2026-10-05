import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { ip, noStore, parseBody } from '../http/middleware.js';
import type { Services } from '../services.js';

const KEY = z.string().regex(/^chn_[A-Za-z0-9_-]{20,40}$/);

/** The customer's session token: `Authorization: Bearer cst_…` (never in a URL). */
const tokenOf = (req: Request): string | undefined => {
  const h = req.header('authorization');
  const m = h ? /^Bearer\s+(cst_[A-Za-z0-9._-]{20,600})$/.exec(h.trim()) : null;
  return m?.[1];
};

/**
 * Customer-service channels, public side (Sprint 28a, B-2301 to B-2303), at `/api/public/channels`, before the
 * authenticated API: no session cookie is read or set. A chat customer starts a session with the channel's public key
 * (anonymously, or with an identity assertion signed by the channel's site) and gets a session token scoped to that
 * session; every other call carries it as a bearer token. Email providers post to the channel's webhook URLs, which
 * check their signature over the raw body before anything is parsed. Rate limits: new sessions per address
 * (CHANNELS_SESSIONS_PER_HOUR and the channel's own), messages per session (the channel's), webhook calls per channel.
 */
export function publicChannelRoutes(s: Services): Router {
  const r = Router();
  const ch = s.channels;
  const json = express.json({ limit: '32kb', strict: true });
  const robots: express.RequestHandler = (_req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  };
  r.use('/channels', noStore, robots);

  r.post('/channels/sessions', json, async (req, res) => {
    const body = parseBody(z.object({ channel: KEY, identity: z.string().max(4000).optional(), name: z.string().trim().max(200).optional() }).strict(), req.body);
    res.status(201).json(await ch.startCustomer(body.channel, body, ip(req), req.traceId));
  });

  r.get('/channels/session', async (req, res) => {
    const q = parseBody(z.object({ after: z.coerce.number().int().min(0).optional() }), req.query);
    const { c, sess } = await ch.customerAuth(tokenOf(req));
    res.json(await ch.customerView(c, sess, q.after ?? 0));
  });

  r.post('/channels/session/messages', json, async (req, res) => {
    const body = parseBody(z.object({ text: z.string().trim().min(1).max(8000) }).strict(), req.body);
    res.status(201).json(await ch.customerSend(tokenOf(req), body.text, ip(req), req.traceId));
  });

  r.post('/channels/session/escalate', json, async (req, res) => {
    const body = parseBody(z.object({ reason: z.string().trim().max(500).optional() }).strict(), req.body ?? {});
    res.json(await ch.customerEscalate(tokenOf(req), body.reason ?? null, ip(req), req.traceId));
  });

  r.post('/channels/session/close', json, async (req, res) => {
    res.json(await ch.customerClose(tokenOf(req), ip(req), req.traceId));
  });

  // Provider webhooks: the raw body is what was signed, so it is read as bytes here, never through a JSON parser.
  r.post('/channels/:key/email/:provider', express.raw({ type: () => true, limit: '2mb' }), async (req, res) => {
    const key = parseBody(KEY, req.params.key);
    const provider = parseBody(z.enum(['generic', 'mailgun']), req.params.provider);
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const out = await ch.mail.webhook(key, provider, raw, req.header('content-type') ?? '', { timestamp: req.header('x-exprsn-timestamp'), signature: req.header('x-exprsn-signature') }, ip(req));
    res.json(out);
  });

  return r;
}
