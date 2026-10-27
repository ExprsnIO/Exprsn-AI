/*
 * 1.9.99-final (B-10802): which registered routes `docs/api.md` describes. A route counts as described when the
 * document names its method and path in backticks anywhere (a table row `| \`GET /admin/x/:id\` ... |` or prose
 * "`POST /api/admin/x/:id/y`"), with the parameter names ignored and the `/api` prefix optional, as the document's
 * tables write it. `api-docs.test.ts` holds the cloud epic's routes and permissions to it; listing every gap:
 *
 *   npx tsx server/test/api-docs-routes.ts [--all]
 *
 * Without `--all` only the cloud epic's routes are listed (`isEpicRoute`).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RouteAccess } from '../src/authz/routes.js';
import { normalise, toOpenApi } from './openapi-routes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const API_MD = path.resolve(here, '../../docs/api.md');

const METHODS = 'GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS';

/** `GET /api/x/{}` keys of every route `docs/api.md` names in backticks. */
export function documentedRoutes(md: string): Set<string> {
  const out = new Set<string>();
  // `GET /x`, `GET/PUT /x`, `GET /x {body}`, `GET /x?query=`: method(s), one space, a path up to space, ? or backtick.
  const re = new RegExp('`((?:' + METHODS + ')(?:/(?:' + METHODS + '))*)\\s+(/[^`\\s?]*)', 'g');
  for (const m of md.matchAll(re)) {
    const raw = m[2]!.replace(/[.,;:)]+$/, '');
    const bases = raw.startsWith('/api/') || raw === '/api' || /^\/(v1|\.well-known|oauth|saml|scim|xrpc|dav|mcp|hooks|embed|healthz|readyz|metrics|t\/)/.test(raw) ? [raw] : [`/api${raw}`, raw];
    for (const method of m[1]!.split('/'))
      for (const base of bases)
        for (const p of toOpenApi(base)) out.add(`${method} ${normalise(p)}`);
  }
  return out;
}

/** The registry key `GET /api/x/{id}` normalised the same way. */
export const routeKey = (key: string): string => {
  const [method, p] = key.split(' ') as [string, string];
  return `${method} ${normalise(p)}`;
};

const accessPermissions = (a: RouteAccess): string[] => (typeof a === 'string' ? [a] : Array.isArray(a) ? [...a] : 'anyOf' in (a as object) ? [...(a as { anyOf: readonly string[]; all?: readonly string[] }).anyOf, ...((a as { all?: readonly string[] }).all ?? [])] : []);

/** The cloud epic's permissions (Sprint 56, B-10002). */
export const EPIC_PERMISSIONS = ['cloud:read', 'cloud:deploy', 'cloud:admin', 'finops:read', 'finops:manage'] as const;

/**
 * A route the cloud epic (1.9.99-final, Sprints 56 to 62) added: under `/cloud` or `/finops`, guarded by a cloud or
 * FinOps permission, or one of the few it added elsewhere (an instance's AI Gateway, B-10908).
 */
export function isEpicRoute(key: string, access: RouteAccess): boolean {
  const p = key.split(' ')[1] ?? '';
  if (/\/(cloud|cloud-issuer|finops)(\/|$)/.test(p) || /\/ai-gateway(\/|$)/.test(p)) return true;
  return accessPermissions(access).some((x) => (EPIC_PERMISSIONS as readonly string[]).includes(x));
}

/** Registry routes `docs/api.md` does not name. */
export function undocumented(registry: readonly (readonly [string, RouteAccess])[], md: string, only: (key: string, access: RouteAccess) => boolean = () => true): string[] {
  const doc = documentedRoutes(md);
  return registry.filter(([k, a]) => only(k, a) && !doc.has(routeKey(k))).map(([k]) => k);
}

// `npx tsx server/test/api-docs-routes.ts [--all]`
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { ROUTE_PERMISSIONS } = await import('../src/authz/routes.js');
  const md = readFileSync(API_MD, 'utf8');
  const gaps = undocumented(ROUTE_PERMISSIONS, md, process.argv.includes('--all') ? undefined : isEpicRoute);
  process.stdout.write(gaps.length ? `${gaps.join('\n')}\n${gaps.length} route(s) not in docs/api.md\n` : 'Every route is in docs/api.md\n');
  process.exitCode = gaps.length ? 1 : 0;
}
