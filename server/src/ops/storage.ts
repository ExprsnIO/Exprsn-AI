import { createHash } from 'node:crypto';
import { readdir, stat, statfs } from 'node:fs/promises';
import { connect } from 'node:net';
import path from 'node:path';
import { ulid } from 'ulid';
import { conflict, HttpProblem, notFound } from '../http/problem.js';
import { FsBlobStore, S3BlobStore, type BlobStore } from '../platform/blob.js';
import { SwitchableBlobStore, type BlobMode } from '../platform/blob-switch.js';
import { PLATFORM_SCOPE } from '../platform/datakeys.js';
import { checkServiceUrl, servicePolicy } from '../platform/egress.js';
import type { JobContext, Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import { BlobIntegrity, sample, VERIFY_JOB } from './blob-integrity.js';
import { audit, getState, notifyAdmins, platformTenant, setState, systemActor, type OpsActor } from './common.js';

/*
 * B-4204: the Storage screen's server side: the stores and their health, usage by workspace, user and kind against
 * the file quotas, the quarantine (with rescan and delete), the integrity check (blob-integrity.ts), the purge
 * schedules in one table, and blob store migration as a copy-then-switch job (decision Q16; platform/blob-switch.ts).
 */

export const MIGRATE_JOB = 'ops.blobs.migrate';
export const SAMPLE_JOB = 'ops.storage.sample';
export const BLOBS_TOPIC = 'platform.blobs';
const MODE_KEY = 'blobs.store';
const day = () => new Date().toISOString().slice(0, 10);

export interface MigrationTarget {
  kind: 'fs' | 's3';
  dir?: string;
  endpoint?: string;
  bucket?: string;
  region?: string;
  pathStyle?: boolean;
  accessKeyId?: string;
}

interface MigrationRow {
  id: string;
  state: 'queued' | 'copying' | 'switched' | 'retired' | 'failed' | 'cancelled';
  source: { migration: string | null; label: string };
  target: MigrationTarget;
  target_secret: string | null;
  reason: string;
  objects: number | null;
  copied: number | null;
  bytes: number | null;
  verified: number | null;
  error: string | null;
  job_id: string | null;
  created_by: string | null;
  created_at: number;
  switched_at: number | null;
  retired_by: string | null;
  retired_at: number | null;
}

const n = (v: unknown): number | null => (v == null ? null : Number(v));
const migrationFrom = (r: Record<string, unknown>): MigrationRow => ({
  ...(r as unknown as MigrationRow),
  source: JSON.parse(String(r.source)) as MigrationRow['source'],
  target: JSON.parse(String(r.target)) as MigrationTarget,
  objects: n(r.objects),
  copied: n(r.copied),
  bytes: n(r.bytes),
  verified: n(r.verified),
  created_at: Number(r.created_at),
  switched_at: n(r.switched_at),
  retired_at: n(r.retired_at)
});

const targetLabel = (t: MigrationTarget) => (t.kind === 's3' ? `S3 bucket ${t.bucket ?? ''} at ${t.endpoint ? new URL(t.endpoint).host : ''}` : `filesystem ${t.dir ?? ''}`);
export const migrationView = (m: MigrationRow) => ({
  id: m.id, state: m.state, from: m.source.label, to: targetLabel(m.target), target: { ...m.target }, reason: m.reason, objects: m.objects, copied: m.copied, bytes: m.bytes, verified: m.verified,
  error: m.error, jobId: m.job_id, createdBy: m.created_by, createdAt: m.created_at, switchedAt: m.switched_at, retiredAt: m.retired_at
});

/** Quarantine entries: what is waiting for its scan, and what was refused in the last 24 hours. */
export type QuarantineKind = 'attachment' | 'file' | 'knowledge' | 'media';
const SCAN_JOBS: Record<QuarantineKind, { type: string; payload: (id: string) => Record<string, unknown> }> = {
  attachment: { type: 'attachment.scan', payload: (id) => ({ id }) },
  file: { type: 'file.scan', payload: (id) => ({ versionId: id }) },
  knowledge: { type: 'knowledge.scan', payload: (id) => ({ documentId: id }) },
  media: { type: 'media.ingest', payload: (id) => ({ id }) }
};

/** The refusal, in the board's words. */
export function refusalState(reason: string | null): string {
  const r = (reason ?? '').toLowerCase();
  if (/deleted from quarantine/.test(r)) return 'deleted';
  if (/malware|infected|found/.test(r)) return 'infected';
  if (/larger|too large|above the upload cap|size limit|over the limit|limit of/.test(r)) return 'too large';
  if (/type|declared|recognis|content is/.test(r)) return 'type mismatch';
  if (/classified|ceiling|clearance/.test(r)) return 'above the ceiling';
  return 'refused';
}

/** ClamAV's PING and VERSION over its socket. */
function clamd(host: string, port: number, command: 'PING' | 'VERSION', timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host, port });
    let answer = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('clamd did not answer in time'));
    }, timeoutMs);
    sock.on('connect', () => sock.write(`z${command}\0`));
    sock.on('data', (d) => (answer += d.toString()));
    sock.on('end', () => {
      clearTimeout(timer);
      resolve(answer.replace(/\0/g, '').trim());
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Bytes used under a directory, counted up to `max` files (scratch directories are small). */
async function du(dir: string, max = 20_000): Promise<{ bytes: number; files: number; partial: boolean }> {
  let bytes = 0;
  let files = 0;
  const walk = async (d: string): Promise<boolean> => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const e of entries) {
      if (files >= max) return false;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!(await walk(p))) return false;
      } else if (e.isFile()) {
        files++;
        bytes += (await stat(p).catch(() => null))?.size ?? 0;
      }
    }
    return true;
  };
  const complete = await walk(dir);
  return { bytes, files, partial: !complete };
}

async function capacity(dir: string): Promise<{ total: number; free: number } | null> {
  try {
    const f = await statfs(dir);
    return { total: Number(f.blocks) * Number(f.bsize), free: Number(f.bavail) * Number(f.bsize) };
  } catch {
    return null;
  }
}

export class StorageService {
  readonly integrity: BlobIntegrity;
  private readonly built = new Map<string, BlobStore>();
  private timer: NodeJS.Timeout | null = null;
  private off: (() => void) | null = null;

  constructor(private readonly s: () => Services) {
    this.integrity = new BlobIntegrity(s);
  }

  private get switchable(): SwitchableBlobStore | null {
    const b = this.s().blobs;
    return b instanceof SwitchableBlobStore ? b : null;
  }

  registerJobs(): void {
    const jobs = this.s().jobs;
    this.integrity.registerJobs();
    jobs.register(MIGRATE_JOB, async (p, ctx) => this.runMigration(String(p.migrationId), ctx), { timeoutMs: 7 * 24 * 3_600_000 });
    jobs.register(SAMPLE_JOB, async () => this.sampleUsage());
  }

  schedule(scheduler: Scheduler): void {
    const s = this.s();
    const once = async () => {
      const t = await platformTenant(s);
      return t ? [{ tenantId: t, payload: {}, key: 'platform' }] : [];
    };
    scheduler.every(VERIFY_JOB, s.cfg.BLOBS_VERIFY_MINUTES * 60_000, once);
    scheduler.every(SAMPLE_JOB, 6 * 3_600_000, once);
  }

  /** Follows the shared store mode: at once on the bus, and every PLATFORM_INSTANCE_REPORT_SECONDS. */
  start(): void {
    const s = this.s();
    this.off = s.bus.on(BLOBS_TOPIC, () => this.syncStore());
    this.timer = setInterval(() => void this.syncStore().catch((err: Error) => s.log.warn({ err: err.message }, 'blob store mode sync failed')), s.cfg.PLATFORM_INSTANCE_REPORT_SECONDS * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.off?.();
    this.off = null;
  }

  // ---------- the store mode (migration) ----------

  private async migrationRow(id: string): Promise<MigrationRow> {
    const r = await this.s().db('platform_blob_migrations').where({ id }).first();
    if (!r) throw notFound('Migration');
    return migrationFrom(r);
  }

  /** The store a migration moved to, built once per process; null is the store the environment configures. */
  private async storeFor(migration: string | null): Promise<BlobStore> {
    const sw = this.switchable;
    if (!migration) return sw ? sw.configured : this.s().blobs;
    const cached = this.built.get(migration);
    if (cached) return cached;
    const m = await this.migrationRow(migration);
    const t = m.target;
    let store: BlobStore;
    if (t.kind === 'fs') store = new FsBlobStore(t.dir!);
    else {
      const secret = m.target_secret ? await this.s().keys.open(PLATFORM_SCOPE, m.target_secret, `blob-migration:${m.id}`) : '';
      store = new S3BlobStore({ endpoint: t.endpoint!, region: t.region ?? 'us-east-1', bucket: t.bucket!, accessKeyId: t.accessKeyId ?? '', secretAccessKey: secret, pathStyle: t.pathStyle ?? true });
    }
    this.built.set(migration, store);
    return store;
  }

  /** Applies the shared mode to this process's blob store. */
  async syncStore(): Promise<string> {
    const sw = this.switchable;
    if (!sw) return 'single';
    const mode = await getState<(BlobMode & { migration?: string }) | null>(this.s(), MODE_KEY, null);
    const label = !mode ? 'single' : mode.mode === 'single' ? (mode.migration ? `single:${mode.migration}` : 'single') : `${mode.mode}:${mode.migration}`;
    if (label === this.appliedLabel) return sw.label;
    if (!mode || (mode.mode === 'single' && !mode.migration)) sw.apply({ mode: 'single' }, { from: sw.configured, to: null });
    else if (mode.mode === 'single') sw.apply({ mode: 'single' }, { from: sw.configured, to: await this.storeFor(mode.migration!) });
    else {
      const m = await this.migrationRow(mode.migration);
      sw.apply(mode, { from: await this.storeFor(m.source.migration), to: await this.storeFor(m.id) });
    }
    this.appliedLabel = label;
    return sw.label;
  }

  private appliedLabel = 'single';

  private async setMode(mode: BlobMode | { mode: 'single'; migration: string }): Promise<void> {
    await setState(this.s(), MODE_KEY, mode);
    await this.syncStore();
    this.s().bus.publish(BLOBS_TOPIC, mode);
  }

  /** The store reads come from, in words (no secret). */
  async activeLabel(): Promise<{ label: string; migration: string | null }> {
    const s = this.s();
    const mode = await getState<{ mode: string; migration?: string } | null>(s, MODE_KEY, null);
    const id = mode && (mode.mode === 'switched' || mode.mode === 'single') ? mode.migration ?? null : null;
    if (id) return { label: targetLabel((await this.migrationRow(id)).target), migration: id };
    return { label: s.cfg.BLOB_STORE === 's3' ? `S3 bucket ${s.cfg.S3_BUCKET ?? ''} at ${s.cfg.S3_ENDPOINT ? new URL(s.cfg.S3_ENDPOINT).host : ''}` : `filesystem ${path.resolve(s.cfg.BLOB_DIR)}`, migration: null };
  }

  async migrations(limit = 20): Promise<ReturnType<typeof migrationView>[]> {
    return ((await this.s().db('platform_blob_migrations').orderBy('created_at', 'desc').limit(limit)) as Record<string, unknown>[]).map((r) => migrationView(migrationFrom(r)));
  }

  /** Queues a copy of every object to another store; reads switch when the copy is complete and verified. */
  async startMigration(by: OpsActor, target: MigrationTarget & { secretAccessKey?: string }, reason: string): Promise<ReturnType<typeof migrationView>> {
    const s = this.s();
    const busy = await s.db('platform_blob_migrations').whereIn('state', ['queued', 'copying', 'switched']).first('id', 'state');
    if (busy) throw conflict(busy.state === 'switched' ? 'The last migration has switched but its old store is not retired yet; retire it first.' : 'A migration is already running.');
    const active = await this.activeLabel();
    const t: MigrationTarget = target.kind === 'fs' ? { kind: 'fs', dir: path.resolve(target.dir ?? '') } : { kind: 's3', endpoint: target.endpoint!, bucket: target.bucket!, region: target.region ?? 'us-east-1', pathStyle: target.pathStyle ?? true, accessKeyId: target.accessKeyId ?? '' };
    if (targetLabel(t) === active.label || (t.kind === 'fs' && s.blobs.kind === 'fs' && !active.migration && path.resolve(s.cfg.BLOB_DIR) === t.dir)) throw conflict('That is the store in use now.');
    if (t.kind === 'fs') {
      if (!path.isAbsolute(target.dir ?? '')) throw new HttpProblem(422, 'Target refused', 'A filesystem target is an absolute directory.', { extensions: { field: 'dir' } });
      const cur = path.resolve(s.cfg.BLOB_DIR);
      if (!active.migration && s.blobs.kind === 'fs' && (t.dir!.startsWith(cur + path.sep) || cur.startsWith(t.dir! + path.sep))) throw new HttpProblem(422, 'Target refused', 'The target cannot be inside the current store, or contain it.', { extensions: { field: 'dir' } });
    } else {
      try {
        await checkServiceUrl(t.endpoint!, servicePolicy(s.cfg));
      } catch (err) {
        throw new HttpProblem(422, 'Target refused', (err as Error).message, { extensions: { field: 'endpoint' } });
      }
      if (!t.bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(t.bucket)) throw new HttpProblem(422, 'Target refused', 'An S3 bucket name is 3 to 63 lower-case letters, digits, dots and dashes.', { extensions: { field: 'bucket' } });
      if (!target.accessKeyId || !target.secretAccessKey) throw new HttpProblem(422, 'Target refused', 'An S3 target needs an access key id and a secret access key.', { extensions: { field: 'secretAccessKey' } });
    }
    const id = ulid();
    const probe = t.kind === 'fs' ? new FsBlobStore(t.dir!) : new S3BlobStore({ endpoint: t.endpoint!, region: t.region!, bucket: t.bucket!, accessKeyId: t.accessKeyId!, secretAccessKey: target.secretAccessKey!, pathStyle: t.pathStyle! });
    const health = await probe.health();
    if (!health.ok) throw new HttpProblem(422, 'Target unreachable', `The target store does not answer: ${health.detail}`, { extensions: { field: 'endpoint' } });
    const row = {
      id, state: 'queued', source: JSON.stringify({ migration: active.migration, label: active.label }), target: JSON.stringify(t),
      target_secret: t.kind === 's3' ? await s.keys.seal(PLATFORM_SCOPE, target.secretAccessKey!, `blob-migration:${id}`) : null,
      reason, created_by: by.userId, created_at: Date.now()
    };
    await s.db('platform_blob_migrations').insert(row);
    const job = await s.jobs.enqueue({ tenantId: by.tenantId, type: MIGRATE_JOB, payload: { migrationId: id }, createdBy: by.userId, maxAttempts: 1 });
    await s.db('platform_blob_migrations').where({ id }).update({ job_id: job.id });
    await audit(s, by, 'platform.blobs.migration.started', { migration: id, job: job.id }, { from: active.label, to: targetLabel(t), reason }, 'admin');
    return migrationView(await this.migrationRow(id));
  }

  /** Waits until every live instance copies writes to the target (reports `dual:<id>`). */
  private async waitForInstances(id: string, signal: AbortSignal): Promise<void> {
    const s = this.s();
    await s.settings.report().catch(() => undefined);
    const until = Date.now() + 2 * s.cfg.PLATFORM_INSTANCE_REPORT_SECONDS * 1000 + 30_000;
    for (;;) {
      const live = (await s.settings.instances()).filter((i) => i.live);
      const behind = live.filter((i) => i.blob_mode !== `dual:${id}`);
      if (!behind.length) return;
      if (Date.now() > until) throw new Error(`Instances did not start copying writes to the target: ${behind.map((i) => i.instance).join(', ')}.`);
      if (signal.aborted) throw new Error('cancelled');
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  /** Copies one object and checks the copy's SHA-256 against what was read. */
  private async copyOne(from: BlobStore, to: BlobStore, key: string): Promise<number> {
    const got = await from.getStream(key);
    if (!got) return -1;
    const h = createHash('sha256');
    const hashed = async function* () {
      for await (const c of got.stream as AsyncIterable<Buffer>) {
        h.update(c);
        yield c;
      }
    };
    await to.putStream(key, hashed());
    const want = h.digest('hex');
    const back = await to.getStream(key);
    if (!back) throw new Error(`The copy of ${key} is missing.`);
    const h2 = createHash('sha256');
    for await (const c of back.stream as AsyncIterable<Buffer>) h2.update(c);
    if (h2.digest('hex') !== want) throw new Error(`The copy of ${key} does not match its source.`);
    return got.size;
  }

  async runMigration(id: string, ctx: Pick<JobContext, 'progress' | 'signal'>): Promise<Record<string, unknown>> {
    const s = this.s();
    const m = await this.migrationRow(id);
    if (m.state !== 'queued') return { skipped: m.state };
    const by = systemActor((await platformTenant(s)) ?? 'platform', m.created_by);
    const from = await this.storeFor(m.source.migration);
    const to = await this.storeFor(m.id);
    try {
      await s.db('platform_blob_migrations').where({ id }).update({ state: 'copying' });
      await this.setMode({ mode: 'dual', migration: id });
      await ctx.progress(1, 'Waiting for every instance to copy new writes');
      await this.waitForInstances(id, ctx.signal);
      const copied = new Set<string>();
      let bytes = 0;
      const pass = async (label: string) => {
        const keys: { key: string; size: number }[] = [];
        for await (const o of from.list('')) if (!o.key.endsWith('.tmp')) keys.push({ key: o.key, size: o.size });
        await s.db('platform_blob_migrations').where({ id }).update({ objects: keys.length });
        let i = 0;
        for (const o of keys) {
          if (ctx.signal.aborted) throw new Error('cancelled');
          i++;
          if (copied.has(o.key)) continue;
          const size = await this.copyOne(from, to, o.key);
          if (size >= 0) {
            copied.add(o.key);
            bytes += size;
          }
          if (i % 50 === 0 || i === keys.length) {
            await s.db('platform_blob_migrations').where({ id }).update({ copied: copied.size, bytes });
            await ctx.progress(Math.min(90, 2 + Math.round((i * 85) / Math.max(1, keys.length))), `${label}: ${i} of ${keys.length}`);
          }
        }
        return keys.length;
      };
      await pass('Copying');
      // Writes made while the first pass ran reached the target too; a second pass picks up anything listed late.
      const total = await pass('Catching up');
      await ctx.progress(92, 'Verifying the target');
      const there = new Map<string, number>();
      for await (const o of to.list('')) there.set(o.key, o.size);
      let verified = 0;
      for await (const o of from.list('')) {
        if (o.key.endsWith('.tmp')) continue;
        if (there.get(o.key) !== o.size) throw new Error(`${o.key} is not on the target with the same size.`);
        verified++;
      }
      await s.db('platform_blob_migrations').where({ id }).update({ state: 'switched', copied: copied.size, bytes, verified, objects: total, switched_at: Date.now() });
      await this.setMode({ mode: 'switched', migration: id });
      await audit(s, by, 'platform.blobs.migration.switched', { migration: id }, { from: m.source.label, to: targetLabel(m.target), objects: verified, bytes });
      await notifyAdmins(s, { kind: 'platform.blobs.migration.switched', title: 'The blob store has moved', body: `Reads and writes now go to ${targetLabel(m.target)}. The old store stays readable until it is retired on Storage.` }).catch(() => 0);
      return { migration: id, objects: verified, bytes };
    } catch (err) {
      const message = (err as Error).message;
      await this.setMode(m.source.migration ? { mode: 'single', migration: m.source.migration } : { mode: 'single' });
      await s.db('platform_blob_migrations').where({ id }).update({ state: message === 'cancelled' ? 'cancelled' : 'failed', error: message.slice(0, 1000) });
      await audit(s, by, 'platform.blobs.migration.failed', { migration: id }, { error: message.slice(0, 500) });
      throw err;
    }
  }

  /** Stops reading from the old store: the target is the only store from now on. */
  async retireMigration(by: OpsActor, id: string, reason: string): Promise<ReturnType<typeof migrationView>> {
    const s = this.s();
    const m = await this.migrationRow(id);
    if (m.state !== 'switched') throw conflict(`The migration is ${m.state}; only a switched migration's old store can be retired.`);
    if (!(await s.db('platform_blob_migrations').where({ id, state: 'switched' }).update({ state: 'retired', retired_by: by.userId, retired_at: Date.now() }))) throw conflict('The migration changed meanwhile.');
    await this.setMode({ mode: 'single', migration: id });
    await audit(s, by, 'platform.blobs.migration.retired', { migration: id }, { old: m.source.label, store: targetLabel(m.target), reason }, 'admin');
    return migrationView(await this.migrationRow(id));
  }

  // ---------- stores ----------

  private async growth(scope: string, today: number | null): Promise<number[]> {
    const since = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
    const rows = (await this.s().db('platform_storage_samples').where({ scope }).andWhere('day', '>=', since).orderBy('day')) as { day: string; bytes: number | string }[];
    const out = rows.filter((r) => r.day !== day()).map((r) => Number(r.bytes));
    if (today != null) out.push(today);
    else if (rows.length && rows[rows.length - 1]!.day === day()) out.push(Number(rows[rows.length - 1]!.bytes));
    return out;
  }

  private async dbStore(): Promise<Record<string, unknown>> {
    const s = this.s();
    const c = s.cfg.DB_CLIENT;
    const t0 = Date.now();
    let kind = 'SQLite';
    let used: number | null = null;
    let objects = '';
    let location = '';
    let healthy = true;
    let detail: string;
    try {
      if (c === 'pg') {
        const v = (await s.db.raw('SHOW server_version')).rows[0].server_version as string;
        kind = `PostgreSQL ${v.split(' ')[0]}`;
        used = Number((await s.db.raw('SELECT pg_database_size(current_database()) AS b')).rows[0].b);
        const conns = Number((await s.db.raw('SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database()')).rows[0].n);
        const max = Number((await s.db.raw('SHOW max_connections')).rows[0].max_connections);
        objects = `${conns} of ${max} connections`;
        location = `database ${(await s.db.raw('SELECT current_database() AS d')).rows[0].d}`;
      } else if (c === 'mysql') {
        const [[v]] = (await s.db.raw('SELECT VERSION() AS v')) as [[{ v: string }]];
        kind = `MySQL ${v.v}`;
        const [[size]] = (await s.db.raw('SELECT COALESCE(SUM(data_length + index_length), 0) AS b FROM information_schema.tables WHERE table_schema = database()')) as [[{ b: number | string }]];
        used = Number(size.b);
        const [[conns]] = (await s.db.raw("SHOW STATUS LIKE 'Threads_connected'")) as [[{ Value: string }]];
        const [[max]] = (await s.db.raw("SHOW VARIABLES LIKE 'max_connections'")) as [[{ Value: string }]];
        objects = `${conns.Value} of ${max.Value} connections`;
        const [[d]] = (await s.db.raw('SELECT database() AS d')) as [[{ d: string }]];
        location = `database ${d.d}`;
      } else {
        const file = s.cfg.SQLITE_FILENAME;
        location = file === ':memory:' ? 'in memory' : path.resolve(file);
        used = file === ':memory:' ? null : ((await stat(file).catch(() => null))?.size ?? null);
        objects = 'one file, one writer';
      }
      detail = `Answered in ${Date.now() - t0} ms.`;
    } catch (err) {
      healthy = false;
      detail = (err as Error).message.slice(0, 300);
    }
    const migrations = (await s.db('knex_migrations').orderBy('id', 'desc').first('name').catch(() => null)) as { name: string } | null;
    if (migrations) detail += ` Latest migration ${migrations.name}.`;
    if (used != null) await sample(s, 'store:db', used, null).catch(() => undefined);
    return { id: 'db', name: 'Database', kind, location, usedBytes: used, capacityBytes: null, objects, health: healthy ? 'ok' : 'failing', checkedAt: Date.now(), detail, settings: ['DB_CLIENT', 'DATABASE_URL', 'DB_POOL_MAX'], growth: await this.growth('store:db', used) };
  }

  async stores(): Promise<{ stores: Record<string, unknown>[]; migration: Record<string, unknown> | null; active: { label: string; migration: string | null; mode: string } }> {
    const s = this.s();
    const now = Date.now();
    const [health, last, active, migrations] = await Promise.all([s.blobs.health(), this.integrity.lastSucceeded(), this.activeLabel(), this.migrations(1)]);
    const out: Record<string, unknown>[] = [];
    const fsStore = s.blobs.kind === 'fs';
    const dir = active.migration ? ((await this.migrationRow(active.migration)).target.dir ?? null) : fsStore ? path.resolve(s.cfg.BLOB_DIR) : null;
    const cap = fsStore && dir ? await capacity(dir) : null;
    out.push({
      id: 'blobs', name: 'Blob store', kind: fsStore ? 'Filesystem' : 'S3', location: fsStore && dir ? dir : active.label.replace(/^S3 /, ''),
      usedBytes: last?.bytes ?? null, capacityBytes: cap ? cap.total : null, freeBytes: cap ? cap.free : null,
      objects: last ? `${last.objects} objects, as of the verification of ${new Date(last.finished_at ?? last.created_at).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'not counted yet: run the integrity check',
      health: health.ok ? 'ok' : 'failing', checkedAt: now, detail: `/readyz blobs: ${health.ok ? 'ok' : 'failing'} (${health.detail}).`,
      settings: fsStore ? ['BLOB_STORE', 'BLOB_DIR'] : ['BLOB_STORE', 'S3_ENDPOINT', 'S3_BUCKET', 'S3_REGION', 'S3_FORCE_PATH_STYLE'],
      growth: await this.growth('store:blobs', null), verify: true, migrate: true, singleNode: fsStore
    });
    out.push(await this.dbStore());
    const chunks = Number(((await s.db('knowledge_chunks').count({ n: '*' }).first()) as { n: number | string }).n);
    const bases = Number(((await s.db('knowledge_bases').count({ n: '*' }).first()) as { n: number | string }).n);
    out.push({ id: 'vectors', name: 'Vector store', kind: s.vectors.kind === 'pgvector' ? 'pgvector' : 'In the database', location: `in the database, ${bases} knowledge ${bases === 1 ? 'base' : 'bases'}`, usedBytes: null, capacityBytes: null, objects: `${chunks.toLocaleString('en-US')} chunks`, health: 'ok', checkedAt: now, detail: s.vectors.kind === 'pgvector' ? 'Embeddings are kept in pgvector columns beside their chunks; a re-index runs as knowledge.reindex.' : 'Embeddings are kept in the database beside their chunks and searched in the server; a re-index runs as knowledge.reindex.', settings: ['KNOWLEDGE_REPLICATION', 'KNOWLEDGE_REPLICATION_TICK_MS'], growth: [] });
    const backups = (await s.db('platform_backups').where({ state: 'succeeded' }).orderBy('created_at', 'desc').select('bytes', 'finished_at', 'created_at')) as { bytes: number | string | null; finished_at: number | string | null; created_at: number | string }[];
    const bBytes = backups.reduce((a, b) => a + Number(b.bytes ?? 0), 0);
    const lastBackup = backups[0] ? Number(backups[0].finished_at ?? backups[0].created_at) : null;
    const rpoLate = lastBackup != null && now - lastBackup > s.cfg.PLATFORM_BACKUP_RPO_MINUTES * 60_000;
    await sample(s, 'store:backups', bBytes, backups.length).catch(() => undefined);
    out.push({ id: 'backups', name: 'Backups', kind: 'In the blob store', location: 'platform/backups/ in the blob store', usedBytes: bBytes, capacityBytes: null, objects: `${backups.length} kept of ${s.cfg.PLATFORM_BACKUP_RETAIN}, last ${lastBackup ? new Date(lastBackup).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'never'}, RPO ${s.cfg.PLATFORM_BACKUP_RPO_MINUTES} min`, health: !lastBackup || rpoLate ? 'late' : 'ok', checkedAt: now, detail: `Signed, encrypted dumps of the database${s.cfg.PLATFORM_BACKUP_BLOBS ? ' with the blob objects they reference' : ''}. Backups are never orphans; their retention removes them.`, settings: ['PLATFORM_BACKUP_MINUTES', 'PLATFORM_BACKUP_RETAIN', 'PLATFORM_BACKUP_BLOBS'], growth: await this.growth('store:backups', bBytes), link: { route: 'platform', params: { tab: 'backups' }, label: 'Open Platform › Backups' } });
    const work = s.cfg.MEDIA_WORK_DIR ?? null;
    const w = work ? await du(work) : null;
    const wCap = work ? await capacity(work) : null;
    out.push({ id: 'media', name: 'Media work directory', kind: 'Filesystem', location: work ? `MEDIA_WORK_DIR ${work} on ${s.settings.instance}` : 'the system temporary directory (MEDIA_WORK_DIR unset)', usedBytes: w ? w.bytes : null, capacityBytes: wCap ? wCap.total : null, objects: w ? `${w.files}${w.partial ? '+' : ''} files of jobs in progress` : 'scratch, per job', health: 'ok', checkedAt: now, detail: 'Transcodes and transcripts land here before their outputs are sealed into the blob store; cleared when a job finishes or is cancelled.', settings: ['MEDIA_WORK_DIR', 'MEDIA_MAX_BYTES', 'MEDIA_URL_TTL_SECONDS'], growth: [] });
    const ds = (await s.db('training_datasets').whereNot({ state: 'withdrawn' }).select('name', 'rows')) as { name: string; rows: number | string }[];
    out.push({ id: 'datasets', name: 'Training datasets', kind: 'Sealed files', location: 'training/ in the blob store, opened only by the trainer', usedBytes: null, capacityBytes: null, objects: `${new Set(ds.map((d) => d.name)).size} datasets, ${ds.length} versions, ${ds.reduce((a, d) => a + Number(d.rows), 0).toLocaleString('en-US')} rows`, health: 'ok', checkedAt: now, detail: 'Datasets are sealed with the tenant key and opened only for a training run (B-905). Versions are kept while a job or model card references them.', settings: ['TRAINER_URL', 'TRAINER_ARTIFACT_MAX_BYTES'], growth: [] });
    const models = (await s.db('models').select('size_bytes')) as { size_bytes: number | string | null }[];
    out.push({ id: 'models', name: 'Model files', kind: 'Ollama', location: 'on the pools', usedBytes: models.reduce((a, m) => a + Number(m.size_bytes ?? 0), 0), capacityBytes: null, objects: `${models.length} models in the catalogue`, health: 'ok', checkedAt: now, detail: "Weights live on each pool's instances, pulled through the registry mirror. Placement and eviction are on Pools.", settings: ['OLLAMA_MAX_LOADS_PER_10_MIN', 'OLLAMA_LOAD_TIMEOUT_MS'], growth: [], link: { route: 'pools', params: {}, label: 'Open Pools' } });
    const mig = migrations[0] ?? null;
    return { stores: out, migration: mig && mig.state !== 'retired' ? mig : null, active: { ...active, mode: this.switchable?.label ?? 'single' } };
  }

  // ---------- usage ----------

  private async sums(q: ReturnType<Services['db']>, by: string, col: string): Promise<Map<string, number>> {
    const rows = (await q.select(`${by} as k`).sum({ b: col }).groupBy(by)) as { k: string | null; b: number | string | null }[];
    return new Map(rows.map((r) => [r.k ?? '', Number(r.b ?? 0)]));
  }

  /** Bytes by workspace, user and kind. The file quota (B-2403) counts files, versions and trash. */
  async usage(): Promise<Record<string, unknown>> {
    const s = this.s();
    const db = s.db;
    const active = ['quarantined', 'scanning', 'ready'];
    const trash = await this.sums(db('file_versions as v').join('files as f', 'f.id', 'v.file_id').whereIn('v.state', active).whereNotNull('f.trashed_at'), 'v.workspace_id', 'v.size');
    const current = await this.sums(db('file_versions as v').join('files as f', 'f.id', 'v.file_id').whereIn('v.state', active).whereNull('f.trashed_at').whereRaw('v.number = f.current_version'), 'v.workspace_id', 'v.size');
    const all = await this.sums(db('file_versions as v').whereIn('v.state', active), 'v.workspace_id', 'v.size');
    const media = await this.sums(db('media_assets').whereNotIn('state', ['refused']), 'workspace_id', 'size');
    const knowledge = await this.sums(db('knowledge_documents as d').join('knowledge_bases as b', 'b.id', 'd.kb_id').whereNotNull('d.blob_key'), 'b.workspace_id', 'd.size');
    const attachments = await this.sums(db('attachments').whereIn('state', ['quarantined', 'scanning', 'ready']), 'workspace_id', 'size');
    const quotas = new Map(((await db('file_quotas').whereNotNull('workspace_id').select('workspace_id', 'max_bytes')) as { workspace_id: string; max_bytes: number | string | null }[]).map((q) => [q.workspace_id, q.max_bytes == null ? null : Number(q.max_bytes)]));
    const workspaces = (await db('workspaces as w').join('tenants as t', 't.id', 'w.tenant_id').select('w.id', 'w.name', 'w.label_ceiling', 'w.tenant_id', 't.name as tenant')) as { id: string; name: string; label_ceiling: string; tenant_id: string; tenant: string }[];
    // Who holds the bytes: uploaders of versions, attachments and media, per workspace.
    const perUser = new Map<string, Map<string, number>>();
    const addUsers = (rows: { w: string | null; u: string | null; b: number | string | null }[]) => {
      for (const r of rows) {
        if (!r.w || !r.u) continue;
        const m = perUser.get(r.w) ?? new Map<string, number>();
        m.set(r.u, (m.get(r.u) ?? 0) + Number(r.b ?? 0));
        perUser.set(r.w, m);
      }
    };
    addUsers((await db('file_versions').whereIn('state', active).select('workspace_id as w', 'created_by as u').sum({ b: 'size' }).groupBy('workspace_id', 'created_by')) as never);
    addUsers((await db('attachments').whereIn('state', ['quarantined', 'scanning', 'ready']).select('workspace_id as w', 'user_id as u').sum({ b: 'size' }).groupBy('workspace_id', 'user_id')) as never);
    addUsers((await db('media_assets').whereNotIn('state', ['refused']).select('workspace_id as w', 'user_id as u').sum({ b: 'size' }).groupBy('workspace_id', 'user_id')) as never);
    const userIds = [...new Set([...perUser.values()].flatMap((m) => [...m.keys()]))];
    const names = new Map(((userIds.length ? await db('users').whereIn('id', userIds.slice(0, 5000)).select('id', 'display_name') : []) as { id: string; display_name: string }[]).map((u) => [u.id, u.display_name]));
    interface WorkspaceUsage { id: string; workspace: string; tenantId: string; tenant: string; label: string; files: number; versions: number; trash: number; media: number; knowledge: number; attachments: number; total: number; quotaBytes: number | null; quotaUsed: number; users: { id: string; name: string; bytes: number }[]; growth: number[] }
    const list: WorkspaceUsage[] = [];
    for (const w of workspaces) {
      const files = current.get(w.id) ?? 0;
      const tr = trash.get(w.id) ?? 0;
      const versions = Math.max(0, (all.get(w.id) ?? 0) - files - tr);
      const row = { files, versions, trash: tr, media: media.get(w.id) ?? 0, knowledge: knowledge.get(w.id) ?? 0, attachments: attachments.get(w.id) ?? 0 };
      const total = row.files + row.versions + row.trash + row.media + row.knowledge + row.attachments;
      const counted = row.files + row.versions + row.trash;
      const users = [...(perUser.get(w.id) ?? new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, b]) => ({ id, name: names.get(id) ?? id, bytes: b }));
      list.push({ id: w.id, workspace: w.name, tenantId: w.tenant_id, tenant: w.tenant, label: w.label_ceiling, ...row, total, quotaBytes: quotas.get(w.id) ?? null, quotaUsed: counted, users, growth: await this.growth(`workspace:${w.id}`, total) });
    }
    list.sort((a, b) => b.total - a.total);
    const byUser = new Map<string, { bytes: number; workspaces: string[] }>();
    for (const w of list) {
      for (const [u, b] of perUser.get(w.id) ?? new Map<string, number>()) {
        const e = byUser.get(u) ?? { bytes: 0, workspaces: [] };
        e.bytes += b;
        e.workspaces.push(w.workspace);
        byUser.set(u, e);
      }
    }
    const kinds = (['files', 'versions', 'trash', 'media', 'knowledge', 'attachments'] as const).map((k) => ({ kind: k, bytes: list.reduce((a, w) => a + w[k], 0) }));
    // 1.6.0 (B-4601): what shared objects save, per tenant (identical content is shared within a tenant only).
    const tenantNames = new Map(((await db('tenants').select('id', 'name')) as { id: string; name: string }[]).map((t) => [t.id, t.name]));
    const perTenant = (await s.files.dedup.savings()).map((d) => ({ ...d, tenant: tenantNames.get(d.tenantId) ?? d.tenantId })).sort((a, b) => b.savedBytes - a.savedBytes);
    const sum = (k: 'blobs' | 'shared' | 'references' | 'logicalBytes' | 'storedBytes' | 'savedBytes') => perTenant.reduce((a, d) => a + d[k], 0);
    const dedup = { tenants: perTenant, blobs: sum('blobs'), shared: sum('shared'), references: sum('references'), logicalBytes: sum('logicalBytes'), storedBytes: sum('storedBytes'), savedBytes: sum('savedBytes') };
    return {
      dedup,
      workspaces: list,
      users: [...byUser.entries()].map(([id, e]) => ({ id, name: names.get(id) ?? id, bytes: e.bytes, workspaces: e.workspaces })).sort((a, b) => b.bytes - a.bytes).slice(0, 200),
      kinds,
      quotaCounts: ['files', 'versions', 'trash']
    };
  }

  /** The daily samples of every workspace's total (the growth lines). */
  async sampleUsage(): Promise<{ workspaces: number }> {
    const u = (await this.usage()) as { workspaces: { id: string; total: number }[] };
    for (const w of u.workspaces) await sample(this.s(), `workspace:${w.id}`, w.total, null);
    return { workspaces: u.workspaces.length };
  }

  // ---------- quarantine ----------

  private async scanJob(kind: QuarantineKind, id: string, tenantId: string, since: number): Promise<{ state: string; error: string | null } | null> {
    const s = this.s();
    const j = SCAN_JOBS[kind];
    const r = (await s.db('jobs').where({ tenant_id: tenantId, type: j.type }).andWhere('created_at', '>=', since - 1000).andWhere('payload', 'like', `%"${id}"%`).orderBy('created_at', 'desc').first('state', 'error')) as { state: string; error: string | null } | undefined;
    return r ?? null;
  }

  async quarantine(): Promise<Record<string, unknown>[]> {
    const s = this.s();
    const db = s.db;
    const since = Date.now() - 24 * 3_600_000;
    const ws = new Map(((await db('workspaces').select('id', 'name')) as { id: string; name: string }[]).map((w) => [w.id, w.name]));
    const items: { kind: QuarantineKind; id: string; tenantId: string; object: string; label: string; workspaceId: string | null; size: number; state: string; reason: string | null; at: number; by: string | null; holds: boolean }[] = [];
    for (const a of (await db('attachments').where((q) => q.whereIn('state', ['quarantined', 'scanning']).orWhere((q2) => q2.where({ state: 'rejected' }).andWhere('created_at', '>', since))).orderBy('created_at', 'desc').limit(200)) as Record<string, unknown>[]) {
      items.push({ kind: 'attachment', id: String(a.id), tenantId: String(a.tenant_id), object: String(a.name), label: 'attachment', workspaceId: (a.workspace_id as string | null) ?? null, size: Number(a.size), state: String(a.state), reason: (a.reason as string | null) ?? null, at: Number(a.created_at), by: (a.user_id as string | null) ?? null, holds: !!a.blob_key && a.state !== 'rejected' });
    }
    for (const v of (await db('file_versions as v').join('files as f', 'f.id', 'v.file_id').where((q) => q.whereIn('v.state', ['quarantined', 'scanning']).orWhere((q2) => q2.where('v.state', 'rejected').andWhere('v.scanned_at', '>', since))).select('v.*', 'f.name as file_name').orderBy('v.created_at', 'desc').limit(200)) as Record<string, unknown>[]) {
      items.push({ kind: 'file', id: String(v.id), tenantId: String(v.tenant_id), object: String(v.file_name), label: Number(v.number) > 1 ? `file version ${String(v.number)}` : 'file', workspaceId: String(v.workspace_id), size: Number(v.size), state: String(v.state), reason: (v.reason as string | null) ?? null, at: Number(v.created_at), by: (v.created_by as string | null) ?? null, holds: !!v.blob_key && v.state !== 'rejected' });
    }
    for (const d of (await db('knowledge_documents as d').join('knowledge_bases as b', 'b.id', 'd.kb_id').where((q) => q.whereIn('d.state', ['quarantined', 'scanning']).orWhere((q2) => q2.where('d.state', 'rejected').andWhere('d.updated_at', '>', since))).select('d.*', 'b.workspace_id as ws').orderBy('d.created_at', 'desc').limit(200)) as Record<string, unknown>[]) {
      items.push({ kind: 'knowledge', id: String(d.id), tenantId: String(d.tenant_id), object: String(d.name), label: 'knowledge upload', workspaceId: (d.ws as string | null) ?? null, size: Number(d.size), state: String(d.state), reason: (d.error as string | null) ?? null, at: Number(d.created_at), by: null, holds: !!d.blob_key && d.state !== 'rejected' });
    }
    for (const m of (await db('media_assets').where((q) => q.whereIn('state', ['quarantined', 'probing']).orWhere((q2) => q2.where({ state: 'refused' }).andWhere('created_at', '>', since))).orderBy('created_at', 'desc').limit(200)) as Record<string, unknown>[]) {
      items.push({ kind: 'media', id: String(m.id), tenantId: String(m.tenant_id), object: String(m.name), label: 'media upload', workspaceId: (m.workspace_id as string | null) ?? null, size: Number(m.size), state: m.state === 'refused' ? 'rejected' : m.state === 'probing' ? 'scanning' : String(m.state), reason: (m.reason as string | null) ?? null, at: Number(m.created_at), by: (m.user_id as string | null) ?? null, holds: !!m.blob_key && m.state !== 'refused' });
    }
    const userIds = [...new Set(items.map((i) => i.by).filter((x): x is string => !!x))];
    const names = new Map(((userIds.length ? await db('users').whereIn('id', userIds).select('id', 'display_name') : []) as { id: string; display_name: string }[]).map((u) => [u.id, u.display_name]));
    const out = [];
    for (const i of items.sort((a, b) => b.at - a.at)) {
      let state = i.state === 'rejected' ? refusalState(i.reason) : 'scanning';
      let detail = i.reason;
      let running = false;
      if (i.state !== 'rejected') {
        const job = await this.scanJob(i.kind, i.id, i.tenantId, i.at);
        running = job?.state === 'running';
        if (job && (job.state === 'failed' || job.state === 'cancelled')) {
          state = /time|timed out/i.test(job.error ?? '') ? 'timed out' : 'scan failed';
          detail = `The scan did not finish: ${job.error ?? job.state}. The object stays in quarantine; Rescan tries again.`;
        } else if (!job) detail = 'Waiting for its scan job.';
        else detail = job.state === 'running' ? 'Being scanned now.' : 'Queued for its scan.';
      }
      out.push({ kind: i.kind, id: i.id, object: i.object, label: i.label, workspace: i.workspaceId ? (ws.get(i.workspaceId) ?? i.workspaceId) : 'no workspace', workspaceId: i.workspaceId, tenantId: i.tenantId, size: i.size, state, rawState: i.state, detail, at: i.at, by: i.by ? (names.get(i.by) ?? i.by) : null, holdsBytes: i.holds, running, canRescan: i.holds && !running, canDelete: i.holds && !running });
    }
    return out;
  }

  async scanner(): Promise<Record<string, unknown>> {
    const s = this.s();
    const db = s.db;
    const midnight = new Date(new Date().toISOString().slice(0, 10)).getTime();
    const host = s.cfg.CLAMD_HOST ?? null;
    let reachable: boolean | null = null;
    let version: string | null = null;
    let error: string | null = null;
    if (host) {
      try {
        reachable = (await clamd(host, s.cfg.CLAMD_PORT, 'PING')) === 'PONG';
        version = await clamd(host, s.cfg.CLAMD_PORT, 'VERSION').catch(() => null);
      } catch (err) {
        reachable = false;
        error = (err as Error).message;
      }
    }
    const count = async (q: ReturnType<Services['db']>) => Number(((await q.count({ n: '*' }).first()) as { n: number | string }).n);
    const scanned = (await count(db('file_versions').where('scanned_at', '>=', midnight))) + (await count(db('attachments').whereIn('state', ['ready', 'rejected']).andWhere('created_at', '>=', midnight)));
    const reasons = [
      ...((await db('file_versions').where({ state: 'rejected' }).andWhere('scanned_at', '>=', midnight).select('reason')) as { reason: string | null }[]),
      ...((await db('attachments').where({ state: 'rejected' }).andWhere('created_at', '>=', midnight).select('reason')) as { reason: string | null }[])
    ].map((r) => refusalState(r.reason));
    const refused: Record<string, number> = {};
    for (const r of reasons) refused[r] = (refused[r] ?? 0) + 1;
    const failures = await count(db('jobs').whereIn('type', Object.values(SCAN_JOBS).map((j) => j.type)).where({ state: 'failed' }).andWhere('created_at', '>=', midnight));
    // "ClamAV 1.4.1/27744/Thu Sep 19 06:00:00 2026": the engine, then the signature database's number and date.
    const parts = version ? version.split('/') : [];
    return { configured: !!host, host: host ? `${host}:${s.cfg.CLAMD_PORT}` : null, reachable, error, engine: parts[0] ?? null, signatures: parts.length >= 3 ? { version: parts[1], date: parts.slice(2).join('/') } : null, scannedToday: scanned, refusedToday: refused, failedToday: failures };
  }

  /** Runs an item's scan again (503 while ClamAV is configured and does not answer). */
  async rescan(by: OpsActor & { ip?: string | null }, kind: QuarantineKind, id: string): Promise<{ job: string }> {
    const s = this.s();
    const item = (await this.quarantine()).find((q) => q.kind === kind && q.id === id) as { canRescan: boolean; tenantId: string; object: string; workspaceId: string | null; running: boolean } | undefined;
    if (!item) throw notFound('Quarantined object');
    if (!item.canRescan) throw conflict(item.running ? 'The object is being scanned now.' : 'Nothing is held for this object any more: it was refused and its bytes were never stored.');
    if (s.cfg.CLAMD_HOST) {
      const ok = await clamd(s.cfg.CLAMD_HOST, s.cfg.CLAMD_PORT, 'PING').then((a) => a === 'PONG').catch(() => false);
      if (!ok) throw new HttpProblem(503, 'Scanner unavailable', `ClamAV at ${s.cfg.CLAMD_HOST}:${s.cfg.CLAMD_PORT} does not answer; the object stays in quarantine until it does.`, { extensions: { step: 'scanner' } });
    }
    const j = SCAN_JOBS[kind];
    const job = await s.jobs.enqueue({ tenantId: item.tenantId, type: j.type, payload: j.payload(id), createdBy: by.userId, maxAttempts: 2 });
    await s.audit.append({ tenantId: item.tenantId, action: 'file.quarantine.rescanned', kind: 'admin', actor: by.actor, target: { kind, id, ...(item.workspaceId ? { workspace: item.workspaceId } : {}) }, detail: { object: item.object, job: job.id }, traceId: by.traceId ?? null });
    return { job: job.id };
  }

  /** Removes a quarantined object's bytes and refuses it; nothing was ever released, so no file or message changes. */
  async discard(by: OpsActor, kind: QuarantineKind, id: string, reason: string | null): Promise<void> {
    const s = this.s();
    const item = (await this.quarantine()).find((q) => q.kind === kind && q.id === id) as { canDelete: boolean; tenantId: string; object: string; workspaceId: string | null; running: boolean } | undefined;
    if (!item) throw notFound('Quarantined object');
    if (!item.canDelete) throw conflict(item.running ? 'The object is being scanned now; delete it when the scan ends.' : 'Nothing is held for this object any more.');
    const why = `Deleted from quarantine by an administrator${reason ? `: ${reason}` : '.'}`.slice(0, 500);
    const t = Date.now();
    const table = { attachment: 'attachments', file: 'file_versions', knowledge: 'knowledge_documents', media: 'media_assets' }[kind];
    const row = (await s.db(table).where({ id }).first()) as Record<string, unknown>;
    if (row.blob_key) await s.blobs.delete(String(row.blob_key)).catch(() => undefined);
    if (kind === 'attachment') await s.db('attachments').where({ id }).update({ state: 'rejected', reason: why, blob_key: null });
    else if (kind === 'file') {
      await s.db('file_versions').where({ id }).update({ state: 'rejected', reason: why, blob_key: null, sealed_key: null, scanned_at: t });
      await s.db('files').where({ id: String(row.file_id) }).whereNull('current_version').update({ state: 'rejected', updated_at: t });
    } else if (kind === 'knowledge') await s.db('knowledge_documents').where({ id }).update({ state: 'rejected', error: why, blob_key: null, updated_at: t });
    else await s.db('media_assets').where({ id }).update({ state: 'refused', reason: why, blob_key: null });
    await s.audit.append({ tenantId: item.tenantId, action: 'file.quarantine.deleted', kind: 'admin', actor: by.actor, target: { kind, id, ...(item.workspaceId ? { workspace: item.workspaceId } : {}) }, detail: { object: item.object, ...(reason ? { reason } : {}) }, traceId: by.traceId ?? null });
  }

  // ---------- purges ----------

  async purges(): Promise<Record<string, unknown>[]> {
    const s = this.s();
    const c = s.cfg;
    const rows: { what: string; policy: string; where: { route: string; params: Record<string, string>; label: string }; job: string; everyMin: number; setting: string | null }[] = [
      { what: 'File trash', policy: `FILES_TRASH_DAYS = ${c.FILES_TRASH_DAYS}`, where: { route: 'configuration', params: { q: 'FILES_TRASH_DAYS' }, label: 'Configuration' }, job: 'files.purge', everyMin: c.FILES_PURGE_MINUTES, setting: 'FILES_PURGE_MINUTES' },
      { what: 'Conversation retention', policy: 'per workspace and user', where: { route: 'tenants', params: { tab: 'retention' }, label: 'Tenants › Retention' }, job: 'chat.retention', everyMin: c.CHAT_RETENTION_SWEEP_MINUTES, setting: 'CHAT_RETENTION_SWEEP_MINUTES' },
      { what: 'Channel retention', policy: 'per channel', where: { route: 'channels', params: {}, label: 'Channels' }, job: 'channels.retention', everyMin: c.CHANNELS_RETENTION_SWEEP_MINUTES, setting: 'CHANNELS_RETENTION_SWEEP_MINUTES' },
      { what: 'Memory purge', policy: 'per workspace memory policy', where: { route: 'memory', params: {}, label: 'Memory' }, job: 'memory.purge', everyMin: 60, setting: null },
      { what: 'Backup retention', policy: `PLATFORM_BACKUP_RETAIN = ${c.PLATFORM_BACKUP_RETAIN}`, where: { route: 'platform', params: { tab: 'backups' }, label: 'Platform › Backups' }, job: 'ops.backup.create', everyMin: c.PLATFORM_BACKUP_MINUTES, setting: 'PLATFORM_BACKUP_MINUTES' },
      { what: 'Feed indexes', policy: 'each feed generator\'s retention', where: { route: 'atproto', params: { tab: 'feeds' }, label: 'AT-Protocol › Feeds' }, job: 'atproto.feeds.prune', everyMin: c.FEED_PRUNE_MINUTES, setting: 'FEED_PRUNE_MINUTES' },
      { what: 'PDS events and unused blobs', policy: `PDS_BACKFILL_HOURS = ${c.PDS_BACKFILL_HOURS}`, where: { route: 'configuration', params: { q: 'PDS_BACKFILL_HOURS' }, label: 'Configuration' }, job: 'pds.trim', everyMin: 60, setting: null }
    ];
    const out = [];
    for (const r of rows) {
      const last = (await s.db('jobs').where({ type: r.job }).whereIn('state', ['succeeded', 'failed']).orderBy('finished_at', 'desc').first('state', 'result', 'error', 'finished_at')) as { state: string; result: string | null; error: string | null; finished_at: number | string | null } | undefined;
      let removed = '';
      if (last?.state === 'failed') removed = `failed: ${(last.error ?? '').slice(0, 120)}`;
      else if (last?.result) {
        try {
          const v = JSON.parse(last.result) as unknown;
          const flat = (o: unknown, pre = ''): [string, number][] => (o && typeof o === 'object' && !Array.isArray(o) ? Object.entries(o as Record<string, unknown>).flatMap(([k, x]) => (typeof x === 'number' ? [[`${pre}${k}`, x] as [string, number]] : x && typeof x === 'object' && !Array.isArray(x) ? flat(x, `${k} `) : [])) : []);
          removed = flat(v).slice(0, 3).map(([k, x]) => `${k} ${x}`).join(', ') || 'nothing to remove';
        } catch {
          removed = '';
        }
      }
      const every = r.everyMin * 60_000;
      const next = every > 0 ? (Math.floor(Date.now() / every) + 1) * every : null;
      out.push({ what: r.what, policy: r.policy, where: r.where, job: r.job, everyMinutes: r.everyMin, setting: r.setting, lastRun: last?.finished_at ? Number(last.finished_at) : null, lastState: last?.state ?? null, removed, nextRun: next });
    }
    return out;
  }
}

