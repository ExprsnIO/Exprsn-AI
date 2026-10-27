import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../../audit/chain.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission, requireRecentAuth } from '../../http/middleware.js';
import { notFound } from '../../http/problem.js';
import type { Services } from '../../services.js';
import type { OpsActor } from '../../ops/common.js';
import type { FindingRow, RunRow } from '../../ops/blob-integrity.js';
import type { QuarantineKind } from '../../ops/storage.js';

const runView = (r: RunRow) => ({ id: r.id, state: r.state, checksums: r.checksums, store: r.store, objects: r.objects, bytes: r.bytes, missing: r.missing, orphans: r.orphans, orphanBytes: r.orphan_bytes, mismatches: r.mismatches, references: r.refs, error: r.error, jobId: r.job_id, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at });
const findingView = (f: FindingRow) => ({ id: f.id, kind: f.kind, object: f.blob_key, size: f.size, modifiedAt: f.modified_at, referencedBy: f.referenced_by, expected: f.expected, actual: f.actual, state: f.state, resolvedAt: f.resolved_at, note: f.note, foundAt: f.found_at });

const KINDS = ['attachment', 'file', 'knowledge', 'media'] as const;
const reason = z.string().trim().min(3, 'Give a reason of at least 3 characters.').max(500);

/** 1.6.0, Sprint 35c (B-4204): Storage. Platform admins only (platform:manage). */
export function storageAdminRoutes(s: Services): Router {
  const r = Router();
  const manage = [noStore, requireAuth(), requirePermission(s, 'platform:manage')];
  const session = [noStore, requireAuth({ sessionOnly: true }), requirePermission(s, 'platform:manage')];
  const st = s.storage;
  const by = (req: Request): OpsActor => {
    const p = principalOf(req);
    return { tenantId: p.tenantId, actor: actorFrom(p, ip(req)), userId: p.userId, traceId: req.traceId };
  };
  const kind = (req: Request): QuarantineKind => {
    const k = String(req.params.kind);
    if (!(KINDS as readonly string[]).includes(k)) throw notFound('Quarantined object');
    return k as QuarantineKind;
  };

  r.get('/storage/stores', ...manage, async (_req, res) => {
    res.json(await st.stores());
  });

  r.get('/storage/usage', ...manage, async (_req, res) => {
    res.json(await st.usage());
  });

  r.get('/storage/quarantine', ...manage, async (_req, res) => {
    const [items, scanner] = await Promise.all([st.quarantine(), st.scanner()]);
    res.json({ items, scanner });
  });

  r.post('/storage/quarantine/:kind/:id/rescan', ...session, async (req, res) => {
    res.status(202).json(await st.rescan(by(req), kind(req), String(req.params.id)));
  });

  r.post('/storage/quarantine/:kind/:id/delete', ...session, async (req, res) => {
    const body = parseBody(z.object({ reason: z.string().trim().max(500).nullable().optional() }).strict(), req.body ?? {});
    await st.discard(by(req), kind(req), String(req.params.id), body.reason || null);
    res.status(204).end();
  });

  r.get('/storage/integrity', ...manage, async (_req, res) => {
    const [runs, findings] = await Promise.all([st.integrity.runs(10), st.integrity.findings(500)]);
    const last = runs.find((x) => x.state === 'succeeded') ?? null;
    res.json({ runs: runs.map(runView), last: last ? runView(last) : null, running: runs.find((x) => x.state === 'queued' || x.state === 'running') ? runView(runs.find((x) => x.state === 'queued' || x.state === 'running')!) : null, findings: findings.map(findingView), graceHours: s.cfg.BLOBS_ORPHAN_GRACE_HOURS, dryRunMinutes: s.cfg.BLOBS_DRY_RUN_MINUTES, everyMinutes: s.cfg.BLOBS_VERIFY_MINUTES });
  });

  r.post('/storage/integrity/verify', ...session, async (req, res) => {
    const body = parseBody(z.object({ checksums: z.boolean().optional() }).strict(), req.body ?? {});
    res.status(202).json(runView(await st.integrity.queue(by(req), { checksums: !!body.checksums })));
  });

  r.post('/storage/orphans/dry-run', ...session, async (req, res) => {
    const body = parseBody(z.object({ objects: z.array(z.string().min(1).max(512)).min(1).max(10_000).optional() }).strict(), req.body ?? {});
    res.json(await st.integrity.dryRun(by(req), body.objects ?? null));
  });

  r.post('/storage/orphans/delete', ...session, async (req, res) => {
    const body = parseBody(z.object({ dryRun: z.string().min(1).max(26), reason }).strict(), req.body);
    res.json(await st.integrity.deleteOrphans(by(req), body.dryRun, body.reason));
  });

  r.post('/storage/findings/:id/accept', ...session, async (req, res) => {
    const body = parseBody(z.object({ reason }).strict(), req.body);
    res.json(findingView(await st.integrity.acceptChecksum(by(req), String(req.params.id), body.reason)));
  });

  r.get('/storage/purges', ...manage, async (_req, res) => {
    res.json(await st.purges());
  });

  r.get('/storage/migrations', ...manage, async (_req, res) => {
    res.json({ migrations: await st.migrations(20), active: await st.activeLabel() });
  });

  // Decision Q16: a copy-then-switch job, started with a recent sign-in and a reason.
  r.post('/storage/migrations', ...session, requireRecentAuth(s), async (req, res) => {
    const body = parseBody(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('fs'), dir: z.string().trim().min(1).max(500), reason }).strict(),
        z.object({ kind: z.literal('s3'), endpoint: z.url().max(500), bucket: z.string().trim().min(3).max(63), region: z.string().trim().min(1).max(40).optional(), pathStyle: z.boolean().optional(), accessKeyId: z.string().trim().min(1).max(200), secretAccessKey: z.string().min(1).max(500), reason }).strict()
      ]),
      req.body
    );
    const { reason: why, ...target } = body;
    res.status(202).json(await st.startMigration(by(req), target, why));
  });

  r.post('/storage/migrations/:id/retire', ...session, requireRecentAuth(s), async (req, res) => {
    const body = parseBody(z.object({ reason }).strict(), req.body);
    res.json(await st.retireMigration(by(req), String(req.params.id), body.reason));
  });

  return r;
}
