import { BlockList, isIP } from 'node:net';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, X509Certificate } from 'node:crypto';
import type { Request } from 'express';
import { ulid } from 'ulid';
import type { AuditEvent } from '../audit/chain.js';
import { platformTenant } from '../ops/common.js';
import type { Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import { fromPem } from './asn1.js';
import { buildPkcs12 } from './pkcs12.js';
import { PkiError, type CertRow, type PkiActor, type ProfileRow } from './service.js';
import { REASONS, spkiOf, type CsrKeyType, type San } from './x509.js';

/*
 * 1.9.0, Sprint 55 (B-189): member certificates.
 *
 * A tenant may turn on a client certificate for every member (Certificates › Settings, `members.enabled`, off by
 * default). When someone joins (an account is created, provisioned on first sign-in, approved, or reactivated) a job
 * issues them one under the tenant's chosen client profile, named by a SAN that maps it back to the account:
 * `exprsn-member://<tenant>/<user id>` (members.san uri) or the account's email address (members.san email). The key
 * is made here for them and kept sealed with the tenant key until they pick it up once in Settings (a PKCS#12 file
 * under a password they choose); after that only the certificate is kept. With `members.withToken` a CA token for
 * this server comes with it the same way. A sweep renews certificates within `members.renewDays` of expiry (same key,
 * so the member only fetches the new certificate), issues the ones a join missed, and revokes the certificates of
 * people who left; offboarding a tenant revokes them all.
 *
 * Certificate sign-in and mTLS for the API (members.signIn, members.mtls) read the client certificate a TLS proxy
 * verified and forwarded: nginx's `$ssl_client_escaped_cert` in PKI_CLIENT_CERT_HEADER, with
 * PKI_CLIENT_CERT_VERIFY_HEADER `SUCCESS`. The header is believed only from a peer address listed in
 * PKI_CLIENT_CERT_PROXIES (the socket's address, never X-Forwarded-For), and the certificate is checked again here:
 * it must be a live member certificate of this CA, chain to its intermediate, and name the account it maps to.
 */

export const MEMBER_URI = (slug: string, userId: string): string => `exprsn-member://${slug}/${userId}`;
const DAY = 86_400_000;
const JOIN_ACTIONS = new Set(['user.created', 'scim.user.created', 'user.signup.approved', 'scim.user.reactivated']);
const LEAVE_ACTIONS = new Set(['user.disabled', 'scim.user.deactivated', 'scim.user.deleted']);

export interface MemberRow {
  id: string;
  tenant_id: string;
  user_id: string;
  certificate_id: string;
  token_id: string | null;
  state: 'active' | 'replaced' | 'revoked';
  key_sealed: string | null;
  token_sealed: string | null;
  picked_up_at: number | null;
  renewed_from: string | null;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
}

const memberFrom = (r: Record<string, unknown>): MemberRow => ({ ...(r as unknown as MemberRow), picked_up_at: r.picked_up_at == null ? null : Number(r.picked_up_at), created_at: Number(r.created_at), updated_at: Number(r.updated_at), revoked_at: r.revoked_at == null ? null : Number(r.revoked_at) });

/** What the proxy forwarded: nothing, a certificate from a trusted proxy, or a header refused (untrusted peer, unverified, unreadable). */
export type ClientCert = { kind: 'none' } | { kind: 'cert'; cert: X509Certificate } | { kind: 'refused'; reason: 'untrusted-proxy' | 'not-verified' | 'unreadable' };

export interface MemberMatch {
  tenantId: string;
  userId: string;
  member: MemberRow;
  certificate: CertRow;
}

export class MemberCertificates {
  private table: { ok: boolean; at: number } | null = null;
  private proxies: { spec: string; list: BlockList } | null = null;

  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  private get cfg() {
    return this.s().cfg;
  }

  /** Forgets whether the tables exist (after a migration ran in this process). */
  forget(): void {
    this.table = null;
  }

  /** Whether the migration that makes the tables has run. */
  async configured(): Promise<boolean> {
    // Present is kept; missing is looked at again after 10 seconds, so registering the migration is noticed soon.
    if (this.table && (this.table.ok || Date.now() - this.table.at < 10_000)) return this.table.ok;
    let ok: boolean;
    try {
      ok = await this.db.schema.hasTable('pki_member_certificates');
    } catch {
      ok = false;
    }
    this.table = { ok, at: Date.now() };
    return ok;
  }

  private by(tenantId: string): PkiActor {
    return { tenantId, userId: null, actor: { service: 'pki' } };
  }

  private audit(tenantId: string, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>) {
    return this.s().audit.append({ tenantId, action, kind: 'system', actor: { service: 'pki' }, target, label: 'internal', ...(detail ? { detail } : {}) });
  }

  registerJobs(): void {
    this.s().jobs.register('pki.members.user', async (p) => this.reconcileUser(String(p.tenantId ?? ''), String(p.userId ?? ''), String(p.reason ?? 'joined')));
    this.s().jobs.register('pki.members.sweep', async () => this.sweep());
    // Joining and leaving are read from the audit chain, so every way in (admin, invitation, SCIM, provisioning on
    // first sign-in, sign-up approval) and out (disabled, SCIM deactivation or deletion, directory sync) counts.
    this.s().audit.onAppend((e) => void this.onAudit(e).catch((err: Error) => this.s().log.warn({ err: err.message }, 'member certificate hook failed')));
    // A member certificate revoked on the Certificates screen ends its row (and its token) too.
    this.s().pki.revokedListeners.push(async (e) => {
      if (!e.certificate || !(await this.configured())) return;
      const r = (await this.db('pki_member_certificates').where({ certificate_id: e.certificate.id, state: 'active' }).first()) as Record<string, unknown> | undefined;
      if (!r) return;
      const m = memberFrom(r);
      await this.db('pki_member_certificates').where({ id: m.id }).update({ state: 'revoked', revoked_at: Date.now(), updated_at: Date.now(), key_sealed: null, token_sealed: null });
      if (m.token_id) await this.s().caTokens.revoke(this.by(m.tenant_id), m.token_id, 'member certificate revoked').catch(() => undefined);
    });
  }

  schedule(scheduler: Scheduler): void {
    scheduler.every('pki.members.sweep', this.cfg.PKI_MEMBER_SWEEP_MINUTES * 60_000, async () => {
      const platform = await platformTenant(this.s());
      return platform ? [{ tenantId: platform }] : [];
    });
  }

  private async enabled(tenantId: string): Promise<boolean> {
    if (!(await this.configured())) return false;
    return (await this.s().pki.settings(tenantId))['members.enabled'];
  }

  private async onAudit(e: AuditEvent): Promise<void> {
    const join = JOIN_ACTIONS.has(e.action) || (e.action === 'auth.login' && e.detail?.jit === true) || (e.action === 'user.updated' && (e.detail?.after as { state?: string } | undefined)?.state === 'active');
    const leave = LEAVE_ACTIONS.has(e.action);
    if (!join && !leave) return;
    const userId = typeof e.target.user === 'string' ? e.target.user : typeof e.actor.user === 'string' ? e.actor.user : null;
    if (!userId || !(await this.enabled(e.tenant_id))) return;
    await this.s().jobs.enqueue({ tenantId: e.tenant_id, type: 'pki.members.user', payload: { tenantId: e.tenant_id, userId, reason: leave ? 'left' : 'joined' }, dedupeKey: `pki.members.user:${userId}:${e.id}`, maxAttempts: 3 });
  }

  // ---------- issuing, renewing, revoking ----------

  async active(tenantId: string, userId: string): Promise<MemberRow | undefined> {
    const r = (await this.db('pki_member_certificates').where({ tenant_id: tenantId, user_id: userId, state: 'active' }).orderBy('created_at', 'desc').first()) as Record<string, unknown> | undefined;
    return r ? memberFrom(r) : undefined;
  }

  /** Issues, keeps or revokes one person's member certificate to match their account and the tenant's setting. */
  async reconcileUser(tenantId: string, userId: string, reason: string): Promise<Record<string, unknown>> {
    if (!(await this.configured())) return { skipped: 'not configured' };
    const user = await this.s().users.get(tenantId, userId);
    if (!user || user.state !== 'active') return { revoked: await this.revokeFor(tenantId, userId, 'left') };
    if (!(await this.enabled(tenantId))) return { skipped: 'off' };
    if (await this.active(tenantId, userId)) return { kept: true };
    const m = await this.issueFor(tenantId, userId, reason);
    return { issued: m.id };
  }

  /** Issues a member certificate (and optionally a CA token) for an active account. */
  async issueFor(tenantId: string, userId: string, reason = 'joined'): Promise<MemberRow> {
    const pki = this.s().pki;
    const v = await pki.settings(tenantId);
    if (!v['members.profileId']) throw new PkiError(409, 'Member certificates need a client profile in Certificates › Settings.');
    const user = await this.s().users.get(tenantId, userId);
    const tenant = await this.s().tenants.byId(tenantId);
    if (!user || !tenant) throw new PkiError(404, 'User not found.');
    const issuer = await pki.activeIntermediate(tenantId);
    if (!issuer) throw new PkiError(409, 'This tenant has no active intermediate.');
    const by = this.by(tenantId);
    const profile: ProfileRow = await pki.issuableProfile(by, issuer, v['members.profileId']);
    if (profile.kind !== 'client') throw new PkiError(409, 'Member certificates are issued under a client profile.');
    const sans: San[] = v['members.san'] === 'email' ? (user.email ? [{ type: 'email', value: user.email }] : []) : [{ type: 'uri', value: MEMBER_URI(tenant.slug, user.id) }];
    if (!sans.length) throw new PkiError(422, `${user.username} has no email address to name the certificate by.`);
    const keyType = (['ec-p256', 'ec-p384', 'rsa-2048', 'rsa-3072', 'rsa-4096'] as CsrKeyType[]).find((k) => profile.policy.keyTypes.includes(k));
    if (!keyType) throw new PkiError(422, 'The client profile accepts no key type this server can make.');
    const kp = keyType.startsWith('ec-') ? generateKeyPairSync('ec', { namedCurve: keyType === 'ec-p256' ? 'prime256v1' : 'secp384r1' }) : generateKeyPairSync('rsa', { modulusLength: Number(keyType.slice(4)) });
    let out;
    try {
      out = await pki.issueKey(by, issuer, profile, { spki: spkiOf(kp.publicKey), keyType, commonName: user.username.slice(0, 64), sans, keyGenerated: true });
    } catch (err) {
      await this.audit(tenantId, 'pki.member.refused', { user: userId }, { reason: (err as Error).message, profile: profile.id });
      throw err;
    }
    // Expiry notices go to the member, as for a certificate they requested.
    await this.db('pki_certificates').where({ id: out.cert.id }).update({ requested_by: userId });
    const id = ulid();
    const keySealed = await this.s().keys.sealBytes(tenantId, kp.privateKey.export({ type: 'pkcs8', format: 'der' }), `pki-member:${id}`);
    let tokenId: string | null = null;
    let tokenSealed: string | null = null;
    if (v['members.withToken'] && (await this.s().caTokens.configured())) {
      const t = await this.s().caTokens.issue(by, { resource: { type: 'url', id: `${this.cfg.PUBLIC_URL.replace(/\/$/, '')}/api` }, permissions: ['read'], expiry: { kind: 'persistent' }, subject: userId, label: `Member token for ${user.username}` });
      tokenId = t.row.id;
      tokenSealed = await this.s().keys.seal(tenantId, t.token, `pki-member-token:${id}`);
    }
    const t = Date.now();
    const row = { id, tenant_id: tenantId, user_id: userId, certificate_id: out.cert.id, token_id: tokenId, state: 'active', key_sealed: keySealed, token_sealed: tokenSealed, picked_up_at: null, renewed_from: null, created_at: t, updated_at: t, revoked_at: null };
    await this.db('pki_member_certificates').insert(row);
    await this.audit(tenantId, 'pki.member.issued', { user: userId, certificate: out.cert.id, member: id }, { serial: out.cert.serial, notAfter: out.cert.not_after, san: v['members.san'], token: tokenId, reason });
    await this.s().notifications.notify({ tenantId, userIds: [userId], kind: 'pki.member.issued', title: 'Your client certificate is ready', body: 'Pick it up once under Settings › Certificates; it is kept for you until then.', route: 'settings', label: 'internal' }).catch(() => undefined);
    return memberFrom(row);
  }

  /** Renews a member certificate with the same key; the old row is replaced and its certificate stays valid until it expires. */
  async renew(m: MemberRow): Promise<MemberRow> {
    const pki = this.s().pki;
    const cert = await pki.certificate(m.tenant_id, m.certificate_id);
    if (!cert) throw new PkiError(404, 'Certificate not found.');
    const out = await pki.renew(this.by(m.tenant_id), cert, {});
    await this.db('pki_certificates').where({ id: out.cert.id }).update({ requested_by: m.user_id });
    const id = ulid();
    const t = Date.now();
    // The sealed key (not picked up yet) moves to the new row under its own associated data.
    const key = m.key_sealed ? await this.s().keys.sealBytes(m.tenant_id, await this.s().keys.openBytes(m.tenant_id, m.key_sealed, `pki-member:${m.id}`), `pki-member:${id}`) : null;
    const token = m.token_sealed ? await this.s().keys.seal(m.tenant_id, await this.s().keys.open(m.tenant_id, m.token_sealed, `pki-member-token:${m.id}`), `pki-member-token:${id}`) : null;
    const row = { id, tenant_id: m.tenant_id, user_id: m.user_id, certificate_id: out.cert.id, token_id: m.token_id, state: 'active', key_sealed: key, token_sealed: token, picked_up_at: m.picked_up_at, renewed_from: m.id, created_at: t, updated_at: t, revoked_at: null };
    await this.db.transaction(async (trx) => {
      await trx('pki_member_certificates').where({ id: m.id }).update({ state: 'replaced', key_sealed: null, token_sealed: null, updated_at: t });
      await trx('pki_member_certificates').insert(row);
    });
    await this.audit(m.tenant_id, 'pki.member.renewed', { user: m.user_id, certificate: out.cert.id, member: id }, { renewedFrom: m.certificate_id, notAfter: out.cert.not_after });
    return memberFrom(row);
  }

  /** Revokes a person's member certificates and their CA tokens (they left, or the tenant is offboarded). */
  async revokeFor(tenantId: string, userId: string | null, why: 'left' | 'offboarded'): Promise<number> {
    if (!(await this.configured())) return 0;
    const q = this.db('pki_member_certificates').where({ tenant_id: tenantId }).whereIn('state', ['active', 'replaced']);
    if (userId) q.andWhere({ user_id: userId });
    const rows = ((await q) as Record<string, unknown>[]).map(memberFrom);
    const by = this.by(tenantId);
    let n = 0;
    for (const m of rows) {
      const cert = await this.s().pki.certificate(tenantId, m.certificate_id);
      await this.db('pki_member_certificates').where({ id: m.id }).update({ state: 'revoked', revoked_at: Date.now(), updated_at: Date.now(), key_sealed: null, token_sealed: null });
      if (cert && cert.state === 'valid') {
        await this.s().pki.revoke(by, cert, why === 'left' ? REASONS.affiliationChanged : REASONS.cessationOfOperation, null).catch((err: Error) => this.s().log.warn({ err: err.message, certificate: cert.id }, 'member certificate not revoked'));
        n++;
      }
      await this.audit(tenantId, 'pki.member.revoked', { user: m.user_id, certificate: m.certificate_id, member: m.id }, { reason: why });
    }
    const users = userId ? [userId] : [...new Set(rows.map((r) => r.user_id))];
    for (const u of users) await this.s().caTokens.revokeForSubject(by, u, why === 'left' ? 'member left' : 'tenant offboarded');
    return n;
  }

  /** Tenant offboarding: every member certificate of the tenant is revoked. */
  async revokeTenant(tenantId: string): Promise<number> {
    return this.revokeFor(tenantId, null, 'offboarded');
  }

  /** The sweep: issue what a join missed, renew what is due, revoke what belongs to people who left. */
  async sweep(now = Date.now()): Promise<{ issued: number; renewed: number; revoked: number; failed: number }> {
    const out = { issued: 0, renewed: 0, revoked: 0, failed: 0 };
    if (!(await this.configured())) return out;
    const tenants = ((await this.db('tenants').where({ state: 'active' }).select('id')) as { id: string }[]).map((t) => t.id);
    for (const tenantId of tenants) {
      const v = await this.s().pki.settings(tenantId);
      const rows = ((await this.db('pki_member_certificates').where({ tenant_id: tenantId, state: 'active' })) as Record<string, unknown>[]).map(memberFrom);
      for (const m of rows) {
        const user = await this.s().users.get(tenantId, m.user_id);
        if (!user || user.state !== 'active') {
          out.revoked += await this.revokeFor(tenantId, m.user_id, 'left');
          continue;
        }
        const cert = await this.s().pki.certificate(tenantId, m.certificate_id);
        if (!cert || cert.state !== 'valid') continue;
        if (v['members.enabled'] && cert.not_after - now <= v['members.renewDays'] * DAY) {
          try {
            await this.renew(m);
            out.renewed++;
          } catch (err) {
            out.failed++;
            this.s().log.warn({ err: (err as Error).message, member: m.id }, 'member certificate not renewed');
          }
        }
      }
      if (!v['members.enabled']) continue;
      const have = new Set(rows.map((r) => r.user_id));
      const users = (await this.db('users').where({ tenant_id: tenantId, state: 'active' }).select('id')) as { id: string }[];
      for (const u of users) {
        if (have.has(u.id)) continue;
        try {
          await this.issueFor(tenantId, u.id, 'sweep');
          out.issued++;
        } catch (err) {
          out.failed++;
          this.s().log.warn({ err: (err as Error).message, user: u.id }, 'member certificate not issued');
        }
      }
    }
    return out;
  }

  // ---------- the member's own view ----------

  async mine(tenantId: string, userId: string): Promise<{ row: MemberRow; cert: CertRow | undefined }[]> {
    if (!(await this.configured())) return [];
    const rows = ((await this.db('pki_member_certificates').where({ tenant_id: tenantId, user_id: userId }).orderBy('created_at', 'desc').limit(20)) as Record<string, unknown>[]).map(memberFrom);
    return Promise.all(rows.map(async (row) => ({ row, cert: await this.s().pki.certificate(tenantId, row.certificate_id) })));
  }

  /** Hands over the key once, as a PKCS#12 file under the member's password, with the CA token if one came with it. */
  async pickup(by: PkiActor, id: string, password: string): Promise<{ pkcs12: Buffer; token: string | null; cert: CertRow }> {
    const r = (await this.db('pki_member_certificates').where({ id, tenant_id: by.tenantId, user_id: by.userId }).first()) as Record<string, unknown> | undefined;
    if (!r) throw new PkiError(404, 'Certificate not found.');
    const m = memberFrom(r);
    if (m.state !== 'active') throw new PkiError(409, `This certificate is ${m.state}.`);
    if (!m.key_sealed) throw new PkiError(409, 'The key for this certificate was already picked up; it is not kept here.');
    const n = await this.db('pki_member_certificates').where({ id, key_sealed: m.key_sealed }).update({ key_sealed: null, token_sealed: null, picked_up_at: Date.now(), updated_at: Date.now() });
    if (!n) throw new PkiError(409, 'The key for this certificate was already picked up.');
    const der = await this.s().keys.openBytes(by.tenantId, m.key_sealed, `pki-member:${m.id}`);
    const token = m.token_sealed ? await this.s().keys.open(by.tenantId, m.token_sealed, `pki-member-token:${m.id}`) : null;
    const cert = await this.s().pki.certificate(by.tenantId, m.certificate_id);
    if (!cert) throw new PkiError(404, 'Certificate not found.');
    const chain = await this.s().pki.chainOf(cert);
    const pkcs12 = buildPkcs12({ certificates: chain.map((p) => fromPem(p, 'CERTIFICATE')), privateKey: createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }), password, friendlyName: cert.common_name ?? cert.serial });
    await this.s().audit.append({ tenantId: by.tenantId, action: 'pki.member.picked_up', kind: 'auth', actor: by.actor, target: { member: m.id, certificate: m.certificate_id }, label: 'internal', detail: { token: !!token }, traceId: by.traceId ?? null });
    return { pkcs12, token, cert };
  }

  // ---------- certificate sign-in and mTLS ----------

  private trusted(addr: string | undefined): boolean {
    const spec = this.cfg.PKI_CLIENT_CERT_PROXIES;
    if (!spec.trim() || !addr) return false;
    if (!this.proxies || this.proxies.spec !== spec) {
      const list = new BlockList();
      for (const raw of spec.split(',').map((x) => x.trim()).filter(Boolean)) {
        const [a, len] = raw.split('/');
        const v = isIP(a ?? '');
        if (!v) continue;
        if (len === undefined) list.addAddress(a!, v === 4 ? 'ipv4' : 'ipv6');
        else list.addSubnet(a!, Number(len), v === 4 ? 'ipv4' : 'ipv6');
      }
      this.proxies = { spec, list };
    }
    const plain = addr.startsWith('::ffff:') && isIP(addr.slice(7)) === 4 ? addr.slice(7) : addr;
    const v = isIP(plain);
    return v !== 0 && this.proxies.list.check(plain, v === 4 ? 'ipv4' : 'ipv6');
  }

  /**
   * The client certificate a trusted TLS proxy forwarded. The peer is the socket's own address: X-Forwarded-For and
   * Express's `trust proxy` are not consulted, so a client cannot claim to be the proxy.
   */
  clientCertificate(req: Request): ClientCert {
    const raw = req.headers[this.cfg.PKI_CLIENT_CERT_HEADER.toLowerCase()];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value) return { kind: 'none' };
    if (!this.trusted(req.socket?.remoteAddress)) return { kind: 'refused', reason: 'untrusted-proxy' };
    const verified = req.headers[this.cfg.PKI_CLIENT_CERT_VERIFY_HEADER.toLowerCase()];
    if ((Array.isArray(verified) ? verified[0] : verified) !== 'SUCCESS') return { kind: 'refused', reason: 'not-verified' };
    try {
      let text = value.includes('%') ? decodeURIComponent(value) : value;
      // nginx's old $ssl_client_cert puts a tab at the start of each continued line.
      text = text.replace(/\t/g, '');
      if (!text.includes('BEGIN CERTIFICATE')) text = `-----BEGIN CERTIFICATE-----\n${text.replace(/\s+/g, '')}\n-----END CERTIFICATE-----\n`;
      if (text.length > 16_384) return { kind: 'refused', reason: 'unreadable' };
      return { kind: 'cert', cert: new X509Certificate(text) };
    } catch {
      return { kind: 'refused', reason: 'unreadable' };
    }
  }

  /** The account a client certificate signs in as, or why not. `use` is sign-in or mTLS (each a tenant choice). */
  async match(cert: X509Certificate, use: 'signIn' | 'mtls'): Promise<{ ok: true; match: MemberMatch } | { ok: false; reason: string; tenantId?: string }> {
    if (!(await this.configured())) return { ok: false, reason: 'not configured' };
    const fingerprint = createHash('sha256').update(cert.raw).digest('hex');
    const row = (await this.db('pki_certificates').where({ fingerprint }).first()) as Record<string, unknown> | undefined;
    if (!row) return { ok: false, reason: 'unknown certificate' };
    const tenantId = String(row.tenant_id);
    const certificate = await this.s().pki.certificate(tenantId, String(row.id));
    const now = Date.now();
    if (!certificate || certificate.state !== 'valid') return { ok: false, reason: 'certificate revoked', tenantId };
    if (certificate.not_before > now || certificate.not_after <= now) return { ok: false, reason: 'certificate expired', tenantId };
    const issuer = await this.s().pki.issuer(certificate.issuer_id);
    if (!issuer || issuer.state === 'revoked' || !cert.verify(createPublicKey(issuer.public_key_pem))) return { ok: false, reason: 'certificate does not chain to this CA', tenantId };
    const m = (await this.db('pki_member_certificates').where({ certificate_id: certificate.id, tenant_id: tenantId }).whereIn('state', ['active', 'replaced']).first()) as Record<string, unknown> | undefined;
    if (!m) return { ok: false, reason: 'not a member certificate', tenantId };
    const member = memberFrom(m);
    const v = await this.s().pki.settings(tenantId);
    if (!v['members.enabled'] || !(use === 'signIn' ? v['members.signIn'] : v['members.mtls'])) return { ok: false, reason: use === 'signIn' ? 'certificate sign-in is off' : 'mTLS is off', tenantId };
    const user = await this.s().users.get(tenantId, member.user_id);
    const tenant = await this.s().tenants.byId(tenantId);
    if (!user || user.state !== 'active' || !tenant || tenant.state !== 'active') return { ok: false, reason: 'account disabled', tenantId };
    // The SAN must still name this account: its URI, or (members.san email) its current email address.
    const names = (cert.subjectAltName ?? '').split(/,\s*/);
    const mapped = names.includes(`URI:${MEMBER_URI(tenant.slug, user.id)}`) || (!!user.email && names.some((x) => x.toLowerCase() === `email:${user.email!.toLowerCase()}`));
    if (!mapped) return { ok: false, reason: 'the certificate does not name this account', tenantId };
    return { ok: true, match: { tenantId, userId: user.id, member, certificate } };
  }
}
