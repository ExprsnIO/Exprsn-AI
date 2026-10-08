import express, { Router } from 'express';
import { z } from 'zod';
import { ip, noStore, parseBody } from '../http/middleware.js';
import { tooManyRequests } from '../http/problem.js';
import { Limiter } from '../platform/ratelimit.js';
import type { Services } from '../services.js';

const TOKEN = z.string().regex(/^exa_[A-Za-z0-9_-]{20,100}$/);

/**
 * Public app forms (Sprint 27, B-2205), at `/api/public/forms`, before the authenticated API: no session is read or
 * created. The link token travels in the body, never in a URL. Opening shows only the form's fields; a submission is
 * rate-limited per address (APPS_PUBLIC_FORM_PER_MINUTE) and per form, keeps only the fields the form lists and shows,
 * and passes the `user-input` guardrail checkpoint before a record is written.
 */
export function publicAppRoutes(s: Services): Router {
  const r = Router();
  const perAddress = new Limiter(s.counters, 'app-form-anon', s.cfg.APPS_PUBLIC_FORM_PER_MINUTE, 60_000);
  const opens = new Limiter(s.counters, 'app-form-open', s.cfg.APPS_PUBLIC_FORM_PER_MINUTE * 10, 60_000);
  const json = express.json({ limit: '64kb', strict: true });
  const robots: express.RequestHandler = (_req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  };

  r.post('/forms/open', noStore, robots, json, async (req, res) => {
    const l = await opens.consume(ip(req) ?? 'unknown');
    if (!l.allowed) throw tooManyRequests('Too many forms opened from this address; try again in a minute.', l.resetMs / 1000);
    const { token } = parseBody(z.object({ token: TOKEN }).strict(), req.body);
    res.json(await s.apps.forms.openPublic(token));
  });

  r.post('/forms/submit', noStore, robots, json, async (req, res) => {
    // Values are checked against the form afterwards; anything the form does not list is dropped there.
    const { token, values } = parseBody(z.object({ token: TOKEN, values: z.record(z.string().max(100), z.unknown()).refine((v) => Object.keys(v).length <= 200, 'at most 200 fields') }).strict(), req.body);
    // 1.6.0 (B-4701): 202 when a held value makes the submission wait for review.
    const out = await s.apps.forms.submitPublic(token, values, ip(req), req.traceId, perAddress);
    res.status(out.held ? 202 : 201).json(out);
  });

  return r;
}
