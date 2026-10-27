import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { ulid } from 'ulid';
import { z } from 'zod';
import { AuditCheckpoints } from '../audit/checkpoints.js';
import { AuditLog, actorFrom, type AuditActor } from '../audit/chain.js';
import { createDb, migrate, type Db } from '../db/knex.js';
import { migrateCheck } from '../db/schema.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { listTables, manifestKeyFor, type BackupManifest } from '../ops/backups.js';
import { getState, setState } from '../ops/common.js';
import { rowCounts } from '../ops/restore.js';
import type { Services } from '../services.js';
import type { CloudActor } from './accounts.js';
import { normaliseCaBundle } from './data-tier.js';

/*
 * 1.9.99-final, Sprint 59 (B-10302): moving an existing install onto a managed PostgreSQL (RDS, Aurora, Azure
 * Flexible Server, DigitalOcean), or any PostgreSQL, as a guided, resumable operation (`s.cloud.dbMoves`).
 *
 *   preflight      connect to the target with TLS against the provider's CA bundle (a file, `sslrootcert`), check
 *                  that TLS is in use, the server version, that the target holds no tenant, user or audit row, that
 *                  pgvector is available, that the source is fully migrated, and the connection budget: the target's
 *                  `max_connections` less its reserved slots must hold DB_POOL_MAX × instances plus headroom
 *   schema         this build's migrations applied to the target (so `backup:restore` finds every table)
 *   read_only      the cutover window opens: the install refuses every change (HTTP 503 `read_only_window`, the
 *                  job queue claims nothing), then waits for running jobs to finish
 *   backup         `backup:create`: a consistent, sealed, KMS-signed dump into the blob store
 *   restore        `backup:restore` into the target (its blob store is shared, so only rows move)
 *   verify         nothing was written to the source during the window, the target's rows match the manifest, every
 *                  tenant's audit chain verifies on the target (`audit:verify`), the window's flag is cleared there
 *   migrate_check  `migrate --check` against the target: up to date, nothing pending, nothing newer
 *   switch         DATABASE_URL switched: the URL file the install reads (`DATABASE_URL_FILE`) is rewritten (the old
 *                  one kept beside it as `.previous`), the old database is kept read-only (its own
 *                  `default_transaction_read_only` where PostgreSQL allows it, and the window's flag) for
 *                  `keepOldDays`; the instances are restarted by the operator
 *
 * Each step is recorded as it finishes (in `platform_state`, on the source and, after the switch, on the target), so a
 * crash between steps resumes where it stopped (`db:move --resume`, or the job's retry). A dry run is the preflight
 * and an estimate of the window, and changes nothing. Rollback before the switch closes the window and leaves the
 * install on its database; after it, within the keep window, it points the URL file back and opens the old database
 * again, refusing when the new one took writes since the switch unless they are given up (`discardNewWrites`).
 *
 * From the console the move is under dual control: one platform cloud admin asks for it (a dry run first), another
 * approves it, both with a recent sign-in, and the approved move runs as the job `cloud.db.move`. The CLI
 * (`exprsn-ai db:move`) is the operator on the host and runs it directly. No URL, password or CA is ever stored in a
 * move record, an audit entry or a log line: the record holds where the URL comes from (a file, a `vault:` reference
 * or a deployment) and the target's host, port and database name only.
 */

export const MOVE_STEPS = ['preflight', 'schema', 'read_only', 'backup', 'restore', 'verify', 'migrate_check', 'switch'] as const;
export type MoveStep = (typeof MOVE_STEPS)[number];
export const MOVE_STATES = ['planned', 'awaiting_approval', 'approved', 'running', 'failed', 'switched', 'finished', 'rolled_back', 'rejected'] as const;
export type MoveState = (typeof MOVE_STATES)[number];

export const MOVE_PREFIX = 'cloud.dbmove:';
export const WINDOW_KEY = 'cloud.dbmove.window';
/** The documented bound on the cutover window (B-10302): a move whose window would pass it is refused at the dry run and stopped if it passes it. */
export const DEFAULT_WINDOW_MINUTES = 30;
export const DEFAULT_KEEP_OLD_DAYS = 7;
/** Connections beyond the pools: the CLI, a migration, a backup and the operator's psql. */
export const CONNECTION_HEADROOM = 5;
/** Tables that change during the window by themselves (heartbeats, the window's own state, the backup's row, the queue). */
export const VOLATILE_TABLES = new Set(['platform_instances', 'platform_state', 'platform_backups', 'platform_drills', 'jobs', 'knex_migrations', 'knex_migrations_lock', 'login_throttle']);

/**
 * `max_connections` of the managed sizes the presets use (the providers' documented defaults: RDS and Aurora
 * `LEAST(DBInstanceClassMemory/9531392, 5000)`, Azure Flexible Server's table per memory size, DigitalOcean 25 per GiB
 * less 3). The live value (`SHOW max_connections`) wins whenever the target answers.
 */
export const MANAGED_MAX_CONNECTIONS: Record<string, number> = {
  'db.t4g.medium': 450,
  'db.m6g.large': 901,
  'db.m6g.xlarge': 1802,
  'db.r6g.large': 1802,
  Standard_B1ms: 50,
  Standard_B2s: 429,
  Standard_D2ds_v5: 859,
  Standard_D4ds_v5: 1719,
  'db-s-1vcpu-1gb': 22,
  'db-s-1vcpu-2gb': 47,
  'db-s-2vcpu-4gb': 97,
  'db-s-4vcpu-8gb': 197,
  'db-s-6vcpu-16gb': 397
};

export interface ConnectionBudget {
  maxConnections: number;
  reserved: number;
  poolMax: number;
  instances: number;
  headroom: number;
  required: number;
  available: number;
  ok: boolean;
  source: 'live' | 'size';
}

/** Whether the target's connections hold every pool: DB_POOL_MAX × instances + headroom ≤ max_connections − reserved. */
export function connectionBudget(o: { maxConnections: number; reserved: number; poolMax: number; instances: number; headroom?: number; source: 'live' | 'size' }): ConnectionBudget {
  const headroom = o.headroom ?? CONNECTION_HEADROOM;
  const required = o.poolMax * o.instances + headroom;
  const available = Math.max(0, o.maxConnections - o.reserved);
  return { maxConnections: o.maxConnections, reserved: o.reserved, poolMax: o.poolMax, instances: o.instances, headroom, required, available, ok: required <= available, source: o.source };
}

// ---------- the target ----------

/** Where the target's URL comes from: never the URL itself. */
export type TargetSpec = { kind: 'url_file'; path: string } | { kind: 'vault'; ref: string; tenantId: string; ownerId: string } | { kind: 'deployment'; deploymentId: string; key?: string };

export interface TargetView {
  client: 'pg' | 'sqlite';
  host: string | null;
  port: number | null;
  database: string | null;
  /** The provider and size, for a deployment's database. */
  provider?: string | null;
  size?: string | null;
}

/** A PostgreSQL URL with verify-full TLS against `caFile` (node-postgres reads `sslrootcert` at connect). */
export function withCaFile(url: string, caFile: string | null): string {
  if (!caFile) return url;
  const u = new URL(url);
  u.searchParams.set('sslrootcert', caFile);
  const mode = u.searchParams.get('sslmode');
  if (!mode || mode === 'require' || mode === 'prefer' || mode === 'allow') u.searchParams.set('sslmode', 'verify-full');
  return u.toString();
}

/** What a URL names, without its password. */
export function describeUrl(url: string): TargetView {
  if (/^sqlite:/i.test(url)) return { client: 'sqlite', host: null, port: null, database: url.replace(/^sqlite:(\/\/)?/i, '') };
  const u = new URL(url);
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new HttpProblem(422, 'Unprocessable', `A move targets PostgreSQL (postgres://); ${u.protocol.replace(/:$/, '')} is not one.`, { extensions: { reason: 'unsupported_target' } });
  return { client: 'pg', host: u.hostname, port: Number(u.port || 5432), database: decodeURIComponent(u.pathname.replace(/^\//, '')) || null };
}

/** The target as a Knex database: PostgreSQL with a small pool, or (rehearsals and tests) a SQLite file. */
export function openTarget(url: string): Db {
  if (/^sqlite:/i.test(url)) return createDb({ DB_CLIENT: 'sqlite', SQLITE_FILENAME: url.replace(/^sqlite:(\/\/)?/i, ''), DB_POOL_MAX: 1, DATABASE_URL: undefined });
  return createDb({ DB_CLIENT: 'pg', DATABASE_URL: url, DB_POOL_MAX: 2, SQLITE_FILENAME: '' });
}

/** What the preflight reads from the target (tests replace it to play a server's limits). */
export interface TargetFacts {
  version: string | null;
  ssl: boolean | null;
  maxConnections: number | null;
  reserved: number;
  extensions: string[];
  occupied: { table: string; rows: number }[];
}

export async function readTargetFacts(db: Db, client: 'pg' | 'sqlite'): Promise<TargetFacts> {
  const tables = new Set(await listTables(db, client));
  const occupied = (await rowCounts(db, ['tenants', 'users', 'audit_events'].filter((t) => tables.has(t)))).filter((c) => c.rows > 0);
  if (client === 'sqlite') return { version: String(((await db.raw('select sqlite_version() as v')) as { v: string }[])[0]?.v ?? ''), ssl: null, maxConnections: null, reserved: 0, extensions: [], occupied };
  const one = async (sql: string) => ((await db.raw(sql)) as { rows: Record<string, unknown>[] }).rows[0] ?? {};
  const version = String((await one('show server_version')).server_version ?? '');
  const ssl = (await one('select ssl from pg_stat_ssl where pid = pg_backend_pid()')).ssl;
  const maxConnections = Number((await one('show max_connections')).max_connections);
  const reservedRow = (await one('show superuser_reserved_connections')).superuser_reserved_connections;
  // RDS and Aurora keep further slots for rdsadmin; Azure for its own admins (azure_pg_admin). Read them where they exist.
  let extra = 0;
  for (const name of ['rds.rds_superuser_reserved_connections', 'reserved_connections']) {
    const r = ((await db.raw('select setting from pg_settings where name = ?', [name])) as { rows: { setting: string }[] }).rows[0];
    if (r) extra += Number(r.setting) || 0;
  }
  const ext = ((await db.raw('select name from pg_available_extensions')) as { rows: { name: string }[] }).rows.map((r) => r.name);
  return { version, ssl: ssl == null ? null : Boolean(ssl), maxConnections: Number.isFinite(maxConnections) ? maxConnections : null, reserved: (Number(reservedRow) || 0) + extra, extensions: ext, occupied };
}

// ---------- records ----------

export interface StepRecord {
  state: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  startedAt: number | null;
  finishedAt: number | null;
  detail: Record<string, unknown> | null;
  attempts: number;
}

export interface MoveCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export interface MoveRecord {
  id: string;
  state: MoveState;
  dryRun: boolean;
  source: { client: string; host: string | null; database: string | null };
  target: TargetSpec;
  view: TargetView | null;
  /** The CA bundle file the target's URL names (`sslrootcert`), or null for a URL that carries its own TLS settings. */
  caFile: string | null;
  /** The URL file DATABASE_URL is switched in (`DATABASE_URL_FILE`), or null when the operator switches by hand. */
  switchFile: string | null;
  instances: number;
  windowBoundMs: number;
  keepOldMs: number;
  requireTls: boolean;
  checks: MoveCheck[];
  budget: ConnectionBudget | null;
  estimate: { windowMs: number; rows: number; basis: string } | null;
  steps: Record<MoveStep, StepRecord>;
  backupId: string | null;
  window: { openedAt: number | null; closedAt: number | null };
  switchedAt: number | null;
  keepOldUntil: number | null;
  oldReadOnly: 'database' | 'flag' | null;
  /** Row counts of the target right after the switch (a rollback compares them). */
  countsAtSwitch: Record<string, number> | null;
  requestedBy: string | null;
  approvedBy: string | null;
  lease: { holder: string; until: number } | null;
  /** Audit entries held back while the window is open (the source takes no writes then), written when it closes. */
  pendingAudit: { action: string; actor: AuditActor; detail: Record<string, unknown>; ts: number }[];
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MoveInput {
  target: TargetSpec;
  caFile?: string | null;
  switchFile?: string | null;
  instances?: number;
  windowMinutes?: number;
  keepOldDays?: number;
  dryRun?: boolean;
  /** Rehearsals against a local PostgreSQL without TLS only (`--insecure-no-tls`); never from the console. */
  requireTls?: boolean;
}

export type MoveActor = CloudActor | { service: 'cli' | 'cloud.db.move'; userId?: string | null };

export interface MoveHooks {
  /** Tests: after a step is recorded done (a throw here is a crash between steps). */
  afterStep?: (step: MoveStep, move: MoveRecord) => void | Promise<void>;
  /** Tests: the target's facts instead of reading them (a server's limits, TLS). */
  facts?: (db: Db, client: 'pg' | 'sqlite') => Promise<TargetFacts>;
  /** How long the window waits for the requests and jobs in flight (default 5 s, then up to 2 min for running jobs). */
  settleMs?: number;
  drainMs?: number;
  sleep?: (ms: number) => Promise<void>;
  progress?: (message: string) => void;
}

export const moveInputSchema = z
  .object({
    target: z.union([z.object({ kind: z.literal('vault'), ref: z.string().regex(/^vault:[^#\s]+#[A-Za-z0-9_.-]+$/, 'a vault: reference') }).strict(), z.object({ kind: z.literal('deployment'), deploymentId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/), key: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/).optional() }).strict()]),
    caRef: z.string().regex(/^vault:[^#\s]+#[A-Za-z0-9_.-]+$/).optional(),
    instances: z.number().int().min(1).max(200).optional(),
    windowMinutes: z.number().int().min(1).max(24 * 60).optional(),
    keepOldDays: z.number().int().min(1).max(90).optional(),
    note: z.string().trim().max(300).optional()
  })
  .strict();
export const moveDecisionSchema = z.object({ note: z.string().trim().max(300).optional() }).strict();
export const moveRollbackSchema = z.object({ discardNewWrites: z.boolean().default(false), note: z.string().trim().max(300).optional() }).strict();

const freshSteps = (): Record<MoveStep, StepRecord> => Object.fromEntries(MOVE_STEPS.map((s) => [s, { state: 'pending', startedAt: null, finishedAt: null, detail: null, attempts: 0 }])) as Record<MoveStep, StepRecord>;

/** Problem for a refused move, with the checks that failed. */
const refused = (reason: string, message: string, extensions: Record<string, unknown> = {}) => new HttpProblem(409, 'Conflict', message, { extensions: { reason, ...extensions } });

// ---------- the read-only window ----------

/**
 * The cutover window as every instance sees it: a row in `platform_state` that the HTTP guard and the job queue's
 * gate read (cached two seconds). While it is open, a change (any method but GET, HEAD and OPTIONS) answers 503
 * `read_only_window` with Retry-After, except the move's own routes and signing out; the queue claims nothing while
 * the move holding the window is alive.
 */
export class ReadOnlyWindow {
  private cache: { at: number; value: WindowState | null } | null = null;
  private loading: Promise<WindowState | null> | null = null;

  constructor(private readonly s: () => Services) {}

  async current(maxAgeMs = 2000): Promise<WindowState | null> {
    if (this.cache && Date.now() - this.cache.at < maxAgeMs) return this.cache.value;
    this.loading ??= (async () => {
      try {
        const v = await getState<WindowState | null>(this.s(), WINDOW_KEY, null).catch(() => null);
        this.cache = { at: Date.now(), value: v };
        return v;
      } finally {
        this.loading = null;
      }
    })();
    return this.loading;
  }

  forget(): void {
    this.cache = null;
  }

  /** For the job queue's gate (synchronous: the last answer, refreshed in the background). */
  refusal(): string | null {
    if (!this.cache || Date.now() - this.cache.at > 2000) void this.current().catch(() => undefined);
    const w = this.cache?.value;
    if (!w) return null;
    if (w.leaseUntil != null && w.leaseUntil < Date.now()) return null; // the move holding it stopped: its job may resume
    return 'the database is being moved (read-only window)';
  }

  middleware() {
    return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
      if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
      if (req.path.startsWith('/admin/cloud/db-moves') || req.path === '/auth/logout') return next();
      const w = await this.current().catch(() => null);
      if (!w) return next();
      next(new HttpProblem(503, 'Read-only window', 'The database is being moved: changes are refused until the move switches or is rolled back. Try again in a few minutes.', { extensions: { reason: 'read_only_window', since: w.openedAt }, headers: { 'retry-after': '60' } }));
    };
  }
}

export interface WindowState {
  moveId: string;
  openedAt: number;
  /** The move's lease: past it, the job queue may claim again (the move's own retry among them). */
  leaseUntil: number | null;
  /** `switched`: kept on the old database after the switch, so an instance still on it changes nothing. */
  phase: 'cutover' | 'switched';
}

// ---------- the service ----------

export class DbMoves {
  readonly window: ReadOnlyWindow;
  hooks: MoveHooks = {};
  private readonly worker = `db-move-${process.pid}-${ulid().slice(-6)}`;

  constructor(private readonly s: () => Services) {
    this.window = new ReadOnlyWindow(s);
  }

  // ---------- records ----------

  async get(id: string): Promise<MoveRecord> {
    const r = await getState<MoveRecord | null>(this.s(), `${MOVE_PREFIX}${id}`, null);
    if (!r) throw notFound('Database move');
    return r;
  }

  async list(limit = 20): Promise<MoveRecord[]> {
    const rows = (await this.s().db('platform_state').where('key', 'like', `${MOVE_PREFIX}%`).select('value')) as { value: string }[];
    return rows
      .map((r) => {
        try {
          return JSON.parse(r.value) as MoveRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is MoveRecord => !!r)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  /**
   * A write on the source. After the switch its PostgreSQL database defaults to read-only transactions: the move's
   * own bookkeeping (its record, the window's flag) still lands there, in a transaction made read-write.
   */
  private async onSource<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const s = this.s();
    try {
      return await fn(s.db);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (s.cfg.DB_CLIENT !== 'pg' || !(e.code === '25006' || /read-only transaction/i.test(e.message ?? ''))) throw err;
      return s.db.transaction(async (trx) => {
        await trx.raw('SET TRANSACTION READ WRITE');
        return fn(trx as unknown as Db);
      });
    }
  }

  private async save(m: MoveRecord, extra?: Db | null): Promise<MoveRecord> {
    m.updatedAt = Date.now();
    await this.onSource((db) => setStateOn(db, `${MOVE_PREFIX}${m.id}`, m));
    if (extra) await setStateOn(extra, `${MOVE_PREFIX}${m.id}`, m).catch(() => undefined);
    return m;
  }

  /** The open move (planned dry runs aside), if any: one at a time. */
  async active(): Promise<MoveRecord | null> {
    return (await this.list(100)).find((m) => !m.dryRun && ['awaiting_approval', 'approved', 'running', 'failed', 'switched'].includes(m.state)) ?? null;
  }

  // ---------- actors and audit ----------

  private actorOf(a: MoveActor): { actor: AuditActor; userId: string | null } {
    if ('principal' in a) return { actor: actorFrom(a.principal, a.ip), userId: a.principal.userId };
    return { actor: { service: a.service === 'cli' ? 'cli' : 'cloud.db.move', ...(a.userId ? { user: a.userId } : {}) }, userId: a.userId ?? null };
  }

  private async platformTenant(): Promise<string | null> {
    return (await this.s().tenants.bySlug(this.s().cfg.DEFAULT_TENANT))?.id ?? null;
  }

  /** An audit entry now, or held in the record while the window is open (the source takes no writes then). */
  private async audit(m: MoveRecord, a: MoveActor, action: string, detail: Record<string, unknown> = {}, to?: Db): Promise<void> {
    const actor = this.actorOf(a).actor;
    const full = { ...detail, move: m.id, target: m.view ? { host: m.view.host, port: m.view.port, database: m.view.database } : null };
    if (m.window.openedAt && !m.window.closedAt && !to) {
      m.pendingAudit.push({ action, actor, detail: full, ts: Date.now() });
      return;
    }
    const tenantId = await this.platformTenant();
    if (!tenantId) return;
    const log = to ? new AuditLog(to) : this.s().audit;
    await log.append({ tenantId, action, kind: 'admin', actor, target: { move: m.id }, detail: full });
  }

  private async flushAudit(m: MoveRecord, to?: Db): Promise<void> {
    const held = m.pendingAudit.splice(0);
    const tenantId = await this.platformTenant();
    if (!tenantId) return;
    const log = to ? new AuditLog(to) : this.s().audit;
    for (const e of held) await log.append({ tenantId, action: e.action, kind: 'admin', actor: e.actor, target: { move: m.id }, detail: { ...e.detail, heldUntil: Date.now(), at: e.ts } });
  }

  // ---------- the target ----------

  /** The target's URL (with its password: kept in memory only) and the CA file it uses. */
  private async resolveTarget(m: Pick<MoveRecord, 'target' | 'caFile'>): Promise<{ url: string; caFile: string | null; view: TargetView }> {
    const s = this.s();
    let url: string;
    let caFile = m.caFile;
    let extra: Partial<TargetView> = {};
    const t = m.target;
    if (t.kind === 'url_file') {
      if (!existsSync(t.path)) throw refused('target_unreadable', `The target's URL file ${t.path} does not exist.`);
      url = readFileSync(t.path, 'utf8').trim();
    } else if (t.kind === 'vault') {
      url = (await s.vault.resolveFor(t.tenantId, t.ownerId, t.ref, { via: 'cloud.db.move' })).trim();
    } else {
      const d = await s.cloud.deployments.get(t.deploymentId);
      if (!d) throw notFound('Deployment');
      const rows = await s.cloud.deployments.resources(d.id);
      const db = rows.find((r) => r.type === 'database' && r.key === (t.key ?? 'db'));
      if (!db) throw refused('no_database', `${d.name} has no database ${t.key ?? 'db'}.`);
      const tier = await s.cloud.dataTier.values(d, { service: 'cloud.db.move', onBehalfOf: d.createdBy });
      if (!tier.database_url) throw refused('data_tier_not_wired', `${d.name}'s database is not wired yet.`);
      // The deployed app's URL names the CA where its shape mounts it; this install keeps its own copy.
      const own = caFile ?? path.join(path.dirname(process.env.DATABASE_URL_FILE ?? path.resolve('data/database-url')), `database-ca-${d.name}.pem`);
      if (tier.database_ca) writePrivate(own, normaliseCaBundle(tier.database_ca), false);
      caFile = own;
      url = tier.database_url;
      extra = { provider: d.provider, size: String((db.desired.spec as { size?: string }).size ?? '') || null };
    }
    if (!url) throw refused('target_unreadable', 'The target URL is empty.');
    if (caFile && !existsSync(caFile)) throw refused('ca_file_missing', `The CA bundle ${caFile} does not exist.`);
    if (caFile) normaliseCaBundle(readFileSync(caFile));
    const view = { ...describeUrl(url), ...extra };
    return { url: view.client === 'pg' ? withCaFile(url, caFile) : url, caFile, view };
  }

  private async instances(): Promise<number> {
    const s = this.s();
    const live = await s
      .db('platform_instances')
      .where('heartbeat_at', '>', Date.now() - 90_000)
      .count({ n: '*' })
      .then((r) => Number(r[0]?.n ?? 0))
      .catch(() => 0);
    return Math.max(1, s.cfg.SERVER_REPLICAS ?? 1, live);
  }

  // ---------- plan (and dry run) ----------

  /** Makes a move record and runs the preflight against the target; changes nothing. */
  async plan(input: MoveInput, a: MoveActor): Promise<MoveRecord> {
    const s = this.s();
    const now = Date.now();
    const sourceView = sourceOf(s);
    const m: MoveRecord = {
      id: ulid(),
      state: 'planned',
      dryRun: input.dryRun !== false,
      source: sourceView,
      target: input.target,
      view: null,
      caFile: input.caFile ?? null,
      switchFile: input.switchFile === undefined ? (process.env.DATABASE_URL_FILE ?? null) : input.switchFile,
      instances: input.instances ?? (await this.instances()),
      windowBoundMs: (input.windowMinutes ?? DEFAULT_WINDOW_MINUTES) * 60_000,
      keepOldMs: (input.keepOldDays ?? DEFAULT_KEEP_OLD_DAYS) * 86_400_000,
      requireTls: input.requireTls !== false,
      checks: [],
      budget: null,
      estimate: null,
      steps: freshSteps(),
      backupId: null,
      window: { openedAt: null, closedAt: null },
      switchedAt: null,
      keepOldUntil: null,
      oldReadOnly: null,
      countsAtSwitch: null,
      requestedBy: this.actorOf(a).userId,
      approvedBy: null,
      lease: null,
      pendingAudit: [],
      error: null,
      createdAt: now,
      updatedAt: now
    };
    await this.preflight(m);
    await this.save(m);
    await this.audit(m, a, m.dryRun ? 'cloud.db_move.dry_run' : 'cloud.db_move.planned', { checks: m.checks.map((c) => ({ id: c.id, ok: c.ok })), budget: m.budget, estimate: m.estimate });
    return m;
  }

  /** The preflight's checks (recorded on the move); throws nothing for a failed check, `ok` says. */
  private async preflight(m: MoveRecord): Promise<boolean> {
    const s = this.s();
    const checks: MoveCheck[] = [];
    const add = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });
    let target: Awaited<ReturnType<DbMoves['resolveTarget']>> | null = null;
    try {
      target = await this.resolveTarget(m);
      m.view = target.view;
      m.caFile = target.caFile;
      add('target', true, `${target.view.client === 'pg' ? `postgres ${target.view.host}:${target.view.port}/${target.view.database ?? ''}` : `sqlite ${target.view.database}`}`);
    } catch (err) {
      add('target', false, (err as Error).message);
    }
    const source = await migrateCheck(s.db);
    add('source_schema', source.state === 'current', source.state === 'current' ? `The source is at ${source.database}.` : (source.reason ?? 'The source is not fully migrated.'));
    add('switch_file', !!m.switchFile, m.switchFile ? `DATABASE_URL is switched in ${m.switchFile}.` : 'No URL file to switch: set DATABASE_URL_FILE (the install reads its URL from a file) or pass --switch-file.');
    if (target) {
      const db = openTarget(target.url);
      try {
        const facts = await (this.hooks.facts ?? readTargetFacts)(db, target.view.client);
        if (target.view.client === 'pg') {
          add('tls', facts.ssl === true || !m.requireTls, facts.ssl ? `TLS in use${m.caFile ? `, verified against ${m.caFile}` : ''}.` : m.requireTls ? 'The connection is not encrypted: give the provider’s CA bundle (--ca-file) and sslmode=verify-full.' : 'TLS is off (a rehearsal without TLS).');
          add('ca_file', !!m.caFile || !m.requireTls, m.caFile ? `The CA bundle ${m.caFile} is a valid PEM bundle.` : 'No CA bundle: the provider’s CA (RDS global bundle, Azure DigiCert and Microsoft roots, DigitalOcean’s cluster CA) must be given as a file.');
          add('extensions', facts.extensions.includes('vector'), facts.extensions.includes('vector') ? 'pgvector is available.' : 'pgvector (vector) is not available on the target; allow-list it first (Azure: azure.extensions).');
        }
        add('version', !!facts.version, `Server version ${facts.version ?? 'unknown'}.`);
        add('empty', !facts.occupied.length, facts.occupied.length ? `The target is not empty (${facts.occupied.map((c) => `${c.rows} ${c.table}`).join(', ')}): move into an empty database.` : 'The target holds no tenant, user or audit row.');
        const size = m.view?.size ?? null;
        const max = facts.maxConnections ?? (size ? (MANAGED_MAX_CONNECTIONS[size] ?? null) : null);
        if (max != null) {
          m.budget = connectionBudget({ maxConnections: max, reserved: facts.reserved, poolMax: s.cfg.DB_POOL_MAX, instances: m.instances, source: facts.maxConnections != null ? 'live' : 'size' });
          add('connections', m.budget.ok, `${m.budget.required} connections needed (DB_POOL_MAX ${m.budget.poolMax} × ${m.budget.instances} instance${m.budget.instances === 1 ? '' : 's'} + ${m.budget.headroom}), ${m.budget.available} available (max_connections ${m.budget.maxConnections} less ${m.budget.reserved} reserved)${m.budget.ok ? '.' : ': lower DB_POOL_MAX, run fewer instances, add a pooler, or choose a larger size.'}`);
        } else add('connections', true, 'The target does not report max_connections (SQLite).');
      } catch (err) {
        add('connect', false, `The target did not answer: ${redact((err as Error).message)}`);
      } finally {
        await db.destroy().catch(() => undefined);
      }
    }
    m.estimate = await this.estimate();
    add('window', m.estimate.windowMs <= m.windowBoundMs, `The window is estimated at ${Math.ceil(m.estimate.windowMs / 1000)} s (${m.estimate.basis}); the bound is ${Math.round(m.windowBoundMs / 60_000)} min.`);
    m.checks = checks;
    return checks.every((c) => c.ok);
  }

  /** The window's estimate: the last backup's time plus a restore at 20,000 rows a second, doubled for margin. */
  private async estimate(): Promise<{ windowMs: number; rows: number; basis: string }> {
    const s = this.s();
    const tables = await listTables(s.db, s.cfg.DB_CLIENT);
    const rows = (await rowCounts(s.db, tables)).reduce((a, c) => a + c.rows, 0);
    const last = (await s.db('platform_backups').where({ state: 'succeeded' }).orderBy('created_at', 'desc').first().catch(() => null)) as { created_at: number; finished_at: number | null } | undefined | null;
    const backupMs = last?.finished_at ? Math.max(0, Number(last.finished_at) - Number(last.created_at)) : Math.ceil(rows / 50);
    const restoreMs = Math.ceil(rows / 20);
    return { windowMs: 2 * (backupMs + restoreMs) + 10_000, rows, basis: last?.finished_at ? `${rows} rows; the last backup took ${Math.ceil(backupMs / 1000)} s` : `${rows} rows, no backup yet` };
  }

  // ---------- dual control (the console) ----------

  async request(a: CloudActor, input: z.infer<typeof moveInputSchema>): Promise<MoveRecord> {
    if (await this.active()) throw conflict('Another database move is open: finish, roll back or reject it first.');
    const target: TargetSpec = input.target.kind === 'vault' ? { kind: 'vault', ref: input.target.ref, tenantId: a.principal.tenantId, ownerId: a.principal.userId! } : { kind: 'deployment', deploymentId: input.target.deploymentId, ...(input.target.key ? { key: input.target.key } : {}) };
    let caFile: string | null = null;
    if (input.caRef) {
      const ca = normaliseCaBundle(await this.s().vault.resolveFor(a.principal.tenantId, a.principal.userId, input.caRef, { via: 'cloud.db.move' }));
      caFile = path.join(path.dirname(process.env.DATABASE_URL_FILE ?? path.resolve('data/database-url')), `database-ca-${ulid().toLowerCase()}.pem`);
      writePrivate(caFile, ca, false);
    }
    const m = await this.plan({ target, caFile, ...(input.instances ? { instances: input.instances } : {}), ...(input.windowMinutes ? { windowMinutes: input.windowMinutes } : {}), ...(input.keepOldDays ? { keepOldDays: input.keepOldDays } : {}), dryRun: false }, a);
    const failed = m.checks.filter((c) => !c.ok);
    if (failed.length) {
      m.state = 'rejected';
      m.error = `The dry run refused the move: ${failed.map((c) => `${c.id}: ${c.detail}`).join(' ')}`;
      await this.save(m);
      await this.audit(m, a, 'cloud.db_move.refused', { failed: failed.map((c) => c.id) });
      throw refused('preflight_failed', m.error, { move: m.id, checks: m.checks });
    }
    m.state = 'awaiting_approval';
    await this.save(m);
    await this.audit(m, a, 'cloud.db_move.requested', { note: input.note ?? null });
    return m;
  }

  async approve(a: CloudActor, id: string, note: string | null): Promise<{ move: MoveRecord; jobId: string }> {
    const m = await this.get(id);
    if (m.state !== 'awaiting_approval') throw conflict(`The move is ${m.state}, not awaiting approval.`);
    if (m.requestedBy && m.requestedBy === a.principal.userId) throw forbidden('A database move is approved by a second cloud admin, never the one who asked.', { step: 'dual-control' });
    m.state = 'approved';
    m.approvedBy = a.principal.userId;
    await this.save(m);
    await this.audit(m, a, 'cloud.db_move.approved', { note });
    const tenantId = (await this.platformTenant()) ?? a.principal.tenantId;
    const job = await this.s().jobs.enqueue({ tenantId, type: 'cloud.db.move', payload: { moveId: m.id }, createdBy: a.principal.userId, maxAttempts: 3 });
    return { move: m, jobId: job.id };
  }

  async reject(a: CloudActor, id: string, note: string | null): Promise<MoveRecord> {
    const m = await this.get(id);
    if (m.state !== 'awaiting_approval') throw conflict(`The move is ${m.state}, not awaiting approval.`);
    m.state = 'rejected';
    await this.save(m);
    await this.audit(m, a, 'cloud.db_move.rejected', { note });
    return m;
  }

  registerJobs(): void {
    this.s().jobs.register('cloud.db.move', async (p, ctx) => {
      const m = await this.run(String(p.moveId), { service: 'cloud.db.move', userId: ctx.job.created_by ?? null });
      return { state: m.state, switchedAt: m.switchedAt };
    }, { timeoutMs: 6 * 60 * 60_000 });
  }

  // ---------- the run ----------

  private async takeLease(m: MoveRecord): Promise<void> {
    const now = Date.now();
    if (m.lease && m.lease.holder !== this.worker && m.lease.until > now) throw conflict('The move is running elsewhere.');
    m.lease = { holder: this.worker, until: now + 10 * 60_000 };
  }

  /** Runs (or resumes) a move from its first unfinished step. */
  async run(id: string, a: MoveActor): Promise<MoveRecord> {
    const m = await this.get(id);
    if (m.dryRun) throw conflict('A dry run is not run; plan the move without --dry-run.');
    if (!['approved', 'running', 'failed', 'planned'].includes(m.state)) throw conflict(`The move is ${m.state}.`);
    if (m.state === 'planned' && !('service' in a && a.service === 'cli')) throw conflict('A move from the console needs a second admin’s approval first.');
    await this.takeLease(m);
    m.state = 'running';
    m.error = null;
    await this.save(m);
    await this.audit(m, a, 'cloud.db_move.started', { resumeAt: MOVE_STEPS.find((x) => m.steps[x].state !== 'done') ?? null });
    const say = this.hooks.progress ?? (() => undefined);
    let target: Awaited<ReturnType<DbMoves['resolveTarget']>> | null = null;
    let tdb: Db | null = null;
    const open = async () => {
      if (tdb) return tdb;
      target ??= await this.resolveTarget(m);
      tdb = openTarget(target.url);
      return tdb;
    };
    try {
      for (const step of MOVE_STEPS) {
        if (m.steps[step].state === 'done') continue;
        const rec = m.steps[step];
        // Run before (a crash, a failure, or a window closed again): the step may have left work behind it.
        const resumed = rec.state === 'running' || rec.state === 'failed' || rec.attempts > 0;
        rec.state = 'running';
        rec.startedAt = Date.now();
        rec.attempts += 1;
        m.lease = { holder: this.worker, until: Date.now() + 10 * 60_000 };
        await this.save(m);
        if (m.window.openedAt && !m.window.closedAt) await this.renewWindow(m);
        say(`${step}…`);
        rec.detail = await this.step(step, m, a, open, resumed);
        rec.state = 'done';
        rec.finishedAt = Date.now();
        if (m.window.openedAt && !m.window.closedAt && step !== 'switch' && Date.now() - m.window.openedAt > m.windowBoundMs) {
          throw Object.assign(new Error(`The window passed its bound of ${Math.round(m.windowBoundMs / 60_000)} min before the switch.`), { code: 'window_exceeded' });
        }
        await this.save(m, step === 'switch' ? tdb : null);
        await this.hooks.afterStep?.(step, m);
      }
      m.state = 'switched';
      m.lease = null;
      await this.save(m, tdb);
      say('switched');
      return m;
    } catch (err) {
      const e = err as Error & { code?: string };
      const current = MOVE_STEPS.find((x) => m.steps[x].state === 'running');
      if (current) m.steps[current].state = 'failed';
      m.error = redact(e.message);
      m.lease = null;
      // A window that ran past its bound, or failed writes check, closes: the install is writable again on the source.
      if (e.code === 'window_exceeded' || e.code === 'writes_during_window') {
        await this.closeWindow(m);
        for (const x of ['read_only', 'backup', 'restore', 'verify'] as const) m.steps[x] = { ...m.steps[x], state: 'pending' };
        m.backupId = null;
      }
      if (!m.switchedAt) m.state = 'failed';
      await this.save(m);
      if (!m.window.openedAt || m.window.closedAt) await this.audit(m, a, 'cloud.db_move.failed', { step: current ?? null, error: m.error, code: e.code ?? null });
      if (e instanceof HttpProblem) throw e;
      throw refused(e.code ?? 'move_failed', `The move stopped at ${current ?? 'start'}: ${m.error}`, { move: m.id });
    } finally {
      const t = tdb as Db | null;
      if (t) await t.destroy().catch(() => undefined);
    }
  }

  private async renewWindow(m: MoveRecord): Promise<void> {
    const w = await getState<WindowState | null>(this.s(), WINDOW_KEY, null);
    if (w && w.moveId === m.id) await setState(this.s(), WINDOW_KEY, { ...w, leaseUntil: m.lease?.until ?? null });
  }

  private async closeWindow(m: MoveRecord): Promise<void> {
    const s = this.s();
    const w = await getState<WindowState | null>(s, WINDOW_KEY, null);
    if (w && w.moveId === m.id) await this.onSource((db) => db('platform_state').where({ key: WINDOW_KEY }).delete());
    this.window.forget();
    if (m.window.openedAt && !m.window.closedAt) m.window.closedAt = Date.now();
    await this.flushAudit(m);
  }

  private async step(step: MoveStep, m: MoveRecord, a: MoveActor, open: () => Promise<Db>, resumed: boolean): Promise<Record<string, unknown>> {
    const s = this.s();
    switch (step) {
      case 'preflight': {
        const ok = await this.preflight(m);
        if (!ok) throw refused('preflight_failed', `The preflight refused the move: ${m.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`).join(' ')}`, { checks: m.checks });
        return { checks: m.checks.length, budget: m.budget };
      }
      case 'schema': {
        const db = await open();
        const applied = await migrate(db);
        return { applied: applied.length };
      }
      case 'read_only': {
        const openedAt = m.window.openedAt && !m.window.closedAt ? m.window.openedAt : Date.now();
        m.window = { openedAt, closedAt: null };
        await setState(s, WINDOW_KEY, { moveId: m.id, openedAt, leaseUntil: m.lease?.until ?? null, phase: 'cutover' } satisfies WindowState);
        this.window.forget();
        const sleep = this.hooks.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
        // Every instance reads the flag within two seconds; then requests in flight finish, then running jobs.
        await sleep(this.hooks.settleMs ?? 5000);
        const until = Date.now() + (this.hooks.drainMs ?? 120_000);
        let running: number;
        for (;;) {
          running = Number((await s.db('jobs').where({ state: 'running' }).whereNot({ type: 'cloud.db.move' }).count({ n: '*' }))[0]?.n ?? 0);
          if (!running || Date.now() > until) break;
          await sleep(1000);
        }
        return { openedAt, runningJobs: running };
      }
      case 'backup': {
        const tenantId = (await this.platformTenant()) ?? 'platform';
        const b = await s.ops.backups.createNow({ tenantId, actor: this.actorOf(a).actor, userId: this.actorOf(a).userId });
        m.backupId = b.id;
        return { backup: b.id, tables: b.tables, rows: b.rows, bytes: b.bytes };
      }
      case 'restore': {
        if (!m.backupId) throw new Error('No backup to restore.');
        const db = await open();
        const client = m.view?.client === 'sqlite' ? 'sqlite' : 'pg';
        // A restore that started before a crash may have committed: the preflight saw the target empty, so replacing is safe.
        const r = await s.ops.backups.restoreInto({ target: db, client, kms: s.kms, from: s.blobs, blobsTo: null, backupId: m.backupId, force: resumed, progress: (x) => this.hooks.progress?.(x) });
        return { rows: r.rows, tables: r.tables, skipped: r.skipped };
      }
      case 'verify':
        return this.verify(m, await open());
      case 'migrate_check': {
        const r = await migrateCheck(await open());
        if (r.state !== 'current') throw refused('migrate_check_failed', `migrate --check on the target: ${r.reason ?? r.state}`, { pending: r.pending, unknown: r.unknown });
        return { database: r.database, pending: 0 };
      }
      case 'switch':
        return this.switchOver(m, a, await open());
    }
  }

  /** Nothing written during the window, the rows as the manifest says, every audit chain verified on the target. */
  private async verify(m: MoveRecord, db: Db): Promise<Record<string, unknown>> {
    const s = this.s();
    if (!m.backupId) throw new Error('No backup to verify.');
    const raw = await s.blobs.get(manifestKeyFor(m.backupId));
    if (!raw) throw new Error(`The manifest of backup ${m.backupId} is gone.`);
    const manifest = (JSON.parse(raw.toString('utf8')) as { manifest: BackupManifest }).manifest;
    const expected = new Map(manifest.tables.map((t) => [t.name, t.rows]));
    // 1. The source took no writes during the window (beyond the backup's own record).
    const sourceTables = (await listTables(s.db, s.cfg.DB_CLIENT)).filter((t) => !VOLATILE_TABLES.has(t) && expected.has(t));
    const own = Number((await s.db('audit_events').where('ts', '>=', m.window.openedAt ?? 0).andWhere('action', 'like', 'platform.backup.%').count({ n: '*' }))[0]?.n ?? 0);
    const changed: string[] = [];
    for (const c of await rowCounts(s.db, sourceTables)) {
      const want = (expected.get(c.table) ?? 0) + (c.table === 'audit_events' ? own : 0);
      if (c.rows !== want) changed.push(`${c.table} (${c.rows - want > 0 ? '+' : ''}${c.rows - want})`);
    }
    if (changed.length) throw Object.assign(new Error(`The source changed during the window: ${changed.slice(0, 10).join(', ')}. The window is closed again; resume to take a new backup.`), { code: 'writes_during_window' });
    // 2. The target holds what the manifest says.
    const targetTables = new Set(await listTables(db, m.view?.client === 'sqlite' ? 'sqlite' : 'pg'));
    const mismatched: string[] = [];
    for (const c of await rowCounts(db, [...expected.keys()].filter((t) => targetTables.has(t) && t !== 'platform_state'))) if (c.rows !== expected.get(c.table)) mismatched.push(`${c.table} (${c.rows}, the manifest says ${expected.get(c.table)})`);
    if (mismatched.length) throw refused('verify_failed', `The target does not hold the backup: ${mismatched.slice(0, 10).join(', ')}.`);
    // 3. audit:verify on the target, every tenant.
    const log = new AuditLog(db);
    const cps = new AuditCheckpoints(db, log, s.kms, s.blobs, `${s.cfg.OPENBAO_KEY_PREFIX}audit-checkpoints`);
    const tenants = (await db('audit_events').distinct('tenant_id')).map((r: { tenant_id: string }) => r.tenant_id);
    const broken: string[] = [];
    let checked = 0;
    for (const t of tenants) {
      const r = await cps.verify(t);
      checked += r.checked;
      if (r.status !== 'verified') broken.push(t);
    }
    if (broken.length) throw refused('audit_broken', `audit:verify fails on the target for ${broken.length} tenant${broken.length === 1 ? '' : 's'}.`);
    // 4. The window's flag came along in the dump: the target is not in a window.
    await db('platform_state').where({ key: WINDOW_KEY }).delete();
    const conversations = expected.get('conversations') ?? 0;
    return { tables: expected.size, rows: manifest.totalRows, conversations, auditChains: tenants.length, auditEvents: checked };
  }

  /** DATABASE_URL switched in its file; the old database kept read-only. */
  private async switchOver(m: MoveRecord, a: MoveActor, db: Db): Promise<Record<string, unknown>> {
    const s = this.s();
    const target = await this.resolveTarget(m);
    if (!m.switchFile) throw refused('switch_file_required', 'No URL file to switch (DATABASE_URL_FILE).');
    const current = existsSync(m.switchFile) ? readFileSync(m.switchFile, 'utf8').trim() : null;
    if (current !== target.url) {
      if (current != null) writePrivate(`${m.switchFile}.previous`, `${current}\n`, true);
      writePrivate(m.switchFile, `${target.url}\n`, true);
    }
    // The old database: read-only at the database where PostgreSQL lets this role, and the window's flag in any case.
    let oldReadOnly: MoveRecord['oldReadOnly'] = 'flag';
    if (s.cfg.DB_CLIENT === 'pg') {
      try {
        const name = ((await s.db.raw('select current_database() as d')) as { rows: { d: string }[] }).rows[0]!.d;
        await s.db.raw(`ALTER DATABASE ${quoteIdent(name)} SET default_transaction_read_only = on`);
        oldReadOnly = 'database';
      } catch {
        oldReadOnly = 'flag';
      }
    }
    const switchedAt = Date.now();
    m.switchedAt = switchedAt;
    m.keepOldUntil = switchedAt + m.keepOldMs;
    m.oldReadOnly = oldReadOnly;
    await this.onSource((d) => setStateOn(d, WINDOW_KEY, { moveId: m.id, openedAt: m.window.openedAt ?? switchedAt, leaseUntil: null, phase: 'switched' } satisfies WindowState));
    this.window.forget();
    m.window.closedAt = m.switchedAt;
    m.countsAtSwitch = Object.fromEntries((await rowCounts(db, (await listTables(db, m.view?.client === 'sqlite' ? 'sqlite' : 'pg')).filter((t) => !VOLATILE_TABLES.has(t)))).map((c) => [c.table, c.rows]));
    // What the window held back goes to the new database's chain, where the restarted instances read it.
    await this.flushAudit(m, db);
    await this.audit(m, a, 'cloud.db_move.switched', { windowMs: m.switchedAt - (m.window.openedAt ?? m.switchedAt), switchFile: m.switchFile, oldReadOnly, keepOldUntil: m.keepOldUntil }, db);
    return { switchFile: m.switchFile, oldReadOnly, windowMs: m.switchedAt - (m.window.openedAt ?? m.switchedAt), restart: 'Restart every instance: they read DATABASE_URL at start.' };
  }

  // ---------- rollback and finish ----------

  /**
   * Before the switch: the window closes and the install stays on its database (the target is left as it is). After
   * it, within the keep window: the URL file goes back, the old database is writable again, and the new one is put in
   * a window; refused when the new database took writes since the switch, unless `discardNewWrites`.
   */
  async rollback(id: string, a: MoveActor, o: { discardNewWrites?: boolean } = {}): Promise<MoveRecord> {
    const s = this.s();
    const m = await this.get(id);
    if (!['planned', 'approved', 'running', 'failed', 'switched'].includes(m.state)) throw conflict(`The move is ${m.state}; there is nothing to roll back.`);
    if (m.lease && m.lease.holder !== this.worker && m.lease.until > Date.now()) throw conflict('The move is running; wait for it to stop.');
    if (!m.switchedAt) {
      await this.closeWindow(m);
      m.state = 'rolled_back';
      await this.save(m);
      await this.audit(m, a, 'cloud.db_move.rolled_back', { phase: 'before_switch' });
      return m;
    }
    if (m.keepOldUntil && Date.now() > m.keepOldUntil) throw conflict('The keep window of the old database has passed: roll back with a move in the other direction.');
    const target = await this.resolveTarget(m);
    const db = openTarget(target.url);
    try {
      const now = Object.fromEntries((await rowCounts(db, Object.keys(m.countsAtSwitch ?? {}))).map((c) => [c.table, c.rows]));
      const changed = Object.entries(m.countsAtSwitch ?? {}).filter(([t, n]) => now[t] !== n && t !== 'audit_events' && t !== 'sessions').map(([t, n]) => `${t} (${(now[t] ?? 0) - n > 0 ? '+' : ''}${(now[t] ?? 0) - n})`);
      if (changed.length && !o.discardNewWrites) throw refused('writes_since_switch', `The new database took writes since the switch (${changed.slice(0, 10).join(', ')}); a rollback loses them. Move back with db:move in the other direction, or roll back with --discard-new-writes.`, { changed });
      if (!m.switchFile || !existsSync(`${m.switchFile}.previous`)) throw refused('previous_missing', `The previous URL (${m.switchFile ?? '?'}.previous) is gone; put the old URL back by hand.`);
      writePrivate(m.switchFile, readFileSync(`${m.switchFile}.previous`, 'utf8'), true);
      if (m.oldReadOnly === 'database' && s.cfg.DB_CLIENT === 'pg') {
        const name = ((await s.db.raw('select current_database() as d')) as { rows: { d: string }[] }).rows[0]!.d;
        // This session is read-only by the database default; lift it for the session, then reset the default.
        await s.db.transaction(async (trx) => {
          await trx.raw('SET TRANSACTION READ WRITE');
          await trx.raw(`ALTER DATABASE ${quoteIdent(name)} RESET default_transaction_read_only`);
        });
      }
      await this.onSource((d) => d('platform_state').where({ key: WINDOW_KEY }).delete());
      this.window.forget();
      // The new database goes into a window, so an instance not yet restarted changes nothing there.
      await setStateOn(db, WINDOW_KEY, { moveId: m.id, openedAt: Date.now(), leaseUntil: null, phase: 'switched' } satisfies WindowState);
      m.state = 'rolled_back';
      await this.save(m, db);
      await this.audit(m, a, 'cloud.db_move.rolled_back', { phase: 'after_switch', discarded: changed.length ? changed : null });
      return m;
    } finally {
      await db.destroy().catch(() => undefined);
    }
  }

  /** Ends the keep window early (or confirms it ended): the old database may be dropped by the operator now. */
  async finish(id: string, a: MoveActor): Promise<MoveRecord> {
    const m = await this.get(id);
    if (m.state !== 'switched') throw conflict(`The move is ${m.state}, not switched.`);
    m.state = 'finished';
    const target = await this.resolveTarget(m);
    const db = openTarget(target.url);
    try {
      await this.save(m, db);
      await this.audit(m, a, 'cloud.db_move.finished', {}, db);
    } finally {
      await db.destroy().catch(() => undefined);
    }
    return m;
  }

  /** What the console and the CLI show (never a URL or a CA). */
  view(m: MoveRecord) {
    const { pendingAudit, lease, ...rest } = m;
    return { ...rest, heldAuditEntries: pendingAudit.length, running: !!lease && lease.until > Date.now() };
  }
}

// ---------- helpers ----------

function sourceOf(s: Services): MoveRecord['source'] {
  if (s.cfg.DB_CLIENT === 'sqlite') return { client: 'sqlite', host: null, database: s.cfg.SQLITE_FILENAME ?? null };
  try {
    const u = new URL(s.cfg.DATABASE_URL ?? '');
    return { client: s.cfg.DB_CLIENT, host: u.hostname, database: decodeURIComponent(u.pathname.replace(/^\//, '')) || null };
  } catch {
    return { client: s.cfg.DB_CLIENT, host: null, database: null };
  }
}

async function setStateOn(db: Db, key: string, value: unknown): Promise<void> {
  const row = { key, value: JSON.stringify(value), updated_at: Date.now() };
  const n = await db('platform_state').where({ key }).update({ value: row.value, updated_at: row.updated_at });
  if (!n) await db('platform_state').insert(row);
}

/** Writes a file readable by its owner only (0600), atomically when `atomic`. */
function writePrivate(file: string, content: string, atomic: boolean): void {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  if (!atomic) {
    writeFileSync(file, content, { mode: 0o600 });
    return;
  }
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, file);
}

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Strips anything that looks like a password from a driver's message (`postgres://user:pw@`, `password=`). */
export function redact(message: string): string {
  return message.replace(/(\w+:\/\/[^:/\s]+:)[^@\s]+@/g, '$1***@').replace(/(password=)[^&\s]+/gi, '$1***').slice(0, 600);
}
