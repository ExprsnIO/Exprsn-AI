import type { Request, RequestHandler } from 'express';
import { forbidden } from '../http/problem.js';
import type { AppKeyScope } from '../identity/apikeys.js';
import type { Services } from '../services.js';

/*
 * 1.6.0, Sprint 39d (B-8601, B-8702): credentials limited to one app.
 *
 * An API key with an `app_scope`, and every embedded session, acts only under `/api/apps/<that app>`: the
 * authenticator refuses any other path, and `appScopeGuard` (on the apps routers) refuses another app, or another
 * entity when the scope names one. The scope names ids; the request may name the app and entity by id or name, so the
 * guard resolves what the path names through the app service and compares ids. Scopes (permissions) still apply on
 * top: an app-scoped key holds at most `records:read` and `records:write`.
 */

/** The segments under `/apps/<app>/` that are the app's own routes, not an entity of the entity API. */
export const RESERVED_SEGMENTS = new Set(['entities', 'forms', 'policies', 'triggers', 'export', 'schema', 'embed', 'openapi.json', 'client.ts', 'client.js', 'transfers', 'drafts', 'import', 'held']);

/** Paths the credential may reach at all: the app API, nothing else (`/api/apps`, `/api/apps/...`). */
export const underApps = (originalUrl: string): boolean => /^\/api\/apps(\/|\?|$)/.test(originalUrl);

/** What a request under `/api/apps` names: the app ref and, when the path has one, the entity ref. */
export function appPathRefs(pathUnderApi: string): { app: string | null; entity: string | null } {
  const m = /^\/apps\/([^/?]+)(?:\/([^/?]+))?(?:\/([^/?]+))?/.exec(pathUnderApi);
  if (!m?.[1] || ['held', 'transfers', 'drafts', 'import'].includes(m[1])) return { app: null, entity: null };
  const app = decodeURIComponent(m[1]);
  const second = m[2] ? decodeURIComponent(m[2]) : null;
  if (!second) return { app, entity: null };
  if (second === 'entities' && m[3]) return { app, entity: decodeURIComponent(m[3]) };
  if (RESERVED_SEGMENTS.has(second)) return { app, entity: null };
  return { app, entity: second };
}

/** The scope a request's credential carries, if any (an app-scoped key or an embedded session). */
export const scopeOf = (req: Request): AppKeyScope | null => req.embedSession?.scope ?? req.apiKey?.app_scope ?? null;

/**
 * Refuses a request whose credential is limited to another app or entity. Mounted on the apps routers; the path seen
 * here is the one under `/api`. Entity routes of the app itself (forms, policies, design) are refused for an
 * entity-scoped credential, which may only reach its entity's records.
 */
export function appScopeGuard(s: Services): RequestHandler {
  return async (req, _res, next) => {
    const scope = scopeOf(req);
    if (!scope) return next();
    const refs = appPathRefs(req.originalUrl.replace(/^\/api/, '').split('?')[0]!);
    if (!refs.app) throw forbidden('This credential is limited to one app and cannot list or create apps.', { step: 'scope' });
    const app = await s.apps.appById(req.principal!.tenantId, scope.app);
    if (!app || (refs.app !== app.id && refs.app !== app.name)) throw forbidden(`This credential is limited to the app ${app?.name ?? scope.app}.`, { step: 'scope' });
    if (scope.entity) {
      const entity = await s.apps.entityById(req.principal!.tenantId, scope.entity);
      if (!entity || !refs.entity || (refs.entity !== entity.id && refs.entity !== entity.name)) throw forbidden(`This credential is limited to the entity ${entity?.name ?? scope.entity} of ${app.name}.`, { step: 'scope' });
    }
    next();
  };
}
