import { Router, type Request } from 'express';
import { z } from 'zod';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { CONTACT_RULES, type Ctx } from '../social/service.js';
import type { Services } from '../services.js';

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');

/**
 * Social relations (Sprint 28b, B-2606 with B-2702): the caller's own blocks, mutes, follows, lists and contact rule
 * (`social:read` to see them, `social:write` to change them), and an admin view of anyone's (`social:manage`).
 * Messaging and the workspace feed both enforce what is set here.
 */
export function socialRoutes(s: Services): Router {
  const r = Router();
  r.use('/social', noStore, requireAuth());
  const read = requirePermission(s, 'social:read');
  const write = requirePermission(s, 'social:write');
  const manage = requirePermission(s, 'social:manage');
  const so = s.social;
  const ctx = (req: Request): Ctx => ({ p: principalOf(req), ip: ip(req), traceId: req.traceId ?? null });
  const idOf = (req: Request, key = 'id') => parseBody(id26, (req.params as Record<string, string>)[key]);
  const target = z.object({ userId: id26 }).strict();

  r.get('/social/settings', read, async (req, res) => {
    res.json(await so.settings(principalOf(req)));
  });

  r.put('/social/settings', write, async (req, res) => {
    const body = parseBody(z.object({ contactRule: z.enum(CONTACT_RULES) }).strict(), req.body);
    res.json(await so.setContactRule(ctx(req), body.contactRule));
  });

  // B-3411: people who share a workspace with the caller, for the console's person picker.
  r.get('/social/people', read, async (req, res) => {
    const q = parseBody(z.object({ q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }), req.query);
    res.json(await so.directory(principalOf(req), q.q, q.limit));
  });

  r.get('/social/users/:id', read, async (req, res) => {
    res.json(await so.relation(principalOf(req), idOf(req)));
  });

  // ---------- blocks ----------

  r.get('/social/blocks', read, async (req, res) => {
    res.json(await so.blocks(principalOf(req)));
  });

  r.post('/social/blocks', write, async (req, res) => {
    const out = await so.block(ctx(req), parseBody(target, req.body).userId);
    res.status(out.created ? 201 : 200).json(out);
  });

  r.delete('/social/blocks/:id', write, async (req, res) => {
    res.json(await so.unblock(ctx(req), idOf(req)));
  });

  // ---------- mutes ----------

  r.get('/social/mutes', read, async (req, res) => {
    res.json(await so.mutes(principalOf(req)));
  });

  r.post('/social/mutes', write, async (req, res) => {
    const body = parseBody(z.object({ userId: id26, minutes: z.number().int().min(1).max(366 * 1440).optional() }).strict(), req.body);
    res.status(201).json(await so.mute(ctx(req), body.userId, body.minutes ? Date.now() + body.minutes * 60_000 : null));
  });

  r.delete('/social/mutes/:id', write, async (req, res) => {
    res.json(await so.unmute(ctx(req), idOf(req)));
  });

  // ---------- follows ----------

  r.get('/social/following', read, async (req, res) => {
    res.json(await so.followingList(principalOf(req)));
  });

  r.get('/social/followers', read, async (req, res) => {
    res.json(await so.followersList(principalOf(req)));
  });

  r.post('/social/following', write, async (req, res) => {
    const out = await so.follow(ctx(req), parseBody(target, req.body).userId);
    res.status(out.created ? 201 : 200).json(out);
  });

  r.delete('/social/following/:id', write, async (req, res) => {
    res.json(await so.unfollow(ctx(req), idOf(req)));
  });

  // ---------- lists ----------

  const listFields = { name: z.string().trim().min(1).max(100), description: z.string().trim().max(500).nullable().optional() };

  r.get('/social/lists', read, async (req, res) => {
    res.json(await so.lists(principalOf(req)));
  });

  r.post('/social/lists', write, async (req, res) => {
    res.status(201).json(await so.createList(ctx(req), parseBody(z.object(listFields).strict(), req.body)));
  });

  r.get('/social/lists/:id', read, async (req, res) => {
    res.json(await so.getList(principalOf(req), idOf(req)));
  });

  r.patch('/social/lists/:id', write, async (req, res) => {
    res.json(await so.updateList(ctx(req), idOf(req), parseBody(z.object({ ...listFields, name: listFields.name.optional() }).strict(), req.body)));
  });

  r.delete('/social/lists/:id', write, async (req, res) => {
    res.json(await so.deleteList(ctx(req), idOf(req)));
  });

  r.post('/social/lists/:id/members', write, async (req, res) => {
    const out = await so.addToList(ctx(req), idOf(req), parseBody(target, req.body).userId);
    res.status(out.added ? 201 : 200).json(out);
  });

  r.delete('/social/lists/:id/members/:userId', write, async (req, res) => {
    res.json(await so.removeFromList(ctx(req), idOf(req), idOf(req, 'userId')));
  });

  // ---------- administration ----------

  r.get('/social/admin/users/:id', manage, async (req, res) => {
    res.json(await so.adminView(ctx(req), idOf(req)));
  });

  return r;
}
