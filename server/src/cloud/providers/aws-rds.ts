import { createHash } from 'node:crypto';
import { signV4 } from '../../platform/blob.js';
import { xmlAll, xmlText } from '../credential-http.js';
import { dbIdentifier, defaultVersion, extensionStatus, FINAL_SNAPSHOT_MAX_AGE_MS, isFinalName, majorOf, parseRdsWindow, PG_EXTENSIONS, rdsWindow } from '../databases.js';
import { namePrefix } from '../tags.js';
import type { CloudTransport } from './transport.js';
import { CloudProviderError, type CallContext, type DatabaseProps, type DatabaseSnapshot, type ExtensionStatus, type ListFilter, type ObservedResource, type OperationHandle, type OperationResult, type PollResult, type ResourceRef, type ResourceSpec, type SnapshotPurpose, type SnapshotResult } from './types.js';

/*
 * 1.9.99-final, Sprint 59 (B-10301, B-10303, B-10307): RDS and Aurora (PostgreSQL and MySQL) through the AWS adapter, over
 * the RDS Query API (SigV4 for `rds`) on the adapter's transport, so every request goes through the egress guard and
 * the rate limiter. (The SDK's RDS client is not a dependency of this build; the calls are few and stable.)
 *
 * - RDS (`service: rds`): a DB subnet group in the data subnets, a DB parameter group per database (its parameters;
 *   the extension allow-list step adds `vector`, `postgis` and `pg_trgm` to `rds.allowed_extensions` where the
 *   parameters restrict it), then `CreateDBInstance`: encrypted gp3 storage, Multi-AZ for HA, not publicly accessible,
 *   the data security group, the backup retention and window, the maintenance window, deletion protection, the master
 *   password managed by RDS in Secrets Manager (or the vault reference's value, handed straight to RDS). The provider
 *   id is `instance:<identifier>`.
 * - Aurora (`service: aurora`): a DB cluster parameter group, `CreateDBCluster`, then its writer instance (and a
 *   reader for HA). The provider id is `cluster:<identifier>`.
 * - Idempotency: the identifier (`exprsn-<account>-<name>`) is ours; a create first describes it, and a lost
 *   response's `DBInstanceAlreadyExists` is adopted. Followed by describing until `available`.
 * - Snapshots: manual DB (or cluster) snapshots, which outlive the database; restore to a new instance with
 *   `RestoreDBInstanceFromDBSnapshot` (or `RestoreDBClusterFromSnapshot` and a writer). A delete of a protected
 *   database is refused unless its final snapshot exists (`final_snapshot_required`); then deletion protection is
 *   turned off and the database deleted without another snapshot.
 */

const VERSION = '2014-10-31';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export interface AwsRdsHost {
  transport: CloudTransport;
  endpoint(region: string): string;
  region(ctx: CallContext, spec?: ResourceSpec): string;
}

type Kind = 'instance' | 'cluster';
const splitId = (id: string): { kind: Kind; id: string } => {
  const m = /^(instance|cluster):(.+)$/.exec(id);
  return m ? { kind: m[1] as Kind, id: m[2]! } : { kind: 'instance', id };
};

interface RdsDb {
  id: string;
  kind: Kind;
  status: string;
  engine: string;
  engineVersion: string;
  size: string | null;
  storageGb: number | null;
  multiAz: boolean;
  public: boolean;
  deletionProtection: boolean;
  retention: number | null;
  backupWindow: string | null;
  maintenance: string | null;
  paramGroup: string | null;
  endpoint: string | null;
  port: number | null;
  vpcId: string | null;
  subnetGroup: string | null;
  securityGroups: string[];
  members: string[];
  tags: Record<string, string>;
}

const num = (v: string | null) => (v == null || v === '' ? null : Number(v));
const tagsOf = (xml: string): Record<string, string> => Object.fromEntries(xmlAll(xmlText(xml, 'TagList') ?? '', 'Tag').map((t) => [xmlText(t, 'Key') ?? '', xmlText(t, 'Value') ?? '']).filter(([k]) => k));

function instanceFrom(x: string): RdsDb {
  return {
    id: xmlText(x, 'DBInstanceIdentifier') ?? '',
    kind: 'instance',
    status: xmlText(x, 'DBInstanceStatus') ?? 'unknown',
    engine: xmlText(x, 'Engine') ?? '',
    engineVersion: xmlText(x, 'EngineVersion') ?? '',
    size: xmlText(x, 'DBInstanceClass'),
    storageGb: num(xmlText(x, 'AllocatedStorage')),
    multiAz: xmlText(x, 'MultiAZ') === 'true',
    public: xmlText(x, 'PubliclyAccessible') === 'true',
    deletionProtection: xmlText(x, 'DeletionProtection') === 'true',
    retention: num(xmlText(x, 'BackupRetentionPeriod')),
    backupWindow: xmlText(x, 'PreferredBackupWindow'),
    maintenance: xmlText(x, 'PreferredMaintenanceWindow'),
    paramGroup: xmlText(xmlText(x, 'DBParameterGroups') ?? '', 'DBParameterGroupName'),
    endpoint: xmlText(xmlText(x, 'Endpoint') ?? '', 'Address'),
    port: num(xmlText(xmlText(x, 'Endpoint') ?? '', 'Port')),
    vpcId: xmlText(xmlText(x, 'DBSubnetGroup') ?? '', 'VpcId'),
    subnetGroup: xmlText(xmlText(x, 'DBSubnetGroup') ?? '', 'DBSubnetGroupName'),
    securityGroups: xmlAll(xmlText(x, 'VpcSecurityGroups') ?? '', 'VpcSecurityGroupId'),
    members: [],
    tags: tagsOf(x)
  };
}

function clusterFrom(x: string): RdsDb {
  return {
    id: xmlText(x, 'DBClusterIdentifier') ?? '',
    kind: 'cluster',
    status: xmlText(x, 'Status') ?? 'unknown',
    engine: xmlText(x, 'Engine') ?? '',
    engineVersion: xmlText(x, 'EngineVersion') ?? '',
    size: null,
    storageGb: num(xmlText(x, 'AllocatedStorage')),
    multiAz: xmlText(x, 'MultiAZ') === 'true',
    public: false,
    deletionProtection: xmlText(x, 'DeletionProtection') === 'true',
    retention: num(xmlText(x, 'BackupRetentionPeriod')),
    backupWindow: xmlText(x, 'PreferredBackupWindow'),
    maintenance: xmlText(x, 'PreferredMaintenanceWindow'),
    paramGroup: xmlText(x, 'DBClusterParameterGroup'),
    endpoint: xmlText(x, 'Endpoint'),
    port: num(xmlText(x, 'Port')),
    vpcId: null,
    subnetGroup: xmlText(x, 'DBSubnetGroup'),
    securityGroups: xmlAll(xmlText(x, 'VpcSecurityGroups') ?? '', 'VpcSecurityGroupId'),
    members: xmlAll(xmlText(x, 'DBClusterMembers') ?? '', 'DBInstanceIdentifier'),
    tags: tagsOf(x)
  };
}

const stateOf = (status: string): ObservedResource['state'] => (status === 'available' ? 'ready' : status === 'creating' || status === 'backing-up' ? 'creating' : status === 'deleting' ? 'deleting' : status === 'failed' || status === 'incompatible-parameters' || status === 'storage-full' ? 'failed' : 'updating');

/** The `exprsn:*` tags and the name tag, without what Exprsn-AI keeps for itself. */
const managed = (t: Record<string, string>) => Object.fromEntries(Object.entries(t).filter(([k]) => k.startsWith('exprsn:') && k !== 'exprsn:name' && k !== 'exprsn:purpose' && k !== 'exprsn:snapshot-of'));

function familyOf(engine: string, major: string): string {
  if (engine === 'aurora-postgresql') return `aurora-postgresql${major}`;
  if (engine === 'aurora-mysql') return 'aurora-mysql8.0';
  if (engine === 'mysql') return `mysql${major}`;
  return `postgres${major}`;
}

export class AwsRds {
  constructor(private readonly h: AwsRdsHost) {}

  // ---------- the Query API ----------

  private async q(ctx: CallContext, region: string, action: string, params: Record<string, string>): Promise<{ text: string; requestId: string | null }> {
    if (ctx.cred.kind !== 'aws') throw new CloudProviderError('An AWS account needs an AWS credential.', 'aws', 400, 'wrong_credential');
    const url = new URL(this.h.endpoint(region));
    const body = new URLSearchParams({ Action: action, Version: VERSION, ...params }).toString();
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' };
    if (ctx.cred.sessionToken) headers['x-amz-security-token'] = ctx.cred.sessionToken;
    const signed = signV4({ method: 'POST', url, headers, payloadHash: sha(body), region, service: 'rds', accessKeyId: ctx.cred.accessKeyId, secretAccessKey: ctx.cred.secretAccessKey, date: new Date() });
    const res = await this.h.transport.send({ method: 'POST', url, headers: signed, body, accountId: ctx.account.id, ...(ctx.signal ? { signal: ctx.signal } : {}) });
    const text = res.body.toString('utf8');
    if (res.status >= 300) {
      const code = xmlText(text, 'Code');
      const status = /NotFound/.test(code ?? '') ? 404 : /AlreadyExists/.test(code ?? '') ? 409 : res.status;
      throw new CloudProviderError(`AWS RDS answered ${res.status}${code ? ` (${code})` : ''}: ${(xmlText(text, 'Message') ?? 'no detail').slice(0, 300)}`, 'aws', status, code, res.requestId);
    }
    return { text, requestId: res.requestId };
  }

  private region(ctx: CallContext, ref?: { region?: string }, spec?: ResourceSpec): string {
    return ref?.region ?? this.h.region(ctx, spec);
  }

  identifier(ctx: CallContext, spec: { name: string }): string {
    return dbIdentifier(namePrefix(ctx.account.name), spec.name, 63);
  }

  private async read(ctx: CallContext, region: string, kind: Kind, id: string): Promise<RdsDb | null> {
    try {
      if (kind === 'cluster') {
        const r = await this.q(ctx, region, 'DescribeDBClusters', { DBClusterIdentifier: id });
        const x = xmlAll(r.text, 'DBCluster')[0];
        return x ? clusterFrom(x) : null;
      }
      const r = await this.q(ctx, region, 'DescribeDBInstances', { DBInstanceIdentifier: id });
      const x = xmlAll(r.text, 'DBInstance')[0];
      return x ? instanceFrom(x) : null;
    } catch (err) {
      if (err instanceof CloudProviderError && err.status === 404) return null;
      throw err;
    }
  }

  private async parameters(ctx: CallContext, region: string, kind: Kind, group: string | null): Promise<Record<string, string>> {
    if (!group || group.startsWith('default.')) return {};
    try {
      const r = await this.q(ctx, region, kind === 'cluster' ? 'DescribeDBClusterParameters' : 'DescribeDBParameters', { [kind === 'cluster' ? 'DBClusterParameterGroupName' : 'DBParameterGroupName']: group, Source: 'user' });
      return Object.fromEntries(xmlAll(r.text, 'Parameter').map((p) => [xmlText(p, 'ParameterName') ?? '', xmlText(p, 'ParameterValue') ?? '']).filter(([k]) => k));
    } catch (err) {
      if (err instanceof CloudProviderError && err.status === 404) return {};
      throw err;
    }
  }

  private async observed(ctx: CallContext, region: string, db: RdsDb): Promise<ObservedResource> {
    let size = db.size;
    let multiAz = db.multiAz;
    if (db.kind === 'cluster') {
      const writer = db.members[0] ? await this.read(ctx, region, 'instance', db.members[0]) : null;
      size = writer?.size ?? null;
      multiAz = db.members.length > 1;
    }
    const params = await this.parameters(ctx, region, db.kind, db.paramGroup);
    const engine = db.engine.includes('mysql') ? 'mysql' : 'postgres';
    const window = parseRdsWindow(db.maintenance);
    const props: Record<string, unknown> = {
      engine,
      service: db.kind === 'cluster' ? 'aurora' : 'rds',
      version: majorOf(engine, db.engineVersion),
      engineVersion: db.engineVersion,
      size,
      ha: multiAz,
      ...(db.storageGb != null && db.kind === 'instance' ? { storageGb: db.storageGb } : {}),
      backups: { days: db.retention ?? 0, ...(db.backupWindow ? { window: db.backupWindow } : {}) },
      ...(window ? { maintenanceWindow: window } : {}),
      deletionProtection: db.deletionProtection,
      publicAccess: db.public,
      privateEndpoint: !db.public,
      parameters: params,
      // The data tier (B-10302) reads endpoint (the host), port and dbName.
      endpoint: db.endpoint,
      port: db.port ?? (engine === 'mysql' ? 3306 : 5432),
      dbName: engine === 'mysql' ? 'mysql' : 'postgres',
      status: db.status,
      securityGroups: db.securityGroups
    };
    return { type: 'database', providerId: `${db.kind}:${db.id}`, name: db.tags['exprsn:name'] ?? db.id, region, state: stateOf(db.status), tags: managed(db.tags), props, ...(db.vpcId ? { locator: { networkId: db.vpcId } } : {}) };
  }

  // ---------- reads ----------

  async find(ctx: CallContext, spec: ResourceSpec): Promise<ObservedResource | null> {
    const p = spec.props as DatabaseProps;
    return this.describe(ctx, { type: 'database', providerId: `${p.service === 'aurora' ? 'cluster' : 'instance'}:${this.identifier(ctx, spec)}`, region: this.region(ctx, undefined, spec) });
  }

  async describe(ctx: CallContext, ref: ResourceRef): Promise<ObservedResource | null> {
    const region = this.region(ctx, ref);
    const { kind, id } = splitId(ref.providerId);
    const db = await this.read(ctx, region, kind, id);
    return db ? this.observed(ctx, region, db) : null;
  }

  async list(ctx: CallContext, filter: ListFilter): Promise<ObservedResource[]> {
    const region = this.region(ctx);
    const out: ObservedResource[] = [];
    const instances = xmlAll((await this.q(ctx, region, 'DescribeDBInstances', {})).text, 'DBInstance').map(instanceFrom);
    const clusters = xmlAll((await this.q(ctx, region, 'DescribeDBClusters', {})).text, 'DBCluster').map(clusterFrom);
    for (const db of [...clusters, ...instances.filter((i) => !clusters.some((c) => c.members.includes(i.id)))]) {
      // A copy restored as a final snapshot is a snapshot, not a database (RDS keeps snapshots apart; this is for symmetry).
      if (db.tags['exprsn:snapshot-of']) continue;
      if (filter.managedOnly && !(db.tags['exprsn:managed'] === 'true' && db.tags['exprsn:account'] === ctx.account.name)) continue;
      const o = await this.observed(ctx, region, db);
      if (filter.networkId && o.locator?.networkId && o.locator.networkId !== filter.networkId) continue;
      out.push(o);
    }
    return out;
  }

  // ---------- create, update, delete ----------

  private tagParams(tags: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    Object.entries(tags).forEach(([k, v], i) => {
      out[`Tags.Tag.${i + 1}.Key`] = k;
      out[`Tags.Tag.${i + 1}.Value`] = v;
    });
    return out;
  }

  private list1(prefix: string, member: string, values: string[]): Record<string, string> {
    return Object.fromEntries(values.map((v, i) => [`${prefix}.${member}.${i + 1}`, v]));
  }

  /** The database's parameters with the extension allow-list step: `rds.allowed_extensions`, where set, gets the wanted extensions. */
  private paramsWithAllowList(p: DatabaseProps): Record<string, string> {
    const params = { ...(p.parameters ?? {}) };
    const wanted = (p.extensions ?? []).filter((e) => (PG_EXTENSIONS as readonly string[]).includes(e));
    const cur = params['rds.allowed_extensions'];
    if (p.engine === 'postgres' && wanted.length && cur && cur.trim() !== '*') {
      const have = cur.split(',').map((x) => x.trim()).filter(Boolean);
      for (const w of wanted) if (!have.includes(w)) have.push(w);
      params['rds.allowed_extensions'] = have.join(',');
    }
    return params;
  }

  private async ensureGroups(ctx: CallContext, region: string, spec: ResourceSpec<'database'>, id: string, engine: string, major: string): Promise<{ subnetGroup: string | null; paramGroup: string }> {
    const p = spec.props;
    const kind: Kind = p.service === 'aurora' ? 'cluster' : 'instance';
    const refs = spec.parent?.refs ?? {};
    const subnetIds = (p.subnets ?? []).map((k) => refs[k]).filter((x): x is string => !!x);
    let subnetGroup: string | null = null;
    if (subnetIds.length) {
      subnetGroup = id;
      try {
        await this.q(ctx, region, 'CreateDBSubnetGroup', { DBSubnetGroupName: id, DBSubnetGroupDescription: `Exprsn-AI ${spec.name} (private data subnets)`, ...this.list1('SubnetIds', 'SubnetIdentifier', subnetIds), ...this.tagParams(spec.tags) });
      } catch (err) {
        if (!(err instanceof CloudProviderError && err.status === 409)) throw err;
      }
    }
    const paramGroup = id;
    try {
      await this.q(ctx, region, kind === 'cluster' ? 'CreateDBClusterParameterGroup' : 'CreateDBParameterGroup', { [kind === 'cluster' ? 'DBClusterParameterGroupName' : 'DBParameterGroupName']: paramGroup, [kind === 'cluster' ? 'DBParameterGroupFamily' : 'DBParameterGroupFamily']: familyOf(engine, major), Description: `Exprsn-AI ${spec.name}`, ...this.tagParams(spec.tags) });
    } catch (err) {
      if (!(err instanceof CloudProviderError && err.status === 409)) throw err;
    }
    await this.setParameters(ctx, region, kind, paramGroup, this.paramsWithAllowList(p));
    return { subnetGroup, paramGroup };
  }

  private async setParameters(ctx: CallContext, region: string, kind: Kind, group: string, params: Record<string, string>): Promise<void> {
    const entries = Object.entries(params);
    for (let i = 0; i < entries.length; i += 20) {
      const batch: Record<string, string> = {};
      entries.slice(i, i + 20).forEach(([k, v], j) => {
        batch[`Parameters.Parameter.${j + 1}.ParameterName`] = k;
        batch[`Parameters.Parameter.${j + 1}.ParameterValue`] = v;
        batch[`Parameters.Parameter.${j + 1}.ApplyMethod`] = 'pending-reboot';
      });
      await this.q(ctx, region, kind === 'cluster' ? 'ModifyDBClusterParameterGroup' : 'ModifyDBParameterGroup', { [kind === 'cluster' ? 'DBClusterParameterGroupName' : 'DBParameterGroupName']: group, ...batch });
    }
  }

  private async password(ctx: CallContext, p: DatabaseProps): Promise<Record<string, string>> {
    if (!p.adminPasswordRef) return { ManageMasterUserPassword: 'true' };
    if (!ctx.secrets) throw new CloudProviderError('No secret broker is configured, so the admin password cannot be given to RDS.', 'aws', 409, 'secrets_unavailable');
    return { MasterUserPassword: await ctx.secrets.value({ name: 'db_admin_password', env: 'DB_ADMIN_PASSWORD', ref: p.adminPasswordRef }) };
  }

  private common(p: DatabaseProps, spec: ResourceSpec<'database'>): Record<string, string> {
    const refs = spec.parent?.refs ?? {};
    const sg = p.firewall ? refs[p.firewall] : undefined;
    return {
      ...(sg ? this.list1('VpcSecurityGroupIds', 'VpcSecurityGroupId', [sg]) : {}),
      BackupRetentionPeriod: String(p.backups?.days ?? 7),
      ...(p.backups?.window ? { PreferredBackupWindow: p.backups.window } : {}),
      ...(p.maintenanceWindow ? { PreferredMaintenanceWindow: rdsWindow(p.maintenanceWindow) } : {}),
      DeletionProtection: String(p.deletionProtection !== false)
    };
  }

  async create(ctx: CallContext, spec: ResourceSpec<'database'>, handle: (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string) => OperationHandle): Promise<OperationResult> {
    const p = spec.props;
    if (p.publicAccess !== false) throw new CloudProviderError('A managed database is private only: publicAccess must be false.', 'aws', 400, 'public_data');
    const region = this.region(ctx, undefined, spec);
    const existing = await this.find(ctx, spec);
    if (existing) return existing.state === 'ready' ? { done: true, resource: existing, adopted: true } : { done: false, operation: handle('create', existing, 'aws-describe', 'database'), resource: existing, adopted: true };
    const id = this.identifier(ctx, spec);
    const aurora = p.service === 'aurora';
    const engine = aurora ? `aurora-${p.engine === 'mysql' ? 'mysql' : 'postgresql'}` : p.engine;
    const major = majorOf(p.engine, p.version ?? defaultVersion('aws', p));
    const { subnetGroup, paramGroup } = await this.ensureGroups(ctx, region, spec, id, engine, major);
    const tags = this.tagParams({ ...spec.tags, 'exprsn:name': spec.name });
    const sub: Record<string, string> = subnetGroup ? { DBSubnetGroupName: subnetGroup } : {};
    const ref: ResourceRef = { type: 'database', providerId: `${aurora ? 'cluster' : 'instance'}:${id}`, region };
    try {
      if (p.restoreFrom) {
        await this.restoreInto(ctx, region, aurora ? 'cluster' : 'instance', p.restoreFrom, id, { size: p.size, ha: !!p.ha, sub, sg: this.common(p, spec), paramGroup, tags, engine });
      } else if (aurora) {
        await this.q(ctx, region, 'CreateDBCluster', { DBClusterIdentifier: id, Engine: engine, EngineVersion: major, ...sub, DBClusterParameterGroupName: paramGroup, MasterUsername: p.adminUser ?? 'exprsn_admin', ...(await this.password(ctx, p)), StorageEncrypted: 'true', CopyTagsToSnapshot: 'true', ...this.common(p, spec), ...tags });
        await this.q(ctx, region, 'CreateDBInstance', { DBInstanceIdentifier: `${id.slice(0, 60)}-w`, DBClusterIdentifier: id, Engine: engine, DBInstanceClass: p.size, PubliclyAccessible: 'false', ...tags });
        if (p.ha) await this.q(ctx, region, 'CreateDBInstance', { DBInstanceIdentifier: `${id.slice(0, 60)}-r`, DBClusterIdentifier: id, Engine: engine, DBInstanceClass: p.size, PubliclyAccessible: 'false', ...tags });
      } else {
        await this.q(ctx, region, 'CreateDBInstance', {
          DBInstanceIdentifier: id,
          Engine: engine,
          EngineVersion: major,
          DBInstanceClass: p.size,
          AllocatedStorage: String(p.storageGb ?? 50),
          ...(p.storageAutogrow ? { MaxAllocatedStorage: String(Math.min(65536, (p.storageGb ?? 50) * 4)) } : {}),
          StorageType: 'gp3',
          StorageEncrypted: 'true',
          MultiAZ: String(!!p.ha),
          PubliclyAccessible: 'false',
          ...sub,
          DBParameterGroupName: paramGroup,
          MasterUsername: p.adminUser ?? 'exprsn_admin',
          ...(await this.password(ctx, p)),
          CopyTagsToSnapshot: 'true',
          ...this.common(p, spec),
          ...tags
        });
      }
    } catch (err) {
      // A lost response's create: the identifier is ours, so what is there is adopted.
      if (err instanceof CloudProviderError && err.status === 409) {
        const found = await this.find(ctx, spec);
        if (found) return { done: false, operation: handle('create', found, 'aws-describe', 'database'), resource: found, adopted: true };
      }
      throw err;
    }
    const o = await this.describe(ctx, ref);
    return o?.state === 'ready' ? { done: true, resource: o } : { done: false, operation: handle('create', ref, 'aws-describe', 'database'), ...(o ? { resource: o } : {}) };
  }

  async update(ctx: CallContext, ref: ResourceRef, spec: ResourceSpec<'database'>, handle: (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string) => OperationHandle): Promise<OperationResult> {
    const p = spec.props;
    const region = this.region(ctx, ref, spec);
    const { kind, id } = splitId(ref.providerId);
    const db = await this.read(ctx, region, kind, id);
    if (!db) throw new CloudProviderError(`${ref.providerId} no longer exists.`, 'aws', 404, 'not_found');
    if (p.publicAccess !== false) throw new CloudProviderError('A managed database is private only: publicAccess must be false.', 'aws', 400, 'public_data');
    if (db.paramGroup && !db.paramGroup.startsWith('default.')) await this.setParameters(ctx, region, kind, db.paramGroup, this.paramsWithAllowList(p));
    // Deletion protection is turned on here, never off (only a delete with its final snapshot turns it off).
    const common = { ...this.common(p, spec), DeletionProtection: String(db.deletionProtection || p.deletionProtection !== false), ApplyImmediately: 'true' };
    if (kind === 'cluster') {
      await this.q(ctx, region, 'ModifyDBCluster', { DBClusterIdentifier: id, ...common });
      for (const m of db.members) await this.q(ctx, region, 'ModifyDBInstance', { DBInstanceIdentifier: m, DBInstanceClass: p.size, ApplyImmediately: 'true' });
    } else {
      await this.q(ctx, region, 'ModifyDBInstance', { DBInstanceIdentifier: id, DBInstanceClass: p.size, MultiAZ: String(!!p.ha), ...(p.storageGb && (db.storageGb ?? 0) < p.storageGb ? { AllocatedStorage: String(p.storageGb) } : {}), ...common });
    }
    const o = await this.describe(ctx, ref);
    return o?.state === 'ready' ? { done: true, resource: o } : { done: false, operation: handle('update', ref, 'aws-describe', 'database'), ...(o ? { resource: o } : {}) };
  }

  /** The newest final snapshot of a database (within the age a delete accepts), or null. */
  private async finalSnapshot(ctx: CallContext, region: string, kind: Kind, id: string): Promise<DatabaseSnapshot | null> {
    const now = Date.now();
    const all = await this.snapshotsOf(ctx, region, kind, id);
    return all.filter((s) => s.final && s.state === 'available' && s.createdAt != null && now - s.createdAt <= FINAL_SNAPSHOT_MAX_AGE_MS).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0] ?? null;
  }

  async delete(ctx: CallContext, ref: ResourceRef, handle: (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string) => OperationHandle): Promise<OperationResult> {
    const region = this.region(ctx, ref);
    const { kind, id } = splitId(ref.providerId);
    const db = await this.read(ctx, region, kind, id);
    if (!db) return { done: true, resource: null };
    if (db.deletionProtection) {
      const final = await this.finalSnapshot(ctx, region, kind, id);
      if (!final) throw new CloudProviderError(`${id} has deletion protection on and no final snapshot from the last ${FINAL_SNAPSHOT_MAX_AGE_MS / 3_600_000} hours; it is deleted only by destroy, after its final snapshot.`, 'aws', 409, 'final_snapshot_required');
      if (kind === 'cluster') await this.q(ctx, region, 'ModifyDBCluster', { DBClusterIdentifier: id, DeletionProtection: 'false', ApplyImmediately: 'true' });
      else await this.q(ctx, region, 'ModifyDBInstance', { DBInstanceIdentifier: id, DeletionProtection: 'false', ApplyImmediately: 'true' });
    }
    try {
      if (kind === 'cluster') {
        for (const m of db.members) await this.q(ctx, region, 'DeleteDBInstance', { DBInstanceIdentifier: m, SkipFinalSnapshot: 'true' }).catch((err) => {
          if (!(err instanceof CloudProviderError && err.status === 404)) throw err;
        });
        return { done: false, operation: handle('delete', ref, 'aws-describe', 'aurora-delete') };
      }
      await this.q(ctx, region, 'DeleteDBInstance', { DBInstanceIdentifier: id, SkipFinalSnapshot: 'true', DeleteAutomatedBackups: 'false' });
    } catch (err) {
      if (err instanceof CloudProviderError && err.status === 404) return { done: true, resource: null };
      throw err;
    }
    return { done: false, operation: handle('delete', ref, 'aws-describe', 'database') };
  }

  async poll(ctx: CallContext, h: OperationHandle): Promise<PollResult> {
    const region = this.region(ctx, h.ref);
    const { kind, id } = splitId(h.ref.providerId);
    if (h.op === 'delete' && h.token === 'aurora-delete') {
      const db = await this.read(ctx, region, 'cluster', id);
      if (!db) return { state: 'succeeded', resource: null };
      const left = [];
      for (const m of db.members) if (await this.read(ctx, region, 'instance', m)) left.push(m);
      if (!left.length && db.status !== 'deleting') await this.q(ctx, region, 'DeleteDBCluster', { DBClusterIdentifier: id, SkipFinalSnapshot: 'true' }).catch((err) => {
        if (!(err instanceof CloudProviderError && err.status === 404)) throw err;
      });
      return { state: 'pending', waitMs: 5000 };
    }
    const db = await this.read(ctx, region, kind, id);
    if (h.op === 'delete') return db ? { state: 'pending', waitMs: 5000 } : { state: 'succeeded', resource: null };
    if (!db) return { state: 'failed', error: `${id} disappeared.`, code: 'not_found' };
    const o = await this.observed(ctx, region, db);
    if (o.state === 'failed') return { state: 'failed', error: `${id} is ${db.status}.`, code: db.status };
    if (kind === 'cluster' && o.state === 'ready') {
      for (const m of db.members) {
        const inst = await this.read(ctx, region, 'instance', m);
        if (inst && inst.status !== 'available') return { state: 'pending', waitMs: 5000 };
      }
    }
    return o.state === 'ready' ? { state: 'succeeded', resource: o } : { state: 'pending', waitMs: 5000 };
  }

  // ---------- snapshots (B-10307) ----------

  private async snapshotsOf(ctx: CallContext, region: string, kind: Kind, id: string): Promise<DatabaseSnapshot[]> {
    const db = await this.read(ctx, region, kind, id);
    const retention = db?.retention ?? 7;
    const r = await this.q(ctx, region, kind === 'cluster' ? 'DescribeDBClusterSnapshots' : 'DescribeDBSnapshots', { [kind === 'cluster' ? 'DBClusterIdentifier' : 'DBInstanceIdentifier']: id });
    return xmlAll(r.text, kind === 'cluster' ? 'DBClusterSnapshot' : 'DBSnapshot').map((x) => {
      const sid = xmlText(x, kind === 'cluster' ? 'DBClusterSnapshotIdentifier' : 'DBSnapshotIdentifier') ?? '';
      const type = xmlText(x, 'SnapshotType') ?? 'manual';
      const created = Date.parse(xmlText(x, 'SnapshotCreateTime') ?? '');
      const status = xmlText(x, 'Status') ?? 'creating';
      const automated = type === 'automated';
      return {
        id: sid,
        name: sid,
        kind: automated ? 'automated' : 'manual',
        state: status === 'available' ? 'available' : status === 'failed' ? 'failed' : 'pending',
        createdAt: Number.isFinite(created) ? created : null,
        sizeGb: num(xmlText(x, 'AllocatedStorage')),
        expiresAt: automated && Number.isFinite(created) ? created + retention * 86_400_000 : null,
        final: isFinalName(sid) || tagsOf(x)['exprsn:purpose'] === 'final',
        billing: automated ? { sku: kind === 'cluster' ? 'aurora:backup' : 'rds:backup', unit: 'included' } : { sku: kind === 'cluster' ? 'aurora:snapshot' : 'rds:snapshot', unit: 'gb-month' }
      } satisfies DatabaseSnapshot;
    });
  }

  async listSnapshots(ctx: CallContext, ref: ResourceRef): Promise<DatabaseSnapshot[]> {
    const { kind, id } = splitId(ref.providerId);
    return this.snapshotsOf(ctx, this.region(ctx, ref), kind, id);
  }

  async snapshot(ctx: CallContext, ref: ResourceRef, name: string, purpose: SnapshotPurpose): Promise<SnapshotResult> {
    const region = this.region(ctx, ref);
    const { kind, id } = splitId(ref.providerId);
    const sid = dbIdentifier('', name, 255);
    const tags = this.tagParams({ 'exprsn:purpose': purpose, 'exprsn:snapshot-of': id });
    let requestId: string | null = null;
    try {
      requestId = (await this.q(ctx, region, kind === 'cluster' ? 'CreateDBClusterSnapshot' : 'CreateDBSnapshot', { [kind === 'cluster' ? 'DBClusterSnapshotIdentifier' : 'DBSnapshotIdentifier']: sid, [kind === 'cluster' ? 'DBClusterIdentifier' : 'DBInstanceIdentifier']: id, ...tags })).requestId;
    } catch (err) {
      if (!(err instanceof CloudProviderError && err.status === 409)) throw err; // a retried call: the snapshot is ours
    }
    const pending: SnapshotResult = { state: 'pending', name: sid, snapshotId: null, operation: { provider: 'aws', type: 'database', op: 'update', kind: 'aws-describe', ref: { type: 'database', providerId: ref.providerId, region }, token: `snapshot:${sid}`, startedAt: Date.now() }, waitMs: 5000, requestId };
    return this.snapshotStatus(ctx, ref, pending);
  }

  async snapshotStatus(ctx: CallContext, ref: ResourceRef, pending: SnapshotResult): Promise<SnapshotResult> {
    if (pending.state !== 'pending' || !pending.operation) return pending;
    const region = this.region(ctx, ref);
    const token = pending.operation.token;
    if (token.startsWith('restore:')) {
      const target = token.slice('restore:'.length);
      const { kind, id } = splitId(target);
      const db = await this.read(ctx, region, kind, id);
      if (!db) return { ...pending, state: 'failed', error: `The restored database ${id} is gone.` };
      if (db.status === 'failed') return { ...pending, state: 'failed', error: `The restore of ${id} failed.` };
      if (db.status !== 'available') return { ...pending, waitMs: 5000 };
      if (kind === 'cluster') for (const m of db.members) if ((await this.read(ctx, region, 'instance', m))?.status !== 'available') return { ...pending, waitMs: 5000 };
      const { operation: _o, ...rest } = pending;
      return { ...rest, state: 'done', restoredId: target };
    }
    const sid = token.slice('snapshot:'.length);
    const { kind, id } = splitId(ref.providerId);
    const snap = (await this.snapshotsOf(ctx, region, kind, id)).find((s) => s.id === sid);
    if (!snap) return { ...pending, waitMs: 5000 };
    if (snap.state === 'failed') return { ...pending, state: 'failed', error: `The snapshot ${sid} failed.` };
    if (snap.state !== 'available') return { ...pending, waitMs: 5000 };
    const { operation: _o, ...rest } = pending;
    return { ...rest, state: 'done', snapshotId: sid };
  }

  async deleteSnapshot(ctx: CallContext, ref: ResourceRef, snapshotId: string): Promise<void> {
    if (isFinalName(snapshotId)) throw new CloudProviderError('A final snapshot is never deleted by Exprsn-AI.', 'aws', 409, 'final_snapshot');
    const { kind } = splitId(ref.providerId);
    await this.q(ctx, this.region(ctx, ref), kind === 'cluster' ? 'DeleteDBClusterSnapshot' : 'DeleteDBSnapshot', { [kind === 'cluster' ? 'DBClusterSnapshotIdentifier' : 'DBSnapshotIdentifier']: snapshotId }).catch((err) => {
      if (!(err instanceof CloudProviderError && err.status === 404)) throw err;
    });
  }

  private async restoreInto(ctx: CallContext, region: string, kind: Kind, snapshotId: string, newId: string, o: { size: string; ha: boolean; sub: Record<string, string>; sg: Record<string, string>; paramGroup: string | null; tags: Record<string, string>; engine: string }): Promise<void> {
    const sgOnly = Object.fromEntries(Object.entries(o.sg).filter(([k]) => k.startsWith('VpcSecurityGroupIds')));
    if (kind === 'cluster') {
      await this.q(ctx, region, 'RestoreDBClusterFromSnapshot', { DBClusterIdentifier: newId, SnapshotIdentifier: snapshotId, Engine: o.engine, ...o.sub, ...sgOnly, ...(o.paramGroup ? { DBClusterParameterGroupName: o.paramGroup } : {}), DeletionProtection: 'true', CopyTagsToSnapshot: 'true', ...o.tags });
      await this.q(ctx, region, 'CreateDBInstance', { DBInstanceIdentifier: `${newId.slice(0, 60)}-w`, DBClusterIdentifier: newId, Engine: o.engine, DBInstanceClass: o.size, PubliclyAccessible: 'false', ...o.tags });
      return;
    }
    await this.q(ctx, region, 'RestoreDBInstanceFromDBSnapshot', { DBInstanceIdentifier: newId, DBSnapshotIdentifier: snapshotId, DBInstanceClass: o.size, MultiAZ: String(o.ha), PubliclyAccessible: 'false', ...o.sub, ...sgOnly, ...(o.paramGroup ? { DBParameterGroupName: o.paramGroup } : {}), DeletionProtection: 'true', CopyTagsToSnapshot: 'true', ...o.tags });
  }

  /** B-10307: a snapshot restored to a new database beside the one it came from (same subnets, security group and parameters). */
  async restore(ctx: CallContext, ref: ResourceRef, snapshotId: string, o: { name?: string; tags?: Record<string, string> } = {}): Promise<SnapshotResult> {
    const region = this.region(ctx, ref);
    const { kind, id } = splitId(ref.providerId);
    const db = await this.read(ctx, region, kind, id);
    if (!db) throw new CloudProviderError(`${id} no longer exists; restore from its snapshot into a new deployment instead.`, 'aws', 404, 'not_found');
    const writer = kind === 'cluster' && db.members[0] ? await this.read(ctx, region, 'instance', db.members[0]) : db;
    const newId = dbIdentifier('', o.name ?? `${id}-restored-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}`, 63);
    const sub: Record<string, string> = db.subnetGroup ? { DBSubnetGroupName: db.subnetGroup } : {};
    const sg = db.securityGroups.length ? this.list1('VpcSecurityGroupIds', 'VpcSecurityGroupId', db.securityGroups) : {};
    try {
      await this.restoreInto(ctx, region, kind, snapshotId, newId, { size: writer?.size ?? 'db.t4g.medium', ha: db.multiAz, sub, sg, paramGroup: db.paramGroup && !db.paramGroup.startsWith('default.') ? db.paramGroup : null, tags: this.tagParams({ ...(o.tags ?? managed(db.tags)), 'exprsn:name': newId, 'exprsn:restored-from': snapshotId.slice(0, 200) }), engine: db.engine });
    } catch (err) {
      if (!(err instanceof CloudProviderError && err.status === 409)) throw err; // a retried call: the new database is ours
    }
    const target = `${kind}:${newId}`;
    return { state: 'pending', name: `restore:${snapshotId}`, snapshotId, operation: { provider: 'aws', type: 'database', op: 'create', kind: 'aws-describe', ref: { type: 'database', providerId: target, region }, token: `restore:${target}`, startedAt: Date.now() }, waitMs: 5000 };
  }

  // ---------- extensions (B-10301) ----------

  async extensions(ctx: CallContext, ref: ResourceRef, wanted: string[]): Promise<ExtensionStatus[]> {
    const region = this.region(ctx, ref);
    const { kind, id } = splitId(ref.providerId);
    const db = await this.read(ctx, region, kind, id);
    if (!db) throw new CloudProviderError(`${id} no longer exists.`, 'aws', 404, 'not_found');
    const engine = db.engine.includes('mysql') ? 'mysql' : 'postgres';
    const params = await this.parameters(ctx, region, kind, db.paramGroup);
    const allowed = params['rds.allowed_extensions'];
    const set: Set<string> | '*' = !allowed || allowed.trim() === '*' ? '*' : new Set(allowed.split(',').map((x) => x.trim()));
    return extensionStatus('aws', { engine, service: kind === 'cluster' ? 'aurora' : 'rds' }, wanted, set);
  }
}
