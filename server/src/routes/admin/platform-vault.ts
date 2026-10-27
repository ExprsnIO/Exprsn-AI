import { Router, type Request } from 'express';
import { z } from 'zod';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission, requireRecentAuth } from '../../http/middleware.js';
import { badRequest } from '../../http/problem.js';
import type { Services } from '../../services.js';
import { CAPABILITIES, SYS_SCOPE } from '../../vault/policy.js';
import { SIGNING_DOMAINS } from '../../vault/signing-keys.js';

/*
 * 1.7.0 (B-9201, B-9205): the vault's platform scope, for holders of `platform:manage`.
 *
 *   GET    /admin/platform/vault/keys                the named keys: their service, versions and what they key
 *   POST   /admin/platform/vault/keys/:name/rotate   a new version (with a recent sign-in)
 *   POST   /admin/platform/vault/keys/:name/retire   refuse what was issued under versions below `minVersion`
 *   GET    /admin/platform/vault/policies            the scope's grants (their subjects are services)
 *   POST   /admin/platform/vault/policies            a grant, allow or deny, on a `sys/` path to a service
 *   DELETE /admin/platform/vault/policies/:id
 *   GET    /admin/platform/vault/explain             the decision for a service on a `sys/` path
 *   GET    /admin/platform/vault/signing-keys        (B-9207) the platform's own signing keys registered with the vault
 *   POST   /admin/platform/vault/signing-keys/register   registers those not registered yet (nothing moves or rotates)
 *   DELETE /admin/platform/vault/signing-keys/:id    removes a registration (the key stays)
 *
 * No key material is returned by any of them. A tenant's own vault routes (`/vault/...`) never reach this scope.
 */

const keyName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const service = z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/);
const capability = z.enum(CAPABILITIES);

export function platformVaultRoutes(s: Services): Router {
  const r = Router();
  const platform = requirePermission(s, 'platform:manage');
  r.use('/platform/vault', noStore, requireAuth());
  const ctx = (req: Request) => ({ ip: ip(req), traceId: req.traceId });

  r.get('/platform/vault/keys', platform, async (_req, res) => {
    res.json({ scope: 'sys', status: s.sysKeys.status, keys: await s.sysKeys.list() });
  });

  r.post('/platform/vault/keys/:name/rotate', platform, requireRecentAuth(s), async (req, res) => {
    parseBody(z.object({}).strict(), req.body ?? {});
    res.json(await s.sysKeys.rotate(principalOf(req), keyName.parse(String(req.params.name)), ctx(req)));
  });

  r.post('/platform/vault/keys/:name/retire', platform, requireRecentAuth(s), async (req, res) => {
    const b = parseBody(z.object({ minVersion: z.number().int().min(1).max(1_000_000) }).strict(), req.body);
    res.json(await s.sysKeys.retire(principalOf(req), keyName.parse(String(req.params.name)), b.minVersion, ctx(req)));
  });

  // 1.7.0 (B-9207): the platform's own signing keys (the root CA and issuers of no tenant, the ACME account key).
  r.get('/platform/vault/signing-keys', platform, async (req, res) => {
    res.json({ scope: 'sys', ...(await s.signingKeys.list(principalOf(req), SYS_SCOPE, ctx(req))) });
  });

  r.post('/platform/vault/signing-keys/register', platform, requireRecentAuth(s), async (req, res) => {
    const b = parseBody(z.object({ domains: z.array(z.enum(SIGNING_DOMAINS)).max(SIGNING_DOMAINS.length).optional() }).strict(), req.body ?? {});
    res.json(await s.signingKeys.register(principalOf(req), SYS_SCOPE, b.domains ? { domains: b.domains } : {}, ctx(req)));
  });

  r.delete('/platform/vault/signing-keys/:id', platform, requireRecentAuth(s), async (req, res) => {
    await s.signingKeys.unregister(principalOf(req), SYS_SCOPE, z.string().length(26).parse(String(req.params.id)), ctx(req));
    res.status(204).end();
  });

  r.get('/platform/vault/policies', platform, async (_req, res) => {
    res.json({ policies: await s.vault.listGrants(SYS_SCOPE) });
  });

  r.post('/platform/vault/policies', platform, requireRecentAuth(s), async (req, res) => {
    const b = parseBody(
      z.object({ service, path: z.string().trim().min(1).max(400), capabilities: z.array(z.union([capability, z.literal('*')])).min(1).max(CAPABILITIES.length + 1), effect: z.enum(['allow', 'deny']).default('allow'), description: z.string().trim().max(500).nullable().optional() }).strict(),
      req.body
    );
    const g = await s.vault.createGrant(s.vault.rootCaller(principalOf(req), ctx(req)), { subjectKind: 'service', subject: b.service, path: b.path, capabilities: b.capabilities, effect: b.effect, description: b.description ?? null });
    await s.sysKeys.policiesChanged();
    res.status(201).json(g);
  });

  r.delete('/platform/vault/policies/:id', platform, requireRecentAuth(s), async (req, res) => {
    await s.vault.deleteGrant(s.vault.rootCaller(principalOf(req), ctx(req)), String(req.params.id));
    await s.sysKeys.policiesChanged();
    res.status(204).end();
  });

  r.get('/platform/vault/explain', platform, async (req, res) => {
    const q = parseBody(z.object({ service, path: z.string().trim().min(1).max(400), capability }).strict(), req.query);
    if (!q.path.startsWith('sys')) throw badRequest('Explain a platform path such as sys/transit/session.');
    res.json(await s.vault.explain(SYS_SCOPE, { userId: null, groups: [], workspaces: [], apiKeyId: null, service: q.service }, q.path, q.capability));
  });

  return r;
}
