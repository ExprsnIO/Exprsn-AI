import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../../audit/chain.js';
import { authorize, effectivePermissions, type Principal } from '../../authz/policy.js';
import { ip, noStore, parseBody, principalOf, requireAnyPermission, requireAuth, requirePermission, requireRecentAuth } from '../../http/middleware.js';
import { forbidden } from '../../http/problem.js';
import { SCAN_FORMATS } from '../../security/scan-formats.js';
import { ARTEFACT_KINDS, DIGEST_RE, KIND_PERMISSION, MAX_REPORT_BYTES, SecurityScans, type ArtefactKind, type ScanActor } from '../../security/scans.js';
import type { Services } from '../../services.js';

/*
 * 1.8.0, Sprint 48 (B-144): security scan results, the gate's policy and its exceptions.
 *
 *   PUT    /admin/security/scans/upload            a raw report (Trivy JSON, SARIF, CycloneDX) for `?kind=&digest=`
 *                                                  (the kind's permission; a CI hook uses an API key with it)
 *   GET    /admin/security/scans                   results, newest first (`kind`, `digest`, `limit`)
 *   GET    /admin/security/scans/:id               one result with its normalised findings
 *   DELETE /admin/security/scans/:id               platform:manage, recent sign-in
 *   GET    /admin/security/policy                  the tenant's gate policy
 *   PUT    /admin/security/policy                  platform:manage, recent sign-in
 *   POST   /admin/security/gate                    what the gate would decide for `{ kind, digest }` (nothing written)
 *   GET    /admin/security/gate/pipelines/:id      the gate for a pipeline's next promotion (`to`, `package`)
 *   GET    /admin/security/exceptions              accepted and pending findings
 *   POST   /admin/security/exceptions              request one (pending until a second admin approves)
 *   POST   /admin/security/exceptions/:id/approve  platform:manage, someone other than the requester
 *   POST   /admin/security/exceptions/:id/reject   platform:manage
 *   POST   /admin/security/exceptions/:id/withdraw the requester
 *   POST   /admin/security/exceptions/:id/revoke   platform:manage
 *
 * The tenant is always the caller's; results are filtered by the kinds the caller may read and by clearance.
 */

const id26 = z.string().regex(/^[0-9A-Za-z]{26}$/);
const kind = z.enum(ARTEFACT_KINDS);
const digest = z.string().regex(DIGEST_RE, 'sha256: followed by 64 lower-case hexadecimal characters');
const note = z.string().trim().max(500).nullable().optional();
const ANY = ['apps:design', 'plugins:manage', 'platform:manage'] as const;

export function securityScanRoutes(s: Services): Router {
  const r = Router();
  const any = requireAnyPermission(s, ANY);
  const platform = requirePermission(s, 'platform:manage');
  const design = requirePermission(s, 'apps:design');
  r.use('/security', noStore, requireAuth());
  const scans = () => s.securityScans;

  const actor = (req: Request): ScanActor => {
    const p = principalOf(req);
    return { tenantId: p.tenantId, userId: p.userId, clearance: p.clearance, audit: { ...actorFrom(p, ip(req)), ...(req.apiKey ? { via: 'api-key' } : {}) }, traceId: req.traceId ?? null };
  };
  const kindsOf = (p: Principal): ArtefactKind[] => {
    const held = effectivePermissions(p);
    return ARTEFACT_KINDS.filter((k) => held.has(KIND_PERMISSION[k]));
  };
  const needKind = (p: Principal, k: ArtefactKind) => {
    const d = authorize(p, KIND_PERMISSION[k]);
    if (!d.allow) throw forbidden(`Results for a ${k} need ${KIND_PERMISSION[k]}.`, { step: d.step, action: KIND_PERMISSION[k] });
  };

  // Reports can be far larger than the API's JSON limit: the body is read raw here (app.ts skips its JSON parser).
  const raw = express.raw({ type: () => true, limit: MAX_REPORT_BYTES });
  r.put('/security/scans/upload', any, raw, async (req, res) => {
    const q = parseBody(z.object({ kind, digest: digest.optional(), ref: z.string().trim().min(1).max(300).optional(), format: z.enum(SCAN_FORMATS).optional(), scannedAt: z.coerce.number().int().min(0).optional() }).strict(), req.query);
    const p = principalOf(req);
    needKind(p, q.kind);
    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    const out = await scans().upload(actor(req), { kind: q.kind, digest: q.digest ?? null, ref: q.ref ?? null, ...(q.format ? { format: q.format } : {}), scannedAt: q.scannedAt ?? null, via: req.apiKey ? 'api' : 'console' }, body);
    res.status(201).json(out);
  });

  r.get('/security/scans', any, async (req, res) => {
    const q = parseBody(z.object({ kind: kind.optional(), digest: digest.optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).strict(), req.query);
    const p = principalOf(req);
    const kinds = kindsOf(p).filter((k) => !q.kind || k === q.kind);
    res.json({ kinds: kindsOf(p), results: await scans().list(p.tenantId, p.clearance, { kinds, ...(q.digest ? { digest: q.digest } : {}), limit: q.limit }) });
  });

  r.get('/security/scans/:id', any, async (req, res) => {
    const p = principalOf(req);
    res.json(await scans().get(p.tenantId, p.clearance, parseBody(id26, req.params.id), kindsOf(p)));
  });

  r.delete('/security/scans/:id', platform, requireRecentAuth(s), async (req, res) => {
    await scans().remove(actor(req), parseBody(id26, req.params.id));
    res.status(204).end();
  });

  r.get('/security/policy', any, async (req, res) => {
    const p = principalOf(req);
    const trivy = ((await s.db('platform_mirrors').where({ kind: 'trivy' }).select('name', 'last_promoted_at', 'max_age_days')) as { name: string; last_promoted_at: number | null; max_age_days: number | null }[]).map((m) => ({ name: m.name, lastPromotedAt: m.last_promoted_at == null ? null : Number(m.last_promoted_at), maxAgeDays: m.max_age_days == null ? null : Number(m.max_age_days) }));
    res.json({ ...(await scans().policy(p.tenantId)), kinds: kindsOf(p), trivyMirrors: trivy });
  });

  r.put('/security/policy', platform, requireRecentAuth(s), async (req, res) => {
    const limit = z.number().int().min(0).max(100_000).nullable();
    const b = parseBody(z.object({ maxCritical: limit, maxHigh: limit, maxAgeDays: z.number().int().min(1).max(3650).nullable(), missing: z.enum(['warn', 'refuse']), licenceDeny: z.array(z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9.+-]+$/, 'an SPDX licence id')).max(200) }).strict(), req.body);
    res.json(await scans().setPolicy(actor(req), b));
  });

  r.post('/security/gate', any, async (req, res) => {
    const b = parseBody(z.object({ kind, digest: digest.nullable(), ref: z.string().trim().max(300).nullable().optional() }).strict(), req.body);
    const p = principalOf(req);
    needKind(p, b.kind);
    res.json(await scans().evaluate(p.tenantId, { kind: b.kind, digest: b.digest, ref: b.ref ?? null }));
  });

  // The promotion dialog's preview: the package the promotion would carry, gated as it would be (nothing written).
  r.get('/security/gate/pipelines/:id', design, async (req, res) => {
    const q = parseBody(z.object({ to: z.enum(['test', 'production']), package: id26.optional() }).strict(), req.query);
    const p = principalOf(req);
    const target = await s.apps.pipelines.gateTarget(p, parseBody(id26, req.params.id), q.to, q.package ?? null);
    if (!target) {
      // A promotion to test without a chosen package builds a new one: it has no result yet.
      const policy = await scans().evaluate(p.tenantId, { kind: 'app-package', digest: null, name: 'a new package of the development app' });
      return void res.json({ ...policy, newPackage: true, warnings: [policy.policy.missing === 'refuse' ? 'A new package is built for this promotion; it has no scan result, so the policy refuses it. Choose a scanned package instead.' : 'A new package is built for this promotion; it has no scan result yet, so it is allowed with a warning. Choose a scanned package to have its findings checked.'] });
    }
    res.json({ ...(await scans().evaluate(p.tenantId, SecurityScans.packageArtefact(target))), newPackage: false });
  });

  r.get('/security/exceptions', any, async (req, res) => {
    const q = parseBody(z.object({ state: z.enum(['pending', 'active', 'rejected', 'withdrawn', 'revoked']).optional() }).strict(), req.query);
    res.json({ exceptions: await scans().exceptions(principalOf(req).tenantId, q.state ? { state: q.state } : {}) });
  });

  r.post('/security/exceptions', any, async (req, res) => {
    const b = parseBody(
      z.object({ findingId: z.string().trim().min(1).max(200), package: z.string().trim().min(1).max(200).nullable().optional(), kind: kind.nullable().optional(), digest: digest.nullable().optional(), reason: z.string().trim().min(10).max(1000), expiresAt: z.number().int().positive() }).strict(),
      req.body
    );
    const p = principalOf(req);
    if (b.kind) needKind(p, b.kind);
    else if (!authorize(p, 'platform:manage').allow) throw forbidden('An exception for every kind of artefact needs platform:manage; name the kind.', { step: 'role', action: 'platform:manage' });
    res.status(201).json(await scans().requestException(actor(req), { findingId: b.findingId, package: b.package ?? null, kind: b.kind ?? null, digest: b.digest ?? null, reason: b.reason, expiresAt: b.expiresAt }));
  });

  r.post('/security/exceptions/:id/approve', platform, requireRecentAuth(s), async (req, res) => {
    const b = parseBody(z.object({ note }).strict(), req.body ?? {});
    res.json(await scans().approveException(actor(req), parseBody(id26, req.params.id), b.note ?? null));
  });

  r.post('/security/exceptions/:id/reject', platform, async (req, res) => {
    const b = parseBody(z.object({ note }).strict(), req.body ?? {});
    res.json(await scans().rejectException(actor(req), parseBody(id26, req.params.id), b.note ?? null));
  });

  r.post('/security/exceptions/:id/withdraw', any, async (req, res) => {
    parseBody(z.object({}).strict(), req.body ?? {});
    res.json(await scans().withdrawException(actor(req), parseBody(id26, req.params.id)));
  });

  r.post('/security/exceptions/:id/revoke', platform, async (req, res) => {
    const b = parseBody(z.object({ note }).strict(), req.body ?? {});
    res.json(await scans().revokeException(actor(req), parseBody(id26, req.params.id), b.note ?? null));
  });

  return r;
}
