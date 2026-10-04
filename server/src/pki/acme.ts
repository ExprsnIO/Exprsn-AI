import { createHash, createHmac, randomBytes, timingSafeEqual, X509Certificate, type KeyObject } from 'node:crypto';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, request as httpRequest } from 'undici';
import { ulid } from 'ulid';
import type { AuditActor } from '../audit/chain.js';
import { json } from '../db/knex.js';
import { literalProblem, serviceAddressProblem, servicePolicy, type ServicePolicy } from '../platform/egress.js';
import type { Tenant } from '../repos/tenants.js';
import type { Services } from '../services.js';
import { AcmeProblem, type JsonWebKey, jwkOf, jwkThumbprint, keyForJwk, malformed, parseJws, verifyJws, type ParsedJws } from './jws.js';
import { PkiError, nameRefusal, type PkiActor, type ProfileRow } from './service.js';
import { certificateParts, CsrError, parseCsr, REASONS } from './x509.js';

/*
 * The ACME server (B-1605, RFC 8555). Each tenant has its own directory at `/pki/acme/<tenant slug>/directory`,
 * closed until a `pki:manage` holder opens it and names the server profile its orders are issued under.
 *
 *   account   one per JWK thumbprint per tenant; optional external account binding (keys made by the tenant admin)
 *   order     names that must all fall inside the profile's allowed names (policy is the upper bound) ...
 *   authz     ... and each one proven by http-01 or dns-01 (domain control: the lower bound)
 *   finalize  the CSR must name exactly the order's identifiers; issued by the tenant's active intermediate
 *
 * Every object is stored with its tenant and owning account, and every lookup filters on both: an account of one
 * tenant cannot see or act on another tenant's (or another account's) orders, authorizations or certificates, and a
 * `kid` naming another tenant's directory is refused. Validation runs as a job (`pki.acme.validate`) through the
 * service address checks (cloud metadata and link-local addresses refused; public addresses only when allowed).
 */

const DAY = 86_400_000;
const MAX_IDENTIFIERS = 100;
const MAX_PENDING_ORDERS = 300;
const HTTP_BODY_LIMIT = 8 * 1024;
const HTTP_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const CHALLENGE_TYPES = ['http-01', 'dns-01'] as const;
type ChallengeType = (typeof CHALLENGE_TYPES)[number];
/** RFC 8555 7.6 / RFC 5280: the reasons a subscriber may give (cACompromise is the CA's, not the subscriber's). */
const ACME_REASONS = new Set<number>([REASONS.unspecified, REASONS.keyCompromise, REASONS.affiliationChanged, REASONS.superseded, REASONS.cessationOfOperation, REASONS.privilegeWithdrawn]);

const DNS_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

export interface AcmeSettings {
  tenant_id: string;
  enabled: boolean;
  profile_id: string | null;
  eab_required: boolean;
  challenges: ChallengeType[];
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface AcmeAccount {
  id: string;
  tenant_id: string;
  thumbprint: string;
  jwk: JsonWebKey;
  contact: string[];
  status: 'valid' | 'deactivated' | 'revoked';
  eab_key_id: string | null;
  created_ip: string | null;
  created_at: number;
  updated_at: number;
}

export interface AcmeOrder {
  id: string;
  tenant_id: string;
  account_id: string;
  status: 'pending' | 'ready' | 'processing' | 'valid' | 'invalid';
  identifiers: { type: 'dns'; value: string }[];
  profile_id: string;
  expires_at: number;
  error: Record<string, unknown> | null;
  certificate_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface AcmeAuthz {
  id: string;
  tenant_id: string;
  account_id: string;
  order_id: string;
  identifier: string;
  wildcard: boolean;
  status: 'pending' | 'valid' | 'invalid' | 'deactivated' | 'expired' | 'revoked';
  expires_at: number;
  created_at: number;
  updated_at: number;
}

export interface AcmeChallenge {
  id: string;
  tenant_id: string;
  authz_id: string;
  type: ChallengeType;
  token: string;
  status: 'pending' | 'processing' | 'valid' | 'invalid';
  error: Record<string, unknown> | null;
  validated_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface EabKeyRow {
  id: string;
  tenant_id: string;
  name: string;
  state: 'active' | 'bound' | 'revoked';
  account_id: string | null;
  created_by: string | null;
  created_at: number;
  bound_at: number | null;
}

const n = (v: unknown): number => Number(v);
const nn = (v: unknown): number | null => (v == null ? null : Number(v));
const settingsFrom = (r: Record<string, unknown>): AcmeSettings => ({ ...(r as unknown as AcmeSettings), enabled: Boolean(r.enabled), eab_required: Boolean(r.eab_required), challenges: String(r.challenges ?? '').split(',').filter((c): c is ChallengeType => (CHALLENGE_TYPES as readonly string[]).includes(c)), created_at: n(r.created_at), updated_at: n(r.updated_at) });
const accountFrom = (r: Record<string, unknown>): AcmeAccount => ({ ...(r as unknown as AcmeAccount), jwk: json<JsonWebKey>(r.jwk, {}), contact: json<string[]>(r.contact, []), created_at: n(r.created_at), updated_at: n(r.updated_at) });
const orderFrom = (r: Record<string, unknown>): AcmeOrder => ({ ...(r as unknown as AcmeOrder), identifiers: json(r.identifiers, []), error: json<Record<string, unknown> | null>(r.error, null), expires_at: n(r.expires_at), created_at: n(r.created_at), updated_at: n(r.updated_at) });
const authzFrom = (r: Record<string, unknown>): AcmeAuthz => ({ ...(r as unknown as AcmeAuthz), wildcard: Boolean(r.wildcard), expires_at: n(r.expires_at), created_at: n(r.created_at), updated_at: n(r.updated_at) });
const challengeFrom = (r: Record<string, unknown>): AcmeChallenge => ({ ...(r as unknown as AcmeChallenge), error: json<Record<string, unknown> | null>(r.error, null), validated_at: nn(r.validated_at), created_at: n(r.created_at), updated_at: n(r.updated_at) });
const eabFrom = (r: Record<string, unknown>): EabKeyRow => ({ id: String(r.id), tenant_id: String(r.tenant_id), name: String(r.name), state: r.state as EabKeyRow['state'], account_id: (r.account_id as string | null) ?? null, created_by: (r.created_by as string | null) ?? null, created_at: n(r.created_at), bound_at: nn(r.bound_at) });

const iso = (ms: number): string => new Date(ms).toISOString();

/** The URLs of one tenant's directory. */
export interface AcmeUrls {
  directory: string;
  newNonce: string;
  newAccount: string;
  newOrder: string;
  revokeCert: string;
  keyChange: string;
  account(id: string): string;
  orders(id: string): string;
  order(id: string): string;
  finalize(id: string): string;
  authz(id: string): string;
  challenge(id: string): string;
  certificate(id: string): string;
}

export interface AcmeContext {
  tenant: Tenant;
  settings: AcmeSettings;
  urls: AcmeUrls;
}

/** What a route sends back: JSON, or a PEM chain, with Location and Link headers. */
export interface AcmeReply {
  status: number;
  body?: unknown;
  pem?: string;
  location?: string;
  links?: string[];
}

/** Replaceable parts of validation (tests point host lookups at loopback). */
export interface AcmeValidation {
  /** Every address a host resolves to (default: the system resolver). */
  resolveHost?: (host: string) => Promise<string[]>;
  /** The TXT strings at a name (default: PKI_ACME_DNS_SERVERS or the system resolver). */
  resolveTxt?: (name: string) => Promise<string[]>;
  /** The port http-01 is fetched from (default PKI_ACME_HTTP_PORT). */
  httpPort?: number;
}

export class AcmeServer {
  validation: AcmeValidation = {};

  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  private get cfg() {
    return this.s().cfg;
  }

  base(): string {
    return (this.cfg.PKI_ACME_URL ?? this.s().pki.base()).replace(/\/$/, '');
  }

  urls(slug: string): AcmeUrls {
    const b = `${this.base()}/pki/acme/${encodeURIComponent(slug)}`;
    return {
      directory: `${b}/directory`,
      newNonce: `${b}/new-nonce`,
      newAccount: `${b}/new-account`,
      newOrder: `${b}/new-order`,
      revokeCert: `${b}/revoke-cert`,
      keyChange: `${b}/key-change`,
      account: (id) => `${b}/acct/${id}`,
      orders: (id) => `${b}/acct/${id}/orders`,
      order: (id) => `${b}/order/${id}`,
      finalize: (id) => `${b}/order/${id}/finalize`,
      authz: (id) => `${b}/authz/${id}`,
      challenge: (id) => `${b}/chall/${id}`,
      certificate: (id) => `${b}/cert/${id}`
    };
  }

  private actor(ctx: AcmeContext, accountId?: string): PkiActor {
    const actor: AuditActor = { service: 'acme', ...(accountId ? { name: `account ${accountId}` } : {}) };
    return { tenantId: ctx.tenant.id, userId: null, actor };
  }

  private audit(tenantId: string, accountId: string | undefined, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>) {
    const actor: AuditActor = { service: 'acme', ...(accountId ? { name: `account ${accountId}` } : {}) };
    return this.s().audit.append({ tenantId, action, kind: 'system', actor, target, label: 'internal', ...(detail ? { detail } : {}) });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Settings and external account binding keys (the admin side, `pki:manage`)

  async settings(tenantId: string): Promise<AcmeSettings> {
    const r = (await this.db('pki_acme_settings').where({ tenant_id: tenantId }).first()) as Record<string, unknown> | undefined;
    return r ? settingsFrom(r) : { tenant_id: tenantId, enabled: false, profile_id: null, eab_required: false, challenges: [...CHALLENGE_TYPES], updated_by: null, created_at: 0, updated_at: 0 };
  }

  async updateSettings(by: PkiActor, patch: { enabled?: boolean | undefined; profileId?: string | null | undefined; eabRequired?: boolean | undefined; challenges?: ChallengeType[] | undefined }): Promise<AcmeSettings> {
    const before = await this.settings(by.tenantId);
    const next = { enabled: patch.enabled ?? before.enabled, profile_id: patch.profileId === undefined ? before.profile_id : patch.profileId, eab_required: patch.eabRequired ?? before.eab_required, challenges: patch.challenges ?? before.challenges };
    if (!next.challenges.length) throw new PkiError(422, 'Offer at least one challenge type.');
    if (next.profile_id) {
      const p = await this.s().pki.profile(by.tenantId, next.profile_id);
      if (!p) throw new PkiError(404, 'Profile not found.');
      if (p.kind !== 'server') throw new PkiError(422, 'ACME issues server certificates: choose a server profile.');
    }
    if (next.enabled && !next.profile_id) throw new PkiError(422, 'Choose the server profile ACME orders are issued under before opening the directory.');
    const t = Date.now();
    const row = { enabled: next.enabled, profile_id: next.profile_id, eab_required: next.eab_required, challenges: next.challenges.join(','), updated_by: by.userId, updated_at: t };
    const n0 = await this.db('pki_acme_settings').where({ tenant_id: by.tenantId }).update(row);
    if (!n0) await this.db('pki_acme_settings').insert({ tenant_id: by.tenantId, created_at: t, ...row });
    await this.s().audit.append({ tenantId: by.tenantId, action: 'pki.acme.settings.updated', kind: by.userId ? 'admin' : 'system', actor: by.actor, target: { tenant: by.tenantId }, label: 'internal', detail: { before: { enabled: before.enabled, profileId: before.profile_id, eabRequired: before.eab_required, challenges: before.challenges }, after: { enabled: next.enabled, profileId: next.profile_id, eabRequired: next.eab_required, challenges: next.challenges } }, traceId: by.traceId ?? null });
    return this.settings(by.tenantId);
  }

  async eabKeys(tenantId: string): Promise<EabKeyRow[]> {
    return ((await this.db('pki_acme_eab_keys').where({ tenant_id: tenantId }).orderBy('created_at', 'desc')) as Record<string, unknown>[]).map(eabFrom);
  }

  /** Makes an external account binding key. The MAC key is returned once and kept sealed with the tenant key. */
  async createEabKey(by: PkiActor, name: string): Promise<{ key: EabKeyRow; hmacKey: string }> {
    const id = ulid();
    const secret = randomBytes(32).toString('base64url');
    const t = Date.now();
    await this.db('pki_acme_eab_keys').insert({ id, tenant_id: by.tenantId, name, key_sealed: await this.s().keys.seal(by.tenantId, secret, `acme-eab:${id}`), state: 'active', account_id: null, created_by: by.userId, created_at: t, bound_at: null });
    await this.s().audit.append({ tenantId: by.tenantId, action: 'pki.acme.eab.created', kind: by.userId ? 'admin' : 'system', actor: by.actor, target: { eabKey: id, name }, label: 'internal', traceId: by.traceId ?? null });
    return { key: { id, tenant_id: by.tenantId, name, state: 'active', account_id: null, created_by: by.userId, created_at: t, bound_at: null }, hmacKey: secret };
  }

  async revokeEabKey(by: PkiActor, id: string): Promise<EabKeyRow> {
    const r = (await this.db('pki_acme_eab_keys').where({ tenant_id: by.tenantId, id }).first()) as Record<string, unknown> | undefined;
    if (!r) throw new PkiError(404, 'Key not found.');
    const k = eabFrom(r);
    if (k.state === 'revoked') throw new PkiError(409, 'The key is already revoked.');
    await this.db('pki_acme_eab_keys').where({ tenant_id: by.tenantId, id }).update({ state: 'revoked' });
    await this.s().audit.append({ tenantId: by.tenantId, action: 'pki.acme.eab.revoked', kind: by.userId ? 'admin' : 'system', actor: by.actor, target: { eabKey: id, name: k.name }, label: 'internal', detail: { boundAccount: k.account_id }, traceId: by.traceId ?? null });
    return { ...k, state: 'revoked' };
  }

  async accounts(tenantId: string): Promise<AcmeAccount[]> {
    return ((await this.db('pki_acme_accounts').where({ tenant_id: tenantId }).orderBy('created_at', 'desc').limit(1000)) as Record<string, unknown>[]).map(accountFrom);
  }

  async accountById(tenantId: string, id: string): Promise<AcmeAccount | undefined> {
    const r = (await this.db('pki_acme_accounts').where({ tenant_id: tenantId, id }).first()) as Record<string, unknown> | undefined;
    return r ? accountFrom(r) : undefined;
  }

  /** An administrator revokes an account (RFC 8555 `revoked`: by the server); its pending orders become invalid. */
  async revokeAccount(by: PkiActor, id: string): Promise<AcmeAccount> {
    const a = await this.accountById(by.tenantId, id);
    if (!a) throw new PkiError(404, 'Account not found.');
    if (a.status === 'revoked') throw new PkiError(409, 'The account is already revoked.');
    const t = Date.now();
    await this.db('pki_acme_accounts').where({ tenant_id: by.tenantId, id }).update({ status: 'revoked', updated_at: t });
    await this.db('pki_acme_orders').where({ tenant_id: by.tenantId, account_id: id }).whereIn('status', ['pending', 'ready']).update({ status: 'invalid', error: JSON.stringify({ type: 'urn:ietf:params:acme:error:unauthorized', detail: 'The account was revoked.' }), updated_at: t });
    await this.s().audit.append({ tenantId: by.tenantId, action: 'pki.acme.account.revoked', kind: by.userId ? 'admin' : 'system', actor: by.actor, target: { acmeAccount: id }, label: 'internal', traceId: by.traceId ?? null });
    return { ...a, status: 'revoked', updated_at: t };
  }

  async orders(tenantId: string, o: { accountId?: string | undefined; status?: string | undefined; limit: number }): Promise<AcmeOrder[]> {
    const q = this.db('pki_acme_orders').where({ tenant_id: tenantId });
    if (o.accountId) q.andWhere({ account_id: o.accountId });
    if (o.status) q.andWhere({ status: o.status });
    return ((await q.orderBy('created_at', 'desc').limit(o.limit)) as Record<string, unknown>[]).map(orderFrom);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Directory, nonces and request authentication

  /** The tenant's directory, when it is open. */
  async context(slug: string): Promise<AcmeContext> {
    const tenant = /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) ? await this.s().tenants.bySlug(slug) : undefined;
    const settings = tenant ? await this.settings(tenant.id) : undefined;
    if (!tenant || tenant.state !== 'active' || !settings?.enabled || !settings.profile_id) throw new AcmeProblem(404, 'malformed', 'There is no ACME directory here.');
    return { tenant, settings, urls: this.urls(slug) };
  }

  directory(ctx: AcmeContext): Record<string, unknown> {
    const u = ctx.urls;
    return { newNonce: u.newNonce, newAccount: u.newAccount, newOrder: u.newOrder, revokeCert: u.revokeCert, keyChange: u.keyChange, meta: { externalAccountRequired: ctx.settings.eab_required, website: this.s().cfg.PUBLIC_URL } };
  }

  async newNonce(): Promise<string> {
    const nonce = randomBytes(18).toString('base64url');
    await this.db('pki_acme_nonces').insert({ nonce, expires_at: Date.now() + this.cfg.PKI_ACME_NONCE_MINUTES * 60_000 });
    return nonce;
  }

  /** Consumes a nonce; true when it existed and had not expired (single use on every instance). */
  async consumeNonce(nonce: string | undefined): Promise<boolean> {
    if (!nonce || nonce.length > 64 || !/^[A-Za-z0-9_-]+$/.test(nonce)) return false;
    return (await this.db('pki_acme_nonces').where({ nonce }).andWhere('expires_at', '>', Date.now()).delete()) === 1;
  }

  async purgeNonces(): Promise<number> {
    return this.db('pki_acme_nonces').where('expires_at', '<=', Date.now()).delete();
  }

  /**
   * Checks a JWS-signed request (RFC 8555 6.2 to 6.5): the URL it was sent to, the signature by the account key
   * (`kid`, an account of this tenant's directory) or by the key it carries (`jwk`, where the endpoint allows it),
   * and the nonce last, so that a request failing any other check does not use up a nonce.
   */
  async authenticate(ctx: AcmeContext, body: unknown, url: string, keyMode: 'kid' | 'jwk' | 'either'): Promise<{ jws: ParsedJws; account: AcmeAccount | null; key: KeyObject }> {
    const jws = parseJws(body);
    if (jws.header.url !== url) throw new AcmeProblem(401, 'unauthorized', 'The JWS url does not match the request URL.');
    let account: AcmeAccount | null = null;
    let key: KeyObject;
    if (jws.header.jwk) {
      if (keyMode === 'kid') throw malformed('This request must be signed with the account key (kid).');
      key = keyForJwk(jws.header.jwk, jws.header.alg);
    } else {
      if (keyMode === 'jwk') throw malformed('This request must carry the public key (jwk), not a kid.');
      const prefix = ctx.urls.account('');
      const kid = jws.header.kid!;
      const id = kid.startsWith(prefix) ? kid.slice(prefix.length) : '';
      if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) throw new AcmeProblem(400, 'accountDoesNotExist', 'The kid does not name an account of this directory.');
      const r = (await this.db('pki_acme_accounts').where({ tenant_id: ctx.tenant.id, id }).first()) as Record<string, unknown> | undefined;
      if (!r) throw new AcmeProblem(400, 'accountDoesNotExist', 'The kid does not name an account of this directory.');
      account = accountFrom(r);
      if (account.status !== 'valid') throw new AcmeProblem(401, 'unauthorized', `The account is ${account.status}.`);
      key = keyForJwk(account.jwk, jws.header.alg);
    }
    if (!verifyJws(jws, key)) throw malformed('The JWS signature does not verify.');
    if (!(await this.consumeNonce(jws.header.nonce))) throw new AcmeProblem(400, 'badNonce', 'The nonce is missing, unknown, already used or expired.');
    return { jws, account, key };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Accounts

  accountJson(ctx: AcmeContext, a: AcmeAccount): Record<string, unknown> {
    return { status: a.status, contact: a.contact, orders: ctx.urls.orders(a.id), createdAt: iso(a.created_at) };
  }

  private contacts(v: unknown): string[] {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > 5) throw malformed('contact must be an array of at most five mailto: URLs.');
    return v.map((c) => {
      if (typeof c !== 'string' || !c.startsWith('mailto:')) throw new AcmeProblem(400, 'unsupportedContact', 'Only mailto: contacts are accepted.');
      const addr = c.slice(7);
      if (addr.length > 254 || /[,?\s]/.test(addr) || !/^[A-Za-z0-9.!#$%&'*+/=^_`{|}~-]{1,64}@[A-Za-z0-9.-]{1,253}$/.test(addr)) throw new AcmeProblem(400, 'invalidContact', `${c.slice(0, 80)} is not a single email address.`);
      return `mailto:${addr}`;
    });
  }

  async newAccount(ctx: AcmeContext, body: unknown, ip: string | null): Promise<AcmeReply> {
    const { jws, key } = await this.authenticate(ctx, body, ctx.urls.newAccount, 'jwk');
    const p = (jws.payload ?? {}) as Record<string, unknown>;
    if (typeof p !== 'object' || Array.isArray(p)) throw malformed('The payload must be an object.');
    const jwk = jws.header.jwk!;
    const thumbprint = jwkThumbprint(jwk);
    const existing = (await this.db('pki_acme_accounts').where({ tenant_id: ctx.tenant.id, thumbprint }).first()) as Record<string, unknown> | undefined;
    if (existing) {
      const a = accountFrom(existing);
      return { status: 200, body: this.accountJson(ctx, a), location: ctx.urls.account(a.id) };
    }
    if (p.onlyReturnExisting === true) throw new AcmeProblem(400, 'accountDoesNotExist', 'There is no account for this key.');
    const contact = this.contacts(p.contact);
    let eabKeyId: string | null = null;
    if (ctx.settings.eab_required || p.externalAccountBinding !== undefined) {
      if (p.externalAccountBinding === undefined) throw new AcmeProblem(400, 'externalAccountRequired', 'This directory needs an external account binding; ask the tenant administrator for a key.');
      eabKeyId = await this.checkBinding(ctx, p.externalAccountBinding, jwk);
    }
    const t = Date.now();
    const id = ulid();
    try {
      await this.db.transaction(async (trx) => {
        if (eabKeyId) {
          const bound = await trx('pki_acme_eab_keys').where({ tenant_id: ctx.tenant.id, id: eabKeyId, state: 'active' }).update({ state: 'bound', account_id: id, bound_at: t });
          if (bound !== 1) throw new AcmeProblem(401, 'unauthorized', 'The external account binding key is already used or revoked.');
        }
        await trx('pki_acme_accounts').insert({ id, tenant_id: ctx.tenant.id, thumbprint, jwk: JSON.stringify(jwkOf(key)), contact: JSON.stringify(contact), status: 'valid', eab_key_id: eabKeyId, created_ip: ip, created_at: t, updated_at: t });
      });
    } catch (err) {
      if (err instanceof AcmeProblem) throw err;
      // Two requests with the same new key: the second finds the first's account.
      const again = (await this.db('pki_acme_accounts').where({ tenant_id: ctx.tenant.id, thumbprint }).first()) as Record<string, unknown> | undefined;
      if (again) return { status: 200, body: this.accountJson(ctx, accountFrom(again)), location: ctx.urls.account(String(again.id)) };
      throw err;
    }
    const a = (await this.accountById(ctx.tenant.id, id))!;
    await this.audit(ctx.tenant.id, id, 'pki.acme.account.created', { acmeAccount: id }, { thumbprint, contact, eabKey: eabKeyId, alg: jws.header.alg });
    return { status: 201, body: this.accountJson(ctx, a), location: ctx.urls.account(id) };
  }

  /** RFC 8555 7.3.4: an HS256 JWS over the account's JWK, MACed with a key this tenant issued. Returns its id. */
  private async checkBinding(ctx: AcmeContext, binding: unknown, jwk: JsonWebKey): Promise<string> {
    const bad = (detail: string) => new AcmeProblem(401, 'unauthorized', `External account binding: ${detail}`);
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw malformed('externalAccountBinding must be a flattened JWS.');
    const b = binding as Record<string, unknown>;
    if (typeof b.protected !== 'string' || typeof b.payload !== 'string' || typeof b.signature !== 'string' || !/^[A-Za-z0-9_-]+$/.test(b.protected + b.payload + b.signature)) throw malformed('externalAccountBinding must be a flattened JWS.');
    let h: Record<string, unknown>;
    let inner: JsonWebKey;
    try {
      h = JSON.parse(Buffer.from(b.protected, 'base64url').toString('utf8')) as Record<string, unknown>;
      inner = JSON.parse(Buffer.from(b.payload, 'base64url').toString('utf8')) as JsonWebKey;
    } catch {
      throw malformed('externalAccountBinding is not JSON.');
    }
    if (h.alg !== 'HS256') throw new AcmeProblem(400, 'badSignatureAlgorithm', 'External account binding must use HS256.');
    if (h.nonce !== undefined) throw bad('the binding must not carry a nonce.');
    if (h.url !== ctx.urls.newAccount) throw bad('its url is not this directory\'s newAccount URL.');
    if (typeof h.kid !== 'string' || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(h.kid)) throw bad('unknown key.');
    if (jwkThumbprint(inner) !== jwkThumbprint(jwk)) throw bad('it binds a different account key.');
    const r = (await this.db('pki_acme_eab_keys').where({ tenant_id: ctx.tenant.id, id: h.kid }).first()) as Record<string, unknown> | undefined;
    if (!r) throw bad('unknown key.');
    if (r.state !== 'active') throw bad('the key is already used or revoked.');
    const secret = Buffer.from(await this.s().keys.open(ctx.tenant.id, String(r.key_sealed), `acme-eab:${h.kid}`), 'base64url');
    const want = createHmac('sha256', secret).update(`${b.protected}.${b.payload}`).digest();
    const got = Buffer.from(b.signature, 'base64url');
    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      await this.audit(ctx.tenant.id, undefined, 'pki.acme.eab.refused', { eabKey: h.kid }, { reason: 'bad MAC' });
      throw bad('the MAC does not verify.');
    }
    return h.kid;
  }

  async updateAccount(ctx: AcmeContext, id: string, body: unknown): Promise<AcmeReply> {
    const { jws, account } = await this.authenticate(ctx, body, ctx.urls.account(id), 'kid');
    if (account!.id !== id) throw new AcmeProblem(401, 'unauthorized', 'The kid is not this account.');
    const p = jws.payload as Record<string, unknown> | null;
    let a = account!;
    if (p && typeof p === 'object') {
      const t = Date.now();
      if (p.status !== undefined) {
        if (p.status !== 'deactivated') throw malformed('An account can only be set to deactivated.');
        await this.db('pki_acme_accounts').where({ tenant_id: ctx.tenant.id, id }).update({ status: 'deactivated', updated_at: t });
        await this.db('pki_acme_orders').where({ tenant_id: ctx.tenant.id, account_id: id }).whereIn('status', ['pending', 'ready']).update({ status: 'invalid', error: JSON.stringify({ type: 'urn:ietf:params:acme:error:unauthorized', detail: 'The account was deactivated.' }), updated_at: t });
        await this.audit(ctx.tenant.id, id, 'pki.acme.account.deactivated', { acmeAccount: id });
      } else if (p.contact !== undefined) {
        const contact = this.contacts(p.contact);
        await this.db('pki_acme_accounts').where({ tenant_id: ctx.tenant.id, id }).update({ contact: JSON.stringify(contact), updated_at: t });
        await this.audit(ctx.tenant.id, id, 'pki.acme.account.updated', { acmeAccount: id }, { before: a.contact, after: contact });
      }
      a = (await this.accountById(ctx.tenant.id, id))!;
    }
    return { status: 200, body: this.accountJson(ctx, a), location: ctx.urls.account(id) };
  }

  async accountOrders(ctx: AcmeContext, id: string, body: unknown): Promise<AcmeReply> {
    const { account } = await this.authenticate(ctx, body, ctx.urls.orders(id), 'kid');
    if (account!.id !== id) throw new AcmeProblem(401, 'unauthorized', 'The kid is not this account.');
    const rows = (await this.db('pki_acme_orders').where({ tenant_id: ctx.tenant.id, account_id: id }).whereIn('status', ['pending', 'ready', 'processing', 'valid']).andWhere('expires_at', '>', Date.now()).orderBy('created_at', 'desc').limit(1000).select('id')) as { id: string }[];
    return { status: 200, body: { orders: rows.map((r) => ctx.urls.order(r.id)) } };
  }

  /** RFC 8555 7.3.5: the inner JWS, signed by the new key, names the account and the old key. */
  async keyChange(ctx: AcmeContext, body: unknown): Promise<AcmeReply> {
    const { jws, account } = await this.authenticate(ctx, body, ctx.urls.keyChange, 'kid');
    const inner = parseJws(jws.payload);
    if (!inner.header.jwk) throw malformed('The inner JWS must carry the new key (jwk).');
    if (inner.header.nonce !== undefined) throw malformed('The inner JWS must not carry a nonce.');
    if (inner.header.url !== ctx.urls.keyChange) throw malformed('The inner JWS url must be the keyChange URL.');
    const newKey = keyForJwk(inner.header.jwk, inner.header.alg);
    if (!verifyJws(inner, newKey)) throw malformed('The inner JWS signature does not verify with the new key.');
    const p = inner.payload as { account?: unknown; oldKey?: unknown } | null;
    if (!p || p.account !== ctx.urls.account(account!.id)) throw malformed('The inner payload must name this account.');
    if (!p.oldKey || typeof p.oldKey !== 'object' || jwkThumbprint(p.oldKey as JsonWebKey) !== account!.thumbprint) throw malformed('The inner payload\'s oldKey is not the account\'s current key.');
    const thumbprint = jwkThumbprint(inner.header.jwk);
    const taken = (await this.db('pki_acme_accounts').where({ tenant_id: ctx.tenant.id, thumbprint }).first('id')) as { id: string } | undefined;
    if (taken) throw Object.assign(new AcmeProblem(409, 'malformed', 'Another account already uses the new key.'), { location: ctx.urls.account(taken.id) });
    await this.db('pki_acme_accounts').where({ tenant_id: ctx.tenant.id, id: account!.id, thumbprint: account!.thumbprint }).update({ jwk: JSON.stringify(jwkOf(newKey)), thumbprint, updated_at: Date.now() });
    await this.audit(ctx.tenant.id, account!.id, 'pki.acme.account.key-changed', { acmeAccount: account!.id }, { oldThumbprint: account!.thumbprint, newThumbprint: thumbprint });
    const a = (await this.accountById(ctx.tenant.id, account!.id))!;
    return { status: 200, body: this.accountJson(ctx, a), location: ctx.urls.account(a.id) };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Orders, authorizations and challenges

  private async profileFor(ctx: AcmeContext): Promise<ProfileRow> {
    const p = ctx.settings.profile_id ? await this.s().pki.profile(ctx.tenant.id, ctx.settings.profile_id) : undefined;
    if (!p || p.state !== 'active' || p.kind !== 'server') throw new AcmeProblem(500, 'serverInternal', 'This directory\'s profile is missing or disabled.');
    return p;
  }

  async newOrder(ctx: AcmeContext, body: unknown): Promise<AcmeReply> {
    const { jws, account } = await this.authenticate(ctx, body, ctx.urls.newOrder, 'kid');
    const p = jws.payload as { identifiers?: unknown; notBefore?: unknown; notAfter?: unknown } | null;
    if (!p || typeof p !== 'object') throw malformed('The payload must be an object with identifiers.');
    if (p.notBefore !== undefined || p.notAfter !== undefined) throw malformed('notBefore and notAfter are not supported; the profile sets the lifetime.');
    if (!Array.isArray(p.identifiers) || !p.identifiers.length || p.identifiers.length > MAX_IDENTIFIERS) throw malformed(`identifiers must list 1 to ${MAX_IDENTIFIERS} names.`);
    const profile = await this.profileFor(ctx);
    const values: string[] = [];
    const sub: Record<string, unknown>[] = [];
    for (const raw of p.identifiers as unknown[]) {
      const idf = raw as { type?: unknown; value?: unknown };
      if (!idf || typeof idf !== 'object' || idf.type !== 'dns' || typeof idf.value !== 'string') {
        sub.push({ type: 'urn:ietf:params:acme:error:unsupportedIdentifier', detail: 'Only dns identifiers are issued.', identifier: idf });
        continue;
      }
      const v = idf.value.trim().toLowerCase().replace(/\.$/, '');
      const wildcard = v.startsWith('*.');
      const why = !DNS_RE.test(wildcard ? v.slice(2) : v) || v.length > 253 ? `${v.slice(0, 80)} is not a valid host name.` : wildcard && !ctx.settings.challenges.includes('dns-01') ? `${v}: wildcards need dns-01, which this directory does not offer.` : nameRefusal('server', profile.policy, { type: 'dns', value: v });
      if (why) sub.push({ type: 'urn:ietf:params:acme:error:rejectedIdentifier', detail: why, identifier: { type: 'dns', value: v } });
      else if (!values.includes(v)) values.push(v);
    }
    if (sub.length) {
      await this.audit(ctx.tenant.id, account!.id, 'pki.acme.order.refused', { acmeAccount: account!.id }, { refused: sub.map((x) => x.detail) });
      throw new AcmeProblem(400, sub.every((x) => String(x.type).endsWith('unsupportedIdentifier')) ? 'unsupportedIdentifier' : 'rejectedIdentifier', sub.length === 1 ? String(sub[0]!.detail) : 'Some identifiers are outside what this directory issues.', { subproblems: sub });
    }
    const pending = (await this.db('pki_acme_orders').where({ tenant_id: ctx.tenant.id, account_id: account!.id }).whereIn('status', ['pending', 'ready', 'processing']).andWhere('expires_at', '>', Date.now()).count({ c: '*' }).first()) as { c: number | string } | undefined;
    if (Number(pending?.c ?? 0) >= MAX_PENDING_ORDERS) throw new AcmeProblem(429, 'rateLimited', `At most ${MAX_PENDING_ORDERS} open orders per account.`);

    const t = Date.now();
    const expires = t + this.cfg.PKI_ACME_ORDER_HOURS * 3_600_000;
    const orderId = ulid();
    const authzRows: Record<string, unknown>[] = [];
    const challengeRows: Record<string, unknown>[] = [];
    for (const v of values) {
      const wildcard = v.startsWith('*.');
      const aid = ulid();
      authzRows.push({ id: aid, tenant_id: ctx.tenant.id, account_id: account!.id, order_id: orderId, identifier: wildcard ? v.slice(2) : v, wildcard, status: 'pending', expires_at: expires, created_at: t, updated_at: t });
      for (const type of ctx.settings.challenges) {
        if (wildcard && type !== 'dns-01') continue; // RFC 8555 7.1.3: a wildcard is proven with dns-01 only
        challengeRows.push({ id: ulid(), tenant_id: ctx.tenant.id, authz_id: aid, type, token: randomBytes(32).toString('base64url'), status: 'pending', error: null, validated_at: null, created_at: t, updated_at: t });
      }
    }
    await this.db.transaction(async (trx) => {
      await trx('pki_acme_orders').insert({ id: orderId, tenant_id: ctx.tenant.id, account_id: account!.id, status: 'pending', identifiers: JSON.stringify(values.map((value) => ({ type: 'dns', value }))), profile_id: profile.id, expires_at: expires, error: null, certificate_id: null, created_at: t, updated_at: t });
      for (const r of authzRows) await trx('pki_acme_authorizations').insert(r);
      for (const r of challengeRows) await trx('pki_acme_challenges').insert(r);
    });
    await this.audit(ctx.tenant.id, account!.id, 'pki.acme.order.created', { acmeOrder: orderId, acmeAccount: account!.id }, { identifiers: values, profile: profile.id });
    const order = (await this.loadOrder(ctx, account!.id, orderId))!;
    return { status: 201, body: await this.orderJson(ctx, order), location: ctx.urls.order(orderId) };
  }

  /** An order of this account, with its status brought up to date (expiry, authorizations). */
  private async loadOrder(ctx: AcmeContext, accountId: string, id: string): Promise<AcmeOrder | undefined> {
    const r = (await this.db('pki_acme_orders').where({ tenant_id: ctx.tenant.id, account_id: accountId, id }).first()) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    const o = orderFrom(r);
    if ((o.status === 'pending' || o.status === 'ready') && o.expires_at <= Date.now()) {
      await this.setOrder(ctx.tenant.id, o.id, o.status, 'invalid', { type: 'urn:ietf:params:acme:error:malformed', detail: 'The order expired.' });
      return { ...o, status: 'invalid', error: { type: 'urn:ietf:params:acme:error:malformed', detail: 'The order expired.' } };
    }
    return o;
  }

  private async setOrder(tenantId: string, id: string, from: string, to: AcmeOrder['status'], error: Record<string, unknown> | null = null): Promise<boolean> {
    return (await this.db('pki_acme_orders').where({ tenant_id: tenantId, id, status: from }).update({ status: to, error: error ? JSON.stringify(error) : null, updated_at: Date.now() })) === 1;
  }

  private async authzOf(tenantId: string, orderId: string): Promise<AcmeAuthz[]> {
    return ((await this.db('pki_acme_authorizations').where({ tenant_id: tenantId, order_id: orderId }).orderBy('id')) as Record<string, unknown>[]).map(authzFrom);
  }

  async orderJson(ctx: AcmeContext, o: AcmeOrder): Promise<Record<string, unknown>> {
    const authz = await this.authzOf(ctx.tenant.id, o.id);
    return {
      status: o.status,
      expires: iso(o.expires_at),
      identifiers: o.identifiers,
      authorizations: authz.map((a) => ctx.urls.authz(a.id)),
      finalize: ctx.urls.finalize(o.id),
      ...(o.certificate_id ? { certificate: ctx.urls.certificate(o.certificate_id) } : {}),
      ...(o.error ? { error: o.error } : {})
    };
  }

  async getOrder(ctx: AcmeContext, id: string, body: unknown): Promise<AcmeReply> {
    const { account } = await this.authenticate(ctx, body, ctx.urls.order(id), 'kid');
    const o = await this.loadOrder(ctx, account!.id, id);
    if (!o) throw new AcmeProblem(404, 'malformed', 'Order not found.');
    return { status: 200, body: await this.orderJson(ctx, o) };
  }

  private async loadAuthz(ctx: AcmeContext, accountId: string, id: string): Promise<AcmeAuthz | undefined> {
    const r = (await this.db('pki_acme_authorizations').where({ tenant_id: ctx.tenant.id, account_id: accountId, id }).first()) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    const a = authzFrom(r);
    if (a.status === 'pending' && a.expires_at <= Date.now()) {
      await this.db('pki_acme_authorizations').where({ tenant_id: ctx.tenant.id, id, status: 'pending' }).update({ status: 'expired', updated_at: Date.now() });
      return { ...a, status: 'expired' };
    }
    return a;
  }

  challengeJson(ctx: AcmeContext, c: AcmeChallenge): Record<string, unknown> {
    return { type: c.type, url: ctx.urls.challenge(c.id), status: c.status, token: c.token, ...(c.validated_at ? { validated: iso(c.validated_at) } : {}), ...(c.error ? { error: c.error } : {}) };
  }

  async getAuthz(ctx: AcmeContext, id: string, body: unknown): Promise<AcmeReply> {
    const { jws, account } = await this.authenticate(ctx, body, ctx.urls.authz(id), 'kid');
    let a = await this.loadAuthz(ctx, account!.id, id);
    if (!a) throw new AcmeProblem(404, 'malformed', 'Authorization not found.');
    const p = jws.payload as { status?: unknown } | null;
    if (p && typeof p === 'object' && p.status !== undefined) {
      if (p.status !== 'deactivated') throw malformed('An authorization can only be set to deactivated.');
      if (a.status === 'pending' || a.status === 'valid') {
        await this.db('pki_acme_authorizations').where({ tenant_id: ctx.tenant.id, id }).update({ status: 'deactivated', updated_at: Date.now() });
        await this.db('pki_acme_orders').where({ tenant_id: ctx.tenant.id, id: a.order_id }).whereIn('status', ['pending', 'ready']).update({ status: 'invalid', error: JSON.stringify({ type: 'urn:ietf:params:acme:error:unauthorized', detail: `The authorization for ${a.identifier} was deactivated.` }), updated_at: Date.now() });
        await this.audit(ctx.tenant.id, account!.id, 'pki.acme.authz.deactivated', { acmeAuthz: id, acmeOrder: a.order_id }, { identifier: a.identifier });
        a = { ...a, status: 'deactivated' };
      }
    }
    const ch = ((await this.db('pki_acme_challenges').where({ tenant_id: ctx.tenant.id, authz_id: id }).orderBy('type', 'desc')) as Record<string, unknown>[]).map(challengeFrom);
    return { status: 200, body: { identifier: { type: 'dns', value: a.identifier }, status: a.status, expires: iso(a.expires_at), challenges: ch.map((c) => this.challengeJson(ctx, c)), ...(a.wildcard ? { wildcard: true } : {}) } };
  }

  /** POST {} to a challenge starts its validation (a job); POST-as-GET reads it. */
  async challenge(ctx: AcmeContext, id: string, body: unknown): Promise<AcmeReply> {
    const { jws, account } = await this.authenticate(ctx, body, ctx.urls.challenge(id), 'kid');
    const r = (await this.db('pki_acme_challenges').where({ tenant_id: ctx.tenant.id, id }).first()) as Record<string, unknown> | undefined;
    const c0 = r ? challengeFrom(r) : undefined;
    const a = c0 ? await this.loadAuthz(ctx, account!.id, c0.authz_id) : undefined;
    if (!c0 || !a) throw new AcmeProblem(404, 'malformed', 'Challenge not found.');
    let c = c0;
    if (jws.payload !== null) {
      if (typeof jws.payload !== 'object' || Array.isArray(jws.payload)) throw malformed('Respond to a challenge with an empty object.');
      if (c.status === 'pending') {
        if (a.status !== 'pending') throw new AcmeProblem(403, 'malformed', `The authorization is ${a.status}.`);
        const started = await this.db('pki_acme_challenges').where({ tenant_id: ctx.tenant.id, id, status: 'pending' }).update({ status: 'processing', updated_at: Date.now() });
        if (started === 1) {
          await this.s().jobs.enqueue({ tenantId: ctx.tenant.id, type: 'pki.acme.validate', payload: { challengeId: id }, createdBy: null, maxAttempts: 1 });
          c = { ...c, status: 'processing' };
        }
      }
    }
    return { status: 200, body: this.challengeJson(ctx, c), links: [`<${ctx.urls.authz(a.id)}>;rel="up"`] };
  }

  /** The validation job: fetch or look up the key authorization, then settle the challenge, authorization and order. */
  async validate(challengeId: string): Promise<{ status: string; detail?: string }> {
    const r = (await this.db('pki_acme_challenges').where({ id: challengeId }).first()) as Record<string, unknown> | undefined;
    if (!r) return { status: 'missing' };
    const c = challengeFrom(r);
    if (c.status !== 'processing') return { status: c.status };
    const a = authzFrom((await this.db('pki_acme_authorizations').where({ tenant_id: c.tenant_id, id: c.authz_id }).first()) as Record<string, unknown>);
    const acct = accountFrom((await this.db('pki_acme_accounts').where({ tenant_id: c.tenant_id, id: a.account_id }).first()) as Record<string, unknown>);
    const keyAuthorization = `${c.token}.${acct.thumbprint}`;
    let problem: { type: string; detail: string } | null;
    if (a.status !== 'pending' || a.expires_at <= Date.now()) problem = { type: 'malformed', detail: `The authorization is ${a.status === 'pending' ? 'expired' : a.status}.` };
    else if (acct.status !== 'valid') problem = { type: 'unauthorized', detail: `The account is ${acct.status}.` };
    else problem = c.type === 'http-01' ? await this.checkHttp01(a.identifier, c.token, keyAuthorization) : await this.checkDns01(a.identifier, keyAuthorization);
    const t = Date.now();
    if (!problem) {
      await this.db('pki_acme_challenges').where({ id: c.id, status: 'processing' }).update({ status: 'valid', validated_at: t, updated_at: t });
      await this.db('pki_acme_authorizations').where({ tenant_id: c.tenant_id, id: a.id, status: 'pending' }).update({ status: 'valid', updated_at: t });
      const all = await this.authzOf(c.tenant_id, a.order_id);
      if (all.every((x) => x.status === 'valid')) await this.setOrder(c.tenant_id, a.order_id, 'pending', 'ready');
      await this.audit(c.tenant_id, acct.id, 'pki.acme.challenge.valid', { acmeChallenge: c.id, acmeOrder: a.order_id }, { identifier: a.identifier, wildcard: a.wildcard, type: c.type });
      return { status: 'valid' };
    }
    const error = { type: `urn:ietf:params:acme:error:${problem.type}`, detail: problem.detail, status: 403 };
    await this.db('pki_acme_challenges').where({ id: c.id, status: 'processing' }).update({ status: 'invalid', error: JSON.stringify(error), updated_at: t });
    await this.db('pki_acme_authorizations').where({ tenant_id: c.tenant_id, id: a.id, status: 'pending' }).update({ status: 'invalid', updated_at: t });
    await this.db('pki_acme_orders').where({ tenant_id: c.tenant_id, id: a.order_id }).whereIn('status', ['pending', 'ready']).update({ status: 'invalid', error: JSON.stringify({ ...error, detail: `${a.identifier}: ${problem.detail}` }), updated_at: t });
    await this.audit(c.tenant_id, acct.id, 'pki.acme.challenge.invalid', { acmeChallenge: c.id, acmeOrder: a.order_id }, { identifier: a.identifier, type: c.type, problem: problem.type, detail: problem.detail.slice(0, 500) });
    return { status: 'invalid', detail: problem.detail };
  }

  private policy(): ServicePolicy {
    return servicePolicy({ SERVICE_ALLOWED_HOSTS: this.cfg.PKI_ACME_ALLOWED_HOSTS, SERVICE_INTERNAL_ONLY: this.cfg.PKI_ACME_INTERNAL_ONLY });
  }

  private resolveHost(host: string): Promise<string[]> {
    if (this.validation.resolveHost) return this.validation.resolveHost(host);
    return new Promise((resolve, reject) => dnsLookup(host, { all: true, verbatim: true }, (err, list: LookupAddress[]) => (err ? reject(err) : resolve(list.map((x) => x.address)))));
  }

  /** http-01 (RFC 8555 8.3): GET the key authorization from port 80 of the name, following up to three redirects. */
  private async checkHttp01(identifier: string, token: string, keyAuthorization: string): Promise<{ type: string; detail: string } | null> {
    const policy = this.policy();
    const port = this.validation.httpPort ?? this.cfg.PKI_ACME_HTTP_PORT;
    let url = `http://${identifier}${port === 80 ? '' : `:${port}`}/.well-known/acme-challenge/${token}`;
    const lookup = (hostname: string, options: { all?: boolean }, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
      this.resolveHost(hostname).then(
        (list) => {
          if (!list.length) return cb(Object.assign(new Error(`${hostname} does not resolve`), { code: 'ENOTFOUND' }), '', 0);
          for (const addr of list) {
            const p = serviceAddressProblem(addr, hostname.toLowerCase(), policy);
            if (p) return cb(Object.assign(new Error(p), { code: 'EREFUSED' }), '', 0);
          }
          const all = list.map((address) => ({ address, family: isIP(address) === 6 ? 6 : 4 }));
          if (options.all) return cb(null, all);
          cb(null, all[0]!.address, all[0]!.family);
        },
        (err: NodeJS.ErrnoException) => cb(err, '', 0)
      );
    };
    const agent = new Agent({ connect: { lookup: lookup as never, timeout: HTTP_TIMEOUT_MS, rejectUnauthorized: false }, headersTimeout: HTTP_TIMEOUT_MS, bodyTimeout: HTTP_TIMEOUT_MS });
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const literal = literalProblem(url, policy);
        if (literal) return { type: 'connection', detail: literal };
        let res;
        try {
          res = await httpRequest(url, { method: 'GET', dispatcher: agent, headers: { 'user-agent': 'Exprsn-AI ACME validation', accept: '*/*' }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
        } catch (err) {
          const e = err as NodeJS.ErrnoException & { cause?: NodeJS.ErrnoException };
          return { type: 'connection', detail: `Could not fetch ${url}: ${e.cause?.message ?? e.message}` };
        }
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          await res.body.dump();
          const next = new URL(String(res.headers.location), url);
          const okPort = next.protocol === 'http:' ? (next.port ? Number(next.port) : 80) === port : next.protocol === 'https:' && (next.port === '' || next.port === '443');
          if (!okPort) return { type: 'connection', detail: `${url} redirects to ${next.href}, which is not http on port ${port} or https on port 443.` };
          url = next.href;
          continue;
        }
        if (res.statusCode !== 200) {
          await res.body.dump();
          return { type: 'unauthorized', detail: `${url} answered ${res.statusCode}.` };
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of res.body) {
          size += (chunk as Buffer).length;
          if (size > HTTP_BODY_LIMIT) {
            res.body.destroy();
            return { type: 'unauthorized', detail: `${url} answered with more than ${HTTP_BODY_LIMIT} bytes.` };
          }
          chunks.push(chunk as Buffer);
        }
        const got = Buffer.concat(chunks).toString('utf8').replace(/[\s]+$/, '');
        return got === keyAuthorization ? null : { type: 'incorrectResponse', detail: `${url} did not answer with the key authorization.` };
      }
      return { type: 'connection', detail: `Too many redirects from ${identifier}.` };
    } finally {
      await agent.close().catch(() => undefined);
    }
  }

  /** dns-01 (RFC 8555 8.4): a TXT record at _acme-challenge.<name> holding base64url(SHA-256(key authorization)). */
  private async checkDns01(identifier: string, keyAuthorization: string): Promise<{ type: string; detail: string } | null> {
    const name = `_acme-challenge.${identifier}`;
    const want = createHash('sha256').update(keyAuthorization).digest('base64url');
    let records: string[];
    try {
      if (this.validation.resolveTxt) records = await this.validation.resolveTxt(name);
      else {
        const r = new Resolver({ timeout: 5000, tries: 2 });
        const servers = this.cfg.PKI_ACME_DNS_SERVERS?.split(',').map((x) => x.trim()).filter(Boolean);
        if (servers?.length) r.setServers(servers);
        records = (await r.resolveTxt(name)).map((chunks) => chunks.join(''));
      }
    } catch (err) {
      return { type: 'dns', detail: `The TXT lookup for ${name} failed: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}.` };
    }
    return records.includes(want) ? null : { type: 'incorrectResponse', detail: `No TXT record at ${name} holds the expected value.` };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Finalize, download, revoke

  async finalize(ctx: AcmeContext, id: string, body: unknown): Promise<AcmeReply> {
    const { jws, account } = await this.authenticate(ctx, body, ctx.urls.finalize(id), 'kid');
    const o = await this.loadOrder(ctx, account!.id, id);
    if (!o) throw new AcmeProblem(404, 'malformed', 'Order not found.');
    if (o.status !== 'ready') throw new AcmeProblem(403, 'orderNotReady', `The order is ${o.status}, not ready.`);
    const p = jws.payload as { csr?: unknown } | null;
    if (!p || typeof p.csr !== 'string' || !/^[A-Za-z0-9_-]+$/.test(p.csr) || p.csr.length > 20_000) throw malformed('finalize needs the CSR as base64url DER.');
    let csr;
    try {
      csr = parseCsr(Buffer.from(p.csr, 'base64url'));
    } catch (err) {
      throw new AcmeProblem(400, 'badCSR', err instanceof CsrError ? err.message : 'The CSR does not parse.');
    }
    // RFC 8555 7.4: the CSR names exactly the order's identifiers (the common name, if any, among them).
    const want = [...new Set(o.identifiers.map((x) => x.value))].sort();
    if (csr.sans.some((x) => x.type !== 'dns')) throw new AcmeProblem(400, 'badCSR', 'The CSR names something other than DNS names.');
    const names = [...new Set([...csr.sans.map((x) => x.value.toLowerCase()), ...(csr.commonName ? [csr.commonName.toLowerCase()] : [])])].sort();
    if (JSON.stringify(names) !== JSON.stringify(want)) throw new AcmeProblem(400, 'badCSR', `The CSR names ${names.join(', ') || 'nothing'}; the order is for ${want.join(', ')}.`);
    // The order keeps the profile it was placed under, even if the directory has moved to another since.
    const profile = await this.s().pki.profile(ctx.tenant.id, o.profile_id);
    if (!profile || profile.state !== 'active') throw new AcmeProblem(403, 'unauthorized', 'The profile this order was placed under is disabled or gone.');
    if (!profile.policy.keyTypes.includes(csr.keyType)) throw new AcmeProblem(400, 'badCSR', `The profile does not accept ${csr.keyType} keys (it accepts ${profile.policy.keyTypes.join(', ')}).`);
    if (jwkThumbprint(jwkOf(csr.publicKey)) === account!.thumbprint) throw new AcmeProblem(400, 'badCSR', 'The certificate key must not be the account key.');
    if (!(await this.setOrder(ctx.tenant.id, o.id, 'ready', 'processing'))) throw new AcmeProblem(403, 'orderNotReady', 'The order is already being finalized.');
    const by = this.actor(ctx, account!.id);
    try {
      const issuer = await this.s().pki.activeIntermediate(ctx.tenant.id);
      if (!issuer) throw new PkiError(409, 'This tenant has no active intermediate.');
      const issued = await this.s().pki.issueKey(by, issuer, profile, { spki: csr.spki, keyType: csr.keyType, commonName: csr.commonName?.toLowerCase() ?? null, sans: o.identifiers.map((x) => ({ type: 'dns' as const, value: x.value })), acmeAccountId: account!.id });
      await this.db('pki_acme_orders').where({ tenant_id: ctx.tenant.id, id: o.id, status: 'processing' }).update({ status: 'valid', certificate_id: issued.cert.id, updated_at: Date.now() });
      await this.audit(ctx.tenant.id, account!.id, 'pki.acme.order.finalized', { acmeOrder: o.id, certificate: issued.cert.id }, { serial: issued.cert.serial, identifiers: want });
    } catch (err) {
      const detail = err instanceof PkiError ? err.message : 'The certificate could not be issued.';
      await this.setOrder(ctx.tenant.id, o.id, 'processing', 'invalid', { type: `urn:ietf:params:acme:error:${err instanceof PkiError && err.status === 422 ? 'rejectedIdentifier' : 'serverInternal'}`, detail });
      if (!(err instanceof PkiError)) this.s().log.warn({ err: (err as Error).message, order: o.id }, 'ACME finalize failed');
    }
    const after = (await this.loadOrder(ctx, account!.id, o.id))!;
    return { status: 200, body: await this.orderJson(ctx, after), location: ctx.urls.order(o.id) };
  }

  /** The certificate and its issuer (application/pem-certificate-chain; the root is left to trust stores). */
  async certificate(ctx: AcmeContext, id: string, body: unknown): Promise<AcmeReply> {
    const { account } = await this.authenticate(ctx, body, ctx.urls.certificate(id), 'kid');
    const cert = await this.s().pki.certificate(ctx.tenant.id, id);
    if (!cert || cert.acme_account_id !== account!.id) throw new AcmeProblem(404, 'malformed', 'Certificate not found.');
    const issuer = await this.s().pki.issuer(cert.issuer_id);
    const chain = issuer ? (await this.s().pki.chain(issuer)).filter((i) => i.kind !== 'root').map((i) => i.certificate_pem) : [];
    return { status: 200, pem: [cert.certificate_pem, ...chain].join('') };
  }

  /**
   * RFC 8555 7.6: revocation signed by the account that ordered the certificate, by an account holding valid
   * authorizations for all of its names, or by the certificate's own key (jwk).
   */
  async revoke(ctx: AcmeContext, body: unknown): Promise<AcmeReply> {
    const { jws, account, key } = await this.authenticate(ctx, body, ctx.urls.revokeCert, 'either');
    const p = jws.payload as { certificate?: unknown; reason?: unknown } | null;
    if (!p || typeof p.certificate !== 'string' || !/^[A-Za-z0-9_-]+$/.test(p.certificate)) throw malformed('revokeCert needs the certificate as base64url DER.');
    const der = Buffer.from(p.certificate, 'base64url');
    let serial: string;
    let x509: X509Certificate;
    try {
      x509 = new X509Certificate(der);
      serial = certificateParts(der).serial.toString('hex').replace(/^(00)+(?=[0-9a-f]{2})/, '');
    } catch {
      throw malformed('The certificate does not parse.');
    }
    const fingerprint = createHash('sha256').update(der).digest('hex');
    const row = (await this.db('pki_certificates').where({ tenant_id: ctx.tenant.id, fingerprint }).first('id')) as { id: string } | undefined;
    const cert = row ? await this.s().pki.certificate(ctx.tenant.id, row.id) : undefined;
    if (!cert || cert.serial.replace(/^(00)+(?=[0-9a-f]{2})/, '') !== serial) throw new AcmeProblem(404, 'malformed', 'This directory did not issue that certificate.');
    const reason = p.reason === undefined ? REASONS.unspecified : p.reason;
    if (typeof reason !== 'number' || !ACME_REASONS.has(reason)) throw new AcmeProblem(400, 'badRevocationReason', 'The reason must be 0, 1, 3, 4, 5 or 9.');
    let authorizedBy: string;
    if (account) {
      if (cert.acme_account_id === account.id) authorizedBy = 'ordering account';
      else {
        const names = cert.sans.filter((x) => x.type === 'dns').map((x) => x.value);
        const held = (await this.db('pki_acme_authorizations').where({ tenant_id: ctx.tenant.id, account_id: account.id, status: 'valid' }).andWhere('expires_at', '>', Date.now()).whereIn('identifier', names.map((v) => v.replace(/^\*\./, ''))).select('identifier', 'wildcard')) as { identifier: string; wildcard: unknown }[];
        const covered = names.every((v) => held.some((h) => h.identifier === v.replace(/^\*\./, '') && Boolean(h.wildcard) === v.startsWith('*.')));
        if (!names.length || !covered) throw new AcmeProblem(403, 'unauthorized', 'This account neither ordered the certificate nor holds valid authorizations for all of its names.');
        authorizedBy = 'authorizations for every name';
      }
    } else {
      if (jwkThumbprint(jwkOf(x509.publicKey)) !== jwkThumbprint(jwkOf(key))) throw new AcmeProblem(403, 'unauthorized', 'The request is not signed by the certificate\'s key.');
      authorizedBy = 'certificate key';
    }
    if (cert.state === 'revoked') throw new AcmeProblem(400, 'alreadyRevoked', 'The certificate is already revoked.');
    try {
      await this.s().pki.revoke(this.actor(ctx, account?.id), cert, reason, null);
    } catch (err) {
      if (err instanceof PkiError && err.status === 409) throw new AcmeProblem(400, 'alreadyRevoked', err.message);
      throw err;
    }
    await this.audit(ctx.tenant.id, account?.id, 'pki.acme.certificate.revoked', { certificate: cert.id }, { serial: cert.serial, reason, authorizedBy });
    return { status: 200 };
  }

  // ---------------------------------------------------------------------------------------------------------------

  registerJobs(): void {
    this.s().jobs.register('pki.acme.validate', async (p) => this.validate(String(p.challengeId ?? '')), { timeoutMs: 120_000 });
  }

  /** Housekeeping for the expiry sweep: used and expired nonces, expired orders and authorizations. */
  async housekeeping(): Promise<{ nonces: number; orders: number }> {
    const now = Date.now();
    const nonces = await this.purgeNonces();
    const orders = await this.db('pki_acme_orders').whereIn('status', ['pending', 'ready']).andWhere('expires_at', '<=', now).update({ status: 'invalid', error: JSON.stringify({ type: 'urn:ietf:params:acme:error:malformed', detail: 'The order expired.' }), updated_at: now });
    await this.db('pki_acme_authorizations').where({ status: 'pending' }).andWhere('expires_at', '<=', now).update({ status: 'expired', updated_at: now });
    // Old finished orders go after 30 days with their authorizations and challenges.
    const old = ((await this.db('pki_acme_orders').whereIn('status', ['valid', 'invalid']).andWhere('updated_at', '<', now - 30 * DAY).limit(500).select('id')) as { id: string }[]).map((r) => r.id);
    if (old.length) {
      const authz = ((await this.db('pki_acme_authorizations').whereIn('order_id', old).select('id')) as { id: string }[]).map((r) => r.id);
      for (let i = 0; i < authz.length; i += 500) await this.db('pki_acme_challenges').whereIn('authz_id', authz.slice(i, i + 500)).delete();
      await this.db('pki_acme_authorizations').whereIn('order_id', old).delete();
      await this.db('pki_acme_orders').whereIn('id', old).delete();
    }
    return { nonces, orders };
  }
}
