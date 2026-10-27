import { randomBytes, X509Certificate } from 'node:crypto';
import { HttpProblem } from '../http/problem.js';
import { guardedRequest, serviceAddressProblem, servicePolicy } from '../platform/egress.js';
import type { Services } from '../services.js';
import { cloudAudit, type CloudAuditActor } from './audit.js';
import { dataTierPath } from './caches.js';
import { CloudVault } from './cloud-vault.js';
import { SECRET_MOUNT, fileName } from './compute.js';
import type { Deployment, GraphResource } from './graph.js';
import type { CallContext, CloudProvider, ResourceRef, SecretBinding } from './providers/types.js';
import { deploymentSpecSchema, type DeploymentSpec } from './spec.js';

/*
 * 1.9.99-final, Sprint 59 (B-10302, B-10305): a provisioned data tier wired into the deployed app.
 *
 * When a deployment's spec provisions its data tier (`data.mode: provision`), the app's secret bindings name
 * `vault:cloud/<deployment>#database_url`, `#redis_url` and `#database_ca` (`compute.ts`), and the Helm release puts
 * the same keys in its Secret. Nothing writes those by hand: once the managed database and cache exist, the first
 * resolve of one of them wires the tier here, into the platform scope of the vault (`cloud/deployments/<id>/data`):
 *
 *   database_url  `postgres://exprsn:<password>@<private endpoint>:<port>/<database>?sslmode=verify-full&sslrootcert=<file>`,
 *                 the password the one Exprsn-AI chose for the database (`db_admin_password`, made once, given to the
 *                 provider at create time through the secret broker), the file where the shape mounts the CA
 *   database_ca   the provider's CA bundle (RDS's global bundle, Azure's DigiCert Global Root G2 and Microsoft RSA
 *                 Root CA 2017, DigitalOcean's per-cluster CA from `/v2/databases/<id>/ca`), checked as PEM
 *                 certificates and delivered as a file like every secret, never a variable
 *   redis_url     from `cloud/caches.ts` (`CloudCaches.wire`), refused when the cache does not suit BullMQ and the bus
 *
 * Where the CA file is: Kubernetes `/run/secrets/database_ca.pem` (the chart's `extraSecretFiles`), VMs the systemd
 * credential `/run/credentials/exprsn-ai.service/database_ca`, Container Apps `/run/secrets/exprsn/database-ca`. ECS
 * and App Platform hand secrets to the app as variables only, so a provisioned database there is refused
 * (`ca_file_unsupported`): `sslrootcert` needs a file, and verify-full without the provider's CA cannot connect.
 */

export const DATA_TIER_KEYS = ['database_url', 'redis_url', 'database_ca'] as const;
export type DataTierKey = (typeof DATA_TIER_KEYS)[number];
/** Generated once per deployment and handed to the provider at create time. */
export const GENERATED_KEYS = ['db_admin_password', 'cache_auth_token'] as const;

/** Where the provider's CA bundles are published (B-10302); the operator may give a file instead (`db:move --ca-file`). */
export const CA_SOURCES: Record<'aws' | 'azure', { urls: string[]; note: string }> = {
  aws: { urls: ['https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem'], note: 'The RDS global bundle (every region’s root and intermediate CAs).' },
  azure: { urls: ['https://cacerts.digicert.com/DigiCertGlobalRootG2.crt.pem', 'https://www.microsoft.com/pkiops/certs/Microsoft%20RSA%20Root%20Certificate%20Authority%202017.crt'], note: 'DigiCert Global Root G2 and Microsoft RSA Root CA 2017, the roots Azure Database for PostgreSQL chains to.' }
};

/** Where the app reads the CA bundle, by compute shape and platform; null where secrets reach the app as variables only. */
export function caPathFor(spec: Pick<DeploymentSpec, 'compute' | 'target'>): string | null {
  if (spec.compute.shape === 'kubernetes') return '/run/secrets/database_ca.pem';
  if (spec.compute.shape === 'vm') return '/run/credentials/exprsn-ai.service/database_ca';
  if (spec.target.provider === 'azure') return `${SECRET_MOUNT}/${fileName({ name: 'database_ca', env: 'DATABASE_CA', ref: '' })}`;
  return null;
}

/** A PostgreSQL URL with verify-full TLS against the CA file (`sslrootcert` is read by node-postgres at connect). */
export function postgresUrl(o: { host: string; port: number; user: string; password: string; database: string; caPath: string | null; sslmode?: 'verify-full' | 'verify-ca' | 'require' | 'disable' }): string {
  const q = new URLSearchParams();
  const mode = o.sslmode ?? 'verify-full';
  if (mode !== 'disable') q.set('sslmode', mode);
  if (o.caPath && mode !== 'disable') q.set('sslrootcert', o.caPath);
  const host = o.host.includes(':') ? `[${o.host}]` : o.host;
  const qs = q.toString();
  return `postgres://${encodeURIComponent(o.user)}:${encodeURIComponent(o.password)}@${host}:${o.port}/${encodeURIComponent(o.database)}${qs ? `?${qs.replace(/%2F/g, '/')}` : ''}`;
}

/** Checks a CA bundle: PEM certificates only (DER is converted), at most 512 KiB and 50 certificates, each a CA. */
export function normaliseCaBundle(input: string | Buffer): string {
  const text = Buffer.isBuffer(input) ? (input.includes('-----BEGIN') ? input.toString('utf8') : derToPem(input)) : input;
  if (text.length > 512 * 1024) throw new Error('The CA bundle is larger than 512 KiB.');
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (!blocks.length) throw new Error('The CA bundle holds no PEM certificate.');
  if (blocks.length > 50) throw new Error('The CA bundle holds more than 50 certificates.');
  for (const b of blocks) {
    let c: X509Certificate;
    try {
      c = new X509Certificate(b);
    } catch {
      throw new Error('The CA bundle holds a certificate that does not parse.');
    }
    if (!c.ca) throw new Error(`The CA bundle holds a certificate that is not a CA (${c.subject.split('\n').join(', ').slice(0, 120)}).`);
  }
  return `${blocks.join('\n')}\n`;
}

const derToPem = (der: Buffer): string => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '')}\n-----END CERTIFICATE-----\n`;

export const dataTierPending = (what: string) => new HttpProblem(409, 'Conflict', `The provisioned data tier is not wired yet: ${what}`, { extensions: { reason: 'data_tier_not_wired' } });

export interface DataTierOptions {
  /** The provider's CA bundle for a database (tests: a fixture; default: `CA_SOURCES` through the egress guard, DigitalOcean's API). */
  fetchCa?: (d: Deployment, db: GraphResource, provider: CloudProvider, ctx: CallContext) => Promise<string>;
}

export class CloudDataTier {
  constructor(
    private readonly s: () => Services,
    readonly options: DataTierOptions = {}
  ) {}

  private vault(): CloudVault {
    return new CloudVault(this.s);
  }

  private async read(d: Pick<Deployment, 'id'>): Promise<Record<string, string>> {
    try {
      return await this.vault().readAll(dataTierPath(d.id));
    } catch {
      return {};
    }
  }

  private async merge(d: Pick<Deployment, 'id'>, values: Record<string, string>): Promise<void> {
    await this.vault().write(dataTierPath(d.id), { ...(await this.read(d)), ...values });
  }

  /** A value Exprsn-AI generates once (the database's admin password, the cache's AUTH token). */
  async generated(d: Pick<Deployment, 'id'>, key: (typeof GENERATED_KEYS)[number]): Promise<string> {
    const have = await this.read(d);
    if (have[key]) return have[key]!;
    // Hex: RDS, Azure and ElastiCache accept it (no @, ", / or spaces), 64 characters.
    const value = randomBytes(32).toString('hex');
    await this.merge(d, { [key]: value });
    return value;
  }

  specOf(d: Deployment): DeploymentSpec | null {
    if (!d.spec) return null;
    const r = deploymentSpecSchema.safeParse(d.spec);
    return r.success ? r.data : null;
  }

  /**
   * The engine's secret broker asks here first (`defaultSecretBroker`'s intercept): the generated values of any
   * deployment, and the wired data tier of a provisioned one. Null: not ours, the vault resolves it as before.
   */
  async intercept(d: Deployment, b: SecretBinding): Promise<string | null> {
    if (b.name === 'db_admin_password' || b.name === 'cache_auth_token') {
      if (!b.ref.startsWith(`vault:cloud/${d.name}#`) && !b.ref.startsWith(`vault:cloud/${this.specOf(d)?.name ?? d.name}#`)) return null;
      return this.generated(d, b.name);
    }
    const spec = this.specOf(d);
    // Sprint 61 (B-10905): a Cloudflare app tier's deployment (on the Cloudflare account) holds no data tier of its
    // own: its Hyperdrive reads the URL the target deployment wired into the vault, through the vault.
    if (!spec || spec.data.mode !== 'provision' || d.provider === 'cloudflare') return null;
    const key = (DATA_TIER_KEYS as readonly string[]).find((k) => b.ref === `vault:cloud/${spec.name}#${k}`) as DataTierKey | undefined;
    if (!key) return null;
    let have = await this.read(d);
    if (!have[key]) have = await this.wire(d, { service: 'cloud.data-tier', onBehalfOf: d.createdBy });
    if (!have[key]) throw dataTierPending(`${key} has no value.`);
    return have[key]!;
  }

  /** The wired values for a provisioned deployment (wiring what is missing); the Helm release's Secret reads these. */
  async values(d: Deployment, actor: CloudAuditActor): Promise<Record<string, string>> {
    const have = await this.read(d);
    const spec = this.specOf(d);
    const want: DataTierKey[] = ['database_url', 'database_ca', ...(spec?.data.mode === 'provision' && spec.data.cache ? (['redis_url'] as const) : [])];
    if (want.every((k) => have[k])) return have;
    return this.wire(d, actor);
  }

  /** Wires the managed database (URL and CA) and cache (URL) of a provisioned deployment into the vault. */
  async wire(d: Deployment, actor: CloudAuditActor): Promise<Record<string, string>> {
    const s = this.s();
    const spec = this.specOf(d);
    if (!spec || spec.data.mode !== 'provision') throw new HttpProblem(409, 'Conflict', `${d.name} does not provision its data tier.`, { extensions: { reason: 'not_provisioned' } });
    const caPath = caPathFor(spec);
    // Sprint 61 (B-10905): Hyperdrive takes the URL's host, user and password; TLS to the origin is Hyperdrive's.
    if (!caPath && spec.compute.shape !== 'cloudflare') throw new HttpProblem(409, 'Conflict', `${spec.compute.shape === 'container' ? (spec.target.provider === 'aws' ? 'ECS' : 'App Platform') : spec.compute.shape} hands secrets to the app as variables only, so the database's CA bundle cannot be a file for sslrootcert; use Kubernetes, VMs or Container Apps, or an existing data tier whose URL names a CA file in the image.`, { extensions: { reason: 'ca_file_unsupported' } });
    const rows = await s.cloud.deployments.resources(d.id);
    const db = rows.find((r) => r.type === 'database' && r.key === 'db');
    const cache = rows.find((r) => r.type === 'cache' && r.key === 'cache');
    const out: Record<string, string> = {};
    if (db) {
      if (!db.observed || !db.providerId || db.observed.state !== 'ready') throw dataTierPending('the database is not ready yet.');
      const props = db.observed.props as Record<string, unknown>;
      const desired = db.desired.spec as { adminUser?: string; adminPasswordRef?: string; engine?: string };
      if (!desired.adminPasswordRef) throw new HttpProblem(409, 'Conflict', 'The database was created without a password Exprsn-AI holds (adminPasswordRef), so its URL cannot be written; give the desired database one and apply again.', { extensions: { reason: 'database_password_unknown' } });
      const host = String(props.endpoint ?? props.host ?? '');
      if (!host) throw dataTierPending('the database reports no endpoint yet.');
      const port = Number(props.port ?? 5432);
      const database = String(props.dbName ?? props.database ?? (d.provider === 'digitalocean' ? 'defaultdb' : 'postgres'));
      const ctxs = await s.cloud.deployments.context(d, 'read');
      const ctx = ctxs.ctx(db.region);
      const ca = normaliseCaBundle(await (this.options.fetchCa ?? defaultFetchCa(s))(d, db, ctxs.provider, ctx));
      const password = await this.generated(d, 'db_admin_password');
      out.database_ca = ca;
      out.database_url = postgresUrl({ host, port, user: desired.adminUser ?? String(props.adminUser ?? 'exprsn'), password, database, caPath });
    }
    if (cache && spec.data.cache) {
      await s.cloud.caches.wire(d, cache, actor);
    }
    if (Object.keys(out).length) await this.merge(d, out);
    const all = await this.read(d);
    await cloudAudit(s, { tenantId: d.tenantId, action: 'cloud.data.wired', actor, deploymentId: d.id, deploymentName: d.name, detail: { database: !!all.database_url, cache: !!all.redis_url, caFile: caPath } });
    return all;
  }
}

/** The provider's CA bundle: DigitalOcean's per-cluster CA from its API, else the published bundle through the egress guard. */
function defaultFetchCa(s: Services): NonNullable<DataTierOptions['fetchCa']> {
  return async (d, db, provider, ctx) => {
    if (d.provider === 'digitalocean') {
      const p = provider as CloudProvider & { databaseCa?: (c: CallContext, ref: ResourceRef) => Promise<string> };
      if (!p.databaseCa) throw new Error('The DigitalOcean adapter cannot read a cluster’s CA.');
      return p.databaseCa(ctx, { type: 'database', providerId: db.providerId!, ...(db.locator ? { locator: db.locator } : {}) });
    }
    const src = CA_SOURCES[d.provider as 'aws' | 'azure'];
    if (!src) throw new Error(`No CA bundle source for ${d.provider}.`);
    const policy = servicePolicy(s.cfg);
    const parts: string[] = [];
    for (const u of src.urls) {
      const res = await guardedRequest({ method: 'GET', url: new URL(u), headers: {}, timeoutMs: 15_000, maxBytes: 512 * 1024, check: (a, h) => serviceAddressProblem(a, h, policy) });
      if (res.status !== 200) throw new Error(`${new URL(u).host} answered ${res.status} for the CA bundle.`);
      parts.push(normaliseCaBundle(res.body));
    }
    return parts.join('');
  };
}
