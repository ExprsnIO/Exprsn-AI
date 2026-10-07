import { Router, type Request } from 'express';
import { z } from 'zod';
import { LABELS } from '../authz/labels.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { notFound } from '../http/problem.js';
import { REACTIONS, VISIBILITIES, type Ctx } from '../feed/service.js';
import type { Services } from '../services.js';

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
const page = z.object({ cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(100).optional() });

/**
 * The workspace feed (Sprint 28c, B-2701 to B-2705): `feed:read` for feeds, posts, comments, trending tags and digests;
 * `feed:write` to post, comment, react, repost and bookmark; `feed:manage` to remove anyone's posts and comments in
 * one's workspaces and to set and run a workspace's digest. Group feeds also need the group's own rights.
 */
export function feedRoutes(s: Services): Router {
  const r = Router();
  r.use('/feed', noStore, requireAuth());
  const read = requirePermission(s, 'feed:read');
  const write = requirePermission(s, 'feed:write');
  const manage = requirePermission(s, 'feed:manage');
  const f = s.feed;
  const ctx = (req: Request): Ctx => ({ p: principalOf(req), ip: ip(req), traceId: req.traceId ?? null });
  const idOf = (req: Request, key = 'id') => parseBody(id26, (req.params as Record<string, string>)[key]);
  const q = (req: Request) => parseBody(page, req.query);

  /** A workspace the caller may act in, for the workspace routes. */
  const inWorkspace = async (req: Request) => {
    const id = idOf(req);
    const sc = await f.scope(principalOf(req));
    if (!sc.workspaces.has(id)) throw notFound('Workspace');
    return { id, sc };
  };

  // ---------- feeds ----------

  r.get('/feed/home', read, async (req, res) => {
    res.json(await f.home(principalOf(req), q(req)));
  });

  r.get('/feed/workspaces/:id', read, async (req, res) => {
    res.json(await f.workspace(principalOf(req), idOf(req), q(req)));
  });

  r.get('/feed/groups/:id', read, async (req, res) => {
    res.json(await f.group(principalOf(req), idOf(req), q(req)));
  });

  r.get('/feed/users/:id', read, async (req, res) => {
    // 1.6.0 (B-4901): `unlisted=true` adds the caller's own unlisted posts on their own page.
    const query = parseBody(page.extend({ unlisted: z.enum(['true', 'false']).optional() }), req.query);
    res.json(await f.user(principalOf(req), idOf(req), { ...query, unlisted: query.unlisted === 'true' }));
  });

  r.get('/feed/lists/:id', read, async (req, res) => {
    res.json(await f.list(principalOf(req), idOf(req), q(req)));
  });

  r.get('/feed/tags/:tag', read, async (req, res) => {
    const tag = parseBody(z.string().min(1).max(65), (req.params as Record<string, string>).tag);
    const ws = parseBody(z.object({ workspace: id26.optional() }), { workspace: (req.query as Record<string, unknown>).workspace });
    res.json(await f.tag(principalOf(req), tag, ws.workspace ?? null, q(req)));
  });

  r.get('/feed/bookmarks', read, async (req, res) => {
    res.json(await f.bookmarks(principalOf(req), q(req)));
  });

  r.get('/feed/trending', read, async (req, res) => {
    const query = parseBody(z.object({ workspace: id26.optional(), limit: z.coerce.number().int().min(1).max(50).optional() }), req.query);
    const sc = await f.scope(principalOf(req));
    if (query.workspace && !sc.workspaces.has(query.workspace)) throw notFound('Workspace');
    res.json(await f.digests.trending(sc.p, query.workspace ? [query.workspace] : [...sc.workspaces.keys()], query.limit ?? 20));
  });

  // ---------- posts ----------

  r.post('/feed/posts', write, async (req, res) => {
    const body = parseBody(z.object({ workspaceId: id26.optional(), groupId: id26.optional(), body: z.string().max(100_000).optional(), media: z.array(id26).max(10).optional(), label: z.enum(LABELS).optional(), visibility: z.enum(VISIBILITIES).optional() }).strict(), req.body);
    const post = await f.createPost(ctx(req), body);
    res.status(post.state === 'held' ? 202 : 201).json(post);
  });

  r.get('/feed/posts/:id', read, async (req, res) => {
    res.json(await f.view(principalOf(req), idOf(req)));
  });

  r.patch('/feed/posts/:id', write, async (req, res) => {
    const body = parseBody(z.object({ body: z.string().max(100_000).optional(), visibility: z.enum(VISIBILITIES).optional() }).strict().refine((b) => b.body !== undefined || b.visibility !== undefined, 'Send body, visibility or both'), req.body);
    res.json(await f.updatePost(ctx(req), idOf(req), body.body, body.visibility));
  });

  r.delete('/feed/posts/:id', write, async (req, res) => {
    res.json(await f.deletePost(ctx(req), idOf(req)));
  });

  r.post('/feed/posts/:id/repost', write, async (req, res) => {
    const body = parseBody(z.object({ body: z.string().max(100_000).optional() }).strict(), req.body ?? {});
    const out = await f.repost(ctx(req), idOf(req), body.body);
    res.status(out.post.state === 'held' ? 202 : out.created ? 201 : 200).json(out.post);
  });

  // 1.6.0 (B-4901): quote a post with a comment, in the caller's workspace or group of choice.
  r.post('/feed/posts/:id/quote', write, async (req, res) => {
    const body = parseBody(z.object({ body: z.string().max(100_000), workspaceId: id26.optional(), groupId: id26.optional(), media: z.array(id26).max(10).optional(), label: z.enum(LABELS).optional(), visibility: z.enum(VISIBILITIES).optional() }).strict(), req.body);
    const post = await f.quote(ctx(req), idOf(req), body);
    res.status(post.state === 'held' ? 202 : 201).json(post);
  });

  r.delete('/feed/posts/:id/repost', write, async (req, res) => {
    res.json(await f.unrepost(ctx(req), idOf(req)));
  });

  // ---------- comments ----------

  r.get('/feed/posts/:id/comments', read, async (req, res) => {
    res.json(await f.comments(principalOf(req), idOf(req), q(req)));
  });

  r.post('/feed/posts/:id/comments', write, async (req, res) => {
    const body = parseBody(z.object({ body: z.string().max(100_000), parentId: id26.optional() }).strict(), req.body);
    res.status(201).json(await f.comment(ctx(req), idOf(req), body));
  });

  r.delete('/feed/comments/:id', write, async (req, res) => {
    res.json(await f.deleteComment(ctx(req), idOf(req)));
  });

  // ---------- reactions and bookmarks ----------

  const kindOf = (req: Request) => parseBody(z.enum(REACTIONS), (req.params as Record<string, string>).kind);

  r.put('/feed/posts/:id/reactions/:kind', write, async (req, res) => {
    const out = await f.react(ctx(req), idOf(req), kindOf(req));
    res.status(out.added ? 201 : 200).json(out);
  });

  r.delete('/feed/posts/:id/reactions/:kind', write, async (req, res) => {
    res.json(await f.unreact(ctx(req), idOf(req), kindOf(req)));
  });

  r.put('/feed/posts/:id/bookmark', write, async (req, res) => {
    const out = await f.bookmark(ctx(req), idOf(req));
    res.status(out.added ? 201 : 200).json(out);
  });

  r.delete('/feed/posts/:id/bookmark', write, async (req, res) => {
    res.json(await f.unbookmark(ctx(req), idOf(req)));
  });

  // ---------- digests ----------

  r.get('/feed/workspaces/:id/digests', read, async (req, res) => {
    const { id, sc } = await inWorkspace(req);
    res.json(await f.digests.list(sc.p, id));
  });

  r.get('/feed/digests/:id', read, async (req, res) => {
    const p = principalOf(req);
    const sc = await f.scope(p);
    res.json(await f.digests.get(p, idOf(req), [...sc.workspaces.keys()], (ids) => f.visibleViews(p, ids, sc)));
  });

  r.get('/feed/workspaces/:id/settings', manage, async (req, res) => {
    const { id, sc } = await inWorkspace(req);
    res.json(await f.digests.settings(sc.p.tenantId, id));
  });

  r.put('/feed/workspaces/:id/settings', manage, async (req, res) => {
    const { id } = await inWorkspace(req);
    const body = parseBody(z.object({ digestEnabled: z.boolean().optional(), digestProfile: z.string().trim().min(1).max(200).nullable().optional() }).strict(), req.body);
    res.json(await f.digests.setSettings(ctx(req), id, body));
  });

  r.post('/feed/workspaces/:id/digest', manage, async (req, res) => {
    const { id } = await inWorkspace(req);
    parseBody(z.object({}).strict(), req.body ?? {});
    res.status(202).json(await f.digests.request(ctx(req), id));
  });

  return r;
}
