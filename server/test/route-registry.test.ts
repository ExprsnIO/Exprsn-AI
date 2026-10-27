import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { matrixCsv, permissionsMarkdown, roleMatrix } from '../src/authz/matrix.js';
import { PERMISSIONS } from '../src/authz/permissions.js';
import { routeAccess, ROUTE_PERMISSIONS } from '../src/authz/routes.js';
import { requireAnyPermission, requireAuth, requirePermission } from '../src/http/middleware.js';
import { harness, type Harness } from './helpers.js';
import { PERMISSIONS_DOC } from './permissions-doc.js';
import { compareRegistry, recordMounts, routeFacts } from './route-registry.js';

// Before any app is built: Express 5 does not keep the paths routers are mounted at.
recordMounts();

/**
 * B-3304: every route the server registers declares its permission in one table (`server/src/authz/routes.ts`), and
 * the table agrees with the middleware on each route. B-3301: `docs/permissions.md` is the catalogue's matrix.
 */
describe('route permission registry (B-3304)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('declares every registered route, matching its middleware, and no route that is gone', () => {
    const facts = routeFacts(h.app);
    expect(facts.length).toBeGreaterThan(900);
    const out = compareRegistry(facts, ROUTE_PERMISSIONS);
    expect(out.missing, 'routes without a declared permission (npx tsx server/test/route-registry.ts --write, then review)').toEqual([]);
    expect(out.stale, 'registry entries for routes the app no longer registers').toEqual([]);
    expect(out.duplicates).toEqual([]);
    expect(out.mismatched, 'routes whose requireAuth or requirePermission middleware disagrees with the registry').toEqual([]);
  });

  it('fails for a route registered without a declared permission, or declared wrongly', async () => {
    const { Router } = await import('express');
    const extra = Router();
    extra.get('/api/zz-undeclared', requireAuth(), (_req, res) => void res.end());
    extra.get('/api/zz-wrong', requireAuth(), requirePermission(h.s, 'models:manage'), (_req, res) => void res.end());
    extra.get('/api/zz-either', requireAuth(), requireAnyPermission(h.s, ['models:read', 'models:manage']), (_req, res) => void res.end());
    const app = { router: { stack: [...(h.app as unknown as { router: { stack: unknown[] } }).router.stack, ...(extra as unknown as { stack: unknown[] }).stack] } };
    const facts = routeFacts(app);
    const out = compareRegistry(facts, [...ROUTE_PERMISSIONS, ['GET /api/zz-wrong', 'models:read'], ['GET /api/zz-either', { anyOf: ['models:read', 'models:manage'] }]]);
    expect(out.missing).toEqual(['GET /api/zz-undeclared -> \'authenticated\'']);
    expect(out.mismatched).toEqual([expect.stringMatching(/^GET \/api\/zz-wrong: declared differently/)]);
    // A public route declared as needing a permission, and an authenticated one declared public, are mismatches too.
    const bad = compareRegistry(facts, [...ROUTE_PERMISSIONS.filter(([k]) => k !== 'GET /healthz' && k !== 'GET /api/me'), ['GET /healthz', 'audit:read'], ['GET /api/me', 'public'], ['GET /api/zz-undeclared', 'authenticated'], ['GET /api/zz-wrong', 'models:manage'], ['GET /api/zz-either', { anyOf: ['models:read', 'models:manage'] }]]);
    expect(bad.mismatched.map((m) => m.split(':')[0])).toEqual(['GET /api/me', 'GET /healthz']);
    expect(bad.missing).toEqual([]);
  });

  it('lists the routes of each permission in the role matrix', () => {
    expect(routeAccess('GET /api/authz/matrix')).toBe('roles:manage');
    expect(routeAccess('GET /healthz')).toBe('public');
    const m = roleMatrix();
    const manage = m.permissions.find((p) => p.id === 'roles:manage')!;
    expect(manage.admin).toBe(true);
    expect(manage.routes).toEqual(expect.arrayContaining(['GET /api/authz/matrix', 'POST /api/authz/roles', 'GET /api/authz/access']));
    expect(m.permissions.find((p) => p.id === 'channels:review')!.anyOfRoutes).toContain('GET /api/channels');
    expect(m.publicRoutes).toContain('POST /api/auth/login');
    expect(m.authenticatedRoutes).toContain('GET /api/me');
    expect(m.permissions).toHaveLength(PERMISSIONS.length);
  });
});

describe('docs/permissions.md (B-3301)', () => {
  it('is what the catalogue and the registry generate (npm run docs:permissions)', () => {
    expect(readFileSync(PERMISSIONS_DOC, 'utf8')).toBe(permissionsMarkdown());
  });

  it('has a CSV form with one column per role', () => {
    const csv = matrixCsv(roleMatrix()).split('\r\n');
    expect(csv[0]).toBe(`permission,admin,routes,${roleMatrix().roles.map((r) => r.id).join(',')}`);
    expect(csv).toHaveLength(PERMISSIONS.length + 2);
    expect(csv.find((l) => l.startsWith('roles:manage,'))).toMatch(/^roles:manage,yes,\d+,x,x,,/);
  });
});
