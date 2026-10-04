import { BlockList, isIP } from 'node:net';
import { createHash, createPublicKey, X509Certificate } from 'node:crypto';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { AuditActor } from '../audit/chain.js';
import { json } from '../db/knex.js';
import { platformTenant } from '../ops/common.js';
import type { Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import { fromPem, pem } from './asn1.js';
import { CUSTODY_MESSAGE, PkiKeys, type KeyRef } from './keys.js';
import { MAX_OCSP_REQUESTS, OCSP_STATUS, ocspError, ocspResponse, OcspRequestError, parseOcspRequest, tbsResponseData, type SingleResponse, type SingleStatus } from './ocsp.js';
import { buildCertificate, certificateParts, CSR_KEY_TYPES, distinguishedName, KU, newSerial, OIDS, parseCsr, REASONS, reasonName, signed, spkiKeyBits, spkiOf, tbsCrl, type CsrKeyType, type IssuerKeyType, type San } from './x509.js';

/*
 * The certificate authority (B-1601 to B-1604).
 *
 *   platform root (tenant_id null, self-signed, pathLen unlimited)
 *     └─ one active intermediate per tenant (pathLen 0); a rotation adds a new one and retires the old
 *          ├─ end-entity certificates issued from CSRs under a profile's policy
 *          └─ a delegated OCSP responder certificate (id-kp-OCSPSigning, ocsp-nocheck, short-lived)
 *
 * No private key is ever in this process: issuer and responder keys live in the signer or OpenBao (`keys.ts`), and
 * every certificate, CRL and OCSP response is signed there over its DER to-be-signed bytes. Revocation uses RFC 5280
 * reason codes; CRLs are numbered per issuer and kept; OCSP answers (RFC 6960) are cached per instance until they
 * change (a revocation drops them on every instance through the bus) or their validity runs out.
 */

export const PKI_TOPIC = 'pki.changed';
const DAY = 86_400_000;
const BACKDATE_MS = 5 * 60_000;
const KEEP_CRLS = 50;

export const PROFILE_KINDS = ['server', 'client', 'code-signing'] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];
/** The longest lifetime each kind of profile may allow (server certificates follow the CA/Browser Forum's 398 days). */
export const PROFILE_MAX_DAYS: Record<ProfileKind, number> = { server: 398, client: 825, 'code-signing': 1185 };
const SAN_TYPES: Record<ProfileKind, readonly San['type'][]> = { server: ['dns', 'ip'], client: ['dns', 'ip', 'email', 'uri'], 'code-signing': ['email', 'uri'] };
const EKU: Record<ProfileKind, string> = { server: OIDS.serverAuth, client: OIDS.clientAuth, 'code-signing': OIDS.codeSigning };

const hostPattern = z.string().trim().toLowerCase().max(253).refine((p) => /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(p), 'a host name, or *.domain for every name below it');
const cidr = z.string().trim().max(64).refine((c) => {
  const [addr, len, extra] = c.split('/');
  const v = isIP(addr ?? '');
  const n = Number(len);
  return !extra && v !== 0 && Number.isInteger(n) && n >= 0 && n <= (v === 4 ? 32 : 128);
}, 'an address range such as 10.0.0.0/8');

export const policySchema = z
  .object({
    /** Host names allowed in dNSName SANs: exact names, or `*.example.com` for any name below example.com. */
    domains: z.array(hostPattern).max(200).default([]),
    /** Whether a SAN may itself be a wildcard (`*.example.com`); it must still fall under `domains`. */
    allowWildcard: z.boolean().default(false),
    ipRanges: z.array(cidr).max(100).default([]),
    emailDomains: z.array(hostPattern).max(100).default([]),
    uriPrefixes: z.array(z.string().trim().max(500).regex(/^[a-z][a-z0-9+.-]*:\/\/\S+$/i, 'a URI prefix such as spiffe://example.org/')).max(100).default([]),
    keyTypes: z.array(z.enum(CSR_KEY_TYPES as unknown as [CsrKeyType, ...CsrKeyType[]])).min(1).max(6).default(['ec-p256', 'ec-p384', 'rsa-2048', 'rsa-3072', 'rsa-4096'])
  })
  .strict();
export type ProfilePolicy = z.infer<typeof policySchema>;

export interface IssuerRow {
  id: string;
  tenant_id: string | null;
  parent_id: string | null;
  kind: 'root' | 'intermediate';
  name: string;
  organization: string | null;
  key_type: IssuerKeyType;
  custody: 'signer' | 'openbao';
  key_name: string;
  key_wrapped: string | null;
  public_key_pem: string;
  subject_der: string;
  serial: string;
  certificate_pem: string;
  generation: number;
  path_len: number | null;
  not_before: number;
  not_after: number;
  state: 'active' | 'retired' | 'revoked';
  revoked_at: number | null;
  revocation_reason: number | null;
  crl_number: number;
  replaced_by: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface ResponderRow {
  id: string;
  issuer_id: string;
  key_type: IssuerKeyType;
  custody: 'signer' | 'openbao';
  key_name: string;
  key_wrapped: string | null;
  serial: string;
  certificate_pem: string;
  not_before: number;
  not_after: number;
  created_at: number;
}

export interface ProfileRow {
  id: string;
  tenant_id: string;
  name: string;
  kind: ProfileKind;
  policy: ProfilePolicy;
  max_days: number;
  default_days: number;
  state: 'active' | 'disabled';
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface CertRow {
  id: string;
  tenant_id: string;
  issuer_id: string;
  profile_id: string | null;
  serial: string;
  common_name: string | null;
  sans: San[];
  key_type: string;
  not_before: number;
  not_after: number;
  certificate_pem: string;
  fingerprint: string;
  state: 'valid' | 'revoked';
  revoked_at: number | null;
  revocation_reason: number | null;
  invalidity_date: number | null;
  revoked_by: string | null;
  requested_by: string | null;
  created_at: number;
}

export interface CrlRow {
  id: string;
  issuer_id: string;
  number: number;
  this_update: number;
  next_update: number;
  entries: number;
  der: string;
  created_at: number;
}

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

const issuerFrom = (r: Record<string, unknown>): IssuerRow => ({ ...(r as unknown as IssuerRow), generation: num(r.generation), path_len: numOrNull(r.path_len), not_before: num(r.not_before), not_after: num(r.not_after), revoked_at: numOrNull(r.revoked_at), revocation_reason: numOrNull(r.revocation_reason), crl_number: num(r.crl_number), created_at: num(r.created_at), updated_at: num(r.updated_at) });
const responderFrom = (r: Record<string, unknown>): ResponderRow => ({ ...(r as unknown as ResponderRow), not_before: num(r.not_before), not_after: num(r.not_after), created_at: num(r.created_at) });
const profileFrom = (r: Record<string, unknown>): ProfileRow => ({ ...(r as unknown as ProfileRow), policy: policySchema.parse(json(r.policy, {})), max_days: num(r.max_days), default_days: num(r.default_days), created_at: num(r.created_at), updated_at: num(r.updated_at) });
const certFrom = (r: Record<string, unknown>): CertRow => ({ ...(r as unknown as CertRow), sans: json<San[]>(r.sans, []), not_before: num(r.not_before), not_after: num(r.not_after), revoked_at: numOrNull(r.revoked_at), revocation_reason: numOrNull(r.revocation_reason), invalidity_date: numOrNull(r.invalidity_date), created_at: num(r.created_at) });
const crlFrom = (r: Record<string, unknown>): CrlRow => ({ ...(r as unknown as CrlRow), number: num(r.number), this_update: num(r.this_update), next_update: num(r.next_update), entries: num(r.entries), created_at: num(r.created_at) });

const refOf = (r: { custody: 'signer' | 'openbao'; key_name: string; key_wrapped: string | null; key_type: IssuerKeyType }): KeyRef => ({ custody: r.custody, keyName: r.key_name, wrapped: r.key_wrapped, keyType: r.key_type });
const derOf = (certPem: string): Buffer => fromPem(certPem, 'CERTIFICATE');
const spkiFromPem = (publicPem: string): Buffer => spkiOf(createPublicKey(publicPem));

/** An error the routes turn into a problem with this status. */
export class PkiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extensions: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

export interface PkiActor {
  tenantId: string;
  userId: string | null;
  actor: AuditActor;
  traceId?: string | null;
}

interface IndexEntry {
  issuer: IssuerRow;
  sha1: { name: string; key: string };
  sha256: { name: string; key: string };
}

const hex = (alg: 'sha1' | 'sha256', b: Buffer): string => createHash(alg).update(b).digest('hex');

// ---------------------------------------------------------------------------------------------------------------
// Name policy

const DNS_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

function underPattern(name: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) return name.endsWith(pattern.slice(1)) && name.length > pattern.length - 1;
  return name === pattern;
}

/** Why a name is outside the profile's policy, or null when it is allowed. */
export function nameRefusal(kind: ProfileKind, policy: ProfilePolicy, n: San): string | null {
  if (!SAN_TYPES[kind].includes(n.type)) return `A ${kind} profile does not issue ${n.type} names.`;
  switch (n.type) {
    case 'dns': {
      const name = n.value.toLowerCase();
      if (name.length > 253 || !DNS_RE.test(name)) return `${n.value} is not a valid host name.`;
      if (name.startsWith('*.') && !policy.allowWildcard) return `${n.value}: this profile does not issue wildcard names.`;
      if (!policy.domains.some((p) => underPattern(name, p))) return `${n.value} is outside this profile's allowed domains.`;
      return null;
    }
    case 'ip': {
      const v = isIP(n.value);
      if (!v) return `${n.value} is not an IP address.`;
      const list = new BlockList();
      for (const r of policy.ipRanges) {
        const [addr, len] = r.split('/');
        const rv = isIP(addr!);
        list.addSubnet(addr!, Number(len), rv === 4 ? 'ipv4' : 'ipv6');
      }
      return list.check(n.value, v === 4 ? 'ipv4' : 'ipv6') ? null : `${n.value} is outside this profile's allowed address ranges.`;
    }
    case 'email': {
      const m = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@([A-Za-z0-9.-]{1,253})$/.exec(n.value);
      if (!m) return `${n.value} is not an email address.`;
      return policy.emailDomains.includes(m[1]!.toLowerCase()) ? null : `${n.value} is outside this profile's allowed email domains.`;
    }
    case 'uri': {
      if (!/^[\x21-\x7e]{1,500}$/.test(n.value)) return `${n.value} is not a URI.`;
      return policy.uriPrefixes.some((p) => n.value.startsWith(p)) ? null : `${n.value} is outside this profile's allowed URI prefixes.`;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------

export class PkiService {
  readonly keys: PkiKeys;
  /** OCSP answers for requests without a nonce, by request key. */
  private readonly ocspCache = new Map<string, { issuerId: string; der: Buffer; expires: number; maxAge: number }>();
  private index: { at: number; entries: IndexEntry[] } | null = null;
  private readonly responderFlight = new Map<string, Promise<ResponderRow>>();
  private readonly crlFlight = new Map<string, Promise<CrlRow | null>>();

  constructor(private readonly s: () => Services) {
    this.keys = new PkiKeys(() => this.s().kms, () => this.s().cfg.OPENBAO_KEY_PREFIX);
  }

  private get db() {
    return this.s().db;
  }

  private get cfg() {
    return this.s().cfg;
  }

  /** The base URL certificates point at for CRLs, OCSP and issuer certificates. */
  base(): string {
    return (this.cfg.PKI_PUBLIC_URL ?? this.cfg.PUBLIC_URL).replace(/\/$/, '');
  }

  crlUrl = (issuerId: string): string => `${this.base()}/pki/crl/${issuerId}.crl`;
  ocspUrl = (): string => `${this.base()}/pki/ocsp`;
  caUrl = (issuerId: string): string => `${this.base()}/pki/ca/${issuerId}.crt`;

  /** Drops this instance's cached OCSP answers and issuer index for an issuer, and tells the other instances. */
  changed(issuerId: string): void {
    this.s().bus.publish(PKI_TOPIC, { issuerId });
  }

  listen(): void {
    this.s().bus.on<{ issuerId?: string }>(PKI_TOPIC, ({ issuerId }) => {
      this.index = null;
      for (const [k, v] of this.ocspCache) if (!issuerId || v.issuerId === issuerId) this.ocspCache.delete(k);
    });
  }

  private audit(by: PkiActor, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>) {
    return this.s().audit.append({ tenantId: by.tenantId, action, kind: by.userId ? 'admin' : 'system', actor: by.actor, target, label: 'internal', ...(detail ? { detail } : {}), traceId: by.traceId ?? null });
  }

  private requireCustody(): void {
    if (!this.keys.custody()) throw new PkiError(409, CUSTODY_MESSAGE, { step: 'custody' });
  }

  // ---------- issuers ----------

  async issuer(id: string): Promise<IssuerRow | undefined> {
    const r = (await this.db('pki_issuers').where({ id }).first()) as Record<string, unknown> | undefined;
    return r ? issuerFrom(r) : undefined;
  }

  /** The platform roots and the tenant's own intermediates (every issuer for `all`). */
  async issuers(tenantId: string, all = false): Promise<IssuerRow[]> {
    const q = this.db('pki_issuers').orderBy('created_at', 'desc');
    if (!all) q.where((w) => w.whereNull('tenant_id').orWhere({ tenant_id: tenantId }));
    return ((await q) as Record<string, unknown>[]).map(issuerFrom);
  }

  async activeRoot(): Promise<IssuerRow | undefined> {
    const r = (await this.db('pki_issuers').where({ kind: 'root', state: 'active' }).orderBy('created_at', 'desc').first()) as Record<string, unknown> | undefined;
    return r ? issuerFrom(r) : undefined;
  }

  async activeIntermediate(tenantId: string): Promise<IssuerRow | undefined> {
    const r = (await this.db('pki_issuers').where({ kind: 'intermediate', state: 'active', tenant_id: tenantId }).orderBy('created_at', 'desc').first()) as Record<string, unknown> | undefined;
    return r ? issuerFrom(r) : undefined;
  }

  /** The certificates from an issuer up to its root (the issuer's own first). */
  async chain(issuer: IssuerRow): Promise<IssuerRow[]> {
    const out = [issuer];
    let cur = issuer;
    while (cur.parent_id && out.length < 4) {
      const p = await this.issuer(cur.parent_id);
      if (!p) break;
      out.push(p);
      cur = p;
    }
    return out;
  }

  private async signIssuerCertificate(o: { id: string; kind: 'root' | 'intermediate'; ref: KeyRef; spki: Buffer; subject: Buffer; parent: IssuerRow | null; days: number }): Promise<{ der: Buffer; serial: Buffer; notBefore: number; notAfter: number }> {
    const notBefore = Date.now() - BACKDATE_MS;
    let notAfter = notBefore + BACKDATE_MS + o.days * DAY;
    if (o.parent) {
      if (o.parent.not_after <= Date.now()) throw new PkiError(409, 'The root has expired; rotate it first.');
      notAfter = Math.min(notAfter, o.parent.not_after);
    }
    const serial = newSerial();
    const signerRef = o.parent ? refOf(o.parent) : o.ref;
    const der = await buildCertificate(
      {
        serial,
        issuerName: o.parent ? Buffer.from(o.parent.subject_der, 'base64') : o.subject,
        subjectName: o.subject,
        spki: o.spki,
        issuerSpki: o.parent ? spkiFromPem(o.parent.public_key_pem) : o.spki,
        notBefore,
        notAfter,
        keyType: signerRef.keyType,
        ca: { pathLen: o.kind === 'root' ? null : 0 },
        keyUsage: KU.keyCertSign | KU.cRLSign,
        ...(o.parent ? { crlUrl: this.crlUrl(o.parent.id), ocspUrl: this.ocspUrl(), caIssuersUrl: this.caUrl(o.parent.id) } : {})
      },
      (tbs) => this.keys.sign(signerRef, tbs)
    );
    // The certificate must verify under the signing key's public half before it is stored.
    const verifyKey = o.parent ? createPublicKey(o.parent.public_key_pem) : createPublicKey({ key: o.spki, format: 'der', type: 'spki' });
    if (!new X509Certificate(der).verify(verifyKey)) throw new PkiError(502, 'The key store returned a signature that does not verify.');
    return { der, serial, notBefore, notAfter };
  }

  /** Creates the platform root (B-1601). Only one root is active; a second needs a rotation. */
  async createRoot(by: PkiActor, o: { commonName: string; organization?: string | null; keyType: IssuerKeyType; days: number }): Promise<IssuerRow> {
    this.requireCustody();
    if (await this.activeRoot()) throw new PkiError(409, 'A root is already active; rotate it to replace it.');
    return this.makeIssuer(by, { kind: 'root', tenantId: null, parent: null, generation: 1, ...o });
  }

  /** Creates the tenant's issuing intermediate under the active root (B-1601). */
  async createIntermediate(by: PkiActor, tenantId: string, o: { commonName?: string | null; organization?: string | null; keyType: IssuerKeyType; days: number }): Promise<IssuerRow> {
    this.requireCustody();
    const root = await this.activeRoot();
    if (!root) throw new PkiError(409, 'There is no active root; a system admin creates one first.');
    if (await this.activeIntermediate(tenantId)) throw new PkiError(409, 'This tenant already has an active intermediate; rotate it to replace it.');
    const tenant = await this.s().tenants.byId(tenantId);
    return this.makeIssuer(by, { kind: 'intermediate', tenantId, parent: root, generation: 1, keyType: o.keyType, days: o.days, commonName: o.commonName || `${tenant?.name ?? 'Tenant'} Issuing CA`, organization: o.organization ?? tenant?.name ?? null });
  }

  private async makeIssuer(by: PkiActor, o: { kind: 'root' | 'intermediate'; tenantId: string | null; parent: IssuerRow | null; generation: number; commonName: string; organization?: string | null; keyType: IssuerKeyType; days: number }): Promise<IssuerRow> {
    const id = ulid();
    const { ref, publicKey } = await this.keys.create(id, o.keyType);
    const spki = spkiOf(publicKey);
    const subject = distinguishedName(o.commonName, o.organization ?? null);
    const c = await this.signIssuerCertificate({ id, kind: o.kind, ref, spki, subject, parent: o.parent, days: o.days });
    const t = Date.now();
    const row = {
      id,
      tenant_id: o.tenantId,
      parent_id: o.parent?.id ?? null,
      kind: o.kind,
      name: o.commonName,
      organization: o.organization ?? null,
      key_type: o.keyType,
      custody: ref.custody,
      key_name: ref.keyName,
      key_wrapped: ref.wrapped,
      public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      subject_der: subject.toString('base64'),
      serial: c.serial.toString('hex'),
      certificate_pem: pem(c.der, 'CERTIFICATE'),
      generation: o.generation,
      path_len: o.kind === 'root' ? null : 0,
      not_before: c.notBefore,
      not_after: c.notAfter,
      state: 'active',
      revoked_at: null,
      revocation_reason: null,
      crl_number: 0,
      replaced_by: null,
      created_by: by.userId,
      created_at: t,
      updated_at: t
    };
    await this.db('pki_issuers').insert(row);
    this.changed(id);
    await this.audit(by, o.kind === 'root' ? 'pki.root.created' : 'pki.intermediate.created', { issuer: id, tenant: o.tenantId }, { name: o.commonName, keyType: o.keyType, custody: ref.custody, serial: row.serial, notAfter: c.notAfter, parent: o.parent?.id ?? null, generation: o.generation });
    return issuerFrom(row);
  }

  /** A new key and certificate; the old issuer is retired (it keeps serving CRLs and OCSP for what it issued). */
  async rotate(by: PkiActor, issuer: IssuerRow, days: number): Promise<IssuerRow> {
    this.requireCustody();
    if (issuer.state !== 'active') throw new PkiError(409, 'Only an active issuer can be rotated.');
    const parent = issuer.kind === 'root' ? null : ((await this.activeRoot()) ?? null);
    if (issuer.kind === 'intermediate' && !parent) throw new PkiError(409, 'There is no active root to sign the new intermediate.');
    const next = await this.makeIssuer(by, { kind: issuer.kind, tenantId: issuer.tenant_id, parent, generation: issuer.generation + 1, commonName: issuer.name, organization: issuer.organization, keyType: issuer.key_type, days });
    await this.db('pki_issuers').where({ id: issuer.id, state: 'active' }).update({ state: 'retired', replaced_by: next.id, updated_at: Date.now() });
    this.changed(issuer.id);
    await this.audit(by, 'pki.issuer.rotated', { issuer: issuer.id, tenant: issuer.tenant_id }, { replacedBy: next.id, kind: issuer.kind });
    return next;
  }

  /** The same key with a new certificate (a new lifetime, or signed by the current root after a root rotation). */
  async reissue(by: PkiActor, issuer: IssuerRow, days: number): Promise<IssuerRow> {
    this.requireCustody();
    if (issuer.state === 'revoked') throw new PkiError(409, 'A revoked issuer cannot be re-issued.');
    const parent = issuer.kind === 'root' ? null : ((await this.activeRoot()) ?? null);
    if (issuer.kind === 'intermediate' && !parent) throw new PkiError(409, 'There is no active root to sign the intermediate.');
    const spki = spkiFromPem(issuer.public_key_pem);
    const subject = Buffer.from(issuer.subject_der, 'base64');
    const c = await this.signIssuerCertificate({ id: issuer.id, kind: issuer.kind, ref: refOf(issuer), spki, subject, parent, days });
    const patch = { certificate_pem: pem(c.der, 'CERTIFICATE'), serial: c.serial.toString('hex'), not_before: c.notBefore, not_after: c.notAfter, parent_id: parent?.id ?? null, updated_at: Date.now() };
    await this.db('pki_issuers').where({ id: issuer.id }).update(patch);
    this.changed(issuer.id);
    await this.audit(by, 'pki.issuer.reissued', { issuer: issuer.id, tenant: issuer.tenant_id }, { previousSerial: issuer.serial, serial: patch.serial, notAfter: c.notAfter, parent: patch.parent_id });
    return { ...issuer, ...patch };
  }

  /** Revokes an intermediate: it appears on its root's next CRL and stops issuing. */
  async revokeIssuer(by: PkiActor, issuer: IssuerRow, reason: number): Promise<IssuerRow> {
    if (issuer.kind === 'root') throw new PkiError(409, 'A root cannot be revoked; retire it by rotating and remove it from trust stores.');
    if (issuer.state === 'revoked') throw new PkiError(409, 'The issuer is already revoked.');
    const t = Date.now();
    await this.db('pki_issuers').where({ id: issuer.id }).update({ state: 'revoked', revoked_at: t, revocation_reason: reason, updated_at: t });
    this.changed(issuer.id);
    if (issuer.parent_id) {
      this.changed(issuer.parent_id);
      await this.enqueueCrl(issuer.parent_id, by.userId);
    }
    await this.audit(by, 'pki.issuer.revoked', { issuer: issuer.id, tenant: issuer.tenant_id }, { reason: reasonName(reason), serial: issuer.serial });
    return { ...issuer, state: 'revoked', revoked_at: t, revocation_reason: reason };
  }

  // ---------- profiles ----------

  async profiles(tenantId: string): Promise<ProfileRow[]> {
    return ((await this.db('pki_profiles').where({ tenant_id: tenantId }).orderBy('name')) as Record<string, unknown>[]).map(profileFrom);
  }

  async profile(tenantId: string, id: string): Promise<ProfileRow | undefined> {
    const r = (await this.db('pki_profiles').where({ tenant_id: tenantId, id }).first()) as Record<string, unknown> | undefined;
    return r ? profileFrom(r) : undefined;
  }

  private checkDays(kind: ProfileKind, maxDays: number, defaultDays: number): void {
    if (maxDays > PROFILE_MAX_DAYS[kind]) throw new PkiError(422, `A ${kind} profile allows at most ${PROFILE_MAX_DAYS[kind]} days.`);
    if (defaultDays > maxDays) throw new PkiError(422, 'The default lifetime is longer than the maximum.');
  }

  async createProfile(by: PkiActor, o: { name: string; kind: ProfileKind; policy: ProfilePolicy; maxDays: number; defaultDays: number }): Promise<ProfileRow> {
    this.checkDays(o.kind, o.maxDays, o.defaultDays);
    if (await this.db('pki_profiles').where({ tenant_id: by.tenantId, name: o.name }).first()) throw new PkiError(409, 'A profile with this name already exists.');
    const t = Date.now();
    const row = { id: ulid(), tenant_id: by.tenantId, name: o.name, kind: o.kind, policy: JSON.stringify(o.policy), max_days: o.maxDays, default_days: o.defaultDays, state: 'active', created_by: by.userId, created_at: t, updated_at: t };
    await this.db('pki_profiles').insert(row);
    await this.audit(by, 'pki.profile.created', { profile: row.id, name: o.name }, { kind: o.kind, policy: o.policy, maxDays: o.maxDays, defaultDays: o.defaultDays });
    return profileFrom(row);
  }

  async updateProfile(by: PkiActor, p: ProfileRow, patch: { policy?: ProfilePolicy; maxDays?: number; defaultDays?: number; state?: 'active' | 'disabled' }): Promise<ProfileRow> {
    const next = { ...p, policy: patch.policy ?? p.policy, max_days: patch.maxDays ?? p.max_days, default_days: patch.defaultDays ?? p.default_days, state: patch.state ?? p.state, updated_at: Date.now() };
    this.checkDays(p.kind, next.max_days, next.default_days);
    await this.db('pki_profiles').where({ id: p.id, tenant_id: by.tenantId }).update({ policy: JSON.stringify(next.policy), max_days: next.max_days, default_days: next.default_days, state: next.state, updated_at: next.updated_at });
    await this.audit(by, 'pki.profile.updated', { profile: p.id, name: p.name }, { before: { policy: p.policy, maxDays: p.max_days, defaultDays: p.default_days, state: p.state }, after: { policy: next.policy, maxDays: next.max_days, defaultDays: next.default_days, state: next.state } });
    return next;
  }

  async deleteProfile(by: PkiActor, p: ProfileRow): Promise<void> {
    await this.db('pki_profiles').where({ id: p.id, tenant_id: by.tenantId }).delete();
    await this.audit(by, 'pki.profile.deleted', { profile: p.id, name: p.name });
  }

  // ---------- issuance (B-1602) ----------

  async issue(by: PkiActor, issuer: IssuerRow, o: { csrPem: string; profileId: string; days?: number | undefined; sans?: San[] | undefined }): Promise<{ cert: CertRow; chain: string[]; clamped: boolean }> {
    if (issuer.kind !== 'intermediate' || issuer.tenant_id !== by.tenantId) throw new PkiError(404, 'Issuer not found.');
    if (issuer.state !== 'active') throw new PkiError(409, `This issuer is ${issuer.state}; certificates come from the tenant's active intermediate.`);
    if (issuer.not_after <= Date.now()) throw new PkiError(409, 'This issuer has expired; rotate it.');
    const profile = await this.profile(by.tenantId, o.profileId);
    if (!profile) throw new PkiError(404, 'Profile not found.');
    if (profile.state !== 'active') throw new PkiError(409, 'This profile is disabled.');

    let csr;
    try {
      csr = parseCsr(fromPem(o.csrPem, 'CERTIFICATE REQUEST', 'NEW CERTIFICATE REQUEST'));
    } catch (err) {
      throw new PkiError(400, (err as Error).message, { step: 'csr' });
    }
    if (!profile.policy.keyTypes.includes(csr.keyType)) throw new PkiError(422, `This profile does not accept ${csr.keyType} keys.`, { step: 'key' });

    const sans = dedupe(o.sans ?? (csr.sans.length ? csr.sans : profile.kind === 'server' && csr.commonName ? [{ type: 'dns', value: csr.commonName }] : []));
    if (profile.kind === 'server' && !sans.length) throw new PkiError(422, 'A server certificate needs at least one host name or address.', { step: 'names' });
    if (sans.length > 100) throw new PkiError(422, 'At most 100 names.', { step: 'names' });
    for (const n of sans) {
      const why = nameRefusal(profile.kind, profile.policy, n);
      if (why) {
        await this.audit(by, 'pki.issue.refused', { issuer: issuer.id, profile: profile.id }, { name: n, reason: why });
        throw new PkiError(422, why, { step: 'names', name: n });
      }
    }
    let commonName = csr.commonName;
    if (profile.kind === 'server') {
      if (commonName && !sans.some((n) => n.value.toLowerCase() === commonName!.toLowerCase())) throw new PkiError(422, `The common name ${commonName} is not among the certificate's names.`, { step: 'names' });
      commonName = commonName ?? sans[0]!.value;
    }
    if (profile.kind === 'code-signing' && !commonName) throw new PkiError(422, 'A code-signing request needs a common name.', { step: 'names' });
    if (!commonName && !sans.length) throw new PkiError(422, 'The request names no subject.', { step: 'names' });
    if (commonName && (commonName.length > 64 || [...commonName].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f))) throw new PkiError(422, 'The common name must be at most 64 printable characters.', { step: 'names' });

    const days = o.days ?? profile.default_days;
    if (days > profile.max_days) throw new PkiError(422, `This profile allows at most ${profile.max_days} days.`, { step: 'lifetime' });
    const notBefore = Date.now() - BACKDATE_MS;
    const wanted = notBefore + BACKDATE_MS + days * DAY;
    const notAfter = Math.min(wanted, issuer.not_after);

    const rsa = csr.keyType.startsWith('rsa-');
    const serial = newSerial();
    const der = await buildCertificate(
      {
        serial,
        issuerName: Buffer.from(issuer.subject_der, 'base64'),
        subjectName: commonName ? distinguishedName(commonName) : Buffer.from([0x30, 0x00]),
        spki: csr.spki,
        issuerSpki: spkiFromPem(issuer.public_key_pem),
        notBefore,
        notAfter,
        keyType: issuer.key_type,
        keyUsage: KU.digitalSignature | (rsa && profile.kind !== 'code-signing' ? KU.keyEncipherment : 0),
        extKeyUsage: [EKU[profile.kind]],
        sans,
        crlUrl: this.crlUrl(issuer.id),
        ocspUrl: this.ocspUrl(),
        caIssuersUrl: this.caUrl(issuer.id)
      },
      (tbs) => this.keys.sign(refOf(issuer), tbs)
    );
    if (!new X509Certificate(der).verify(createPublicKey(issuer.public_key_pem))) throw new PkiError(502, 'The key store returned a signature that does not verify.');
    const t = Date.now();
    const row = {
      id: ulid(),
      tenant_id: by.tenantId,
      issuer_id: issuer.id,
      profile_id: profile.id,
      serial: serial.toString('hex'),
      common_name: commonName,
      sans: JSON.stringify(sans),
      key_type: csr.keyType,
      not_before: notBefore,
      not_after: notAfter,
      certificate_pem: pem(der, 'CERTIFICATE'),
      fingerprint: createHash('sha256').update(der).digest('hex'),
      state: 'valid',
      revoked_at: null,
      revocation_reason: null,
      invalidity_date: null,
      revoked_by: null,
      requested_by: by.userId,
      created_at: t
    };
    await this.db('pki_certificates').insert(row);
    await this.audit(by, 'pki.certificate.issued', { certificate: row.id, issuer: issuer.id, profile: profile.id }, { serial: row.serial, commonName, sans, keyType: csr.keyType, notAfter, fingerprint: row.fingerprint });
    const chain = (await this.chain(issuer)).map((i) => i.certificate_pem);
    return { cert: certFrom(row), chain, clamped: notAfter < wanted };
  }

  async certificates(tenantId: string, o: { issuerId?: string | undefined; state?: 'valid' | 'revoked' | undefined; limit: number; before?: number | undefined }): Promise<CertRow[]> {
    const q = this.db('pki_certificates').where({ tenant_id: tenantId });
    if (o.issuerId) q.andWhere({ issuer_id: o.issuerId });
    if (o.state) q.andWhere({ state: o.state });
    if (o.before) q.andWhere('created_at', '<', o.before);
    return ((await q.orderBy('created_at', 'desc').limit(o.limit)) as Record<string, unknown>[]).map(certFrom);
  }

  async certificate(tenantId: string, id: string): Promise<CertRow | undefined> {
    const r = (await this.db('pki_certificates').where({ tenant_id: tenantId, id }).first()) as Record<string, unknown> | undefined;
    return r ? certFrom(r) : undefined;
  }

  // ---------- revocation and CRLs (B-1603) ----------

  async revoke(by: PkiActor, cert: CertRow, reason: number, invalidityDate: number | null): Promise<CertRow> {
    if (cert.state === 'revoked') throw new PkiError(409, 'The certificate is already revoked.');
    if (reason === REASONS.cACompromise) throw new PkiError(422, 'cACompromise applies to issuers, not to end-entity certificates.');
    const t = Date.now();
    const n = await this.db('pki_certificates').where({ id: cert.id, tenant_id: by.tenantId, state: 'valid' }).update({ state: 'revoked', revoked_at: t, revocation_reason: reason, invalidity_date: invalidityDate, revoked_by: by.userId });
    if (!n) throw new PkiError(409, 'The certificate is already revoked.');
    this.changed(cert.issuer_id);
    const job = await this.enqueueCrl(cert.issuer_id, by.userId);
    await this.audit(by, 'pki.certificate.revoked', { certificate: cert.id, issuer: cert.issuer_id }, { serial: cert.serial, reason: reasonName(reason), invalidityDate, crlJob: job });
    return { ...cert, state: 'revoked', revoked_at: t, revocation_reason: reason, invalidity_date: invalidityDate, revoked_by: by.userId };
  }

  private async jobTenant(issuer: { tenant_id: string | null }): Promise<string | null> {
    return issuer.tenant_id ?? (await platformTenant(this.s()));
  }

  /** Queues a CRL for the issuer (the revocation that asked for it shows on it). */
  async enqueueCrl(issuerId: string, userId: string | null): Promise<string | null> {
    const issuer = await this.issuer(issuerId);
    if (!issuer) return null;
    const tenantId = await this.jobTenant(issuer);
    if (!tenantId) return null;
    const job = await this.s().jobs.enqueue({ tenantId, type: 'pki.crl', payload: { issuerId }, createdBy: userId, maxAttempts: 3 });
    return job.id;
  }

  async crls(issuerId: string, limit = 20): Promise<CrlRow[]> {
    return ((await this.db('pki_crls').where({ issuer_id: issuerId }).orderBy('number', 'desc').limit(limit)) as Record<string, unknown>[]).map(crlFrom);
  }

  /** What the issuer's CRL lists: its revoked certificates (not yet expired) and revoked child issuers. */
  private async revokedUnder(issuer: IssuerRow, now: number): Promise<{ serial: Buffer; revokedAt: number; reason: number; invalidityDate: number | null }[]> {
    const leaves = (await this.db('pki_certificates').where({ issuer_id: issuer.id, state: 'revoked' }).andWhere('not_after', '>', now).select('serial', 'revoked_at', 'revocation_reason', 'invalidity_date')) as Record<string, unknown>[];
    const children = (await this.db('pki_issuers').where({ parent_id: issuer.id, state: 'revoked' }).andWhere('not_after', '>', now).select('serial', 'revoked_at', 'revocation_reason')) as Record<string, unknown>[];
    return [...leaves, ...children]
      .map((r) => ({ serial: Buffer.from(String(r.serial), 'hex'), revokedAt: num(r.revoked_at), reason: num(r.revocation_reason ?? 0), invalidityDate: numOrNull(r.invalidity_date) }))
      .sort((a, b) => a.revokedAt - b.revokedAt);
  }

  /** Signs the issuer's next CRL with the next number and stores it. Null when the issuer has expired or is revoked. */
  async generateCrl(issuerId: string): Promise<CrlRow | null> {
    let issuer = await this.issuer(issuerId);
    if (!issuer || issuer.state === 'revoked' || issuer.not_after <= Date.now()) return null;
    // The number is claimed with a compare-and-set, so two instances never sign the same number.
    let number = 0;
    for (let i = 0; i < 20; i++) {
      const cur = issuer.crl_number;
      const n = await this.db('pki_issuers').where({ id: issuerId, crl_number: cur }).update({ crl_number: cur + 1 });
      if (n === 1) {
        number = cur + 1;
        break;
      }
      issuer = (await this.issuer(issuerId))!;
    }
    if (!number) throw new Error('Could not claim a CRL number');
    const now = Date.now();
    const thisUpdate = now;
    const nextUpdate = Math.min(now + this.cfg.PKI_CRL_VALIDITY_HOURS * 3_600_000, issuer.not_after);
    const entries = await this.revokedUnder(issuer, now);
    const tbs = tbsCrl({ issuerName: Buffer.from(issuer.subject_der, 'base64'), issuerSpki: spkiFromPem(issuer.public_key_pem), keyType: issuer.key_type, thisUpdate, nextUpdate, number, entries });
    const ref = refOf(issuer);
    const der = await signed(tbs, issuer.key_type, (b) => this.keys.sign(ref, b));
    const row = { id: ulid(), issuer_id: issuerId, number, this_update: thisUpdate, next_update: nextUpdate, entries: entries.length, der: der.toString('base64'), created_at: now };
    await this.db('pki_crls').insert(row);
    const old = (await this.db('pki_crls').where({ issuer_id: issuerId }).orderBy('number', 'desc').offset(KEEP_CRLS).limit(1000).select('id')) as { id: string }[];
    if (old.length) await this.db('pki_crls').whereIn('id', old.map((o) => o.id)).delete();
    return crlFrom(row);
  }

  /** The CRL the public endpoint serves: the latest, or a fresh one when there is none yet or it is past nextUpdate. */
  async currentCrl(issuerId: string): Promise<CrlRow | null> {
    const latest = (await this.crls(issuerId, 1))[0];
    if (latest && latest.next_update > Date.now()) return latest;
    const running = this.crlFlight.get(issuerId);
    if (running) return running;
    const p = this.generateCrl(issuerId)
      .then((r) => r ?? latest ?? null)
      .finally(() => this.crlFlight.delete(issuerId));
    this.crlFlight.set(issuerId, p);
    return p;
  }

  registerJobs(): void {
    this.s().jobs.register('pki.crl', async (p) => {
      const issuerId = String(p.issuerId ?? '');
      const crl = await this.generateCrl(issuerId);
      if (crl) {
        const issuer = await this.issuer(issuerId);
        // Keep a delegated OCSP responder ready, so the first OCSP request does not wait for one.
        if (issuer && issuer.state !== 'revoked') await this.responder(issuer).catch((err: Error) => this.s().log.warn({ err: err.message, issuer: issuerId }, 'OCSP responder not renewed'));
      }
      return crl ? { issuer: issuerId, number: crl.number, entries: crl.entries } : { issuer: issuerId, skipped: 'expired or revoked' };
    });
    this.listen();
  }

  schedule(scheduler: Scheduler): void {
    scheduler.every('pki.crl', this.cfg.PKI_CRL_MINUTES * 60_000, async () => {
      const rows = ((await this.db('pki_issuers').whereIn('state', ['active', 'retired']).andWhere('not_after', '>', Date.now())) as Record<string, unknown>[]).map(issuerFrom);
      const platform = await platformTenant(this.s());
      return rows.filter((r) => r.tenant_id ?? platform).map((r) => ({ tenantId: (r.tenant_id ?? platform)!, payload: { issuerId: r.id }, key: r.id }));
    });
  }

  // ---------- OCSP (B-1604) ----------

  private async issuerIndex(): Promise<IndexEntry[]> {
    if (this.index && Date.now() - this.index.at < 60_000) return this.index.entries;
    const rows = ((await this.db('pki_issuers')) as Record<string, unknown>[]).map(issuerFrom);
    const entries = rows.map((issuer) => {
      const name = Buffer.from(issuer.subject_der, 'base64');
      const key = spkiKeyBits(spkiFromPem(issuer.public_key_pem));
      return { issuer, sha1: { name: hex('sha1', name), key: hex('sha1', key) }, sha256: { name: hex('sha256', name), key: hex('sha256', key) } };
    });
    this.index = { at: Date.now(), entries };
    return entries;
  }

  /** The issuer's current delegated responder, made (signed by the issuer) when there is none or it is a third from expiry. */
  async responder(issuer: IssuerRow): Promise<ResponderRow> {
    const life = this.cfg.PKI_OCSP_SIGNER_DAYS * DAY;
    const now = Date.now();
    const r = (await this.db('pki_responders').where({ issuer_id: issuer.id }).orderBy('not_after', 'desc').first()) as Record<string, unknown> | undefined;
    const current = r ? responderFrom(r) : undefined;
    const fresh = (x: ResponderRow) => x.not_after - now > Math.min(life, Math.max(0, issuer.not_after - x.not_before)) / 3 && x.not_before >= issuer.not_before - BACKDATE_MS;
    if (current && fresh(current)) return current;
    const running = this.responderFlight.get(issuer.id);
    if (running) return running;
    const p = this.makeResponder(issuer).finally(() => this.responderFlight.delete(issuer.id));
    this.responderFlight.set(issuer.id, p);
    return p;
  }

  private async makeResponder(issuer: IssuerRow): Promise<ResponderRow> {
    if (issuer.not_after <= Date.now()) throw new PkiError(409, 'The issuer has expired.');
    const id = ulid();
    const { ref, publicKey } = await this.keys.create(id, 'ecdsa-p256');
    const spki = spkiOf(publicKey);
    const notBefore = Date.now() - BACKDATE_MS;
    const notAfter = Math.min(notBefore + BACKDATE_MS + this.cfg.PKI_OCSP_SIGNER_DAYS * DAY, issuer.not_after);
    const serial = newSerial();
    const der = await buildCertificate(
      { serial, issuerName: Buffer.from(issuer.subject_der, 'base64'), subjectName: distinguishedName(`${issuer.name} OCSP Responder`.slice(0, 64), issuer.organization), spki, issuerSpki: spkiFromPem(issuer.public_key_pem), notBefore, notAfter, keyType: issuer.key_type, keyUsage: KU.digitalSignature, extKeyUsage: [OIDS.ocspSigning], ocspNoCheck: true },
      (tbs) => this.keys.sign(refOf(issuer), tbs)
    );
    const row = { id, issuer_id: issuer.id, key_type: 'ecdsa-p256' as const, custody: ref.custody, key_name: ref.keyName, key_wrapped: ref.wrapped, serial: serial.toString('hex'), certificate_pem: pem(der, 'CERTIFICATE'), not_before: notBefore, not_after: notAfter, created_at: Date.now() };
    await this.db('pki_responders').insert(row);
    const tenantId = await this.jobTenant(issuer);
    if (tenantId) await this.audit({ tenantId, userId: null, actor: { service: 'pki' } }, 'pki.responder.issued', { issuer: issuer.id, responder: id }, { serial: row.serial, notAfter });
    return row;
  }

  private async status(issuer: IssuerRow, serialHex: string): Promise<SingleStatus> {
    const leaf = (await this.db('pki_certificates').where({ issuer_id: issuer.id, serial: serialHex }).first('state', 'revoked_at', 'revocation_reason')) as Record<string, unknown> | undefined;
    const row = leaf ?? ((await this.db('pki_issuers').where({ parent_id: issuer.id, serial: serialHex }).first('state', 'revoked_at', 'revocation_reason')) as Record<string, unknown> | undefined);
    if (!row) return { status: 'unknown' };
    if (row.state === 'revoked') return { status: 'revoked', revokedAt: num(row.revoked_at), reason: numOrNull(row.revocation_reason) };
    return { status: 'good' };
  }

  /**
   * Answers an OCSP request (DER). Every CertID must name the same issuer; an issuer this CA does not know gets
   * `unauthorized`, a malformed request `malformedRequest`, and a key-store failure `internalError` (RFC 6960 2.3).
   */
  async ocsp(der: Buffer): Promise<{ body: Buffer; maxAge: number; cacheable: boolean }> {
    const fail = (status: number) => ({ body: ocspError(status), maxAge: 0, cacheable: false });
    let req;
    try {
      req = parseOcspRequest(der);
    } catch (err) {
      if (err instanceof OcspRequestError) return fail(OCSP_STATUS.malformedRequest);
      throw err;
    }
    const cacheKey = req.nonce ? null : createHash('sha256').update(Buffer.concat(req.certIds.map((c) => c.raw))).digest('hex');
    if (cacheKey) {
      const hit = this.ocspCache.get(cacheKey);
      if (hit && hit.expires > Date.now()) return { body: hit.der, maxAge: Math.max(0, Math.floor((hit.expires - Date.now()) / 1000)), cacheable: true };
    }
    const index = await this.issuerIndex();
    let issuer: IssuerRow | null = null;
    for (const c of req.certIds) {
      const e = index.find((x) => x[c.hash].name === c.nameHash.toString('hex') && x[c.hash].key === c.keyHash.toString('hex'));
      if (!e || (issuer && issuer.id !== e.issuer.id)) return fail(OCSP_STATUS.unauthorized);
      issuer = e.issuer;
    }
    if (!issuer || req.certIds.length > MAX_OCSP_REQUESTS) return fail(OCSP_STATUS.malformedRequest);
    try {
      const responder = await this.responder(issuer);
      const now = Date.now();
      const validity = this.cfg.PKI_OCSP_VALIDITY_MINUTES * 60_000;
      const responses: SingleResponse[] = [];
      for (const c of req.certIds) responses.push({ certId: c, status: await this.status(issuer, c.serial.toString('hex')), thisUpdate: now, nextUpdate: now + validity });
      const responderDer = derOf(responder.certificate_pem);
      const tbs = tbsResponseData({ responderKeyHash: createHash('sha1').update(spkiKeyBits(certificateParts(responderDer).spki)).digest(), producedAt: now, responses, nonce: req.nonce });
      const signature = await this.keys.sign(refOf(responder), tbs);
      const body = ocspResponse({ tbs, keyType: responder.key_type, signature, certs: [responderDer, derOf(issuer.certificate_pem)] });
      const maxAge = Math.min(this.cfg.PKI_OCSP_CACHE_SECONDS, Math.floor(validity / 1000));
      if (cacheKey && maxAge > 0) {
        if (this.ocspCache.size >= 10_000) this.ocspCache.delete(this.ocspCache.keys().next().value!);
        this.ocspCache.set(cacheKey, { issuerId: issuer.id, der: body, expires: now + maxAge * 1000, maxAge });
      }
      return { body, maxAge, cacheable: !!cacheKey };
    } catch (err) {
      this.s().log.warn({ err: (err as Error).message, issuer: issuer.id }, 'OCSP response not signed');
      return fail(OCSP_STATUS.internalError);
    }
  }

  /** How many OCSP answers this instance holds (tests and status). */
  get ocspCacheSize(): number {
    return this.ocspCache.size;
  }

  info(): { custody: string; crlMinutes: number; crlValidityHours: number; ocspValidityMinutes: number; ocspCacheSeconds: number; responderDays: number; baseUrl: string } {
    return { custody: this.keys.describe(), crlMinutes: this.cfg.PKI_CRL_MINUTES, crlValidityHours: this.cfg.PKI_CRL_VALIDITY_HOURS, ocspValidityMinutes: this.cfg.PKI_OCSP_VALIDITY_MINUTES, ocspCacheSeconds: this.cfg.PKI_OCSP_CACHE_SECONDS, responderDays: this.cfg.PKI_OCSP_SIGNER_DAYS, baseUrl: this.base() };
  }
}

function dedupe(list: San[]): San[] {
  const seen = new Set<string>();
  const out: San[] = [];
  for (const n of list) {
    const v = n.type === 'dns' || n.type === 'email' ? n.value.toLowerCase() : n.value;
    const k = `${n.type}:${v}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ type: n.type, value: v });
  }
  return out;
}

