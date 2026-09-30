import { createPrivateKey, generateKeyPairSync, X509Certificate, type KeyObject } from 'node:crypto';
import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ulid } from 'ulid';
import { json } from '../db/knex.js';
import { PLATFORM_SCOPE } from '../platform/datakeys.js';
import { badRequest, conflict, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import type { AcmeChallengeStore } from './acme.js';
import { audit, notifyAdmins, type OpsActor } from './common.js';
import { buildCsr, pemBlocks } from './der.js';
import { createDnsProvider, type DnsProvider } from './dns.js';

/** Published on the bus after every issue or renewal; every instance's file sink writes the new PEMs (B-409). */
export const CERT_ISSUED = 'platform.cert.issued';
export interface CertIssuedEvent {
  certificate: string;
  name: string;
  serial: string;
  notAfter: number;
  renewal: boolean;
}

/** A directory name for a certificate: its first name, with a wildcard's `*` spelled out. */
export const sinkName = (name: string): string => name.replace(/^\*\./, '_wildcard.').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200) || 'certificate';

/** Writes one file atomically: a temporary file in the same directory, then a rename over the old one. */
async function atomicWrite(file: string, data: string, mode: number): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data, { mode });
  await chmod(tmp, mode);
  await rename(tmp, file);
}

/**
 * The certificate file sink: `<dir>/<name>/fullchain.pem`, `cert.pem`, `chain.pem` and `privkey.pem` (0600), the
 * layout reverse proxies (nginx, HAProxy, Caddy, Traefik file provider) read. The key is written last, so a proxy
 * that reloads on the key file sees the matching certificate.
 */
export async function writeCertFiles(dir: string, name: string, chainPem: string, keyPem: string): Promise<string> {
  const target = path.join(path.resolve(dir), sinkName(name));
  await mkdir(target, { recursive: true, mode: 0o750 });
  const blocks = chainPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  await atomicWrite(path.join(target, 'cert.pem'), (blocks[0] ?? '') + '\n', 0o644);
  await atomicWrite(path.join(target, 'chain.pem'), blocks.slice(1).join('\n') + (blocks.length > 1 ? '\n' : ''), 0o644);
  await atomicWrite(path.join(target, 'fullchain.pem'), blocks.join('\n') + '\n', 0o644);
  await atomicWrite(path.join(target, 'privkey.pem'), keyPem, 0o600);
  return target;
}

export const CERT_USES = ['TLS', 'mTLS', 'LDAPS', 'CA', 'other'] as const;
export type CertUse = (typeof CERT_USES)[number];

export interface CertRow {
  id: string;
  name: string;
  domains: string[];
  issued_to: string | null;
  use: CertUse;
  method: 'acme' | 'tracked';
  state: 'pending' | 'issuing' | 'valid' | 'failed' | 'revoked';
  auto_renew: boolean;
  issuer: string | null;
  serial: string | null;
  fingerprint: string | null;
  not_before: number | null;
  not_after: number | null;
  chain_pem: string | null;
  key_sealed: string | null;
  order_url: string | null;
  error: string | null;
  job_id: string | null;
  notified_at: number | null;
  renewed_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const fromRow = (r: Record<string, unknown>): CertRow => ({
  ...(r as unknown as CertRow),
  domains: json<string[]>(r.domains, []),
  auto_renew: Boolean(r.auto_renew),
  not_before: num(r.not_before),
  not_after: num(r.not_after),
  notified_at: num(r.notified_at),
  renewed_at: num(r.renewed_at),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

const DAY = 86_400_000;

/** The issuer's common name, or the whole distinguished name. */
const shortName = (dn: string): string => /(?:^|\n)CN=([^\n]+)/.exec(dn)?.[1] ?? dn.replace(/\n/g, ', ');

export function parseCertificate(pem: string): { issuer: string; subject: string; serial: string; fingerprint: string; notBefore: number; notAfter: number; domains: string[]; isCa: boolean } {
  const der = pemBlocks(pem)[0];
  if (!der) throw new Error('No PEM certificate found');
  const x = new X509Certificate(der);
  const domains = (x.subjectAltName ?? '').split(/,\s*/).filter((s) => s.startsWith('DNS:')).map((s) => s.slice(4));
  return { issuer: shortName(x.issuer), subject: shortName(x.subject), serial: x.serialNumber, fingerprint: x.fingerprint256, notBefore: Date.parse(x.validFrom), notAfter: Date.parse(x.validTo), domains, isCa: x.ca };
}

export function certStatus(c: CertRow, renewDays: number, now = Date.now()): { days: number | null; status: string } {
  const days = c.not_after == null ? null : Math.floor((c.not_after - now) / DAY);
  if (c.state === 'revoked') return { days, status: 'revoked' };
  if (c.state === 'pending' || c.state === 'issuing') return { days, status: c.state };
  if (c.not_after == null) return { days, status: c.state === 'failed' ? 'failed' : c.state };
  if (c.not_after <= now) return { days, status: 'expired' };
  if (days! <= renewDays) return { days, status: 'expiring' };
  return { days, status: 'valid' };
}

const DOMAIN = /^(?=.{1,253}$)(?:(?!-)[a-z0-9-]{1,63}(?<!-)\.)*(?!-)[a-z0-9-]{1,63}(?<!-)$/;
/** A wildcard name (`*.example.internal`): dns-01 only. */
const WILDCARD = /^\*\.(?=.{1,251}$)(?:(?!-)[a-z0-9-]{1,63}(?<!-)\.)+(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * Platform certificates. `acme` certificates are ordered from the internal CA over RFC 8555 with a fresh ECDSA
 * P-256 key each time (sealed with the platform data key); `tracked` ones (the CA's own, or certificates issued
 * elsewhere) are only watched for expiry. http-01 challenges are kept in the database so any instance answers them.
 */
export class CertificateService {
  private dnsOverride: DnsProvider | null | undefined;

  constructor(private readonly s: () => Services) {}

  /** The dns-01 provider when ACME_CHALLENGE=dns-01, else null (http-01). Replaceable (tests). */
  get dns(): DnsProvider | null {
    if (this.dnsOverride !== undefined) return this.dnsOverride;
    const cfg = this.s().cfg;
    return (this.dnsOverride = cfg.ACME_CHALLENGE === 'dns-01' ? createDnsProvider(cfg) : null);
  }

  set dns(v: DnsProvider | null) {
    this.dnsOverride = v;
  }

  async list(): Promise<CertRow[]> {
    return (await this.s().db('platform_certificates').orderBy('not_after', 'asc').orderBy('name')).map(fromRow);
  }

  async get(id: string): Promise<CertRow> {
    const r = await this.s().db('platform_certificates').where({ id }).first();
    if (!r) throw notFound('Certificate');
    return fromRow(r);
  }

  private async patch(id: string, u: Record<string, unknown>): Promise<void> {
    await this.s().db('platform_certificates').where({ id }).update({ ...u, updated_at: Date.now() });
  }

  private enqueueIssue(by: OpsActor, id: string) {
    return this.s().jobs.enqueue({ tenantId: by.tenantId, type: 'ops.cert.issue', payload: { certId: id }, createdBy: by.userId, maxAttempts: 1 });
  }

  async request(by: OpsActor, input: { domains: string[]; issuedTo?: string | null; use: CertUse; autoRenew: boolean }): Promise<CertRow> {
    if (!this.s().acme.directoryUrl) throw conflict('ACME is not configured. Set ACME_DIRECTORY_URL to the internal CA\'s directory.');
    const domains = [...new Set(input.domains.map((d) => d.trim().toLowerCase()))];
    for (const d of domains) {
      if (WILDCARD.test(d) && !this.dns) throw badRequest(`${d} is a wildcard: wildcards need dns-01 (ACME_CHALLENGE=dns-01 with a DNS provider).`, { field: 'domains' });
      if (!DOMAIN.test(d) && !WILDCARD.test(d)) throw badRequest(`${d} is not a DNS name.`, { field: 'domains' });
    }
    const t = Date.now();
    const row = { id: ulid(), name: domains[0]!, domains: JSON.stringify(domains), issued_to: input.issuedTo ?? null, use: input.use, method: 'acme', state: 'pending', auto_renew: input.autoRenew, created_by: by.userId, created_at: t, updated_at: t };
    await this.s().db('platform_certificates').insert(row);
    const job = await this.enqueueIssue(by, row.id);
    await this.patch(row.id, { job_id: job.id });
    await audit(this.s(), by, 'platform.cert.requested', { certificate: row.id, name: row.name }, { domains, use: input.use, directory: this.s().acme.directoryUrl, job: job.id }, 'admin');
    return this.get(row.id);
  }

  async track(by: OpsActor, input: { pem: string; issuedTo?: string | null; use: CertUse }): Promise<CertRow> {
    let info: ReturnType<typeof parseCertificate>;
    try {
      info = parseCertificate(input.pem);
    } catch {
      throw badRequest('The certificate is not a PEM X.509 certificate.', { field: 'pem' });
    }
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(input.pem)) throw badRequest('Paste the certificate only, never its private key.', { field: 'pem' });
    const t = Date.now();
    const row = { id: ulid(), name: info.domains[0] ?? info.subject, domains: JSON.stringify(info.domains), issued_to: input.issuedTo ?? null, use: input.use, method: 'tracked', state: 'valid', auto_renew: false, issuer: info.issuer, serial: info.serial, fingerprint: info.fingerprint, not_before: info.notBefore, not_after: info.notAfter, chain_pem: input.pem.trim() + '\n', created_by: by.userId, created_at: t, updated_at: t };
    await this.s().db('platform_certificates').insert(row);
    await audit(this.s(), by, 'platform.cert.tracked', { certificate: row.id, name: row.name }, { issuer: info.issuer, serial: info.serial, notAfter: info.notAfter, fingerprint: info.fingerprint }, 'admin');
    return this.get(row.id);
  }

  async renew(by: OpsActor, id: string, reason = 'manual'): Promise<CertRow> {
    const c = await this.get(id);
    if (c.method !== 'acme') throw conflict('Only ACME certificates are renewed here; renew a tracked certificate with its issuer and track the new one.');
    if (c.state === 'pending' || c.state === 'issuing') throw conflict('The certificate is already being issued.');
    const job = await this.enqueueIssue(by, id);
    await this.patch(id, { state: c.chain_pem && c.state === 'valid' ? 'valid' : 'pending', job_id: job.id });
    await audit(this.s(), by, 'platform.cert.renewal.requested', { certificate: id, name: c.name }, { reason, job: job.id, notAfter: c.not_after }, reason === 'manual' ? 'admin' : 'system');
    return this.get(id);
  }

  async update(by: OpsActor, id: string, patch: { issuedTo?: string | null; use?: CertUse; autoRenew?: boolean }): Promise<CertRow> {
    const c = await this.get(id);
    const u: Record<string, unknown> = {};
    if (patch.issuedTo !== undefined) u.issued_to = patch.issuedTo;
    if (patch.use !== undefined) u.use = patch.use;
    if (patch.autoRenew !== undefined) u.auto_renew = patch.autoRenew;
    await this.patch(id, u);
    await audit(this.s(), by, 'platform.cert.updated', { certificate: id, name: c.name }, { changed: Object.keys(u), before: { issuedTo: c.issued_to, use: c.use, autoRenew: c.auto_renew }, after: patch }, 'admin');
    return this.get(id);
  }

  async revoke(by: OpsActor, id: string, reason: number): Promise<CertRow> {
    const c = await this.get(id);
    if (c.method !== 'acme') throw conflict('Tracked certificates are revoked by their issuer; remove it here instead.');
    if (!c.chain_pem || c.state === 'revoked') throw conflict('There is no issued certificate to revoke.');
    const der = pemBlocks(c.chain_pem)[0]!;
    const acct = await this.account();
    await this.s().acme.revoke({ key: acct.key, kid: acct.kid, certDer: der, reason });
    await this.patch(id, { state: 'revoked', auto_renew: false });
    await audit(this.s(), by, 'platform.cert.revoked', { certificate: id, name: c.name }, { serial: c.serial, reason }, 'admin');
    return this.get(id);
  }

  async remove(by: OpsActor, id: string): Promise<void> {
    const c = await this.get(id);
    if (c.method === 'acme' && c.state === 'valid' && c.not_after && c.not_after > Date.now()) throw conflict('Revoke a valid ACME certificate before removing it.');
    await this.s().db('platform_certificates').where({ id }).delete();
    await audit(this.s(), by, 'platform.cert.removed', { certificate: id, name: c.name }, { method: c.method, serial: c.serial }, 'admin');
  }

  /** The certificate's private key, for the deploy tooling that installs it. Every export is audited. */
  async exportKey(by: OpsActor, id: string): Promise<string> {
    const c = await this.get(id);
    if (!c.key_sealed) throw conflict('This certificate has no private key here.');
    const pem = await this.s().keys.open(PLATFORM_SCOPE, c.key_sealed, `platform-cert:${id}`);
    await audit(this.s(), by, 'platform.cert.key.exported', { certificate: id, name: c.name }, { serial: c.serial }, 'admin');
    return pem;
  }

  /** Writes an issued certificate and its key into ACME_CERT_DIR (the sink). Returns the directory, or null. */
  async sink(certId: string): Promise<string | null> {
    const s = this.s();
    if (!s.cfg.ACME_CERT_DIR) return null;
    const c = await this.get(certId);
    if (!c.chain_pem || !c.key_sealed || c.state === 'revoked') return null;
    const key = await s.keys.open(PLATFORM_SCOPE, c.key_sealed, `platform-cert:${certId}`);
    return writeCertFiles(s.cfg.ACME_CERT_DIR, c.name, c.chain_pem, key);
  }

  /** The ACME account for the configured directory, created on first use; its key is sealed at rest. */
  async account(): Promise<{ key: KeyObject; kid: string }> {
    const s = this.s();
    const dir = s.acme.directoryUrl;
    if (!dir) throw conflict('ACME is not configured. Set ACME_DIRECTORY_URL to the internal CA\'s directory.');
    const aad = `acme-account:${dir}`;
    const row = (await s.db('platform_acme_accounts').where({ directory_url: dir }).first()) as { kid: string; key_sealed: string } | undefined;
    if (row) return { key: createPrivateKey(await s.keys.open(PLATFORM_SCOPE, row.key_sealed, aad)), kid: row.kid };
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const kid = await s.acme.register(privateKey, s.cfg.ACME_CONTACT);
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    await s.db('platform_acme_accounts').insert({ directory_url: dir, kid, key_sealed: await s.keys.seal(PLATFORM_SCOPE, pem, aad), contact: s.cfg.ACME_CONTACT ?? null, created_at: Date.now() });
    return { key: privateKey, kid };
  }

  async accountView(): Promise<{ directoryUrl: string | null; registered: boolean; kid: string | null; contact: string | null; createdAt: number | null; challenge: 'http-01' | 'dns-01'; dnsProvider: string | null; certDir: string | null }> {
    const dir = this.s().acme.directoryUrl;
    const row = dir ? ((await this.s().db('platform_acme_accounts').where({ directory_url: dir }).first()) as { kid: string; contact: string | null; created_at: number } | undefined) : undefined;
    const dns = this.dns;
    return { directoryUrl: dir, registered: !!row, kid: row?.kid ?? null, contact: row?.contact ?? this.s().cfg.ACME_CONTACT ?? null, createdAt: row ? Number(row.created_at) : null, challenge: dns ? 'dns-01' : 'http-01', dnsProvider: dns?.name ?? null, certDir: this.s().cfg.ACME_CERT_DIR ?? null };
  }

  private get challengeStore(): AcmeChallengeStore {
    const db = this.s().db;
    return {
      publish: async (token, keyAuthorization) => {
        await db('platform_acme_challenges').where({ token }).delete();
        await db('platform_acme_challenges').insert({ token, key_authorization: keyAuthorization, expires_at: Date.now() + 60 * 60_000 });
      },
      remove: async (token) => {
        await db('platform_acme_challenges').where({ token }).delete();
      }
    };
  }

  /** The key authorization for an http-01 token, or null. Served at /.well-known/acme-challenge/<token>. */
  async challengeResponse(token: string): Promise<string | null> {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(token)) return null;
    const row = (await this.s().db('platform_acme_challenges').where({ token }).andWhere('expires_at', '>', Date.now()).first()) as { key_authorization: string } | undefined;
    return row?.key_authorization ?? null;
  }

  /** The issuing job: account, fresh key, CSR, order with http-01, chain; the key is sealed before it is stored. */
  async runIssue(certId: string, by: OpsActor, progress: (pct: number, msg: string) => Promise<void>, signal: AbortSignal): Promise<{ serial: string; notAfter: number }> {
    const s = this.s();
    const c = await this.get(certId);
    const renewal = !!c.chain_pem;
    await this.patch(certId, { state: renewal && c.state === 'valid' ? 'valid' : 'issuing', error: null });
    try {
      const acct = await this.account();
      await progress(10, 'Account ready');
      const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const csr = buildCsr(c.domains, privateKey);
      const dns = this.dns;
      const { chainPem, orderUrl } = await s.acme.issue({ key: acct.key, kid: acct.kid, domains: c.domains, csr, challenges: this.challengeStore, dns, dnsWaitMs: dns ? s.cfg.ACME_DNS_WAIT_SECONDS * 1000 : 0, signal, progress });
      const info = parseCertificate(chainPem);
      const keySealed = await s.keys.seal(PLATFORM_SCOPE, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), `platform-cert:${certId}`);
      await this.patch(certId, { state: 'valid', issuer: info.issuer, serial: info.serial, fingerprint: info.fingerprint, not_before: info.notBefore, not_after: info.notAfter, chain_pem: chainPem, key_sealed: keySealed, order_url: orderUrl, renewed_at: Date.now(), notified_at: null, error: null });
      await audit(s, by, renewal ? 'platform.cert.renewed' : 'platform.cert.issued', { certificate: certId, name: c.name }, { serial: info.serial, issuer: info.issuer, notAfter: info.notAfter, fingerprint: info.fingerprint, previousSerial: c.serial, challenge: dns ? 'dns-01' : 'http-01' });
      // Every instance hears this: their file sinks write the new PEMs, and anything else can reload on it.
      s.bus.publish(CERT_ISSUED, { certificate: certId, name: c.name, serial: info.serial, notAfter: info.notAfter, renewal } satisfies CertIssuedEvent);
      return { serial: info.serial, notAfter: info.notAfter };
    } catch (err) {
      const reason = (err as Error).message.slice(0, 1000);
      // A failed renewal keeps the certificate that is still in place.
      await this.patch(certId, { state: renewal && c.state === 'valid' ? 'valid' : 'failed', error: reason });
      await audit(s, by, 'platform.cert.issue.failed', { certificate: certId, name: c.name }, { reason, renewal });
      await notifyAdmins(s, { kind: 'platform.cert.failed', title: `Certificate ${c.name} could not be ${renewal ? 'renewed' : 'issued'}`, body: reason.slice(0, 300) });
      throw err;
    }
  }

  /**
   * The renewal sweep: ACME certificates inside the renewal window are renewed; certificates that will expire within
   * the window without automatic renewal, or already have, notify system admins once a day.
   */
  async sweep(by: OpsActor): Promise<{ renewing: string[]; notified: string[] }> {
    const s = this.s();
    const now = Date.now();
    const window = s.cfg.ACME_RENEW_DAYS * DAY;
    const renewing: string[] = [];
    const notified: string[] = [];
    for (const c of await this.list()) {
      if (c.state === 'revoked' || c.not_after == null) continue;
      const due = c.not_after - now <= window;
      if (!due) continue;
      if (c.method === 'acme' && c.auto_renew && c.state === 'valid' && s.acme.directoryUrl) {
        const running = c.job_id ? await s.jobs.get(by.tenantId, c.job_id) : undefined;
        if (!running || (running.state !== 'queued' && running.state !== 'running')) {
          await this.renew(by, c.id, 'schedule');
          renewing.push(c.name);
        }
        if (c.not_after - now > 7 * DAY) continue;
      }
      if (c.notified_at && now - c.notified_at < DAY) continue;
      const days = Math.floor((c.not_after - now) / DAY);
      await notifyAdmins(s, { kind: 'platform.cert.expiring', title: days < 0 ? `Certificate ${c.name} has expired` : `Certificate ${c.name} expires in ${days} ${days === 1 ? 'day' : 'days'}`, body: c.method === 'acme' ? (c.error ? `Renewal failed: ${c.error.slice(0, 200)}` : 'Renewal is due.') : `Issued by ${c.issuer ?? 'another CA'}; renew it there and track the new certificate.`, email: true });
      await this.patch(c.id, { notified_at: now });
      notified.push(c.name);
    }
    if (renewing.length || notified.length) await audit(s, by, 'platform.cert.sweep', {}, { renewing, notified });
    return { renewing, notified };
  }
}
