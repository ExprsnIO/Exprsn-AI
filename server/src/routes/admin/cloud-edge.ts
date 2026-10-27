import { Router, type Request } from 'express';
import { z } from 'zod';
import type { CloudActor } from '../../cloud/accounts.js';
import { accessSchema, edgeCreateSchema } from '../../cloud/edge.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission, requireRecentAuth } from '../../http/middleware.js';
import { ACCESS_EXCLUSIONS } from '../../http/cloudflare-access.js';
import { CLOUDFLARE_IP_RANGES } from '../../http/cloudflare-ips.js';
import type { Services } from '../../services.js';

/*
 * 1.9.99-final, Sprint 61 (B-10901 to B-10904): the Cloudflare front door (`cloud/edge.ts`). Reads need `cloud:read`;
 * applying `cloud:deploy` with a recent sign-in; creating a front door and setting up Access `cloud:admin` with a
 * recent sign-in. No route ever answers the tunnel token (only its vault reference) or an identity provider's secret.
 * Without migration 161 every route answers 503 `migration_pending` (the ranges answer without it).
 *
 *   GET  /admin/cloud/edge                          front doors, the shipped ranges' date, the Access exclusions
 *   POST /admin/cloud/edge                          { name, accountId, deploymentId?, hostname, zone, plan?, origin, waf? } → 201
 *   GET  /admin/cloud/edge/ranges?accountId=        Cloudflare's ranges as shipped (and, with an account, as published now)
 *   GET  /admin/cloud/edge/:id                      the front door with its WAF render
 *   POST /admin/cloud/edge/:id/apply                DNS, edge TLS (Full strict), the tunnel, the WAF → the steps
 *   PUT  /admin/cloud/edge/:id/access               { scope, teamDomain, idp, allowedEmails?, allowedDomains? } → the audience tag
 *   GET  /admin/cloud/edge/:id/install/:target      helm | systemd | compose: what runs cloudflared beside the app
 */

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
const actorOf = (req: Request): CloudActor => ({ principal: principalOf(req), ip: ip(req), traceId: req.traceId });

export function cloudEdgeRoutes(s: Services): Router {
  const r = Router();
  const read = [noStore, requireAuth(), requirePermission(s, 'cloud:read')];
  const freshDeploy = [noStore, requireAuth({ sessionOnly: true }), requirePermission(s, 'cloud:deploy'), requireRecentAuth(s)];
  const freshAdmin = [noStore, requireAuth({ sessionOnly: true }), requirePermission(s, 'cloud:admin'), requireRecentAuth(s)];
  const edge = () => s.cloud.edge;

  r.get('/cloud/edge', ...read, async (req, res) => {
    res.json({ edges: await edge().list(principalOf(req)), ranges: { asOf: CLOUDFLARE_IP_RANGES.asOf, source: CLOUDFLARE_IP_RANGES.source }, accessExclusions: ACCESS_EXCLUSIONS });
  });

  r.post('/cloud/edge', ...freshAdmin, async (req, res) => {
    res.status(201).json({ edge: await edge().create(actorOf(req), parseBody(edgeCreateSchema, req.body ?? {})) });
  });

  r.get('/cloud/edge/ranges', ...read, async (req, res) => {
    const q = parseBody(z.object({ accountId: id26.optional() }).strict(), req.query);
    res.json(await edge().ranges(principalOf(req), q.accountId));
  });

  r.get('/cloud/edge/:id', ...read, async (req, res) => {
    res.json(await edge().render(parseBody(id26, req.params.id)));
  });

  r.post('/cloud/edge/:id/apply', ...freshDeploy, async (req, res) => {
    res.json({ edge: await edge().apply(actorOf(req), parseBody(id26, req.params.id)) });
  });

  r.put('/cloud/edge/:id/access', ...freshAdmin, async (req, res) => {
    const out = await edge().configureAccess(actorOf(req), parseBody(id26, req.params.id), parseBody(accessSchema, req.body ?? {}));
    res.json({ edge: out, aud: out.accessAud, settings: { CLOUDFLARE_ACCESS_TEAM_DOMAIN: out.access?.teamDomain ?? null, CLOUDFLARE_ACCESS_SCOPE: out.access?.scope ?? null } });
  });

  r.get('/cloud/edge/:id/install/:target', ...read, async (req, res) => {
    const target = parseBody(z.enum(['helm', 'systemd', 'compose']), req.params.target);
    res.json(await edge().installFor(parseBody(id26, req.params.id), target));
  });

  return r;
}
