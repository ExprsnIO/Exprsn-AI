/*
 * B-3304: the routes the Express app registers, each with what its middleware enforces (requireAuth and the
 * permissions of requirePermission, which tag the handlers they return), for the check that the route permission
 * registry (`server/src/authz/routes.ts`) declares every route correctly (route-registry.test.ts), and a writer that
 * adds the missing routes to the registry with what their middleware says:
 *
 *   npx tsx server/test/route-registry.ts --write
 *
 * A route the writer adds is `public` when nothing on its path requires a sign-in, `authenticated` when only
 * requireAuth does, else the permissions of its requirePermission handlers. Review what it wrote: a handler that
 * checks a permission itself should be declared with that permission.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANY_PERMISSION_TAG, AUTH_TAG, PERMISSION_TAG } from '../src/http/middleware.js';
import type { Permission } from '../src/authz/permissions.js';
import type { RouteAccess } from '../src/authz/routes.js';
import { mountPathOf, recordMounts, toOpenApi } from './openapi-routes.js';

export { recordMounts };

export interface RouteFacts {
  /** `GET /api/admin/users/{id}`. */
  key: string;
  /** requireAuth runs before the handler. */
  auth: boolean;
  /** The permissions requirePermission checks before the handler (all of them). */
  permissions: Permission[];
  /** Permissions of a requireAnyPermission (or another handler declaring any-of) before the handler: one suffices. */
  anyOf: Permission[] | null;
}

type Matcher = (p: string) => unknown;
interface Layer {
  route?: { path: string | string[]; methods: Record<string, boolean>; stack: Layer[] };
  handle?: ((...a: unknown[]) => unknown) & { stack?: Layer[]; [k: symbol]: unknown };
  matchers?: Matcher[];
}

const join = (a: string, b: string) => (a === '/' ? '' : a.replace(/\/$/, '')) + (b === '/' ? '' : b);

interface Tags {
  auth: boolean;
  permissions: Set<Permission>;
  anyOf: Permission[] | null;
}

const tagsOf = (layer: Layer, into: Tags): void => {
  const h = layer.handle;
  if (!h) return;
  if (h[AUTH_TAG]) into.auth = true;
  const perm = h[PERMISSION_TAG];
  if (typeof perm === 'string') into.permissions.add(perm as Permission);
  const any = h[ANY_PERMISSION_TAG];
  if (Array.isArray(any)) into.anyOf = [...(any as Permission[])].sort();
};

const matches = (layer: Layer, p: string): boolean => {
  if (!layer.matchers) return true;
  return layer.matchers.some((m) => {
    try {
      return !!m(p);
    } catch {
      return false;
    }
  });
};

/** Every method and path the app answers, with the requireAuth and requirePermission handlers on its way. */
export function routeFacts(app: unknown): RouteFacts[] {
  const out = new Map<string, RouteFacts>();
  const walk = (stack: Layer[], prefix: string, inherited: Tags) => {
    const before: Layer[] = [];
    for (const layer of stack) {
      if (layer.route) {
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        for (const raw of paths) {
          const tags: Tags = { auth: inherited.auth, permissions: new Set(inherited.permissions), anyOf: inherited.anyOf };
          for (const mw of before) if (matches(mw, raw)) tagsOf(mw, tags);
          for (const l of layer.route.stack) tagsOf(l, tags);
          for (const p of toOpenApi(join(prefix, raw)))
            for (const [m, on] of Object.entries(layer.route.methods)) {
              if (!on || m === '_all') continue;
              const key = `${m.toUpperCase()} ${p}`;
              const prev = out.get(key);
              // The same path mounted twice (tenant-prefixed and not) is one route; it keeps what both ways enforce.
              out.set(key, { key, auth: tags.auth && (prev?.auth ?? true), permissions: [...new Set([...(prev?.permissions ?? []), ...tags.permissions])].sort(), anyOf: tags.anyOf ?? prev?.anyOf ?? null });
            }
        }
      } else if (layer.handle?.stack) {
        const mount = mountOf(layer);
        const tags: Tags = { auth: inherited.auth, permissions: new Set(inherited.permissions), anyOf: inherited.anyOf };
        for (const mw of before) if (matches(mw, mount)) tagsOf(mw, tags);
        walk(layer.handle.stack, join(prefix, mount), tags);
      } else {
        before.push(layer);
      }
    }
  };
  walk((app as { router: { stack: Layer[] } }).router.stack, '/', { auth: false, permissions: new Set(), anyOf: null });
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
}

const mountOf = (layer: Layer): string => mountPathOf(layer) ?? '/';

type Access = RouteAccess;

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/**
 * Compares the registry with what the app registers. `missing`: routes the registry does not declare (the B-3304
 * failure); `stale`: entries for routes that are gone; `duplicates`; `mismatched`: routes whose middleware disagrees
 * with the entry (a requirePermission the entry does not name, an authenticated route declared public, and so on).
 * An entry may name a permission the route's handler checks itself (no middleware tag), but only on a route that
 * requires a sign-in.
 */
export function compareRegistry(facts: RouteFacts[], table: readonly (readonly [string, Access])[]) {
  const declared = new Map<string, Access>();
  const duplicates: string[] = [];
  for (const [k, v] of table) {
    if (declared.has(k)) duplicates.push(k);
    declared.set(k, v);
  }
  const registered = new Set(facts.map((f) => f.key));
  const mismatched: string[] = [];
  for (const f of facts) {
    const d = declared.get(f.key);
    if (d === undefined) continue;
    const tagged = f.permissions.length > 0 || !!f.anyOf;
    const say = (why: string) => mismatched.push(`${f.key}: ${why} (middleware implies ${implied(f)})`);
    if (d === 'public') {
      if (f.auth || tagged) say('declared public');
    } else if (d === 'authenticated') {
      if (!f.auth) say('declared authenticated, but nothing on its path requires a sign-in');
      else if (tagged) say('declared authenticated');
    } else {
      const all: readonly string[] = typeof d === 'string' ? [d] : Array.isArray(d) ? d : ((d as { all?: readonly string[] }).all ?? []);
      const anyOf = typeof d === 'object' && !Array.isArray(d) ? (d as { anyOf: readonly string[] }).anyOf : null;
      if (!tagged) {
        if (!f.auth) say('declares a permission, but nothing on its path requires a sign-in');
      } else if (!same(all, f.permissions) || (anyOf ? !f.anyOf || !same(anyOf, f.anyOf) : !!f.anyOf)) say('declared differently');
    }
  }
  return {
    missing: facts.filter((f) => !declared.has(f.key)).map((f) => `${f.key} -> ${implied(f)}`),
    stale: [...declared.keys()].filter((k) => !registered.has(k)),
    duplicates,
    mismatched
  };
}

export const REGISTRY_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/authz/routes.ts');

const list = (ps: Permission[]) => `[${ps.map((p) => `'${p}'`).join(', ')}]`;

/** The registry entry a route's middleware implies (see `RouteAccess`). */
export function implied(f: RouteFacts): string {
  if (f.anyOf) return f.permissions.length ? `{ all: ${list(f.permissions)}, anyOf: ${list(f.anyOf)} }` : `{ anyOf: ${list(f.anyOf)} }`;
  if (f.permissions.length > 1) return list(f.permissions);
  if (f.permissions.length === 1) return `'${f.permissions[0]}'`;
  return f.auth ? `'authenticated'` : `'public'`;
}

/** Adds the routes the registry does not declare yet, before the closing marker, in path order. */
export function writeMissing(facts: RouteFacts[], declared: Set<string>): number {
  const missing = facts.filter((f) => !declared.has(f.key));
  if (!missing.length) return 0;
  const src = readFileSync(REGISTRY_FILE, 'utf8');
  const marker = '  // ---- end of routes ----';
  if (!src.includes(marker)) throw new Error(`${REGISTRY_FILE} has no "${marker.trim()}" line`);
  const lines = missing.map((f) => `  ['${f.key}', ${implied(f)}],`).join('\n');
  writeFileSync(REGISTRY_FILE, src.replace(marker, `${lines}\n${marker}`));
  return missing.length;
}

// `npx tsx server/test/route-registry.ts --write`
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) && process.argv.includes('--write')) {
  recordMounts();
  const { harness } = await import('./helpers.js');
  const { ROUTE_PERMISSIONS } = await import('../src/authz/routes.js');
  const h = await harness();
  try {
    const n = writeMissing(routeFacts(h.app), new Set(ROUTE_PERMISSIONS.map(([k]) => k)));
    process.stdout.write(`${n} routes added to ${path.relative(process.cwd(), REGISTRY_FILE)}\n`);
  } finally {
    await h.close();
  }
}
