import { AppPolicies } from '../../apps/policies.js';
import { json } from '../../db/knex.js';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom, isUniqueViolation } from '../../audit/chain.js';
import { clears, LABELS } from '../../authz/labels.js';
import { canGrant, canManage, customRolesOf, isRole, ROLES, rolesRequireMfa } from '../../authz/permissions.js';
import { hashPassword } from '../../identity/passwords.js';
import { randomToken } from '../../crypto/index.js';
import { securityAlert } from '../../identity/security-alerts.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import { conflict, forbidden, HttpProblem, notFound } from '../../http/problem.js';
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

  // 1.5.0 (B-3302): the tenant's custom roles in force follow the built-in ones.
  r.get('/roles', requirePermission(s, 'users:manage'), (req, res) => {
    res.json([...ROLES, ...customRolesOf(principalOf(req).tenantId)].map((x) => ({ id: x.id, name: x.name, description: x.description, requiresMfa: x.requiresMfa, permissions: x.permissions, grantableBy: x.grantableBy, builtIn: ROLES.includes(x) })));
  });

  r.get('/users', manage, async (req, res) => {
    const q = parseBody(z.object({ q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) }), req.query);
    const rows = await s.users.list(principalOf(req).tenantId, q);
    const roles = await s.users.roleIdsFor(rows.map((u) => u.id));
    res.json(rows.map((u) => ({ id: u.id, username: u.username, displayName: u.display_name, email: u.email, state: u.state, clearance: u.clearance, roles: roles.get(u.id) ?? [], lastLoginAt: u.last_login_at })));
  });

  r.get('/users/:id', manage, async (req, res) => {
    const p = principalOf(req);
    const u = await s.users.get(p.tenantId, String(req.params.id));
    if (!u) throw notFound('User');
    const [roles, identities, factors, sessions, providers, local] = await Promise.all([s.users.roles(u.id), s.users.identitiesFor(u.id), s.mfa.factors(u.id), s.sessions.listForUser(u.id), s.providers.list(p.tenantId), s.account.localCredential(u.id)]);
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
      attributes: json<Record<string, string>>(u.attributes, {}),
      lastLoginAt: u.last_login_at,
      createdAt: u.created_at,
      roles,
      identities: identities.map((i) => ({ provider: names.get(i.provider_id) ?? i.provider_id, externalId: i.external_id, lastSeenAt: i.last_seen_at })),
      factors: factors.map((f) => ({ id: f.id, kind: f.kind, label: f.label, lastUsedAt: f.last_used_at })),
      sessions: sessions.map((x) => ({ id: x.id, method: x.method, ip: x.ip, lastSeenAt: x.last_seen_at })),
      password: { local: !!local, mustChange: local?.must_change ?? false }
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
        password: z.string().min(1).max(256).optional(),
        /** Instead of a password: email a single-use link to set one (needs an email address and SMTP). */
        invite: z.boolean().default(false),
        /** An admin-set initial password must be changed at first sign-in (B-103). */
        mustChange: z.boolean().default(true),
        roles: z.array(z.string().refine((x) => isRole(x, p.tenantId), 'Unknown role')).min(1),
        clearance: z.enum(LABELS).default('internal')
      })
        .refine((b) => (b.invite ? !b.password : !!b.password), 'Give a password, or set invite with no password.'),
      req.body
    );
    if (body.invite && !body.email) throw conflict('An invitation needs an email address.');
    if (body.invite && !s.notifications.emailEnabled) throw conflict('Email is not configured (SMTP_URL), so an invitation cannot be sent. Set an initial password instead.');
    if (body.password) await s.account.checkNewPassword({ tenantId: p.tenantId, username: body.username, password: body.password, actor: p, ip: ip(req), traceId: req.traceId });
    const denied = body.roles.filter((role) => !canGrant(p.roles, role, p.tenantId));
    if (denied.length) throw forbidden(`Your roles cannot grant ${denied.join(', ')}.`, { step: 'role' });
    if (!clears(p.clearance, body.clearance)) throw forbidden('You cannot grant a clearance above your own.', { step: 'clearance' });
    const local = (await s.providers.list(p.tenantId)).find((x) => x.kind === 'local');
    if (!local) throw conflict('This tenant has no local user store. Add one under Identity first.');
    // An invited account gets a random password nobody knows until the link sets one. Slow on purpose: outside the transaction.
    const passwordHash = await hashPassword(body.password ?? randomToken(32));
    try {
      // One transaction: a failure part-way never leaves a user without a credential, identity or roles.
      const user = await s.db.transaction(async (trx) => {
        const users = s.users.within(trx);
        const u = await users.create(p.tenantId, { username: body.username, displayName: body.displayName, email: body.email, clearance: body.clearance, mfaRequired: rolesRequireMfa(body.roles, p.tenantId) });
        await users.update(p.tenantId, u.id, { clearance_direct: body.clearance });
        // Sprint 26a (B-1802): an address an admin gives is vouched for (an invitation link also proves it).
        if (body.email) await trx('users').where({ id: u.id }).update({ email_verified_at: Date.now() });
        await trx('local_credentials').insert({ user_id: u.id, password_hash: passwordHash, must_change: !body.invite && body.mustChange, updated_at: Date.now() });
        await users.upsertIdentity(u.id, local.id, u.id, []);
        await users.setRoles(u.id, 'direct', body.roles);
        return u;
      });
      await audit(req, 'user.created', { user: user.id, username: user.username }, { roles: body.roles, clearance: body.clearance, store: local.name, invite: body.invite, mustChange: !body.invite && body.mustChange });
      let invited = false;
      if (body.invite) {
        const tenant = await s.tenants.byId(p.tenantId);
        const { token } = await s.account.issueToken({ tenantId: p.tenantId, userId: user.id, kind: 'invite', ttlMs: s.cfg.PASSWORD_INVITE_HOURS * 3600_000, createdBy: p.userId });
        invited = await s.notifications.sendTemplate(body.email, 'invite', { name: user.display_name, username: user.username, actor: p.displayName, tenant: tenant?.name ?? '', hours: s.cfg.PASSWORD_INVITE_HOURS, link: s.account.resetLink(token, p.tenantSlug) });
        await audit(req, 'user.invited', { user: user.id, username: user.username }, { sent: invited, expiresInHours: s.cfg.PASSWORD_INVITE_HOURS });
      }
      res.status(201).json({ id: user.id, username: user.username, ...(body.invite ? { invited } : {}) });
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
        roles: z.array(z.string().refine((x) => isRole(x, p.tenantId), 'Unknown role')).optional(),
        mfaRequired: z.boolean().optional(),
        // 1.6.0 (B-8101): attributes app policies compare records with ($user.attributes.<name>).
        attributes: AppPolicies.attributesSchema.optional()
      }),
      req.body
    );
    if (u.id === p.userId && (body.state !== undefined || body.roles !== undefined || body.clearanceDirect !== undefined)) {
      throw forbidden('You cannot change your own state, roles or clearance. Ask another admin.', { step: 'self' });
    }
    const before = { state: u.state, clearanceDirect: u.clearance_direct, roles: await s.users.roles(u.id), mfaRequired: u.mfa_required };
    if (!canManage(p.roles, before.roles.map((x) => x.role), p.tenantId)) throw forbidden('This user holds roles you cannot grant, so you cannot change them.', { step: 'role' });

    if (body.roles) {
      const current = before.roles.filter((x) => x.source === 'direct').map((x) => x.role);
      const changed = [...body.roles.filter((x) => !current.includes(x)), ...current.filter((x) => !body.roles!.includes(x))];
      const denied = changed.filter((role) => !canGrant(p.roles, role, p.tenantId));
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
    if (body.mfaRequired !== undefined || rolesRequireMfa(roleIds, p.tenantId)) patch.mfa_required = (body.mfaRequired ?? u.mfa_required) || rolesRequireMfa(roleIds, p.tenantId);
    if (body.attributes !== undefined) patch.attributes = Object.keys(body.attributes).length ? JSON.stringify(body.attributes) : null;
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
    if (!canManage(p.roles, await s.users.roleIds(u.id), p.tenantId)) throw forbidden('This user holds roles you cannot grant, so you cannot reset their factors.', { step: 'role' });
    const factors = await s.mfa.factors(u.id, false);
    for (const f of factors) await s.mfa.removeFactor(u.id, f.id);
    await s.db('mfa_recovery_codes').where({ user_id: u.id }).delete();
    const revoked = await s.sessions.revokeAllForUser(u.id);
    await audit(req, 'user.mfa_reset', { user: u.id, username: u.username }, { factorsRemoved: factors.length, sessionsRevoked: revoked });
    await securityAlert(s, { tenantId: p.tenantId, userId: u.id, event: 'factors.reset_by_admin', detail: `${p.displayName} removed ${factors.length} second factor${factors.length === 1 ? '' : 's'} and signed out your sessions.` });
    res.json({ factorsRemoved: factors.length, sessionsRevoked: revoked });
  });

  /**
   * Admin password reset for a local account (B-102): a temporary password the user must change at next sign-in, or
   * a single-use link by email. Either way the old password stops working and every session and OAuth grant ends.
   */
  r.post('/users/:id/password', manage, async (req, res) => {
    const p = principalOf(req);
    const u = await s.users.get(p.tenantId, String(req.params.id));
    if (!u) throw notFound('User');
    if (u.id === p.userId) throw forbidden('Change your own password from Settings.', { step: 'self' });
    if (!canManage(p.roles, await s.users.roleIds(u.id), p.tenantId)) throw forbidden('This user holds roles you cannot grant, so you cannot reset their password.', { step: 'role' });
    // B-804: the account's API keys end too unless the admin unticks it (they are separate credentials).
    const revokeKeys = z.boolean().default(true);
    const body = parseBody(z.discriminatedUnion('mode', [z.object({ mode: z.literal('temporary'), password: z.string().min(1).max(256), revokeApiKeys: revokeKeys }), z.object({ mode: z.literal('link'), revokeApiKeys: revokeKeys })]), req.body);
    if (!(await s.account.localCredential(u.id))) {
      throw new HttpProblem(409, 'Managed by the directory', 'This account signs in through a directory, which keeps its password. Reset it there.');
    }
    if (body.mode === 'link') {
      if (!u.email) throw conflict('This account has no email address. Set a temporary password instead.');
      if (!s.notifications.emailEnabled) throw conflict('Email is not configured (SMTP_URL). Set a temporary password instead.');
      await s.account.scramblePassword(u.id);
    } else {
      await s.account.checkNewPassword({ tenantId: p.tenantId, username: u.username, password: body.password, actor: p, ip: ip(req), traceId: req.traceId });
      await s.account.setPassword(u.id, body.password, true);
    }
    const sessionsRevoked = await s.sessions.revokeAllForUser(u.id);
    const grantsRevoked = await s.account.revokeGrants(p.tenantId, u.id);
    const apiKeysRevoked = body.revokeApiKeys ? await s.apiKeys.revokeAllForUser(u.id) : 0;
    let sent = false;
    if (body.mode === 'link') {
      const { token } = await s.account.issueToken({ tenantId: p.tenantId, userId: u.id, kind: 'admin', ttlMs: s.cfg.PASSWORD_RESET_MINUTES * 60_000, createdBy: p.userId });
      sent = await s.notifications.sendTemplate(u.email, 'password-set', { name: u.display_name, username: u.username, actor: p.displayName, minutes: s.cfg.PASSWORD_RESET_MINUTES, link: s.account.resetLink(token, p.tenantSlug) });
    }
    await audit(req, 'user.password_reset', { user: u.id, username: u.username }, { mode: body.mode, mustChange: body.mode === 'temporary', linkSent: sent, sessionsRevoked, grantsRevoked, apiKeysRevoked });
    const keysNote = apiKeysRevoked ? ` ${apiKeysRevoked} API key${apiKeysRevoked === 1 ? ' was' : 's were'} revoked.` : '';
    await securityAlert(s, { tenantId: p.tenantId, userId: u.id, event: 'password.reset_by_admin', detail: (body.mode === 'link' ? `${p.displayName} reset your password and sent a link to choose a new one.` : `${p.displayName} set a temporary password, which you change at your next sign-in.`) + keysNote });
    res.json({ mode: body.mode, mustChange: body.mode === 'temporary', linkSent: sent, sessionsRevoked, grantsRevoked, apiKeysRevoked });
  });

  // ---------- sessions across the tenant ----------

  r.get('/sessions', manage, async (req, res) => {
    const rows = await s.sessions.listForTenant(principalOf(req).tenantId);
    res.json(rows.map((x) => ({ id: x.id, user: { id: x.user_id, username: x.username, displayName: x.display_name }, method: x.method, stage: x.stage, workspaceId: x.workspace_id ?? null, ip: x.ip, userAgent: x.user_agent, createdAt: x.created_at, lastSeenAt: x.last_seen_at })));
  });

  r.delete('/sessions/:id', manage, async (req, res) => {
    const p = principalOf(req);
    const target = await s.sessions.get(p.tenantId, String(req.params.id));
    if (!target) throw notFound('Session');
    // As for role changes and factor resets: only someone who could grant all of the owner's roles may end their session.
    if (target.user_id !== p.userId && !canManage(p.roles, await s.users.roleIds(target.user_id), p.tenantId)) throw forbidden('This session belongs to someone holding roles you cannot grant, so you cannot end it.', { step: 'role' });
    await s.sessions.revoke(p.tenantId, target.id);
    await s.identityPolicy.forgetSession(target.id); // Sprint 26a (B-1803): and the device trusted from it
    await audit(req, 'session.revoked', { session: target.id, user: target.user_id }, { note: 'Refresh tokens and sockets for this session end with it.' });
    if (target.user_id !== p.userId) await securityAlert(s, { tenantId: p.tenantId, userId: target.user_id, event: 'session.revoked', detail: `${p.displayName} signed out your session (${target.method}).` });
    res.status(204).end();
  });

  return r;
}
