import { createHash, createHmac } from 'node:crypto';
import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { clears, LABELS, type Label } from '../authz/labels.js';
import { connectionView, type CloudConnectionAuth, type CloudConnectionHooks, type ConnectionRow } from '../connections/service.js';
import type { Engine } from '../connections/engines.js';
import { json } from '../db/knex.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { namedHost, parseAllowList } from '../mcp/hosts.js';
import { signV4 } from '../platform/blob.js';
import type { Services } from '../services.js';
import { isVaultRef } from '../vault/policy.js';
import type { CloudActor } from './accounts.js';
import { AZURE_SCOPES } from './azure-calls.js';
import { xmlAll, xmlText } from './credential-http.js';
import type { ProviderCredential } from './credentials.js';
import type { CloudTransport } from './providers/transport.js';
import type { CloudProvider, ObservedResource } from './providers/types.js';
import type { CloudAccount, Provider } from './types.js';

/*
 * 1.9.99-final, Sprint 59 (B-10306): managed databases and stores as data connections, `s.cloud.discovery`.
 *
 * Discover (`GET /api/admin/cloud/accounts/:id/discover`) lists what the account holds, per region on its allow-list,
 * through the adapters' transports (so every call has the egress guard, the shared rate limiter and the breaker):
 *
 *   AWS           RDS DescribeDBInstances and DescribeDBClusters (RDS PostgreSQL and MySQL, Aurora, DocumentDB:
 *                 engine `docdb`), DynamoDB ListTables and DescribeTable
 *   Azure         ARM flexible servers (PostgreSQL, MySQL), Cosmos DB accounts (NoSQL; MongoDB RU accounts), MongoDB
 *                 vCore clusters (`mongoClusters`)
 *   DigitalOcean  `/v2/databases` (PostgreSQL, MySQL, MongoDB; Valkey and Kafka are listed without an engine)
 *
 * The managed databases the deployment engine made (the `database` type, `cloud/databases.ts`) are found the same
 * way; where the adapter lists them, their deployment and resource key are put beside them. Each instance names the
 * connection engine it maps to, its private and public endpoints, and the ways a connection may authenticate. The
 * last discovery of an account is kept in `cloud_discovered` (migration 156), never with a secret in it.
 *
 * Connect (`POST /api/admin/cloud/accounts/:id/connect`) makes a data connection to one instance, discovered or
 * provisioned (`deploymentId` and `resourceKey`): the chosen endpoint (the private one by default) and the tenant's
 * allowed hosts change together (the host is added, and taken out again if the connection cannot be made), and the
 * connection authenticates in one of these ways:
 *
 *   password  the admin password, given once (or by DigitalOcean's API) and written to the tenant vault; the
 *             connection holds its `vault:` reference, read at every use as the admin who saved it
 *   lease     per-connection users through the B-1704 lease engines: the admin password goes to the vault, an engine
 *             `cloud-<connection>` and a read role `conn` are registered, and every use takes (and renews) a leased
 *             user the engine creates; when the lease ends the sweeper drops the user
 *   rds-iam   RDS IAM authentication: a 15-minute token presigned at each use with the account's credential
 *             (`s.cloud.credentials`, purpose `read`), for the database user given
 *   entra     Microsoft Entra authentication to Azure Database for PostgreSQL: a token for the OSS RDBMS scope from
 *             the account's credential, for the Entra principal's database role
 *   account   DynamoDB with the account's own session, Cosmos DB for NoSQL with its Entra token (Data Reader role)
 *   key       Cosmos DB for NoSQL with the account's read-only key (listReadOnlyKeys), written to the vault
 *
 * The link (`cloud_connection_links`) carries what each use needs; `ConnectionService.cloud` asks `auth` for it, so a
 * connection without a link (every connection made before this) behaves exactly as before. The service's CA bundle
 * (fetched from DigitalOcean, or given: the Amazon RDS bundle) is kept on the link, public certificates only.
 */

export const DISCOVERED_KINDS = ['rds', 'aurora', 'documentdb', 'dynamodb', 'azure-postgres', 'azure-mysql', 'cosmos-nosql', 'cosmos-mongodb', 'do-database'] as const;
export type DiscoveredKind = (typeof DISCOVERED_KINDS)[number];
export const AUTH_MODES = ['password', 'lease', 'rds-iam', 'entra', 'account', 'key'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export interface Endpoint {
  host: string;
  port: number;
}

/** One managed database or store an account holds, as discovery normalises it. Never a secret. */
export interface DiscoveredInstance {
  providerId: string;
  provider: Provider;
  kind: DiscoveredKind;
  name: string;
  region: string | null;
  /** The provider's engine (`postgres`, `aurora-postgresql`, `docdb`, `pg`, `mongodb`, `GlobalDocumentDB`...). */
  providerEngine: string;
  /** The data connection engine that reads it, or null when this build has none for it (a cache, Kafka). */
  engine: Engine | null;
  state: string;
  endpoints: { private: Endpoint | null; public: Endpoint | null };
  database: string | null;
  adminUser: string | null;
  tls: boolean;
  /** How a connection to it may authenticate. */
  auth: AuthMode[];
  /** Carries this installation's `exprsn:managed` tag (made by a deployment). */
  managed: boolean;
  /** The deployment and resource key, when a deployment's graph has it. */
  deployment: { id: string; key: string } | null;
  /** The tenant's connections already made to it. */
  connections?: { id: string; name: string }[];
}

export interface DiscoveryEndpoints {
  aws?: { rds?: string; dynamodb?: string };
  azure?: { arm?: string };
  digitalocean?: { api?: string };
}

const SCHEMA_RECHECK_MS = 30_000;
const SERVICE = 'connections.cloud';
const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
const PEM_CERTS = /^(\s*-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----\s*)+$/;

export const connectSchema = z
  .object({
    /** The instance: a provider id from discovery, or a deployment's resource. */
    providerId: z.string().trim().min(1).max(500).optional(),
    deploymentId: id26.optional(),
    resourceKey: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).optional(),
    name: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lower-case letters, digits and dashes'),
    /** The database (or Cosmos DB database, DynamoDB: none); the instance's default when absent. */
    database: z.string().trim().min(1).max(200).nullable().optional(),
    endpoint: z.enum(['private', 'public']).default('private'),
    auth: z.enum(AUTH_MODES),
    /** rds-iam, entra: the database user (an IAM-enabled user, the Entra principal's role). password: the account. */
    dbUser: z.string().trim().regex(/^[A-Za-z0-9_.@/-]{1,128}$/).optional(),
    /** password, lease: the admin password, once (DigitalOcean's comes from its API), or a vault reference to it. */
    adminPassword: z.string().min(1).max(1024).optional(),
    adminPasswordRef: z.string().max(600).optional(),
    /** lease: the schemas (PostgreSQL) or databases (MySQL, MongoDB) the read role covers. */
    schemas: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/)).min(1).max(20).optional(),
    leaseTtlSeconds: z.number().int().min(60).max(86_400).default(3600),
    /** The CA bundle (PEM certificates only), for the Amazon RDS and DocumentDB endpoints. */
    caPem: z.string().max(400_000).regex(PEM_CERTS, 'PEM certificates only').optional(),
    zone: z.string().trim().regex(/^[a-z0-9-]{1,63}$/).default('data'),
    label: z.enum(LABELS).default('internal'),
    rowLimit: z.number().int().min(1).max(10_000).default(500),
    timeoutS: z.number().int().min(1).max(300).default(15)
  })
  .strict()
  .refine((b) => !!b.providerId !== !!(b.deploymentId && b.resourceKey), 'Name the instance by providerId, or by deploymentId and resourceKey.');
export type ConnectInput = z.infer<typeof connectSchema>;

export const discoverQuery = z.object({ region: z.string().trim().max(40).optional(), refresh: z.enum(['0', '1']).optional(), kind: z.enum(DISCOVERED_KINDS).optional() }).strict();

const sha256 = (b: string) => createHash('sha256').update(b).digest('hex');
const hmac = (k: string | Buffer, d: string) => createHmac('sha256', k).update(d).digest();
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const bool = (v: string | null) => v === 'true';
const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

/**
 * An RDS IAM authentication token: a presigned `connect` request for `rds-db`, valid for 15 minutes, used as the
 * password (`<host>:<port>/?Action=connect&DBUser=<user>&X-Amz-...`). Computed here; nothing is called.
 */
export function rdsIamToken(o: { host: string; port: number; user: string; region: string; keys: { accessKeyId: string; secretAccessKey: string; sessionToken?: string | null }; now?: Date }): string {
  const now = o.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${o.region}/rds-db/aws4_request`;
  const params: [string, string][] = [
    ['Action', 'connect'],
    ['DBUser', o.user],
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${o.keys.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', '900'],
    ['X-Amz-SignedHeaders', 'host'],
    ...(o.keys.sessionToken ? ([['X-Amz-Security-Token', o.keys.sessionToken]] as [string, string][]) : [])
  ];
  const query = params
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const host = `${o.host}:${o.port}`;
  const canonical = ['GET', '/', query, `host:${host}\n`, 'host', sha256('')].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${o.keys.secretAccessKey}`, day), o.region), 'rds-db'), 'aws4_request');
  return `${host}/?${query}&X-Amz-Signature=${createHmac('sha256', key).update(toSign).digest('hex')}`;
}

/** The connection engine of a provider's database engine. */
function engineFor(kind: DiscoveredKind, providerEngine: string): Engine | null {
  const e = providerEngine.toLowerCase();
  if (kind === 'documentdb') return 'documentdb';
  if (kind === 'dynamodb') return 'dynamodb';
  if (kind === 'cosmos-nosql') return 'cosmos-nosql';
  if (kind === 'cosmos-mongodb') return 'cosmos-mongodb';
  if (kind === 'azure-postgres') return 'postgres';
  if (kind === 'azure-mysql') return 'mysql';
  if (kind === 'do-database') return e === 'pg' ? 'postgres' : e === 'mysql' ? 'mysql' : e === 'mongodb' ? 'do-mongodb' : null;
  if (/postgres/.test(e)) return 'postgres';
  if (/mysql|mariadb/.test(e)) return 'mysql';
  return null;
}

/** The lease engine dialect of a connection engine (B-1704), or null when the lease engines cannot make its users. */
const leaseDialect = (e: Engine | null): 'postgres' | 'mysql' | 'mongodb' | null => (e === 'postgres' ? 'postgres' : e === 'mysql' ? 'mysql' : e === 'documentdb' || e === 'do-mongodb' ? 'mongodb' : null);

function authModes(kind: DiscoveredKind, engine: Engine | null, o: { iam?: boolean; entra?: boolean; localAuth?: boolean } = {}): AuthMode[] {
  if (!engine) return [];
  if (kind === 'dynamodb') return ['account'];
  if (kind === 'cosmos-nosql') return o.localAuth === false ? ['account'] : ['account', 'key'];
  const out: AuthMode[] = ['password'];
  if (leaseDialect(engine)) out.push('lease');
  if (o.iam && (kind === 'rds' || kind === 'aurora')) out.push('rds-iam');
  if (o.entra && kind === 'azure-postgres') out.push('entra');
  return out;
}

/**
 * Whether a provider id names this instance: the same id (ARM ids compare case-insensitively), the adapter's form
 * (`instance:<id>`, `cluster:<id>` for RDS), or the instance's name or ARN suffix.
 */
function sameInstance(x: Pick<DiscoveredInstance, 'providerId' | 'name'>, pid: string): boolean {
  const a = x.providerId.toLowerCase();
  const b = pid.toLowerCase();
  if (a === b || x.name === pid) return true;
  const bare = pid.replace(/^(instance|cluster):/, '');
  return x.name === bare || a.endsWith(`:${bare.toLowerCase()}`) || a.endsWith(`/${bare.toLowerCase()}`);
}

const tagsOf = (xml: string): Record<string, string> => Object.fromEntries(xmlAll(xmlText(xml, 'TagList') ?? '', 'Tag').map((t) => [xmlText(t, 'Key') ?? '', xmlText(t, 'Value') ?? '']));

interface LinkRow {
  connection_id: string;
  tenant_id: string;
  account_id: string;
  provider_id: string;
  kind: DiscoveredKind;
  region: string | null;
  endpoint_kind: 'private' | 'public';
  host: string;
  auth: AuthMode;
  db_user: string | null;
  lease_engine: string | null;
  lease_role: string | null;
  ca_pem: string | null;
  deployment_id: string | null;
  resource_key: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export const linkView = (l: LinkRow) => ({
  connectionId: l.connection_id,
  accountId: l.account_id,
  providerId: l.provider_id,
  kind: l.kind,
  region: l.region,
  endpoint: l.endpoint_kind,
  host: l.host,
  auth: l.auth,
  dbUser: l.db_user,
  leaseEngine: l.lease_engine,
  leaseRole: l.lease_role,
  caBundle: !!l.ca_pem,
  deployment: l.deployment_id ? { id: l.deployment_id, key: l.resource_key } : null,
  createdAt: Number(l.created_at)
});

interface HeldLease {
  leaseId: string;
  username: string;
  password: string;
  expiresAt: number;
  ttlMs: number;
}

export class CloudDiscovery {
  private schema: { ok: boolean; at: number } | null = null;
  private endpoints: DiscoveryEndpoints = {};
  /** Leased users this instance holds, per connection (the password is never stored; a restart takes a new lease). */
  private readonly leases = new Map<string, HeldLease>();
  private readonly inflight = new Map<string, Promise<HeldLease>>();

  constructor(private readonly s: () => Services) {}

  /** Points discovery at other endpoints (tests: the fakes); the Azure default is the adapter's ARM endpoint. */
  setEndpoints(e: DiscoveryEndpoints): void {
    this.endpoints = { aws: { ...this.endpoints.aws, ...e.aws }, azure: { ...this.endpoints.azure, ...e.azure }, digitalocean: { ...this.endpoints.digitalocean, ...e.digitalocean } };
  }

  /** Whether migration 156 is applied (cached; rechecked every 30 seconds while it is not). */
  async installed(): Promise<boolean> {
    const t = Date.now();
    if (this.schema && (this.schema.ok || t - this.schema.at < SCHEMA_RECHECK_MS)) return this.schema.ok;
    let ok: boolean;
    try {
      ok = (await this.s().db.schema.hasTable('cloud_discovered')) && (await this.s().db.schema.hasTable('cloud_connection_links'));
    } catch {
      ok = false;
    }
    this.schema = { ok, at: t };
    return ok;
  }

  resetSchemaCache(): void {
    this.schema = null;
  }

  private async credential(account: CloudAccount): Promise<ProviderCredential> {
    const c = this.s().cloud.credentials;
    if (!c) throw new HttpProblem(503, 'Not installed', 'Cloud credentials are not available on this server.', { extensions: { reason: 'cloud_component_missing' } });
    return (await c.for(account, 'read')) as ProviderCredential;
  }

  private async transport(provider: Provider): Promise<CloudTransport> {
    return (await this.s().cloud.providers.adapter(provider)).transport;
  }

  private assertUsable(account: CloudAccount): void {
    if (account.state === 'pending') throw conflict(`${account.name} waits for a second cloud admin's approval; it cannot be used yet.`);
    if (account.state === 'disabled') throw conflict(`${account.name} is disabled.`);
    if (account.provider === 'cloudflare') throw new HttpProblem(409, 'Conflict', 'Cloudflare D1 and Hyperdrive come with B-10907; this build discovers no Cloudflare databases.', { extensions: { reason: 'unsupported' } });
  }

  private regionsFor(account: CloudAccount, region?: string): string[] {
    if (region) {
      if (account.regions.length && !account.regions.some((r) => r.region === region)) throw forbidden(`${region} is not on ${account.name}'s allow-list of regions.`, { step: 'zone', region });
      return [region];
    }
    const list = account.regions.map((r) => r.region);
    return list.length ? list : [account.defaultRegion ?? (account.provider === 'aws' ? 'us-east-1' : account.provider === 'azure' ? 'westeurope' : 'fra1')];
  }

  // ---------- provider calls ----------

  private async aws(account: CloudAccount, cred: ProviderCredential, region: string, service: 'rds' | 'dynamodb', body: string, headers: Record<string, string>): Promise<string> {
    if (cred.kind !== 'aws') throw conflict('An AWS account needs an AWS credential.');
    const t = await this.transport('aws');
    const base = (service === 'rds' ? this.endpoints.aws?.rds : this.endpoints.aws?.dynamodb) ?? `https://${service}.${region}.amazonaws.com`;
    const url = new URL('/', base);
    const signed = signV4({ method: 'POST', url, headers: { ...headers, ...(cred.sessionToken ? { 'x-amz-security-token': cred.sessionToken } : {}) }, payloadHash: sha256(body), region, service, accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey, date: new Date() });
    const res = await t.send({ method: 'POST', url, headers: signed, body, accountId: account.id });
    const text = res.body.toString('utf8');
    if (res.status !== 200) {
      const code = xmlText(text, 'Code') ?? (/"__type"\s*:\s*"(?:[^"#]*#)?([^"]+)"/.exec(text)?.[1] ?? null);
      throw new HttpProblem(res.status === 403 ? 403 : 502, 'Provider refused', `AWS ${service} refused the call${code ? ` (${code})` : ''} in ${region}.`, { extensions: { provider: 'aws', code, requestId: res.requestId } });
    }
    return text;
  }

  private rdsQuery(account: CloudAccount, cred: ProviderCredential, region: string, action: string): Promise<string> {
    return this.aws(account, cred, region, 'rds', new URLSearchParams({ Action: action, Version: '2014-10-31', MaxRecords: '100' }).toString(), { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' });
  }

  private async dynamo<T>(account: CloudAccount, cred: ProviderCredential, region: string, action: string, input: Record<string, unknown>): Promise<T> {
    return JSON.parse(await this.aws(account, cred, region, 'dynamodb', JSON.stringify(input), { 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': `DynamoDB_20120810.${action}` })) as T;
  }

  private async discoverAws(account: CloudAccount, cred: ProviderCredential, regions: string[]): Promise<DiscoveredInstance[]> {
    const out: DiscoveredInstance[] = [];
    for (const region of regions) {
      const inst = await this.rdsQuery(account, cred, region, 'DescribeDBInstances');
      for (const x of xmlAll(xmlText(inst, 'DBInstances') ?? '', 'DBInstance')) {
        // Instances of an Aurora or DocumentDB cluster are reached through the cluster's endpoints.
        if (xmlText(x, 'DBClusterIdentifier')) continue;
        const pe = xmlText(x, 'Engine') ?? '';
        const ep = xmlText(x, 'Endpoint') ?? '';
        const host = xmlText(ep, 'Address');
        const port = num(xmlText(ep, 'Port'), /mysql|maria/.test(pe) ? 3306 : 5432);
        const engine = engineFor('rds', pe);
        const tags = tagsOf(x);
        out.push({ providerId: xmlText(x, 'DBInstanceArn') ?? xmlText(x, 'DBInstanceIdentifier') ?? '', provider: 'aws', kind: 'rds', name: xmlText(x, 'DBInstanceIdentifier') ?? '', region, providerEngine: pe, engine, state: xmlText(x, 'DBInstanceStatus') ?? 'unknown', endpoints: { private: host ? { host, port } : null, public: host && bool(xmlText(x, 'PubliclyAccessible')) ? { host, port } : null }, database: xmlText(x, 'DBName'), adminUser: xmlText(x, 'MasterUsername'), tls: true, auth: authModes('rds', engine, { iam: bool(xmlText(x, 'IAMDatabaseAuthenticationEnabled')) }), managed: tags['exprsn:managed'] === 'true', deployment: null });
      }
      const clusters = await this.rdsQuery(account, cred, region, 'DescribeDBClusters');
      for (const x of xmlAll(xmlText(clusters, 'DBClusters') ?? '', 'DBCluster')) {
        const pe = xmlText(x, 'Engine') ?? '';
        const kind: DiscoveredKind = pe === 'docdb' ? 'documentdb' : 'aurora';
        const port = num(xmlText(x, 'Port'), pe === 'docdb' ? 27017 : /mysql/.test(pe) ? 3306 : 5432);
        // Reads go to the reader endpoint where there is one.
        const host = xmlText(x, 'ReaderEndpoint') ?? xmlText(x, 'Endpoint');
        const engine = engineFor(kind, pe);
        const tags = tagsOf(x);
        out.push({ providerId: xmlText(x, 'DBClusterArn') ?? xmlText(x, 'DBClusterIdentifier') ?? '', provider: 'aws', kind, name: xmlText(x, 'DBClusterIdentifier') ?? '', region, providerEngine: pe, engine, state: xmlText(x, 'Status') ?? 'unknown', endpoints: { private: host ? { host, port } : null, public: null }, database: xmlText(x, 'DatabaseName'), adminUser: xmlText(x, 'MasterUsername'), tls: true, auth: authModes(kind, engine, { iam: bool(xmlText(x, 'IAMDatabaseAuthenticationEnabled')) }), managed: tags['exprsn:managed'] === 'true', deployment: null });
      }
      let start: string | undefined;
      const tables: string[] = [];
      do {
        const r = await this.dynamo<{ TableNames?: string[]; LastEvaluatedTableName?: string }>(account, cred, region, 'ListTables', { Limit: 100, ...(start ? { ExclusiveStartTableName: start } : {}) });
        tables.push(...(r.TableNames ?? []));
        start = r.LastEvaluatedTableName;
      } while (start && tables.length < 500);
      const dynamoHost = new URL(this.endpoints.aws?.dynamodb ?? `https://dynamodb.${region}.amazonaws.com`);
      for (const name of tables) {
        const d = await this.dynamo<{ Table?: { TableArn?: string; TableStatus?: string } }>(account, cred, region, 'DescribeTable', { TableName: name }).catch(() => ({ Table: undefined }));
        out.push({ providerId: d.Table?.TableArn ?? `arn:aws:dynamodb:${region}:${account.providerIds.awsAccountId ?? ''}:table/${name}`, provider: 'aws', kind: 'dynamodb', name, region, providerEngine: 'dynamodb', engine: 'dynamodb', state: (d.Table?.TableStatus ?? 'ACTIVE').toLowerCase(), endpoints: { private: null, public: { host: dynamoHost.hostname, port: Number(dynamoHost.port) || (dynamoHost.protocol === 'http:' ? 80 : 443) } }, database: null, adminUser: null, tls: dynamoHost.protocol === 'https:', auth: ['account'], managed: false, deployment: null });
      }
    }
    return out;
  }

  private async arm<T>(account: CloudAccount, cred: ProviderCredential, method: 'GET' | 'POST', path: string): Promise<T> {
    if (cred.kind !== 'azure') throw conflict('An Azure account needs an Azure credential.');
    const t = await this.transport('azure');
    const base = (this.endpoints.azure?.arm ?? (await this.s().cloud.providers.adapter('azure')).arm).replace(/\/+$/, '');
    const token = await cred.getToken(AZURE_SCOPES.arm);
    const r = await t.json<T>({ method, url: `${base}${path}`, headers: { authorization: `Bearer ${token.token}` }, ...(method === 'POST' ? { body: '{}' } : {}), accountId: account.id, ...(method === 'POST' ? { apiClass: 'read' as const } : {}) }, (status, b) => {
      const e = ((b ?? {}) as { error?: { code?: string; message?: string } }).error ?? {};
      return { message: `Azure answered ${status}${e.code ? ` (${e.code})` : ''}: ${(e.message ?? 'no detail').slice(0, 300)}`, code: e.code ?? null };
    });
    return r.body;
  }

  private async discoverAzure(account: CloudAccount, cred: ProviderCredential, regions: string[]): Promise<DiscoveredInstance[]> {
    const sub = account.providerIds.azureSubscriptionId;
    if (!sub) throw conflict(`${account.name} names no subscription.`);
    const out: DiscoveredInstance[] = [];
    const inRegion = (loc: string | undefined) => !loc || regions.includes(loc.toLowerCase().replace(/\s+/g, ''));
    type Arm = { id: string; name: string; location?: string; kind?: string; tags?: Record<string, string>; properties?: Record<string, unknown> };
    const list = async (provider: string, version: string) => (await this.arm<{ value?: Arm[] }>(account, cred, 'GET', `/subscriptions/${sub}/providers/${provider}?api-version=${version}`)).value ?? [];
    for (const [provider, kind, version] of [['Microsoft.DBforPostgreSQL/flexibleServers', 'azure-postgres', '2022-12-01'], ['Microsoft.DBforMySQL/flexibleServers', 'azure-mysql', '2023-12-30']] as const) {
      for (const x of await list(provider, version)) {
        if (!inRegion(x.location)) continue;
        const p = x.properties ?? {};
        const fqdn = typeof p.fullyQualifiedDomainName === 'string' ? p.fullyQualifiedDomainName : null;
        const net = (p.network ?? {}) as { publicNetworkAccess?: string; delegatedSubnetResourceId?: string };
        const privateAccess = !!net.delegatedSubnetResourceId || (Array.isArray(p.privateEndpointConnections) && p.privateEndpointConnections.length > 0) || net.publicNetworkAccess === 'Disabled';
        const port = kind === 'azure-postgres' ? 5432 : 3306;
        const entra = ((p.authConfig ?? {}) as { activeDirectoryAuth?: string }).activeDirectoryAuth === 'Enabled';
        const engine = engineFor(kind, kind);
        out.push({ providerId: x.id, provider: 'azure', kind, name: x.name, region: x.location ?? null, providerEngine: kind === 'azure-postgres' ? 'postgres' : 'mysql', engine, state: String(p.state ?? 'unknown').toLowerCase(), endpoints: { private: fqdn && privateAccess ? { host: fqdn, port } : null, public: fqdn && net.publicNetworkAccess !== 'Disabled' && !net.delegatedSubnetResourceId ? { host: fqdn, port } : null }, database: kind === 'azure-postgres' ? 'postgres' : null, adminUser: typeof p.administratorLogin === 'string' ? p.administratorLogin : null, tls: true, auth: authModes(kind, engine, { entra }), managed: x.tags?.['exprsn:managed'] === 'true', deployment: null });
      }
    }
    for (const x of await list('Microsoft.DocumentDB/databaseAccounts', '2024-05-15')) {
      if (!inRegion(x.location)) continue;
      const p = x.properties ?? {};
      const privateEp = Array.isArray(p.privateEndpointConnections) && p.privateEndpointConnections.length > 0;
      const isPublic = p.publicNetworkAccess !== 'Disabled';
      if (x.kind === 'MongoDB') {
        const host = `${x.name}.mongo.cosmos.azure.com`;
        out.push({ providerId: x.id, provider: 'azure', kind: 'cosmos-mongodb', name: x.name, region: x.location ?? null, providerEngine: 'MongoDB', engine: 'cosmos-mongodb', state: String(p.provisioningState ?? 'unknown').toLowerCase(), endpoints: { private: privateEp ? { host, port: 10255 } : null, public: isPublic ? { host, port: 10255 } : null }, database: null, adminUser: x.name, tls: true, auth: ['password'], managed: x.tags?.['exprsn:managed'] === 'true', deployment: null });
        continue;
      }
      const doc = typeof p.documentEndpoint === 'string' ? new URL(p.documentEndpoint) : new URL(`https://${x.name}.documents.azure.com:443/`);
      const ep = { host: doc.hostname, port: Number(doc.port) || 443 };
      out.push({ providerId: x.id, provider: 'azure', kind: 'cosmos-nosql', name: x.name, region: x.location ?? null, providerEngine: x.kind ?? 'GlobalDocumentDB', engine: 'cosmos-nosql', state: String(p.provisioningState ?? 'unknown').toLowerCase(), endpoints: { private: privateEp ? ep : null, public: isPublic ? ep : null }, database: null, adminUser: null, tls: doc.protocol === 'https:', auth: authModes('cosmos-nosql', 'cosmos-nosql', { localAuth: p.disableLocalAuth !== true }), managed: x.tags?.['exprsn:managed'] === 'true', deployment: null });
    }
    for (const x of await list('Microsoft.DocumentDB/mongoClusters', '2024-07-01')) {
      if (!inRegion(x.location)) continue;
      const p = x.properties ?? {};
      // The connection string is mongodb+srv://<cluster>.mongocluster.cosmos.azure.com; the driver dials one host directly.
      const srv = /@?([A-Za-z0-9.-]+\.mongocluster\.cosmos\.azure\.com)/.exec(String(p.connectionString ?? ''))?.[1] ?? `${x.name}.mongocluster.cosmos.azure.com`;
      const host = srv.startsWith('c.') ? srv : `c.${srv.replace(/^global\./, '')}`;
      const privateEp = Array.isArray(p.privateEndpointConnections) && p.privateEndpointConnections.length > 0;
      out.push({ providerId: x.id, provider: 'azure', kind: 'cosmos-mongodb', name: x.name, region: x.location ?? null, providerEngine: 'mongoCluster', engine: 'cosmos-mongodb', state: String(p.clusterStatus ?? p.provisioningState ?? 'unknown').toLowerCase(), endpoints: { private: privateEp ? { host, port: 10260 } : null, public: p.publicNetworkAccess !== 'Disabled' ? { host, port: 10260 } : null }, database: null, adminUser: ((p.administrator ?? {}) as { userName?: string }).userName ?? (typeof p.administratorLogin === 'string' ? p.administratorLogin : null), tls: true, auth: ['password'], managed: x.tags?.['exprsn:managed'] === 'true', deployment: null });
    }
    return out;
  }

  private async doApi<T>(account: CloudAccount, cred: ProviderCredential, path: string): Promise<T> {
    if (cred.kind !== 'token') throw conflict('A DigitalOcean account needs an API token.');
    const t = await this.transport('digitalocean');
    const base = (this.endpoints.digitalocean?.api ?? 'https://api.digitalocean.com').replace(/\/+$/, '');
    const r = await t.json<T>({ method: 'GET', url: `${base}${path}`, headers: { authorization: `Bearer ${cred.token}` }, accountId: account.id }, (status, b) => {
      const e = (b ?? {}) as { id?: string; message?: string };
      return { message: `DigitalOcean answered ${status}${e.id ? ` (${e.id})` : ''}: ${(e.message ?? 'no detail').slice(0, 300)}`, code: e.id ?? null };
    });
    return r.body;
  }

  private async discoverDo(account: CloudAccount, cred: ProviderCredential, regions: string[]): Promise<DiscoveredInstance[]> {
    type Conn = { host?: string; port?: number; user?: string; database?: string; ssl?: boolean };
    const r = await this.doApi<{ databases?: { id: string; name: string; engine: string; region?: string; status?: string; connection?: Conn; private_connection?: Conn; tags?: string[]; db_names?: string[] }[] }>(account, cred, '/v2/databases');
    return (r.databases ?? [])
      .filter((d) => !d.region || regions.includes(d.region))
      .map((d) => {
        const engine = engineFor('do-database', d.engine);
        // Never the password DigitalOcean puts in `connection`: only where and who.
        const ep = (c?: Conn): Endpoint | null => (c?.host ? { host: c.host, port: num(c.port, 25060) } : null);
        return { providerId: d.id, provider: 'digitalocean' as const, kind: 'do-database' as const, name: d.name, region: d.region ?? null, providerEngine: d.engine, engine, state: d.status ?? 'unknown', endpoints: { private: ep(d.private_connection), public: ep(d.connection) }, database: d.connection?.database ?? d.db_names?.[0] ?? null, adminUser: d.connection?.user ?? null, tls: d.connection?.ssl !== false, auth: authModes('do-database', engine), managed: (d.tags ?? []).includes('exprsn:managed:true') || (d.tags ?? []).includes('exprsn-managed'), deployment: null };
      });
  }

  /**
   * The managed databases the adapter lists for the `database` type (`cloud/databases.ts`, B-10301, B-10303): what
   * this installation made, with its endpoint as the adapter observes it. Discovery's own listing covers every
   * instance; these mark which are managed and add any it missed. A failing adapter list leaves discovery as it is.
   */
  private async adapterDatabases(account: CloudAccount, cred: ProviderCredential, regions: string[]): Promise<ObservedResource[]> {
    const provider = this.s().cloud.providerFor(account.provider) as unknown as CloudProvider | null;
    if (!provider || typeof provider.supports !== 'function' || provider.supports('database', 'list') !== 'built') return [];
    const out: ObservedResource[] = [];
    for (const region of account.provider === 'aws' ? regions : [regions[0]!]) {
      try {
        out.push(...(await provider.list({ account, cred, region }, 'database', { managedOnly: true })));
      } catch (err) {
        this.s().log.warn({ err: (err as Error).message, account: account.name }, 'cloud discovery: the database adapter list failed');
      }
    }
    return out;
  }

  /** The deployments' database resources of this account, by provider id (the `database` type the adapters drive). */
  private async provisioned(account: CloudAccount): Promise<Map<string, { id: string; key: string; observed: ObservedResource | null }>> {
    const out = new Map<string, { id: string; key: string; observed: ObservedResource | null }>();
    try {
      const rows = (await this.s().db('cloud_resources as r').join('cloud_deployments as d', 'd.id', 'r.deployment_id').where({ 'd.account_id': account.id, 'r.type': 'database' }).whereNot('r.state', 'deleted').whereNotNull('r.provider_id').select('r.deployment_id', 'r.key', 'r.provider_id', 'r.observed')) as { deployment_id: string; key: string; provider_id: string; observed: string | null }[];
      for (const r of rows) out.set(r.provider_id, { id: r.deployment_id, key: r.key, observed: json<ObservedResource | null>(r.observed, null) });
    } catch {
      /* the deployments are not installed */
    }
    return out;
  }

  // ---------- discover ----------

  /** What the account holds now (from the providers), kept as the account's last discovery. */
  async discover(a: CloudActor, accountId: string, o: { region?: string; kind?: DiscoveredKind; refresh?: boolean } = {}): Promise<{ instances: DiscoveredInstance[]; cached: boolean; at: number }> {
    const p = a.principal;
    const account = await this.s().cloud.accounts.getFor(p, accountId);
    this.assertUsable(account);
    const installed = await this.installed();
    if (installed && !o.refresh) {
      const rows = (await this.s().db('cloud_discovered').where({ account_id: account.id }).orderBy('name')) as { instance: string; seen_at: number }[];
      const fresh = rows.length && Date.now() - Math.min(...rows.map((r) => Number(r.seen_at))) < 10 * 60_000;
      if (fresh) {
        const instances = rows.map((r) => json<DiscoveredInstance>(r.instance, null as never)).filter((x) => (!o.kind || x.kind === o.kind) && (!o.region || x.region === o.region));
        return { instances: await this.withConnections(p.tenantId, instances), cached: true, at: Math.min(...rows.map((r) => Number(r.seen_at))) };
      }
    }
    const regions = this.regionsFor(account, o.region);
    const cred = await this.credential(account);
    let instances = account.provider === 'aws' ? await this.discoverAws(account, cred, regions) : account.provider === 'azure' ? await this.discoverAzure(account, cred, regions) : await this.discoverDo(account, cred, regions);
    const mine = await this.provisioned(account);
    instances = instances.filter((x) => x.providerId).map((x) => {
      const d = [...mine.entries()].find(([pid]) => sameInstance(x, pid))?.[1];
      return d ? { ...x, managed: true, deployment: { id: d.id, key: d.key } } : x;
    });
    for (const o of await this.adapterDatabases(account, cred, regions)) {
      const have = instances.find((x) => sameInstance(x, o.providerId));
      if (have) {
        have.managed = true;
        continue;
      }
      const ep = typeof o.props.endpoint === 'string' ? /^(.+):(\d+)$/.exec(o.props.endpoint) : null;
      const kind: DiscoveredKind = account.provider === 'aws' ? (o.props.service === 'aurora' ? 'aurora' : 'rds') : account.provider === 'azure' ? (o.props.engine === 'mysql' ? 'azure-mysql' : 'azure-postgres') : 'do-database';
      const engine: Engine = o.props.engine === 'mysql' ? 'mysql' : 'postgres';
      const at = ep ? { host: ep[1]!, port: Number(ep[2]) } : null;
      const d = [...mine.entries()].find(([pid]) => pid === o.providerId)?.[1];
      instances.push({ providerId: o.providerId, provider: account.provider, kind, name: o.name, region: o.region ?? null, providerEngine: String(o.props.engine ?? engine), engine, state: o.state, endpoints: { private: at && o.props.privateEndpoint !== false ? at : null, public: at && o.props.publicAccess === true ? at : null }, database: null, adminUser: null, tls: true, auth: authModes(kind, engine), managed: true, deployment: d ? { id: d.id, key: d.key } : null });
    }
    const at = Date.now();
    if (installed) {
      const db = this.s().db;
      await db.transaction(async (trx) => {
        const seen = new Set<string>();
        for (const x of instances) {
          seen.add(x.providerId);
          const row = { account_id: account.id, provider_id: x.providerId.slice(0, 500), kind: x.kind, name: x.name.slice(0, 255), region: x.region, engine: x.engine, instance: JSON.stringify(x), seen_at: at };
          const had = await trx('cloud_discovered').where({ account_id: account.id, provider_id: row.provider_id }).first('id');
          if (had) await trx('cloud_discovered').where({ id: (had as { id: string }).id }).update(row);
          else await trx('cloud_discovered').insert({ id: ulid(), ...row });
        }
        // Only a full discovery (every region, every kind) forgets what it no longer sees.
        if (!o.region) await trx('cloud_discovered').where({ account_id: account.id }).whereNotIn('provider_id', [...seen].length ? [...seen] : ['-']).delete();
      });
    }
    await this.s().audit.append({ tenantId: p.tenantId, action: 'cloud.discovery.run', kind: 'admin', actor: actorFrom(p, a.ip), target: { account: account.id, name: account.name }, detail: { provider: account.provider, regions, found: instances.length, kinds: [...new Set(instances.map((x) => x.kind))] }, ...(a.traceId ? { traceId: a.traceId } : {}) });
    const shown = instances.filter((x) => (!o.kind || x.kind === o.kind));
    return { instances: await this.withConnections(p.tenantId, shown), cached: false, at };
  }

  private async withConnections(tenantId: string, list: DiscoveredInstance[]): Promise<DiscoveredInstance[]> {
    if (!(await this.installed())) return list;
    const links = (await this.s().db('cloud_connection_links as l').join('data_connections as c', 'c.id', 'l.connection_id').where({ 'l.tenant_id': tenantId }).select('l.provider_id', 'c.id', 'c.name')) as { provider_id: string; id: string; name: string }[];
    return list.map((x) => ({ ...x, connections: links.filter((l) => l.provider_id === x.providerId).map((l) => ({ id: l.id, name: l.name })) }));
  }

  // ---------- connect ----------

  private async need(): Promise<void> {
    if (!(await this.installed())) throw new HttpProblem(503, 'Not installed', 'Data connections from a cloud account need the database migration 156_cloud_connections, which has not been applied.', { extensions: { reason: 'migration_pending' } });
  }

  /** Writes a secret to the tenant vault as the admin (their policy must allow it) and returns its reference. */
  private async vaultPut(a: CloudActor, path: string, value: string, label: Label): Promise<string> {
    const v = this.s().vault;
    const c = await v.callerFor(a.principal, { ip: a.ip, traceId: a.traceId ?? null });
    await v.write(c, path, { password: value }, { label: label === 'public' ? 'internal' : label });
    return `vault:${path}#password`;
  }

  /** Makes a data connection to one instance of the account; the allowed hosts change with it. */
  async connect(a: CloudActor, accountId: string, input: ConnectInput): Promise<{ connection: ReturnType<typeof connectionView>; link: ReturnType<typeof linkView>; notes: string[] }> {
    await this.need();
    const s = this.s();
    const p = a.principal;
    const account = await s.cloud.accounts.getFor(p, accountId);
    this.assertUsable(account);
    if (!clears(p.clearance, input.label)) throw forbidden(`Your clearance is ${p.clearance}; a ${input.label} connection is above it.`, { step: 'clearance' });
    // The instance, discovered now (or the deployment's resource, found the same way).
    let providerId = input.providerId ?? null;
    let deployment: { id: string; key: string } | null = null;
    if (!providerId) {
      const d = await s.cloud.deployments.getFor(p, input.deploymentId!);
      if (d.accountId !== account.id) throw conflict('That deployment runs in another account.');
      const r = await s.cloud.deployments.resource(d.id, input.resourceKey!);
      if (!r || r.type !== 'database' || !r.providerId) throw notFound('Database resource');
      providerId = r.providerId;
      deployment = { id: d.id, key: r.key };
    }
    // The last discovery when it is fresh and has the instance; otherwise the providers are asked again.
    const pick = (list: DiscoveredInstance[]) => list.find((x) => x.providerId === providerId) ?? list.find((x) => sameInstance(x, providerId!));
    let inst = pick((await this.discover(a, account.id)).instances);
    if (!inst || deployment) inst = pick((await this.discover(a, account.id, { refresh: true })).instances);
    if (!inst) throw notFound('Instance');
    deployment ??= inst.deployment;
    if (!inst.engine) throw conflict(`${inst.name} is ${inst.providerEngine}, which this build reads through no data connection engine.`);
    if (!s.connections.installed().includes(inst.engine)) throw conflict(`The ${inst.engine} engine is not installed on this platform.`);
    if (!inst.auth.includes(input.auth)) throw conflict(`${inst.name} offers ${inst.auth.join(', ')}; not ${input.auth}.${input.auth === 'rds-iam' ? ' Turn on IAM database authentication on the instance first.' : input.auth === 'entra' ? ' Turn on Microsoft Entra authentication on the server first.' : ''}`);
    const ep = inst.endpoints[input.endpoint] ?? null;
    if (!ep) throw conflict(`${inst.name} has no ${input.endpoint} endpoint${input.endpoint === 'private' && inst.endpoints.public ? '; it is reachable only on its public endpoint, which needs endpoint: public' : ''}.`);
    if (inst.region && account.regions.length) await s.cloud.accounts.assertRegionAllows(account, inst.region.toLowerCase().replace(/\s+/g, ''), input.label, { tenantId: p.tenantId, use: 'data' });
    await s.zones.assertMemberFits('connection', input.zone, input.label);
    if ((await s.connections.list(p.tenantId)).some((c) => c.name === input.name)) throw conflict('A connection with that name exists.');

    const engine = inst.engine;
    const notes: string[] = [];
    const https = engine === 'dynamodb' || engine === 'cosmos-nosql';
    const endpoint = https ? `${inst.tls ? 'https' : 'http'}://${ep.host}${ep.port && ep.port !== (inst.tls ? 443 : 80) ? `:${ep.port}` : ''}` : `${ep.host}:${ep.port}`;
    const database = engine === 'dynamodb' ? null : (input.database ?? inst.database ?? (engine === 'do-mongodb' ? 'admin' : null));
    if (!database && engine !== 'dynamodb') throw badRequest(`Name the database to read on ${inst.name}.`);
    const options: Record<string, unknown> = engine === 'dynamodb' && inst.region ? { region: inst.region } : engine === 'cosmos-nosql' ? { auth: 'key' } : {};

    // The CA bundle: DigitalOcean's, from its API; the Amazon RDS bundle, given (it is not fetched from the internet).
    let ca: string | null = input.caPem?.trim() ?? null;
    if (!ca && account.provider === 'digitalocean') {
      const r = await this.doApi<{ ca?: { certificate?: string } }>(account, await this.credential(account), `/v2/databases/${encodeURIComponent(inst.providerId)}/ca`).catch(() => null);
      const pem = r?.ca?.certificate ? Buffer.from(r.ca.certificate, 'base64').toString('utf8') : null;
      if (pem && PEM_CERTS.test(pem)) ca = pem;
      else notes.push('The cluster\'s CA certificate could not be read; TLS checks it against the system trust store.');
    }
    if (!ca && account.provider === 'aws' && engine !== 'dynamodb') notes.push('No CA bundle was given: TLS checks the certificate against the system trust store, which does not hold the Amazon RDS CAs. Connect again with caPem (global-bundle.pem), or set tlsCaFile on a DocumentDB connection.');

    // How it authenticates: what the connection stores, and what the link adds at each use.
    let username: string | null = null;
    let password: string | null = null;
    let leaseEngine: string | null = null;
    let dbUser: string | null = input.dbUser ?? null;
    const secretPath = `connections/cloud/${input.name}/admin`;
    const adminSecret = async (): Promise<string> => {
      if (input.adminPasswordRef) {
        if (!isVaultRef(input.adminPasswordRef)) throw badRequest('adminPasswordRef is a vault:path#key reference.');
        await s.vault.assertRefsReadable(p, [input.adminPasswordRef], { ip: a.ip, traceId: a.traceId ?? null });
        return input.adminPasswordRef;
      }
      let value = input.adminPassword ?? null;
      if (!value && account.provider === 'digitalocean') {
        // DigitalOcean hands the admin password out with the cluster; it goes straight to the vault, never into a row.
        const r = await this.doApi<{ database?: { connection?: { password?: string } } }>(account, await this.credential(account), `/v2/databases/${encodeURIComponent(inst.providerId)}`);
        value = r.database?.connection?.password ?? null;
      }
      if (!value) throw badRequest(`Give the admin password of ${inst.name} (adminPassword, written to the vault) or a vault reference to it (adminPasswordRef).`);
      return this.vaultPut(a, secretPath, value, input.label);
    };
    switch (input.auth) {
      case 'password':
        username = input.dbUser ?? inst.adminUser;
        if (!username) throw badRequest('Name the database account (dbUser).');
        password = await adminSecret();
        break;
      case 'lease': {
        const dialect = leaseDialect(engine)!;
        const adminUser = inst.adminUser ?? input.dbUser;
        if (!adminUser) throw badRequest('Name the admin account the lease engine logs in with (dbUser).');
        const ref = await adminSecret();
        leaseEngine = `cloud-${input.name}`.slice(0, 64);
        const schemas = input.schemas ?? (dialect === 'postgres' ? ['public'] : [database!]);
        await s.dbLeases.registerEngine(p, { name: leaseEngine, dialect, endpoint: `${ep.host}:${ep.port}`, database: dialect === 'mongodb' ? 'admin' : database, tls: inst.tls, zone: input.zone, label: input.label, adminUsername: dialect === 'mongodb' && !adminUser.includes('/') ? `admin/${adminUser}` : adminUser, adminPasswordRef: ref, userHost: '%', defaultTtlSeconds: input.leaseTtlSeconds, maxTtlSeconds: Math.max(input.leaseTtlSeconds, Math.min(86_400, input.leaseTtlSeconds * 24)), check: true }, { ip: a.ip, traceId: a.traceId ?? null });
        await s.dbLeases.putRole(p, leaseEngine, 'conn', { privileges: 'read', schemas }, { ip: a.ip, traceId: a.traceId ?? null });
        dbUser = null;
        break;
      }
      case 'rds-iam':
      case 'entra':
        if (!dbUser) throw badRequest(`Name the database user the ${input.auth === 'rds-iam' ? 'IAM token' : 'Entra token'} signs in as (dbUser).`);
        username = dbUser;
        break;
      case 'account':
        if (engine === 'cosmos-nosql') notes.push('The account\'s principal needs the Cosmos DB Built-in Data Reader role on the account (a data-plane role assignment).');
        if (engine === 'dynamodb') notes.push('The account\'s read role needs dynamodb:Query, dynamodb:PartiQLSelect, dynamodb:DescribeTable and dynamodb:ListTables.');
        break;
      case 'key': {
        const keys = await this.arm<{ primaryReadonlyMasterKey?: string }>(account, await this.credential(account), 'POST', `${inst.providerId}/readonlykeys?api-version=2024-05-15`);
        if (!keys.primaryReadonlyMasterKey) throw new HttpProblem(502, 'Provider refused', `Azure listed no read-only key for ${inst.name}.`);
        password = await this.vaultPut(a, secretPath, keys.primaryReadonlyMasterKey, input.label);
        break;
      }
    }

    // The endpoint and the tenant's allowed hosts change together: added now, taken out again if the connection fails.
    const hosts = (await s.integrations.get(p.tenantId)).allowedHosts;
    const added = !hosts.includes(ep.host.toLowerCase());
    if (added) {
      const after = (await s.integrations.set(p.tenantId, { allowedHosts: [...hosts, ep.host.toLowerCase()] }, p.userId ?? 'system')).allowedHosts;
      await s.audit.append({ tenantId: p.tenantId, action: 'tenant.hosts.updated', kind: 'admin', actor: actorFrom(p, a.ip), target: { tenant: p.tenantId }, detail: { before: hosts, after, why: `cloud connection ${input.name}` }, ...(a.traceId ? { traceId: a.traceId } : {}) });
    }
    const operator = parseAllowList(s.cfg.CONNECTIONS_ALLOWED_HOSTS ?? '');
    if (input.endpoint === 'public' && !namedHost(ep.host, operator)) notes.push(`${ep.host} is a public endpoint: the operator must name it in CONNECTIONS_ALLOWED_HOSTS before the connection can reach it (a private endpoint needs nothing).`);
    let row: ConnectionRow;
    try {
      row = await s.connections.create(p, { name: input.name, engine, endpoint, database, zone: input.zone, label: input.label, rowLimit: input.rowLimit, timeoutS: input.timeoutS, tls: inst.tls, username, password, options });
      const now = Date.now();
      const link: LinkRow = { connection_id: row.id, tenant_id: p.tenantId, account_id: account.id, provider_id: inst.providerId.slice(0, 500), kind: inst.kind, region: inst.region, endpoint_kind: input.endpoint, host: ep.host.toLowerCase(), auth: input.auth, db_user: dbUser, lease_engine: leaseEngine, lease_role: leaseEngine ? 'conn' : null, ca_pem: ca, deployment_id: deployment?.id ?? null, resource_key: deployment?.key ?? null, created_by: p.userId, created_at: now, updated_at: now };
      await s.db('cloud_connection_links').insert(link);
      await s.audit.append({ tenantId: p.tenantId, action: 'connection.registered', kind: 'admin', actor: actorFrom(p, a.ip), target: { connection: row.id, name: row.name }, label: row.label, detail: { engine: row.engine, endpoint: row.endpoint, zone: row.zone, account: row.account, via: 'cloud-connect' }, ...(a.traceId ? { traceId: a.traceId } : {}) });
      await s.audit.append({ tenantId: p.tenantId, action: 'cloud.connection.connected', kind: 'admin', actor: actorFrom(p, a.ip), target: { connection: row.id, name: row.name, account: account.id }, label: row.label, detail: { provider: account.provider, kind: inst.kind, providerId: inst.providerId, endpoint: input.endpoint, host: ep.host, auth: input.auth, leaseEngine, hostAdded: added, deployment }, ...(a.traceId ? { traceId: a.traceId } : {}) });
      return { connection: connectionView(row), link: linkView(link), notes };
    } catch (err) {
      if (added) await s.integrations.set(p.tenantId, { allowedHosts: hosts }, p.userId ?? 'system').catch(() => undefined);
      throw err;
    }
  }

  /** The links of a tenant's connections (for the views). */
  async links(tenantId: string): Promise<ReturnType<typeof linkView>[]> {
    if (!(await this.installed())) return [];
    return ((await this.s().db('cloud_connection_links').where({ tenant_id: tenantId })) as LinkRow[]).map(linkView);
  }

  // ---------- at each use ----------

  private async leaseFor(link: LinkRow): Promise<HeldLease> {
    const key = link.connection_id;
    const have = this.leases.get(key);
    const now = Date.now();
    if (have && have.expiresAt - now > have.ttlMs / 3) return have;
    const running = this.inflight.get(key);
    if (running) return running;
    const task = (async () => {
      const l = await this.s().dbLeases.issueForService(link.tenant_id, link.lease_engine!, link.lease_role ?? 'conn', { service: SERVICE });
      const next: HeldLease = { leaseId: l.id, username: l.username, password: l.password, expiresAt: l.expiresAt, ttlMs: l.ttlSeconds * 1000 };
      this.leases.set(key, next);
      // The one it replaces ends now (its user is dropped), not at its expiry.
      if (have) await this.s().dbLeases.revokeForService(link.tenant_id, have.leaseId, SERVICE).catch(() => undefined);
      return next;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, task);
    return task;
  }

  /** What `ConnectionService` hands its drivers for connections made from a cloud account. */
  hooks(): CloudConnectionHooks {
    return {
      auth: async (c) => {
        if (!(await this.installed())) return null;
        const link = (await this.s().db('cloud_connection_links').where({ connection_id: c.id }).first()) as LinkRow | undefined;
        if (!link) return null;
        const out: CloudConnectionAuth = link.ca_pem ? { ca: link.ca_pem } : {};
        if (link.auth === 'password' || link.auth === 'key') return out;
        if (link.auth === 'lease') {
          const l = await this.leaseFor(link);
          return { ...out, username: l.username, password: l.password };
        }
        const account = await this.s().cloud.accounts.get(link.account_id);
        if (!account) throw conflict('The cloud account of this connection was removed.');
        this.assertUsable(account);
        const cred = await this.credential(account);
        if (link.auth === 'rds-iam') {
          if (cred.kind !== 'aws') throw conflict('RDS IAM authentication needs an AWS account.');
          const port = Number(/:(\d+)$/.exec(c.endpoint)?.[1] ?? 5432);
          return { ...out, username: link.db_user, password: rdsIamToken({ host: link.host, port, user: link.db_user ?? '', region: link.region ?? account.defaultRegion ?? 'us-east-1', keys: cred }) };
        }
        if (link.auth === 'entra') {
          if (cred.kind !== 'azure') throw conflict('Entra authentication needs an Azure account.');
          return { ...out, username: link.db_user, password: (await cred.getToken(AZURE_SCOPES.ossrdbms)).token };
        }
        // `account`: the account's own session (DynamoDB) or Entra token (Cosmos DB).
        if (cred.kind === 'aws') return { ...out, username: cred.accessKeyId, password: cred.secretAccessKey, sessionToken: cred.sessionToken ?? null };
        if (cred.kind === 'azure') return { ...out, bearer: (await cred.getToken(AZURE_SCOPES.cosmos)).token };
        throw conflict('This account cannot sign a data connection\'s requests.');
      },
      forget: async (c) => {
        if (!(await this.installed())) return;
        const link = (await this.s().db('cloud_connection_links').where({ connection_id: c.id }).first()) as LinkRow | undefined;
        if (!link) return;
        await this.s().db('cloud_connection_links').where({ connection_id: c.id }).delete();
        const held = this.leases.get(c.id);
        this.leases.delete(c.id);
        if (held) await this.s().dbLeases.revokeForService(link.tenant_id, held.leaseId, SERVICE).catch(() => undefined);
      }
    };
  }

  /** The lease this instance holds for a connection (for tests and the view); never the password. */
  heldLease(connectionId: string): { leaseId: string; username: string; expiresAt: number } | null {
    const l = this.leases.get(connectionId);
    return l ? { leaseId: l.leaseId, username: l.username, expiresAt: l.expiresAt } : null;
  }
}
