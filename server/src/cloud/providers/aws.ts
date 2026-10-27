import { CreateSubnetCommand, CreateSecurityGroupCommand, CreateTagsCommand, CreateVpcCommand, DeleteSecurityGroupCommand, DeleteSubnetCommand, DeleteVpcCommand, DescribeSecurityGroupsCommand, DescribeSubnetsCommand, DescribeVpcsCommand, EC2Client, AuthorizeSecurityGroupIngressCommand, RevokeSecurityGroupIngressCommand, type Filter, type IpPermission, type SecurityGroup, type Subnet, type Tag, type Vpc } from '@aws-sdk/client-ec2';
import { IAMClient, SimulatePrincipalPolicyCommand, type ContextEntry } from '@aws-sdk/client-iam';
import { ChangeResourceRecordSetsCommand, GetChangeCommand, ListHostedZonesCommand, ListResourceRecordSetsCommand, Route53Client, type ResourceRecordSet } from '@aws-sdk/client-route-53';
import { CreateBucketCommand, DeleteBucketCommand, GetBucketTaggingCommand, HeadBucketCommand, ListBucketsCommand, PutBucketTaggingCommand, PutPublicAccessBlockCommand, S3Client, type BucketLocationConstraint } from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { createHash } from 'node:crypto';
import { signV4 } from '../../platform/blob.js';
import type { CacheAccess } from '../caches.js';
import { FEATURES_BY_PROVIDER, type CloudAccount, type CloudFeature, type IdentityResult, type PermissionCheck } from '../types.js';
import { namePrefix } from '../tags.js';
import { smithyHandler } from './sdk-bridges.js';
import { AWS_CAPABILITIES, AWS_FEATURE_ACTIONS, snapshotReason } from './capabilities.js';
import { CloudTransport, type TransportOptions } from './transport.js';
import { AwsCompute } from './aws-compute.js';
import { EksResources } from './aws-eks.js';
import { AwsCaches } from './aws-cache.js';
import { AwsRds } from './aws-rds.js';
import { isKubeType } from './kubernetes.js';
import {
  assertAccount,
  CloudProviderError,
  CloudUnsupported,
  type AdapterCredential,
  type CallContext,
  type ChangeEvent,
  type ChangeTrailQuery,
  type ClusterAccess,
  type CloudProvider,
  type FirewallRule,
  type InstallStatus,
  type ListFilter,
  type ObservedResource,
  type OperationHandle,
  type OperationResult,
  type PollResult,
  type PropsByType,
  type ResourceOperation,
  type ResourceRef,
  type ResourceSpec,
  type ResourceType,
  type Support,
  type DatabaseSnapshot,
  type ExtensionStatus,
  type SnapshotPurpose,
  type SnapshotResult
} from './types.js';

/*
 * 1.9.99-final, Sprint 56 (B-10101): the AWS adapter, on the AWS SDK for JavaScript v3's modular clients (STS, IAM,
 * EC2, S3, Route 53). Every client is built per call with the account's credential, an explicit region, the SDK's own
 * retries off (`maxAttempts: 1`), configured endpoint URLs from the environment ignored, and `smithyHandler` as its
 * request handler, so every request goes through `CloudTransport` (the egress guard and the rate limiter). The SDK's
 * default credential chain (and with it the instance metadata service) is never reached: a credential is always given.
 *
 * Idempotency: EC2 VPCs, subnets and security groups take no client token, so each carries `exprsn:name` (its
 * logical name) and `exprsn:account` from create time (TagSpecifications) and a create looks them up first; S3
 * buckets are found by name (and `BucketAlreadyOwnedByYou` is adopted); Route 53 record sets are keyed by name and
 * type. Long-running operations: VPCs and subnets are described until `available`; record changes follow `GetChange`
 * until `INSYNC`.
 */

export interface AwsEndpoints {
  sts?: string;
  iam?: string;
  ec2?: string;
  s3?: string;
  route53?: string;
  /** Sprint 58 (B-10205): ECS, Elastic Load Balancing v2 and Secrets Manager (default: the regional endpoints). */
  ecs?: string;
  elbv2?: string;
  secretsmanager?: string;
  /** Sprint 58 (B-10203): EKS (default `https://eks.<region>.amazonaws.com`). */
  eks?: string;
  /** Sprint 59 (B-10305): ElastiCache and MemoryDB (default: the regional endpoints). */
  elasticache?: string;
  /** Sprint 59 (B-10301, B-10303, B-10307): RDS and Aurora (default `https://rds.<region>.amazonaws.com`). */
  rds?: string;
  memorydb?: string;
  /** Sprint 60 (B-10405): Service Quotas (default `https://servicequotas.<region>.amazonaws.com`). */
  servicequotas?: string;
  /** Sprint 62 (B-10703): CloudTrail `LookupEvents`, the change trail (default `https://cloudtrail.<region>.amazonaws.com`). */
  cloudtrail?: string;
}

/** Sprint 62 (B-10703): CloudTrail's JSON target and the IAM action it needs (`capabilities.ts`, deploy). */
const CLOUDTRAIL = { action: 'cloudtrail:LookupEvents', target: 'com.amazonaws.cloudtrail.v20131101.CloudTrail_20131101.LookupEvents' } as const;
/** At most this many pages of 50 events per lookup (LookupEvents allows two calls a second per account and region). */
const CLOUDTRAIL_PAGES = 3;


type Sdk = 'sts' | 'iam' | 'ec2' | 's3' | 'route53';

export interface AwsProviderOptions extends Omit<TransportOptions, 'provider'> {
  endpoints?: AwsEndpoints;
}

const NAME_TAG = 'exprsn:name';

export class AwsProvider implements CloudProvider {
  readonly kind = 'aws' as const;
  readonly capabilities = AWS_CAPABILITIES;
  readonly transport: CloudTransport;
  private endpoints: AwsEndpoints;
  /** Sprint 58 (B-10204, B-10205): EC2 instances and ECS on Fargate (`aws-compute.ts`). */
  private readonly compute: AwsCompute;

  constructor(o: AwsProviderOptions) {
    const { endpoints, ...t } = o;
    this.transport = new CloudTransport({ ...t, provider: 'aws' });
    this.endpoints = endpoints ?? {};
    this.compute = new AwsCompute({
      transport: this.transport,
      ec2: (ctx, region) => this.ec2(ctx, region),
      endpoint: (service, region) => this.endpoints[service] ?? `https://${service === 'elbv2' ? 'elasticloadbalancing' : service}.${region}.amazonaws.com`,
      region: (ctx, spec) => spec?.region ?? ctx.region ?? ctx.account.defaultRegion ?? 'us-east-1'
    });
  }

  /** Sprint 60 (B-10405): a service's endpoint for a region (the configured one, else the regional default). */
  serviceEndpoint(service: 'ec2' | 'servicequotas', region: string): string {
    return (this.endpoints[service] ?? `https://${service}.${region}.amazonaws.com`).replace(/\/$/, '');
  }

  /** Points the clients at other endpoints (tests: the fake). */
  setEndpoints(e: AwsEndpoints): void {
    this.endpoints = { ...e };
  }

  /** Sprint 58 (B-10203): EKS clusters, node groups and the cluster's load balancer (`aws-eks.ts`), on this adapter's transport. */
  private get kube(): EksResources {
    // B-10705: the EC2 client makes each node group's launch template (IMDSv2 required, hop limit 1).
    return (this.eks ??= new EksResources({ transport: this.transport, endpoint: (r) => this.endpoints.eks ?? `https://eks.${r}.amazonaws.com`, stsEndpoint: (r) => this.endpoints.sts ?? `https://sts.${r}.amazonaws.com`, ec2: (ctx, r) => this.ec2(ctx, r) }));
  }
  private eks: EksResources | null = null;

  /** Sprint 59 (B-10305): ElastiCache replication groups and MemoryDB clusters (`aws-cache.ts`), on this adapter's transport. */
  private get caches(): AwsCaches {
    return (this.cacheModule ??= new AwsCaches({ transport: this.transport, endpoint: (svc, r) => this.endpoints[svc] ?? (svc === 'memorydb' ? `https://memory-db.${r}.amazonaws.com` : `https://elasticache.${r}.amazonaws.com`), region: (ctx, spec) => spec?.region ?? ctx.region ?? ctx.account.defaultRegion ?? 'us-east-1' }));
  }
  private cacheModule: AwsCaches | null = null;

  /** Sprint 59 (B-10301, B-10303, B-10307): RDS instances and Aurora clusters (`aws-rds.ts`), on this adapter's transport. */
  private get rdsModule(): AwsRds {
    return (this.rdsInstance ??= new AwsRds({ transport: this.transport, endpoint: (r) => this.endpoints.rds ?? `https://rds.${r}.amazonaws.com`, region: (ctx, spec) => spec?.region ?? ctx.region ?? ctx.account.defaultRegion ?? 'us-east-1' }));
  }
  private rdsInstance: AwsRds | null = null;

  /** B-10307: RDS and Aurora take manual snapshots; nothing else here does. */
  snapshotSupport(type: ResourceType): string | null {
    return snapshotReason('aws', type);
  }

  async snapshot(ctx: CallContext, ref: ResourceRef, name: string, o?: { purpose?: SnapshotPurpose }): Promise<SnapshotResult> {
    const why = snapshotReason('aws', ref.type);
    if (why) throw new CloudUnsupported('aws', ref.type, 'not_yet', undefined, why);
    return this.rdsModule.snapshot(ctx, ref, name, o?.purpose ?? 'final');
  }

  async snapshotStatus(ctx: CallContext, ref: ResourceRef, pending: SnapshotResult): Promise<SnapshotResult> {
    return this.rdsModule.snapshotStatus(ctx, ref, pending);
  }

  async listSnapshots(ctx: CallContext, ref: ResourceRef): Promise<DatabaseSnapshot[]> {
    this.assertBuilt('database', 'describe');
    return this.rdsModule.listSnapshots(ctx, ref);
  }

  async deleteSnapshot(ctx: CallContext, ref: ResourceRef, snapshotId: string): Promise<void> {
    this.assertBuilt('database', 'delete');
    return this.rdsModule.deleteSnapshot(ctx, ref, snapshotId);
  }

  /** B-10307: a database snapshot restored to a new instance. */
  async restoreSnapshot(ctx: CallContext, ref: ResourceRef, snapshotId: string, o?: { name?: string; tags?: Record<string, string> }): Promise<SnapshotResult> {
    this.assertBuilt('database', 'create');
    return this.rdsModule.restore(ctx, ref, snapshotId, o);
  }

  /** B-10301: the extension check (the supported list and the parameter group's `rds.allowed_extensions`). */
  async databaseExtensions(ctx: CallContext, ref: ResourceRef, wanted: string[]): Promise<ExtensionStatus[]> {
    this.assertBuilt('database', 'describe');
    return this.rdsModule.extensions(ctx, ref, wanted);
  }

  /** B-10305: a cache's primary endpoint (its AUTH token is Exprsn-AI's own, in the vault). */
  async cacheAccess(ctx: CallContext, ref: ResourceRef): Promise<CacheAccess> {
    this.assertBuilt('cache', 'describe');
    return this.caches.access(ctx, ref);
  }

  /** B-10203: a short-lived token for an EKS cluster's API (a presigned STS GetCallerIdentity). */
  async kubeAccess(ctx: CallContext, ref: ResourceRef): Promise<ClusterAccess> {
    this.assertBuilt('kubernetes_cluster', 'describe');
    return this.kube.access(ctx, ref);
  }

  supports(type: ResourceType, op?: ResourceOperation): Support {
    const c = this.capabilities[type];
    if (c.support !== 'built') return c.support;
    return !op || c.operations.includes(op) ? 'built' : 'not_yet';
  }

  /**
   * B-10703 (Sprint 62): CloudTrail `LookupEvents` for one resource in a window, in the resource's region (Route 53,
   * IAM and other global services record in us-east-1). Resources are looked up by name: the provider id (a security
   * group, a VPC, an instance, a bucket), a record set by its hosted zone. Read-only events are left out; newest first.
   */
  async changeEvents(ctx: CallContext, q: ChangeTrailQuery): Promise<ChangeEvent[]> {
    assertAccount('aws', ctx.account);
    if (ctx.cred.kind !== 'aws') throw new CloudProviderError('An AWS account needs an AWS credential.', 'aws', 400, 'wrong_credential');
    const cred = ctx.cred;
    const global = q.type === 'dns_record' || !q.region || q.region === 'global';
    const region = global ? 'us-east-1' : q.region!;
    const name = q.type === 'dns_record' ? (q.locator?.zoneId ?? q.providerId.split('/')[0]!) : q.providerId;
    const url = new URL('/', this.endpoints.cloudtrail ?? `https://cloudtrail.${region}.amazonaws.com`);
    const limit = q.limit ?? 20;
    const out: ChangeEvent[] = [];
    let token: string | undefined;
    for (let page = 0; page < CLOUDTRAIL_PAGES && out.length < limit; page++) {
      const body = JSON.stringify({ LookupAttributes: [{ AttributeKey: 'ResourceName', AttributeValue: name }], StartTime: Math.floor(q.from / 1000), EndTime: Math.ceil(q.to / 1000), MaxResults: 50, ...(token ? { NextToken: token } : {}) });
      const headers: Record<string, string> = { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': CLOUDTRAIL.target, ...(cred.sessionToken ? { 'x-amz-security-token': cred.sessionToken } : {}) };
      const signed = signV4({ method: 'POST', url, headers, payloadHash: createHash('sha256').update(body).digest('hex'), region, service: 'cloudtrail', accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey, date: new Date() });
      const res = await this.transport.send({ method: 'POST', url, headers: signed, body, accountId: ctx.account.id, ...(ctx.signal ? { signal: ctx.signal } : {}) });
      const text = res.body.toString('utf8');
      let parsed: { Events?: CloudTrailEvent[]; NextToken?: string; __type?: string; message?: string; Message?: string } = {};
      try {
        parsed = text ? (JSON.parse(text) as typeof parsed) : {};
      } catch {
        /* not JSON */
      }
      if (res.status >= 300) {
        const code = String(parsed.__type ?? '').split('#').pop() || null;
        throw new CloudProviderError(`AWS CloudTrail answered ${res.status}${code ? ` (${code})` : ''}: ${String(parsed.message ?? parsed.Message ?? 'no detail').slice(0, 300)}`, 'aws', res.status, code, res.requestId);
      }
      for (const e of parsed.Events ?? []) {
        const ev = trailEvent(e);
        if (ev) out.push(ev);
      }
      token = parsed.NextToken;
      if (!token) break;
    }
    return out.sort((a, b) => b.at - a.at).slice(0, limit);
  }

  // ---------- clients ----------

  private config(sdk: Sdk, cred: AdapterCredential, account: CloudAccount, region?: string) {
    assertAccount('aws', account);
    if (cred.kind !== 'aws') throw new CloudProviderError('An AWS account needs an AWS credential.', 'aws', 400, 'wrong_credential');
    const endpoint = this.endpoints[sdk];
    return {
      region: sdk === 'iam' || sdk === 'route53' ? 'us-east-1' : (region ?? account.defaultRegion ?? 'us-east-1'),
      credentials: { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey, ...(cred.sessionToken ? { sessionToken: cred.sessionToken } : {}), ...(cred.expiresAt != null ? { expiration: new Date(cred.expiresAt) } : {}) },
      requestHandler: smithyHandler(this.transport, account.id),
      maxAttempts: 1,
      defaultsMode: 'standard' as const,
      ignoreConfiguredEndpointUrls: true,
      ...(endpoint ? { endpoint } : {})
    };
  }

  private sts(cred: AdapterCredential, account: CloudAccount, region?: string) {
    return new STSClient(this.config('sts', cred, account, region));
  }
  private iam(cred: AdapterCredential, account: CloudAccount) {
    return new IAMClient(this.config('iam', cred, account));
  }
  private ec2(ctx: CallContext, region?: string) {
    return new EC2Client(this.config('ec2', ctx.cred, ctx.account, region ?? ctx.region));
  }
  private s3(ctx: CallContext, region?: string) {
    const c = this.config('s3', ctx.cred, ctx.account, region ?? ctx.region);
    return new S3Client({ ...c, forcePathStyle: Boolean(this.endpoints.s3), requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  }
  private r53(ctx: CallContext) {
    return new Route53Client(this.config('route53', ctx.cred, ctx.account));
  }

  // ---------- identity and permissions ----------

  async identity(cred: AdapterCredential, account: CloudAccount): Promise<IdentityResult> {
    try {
      const r = await this.sts(cred, account).send(new GetCallerIdentityCommand({}));
      return { ok: true, principal: r.Arn, providerAccount: r.Account, ...(r.$metadata.requestId ? { requestId: r.$metadata.requestId } : {}) };
    } catch (err) {
      const e = awsError(err);
      if (e.status === 401 || e.status === 403) return { ok: false, error: `AWS refused the credential (${e.code ?? e.status}): ${e.message}`, ...(e.requestId ? { requestId: e.requestId } : {}) };
      throw e;
    }
  }

  async checkPermissions(cred: AdapterCredential, account: CloudAccount, features: CloudFeature[]): Promise<PermissionCheck[]> {
    const offered = FEATURES_BY_PROVIDER.aws;
    const wanted = features.filter((f) => offered.includes(f) && AWS_FEATURE_ACTIONS[f]);
    const out: PermissionCheck[] = features.filter((f) => !wanted.includes(f)).map((f) => ({ feature: f, required: [], missing: [], unsupported: true }));
    if (!wanted.length) return out;
    const who = await this.sts(cred, account).send(new GetCallerIdentityCommand({})).catch((err) => {
      throw awsError(err);
    });
    const source = policySourceArn(who.Arn ?? '');
    const actions = [...new Set(wanted.flatMap((f) => AWS_FEATURE_ACTIONS[f]!))];
    const decisions = new Map<string, string>();
    const context: ContextEntry[] = ['aws:RequestTag/exprsn:managed', 'aws:ResourceTag/exprsn:managed'].map((k) => ({ ContextKeyName: k, ContextKeyValues: ['true'], ContextKeyType: 'string' as const })).concat(['aws:RequestTag/exprsn:account', 'aws:ResourceTag/exprsn:account'].map((k) => ({ ContextKeyName: k, ContextKeyValues: [account.name], ContextKeyType: 'string' as const })));
    try {
      const client = this.iam(cred, account);
      for (let i = 0; i < actions.length; i += 50) {
        let marker: string | undefined;
        do {
          const r = await client.send(new SimulatePrincipalPolicyCommand({ PolicySourceArn: source, ActionNames: actions.slice(i, i + 50), ContextEntries: context, ...(marker ? { Marker: marker } : {}) }));
          for (const e of r.EvaluationResults ?? []) if (e.EvalActionName) decisions.set(e.EvalActionName, e.EvalDecision ?? 'implicitDeny');
          marker = r.IsTruncated ? r.Marker : undefined;
        } while (marker);
      }
    } catch (err) {
      const e = awsError(err);
      if (e.status !== 401 && e.status !== 403) throw e;
      return out.concat(wanted.map((f) => ({ feature: f, required: AWS_FEATURE_ACTIONS[f]!, missing: [], error: 'The credential may not call iam:SimulatePrincipalPolicy, so its permissions cannot be checked. Grant it, or check the policy by hand.' })));
    }
    for (const f of wanted) {
      const required = AWS_FEATURE_ACTIONS[f]!;
      out.push({ feature: f, required, missing: required.filter((a) => decisions.get(a) !== 'allowed') });
    }
    return features.map((f) => out.find((c) => c.feature === f)!);
  }

  // ---------- resources ----------

  private assertBuilt(type: ResourceType, op: ResourceOperation): void {
    const s = this.supports(type, op);
    if (s !== 'built') throw new CloudUnsupported('aws', type, s, op, this.capabilities[type].note);
  }

  async find(ctx: CallContext, spec: ResourceSpec): Promise<ObservedResource | null> {
    this.assertBuilt(spec.type, 'describe');
    if (isKubeType(spec.type)) return this.kube.find(ctx, spec);
    if (spec.type === 'cache') return this.caches.find(ctx, spec);
    if (spec.type === 'database') return this.rdsModule.find(ctx, spec);
    const region = spec.region ?? ctx.region;
    switch (spec.type) {
      case 'network':
      case 'subnet':
      case 'firewall': {
        const filters: Filter[] = [{ Name: `tag:${NAME_TAG}`, Values: [spec.name] }, { Name: 'tag:exprsn:account', Values: [ctx.account.name] }];
        if (spec.type !== 'network' && spec.parent?.networkId) filters.push({ Name: 'vpc-id', Values: [spec.parent.networkId] });
        const found = await this.listEc2(ctx, spec.type, filters, region);
        return found[0] ?? null;
      }
      case 'bucket':
        return this.describe(ctx, { type: 'bucket', providerId: this.bucketName(ctx.account, spec as ResourceSpec<'bucket'>), ...(region ? { region } : {}) });
      case 'dns_record': {
        const p = (spec as ResourceSpec<'dns_record'>).props;
        const zoneId = await this.zoneId(ctx, p.zone);
        return this.describe(ctx, { type: 'dns_record', providerId: recordId(zoneId, fqdn(p.record, p.zone), p.recordType), locator: { zoneId } });
      }
      case 'vm':
        return this.compute.findVm(ctx, spec);
      case 'container_service':
        return this.compute.findService(ctx, spec);
    }
    return null;
  }

  async describe(ctx: CallContext, ref: ResourceRef): Promise<ObservedResource | null> {
    this.assertBuilt(ref.type, 'describe');
    if (isKubeType(ref.type)) return this.kube.describe(ctx, ref);
    if (ref.type === 'cache') return this.caches.describe(ctx, ref);
    if (ref.type === 'database') return this.rdsModule.describe(ctx, ref);
    const region = ref.region ?? ctx.region;
    switch (ref.type) {
      case 'network':
        return (await this.listEc2(ctx, 'network', [{ Name: 'vpc-id', Values: [ref.providerId] }], region))[0] ?? null;
      case 'subnet':
        return (await this.listEc2(ctx, 'subnet', [{ Name: 'subnet-id', Values: [ref.providerId] }], region))[0] ?? null;
      case 'firewall':
        return (await this.listEc2(ctx, 'firewall', [{ Name: 'group-id', Values: [ref.providerId] }], region))[0] ?? null;
      case 'bucket': {
        const s3 = this.s3(ctx, region);
        try {
          await s3.send(new HeadBucketCommand({ Bucket: ref.providerId }));
        } catch (err) {
          const e = awsError(err);
          if (e.status === 404) return null;
          if (e.status === 403) throw new CloudProviderError(`The bucket ${ref.providerId} exists but belongs to someone else, or this credential may not read it.`, 'aws', 409, 'bucket_not_owned', e.requestId);
          throw e;
        }
        let tags: Record<string, string> = {};
        try {
          const t = await s3.send(new GetBucketTaggingCommand({ Bucket: ref.providerId }));
          tags = fromTags(t.TagSet);
        } catch (err) {
          const e = awsError(err);
          if (e.code !== 'NoSuchTagSet' && e.status !== 404) throw e;
        }
        return { type: 'bucket', providerId: ref.providerId, name: tags[NAME_TAG] ?? ref.providerId, ...(region ? { region } : {}), state: 'ready', tags: managedTags(tags), props: { bucketName: ref.providerId } };
      }
      case 'dns_record': {
        const [zoneId, name, rtype] = splitRecordId(ref.providerId);
        const r = await this.r53(ctx).send(new ListResourceRecordSetsCommand({ HostedZoneId: zoneId, StartRecordName: name, StartRecordType: rtype as never, MaxItems: 1 })).catch((err) => {
          throw awsError(err);
        });
        const set = r.ResourceRecordSets?.[0];
        if (!set || fqdnOf(set.Name) !== name || set.Type !== rtype) return null;
        return recordObserved(zoneId, set);
      }
      case 'vm':
        return this.compute.describeVm(ctx, ref);
      case 'container_service':
        return this.compute.describeService(ctx, ref);
    }
    return null;
  }

  async list(ctx: CallContext, type: ResourceType, filter: ListFilter = {}): Promise<ObservedResource[]> {
    this.assertBuilt(type, 'list');
    if (type === 'kubernetes_cluster' || type === 'node_group' || type === 'load_balancer') return this.kube.list(ctx, type, filter);
    if (type === 'cache') return this.caches.list(ctx, filter);
    if (type === 'database') return this.rdsModule.list(ctx, filter);
    switch (type) {
      case 'network':
      case 'subnet':
      case 'firewall': {
        const filters: Filter[] = [];
        if (filter.managedOnly) filters.push({ Name: 'tag:exprsn:managed', Values: ['true'] }, { Name: 'tag:exprsn:account', Values: [ctx.account.name] });
        if (filter.networkId && type !== 'network') filters.push({ Name: 'vpc-id', Values: [filter.networkId] });
        return this.listEc2(ctx, type, filters, ctx.region);
      }
      case 'bucket': {
        const r = await this.s3(ctx).send(new ListBucketsCommand({})).catch((err) => {
          throw awsError(err);
        });
        const prefix = namePrefix(ctx.account.name);
        const names = (r.Buckets ?? []).map((b) => b.Name!).filter((n) => !filter.managedOnly || n.startsWith(prefix));
        const out: ObservedResource[] = [];
        for (const n of names) {
          const o = await this.describe(ctx, { type: 'bucket', providerId: n }).catch(() => null);
          if (o && (!filter.managedOnly || o.tags['exprsn:account'] === ctx.account.name)) out.push(o);
        }
        return out;
      }
      case 'dns_record': {
        if (!filter.zone) throw new CloudProviderError('Listing Route 53 records needs the zone.', 'aws', 400, 'zone_required');
        const zoneId = await this.zoneId(ctx, filter.zone);
        const out: ObservedResource[] = [];
        let start: { name?: string; type?: string } = {};
        for (;;) {
          const r = await this.r53(ctx).send(new ListResourceRecordSetsCommand({ HostedZoneId: zoneId, ...(start.name ? { StartRecordName: start.name, StartRecordType: start.type as never } : {}) })).catch((err) => {
            throw awsError(err);
          });
          for (const set of r.ResourceRecordSets ?? []) if (set.Type !== 'NS' && set.Type !== 'SOA') out.push(recordObserved(zoneId, set));
          if (!r.IsTruncated) break;
          start = { name: r.NextRecordName!, type: r.NextRecordType! };
        }
        return out;
      }
      case 'vm':
        return this.compute.listVms(ctx, filter);
      case 'container_service':
        return this.compute.listServices(ctx);
    }
    return [];
  }

  async create(ctx: CallContext, spec: ResourceSpec): Promise<OperationResult> {
    this.assertBuilt(spec.type, 'create');
    if (isKubeType(spec.type)) return this.kube.create(ctx, spec);
    if (spec.type === 'cache') return this.caches.create(ctx, spec, (op, ref, kind, token) => this.handle(op, ref, kind, token));
    if (spec.type === 'database') return this.rdsModule.create(ctx, spec as ResourceSpec<'database'>, (op, ref, kind, token) => this.handle(op, ref, kind, token));
    if (spec.type === 'vm') return this.compute.createVm(ctx, spec as ResourceSpec<'vm'>, (op, ref, kind, token) => this.handle(op, ref, kind, token));
    if (spec.type === 'container_service') return this.compute.createService(ctx, spec as ResourceSpec<'container_service'>, (op, ref, kind, token) => this.handle(op, ref, kind, token));
    const existing = await this.find(ctx, spec);
    if (existing) {
      if (spec.type === 'firewall') await this.reconcileIngress(ctx, existing, (spec as ResourceSpec<'firewall'>).props.ingress, spec.region);
      if (existing.state === 'creating') return { done: false, operation: this.handle('create', existing, 'aws-describe', existing.providerId), resource: existing };
      return { done: true, resource: spec.type === 'firewall' ? await this.describe(ctx, existing) : existing, adopted: true };
    }
    const region = spec.region ?? ctx.region;
    const tags = toTags({ ...spec.tags, [NAME_TAG]: spec.name, Name: `${namePrefix(ctx.account.name)}${spec.name}` });
    switch (spec.type) {
      case 'network': {
        const p = (spec as ResourceSpec<'network'>).props;
        const r = await this.ec2(ctx, region).send(new CreateVpcCommand({ CidrBlock: p.cidr, TagSpecifications: [{ ResourceType: 'vpc', Tags: tags }] })).catch((err) => {
          throw awsError(err);
        });
        const o = vpcObserved(r.Vpc!, region);
        return o.state === 'ready' ? { done: true, resource: o, ...rid(r) } : { done: false, operation: this.handle('create', o, 'aws-describe', o.providerId), resource: o, ...rid(r) };
      }
      case 'subnet': {
        const p = (spec as ResourceSpec<'subnet'>).props;
        if (!spec.parent?.networkId) throw new CloudProviderError('A subnet needs its network (parent.networkId).', 'aws', 400, 'parent_required');
        const r = await this.ec2(ctx, region).send(new CreateSubnetCommand({ VpcId: spec.parent.networkId, CidrBlock: p.cidr, ...(p.zone ? { AvailabilityZone: p.zone } : {}), TagSpecifications: [{ ResourceType: 'subnet', Tags: tags }] })).catch((err) => {
          throw awsError(err);
        });
        const o = subnetObserved(r.Subnet!, region);
        return o.state === 'ready' ? { done: true, resource: o, ...rid(r) } : { done: false, operation: this.handle('create', o, 'aws-describe', o.providerId), resource: o, ...rid(r) };
      }
      case 'firewall': {
        const p = (spec as ResourceSpec<'firewall'>).props;
        if (!spec.parent?.networkId) throw new CloudProviderError('A security group needs its network (parent.networkId).', 'aws', 400, 'parent_required');
        const r = await this.ec2(ctx, region).send(new CreateSecurityGroupCommand({ GroupName: `${namePrefix(ctx.account.name)}${spec.name}`, Description: p.description ?? `Exprsn-AI ${spec.name}`, VpcId: spec.parent.networkId, TagSpecifications: [{ ResourceType: 'security-group', Tags: tags }] })).catch((err) => {
          throw awsError(err);
        });
        const created: ObservedResource = { type: 'firewall', providerId: r.GroupId!, name: spec.name, ...(region ? { region } : {}), state: 'ready', tags: managedTags(fromTags(tags)), props: { ingress: [] }, locator: { networkId: spec.parent.networkId } };
        await this.reconcileIngress(ctx, created, p.ingress, region);
        return { done: true, resource: await this.describe(ctx, created), ...rid(r) };
      }
      case 'bucket': {
        const name = this.bucketName(ctx.account, spec as ResourceSpec<'bucket'>);
        const s3 = this.s3(ctx, region);
        const r0 = region ?? ctx.account.defaultRegion ?? 'us-east-1';
        let adopted = false;
        try {
          await s3.send(new CreateBucketCommand({ Bucket: name, ...(r0 !== 'us-east-1' ? { CreateBucketConfiguration: { LocationConstraint: r0 as BucketLocationConstraint } } : {}) }));
        } catch (err) {
          const e = awsError(err);
          if (e.code !== 'BucketAlreadyOwnedByYou') throw e;
          adopted = true;
        }
        await s3.send(new PutPublicAccessBlockCommand({ Bucket: name, PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } })).catch((err) => {
          throw awsError(err);
        });
        await s3.send(new PutBucketTaggingCommand({ Bucket: name, Tagging: { TagSet: tags.filter((t) => t.Key !== 'Name') } })).catch((err) => {
          throw awsError(err);
        });
        return { done: true, resource: await this.describe(ctx, { type: 'bucket', providerId: name, region: r0 }), ...(adopted ? { adopted } : {}) };
      }
      case 'dns_record':
        return this.changeRecord(ctx, spec as ResourceSpec<'dns_record'>, 'CREATE');
    }
    throw new CloudUnsupported('aws', spec.type, 'not_yet', 'create');
  }

  async update(ctx: CallContext, ref: ResourceRef, spec: ResourceSpec): Promise<OperationResult> {
    this.assertBuilt(ref.type, 'update');
    if (isKubeType(ref.type)) return this.kube.update(ctx, ref, spec);
    if (ref.type === 'cache') return this.caches.update(ctx, ref, spec, (op, r, kind, token) => this.handle(op, r, kind, token));
    if (ref.type === 'database') return this.rdsModule.update(ctx, ref, spec as ResourceSpec<'database'>, (op, r, kind, token) => this.handle(op, r, kind, token));
    if (ref.type === 'vm') return this.compute.updateVm(ctx, ref, spec as ResourceSpec<'vm'>);
    if (ref.type === 'container_service') return this.compute.updateService(ctx, ref, spec as ResourceSpec<'container_service'>, (op, r, kind, token) => this.handle(op, r, kind, token));
    const region = ref.region ?? spec.region ?? ctx.region;
    switch (ref.type) {
      case 'network':
      case 'subnet':
      case 'firewall': {
        const current = await this.describe(ctx, ref);
        if (!current) throw new CloudProviderError(`${ref.providerId} no longer exists.`, 'aws', 404, 'not_found');
        await this.ec2(ctx, region).send(new CreateTagsCommand({ Resources: [ref.providerId], Tags: toTags({ ...spec.tags, [NAME_TAG]: spec.name }) })).catch((err) => {
          throw awsError(err);
        });
        if (ref.type === 'firewall') await this.reconcileIngress(ctx, current, (spec as ResourceSpec<'firewall'>).props.ingress, region);
        return { done: true, resource: await this.describe(ctx, ref) };
      }
      case 'bucket':
        await this.s3(ctx, region).send(new PutBucketTaggingCommand({ Bucket: ref.providerId, Tagging: { TagSet: toTags({ ...spec.tags, [NAME_TAG]: spec.name }) } })).catch((err) => {
          throw awsError(err);
        });
        return { done: true, resource: await this.describe(ctx, ref) };
      case 'dns_record':
        return this.changeRecord(ctx, spec as ResourceSpec<'dns_record'>, 'UPSERT');
    }
    throw new CloudUnsupported('aws', ref.type, 'not_yet', 'update');
  }

  async delete(ctx: CallContext, ref: ResourceRef): Promise<OperationResult> {
    this.assertBuilt(ref.type, 'delete');
    if (isKubeType(ref.type)) return this.kube.delete(ctx, ref);
    if (ref.type === 'cache') return this.caches.delete(ctx, ref, (op, r, kind, token) => this.handle(op, r, kind, token));
    if (ref.type === 'database') return this.rdsModule.delete(ctx, ref, (op, r, kind, token) => this.handle(op, r, kind, token));
    if (ref.type === 'vm') return this.compute.deleteVm(ctx, ref, (op, r, kind, token) => this.handle(op, r, kind, token));
    if (ref.type === 'container_service') return this.compute.deleteService(ctx, ref, (op, r, kind, token) => this.handle(op, r, kind, token));
    const region = ref.region ?? ctx.region;
    const gone = (err: unknown) => {
      const e = awsError(err);
      if (e.status === 404 || /NotFound|NoSuchBucket/.test(e.code ?? '')) return { done: true as const, resource: null };
      throw e;
    };
    try {
      switch (ref.type) {
        case 'network':
          await this.ec2(ctx, region).send(new DeleteVpcCommand({ VpcId: ref.providerId }));
          return { done: true, resource: null };
        case 'subnet':
          await this.ec2(ctx, region).send(new DeleteSubnetCommand({ SubnetId: ref.providerId }));
          return { done: true, resource: null };
        case 'firewall':
          await this.ec2(ctx, region).send(new DeleteSecurityGroupCommand({ GroupId: ref.providerId }));
          return { done: true, resource: null };
        case 'bucket':
          await this.s3(ctx, region).send(new DeleteBucketCommand({ Bucket: ref.providerId }));
          return { done: true, resource: null };
        case 'dns_record': {
          const current = await this.describe(ctx, ref);
          if (!current) return { done: true, resource: null };
          const [zoneId, name, rtype] = splitRecordId(ref.providerId);
          const r = await this.r53(ctx).send(new ChangeResourceRecordSetsCommand({ HostedZoneId: zoneId, ChangeBatch: { Changes: [{ Action: 'DELETE', ResourceRecordSet: { Name: name, Type: rtype as never, TTL: current.props.ttl as number, ResourceRecords: (current.props.values as string[]).map((Value) => ({ Value })) } }] } }));
          return { done: false, operation: this.handle('delete', current, 'aws-route53-change', r.ChangeInfo!.Id!), ...rid(r) };
        }
      }
    } catch (err) {
      return gone(err);
    }
    throw new CloudUnsupported('aws', ref.type, 'not_yet', 'delete');
  }

  async poll(ctx: CallContext, h: OperationHandle): Promise<PollResult> {
    if (h.provider !== 'aws') throw new CloudProviderError('That operation is not an AWS one.', 'aws', 400, 'wrong_provider');
    if (isKubeType(h.type)) return this.kube.poll(ctx, h);
    if (h.type === 'cache') return this.caches.poll(ctx, h);
    if (h.type === 'database') return this.rdsModule.poll(ctx, h);
    if (h.kind === 'aws-ecs') return this.compute.pollService(ctx, h, (op, ref, kind, token) => this.handle(op, ref, kind, token));
    if (h.kind === 'aws-route53-change') {
      const r = await this.r53(ctx).send(new GetChangeCommand({ Id: h.token })).catch((err) => {
        throw awsError(err);
      });
      if (r.ChangeInfo?.Status !== 'INSYNC') return { state: 'pending', waitMs: 2000 };
      return { state: 'succeeded', resource: h.op === 'delete' ? null : await this.describe(ctx, h.ref) };
    }
    const o = await this.describe(ctx, h.ref);
    if (h.op === 'delete') return o ? { state: 'pending', waitMs: 2000 } : { state: 'succeeded', resource: null };
    if (!o) return { state: 'failed', error: `${h.ref.providerId} disappeared while it was being created.`, code: 'not_found' };
    if (o.state === 'failed') return { state: 'failed', error: `${h.ref.providerId} failed.` };
    return o.state === 'ready' ? { state: 'succeeded', resource: o } : { state: 'pending', waitMs: 1000 };
  }

  /** B-10204: the installer's lines on the instance's console (`GetConsoleOutput`). */
  async vmInstallStatus(ctx: CallContext, ref: ResourceRef): Promise<InstallStatus> {
    return this.compute.installStatus(ctx, ref);
  }

  // ---------- helpers ----------

  private handle(op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string): OperationHandle {
    return { provider: 'aws', type: ref.type, op, kind, ref: { type: ref.type, providerId: ref.providerId, ...(ref.region ? { region: ref.region } : {}), ...(ref.locator ? { locator: ref.locator } : {}) }, token, startedAt: Date.now() };
  }

  bucketName(account: CloudAccount, spec: ResourceSpec<'bucket'>): string {
    const n = (spec.props.bucketName ?? `${namePrefix(account.name)}${spec.name}`).toLowerCase();
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(n)) throw new CloudProviderError(`${n} is not a valid S3 bucket name.`, 'aws', 400, 'invalid_name');
    return n;
  }

  private async listEc2(ctx: CallContext, type: 'network' | 'subnet' | 'firewall', filters: Filter[], region?: string): Promise<ObservedResource[]> {
    const ec2 = this.ec2(ctx, region);
    const out: ObservedResource[] = [];
    let token: string | undefined;
    try {
      do {
        const args = { ...(filters.length ? { Filters: filters } : {}), ...(token ? { NextToken: token } : {}) };
        if (type === 'network') {
          const r = await ec2.send(new DescribeVpcsCommand(args));
          out.push(...(r.Vpcs ?? []).map((v) => vpcObserved(v, region)));
          token = r.NextToken;
        } else if (type === 'subnet') {
          const r = await ec2.send(new DescribeSubnetsCommand(args));
          out.push(...(r.Subnets ?? []).map((s) => subnetObserved(s, region)));
          token = r.NextToken;
        } else {
          const r = await ec2.send(new DescribeSecurityGroupsCommand(args));
          out.push(...(r.SecurityGroups ?? []).map((g) => sgObserved(g, region)));
          token = r.NextToken;
        }
      } while (token);
    } catch (err) {
      const e = awsError(err);
      if (/NotFound/.test(e.code ?? '')) return [];
      throw e;
    }
    return out;
  }

  private async reconcileIngress(ctx: CallContext, group: ResourceRef, desired: FirewallRule[], region?: string): Promise<void> {
    const ec2 = this.ec2(ctx, region ?? group.region);
    const current = (await this.describe(ctx, group))?.props.ingress as FirewallRule[] | undefined;
    const key = (r: FirewallRule) => `${r.protocol}|${r.ports ?? ''}|${[...r.sources].sort().join(',')}`;
    const want = new Map(desired.flatMap(splitSources).map((r) => [key(r), r]));
    const have = new Map((current ?? []).flatMap(splitSources).map((r) => [key(r), r]));
    const add = [...want.entries()].filter(([k]) => !have.has(k)).map(([, r]) => r);
    const remove = [...have.entries()].filter(([k]) => !want.has(k)).map(([, r]) => r);
    try {
      if (add.length) await ec2.send(new AuthorizeSecurityGroupIngressCommand({ GroupId: group.providerId, IpPermissions: add.map(toIpPermission) }));
      if (remove.length) await ec2.send(new RevokeSecurityGroupIngressCommand({ GroupId: group.providerId, IpPermissions: remove.map(toIpPermission) }));
    } catch (err) {
      const e = awsError(err);
      if (e.code !== 'InvalidPermission.Duplicate') throw e;
    }
  }

  private async zoneId(ctx: CallContext, zone: string): Promise<string> {
    if (/^Z[A-Z0-9]{4,}$/.test(zone)) return zone;
    const want = fqdnOf(zone);
    let marker: string | undefined;
    do {
      const r = await this.r53(ctx).send(new ListHostedZonesCommand({ ...(marker ? { Marker: marker } : {}) })).catch((err) => {
        throw awsError(err);
      });
      const z = (r.HostedZones ?? []).find((x) => fqdnOf(x.Name) === want && !x.Config?.PrivateZone);
      if (z) return z.Id!.replace(/^\/hostedzone\//, '');
      marker = r.IsTruncated ? r.NextMarker : undefined;
    } while (marker);
    throw new CloudProviderError(`No Route 53 hosted zone ${zone} in this account.`, 'aws', 404, 'zone_not_found');
  }

  private async changeRecord(ctx: CallContext, spec: ResourceSpec<'dns_record'>, action: 'CREATE' | 'UPSERT'): Promise<OperationResult> {
    const p = spec.props;
    const zoneId = await this.zoneId(ctx, p.zone);
    const name = fqdn(p.record, p.zone);
    const set: ResourceRecordSet = { Name: name, Type: p.recordType as never, TTL: p.ttl ?? 300, ResourceRecords: p.values.map((Value) => ({ Value: p.recordType === 'TXT' && !Value.startsWith('"') ? `"${Value}"` : Value })) };
    try {
      const r = await this.r53(ctx).send(new ChangeResourceRecordSetsCommand({ HostedZoneId: zoneId, ChangeBatch: { Comment: `exprsn-ai ${spec.idempotencyKey}`.slice(0, 256), Changes: [{ Action: action, ResourceRecordSet: set }] } }));
      const ref: ResourceRef = { type: 'dns_record', providerId: recordId(zoneId, name, p.recordType), locator: { zoneId } };
      return { done: false, operation: this.handle(action === 'CREATE' ? 'create' : 'update', ref, 'aws-route53-change', r.ChangeInfo!.Id!), ...rid(r) };
    } catch (err) {
      const e = awsError(err);
      // A create that an earlier attempt already made: the set exists with this name and type, so it is adopted.
      if (action === 'CREATE' && e.code === 'InvalidChangeBatch' && /already exists/.test(e.message)) {
        const found = await this.describe(ctx, { type: 'dns_record', providerId: recordId(zoneId, name, p.recordType), locator: { zoneId } });
        if (found) return { done: true, resource: found, adopted: true };
      }
      throw e;
    }
  }
}

// ---------- mapping ----------

/** One CloudTrail `LookupEvents` event (the record itself is a JSON string in `CloudTrailEvent`). */
interface CloudTrailEvent { EventId?: string; EventName?: string; ReadOnly?: string; Username?: string; EventTime?: number | string; EventSource?: string; CloudTrailEvent?: string }

/** A CloudTrail event as a change, or null for a read. The principal is the caller's ARN, else its user name. */
function trailEvent(e: CloudTrailEvent): ChangeEvent | null {
  let rec: { readOnly?: boolean; sourceIPAddress?: string; userIdentity?: { arn?: string; type?: string; userName?: string; invokedBy?: string } } = {};
  try {
    rec = e.CloudTrailEvent ? (JSON.parse(e.CloudTrailEvent) as typeof rec) : {};
  } catch {
    /* a record CloudTrail did not give as JSON: the summary fields still say who */
  }
  if (e.ReadOnly === 'true' || rec.readOnly === true) return null;
  const at = typeof e.EventTime === 'number' ? e.EventTime * 1000 : Date.parse(String(e.EventTime ?? ''));
  const principal = rec.userIdentity?.arn ?? e.Username ?? rec.userIdentity?.userName ?? rec.userIdentity?.invokedBy;
  if (!Number.isFinite(at) || !principal) return null;
  return { at, principal, principalType: rec.userIdentity?.type ?? null, action: e.EventName ?? 'unknown', source: e.EventSource ?? 'cloudtrail', eventId: e.EventId ?? null, sourceIp: rec.sourceIPAddress ?? null };
}

const rid = (r: { $metadata?: { requestId?: string } }) => (r.$metadata?.requestId ? { requestId: r.$metadata.requestId } : {});

/** An SDK error as a `CloudProviderError` (code, status and request id; never the request). */
export function awsError(err: unknown): CloudProviderError {
  if (err instanceof CloudProviderError) return err;
  const e = (err ?? {}) as { name?: string; Code?: string; message?: string; $metadata?: { httpStatusCode?: number; requestId?: string }; $retryable?: { throttling?: boolean } };
  const status = e.$metadata?.httpStatusCode ?? 502;
  const code = e.Code ?? e.name ?? null;
  const throttled = status === 429 || e.$retryable?.throttling === true || /Throttl|RequestLimitExceeded|SlowDown|TooManyRequests/.test(code ?? '');
  return new CloudProviderError(`AWS answered ${status}${code ? ` (${code})` : ''}: ${(e.message ?? 'no detail').slice(0, 300)}`, 'aws', throttled ? 429 : status, code, e.$metadata?.requestId ?? null, throttled ? 1 : null);
}

/** The IAM principal SimulatePrincipalPolicy takes for a caller (an assumed role's session becomes its role). */
export function policySourceArn(arn: string): string {
  const m = /^arn:(aws[\w-]*):sts::(\d{12}):assumed-role\/([^/]+)\/.+$/.exec(arn);
  return m ? `arn:${m[1]}:iam::${m[2]}:role/${m[3]}` : arn;
}

const toTags = (t: Record<string, string>): (Tag & { Key: string; Value: string })[] => Object.entries(t).map(([Key, Value]) => ({ Key, Value }));
const fromTags = (t: { Key?: string; Value?: string }[] | undefined): Record<string, string> => Object.fromEntries((t ?? []).filter((x) => x.Key).map((x) => [x.Key!, x.Value ?? '']));
/** Only the `exprsn:*` tags (the provider's `Name` tag stays out of the planner's view). */
const managedTags = (t: Record<string, string>) => Object.fromEntries(Object.entries(t).filter(([k]) => k.startsWith('exprsn:')));

const ec2State = (s: string | undefined): ObservedResource['state'] => (s === 'available' ? 'ready' : s === 'pending' ? 'creating' : s === 'deleting' ? 'deleting' : s === 'failed' ? 'failed' : 'ready');

function vpcObserved(v: Vpc, region?: string): ObservedResource {
  const tags = fromTags(v.Tags);
  return { type: 'network', providerId: v.VpcId!, name: tags[NAME_TAG] ?? v.VpcId!, ...(region ? { region } : {}), state: ec2State(v.State), tags: managedTags(tags), props: { cidr: v.CidrBlock } };
}

function subnetObserved(s: Subnet, region?: string): ObservedResource {
  const tags = fromTags(s.Tags);
  return { type: 'subnet', providerId: s.SubnetId!, name: tags[NAME_TAG] ?? s.SubnetId!, ...(region ? { region } : {}), state: ec2State(s.State), tags: managedTags(tags), props: { cidr: s.CidrBlock, zone: s.AvailabilityZone }, locator: { networkId: s.VpcId! } };
}

function sgObserved(g: SecurityGroup, region?: string): ObservedResource {
  const tags = fromTags(g.Tags);
  return { type: 'firewall', providerId: g.GroupId!, name: tags[NAME_TAG] ?? g.GroupName!, ...(region ? { region } : {}), state: 'ready', tags: managedTags(tags), props: { ingress: (g.IpPermissions ?? []).map(fromIpPermission), description: g.Description }, locator: { networkId: g.VpcId! } };
}

const splitSources = (r: FirewallRule): FirewallRule[] => r.sources.map((s) => ({ protocol: r.protocol, ...(r.ports ? { ports: r.ports } : {}), sources: [s] }));

function toIpPermission(r: FirewallRule): IpPermission {
  const [from, to] = (r.ports ?? '').split('-');
  const ports = r.protocol === 'tcp' || r.protocol === 'udp' ? { FromPort: Number(from || 0), ToPort: Number(to || from || 65535) } : r.protocol === 'icmp' ? { FromPort: -1, ToPort: -1 } : {};
  const v6 = r.sources.filter((s) => s.includes(':'));
  const v4 = r.sources.filter((s) => !s.includes(':'));
  return { IpProtocol: r.protocol === 'all' ? '-1' : r.protocol, ...ports, ...(v4.length ? { IpRanges: v4.map((CidrIp) => ({ CidrIp })) } : {}), ...(v6.length ? { Ipv6Ranges: v6.map((CidrIpv6) => ({ CidrIpv6 })) } : {}) };
}

function fromIpPermission(p: IpPermission): FirewallRule {
  const protocol = (p.IpProtocol === '-1' ? 'all' : p.IpProtocol) as FirewallRule['protocol'];
  const ports = protocol === 'tcp' || protocol === 'udp' ? (p.FromPort === p.ToPort ? String(p.FromPort) : `${p.FromPort}-${p.ToPort}`) : undefined;
  return { protocol, ...(ports ? { ports } : {}), sources: [...(p.IpRanges ?? []).map((x) => x.CidrIp!), ...(p.Ipv6Ranges ?? []).map((x) => x.CidrIpv6!)] };
}

const fqdnOf = (n: string | undefined) => `${(n ?? '').replace(/\.$/, '')}.`.toLowerCase();
const fqdn = (record: string, zone: string) => fqdnOf(record === '@' || record === '' ? zone : `${record}.${zone.replace(/\.$/, '')}`);
const recordId = (zoneId: string, name: string, type: string) => `${zoneId}/${name}/${type}`;
const splitRecordId = (id: string): [string, string, string] => {
  const [zoneId, name, type] = id.split('/');
  return [zoneId!, name!, type!];
};

function recordObserved(zoneId: string, set: ResourceRecordSet): ObservedResource {
  const name = fqdnOf(set.Name);
  const values = (set.ResourceRecords ?? []).map((r) => (set.Type === 'TXT' ? (r.Value ?? '').replace(/^"|"$/g, '') : r.Value!));
  return { type: 'dns_record', providerId: recordId(zoneId, name, set.Type!), name, state: 'ready', tags: {}, props: { record: name, recordType: set.Type, values, ttl: set.TTL } satisfies Partial<Record<keyof PropsByType['dns_record'], unknown>>, locator: { zoneId } };
}
