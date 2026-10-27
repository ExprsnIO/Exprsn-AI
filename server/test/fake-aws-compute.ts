/*
 * 1.9.99-final, Sprint 58 (B-10204, B-10205): the compute part of the AWS fake (`fake-aws.ts` routes to it). EC2
 * instances (RunInstances with ClientToken, DescribeInstances, TerminateInstances, GetConsoleOutput with the
 * simulated first boot of `fake-vm-boot.ts`, ModifyInstanceMetadataOptions), ECS (clusters, task definitions, RunTask
 * with a migration exit code a test sets, services settling after `settleAfter` describes), Elastic Load Balancing
 * v2 (load balancers, target groups, listeners, by name) and Secrets Manager (secrets kept so a test can check where
 * values went). It is never the real AWS.
 */
import { simulateBoot } from './fake-vm-boot.js';
import { xmlEsc, type RecordedRequest, type Reply } from './fake-cloud-base.js';

type Tags = Record<string, string>;

export interface FakeInstance {
  InstanceId: string;
  ImageId: string;
  InstanceType: string;
  SubnetId: string;
  VpcId: string;
  SecurityGroups: string[];
  State: 'pending' | 'running' | 'shutting-down' | 'terminated';
  UserData: string | null;
  HttpTokens: string;
  HopLimit: number;
  HttpEndpoint: string;
  PublicIp: string | null;
  PrivateIp: string;
  Tags: Tags;
  ClientToken: string | null;
  /** Sprint 60 (B-10404): `snapshotId` when the volume is made from a snapshot (a GPU node's pre-seeded models). */
  BlockDevices: { encrypted: boolean; snapshotId?: string }[];
  describes: number;
  console: string;
}

export interface FakeEcsTask { taskArn: string; cluster: string; taskDefinition: string; command: string[] | null; lastStatus: string; exitCode: number; polls: number; clientToken: string | null }
export interface FakeEcsService { serviceName: string; cluster: string; status: string; desiredCount: number; runningCount: number; taskDefinition: string; rolloutState: string; tags: { key: string; value: string }[]; loadBalancers: unknown[]; clientToken: string | null; describes: number; networkConfiguration: unknown }

export interface ComputeHelpers {
  nextId(prefix: string): string;
  account(): string;
  settleAfter(): number;
  subnetVpc(subnetId: string): string | null;
  ec2Ok(action: string, inner: string): Reply;
  ec2Error(status: number, code: string, message: string): Reply;
}

const iso = () => new Date().toISOString();

export interface FakeLaunchTemplate { id: string; name: string; httpTokens: string; hopLimit: number; httpEndpoint: string; tags: Tags }
const ltXml = (t: FakeLaunchTemplate) => `<launchTemplateId>${t.id}</launchTemplateId><launchTemplateName>${xmlEsc(t.name)}</launchTemplateName><defaultVersionNumber>1</defaultVersionNumber><latestVersionNumber>1</latestVersionNumber>`;

export class FakeAwsCompute {
  readonly instances = new Map<string, FakeInstance>();
  readonly clusters = new Map<string, { clusterName: string; status: string; tags: unknown }>();
  readonly taskDefinitions = new Map<string, Record<string, unknown>>();
  readonly tasks = new Map<string, FakeEcsTask>();
  readonly services = new Map<string, FakeEcsService>();
  readonly loadBalancers = new Map<string, { name: string; arn: string; scheme: string; dns: string; subnets: string[]; securityGroups: string[] }>();
  readonly targetGroups = new Map<string, { name: string; arn: string; port: string; healthCheckPath: string }>();
  readonly listeners: { lbArn: string; arn: string; protocol: string; port: string; certificate: string | null }[] = [];
  readonly secrets = new Map<string, { name: string; arn: string; value: string; versions: number }>();
  /** B-10705: launch templates by id, with the metadata options they set. */
  readonly launchTemplates = new Map<string, FakeLaunchTemplate>();
  /** URL → sha256 of what that URL serves (a tampered tarball has another digest). */
  releases = new Map<string, string>();
  /** The exit code of the next migration tasks. */
  migrationExitCode = 0;
  private revisions = new Map<string, number>();

  constructor(private readonly h: ComputeHelpers) {}

  // ---------- EC2 instances ----------

  ec2(action: string, p: URLSearchParams, x: { indexed: (prefix: string) => string[]; filters: () => { name: string; values: string[] }[]; tagSpecs: (type: string) => Tags; tagSet: (t: Tags) => string }): Reply | null {
    const xml = (i: FakeInstance) =>
      `<item><instanceId>${i.InstanceId}</instanceId><imageId>${xmlEsc(i.ImageId)}</imageId><instanceState><code>${{ pending: 0, running: 16, 'shutting-down': 32, terminated: 48 }[i.State]}</code><name>${i.State}</name></instanceState><privateIpAddress>${i.PrivateIp}</privateIpAddress>${i.PublicIp ? `<ipAddress>${i.PublicIp}</ipAddress>` : ''}<instanceType>${i.InstanceType}</instanceType><subnetId>${i.SubnetId}</subnetId><vpcId>${i.VpcId}</vpcId><groupSet>${i.SecurityGroups.map((g) => `<item><groupId>${g}</groupId><groupName>${g}</groupName></item>`).join('')}</groupSet>${x.tagSet(i.Tags)}<metadataOptions><state>applied</state><httpTokens>${i.HttpTokens}</httpTokens><httpPutResponseHopLimit>${i.HopLimit}</httpPutResponseHopLimit><httpEndpoint>${i.HttpEndpoint}</httpEndpoint></metadataOptions></item>`;
    const settle = (i: FakeInstance) => {
      i.describes += 1;
      if (i.State === 'pending' && i.describes > this.h.settleAfter()) {
        i.State = 'running';
        i.console = simulateBoot(i.UserData ? Buffer.from(i.UserData, 'base64').toString('utf8') : null, this.releases).console;
      }
      if (i.State === 'shutting-down' && i.describes > this.h.settleAfter()) i.State = 'terminated';
    };
    switch (action) {
      case 'RunInstances': {
        const token = p.get('ClientToken');
        const again = token ? [...this.instances.values()].find((i) => i.ClientToken === token) : undefined;
        if (again) return this.h.ec2Ok('RunInstances', `<reservationId>r-again</reservationId><ownerId>${this.h.account()}</ownerId><instancesSet>${xml(again)}</instancesSet>`);
        const subnet = p.get('SubnetId') ?? '';
        const devices: { encrypted: boolean; snapshotId?: string }[] = [];
        for (let i = 1; p.has(`BlockDeviceMapping.${i}.DeviceName`); i++) {
          const snap = p.get(`BlockDeviceMapping.${i}.Ebs.SnapshotId`);
          devices.push({ encrypted: p.get(`BlockDeviceMapping.${i}.Ebs.Encrypted`) === 'true', ...(snap ? { snapshotId: snap } : {}) });
        }
        const inst: FakeInstance = {
          InstanceId: this.h.nextId('i-'),
          ImageId: p.get('ImageId') ?? '',
          InstanceType: p.get('InstanceType') ?? '',
          SubnetId: subnet,
          VpcId: this.h.subnetVpc(subnet) ?? '',
          SecurityGroups: x.indexed('SecurityGroupId'),
          State: 'pending',
          UserData: p.get('UserData'),
          HttpTokens: p.get('MetadataOptions.HttpTokens') ?? 'optional',
          HopLimit: Number(p.get('MetadataOptions.HttpPutResponseHopLimit') ?? 1),
          HttpEndpoint: p.get('MetadataOptions.HttpEndpoint') ?? 'enabled',
          PublicIp: null,
          PrivateIp: `10.64.${this.instances.size + 1}.10`,
          Tags: x.tagSpecs('instance'),
          ClientToken: token,
          BlockDevices: devices,
          describes: 0,
          console: ''
        };
        this.instances.set(inst.InstanceId, inst);
        return this.h.ec2Ok('RunInstances', `<reservationId>${this.h.nextId('r-')}</reservationId><ownerId>${this.h.account()}</ownerId><instancesSet>${xml(inst)}</instancesSet>`);
      }
      case 'DescribeInstances': {
        const ids = x.indexed('InstanceId');
        for (const id of ids) if (!this.instances.has(id)) return this.h.ec2Error(400, 'InvalidInstanceID.NotFound', `The instance ID '${id}' does not exist`);
        const list = [...this.instances.values()].filter(
          (i) =>
            (!ids.length || ids.includes(i.InstanceId)) &&
            x.filters().every((f) => {
              if (f.name.startsWith('tag:')) return f.values.includes(i.Tags[f.name.slice(4)] ?? '\u0000');
              if (f.name === 'instance-state-name') return f.values.includes(i.State);
              if (f.name === 'vpc-id') return f.values.includes(i.VpcId);
              return true;
            })
        );
        list.forEach(settle);
        return this.h.ec2Ok('DescribeInstances', `<reservationSet>${list.length ? `<item><reservationId>r-1</reservationId><ownerId>${this.h.account()}</ownerId><instancesSet>${list.map(xml).join('')}</instancesSet></item>` : ''}</reservationSet>`);
      }
      case 'TerminateInstances': {
        const out: string[] = [];
        for (const id of x.indexed('InstanceId')) {
          const i = this.instances.get(id);
          if (!i) return this.h.ec2Error(400, 'InvalidInstanceID.NotFound', `The instance ID '${id}' does not exist`);
          const prev = i.State;
          i.State = 'shutting-down';
          i.describes = 0;
          out.push(`<item><instanceId>${id}</instanceId><currentState><code>32</code><name>shutting-down</name></currentState><previousState><code>16</code><name>${prev}</name></previousState></item>`);
        }
        return this.h.ec2Ok('TerminateInstances', `<instancesSet>${out.join('')}</instancesSet>`);
      }
      case 'GetConsoleOutput': {
        const i = this.instances.get(p.get('InstanceId') ?? '');
        if (!i) return this.h.ec2Error(400, 'InvalidInstanceID.NotFound', 'The instance does not exist');
        return this.h.ec2Ok('GetConsoleOutput', `<instanceId>${i.InstanceId}</instanceId><timestamp>${iso()}</timestamp>${i.console ? `<output>${Buffer.from(i.console).toString('base64')}</output>` : ''}`);
      }
      // B-10705: launch templates (the EKS node groups' metadata options).
      case 'CreateLaunchTemplate': {
        const name = p.get('LaunchTemplateName') ?? '';
        if ([...this.launchTemplates.values()].some((t) => t.name === name)) return this.h.ec2Error(400, 'InvalidLaunchTemplateName.AlreadyExistsException', `Launch template name already in use.`);
        const t = { id: this.h.nextId('lt-'), name, httpTokens: p.get('LaunchTemplateData.MetadataOptions.HttpTokens') ?? 'optional', hopLimit: Number(p.get('LaunchTemplateData.MetadataOptions.HttpPutResponseHopLimit') ?? 2), httpEndpoint: p.get('LaunchTemplateData.MetadataOptions.HttpEndpoint') ?? 'enabled', tags: x.tagSpecs('launch-template') };
        this.launchTemplates.set(t.id, t);
        return this.h.ec2Ok('CreateLaunchTemplate', `<launchTemplate>${ltXml(t)}</launchTemplate>`);
      }
      case 'DescribeLaunchTemplates': {
        const names = x.indexed('LaunchTemplateName');
        const list = [...this.launchTemplates.values()].filter((t) => !names.length || names.includes(t.name));
        if (names.length && !list.length) return this.h.ec2Error(400, 'InvalidLaunchTemplateName.NotFoundException', 'At least one of the launch templates specified in the request does not exist.');
        return this.h.ec2Ok('DescribeLaunchTemplates', `<launchTemplates>${list.map((t) => `<item>${ltXml(t)}</item>`).join('')}</launchTemplates>`);
      }
      case 'DeleteLaunchTemplate': {
        const t = [...this.launchTemplates.values()].find((v) => v.name === p.get('LaunchTemplateName') || v.id === p.get('LaunchTemplateId'));
        if (!t) return this.h.ec2Error(400, 'InvalidLaunchTemplateName.NotFoundException', 'The launch template does not exist.');
        this.launchTemplates.delete(t.id);
        return this.h.ec2Ok('DeleteLaunchTemplate', `<launchTemplate>${ltXml(t)}</launchTemplate>`);
      }
      case 'ModifyInstanceMetadataOptions': {
        const i = this.instances.get(p.get('InstanceId') ?? '');
        if (!i) return this.h.ec2Error(400, 'InvalidInstanceID.NotFound', 'The instance does not exist');
        if (p.get('HttpTokens')) i.HttpTokens = p.get('HttpTokens')!;
        if (p.get('HttpPutResponseHopLimit')) i.HopLimit = Number(p.get('HttpPutResponseHopLimit'));
        return this.h.ec2Ok('ModifyInstanceMetadataOptions', `<instanceId>${i.InstanceId}</instanceId><instanceMetadataOptions><state>pending</state><httpTokens>${i.HttpTokens}</httpTokens><httpPutResponseHopLimit>${i.HopLimit}</httpPutResponseHopLimit><httpEndpoint>${i.HttpEndpoint}</httpEndpoint></instanceMetadataOptions>`);
      }
    }
    return null;
  }

  /** The instance whose tags a CreateTags names. */
  taggable(id: string): { Tags: Tags } | undefined {
    return this.instances.get(id);
  }

  // ---------- ECS (JSON 1.1) ----------

  ecs(r: RecordedRequest): Reply {
    const action = r.op.split(':')[1]!;
    const b = (r.body ? JSON.parse(r.body) : {}) as Record<string, unknown>;
    const err = (code: string, message: string): Reply => ({ status: 400, headers: { 'x-amzn-errortype': code }, body: { __type: code, message } });
    const clusterOf = (c: unknown) => String(c ?? 'default').split('/').pop()!;
    const arn = (kind: string, name: string) => `arn:aws:ecs:eu-central-1:${this.h.account()}:${kind}/${name}`;
    const svcView = (s: FakeEcsService) => ({ serviceName: s.serviceName, serviceArn: arn('service', `${s.cluster}/${s.serviceName}`), clusterArn: arn('cluster', s.cluster), status: s.status, desiredCount: s.desiredCount, runningCount: s.runningCount, taskDefinition: s.taskDefinition, deployments: [{ status: 'PRIMARY', rolloutState: s.rolloutState, taskDefinition: s.taskDefinition }], tags: s.tags, loadBalancers: s.loadBalancers });
    switch (action) {
      case 'CreateCluster': {
        const name = String(b.clusterName);
        const c = this.clusters.get(name) ?? { clusterName: name, status: 'ACTIVE', tags: b.tags };
        c.status = 'ACTIVE';
        this.clusters.set(name, c);
        return { status: 200, body: { cluster: { clusterArn: arn('cluster', name), clusterName: name, status: 'ACTIVE' } } };
      }
      case 'ListClusters':
        return { status: 200, body: { clusterArns: [...this.clusters.values()].filter((c) => c.status === 'ACTIVE').map((c) => arn('cluster', c.clusterName)) } };
      case 'DeleteCluster': {
        const name = clusterOf(b.cluster);
        if (!this.clusters.has(name)) return err('ClusterNotFoundException', 'Cluster not found.');
        if ([...this.services.values()].some((s) => s.cluster === name && s.status === 'ACTIVE')) return err('ClusterContainsServicesException', 'The cluster cannot be deleted while services are active.');
        this.clusters.delete(name);
        return { status: 200, body: { cluster: { clusterName: name, status: 'INACTIVE' } } };
      }
      case 'RegisterTaskDefinition': {
        const family = String(b.family);
        const rev = (this.revisions.get(family) ?? 0) + 1;
        this.revisions.set(family, rev);
        const td = { ...b, taskDefinitionArn: arn('task-definition', `${family}:${rev}`), revision: rev, status: 'ACTIVE' };
        this.taskDefinitions.set(td.taskDefinitionArn, td);
        return { status: 200, body: { taskDefinition: td } };
      }
      case 'DescribeTaskDefinition': {
        const td = this.taskDefinitions.get(String(b.taskDefinition));
        return td ? { status: 200, body: { taskDefinition: td } } : err('ClientException', 'Unable to describe task definition.');
      }
      case 'RunTask': {
        const cluster = clusterOf(b.cluster);
        if (!this.clusters.has(cluster)) return err('ClusterNotFoundException', 'Cluster not found.');
        const token = (b.clientToken as string | undefined) ?? null;
        const again = token ? [...this.tasks.values()].find((t) => t.clientToken === token) : undefined;
        const overrides = (b.overrides as { containerOverrides?: { command?: string[] }[] } | undefined)?.containerOverrides?.[0];
        const t: FakeEcsTask = again ?? { taskArn: arn('task', `${cluster}/${this.h.nextId('')}`), cluster, taskDefinition: String(b.taskDefinition), command: overrides?.command ?? null, lastStatus: 'PROVISIONING', exitCode: this.migrationExitCode, polls: 0, clientToken: token };
        this.tasks.set(t.taskArn, t);
        return { status: 200, body: { tasks: [{ taskArn: t.taskArn, lastStatus: t.lastStatus }], failures: [] } };
      }
      case 'DescribeTasks': {
        const out = ((b.tasks as string[]) ?? []).map((a) => this.tasks.get(a)).filter((t): t is FakeEcsTask => !!t);
        for (const t of out) {
          t.polls += 1;
          if (t.polls > this.h.settleAfter()) t.lastStatus = 'STOPPED';
          else t.lastStatus = 'RUNNING';
        }
        return { status: 200, body: { tasks: out.map((t) => ({ taskArn: t.taskArn, lastStatus: t.lastStatus, ...(t.lastStatus === 'STOPPED' ? { stoppedReason: t.exitCode ? 'Essential container in task exited' : 'Task completed', containers: [{ name: 'app', exitCode: t.exitCode }] } : { containers: [{ name: 'app' }] }) })), failures: [] } };
      }
      case 'CreateService': {
        const cluster = clusterOf(b.cluster);
        if (!this.clusters.has(cluster)) return err('ClusterNotFoundException', 'Cluster not found.');
        const key = `${cluster}/${String(b.serviceName)}`;
        const existing = this.services.get(key);
        if (existing && existing.status === 'ACTIVE') {
          if (existing.clientToken && existing.clientToken === b.clientToken) return { status: 200, body: { service: svcView(existing) } };
          return err('InvalidParameterException', 'Creation of service was not idempotent.');
        }
        const s: FakeEcsService = { serviceName: String(b.serviceName), cluster, status: 'ACTIVE', desiredCount: Number(b.desiredCount ?? 1), runningCount: 0, taskDefinition: String(b.taskDefinition), rolloutState: 'IN_PROGRESS', tags: (b.tags as FakeEcsService['tags']) ?? [], loadBalancers: (b.loadBalancers as unknown[]) ?? [], clientToken: (b.clientToken as string | undefined) ?? null, describes: 0, networkConfiguration: b.networkConfiguration };
        this.services.set(key, s);
        return { status: 200, body: { service: svcView(s) } };
      }
      case 'DescribeServices': {
        const cluster = clusterOf(b.cluster);
        if (!this.clusters.has(cluster)) return err('ClusterNotFoundException', 'Cluster not found.');
        const found: FakeEcsService[] = [];
        const failures: { arn: string; reason: string }[] = [];
        for (const name of (b.services as string[]) ?? []) {
          const s = this.services.get(`${cluster}/${name.split('/').pop()}`);
          if (!s) {
            failures.push({ arn: name, reason: 'MISSING' });
            continue;
          }
          s.describes += 1;
          if (s.status === 'ACTIVE' && s.describes > this.h.settleAfter()) {
            s.runningCount = s.desiredCount;
            s.rolloutState = 'COMPLETED';
          }
          found.push(s);
        }
        return { status: 200, body: { services: found.map(svcView), failures } };
      }
      case 'UpdateService': {
        const s = this.services.get(`${clusterOf(b.cluster)}/${String(b.service).split('/').pop()}`);
        if (!s || s.status !== 'ACTIVE') return err('ServiceNotActiveException', 'Service not active.');
        if (b.taskDefinition) s.taskDefinition = String(b.taskDefinition);
        if (b.desiredCount != null) s.desiredCount = Number(b.desiredCount);
        s.rolloutState = 'IN_PROGRESS';
        s.describes = 0;
        return { status: 200, body: { service: svcView(s) } };
      }
      case 'DeleteService': {
        const key = `${clusterOf(b.cluster)}/${String(b.service).split('/').pop()}`;
        const s = this.services.get(key);
        if (!s || s.status !== 'ACTIVE') return err('ServiceNotFoundException', 'Service not found.');
        s.status = 'INACTIVE';
        return { status: 200, body: { service: svcView(s) } };
      }
    }
    return err('InvalidAction', `${action} is not offered by this fake.`);
  }

  // ---------- Elastic Load Balancing v2 (query) ----------

  elb(p: URLSearchParams): Reply {
    const action = p.get('Action') ?? '';
    const ns = 'http://elasticloadbalancing.amazonaws.com/doc/2015-12-01/';
    const ok = (inner: string): Reply => ({ status: 200, headers: { 'content-type': 'text/xml' }, body: `<?xml version="1.0" encoding="UTF-8"?><${action}Response xmlns="${ns}"><${action}Result>${inner}</${action}Result><ResponseMetadata><RequestId>${this.h.nextId('req-')}</RequestId></ResponseMetadata></${action}Response>` });
    const err = (code: string, message: string): Reply => ({ status: 400, body: `<?xml version="1.0" encoding="UTF-8"?><ErrorResponse xmlns="${ns}"><Error><Type>Sender</Type><Code>${code}</Code><Message>${xmlEsc(message)}</Message></Error><RequestId>${this.h.nextId('req-')}</RequestId></ErrorResponse>` });
    const members = (prefix: string) => [...p.entries()].filter(([k]) => new RegExp(`^${prefix}\\.member\\.\\d+$`).test(k)).map(([, v]) => v);
    const lbXml = (l: { name: string; arn: string; scheme: string; dns: string }) => `<member><LoadBalancerArn>${l.arn}</LoadBalancerArn><DNSName>${l.dns}</DNSName><LoadBalancerName>${l.name}</LoadBalancerName><Scheme>${l.scheme}</Scheme><Type>application</Type><State><Code>active</Code></State></member>`;
    const tgXml = (t: { name: string; arn: string; port: string; healthCheckPath: string }) => `<member><TargetGroupArn>${t.arn}</TargetGroupArn><TargetGroupName>${t.name}</TargetGroupName><Port>${t.port}</Port><HealthCheckPath>${t.healthCheckPath}</HealthCheckPath></member>`;
    switch (action) {
      case 'CreateLoadBalancer': {
        const name = p.get('Name')!;
        const l = this.loadBalancers.get(name) ?? { name, arn: `arn:aws:elasticloadbalancing:eu-central-1:${this.h.account()}:loadbalancer/app/${name}/${this.h.nextId('')}`, scheme: p.get('Scheme') ?? 'internet-facing', dns: `${p.get('Scheme') === 'internal' ? 'internal-' : ''}${name}-1234.eu-central-1.elb.amazonaws.com`, subnets: members('Subnets'), securityGroups: members('SecurityGroups') };
        this.loadBalancers.set(name, l);
        return ok(`<LoadBalancers>${lbXml(l)}</LoadBalancers>`);
      }
      case 'DescribeLoadBalancers': {
        const names = members('Names');
        const list = [...this.loadBalancers.values()].filter((l) => !names.length || names.includes(l.name));
        if (names.length && !list.length) return err('LoadBalancerNotFound', 'One or more load balancers not found');
        return ok(`<LoadBalancers>${list.map(lbXml).join('')}</LoadBalancers>`);
      }
      case 'DeleteLoadBalancer': {
        const l = [...this.loadBalancers.values()].find((x) => x.arn === p.get('LoadBalancerArn'));
        if (l) this.loadBalancers.delete(l.name);
        for (let i = this.listeners.length - 1; i >= 0; i--) if (this.listeners[i]!.lbArn === p.get('LoadBalancerArn')) this.listeners.splice(i, 1);
        return ok('');
      }
      case 'CreateTargetGroup': {
        const name = p.get('Name')!;
        const t = this.targetGroups.get(name) ?? { name, arn: `arn:aws:elasticloadbalancing:eu-central-1:${this.h.account()}:targetgroup/${name}/${this.h.nextId('')}`, port: p.get('Port') ?? '80', healthCheckPath: p.get('HealthCheckPath') ?? '/' };
        this.targetGroups.set(name, t);
        return ok(`<TargetGroups>${tgXml(t)}</TargetGroups>`);
      }
      case 'DescribeTargetGroups': {
        const names = members('Names');
        const list = [...this.targetGroups.values()].filter((t) => !names.length || names.includes(t.name));
        if (names.length && !list.length) return err('TargetGroupNotFound', 'One or more target groups not found');
        return ok(`<TargetGroups>${list.map(tgXml).join('')}</TargetGroups>`);
      }
      case 'DeleteTargetGroup': {
        const t = [...this.targetGroups.values()].find((x) => x.arn === p.get('TargetGroupArn'));
        if (t) this.targetGroups.delete(t.name);
        return ok('');
      }
      case 'CreateListener': {
        const l = { lbArn: p.get('LoadBalancerArn')!, arn: `${p.get('LoadBalancerArn')}/listener/${this.h.nextId('')}`, protocol: p.get('Protocol')!, port: p.get('Port')!, certificate: p.get('Certificates.member.1.CertificateArn') };
        this.listeners.push(l);
        return ok(`<Listeners><member><ListenerArn>${l.arn}</ListenerArn><Protocol>${l.protocol}</Protocol><Port>${l.port}</Port></member></Listeners>`);
      }
      case 'DescribeListeners':
        return ok(`<Listeners>${this.listeners.filter((l) => l.lbArn === p.get('LoadBalancerArn')).map((l) => `<member><ListenerArn>${l.arn}</ListenerArn><Protocol>${l.protocol}</Protocol><Port>${l.port}</Port></member>`).join('')}</Listeners>`);
    }
    return err('InvalidAction', `${action} is not offered by this fake.`);
  }

  // ---------- Secrets Manager (JSON 1.1) ----------

  secretsManager(r: RecordedRequest): Reply {
    const action = r.op.split(':')[1]!;
    const b = (r.body ? JSON.parse(r.body) : {}) as Record<string, unknown>;
    const err = (code: string, message: string): Reply => ({ status: 400, headers: { 'x-amzn-errortype': code }, body: { __type: code, Message: message } });
    const arnOf = (name: string) => `arn:aws:secretsmanager:eu-central-1:${this.h.account()}:secret:${name}-AbCdEf`;
    switch (action) {
      case 'CreateSecret': {
        const name = String(b.Name);
        if (this.secrets.has(name)) return err('ResourceExistsException', `The operation failed because the secret ${name} already exists.`);
        const sct = { name, arn: arnOf(name), value: String(b.SecretString ?? ''), versions: 1 };
        this.secrets.set(name, sct);
        return { status: 200, body: { ARN: sct.arn, Name: name, VersionId: 'v1' } };
      }
      case 'PutSecretValue': {
        const sct = this.secrets.get(String(b.SecretId));
        if (!sct) return err('ResourceNotFoundException', 'Secrets Manager can’t find the specified secret.');
        sct.value = String(b.SecretString ?? '');
        sct.versions += 1;
        return { status: 200, body: { ARN: sct.arn, Name: sct.name, VersionId: `v${sct.versions}` } };
      }
      case 'ListSecrets': {
        const prefix = ((b.Filters as { Key: string; Values: string[] }[] | undefined) ?? []).find((f) => f.Key === 'name')?.Values[0] ?? '';
        return { status: 200, body: { SecretList: [...this.secrets.values()].filter((s) => s.name.startsWith(prefix)).map((s) => ({ ARN: s.arn, Name: s.name })) } };
      }
      case 'DeleteSecret': {
        const sct = this.secrets.get(String(b.SecretId));
        if (!sct) return err('ResourceNotFoundException', 'Secrets Manager can’t find the specified secret.');
        this.secrets.delete(sct.name);
        return { status: 200, body: { ARN: sct.arn, Name: sct.name } };
      }
    }
    return err('InvalidAction', `${action} is not offered by this fake.`);
  }
}
