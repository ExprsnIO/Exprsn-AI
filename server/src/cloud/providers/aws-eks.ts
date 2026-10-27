import { createHash, createHmac } from 'node:crypto';
import { CreateLaunchTemplateCommand, DeleteLaunchTemplateCommand, DescribeLaunchTemplatesCommand, type EC2Client } from '@aws-sdk/client-ec2';
import { signV4 } from '../../platform/blob.js';
import { namePrefix } from '../tags.js';
import type { CloudAccount } from '../types.js';
import { clusterLoadBalancer, KUBE_TOKEN_SECONDS, nodeLabels, parseTaint } from './kubernetes.js';
import type { CloudTransport } from './transport.js';
import {
  CloudProviderError,
  type CallContext,
  type ClusterAccess,
  type ListFilter,
  type ObservedResource,
  type OperationHandle,
  type OperationResult,
  type PollResult,
  type ResourceRef,
  type ResourceSpec
} from './types.js';

/*
 * 1.9.99-final, Sprint 58 (B-10203): EKS through the AWS adapter, over EKS's REST API (JSON, SigV4 for `eks`) on the
 * adapter's transport, so every request goes through the egress guard and the rate limiter. (The AWS SDK's EKS client
 * is not a dependency of this build; the REST calls are few and stable.)
 *
 * - Clusters: `POST /clusters` with a client request token (the journal step's idempotency key, hashed), access
 *   entries (`authenticationMode: API`) with the creating role as cluster admin, the private subnets and the app
 *   zone's security group, the API endpoint private and public only to `apiCidrs`. Found again by name; followed by
 *   `DescribeCluster` until `ACTIVE`. The provider id is the cluster's name.
 * - Node groups: `POST /clusters/<name>/node-groups` (AL2023, NVIDIA AMI for GPU pools, labels and taints), changed in
 *   place with `update-config` (scaling, labels, taints); the provider id is `<cluster>/<node group>`. Since Sprint 59
 *   (B-10705) every node group is made from its own launch template (`<node group>-imds`, tagged like the group) whose
 *   only content is the metadata options: IMDSv2 required (`HttpTokens: required`), hop limit 1 (a pod that is not on
 *   the host network cannot reach the instance's credentials), instance tags off. The template goes when its group is
 *   deleted. A group made before Sprint 59 keeps the AMI's defaults until it is replaced.
 * - Access: a token the EKS authenticator accepts: a presigned STS `GetCallerIdentity` URL (60 s signature validity,
 *   the cluster's name in the signed `x-k8s-aws-id` header), `k8s-aws-v1.` + its base64url. EKS honours it for 15
 *   minutes; nothing is stored.
 *
 * The cluster and node IAM roles are not graph resources: by default `exprsn-<account>-eks-cluster` and
 * `exprsn-<account>-eks-node` in the account (the setup helper's job to list), or `clusterRoleArn` / `nodeRoleArn`.
 */

interface EksCluster { name: string; arn: string; status: string; version?: string; endpoint?: string; certificateAuthority?: { data?: string }; resourcesVpcConfig?: { subnetIds?: string[]; securityGroupIds?: string[]; endpointPublicAccess?: boolean; endpointPrivateAccess?: boolean; publicAccessCidrs?: string[]; vpcId?: string }; tags?: Record<string, string> }
interface EksNodegroup { nodegroupName: string; nodegroupArn?: string; clusterName: string; status: string; instanceTypes?: string[]; scalingConfig?: { minSize?: number; maxSize?: number; desiredSize?: number }; labels?: Record<string, string>; taints?: { key: string; value?: string; effect: string }[]; tags?: Record<string, string>; subnets?: string[]; launchTemplate?: { id?: string; name?: string; version?: string } }

export interface EksKeys {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const sha256 = (b: string) => createHash('sha256').update(b).digest('hex');
const hmac = (k: string | Buffer, d: string) => createHmac('sha256', k).update(d).digest();
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * The token the EKS authenticator (aws-iam-authenticator) accepts: a presigned `sts:GetCallerIdentity` GET with the
 * cluster's name in the signed `x-k8s-aws-id` header. Valid for 15 minutes after `now`.
 */
export function eksToken(o: { clusterName: string; region: string; keys: EksKeys; stsUrl: string; now?: Date }): { token: string; expiresAt: number; url: string } {
  const now = o.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const url = new URL('/', o.stsUrl);
  const scope = `${day}/${o.region}/sts/aws4_request`;
  const params: [string, string][] = [
    ['Action', 'GetCallerIdentity'],
    ['Version', '2011-06-15'],
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${o.keys.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', '60'],
    ['X-Amz-SignedHeaders', 'host;x-k8s-aws-id'],
    ...(o.keys.sessionToken ? ([['X-Amz-Security-Token', o.keys.sessionToken]] as [string, string][]) : [])
  ];
  const query = params
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = ['GET', '/', query, `host:${url.host}\nx-k8s-aws-id:${o.clusterName}\n`, 'host;x-k8s-aws-id', sha256('')].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${o.keys.secretAccessKey}`, day), o.region), 'sts'), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  const signed = `${url.origin}/?${query}&X-Amz-Signature=${signature}`;
  return { token: `k8s-aws-v1.${Buffer.from(signed).toString('base64url')}`, expiresAt: now.getTime() + 14 * 60_000, url: signed };
}

export interface EksDeps {
  transport: CloudTransport;
  /** The EKS endpoint for a region (tests: the fake). */
  endpoint(region: string): string;
  /** The STS endpoint a token is presigned for. */
  stsEndpoint(region: string): string;
  /** B-10705: the account's EC2 client, for the node groups' launch templates (IMDSv2, hop limit 1). */
  ec2?: (ctx: CallContext, region: string) => EC2Client;
}

/** B-10705: the metadata options every EKS node gets (the same as an EC2 instance's, `aws-compute.ts`). */
export const EKS_NODE_METADATA = { HttpTokens: 'required', HttpPutResponseHopLimit: 1, HttpEndpoint: 'enabled', InstanceMetadataTags: 'disabled' } as const;
const launchTemplateName = (group: string) => `${group}-imds`.slice(0, 128);

const clusterState = (s: string | undefined): ObservedResource['state'] => (s === 'ACTIVE' ? 'ready' : s === 'CREATING' || s === 'PENDING' ? 'creating' : s === 'UPDATING' ? 'updating' : s === 'DELETING' ? 'deleting' : s === 'FAILED' || s === 'CREATE_FAILED' || s === 'DEGRADED' || s === 'DELETE_FAILED' ? 'failed' : 'creating');
const managed = (t: Record<string, string> | undefined) => Object.fromEntries(Object.entries(t ?? {}).filter(([k]) => k.startsWith('exprsn:') && k !== 'exprsn:name'));
const EFFECT_TO_EKS: Record<string, string> = { NoSchedule: 'NO_SCHEDULE', PreferNoSchedule: 'PREFER_NO_SCHEDULE', NoExecute: 'NO_EXECUTE' };
const EFFECT_FROM_EKS: Record<string, string> = { NO_SCHEDULE: 'NoSchedule', PREFER_NO_SCHEDULE: 'PreferNoSchedule', NO_EXECUTE: 'NoExecute' };

function clusterObserved(c: EksCluster, region?: string): ObservedResource {
  return { type: 'kubernetes_cluster', providerId: c.name, name: c.tags?.['exprsn:name'] ?? c.name, ...(region ? { region } : {}), state: clusterState(c.status), tags: managed(c.tags), props: { version: c.version ?? null, endpoint: c.endpoint ?? null, status: c.status, privateEndpoint: !!c.resourcesVpcConfig?.endpointPrivateAccess, networkId: c.resourcesVpcConfig?.vpcId ?? null }, locator: { arn: c.arn } };
}

function groupObserved(g: EksNodegroup, region?: string): ObservedResource {
  const sc = g.scalingConfig ?? {};
  return {
    type: 'node_group',
    providerId: `${g.clusterName}/${g.nodegroupName}`,
    name: g.tags?.['exprsn:name'] ?? g.nodegroupName,
    ...(region ? { region } : {}),
    state: clusterState(g.status === 'CREATE_FAILED' ? 'FAILED' : g.status),
    tags: managed(g.tags),
    props: { size: g.instanceTypes?.[0] ?? null, count: sc.desiredSize ?? null, min: sc.minSize ?? null, max: sc.maxSize ?? null, launchTemplate: g.launchTemplate?.name ?? g.launchTemplate?.id ?? null, role: g.labels?.['exprsn.ai/role'] ?? null, taints: (g.taints ?? []).map((t) => `${t.key}${t.value ? `=${t.value}` : ''}:${EFFECT_FROM_EKS[t.effect] ?? t.effect}`) },
    locator: { cluster: g.clusterName, ...(g.nodegroupArn ? { arn: g.nodegroupArn } : {}) }
  };
}

const splitGroup = (id: string): [string, string] => {
  const i = id.indexOf('/');
  if (i < 0) throw new CloudProviderError(`${id} is not an EKS node group id (<cluster>/<node group>).`, 'aws', 400, 'bad_id');
  return [id.slice(0, i), id.slice(i + 1)];
};

/** A client request token from the step's idempotency key (EKS takes at most 64 characters). */
const clientToken = (key: string) => sha256(key).slice(0, 36);

export class EksResources {
  constructor(private readonly d: EksDeps) {}

  private keys(ctx: CallContext): EksKeys {
    if (ctx.cred.kind !== 'aws') throw new CloudProviderError('An AWS account needs an AWS credential.', 'aws', 400, 'wrong_credential');
    return { accessKeyId: ctx.cred.accessKeyId, secretAccessKey: ctx.cred.secretAccessKey, ...(ctx.cred.sessionToken ? { sessionToken: ctx.cred.sessionToken } : {}) };
  }

  private regionOf(ctx: CallContext, r?: { region?: string }): string {
    return r?.region ?? ctx.region ?? ctx.account.defaultRegion ?? 'us-east-1';
  }

  /** One signed EKS call. A 404 answers null. */
  private async call<T>(ctx: CallContext, region: string, method: string, path: string, body?: unknown): Promise<{ body: T; requestId: string | null } | null> {
    const keys = this.keys(ctx);
    const url = new URL(path, `${this.d.endpoint(region).replace(/\/$/, '')}/`);
    const payload = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = { 'content-type': 'application/json', ...(keys.sessionToken ? { 'x-amz-security-token': keys.sessionToken } : {}) };
    const signed = signV4({ method, url, headers, payloadHash: sha256(payload), region, service: 'eks', accessKeyId: keys.accessKeyId, secretAccessKey: keys.secretAccessKey, date: new Date() });
    delete signed.host;
    try {
      const r = await this.d.transport.json<T>({ method, url, headers: signed, ...(body === undefined ? {} : { body: payload }), accountId: ctx.account.id, ...(ctx.signal ? { signal: ctx.signal } : {}) }, (status, b) => {
        const e = (b ?? {}) as { message?: string; __type?: string };
        return { message: `EKS answered ${status}${e.__type ? ` (${e.__type})` : ''}: ${(e.message ?? 'no detail').slice(0, 300)}`, code: e.__type ?? null };
      });
      return { body: r.body, requestId: r.requestId };
    } catch (err) {
      if (err instanceof CloudProviderError && err.status === 404) return null;
      throw err;
    }
  }

  private clusterName(account: CloudAccount, name: string): string {
    return `${namePrefix(account.name)}${name}`.slice(0, 100);
  }

  private roleArn(account: CloudAccount, kind: 'cluster' | 'node', given?: string): string {
    if (given) return given;
    const id = account.providerIds.awsAccountId;
    if (!id) throw new CloudProviderError(`${account.name} has no AWS account id, so the EKS ${kind} role cannot be named; give ${kind === 'cluster' ? 'clusterRoleArn' : 'nodeRoleArn'}.`, 'aws', 400, 'eks_role_missing');
    return `arn:aws:iam::${id}:role/exprsn-${account.name}-eks-${kind}`;
  }

  private handle(op: OperationHandle['op'], ref: ResourceRef): OperationHandle {
    return { provider: 'aws', type: ref.type, op, kind: 'describe', ref: { type: ref.type, providerId: ref.providerId, ...(ref.region ? { region: ref.region } : {}) }, token: ref.providerId, startedAt: Date.now() };
  }

  private refs(spec: ResourceSpec, keys: string[] | undefined, what: string): string[] {
    const out = (keys ?? []).map((k) => spec.parent?.refs?.[k]).filter((x): x is string => !!x);
    if (!out.length) throw new CloudProviderError(`${spec.name} needs its ${what} (their provider ids in parent.refs).`, 'aws', 400, 'parent_required');
    return out;
  }

  async find(ctx: CallContext, spec: ResourceSpec): Promise<ObservedResource | null> {
    if (spec.type === 'load_balancer') return clusterLoadBalancer.find('aws', spec);
    const region = this.regionOf(ctx, spec);
    if (spec.type === 'kubernetes_cluster') return this.describe(ctx, { type: 'kubernetes_cluster', providerId: this.clusterName(ctx.account, spec.name), region });
    const cluster = spec.parent?.refs?.cluster;
    if (!cluster) return null;
    return this.describe(ctx, { type: 'node_group', providerId: `${cluster}/${this.clusterName(ctx.account, spec.name).slice(0, 63)}`, region });
  }

  async describe(ctx: CallContext, ref: ResourceRef): Promise<ObservedResource | null> {
    if (ref.type === 'load_balancer') return clusterLoadBalancer.describe(ref);
    const region = this.regionOf(ctx, ref);
    if (ref.type === 'kubernetes_cluster') {
      const r = await this.call<{ cluster: EksCluster }>(ctx, region, 'GET', `/clusters/${encodeURIComponent(ref.providerId)}`);
      return r ? clusterObserved(r.body.cluster, region) : null;
    }
    const [c, g] = splitGroup(ref.providerId);
    const r = await this.call<{ nodegroup: EksNodegroup }>(ctx, region, 'GET', `/clusters/${encodeURIComponent(c)}/node-groups/${encodeURIComponent(g)}`);
    return r ? groupObserved(r.body.nodegroup, region) : null;
  }

  async list(ctx: CallContext, type: 'kubernetes_cluster' | 'node_group' | 'load_balancer', filter: ListFilter = {}): Promise<ObservedResource[]> {
    if (type === 'load_balancer') return [];
    const region = this.regionOf(ctx);
    const names = (await this.call<{ clusters: string[] }>(ctx, region, 'GET', '/clusters'))?.body.clusters ?? [];
    const prefix = namePrefix(ctx.account.name);
    const out: ObservedResource[] = [];
    for (const n of names.filter((x) => !filter.managedOnly || x.startsWith(prefix))) {
      const c = await this.describe(ctx, { type: 'kubernetes_cluster', providerId: n, region });
      if (!c || (filter.managedOnly && c.tags['exprsn:account'] !== ctx.account.name) || (filter.networkId && c.props.networkId !== filter.networkId)) continue;
      if (type === 'kubernetes_cluster') out.push(c);
      else for (const g of (await this.call<{ nodegroups: string[] }>(ctx, region, 'GET', `/clusters/${encodeURIComponent(n)}/node-groups`))?.body.nodegroups ?? []) {
        const o = await this.describe(ctx, { type: 'node_group', providerId: `${n}/${g}`, region });
        if (o) out.push(o);
      }
    }
    return out;
  }

  async create(ctx: CallContext, spec: ResourceSpec): Promise<OperationResult> {
    if (spec.type === 'load_balancer') return clusterLoadBalancer.create('aws', spec);
    const existing = await this.find(ctx, spec);
    // A node group the cluster was made with (AKS, DOKS) or an earlier attempt made: adopted, and brought to its spec at once.
    if (existing && spec.type === 'node_group') return { ...(await this.update(ctx, existing, spec)), adopted: true };
    if (existing) return existing.state === 'ready' ? { done: true, resource: existing, adopted: true } : { done: false, operation: this.handle('create', existing), resource: existing, adopted: true };
    const region = this.regionOf(ctx, spec);
    const tags = { ...spec.tags, 'exprsn:name': spec.name };
    if (spec.type === 'kubernetes_cluster') {
      const p = (spec as ResourceSpec<'kubernetes_cluster'>).props;
      const name = this.clusterName(ctx.account, spec.name);
      const body = {
        name,
        ...(p.version ? { version: p.version } : {}),
        roleArn: this.roleArn(ctx.account, 'cluster', p.clusterRoleArn),
        resourcesVpcConfig: { subnetIds: this.refs(spec, p.subnets, 'subnets'), ...(p.firewall && spec.parent?.refs?.[p.firewall] ? { securityGroupIds: [spec.parent.refs[p.firewall]!] } : {}), endpointPrivateAccess: p.privateEndpoint !== false, endpointPublicAccess: true, publicAccessCidrs: p.apiCidrs?.length ? p.apiCidrs : ['0.0.0.0/0'] },
        accessConfig: { authenticationMode: 'API', bootstrapClusterCreatorAdminPermissions: true },
        tags,
        clientRequestToken: clientToken(spec.idempotencyKey)
      };
      const r = await this.call<{ cluster: EksCluster }>(ctx, region, 'POST', '/clusters', body).catch(async (err) => {
        // Two attempts racing: the name is taken by the other one's cluster, which is ours.
        if (err instanceof CloudProviderError && err.code === 'ResourceInUseException') return null;
        throw err;
      });
      const o = r ? clusterObserved(r.body.cluster, region) : await this.describe(ctx, { type: 'kubernetes_cluster', providerId: name, region });
      if (!o) throw new CloudProviderError(`EKS accepted ${name} but does not describe it.`, 'aws', 502, 'not_found');
      return o.state === 'ready' ? { done: true, resource: o, ...(r?.requestId ? { requestId: r.requestId } : {}), ...(r ? {} : { adopted: true }) } : { done: false, operation: this.handle('create', o), resource: o, ...(r?.requestId ? { requestId: r.requestId } : {}) };
    }
    const p = (spec as ResourceSpec<'node_group'>).props;
    const cluster = spec.parent?.refs?.cluster;
    if (!cluster) throw new CloudProviderError('A node group needs its cluster (parent.refs.cluster).', 'aws', 400, 'parent_required');
    const ng = this.clusterName(ctx.account, spec.name).slice(0, 63);
    const min = p.min ?? p.count ?? 1;
    const lt = await this.launchTemplate(ctx, region, ng, tags);
    const body = {
      nodegroupName: ng,
      ...(lt ? { launchTemplate: { id: lt.id, version: lt.version } } : {}),
      scalingConfig: { minSize: min, maxSize: Math.max(1, p.max ?? min), desiredSize: Math.max(min, p.count ?? min) },
      subnets: this.refs(spec, p.subnets, 'subnets'),
      instanceTypes: [p.size],
      nodeRole: this.roleArn(ctx.account, 'node', p.nodeRoleArn),
      amiType: p.gpu ? 'AL2023_x86_64_NVIDIA' : 'AL2023_x86_64_STANDARD',
      capacityType: p.purchase === 'spot' ? 'SPOT' : 'ON_DEMAND', // B-10403: EC2 Spot
      labels: nodeLabels(spec as ResourceSpec<'node_group'>),
      ...(p.taints?.length ? { taints: p.taints.map(parseTaint).map((t) => ({ key: t.key, ...(t.value ? { value: t.value } : {}), effect: EFFECT_TO_EKS[t.effect] })) } : {}),
      tags,
      clientRequestToken: clientToken(spec.idempotencyKey)
    };
    const r = await this.call<{ nodegroup: EksNodegroup }>(ctx, region, 'POST', `/clusters/${encodeURIComponent(cluster)}/node-groups`, body).catch((err) => {
      if (err instanceof CloudProviderError && err.code === 'ResourceInUseException') return null;
      throw err;
    });
    const o = r ? groupObserved(r.body.nodegroup, region) : await this.describe(ctx, { type: 'node_group', providerId: `${cluster}/${ng}`, region });
    if (!o) throw new CloudProviderError(`EKS accepted ${ng} but does not describe it.`, 'aws', 502, 'not_found');
    return o.state === 'ready' ? { done: true, resource: o } : { done: false, operation: this.handle('create', o), resource: o, ...(r?.requestId ? { requestId: r.requestId } : {}) };
  }

  async update(ctx: CallContext, ref: ResourceRef, spec: ResourceSpec): Promise<OperationResult> {
    if (ref.type === 'load_balancer') return clusterLoadBalancer.update('aws', ref, spec);
    const region = this.regionOf(ctx, ref);
    const current = await this.describe(ctx, ref);
    if (!current) throw new CloudProviderError(`${ref.providerId} no longer exists.`, 'aws', 404, 'not_found');
    const arn = current.locator?.arn;
    if (arn) await this.call(ctx, region, 'POST', `/tags/${encodeURIComponent(arn)}`, { tags: { ...spec.tags, 'exprsn:name': spec.name } });
    if (ref.type === 'kubernetes_cluster') return { done: true, resource: await this.describe(ctx, ref) };
    const p = (spec as ResourceSpec<'node_group'>).props;
    const [c, g] = splitGroup(ref.providerId);
    const min = p.min ?? p.count ?? 1;
    const want = (p.taints ?? []).map(parseTaint);
    const have = ((current.props.taints as string[] | undefined) ?? []).map(parseTaint);
    const key = (t: { key: string; value: string; effect: string }) => `${t.key}=${t.value}:${t.effect}`;
    const body = {
      scalingConfig: { minSize: min, maxSize: Math.max(1, p.max ?? min), desiredSize: Math.max(min, p.count ?? min) },
      labels: { addOrUpdateLabels: nodeLabels(spec as ResourceSpec<'node_group'>) },
      taints: { addOrUpdateTaints: want.map((t) => ({ key: t.key, ...(t.value ? { value: t.value } : {}), effect: EFFECT_TO_EKS[t.effect] })), removeTaints: have.filter((h) => !want.some((w) => key(w) === key(h))).map((t) => ({ key: t.key, ...(t.value ? { value: t.value } : {}), effect: EFFECT_TO_EKS[t.effect] })) }
    };
    const r = await this.call<{ update?: { id: string; status: string } }>(ctx, region, 'POST', `/clusters/${encodeURIComponent(c)}/node-groups/${encodeURIComponent(g)}/update-config`, body);
    const o = await this.describe(ctx, ref);
    if (o && o.state === 'ready' && r?.body.update?.status !== 'InProgress') return { done: true, resource: o };
    return { done: false, operation: this.handle('update', ref), ...(o ? { resource: o } : {}) };
  }

  async delete(ctx: CallContext, ref: ResourceRef): Promise<OperationResult> {
    if (ref.type === 'load_balancer') return clusterLoadBalancer.delete();
    const region = this.regionOf(ctx, ref);
    const path = ref.type === 'kubernetes_cluster' ? `/clusters/${encodeURIComponent(ref.providerId)}` : (() => {
      const [c, g] = splitGroup(ref.providerId);
      return `/clusters/${encodeURIComponent(c)}/node-groups/${encodeURIComponent(g)}`;
    })();
    const r = await this.call(ctx, region, 'DELETE', path);
    if (!r) {
      await this.dropLaunchTemplate(ctx, ref);
      return { done: true, resource: null };
    }
    return { done: false, operation: this.handle('delete', ref), ...(r.requestId ? { requestId: r.requestId } : {}) };
  }

  /**
   * B-10705: the node group's launch template (IMDSv2 required, hop limit 1), made once and found again by name on a
   * retry. Null only when the adapter was built without an EC2 client (a test of the EKS calls alone).
   */
  private async launchTemplate(ctx: CallContext, region: string, group: string, tags: Record<string, string>): Promise<{ id: string; version: string } | null> {
    if (!this.d.ec2) return null;
    const ec2 = this.d.ec2(ctx, region);
    const name = launchTemplateName(group);
    const found = async () => {
      const r = await ec2.send(new DescribeLaunchTemplatesCommand({ LaunchTemplateNames: [name] })).catch((err: { name?: string }) => {
        if (/NotFound/.test(err.name ?? '')) return null;
        throw err;
      });
      const t = r?.LaunchTemplates?.[0];
      return t?.LaunchTemplateId ? { id: t.LaunchTemplateId, version: String(t.LatestVersionNumber ?? 1) } : null;
    };
    const have = await found();
    if (have) return have;
    try {
      const r = await ec2.send(
        new CreateLaunchTemplateCommand({
          LaunchTemplateName: name,
          ClientToken: clientToken(`${group}|launch-template`),
          LaunchTemplateData: { MetadataOptions: { ...EKS_NODE_METADATA } },
          TagSpecifications: [{ ResourceType: 'launch-template', Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) }]
        })
      );
      if (r.LaunchTemplate?.LaunchTemplateId) return { id: r.LaunchTemplate.LaunchTemplateId, version: String(r.LaunchTemplate.LatestVersionNumber ?? 1) };
    } catch (err) {
      if (!/AlreadyExists/.test((err as { name?: string }).name ?? '')) throw new CloudProviderError(`EC2 refused the node group's launch template: ${(err as Error).message}`, 'aws', 502, (err as { name?: string }).name ?? null);
    }
    const again = await found();
    if (!again) throw new CloudProviderError(`EC2 made ${name} but does not describe it.`, 'aws', 502, 'not_found');
    return again;
  }

  /** Deletes a deleted node group's launch template (best effort: a leftover template costs nothing and the orphan sweep finds it). */
  private async dropLaunchTemplate(ctx: CallContext, ref: ResourceRef): Promise<void> {
    if (!this.d.ec2 || ref.type !== 'node_group') return;
    const [, g] = splitGroup(ref.providerId);
    await this.d.ec2(ctx, this.regionOf(ctx, ref)).send(new DeleteLaunchTemplateCommand({ LaunchTemplateName: launchTemplateName(g) })).catch(() => undefined);
  }

  async poll(ctx: CallContext, h: OperationHandle): Promise<PollResult> {
    const o = await this.describe(ctx, h.ref);
    if (h.op === 'delete' && !o) await this.dropLaunchTemplate(ctx, h.ref);
    if (h.op === 'delete') return o ? { state: 'pending', waitMs: 10_000 } : { state: 'succeeded', resource: null };
    if (!o) return { state: 'failed', error: `${h.ref.providerId} disappeared.`, code: 'not_found' };
    if (o.state === 'failed') return { state: 'failed', error: `${h.ref.providerId} is ${String(o.props.status ?? 'FAILED')}.`, code: 'eks_failed' };
    return o.state === 'ready' ? { state: 'succeeded', resource: o } : { state: 'pending', waitMs: 10_000 };
  }

  /** The cluster's endpoint and CA, and a token from a presigned `GetCallerIdentity` (15 minutes). */
  async access(ctx: CallContext, ref: ResourceRef): Promise<ClusterAccess> {
    const region = this.regionOf(ctx, ref);
    const c = await this.call<{ cluster: EksCluster }>(ctx, region, 'GET', `/clusters/${encodeURIComponent(ref.providerId)}`);
    if (!c?.body.cluster.endpoint) throw new CloudProviderError(`${ref.providerId} has no API endpoint yet.`, 'aws', 409, 'cluster_not_ready');
    const t = eksToken({ clusterName: c.body.cluster.name, region, keys: this.keys(ctx), stsUrl: this.d.stsEndpoint(region) });
    return { server: c.body.cluster.endpoint, caData: c.body.cluster.certificateAuthority?.data ?? null, token: t.token, expiresAt: Math.min(t.expiresAt, Date.now() + KUBE_TOKEN_SECONDS * 1000 + 5 * 60_000), clusterName: c.body.cluster.name };
  }
}
