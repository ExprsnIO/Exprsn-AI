import type { Request, RequestHandler } from 'express';
import { effectivePermissions } from '../authz/policy.js';
import type { Permission } from '../authz/permissions.js';
import { AUTH_TAG, declaresAnyOf, loadPrincipal } from '../http/middleware.js';
import { Limiter } from '../platform/ratelimit.js';
import type { Services } from '../services.js';
import { permissionsOfScopes } from './passwords.js';
import { DavError } from './xml.js';

/*
 * DAV authentication (B-3101): HTTP Basic with the account's username and an app password, over TLS. Sessions and
 * cookies never apply here, and app passwords never apply anywhere else. The principal is narrowed to the
 * permissions of the password's DAV scopes (CalDAV, CardDAV, WebDAV), always within what the owner's roles grant now,
 * and is treated as MFA-verified for DAV because creating the password needed a fresh second-factor step-up.
 *
 * Failed attempts: 20 a minute per address (then 429 before the password is even checked), and 10 a minute per app
 * password (a guessed secret for a known prefix), so a password cannot be brute-forced from many addresses either.
 */

/** Any one of these lets a caller into /dav; each request then needs the permission of what it touches. */
export const DAV_PERMISSIONS: readonly Permission[] = ['calendars:read', 'contacts:read', 'files:read', 'groups:read'];

export const REALM = 'Basic realm="Exprsn-AI DAV", charset="UTF-8"';

const unauthorized = (msg: string) => new DavError(401, msg, undefined, { 'WWW-Authenticate': REALM });

export function davAuthenticate(s: Services): RequestHandler {
  const badAddress = new Limiter(s.counters, 'dav-fail', 20, 60_000);
  const badPassword = new Limiter(s.counters, 'dav-fail-pw', 10, 60_000);
  const handler: RequestHandler = async (req: Request, _res, next) => {
    try {
      // Basic credentials travel in the clear without TLS: refused outright when the deployment runs on HTTPS.
      if (s.cfg.COOKIE_SECURE && !req.secure) throw new DavError(403, 'DAV clients connect over HTTPS.');
      const addr = req.ip ?? 'unknown';
      const auth = req.headers.authorization;
      const m = auth ? /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(auth) : null;
      if (!m) throw unauthorized('Sign in with your username and an app password.');
      const held = await badAddress.blocked(addr);
      if (held.blocked) throw new DavError(429, 'Too many failed sign-ins from this address. Wait before trying again.', undefined, { 'Retry-After': String(Math.max(1, Math.ceil(held.resetMs / 1000))) });
      const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      const username = colon > 0 ? decoded.slice(0, colon) : '';
      const password = colon > 0 ? decoded.slice(colon + 1) : '';
      const { row, known } = await s.dav.passwords.verify(password);
      const fail = async () => {
        await badAddress.consume(addr);
        if (known) await badPassword.consume(known.id);
        return unauthorized('The username or app password is wrong, or the app password was revoked or has expired.');
      };
      if (known && (await badPassword.blocked(known.id)).blocked) throw await fail();
      if (!row) throw await fail();
      const owner = await s.users.get(row.tenant_id, row.user_id);
      // The username is checked too (without telling a wrong one from a wrong password); a tenant slug may follow it.
      const given = username.toLowerCase();
      const tenant = await s.tenants.byId(row.tenant_id);
      if (!owner || (given !== owner.username.toLowerCase() && given !== `${owner.username}@${tenant?.slug ?? ''}`.toLowerCase())) throw await fail();
      const p = await loadPrincipal(s, row.tenant_id, row.user_id, {});
      if (!p) throw unauthorized('The account is disabled or suspended.');
      p.kind = 'api_key';
      p.scopes = permissionsOfScopes(row.scopes);
      p.mfa = true;
      p.appPasswordId = row.id;
      p.workspaceId = null;
      if (!DAV_PERMISSIONS.some((x) => effectivePermissions(p).has(x))) throw new DavError(403, 'This account’s roles and the app password’s scopes allow nothing over DAV.', '{DAV:}need-privileges');
      await s.dav.passwords.touch(row, req.ip ?? null, req.header('user-agent') ?? null);
      req.principal = p;
      next();
    } catch (err) {
      next(err);
    }
  };
  // 1.5.0 (B-3304): a signed-in route that needs any one of the DAV permissions, as the route registry declares it.
  return declaresAnyOf(Object.assign(handler, { [AUTH_TAG]: true }), DAV_PERMISSIONS);
}
