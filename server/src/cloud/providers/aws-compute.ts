import { createHash } from 'node:crypto';
import { CreateTagsCommand, DescribeInstancesCommand, type EC2Client, GetConsoleOutputCommand, ModifyInstanceMetadataOptionsCommand, RunInstancesCommand, TerminateInstancesCommand, type Instance, type _InstanceType } from '@aws-sdk/client-ec2';
import { signV4 } from '../../platform/blob.js';
import { bootstrapUserData, fileName, installStatusFrom } from '../compute.js';
import { xmlText } from '../credential-http.js';
import { namePrefix } from '../tags.js';
import type { CloudTransport } from './transport.js';
import { CloudProviderError, type CallContext, type ContainerServiceProps, type InstallStatus, type ObservedResource, type OperationHandle, type OperationResult, type PollResult, type PropsByType, type ResourceRef, type ResourceSpec } from './types.js';

/*
 * 1.9.99-final, Sprint 58 (B-10204, B-10205): the AWS adapter's compute: EC2 instances for the VM target and ECS on
 * Fargate for the container target. `aws.ts` delegates its `vm` and `container_service` cases here.
 *
 * EC2 (`vm`): RunInstances with the step's idempotency key as `ClientToken`, IMDSv2 required with a hop limit of 1
 * (`MetadataOptions`), no public address, an encrypted root volume, Ubuntu 24.04 from Canonical's public SSM
 * parameter, the cloud-init user data with the single-use wrapped token put in at create time, and the `exprsn:*`
 * tags on the instance and its volume. Described until `running`; `GetConsoleOutput` gives the installer's lines.
 *
 * ECS (`container_service`): a cluster, the secrets in Secrets Manager (values from the engine's broker, sent only
 * to AWS; the task definition names their ARNs), the service's own ALB (load balancer, target group on `/readyz`,
 * listener: HTTPS with the certificate when there is one, HTTP for an internal one), a task definition with
 * settings in `environment` and secrets in `secrets` (never DATA_KEY: the key-encryption key stays in OpenBao), the
 * migration as a one-off `RunTask` with the command overridden, and then the service. The phases are one
 * long-running operation (`aws-ecs`, the phase in the token as JSON). Calls go through `CloudTransport` signed with
 * SigV4 (`platform/blob.ts`); the SDK is used for EC2 only.
 */

export interface AwsComputeHost {
  transport: CloudTransport;
  ec2(ctx: CallContext, region?: string): EC2Client;
  endpoint(service: 'ecs' | 'elbv2' | 'secretsmanager', region: string): string;
  region(ctx: CallContext, spec?: { region?: string }): string;
}

const NAME_TAG = 'exprsn:name';
const ECS_TARGET = 'AmazonEC2ContainerServiceV20141113';
const ELB_VERSION = '2015-12-01';
const UBUNTU_AMI = 'resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const token64 = (s: string) => sha(s).slice(0, 64);
const toTags = (t: Record<string, string>) => Object.entries(t).map(([Key, Value]) => ({ Key, Value }));
const managed = (t: Record<string, string>) => Object.fromEntries(Object.entries(t).filter(([k]) => k.startsWith('exprsn:')));

interface EcsPhase {
  phase: 'migrate' | 'service' | 'delete';
  then?: 'create' | 'update';
  cluster: string;
  service: string;
  taskDefinition?: string;
  taskArn?: string;
  targetGroupArn?: string | null;
  subnets?: string[];
  securityGroups?: string[];
  desired?: number;
  clientToken?: string;
  tags?: Record<string, string>;
  left?: string[];
}

export class AwsCompute {
  constructor(private readonly h: AwsComputeHost) {}

  // ---------- EC2 (B-10204) ----------

  async findVm(ctx: CallContext, spec: ResourceSpec): Promise<ObservedResource | null> {
    const list = await this.describeInstances(ctx, { Filters: [{ Name: `tag:${NAME_TAG}`, Values: [spec.name] }, { Name: 'tag:exprsn:account', Values: [ctx.account.name] }, { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] }] }, spec.region);
    return list[0] ?? null;
  }

  async describeVm(ctx: CallContext, ref: ResourceRef): Promise<ObservedResource | null> {
    const list = await this.describeInstances(ctx, { InstanceIds: [ref.providerId] }, ref.region);
    return list[0] ?? null;
  }

  async listVms(ctx: CallContext, filter: { managedOnly?: boolean; networkId?: string }): Promise<ObservedResource[]> {
    const Filters = [{ Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] }, ...(filter.managedOnly ? [{ Name: 'tag:exprsn:managed', Values: ['true'] }, { Name: 'tag:exprsn:account', Values: [ctx.account.name] }] : []), ...(filter.networkId ? [{ Name: 'vpc-id', Values: [filter.networkId] }] : [])];
    return this.describeInstances(ctx, { Filters }, ctx.region);
  }

  private async describeInstances(ctx: CallContext, input: ConstructorParameters<typeof DescribeInstancesCommand>[0], region?: string): Promise<ObservedResource[]> {
    const out: ObservedResource[] = [];
    let next: string | undefined;
    try {
      do {
        const r = await this.h.ec2(ctx, region).send(new DescribeInstancesCommand({ ...input, ...(next ? { NextToken: next } : {}) }));
        for (const res of r.Reservations ?? []) for (const i of res.Instances ?? []) if (i.State?.Name !== 'terminated') out.push(instanceObserved(i, region ?? ctx.region));
        next = r.NextToken;
      } while (next);
    } catch (err) {
      const e = ec2Err(err);
      if (/InvalidInstanceID\.(NotFound|Malformed)/.test(e.code ?? '')) return [];
      throw e;
    }
    return out;
  }

  async createVm(ctx: CallContext, spec: ResourceSpec<'vm'>, handle: (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string) => OperationHandle): Promise<OperationResult> {
    const existing = await this.findVm(ctx, spec);
    if (existing) return existing.state === 'ready' ? { done: true, resource: existing, adopted: true } : { done: false, operation: handle('create', existing, 'aws-describe', existing.providerId), resource: existing, adopted: true };
    const p = spec.props;
    const region = this.h.region(ctx, spec);
    const refs = spec.parent?.refs ?? {};
    const subnet = p.subnet ? refs[p.subnet] : undefined;
    const sg = p.firewall ? refs[p.firewall] : undefined;
    if (p.imdsV2 === false) throw new CloudProviderError('An EC2 instance is created with IMDSv2 required; imdsV2: false is refused.', 'aws', 400, 'imds_required');
    const userData = await bootstrapUserData(p.userData, p.secrets, ctx.secrets);
    const modelVolume = (p as { modelVolume?: { snapshotId?: string } }).modelVolume;
    const tags = toTags({ ...spec.tags, [NAME_TAG]: spec.name, Name: `${namePrefix(ctx.account.name)}${spec.name}` });
    try {
      const r = await this.h.ec2(ctx, region).send(
        new RunInstancesCommand({
          ImageId: /^ami-/.test(p.image) ? p.image : UBUNTU_AMI,
          InstanceType: p.size as _InstanceType,
          MinCount: 1,
          MaxCount: 1,
          ClientToken: token64(spec.idempotencyKey),
          ...(subnet ? { SubnetId: subnet } : {}),
          ...(sg ? { SecurityGroupIds: [sg] } : {}),
          ...(userData ? { UserData: Buffer.from(userData, 'utf8').toString('base64') } : {}),
          MetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: p.metadataHopLimit ?? 1, HttpEndpoint: 'enabled', InstanceMetadataTags: 'disabled' },
          BlockDeviceMappings: [
            { DeviceName: '/dev/sda1', Ebs: { Encrypted: true, VolumeType: 'gp3', VolumeSize: 40, DeleteOnTermination: true } },
            // Sprint 60 (B-10404): a GPU node's models from a pre-seeded snapshot (mounted by its label at boot).
            ...(modelVolume?.snapshotId ? [{ DeviceName: '/dev/sdf', Ebs: { SnapshotId: modelVolume.snapshotId, Encrypted: true, VolumeType: 'gp3' as const, DeleteOnTermination: true } }] : [])
          ],
          ...(p.instanceProfile ? { IamInstanceProfile: { Name: p.instanceProfile } } : {}),
          TagSpecifications: [
            { ResourceType: 'instance', Tags: tags },
            { ResourceType: 'volume', Tags: tags }
          ]
        })
      );
      const i = r.Instances?.[0];
      if (!i?.InstanceId) throw new CloudProviderError('RunInstances answered without an instance.', 'aws', 502, 'malformed');
      const o = instanceObserved(i, region);
      const requestId = r.$metadata.requestId;
      return o.state === 'ready' ? { done: true, resource: o, ...(requestId ? { requestId } : {}) } : { done: false, operation: handle('create', o, 'aws-describe', o.providerId), resource: o, ...(requestId ? { requestId } : {}) };
    } catch (err) {
      throw ec2Err(err);
    }
  }

  /** Tags and the metadata options back to the desired ones (a drift revert); the rest of a VM is replaced, not updated. */
  async updateVm(ctx: CallContext, ref: ResourceRef, spec: ResourceSpec<'vm'>): Promise<OperationResult> {
    const region = ref.region ?? this.h.region(ctx, spec);
    try {
      await this.h.ec2(ctx, region).send(new CreateTagsCommand({ Resources: [ref.providerId], Tags: toTags({ ...spec.tags, [NAME_TAG]: spec.name }) }));
      await this.h.ec2(ctx, region).send(new ModifyInstanceMetadataOptionsCommand({ InstanceId: ref.providerId, HttpTokens: 'required', HttpPutResponseHopLimit: spec.props.metadataHopLimit ?? 1, HttpEndpoint: 'enabled' }));
    } catch (err) {
      throw ec2Err(err);
    }
    return { done: true, resource: await this.describeVm(ctx, ref) };
  }

  async deleteVm(ctx: CallContext, ref: ResourceRef, handle: (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string) => OperationHandle): Promise<OperationResult> {
    try {
      await this.h.ec2(ctx, ref.region).send(new TerminateInstancesCommand({ InstanceIds: [ref.providerId] }));
    } catch (err) {
      const e = ec2Err(err);
      if (/InvalidInstanceID\.NotFound/.test(e.code ?? '')) return { done: true, resource: null };
      throw e;
    }
    return { done: false, operation: handle('delete', ref, 'aws-describe', ref.providerId) };
  }

  async installStatus(ctx: CallContext, ref: ResourceRef): Promise<InstallStatus> {
    try {
      const r = await this.h.ec2(ctx, ref.region).send(new GetConsoleOutputCommand({ InstanceId: ref.providerId, Latest: true }));
      return installStatusFrom(r.Output ? Buffer.from(r.Output, 'base64').toString('utf8') : null);
    } catch (err) {
      throw ec2Err(err);
    }
  }

  // ---------- signed JSON and query calls (ECS, ELBv2, Secrets Manager) ----------

  private async signed(ctx: CallContext, service: 'ecs' | 'elbv2' | 'secretsmanager', region: string, o: { target?: string; params?: Record<string, string>; body?: unknown }): Promise<{ status: number; text: string; requestId: string | null }> {
    if (ctx.cred.kind !== 'aws') throw new CloudProviderError('An AWS account needs an AWS credential.', 'aws', 400, 'wrong_credential');
    const url = new URL(this.h.endpoint(service, region));
    const body = o.target ? JSON.stringify(o.body ?? {}) : new URLSearchParams(o.params ?? {}).toString();
    const headers: Record<string, string> = o.target ? { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': o.target } : { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' };
    if (ctx.cred.sessionToken) headers['x-amz-security-token'] = ctx.cred.sessionToken;
    const signingName = service === 'elbv2' ? 'elasticloadbalancing' : service;
    const signedHeaders = signV4({ method: 'POST', url, headers, payloadHash: sha(body), region, service: signingName, accessKeyId: ctx.cred.accessKeyId, secretAccessKey: ctx.cred.secretAccessKey, date: new Date() });
    const res = await this.h.transport.send({ method: 'POST', url, headers: signedHeaders, body, accountId: ctx.account.id, ...(ctx.signal ? { signal: ctx.signal } : {}) });
    return { status: res.status, text: res.body.toString('utf8'), requestId: res.requestId };
  }

  private async json<T>(ctx: CallContext, service: 'ecs' | 'secretsmanager', region: string, action: string, body: unknown): Promise<T> {
    const target = `${service === 'ecs' ? ECS_TARGET : 'secretsmanager'}.${action}`;
    const r = await this.signed(ctx, service, region, { target, body });
    let parsed: Record<string, unknown> = {};
    try {
      parsed = r.text ? (JSON.parse(r.text) as Record<string, unknown>) : {};
    } catch {
      /* not JSON */
    }
    if (r.status >= 300) {
      const code = String(parsed.__type ?? '').split('#').pop() || null;
      throw new CloudProviderError(`AWS ${service} answered ${r.status}${code ? ` (${code})` : ''}: ${String(parsed.message ?? parsed.Message ?? 'no detail').slice(0, 300)}`, 'aws', r.status === 400 && /NotFound/.test(code ?? '') ? 404 : r.status, code, r.requestId);
    }
    return parsed as T;
  }

  private async elb(ctx: CallContext, region: string, action: string, params: Record<string, string>): Promise<string> {
    const r = await this.signed(ctx, 'elbv2', region, { params: { Action: action, Version: ELB_VERSION, ...params } });
    if (r.status >= 300) {
      const code = xmlText(r.text, 'Code');
      throw new CloudProviderError(`AWS Elastic Load Balancing answered ${r.status}${code ? ` (${code})` : ''}: ${(xmlText(r.text, 'Message') ?? 'no detail').slice(0, 300)}`, 'aws', /NotFound/.test(code ?? '') ? 404 : r.status, code, r.requestId);
    }
    return r.text;
  }

  // ---------- ECS on Fargate (B-10205) ----------

  names(ctx: CallContext, spec: { name: string }) {
    const base = `${namePrefix(ctx.account.name)}${spec.name}`;
    const short = `ex-${sha(base).slice(0, 12)}`;
    return { cluster: base, service: base, family: base, lb: `${short}-lb`, tg: `${short}-tg`, secret: (b: string) => `exprsn/${ctx.account.name}/${spec.name}/${b}` };
  }

  async findService(ctx: CallContext, spec: ResourceSpec): Promise<ObservedResource | null> {
    const n = this.names(ctx, spec);
    return this.describeService(ctx, { type: 'container_service', providerId: `${n.cluster}/${n.service}`, region: this.h.region(ctx, spec) });
  }

  async describeService(ctx: CallContext, ref: ResourceRef): Promise<ObservedResource | null> {
    const region = ref.region ?? this.h.region(ctx);
    const [cluster, service] = splitService(ref.providerId);
    let r: { services?: EcsService[]; failures?: unknown[] };
    try {
      r = await this.json(ctx, 'ecs', region, 'DescribeServices', { cluster, services: [service], include: ['TAGS'] });
    } catch (err) {
      if (err instanceof CloudProviderError && (err.status === 404 || /ClusterNotFound/.test(err.code ?? ''))) return null;
      throw err;
    }
    const s = r.services?.[0];
    if (!s || s.status === 'INACTIVE') return null;
    let image: string | null = null;
    if (s.taskDefinition) {
      const td = await this.json<{ taskDefinition?: { containerDefinitions?: { image?: string }[] } }>(ctx, 'ecs', region, 'DescribeTaskDefinition', { taskDefinition: s.taskDefinition }).catch(() => null);
      image = td?.taskDefinition?.containerDefinitions?.[0]?.image ?? null;
    }
    const lbName = s.tags?.find((t) => t.key === 'exprsn:lb')?.value;
    const address = lbName ? await this.lbAddress(ctx, region, lbName) : null;
    const tags = Object.fromEntries((s.tags ?? []).map((t) => [t.key, t.value]));
    const primary = s.deployments?.find((d) => d.status === 'PRIMARY');
    const settled = (s.runningCount ?? 0) >= (s.desiredCount ?? 0) && (!primary?.rolloutState || primary.rolloutState === 'COMPLETED') && (s.deployments?.length ?? 1) <= 1;
    return {
      type: 'container_service',
      providerId: ref.providerId,
      name: tags[NAME_TAG] ?? service,
      region,
      state: primary?.rolloutState === 'FAILED' ? 'failed' : settled ? 'ready' : 'updating',
      tags: managed(tags),
      props: { platform: 'ecs-fargate', image, replicas: s.desiredCount ?? 0, running: s.runningCount ?? 0, taskDefinition: s.taskDefinition, address },
      locator: { cluster }
    };
  }

  private async lbAddress(ctx: CallContext, region: string, name: string): Promise<string | null> {
    try {
      return xmlText(await this.elb(ctx, region, 'DescribeLoadBalancers', { 'Names.member.1': name }), 'DNSName');
    } catch (err) {
      if (err instanceof CloudProviderError && err.status === 404) return null;
      throw err;
    }
  }

  async listServices(ctx: CallContext): Promise<ObservedResource[]> {
    const region = this.h.region(ctx);
    const prefix = namePrefix(ctx.account.name);
    const clusters = await this.json<{ clusterArns?: string[] }>(ctx, 'ecs', region, 'ListClusters', {});
    const out: ObservedResource[] = [];
    for (const arn of clusters.clusterArns ?? []) {
      const cluster = arn.split('/').pop()!;
      if (!cluster.startsWith(prefix)) continue;
      const o = await this.describeService(ctx, { type: 'container_service', providerId: `${cluster}/${cluster}`, region });
      if (o) out.push(o);
    }
    return out;
  }

  /** The secrets in Secrets Manager (values from the broker, straight to AWS), by ARN. */
  private async putSecrets(ctx: CallContext, spec: ResourceSpec<'container_service'>, region: string): Promise<Record<string, string>> {
    const p = spec.props;
    if (!p.secrets.length) return {};
    if (!ctx.secrets) throw new CloudProviderError('No secret broker is configured, so the service’s secrets cannot be put in Secrets Manager.', 'aws', 409, 'secrets_unavailable');
    const n = this.names(ctx, spec);
    const arns: Record<string, string> = {};
    for (const b of p.secrets) {
      const value = await ctx.secrets.value(b);
      const name = n.secret(fileName(b));
      const clientToken = token64(`${spec.idempotencyKey}:${name}:${sha(value)}`);
      try {
        const r = await this.json<{ ARN: string }>(ctx, 'secretsmanager', region, 'CreateSecret', { Name: name, SecretString: value, ClientRequestToken: clientToken, Description: `Exprsn-AI ${spec.name}: ${b.env}`, Tags: toTags({ ...spec.tags, [NAME_TAG]: spec.name }) });
        arns[b.env] = r.ARN;
      } catch (err) {
        if (!(err instanceof CloudProviderError && /ResourceExists/.test(err.code ?? ''))) throw err;
        const r = await this.json<{ ARN: string }>(ctx, 'secretsmanager', region, 'PutSecretValue', { SecretId: name, SecretString: value, ClientRequestToken: clientToken });
        arns[b.env] = r.ARN;
      }
    }
    return arns;
  }

  /** The service's own ALB: load balancer, target group on `/readyz`, listener. Found by name when it exists. */
  private async ensureLoadBalancer(ctx: CallContext, spec: ResourceSpec<'container_service'>, region: string): Promise<string | null> {
    const p = spec.props;
    const refs = spec.parent?.refs ?? {};
    const subnets = (p.lbSubnets ?? []).map((k) => refs[k]).filter((x): x is string => !!x);
    if (!subnets.length) return null;
    const n = this.names(ctx, spec);
    const sg = p.lbFirewall ? refs[p.lbFirewall] : undefined;
    const tagParams = (prefix: string) => Object.fromEntries(Object.entries({ ...spec.tags, [NAME_TAG]: spec.name }).flatMap(([k, v], i) => [[`${prefix}.member.${i + 1}.Key`, k], [`${prefix}.member.${i + 1}.Value`, v]]));
    const lbXml = await this.elb(ctx, region, 'CreateLoadBalancer', { Name: n.lb, Type: 'application', Scheme: p.ingress, ...Object.fromEntries(subnets.map((s, i) => [`Subnets.member.${i + 1}`, s])), ...(sg ? { 'SecurityGroups.member.1': sg } : {}), ...tagParams('Tags') });
    const lbArn = xmlText(lbXml, 'LoadBalancerArn')!;
    const tgXml = await this.elb(ctx, region, 'CreateTargetGroup', { Name: n.tg, Protocol: 'HTTP', Port: String(p.port), TargetType: 'ip', ...(spec.parent?.networkId ? { VpcId: spec.parent.networkId } : {}), HealthCheckPath: '/readyz', HealthCheckProtocol: 'HTTP', ...tagParams('Tags') });
    const tgArn = xmlText(tgXml, 'TargetGroupArn')!;
    const listeners = await this.elb(ctx, region, 'DescribeListeners', { LoadBalancerArn: lbArn });
    if (!xmlText(listeners, 'ListenerArn')) {
      const forward = { 'DefaultActions.member.1.Type': 'forward', 'DefaultActions.member.1.TargetGroupArn': tgArn };
      if (p.certificateArn) await this.elb(ctx, region, 'CreateListener', { LoadBalancerArn: lbArn, Protocol: 'HTTPS', Port: '443', 'Certificates.member.1.CertificateArn': p.certificateArn, SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06', ...forward });
      else if (p.ingress === 'internal') await this.elb(ctx, region, 'CreateListener', { LoadBalancerArn: lbArn, Protocol: 'HTTP', Port: '80', ...forward });
      // An internet-facing ALB without a certificate gets no listener until B-10206 imports one: never plain HTTP to the internet.
    }
    return tgArn;
  }

  private async registerTask(ctx: CallContext, spec: ResourceSpec<'container_service'>, region: string, secretArns: Record<string, string>): Promise<string> {
    const p = spec.props;
    const n = this.names(ctx, spec);
    const acct = ctx.account.providerIds.awsAccountId ?? '000000000000';
    const executionRoleArn = p.executionRoleArn ?? `arn:aws:iam::${acct}:role/${namePrefix(ctx.account.name)}ecs-execution`;
    const r = await this.json<{ taskDefinition: { taskDefinitionArn: string } }>(ctx, 'ecs', region, 'RegisterTaskDefinition', {
      family: n.family,
      networkMode: 'awsvpc',
      requiresCompatibilities: ['FARGATE'],
      cpu: String(Math.round(p.vcpu * 1024)),
      memory: String(Math.round(p.memoryGb * 1024)),
      executionRoleArn,
      runtimePlatform: { cpuArchitecture: 'X86_64', operatingSystemFamily: 'LINUX' },
      containerDefinitions: [
        {
          name: 'app',
          image: p.image,
          essential: true,
          portMappings: [{ containerPort: p.port, protocol: 'tcp' }],
          environment: Object.entries(p.env).map(([name, value]) => ({ name, value })),
          secrets: p.secrets.map((b) => ({ name: b.env, valueFrom: secretArns[b.env]! })),
          readonlyRootFilesystem: false,
          user: '1000'
        }
      ],
      tags: toTags({ ...spec.tags, [NAME_TAG]: spec.name }).map((t) => ({ key: t.Key, value: t.Value }))
    });
    return r.taskDefinition.taskDefinitionArn;
  }

  private network(spec: ResourceSpec<'container_service'>): { subnets: string[]; securityGroups: string[] } {
    const refs = spec.parent?.refs ?? {};
    return { subnets: spec.props.subnets.map((k) => refs[k]).filter((x): x is string => !!x), securityGroups: spec.props.firewall && refs[spec.props.firewall] ? [refs[spec.props.firewall]!] : [] };
  }

  private async runMigration(ctx: CallContext, region: string, cluster: string, taskDefinition: string, net: { subnets: string[]; securityGroups: string[] }, command: string[], clientToken: string): Promise<string> {
    const r = await this.json<{ tasks?: { taskArn: string }[]; failures?: { reason?: string }[] }>(ctx, 'ecs', region, 'RunTask', {
      cluster,
      taskDefinition,
      launchType: 'FARGATE',
      count: 1,
      startedBy: 'exprsn-migrate',
      clientToken,
      networkConfiguration: { awsvpcConfiguration: { subnets: net.subnets, securityGroups: net.securityGroups, assignPublicIp: 'DISABLED' } },
      overrides: { containerOverrides: [{ name: 'app', command }] }
    });
    const arn = r.tasks?.[0]?.taskArn;
    if (!arn) throw new CloudProviderError(`The migration task did not start${r.failures?.[0]?.reason ? `: ${r.failures[0].reason}` : '.'}`, 'aws', 502, 'migration_not_started');
    return arn;
  }

  async createService(ctx: CallContext, spec: ResourceSpec<'container_service'>, handle: (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string) => OperationHandle): Promise<OperationResult> {
    const existing = await this.findService(ctx, spec);
    if (existing) return existing.state === 'ready' ? { done: true, resource: existing, adopted: true } : { done: false, operation: handle('create', existing, 'aws-ecs', JSON.stringify({ phase: 'service', cluster: existing.locator!.cluster!, service: splitService(existing.providerId)[1] } satisfies EcsPhase)), resource: existing, adopted: true };
    return this.rollout(ctx, spec, 'create', handle);
  }

  async updateService(ctx: CallContext, ref: ResourceRef, spec: ResourceSpec<'container_service'>, handle: (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string) => OperationHandle): Promise<OperationResult> {
    return this.rollout(ctx, spec, 'update', handle, ref);
  }

  /** Cluster, secrets, ALB, task definition, then the migration task; the service follows once it exited 0. */
  private async rollout(ctx: CallContext, spec: ResourceSpec<'container_service'>, then: 'create' | 'update', handle: (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string) => OperationHandle, ref?: ResourceRef): Promise<OperationResult> {
    const p = spec.props;
    if (!p.image) throw new CloudProviderError('The container service has no image pinned by digest.', 'aws', 400, 'image_required');
    if (Object.keys(p.env).some((k) => k === 'DATA_KEY' || k === 'DATA_KEY_PREVIOUS')) throw new CloudProviderError('DATA_KEY is never a task definition variable.', 'aws', 400, 'inline_secret');
    const region = this.h.region(ctx, spec);
    const n = this.names(ctx, spec);
    const tags = { ...spec.tags, [NAME_TAG]: spec.name, 'exprsn:lb': n.lb };
    await this.json(ctx, 'ecs', region, 'CreateCluster', { clusterName: n.cluster, tags: toTags(tags).map((t) => ({ key: t.Key, value: t.Value })), settings: [{ name: 'containerInsights', value: 'enabled' }] });
    const arns = await this.putSecrets(ctx, spec, region);
    const targetGroupArn = await this.ensureLoadBalancer(ctx, spec, region);
    const taskDefinition = await this.registerTask(ctx, spec, region, arns);
    const net = this.network(spec);
    const taskArn = await this.runMigration(ctx, region, n.cluster, taskDefinition, net, p.migrate.command, token64(`${spec.idempotencyKey}:migrate`));
    const phase: EcsPhase = { phase: 'migrate', then, cluster: n.cluster, service: n.service, taskDefinition, taskArn, targetGroupArn, subnets: net.subnets, securityGroups: net.securityGroups, desired: p.replicas, clientToken: token64(`${spec.idempotencyKey}:service`), tags };
    const r: ResourceRef = ref ?? { type: 'container_service', providerId: `${n.cluster}/${n.service}`, region, locator: { cluster: n.cluster } };
    return { done: false, operation: handle(then === 'create' ? 'create' : 'update', r, 'aws-ecs', JSON.stringify(phase)) };
  }

  async deleteService(ctx: CallContext, ref: ResourceRef, handle: (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string) => OperationHandle): Promise<OperationResult> {
    const [cluster, service] = splitService(ref.providerId);
    const phase: EcsPhase = { phase: 'delete', cluster, service, left: ['service', 'lb', 'tg', 'secrets', 'cluster'] };
    return this.pollDelete(ctx, { provider: 'aws', type: 'container_service', op: 'delete', kind: 'aws-ecs', ref, token: JSON.stringify(phase), startedAt: Date.now() }, phase, handle);
  }

  async pollService(ctx: CallContext, h: OperationHandle, handle: (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string) => OperationHandle): Promise<PollResult> {
    const ph = JSON.parse(h.token) as EcsPhase;
    const region = h.ref.region ?? this.h.region(ctx);
    if (ph.phase === 'delete') {
      const r = await this.pollDelete(ctx, h, ph, handle);
      return r.done ? { state: 'succeeded', resource: null } : { state: 'pending', waitMs: 5000 };
    }
    if (ph.phase === 'migrate') {
      const t = await this.json<{ tasks?: EcsTask[] }>(ctx, 'ecs', region, 'DescribeTasks', { cluster: ph.cluster, tasks: [ph.taskArn] });
      const task = t.tasks?.[0];
      if (!task) return { state: 'failed', error: 'The migration task disappeared.', code: 'migration_failed' };
      if (task.lastStatus !== 'STOPPED') return { state: 'pending', waitMs: 5000 };
      const exit = task.containers?.[0]?.exitCode;
      if (exit !== 0) return { state: 'failed', error: `The migration task stopped with exit code ${exit ?? 'none'}${task.stoppedReason ? ` (${task.stoppedReason})` : ''}; the service was not rolled out.`, code: 'migration_failed' };
      // The service, read back each poll (a journalled handle cannot change): created once (client token), or moved
      // to this rollout's task definition, then followed until its deployment settles.
      const netConf = { awsvpcConfiguration: { subnets: ph.subnets ?? [], securityGroups: ph.securityGroups ?? [], assignPublicIp: 'DISABLED' } };
      const current = await this.describeService(ctx, h.ref);
      if (!current) {
        try {
          await this.json(ctx, 'ecs', region, 'CreateService', {
            cluster: ph.cluster,
            serviceName: ph.service,
            taskDefinition: ph.taskDefinition,
            desiredCount: ph.desired,
            launchType: 'FARGATE',
            clientToken: ph.clientToken,
            networkConfiguration: netConf,
            ...(ph.targetGroupArn ? { loadBalancers: [{ targetGroupArn: ph.targetGroupArn, containerName: 'app', containerPort: 8080 }], healthCheckGracePeriodSeconds: 120 } : {}),
            deploymentConfiguration: { deploymentCircuitBreaker: { enable: true, rollback: true }, minimumHealthyPercent: 100, maximumPercent: 200 },
            enableExecuteCommand: false,
            propagateTags: 'SERVICE',
            tags: toTags(ph.tags ?? {}).map((x) => ({ key: x.Key, value: x.Value }))
          });
        } catch (err) {
          if (!(err instanceof CloudProviderError && /InvalidParameter/.test(err.code ?? '') && /already exists|idempotent/i.test(err.message))) throw err;
        }
        return { state: 'pending', waitMs: 5000, progress: 50 };
      }
      if (current.props.taskDefinition !== ph.taskDefinition || current.props.replicas !== ph.desired) {
        await this.json(ctx, 'ecs', region, 'UpdateService', { cluster: ph.cluster, service: ph.service, taskDefinition: ph.taskDefinition, desiredCount: ph.desired, networkConfiguration: netConf, forceNewDeployment: false });
        return { state: 'pending', waitMs: 5000, progress: 60 };
      }
    }
    const o = await this.describeService(ctx, h.ref);
    if (!o) return { state: 'pending', waitMs: 5000 };
    if (o.state === 'failed') return { state: 'failed', error: 'The ECS deployment failed and its circuit breaker rolled it back.', code: 'rollout_failed' };
    return o.state === 'ready' ? { state: 'succeeded', resource: o } : { state: 'pending', waitMs: 5000, progress: 75 };
  }

  /** One pass over what a delete still has to remove; done when nothing is left. */
  private async pollDelete(ctx: CallContext, h: OperationHandle, ph: EcsPhase, handle: (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string) => OperationHandle): Promise<OperationResult> {
    const region = h.ref.region ?? this.h.region(ctx);
    const n = { lb: '', tg: '' };
    const short = `ex-${sha(ph.cluster).slice(0, 12)}`;
    n.lb = `${short}-lb`;
    n.tg = `${short}-tg`;
    const left = new Set(ph.left ?? []);
    const gone = (err: unknown) => err instanceof CloudProviderError && (err.status === 404 || /NotFound|ServiceNotActive|ResourceNotFound/.test(err.code ?? ''));
    const step = async (k: string, f: () => Promise<unknown>) => {
      if (!left.has(k)) return;
      try {
        await f();
        left.delete(k);
      } catch (err) {
        if (gone(err)) left.delete(k);
        else if (!(err instanceof CloudProviderError && /InUse|ClusterContainsTasks|ClusterContainsServices|Dependency/.test(err.code ?? ''))) throw err;
      }
    };
    await step('service', () => this.json(ctx, 'ecs', region, 'DeleteService', { cluster: ph.cluster, service: ph.service, force: true }));
    await step('lb', async () => {
      const x = await this.elb(ctx, region, 'DescribeLoadBalancers', { 'Names.member.1': n.lb });
      const arn = xmlText(x, 'LoadBalancerArn');
      if (arn) await this.elb(ctx, region, 'DeleteLoadBalancer', { LoadBalancerArn: arn });
    });
    await step('tg', async () => {
      const x = await this.elb(ctx, region, 'DescribeTargetGroups', { 'Names.member.1': n.tg });
      const arn = xmlText(x, 'TargetGroupArn');
      if (arn) await this.elb(ctx, region, 'DeleteTargetGroup', { TargetGroupArn: arn });
    });
    await step('secrets', async () => {
      const prefix = `exprsn/${ctx.account.name}/${ph.service.slice(namePrefix(ctx.account.name).length)}/`;
      const list = await this.json<{ SecretList?: { Name: string }[] }>(ctx, 'secretsmanager', region, 'ListSecrets', { Filters: [{ Key: 'name', Values: [prefix] }] });
      for (const sct of list.SecretList ?? []) if (sct.Name.startsWith(prefix)) await this.json(ctx, 'secretsmanager', region, 'DeleteSecret', { SecretId: sct.Name, ForceDeleteWithoutRecovery: true });
    });
    await step('cluster', () => this.json(ctx, 'ecs', region, 'DeleteCluster', { cluster: ph.cluster }));
    if (!left.size) return { done: true, resource: null };
    return { done: false, operation: handle('delete', h.ref, 'aws-ecs', JSON.stringify({ ...ph, left: [...left] })) };
  }
}

interface EcsService { serviceName: string; status: string; desiredCount?: number; runningCount?: number; taskDefinition?: string; deployments?: { status: string; rolloutState?: string }[]; tags?: { key: string; value: string }[] }
interface EcsTask { taskArn: string; lastStatus: string; stoppedReason?: string; containers?: { exitCode?: number }[] }

const splitService = (id: string): [string, string] => {
  const i = id.indexOf('/');
  return i < 0 ? [id, id] : [id.slice(0, i), id.slice(i + 1)];
};

function ec2Err(err: unknown): CloudProviderError {
  if (err instanceof CloudProviderError) return err;
  const e = (err ?? {}) as { name?: string; Code?: string; message?: string; $metadata?: { httpStatusCode?: number; requestId?: string } };
  const status = e.$metadata?.httpStatusCode ?? 502;
  const code = e.Code ?? e.name ?? null;
  return new CloudProviderError(`AWS answered ${status}${code ? ` (${code})` : ''}: ${(e.message ?? 'no detail').slice(0, 300)}`, 'aws', /NotFound/.test(code ?? '') ? 404 : status, code, e.$metadata?.requestId ?? null);
}

const ec2State = (s: string | undefined): ObservedResource['state'] => (s === 'running' ? 'ready' : s === 'pending' ? 'creating' : s === 'shutting-down' || s === 'terminated' || s === 'stopping' ? 'deleting' : 'ready');

function instanceObserved(i: Instance, region?: string): ObservedResource {
  const tags = Object.fromEntries((i.Tags ?? []).filter((t) => t.Key).map((t) => [t.Key!, t.Value ?? '']));
  const m = i.MetadataOptions;
  return {
    type: 'vm',
    providerId: i.InstanceId!,
    name: tags[NAME_TAG] ?? i.InstanceId!,
    ...(region ? { region } : {}),
    state: ec2State(i.State?.Name),
    tags: managed(tags),
    props: { size: i.InstanceType, imdsV2: m?.HttpTokens === 'required', metadataHopLimit: m?.HttpPutResponseHopLimit, publicIp: !!i.PublicIpAddress, networkId: i.VpcId, privateIp: i.PrivateIpAddress, status: i.State?.Name } satisfies Partial<Record<keyof PropsByType['vm'] | 'networkId' | 'privateIp' | 'status', unknown>>,
    ...(i.VpcId ? { locator: { networkId: i.VpcId } } : {})
  };
}

export type { ContainerServiceProps };
