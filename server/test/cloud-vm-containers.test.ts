import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Principal } from '../src/authz/policy.js';
import { BOOTSTRAP_PLACEHOLDER, computeProblems, type SecretBroker } from '../src/cloud/compute.js';
import type { DesiredResource } from '../src/cloud/graph.js';
import { AwsProvider, AzureProvider, DigitalOceanProvider, type AdapterCredential, type CallContext, type CloudProvider, type OperationResult, type ResourceSpec, type SecretBinding } from '../src/cloud/providers/index.js';
import { ProviderRegistry } from '../src/cloud/providers/registry.js';
import { renderGraph } from '../src/cloud/render.js';
import { deploymentSpecSchema, type DeploymentSpec, type DeploymentSpecInput } from '../src/cloud/spec.js';
import { cloudTags } from '../src/cloud/tags.js';
import type { CloudAccount, Provider } from '../src/cloud/types.js';
import { servicePolicy } from '../src/platform/egress.js';
import { DEFAULT_ZONES, type ZoneSpec } from '../src/zones/spec.js';
import { seedAccount } from './cloud-credentials-helpers.js';
import { FakeAws } from './fake-aws.js';
import { FakeAzure } from './fake-azure.js';
import { FakeDigitalOcean } from './fake-do.js';
import { harness, type Harness } from './helpers.js';

/*
 * 1.9.99-final, Sprint 58 (B-10204, B-10205): VMs and container platforms against the fakes (127.0.0.1 only, no
 * network, never a real cloud). VMs per provider: cloud-init user data that runs `install.sh --from-release` with the
 * pinned digest, IMDSv2 required with hop limit 1 on EC2, secrets as systemd credentials (never variables), and a
 * tampered tarball refused by the installer and failing verify through the `vm.install` readiness check. Containers:
 * ECS on Fargate, Container Apps and App Platform rendered and created, the migration as a one-off task or job before
 * the rollout, secrets as files or through the platform's store with the key-encryption key in OpenBao, and no plain
 * DATA_KEY in any of them (the planner refuses a graph that has one).
 */

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

const ALLOWED = '127.0.0.1,::1,localhost';
const policy = servicePolicy({ SERVICE_ALLOWED_HOSTS: '127.0.0.1' });
const transport = { sleep: async () => undefined, random: () => 0.5, maxRetryWaitMs: 60_000 };
const zones = (): Map<string, { version: number; spec: ZoneSpec }> => new Map(DEFAULT_ZONES.map((z) => [z.id, { version: 1, spec: structuredClone(z.spec) }]));

const RELEASE_URL = 'https://releases.example.test/exprsn-ai-1.0.0.tar.gz';
const GOOD = createHash('sha256').update('the release tarball').digest('hex');
const TAMPERED = createHash('sha256').update('the release tarball, with a backdoor').digest('hex');
const IMAGE = `ghcr.io/exprsn/exprsn-ai@sha256:${'a'.repeat(64)}`;
const SECRET_VALUE = (b: SecretBinding) => `value-of-${b.name}-${'x'.repeat(8)}`;

const REGION: Record<Provider, string> = { aws: 'eu-central-1', azure: 'westeurope', digitalocean: 'fra1', cloudflare: 'global' };

function spec(provider: 'aws' | 'azure' | 'digitalocean', shape: 'vm' | 'container', extra: Partial<DeploymentSpecInput> = {}): DeploymentSpec {
  return deploymentSpecSchema.parse({
    name: `lab-${shape}`,
    target: { provider, accountId: ulid(), region: REGION[provider] },
    compute: { shape, size: 'small' },
    data: { mode: 'existing', databaseUrlRef: 'vault:cloud/lab#database_url', redisUrlRef: 'vault:cloud/lab#redis_url' },
    frontDoor: { kind: 'cloudflare', accountId: ulid(), hostname: 'ai.example.test', zone: 'example.test' },
    release: { version: '1.0.0', tarball: { url: RELEASE_URL, sha256: GOOD }, image: IMAGE },
    keys: { provider: 'openbao', addr: 'https://bao.example.test' },
    ...extra
  });
}

const graph = (s: DeploymentSpec) => renderGraph(s, { zones: zones(), corporateCidrs: [] });

const account = (provider: CloudAccount['provider'], name: string, ids: CloudAccount['providerIds']): CloudAccount => ({ id: `acc-${name}`, name, provider, scope: 'platform', tenantId: null, providerIds: ids, credentialMode: 'vaulted', defaultRegion: REGION[provider], state: 'active', description: null, regions: [], validation: null, createdBy: null, createdAt: 0, updatedAt: 0 });

const wraps: SecretBinding[][] = [];
const broker = {
  value: async (b: SecretBinding) => SECRET_VALUE(b),
  wrap: async (list: SecretBinding[]) => {
    wraps.push(list);
    return { token: 's.single-use-wrap', addr: 'https://bao.example.test', ttlSeconds: 900 };
  }
};

const settle = async (p: CloudProvider, ctx: CallContext, r: OperationResult, rounds = 30) => {
  if (r.done) return r.resource;
  for (let i = 0; i < rounds; i++) {
    const s = await p.poll(ctx, JSON.parse(JSON.stringify(r.operation)));
    if (s.state === 'succeeded') return s.resource;
    if (s.state === 'failed') throw Object.assign(new Error(s.error), { code: s.code });
  }
  throw new Error('still pending');
};

/** A rendered resource as the adapter gets it, its dependencies' provider ids made up (the fakes take any). */
function specOf(r: DesiredResource, name: string, refs: Record<string, string> = {}, networkId?: string): ResourceSpec {
  const ids = Object.fromEntries(r.dependsOn.map((k) => [k, refs[k] ?? `id-${k}`]));
  return { type: r.type, name, idempotencyKey: `${name}-step`, tags: cloudTags({ account: 'lab', deployment: 'lab' }), parent: { ...(networkId ? { networkId } : {}), refs: ids }, props: r.spec as never };
}

const azureCred = (fake: FakeAzure, tenant: string): AdapterCredential => {
  const app = fake.addApp({ tenantId: tenant, secret: true });
  return {
    kind: 'azure',
    tenantId: tenant,
    getToken: async (scope) => {
      const r = await fetch(`${fake.url}/${tenant}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: app.clientId, client_secret: app.secret!, scope }) });
      const j = (await r.json()) as { access_token: string; expires_in: number };
      return { token: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
    }
  };
};

const userDataOf = (b64: string | null | undefined) => Buffer.from(b64 ?? '', 'base64').toString('utf8');
const SECRET_NAMES = /^\s*(DATA_KEY|SESSION_SECRET|DATABASE_URL|REDIS_URL|OPENBAO_TOKEN)=/m;

// ---------------------------------------------------------------- the render

describe('rendering VMs and containers (B-10204, B-10205)', () => {
  it('renders app VMs whose cloud-init runs the installer from the release with the pinned digest, secrets as systemd credentials', () => {
    for (const provider of ['aws', 'azure', 'digitalocean'] as const) {
      const g = graph(spec(provider, 'vm'));
      const vms = g.resources.filter((r) => r.type === 'vm' && r.spec.role === 'app');
      expect(vms).toHaveLength(1);
      const p = vms[0]!.spec as Record<string, unknown> & { userData: string; secrets: SecretBinding[] };
      expect(p).toMatchObject({ imdsV2: true, metadataHopLimit: 1, publicIp: false, install: { from: 'release', url: RELEASE_URL, sha256: GOOD } });
      expect(p.userData).toMatch(/^#cloud-config\n/);
      expect(p.userData).toContain(`install.sh" --from-release '${RELEASE_URL}' --sha256 ${GOOD}`);
      expect(p.userData).toContain(`[ "$got" = "$SHA" ] || { say "refused sha256 mismatch`); // the bootstrap checks before extracting
      expect(p.userData).toContain('--credentials-wrapped /run/exprsn-bootstrap/token');
      expect(p.userData).toContain(`content: '${BOOTSTRAP_PLACEHOLDER}'`);
      // Secrets are systemd credentials by name and reference; the env file holds settings only.
      expect(p.secrets.map((b) => b.name)).toEqual(['session_secret', 'database_url', 'redis_url', 'openbao_token']);
      expect(p.secrets.every((b) => b.ref.startsWith('vault:'))).toBe(true);
      expect(p.userData).not.toMatch(SECRET_NAMES);
      expect(p.userData).not.toContain('DATA_KEY');
      expect(p.userData).toContain('KMS_PROVIDER=openbao');
      expect(computeProblems(g.resources)).toEqual([]);
    }
  });

  it('renders ECS, Container Apps and App Platform with a one-off migration and no DATA_KEY, and the planner check refuses one', () => {
    const want = { aws: ['ecs-fargate', 'platform'], azure: ['container-apps', 'files'], digitalocean: ['app-platform', 'platform'] } as const;
    for (const provider of ['aws', 'azure', 'digitalocean'] as const) {
      const g = graph(spec(provider, 'container'));
      const app = g.resources.find((r) => r.type === 'container_service')!;
      expect(app.spec).toMatchObject({ platform: want[provider][0], secretDelivery: want[provider][1], image: IMAGE, migrate: { command: ['node', 'server/dist/cli.js', 'migrate'] } });
      expect(g.resources.some((r) => r.type === 'load_balancer')).toBe(false); // ECS owns its ALB
      const env = app.spec.env as Record<string, string>;
      expect(Object.keys(env)).not.toContain('DATA_KEY');
      expect(env.KMS_PROVIDER).toBe('openbao');
      if (provider === 'azure') expect(env.SESSION_SECRET_FILE).toBe('/run/secrets/exprsn/session-secret');
      expect(computeProblems(g.resources)).toEqual([]);
      // The render check: DATA_KEY as a plain variable is refused on every platform.
      const bad = structuredClone(g.resources);
      (bad.find((r) => r.type === 'container_service')!.spec.env as Record<string, string>).DATA_KEY = 'AAAA';
      expect(computeProblems(bad)).toEqual([expect.stringMatching(/^app \(container_service\): DATA_KEY is set as a plain environment variable/)]);
      // So is DATA_KEY through the platform's secret store where it would arrive as a variable.
      const viaStore = structuredClone(g.resources);
      (viaStore.find((r) => r.type === 'container_service')!.spec.secrets as SecretBinding[]).push({ name: 'data_key', env: 'DATA_KEY', ref: 'vault:cloud/lab#data_key' });
      expect(computeProblems(viaStore).length > 0).toBe(provider !== 'azure');
    }
  });

  it('refuses a VM graph without IMDSv2 and hop limit 1, without a pinned release, or with a secret in the user data', () => {
    const g = graph(spec('aws', 'vm'));
    const mutate = (f: (p: Record<string, unknown>) => void) => {
      const copy = structuredClone(g.resources);
      f(copy.find((r) => r.key === 'app-1')!.spec);
      return computeProblems(copy);
    };
    expect(mutate((p) => (p.metadataHopLimit = 2))).toEqual([expect.stringMatching(/IMDSv2 tokens with a hop limit of 1/)]);
    expect(mutate((p) => ((p.install as Record<string, unknown>).sha256 = null))).toEqual([expect.stringMatching(/no signed release pinned/)]);
    expect(mutate((p) => (p.userData = `${String(p.userData)}\n      DATA_KEY=c2VjcmV0\n`))).toEqual([expect.stringMatching(/sets DATA_KEY inline/)]);
  });

  it('wires the cloud KMS (B-10208) where the platform takes its credential as a file, never as a variable', () => {
    const awsKms = { provider: 'aws-kms', region: 'eu-central-1', accessKeyId: 'AKIAEXAMPLEEXAMPLE', secretRef: 'vault:cloud/lab#kms' } as const;
    const vm = graph(spec('aws', 'vm', { keys: awsKms })).resources.find((r) => r.key === 'app-1')!.spec as { userData: string; secrets: SecretBinding[] };
    expect(vm.secrets.map((b) => b.env)).toEqual(['SESSION_SECRET', 'DATABASE_URL', 'REDIS_URL', 'KMS_AWS_SECRET_ACCESS_KEY']);
    expect(vm.userData).toContain('KMS_PROVIDER=aws-kms');
    expect(vm.userData).toContain('--kms aws-kms');
    expect(vm.userData).not.toMatch(/^\s*KMS_AWS_SECRET_ACCESS_KEY=/m);
    const kv = { provider: 'azure-keyvault', vaultUrl: 'https://lab.vault.azure.net', tenantId: '00000000-0000-4000-8000-000000000001', clientId: '00000000-0000-4000-8000-000000000002', secretRef: 'vault:cloud/lab#azure' } as const;
    const aca = graph(spec('azure', 'container', { keys: kv }));
    const env = aca.resources.find((r) => r.type === 'container_service')!.spec.env as Record<string, string>;
    expect(env).toMatchObject({ KMS_PROVIDER: 'azure-keyvault', AZURE_IDENTITY_CLIENT_SECRET_FILE: '/run/secrets/exprsn/azure-identity-secret' });
    expect(computeProblems(aca.resources)).toEqual([]);
    // ECS would hand KMS_AWS_SECRET_ACCESS_KEY over as a variable, which production refuses: the check says so.
    const ecs = graph(spec('aws', 'container', { keys: awsKms }));
    expect(computeProblems(ecs.resources)).toEqual([expect.stringMatching(/KMS_AWS_SECRET_ACCESS_KEY would reach the app as a variable/)]);
  });

  it('pins the release: https tarballs and images by digest only', () => {
    const s0 = spec('aws', 'vm');
    expect(deploymentSpecSchema.safeParse({ ...s0, release: { tarball: { url: 'http://releases.example.test/x.tar.gz', sha256: GOOD } } }).success).toBe(false);
    expect(deploymentSpecSchema.safeParse({ ...s0, release: { image: 'ghcr.io/exprsn/exprsn-ai:latest' } }).success).toBe(false);
    expect(deploymentSpecSchema.safeParse({ ...s0, keys: { provider: 'aws-kms', region: 'eu-central-1', accessKeyId: 'AKIAEXAMPLEEXAMPLE', secretRef: 'vault:cloud/lab#kms' } }).success).toBe(true);
  });
});

// ---------------------------------------------------------------- VMs against the fakes

describe('VMs on EC2, Azure and DigitalOcean (B-10204)', () => {
  const aws = new FakeAws();
  const az = new FakeAzure();
  const dof = new FakeDigitalOcean();
  const tenant = 'tenant-vm';
  const sub = '00000000-0000-4000-8000-0000000000cc';
  let pa: AwsProvider;
  let pz: AzureProvider;
  let pd: DigitalOceanProvider;
  let ca: CallContext;
  let cz: CallContext;
  let cd: CallContext;

  beforeAll(async () => {
    await aws.start();
    await az.start();
    await dof.start();
    az.publicOrigin = 'https://management.azure.com';
    az.addSubscription(sub, tenant);
    const key = aws.addUser({ userName: 'exprsn' });
    pa = new AwsProvider({ policy, ...transport, endpoints: { sts: aws.url, ec2: aws.url } });
    ca = { account: account('aws', 'lab', { awsAccountId: aws.account }), cred: { kind: 'aws', accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey, expiresAt: null }, region: 'eu-central-1', secrets: broker };
    pz = new AzureProvider({ policy, ...transport, testOrigins: { 'https://management.azure.com': az.url } });
    cz = { account: account('azure', 'lab', { azureTenantId: tenant, azureSubscriptionId: sub }), cred: azureCred(az, tenant), region: 'westeurope', secrets: broker };
    pd = new DigitalOceanProvider({ policy, ...transport, endpoints: { api: dof.url } });
    cd = { account: account('digitalocean', 'lab', { doTeamId: 'team' }), cred: { kind: 'token', token: dof.addToken() }, region: 'fra1', secrets: broker };
  });
  afterAll(async () => {
    await aws.stop();
    await az.stop();
    await dof.stop();
  });

  it('EC2: RunInstances with the client token, IMDSv2 required at hop limit 1, the wrapped token in the user data; the console reports the install', async () => {
    aws.compute.releases.set(RELEASE_URL, GOOD);
    const r = graph(spec('aws', 'vm')).resources.find((x) => x.key === 'app-1')!;
    const s = specOf(r, 'lab-app-1');
    const vm = await settle(pa, ca, await pa.create(ca, s));
    expect(vm).toMatchObject({ type: 'vm', state: 'ready', props: { imdsV2: true, metadataHopLimit: 1, publicIp: false } });
    const inst = aws.compute.instances.get(vm!.providerId)!;
    expect(inst).toMatchObject({ HttpTokens: 'required', HopLimit: 1, HttpEndpoint: 'enabled', PublicIp: null, ImageId: expect.stringMatching(/^resolve:ssm:\/aws\/service\/canonical\/ubuntu\/server\/24\.04\//) });
    expect(inst.BlockDevices).toEqual([{ encrypted: true }]);
    expect(inst.Tags).toMatchObject({ 'exprsn:managed': 'true', 'exprsn:account': 'lab', 'exprsn:name': 'lab-app-1' });
    const ud = userDataOf(inst.UserData);
    expect(ud).toContain(`--from-release '${RELEASE_URL}' --sha256 ${GOOD}`);
    expect(ud).not.toContain(BOOTSTRAP_PLACEHOLDER);
    expect(ud).toContain(`content: '{"addr":"https://bao.example.test","token":"s.single-use-wrap","ttl":900}'`);
    // Secret values never reach the user data: only the single-use token that unwraps them.
    for (const b of wraps.at(-1)!) expect(ud).not.toContain(SECRET_VALUE(b));
    expect(wraps.at(-1)!.map((b) => b.name)).toEqual(['session_secret', 'database_url', 'redis_url', 'openbao_token']);
    expect(ud).not.toMatch(SECRET_NAMES);
    // The retried create (lost response) is the same instance: the client token, then the tag lookup.
    expect(await pa.create(ca, s)).toMatchObject({ done: true, adopted: true, resource: { providerId: vm!.providerId } });
    expect(aws.calls('ec2:RunInstances')).toHaveLength(1);
    expect(await pa.vmInstallStatus(ca, vm!)).toMatchObject({ state: 'installed' });
    // Drift on the metadata options is put back by an update.
    inst.HopLimit = 3;
    expect(await pa.describe(ca, vm!)).toMatchObject({ props: { metadataHopLimit: 3 } });
    await pa.update(ca, vm!, s);
    expect(inst.HopLimit).toBe(1);
    await settle(pa, ca, await pa.delete(ca, vm!));
    expect(await pa.describe(ca, vm!)).toBeNull();
  });

  it('EC2: a tampered tarball is refused by the installer, and the console says so', async () => {
    aws.compute.releases.set(RELEASE_URL, TAMPERED);
    const r = graph(spec('aws', 'vm')).resources.find((x) => x.key === 'app-1')!;
    const vm = await settle(pa, ca, await pa.create(ca, specOf(r, 'lab-tampered-1')));
    const st = await pa.vmInstallStatus(ca, vm!);
    expect(st).toMatchObject({ state: 'refused', detail: expect.stringContaining(`sha256 mismatch: expected ${GOOD}, got ${TAMPERED}`) });
  });

  it('Azure: a NIC without a public address and a Trusted Launch VM with customData; boot diagnostics report the install', async () => {
    az.compute.releases.set(RELEASE_URL, GOOD);
    const r = graph(spec('azure', 'vm')).resources.find((x) => x.key === 'app-1')!;
    const s = specOf(r, 'lab-app-1', { [r.spec.subnet as string]: `/subscriptions/${sub}/resourceGroups/exprsn-lab/providers/Microsoft.Network/virtualNetworks/n/subnets/app` });
    const vm = await settle(pz, cz, await pz.create(cz, s));
    expect(vm).toMatchObject({ type: 'vm', state: 'ready', props: { publicIp: false, trustedLaunch: true } });
    const stored = az.resources.get(vm!.providerId.toLowerCase())!;
    const props = stored.body.properties as { osProfile: { customData: string; linuxConfiguration: { disablePasswordAuthentication: boolean } }; diagnosticsProfile: { bootDiagnostics: { enabled: boolean } } };
    expect(props.osProfile.linuxConfiguration.disablePasswordAuthentication).toBe(true);
    expect(props.diagnosticsProfile.bootDiagnostics.enabled).toBe(true);
    const ud = userDataOf(props.osProfile.customData);
    expect(ud).toContain(`--from-release '${RELEASE_URL}' --sha256 ${GOOD}`);
    expect(ud).not.toMatch(SECRET_NAMES);
    const nic = [...az.resources.values()].find((x) => x.type === 'Microsoft.Network/networkInterfaces')!;
    expect(JSON.stringify(nic.body)).not.toMatch(/publicIPAddress/i);
    expect(await pz.create(cz, s)).toMatchObject({ done: true, adopted: true });
    expect(await pz.vmInstallStatus(cz, vm!)).toMatchObject({ state: 'installed' });
    az.compute.releases.set(RELEASE_URL, TAMPERED);
    expect(await pz.vmInstallStatus(cz, vm!)).toMatchObject({ state: 'refused', detail: expect.stringContaining('sha256 mismatch') });
  });

  it('DigitalOcean: the droplet gets the same user data; DigitalOcean has no console read', async () => {
    const r = graph(spec('digitalocean', 'vm')).resources.find((x) => x.key === 'app-1')!;
    const net = await settle(pd, cd, await pd.create(cd, { type: 'network', name: 'lab-net', idempotencyKey: 'n', tags: cloudTags({ account: 'lab', deployment: 'lab' }), props: { cidr: '10.64.0.0/20' } }));
    const vm = await settle(pd, cd, await pd.create(cd, specOf(r, 'lab-app-1', {}, net!.providerId)));
    const ud = dof.userData.get(Number(vm!.providerId))!;
    expect(ud).toContain(`--from-release '${RELEASE_URL}' --sha256 ${GOOD}`);
    expect(ud).toContain('"token":"s.single-use-wrap"');
    expect(ud).not.toMatch(SECRET_NAMES);
    expect((pd as CloudProvider).vmInstallStatus).toBeUndefined();
  });
});

// ---------------------------------------------------------------- containers against the fakes

describe('container platforms (B-10205)', () => {
  const aws = new FakeAws();
  const az = new FakeAzure();
  const dof = new FakeDigitalOcean();
  const tenant = 'tenant-apps';
  const sub = '00000000-0000-4000-8000-0000000000ce';
  let pa: AwsProvider;
  let pz: AzureProvider;
  let pd: DigitalOceanProvider;
  let ca: CallContext;
  let cz: CallContext;
  let cd: CallContext;
  const allBodies = (f: FakeAws | FakeAzure | FakeDigitalOcean) => f.requests.map((r) => r.body).join('\n');

  beforeAll(async () => {
    await aws.start();
    await az.start();
    await dof.start();
    az.publicOrigin = 'https://management.azure.com';
    az.addSubscription(sub, tenant);
    const key = aws.addUser({ userName: 'exprsn' });
    pa = new AwsProvider({ policy, ...transport, endpoints: { sts: aws.url, ec2: aws.url, ecs: aws.url, elbv2: aws.url, secretsmanager: aws.url } });
    ca = { account: account('aws', 'lab', { awsAccountId: aws.account }), cred: { kind: 'aws', accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey, expiresAt: null }, region: 'eu-central-1', secrets: broker };
    pz = new AzureProvider({ policy, ...transport, testOrigins: { 'https://management.azure.com': az.url } });
    cz = { account: account('azure', 'lab', { azureTenantId: tenant, azureSubscriptionId: sub }), cred: azureCred(az, tenant), region: 'westeurope', secrets: broker };
    pd = new DigitalOceanProvider({ policy, ...transport, endpoints: { api: dof.url } });
    cd = { account: account('digitalocean', 'lab', { doTeamId: 'team' }), cred: { kind: 'token', token: dof.addToken() }, region: 'fra1', secrets: broker };
  });
  afterAll(async () => {
    await aws.stop();
    await az.stop();
    await dof.stop();
  });

  it('ECS on Fargate: cluster, secrets in Secrets Manager, the service’s internal ALB, the migration task first, then the service', async () => {
    const g = graph(spec('aws', 'container'));
    const r = g.resources.find((x) => x.type === 'container_service')!;
    const svc = await settle(pa, ca, await pa.create(ca, specOf(r, 'lab-app', {}, 'vpc-1')));
    expect(svc).toMatchObject({ type: 'container_service', state: 'ready', props: { platform: 'ecs-fargate', image: IMAGE, replicas: 1, address: expect.stringMatching(/^internal-ex-[0-9a-f]{12}-lb/) } });
    // The migration ran as a one-off task with the command overridden, before the service existed.
    const runs = aws.calls('ecs:RunTask');
    expect(runs).toHaveLength(1);
    expect(JSON.parse(runs[0]!.body).overrides.containerOverrides[0].command).toEqual(['node', 'server/dist/cli.js', 'migrate']);
    expect(aws.requests.findIndex((x) => x.op === 'ecs:RunTask')).toBeLessThan(aws.requests.findIndex((x) => x.op === 'ecs:CreateService'));
    // The task definition: settings in environment, secrets by ARN, no DATA_KEY anywhere.
    const td = JSON.parse(aws.calls('ecs:RegisterTaskDefinition')[0]!.body) as { containerDefinitions: { environment: { name: string; value: string }[]; secrets: { name: string; valueFrom: string }[] }[] };
    const c = td.containerDefinitions[0]!;
    expect(c.environment.map((e) => e.name)).not.toContain('DATA_KEY');
    expect(c.environment.find((e) => e.name === 'KMS_PROVIDER')!.value).toBe('openbao');
    expect(c.secrets.map((x) => x.name).sort()).toEqual(['DATABASE_URL', 'OPENBAO_TOKEN', 'REDIS_URL', 'SESSION_SECRET']);
    expect(c.secrets.every((x) => x.valueFrom.startsWith('arn:aws:secretsmanager:'))).toBe(true);
    expect(allBodies(aws)).not.toContain('DATA_KEY');
    // Values went to Secrets Manager only.
    expect([...aws.compute.secrets.values()].map((x) => x.value).sort()).toEqual(['database_url', 'openbao_token', 'redis_url', 'session_secret'].map((n) => SECRET_VALUE({ name: n } as SecretBinding)).sort());
    for (const x of aws.requests.filter((q) => !q.op.startsWith('secretsmanager:'))) expect(x.body).not.toContain('value-of-');
    // The internal ALB: target group on /readyz, an HTTP listener (behind the tunnel, no certificate needed).
    expect([...aws.compute.loadBalancers.values()][0]).toMatchObject({ scheme: 'internal' });
    expect([...aws.compute.targetGroups.values()][0]).toMatchObject({ port: '8080', healthCheckPath: '/readyz' });
    expect(aws.compute.listeners).toEqual([expect.objectContaining({ protocol: 'HTTP', port: '80' })]);
    // A new image: a new task definition, the migration again, then the service moved.
    const next = { ...(r.spec as Record<string, unknown>), image: `ghcr.io/exprsn/exprsn-ai@sha256:${'b'.repeat(64)}` };
    const updated = await settle(pa, ca, await pa.update(ca, svc!, { ...specOf(r, 'lab-app', {}, 'vpc-1'), props: next as never }));
    expect(updated).toMatchObject({ props: { image: next.image } });
    expect(aws.calls('ecs:RunTask')).toHaveLength(2);
    // Delete removes the service, the ALB, the secrets and the cluster.
    await settle(pa, ca, await pa.delete(ca, svc!));
    expect(aws.compute.loadBalancers.size + aws.compute.targetGroups.size + aws.compute.secrets.size + aws.compute.clusters.size).toBe(0);
  });

  it('ECS: a failed migration stops the rollout; no service is created', async () => {
    aws.compute.migrationExitCode = 1;
    const r = graph(spec('aws', 'container', { name: 'lab-bad' })).resources.find((x) => x.type === 'container_service')!;
    await expect(settle(pa, ca, await pa.create(ca, specOf(r, 'lab-bad-app', {}, 'vpc-1')))).rejects.toMatchObject({ code: 'migration_failed' });
    expect([...aws.compute.services.keys()].some((k) => k.endsWith('lab-bad-app'))).toBe(false);
    aws.compute.migrationExitCode = 0;
  });

  it('Container Apps: environment, the migration job started and finished, then the app with secrets mounted as files', async () => {
    const r = graph(spec('azure', 'container')).resources.find((x) => x.type === 'container_service')!;
    const app = await settle(pz, cz, await pz.create(cz, specOf(r, 'lab-app')));
    expect(app).toMatchObject({ state: 'ready', props: { platform: 'container-apps', image: IMAGE, address: expect.stringContaining('.internal.'), revision: 'exprsn-lab-lab-app--r100' } });
    expect([...az.compute.executions.values()]).toEqual([expect.objectContaining({ status: 'Succeeded', command: ['node', 'server/dist/cli.js', 'migrate'] })]);
    const ids = az.requests.map((x) => `${x.method} ${x.path}`);
    expect(ids.findIndex((x) => /POST .*\/jobs\/.+\/start$/.test(x))).toBeLessThan(ids.findIndex((x) => /PUT .*\/containerApps\//.test(x)));
    const stored = [...az.resources.values()].find((x) => x.type === 'Microsoft.App/containerApps')!;
    const tpl = (stored.body.properties as { template: { containers: { env: { name: string; value?: string; secretRef?: string }[]; volumeMounts: unknown[] }[]; volumes: { storageType: string }[] } }).template;
    const env = Object.fromEntries(tpl.containers[0]!.env.map((e) => [e.name, e.value]));
    expect(env).toMatchObject({ SESSION_SECRET_FILE: '/run/secrets/exprsn/session-secret', OPENBAO_TOKEN_FILE: '/run/secrets/exprsn/openbao-token', KMS_PROVIDER: 'openbao' });
    for (const k of ['DATA_KEY', 'SESSION_SECRET', 'DATABASE_URL', 'OPENBAO_TOKEN']) expect(k in env).toBe(false);
    expect(tpl.volumes).toEqual([expect.objectContaining({ storageType: 'Secret' })]);
    expect(allBodies(az)).not.toContain('DATA_KEY');
  });

  it('App Platform: one app spec with a PRE_DEPLOY migration job and SECRET values, never DATA_KEY; a failed migration fails the deployment', async () => {
    const r = graph(spec('digitalocean', 'container')).resources.find((x) => x.type === 'container_service')!;
    const app = await settle(pd, cd, await pd.create(cd, specOf(r, 'lab-app', {}, 'vpc-1')));
    expect(app).toMatchObject({ state: 'ready', props: { platform: 'app-platform', image: IMAGE } });
    const stored = [...dof.appPlatform.apps.values()][0]!;
    const svc = (stored.spec.services as { envs: { key: string; type: string; value: string }[]; image: Record<string, string>; health_check: { http_path: string } }[])[0]!;
    expect(svc.image).toMatchObject({ registry_type: 'GHCR', registry: 'exprsn', repository: 'exprsn-ai', digest: `sha256:${'a'.repeat(64)}` });
    expect(svc.health_check.http_path).toBe('/readyz');
    expect(svc.envs.filter((e) => e.type === 'SECRET').map((e) => e.key).sort()).toEqual(['DATABASE_URL', 'OPENBAO_TOKEN', 'REDIS_URL', 'SESSION_SECRET']);
    expect(svc.envs.map((e) => e.key)).not.toContain('DATA_KEY');
    expect(stored.spec.jobs).toEqual([expect.objectContaining({ name: 'migrate', kind: 'PRE_DEPLOY', run_command: 'node server/dist/cli.js migrate' })]);
    expect(allBodies(dof)).not.toContain('DATA_KEY');
    dof.appPlatform.migrationFails = true;
    const next = { ...(r.spec as Record<string, unknown>), image: `ghcr.io/exprsn/exprsn-ai@sha256:${'c'.repeat(64)}` };
    await expect(settle(pd, cd, await pd.update(cd, app!, { ...specOf(r, 'lab-app', {}, 'vpc-1'), props: next as never }))).rejects.toMatchObject({ code: 'migration_failed' });
    dof.appPlatform.migrationFails = false;
  });
});

// ---------------------------------------------------------------- the engine: plan, apply, verify

describe('the engine path: a tampered release fails verify; a plain DATA_KEY is refused at plan (B-10204, B-10205)', () => {
  let h: Harness;
  const aws = new FakeAws();
  const az = new FakeAzure();
  const tenant = 'tenant-engine';
  const sub = '00000000-0000-4000-8000-0000000000cf';
  const accounts: Partial<Record<'aws' | 'azure', CloudAccount>> = {};
  let actor: { principal: Principal; ip: string };

  beforeAll(async () => {
    await aws.start();
    await az.start();
    az.publicOrigin = 'https://management.azure.com';
    az.addSubscription(sub, tenant);
    h = await harness({ SERVICE_ALLOWED_HOSTS: ALLOWED });
    if (!(await h.s.db.schema.hasTable('cloud_deployments'))) await (await import('../src/db/migrations/148_cloud_journal.js')).up(h.s.db);
    h.s.cloud.deployments.resetSchemaCache();
    const key = aws.addUser({ userName: 'exprsn' });
    const azCred = azureCred(az, tenant);
    const registry = new ProviderRegistry({ policy: servicePolicy({ SERVICE_ALLOWED_HOSTS: ALLOWED }), endpoints: { aws: { sts: aws.url, eks: aws.url, iam: aws.url, ec2: aws.url, s3: aws.url, route53: aws.url, ecs: aws.url, elbv2: aws.url, secretsmanager: aws.url, rds: aws.url } }, transport: { sleep: async () => undefined, random: () => 0.5, testOrigins: { 'https://management.azure.com': az.url } } });
    Object.defineProperty(h.s.cloud, 'providers', { value: registry, configurable: true });
    (h.s.cloud as { credentials: unknown }).credentials = { for: async (a: CloudAccount) => (a.provider === 'aws' ? { kind: 'aws', accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey, expiresAt: null } : azCred) };
    h.s.cloud.engine.options.sleep = async () => undefined;
    h.s.cloud.engine.hooks.secrets = { value: async (_d, b) => SECRET_VALUE(b), wrap: async () => ({ token: 's.engine-wrap', addr: 'https://bao.example.test', ttlSeconds: 900 }) } satisfies SecretBroker;
    const VALIDATED = { at: Date.now(), ok: true, identity: { ok: true }, features: [{ feature: 'deploy', name: 'Deploy', status: 'ok', required: [], missing: [], reason: null }] };
    accounts.aws = await seedAccount(h, { provider: 'aws', mode: 'vaulted', name: 'aws-lab', providerIds: { awsAccountId: aws.account }, refs: { accessKeyId: 'vault:cloud/aws-lab#id', secretAccessKey: 'vault:cloud/aws-lab#secret' } });
    accounts.azure = await seedAccount(h, { provider: 'azure', mode: 'vaulted', name: 'az-lab', providerIds: { azureTenantId: tenant, azureSubscriptionId: sub }, refs: { clientSecret: 'vault:cloud/az-lab#secret' }, params: { clientId: 'x' } });
    for (const a of Object.values(accounts)) await h.s.db('cloud_accounts').where({ id: a!.id }).update({ validation: JSON.stringify(VALIDATED) });
    actor = { principal: { kind: 'user', userId: 'u-cloud', tenantId: h.tenantId, tenantSlug: h.s.cfg.DEFAULT_TENANT, username: 'cloud', displayName: 'Cloud', roles: ['system-admin'], clearance: 'restricted', scopes: null, sessionId: null, apiKeyId: null, mfa: true }, ip: '127.0.0.1' };
  });
  afterAll(async () => {
    await h.close();
    await aws.stop();
    await az.stop();
  });

  /** The VM graph without what this sprint's VM target does not need (the edge load balancer, the data tier). */
  const vmGraph = (provider: 'aws' | 'azure') => graph(spec(provider, 'vm')).resources.filter((r) => ['network', 'subnet', 'firewall', 'vm'].includes(r.type));

  for (const provider of ['aws', 'azure'] as const) {
    it(`${provider}: the installer refuses a tampered tarball, the apply settles, and verify fails at vm.install`, async () => {
      const fake = provider === 'aws' ? aws.compute : az.compute;
      fake.releases.set(RELEASE_URL, TAMPERED);
      const d = await h.s.cloud.deployments.create(actor, { name: `vm-${provider}`, accountId: accounts[provider]!.id });
      const plan = await h.s.cloud.plans.create(actor, d.id, vmGraph(provider));
      expect(plan.blockers).toEqual([]);
      const { jobId } = await h.s.cloud.plans.apply(actor, plan.id, plan.hash);
      const outcome = await h.s.cloud.engine.apply(plan.id, { jobId, onBehalfOf: actor.principal.userId });
      expect(outcome).toMatchObject({ state: 'applied' });
      const report = await h.s.cloud.engine.verifier.run(d.id, {});
      expect(report.ok).toBe(false);
      expect(report.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'vm.install', key: 'app-1', status: 'fail', detail: expect.stringContaining('sha256 mismatch') })]));
      expect((await h.s.cloud.deployments.get(d.id))!.health).toBe('degraded');
      // A deployment built while the real release is served installs, and its install passes verify.
      fake.releases.set(RELEASE_URL, GOOD);
      const good = await h.s.cloud.deployments.create(actor, { name: `vm-${provider}-good`, accountId: accounts[provider]!.id });
      const p2 = await h.s.cloud.plans.create(actor, good.id, vmGraph(provider));
      const j2 = await h.s.cloud.plans.apply(actor, p2.id, p2.hash);
      await h.s.cloud.engine.apply(p2.id, { jobId: j2.jobId, onBehalfOf: actor.principal.userId });
      const passed = await h.s.cloud.engine.verifier.run(good.id, {});
      expect(passed.checks.find((c) => c.id === 'vm.install')).toMatchObject({ status: 'pass' });
      expect(passed.ok).toBe(true);
    });
  }

  it('refuses at plan a container service carrying DATA_KEY as a plain variable', async () => {
    const d = await h.s.cloud.deployments.create(actor, { name: 'apps-aws', accountId: accounts.aws!.id });
    const g = graph(spec('aws', 'container')).resources.filter((r) => ['network', 'subnet', 'firewall', 'container_service'].includes(r.type));
    (g.find((r) => r.type === 'container_service')!.spec.env as Record<string, string>).DATA_KEY = 'AAAA';
    const plan = await h.s.cloud.plans.create(actor, d.id, g);
    expect(plan.applicable).toBe(false);
    expect(plan.blockers).toEqual(expect.arrayContaining([expect.stringMatching(/app \(container_service\): DATA_KEY is set as a plain environment variable/)]));
    await expect(h.s.cloud.plans.apply(actor, plan.id, plan.hash)).rejects.toMatchObject({ status: 409 });
  });
});
