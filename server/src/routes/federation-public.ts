import express, { Router, type Request, type Response } from 'express';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { hmac, randomToken, safeEqual } from '../crypto/index.js';
import { json as parseJson } from '../db/knex.js';
import { rolesRequireMfa } from '../authz/permissions.js';
import { provision } from '../identity/provisioning.js';
import { isFederatedKind, type ExternalUser } from '../identity/providers/types.js';
import type { ProviderRow } from '../repos/providers.js';
import { clearSessionCookie, loadPrincipal, sessionTokenFrom, setSessionCookie } from '../http/middleware.js';
import { splitPrincipal } from '../federation/kerberos.js';
import { AuthorizeError, OAuthError, type AuthzRequest, type DpopInput, type SignedInUser, type TenantCtx } from '../federation/oidc.js';
import { SamlError } from '../federation/saml.js';
import { JwtError } from '../federation/jose.js';
import { UpstreamError, type SamlSubject } from '../federation/upstream.js';
import { CONSENT_REMEMBER_DAYS } from '../federation/service.js';
import type { SessionRow } from '../identity/sessions.js';
import type { Services } from '../services.js';

const REFUSALS: Record<string, string> = {
  disabled: 'This account is disabled. Ask an identity admin.',
  no_mapped_group: 'Your account is not in a group mapped to this tenant. Ask an identity admin.',
  identity_conflict: 'This username is already linked to a different user store. Ask an identity admin.'
};

const esc = (v: unknown): string => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Where a protocol flow may send the browser after sign-in: our own protocol pages, never another origin. */
export const safeReturn = (v: unknown): string | null =>
  typeof v === 'string' && v.length <= 4000 && /^\/(t\/[a-z0-9][a-z0-9-]{0,62}\/)?(oauth\/authorize\?|saml\/continue\?|device(\?|$))/.test(v) && !v.includes('\\') ? v : null;

const FED_COOKIE = 'exai_fed';

/**
 * What a public page may say about a failed upstream sign-in: our own checks (state, nonce, signature, issuer) are
 * named, while anything else (network errors, refused internal addresses, driver errors) gets `fallback` and goes
 * to the log only.
 */
export const publicReason = (err: unknown, fallback: string): string => (err instanceof UpstreamError || err instanceof SamlError ? err.message : fallback);

/** Browser sign-in endpoints and userinfo: requests per client address per minute (token endpoints have their own). */
export const SIGN_IN_POINTS = 120;
const SIGN_IN_PATHS = ['/oauth/authorize', '/oauth/userinfo', '/device', '/saml/sso', '/saml/continue', '/federation/oidc/start', '/federation/saml/start', '/federation/oidc/callback', '/federation/saml/acs', '/auth/negotiate', '/oauth/logout', '/saml/slo', '/federation/saml/slo'];

/** First value of each string field; repeated OAuth parameters are refused (RFC 6749 3.1). */
function formOf(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!body || typeof body !== 'object') return out;
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (Array.isArray(v)) throw new OAuthError(400, 'invalid_request', `Parameter ${k} is repeated.`);
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/**
 * Public protocol endpoints mounted at the root, outside /api: OIDC discovery, JWKS, authorize, token, userinfo,
 * revocation, device authorization, SAML metadata and SSO, upstream OIDC and SAML callbacks, and Kerberos SPNEGO.
 *
 * The default tenant's endpoints are at the root (`/oauth/token`); other tenants' under `/t/<slug>/…`, matching their
 * issuers. Each router path resolves its tenant itself, so unrelated requests pass through without a lookup.
 * Pages that need a signed-in user and arrive without the (SameSite=Strict) session cookie, as every cross-site
 * redirect does, render a small "continue" page whose script re-checks the session from our own origin and resumes,
 * or sends the browser to the console sign-in with the resume address kept in sessionStorage.
 */
export function federationPublicRoutes(s: Services): Router {
  const root = Router();
  const r = Router({ mergeParams: true });
  root.use('/t/:tenant', r);
  root.use(r);

  const smallForm = express.urlencoded({ extended: false, limit: '64kb', parameterLimit: 50 });
  const largeForm = express.urlencoded({ extended: false, limit: '1mb', parameterLimit: 20 });
  const tokenLimiter = new RateLimiterMemory({ points: 60, duration: 60 });
  const signInLimiter = new RateLimiterMemory({ points: SIGN_IN_POINTS, duration: 60 });
  const fed = () => s.federation;

  const tenantOf = async (req: Request): Promise<TenantCtx | null> => {
    const slug = typeof req.params.tenant === 'string' ? req.params.tenant : s.cfg.DEFAULT_TENANT;
    // The default tenant lives at the root only, so it has exactly one issuer.
    if (req.params.tenant !== undefined && slug === s.cfg.DEFAULT_TENANT) return null;
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) return null;
    return fed().tenantBySlug(slug);
  };

  // ---------- pages ----------

  const page = (res: Response, status: number, title: string, body: string, opts: { mode?: string; data?: Record<string, string>; formAction?: string[]; frameSrc?: string[] } = {}) => {
    res.status(status).setHeader('Cache-Control', 'no-store');
    const clean = (list: string[]) => list.map((o) => o.replace(/[;\s'"]/g, '')).join(' ');
    if (opts.formAction) {
      // A form that posts (or redirects) to a relying party needs its origin in form-action.
      const csp = String(res.getHeader('Content-Security-Policy') ?? '');
      if (csp) res.setHeader('Content-Security-Policy', csp.replace(/form-action [^;]*/, `form-action 'self' ${clean(opts.formAction)}`));
    }
    if (opts.frameSrc?.length) {
      // Only the logout page frames other origins: exactly the registered front-channel logout origins.
      const csp = String(res.getHeader('Content-Security-Policy') ?? '');
      if (csp) res.setHeader('Content-Security-Policy', `${csp};frame-src ${clean(opts.frameSrc)}`);
    }
    const data = Object.entries(opts.data ?? {}).map(([k, v]) => ` data-${k}="${esc(v)}"`).join('');
    res.type('html').send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · Exprsn-AI</title><link rel="stylesheet" href="/css/app.css">${opts.mode ? '<script src="/js/federation.js" defer></script>' : ''}</head>` +
        `<body style="overflow:auto"${opts.mode ? ` data-mode="${esc(opts.mode)}"` : ''}${data}><div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px"><div class="panel" style="width:440px;max-width:100%;gap:14px;padding:28px"><div><div class="eyebrow" style="letter-spacing:.08em">Exprsn-AI</div><div style="font-size:20px;font-weight:600">${esc(title)}</div></div>${body}</div></div></body></html>`
    );
  };

  const errorPage = (res: Response, status: number, title: string, detail: string, req: Request) =>
    page(res, status, title, `<div class="notice danger">${esc(detail)}</div><div class="muted mono" style="font-size:11px">trace ${esc(req.traceId)}</div><div><a class="btn" href="/">Open the console</a></div>`);

  /** Asks the browser to re-check the session from our origin and resume at `url`, or sign in first. */
  const continuePage = (res: Response, url: string) =>
    page(res, 200, 'Sign in to continue', `<p class="fg2" style="margin:0">Checking your session…</p><noscript><p class="fg2">Sign in to the console, then open this address again.</p></noscript><div><a class="btn primary" href="/#/signin" data-signin>Sign in</a></div>`, { mode: 'continue', data: { continue: url } });

  // Sign-in pages, SAML and upstream callbacks (which parse up to 1 MB of XML) and Kerberos are throttled per address.
  r.use(SIGN_IN_PATHS, async (req, res, next) => {
    try {
      await signInLimiter.consume(req.ip ?? 'unknown');
      next();
    } catch (rej) {
      if (rej instanceof Error) return next(rej);
      const ms = (rej as { msBeforeNext?: number }).msBeforeNext ?? 1000;
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(ms / 1000))));
      if (req.path.startsWith('/oauth/userinfo')) return void res.status(429).setHeader('Cache-Control', 'no-store').json({ error: 'slow_down', error_description: 'Too many requests.' });
      errorPage(res, 429, 'Too many requests', 'Too many sign-in requests from this address. Wait a minute and try again.', req);
    }
  });

  // ---------- sessions ----------

  const sessionOf = async (req: Request): Promise<{ session: SessionRow; user: SignedInUser } | null> => {
    const token = sessionTokenFrom(req.headers.cookie, s.cfg.COOKIE_SECURE);
    if (!token) return null;
    const session = await s.sessions.resolve(token);
    if (!session || session.stage !== 'active') return null;
    const p = await loadPrincipal(s, session.tenant_id, session.user_id, { session });
    if (!p) return null;
    await s.sessions.touch(session);
    return { session, user: { tenantId: session.tenant_id, userId: session.user_id, sessionId: session.id, method: session.method, authTime: session.created_at } };
  };

  /** Finishes a federated or Kerberos sign-in exactly as a password sign-in does: JIT provisioning, second factor for admin roles, audit. */
  const completeSignIn = async (req: Request, res: Response, t: TenantCtx, row: ProviderRow, ext: ExternalUser, method: string, kind: string, returnTo: string | null, extraHeaders: Record<string, string> = {}, afterSession?: (sessionId: string) => Promise<void>) => {
    const prov = await provision(s.users, t.id, row, ext);
    if (prov.status === 'refused') {
      await s.audit.append({ tenantId: t.id, action: 'auth.login.refused', kind: 'auth', actor: { username: ext.username, user: prov.user?.id, ip: req.ip ?? null }, target: { provider: row.name, kind, groups: ext.groups.length }, detail: { reason: prov.reason }, traceId: req.traceId });
      s.metrics.logins.inc({ result: prov.reason, kind });
      return errorPage(res, 403, 'Sign-in refused', REFUSALS[prov.reason] ?? 'Sign-in refused.', req);
    }
    const old = sessionTokenFrom(req.headers.cookie, s.cfg.COOKIE_SECURE);
    if (old) {
      const prev = await s.sessions.resolve(old);
      if (prev) await s.sessions.revoke(prev.tenant_id, prev.id);
    }
    const methods = await s.mfa.methods(prov.user.id);
    // Upstream and Kerberos sign-ins count as the first factor only: admin roles still need their second factor.
    const needsMfa = prov.user.mfa_required || rolesRequireMfa(prov.roles);
    const stage = methods.length ? 'mfa' : needsMfa ? 'enroll' : 'active';
    const { token, session } = await s.sessions.create({ userId: prov.user.id, tenantId: t.id, stage, method, providerId: row.id, ip: req.ip ?? null, userAgent: req.header('user-agent') ?? null });
    setSessionCookie(res, s, token, session.expires_at);
    if (afterSession) await afterSession(session.id);
    await s.audit.append({
      tenantId: t.id,
      action: stage === 'active' ? 'auth.login' : 'auth.login.pending_mfa',
      kind: 'auth',
      actor: { user: prov.user.id, username: prov.user.username, name: prov.user.display_name, session: session.id, roles: prov.roles, ip: req.ip ?? null },
      target: { provider: row.name, kind },
      detail: { jit: prov.created, stage, method },
      traceId: req.traceId
    });
    s.metrics.logins.inc({ result: stage === 'active' ? 'ok' : stage, kind });
    for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
    res.setHeader('Cache-Control', 'no-store');
    // A pending second factor is finished in the console, which then resumes the flow from sessionStorage.
    res.redirect(302, stage === 'active' && returnTo ? returnTo : '/');
  };

  // ---------- OIDC discovery and keys ----------

  r.get('/.well-known/openid-configuration', async (req, res) => {
    const t = await tenantOf(req);
    if (!t) return void res.status(404).json({ error: 'not_found' });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(fed().oidc.discovery(t));
  });

  r.get('/.well-known/jwks.json', async (req, res) => {
    const t = await tenantOf(req);
    if (!t) return void res.status(404).json({ error: 'not_found' });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(await fed().keys.jwks(t.id));
  });

  // ---------- authorization endpoint ----------

  const redirectTo = (res: Response, t: TenantCtx, uri: string, params: Record<string, string | null>) => {
    const u = new URL(uri);
    for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
    u.searchParams.set('iss', t.issuer); // RFC 9207
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, u.toString());
  };

  const pendingId = (handle: string) => hmac(s.cfg.SESSION_SECRET, `federation-pending:${handle}`);
  const consentToken = (handle: string, sessionId: string) => hmac(s.cfg.SESSION_SECRET, `consent:${handle}:${sessionId}`);
  const reauthToken = (at: number, clientId: string) => `${at}.${hmac(s.cfg.SESSION_SECRET, `reauth:${at}:${clientId}`).slice(0, 32)}`;
  /** The time a re-authentication was asked for, when `v` is a token this server made for this client (a day at most). */
  const reauthAfter = (v: unknown, clientId: string): number | null => {
    if (typeof v !== 'string' || !/^\d{13}\.[0-9a-f]{32}$/.test(v)) return null;
    const at = Number(v.slice(0, 13));
    return safeEqual(v, reauthToken(at, clientId)) && Date.now() - at < 86_400_000 ? at : null;
  };

  const issueAndRedirect = async (req: Request, res: Response, t: TenantCtx, clientId: string, areq: AuthzRequest, user: SignedInUser, scopes: string[], par: string | null = null) => {
    const client = await fed().oidc.byClientId(t.id, clientId);
    if (!client || client.status !== 'active') return errorPage(res, 400, 'Authorization failed', 'This client is disabled.', req);
    // A pushed request works once: whoever answers it first uses it up.
    if (!(await fed().oidc.claimPushed(par))) return errorPage(res, 400, 'Authorization failed', 'This pushed request was already used. Start again from the application.', req);
    const code = await fed().oidc.issueCode(t, client, areq, user, scopes);
    await s.audit.append({ tenantId: t.id, action: 'oidc.authorized', kind: 'auth', actor: { user: user.userId, session: user.sessionId ?? undefined, ip: req.ip ?? null }, target: { client: client.client_id, name: client.name }, detail: { scopes }, traceId: req.traceId });
    redirectTo(res, t, areq.redirectUri, { code, state: areq.state });
  };

  r.get('/oauth/authorize', async (req, res) => {
    const t = await tenantOf(req);
    if (!t) return errorPage(res, 404, 'Unknown tenant', 'No active tenant answers at this address.', req);
    let v;
    try {
      v = await fed().oidc.validateAuthorize(t, req.query as Record<string, unknown>);
    } catch (err) {
      if (!(err instanceof AuthorizeError)) throw err;
      if (!err.redirect) return errorPage(res, 400, 'Authorization failed', err.message, req);
      const q = req.query as Record<string, unknown>;
      return redirectTo(res, t, String(q.redirect_uri), { error: err.error, error_description: err.message, state: typeof q.state === 'string' ? q.state : null });
    }
    const { client, req: areq, par } = v;
    const fail = async (error: string, description?: string) => {
      await fed().oidc.claimPushed(par);
      redirectTo(res, t, areq.redirectUri, { error, ...(description ? { error_description: description } : {}), state: areq.state });
    };
    const prompts = (areq.prompt ?? '').split(' ');
    const signed = await sessionOf(req);
    if (!signed) {
      if (prompts.includes('none')) return fail('login_required');
      return continuePage(res, req.originalUrl);
    }
    if (signed.user.tenantId !== t.id) return errorPage(res, 403, 'Wrong tenant', 'You are signed in to another tenant. Sign out of the console and sign in to this one.', req);
    // prompt=login and max_age (B-402): a sign-in that is not fresh enough is repeated. The resume address carries a
    // signed time; a session created after it proves the new sign-in, so prompt=login does not ask twice.
    const fresh = reauthAfter(req.query.reauth, client.client_id);
    const tooOld = areq.maxAge != null && Date.now() - signed.session.created_at > areq.maxAge * 1000;
    if ((prompts.includes('login') && !(fresh != null && signed.session.created_at >= fresh)) || tooOld) {
      if (prompts.includes('none')) return fail('login_required');
      const resume = new URL(req.originalUrl, 'http://x');
      resume.searchParams.set('reauth', reauthToken(Date.now(), client.client_id));
      await s.audit.append({ tenantId: t.id, action: 'oidc.reauth.required', kind: 'auth', actor: { user: signed.user.userId, session: signed.session.id, ip: req.ip ?? null }, target: { client: client.client_id, name: client.name }, detail: { prompt: areq.prompt, maxAge: areq.maxAge, sessionAgeS: Math.round((Date.now() - signed.session.created_at) / 1000) }, traceId: req.traceId });
      return page(res, 200, 'Sign in again', `<p class="fg2" style="margin:0"><b>${esc(client.name)}</b> asks you to sign in again before it continues. You are signed out of this session first.</p><noscript><p class="fg2">Sign out of the console, sign in again, then open this address again.</p></noscript><div><a class="btn primary" href="/#/signin" data-signin>Sign in again</a></div>`, { mode: 'reauth', data: { continue: resume.pathname + resume.search } });
    }
    const scopes = await fed().oidc.grantableScopes(t.id, signed.user.userId, client, areq.scopes);
    if (!scopes.length) return fail('invalid_scope', 'None of the requested scopes can be granted to you.');
    const settings = await fed().settings(t.id);
    const ask = prompts.includes('consent') || (await fed().oidc.needsConsent(t.id, client, signed.user.userId, scopes, settings.consent));
    if (!ask) return issueAndRedirect(req, res, t, client.client_id, areq, signed.user, scopes, par);
    if (prompts.includes('none')) return fail('consent_required');
    if (!(await fed().oidc.claimPushed(par))) return errorPage(res, 400, 'Authorization failed', 'This pushed request was already used. Start again from the application.', req);
    const handle = randomToken(24);
    await s.db('federation_pending').insert({ id: pendingId(handle), tenant_id: t.id, kind: 'authz', data: JSON.stringify({ clientId: client.client_id, req: areq, scopes, userId: signed.user.userId, sessionId: signed.session.id }), expires_at: Date.now() + 10 * 60_000 });
    const action = req.baseUrl + '/oauth/authorize';
    page(
      res,
      200,
      `Allow ${client.name}`,
      `<p class="fg2" style="margin:0"><b>${esc(client.name)}</b> asks to act as you in ${esc(t.name)} with these permissions. Your roles and clearance still apply; scopes never widen them.</p>` +
        `<ul class="mono" style="margin:0;padding-left:18px;font-size:12px">${scopes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` +
        `<div class="muted" style="font-size:12px">Returns to ${esc(new URL(areq.redirectUri).origin)}.${settings.consent.remember ? ` Your answer is remembered for ${CONSENT_REMEMBER_DAYS} days.` : ''}</div>` +
        `<form method="post" action="${esc(action)}" class="hstack gap6"><input type="hidden" name="handle" value="${esc(handle)}"><input type="hidden" name="csrf" value="${esc(consentToken(handle, signed.session.id))}">` +
        `<button type="submit" class="btn primary" name="decision" value="allow">Allow</button><button type="submit" class="btn" name="decision" value="deny">Deny</button></form>`,
      { formAction: [new URL(areq.redirectUri).origin] }
    );
  });

  r.post('/oauth/authorize', smallForm, async (req, res) => {
    const t = await tenantOf(req);
    if (!t) return errorPage(res, 404, 'Unknown tenant', 'No active tenant answers at this address.', req);
    const origin = req.headers.origin;
    if (origin && origin !== s.cfg.ORIGIN && origin !== 'null') return errorPage(res, 403, 'Refused', 'Cross-origin request refused.', req);
    let form: Record<string, string>;
    try {
      form = formOf(req.body);
    } catch {
      return errorPage(res, 400, 'Authorization failed', 'Malformed request.', req);
    }
    const signed = await sessionOf(req);
    if (!signed || !form.handle) return errorPage(res, 401, 'Sign in again', 'Your session ended. Start again from the application.', req);
    const id = pendingId(form.handle);
    const row = (await s.db('federation_pending').where({ id, tenant_id: t.id, kind: 'authz' }).first()) as { data: string; expires_at: number } | undefined;
    if (!row || Number(row.expires_at) < Date.now()) return errorPage(res, 400, 'Authorization expired', 'This request expired. Start again from the application.', req);
    const data = parseJson<{ clientId: string; req: AuthzRequest; scopes: string[]; userId: string; sessionId: string }>(row.data, { clientId: '', req: {} as AuthzRequest, scopes: [], userId: '', sessionId: '' });
    if (data.sessionId !== signed.session.id || !form.csrf || !safeEqual(form.csrf, consentToken(form.handle, signed.session.id))) return errorPage(res, 403, 'Refused', 'This consent form belongs to another session.', req);
    await s.db('federation_pending').where({ id }).delete();
    const client = await fed().oidc.byClientId(t.id, data.clientId);
    if (!client) return errorPage(res, 400, 'Authorization failed', 'Unknown client.', req);
    if (form.decision !== 'allow') {
      await s.audit.append({ tenantId: t.id, action: 'oidc.consent.denied', kind: 'auth', actor: { user: signed.user.userId, ip: req.ip ?? null }, target: { client: client.client_id, name: client.name }, traceId: req.traceId });
      return redirectTo(res, t, data.req.redirectUri, { error: 'access_denied', error_description: 'The user denied the request.', state: data.req.state });
    }
    const settings = await fed().settings(t.id);
    await fed().oidc.recordConsent(t.id, client, signed.user.userId, data.scopes, settings.consent.remember ? CONSENT_REMEMBER_DAYS : 0);
    await s.audit.append({ tenantId: t.id, action: 'oidc.consent.granted', kind: 'auth', actor: { user: signed.user.userId, ip: req.ip ?? null }, target: { client: client.client_id, name: client.name }, detail: { scopes: data.scopes, remembered: settings.consent.remember }, traceId: req.traceId });
    // Grants changed (B-107): the user is told, and can revoke the access under Settings. Sprint 11's security-notice
    // helper replaces this direct call when it merges.
    await s.notifications.notify({ tenantId: t.id, userIds: [signed.user.userId], kind: 'security', title: `${client.name} can now act as you`, body: `You allowed ${client.name}: ${data.scopes.join(', ')}. You can remove its access under Settings, Connected applications.`, route: 'settings' });
    return issueAndRedirect(req, res, t, client.client_id, data.req, signed.user, data.scopes);
  });

  // ---------- token, userinfo, revocation, device authorization ----------

  const oauthError = (res: Response, err: unknown, req: Request) => {
    res.setHeader('Cache-Control', 'no-store');
    if (err instanceof OAuthError) {
      for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v);
      return void res.status(err.status).json({ error: err.error, error_description: err.message });
    }
    s.log.error({ err, trace_id: req.traceId }, 'oauth endpoint error');
    res.status(500).json({ error: 'server_error', error_description: 'Something went wrong on our side.', trace_id: req.traceId });
  };

  const limited = async (req: Request, res: Response): Promise<boolean> => {
    try {
      await tokenLimiter.consume(req.ip ?? 'unknown');
      return false;
    } catch (rej) {
      const ms = (rej as { msBeforeNext?: number }).msBeforeNext ?? 1000;
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(ms / 1000))));
      res.status(429).json({ error: 'slow_down', error_description: 'Too many requests.' });
      return true;
    }
  };

  r.post('/oauth/token', smallForm, async (req, res) => {
    if (await limited(req, res)) return;
    const t = await tenantOf(req);
    if (!t) return void res.status(404).json({ error: 'invalid_request', error_description: 'Unknown tenant.' });
    try {
      const out = await fed().oidc.token(t, formOf(req.body), req.header('authorization'), { proof: req.header('dpop'), method: 'POST', url: `${t.issuer}/oauth/token` });
      await s.audit.append({ tenantId: t.id, action: 'oidc.token.issued', kind: 'auth', actor: { user: out.userId, service: out.client.client_id, ip: req.ip ?? null }, target: { client: out.client.client_id, name: out.client.name }, detail: { grant: out.grant, scope: out.response.scope, refresh: !!out.response.refresh_token, type: out.response.token_type }, traceId: req.traceId });
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
      res.json(out.response);
    } catch (err) {
      if (err instanceof OAuthError && ['invalid_client', 'invalid_grant', 'invalid_dpop_proof'].includes(err.error)) {
        await s.audit.append({ tenantId: t.id, action: 'oidc.token.refused', kind: 'auth', actor: { ip: req.ip ?? null }, target: { client: String((req.body as Record<string, unknown> | undefined)?.client_id ?? '') }, detail: { error: err.error, reason: err.message }, traceId: req.traceId });
      }
      oauthError(res, err, req);
    }
  });

  const userinfo = async (req: Request, res: Response) => {
    const t = await tenantOf(req);
    if (!t) return void res.status(404).json({ error: 'invalid_request' });
    const m = /^(Bearer|DPoP)\s+(\S+)$/i.exec(req.header('authorization') ?? '');
    const token = m?.[2] ?? (req.method === 'POST' ? formOf(req.body).access_token : undefined);
    const scheme = m?.[1]?.toLowerCase() === 'dpop' ? 'dpop' : 'bearer';
    res.setHeader('Cache-Control', 'no-store');
    if (!token) return void res.status(401).setHeader('WWW-Authenticate', 'Bearer').json({ error: 'invalid_token', error_description: 'An access token is required.' });
    try {
      const dpop: DpopInput = { proof: req.header('dpop'), method: req.method, url: `${t.issuer}/oauth/userinfo` };
      res.json(await fed().oidc.userinfo(t, token, { scheme, dpop }));
    } catch (err) {
      if (!(err instanceof JwtError)) s.log.warn({ err, trace_id: req.traceId }, 'userinfo failed');
      const why = err instanceof JwtError ? err.message.replace(/["\\\r\n]/g, "'") : 'The access token could not be verified.';
      res.status(401).setHeader('WWW-Authenticate', `Bearer error="invalid_token", error_description="${why}"`).json({ error: 'invalid_token', error_description: why });
    }
  };
  r.get('/oauth/userinfo', userinfo);
  r.post('/oauth/userinfo', smallForm, userinfo);

  r.post('/oauth/revoke', smallForm, async (req, res) => {
    if (await limited(req, res)) return;
    const t = await tenantOf(req);
    if (!t) return void res.status(404).json({ error: 'invalid_request' });
    try {
      const out = await fed().oidc.revoke(t, formOf(req.body), req.header('authorization'));
      if (out.revoked) await s.audit.append({ tenantId: t.id, action: 'oidc.token.revoked', kind: 'auth', actor: { service: out.client.client_id, ip: req.ip ?? null }, target: { client: out.client.client_id }, detail: { token: out.revoked }, traceId: req.traceId });
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).end();
    } catch (err) {
      oauthError(res, err, req);
    }
  });

  /** RFC 7662: introspection for confidential clients; a token is active only for the client it was issued to. */
  r.post('/oauth/introspect', smallForm, async (req, res) => {
    if (await limited(req, res)) return;
    const t = await tenantOf(req);
    if (!t) return void res.status(404).json({ error: 'invalid_request' });
    try {
      const out = await fed().oidc.introspect(t, formOf(req.body), req.header('authorization'));
      res.setHeader('Cache-Control', 'no-store');
      res.json(out.response);
    } catch (err) {
      oauthError(res, err, req);
    }
  });

  /** RFC 9126: pushed authorization requests; the request_uri is good for 60 seconds and one authorization. */
  r.post('/oauth/par', smallForm, async (req, res) => {
    if (await limited(req, res)) return;
    const t = await tenantOf(req);
    if (!t) return void res.status(404).json({ error: 'invalid_request' });
    try {
      const out = await fed().oidc.pushRequest(t, formOf(req.body), req.header('authorization'));
      await s.audit.append({ tenantId: t.id, action: 'oidc.par.pushed', kind: 'auth', actor: { service: out.client.client_id, ip: req.ip ?? null }, target: { client: out.client.client_id, name: out.client.name }, traceId: req.traceId });
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json(out.response);
    } catch (err) {
      oauthError(res, err, req);
    }
  });

  // ---------- logout (RP-initiated, front-channel; back-channel runs as jobs when the session ends) ----------

  /**
   * The signed-out page: hidden frames load each front-channel logout URL (OIDC clients, SAML SPs over the redirect
   * binding), then the page continues to `next` or posts `form`. frame-src names exactly those origins.
   */
  const logoutPage = (res: Response, frames: string[], next: string | null, form: { url: string; fields: Record<string, string> } | null, lead: string) => {
    const origin = (u: string) => new URL(u).origin;
    page(
      res,
      200,
      'Signed out',
      `<p class="fg2" style="margin:0">${esc(lead)}</p>` +
        frames.map((u) => `<iframe src="${esc(u)}" title="Sign-out notice to ${esc(origin(u))}" hidden></iframe>`).join('') +
        (form ? `<form method="post" action="${esc(form.url)}" data-logoutpost>${Object.entries(form.fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')}<button type="submit" class="btn primary">Continue</button></form>` : next ? `<div><a class="btn primary" href="${esc(next)}" data-next>Continue</a></div>` : `<div><a class="btn" href="/">Open the console</a></div>`),
      { mode: 'logout', data: next ? { continue: next } : {}, frameSrc: [...new Set(frames.map(origin))], ...(form ? { formAction: [origin(form.url)] } : {}) }
    );
  };

  /** The front-channel URLs for sessions that are ending: OIDC clients, then SAML SPs other than `exceptSp`. */
  const frontChannel = async (t: TenantCtx, sessionIds: string[], exceptSp: string | null) => {
    const out: string[] = [];
    for (const id of sessionIds) out.push(...(await fed().oidc.frontChannelUrls(t, id)));
    out.push(...(await fed().saml.logoutRequestUrls(t, sessionIds, exceptSp)));
    return [...new Set(out)].slice(0, 20);
  };

  const withQuery = (uri: string, params: Record<string, string | null>) => {
    const u = new URL(uri);
    for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
    return u.toString();
  };

  /**
   * end_session_endpoint. The request (GET or a cross-site POST) is checked, then a confirmation page posts back
   * from our own origin, which carries the SameSite=Strict session cookie and prevents cross-site sign-out.
   */
  const endSession = async (req: Request, res: Response, params: Record<string, unknown>) => {
    const t = await tenantOf(req);
    if (!t) return errorPage(res, 404, 'Unknown tenant', 'No active tenant answers at this address.', req);
    let v;
    try {
      v = await fed().oidc.checkLogout(t, params);
    } catch (err) {
      if (!(err instanceof AuthorizeError)) throw err;
      return errorPage(res, 400, 'Sign-out failed', err.message, req);
    }
    const handle = randomToken(24);
    await s.db('federation_pending').insert({ id: pendingId(handle), tenant_id: t.id, kind: 'logout', data: JSON.stringify({ clientId: v.client?.client_id ?? null, userId: v.userId, redirect: v.redirect, state: v.state }), expires_at: Date.now() + 10 * 60_000 });
    page(
      res,
      200,
      'Sign out',
      `<p class="fg2" style="margin:0">${v.client ? `<b>${esc(v.client.name)}</b> asks to sign you out of ${esc(t.name)}.` : `Sign out of ${esc(t.name)}?`} Applications you signed in to through this session are told too.</p>` +
        `<form method="post" action="${esc(req.baseUrl + '/oauth/logout')}" class="hstack gap6"><input type="hidden" name="handle" value="${esc(handle)}">` +
        `<button type="submit" class="btn primary" name="decision" value="logout">Sign out</button><button type="submit" class="btn" name="decision" value="stay">Stay signed in</button></form>`
    );
  };

  r.get('/oauth/logout', async (req, res) => endSession(req, res, req.query as Record<string, unknown>));

  r.post('/oauth/logout', smallForm, async (req, res) => {
    let form: Record<string, string>;
    try {
      form = formOf(req.body);
    } catch {
      return errorPage(res, 400, 'Sign-out failed', 'Malformed request.', req);
    }
    if (!form.handle) return endSession(req, res, form);
    const t = await tenantOf(req);
    if (!t) return errorPage(res, 404, 'Unknown tenant', 'No active tenant answers at this address.', req);
    const origin = req.headers.origin;
    if (origin && origin !== s.cfg.ORIGIN && origin !== 'null') return errorPage(res, 403, 'Refused', 'Cross-origin request refused.', req);
    const id = pendingId(form.handle);
    const row = (await s.db('federation_pending').where({ id, tenant_id: t.id, kind: 'logout' }).first()) as { data: string; expires_at: number } | undefined;
    if (!row || Number(row.expires_at) < Date.now() || !(await s.db('federation_pending').where({ id }).delete())) return errorPage(res, 400, 'Sign-out expired', 'This sign-out request expired or was already used. Start again from the application.', req);
    const data = parseJson<{ clientId: string | null; userId: string | null; redirect: string | null; state: string | null }>(row.data, { clientId: null, userId: null, redirect: null, state: null });
    let next = data.redirect ? withQuery(data.redirect, { state: data.state }) : null;
    if (form.decision !== 'logout') {
      if (next) {
        res.setHeader('Cache-Control', 'no-store');
        return void res.redirect(302, next);
      }
      return page(res, 200, 'Still signed in', `<p class="fg2" style="margin:0">You are still signed in.</p><div><a class="btn" href="/">Open the console</a></div>`);
    }
    const token = sessionTokenFrom(req.headers.cookie, s.cfg.COOKIE_SECURE);
    const session = token ? await s.sessions.resolve(token) : null;
    let frames: string[] = [];
    if (session && session.tenant_id === t.id) {
      if (data.userId && data.userId !== session.user_id) return errorPage(res, 403, 'Not signed out', 'The application asked to sign out a different user. You are still signed in.', req);
      frames = await frontChannel(t, [session.id], null);
      const upstreamLogout = await fed().upstream.startSamlLogout(t, session.id, next).catch((err: unknown) => {
        s.log.warn({ err, trace_id: req.traceId }, 'upstream SAML logout could not start');
        return null;
      });
      await s.sessions.revoke(t.id, session.id);
      await s.audit.append({ tenantId: t.id, action: 'auth.logout', kind: 'auth', actor: { user: session.user_id, session: session.id, ip: req.ip ?? null }, target: { client: data.clientId }, detail: { via: 'end_session', frontChannel: frames.length, upstream: !!upstreamLogout }, traceId: req.traceId });
      if (upstreamLogout) next = upstreamLogout;
    }
    clearSessionCookie(res, s);
    logoutPage(res, frames, next, null, frames.length ? 'You are signed out. The applications you used in this session are being told.' : 'You are signed out.');
  });

  r.post('/oauth/device_authorization', smallForm, async (req, res) => {
    if (await limited(req, res)) return;
    const t = await tenantOf(req);
    if (!t) return void res.status(404).json({ error: 'invalid_request' });
    try {
      const out = await fed().oidc.deviceAuthorization(t, formOf(req.body), req.header('authorization'));
      res.setHeader('Cache-Control', 'no-store');
      res.json(out);
    } catch (err) {
      oauthError(res, err, req);
    }
  });

  /** The verification page: the signed-in user enters (or confirms) the code and approves it through /api/auth/device. */
  r.get('/device', async (req, res) => {
    const t = await tenantOf(req);
    if (!t) return errorPage(res, 404, 'Unknown tenant', 'No active tenant answers at this address.', req);
    const code = typeof req.query.user_code === 'string' ? req.query.user_code.toUpperCase().replace(/[^A-Z-]/g, '').slice(0, 9) : '';
    page(
      res,
      200,
      'Connect a device',
      `<p class="fg2" style="margin:0">Enter the code your device shows. You approve it as the user signed in to this browser.</p>` +
        `<form class="vstack gap12" data-device><div class="field"><label for="uc">Code</label><input class="input mono" id="uc" name="user_code" value="${esc(code)}" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX" style="letter-spacing:.2em;font-size:18px;height:40px"></div>` +
        `<div data-out></div><div class="hstack gap6"><button type="submit" class="btn primary" data-lookup>Continue</button></div></form>`,
      { mode: 'device', data: { continue: req.originalUrl } }
    );
  });

  // ---------- SAML IdP ----------

  r.get('/saml/metadata', async (req, res) => {
    const t = await tenantOf(req);
    if (!t) return void res.status(404).end();
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Content-Disposition', 'inline; filename="idp-metadata.xml"');
    res.type('application/samlmetadata+xml').send(await fed().saml.metadata(t));
  });

  const sso = async (req: Request, res: Response, binding: 'redirect' | 'post') => {
    const t = await tenantOf(req);
    if (!t) return errorPage(res, 404, 'Unknown tenant', 'No active tenant answers at this address.', req);
    const src = binding === 'redirect' ? (req.query as Record<string, unknown>) : ((req.body ?? {}) as Record<string, unknown>);
    const samlRequest = typeof src.SAMLRequest === 'string' ? src.SAMLRequest : '';
    const relay = typeof src.RelayState === 'string' ? src.RelayState.slice(0, 80) : null;
    if (!samlRequest) return errorPage(res, 400, 'SAML sign-in failed', 'The request has no SAMLRequest.', req);
    try {
      const rawQuery = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : '';
      const { sp, acs, request } = await fed().saml.parseRequest(t, binding, samlRequest, rawQuery);
      const handle = randomToken(24);
      await s.db('federation_pending').insert({ id: pendingId(handle), tenant_id: t.id, kind: 'saml_authn', data: JSON.stringify({ spId: sp.id, acs, requestId: request.id, relay, forceAuthn: request.forceAuthn }), expires_at: Date.now() + 10 * 60_000 });
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(302, `${req.baseUrl}/saml/continue?h=${encodeURIComponent(handle)}`);
    } catch (err) {
      if (!(err instanceof SamlError)) throw err;
      await s.audit.append({ tenantId: t.id, action: 'saml.sso.refused', kind: 'auth', actor: { ip: req.ip ?? null }, detail: { reason: err.message }, traceId: req.traceId });
      errorPage(res, 400, 'SAML sign-in failed', err.message, req);
    }
  };
  r.get('/saml/sso', (req, res) => sso(req, res, 'redirect'));
  r.post('/saml/sso', largeForm, (req, res) => sso(req, res, 'post'));

  r.get('/saml/continue', async (req, res) => {
    const t = await tenantOf(req);
    if (!t) return errorPage(res, 404, 'Unknown tenant', 'No active tenant answers at this address.', req);
    const handle = typeof req.query.h === 'string' ? req.query.h : '';
    const id = pendingId(handle);
    const row = handle ? ((await s.db('federation_pending').where({ id, tenant_id: t.id, kind: 'saml_authn' }).first()) as { data: string; expires_at: number } | undefined) : undefined;
    if (!row || Number(row.expires_at) < Date.now()) return errorPage(res, 400, 'SAML sign-in expired', 'This sign-in request expired. Start again from the application.', req);
    const signed = await sessionOf(req);
    if (!signed) return continuePage(res, req.originalUrl);
    if (signed.user.tenantId !== t.id) return errorPage(res, 403, 'Wrong tenant', 'You are signed in to another tenant. Sign out of the console and sign in to this one.', req);
    const data = parseJson<{ spId: string; acs: { url: string; index: number; binding: string }; requestId: string; relay: string | null }>(row.data, { spId: '', acs: { url: '', index: 0, binding: '' }, requestId: '', relay: null });
    const sp = await fed().saml.get(t.id, data.spId);
    if (!sp || sp.status !== 'active') return errorPage(res, 400, 'SAML sign-in failed', 'The service provider is disabled.', req);
    await s.db('federation_pending').where({ id }).delete();
    const user = (await s.users.get(t.id, signed.user.userId))!;
    const links = (await s.db('user_identities').where({ user_id: user.id }).orderBy('last_seen_at', 'desc').select('groups')) as { groups: string }[];
    const samlResponse = await fed().saml.response(t, sp, data.acs, data.requestId, { id: user.id, username: user.username, displayName: user.display_name, email: user.email, groups: parseJson<string[]>(links[0]?.groups, []), roles: await s.users.roleIds(user.id), clearance: user.clearance, authTime: signed.session.created_at, method: signed.session.method, sessionId: signed.session.id });
    await s.audit.append({ tenantId: t.id, action: 'saml.sso', kind: 'auth', actor: { user: user.id, username: user.username, session: signed.session.id, ip: req.ip ?? null }, target: { sp: sp.id, name: sp.name, entity: sp.entity_id }, detail: { encrypted: sp.encrypt_assertions && !!sp.encryption_certificate }, traceId: req.traceId });
    page(
      res,
      200,
      `Continue to ${sp.name}`,
      `<p class="fg2" style="margin:0">Signing you in to ${esc(sp.name)}.</p><form method="post" action="${esc(data.acs.url)}" data-autopost><input type="hidden" name="SAMLResponse" value="${esc(samlResponse)}">${data.relay ? `<input type="hidden" name="RelayState" value="${esc(data.relay)}">` : ''}<button type="submit" class="btn primary">Continue</button></form>`,
      { mode: 'autopost', formAction: [new URL(data.acs.url).origin] }
    );
  });

  // ---------- SAML single logout (this server as IdP) ----------

  /**
   * An SP's LogoutRequest (HTTP-Redirect or HTTP-POST, signed): ends the sign-in sessions it names, tells the other
   * SPs and OIDC clients of those sessions through front-channel frames, then answers the SP with a signed
   * LogoutResponse. The sessions are found by NameID and SessionIndex, not by cookie (a cross-site request has none).
   */
  const slo = async (req: Request, res: Response, binding: 'redirect' | 'post') => {
    const t = await tenantOf(req);
    if (!t) return errorPage(res, 404, 'Unknown tenant', 'No active tenant answers at this address.', req);
    const src = binding === 'redirect' ? (req.query as Record<string, unknown>) : ((req.body ?? {}) as Record<string, unknown>);
    const relay = typeof src.RelayState === 'string' ? src.RelayState.slice(0, 80) : null;
    if (typeof src.SAMLResponse === 'string') {
      // An SP answering a logout request we sent from a front-channel frame: nothing is left to do.
      return page(res, 200, 'Signed out', '<p class="fg2" style="margin:0">You are signed out.</p>');
    }
    if (typeof src.SAMLRequest !== 'string' || !src.SAMLRequest) return errorPage(res, 400, 'SAML sign-out failed', 'The request has no SAMLRequest.', req);
    try {
      const rawQuery = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : '';
      const lr = await fed().saml.parseLogoutRequest(t, binding, src.SAMLRequest, rawQuery);
      const sessionIds = await fed().saml.sessionsFor(t.id, lr.sp.id, lr.nameId, lr.sessionIndexes);
      const frames = await frontChannel(t, sessionIds, lr.sp.id);
      for (const id of sessionIds) await s.sessions.revoke(t.id, id);
      await s.audit.append({ tenantId: t.id, action: 'saml.slo', kind: 'auth', actor: { ip: req.ip ?? null }, target: { sp: lr.sp.id, name: lr.sp.name, entity: lr.sp.entity_id }, detail: { sessions: sessionIds.length, frontChannel: frames.length }, traceId: req.traceId });
      if (!lr.sp.slo_url) return logoutPage(res, frames, null, null, 'You are signed out.');
      const answer = await fed().saml.logoutResponse(t, lr.sp, lr.id, true, relay);
      if (answer.form) return logoutPage(res, frames, null, { url: answer.url, fields: answer.form }, 'You are signed out.');
      if (!frames.length) {
        res.setHeader('Cache-Control', 'no-store');
        return void res.redirect(302, answer.url);
      }
      logoutPage(res, frames, answer.url, null, 'You are signed out. The applications you used in this session are being told.');
    } catch (err) {
      if (!(err instanceof SamlError)) throw err;
      await s.audit.append({ tenantId: t.id, action: 'saml.slo.refused', kind: 'auth', actor: { ip: req.ip ?? null }, detail: { reason: err.message }, traceId: req.traceId });
      errorPage(res, 400, 'SAML sign-out failed', err.message, req);
    }
  };
  r.get('/saml/slo', (req, res) => slo(req, res, 'redirect'));
  r.post('/saml/slo', largeForm, (req, res) => slo(req, res, 'post'));

  // ---------- upstream federation ----------

  const fedCookie = (res: Response, value: string, sameSite: 'lax' | 'none') =>
    res.cookie(FED_COOKIE, value, { httpOnly: true, secure: s.cfg.COOKIE_SECURE, sameSite: sameSite === 'none' && s.cfg.COOKIE_SECURE ? 'none' : 'lax', path: '/', maxAge: 10 * 60_000 });
  const fedCookieOf = (req: Request): string | undefined => {
    const m = new RegExp(`(?:^|;\\s*)${FED_COOKIE}=([^;]+)`).exec(req.headers.cookie ?? '');
    return m?.[1] ? decodeURIComponent(m[1]) : undefined;
  };

  const start = (protocol: 'oidc' | 'saml') => async (req: Request, res: Response) => {
    const t = await tenantOf(req);
    if (!t) return errorPage(res, 404, 'Unknown tenant', 'No active tenant answers at this address.', req);
    const providerId = typeof req.query.provider === 'string' ? req.query.provider : '';
    try {
      const out = protocol === 'oidc' ? await fed().upstream.startOidc(t, providerId, safeReturn(req.query.return)) : await fed().upstream.startSaml(t, providerId, safeReturn(req.query.return));
      fedCookie(res, out.browser, protocol === 'saml' ? 'none' : 'lax');
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(302, out.url);
    } catch (err) {
      if (!(err instanceof UpstreamError)) s.log.warn({ err, provider: providerId, trace_id: req.traceId }, 'upstream sign-in could not start');
      errorPage(res, 502, 'Sign-in could not start', publicReason(err, 'The identity provider could not be reached. Try again later, or ask an identity admin.'), req);
    }
  };
  r.get('/federation/oidc/start', start('oidc'));
  r.get('/federation/saml/start', start('saml'));

  const upstreamDone = async (req: Request, res: Response, t: TenantCtx, fn: () => Promise<{ row: ProviderRow; user: ExternalUser; returnTo: string | null; subject?: SamlSubject }>) => {
    res.clearCookie(FED_COOKIE, { path: '/' });
    try {
      const out = await fn();
      // Upstream SAML sessions are remembered with their NameID and SessionIndex for single logout.
      const after = out.subject ? (sessionId: string) => fed().upstream.recordSamlSession(t.id, sessionId, out.row.id, out.subject!) : undefined;
      await completeSignIn(req, res, t, out.row, out.user, `${out.row.kind === 'oidc' ? 'OIDC' : 'SAML'} (${out.row.name})`, out.row.kind, out.returnTo, {}, after);
    } catch (err) {
      await s.audit.append({ tenantId: t.id, action: 'auth.login.failed', kind: 'auth', actor: { ip: req.ip ?? null }, target: { kind: 'upstream' }, detail: { reason: (err as Error).message.slice(0, 300) }, traceId: req.traceId });
      s.metrics.logins.inc({ result: 'invalid', kind: 'upstream' });
      if (!(err instanceof UpstreamError || err instanceof SamlError)) s.log.warn({ err, trace_id: req.traceId }, 'upstream sign-in failed');
      errorPage(res, 400, 'Sign-in failed', publicReason(err, 'The sign-in could not be completed. Start again, or ask an identity admin with the trace id below.'), req);
    }
  };

  r.get('/federation/oidc/callback', async (req, res) => {
    const t = await tenantOf(req);
    if (!t) return errorPage(res, 404, 'Unknown tenant', 'No active tenant answers at this address.', req);
    await upstreamDone(req, res, t, () => fed().upstream.finishOidc(t, req.query as Record<string, unknown>, fedCookieOf(req)));
  });

  r.post('/federation/saml/acs', largeForm, async (req, res) => {
    const t = await tenantOf(req);
    if (!t) return errorPage(res, 404, 'Unknown tenant', 'No active tenant answers at this address.', req);
    let form: Record<string, string>;
    try {
      form = formOf(req.body);
    } catch {
      return errorPage(res, 400, 'Sign-in failed', 'Malformed response.', req);
    }
    await upstreamDone(req, res, t, () => fed().upstream.finishSaml(t, form, fedCookieOf(req)));
  });

  /**
   * Our SLO endpoint as SP to upstream IdPs: an IdP's LogoutRequest ends the sessions it names and is answered with
   * a signed LogoutResponse; a LogoutResponse to a logout we started continues to where the sign-out was going.
   */
  const spSlo = async (req: Request, res: Response, binding: 'redirect' | 'post') => {
    const t = await tenantOf(req);
    if (!t) return errorPage(res, 404, 'Unknown tenant', 'No active tenant answers at this address.', req);
    let params: Record<string, string>;
    try {
      params = formOf(binding === 'redirect' ? req.query : req.body);
    } catch {
      return errorPage(res, 400, 'SAML sign-out failed', 'Malformed request.', req);
    }
    try {
      const rawQuery = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : '';
      const out = await fed().upstream.handleSlo(t, binding, params, rawQuery);
      if (out.kind === 'response') {
        if (out.next) {
          res.setHeader('Cache-Control', 'no-store');
          return void res.redirect(302, out.next);
        }
        return logoutPage(res, [], null, null, 'You are signed out, here and at your identity provider.');
      }
      const frames = await frontChannel(t, out.sessionIds, null);
      for (const id of out.sessionIds) await s.sessions.revoke(t.id, id);
      await s.audit.append({ tenantId: t.id, action: 'saml.slo.upstream', kind: 'auth', actor: { ip: req.ip ?? null }, target: { provider: out.provider.id, name: out.provider.name }, detail: { sessions: out.sessionIds.length, frontChannel: frames.length }, traceId: req.traceId });
      if (out.responseUrl && !frames.length) {
        res.setHeader('Cache-Control', 'no-store');
        return void res.redirect(302, out.responseUrl);
      }
      logoutPage(res, frames, out.responseUrl, null, 'You are signed out.');
    } catch (err) {
      if (!(err instanceof SamlError)) throw err;
      await s.audit.append({ tenantId: t.id, action: 'saml.slo.refused', kind: 'auth', actor: { ip: req.ip ?? null }, target: { kind: 'upstream' }, detail: { reason: err.message }, traceId: req.traceId });
      errorPage(res, 400, 'SAML sign-out failed', err.message, req);
    }
  };
  r.get('/federation/saml/slo', (req, res) => spSlo(req, res, 'redirect'));
  r.post('/federation/saml/slo', largeForm, (req, res) => spSlo(req, res, 'post'));

  /** Our SP metadata for one upstream SAML provider; its URL is our entity ID for that provider. */
  r.get('/federation/saml/:id', async (req, res, next) => {
    if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(String(req.params.id))) return next();
    const t = await tenantOf(req);
    const row = t ? await s.providers.get(t.id, String(req.params.id)) : undefined;
    if (!t || !row || row.kind !== 'saml') return void res.status(404).end();
    res.type('application/samlmetadata+xml').send(await fed().upstream.spMetadata(t, row));
  });

  // ---------- Kerberos SPNEGO ----------

  r.get('/auth/negotiate', async (req, res) => {
    const t = await tenantOf(req);
    if (!t) return errorPage(res, 404, 'Unknown tenant', 'No active tenant answers at this address.', req);
    const settings = await fed().settings(t.id);
    if (!settings.kerberos.enabled) return errorPage(res, 404, 'Kerberos sign-in is off', 'Kerberos sign-in is not enabled for this tenant. Sign in with your password.', req);
    const returnTo = safeReturn(req.query.return);
    const m = /^Negotiate\s+([A-Za-z0-9+/=]+)$/.exec(req.header('authorization') ?? '');
    if (!m) {
      // The browser answers this with a ticket when the site is in its Kerberos (intranet) zone; otherwise the page shows.
      res.setHeader('WWW-Authenticate', 'Negotiate');
      return page(res, 401, 'Kerberos sign-in', `<div class="notice warn">This browser did not offer a Kerberos ticket. It needs a domain sign-in and this site in its intranet zone.</div><div><a class="btn primary" href="/#/signin">Sign in with your password</a></div>`);
    }
    const result = await s.kerberos.verify(m[1]!);
    if (result.status !== 'ok') {
      await s.audit.append({ tenantId: t.id, action: 'auth.login.failed', kind: 'auth', actor: { ip: req.ip ?? null }, target: { kind: 'kerberos' }, detail: { reason: result.message }, traceId: req.traceId });
      s.metrics.logins.inc({ result: result.status, kind: 'kerberos' });
      return errorPage(res, result.status === 'unavailable' ? 503 : 401, 'Kerberos sign-in failed', result.status === 'unavailable' ? 'Kerberos is not available on this server. Sign in with your password.' : 'The Kerberos ticket was not accepted. Sign in with your password.', req);
    }
    const { user, realm } = splitPrincipal(result.principal);
    if (settings.kerberos.realms.length && (!realm || !settings.kerberos.realms.includes(realm))) {
      await s.audit.append({ tenantId: t.id, action: 'auth.login.refused', kind: 'auth', actor: { username: result.principal, ip: req.ip ?? null }, target: { kind: 'kerberos' }, detail: { reason: 'realm_not_accepted', realm }, traceId: req.traceId });
      return errorPage(res, 403, 'Sign-in refused', `The realm ${realm ?? '(none)'} is not accepted by this tenant.`, req);
    }
    // The principal names a user; the user stores (in order) say who they are and which groups they hold.
    const username = user.toLowerCase();
    for (const row of (await s.providers.list(t.id)).filter((p) => p.enabled && !isFederatedKind(p.kind))) {
      let ext: ExternalUser | null = null;
      try {
        ext = await s.chain.build(row).lookup(username);
      } catch (err) {
        s.log.warn({ provider: row.name, err: (err as Error).message }, 'kerberos lookup failed');
      }
      if (ext) return completeSignIn(req, res, t, row, ext, 'Kerberos', 'kerberos', returnTo, result.responseToken ? { 'WWW-Authenticate': `Negotiate ${result.responseToken}` } : {});
    }
    await s.audit.append({ tenantId: t.id, action: 'auth.login.failed', kind: 'auth', actor: { username: result.principal, ip: req.ip ?? null }, target: { kind: 'kerberos' }, detail: { reason: 'not_found' }, traceId: req.traceId });
    errorPage(res, 403, 'Sign-in refused', 'Your Kerberos principal is not in any user store for this tenant.', req);
  });

  return root;
}
