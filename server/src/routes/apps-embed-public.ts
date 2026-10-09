import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { AppEmbeds, type EmbedConfig } from '../apps/embeds.js';
import { ip, noStore, parseBody } from '../http/middleware.js';
import { tooManyRequests } from '../http/problem.js';
import { Limiter } from '../platform/ratelimit.js';
import type { Services } from '../services.js';

const id26 = z.string().length(26);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * 1.6.0, Sprint 39d (B-8701, B-8702): the embed pages and their public endpoints, outside the authenticated API.
 *
 * `GET /embed/:id` serves a public form's embed page and `GET /embed/app/:tenant/:app` the signed-embed page of an
 * app, each with `frame-ancestors` set to the app's allowed host sites (and no `X-Frame-Options`), so a browser frames
 * them there and refuses them elsewhere. The pages are static shells: `/js/embed.js` reads the embed id or the host
 * token (from the fragment, never a query string) and talks to `/api/public/embeds/*` and the entity API.
 */
export function appEmbedPublicRoutes(s: Services): Router {
  const r = Router();
  const json = express.json({ limit: '64kb', strict: true });
  const opens = new Limiter(s.counters, 'embed-open', s.cfg.APPS_PUBLIC_FORM_PER_MINUTE * 10, 60_000);
  const submits = new Limiter(s.counters, 'app-form-anon', s.cfg.APPS_PUBLIC_FORM_PER_MINUTE, 60_000);
  const exchanges = new Limiter(s.counters, 'embed-session', s.cfg.APP_EMBED_SESSION_PER_MINUTE, 60_000);

  const framed = (res: Response, config: EmbedConfig) => {
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors ${s.apps.embeds.frameAncestors(config).join(' ')}`);
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
  };

  const page = (title: string, attrs: Record<string, string>) =>
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/css/app.css">
<style>body.embed{overflow:auto;background:var(--bg)}.embed-main{max-width:760px;margin:0 auto;padding:16px;display:flex;flex-direction:column;gap:12px}.embed-title{font-size:18px;margin:0}.embed-sub{font-size:14px;margin:8px 0 0}.embed-form{display:flex;flex-direction:column;gap:10px}.embed-head{align-items:baseline}</style>
</head>
<body class="embed">
<main class="embed-main" id="embed" ${Object.entries(attrs)
      .map(([k, v]) => `data-${k}="${esc(v)}"`)
      .join(' ')} aria-live="polite"><noscript>This page needs JavaScript.</noscript></main>
<script src="/js/embed.js"></script>
</body>
</html>
`;

  const limited = async (req: Request, l: Limiter, what: string) => {
    const x = await l.consume(ip(req) ?? 'unknown');
    if (!x.allowed) throw tooManyRequests(`Too many ${what} from this address; try again in a minute.`, x.resetMs / 1000);
  };

  // ---------- public form pages (B-8701) ----------

  r.get('/embed/:id', noStore, async (req, res) => {
    const id = parseBody(id26, req.params.id);
    const { app, form, config } = await s.apps.embeds.pageById(id);
    framed(res, config);
    res.type('html').send(page(form.title, { kind: 'form', embed: id, app: app.name, title: form.title }));
  });

  r.post('/api/public/embeds/open', noStore, json, async (req, res) => {
    await limited(req, opens, 'forms opened');
    const { embed } = parseBody(z.object({ embed: id26 }).strict(), req.body);
    const { entity, form } = await s.apps.embeds.pageById(embed);
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.json({ ...s.apps.forms.describe(entity, form), form: form.name });
  });

  r.post('/api/public/embeds/submit', noStore, json, async (req, res) => {
    const { embed, values } = parseBody(z.object({ embed: id26, values: z.record(z.string().max(100), z.unknown()).refine((v) => Object.keys(v).length <= 200, 'at most 200 fields') }).strict(), req.body);
    const { form } = await s.apps.embeds.pageById(embed);
    // The same path as a public link submission: per-address and per-form limits, the user-input guardrail, a held
    // submission answers 202. The form's own token never reaches the page: the embed id stands for it.
    const out = await s.apps.forms.submitPublicForm(form, values, ip(req), req.traceId, submits);
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.status(out.held ? 202 : 201).json(out);
  });

  // ---------- signed embeds (B-8702) ----------

  r.get('/embed/app/:tenant/:app', noStore, async (req, res) => {
    const tenant = parseBody(id26, req.params.tenant);
    const { app, config } = await s.apps.embeds.signedApp(tenant, parseBody(z.string().min(1).max(63), req.params.app));
    framed(res, config);
    res.type('html').send(page(app.title, { kind: 'app', tenant, app: app.name, title: app.title, audience: AppEmbeds.audience(app) }));
  });

  r.post('/api/public/embeds/session', noStore, json, async (req, res) => {
    await limited(req, exchanges, 'embed tokens');
    const body = parseBody(z.object({ tenant: id26, app: z.string().min(1).max(63), token: z.string().min(20).max(16_000) }).strict(), req.body);
    const out = await s.apps.embeds.exchange(body.tenant, body.app, body.token, { ip: ip(req), traceId: req.traceId });
    const entities = (await s.apps.entities(out.app)).filter((e) => !out.config.entities || out.config.entities.includes(e.name));
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.json({ token: out.token, expiresAt: out.expiresAt, app: { name: out.app.name, title: out.app.title }, user: out.user, write: out.config.write, entities: entities.map((e) => ({ name: e.name, title: e.title, fields: e.definition.fields.map((f) => ({ name: f.name, title: f.title ?? f.name, type: f.type, required: f.required, computed: f.type === 'formula' || f.type === 'ai', ...(f.type === 'enum' ? { options: f.options.map((o) => o.value) } : {}) })), states: e.definition.states?.states.map((x) => x.name) ?? null })) });
  });

  return r;
}
