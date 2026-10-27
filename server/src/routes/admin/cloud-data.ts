import { Router, type Request } from 'express';
import { z } from 'zod';
import type { CloudActor } from '../../cloud/accounts.js';
import { connectSchema, discoverQuery } from '../../cloud/discovery.js';
import { isUniqueViolation } from '../../audit/chain.js';
import { conflict } from '../../http/problem.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import type { Services } from '../../services.js';

/*
 * 1.9.99-final, Sprint 59 (B-10306): managed databases and stores of a cloud account as data connections
 * (`cloud/discovery.ts`). Every route needs both `cloud:read` (the account) and `connections:manage` (the
 * connection); the account must be one the caller may see. Without migration 156 discovery answers from the
 * providers without a cache, and connect answers 503 `migration_pending`.
 *
 *   GET  /admin/cloud/accounts/:id/discover      ?region=&kind=&refresh=1   the instances, with their endpoints and auth options
 *   POST /admin/cloud/accounts/:id/connect       { providerId | deploymentId + resourceKey, name, auth, ... } → 201
 *   GET  /admin/cloud/accounts/:id/connections   the tenant's connections made from the account
 */

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
const actorOf = (req: Request): CloudActor => ({ principal: principalOf(req), ip: ip(req), traceId: req.traceId });

export function cloudDataRoutes(s: Services): Router {
  const r = Router();
  const both = [noStore, requireAuth(), requirePermission(s, 'cloud:read'), requirePermission(s, 'connections:manage')];

  r.get('/cloud/accounts/:id/discover', ...both, async (req, res) => {
    const q = parseBody(discoverQuery, req.query);
    const out = await s.cloud.discovery.discover(actorOf(req), parseBody(id26, req.params.id), { ...(q.region ? { region: q.region } : {}), ...(q.kind ? { kind: q.kind } : {}), refresh: q.refresh === '1' });
    res.json(out);
  });

  r.post('/cloud/accounts/:id/connect', ...both, async (req, res) => {
    const body = parseBody(connectSchema, req.body);
    try {
      res.status(201).json(await s.cloud.discovery.connect(actorOf(req), parseBody(id26, req.params.id), body));
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('A connection with that name exists.');
      throw err;
    }
  });

  r.get('/cloud/accounts/:id/connections', ...both, async (req, res) => {
    const p = principalOf(req);
    const account = await s.cloud.accounts.getFor(p, parseBody(id26, req.params.id));
    res.json({ links: (await s.cloud.discovery.links(p.tenantId)).filter((l) => l.accountId === account.id) });
  });

  return r;
}
