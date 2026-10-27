import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../../audit/chain.js';
import { clientSettingsSchema, LIFETIME_BOUNDS, tenantOauthSchema } from '../../federation/client-settings.js';
import { isConfidential } from '../../federation/oidc.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import { conflict, notFound } from '../../http/problem.js';
import { policyWarnings, signinPolicySchema } from '../../identity/signin-policy.js';
import type { Services } from '../../services.js';

/**
 * 1.9.0, Sprint 55: Identity › Sign-in policy.
 *
 * - B-190: the tenant's sign-in policy (passwords, lockout, session lifetimes and step-up, the MFA methods), saved
 *   within the platform's bounds, with the warnings it deserves; "what applies to this person" on the user page.
 * - B-191: the tenant's OAuth defaults and each OIDC client's own settings.
 *
 * Audited `identity.policy.*` and `oidc.client.settings.*`. `identity:manage` for the policy and the OAuth settings;
 * `users:manage` for a person's "what applies".
 */
export function signinPolicyRoutes(s: Services): Router {
  const r = Router();
  r.use(['/signin-policy', '/federation/oidc/clients/:id/settings'], noStore, requireAuth(), requirePermission(s, 'identity:manage'));
  r.use('/users/:id/signin-policy', noStore, requireAuth(), requirePermission(s, 'users:manage'));

  const audit = (req: Request, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, ...(detail ? { detail } : {}), traceId: req.traceId });
  };

  const view = async (tenantId: string) => {
    const pol = s.account.policy;
    const oidc = s.federation.oidc.settings;
    const [stored, effective, available, oauthStored, oauth, oauthAvailable] = await Promise.all([pol.stored(tenantId), pol.effective(tenantId), pol.available(), oidc.tenantStored(tenantId), oidc.tenant(tenantId), oidc.available()]);
    return {
      available,
      policy: stored?.policy ?? null,
      updatedBy: stored?.updatedBy ?? null,
      updatedAt: stored?.updatedAt ?? null,
      effective,
      bounds: pol.bounds(),
      warnings: stored ? policyWarnings(stored.policy) : [],
      oauth: { available: oauthAvailable, stored: oauthStored, effective: oauth, bounds: LIFETIME_BOUNDS }
    };
  };

  // ---------- B-190: the sign-in policy ----------

  r.get('/signin-policy', async (req, res) => {
    res.json(await view(principalOf(req).tenantId));
  });

  r.put('/signin-policy', async (req, res) => {
    const p = principalOf(req);
    const policy = parseBody(signinPolicySchema, req.body);
    const before = (await s.account.policy.stored(p.tenantId))?.policy ?? null;
    const { warnings } = await s.account.policy.save(p.tenantId, policy, p.userId);
    await audit(req, 'identity.policy.updated', { tenant: p.tenantId }, { before, after: policy, ...(warnings.length ? { warnings } : {}) });
    res.json({ ...(await view(p.tenantId)), warnings });
  });

  r.delete('/signin-policy', async (req, res) => {
    const p = principalOf(req);
    const before = (await s.account.policy.stored(p.tenantId))?.policy ?? null;
    const removed = await s.account.policy.reset(p.tenantId);
    if (removed) await audit(req, 'identity.policy.reset', { tenant: p.tenantId }, { before });
    res.json(await view(p.tenantId));
  });

  /** What applies to one person: their effective policy, where each value comes from, their factors and password. */
  r.get('/users/:id/signin-policy', async (req, res) => {
    const p = principalOf(req);
    const out = await s.account.policy.whatApplies(p.tenantId, String(req.params.id));
    if (!out) throw notFound('User');
    res.json(out);
  });

  // ---------- B-191: OAuth defaults and client settings ----------

  r.put('/signin-policy/oauth', async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(tenantOauthSchema, req.body);
    const before = await s.federation.oidc.settings.tenantStored(p.tenantId);
    await s.federation.oidc.settings.saveTenant(p.tenantId, body, p.userId);
    await audit(req, 'oidc.client.settings.defaults_updated', { tenant: p.tenantId }, { before, after: body });
    res.json(await view(p.tenantId));
  });

  const loadClient = async (req: Request) => {
    const c = await s.federation.oidc.getClient(principalOf(req).tenantId, String(req.params.id));
    if (!c) throw notFound('Client');
    return c;
  };

  const clientView = async (req: Request) => {
    const c = await loadClient(req);
    const st = s.federation.oidc.settings;
    const [stored, effective, ended] = await Promise.all([st.clientStored(c), st.effective(c), st.endedFamilies(c.tenant_id, c.client_id)]);
    return { clientId: c.client_id, name: c.name, type: c.type, confidential: isConfidential(c), dynamic: c.dynamic, refreshGrant: c.grants.includes('refresh_token'), stored, effective, bounds: LIFETIME_BOUNDS, reusedFamilies: ended };
  };

  r.get('/federation/oidc/clients/:id/settings', async (req, res) => {
    res.json(await clientView(req));
  });

  const clientBody = clientSettingsSchema.extend({
    accessTtl: z.number().int().min(LIFETIME_BOUNDS.accessTtl.min).max(LIFETIME_BOUNDS.accessTtl.max).optional(),
    refreshTtl: z.number().int().min(LIFETIME_BOUNDS.refreshTtl.min).max(LIFETIME_BOUNDS.refreshTtl.max).optional(),
    pkceRequired: z.boolean().optional()
  });

  r.put('/federation/oidc/clients/:id/settings', async (req, res) => {
    const p = principalOf(req);
    const c = await loadClient(req);
    const body = parseBody(clientBody, req.body);
    const { accessTtl, refreshTtl, pkceRequired, ...settings } = body;
    const st = s.federation.oidc.settings;
    const before = { settings: await st.clientStored(c), accessTtl: c.access_ttl, refreshTtl: c.refresh_ttl, pkceRequired: c.pkce_required };
    if (pkceRequired === false && c.type === 'public') throw conflict('Public clients always require PKCE.');
    await st.saveClient(c, settings, { accessTtl, refreshTtl }, p.userId);
    if (pkceRequired !== undefined) await s.federation.oidc.updateClient(c.tenant_id, c.id, { pkceRequired });
    await audit(req, 'oidc.client.settings.updated', { client: c.client_id, name: c.name }, { before, after: { settings, accessTtl: accessTtl ?? c.access_ttl, refreshTtl: refreshTtl ?? c.refresh_ttl, pkceRequired: pkceRequired ?? c.pkce_required } });
    res.json(await clientView(req));
  });

  return r;
}
