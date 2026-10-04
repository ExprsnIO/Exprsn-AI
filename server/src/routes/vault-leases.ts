import { Router, type Request } from 'express';
import { z } from 'zod';
import { LABELS } from '../authz/labels.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import type { Services } from '../services.js';
import { DIALECTS, PRIVILEGES, ROLE_NAME, SCHEMA_NAME } from '../vault/db-engines.js';
import { VAULT_REF } from '../vault/policy.js';

/*
 * Database leases (Sprint 25, B-1704). Engines and their roles are managed by holders of `connections:manage` (the
 * admin login reaches a database, so it sits with the data connections), in a zone whose ceiling covers the engine's
 * label. Leases are taken by holders of `secrets:read` whose vault policy grants `read` on `database/<engine>/<role>`;
 * the password is in the issue response only. Holders renew and revoke their own leases; `connections:manage` or
 * `secrets:admin` reach every lease.
 */

const engineName = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'Lower-case letters, digits, dot, dash and underscore').refine((n) => n !== '.' && n !== '..');
const endpoint = z.string().trim().min(3).max(300).regex(/^[A-Za-z0-9.:[\]_-]+$/, 'host:port');
const dbName = z.string().trim().regex(SCHEMA_NAME, 'Letters, digits, _, $ and -, starting with a letter or _');
const ttl = z.number().int().min(1).max(366 * 86_400);
const vaultRef = z.string().max(600).regex(VAULT_REF, 'A vault reference: vault:path#key');
const leaseId = z.string().length(26);

export function vaultLeaseRoutes(s: Services): Router {
  const r = Router();
  r.use('/vault/database', noStore, requireAuth());
  const manage = requirePermission(s, 'connections:manage');
  const read = requirePermission(s, 'secrets:read');
  const L = s.dbLeases;
  const ctx = (req: Request) => ({ ip: ip(req), traceId: req.traceId });
  const name = (req: Request, key = 'name') => parseBody(engineName, String((req.params as Record<string, string>)[key]));

  // ---- engines and roles (connections:manage) ----

  r.get('/vault/database/engines', manage, async (req, res) => {
    res.json({ engines: await L.listEngines(principalOf(req)) });
  });

  r.post('/vault/database/engines', manage, async (req, res) => {
    const b = parseBody(
      z
        .object({
          name: engineName,
          dialect: z.enum(DIALECTS),
          endpoint,
          database: dbName.nullable().default(null),
          tls: z.boolean().default(false),
          zone: z.string().trim().regex(/^[a-z0-9-]{1,63}$/).default('data'),
          label: z.enum(LABELS).default('internal'),
          adminUsername: z.string().trim().min(1).max(200),
          adminPassword: z.string().min(1).max(1000).nullable().optional(),
          adminPasswordRef: vaultRef.nullable().optional(),
          userHost: z.string().trim().regex(/^[A-Za-z0-9.%_:-]{1,100}$/).default('%'),
          defaultTtlSeconds: ttl.default(s.cfg.VAULT_LEASE_DEFAULT_TTL_SECONDS),
          maxTtlSeconds: ttl.default(s.cfg.VAULT_LEASE_MAX_TTL_SECONDS),
          check: z.boolean().default(true)
        })
        .strict(),
      req.body
    );
    res.status(201).json(await L.registerEngine(principalOf(req), b, ctx(req)));
  });

  r.get('/vault/database/engines/:name', manage, async (req, res) => {
    res.json(await L.getEngine(principalOf(req), name(req)));
  });

  r.patch('/vault/database/engines/:name', manage, async (req, res) => {
    const b = parseBody(
      z
        .object({
          endpoint: endpoint.optional(),
          database: dbName.nullable().optional(),
          tls: z.boolean().optional(),
          zone: z.string().trim().regex(/^[a-z0-9-]{1,63}$/).optional(),
          label: z.enum(LABELS).optional(),
          adminUsername: z.string().trim().min(1).max(200).optional(),
          adminPassword: z.string().min(1).max(1000).optional(),
          adminPasswordRef: vaultRef.optional(),
          userHost: z.string().trim().regex(/^[A-Za-z0-9.%_:-]{1,100}$/).optional(),
          defaultTtlSeconds: ttl.optional(),
          maxTtlSeconds: ttl.optional(),
          state: z.enum(['active', 'disabled']).optional()
        })
        .strict(),
      req.body
    );
    res.json(await L.updateEngine(principalOf(req), name(req), b, ctx(req)));
  });

  r.delete('/vault/database/engines/:name', manage, async (req, res) => {
    await L.removeEngine(principalOf(req), name(req), ctx(req));
    res.status(204).end();
  });

  r.post('/vault/database/engines/:name/test', manage, async (req, res) => {
    res.json(await L.testEngine(principalOf(req), name(req), ctx(req)));
  });

  r.put('/vault/database/engines/:name/roles/:role', manage, async (req, res) => {
    const role = parseBody(z.string().regex(ROLE_NAME, 'Lower-case letters, digits and _, starting with a letter, at most 32'), String(req.params.role));
    const b = parseBody(z.object({ privileges: z.enum(PRIVILEGES), schemas: z.array(dbName).min(1).max(50).optional(), defaultTtlSeconds: ttl.nullable().optional(), maxTtlSeconds: ttl.nullable().optional() }).strict(), req.body);
    res.json(await L.putRole(principalOf(req), name(req), role, b, ctx(req)));
  });

  r.delete('/vault/database/engines/:name/roles/:role', manage, async (req, res) => {
    await L.removeRole(principalOf(req), name(req), parseBody(z.string().regex(ROLE_NAME), String(req.params.role)), ctx(req));
    res.status(204).end();
  });

  /** Runs the expiry sweeper for this tenant now (it also runs every VAULT_LEASE_SWEEP_SECONDS). */
  r.post('/vault/database/sweep', manage, async (req, res) => {
    const p = principalOf(req);
    const job = await s.jobs.enqueue({ tenantId: p.tenantId, createdBy: p.userId, type: 'vault.leases.sweep', payload: { tenantId: p.tenantId } });
    res.status(202).json({ jobId: job.id });
  });

  // ---- leases (secrets:read and the vault policy) ----

  r.get('/vault/database/roles', read, async (req, res) => {
    res.json({ roles: await L.issuableRoles(principalOf(req)) });
  });

  r.post('/vault/database/creds/:engine/:role', read, async (req, res) => {
    const role = parseBody(z.string().regex(ROLE_NAME), String(req.params.role));
    const b = parseBody(z.object({ ttlSeconds: ttl.optional() }).strict(), req.body ?? {});
    res.status(201).json(await L.issue(principalOf(req), name(req, 'engine'), role, b, ctx(req)));
  });

  r.get('/vault/database/leases', read, async (req, res) => {
    const q = parseBody(z.object({ all: z.enum(['0', '1', 'true', 'false']).optional(), engine: engineName.optional(), state: z.enum(['active', 'revoking', 'revoked', 'expired']).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).strict(), req.query);
    res.json({ leases: await L.listLeases(principalOf(req), { all: q.all === '1' || q.all === 'true', ...(q.engine ? { engine: q.engine } : {}), ...(q.state ? { state: q.state } : {}), ...(q.limit ? { limit: q.limit } : {}) }) });
  });

  r.get('/vault/database/leases/:id', read, async (req, res) => {
    res.json(await L.getLease(principalOf(req), parseBody(leaseId, String(req.params.id))));
  });

  r.post('/vault/database/leases/:id/renew', read, async (req, res) => {
    const b = parseBody(z.object({ incrementSeconds: ttl.optional() }).strict(), req.body ?? {});
    res.json(await L.renew(principalOf(req), parseBody(leaseId, String(req.params.id)), b.incrementSeconds, ctx(req)));
  });

  r.post('/vault/database/leases/:id/revoke', read, async (req, res) => {
    res.json(await L.revoke(principalOf(req), parseBody(leaseId, String(req.params.id)), ctx(req)));
  });

  return r;
}
