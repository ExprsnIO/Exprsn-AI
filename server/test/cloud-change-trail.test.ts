import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '../src/authz/policy.js';
import type { CloudActor } from '../src/cloud/accounts.js';
import type { DesiredResource } from '../src/cloud/graph.js';
import { ProviderRegistry } from '../src/cloud/providers/registry.js';
import type { CloudAccount, Provider, ProviderIds } from '../src/cloud/types.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { servicePolicy } from '../src/platform/egress.js';
import { seedAccount } from './cloud-credentials-helpers.js';
import { FakeAws, type FakeAwsKey } from './fake-aws.js';
import { FakeAzure } from './fake-azure.js';
import { FakeCloudflare } from './fake-cloudflare.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * 1.9.99-final, Sprint 62 (B-10703): the out-of-band change trail on drift findings ("changed by …"), against the
 * AWS (CloudTrail `LookupEvents`), Azure (Activity Log) and Cloudflare (audit logs) fakes on 127.0.0.1; nothing
 * reaches a real cloud. Migration 165 is applied here by hand until it is registered.
 */

const ALLOWED = '127.0.0.1,::1,localhost';
const D = '/api/admin/cloud/deployments';
const HOUR = 3_600_000;
const AZ_TENANT = '00000000-0000-4000-8000-0000000000aa';
const AZ_SUB = '00000000-0000-4000-8000-0000000000bb';
const AZ_TOKEN = 'arm-token-change-trail';

let h: Harness;
const aws = new FakeAws();
const azure = new FakeAzure();
const cf = new FakeCloudflare();
let awsKey: FakeAwsKey;
let cfToken = '';
let cfZone = '';
let alice: CloudActor & { client: Client };
const acc: Partial<Record<Provider, CloudAccount>> = {};

const validated = (feature: string, principal?: string) => JSON.stringify({ at: Date.now(), ok: true, identity: { ok: true, ...(principal ? { principal } : {}) }, features: [{ feature, name: feature, status: 'ok', required: [], missing: [], reason: null }] });

async function account(provider: Provider, name: string, providerIds: ProviderIds, feature: string, principal?: string): Promise<CloudAccount> {
  const a = await seedAccount(h, { provider, mode: 'vaulted', name, providerIds });
  await h.s.db('cloud_accounts').where({ id: a.id }).update({ validation: validated(feature, principal) });
  return (await h.s.cloud.accounts.get(a.id))!;
}

let seq = 0;
async function deployment(a: CloudAccount, region: string): Promise<string> {
  const d = await h.s.cloud.deployments.create(alice, { name: `trail-${++seq}`, accountId: a.id, region });
  await h.s.cloud.deployments.setState(d.id, 'ready');
  return d.id;
}

/** A resource in the graph with its provider id, as an apply leaves it. */
async function resource(deploymentId: string, desired: DesiredResource, region: string, providerId: string, locator?: Record<string, string>): Promise<void> {
  await h.s.cloud.deployments.upsertResource(deploymentId, desired, region, { providerId, state: 'ready', ...(locator ? { locator } : {}) });
}

const fw = (key: string, port = '443'): DesiredResource => ({ key, type: 'firewall', spec: { ingress: [{ protocol: 'tcp', ports: port, sources: ['0.0.0.0/0'] }] }, dependsOn: [], protect: false, region: null });

/** A security group at the AWS fake, as Exprsn-AI made it. */
function securityGroup(id: string, name: string, ports: number[] = [443]): void {
  aws.securityGroups.set(id, { GroupId: id, GroupName: name, Description: 'exprsn', VpcId: 'vpc-none', Tags: { 'exprsn:managed': 'true', 'exprsn:account': 'aws-trail', 'exprsn:name': name }, Ingress: ports.map((p) => ({ IpProtocol: 'tcp', FromPort: p, ToPort: p, CidrIp: ['0.0.0.0/0'] })) });
}

const detect = async (id: string) => h.s.cloud.lifecycle.drift.detect((await h.s.cloud.deployments.get(id))!);
const driftOf = async (id: string) => {
  const res = await alice.client.agent.get(`${D}/${id}/drift`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.findings as { id: string; kind: string; key: string; path: string; providerId: string; firstSeen: number; changedBy: { principal: string; principalType: string | null; at: number; action: string; source: string; sourceIp: string | null; byExprsn: boolean } | null; trail: { state: string; attempts: number; window: { from: number; to: number } | null; events: { principal: string; byExprsn: boolean }[] } }[];
};

beforeAll(async () => {
  await Promise.all([aws.start(), azure.start(), cf.start()]);
  h = await harness({ SERVICE_ALLOWED_HOSTS: ALLOWED });
  if (!(await h.s.db.schema.hasTable('cloud_deployments'))) await (await import('../src/db/migrations/148_cloud_journal.js')).up(h.s.db);
  if (!(await h.s.db.schema.hasTable('cloud_drift_findings'))) await (await import('../src/db/migrations/149_cloud_lifecycle.js')).up(h.s.db);
  if (!(await h.s.db.schema.hasTable('cloud_change_trail'))) await (await import('../src/db/migrations/165_cloud_change_trail.js')).up(h.s.db);
  h.s.cloud.deployments.resetSchemaCache();
  h.s.cloud.lifecycle.schema.reset();
  h.s.cloud.lifecycle.trail.resetSchemaCache();
  const u = aws.url;
  const registry = new ProviderRegistry({
    policy: servicePolicy({ SERVICE_ALLOWED_HOSTS: ALLOWED }),
    endpoints: { aws: { sts: u, iam: u, ec2: u, s3: u, route53: u, eks: u, ecs: u, elbv2: u, secretsmanager: u, rds: u, elasticache: u, memorydb: u, servicequotas: u, cloudtrail: u }, cloudflare: { api: cf.url } },
    transport: { sleep: async () => undefined, random: () => 0.5, testOrigins: { 'https://management.azure.com': azure.url } }
  });
  Object.defineProperty(h.s.cloud, 'providers', { value: registry, configurable: true });
  awsKey = aws.addUser({ userName: 'exprsn-deploy' });
  azure.addSubscription(AZ_SUB, AZ_TENANT);
  azure.tokens.set(AZ_TOKEN, { tenantId: AZ_TENANT, clientId: 'deploy-app', scope: 'https://management.azure.com/.default', exp: Date.now() + 24 * HOUR });
  cfZone = cf.addZone('example.test').id;
  cfToken = cf.addToken(['Zone Read', 'DNS Write', 'Cloudflare Tunnel Write', 'Account Settings Read']).value;
  (h.s.cloud as { credentials: unknown }).credentials = {
    for: async (a: CloudAccount) => {
      if (a.provider === 'aws') return { kind: 'aws', accessKeyId: awsKey.accessKeyId, secretAccessKey: awsKey.secretAccessKey, expiresAt: null };
      if (a.provider === 'azure') return { kind: 'azure', tenantId: AZ_TENANT, getToken: async () => ({ token: AZ_TOKEN, expiresAt: Date.now() + HOUR }) };
      return { kind: 'token', token: cfToken, accountId: cf.accountId };
    }
  };
  const user = await localUser(h, 'trailadmin', ['system-admin'], 'restricted');
  const client = await loginAdmin(h, 'trailadmin');
  const p = (await loadPrincipal(h.s, h.tenantId, user.id, {}))!;
  alice = { principal: { ...p, mfa: true } as Principal, ip: '127.0.0.1', client };
  acc.aws = await account('aws', 'aws-trail', { awsAccountId: aws.account }, 'deploy', awsKey.arn);
  acc.azure = await account('azure', 'az-trail', { azureTenantId: AZ_TENANT, azureSubscriptionId: AZ_SUB }, 'deploy');
  acc.cloudflare = await account('cloudflare', 'cf-trail', { cloudflareAccountId: cf.accountId, cloudflareZoneIds: [cfZone] }, 'frontdoor');
}, 120_000);

afterAll(async () => {
  await h?.close();
  await Promise.all([aws.stop(), azure.stop(), cf.stop()]);
});

beforeEach(() => {
  aws.reset();
  azure.reset();
  cf.reset();
});

describe('change trail on drift findings (B-10703)', () => {
  it('AWS: a drift finding names the principal and time of the change from CloudTrail, and only the drifted resource is looked up', async () => {
    const id = await deployment(acc.aws!, 'eu-central-1');
    securityGroup('sg-0a1', 'trail-web');
    securityGroup('sg-0b2', 'trail-api');
    await resource(id, fw('web'), 'eu-central-1', 'sg-0a1');
    await resource(id, fw('api'), 'eu-central-1', 'sg-0b2');
    // Someone opens SSH on the web group by hand, 40 minutes ago; Exprsn-AI's own credential touched it later.
    const changedAt = Date.now() - 40 * 60_000;
    aws.securityGroups.get('sg-0a1')!.Ingress.push({ IpProtocol: 'tcp', FromPort: 22, ToPort: 22, CidrIp: ['0.0.0.0/0'] });
    aws.addTrailEvent({ resource: 'sg-0a1', name: 'AuthorizeSecurityGroupIngress', at: changedAt, arn: `arn:aws:sts::${aws.account}:assumed-role/ops-admin/mallory`, userName: 'mallory', identityType: 'AssumedRole', sourceIp: '198.51.100.23' });
    aws.addTrailEvent({ resource: 'sg-0a1', name: 'CreateTags', at: changedAt + 5 * 60_000, arn: awsKey.arn, userName: 'exprsn-deploy' });
    aws.addTrailEvent({ resource: 'sg-0a1', name: 'DescribeSecurityGroups', at: changedAt + 6 * 60_000, arn: awsKey.arn, userName: 'exprsn-deploy', readOnly: true });
    // Outside the window (two days before): never chosen.
    aws.addTrailEvent({ resource: 'sg-0a1', name: 'AuthorizeSecurityGroupIngress', at: Date.now() - 48 * HOUR, arn: `arn:aws:iam::${aws.account}:user/old-admin`, userName: 'old-admin' });
    aws.addTrailEvent({ resource: 'sg-0b2', name: 'AuthorizeSecurityGroupIngress', at: changedAt, arn: `arn:aws:iam::${aws.account}:user/other`, userName: 'other' });

    const out = await detect(id);
    expect(out.fresh.map((f) => [f.kind, f.key, f.path])).toEqual([['field', 'web', 'ingress']]);
    const calls = aws.calls('cloudtrail:LookupEvents');
    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]!.body) as { LookupAttributes: { AttributeKey: string; AttributeValue: string }[]; StartTime: number; EndTime: number };
    expect(body.LookupAttributes).toEqual([{ AttributeKey: 'ResourceName', AttributeValue: 'sg-0a1' }]);
    expect(calls[0]!.headers.authorization).toMatch(/Credential=[^/]+\/\d{8}\/eu-central-1\/cloudtrail\/aws4_request/);
    expect(calls[0]!.headers['x-amz-target']).toBe('com.amazonaws.cloudtrail.v20131101.CloudTrail_20131101.LookupEvents');
    // Bounded: a day up to the finding's first sighting (and a little slack), no more.
    expect(body.EndTime - body.StartTime).toBeLessThanOrEqual(24 * 3600 + 180);
    expect(body.EndTime * 1000).toBeLessThanOrEqual(Date.now() + 3 * 60_000);

    const [f] = await driftOf(id);
    expect(f!.changedBy).toMatchObject({ principal: `arn:aws:sts::${aws.account}:assumed-role/ops-admin/mallory`, principalType: 'AssumedRole', action: 'AuthorizeSecurityGroupIngress', source: 'ec2.amazonaws.com', sourceIp: '198.51.100.23', byExprsn: false });
    expect(Math.abs(f!.changedBy!.at - changedAt)).toBeLessThan(1000);
    expect(f!.trail).toMatchObject({ state: 'found', attempts: 1 });
    expect(f!.trail.window!.to - f!.trail.window!.from).toBeLessThanOrEqual(24 * HOUR + 3 * 60_000);
    // Exprsn-AI's own write is listed, flagged, and not the one chosen; the read and the old change are not there.
    expect(f!.trail.events.map((e) => [e.principal.split('/').pop(), e.byExprsn])).toEqual([['exprsn-deploy', true], ['mallory', false]]);

    // A finding already found is not looked up again.
    await detect(id);
    expect(aws.calls('cloudtrail:LookupEvents')).toHaveLength(1);
  });

  it('no finding, no lookup; a finding with nothing in the trail yet is asked again later, bounded', async () => {
    const id = await deployment(acc.aws!, 'eu-central-1');
    securityGroup('sg-0c3', 'trail-quiet');
    await resource(id, fw('quiet'), 'eu-central-1', 'sg-0c3');
    const clean = await detect(id);
    expect(clean.open).toEqual([]);
    expect(aws.calls('cloudtrail:LookupEvents')).toHaveLength(0);

    // Drift whose event CloudTrail has not delivered yet.
    aws.securityGroups.get('sg-0c3')!.Ingress.push({ IpProtocol: 'tcp', FromPort: 8443, ToPort: 8443, CidrIp: ['10.0.0.0/8'] });
    await detect(id);
    let [f] = await driftOf(id);
    expect(f!.changedBy).toBeNull();
    expect(f!.trail).toMatchObject({ state: 'pending', attempts: 1 });
    // It arrives; the next run finds it.
    aws.addTrailEvent({ resource: 'sg-0c3', name: 'AuthorizeSecurityGroupIngress', at: f!.firstSeen - 10 * 60_000, userName: 'late-admin', arn: `arn:aws:iam::${aws.account}:user/late-admin` });
    await detect(id);
    [f] = await driftOf(id);
    expect(f!.changedBy).toMatchObject({ principal: `arn:aws:iam::${aws.account}:user/late-admin` });
    expect(f!.trail).toMatchObject({ state: 'found', attempts: 2 });
    expect(aws.calls('cloudtrail:LookupEvents')).toHaveLength(2);

    // At most maxAttempts lookups for a finding that never shows in the trail.
    const id2 = await deployment(acc.aws!, 'eu-central-1');
    securityGroup('sg-0d4', 'trail-never');
    await resource(id2, fw('never'), 'eu-central-1', 'sg-0d4');
    aws.securityGroups.get('sg-0d4')!.Ingress.push({ IpProtocol: 'tcp', FromPort: 3389, ToPort: 3389, CidrIp: ['0.0.0.0/0'] });
    aws.reset();
    for (let i = 0; i < 6; i++) await detect(id2);
    expect(aws.calls('cloudtrail:LookupEvents')).toHaveLength(h.s.cloud.lifecycle.trail.options.maxAttempts);
    const [g] = await driftOf(id2);
    expect(g!.trail).toMatchObject({ state: 'not_found', attempts: 4 });
  });

  it('a failed lookup never fails the drift run and is tried again', async () => {
    const id = await deployment(acc.aws!, 'eu-central-1');
    securityGroup('sg-0e5', 'trail-denied');
    await resource(id, fw('denied'), 'eu-central-1', 'sg-0e5');
    aws.securityGroups.get('sg-0e5')!.Ingress.push({ IpProtocol: 'tcp', FromPort: 25, ToPort: 25, CidrIp: ['0.0.0.0/0'] });
    aws.fail(400, { __type: 'AccessDeniedException', message: 'User is not authorized to perform: cloudtrail:LookupEvents' }, { op: 'cloudtrail:LookupEvents', headers: { 'x-amzn-errortype': 'AccessDeniedException' } });
    const out = await detect(id);
    expect(out.fresh).toHaveLength(1);
    const [f] = await driftOf(id);
    expect(f!.trail.state).toBe('error');
    expect(f!.changedBy).toBeNull();
  });

  it('Azure: a resource deleted out of band names its caller from the Activity Log', async () => {
    const id = await deployment(acc.azure!, 'westeurope');
    const nsg = `/subscriptions/${AZ_SUB}/resourceGroups/exprsn-az-trail/providers/Microsoft.Network/networkSecurityGroups/exprsn-az-trail-app`;
    await resource(id, fw('app'), 'westeurope', nsg);
    const at = Date.now() - 25 * 60_000;
    azure.addActivity({ subscriptionId: AZ_SUB, resourceId: nsg, caller: 'eve@contoso.example', at, operation: 'Microsoft.Network/networkSecurityGroups/delete' });
    azure.addActivity({ subscriptionId: AZ_SUB, resourceId: nsg, caller: 'eve@contoso.example', at: at - 60_000, operation: 'Microsoft.Network/networkSecurityGroups/read' });
    azure.addActivity({ subscriptionId: AZ_SUB, resourceId: `${nsg}-other`, caller: 'bob@contoso.example', at, operation: 'Microsoft.Network/networkSecurityGroups/write' });
    const out = await detect(id);
    expect(out.fresh.map((f) => [f.kind, f.key])).toEqual([['missing', 'app']]);
    const calls = azure.calls('arm:activity');
    expect(calls).toHaveLength(1);
    const filter = calls[0]!.query.get('$filter')!;
    expect(filter).toContain(`resourceUri eq '${nsg}'`);
    const ge = Date.parse(/ge '([^']+)'/.exec(filter)![1]!);
    const le = Date.parse(/le '([^']+)'/.exec(filter)![1]!);
    expect(le - ge).toBeLessThanOrEqual(24 * HOUR + 3 * 60_000);
    const [f] = await driftOf(id);
    expect(f!.changedBy).toMatchObject({ principal: 'eve@contoso.example', principalType: 'user', action: 'Microsoft.Network/networkSecurityGroups/delete', source: 'Microsoft.Network', at, sourceIp: '203.0.113.9' });
  });

  it('Cloudflare: a record changed by hand names its user from the audit logs', async () => {
    const id = await deployment(acc.cloudflare!, 'global');
    // The proxied record as the front door made it, then made DNS-only by hand.
    const rec = { id: 'a'.repeat(32), zone_id: cfZone, zone_name: 'example.test', name: 'app.example.test', type: 'CNAME', content: 'tunnel.cfargotunnel.com', ttl: 1, proxied: false, comment: null, tags: [], created_on: new Date().toISOString(), modified_on: new Date().toISOString() };
    cf.records.set(rec.id, rec);
    const desired: DesiredResource = { key: 'dns-app', type: 'dns_record', spec: { zone: 'example.test', record: 'app.example.test', recordType: 'CNAME', values: ['tunnel.cfargotunnel.com'], proxied: true }, dependsOn: [], protect: false, region: null };
    await resource(id, desired, 'global', `${cfZone}|CNAME|app.example.test`, { zoneId: cfZone, zone: 'example.test' });
    const at = Date.now() - 15 * 60_000;
    cf.addAuditLog({ resourceId: rec.id, action: 'rec_set', at, email: 'ops@example.test', name: 'app.example.test' });
    cf.addAuditLog({ resourceId: 'f'.repeat(32), action: 'rec_set', at, email: 'someone-else@example.test' });
    const out = await detect(id);
    expect(out.fresh.map((f) => [f.kind, f.key, f.path])).toEqual([['field', 'dns-app', 'proxied']]);
    expect(cf.calls(/audit_logs/)).toHaveLength(1);
    const q = cf.calls(/audit_logs/)[0]!.query;
    expect(Date.parse(q.get('before')!) - Date.parse(q.get('since')!)).toBeLessThanOrEqual(24 * HOUR + 3 * 60_000);
    const [f] = await driftOf(id);
    expect(f!.changedBy).toMatchObject({ principal: 'ops@example.test', principalType: 'user', action: 'rec_set', source: 'cloudflare:DNS_record', at, sourceIp: '192.0.2.44', byExprsn: false });
  });

  it('DigitalOcean keeps no trail: unsupported, and nothing is called', async () => {
    const trail = h.s.cloud.lifecycle.trail;
    const d = { id: 'X'.repeat(26), region: 'fra1' } as never;
    const finding = { id: '01J0000000000000000000000Z', deploymentId: 'x', tenantId: h.tenantId, kind: 'field', key: 'web', type: 'firewall', providerId: 'fw-1', path: 'ingress', desired: null, observed: null, detail: null, state: 'open', decidedBy: null, decidedAt: null, note: null, planId: null, firstSeen: Date.now(), lastSeen: Date.now() } as never;
    const ctx = { account: { provider: 'digitalocean', validation: null }, ctx: () => ({}) } as never;
    expect(await trail.lookup(d, [finding], ctx)).toEqual({ looked: 0, found: 0 });
    const [decorated] = await trail.decorate([finding as { id: string; firstSeen: number }] as never);
    expect((decorated as { trail: { state: string } }).trail.state).toBe('unsupported');
  });

  it('without migration 165 nothing is looked up and findings say the trail is unavailable', async () => {
    const trail = h.s.cloud.lifecycle.trail;
    const real = trail.installed.bind(trail);
    trail.installed = async () => false;
    try {
      const id = await deployment(acc.aws!, 'eu-central-1');
      securityGroup('sg-0f6', 'trail-nomig');
      await resource(id, fw('nomig'), 'eu-central-1', 'sg-0f6');
      aws.securityGroups.get('sg-0f6')!.Ingress.push({ IpProtocol: 'tcp', FromPort: 21, ToPort: 21, CidrIp: ['0.0.0.0/0'] });
      expect((await detect(id)).fresh).toHaveLength(1);
      expect(aws.calls('cloudtrail:LookupEvents')).toHaveLength(0);
      const [f] = await driftOf(id);
      expect(f!.changedBy).toBeNull();
      expect(f!.trail.state).toBe('unavailable');
    } finally {
      trail.installed = real;
    }
  });
});
