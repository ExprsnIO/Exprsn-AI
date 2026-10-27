import { Router, type Request } from 'express';
import { z } from 'zod';
import { ip, noStore, parseBody, principalOf, requireAnyPermission, requireAuth, requirePermission } from '../http/middleware.js';
import { SEARCH_PERMISSIONS, SOURCES, type Source } from '../search/everything.js';
import { chatQuery, id26, listOf, paging, postQuery, query } from '../search/filters.js';
import type { AdminCtx } from '../search/indexer.js';
import { MAX_SAVED_NAME, rawFilters, SAVED_SOURCES, type SavedCtx } from '../search/saved.js';
import type { Services } from '../services.js';

/*
 * 1.9.0, Sprint 52 (B-170 to B-173): search.
 *
 *   GET  /api/search                 one search box: every source the caller may search, grouped (any source permission)
 *   GET  /api/search/suggest         type-ahead for the box (the last word as a prefix)
 *   GET  /api/search/messages        across the caller's conversations, with filters (messages:read)
 *   GET  /api/search/posts           posts and comments in the feed, groups and lists (feed:read)
 *   GET  /api/search/messages/:id/locate   where a message is, for a link to it (messages:read; no text)
 *   GET    /api/search/saved          the caller's saved searches (any source permission)
 *   POST   /api/search/saved          save a search (the source's permission; audited, without the query)
 *   GET    /api/search/saved/:id      one of them
 *   PATCH  /api/search/saved/:id      rename it, or change its query, source or filters (audited)
 *   DELETE /api/search/saved/:id      delete it (audited)
 *   POST   /api/search/saved/:id/run  run it as the caller now
 *   GET  /api/admin/search           the tenant's index: state, progress, keys (tenant:manage)
 *   POST /api/admin/search/enable    turn the index on and backfill (tenant:manage, audited)
 *   POST /api/admin/search/rebuild   resume a stopped backfill, or build again (tenant:manage, audited)
 *   POST /api/admin/search/rotate    a new search key, everything indexed again under it (tenant:manage, audited)
 *   POST /api/admin/search/disable   turn the index off and delete it (tenant:manage, audited)
 *
 * Queries are not audited (B-173 asks for admin actions only) and are stored only when a person saves a search, sealed
 * (1.9.9-qa); the console keeps recent searches in the browser.
 */

const savedName = z.string().trim().min(1).max(MAX_SAVED_NAME);

export function searchRoutes(s: Services): Router {
  const r = Router();
  r.use(['/search', '/admin/search'], noStore, requireAuth());
  const any = requireAnyPermission(s, SEARCH_PERMISSIONS);
  const manage = requirePermission(s, 'tenant:manage');
  const ctx = (req: Request): AdminCtx & SavedCtx => ({ p: principalOf(req), ip: ip(req), traceId: req.traceId ?? null });

  // ---------- B-173: one search box ----------

  r.get('/search', any, async (req, res) => {
    const q = parseBody(z.object({ q: query, sources: listOf(SOURCES).optional(), limit: z.coerce.number().int().min(1).max(20).optional() }), req.query);
    res.json(await s.search.everything.search(principalOf(req), { q: q.q, sources: q.sources as Source[] | undefined, limit: q.limit }));
  });

  r.get('/search/suggest', any, async (req, res) => {
    const q = parseBody(z.object({ q: z.string().max(200), sources: listOf(SOURCES).optional() }), req.query);
    if (!q.q.trim()) {
      res.json({ q: q.q, groups: [], completions: [], engine: 'fallback' });
      return;
    }
    res.json(await s.search.everything.suggest(principalOf(req), q.q, q.sources as Source[] | undefined));
  });

  // ---------- B-171: across chats ----------

  r.get('/search/messages', requirePermission(s, 'messages:read'), async (req, res) => {
    res.json(await s.search.chats.search(principalOf(req), parseBody(chatQuery, req.query)));
  });

  // 1.9.9-qa: a search result's link opens the message in its conversation; this says where it is, or that it is gone.
  r.get('/search/messages/:id/locate', requirePermission(s, 'messages:read'), async (req, res) => {
    const { id } = parseBody(z.object({ id: id26 }), req.params);
    res.json(await s.search.chats.locate(principalOf(req), id));
  });

  // ---------- B-172: posts and comments ----------

  r.get('/search/posts', requirePermission(s, 'feed:read'), async (req, res) => {
    res.json(await s.search.posts.search(principalOf(req), parseBody(postQuery, req.query)));
  });

  // ---------- 1.9.9-qa (B-173): saved searches, per person and sealed ----------

  const savedId = (req: Request) => parseBody(z.object({ id: id26 }), req.params).id;

  r.get('/search/saved', any, async (req, res) => {
    res.json(await s.search.saved.list(principalOf(req)));
  });

  r.post('/search/saved', any, async (req, res) => {
    const body = parseBody(z.object({ name: savedName, q: query, source: z.enum(SAVED_SOURCES).default('all'), filters: rawFilters.optional() }).strict(), req.body ?? {});
    res.status(201).json(await s.search.saved.create(ctx(req), body));
  });

  r.get('/search/saved/:id', any, async (req, res) => {
    res.json(await s.search.saved.get(principalOf(req), savedId(req)));
  });

  r.patch('/search/saved/:id', any, async (req, res) => {
    const body = parseBody(z.object({ name: savedName.optional(), q: query.optional(), source: z.enum(SAVED_SOURCES).optional(), filters: rawFilters.optional() }).strict(), req.body ?? {});
    res.json(await s.search.saved.update(ctx(req), savedId(req), body));
  });

  r.delete('/search/saved/:id', any, async (req, res) => {
    res.json(await s.search.saved.remove(ctx(req), savedId(req)));
  });

  r.post('/search/saved/:id/run', any, async (req, res) => {
    const body = parseBody(z.object(paging).strict(), req.body ?? {});
    res.json(await s.search.saved.run(principalOf(req), savedId(req), body));
  });

  // ---------- B-170: the index (tenant administration) ----------

  r.get('/admin/search', manage, async (req, res) => {
    res.json(await s.search.index.status(principalOf(req).tenantId));
  });

  r.post('/admin/search/enable', manage, async (req, res) => {
    parseBody(z.object({}).strict(), req.body ?? {});
    res.status(202).json(await s.search.index.enable(ctx(req)));
  });

  r.post('/admin/search/rebuild', manage, async (req, res) => {
    const body = parseBody(z.object({ restart: z.boolean().optional() }).strict(), req.body ?? {});
    res.status(202).json(await s.search.index.rebuild(ctx(req), body));
  });

  r.post('/admin/search/rotate', manage, async (req, res) => {
    parseBody(z.object({}).strict(), req.body ?? {});
    res.status(202).json(await s.search.index.rotate(ctx(req)));
  });

  r.post('/admin/search/disable', manage, async (req, res) => {
    parseBody(z.object({}).strict(), req.body ?? {});
    res.json(await s.search.index.disable(ctx(req)));
  });

  return r;
}
