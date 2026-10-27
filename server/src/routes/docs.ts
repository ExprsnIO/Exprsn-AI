import { Router } from 'express';
import { z } from 'zod';
import { SITE_SLUG } from '../docs/service.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import type { Services } from '../services.js';

/**
 * 2.0.x Docs portal: documentation sites over knowledge bases. Reading needs `knowledge:read` and access to the bases
 * (checked by the knowledge services); curating sites needs `docs:manage`.
 */
export function docsRoutes(s: Services): Router {
  const r = Router();
  r.use('/docs', noStore, requireAuth());
  const read = requirePermission(s, 'knowledge:read');
  const manage = requirePermission(s, 'docs:manage');
  const ctx = (req: Parameters<Parameters<Router['get']>[1]>[0]) => ({ ip: ip(req), traceId: req.traceId });
  const kbId = z.string().regex(/^[0-9A-Z]{26}$/);
  const home = z.object({ kbId, slug: z.string().trim().min(1).max(240) }).strict().nullable();
  const fields = {
    slug: z.string().trim().regex(SITE_SLUG, 'lower-case letters, digits and dashes'),
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullable().optional(),
    kbIds: z.array(kbId).max(50),
    home: home.optional(),
    library: z.boolean().optional()
  };

  r.get('/docs/sites', read, async (req, res) => {
    res.json(await s.docs.sites(principalOf(req)));
  });

  r.post('/docs/sites', manage, async (req, res) => {
    const body = parseBody(z.object(fields).strict(), req.body);
    res.status(201).json(await s.docs.create(principalOf(req), body, ctx(req)));
  });

  r.patch('/docs/sites/:id', manage, async (req, res) => {
    const body = parseBody(z.object(fields).partial().strict(), req.body);
    res.json(await s.docs.update(principalOf(req), String(req.params.id), body, ctx(req)));
  });

  r.delete('/docs/sites/:id', manage, async (req, res) => {
    await s.docs.remove(principalOf(req), String(req.params.id), ctx(req));
    res.status(204).end();
  });

  r.get('/docs/sites/:site/nav', read, async (req, res) => {
    res.json(await s.docs.nav(principalOf(req), String(req.params.site)));
  });

  r.get('/docs/sites/:site/page', read, async (req, res) => {
    const q = parseBody(z.object({ kb: kbId, slug: z.string().trim().min(1).max(240), version: z.string().trim().regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}$/).optional() }).strict(), req.query);
    res.json(await s.docs.page(principalOf(req), String(req.params.site), q.kb, q.slug, q.version ?? null));
  });

  r.get('/docs/sites/:site/library', read, async (req, res) => {
    const q = parseBody(z.object({ kb: kbId, category: z.string().trim().min(1).max(300).optional(), q: z.string().trim().min(1).max(200).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).strict(), req.query);
    res.json(await s.docs.library(principalOf(req), String(req.params.site), q.kb, { category: q.category ?? null, q: q.q ?? null, ...(q.limit ? { limit: q.limit } : {}) }));
  });

  r.get('/docs/sites/:site/document/:doc', read, async (req, res) => {
    const q = parseBody(z.object({ from: z.coerce.number().int().min(0).optional() }).strict(), req.query);
    res.json(await s.docs.document(principalOf(req), String(req.params.site), String(req.params.doc), q.from));
  });

  r.get('/docs/sites/:site/search', read, async (req, res) => {
    const q = parseBody(z.object({ q: z.string().trim().min(2).max(300) }).strict(), req.query);
    res.json(await s.docs.search(principalOf(req), String(req.params.site), q.q));
  });

  return r;
}
