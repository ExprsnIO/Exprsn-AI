import { randomBytes } from 'node:crypto';
import { createPipelineRequest, type Pipeline } from '@azure/core-rest-pipeline';
import { allowedSet, azureDay, azureTier, COPY_SIZE, dayName, dbIdentifier, defaultVersion, extensionStatus, FINAL_SNAPSHOT_MAX_AGE_MS, isFinalName, majorOf, PG_EXTENSIONS, withAllowed } from '../databases.js';
import { namePrefix } from '../tags.js';
import { azureHttpClient } from './sdk-bridges.js';
import type { CloudTransport } from './transport.js';
import { CloudProviderError, type CallContext, type DatabaseProps, type DatabaseSnapshot, type ExtensionStatus, type ListFilter, type ObservedResource, type OperationHandle, type OperationResult, type PollResult, type ResourceRef, type ResourceSpec, type SnapshotPurpose, type SnapshotResult } from './types.js';

/*
 * 1.9.99-final, Sprint 59 (B-10301, B-10303, B-10307): Azure Database for PostgreSQL and for MySQL Flexible Server,
 * over raw ARM requests through the adapter's pipeline (token policy and all) and `CloudTransport`. `azure.ts` delegates
 * its `database` cases here.
 *
 * - The server: PUT by name in the managed resource group (`exprsn-<account>-<name>`), the SKU and its tier, the
 *   version, storage (auto-grow on request), backup retention, zone-redundant HA (not on Burstable sizes), the custom
 *   maintenance window, public network access off. Followed through `Azure-AsyncOperation`; then, in the same
 *   operation (`azure-db`, the phase in the token as JSON), the settings: the server parameters, the extension
 *   allow-list (`azure.extensions`, merged with what is there, before anything uses the database), a private endpoint
 *   in the data subnet (`groupIds` `postgresqlServer` or `mysqlServer`) and, for deletion protection, a `CanNotDelete`
 *   management lock. Nothing in the token is a secret: the admin password is the vault reference's value handed
 *   straight to Azure, or a random one Azure gets once and nobody keeps (reset it when connecting: B-10302, B-10306).
 * - Snapshots: on-demand backups (`backups/<name>`) for upgrades, schedules and by hand; a final snapshot is a retained
 *   copy (a point-in-time restore to a new Burstable server tagged `exprsn:snapshot-of`), since a server's backups go
 *   with it. A delete of a locked server is refused unless that copy exists and is fresh (`final_snapshot_required`);
 *   then the lock, the private endpoint and the server go. Copies are snapshots, so `list` leaves them out.
 * - Restore to a new instance: a point-in-time restore from the source server (at a backup's time) or from a copy.
 */

const API = { postgres: '2024-08-01', mysql: '2023-12-30', network: '2024-05-01', locks: '2020-05-01' };
const NS = { postgres: 'Microsoft.DBforPostgreSQL', mysql: 'Microsoft.DBforMySQL' } as const;
const LOCK = 'exprsn-deletion-protection';
type Engine = 'postgres' | 'mysql';

export interface AzureDatabasesHost {
  transport: CloudTransport;
  arm: () => string;
  pipeline(ctx: CallContext): Pipeline;
  subscription(ctx: CallContext): string;
  rg(ctx: CallContext): string;
  location(ctx: CallContext, spec?: ResourceSpec): string;
  ensureGroup(ctx: CallContext, spec: ResourceSpec): Promise<string>;
}

interface Arm<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Record<string, string>;
}

interface AzServer {
  id?: string;
  name?: string;
  location?: string;
  tags?: Record<string, string>;
  sku?: { name?: string; tier?: string };
  properties?: {
    version?: string;
    state?: string;
    provisioningState?: string;
    fullyQualifiedDomainName?: string;
    storage?: { storageSizeGB?: number; autoGrow?: string };
    backup?: { backupRetentionDays?: number; earliestRestoreDate?: string };
    highAvailability?: { mode?: string };
    network?: { publicNetworkAccess?: string };
    maintenanceWindow?: { customWindow?: string; dayOfWeek?: number; startHour?: number };
    createMode?: string;
    sourceServerResourceId?: string;
  };
}

/** What the settings phase works towards (settings and references only, never a secret). */
interface DbPhase {
  phase: 'server' | 'settings' | 'delete';
  follow: string | null;
  engine: Engine;
  props?: Pick<DatabaseProps, 'parameters' | 'extensions' | 'deletionProtection' | 'privateEndpoint'> & { subnetId?: string | null };
  tags?: Record<string, string>;
}

const engineOfId = (id: string): Engine => (/microsoft\.dbformysql/i.test(id) ? 'mysql' : 'postgres');
const managed = (t: Record<string, string> | undefined) => Object.fromEntries(Object.entries(t ?? {}).filter(([k]) => k.startsWith('exprsn:') && !['exprsn:name', 'exprsn:purpose', 'exprsn:snapshot-of', 'exprsn:restored-from'].includes(k)));

export class AzureDatabases {
  constructor(private readonly h: AzureDatabasesHost) {}

  private async send<T = Record<string, unknown>>(ctx: CallContext, method: string, url: string, body?: unknown): Promise<Arm<T>> {
    const target = new URL(url, `${this.h.arm()}/`);
    if (target.origin !== new URL(this.h.arm()).origin) throw new CloudProviderError(`Refusing an ARM call off the ARM endpoint (${target.host}).`, 'azure', 502, 'foreign_operation_url');
    const req = createPipelineRequest({ url: target.toString(), method: method as 'GET', ...(body !== undefined ? { body: JSON.stringify(body) } : {}), ...(target.protocol === 'http:' ? { allowInsecureConnection: true } : {}) });
    if (body !== undefined) req.headers.set('content-type', 'application/json');
    const res = await this.h.pipeline(ctx).sendRequest(azureHttpClient(this.h.transport, ctx.account.id), req);
    let parsed: unknown = null;
    if (res.bodyAsText) {
      try {
        parsed = JSON.parse(res.bodyAsText);
      } catch {
        parsed = res.bodyAsText;
      }
    }
    return { status: res.status, body: (parsed ?? {}) as T, headers: res.headers.toJSON() };
  }

  private fail(r: Arm<unknown>, what: string): CloudProviderError {
    const e = ((r.body as { error?: { code?: string; message?: string } }).error ?? {}) as { code?: string; message?: string };
    return new CloudProviderError(`Azure answered ${r.status} for ${what}${e.code ? ` (${e.code})` : ''}: ${(e.message ?? 'no detail').slice(0, 300)}`, 'azure', r.status, e.code ?? null, r.headers['x-ms-request-id'] ?? null, r.status === 429 ? Number(r.headers['retry-after']) || 1 : null);
  }

  private base(ctx: CallContext): string {
    return `/subscriptions/${this.h.subscription(ctx)}/resourceGroups/${this.h.rg(ctx)}/providers`;
  }

  serverName(ctx: CallContext, spec: { name: string }): string {
    return dbIdentifier(namePrefix(ctx.account.name), spec.name, 63);
  }

  serverId(ctx: CallContext, engine: Engine, name: string): string {
    return `${this.base(ctx)}/${NS[engine]}/flexibleServers/${name}`;
  }

  private v(engine: Engine): string {
    return API[engine];
  }

  private peId(ctx: CallContext, serverName: string): string {
    return `${this.base(ctx)}/Microsoft.Network/privateEndpoints/${serverName.slice(0, 60)}-pe`;
  }

  private followOf(r: Arm<unknown>): string | null {
    return r.headers['azure-asyncoperation'] ?? (r.status === 202 ? (r.headers.location ?? null) : null);
  }

  private async followed(ctx: CallContext, url: string): Promise<'pending' | 'succeeded' | { error: string; code?: string }> {
    const r = await this.send<{ status?: string; error?: { code?: string; message?: string } }>(ctx, 'GET', url);
    if (r.status === 202) return 'pending';
    if (r.status >= 400) return { error: r.body.error?.message ?? `Azure answered ${r.status}.`, ...(r.body.error?.code ? { code: r.body.error.code } : {}) };
    const st = (r.body.status ?? 'Succeeded').toLowerCase();
    if (st === 'succeeded') return 'succeeded';
    if (st === 'failed' || st === 'canceled') return { error: r.body.error?.message ?? `The operation ${st}.`, ...(r.body.error?.code ? { code: r.body.error.code } : {}) };
    return 'pending';
  }

  private async get(ctx: CallContext, id: string): Promise<AzServer | null> {
    const r = await this.send<AzServer>(ctx, 'GET', `${id}?api-version=${this.v(engineOfId(id))}`);
    if (r.status === 404) return null;
    if (r.status >= 300) throw this.fail(r, 'the database server');
    return r.body;
  }

  private async configs(ctx: CallContext, id: string): Promise<Record<string, string>> {
    const r = await this.send<{ value?: { name?: string; properties?: { value?: string; source?: string } }[] }>(ctx, 'GET', `${id}/configurations?api-version=${this.v(engineOfId(id))}`);
    if (r.status === 404) return {};
    if (r.status >= 300) throw this.fail(r, 'the server parameters');
    return Object.fromEntries((r.body.value ?? []).filter((c) => !c.properties?.source || c.properties.source === 'user-override').map((c) => [c.name ?? '', c.properties?.value ?? '']).filter(([k]) => k));
  }

  private async locked(ctx: CallContext, id: string): Promise<boolean> {
    const r = await this.send(ctx, 'GET', `${id}/providers/Microsoft.Authorization/locks/${LOCK}?api-version=${API.locks}`);
    if (r.status === 404) return false;
    if (r.status >= 300) throw this.fail(r, 'the deletion lock');
    return true;
  }

  private async hasEndpoint(ctx: CallContext, id: string): Promise<boolean> {
    const name = id.split('/').pop()!;
    const r = await this.send(ctx, 'GET', `${this.peId(ctx, name)}?api-version=${API.network}`);
    return r.status < 300;
  }

  private async observed(ctx: CallContext, srv: AzServer, id: string): Promise<ObservedResource> {
    const engine = engineOfId(id);
    const p = srv.properties ?? {};
    const prov = (p.provisioningState ?? 'Succeeded').toLowerCase();
    const st = (p.state ?? 'Ready').toLowerCase();
    const state: ObservedResource['state'] = prov === 'failed' ? 'failed' : prov === 'deleting' || st === 'dropping' ? 'deleting' : prov !== 'succeeded' ? (p.createMode && prov === 'updating' && !srv.properties?.fullyQualifiedDomainName ? 'creating' : 'updating') : st === 'ready' ? 'ready' : 'updating';
    const params = await this.configs(ctx, id);
    const mw = p.maintenanceWindow?.customWindow === 'Enabled' ? { day: dayName(p.maintenanceWindow.dayOfWeek ?? 0), hour: p.maintenanceWindow.startHour ?? 0 } : undefined;
    const locked = await this.locked(ctx, id);
    const props: Record<string, unknown> = {
      engine,
      version: majorOf(engine, String(p.version ?? '')),
      engineVersion: p.version ?? null,
      size: srv.sku?.name,
      tier: srv.sku?.tier,
      ha: !!p.highAvailability?.mode && p.highAvailability.mode !== 'Disabled',
      storageGb: p.storage?.storageSizeGB,
      storageAutogrow: p.storage?.autoGrow === 'Enabled',
      backups: { days: p.backup?.backupRetentionDays ?? 7 },
      ...(mw ? { maintenanceWindow: mw } : {}),
      deletionProtection: locked,
      publicAccess: p.network?.publicNetworkAccess === 'Enabled',
      privateEndpoint: await this.hasEndpoint(ctx, id),
      parameters: Object.fromEntries(Object.entries(params).filter(([k]) => k !== 'azure.extensions')),
      allowedExtensions: [...allowedSet(params['azure.extensions'])],
      // The data tier (B-10302) reads endpoint (the host), port and dbName.
      endpoint: p.fullyQualifiedDomainName ?? null,
      port: engine === 'mysql' ? 3306 : 5432,
      dbName: engine === 'mysql' ? 'mysql' : 'postgres',
      status: p.state ?? null
    };
    return { type: 'database', providerId: srv.id ?? id, name: srv.tags?.['exprsn:name'] ?? srv.name ?? id.split('/').pop()!, ...(srv.location ? { region: srv.location } : {}), state, tags: managed(srv.tags), props };
  }

  // ---------- reads ----------

  async find(ctx: CallContext, spec: ResourceSpec): Promise<ObservedResource | null> {
    const p = spec.props as DatabaseProps;
    return this.describe(ctx, { type: 'database', providerId: this.serverId(ctx, p.engine === 'mysql' ? 'mysql' : 'postgres', this.serverName(ctx, spec)) });
  }

  async describe(ctx: CallContext, ref: ResourceRef): Promise<ObservedResource | null> {
    const srv = await this.get(ctx, ref.providerId);
    return srv ? this.observed(ctx, srv, ref.providerId) : null;
  }

  private async servers(ctx: CallContext, engine: Engine): Promise<AzServer[]> {
    const r = await this.send<{ value?: AzServer[] }>(ctx, 'GET', `${this.base(ctx)}/${NS[engine]}/flexibleServers?api-version=${this.v(engine)}`);
    if (r.status === 404) return [];
    if (r.status >= 300) throw this.fail(r, 'the database servers');
    return r.body.value ?? [];
  }

  async list(ctx: CallContext, filter: ListFilter): Promise<ObservedResource[]> {
    const out: ObservedResource[] = [];
    for (const engine of ['postgres', 'mysql'] as const) {
      for (const srv of await this.servers(ctx, engine)) {
        if (srv.tags?.['exprsn:snapshot-of']) continue; // a retained copy is a snapshot, not a database
        if (filter.managedOnly && !(srv.tags?.['exprsn:managed'] === 'true' && srv.tags['exprsn:account'] === ctx.account.name)) continue;
        out.push(await this.observed(ctx, srv, srv.id!));
      }
    }
    return out;
  }

  // ---------- create, update, delete ----------

  private async adminPassword(ctx: CallContext, p: DatabaseProps): Promise<string> {
    if (p.adminPasswordRef) {
      if (!ctx.secrets) throw new CloudProviderError('No secret broker is configured, so the admin password cannot be given to Azure.', 'azure', 409, 'secrets_unavailable');
      return ctx.secrets.value({ name: 'db_admin_password', env: 'DB_ADMIN_PASSWORD', ref: p.adminPasswordRef });
    }
    // Sent to Azure once and kept nowhere: whoever connects first resets it (B-10302, B-10306).
    return `Ex-${randomBytes(24).toString('base64url')}9a`;
  }

  private serverBody(ctx: CallContext, spec: ResourceSpec<'database'>, engine: Engine, password: string | null, create: { mode?: 'PointInTimeRestore'; source?: string; at?: string } = {}): Record<string, unknown> {
    const p = spec.props;
    const tier = azureTier(p.size);
    const version = p.version ?? defaultVersion('azure', p);
    return {
      location: this.h.location(ctx, spec),
      tags: { ...spec.tags, 'exprsn:name': spec.name },
      sku: { name: p.size, tier },
      properties: {
        ...(create.mode ? { createMode: create.mode, sourceServerResourceId: create.source, pointInTimeUTC: create.at } : { createMode: engine === 'mysql' ? 'Default' : 'Create', version: engine === 'mysql' && version === '8.0' ? '8.0.21' : version, administratorLogin: p.adminUser ?? 'exprsn_admin', ...(password ? { administratorLoginPassword: password } : {}) }),
        storage: { storageSizeGB: p.storageGb ?? 64, autoGrow: p.storageAutogrow ? 'Enabled' : 'Disabled' },
        backup: { backupRetentionDays: p.backups?.days ?? 7, geoRedundantBackup: 'Disabled' },
        highAvailability: { mode: p.ha && tier !== 'Burstable' ? 'ZoneRedundant' : 'Disabled' },
        network: { publicNetworkAccess: 'Disabled' },
        ...(p.maintenanceWindow ? { maintenanceWindow: { customWindow: 'Enabled', dayOfWeek: azureDay(p.maintenanceWindow.day), startHour: p.maintenanceWindow.hour, startMinute: 0 } } : {})
      }
    };
  }

  private phaseProps(spec: ResourceSpec<'database'>): DbPhase['props'] {
    const p = spec.props;
    const subnet = p.subnets?.[0] ? (spec.parent?.refs?.[p.subnets[0]] ?? null) : null;
    return { ...(p.parameters ? { parameters: p.parameters } : {}), ...(p.extensions ? { extensions: p.extensions } : {}), deletionProtection: p.deletionProtection !== false, privateEndpoint: p.privateEndpoint !== false, subnetId: subnet };
  }

  private token(phase: DbPhase): string {
    return JSON.stringify(phase);
  }

  async create(ctx: CallContext, spec: ResourceSpec<'database'>, handle: (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string) => OperationHandle): Promise<OperationResult> {
    const p = spec.props;
    if (p.publicAccess !== false) throw new CloudProviderError('A managed database is private only: publicAccess must be false.', 'azure', 400, 'public_data');
    const engine: Engine = p.engine === 'mysql' ? 'mysql' : 'postgres';
    const id = this.serverId(ctx, engine, this.serverName(ctx, spec));
    const found = await this.describe(ctx, { type: 'database', providerId: id });
    const ref: ResourceRef = { type: 'database', providerId: id };
    if (found?.state === 'ready') {
      // Adopted (a lost response): the settings are made to match, as they would have been.
      return { done: false, operation: handle('create', ref, 'azure-async', this.token({ phase: 'settings', follow: null, engine, props: this.phaseProps(spec), tags: spec.tags })), resource: found, adopted: true };
    }
    if (found) return { done: false, operation: handle('create', ref, 'azure-async', this.token({ phase: 'server', follow: null, engine, props: this.phaseProps(spec), tags: spec.tags })), resource: found, adopted: true };
    await this.h.ensureGroup(ctx, spec);
    const restore = p.restoreFrom ? await this.restorePoint(ctx, p.restoreFrom) : null;
    const body = this.serverBody(ctx, spec, engine, restore ? null : await this.adminPassword(ctx, p), restore ? { mode: 'PointInTimeRestore', source: restore.source, at: restore.at } : {});
    const r = await this.send(ctx, 'PUT', `${id}?api-version=${this.v(engine)}`, body);
    if (r.status >= 300) throw this.fail(r, 'the database server');
    return { done: false, operation: handle('create', ref, 'azure-async', this.token({ phase: 'server', follow: this.followOf(r), engine, props: this.phaseProps(spec), tags: spec.tags })), ...(r.headers['x-ms-request-id'] ? { requestId: r.headers['x-ms-request-id'] } : {}) };
  }

  async update(ctx: CallContext, ref: ResourceRef, spec: ResourceSpec<'database'>, handle: (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string) => OperationHandle): Promise<OperationResult> {
    const p = spec.props;
    if (p.publicAccess !== false) throw new CloudProviderError('A managed database is private only: publicAccess must be false.', 'azure', 400, 'public_data');
    const engine = engineOfId(ref.providerId);
    const srv = await this.get(ctx, ref.providerId);
    if (!srv) throw new CloudProviderError(`${ref.providerId} no longer exists.`, 'azure', 404, 'not_found');
    const body = this.serverBody(ctx, spec, engine, null);
    // A PATCH: the version and the admin login stay as they are (a version change is a replace).
    const props = body.properties as Record<string, unknown>;
    delete props.createMode;
    delete props.version;
    delete props.administratorLogin;
    const r = await this.send(ctx, 'PATCH', `${ref.providerId}?api-version=${this.v(engine)}`, { tags: body.tags, sku: body.sku, properties: props });
    if (r.status >= 300) throw this.fail(r, 'the database server');
    // Deletion protection is turned on here, never off: only a delete after its final snapshot removes the lock.
    const prot = this.phaseProps(spec)!;
    return { done: false, operation: handle('update', ref, 'azure-async', this.token({ phase: 'server', follow: this.followOf(r), engine, props: { ...prot, deletionProtection: prot.deletionProtection || (await this.locked(ctx, ref.providerId)) }, tags: spec.tags })) };
  }

  /** The settings phase: server parameters, the extension allow-list, the private endpoint, the lock. Returns what to follow, if anything. */
  private async settings(ctx: CallContext, id: string, ph: DbPhase): Promise<string | null> {
    const engine = ph.engine;
    const props = ph.props ?? {};
    const want: Record<string, string> = { ...(props.parameters ?? {}) };
    const exts = (props.extensions ?? []).filter((e) => (PG_EXTENSIONS as readonly string[]).includes(e));
    if (engine === 'postgres' && exts.length) {
      const current = (await this.configs(ctx, id))['azure.extensions'];
      const merged = withAllowed(current, exts);
      if (merged !== (current ?? '')) want['azure.extensions'] = merged;
    }
    let follow: string | null = null;
    const have = await this.configs(ctx, id);
    for (const [name, value] of Object.entries(want)) {
      if (have[name] === value) continue;
      const r = await this.send(ctx, 'PUT', `${id}/configurations/${encodeURIComponent(name)}?api-version=${this.v(engine)}`, { properties: { value, source: 'user-override' } });
      if (r.status >= 300) throw this.fail(r, `the server parameter ${name}`);
      follow = this.followOf(r) ?? follow;
    }
    const name = id.split('/').pop()!;
    if (props.privateEndpoint !== false && props.subnetId && !(await this.hasEndpoint(ctx, id))) {
      const srv = await this.get(ctx, id);
      const r = await this.send(ctx, 'PUT', `${this.peId(ctx, name)}?api-version=${API.network}`, { location: srv?.location, tags: ph.tags ?? {}, properties: { subnet: { id: props.subnetId }, privateLinkServiceConnections: [{ name: `${name.slice(0, 60)}-plsc`, properties: { privateLinkServiceId: id, groupIds: [engine === 'mysql' ? 'mysqlServer' : 'postgresqlServer'] } }] } });
      if (r.status >= 300) throw this.fail(r, 'the private endpoint');
      follow = this.followOf(r) ?? follow;
    }
    if (props.deletionProtection !== false && !(await this.locked(ctx, id))) {
      const r = await this.send(ctx, 'PUT', `${id}/providers/Microsoft.Authorization/locks/${LOCK}?api-version=${API.locks}`, { properties: { level: 'CanNotDelete', notes: 'Exprsn-AI deletion protection: destroy takes a final snapshot first.' } });
      if (r.status >= 300) throw this.fail(r, 'the deletion lock');
    }
    return follow;
  }

  async poll(ctx: CallContext, h: OperationHandle): Promise<PollResult> {
    let ph: DbPhase;
    try {
      ph = JSON.parse(h.token) as DbPhase;
    } catch {
      return { state: 'failed', error: 'The operation token is not readable.', code: 'bad_token' };
    }
    if (ph.follow) {
      const f = await this.followed(ctx, ph.follow);
      if (f === 'pending') return { state: 'pending', waitMs: 3000 };
      if (typeof f === 'object') return { state: 'failed', error: f.error, ...(f.code ? { code: f.code } : {}) };
      ph = { ...ph, follow: null };
      h.token = this.token(ph);
    }
    if (ph.phase === 'delete') {
      const srv = await this.get(ctx, h.ref.providerId);
      return srv ? { state: 'pending', waitMs: 3000 } : { state: 'succeeded', resource: null };
    }
    if (ph.phase === 'server') {
      const srv = await this.get(ctx, h.ref.providerId);
      if (!srv) return { state: 'failed', error: `${h.ref.providerId} disappeared.`, code: 'not_found' };
      if ((srv.properties?.provisioningState ?? 'Succeeded').toLowerCase() === 'failed') return { state: 'failed', error: `${h.ref.providerId} failed to provision.`, code: 'provisioning_failed' };
      if ((srv.properties?.state ?? 'Ready').toLowerCase() !== 'ready' || (srv.properties?.provisioningState ?? 'Succeeded').toLowerCase() !== 'succeeded') return { state: 'pending', waitMs: 3000 };
      const follow = await this.settings(ctx, h.ref.providerId, ph);
      h.token = this.token({ ...ph, phase: 'settings', follow });
      if (follow) return { state: 'pending', waitMs: 2000 };
    } else if (ph.phase === 'settings') {
      const follow = await this.settings(ctx, h.ref.providerId, ph);
      if (follow) {
        h.token = this.token({ ...ph, follow });
        return { state: 'pending', waitMs: 2000 };
      }
    }
    const o = await this.describe(ctx, h.ref);
    return o ? { state: 'succeeded', resource: o } : { state: 'failed', error: `${h.ref.providerId} disappeared.`, code: 'not_found' };
  }

  /** The newest retained copy of a server taken as its final snapshot (within the age a delete accepts). */
  private async finalCopy(ctx: CallContext, id: string): Promise<DatabaseSnapshot | null> {
    const now = Date.now();
    return (await this.copies(ctx, id)).filter((s) => s.final && s.state === 'available' && s.createdAt != null && now - s.createdAt <= FINAL_SNAPSHOT_MAX_AGE_MS).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0] ?? null;
  }

  async delete(ctx: CallContext, ref: ResourceRef, handle: (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string) => OperationHandle): Promise<OperationResult> {
    const id = ref.providerId;
    const engine = engineOfId(id);
    const srv = await this.get(ctx, id);
    if (!srv) return { done: true, resource: null };
    if (await this.locked(ctx, id)) {
      if (!(await this.finalCopy(ctx, id))) throw new CloudProviderError(`${srv.name} has deletion protection on and no final snapshot from the last ${FINAL_SNAPSHOT_MAX_AGE_MS / 3_600_000} hours; it is deleted only by destroy, after its final snapshot.`, 'azure', 409, 'final_snapshot_required');
      const r = await this.send(ctx, 'DELETE', `${id}/providers/Microsoft.Authorization/locks/${LOCK}?api-version=${API.locks}`);
      if (r.status >= 300 && r.status !== 404) throw this.fail(r, 'the deletion lock');
    }
    const name = id.split('/').pop()!;
    const pe = await this.send(ctx, 'DELETE', `${this.peId(ctx, name)}?api-version=${API.network}`);
    if (pe.status >= 300 && pe.status !== 404) throw this.fail(pe, 'the private endpoint');
    const r = await this.send(ctx, 'DELETE', `${id}?api-version=${this.v(engine)}`);
    if (r.status === 404 || r.status === 204 || r.status === 200) return r.status === 200 && this.followOf(r) ? { done: false, operation: handle('delete', ref, 'azure-async', this.token({ phase: 'delete', follow: this.followOf(r), engine })) } : { done: true, resource: null };
    if (r.status >= 300) throw this.fail(r, 'the database server');
    return { done: false, operation: handle('delete', ref, 'azure-async', this.token({ phase: 'delete', follow: this.followOf(r), engine })) };
  }

  // ---------- snapshots (B-10307) ----------

  private async copies(ctx: CallContext, id: string): Promise<DatabaseSnapshot[]> {
    const engine = engineOfId(id);
    const out: DatabaseSnapshot[] = [];
    for (const srv of await this.servers(ctx, engine)) {
      if ((srv.tags?.['exprsn:snapshot-of'] ?? '').toLowerCase() !== id.toLowerCase()) continue;
      const ready = (srv.properties?.provisioningState ?? 'Succeeded').toLowerCase() === 'succeeded' && (srv.properties?.state ?? 'Ready').toLowerCase() === 'ready';
      const created = Date.parse(srv.tags?.['exprsn:taken'] ?? '');
      out.push({ id: srv.id!, name: srv.name!, kind: 'copy', state: ready ? 'available' : (srv.properties?.provisioningState ?? '').toLowerCase() === 'failed' ? 'failed' : 'pending', createdAt: Number.isFinite(created) ? created : null, sizeGb: srv.properties?.storage?.storageSizeGB ?? null, expiresAt: null, final: srv.tags?.['exprsn:purpose'] === 'final' || isFinalName(srv.name ?? ''), billing: { sku: `${engine === 'mysql' ? 'mysql' : 'postgres'}:${srv.sku?.name ?? COPY_SIZE.azure}`, unit: 'month' } });
    }
    return out;
  }

  async listSnapshots(ctx: CallContext, ref: ResourceRef): Promise<DatabaseSnapshot[]> {
    const id = ref.providerId;
    const engine = engineOfId(id);
    const srv = await this.get(ctx, id);
    const retention = srv?.properties?.backup?.backupRetentionDays ?? 7;
    const out: DatabaseSnapshot[] = [];
    if (srv) {
      const r = await this.send<{ value?: { id?: string; name?: string; properties?: { backupType?: string; completedTime?: string } }[] }>(ctx, 'GET', `${id}/backups?api-version=${this.v(engine)}`);
      if (r.status >= 300 && r.status !== 404) throw this.fail(r, 'the backups');
      for (const b of r.body.value ?? []) {
        const at = Date.parse(b.properties?.completedTime ?? '');
        const auto = !/on-?demand/i.test(b.properties?.backupType ?? '');
        out.push({ id: b.id ?? `${id}/backups/${b.name}`, name: b.name ?? '', kind: auto ? 'automated' : 'manual', state: Number.isFinite(at) ? 'available' : 'pending', createdAt: Number.isFinite(at) ? at : null, sizeGb: srv.properties?.storage?.storageSizeGB ?? null, expiresAt: Number.isFinite(at) ? at + retention * 86_400_000 : null, final: false, billing: auto ? { sku: `${engine}:backup`, unit: 'included' } : { sku: `${engine === 'mysql' ? 'mysql' : 'postgres'}:backup`, unit: 'gb-month' } });
      }
    }
    return [...out, ...(await this.copies(ctx, id))];
  }

  async snapshot(ctx: CallContext, ref: ResourceRef, name: string, purpose: SnapshotPurpose): Promise<SnapshotResult> {
    const id = ref.providerId;
    const engine = engineOfId(id);
    const srv = await this.get(ctx, id);
    if (!srv) throw new CloudProviderError(`${id} no longer exists.`, 'azure', 404, 'not_found');
    const snapName = dbIdentifier('', name, 63);
    if (purpose === 'final') {
      // A server's backups go with it: the final snapshot is a retained copy, restored to the latest point.
      const copyId = this.serverId(ctx, engine, snapName);
      const at = new Date(Date.now() - 60_000).toISOString();
      const body = { location: srv.location, tags: { ...managed(srv.tags), 'exprsn:snapshot-of': id.toLowerCase(), 'exprsn:purpose': 'final', 'exprsn:taken': new Date().toISOString() }, sku: { name: COPY_SIZE.azure, tier: 'Burstable' }, properties: { createMode: 'PointInTimeRestore', sourceServerResourceId: id, pointInTimeUTC: at, storage: { storageSizeGB: srv.properties?.storage?.storageSizeGB ?? 64 }, highAvailability: { mode: 'Disabled' }, network: { publicNetworkAccess: 'Disabled' } } };
      const exists = await this.get(ctx, copyId);
      let follow: string | null = null;
      if (!exists) {
        const r = await this.send(ctx, 'PUT', `${copyId}?api-version=${this.v(engine)}`, body);
        if (r.status >= 300) throw this.fail(r, 'the final snapshot copy');
        follow = this.followOf(r);
      }
      return { state: 'pending', name: snapName, snapshotId: null, operation: { provider: 'azure', type: 'database', op: 'create', kind: 'azure-async', ref: { type: 'database', providerId: copyId }, token: JSON.stringify({ snapshot: 'copy', id: copyId, follow }), startedAt: Date.now() }, waitMs: 3000 };
    }
    const backupId = `${id}/backups/${snapName}`;
    const r = await this.send(ctx, 'PUT', `${backupId}?api-version=${this.v(engine)}`, {});
    if (r.status >= 300 && r.status !== 409) throw this.fail(r, 'the on-demand backup');
    return { state: 'pending', name: snapName, snapshotId: null, operation: { provider: 'azure', type: 'database', op: 'update', kind: 'azure-async', ref: { type: 'database', providerId: id }, token: JSON.stringify({ snapshot: 'backup', id: backupId, follow: this.followOf(r) }), startedAt: Date.now() }, waitMs: 3000, requestId: r.headers['x-ms-request-id'] ?? null };
  }

  async snapshotStatus(ctx: CallContext, ref: ResourceRef, pending: SnapshotResult): Promise<SnapshotResult> {
    if (pending.state !== 'pending' || !pending.operation) return pending;
    let t: { snapshot?: 'copy' | 'backup' | 'restore'; id: string; follow?: string | null; phase?: string };
    try {
      t = JSON.parse(pending.operation.token) as typeof t;
    } catch {
      return { ...pending, state: 'failed', error: 'The snapshot token is not readable.' };
    }
    const { operation: _o, ...rest } = pending;
    if (t.snapshot === 'backup') {
      if (t.follow) {
        const f = await this.followed(ctx, t.follow);
        if (f === 'pending') return { ...pending, waitMs: 3000 };
        if (typeof f === 'object') return { ...pending, state: 'failed', error: f.error };
      }
      const r = await this.send<{ properties?: { completedTime?: string } }>(ctx, 'GET', `${t.id}?api-version=${this.v(engineOfId(t.id))}`);
      if (r.status === 404) return { ...pending, waitMs: 3000 };
      if (r.status >= 300) return { ...pending, state: 'failed', error: this.fail(r, 'the on-demand backup').message };
      return r.body.properties?.completedTime ? { ...rest, state: 'done', snapshotId: t.id } : { ...pending, waitMs: 3000 };
    }
    if (t.snapshot === 'copy') {
      if (t.follow) {
        const f = await this.followed(ctx, t.follow);
        if (f === 'pending') return { ...pending, waitMs: 3000 };
        if (typeof f === 'object') return { ...pending, state: 'failed', error: f.error };
        pending = { ...pending, operation: { ...pending.operation, token: JSON.stringify({ ...t, follow: null }) } };
      }
      const srv = await this.get(ctx, t.id);
      if (!srv) return { ...pending, state: 'failed', error: 'The final snapshot copy is gone.' };
      if ((srv.properties?.provisioningState ?? '').toLowerCase() === 'failed') return { ...pending, state: 'failed', error: 'The final snapshot copy failed to restore.' };
      if ((srv.properties?.provisioningState ?? 'Succeeded').toLowerCase() !== 'succeeded' || (srv.properties?.state ?? 'Ready').toLowerCase() !== 'ready') return { ...pending, waitMs: 3000 };
      return { ...rest, state: 'done', snapshotId: t.id };
    }
    // A restore to a new server: the create's phases, as `poll` follows them.
    const ph = t as unknown as DbPhase;
    const inner: OperationHandle = { ...pending.operation, token: JSON.stringify({ phase: ph.phase ?? 'server', follow: t.follow ?? null, engine: engineOfId(t.id), props: ph.props, tags: ph.tags }) };
    const r = await this.poll(ctx, inner);
    if (r.state === 'pending') {
      const next = JSON.parse(inner.token) as DbPhase;
      return { ...pending, operation: { ...pending.operation, token: JSON.stringify({ ...next, snapshot: 'restore', id: t.id }) }, waitMs: r.waitMs };
    }
    if (r.state === 'failed') return { ...pending, state: 'failed', error: r.error };
    return { ...rest, state: 'done', restoredId: t.id };
  }

  async deleteSnapshot(ctx: CallContext, ref: ResourceRef, snapshotId: string): Promise<void> {
    if (!/\/backups\//i.test(snapshotId) || isFinalName(snapshotId)) throw new CloudProviderError('Only on-demand backups Exprsn-AI took are deleted here; a final snapshot copy is never deleted by Exprsn-AI.', 'azure', 409, 'final_snapshot');
    const r = await this.send(ctx, 'DELETE', `${snapshotId}?api-version=${this.v(engineOfId(ref.providerId))}`);
    if (r.status >= 300 && r.status !== 404) throw this.fail(r, 'the on-demand backup');
  }

  /** Where a restore starts: a copy server (its latest point) or the source server at a backup's completed time. */
  private async restorePoint(ctx: CallContext, snapshotId: string): Promise<{ source: string; at: string }> {
    if (/\/backups\//i.test(snapshotId)) {
      const r = await this.send<{ properties?: { completedTime?: string } }>(ctx, 'GET', `${snapshotId}?api-version=${this.v(engineOfId(snapshotId))}`);
      if (r.status >= 300) throw this.fail(r, 'the backup to restore');
      return { source: snapshotId.replace(/\/backups\/[^/]+$/i, ''), at: r.body.properties?.completedTime ?? new Date().toISOString() };
    }
    return { source: snapshotId, at: new Date(Date.now() - 60_000).toISOString() };
  }

  /** B-10307: a snapshot restored to a new server beside the source, with its settings, private endpoint and lock. */
  async restore(ctx: CallContext, ref: ResourceRef, snapshotId: string, o: { name?: string; tags?: Record<string, string> } = {}): Promise<SnapshotResult> {
    const src = await this.get(ctx, ref.providerId);
    if (!src) throw new CloudProviderError(`${ref.providerId} no longer exists.`, 'azure', 404, 'not_found');
    const engine = engineOfId(ref.providerId);
    const point = await this.restorePoint(ctx, snapshotId);
    const name = dbIdentifier('', o.name ?? `${src.name}-restored-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}`, 63);
    const id = this.serverId(ctx, engine, name);
    const srcObs = await this.observed(ctx, src, ref.providerId);
    const subnetId = await this.endpointSubnet(ctx, src.name!);
    const props: DbPhase['props'] = { parameters: srcObs.props.parameters as Record<string, string>, extensions: srcObs.props.allowedExtensions as string[], deletionProtection: true, privateEndpoint: true, subnetId };
    if (!(await this.get(ctx, id))) {
      const r = await this.send(ctx, 'PUT', `${id}?api-version=${this.v(engine)}`, { location: src.location, tags: { ...(o.tags ?? managed(src.tags)), 'exprsn:name': name, 'exprsn:restored-from': snapshotId.split('/').pop()!.slice(0, 200) }, sku: src.sku, properties: { createMode: 'PointInTimeRestore', sourceServerResourceId: point.source, pointInTimeUTC: point.at, network: { publicNetworkAccess: 'Disabled' } } });
      if (r.status >= 300) throw this.fail(r, 'the restored server');
      return { state: 'pending', name: `restore:${snapshotId.split('/').pop()}`, snapshotId, operation: { provider: 'azure', type: 'database', op: 'create', kind: 'azure-async', ref: { type: 'database', providerId: id }, token: JSON.stringify({ snapshot: 'restore', id, phase: 'server', follow: this.followOf(r), engine, props, tags: o.tags ?? {} }), startedAt: Date.now() }, waitMs: 3000 };
    }
    return { state: 'pending', name: `restore:${snapshotId.split('/').pop()}`, snapshotId, operation: { provider: 'azure', type: 'database', op: 'create', kind: 'azure-async', ref: { type: 'database', providerId: id }, token: JSON.stringify({ snapshot: 'restore', id, phase: 'server', follow: null, engine, props, tags: o.tags ?? {} }), startedAt: Date.now() }, waitMs: 3000 };
  }

  private async endpointSubnet(ctx: CallContext, serverName: string): Promise<string | null> {
    const r = await this.send<{ properties?: { subnet?: { id?: string } } }>(ctx, 'GET', `${this.peId(ctx, serverName)}?api-version=${API.network}`);
    return r.status < 300 ? (r.body.properties?.subnet?.id ?? null) : null;
  }

  // ---------- extensions (B-10301) ----------

  async extensions(ctx: CallContext, ref: ResourceRef, wanted: string[]): Promise<ExtensionStatus[]> {
    const engine = engineOfId(ref.providerId);
    const srv = await this.get(ctx, ref.providerId);
    if (!srv) throw new CloudProviderError(`${ref.providerId} no longer exists.`, 'azure', 404, 'not_found');
    const allowed = allowedSet((await this.configs(ctx, ref.providerId))['azure.extensions']);
    return extensionStatus('azure', { engine }, wanted, allowed);
  }
}
