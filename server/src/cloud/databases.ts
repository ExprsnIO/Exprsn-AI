import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Principal } from '../authz/policy.js';
import { conflict, HttpProblem, notFound } from '../http/problem.js';
import type { Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import type { CloudActor } from './accounts.js';
import { cloudAudit } from './audit.js';
import type { DesiredResource, Deployment, GraphResource } from './graph.js';
import sheetJson from './price-sheet.json' with { type: 'json' };
import type { DatabaseProps, DatabaseSnapshot, ExtensionStatus, ObservedResource, ResourceRef, SnapshotPurpose, SnapshotResult } from './providers/types.js';
import type { Provider } from './types.js';

/*
 * 1.9.99-final, Sprint 59 (B-10301, B-10303, B-10307): managed databases. `s.cloud.databases`.
 *
 * The `database` resource type on AWS (RDS for PostgreSQL and MySQL, Aurora PostgreSQL and MySQL), Azure (Database for
 * PostgreSQL and for MySQL Flexible Server) and DigitalOcean (Managed PostgreSQL and MySQL). The adapters
 * (`providers/aws-rds.ts`, `providers/azure-databases.ts`, `providers/do-databases.ts`) create, change, snapshot and
 * restore them; this module holds what they share and what runs above them:
 *
 * - the engines, the versions each provider offers, the size tiers, and the extension allow-list table (pgvector as
 *   `vector`, PostGIS as `postgis`, `pg_trgm`): what each provider offers per engine and version, and the step that
 *   allows them (Azure's `azure.extensions` server parameter; an RDS parameter group whose `rds.allowed_extensions`
 *   restricts them; DigitalOcean's supported list, which needs no step). `databaseProblems` refuses a plan that asks
 *   for an extension the provider does not offer, naming it, before anything is created;
 * - deletion protection, on by default (`deletionProtection: false` only when the database is created so):
 *   `deletionBlock` is the planner's rule, and the adapters refuse a delete of a protected database unless its final
 *   snapshot exists and is fresh (`FINAL_SNAPSHOT_MAX_AGE_MS`), so no route deletes one without it;
 * - snapshots: listed per database with their cost (the price sheet, `snapshotCost`) and retention; taken on demand or
 *   on a schedule (`cloud_db_snapshot_schedules`, migration 153, which keeps `keep` of them and deletes older ones it
 *   took), and restored to a new instance that joins the deployment's graph, protected.
 *
 * Nothing here runs until a deployment has a database: the schedule tick finds no rows, and every route answers for
 * a database resource only.
 */

export const DB_ENGINES = ['postgres', 'mysql'] as const;
export type DbEngine = (typeof DB_ENGINES)[number];
export const PG_EXTENSIONS = ['vector', 'postgis', 'pg_trgm'] as const;
/** What the render asks for by default: pgvector (the vector store) and pg_trgm (keyword search). PostGIS on request. */
export const DEFAULT_EXTENSIONS = ['vector', 'pg_trgm'];

type DbProvider = Extract<Provider, 'aws' | 'azure' | 'digitalocean'>;
type Offer = 'rds' | 'aurora' | 'azure' | 'digitalocean';

/** The major versions each offer takes (checked at plan time); the first is the default. */
export const ENGINE_VERSIONS: Record<Offer, Record<DbEngine, readonly string[]>> = {
  rds: { postgres: ['17', '16', '15', '14', '13'], mysql: ['8.0', '8.4'] },
  aurora: { postgres: ['16', '15', '14', '13'], mysql: ['8.0'] },
  azure: { postgres: ['17', '16', '15', '14', '13'], mysql: ['8.0', '8.4'] },
  digitalocean: { postgres: ['17', '16', '15', '14', '13'], mysql: ['8'] }
};

/**
 * The PostgreSQL extensions each offer provides for every version above (the providers' supported-extension lists, read
 * 2026-10-20: RDS and Aurora PostgreSQL extension tables, Azure Flexible Server's extension list, DigitalOcean's
 * supported extensions). The sandbox e2e (B-10804) records the versions; `pg_available_extensions` is read where the
 * database is reachable, since a table can be wrong.
 */
const OFFERED: Record<Offer, readonly string[]> = {
  rds: ['vector', 'postgis', 'pg_trgm'],
  aurora: ['vector', 'postgis', 'pg_trgm'],
  azure: ['vector', 'postgis', 'pg_trgm'],
  digitalocean: ['vector', 'postgis', 'pg_trgm']
};

/** How each offer allows an extension before `CREATE EXTENSION` works. */
export const ALLOW_LIST_STEP: Record<Offer, string> = {
  rds: 'none needed by default; a parameter group that sets rds.allowed_extensions gets the extensions added to it',
  aurora: 'none needed by default; a cluster parameter group that sets rds.allowed_extensions gets the extensions added to it',
  azure: 'the azure.extensions server parameter lists them (set before the database is used)',
  digitalocean: 'none: every supported extension can be created'
};

export const offerOf = (provider: DbProvider, p: Pick<DatabaseProps, 'service'>): Offer => (provider === 'aws' ? (p.service === 'aurora' ? 'aurora' : 'rds') : provider);

export function defaultVersion(provider: DbProvider, p: Pick<DatabaseProps, 'service' | 'engine'>): string {
  return ENGINE_VERSIONS[offerOf(provider, p)][p.engine][0]!;
}

/** The major part of a version (`16.4` → `16`, `8.0.36` → `8.0`, `8` → `8`). */
export function majorOf(engine: DbEngine, version: string): string {
  const parts = version.split('.');
  return engine === 'mysql' && parts.length > 1 ? `${parts[0]}.${parts[1]}` : parts[0]!;
}

export function offeredExtensions(provider: DbProvider, p: Pick<DatabaseProps, 'service' | 'engine'>): readonly string[] {
  return p.engine === 'postgres' ? OFFERED[offerOf(provider, p)] : [];
}

/** Azure Flexible Server's compute tier for a SKU name. */
export function azureTier(size: string): 'Burstable' | 'GeneralPurpose' | 'MemoryOptimized' {
  const s = size.replace(/^Standard_/, '');
  if (/^B/i.test(s)) return 'Burstable';
  if (/^E/i.test(s)) return 'MemoryOptimized';
  return 'GeneralPurpose';
}

/** The smallest size a retained copy (a final snapshot that must outlive the database) is made at. */
export const COPY_SIZE: Record<'azure' | 'digitalocean', string> = { azure: 'Standard_B1ms', digitalocean: 'db-s-1vcpu-1gb' };

/** How old a final snapshot may be when the delete it guards runs (the destroy takes it just before). */
export const FINAL_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60_000;

/** A provider name for a database: lower case letters, digits and single dashes, a letter first, at most `max`. */
export function dbIdentifier(prefix: string, name: string, max = 63): string {
  let n = `${prefix}${name}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(n)) n = `x${n}`;
  if (n.length <= max) return n;
  const h = createHash('sha256').update(n).digest('hex').slice(0, 8);
  return `${n.slice(0, max - 9).replace(/-+$/, '')}-${h}`;
}

/** The snapshot name for a purpose (`final` names are what the destroy's guard looks for). */
export function snapshotName(base: string, purpose: SnapshotPurpose, at = Date.now()): string {
  const t = new Date(at).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return dbIdentifier('', `${base}-${purpose === 'final' ? 'final' : purpose === 'scheduled' ? 'sched' : purpose === 'upgrade' ? 'preup' : 'manual'}-${t}`, 63);
}

/** True when a snapshot name says it is a final one (`-final-<time>`, as `snapshotName` and the destroy make them). */
export const isFinalName = (name: string): boolean => /-final-\d{8,}/.test(name);

/** A weekly window `day:HH:MM-day:HH:MM` (RDS) for a maintenance window of one hour. */
export function rdsWindow(w: NonNullable<DatabaseProps['maintenanceWindow']>): string {
  const h = String(w.hour).padStart(2, '0');
  const next = (w.hour + 1) % 24;
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const endDay = next === 0 ? days[(days.indexOf(w.day) + 1) % 7]! : w.day;
  return `${w.day}:${h}:00-${endDay}:${String(next).padStart(2, '0')}:00`;
}

export function parseRdsWindow(s: string | null | undefined): DatabaseProps['maintenanceWindow'] | undefined {
  const m = /^(mon|tue|wed|thu|fri|sat|sun):(\d{2}):\d{2}-/i.exec(s ?? '');
  return m ? { day: m[1]!.toLowerCase() as never, hour: Number(m[2]) } : undefined;
}

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
/** Azure's `dayOfWeek` (0 is Sunday). */
export const azureDay = (d: NonNullable<DatabaseProps['maintenanceWindow']>['day']): number => DAY_NAMES.indexOf(d);
export const dayName = (n: number): (typeof DAY_NAMES)[number] => DAY_NAMES[((n % 7) + 7) % 7]!;
/** DigitalOcean's maintenance day (`monday`...). */
export const doDay = (d: NonNullable<DatabaseProps['maintenanceWindow']>['day']): string => ({ mon: 'monday', tue: 'tuesday', wed: 'wednesday', thu: 'thursday', fri: 'friday', sat: 'saturday', sun: 'sunday' })[d];
export const fromDoDay = (d: string | undefined): NonNullable<DatabaseProps['maintenanceWindow']>['day'] | undefined => (d ? ((({ monday: 'mon', tuesday: 'tue', wednesday: 'wed', thursday: 'thu', friday: 'fri', saturday: 'sat', sunday: 'sun' }) as Record<string, string>)[d.toLowerCase()] as never) : undefined);

/** Azure's `azure.extensions` value with the wanted extensions added (upper case, comma-separated, as Azure shows it). */
export function withAllowed(current: string | null | undefined, wanted: readonly string[]): string {
  const have = (current ?? '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
  for (const w of wanted) if (!have.includes(w.toUpperCase())) have.push(w.toUpperCase());
  return have.join(',');
}

export const allowedSet = (value: string | null | undefined): Set<string> => new Set((value ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));

/** The extension check from what the provider reports: offered for the engine and version, and allowed. */
export function extensionStatus(provider: DbProvider, p: Pick<DatabaseProps, 'service' | 'engine'>, wanted: readonly string[], allowed: Set<string> | '*'): ExtensionStatus[] {
  const offered = offeredExtensions(provider, p);
  const offer = offerOf(provider, p);
  return wanted.map((name) => {
    if (!offered.includes(name)) return { name, state: 'not_offered', source: 'supported_list', detail: p.engine === 'mysql' ? 'MySQL has no extensions.' : `${offer} does not offer ${name}.` };
    if (allowed !== '*' && !allowed.has(name)) return { name, state: 'not_allowed', source: 'allow_list', detail: `Not allowed yet: ${ALLOW_LIST_STEP[offer]}.` };
    return { name, state: 'available', source: allowed === '*' ? 'supported_list' : 'allow_list' };
  });
}

// ---------- the planner's rules ----------

/** Whether a database is protected against deletion: on unless the desired spec turned it off and the provider agrees. */
export function isDeletionProtected(desired: Pick<DesiredResource, 'type' | 'spec'>, observed: Pick<ObservedResource, 'props'> | null | undefined): boolean {
  if (desired.type !== 'database') return false;
  if (desired.spec.deletionProtection !== false) return true;
  return observed?.props.deletionProtection === true;
}

/**
 * The planner's rule for a database step: a delete or replace of a protected database is blocked (only the destroy,
 * with its final snapshot and a second admin, deletes one), and so is turning its protection off.
 */
export function deletionBlock(action: 'delete' | 'replace' | 'update', row: Pick<GraphResource, 'type' | 'key' | 'desired' | 'observed'>, want?: Pick<DesiredResource, 'spec'>): string | null {
  if (row.type !== 'database') return null;
  const prot = isDeletionProtected(row.desired, row.observed);
  if (!prot) return null;
  if (action === 'update') return want && want.spec.deletionProtection === false ? `${row.key} has deletion protection on; it is not turned off by a plan. Destroy the database (a final snapshot and a second admin's approval) instead.` : null;
  return `${row.key} is a database with deletion protection: ${action === 'replace' ? 'replacing it would delete it' : 'deleting it needs its final snapshot and a second admin\'s approval'} (destroy).`;
}

const TIME_WINDOW = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;

/** Why a desired graph's databases cannot be planned on this provider (engine, version, extensions, sizes), named. */
export function databaseProblems(resources: DesiredResource[], provider: Provider): string[] {
  const out: string[] = [];
  for (const r of resources) {
    if (r.type !== 'database') continue;
    if (provider === 'cloudflare') continue; // the adapter answers `not_yet`
    const p = r.spec as Partial<DatabaseProps>;
    const where = `${r.key} (database)`;
    if (!p.engine || !(DB_ENGINES as readonly string[]).includes(p.engine)) {
      out.push(`${where}: engine must be postgres or mysql.`);
      continue;
    }
    if (p.service && (provider !== 'aws' || !['rds', 'aurora'].includes(p.service))) out.push(`${where}: service ${p.service} is AWS's only (rds or aurora).`);
    const offer = offerOf(provider, { service: p.service === 'aurora' ? 'aurora' : 'rds' });
    const versions = ENGINE_VERSIONS[offer][p.engine];
    if (p.version && !versions.includes(majorOf(p.engine, String(p.version)))) out.push(`${where}: ${offer} ${p.engine} ${p.version} is not offered (${versions.join(', ')}).`);
    if (!p.size) out.push(`${where}: a size is required.`);
    const wanted = p.extensions ?? [];
    for (const e of wanted) {
      if (p.engine === 'mysql') out.push(`${where}: extension ${e} is PostgreSQL's; MySQL has no extensions.`);
      else if (!offeredExtensions(provider as DbProvider, { engine: 'postgres', service: p.service === 'aurora' ? 'aurora' : 'rds' }).includes(e)) out.push(`${where}: extension ${e} is not offered by ${offer} PostgreSQL ${p.version ?? defaultVersion(provider as DbProvider, { engine: 'postgres', service: p.service === 'aurora' ? 'aurora' : 'rds' })}.`);
    }
    if (provider === 'azure' && p.ha && p.size && azureTier(p.size) === 'Burstable') out.push(`${where}: Azure offers high availability only on General Purpose and Memory Optimized sizes, not ${p.size}.`);
    if (p.backups) {
      const days = Number(p.backups.days);
      const [lo, hi] = provider === 'aws' ? [1, 35] : provider === 'azure' ? [7, 35] : [7, 7];
      if (!Number.isInteger(days) || days < lo || days > hi) out.push(`${where}: backups.days must be ${lo === hi ? lo : `${lo} to ${hi}`} on ${provider}${provider === 'digitalocean' ? ' (DigitalOcean keeps seven days of backups)' : ''}.`);
      if (p.backups.window && !TIME_WINDOW.test(p.backups.window)) out.push(`${where}: backups.window must be HH:MM-HH:MM (UTC).`);
    }
    if (p.maintenanceWindow) {
      const w = p.maintenanceWindow;
      if (!DAY_NAMES.includes(w.day as never) || !Number.isInteger(w.hour) || w.hour < 0 || w.hour > 23) out.push(`${where}: maintenanceWindow needs a day (mon..sun) and an hour 0 to 23 (UTC).`);
    }
    if (p.storageGb != null && (!Number.isInteger(p.storageGb) || p.storageGb < 10 || p.storageGb > 65536)) out.push(`${where}: storageGb must be 10 to 65536.`);
    for (const [k, v] of Object.entries(p.parameters ?? {})) {
      if (!/^[a-z_][a-z0-9_.]{0,127}$/i.test(k) || typeof v !== 'string' || v.length > 4096) out.push(`${where}: parameter ${k.slice(0, 60)} is not a valid name and value.`);
    }
    if (p.adminPasswordRef && !/^vault:/.test(p.adminPasswordRef)) out.push(`${where}: adminPasswordRef must be a vault: reference, never a value.`);
  }
  return out;
}

// ---------- snapshot costs (the price sheet) ----------

interface SheetEntry {
  provider: Provider;
  region: string;
  sku: string;
  unit: string;
  price: number;
  source: string;
  date: string;
  unverified?: boolean;
}
const SHEET = sheetJson as { currency: string; prices: SheetEntry[] };

export interface SnapshotCost {
  monthly: number | null;
  currency: string;
  sku: string;
  unit: string;
  price: number | null;
  source: string | null;
  date: string | null;
  /** The sheet's price is not confirmed yet (`"unverified": true`): shown, never put in an estimate's total. */
  unverified: boolean;
  note?: string;
}

/** What one snapshot costs a month, from the price sheet (cloud/prices.ts's sheet; the price APIs price no snapshots). */
export function snapshotCost(provider: Provider, snap: Pick<DatabaseSnapshot, 'billing' | 'sizeGb' | 'kind'>, region = '*'): SnapshotCost | null {
  if (!snap.billing) return null;
  const currency = SHEET.currency;
  if (snap.billing.unit === 'included') return { monthly: 0, currency, sku: snap.billing.sku, unit: 'included', price: 0, source: null, date: null, unverified: false, note: snap.kind === 'automated' ? 'Included in the database price up to its storage size.' : 'Included: a time inside the provider\'s point-in-time window.' };
  const all = SHEET.prices.filter((e) => e.provider === provider && e.sku === snap.billing!.sku && (e.unit === snap.billing!.unit || (snap.billing!.unit === 'month' && e.unit === 'hour')));
  const e = all.find((x) => x.region === region) ?? all.find((x) => x.region === '*');
  if (!e) return { monthly: null, currency, sku: snap.billing.sku, unit: snap.billing.unit, price: null, source: null, date: null, unverified: false, note: 'No price for it in the price sheet.' };
  const qty = snap.billing.unit === 'gb-month' ? Number(snap.sizeGb ?? 0) : 1;
  const monthly = e.unit === 'hour' ? e.price * 730 : e.price * qty;
  return { monthly: Math.round(monthly * 100) / 100, currency, sku: e.sku, unit: e.unit, price: e.price, source: e.source, date: e.date, unverified: !!e.unverified, ...(e.unverified ? { note: 'The sheet\'s price is not confirmed yet; it is shown but never put in a total.' } : {}) };
}

/** Retention in words, for the list. */
export function retentionOf(s: Pick<DatabaseSnapshot, 'expiresAt' | 'kind' | 'final'>, now = Date.now()): string {
  if (s.final) return 'Kept until deleted by hand (the final snapshot).';
  if (s.expiresAt) return `Deleted by the provider in ${Math.max(0, Math.ceil((s.expiresAt - now) / 86_400_000))} days.`;
  return s.kind === 'manual' ? 'Kept until deleted (a scheduled snapshot is deleted once more than the schedule keeps are newer).' : 'Kept until deleted.';
}

// ---------- the service ----------

export const scheduleSchema = z.object({ everyHours: z.number().int().min(1).max(24 * 30), keep: z.number().int().min(1).max(100), enabled: z.boolean().default(true) }).strict();
export const snapshotNowSchema = z.object({ note: z.string().trim().max(300).optional() }).strict();
export const restoreToNewSchema = z.object({ key: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/).optional(), size: z.string().trim().min(1).max(60).optional() }).strict();

const SCHEDULES = 'cloud_db_snapshot_schedules';
const SCHEMA_RECHECK_MS = 30_000;
const TICK_MS = 15 * 60_000;

export const databasesMissing = () => new HttpProblem(503, 'Not installed', 'Snapshot schedules need the database migration 153_cloud_databases, which has not been applied.', { extensions: { reason: 'migration_pending' } });

export interface SnapshotSchedule {
  deploymentId: string;
  key: string;
  everyHours: number;
  keep: number;
  enabled: boolean;
  nextAt: number;
  lastAt: number | null;
  lastSnapshot: string | null;
  lastError: string | null;
  updatedBy: string | null;
  updatedAt: number;
}

export interface DatabaseView {
  key: string;
  providerId: string | null;
  state: string;
  engine: string | null;
  service: string | null;
  version: string | null;
  size: string | null;
  ha: boolean;
  storageGb: number | null;
  backups: { days: number | null; window: string | null };
  maintenanceWindow: DatabaseProps['maintenanceWindow'] | null;
  deletionProtection: boolean;
  publicAccess: boolean | null;
  privateEndpoint: boolean | null;
  extensions: string[];
  parameters: Record<string, string>;
  endpoint: string | null;
  schedule: SnapshotSchedule | null;
}

const scheduleFrom = (r: Record<string, unknown>): SnapshotSchedule => ({
  deploymentId: String(r.deployment_id),
  key: String(r.resource_key),
  everyHours: Number(r.every_hours),
  keep: Number(r.keep),
  enabled: !!r.enabled,
  nextAt: Number(r.next_at),
  lastAt: r.last_at == null ? null : Number(r.last_at),
  lastSnapshot: (r.last_snapshot as string | null) ?? null,
  lastError: (r.last_error as string | null) ?? null,
  updatedBy: (r.updated_by as string | null) ?? null,
  updatedAt: Number(r.updated_at)
});

export interface DatabaseOptions {
  /** How long a snapshot or restore is followed. */
  maxWaitMs: number;
  waitCapMs: number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class CloudDatabases {
  options: DatabaseOptions = { maxWaitMs: 2 * 60 * 60_000, waitCapMs: 30_000, sleep: (ms) => new Promise((r) => setTimeout(r, ms).unref?.()) };
  private schema: { ok: boolean; at: number } | null = null;

  constructor(private readonly s: () => Services) {}

  private get deployments() {
    return this.s().cloud.deployments;
  }

  async installed(): Promise<boolean> {
    const t = Date.now();
    if (this.schema && (this.schema.ok || t - this.schema.at < SCHEMA_RECHECK_MS)) return this.schema.ok;
    let ok: boolean;
    try {
      ok = await this.s().db.schema.hasTable(SCHEDULES);
    } catch {
      ok = false;
    }
    this.schema = { ok, at: t };
    return ok;
  }

  resetSchemaCache(): void {
    this.schema = null;
  }

  /** A deployment's database resource, as the caller may see it. */
  private async row(p: Principal, deploymentId: string, key: string): Promise<{ d: Deployment; row: GraphResource }> {
    const d = await this.deployments.getFor(p, deploymentId);
    const row = await this.deployments.resource(d.id, key);
    if (!row || row.type !== 'database' || row.state === 'deleted') throw notFound('Database');
    return { d, row };
  }

  private refOf(row: GraphResource): ResourceRef {
    if (!row.providerId) throw conflict(`${row.key} has not been created yet.`);
    return { type: 'database', providerId: row.providerId, region: row.region, ...(row.locator ? { locator: row.locator } : {}) };
  }

  private async scheduleOf(deploymentId: string, key: string): Promise<SnapshotSchedule | null> {
    if (!(await this.installed())) return null;
    const r = await this.s().db(SCHEDULES).where({ deployment_id: deploymentId, resource_key: key }).first();
    return r ? scheduleFrom(r as Record<string, unknown>) : null;
  }

  /** The deployment's databases: engine, version, size, HA, storage, backups, maintenance, protection, extensions, schedule. */
  async list(p: Principal, deploymentId: string): Promise<DatabaseView[]> {
    const d = await this.deployments.getFor(p, deploymentId);
    const rows = (await this.deployments.resources(d.id)).filter((r) => r.type === 'database');
    return Promise.all(rows.map(async (r) => this.view(r, await this.scheduleOf(d.id, r.key))));
  }

  view(r: GraphResource, schedule: SnapshotSchedule | null): DatabaseView {
    const want = r.desired.spec as Partial<DatabaseProps>;
    const o = (r.observed?.props ?? {}) as Record<string, unknown>;
    const pick = <T>(k: string, fallback: T): T => (o[k] !== undefined ? (o[k] as T) : fallback);
    const backups = pick<{ days?: number; window?: string } | undefined>('backups', want.backups);
    return {
      key: r.key,
      providerId: r.providerId,
      state: r.state,
      engine: pick('engine', want.engine ?? null),
      service: pick('service', want.service ?? null),
      version: pick('version', want.version ?? null),
      size: pick('size', want.size ?? null),
      ha: !!pick('ha', want.ha ?? false),
      storageGb: pick('storageGb', want.storageGb ?? null),
      backups: { days: backups?.days ?? null, window: backups?.window ?? null },
      maintenanceWindow: pick('maintenanceWindow', want.maintenanceWindow ?? null),
      deletionProtection: isDeletionProtected(r.desired, r.observed),
      publicAccess: pick('publicAccess', want.publicAccess ?? null),
      privateEndpoint: pick('privateEndpoint', want.privateEndpoint ?? null),
      extensions: want.extensions ?? [],
      parameters: pick('parameters', want.parameters ?? {}),
      endpoint: (o.endpoint as string | undefined) ?? null,
      schedule
    };
  }

  /** The extension check: what the provider offers and allows for the database's wanted extensions. */
  async extensions(p: Principal, deploymentId: string, key: string, names?: string[]): Promise<{ key: string; engine: string; extensions: ExtensionStatus[]; allAvailable: boolean }> {
    const { d, row } = await this.row(p, deploymentId, key);
    const spec = row.desired.spec as Partial<DatabaseProps>;
    const wanted = names?.length ? names : (spec.extensions ?? []);
    const c = await this.deployments.context(d, 'read');
    if (!c.provider.databaseExtensions) throw new HttpProblem(409, 'Conflict', `This build checks no database extensions on ${d.provider}.`, { extensions: { reason: 'unsupported' } });
    const out = await c.provider.databaseExtensions(c.ctx(row.region), this.refOf(row), wanted);
    return { key, engine: String(spec.engine ?? 'postgres'), extensions: out, allAvailable: out.every((x) => x.state === 'available') };
  }

  /** The database's snapshots and backups, with their cost and retention. */
  async snapshots(p: Principal, deploymentId: string, key: string): Promise<{ key: string; snapshots: (DatabaseSnapshot & { cost: SnapshotCost | null; retention: string })[]; currency: string; monthly: number }> {
    const { d, row } = await this.row(p, deploymentId, key);
    const c = await this.deployments.context(d, 'read');
    if (!c.provider.listSnapshots) throw new HttpProblem(409, 'Conflict', `This build lists no database snapshots on ${d.provider}.`, { extensions: { reason: 'unsupported' } });
    const list = await c.provider.listSnapshots(c.ctx(row.region), this.refOf(row));
    const snaps = list.map((x) => ({ ...x, cost: snapshotCost(d.provider, x, row.region), retention: retentionOf(x) }));
    const monthly = Math.round(snaps.reduce((n, x) => n + (x.cost && !x.cost.unverified && x.cost.monthly ? x.cost.monthly : 0), 0) * 100) / 100;
    return { key, snapshots: snaps.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)), currency: SHEET.currency, monthly };
  }

  /** Takes a snapshot now (the job `cloud.db.snapshot`). */
  async snapshotNow(a: CloudActor, deploymentId: string, key: string, note: string | null): Promise<{ jobId: string }> {
    const { d, row } = await this.row(a.principal, deploymentId, key);
    this.deployments.assertCanDeploy(a.principal, d);
    this.refOf(row);
    const job = await this.s().jobs.enqueue({ tenantId: d.tenantId, type: 'cloud.db.snapshot', payload: { deploymentId: d.id, key, purpose: 'manual' }, createdBy: a.principal.userId, maxAttempts: 2 });
    await cloudAudit(this.s(), { tenantId: d.tenantId, action: 'cloud.database.snapshot.requested', actor: a, deploymentId: d.id, deploymentName: d.name, resource: { key, type: 'database', providerId: row.providerId }, label: d.label, detail: { job: job.id, purpose: 'manual', note } });
    return { jobId: job.id };
  }

  /** Sets (or turns off) the database's snapshot schedule. */
  async setSchedule(a: CloudActor, deploymentId: string, key: string, input: z.infer<typeof scheduleSchema>): Promise<SnapshotSchedule> {
    if (!(await this.installed())) throw databasesMissing();
    const { d, row } = await this.row(a.principal, deploymentId, key);
    this.deployments.assertCanDeploy(a.principal, d);
    const s = this.s();
    const now = Date.now();
    const existing = await this.scheduleOf(d.id, key);
    const values = { every_hours: input.everyHours, keep: input.keep, enabled: input.enabled, next_at: now + input.everyHours * 3_600_000, updated_by: a.principal.userId, updated_at: now };
    if (existing) await s.db(SCHEDULES).where({ deployment_id: d.id, resource_key: key }).update(values);
    else await s.db(SCHEDULES).insert({ deployment_id: d.id, tenant_id: d.tenantId, resource_key: key, last_at: null, last_snapshot: null, last_error: null, created_at: now, ...values });
    await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.database.schedule.set', actor: a, deploymentId: d.id, deploymentName: d.name, resource: { key, type: 'database', providerId: row.providerId }, label: d.label, detail: { everyHours: input.everyHours, keep: input.keep, enabled: input.enabled, before: existing ? { everyHours: existing.everyHours, keep: existing.keep, enabled: existing.enabled } : null } });
    return (await this.scheduleOf(d.id, key))!;
  }

  /** Restores a snapshot to a new instance (the job `cloud.db.restore`); the new database joins the graph, protected. */
  async restore(a: CloudActor, deploymentId: string, key: string, snapshotId: string, input: z.infer<typeof restoreToNewSchema>): Promise<{ jobId: string; key: string }> {
    const { d, row } = await this.row(a.principal, deploymentId, key);
    this.deployments.assertCanDeploy(a.principal, d);
    this.refOf(row);
    const taken = new Set((await this.deployments.resources(d.id, { includeDeleted: true })).map((r) => r.key));
    let newKey = input.key ?? `${key}-restored`;
    for (let i = 2; taken.has(newKey) && i < 100; i++) newKey = `${(input.key ?? `${key}-restored`).slice(0, 58)}-${i}`;
    if (taken.has(newKey)) throw conflict(`${newKey} is taken in this deployment.`);
    const job = await this.s().jobs.enqueue({ tenantId: d.tenantId, type: 'cloud.db.restore', payload: { deploymentId: d.id, key, snapshotId, newKey, ...(input.size ? { size: input.size } : {}) }, createdBy: a.principal.userId, maxAttempts: 1 });
    await cloudAudit(this.s(), { tenantId: d.tenantId, action: 'cloud.database.restore.requested', actor: a, deploymentId: d.id, deploymentName: d.name, resource: { key, type: 'database', providerId: row.providerId }, label: d.label, detail: { job: job.id, snapshot: snapshotId, newKey } });
    return { jobId: job.id, key: newKey };
  }

  // ---------- the jobs ----------

  registerJobs(): void {
    const s = this.s();
    s.jobs.register('cloud.db.snapshot', async (p, ctx) => this.runSnapshot(String(p.deploymentId), String(p.key), (p.purpose as SnapshotPurpose) ?? 'manual', { jobId: ctx.job.id, onBehalfOf: ctx.job.created_by ?? null, ...(ctx.signal ? { signal: ctx.signal } : {}) }), { timeoutMs: 3 * 60 * 60_000 });
    s.jobs.register('cloud.db.restore', async (p, ctx) => this.runRestore(p as { deploymentId: string; key: string; snapshotId: string; newKey: string; size?: string }, { jobId: ctx.job.id, onBehalfOf: ctx.job.created_by ?? null, ...(ctx.signal ? { signal: ctx.signal } : {}) }), { timeoutMs: 3 * 60 * 60_000 });
    s.jobs.register('cloud.db.schedules', async (p, ctx) => this.tick(String(p.tenantId ?? ctx.job.tenant_id)));
  }

  /** The tenants with a snapshot schedule due (none until someone sets one). */
  async targets(now = Date.now()): Promise<{ tenantId: string; payload: Record<string, unknown>; key: string }[]> {
    if (!(await this.installed())) return [];
    const rows = (await this.s().db(SCHEDULES).where({ enabled: true }).andWhere('next_at', '<=', now).distinct('tenant_id')) as { tenant_id: string }[];
    return rows.map((r) => ({ tenantId: r.tenant_id, payload: { tenantId: r.tenant_id }, key: r.tenant_id }));
  }

  schedule(scheduler: Scheduler): void {
    scheduler.every('cloud.db.schedules', TICK_MS, () => this.targets());
  }

  /** Queues a tenant's snapshots that are due. */
  async tick(tenantId: string, now = Date.now()): Promise<{ queued: number }> {
    if (!(await this.installed())) return { queued: 0 };
    const s = this.s();
    const due = ((await s.db(SCHEDULES).where({ enabled: true, tenant_id: tenantId }).andWhere('next_at', '<=', now).limit(200)) as Record<string, unknown>[]).map(scheduleFrom);
    let queued = 0;
    for (const x of due) {
      const d = await this.deployments.get(x.deploymentId);
      await s.db(SCHEDULES).where({ deployment_id: x.deploymentId, resource_key: x.key }).update({ next_at: now + x.everyHours * 3_600_000 });
      if (!d || d.state === 'destroyed' || d.state === 'destroying') continue;
      await s.jobs.enqueue({ tenantId: d.tenantId, type: 'cloud.db.snapshot', payload: { deploymentId: d.id, key: x.key, purpose: 'scheduled' }, createdBy: x.updatedBy, dedupeKey: `cloud.db.snapshot:${d.id}:${x.key}:${Math.floor(now / 60_000)}`, maxAttempts: 2 });
      queued++;
    }
    return { queued };
  }

  /** Follows a snapshot (or restore) until it settles. */
  private async follow(provider: { snapshotStatus?: (ctx: never, ref: ResourceRef, r: SnapshotResult) => Promise<SnapshotResult> }, callCtx: unknown, ref: ResourceRef, r: SnapshotResult, signal?: AbortSignal): Promise<SnapshotResult> {
    const until = Date.now() + this.options.maxWaitMs;
    while (r.state === 'pending') {
      if (!provider.snapshotStatus) return { ...r, state: 'failed', error: 'This adapter cannot follow a snapshot.' };
      if (Date.now() > until) return { ...r, state: 'failed', error: 'It did not finish in time.' };
      await this.options.sleep(Math.min(this.options.waitCapMs, r.waitMs ?? 3000), signal);
      r = await provider.snapshotStatus(callCtx as never, ref, r);
    }
    return r;
  }

  /** `cloud.db.snapshot`: a snapshot taken and followed; a scheduled one prunes what the schedule no longer keeps. */
  async runSnapshot(deploymentId: string, key: string, purpose: SnapshotPurpose, run: { jobId: string; onBehalfOf: string | null; signal?: AbortSignal }): Promise<Record<string, unknown>> {
    const s = this.s();
    const d = await this.deployments.get(deploymentId);
    if (!d) return { skipped: 'no such deployment' };
    const row = await this.deployments.resource(d.id, key);
    if (!row?.providerId || row.state === 'deleted') return { skipped: 'no such database' };
    const c = await this.deployments.context(d, 'deploy');
    const ref = this.refOf(row);
    const actor = { service: 'cloud.db.snapshot', onBehalfOf: run.onBehalfOf, jobId: run.jobId };
    if (!c.provider.snapshot) return { skipped: `${d.provider} takes no database snapshots` };
    const name = snapshotName(`${d.name}-${key}`, purpose);
    let r: SnapshotResult;
    try {
      r = await c.provider.snapshot(c.ctx(row.region, run.signal), ref, name, { purpose });
      r = await this.follow(c.provider as never, c.ctx(row.region, run.signal), ref, r, run.signal);
    } catch (err) {
      if (run.signal?.aborted) throw err;
      r = { state: 'failed', name, snapshotId: null, error: String((err as Error).message ?? err).slice(0, 300) };
    }
    if (purpose === 'scheduled' && (await this.installed())) await s.db(SCHEDULES).where({ deployment_id: d.id, resource_key: key }).update({ last_at: Date.now(), last_snapshot: r.snapshotId, last_error: r.state === 'done' ? null : (r.error ?? 'failed').slice(0, 500) });
    await cloudAudit(s, { tenantId: d.tenantId, action: r.state === 'done' ? 'cloud.database.snapshot.taken' : 'cloud.database.snapshot.failed', actor, deploymentId: d.id, deploymentName: d.name, resource: { key, type: 'database', providerId: row.providerId }, label: d.label, ...(r.requestId ? { providerRequestId: r.requestId } : {}), detail: { purpose, name, snapshot: r.snapshotId, error: r.error ?? null } });
    let pruned: string[] = [];
    if (r.state === 'done' && purpose === 'scheduled') pruned = await this.prune(d, row, c, actor);
    return { state: r.state, snapshot: r.snapshotId, name, pruned };
  }

  /** Deletes the schedule's own snapshots beyond `keep` (never a final, manual or provider-made one). */
  private async prune(d: Deployment, row: GraphResource, c: Awaited<ReturnType<CloudDatabases['deployments']['context']>>, actor: { service: string; onBehalfOf: string | null; jobId: string }): Promise<string[]> {
    const sched = await this.scheduleOf(d.id, row.key);
    if (!sched || !c.provider.listSnapshots || !c.provider.deleteSnapshot) return [];
    const ref = this.refOf(row);
    const mine = (await c.provider.listSnapshots(c.ctx(row.region), ref)).filter((x) => x.kind === 'manual' && !x.final && /-sched-\d{8,}/.test(x.name) && x.name.startsWith(dbIdentifier('', `${d.name}-${row.key}`, 63).slice(0, 40))).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    const out: string[] = [];
    for (const x of mine.slice(sched.keep)) {
      await c.provider.deleteSnapshot(c.ctx(row.region), ref, x.id);
      out.push(x.id);
    }
    if (out.length) await cloudAudit(this.s(), { tenantId: d.tenantId, action: 'cloud.database.snapshot.pruned', actor, deploymentId: d.id, deploymentName: d.name, resource: { key: row.key, type: 'database', providerId: row.providerId }, label: d.label, detail: { deleted: out, keep: sched.keep } });
    return out;
  }

  /**
   * A restored database (a new instance) taken into the graph beside the one it came from: protected, in the same
   * network, with the source's desired spec and `restoreFrom`. Returns its key. (The upgrade's restore uses it too.)
   */
  async adoptRestored(d: Deployment, row: GraphResource, restoredId: string, snapshotId: string, o: { key?: string; name?: string; size?: string; tags?: Record<string, string> } = {}): Promise<string> {
    const taken = new Set((await this.deployments.resources(d.id, { includeDeleted: true })).map((r) => r.key));
    let key = o.key ?? `${row.key}-restored`;
    for (let i = 2; taken.has(key) && i < 100; i++) key = `${(o.key ?? `${row.key}-restored`).slice(0, 58)}-${i}`;
    const c = await this.deployments.context(d, 'read');
    const observed = await c.provider.describe(c.ctx(row.region), { type: 'database', providerId: restoredId, region: row.region, ...(row.locator ? { locator: row.locator } : {}) });
    const desired: DesiredResource = { ...row.desired, key, name: o.name ?? observed?.name ?? key, protect: true, spec: { ...row.desired.spec, ...(o.size ? { size: o.size } : {}), restoreFrom: snapshotId, deletionProtection: true } };
    await this.deployments.upsertResource(d.id, desired, row.region, { providerId: restoredId, observed, state: observed?.state === 'ready' ? 'ready' : 'creating', ...(row.locator ? { locator: row.locator } : {}), ...(o.tags ? { tags: o.tags } : {}) });
    await this.deployments.bump(d.id);
    return key;
  }

  /** `cloud.db.restore`: a snapshot restored to a new instance, which joins the graph (protected, in the same network). */
  async runRestore(p: { deploymentId: string; key: string; snapshotId: string; newKey: string; size?: string }, run: { jobId: string; onBehalfOf: string | null; signal?: AbortSignal }): Promise<Record<string, unknown>> {
    const s = this.s();
    const d = await this.deployments.get(p.deploymentId);
    if (!d) return { skipped: 'no such deployment' };
    const row = await this.deployments.resource(d.id, p.key);
    if (!row?.providerId) return { skipped: 'no such database' };
    const c = await this.deployments.context(d, 'deploy');
    const ref = this.refOf(row);
    const actor = { service: 'cloud.db.restore', onBehalfOf: run.onBehalfOf, jobId: run.jobId };
    const fail = async (error: string) => {
      await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.database.restore.failed', actor, deploymentId: d.id, deploymentName: d.name, resource: { key: p.key, type: 'database', providerId: row.providerId }, label: d.label, detail: { snapshot: p.snapshotId, newKey: p.newKey, error: error.slice(0, 500) } });
      return { state: 'failed', error };
    };
    if (!c.provider.restoreSnapshot) return fail(`This build cannot restore a database snapshot on ${d.provider}.`);
    const name = dbIdentifier('', `${d.name}-${p.newKey}`, 60);
    const tags = { 'exprsn:managed': 'true', 'exprsn:account': c.account.name, 'exprsn:deployment': d.name };
    let r: SnapshotResult;
    try {
      r = await c.provider.restoreSnapshot(c.ctx(row.region, run.signal), ref, p.snapshotId, { name, tags });
      r = await this.follow(c.provider as never, c.ctx(row.region, run.signal), ref, r, run.signal);
    } catch (err) {
      if (run.signal?.aborted) throw err;
      return fail(String((err as Error).message ?? err));
    }
    if (r.state !== 'done' || !r.restoredId) return fail(r.error ?? 'The restore did not finish.');
    await this.adoptRestored(d, row, r.restoredId, p.snapshotId, { key: p.newKey, name, ...(p.size ? { size: p.size } : {}), tags });
    await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.database.restored', actor, deploymentId: d.id, deploymentName: d.name, resource: { key: p.newKey, type: 'database', providerId: r.restoredId }, label: d.label, detail: { from: p.key, snapshot: p.snapshotId, restoredId: r.restoredId } });
    return { state: 'restored', key: p.newKey, providerId: r.restoredId };
  }
}
