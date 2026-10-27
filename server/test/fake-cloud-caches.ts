/*
 * 1.9.99-final, Sprint 59 (B-10305): the managed caches of the three cloud fakes, in this process on 127.0.0.1 (never
 * the real services). `fake-aws.ts` hands ElastiCache and MemoryDB here, `fake-azure.ts` the Azure Cache for Redis
 * and Azure Managed Redis calls its generic ARM store does not answer (hosts, access keys), `fake-do.ts` managed
 * Valkey clusters under `/v2/databases`. Each keeps what a test asserts on: the AUTH token an ElastiCache replication
 * group was created with, the eviction policy and cluster mode as the provider would report them.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { xmlEsc, type RecordedRequest, type Reply } from './fake-cloud-base.js';

const NS = 'http://elasticache.amazonaws.com/doc/2015-02-02/';

interface ParamGroup { name: string; family: string; params: Record<string, string> }
export interface FakeReplicationGroup {
  id: string;
  arn: string;
  engine: string;
  nodeType: string;
  members: string[];
  clusterEnabled: boolean;
  paramGroup: string;
  subnetGroup: string | null;
  securityGroups: string[];
  tls: boolean;
  authToken: string | null;
  status: string;
  polls: number;
  tags: Record<string, string>;
  multiAz: boolean;
}

export class FakeElastiCache {
  readonly groups = new Map<string, FakeReplicationGroup>();
  readonly paramGroups = new Map<string, ParamGroup>();
  readonly subnetGroups = new Map<string, string[]>();
  /** MemoryDB clusters a test adds (always cluster mode). */
  readonly memoryClusters: Record<string, unknown>[] = [];
  private seq = 0;

  constructor(
    private readonly account: () => string,
    private readonly settleAfter: () => number
  ) {
    for (const family of ['redis7', 'valkey8', 'valkey7']) this.paramGroups.set(`default.${family}`, { name: `default.${family}`, family, params: { 'maxmemory-policy': 'volatile-lru' } });
  }

  /** A replication group made out of band (a test's incompatible cache). */
  addGroup(o: { id: string; clusterEnabled?: boolean; policy?: string; tls?: boolean; tags?: Record<string, string> }): FakeReplicationGroup {
    const pg = `custom-${o.id}`;
    this.paramGroups.set(pg, { name: pg, family: 'redis7', params: { 'maxmemory-policy': o.policy ?? 'volatile-lru' } });
    const g: FakeReplicationGroup = { id: o.id, arn: `arn:aws:elasticache:eu-central-1:${this.account()}:replicationgroup:${o.id}`, engine: 'redis', nodeType: 'cache.t4g.small', members: [`${o.id}-001`], clusterEnabled: !!o.clusterEnabled, paramGroup: pg, subnetGroup: null, securityGroups: [], tls: o.tls ?? true, authToken: null, status: 'available', polls: 99, tags: o.tags ?? {}, multiAz: false };
    this.groups.set(g.id, g);
    return g;
  }

  private ok(action: string, inner: string): Reply {
    this.seq += 1;
    return { status: 200, headers: { 'content-type': 'text/xml', 'x-amzn-requestid': `req-cache-${this.seq}` }, body: `<?xml version="1.0" encoding="UTF-8"?><${action}Response xmlns="${NS}"><${action}Result>${inner}</${action}Result><ResponseMetadata><RequestId>req-cache-${this.seq}</RequestId></ResponseMetadata></${action}Response>` };
  }

  private err(status: number, code: string, message: string): Reply {
    return { status, headers: { 'content-type': 'text/xml' }, body: `<?xml version="1.0" encoding="UTF-8"?><ErrorResponse xmlns="${NS}"><Error><Type>Sender</Type><Code>${code}</Code><Message>${xmlEsc(message)}</Message></Error><RequestId>req-cache-err</RequestId></ErrorResponse>` };
  }

  private list(p: URLSearchParams, prefix: string): string[] {
    const out: string[] = [];
    for (let i = 1; p.has(`${prefix}.${i}`); i++) out.push(p.get(`${prefix}.${i}`)!);
    return out;
  }

  private groupXml(g: FakeReplicationGroup): string {
    const port = 6379;
    const host = `master.${g.id}.abc123.euc1.cache.amazonaws.com`;
    return `<ReplicationGroup><ReplicationGroupId>${g.id}</ReplicationGroupId><Description>${xmlEsc(g.id)}</Description><Status>${g.status}</Status><Engine>${g.engine}</Engine><MemberClusters>${g.members.map((m) => `<ClusterId>${m}</ClusterId>`).join('')}</MemberClusters><NodeGroups><NodeGroup><NodeGroupId>0001</NodeGroupId><Status>${g.status}</Status><PrimaryEndpoint><Address>${host}</Address><Port>${port}</Port></PrimaryEndpoint></NodeGroup></NodeGroups><AutomaticFailover>${g.members.length > 1 ? 'enabled' : 'disabled'}</AutomaticFailover><MultiAZ>${g.multiAz ? 'enabled' : 'disabled'}</MultiAZ><ClusterEnabled>${g.clusterEnabled}</ClusterEnabled><ClusterMode>${g.clusterEnabled ? 'enabled' : 'disabled'}</ClusterMode><CacheNodeType>${g.nodeType}</CacheNodeType><AuthTokenEnabled>${!!g.authToken}</AuthTokenEnabled><TransitEncryptionEnabled>${g.tls}</TransitEncryptionEnabled><AtRestEncryptionEnabled>true</AtRestEncryptionEnabled><ARN>${g.arn}</ARN></ReplicationGroup>`;
  }

  /** Advances a group's state the way describing it would observe. */
  private settle(g: FakeReplicationGroup): void {
    g.polls += 1;
    if (g.polls <= this.settleAfter()) return;
    if (g.status === 'creating' || g.status === 'modifying') g.status = 'available';
    if (g.status === 'deleting') this.groups.delete(g.id);
  }

  handle(p: URLSearchParams): Reply {
    const action = p.get('Action') ?? '';
    switch (action) {
      case 'CreateCacheParameterGroup': {
        const name = p.get('CacheParameterGroupName')!;
        if (this.paramGroups.has(name)) return this.err(400, 'CacheParameterGroupAlreadyExists', `Parameter group ${name} already exists.`);
        this.paramGroups.set(name, { name, family: p.get('CacheParameterGroupFamily') ?? 'redis7', params: { 'maxmemory-policy': 'volatile-lru' } });
        return this.ok(action, `<CacheParameterGroup><CacheParameterGroupName>${name}</CacheParameterGroupName></CacheParameterGroup>`);
      }
      case 'ModifyCacheParameterGroup': {
        const g = this.paramGroups.get(p.get('CacheParameterGroupName') ?? '');
        if (!g) return this.err(404, 'CacheParameterGroupNotFound', 'No such parameter group.');
        if (g.name.startsWith('default.')) return this.err(400, 'InvalidCacheParameterGroupState', 'Default parameter groups cannot be modified.');
        for (let i = 1; p.has(`ParameterNameValues.ParameterNameValue.${i}.ParameterName`); i++) g.params[p.get(`ParameterNameValues.ParameterNameValue.${i}.ParameterName`)!] = p.get(`ParameterNameValues.ParameterNameValue.${i}.ParameterValue`) ?? '';
        return this.ok(action, `<CacheParameterGroupName>${g.name}</CacheParameterGroupName>`);
      }
      case 'DescribeCacheParameters': {
        const g = this.paramGroups.get(p.get('CacheParameterGroupName') ?? '');
        if (!g) return this.err(404, 'CacheParameterGroupNotFound', 'No such parameter group.');
        const all = { appendonly: 'no', 'maxmemory-samples': '3', ...g.params };
        return this.ok(action, `<Parameters>${Object.entries(all).map(([k, v]) => `<Parameter><ParameterName>${k}</ParameterName><ParameterValue>${xmlEsc(v)}</ParameterValue><Source>user</Source></Parameter>`).join('')}</Parameters>`);
      }
      case 'CreateCacheSubnetGroup':
      case 'ModifyCacheSubnetGroup': {
        const name = p.get('CacheSubnetGroupName')!;
        if (action === 'CreateCacheSubnetGroup' && this.subnetGroups.has(name)) return this.err(400, 'CacheSubnetGroupAlreadyExists', `${name} exists.`);
        this.subnetGroups.set(name, this.list(p, 'SubnetIds.SubnetIdentifier'));
        return this.ok(action, `<CacheSubnetGroup><CacheSubnetGroupName>${name}</CacheSubnetGroupName></CacheSubnetGroup>`);
      }
      case 'CreateReplicationGroup': {
        const id = p.get('ReplicationGroupId')!;
        if (this.groups.has(id)) return this.err(400, 'ReplicationGroupAlreadyExists', `${id} already exists.`);
        if (p.get('AuthToken') && p.get('TransitEncryptionEnabled') !== 'true') return this.err(400, 'InvalidParameterCombination', 'AuthToken requires TransitEncryptionEnabled.');
        const pg = p.get('CacheParameterGroupName') ?? 'default.redis7';
        if (!this.paramGroups.has(pg)) return this.err(404, 'CacheParameterGroupNotFound', `${pg} does not exist.`);
        const n = Number(p.get('NumCacheClusters') ?? '1');
        const tags: Record<string, string> = {};
        for (let i = 1; p.has(`Tags.Tag.${i}.Key`); i++) tags[p.get(`Tags.Tag.${i}.Key`)!] = p.get(`Tags.Tag.${i}.Value`) ?? '';
        const g: FakeReplicationGroup = { id, arn: `arn:aws:elasticache:eu-central-1:${this.account()}:replicationgroup:${id}`, engine: p.get('Engine') ?? 'redis', nodeType: p.get('CacheNodeType') ?? 'cache.t4g.small', members: Array.from({ length: n }, (_, i) => `${id}-00${i + 1}`), clusterEnabled: p.get('ClusterMode') === 'enabled', paramGroup: pg, subnetGroup: p.get('CacheSubnetGroupName'), securityGroups: this.list(p, 'SecurityGroupIds.SecurityGroupId'), tls: p.get('TransitEncryptionEnabled') === 'true', authToken: p.get('AuthToken'), status: 'creating', polls: 0, tags, multiAz: p.get('MultiAZEnabled') === 'true' };
        this.groups.set(id, g);
        return this.ok(action, this.groupXml(g));
      }
      case 'DescribeReplicationGroups': {
        const id = p.get('ReplicationGroupId');
        if (id) {
          const g = this.groups.get(id);
          if (!g) return this.err(404, 'ReplicationGroupNotFoundFault', `ReplicationGroup ${id} not found.`);
          this.settle(g);
          if (!this.groups.has(id)) return this.err(404, 'ReplicationGroupNotFoundFault', `ReplicationGroup ${id} not found.`);
          return this.ok(action, `<ReplicationGroups>${this.groupXml(g)}</ReplicationGroups>`);
        }
        return this.ok(action, `<ReplicationGroups>${[...this.groups.values()].map((g) => this.groupXml(g)).join('')}</ReplicationGroups>`);
      }
      case 'DescribeCacheClusters': {
        const id = p.get('CacheClusterId') ?? '';
        const g = [...this.groups.values()].find((x) => x.members.includes(id));
        if (!g) return this.err(404, 'CacheClusterNotFound', `${id} not found.`);
        return this.ok(action, `<CacheClusters><CacheCluster><CacheClusterId>${id}</CacheClusterId><ReplicationGroupId>${g.id}</ReplicationGroupId><CacheParameterGroup><CacheParameterGroupName>${g.paramGroup}</CacheParameterGroupName><ParameterApplyStatus>in-sync</ParameterApplyStatus></CacheParameterGroup></CacheCluster></CacheClusters>`);
      }
      case 'ListTagsForResource': {
        const g = [...this.groups.values()].find((x) => x.arn === p.get('ResourceName'));
        return this.ok(action, `<TagList>${Object.entries(g?.tags ?? {}).map(([k, v]) => `<Tag><Key>${xmlEsc(k)}</Key><Value>${xmlEsc(v)}</Value></Tag>`).join('')}</TagList>`);
      }
      case 'ModifyReplicationGroup': {
        const g = this.groups.get(p.get('ReplicationGroupId') ?? '');
        if (!g) return this.err(404, 'ReplicationGroupNotFoundFault', 'Not found.');
        if (p.get('CacheParameterGroupName')) g.paramGroup = p.get('CacheParameterGroupName')!;
        if (p.get('CacheNodeType')) g.nodeType = p.get('CacheNodeType')!;
        g.status = 'modifying';
        g.polls = 0;
        return this.ok(action, this.groupXml(g));
      }
      case 'DeleteReplicationGroup': {
        const g = this.groups.get(p.get('ReplicationGroupId') ?? '');
        if (!g) return this.err(404, 'ReplicationGroupNotFoundFault', 'Not found.');
        g.status = 'deleting';
        g.polls = 0;
        return this.ok(action, this.groupXml(g));
      }
    }
    return this.err(400, 'InvalidAction', `${action} is not something this fake answers.`);
  }

  /** MemoryDB's JSON API: `DescribeClusters` only. */
  memorydb(r: RecordedRequest): Reply {
    const target = (r.headers['x-amz-target'] ?? '').split('.').pop();
    if (target !== 'DescribeClusters') return { status: 400, headers: { 'x-amzn-errortype': 'InvalidAction' }, body: { __type: 'InvalidAction', message: `${target} is not answered` } };
    let body: { ClusterName?: string } = {};
    try {
      body = r.body ? (JSON.parse(r.body) as typeof body) : {};
    } catch {
      /* empty */
    }
    if (body.ClusterName) {
      const c = this.memoryClusters.find((x) => x.Name === body.ClusterName);
      if (!c) return { status: 400, headers: { 'x-amzn-errortype': 'ClusterNotFoundFault' }, body: { __type: 'ClusterNotFoundFault', message: `${body.ClusterName} not found` } };
      return { status: 200, body: { Clusters: [c] } };
    }
    return { status: 200, body: { Clusters: this.memoryClusters } };
  }

  addMemoryDb(name: string): void {
    this.memoryClusters.push({ Name: name, Status: 'available', NodeType: 'db.r7g.large', Engine: 'valkey', NumberOfShards: 1, TLSEnabled: true, ClusterEndpoint: { Address: `clustercfg.${name}.memorydb.eu-central-1.amazonaws.com`, Port: 6379 }, ARN: `arn:aws:memorydb:eu-central-1:${this.account()}:cluster/${name}`, Shards: [{ Name: '0001', NumberOfNodes: 2 }] });
  }
}

// ---------- Azure ----------

interface ArmLike { id: string; name: string; type: string; location?: string; tags?: Record<string, string>; body: Record<string, unknown> }

export class FakeAzureCaches {
  /** The keys `listKeys` answers, by cache id (lower case). */
  readonly keys = new Map<string, string>();

  private keyOf(id: string): string {
    let k = this.keys.get(id);
    if (!k) {
      k = randomBytes(24).toString('base64');
      this.keys.set(id, k);
    }
    return k;
  }

  private view(res: ArmLike, extra: Record<string, unknown>): Record<string, unknown> {
    return { ...res.body, id: res.id, name: res.name, type: res.type, ...(res.location ? { location: res.location } : {}), ...(res.tags ? { tags: res.tags } : {}), properties: { ...((res.body.properties as Record<string, unknown>) ?? {}), ...extra } };
  }

  /** What the generic ARM store does not answer for caches; null for everything else. */
  handle(r: RecordedRequest, get: (key: string) => ArmLike | undefined): Reply | null {
    const p = r.path;
    const redis = /^(\/subscriptions\/[^/]+\/resourcegroups\/[^/]+\/providers\/microsoft\.cache\/redis\/[^/]+)(\/listkeys)?$/i.exec(p);
    if (redis) {
      const res = get(redis[1]!.toLowerCase());
      if (!res) return null;
      if (redis[2] && r.method === 'POST') return { status: 200, body: { primaryKey: this.keyOf(redis[1]!.toLowerCase()), secondaryKey: 'secondary-not-used' } };
      if (!redis[2] && r.method === 'GET') return { status: 200, body: this.view(res, { hostName: `${res.name}.redis.cache.windows.net`, sslPort: 6380, port: 6379 }) };
      return null;
    }
    const ent = /^(\/subscriptions\/[^/]+\/resourcegroups\/[^/]+\/providers\/microsoft\.cache\/redisenterprise\/[^/]+)(\/databases\/default\/listkeys)?$/i.exec(p);
    if (ent) {
      const res = get(ent[1]!.toLowerCase());
      if (!res) return null;
      if (ent[2] && r.method === 'POST') return { status: 200, body: { primaryKey: this.keyOf(ent[1]!.toLowerCase()), secondaryKey: 'secondary-not-used' } };
      if (!ent[2] && r.method === 'GET') return { status: 200, body: this.view(res, { hostName: `${res.name}.${res.location ?? 'westeurope'}.redis.azure.net` }) };
    }
    return null;
  }
}

// ---------- DigitalOcean ----------

export interface FakeDoCluster {
  id: string;
  name: string;
  engine: string;
  version: string;
  status: string;
  size: string;
  region: string;
  num_nodes: number;
  tags: string[];
  private_network_uuid?: string;
  connection: Record<string, unknown>;
  private_connection: Record<string, unknown>;
  polls: number;
  eviction_policy: string;
  firewall: { type: string; value: string }[];
}

export class FakeDoCaches {
  readonly clusters = new Map<string, FakeDoCluster>();

  constructor(private readonly settleAfter: () => number) {}

  /** Managed Valkey clusters under `/v2/databases`; null hands the request to the shared databases route. */
  route(r: RecordedRequest, seg: string[], b: Record<string, unknown>, shared: { id: string }[]): Reply | null {
    if (r.method === 'POST' && !seg[1] && (b.engine === 'valkey' || b.engine === 'redis')) {
      if (!b.name || !b.size || !b.region) return { status: 422, body: { id: 'unprocessable_entity', message: 'name, size and region are required' } };
      const id = randomUUID();
      const password = `AVNS_${randomBytes(12).toString('base64url')}`;
      const host = `${String(b.name)}-do-user-1.f.db.ondigitalocean.com`;
      const c: FakeDoCluster = { id, name: String(b.name), engine: String(b.engine), version: String(b.version ?? '8'), status: 'creating', size: String(b.size), region: String(b.region), num_nodes: Number(b.num_nodes ?? 1), tags: (b.tags as string[]) ?? [], ...(b.private_network_uuid ? { private_network_uuid: String(b.private_network_uuid) } : {}), connection: { protocol: 'rediss', host, port: 25061, user: 'default', password, ssl: true }, private_connection: { protocol: 'rediss', host: `private-${host}`, port: 25061, user: 'default', password, ssl: true }, polls: 0, eviction_policy: 'allkeys_lru', firewall: [] };
      this.clusters.set(id, c);
      shared.push(c as unknown as { id: string });
      return { status: 201, body: { database: this.view(c) } };
    }
    const c = seg[1] ? this.clusters.get(seg[1]) : undefined;
    if (!c) return null;
    if (!seg[2]) {
      if (r.method === 'DELETE') {
        this.clusters.delete(c.id);
        const i = shared.findIndex((x) => x.id === c.id);
        if (i >= 0) shared.splice(i, 1);
        return { status: 204 };
      }
      if (r.method === 'GET') {
        c.polls += 1;
        if (c.status === 'creating' && c.polls > this.settleAfter()) c.status = 'online';
        if (c.status === 'resizing' && c.polls > this.settleAfter()) c.status = 'online';
        return { status: 200, body: { database: this.view(c) } };
      }
    }
    if (seg[2] === 'eviction_policy') {
      if (r.method === 'GET') return { status: 200, body: { eviction_policy: c.eviction_policy } };
      if (r.method === 'PUT') {
        c.eviction_policy = String(b.eviction_policy);
        return { status: 204 };
      }
    }
    if (seg[2] === 'firewall' && r.method === 'PUT') {
      c.firewall = (b.rules as { type: string; value: string }[]) ?? [];
      return { status: 204 };
    }
    if (seg[2] === 'resize' && r.method === 'PUT') {
      c.size = String(b.size);
      c.num_nodes = Number(b.num_nodes ?? c.num_nodes);
      c.status = 'resizing';
      c.polls = 0;
      return { status: 202 };
    }
    return null;
  }

  view(c: FakeDoCluster): Record<string, unknown> {
    const { polls: _p, eviction_policy: _e, firewall: _f, ...rest } = c;
    return rest;
  }
}
