import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { effectivePermissions } from '../authz/policy.js';
import { getRole, PERMISSIONS, rolesRequireMfa, type Permission } from '../authz/permissions.js';
import { apiKeyState } from '../identity/apikeys.js';
import { ed25519PublicKey } from '../crypto/httpsig.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requireRecentAuth, setSessionCookie, workspacesFor } from '../http/middleware.js';
import { AccountService } from '../identity/account.js';
import { LoginThrottle } from '../identity/lockout.js';
import { admitSend, emailCodeTtlMs, maskAddress, requireEmail, sendCode } from '../identity/email-otp.js';
import { securityAlert, type SecurityAlertInput } from '../identity/security-alerts.js';
import { toClient as notificationView } from '../platform/notifications.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound, tooManyRequests, unauthorized } from '../http/problem.js';
import { setFedCookie } from './federation-public.js';
import type { Services } from '../services.js';

/** Sprint 20 (B-1203): an Ed25519 public key (JWK x or PEM) as its JWK x value, or a 400. */
function signatureKeyX(text: string): string {
  try {
    return String(ed25519PublicKey(text).export({ format: 'jwk' }).x);
  } catch (err) {
    throw badRequest(`signatureKey: ${(err as Error).message}`);
  }
}

export function meRoutes(s: Services): Router {
  const r = Router();
  r.use(noStore);

  const active = requireAuth();
  const browser = requireAuth({ sessionOnly: true });
  // Enrolment endpoints also serve sessions that must set up a factor before anything else.
  const enrolling = requireAuth({ stages: ['active', 'enroll'], sessionOnly: true });
  // The password change also serves sessions that must change an admin-set password before anything else.
  const changing = requireAuth({ stages: ['active', 'password'], sessionOnly: true });
  // Sensitive account changes need a recent password or factor check (B-106).
  const recent = requireRecentAuth(s);

  const alert = (req: Request, event: SecurityAlertInput['event'], detail?: string) => {
    const p = principalOf(req);
    return securityAlert(s, { tenantId: p.tenantId, userId: p.userId, event, ...(detail ? { detail } : {}), ip: ip(req) });
  };

  /** Counts a password or factor attempt against the account's lockout; returns the keys to settle afterwards. */
  const reserveAttempt = async (req: Request) => {
    const p = principalOf(req);
    const keys = LoginThrottle.keys(p.tenantId, p.username, ip(req));
    const list = [keys.account, ...(keys.ip ? [keys.ip] : [])];
    const state = await s.throttle.reserve(list);
    if (state.locked) throw tooManyRequests(`Too many failed attempts. Try again in ${Math.ceil(state.retryAfterSeconds / 60)} minutes.`, state.retryAfterSeconds);
    return {
      failed: async (action: string, detail: Record<string, unknown>) => {
        const after = await s.throttle.failed(list);
        await audit(req, action, {}, { ...detail, attemptsRemaining: after.remaining }, 'auth');
        if (after.locked) throw tooManyRequests(`Too many failed attempts. Try again in ${Math.ceil(after.retryAfterSeconds / 60)} minutes.`, after.retryAfterSeconds);
        return after.remaining;
      },
      ok: async () => {
        await s.throttle.succeed(keys.account);
        if (keys.ip) await s.throttle.release([keys.ip]);
      }
    };
  };

  const audit = (req: Request, action: string, target: Record<string, unknown> = {}, detail?: Record<string, unknown>, kind: 'admin' | 'auth' = 'admin') => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind, actor: actorFrom(p, ip(req)), target, ...(detail ? { detail } : {}), traceId: req.traceId });
  };

  r.get('/', active, async (req, res) => {
    const p = principalOf(req);
    const [tenant, workspaces, methods, recovery, preferences, home, row, verifiedAt] = await Promise.all([
      s.tenants.byId(p.tenantId),
      workspacesFor(s, p),
      s.mfa.methods(p.userId),
      s.mfa.remainingRecoveryCodes(p.userId),
      s.account.preferences(p.userId),
      s.account.passwordHome(p.tenantId, p.userId),
      s.users.get(p.tenantId, p.userId),
      s.signup.emailVerifiedAt(p.userId)
    ]);
    const passwordStepUp = home.kind === 'local' || home.stores.some((x) => x.kind === 'ldap' || x.kind === 'sql');
    // B-803: a session from an upstream OIDC or SAML provider can step up by signing in there again.
    const upstream = await upstreamOf(req);
    res.json({
      // Sprint 30d (B-3413): the address and whether it is proven, for Settings' verification link (B-1802).
      user: { id: p.userId, username: p.username, displayName: p.displayName, clearance: p.clearance, email: row?.email ?? null, emailVerified: verifiedAt != null },
      roles: p.roles.map((id) => ({ id, name: getRole(id, p.tenantId)?.name ?? id })),
      permissions: [...effectivePermissions(p)].sort(),
      tenant: tenant ? { id: tenant.id, slug: tenant.slug, name: tenant.name } : null,
      workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, label: w.label_ceiling })),
      workspace: p.workspaceId ?? null,
      credential: p.kind,
      mfa: { verified: p.mfa, methods, recoveryCodesRemaining: recovery },
      preferences,
      password: home.kind === 'local' ? { managedHere: true, mustChange: home.mustChange } : { managedHere: false, stores: home.stores.map((x) => x.name) },
      stepUp: {
        windowSeconds: s.cfg.STEPUP_WINDOW_SECONDS,
        authAt: req.authSession ? AccountService.authTime(req.authSession) : null,
        methods: [...(passwordStepUp ? ['password'] : []), ...methods.filter((m) => m !== 'recovery'), ...(upstream ? ['upstream'] : [])],
        upstream: upstream ? { name: upstream.name, protocol: upstream.kind } : null
      }
    });
  });

  // ---------- preferences (B-501) ----------

  /** Appearance preferences follow the user to every browser. */
  r.patch('/preferences', active, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ a11y: z.enum(['system', 'aa', 'aaa']) }), req.body);
    const before = await s.account.preferences(p.userId);
    const after = await s.account.setPreferences(p.tenantId, p.userId, body);
    await audit(req, 'user.preferences.updated', { user: p.userId }, { before, after });
    res.json(after);
  });

  // ---------- password (B-101, B-103) ----------

  /**
   * Changes the local password: the current one (a wrong one counts toward the lockout), the policy and the breached
   * check, never the current password again. Ends every other session and OAuth grant. A session in the `password`
   * stage (admin-set or reset password) becomes active. Directory accounts are changed in their directory.
   */
  r.post('/password', changing, async (req, res) => {
    const p = principalOf(req);
    const session = req.authSession!;
    const body = parseBody(z.object({ currentPassword: z.string().min(1).max(1024), newPassword: z.string().min(1).max(1024) }), req.body);
    const home = await s.account.passwordHome(p.tenantId, p.userId);
    if (home.kind !== 'local') {
      const where = home.stores.length ? home.stores.map((x) => x.name).join(', ') : 'your directory';
      throw new HttpProblem(409, 'Managed by the directory', `Your password is kept by ${where}. Change it there; this server does not store it.`, { extensions: { stores: home.stores.map((x) => x.name) } });
    }
    const attempt = await reserveAttempt(req);
    if (!(await s.account.isCurrent(p.userId, body.currentPassword))) {
      const remaining = await attempt.failed('password.change.failed', { reason: 'wrong current password' });
      throw new HttpProblem(400, 'Wrong password', 'The current password is wrong.', { extensions: { attempts_remaining: remaining } });
    }
    await attempt.ok();
    if (body.newPassword === body.currentPassword) throw badRequest('Choose a password different from the current one.', { reason: 'reuse' });
    await s.account.checkNewPassword({ tenantId: p.tenantId, username: p.username, password: body.newPassword, actor: p, ip: ip(req), traceId: req.traceId });
    await s.account.setPassword(p.userId, body.newPassword, false);
    const sessionsRevoked = await s.sessions.revokeAllForUser(p.userId, session.id);
    const grantsRevoked = await s.account.revokeGrants(p.tenantId, p.userId);
    let current = session;
    let csrf: string | undefined;
    if (session.stage === 'password') {
      const next = await s.sessions.rotate(session, { stage: 'active' });
      setSessionCookie(res, s, next.token, next.session.expires_at);
      current = next.session;
      csrf = s.sessions.csrfFor(current.id);
    }
    await s.sessions.markAuthenticated(current.id);
    await audit(req, 'password.changed', { user: p.userId }, { sessionsRevoked, grantsRevoked, forced: session.stage === 'password' }, 'auth');
    await alert(req, 'password.changed', sessionsRevoked ? `${sessionsRevoked} other session${sessionsRevoked === 1 ? ' was' : 's were'} signed out.` : undefined);
    res.json({ changed: true, stage: 'active', sessionsRevoked, grantsRevoked, ...(csrf ? { csrf } : {}) });
  });

  // ---------- step-up re-authentication (B-106) ----------

  r.post('/step-up/webauthn/options', browser, async (req, res) => {
    const options = await s.mfa.authenticationOptions(principalOf(req).userId);
    await s.sessions.setChallenge(req.authSession!.id, options.challenge);
    res.json(options);
  });

  /** Confirms the signed-in user with their password, a TOTP code or a passkey; sensitive changes are then allowed for the window. */
  r.post('/step-up', browser, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(
      z
        .object({ password: z.string().min(1).max(1024).optional(), code: z.string().trim().regex(/^\d{6}$/).optional(), response: z.looseObject({ id: z.string(), type: z.literal('public-key') }).optional() })
        .refine((b) => [b.password, b.code, b.response].filter((x) => x !== undefined).length === 1, 'Give exactly one of password, code or response.'),
      req.body
    );
    const challenge = body.response ? await s.sessions.takeChallenge(req.authSession!.id) : null;
    if (body.response && !challenge) throw badRequest('The passkey challenge expired. Try again.');
    const attempt = await reserveAttempt(req);
    let method: string;
    let ok: boolean;
    if (body.password !== undefined) {
      method = 'password';
      const r2 = await s.chain.authenticate(p.tenantId, p.username, body.password);
      ok = r2.status === 'ok' && (await s.users.identity(r2.provider.id, r2.user.externalId))?.user_id === p.userId;
    } else if (body.code !== undefined) {
      method = 'TOTP';
      ok = await s.mfa.verifyTotp(p.userId, body.code);
    } else {
      method = 'passkey';
      ok = await s.mfa.verifyAuthentication(p.userId, challenge!, body.response as never).catch(() => false);
    }
    if (!ok) {
      const remaining = await attempt.failed('auth.step_up.failed', { method });
      throw new HttpProblem(400, 'Not confirmed', method === 'password' ? 'That password is wrong.' : 'That did not match. Try again.', { extensions: { attempts_remaining: remaining } });
    }
    await attempt.ok();
    const at = await s.sessions.markAuthenticated(req.authSession!.id, { mfa: method !== 'password' });
    await audit(req, 'auth.step_up', {}, { method }, 'auth');
    res.json({ authAt: at, windowSeconds: s.cfg.STEPUP_WINDOW_SECONDS, method });
  });

  // ---------- step-up at the upstream identity provider (Sprint 17, B-803) ----------

  /** The enabled upstream OIDC or SAML provider the current session signed in with, if any. */
  async function upstreamOf(req: Request) {
    const id = req.authSession?.provider_id;
    if (!id) return null;
    const row = await s.providers.get(req.authSession!.tenant_id, id);
    return row && row.enabled && (row.kind === 'oidc' || row.kind === 'saml') ? row : null;
  }

  /**
   * Starts a re-authentication at the upstream IdP the session came from (`prompt=login` and `max_age=0`, or SAML
   * `ForceAuthn`). The pending state is bound to this browser (the federation cookie) and to this session; the
   * console follows the returned URL.
   */
  r.post('/step-up/upstream', browser, async (req, res) => {
    const p = principalOf(req);
    const row = await upstreamOf(req);
    if (!row) throw conflict('This session did not sign in through an upstream identity provider. Confirm with your password or a second factor instead.');
    const t = (await s.federation.tenantById(p.tenantId))!;
    const binding = { sessionId: req.authSession!.id, userId: p.userId };
    const out = row.kind === 'oidc' ? await s.federation.upstream.startOidc(t, row.id, null, binding) : await s.federation.upstream.startSaml(t, row.id, null, binding);
    setFedCookie(res, s, out.browser, row.kind === 'saml' ? 'none' : 'lax');
    await audit(req, 'auth.step_up.started', { provider: row.name, kind: row.kind }, { method: 'upstream' }, 'auth');
    res.json({ url: out.url, provider: row.name });
  });

  /** Redeems the handle the upstream callback left for this session; only then does the step-up time move. */
  r.post('/step-up/upstream/complete', browser, async (req, res) => {
    const p = principalOf(req);
    const { handle } = parseBody(z.object({ handle: z.string().min(1).max(100) }), req.body);
    const out = await s.federation.upstream.takeStepUp(p.tenantId, handle, req.authSession!.id);
    if (!out || out.userId !== p.userId) {
      await audit(req, 'auth.step_up.failed', {}, { method: 'upstream', reason: 'unknown, expired or another session' }, 'auth');
      throw badRequest('This confirmation is unknown, has expired, or belongs to another session. Try again.');
    }
    const at = await s.sessions.markAuthenticated(req.authSession!.id);
    await audit(req, 'auth.step_up', {}, { method: out.method }, 'auth');
    res.json({ authAt: at, windowSeconds: s.cfg.STEPUP_WINDOW_SECONDS, method: out.method });
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
    await s.identityPolicy.forgetSession(target.id); // Sprint 26a (B-1803): and the device trusted from it
    await audit(req, 'session.revoked', { session: target.id });
    await alert(req, 'session.revoked', `The session signed in with ${target.method}${target.ip ? ` from ${target.ip}` : ''} was ended.`);
    res.status(204).end();
  });

  r.post('/sessions/revoke-others', browser, async (req, res) => {
    const p = principalOf(req);
    const n = await s.sessions.revokeAllForUser(p.userId, p.sessionId ?? undefined);
    await audit(req, 'session.revoked_all', { count: n, keptCurrent: true });
    if (n) await alert(req, 'sessions.revoked', `${n} session${n === 1 ? ' was' : 's were'} signed out.`);
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
    await alert(req, 'grant.revoked', `${client.name} can no longer act as you. Its tokens stopped working at once.`);
    res.json({ revoked: true, clientId, ...out });
  });

  // ---------- API keys ----------

  r.get('/api-keys', active, async (req, res) => {
    const rows = await s.apiKeys.listForUser(principalOf(req).userId);
    res.json(rows.map((k) => ({ id: k.id, name: k.name, prefix: `exai_k1_${k.prefix}`, scopes: k.scopes, state: apiKeyState(k), expiresAt: k.expires_at, lastUsedAt: k.last_used_at, createdAt: k.created_at, signatureKey: k.signature_key })));
  });

  r.post('/api-keys', browser, recent, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(
      z.object({
        name: z.string().trim().min(1).max(100),
        scopes: z.array(z.enum(PERMISSIONS)).min(1).max(PERMISSIONS.length),
        ttlDays: z.union([z.literal(30), z.literal(90), z.literal(180), z.literal(365)]),
        // Sprint 20 (B-1203): requests made with the key must then carry an RFC 9421 signature by this Ed25519 key.
        signatureKey: z.string().trim().min(1).max(400).nullable().optional()
      }),
      req.body
    );
    const signatureKey = body.signatureKey ? signatureKeyX(body.signatureKey) : null;
    const held = effectivePermissions(p);
    const extra = body.scopes.filter((sc) => !held.has(sc));
    if (extra.length) throw forbidden(`Scopes never widen a role: you do not hold ${extra.join(', ')}.`, { step: 'scope' });
    const { key, row } = await s.apiKeys.create({ tenantId: p.tenantId, userId: p.userId, name: body.name, scopes: body.scopes as Permission[], ttlDays: body.ttlDays, signatureKey });
    await audit(req, 'apikey.created', { key: row.id, prefix: row.prefix, scopes: row.scopes, expiresAt: row.expires_at, signatureKey: row.signature_key });
    await alert(req, 'api_key.created', `Key "${row.name}" (exai_k1_${row.prefix}…) with ${row.scopes.length} scope${row.scopes.length === 1 ? '' : 's'}.`);
    res.status(201).json({ id: row.id, key, prefix: `exai_k1_${row.prefix}`, scopes: row.scopes, expiresAt: row.expires_at, signatureKey: row.signature_key, notice: 'This is the only time the key is shown.' });
  });

  /**
   * Sprint 20 (B-1203): registers (or, with null, removes) the Ed25519 public key that `/v1` requests made with this
   * API key must be signed with (RFC 9421). Browser sessions only, after a recent sign-in, like creating a key.
   */
  r.put('/api-keys/:id/signature-key', browser, recent, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(z.object({ publicKey: z.string().trim().min(1).max(400).nullable() }).strict(), req.body);
    const x = body.publicKey ? signatureKeyX(body.publicKey) : null;
    const row = await s.apiKeys.setSignatureKey(p.userId, String(req.params.id), x);
    if (!row) throw notFound('API key');
    await audit(req, x ? 'apikey.signature_key.set' : 'apikey.signature_key.removed', { key: row.id, prefix: row.prefix, signatureKey: x });
    await alert(req, 'api_key.changed', x ? `Key "${row.name}" (exai_k1_${row.prefix}…) now requires signed requests.` : `Key "${row.name}" (exai_k1_${row.prefix}…) no longer requires signed requests.`);
    res.json({ id: row.id, signatureKey: row.signature_key });
  });

  r.delete('/api-keys/:id', active, async (req, res) => {
    const p = principalOf(req);
    const key = (await s.apiKeys.listForUser(p.userId)).find((k) => k.id === req.params.id);
    if (!(await s.apiKeys.revoke(p.userId, String(req.params.id)))) throw notFound('API key');
    await audit(req, 'apikey.revoked', { key: req.params.id });
    await alert(req, 'api_key.revoked', key ? `Key "${key.name}" (exai_k1_${key.prefix}…).` : undefined);
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
    await alert(req, 'factor.added', `A ${kind === 'passkey' ? 'passkey' : kind === 'email code' ? 'email address for one-time codes' : 'authenticator app'} was added.`);
    const codes = (await s.mfa.remainingRecoveryCodes(p.userId)) === 0 ? await s.mfa.regenerateRecoveryCodes(p.userId) : null;
    let stage = req.authSession!.stage;
    if (stage === 'enroll') {
      const { token, session } = await s.sessions.rotate(req.authSession!, { stage: await s.account.stageAfterFactor(p.userId), method: `${req.authSession!.method}, ${kind}`, mfaVerified: true });
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

  // Sprint 28a (B-1806): one-time codes sent to the account's email address. The code proves the address works before
  // it becomes a factor; wrong codes count against the account's lockout like a wrong password or TOTP code.
  r.post('/mfa/email', enrolling, async (req, res) => {
    const p = principalOf(req);
    const { label } = parseBody(z.object({ label: z.string().trim().min(1).max(100).optional() }).strict(), req.body ?? {});
    requireEmail(s);
    const user = await s.users.get(p.tenantId, p.userId);
    if (!user?.email) throw conflict('Your account has no email address. Ask an identity admin to add one first.');
    if ((await s.mfa.factors(p.userId)).some((f) => f.kind === 'email')) throw conflict('An email factor is already set up. Remove it before adding another.');
    await admitSend(s, p.userId);
    const out = await s.mfa.beginEmail(p.userId, user.email, label ?? `Email ${maskAddress(user.email)}`, emailCodeTtlMs(s));
    await sendCode(s, { address: user.email, name: user.display_name, username: user.username }, out.code, 'enrol');
    await audit(req, 'mfa.email.code_sent', { factor: out.id }, { purpose: 'enrol' }, 'auth');
    res.status(201).json({ id: out.id, sentTo: maskAddress(user.email), expiresAt: out.expiresAt });
  });

  r.post('/mfa/email/:id/confirm', enrolling, async (req, res) => {
    const p = principalOf(req);
    const { code } = parseBody(z.object({ code: z.string().trim().regex(/^\d{6}$/) }).strict(), req.body);
    const attempt = await reserveAttempt(req);
    if (!(await s.mfa.confirmEmail(p.userId, String(req.params.id), code))) {
      const remaining = await attempt.failed('mfa.email.failed', { purpose: 'enrol' });
      throw new HttpProblem(400, 'Not confirmed', 'That code did not match, or it expired. Ask for a new one if needed.', { extensions: { attempts_remaining: remaining } });
    }
    await attempt.ok();
    await afterEnrol(req, res, 'email code');
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

  r.delete('/mfa/:id', browser, recent, async (req, res) => {
    const p = principalOf(req);
    const factors = await s.mfa.factors(p.userId);
    const user = await s.users.get(p.tenantId, p.userId);
    if (!factors.some((f) => f.id === req.params.id)) throw notFound('Factor');
    // Admin roles need a factor whether they were granted directly or through a group mapping after the account was made.
    if ((user?.mfa_required || rolesRequireMfa(p.roles)) && factors.length <= 1) throw forbidden('Your roles require a second factor. Add another before removing this one.');
    const removed = factors.find((f) => f.id === req.params.id)!;
    await s.mfa.removeFactor(p.userId, String(req.params.id));
    await audit(req, 'mfa.removed', { factor: req.params.id });
    await alert(req, 'factor.removed', `"${removed.label}" (${removed.kind === 'webauthn' ? 'passkey' : 'authenticator app'}) was removed.`);
    res.status(204).end();
  });

  r.post('/mfa/recovery-codes', browser, recent, async (req, res) => {
    const p = principalOf(req);
    if (!(await s.mfa.factors(p.userId)).length) throw badRequest('Add a second factor first.');
    const codes = await s.mfa.regenerateRecoveryCodes(p.userId);
    await audit(req, 'mfa.recovery_codes.regenerated');
    await alert(req, 'recovery_codes.regenerated', 'Earlier recovery codes no longer work.');
    res.status(201).json({ recoveryCodes: codes, notice: 'Store these now. Each works once; they replace any earlier codes.' });
  });

  return r;
}
