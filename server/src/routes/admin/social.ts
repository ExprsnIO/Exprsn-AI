import { Router, type Request } from 'express';
import { z } from 'zod';
import { LABELS } from '../../authz/labels.js';
import { JOIN_MODES, VISIBILITIES } from '../../groups/service.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission, requireRecentAuth } from '../../http/middleware.js';
import { FEED_APPROVERS, GROUP_CREATORS, MEDIA_MAX_BYTES, WORKSPACE_CONTACT_RULES, type Ctx } from '../../social/admin.js';
import type { Services } from '../../services.js';

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
const profileName = z.string().trim().min(1).max(63).nullable();

/**
 * Social and messaging (1.6.0, B-4206): the administrator's policies and health views for the feed, groups, messaging
 * and relations of every workspace they may act in (`social:manage`, decision Q4; the moderation-facing feed
 * policies also need moderation:manage, checked in `SocialAdmin.setPolicy`), legal-hold exports of a conversation
 * under dual control (requested with social:manage, decided by a second platform admin, decision Q5), and the
 * realtime counts of this instance (`platform:manage`). Every route answers `Cache-Control: no-store`.
 */
export function socialAdminRoutes(s: Services): Router {
  const r = Router();
  r.use('/social', noStore, requireAuth());
  const manage = requirePermission(s, 'social:manage');
  const platform = requirePermission(s, 'platform:manage');
  const recent = [requireAuth({ sessionOnly: true }), requireRecentAuth(s)];
  const a = s.socialAdmin;
  const ctx = (req: Request): Ctx => ({ p: principalOf(req), ip: ip(req), traceId: req.traceId ?? null });
  const idOf = (req: Request, key = 'id') => parseBody(id26, (req.params as Record<string, string>)[key]);

  // ---------- policies and settings ----------

  r.put('/social/policies/:id', manage, async (req, res) => {
    const body = parseBody(
      z
        .object({
          feedGuard: z.boolean().optional(),
          feedApprover: z.enum(FEED_APPROVERS).optional(),
          feedMedia: z.boolean().optional(),
          feedMediaMaxBytes: z.number().int().min(1024).max(MEDIA_MAX_BYTES).nullable().optional(),
          groupCreate: z.enum(GROUP_CREATORS).optional(),
          groupVisibility: z.enum(VISIBILITIES).optional(),
          groupJoin: z.enum(JOIN_MODES).optional(),
          eventCapacity: z.number().int().min(1).max(100_000).nullable().optional(),
          contactRule: z.enum(WORKSPACE_CONTACT_RULES).optional()
        })
        .strict(),
      req.body
    );
    res.json(await a.setPolicy(ctx(req), idOf(req), body));
  });

  r.put('/social/settings', manage, async (req, res) => {
    const body = parseBody(
      z
        .object({
          digestProfile: profileName.optional(),
          digestDay: z.number().int().min(0).max(6).nullable().optional(),
          digestHour: z.number().int().min(0).max(23).nullable().optional(),
          digestTop: z.number().int().min(1).max(50).nullable().optional(),
          digestMaxLabel: z.enum(LABELS).nullable().optional(),
          summaryProfile: profileName.optional()
        })
        .strict(),
      req.body
    );
    res.json(await a.setTenantSettings(ctx(req), body));
  });

  // ---------- feed ----------

  r.get('/social/feed', manage, async (req, res) => {
    res.json(await a.feed(principalOf(req)));
  });

  r.post('/social/trending/exclusions', manage, async (req, res) => {
    const body = parseBody(z.object({ tag: z.string().trim().min(1).max(65) }).strict(), req.body);
    res.status(201).json(await a.exclude(ctx(req), body.tag));
  });

  r.delete('/social/trending/exclusions/:tag', manage, async (req, res) => {
    const tag = parseBody(z.string().trim().min(1).max(65), String(req.params.tag ?? ''));
    res.json(await a.include(ctx(req), tag));
  });

  r.post('/social/trending/run', manage, async (req, res) => {
    res.status(202).json(await a.runTrending(ctx(req)));
  });

  r.post('/social/digest/test', manage, async (req, res) => {
    res.status(202).json(await a.testDigest(ctx(req)));
  });

  // ---------- groups and events ----------

  r.get('/social/groups', manage, async (req, res) => {
    res.json(await a.groups(principalOf(req)));
  });

  r.get('/social/groups/:id/members', manage, async (req, res) => {
    res.json(await a.groupMembers(principalOf(req), idOf(req)));
  });

  r.post('/social/groups/:id/transfer', manage, async (req, res) => {
    const body = parseBody(z.object({ userId: id26 }).strict(), req.body);
    res.json(await s.groups.transferOwnership(ctx(req), idOf(req), body.userId));
  });

  r.post('/social/groups/:id/archive', manage, async (req, res) => {
    res.json(await s.groups.archive(ctx(req), idOf(req)));
  });

  r.post('/social/calendar-feeds/:id/revoke', manage, async (req, res) => {
    res.json(await s.calendar.revokeFeed(ctx(req), idOf(req), { admin: true }));
  });

  // ---------- messaging ----------

  r.get('/social/messaging', manage, async (req, res) => {
    res.json(await a.messaging(principalOf(req)));
  });

  r.get('/social/conversations', manage, async (req, res) => {
    const q = parseBody(z.object({ q: z.string().trim().max(100).optional() }), req.query);
    res.json(await a.conversations(principalOf(req), q.q));
  });

  r.post('/social/exports', manage, ...recent, async (req, res) => {
    const body = parseBody(z.object({ conversationId: id26, reason: z.string().trim().min(10).max(2000), approverId: id26 }).strict(), req.body);
    res.status(201).json(await a.requestExport(ctx(req), body));
  });

  r.post('/social/exports/:id/approve', platform, ...recent, async (req, res) => {
    const body = parseBody(z.object({ note: z.string().trim().max(500).nullable().optional() }).strict(), req.body ?? {});
    res.json(await a.decideExport(ctx(req), idOf(req), 'approved', body.note ?? null));
  });

  r.post('/social/exports/:id/reject', platform, async (req, res) => {
    const body = parseBody(z.object({ note: z.string().trim().max(500).nullable().optional() }).strict(), req.body ?? {});
    res.json(await a.decideExport(ctx(req), idOf(req), 'rejected', body.note ?? null));
  });

  r.post('/social/exports/:id/withdraw', manage, async (req, res) => {
    res.json(await a.withdrawExport(ctx(req), idOf(req)));
  });

  r.get('/social/exports/:id/download', manage, async (req, res) => {
    const out = await a.download(ctx(req), idOf(req));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${out.file.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(out.csv);
  });

  // ---------- realtime (platform) ----------

  r.get('/social/realtime', platform, (_req, res) => {
    res.json(a.realtime());
  });

  r.get('/social/people', platform, async (req, res) => {
    const q = parseBody(z.object({ q: z.string().trim().max(100).optional() }), req.query);
    res.json(await a.people(principalOf(req), q.q));
  });

  r.post('/social/realtime/close', platform, async (req, res) => {
    const body = parseBody(z.object({ userId: id26 }).strict(), req.body);
    res.json(await a.closeRooms(ctx(req), body.userId));
  });

  // ---------- relations ----------

  r.get('/social/relations', manage, async (req, res) => {
    res.json(await a.relations(principalOf(req)));
  });

  return r;
}
