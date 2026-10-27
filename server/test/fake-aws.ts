/*
 * 1.9.99-final, Sprint 56 (B-10109): an in-process stand-in for the AWS APIs the cloud adapter calls, on one port
 * for every service (the SigV4 credential scope says which service a call is for; `AssumeRoleWithWebIdentity` is
 * unsigned and found by its action). Working: STS `GetCallerIdentity` and `AssumeRoleWithWebIdentity` (trust checked
 * on `aud` and `sub`, or by a test's own validator), IAM `SimulatePrincipalPolicy`, `CreateAccessKey`,
 * `DeleteAccessKey`, `ListAccessKeys`, `GetAccessKeyLastUsed` and `GetUser`; EC2 VPCs, subnets and security groups
 * (with tag specifications, filters, ingress rules and a `pending` state that settles after `settleAfter` describes);
 * S3 buckets (path style: create, head, delete, list, tagging, location, public access block; objects put and read,
 * an unsigned GET reading them as a public bucket does); Route 53 hosted zones,
 * record sets and changes (PENDING, then INSYNC); EKS clusters and node groups (Sprint 58, `fake-aws-eks.ts`); Bedrock (Sprint 60, `fake-aws-bedrock.ts`). Stubs that answer their basic list or describe: RDS,
 * ElastiCache; Pricing `GetProducts` answers the prices a test sets (`setPrice`, B-10601); Cost Explorer
 * `GetCostAndUsage` answers the daily costs a test adds, grouped by tag and service, paged (`addCost`, B-10603);
 * CloudTrail `LookupEvents` answers the management events a test adds, by resource name and time, paged
 * (`addTrailEvent`, B-10703).
 * KMS keys, aliases, Encrypt/Decrypt, Sign and GetPublicKey are in `fake-aws-kms.ts` (B-10208). Signatures are not verified; the access key id (and the session
 * token of a temporary key) are. It is never the real AWS.
 */
import { randomBytes } from 'node:crypto';
import { FakeCloudBase, jwtClaims, xmlEsc, type RecordedRequest, type Reply } from './fake-cloud-base.js';
import { FakeKms } from './fake-aws-kms.js';
import { FakeAwsCompute } from './fake-aws-compute.js';
import { FakeEks } from './fake-aws-eks.js';
import { FakeElastiCache } from './fake-cloud-caches.js';
import { FakeRds } from './fake-aws-rds.js';
import { FakeAwsData } from './fake-aws-data.js';
import { FakeBedrock } from './fake-aws-bedrock.js';

export interface FakeAwsKey {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** The IAM user or the assumed role session's ARN. */
  arn: string;
  userName?: string;
  expiresAt?: number;
  status: 'Active' | 'Inactive';
  createdAt: number;
  lastUsed?: { at: number; service: string; region: string };
}

export interface FakeAwsRole {
  arn: string;
  /** The trust policy's conditions on the web identity token (undefined: any). */
  aud?: string;
  sub?: string;
}

type Tags = Record<string, string>;
/** B-10603: one day's cost of one service with its cost allocation tags (`addCost`). */
interface FakeCost { day: string; service: string; tags: Record<string, string>; amount: string; unit: string; estimated: boolean; linkedAccount: string }
interface Vpc { VpcId: string; CidrBlock: string; State: string; Tags: Tags; describes: number }
interface Subnet { SubnetId: string; VpcId: string; CidrBlock: string; AvailabilityZone: string; State: string; Tags: Tags; describes: number }
interface Rule { IpProtocol: string; FromPort?: number; ToPort?: number; CidrIp: string[] }
interface SecurityGroup { GroupId: string; GroupName: string; Description: string; VpcId: string; Tags: Tags; Ingress: Rule[] }
interface Bucket { Name: string; Region: string; Tags: Tags | null; CreatedAt: number; PublicAccessBlock: boolean }
interface RRSet { Name: string; Type: string; TTL: number; Values: string[] }
interface Zone { Id: string; Name: string; CallerReference: string; Records: Map<string, RRSet> }

const EC2_NS = 'http://ec2.amazonaws.com/doc/2016-11-15/';
const qNs: Record<string, string> = { sts: 'https://sts.amazonaws.com/doc/2011-06-15/', iam: 'https://iam.amazonaws.com/doc/2010-05-08/', rds: 'http://rds.amazonaws.com/doc/2014-10-31/', elasticache: 'http://elasticache.amazonaws.com/doc/2015-02-02/' };
const R53 = 'https://route53.amazonaws.com/doc/2013-04-01/';
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const fqdn = (n: string) => (n.endsWith('.') ? n : `${n}.`).toLowerCase();

export class FakeAws extends FakeCloudBase {
  account = '123456789012';
  readonly keys = new Map<string, FakeAwsKey>();
  readonly roles = new Map<string, FakeAwsRole>();
  /** IAM actions denied by `SimulatePrincipalPolicy`, per principal ARN ('*' for every principal). */
  readonly denied = new Map<string, Set<string>>();
  /** Every web identity token presented, with its claims (unverified). */
  readonly webIdentityTokens: { token: string; claims: Record<string, unknown> | null; roleArn: string }[] = [];
  /** A test's own check of a web identity token (a JWKS signature check); a string refuses with that message. */
  validateWebIdentity: ((token: string, role: FakeAwsRole) => string | null | Promise<string | null>) | null = null;
  /** Session length for assumed roles, seconds (DurationSeconds wins when given). */
  sessionSeconds = 3600;
  /** Describes a new VPC or subnet answers `pending` before `available`; Route 53 polls before INSYNC. */
  settleAfter = 1;
  readonly vpcs = new Map<string, Vpc>();
  readonly subnets = new Map<string, Subnet>();
  readonly securityGroups = new Map<string, SecurityGroup>();
  readonly buckets = new Map<string, Bucket>();
  readonly zones = new Map<string, Zone>();
  /** S3 objects by `<bucket>/<key>` (B-10005: the issuer's documents); a GET without a signature reads them, as a public bucket does. */
  readonly objects = new Map<string, { body: string; contentType: string }>();
  /** B-10208: KMS keys, aliases, wrap and sign (`fake-aws-kms.ts`). */
  readonly kms = new FakeKms(() => this.account);
  private readonly changes = new Map<string, { polls: number }>();
  /** Sprint 58 (B-10204, B-10205): EC2 instances, ECS, ELBv2 and Secrets Manager (`fake-aws-compute.ts`). */
  /** Sprint 58 (B-10203): EKS (`fake-aws-eks.ts`); `eks.verifyToken` is what a cluster's API asks. */
  readonly eks: FakeEks = new FakeEks(() => this.account);
  /** Sprint 59 (B-10305): ElastiCache and MemoryDB (`fake-cloud-caches.ts`). */
  readonly caches: FakeElastiCache = new FakeElastiCache(() => this.account, () => this.settleAfter);
  /** Sprint 59 (B-10301, B-10303, B-10307): RDS and Aurora instances, clusters, parameter groups and snapshots (`fake-aws-rds.ts`). */
  readonly rds: FakeRds = new FakeRds({ ok: (action, inner) => this.queryOk('rds', action, inner), error: (status, code, message) => ({ status, body: this.queryError(code, message) }), settleAfter: () => this.settleAfter, account: () => this.account });
  /** Sprint 59 (B-10304, B-10306): DynamoDB tables, RDS instances and clusters, DocumentDB clusters (`fake-aws-data.ts`). */
  readonly data: FakeAwsData = new FakeAwsData(() => this.account);
  /** Sprint 60 (B-10501, B-10504): Bedrock's control plane and runtime with signature checks (`fake-aws-bedrock.ts`). */
  readonly bedrock: FakeBedrock = new FakeBedrock((id) => this.keys.get(id)?.secretAccessKey ?? null);
  /**
   * Sprint 60 (B-10405): Service Quotas `GetServiceQuota` (ec2 only): quota code → value. The defaults are the G/VT
   * and P on-demand vCPU quotas of a fresh account that asked for GPUs once.
   */
  readonly serviceQuotas = new Map<string, { name: string; value: number }>([
    ['L-DB2E81BA', { name: 'Running On-Demand G and VT instances', value: 64 }],
    ['L-417A185B', { name: 'Running On-Demand P instances', value: 192 }]
  ]);
  readonly compute: FakeAwsCompute = new FakeAwsCompute({
    nextId: (prefix) => this.nextId(prefix),
    account: () => this.account,
    settleAfter: () => this.settleAfter,
    subnetVpc: (id) => this.subnets.get(id)?.VpcId ?? null,
    ec2Ok: (action, inner) => this.ec2Ok(action, inner),
    ec2Error: (status, code, message) => this.ec2Error(status, code, message)
  });

  /** An IAM user with a long-lived key (the vaulted-credential mode). */
  addUser(o: { userName: string; accessKeyId?: string; secretAccessKey?: string }): FakeAwsKey {
    const key: FakeAwsKey = { accessKeyId: o.accessKeyId ?? `AKIA${randomBytes(8).toString('hex').toUpperCase()}`, secretAccessKey: o.secretAccessKey ?? randomBytes(20).toString('base64'), arn: `arn:aws:iam::${this.account}:user/${o.userName}`, userName: o.userName, status: 'Active', createdAt: Date.now() };
    this.keys.set(key.accessKeyId, key);
    return key;
  }

  addRole(o: { name: string; aud?: string; sub?: string }): FakeAwsRole {
    const role = { arn: `arn:aws:iam::${this.account}:role/${o.name}`, aud: o.aud, sub: o.sub };
    this.roles.set(role.arn, role);
    return role;
  }

  deny(action: string, principalArn = '*'): this {
    const s = this.denied.get(principalArn) ?? new Set<string>();
    s.add(action);
    this.denied.set(principalArn, s);
    return this;
  }

  // ---------- routing ----------

  private service(r: Omit<RecordedRequest, 'op'>): string {
    const scope = /Credential=[^/]+\/\d{8}\/[^/]+\/([^/]+)\/aws4_request/.exec(r.headers.authorization ?? '')?.[1];
    if (scope) return scope;
    return 'sts';
  }

  private params(r: Omit<RecordedRequest, 'op'>): URLSearchParams {
    const p = new URLSearchParams(r.query);
    if (r.method === 'POST' && /x-www-form-urlencoded/.test(r.headers['content-type'] ?? '')) for (const [k, v] of new URLSearchParams(r.body)) p.append(k, v);
    return p;
  }

  protected classify(r: Omit<RecordedRequest, 'op'>): string {
    const svc = this.service(r);
    const action = this.params(r).get('Action');
    if (action) return `${svc}:${action}`;
    const target = r.headers['x-amz-target'];
    if (target) return `${svc}:${target.split('.').pop()}`;
    if (svc === 's3') {
      const sub = [...r.query.keys()].find((k) => ['tagging', 'location', 'publicAccessBlock'].includes(k));
      const bucket = r.path.split('/')[1];
      return `s3:${r.method}${bucket ? 'Bucket' : 'Service'}${sub ? `:${sub}` : ''}`;
    }
    if (svc === 'route53') {
      if (/\/rrset$/.test(r.path)) return r.method === 'POST' ? 'route53:ChangeResourceRecordSets' : 'route53:ListResourceRecordSets';
      if (/\/change\//.test(r.path)) return 'route53:GetChange';
      if (/\/hostedzone\/[^/]+$/.test(r.path)) return r.method === 'DELETE' ? 'route53:DeleteHostedZone' : 'route53:GetHostedZone';
      if (/\/hostedzone$/.test(r.path)) return r.method === 'POST' ? 'route53:CreateHostedZone' : 'route53:ListHostedZones';
    }
    return `${svc}:${r.method} ${r.path}`;
  }

  protected throttleReply(r: RecordedRequest): Reply {
    const svc = r.op.split(':')[0]!;
    if (svc === 'ec2') return { status: 503, body: `<?xml version="1.0" encoding="UTF-8"?><Response><Errors><Error><Code>RequestLimitExceeded</Code><Message>Request limit exceeded.</Message></Error></Errors><RequestID>${this.nextId('req-')}</RequestID></Response>` };
    if (svc === 's3') return { status: 503, body: `<?xml version="1.0" encoding="UTF-8"?><Error><Code>SlowDown</Code><Message>Please reduce your request rate.</Message><RequestId>${this.nextId()}</RequestId></Error>` };
    if (['pricing', 'ce', 'eks', 'bedrock', 'kms', 'cloudtrail'].includes(svc)) return { status: 429, headers: { 'x-amzn-errortype': 'ThrottlingException' }, body: { __type: 'ThrottlingException', message: 'Rate exceeded' } };
    return { status: 400, body: this.queryError('Throttling', 'Rate exceeded', svc === 'route53') };
  }

  private queryError(code: string, message: string, r53 = false): string {
    return `<?xml version="1.0" encoding="UTF-8"?><ErrorResponse${r53 ? ` xmlns="${R53}"` : ''}><Error><Type>Sender</Type><Code>${code}</Code><Message>${xmlEsc(message)}</Message></Error><RequestId>${this.nextId('req-')}</RequestId></ErrorResponse>`;
  }

  private ec2Error(status: number, code: string, message: string): Reply {
    return { status, body: `<?xml version="1.0" encoding="UTF-8"?><Response><Errors><Error><Code>${code}</Code><Message>${xmlEsc(message)}</Message></Error></Errors><RequestID>${this.nextId('req-')}</RequestID></Response>` };
  }

  private s3Error(status: number, code: string, message: string): Reply {
    return { status, headers: { 'content-type': 'application/xml' }, body: `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${xmlEsc(message)}</Message><RequestId>${this.nextId()}</RequestId></Error>` };
  }

  private queryOk(svc: string, action: string, inner: string): Reply {
    return { status: 200, headers: { 'content-type': 'text/xml' }, body: `<?xml version="1.0" encoding="UTF-8"?><${action}Response xmlns="${qNs[svc] ?? ''}"><${action}Result>${inner}</${action}Result><ResponseMetadata><RequestId>${this.nextId('req-')}</RequestId></ResponseMetadata></${action}Response>` };
  }

  private ec2Ok(action: string, inner: string): Reply {
    return { status: 200, headers: { 'content-type': 'text/xml' }, body: `<?xml version="1.0" encoding="UTF-8"?><${action}Response xmlns="${EC2_NS}"><requestId>${this.nextId('req-')}</requestId>${inner}</${action}Response>` };
  }

  /** The key a signed request names, or a refusal. */
  private caller(r: RecordedRequest, svc: string): FakeAwsKey | Reply {
    const keyId = /Credential=([^/]+)\//.exec(r.headers.authorization ?? '')?.[1];
    const key = keyId ? this.keys.get(keyId) : undefined;
    const refuse = (code: string, msg: string): Reply => (svc === 'ec2' ? this.ec2Error(401, 'AuthFailure', msg) : svc === 's3' ? this.s3Error(403, 'InvalidAccessKeyId', msg) : { status: 403, body: this.queryError(code, msg, svc === 'route53') });
    if (!key || key.status !== 'Active') return refuse('InvalidClientTokenId', 'The security token included in the request is invalid.');
    if (key.sessionToken && r.headers['x-amz-security-token'] !== key.sessionToken) return refuse('InvalidClientTokenId', 'The security token included in the request is invalid.');
    if (key.expiresAt && key.expiresAt < Date.now()) return refuse('ExpiredToken', 'The security token included in the request is expired');
    const region = /Credential=[^/]+\/\d{8}\/([^/]+)\//.exec(r.headers.authorization ?? '')?.[1] ?? 'us-east-1';
    key.lastUsed = { at: Date.now(), service: svc, region };
    return key;
  }

  protected async handle(r: RecordedRequest): Promise<Reply> {
    const svc = r.op.split(':')[0]!;
    const p = this.params(r);
    if (r.op === 'sts:AssumeRoleWithWebIdentity') return this.assumeRoleWithWebIdentity(p);
    if (!r.headers.authorization && r.method === 'GET') {
      const o = this.objects.get(decodeURIComponent(r.path.slice(1)));
      if (o) return { status: 200, headers: { 'content-type': o.contentType }, body: o.body };
    }
    const who = this.caller(r, svc);
    if (!('accessKeyId' in who)) return who;
    switch (svc) {
      case 'sts':
        if (r.op === 'sts:GetCallerIdentity') return this.queryOk('sts', 'GetCallerIdentity', `<Arn>${who.arn}</Arn><UserId>${who.accessKeyId}</UserId><Account>${this.account}</Account>`);
        break;
      case 'iam':
        return this.iam(p, who);
      case 'ec2':
        return this.ec2(p);
      case 's3':
        return this.s3(r);
      case 'route53':
        return this.route53(r);
      case 'rds': {
        // Sprint 59 (B-10301, B-10307): the RDS fake; (B-10306) the instances and clusters a test adds for discovery
        // (`data.dbInstances`, `data.dbClusters`) join its plain lists.
        const action = r.op.split(':')[1] ?? '';
        const mine = this.rds.handle(p);
        const listing = (action === 'DescribeDBInstances' && !p.get('DBInstanceIdentifier')) || (action === 'DescribeDBClusters' && !p.get('DBClusterIdentifier'));
        const theirs = listing ? this.data.rds(action, /Credential=[^/]+\/\d{8}\/([^/]+)\//.exec(r.headers.authorization ?? '')?.[1] ?? 'us-east-1') : null;
        if (!theirs || typeof theirs.body !== 'string' || typeof mine.body !== 'string') return mine;
        const tag = action === 'DescribeDBInstances' ? 'DBInstances' : 'DBClusters';
        const extra = new RegExp(`<${tag}>([\\s\\S]*)</${tag}>`).exec(theirs.body)?.[1] ?? '';
        return { ...mine, body: mine.body.replace(`</${tag}>`, `${extra}</${tag}>`) };
      }
      case 'dynamodb':
        // Sprint 59 (B-10304): tables, Query, Scan and ExecuteStatement (`fake-aws-data.ts`).
        return this.data.dynamodb(r);
      case 'elasticache':
        // Sprint 59 (B-10305): replication groups, parameter and subnet groups (`fake-cloud-caches.ts`).
        return this.caches.handle(p);
      case 'memorydb':
        return this.caches.memorydb(r);
      case 'pricing':
        return r.op.endsWith('GetProducts') ? this.getProducts(r) : { status: 200, body: { Services: [{ ServiceCode: 'AmazonEC2', AttributeNames: ['instanceType', 'location'] }], FormatVersion: 'aws_v1' } };
      case 'ce':
        // Sprint 59 (B-10603): `GetCostAndUsage` from the costs a test adds (`addCost`).
        return r.op.endsWith('GetCostAndUsage') ? this.getCostAndUsage(r) : { status: 200, body: { ResultsByTime: [], DimensionValueAttributes: [], GroupDefinitions: [] } };
      case 'ecs':
        return this.compute.ecs(r);
      case 'elasticloadbalancing':
        return this.compute.elb(p);
      case 'secretsmanager':
        return this.compute.secretsManager(r);
      case 'eks':
        // Sprint 58 (B-10203): clusters and node groups (`fake-aws-eks.ts`).
        return this.eks.handle(r);
      case 'kms': {
        let body: Record<string, unknown>;
        try {
          body = r.body ? (JSON.parse(r.body) as Record<string, unknown>) : {};
        } catch {
          return { status: 400, headers: { 'x-amzn-errortype': 'SerializationException' }, body: { __type: 'SerializationException', message: 'Malformed body' } };
        }
        return this.kms.handle(r.op.split(':')[1] ?? '', body, /Credential=[^/]+\/\d{8}\/([^/]+)\//.exec(r.headers.authorization ?? '')?.[1] ?? 'us-east-1');
      }
      case 'servicequotas': {
        // Sprint 60 (B-10405): GetServiceQuota for EC2's GPU quotas.
        let body: { ServiceCode?: string; QuotaCode?: string } = {};
        try {
          body = r.body ? (JSON.parse(r.body) as typeof body) : {};
        } catch {
          /* answered below */
        }
        const q = body.ServiceCode === 'ec2' && body.QuotaCode ? this.serviceQuotas.get(body.QuotaCode) : undefined;
        if (!r.op.endsWith('GetServiceQuota') || !q) return { status: 400, headers: { 'x-amzn-errortype': 'NoSuchResourceException' }, body: { __type: 'NoSuchResourceException', message: `No quota ${String(body.QuotaCode)} for ${String(body.ServiceCode)}.` } };
        return { status: 200, body: { Quota: { ServiceCode: 'ec2', ServiceName: 'Amazon Elastic Compute Cloud (Amazon EC2)', QuotaCode: body.QuotaCode, QuotaName: q.name, Value: q.value, Unit: 'None', Adjustable: true, GlobalQuota: false } } };
      }
      case 'bedrock':
        // Sprint 60 (B-10501, B-10504): Bedrock (`fake-aws-bedrock.ts`), in the region the signature's scope names.
        return this.bedrock.handle(r, /Credential=[^/]+\/\d{8}\/([^/]+)\//.exec(r.headers.authorization ?? '')?.[1] ?? 'us-east-1');
      case 'cloudtrail':
        // Sprint 62 (B-10703): `LookupEvents` over the events a test adds (`addTrailEvent`), in the scope's region.
        return r.op.endsWith('LookupEvents') ? this.lookupEvents(r, /Credential=[^/]+\/\d{8}\/([^/]+)\//.exec(r.headers.authorization ?? '')?.[1] ?? 'us-east-1') : { status: 400, headers: { 'x-amzn-errortype': 'InvalidRequestException' }, body: { __type: 'InvalidRequestException', message: `${r.op} is not something this fake answers` } };
    }
    return { status: 400, body: this.queryError('InvalidAction', `${r.op} is not something this fake answers`) };
  }

  // ---------- CloudTrail (B-10703) ----------

  /** Management events `LookupEvents` answers (`addTrailEvent`), any region unless one is given. */
  readonly trail: { id: string; at: number; name: string; source: string; region: string | null; resources: string[]; arn: string; userName: string; identityType: string; readOnly: boolean; sourceIp: string }[] = [];
  /** Events per page before a `NextToken`. */
  trailPageSize = 50;

  addTrailEvent(o: { resource: string; name: string; at: number; arn?: string; userName?: string; identityType?: string; source?: string; region?: string; readOnly?: boolean; sourceIp?: string }): this {
    this.trail.push({ id: this.nextId('evt-'), at: o.at, name: o.name, source: o.source ?? 'ec2.amazonaws.com', region: o.region ?? null, resources: [o.resource], arn: o.arn ?? `arn:aws:iam::${this.account}:user/${o.userName ?? 'someone'}`, userName: o.userName ?? 'someone', identityType: o.identityType ?? 'IAMUser', readOnly: o.readOnly ?? false, sourceIp: o.sourceIp ?? '198.51.100.7' });
    return this;
  }

  /** CloudTrail `LookupEvents` (JSON 1.1): one LookupAttribute (ResourceName or EventName), StartTime and EndTime in seconds, newest first, paged. */
  private lookupEvents(r: RecordedRequest, region: string): Reply {
    let q: { LookupAttributes?: { AttributeKey: string; AttributeValue: string }[]; StartTime?: number; EndTime?: number; MaxResults?: number; NextToken?: string } = {};
    try {
      q = JSON.parse(r.body) as typeof q;
    } catch {
      return { status: 400, headers: { 'x-amzn-errortype': 'InvalidLookupAttributesException' }, body: { __type: 'InvalidLookupAttributesException', message: 'Malformed body' } };
    }
    const attrs = q.LookupAttributes ?? [];
    if (attrs.length > 1) return { status: 400, headers: { 'x-amzn-errortype': 'InvalidLookupAttributesException' }, body: { __type: 'InvalidLookupAttributesException', message: 'You cannot specify more than one lookup attribute.' } };
    const start = q.StartTime != null ? q.StartTime * 1000 : 0;
    const end = q.EndTime != null ? q.EndTime * 1000 : Date.now();
    if (start > end) return { status: 400, headers: { 'x-amzn-errortype': 'InvalidTimeRangeException' }, body: { __type: 'InvalidTimeRangeException', message: 'Start time is after end time.' } };
    const a = attrs[0];
    const all = this.trail
      .filter((e) => (!e.region || e.region === region) && e.at >= start && e.at <= end)
      .filter((e) => !a || (a.AttributeKey === 'ResourceName' ? e.resources.includes(a.AttributeValue) : a.AttributeKey === 'EventName' ? e.name === a.AttributeValue : true))
      .sort((x, y) => y.at - x.at);
    const per = Math.min(50, q.MaxResults ?? 50, this.trailPageSize);
    const offset = Number(q.NextToken ?? 0) || 0;
    const page = all.slice(offset, offset + per);
    const Events = page.map((e) => ({
      EventId: e.id,
      EventName: e.name,
      ReadOnly: String(e.readOnly),
      AccessKeyId: 'AKIAEXAMPLE',
      EventTime: e.at / 1000,
      EventSource: e.source,
      Username: e.userName,
      Resources: e.resources.map((x) => ({ ResourceType: 'AWS::EC2::SecurityGroup', ResourceName: x })),
      CloudTrailEvent: JSON.stringify({ eventVersion: '1.09', userIdentity: { type: e.identityType, arn: e.arn, accountId: this.account, userName: e.userName }, eventTime: new Date(e.at).toISOString(), eventSource: e.source, eventName: e.name, awsRegion: region, sourceIPAddress: e.sourceIp, readOnly: e.readOnly, eventID: e.id, managementEvent: true, eventCategory: 'Management' })
    }));
    return { status: 200, body: { Events, ...(offset + per < all.length ? { NextToken: String(offset + per) } : {}) } };
  }

  // ---------- Cost Explorer (B-10603) ----------

  /** Daily costs `GetCostAndUsage` answers (`addCost`); a later `addCost` for the same day, tags and service revises it. */
  readonly costs: FakeCost[] = [];
  /** Groups per page before a `NextPageToken` (Cost Explorer pages long answers). */
  costPageSize = 500;

  addCost(o: { day: string; service: string; amount: string; tags?: Record<string, string>; unit?: string; estimated?: boolean; linkedAccount?: string }): this {
    const tags = o.tags ?? {};
    const same = (c: FakeCost) => c.day === o.day && c.service === o.service && JSON.stringify(c.tags) === JSON.stringify(tags) && c.linkedAccount === (o.linkedAccount ?? this.account);
    const had = this.costs.find(same);
    const row = { day: o.day, service: o.service, tags, amount: o.amount, unit: o.unit ?? 'USD', estimated: o.estimated ?? false, linkedAccount: o.linkedAccount ?? this.account };
    if (had) Object.assign(had, row);
    else this.costs.push(row);
    return this;
  }

  /** `GetCostAndUsage` (JSON 1.1): DAILY, one metric, GroupBy TAG and/or DIMENSION SERVICE, a LINKED_ACCOUNT filter, paged. */
  private getCostAndUsage(r: RecordedRequest): Reply {
    let q: { TimePeriod?: { Start?: string; End?: string }; Granularity?: string; Metrics?: string[]; GroupBy?: { Type: string; Key: string }[]; Filter?: { Dimensions?: { Key: string; Values: string[] } }; NextPageToken?: string } = {};
    try {
      q = JSON.parse(r.body) as typeof q;
    } catch {
      return { status: 400, headers: { 'x-amzn-errortype': 'ValidationException' }, body: { __type: 'ValidationException', message: 'Malformed body' } };
    }
    const start = q.TimePeriod?.Start ?? '';
    const end = q.TimePeriod?.End ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start >= end) return { status: 400, headers: { 'x-amzn-errortype': 'ValidationException' }, body: { __type: 'ValidationException', message: 'Start date must be before end date' } };
    if (q.Granularity !== 'DAILY' && q.Granularity !== 'MONTHLY') return { status: 400, headers: { 'x-amzn-errortype': 'ValidationException' }, body: { __type: 'ValidationException', message: 'Granularity is required' } };
    const metric = q.Metrics?.[0] ?? 'UnblendedCost';
    const linked = q.Filter?.Dimensions?.Key === 'LINKED_ACCOUNT' ? q.Filter.Dimensions.Values : null;
    const keyOf = (c: FakeCost) => (q.GroupBy ?? []).map((g) => (g.Type === 'TAG' ? `${g.Key}$${c.tags[g.Key] ?? ''}` : g.Key === 'SERVICE' ? c.service : g.Key === 'LINKED_ACCOUNT' ? c.linkedAccount : ''));
    const days: string[] = [];
    for (let t = Date.parse(`${start}T00:00:00Z`); t < Date.parse(`${end}T00:00:00Z`); t += 86_400_000) days.push(new Date(t).toISOString().slice(0, 10));
    const all: { day: string; keys: string[]; amount: number; unit: string; estimated: boolean }[] = [];
    for (const d of days) {
      const m = new Map<string, { day: string; keys: string[]; amount: number; unit: string; estimated: boolean }>();
      for (const c of this.costs.filter((x) => x.day === d && (!linked || linked.includes(x.linkedAccount)))) {
        const keys = keyOf(c);
        const k = keys.join('|');
        const g = m.get(k) ?? { day: d, keys, amount: 0, unit: c.unit, estimated: false };
        g.amount += Number(c.amount);
        g.estimated ||= c.estimated;
        m.set(k, g);
      }
      all.push(...m.values());
    }
    const offset = Number(q.NextPageToken ?? 0) || 0;
    const page = all.slice(offset, offset + this.costPageSize);
    const next = offset + this.costPageSize < all.length ? String(offset + this.costPageSize) : undefined;
    const ResultsByTime = days.map((d) => {
      const groups = page.filter((g) => g.day === d);
      const e = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      return { TimePeriod: { Start: d, End: e }, Total: {}, Groups: groups.map((g) => ({ Keys: g.keys, Metrics: { [metric]: { Amount: g.amount.toFixed(10), Unit: g.unit } } })), Estimated: groups.some((g) => g.estimated) };
    });
    return { status: 200, body: { GroupDefinitions: (q.GroupBy ?? []).map((g) => ({ Type: g.Type, Key: g.Key })), ResultsByTime, DimensionValueAttributes: [], ...(next ? { NextPageToken: next } : {}) } };
  }

  // ---------- Pricing (B-10601) ----------

  /** On-demand prices `GetProducts` answers, by `<ServiceCode>|<instanceType>|<regionCode>` (`setPrice`). */
  readonly prices = new Map<string, { usd: string; effectiveDate: string }>();

  setPrice(serviceCode: string, instanceType: string, regionCode: string, usd: string, effectiveDate = '2026-10-01'): this {
    this.prices.set(`${serviceCode}|${instanceType}|${regionCode}`, { usd, effectiveDate });
    return this;
  }

  /**
   * Sprint 61 (B-10505): Bedrock token prices `GetProducts` answers, by `<model>|<regionCode>` (the price list's model
   * name): USD per unit (`unit`, default `1K tokens`), one product per token kind, shaped as the offer files of
   * 2026-10-21 shape them. Amazon's, Meta's and Mistral's models are under service code `AmazonBedrock` (usage type
   * `EUC1-NovaPro-input-tokens`, with flex and priority tier products beside the standard ones; Titan embeddings named
   * by `titanModel`, not `model`); third-party sellers' (Anthropic, Cohere, AI21: `serviceCode` default by the name)
   * under `AmazonBedrockFoundationModels` (usage type `EUC1-MP:EUC1_InputTokenCount-Units`, with latency-optimized
   * products, and an embedding model's per-image product).
   */
  readonly bedrockPrices = new Map<string, { input: string; output?: string; cached?: string; unit: string; effectiveDate: string; serviceCode: string }[]>();

  setBedrockPrice(model: string, regionCode: string, p: { input: string; output?: string; cached?: string; unit?: string; effectiveDate?: string; serviceCode?: 'AmazonBedrock' | 'AmazonBedrockFoundationModels' }): this {
    const key = `${model}|${regionCode}`;
    const serviceCode = p.serviceCode ?? (/^(Claude|Embed|Command|Jamba|Rerank|Palmyra)\b/.test(model) ? 'AmazonBedrockFoundationModels' : 'AmazonBedrock');
    this.bedrockPrices.set(key, [...(this.bedrockPrices.get(key) ?? []), { input: p.input, ...(p.output ? { output: p.output } : {}), ...(p.cached ? { cached: p.cached } : {}), unit: p.unit ?? '1K tokens', effectiveDate: p.effectiveDate ?? '2026-10-01', serviceCode }]);
    return this;
  }

  /** Bedrock products of a model in a region under one service code: the latest price set, one product per token kind. */
  private bedrockProducts(serviceCode: string, filters: { Field: string; Value: string }[]): Reply {
    const f = (name: string) => filters.find((x) => x.Field === name)?.Value;
    const region = f('regionCode') ?? '';
    const titan = f('titanModel');
    const model = titan === 'TitanEmbeddingsV2-Text-input' ? 'Titan Text Embeddings V2' : (f('model') ?? '');
    const hit = (this.bedrockPrices.get(`${model}|${region}`) ?? []).at(-1);
    // Titan embeddings are listed by `titanModel` only: a `model` filter finds nothing.
    if (!hit || hit.serviceCode !== serviceCode || (model.startsWith('Titan') && !titan)) return { status: 200, body: { PriceList: [], FormatVersion: 'aws_v1' } };
    const reg = ({ 'us-east-1': 'USE1', 'us-west-2': 'USW2', 'eu-central-1': 'EUC1', 'eu-west-1': 'EU', 'ap-northeast-1': 'APN1' } as Record<string, string>)[region] ?? region.toUpperCase().replace(/-/g, '');
    const mp = serviceCode === 'AmazonBedrockFoundationModels';
    const short = model.replace(/\s+/g, '');
    const products: { kind: string; usd: string; usagetype: string; feature?: string; tier?: string }[] = [];
    const add = (kind: string, usd: string | undefined, mpName: string, ownName: string) => {
      if (usd == null) return;
      products.push({ kind, usd, usagetype: mp ? `${reg}-MP:${reg}_${mpName}-Units` : `${reg}-${short}-${ownName}` });
      // What the real lists carry beside the standard price, at other prices: never the one to read.
      const dearer = String(Number(usd) * 1.25);
      if (mp) products.push({ kind, usd: dearer, usagetype: `${reg}-MP:${reg}_${mpName}_LatencyOptimized-Units` });
      else products.push({ kind: `${kind} priority`, usd: dearer, usagetype: `${reg}-${short}-${ownName}-priority`, tier: 'priority' }, { kind: `${kind} flex`, usd: String(Number(usd) / 2), usagetype: `${reg}-${short}-${ownName}-flex`, tier: 'flex' });
    };
    add('Input tokens', hit.input, 'InputTokenCount', 'input-tokens');
    add('Output tokens', hit.output, 'OutputTokenCount', 'output-tokens');
    add('Prompt cache read input tokens', hit.cached, 'CacheReadInputTokenCount', 'cache-read-input-token-count');
    if (mp && model.startsWith('Embed')) products.push({ kind: 'Input image', usd: '0.0001', usagetype: `${reg}-MP:${reg}_InputImageCount-Units` });
    const list = products.map((x) => {
      const sku = this.nextId('SKU');
      const unit = x.kind === 'Input image' ? 'Input Images' : hit.unit;
      const attributes: Record<string, string> = { servicecode: serviceCode, regionCode: region, ...(titan ? { titanModel: titan } : { model }), inferenceType: x.kind, usagetype: x.usagetype, feature: 'On-demand Inference', ...(mp ? { provider: model.startsWith('Claude') ? 'Anthropic' : 'Cohere' } : {}), ...(x.tier ? { service_tier: x.tier } : {}) };
      return JSON.stringify({ product: { productFamily: mp ? undefined : 'Amazon Bedrock', sku, attributes }, serviceCode, terms: { OnDemand: { [`${sku}.JRTCKXETXF`]: { offerTermCode: 'JRTCKXETXF', sku, effectiveDate: `${hit.effectiveDate}T00:00:00Z`, priceDimensions: { [`${sku}.JRTCKXETXF.6YS6EN2CT7`]: { unit, endRange: 'Inf', beginRange: '0', description: `$${x.usd} per ${unit}`, pricePerUnit: { USD: x.usd } } }, termAttributes: {} } } }, version: '20261001000000', publicationDate: `${hit.effectiveDate}T00:00:00Z` });
    });
    return { status: 200, body: { PriceList: list, FormatVersion: 'aws_v1' } };
  }

  /** The Price List Query API's `GetProducts` (JSON 1.1): one product per matching price, its terms as the real API shapes them. */
  private getProducts(r: RecordedRequest): Reply {
    let q: { ServiceCode?: string; Filters?: { Field: string; Value: string }[] } = {};
    try {
      q = JSON.parse(r.body) as typeof q;
    } catch {
      return { status: 400, headers: { 'x-amzn-errortype': 'InvalidParameterException' }, body: { __type: 'InvalidParameterException', message: 'Malformed body' } };
    }
    const f = (name: string) => q.Filters?.find((x) => x.Field === name)?.Value ?? '';
    if (q.ServiceCode === 'AmazonBedrock' || q.ServiceCode === 'AmazonBedrockFoundationModels') return this.bedrockProducts(q.ServiceCode, q.Filters ?? []);
    const hit = this.prices.get(`${q.ServiceCode}|${f('instanceType')}|${f('regionCode')}`);
    if (!hit) return { status: 200, body: { PriceList: [], FormatVersion: 'aws_v1' } };
    const sku = this.nextId('SKU');
    const product = {
      product: { productFamily: q.ServiceCode === 'AmazonEC2' ? 'Compute Instance' : 'Database Instance', sku, attributes: Object.fromEntries((q.Filters ?? []).map((x) => [x.Field, x.Value])) },
      serviceCode: q.ServiceCode,
      terms: { OnDemand: { [`${sku}.JRTCKXETXF`]: { offerTermCode: 'JRTCKXETXF', sku, effectiveDate: `${hit.effectiveDate}T00:00:00Z`, priceDimensions: { [`${sku}.JRTCKXETXF.6YS6EN2CT7`]: { unit: 'Hrs', endRange: 'Inf', beginRange: '0', description: `$${hit.usd} per On Demand hour`, pricePerUnit: { USD: hit.usd } } }, termAttributes: {} } } },
      version: '20261001000000',
      publicationDate: `${hit.effectiveDate}T00:00:00Z`
    };
    return { status: 200, body: { PriceList: [JSON.stringify(product)], FormatVersion: 'aws_v1' } };
  }

  // ---------- STS ----------

  private async assumeRoleWithWebIdentity(p: URLSearchParams): Promise<Reply> {
    const roleArn = p.get('RoleArn') ?? '';
    const token = p.get('WebIdentityToken') ?? '';
    const claims = jwtClaims(token);
    this.webIdentityTokens.push({ token, claims, roleArn });
    const role = this.roles.get(roleArn);
    const denied = (msg: string): Reply => ({ status: 403, body: this.queryError('AccessDenied', msg) });
    if (!role) return denied('Not authorized to perform sts:AssumeRoleWithWebIdentity');
    if (!claims) return { status: 400, body: this.queryError('InvalidIdentityToken', "Couldn't parse the web identity token") };
    if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) return { status: 400, body: this.queryError('ExpiredTokenException', 'Token is expired') };
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (role.aud && !aud.includes(role.aud)) return denied('Not authorized to perform sts:AssumeRoleWithWebIdentity');
    if (role.sub && claims.sub !== role.sub) return denied('Not authorized to perform sts:AssumeRoleWithWebIdentity');
    if (this.validateWebIdentity) {
      const problem = await this.validateWebIdentity(token, role);
      if (problem) return { status: 400, body: this.queryError('InvalidIdentityToken', problem) };
    }
    const seconds = Number(p.get('DurationSeconds')) || this.sessionSeconds;
    const session = p.get('RoleSessionName') ?? 'session';
    const roleName = roleArn.split('/').pop()!;
    const key: FakeAwsKey = { accessKeyId: `ASIA${randomBytes(8).toString('hex').toUpperCase()}`, secretAccessKey: randomBytes(20).toString('base64'), sessionToken: randomBytes(32).toString('base64'), arn: `arn:aws:sts::${this.account}:assumed-role/${roleName}/${session}`, expiresAt: Date.now() + seconds * 1000, status: 'Active', createdAt: Date.now() };
    this.keys.set(key.accessKeyId, key);
    return this.queryOk('sts', 'AssumeRoleWithWebIdentity', `<Credentials><AccessKeyId>${key.accessKeyId}</AccessKeyId><SecretAccessKey>${xmlEsc(key.secretAccessKey)}</SecretAccessKey><SessionToken>${xmlEsc(key.sessionToken!)}</SessionToken><Expiration>${iso(key.expiresAt!)}</Expiration></Credentials><SubjectFromWebIdentityToken>${xmlEsc(String(claims.sub ?? ''))}</SubjectFromWebIdentityToken><AssumedRoleUser><Arn>${key.arn}</Arn><AssumedRoleId>AROA${randomBytes(6).toString('hex').toUpperCase()}:${xmlEsc(session)}</AssumedRoleId></AssumedRoleUser><Provider>${xmlEsc(String(claims.iss ?? ''))}</Provider><Audience>${xmlEsc(String(aud[0] ?? ''))}</Audience>`);
  }

  // ---------- IAM ----------

  private iam(p: URLSearchParams, who: FakeAwsKey): Reply {
    const action = p.get('Action');
    const userOf = (name: string | null) => name ?? who.userName ?? '';
    const meta = (k: FakeAwsKey) => `<member><UserName>${xmlEsc(k.userName ?? '')}</UserName><AccessKeyId>${k.accessKeyId}</AccessKeyId><Status>${k.status}</Status><CreateDate>${iso(k.createdAt)}</CreateDate></member>`;
    switch (action) {
      case 'GetUser': {
        const name = userOf(p.get('UserName'));
        return this.queryOk('iam', 'GetUser', `<User><UserName>${xmlEsc(name)}</UserName><UserId>AIDA${name.length}</UserId><Arn>arn:aws:iam::${this.account}:user/${xmlEsc(name)}</Arn><Path>/</Path><CreateDate>${iso(Date.now())}</CreateDate></User>`);
      }
      case 'SimulatePrincipalPolicy': {
        const source = p.get('PolicySourceArn') ?? '';
        const actions = [...p.entries()].filter(([k]) => /^ActionNames\.member\.\d+$/.test(k)).map(([, v]) => v);
        const resources = [...p.entries()].filter(([k]) => /^ResourceArns\.member\.\d+$/.test(k)).map(([, v]) => v);
        const deny = new Set([...(this.denied.get('*') ?? []), ...(this.denied.get(source) ?? [])]);
        const rows = actions.map((a) => `<member><EvalActionName>${xmlEsc(a)}</EvalActionName><EvalResourceName>${xmlEsc(resources[0] ?? '*')}</EvalResourceName><EvalDecision>${deny.has(a) ? 'implicitDeny' : 'allowed'}</EvalDecision><MatchedStatements></MatchedStatements><MissingContextValues></MissingContextValues></member>`);
        return this.queryOk('iam', 'SimulatePrincipalPolicy', `<IsTruncated>false</IsTruncated><EvaluationResults>${rows.join('')}</EvaluationResults>`);
      }
      case 'CreateAccessKey': {
        const user = userOf(p.get('UserName'));
        const owned = [...this.keys.values()].filter((k) => k.userName === user && !k.sessionToken);
        if (owned.length >= 2) return { status: 409, body: this.queryError('LimitExceeded', 'Cannot exceed quota for AccessKeysPerUser: 2') };
        const k = this.addUser({ userName: user });
        return this.queryOk('iam', 'CreateAccessKey', `<AccessKey><UserName>${xmlEsc(user)}</UserName><AccessKeyId>${k.accessKeyId}</AccessKeyId><Status>Active</Status><SecretAccessKey>${xmlEsc(k.secretAccessKey)}</SecretAccessKey><CreateDate>${iso(k.createdAt)}</CreateDate></AccessKey>`);
      }
      case 'DeleteAccessKey': {
        const id = p.get('AccessKeyId') ?? '';
        const k = this.keys.get(id);
        if (!k || k.userName !== userOf(p.get('UserName'))) return { status: 404, body: this.queryError('NoSuchEntity', `The Access Key with id ${id} cannot be found.`) };
        this.keys.delete(id);
        return this.queryOk('iam', 'DeleteAccessKey', '');
      }
      case 'UpdateAccessKey': {
        const k = this.keys.get(p.get('AccessKeyId') ?? '');
        if (!k) return { status: 404, body: this.queryError('NoSuchEntity', 'The Access Key cannot be found.') };
        k.status = p.get('Status') === 'Inactive' ? 'Inactive' : 'Active';
        return this.queryOk('iam', 'UpdateAccessKey', '');
      }
      case 'ListAccessKeys': {
        const user = userOf(p.get('UserName'));
        const owned = [...this.keys.values()].filter((k) => k.userName === user && !k.sessionToken);
        return this.queryOk('iam', 'ListAccessKeys', `<UserName>${xmlEsc(user)}</UserName><AccessKeyMetadata>${owned.map(meta).join('')}</AccessKeyMetadata><IsTruncated>false</IsTruncated>`);
      }
      case 'GetAccessKeyLastUsed': {
        const k = this.keys.get(p.get('AccessKeyId') ?? '');
        if (!k) return { status: 404, body: this.queryError('NoSuchEntity', 'The Access Key cannot be found.') };
        const lu = k.lastUsed;
        return this.queryOk('iam', 'GetAccessKeyLastUsed', `<UserName>${xmlEsc(k.userName ?? '')}</UserName><AccessKeyLastUsed>${lu ? `<LastUsedDate>${iso(lu.at)}</LastUsedDate><ServiceName>${lu.service}</ServiceName><Region>${lu.region}</Region>` : '<ServiceName>N/A</ServiceName><Region>N/A</Region>'}</AccessKeyLastUsed>`);
      }
    }
    return { status: 400, body: this.queryError('InvalidAction', `${action} is not something this fake answers`) };
  }

  // ---------- EC2 ----------

  private ec2(p: URLSearchParams): Reply {
    const action = p.get('Action') ?? '';
    const indexed = (prefix: string) => [...p.entries()].filter(([k]) => new RegExp(`^${prefix.replace(/\./g, '\\.')}\\.\\d+$`).test(k)).map(([, v]) => v);
    const filters = () => {
      const out: { name: string; values: string[] }[] = [];
      for (let i = 1; p.has(`Filter.${i}.Name`); i++) out.push({ name: p.get(`Filter.${i}.Name`)!, values: indexed(`Filter.${i}.Value`) });
      return out;
    };
    const tagSpecs = (type: string): Tags => {
      const tags: Tags = {};
      for (let i = 1; p.has(`TagSpecification.${i}.ResourceType`); i++) {
        if (p.get(`TagSpecification.${i}.ResourceType`) !== type) continue;
        for (let j = 1; p.has(`TagSpecification.${i}.Tag.${j}.Key`); j++) tags[p.get(`TagSpecification.${i}.Tag.${j}.Key`)!] = p.get(`TagSpecification.${i}.Tag.${j}.Value`) ?? '';
      }
      return tags;
    };
    const tagSet = (t: Tags) => `<tagSet>${Object.entries(t).map(([k, v]) => `<item><key>${xmlEsc(k)}</key><value>${xmlEsc(v)}</value></item>`).join('')}</tagSet>`;
    const match = (tags: Tags, fields: Record<string, string>) =>
      filters().every((f) => {
        if (f.name.startsWith('tag:')) return f.values.includes(tags[f.name.slice(4)] ?? '\u0000');
        if (f.name === 'tag-key') return f.values.some((v) => v in tags);
        return f.name in fields ? f.values.includes(fields[f.name]!) : true;
      });
    const settle = (o: { State: string; describes: number }) => {
      o.describes += 1;
      if (o.State === 'pending' && o.describes > this.settleAfter) o.State = 'available';
    };
    const vpcXml = (v: Vpc) => `<item><vpcId>${v.VpcId}</vpcId><ownerId>${this.account}</ownerId><state>${v.State}</state><cidrBlock>${v.CidrBlock}</cidrBlock><isDefault>false</isDefault>${tagSet(v.Tags)}</item>`;
    const subnetXml = (s: Subnet) => `<item><subnetId>${s.SubnetId}</subnetId><vpcId>${s.VpcId}</vpcId><state>${s.State}</state><cidrBlock>${s.CidrBlock}</cidrBlock><availabilityZone>${s.AvailabilityZone}</availabilityZone>${tagSet(s.Tags)}</item>`;
    const ruleXml = (r: Rule) => `<item><ipProtocol>${r.IpProtocol}</ipProtocol>${r.FromPort != null ? `<fromPort>${r.FromPort}</fromPort><toPort>${r.ToPort}</toPort>` : ''}<ipRanges>${r.CidrIp.map((c) => `<item><cidrIp>${c}</cidrIp></item>`).join('')}</ipRanges></item>`;
    const sgXml = (g: SecurityGroup) => `<item><ownerId>${this.account}</ownerId><groupId>${g.GroupId}</groupId><groupName>${xmlEsc(g.GroupName)}</groupName><groupDescription>${xmlEsc(g.Description)}</groupDescription><vpcId>${g.VpcId}</vpcId><ipPermissions>${g.Ingress.map(ruleXml).join('')}</ipPermissions><ipPermissionsEgress></ipPermissionsEgress>${tagSet(g.Tags)}</item>`;
    const rules = (): Rule[] => {
      const out: Rule[] = [];
      for (let i = 1; p.has(`IpPermissions.${i}.IpProtocol`); i++) {
        const from = p.get(`IpPermissions.${i}.FromPort`);
        const to = p.get(`IpPermissions.${i}.ToPort`);
        out.push({ IpProtocol: p.get(`IpPermissions.${i}.IpProtocol`)!, ...(from != null ? { FromPort: Number(from), ToPort: Number(to ?? from) } : {}), CidrIp: [...p.entries()].filter(([k]) => new RegExp(`^IpPermissions\\.${i}\\.IpRanges\\.\\d+\\.CidrIp$`).test(k)).map(([, v]) => v) });
      }
      return out;
    };
    const same = (a: Rule, b: Rule) => a.IpProtocol === b.IpProtocol && a.FromPort === b.FromPort && a.ToPort === b.ToPort && a.CidrIp.join() === b.CidrIp.join();
    switch (action) {
      case 'CreateVpc': {
        const v: Vpc = { VpcId: this.nextId('vpc-'), CidrBlock: p.get('CidrBlock') ?? '10.0.0.0/16', State: 'pending', Tags: tagSpecs('vpc'), describes: 0 };
        this.vpcs.set(v.VpcId, v);
        return this.ec2Ok('CreateVpc', `<vpc>${vpcXml(v).replace(/^<item>|<\/item>$/g, '')}</vpc>`);
      }
      case 'DescribeVpcs': {
        const ids = indexed('VpcId');
        for (const id of ids) if (!this.vpcs.has(id)) return this.ec2Error(400, 'InvalidVpcID.NotFound', `The vpc ID '${id}' does not exist`);
        const list = [...this.vpcs.values()].filter((v) => (!ids.length || ids.includes(v.VpcId)) && match(v.Tags, { 'vpc-id': v.VpcId, 'cidr-block': v.CidrBlock, state: v.State }));
        list.forEach(settle);
        return this.ec2Ok('DescribeVpcs', `<vpcSet>${list.map(vpcXml).join('')}</vpcSet>`);
      }
      case 'DeleteVpc': {
        const id = p.get('VpcId') ?? '';
        if (!this.vpcs.has(id)) return this.ec2Error(400, 'InvalidVpcID.NotFound', `The vpc ID '${id}' does not exist`);
        if ([...this.subnets.values()].some((s) => s.VpcId === id) || [...this.securityGroups.values()].some((g) => g.VpcId === id)) return this.ec2Error(400, 'DependencyViolation', `The vpc '${id}' has dependencies and cannot be deleted.`);
        this.vpcs.delete(id);
        return this.ec2Ok('DeleteVpc', '<return>true</return>');
      }
      case 'CreateSubnet': {
        const vpc = p.get('VpcId') ?? '';
        if (!this.vpcs.has(vpc)) return this.ec2Error(400, 'InvalidVpcID.NotFound', `The vpc ID '${vpc}' does not exist`);
        const s: Subnet = { SubnetId: this.nextId('subnet-'), VpcId: vpc, CidrBlock: p.get('CidrBlock') ?? '', AvailabilityZone: p.get('AvailabilityZone') ?? 'us-east-1a', State: 'pending', Tags: tagSpecs('subnet'), describes: 0 };
        this.subnets.set(s.SubnetId, s);
        return this.ec2Ok('CreateSubnet', `<subnet>${subnetXml(s).replace(/^<item>|<\/item>$/g, '')}</subnet>`);
      }
      case 'DescribeSubnets': {
        const ids = indexed('SubnetId');
        for (const id of ids) if (!this.subnets.has(id)) return this.ec2Error(400, 'InvalidSubnetID.NotFound', `The subnet ID '${id}' does not exist`);
        const list = [...this.subnets.values()].filter((s) => (!ids.length || ids.includes(s.SubnetId)) && match(s.Tags, { 'vpc-id': s.VpcId, 'subnet-id': s.SubnetId }));
        list.forEach(settle);
        return this.ec2Ok('DescribeSubnets', `<subnetSet>${list.map(subnetXml).join('')}</subnetSet>`);
      }
      case 'DeleteSubnet': {
        const id = p.get('SubnetId') ?? '';
        if (!this.subnets.delete(id)) return this.ec2Error(400, 'InvalidSubnetID.NotFound', `The subnet ID '${id}' does not exist`);
        return this.ec2Ok('DeleteSubnet', '<return>true</return>');
      }
      case 'CreateSecurityGroup': {
        const vpc = p.get('VpcId') ?? '';
        const name = p.get('GroupName') ?? '';
        if (!this.vpcs.has(vpc)) return this.ec2Error(400, 'InvalidVpcID.NotFound', `The vpc ID '${vpc}' does not exist`);
        if ([...this.securityGroups.values()].some((g) => g.VpcId === vpc && g.GroupName === name)) return this.ec2Error(400, 'InvalidGroup.Duplicate', `The security group '${name}' already exists for VPC '${vpc}'`);
        const g: SecurityGroup = { GroupId: this.nextId('sg-'), GroupName: name, Description: p.get('GroupDescription') ?? '', VpcId: vpc, Tags: tagSpecs('security-group'), Ingress: [] };
        this.securityGroups.set(g.GroupId, g);
        return this.ec2Ok('CreateSecurityGroup', `<return>true</return><groupId>${g.GroupId}</groupId>${tagSet(g.Tags)}`);
      }
      case 'DescribeSecurityGroups': {
        const ids = indexed('GroupId');
        for (const id of ids) if (!this.securityGroups.has(id)) return this.ec2Error(400, 'InvalidGroup.NotFound', `The security group '${id}' does not exist`);
        const list = [...this.securityGroups.values()].filter((g) => (!ids.length || ids.includes(g.GroupId)) && match(g.Tags, { 'vpc-id': g.VpcId, 'group-name': g.GroupName, 'group-id': g.GroupId }));
        return this.ec2Ok('DescribeSecurityGroups', `<securityGroupInfo>${list.map(sgXml).join('')}</securityGroupInfo>`);
      }
      case 'DeleteSecurityGroup': {
        const id = p.get('GroupId') ?? '';
        if (!this.securityGroups.delete(id)) return this.ec2Error(400, 'InvalidGroup.NotFound', `The security group '${id}' does not exist`);
        return this.ec2Ok('DeleteSecurityGroup', '<return>true</return>');
      }
      case 'AuthorizeSecurityGroupIngress':
      case 'RevokeSecurityGroupIngress': {
        const g = this.securityGroups.get(p.get('GroupId') ?? '');
        if (!g) return this.ec2Error(400, 'InvalidGroup.NotFound', 'The security group does not exist');
        for (const r of rules()) {
          const i = g.Ingress.findIndex((x) => same(x, r));
          if (action === 'AuthorizeSecurityGroupIngress') {
            if (i >= 0) return this.ec2Error(400, 'InvalidPermission.Duplicate', 'the specified rule already exists');
            g.Ingress.push(r);
          } else if (i >= 0) g.Ingress.splice(i, 1);
        }
        return this.ec2Ok(action, '<return>true</return>');
      }
      case 'CreateTags': {
        const ids = indexed('ResourceId');
        for (const id of ids) {
          const o = this.vpcs.get(id) ?? this.subnets.get(id) ?? this.securityGroups.get(id) ?? this.compute.taggable(id);
          if (!o) return this.ec2Error(400, 'InvalidID', `The ID '${id}' is not valid`);
          for (let j = 1; p.has(`Tag.${j}.Key`); j++) o.Tags[p.get(`Tag.${j}.Key`)!] = p.get(`Tag.${j}.Value`) ?? '';
        }
        return this.ec2Ok('CreateTags', '<return>true</return>');
      }
    }
    const compute = this.compute.ec2(action, p, { indexed, filters, tagSpecs, tagSet });
    if (compute) return compute;
    return this.ec2Error(400, 'InvalidAction', `The action ${action} is not valid for this web service.`);
  }

  // ---------- S3 (path style) ----------

  private s3(r: RecordedRequest): Reply {
    const [, name] = r.path.split('/');
    const bucketName = decodeURIComponent(name ?? '');
    if (!bucketName) {
      const items = [...this.buckets.values()].map((b) => `<Bucket><Name>${xmlEsc(b.Name)}</Name><CreationDate>${iso(b.CreatedAt)}</CreationDate><BucketRegion>${b.Region}</BucketRegion></Bucket>`).join('');
      return { status: 200, headers: { 'content-type': 'application/xml' }, body: `<?xml version="1.0" encoding="UTF-8"?><ListAllMyBucketsResult><Owner><ID>${this.account}</ID></Owner><Buckets>${items}</Buckets></ListAllMyBucketsResult>` };
    }
    const b = this.buckets.get(bucketName);
    const missing = () => this.s3Error(404, 'NoSuchBucket', 'The specified bucket does not exist');
    const objectKey = decodeURIComponent(r.path.split('/').slice(2).join('/'));
    if (objectKey) {
      if (!b) return missing();
      const id = `${bucketName}/${objectKey}`;
      if (r.method === 'PUT') {
        this.objects.set(id, { body: r.body, contentType: r.headers['content-type'] ?? 'application/octet-stream' });
        return { status: 200, headers: { etag: `"${this.nextId()}"` } };
      }
      const o = this.objects.get(id);
      if (r.method === 'GET') return o ? { status: 200, headers: { 'content-type': o.contentType }, body: o.body } : this.s3Error(404, 'NoSuchKey', 'The specified key does not exist.');
      if (r.method === 'DELETE') return this.objects.delete(id), { status: 204 };
    }
    if (r.query.has('tagging')) {
      if (!b) return missing();
      if (r.method === 'PUT') {
        const tags: Tags = {};
        for (const m of r.body.matchAll(/<Tag>\s*<Key>([^<]*)<\/Key>\s*<Value>([^<]*)<\/Value>\s*<\/Tag>/g)) tags[unxml(m[1]!)] = unxml(m[2]!);
        b.Tags = tags;
        return { status: 204 };
      }
      if (r.method === 'DELETE') {
        b.Tags = null;
        return { status: 204 };
      }
      if (!b.Tags) return this.s3Error(404, 'NoSuchTagSet', 'The TagSet does not exist');
      return { status: 200, headers: { 'content-type': 'application/xml' }, body: `<?xml version="1.0" encoding="UTF-8"?><Tagging><TagSet>${Object.entries(b.Tags).map(([k, v]) => `<Tag><Key>${xmlEsc(k)}</Key><Value>${xmlEsc(v)}</Value></Tag>`).join('')}</TagSet></Tagging>` };
    }
    if (r.query.has('location')) {
      if (!b) return missing();
      return { status: 200, headers: { 'content-type': 'application/xml' }, body: `<?xml version="1.0" encoding="UTF-8"?><LocationConstraint>${b.Region === 'us-east-1' ? '' : b.Region}</LocationConstraint>` };
    }
    if (r.query.has('publicAccessBlock')) {
      if (!b) return missing();
      if (r.method === 'PUT') {
        b.PublicAccessBlock = /<BlockPublicAcls>true<\/BlockPublicAcls>/.test(r.body);
        return { status: 200 };
      }
      return { status: 200, headers: { 'content-type': 'application/xml' }, body: `<?xml version="1.0" encoding="UTF-8"?><PublicAccessBlockConfiguration><BlockPublicAcls>${b.PublicAccessBlock}</BlockPublicAcls><IgnorePublicAcls>${b.PublicAccessBlock}</IgnorePublicAcls><BlockPublicPolicy>${b.PublicAccessBlock}</BlockPublicPolicy><RestrictPublicBuckets>${b.PublicAccessBlock}</RestrictPublicBuckets></PublicAccessBlockConfiguration>` };
    }
    switch (r.method) {
      case 'PUT': {
        if (b) return this.s3Error(409, 'BucketAlreadyOwnedByYou', 'Your previous request to create the named bucket succeeded and you already own it.');
        const region = /<LocationConstraint>([^<]+)<\/LocationConstraint>/.exec(r.body)?.[1] ?? 'us-east-1';
        this.buckets.set(bucketName, { Name: bucketName, Region: region, Tags: null, CreatedAt: Date.now(), PublicAccessBlock: false });
        return { status: 200, headers: { location: `/${bucketName}` } };
      }
      case 'HEAD':
        return b ? { status: 200, headers: { 'x-amz-bucket-region': b.Region } } : { status: 404 };
      case 'DELETE':
        if (!b) return missing();
        this.buckets.delete(bucketName);
        return { status: 204 };
      case 'GET':
        if (!b) return missing();
        return { status: 200, headers: { 'content-type': 'application/xml' }, body: `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${xmlEsc(bucketName)}</Name><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated></ListBucketResult>` };
    }
    return this.s3Error(405, 'MethodNotAllowed', 'The specified method is not allowed');
  }

  // ---------- Route 53 ----------

  private r53Ok(root: string, inner: string, status = 200): Reply {
    return { status, headers: { 'content-type': 'text/xml' }, body: `<?xml version="1.0" encoding="UTF-8"?><${root} xmlns="${R53}">${inner}</${root}>` };
  }

  private zoneXml(z: Zone): string {
    return `<HostedZone><Id>/hostedzone/${z.Id}</Id><Name>${xmlEsc(z.Name)}</Name><CallerReference>${xmlEsc(z.CallerReference)}</CallerReference><Config><PrivateZone>false</PrivateZone></Config><ResourceRecordSetCount>${z.Records.size}</ResourceRecordSetCount></HostedZone>`;
  }

  private changeInfo(id: string, status: string): string {
    return `<ChangeInfo><Id>/change/${id}</Id><Status>${status}</Status><SubmittedAt>${iso(Date.now())}</SubmittedAt></ChangeInfo>`;
  }

  /** A hosted zone added directly (zones are usually made by hand before Exprsn-AI manages their records). */
  addZone(name: string): Zone {
    const z: Zone = { Id: `Z${randomBytes(6).toString('hex').toUpperCase()}`, Name: fqdn(name), CallerReference: randomBytes(4).toString('hex'), Records: new Map() };
    z.Records.set(`${z.Name}|NS`, { Name: z.Name, Type: 'NS', TTL: 172800, Values: ['ns-1.awsdns.example.'] });
    this.zones.set(z.Id, z);
    return z;
  }

  private route53(r: RecordedRequest): Reply {
    const zoneId = /\/hostedzone\/([^/]+)/.exec(r.path)?.[1];
    const z = zoneId ? this.zones.get(zoneId) : undefined;
    const noZone = () => ({ status: 404, body: this.queryError('NoSuchHostedZone', `No hosted zone found with ID: ${zoneId}`, true) });
    switch (r.op) {
      case 'route53:ListHostedZones':
        return this.r53Ok('ListHostedZonesResponse', `<HostedZones>${[...this.zones.values()].map((x) => this.zoneXml(x)).join('')}</HostedZones><IsTruncated>false</IsTruncated><MaxItems>100</MaxItems>`);
      case 'route53:CreateHostedZone': {
        const name = /<Name>([^<]+)<\/Name>/.exec(r.body)?.[1] ?? '';
        const ref = /<CallerReference>([^<]+)<\/CallerReference>/.exec(r.body)?.[1] ?? '';
        if ([...this.zones.values()].some((x) => x.CallerReference === ref)) return { status: 409, body: this.queryError('HostedZoneAlreadyExists', 'A hosted zone has already been created with the specified caller reference.', true) };
        const nz = this.addZone(name);
        nz.CallerReference = ref;
        const change = this.nextId('C');
        this.changes.set(change, { polls: 0 });
        return { ...this.r53Ok('CreateHostedZoneResponse', `${this.zoneXml(nz)}${this.changeInfo(change, 'PENDING')}<DelegationSet><NameServers><NameServer>ns-1.awsdns.example</NameServer></NameServers></DelegationSet>`, 201), headers: { 'content-type': 'text/xml', location: `/2013-04-01/hostedzone/${nz.Id}` } };
      }
      case 'route53:GetHostedZone':
        if (!z) return noZone();
        return this.r53Ok('GetHostedZoneResponse', this.zoneXml(z));
      case 'route53:DeleteHostedZone': {
        if (!z) return noZone();
        this.zones.delete(z.Id);
        const change = this.nextId('C');
        this.changes.set(change, { polls: 0 });
        return this.r53Ok('DeleteHostedZoneResponse', this.changeInfo(change, 'PENDING'));
      }
      case 'route53:ListResourceRecordSets': {
        if (!z) return noZone();
        const start = r.query.get('name') ? fqdn(r.query.get('name')!) : null;
        const type = r.query.get('type');
        const sets = [...z.Records.values()].sort((a, b) => (a.Name < b.Name ? -1 : a.Name > b.Name ? 1 : a.Type < b.Type ? -1 : 1)).filter((s) => !start || s.Name > start || (s.Name === start && (!type || s.Type >= type)));
        const xml = sets.map((s) => `<ResourceRecordSet><Name>${xmlEsc(s.Name)}</Name><Type>${s.Type}</Type><TTL>${s.TTL}</TTL><ResourceRecords>${s.Values.map((v) => `<ResourceRecord><Value>${xmlEsc(v)}</Value></ResourceRecord>`).join('')}</ResourceRecords></ResourceRecordSet>`).join('');
        return this.r53Ok('ListResourceRecordSetsResponse', `<ResourceRecordSets>${xml}</ResourceRecordSets><IsTruncated>false</IsTruncated><MaxItems>300</MaxItems>`);
      }
      case 'route53:ChangeResourceRecordSets': {
        if (!z) return noZone();
        const changes = [...r.body.matchAll(/<Change>([\s\S]*?)<\/Change>/g)].map((m) => {
          const c = m[1]!;
          return { action: /<Action>([^<]+)<\/Action>/.exec(c)?.[1] ?? '', set: { Name: fqdn(unxml(/<Name>([^<]+)<\/Name>/.exec(c)?.[1] ?? '')), Type: /<Type>([^<]+)<\/Type>/.exec(c)?.[1] ?? '', TTL: Number(/<TTL>(\d+)<\/TTL>/.exec(c)?.[1] ?? 300), Values: [...c.matchAll(/<Value>([^<]*)<\/Value>/g)].map((v) => unxml(v[1]!)) } };
        });
        // All or nothing, as Route 53 does.
        for (const c of changes) {
          const key = `${c.set.Name}|${c.set.Type}`;
          if (c.action === 'CREATE' && z.Records.has(key)) return { status: 400, body: this.queryError('InvalidChangeBatch', `[Tried to create resource record set [name='${c.set.Name}', type='${c.set.Type}'] but it already exists]`, true) };
          if (c.action === 'DELETE' && !z.Records.has(key)) return { status: 400, body: this.queryError('InvalidChangeBatch', `[Tried to delete resource record set [name='${c.set.Name}', type='${c.set.Type}'] but it was not found]`, true) };
        }
        for (const c of changes) {
          const key = `${c.set.Name}|${c.set.Type}`;
          if (c.action === 'DELETE') z.Records.delete(key);
          else z.Records.set(key, c.set);
        }
        const change = this.nextId('C');
        this.changes.set(change, { polls: 0 });
        return this.r53Ok('ChangeResourceRecordSetsResponse', this.changeInfo(change, 'PENDING'));
      }
      case 'route53:GetChange': {
        const id = r.path.split('/').pop()!;
        const c = this.changes.get(id);
        if (!c) return { status: 404, body: this.queryError('NoSuchChange', `A change with the specified change ID does not exist.`, true) };
        c.polls += 1;
        return this.r53Ok('GetChangeResponse', this.changeInfo(id, c.polls > this.settleAfter ? 'INSYNC' : 'PENDING'));
      }
    }
    return { status: 400, body: this.queryError('InvalidInput', `${r.op} is not something this fake answers`, true) };
  }
}

const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
