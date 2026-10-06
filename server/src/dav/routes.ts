import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { effectivePermissions } from '../authz/policy.js';
import { ip, noStore, parseBody, principalOf, requireAuth } from '../http/middleware.js';
import { forbidden, HttpProblem, notFound } from '../http/problem.js';
import { securityAlert, type SecurityAlertInput } from '../identity/security-alerts.js';
import type { Services } from '../services.js';
import { appPasswordView, DAV_SCOPES, SCOPE_PERMISSIONS, type DavScope } from './passwords.js';

/**
 * App passwords for DAV clients (B-3101), under `/api/me`: list, create and revoke one's own. Creating one needs a
 * browser session whose second factor was confirmed within STEPUP_WINDOW_SECONDS (sign-in with a factor, or
 * `POST /api/me/step-up` with a code or a passkey); a password alone is not enough, and an account without a second
 * factor sets one up first. The password is shown once. `GET /api/me/dav` (Sprint 32, B-3415) gives Settings the
 * discovery URLs, the username a client signs in with, the scopes the caller's roles can use and whether the second
 * factor is fresh enough to create one now.
 */
export function appPasswordRoutes(s: Services): Router {
  const r = Router();
  r.use('/app-passwords', noStore);
  const active = requireAuth();
  const browser = requireAuth({ sessionOnly: true });

  const audit = (req: Request, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'auth', actor: actorFrom(p, ip(req)), target, ...(detail ? { detail } : {}), traceId: req.traceId });
  };
  const alert = (req: Request, event: SecurityAlertInput['event'], detail: string) => {
    const p = principalOf(req);
    return securityAlert(s, { tenantId: p.tenantId, userId: p.userId, event, detail, ip: ip(req) });
  };

  const urls = () => {
    const base = s.cfg.PUBLIC_URL.replace(/\/+$/, '');
    return { url: `${base}/dav/`, caldav: `${base}/.well-known/caldav`, carddav: `${base}/.well-known/carddav`, webdav: `${base}/dav/` };
  };

  r.get('/dav', active, async (req, res) => {
    const p = principalOf(req);
    const tenant = await s.tenants.byId(p.tenantId);
    const perms = effectivePermissions(p);
    const window = s.cfg.STEPUP_WINDOW_SECONDS * 1000;
    const verifiedAt = req.authSession?.mfa_verified_at ?? null;
    res.json({
      username: p.username,
      usernameWithTenant: tenant ? `${p.username}@${tenant.slug}` : p.username,
      server: urls(),
      // A scope is offered when the caller's roles grant at least one of its permissions now.
      scopes: DAV_SCOPES.map((scope) => ({ scope, available: SCOPE_PERMISSIONS[scope].some((x) => perms.has(x)) })),
      stepUp: {
        hasFactor: (await s.mfa.factors(p.userId)).length > 0,
        windowSeconds: s.cfg.STEPUP_WINDOW_SECONDS,
        freshUntil: verifiedAt != null && Date.now() - verifiedAt <= window ? verifiedAt + window : null
      }
    });
  });

  r.get('/app-passwords', active, async (req, res) => {
    const rows = await s.dav.passwords.listForUser(principalOf(req).userId);
    res.json(rows.map(appPasswordView));
  });

  r.post('/app-passwords', browser, async (req, res) => {
    const p = principalOf(req);
    const body = parseBody(
      z
        .object({
          name: z.string().trim().min(1).max(100),
          scopes: z.array(z.enum(DAV_SCOPES)).min(1).max(DAV_SCOPES.length),
          ttlDays: z.union([z.literal(30), z.literal(90), z.literal(180), z.literal(365)]).nullable().default(null)
        })
        .strict(),
      req.body
    );
    // A fresh second factor (the owner decision of 2026-10-05): the password never passes MFA on its own afterwards.
    if (!(await s.mfa.factors(p.userId)).length) throw forbidden('Set up a second factor before creating an app password.', { step: 'mfa' });
    const session = req.authSession!;
    if (!session.mfa_verified_at || Date.now() - session.mfa_verified_at > s.cfg.STEPUP_WINDOW_SECONDS * 1000) {
      throw new HttpProblem(401, 'Step-up required', 'Confirm with your second factor (a code or a passkey) to create an app password.', { extensions: { step_up: true, factor: true, window_seconds: s.cfg.STEPUP_WINDOW_SECONDS } });
    }
    if ((await s.dav.passwords.listForUser(p.userId)).filter((x) => !x.revoked_at).length >= 50) throw new HttpProblem(409, 'Conflict', 'You have 50 app passwords; revoke one you no longer use first.');
    const { password, row } = await s.dav.passwords.create({ tenantId: p.tenantId, userId: p.userId, name: body.name, scopes: body.scopes as DavScope[], ttlDays: body.ttlDays });
    await audit(req, 'dav.app_password.created', { appPassword: row.id, prefix: row.prefix }, { name: row.name, scopes: row.scopes, expiresAt: row.expires_at });
    await alert(req, 'app_password.created', `"${row.name}" (exai_d1_${row.prefix}…) for ${row.scopes.join(', ')}.`);
    res.status(201).json({
      ...appPasswordView(row),
      password,
      username: p.username,
      server: urls(),
      notice: 'This is the only time the app password is shown.'
    });
  });

  r.delete('/app-passwords/:id', active, async (req, res) => {
    const p = principalOf(req);
    const id = parseBody(z.string().length(26), req.params.id);
    const row = await s.dav.passwords.get(p.userId, id);
    if (!row || !(await s.dav.passwords.revoke(p.userId, id, p.userId))) throw notFound('App password');
    await audit(req, 'dav.app_password.revoked', { appPassword: row.id, prefix: row.prefix }, { name: row.name });
    await alert(req, 'app_password.revoked', `"${row.name}" (exai_d1_${row.prefix}…) stopped working at once.`);
    res.status(204).end();
  });

  return r;
}
