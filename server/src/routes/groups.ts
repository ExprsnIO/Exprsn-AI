import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { LABELS } from '../authz/labels.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { badRequest, notFound, tooManyRequests } from '../http/problem.js';
import { BAN_KINDS, BAN_LIMITS } from '../groups/bans.js';
import { CASE_ACTIONS, CASE_LIMITS } from '../groups/cases.js';
import { EVENT_KINDS, EVENT_VISIBILITIES, FEED_KINDS, NOTICE_MAX, RSVP_RESPONSES, RSVP_STATES } from '../groups/calendar.js';
import { CUSTOM_RIGHTS, GROUP_RIGHTS } from '../groups/roles.js';
import { MAX_RADIUS_KM, parseNear } from '../groups/geo.js';
import { INVITE_LIMITS } from '../groups/invites.js';
import { MAX_PAGE, paged } from '../groups/paging.js';
import { GROUP_PROFILE_LIMITS, IMAGE_KINDS } from '../groups/profile.js';
import { GROUP_ROLES, JOIN_MODES, VISIBILITIES, type Ctx } from '../groups/service.js';
import { sandboxHeaders } from '../media/origin.js';
import { Limiter } from '../platform/ratelimit.js';
import type { Services } from '../services.js';

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
const name = z.string().trim().min(1).max(200);
const text = (max: number) => z.string().trim().max(max);
const isoTime = z.string().trim().min(10).max(40);
const reminders = z.array(z.number().int().min(1).max(28 * 1440)).max(5);
const lat = z.number().min(-90).max(90).nullable();
const lon = z.number().min(-180).max(180).nullable();
// 1.6.0 (B-4403): a group's place: a name, a point, or both.
const location = z.object({ name: text(200).nullable().optional(), lat: lat.optional(), lon: lon.optional() }).strict().nullable();
// 1.6.0 (B-4403, B-4405): the list filters: a category (or `none`) and a distance (`near=<lat>,<lon>`, `km`).
const listFilters = {
  workspace: id26.optional(),
  category: z.union([id26, z.literal('none')]).optional(),
  near: z.string().trim().max(60).regex(/^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$/, 'latitude,longitude').optional(),
  km: z.coerce.number().positive().max(MAX_RADIUS_KM).optional()
};
// 1.7.0 (B-9704): search and paging. With `limit` or `cursor` a list answers `{ items, next, total }`.
const pageQuery = { q: z.string().trim().max(100).optional(), limit: z.coerce.number().int().min(1).max(MAX_PAGE).optional(), cursor: z.string().max(600).optional() };
// 1.7.0 (B-9703): a group's profile fields and its member limit.
const profileFields = {
  tags: z.array(z.string().trim().min(1).max(GROUP_PROFILE_LIMITS.tagLength)).max(GROUP_PROFILE_LIMITS.tags).optional(),
  website: z.string().trim().max(GROUP_PROFILE_LIMITS.website).nullable().optional(),
  memberLimit: z.number().int().min(1).max(GROUP_PROFILE_LIMITS.memberLimit).nullable().optional()
};
const nearOf = (q: { near?: string | undefined; km?: number | undefined }) => {
  if (!q.near) return null;
  const n = parseNear(q.near, q.km);
  if (!n) throw badRequest('near is a latitude (−90 to 90) and a longitude (−180 to 180), separated by a comma.');
  return n;
};

const eventFields = {
  title: name,
  description: text(10_000).nullable().optional(),
  location: text(500).nullable().optional(),
  start: isoTime,
  end: isoTime.optional(),
  durationMinutes: z.number().int().min(1).max(31 * 1440).optional(),
  timeZone: z.string().trim().min(1).max(64),
  allDay: z.boolean().optional(),
  capacity: z.number().int().min(1).max(100_000).nullable().optional(),
  maxGuests: z.number().int().min(0).max(20).optional(),
  reminders: reminders.optional(),
  lat: lat.optional(),
  lon: lon.optional(),
  // 1.7.0 (B-9707)
  kind: z.enum(EVENT_KINDS).optional(),
  virtualUrl: z.string().trim().min(1).max(2000).nullable().optional(),
  visibility: z.enum(EVENT_VISIBILITIES).optional(),
  rsvpDeadline: isoTime.nullable().optional(),
  rsvpApproval: z.boolean().optional(),
  waitlist: z.boolean().optional()
};

const timeQuery = (v: string | undefined, fallback: number): number => {
  if (v == null) return fallback;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) throw badRequest(`${v} is not an ISO 8601 time.`);
  return ms;
};

/**
 * Groups and events (Sprint 27c, B-2501 to B-2505). `groups:read` to see, `groups:write` to change; what a member may do
 * inside a group is decided by their group role (owner, moderator, member), and `groups:manage` acts as owner. All of
 * it inside the caller's workspaces and clearance.
 */
export function groupRoutes(s: Services): Router {
  const r = Router();
  r.use(['/groups', '/group-requests', '/group-invites', '/group-posts', '/group-categories', '/calendar'], noStore, requireAuth());
  const read = requirePermission(s, 'groups:read');
  const write = requirePermission(s, 'groups:write');
  const g = s.groups;
  const cal = s.calendar;
  const ctx = (req: Request): Ctx => ({ p: principalOf(req), ip: ip(req), traceId: req.traceId ?? null });
  const idOf = (req: Request, key = 'id') => parseBody(id26, (req.params as Record<string, string>)[key]);

  // ---------- groups ----------

  r.get('/groups', read, async (req, res) => {
    const q = parseBody(z.object({ ...listFilters, ...pageQuery, mine: z.enum(['true', 'false']).optional() }), req.query);
    const filters = { workspaceId: q.workspace ?? null, mine: q.mine === 'true', category: q.category ?? null, near: nearOf(q) };
    res.json(paged(q) ? await g.listPage(principalOf(req), { ...filters, q: q.q, limit: q.limit, cursor: q.cursor }) : await g.list(principalOf(req), { ...filters, search: q.q }));
  });

  r.post('/groups', write, async (req, res) => {
    const body = parseBody(z.object({ workspaceId: id26.optional(), name, description: text(5000).nullable().optional(), visibility: z.enum(VISIBILITIES).optional(), joinMode: z.enum(JOIN_MODES).optional(), label: z.enum(LABELS).optional(), categoryId: id26.nullable().optional(), location: location.optional(), ...profileFields }).strict(), req.body);
    res.status(201).json(await g.create(ctx(req), body));
  });

  // 1.6.0 (B-4402): groups the caller may join, ranked by shared members and activity; never above their clearance.
  r.get('/groups/discover', read, async (req, res) => {
    const q = parseBody(z.object({ ...listFilters, q: pageQuery.q, limit: z.coerce.number().int().min(1).max(200).optional() }), req.query);
    res.json(await g.depth.discover(principalOf(req), { workspaceId: q.workspace ?? null, category: q.category ?? null, near: nearOf(q), limit: q.limit, search: q.q }));
  });

  // 1.6.0 (B-4404): the trending groups of the caller's workspaces, as the `groups.trending` job last counted them.
  r.get('/groups/trending', read, async (req, res) => {
    const q = parseBody(z.object({ workspace: id26.optional(), category: listFilters.category, limit: z.coerce.number().int().min(1).max(100).optional() }), req.query);
    res.json(await g.depth.trending(principalOf(req), { workspaceId: q.workspace ?? null, category: q.category ?? null, limit: q.limit }));
  });

  // 1.6.0 (B-4405): the tenant's group categories (managed under /api/admin/social/group-categories).
  r.get('/group-categories', read, async (req, res) => {
    res.json(await g.depth.categories(principalOf(req).tenantId));
  });

  r.get('/group-requests', read, async (req, res) => {
    res.json(await g.mine(principalOf(req)));
  });

  r.post('/group-requests/:id/accept', write, async (req, res) => {
    res.json((await g.decide(ctx(req), idOf(req), 'accept')).request);
  });

  r.post('/group-requests/:id/decline', write, async (req, res) => {
    res.json((await g.decide(ctx(req), idOf(req), 'decline')).request);
  });

  r.delete('/group-requests/:id', write, async (req, res) => {
    res.json(await g.cancel(ctx(req), idOf(req)));
  });

  r.delete('/group-posts/:id', write, async (req, res) => {
    res.json(await g.deletePost(ctx(req), idOf(req)));
  });

  r.get('/groups/:id', read, async (req, res) => {
    res.json(await g.view(principalOf(req), idOf(req)));
  });

  r.patch('/groups/:id', write, async (req, res) => {
    const body = parseBody(z.object({ name: name.optional(), description: text(5000).nullable().optional(), visibility: z.enum(VISIBILITIES).optional(), joinMode: z.enum(JOIN_MODES).optional(), label: z.enum(LABELS).optional(), categoryId: id26.nullable().optional(), location: location.optional(), ...profileFields }).strict(), req.body);
    res.json(await g.update(ctx(req), idOf(req), body));
  });

  // 1.7.0 (B-9703): the avatar and the banner. The raw image is the body (PNG, JPEG, WebP or GIF; an avatar at most
  // 2 MiB, a banner 5 MiB); it goes into the file store's quarantine and is served once its scan released it.
  const declared = (req: Request): number | null => {
    const n = Number(req.header('content-length') ?? NaN);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  for (const kind of IMAGE_KINDS) {
    r.put(`/groups/:id/${kind}`, write, async (req, res) => {
      res.status(202).json(await g.profile.setImage(ctx(req), idOf(req), kind, { declaredType: req.header('content-type') ?? null, declaredBytes: declared(req) }, req));
    });

    r.delete(`/groups/:id/${kind}`, write, async (req, res) => {
      res.json(await g.profile.removeImage(ctx(req), idOf(req), kind));
    });

    r.get(`/groups/:id/${kind}`, read, async (req, res) => {
      const got = await g.profile.image(principalOf(req), idOf(req), kind);
      sandboxHeaders(res);
      res.setHeader('Content-Type', got.type);
      res.setHeader('Content-Length', String(got.size));
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Cache-Control', 'private, no-store');
      await pipeline(Readable.from(got.stream), res);
    });
  }

  // 1.6.0 (B-4401): channels inside a group, with their own members, roles and posts.
  r.get('/groups/:id/channels', read, async (req, res) => {
    res.json(await g.list(principalOf(req), { parentId: idOf(req) }));
  });

  r.post('/groups/:id/channels', write, async (req, res) => {
    const body = parseBody(z.object({ name, description: text(5000).nullable().optional(), visibility: z.enum(VISIBILITIES).optional(), joinMode: z.enum(JOIN_MODES).optional(), label: z.enum(LABELS).optional() }).strict(), req.body);
    res.status(201).json(await g.createChannel(ctx(req), idOf(req), body));
  });

  r.delete('/groups/:id', write, async (req, res) => {
    res.json(await g.remove(ctx(req), idOf(req)));
  });

  r.get('/groups/:id/members', read, async (req, res) => {
    // 1.7.0 (B-9801): `departed=1` (managers) lists members whose account is no longer active, to remove them.
    const q = parseBody(z.object({ ...pageQuery, role: z.enum(GROUP_ROLES).optional(), departed: z.enum(['0', '1']).transform((v) => v === '1').optional() }), req.query);
    res.json(await g.members(principalOf(req), idOf(req), q));
  });

  r.patch('/groups/:id/members/:userId', write, async (req, res) => {
    // 1.7.0 (B-9705): a tier, or one of the group's custom roles (held with the tier `member`).
    const body = parseBody(z.object({ role: z.enum(GROUP_ROLES).optional(), customRoleId: id26.nullable().optional() }).strict().refine((b) => b.role !== undefined || !!b.customRoleId, { message: 'Give a role or a custom role.' }), req.body);
    res.json(await g.setRole(ctx(req), idOf(req), idOf(req, 'userId'), body.role ?? 'member', body.customRoleId ?? null));
  });

  // ---------- roles (1.7.0, B-9705): the tiers' rights and the group's custom roles ----------

  const roleRights = z.array(z.enum(GROUP_RIGHTS)).max(GROUP_RIGHTS.length).refine((r) => r.every((x) => x === 'read' || (CUSTOM_RIGHTS as readonly string[]).includes(x)), { message: 'A custom role cannot carry the right to delete the group.' });
  const roleName = z.string().trim().min(1).max(60);

  r.get('/groups/:id/roles', read, async (req, res) => {
    res.json(await g.roles.list(await g.require(principalOf(req), idOf(req), 'read')));
  });

  r.post('/groups/:id/roles', write, async (req, res) => {
    const body = parseBody(z.object({ name: roleName, rights: roleRights }).strict(), req.body);
    res.status(201).json(await g.roles.create(ctx(req), await g.require(principalOf(req), idOf(req), 'roles'), body));
  });

  r.patch('/groups/:id/roles/:roleId', write, async (req, res) => {
    const body = parseBody(z.object({ name: roleName.optional(), rights: roleRights.optional() }).strict(), req.body);
    res.json(await g.roles.update(ctx(req), await g.require(principalOf(req), idOf(req), 'roles'), idOf(req, 'roleId'), body));
  });

  r.delete('/groups/:id/roles/:roleId', write, async (req, res) => {
    res.json(await g.roles.remove(ctx(req), await g.require(principalOf(req), idOf(req), 'roles'), idOf(req, 'roleId')));
  });

  r.delete('/groups/:id/members/:userId', write, async (req, res) => {
    res.json(await g.removeMember(ctx(req), idOf(req), idOf(req, 'userId')));
  });

  // 1.7.0 (B-9801): a holder of groups:manage takes ownership of a group whose owners have all left.
  r.post('/groups/:id/claim-ownership', write, async (req, res) => {
    res.json(await g.claimOwnership(ctx(req), idOf(req)));
  });

  // 1.7.0 (B-9702): a request to join and an invitation may carry a message, screened by the guardrails.
  const message = z.string().trim().max(INVITE_LIMITS.message).nullable().optional();

  r.post('/groups/:id/join', write, async (req, res) => {
    const body = parseBody(z.object({ message }).strict(), req.body ?? {});
    const out = await g.join(ctx(req), idOf(req), { message: body.message });
    res.status('requested' in out ? 202 : 200).json(out);
  });

  r.post('/groups/:id/invites', write, async (req, res) => {
    const body = parseBody(z.object({ userId: id26, role: z.enum(GROUP_ROLES).default('member'), message }).strict(), req.body);
    res.status(201).json(await g.invite(ctx(req), idOf(req), body.userId, body.role, body.message));
  });

  // 1.7.0 (B-9702): invite links. A moderator makes one; its code is in that answer only.
  r.get('/groups/:id/invite-links', read, async (req, res) => {
    res.json(await g.invites.list(ctx(req), idOf(req)));
  });

  r.post('/groups/:id/invite-links', write, async (req, res) => {
    const body = parseBody(z.object({ maxUses: z.number().int().min(1).max(INVITE_LIMITS.maxUses).nullable().optional(), expiresInDays: z.number().int().min(1).max(INVITE_LIMITS.days).optional() }).strict(), req.body ?? {});
    res.status(201).json(await g.invites.create(ctx(req), idOf(req), body));
  });

  r.delete('/groups/:id/invite-links/:linkId', write, async (req, res) => {
    res.json(await g.invites.revoke(ctx(req), idOf(req), idOf(req, 'linkId')));
  });

  // The person with a code: what it leads to, and joining by it. Guesses are slowed per person.
  const codes = new Limiter(s.counters, 'group-invite-code', 20, 60_000);
  const code = z.object({ code: z.string().trim().min(1).max(80) }).strict();
  const slowed = async (req: Request): Promise<void> => {
    const l = await codes.consume(`${principalOf(req).tenantId}:${principalOf(req).userId}`);
    if (!l.allowed) throw tooManyRequests('Too many invite codes tried; wait a minute.', l.resetMs / 1000);
  };

  r.post('/group-invites/lookup', read, async (req, res) => {
    await slowed(req);
    res.json(await g.invites.lookup(principalOf(req), parseBody(code, req.body).code));
  });

  r.post('/group-invites/redeem', write, async (req, res) => {
    await slowed(req);
    res.json(await g.invites.redeem(ctx(req), parseBody(code, req.body).code));
  });

  // 1.7.0 (B-9701): bans and suspensions (moderators; an owner for a moderator).
  r.get('/groups/:id/bans', read, async (req, res) => {
    const q = parseBody(z.object({ state: z.enum(['active', 'all']).optional() }), req.query);
    res.json(await g.bans.list(ctx(req), idOf(req), q.state ?? 'active'));
  });

  r.post('/groups/:id/bans', write, async (req, res) => {
    const body = parseBody(z.object({ userId: id26, kind: z.enum(BAN_KINDS), days: z.number().positive().max(BAN_LIMITS.days).nullable().optional(), reason: z.string().trim().max(BAN_LIMITS.reason).nullable().optional() }).strict(), req.body);
    res.status(201).json(await g.bans.create(ctx(req), idOf(req), body));
  });

  r.delete('/groups/:id/bans/:banId', write, async (req, res) => {
    res.json(await g.bans.lift(ctx(req), idOf(req), idOf(req, 'banId')));
  });

  r.get('/groups/:id/candidates', read, async (req, res) => {
    const q = parseBody(z.object({ q: z.string().trim().max(100).optional() }), req.query);
    res.json(await g.candidates(principalOf(req), idOf(req), q.q || undefined));
  });

  r.get('/groups/:id/requests', read, async (req, res) => {
    const q = parseBody(z.object({ state: z.enum(['pending', 'accepted', 'declined', 'cancelled', 'expired']).optional() }), req.query);
    res.json(await g.requests(principalOf(req), idOf(req), q.state));
  });

  r.get('/groups/:id/posts', read, async (req, res) => {
    const q = parseBody(z.object({ before: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(200).optional() }), req.query);
    res.json(await g.posts(principalOf(req), idOf(req), q));
  });

  r.post('/groups/:id/posts', write, async (req, res) => {
    const body = parseBody(z.object({ body: z.string().trim().min(1).max(10_000) }).strict(), req.body);
    const out = await g.createPost(ctx(req), idOf(req), body.body);
    // 1.7.0 (B-9402): 202 when the guardrail holds the post for review.
    res.status(out.state === 'held' ? 202 : 201).json(out);
  });

  // 1.7.0 (B-9706): the cases about the group's content, for its moderators (the `cases` right), and what they do
  // with them. `:ref` is a flag's id or its reference (F-12).
  const refOf = (req: Request, pattern: RegExp) => parseBody(z.string().regex(pattern, 'a reference'), (req.params as Record<string, string>).ref);
  const flagRefOf = (req: Request) => refOf(req, /^(F-\d{1,12}|[0-9A-HJKMNP-TV-Z]{26})$/i);
  const appealRefOf = (req: Request) => refOf(req, /^(A-\d{1,12}|[0-9A-HJKMNP-TV-Z]{26})$/i);

  r.get('/groups/:id/cases', read, async (req, res) => {
    const q = parseBody(z.object({ state: z.enum(['open', 'confirmed', 'dismissed', 'approved', 'rejected']).optional() }), req.query);
    res.json(await g.caseWork.list(principalOf(req), idOf(req), q.state));
  });

  r.get('/groups/:id/cases/:ref', read, async (req, res) => {
    res.json(await g.caseWork.detail(principalOf(req), idOf(req), flagRefOf(req)));
  });

  r.get('/groups/:id/cases/:ref/moderators', read, async (req, res) => {
    res.json(await g.caseWork.moderators(principalOf(req), idOf(req), flagRefOf(req)));
  });

  r.post('/groups/:id/cases/:ref/act', write, async (req, res) => {
    const body = parseBody(z.object({ action: z.enum(CASE_ACTIONS), note: z.string().trim().max(CASE_LIMITS.note).nullable().optional(), days: z.number().positive().max(BAN_LIMITS.days).nullable().optional() }).strict(), req.body);
    res.json(await g.caseWork.act(ctx(req), idOf(req), flagRefOf(req), body));
  });

  r.post('/groups/:id/cases/:ref/assign', write, async (req, res) => {
    const body = parseBody(z.object({ userId: id26.nullable() }).strict(), req.body);
    res.json(await g.caseWork.assign(ctx(req), idOf(req), flagRefOf(req), body.userId));
  });

  // Appeals of actions taken on the group's content: a moderator who took no part in the decision decides them.
  r.get('/groups/:id/appeals', read, async (req, res) => {
    const q = parseBody(z.object({ state: z.enum(['pending', 'reviewing', 'upheld', 'denied']).optional() }), req.query);
    res.json(await g.caseWork.appeals(principalOf(req), idOf(req), q.state));
  });

  r.get('/groups/:id/appeals/:ref', read, async (req, res) => {
    res.json(await g.caseWork.appeal(principalOf(req), idOf(req), appealRefOf(req)));
  });

  r.post('/groups/:id/appeals/:ref/review', write, async (req, res) => {
    res.json(await g.caseWork.reviewAppeal(ctx(req), idOf(req), appealRefOf(req)));
  });

  r.post('/groups/:id/appeals/:ref/decide', write, async (req, res) => {
    const body = parseBody(z.object({ decision: z.enum(['upheld', 'denied']), note: z.string().trim().max(1000).nullable().optional() }).strict(), req.body);
    res.json(await g.caseWork.decideAppeal(ctx(req), idOf(req), appealRefOf(req), body.decision, body.note ?? null));
  });

  // 1.7.0 (B-9709): the group's linked conversation, whose members follow the group's. Linking is an owner's action.
  r.get('/groups/:id/conversation', read, async (req, res) => {
    res.json(await g.conversations.view(principalOf(req), idOf(req)));
  });

  r.put('/groups/:id/conversation', write, async (req, res) => {
    const body = parseBody(z.object({ conversationId: id26.optional(), label: z.enum(LABELS).optional(), removeOthers: z.boolean().optional() }).strict(), req.body ?? {});
    res.status(201).json(await g.conversations.link(ctx(req), idOf(req), body));
  });

  r.delete('/groups/:id/conversation', write, async (req, res) => {
    res.json(await g.conversations.unlink(ctx(req), idOf(req)));
  });

  // ---------- events ----------

  r.get('/groups/:id/events', read, async (req, res) => {
    const q = parseBody(z.object({ from: isoTime.optional(), to: isoTime.optional(), includeCancelled: z.enum(['true', 'false']).optional() }), req.query);
    const from = timeQuery(q.from, Date.now() - 86_400_000);
    res.json(await cal.list(principalOf(req), idOf(req), { from, to: timeQuery(q.to, from + 366 * 86_400_000), includeCancelled: q.includeCancelled === 'true' }));
  });

  r.post('/groups/:id/events', write, async (req, res) => {
    const body = parseBody(z.object({ ...eventFields, draft: z.boolean().optional() }).strict(), req.body);
    res.status(201).json(await cal.create(ctx(req), idOf(req), body));
  });

  r.get('/calendar/events', read, async (req, res) => {
    const q = parseBody(z.object({ from: isoTime.optional(), to: isoTime.optional(), near: listFilters.near, km: listFilters.km }), req.query);
    const from = timeQuery(q.from, Date.now() - 86_400_000);
    const to = timeQuery(q.to, from + 90 * 86_400_000);
    if (to - from > 400 * 86_400_000) throw badRequest('Ask for at most 400 days at a time.');
    res.json(await cal.mine(principalOf(req), { from, to, near: nearOf(q) }));
  });

  r.get('/calendar/events/:id', read, async (req, res) => {
    res.json(await cal.get(principalOf(req), idOf(req)));
  });

  r.patch('/calendar/events/:id', write, async (req, res) => {
    const body = parseBody(z.object({ ...eventFields, title: name.optional(), start: isoTime.optional(), timeZone: z.string().trim().min(1).max(64).optional() }).strict(), req.body);
    res.json(await cal.update(ctx(req), idOf(req), body));
  });

  r.post('/calendar/events/:id/cancel', write, async (req, res) => {
    const body = parseBody(z.object({ reason: text(500).optional() }).strict(), req.body ?? {});
    res.json(await cal.cancel(ctx(req), idOf(req), body.reason || null));
  });

  // 1.7.0 (B-9707): a draft is published by someone who may edit it.
  r.post('/calendar/events/:id/publish', write, async (req, res) => {
    res.json(await cal.publish(ctx(req), idOf(req)));
  });

  // 1.7.0 (B-9707): an organiser decides an answer that waits for approval.
  r.post('/calendar/events/:id/rsvps/:userId/decide', write, async (req, res) => {
    const body = parseBody(z.object({ decision: z.enum(['approve', 'decline']) }).strict(), req.body);
    res.json(await cal.decideRsvp(ctx(req), idOf(req), idOf(req, 'userId'), body.decision));
  });

  r.post('/calendar/events/:id/rsvp', write, async (req, res) => {
    const body = parseBody(z.object({ response: z.enum(RSVP_RESPONSES), guests: z.number().int().min(0).max(20).optional() }).strict(), req.body);
    res.json(await cal.rsvp(ctx(req), idOf(req), body));
  });

  r.get('/calendar/events/:id/attendees', read, async (req, res) => {
    const q = parseBody(z.object({ ...pageQuery, response: z.enum(RSVP_STATES).optional() }), req.query);
    res.json(await cal.attendees(principalOf(req), idOf(req), q));
  });

  // 1.7.0 (B-9708): "notify attendees", and the notices of an event (changes of time, organisers' messages).
  r.post('/calendar/events/:id/notify', write, async (req, res) => {
    const body = parseBody(z.object({ message: z.string().trim().min(1).max(NOTICE_MAX) }).strict(), req.body);
    res.status(201).json(await cal.notifyAttendees(ctx(req), idOf(req), body.message));
  });

  r.get('/calendar/events/:id/notices', read, async (req, res) => {
    res.json(await cal.notices(principalOf(req), idOf(req)));
  });

  r.post('/calendar/events/:id/check-in', write, async (req, res) => {
    const body = parseBody(z.object({ userId: id26, checkedIn: z.boolean().default(true) }).strict(), req.body);
    res.json(await cal.checkIn(ctx(req), idOf(req), body.userId, body.checkedIn));
  });

  r.get('/calendar/events/:id/reminders', read, async (req, res) => {
    res.json(await cal.reminders(principalOf(req), idOf(req)));
  });

  // ---------- feeds ----------

  r.get('/calendar/feeds', read, async (req, res) => {
    res.json(await cal.feeds(principalOf(req)));
  });

  r.post('/calendar/feeds', write, async (req, res) => {
    const body = parseBody(z.object({ kind: z.enum(FEED_KINDS), targetId: id26.optional() }).strict(), req.body);
    res.status(201).json(await cal.createFeed(ctx(req), body));
  });

  r.delete('/calendar/feeds/:id', write, async (req, res) => {
    res.json(await cal.revokeFeed(ctx(req), idOf(req)));
  });

  return r;
}

/**
 * Signed iCalendar feeds (B-2504), mounted at the root outside `/api`: no session, no cookie; the URL's signature is
 * the credential, so the feed works in calendar programs. Every refusal (bad signature, unknown or revoked feed, an
 * owner no longer entitled) is the same 404, and requests are rate-limited per address (CALENDAR_FEED_PER_MINUTE).
 */
export function calendarPublicRoutes(s: Services): Router {
  const r = Router();
  const limiter = new Limiter(s.counters, 'calendar-feed', s.cfg.CALENDAR_FEED_PER_MINUTE, 60_000);
  const limit: RequestHandler = async (req, _res, next) => {
    const l = await limiter.consume(req.ip ?? 'unknown');
    if (!l.allowed) throw tooManyRequests('Too many calendar feed requests from this address.', l.resetMs / 1000);
    next();
  };
  r.get('/calendar/feeds/:id/:file', limit, async (req, res) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'private, no-store');
    const m = /^([A-Za-z0-9_-]{43})\.ics$/.exec(String(req.params.file));
    const out = m ? await s.calendar.renderFeed(String(req.params.id), m[1]!) : null;
    if (!out) throw notFound('Calendar feed');
    res.setHeader('Content-Disposition', 'inline; filename="calendar.ics"');
    res.type('text/calendar; charset=utf-8').send(out.body);
  });
  return r;
}
