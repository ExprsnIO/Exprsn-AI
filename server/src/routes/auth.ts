import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { LoginThrottle } from '../identity/lockout.js';
import { provision } from '../identity/provisioning.js';
import { isFederatedKind } from '../identity/providers/types.js';
import type { SessionRow } from '../identity/sessions.js';
import { rolesRequireMfa } from '../authz/permissions.js';
import { clearSessionCookie, ip, loadPrincipal, noStore, parseBody, requireAuth, setSessionCookie } from '../http/middleware.js';
import { forbidden, HttpProblem, tooManyRequests, unauthorized } from '../http/problem.js';
import type { Services } from '../services.js';
import { securityAlert } from '../identity/security-alerts.js';

const loginSchema = z.object({
  tenant: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).optional(),
  username: z.string().trim().min(1).max(190),
  password: z.string().min(1).max(1024)
});

const REFUSALS: Record<string, string> = {
  disabled: 'This account is disabled. Ask an identity admin.',
  no_mapped_group: 'Your account is not in a group mapped to this tenant. Ask an identity admin.',
  identity_conflict: 'This username is already linked to a different user store. Ask an identity admin.'
};

const invalidCredentials = (remaining: number) =>
  new HttpProblem(401, 'Invalid credentials', remaining > 0 && remaining <= 2 ? `The username or password is wrong. ${remaining === 1 ? 'One attempt' : 'Two attempts'} left before lockout.` : 'The username or password is wrong.', {
    extensions: { attempts_remaining: remaining }
  });

export function authRoutes(s: Services): Router {
  const r = Router();
  r.use(noStore);

  const sessionBody = async (session: SessionRow) => {
    const user = await s.users.get(session.tenant_id, session.user_id);
    const methods = session.stage === 'mfa' ? await s.mfa.methods(session.user_id) : [];
    return {
      authenticated: session.stage === 'active',
      stage: session.stage,
      csrf: s.sessions.csrfFor(session.id),
      mfa: { methods },
      user: user ? { id: user.id, username: user.username, displayName: user.display_name } : null,
      expiresAt: session.expires_at
    };
  };

  /** Completes a pending-MFA session: new token, stage active. */
  const completeMfa = async (req: Request, res: Response, method: string) => {
    const session = req.authSession as SessionRow;
    // A password an admin set or reset must be changed next (after the factor, so a leaked temporary password alone
    // cannot take over the account).
    const stage = await s.account.stageAfterFactor(session.user_id);
    const { token, session: next } = await s.sessions.rotate(session, { stage, method: `${session.method}, ${method}`, mfaVerified: true });
    setSessionCookie(res, s, token, next.expires_at);
    await s.throttle.succeed(`mfa:${session.id}`);
    await s.audit.append({ tenantId: session.tenant_id, action: 'auth.mfa.verified', kind: 'auth', actor: actorFrom(req.principal, ip(req)), target: { method }, traceId: req.traceId });
    s.metrics.logins.inc({ result: 'ok', kind: method });
    res.json(await sessionBody(next));
  };

  const endPending = async (session: SessionRow, res: Response): Promise<never> => {
    await s.sessions.revoke(session.tenant_id, session.id);
    clearSessionCookie(res, s);
    throw unauthorized('Too many wrong codes. Sign in again.');
  };

  /** Counts the attempt before the code is checked, so parallel guesses cannot exceed the limit. */
  const reserveMfa = async (req: Request, res: Response) => {
    const session = req.authSession as SessionRow;
    const state = await s.throttle.reserve([`mfa:${session.id}`]);
    if (state.locked) await endPending(session, res);
  };

  /** Counts a failed second factor; five failures end the pending session. */
  const failMfa = async (req: Request, res: Response, method: string) => {
    const session = req.authSession as SessionRow;
    const state = await s.throttle.failed([`mfa:${session.id}`]);
    await s.audit.append({ tenantId: session.tenant_id, action: 'auth.mfa.failed', kind: 'auth', actor: actorFrom(req.principal, ip(req)), target: { method }, traceId: req.traceId });
    s.metrics.logins.inc({ result: 'mfa_failed', kind: method });
    if (state.remaining <= 0 || state.locked) await endPending(session, res);
    throw new HttpProblem(401, 'Invalid code', 'That code did not work. Try the next one from your authenticator.', { extensions: { attempts_remaining: state.remaining } });
  };

  r.get('/session', async (req, res) => {
    if (!req.authSession) return void res.json({ authenticated: false, stage: null });
    res.json(await sessionBody(req.authSession));
  });

  r.post('/login', async (req, res) => {
    const body = parseBody(loginSchema, req.body);
    const tenant = await s.tenants.bySlug(body.tenant ?? s.cfg.DEFAULT_TENANT);
    const keys = LoginThrottle.keys(tenant?.id ?? 'unknown', body.username, ip(req));
    const throttleKeys = [keys.account, ...(keys.ip ? [keys.ip] : [])];

    const state = await s.throttle.check(throttleKeys);
    if (state.locked) throw tooManyRequests(`Too many failed sign-ins. Try again in ${Math.ceil(state.retryAfterSeconds / 60)} minutes.`, state.retryAfterSeconds);
    // Count this attempt before the (slow) password check, so parallel guesses cannot all pass the check above.
    const reserved = await s.throttle.reserve(throttleKeys);
    if (reserved.locked) throw tooManyRequests(`Too many failed sign-ins. Try again in ${Math.ceil(reserved.retryAfterSeconds / 60)} minutes.`, reserved.retryAfterSeconds);

    if (!tenant || tenant.state !== 'active') {
      const after = await s.throttle.failed(throttleKeys);
      throw invalidCredentials(after.remaining);
    }

    const result = await s.chain.authenticate(tenant.id, body.username, body.password);
    if (result.status !== 'ok') {
      const after = await s.throttle.failed(throttleKeys);
      await s.audit.append({
        tenantId: tenant.id,
        action: 'auth.login.failed',
        kind: 'auth',
        actor: { username: body.username.toLowerCase(), ip: ip(req) },
        target: { provider: 'provider' in result ? result.provider.name : null },
        detail: { reason: result.status, attemptsRemaining: after.remaining, ...(result.status === 'not_found' && result.errors.length ? { storeErrors: result.errors } : {}) },
        traceId: req.traceId
      });
      s.metrics.logins.inc({ result: result.status, kind: 'password' });
      if (after.locked) throw tooManyRequests(`Too many failed sign-ins. Try again in ${Math.ceil(after.retryAfterSeconds / 60)} minutes.`, after.retryAfterSeconds);
      throw invalidCredentials(after.remaining);
    }

    const prov = await provision(s.users, tenant.id, result.provider, result.user);
    if (prov.status === 'refused') {
      await s.throttle.release(throttleKeys); // the password was right; the refusal is about the account
      await s.audit.append({
        tenantId: tenant.id,
        action: 'auth.login.refused',
        kind: 'auth',
        actor: { username: result.user.username, user: prov.user?.id, ip: ip(req) },
        target: { provider: result.provider.name, groups: result.user.groups.length },
        detail: { reason: prov.reason },
        traceId: req.traceId
      });
      s.metrics.logins.inc({ result: prov.reason, kind: 'password' });
      throw forbidden(REFUSALS[prov.reason] ?? 'Sign-in refused.', { reason: prov.reason });
    }
    await s.throttle.succeed(keys.account);
    if (keys.ip) await s.throttle.release([keys.ip]);
    // A new sign-in in this browser ends the session its cookie held before (ASVS 3.2.1), as federated sign-ins do.
    if (req.authSession) await s.sessions.revoke(req.authSession.tenant_id, req.authSession.id);

    const methods = await s.mfa.methods(prov.user.id);
    const needsMfa = prov.user.mfa_required || rolesRequireMfa(prov.roles);
    const mustChange = result.provider.kind === 'local' && (await s.account.mustChange(prov.user.id));
    const stage = methods.length ? 'mfa' : needsMfa ? 'enroll' : mustChange ? 'password' : 'active';
    const { token, session } = await s.sessions.create({
      userId: prov.user.id,
      tenantId: tenant.id,
      stage,
      method: `${result.provider.kind === 'ldap' ? 'LDAP' : result.provider.kind === 'sql' ? 'SQL' : 'Local'} password`,
      providerId: result.provider.id,
      ip: ip(req),
      userAgent: req.header('user-agent') ?? null
    });
    setSessionCookie(res, s, token, session.expires_at);
    await s.audit.append({
      tenantId: tenant.id,
      action: stage === 'active' ? 'auth.login' : stage === 'password' ? 'auth.login.pending_password' : 'auth.login.pending_mfa',
      kind: 'auth',
      actor: { user: prov.user.id, username: prov.user.username, name: prov.user.display_name, session: session.id, roles: prov.roles, ip: ip(req) },
      target: { provider: result.provider.name, kind: result.provider.kind },
      detail: { jit: prov.created, stage },
      traceId: req.traceId
    });
    s.metrics.logins.inc({ result: stage === 'active' ? 'ok' : stage, kind: 'password' });
    res.json(await sessionBody(session));
  });

  const pending = requireAuth({ stages: ['mfa'], sessionOnly: true });

  r.post('/mfa/totp', pending, async (req, res) => {
    const { code } = parseBody(z.object({ code: z.string().trim().regex(/^\d{6}$/) }), req.body);
    await reserveMfa(req, res);
    if (await s.mfa.verifyTotp(req.authSession!.user_id, code)) return completeMfa(req, res, 'TOTP');
    await failMfa(req, res, 'TOTP');
  });

  r.post('/mfa/recovery', pending, async (req, res) => {
    const { code } = parseBody(z.object({ code: z.string().trim().min(8).max(20) }), req.body);
    await reserveMfa(req, res);
    if (await s.mfa.useRecoveryCode(req.authSession!.user_id, code)) return completeMfa(req, res, 'recovery code');
    await failMfa(req, res, 'recovery code');
  });

  r.post('/mfa/webauthn/options', pending, async (req, res) => {
    const options = await s.mfa.authenticationOptions(req.authSession!.user_id);
    await s.sessions.setChallenge(req.authSession!.id, options.challenge);
    res.json(options);
  });

  r.post('/mfa/webauthn', pending, async (req, res) => {
    const { response } = parseBody(z.object({ response: z.looseObject({ id: z.string(), type: z.literal('public-key') }) }), req.body);
    const challenge = await s.sessions.takeChallenge(req.authSession!.id);
    if (!challenge) throw unauthorized('The passkey challenge expired. Try again.');
    await reserveMfa(req, res);
    const ok = await s.mfa.verifyAuthentication(req.authSession!.user_id, challenge, response as never).catch(() => false);
    if (ok) return completeMfa(req, res, 'passkey');
    await failMfa(req, res, 'passkey');
  });

  // ---------- Sprint 11: password reset by email (public, outside a session) ----------

  const tenantSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

  /** One user by username or (unambiguous) email address, in a tenant. */
  const byIdentifier = async (tenantId: string, identifier: string) => {
    const byName = await s.users.byUsername(tenantId, identifier);
    if (byName) return byName;
    if (!identifier.includes('@')) return undefined;
    const rows = (await s.db('users').where({ tenant_id: tenantId }).whereRaw('LOWER(email) = ?', [identifier.toLowerCase()]).limit(2).select('id')) as { id: string }[];
    return rows.length === 1 ? s.users.get(tenantId, rows[0]!.id) : undefined;
  };

  /**
   * Asks for a reset link. The answer is the same whether or not the account exists, has a local password or an
   * email address. Throttled per client address and per identifier (answering 429, which says nothing about the
   * account), and per account (silently: no second email).
   */
  r.post('/password/forgot', async (req, res) => {
    const body = parseBody(z.object({ tenant: tenantSlug.optional(), identifier: z.string().trim().min(1).max(320) }), req.body);
    const hour = 3600_000;
    const per = s.cfg.PASSWORD_RESET_PER_HOUR;
    const slug = body.tenant ?? s.cfg.DEFAULT_TENANT;
    const okAddr = await s.account.hit(`pwreset:ip:${ip(req) ?? 'unknown'}`, per * 4, hour);
    const okId = await s.account.hit(`pwreset:id:${slug}:${body.identifier.toLowerCase()}`, per, hour);
    if (!okAddr || !okId) throw tooManyRequests('Too many reset requests. Try again in an hour.', 3600);
    const tenant = await s.tenants.bySlug(slug);
    const user = tenant && tenant.state === 'active' ? await byIdentifier(tenant.id, body.identifier) : undefined;
    if (tenant && user) {
      const local = await s.account.localCredential(user.id);
      const reason = user.state !== 'active' ? 'disabled' : !local ? 'directory_account' : !user.email ? 'no_email' : !s.notifications.emailEnabled ? 'email_not_configured' : null;
      if (!reason && (await s.account.hit(`pwreset:user:${user.id}`, per, hour))) {
        const { token } = await s.account.issueToken({ tenantId: tenant.id, userId: user.id, kind: 'reset', ttlMs: s.cfg.PASSWORD_RESET_MINUTES * 60_000 });
        void s.notifications.sendTemplate(user.email, 'password-reset', { name: user.display_name, username: user.username, minutes: s.cfg.PASSWORD_RESET_MINUTES, link: s.account.resetLink(token, tenant.slug) });
        await s.audit.append({ tenantId: tenant.id, action: 'password.reset.requested', kind: 'auth', actor: { ip: ip(req) }, target: { user: user.id, username: user.username }, traceId: req.traceId });
      } else {
        await s.audit.append({ tenantId: tenant.id, action: 'password.reset.ignored', kind: 'auth', actor: { ip: ip(req) }, target: { user: user.id, username: user.username }, detail: { reason: reason ?? 'throttled' }, traceId: req.traceId });
      }
    }
    res.status(202).json({ accepted: true, detail: `If an account with a password kept here matches, a reset link is on its way to its email address. The link works once, for ${s.cfg.PASSWORD_RESET_MINUTES} minutes.` });
  });

  /** Sets a new password with a reset, admin or invite link. Ends every session and OAuth grant of the account. */
  r.post('/password/reset', async (req, res) => {
    const body = parseBody(z.object({ token: z.string().min(1).max(200), password: z.string().min(1).max(1024) }), req.body);
    const invalid = () => new HttpProblem(400, 'Invalid link', 'This link is invalid, has expired or was already used. Ask for a new one.');
    const found = await s.account.findToken(body.token);
    const user = found ? await s.users.get(found.tenant_id, found.user_id) : undefined;
    if (!found || !user || user.state !== 'active' || !(await s.account.localCredential(user.id))) throw invalid();
    await s.account.checkNewPassword({ tenantId: user.tenant_id, username: user.username, password: body.password, ip: ip(req), traceId: req.traceId });
    const row = await s.account.consumeToken(body.token);
    if (!row) throw invalid();
    await s.account.setPassword(user.id, body.password, false);
    const sessions = await s.sessions.revokeAllForUser(user.id);
    const grants = await s.account.revokeGrants(user.tenant_id, user.id);
    // A reset lifts a lockout on the account.
    await s.throttle.succeed(LoginThrottle.keys(user.tenant_id, user.username, null).account);
    await s.audit.append({ tenantId: user.tenant_id, action: row.kind === 'invite' ? 'password.invite.accepted' : 'password.reset.completed', kind: 'auth', actor: { user: user.id, username: user.username, ip: ip(req) }, target: { user: user.id, username: user.username }, detail: { link: row.kind, sessionsRevoked: sessions, grantsRevoked: grants }, traceId: req.traceId });
    if (row.kind !== 'invite') await securityAlert(s, { tenantId: user.tenant_id, userId: user.id, event: 'password.reset', detail: 'The password was set with a reset link and every session was signed out.', ip: ip(req) });
    const tenant = await s.tenants.byId(user.tenant_id);
    res.json({ reset: true, username: user.username, tenant: tenant?.slug ?? null });
  });

  // ---------- Sprint 9: federation ----------

  /** What the sign-in screen can offer besides a password: upstream identity providers and Kerberos. Public. */
  r.get('/sign-in-options', async (req, res) => {
    const slug = typeof req.query.tenant === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(req.query.tenant) ? req.query.tenant : s.cfg.DEFAULT_TENANT;
    const t = await s.federation.tenantBySlug(slug);
    if (!t) return void res.json({ upstream: [], kerberos: false });
    const base = slug === s.cfg.DEFAULT_TENANT ? '' : `/t/${slug}`;
    const rows = (await s.providers.list(t.id)).filter((p) => p.enabled && isFederatedKind(p.kind));
    const settings = await s.federation.settings(t.id);
    const kerberos = settings.kerberos.enabled && (await s.kerberos.status()).available;
    res.json({
      upstream: rows.map((p) => ({ id: p.id, name: p.name, protocol: p.kind, start: `${base}/federation/${p.kind}/start?provider=${p.id}` })),
      kerberos: kerberos ? { start: `${base}/auth/negotiate` } : false
    });
  });

  const userCodeSchema = z.string().trim().min(8).max(12);
  const signedIn = (req: Request) => {
    const session = req.authSession as SessionRow;
    return { tenantId: session.tenant_id, userId: session.user_id, sessionId: session.id, method: session.method, authTime: session.created_at };
  };

  /** The device request behind a user code, for the approval page (RFC 8628 verification). */
  r.get('/device', requireAuth({ sessionOnly: true }), async (req, res) => {
    const code = parseBody(userCodeSchema, req.query.user_code);
    const p = req.principal!;
    const found = await s.federation.oidc.deviceLookup(p.tenantId, code);
    if (!found) throw new HttpProblem(404, 'Not found', 'No pending request has that code in your tenant. Check the code, or start again on the device.');
    res.json({ client: { name: found.client.name, type: found.client.type }, scopes: await s.federation.oidc.grantableScopes(p.tenantId, p.userId, found.client, found.scopes), expiresAt: found.expiresAt });
  });

  /** Approves or denies a device request as the signed-in user. */
  r.post('/device', requireAuth({ sessionOnly: true }), async (req, res) => {
    const body = parseBody(z.object({ userCode: userCodeSchema, approve: z.boolean() }), req.body);
    const p = req.principal!;
    const out = await s.federation.oidc.deviceDecide(p.tenantId, body.userCode, signedIn(req), body.approve);
    if (!out) throw new HttpProblem(404, 'Not found', 'No pending request has that code in your tenant. Check the code, or start again on the device.');
    await s.audit.append({ tenantId: p.tenantId, action: body.approve ? 'oidc.device.approved' : 'oidc.device.denied', kind: 'auth', actor: actorFrom(p, ip(req)), target: { client: out.client.client_id, name: out.client.name }, detail: { scopes: out.scopes }, traceId: req.traceId });
    res.json({ approved: body.approve, client: out.client.name, scopes: out.scopes });
  });

  r.post('/logout', async (req, res) => {
    if (req.authSession) {
      await s.sessions.revoke(req.authSession.tenant_id, req.authSession.id);
      const p = req.principal ?? (await loadPrincipal(s, req.authSession.tenant_id, req.authSession.user_id, { session: req.authSession }));
      await s.audit.append({ tenantId: req.authSession.tenant_id, action: 'auth.logout', kind: 'auth', actor: actorFrom(p, ip(req)), traceId: req.traceId });
    }
    clearSessionCookie(res, s);
    res.status(204).end();
  });

  return r;
}
