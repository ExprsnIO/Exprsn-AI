import { Router, type Request } from 'express';
import { z } from 'zod';
import { LABELS } from '../authz/labels.js';
import { effectivePermissions } from '../authz/policy.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import type { Services } from '../services.js';
import { APIKEY_NAME } from '../vault/apikey-leases.js';
import { VAULT_REF } from '../vault/policy.js';

/*
 * Dynamic API-key leases (1.7.0, Sprint 41, B-9301 and B-9302). Providers and their roles are managed by holders of
 * `secrets:admin`. Leases are taken by holders of `secrets:read` whose vault policy grants `read` on
 * `apikey/<provider>/<role>`; the key is in the issue response only. Holders renew and revoke their own leases;
 * `secrets:admin` reaches every lease of the tenant.
 */

const name = z.string().regex(APIKEY_NAME, 'Lower-case letters, digits, dot, dash and underscore').refine((n) => n !== '.' && n !== '..');
const ttl = z.number().int().min(1).max(366 * 86_400);
const vaultRef = z.string().max(600).regex(VAULT_REF, 'A vault reference: vault:path#key');
const endpoint = z.string().trim().min(8).max(300);
const leaseId = z.string().length(26);
const scopes = z.array(z.string().trim().min(1).max(100)).min(1).max(100);
const config = z.record(z.string(), z.unknown());

export function vaultApiKeyRoutes(s: Services): Router {
  const r = Router();
  r.use('/vault/apikey', noStore, requireAuth());
  const admin = requirePermission(s, 'secrets:admin');
  const read = requirePermission(s, 'secrets:read');
  const L = s.apiKeyLeases;
  const ctx = (req: Request) => ({ ip: ip(req), traceId: req.traceId });
  const param = (req: Request, key: string) => parseBody(name, String((req.params as Record<string, string>)[key]));

  // ---- providers and roles (secrets:admin) ----

  r.get('/vault/apikey/providers', admin, async (req, res) => {
    res.json(await L.listProviders(principalOf(req)));
  });

  r.post('/vault/apikey/providers', admin, async (req, res) => {
    const b = parseBody(z.object({ name, kind: z.string().trim().min(1).max(40), endpoint: endpoint.optional(), label: z.enum(LABELS).optional(), config, credentialRef: vaultRef }).strict(), req.body);
    res.status(201).json(await L.registerProvider(principalOf(req), b, ctx(req)));
  });

  r.patch('/vault/apikey/providers/:provider', admin, async (req, res) => {
    const b = parseBody(z.object({ endpoint: endpoint.optional(), label: z.enum(LABELS).optional(), config: config.optional(), credentialRef: vaultRef.optional(), state: z.enum(['active', 'disabled']).optional() }).strict(), req.body);
    res.json(await L.updateProvider(principalOf(req), param(req, 'provider'), b, ctx(req)));
  });

  r.delete('/vault/apikey/providers/:provider', admin, async (req, res) => {
    await L.removeProvider(principalOf(req), param(req, 'provider'), ctx(req));
    res.status(204).end();
  });

  r.put('/vault/apikey/providers/:provider/roles/:role', admin, async (req, res) => {
    const b = parseBody(z.object({ scopes, config: config.optional(), ttlSeconds: ttl.nullable().optional(), maxTtlSeconds: ttl.nullable().optional() }).strict(), req.body);
    res.json(await L.putRole(principalOf(req), param(req, 'provider'), param(req, 'role'), b, ctx(req)));
  });

  r.delete('/vault/apikey/providers/:provider/roles/:role', admin, async (req, res) => {
    await L.removeRole(principalOf(req), param(req, 'provider'), param(req, 'role'), ctx(req));
    res.status(204).end();
  });

  // ---- leases (secrets:read and the vault policy) ----

  r.get('/vault/apikey/roles', read, async (req, res) => {
    res.json({ roles: await L.issuableRoles(principalOf(req)) });
  });

  /** Reads the credential path: a fresh key under a new lease. The key is in this answer only. */
  r.post('/vault/apikey/creds/:provider/:role', read, async (req, res) => {
    const p = principalOf(req);
    const b = parseBody(z.object({ ttlSeconds: ttl.optional() }).strict(), req.body ?? {});
    const c = await s.vault.callerFor(p, ctx(req));
    res.status(201).json(await L.issue(c, param(req, 'provider'), param(req, 'role'), { ttlSeconds: b.ttlSeconds, within: effectivePermissions(p), agentId: p.agent?.id ?? null }));
  });

  r.get('/vault/apikey/leases', read, async (req, res) => {
    const q = parseBody(z.object({ all: z.enum(['0', '1', 'true', 'false']).optional(), provider: name.optional(), state: z.enum(['active', 'revoking', 'revoked', 'expired']).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).strict(), req.query);
    res.json({ leases: await L.listLeases(principalOf(req), { all: q.all === '1' || q.all === 'true', ...(q.provider ? { provider: q.provider } : {}), ...(q.state ? { state: q.state } : {}), ...(q.limit ? { limit: q.limit } : {}) }) });
  });

  r.get('/vault/apikey/leases/:id', read, async (req, res) => {
    res.json(await L.getLease(principalOf(req), parseBody(leaseId, String(req.params.id))));
  });

  r.post('/vault/apikey/leases/:id/renew', read, async (req, res) => {
    res.json(await L.renew(principalOf(req), parseBody(leaseId, String(req.params.id)), ctx(req)));
  });

  r.post('/vault/apikey/leases/:id/revoke', read, async (req, res) => {
    res.json(await L.revoke(principalOf(req), parseBody(leaseId, String(req.params.id)), ctx(req)));
  });

  return r;
}
