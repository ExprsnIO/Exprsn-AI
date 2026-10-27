import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cloudTags } from '../src/cloud/tags.js';
import type { CloudAccount } from '../src/cloud/types.js';
import { CloudValidation } from '../src/cloud/validate.js';
import {
  AwsProvider,
  AzureProvider,
  CloudflareProvider,
  CloudProviderError,
  CloudUnsupported,
  createProviderRegistry,
  DigitalOceanProvider,
  RESOURCE_TYPES,
  type AdapterCredential,
  type CallContext,
  type CloudProvider,
  type OperationResult,
  type ResourceSpec
} from '../src/cloud/providers/index.js';
import { CLOUD_PROVIDER_HOSTS, cloudAddressProblem, servicePolicy } from '../src/platform/egress.js';
import { MemoryCounterStore } from '../src/platform/ratelimit.js';
import { FakeAws } from './fake-aws.js';
import { FakeAzure } from './fake-azure.js';
import { FakeCloudflare } from './fake-cloudflare.js';
import { FakeDigitalOcean } from './fake-do.js';

/*
 * 1.9.99-final, Sprint 56 (B-10101, B-10109): the four provider adapters against their fakes, with no network: each
 * fake runs on 127.0.0.1 in this process, and the only host the test policy admits is 127.0.0.1.
 */

const policy = servicePolicy({ SERVICE_ALLOWED_HOSTS: '127.0.0.1' });
const sleeps: number[] = [];
const transport = { sleep: async (ms: number) => void sleeps.push(ms), random: () => 0.5, maxRetryWaitMs: 60_000 };

const account = (provider: CloudAccount['provider'], name: string, ids: CloudAccount['providerIds'], region: string | null): CloudAccount => ({
  id: `acc-${name}`,
  name,
  provider,
  scope: 'platform',
  tenantId: null,
  providerIds: ids,
  credentialMode: 'vaulted',
  defaultRegion: region,
  state: 'active',
  description: null,
  regions: [],
  validation: null,
  createdBy: null,
  createdAt: 0,
  updatedAt: 0
});

const settle = async (p: CloudProvider, ctx: CallContext, r: OperationResult, rounds = 5) => {
  if (r.done) return r.resource;
  for (let i = 0; i < rounds; i++) {
    const s = await p.poll(ctx, r.operation);
    if (s.state === 'succeeded') return s.resource;
    if (s.state === 'failed') throw new Error(s.error);
  }
  throw new Error('still pending');
};

beforeEach(() => {
  sleeps.length = 0;
});

// ---------------------------------------------------------------- AWS

describe('AWS adapter (SDK v3 through the egress guard)', () => {
  const fake = new FakeAws();
  let p: AwsProvider;
  let ctx: CallContext;
  let cred: AdapterCredential;
  const acct = () => ctx.account;
  const tags = cloudTags({ account: 'prod', deployment: 'main' });

  beforeAll(async () => {
    await fake.start();
    const key = fake.addUser({ userName: 'exprsn' });
    cred = { kind: 'aws', accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey, expiresAt: null };
    p = new AwsProvider({ policy, ...transport, endpoints: { sts: fake.url, iam: fake.url, ec2: fake.url, s3: fake.url, route53: fake.url, eks: fake.url, rds: fake.url } });
    ctx = { account: account('aws', 'prod', { awsAccountId: fake.account }, 'eu-central-1'), cred };
  });
  afterAll(() => fake.stop());

  it('answers identity with STS GetCallerIdentity, and a bad key as not ok', async () => {
    const id = await p.identity(cred, acct());
    expect(id).toMatchObject({ ok: true, principal: 'arn:aws:iam::123456789012:user/exprsn', providerAccount: '123456789012' });
    const bad = await p.identity({ kind: 'aws', accessKeyId: 'AKIANOPE', secretAccessKey: 'x', expiresAt: null }, acct());
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/InvalidClientTokenId/);
  });

  it('reports what is missing per feature from SimulatePrincipalPolicy, and the rest as unsupported', async () => {
    fake.deny('ec2:RunInstances').deny('bedrock:InvokeModel');
    const checks = await p.checkPermissions(cred, acct(), ['deploy', 'compute', 'models', 'frontdoor']);
    // Sprint 58: deploying VMs (B-10204) needs RunInstances too.
    expect(checks.find((c) => c.feature === 'deploy')!.missing).toEqual(['ec2:RunInstances']);
    expect(checks.find((c) => c.feature === 'compute')!.missing).toEqual(['ec2:RunInstances']);
    expect(checks.find((c) => c.feature === 'models')!.missing).toEqual(['bedrock:InvokeModel']);
    expect(checks.find((c) => c.feature === 'frontdoor')!.unsupported).toBe(true);
    // The simulation is asked with the exprsn:* tag context the generated policies are conditioned on.
    const sim = fake.calls('iam:SimulatePrincipalPolicy').at(-1)!;
    expect(new URLSearchParams(sim.body).get('ContextEntries.member.1.ContextKeyName')).toBe('aws:RequestTag/exprsn:managed');
    // The validation report (agent A's) names the missing permission against the feature it blocks.
    const report = CloudValidation.report(acct(), await p.identity(cred, acct()), checks);
    expect(report.features.find((f) => f.feature === 'compute')).toMatchObject({ status: 'missing', missing: ['ec2:RunInstances'] });
    fake.denied.clear();
  });

  it('creates, describes, adopts and deletes a VPC, polling it until available, with the exprsn tags', async () => {
    const spec: ResourceSpec = { type: 'network', name: 'core', idempotencyKey: 'step-1', tags, props: { cidr: '10.20.0.0/16' } };
    const r = await p.create(ctx, spec);
    expect(r.done).toBe(false);
    if (r.done) return;
    expect(r.operation).toMatchObject({ provider: 'aws', kind: 'aws-describe', op: 'create' });
    // The handle is plain JSON, so the journal can keep it and any instance can resume it.
    const vpc = await settle(p, ctx, { ...r, operation: JSON.parse(JSON.stringify(r.operation)) });
    expect(vpc).toMatchObject({ state: 'ready', name: 'core', props: { cidr: '10.20.0.0/16' } });
    const stored = fake.vpcs.get(vpc!.providerId)!;
    expect(stored.Tags).toMatchObject({ 'exprsn:managed': 'true', 'exprsn:account': 'prod', 'exprsn:deployment': 'main', 'exprsn:name': 'core', Name: 'exprsn-prod-core' });
    // A retried create (the first response lost) adopts the VPC: no second one.
    const again = await p.create(ctx, spec);
    expect(again).toMatchObject({ done: true, adopted: true, resource: { providerId: vpc!.providerId } });
    expect(fake.vpcs.size).toBe(1);
    expect(fake.calls('ec2:CreateVpc')).toHaveLength(1);
    expect((await p.list(ctx, 'network', { managedOnly: true })).map((x) => x.providerId)).toEqual([vpc!.providerId]);
    expect(await p.delete(ctx, vpc!)).toEqual({ done: true, resource: null });
    expect(await p.describe(ctx, vpc!)).toBeNull();
    expect(await p.delete(ctx, vpc!)).toEqual({ done: true, resource: null });
  });

  it('creates a security group with its ingress rules once, and reconciles them on update', async () => {
    const net = await settle(p, ctx, await p.create(ctx, { type: 'network', name: 'fw-net', idempotencyKey: 's1', tags, props: { cidr: '10.30.0.0/16' } }));
    const spec: ResourceSpec = { type: 'firewall', name: 'web', idempotencyKey: 's2', tags, parent: { networkId: net!.providerId }, props: { ingress: [{ protocol: 'tcp', ports: '443', sources: ['0.0.0.0/0'] }] } };
    const fw = await settle(p, ctx, await p.create(ctx, spec));
    expect(fw).toMatchObject({ props: { ingress: [{ protocol: 'tcp', ports: '443', sources: ['0.0.0.0/0'] }] }, tags: { 'exprsn:account': 'prod' } });
    expect(await p.create(ctx, spec)).toMatchObject({ done: true, adopted: true });
    expect(fake.securityGroups.size).toBe(1);
    const updated = await settle(p, ctx, await p.update(ctx, fw!, { ...spec, props: { ingress: [{ protocol: 'tcp', ports: '8443-8444', sources: ['10.0.0.0/8'] }] } }));
    expect(updated!.props.ingress).toEqual([{ protocol: 'tcp', ports: '8443-8444', sources: ['10.0.0.0/8'] }]);
    await p.delete(ctx, fw!);
    await p.delete(ctx, net!);
    expect(fake.securityGroups.size + fake.vpcs.size).toBe(0);
  });

  it('creates an S3 bucket once (public access blocked, tagged), and deletes it', async () => {
    const spec: ResourceSpec = { type: 'bucket', name: 'blobs', idempotencyKey: 'b1', tags, props: {} };
    const r = await p.create(ctx, spec);
    expect(r).toMatchObject({ done: true, resource: { providerId: 'exprsn-prod-blobs', tags: { 'exprsn:managed': 'true' } } });
    const b = fake.buckets.get('exprsn-prod-blobs')!;
    expect(b).toMatchObject({ Region: 'eu-central-1', PublicAccessBlock: true });
    expect(b.Tags).toMatchObject({ 'exprsn:account': 'prod', 'exprsn:deployment': 'main' });
    expect(await p.create(ctx, spec)).toMatchObject({ done: true, adopted: true });
    expect(fake.buckets.size).toBe(1);
    await p.delete(ctx, { type: 'bucket', providerId: 'exprsn-prod-blobs' });
    expect(fake.buckets.size).toBe(0);
  });

  it('creates a Route 53 record, follows the change until INSYNC, adopts a repeat and deletes it', async () => {
    const zone = fake.addZone('example.test');
    const spec: ResourceSpec = { type: 'dns_record', name: 'www', idempotencyKey: 'd1', tags, props: { zone: 'example.test', record: 'www', recordType: 'A', values: ['203.0.113.7'] } };
    const r = await p.create(ctx, spec);
    expect(r).toMatchObject({ done: false, operation: { kind: 'aws-route53-change' } });
    const rec = await settle(p, ctx, r);
    expect(rec).toMatchObject({ props: { values: ['203.0.113.7'], recordType: 'A' } });
    expect(await p.create(ctx, spec)).toMatchObject({ done: true, adopted: true });
    expect([...zone.Records.keys()].filter((k) => k.startsWith('www.'))).toEqual(['www.example.test.|A']);
    await settle(p, ctx, await p.delete(ctx, rec!));
    expect(zone.Records.has('www.example.test.|A')).toBe(false);
  });

  it('retries AWS throttling (no Retry-After) with jittered backoff and then succeeds', async () => {
    fake.throttle(2, { op: 'ec2:DescribeVpcs' });
    const before = p.transport.stats.retries;
    expect(await p.list(ctx, 'network')).toEqual([]);
    expect(p.transport.stats.retries - before).toBe(2);
    expect(sleeps).toEqual([250, 500]);
  });

  it('sends every SDK request through the transport (the fake saw exactly what the guard let out)', () => {
    expect(fake.requests.length).toBe(p.transport.stats.attempts);
  });

  it('answers unsupported and not yet without calling AWS', async () => {
    const n = fake.requests.length;
    expect(p.supports('tunnel')).toBe('unsupported');
    // Sprint 59 (B-10301): databases are built; Secrets Manager as a graph resource is not yet.
    expect(p.supports('secret')).toBe('not_yet');
    await expect(p.create(ctx, { type: 'secret', name: 'k', idempotencyKey: 'x', tags, props: {} })).rejects.toBeInstanceOf(CloudUnsupported);
    await expect(p.create(ctx, { type: 'tunnel', name: 'k', idempotencyKey: 'x', tags, props: {} })).rejects.toMatchObject({ support: 'unsupported' });
    expect(fake.requests.length).toBe(n);
  });
});

// ---------------------------------------------------------------- Azure

describe('Azure adapter (ARM clients through the egress guard)', () => {
  const fake = new FakeAzure();
  const tenant = 'tenant-test';
  const sub = '00000000-0000-4000-8000-0000000000aa';
  let p: AzureProvider;
  let ctx: CallContext;
  const tags = cloudTags({ account: 'eu', deployment: 'main' });

  beforeAll(async () => {
    await fake.start();
    fake.publicOrigin = 'https://management.azure.com';
    fake.addSubscription(sub, tenant);
    const app = fake.addApp({ tenantId: tenant, secret: true });
    const cred: AdapterCredential = {
      kind: 'azure',
      tenantId: tenant,
      getToken: async (scope) => {
        const r = await fetch(`${fake.url}/${tenant}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: app.clientId, client_secret: app.secret!, scope }) });
        const j = (await r.json()) as { access_token: string; expires_in: number };
        return { token: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
      }
    };
    p = new AzureProvider({ policy, ...transport, testOrigins: { 'https://management.azure.com': fake.url } });
    ctx = { account: account('azure', 'eu', { azureTenantId: tenant, azureSubscriptionId: sub }, 'westeurope'), cred };
  });
  afterAll(() => fake.stop());

  it('answers identity with the ARM subscription, and a missing subscription as not ok', async () => {
    expect(await p.identity(ctx.cred, ctx.account)).toMatchObject({ ok: true, providerAccount: sub });
    const other = account('azure', 'other', { azureTenantId: tenant, azureSubscriptionId: '00000000-0000-4000-8000-0000000000bb' }, null);
    expect(await p.identity(ctx.cred, other)).toMatchObject({ ok: false });
  });

  it('reports missing ARM actions per feature from the permissions list (wildcards and notActions)', async () => {
    fake.setPermissions('', ['Microsoft.Resources/*', 'Microsoft.Network/*', 'Microsoft.Storage/*', 'Microsoft.ContainerService/*', 'Microsoft.Compute/*', 'Microsoft.App/*', 'Microsoft.Insights/*'], ['Microsoft.Network/dnsZones/CNAME/write']);
    const checks = await p.checkPermissions(ctx.cred, ctx.account, ['deploy', 'billing', 'apptier']);
    expect(checks.find((c) => c.feature === 'deploy')!.missing).toEqual(['Microsoft.Network/dnsZones/CNAME/write']);
    expect(checks.find((c) => c.feature === 'billing')!.missing).toEqual(['Microsoft.CostManagement/query/action', 'Microsoft.Consumption/usageDetails/read']);
    expect(checks.find((c) => c.feature === 'apptier')!.unsupported).toBe(true);
    fake.setPermissions('', ['*']);
  });

  it('PUTs a virtual network by name, polls Azure-AsyncOperation, and a repeat makes no second one', async () => {
    const spec: ResourceSpec = { type: 'network', name: 'core', idempotencyKey: 'n1', tags, props: { cidr: '10.40.0.0/16' } };
    const r = await p.create(ctx, spec);
    expect(r).toMatchObject({ done: false, operation: { kind: 'azure-async', token: expect.stringMatching(/^https:\/\/management\.azure\.com\/subscriptions\/.+\/operations\//) } });
    const vnet = await settle(p, ctx, r);
    expect(vnet).toMatchObject({ state: 'ready', name: 'core', region: 'westeurope', tags: { 'exprsn:managed': 'true', 'exprsn:account': 'eu' } });
    expect(fake.calls('arm:operation').length).toBeGreaterThanOrEqual(2);
    // The managed resource group was created on first use, and tagged.
    expect(fake.resources.get(`/subscriptions/${sub}/resourcegroups/exprsn-eu`)!.tags).toMatchObject({ 'exprsn:account': 'eu' });
    const again = await p.create(ctx, spec);
    expect(again.adopted).toBe(true);
    await settle(p, ctx, again);
    expect([...fake.resources.values()].filter((x) => x.type === 'Microsoft.Network/virtualNetworks')).toHaveLength(1);
    const del = await p.delete(ctx, vnet!);
    expect(del).toMatchObject({ done: false, operation: { op: 'delete' } });
    expect(await settle(p, ctx, del)).toBeNull();
    expect(await p.describe(ctx, vnet!)).toBeNull();
  });

  it('creates a network security group with its rules and a storage account through the Location poll', async () => {
    const fw = await settle(p, ctx, await p.create(ctx, { type: 'firewall', name: 'web', idempotencyKey: 'f1', tags, props: { ingress: [{ protocol: 'tcp', ports: '443', sources: ['0.0.0.0/0'] }] } }));
    expect(fw).toMatchObject({ props: { ingress: [{ protocol: 'tcp', ports: '443', sources: ['0.0.0.0/0'] }] } });
    const r = await p.create(ctx, { type: 'bucket', name: 'blobs', idempotencyKey: 'b1', tags, props: {} });
    expect(r).toMatchObject({ done: false, operation: { kind: 'azure-location' } });
    const acct = await settle(p, ctx, r);
    expect(acct).toMatchObject({ providerId: expect.stringMatching(/storageAccounts\/exeublobs$/), tags: { 'exprsn:deployment': 'main' } });
    const stored = fake.resources.get(acct!.providerId.toLowerCase())!;
    expect((stored.body.properties as Record<string, unknown>).allowBlobPublicAccess).toBe(false);
    expect(await p.delete(ctx, acct!)).toEqual({ done: true, resource: null });
    await settle(p, ctx, await p.delete(ctx, fw!));
  });

  it('reports a failed asynchronous operation as failed', async () => {
    fake.failNextAsync = { type: 'microsoft.network/virtualnetworks', code: 'InUseSubnetCannotBeDeleted', message: 'The subnet is in use.' };
    const r = await p.create(ctx, { type: 'network', name: 'bad', idempotencyKey: 'n9', tags, props: { cidr: '10.41.0.0/16' } });
    if (r.done) throw new Error('expected an operation');
    await p.poll(ctx, r.operation);
    expect(await p.poll(ctx, r.operation)).toMatchObject({ state: 'failed', code: 'InUseSubnetCannotBeDeleted' });
  });

  it('keeps DNS record set tags as metadata, and a repeat PUT keeps one record set', async () => {
    fake.resources.set(`/subscriptions/${sub}/resourcegroups/exprsn-eu/providers/microsoft.network/dnszones/example.test`, { id: `/subscriptions/${sub}/resourceGroups/exprsn-eu/providers/Microsoft.Network/dnsZones/example.test`, name: 'example.test', type: 'Microsoft.Network/dnsZones', etag: 'x', body: {} });
    const spec: ResourceSpec = { type: 'dns_record', name: 'www', idempotencyKey: 'd1', tags, props: { zone: 'example.test', record: 'www', recordType: 'A', values: ['203.0.113.9'] } };
    const r = await p.create(ctx, spec);
    expect(r).toMatchObject({ done: true, resource: { props: { values: ['203.0.113.9'] }, tags: { 'exprsn:account': 'eu' } } });
    expect(await p.create(ctx, spec)).toMatchObject({ done: true, adopted: true });
    const sets = [...fake.resources.values()].filter((x) => x.type === 'Microsoft.Network/dnszones/A');
    expect(sets).toHaveLength(1);
    expect((sets[0]!.body as { properties: { metadata: Record<string, string> } }).properties.metadata['exprsn:managed']).toBe('true');
    await p.delete(ctx, r.done ? r.resource! : (null as never));
    expect([...fake.resources.values()].filter((x) => x.type === 'Microsoft.Network/dnszones/A')).toHaveLength(0);
  });

  it('honours Retry-After on an ARM 429 (the pipeline’s own retries are off)', async () => {
    fake.throttle(1, { retryAfterS: 3, op: /arm:GET Microsoft.Resources\/subscriptions/ });
    expect(await p.identity(ctx.cred, ctx.account)).toMatchObject({ ok: true });
    expect(sleeps).toContain(3000);
  });

  it('refuses to poll an operation URL off the ARM endpoint', async () => {
    await expect(p.poll(ctx, { provider: 'azure', type: 'network', op: 'create', kind: 'azure-async', ref: { type: 'network', providerId: '/subscriptions/x/resourceGroups/y/providers/Microsoft.Network/virtualNetworks/z' }, token: 'https://evil.example/operations/1', startedAt: 0 })).rejects.toMatchObject({ code: 'foreign_operation_url' });
  });

  it('sends every pipeline request through the transport', () => {
    // Token requests go to Entra through the test's own fetch (agent B's credential uses its own guarded client).
    expect(fake.requests.filter((r) => r.op !== 'entra:token').length).toBe(p.transport.stats.attempts);
  });
});

// ---------------------------------------------------------------- DigitalOcean

describe('DigitalOcean adapter (API v2)', () => {
  const fake = new FakeDigitalOcean();
  let p: DigitalOceanProvider;
  let ctx: CallContext;
  const tags = cloudTags({ account: 'ams', deployment: 'main' });

  beforeAll(async () => {
    await fake.start();
    const token = fake.addToken();
    p = new DigitalOceanProvider({ policy, ...transport, endpoints: { api: fake.url } });
    ctx = { account: account('digitalocean', 'ams', { doTeamId: fake.account.team.uuid }, 'ams3'), cred: { kind: 'token', token } };
  });
  afterAll(() => fake.stop());

  it('answers identity with /v2/account (the team is the provider account)', async () => {
    expect(await p.identity(ctx.cred, ctx.account)).toMatchObject({ ok: true, providerAccount: fake.account.team.uuid });
    expect(await p.identity({ kind: 'token', token: 'dop_v1_nope' }, ctx.account)).toMatchObject({ ok: false });
  });

  it('probes token scopes without changing anything and names the missing ones per feature', async () => {
    const scoped = fake.addToken(['account:read', 'vpc:read', 'vpc:create', 'vpc:update', 'vpc:delete', 'firewall:read', 'firewall:create', 'firewall:update', 'firewall:delete', 'domain:read', 'domain:create', 'domain:update', 'domain:delete', 'kubernetes:read', 'kubernetes:create', 'load_balancer:create', 'tag:create', 'droplet:read', 'actions:read', 'app:create', 'app:read', 'app:update', 'app:delete']);
    const checks = await p.checkPermissions({ kind: 'token', token: scoped }, ctx.account, ['deploy', 'compute', 'frontdoor']);
    expect(checks.find((c) => c.feature === 'deploy')!.missing).toEqual([]);
    expect(checks.find((c) => c.feature === 'compute')!.missing).toEqual(['droplet:create', 'droplet:delete', 'kubernetes:update']);
    expect(checks.find((c) => c.feature === 'frontdoor')!.unsupported).toBe(true);
    expect(fake.vpcs.size + fake.firewalls.size + fake.droplets.size).toBe(0);
  });

  it('creates a VPC once (tags in its description), finds it by name, and deletes it', async () => {
    const spec: ResourceSpec = { type: 'network', name: 'core', idempotencyKey: 'v1', tags, props: { cidr: '10.50.0.0/20' } };
    const r = await p.create(ctx, spec);
    expect(r).toMatchObject({ done: true, resource: { name: 'core', props: { cidr: '10.50.0.0/20' }, tags: { 'exprsn:managed': 'true', 'exprsn:account': 'ams', 'exprsn:deployment': 'main' } } });
    expect([...fake.vpcs.values()][0]!.name).toBe('exprsn-ams-core');
    expect(await p.create(ctx, spec)).toMatchObject({ done: true, adopted: true });
    expect(fake.vpcs.size).toBe(1);
    await p.delete(ctx, r.done ? r.resource! : (null as never));
    expect(fake.vpcs.size).toBe(0);
  });

  it('creates a firewall and follows its status until it is applied', async () => {
    const spec: ResourceSpec = { type: 'firewall', name: 'web', idempotencyKey: 'f1', tags, props: { ingress: [{ protocol: 'tcp', ports: '443', sources: ['0.0.0.0/0'] }] } };
    const r = await p.create(ctx, spec);
    expect(r).toMatchObject({ done: false, operation: { kind: 'do-firewall' } });
    const fw = await settle(p, ctx, r);
    expect(fw).toMatchObject({ state: 'ready', props: { ingress: [{ protocol: 'tcp', ports: '443', sources: ['0.0.0.0/0'] }] } });
    expect(await p.create(ctx, spec)).toMatchObject({ adopted: true });
    expect(fake.firewalls.size).toBe(1);
    await p.delete(ctx, fw!);
    expect(fake.firewalls.size).toBe(0);
  });

  it('keeps a domain record set at the spec’s values, once', async () => {
    fake.domains.set('example.test', []);
    const spec: ResourceSpec = { type: 'dns_record', name: 'www', idempotencyKey: 'd1', tags, props: { zone: 'example.test', record: 'www', recordType: 'A', values: ['203.0.113.1', '203.0.113.2'] } };
    expect(await p.create(ctx, spec)).toMatchObject({ done: true, resource: { props: { values: ['203.0.113.1', '203.0.113.2'] } } });
    expect(await p.create(ctx, spec)).toMatchObject({ done: true, adopted: true });
    expect(fake.domains.get('example.test')).toHaveLength(2);
    const r = await p.update(ctx, { type: 'dns_record', providerId: 'example.test|A|www' }, { ...spec, props: { ...spec.props, values: ['203.0.113.2'] } as never });
    expect(r).toMatchObject({ done: true, resource: { props: { values: ['203.0.113.2'] } } });
    await p.delete(ctx, { type: 'dns_record', providerId: 'example.test|A|www' });
    expect(fake.domains.get('example.test')).toHaveLength(0);
  });

  it('creates a droplet with its tags and follows its create action', async () => {
    const spec: ResourceSpec = { type: 'vm', name: 'gpu-1', idempotencyKey: 'vm1', tags, props: { size: 's-1vcpu-1gb', image: 'ubuntu-24-04-x64' } };
    const r = await p.create(ctx, spec);
    expect(r).toMatchObject({ done: false, operation: { kind: 'do-action' } });
    const d = await settle(p, ctx, r);
    expect(d).toMatchObject({ state: 'ready', name: 'gpu-1', tags: { 'exprsn:account': 'ams' } });
    expect([...fake.droplets.values()][0]!.tags).toEqual(expect.arrayContaining(['exprsn:managed:true', 'exprsn:account:ams', 'exprsn:name:gpu-1']));
    expect(await p.create(ctx, spec)).toMatchObject({ done: true, adopted: true });
    expect(fake.droplets.size).toBe(1);
    await p.delete(ctx, d!);
  });

  it('waits for Retry-After on a 429 and then completes', async () => {
    fake.throttle(1, { retryAfterS: 2, op: 'GET /account' });
    expect(await p.identity(ctx.cred, ctx.account)).toMatchObject({ ok: true });
    expect(sleeps).toEqual([2000]);
  });

  it('gives up when the provider asks for a longer wait than allowed, with the wait to report', async () => {
    const strict = new DigitalOceanProvider({ policy, ...transport, maxRetryWaitMs: 10_000, endpoints: { api: fake.url } });
    fake.throttle(1, { retryAfterS: 120, op: 'GET /vpcs' });
    const err = await strict.list(ctx, 'network').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudProviderError);
    expect(err).toMatchObject({ status: 429, retryAfterSeconds: 120, throttled: true });
  });

  it('holds calls to the shared per-account bucket, and refuses locally when the wait would be too long', async () => {
    // A counter store whose second hit is over the limit, as a full window would be.
    let hits = 0;
    const keys: string[] = [];
    const counters = { kind: 'memory' as const, hit: async (key: string) => (keys.push(key), ++hits === 2 ? { count: 9999, resetMs: 500 } : { count: 1, resetMs: 500 }), close: async () => undefined };
    const limited = new DigitalOceanProvider({ policy, ...transport, counters, limit: { points: 2, windowMs: 60_000 }, endpoints: { api: fake.url } });
    await limited.identity(ctx.cred, ctx.account);
    await limited.identity(ctx.cred, ctx.account);
    expect(limited.transport.stats.limiterWaits).toBe(1);
    expect(sleeps).toEqual([525]);
    // B-10108: the read class's bucket and the account's total, each with its refill slice, all keyed by the account.
    expect([...new Set(keys)].sort()).toEqual([`cloud:digitalocean:${ctx.account.id}`, `cloud:digitalocean:read:${ctx.account.id}`, `cloud:digitalocean:read:s:${ctx.account.id}`, `cloud:digitalocean:s:${ctx.account.id}`].sort());
    const store = new MemoryCounterStore();
    const strict = new DigitalOceanProvider({ policy, ...transport, counters: store, limit: { points: 1, windowMs: 60_000 }, maxQueueWaitMs: 0, endpoints: { api: fake.url } });
    await strict.identity(ctx.cred, ctx.account);
    const seen = fake.requests.length;
    await expect(strict.identity(ctx.cred, ctx.account)).rejects.toMatchObject({ status: 429, code: 'rate_limited' });
    expect(fake.requests.length).toBe(seen);
  });

  it('answers Spaces buckets as not yet and subnets as unsupported', () => {
    expect(p.supports('bucket')).toBe('not_yet');
    expect(p.supports('subnet')).toBe('unsupported');
  });
});

// ---------------------------------------------------------------- Cloudflare

describe('Cloudflare adapter (API v4)', () => {
  const fake = new FakeCloudflare();
  let p: CloudflareProvider;
  let ctx: CallContext;
  let zoneId = '';
  const tags = cloudTags({ account: 'edge', deployment: 'main' });

  beforeAll(async () => {
    await fake.start();
    zoneId = fake.addZone('example.test').id;
    const t = fake.addToken(['Zone Read', 'DNS Write', 'Cloudflare Tunnel Write', 'SSL and Certificates Write', 'Zone WAF Write', 'Account Settings Read', 'Workers R2 Storage Write', 'API Tokens Read']);
    p = new CloudflareProvider({ policy, ...transport, endpoints: { api: fake.url } });
    ctx = { account: account('cloudflare', 'edge', { cloudflareAccountId: fake.accountId, cloudflareZoneIds: [zoneId] }, null), cred: { kind: 'token', token: t.value } };
  });
  afterAll(() => fake.stop());

  it('verifies user and account tokens, and a disabled token is not ok', async () => {
    expect(await p.identity(ctx.cred, ctx.account)).toMatchObject({ ok: true });
    const acc = fake.addToken(['DNS Read'], { accountOwned: true });
    expect(await p.identity({ kind: 'token', token: acc.value }, ctx.account)).toMatchObject({ ok: true, providerAccount: fake.accountId });
    const off = fake.addToken([], { status: 'disabled' });
    expect(await p.identity({ kind: 'token', token: off.value }, ctx.account)).toMatchObject({ ok: false });
  });

  it('accepts a token without Containers Edit for the front door and refuses it for the app tier (B-10009)', async () => {
    const checks = await p.checkPermissions(ctx.cred, ctx.account, ['frontdoor', 'apptier', 'compute']);
    expect(checks.find((c) => c.feature === 'frontdoor')!.missing).toEqual([]);
    expect(checks.find((c) => c.feature === 'apptier')!.missing).toEqual(['Workers Scripts Write', 'Containers Edit', 'Hyperdrive Write']);
    expect(checks.find((c) => c.feature === 'compute')!.unsupported).toBe(true);
  });

  it('probes without API Tokens Read, and says which permissions it could not check', async () => {
    const t = fake.addToken(['Zone Read', 'DNS Write', 'Hyperdrive Write', 'Account Settings Read']);
    const checks = await p.checkPermissions({ kind: 'token', token: t.value }, ctx.account, ['frontdoor', 'apptier']);
    const fd = checks.find((c) => c.feature === 'frontdoor')!;
    expect(fd.missing).toEqual(['Cloudflare Tunnel Write']);
    expect(fd.error).toMatch(/SSL and Certificates Write, Zone WAF Write cannot be checked/);
    const app = checks.find((c) => c.feature === 'apptier')!;
    expect(app.missing).toEqual(['Containers Edit']);
    expect(fake.records.size + fake.tunnels.size + fake.buckets.size).toBe(0);
  });

  it('creates DNS records with the tags in their comment, once, and deletes them', async () => {
    const spec: ResourceSpec = { type: 'dns_record', name: 'app', idempotencyKey: 'd1', tags, props: { zone: 'example.test', record: 'app', recordType: 'CNAME', values: ['origin.example.test'], proxied: true } };
    const r = await p.create(ctx, spec);
    expect(r).toMatchObject({ done: true, resource: { props: { values: ['origin.example.test'], proxied: true }, tags: { 'exprsn:managed': 'true', 'exprsn:account': 'edge' } } });
    expect([...fake.records.values()][0]!.comment).toBe('exprsn:managed=true exprsn:account=edge exprsn:deployment=main');
    expect(await p.create(ctx, spec)).toMatchObject({ done: true, adopted: true });
    expect(fake.records.size).toBe(1);
    expect(await p.list(ctx, 'dns_record', { zone: 'example.test', managedOnly: true })).toHaveLength(1);
    await p.delete(ctx, r.done ? r.resource! : (null as never));
    expect(fake.records.size).toBe(0);
  });

  it('creates an R2 bucket and a tunnel once each, by name', async () => {
    const b = await p.create(ctx, { type: 'bucket', name: 'assets', idempotencyKey: 'b1', tags, props: {} });
    expect(b).toMatchObject({ done: true, resource: { providerId: 'exprsn-edge-assets', name: 'assets' } });
    expect(await p.create(ctx, { type: 'bucket', name: 'assets', idempotencyKey: 'b1', tags, props: {} })).toMatchObject({ adopted: true });
    expect(fake.buckets.size).toBe(1);
    const t = await p.create(ctx, { type: 'tunnel', name: 'origin', idempotencyKey: 't1', tags, props: {} });
    expect(t).toMatchObject({ done: true, resource: { name: 'origin' } });
    expect(JSON.stringify(t)).not.toMatch(/token|secret/i);
    expect(await p.create(ctx, { type: 'tunnel', name: 'origin', idempotencyKey: 't1', tags, props: {} })).toMatchObject({ adopted: true });
    expect(fake.tunnels.size).toBe(1);
    await p.delete(ctx, t.done ? t.resource! : (null as never));
    await p.delete(ctx, { type: 'bucket', providerId: 'exprsn-edge-assets' });
    expect(fake.buckets.size).toBe(0);
    expect(await p.list(ctx, 'tunnel', { managedOnly: true })).toEqual([]);
  });

  it('retries a 429 after Retry-After', async () => {
    fake.throttle(2, { retryAfterS: 1 });
    expect(await p.identity(ctx.cred, ctx.account)).toMatchObject({ ok: true });
    expect(sleeps).toEqual([1000, 1000]);
  });

  it('answers networks as unsupported and never calls Cloudflare for them', async () => {
    const n = fake.requests.length;
    expect(p.supports('network')).toBe('unsupported');
    // Sprint 61 (B-10905): Containers are built; WAF custom rules as a firewall resource are not.
    expect(p.supports('container_service')).toBe('built');
    expect(p.supports('firewall')).toBe('not_yet');
    await expect(p.create(ctx, { type: 'network', name: 'x', idempotencyKey: 'x', tags, props: { cidr: '10.0.0.0/8' } })).rejects.toMatchObject({ code: 'unsupported', support: 'unsupported' });
    expect(fake.requests.length).toBe(n);
  });
});

// ---------------------------------------------------------------- the egress guard and the registry

describe('cloud egress and the registry', () => {
  const acct = account('aws', 'guard', { awsAccountId: '123456789012' }, 'us-east-1');
  const cred: AdapterCredential = { kind: 'aws', accessKeyId: 'AKIAGUARD', secretAccessKey: 'x', expiresAt: null };

  it('refuses a cloud metadata address even when the operator allow-lists it (IPv4 and IPv6)', async () => {
    const open = servicePolicy({ SERVICE_ALLOWED_HOSTS: '169.254.169.254,fd00:ec2::254,169.254.0.0/16' });
    for (const url of ['http://169.254.169.254', 'http://[fd00:ec2::254]']) {
      const p = new AwsProvider({ policy: open, ...transport, endpoints: { sts: url } });
      const err = await p.identity(cred, acct).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CloudProviderError);
      expect((err as CloudProviderError).code).toBe('egress_refused');
      expect((err as Error).message).toMatch(/metadata address/);
    }
    expect(cloudAddressProblem('169.254.169.254', 'sts.amazonaws.com', open, CLOUD_PROVIDER_HOSTS.aws)).toMatch(/metadata/);
    expect(cloudAddressProblem('fd00:ec2::254', 'sts.amazonaws.com', open, CLOUD_PROVIDER_HOSTS.aws)).toMatch(/metadata/);
  });

  it('refuses a private address or a host that is not the provider’s, for SDK calls and REST calls alike', async () => {
    const aws = new AwsProvider({ policy, ...transport, endpoints: { ec2: 'https://10.1.2.3', sts: 'https://192.168.10.10' } });
    await expect(aws.identity(cred, acct)).rejects.toMatchObject({ code: 'egress_refused' });
    await expect(aws.list({ account: acct, cred }, 'network')).rejects.toMatchObject({ code: 'egress_refused' });
    const az = new AzureProvider({ policy, ...transport, testOrigins: { 'https://management.azure.com': 'http://169.254.169.254' } });
    const azAcct = account('azure', 'g', { azureTenantId: 't', azureSubscriptionId: 's' }, null);
    await expect(az.identity({ kind: 'azure', tenantId: 't', getToken: async () => ({ token: 'x', expiresAt: Date.now() + 60_000 }) }, azAcct)).rejects.toMatchObject({ code: 'egress_refused' });
    const dop = new DigitalOceanProvider({ policy, ...transport, endpoints: { api: 'https://example.com' } });
    await expect(dop.identity({ kind: 'token', token: 't' }, account('digitalocean', 'g', {}, null))).rejects.toMatchObject({ code: 'egress_refused', message: expect.stringMatching(/not one of this provider/) });
    const cf = new CloudflareProvider({ policy, ...transport, endpoints: { api: 'http://203.0.113.5' } });
    await expect(cf.identity({ kind: 'token', token: 't' }, account('cloudflare', 'g', { cloudflareAccountId: 'a' }, null))).rejects.toMatchObject({ code: 'egress_refused', message: expect.stringMatching(/plain http/) });
    // A provider's own name that resolves inward is refused at connect time, unless the operator names it.
    expect(cloudAddressProblem('10.0.0.5', 'ec2.us-east-1.amazonaws.com', policy, CLOUD_PROVIDER_HOSTS.aws)).toMatch(/internal address/);
    expect(cloudAddressProblem('52.94.0.1', 'ec2.us-east-1.amazonaws.com', policy, CLOUD_PROVIDER_HOSTS.aws)).toBeNull();
    expect(cloudAddressProblem('104.16.0.1', 'api.cloudflare.com', policy, CLOUD_PROVIDER_HOSTS.aws)).toMatch(/not one of this provider/);
  });

  it('refuses to run without an account, before any call', async () => {
    const p = new AwsProvider({ policy, ...transport, endpoints: { sts: 'http://127.0.0.1:9' } });
    await expect(p.identity(cred, undefined as never)).rejects.toMatchObject({ code: 'no_account' });
    await expect(p.identity(cred, { ...acct, provider: 'azure' })).rejects.toMatchObject({ code: 'wrong_provider' });
    expect(p.transport.stats.calls).toBe(0);
  });

  it('builds the four adapters without calling anything, with a capability entry for every type', () => {
    const reg = createProviderRegistry({ SERVICE_ALLOWED_HOSTS: '', SERVICE_INTERNAL_ONLY: false });
    for (const kind of ['aws', 'azure', 'digitalocean', 'cloudflare'] as const) {
      const p = reg.providerFor(kind);
      expect(p.kind).toBe(kind);
      for (const t of RESOURCE_TYPES) expect(['built', 'not_yet', 'unsupported']).toContain(p.supports(t));
      for (const t of ['network', 'firewall', 'bucket', 'dns_record'] as const) if (p.supports(t) === 'built') expect(p.capabilities[t].operations).toEqual(['describe', 'list', 'create', 'update', 'delete', 'poll']);
    }
    const built = Object.fromEntries((['aws', 'azure', 'digitalocean', 'cloudflare'] as const).map((k) => [k, RESOURCE_TYPES.filter((t) => reg.providerFor(k).supports(t) === 'built')]));
    // Sprint 58 adds vm and container_service (B-10204, B-10205) beside the Kubernetes work's types.
    expect(built.aws).toEqual(expect.arrayContaining(['network', 'subnet', 'firewall', 'bucket', 'dns_record', 'vm', 'container_service']));
    expect(built.azure).toEqual(expect.arrayContaining(['network', 'subnet', 'firewall', 'bucket', 'dns_record', 'vm', 'container_service']));
    expect(built.digitalocean).toEqual(expect.arrayContaining(['network', 'firewall', 'vm', 'dns_record', 'container_service']));
    expect(built.cloudflare).toEqual(['container_service', 'bucket', 'dns_record', 'tunnel', 'worker', 'hyperdrive']);
  });
});
