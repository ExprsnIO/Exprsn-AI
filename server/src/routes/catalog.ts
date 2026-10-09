import { Router } from 'express';
import { z } from 'zod';
import { NOTICE_MODES } from '../discovery/service.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import type { Services } from '../services.js';

const id26 = z.string().length(26);
const entryKey = z.string().trim().regex(/^(workflow|agent|tool|skill):.{1,200}$/, 'An entry key such as workflow:summarise-contract');

/**
 * 1.7.0, Sprint 41d (B-12301 to B-12303): the catalogue of what the caller may use in their current workspace (the
 * workspace form of a conversation's capabilities), composer suggestions ranked by the embedding profile, and each
 * person's choice for publish notices. Dismissing a suggestion is a conversation route (`routes/chat.ts`).
 */
export function catalogRoutes(s: Services): Router {
  const r = Router();
  r.use(['/catalog', '/me/catalog-notices'], noStore, requireAuth());
  const read = requirePermission(s, 'chat:read');
  const write = requirePermission(s, 'chat:write');

  r.get('/catalog', read, async (req, res) => {
    const q = parseBody(z.object({ profile: z.string().trim().min(1).max(63).optional() }), req.query);
    res.json(await s.discovery.catalog(principalOf(req), { profile: q.profile ?? null }));
  });

  r.post('/catalog/suggestions', write, async (req, res) => {
    const b = parseBody(z.object({ draft: z.string().max(4000), profile: z.string().trim().min(1).max(63).nullable().optional(), conversationId: id26.nullable().optional(), dismissed: z.array(entryKey).max(50).default([]) }).strict(), req.body);
    res.json(await s.discovery.suggest(principalOf(req), { draft: b.draft, profile: b.profile ?? null, conversationId: b.conversationId ?? null, dismissed: b.dismissed }));
  });

  r.get('/me/catalog-notices', async (req, res) => {
    res.json(await s.discovery.preferences(principalOf(req)));
  });

  r.put('/me/catalog-notices', async (req, res) => {
    const b = parseBody(z.object({ notices: z.enum(NOTICE_MODES) }).strict(), req.body);
    res.json(await s.discovery.setPreferences(principalOf(req), b.notices, { ip: ip(req), traceId: req.traceId }));
  });

  return r;
}
