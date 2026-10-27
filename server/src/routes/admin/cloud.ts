import { Router, type Request } from 'express';
import { z } from 'zod';
import { LABELS } from '../../authz/labels.js';
import { addAccountSchema, patchAccountSchema, type CloudActor } from '../../cloud/accounts.js';
import { PERMISSION_CHECKLIST, REGION_CATALOGUE, RESIDENCY_GEOS } from '../../cloud/catalogue.js';
import { CREDENTIAL_FIELDS, FEATURE_NAMES, FEATURES_BY_PROVIDER, PROVIDER_MODES, PROVIDER_NAMES, PROVIDERS, federationUnavailable } from '../../cloud/types.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission, requireRecentAuth } from '../../http/middleware.js';
import type { Services } from '../../services.js';

/*
 * 1.9.99-final, Sprint 56 (B-10002, B-10007 to B-10009): cloud accounts (`cloud/accounts.ts`, `cloud/validate.ts`).
 * Reads need `cloud:read`; changes, validation and proposal decisions `cloud:admin` (a platform account also
 * `platform:manage`, checked in the service). Approving needs a recent sign-in. Without migration 146 every route but
 * the catalogue answers 503 `migration_pending`.
 *
 *   GET    /admin/cloud/catalogue                       providers, modes, federation, regions, permission checklists
 *   GET    /admin/cloud/accounts                        ?provider=&scope=&state=
 *   POST   /admin/cloud/accounts                        202: a pending account and its proposal
 *   GET    /admin/cloud/accounts/:id
 *   PATCH  /admin/cloud/accounts/:id                    200, or 202 when a change became a proposal
 *   DELETE /admin/cloud/accounts/:id                    202: a removal proposal
 *   POST   /admin/cloud/accounts/:id/validate           identity call and the per-feature permission check
 *   GET    /admin/cloud/proposals                       ?state=&accountId=
 *   POST   /admin/cloud/proposals/:id/approve|reject|withdraw
 *   GET    /admin/cloud/residency                       the tenant's residency geographies
 *   PUT    /admin/cloud/residency                       { geos, reason? } (widening: 202, a proposal)
 */

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
const noteBody = z.object({ note: z.string().trim().max(500).optional() }).strict();
const actorOf = (req: Request): CloudActor => ({ principal: principalOf(req), ip: ip(req), traceId: req.traceId });

export function cloudAdminRoutes(s: Services): Router {
  const r = Router();
  const read = [noStore, requireAuth(), requirePermission(s, 'cloud:read')];
  const admin = [noStore, requireAuth(), requirePermission(s, 'cloud:admin')];
  const fresh = [noStore, requireAuth({ sessionOnly: true }), requirePermission(s, 'cloud:admin'), requireRecentAuth(s)];
  const acc = () => s.cloud.accounts;

  r.get('/cloud/catalogue', ...read, async (_req, res) => {
    res.json({
      installed: await acc().installed(),
      labels: LABELS,
      residencyGeos: RESIDENCY_GEOS,
      providers: PROVIDERS.map((p) => ({
        id: p,
        name: PROVIDER_NAMES[p],
        modes: PROVIDER_MODES[p],
        federation: federationUnavailable(p) ? { available: false, reason: federationUnavailable(p) } : { available: true, reason: null },
        credentialFields: CREDENTIAL_FIELDS[p],
        regions: REGION_CATALOGUE[p],
        features: FEATURES_BY_PROVIDER[p].map((f) => ({ id: f, name: FEATURE_NAMES[f], checklist: PERMISSION_CHECKLIST[p][f] ?? [] }))
      }))
    });
  });

  r.get('/cloud/accounts', ...read, async (req, res) => {
    const q = parseBody(z.object({ provider: z.enum(PROVIDERS).optional(), scope: z.enum(['platform', 'tenant']).optional(), state: z.enum(['pending', 'active', 'attention', 'disabled']).optional() }).strict(), req.query);
    const p = principalOf(req);
    const list = await acc().list(p, q);
    res.json({ accounts: await Promise.all(list.map((a) => acc().view(p, a))), residency: await acc().residency(p.tenantId), platformAdmin: acc().isPlatformAdmin(p) });
  });

  r.post('/cloud/accounts', ...admin, async (req, res) => {
    const body = parseBody(addAccountSchema, req.body);
    const out = await acc().add(actorOf(req), body);
    res.status(202).json({ account: await acc().view(principalOf(req), out.account), proposal: out.proposal });
  });

  r.get('/cloud/accounts/:id', ...read, async (req, res) => {
    const p = principalOf(req);
    res.json(await acc().view(p, await acc().getFor(p, parseBody(id26, req.params.id))));
  });

  r.patch('/cloud/accounts/:id', ...admin, async (req, res) => {
    const body = parseBody(patchAccountSchema, req.body);
    const out = await acc().update(actorOf(req), parseBody(id26, req.params.id), body);
    res.status(out.proposals.length ? 202 : 200).json({ account: await acc().view(principalOf(req), out.account), proposals: out.proposals });
  });

  r.delete('/cloud/accounts/:id', ...admin, async (req, res) => {
    // The reason may come in the body or, for clients that send no body with DELETE, as `?reason=`.
    const reasonOf = z.object({ reason: z.string().trim().max(500).optional() }).strict();
    const body = parseBody(reasonOf, req.body ?? {});
    const query = parseBody(reasonOf, req.query);
    res.status(202).json({ proposal: await acc().remove(actorOf(req), parseBody(id26, req.params.id), body.reason ?? query.reason ?? null) });
  });

  r.post('/cloud/accounts/:id/validate', ...admin, async (req, res) => {
    const out = await s.cloud.validation.validate(actorOf(req), parseBody(id26, req.params.id));
    res.json({ account: await acc().view(principalOf(req), out.account), report: out.report });
  });

  r.get('/cloud/proposals', ...read, async (req, res) => {
    const q = parseBody(z.object({ state: z.enum(['pending', 'approved', 'rejected', 'withdrawn', 'superseded']).optional(), accountId: id26.optional() }).strict(), req.query);
    const p = principalOf(req);
    res.json((await acc().proposals(p, q)).map((x) => ({ ...x, mine: x.proposedBy === p.userId })));
  });

  r.post('/cloud/proposals/:id/approve', ...fresh, async (req, res) => {
    const body = parseBody(noteBody, req.body ?? {});
    const out = await acc().approve(actorOf(req), parseBody(id26, req.params.id), body.note ?? null);
    res.json({ proposal: out.proposal, account: out.account ? await acc().view(principalOf(req), out.account) : null });
  });

  r.post('/cloud/proposals/:id/reject', ...admin, async (req, res) => {
    const body = parseBody(noteBody, req.body ?? {});
    res.json(await acc().reject(actorOf(req), parseBody(id26, req.params.id), body.note ?? null));
  });

  r.post('/cloud/proposals/:id/withdraw', ...admin, async (req, res) => {
    res.json(await acc().withdraw(actorOf(req), parseBody(id26, req.params.id)));
  });

  r.get('/cloud/residency', ...read, async (req, res) => {
    await acc().need();
    res.json({ geos: await acc().residency(principalOf(req).tenantId), options: RESIDENCY_GEOS });
  });

  r.put('/cloud/residency', ...admin, async (req, res) => {
    const body = parseBody(z.object({ geos: z.array(z.enum(RESIDENCY_GEOS)).max(RESIDENCY_GEOS.length), reason: z.string().trim().max(500).optional() }).strict(), req.body);
    const out = await acc().setResidency(actorOf(req), body.geos, body.reason ?? null);
    res.status(out.proposal ? 202 : 200).json(out);
  });

  return r;
}
