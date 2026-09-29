import { Router, type Request } from 'express';
import { z, ZodError } from 'zod';
import { actorFrom } from '../../audit/chain.js';
import { clears, LABELS } from '../../authz/labels.js';
import { canGrant, isRole } from '../../authz/permissions.js';
import { LoginThrottle } from '../../identity/lockout.js';
import { PROVIDER_KINDS, parseProviderConfig, type Step } from '../../identity/providers/types.js';
import { resolveMappings } from '../../repos/users.js';
import type { ProviderRow } from '../../repos/providers.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import { badRequest, conflict, forbidden, notFound, tooManyRequests } from '../../http/problem.js';
import { isUniqueViolation } from '../../audit/chain.js';
import type { Services } from '../../services.js';

const providerView = (p: ProviderRow) => ({
  id: p.id,
  name: p.name,
  kind: p.kind,
  position: p.position,
  enabled: p.enabled,
  config: p.config, // secrets are references (env:/file:), never values
  managedBy: p.managed_by,
  createdAt: p.created_at,
  updatedAt: p.updated_at
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(PROVIDER_KINDS),
  position: z.number().int().min(0).max(10000).default(100),
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({})
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  position: z.number().int().min(0).max(10000).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional()
});

const configProblem = (err: unknown) => {
  if (err instanceof ZodError) return badRequest('The store configuration did not validate.', { errors: err.issues.map((i) => ({ path: ['config', ...i.path].join('.'), message: i.message })) });
  return err;
};

/** User stores (identity providers), group → role mappings, and the "Test a login" tool. */
export function identityAdminRoutes(s: Services): Router {
  const r = Router();
  // Scoped to this router's paths: the /admin mount is shared with other admin routers.
  r.use(['/identity-providers', '/test-login', '/group-mappings'], noStore, requireAuth(), requirePermission(s, 'identity:manage'));

  const audit = (req: Request, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, ...(detail ? { detail } : {}), traceId: req.traceId });
  };

  const load = async (req: Request) => {
    const row = await s.providers.get(principalOf(req).tenantId, String(req.params.id));
    if (!row) throw notFound('User store');
    return row;
  };

  const assertAnotherEnabled = async (tenantId: string, exceptId: string) => {
    const others = (await s.providers.list(tenantId)).filter((p) => p.enabled && p.id !== exceptId);
    if (!others.length) throw conflict('This is the only enabled user store; nobody could sign in without it.');
  };

  r.get('/identity-providers', async (req, res) => {
    res.json((await s.providers.list(principalOf(req).tenantId)).map(providerView));
  });

  r.post('/identity-providers', async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(createSchema, req.body);
    try {
      parseProviderConfig(body.kind, body.config);
      if (body.kind === 'local' && (await s.providers.list(p.tenantId)).some((x) => x.kind === 'local')) throw conflict('A tenant has one local user store.');
      const row = await s.providers.create(p.tenantId, body);
      await audit(req, 'identity.provider.created', { provider: row.id, name: row.name, kind: row.kind }, { config: row.config });
      res.status(201).json(providerView(row));
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('A user store with that name exists.');
      throw configProblem(err);
    }
  });

  r.get('/identity-providers/:id', async (req, res) => {
    res.json(providerView(await load(req)));
  });

  r.patch('/identity-providers/:id', async (req, res) => {
    const p = principalOf(req);
    const current = await load(req);
    const body = parseBody(patchSchema, req.body);
    if (current.managed_by === 'config' && (body.config !== undefined || body.name !== undefined)) throw conflict('This store is managed by the configuration file; change it there.');
    if (body.enabled === false && current.enabled) await assertAnotherEnabled(p.tenantId, current.id);
    try {
      const row = await s.providers.update(p.tenantId, current.id, body);
      await audit(req, 'identity.provider.updated', { provider: current.id, name: current.name }, { before: { position: current.position, enabled: current.enabled, config: current.config }, after: body });
      res.json(providerView(row!));
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('A user store with that name exists.');
      throw configProblem(err);
    }
  });

  r.delete('/identity-providers/:id', async (req, res) => {
    const p = principalOf(req);
    const current = await load(req);
    if (current.managed_by === 'config') throw conflict('This store is managed by the configuration file; remove it there.');
    if (current.enabled) await assertAnotherEnabled(p.tenantId, current.id);
    await s.providers.remove(p.tenantId, current.id);
    await audit(req, 'identity.provider.deleted', { provider: current.id, name: current.name, kind: current.kind });
    res.status(204).end();
  });

  r.post('/identity-providers/:id/test', async (req, res) => {
    const row = await load(req);
    const steps: Step[] = [];
    let ok = false;
    try {
      ok = await s.chain.build(row).test(steps);
    } catch (err) {
      steps.push({ title: 'Configuration', ok: false, detail: (err as Error).message });
    }
    await audit(req, 'identity.provider.tested', { provider: row.id, name: row.name }, { ok });
    res.json({ ok, steps });
  });

  /**
   * Runs the real sign-in chain for a username and password without creating a session or provisioning anyone,
   * and shows which store answered, the groups it returned, and the roles and clearance they map to.
   */
  r.post('/test-login', async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ username: z.string().trim().min(1).max(190), password: z.string().min(1).max(1024) }), req.body);
    const keys = LoginThrottle.keys(p.tenantId, body.username, null);
    const state = await s.throttle.check([keys.account]);
    if (state.locked) throw tooManyRequests('This account is locked after failed attempts.', state.retryAfterSeconds);
    const steps: Step[] = [];
    const result = await s.chain.authenticate(p.tenantId, body.username, body.password, steps);
    let mapping: { roles: string[]; clearance: string | null } | null = null;
    if (result.status === 'ok') {
      mapping = resolveMappings(await s.users.mappings(p.tenantId), result.provider.id, result.user.groups);
      if (!mapping.roles.length) {
        const cfg = parseProviderConfig(result.provider.kind, result.provider.config);
        mapping = { roles: cfg.defaultRoles, clearance: cfg.defaultRoles.length ? cfg.defaultClearance : null };
      }
    } else {
      await s.throttle.fail([keys.account]);
    }
    await audit(req, 'identity.test_login', { username: body.username.toLowerCase() }, { result: result.status, provider: 'provider' in result ? result.provider.name : null });
    res.json({
      result: result.status,
      provider: 'provider' in result ? { id: result.provider.id, name: result.provider.name, kind: result.provider.kind } : null,
      user: result.status === 'ok' ? { externalId: result.user.externalId, username: result.user.username, displayName: result.user.displayName, email: result.user.email, groups: result.user.groups } : null,
      mapping,
      steps,
      errors: result.status === 'not_found' ? result.errors : []
    });
  });

  // ---------- group mappings ----------

  r.get('/group-mappings', async (req, res) => {
    res.json(await s.users.mappings(principalOf(req).tenantId));
  });

  r.post('/group-mappings', async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(
      z.object({
        providerId: z.string().length(26).nullable().default(null),
        group: z.string().trim().min(1).max(512),
        role: z.string().refine(isRole, 'Unknown role'),
        clearance: z.enum(LABELS)
      }),
      req.body
    );
    if (!canGrant(p.roles, body.role)) throw forbidden(`Your roles cannot grant ${body.role}.`, { step: 'role' });
    if (!clears(p.clearance, body.clearance)) throw forbidden('You cannot map a clearance above your own.', { step: 'clearance' });
    if (body.providerId && !(await s.providers.get(p.tenantId, body.providerId))) throw notFound('User store');
    const row = await s.users.addMapping(p.tenantId, body);
    await audit(req, 'identity.mapping.created', { mapping: row.id, group: row.group_name, role: row.role, clearance: row.clearance });
    res.status(201).json(row);
  });

  r.delete('/group-mappings/:id', async (req, res) => {
    const p = principalOf(req);
    const existing = (await s.users.mappings(p.tenantId)).find((m) => m.id === req.params.id);
    if (!existing) throw notFound('Group mapping');
    if (!canGrant(p.roles, existing.role)) throw forbidden(`Your roles cannot change mappings for ${existing.role}.`, { step: 'role' });
    await s.users.removeMapping(p.tenantId, existing.id);
    await audit(req, 'identity.mapping.deleted', { mapping: existing.id, group: existing.group_name, role: existing.role }, { note: 'Takes effect at each user\'s next sign-in.' });
    res.status(204).end();
  });

  return r;
}
