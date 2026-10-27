import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { LABELS } from '../authz/labels.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { sandboxHeaders } from '../media/origin.js';
import { CHOSEN, MAX_WATCH } from '../profiles/presence.js';
import { PROFILE_LIMITS, type Ctx } from '../profiles/service.js';
import type { Services } from '../services.js';

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');

/**
 * Profiles and presence (1.5.0, Sprint 34c, B-5801 and B-5802). Reading someone's profile or presence needs
 * `social:read`, changing one's own `social:write` (an avatar also `files:write`: it is stored in the file store).
 * Who sees what is decided in `ProfileService.view` and `PresenceService.visibleAmong`: people who share a workspace,
 * narrowed by the profile's label and workspaces; nothing of either for someone in a block.
 */
export function peopleRoutes(s: Services): Router {
  const r = Router();
  r.use(['/people', '/presence'], noStore, requireAuth());
  const read = requirePermission(s, 'social:read');
  const write = requirePermission(s, 'social:write');
  const ctx = (req: Request): Ctx => ({ p: principalOf(req), ip: ip(req), traceId: req.traceId ?? null });
  const declared = (req: Request): number | null => {
    const n = Number(req.header('content-length') ?? NaN);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  // ---------- one's own profile ----------

  r.get('/people/me', read, async (req, res) => {
    res.json(await s.people.own(principalOf(req)));
  });

  r.patch('/people/me', write, async (req, res) => {
    const body = parseBody(
      z
        .object({
          pronouns: z.string().max(PROFILE_LIMITS.pronouns).nullable().optional(),
          bio: z.string().max(PROFILE_LIMITS.bio).nullable().optional(),
          label: z.enum(LABELS).optional(),
          workspaces: z.array(id26).max(100).nullable().optional()
        })
        .strict(),
      req.body
    );
    res.json(await s.people.update(ctx(req), body));
  });

  // The raw image is the body (PNG, JPEG, WebP or GIF, at most 2 MiB); it goes into the file store's quarantine.
  r.put('/people/me/avatar', write, async (req, res) => {
    res.status(202).json(await s.people.setAvatar(ctx(req), { declaredType: req.header('content-type') ?? null, declaredBytes: declared(req) }, req));
  });

  r.delete('/people/me/avatar', write, async (req, res) => {
    res.json(await s.people.removeAvatar(ctx(req)));
  });

  // ---------- someone's profile ----------

  r.get('/people/:id', read, async (req, res) => {
    res.json(await s.people.view(principalOf(req), parseBody(id26, req.params.id)));
  });

  r.get('/people/:id/avatar', read, async (req, res) => {
    const got = await s.people.avatar(principalOf(req), parseBody(id26, req.params.id));
    sandboxHeaders(res);
    res.setHeader('Content-Type', got.type);
    res.setHeader('Content-Length', String(got.size));
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, no-store');
    await pipeline(Readable.from(got.stream), res);
  });

  // ---------- presence ----------

  r.get('/presence', read, async (req, res) => {
    const q = parseBody(z.object({ ids: z.string().max(MAX_WATCH * 27) }), req.query);
    const ids = parseBody(z.array(id26).min(1).max(MAX_WATCH), q.ids.split(',').filter(Boolean));
    res.json({ statuses: await s.presence.statuses(principalOf(req), ids) });
  });

  r.get('/presence/me', read, async (req, res) => {
    res.json(await s.presence.mine(principalOf(req)));
  });

  r.put('/presence/me', write, async (req, res) => {
    const body = parseBody(z.object({ status: z.enum(CHOSEN) }).strict(), req.body);
    res.json(await s.presence.setStatus(ctx(req), body.status));
  });

  return r;
}
