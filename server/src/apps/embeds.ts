import { createHmac, createPublicKey, createVerify, randomBytes, timingSafeEqual, verify as cryptoVerify, X509Certificate, type KeyObject } from 'node:crypto';
import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import type { Principal } from '../authz/policy.js';
import { randomToken, sha256 } from '../crypto/index.js';
import { json } from '../db/knex.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { AppKeyScope } from '../identity/apikeys.js';
import type { Services } from '../services.js';
import type { FormRow } from './forms.js';
import type { Actor, AppRow, AppService, EntityRow } from './service.js';

/*
 * 1.6.0, Sprint 39d (B-8701, B-8702): embedding an app in another site.
 *
 * Public embeds: a public form (one with a link token) is published as an embed page under a random id, and the page
 * is served with `frame-ancestors` naming the host sites the app's designers listed, so a browser frames it on those
 * sites and nowhere else. The form's link token stays private: the page opens and submits the form by the embed id.
 *
 * Signed embeds: the host site signs a short-lived JWT with a key registered for the app (ES256, RS256 or EdDSA public
 * key, an HS256 secret, or a certificate the tenant CA issued, carried as `x5c`), naming the app as audience and the
 * person by a claim the designers chose (`sub` as a username by default). The embed page exchanges it for an embedded
 * session: a bearer token of its own (`exe_…`), apart from console sessions and cookies, that acts as the mapped user
 * within the app only, with `records:read` and, if the app allows, `records:write`, for the shorter of the token's
 * expiry, the app's limit and APP_EMBED_MAX_TTL_SECONDS. Every exchange is audited; a `jti` is accepted once per key.
 */

export const EMBED_ALGS = ['ES256', 'RS256', 'HS256', 'EdDSA', 'x5c'] as const;
export type EmbedAlg = (typeof EMBED_ALGS)[number];
export const CLAIM_MATCHES = ['username', 'email', 'id'] as const;
export type ClaimMatch = (typeof CLAIM_MATCHES)[number];

export interface EmbedConfig {
  publicEnabled: boolean;
  allowedHosts: string[];
  signedEnabled: boolean;
  claimName: string;
  claimMatch: ClaimMatch;
  maxTtlSeconds: number;
  write: boolean;
  entities: string[] | null;
  updatedBy: string | null;
  updatedAt: number | null;
}

export interface EmbedKeyRow {
  id: string;
  tenant_id: string;
  app_id: string;
  kid: string;
  alg: EmbedAlg;
  public_key_pem: string | null;
  secret: string | null;
  created_by: string | null;
  created_at: number;
  revoked_at: number | null;
}

export interface EmbedPageRow {
  id: string;
  tenant_id: string;
  app_id: string;
  form_id: string;
  enabled: boolean;
  created_by: string | null;
  created_at: number;
}

export interface EmbedSessionRow {
  id: string;
  tenant_id: string;
  app_id: string;
  user_id: string;
  key_id: string;
  jti: string;
  token_hash: string;
  host: string | null;
  ip: string | null;
  expires_at: number;
  created_at: number;
  last_seen_at: number;
  revoked_at: number | null;
  /** What the session may reach (B-8601's shape): the app, and the entities the app's settings list. */
  scope: AppKeyScope;
  write: boolean;
}

const HOST = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;
export const hostSchema = z.string().trim().regex(HOST, 'an origin: https://host[:port]').max(300);

export const embedConfigSchema = z
  .object({
    publicEnabled: z.boolean().optional(),
    allowedHosts: z.array(hostSchema).max(50).optional(),
    signedEnabled: z.boolean().optional(),
    claimName: z.string().trim().regex(/^[A-Za-z0-9_.:-]{1,60}$/, 'a claim name').optional(),
    claimMatch: z.enum(CLAIM_MATCHES).optional(),
    maxTtlSeconds: z.number().int().min(60).max(86_400).optional(),
    write: z.boolean().optional(),
    entities: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/)).max(200).nullable().optional()
  })
  .strict();
export type EmbedConfigPatch = z.infer<typeof embedConfigSchema>;

export const embedKeyInputSchema = z
  .object({
    kid: z.string().trim().regex(/^[A-Za-z0-9_.:-]{1,100}$/, 'letters, digits, _ . : -'),
    alg: z.enum(EMBED_ALGS),
    /** ES256, RS256, EdDSA: the public key (PEM, SPKI). */
    publicKey: z.string().trim().min(1).max(8000).optional(),
    /** HS256: the shared secret (base64url, at least 32 bytes); generated when absent and shown once. */
    secret: z.string().trim().regex(/^[A-Za-z0-9_-]{43,200}$/).optional()
  })
  .strict();
export type EmbedKeyInput = z.infer<typeof embedKeyInputSchema>;

const keyFrom = (r: Record<string, unknown>): EmbedKeyRow => ({ ...(r as unknown as EmbedKeyRow), created_at: Number(r.created_at), revoked_at: r.revoked_at == null ? null : Number(r.revoked_at) });
const pageFrom = (r: Record<string, unknown>): EmbedPageRow => ({ ...(r as unknown as EmbedPageRow), enabled: !!r.enabled, created_at: Number(r.created_at) });

export const embedKeyView = (k: EmbedKeyRow) => ({ id: k.id, kid: k.kid, alg: k.alg, publicKey: k.public_key_pem, createdBy: k.created_by, createdAt: k.created_at, revokedAt: k.revoked_at, state: k.revoked_at ? 'revoked' : 'active' });

const b64url = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const CLOCK_SKEW_MS = 60_000;

export class EmbedTokenError extends HttpProblem {
  constructor(detail: string) {
    super(401, 'Unauthorized', detail, { extensions: { error: 'invalid_token' } });
  }
}

export class AppEmbeds {
  constructor(
    private readonly s: () => Services,
    private readonly apps: AppService
  ) {}

  private get db() {
    return this.s().db;
  }

  // ---------- settings ----------

  async config(app: Pick<AppRow, 'id'>): Promise<EmbedConfig> {
    const r = (await this.db('app_embeds').where({ app_id: app.id }).first()) as Record<string, unknown> | undefined;
    if (!r) return { publicEnabled: false, allowedHosts: [], signedEnabled: false, claimName: 'sub', claimMatch: 'username', maxTtlSeconds: 900, write: false, entities: null, updatedBy: null, updatedAt: null };
    return {
      publicEnabled: !!r.public_enabled,
      allowedHosts: json<string[]>(r.allowed_hosts, []),
      signedEnabled: !!r.signed_enabled,
      claimName: String(r.claim_name),
      claimMatch: (CLAIM_MATCHES as readonly string[]).includes(String(r.claim_match)) ? (String(r.claim_match) as ClaimMatch) : 'username',
      maxTtlSeconds: Number(r.max_ttl_seconds),
      write: !!r.write,
      entities: r.entities == null ? null : json<string[] | null>(r.entities, null),
      updatedBy: r.updated_by == null ? null : String(r.updated_by),
      updatedAt: Number(r.updated_at)
    };
  }

  async update(actor: Actor & { principal: Principal }, app: AppRow, patch: EmbedConfigPatch): Promise<EmbedConfig> {
    const cur = await this.config(app);
    const next: EmbedConfig = { ...cur, ...stripUndefined(patch), updatedBy: actor.principal.userId, updatedAt: Date.now() };
    if (next.entities) {
      const names = new Set((await this.apps.entities(app)).map((e) => e.name));
      const unknown = next.entities.filter((n) => !names.has(n));
      if (unknown.length) throw badRequest(`This app has no entity ${unknown.join(', ')}.`);
    }
    const row = { tenant_id: app.tenant_id, public_enabled: next.publicEnabled, allowed_hosts: JSON.stringify(next.allowedHosts), signed_enabled: next.signedEnabled, claim_name: next.claimName, claim_match: next.claimMatch, max_ttl_seconds: next.maxTtlSeconds, write: next.write, entities: next.entities ? JSON.stringify(next.entities) : null, updated_by: next.updatedBy, updated_at: next.updatedAt };
    const n = await this.db('app_embeds').where({ app_id: app.id }).update(row);
    if (!n) await this.db('app_embeds').insert({ app_id: app.id, ...row });
    await this.s().audit.append({ tenantId: app.tenant_id, action: 'app.embed.updated', kind: 'admin', actor: actorFrom(actor.principal, actor.ip ?? null), target: { app: app.id, name: app.name }, label: app.label, detail: { publicEnabled: next.publicEnabled, allowedHosts: next.allowedHosts, signedEnabled: next.signedEnabled, claim: `${next.claimName} as ${next.claimMatch}`, maxTtlSeconds: next.maxTtlSeconds, write: next.write, entities: next.entities }, traceId: actor.traceId ?? null });
    return next;
  }

  /** The `frame-ancestors` sources an embed page of the app is served with: the console's own origin and the hosts. */
  frameAncestors(config: EmbedConfig): string[] {
    return ["'self'", ...config.allowedHosts.map((h) => h.toLowerCase())];
  }

  // ---------- keys (B-8702) ----------

  async keys(app: Pick<AppRow, 'id'>): Promise<EmbedKeyRow[]> {
    return ((await this.db('app_embed_keys').where({ app_id: app.id }).orderBy('created_at', 'desc')) as Record<string, unknown>[]).map(keyFrom);
  }

  async addKey(actor: Actor & { principal: Principal }, app: AppRow, input: EmbedKeyInput): Promise<{ key: EmbedKeyRow; secret: string | null }> {
    const s = this.s();
    if (await this.db('app_embed_keys').where({ app_id: app.id, kid: input.kid }).first('id')) throw conflict(`There is already a key ${input.kid} on this app.`);
    let publicKeyPem: string | null = null;
    let secret: string | null = null;
    if (input.alg === 'HS256') {
      if (input.publicKey) throw badRequest('An HS256 key is a shared secret, not a public key.');
      secret = input.secret ?? randomBytes(32).toString('base64url');
    } else if (input.alg === 'x5c') {
      if (input.publicKey || input.secret) throw badRequest('A tenant CA key needs no key material: the token carries the certificate the CA issued.');
      if (!(await s.pki.activeIntermediate(app.tenant_id))) throw conflict('This tenant has no active certificate authority to verify host certificates with.');
    } else {
      if (!input.publicKey) throw badRequest(`A ${input.alg} key needs the public key (PEM).`);
      if (input.secret) throw badRequest(`A ${input.alg} key is a public key, not a secret.`);
      let key: KeyObject;
      try {
        key = createPublicKey(input.publicKey);
      } catch {
        throw badRequest('The public key is not a PEM public key.');
      }
      const want = input.alg === 'ES256' ? 'ec' : input.alg === 'RS256' ? 'rsa' : 'ed25519';
      if (key.asymmetricKeyType !== want || (want === 'ec' && key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') || (want === 'rsa' && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)) throw badRequest(`A ${input.alg} key is ${want === 'ec' ? 'an EC P-256' : want === 'rsa' ? 'an RSA key of at least 2048 bits' : 'an Ed25519 key'}.`);
      publicKeyPem = key.export({ type: 'spki', format: 'pem' }).toString();
    }
    const row = { id: ulid(), tenant_id: app.tenant_id, app_id: app.id, kid: input.kid, alg: input.alg, public_key_pem: publicKeyPem, secret: secret ? await s.keys.seal(app.tenant_id, secret, `embedkey:${app.id}:${input.kid}`) : null, created_by: actor.principal.userId, created_at: Date.now(), revoked_at: null };
    await this.db('app_embed_keys').insert(row);
    await s.audit.append({ tenantId: app.tenant_id, action: 'app.embed.key.created', kind: 'admin', actor: actorFrom(actor.principal, actor.ip ?? null), target: { app: app.id, name: app.name, key: row.id }, label: app.label, detail: { kid: input.kid, alg: input.alg }, traceId: actor.traceId ?? null });
    return { key: keyFrom(row), secret };
  }

  async revokeKey(actor: Actor & { principal: Principal }, app: AppRow, id: string): Promise<EmbedKeyRow> {
    const r = (await this.db('app_embed_keys').where({ app_id: app.id, id }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Embed key');
    const key = keyFrom(r);
    if (!key.revoked_at) {
      await this.db('app_embed_keys').where({ id }).update({ revoked_at: Date.now() });
      // Sessions it made end with it.
      await this.db('app_embed_sessions').where({ key_id: id, revoked_at: null }).update({ revoked_at: Date.now() });
      await this.s().audit.append({ tenantId: app.tenant_id, action: 'app.embed.key.revoked', kind: 'admin', actor: actorFrom(actor.principal, actor.ip ?? null), target: { app: app.id, name: app.name, key: id }, label: app.label, detail: { kid: key.kid, alg: key.alg }, traceId: actor.traceId ?? null });
    }
    return { ...key, revoked_at: key.revoked_at ?? Date.now() };
  }

  // ---------- public pages (B-8701) ----------

  async pages(app: Pick<AppRow, 'id'>): Promise<(EmbedPageRow & { form: FormRow; entity: EntityRow })[]> {
    const rows = ((await this.db('app_embed_pages').where({ app_id: app.id }).orderBy('created_at', 'desc')) as Record<string, unknown>[]).map(pageFrom);
    const forms = await this.apps.forms.list(app as AppRow);
    const byId = new Map(forms.map((f) => [f.form.id, f]));
    return rows.flatMap((p) => {
      const f = byId.get(p.form_id);
      return f ? [{ ...p, form: f.form, entity: f.entity }] : [];
    });
  }

  async addPage(actor: Actor & { principal: Principal }, app: AppRow, formRef: string): Promise<EmbedPageRow & { form: FormRow; entity: EntityRow }> {
    const { form, entity } = await this.apps.forms.form(actor.principal, app.id, formRef);
    if (!form.public) throw conflict('Only a public form can be embedded: publish it with a public link first.');
    const existing = (await this.db('app_embed_pages').where({ app_id: app.id, form_id: form.id }).first()) as Record<string, unknown> | undefined;
    if (existing) return { ...pageFrom(existing), form, entity };
    const row = { id: ulid(), tenant_id: app.tenant_id, app_id: app.id, form_id: form.id, enabled: true, created_by: actor.principal.userId, created_at: Date.now() };
    await this.db('app_embed_pages').insert(row);
    await this.s().audit.append({ tenantId: app.tenant_id, action: 'app.embed.page.created', kind: 'admin', actor: actorFrom(actor.principal, actor.ip ?? null), target: { app: app.id, name: app.name, form: form.id, page: row.id }, label: app.label, detail: { form: form.name }, traceId: actor.traceId ?? null });
    return { ...pageFrom(row), form, entity };
  }

  async removePage(actor: Actor & { principal: Principal }, app: AppRow, id: string): Promise<void> {
    const r = (await this.db('app_embed_pages').where({ app_id: app.id, id }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Embed page');
    await this.db('app_embed_pages').where({ id }).delete();
    await this.s().audit.append({ tenantId: app.tenant_id, action: 'app.embed.page.removed', kind: 'admin', actor: actorFrom(actor.principal, actor.ip ?? null), target: { app: app.id, name: app.name, page: id, form: String(r.form_id) }, label: app.label, detail: {}, traceId: actor.traceId ?? null });
  }

  /** A public embed page by its id: the app, form and entity behind it, if everything on the way is on. */
  async pageById(id: string): Promise<{ app: AppRow; entity: EntityRow; form: FormRow; config: EmbedConfig; page: EmbedPageRow }> {
    const r = (await this.db('app_embed_pages').where({ id }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Embed');
    const page = pageFrom(r);
    const s = this.s();
    const tenant = await s.tenants.byId(page.tenant_id);
    const app = await this.apps.appById(page.tenant_id, page.app_id);
    const form = app ? (await this.apps.forms.list(app)).find((f) => f.form.id === page.form_id) : undefined;
    if (!tenant || tenant.state !== 'active' || !app || !form || !form.form.public || !page.enabled) throw notFound('Embed');
    const config = await this.config(app);
    if (!config.publicEnabled) throw notFound('Embed');
    return { app, entity: form.entity, form: form.form, config, page };
  }

  /** The signed-embed page of an app: the app and its settings, if signed embeds are on. */
  async signedApp(tenantId: string, appRef: string): Promise<{ app: AppRow; config: EmbedConfig }> {
    const s = this.s();
    const tenant = await s.tenants.byId(tenantId);
    const app = tenant && tenant.state === 'active' ? await this.appByRef(tenantId, appRef) : undefined;
    if (!app) throw notFound('Embed');
    const config = await this.config(app);
    if (!config.signedEnabled) throw notFound('Embed');
    return { app, config };
  }

  private async appByRef(tenantId: string, ref: string): Promise<AppRow | undefined> {
    const byId = await this.apps.appById(tenantId, ref);
    if (byId) return byId;
    const r = await this.db('apps').where({ tenant_id: tenantId, name: ref }).first('id');
    return r ? this.apps.appById(tenantId, String(r.id)) : undefined;
  }

  // ---------- signed embeds: the exchange (B-8702) ----------

  /** The audience a host token must name for an app. */
  static audience(app: Pick<AppRow, 'id'>): string {
    return `exprsn-ai:app:${app.id}`;
  }

  /**
   * Verifies a host-signed token for the app and opens an embedded session as the person it names. Refusals are 401
   * `invalid_token` with the reason; the exchange is audited either way.
   */
  async exchange(tenantId: string, appRef: string, token: string, o: { ip: string | null; traceId?: string | null }): Promise<{ token: string; expiresAt: number; session: EmbedSessionRow; app: AppRow; user: { id: string; username: string; displayName: string }; config: EmbedConfig }> {
    const s = this.s();
    const { app, config } = await this.signedApp(tenantId, appRef);
    const audit = (action: 'app.embed.session.created' | 'app.embed.session.refused', detail: Record<string, unknown>, userId: string | null) =>
      s.audit.append({ tenantId: app.tenant_id, action, kind: 'auth', actor: userId ? { user: userId, via: 'embed', ...(o.ip ? { ip: o.ip } : {}) } : { service: 'apps.embeds', ...(o.ip ? { ip: o.ip } : {}) }, target: { app: app.id, name: app.name }, label: app.label, detail, traceId: o.traceId ?? null });
    const refuse = async (reason: string, detail: Record<string, unknown> = {}): Promise<never> => {
      await audit('app.embed.session.refused', { reason, ...detail }, null);
      throw new EmbedTokenError(reason);
    };
    const parts = token.split('.');
    if (parts.length !== 3) return refuse('The token is not a JWT.');
    let header: Record<string, unknown>;
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(b64url(parts[0]!).toString('utf8')) as Record<string, unknown>;
      claims = JSON.parse(b64url(parts[1]!).toString('utf8')) as Record<string, unknown>;
    } catch {
      return refuse('The token is not a JWT.');
    }
    if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object') return refuse('The token is not a JWT.');
    const kid = typeof header.kid === 'string' ? header.kid : null;
    const alg = typeof header.alg === 'string' ? header.alg : null;
    if (!kid || !alg) return refuse('The token names no kid or alg.');
    const keyRow = (await this.db('app_embed_keys').where({ app_id: app.id, kid }).first()) as Record<string, unknown> | undefined;
    if (!keyRow) return refuse(`No key ${kid} is registered for this app.`, { kid });
    const key = keyFrom(keyRow);
    if (key.revoked_at) return refuse(`The key ${kid} was revoked.`, { kid });
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8');
    const sig = b64url(parts[2]!);
    let ok: boolean;
    try {
      if (key.alg === 'HS256') {
        if (alg !== 'HS256') return refuse(`The key ${kid} signs HS256 tokens, not ${alg}.`, { kid, alg });
        const secret = await s.keys.open(app.tenant_id, key.secret!, `embedkey:${app.id}:${key.kid}`);
        const want = createHmac('sha256', Buffer.from(secret, 'base64url')).update(signed).digest();
        ok = want.length === sig.length && timingSafeEqual(want, sig);
      } else if (key.alg === 'x5c') {
        if (alg !== 'ES256' && alg !== 'RS256') return refuse('A certificate-signed token is ES256 or RS256.', { kid, alg });
        const x5c = Array.isArray(header.x5c) ? (header.x5c as unknown[]) : [];
        if (!x5c.length || typeof x5c[0] !== 'string') return refuse('The token carries no certificate (x5c).', { kid });
        const leaf = new X509Certificate(Buffer.from(x5c[0], 'base64'));
        const ca = await s.pki.activeIntermediate(app.tenant_id);
        if (!ca) return refuse('This tenant has no active certificate authority.', { kid });
        const issuer = new X509Certificate(ca.certificate_pem);
        const now = Date.now();
        if (!leaf.checkIssued(issuer) || !leaf.verify(issuer.publicKey)) return refuse('The certificate was not issued by the tenant CA.', { kid, subject: leaf.subject });
        if (new Date(leaf.validFrom).getTime() > now + CLOCK_SKEW_MS || new Date(leaf.validTo).getTime() < now) return refuse('The certificate is not valid now.', { kid, subject: leaf.subject });
        if (await this.db('pki_certificates').where({ issuer_id: ca.id, state: 'revoked' }).whereRaw('lower(serial) = ?', [leaf.serialNumber.toLowerCase()]).first('id')) return refuse('The certificate was revoked.', { kid, serial: leaf.serialNumber });
        ok = verifyWith(leaf.publicKey, alg, signed, sig);
      } else {
        if (alg !== key.alg) return refuse(`The key ${kid} signs ${key.alg} tokens, not ${alg}.`, { kid, alg });
        ok = verifyWith(createPublicKey(key.public_key_pem!), alg, signed, sig);
      }
    } catch {
      ok = false;
    }
    if (!ok) return refuse('The token signature does not verify.', { kid, alg });
    // Claims.
    const now = Date.now();
    const aud = Array.isArray(claims.aud) ? (claims.aud as unknown[]) : [claims.aud];
    if (!aud.includes(AppEmbeds.audience(app))) return refuse(`The token's audience is not this app (${AppEmbeds.audience(app)}).`, { kid });
    const exp = typeof claims.exp === 'number' ? claims.exp * 1000 : null;
    if (!exp) return refuse('The token has no exp.', { kid });
    if (exp < now - CLOCK_SKEW_MS) return refuse('The token has expired.', { kid });
    const ttlCap = Math.min(config.maxTtlSeconds, s.cfg.APP_EMBED_MAX_TTL_SECONDS) * 1000;
    if (typeof claims.iat === 'number' && claims.iat * 1000 > now + CLOCK_SKEW_MS) return refuse('The token is issued in the future.', { kid });
    if (typeof claims.nbf === 'number' && claims.nbf * 1000 > now + CLOCK_SKEW_MS) return refuse('The token is not valid yet.', { kid });
    const jti = typeof claims.jti === 'string' && claims.jti.length <= 200 ? claims.jti : null;
    if (!jti) return refuse('The token has no jti.', { kid });
    const value = claims[config.claimName];
    if (typeof value !== 'string' || !value) return refuse(`The token's ${config.claimName} claim names no one.`, { kid });
    const user = await this.userByClaim(app.tenant_id, config.claimMatch, value);
    if (!user || user.state !== 'active') return refuse(`No active user matches the ${config.claimName} claim.`, { kid, claim: config.claimName });
    if (await this.db('app_embed_sessions').where({ key_id: key.id, jti }).first('id')) return refuse('The token was already used (jti).', { kid, jti });
    const expiresAt = Math.min(exp, now + ttlCap);
    const sessionToken = `exe_${randomToken(32)}`;
    const row = { id: ulid(), tenant_id: app.tenant_id, app_id: app.id, user_id: user.id, key_id: key.id, jti, token_hash: sha256(sessionToken), host: typeof claims.iss === 'string' ? claims.iss.slice(0, 300) : null, ip: o.ip, expires_at: expiresAt, created_at: now, last_seen_at: now, revoked_at: null };
    await this.db('app_embed_sessions').insert(row);
    await audit('app.embed.session.created', { kid, alg: key.alg, jti, iss: row.host, expiresAt, write: config.write, entities: config.entities }, user.id);
    const session: EmbedSessionRow = { ...row, scope: { app: app.id, entity: null, entities: config.entities }, write: config.write };
    return { token: sessionToken, expiresAt, session, app, user: { id: user.id, username: user.username, displayName: user.display_name }, config };
  }

  private async userByClaim(tenantId: string, match: ClaimMatch, value: string) {
    const s = this.s();
    if (match === 'id') return s.users.get(tenantId, value);
    if (match === 'username') return s.users.byUsername(tenantId, value);
    const r = (await this.db('users').where({ tenant_id: tenantId }).whereRaw('lower(email) = ?', [value.toLowerCase()]).first()) as Record<string, unknown> | undefined;
    return r ? s.users.get(tenantId, String(r.id)) : undefined;
  }

  /** The embedded session a bearer token names, with its scope; null when it is unknown, expired or revoked. */
  async resolveSession(token: string): Promise<EmbedSessionRow | null> {
    if (!/^exe_[A-Za-z0-9_-]{40,}$/.test(token)) return null;
    const r = (await this.db('app_embed_sessions').where({ token_hash: sha256(token) }).first()) as Record<string, unknown> | undefined;
    if (!r) return null;
    const now = Date.now();
    if (r.revoked_at != null || Number(r.expires_at) <= now) return null;
    const app = await this.apps.appById(String(r.tenant_id), String(r.app_id));
    if (!app) return null;
    const config = await this.config(app);
    if (!config.signedEnabled) return null;
    if (now - Number(r.last_seen_at) > 60_000) await this.db('app_embed_sessions').where({ id: String(r.id) }).update({ last_seen_at: now });
    return { ...(r as unknown as EmbedSessionRow), expires_at: Number(r.expires_at), created_at: Number(r.created_at), last_seen_at: Number(r.last_seen_at), revoked_at: null, scope: { app: app.id, entity: null, entities: config.entities }, write: config.write };
  }

  async sessions(app: Pick<AppRow, 'id'>, limit = 100): Promise<(EmbedSessionRow & { username: string | null })[]> {
    const rows = (await this.db('app_embed_sessions as e').leftJoin('users as u', 'u.id', 'e.user_id').where({ 'e.app_id': app.id }).orderBy('e.created_at', 'desc').limit(limit).select('e.*', 'u.username as username')) as Record<string, unknown>[];
    return rows.map((r) => ({ ...(r as unknown as EmbedSessionRow), username: r.username == null ? null : String(r.username), expires_at: Number(r.expires_at), created_at: Number(r.created_at), last_seen_at: Number(r.last_seen_at), revoked_at: r.revoked_at == null ? null : Number(r.revoked_at), scope: { app: app.id, entity: null }, write: false }));
  }

  async revokeSessions(actor: Actor & { principal: Principal }, app: AppRow, id?: string): Promise<number> {
    const q = this.db('app_embed_sessions').where({ app_id: app.id, revoked_at: null });
    if (id) q.andWhere({ id });
    const n = await q.update({ revoked_at: Date.now() });
    await this.s().audit.append({ tenantId: app.tenant_id, action: 'app.embed.sessions.revoked', kind: 'admin', actor: actorFrom(actor.principal, actor.ip ?? null), target: { app: app.id, name: app.name, ...(id ? { session: id } : {}) }, label: app.label, detail: { count: n }, traceId: actor.traceId ?? null });
    return n;
  }

  /** Ended sessions older than a day are dropped (the `jti` uniqueness they carried has served its purpose by then). */
  async purge(): Promise<number> {
    const cutoff = Date.now() - 86_400_000;
    return this.db('app_embed_sessions').where('expires_at', '<', cutoff).delete();
  }

  /** The permissions an embedded session holds: reads, and writes when the app allows them. */
  static scopesFor(session: Pick<EmbedSessionRow, 'write'>): ('records:read' | 'records:write')[] {
    return session.write ? ['records:read', 'records:write'] : ['records:read'];
  }

  /** Refuses an embedded session reaching an entity the app's settings leave out. */
  static checkEntity(session: EmbedSessionRow, entityName: string): void {
    if (session.scope.entities && !session.scope.entities.includes(entityName)) throw forbidden(`This embedded session does not reach the entity ${entityName}.`, { step: 'scope' });
  }
}

function verifyWith(key: KeyObject, alg: string, data: Buffer, sig: Buffer): boolean {
  if (alg === 'ES256') return key.asymmetricKeyType === 'ec' && createVerify('SHA256').update(data).verify({ key, dsaEncoding: 'ieee-p1363' }, sig);
  if (alg === 'RS256') return key.asymmetricKeyType === 'rsa' && createVerify('SHA256').update(data).verify(key, sig);
  if (alg === 'EdDSA') return key.asymmetricKeyType === 'ed25519' && cryptoVerify(null, data, key, sig);
  return false;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

