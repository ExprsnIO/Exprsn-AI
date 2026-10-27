import { constants, createHash, createPublicKey, verify, X509Certificate } from 'node:crypto';
import { ulid } from 'ulid';
import { fromPem, pem } from './asn1.js';
import { CUSTODY_MESSAGE, type KeyRef } from './keys.js';
import { PkiError, type IssuerRow, type PkiActor } from './service.js';
import type { TokenExpiry, TokenSignature } from './settings.js';
import { buildCertificate, KU, newSerial, spkiOf, subjectName, type IssuerKeyType } from './x509.js';
import { platformTenant } from '../ops/common.js';
import type { Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';

/*
 * 1.9.0, Sprint 55 (B-188): CA tokens and one-time tickets.
 *
 * A CA token is a compact JWS signed in custody by the tenant's token-signing key: an end-entity certificate under
 * the tenant's intermediate, its key in the signer or OpenBao like every CA key, its algorithm ES256, ES384 or PS256
 * as Certificates › Settings says. The header names the signer (`kid`) and its certificate (`x5t#S256`); the chain is
 * public at /pki/tokens/<tenant>/keys, so a resource server can check a signature offline. The payload binds the
 * token to one resource (a URL, a DID or a CID) with permission bits:
 *
 *   { iss, jti, tid, sub?, res: { type, id }, perm: ["read", ...], iat, exp?, uses?, kind?: "ticket", act? }
 *
 * A token ends by time (`exp`), by uses (spent one at a time in one conditional update, so concurrent validations on
 * any number of instances never spend more than there is) or never (persistent: until it is revoked or its signer's
 * certificate ends). A ticket is a token good for one use of one named action. The server keeps only the token's id
 * and the SHA-256 of its text, never the token: it is shown once.
 *
 * Revoking the token-signing certificate (on the Certificates screen, or its intermediate) revokes every token it
 * signed. The signer rotates on a schedule (tokens.rotationDays) and whenever its intermediate is no longer the active
 * one; a retired signer keeps verifying what it signed.
 */

export const PERM_BITS = { read: 1, write: 2, append: 4, delete: 8, admin: 16 } as const;
export type TokenPermission = keyof typeof PERM_BITS;
export const TOKEN_PERMISSIONS = Object.keys(PERM_BITS) as TokenPermission[];
export const RESOURCE_TYPES = ['url', 'did', 'cid'] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

const ALGS: Record<TokenSignature, { alg: 'ES256' | 'ES384' | 'PS256'; keyType: IssuerKeyType }> = {
  'ecdsa-p256': { alg: 'ES256', keyType: 'ecdsa-p256' },
  'ecdsa-p384': { alg: 'ES384', keyType: 'ecdsa-p384' },
  'rsa-pss': { alg: 'PS256', keyType: 'rsa-3072' }
};
const DAY = 86_400_000;
const BACKDATE_MS = 5 * 60_000;
const MAX_TOKEN_TEXT = 16_384;
const OID_DOCUMENT_SIGNING = '1.3.6.1.5.5.7.3.36';
export const TICKET_MAX_MINUTES = 24 * 60;

export interface SignerRow {
  id: string;
  tenant_id: string;
  issuer_id: string;
  certificate_id: string;
  custody: 'signer' | 'openbao';
  key_name: string;
  key_wrapped: string | null;
  key_type: IssuerKeyType;
  alg: 'ES256' | 'ES384' | 'PS256';
  public_key_pem: string;
  certificate_pem: string;
  fingerprint: string;
  not_after: number;
  state: 'active' | 'retired';
  created_at: number;
  retired_at: number | null;
}

export interface TokenRow {
  id: string;
  tenant_id: string;
  signer_id: string;
  hash: string;
  kind: 'token' | 'ticket';
  resource_type: ResourceType;
  resource: string;
  permissions: number;
  action: string | null;
  subject: string | null;
  label: string | null;
  expiry: TokenExpiry;
  expires_at: number | null;
  max_uses: number | null;
  uses_left: number | null;
  size: number;
  state: 'active' | 'revoked' | 'spent' | 'replaced';
  revoked_at: number | null;
  revoked_reason: string | null;
  replaced_by: string | null;
  refreshed_from: string | null;
  created_by: string | null;
  created_at: number;
  last_used_at: number | null;
}

const n = (v: unknown) => Number(v);
const nn = (v: unknown) => (v == null ? null : Number(v));
const signerFrom = (r: Record<string, unknown>): SignerRow => ({ ...(r as unknown as SignerRow), not_after: n(r.not_after), created_at: n(r.created_at), retired_at: nn(r.retired_at) });
const tokenFrom = (r: Record<string, unknown>): TokenRow => ({ ...(r as unknown as TokenRow), permissions: n(r.permissions), expires_at: nn(r.expires_at), max_uses: nn(r.max_uses), uses_left: nn(r.uses_left), size: n(r.size), revoked_at: nn(r.revoked_at), created_at: n(r.created_at), last_used_at: nn(r.last_used_at) });
const refOf = (r: SignerRow): KeyRef => ({ custody: r.custody, keyName: r.key_name, wrapped: r.key_wrapped, keyType: r.key_type });

export const bitsOf = (perms: readonly TokenPermission[]): number => perms.reduce((a, p) => a | PERM_BITS[p], 0);
export const namesOf = (bits: number): TokenPermission[] => TOKEN_PERMISSIONS.filter((p) => (bits & PERM_BITS[p]) !== 0);
export const tokenHash = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');

/** Whether a resource is well formed for its type (a URL is http or https; a DID did:<method>:<id>; a CID v0 or base32 v1). */
export function resourceProblem(type: ResourceType, id: string): string | null {
  if (id.length > 500) return 'The resource is longer than 500 characters.';
  if (type === 'url') {
    try {
      const u = new URL(id);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'A URL resource is http or https.';
      if (u.username || u.password) return 'A URL resource carries no credentials.';
      return null;
    } catch {
      return 'The resource is not a URL.';
    }
  }
  if (type === 'did') return /^did:[a-z0-9]{1,32}:[A-Za-z0-9._:%-]{1,400}$/.test(id) ? null : 'The resource is not a DID (did:<method>:<id>).';
  return /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,400})$/.test(id) ? null : 'The resource is not a CID (CIDv0, or CIDv1 in base32).';
}

/** Whether the token's resource covers the one asked about: the same DID or CID, or the URL or a path below it. */
export function covers(type: ResourceType, bound: string, asked: { type: ResourceType; id: string }): boolean {
  if (asked.type !== type) return false;
  if (type !== 'url') return asked.id === bound;
  try {
    const a = new URL(asked.id);
    const b = new URL(bound);
    if (a.origin !== b.origin) return false;
    if (a.pathname === b.pathname) return !b.search || a.search === b.search;
    const base = b.pathname.endsWith('/') ? b.pathname : `${b.pathname}/`;
    return !b.search && a.pathname.startsWith(base);
  } catch {
    return false;
  }
}

export interface TokenView {
  id: string;
  kind: 'token' | 'ticket';
  resource: { type: ResourceType; id: string };
  permissions: TokenPermission[];
  action: string | null;
  subject: string | null;
  label: string | null;
  expiry: TokenExpiry;
  expiresAt: number | null;
  maxUses: number | null;
  usesLeft: number | null;
  size: number;
  state: TokenRow['state'];
  revokedAt: number | null;
  revokedReason: string | null;
  replacedBy: string | null;
  refreshedFrom: string | null;
  signerId: string;
  createdBy: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export const tokenView = (r: TokenRow): TokenView => ({
  id: r.id,
  kind: r.kind,
  resource: { type: r.resource_type, id: r.resource },
  permissions: namesOf(r.permissions),
  action: r.action,
  subject: r.subject,
  label: r.label,
  expiry: r.expiry,
  expiresAt: r.expires_at,
  maxUses: r.max_uses,
  usesLeft: r.uses_left,
  size: r.size,
  state: r.state,
  revokedAt: r.revoked_at,
  revokedReason: r.revoked_reason,
  replacedBy: r.replaced_by,
  refreshedFrom: r.refreshed_from,
  signerId: r.signer_id,
  createdBy: r.created_by,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at
});

export interface IssueInput {
  resource: { type: ResourceType; id: string };
  permissions: TokenPermission[];
  expiry?: { kind?: TokenExpiry | undefined; ttlMinutes?: number | undefined; uses?: number | undefined } | undefined;
  subject?: string | null | undefined;
  label?: string | null | undefined;
}

export type CheckResult = { active: true; row: TokenRow; claims: Record<string, unknown> } | { active: false; reason: string; row?: TokenRow };

export class CaTokens {
  private table: { ok: boolean; at: number } | null = null;
  private readonly flight = new Map<string, Promise<SignerRow>>();

  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
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
      ok = (await this.db.schema.hasTable('pki_tokens')) && (await this.db.schema.hasTable('pki_token_signers'));
    } catch {
      ok = false;
    }
    this.table = { ok, at: Date.now() };
    return ok;
  }

  private async requireTable(): Promise<void> {
    if (!(await this.configured())) throw new PkiError(409, 'CA tokens are not configured on this server yet (migration 128_ca_tokens has not run).', { step: 'tokens-table' });
  }

  private audit(by: PkiActor, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>) {
    return this.s().audit.append({ tenantId: by.tenantId, action, kind: by.userId ? 'admin' : 'system', actor: by.actor, target, label: 'internal', ...(detail ? { detail } : {}), traceId: by.traceId ?? null });
  }

  registerJobs(): void {
    this.s().jobs.register('pki.tokens.rotate', async () => this.rotateDue());
    // Revoking a signer's certificate, or the intermediate above it, ends every token that signer signed.
    this.s().pki.revokedListeners.push(async (e) => {
      if (!(await this.configured())) return;
      const q = this.db('pki_token_signers');
      if (e.certificate) q.where({ certificate_id: e.certificate.id });
      else if (e.issuer) q.where({ issuer_id: e.issuer.id });
      else return;
      const signers = ((await q) as Record<string, unknown>[]).map(signerFrom);
      for (const sg of signers) await this.endSigner({ ...e.by, tenantId: sg.tenant_id }, sg, e.certificate ? 'signer-revoked' : 'issuer-revoked');
    });
  }

  schedule(scheduler: Scheduler): void {
    scheduler.every('pki.tokens.rotate', 60 * 60_000, async () => {
      const platform = await platformTenant(this.s());
      return platform ? [{ tenantId: platform }] : [];
    });
  }

  // ---------- signers ----------

  async signers(tenantId: string): Promise<SignerRow[]> {
    if (!(await this.configured())) return [];
    return ((await this.db('pki_token_signers').where({ tenant_id: tenantId }).orderBy('created_at', 'desc').limit(50)) as Record<string, unknown>[]).map(signerFrom);
  }

  private async signerById(id: string): Promise<SignerRow | undefined> {
    const r = (await this.db('pki_token_signers').where({ id }).first()) as Record<string, unknown> | undefined;
    return r ? signerFrom(r) : undefined;
  }

  /** Why a signer should be replaced, or null while it is good to sign with. */
  private async staleReason(sg: SignerRow, issuer: IssuerRow | undefined, sig: TokenSignature, rotationDays: number): Promise<string | null> {
    const now = Date.now();
    if (!issuer || issuer.id !== sg.issuer_id) return 'the intermediate changed';
    if (sg.alg !== ALGS[sig].alg) return 'the signature setting changed';
    if (sg.not_after - now < 7 * DAY) return 'its certificate is about to expire';
    if (sg.created_at + rotationDays * DAY <= now) return 'scheduled rotation';
    const cert = (await this.db('pki_certificates').where({ id: sg.certificate_id }).first('state')) as { state: string } | undefined;
    if (cert?.state !== 'valid') return 'its certificate was revoked';
    return null;
  }

  /** The tenant's active signer, made under the active intermediate when there is none or it is due for rotation. */
  async signer(tenantId: string, by: PkiActor): Promise<SignerRow> {
    await this.requireTable();
    const v = await this.s().pki.settings(tenantId);
    const issuer = await this.s().pki.activeIntermediate(tenantId);
    if (!issuer) throw new PkiError(409, 'This tenant has no active intermediate to sign CA tokens; create one on the Certificates screen.', { step: 'issuer' });
    const r = (await this.db('pki_token_signers').where({ tenant_id: tenantId, state: 'active' }).orderBy('created_at', 'desc').first()) as Record<string, unknown> | undefined;
    const current = r ? signerFrom(r) : undefined;
    if (current && !(await this.staleReason(current, issuer, v['tokens.signature'], v['tokens.rotationDays']))) return current;
    const running = this.flight.get(tenantId);
    if (running) return running;
    const p = this.makeSigner(by, tenantId, issuer, v['tokens.signature'], current, current ? ((await this.staleReason(current, issuer, v['tokens.signature'], v['tokens.rotationDays'])) ?? 'rotation') : 'first token').finally(() => this.flight.delete(tenantId));
    this.flight.set(tenantId, p);
    return p;
  }

  private async makeSigner(by: PkiActor, tenantId: string, issuer: IssuerRow, sig: TokenSignature, previous: SignerRow | undefined, reason: string): Promise<SignerRow> {
    const pki = this.s().pki;
    if (!pki.keys.custody()) throw new PkiError(409, CUSTODY_MESSAGE, { step: 'custody' });
    const { alg, keyType } = ALGS[sig];
    const id = ulid();
    const { ref, publicKey } = await pki.keys.create(`tok-${id}`, keyType);
    const spki = spkiOf(publicKey);
    const now = Date.now();
    const notBefore = now - BACKDATE_MS;
    const notAfter = Math.min(notBefore + BACKDATE_MS + 398 * DAY, issuer.not_after);
    const serial = newSerial();
    const tenant = await this.s().tenants.byId(tenantId);
    const commonName = `${tenant?.name ?? 'Tenant'} CA token signer`.slice(0, 64);
    const der = await buildCertificate(
      { serial, issuerName: Buffer.from(issuer.subject_der, 'base64'), subjectName: subjectName(commonName, { O: issuer.organization }), spki, issuerSpki: spkiOf(createPublicKey(issuer.public_key_pem)), notBefore, notAfter, keyType: issuer.key_type, keyUsage: KU.digitalSignature, extKeyUsage: [OID_DOCUMENT_SIGNING], sans: [], crlUrl: pki.crlUrl(issuer.id), ocspUrl: pki.ocspUrl(), caIssuersUrl: pki.caUrl(issuer.id) },
      (tbs) => pki.keys.sign({ custody: issuer.custody, keyName: issuer.key_name, wrapped: issuer.key_wrapped, keyType: issuer.key_type }, tbs)
    );
    if (!new X509Certificate(der).verify(createPublicKey(issuer.public_key_pem))) throw new PkiError(502, 'The key store returned a signature that does not verify.');
    const certId = ulid();
    const fingerprint = createHash('sha256').update(der).digest('hex');
    const certificatePem = pem(der, 'CERTIFICATE');
    await this.db('pki_certificates').insert({ id: certId, tenant_id: tenantId, issuer_id: issuer.id, profile_id: null, serial: serial.toString('hex'), common_name: commonName, sans: '[]', key_type: keyType === 'rsa-3072' ? 'rsa-3072' : keyType === 'ecdsa-p384' ? 'ec-p384' : 'ec-p256', not_before: notBefore, not_after: notAfter, certificate_pem: certificatePem, fingerprint, state: 'valid', revoked_at: null, revocation_reason: null, invalidity_date: null, revoked_by: null, requested_by: null, created_at: now });
    const row: SignerRow = { id, tenant_id: tenantId, issuer_id: issuer.id, certificate_id: certId, custody: ref.custody, key_name: ref.keyName, key_wrapped: ref.wrapped, key_type: keyType, alg, public_key_pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), certificate_pem: certificatePem, fingerprint, not_after: notAfter, state: 'active', created_at: now, retired_at: null };
    await this.db('pki_token_signers').insert(row);
    if (previous) await this.db('pki_token_signers').where({ id: previous.id, state: 'active' }).update({ state: 'retired', retired_at: now });
    await this.audit({ ...by, tenantId }, 'pki.token.signer.rotated', { signer: id, certificate: certId, issuer: issuer.id }, { alg, custody: ref.custody, notAfter, previous: previous?.id ?? null, reason });
    return row;
  }

  /** Rotates the tenant's signer now (the old one keeps verifying what it signed). */
  async rotate(by: PkiActor): Promise<SignerRow> {
    await this.requireTable();
    const issuer = await this.s().pki.activeIntermediate(by.tenantId);
    if (!issuer) throw new PkiError(409, 'This tenant has no active intermediate to sign CA tokens.', { step: 'issuer' });
    const v = await this.s().pki.settings(by.tenantId);
    const r = (await this.db('pki_token_signers').where({ tenant_id: by.tenantId, state: 'active' }).orderBy('created_at', 'desc').first()) as Record<string, unknown> | undefined;
    return this.makeSigner(by, by.tenantId, issuer, v['tokens.signature'], r ? signerFrom(r) : undefined, 'rotated by an admin');
  }

  /** The scheduled rotation: every tenant's signer that is due. */
  async rotateDue(): Promise<{ rotated: number }> {
    if (!(await this.configured())) return { rotated: 0 };
    let rotated = 0;
    for (const r of (await this.db('pki_token_signers').where({ state: 'active' })) as Record<string, unknown>[]) {
      const sg = signerFrom(r);
      const v = await this.s().pki.settings(sg.tenant_id);
      const issuer = await this.s().pki.activeIntermediate(sg.tenant_id);
      const why = await this.staleReason(sg, issuer, v['tokens.signature'], v['tokens.rotationDays']);
      if (!why || !issuer || !this.s().pki.keys.custody()) continue;
      try {
        await this.makeSigner({ tenantId: sg.tenant_id, userId: null, actor: { service: 'pki' } }, sg.tenant_id, issuer, v['tokens.signature'], sg, why);
        rotated++;
      } catch (err) {
        this.s().log.warn({ err: (err as Error).message, tenant: sg.tenant_id }, 'CA token signer not rotated');
      }
    }
    return { rotated };
  }

  private async endSigner(by: PkiActor, sg: SignerRow, reason: string): Promise<void> {
    const t = Date.now();
    await this.db('pki_token_signers').where({ id: sg.id }).update({ state: 'retired', retired_at: sg.retired_at ?? t });
    const ended = await this.db('pki_tokens').where({ signer_id: sg.id, state: 'active' }).update({ state: 'revoked', revoked_at: t, revoked_reason: reason });
    await this.audit(by, 'pki.token.revoked.bulk', { signer: sg.id, certificate: sg.certificate_id }, { reason, tokens: Number(ended) });
  }

  // ---------- issuing ----------

  private async sign(sg: SignerRow, header: Record<string, unknown>, payload: Record<string, unknown>): Promise<string> {
    const input = `${b64u(header)}.${b64u(payload)}`;
    const data = Buffer.from(input, 'ascii');
    const sig = await this.s().pki.keys.signRaw(refOf(sg), data, sg.alg === 'PS256' ? { pss: true } : undefined);
    if (!verifyJwsSignature(sg.alg, data, sig, sg.public_key_pem)) throw new PkiError(502, sg.alg === 'PS256' ? 'The key store did not sign with RSA-PSS; the signer must run this release (restart it), or choose an ECDSA token signature.' : 'The key store returned a signature that does not verify.', { step: 'custody' });
    return `${input}.${sig.toString('base64url')}`;
  }

  private async mint(by: PkiActor, o: { kind: 'token' | 'ticket'; resource: { type: ResourceType; id: string }; permissions: number; action: string | null; subject: string | null; label: string | null; expiry: TokenExpiry; expiresAt: number | null; maxUses: number | null; refreshedFrom?: string | null }): Promise<{ token: string; row: TokenRow }> {
    const why = resourceProblem(o.resource.type, o.resource.id);
    if (why) throw new PkiError(422, why, { step: 'resource' });
    if (!o.permissions) throw new PkiError(422, 'Name at least one permission.', { step: 'permissions' });
    if (o.subject && !(await this.s().users.get(by.tenantId, o.subject))) throw new PkiError(422, 'The subject is not a user of this tenant.', { step: 'subject' });
    const v = await this.s().pki.settings(by.tenantId);
    const sg = await this.signer(by.tenantId, by);
    const tenant = await this.s().tenants.byId(by.tenantId);
    const id = ulid();
    const now = Date.now();
    const header = { alg: sg.alg, typ: 'exprsn-ca+jwt', kid: sg.id, 'x5t#S256': Buffer.from(sg.fingerprint, 'hex').toString('base64url') };
    const payload: Record<string, unknown> = {
      iss: `${this.s().pki.base()}/pki/tokens/${tenant?.slug ?? by.tenantId}`,
      jti: id,
      tid: by.tenantId,
      ...(o.subject ? { sub: o.subject } : {}),
      res: { type: o.resource.type, id: o.resource.id },
      perm: namesOf(o.permissions),
      iat: Math.floor(now / 1000),
      ...(o.expiresAt ? { exp: Math.floor(o.expiresAt / 1000) } : {}),
      ...(o.maxUses ? { uses: o.maxUses } : {}),
      ...(o.kind === 'ticket' ? { kind: 'ticket', act: o.action } : {})
    };
    const token = await this.sign(sg, header, payload);
    const size = Buffer.byteLength(token, 'utf8');
    if (size > v['tokens.maxBytes']) throw new PkiError(422, `The token would be ${size} bytes; this tenant allows at most ${v['tokens.maxBytes']}.`, { step: 'size' });
    const row = { id, tenant_id: by.tenantId, signer_id: sg.id, hash: tokenHash(token), kind: o.kind, resource_type: o.resource.type, resource: o.resource.id, permissions: o.permissions, action: o.action, subject: o.subject, label: o.label, expiry: o.expiry, expires_at: o.expiresAt, max_uses: o.maxUses, uses_left: o.maxUses, size, state: 'active', revoked_at: null, revoked_reason: null, replaced_by: null, refreshed_from: o.refreshedFrom ?? null, created_by: by.userId, created_at: now, last_used_at: null };
    await this.db('pki_tokens').insert(row);
    return { token, row: tokenFrom(row) };
  }

  /** Issues a token (B-188). The token is returned once; only its id and hash are kept. */
  async issue(by: PkiActor, input: IssueInput): Promise<{ token: string; row: TokenRow }> {
    await this.requireTable();
    const v = await this.s().pki.settings(by.tenantId);
    const kind = input.expiry?.kind ?? v['tokens.defaultExpiry'];
    const now = Date.now();
    let expiresAt: number | null = null;
    let maxUses: number | null = null;
    if (kind === 'time') expiresAt = now + (input.expiry?.ttlMinutes ?? v['tokens.defaultTtlMinutes']) * 60_000;
    if (kind === 'uses') {
      maxUses = input.expiry?.uses ?? v['tokens.defaultUses'];
      if (input.expiry?.ttlMinutes) expiresAt = now + input.expiry.ttlMinutes * 60_000;
    }
    if (kind === 'persistent' && (input.expiry?.ttlMinutes || input.expiry?.uses)) throw new PkiError(422, 'A persistent token has no lifetime or use limit.', { step: 'expiry' });
    const out = await this.mint(by, { kind: 'token', resource: input.resource, permissions: bitsOf(input.permissions), action: null, subject: input.subject ?? null, label: input.label ?? null, expiry: kind, expiresAt, maxUses });
    await this.audit(by, 'pki.token.issued', { token: out.row.id, signer: out.row.signer_id }, { resource: input.resource, permissions: input.permissions, expiry: kind, expiresAt, maxUses, subject: input.subject ?? null, size: out.row.size });
    return out;
  }

  /** A one-time ticket: good for one use of one action on one resource, for at most a day. */
  async ticket(by: PkiActor, input: { resource: { type: ResourceType; id: string }; permissions: TokenPermission[]; action: string; ttlMinutes?: number | undefined; subject?: string | null | undefined; label?: string | null | undefined }): Promise<{ token: string; row: TokenRow }> {
    await this.requireTable();
    const ttl = input.ttlMinutes ?? 15;
    if (ttl > TICKET_MAX_MINUTES) throw new PkiError(422, `A ticket lasts at most ${TICKET_MAX_MINUTES} minutes.`, { step: 'expiry' });
    const out = await this.mint(by, { kind: 'ticket', resource: input.resource, permissions: bitsOf(input.permissions), action: input.action, subject: input.subject ?? null, label: input.label ?? null, expiry: 'uses', expiresAt: Date.now() + ttl * 60_000, maxUses: 1 });
    await this.audit(by, 'pki.token.ticket.issued', { token: out.row.id, signer: out.row.signer_id }, { resource: input.resource, permissions: input.permissions, action: input.action, expiresAt: out.row.expires_at });
    return out;
  }

  // ---------- checking ----------

  /** Reads and checks a token of this tenant: its row by hash, its state and expiry, its signer and the signature. */
  async check(tenantId: string, token: string): Promise<CheckResult> {
    await this.requireTable();
    if (typeof token !== 'string' || token.length > MAX_TOKEN_TEXT || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return { active: false, reason: 'malformed' };
    const r = (await this.db('pki_tokens').where({ hash: tokenHash(token) }).first()) as Record<string, unknown> | undefined;
    const row = r ? tokenFrom(r) : undefined;
    if (!row || row.tenant_id !== tenantId) return { active: false, reason: 'unknown' };
    if (row.state !== 'active') return { active: false, reason: row.state === 'revoked' ? (row.revoked_reason ?? 'revoked') : row.state, row };
    const now = Date.now();
    if (row.expires_at !== null && row.expires_at <= now) return { active: false, reason: 'expired', row };
    if (row.max_uses !== null && (row.uses_left ?? 0) <= 0) return { active: false, reason: 'spent', row };
    const sg = await this.signerById(row.signer_id);
    if (!sg) return { active: false, reason: 'signer-unknown', row };
    const cert = (await this.db('pki_certificates').where({ id: sg.certificate_id }).first('state', 'not_after')) as { state: string; not_after: unknown } | undefined;
    const issuer = await this.s().pki.issuer(sg.issuer_id);
    if (!cert || cert.state !== 'valid' || !issuer || issuer.state === 'revoked') {
      await this.db('pki_tokens').where({ id: row.id, state: 'active' }).update({ state: 'revoked', revoked_at: now, revoked_reason: 'signer-revoked' });
      return { active: false, reason: 'signer-revoked', row };
    }
    if (Number(cert.not_after) <= now) return { active: false, reason: 'signer-expired', row };
    const [h, p, sig] = token.split('.') as [string, string, string];
    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as Record<string, unknown>;
      claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>;
    } catch {
      return { active: false, reason: 'malformed', row };
    }
    if (header.alg !== sg.alg || header.kid !== sg.id || !verifyJwsSignature(sg.alg, Buffer.from(`${h}.${p}`, 'ascii'), Buffer.from(sig, 'base64url'), sg.public_key_pem)) return { active: false, reason: 'bad-signature', row };
    if (claims.jti !== row.id || claims.tid !== tenantId) return { active: false, reason: 'claims-mismatch', row };
    return { active: true, row, claims };
  }

  /** Spends one use in one conditional update (`uses_left > 0`); a token at zero becomes `spent`. */
  private async spend(row: TokenRow): Promise<{ ok: boolean; left: number }> {
    const now = Date.now();
    const n = await this.db('pki_tokens').where({ id: row.id, state: 'active' }).andWhere('uses_left', '>', 0).update({ uses_left: this.db.raw('uses_left - 1'), last_used_at: now });
    const after = (await this.db('pki_tokens').where({ id: row.id }).first('uses_left')) as { uses_left: unknown } | undefined;
    const left = Math.max(0, Number(after?.uses_left ?? 0));
    if (n && left === 0) await this.db('pki_tokens').where({ id: row.id, state: 'active' }).update({ state: 'spent' });
    return { ok: n === 1, left };
  }

  /**
   * Validates a token for a use (B-188): active, signed by a live signer, bound to the resource asked about, holding
   * the permission, and for a ticket naming the action. A use-limited token or a ticket spends one use (unless
   * `spend` is false for a token; a ticket always spends).
   */
  async validate(by: PkiActor, token: string, ask: { resource?: { type: ResourceType; id: string } | undefined; permission?: TokenPermission | undefined; action?: string | undefined; spend?: boolean | undefined }): Promise<{ active: boolean; reason?: string; token?: TokenView; usesLeft?: number | null }> {
    const c = await this.check(by.tenantId, token);
    if (!c.active) return { active: false, reason: c.reason, ...(c.row ? { token: tokenView(c.row) } : {}) };
    const row = c.row;
    if (ask.resource && !covers(row.resource_type, row.resource, ask.resource)) return { active: false, reason: 'resource', token: tokenView(row) };
    if (ask.permission && (row.permissions & PERM_BITS[ask.permission]) === 0) return { active: false, reason: 'permission', token: tokenView(row) };
    if (row.kind === 'ticket' && ask.action !== row.action) return { active: false, reason: 'action', token: tokenView(row) };
    let usesLeft = row.uses_left;
    if (row.max_uses !== null && (row.kind === 'ticket' || ask.spend !== false)) {
      const spent = await this.spend(row);
      if (!spent.ok) return { active: false, reason: 'spent', token: tokenView({ ...row, uses_left: 0, state: 'spent' }) };
      usesLeft = spent.left;
      await this.audit(by, row.kind === 'ticket' ? 'pki.token.ticket.redeemed' : 'pki.token.used', { token: row.id }, { resource: { type: row.resource_type, id: row.resource }, permission: ask.permission ?? null, action: ask.action ?? null, usesLeft });
    } else await this.db('pki_tokens').where({ id: row.id }).update({ last_used_at: Date.now() });
    return { active: true, token: tokenView({ ...row, uses_left: usesLeft, state: usesLeft === 0 ? 'spent' : row.state }), usesLeft };
  }

  /** RFC 7662-style introspection: what the token is, without spending a use. */
  async introspect(by: PkiActor, token: string): Promise<Record<string, unknown>> {
    const c = await this.check(by.tenantId, token);
    if (!c.active) return { active: false, reason: c.reason };
    const r = c.row;
    return { active: true, jti: r.id, token_type: r.kind === 'ticket' ? 'ticket' : 'ca-token', iss: c.claims.iss, sub: r.subject, iat: Math.floor(r.created_at / 1000), exp: r.expires_at ? Math.floor(r.expires_at / 1000) : null, resource: { type: r.resource_type, id: r.resource }, permissions: namesOf(r.permissions), action: r.action, uses_left: r.uses_left, max_uses: r.max_uses, expiry: r.expiry, signer: r.signer_id };
  }

  /** Refreshes a token: a new one with the same binding, a fresh lifetime and the uses left, signed by the current signer; the old one is replaced. */
  async refresh(by: PkiActor, token: string): Promise<{ token: string; row: TokenRow }> {
    const c = await this.check(by.tenantId, token);
    if (!c.active) throw new PkiError(c.reason === 'unknown' || c.reason === 'malformed' ? 404 : 409, `This token cannot be refreshed: ${c.reason}.`, { step: 'refresh', reason: c.reason });
    const old = c.row;
    if (old.kind === 'ticket') throw new PkiError(409, 'A one-time ticket cannot be refreshed.', { step: 'refresh' });
    const now = Date.now();
    const life = old.expires_at !== null ? old.expires_at - old.created_at : null;
    const out = await this.mint(by, { kind: 'token', resource: { type: old.resource_type, id: old.resource }, permissions: old.permissions, action: null, subject: old.subject, label: old.label, expiry: old.expiry, expiresAt: life !== null ? now + life : null, maxUses: old.max_uses !== null ? old.uses_left : null, refreshedFrom: old.id });
    const n = await this.db('pki_tokens').where({ id: old.id, state: 'active' }).update({ state: 'replaced', replaced_by: out.row.id });
    if (!n) {
      await this.db('pki_tokens').where({ id: out.row.id }).update({ state: 'revoked', revoked_at: now, revoked_reason: 'refresh-raced' });
      throw new PkiError(409, 'This token was refreshed or revoked at the same time.', { step: 'refresh' });
    }
    await this.audit(by, 'pki.token.refreshed', { token: out.row.id, replaced: old.id }, { expiresAt: out.row.expires_at, usesLeft: out.row.uses_left });
    return out;
  }

  // ---------- listing and revoking ----------

  async list(tenantId: string, o: { state?: TokenRow['state'] | undefined; kind?: 'token' | 'ticket' | undefined; subject?: string | undefined; limit: number }): Promise<TokenRow[]> {
    if (!(await this.configured())) return [];
    const q = this.db('pki_tokens').where({ tenant_id: tenantId });
    if (o.state) q.andWhere({ state: o.state });
    if (o.kind) q.andWhere({ kind: o.kind });
    if (o.subject) q.andWhere({ subject: o.subject });
    return ((await q.orderBy('created_at', 'desc').limit(o.limit)) as Record<string, unknown>[]).map(tokenFrom);
  }

  async get(tenantId: string, id: string): Promise<TokenRow | undefined> {
    if (!(await this.configured())) return undefined;
    const r = (await this.db('pki_tokens').where({ tenant_id: tenantId, id }).first()) as Record<string, unknown> | undefined;
    return r ? tokenFrom(r) : undefined;
  }

  async revoke(by: PkiActor, id: string, reason: string | null): Promise<TokenRow> {
    await this.requireTable();
    const row = await this.get(by.tenantId, id);
    if (!row) throw new PkiError(404, 'Token not found.');
    if (row.state !== 'active') throw new PkiError(409, `This token is already ${row.state}.`);
    const t = Date.now();
    const n = await this.db('pki_tokens').where({ id, tenant_id: by.tenantId, state: 'active' }).update({ state: 'revoked', revoked_at: t, revoked_reason: reason ?? 'revoked' });
    if (!n) throw new PkiError(409, 'This token is no longer active.');
    await this.audit(by, 'pki.token.revoked', { token: id }, { reason: reason ?? null });
    return { ...row, state: 'revoked', revoked_at: t, revoked_reason: reason ?? 'revoked' };
  }

  /** Bulk revoke: by ids, by subject, by resource (a URL and what is below it), by signer, or every active token. */
  async revokeMany(by: PkiActor, f: { ids?: string[] | undefined; subject?: string | undefined; resource?: { type: ResourceType; id: string } | undefined; signerId?: string | undefined; all?: boolean | undefined; reason?: string | null | undefined }): Promise<{ revoked: number }> {
    await this.requireTable();
    if (!f.ids?.length && !f.subject && !f.resource && !f.signerId && !f.all) throw new PkiError(422, 'Name what to revoke: ids, a subject, a resource, a signer, or all.', { step: 'filter' });
    const q = this.db('pki_tokens').where({ tenant_id: by.tenantId, state: 'active' });
    if (f.ids?.length) q.whereIn('id', f.ids);
    if (f.subject) q.andWhere({ subject: f.subject });
    if (f.signerId) q.andWhere({ signer_id: f.signerId });
    let ids: string[];
    if (f.resource) {
      const rows = ((await q.clone().andWhere({ resource_type: f.resource.type }).select('*')) as Record<string, unknown>[]).map(tokenFrom);
      const asked = f.resource;
      ids = rows.filter((r) => r.resource === asked.id || covers(asked.type, asked.id, { type: r.resource_type, id: r.resource })).map((r) => r.id);
    } else ids = ((await q.clone().select('id')) as { id: string }[]).map((r) => r.id);
    let revoked = 0;
    const t = Date.now();
    for (let i = 0; i < ids.length; i += 500) revoked += Number(await this.db('pki_tokens').whereIn('id', ids.slice(i, i + 500)).andWhere({ tenant_id: by.tenantId, state: 'active' }).update({ state: 'revoked', revoked_at: t, revoked_reason: f.reason ?? 'bulk revoke' }));
    await this.audit(by, 'pki.token.revoked.bulk', { tenant: by.tenantId }, { filter: { ids: f.ids?.length ?? 0, subject: f.subject ?? null, resource: f.resource ?? null, signer: f.signerId ?? null, all: !!f.all }, reason: f.reason ?? null, tokens: revoked });
    return { revoked };
  }

  /** The public keys a resource server checks signatures with: every live signer's certificate chain (x5c, base64 DER). */
  async publicKeys(tenantId: string): Promise<{ kid: string; alg: string; state: string; notAfter: number; x5c: string[]; 'x5t#S256': string }[]> {
    if (!(await this.configured())) return [];
    const out = [];
    for (const sg of await this.signers(tenantId)) {
      const cert = (await this.db('pki_certificates').where({ id: sg.certificate_id }).first('state')) as { state: string } | undefined;
      if (cert?.state !== 'valid' || sg.not_after <= Date.now()) continue;
      const issuer = await this.s().pki.issuer(sg.issuer_id);
      const chain = issuer ? (await this.s().pki.chain(issuer)).map((i) => i.certificate_pem) : [];
      out.push({ kid: sg.id, alg: sg.alg, state: sg.state, notAfter: sg.not_after, x5c: [sg.certificate_pem, ...chain].map((p) => fromPem(p, 'CERTIFICATE').toString('base64')), 'x5t#S256': Buffer.from(sg.fingerprint, 'hex').toString('base64url') });
    }
    return out;
  }

  /** The tokens a member certificate came with, revoked when the member leaves. */
  async revokeForSubject(by: PkiActor, userId: string, reason: string): Promise<number> {
    if (!(await this.configured())) return 0;
    const n = await this.db('pki_tokens').where({ tenant_id: by.tenantId, subject: userId, state: 'active' }).update({ state: 'revoked', revoked_at: Date.now(), revoked_reason: reason });
    return Number(n);
  }
}

/** Checks a JWS signature: ES256 and ES384 as raw r||s, PS256 as RSASSA-PSS with SHA-256 and a 32-byte salt. */
export function verifyJwsSignature(alg: string, data: Buffer, sig: Buffer, publicKeyPem: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    if (alg === 'ES256') return sig.length === 64 && verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
    if (alg === 'ES384') return sig.length === 96 && verify('sha384', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
    if (alg === 'PS256') return verify('sha256', data, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, sig);
    return false;
  } catch {
    return false;
  }
}
