import { Router, type Request } from 'express';
import { z } from 'zod';
import { LABELS } from '../authz/labels.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { SEARCH_MODES } from '../messaging/insights.js';
import { DM_ROLES, MAX_ATTACHMENTS, MAX_BODY, NOTIFY_RULES, type Ctx } from '../messaging/service.js';
import type { Services } from '../services.js';

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
const body = z.string().trim().min(1).max(MAX_BODY);
const emoji = z.string().min(1).max(32).regex(/^\S+$/u, 'one emoji or :name: without spaces');
const empty = z.object({}).strict();

/**
 * Messaging (Sprint 28b, B-2601 to B-2606): person-to-person conversations. `messages:read` to read, `messages:write`
 * to start conversations, send and react; what a member may do inside a conversation is their role (owner, admin,
 * member). All of it inside the caller's workspaces, clearance and social relations (blocks, contact rules).
 */
export function messagingRoutes(s: Services): Router {
  const r = Router();
  r.use('/messaging', noStore, requireAuth());
  const read = requirePermission(s, 'messages:read');
  const write = requirePermission(s, 'messages:write');
  const m = s.messaging;
  const ins = s.messagingInsights;
  const ctx = (req: Request): Ctx => ({ p: principalOf(req), ip: ip(req), traceId: req.traceId ?? null });
  const idOf = (req: Request, key = 'id') => parseBody(id26, (req.params as Record<string, string>)[key]);

  // ---------- conversations (B-2601) ----------

  r.get('/messaging/conversations', read, async (req, res) => {
    const q = parseBody(z.object({ workspace: id26.optional() }), req.query);
    res.json(await m.list(principalOf(req), { workspaceId: q.workspace }));
  });

  r.post('/messaging/conversations', write, async (req, res) => {
    const input = parseBody(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('direct'), userId: id26, label: z.enum(LABELS).optional() }).strict(),
        z.object({ kind: z.literal('group'), workspaceId: id26.optional(), title: z.string().trim().min(1).max(200).nullable().optional(), memberIds: z.array(id26).min(1).max(1000), label: z.enum(LABELS).optional() }).strict()
      ]),
      req.body
    );
    if (input.kind === 'direct') {
      const out = await m.direct(ctx(req), input.userId, input.label);
      res.status(out.created ? 201 : 200).json(out.conversation);
      return;
    }
    res.status(201).json(await m.createGroup(ctx(req), input));
  });

  r.get('/messaging/conversations/:id', read, async (req, res) => {
    res.json(await m.view(principalOf(req), idOf(req)));
  });

  r.patch('/messaging/conversations/:id', write, async (req, res) => {
    res.json(await m.update(ctx(req), idOf(req), parseBody(z.object({ title: z.string().trim().min(1).max(200).nullable().optional() }).strict(), req.body)));
  });

  r.delete('/messaging/conversations/:id', write, async (req, res) => {
    res.json(await m.remove(ctx(req), idOf(req)));
  });

  r.get('/messaging/conversations/:id/members', read, async (req, res) => {
    res.json(await m.members(principalOf(req), idOf(req)));
  });

  r.post('/messaging/conversations/:id/members', write, async (req, res) => {
    const b = parseBody(z.object({ userId: id26, role: z.enum(DM_ROLES).default('member') }).strict(), req.body);
    res.status(201).json(await m.addMember(ctx(req), idOf(req), b.userId, b.role));
  });

  r.patch('/messaging/conversations/:id/members/:userId', write, async (req, res) => {
    const b = parseBody(z.object({ role: z.enum(DM_ROLES) }).strict(), req.body);
    res.json(await m.setRole(ctx(req), idOf(req), idOf(req, 'userId'), b.role));
  });

  r.delete('/messaging/conversations/:id/members/:userId', write, async (req, res) => {
    res.json(await m.removeMember(ctx(req), idOf(req), idOf(req, 'userId')));
  });

  // B-2604: the caller's mute and notification rule for one conversation.
  r.put('/messaging/conversations/:id/settings', write, async (req, res) => {
    const b = parseBody(z.object({ muted: z.boolean().optional(), mutedMinutes: z.number().int().min(1).max(366 * 1440).optional(), notify: z.enum(NOTIFY_RULES).optional() }).strict(), req.body);
    res.json(await m.settings(ctx(req), idOf(req), b));
  });

  // ---------- messages (B-2602) ----------

  r.get('/messaging/conversations/:id/messages', read, async (req, res) => {
    const q = parseBody(z.object({ before: z.coerce.number().int().min(0).optional(), thread: id26.optional(), limit: z.coerce.number().int().min(1).max(200).optional() }), req.query);
    res.json(await m.messages(principalOf(req), idOf(req), q));
  });

  r.post('/messaging/conversations/:id/messages', write, async (req, res) => {
    const b = parseBody(z.object({ body, replyTo: id26.optional(), threadId: id26.optional(), attachments: z.array(id26).max(MAX_ATTACHMENTS).optional() }).strict(), req.body);
    res.status(201).json(await m.send(ctx(req), idOf(req), b));
  });

  r.get('/messaging/conversations/:id/pins', read, async (req, res) => {
    res.json(await m.pins(principalOf(req), idOf(req)));
  });

  r.patch('/messaging/messages/:id', write, async (req, res) => {
    res.json(await m.edit(ctx(req), idOf(req), parseBody(z.object({ body }).strict(), req.body).body));
  });

  r.delete('/messaging/messages/:id', write, async (req, res) => {
    res.json(await m.delete(ctx(req), idOf(req)));
  });

  r.post('/messaging/messages/:id/reactions', write, async (req, res) => {
    res.status(201).json(await m.react(ctx(req), idOf(req), parseBody(z.object({ emoji }).strict(), req.body).emoji, true));
  });

  r.delete('/messaging/messages/:id/reactions/:emoji', write, async (req, res) => {
    res.json(await m.react(ctx(req), idOf(req), parseBody(emoji, (req.params as Record<string, string>).emoji), false));
  });

  r.post('/messaging/messages/:id/pin', write, async (req, res) => {
    parseBody(empty, req.body ?? {});
    res.json(await m.pin(ctx(req), idOf(req), true));
  });

  r.delete('/messaging/messages/:id/pin', write, async (req, res) => {
    res.json(await m.pin(ctx(req), idOf(req), false));
  });

  r.post('/messaging/messages/:id/forward', write, async (req, res) => {
    res.status(201).json(await m.forward(ctx(req), idOf(req), parseBody(z.object({ conversationId: id26 }).strict(), req.body).conversationId));
  });

  // ---------- receipts (B-2603) ----------

  r.post('/messaging/conversations/:id/read', read, async (req, res) => {
    res.json(await m.mark(ctx(req), idOf(req), 'read', parseBody(z.object({ messageId: id26 }).strict(), req.body).messageId));
  });

  r.post('/messaging/conversations/:id/delivered', read, async (req, res) => {
    res.json(await m.mark(ctx(req), idOf(req), 'delivered', parseBody(z.object({ messageId: id26 }).strict(), req.body).messageId));
  });

  r.get('/messaging/conversations/:id/receipts', read, async (req, res) => {
    res.json(await m.receipts(principalOf(req), idOf(req)));
  });

  // ---------- search, summaries and digests (B-2605) ----------

  r.get('/messaging/conversations/:id/search', read, async (req, res) => {
    const q = parseBody(z.object({ q: z.string().trim().min(1).max(500), mode: z.enum(SEARCH_MODES).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }), req.query);
    res.json(await ins.search(principalOf(req), idOf(req), q));
  });

  r.post('/messaging/conversations/:id/summary', read, requirePermission(s, 'inference:invoke'), async (req, res) => {
    const b = parseBody(z.object({ threadId: id26.optional(), profile: z.string().min(1).max(63).optional(), limit: z.number().int().min(1).max(2000).optional() }).strict(), req.body ?? {});
    res.json(await ins.summary(ctx(req), idOf(req), b));
  });

  r.post('/messaging/conversations/:id/digest', read, requirePermission(s, 'inference:invoke'), async (req, res) => {
    const b = parseBody(z.object({ profile: z.string().min(1).max(63).optional() }).strict(), req.body ?? {});
    res.json(await ins.digest(ctx(req), idOf(req), b));
  });

  return r;
}
