import { tmpdir } from 'node:os';
import { ulid } from 'ulid';
import { isUniqueViolation, type AuditActor } from '../../audit/chain.js';
import { json } from '../../db/knex.js';
import { badRequest, conflict, HttpProblem, notFound } from '../../http/problem.js';
import type { JobContext } from '../../platform/jobs.js';
import type { Services } from '../../services.js';
import type { LeakedPasswordCheck, LeakedPasswordResult } from '../passwords.js';
import { digestOf, WIDTH, type HashKind, type ImportFormat } from './hashes.js';
import { mirrorChunks, MIRROR_BATCH, RANGE_PREFIXES, runMirror } from './mirror.js';
import { build, ShardCache, stage, stagingKey, VersionReader, type StageCounts } from './store.js';

/*
 * 1.9.0, Sprint 55 (B-192, B-193): leaked-password lists and the checks against them, `s.leakedPasswords`.
 *
 * Lists (B-192)
 *   - A list is platform-wide (`platform:manage`) or a tenant's own (`identity:manage`: the Identity admin and Tenant
 *     admin roles hold it, the permission that already governs the tenant's user stores and sign-in). Its hash kind,
 *     SHA-1 or NTLM, is fixed when it is made.
 *   - Each import is a new version: staged (the upload parsed to binary digests as it streams in; plain text is hashed
 *     line by line and never stored), then built by the job `passwords.list.build` (sorted, de-duplicated, sharded by
 *     prefix, a Bloom filter in front: `store.ts`). A built version becomes the active one unless the import said not
 *     to; `activate` points the list at any built version, which is both "replace" and "roll back".
 *   - An HIBP mirror (`passwords.list.mirror`) fetches the whole corpus through the range API into a version; it is an
 *     explicit platform action, rate-limited and resumable (`mirror.ts`).
 *
 * Checks (B-193)
 *   - `check(tenantId, password)` asks every enabled list that applies (the platform's and the tenant's), then the
 *     `BREACHED_*` sources exactly as before (HIBP online and the local file, `s.account.breached`). The answer is only
 *     found, not found, or unavailable, with the action the tenant's settings require: a found password is refused; an
 *     unavailable check is accepted (fail-open, the default, as before) or refused (fail-closed), and audited as
 *     `password.breach_check.unavailable` as before. It never names the list or a count.
 *   - `atSignIn` checks a signing-in password against the list versions added since the account was last checked, and
 *     returns what the tenant chose for a newly listed password: warn, require a change (the default) or block.
 *   - No lists (or the migration not applied yet) means exactly the `BREACHED_*` behaviour of before.
 */

export const BUILD_JOB = 'passwords.list.build';
export const MIRROR_JOB = 'passwords.list.mirror';
export const LISTS_CHANGED = 'passwords.lists.changed';
export const SETTINGS_CHANGED = 'passwords.settings.changed';
export const SIGNIN_ACTIONS = ['warn', 'require_change', 'block'] as const;
export type SignInAction = (typeof SIGNIN_ACTIONS)[number];
export const FAIL_MODES = ['open', 'closed'] as const;
export type FailMode = (typeof FAIL_MODES)[number];
export type ListScope = 'platform' | 'tenant';
const PLATFORM = 'platform';
const CACHE_MS = 15_000;
const SCHEMA_RECHECK_MS = 30_000;

export const LEAKED_MESSAGE = 'This password appears in a list of leaked passwords. Choose another.';
/** What the BREACHED_* check has always said (`account.ts` before 1.9.0). */
export const BREACHED_MESSAGE = 'This password appears in a public list of breached passwords. Choose another.';

export interface ListRow {
  id: string;
  owner: string;
  tenant_id: string | null;
  name: string;
  description: string | null;
  hash_kind: HashKind;
  source: string;
  enabled: boolean;
  active_version: number | null;
  latest_version: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface VersionRow {
  id: string;
  list_id: string;
  version: number;
  state: 'staging' | 'queued' | 'building' | 'mirroring' | 'ready' | 'failed';
  format: string;
  source: string;
  note: string | null;
  activate: boolean;
  lines_read: number;
  invalid: number;
  duplicates: number;
  entries: number;
  bytes: number;
  bloom_bits: number;
  bloom_hashes: number;
  fp_rate: number;
  prefix_len: number;
  blob_prefix: string;
  mirror_cursor: number | null;
  mirror_total: number | null;
  job_id: string | null;
  error: string | null;
  created_by: string | null;
  created_at: number;
  built_at: number | null;
}

export interface LeakedSettings {
  signinAction: SignInAction;
  failMode: FailMode;
  denyWords: string[];
  denyTermList: string | null;
  updatedAt: number | null;
}

export const DEFAULT_SETTINGS: LeakedSettings = { signinAction: 'require_change', failMode: 'open', denyWords: [], denyTermList: null, updatedAt: null };

/** What `check` answers: only found / not found / unavailable, and the action the tenant's settings require. */
/**
 * What `check` and `atSignIn` answer: Agent B's `LeakedPasswordResult` (`identity/passwords.ts`): found or not with
 * the action (`block`, `warn`, `require_change`, `accept`), or unavailable with the fail mode's action. Never which
 * list or how often.
 */
export type LeakedCheck = LeakedPasswordResult & {
  /** Unavailable: what could not be checked (source kinds and list version ids, for the audit; never shown). */
  sources?: { source: string; reason: string; version?: string }[];
  /**
   * Found: `list` (one of the leaked-password lists) or `breached` (the BREACHED_* sources, HIBP online or the local
   * file), so the pipeline can keep the `reason: breached` code it always returned for those. Never which list.
   */
  source?: 'list' | 'breached';
};

export interface CheckContext {
  username?: string | null;
  actor?: AuditActor | null;
  traceId?: string | null;
}

export interface Actor {
  tenantId: string;
  userId: string | null;
  audit: AuditActor;
  traceId?: string | null;
  /** Whether the caller holds platform:manage (platform lists) and identity:manage (the tenant's lists). */
  platform: boolean;
  identity: boolean;
}

const num = (v: unknown): number => Number(v ?? 0);
const listFrom = (r: Record<string, unknown>): ListRow => ({ ...(r as unknown as ListRow), enabled: !!r.enabled, active_version: r.active_version == null ? null : num(r.active_version), latest_version: num(r.latest_version), created_at: num(r.created_at), updated_at: num(r.updated_at) });
const versionFrom = (r: Record<string, unknown>): VersionRow => ({
  ...(r as unknown as VersionRow),
  activate: !!r.activate,
  version: num(r.version), lines_read: num(r.lines_read), invalid: num(r.invalid), duplicates: num(r.duplicates), entries: num(r.entries), bytes: num(r.bytes),
  bloom_bits: num(r.bloom_bits), bloom_hashes: num(r.bloom_hashes), fp_rate: num(r.fp_rate), prefix_len: num(r.prefix_len),
  mirror_cursor: r.mirror_cursor == null ? null : num(r.mirror_cursor), mirror_total: r.mirror_total == null ? null : num(r.mirror_total),
  created_at: num(r.created_at), built_at: r.built_at == null ? null : num(r.built_at)
});

/** Mirror batches: fixed by the number of prefixes, so a resumed mirror cuts the same batches. */
export const batchFor = (total: number): number => (total >= MIRROR_BATCH * 4 ? MIRROR_BATCH : Math.max(1, Math.ceil(total / 8)));

const notInstalled = () => new HttpProblem(503, 'Not installed', 'Leaked-password lists need the database migration 131_leaked_password_lists, which has not been applied.', { extensions: { reason: 'migration_pending' } });

export class LeakedPasswords implements LeakedPasswordCheck {
  private schema: { ok: boolean; at: number } | null = null;
  private shardCache: ShardCache | null = null;
  private readonly readers = new Map<string, Promise<VersionReader>>();
  private active: { at: number; byOwner: Map<string, { id: string; kind: HashKind; blobPrefix: string; prefixLen: number; shards: string[] }[]> } | null = null;
  private readonly settingsCache = new Map<string, { at: number; v: LeakedSettings }>();
  private listening = false;

  constructor(private readonly s: () => Services) {}

  private get cache(): ShardCache {
    return (this.shardCache ??= new ShardCache(this.s().cfg.LEAKED_CACHE_MB * 1024 * 1024));
  }

  private get db() {
    return this.s().db;
  }

  /** Whether migration 131 is applied; negative answers are re-checked every 30 s, so applying it needs no restart. */
  async installed(): Promise<boolean> {
    const t = Date.now();
    if (this.schema && (this.schema.ok || t - this.schema.at < SCHEMA_RECHECK_MS)) return this.schema.ok;
    let ok: boolean;
    try {
      ok = (await this.db.schema.hasTable('leaked_password_lists')) && (await this.db.schema.hasTable('leaked_password_settings'));
    } catch {
      ok = false;
    }
    this.schema = { ok, at: t };
    return ok;
  }

  /** Forgets the cached schema answer (tests apply the migration by hand). */
  resetSchemaCache(): void {
    this.schema = null;
    this.active = null;
    this.settingsCache.clear();
  }

  private async need(): Promise<void> {
    if (!(await this.installed())) throw notInstalled();
  }

  listen(): void {
    if (this.listening) return;
    this.listening = true;
    this.s().bus.on(LISTS_CHANGED, () => {
      this.active = null;
    });
    this.s().bus.on<{ tenantId: string }>(SETTINGS_CHANGED, ({ tenantId }) => {
      this.settingsCache.delete(tenantId);
      this.s().passwordDenyWords.forget(tenantId);
    });
  }

  private changed(): void {
    this.active = null;
    this.s().bus.publish(LISTS_CHANGED, {});
  }

  registerJobs(): void {
    this.listen();
    this.s().jobs.register(BUILD_JOB, async (p, ctx) => this.runBuild(String(p.versionId), ctx), { timeoutMs: 6 * 3600_000 });
    this.s().jobs.register(MIRROR_JOB, async (p, ctx) => this.runMirrorJob(String(p.versionId), ctx), { timeoutMs: 7 * 24 * 3600_000 });
  }

  // ---------- lists ----------

  private ownerOf(scope: ListScope, tenantId: string): string {
    return scope === 'platform' ? PLATFORM : tenantId;
  }

  private assertScope(a: Actor, scope: ListScope): void {
    if (scope === 'platform' && !a.platform) throw new HttpProblem(403, 'Forbidden', 'Platform lists need platform:manage.', { extensions: { action: 'platform:manage' } });
    if (scope === 'tenant' && !a.identity) throw new HttpProblem(403, 'Forbidden', 'This tenant\'s lists need identity:manage.', { extensions: { action: 'identity:manage' } });
  }

  async lists(a: Actor, scope: ListScope): Promise<{ lists: (ListRow & { activeEntries: number | null; versions: number })[]; platformLists: number }> {
    if (!(await this.installed())) return { lists: [], platformLists: 0 };
    this.assertScope(a, scope);
    const rows = ((await this.db('leaked_password_lists').where({ owner: this.ownerOf(scope, a.tenantId) }).orderBy('name')) as Record<string, unknown>[]).map(listFrom);
    const ids = rows.map((r) => r.id);
    const versions = ids.length ? ((await this.db('leaked_password_versions').whereIn('list_id', ids).select('list_id', 'version', 'entries', 'state')) as { list_id: string; version: number; entries: number; state: string }[]) : [];
    const platformLists = scope === 'tenant' ? num(((await this.db('leaked_password_lists').where({ owner: PLATFORM, enabled: true }).whereNotNull('active_version').count({ n: '*' })) as { n: unknown }[])[0]?.n) : 0;
    return {
      lists: rows.map((l) => {
        const mine = versions.filter((v) => v.list_id === l.id);
        const act = mine.find((v) => num(v.version) === l.active_version && v.state === 'ready');
        return { ...l, activeEntries: act ? num(act.entries) : null, versions: mine.length };
      }),
      platformLists
    };
  }

  async getList(a: Actor, id: string): Promise<ListRow> {
    await this.need();
    const r = (await this.db('leaked_password_lists').where({ id }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('List');
    const l = listFrom(r);
    if (l.owner !== PLATFORM && l.owner !== a.tenantId) throw notFound('List');
    this.assertScope(a, l.owner === PLATFORM ? 'platform' : 'tenant');
    return l;
  }

  async versions(listId: string): Promise<VersionRow[]> {
    return ((await this.db('leaked_password_versions').where({ list_id: listId }).orderBy('version', 'desc')) as Record<string, unknown>[]).map(versionFrom);
  }

  async version(listId: string, version: number): Promise<VersionRow> {
    const r = (await this.db('leaked_password_versions').where({ list_id: listId, version }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Version');
    return versionFrom(r);
  }

  private async audit(a: Actor, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>): Promise<void> {
    await this.s().audit.append({ tenantId: a.tenantId, action, kind: 'admin', actor: a.audit, target, ...(detail ? { detail } : {}), ...(a.traceId ? { traceId: a.traceId } : {}) });
  }

  async create(a: Actor, input: { scope: ListScope; name: string; description?: string | null; hashKind: HashKind; source?: string }): Promise<ListRow> {
    await this.need();
    this.assertScope(a, input.scope);
    const t = Date.now();
    const row = { id: ulid(), owner: this.ownerOf(input.scope, a.tenantId), tenant_id: input.scope === 'platform' ? null : a.tenantId, name: input.name, description: input.description ?? null, hash_kind: input.hashKind, source: input.source ?? 'upload', enabled: true, active_version: null, latest_version: 0, created_by: a.userId, created_at: t, updated_at: t };
    try {
      await this.db('leaked_password_lists').insert(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A list named ${input.name} already exists here.`);
      throw err;
    }
    await this.audit(a, 'passwords.list.created', { list: row.id, name: row.name }, { scope: input.scope, hashKind: row.hash_kind });
    return listFrom(row as unknown as Record<string, unknown>);
  }

  async update(a: Actor, id: string, patch: { enabled?: boolean; description?: string | null }): Promise<ListRow> {
    const l = await this.getList(a, id);
    const set: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.description !== undefined) set.description = patch.description;
    await this.db('leaked_password_lists').where({ id }).update(set);
    await this.audit(a, 'passwords.list.updated', { list: id, name: l.name }, { ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}), ...(patch.description !== undefined ? { description: true } : {}) });
    this.changed();
    return this.getList(a, id);
  }

  async remove(a: Actor, id: string): Promise<void> {
    const l = await this.getList(a, id);
    const vs = await this.versions(id);
    if (vs.some((v) => v.state === 'building' || v.state === 'mirroring')) throw conflict('A version of this list is still being built. Wait for it, or cancel its job, first.');
    await this.db.transaction(async (trx) => {
      const vids = vs.map((v) => v.id);
      if (vids.length) await trx('leaked_password_shards').whereIn('version_id', vids).delete();
      await trx('leaked_password_versions').where({ list_id: id }).delete();
      await trx('leaked_password_lists').where({ id }).delete();
    });
    for (const v of vs) await this.dropBlobs(v);
    await this.audit(a, 'passwords.list.deleted', { list: id, name: l.name }, { versions: vs.length });
    this.changed();
  }

  private async dropBlobs(v: VersionRow): Promise<void> {
    this.cache.dropPrefix(v.blob_prefix + '/');
    this.readers.delete(v.id);
    await this.s().blobs.deletePrefix(v.blob_prefix).catch(() => undefined);
  }

  private async newVersion(l: ListRow, input: { format: string; source: string; note?: string | null; activate?: boolean; createdBy: string | null; state: VersionRow['state']; mirrorTotal?: number }): Promise<VersionRow> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const fresh = listFrom((await this.db('leaked_password_lists').where({ id: l.id }).first()) as Record<string, unknown>);
      const version = fresh.latest_version + 1;
      const id = ulid();
      const row = {
        id, list_id: l.id, version, state: input.state, format: input.format, source: input.source, note: input.note ?? null, activate: input.activate ?? true,
        blob_prefix: `leaked-passwords/${l.id}/${id}`, prefix_len: 2, created_by: input.createdBy, created_at: Date.now(),
        ...(input.mirrorTotal != null ? { mirror_cursor: 0, mirror_total: input.mirrorTotal } : {})
      };
      try {
        await this.db.transaction(async (trx) => {
          const n = await trx('leaked_password_lists').where({ id: l.id, latest_version: fresh.latest_version }).update({ latest_version: version, updated_at: Date.now() });
          if (!n) throw Object.assign(new Error('raced'), { raced: true });
          await trx('leaked_password_versions').insert(row);
        });
        return versionFrom(row as unknown as Record<string, unknown>);
      } catch (err) {
        if ((err as { raced?: boolean }).raced || isUniqueViolation(err)) continue;
        throw err;
      }
    }
    throw conflict('Another import of this list started at the same time. Try again.');
  }

  /**
   * Stages an import as it streams in (only digests reach the blob store), then queues the build. `inline` builds at
   * once in this process instead (the CLI), reporting progress through `onProgress`.
   */
  async upload(a: Actor, listId: string, input: { format: ImportFormat; source: AsyncIterable<Buffer | Uint8Array | string>; note?: string | null; activate?: boolean; via: 'console' | 'api' | 'cli'; maxBytes?: number; inline?: { onProgress(pct: number, message: string): void } }): Promise<{ version: VersionRow; counts: StageCounts; jobId: string | null }> {
    const l = await this.getList(a, listId);
    const v = await this.newVersion(l, { format: input.format, source: input.via, note: input.note ?? null, activate: input.activate ?? true, createdBy: a.userId, state: 'staging' });
    let counts: StageCounts;
    try {
      counts = await stage(this.s().blobs, stagingKey(v.blob_prefix), { format: input.format, kind: l.hash_kind, source: input.source, maxBytes: input.maxBytes ?? (input.via === 'cli' ? Number.MAX_SAFE_INTEGER : this.s().cfg.LEAKED_UPLOAD_MAX_BYTES) });
    } catch (err) {
      await this.fail(v, (err as Error).message);
      await this.audit(a, 'passwords.list.failed', { list: l.id, name: l.name, version: v.version }, { stage: 'upload', error: (err as Error).message.slice(0, 300) });
      if ((err as { code?: string }).code === 'too_large') throw new HttpProblem(413, 'Payload too large', (err as Error).message);
      throw err;
    }
    await this.db('leaked_password_versions').where({ id: v.id }).update({ lines_read: counts.lines, invalid: counts.invalid, state: 'queued' });
    await this.audit(a, 'passwords.list.uploaded', { list: l.id, name: l.name, version: v.version }, { format: input.format, via: input.via, lines: counts.lines, invalid: counts.invalid, digests: counts.records, bytes: counts.bytes, activate: input.activate ?? true });
    if (input.inline) {
      await this.runBuild(v.id, { progress: async (pct, m) => input.inline!.onProgress(pct, m ?? ''), signal: new AbortController().signal, tenantId: a.tenantId });
      return { version: await this.version(l.id, v.version), counts, jobId: null };
    }
    const job = await this.s().jobs.enqueue({ tenantId: a.tenantId, type: BUILD_JOB, payload: { versionId: v.id }, createdBy: a.userId, dedupeKey: `${BUILD_JOB}:${v.id}`, maxAttempts: 2 });
    await this.db('leaked_password_versions').where({ id: v.id }).update({ job_id: job.id });
    return { version: { ...v, state: 'queued', lines_read: counts.lines, invalid: counts.invalid, job_id: job.id }, counts, jobId: job.id };
  }

  private async fail(v: VersionRow, message: string): Promise<void> {
    await this.db('leaked_password_versions').where({ id: v.id }).update({ state: 'failed', error: message.slice(0, 500) });
    await this.s().blobs.deletePrefix(`${v.blob_prefix}/shards`).catch(() => undefined);
  }

  private async versionById(id: string): Promise<{ v: VersionRow; l: ListRow }> {
    const r = (await this.db('leaked_password_versions').where({ id }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Version');
    const v = versionFrom(r);
    const l = listFrom((await this.db('leaked_password_lists').where({ id: v.list_id }).first()) as Record<string, unknown>);
    return { v, l };
  }

  private buildOpts(l: ListRow, v: VersionRow, total: number, ctx: { progress(pct: number, m: string): Promise<void>; signal?: AbortSignal }) {
    const cfg = this.s().cfg;
    return { blobs: this.s().blobs, kind: l.hash_kind, blobPrefix: v.blob_prefix, total, fpRate: cfg.LEAKED_BLOOM_FP_RATE, bloomMaxBytes: cfg.LEAKED_BLOOM_MAX_MB * 1024 * 1024, workDir: cfg.LEAKED_WORK_DIR ?? tmpdir(), progress: ctx.progress, ...(ctx.signal ? { signal: ctx.signal } : {}) };
  }

  /** The build job: staged digests → shards and filter; then the version is ready and, if asked, active. */
  async runBuild(versionId: string, ctx: Pick<JobContext, 'progress' | 'signal'> & { tenantId?: string }, mirror = false): Promise<{ entries: number; duplicates: number }> {
    const { v, l } = await this.versionById(versionId);
    if (v.state === 'ready') return { entries: v.entries, duplicates: v.duplicates };
    const width = WIDTH[l.hash_kind];
    await this.db('leaked_password_versions').where({ id: v.id }).update({ state: 'building', error: null });
    await this.s().blobs.deletePrefix(`${v.blob_prefix}/shards`).catch(() => undefined);
    try {
      let source: AsyncIterable<Buffer>;
      let total: number;
      if (mirror) {
        const m = await mirrorChunks(this.s().blobs, v.blob_prefix, v.mirror_total ?? RANGE_PREFIXES, batchFor(v.mirror_total ?? RANGE_PREFIXES));
        source = m.stream;
        total = m.bytes / width;
      } else {
        const st = await this.s().blobs.getStream(stagingKey(v.blob_prefix));
        if (!st) throw new Error('The staged import is missing; upload the list again');
        source = st.stream as AsyncIterable<Buffer>;
        total = st.size / width;
      }
      const r = await build(source, { ...this.buildOpts(l, v, total, ctx), sorted: mirror });
      await this.db.transaction(async (trx) => {
        await trx('leaked_password_shards').where({ version_id: v.id }).delete();
        for (let i = 0; i < r.shards.length; i += 500) await trx('leaked_password_shards').insert(r.shards.slice(i, i + 500).map((sh) => ({ version_id: v.id, prefix: sh.prefix, entries: sh.entries, bytes: sh.bytes })));
        await trx('leaked_password_versions').where({ id: v.id }).update({ state: 'ready', entries: r.entries, duplicates: r.duplicates, bytes: r.bytes, bloom_bits: r.bloom.bits, bloom_hashes: r.bloom.hashes, fp_rate: r.bloom.rate, prefix_len: r.prefixLen, built_at: Date.now(), error: null, ...(mirror ? { lines_read: r.entries + r.duplicates } : {}) });
        if (v.activate) await trx('leaked_password_lists').where({ id: l.id }).update({ active_version: v.version, updated_at: Date.now() });
      });
      if (mirror) await this.s().blobs.deletePrefix(`${v.blob_prefix}/staging`).catch(() => undefined);
      else await this.s().blobs.delete(stagingKey(v.blob_prefix)).catch(() => undefined);
      const tenantId = ctx.tenantId ?? l.tenant_id ?? (await this.s().tenants.bySlug(this.s().cfg.DEFAULT_TENANT))?.id;
      if (tenantId) {
        await this.s().audit.append({ tenantId, action: 'passwords.list.built', kind: 'system', actor: { service: 'leaked-passwords' }, target: { list: l.id, name: l.name, version: v.version }, detail: { entries: r.entries, duplicates: r.duplicates, shards: r.shards.length, prefixLen: r.prefixLen, bloomBits: r.bloom.bits, fpRate: r.bloom.rate, activated: v.activate } });
        if (v.activate) await this.s().audit.append({ tenantId, action: 'passwords.list.activated', kind: 'system', actor: { service: 'leaked-passwords' }, target: { list: l.id, name: l.name, version: v.version }, detail: { previous: l.active_version } });
      }
      this.changed();
      await ctx.progress(100, `${r.entries} hashes in ${r.shards.length} shards`);
      return { entries: r.entries, duplicates: r.duplicates };
    } catch (err) {
      await this.fail(v, (err as Error).message);
      const tenantId = ctx.tenantId ?? l.tenant_id;
      if (tenantId) await this.s().audit.append({ tenantId, action: 'passwords.list.failed', kind: 'system', actor: { service: 'leaked-passwords' }, target: { list: l.id, name: l.name, version: v.version }, detail: { stage: 'build', error: (err as Error).message.slice(0, 300) } });
      throw err;
    }
  }

  /** Starts (or resumes) an HIBP mirror into a new version of a platform list. */
  async startMirror(a: Actor, listId: string, opts: { note?: string | null; activate?: boolean; total?: number } = {}): Promise<{ version: VersionRow; jobId: string }> {
    const l = await this.getList(a, listId);
    if (l.owner !== PLATFORM) throw badRequest('Only a platform list can hold an HIBP mirror.');
    const running = (await this.versions(l.id)).find((v) => v.state === 'mirroring' || (v.state === 'failed' && v.mirror_total != null && (v.mirror_cursor ?? 0) < v.mirror_total));
    if (running) return this.resumeMirror(a, l, running);
    const v = await this.newVersion(l, { format: 'hibp', source: 'hibp-mirror', note: opts.note ?? null, activate: opts.activate ?? true, createdBy: a.userId, state: 'mirroring', mirrorTotal: Math.min(RANGE_PREFIXES, Math.max(1, opts.total ?? RANGE_PREFIXES)) });
    const job = await this.s().jobs.enqueue({ tenantId: a.tenantId, type: MIRROR_JOB, payload: { versionId: v.id }, createdBy: a.userId, dedupeKey: `${MIRROR_JOB}:${v.id}:0`, maxAttempts: 5 });
    await this.db('leaked_password_versions').where({ id: v.id }).update({ job_id: job.id });
    await this.audit(a, 'passwords.list.mirror.started', { list: l.id, name: l.name, version: v.version }, { url: this.s().cfg.BREACHED_HIBP_URL, prefixes: v.mirror_total, rps: this.s().cfg.LEAKED_MIRROR_RPS });
    return { version: { ...v, job_id: job.id }, jobId: job.id };
  }

  private async resumeMirror(a: Actor, l: ListRow, v: VersionRow): Promise<{ version: VersionRow; jobId: string }> {
    if (v.job_id) {
      const j = await this.s().jobs.get(a.tenantId, v.job_id);
      if (j && (j.state === 'queued' || j.state === 'running')) return { version: v, jobId: j.id };
    }
    await this.db('leaked_password_versions').where({ id: v.id }).update({ state: 'mirroring', error: null });
    const job = await this.s().jobs.enqueue({ tenantId: a.tenantId, type: MIRROR_JOB, payload: { versionId: v.id }, createdBy: a.userId, dedupeKey: `${MIRROR_JOB}:${v.id}:${Date.now()}`, maxAttempts: 5 });
    await this.db('leaked_password_versions').where({ id: v.id }).update({ job_id: job.id });
    await this.audit(a, 'passwords.list.mirror.resumed', { list: l.id, name: l.name, version: v.version }, { cursor: v.mirror_cursor, prefixes: v.mirror_total });
    return { version: { ...v, state: 'mirroring', job_id: job.id }, jobId: job.id };
  }

  /** The mirror job: fetch from the cursor, then build from the chunks in order. */
  async runMirrorJob(versionId: string, ctx: Pick<JobContext, 'progress' | 'signal'> & { tenantId?: string; fetch?: typeof fetch }): Promise<{ entries: number; duplicates: number }> {
    const { v, l } = await this.versionById(versionId);
    if (v.state === 'ready') return { entries: v.entries, duplicates: v.duplicates };
    const total = v.mirror_total ?? RANGE_PREFIXES;
    const cfg = this.s().cfg;
    let read = v.lines_read;
    await this.db('leaked_password_versions').where({ id: v.id }).update({ state: 'mirroring', error: null });
    try {
      await runMirror({
        baseUrl: cfg.BREACHED_HIBP_URL, kind: l.hash_kind, blobs: this.s().blobs, blobPrefix: v.blob_prefix, rps: cfg.LEAKED_MIRROR_RPS, timeoutMs: cfg.BREACHED_TIMEOUT_MS,
        cursor: v.mirror_cursor ?? 0, total, batch: batchFor(total), ...(ctx.signal ? { signal: ctx.signal } : {}), ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
        advanced: async (cursor, records) => {
          read += records;
          await this.db('leaked_password_versions').where({ id: v.id }).update({ mirror_cursor: cursor, lines_read: read });
          await ctx.progress(Math.floor((cursor / total) * 80), `Fetched ${cursor} of ${total} ranges`);
        }
      });
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      await this.db('leaked_password_versions').where({ id: v.id }).update({ state: 'failed', error: `Stopped: ${message}`.slice(0, 500) });
      const tenantId = ctx.tenantId ?? (await this.s().tenants.bySlug(cfg.DEFAULT_TENANT))?.id;
      if (tenantId) await this.s().audit.append({ tenantId, action: 'passwords.list.failed', kind: 'system', actor: { service: 'leaked-passwords' }, target: { list: l.id, name: l.name, version: v.version }, detail: { stage: 'mirror', cursor: (await this.versionById(v.id)).v.mirror_cursor, error: message.slice(0, 300) } });
      throw err;
    }
    return this.runBuild(v.id, { progress: (pct, m) => ctx.progress(80 + Math.floor(pct / 5), m), signal: ctx.signal, ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}) }, true);
  }

  /** Points the list at a built version: replacing the active one, or rolling back to an older one. */
  async activate(a: Actor, listId: string, version: number): Promise<ListRow> {
    const l = await this.getList(a, listId);
    const v = await this.version(listId, version);
    if (v.state !== 'ready') throw conflict(`Version ${version} is ${v.state}; only a built version can be made active.`);
    await this.db('leaked_password_lists').where({ id: listId }).update({ active_version: version, updated_at: Date.now() });
    await this.audit(a, 'passwords.list.activated', { list: l.id, name: l.name, version }, { previous: l.active_version, rollback: l.active_version != null && version < l.active_version });
    this.changed();
    return this.getList(a, listId);
  }

  async removeVersion(a: Actor, listId: string, version: number): Promise<void> {
    const l = await this.getList(a, listId);
    const v = await this.version(listId, version);
    if (l.active_version === version) throw conflict('This is the active version. Make another one active first.');
    if (v.state === 'building' || v.state === 'mirroring') throw conflict('This version is still being built.');
    await this.db.transaction(async (trx) => {
      await trx('leaked_password_shards').where({ version_id: v.id }).delete();
      await trx('leaked_password_versions').where({ id: v.id }).delete();
    });
    await this.dropBlobs(v);
    await this.audit(a, 'passwords.list.version.deleted', { list: l.id, name: l.name, version });
  }

  // ---------- reading ----------

  /** The active, built versions of enabled lists, by owner (cached; dropped on any list change, on every instance). */
  private async activeByOwner(): Promise<Map<string, { id: string; kind: HashKind; blobPrefix: string; prefixLen: number; shards: string[] }[]>> {
    const t = Date.now();
    if (this.active && t - this.active.at < CACHE_MS) return this.active.byOwner;
    const rows = (await this.db('leaked_password_lists as l')
      .join('leaked_password_versions as v', function () {
        this.on('v.list_id', '=', 'l.id').andOn('v.version', '=', 'l.active_version');
      })
      .where('l.enabled', true)
      .where('v.state', 'ready')
      .select('l.owner', 'l.hash_kind', 'v.id', 'v.blob_prefix', 'v.prefix_len')) as { owner: string; hash_kind: HashKind; id: string; blob_prefix: string; prefix_len: number }[];
    const shards = rows.length ? ((await this.db('leaked_password_shards').whereIn('version_id', rows.map((r) => r.id)).select('version_id', 'prefix')) as { version_id: string; prefix: string }[]) : [];
    const byVersion = new Map<string, string[]>();
    for (const sh of shards) (byVersion.get(sh.version_id) ?? byVersion.set(sh.version_id, []).get(sh.version_id)!).push(sh.prefix);
    const byOwner = new Map<string, { id: string; kind: HashKind; blobPrefix: string; prefixLen: number; shards: string[] }[]>();
    for (const r of rows) (byOwner.get(r.owner) ?? byOwner.set(r.owner, []).get(r.owner)!).push({ id: r.id, kind: r.hash_kind, blobPrefix: r.blob_prefix, prefixLen: num(r.prefix_len), shards: byVersion.get(r.id) ?? [] });
    const live = new Set(rows.map((r) => r.id));
    for (const id of this.readers.keys()) if (!live.has(id)) this.readers.delete(id);
    this.active = { at: t, byOwner };
    return byOwner;
  }

  /** The versions a tenant's checks use: the platform's enabled lists and the tenant's own. */
  async versionsFor(tenantId: string): Promise<{ id: string; kind: HashKind; blobPrefix: string; prefixLen: number; shards: string[] }[]> {
    if (!(await this.installed())) return [];
    const m = await this.activeByOwner();
    return [...(m.get(PLATFORM) ?? []), ...(m.get(tenantId) ?? [])];
  }

  private reader(v: { id: string; kind: HashKind; blobPrefix: string; prefixLen: number; shards: string[] }): Promise<VersionReader> {
    let r = this.readers.get(v.id);
    if (!r) {
      r = VersionReader.open(this.s().blobs, this.cache, v);
      r.catch(() => this.readers.delete(v.id));
      this.readers.set(v.id, r);
    }
    return r;
  }

  /** Whether any of these versions holds the password; `unavailable` lists the versions that could not be read. */
  private async inVersions(vs: { id: string; kind: HashKind; blobPrefix: string; prefixLen: number; shards: string[] }[], password: string): Promise<{ found: boolean; unavailable: { version: string; reason: string }[] }> {
    const unavailable: { version: string; reason: string }[] = [];
    const digests = new Map<HashKind, Buffer>();
    for (const v of vs) {
      try {
        const d = digests.get(v.kind) ?? digests.set(v.kind, digestOf(v.kind, password)).get(v.kind)!;
        if (await (await this.reader(v)).has(d)) return { found: true, unavailable };
      } catch (err) {
        unavailable.push({ version: v.id, reason: (err as Error).message.slice(0, 200) });
      }
    }
    return { found: false, unavailable };
  }

  // ---------- B-193: checking ----------

  /**
   * The leaked-password check for a new password (set, reset, import and admin set), as `SigninPolicies.
   * checkNewPassword` (Agent B's pipeline, `identity/signin-policy.ts`) calls it after the policy and the deny words.
   * Every enabled list, then the `BREACHED_*` sources as before. Found: `block`. Unavailable: the tenant's fail mode,
   * `accept` (open, the default, as before) or `block` (closed); the pipeline audits the miss as
   * `password.breach_check.unavailable` (pass `{ audit: true }` to have it audited here instead). Never says which
   * list or how often; `sources` (for that audit) names the source kinds and list version ids only.
   */
  async check(tenantId: string, password: string, ctx: CheckContext & { audit?: boolean } = {}): Promise<LeakedCheck> {
    const settings = await this.settings(tenantId);
    const lists = await this.inVersions(await this.versionsFor(tenantId), password);
    if (lists.found) return { found: true, action: 'block', message: LEAKED_MESSAGE, source: 'list' };
    const sources: { source: string; reason: string; version?: string }[] = lists.unavailable.map((u) => ({ source: 'list', version: u.version, reason: u.reason }));
    const r = await this.s().account.breached.check(password);
    // The BREACHED_* sources answer as they always did (same message), so a hit there reads as before.
    if (r.breached) return { found: true, action: 'block', message: BREACHED_MESSAGE, source: 'breached' };
    for (const u of r.unavailable ?? []) sources.push(u);
    if (!sources.length) return { found: false, action: 'accept' };
    const closed = settings.failMode === 'closed';
    if (ctx.audit) {
      await this.s().audit.append({
        tenantId,
        action: 'password.breach_check.unavailable',
        kind: 'auth',
        actor: ctx.actor ?? (ctx.username ? { username: ctx.username } : { service: 'leaked-passwords' }),
        target: ctx.username ? { username: ctx.username } : {},
        detail: { sources, failMode: settings.failMode, note: closed ? 'The leaked-password check failed closed: the password was refused.' : 'The breached-password check failed open: the password was accepted without it.' },
        ...(ctx.traceId ? { traceId: ctx.traceId } : {})
      });
    }
    return { unavailable: true, action: closed ? 'block' : 'accept', reason: sources.map((x) => `${x.source}: ${x.reason}`).join('; ').slice(0, 300), sources };
  }

  /** `check` (audited here), throwing the problem a route returns: 400 `leaked` when found, 503 when it fails closed. */
  async assertNotLeaked(tenantId: string, password: string, ctx: CheckContext = {}): Promise<void> {
    const r = await this.check(tenantId, password, { ...ctx, audit: true });
    if (r.action === 'accept') return;
    if ('found' in r) throw badRequest(r.message ?? LEAKED_MESSAGE, { reason: r.source === 'breached' ? 'breached' : 'leaked' });
    throw new HttpProblem(503, 'Check unavailable', 'The leaked-password check is unavailable, and this organisation does not accept a password without it. Try again later.', { extensions: { reason: 'leaked_unavailable' } });
  }

  /**
   * After a checked password is saved (set, reset, invitation, sign-up, admin create or set, import): records the
   * account as checked against the list versions that were active when the check ran, so the next sign-in only
   * looks at versions added since. `checkedAt` is when the check started: a list changed after it (a new or
   * re-activated version, turned on) is left out and so checked at the next sign-in. A flag stays for the report.
   * Never fails the save: an error is logged and the sign-in checks every list instead.
   */
  async markChecked(tenantId: string, userId: string, checkedAt = Date.now()): Promise<void> {
    try {
      if (!(await this.installed())) return;
      const rows = (await this.db('leaked_password_lists as l')
        .join('leaked_password_versions as v', function () {
          this.on('v.list_id', '=', 'l.id').andOn('v.version', '=', 'l.active_version');
        })
        .where('l.enabled', true)
        .where('v.state', 'ready')
        .whereIn('l.owner', [PLATFORM, tenantId])
        .where('l.updated_at', '<=', checkedAt)
        .select('v.id')) as { id: string }[];
      if (!rows.length && !(await this.db('leaked_password_checks').where({ user_id: userId }).first('user_id'))) return;
      await this.saveCheck(tenantId, userId, rows.map((r) => r.id), null, true);
    } catch (err) {
      this.s().log.warn({ err: (err as Error).message }, 'could not record the leaked-password check of a new password');
    }
  }

  private async saveCheck(tenantId: string, userId: string, versions: string[], flag: { at: number; action: SignInAction } | null, keepFlag = false): Promise<void> {
    const row = { user_id: userId, tenant_id: tenantId, checked_at: Date.now(), versions: JSON.stringify(versions), ...(keepFlag ? {} : { flagged_at: flag?.at ?? null, flag_action: flag?.action ?? null }) };
    const n = await this.db('leaked_password_checks').where({ user_id: userId }).update(row);
    if (!n) {
      try {
        await this.db('leaked_password_checks').insert({ flagged_at: null, flag_action: null, ...row });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        await this.db('leaked_password_checks').where({ user_id: userId }).update(row);
      }
    }
  }

  /**
   * At sign-in, after the password was verified (Agent B's `SigninPolicies.atSignIn` calls it for local accounts):
   * checks it against the list versions added since the account was last checked, and answers what the tenant chose
   * for a newly listed password: `warn` (signed in, told once by a security notice), `require_change` (the default:
   * signed in once, then must change it; `local_credentials.must_change` is set so it holds at the next sign-in too)
   * or `block` (refused until it is changed; the versions are not recorded, so every sign-in with it is refused). A
   * directory account's password is changed in its store, so `require_change` warns it instead. A check that cannot
   * run never stops a sign-in (`unavailable`, accepted); it is tried again at the next one.
   */
  async atSignIn(tenantId: string, userId: string, password: string, opts: { local?: boolean; ip?: string | null; traceId?: string | null } = {}): Promise<LeakedCheck> {
    const vs = await this.versionsFor(tenantId);
    if (!vs.length) return { found: false };
    const rec = (await this.db('leaked_password_checks').where({ user_id: userId }).first()) as Record<string, unknown> | undefined;
    const done = new Set(json<string[]>(rec?.versions ?? null, []));
    const fresh = vs.filter((v) => !done.has(v.id));
    if (!fresh.length) return { found: false };
    const r = await this.inVersions(fresh, password);
    if (!r.found && r.unavailable.length) {
      this.s().log.warn({ tenantId, versions: r.unavailable.map((u) => u.version) }, 'leaked-password check at sign-in could not run');
      // Remember what could be checked, so the next sign-in only retries the rest.
      const ok = fresh.filter((v) => !r.unavailable.some((u) => u.version === v.id)).map((v) => v.id);
      await this.saveCheck(tenantId, userId, [...done, ...ok], null, true);
      return { unavailable: true, action: 'accept', reason: 'a list could not be read' };
    }
    const all = vs.map((v) => v.id);
    if (!r.found) {
      await this.saveCheck(tenantId, userId, all, null, true);
      return { found: false };
    }
    const settings = await this.settings(tenantId);
    const local = opts.local ?? !!(await this.db('local_credentials').where({ user_id: userId }).first('user_id'));
    let action: SignInAction = settings.signinAction;
    if (action === 'require_change' && !local) action = 'warn';
    if (action === 'block') {
      await this.saveFlag(tenantId, userId, [...done], action);
    } else {
      await this.saveFlag(tenantId, userId, all, action);
      if (action === 'require_change') await this.db('local_credentials').where({ user_id: userId }).update({ must_change: true });
    }
    const user = (await this.db('users').where({ id: userId }).first('username')) as { username: string } | undefined;
    await this.s().audit.append({
      tenantId,
      action: 'password.leaked.signin',
      kind: 'auth',
      actor: { user: userId, ...(user ? { username: user.username } : {}), ip: opts.ip ?? null },
      target: { user: userId },
      detail: { action, ...(settings.signinAction !== action ? { chosen: settings.signinAction, reason: 'directory account: the password is changed in its store' } : {}) },
      ...(opts.traceId ? { traceId: opts.traceId } : {})
    });
    const title = action === 'block' ? 'Sign-in refused: your password is on a leaked-password list' : 'Your password is on a leaked-password list';
    const body = action === 'block' ? 'Reset your password to sign in again.' : action === 'require_change' ? 'You were asked to choose a new one when you signed in.' : local ? 'Change it in Settings soon.' : 'Change it where your account lives (your directory).';
    try {
      await this.s().notifications.notify({ tenantId, userIds: [userId], kind: 'security', title, body, route: 'settings', label: 'internal', email: true });
    } catch (err) {
      this.s().log.warn({ err: (err as Error).message }, 'leaked-password notice failed');
    }
    return { found: true, action, message: action === 'block' ? 'This password appears in a list of leaked passwords and can no longer be used. Reset it with a link.' : LEAKED_MESSAGE };
  }

  private async saveFlag(tenantId: string, userId: string, versions: string[], action: SignInAction): Promise<void> {
    await this.saveCheck(tenantId, userId, versions, { at: Date.now(), action });
  }

  /**
   * The k-anonymous range for the CLI self-check: every listed digest whose hex starts with the five-character
   * prefix, from every list the tenant's checks use, as upper-case hex suffixes. Only the prefix comes in.
   */
  async range(tenantId: string, kind: HashKind, prefix: string): Promise<string[]> {
    if (!/^[0-9A-F]{5}$/.test(prefix)) throw new Error('A range prefix is five upper-case hexadecimal characters');
    const out = new Set<string>();
    for (const v of (await this.versionsFor(tenantId)).filter((x) => x.kind === kind)) {
      for (const d of await (await this.reader(v)).range(prefix)) out.add(d.toString('hex').toUpperCase().slice(5));
    }
    return [...out];
  }

  // ---------- tenant settings ----------

  async settings(tenantId: string): Promise<LeakedSettings> {
    const hit = this.settingsCache.get(tenantId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.v;
    if (!(await this.installed())) return DEFAULT_SETTINGS;
    const r = (await this.db('leaked_password_settings').where({ tenant_id: tenantId }).first()) as Record<string, unknown> | undefined;
    const v: LeakedSettings = r
      ? { signinAction: (SIGNIN_ACTIONS as readonly string[]).includes(String(r.signin_action)) ? (r.signin_action as SignInAction) : 'require_change', failMode: r.fail_mode === 'closed' ? 'closed' : 'open', denyWords: json<string[]>(r.deny_words, []), denyTermList: (r.deny_term_list as string | null) ?? null, updatedAt: num(r.updated_at) }
      : DEFAULT_SETTINGS;
    this.settingsCache.set(tenantId, { at: Date.now(), v });
    return v;
  }

  async saveSettings(a: Actor, patch: Partial<Omit<LeakedSettings, 'updatedAt'>>): Promise<LeakedSettings> {
    await this.need();
    if (!a.identity) throw new HttpProblem(403, 'Forbidden', 'Leaked-password settings need identity:manage.', { extensions: { action: 'identity:manage' } });
    if (patch.denyTermList) await this.s().guard.terms.get(a.tenantId, patch.denyTermList);
    const before = await this.settings(a.tenantId);
    const next = { ...before, ...patch };
    const row = { tenant_id: a.tenantId, signin_action: next.signinAction, fail_mode: next.failMode, deny_words: JSON.stringify(next.denyWords), deny_term_list: next.denyTermList, updated_by: a.userId, updated_at: Date.now() };
    const n = await this.db('leaked_password_settings').where({ tenant_id: a.tenantId }).update(row);
    if (!n) await this.db('leaked_password_settings').insert(row);
    this.settingsCache.delete(a.tenantId);
    this.s().passwordDenyWords.forget(a.tenantId);
    this.s().bus.publish(SETTINGS_CHANGED, { tenantId: a.tenantId });
    const changed = Object.keys(patch).filter((k) => JSON.stringify((patch as Record<string, unknown>)[k]) !== JSON.stringify((before as unknown as Record<string, unknown>)[k]));
    await this.audit(a, 'passwords.settings.updated', { tenant: a.tenantId }, { changed, signinAction: next.signinAction, failMode: next.failMode, denyWords: next.denyWords.length, denyTermList: next.denyTermList });
    return this.settings(a.tenantId);
  }

  // ---------- report ----------

  /** Accounts found on a list at sign-in, and whether their password has been changed since. */
  async report(tenantId: string): Promise<{ checked: number; flagged: number; changed: number; accounts: { userId: string; username: string; displayName: string; flaggedAt: number; action: string | null; changedAt: number | null }[] }> {
    if (!(await this.installed())) return { checked: 0, flagged: 0, changed: 0, accounts: [] };
    const checked = num(((await this.db('leaked_password_checks').where({ tenant_id: tenantId }).count({ n: '*' })) as { n: unknown }[])[0]?.n);
    const rows = (await this.db('leaked_password_checks as c')
      .join('users as u', 'u.id', 'c.user_id')
      .leftJoin('local_credentials as lc', 'lc.user_id', 'c.user_id')
      .where('c.tenant_id', tenantId)
      .whereNotNull('c.flagged_at')
      .orderBy('c.flagged_at', 'desc')
      .limit(1000)
      .select('c.user_id', 'u.username', 'u.display_name', 'c.flagged_at', 'c.flag_action', 'lc.updated_at as cred_at')) as { user_id: string; username: string; display_name: string; flagged_at: number; flag_action: string | null; cred_at: number | null }[];
    const accounts = rows.map((r) => {
      const changedAt = r.cred_at != null && num(r.cred_at) > num(r.flagged_at) ? num(r.cred_at) : null;
      return { userId: r.user_id, username: r.username, displayName: r.display_name, flaggedAt: num(r.flagged_at), action: r.flag_action, changedAt };
    });
    return { checked, flagged: accounts.length, changed: accounts.filter((x) => x.changedAt).length, accounts };
  }
}
