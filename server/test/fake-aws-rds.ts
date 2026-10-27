/*
 * 1.9.99-final, Sprint 59 (B-10301, B-10303, B-10307): RDS and Aurora for the AWS fake (`fake-aws.ts` routes the `rds`
 * service here), over the Query API as RDS speaks it. Working: DB subnet groups, DB and cluster parameter groups with
 * their parameters (`Source=user` reads), DB instances and clusters (creating, then available after `settleAfter`
 * describes; modifying; deleting, then gone), deletion protection (a delete of a protected instance or cluster is
 * refused, as RDS refuses it), manual and automated snapshots of instances and clusters, and restores from a snapshot
 * to a new instance or cluster. Passwords are never kept: only whether RDS manages the master password or one was
 * given. It is never the real RDS.
 */
import { xmlEsc, type Reply } from './fake-cloud-base.js';

export interface FakeRdsHost {
  ok(action: string, inner: string): Reply;
  error(status: number, code: string, message: string): Reply;
  settleAfter(): number;
  account(): string;
}

type Tags = Record<string, string>;

export interface FakeRdsInstance {
  id: string;
  engine: string;
  engineVersion: string;
  instanceClass: string;
  allocatedStorage: number;
  maxAllocatedStorage: number | null;
  multiAz: boolean;
  publiclyAccessible: boolean;
  deletionProtection: boolean;
  retention: number;
  backupWindow: string;
  maintenanceWindow: string;
  paramGroup: string;
  subnetGroup: string | null;
  securityGroups: string[];
  storageEncrypted: boolean;
  managedPassword: boolean;
  passwordGiven: boolean;
  cluster: string | null;
  status: string;
  reads: number;
  tags: Tags;
  restoredFrom: string | null;
  createdAt: number;
}

export interface FakeRdsCluster {
  id: string;
  engine: string;
  engineVersion: string;
  deletionProtection: boolean;
  retention: number;
  backupWindow: string;
  maintenanceWindow: string;
  paramGroup: string;
  subnetGroup: string | null;
  securityGroups: string[];
  managedPassword: boolean;
  status: string;
  reads: number;
  tags: Tags;
  restoredFrom: string | null;
  createdAt: number;
}

export interface FakeRdsSnapshot {
  id: string;
  source: string;
  cluster: boolean;
  type: 'manual' | 'automated';
  status: string;
  createdAt: number;
  allocatedStorage: number;
  engine: string;
  reads: number;
  tags: Tags;
}

const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');

function listParam(p: URLSearchParams, prefix: string): string[] {
  const out: string[] = [];
  for (let i = 1; i < 100; i++) {
    const v = [...p.keys()].find((k) => k.startsWith(`${prefix}.`) && k.endsWith(`.${i}`) && k.split('.').length === 3);
    if (!v) break;
    out.push(p.get(v)!);
  }
  return out;
}

function tagParam(p: URLSearchParams): Tags {
  const out: Tags = {};
  for (let i = 1; i < 100; i++) {
    const k = p.get(`Tags.Tag.${i}.Key`) ?? p.get(`Tags.member.${i}.Key`);
    if (k == null) break;
    out[k] = p.get(`Tags.Tag.${i}.Value`) ?? p.get(`Tags.member.${i}.Value`) ?? '';
  }
  return out;
}

const tagXml = (t: Tags) => `<TagList>${Object.entries(t).map(([k, v]) => `<Tag><Key>${xmlEsc(k)}</Key><Value>${xmlEsc(v)}</Value></Tag>`).join('')}</TagList>`;

export class FakeRds {
  readonly instances = new Map<string, FakeRdsInstance>();
  readonly clusters = new Map<string, FakeRdsCluster>();
  readonly subnetGroups = new Map<string, { subnets: string[]; tags: Tags }>();
  readonly paramGroups = new Map<string, { family: string; cluster: boolean; params: Record<string, string> }>();
  readonly snapshots = new Map<string, FakeRdsSnapshot>();

  constructor(private readonly h: FakeRdsHost) {}

  private settle(x: { status: string; reads: number }): void {
    x.reads += 1;
    if (x.reads > this.h.settleAfter() && ['creating', 'modifying', 'backing-up', 'rebooting'].includes(x.status)) x.status = 'available';
  }

  private instanceXml(i: FakeRdsInstance): string {
    this.settle(i);
    if (i.status === 'deleting' && i.reads > this.h.settleAfter()) {
      this.instances.delete(i.id);
      return '';
    }
    if (i.status === 'available' && !i.cluster && ![...this.snapshots.values()].some((s) => s.source === i.id && s.type === 'automated')) this.automated(i.id, false, i.allocatedStorage, i.engine);
    const port = i.engine.includes('mysql') ? 3306 : 5432;
    return `<DBInstance><DBInstanceIdentifier>${xmlEsc(i.id)}</DBInstanceIdentifier><DBInstanceClass>${xmlEsc(i.instanceClass)}</DBInstanceClass><Engine>${xmlEsc(i.engine)}</Engine><DBInstanceStatus>${i.status}</DBInstanceStatus><Endpoint><Address>${xmlEsc(i.id)}.abc123.${'eu-central-1'}.rds.amazonaws.com</Address><Port>${port}</Port></Endpoint><AllocatedStorage>${i.allocatedStorage}</AllocatedStorage><PreferredBackupWindow>${xmlEsc(i.backupWindow)}</PreferredBackupWindow><BackupRetentionPeriod>${i.retention}</BackupRetentionPeriod><VpcSecurityGroups>${i.securityGroups.map((g) => `<VpcSecurityGroupMembership><VpcSecurityGroupId>${xmlEsc(g)}</VpcSecurityGroupId><Status>active</Status></VpcSecurityGroupMembership>`).join('')}</VpcSecurityGroups><DBParameterGroups><DBParameterGroup><DBParameterGroupName>${xmlEsc(i.paramGroup)}</DBParameterGroupName><ParameterApplyStatus>in-sync</ParameterApplyStatus></DBParameterGroup></DBParameterGroups>${i.subnetGroup ? `<DBSubnetGroup><DBSubnetGroupName>${xmlEsc(i.subnetGroup)}</DBSubnetGroupName><VpcId>vpc-fake</VpcId></DBSubnetGroup>` : ''}<PreferredMaintenanceWindow>${xmlEsc(i.maintenanceWindow)}</PreferredMaintenanceWindow><MultiAZ>${i.multiAz}</MultiAZ><EngineVersion>${xmlEsc(i.engineVersion)}</EngineVersion><PubliclyAccessible>${i.publiclyAccessible}</PubliclyAccessible><StorageEncrypted>${i.storageEncrypted}</StorageEncrypted><DeletionProtection>${i.deletionProtection}</DeletionProtection>${i.cluster ? `<DBClusterIdentifier>${xmlEsc(i.cluster)}</DBClusterIdentifier>` : ''}${tagXml(i.tags)}</DBInstance>`;
  }

  private clusterXml(c: FakeRdsCluster): string {
    this.settle(c);
    const members = [...this.instances.values()].filter((i) => i.cluster === c.id);
    if (c.status === 'deleting' && c.reads > this.h.settleAfter()) {
      this.clusters.delete(c.id);
      return '';
    }
    if (c.status === 'available' && ![...this.snapshots.values()].some((s) => s.source === c.id && s.type === 'automated')) this.automated(c.id, true, 10, c.engine);
    return `<DBCluster><AllocatedStorage>1</AllocatedStorage><BackupRetentionPeriod>${c.retention}</BackupRetentionPeriod><DBClusterIdentifier>${xmlEsc(c.id)}</DBClusterIdentifier><DBClusterParameterGroup>${xmlEsc(c.paramGroup)}</DBClusterParameterGroup>${c.subnetGroup ? `<DBSubnetGroup>${xmlEsc(c.subnetGroup)}</DBSubnetGroup>` : ''}<Status>${c.status}</Status><Endpoint>${xmlEsc(c.id)}.cluster-abc123.eu-central-1.rds.amazonaws.com</Endpoint><Engine>${xmlEsc(c.engine)}</Engine><EngineVersion>${xmlEsc(c.engineVersion)}</EngineVersion><Port>${c.engine.includes('mysql') ? 3306 : 5432}</Port><PreferredBackupWindow>${xmlEsc(c.backupWindow)}</PreferredBackupWindow><PreferredMaintenanceWindow>${xmlEsc(c.maintenanceWindow)}</PreferredMaintenanceWindow><DBClusterMembers>${members.map((m, n) => `<DBClusterMember><DBInstanceIdentifier>${xmlEsc(m.id)}</DBInstanceIdentifier><IsClusterWriter>${n === 0}</IsClusterWriter></DBClusterMember>`).join('')}</DBClusterMembers><VpcSecurityGroups>${c.securityGroups.map((g) => `<VpcSecurityGroupMembership><VpcSecurityGroupId>${xmlEsc(g)}</VpcSecurityGroupId></VpcSecurityGroupMembership>`).join('')}</VpcSecurityGroups><MultiAZ>${members.length > 1}</MultiAZ><DeletionProtection>${c.deletionProtection}</DeletionProtection>${tagXml(c.tags)}</DBCluster>`;
  }

  private automated(source: string, cluster: boolean, storage: number, engine: string): void {
    const now = Date.now();
    const id = `rds:${source}-${new Date(now).toISOString().slice(0, 10)}-03-10`;
    this.snapshots.set(id, { id, source, cluster, type: 'automated', status: 'available', createdAt: now, allocatedStorage: storage, engine, reads: 0, tags: {} });
  }

  private snapshotXml(s: FakeRdsSnapshot): string {
    s.reads += 1;
    if (s.status === 'creating' && s.reads > this.h.settleAfter()) s.status = 'available';
    const el = s.cluster ? 'DBClusterSnapshot' : 'DBSnapshot';
    return `<${el}><${el}Identifier>${xmlEsc(s.id)}</${el}Identifier><${s.cluster ? 'DBClusterIdentifier' : 'DBInstanceIdentifier'}>${xmlEsc(s.source)}</${s.cluster ? 'DBClusterIdentifier' : 'DBInstanceIdentifier'}><SnapshotCreateTime>${iso(s.createdAt)}</SnapshotCreateTime><Engine>${xmlEsc(s.engine)}</Engine><AllocatedStorage>${s.allocatedStorage}</AllocatedStorage><Status>${s.status}</Status><SnapshotType>${s.type}</SnapshotType>${tagXml(s.tags)}</${el}>`;
  }

  private notFound(kind: string, id: string): Reply {
    const code = kind === 'instance' ? 'DBInstanceNotFound' : kind === 'cluster' ? 'DBClusterNotFoundFault' : kind === 'snapshot' ? 'DBSnapshotNotFound' : kind === 'cluster-snapshot' ? 'DBClusterSnapshotNotFoundFault' : kind === 'paramgroup' ? 'DBParameterGroupNotFound' : 'DBSubnetGroupNotFoundFault';
    return this.h.error(404, code, `${kind} ${id} not found.`);
  }

  handle(p: URLSearchParams): Reply {
    const a = p.get('Action') ?? '';
    const now = Date.now();
    switch (a) {
      case 'CreateDBSubnetGroup': {
        const name = p.get('DBSubnetGroupName')!;
        if (this.subnetGroups.has(name)) return this.h.error(400, 'DBSubnetGroupAlreadyExists', `DB subnet group ${name} already exists.`);
        const subnets = listParam(p, 'SubnetIds');
        if (!subnets.length) return this.h.error(400, 'InvalidParameterValue', 'SubnetIds is required.');
        this.subnetGroups.set(name, { subnets, tags: tagParam(p) });
        return this.h.ok(a, `<DBSubnetGroup><DBSubnetGroupName>${xmlEsc(name)}</DBSubnetGroupName></DBSubnetGroup>`);
      }
      case 'CreateDBParameterGroup':
      case 'CreateDBClusterParameterGroup': {
        const cluster = a === 'CreateDBClusterParameterGroup';
        const name = p.get(cluster ? 'DBClusterParameterGroupName' : 'DBParameterGroupName')!;
        if (this.paramGroups.has(name)) return this.h.error(400, 'DBParameterGroupAlreadyExists', `Parameter group ${name} already exists.`);
        this.paramGroups.set(name, { family: p.get('DBParameterGroupFamily') ?? '', cluster, params: {} });
        return this.h.ok(a, `<DBParameterGroup><DBParameterGroupName>${xmlEsc(name)}</DBParameterGroupName></DBParameterGroup>`);
      }
      case 'ModifyDBParameterGroup':
      case 'ModifyDBClusterParameterGroup': {
        const name = p.get(a === 'ModifyDBClusterParameterGroup' ? 'DBClusterParameterGroupName' : 'DBParameterGroupName')!;
        const g = this.paramGroups.get(name);
        if (!g) return this.notFound('paramgroup', name);
        for (let i = 1; i < 100; i++) {
          const k = p.get(`Parameters.Parameter.${i}.ParameterName`);
          if (k == null) break;
          g.params[k] = p.get(`Parameters.Parameter.${i}.ParameterValue`) ?? '';
        }
        return this.h.ok(a, `<DBParameterGroupName>${xmlEsc(name)}</DBParameterGroupName>`);
      }
      case 'DescribeDBParameters':
      case 'DescribeDBClusterParameters': {
        const name = p.get(a === 'DescribeDBClusterParameters' ? 'DBClusterParameterGroupName' : 'DBParameterGroupName')!;
        const g = this.paramGroups.get(name);
        if (!g) return this.notFound('paramgroup', name);
        return this.h.ok(a, `<Parameters>${Object.entries(g.params).map(([k, v]) => `<Parameter><ParameterName>${xmlEsc(k)}</ParameterName><ParameterValue>${xmlEsc(v)}</ParameterValue><Source>user</Source></Parameter>`).join('')}</Parameters>`);
      }
      case 'CreateDBInstance':
      case 'RestoreDBInstanceFromDBSnapshot': {
        const id = p.get('DBInstanceIdentifier')!;
        if (this.instances.has(id)) return this.h.error(400, 'DBInstanceAlreadyExists', `DB instance ${id} already exists.`);
        const cluster = p.get('DBClusterIdentifier');
        if (cluster && !this.clusters.has(cluster)) return this.notFound('cluster', cluster);
        let from: FakeRdsSnapshot | null = null;
        if (a === 'RestoreDBInstanceFromDBSnapshot') {
          from = this.snapshots.get(p.get('DBSnapshotIdentifier') ?? '') ?? null;
          if (!from || from.cluster) return this.notFound('snapshot', p.get('DBSnapshotIdentifier') ?? '');
          if (from.status !== 'available') return this.h.error(400, 'InvalidDBSnapshotState', 'The snapshot is not available.');
        }
        const source = from ? this.instances.get(from.source) : null;
        const sg = p.get('DBSubnetGroupName');
        if (sg && !this.subnetGroups.has(sg)) return this.notFound('subnetgroup', sg);
        const pg = p.get('DBParameterGroupName') ?? (cluster ? this.clusters.get(cluster)!.paramGroup : `default.${p.get('Engine')}`);
        if (pg && !pg.startsWith('default.') && !this.paramGroups.has(pg)) return this.notFound('paramgroup', pg);
        const c = cluster ? this.clusters.get(cluster)! : null;
        const i: FakeRdsInstance = {
          id,
          engine: p.get('Engine') ?? from?.engine ?? source?.engine ?? 'postgres',
          engineVersion: c?.engineVersion ?? (p.get('EngineVersion') ? `${p.get('EngineVersion')}${p.get('EngineVersion')!.includes('.') ? '.36' : '.4'}` : (source?.engineVersion ?? '17.4')),
          instanceClass: p.get('DBInstanceClass') ?? source?.instanceClass ?? 'db.t4g.medium',
          allocatedStorage: Number(p.get('AllocatedStorage') ?? from?.allocatedStorage ?? 20),
          maxAllocatedStorage: p.get('MaxAllocatedStorage') ? Number(p.get('MaxAllocatedStorage')) : null,
          multiAz: p.get('MultiAZ') === 'true',
          publiclyAccessible: p.get('PubliclyAccessible') === 'true',
          deletionProtection: p.get('DeletionProtection') === 'true',
          retention: Number(p.get('BackupRetentionPeriod') ?? source?.retention ?? 1),
          backupWindow: p.get('PreferredBackupWindow') ?? source?.backupWindow ?? '03:00-03:30',
          maintenanceWindow: p.get('PreferredMaintenanceWindow') ?? source?.maintenanceWindow ?? 'mon:05:00-mon:05:30',
          paramGroup: pg,
          subnetGroup: sg ?? c?.subnetGroup ?? null,
          securityGroups: listParam(p, 'VpcSecurityGroupIds'),
          storageEncrypted: p.get('StorageEncrypted') === 'true' || !!from,
          managedPassword: p.get('ManageMasterUserPassword') === 'true',
          passwordGiven: !!p.get('MasterUserPassword'),
          cluster,
          status: 'creating',
          reads: 0,
          tags: tagParam(p),
          restoredFrom: from?.id ?? null,
          createdAt: now
        };
        this.instances.set(id, i);
        return this.h.ok(a, this.instanceXml(i));
      }
      case 'CreateDBCluster':
      case 'RestoreDBClusterFromSnapshot': {
        const id = p.get('DBClusterIdentifier')!;
        if (this.clusters.has(id)) return this.h.error(400, 'DBClusterAlreadyExistsFault', `DB cluster ${id} already exists.`);
        let from: FakeRdsSnapshot | null = null;
        if (a === 'RestoreDBClusterFromSnapshot') {
          from = this.snapshots.get(p.get('SnapshotIdentifier') ?? '') ?? null;
          if (!from || !from.cluster) return this.notFound('cluster-snapshot', p.get('SnapshotIdentifier') ?? '');
        }
        const source = from ? this.clusters.get(from.source) : null;
        const c: FakeRdsCluster = {
          id,
          engine: p.get('Engine') ?? source?.engine ?? 'aurora-postgresql',
          engineVersion: p.get('EngineVersion') ? `${p.get('EngineVersion')}${p.get('EngineVersion')!.includes('.') ? '.mysql_aurora.3.05.2' : '.4'}` : (source?.engineVersion ?? '16.4'),
          deletionProtection: p.get('DeletionProtection') === 'true',
          retention: Number(p.get('BackupRetentionPeriod') ?? source?.retention ?? 1),
          backupWindow: p.get('PreferredBackupWindow') ?? '03:00-03:30',
          maintenanceWindow: p.get('PreferredMaintenanceWindow') ?? 'mon:05:00-mon:05:30',
          paramGroup: p.get('DBClusterParameterGroupName') ?? 'default.aurora',
          subnetGroup: p.get('DBSubnetGroupName'),
          securityGroups: listParam(p, 'VpcSecurityGroupIds'),
          managedPassword: p.get('ManageMasterUserPassword') === 'true',
          status: 'creating',
          reads: 0,
          tags: tagParam(p),
          restoredFrom: from?.id ?? null,
          createdAt: now
        };
        this.clusters.set(id, c);
        return this.h.ok(a, this.clusterXml(c));
      }
      case 'DescribeDBInstances': {
        const id = p.get('DBInstanceIdentifier');
        if (id) {
          const i = this.instances.get(id);
          const x = i ? this.instanceXml(i) : '';
          return x ? this.h.ok(a, `<DBInstances>${x}</DBInstances>`) : this.notFound('instance', id);
        }
        return this.h.ok(a, `<DBInstances>${[...this.instances.values()].map((i) => this.instanceXml(i)).join('')}</DBInstances>`);
      }
      case 'DescribeDBClusters': {
        const id = p.get('DBClusterIdentifier');
        if (id) {
          const c = this.clusters.get(id);
          const x = c ? this.clusterXml(c) : '';
          return x ? this.h.ok(a, `<DBClusters>${x}</DBClusters>`) : this.notFound('cluster', id);
        }
        return this.h.ok(a, `<DBClusters>${[...this.clusters.values()].map((c) => this.clusterXml(c)).join('')}</DBClusters>`);
      }
      case 'ModifyDBInstance': {
        const id = p.get('DBInstanceIdentifier')!;
        const i = this.instances.get(id);
        if (!i) return this.notFound('instance', id);
        if (p.get('DBInstanceClass')) i.instanceClass = p.get('DBInstanceClass')!;
        if (p.get('AllocatedStorage')) i.allocatedStorage = Number(p.get('AllocatedStorage'));
        if (p.get('MultiAZ')) i.multiAz = p.get('MultiAZ') === 'true';
        if (p.get('BackupRetentionPeriod')) i.retention = Number(p.get('BackupRetentionPeriod'));
        if (p.get('PreferredBackupWindow')) i.backupWindow = p.get('PreferredBackupWindow')!;
        if (p.get('PreferredMaintenanceWindow')) i.maintenanceWindow = p.get('PreferredMaintenanceWindow')!;
        if (p.get('DeletionProtection')) i.deletionProtection = p.get('DeletionProtection') === 'true';
        if (p.get('PubliclyAccessible')) i.publiclyAccessible = p.get('PubliclyAccessible') === 'true';
        const sgs = listParam(p, 'VpcSecurityGroupIds');
        if (sgs.length) i.securityGroups = sgs;
        if (i.status === 'available' && [...p.keys()].some((k) => !['Action', 'Version', 'DBInstanceIdentifier', 'ApplyImmediately', 'DeletionProtection'].includes(k))) Object.assign(i, { status: 'modifying', reads: 0 });
        return this.h.ok(a, this.instanceXml(i));
      }
      case 'ModifyDBCluster': {
        const id = p.get('DBClusterIdentifier')!;
        const c = this.clusters.get(id);
        if (!c) return this.notFound('cluster', id);
        if (p.get('BackupRetentionPeriod')) c.retention = Number(p.get('BackupRetentionPeriod'));
        if (p.get('PreferredBackupWindow')) c.backupWindow = p.get('PreferredBackupWindow')!;
        if (p.get('PreferredMaintenanceWindow')) c.maintenanceWindow = p.get('PreferredMaintenanceWindow')!;
        if (p.get('DeletionProtection')) c.deletionProtection = p.get('DeletionProtection') === 'true';
        return this.h.ok(a, this.clusterXml(c));
      }
      case 'DeleteDBInstance': {
        const id = p.get('DBInstanceIdentifier')!;
        const i = this.instances.get(id);
        if (!i) return this.notFound('instance', id);
        if (i.deletionProtection) return this.h.error(400, 'InvalidParameterCombination', 'Cannot delete protected DB Instance, please disable deletion protection and try again.');
        if (p.get('SkipFinalSnapshot') !== 'true' && !p.get('FinalDBSnapshotIdentifier') && !i.cluster) return this.h.error(400, 'InvalidParameterCombination', 'FinalDBSnapshotIdentifier is required unless SkipFinalSnapshot is specified.');
        Object.assign(i, { status: 'deleting', reads: 0 });
        return this.h.ok(a, `<DBInstance><DBInstanceIdentifier>${xmlEsc(id)}</DBInstanceIdentifier><DBInstanceStatus>deleting</DBInstanceStatus></DBInstance>`);
      }
      case 'DeleteDBCluster': {
        const id = p.get('DBClusterIdentifier')!;
        const c = this.clusters.get(id);
        if (!c) return this.notFound('cluster', id);
        if (c.deletionProtection) return this.h.error(400, 'InvalidParameterCombination', 'Cannot delete protected Cluster, please disable deletion protection and try again.');
        if ([...this.instances.values()].some((i) => i.cluster === id)) return this.h.error(400, 'InvalidDBClusterStateFault', 'Cluster cannot be deleted, it still contains DB instances in non-deleting state.');
        Object.assign(c, { status: 'deleting', reads: 0 });
        return this.h.ok(a, `<DBCluster><DBClusterIdentifier>${xmlEsc(id)}</DBClusterIdentifier><Status>deleting</Status></DBCluster>`);
      }
      case 'CreateDBSnapshot':
      case 'CreateDBClusterSnapshot': {
        const cluster = a === 'CreateDBClusterSnapshot';
        const sid = p.get(cluster ? 'DBClusterSnapshotIdentifier' : 'DBSnapshotIdentifier')!;
        const source = p.get(cluster ? 'DBClusterIdentifier' : 'DBInstanceIdentifier')!;
        if (this.snapshots.has(sid)) return this.h.error(400, cluster ? 'DBClusterSnapshotAlreadyExistsFault' : 'DBSnapshotAlreadyExists', `Snapshot ${sid} already exists.`);
        const src = cluster ? this.clusters.get(source) : this.instances.get(source);
        if (!src) return this.notFound(cluster ? 'cluster' : 'instance', source);
        const s: FakeRdsSnapshot = { id: sid, source, cluster, type: 'manual', status: 'creating', createdAt: now, allocatedStorage: cluster ? 10 : (src as FakeRdsInstance).allocatedStorage, engine: src.engine, reads: 0, tags: tagParam(p) };
        this.snapshots.set(sid, s);
        return this.h.ok(a, this.snapshotXml(s));
      }
      case 'DescribeDBSnapshots':
      case 'DescribeDBClusterSnapshots': {
        const cluster = a === 'DescribeDBClusterSnapshots';
        const source = p.get(cluster ? 'DBClusterIdentifier' : 'DBInstanceIdentifier');
        const sid = p.get(cluster ? 'DBClusterSnapshotIdentifier' : 'DBSnapshotIdentifier');
        const type = p.get('SnapshotType');
        const list = [...this.snapshots.values()].filter((s) => s.cluster === cluster && (!source || s.source === source) && (!sid || s.id === sid) && (!type || s.type === type));
        if (sid && !list.length) return this.notFound(cluster ? 'cluster-snapshot' : 'snapshot', sid);
        return this.h.ok(a, `<${cluster ? 'DBClusterSnapshots' : 'DBSnapshots'}>${list.map((s) => this.snapshotXml(s)).join('')}</${cluster ? 'DBClusterSnapshots' : 'DBSnapshots'}>`);
      }
      case 'DeleteDBSnapshot':
      case 'DeleteDBClusterSnapshot': {
        const sid = p.get(a === 'DeleteDBClusterSnapshot' ? 'DBClusterSnapshotIdentifier' : 'DBSnapshotIdentifier')!;
        const s = this.snapshots.get(sid);
        if (!s) return this.notFound(a === 'DeleteDBClusterSnapshot' ? 'cluster-snapshot' : 'snapshot', sid);
        if (s.type === 'automated') return this.h.error(400, 'InvalidDBSnapshotState', 'Automated snapshots are deleted by RDS.');
        this.snapshots.delete(sid);
        return this.h.ok(a, this.snapshotXml({ ...s, status: 'deleted' }));
      }
    }
    return this.h.error(400, 'InvalidAction', `rds:${a} is not something this fake answers`);
  }

  /** A manual snapshot as if taken by hand at a time (a test's stale final snapshot). */
  addSnapshot(o: { id: string; source: string; cluster?: boolean; createdAt?: number; status?: string; tags?: Tags }): FakeRdsSnapshot {
    const src = o.cluster ? this.clusters.get(o.source) : this.instances.get(o.source);
    const s: FakeRdsSnapshot = { id: o.id, source: o.source, cluster: !!o.cluster, type: 'manual', status: o.status ?? 'available', createdAt: o.createdAt ?? Date.now(), allocatedStorage: (src as FakeRdsInstance | undefined)?.allocatedStorage ?? 10, engine: src?.engine ?? 'postgres', reads: 0, tags: o.tags ?? {} };
    this.snapshots.set(s.id, s);
    return s;
  }
}
