import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { parseCookie } from 'cookie';
import type { z } from 'zod';
import { safeEqual } from '../crypto/index.js';
import { isLabel } from '../authz/labels.js';
import { authorize, effectivePermissions, type Principal, type Resource } from '../authz/policy.js';
import type { Workspace } from '../repos/tenants.js';
import { rolesRequireMfa, type Permission } from '../authz/permissions.js';
import { actorFrom } from '../audit/chain.js';
import type { SessionRow, SessionStage } from '../identity/sessions.js';
import type { ApiKeyRow } from '../identity/apikeys.js';
import type { Services } from '../services.js';
import { badRequest, forbidden, HttpProblem, unauthorized } from './problem.js';

declare module 'express-serve-static-core' {
  interface Request {
    traceId: string;
    principal?: Principal;
    authSession?: SessionRow;
    apiKey?: ApiKeyRow;
  }
}

export const cookieName = (secure: boolean): string => (secure ? '__Host-exai_sid' : 'exai_sid');

export function setSessionCookie(res: Response, s: Services, token: string, expiresAt: number): void {
  res.cookie(cookieName(s.cfg.COOKIE_SECURE), token, {
    httpOnly: true,
    secure: s.cfg.COOKIE_SECURE,
    sameSite: 'strict',
    path: '/',
    expires: new Date(expiresAt)
  });
}

export function clearSessionCookie(res: Response, s: Services): void {
  res.clearCookie(cookieName(s.cfg.COOKIE_SECURE), { httpOnly: true, secure: s.cfg.COOKIE_SECURE, sameSite: 'strict', path: '/' });
}

export const sessionTokenFrom = (cookieHeader: string | undefined, secure: boolean): string | undefined =>
  cookieHeader ? parseCookie(cookieHeader)[cookieName(secure)] : undefined;

/** Builds the principal for a user, or null when the user or tenant is not active. */
export async function loadPrincipal(
  s: Services,
  tenantId: string,
  userId: string,
  via: { session?: SessionRow; apiKey?: ApiKeyRow }
): Promise<Principal | null> {
  const [user, tenant] = await Promise.all([s.users.get(tenantId, userId), s.tenants.byId(tenantId)]);
  if (!user || user.state !== 'active' || !tenant || tenant.state !== 'active') return null;
  return {
    kind: via.apiKey ? 'api_key' : 'user',
    userId: user.id,
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    username: user.username,
    displayName: user.display_name,
    roles: await s.users.roleIds(user.id),
    clearance: isLabel(user.clearance) ? user.clearance : 'public',
    scopes: via.apiKey ? via.apiKey.scopes : null,
    sessionId: via.session?.id ?? null,
    apiKeyId: via.apiKey?.id ?? null,
    // API keys can only be created from an MFA-verified session when the owner needs MFA.
    mfa: via.apiKey ? true : via.session?.mfa_verified_at != null
  };
}

/** Workspaces the principal may act in: all of them for tenant admins, else tenant-wide ones and memberships. */
export async function workspacesFor(s: Services, p: Principal): Promise<Workspace[]> {
  if (effectivePermissions(p).has('tenant:manage')) return s.tenants.workspaces(p.tenantId);
  return s.tenants.workspacesForUser(p.tenantId, p.userId);
}

/** Picks the requested workspace when the principal may use it, otherwise their first one (or none). */
export async function resolveWorkspace(s: Services, p: Principal, requested: string | null | undefined): Promise<Workspace | null> {
  const list = await workspacesFor(s, p);
  return list.find((w) => w.id === requested) ?? list[0] ?? null;
}

/** Resolves the caller from a bearer API key or the session cookie. Never rejects: see requireAuth. */
export function authenticate(s: Services): RequestHandler {
  return async (req, _res, next) => {
    const auth = req.headers.authorization;
    if (auth) {
      const m = /^Bearer\s+(\S+)$/i.exec(auth);
      if (!m?.[1]) throw unauthorized('Malformed Authorization header.');
      // OAuth access tokens from the OIDC provider (JWTs), narrowed to their scopes like API keys.
      if (m[1].startsWith('eyJ')) {
        const p = await s.federation.principalFromAccessToken(m[1]);
        if (!p) throw new HttpProblem(401, 'Unauthorized', 'The access token is invalid, expired or revoked.', { extensions: { error: 'invalid_token' } });
        req.principal = p;
        p.workspaceId = (await resolveWorkspace(s, p, req.header('x-workspace')))?.id ?? null;
        return next();
      }
      const key = await s.apiKeys.verify(m[1]);
      if (!key) throw new HttpProblem(401, 'Unauthorized', 'The API key is invalid, expired or revoked.', { extensions: { error: 'invalid_token' } });
      const p = await loadPrincipal(s, key.tenant_id, key.user_id, { apiKey: key });
      if (!p) throw unauthorized('The key owner is disabled.');
      req.apiKey = key;
      req.principal = p;
      p.workspaceId = (await resolveWorkspace(s, p, req.header('x-workspace')))?.id ?? null;
      return next();
    }
    const token = sessionTokenFrom(req.headers.cookie, s.cfg.COOKIE_SECURE);
    if (token) {
      const session = await s.sessions.resolve(token);
      if (session) {
        const p = await loadPrincipal(s, session.tenant_id, session.user_id, { session });
        if (p) {
          req.authSession = session;
          req.principal = p;
          p.workspaceId = session.stage === 'active' ? ((await resolveWorkspace(s, p, session.workspace_id))?.id ?? null) : null;
          await s.sessions.touch(session);
        }
      }
    }
    next();
  };
}

/**
 * Rejects cross-site state changes. Unsafe methods must come from our own origin, and requests authenticated by
 * the session cookie must also carry the session's CSRF token (double submit, HMAC-bound to the session).
 */
export function csrfProtection(s: Services): RequestHandler {
  return (req, _res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin && origin !== s.cfg.ORIGIN) throw forbidden('Cross-origin request refused.', { step: 'csrf' });
    if (req.authSession && !req.apiKey) {
      const presented = req.header('x-csrf-token') ?? '';
      if (!presented || !safeEqual(presented, s.sessions.csrfFor(req.authSession.id))) {
        throw forbidden('Missing or invalid CSRF token.', { step: 'csrf' });
      }
    }
    next();
  };
}

/** Requires a signed-in caller whose session has finished sign-in (or is in one of `stages`). */
export function requireAuth(opts: { stages?: SessionStage[]; sessionOnly?: boolean } = {}): RequestHandler {
  const stages = opts.stages ?? ['active'];
  return (req, _res, next) => {
    if (!req.principal) throw unauthorized();
    if (opts.sessionOnly && !req.authSession) throw forbidden('This action needs a signed-in browser session, not an API key.', { step: 'credential' });
    if (req.authSession && !stages.includes(req.authSession.stage)) {
      throw new HttpProblem(401, 'Unauthorized', req.authSession.stage === 'mfa' ? 'Complete the second factor to continue.' : 'Set up a second factor to continue.', { extensions: { stage: req.authSession.stage } });
    }
    next();
  };
}

export const principalOf = (req: Request): Principal => {
  if (!req.principal) throw unauthorized();
  return req.principal;
};

/**
 * Authorises the caller for `action` (optionally against a resource), writing the decision to the audit chain
 * when it is a denial. Admin roles additionally need an MFA-verified session.
 */
export function requirePermission(s: Services, action: Permission, resourceOf?: (req: Request) => Resource): RequestHandler {
  return async (req, _res, next) => {
    const p = principalOf(req);
    const decision = authorize(p, action, resourceOf ? resourceOf(req) : {});
    if (decision.allow && p.kind === 'user' && !p.mfa && rolesRequireMfa(p.roles)) {
      Object.assign(decision, { allow: false, step: 'mfa', reason: 'Admin roles need a session verified with a second factor' });
    }
    if (!decision.allow) {
      await s.denials.record(`${p.tenantId}:${p.userId ?? p.apiKeyId ?? 'anonymous'}`, {
        tenantId: p.tenantId,
        action: 'authz.denied',
        kind: 'decision',
        actor: actorFrom(p, req.ip),
        target: { method: req.method, path: req.baseUrl + req.path },
        decision: { ...decision, clearance: p.clearance, roles: p.roles },
        traceId: req.traceId
      });
      throw forbidden(decision.reason, { step: decision.step, action, policy: decision.policy });
    }
    next();
  };
}

export function parseBody<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest('The request did not validate.', { errors: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
  return r.data;
}

export const ip = (req: Request): string | null => req.ip ?? null;

export const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

export type Handler = (req: Request, res: Response, next: NextFunction) => unknown;
