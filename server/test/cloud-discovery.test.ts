/*
 * 1.9.99-final, Sprint 59 (B-10306): managed databases and stores of a cloud account as data connections
 * (`cloud/discovery.ts`). Against the in-process fakes only (AWS RDS, DocumentDB and DynamoDB; Azure ARM and the
 * Cosmos DB data plane; DigitalOcean databases): discovery per provider, connect changing the private endpoint and the
 * tenant's allowed hosts together, the admin password in the vault, per-connection users from a lease engine that are
 * dropped when their lease ends, RDS IAM and Entra tokens bought through `s.cloud.credentials`, the accounts' own
 * credentials for DynamoDB and Cosmos DB, and the permissions. The account credentials are stand-ins (the
 * credentials suite covers federation and vaulted keys); the SQL drivers are recorders, so no database is dialled.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rdsIamToken } from '../src/cloud/discovery.js';
import type { ConnectionSpec, DataDriver } from '../src/connections/drivers.js';
import { LEASE_USER, type DbAdmin, type EngineTarget } from '../src/vault/db-engines.js';
import type { CloudAccount } from '../src/cloud/types.js';
import { seedAccount } from './cloud-credentials-helpers.js';
import { FakeAws } from './fake-aws.js';
import { FakeAzure } from './fake-azure.js';
import { FakeDigitalOcean } from './fake-do.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

const CA = '-----BEGIN CERTIFICATE-----\nMIIBdigitaloceanTestCA\n-----END CERTIFICATE-----\n';

/** Records every spec a SQL connection is opened with; answers like a small database. */
class SpecDriver implements DataDriver {
  static specs: ConnectionSpec[] = [];
  constructor(spec: ConnectionSpec) {
    SpecDriver.specs.push(spec);
  }
  async test() {
    return { version: 'PostgreSQL 17', readOnly: true, detail: 'ok', health: 'healthy' as const };
  }
  async introspect() {
    return [{ name: 'public.orders', kind: 'table' as const, columns: [{ name: 'id', type: 'int' }, { name: 'email', type: 'text' }] }];
  }
  async query() {
    return { columns: ['id', 'email'], rows: [[1, 'ana@example.org']], capped: false, estimate: null };
  }
  async rows() {
    return { columns: ['id'], rows: [[1]], capped: false, estimate: null };
  }
}

/** The lease engines' admin sessions: who was created and dropped. */
class FakeAdmins {
  users = new Map<string, { password: string; target: EngineTarget }>();
  dropped: string[] = [];
  targets: EngineTarget[] = [];
  admins = (t: EngineTarget): DbAdmin => {
    this.targets.push(t);
    return {
      test: async () => ({ version: 'PostgreSQL 17', canCreate: true, detail: 'can create roles' }),
      createUser: async (u, pw) => {
        if (!LEASE_USER.test(u)) throw new Error('bad user');
        this.users.set(u, { password: pw, target: t });
      },
      extend: async () => undefined,
      dropUser: async (u) => {
        this.users.delete(u);
        this.dropped.push(u);
      },
      exists: async (u) => this.users.has(u)
    };
  };
}

const send = (c: Client, method: 'post' | 'put' | 'delete', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);

describe('B-10306: discover and connect', () => {
  let h: Harness;
  let aws: FakeAws;
  let az: FakeAzure;
  let dio: FakeDigitalOcean;
  let fakes: FakeAdmins;
  let admin: Client;
  let adminId: string;
  let awsAcct: CloudAccount;
  let azAcct: CloudAccount;
  let doAcct: CloudAccount;
  let awsKey: { accessKeyId: string; secretAccessKey: string };
  const tenant = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const sub = '0b1c2d3e-0000-1111-2222-333344445555';
  const scopes: string[] = [];

  beforeAll(async () => {
    aws = await new FakeAws().start();
    az = await new FakeAzure().start();
    dio = await new FakeDigitalOcean().start();
    fakes = new FakeAdmins();
    const sql = (spec: ConnectionSpec) => new SpecDriver(spec);
    h = await harness({ SERVICE_ALLOWED_HOSTS: '127.0.0.1', OLLAMA_POLL_MS: '600000' }, { dbAdmins: fakes.admins, drivers: { postgres: sql, mysql: sql } });
    if (!(await h.s.db.schema.hasTable('cloud_discovered'))) await (await import('../src/db/migrations/156_cloud_connections.js')).up(h.s.db);
    h.s.cloud.discovery.resetSchemaCache();
    h.s.cloud.discovery.setEndpoints({ aws: { rds: aws.url, dynamodb: aws.url }, azure: { arm: az.url }, digitalocean: { api: dio.url } });

    // AWS: an RDS PostgreSQL instance with IAM authentication, an Aurora cluster (and its member), DocumentDB, a table.
    awsKey = aws.addUser({ userName: 'exprsn-read' });
    const sess = aws.addUser({ userName: 'session' });
    aws.keys.get(sess.accessKeyId)!.sessionToken = 'aws-session-token';
    aws.data.dbInstances.push({ id: 'orders', engine: 'postgres', host: 'orders.c1.eu-central-1.rds.test.internal', port: 5432, dbName: 'shop', masterUser: 'master', iamAuth: true, tags: { 'exprsn:managed': 'true' } });
    aws.data.dbInstances.push({ id: 'ledger-1', engine: 'aurora-postgresql', host: 'ledger-1.test.internal', port: 5432, cluster: 'ledger' });
    aws.data.dbClusters.push({ id: 'ledger', engine: 'aurora-postgresql', writer: 'ledger.cluster.test.internal', reader: 'ledger.cluster-ro.test.internal', port: 5432, dbName: 'ledger', masterUser: 'master', iamAuth: true });
    aws.data.dbClusters.push({ id: 'catalog', engine: 'docdb', writer: 'catalog.docdb.test.internal', reader: 'catalog.ro.docdb.test.internal', port: 27017, masterUser: 'docadmin' });
    aws.data.addTable({ name: 'events', pk: 'device', items: [{ device: { S: 'd-1' }, reading: { N: '7' }, owner_email: { S: 'owner@example.org' } }] });

    // Azure: a PostgreSQL flexible server with Entra sign-in on a private network, a Cosmos DB account, a vCore cluster.
    az.addSubscription(sub, tenant);
    const tok = (name: string, scope: string) => (az.tokens.set(name, { tenantId: tenant, clientId: 'app', scope, exp: Date.now() + 3600_000 }), name);
    const armTok = tok('arm-token', 'https://management.azure.com');
    const cosmosTok = tok('cosmos-token', 'https://cosmos.azure.com');
    const pgTok = tok('pg-entra-token', 'https://ossrdbms-aad.database.windows.net');
    const rg = `/subscriptions/${sub}/resourceGroups/data`;
    const put = (id: string, type: string, body: Record<string, unknown>, extra: Record<string, unknown> = {}) => az.resources.set(id.toLowerCase(), { id, name: id.split('/').pop()!, type, location: 'westeurope', tags: {}, etag: 'e', body: { properties: body }, ...extra });
    put(`${rg}/providers/Microsoft.DBforPostgreSQL/flexibleServers/pgflex`, 'Microsoft.DBforPostgreSQL/flexibleServers', { fullyQualifiedDomainName: 'pgflex.postgres.test.internal', state: 'Ready', administratorLogin: 'pgadmin', network: { publicNetworkAccess: 'Disabled', delegatedSubnetResourceId: `${rg}/providers/Microsoft.Network/virtualNetworks/v/subnets/data` }, authConfig: { activeDirectoryAuth: 'Enabled', passwordAuth: 'Enabled' } });
    put(`${rg}/providers/Microsoft.DocumentDB/databaseAccounts/shopdocs`, 'Microsoft.DocumentDB/databaseAccounts', { documentEndpoint: `${az.url}/`, provisioningState: 'Succeeded', publicNetworkAccess: 'Enabled' }, { kind: 'GlobalDocumentDB' });
    az.resources.get(`${rg}/providers/Microsoft.DocumentDB/databaseAccounts/shopdocs`.toLowerCase())!.body.kind = 'GlobalDocumentDB';
    put(`${rg}/providers/Microsoft.DocumentDB/mongoClusters/vcore`, 'Microsoft.DocumentDB/mongoClusters', { connectionString: 'mongodb+srv://<user>:<password>@vcore.mongocluster.cosmos.azure.com/?tls=true', administrator: { userName: 'vadmin' }, clusterStatus: 'Ready', publicNetworkAccess: 'Enabled' });
    az.cosmos.addContainer('shop', 'orders', { partitionKey: 'customer', docs: [{ id: 'o-1', customer: 'c-1', email: 'ana@example.org' }] });

    // DigitalOcean: a PostgreSQL cluster with a private host; its API hands out the admin password and the CA.
    dio.tokens.set('do-token', null);
    dio.databases.push({ id: '9cc10173-e9ea-4176-9dbc-a4cee4c4ff30', name: 'app-pg', engine: 'pg', region: 'fra1', status: 'online', connection: { host: 'app-pg.db.do.test.internal', port: 25060, user: 'doadmin', password: 'do-admin-password', database: 'defaultdb', ssl: true }, private_connection: { host: 'private-app-pg.db.do.test.internal', port: 25060, user: 'doadmin', password: 'do-admin-password', database: 'defaultdb', ssl: true } });
    dio.databaseCa.set('9cc10173-e9ea-4176-9dbc-a4cee4c4ff30', CA);

    awsAcct = await seedAccount(h, { provider: 'aws', mode: 'vaulted', name: 'aws-data', providerIds: { awsAccountId: '123456789012' } });
    azAcct = await seedAccount(h, { provider: 'azure', mode: 'vaulted', name: 'az-data', providerIds: { azureTenantId: tenant, azureSubscriptionId: sub }, params: { clientId: 'app' } });
    doAcct = await seedAccount(h, { provider: 'digitalocean', mode: 'vaulted', name: 'do-data', providerIds: { doTeamId: '5d1f0b5e-0000-4000-8000-000000000001' } });
    // The account credentials: stand-ins for `s.cloud.credentials` (the AWS one is a session, as a federated one is).
    h.s.cloud.credentials = {
      for: async (a: CloudAccount, purpose: string) => {
        expect(purpose).toBe('read');
        if (a.provider === 'aws') return { kind: 'aws', accessKeyId: sess.accessKeyId, secretAccessKey: sess.secretAccessKey, sessionToken: 'aws-session-token', expiresAt: Date.now() + 3600_000 };
        if (a.provider === 'azure') return { kind: 'azure', tenantId: tenant, getToken: async (scope: string) => (scopes.push(scope), { token: scope.startsWith('https://management') ? armTok : scope.startsWith('https://cosmos') ? cosmosTok : pgTok, expiresAt: Date.now() + 3600_000 }) };
        return { kind: 'token', token: 'do-token', accountId: '5d1f0b5e-0000-4000-8000-000000000001' };
      }
    };

    // A connection admin who reads cloud accounts, with vault write and read under connections/.
    adminId = (await localUser(h, 'dataops', ['connection-admin', 'cloud-operator', 'member'], 'confidential')).id;
    admin = await loginAdmin(h, 'dataops');
    const rootId = (await localUser(h, 'root', ['system-admin'], 'restricted')).id;
    const root = await loginAdmin(h, 'root');
    await send(root, 'post', '/api/vault/policies', { subjectKind: 'user', subject: adminId, path: 'kv/connections', capabilities: ['read', 'write', 'list'], effect: 'allow' }).expect(201);
    expect(rootId).toBeTruthy();
  });
  afterAll(async () => {
    await h.close();
    await aws.stop();
    await az.stop();
    await dio.stop();
  });

  it('discovers RDS, Aurora, DocumentDB and DynamoDB; flexible servers, Cosmos DB and vCore; DigitalOcean clusters', async () => {
    const a = (await admin.agent.get(`/api/admin/cloud/accounts/${awsAcct.id}/discover?refresh=1`).expect(200)).body;
    const byName = Object.fromEntries((a.instances as { name: string }[]).map((x) => [x.name, x])) as Record<string, Record<string, unknown>>;
    expect(Object.keys(byName).sort()).toEqual(['catalog', 'events', 'ledger', 'orders']);
    expect(byName.orders).toMatchObject({ kind: 'rds', engine: 'postgres', managed: true, endpoints: { private: { host: 'orders.c1.eu-central-1.rds.test.internal', port: 5432 }, public: null }, database: 'shop', auth: ['password', 'lease', 'rds-iam'] });
    expect(byName.ledger).toMatchObject({ kind: 'aurora', endpoints: { private: { host: 'ledger.cluster-ro.test.internal' } } });
    expect(byName.catalog).toMatchObject({ kind: 'documentdb', engine: 'documentdb', auth: ['password', 'lease'] });
    expect(byName.events).toMatchObject({ kind: 'dynamodb', engine: 'dynamodb', auth: ['account'] });
    // Signed through the adapter's transport with the account's session.
    expect(aws.calls('rds:DescribeDBInstances')[0]!.headers['x-amz-security-token']).toBe('aws-session-token');
    // Cached: a second read within ten minutes calls nothing.
    aws.reset();
    expect((await admin.agent.get(`/api/admin/cloud/accounts/${awsAcct.id}/discover`).expect(200)).body).toMatchObject({ cached: true });
    expect(aws.requests).toHaveLength(0);

    const z = (await admin.agent.get(`/api/admin/cloud/accounts/${azAcct.id}/discover?refresh=1`).expect(200)).body.instances as Record<string, unknown>[];
    expect(z.find((x) => x.name === 'pgflex')).toMatchObject({ kind: 'azure-postgres', engine: 'postgres', endpoints: { private: { host: 'pgflex.postgres.test.internal', port: 5432 }, public: null }, auth: ['password', 'lease', 'entra'] });
    expect(z.find((x) => x.name === 'shopdocs')).toMatchObject({ kind: 'cosmos-nosql', engine: 'cosmos-nosql', auth: ['account', 'key'] });
    expect(z.find((x) => x.name === 'vcore')).toMatchObject({ kind: 'cosmos-mongodb', endpoints: { public: { host: 'c.vcore.mongocluster.cosmos.azure.com', port: 10260 } } });

    const d = (await admin.agent.get(`/api/admin/cloud/accounts/${doAcct.id}/discover?refresh=1`).expect(200)).body.instances as Record<string, unknown>[];
    expect(d[0]).toMatchObject({ kind: 'do-database', engine: 'postgres', adminUser: 'doadmin', endpoints: { private: { host: 'private-app-pg.db.do.test.internal', port: 25060 } } });
    // The admin password DigitalOcean lists is never kept.
    expect(JSON.stringify(await h.s.db('cloud_discovered').select('instance'))).not.toContain('do-admin-password');
    expect(JSON.stringify(d)).not.toContain('do-admin-password');
    expect((await h.s.audit.list(h.tenantId, { action: 'cloud.discovery.run' })).length).toBeGreaterThanOrEqual(3);
  });

  it('connects a discovered RDS instance whose queries run as a leased user, dropped when the lease ends', async () => {
    const before = (await h.s.integrations.get(h.tenantId)).allowedHosts;
    const out = (await send(admin, 'post', `/api/admin/cloud/accounts/${awsAcct.id}/connect`, { providerId: 'arn:aws:rds:eu-central-1:123456789012:db:orders', name: 'orders', auth: 'lease', adminPassword: 'master-password-1', caPem: CA }).expect(201)).body;
    expect(out.connection).toMatchObject({ name: 'orders', engine: 'postgres', endpoint: 'orders.c1.eu-central-1.rds.test.internal:5432', database: 'shop', tls: true, hasCredential: false });
    expect(out.link).toMatchObject({ endpoint: 'private', host: 'orders.c1.eu-central-1.rds.test.internal', auth: 'lease', leaseEngine: 'cloud-orders', leaseRole: 'conn', caBundle: true });
    // The private endpoint and the allowed hosts changed together.
    expect((await h.s.integrations.get(h.tenantId)).allowedHosts).toEqual([...before, 'orders.c1.eu-central-1.rds.test.internal']);
    // The admin password is in the vault, and the lease engine logs in with it.
    const secret = await h.s.db('vault_secrets').where({ tenant_id: h.tenantId, path: 'connections/cloud/orders/admin' }).first();
    expect(secret).toBeTruthy();
    expect(JSON.stringify(await h.s.db('cloud_connection_links').first())).not.toContain('master-password-1');
    expect(JSON.stringify(await h.s.db('data_connections').where({ name: 'orders' }).first())).not.toContain('master-password-1');

    SpecDriver.specs = [];
    await send(admin, 'post', `/api/admin/connections/${out.connection.id}/schema`).expect(200);
    await send(admin, 'put', `/api/admin/connections/${out.connection.id}/allow-list`, { objects: ['public.orders'], piiColumns: [] }).expect(200);
    const r = (await send(admin, 'post', `/api/admin/connections/${out.connection.id}/query`, { query: 'SELECT id, email FROM orders' }).expect(200)).body;
    expect(r.masked).toEqual(['email']);
    const first = SpecDriver.specs.at(-1)!;
    expect(first.username).toMatch(/^exai_conn_[0-9a-f]{12}$/);
    expect(first).toMatchObject({ ca: CA.trim(), tls: true });
    expect(fakes.users.get(first.username!)).toMatchObject({ password: first.password, target: { adminUsername: 'master', adminPassword: 'master-password-1', endpoint: 'orders.c1.eu-central-1.rds.test.internal:5432' } });
    expect(SpecDriver.specs.every((s) => s.username === first.username)).toBe(true);

    // The lease ends: the sweeper drops the user, and the next query takes a fresh one.
    await h.s.db('vault_db_leases').where({ username: first.username }).update({ expires_at: Date.now() - 1000 });
    expect(await h.s.dbLeases.sweep(h.tenantId)).toEqual({ ended: 1, failed: 0 });
    expect(fakes.users.has(first.username!)).toBe(false);
    expect(fakes.dropped).toContain(first.username);
    const held = h.s.cloud.discovery.heldLease(out.connection.id)!;
    (h.s.cloud.discovery as unknown as { leases: Map<string, { expiresAt: number }> }).leases.get(out.connection.id)!.expiresAt = Date.now() - 1;
    await send(admin, 'post', `/api/admin/connections/${out.connection.id}/query`, { query: 'SELECT id FROM orders' }).expect(200);
    const second = SpecDriver.specs.at(-1)!;
    expect(second.username).not.toBe(first.username);
    expect(fakes.users.has(second.username!)).toBe(true);
    expect(held.username).toBe(first.username);
    expect(await h.s.audit.list(h.tenantId, { action: 'vault.database.lease.issued' })).toHaveLength(2);
    expect(await h.s.audit.list(h.tenantId, { action: 'cloud.connection.connected' })).toHaveLength(1);

    // Removing the connection ends its lease and its link.
    await send(admin, 'delete', `/api/admin/connections/${out.connection.id}`).expect(204);
    expect(fakes.users.has(second.username!)).toBe(false);
    expect(await h.s.db('cloud_connection_links').where({ connection_id: out.connection.id }).first()).toBeUndefined();
  });

  it('signs in with RDS IAM and Entra tokens bought through the account credential', async () => {
    const iam = (await send(admin, 'post', `/api/admin/cloud/accounts/${awsAcct.id}/connect`, { providerId: 'ledger', name: 'ledger', auth: 'rds-iam', dbUser: 'app_reader' }).expect(201)).body;
    expect(iam.link).toMatchObject({ auth: 'rds-iam', dbUser: 'app_reader', host: 'ledger.cluster-ro.test.internal' });
    expect(iam.notes.join(' ')).toMatch(/CA bundle/);
    SpecDriver.specs = [];
    await send(admin, 'post', `/api/admin/connections/${iam.connection.id}/test`).expect(200);
    const s1 = SpecDriver.specs.at(-1)!;
    expect(s1.username).toBe('app_reader');
    expect(s1.password).toMatch(/^ledger\.cluster-ro\.test\.internal:5432\/\?Action=connect&DBUser=app_reader&X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=[A-Z0-9]+%2F\d{8}%2Feu-central-1%2Frds-db%2Faws4_request&X-Amz-Date=\d{8}T\d{6}Z&X-Amz-Expires=900&X-Amz-Security-Token=aws-session-token&X-Amz-SignedHeaders=host&X-Amz-Signature=[0-9a-f]{64}$/);
    expect(rdsIamToken({ host: 'h', port: 5432, user: 'u', region: 'eu-west-1', keys: awsKey, now: new Date('2026-10-20T10:00:00Z') })).toBe(rdsIamToken({ host: 'h', port: 5432, user: 'u', region: 'eu-west-1', keys: awsKey, now: new Date('2026-10-20T10:00:00Z') }));
    // An instance without IAM authentication refuses the option.
    expect((await send(admin, 'post', `/api/admin/cloud/accounts/${awsAcct.id}/connect`, { providerId: 'catalog', name: 'cat-iam', auth: 'rds-iam', dbUser: 'x' }).expect(409)).body.detail).toMatch(/offers password, lease/);

    scopes.length = 0;
    const entra = (await send(admin, 'post', `/api/admin/cloud/accounts/${azAcct.id}/connect`, { providerId: 'pgflex', name: 'pgflex', auth: 'entra', dbUser: 'exprsn-reader-app' }).expect(201)).body;
    expect(entra.connection).toMatchObject({ endpoint: 'pgflex.postgres.test.internal:5432', database: 'postgres' });
    await send(admin, 'post', `/api/admin/connections/${entra.connection.id}/test`).expect(200);
    expect(SpecDriver.specs.at(-1)).toMatchObject({ username: 'exprsn-reader-app', password: 'pg-entra-token' });
    expect(scopes).toContain('https://ossrdbms-aad.database.windows.net/.default');
  });

  it('reads DynamoDB with the account\'s session and Cosmos DB with its token or read-only key', async () => {
    const dyn = (await send(admin, 'post', `/api/admin/cloud/accounts/${awsAcct.id}/connect`, { providerId: 'events', name: 'events', auth: 'account', endpoint: 'public' }).expect(201)).body;
    expect(dyn.connection).toMatchObject({ engine: 'dynamodb', endpoint: aws.url, options: { region: 'eu-central-1' } });
    expect(dyn.notes.join(' ')).toMatch(/CONNECTIONS_ALLOWED_HOSTS/);
    await send(admin, 'post', `/api/admin/connections/${dyn.connection.id}/schema`).expect(200);
    await send(admin, 'put', `/api/admin/connections/${dyn.connection.id}/allow-list`, { objects: ['events'], piiColumns: [] }).expect(200);
    aws.reset();
    await send(admin, 'post', `/api/admin/connections/${dyn.connection.id}/query`, { query: 'UPDATE "events" SET reading = 0 WHERE device = \'d-1\'' }).expect(422);
    expect(aws.requests).toHaveLength(0);
    const r = (await send(admin, 'post', `/api/admin/connections/${dyn.connection.id}/query`, { query: 'SELECT * FROM "events" WHERE "device" = \'d-1\'' }).expect(200)).body;
    expect(r.masked).toEqual(['owner_email']);
    expect(aws.calls('dynamodb:ExecuteStatement')[0]!.headers['x-amz-security-token']).toBe('aws-session-token');

    const viaToken = (await send(admin, 'post', `/api/admin/cloud/accounts/${azAcct.id}/connect`, { providerId: 'shopdocs', name: 'shopdocs', auth: 'account', endpoint: 'public', database: 'shop' }).expect(201)).body;
    await send(admin, 'post', `/api/admin/connections/${viaToken.connection.id}/test`).expect(200);
    expect(az.cosmos.auths.at(-1)).toBe('aad');
    const viaKey = (await send(admin, 'post', `/api/admin/cloud/accounts/${azAcct.id}/connect`, { providerId: 'shopdocs', name: 'shopdocs-key', auth: 'key', endpoint: 'public', database: 'shop' }).expect(201)).body;
    expect(viaKey.connection).toMatchObject({ passwordFromVault: true, options: { auth: 'key' } });
    expect((await send(admin, 'post', `/api/admin/connections/${viaKey.connection.id}/test`).expect(200)).body).toMatchObject({ ok: true });
    expect(az.cosmos.auths.at(-1)).toBe('master-read');
    expect(az.calls(/readonlykeys/).length).toBe(1);
  });

  it('connects a DigitalOcean cluster with the admin password from its API in the vault and its CA', async () => {
    const out = (await send(admin, 'post', `/api/admin/cloud/accounts/${doAcct.id}/connect`, { providerId: '9cc10173-e9ea-4176-9dbc-a4cee4c4ff30', name: 'app-pg', auth: 'password' }).expect(201)).body;
    expect(out.connection).toMatchObject({ endpoint: 'private-app-pg.db.do.test.internal:25060', database: 'defaultdb', account: 'doadmin', passwordFromVault: true });
    expect(out.link).toMatchObject({ caBundle: true, host: 'private-app-pg.db.do.test.internal' });
    await send(admin, 'post', `/api/admin/connections/${out.connection.id}/test`).expect(200);
    expect(SpecDriver.specs.at(-1)).toMatchObject({ username: 'doadmin', password: 'do-admin-password', ca: CA });
    expect(JSON.stringify(await h.s.db('data_connections').where({ id: out.connection.id }).first())).not.toContain('do-admin-password');
    const links = (await admin.agent.get(`/api/admin/cloud/accounts/${doAcct.id}/connections`).expect(200)).body.links;
    expect(links).toHaveLength(1);
  });

  it('connects a database a deployment provisioned, by its resource key', async () => {
    const { ulid } = await import('ulid');
    const dep = ulid();
    const now = Date.now();
    await h.s.db('cloud_deployments').insert({ id: dep, tenant_id: h.tenantId, scope: 'platform', account_id: awsAcct.id, provider: 'aws', name: 'prod', region: 'eu-central-1', label: 'internal', state: 'ready', health: 'healthy', observed_version: 1, created_at: now, updated_at: now });
    await h.s.db('cloud_resources').insert({ id: ulid(), deployment_id: dep, key: 'db', type: 'database', region: 'eu-central-1', provider_id: 'instance:orders', desired: JSON.stringify({ key: 'db', type: 'database', spec: {} }), depends_on: '[]', protect: true, tags: '{}', state: 'ready', created_at: now, updated_at: now });
    const found = (await admin.agent.get(`/api/admin/cloud/accounts/${awsAcct.id}/discover?refresh=1`).expect(200)).body.instances as { name: string; deployment: unknown }[];
    expect(found.find((x) => x.name === 'orders')!.deployment).toEqual({ id: dep, key: 'db' });
    const out = (await send(admin, 'post', `/api/admin/cloud/accounts/${awsAcct.id}/connect`, { deploymentId: dep, resourceKey: 'db', name: 'prod-db', auth: 'rds-iam', dbUser: 'reporting' }).expect(201)).body;
    expect(out.link).toMatchObject({ deployment: { id: dep, key: 'db' }, providerId: 'arn:aws:rds:eu-central-1:123456789012:db:orders' });
    expect((await admin.agent.get(`/api/admin/cloud/accounts/${awsAcct.id}/discover`).expect(200)).body.instances.find((x: { name: string }) => x.name === 'orders').connections).toEqual([{ id: out.connection.id, name: 'prod-db' }]);
  });

  it('takes the allowed host out again when the connection cannot be made', async () => {
    const before = (await h.s.integrations.get(h.tenantId)).allowedHosts;
    const create = h.s.connections.create.bind(h.s.connections);
    h.s.connections.create = async () => {
      throw new Error('database unavailable');
    };
    try {
      await send(admin, 'post', `/api/admin/cloud/accounts/${awsAcct.id}/connect`, { providerId: 'catalog', name: 'catalog', auth: 'password', adminPassword: 'docpw', database: 'catalog' }).expect(500);
    } finally {
      h.s.connections.create = create;
    }
    expect((await h.s.integrations.get(h.tenantId)).allowedHosts).toEqual(before);
  });

  it('needs cloud:read and connections:manage, and an account the caller may see', async () => {
    await localUser(h, 'ops-only', ['cloud-operator'], 'internal');
    const ops = await login(h, 'ops-only');
    await ops.agent.get(`/api/admin/cloud/accounts/${awsAcct.id}/discover`).expect(403);
    await localUser(h, 'conn-only', ['connection-admin'], 'internal');
    const conn = await loginAdmin(h, 'conn-only');
    await conn.agent.get(`/api/admin/cloud/accounts/${awsAcct.id}/discover`).expect(403);
    await send(conn, 'post', `/api/admin/cloud/accounts/${awsAcct.id}/connect`, { providerId: 'orders', name: 'x', auth: 'password' }).expect(403);
    await admin.agent.get('/api/admin/cloud/accounts/01J0000000000000000000000Z/discover').expect(404);
    await send(admin, 'post', `/api/admin/cloud/accounts/${awsAcct.id}/connect`, { name: 'neither', auth: 'password' }).expect(400);
  });

  it('answers 503 for connect, and discovers without a cache, while migration 156 is missing', async () => {
    await (await import('../src/db/migrations/156_cloud_connections.js')).down(h.s.db);
    h.s.cloud.discovery.resetSchemaCache();
    try {
      expect((await send(admin, 'post', `/api/admin/cloud/accounts/${awsAcct.id}/connect`, { providerId: 'orders', name: 'later', auth: 'password', adminPassword: 'x' }).expect(503)).body).toMatchObject({ reason: 'migration_pending' });
      expect((await admin.agent.get(`/api/admin/cloud/accounts/${awsAcct.id}/discover`).expect(200)).body).toMatchObject({ cached: false });
      // Connections made before keep working without their links (here: none are left to read).
      expect(await h.s.cloud.discovery.links(h.tenantId)).toEqual([]);
    } finally {
      await (await import('../src/db/migrations/156_cloud_connections.js')).up(h.s.db);
      h.s.cloud.discovery.resetSchemaCache();
    }
  });
});
