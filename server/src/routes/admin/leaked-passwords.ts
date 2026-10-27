import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../../audit/chain.js';
import { effectivePermissions } from '../../authz/policy.js';
import { ip, noStore, parseBody, principalOf, requireAnyPermission, requireAuth, requirePermission } from '../../http/middleware.js';
import { badRequest, HttpProblem } from '../../http/problem.js';
import { HASH_KINDS, IMPORT_FORMATS } from '../../identity/leaked/hashes.js';
import { FAIL_MODES, SIGNIN_ACTIONS, type Actor, type ListRow, type VersionRow } from '../../identity/leaked/service.js';
import { MAX_DENY_WORDS } from '../../identity/deny-words.js';
import type { Services } from '../../services.js';

/*
 * 1.9.0, Sprint 55 (B-192 to B-195): Platform › Leaked passwords.
 *
 *   GET    /admin/leaked-passwords/lists?scope=platform|tenant   lists with their active version's size
 *   POST   /admin/leaked-passwords/lists                         a new list { scope, name, description, hashKind }
 *   GET    /admin/leaked-passwords/lists/:id                     one list and its versions
 *   PATCH  /admin/leaked-passwords/lists/:id                     { enabled, description }
 *   DELETE /admin/leaked-passwords/lists/:id                     the list, its versions and their blobs
 *   PUT    /admin/leaked-passwords/lists/:id/upload              the raw list (?format=hibp|hashes|plain&note=&activate=):
 *                                                                streamed, parsed to digests, built by a job (202)
 *   POST   /admin/leaked-passwords/lists/:id/mirror              start or resume an HIBP mirror (platform lists) (202)
 *   POST   /admin/leaked-passwords/lists/:id/versions/:v/activate  make a built version active (replace or roll back)
 *   DELETE /admin/leaked-passwords/lists/:id/versions/:v         remove an inactive version
 *   GET    /admin/leaked-passwords/settings                      the tenant's sign-in action, fail mode, deny words
 *   PUT    /admin/leaked-passwords/settings                      change them
 *   GET    /admin/leaked-passwords/report                        accounts found on a list at sign-in, and changed since
 *
 * Platform lists need platform:manage; the tenant's own lists, its settings and the report need identity:manage (held
 * by the Identity admin and Tenant admin roles). The tenant is always the caller's.
 */

const id26 = z.string().regex(/^[0-9A-Za-z]{26}$/);
const scope = z.enum(['platform', 'tenant']);
const listName = z.string().trim().min(1).max(100).regex(/^[\p{L}\p{N}][\p{L}\p{N} ._()-]*$/u, 'Letters, digits, spaces, dots, dashes, underscores and brackets');
const description = z.string().trim().max(500).nullable().optional();
const versionNo = z.coerce.number().int().min(1).max(1_000_000);
const flag = z.enum(['true', 'false']).transform((v) => v === 'true');
const ANY = ['platform:manage', 'identity:manage'] as const;

export const listView = (l: ListRow & { activeEntries?: number | null; versions?: number }) => ({
  id: l.id, scope: l.owner === 'platform' ? 'platform' : 'tenant', name: l.name, description: l.description, hashKind: l.hash_kind, source: l.source, enabled: l.enabled,
  activeVersion: l.active_version, latestVersion: l.latest_version, ...(l.activeEntries !== undefined ? { activeEntries: l.activeEntries } : {}), ...(l.versions !== undefined ? { versions: l.versions } : {}),
  createdAt: l.created_at, updatedAt: l.updated_at
});

export const versionView = (v: VersionRow) => ({
  version: v.version, state: v.state, format: v.format, source: v.source, note: v.note, activate: v.activate,
  linesRead: v.lines_read, invalid: v.invalid, duplicates: v.duplicates, entries: v.entries, bytes: v.bytes,
  bloom: { bits: v.bloom_bits, hashes: v.bloom_hashes, falsePositiveRate: v.fp_rate }, prefixLength: v.prefix_len,
  mirror: v.mirror_total != null ? { cursor: v.mirror_cursor, total: v.mirror_total } : null,
  jobId: v.job_id, error: v.error, createdAt: v.created_at, builtAt: v.built_at
});

export function leakedPasswordRoutes(s: Services): Router {
  const r = Router();
  r.use('/leaked-passwords', noStore, requireAuth());
  const any = requireAnyPermission(s, ANY);
  const identity = requirePermission(s, 'identity:manage');
  const platform = requirePermission(s, 'platform:manage');
  const svc = () => s.leakedPasswords;

  const actor = (req: Request): Actor => {
    const p = principalOf(req);
    const held = effectivePermissions(p);
    return { tenantId: p.tenantId, userId: p.userId, audit: { ...actorFrom(p, ip(req)), ...(req.apiKey ? { via: 'api-key' } : {}) }, traceId: req.traceId ?? null, platform: held.has('platform:manage'), identity: held.has('identity:manage') };
  };

  r.get('/leaked-passwords/lists', any, async (req, res) => {
    const q = parseBody(z.object({ scope: scope.optional() }).strict(), req.query);
    const a = actor(req);
    const sc = q.scope ?? (a.platform ? 'platform' : 'tenant');
    const out = await svc().lists(a, sc);
    res.json({ installed: await svc().installed(), scope: sc, lists: out.lists.map(listView), ...(sc === 'tenant' ? { platformLists: out.platformLists } : {}) });
  });

  r.post('/leaked-passwords/lists', any, async (req, res) => {
    const body = parseBody(z.object({ scope, name: listName, description, hashKind: z.enum(HASH_KINDS).default('sha1') }).strict(), req.body);
    res.status(201).json(listView(await svc().create(actor(req), { scope: body.scope, name: body.name, description: body.description ?? null, hashKind: body.hashKind })));
  });

  r.get('/leaked-passwords/lists/:id', any, async (req, res) => {
    const l = await svc().getList(actor(req), parseBody(id26, req.params.id));
    res.json({ ...listView(l), versions: (await svc().versions(l.id)).map(versionView) });
  });

  r.patch('/leaked-passwords/lists/:id', any, async (req, res) => {
    const body = parseBody(z.object({ enabled: z.boolean().optional(), description }).strict(), req.body);
    res.json(listView(await svc().update(actor(req), parseBody(id26, req.params.id), body)));
  });

  r.delete('/leaked-passwords/lists/:id', any, async (req, res) => {
    await svc().remove(actor(req), parseBody(id26, req.params.id));
    res.status(204).end();
  });

  /** The list as the raw request body (text/plain or application/octet-stream), never read whole. */
  r.put('/leaked-passwords/lists/:id/upload', any, async (req, res) => {
    const q = parseBody(z.object({ format: z.enum(IMPORT_FORMATS), note: z.string().trim().max(500).optional(), activate: flag.optional() }).strict(), req.query);
    const max = s.cfg.LEAKED_UPLOAD_MAX_BYTES;
    const declared = Number(req.header('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > max) throw new HttpProblem(413, 'Payload too large', `The list is larger than ${max} bytes (LEAKED_UPLOAD_MAX_BYTES). Import it with exprsn-ai passwords:import instead.`);
    if (/json|form/i.test(req.header('content-type') ?? '')) throw badRequest('Send the list as text/plain or application/octet-stream.');
    const out = await svc().upload(actor(req), parseBody(id26, req.params.id), { format: q.format, source: req as AsyncIterable<Buffer>, note: q.note ?? null, activate: q.activate ?? true, via: req.apiKey ? 'api' : 'console' });
    res.status(202).json({ version: versionView(out.version), jobId: out.jobId, lines: out.counts.lines, invalid: out.counts.invalid, invalidLines: out.counts.invalidLines, digests: out.counts.records });
  });

  r.post('/leaked-passwords/lists/:id/mirror', platform, async (req, res) => {
    const body = parseBody(z.object({ note: z.string().trim().max(500).nullable().optional(), activate: z.boolean().optional() }).strict(), req.body ?? {});
    const out = await svc().startMirror(actor(req), parseBody(id26, req.params.id), { note: body.note ?? null, ...(body.activate !== undefined ? { activate: body.activate } : {}) });
    res.status(202).json({ version: versionView(out.version), jobId: out.jobId });
  });

  r.post('/leaked-passwords/lists/:id/versions/:version/activate', any, async (req, res) => {
    res.json(listView(await svc().activate(actor(req), parseBody(id26, req.params.id), parseBody(versionNo, req.params.version))));
  });

  r.delete('/leaked-passwords/lists/:id/versions/:version', any, async (req, res) => {
    await svc().removeVersion(actor(req), parseBody(id26, req.params.id), parseBody(versionNo, req.params.version));
    res.status(204).end();
  });

  const settingsView = async (tenantId: string) => {
    const v = await svc().settings(tenantId);
    return { installed: await svc().installed(), signinAction: v.signinAction, failMode: v.failMode, denyWords: v.denyWords, denyTermList: v.denyTermList, updatedAt: v.updatedAt };
  };

  r.get('/leaked-passwords/settings', identity, async (req, res) => {
    res.json(await settingsView(principalOf(req).tenantId));
  });

  r.put('/leaked-passwords/settings', identity, async (req, res) => {
    const body = parseBody(z.object({
      signinAction: z.enum(SIGNIN_ACTIONS).optional(),
      failMode: z.enum(FAIL_MODES).optional(),
      denyWords: z.array(z.string().trim().min(1).max(64)).max(MAX_DENY_WORDS).optional(),
      denyTermList: id26.nullable().optional()
    }).strict(), req.body);
    const words = body.denyWords ? [...new Map(body.denyWords.map((w) => [w.toLowerCase(), w])).values()] : undefined;
    await svc().saveSettings(actor(req), { ...(body.signinAction ? { signinAction: body.signinAction } : {}), ...(body.failMode ? { failMode: body.failMode } : {}), ...(words ? { denyWords: words } : {}), ...(body.denyTermList !== undefined ? { denyTermList: body.denyTermList } : {}) });
    res.json(await settingsView(principalOf(req).tenantId));
  });

  r.get('/leaked-passwords/report', identity, async (req, res) => {
    res.json(await svc().report(principalOf(req).tenantId));
  });

  return r;
}
