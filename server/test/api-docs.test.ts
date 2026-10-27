import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../src/authz/permissions.js';
import { ROUTE_PERMISSIONS } from '../src/authz/routes.js';
import { API_MD, documentedRoutes, EPIC_PERMISSIONS, isEpicRoute, routeKey, undocumented } from './api-docs-routes.js';
import { normalise, OPENAPI_FILE } from './openapi-routes.js';
import { PERMISSIONS_DOC } from './permissions-doc.js';

/*
 * 1.9.99-final (B-10802): every route and permission the cloud epic added is in docs/api.md, docs/openapi.json and
 * the generated docs/permissions.md. The route registry is the list of routes (route-registry.test.ts holds it to
 * what the app registers); `npx tsx server/test/api-docs-routes.ts [--all]` lists the gaps.
 */
describe('the cloud epic in the API docs (B-10802)', () => {
  const md = readFileSync(API_MD, 'utf8');
  const epic = ROUTE_PERMISSIONS.filter(([k, a]) => isEpicRoute(k, a));

  it('finds the epic routes', () => {
    expect(epic.length).toBeGreaterThan(100);
    expect(epic.map(([k]) => k)).toEqual(expect.arrayContaining(['GET /api/admin/cloud/accounts', 'GET /cloud-issuer/jwks.json', 'PUT /api/admin/pools/{id}/autoscale', 'PUT /api/admin/instances/{id}/ai-gateway']));
  });

  it('describes every epic route in docs/api.md', () => {
    expect(undocumented(ROUTE_PERMISSIONS, md, isEpicRoute), 'routes missing from docs/api.md (npx tsx server/test/api-docs-routes.ts)').toEqual([]);
  });

  it('has every epic route in docs/openapi.json', () => {
    const doc = JSON.parse(readFileSync(OPENAPI_FILE, 'utf8')) as { paths: Record<string, Record<string, unknown>> };
    const ops = new Set(Object.entries(doc.paths).flatMap(([p, item]) => Object.keys(item).map((m) => `${m.toUpperCase()} ${normalise(p)}`)));
    expect(epic.map(([k]) => k).filter((k) => !ops.has(routeKey(k))), 'routes missing from docs/openapi.json (npx tsx server/test/openapi-routes.ts --write)').toEqual([]);
  });

  it('lists every epic permission in docs/permissions.md and docs/api.md', () => {
    const perms = readFileSync(PERMISSIONS_DOC, 'utf8');
    for (const p of EPIC_PERMISSIONS) {
      expect((PERMISSIONS as readonly string[]).includes(p), p).toBe(true);
      expect(perms, p).toMatch(new RegExp('^\\| `' + p + '` \\| yes \\| [1-9]', 'm'));
      expect(md, p).toContain(`\`${p}\``);
    }
  });

  it('reads the forms docs/api.md writes routes in, and notices a route it does not name', () => {
    const doc = documentedRoutes('| `GET /admin/x/:id` | a |\nprose `POST /api/admin/y/:id/run {body}` and `GET/PUT /admin/z?q=`.\n`GET /healthz`');
    expect([...doc]).toEqual(expect.arrayContaining(['GET /api/admin/x/{}', 'POST /api/admin/y/{}/run', 'GET /api/admin/z', 'PUT /api/admin/z', 'GET /healthz']));
    expect(undocumented([['GET /api/admin/x/{tid}', 'cloud:read'], ['DELETE /api/admin/x/{id}', 'cloud:admin']], '| `GET /admin/x/:id` | a |')).toEqual(['DELETE /api/admin/x/{id}']);
  });
});
