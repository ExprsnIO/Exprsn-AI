import { COPY_SIZE, dbIdentifier, defaultVersion, doDay, extensionStatus, FINAL_SNAPSHOT_MAX_AGE_MS, fromDoDay, isFinalName, majorOf } from '../databases.js';
import { namePrefix } from '../tags.js';
import { CloudProviderError, type CallContext, type DatabaseProps, type DatabaseSnapshot, type ExtensionStatus, type ListFilter, type ObservedResource, type OperationHandle, type OperationResult, type PollResult, type ResourceRef, type ResourceSpec, type SnapshotPurpose, type SnapshotResult } from './types.js';

/*
 * 1.9.99-final, Sprint 59 (B-10301, B-10303, B-10307): DigitalOcean Managed PostgreSQL and MySQL as the `database`
 * type, on the adapter's call path (the transport, the egress guard and the rate limiter).
 *
 * - The cluster: `POST /v2/databases` in the data VPC (`private_network_uuid`), the size, a standby node for HA, the
 *   storage, the tags; followed until `online`, then (the same operation, `describe` with the phase in the token) its
 *   settings: trusted sources (the database firewall) from the data zone's cloud firewall sources, else the VPC's
 *   range, so nothing outside reaches it (DigitalOcean keeps a public host name; the firewall refuses it), the
 *   maintenance window, the engine config (parameters). The password DigitalOcean answers with is dropped, never
 *   stored (reset it when connecting: B-10302, B-10306).
 * - Deletion protection: DigitalOcean has none, so it is a tag (`exprsn-deletion-protection`) the adapter honours: a
 *   delete of a tagged cluster is refused unless its final snapshot exists and is fresh (`final_snapshot_required`).
 * - Snapshots: DigitalOcean takes a backup every day and keeps seven days, with point-in-time recovery inside them,
 *   and offers no on-demand backup. A final (or manual) snapshot is a retained fork (`backup_restore` from the latest
 *   point, at the smallest size, tagged `exprsn:snapshot-of:<id>`); an upgrade's is a restore point (`pitr:<time>`)
 *   inside the window. Restore to a new instance forks from a backup, a restore point or a fork.
 * - Extensions: DigitalOcean's supported list (pgvector, PostGIS, pg_trgm on every version offered); no allow-list.
 */

export interface DoDatabasesHost {
  call<T>(ctx: CallContext, method: string, path: string, body?: unknown): Promise<{ status: number; body: T; requestId: string | null }>;
  all<T>(ctx: CallContext, path: string, key: string): Promise<T[]>;
  region(ctx: CallContext, spec?: ResourceSpec): string;
}

interface DoDb {
  id: string;
  name: string;
  engine: string;
  version: string;
  status: string;
  size: string;
  region: string;
  num_nodes: number;
  private_network_uuid?: string;
  storage_size_mib?: number;
  tags?: string[] | null;
  maintenance_window?: { day?: string; hour?: string } | null;
  connection?: { host?: string; port?: number } & Record<string, unknown>;
  private_connection?: { host?: string; port?: number } & Record<string, unknown>;
  created_at?: string;
}

interface Phase {
  phase: 'cluster' | 'settings';
  /** The data zone's cloud firewall and network (provider ids), for the trusted sources. */
  firewallId?: string | null;
  networkId?: string | null;
  sources?: string[] | null;
  maintenance?: DatabaseProps['maintenanceWindow'] | null;
  parameters?: Record<string, string> | null;
  protect?: boolean;
}

export const PROTECT_TAG = 'exprsn-deletion-protection';
const OPEN = new Set(['0.0.0.0/0', '::/0']);
const engineOf = (e: string): 'postgres' | 'mysql' => (e === 'mysql' ? 'mysql' : 'postgres');
const doEngine = (e: 'postgres' | 'mysql') => (e === 'mysql' ? 'mysql' : 'pg');

function parseTags(list: string[] | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of list ?? []) {
    const m = /^(exprsn:[a-z-]+):(.*)$/.exec(t);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}
const managed = (t: Record<string, string>) => Object.fromEntries(Object.entries(t).filter(([k]) => !['exprsn:name', 'exprsn:purpose', 'exprsn:snapshot-of', 'exprsn:taken', 'exprsn:restored-from'].includes(k)));
const tagStrings = (tags: Record<string, string>) => Object.entries(tags).map(([k, v]) => `${k}:${v}`);
const stamp = (t = Date.now()) => new Date(t).toISOString().replace(/[-:T]/g, '').slice(0, 12);
const fromStamp = (s: string | undefined): number | null => {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s ?? '');
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) : null;
};

export class DoDatabases {
  constructor(private readonly h: DoDatabasesHost) {}

  clusterName(ctx: CallContext, spec: { name: string }): string {
    return dbIdentifier(namePrefix(ctx.account.name), spec.name, 63);
  }

  private async get(ctx: CallContext, id: string): Promise<DoDb | null> {
    try {
      return (await this.h.call<{ database: DoDb }>(ctx, 'GET', `/v2/databases/${encodeURIComponent(id)}`)).body.database;
    } catch (err) {
      if (err instanceof CloudProviderError && err.status === 404) return null;
      throw err;
    }
  }

  private async rules(ctx: CallContext, id: string): Promise<{ type: string; value: string }[]> {
    try {
      return (await this.h.call<{ rules?: { type: string; value: string }[] }>(ctx, 'GET', `/v2/databases/${encodeURIComponent(id)}/firewall`)).body.rules ?? [];
    } catch (err) {
      if (err instanceof CloudProviderError && err.status === 404) return [];
      throw err;
    }
  }

  private async config(ctx: CallContext, id: string): Promise<Record<string, string>> {
    try {
      const c = (await this.h.call<{ config?: Record<string, unknown> }>(ctx, 'GET', `/v2/databases/${encodeURIComponent(id)}/config`)).body.config ?? {};
      return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, String(v)]));
    } catch (err) {
      if (err instanceof CloudProviderError && err.status === 404) return {};
      throw err;
    }
  }

  private async observed(ctx: CallContext, db: DoDb): Promise<ObservedResource> {
    const engine = engineOf(db.engine);
    const tags = parseTags(db.tags);
    const rules = await this.rules(ctx, db.id);
    const day = fromDoDay(db.maintenance_window?.day);
    const hour = db.maintenance_window?.hour ? Number(db.maintenance_window.hour.split(':')[0]) : undefined;
    const host = db.private_connection?.host ?? null;
    const props: Record<string, unknown> = {
      engine,
      version: majorOf(engine, db.version),
      size: db.size,
      ha: db.num_nodes > 1,
      ...(db.storage_size_mib ? { storageGb: Math.round(db.storage_size_mib / 1024) } : {}),
      backups: { days: 7 },
      ...(day && hour != null ? { maintenanceWindow: { day, hour } } : {}),
      deletionProtection: (db.tags ?? []).includes(PROTECT_TAG),
      publicAccess: !rules.length || rules.some((r) => r.type === 'ip_addr' && OPEN.has(r.value)),
      privateEndpoint: !!db.private_network_uuid,
      trustedSources: rules.map((r) => `${r.type}:${r.value}`),
      parameters: await this.config(ctx, db.id),
      // The data tier (B-10302) reads endpoint (the private host), port and dbName.
      endpoint: host,
      port: db.private_connection?.port ?? 25060,
      dbName: 'defaultdb',
      status: db.status,
      networkId: db.private_network_uuid ?? null
    };
    const state: ObservedResource['state'] = db.status === 'online' ? 'ready' : db.status === 'creating' || db.status === 'forking' || db.status === 'restoring' ? 'creating' : db.status === 'resizing' || db.status === 'migrating' ? 'updating' : db.status === 'offline' ? 'failed' : 'updating';
    return { type: 'database', providerId: db.id, name: tags['exprsn:name'] ?? db.name, region: db.region, state, tags: managed(tags), props, ...(db.private_network_uuid ? { locator: { networkId: db.private_network_uuid } } : {}) };
  }

  // ---------- reads ----------

  async find(ctx: CallContext, spec: ResourceSpec): Promise<ObservedResource | null> {
    const name = this.clusterName(ctx, spec);
    const db = (await this.h.all<DoDb>(ctx, `/v2/databases?tag_name=${encodeURIComponent(`exprsn:account:${ctx.account.name}`)}`, 'databases')).find((x) => x.name === name && (x.engine === 'pg' || x.engine === 'mysql'));
    return db ? this.observed(ctx, db) : null;
  }

  async describe(ctx: CallContext, ref: ResourceRef): Promise<ObservedResource | null> {
    const db = await this.get(ctx, ref.providerId);
    return db ? this.observed(ctx, db) : null;
  }

  async list(ctx: CallContext, filter: ListFilter): Promise<ObservedResource[]> {
    const all = await this.h.all<DoDb>(ctx, filter.managedOnly ? `/v2/databases?tag_name=${encodeURIComponent(`exprsn:account:${ctx.account.name}`)}` : '/v2/databases', 'databases');
    const out: ObservedResource[] = [];
    for (const db of all) {
      if (db.engine !== 'pg' && db.engine !== 'mysql') continue; // Valkey clusters are caches (`do-cache.ts`)
      if (parseTags(db.tags)['exprsn:snapshot-of']) continue; // a retained fork is a snapshot, not a database
      if (filter.networkId && db.private_network_uuid !== filter.networkId) continue;
      out.push(await this.observed(ctx, db));
    }
    return out;
  }

  // ---------- create, update, delete ----------

  private phaseOf(spec: ResourceSpec<'database'>): Phase {
    const p = spec.props;
    const refs = spec.parent?.refs ?? {};
    return { phase: 'cluster', firewallId: p.firewall ? (refs[p.firewall] ?? null) : null, networkId: spec.parent?.networkId ?? null, maintenance: p.maintenanceWindow ?? null, parameters: p.parameters ?? null, protect: p.deletionProtection !== false };
  }

  /** The trusted sources: the data zone's cloud firewall sources (never the world), else the database's VPC range. */
  private async sources(ctx: CallContext, ph: Phase, db: DoDb): Promise<string[]> {
    if (ph.sources?.length) return ph.sources;
    const out = new Set<string>();
    if (ph.firewallId) {
      try {
        const fw = (await this.h.call<{ firewall: { inbound_rules?: { sources?: { addresses?: string[] } }[] } }>(ctx, 'GET', `/v2/firewalls/${encodeURIComponent(ph.firewallId)}`)).body.firewall;
        for (const r of fw.inbound_rules ?? []) for (const a of r.sources?.addresses ?? []) if (!OPEN.has(a)) out.add(a);
      } catch (err) {
        if (!(err instanceof CloudProviderError && err.status === 404)) throw err;
      }
    }
    const vpcId = ph.networkId ?? db.private_network_uuid ?? null;
    if (!out.size && vpcId) {
      const vpc = (await this.h.call<{ vpc: { ip_range: string } }>(ctx, 'GET', `/v2/vpcs/${encodeURIComponent(vpcId)}`)).body.vpc;
      out.add(vpc.ip_range);
    }
    if (!out.size) throw new CloudProviderError('A managed database needs trusted sources: the data zone firewall names none and the database has no VPC.', 'digitalocean', 400, 'public_data');
    return [...out];
  }

  private async settings(ctx: CallContext, db: DoDb, ph: Phase): Promise<void> {
    const want = await this.sources(ctx, ph, db);
    const have = await this.rules(ctx, db.id);
    if (have.length !== want.length || !want.every((w) => have.some((r) => r.type === 'ip_addr' && r.value === w))) await this.h.call(ctx, 'PUT', `/v2/databases/${encodeURIComponent(db.id)}/firewall`, { rules: want.map((value) => ({ type: 'ip_addr', value })) });
    if (ph.maintenance) await this.h.call(ctx, 'PUT', `/v2/databases/${encodeURIComponent(db.id)}/maintenance`, { day: doDay(ph.maintenance.day), hour: `${String(ph.maintenance.hour).padStart(2, '0')}:00` });
    if (ph.parameters && Object.keys(ph.parameters).length) {
      const cur = await this.config(ctx, db.id);
      if (Object.entries(ph.parameters).some(([k, v]) => cur[k] !== v)) await this.h.call(ctx, 'PATCH', `/v2/databases/${encodeURIComponent(db.id)}/config`, { config: ph.parameters });
    }
    // Deletion protection is turned on here, never off (only a delete after its final snapshot removes the tag).
    if (ph.protect && !(db.tags ?? []).includes(PROTECT_TAG)) await this.tag(ctx, db.id, PROTECT_TAG, true);
  }

  private async tag(ctx: CallContext, id: string, tag: string, on: boolean): Promise<void> {
    if (on)
      await this.h.call(ctx, 'POST', '/v2/tags', { name: tag }).catch((err) => {
        if (!(err instanceof CloudProviderError && err.status === 422)) throw err;
      });
    await this.h.call(ctx, on ? 'POST' : 'DELETE', `/v2/tags/${encodeURIComponent(tag)}/resources`, { resources: [{ resource_id: id, resource_type: 'database' }] }).catch((err) => {
      if (!(!on && err instanceof CloudProviderError && err.status === 404)) throw err;
    });
  }

  async create(ctx: CallContext, spec: ResourceSpec<'database'>, handle: (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string) => OperationHandle): Promise<OperationResult> {
    const p = spec.props;
    if (p.publicAccess !== false) throw new CloudProviderError('A managed database is private only: publicAccess must be false.', 'digitalocean', 400, 'public_data');
    if (!spec.parent?.networkId) throw new CloudProviderError('A managed database lives in the data VPC (parent.networkId).', 'digitalocean', 400, 'parent_required');
    const ph = this.phaseOf(spec);
    const existing = await this.find(ctx, spec);
    if (existing) return { done: false, operation: handle('create', existing, 'describe', JSON.stringify(ph)), resource: existing, adopted: true };
    const name = this.clusterName(ctx, spec);
    const tags = [...tagStrings(spec.tags), `exprsn:name:${spec.name}`];
    const body: Record<string, unknown> = { name, engine: doEngine(p.engine), version: majorOf(p.engine, p.version ?? defaultVersion('digitalocean', p)), size: p.size, region: this.h.region(ctx, spec), num_nodes: p.ha ? 2 : 1, private_network_uuid: spec.parent.networkId, tags, ...(p.storageGb ? { storage_size_mib: p.storageGb * 1024 } : {}) };
    if (p.restoreFrom) Object.assign(body, { backup_restore: await this.restorePoint(ctx, p.restoreFrom) });
    const r = await this.h.call<{ database: DoDb }>(ctx, 'POST', '/v2/databases', body);
    const db = { ...r.body.database, connection: undefined, private_connection: r.body.database.private_connection ? { host: r.body.database.private_connection.host, port: r.body.database.private_connection.port } : undefined } as DoDb;
    const o = await this.observed(ctx, db);
    return { done: false, operation: handle('create', o, 'describe', JSON.stringify(ph)), resource: o, ...(r.requestId ? { requestId: r.requestId } : {}) };
  }

  async update(ctx: CallContext, ref: ResourceRef, spec: ResourceSpec<'database'>, handle: (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string) => OperationHandle): Promise<OperationResult> {
    const p = spec.props;
    if (p.publicAccess !== false) throw new CloudProviderError('A managed database is private only: publicAccess must be false.', 'digitalocean', 400, 'public_data');
    const db = await this.get(ctx, ref.providerId);
    if (!db) throw new CloudProviderError(`Database ${ref.providerId} no longer exists.`, 'digitalocean', 404, 'not_found');
    const nodes = p.ha ? 2 : 1;
    const mib = p.storageGb ? p.storageGb * 1024 : undefined;
    if (db.size !== p.size || db.num_nodes !== nodes || (mib && (db.storage_size_mib ?? 0) < mib)) await this.h.call(ctx, 'PUT', `/v2/databases/${encodeURIComponent(db.id)}/resize`, { size: p.size, num_nodes: nodes, ...(mib ? { storage_size_mib: mib } : {}) });
    const ph = { ...this.phaseOf(spec), protect: this.phaseOf(spec).protect || (db.tags ?? []).includes(PROTECT_TAG) };
    return { done: false, operation: handle('update', ref, 'describe', JSON.stringify(ph)) };
  }

  async poll(ctx: CallContext, h: OperationHandle): Promise<PollResult> {
    const db = await this.get(ctx, h.ref.providerId);
    if (h.op === 'delete') return db ? { state: 'pending', waitMs: 3000 } : { state: 'succeeded', resource: null };
    if (!db) return { state: 'failed', error: `${h.ref.providerId} disappeared.`, code: 'not_found' };
    if (db.status === 'offline') return { state: 'failed', error: `${db.name} is offline.`, code: 'offline' };
    if (db.status !== 'online') return { state: 'pending', waitMs: 5000 };
    let ph: Phase = { phase: 'cluster' };
    try {
      ph = JSON.parse(h.token) as Phase;
    } catch {
      /* an old handle: settings as they are */
    }
    await this.settings(ctx, db, ph);
    return { state: 'succeeded', resource: await this.observed(ctx, (await this.get(ctx, db.id)) ?? db) };
  }

  async delete(ctx: CallContext, ref: ResourceRef, handle: (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string) => OperationHandle): Promise<OperationResult> {
    const db = await this.get(ctx, ref.providerId);
    if (!db) return { done: true, resource: null };
    if ((db.tags ?? []).includes(PROTECT_TAG)) {
      const now = Date.now();
      const final = (await this.forks(ctx, db)).find((f) => f.final && f.state === 'available' && f.createdAt != null && now - f.createdAt <= FINAL_SNAPSHOT_MAX_AGE_MS);
      if (!final) throw new CloudProviderError(`${db.name} has deletion protection on and no final snapshot from the last ${FINAL_SNAPSHOT_MAX_AGE_MS / 3_600_000} hours; it is deleted only by destroy, after its final snapshot.`, 'digitalocean', 409, 'final_snapshot_required');
      await this.tag(ctx, db.id, PROTECT_TAG, false);
    }
    try {
      await this.h.call(ctx, 'DELETE', `/v2/databases/${encodeURIComponent(db.id)}`);
    } catch (err) {
      if (err instanceof CloudProviderError && err.status === 404) return { done: true, resource: null };
      throw err;
    }
    return (await this.get(ctx, db.id)) ? { done: false, operation: handle('delete', ref, 'describe', '{}') } : { done: true, resource: null };
  }

  // ---------- snapshots (B-10307) ----------

  private async forks(ctx: CallContext, db: DoDb): Promise<DatabaseSnapshot[]> {
    const all = await this.h.all<DoDb>(ctx, `/v2/databases?tag_name=${encodeURIComponent(`exprsn:snapshot-of:${db.id}`)}`, 'databases');
    return all.map((f) => {
      const t = parseTags(f.tags);
      return { id: f.id, name: f.name, kind: 'copy', state: f.status === 'online' ? 'available' : f.status === 'offline' ? 'failed' : 'pending', createdAt: fromStamp(t['exprsn:taken']) ?? (f.created_at ? Date.parse(f.created_at) : null), sizeGb: f.storage_size_mib ? Math.round(f.storage_size_mib / 1024) : null, expiresAt: null, final: t['exprsn:purpose'] === 'final' || isFinalName(f.name), billing: { sku: `do-db:${f.size}`, unit: 'month' } } satisfies DatabaseSnapshot;
    });
  }

  async listSnapshots(ctx: CallContext, ref: ResourceRef): Promise<DatabaseSnapshot[]> {
    const db = await this.get(ctx, ref.providerId);
    if (!db) return [];
    const backups = await this.h.all<{ created_at: string; size_gigabytes?: number }>(ctx, `/v2/databases/${encodeURIComponent(db.id)}/backups`, 'backups').catch((err) => {
      if (err instanceof CloudProviderError && err.status === 404) return [];
      throw err;
    });
    const auto: DatabaseSnapshot[] = backups.map((b) => {
      const at = Date.parse(b.created_at);
      return { id: `backup:${b.created_at}`, name: `backup ${b.created_at}`, kind: 'automated', state: 'available', createdAt: Number.isFinite(at) ? at : null, sizeGb: b.size_gigabytes ?? null, expiresAt: Number.isFinite(at) ? at + 7 * 86_400_000 : null, final: false, billing: { sku: 'do-db:backup', unit: 'included' } };
    });
    return [...auto, ...(await this.forks(ctx, db))];
  }

  async snapshot(ctx: CallContext, ref: ResourceRef, name: string, purpose: SnapshotPurpose): Promise<SnapshotResult> {
    const db = await this.get(ctx, ref.providerId);
    if (!db) throw new CloudProviderError(`Database ${ref.providerId} no longer exists.`, 'digitalocean', 404, 'not_found');
    const snapName = dbIdentifier('', name, 63);
    if (purpose === 'scheduled') throw new CloudProviderError('DigitalOcean takes a backup of every database each day and keeps seven days with point-in-time recovery; it offers no on-demand backup, so Exprsn-AI keeps no schedule of its own there.', 'digitalocean', 409, 'provider_schedule');
    if (purpose === 'upgrade') {
      // A restore point inside DigitalOcean's point-in-time window: nothing to wait for, nothing billed.
      return { state: 'done', name: snapName, snapshotId: `pitr:${new Date().toISOString()}` };
    }
    const existing = (await this.forks(ctx, db)).find((f) => f.name === snapName);
    let forkId = existing?.id ?? null;
    if (!forkId) {
      const tags = [...tagStrings(managed(parseTags(db.tags))), `exprsn:snapshot-of:${db.id}`, `exprsn:purpose:${purpose === 'final' ? 'final' : 'manual'}`, `exprsn:taken:${stamp()}`];
      const r = await this.h.call<{ database: DoDb }>(ctx, 'POST', '/v2/databases', { name: snapName, engine: db.engine, version: db.version, size: COPY_SIZE.digitalocean, region: db.region, num_nodes: 1, ...(db.private_network_uuid ? { private_network_uuid: db.private_network_uuid } : {}), tags, backup_restore: { database_name: db.name } });
      forkId = r.body.database.id;
    }
    return { state: 'pending', name: snapName, snapshotId: null, operation: { provider: 'digitalocean', type: 'database', op: 'create', kind: 'describe', ref: { type: 'database', providerId: forkId }, token: JSON.stringify({ snapshot: 'fork', source: db.id }), startedAt: Date.now() }, waitMs: 5000 };
  }

  async snapshotStatus(ctx: CallContext, ref: ResourceRef, pending: SnapshotResult): Promise<SnapshotResult> {
    if (pending.state !== 'pending' || !pending.operation) return pending;
    let t: { snapshot?: string; source?: string; phase?: Phase } = {};
    try {
      t = JSON.parse(pending.operation.token) as typeof t;
    } catch {
      /* not ours */
    }
    const id = pending.operation.ref.providerId;
    const db = await this.get(ctx, id);
    if (!db) return { ...pending, state: 'failed', error: `${id} is gone.` };
    if (db.status === 'offline') return { ...pending, state: 'failed', error: `${db.name} is offline.` };
    if (db.status !== 'online') return { ...pending, waitMs: 5000 };
    const source = await this.get(ctx, t.source ?? ref.providerId);
    // The copy gets the source's trusted sources (never the world), as the restored database gets its settings.
    const sources = source ? (await this.rules(ctx, source.id)).filter((r) => r.type === 'ip_addr' && !OPEN.has(r.value)).map((r) => r.value) : [];
    await this.settings(ctx, db, { phase: 'settings', sources: sources.length ? sources : null, networkId: db.private_network_uuid ?? null, ...(t.snapshot === 'restore' ? { protect: true, ...(t.phase ?? {}) } : { protect: false }) });
    const { operation: _o, ...rest } = pending;
    return t.snapshot === 'restore' ? { ...rest, state: 'done', restoredId: id } : { ...rest, state: 'done', snapshotId: id };
  }

  async deleteSnapshot(ctx: CallContext, ref: ResourceRef, snapshotId: string): Promise<void> {
    const db = await this.get(ctx, ref.providerId);
    const fork = db ? (await this.forks(ctx, db)).find((f) => f.id === snapshotId) : null;
    if (!fork || fork.final) throw new CloudProviderError('Only a manual fork Exprsn-AI took is deleted here; a final snapshot is never deleted by Exprsn-AI, and DigitalOcean\'s own backups expire by themselves.', 'digitalocean', 409, 'final_snapshot');
    await this.h.call(ctx, 'DELETE', `/v2/databases/${encodeURIComponent(snapshotId)}`).catch((err) => {
      if (!(err instanceof CloudProviderError && err.status === 404)) throw err;
    });
  }

  /** DigitalOcean's `backup_restore` for a snapshot id: a backup, a restore point or a fork. */
  private async restorePoint(ctx: CallContext, snapshotId: string, source?: DoDb): Promise<{ database_name: string; backup_created_at?: string }> {
    if (snapshotId.startsWith('pitr:') || snapshotId.startsWith('backup:')) {
      if (!source) throw new CloudProviderError('A restore point is restored from its own database.', 'digitalocean', 400, 'source_required');
      return { database_name: source.name, backup_created_at: snapshotId.slice(snapshotId.indexOf(':') + 1) };
    }
    const fork = await this.get(ctx, snapshotId);
    if (!fork) throw new CloudProviderError(`The snapshot ${snapshotId} is gone.`, 'digitalocean', 404, 'not_found');
    return { database_name: fork.name };
  }

  /** B-10307: a snapshot restored to a new cluster beside the source (its size, standby, VPC, trusted sources). */
  async restore(ctx: CallContext, ref: ResourceRef, snapshotId: string, o: { name?: string; tags?: Record<string, string> } = {}): Promise<SnapshotResult> {
    const src = await this.get(ctx, ref.providerId);
    if (!src) throw new CloudProviderError(`Database ${ref.providerId} no longer exists.`, 'digitalocean', 404, 'not_found');
    const name = dbIdentifier('', o.name ?? `${src.name}-restored-${stamp()}`, 63);
    const existing = (await this.h.all<DoDb>(ctx, `/v2/databases?tag_name=${encodeURIComponent(`exprsn:account:${ctx.account.name}`)}`, 'databases')).find((x) => x.name === name);
    let id = existing?.id ?? null;
    if (!id) {
      const tags = [...tagStrings(o.tags ?? managed(parseTags(src.tags))), `exprsn:name:${name}`];
      const r = await this.h.call<{ database: DoDb }>(ctx, 'POST', '/v2/databases', { name, engine: src.engine, version: src.version, size: src.size, region: src.region, num_nodes: src.num_nodes, ...(src.private_network_uuid ? { private_network_uuid: src.private_network_uuid } : {}), ...(src.storage_size_mib ? { storage_size_mib: src.storage_size_mib } : {}), tags, backup_restore: await this.restorePoint(ctx, snapshotId, src) });
      id = r.body.database.id;
    }
    const cfg = await this.config(ctx, src.id);
    return { state: 'pending', name: `restore:${snapshotId}`, snapshotId, operation: { provider: 'digitalocean', type: 'database', op: 'create', kind: 'describe', ref: { type: 'database', providerId: id }, token: JSON.stringify({ snapshot: 'restore', source: src.id, phase: { phase: 'settings', ...(Object.keys(cfg).length ? { parameters: cfg } : {}), ...(src.maintenance_window?.day && src.maintenance_window.hour ? { maintenance: { day: fromDoDay(src.maintenance_window.day), hour: Number(src.maintenance_window.hour.split(':')[0]) } } : {}) } }), startedAt: Date.now() }, waitMs: 5000 };
  }

  // ---------- extensions (B-10301) ----------

  async extensions(ctx: CallContext, ref: ResourceRef, wanted: string[]): Promise<ExtensionStatus[]> {
    const db = await this.get(ctx, ref.providerId);
    if (!db) throw new CloudProviderError(`Database ${ref.providerId} no longer exists.`, 'digitalocean', 404, 'not_found');
    return extensionStatus('digitalocean', { engine: engineOf(db.engine) }, wanted, '*');
  }
}
