import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import { canonicalJson } from '../crypto/index.js';
import { createDb, json, migrate, type Db } from '../db/knex.js';
import { AuditLog } from '../audit/chain.js';
import { AuditCheckpoints } from '../audit/checkpoints.js';
import { conflict, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import type { BlobStore } from '../platform/blob.js';
import type { Kms } from '../platform/kms.js';
import { blobTar, deferForeignKeys, lines, openFromBlob, pgForeignKeys, restoreBlobTar, restoreRows, rowCounts, sealToBlob, setPgDeferrable, tableRows } from './restore.js';
import { audit, getState, notifyAdmins, setState, type OpsActor } from './common.js';

export interface BackupRow {
  id: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed';
  kind: 'manual' | 'scheduled' | 'cli';
  db_client: string;
  tables: number | null;
  rows: number | null;
  bytes: number | null;
  manifest_hash: string | null;
  signature: string | null;
  blob_key: string | null;
  manifest_key: string | null;
  error: string | null;
  job_id: string | null;
  created_by: string | null;
  created_at: number;
  finished_at: number | null;
}

export interface DrillStep {
  title: string;
  state: 'waiting' | 'running' | 'passed' | 'failed';
  ms: number | null;
  detail: string | null;
}

export interface DrillRow {
  id: string;
  backup_id: string;
  state: 'queued' | 'running' | 'passed' | 'failed';
  steps: DrillStep[];
  rpo_ms: number | null;
  rto_ms: number | null;
  rpo_target_ms: number;
  rto_target_ms: number;
  within_target: boolean | null;
  detail: Record<string, unknown> | null;
  error: string | null;
  job_id: string | null;
  created_by: string | null;
  created_at: number;
  finished_at: number | null;
}

export interface BackupManifest {
  format: 'exprsn-backup/1';
  id: string;
  createdAt: number;
  dbClient: string;
  migrations: string[];
  tables: { name: string; rows: number }[];
  totalRows: number;
  archive: { blob: string; sha256: string; bytes: number; cipher: 'aes-256-gcm'; iv: string; tag: string; kek: string; wrappedKey: string };
  /** Sprint 15: the blob store as a tar, sealed with its own key (absent in older backups or with PLATFORM_BACKUP_BLOBS=false). */
  blobs?: { blob: string; sha256: string; bytes: number; plainBytes: number; objects: number; /** B-903: `snapshot` when only objects the dump references are archived. */ selection?: 'snapshot'; cipher: 'aes-256-gcm'; iv: string; tag: string; kek: string; wrappedKey: string } | null;
}

/** Blob keys a backup of the blob store leaves out: the backups themselves. */
export const BLOB_BACKUP_EXCLUDE = ['platform/backups/'];

/*
 * B-903: the blob archive holds exactly the objects the database snapshot references. While the dump reads every
 * row inside its snapshot, every string value (and every string inside a JSON value) that could be a blob key is
 * collected; after the dump the store is listed and only objects named by the snapshot are archived. An object
 * written after the snapshot opened (whose row the snapshot cannot see) is left out, and every object a row of the
 * snapshot names was written before that row committed, so it is in the store when the listing runs.
 */

/** Objects no row names: content-addressed mirror files and pipeline staging input. They are archived as listed. */
export const BLOB_UNOWNED_PREFIXES = ['mirrors/', 'training/staging/'];

/** Rows that own a whole directory of objects without naming each one (derived keys). */
export const BLOB_OWNED_DIRS: Record<string, (r: Record<string, unknown>) => string | null> = {
  exports: (r) => (r.tenant_id && r.id ? `exports/${String(r.tenant_id)}/${String(r.id)}/` : null),
  platform_bundles: (r) => (r.id ? `platform/bundles/${String(r.id)}/` : null)
};

const KEY_LIKE = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,511}$/;

/** The blob keys and owned directories a snapshot's rows reference. */
export class BlobRefs {
  readonly keys = new Set<string>();
  readonly dirs = new Set<string>();

  add(table: string, row: Record<string, unknown>): void {
    const dir = BLOB_OWNED_DIRS[table]?.(row);
    if (dir) this.dirs.add(dir);
    for (const v of Object.values(row)) this.visit(v, 0);
  }

  private visit(v: unknown, depth: number): void {
    if (typeof v === 'string') {
      const c = v.charCodeAt(0);
      if ((c === 123 || c === 91) && depth < 6 && v.length < 4 * 1024 * 1024) {
        try {
          this.visit(JSON.parse(v), depth + 1);
          return;
        } catch {
          /* not JSON */
        }
      }
      if (v.length <= 512 && v.includes('/') && KEY_LIKE.test(v)) this.keys.add(v);
    } else if (Array.isArray(v)) {
      if (depth < 6) for (const x of v) this.visit(x, depth + 1);
    } else if (v && typeof v === 'object' && !Buffer.isBuffer(v) && !(v instanceof Date)) {
      if (depth < 6) for (const x of Object.values(v)) this.visit(x, depth + 1);
    }
  }

  includes(key: string): boolean {
    if (this.keys.has(key) || BLOB_UNOWNED_PREFIXES.some((p) => key.startsWith(p))) return true;
    for (let i = key.lastIndexOf('/'); i > 0; i = key.lastIndexOf('/', i - 1)) if (this.dirs.has(key.slice(0, i + 1))) return true;
    return false;
  }
}

export const manifestKeyFor = (id: string) => `platform/backups/${id}.manifest.json`;

export const DRILL_STEPS = [
  'Manifest signature verified',
  'Archive decrypted and digest matched',
  'Schema created in a scratch SQLite database',
  'Rows restored',
  'Row counts match the manifest',
  'Audit chains and checkpoints verified'
] as const;

const SKIP_TABLES = new Set(['knex_migrations', 'knex_migrations_lock']);
const ALERT_KEY = 'backup.alert';

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const backupFromRow = (r: Record<string, unknown>): BackupRow => ({ ...(r as unknown as BackupRow), tables: num(r.tables), rows: num(r.rows), bytes: num(r.bytes), created_at: Number(r.created_at), finished_at: num(r.finished_at) });
const drillFromRow = (r: Record<string, unknown>): DrillRow => ({
  ...(r as unknown as DrillRow),
  steps: json<DrillStep[]>(r.steps, []),
  detail: json<Record<string, unknown> | null>(r.detail, null),
  rpo_ms: num(r.rpo_ms),
  rto_ms: num(r.rto_ms),
  rpo_target_ms: Number(r.rpo_target_ms),
  rto_target_ms: Number(r.rto_target_ms),
  within_target: r.within_target == null ? null : Boolean(r.within_target),
  created_at: Number(r.created_at),
  finished_at: num(r.finished_at)
});

/** Every base table of the application database, whatever the dialect. */
export async function listTables(db: Db, client: string): Promise<string[]> {
  let names: string[];
  if (client === 'sqlite') names = (await db.raw("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")).map((r: { name: string }) => r.name);
  else if (client === 'pg') names = (await db.raw("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'")).rows.map((r: { name: string }) => r.name);
  else names = ((await db.raw("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = database() AND table_type = 'BASE TABLE'")) as [{ name: string }[]])[0].map((r) => r.name);
  return names.filter((n) => !SKIP_TABLES.has(n)).sort();
}

/** Values in the dump: binary as base64, dates as ISO strings, everything else as the driver returned it. */
const encodeRow = (r: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) out[k] = Buffer.isBuffer(v) ? { $b64: v.toString('base64') } : v instanceof Date ? v.toISOString() : v;
  return out;
};

const fmtMs = (ms: number): string => (ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s` : `${Math.floor(ms / 3_600_000)} h ${Math.round((ms % 3_600_000) / 60_000)} min`);

/**
 * Backups of the application database and restore drills. A backup is a logical dump of every table (read in one
 * repeatable-read transaction on PostgreSQL and MySQL), gzipped and encrypted with a fresh AES-256-GCM key that the
 * KMS wraps; its manifest (tables, row counts, archive digest, wrapped key) is HMAC-signed by the KMS. Opening a
 * backup needs only the KMS, not the database it came from. A drill restores a backup into a scratch SQLite file
 * and verifies the signature, digest, row counts and every tenant's audit chain; the live database is never written.
 */
export class BackupService {
  constructor(private readonly s: () => Services) {}

  /** A test seam (B-903): runs once the dump's snapshot is fixed, before any table is read. */
  onSnapshot: ((backupId: string) => Promise<void>) | null = null;

  /**
   * The dump's snapshot. PostgreSQL and MySQL: a repeatable-read transaction on the pool. A SQLite file: a read
   * transaction on a second connection (WAL keeps writers going and the reader on its snapshot). In-memory SQLite has
   * one connection only, so the transaction holds it and other queries wait until the dump ends.
   */
  private async openSnapshot(): Promise<{ db: Db; sharesConnection: boolean; done: (ok: boolean) => Promise<void> }> {
    const s = this.s();
    if (s.cfg.DB_CLIENT !== 'sqlite') {
      const trx = await s.db.transaction({ isolationLevel: 'repeatable read' });
      return { db: trx as unknown as Db, sharesConnection: false, done: async (ok) => void (await (ok ? trx.commit() : trx.rollback()).catch(() => undefined)) };
    }
    if (s.cfg.SQLITE_FILENAME === ':memory:') {
      const trx = await s.db.transaction();
      return { db: trx as unknown as Db, sharesConnection: true, done: async (ok) => void (await (ok ? trx.commit() : trx.rollback()).catch(() => undefined)) };
    }
    const reader = createDb({ ...s.cfg, DB_POOL_MAX: 1 });
    const trx = await reader.transaction();
    return {
      db: trx as unknown as Db,
      sharesConnection: false,
      done: async () => {
        await trx.rollback().catch(() => undefined);
        await reader.destroy();
      }
    };
  }

  private get kek(): string {
    return `${this.s().cfg.OPENBAO_KEY_PREFIX}platform-backups`;
  }

  async list(limit = 50): Promise<BackupRow[]> {
    return (await this.s().db('platform_backups').orderBy('created_at', 'desc').limit(limit)).map(backupFromRow);
  }

  async get(id: string): Promise<BackupRow> {
    const r = await this.s().db('platform_backups').where({ id }).first();
    if (!r) throw notFound('Backup');
    return backupFromRow(r);
  }

  async drills(limit = 20): Promise<DrillRow[]> {
    return (await this.s().db('platform_drills').orderBy('created_at', 'desc').limit(limit)).map(drillFromRow);
  }

  async drill(id: string): Promise<DrillRow> {
    const r = await this.s().db('platform_drills').where({ id }).first();
    if (!r) throw notFound('Restore drill');
    return drillFromRow(r);
  }

  async lastSucceeded(): Promise<BackupRow | null> {
    const r = await this.s().db('platform_backups').where({ state: 'succeeded' }).orderBy('created_at', 'desc').first();
    return r ? backupFromRow(r) : null;
  }

  private async insertBackup(by: OpsActor, kind: BackupRow['kind']): Promise<BackupRow> {
    const row = { id: ulid(), state: 'queued', kind, db_client: this.s().cfg.DB_CLIENT, created_by: by.userId, created_at: Date.now() };
    await this.s().db('platform_backups').insert(row);
    return this.get(row.id);
  }

  /** Queues a backup job. */
  async request(by: OpsActor, kind: 'manual' | 'scheduled'): Promise<BackupRow> {
    const running = await this.s().db('platform_backups').whereIn('state', ['queued', 'running']).andWhere('created_at', '>', Date.now() - 6 * 3_600_000).first();
    if (running) throw conflict('A backup is already running.');
    const b = await this.insertBackup(by, kind);
    const job = await this.s().jobs.enqueue({ tenantId: by.tenantId, type: 'ops.backup.create', payload: { backupId: b.id }, createdBy: by.userId, maxAttempts: 1 });
    await this.s().db('platform_backups').where({ id: b.id }).update({ job_id: job.id });
    if (kind === 'manual') await audit(this.s(), by, 'platform.backup.requested', { backup: b.id }, { job: job.id }, 'admin');
    return this.get(b.id);
  }

  /** Runs a backup now, without the queue (the CLI). */
  async createNow(by: OpsActor, progress: (pct: number, msg: string) => Promise<void> = async () => undefined): Promise<BackupRow> {
    const b = await this.insertBackup(by, 'cli');
    await this.run(b.id, by, progress);
    return this.get(b.id);
  }

  /** The backup job. */
  async run(backupId: string, by: OpsActor, progress: (pct: number, msg: string) => Promise<void>): Promise<BackupManifest> {
    const s = this.s();
    await s.db('platform_backups').where({ id: backupId }).update({ state: 'running' });
    try {
      const client = s.cfg.DB_CLIENT;
      const counts: { name: string; rows: number }[] = [];
      const refs = new BlobRefs();
      // B-903: one snapshot for the whole dump (repeatable read on PostgreSQL and MySQL, one read transaction on SQLite).
      const snap = await this.openSnapshot();
      let migrations: string[];
      let sealedDb: Awaited<ReturnType<typeof sealToBlob>>;
      const dek = randomBytes(32);
      const iv = randomBytes(12);
      const blob = `platform/backups/${backupId}.bin`;
      try {
        // The first read fixes the snapshot.
        migrations = (await snap.db('knex_migrations').select('name').orderBy('id')).map((r: { name: string }) => r.name);
        await this.onSnapshot?.(backupId);
        // The dump is produced a page at a time and flows through gzip and AES-256-GCM into the blob store.
        const dump = async function* (db: Db): AsyncGenerator<Buffer> {
          const tables = await listTables(db, client);
          yield Buffer.from(JSON.stringify({ format: 'exprsn-backup/1', id: backupId }) + '\n');
          for (const [i, t] of tables.entries()) {
            let n = 0;
            let buf: string[] = [];
            for await (const r of tableRows(db, client, t)) {
              refs.add(t, r);
              buf.push(JSON.stringify([t, encodeRow(r)]));
              n++;
              if (buf.length >= 500) {
                yield Buffer.from(buf.join('\n') + '\n');
                buf = [];
              }
            }
            if (buf.length) yield Buffer.from(buf.join('\n') + '\n');
            counts.push({ name: t, rows: n });
            // With an in-memory SQLite database the snapshot holds the only connection, so progress waits until the end.
            if (!snap.sharesConnection) await progress(Math.round(((i + 1) * 60) / tables.length), `Dumped ${t}`);
          }
        };
        sealedDb = await sealToBlob({ blobs: s.blobs, key: blob, plain: dump(snap.db), gzip: true, dek, iv, aad: `exprsn-backup:${backupId}` });
        await snap.done(true);
      } catch (err) {
        await snap.done(false);
        throw err;
      }
      if (snap.sharesConnection) await progress(60, `Dumped ${counts.length} tables`);
      await s.kms.ensureKey(this.kek);
      let blobsPart: BackupManifest['blobs'] = null;
      if (s.cfg.PLATFORM_BACKUP_BLOBS) {
        await progress(65, 'Archiving the blob store');
        const bdek = randomBytes(32);
        const biv = randomBytes(12);
        const counter = { objects: 0, bytes: 0 };
        const key = `platform/backups/${backupId}.blobs.bin`;
        const r = await sealToBlob({ blobs: s.blobs, key, plain: blobTar(s.blobs, BLOB_BACKUP_EXCLUDE, counter, (k) => refs.includes(k)), gzip: false, dek: bdek, iv: biv, aad: `exprsn-backup-blobs:${backupId}` });
        blobsPart = { blob: key, sha256: r.sha256, bytes: r.bytes, plainBytes: r.plainBytes, objects: counter.objects, selection: 'snapshot', cipher: 'aes-256-gcm', iv: biv.toString('base64'), tag: r.tag, kek: this.kek, wrappedKey: await s.kms.wrap(this.kek, bdek, `backup-blobs:${backupId}`) };
      }
      await progress(85, 'Signing the manifest');
      const manifest: BackupManifest = {
        format: 'exprsn-backup/1',
        id: backupId,
        createdAt: (await this.get(backupId)).created_at,
        dbClient: client,
        migrations,
        tables: counts,
        totalRows: counts.reduce((a, c) => a + c.rows, 0),
        archive: { blob, sha256: sealedDb.sha256, bytes: sealedDb.bytes, cipher: 'aes-256-gcm', iv: iv.toString('base64'), tag: sealedDb.tag, kek: this.kek, wrappedKey: await s.kms.wrap(this.kek, dek, `backup:${backupId}`) },
        ...(blobsPart ? { blobs: blobsPart } : {})
      };
      const signature = await s.kms.hmac(this.kek, canonicalJson(manifest));
      const manifestKey = manifestKeyFor(backupId);
      await s.blobs.put(manifestKey, Buffer.from(JSON.stringify({ manifest, signature }, null, 2)), 'application/json');
      const sealed = { length: sealedDb.bytes + (blobsPart?.bytes ?? 0) };
      const manifestHash = createHash('sha256').update(canonicalJson(manifest)).digest('hex');
      await s.db('platform_backups').where({ id: backupId }).update({ state: 'succeeded', tables: counts.length, rows: manifest.totalRows, bytes: sealed.length, manifest_hash: manifestHash, signature: signature.slice(0, 200), blob_key: blob, manifest_key: manifestKey, finished_at: Date.now(), error: null });
      await audit(s, by, 'platform.backup.created', { backup: backupId }, { tables: counts.length, rows: manifest.totalRows, bytes: sealed.length, manifestHash, kek: this.kek, store: s.blobs.kind, blobObjects: blobsPart?.objects ?? null });
      await progress(95, 'Applying retention');
      await this.prune(by);
      await this.watch(by);
      return manifest;
    } catch (err) {
      const reason = (err as Error).message.slice(0, 1000);
      await s.db('platform_backups').where({ id: backupId }).update({ state: 'failed', error: reason, finished_at: Date.now() });
      await audit(s, by, 'platform.backup.failed', { backup: backupId }, { reason });
      await notifyAdmins(s, { kind: 'platform.backup.failed', title: 'A database backup failed', body: reason.slice(0, 300), email: true });
      throw err;
    }
  }

  /** Keeps the newest PLATFORM_BACKUP_RETAIN successful backups. */
  async prune(by: OpsActor): Promise<number> {
    const s = this.s();
    const old = (await s.db('platform_backups').where({ state: 'succeeded' }).orderBy('created_at', 'desc').offset(s.cfg.PLATFORM_BACKUP_RETAIN).limit(1000)).map(backupFromRow);
    for (const b of old) {
      if (b.blob_key) await s.blobs.delete(b.blob_key);
      if (b.manifest_key) await s.blobs.delete(b.manifest_key);
      await s.blobs.delete(`platform/backups/${b.id}.blobs.bin`);
      await s.db('platform_backups').where({ id: b.id }).delete();
    }
    if (old.length) await audit(s, by, 'platform.backup.pruned', {}, { removed: old.map((b) => b.id), retain: s.cfg.PLATFORM_BACKUP_RETAIN });
    return old.length;
  }

  /** Reads a backup's manifest and checks its KMS signature. */
  private async manifest(b: BackupRow): Promise<{ manifest: BackupManifest; ok: boolean }> {
    const raw = b.manifest_key ? await this.s().blobs.get(b.manifest_key) : null;
    if (!raw) throw new Error('The backup manifest is missing from the blob store.');
    const { manifest, signature } = JSON.parse(raw.toString('utf8')) as { manifest: BackupManifest; signature: string };
    const ok = await this.s().kms.verifyHmac(manifest.archive.kek, canonicalJson(manifest), signature).catch(() => false);
    return { manifest, ok };
  }

  async requestDrill(by: OpsActor, backupId: string | null, kind: 'manual' | 'scheduled' = 'manual'): Promise<DrillRow> {
    const s = this.s();
    const b = backupId ? await this.get(backupId) : await this.lastSucceeded();
    if (!b) throw conflict('There is no successful backup to restore yet. Run a backup first.');
    if (b.state !== 'succeeded') throw conflict(`That backup is ${b.state}.`);
    const running = await s.db('platform_drills').whereIn('state', ['queued', 'running']).andWhere('created_at', '>', Date.now() - 6 * 3_600_000).first();
    if (running) throw conflict('A restore drill is already running.');
    const d = this.newDrill(by, b.id);
    await s.db('platform_drills').insert(d);
    const job = await s.jobs.enqueue({ tenantId: by.tenantId, type: 'ops.backup.drill', payload: { drillId: d.id }, createdBy: by.userId, maxAttempts: 1 });
    await s.db('platform_drills').where({ id: d.id }).update({ job_id: job.id });
    await audit(s, by, 'platform.drill.requested', { drill: d.id, backup: b.id }, { job: job.id, kind }, kind === 'manual' ? 'admin' : 'system');
    return this.drill(d.id);
  }

  private newDrill(by: OpsActor, backupId: string) {
    const cfg = this.s().cfg;
    return { id: ulid(), backup_id: backupId, state: 'queued', steps: JSON.stringify(DRILL_STEPS.map((title) => ({ title, state: 'waiting', ms: null, detail: null }))), rpo_target_ms: cfg.PLATFORM_BACKUP_RPO_MINUTES * 60_000, rto_target_ms: cfg.PLATFORM_BACKUP_RTO_MINUTES * 60_000, created_by: by.userId, created_at: Date.now() };
  }

  /** Runs a drill now, without the queue (the CLI). */
  async drillNow(by: OpsActor, backupId: string | null, progress: (pct: number, msg: string) => Promise<void> = async () => undefined): Promise<DrillRow> {
    const b = backupId ? await this.get(backupId) : await this.lastSucceeded();
    if (!b || b.state !== 'succeeded') throw new Error('There is no successful backup to restore.');
    const d = this.newDrill(by, b.id);
    await this.s().db('platform_drills').insert(d);
    await this.runDrill(d.id, by, progress);
    return this.drill(d.id);
  }

  /** The drill job. Everything is restored into a scratch SQLite file that is deleted afterwards. */
  async runDrill(drillId: string, by: OpsActor, progress: (pct: number, msg: string) => Promise<void>): Promise<DrillRow> {
    const s = this.s();
    const d = await this.drill(drillId);
    const b = await this.get(d.backup_id);
    const started = Date.now();
    const steps: DrillStep[] = DRILL_STEPS.map((title) => ({ title, state: 'waiting', ms: null, detail: null }));
    const detail: Record<string, unknown> = {};
    let current = 0;
    let t0 = Date.now();
    const save = (extra: Record<string, unknown> = {}) => s.db('platform_drills').where({ id: drillId }).update({ steps: JSON.stringify(steps), detail: JSON.stringify(detail), ...extra });
    const begin = async (i: number) => {
      current = i;
      t0 = Date.now();
      steps[i] = { ...steps[i]!, state: 'running' };
      await save();
      await progress(Math.round((i * 100) / DRILL_STEPS.length), DRILL_STEPS[i]!);
    };
    const pass = (i: number, text: string) => {
      steps[i] = { ...steps[i]!, state: 'passed', ms: Date.now() - t0, detail: text };
    };
    await save({ state: 'running' });
    const dir = await mkdtemp(path.join(s.cfg.PLATFORM_DRILL_DIR ?? tmpdir(), 'exprsn-drill-'));
    let scratch: Db | null = null;
    try {
      await begin(0);
      const { manifest, ok } = await this.manifest(b);
      if (!ok) throw new Error('The manifest signature does not verify with the KMS key.');
      if (manifest.id !== b.id) throw new Error('The manifest belongs to a different backup.');
      pass(0, `HMAC by ${manifest.archive.kek}`);

      await begin(1);
      // A streamed pass that only authenticates: nothing read from the archive is used before its tag and digest check.
      const archiveIn = await this.openArchive(s.kms, s.blobs, manifest, false);
      for await (const _ of archiveIn.stream) void _;
      await archiveIn.done();
      let blobNote = '';
      if (manifest.blobs) {
        const blobsIn = await this.openBlobArchive(s.kms, s.blobs, manifest);
        for await (const _ of blobsIn.stream) void _;
        await blobsIn.done();
        blobNote = `; blob store ${manifest.blobs.objects} objects, ${(manifest.blobs.bytes / 1e6).toFixed(1)} MB`;
        detail.blobs = { objects: manifest.blobs.objects, bytes: manifest.blobs.bytes, verified: true };
      }
      pass(1, `${(archiveIn.sealedBytes / 1e6).toFixed(1)} MB, sha256 ${manifest.archive.sha256.slice(0, 12)}…${blobNote}`);

      await begin(2);
      scratch = createDb({ DB_CLIENT: 'sqlite', SQLITE_FILENAME: path.join(dir, 'drill.sqlite'), DB_POOL_MAX: 1, DATABASE_URL: undefined });
      await migrate(scratch);
      await scratch.raw('PRAGMA foreign_keys = OFF');
      const schema = new Set(await listTables(scratch, 'sqlite'));
      const known = new Set((await scratch('knex_migrations').select('name')).map((r: { name: string }) => r.name));
      const unknown = manifest.migrations.filter((m) => !known.has(m));
      if (unknown.length) throw new Error(`The backup comes from a newer schema (${unknown.join(', ')}); run the drill with that release.`);
      detail.migrations = { backup: manifest.migrations.length, current: known.size };
      pass(2, `${schema.size} tables; the backup is at ${manifest.migrations.length} of ${known.size} migrations`);

      await begin(3);
      for (const { name } of manifest.tables) if (schema.has(name)) await scratch(name).delete();
      const second = await this.openArchive(s.kms, s.blobs, manifest, true);
      const restoredRows = await restoreRows(scratch, 'sqlite', lines(second.stream), schema, { id: b.id });
      await second.done();
      const skipped = manifest.tables.map((t) => t.name).filter((n) => !schema.has(n));
      const restored = [...restoredRows.counts.entries()].filter(([t]) => schema.has(t)).reduce((a, [, n]) => a + n, 0);
      detail.skipped = skipped;
      pass(3, `${restored} rows into ${manifest.tables.length - skipped.length} tables${skipped.length ? `; not in the portable schema: ${skipped.join(', ')}` : ''}`);

      await begin(4);
      const mismatches: { table: string; expected: number; restored: number }[] = [];
      for (const { name, rows } of manifest.tables) {
        if (skipped.includes(name)) continue;
        const [r] = await scratch(name).count({ n: '*' });
        const n = Number(r?.n ?? 0);
        if (n !== rows) mismatches.push({ table: name, expected: rows, restored: n });
      }
      detail.counts = { tables: manifest.tables.length - skipped.length, rows: restored, mismatches };
      if (mismatches.length) throw new Error(`Row counts differ in ${mismatches.length} ${mismatches.length === 1 ? 'table' : 'tables'}: ${mismatches.slice(0, 5).map((m) => `${m.table} ${m.restored} of ${m.expected}`).join(', ')}`);
      pass(4, `${manifest.tables.length - skipped.length} tables, ${restored} rows`);

      await begin(5);
      const tenants = (await scratch('audit_events').distinct('tenant_id')).map((r: { tenant_id: string }) => r.tenant_id);
      const log = new AuditLog(scratch);
      const cps = new AuditCheckpoints(scratch, log, s.kms, s.blobs, `${s.cfg.OPENBAO_KEY_PREFIX}audit-checkpoints`);
      const chains: { tenant: string; status: string; checked: number; checkpoints: number; brokenAt?: unknown }[] = [];
      for (const t of tenants) {
        const r = await cps.verify(t);
        chains.push({ tenant: t, status: r.status, checked: r.checked, checkpoints: r.checkpoints.checked, ...(r.brokenAt ? { brokenAt: r.brokenAt } : {}) });
      }
      detail.chains = chains;
      const broken = chains.filter((c) => c.status !== 'verified');
      if (broken.length) throw new Error(`The audit chain of ${broken.length} ${broken.length === 1 ? 'tenant is' : 'tenants are'} broken in the backup.`);
      pass(5, `${chains.length} ${chains.length === 1 ? 'chain' : 'chains'}, ${chains.reduce((a, c) => a + c.checked, 0)} events, ${chains.reduce((a, c) => a + c.checkpoints, 0)} checkpoints`);

      const rto = Date.now() - started;
      const rpo = started - b.created_at;
      const within = rto <= d.rto_target_ms && rpo <= d.rpo_target_ms;
      await save({ state: 'passed', rpo_ms: rpo, rto_ms: rto, within_target: within, finished_at: Date.now(), error: null });
      await audit(s, by, 'platform.drill.passed', { drill: drillId, backup: b.id }, { rpoMs: rpo, rtoMs: rto, withinTarget: within, rows: restored, chains: chains.length, skipped });
      if (!within) await notifyAdmins(s, { kind: 'platform.drill.target', title: 'A restore drill missed its target', body: `Measured RPO ${fmtMs(rpo)} and RTO ${fmtMs(rto)} against ${fmtMs(d.rpo_target_ms)} and ${fmtMs(d.rto_target_ms)}.` });
      return this.drill(drillId);
    } catch (err) {
      const reason = (err as Error).message.slice(0, 1000);
      steps[current] = { ...steps[current]!, state: 'failed', ms: Date.now() - t0, detail: reason };
      await save({ state: 'failed', rto_ms: Date.now() - started, rpo_ms: started - b.created_at, within_target: false, error: reason, finished_at: Date.now() });
      await audit(s, by, 'platform.drill.failed', { drill: drillId, backup: b.id }, { step: current + 1, title: DRILL_STEPS[current], reason });
      await notifyAdmins(s, { kind: 'platform.drill.failed', title: 'A restore drill failed', body: `${DRILL_STEPS[current]}: ${reason.slice(0, 300)}`, email: true });
      return this.drill(drillId);
    } finally {
      await scratch?.destroy().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** The database archive of a backup, decrypted (and gunzipped when `gunzip`) as a stream. */
  private async openArchive(kms: Kms, blobs: BlobStore, m: BackupManifest, gunzip: boolean) {
    const dek = await kms.unwrap(m.archive.kek, m.archive.wrappedKey, `backup:${m.id}`);
    return openFromBlob({ blobs, key: m.archive.blob, dek, iv: m.archive.iv, tag: m.archive.tag, aad: `exprsn-backup:${m.id}`, sha256: m.archive.sha256, gunzip });
  }

  /** The blob-store archive of a backup, decrypted as a tar stream. */
  private async openBlobArchive(kms: Kms, blobs: BlobStore, m: BackupManifest) {
    const b = m.blobs!;
    const dek = await kms.unwrap(b.kek, b.wrappedKey, `backup-blobs:${m.id}`);
    return openFromBlob({ blobs, key: b.blob, dek, iv: b.iv, tag: b.tag, aad: `exprsn-backup-blobs:${m.id}`, sha256: b.sha256, gunzip: false });
  }

  /**
   * Restores a backup into `target` (B-410): the application database this server is configured with, used by the
   * `backup:restore` CLI. The manifest is read from `from` (the blob store holding the backup, which may be a copy
   * kept elsewhere) and checked against the KMS; both archives are authenticated in a first streamed pass before
   * anything is written. The rows go in in one transaction, with foreign keys checked at commit; then the blob store
   * objects are written into `blobsTo`. A database that already has tenants, users or audit events is refused unless
   * `force`, which empties it first.
   */
  async restoreInto(o: { target: Db; client: string; kms: Kms; from: BlobStore; blobsTo: BlobStore | null; backupId: string; force: boolean; progress?: (msg: string) => void }): Promise<{ rows: number; tables: number; skipped: string[]; blobs: { objects: number; bytes: number } | null; wiped: boolean }> {
    const say = o.progress ?? (() => undefined);
    const raw = await o.from.get(manifestKeyFor(o.backupId));
    if (!raw) throw new Error(`No manifest for backup ${o.backupId} in the blob store (${manifestKeyFor(o.backupId)}).`);
    const { manifest, signature } = JSON.parse(raw.toString('utf8')) as { manifest: BackupManifest; signature: string };
    if (manifest.id !== o.backupId) throw new Error('The manifest belongs to a different backup.');
    if (!(await o.kms.verifyHmac(manifest.archive.kek, canonicalJson(manifest), signature).catch(() => false))) throw new Error('The manifest signature does not verify with the KMS key.');
    say('Manifest signature verified');

    const schema = new Set(await listTables(o.target, o.client));
    const known = new Set((await o.target('knex_migrations').select('name')).map((r: { name: string }) => r.name));
    const unknown = manifest.migrations.filter((m) => !known.has(m));
    if (unknown.length) throw new Error(`The backup comes from a newer schema (${unknown.join(', ')}); restore it with that release.`);

    const occupied = (await rowCounts(o.target, ['tenants', 'users', 'audit_events'].filter((t) => schema.has(t)))).filter((c) => c.rows > 0);
    if (occupied.length && !o.force) throw new Error(`The database is not empty (${occupied.map((c) => `${c.rows} ${c.table}`).join(', ')}). Restore into an empty database, or pass --force with the confirmation phrase to replace everything in it.`);

    const archiveIn = await this.openArchive(o.kms, o.from, manifest, false);
    for await (const _ of archiveIn.stream) void _;
    await archiveIn.done();
    if (manifest.blobs && o.blobsTo) {
      const blobsIn = await this.openBlobArchive(o.kms, o.from, manifest);
      for await (const _ of blobsIn.stream) void _;
      await blobsIn.done();
    }
    say('Archives authenticated');

    const fks = o.client === 'pg' ? await pgForeignKeys(o.target) : [];
    if (fks.length) await setPgDeferrable(o.target, fks, true);
    let result: Awaited<ReturnType<typeof restoreRows>>;
    try {
      result = await o.target.transaction(async (trx) => {
        await deferForeignKeys(trx as unknown as Db, o.client);
        // Everything in the schema is replaced, including rows the migrations or a first start seeded.
        for (const t of schema) await trx(t).delete();
        const second = await this.openArchive(o.kms, o.from, manifest, true);
        const r = await restoreRows(trx as unknown as Db, o.client, lines(second.stream), schema, { id: manifest.id }, async (t, n) => say(`Restored ${t}: ${n} rows`));
        await second.done();
        for (const { name, rows } of manifest.tables) {
          if (!schema.has(name)) continue;
          const got = r.counts.get(name) ?? 0;
          if (got !== rows) throw new Error(`${name}: restored ${got} rows, the manifest says ${rows}.`);
        }
        // The dump was taken while this backup's own row said "running": record it as the backup it turned out to be.
        const own = { state: 'succeeded', tables: manifest.tables.length, rows: manifest.totalRows, bytes: manifest.archive.bytes + (manifest.blobs?.bytes ?? 0), manifest_hash: createHash('sha256').update(canonicalJson(manifest)).digest('hex'), signature: signature.slice(0, 200), blob_key: manifest.archive.blob, manifest_key: manifestKeyFor(manifest.id), error: null, finished_at: Date.now() };
        if (!(await trx('platform_backups').where({ id: manifest.id }).update(own))) await trx('platform_backups').insert({ id: manifest.id, kind: 'cli', db_client: manifest.dbClient, created_by: null, created_at: manifest.createdAt, job_id: null, ...own });
        if (o.client === 'mysql') await trx.raw('SET FOREIGN_KEY_CHECKS = 1');
        return r;
      });
    } finally {
      if (fks.length) await setPgDeferrable(o.target, fks, false).catch(() => undefined);
    }
    say('Rows committed');

    let blobs: { objects: number; bytes: number } | null = null;
    if (manifest.blobs && o.blobsTo) {
      const blobsIn = await this.openBlobArchive(o.kms, o.from, manifest);
      blobs = await restoreBlobTar(o.blobsTo, blobsIn.stream);
      await blobsIn.done();
      say(`Blob store: ${blobs.objects} objects restored`);
    }
    const rows = [...result.counts.entries()].filter(([t]) => schema.has(t)).reduce((a, [, n]) => a + n, 0);
    return { rows, tables: manifest.tables.length - result.skipped.length, skipped: result.skipped, blobs, wiped: occupied.length > 0 };
  }

  /** The platform alert for a missed RPO: raised once, cleared when a backup lands, acknowledged by an admin. */
  async alert(): Promise<{ raisedAt: number; lastBackupAt: number | null; acknowledgedAt: number | null; acknowledgedBy: string | null } | null> {
    return getState(this.s(), ALERT_KEY, null);
  }

  async watch(by: OpsActor): Promise<{ missed: boolean }> {
    const s = this.s();
    const last = await this.lastSucceeded();
    const rpo = s.cfg.PLATFORM_BACKUP_RPO_MINUTES * 60_000;
    const missed = !last || Date.now() - last.created_at > rpo;
    const current = await this.alert();
    if (missed && !current) {
      await setState(s, ALERT_KEY, { raisedAt: Date.now(), lastBackupAt: last?.created_at ?? null, acknowledgedAt: null, acknowledgedBy: null });
      await audit(s, by, 'platform.backup.rpo_missed', {}, { lastBackupAt: last?.created_at ?? null, rpoMinutes: s.cfg.PLATFORM_BACKUP_RPO_MINUTES });
      await notifyAdmins(s, { kind: 'platform.backup.rpo', title: 'Backup target missed', body: last ? `The last database backup is older than the RPO of ${fmtMs(rpo)}.` : 'There is no database backup yet.', email: true });
    } else if (!missed && current) {
      await s.db('platform_state').where({ key: ALERT_KEY }).delete();
      await audit(s, by, 'platform.backup.rpo_recovered', {}, { lastBackupAt: last?.created_at ?? null });
    }
    return { missed };
  }

  async acknowledge(by: OpsActor): Promise<void> {
    const a = await this.alert();
    if (!a) throw conflict('There is no backup alert to acknowledge.');
    await setState(this.s(), ALERT_KEY, { ...a, acknowledgedAt: Date.now(), acknowledgedBy: by.userId });
    await audit(this.s(), by, 'platform.backup.alert.acknowledged', {}, { raisedAt: a.raisedAt }, 'admin');
  }
}

export { fmtMs };
