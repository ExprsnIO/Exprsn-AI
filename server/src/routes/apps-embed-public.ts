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
 * `GET /form` (follow-up 2 of docs/decisions/lowcode-port.md) is the same shell for a form's public link, not framed.
 * Every page loads `/js/form-layout.js`, which lays out sections and wizard steps and mirrors the server's conditions.
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
<style>body.embed{overflow:auto;background:var(--bg)}.embed-main{max-width:760px;margin:0 auto;padding:16px;display:flex;flex-direction:column;gap:12px}.embed-title{font-size:18px;margin:0}.embed-sub{font-size:14px;margin:8px 0 0}.embed-form{display:flex;flex-direction:column;gap:10px}.embed-head{align-items:baseline}.ef-steps{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px}.ef-step{display:inline-block;font:inherit;font-size:13px;padding:4px 10px;border-radius:999px;border:1px solid var(--line2);background:var(--panel);color:var(--fg2);overflow-wrap:anywhere;max-width:100%}.ef-step.cur{border-color:var(--accent);color:var(--fg);font-weight:600;box-shadow:0 0 0 1px var(--accent)}button.ef-step{cursor:pointer;color:var(--fg)}button.ef-step:focus-visible,.ef-steph:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.ef-progress{width:100%;height:6px;accent-color:var(--accent)}.ef-steph{font-size:16px;margin:0;overflow-wrap:anywhere}.ef-count{font-size:13px;font-weight:400}.ef-sec{display:flex;flex-direction:column;gap:10px;min-width:0;border:1px solid var(--line);border-radius:8px;padding:12px}.ef-plain{border:0;padding:0}details.ef-sec>summary{cursor:pointer;display:list-item}details.ef-sec>summary .ef-sech{display:inline}details.ef-sec[open]>summary{margin-bottom:8px}.ef-sech{font-size:15px;margin:0;overflow-wrap:anywhere}.ef-help{margin:0;font-size:13px;color:var(--fg2)}.ef-err{font-size:12px;color:var(--danger-fg)}.ef-review{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);gap:4px 12px;margin:0}.ef-review dt{font-weight:600;font-size:13px;overflow-wrap:anywhere}.ef-review dd{margin:0;font-size:13px;overflow-wrap:anywhere}.ef-actions{align-items:center}.ef-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}.embed-form .input,.embed-form .select,.embed-form .textarea{max-width:100%;min-width:0}@media (max-width:480px){.ef-review{grid-template-columns:minmax(0,1fr)}}</style>
</head>
<body class="embed">
<main class="embed-main" id="embed" ${Object.entries(attrs)
      .map(([k, v]) => `data-${k}="${esc(v)}"`)
      .join(' ')} aria-live="polite"><noscript>This page needs JavaScript.</noscript></main>
<script src="/js/form-layout.js"></script>
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

  // ---------- the public link page (the low-code port, follow-up 2) ----------

  // A static page for a form's public link: `/form#token=exa_…`. The token stays in the fragment (never in a request
  // URL) and goes to /api/public/forms/open and /submit in the body, as before. Not framed anywhere: a form meant for
  // other sites is published as an embed page.
  r.get('/form', noStore, (_req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.type('html').send(page('Form', { kind: 'link', title: 'the form' }));
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
