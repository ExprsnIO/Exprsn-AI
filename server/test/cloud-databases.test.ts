import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Principal } from '../src/authz/policy.js';
import type { CloudActor } from '../src/cloud/accounts.js';
import { databaseProblems, deletionBlock, snapshotCost, snapshotName } from '../src/cloud/databases.js';
import type { DesiredResource } from '../src/cloud/graph.js';
import { AwsProvider, AzureProvider, DigitalOceanProvider, type AdapterCredential, type CallContext, type CloudProvider, type DatabaseProps, type ObservedResource, type OperationResult, type ResourceSpec, type SnapshotResult } from '../src/cloud/providers/index.js';
import { ProviderRegistry } from '../src/cloud/providers/registry.js';
import { renderGraph } from '../src/cloud/render.js';
import { deploymentSpecSchema } from '../src/cloud/spec.js';
import { cloudTags } from '../src/cloud/tags.js';
import type { CloudAccount, Provider } from '../src/cloud/types.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { servicePolicy } from '../src/platform/egress.js';
import { DEFAULT_ZONES, type ZoneSpec } from '../src/zones/spec.js';
import { seedAccount } from './cloud-credentials-helpers.js';
import { FakeAws } from './fake-aws.js';
import { FakeAzure } from './fake-azure.js';
import { FakeDigitalOcean } from './fake-do.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * 1.9.99-final, Sprint 59 (B-10301, B-10303, B-10307): managed databases against the fakes (127.0.0.1 only, never a
 * real cloud). Each provider and engine: RDS and Aurora for PostgreSQL and MySQL, Azure Flexible Server for both, and
 * DigitalOcean Managed PostgreSQL and MySQL: created with HA, storage, backups, a maintenance window and parameters,
 * private only; the extension allow-list step and the check (pgvector, PostGIS, pg_trgm); snapshots listed with their
 * cost, restored to a new instance; deletion protection; and, through the engine, a protected database that no route
 * deletes without its final snapshot (a plan's delete, replace or protection change, drift's revert, the adapter
 * itself), with destroy taking the final snapshot and a second admin's approval first.
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const ALLOWED = '127.0.0.1,::1,localhost';
const policy = servicePolicy({ SERVICE_ALLOWED_HOSTS: '127.0.0.1' });
// These suites make more changes a minute than the providers' mutate buckets allow; the limits are B-10108's suite's.
const roomy = { points: 100_000, windowMs: 60_000 };
const limits = { limit: roomy, classLimits: { read: roomy, list: roomy, mutate: roomy, billing: roomy } };
const transport = { sleep: async () => undefined, random: () => 0.5, maxRetryWaitMs: 60_000, ...limits };
const REGION: Record<Provider, string> = { aws: 'eu-central-1', azure: 'westeurope', digitalocean: 'fra1', cloudflare: 'global' };
const EXT = ['vector', 'postgis', 'pg_trgm'];

const account = (provider: CloudAccount['provider'], name: string, ids: CloudAccount['providerIds']): CloudAccount => ({ id: `acc-${name}`, name, provider, scope: 'platform', tenantId: null, providerIds: ids, credentialMode: 'vaulted', defaultRegion: REGION[provider], state: 'active', description: null, regions: [], validation: null, createdBy: null, createdAt: 0, updatedAt: 0 });

const settle = async (p: CloudProvider, ctx: CallContext, r: OperationResult, rounds = 40): Promise<ObservedResource | null> => {
  if (r.done) return r.resource;
  const h = JSON.parse(JSON.stringify(r.operation));
  for (let i = 0; i < rounds; i++) {
    const s = await p.poll(ctx, h);
    if (s.state === 'succeeded') return s.resource;
    if (s.state === 'failed') throw Object.assign(new Error(s.error), { code: s.code });
  }
  throw new Error('still pending');
};

const follow = async (p: CloudProvider, ctx: CallContext, ref: ObservedResource, r: SnapshotResult, rounds = 40): Promise<SnapshotResult> => {
  for (let i = 0; i < rounds && r.state === 'pending'; i++) r = await p.snapshotStatus!(ctx, ref, JSON.parse(JSON.stringify(r)));
  return r;
};

const dbSpec = (name: string, props: Partial<DatabaseProps>, parent: ResourceSpec['parent'] = {}): ResourceSpec<'database'> => ({ type: 'database', name, idempotencyKey: `${name}-create`, tags: cloudTags({ account: 'lab', deployment: 'lab' }), parent, props: { engine: 'postgres', size: 'x', publicAccess: false, privateEndpoint: true, ...props } as DatabaseProps });

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

/** A broker that hands the vault reference's value to the provider (and records who asked). */
const asked: string[] = [];
const broker = { value: async (b: { ref: string }) => (asked.push(b.ref), 'Admin-pw-from-the-vault-1'), wrap: async () => null };

// ---------------------------------------------------------------- the pure rules

describe('engines, versions, extensions and the planner rules (B-10301, B-10303, B-10307)', () => {
  const db = (spec: Record<string, unknown>): DesiredResource => ({ key: 'db', type: 'database', spec: { engine: 'postgres', size: 'db.m6g.large', publicAccess: false, ...spec }, dependsOn: [], network: 'net', protect: true, region: null });

  it('refuses what a provider does not offer before anything is created, naming a missing extension', () => {
    expect(databaseProblems([db({ extensions: EXT, version: '16' })], 'aws')).toEqual([]);
    expect(databaseProblems([db({ extensions: ['vector', 'plv8'] })], 'azure')).toEqual(['db (database): extension plv8 is not offered by azure PostgreSQL 17.']);
    expect(databaseProblems([db({ engine: 'mysql', extensions: ['vector'] })], 'digitalocean')).toEqual([expect.stringMatching(/extension vector is PostgreSQL's/)]);
    expect(databaseProblems([db({ version: '12' })], 'aws')).toEqual([expect.stringMatching(/postgres 12 is not offered/)]);
    expect(databaseProblems([db({ service: 'aurora', version: '17' })], 'aws')).toEqual([expect.stringMatching(/aurora postgres 17 is not offered/)]);
    expect(databaseProblems([db({ size: 'Standard_B2s', ha: true })], 'azure')).toEqual([expect.stringMatching(/high availability only on General Purpose/)]);
    expect(databaseProblems([db({ backups: { days: 14 } })], 'digitalocean')).toEqual([expect.stringMatching(/seven days of backups/)]);
    expect(databaseProblems([db({ adminPasswordRef: 'hunter2' })], 'aws')).toEqual([expect.stringMatching(/vault: reference, never a value/)]);
    expect(databaseProblems([db({ engine: 'mysql', version: '8.0' })], 'azure')).toEqual([]);
  });

  it('keeps deletion protection on by default: a protected database is not deleted, replaced or unprotected by a plan', () => {
    const row = { type: 'database' as const, key: 'db', desired: db({}), observed: { props: { deletionProtection: true } } as unknown as ObservedResource };
    expect(deletionBlock('delete', row)).toMatch(/final snapshot and a second admin/);
    expect(deletionBlock('replace', row)).toMatch(/replacing it would delete it/);
    expect(deletionBlock('update', row, { spec: { deletionProtection: false } })).toMatch(/not turned off by a plan/);
    expect(deletionBlock('update', row, { spec: { size: 'bigger' } })).toBeNull();
    // Only a database created without it, and without it at the provider, is deleted by a plan.
    expect(deletionBlock('delete', { ...row, desired: db({ deletionProtection: false }), observed: { props: { deletionProtection: false } } as unknown as ObservedResource })).toBeNull();
    expect(deletionBlock('delete', { ...row, desired: db({ deletionProtection: false }) })).not.toBeNull();
  });

  it('renders the data tier with protection, the extensions, backups and a maintenance window, private only', () => {
    const zones = new Map<string, { version: number; spec: ZoneSpec }>(DEFAULT_ZONES.map((z) => [z.id, { version: 1, spec: structuredClone(z.spec) }]));
    for (const provider of ['aws', 'azure', 'digitalocean'] as const) {
      const spec = deploymentSpecSchema.parse({ name: 'lab', target: { provider, accountId: '01JAAAAAAAAAAAAAAAAAAAAAAA', region: REGION[provider] }, compute: { shape: 'kubernetes', size: 'large' }, data: { mode: 'provision' }, frontDoor: { kind: 'byo', hostname: 'ai.example.com' } });
      const g = renderGraph(spec, { zones, corporateCidrs: [] });
      const r = g.resources.find((x) => x.type === 'database')!;
      expect(r).toMatchObject({ protect: true, spec: { engine: 'postgres', version: '17', ha: true, publicAccess: false, privateEndpoint: true, deletionProtection: true, extensions: ['vector', 'pg_trgm'], maintenanceWindow: { day: 'sun', hour: 3 }, backups: { days: 7 } } });
      expect(databaseProblems(g.resources, provider)).toEqual([]);
    }
  });

  it('names snapshots by purpose; a final one is what the delete guard looks for', () => {
    expect(snapshotName('lab-db', 'final', Date.UTC(2026, 9, 20, 12, 30, 5))).toBe('lab-db-final-20261020123005');
    expect(snapshotName('lab-db', 'scheduled', Date.UTC(2026, 9, 20, 12, 30, 5))).toBe('lab-db-sched-20261020123005');
  });
});

// ---------------------------------------------------------------- AWS: RDS and Aurora

describe('RDS and Aurora on the AWS fake (B-10301, B-10303, B-10307)', () => {
  const aws = new FakeAws();
  let p: AwsProvider;
  let ctx: CallContext;
  const parent = { refs: { 'sub-a': 'subnet-0a', 'sub-b': 'subnet-0b', 'fw-data': 'sg-0data' } };

  beforeAll(async () => {
    await aws.start();
    const key = aws.addUser({ userName: 'exprsn' });
    p = new AwsProvider({ policy, ...transport, endpoints: { sts: aws.url, ec2: aws.url, rds: aws.url } });
    ctx = { account: account('aws', 'lab', { awsAccountId: aws.account }), cred: { kind: 'aws', accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey, expiresAt: null }, region: 'eu-central-1', secrets: broker };
  });
  afterAll(async () => aws.stop());

  it('RDS PostgreSQL: HA, storage, backups, the maintenance window, a parameter group with the allow-list step; private and protected', async () => {
    const spec = dbSpec('pg', { version: '16', size: 'db.m6g.large', ha: true, storageGb: 100, storageAutogrow: true, subnets: ['sub-a', 'sub-b'], firewall: 'fw-data', backups: { days: 14, window: '02:00-03:00' }, maintenanceWindow: { day: 'sun', hour: 3 }, parameters: { work_mem: '65536', 'rds.allowed_extensions': 'pg_stat_statements' }, extensions: EXT }, parent);
    const o = (await settle(p, ctx, await p.create(ctx, spec)))!;
    const inst = aws.rds.instances.get('exprsn-lab-pg')!;
    expect(inst).toMatchObject({ engine: 'postgres', engineVersion: expect.stringMatching(/^16\./), instanceClass: 'db.m6g.large', allocatedStorage: 100, maxAllocatedStorage: 400, multiAz: true, publiclyAccessible: false, deletionProtection: true, retention: 14, backupWindow: '02:00-03:00', maintenanceWindow: 'sun:03:00-sun:04:00', subnetGroup: 'exprsn-lab-pg', securityGroups: ['sg-0data'], storageEncrypted: true, managedPassword: true, passwordGiven: false });
    expect(aws.rds.subnetGroups.get('exprsn-lab-pg')!.subnets).toEqual(['subnet-0a', 'subnet-0b']);
    // The allow-list step: the parameters restrict extensions, so the wanted ones are added to them.
    expect(aws.rds.paramGroups.get('exprsn-lab-pg')).toMatchObject({ family: 'postgres16', params: { work_mem: '65536', 'rds.allowed_extensions': 'pg_stat_statements,vector,postgis,pg_trgm' } });
    expect(o).toMatchObject({ type: 'database', providerId: 'instance:exprsn-lab-pg', state: 'ready', tags: { 'exprsn:managed': 'true', 'exprsn:account': 'lab' }, props: { engine: 'postgres', service: 'rds', version: '16', size: 'db.m6g.large', ha: true, storageGb: 100, backups: { days: 14, window: '02:00-03:00' }, maintenanceWindow: { day: 'sun', hour: 3 }, deletionProtection: true, publicAccess: false, privateEndpoint: true, parameters: { work_mem: '65536' } } });
    // A retried create (a lost response) adopts the instance: one CreateDBInstance.
    expect(await p.create(ctx, spec)).toMatchObject({ done: true, adopted: true, resource: { providerId: 'instance:exprsn-lab-pg' } });
    expect(aws.calls('rds:CreateDBInstance')).toHaveLength(1);
    // The extension check: offered for RDS PostgreSQL 16 and allowed by the parameter group.
    expect(await p.databaseExtensions(ctx, o, [...EXT, 'plv8'])).toEqual([
      { name: 'vector', state: 'available', source: 'allow_list' },
      { name: 'postgis', state: 'available', source: 'allow_list' },
      { name: 'pg_trgm', state: 'available', source: 'allow_list' },
      expect.objectContaining({ name: 'plv8', state: 'not_offered' })
    ]);
    // In place: a larger size.
    await settle(p, ctx, await p.update(ctx, o, { ...spec, props: { ...spec.props, size: 'db.m6g.xlarge' } }));
    expect(inst.instanceClass).toBe('db.m6g.xlarge');
  });

  it('RDS: snapshots listed with their cost, restored to a new instance; no delete without a fresh final snapshot', async () => {
    const o = (await p.describe(ctx, { type: 'database', providerId: 'instance:exprsn-lab-pg' }))!;
    const manual = await follow(p, ctx, o, await p.snapshot!(ctx, o, 'lab-pg-manual-20261020120000', { purpose: 'manual' }));
    expect(manual).toMatchObject({ state: 'done', snapshotId: 'lab-pg-manual-20261020120000' });
    const list = await p.listSnapshots!(ctx, o);
    const m = list.find((s) => s.id === manual.snapshotId)!;
    expect(m).toMatchObject({ kind: 'manual', state: 'available', final: false, sizeGb: 100, billing: { sku: 'rds:snapshot', unit: 'gb-month' } });
    expect(list.find((s) => s.kind === 'automated')).toMatchObject({ billing: { unit: 'included' }, expiresAt: expect.any(Number) });
    expect(snapshotCost('aws', m, 'eu-central-1')).toMatchObject({ monthly: 9.5, sku: 'rds:snapshot', unit: 'gb-month', price: 0.095, unverified: true });
    // Restore to a new instance beside it: the same subnets, security group and parameters, private and protected.
    const restored = await follow(p, ctx, o, await p.restoreSnapshot!(ctx, o, manual.snapshotId!, { name: 'exprsn-lab-pg-restored' }));
    expect(restored).toMatchObject({ state: 'done', restoredId: 'instance:exprsn-lab-pg-restored' });
    expect(aws.rds.instances.get('exprsn-lab-pg-restored')).toMatchObject({ restoredFrom: manual.snapshotId, publiclyAccessible: false, deletionProtection: true, subnetGroup: 'exprsn-lab-pg', securityGroups: ['sg-0data'], paramGroup: 'exprsn-lab-pg' });
    // No final snapshot: the delete is refused and nothing is deleted.
    await expect(p.delete(ctx, o)).rejects.toMatchObject({ code: 'final_snapshot_required', status: 409 });
    // A final snapshot from months ago does not count.
    aws.rds.addSnapshot({ id: 'exprsn-lab-db-final-20260101000000', source: 'exprsn-lab-pg', createdAt: Date.now() - 90 * 86_400_000 });
    await expect(p.delete(ctx, o)).rejects.toMatchObject({ code: 'final_snapshot_required' });
    expect(aws.calls('rds:DeleteDBInstance')).toHaveLength(0);
    // With its final snapshot: protection off, then the delete; the final snapshot outlives the instance.
    const fin = await follow(p, ctx, o, await p.snapshot!(ctx, o, 'exprsn-lab-db-final-20261020123000'));
    expect(fin).toMatchObject({ state: 'done' });
    expect(await settle(p, ctx, await p.delete(ctx, o))).toBeNull();
    expect(aws.rds.instances.has('exprsn-lab-pg')).toBe(false);
    expect(aws.rds.snapshots.get(fin.snapshotId!)).toMatchObject({ type: 'manual', status: 'available', tags: { 'exprsn:purpose': 'final' } });
    const modify = aws.calls('rds:ModifyDBInstance').at(-1)!;
    expect(new URLSearchParams(modify.body).get('DeletionProtection')).toBe('false');
    await expect(p.deleteSnapshot!(ctx, o, fin.snapshotId!)).rejects.toMatchObject({ code: 'final_snapshot' });
  });

  it('RDS MySQL: a MySQL parameter group, the admin password from the vault handed straight to RDS, no extensions', async () => {
    const spec = dbSpec('my', { engine: 'mysql', version: '8.0', size: 'db.t4g.medium', storageGb: 50, subnets: ['sub-a'], firewall: 'fw-data', parameters: { max_connections: '400' }, adminPasswordRef: 'vault:cloud/lab#db_admin' }, parent);
    const o = (await settle(p, ctx, await p.create(ctx, spec)))!;
    expect(aws.rds.instances.get('exprsn-lab-my')).toMatchObject({ engine: 'mysql', engineVersion: expect.stringMatching(/^8\.0\./), managedPassword: false, passwordGiven: true, publiclyAccessible: false });
    expect(asked).toContain('vault:cloud/lab#db_admin');
    expect(aws.rds.paramGroups.get('exprsn-lab-my')).toMatchObject({ family: 'mysql8.0', params: { max_connections: '400' } });
    expect(JSON.stringify(aws.rds.instances.get('exprsn-lab-my'))).not.toContain('Admin-pw-from-the-vault-1');
    expect(o.props).toMatchObject({ engine: 'mysql', version: '8.0' });
    expect((await p.databaseExtensions(ctx, o, ['vector']))[0]).toMatchObject({ state: 'not_offered', detail: 'MySQL has no extensions.' });
  });

  it('Aurora MySQL: a cluster with a writer and a reader for HA, cluster snapshots, restore, protected delete', async () => {
    const spec = dbSpec('au', { engine: 'mysql', service: 'aurora', version: '8.0', size: 'db.r6g.large', ha: true, subnets: ['sub-a', 'sub-b'], firewall: 'fw-data', backups: { days: 7 } }, parent);
    const o = (await settle(p, ctx, await p.create(ctx, spec)))!;
    expect(aws.rds.clusters.get('exprsn-lab-au')).toMatchObject({ engine: 'aurora-mysql', deletionProtection: true, subnetGroup: 'exprsn-lab-au', securityGroups: ['sg-0data'], managedPassword: true });
    expect([...aws.rds.instances.values()].filter((i) => i.cluster === 'exprsn-lab-au').map((i) => [i.id, i.instanceClass, i.publiclyAccessible])).toEqual([
      ['exprsn-lab-au-w', 'db.r6g.large', false],
      ['exprsn-lab-au-r', 'db.r6g.large', false]
    ]);
    expect(o).toMatchObject({ providerId: 'cluster:exprsn-lab-au', props: { engine: 'mysql', service: 'aurora', version: '8.0', size: 'db.r6g.large', ha: true, deletionProtection: true } });
    const snap = await follow(p, ctx, o, await p.snapshot!(ctx, o, 'exprsn-lab-au-manual-20261020120000', { purpose: 'manual' }));
    expect((await p.listSnapshots!(ctx, o)).find((s) => s.id === snap.snapshotId)).toMatchObject({ billing: { sku: 'aurora:snapshot' } });
    const restored = await follow(p, ctx, o, await p.restoreSnapshot!(ctx, o, snap.snapshotId!, { name: 'exprsn-lab-au-restored' }));
    expect(restored).toMatchObject({ state: 'done', restoredId: 'cluster:exprsn-lab-au-restored' });
    await expect(p.delete(ctx, o)).rejects.toMatchObject({ code: 'final_snapshot_required' });
    await follow(p, ctx, o, await p.snapshot!(ctx, o, 'exprsn-lab-au-final-20261020123000'));
    expect(await settle(p, ctx, await p.delete(ctx, o))).toBeNull();
    expect(aws.rds.clusters.has('exprsn-lab-au')).toBe(false);
    expect([...aws.rds.instances.values()].some((i) => i.cluster === 'exprsn-lab-au')).toBe(false);
  });

  it('refuses a public database before calling RDS', async () => {
    const n = aws.requests.length;
    await expect(p.create(ctx, dbSpec('pub', { size: 'db.t4g.medium', publicAccess: true }, parent))).rejects.toMatchObject({ code: 'public_data' });
    expect(aws.requests.length).toBe(n);
  });
});

// ---------------------------------------------------------------- Azure: Flexible Server

describe('Azure Database for PostgreSQL and MySQL Flexible Server on the fake (B-10301, B-10303, B-10307)', () => {
  const az = new FakeAzure();
  const tenant = 'tenant-db';
  const sub = '00000000-0000-4000-8000-0000000000db';
  let p: AzureProvider;
  let ctx: CallContext;
  const subnetId = `/subscriptions/${sub}/resourceGroups/exprsn-lab/providers/Microsoft.Network/virtualNetworks/exprsn-lab-net/subnets/exprsn-lab-data`;
  const server = (name: string, engine = 'PostgreSQL') => `/subscriptions/${sub}/resourceGroups/exprsn-lab/providers/Microsoft.DBfor${engine}/flexibleServers/${name}`;
  const res = (id: string) => az.resources.get(id.toLowerCase());

  beforeAll(async () => {
    await az.start();
    az.publicOrigin = 'https://management.azure.com';
    az.addSubscription(sub, tenant);
    p = new AzureProvider({ policy, ...transport, testOrigins: { 'https://management.azure.com': az.url } });
    ctx = { account: account('azure', 'lab', { azureTenantId: tenant, azureSubscriptionId: sub }), cred: azureCred(az, tenant), region: 'westeurope', secrets: broker };
  });
  afterAll(async () => az.stop());

  it('PostgreSQL: the allow-list step enables pgvector, PostGIS and pg_trgm and the check reports them available; private, protected', async () => {
    const spec = dbSpec('pg', { version: '16', size: 'Standard_D2ds_v5', ha: true, storageGb: 128, subnets: ['sub-data'], firewall: 'fw-data', backups: { days: 14 }, maintenanceWindow: { day: 'sun', hour: 3 }, parameters: { work_mem: '8192' }, extensions: EXT }, { refs: { 'sub-data': subnetId, 'fw-data': 'nsg' } });
    const o = (await settle(p, ctx, await p.create(ctx, spec)))!;
    const id = server('exprsn-lab-pg');
    const body = res(id)!.body as { sku: { name: string; tier: string }; properties: Record<string, unknown> };
    expect(body.sku).toEqual({ name: 'Standard_D2ds_v5', tier: 'GeneralPurpose' });
    expect(body.properties).toMatchObject({ version: '16', storage: { storageSizeGB: 128 }, backup: { backupRetentionDays: 14, geoRedundantBackup: 'Disabled' }, highAvailability: { mode: 'ZoneRedundant' }, network: { publicNetworkAccess: 'Disabled' }, maintenanceWindow: { customWindow: 'Enabled', dayOfWeek: 0, startHour: 3 } });
    // The admin password went to Azure once and is kept nowhere.
    expect(az.db.puts.find((x) => x.id.toLowerCase() === id.toLowerCase())).toMatchObject({ password: true });
    expect(JSON.stringify([...az.resources.values()])).not.toContain('administratorLoginPassword');
    // The allow-list step: azure.extensions lists them, so CREATE EXTENSION works.
    expect((res(`${id}/configurations/azure.extensions`)!.body.properties as { value: string }).value).toBe('VECTOR,POSTGIS,PG_TRGM');
    expect(az.db.availableExtensions(id, (k) => az.resources.get(k))).toEqual(EXT);
    expect((res(`${id}/configurations/work_mem`)!.body.properties as { value: string }).value).toBe('8192');
    expect(await p.databaseExtensions(ctx, o, EXT)).toEqual(EXT.map((name) => ({ name, state: 'available', source: 'allow_list' })));
    // The private endpoint in the data subnet, and the deletion lock.
    const pe = res(`/subscriptions/${sub}/resourceGroups/exprsn-lab/providers/Microsoft.Network/privateEndpoints/exprsn-lab-pg-pe`)!.body.properties as { subnet: { id: string }; privateLinkServiceConnections: { properties: { privateLinkServiceId: string; groupIds: string[] } }[] };
    expect(pe.subnet.id).toBe(subnetId);
    expect(pe.privateLinkServiceConnections[0]!.properties).toEqual({ privateLinkServiceId: id, groupIds: ['postgresqlServer'] });
    expect([...az.db.locks.values()]).toEqual([expect.objectContaining({ scope: id.toLowerCase(), level: 'CanNotDelete' })]);
    expect(o).toMatchObject({ state: 'ready', props: { engine: 'postgres', version: '16', size: 'Standard_D2ds_v5', ha: true, storageGb: 128, backups: { days: 14 }, maintenanceWindow: { day: 'sun', hour: 3 }, deletionProtection: true, publicAccess: false, privateEndpoint: true, parameters: { work_mem: '8192' } } });
    // A retried create (lost response) is the same server, and its settings are made to match.
    expect(await p.create(ctx, spec)).toMatchObject({ adopted: true });
    expect(az.db.puts.filter((x) => x.id.toLowerCase() === id.toLowerCase())).toHaveLength(1);
  });

  it('an unknown extension in the allow-list is refused by Azure, and the check says which are not allowed', async () => {
    const o = (await p.describe(ctx, { type: 'database', providerId: server('exprsn-lab-pg') }))!;
    expect(await p.databaseExtensions(ctx, o, ['vector', 'pgcrypto', 'plv8'])).toEqual([
      { name: 'vector', state: 'available', source: 'allow_list' },
      expect.objectContaining({ name: 'pgcrypto', state: 'not_offered' }),
      expect.objectContaining({ name: 'plv8', state: 'not_offered' })
    ]);
  });

  it('PostgreSQL: no delete without the final snapshot, a retained copy; copies are snapshots, not databases', async () => {
    const id = server('exprsn-lab-pg');
    const o = (await p.describe(ctx, { type: 'database', providerId: id }))!;
    await expect(p.delete(ctx, o)).rejects.toMatchObject({ code: 'final_snapshot_required' });
    expect(res(id)).toBeTruthy();
    // ARM itself refuses a delete while the lock is on.
    const fin = await follow(p, ctx, o, await p.snapshot!(ctx, o, 'exprsn-lab-db-final-20261020123000'));
    expect(fin).toMatchObject({ state: 'done', snapshotId: server('exprsn-lab-db-final-20261020123000') });
    const copy = res(fin.snapshotId!)!;
    expect(copy.tags).toMatchObject({ 'exprsn:snapshot-of': id.toLowerCase(), 'exprsn:purpose': 'final' });
    expect(copy.body).toMatchObject({ sku: { name: 'Standard_B1ms', tier: 'Burstable' }, properties: { createMode: 'PointInTimeRestore', sourceServerResourceId: id, network: { publicNetworkAccess: 'Disabled' } } });
    expect((await p.list(ctx, 'database', { managedOnly: true })).map((x) => x.providerId)).toEqual([id]);
    const snaps = await p.listSnapshots!(ctx, o);
    expect(snaps).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'automated', billing: { sku: 'postgres:backup', unit: 'included' } }), expect.objectContaining({ kind: 'copy', final: true, id: fin.snapshotId, billing: { sku: 'postgres:Standard_B1ms', unit: 'month' } })]));
    expect(snapshotCost('azure', snaps.find((s) => s.kind === 'copy')!)).toMatchObject({ monthly: 15.11, unverified: true });
    expect(await settle(p, ctx, await p.delete(ctx, o))).toBeNull();
    expect(res(id)).toBeUndefined();
    expect(az.db.locks.size).toBe(0);
    expect(res(fin.snapshotId!)).toBeTruthy();
  });

  it('MySQL: the admin password from the vault, on-demand backups, restore to a new server with its settings', async () => {
    const spec = dbSpec('my', { engine: 'mysql', version: '8.0', size: 'Standard_B2s', storageGb: 32, subnets: ['sub-data'], parameters: { max_connections: '300' }, adminPasswordRef: 'vault:cloud/lab#mysql_admin' }, { refs: { 'sub-data': subnetId } });
    const o = (await settle(p, ctx, await p.create(ctx, spec)))!;
    const id = server('exprsn-lab-my', 'MySQL');
    expect(asked).toContain('vault:cloud/lab#mysql_admin');
    expect((res(id)!.body as { sku: unknown; properties: { version: string } }).properties.version).toBe('8.0.21');
    expect(res(id)!.body).toMatchObject({ sku: { tier: 'Burstable' } });
    expect(JSON.stringify(res(id)!.body)).not.toContain('Admin-pw-from-the-vault-1');
    expect(o.props).toMatchObject({ engine: 'mysql', version: '8.0', deletionProtection: true, privateEndpoint: true, parameters: { max_connections: '300' } });
    const backup = await follow(p, ctx, o, await p.snapshot!(ctx, o, 'exprsn-lab-my-manual-20261020120000', { purpose: 'manual' }));
    expect(backup).toMatchObject({ state: 'done', snapshotId: `${id}/backups/exprsn-lab-my-manual-20261020120000` });
    expect((await p.listSnapshots!(ctx, o)).find((s) => s.id === backup.snapshotId)).toMatchObject({ kind: 'manual', billing: { sku: 'mysql:backup', unit: 'gb-month' } });
    const restored = await follow(p, ctx, o, await p.restoreSnapshot!(ctx, o, backup.snapshotId!, { name: 'exprsn-lab-my-restored' }));
    const rid = server('exprsn-lab-my-restored', 'MySQL');
    expect(restored).toMatchObject({ state: 'done', restoredId: rid });
    expect(res(rid)!.body).toMatchObject({ properties: { createMode: 'PointInTimeRestore', sourceServerResourceId: id, network: { publicNetworkAccess: 'Disabled' } } });
    expect((res(`${rid}/configurations/max_connections`)!.body.properties as { value: string }).value).toBe('300');
    expect([...az.db.locks.values()].some((l) => l.scope === rid.toLowerCase())).toBe(true);
    expect((await p.databaseExtensions(ctx, o, ['vector']))[0]).toMatchObject({ state: 'not_offered' });
  });
});

// ---------------------------------------------------------------- DigitalOcean

describe('DigitalOcean Managed PostgreSQL and MySQL on the fake (B-10301, B-10303, B-10307)', () => {
  const dof = new FakeDigitalOcean();
  let p: DigitalOceanProvider;
  let ctx: CallContext;
  let vpc: ObservedResource;
  let fw: ObservedResource;

  beforeAll(async () => {
    await dof.start();
    p = new DigitalOceanProvider({ policy, ...transport, endpoints: { api: dof.url } });
    ctx = { account: account('digitalocean', 'lab', { doTeamId: 'team' }), cred: { kind: 'token', token: dof.addToken() }, region: 'fra1' };
    vpc = (await settle(p, ctx, await p.create(ctx, { type: 'network', name: 'data', idempotencyKey: 'n', tags: cloudTags({ account: 'lab' }), props: { cidr: '10.30.0.0/20' } })))!;
    fw = (await settle(p, ctx, await p.create(ctx, { type: 'firewall', name: 'fw-data', idempotencyKey: 'f', tags: cloudTags({ account: 'lab' }), props: { ingress: [{ protocol: 'tcp', ports: '25060', sources: ['10.30.4.0/24'] }] } })))!;
  });
  afterAll(async () => dof.stop());

  it('PostgreSQL: in the data VPC, a standby, trusted sources from the data firewall, the window and config; the password dropped', async () => {
    const spec = dbSpec('pg', { version: '16', size: 'db-s-2vcpu-4gb', ha: true, storageGb: 60, firewall: 'fw-data', maintenanceWindow: { day: 'sun', hour: 3 }, parameters: { work_mem: '8192' }, extensions: EXT, backups: { days: 7 } }, { networkId: vpc.providerId, refs: { 'fw-data': fw.providerId } });
    const o = (await settle(p, ctx, await p.create(ctx, spec)))!;
    const c = [...dof.dbs.clusters.values()].find((x) => x.name === 'exprsn-lab-pg')!;
    expect(c).toMatchObject({ engine: 'pg', version: '16', size: 'db-s-2vcpu-4gb', num_nodes: 2, private_network_uuid: vpc.providerId, storage_size_mib: 60 * 1024, maintenance_window: { day: 'sunday', hour: '03:00:00' }, config: { work_mem: '8192' } });
    expect(c.tags).toEqual(expect.arrayContaining(['exprsn:managed:true', 'exprsn:account:lab', 'exprsn-deletion-protection']));
    expect(c.firewall.map((f) => [f.type, f.value])).toEqual([['ip_addr', '10.30.4.0/24']]);
    // DigitalOcean answered with the admin password; it is in no observed state, handle or journal.
    expect(JSON.stringify(o)).not.toContain(String(c.connection.password));
    expect(o).toMatchObject({ state: 'ready', props: { engine: 'postgres', version: '16', ha: true, storageGb: 60, backups: { days: 7 }, maintenanceWindow: { day: 'sun', hour: 3 }, deletionProtection: true, publicAccess: false, privateEndpoint: true, parameters: { work_mem: '8192' } } });
    expect(await p.databaseExtensions(ctx, o, EXT)).toEqual(EXT.map((name) => ({ name, state: 'available', source: 'supported_list' })));
    expect(await p.create(ctx, spec)).toMatchObject({ adopted: true });
    expect([...dof.dbs.clusters.values()].filter((x) => x.name === 'exprsn-lab-pg')).toHaveLength(1);
  });

  it('PostgreSQL: no delete without the final snapshot, a retained fork with the same trusted sources', async () => {
    const c = [...dof.dbs.clusters.values()].find((x) => x.name === 'exprsn-lab-pg')!;
    const o = (await p.describe(ctx, { type: 'database', providerId: c.id }))!;
    await expect(p.delete(ctx, o)).rejects.toMatchObject({ code: 'final_snapshot_required' });
    expect(dof.dbs.clusters.has(c.id)).toBe(true);
    const fin = await follow(p, ctx, o, await p.snapshot!(ctx, o, 'exprsn-lab-db-final-20261020123000'));
    const fork = dof.dbs.clusters.get(fin.snapshotId!)!;
    expect(fork).toMatchObject({ size: 'db-s-1vcpu-1gb', num_nodes: 1, restoredFrom: { database_name: 'exprsn-lab-pg' }, private_network_uuid: vpc.providerId });
    expect(fork.tags).toEqual(expect.arrayContaining([`exprsn:snapshot-of:${c.id}`, 'exprsn:purpose:final']));
    expect(fork.firewall.map((f) => f.value)).toEqual(['10.30.4.0/24']);
    expect((await p.list(ctx, 'database', { managedOnly: true })).map((x) => x.providerId)).toEqual([c.id]);
    const snaps = await p.listSnapshots!(ctx, o);
    expect(snaps).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'automated', billing: { sku: 'do-db:backup', unit: 'included' } }), expect.objectContaining({ kind: 'copy', final: true, billing: { sku: 'do-db:db-s-1vcpu-1gb', unit: 'month' } })]));
    expect(snapshotCost('digitalocean', snaps.find((s) => s.kind === 'copy')!)).toMatchObject({ monthly: 15.15, unverified: true });
    expect(snapshotCost('digitalocean', snaps.find((s) => s.kind === 'automated')!)).toMatchObject({ monthly: 0, unit: 'included' });
    expect(await settle(p, ctx, await p.delete(ctx, o))).toBeNull();
    expect(dof.dbs.clusters.has(c.id)).toBe(false);
    expect(dof.dbs.clusters.has(fork.id)).toBe(true);
  });

  it('MySQL: the VPC range when the zone names no sources; restore points, forks and restores; no schedule of its own', async () => {
    const o = (await settle(p, ctx, await p.create(ctx, dbSpec('my', { engine: 'mysql', version: '8', size: 'db-s-1vcpu-2gb' }, { networkId: vpc.providerId }))))!;
    const c = dof.dbs.clusters.get(o.providerId)!;
    expect(c).toMatchObject({ engine: 'mysql', version: '8' });
    expect(c.firewall.map((f) => f.value)).toEqual(['10.30.0.0/20']);
    const point = await p.snapshot!(ctx, o, 'exprsn-lab-my-preup-20261020120000', { purpose: 'upgrade' });
    expect(point).toMatchObject({ state: 'done', snapshotId: expect.stringMatching(/^pitr:/) });
    await expect(p.snapshot!(ctx, o, 'x-sched-20261020120000', { purpose: 'scheduled' })).rejects.toMatchObject({ code: 'provider_schedule' });
    const restored = await follow(p, ctx, o, await p.restoreSnapshot!(ctx, o, point.snapshotId!, { name: 'exprsn-lab-my-restored' }));
    const r = dof.dbs.clusters.get(restored.restoredId!)!;
    expect(r).toMatchObject({ name: 'exprsn-lab-my-restored', engine: 'mysql', size: 'db-s-1vcpu-2gb', restoredFrom: { database_name: 'exprsn-lab-my', backup_created_at: point.snapshotId!.slice(5) } });
    expect(r.tags).toContain('exprsn-deletion-protection');
    expect(r.firewall.map((f) => f.value)).toEqual(['10.30.0.0/20']);
    const manual = await follow(p, ctx, o, await p.snapshot!(ctx, o, 'exprsn-lab-my-manual-20261020120000', { purpose: 'manual' }));
    expect((await p.listSnapshots!(ctx, o)).find((s) => s.id === manual.snapshotId)).toMatchObject({ kind: 'copy', final: false });
    await p.deleteSnapshot!(ctx, o, manual.snapshotId!);
    expect(dof.dbs.clusters.has(manual.snapshotId!)).toBe(false);
  });
});

// ---------------------------------------------------------------- through the engine: plan, apply, routes, destroy

interface World {
  h: Harness;
  az: FakeAzure;
  dof: FakeDigitalOcean;
  azure: CloudAccount;
  digitalocean: CloudAccount;
  alice: CloudActor & { client: Client };
  bob: CloudActor & { client: Client };
}

const D = '/api/admin/cloud/deployments';
const VALIDATED = { at: Date.now(), ok: true, identity: { ok: true }, features: [{ feature: 'deploy', name: 'Deploy', status: 'ok', required: [], missing: [], reason: null }] };

async function person(h: Harness, name: string): Promise<CloudActor & { client: Client }> {
  const u = await localUser(h, name, ['system-admin'], 'restricted');
  const client = await loginAdmin(h, name);
  const p = (await loadPrincipal(h.s, h.tenantId, u.id, {}))!;
  const principal: Principal = { ...p, mfa: true };
  return { principal, ip: '127.0.0.1', client };
}

async function world(): Promise<World> {
  const h = await harness({ SERVICE_ALLOWED_HOSTS: ALLOWED });
  if (!(await h.s.db.schema.hasTable('cloud_deployments'))) await (await import('../src/db/migrations/148_cloud_journal.js')).up(h.s.db);
  if (!(await h.s.db.schema.hasTable('cloud_drift_findings'))) await (await import('../src/db/migrations/149_cloud_lifecycle.js')).up(h.s.db);
  h.s.cloud.deployments.resetSchemaCache();
  h.s.cloud.lifecycle.schema.reset();
  const az = await new FakeAzure().start();
  const dof = await new FakeDigitalOcean().start();
  az.publicOrigin = 'https://management.azure.com';
  const tenant = '00000000-0000-4000-8000-00000000db01';
  const sub = '00000000-0000-4000-8000-00000000db02';
  az.addSubscription(sub, tenant);
  const registry = new ProviderRegistry({ policy: servicePolicy({ SERVICE_ALLOWED_HOSTS: ALLOWED }), endpoints: { digitalocean: { api: dof.url } }, transport: { sleep: async () => undefined, random: () => 0.5, testOrigins: { 'https://management.azure.com': az.url }, ...limits } });
  Object.defineProperty(h.s.cloud, 'providers', { value: registry, configurable: true });
  h.s.cloud.prices!.setEndpoints({ azureRetail: `${az.url}/api/retail/prices`, digitalocean: dof.url, awsPricing: 'http://127.0.0.1:9' });
  const creds: Partial<Record<Provider, AdapterCredential>> = { azure: azureCred(az, tenant), digitalocean: { kind: 'token', token: dof.addToken() } };
  (h.s.cloud as { credentials: unknown }).credentials = { for: async (a: { provider: Provider }) => creds[a.provider] };
  h.s.cloud.engine.options.sleep = async () => undefined;
  h.s.cloud.lifecycle.destroys.options.sleep = async () => undefined;
  h.s.cloud.lifecycle.destroys.options.maxSnapshotMs = 30_000;
  h.s.cloud.databases.options.maxWaitMs = 30_000;
  h.s.cloud.databases.options.sleep = async () => undefined;
  const seed = async (provider: 'azure' | 'digitalocean', ids: CloudAccount['providerIds']) => {
    const a = await seedAccount(h, { provider, mode: 'vaulted', name: `${provider === 'azure' ? 'az' : 'do'}-data`, providerIds: ids, refs: { token: 'vault:cloud/data#token' } });
    await h.s.db('cloud_accounts').where({ id: a.id }).update({ validation: JSON.stringify(VALIDATED) });
    return (await h.s.cloud.accounts.get(a.id))!;
  };
  return { h, az, dof, azure: await seed('azure', { azureTenantId: tenant, azureSubscriptionId: sub }), digitalocean: await seed('digitalocean', { doTeamId: dof.account.team.uuid }), alice: await person(h, 'alice'), bob: await person(h, 'bob') };
}

async function drain(w: World): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const ran = await w.h.s.jobs.runDue();
    await w.h.s.cloud.lifecycle.idle();
    if (!ran) {
      const due = await w.h.s.db('jobs').where({ state: 'queued' }).andWhere('run_at', '<=', Date.now()).first();
      if (!due) return;
    }
  }
}

const send = (who: World['alice'], method: 'post' | 'put' | 'get', path: string, body: object = {}) => (method === 'get' ? who.client.agent.get(path) : who.client.agent[method](path).set('x-csrf-token', who.client.csrf).send(body));

const azGraph = (db: Record<string, unknown> = {}): DesiredResource[] => [
  { key: 'net', type: 'network', spec: { cidr: '10.40.0.0/16' }, dependsOn: [], protect: false, region: null },
  { key: 'sub-data', type: 'subnet', spec: { cidr: '10.40.1.0/24' }, dependsOn: [], network: 'net', protect: false, region: null },
  { key: 'fw-data', type: 'firewall', spec: { ingress: [{ protocol: 'tcp', ports: '5432', sources: ['10.40.2.0/24'] }] }, dependsOn: [], network: 'net', protect: false, region: null },
  { key: 'db', type: 'database', spec: { engine: 'postgres', version: '16', size: 'Standard_D2ds_v5', storageGb: 64, subnets: ['sub-data'], firewall: 'fw-data', publicAccess: false, privateEndpoint: true, backups: { days: 7 }, maintenanceWindow: { day: 'sun', hour: 3 }, extensions: EXT, deletionProtection: true, ...db }, dependsOn: ['sub-data', 'fw-data'], network: 'net', protect: true, region: null }
];

describe('managed databases through the engine (B-10301, B-10307)', () => {
  let w: World;
  let depId = '';
  let serverId = '';
  beforeAll(async () => {
    w = await world();
  });
  afterAll(async () => {
    await w.az.stop();
    await w.dof.stop();
    await w.h.close();
  });

  it('a schedule needs migration 153; nothing else does', async () => {
    // 153 is registered (2026-10-20), so the harness has it: roll it back to see the service without it.
    if (await w.h.s.db.schema.hasTable('cloud_db_snapshot_schedules')) await (await import('../src/db/migrations/153_cloud_databases.js')).down(w.h.s.db);
    w.h.s.cloud.databases.resetSchemaCache();
    const d = await w.h.s.cloud.deployments.create(w.alice, { name: 'no-schedules', accountId: w.azure.id });
    const r = await send(w.alice, 'put', `${D}/${d.id}/databases/db/schedule`, { everyHours: 6, keep: 2 });
    expect(r.status).toBe(503);
    expect(r.body.reason).toBe('migration_pending');
    expect((await send(w.alice, 'get', `${D}/${d.id}/databases`)).body).toEqual({ databases: [] });
    if (!(await w.h.s.db.schema.hasTable('cloud_db_snapshot_schedules'))) await (await import('../src/db/migrations/153_cloud_databases.js')).up(w.h.s.db);
    w.h.s.cloud.databases.resetSchemaCache();
  });

  it('provisioning on Azure enables the extensions through the allow-list step, and the check reports them available', async () => {
    const d = await w.h.s.cloud.deployments.create(w.alice, { name: 'pg-lab', accountId: w.azure.id });
    depId = d.id;
    // A missing extension stops the plan with its name, before anything is created.
    const refused = await w.h.s.cloud.plans.create(w.alice, d.id, azGraph({ extensions: ['vector', 'plv8'] }));
    expect(refused.applicable).toBe(false);
    expect(refused.blockers).toContain('db (database): extension plv8 is not offered by azure PostgreSQL 16.');
    const plan = await w.h.s.cloud.plans.create(w.alice, d.id, azGraph());
    expect(plan.blockers).toEqual([]);
    expect(plan.steps.find((s) => s.key === 'db')).toMatchObject({ action: 'create', type: 'database' });
    await w.h.s.cloud.plans.apply(w.alice, plan.id, plan.hash);
    await drain(w);
    expect((await w.h.s.cloud.plans.load(plan.id))!.state).toBe('applied');
    const row = (await w.h.s.cloud.deployments.resource(d.id, 'db'))!;
    serverId = row.providerId!;
    expect(row).toMatchObject({ state: 'ready', observed: { props: { deletionProtection: true, publicAccess: false, privateEndpoint: true } } });
    expect(w.az.db.availableExtensions(serverId, (k) => w.az.resources.get(k))).toEqual(EXT);
    const ext = await send(w.alice, 'get', `${D}/${d.id}/databases/db/extensions`);
    expect(ext.status).toBe(200);
    expect(ext.body).toEqual({ key: 'db', engine: 'postgres', allAvailable: true, extensions: EXT.map((name) => ({ name, state: 'available', source: 'allow_list' })) });
    const list = await send(w.alice, 'get', `${D}/${d.id}/databases`);
    expect(list.body.databases).toEqual([expect.objectContaining({ key: 'db', engine: 'postgres', version: '16', size: 'Standard_D2ds_v5', storageGb: 64, deletionProtection: true, publicAccess: false, privateEndpoint: true, maintenanceWindow: { day: 'sun', hour: 3 }, backups: { days: 7, window: null }, extensions: EXT, schedule: null })]);
  });

  it('takes snapshots on a schedule, keeps what the schedule keeps, lists them with their cost and retention', async () => {
    const put = await send(w.alice, 'put', `${D}/${depId}/databases/db/schedule`, { everyHours: 6, keep: 1 });
    expect(put.status).toBe(200);
    expect(put.body.schedule).toMatchObject({ everyHours: 6, keep: 1, enabled: true });
    const backups = () => [...w.az.resources.keys()].filter((k) => k.startsWith(`${serverId.toLowerCase()}/backups/`) && !k.includes('/backups/backup_'));
    await w.h.s.db('cloud_db_snapshot_schedules').update({ next_at: 0 });
    expect(await w.h.s.cloud.databases.tick(w.h.tenantId)).toEqual({ queued: 1 });
    await drain(w);
    expect(backups()).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 1100));
    await w.h.s.db('cloud_db_snapshot_schedules').update({ next_at: 0 });
    expect(await w.h.s.cloud.databases.tick(w.h.tenantId, Date.now() + 120_000)).toEqual({ queued: 1 });
    await drain(w);
    // The second run kept one: the older scheduled backup was deleted.
    expect(backups()).toHaveLength(1);
    expect(await w.h.s.db('audit_events').where({ action: 'cloud.database.snapshot.pruned' }).first()).toBeTruthy();
    const sched = (await w.h.s.db('cloud_db_snapshot_schedules').first()) as { last_snapshot: string; last_error: string | null };
    expect(sched).toMatchObject({ last_error: null, last_snapshot: expect.stringContaining('/backups/pg-lab-db-sched-') });
    // On demand too.
    const now = await send(w.alice, 'post', `${D}/${depId}/databases/db/snapshots`, { note: 'before the import' });
    expect(now.status).toBe(202);
    await drain(w);
    const listed = await send(w.alice, 'get', `${D}/${depId}/databases/db/snapshots`);
    expect(listed.status).toBe(200);
    const sn = listed.body.snapshots as { kind: string; name: string; cost: { sku: string; monthly: number | null; unverified: boolean } | null; retention: string }[];
    expect(sn.filter((x) => x.kind === 'manual').map((x) => x.name)).toEqual([expect.stringMatching(/^pg-lab-db-manual-/), expect.stringMatching(/^pg-lab-db-sched-/)]);
    expect(sn.find((x) => x.kind === 'manual')!.cost).toMatchObject({ sku: 'postgres:backup', unit: 'gb-month', monthly: 6.08, unverified: true });
    expect(sn.find((x) => x.kind === 'automated')).toMatchObject({ cost: { monthly: 0, unit: 'included' }, retention: expect.stringMatching(/^Deleted by the provider in 7 days/) });
    // An unconfirmed price is shown but never totalled.
    expect(listed.body).toMatchObject({ currency: 'USD', monthly: 0 });
    for (const a of ['cloud.database.schedule.set', 'cloud.database.snapshot.requested', 'cloud.database.snapshot.taken']) expect(await w.h.s.db('audit_events').where({ action: a }).first()).toBeTruthy();
  });

  it('restores a snapshot to a new instance, which joins the graph protected', async () => {
    const listed = await send(w.alice, 'get', `${D}/${depId}/databases/db/snapshots`);
    const backup = (listed.body.snapshots as { id: string; kind: string }[]).find((x) => x.kind === 'manual')!;
    const r = await send(w.alice, 'post', `${D}/${depId}/databases/db/snapshots/${encodeURIComponent(backup.id)}/restore`, {});
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ key: 'db-restored', job: { type: 'cloud.db.restore' } });
    await drain(w);
    const row = (await w.h.s.cloud.deployments.resource(depId, 'db-restored'))!;
    expect(row).toMatchObject({ protect: true, desired: { spec: { restoreFrom: backup.id, deletionProtection: true } } });
    const srv = w.az.resources.get(row.providerId!.toLowerCase())!;
    expect(srv.body).toMatchObject({ properties: { createMode: 'PointInTimeRestore', sourceServerResourceId: serverId, network: { publicNetworkAccess: 'Disabled' } } });
    expect([...w.az.db.locks.values()].some((l) => l.scope === row.providerId!.toLowerCase())).toBe(true);
    expect(w.az.db.availableExtensions(row.providerId!, (k) => w.az.resources.get(k))).toEqual(EXT);
    expect(await w.h.s.db('audit_events').where({ action: 'cloud.database.restored' }).first()).toBeTruthy();
  });

  it('no route deletes a protected database: a plan’s delete, replace or protection change is blocked; the adapter refuses too', async () => {
    const graph = await w.h.s.cloud.deployments.desiredGraph(depId);
    const without = graph.filter((r) => r.key !== 'db');
    const del = await w.h.s.cloud.plans.create(w.alice, depId, without);
    expect(del.steps.find((s) => s.key === 'db')).toMatchObject({ action: 'delete', blocked: expect.stringMatching(/protected/) });
    expect(del.applicable).toBe(false);
    const applied = await send(w.alice, 'post', `${D}/${depId}/plans/${del.id}/apply`, { hash: del.hash });
    expect(applied.status).toBe(409);
    expect(applied.body).toMatchObject({ reason: 'plan_unavailable', blockers: expect.arrayContaining([expect.stringMatching(/^db: /)]) });
    // Even a database whose graph flag says unprotected: its own deletion protection holds.
    await w.h.s.db('cloud_resources').where({ deployment_id: depId, key: 'db-restored' }).update({ protect: false });
    const unflagged = await w.h.s.cloud.plans.create(w.alice, depId, graph.filter((r) => r.key !== 'db-restored'));
    expect(unflagged.steps.find((s) => s.key === 'db-restored')).toMatchObject({ action: 'delete', blocked: expect.stringMatching(/deletion protection/) });
    await w.h.s.db('cloud_resources').where({ deployment_id: depId, key: 'db-restored' }).update({ protect: true });
    const replace = await w.h.s.cloud.plans.create(w.alice, depId, graph.map((r) => (r.key === 'db' ? { ...r, spec: { ...r.spec, version: '17' } } : r)));
    expect(replace.steps.find((s) => s.key === 'db')).toMatchObject({ action: 'replace', blocked: expect.any(String) });
    const off = await w.h.s.cloud.plans.create(w.alice, depId, graph.map((r) => (r.key === 'db' ? { ...r, spec: { ...r.spec, deletionProtection: false } } : r)));
    expect(off.steps.find((s) => s.key === 'db')).toMatchObject({ blocked: expect.stringMatching(/not turned off by a plan/) });
    expect(off.applicable).toBe(false);
    // The adapter itself, called directly: refused without the final snapshot.
    const d = (await w.h.s.cloud.deployments.get(depId))!;
    const c = await w.h.s.cloud.deployments.context(d, 'deploy');
    await expect(c.provider.delete(c.ctx('westeurope'), { type: 'database', providerId: serverId })).rejects.toMatchObject({ code: 'final_snapshot_required' });
    expect(w.az.resources.has(serverId.toLowerCase())).toBe(true);
  });

  it('drift’s revert does not delete an unmanaged protected database either', async () => {
    const d = await w.h.s.cloud.deployments.create(w.alice, { name: 'do-lab', accountId: w.digitalocean.id });
    const graph: DesiredResource[] = [
      { key: 'net', type: 'network', spec: { cidr: '10.50.0.0/20' }, dependsOn: [], protect: false, region: null },
      { key: 'fw-data', type: 'firewall', spec: { ingress: [{ protocol: 'tcp', ports: '25060', sources: ['10.50.4.0/24'] }] }, dependsOn: [], protect: false, region: null }
    ];
    const plan = await w.h.s.cloud.plans.create(w.alice, d.id, graph);
    await w.h.s.cloud.plans.apply(w.alice, plan.id, plan.hash);
    await drain(w);
    const vpc = (await w.h.s.cloud.deployments.resource(d.id, 'net'))!.providerId!;
    // A database made by hand in the deployment's VPC, with deletion protection (as Exprsn-AI makes them).
    const c = await w.h.s.cloud.deployments.context((await w.h.s.cloud.deployments.get(d.id))!, 'deploy');
    const made = await c.provider.create(c.ctx('fra1'), { type: 'database', name: 'stray', idempotencyKey: 's', tags: cloudTags({ account: w.digitalocean.name }), region: 'fra1', parent: { networkId: vpc }, props: { engine: 'postgres', size: 'db-s-1vcpu-2gb', publicAccess: false } as DatabaseProps });
    await settle(c.provider, c.ctx('fra1'), made);
    const found = await w.h.s.cloud.lifecycle.drift.detect((await w.h.s.cloud.deployments.get(d.id))!);
    const f = found.open.find((x) => x.kind === 'unmanaged' && x.type === 'database')!;
    expect(f).toBeTruthy();
    const r = await send(w.alice, 'post', `${D}/${d.id}/drift/${f.id}/decide`, { decision: 'revert', apply: true });
    expect(r.status).toBe(409);
    expect(r.body.detail).toMatch(/cannot be applied: .*deletion protection/);
    expect([...w.dof.dbs.clusters.values()].some((x) => x.name === 'exprsn-do-data-stray')).toBe(true);
  });

  it('destroy takes the final snapshot of each protected database after a second admin approves, then deletes it', async () => {
    const asked = await send(w.alice, 'post', `${D}/${depId}/destroy`, { reason: 'decommissioned' });
    expect(asked.status).toBe(202);
    expect(asked.body.destroy.protected.map((p: { key: string; snapshot: { state: string } }) => [p.key, p.snapshot.state]).sort()).toEqual([
      ['db', 'none'],
      ['db-restored', 'none']
    ]);
    await drain(w);
    const destroyId = asked.body.destroy.id as string;
    expect((await w.h.s.cloud.lifecycle.destroys.get(destroyId))!.state).toBe('waiting');
    expect(w.az.resources.has(serverId.toLowerCase())).toBe(true);
    for (const key of ['db', 'db-restored']) {
      const ok = await send(w.bob, 'post', `${D}/${depId}/destroy/${destroyId}/protected/${key}/approve`, { note: 'final snapshot first' });
      expect(ok.status).toBe(200);
    }
    await drain(w);
    const x = (await w.h.s.cloud.lifecycle.destroys.get(destroyId))!;
    expect(x.state).toBe('finished');
    expect(x.protected.every((p) => p.deleted && p.snapshot.state === 'taken')).toBe(true);
    // Each final snapshot is a retained copy that outlives its server.
    expect(w.az.resources.has(serverId.toLowerCase())).toBe(false);
    for (const p of x.protected) {
      const copy = w.az.resources.get(p.snapshot.id!.toLowerCase())!;
      expect(copy.tags).toMatchObject({ 'exprsn:purpose': 'final' });
    }
    expect(w.az.db.locks.size).toBe(0);
    const actions = (await w.h.s.db('audit_events').whereLike('action', 'cloud.destroy.%').orderBy('seq')).map((e: { action: string }) => e.action);
    expect(actions.filter((a: string) => a === 'cloud.destroy.snapshot')).toHaveLength(2);
  });
});
