import { constants, verify, X509Certificate } from 'node:crypto';
import { z } from 'zod';
import type { Principal } from '../authz/policy.js';
import { isPermission, type Permission } from '../authz/permissions.js';
import { exprsnPlatformConfigSchema, type ExprsnPlatformConfig } from '../identity/providers/types.js';
import { resolveSecretRef } from '../identity/secrets.js';
import { guardedRequest, serviceAddressProblem, servicePolicy } from '../platform/egress.js';
import { Limiter } from '../platform/ratelimit.js';
import { HttpProblem } from '../http/problem.js';
import type { ProviderRow } from '../repos/providers.js';
import type { Services } from '../services.js';
import { canonicalJson } from './canonical-json.js';
import { parsePemCertificates } from './x509.js';

/*
 * 1.9.0 (B-184, last part): the Exprsn platform's CA tokens as bearer credentials on the API.
 *
 * What the platform issues (exprsn-platform `services/ca/services/token.js`, read for design only): a CA token is a
 * database row; `POST /api/tokens/generate` answers the full signed token object
 *
 *   { id, version, issuer: { domain, certificateSerial }, permissions: { read, write, append, update, delete },
 *     resource: { url: <pattern> }, data: { userId, email, … }, issuedAt, notBefore, expiresAt (ms),
 *     expiryType: time | use | persistent, [groupId], [organizationId], checksum, signature }
 *
 * signed RSA-PSS SHA-256 (salt 32) by a token-signing certificate the CA issued, over
 * `JSON.stringify(t, Object.keys(t).sort())` (v1) or, since the platform's QA-1 fix, the canonical JSON of the whole
 * object with `sigVersion: 2` and `userId` in it (v2). It is not a JWT. The platform's own modules present only the `id` and
 * ask the CA's `POST /api/tokens/validate` (session or service credentials) every time.
 *
 * Here a caller presents the full object, base64url-encoded JSON (so it starts `eyJ` and, unlike a JWT, has no dot).
 * Three facts about the platform's signature shape this module:
 *
 * - v1 (no `sigVersion`): the replacer array in that `JSON.stringify` applies at every depth, so the nested objects
 *   (issuer, permissions, resource, data) are signed as `{}`: the signature binds the id, version, times and expiry
 *   type, not the account, the permission bits or the resource. So the account, bits and resource are taken from the
 *   CA's validation answer (asked by the signed id, cached briefly), never from the presented object; a presented
 *   `data.userId` that differs is refused. Validation is therefore required, and it is also how revocation is
 *   honoured. A store with `requireSignedClaims` refuses v1 tokens (`unsigned_claims`).
 * - v2 (1.9.9-qa, QA-1; `sigVersion: 2`, the platform's fix): the signature covers the canonical JSON
 *   (`canonical-json.ts`) of every presented field but `signature` and `checksum`, nested ones included. A v2 token
 *   naming a trusted signing certificate whose signature does not cover what is presented is refused
 *   (`signature_invalid`); its signed account, bits and resource must also equal the CA's answer (`claims_mismatch`),
 *   which is still asked for revocation and use counts. Stripping `sigVersion` does not help: the v2 signature does
 *   not verify over the v1 bytes.
 * - The signing certificate is named only by serial; its public key comes from the store's trust anchor bundle (or
 *   a JWKS with `x5c`), and every signing certificate must be issued by a CA certificate in the bundle.
 *
 * Tenancy: the tenant is the one whose active, enabled `exprsn-platform` store opted in (`acceptApiTokens`) with this
 * token's CA domain and a trust anchor its signature verifies under. With several, `X-Exprsn-Tenant: <slug>` picks
 * one (it must be one of them). The person is the account linked to the platform account id through that store;
 * nobody is created from a token. Permissions are the account's roles narrowed by the store's explicit bit table.
 *
 * Second factor (2026-10-21): a token carries no session, so it counts as MFA-verified only when it is v2 and carries
 * the CA's signed `mfa: true` claim (stamped when it was minted from a login verified with a second factor; the CA's
 * answer must agree). Admin roles that need a second factor work with such a token and are refused (`step: mfa`)
 * with any other, unless the store sets `adminTokensWithoutMfa` (off by default).
 */

/** Clock skew allowed on the token's times. */
export const PLATFORM_TOKEN_SKEW_MS = 60_000;
const MAX_BEARER = 16_384;
const JWKS_TTL_MS = 10 * 60_000;
const MAX_CACHE = 10_000;
const SUB = /^[A-Za-z0-9._:@-]{1,200}$/;

export type PlatformTokenRefusal =
  | 'malformed'
  | 'tenant_ambiguous'
  | 'tenant_mismatch'
  | 'bad_signature'
  | 'signature_invalid'
  | 'unsigned_claims'
  | 'expired'
  | 'not_yet_valid'
  | 'no_expiry'
  | 'wrong_audience'
  | 'revoked'
  | 'claims_mismatch'
  | 'unlinked'
  | 'account_disabled'
  | 'platform_unavailable';

const stamp = z.union([z.number().finite(), z.string().regex(/^\d{1,16}$/)]);
const presentedSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9-]{1,100}$/),
  version: z.string().max(20),
  issuer: z.object({ domain: z.string().max(253), certificateSerial: z.string().max(200) }),
  permissions: z.record(z.string(), z.unknown()),
  resource: z.record(z.string(), z.unknown()),
  data: z.unknown().optional(),
  issuedAt: stamp,
  notBefore: stamp.nullable().optional(),
  expiresAt: stamp.nullable().optional(),
  expiryType: z.enum(['time', 'use', 'persistent']),
  usesRemaining: z.number().nullable().optional(),
  maxUses: z.number().nullable().optional(),
  groupId: z.string().max(100).nullable().optional(),
  organizationId: z.string().max(100).nullable().optional(),
  signature: z.string().min(16).max(4096),
  /** The platform CA's signature scheme: absent (or 1) the legacy form, 2 the canonical form over every field. */
  sigVersion: z.union([z.literal(1), z.literal(2)]).optional(),
  /** v2: the platform account that holds the token (signed). */
  userId: z.string().max(200).optional(),
  /** v2: minted from a login verified with a second factor (signed; absent otherwise). */
  mfa: z.boolean().optional()
});
/** The presented token; `raw` is the decoded object as sent (every field, for the v2 signing input). */
export type PresentedPlatformToken = z.infer<typeof presentedSchema> & { raw?: Record<string, unknown> };

const validateAnswer = z.object({
  valid: z.boolean(),
  error: z.string().max(100).optional(),
  userId: z.string().optional(),
  token: z
    .object({
      id: z.string(),
      permissions: z.record(z.string(), z.unknown()).optional(),
      resource: z.record(z.string(), z.unknown()).optional(),
      expiryType: z.string().optional(),
      expiresAt: stamp.nullable().optional(),
      data: z.unknown().optional(),
      sigVersion: z.number().int().optional(),
      mfa: z.boolean().optional()
    })
    .optional()
});

interface Introspected {
  valid: true;
  sub: string;
  bits: Set<string>;
  resource: string | null;
  /** The scheme the CA verified the token's row under, when it says. */
  sigVersion: number | null;
  /** The CA says the token was minted from an MFA-verified login. */
  mfa: boolean;
}
type Introspection = Introspected | { valid: false; reason: PlatformTokenRefusal };

/** The bearer as a platform CA token, or null when it is not one (not base64url JSON of the token's shape). */
export function decodePlatformToken(bearer: string): PresentedPlatformToken | null {
  if (bearer.length > MAX_BEARER || !/^eyJ[A-Za-z0-9_-]+={0,2}$/.test(bearer)) return null;
  try {
    const raw = JSON.parse(Buffer.from(bearer, 'base64url').toString('utf8')) as unknown;
    const r = presentedSchema.safeParse(raw);
    return r.success ? { ...r.data, raw: raw as Record<string, unknown> } : null;
  } catch {
    return null;
  }
}

/** The token's signature scheme: 2 when it says so, else the legacy 1. */
export const platformSigVersion = (t: PresentedPlatformToken): 1 | 2 => (t.sigVersion === 2 ? 2 : 1);

/**
 * The v2 signing input: the canonical JSON of every presented field except `signature` and `checksum`
 * (exprsn-platform `services/ca/services/tokenSignature.js`). Null when the object cannot be canonicalised.
 */
export function platformSigningInputV2(t: PresentedPlatformToken): string | null {
  const rest: Record<string, unknown> = { ...(t.raw ?? t) };
  delete rest.raw;
  delete rest.signature;
  delete rest.checksum;
  try {
    return canonicalJson(rest);
  } catch {
    return null;
  }
}

/** The string the platform signs for a v1 token, built exactly as the CA built it before QA-1. */
export function platformSigningInput(t: PresentedPlatformToken): string {
  const o: Record<string, unknown> = {
    id: t.id,
    version: t.version,
    issuer: t.issuer,
    permissions: t.permissions,
    resource: t.resource,
    data: t.data ?? null,
    issuedAt: t.issuedAt,
    notBefore: t.notBefore ?? null,
    expiresAt: t.expiresAt ?? null,
    expiryType: t.expiryType
  };
  if (t.expiryType === 'use') {
    o.usesRemaining = t.maxUses ?? null;
    o.maxUses = t.maxUses ?? null;
  }
  if (t.groupId) o.groupId = t.groupId;
  if (t.organizationId) o.organizationId = t.organizationId;
  return JSON.stringify(o, Object.keys(o).sort());
}

const serialKey = (s: string): string => s.replace(/[^0-9a-f]/gi, '').toUpperCase().replace(/^0+/, '');

/** The CA's resource matcher (`matchesResource`): exact, `*` within one path segment, or a prefix ending in `/`. */
export function resourceMatches(requested: string, pattern: string): boolean {
  if (requested === pattern) return true;
  if (pattern.includes('*')) {
    const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
    return re.test(requested);
  }
  return pattern.endsWith('/') && requested.startsWith(pattern);
}

/** The permissions the token's true bits allow under the store's table (`read=chat:use knowledge:read`). */
export function scopesFor(bits: Set<string>, table: string[]): Permission[] {
  const out = new Set<Permission>();
  for (const line of table) {
    const [bit, rest] = line.split('=');
    if (!bit || !rest || !bits.has(bit.trim())) continue;
    for (const p of rest.trim().split(/\s+/)) if (isPermission(p)) out.add(p);
  }
  return [...out];
}

const bitsOf = (perms: Record<string, unknown> | undefined): Set<string> => new Set(Object.entries(perms ?? {}).filter(([, v]) => v === true).map(([k]) => k));

const refusalText: Record<PlatformTokenRefusal, string> = {
  malformed: 'The access token is invalid, expired or revoked.',
  tenant_ambiguous: 'More than one tenant accepts this platform token. Name the tenant with the X-Exprsn-Tenant header.',
  tenant_mismatch: 'The tenant named in X-Exprsn-Tenant does not accept this platform token.',
  bad_signature: 'The platform token\'s signature does not verify under a trusted platform CA.',
  signature_invalid: 'The platform token\'s signature does not cover the fields it presents.',
  unsigned_claims: 'The platform token uses the retired v1 signature, which does not cover its account, permissions or resource. Request a new token.',
  expired: 'The platform token has expired.',
  not_yet_valid: 'The platform token is not valid yet.',
  no_expiry: 'Only time-limited platform tokens are accepted.',
  wrong_audience: 'The platform token was not issued for this server.',
  revoked: 'The platform token is revoked or no longer valid at the platform.',
  claims_mismatch: 'The platform token does not match what the platform holds for it.',
  unlinked: 'No account here is linked to this platform account.',
  account_disabled: 'The account linked to this platform account is disabled.',
  platform_unavailable: 'The platform could not be asked whether this token is valid. Try again shortly.'
};

/** The 401 (or, when the platform cannot be asked, 503) problem for a refusal; `invalid_token` for OAuth clients. */
export function platformTokenProblem(reason: PlatformTokenRefusal): HttpProblem {
  if (reason === 'platform_unavailable') return new HttpProblem(503, 'Platform unavailable', refusalText[reason], { extensions: { error: 'temporarily_unavailable', reason, step: 'platform-token' } });
  return new HttpProblem(401, 'Unauthorized', refusalText[reason], { extensions: { error: reason === 'tenant_ambiguous' ? 'tenant_ambiguous' : 'invalid_token', reason, step: 'platform-token' } });
}

export type PlatformTokenResult = { ok: true; principal: Principal } | { ok: false; reason: PlatformTokenRefusal; problem: HttpProblem };

interface Candidate {
  row: ProviderRow;
  cfg: ExprsnPlatformConfig;
}

export class PlatformTokens {
  private readonly signerCache = new Map<string, { until: number; certs: X509Certificate[] }>();
  private readonly answers = new Map<string, { until: number; answer: Introspection }>();
  private limiter: Limiter | null = null;

  constructor(private readonly s: () => Services) {}

  /** Refusals are audited at most once a minute per tenant, store and reason; acceptances are not audited. */
  private get auditLimit(): Limiter {
    return (this.limiter ??= new Limiter(this.s().counters, 'platform-token-refused-audit', 1, 60_000));
  }

  /** Active, enabled platform stores (any tenant) that accept tokens from this CA domain. */
  private async candidates(domain: string): Promise<Candidate[]> {
    const rows = (await this.s().db('identity_providers').where({ kind: 'exprsn-platform', enabled: true }).orderBy([{ column: 'tenant_id' }, { column: 'position' }])) as Record<string, unknown>[];
    const out: Candidate[] = [];
    for (const r of rows) {
      if (r.state === 'archived') continue;
      const row = await this.s().providers.get(String(r.tenant_id), String(r.id));
      if (!row || !row.enabled || row.state === 'archived') continue;
      const parsed = exprsnPlatformConfigSchema.safeParse(row.config);
      if (!parsed.success || !parsed.data.acceptApiTokens || parsed.data.tokenIssuer !== domain.toLowerCase()) continue;
      out.push({ row, cfg: parsed.data });
    }
    return out;
  }

  private async request(url: string, init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: unknown }> {
    const cfg = this.s().cfg;
    const policy = servicePolicy(cfg);
    const res = await guardedRequest({
      method: init.method,
      url: new URL(url),
      headers: { accept: 'application/json', 'user-agent': 'Exprsn-AI', ...init.headers },
      ...(init.body != null ? { body: init.body } : {}),
      timeoutMs: cfg.FEDERATION_TIMEOUT_MS,
      maxBytes: 1_000_000,
      check: (address, host) => serviceAddressProblem(address, host, policy)
    });
    let body: unknown;
    try {
      body = JSON.parse(res.body.toString('utf8'));
    } catch {
      body = null;
    }
    return { status: res.status, body };
  }

  /** The token-signing certificates the store trusts: non-CA certificates issued by a CA certificate of its bundle. */
  private async signers(c: Candidate): Promise<X509Certificate[]> {
    const key = `${c.row.id}:${c.row.updated_at}`;
    const hit = this.signerCache.get(key);
    if (hit && hit.until > Date.now()) return hit.certs;
    const bundle = parsePemCertificates(c.cfg.tokenTrustAnchor);
    const now = Date.now();
    const live = (x: X509Certificate) => Date.parse(x.validFrom) - PLATFORM_TOKEN_SKEW_MS <= now && now <= Date.parse(x.validTo) + PLATFORM_TOKEN_SKEW_MS;
    const anchors = bundle.filter((x) => x.ca && live(x));
    let leaves = bundle.filter((x) => !x.ca);
    if (c.cfg.tokenJwksUrl) {
      try {
        const r = await this.request(c.cfg.tokenJwksUrl, { method: 'GET' });
        const keys = r.status === 200 && r.body && typeof r.body === 'object' && Array.isArray((r.body as { keys?: unknown }).keys) ? ((r.body as { keys: unknown[] }).keys) : [];
        for (const k of keys.slice(0, 50)) {
          const x5c = (k as { x5c?: unknown }).x5c;
          if (Array.isArray(x5c) && typeof x5c[0] === 'string') {
            try {
              leaves.push(new X509Certificate(Buffer.from(x5c[0], 'base64')));
            } catch {
              /* a key whose certificate does not parse is not a signer */
            }
          }
        }
      } catch (err) {
        this.s().log.warn({ provider: c.row.id, err: (err as Error).message }, 'platform token JWKS fetch failed');
      }
    }
    leaves = leaves.filter((x) => !x.ca && live(x) && anchors.some((a) => x.checkIssued(a) && x.verify(a.publicKey)));
    this.signerCache.set(key, { until: now + JWKS_TTL_MS, certs: leaves });
    return leaves;
  }

  /**
   * `ok` when the signature verifies under one of the store's signers; `named` when it does not but the token names
   * one of them by serial (for a v2 token: what it presents is not what was signed); `no` otherwise.
   */
  private async signatureVerifies(c: Candidate, t: PresentedPlatformToken): Promise<'ok' | 'named' | 'no'> {
    let certs: X509Certificate[];
    try {
      certs = await this.signers(c);
    } catch {
      return 'no';
    }
    const text = platformSigVersion(t) === 2 ? platformSigningInputV2(t) : platformSigningInput(t);
    const wanted = serialKey(t.issuer.certificateSerial);
    const named = certs.some((x) => serialKey(x.serialNumber) === wanted);
    if (text == null) return named ? 'named' : 'no';
    const input = Buffer.from(text, 'utf8');
    const sig = Buffer.from(t.signature, 'base64');
    const ordered = [...certs.filter((x) => serialKey(x.serialNumber) === wanted), ...certs.filter((x) => serialKey(x.serialNumber) !== wanted)];
    const ok = ordered.some((x) => {
      if (x.publicKey.asymmetricKeyType !== 'rsa' && x.publicKey.asymmetricKeyType !== 'rsa-pss') return false;
      try {
        return verify('sha256', input, { key: x.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, sig);
      } catch {
        return false;
      }
    });
    return ok ? 'ok' : named ? 'named' : 'no';
  }

  /** The CA's validation answer for the token id (cached for `tokenCacheSeconds`, never past the token's expiry). */
  private async introspect(c: Candidate, t: PresentedPlatformToken, expiresAt: number): Promise<Introspection> {
    const key = `${c.row.id}:${c.row.updated_at}:${t.id}`;
    const hit = this.answers.get(key);
    if (hit && hit.until > Date.now()) return hit.answer;
    const secret = await resolveSecretRef(c.cfg.tokenServiceToken!, (r) => this.s().vault.resolveFor(c.row.tenant_id, c.row.vault_owner, r, { via: `identity-provider:${c.row.id}` }));
    const r = await this.request(c.cfg.tokenValidateUrl!, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-service-id': c.cfg.tokenServiceId, 'x-service-token': secret },
      body: JSON.stringify({ tokenId: t.id, resource: c.cfg.apiAudience })
    });
    const parsed = validateAnswer.safeParse(r.body);
    if (!parsed.success || (r.status !== 200 && r.status !== 401) || (r.status === 401 && parsed.data.valid !== false)) throw new Error(`The validation endpoint answered HTTP ${r.status}.`);
    const a = parsed.data;
    let answer: Introspection;
    if (!a.valid) {
      const e = a.error ?? '';
      answer = { valid: false, reason: e === 'TOKEN_EXPIRED' ? 'expired' : e === 'TOKEN_NOT_YET_VALID' ? 'not_yet_valid' : e === 'RESOURCE_MISMATCH' ? 'wrong_audience' : e === 'INVALID_SIGNATURE' ? 'bad_signature' : e === 'SIGNATURE_SCHEME_RETIRED' ? 'unsigned_claims' : 'revoked' };
    } else {
      const sub = a.userId ?? (a.token?.data && typeof a.token.data === 'object' ? (a.token.data as { userId?: unknown }).userId : undefined);
      const res = a.token?.resource;
      if (!a.token || a.token.id !== t.id || typeof sub !== 'string' || !SUB.test(sub) || (a.token.expiryType && a.token.expiryType !== 'time')) answer = { valid: false, reason: 'claims_mismatch' };
      else answer = { valid: true, sub, bits: bitsOf(a.token.permissions), resource: res && typeof res.url === 'string' ? res.url : null, sigVersion: a.token.sigVersion ?? null, mfa: a.token.mfa === true };
    }
    const ttl = Math.min(c.cfg.tokenCacheSeconds * 1000, Math.max(0, expiresAt - Date.now()));
    if (ttl > 0) {
      if (this.answers.size >= MAX_CACHE) this.answers.delete(this.answers.keys().next().value!);
      this.answers.set(key, { until: Date.now() + ttl, answer });
    }
    return answer;
  }

  /** Audits a refusal in each tenant concerned, at most once a minute per tenant, store and reason (no token text). */
  private async refused(stores: Candidate[], reason: PlatformTokenRefusal, ctx: { ip: string | null; traceId?: string | null }): Promise<void> {
    const seen = new Set<string>();
    for (const c of stores.slice(0, 10)) {
      if (seen.has(c.row.tenant_id)) continue;
      seen.add(c.row.tenant_id);
      try {
        const r = await this.auditLimit.consume(`${c.row.tenant_id}:${c.row.id}:${reason}`);
        if (!r.allowed) continue;
        await this.s().audit.append({ tenantId: c.row.tenant_id, action: 'identity.platform_token.refused', kind: 'auth', actor: { ip: ctx.ip }, target: { provider: c.row.id, name: c.row.name }, detail: { reason }, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
      } catch (err) {
        this.s().log.warn({ err: (err as Error).message }, 'platform token refusal audit failed');
      }
    }
  }

  /**
   * Authenticates a bearer that looks like a platform CA token. `load` builds the principal for the linked account
   * (null when the account or tenant is not active), as for any other credential.
   */
  async authenticate(bearer: string, ctx: { tenant: string | null; ip: string | null; traceId?: string | null }, load: (tenantId: string, userId: string) => Promise<Principal | null>): Promise<PlatformTokenResult> {
    const fail = async (reason: PlatformTokenRefusal, audited: Candidate[] = []): Promise<PlatformTokenResult> => {
      if (audited.length) await this.refused(audited, reason, ctx);
      return { ok: false, reason, problem: platformTokenProblem(reason) };
    };
    const t = decodePlatformToken(bearer);
    if (!t) return fail('malformed');
    // No store opted in for this CA: the same answer as any unknown token (and nothing is audited).
    const stores = await this.candidates(t.issuer.domain);
    if (!stores.length) return fail('malformed');
    const v2 = platformSigVersion(t) === 2;
    const matched: Candidate[] = [];
    const named: Candidate[] = [];
    for (const c of stores) {
      const v = await this.signatureVerifies(c, t);
      if (v === 'ok') matched.push(c);
      else if (v === 'named') named.push(c);
    }
    // A v2 token from a trusted signing certificate whose signature does not cover what it presents: a changed field.
    if (!matched.length && v2 && named.length) return fail('signature_invalid', named);
    if (!matched.length) return fail('bad_signature', stores);
    let chosen = matched;
    if (ctx.tenant) {
      const tenant = await this.s().tenants.bySlug(ctx.tenant.trim().toLowerCase());
      chosen = tenant ? matched.filter((c) => c.row.tenant_id === tenant.id) : [];
      if (!chosen.length) return fail('tenant_mismatch', matched);
    } else if (new Set(matched.map((c) => c.row.tenant_id)).size > 1) {
      return fail('tenant_ambiguous', matched);
    }
    const now = Date.now();
    if (t.expiryType !== 'time' || t.expiresAt == null) return fail('no_expiry', chosen);
    const exp = Number(t.expiresAt);
    if (now > exp + PLATFORM_TOKEN_SKEW_MS) return fail('expired', chosen);
    if ((t.notBefore != null && Number(t.notBefore) > now + PLATFORM_TOKEN_SKEW_MS) || Number(t.issuedAt) > now + PLATFORM_TOKEN_SKEW_MS) return fail('not_yet_valid', chosen);
    let last: PlatformTokenRefusal = 'unlinked';
    for (const c of chosen) {
      if (!v2 && c.cfg.requireSignedClaims) return fail('unsigned_claims', [c]);
      let a: Introspection;
      try {
        a = await this.introspect(c, t, exp + PLATFORM_TOKEN_SKEW_MS);
      } catch (err) {
        this.s().log.warn({ provider: c.row.id, err: (err as Error).message }, 'platform token validation failed');
        return fail('platform_unavailable', [c]);
      }
      if (!a.valid) return fail(a.reason, [c]);
      // The account, bits and resource are the platform's (the signature does not cover them); a presented account
      // id that differs is a forgery of the unsigned part.
      const presented = t.data && typeof t.data === 'object' ? (t.data as { userId?: unknown }).userId : undefined;
      if (presented !== undefined && presented !== a.sub) return fail('claims_mismatch', [c]);
      // v2: the signed bits and resource are the token's; they must be what the platform holds for it.
      if (v2) {
        const signedBits = bitsOf(t.permissions);
        const signedResource = typeof t.resource.url === 'string' ? t.resource.url : null;
        if (presented === undefined || (a.sigVersion != null && a.sigVersion !== 2) || signedResource !== a.resource || signedBits.size !== a.bits.size || [...signedBits].some((b) => !a.bits.has(b)) || (t.mfa === true) !== a.mfa) return fail('claims_mismatch', [c]);
      }
      if (!a.resource || !resourceMatches(c.cfg.apiAudience, a.resource)) return fail('wrong_audience', [c]);
      const link = await this.s().users.identity(c.row.id, a.sub);
      if (!link) {
        last = 'unlinked';
        continue;
      }
      const p = await load(c.row.tenant_id, link.user_id);
      if (!p) {
        last = 'account_disabled';
        continue;
      }
      // The account's own roles, narrowed by the store's table for the token's bits (an unlisted bit grants nothing).
      // Not a session: no CSRF token and no step-up. Admin roles that need a second factor work only with a v2 token
      // that carries the CA's signed mfa claim (checked against its answer above), or where the store waives it.
      p.kind = 'user';
      p.mfa = (v2 && t.mfa === true && a.mfa) || c.cfg.adminTokensWithoutMfa === true;
      p.sessionId = null;
      p.apiKeyId = null;
      p.scopes = scopesFor(a.bits, c.cfg.scopeMap);
      p.platformToken = { storeId: c.row.id };
      return { ok: true, principal: p };
    }
    return fail(last, chosen);
  }
}
