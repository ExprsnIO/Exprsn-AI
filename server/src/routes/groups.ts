import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { LABELS } from '../authz/labels.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { badRequest, notFound, tooManyRequests } from '../http/problem.js';
import { FEED_KINDS, RSVP_RESPONSES } from '../groups/calendar.js';
import { MAX_RADIUS_KM, parseNear } from '../groups/geo.js';
import { GROUP_ROLES, JOIN_MODES, VISIBILITIES, type Ctx } from '../groups/service.js';
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
  lon: lon.optional()
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
  r.use(['/groups', '/group-requests', '/group-posts', '/group-categories', '/calendar'], noStore, requireAuth());
  const read = requirePermission(s, 'groups:read');
  const write = requirePermission(s, 'groups:write');
  const g = s.groups;
  const cal = s.calendar;
  const ctx = (req: Request): Ctx => ({ p: principalOf(req), ip: ip(req), traceId: req.traceId ?? null });
  const idOf = (req: Request, key = 'id') => parseBody(id26, (req.params as Record<string, string>)[key]);

  // ---------- groups ----------

  r.get('/groups', read, async (req, res) => {
    const q = parseBody(z.object({ ...listFilters, mine: z.enum(['true', 'false']).optional() }), req.query);
    res.json(await g.list(principalOf(req), { workspaceId: q.workspace ?? null, mine: q.mine === 'true', category: q.category ?? null, near: nearOf(q) }));
  });

  r.post('/groups', write, async (req, res) => {
    const body = parseBody(z.object({ workspaceId: id26.optional(), name, description: text(5000).nullable().optional(), visibility: z.enum(VISIBILITIES).optional(), joinMode: z.enum(JOIN_MODES).optional(), label: z.enum(LABELS).optional(), categoryId: id26.nullable().optional(), location: location.optional() }).strict(), req.body);
    res.status(201).json(await g.create(ctx(req), body));
  });

  // 1.6.0 (B-4402): groups the caller may join, ranked by shared members and activity; never above their clearance.
  r.get('/groups/discover', read, async (req, res) => {
    const q = parseBody(z.object({ ...listFilters, limit: z.coerce.number().int().min(1).max(200).optional() }), req.query);
    res.json(await g.depth.discover(principalOf(req), { workspaceId: q.workspace ?? null, category: q.category ?? null, near: nearOf(q), limit: q.limit }));
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
    const body = parseBody(z.object({ name: name.optional(), description: text(5000).nullable().optional(), visibility: z.enum(VISIBILITIES).optional(), joinMode: z.enum(JOIN_MODES).optional(), label: z.enum(LABELS).optional(), categoryId: id26.nullable().optional(), location: location.optional() }).strict(), req.body);
    res.json(await g.update(ctx(req), idOf(req), body));
  });

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
    res.json(await g.members(principalOf(req), idOf(req)));
  });

  r.patch('/groups/:id/members/:userId', write, async (req, res) => {
    const body = parseBody(z.object({ role: z.enum(GROUP_ROLES) }).strict(), req.body);
    res.json(await g.setRole(ctx(req), idOf(req), idOf(req, 'userId'), body.role));
  });

  r.delete('/groups/:id/members/:userId', write, async (req, res) => {
    res.json(await g.removeMember(ctx(req), idOf(req), idOf(req, 'userId')));
  });

  r.post('/groups/:id/join', write, async (req, res) => {
    const out = await g.join(ctx(req), idOf(req));
    res.status('requested' in out ? 202 : 200).json(out);
  });

  r.post('/groups/:id/invites', write, async (req, res) => {
    const body = parseBody(z.object({ userId: id26, role: z.enum(GROUP_ROLES).default('member') }).strict(), req.body);
    res.status(201).json(await g.invite(ctx(req), idOf(req), body.userId, body.role));
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
    res.status(201).json(await g.createPost(ctx(req), idOf(req), body.body));
  });

  r.get('/groups/:id/cases', read, async (req, res) => {
    const q = parseBody(z.object({ state: z.enum(['open', 'confirmed', 'dismissed', 'approved', 'rejected']).optional() }), req.query);
    res.json(await g.cases(principalOf(req), idOf(req), q.state));
  });

  // ---------- events ----------

  r.get('/groups/:id/events', read, async (req, res) => {
    const q = parseBody(z.object({ from: isoTime.optional(), to: isoTime.optional(), includeCancelled: z.enum(['true', 'false']).optional() }), req.query);
    const from = timeQuery(q.from, Date.now() - 86_400_000);
    res.json(await cal.list(principalOf(req), idOf(req), { from, to: timeQuery(q.to, from + 366 * 86_400_000), includeCancelled: q.includeCancelled === 'true' }));
  });

  r.post('/groups/:id/events', write, async (req, res) => {
    const body = parseBody(z.object(eventFields).strict(), req.body);
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

  r.post('/calendar/events/:id/rsvp', write, async (req, res) => {
    const body = parseBody(z.object({ response: z.enum(RSVP_RESPONSES), guests: z.number().int().min(0).max(20).optional() }).strict(), req.body);
    res.json(await cal.rsvp(ctx(req), idOf(req), body));
  });

  r.get('/calendar/events/:id/attendees', read, async (req, res) => {
    res.json(await cal.attendees(principalOf(req), idOf(req)));
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
