import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { effectivePermissions } from '../authz/policy.js';
import { getRole, PERMISSIONS, rolesRequireMfa, type Permission } from '../authz/permissions.js';
import { apiKeyState } from '../identity/apikeys.js';
import { ip, noStore, parseBody, principalOf, requireAuth, setSessionCookie, workspacesFor } from '../http/middleware.js';
import { toClient as notificationView } from '../platform/notifications.js';
import { badRequest, forbidden, notFound, unauthorized } from '../http/problem.js';
import type { Services } from '../services.js';

export function meRoutes(s: Services): Router {
  const r = Router();
  r.use(noStore);

  const active = requireAuth();
  const browser = requireAuth({ sessionOnly: true });
  // Enrolment endpoints also serve sessions that must set up a factor before anything else.
  const enrolling = requireAuth({ stages: ['active', 'enroll'], sessionOnly: true });

  const audit = (req: Request, action: string, target: Record<string, unknown> = {}) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, traceId: req.traceId });
  };

  r.get('/', active, async (req, res) => {
    const p = principalOf(req);
    const [tenant, workspaces, methods, recovery] = await Promise.all([
      s.tenants.byId(p.tenantId),
      workspacesFor(s, p),
      s.mfa.methods(p.userId),
      s.mfa.remainingRecoveryCodes(p.userId)
    ]);
    res.json({
      user: { id: p.userId, username: p.username, displayName: p.displayName, clearance: p.clearance },
      roles: p.roles.map((id) => ({ id, name: getRole(id)?.name ?? id })),
      permissions: [...effectivePermissions(p)].sort(),
      tenant: tenant ? { id: tenant.id, slug: tenant.slug, name: tenant.name } : null,
      workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, label: w.label_ceiling })),
      workspace: p.workspaceId ?? null,
      credential: p.kind,
      mfa: { verified: p.mfa, methods, recoveryCodesRemaining: recovery }
    });
  });

  // ---------- workspace ----------

  /** Switches the session's current workspace; conversations, knowledge and quotas scope to it. */
  r.put('/workspace', browser, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ workspaceId: z.string().length(26) }), req.body);
    const w = (await workspacesFor(s, p)).find((x) => x.id === body.workspaceId);
    if (!w) throw notFound('Workspace');
    await s.sessions.setWorkspace(p.sessionId as string, w.id);
    res.json({ workspace: w.id });
  });

  // ---------- notifications ----------

  r.get('/notifications', active, async (req, res) => {
    const p = principalOf(req);
    res.json({ items: (await s.notifications.list(p.userId)).map(notificationView), email: s.notifications.emailEnabled });
  });

  r.post('/notifications/read', active, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ ids: z.array(z.string().length(26)).max(500).optional() }), req.body);
    res.json({ read: await s.notifications.markRead(p.userId, body.ids) });
  });

  // ---------- jobs I started ----------

  r.get('/jobs', active, async (req, res) => {
    const p = principalOf(req);
    const rows = await s.jobs.list(p.tenantId, { createdBy: p.userId, limit: 50 });
    res.json(rows.map((j) => ({ id: j.id, type: j.type, state: j.state, progress: j.progress, message: j.message, error: j.error, payload: j.payload, result: j.state === 'succeeded' ? j.result : null, createdAt: j.created_at, finishedAt: j.finished_at })));
  });

  r.post('/jobs/:id/cancel', active, async (req, res) => {
    const p = principalOf(req);
    const j = await s.jobs.get(p.tenantId, String(req.params.id));
    if (!j || j.created_by !== p.userId) throw notFound('Job');
    const after = await s.jobs.cancel(p.tenantId, j.id);
    await audit(req, 'job.cancelled', { job: j.id, type: j.type });
    res.json({ id: j.id, state: after?.state });
  });

  // ---------- sessions ----------

  r.get('/sessions', active, async (req, res) => {
    const p = principalOf(req);
    const rows = await s.sessions.listForUser(p.userId);
    res.json(rows.map((x) => ({ id: x.id, method: x.method, ip: x.ip, userAgent: x.user_agent, stage: x.stage, createdAt: x.created_at, lastSeenAt: x.last_seen_at, current: x.id === p.sessionId })));
  });

  r.delete('/sessions/:id', active, async (req, res) => {
    const p = principalOf(req);
    const target = await s.sessions.get(p.tenantId, String(req.params.id));
    if (!target || target.user_id !== p.userId) throw notFound('Session');
    await s.sessions.revoke(p.tenantId, target.id);
    await audit(req, 'session.revoked', { session: target.id });
    res.status(204).end();
  });

  r.post('/sessions/revoke-others', browser, async (req, res) => {
    const p = principalOf(req);
    const n = await s.sessions.revokeAllForUser(p.userId, p.sessionId ?? undefined);
    await audit(req, 'session.revoked_all', { count: n, keptCurrent: true });
    res.json({ revoked: n });
  });

  // ---------- OAuth grants and consents (Sprint 14, B-107) ----------

  /** The applications (OAuth clients) the user consented to or holds live tokens for. */
  r.get('/grants', active, async (req, res) => {
    const p = principalOf(req);
    res.json(await s.federation.oidc.userGrants(p.tenantId, p.userId));
  });

  /**
   * Revokes the user's grant to one application: its consent, refresh tokens and every access token issued so far
   * stop working at once. The user is notified (a security notice), so a revocation they did not make is visible.
   * A browser session only: an application's own token cannot remove other applications' access.
   */
  r.delete('/grants/:clientId', browser, async (req, res) => {
    const p = principalOf(req);
    const clientId = String(req.params.clientId);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(clientId)) throw notFound('Grant');
    const client = await s.federation.oidc.byClientId(p.tenantId, clientId);
    const mine = (await s.federation.oidc.userGrants(p.tenantId, p.userId)).find((g) => g.clientId === clientId);
    if (!client || !mine) throw notFound('Grant');
    const out = await s.federation.oidc.revokeUserGrant(p.tenantId, p.userId, clientId);
    await audit(req, 'oidc.grant.revoked_by_user', { client: clientId, name: client.name, consents: out.consents, refreshTokens: out.refreshTokens });
    // Sprint 11 adds a security-notification helper; until it merges, the notice goes straight through notify.
    await s.notifications.notify({ tenantId: p.tenantId, userIds: [p.userId], kind: 'security', title: `Access removed for ${client.name}`, body: `${client.name} can no longer act as you. Its tokens stopped working at once. If you did not do this, change your password and review your sessions.`, route: 'settings', email: true });
    res.json({ revoked: true, clientId, ...out });
  });

  // ---------- API keys ----------

  r.get('/api-keys', active, async (req, res) => {
    const rows = await s.apiKeys.listForUser(principalOf(req).userId);
    res.json(rows.map((k) => ({ id: k.id, name: k.name, prefix: `exai_k1_${k.prefix}`, scopes: k.scopes, state: apiKeyState(k), expiresAt: k.expires_at, lastUsedAt: k.last_used_at, createdAt: k.created_at })));
  });

  r.post('/api-keys', browser, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(100),
        scopes: z.array(z.enum(PERMISSIONS)).min(1).max(PERMISSIONS.length),
        ttlDays: z.union([z.literal(30), z.literal(90), z.literal(180), z.literal(365)])
      }),
      req.body
    );
    const held = effectivePermissions(p);
    const extra = body.scopes.filter((sc) => !held.has(sc));
    if (extra.length) throw forbidden(`Scopes never widen a role: you do not hold ${extra.join(', ')}.`, { step: 'scope' });
    const { key, row } = await s.apiKeys.create({ tenantId: p.tenantId, userId: p.userId, name: body.name, scopes: body.scopes as Permission[], ttlDays: body.ttlDays });
    await audit(req, 'apikey.created', { key: row.id, prefix: row.prefix, scopes: row.scopes, expiresAt: row.expires_at });
    res.status(201).json({ id: row.id, key, prefix: `exai_k1_${row.prefix}`, scopes: row.scopes, expiresAt: row.expires_at, notice: 'This is the only time the key is shown.' });
  });

  r.delete('/api-keys/:id', active, async (req, res) => {
    const p = principalOf(req);
    if (!(await s.apiKeys.revoke(p.userId, String(req.params.id)))) throw notFound('API key');
    await audit(req, 'apikey.revoked', { key: req.params.id });
    res.status(204).end();
  });

  // ---------- second factors ----------

  r.get('/mfa', enrolling, async (req, res) => {
    const p = principalOf(req);
    const factors = await s.mfa.factors(p.userId);
    res.json({
      factors: factors.map((f) => ({ id: f.id, kind: f.kind, label: f.label, createdAt: f.created_at, lastUsedAt: f.last_used_at })),
      recoveryCodesRemaining: await s.mfa.remainingRecoveryCodes(p.userId)
    });
  });

  r.post('/mfa/totp', enrolling, async (req, res) => {
    const p = principalOf(req);
    const { label } = parseBody(z.object({ label: z.string().trim().min(1).max(100).default('Authenticator app') }), req.body ?? {});
    const out = await s.mfa.beginTotp(p.userId, p.username, label);
    res.status(201).json({ id: out.id, secret: out.secret, uri: out.uri });
  });

  /** Confirming the first factor of an enrolling session completes sign-in under a new session token. */
  const afterEnrol = async (req: Request, res: Response, kind: string) => {
    const p = principalOf(req);
    await audit(req, 'mfa.enrolled', { kind });
    const codes = (await s.mfa.remainingRecoveryCodes(p.userId)) === 0 ? await s.mfa.regenerateRecoveryCodes(p.userId) : null;
    let stage = req.authSession!.stage;
    if (stage === 'enroll') {
      const { token, session } = await s.sessions.rotate(req.authSession!, { stage: 'active', method: `${req.authSession!.method}, ${kind}`, mfaVerified: true });
      setSessionCookie(res, s, token, session.expires_at);
      stage = session.stage;
      res.status(201).json({ enrolled: true, stage, csrf: s.sessions.csrfFor(session.id), recoveryCodes: codes });
      return;
    }
    res.status(201).json({ enrolled: true, stage, recoveryCodes: codes });
  };

  r.post('/mfa/totp/:id/confirm', enrolling, async (req, res) => {
    const p = principalOf(req);
    const { code } = parseBody(z.object({ code: z.string().trim().regex(/^\d{6}$/) }), req.body);
    if (!(await s.mfa.confirmTotp(p.userId, String(req.params.id), code))) throw badRequest('That code did not match. Check the time on your device and try the next code.');
    await afterEnrol(req, res, 'TOTP');
  });

  r.post('/mfa/webauthn/options', enrolling, async (req, res) => {
    const p = principalOf(req);
    const options = await s.mfa.registrationOptions(p.userId, p.username, p.displayName);
    await s.sessions.setChallenge(req.authSession!.id, options.challenge);
    res.json(options);
  });

  r.post('/mfa/webauthn', enrolling, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ label: z.string().trim().min(1).max(100).default('Passkey'), response: z.looseObject({ id: z.string(), type: z.literal('public-key') }) }), req.body);
    const challenge = await s.sessions.takeChallenge(req.authSession!.id);
    if (!challenge) throw unauthorized('The passkey challenge expired. Try again.');
    const factor = await s.mfa.verifyRegistration(p.userId, challenge, body.response as never, body.label).catch(() => null);
    if (!factor) throw badRequest('The passkey could not be verified.');
    await afterEnrol(req, res, 'passkey');
  });

  r.delete('/mfa/:id', browser, async (req, res) => {
    const p = principalOf(req);
    const factors = await s.mfa.factors(p.userId);
    const user = await s.users.get(p.tenantId, p.userId);
    if (!factors.some((f) => f.id === req.params.id)) throw notFound('Factor');
    // Admin roles need a factor whether they were granted directly or through a group mapping after the account was made.
    if ((user?.mfa_required || rolesRequireMfa(p.roles)) && factors.length <= 1) throw forbidden('Your roles require a second factor. Add another before removing this one.');
    await s.mfa.removeFactor(p.userId, String(req.params.id));
    await audit(req, 'mfa.removed', { factor: req.params.id });
    res.status(204).end();
  });

  r.post('/mfa/recovery-codes', browser, async (req, res) => {
    const p = principalOf(req);
    if (!(await s.mfa.factors(p.userId)).length) throw badRequest('Add a second factor first.');
    const codes = await s.mfa.regenerateRecoveryCodes(p.userId);
    await audit(req, 'mfa.recovery_codes.regenerated');
    res.status(201).json({ recoveryCodes: codes, notice: 'Store these now. Each works once; they replace any earlier codes.' });
  });

  return r;
}
