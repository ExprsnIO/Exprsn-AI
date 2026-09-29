import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom, isUniqueViolation } from '../../audit/chain.js';
import { clears, LABELS } from '../../authz/labels.js';
import { canGrant, canManage, isRole, ROLES, rolesRequireMfa } from '../../authz/permissions.js';
import { checkPasswordPolicy, hashPassword } from '../../identity/passwords.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import { badRequest, conflict, forbidden, notFound } from '../../http/problem.js';
import type { Services } from '../../services.js';

/** Users, their direct roles and clearance, local accounts, and every session in the tenant. */
export function userAdminRoutes(s: Services): Router {
  const r = Router();
  r.use(['/roles', '/users', '/sessions'], noStore, requireAuth());

  const manage = requirePermission(s, 'users:manage');

  const audit = (req: Request, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, ...(detail ? { detail } : {}), traceId: req.traceId });
  };

  r.get('/roles', requirePermission(s, 'users:manage'), (_req, res) => {
    res.json(ROLES.map((x) => ({ id: x.id, name: x.name, description: x.description, requiresMfa: x.requiresMfa, permissions: x.permissions, grantableBy: x.grantableBy })));
  });

  r.get('/users', manage, async (req, res) => {
    const q = parseBody(z.object({ q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) }), req.query);
    const rows = await s.users.list(principalOf(req).tenantId, q);
    const out = await Promise.all(
      rows.map(async (u) => ({ id: u.id, username: u.username, displayName: u.display_name, email: u.email, state: u.state, clearance: u.clearance, roles: await s.users.roleIds(u.id), lastLoginAt: u.last_login_at }))
    );
    res.json(out);
  });

  r.get('/users/:id', manage, async (req, res) => {
    const p = principalOf(req);
    const u = await s.users.get(p.tenantId, String(req.params.id));
    if (!u) throw notFound('User');
    const [roles, identities, factors, sessions, providers] = await Promise.all([s.users.roles(u.id), s.users.identitiesFor(u.id), s.mfa.factors(u.id), s.sessions.listForUser(u.id), s.providers.list(p.tenantId)]);
    const names = new Map(providers.map((x) => [x.id, x.name]));
    res.json({
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      email: u.email,
      state: u.state,
      disabledReason: u.disabled_reason,
      clearance: u.clearance,
      clearanceDirect: u.clearance_direct,
      mfaRequired: u.mfa_required,
      lastLoginAt: u.last_login_at,
      createdAt: u.created_at,
      roles,
      identities: identities.map((i) => ({ provider: names.get(i.provider_id) ?? i.provider_id, externalId: i.external_id, lastSeenAt: i.last_seen_at })),
      factors: factors.map((f) => ({ id: f.id, kind: f.kind, label: f.label, lastUsedAt: f.last_used_at })),
      sessions: sessions.map((x) => ({ id: x.id, method: x.method, ip: x.ip, lastSeenAt: x.last_seen_at }))
    });
  });

  /** Creates an account in the tenant's local user store (bootstrap and break-glass accounts). */
  r.post('/users', manage, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(
      z.object({
        username: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._@-]{0,189}$/),
        displayName: z.string().trim().min(1).max(200),
        email: z.email().nullable().default(null),
        password: z.string().min(1).max(256),
        roles: z.array(z.string().refine(isRole, 'Unknown role')).min(1),
        clearance: z.enum(LABELS).default('internal')
      }),
      req.body
    );
    const policy = checkPasswordPolicy(body.password, body.username);
    if (!policy.ok) throw badRequest(policy.reason!);
    const denied = body.roles.filter((role) => !canGrant(p.roles, role));
    if (denied.length) throw forbidden(`Your roles cannot grant ${denied.join(', ')}.`, { step: 'role' });
    if (!clears(p.clearance, body.clearance)) throw forbidden('You cannot grant a clearance above your own.', { step: 'clearance' });
    const local = (await s.providers.list(p.tenantId)).find((x) => x.kind === 'local');
    if (!local) throw conflict('This tenant has no local user store. Add one under Identity first.');
    try {
      const user = await s.users.create(p.tenantId, { username: body.username, displayName: body.displayName, email: body.email, clearance: body.clearance, mfaRequired: rolesRequireMfa(body.roles) });
      await s.users.update(p.tenantId, user.id, { clearance_direct: body.clearance });
      await s.db('local_credentials').insert({ user_id: user.id, password_hash: await hashPassword(body.password), updated_at: Date.now() });
      await s.users.upsertIdentity(user.id, local.id, user.id, []);
      await s.users.setRoles(user.id, 'direct', body.roles);
      await audit(req, 'user.created', { user: user.id, username: user.username }, { roles: body.roles, clearance: body.clearance, store: local.name });
      res.status(201).json({ id: user.id, username: user.username });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('A user with that username exists.');
      throw err;
    }
  });

  r.patch('/users/:id', manage, async (req, res) => {
    const p = principalOf(req);
    const u = await s.users.get(p.tenantId, String(req.params.id));
    if (!u) throw notFound('User');
    const body = parseBody(
      z.object({
        state: z.enum(['active', 'disabled']).optional(),
        disabledReason: z.string().trim().max(200).optional(),
        clearanceDirect: z.enum(LABELS).nullable().optional(),
        roles: z.array(z.string().refine(isRole, 'Unknown role')).optional(),
        mfaRequired: z.boolean().optional()
      }),
      req.body
    );
    if (u.id === p.userId && (body.state !== undefined || body.roles !== undefined || body.clearanceDirect !== undefined)) {
      throw forbidden('You cannot change your own state, roles or clearance. Ask another admin.', { step: 'self' });
    }
    const before = { state: u.state, clearanceDirect: u.clearance_direct, roles: await s.users.roles(u.id), mfaRequired: u.mfa_required };
    if (!canManage(p.roles, before.roles.map((x) => x.role))) throw forbidden('This user holds roles you cannot grant, so you cannot change them.', { step: 'role' });

    if (body.roles) {
      const current = before.roles.filter((x) => x.source === 'direct').map((x) => x.role);
      const changed = [...body.roles.filter((x) => !current.includes(x)), ...current.filter((x) => !body.roles!.includes(x))];
      const denied = changed.filter((role) => !canGrant(p.roles, role));
      if (denied.length) throw forbidden(`Your roles cannot grant or remove ${denied.join(', ')}.`, { step: 'role' });
      await s.users.setRoles(u.id, 'direct', body.roles);
    }
    // Only a clearance at or below your own can be granted.
    if (body.clearanceDirect && !clears(p.clearance, body.clearanceDirect)) {
      throw forbidden('You cannot grant a clearance above your own.', { step: 'clearance' });
    }
    const patch: Parameters<typeof s.users.update>[2] = {};
    if (body.state) {
      patch.state = body.state;
      patch.disabled_reason = body.state === 'disabled' ? (body.disabledReason ?? 'Disabled by an admin') : null;
    }
    if (body.clearanceDirect !== undefined) {
      patch.clearance_direct = body.clearanceDirect;
      // Effective clearance (highest of mapped and direct) is recomputed at the next sign-in. Until then, API keys
      // use the direct value, so a lowered clearance applies at once.
      if (body.clearanceDirect) patch.clearance = body.clearanceDirect;
    }
    const roleIds = await s.users.roleIds(u.id);
    if (body.mfaRequired !== undefined || rolesRequireMfa(roleIds)) patch.mfa_required = (body.mfaRequired ?? u.mfa_required) || rolesRequireMfa(roleIds);
    await s.users.update(p.tenantId, u.id, patch);

    let revoked = 0;
    if (body.state === 'disabled' || body.roles || body.clearanceDirect !== undefined) {
      // Access changes take effect immediately: end sessions so the next request re-reads roles and clearance.
      revoked = await s.sessions.revokeAllForUser(u.id);
      if (body.state === 'disabled') await s.apiKeys.revokeAllForUser(u.id);
    }
    await audit(req, body.state === 'disabled' ? 'user.disabled' : 'user.updated', { user: u.id, username: u.username }, { before, after: body, sessionsRevoked: revoked });
    res.json({ ok: true, sessionsRevoked: revoked });
  });

  r.post('/users/:id/reset-mfa', manage, async (req, res) => {
    const p = principalOf(req);
    const u = await s.users.get(p.tenantId, String(req.params.id));
    if (!u) throw notFound('User');
    if (u.id === p.userId) throw forbidden('Reset your own factors from Settings.', { step: 'self' });
    if (!canManage(p.roles, await s.users.roleIds(u.id))) throw forbidden('This user holds roles you cannot grant, so you cannot reset their factors.', { step: 'role' });
    const factors = await s.mfa.factors(u.id, false);
    for (const f of factors) await s.mfa.removeFactor(u.id, f.id);
    await s.db('mfa_recovery_codes').where({ user_id: u.id }).delete();
    const revoked = await s.sessions.revokeAllForUser(u.id);
    await audit(req, 'user.mfa_reset', { user: u.id, username: u.username }, { factorsRemoved: factors.length, sessionsRevoked: revoked });
    res.json({ factorsRemoved: factors.length, sessionsRevoked: revoked });
  });

  // ---------- sessions across the tenant ----------

  r.get('/sessions', manage, async (req, res) => {
    const rows = await s.sessions.listForTenant(principalOf(req).tenantId);
    res.json(rows.map((x) => ({ id: x.id, user: { id: x.user_id, username: x.username, displayName: x.display_name }, method: x.method, stage: x.stage, ip: x.ip, userAgent: x.user_agent, createdAt: x.created_at, lastSeenAt: x.last_seen_at })));
  });

  r.delete('/sessions/:id', manage, async (req, res) => {
    const p = principalOf(req);
    const target = await s.sessions.get(p.tenantId, String(req.params.id));
    if (!target) throw notFound('Session');
    await s.sessions.revoke(p.tenantId, target.id);
    await audit(req, 'session.revoked', { session: target.id, user: target.user_id }, { note: 'Refresh tokens and sockets for this session end with it.' });
    res.status(204).end();
  });

  return r;
}
