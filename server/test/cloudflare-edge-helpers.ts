/*
 * 1.9.99-final, Sprint 61 (B-10901 to B-10904): what the three front door suites share: a harness with the cloud
 * accounts migrations and 161_cloud_edge applied by hand until they are registered, the Cloudflare fake on 127.0.0.1
 * (recording, after every change, what the watched name answers with: its records, the SSL mode and whether the edge
 * certificate is active), a platform Cloudflare account on it, and a platform admin. Nothing reaches Cloudflare.
 */
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';
import type { AddressInfo } from 'node:net';
import type { Principal } from '../src/authz/policy.js';
import type { CloudActor } from '../src/cloud/accounts.js';
import type { CloudAccount } from '../src/cloud/types.js';
import { pemOf, selfSignedCertificate } from '../src/federation/x509.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { seedAccount } from './cloud-credentials-helpers.js';
import { FakeCloudflare } from './fake-cloudflare.js';
import type { RecordedRequest, Reply } from './fake-cloud-base.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';

export const EDGE_PERMISSIONS_ALL = ['Zone Read', 'DNS Write', 'Cloudflare Tunnel Write', 'SSL and Certificates Write', 'Zone WAF Write', 'Account Settings Read', 'Access: Apps and Policies Write', 'Access: Organizations, Identity Providers, and Groups Write'];

export interface Moment {
  op: string;
  records: { type: string; content: string; proxied: boolean }[];
  ssl: string;
  certActive: boolean;
}

/** The fake, also noting after each change what the watched name answers with. */
export class WatchedCloudflare extends FakeCloudflare {
  watch: string | null = null;
  readonly timeline: Moment[] = [];

  snapshot(name: string, op: string): Moment {
    const zone = [...this.zones.values()].find((z) => name === z.name || name.endsWith(`.${z.name}`));
    const records = [...this.records.values()].filter((r) => r.name === name && ['A', 'AAAA', 'CNAME'].includes(r.type)).map((r) => ({ type: r.type, content: r.content, proxied: r.proxied }));
    return { op, records, ssl: zone ? (this.edge.settings.get(zone.id)?.ssl ?? 'full') : 'full', certActive: zone ? !this.edge.pendingCertificates.has(zone.id) : false };
  }

  protected override handle(r: RecordedRequest): Reply {
    const out = super.handle(r);
    if (this.watch && r.method !== 'GET') this.timeline.push(this.snapshot(this.watch, `${r.method} ${r.path.replace(/^\/client\/v4/, '')}`));
    return out;
  }
}

export interface EdgeWorld {
  h: Harness;
  cf: WatchedCloudflare;
  account: CloudAccount;
  zoneId: string;
  token: string;
  admin: CloudActor & { client: Client };
  stop(): Promise<void>;
}

export async function edgeWorld(env: Record<string, string> = {}, permissions = EDGE_PERMISSIONS_ALL): Promise<EdgeWorld> {
  const h = await harness({ SERVICE_ALLOWED_HOSTS: '127.0.0.1,::1,localhost', ...env });
  if (!(await h.s.db.schema.hasTable('cloud_accounts'))) await (await import('../src/db/migrations/146_cloud_accounts.js')).up(h.s.db);
  if (!(await h.s.db.schema.hasTable('cloud_issuer_keys'))) await (await import('../src/db/migrations/147_cloud_federation.js')).up(h.s.db);
  if (!(await h.s.db.schema.hasTable('cloud_edge'))) await (await import('../src/db/migrations/161_cloud_edge.js')).up(h.s.db);
  h.s.cloud.accounts.resetSchemaCache();
  h.s.cloud.edge.resetSchemaCache();
  const cf = await new WatchedCloudflare().start();
  const zoneId = cf.addZone('example.test').id;
  const token = cf.addToken(permissions).value;
  h.s.cloud.providers.setEndpoints({ cloudflare: { api: cf.url } });
  const account = await seedAccount(h, { provider: 'cloudflare', mode: 'vaulted', name: 'edge', providerIds: { cloudflareAccountId: cf.accountId, cloudflareZoneIds: [zoneId] }, refs: { token: 'vault:cloud/accounts/edge#token' } });
  (h.s.cloud as { credentials: unknown }).credentials = { for: async () => ({ kind: 'token', token, accountId: cf.accountId }) };
  const u = await localUser(h, 'edgeadmin', ['system-admin'], 'restricted');
  const client = await loginAdmin(h, 'edgeadmin');
  const p = (await loadPrincipal(h.s, h.tenantId, u.id, {}))!;
  const principal: Principal = { ...p, mfa: true };
  return {
    h,
    cf,
    account,
    zoneId,
    token,
    admin: { principal, ip: '127.0.0.1', client },
    stop: async () => {
      await h.close();
      await cf.stop();
    }
  };
}

/** A self-signed certificate and key for a name (the origin's ACME certificate stand-in). */
export function certFor(name: string): { cert: string; key: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { cert: pemOf(selfSignedCertificate({ publicKey, commonName: name, days: 60, privateKey })), key: privateKey };
}

/** A TLS origin on 127.0.0.1 serving a certificate. */
export async function tlsOrigin(cert: string, key: KeyObject): Promise<{ port: number; server: TlsServer }> {
  const server = createTlsServer({ cert, key: key.export({ type: 'pkcs8', format: 'pem' }) }, (s) => s.end());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, server };
}
