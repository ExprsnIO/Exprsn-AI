import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../../audit/chain.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import { badRequest, HttpProblem } from '../../http/problem.js';
import type { Services } from '../../services.js';
import type { OpsActor } from '../../ops/common.js';
import { shortFingerprint } from '../../ops/common.js';
import { STEP_TITLES, type BundleRow, type SignerKeyRow } from '../../ops/bundles.js';
import { MIRROR_KINDS, mirrorView } from '../../ops/mirrors.js';
import { CERT_USES, certStatus, type CertRow } from '../../ops/certs.js';
import type { BackupRow, DrillRow } from '../../ops/backups.js';
import type { SignerProposalRow } from '../../ops/signers.js';
import { hookView } from '../../ops/cert-hooks.js';
import { pushView, targetView } from '../../ops/push.js';

const keyView = (k: SignerKeyRow) => ({ id: k.id, name: k.name, algorithm: k.algorithm, fingerprint: k.fingerprint, short: shortFingerprint(k.fingerprint), publicKeyPem: k.public_key_pem, state: k.state, createdAt: k.created_at, revokedAt: k.revoked_at, revokeReason: k.revoke_reason });

const bundleView = (b: BundleRow, keys: SignerKeyRow[]) => {
  const signer = keys.find((k) => k.id === b.signer_key_id) ?? (b.signer_fingerprint ? keys.find((k) => k.fingerprint === b.signer_fingerprint) : undefined);
  return {
    id: b.id, name: b.name, state: b.state, expedited: b.expedited, ticket: b.ticket, transfer: b.transfer, contents: b.contents, size: b.size, digest: b.digest,
    manifestId: b.manifest_id,
    signer: b.signer_fingerprint ? { fingerprint: b.signer_fingerprint, short: shortFingerprint(b.signer_fingerprint), name: signer?.name ?? null, algorithm: signer?.algorithm ?? null, state: signer?.state ?? 'unknown' } : null,
    steps: b.steps.map((st, i) => ({ title: STEP_TITLES[i], ...st })),
    report: b.report, error: b.error, jobId: b.job_id, createdAt: b.created_at, receivedAt: b.received_at, verifiedAt: b.verified_at, promotedAt: b.promoted_at
  };
};

const certView = (c: CertRow, renewDays: number) => {
  const st = certStatus(c, renewDays);
  return { id: c.id, name: c.name, domains: c.domains, issuedTo: c.issued_to, use: c.use, method: c.method, state: c.state, status: st.status, days: st.days, autoRenew: c.auto_renew, issuer: c.issuer, serial: c.serial, fingerprint: c.fingerprint, notBefore: c.not_before, notAfter: c.not_after, hasKey: !!c.key_sealed, error: c.error, jobId: c.job_id, renewedAt: c.renewed_at, createdAt: c.created_at };
};

const backupView = (b: BackupRow) => ({ id: b.id, state: b.state, kind: b.kind, dbClient: b.db_client, tables: b.tables, rows: b.rows, bytes: b.bytes, manifestHash: b.manifest_hash, signed: !!b.signature, error: b.error, jobId: b.job_id, createdAt: b.created_at, finishedAt: b.finished_at });

const drillView = (d: DrillRow) => ({ id: d.id, backupId: d.backup_id, state: d.state, steps: d.steps, rpoMs: d.rpo_ms, rtoMs: d.rto_ms, rpoTargetMs: d.rpo_target_ms, rtoTargetMs: d.rto_target_ms, withinTarget: d.within_target, detail: d.detail, error: d.error, jobId: d.job_id, createdAt: d.created_at, finishedAt: d.finished_at });

const bundleName = z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/, 'Use lower-case letters, digits, dots, dashes and underscores.');
const mirrorBody = z.object({
  name: z.string().trim().min(1).max(100),
  kind: z.enum(MIRROR_KINDS),
  store: z.string().trim().min(1).max(100),
  url: z.url().max(500),
  consumer: z.string().trim().max(200).nullable().optional(),
  maxAgeDays: z.number().int().min(1).max(3650).nullable().optional()
}).strict();

/** Revocation reasons from RFC 5280 that make sense for a server certificate. */
const REVOKE_REASONS = { unspecified: 0, keyCompromise: 1, superseded: 4, cessationOfOperation: 5 } as const;

/** Platform: import bundles, mirrors, certificates, backups and restore drills (Sprint 9). */
export function platformAdminRoutes(s: Services): Router {
  const r = Router();
  r.use('/platform', noStore, requireAuth(), requirePermission(s, 'platform:manage'));
  const ops = s.ops;

  const names = async (ids: (string | null)[]) => {
    const list = ids.filter((x): x is string => !!x);
    return new Map(((list.length ? await s.db('users').whereIn('id', list).select('id', 'display_name') : []) as { id: string; display_name: string }[]).map((u) => [u.id, u.display_name]));
  };
  const proposalView = async (p: SignerProposalRow) => {
    const n = await names([p.proposed_by, p.decided_by]);
    return { id: p.id, action: p.action, keyId: p.key_id, name: p.name, algorithm: p.algorithm, fingerprint: p.fingerprint, short: p.fingerprint ? shortFingerprint(p.fingerprint) : null, reason: p.reason, state: p.state, proposedBy: p.proposed_by, proposedByName: p.proposed_by ? (n.get(p.proposed_by) ?? null) : null, proposedAt: p.proposed_at, decidedBy: p.decided_by, decidedByName: p.decided_by ? (n.get(p.decided_by) ?? null) : null, decidedAt: p.decided_at, note: p.note };
  };

  const by = (req: Request): OpsActor => {
    const p = principalOf(req);
    return { tenantId: p.tenantId, actor: actorFrom(p, ip(req)), userId: p.userId, traceId: req.traceId };
  };

  r.get('/platform/summary', async (_req, res) => {
    const [summary, bundles, certs, mirrors] = await Promise.all([ops.summary(), ops.bundles.list(), ops.certs.list(), ops.mirrors.list()]);
    const views = certs.map((c) => certView(c, s.cfg.ACME_RENEW_DAYS)).filter((c) => c.status !== 'revoked');
    const next = views.filter((c) => c.days != null).sort((a, b) => a.days! - b.days!)[0];
    res.json({
      ...summary,
      bundles: { total: bundles.length, ready: bundles.filter((b) => b.state === 'ready to promote').length, rejected: bundles.filter((b) => b.state === 'rejected').length, expedited: bundles.filter((b) => b.expedited && b.state !== 'in production' && b.state !== 'rejected').length },
      certificates: { total: views.length, expiring: views.filter((c) => c.status === 'expiring' || c.status === 'expired').length, nextExpiry: next ? { name: next.name, days: next.days } : null },
      mirrors: { total: mirrors.length, stale: mirrors.map(mirrorView).filter((m) => m.stale).length }
    });
  });

  // ---------- signer keys ----------

  r.get('/platform/signers', async (_req, res) => {
    res.json((await ops.bundles.keys()).map(keyView));
  });

  /** Adds a key: at once when none is registered yet, otherwise as a proposal a second platform admin approves (202). */
  r.post('/platform/signers', async (req, res) => {
    const body = parseBody(z.object({ name: z.string().trim().min(1).max(100), publicKeyPem: z.string().min(40).max(4000) }).strict(), req.body);
    const out = await ops.signers.proposeAdd(by(req), body);
    if (out.key) res.status(201).json(keyView(out.key));
    else res.status(202).json({ proposal: await proposalView(out.proposal!) });
  });

  /** Revoking a key is a proposal a second platform admin approves. */
  r.post('/platform/signers/:id/revoke', async (req, res) => {
    const body = parseBody(z.object({ reason: z.string().trim().min(3).max(500) }).strict(), req.body);
    res.status(202).json({ proposal: await proposalView(await ops.signers.proposeRevoke(by(req), String(req.params.id), body.reason)) });
  });

  r.get('/platform/signers/proposals', async (req, res) => {
    const me = principalOf(req).userId;
    res.json(await Promise.all((await ops.signers.list()).map(async (p) => ({ ...(await proposalView(p)), mine: p.proposed_by === me }))));
  });

  r.post('/platform/signers/proposals/:id/approve', async (req, res) => {
    const body = parseBody(z.object({ note: z.string().trim().max(500).nullable().optional() }).strict(), req.body ?? {});
    const out = await ops.signers.approve(by(req), String(req.params.id), body.note ?? null);
    res.json({ proposal: await proposalView(out.proposal), key: keyView(out.key) });
  });

  r.post('/platform/signers/proposals/:id/reject', async (req, res) => {
    const body = parseBody(z.object({ note: z.string().trim().max(500).nullable().optional() }).strict(), req.body ?? {});
    res.json({ proposal: await proposalView(await ops.signers.reject(by(req), String(req.params.id), body.note ?? null)) });
  });

  r.post('/platform/signers/proposals/:id/withdraw', async (req, res) => {
    res.json({ proposal: await proposalView(await ops.signers.withdraw(by(req), String(req.params.id))) });
  });

  // ---------- bundles ----------

  r.get('/platform/bundles', async (_req, res) => {
    const keys = await ops.bundles.keys();
    res.json((await ops.bundles.list()).map((b) => bundleView(b, keys)));
  });

  r.get('/platform/bundles/:id', async (req, res) => {
    res.json(bundleView(await ops.bundles.get(String(req.params.id)), await ops.bundles.keys()));
  });

  r.post('/platform/bundles', async (req, res) => {
    const body = parseBody(z.object({ name: bundleName, transfer: z.enum(['diode', 'removable media', 'upload']).default('upload'), contents: z.string().trim().max(500).nullable().optional(), expedited: z.boolean().default(false), ticket: z.string().trim().max(100).nullable().optional() }).strict(), req.body);
    if (body.expedited && !body.ticket?.replace(/^SEC-$/, '')) throw badRequest('An expedited import needs its security ticket.', { field: 'ticket' });
    res.status(201).json(bundleView(await ops.bundles.create(by(req), body), await ops.bundles.keys()));
  });

  /** The transferred file, as the raw request body (application/octet-stream or application/x-tar), streamed to the blob store. */
  r.put('/platform/bundles/:id/transfer', async (req, res) => {
    const max = s.cfg.PLATFORM_BUNDLE_MAX_BYTES;
    const declared = Number(req.header('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > max) throw new HttpProblem(413, 'Payload too large', `The bundle is above the cap of ${(max / 1e6).toFixed(0)} MB (PLATFORM_BUNDLE_MAX_BYTES).`, { extensions: { cap: 'size', max } });
    if (/json/i.test(req.header('content-type') ?? '')) throw badRequest('Send the bundle as application/octet-stream or application/x-tar.');
    res.status(202).json(bundleView(await ops.bundles.receive(by(req), String(req.params.id), req as AsyncIterable<Buffer>, max), await ops.bundles.keys()));
  });

  r.post('/platform/bundles/:id/verify', async (req, res) => {
    res.status(202).json(bundleView(await ops.bundles.verify(by(req), String(req.params.id)), await ops.bundles.keys()));
  });

  r.post('/platform/bundles/:id/promote', async (req, res) => {
    res.status(202).json(bundleView(await ops.bundles.promote(by(req), String(req.params.id)), await ops.bundles.keys()));
  });

  r.delete('/platform/bundles/:id', async (req, res) => {
    await ops.bundles.remove(by(req), String(req.params.id));
    res.status(204).end();
  });

  // ---------- mirrors ----------

  r.get('/platform/mirrors', async (_req, res) => {
    res.json((await ops.mirrors.list()).map(mirrorView));
  });

  r.post('/platform/mirrors', async (req, res) => {
    const body = parseBody(mirrorBody, req.body);
    res.status(201).json(mirrorView(await ops.mirrors.create(by(req), body)));
  });

  r.patch('/platform/mirrors/:id', async (req, res) => {
    const body = parseBody(mirrorBody.partial(), req.body);
    res.json(mirrorView(await ops.mirrors.update(by(req), String(req.params.id), body)));
  });

  r.delete('/platform/mirrors/:id', async (req, res) => {
    await ops.mirrors.remove(by(req), String(req.params.id));
    res.status(204).end();
  });

  r.post('/platform/mirrors/check', async (req, res) => {
    const body = parseBody(z.object({ mirrorIds: z.array(z.string().max(26)).max(200).optional() }).strict(), req.body ?? {});
    const who = by(req);
    const job = await s.jobs.enqueue({ tenantId: who.tenantId, type: 'ops.mirror.check', payload: body.mirrorIds ? { mirrorIds: body.mirrorIds } : {}, createdBy: who.userId, maxAttempts: 1 });
    await s.audit.append({ tenantId: who.tenantId, action: 'platform.mirror.check.requested', kind: 'admin', actor: who.actor, target: {}, detail: { job: job.id, mirrors: body.mirrorIds ?? 'all' }, traceId: req.traceId });
    res.status(202).json({ jobId: job.id });
  });

  // ---------- certificates ----------

  r.get('/platform/certificates', async (_req, res) => {
    res.json((await ops.certs.list()).map((c) => certView(c, s.cfg.ACME_RENEW_DAYS)));
  });

  r.post('/platform/certificates', async (req, res) => {
    const body = parseBody(z.object({ domains: z.array(z.string().trim().min(1).max(253)).min(1).max(20), issuedTo: z.string().trim().max(200).nullable().optional(), use: z.enum(CERT_USES).default('TLS'), autoRenew: z.boolean().default(true) }).strict(), req.body);
    res.status(202).json(certView(await ops.certs.request(by(req), body), s.cfg.ACME_RENEW_DAYS));
  });

  r.post('/platform/certificates/track', async (req, res) => {
    const body = parseBody(z.object({ pem: z.string().min(100).max(64_000), issuedTo: z.string().trim().max(200).nullable().optional(), use: z.enum(CERT_USES).default('CA') }).strict(), req.body);
    res.status(201).json(certView(await ops.certs.track(by(req), body), s.cfg.ACME_RENEW_DAYS));
  });

  r.patch('/platform/certificates/:id', async (req, res) => {
    const body = parseBody(z.object({ issuedTo: z.string().trim().max(200).nullable().optional(), use: z.enum(CERT_USES).optional(), autoRenew: z.boolean().optional() }).strict(), req.body);
    res.json(certView(await ops.certs.update(by(req), String(req.params.id), body), s.cfg.ACME_RENEW_DAYS));
  });

  r.post('/platform/certificates/:id/renew', async (req, res) => {
    res.status(202).json(certView(await ops.certs.renew(by(req), String(req.params.id)), s.cfg.ACME_RENEW_DAYS));
  });

  r.post('/platform/certificates/:id/revoke', async (req, res) => {
    const body = parseBody(z.object({ reason: z.enum(Object.keys(REVOKE_REASONS) as [keyof typeof REVOKE_REASONS]).default('unspecified') }).strict(), req.body);
    res.json(certView(await ops.certs.revoke(by(req), String(req.params.id), REVOKE_REASONS[body.reason]), s.cfg.ACME_RENEW_DAYS));
  });

  r.delete('/platform/certificates/:id', async (req, res) => {
    await ops.certs.remove(by(req), String(req.params.id));
    res.status(204).end();
  });

  r.get('/platform/certificates/:id/chain', async (req, res) => {
    const c = await ops.certs.get(String(req.params.id));
    if (!c.chain_pem) throw new HttpProblem(409, 'Conflict', 'The certificate has not been issued yet.');
    res.type('application/pem-certificate-chain').setHeader('content-disposition', `attachment; filename="${c.name.replace(/[^A-Za-z0-9._-]/g, '_')}.pem"`);
    res.send(c.chain_pem);
  });

  /** The private key, for the deploy tooling. POST so it is CSRF-checked; audited every time. */
  r.post('/platform/certificates/:id/key', async (req, res) => {
    res.type('application/x-pem-file').send(await ops.certs.exportKey(by(req), String(req.params.id)));
  });

  // ---------- registry pushes (Sprint 18, B-909) ----------

  r.get('/platform/push-targets', async (_req, res) => {
    res.json((await ops.push.targets()).map(targetView));
  });

  r.put('/platform/mirrors/:id/push-target', async (req, res) => {
    const body = parseBody(z.object({ url: z.url().max(500).refine((u) => /^https?:\/\//.test(u), 'http:// or https:// URL'), repository: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/).nullable().optional(), username: z.string().trim().max(200).nullable().optional(), secret: z.string().min(1).max(4000).nullable().optional(), state: z.enum(['active', 'disabled']).optional() }).strict(), req.body);
    const m = await ops.mirrors.get(String(req.params.id));
    res.json(targetView(await ops.push.setTarget(by(req), m, body)));
  });

  r.delete('/platform/mirrors/:id/push-target', async (req, res) => {
    await ops.push.removeTarget(by(req), await ops.mirrors.get(String(req.params.id)));
    res.status(204).end();
  });

  r.get('/platform/bundles/:id/pushes', async (req, res) => {
    const b = await ops.bundles.get(String(req.params.id));
    res.json((await ops.push.pushes(b.id)).map(pushView));
  });

  r.post('/platform/bundles/:id/push', async (req, res) => {
    const out = await ops.push.request(by(req), String(req.params.id));
    if (!out) throw new HttpProblem(409, 'Conflict', 'No mirror has an active push target. Set one on an image, npm or PyPI mirror first.');
    res.status(202).json(out);
  });

  // ---------- certificate push hooks (Sprint 18, B-904) ----------

  r.get('/platform/certificates/:id/hooks', async (req, res) => {
    const c = await ops.certs.get(String(req.params.id));
    res.json({ hooks: (await ops.certs.hooks.list(c.id)).map(hookView), commands: ops.certs.hooks.commandNames() });
  });

  r.post('/platform/certificates/:id/hooks', async (req, res) => {
    const body = parseBody(z.discriminatedUnion('kind', [z.object({ kind: z.literal('command'), command: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/) }).strict(), z.object({ kind: z.literal('webhook'), url: z.url().max(500).refine((u) => /^https?:\/\//.test(u), 'http:// or https:// URL') }).strict()]), req.body);
    const c = await ops.certs.get(String(req.params.id));
    const { hook, secret } = await ops.certs.hooks.add(by(req), c, body);
    // The webhook secret is shown once; it is stored sealed.
    res.status(201).json({ ...hookView(hook), ...(secret ? { secret } : {}) });
  });

  r.post('/platform/certificates/:id/hooks/:hookId/test', async (req, res) => {
    const c = await ops.certs.get(String(req.params.id));
    res.json(hookView(await ops.certs.hooks.test(by(req), c, String(req.params.hookId))));
  });

  r.delete('/platform/certificates/:id/hooks/:hookId', async (req, res) => {
    const c = await ops.certs.get(String(req.params.id));
    await ops.certs.hooks.remove(by(req), c, String(req.params.hookId));
    res.status(204).end();
  });

  // ---------- data keys ----------

  r.get('/platform/keys', async (_req, res) => {
    res.json(await ops.dataKeys());
  });

  r.post('/platform/keys/:scope/rotate', async (req, res) => {
    const scope = String(req.params.scope);
    if (!/^[A-Za-z0-9-]{1,26}$/.test(scope)) throw badRequest('Unknown key scope.');
    res.json(await ops.rotateKey(by(req), scope));
  });

  // ---------- backups and restore drills ----------

  r.get('/platform/backups', async (_req, res) => {
    const [backups, drills, alert] = await Promise.all([ops.backups.list(), ops.backups.drills(), ops.backups.alert()]);
    res.json({ backups: backups.map(backupView), drills: drills.map(drillView), alert, rpoMinutes: s.cfg.PLATFORM_BACKUP_RPO_MINUTES, rtoMinutes: s.cfg.PLATFORM_BACKUP_RTO_MINUTES, everyMinutes: s.cfg.PLATFORM_BACKUP_MINUTES, retain: s.cfg.PLATFORM_BACKUP_RETAIN, dbClient: s.cfg.DB_CLIENT, blobStore: s.blobs.kind, kms: s.kms.kind, blobsBackedUp: s.cfg.PLATFORM_BACKUP_BLOBS });
  });

  r.post('/platform/backups', async (req, res) => {
    res.status(202).json(backupView(await ops.backups.request(by(req), 'manual')));
  });

  r.post('/platform/backups/drills', async (req, res) => {
    const body = parseBody(z.object({ backupId: z.string().max(26).nullable().optional() }).strict(), req.body ?? {});
    res.status(202).json(drillView(await ops.backups.requestDrill(by(req), body.backupId ?? null)));
  });

  r.get('/platform/backups/drills/:id', async (req, res) => {
    res.json(drillView(await ops.backups.drill(String(req.params.id))));
  });

  r.post('/platform/backups/alert/acknowledge', async (req, res) => {
    await ops.backups.acknowledge(by(req));
    res.json({ alert: await ops.backups.alert() });
  });

  return r;
}

/**
 * ACME http-01: the internal CA fetches /.well-known/acme-challenge/<token> over plain HTTP on port 80 of each
 * domain. Public (the CA has no session) and answers only tokens of orders in flight.
 */
export function acmeChallengeRoutes(s: Services): Router {
  const r = Router();
  r.get('/.well-known/acme-challenge/:token', async (req, res) => {
    const answer = await s.ops.certs.challengeResponse(String(req.params.token));
    if (!answer) {
      res.status(404).type('text/plain').send('Not found');
      return;
    }
    res.type('text/plain').setHeader('cache-control', 'no-store');
    res.send(answer);
  });
  return r;
}
