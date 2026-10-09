import { Router } from 'express';
import { identityBody, identityKeyBody } from '../../agents/identity.js';
import { noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import type { Services } from '../../services.js';

/**
 * Agent identities (1.6.0, Sprint 38b, B-7701), under `agents:manage`: the roles, ceiling and keys an agent acts
 * with. Keys are shown once. Agent names may hold spaces: they travel URL-encoded in the path.
 */
export function agentIdentityRoutes(s: Services): Router {
  const r = Router();
  const manage = requirePermission(s, 'agents:manage');
  const name = (v: unknown) => decodeURIComponent(String(v));

  r.get('/agent-identities', noStore, requireAuth(), manage, async (req, res) => {
    const p = principalOf(req);
    res.json((await s.agentIdentities.list(p.tenantId)).map((x) => s.agentIdentities.view(x)));
  });

  r.get('/agent-identities/:name', noStore, requireAuth(), manage, async (req, res) => {
    const p = principalOf(req);
    const x = await s.agentIdentities.get(p.tenantId, name(req.params.name));
    res.json({ agent: name(req.params.name), identity: x ? s.agentIdentities.view(x) : null, keys: await s.agentIdentities.keys(p.tenantId, name(req.params.name)) });
  });

  r.put('/agent-identities/:name', noStore, requireAuth(), manage, async (req, res) => {
    const body = parseBody(identityBody.strict(), req.body);
    res.json(await s.agentIdentities.set(principalOf(req), name(req.params.name), body));
  });

  r.post('/agent-identities/:name/keys', noStore, requireAuth(), manage, async (req, res) => {
    const body = parseBody(identityKeyBody.strict(), req.body);
    res.status(201).json(await s.agentIdentities.createKey(principalOf(req), name(req.params.name), body));
  });

  r.delete('/agent-identities/:name/keys/:kid', noStore, requireAuth(), manage, async (req, res) => {
    await s.agentIdentities.revokeKey(principalOf(req), name(req.params.name), String(req.params.kid));
    res.status(204).end();
  });

  return r;
}
