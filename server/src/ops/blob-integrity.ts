import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { conflict, HttpProblem, notFound } from '../http/problem.js';
import type { JobContext } from '../platform/jobs.js';
import type { BlobObject } from '../platform/blob.js';
import type { Services } from '../services.js';
import { BLOB_BACKUP_EXCLUDE, BLOB_UNOWNED_PREFIXES, BlobRefs, listTables } from './backups.js';
import { tableRows } from './restore.js';
import { audit, notifyAdmins, platformTenant, systemActor, type OpsActor } from './common.js';

/*
 * B-4204: the blob integrity check `ops.blobs.verify` and orphan deletion (decision Q10: a dry run, then one admin
 * with a reason).
 *
 * The check lists every object in the blob store, then walks every row of every table:
 * - a `blob_key`, `manifest_key` or `report_key` that names an object the store does not have (checked a second time
 *   object by object, so an object deleted or written during the walk is not reported) is **missing**, except on rows
 *   whose state says they never kept their content (failed, rejected and the like);
 * - an object no row references is an **orphan** when it is older than BLOBS_ORPHAN_GRACE_HOURS. "References" is wide
 *   on purpose: any key-like string in any column or JSON value (the B-903 reference walk the backups use), any
 *   directory a row owns, and any key with a path segment that is the id of a row (derived keys such as a media
 *   asset's previews). Backups (`platform/backups/`, kept by their retention) and content-addressed mirror files are
 *   never orphans. A false "referenced" only leaves an orphan in place; a false orphan would lose data, so every rule
 *   errs towards "referenced";
 * - with checksums on, every object is read: a mirror file's SHA-256 must match its name; any other object's SHA-256
 *   is recorded the first time and compared afterwards. A different hash on an object whose modification time has not
 *   moved since it was recorded is a **mismatch** (the bytes changed outside the server); one that was rewritten
 *   through the store (a key re-wrap re-seals objects) is recorded again.
 * The check never changes the store. Deleting orphans takes a dry run that walks the references again and lists the
 * exact objects; a deletion within BLOBS_DRY_RUN_MINUTES removes those and nothing else, with a reason, audited as
 * platform.blobs.orphans.deleted with the list of objects.
 */

export const VERIFY_JOB = 'ops.blobs.verify';
const KEY_COLUMNS = ['blob_key', 'manifest_key', 'report_key'];
/** Rows in these states never kept (or no longer keep) the content their key names. */
const GONE_STATES = new Set(['failed', 'rejected', 'refused', 'withdrawn', 'cancelled', 'deleted', 'expired', 'purged']);
/** Tables whose rows talk about objects without owning them: the audit chain and this check's own bookkeeping. */
const SKIP_TABLES = new Set(['audit_events', 'platform_blob_findings', 'platform_blob_dryruns', 'platform_blob_checksums', 'platform_blob_runs', 'platform_instance_settings', 'platform_storage_samples']);
const MIRROR_FILE = /^mirrors\/[^/]+\/sha256\/([0-9a-f]{64})$/;
/** Findings kept per kind and run; the counts stay exact. */
const MAX_FINDINGS = 10_000;

export interface RunRow {
  id: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed';
  checksums: boolean;
  store: string | null;
  objects: number | null;
  bytes: number | null;
  missing: number | null;
  orphans: number | null;
  orphan_bytes: number | null;
  mismatches: number | null;
  refs: number | null;
  error: string | null;
  job_id: string | null;
  created_by: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface FindingRow {
  id: string;
  run_id: string;
  kind: 'missing' | 'orphan' | 'mismatch';
  blob_key: string;
  size: number | null;
  modified_at: number | null;
  referenced_by: { table: string; column: string; id: string | null }[] | null;
  expected: string | null;
  actual: string | null;
  state: 'open' | 'deleted' | 'accepted' | 'gone' | 'superseded';
  resolved_by: string | null;
  resolved_at: number | null;
  note: string | null;
  found_at: number;
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const runFrom = (r: Record<string, unknown>): RunRow => ({
  ...(r as unknown as RunRow),
  checksums: !!r.checksums,
  objects: num(r.objects),
  bytes: num(r.bytes),
  missing: num(r.missing),
  orphans: num(r.orphans),
  orphan_bytes: num(r.orphan_bytes),
  mismatches: num(r.mismatches),
  refs: num(r.refs),
  created_at: Number(r.created_at),
  started_at: num(r.started_at),
  finished_at: num(r.finished_at)
});
const findingFrom = (r: Record<string, unknown>): FindingRow => ({
  ...(r as unknown as FindingRow),
  size: num(r.size),
  modified_at: num(r.modified_at),
  referenced_by: r.referenced_by ? (JSON.parse(String(r.referenced_by)) as FindingRow['referenced_by']) : null,
  resolved_at: num(r.resolved_at),
  found_at: Number(r.found_at)
});

/** What the rows of the database reference: keys and owned directories (B-903), row ids, and explicit key columns. */
interface References {
  refs: BlobRefs;
  ids: Set<string>;
  explicit: Map<string, { table: string; column: string; id: string | null }[]>;
  rows: number;
}

const segmentId = (seg: string) => seg.replace(/\..*$/, '').replace(/^(preview|part)-/, '');

export class BlobIntegrity {
  constructor(private readonly s: () => Services) {}

  registerJobs(): void {
    this.s().jobs.register(VERIFY_JOB, async (p, ctx) => {
      const runId = p.runId ? String(p.runId) : (await this.queue(systemActor(ctx.job.tenant_id, ctx.job.created_by), { checksums: !!p.checksums, enqueue: false }).catch(() => null))?.id;
      if (!runId) return { skipped: 'A verification is already running.' };
      return this.run(runId, ctx);
    }, { timeoutMs: 24 * 3_600_000 });
  }

  // ---------- runs and findings ----------

  async runs(limit = 20): Promise<RunRow[]> {
    return ((await this.s().db('platform_blob_runs').orderBy('created_at', 'desc').limit(limit)) as Record<string, unknown>[]).map(runFrom);
  }

  async runRow(id: string): Promise<RunRow> {
    const r = await this.s().db('platform_blob_runs').where({ id }).first();
    if (!r) throw notFound('Verification');
    return runFrom(r);
  }

  async lastSucceeded(): Promise<RunRow | null> {
    const r = await this.s().db('platform_blob_runs').where({ state: 'succeeded' }).orderBy('created_at', 'desc').first();
    return r ? runFrom(r) : null;
  }

  /** The open findings of the latest finished run (and the ones resolved since, for the record). */
  async findings(limit = 500): Promise<FindingRow[]> {
    const last = await this.lastSucceeded();
    if (!last) return [];
    return ((await this.s().db('platform_blob_findings').where({ run_id: last.id }).whereNot({ state: 'superseded' }).orderBy([{ column: 'kind' }, { column: 'blob_key' }]).limit(limit)) as Record<string, unknown>[]).map(findingFrom);
  }

  async finding(id: string): Promise<FindingRow> {
    const r = await this.s().db('platform_blob_findings').where({ id }).first();
    if (!r) throw notFound('Finding');
    return findingFrom(r);
  }

  /** Queues a verification (409 while one is queued or running). */
  async queue(by: OpsActor, o: { checksums: boolean; enqueue?: boolean }): Promise<RunRow> {
    const s = this.s();
    const busy = await s.db('platform_blob_runs').whereIn('state', ['queued', 'running']).andWhere('created_at', '>', Date.now() - 24 * 3_600_000).first();
    if (busy) throw conflict('A verification is already running.');
    const row = { id: ulid(), state: 'queued', checksums: o.checksums, store: (await s.storage.activeLabel()).label, created_by: by.userId, created_at: Date.now() };
    await s.db('platform_blob_runs').insert(row);
    if (o.enqueue !== false) {
      const job = await s.jobs.enqueue({ tenantId: by.tenantId, type: VERIFY_JOB, payload: { runId: row.id, checksums: o.checksums }, createdBy: by.userId, maxAttempts: 1 });
      await s.db('platform_blob_runs').where({ id: row.id }).update({ job_id: job.id });
      await audit(s, by, 'platform.blobs.verify.started', { run: row.id, job: job.id }, { checksums: o.checksums }, 'admin');
    }
    return this.runRow(row.id);
  }

  // ---------- the walk ----------

  /** Every object in the store, by key (temporary files of writes in progress left out). */
  private async listing(signal?: AbortSignal): Promise<Map<string, BlobObject>> {
    const out = new Map<string, BlobObject>();
    for await (const o of this.s().blobs.list('')) {
      if (signal?.aborted) throw new Error('cancelled');
      if (!o.key.endsWith('.tmp')) out.set(o.key, o);
    }
    return out;
  }

  /** Walks every row of every table once. */
  private async references(signal?: AbortSignal): Promise<References> {
    const s = this.s();
    const refs = new BlobRefs();
    const ids = new Set<string>();
    const explicit = new Map<string, { table: string; column: string; id: string | null }[]>();
    let rows = 0;
    for (const t of await listTables(s.db, s.cfg.DB_CLIENT)) {
      if (SKIP_TABLES.has(t)) continue;
      for await (const r of tableRows(s.db, s.cfg.DB_CLIENT, t)) {
        if (signal?.aborted) throw new Error('cancelled');
        rows++;
        // The check's own jobs carry nothing that keeps an object.
        if (t === 'jobs' && String(r.type ?? '').startsWith('ops.blobs.')) continue;
        refs.add(t, r);
        if (t !== 'tenants' && typeof r.id === 'string' && r.id.length >= 10) ids.add(r.id);
        const gone = typeof r.state === 'string' && GONE_STATES.has(r.state);
        for (const c of KEY_COLUMNS) {
          const v = r[c];
          if (typeof v !== 'string' || !v || gone) continue;
          const list = explicit.get(v) ?? [];
          if (list.length < 5) list.push({ table: t, column: c, id: typeof r.id === 'string' ? r.id : null });
          explicit.set(v, list);
        }
      }
    }
    return { refs, ids, explicit, rows };
  }

  /** Whether an object is kept by something (see the header): never an orphan when this says yes. */
  private kept(key: string, r: References): boolean {
    if (BLOB_BACKUP_EXCLUDE.some((p) => key.startsWith(p)) || BLOB_UNOWNED_PREFIXES.some((p) => key.startsWith(p))) return true;
    if (r.refs.includes(key) || r.explicit.has(key)) return true;
    const segs = key.split('/');
    return segs.some((seg, i) => i > 0 && r.ids.has(segmentId(seg)));
  }

  private async exists(key: string): Promise<boolean> {
    const got = await this.s().blobs.getStream(key);
    if (!got) return false;
    got.stream.destroy();
    return true;
  }

  private async sha(key: string): Promise<{ sha256: string; size: number } | null> {
    const got = await this.s().blobs.getStream(key);
    if (!got) return null;
    const h = createHash('sha256');
    let size = 0;
    for await (const c of got.stream as AsyncIterable<Buffer>) {
      h.update(c);
      size += c.length;
    }
    return { sha256: h.digest('hex'), size };
  }

  /** The job: lists, walks, compares, records findings. */
  async run(runId: string, ctx: Pick<JobContext, 'progress' | 'signal'> & { job?: JobContext['job'] }): Promise<Record<string, unknown>> {
    const s = this.s();
    const run = await this.runRow(runId);
    const t0 = Date.now();
    await s.db('platform_blob_runs').where({ id: runId }).update({ state: 'running', started_at: t0, store: (await s.storage.activeLabel()).label });
    try {
      await ctx.progress(2, 'Listing objects');
      const objects = await this.listing(ctx.signal);
      let bytes = 0;
      for (const o of objects.values()) bytes += o.size;
      await ctx.progress(20, `Listed ${objects.size} objects; walking references`);
      const refs = await this.references(ctx.signal);
      await ctx.progress(50, 'Comparing');
      const grace = s.cfg.BLOBS_ORPHAN_GRACE_HOURS * 3_600_000;
      const now = Date.now();
      const found: Omit<FindingRow, 'id' | 'state' | 'resolved_by' | 'resolved_at' | 'note'>[] = [];
      const counts = { missing: 0, orphans: 0, orphanBytes: 0, mismatches: 0 };
      // Missing: a row names an object the store does not have, also on a second look.
      for (const [key, by] of refs.explicit) {
        if (objects.has(key)) continue;
        if (await this.exists(key)) continue;
        counts.missing++;
        if (counts.missing <= MAX_FINDINGS) found.push({ run_id: runId, kind: 'missing', blob_key: key, size: null, modified_at: null, referenced_by: by, expected: null, actual: null, found_at: now });
      }
      // Orphans: an object older than the grace period that nothing keeps.
      for (const [key, o] of objects) {
        if (o.modified != null && now - o.modified < grace) continue;
        if (o.modified == null) continue; // a store that cannot say when an object was written never reports orphans
        if (this.kept(key, refs)) continue;
        counts.orphans++;
        counts.orphanBytes += o.size;
        if (counts.orphans <= MAX_FINDINGS) found.push({ run_id: runId, kind: 'orphan', blob_key: key, size: o.size, modified_at: o.modified, referenced_by: null, expected: null, actual: null, found_at: now });
      }
      // Checksums, when asked: every object is read.
      if (run.checksums) {
        let i = 0;
        const total = objects.size || 1;
        for (const [key, o] of objects) {
          if (ctx.signal.aborted) throw new Error('cancelled');
          i++;
          if (i % 50 === 0) await ctx.progress(50 + Math.round((i * 45) / total), `Checksums: ${i} of ${objects.size}`);
          const got = await this.sha(key);
          if (!got) continue;
          const m = MIRROR_FILE.exec(key);
          let expected: string | null = null;
          if (m) expected = m[1]!;
          else {
            const base = (await s.db('platform_blob_checksums').where({ blob_key: key }).first()) as { sha256: string; size: number | string; verified_at: number | string } | undefined;
            if (!base) await s.db('platform_blob_checksums').insert({ blob_key: key, sha256: got.sha256, size: got.size, first_seen: now, verified_at: now }).catch(() => undefined);
            else if (base.sha256 === got.sha256) await s.db('platform_blob_checksums').where({ blob_key: key }).update({ verified_at: now });
            else if (o.modified != null && o.modified > Number(base.verified_at)) await s.db('platform_blob_checksums').where({ blob_key: key }).update({ sha256: got.sha256, size: got.size, verified_at: now });
            else expected = base.sha256;
          }
          if (expected && expected !== got.sha256) {
            counts.mismatches++;
            if (counts.mismatches <= MAX_FINDINGS) found.push({ run_id: runId, kind: 'mismatch', blob_key: key, size: got.size, modified_at: o.modified ?? null, referenced_by: refs.explicit.get(key) ?? null, expected, actual: got.sha256, found_at: now });
          }
        }
      }
      await ctx.progress(96, 'Recording findings');
      await s.db('platform_blob_findings').where({ state: 'open' }).update({ state: 'superseded' });
      for (let i = 0; i < found.length; i += 200) {
        await s.db('platform_blob_findings').insert(found.slice(i, i + 200).map((f) => ({ ...f, id: ulid(), referenced_by: f.referenced_by ? JSON.stringify(f.referenced_by) : null, state: 'open' })));
      }
      const t1 = Date.now();
      await s.db('platform_blob_runs').where({ id: runId }).update({ state: 'succeeded', objects: objects.size, bytes, missing: counts.missing, orphans: counts.orphans, orphan_bytes: counts.orphanBytes, mismatches: counts.mismatches, refs: refs.rows, finished_at: t1 });
      await sample(s, 'store:blobs', bytes, objects.size);
      const tenantId = run.created_by ? (ctx.job?.tenant_id ?? (await platformTenant(s))) : await platformTenant(s);
      if (tenantId) {
        const by = systemActor(tenantId, run.created_by);
        await audit(s, by, 'platform.blobs.verified', { run: runId }, { objects: objects.size, bytes, missing: counts.missing, orphans: counts.orphans, mismatches: counts.mismatches, checksums: run.checksums, ms: t1 - t0 });
        if (counts.missing || counts.mismatches) await notifyAdmins(s, { kind: 'platform.blobs.findings', title: `Blob verification found ${counts.missing} missing and ${counts.mismatches} changed objects`, body: 'Open Storage › Integrity to restore them from a backup.' }).catch(() => 0);
      }
      return { run: runId, objects: objects.size, bytes, missing: counts.missing, orphans: counts.orphans, mismatches: counts.mismatches };
    } catch (err) {
      await s.db('platform_blob_runs').where({ id: runId }).update({ state: 'failed', error: (err as Error).message.slice(0, 1000), finished_at: Date.now() });
      throw err;
    }
  }

  // ---------- orphan deletion: a dry run, then one admin with a reason ----------

  /**
   * Lists the orphans of the latest run (or the given ones) that are still orphans now: the references are walked
   * again and each object is looked at again. The dry run is what a deletion may remove.
   */
  async dryRun(by: OpsActor, keys: string[] | null): Promise<{ id: string; count: number; bytes: number; oldest: number | null; skipped: number; expiresAt: number; keys: string[] }> {
    const s = this.s();
    const last = await this.lastSucceeded();
    if (!last) throw conflict('Run the integrity check first: there is no finished verification to delete orphans from.');
    const q = s.db('platform_blob_findings').where({ run_id: last.id, kind: 'orphan', state: 'open' });
    if (keys) q.whereIn('blob_key', keys.slice(0, 10_000));
    const candidates = ((await q) as Record<string, unknown>[]).map(findingFrom);
    if (!candidates.length) throw conflict(keys ? 'None of those objects is an open orphan finding of the latest verification.' : 'The latest verification found no orphans.');
    const refs = await this.references();
    const grace = s.cfg.BLOBS_ORPHAN_GRACE_HOURS * 3_600_000;
    const objects = candidates.length > 200 ? await this.listing() : null;
    const now = Date.now();
    const still: FindingRow[] = [];
    let skipped = 0;
    for (const f of candidates) {
      let present: BlobObject | undefined;
      if (objects) present = objects.get(f.blob_key);
      else {
        const got = await s.blobs.getStream(f.blob_key);
        if (got) {
          got.stream.destroy();
          present = { key: f.blob_key, size: got.size, ...(f.modified_at != null ? { modified: f.modified_at } : {}) };
        }
      }
      if (!present) {
        skipped++;
        await s.db('platform_blob_findings').where({ id: f.id }).update({ state: 'gone', resolved_at: now });
        continue;
      }
      if (this.kept(f.blob_key, refs) || (present.modified != null && now - present.modified < grace)) {
        skipped++;
        continue;
      }
      still.push({ ...f, size: present.size });
    }
    if (!still.length) throw conflict('Nothing to delete: every object listed is gone or is referenced again.');
    const bytes = still.reduce((a, f) => a + (f.size ?? 0), 0);
    const oldest = still.reduce<number | null>((a, f) => (f.modified_at != null && (a == null || f.modified_at < a) ? f.modified_at : a), null);
    const row = { id: ulid(), run_id: last.id, blob_keys: JSON.stringify(still.map((f) => f.blob_key)), total: still.length, bytes, oldest, skipped, created_by: by.userId, created_at: now, expires_at: now + s.cfg.BLOBS_DRY_RUN_MINUTES * 60_000 };
    await s.db('platform_blob_dryruns').insert(row);
    await audit(s, by, 'platform.blobs.orphans.dry-run', { dryRun: row.id, run: last.id }, { count: still.length, bytes, skipped }, 'admin');
    return { id: row.id, count: still.length, bytes, oldest, skipped, expiresAt: row.expires_at, keys: still.slice(0, 50).map((f) => f.blob_key) };
  }

  /** Deletes exactly the objects of a dry run that is still valid; the reason and the list go into the audit chain. */
  async deleteOrphans(by: OpsActor, dryRunId: string, reason: string): Promise<{ deleted: number; bytes: number; failed: number }> {
    const s = this.s();
    const d = (await s.db('platform_blob_dryruns').where({ id: dryRunId }).first()) as Record<string, unknown> | undefined;
    if (!d) throw notFound('Dry run');
    if (d.used_at != null) throw conflict('That dry run has been used; run another one.');
    if (Number(d.expires_at) < Date.now()) throw new HttpProblem(409, 'Dry run expired', `A dry run is good for ${s.cfg.BLOBS_DRY_RUN_MINUTES} minutes; run it again.`, { extensions: { step: 'dry-run' } });
    // Claimed first, so two admins confirming at once delete once.
    if (!(await s.db('platform_blob_dryruns').where({ id: dryRunId }).whereNull('used_at').update({ used_at: Date.now() }))) throw conflict('That dry run has been used; run another one.');
    const keys = JSON.parse(String(d.blob_keys)) as string[];
    let deleted = 0;
    let bytes = 0;
    let failed = 0;
    const sizes = new Map(((await s.db('platform_blob_findings').where({ run_id: String(d.run_id), kind: 'orphan' }).whereIn('blob_key', keys.slice(0, 10_000)).select('blob_key', 'size')) as { blob_key: string; size: number | string | null }[]).map((r) => [r.blob_key, Number(r.size ?? 0)]));
    const t = Date.now();
    for (const key of keys) {
      try {
        await s.blobs.delete(key);
        deleted++;
        bytes += sizes.get(key) ?? 0;
      } catch {
        failed++;
      }
    }
    for (let i = 0; i < keys.length; i += 500) await s.db('platform_blob_findings').where({ run_id: String(d.run_id), kind: 'orphan', state: 'open' }).whereIn('blob_key', keys.slice(i, i + 500)).update({ state: 'deleted', resolved_by: by.userId, resolved_at: t, note: reason.slice(0, 500) });
    await audit(s, by, 'platform.blobs.orphans.deleted', { dryRun: dryRunId, run: String(d.run_id) }, { reason, deleted, bytes, failed, objects: keys.slice(0, 1000), more: Math.max(0, keys.length - 1000) }, 'admin');
    return { deleted, bytes, failed };
  }

  /** Takes an object's current SHA-256 as the one to compare against from now on (a mismatch that was expected). */
  async acceptChecksum(by: OpsActor, findingId: string, reason: string): Promise<FindingRow> {
    const s = this.s();
    const f = await this.finding(findingId);
    if (f.kind !== 'mismatch' || f.state !== 'open') throw conflict('Only an open checksum mismatch can be accepted.');
    if (MIRROR_FILE.test(f.blob_key)) throw conflict('A mirror file is named by its SHA-256; restore it from the bundle or a backup instead.');
    const now = await this.sha(f.blob_key);
    if (!now) throw conflict('The object is gone.');
    const t = Date.now();
    const n = await s.db('platform_blob_checksums').where({ blob_key: f.blob_key }).update({ sha256: now.sha256, size: now.size, verified_at: t });
    if (!n) await s.db('platform_blob_checksums').insert({ blob_key: f.blob_key, sha256: now.sha256, size: now.size, first_seen: t, verified_at: t });
    await s.db('platform_blob_findings').where({ id: f.id }).update({ state: 'accepted', resolved_by: by.userId, resolved_at: t, note: reason.slice(0, 500) });
    await audit(s, by, 'platform.blobs.checksum.accepted', { finding: f.id, object: f.blob_key }, { expected: f.expected, actual: now.sha256, reason }, 'admin');
    return this.finding(f.id);
  }
}

/** One sample a day per scope (the last one of the day wins). */
export async function sample(s: Services, scope: string, bytes: number, objects: number | null): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const row = { scope, day, bytes, objects, updated_at: Date.now() };
  const n = await s.db('platform_storage_samples').where({ scope, day }).update({ bytes, objects, updated_at: row.updated_at });
  if (!n) await s.db('platform_storage_samples').insert(row).catch(() => undefined);
}
