/*
 * B-2104: the routes the Express app registers, for the check that docs/openapi.json covers every one of them
 * (openapi.test.ts), and a writer that adds the missing ones to docs/openapi.json as minimal operations, with the
 * summary from docs/api.md when it has one:
 *
 *   npx tsx server/test/openapi-routes.ts --write
 *
 * Express 5 does not keep the path a router was mounted at, so `recordMounts()` wraps `Router.prototype.use` and
 * notes it for each layer; call it before the app is built.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

export interface RouteEntry {
  method: string;
  /** The OpenAPI path: `/api/conversations/{id}`. */
  path: string;
}

interface Layer {
  route?: { path: string | string[]; methods: Record<string, boolean> };
  handle?: { stack?: Layer[] };
}

const mounts = new WeakMap<object, string>();
let patched = false;

/** Notes the mount path of every layer added with `use`; idempotent. */
export function recordMounts(): void {
  if (patched) return;
  patched = true;
  const proto = (express.Router as unknown as { prototype: { use: (...a: unknown[]) => unknown; stack?: Layer[] } }).prototype;
  const use = proto.use;
  proto.use = function (this: { stack: Layer[] }, ...args: unknown[]) {
    const before = this.stack.length;
    const first = args[0];
    const at = typeof first === 'string' ? first : Array.isArray(first) && first.every((x) => typeof x === 'string') ? (first as string[])[0]! : '/';
    const r = use.apply(this, args);
    for (const layer of this.stack.slice(before)) mounts.set(layer, at);
    return r;
  };
}

/** The path a router layer was mounted at (B-3304's route registry walks the same stacks). */
export const mountPathOf = (layer: object): string | undefined => mounts.get(layer);

/** Express path syntax to OpenAPI: `:id` to `{id}`; optional `{/:x}` groups give both paths; `*splat` to `{splat}`. */
export function toOpenApi(p: string): string[] {
  const opt = /\{([^{}]*)\}/.exec(p);
  if (opt) return [...toOpenApi(p.replace(opt[0], '')), ...toOpenApi(p.replace(opt[0], opt[1]!))];
  const out = p.replace(/:([A-Za-z0-9_]+)/g, '{$1}').replace(/\*([A-Za-z0-9_]+)/g, '{$1}').replace(/\/+$/, '');
  return [out || '/'];
}

const join = (a: string, b: string) => (a === '/' ? '' : a.replace(/\/$/, '')) + (b === '/' ? '' : b);

/** Every method and path the app answers, with mount prefixes resolved. */
export function listRoutes(app: { router: { stack: Layer[] } } | unknown): RouteEntry[] {
  const out = new Map<string, RouteEntry>();
  const walk = (stack: Layer[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        for (const raw of paths)
          for (const p of toOpenApi(join(prefix, raw)))
            for (const [m, on] of Object.entries(layer.route.methods)) {
              if (!on || m === '_all') continue;
              const method = m.toLowerCase();
              out.set(`${method} ${p}`, { method, path: p });
            }
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack, join(prefix, mounts.get(layer) ?? '/'));
      }
    }
  };
  walk((app as { router: { stack: Layer[] } }).router.stack, '/');
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/** Summaries from docs/api.md tables: `| \`GET /admin/webhooks\` ... | text |`, keyed by method and a normalised path. */
export function apiMdSummaries(md: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of md.split('\n')) {
    const m = /^\|\s*`([A-Z/]+)\s+([^`\s]+)`[^|]*\|\s*(.+?)\s*\|\s*$/.exec(line);
    if (!m) continue;
    const text = m[3]!.replace(/`/g, '').replace(/\s+/g, ' ').slice(0, 240);
    for (const method of m[1]!.split('/')) {
      const raw = m[2]!.split('?')[0]!;
      for (const base of raw.startsWith('/v1') || raw.startsWith('/.well-known') || raw.startsWith('/oauth') || raw.startsWith('/saml') || raw.startsWith('/api/') ? [raw] : [`/api${raw}`, raw])
        for (const p of toOpenApi(base)) out.set(`${method.toLowerCase()} ${normalise(p)}`, text);
    }
  }
  return out;
}

/** Parameter names do not matter for matching: `/a/{id}` and `/a/{tid}` are the same route. */
export const normalise = (p: string) => p.replace(/\{[^}]+\}/g, '{}');

type Doc = { paths: Record<string, Record<string, Record<string, unknown>>> };

const here = path.dirname(fileURLToPath(import.meta.url));
export const OPENAPI_FILE = path.resolve(here, '../../docs/openapi.json');

/** Adds an operation for each route missing from the document (existing operations are kept as written). */
export function addMissing(doc: Doc, routes: RouteEntry[], summaries: Map<string, string>): number {
  let n = 0;
  for (const r of routes) {
    doc.paths[r.path] ??= {};
    if (doc.paths[r.path]![r.method]) continue;
    const params = [...r.path.matchAll(/\{([^}]+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    const segs = r.path.split('/').filter(Boolean);
    const tag = segs[0] === 'api' ? (segs[1] === 'admin' ? `admin/${segs[2] ?? ''}` : (segs[1] ?? 'api')) : segs[0]!;
    doc.paths[r.path]![r.method] = {
      tags: [tag.replace(/\{.*$/, '')],
      summary: summaries.get(`${r.method} ${normalise(r.path)}`) ?? 'See docs/api.md',
      ...(params.length ? { parameters: params } : {}),
      responses: { default: { $ref: '#/components/responses/Default' } }
    };
    n++;
  }
  const sorted: Doc['paths'] = {};
  for (const k of Object.keys(doc.paths).sort()) sorted[k] = doc.paths[k]!;
  doc.paths = sorted;
  return n;
}

// `npx tsx server/test/openapi-routes.ts --write`
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) && process.argv.includes('--write')) {
  recordMounts();
  const { harness } = await import('./helpers.js');
  const h = await harness();
  try {
    const doc = JSON.parse(readFileSync(OPENAPI_FILE, 'utf8')) as Doc;
    const added = addMissing(doc, listRoutes(h.app), apiMdSummaries(readFileSync(path.resolve(here, '../../docs/api.md'), 'utf8')));
    writeFileSync(OPENAPI_FILE, JSON.stringify(doc, null, 2) + '\n');
    process.stdout.write(`Added ${added} operations to ${OPENAPI_FILE}.\n`);
  } finally {
    await h.close();
  }
}
