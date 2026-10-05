import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { LoginThrottle } from '../identity/lockout.js';
import { provision } from '../identity/provisioning.js';
import { signsInByRedirect } from '../identity/providers/types.js';
import type { SessionRow } from '../identity/sessions.js';
import { effectivePermissions } from '../authz/policy.js';
import { rolesRequireMfa } from '../authz/permissions.js';
import { estimateStrength, passwordRules } from '../identity/passwords.js';
import { clearSessionCookie, ip, loadPrincipal, noStore, parseBody, requireAuth, setSessionCookie } from '../http/middleware.js';
import { conflict, forbidden, HttpProblem, tooManyRequests, unauthorized } from '../http/problem.js';
import { admitSend, emailCodeTtlMs, maskAddress, requireEmail, sendCode } from '../identity/email-otp.js';
import type { Services } from '../services.js';
import { securityAlert } from '../identity/security-alerts.js';
import { signedOutPage } from './federation-public.js';

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
    // Sprint 30d (B-3413): how long "trust this browser" lasts for this account, so the sign-in page offers it only
    // when the tenant allows trusted devices and the account may have one (never admins or accounts marked as needing
    // a factor).
    const trustedDeviceDays =
      session.stage !== 'mfa' || !user || user.mfa_required || rolesRequireMfa(await s.users.roleIds(user.id), session.tenant_id) ? 0 : (await s.identityPolicy.get(session.tenant_id)).mfa.trustedDeviceDays;
    return {
      authenticated: session.stage === 'active',
      stage: session.stage,
      csrf: s.sessions.csrfFor(session.id),
      mfa: { methods, ...(session.stage === 'mfa' ? { trustedDeviceDays } : {}) },
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
    // Sprint 26a (B-1803): "trust this device" skips the factor on this browser for the tenant's trusted-device period.
    const remember = (req.body as { rememberDevice?: unknown } | undefined)?.rememberDevice === true;
    const trustedUntil = remember && method !== 'recovery code' ? await s.identityPolicy.trust(req, { tenantId: session.tenant_id, userId: session.user_id, sessionId: next.id }) : null;
    if (trustedUntil) await s.audit.append({ tenantId: session.tenant_id, action: 'auth.trusted_device.added', kind: 'auth', actor: actorFrom(req.principal, ip(req)), target: { user: session.user_id }, detail: { until: trustedUntil }, traceId: req.traceId });
    res.json({ ...(await sessionBody(next)), ...(remember ? { trustedDevice: trustedUntil ? { until: trustedUntil } : null } : {}) });
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
    // Sprint 26a (B-1801): the right password for a sign-up still waiting for approval gets a clear answer.
    if (result.status === 'disabled' && result.provider.kind === 'local') {
      const pendingUser = await s.users.byUsername(tenant.id, body.username);
      const state = pendingUser ? await s.signup.signupState(pendingUser.id) : null;
      if (pendingUser && (state === 'pending' || state === 'rejected')) {
        await s.throttle.release(throttleKeys);
        await s.audit.append({ tenantId: tenant.id, action: 'auth.login.refused', kind: 'auth', actor: { username: pendingUser.username, user: pendingUser.id, ip: ip(req) }, target: { provider: result.provider.name }, detail: { reason: state === 'pending' ? 'signup_pending' : 'signup_rejected' }, traceId: req.traceId });
        throw forbidden(state === 'pending' ? 'Your sign-up is waiting for an admin to approve it. You will get an email when it is.' : 'Your sign-up was not approved. Ask an admin.', { reason: state === 'pending' ? 'signup_pending' : 'signup_rejected' });
      }
    }
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

    // Sprint 26a (B-1802): a local account must have proven its address when the tenant requires it. A new link is
    // sent (throttled), and the refusal comes only after the right password, so it says nothing to a guesser.
    if (result.provider.kind === 'local') {
      const policy = await s.identityPolicy.get(tenant.id);
      const local = await s.users.get(tenant.id, result.user.externalId);
      if (local && (await s.signup.needsVerification(policy, local))) {
        await s.throttle.release(throttleKeys);
        const sent = await s.signup.sendVerification(tenant, local);
        await s.audit.append({ tenantId: tenant.id, action: 'auth.login.refused', kind: 'auth', actor: { username: local.username, user: local.id, ip: ip(req) }, target: { provider: result.provider.name }, detail: { reason: 'email_unverified', linkSent: sent }, traceId: req.traceId });
        s.metrics.logins.inc({ result: 'email_unverified', kind: 'password' });
        throw forbidden('Confirm your email address first: open the link we sent you. A new link is on its way if the last one expired.', { reason: 'email_unverified' });
      }
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

    const mustChange = result.provider.kind === 'local' && (await s.account.mustChange(prov.user.id));
    // Sprint 26a (B-1803): the second factor (skipped on a trusted device), enrolment for roles that need it and for
    // the tenant's MFA policy once its grace period is over, then a forced password change.
    const next = await s.identityPolicy.signInStage(req, { tenantId: tenant.id, user: prov.user, roles: prov.roles, mustChange });
    const stage = next.stage;
    const { token, session } = await s.sessions.create({
      userId: prov.user.id,
      tenantId: tenant.id,
      stage,
      method: `${result.provider.kind === 'ldap' ? 'LDAP' : result.provider.kind === 'sql' ? 'SQL' : 'Local'} password${next.trustedDevice ? ', trusted device' : ''}`,
      providerId: result.provider.id,
      ip: ip(req),
      userAgent: req.header('user-agent') ?? null,
      mfaVerified: next.mfaVerified
    });
    setSessionCookie(res, s, token, session.expires_at);
    // B-801: a sign-in from a new browser or network notifies the owner (the password was right, whatever comes next).
    await s.account.signIns.check(req, res, { tenantId: tenant.id, userId: prov.user.id, method: session.method, ip: ip(req) });
    await s.audit.append({
      tenantId: tenant.id,
      action: stage === 'active' ? 'auth.login' : stage === 'password' ? 'auth.login.pending_password' : 'auth.login.pending_mfa',
      kind: 'auth',
      actor: { user: prov.user.id, username: prov.user.username, name: prov.user.display_name, session: session.id, roles: prov.roles, ip: ip(req) },
      target: { provider: result.provider.name, kind: result.provider.kind },
      detail: { jit: prov.created, stage, ...(next.trustedDevice ? { trustedDevice: true } : {}), ...(next.enrolBy ? { mfaEnrolBy: next.enrolBy } : {}) },
      traceId: req.traceId
    });
    s.metrics.logins.inc({ result: stage === 'active' ? 'ok' : stage, kind: 'password' });
    const body2 = await sessionBody(session);
    res.json({ ...body2, mfa: { ...body2.mfa, ...(next.enrolBy ? { enrolBy: next.enrolBy } : {}), ...(next.trustedDevice ? { trustedDevice: true } : {}) } });
  });

  const pending = requireAuth({ stages: ['mfa'], sessionOnly: true });

  r.post('/mfa/totp', pending, async (req, res) => {
    const { code } = parseBody(z.object({ code: z.string().trim().regex(/^\d{6}$/), rememberDevice: z.boolean().optional() }), req.body);
    await reserveMfa(req, res);
    if (await s.mfa.verifyTotp(req.authSession!.user_id, code)) return completeMfa(req, res, 'TOTP');
    await failMfa(req, res, 'TOTP');
  });

  r.post('/mfa/recovery', pending, async (req, res) => {
    const { code } = parseBody(z.object({ code: z.string().trim().min(8).max(20), rememberDevice: z.boolean().optional() }), req.body);
    await reserveMfa(req, res);
    if (await s.mfa.useRecoveryCode(req.authSession!.user_id, code)) return completeMfa(req, res, 'recovery code');
    await failMfa(req, res, 'recovery code');
  });

  // Sprint 28a (B-1806): a one-time code by email. Sending is limited per user (MFA_EMAIL_SENDS_PER_HOUR); a wrong code
  // counts in the pending session's lockout exactly like a wrong TOTP code.
  r.post('/mfa/email/send', pending, async (req, res) => {
    const session = req.authSession as SessionRow;
    const factor = await s.mfa.emailFactor(session.user_id);
    if (!factor) throw conflict('This account has no email factor.');
    requireEmail(s);
    await admitSend(s, session.user_id);
    const user = await s.users.get(session.tenant_id, session.user_id);
    const { code, expiresAt } = await s.mfa.issueEmailCode(session.user_id, factor.id, 'signin', session.id, emailCodeTtlMs(s));
    await sendCode(s, { address: factor.address, name: user?.display_name ?? '', username: user?.username ?? '' }, code, 'signin');
    await s.audit.append({ tenantId: session.tenant_id, action: 'auth.mfa.email_sent', kind: 'auth', actor: actorFrom(req.principal, ip(req)), target: { factor: factor.id }, traceId: req.traceId });
    res.json({ sentTo: maskAddress(factor.address), expiresAt });
  });

  r.post('/mfa/email', pending, async (req, res) => {
    const { code } = parseBody(z.object({ code: z.string().trim().regex(/^\d{6}$/), rememberDevice: z.boolean().optional() }), req.body);
    await reserveMfa(req, res);
    if (await s.mfa.verifyEmailCode(req.authSession!.user_id, req.authSession!.id, code)) return completeMfa(req, res, 'email code');
    await failMfa(req, res, 'email code');
  });

  r.post('/mfa/webauthn/options', pending, async (req, res) => {
    const options = await s.mfa.authenticationOptions(req.authSession!.user_id);
    await s.sessions.setChallenge(req.authSession!.id, options.challenge);
    res.json(options);
  });

  r.post('/mfa/webauthn', pending, async (req, res) => {
    const { response } = parseBody(z.object({ response: z.looseObject({ id: z.string(), type: z.literal('public-key') }), rememberDevice: z.boolean().optional() }), req.body);
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

  /**
   * B-802: the strength meter behind every password form: an entropy estimate, the policy's rules one by one and,
   * when BREACHED_PASSWORDS is on, whether the password is in a breach corpus (only a hash prefix leaves). Needs a
   * session (change, forced change, admin set) or a live reset, invite or enrolment link, and is throttled.
   */
  r.post('/password/check', async (req, res) => {
    const body = parseBody(z.object({ password: z.string().max(1024), token: z.string().max(200).optional(), username: z.string().trim().max(190).optional(), breach: z.boolean().default(true) }), req.body);
    let username: string;
    let key: string;
    if (req.authSession) {
      const user = await s.users.get(req.authSession.tenant_id, req.authSession.user_id);
      // An identity admin setting someone else's password checks it against that user's name.
      username = body.username && req.principal && (effectivePermissions(req.principal).has('identity:manage') || effectivePermissions(req.principal).has('users:manage')) ? body.username : (user?.username ?? '');
      key = `pwcheck:s:${req.authSession.id}`;
    } else {
      const found = body.token ? await s.account.findToken(body.token) : null;
      const user = found ? await s.users.get(found.tenant_id, found.user_id) : undefined;
      if (!found || !user) throw unauthorized('Sign in, or open a valid password link, to check a password.');
      username = user.username;
      key = `pwcheck:t:${found.id}`;
    }
    if (!(await s.account.hit(key, 600, 3600_000))) throw tooManyRequests('Too many password checks. Try again later.', 600);
    const strength = estimateStrength(body.password, username);
    const rules = passwordRules(body.password, username);
    let breached: { mode: string; checked: boolean; found: boolean | null; unavailable: boolean } = { mode: s.cfg.BREACHED_PASSWORDS, checked: false, found: null, unavailable: false };
    if (s.cfg.BREACHED_PASSWORDS !== 'off' && body.breach && body.password.length >= 8) {
      const r2 = await s.account.breached.check(body.password);
      breached = { mode: s.cfg.BREACHED_PASSWORDS, checked: true, found: r2.breached, unavailable: !!r2.unavailable?.length };
    }
    res.json({ ...strength, rules, acceptable: rules.every((x) => x.ok) && breached.found !== true, breached });
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
    await s.audit.append({ tenantId: user.tenant_id, action: row.kind === 'invite' ? 'password.invite.accepted' : row.kind === 'enrol' ? 'password.enrol.accepted' : 'password.reset.completed', kind: 'auth', actor: { user: user.id, username: user.username, ip: ip(req) }, target: { user: user.id, username: user.username }, detail: { link: row.kind, sessionsRevoked: sessions, grantsRevoked: grants }, traceId: req.traceId });
    if (row.kind !== 'invite' && row.kind !== 'enrol') await securityAlert(s, { tenantId: user.tenant_id, userId: user.id, event: 'password.reset', detail: 'The password was set with a reset link and every session was signed out.', ip: ip(req) });
    const tenant = await s.tenants.byId(user.tenant_id);
    // B-810: an enrolment link signs the new admin straight into factor enrolment; no password-only session exists.
    if (row.kind === 'enrol' && !(await s.mfa.methods(user.id)).length) {
      if (req.authSession) await s.sessions.revoke(req.authSession.tenant_id, req.authSession.id);
      const local = (await s.providers.list(user.tenant_id)).find((x) => x.kind === 'local');
      const { token, session } = await s.sessions.create({ userId: user.id, tenantId: user.tenant_id, stage: 'enroll', method: 'Enrolment link', providerId: local?.id ?? null, ip: ip(req), userAgent: req.header('user-agent') ?? null });
      setSessionCookie(res, s, token, session.expires_at);
      await s.audit.append({ tenantId: user.tenant_id, action: 'auth.login.pending_mfa', kind: 'auth', actor: { user: user.id, username: user.username, session: session.id, ip: ip(req) }, target: { provider: local?.name ?? 'local', kind: 'local' }, detail: { stage: 'enroll', via: 'enrol_link' }, traceId: req.traceId });
      return void res.json({ reset: true, username: user.username, tenant: tenant?.slug ?? null, session: await sessionBody(session) });
    }
    res.json({ reset: true, username: user.username, tenant: tenant?.slug ?? null });
  });

  // ---------- Sprint 9: federation ----------

  /** What the sign-in screen can offer besides a password: upstream identity providers and Kerberos. Public. */
  r.get('/sign-in-options', async (req, res) => {
    const slug = typeof req.query.tenant === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(req.query.tenant) ? req.query.tenant : s.cfg.DEFAULT_TENANT;
    const t = await s.federation.tenantBySlug(slug);
    if (!t) return void res.json({ upstream: [], kerberos: false, signup: false });
    const base = slug === s.cfg.DEFAULT_TENANT ? '' : `/t/${slug}`;
    // Sprint 26 (B-1808): AT-Protocol stores too; their start page asks for the handle.
    const rows = (await s.providers.list(t.id)).filter((p) => p.enabled && signsInByRedirect(p.kind));
    const settings = await s.federation.settings(t.id);
    const kerberos = settings.kerberos.enabled && (await s.kerberos.status()).available;
    res.json({
      upstream: rows.map((p) => ({ id: p.id, name: p.name, protocol: p.kind, start: `${base}/federation/${p.kind}/start?provider=${p.id}` })),
      kerberos: kerberos ? { start: `${base}/auth/negotiate` } : false,
      // Sprint 26a (B-1801): whether this tenant takes sign-ups (and whether they wait for approval).
      signup: await s.identityPolicy.get(t.id).then((p) => (p.signup.mode === 'closed' ? false : { approval: p.signup.mode === 'approval', verifyEmail: p.signup.requireEmailVerification }))
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
    let next: string | null = null;
    if (req.authSession) {
      // B-808: front-channel logout too. The frame URLs are collected before the session (and its records) end, and
      // the console opens the signed-out page that loads them; back-channel logout follows the revocation as before.
      next = await signedOutPage(s, req.authSession.tenant_id, req.authSession.id).catch((err: unknown) => {
        s.log.warn({ err, trace_id: req.traceId }, 'front-channel logout could not be prepared');
        return null;
      });
      await s.sessions.revoke(req.authSession.tenant_id, req.authSession.id);
      const p = req.principal ?? (await loadPrincipal(s, req.authSession.tenant_id, req.authSession.user_id, { session: req.authSession }));
      await s.audit.append({ tenantId: req.authSession.tenant_id, action: 'auth.logout', kind: 'auth', actor: actorFrom(p, ip(req)), ...(next ? { detail: { frontChannel: true } } : {}), traceId: req.traceId });
    }
    clearSessionCookie(res, s);
    if (next) return void res.json({ signedOut: true, next });
    res.status(204).end();
  });

  return r;
}
