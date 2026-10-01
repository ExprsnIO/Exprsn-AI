import { randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { fetch, type Agent } from 'undici';
import { hmac, randomToken, safeEqual } from '../crypto/index.js';
import { json } from '../db/knex.js';
import { checkUrl, guardedAgent, HostRefused, parseAllowList, type AllowList } from '../mcp/hosts.js';
import type { ProviderRow } from '../repos/providers.js';
import type { ExternalUser, OidcUpstreamConfig, SamlUpstreamConfig, Step } from '../identity/providers/types.js';
import { resolveSecret } from '../identity/secrets.js';
import type { Services } from '../services.js';
import { ulid } from 'ulid';
import { pkceChallenge, verifyJwt, type Jwk } from './jose.js';
import type { TenantCtx } from './oidc.js';
import { certInfo, decodeMessage, SamlError } from './saml.js';
import { normaliseCertificate } from './x509.js';
import { attr, child, descendants, elements, escAttr, escText, lookupNs, NS, parseXml, signedRedirectQuery, textOf, verifyEnveloped, verifyRedirectSignature, type XmlElement } from './xml.js';
import { decryptAssertion, ENC, XmlEncError } from './xmlenc.js';

export class UpstreamError extends Error {}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface CheckResult {
  ok: boolean;
  reach: string;
  steps: Step[];
  parsed?: Record<string, unknown>;
}

interface PendingUpstream {
  providerId: string;
  browser: string;
  returnTo: string | null;
  nonce?: string;
  verifier?: string;
  requestId?: string;
  /** Sprint 17 (B-803): a step-up re-authentication for this console session and user, started at `startedAt`. */
  stepUp?: StepUpBinding;
  startedAt?: number;
}

/** The console session a step-up at the upstream IdP was started from; the result counts only for it. */
export interface StepUpBinding {
  sessionId: string;
  userId: string;
}

/** How much older than the step-up request an upstream authentication may be (clock skew). */
const STEPUP_SKEW_MS = 60_000;

/** What an upstream SAML sign-in leaves for single logout: the subject and session as the IdP named them. */
export interface SamlSubject {
  nameId: string;
  nameIdFormat: string | null;
  sessionIndex: string | null;
}

const PENDING_MS = 10 * 60_000;
const USERNAME = /^[a-z0-9][a-z0-9._@-]{0,189}$/;

const claimString = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const claimList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' && v ? [v] : []);

/**
 * Upstream federation: this issuer is an OIDC relying party or a SAML service provider to an on-prem identity
 * provider. Upstream hosts must be internal (the air gap), unless FEDERATION_ALLOWED_HOSTS names them; every
 * connection is re-checked at dial time. Browser round trips carry a single-use handle (the OIDC `state`, the SAML
 * `RelayState`) bound to a cookie in the browser that started them, so a sign-in cannot be completed by another one.
 */
export class Upstream {
  private readonly discoveryCache = new Map<string, { at: number; doc: Discovery }>();
  private readonly jwksCache = new Map<string, { at: number; keys: Jwk[] }>();
  private agentCache: { spec: string; agent: Agent; allow: AllowList } | null = null;

  constructor(private readonly s: () => Services) {}

  private net(): { agent: Agent; allow: AllowList } {
    const spec = this.s().cfg.FEDERATION_ALLOWED_HOSTS;
    if (!this.agentCache || this.agentCache.spec !== spec) {
      const allow = parseAllowList(spec);
      this.agentCache = { spec, allow, agent: guardedAgent(allow, this.s().cfg.FEDERATION_TIMEOUT_MS) };
    }
    return this.agentCache;
  }

  private async get(url: string, accept: string): Promise<string> {
    const { agent, allow } = this.net();
    await checkUrl(url, allow);
    const res = await fetch(url, { headers: { accept }, dispatcher: agent, redirect: 'error', signal: AbortSignal.timeout(this.s().cfg.FEDERATION_TIMEOUT_MS) });
    const text = await res.text();
    if (!res.ok) throw new UpstreamError(`${url} answered HTTP ${res.status}.`);
    if (text.length > 1_000_000) throw new UpstreamError(`${url} returned too much data.`);
    return text;
  }

  /** SAML metadata from a URL, through the same outbound checks as the providers themselves (B-807). */
  fetchMetadata(url: string): Promise<string> {
    return this.get(url, 'application/samlmetadata+xml, application/xml');
  }

  private async getJson<T>(url: string): Promise<T> {
    const text = await this.get(url, 'application/json');
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new UpstreamError(`${url} did not return JSON.`);
    }
  }

  /**
   * POSTs a form to a host that must pass the same checks as upstream providers (internal, or allow-listed; checked
   * again at dial time; no redirects), for back-channel logout. Throws when it does not answer 200 or 204.
   */
  async postForm(url: string, form: Record<string, string>): Promise<number> {
    const { agent, allow } = this.net();
    await checkUrl(url, allow);
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(form).toString(), dispatcher: agent, redirect: 'error', signal: AbortSignal.timeout(this.s().cfg.FEDERATION_TIMEOUT_MS) });
    await res.body?.cancel().catch(() => undefined);
    if (res.status !== 200 && res.status !== 204) throw new UpstreamError(`${new URL(url).origin} answered HTTP ${res.status}.`);
    return res.status;
  }

  /** How an upstream host is reached: internal addresses, or a host the allow-list names. */
  async reachOf(url: string): Promise<string> {
    const { allow } = this.net();
    const { addresses } = await checkUrl(url, allow);
    const internal = addresses.every((a) => /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|::1$|f[cd])/i.test(a));
    return internal ? 'on-prem, internal network' : 'on-prem, allow-listed host';
  }

  async discovery(cfg: OidcUpstreamConfig, force = false): Promise<Discovery> {
    const key = cfg.issuer;
    const hit = this.discoveryCache.get(key);
    if (hit && !force && Date.now() - hit.at < 3600_000) return hit.doc;
    const doc = await this.getJson<Discovery>(`${cfg.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
    if (doc.issuer !== cfg.issuer) throw new UpstreamError(`The discovery document names issuer ${String(doc.issuer)}, not ${cfg.issuer}.`);
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) if (typeof doc[k] !== 'string') throw new UpstreamError(`The discovery document has no ${k}.`);
    this.discoveryCache.set(key, { at: Date.now(), doc });
    return doc;
  }

  private async jwks(doc: Discovery, force = false): Promise<Jwk[]> {
    const hit = this.jwksCache.get(doc.jwks_uri);
    // A forced refresh (unknown kid) is allowed at most once a minute.
    if (hit && (!force || Date.now() - hit.at < 60_000) && Date.now() - hit.at < 3600_000) return hit.keys;
    const set = await this.getJson<{ keys?: Jwk[] }>(doc.jwks_uri);
    const keys = Array.isArray(set.keys) ? set.keys : [];
    this.jwksCache.set(doc.jwks_uri, { at: Date.now(), keys });
    return keys;
  }

  // ---------- reachability and configuration checks ----------

  /** "Check reachability": fetches an OIDC discovery document and key set, or reads SAML metadata (URL or pasted XML). */
  async check(protocol: 'oidc' | 'saml', input: string): Promise<CheckResult> {
    const steps: Step[] = [];
    const step = async <T>(title: string, fn: () => Promise<T>, describe?: (v: T) => string): Promise<T | null> => {
      const t0 = performance.now();
      try {
        const v = await fn();
        steps.push({ title, ok: true, ms: Math.round(performance.now() - t0), ...(describe ? { detail: describe(v) } : {}) });
        return v;
      } catch (err) {
        steps.push({ title, ok: false, ms: Math.round(performance.now() - t0), detail: (err as Error).message });
        return null;
      }
    };
    if (protocol === 'oidc') {
      const reach = await step('Resolve and check the address', () => this.reachOf(input), (r) => r);
      if (!reach) return { ok: false, reach: 'unreachable', steps };
      const doc = await step('Fetch the discovery document', () => this.discovery({ issuer: input } as OidcUpstreamConfig, true), (d) => d.issuer);
      if (!doc) return { ok: false, reach, steps };
      const keys = await step('Fetch the key set', () => this.jwks(doc, true), (k) => `${k.length} key${k.length === 1 ? '' : 's'}: ${k.map((x) => `${x.kid ?? '?'} (${x.kty})`).join(', ')}`);
      return { ok: !!keys?.length, reach, steps, parsed: { issuer: doc.issuer, authorizationEndpoint: doc.authorization_endpoint, tokenEndpoint: doc.token_endpoint, keys: keys?.length ?? 0 } };
    }
    let xml = input.trim();
    let reach = 'pasted metadata';
    if (/^https?:\/\//.test(xml)) {
      const r = await step('Resolve and check the address', () => this.reachOf(input), (x) => x);
      if (!r) return { ok: false, reach: 'unreachable', steps };
      reach = r;
      const text = await step('Fetch the metadata', () => this.get(input, 'application/samlmetadata+xml, application/xml'), (t) => `${t.length} bytes`);
      if (!text) return { ok: false, reach, steps };
      xml = text;
    }
    const parsed = await step('Read the IdP metadata', async () => parseIdpMetadata(xml), (p) => `${p.entityId}, ${p.certificates.length} signing certificate${p.certificates.length === 1 ? '' : 's'}`);
    if (!parsed) return { ok: false, reach, steps };
    const certs = parsed.certificates.map(certInfo);
    steps.push({ title: 'Signing certificate', ok: certs.every((c) => c && !c.expired), detail: certs.map((c) => (c ? `${c.subject}, expires ${new Date(c.validTo).toISOString().slice(0, 10)}` : 'unreadable')).join('; ') });
    return { ok: steps.every((x) => x.ok), reach, steps, parsed: { ...parsed } };
  }

  /** The User stores "Test connection" for upstream providers. */
  async test(row: ProviderRow, steps: Step[]): Promise<boolean> {
    if (row.kind === 'oidc') {
      const cfg = row.config as unknown as OidcUpstreamConfig;
      const r = await this.check('oidc', cfg.issuer);
      steps.push(...r.steps);
      if (cfg.clientSecret) {
        try {
          resolveSecret(cfg.clientSecret);
          steps.push({ title: 'Client secret reference resolves', ok: true });
        } catch (err) {
          steps.push({ title: 'Client secret reference resolves', ok: false, detail: (err as Error).message });
          return false;
        }
      }
      return r.ok;
    }
    const cfg = row.config as unknown as SamlUpstreamConfig;
    const reach = await this.reachOf(cfg.ssoUrl).then((r) => ({ ok: true, detail: r }), (err: Error) => ({ ok: false, detail: err.message }));
    steps.push({ title: 'SSO endpoint address', ...reach });
    const certs = cfg.certificates.map(certInfo);
    steps.push({ title: 'Signing certificate', ok: certs.every((c) => c && !c.expired), detail: certs.map((c) => (c ? `${c.subject}, expires ${new Date(c.validTo).toISOString().slice(0, 10)}` : 'unreadable')).join('; ') });
    return steps.every((x) => x.ok);
  }

  // ---------- pending state ----------

  private digest(handle: string): string {
    return hmac(this.s().cfg.SESSION_SECRET, `federation-pending:${handle}`);
  }

  private async savePending(tenantId: string, data: PendingUpstream): Promise<string> {
    const handle = randomToken(24);
    await this.s().db('federation_pending').insert({ id: this.digest(handle), tenant_id: tenantId, kind: 'upstream', data: JSON.stringify(data), expires_at: Date.now() + PENDING_MS });
    return handle;
  }

  /** Takes (single use) the pending state for a handle, checking the browser binding. */
  private async takePending(tenantId: string, handle: string | undefined, browser: string | undefined): Promise<PendingUpstream> {
    if (!handle || handle.length > 100) throw new UpstreamError('The sign-in response has no state. Start again.');
    const id = this.digest(handle);
    const row = (await this.s().db('federation_pending').where({ id, tenant_id: tenantId, kind: 'upstream' }).first()) as { data: string; expires_at: number } | undefined;
    if (!row) throw new UpstreamError('This sign-in response was already used or is unknown. Start again.');
    const data = json<PendingUpstream>(row.data, { providerId: '', browser: '', returnTo: null });
    // Checked before the state is used up, so a copied response cannot cancel the real browser's sign-in.
    if (!browser || !safeEqual(this.digest(`browser:${browser}`), data.browser)) throw new UpstreamError('This sign-in was started in another browser. Start again.');
    if (!(await this.s().db('federation_pending').where({ id }).delete())) throw new UpstreamError('This sign-in response was already used. Start again.');
    if (Number(row.expires_at) < Date.now()) throw new UpstreamError('The sign-in took too long. Start again.');
    return data;
  }

  private async provider(tenantId: string, id: string, kind: 'oidc' | 'saml'): Promise<ProviderRow> {
    const row = await this.s().providers.get(tenantId, id);
    if (!row || row.kind !== kind || !row.enabled) throw new UpstreamError('That identity provider is not available.');
    return row;
  }

  // ---------- OIDC relying party ----------

  redirectUri(t: TenantCtx): string {
    return `${t.issuer}/federation/oidc/callback`;
  }

  /** Starts an upstream OIDC sign-in: authorization code with PKCE (S256), nonce and state. */
  async startOidc(t: TenantCtx, providerId: string, returnTo: string | null, stepUp?: StepUpBinding): Promise<{ url: string; browser: string }> {
    const row = await this.provider(t.id, providerId, 'oidc');
    const cfg = row.config as unknown as OidcUpstreamConfig;
    const doc = await this.discovery(cfg);
    const browser = randomToken(24);
    const nonce = randomToken(24);
    const verifier = randomBytes(48).toString('base64url');
    const state = await this.savePending(t.id, { providerId: row.id, browser: this.digest(`browser:${browser}`), returnTo, nonce, verifier, ...(stepUp ? { stepUp, startedAt: Date.now() } : {}) });
    const url = new URL(doc.authorization_endpoint);
    const params = new URLSearchParams({ response_type: 'code', client_id: cfg.clientId, redirect_uri: this.redirectUri(t), scope: cfg.scopes.includes('openid') ? cfg.scopes : `openid ${cfg.scopes}`, state, nonce, code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256' });
    // B-803: a step-up asks the IdP to authenticate the user again now, and to say when it did (auth_time).
    if (stepUp) {
      params.set('prompt', 'login');
      params.set('max_age', '0');
    }
    url.search = params.toString();
    return { url: url.toString(), browser };
  }

  /** Completes an upstream OIDC sign-in: code exchange, then ID token verification against the upstream key set. */
  async finishOidc(t: TenantCtx, query: Record<string, unknown>, browser: string | undefined): Promise<{ row: ProviderRow; user: ExternalUser; returnTo: string | null; stepUp?: StepUpBinding }> {
    const pending = await this.takePending(t.id, typeof query.state === 'string' ? query.state : undefined, browser);
    if (typeof query.error === 'string') throw new UpstreamError(`The identity provider refused the sign-in: ${query.error}${typeof query.error_description === 'string' ? ` (${query.error_description.slice(0, 200)})` : ''}.`);
    if (typeof query.code !== 'string' || !query.code) throw new UpstreamError('The identity provider returned no code.');
    const row = await this.provider(t.id, pending.providerId, 'oidc');
    const cfg = row.config as unknown as OidcUpstreamConfig;
    const doc = await this.discovery(cfg);
    const form = new URLSearchParams({ grant_type: 'authorization_code', code: query.code, redirect_uri: this.redirectUri(t), code_verifier: pending.verifier!, client_id: cfg.clientId });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    if (cfg.clientSecret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(resolveSecret(cfg.clientSecret))}`).toString('base64')}`;
    const { agent, allow } = this.net();
    await checkUrl(doc.token_endpoint, allow);
    const res = await fetch(doc.token_endpoint, { method: 'POST', headers, body: form.toString(), dispatcher: agent, redirect: 'error', signal: AbortSignal.timeout(this.s().cfg.FEDERATION_TIMEOUT_MS) });
    const body = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string; error_description?: string };
    if (!res.ok || !body.id_token) throw new UpstreamError(`The token exchange failed: ${body.error ?? `HTTP ${res.status}`}${body.error_description ? ` (${String(body.error_description).slice(0, 200)})` : ''}.`);
    let claims;
    try {
      claims = verifyJwt(body.id_token, await this.jwks(doc), { issuer: cfg.issuer, audience: cfg.clientId, algs: cfg.algs });
    } catch (err) {
      // The provider may have rotated its keys: refetch once and retry.
      if (!/No key/.test((err as Error).message)) throw new UpstreamError(`The ID token was refused: ${(err as Error).message}`);
      claims = verifyJwt(body.id_token, await this.jwks(doc, true), { issuer: cfg.issuer, audience: cfg.clientId, algs: cfg.algs });
    }
    if (claims.nonce !== pending.nonce) throw new UpstreamError('The ID token nonce does not match this sign-in.');
    // A step-up counts only when the IdP says it authenticated the user after we asked (max_age=0 requires auth_time).
    if (pending.stepUp && (typeof claims.auth_time !== 'number' || claims.auth_time * 1000 < (pending.startedAt ?? 0) - STEPUP_SKEW_MS)) throw new UpstreamError('The identity provider did not sign you in again, so this does not confirm it is you. Try again.');
    const sub = claimString(claims.sub);
    if (!sub) throw new UpstreamError('The ID token has no subject.');
    const username = claimString(claims[cfg.usernameClaim])?.toLowerCase() ?? null;
    if (!username || !USERNAME.test(username)) throw new UpstreamError(`The ID token has no usable ${cfg.usernameClaim} claim.`);
    return {
      row,
      returnTo: pending.returnTo,
      user: { externalId: sub, username, displayName: claimString(claims[cfg.displayNameClaim]) ?? username, email: claimString(claims[cfg.emailClaim]), groups: claimList(claims[cfg.groupsClaim]).slice(0, 500) },
      ...(pending.stepUp ? { stepUp: pending.stepUp } : {})
    };
  }

  // ---------- SAML service provider ----------

  spEntityId(t: TenantCtx, row: ProviderRow): string {
    return `${t.issuer}/federation/saml/${row.id}`;
  }

  acsUrl(t: TenantCtx): string {
    return `${t.issuer}/federation/saml/acs`;
  }

  sloUrl(t: TenantCtx): string {
    return `${t.issuer}/federation/saml/slo`;
  }

  /**
   * Our SP metadata for one upstream IdP: the ACS, the single logout endpoint, the tenant's SAML signing
   * certificate (our logout messages are signed with it) and our encryption certificate for encrypted assertions.
   */
  async spMetadata(t: TenantCtx, row: ProviderRow): Promise<string> {
    const keys = this.s().federation.keys;
    const signing = (await keys.signer(t.id, 'saml')).row.certificate ?? '';
    const enc = (await keys.advance(t.id, 'saml-enc')).certificate ?? '';
    const kd = (use: string, cert: string, methods = '') => `<md:KeyDescriptor use="${use}"><ds:KeyInfo xmlns:ds="${NS.ds}"><ds:X509Data><ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>${methods}</md:KeyDescriptor>`;
    const slo = this.sloUrl(t);
    return `<?xml version="1.0" encoding="UTF-8"?><md:EntityDescriptor xmlns:md="${NS.md}" entityID="${escAttr(this.spEntityId(t, row))}"><md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">${kd('signing', signing)}${kd('encryption', enc, `<md:EncryptionMethod Algorithm="${ENC.aes256gcm}"/><md:EncryptionMethod Algorithm="${ENC.rsaOaep}"/>`)}<md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${escAttr(slo)}"/><md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${escAttr(slo)}"/><md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${escAttr(this.acsUrl(t))}" index="0"/></md:SPSSODescriptor></md:EntityDescriptor>`;
  }

  /** Starts an upstream SAML sign-in with an AuthnRequest over the HTTP-Redirect binding. */
  async startSaml(t: TenantCtx, providerId: string, returnTo: string | null, stepUp?: StepUpBinding): Promise<{ url: string; browser: string }> {
    const row = await this.provider(t.id, providerId, 'saml');
    const cfg = row.config as unknown as SamlUpstreamConfig;
    const browser = randomToken(24);
    const requestId = `_${randomBytes(20).toString('hex')}`;
    const relay = await this.savePending(t.id, { providerId: row.id, browser: this.digest(`browser:${browser}`), returnTo, requestId, ...(stepUp ? { stepUp, startedAt: Date.now() } : {}) });
    // B-803: ForceAuthn makes the IdP authenticate the user again rather than reuse its session.
    const xml = `<samlp:AuthnRequest xmlns:samlp="${NS.samlp}" xmlns:saml="${NS.saml}" ID="${requestId}" Version="2.0" IssueInstant="${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}" Destination="${escAttr(cfg.ssoUrl)}" AssertionConsumerServiceURL="${escAttr(this.acsUrl(t))}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"${stepUp ? ' ForceAuthn="true"' : ''}><saml:Issuer>${escText(this.spEntityId(t, row))}</saml:Issuer></samlp:AuthnRequest>`;
    const url = new URL(cfg.ssoUrl);
    url.searchParams.set('SAMLRequest', deflateRawSync(Buffer.from(xml, 'utf8')).toString('base64'));
    url.searchParams.set('RelayState', relay);
    return { url: url.toString(), browser };
  }

  /**
   * Completes an upstream SAML sign-in. The response must answer our request (InResponseTo), be addressed to our
   * ACS and audience, be in its validity window, and carry exactly one assertion signed (itself, or inside a signed
   * response) by a registered certificate. An encrypted assertion is decrypted with our SP key first (AES-GCM with
   * RSA-OAEP only); unsolicited assertions are refused.
   */
  async finishSaml(t: TenantCtx, form: Record<string, string>, browser: string | undefined): Promise<{ row: ProviderRow; user: ExternalUser; returnTo: string | null; subject: SamlSubject; stepUp?: StepUpBinding }> {
    const pending = await this.takePending(t.id, form.RelayState, browser);
    const row = await this.provider(t.id, pending.providerId, 'saml');
    const cfg = row.config as unknown as SamlUpstreamConfig;
    let root: XmlElement;
    try {
      root = parseXml(Buffer.from(form.SAMLResponse ?? '', 'base64').toString('utf8'), 512 * 1024);
    } catch (err) {
      throw new UpstreamError(`The SAML response is not valid XML: ${(err as Error).message}`);
    }
    if (root.ns !== NS.samlp || root.local !== 'Response') throw new UpstreamError('Expected a samlp:Response.');
    const status = attr(child(child(root, NS.samlp, 'Status'), NS.samlp, 'StatusCode'), 'Value');
    if (status !== 'urn:oasis:names:tc:SAML:2.0:status:Success') throw new UpstreamError(`The identity provider refused the sign-in (${status ?? 'no status'}).`);
    const all = descendants(root, NS.saml, 'Assertion');
    const plain = elements(root, NS.saml, 'Assertion');
    const encryptedAll = descendants(root, NS.saml, 'EncryptedAssertion');
    const encrypted = elements(root, NS.saml, 'EncryptedAssertion');
    if (plain.length + encrypted.length !== 1 || all.length + encryptedAll.length !== 1) throw new UpstreamError('The response must carry exactly one assertion.');
    const certs = cfg.certificates.map(normaliseCertificate);
    let assertion: XmlElement;
    // The document the assertion's signature is checked in (its ID must be unique there).
    let assertionDoc: XmlElement = root;
    if (encrypted.length) {
      let xml: string;
      try {
        xml = await decryptAssertion(encrypted[0]!, (await this.s().federation.keys.decrypter(t.id)).decrypt);
      } catch (err) {
        if (err instanceof XmlEncError) throw new UpstreamError(`The encrypted assertion was refused: ${err.message}`);
        throw err;
      }
      // Parsed on its own, strictly, inside the namespaces in scope where it was (it may use the response's prefixes).
      const decls = ['saml', 'samlp', 'ds', 'xs', 'xsi'].map((p) => [p, lookupNs(encrypted[0]!, p)] as const).filter(([, v]) => v);
      try {
        assertionDoc = parseXml(`<w ${decls.map(([p, v]) => `xmlns:${p}="${escAttr(v!)}"`).join(' ')}>${xml}</w>`, 512 * 1024);
      } catch (err) {
        throw new UpstreamError(`The decrypted assertion is not valid XML: ${(err as Error).message}`);
      }
      const inner = elements(assertionDoc, NS.saml, 'Assertion');
      if (inner.length !== 1 || assertionDoc.children.some((c) => c.type === 'element' && c !== inner[0])) throw new UpstreamError('The encrypted element must be exactly one assertion.');
      assertion = inner[0]!;
      if (descendants(assertion, NS.saml, 'Assertion').length || descendants(assertion, NS.saml, 'EncryptedAssertion').length) throw new UpstreamError('The assertion must not contain another assertion.');
    } else assertion = plain[0]!;
    const signedAssertion = verifyEnveloped(assertionDoc, assertion, certs);
    if (!signedAssertion.ok) {
      // A signed response covers an encrypted assertion as it was sent.
      const signedResponse = verifyEnveloped(root, root, certs);
      if (!signedResponse.ok) throw new UpstreamError(`The assertion signature was refused: ${signedAssertion.reason ?? signedResponse.reason}`);
    }
    const now = Date.now();
    const skew = 120_000;
    const issuer = textOf(child(assertion, NS.saml, 'Issuer')).trim();
    if (issuer !== cfg.entityId) throw new UpstreamError(`The assertion issuer ${issuer} is not ${cfg.entityId}.`);
    const conditions = child(assertion, NS.saml, 'Conditions');
    const nb = attr(conditions, 'NotBefore');
    const na = attr(conditions, 'NotOnOrAfter');
    if (!conditions || !na || Date.parse(na) + skew <= now || (nb && Date.parse(nb) - skew > now)) throw new UpstreamError('The assertion is outside its validity window.');
    const audiences = descendants(conditions, NS.saml, 'Audience').map((a) => textOf(a).trim());
    if (!audiences.includes(this.spEntityId(t, row))) throw new UpstreamError('The assertion is not addressed to this service provider.');
    const subject = child(assertion, NS.saml, 'Subject');
    const confirmations = subject ? elements(subject, NS.saml, 'SubjectConfirmation').filter((c) => attr(c, 'Method') === 'urn:oasis:names:tc:SAML:2.0:cm:bearer') : [];
    const ok = confirmations.some((c) => {
      const d = child(c, NS.saml, 'SubjectConfirmationData');
      const until = attr(d, 'NotOnOrAfter');
      return attr(d, 'Recipient') === this.acsUrl(t) && attr(d, 'InResponseTo') === pending.requestId && !!until && Date.parse(until) + skew > now;
    });
    if (!ok) throw new UpstreamError('The assertion does not answer this sign-in (recipient, request or expiry).');
    const nameIdEl = child(subject, NS.saml, 'NameID');
    const nameId = textOf(nameIdEl).trim();
    const sessionIndex = attr(child(assertion, NS.saml, 'AuthnStatement'), 'SessionIndex') ?? null;
    if (pending.stepUp) {
      const instant = Date.parse(attr(child(assertion, NS.saml, 'AuthnStatement'), 'AuthnInstant') ?? '');
      if (!Number.isFinite(instant) || instant < (pending.startedAt ?? 0) - STEPUP_SKEW_MS) throw new UpstreamError('The identity provider did not sign you in again, so this does not confirm it is you. Try again.');
    }
    const attrs = new Map<string, string[]>();
    for (const st of elements(assertion, NS.saml, 'AttributeStatement')) {
      for (const a of elements(st, NS.saml, 'Attribute')) attrs.set(attr(a, 'Name') ?? '', elements(a, NS.saml, 'AttributeValue').map((v) => textOf(v).trim()));
    }
    const first = (name: string) => (name ? (attrs.get(name)?.[0] ?? null) : null);
    const username = (cfg.usernameAttribute ? first(cfg.usernameAttribute) : nameId)?.toLowerCase() ?? '';
    if (!nameId || !USERNAME.test(username)) throw new UpstreamError('The assertion has no usable username.');
    return {
      row,
      returnTo: pending.returnTo,
      user: { externalId: nameId, username, displayName: first(cfg.displayNameAttribute) ?? username, email: first(cfg.emailAttribute), groups: (attrs.get(cfg.groupsAttribute) ?? []).slice(0, 500) },
      subject: { nameId: nameId.slice(0, 500), nameIdFormat: attr(nameIdEl, 'Format')?.slice(0, 200) ?? null, sessionIndex: sessionIndex?.slice(0, 200) ?? null },
      ...(pending.stepUp ? { stepUp: pending.stepUp } : {})
    };
  }

  /**
   * B-803: records a verified upstream re-authentication for the console session it was started from. The console
   * (same origin, so the SameSite=Strict session cookie is sent) redeems the single-use handle, and only then does
   * the session's step-up time move.
   */
  async saveStepUp(tenantId: string, binding: StepUpBinding, providerId: string, method: string): Promise<string> {
    const handle = randomToken(24);
    await this.s().db('federation_pending').insert({ id: this.digest(`stepup:${handle}`), tenant_id: tenantId, kind: 'stepup', data: JSON.stringify({ ...binding, providerId, method }), expires_at: Date.now() + 5 * 60_000 });
    return handle;
  }

  /** Redeems a step-up handle for `sessionId` (single use). Null when unknown, expired or for another session. */
  async takeStepUp(tenantId: string, handle: string, sessionId: string): Promise<{ userId: string; providerId: string; method: string } | null> {
    if (!/^[A-Za-z0-9_-]{32}$/.test(handle)) return null;
    const id = this.digest(`stepup:${handle}`);
    const row = (await this.s().db('federation_pending').where({ id, tenant_id: tenantId, kind: 'stepup' }).first()) as { data: string; expires_at: number } | undefined;
    if (!row) return null;
    const data = json<StepUpBinding & { providerId: string; method: string }>(row.data, { sessionId: '', userId: '', providerId: '', method: '' });
    if (!safeEqual(data.sessionId, sessionId)) return null;
    if (!(await this.s().db('federation_pending').where({ id }).delete()) || Number(row.expires_at) < Date.now()) return null;
    return { userId: data.userId, providerId: data.providerId, method: data.method };
  }

  /** Remembers an upstream SAML session (NameID, SessionIndex) against the console session it created. */
  async recordSamlSession(tenantId: string, sessionId: string, providerId: string, subject: SamlSubject): Promise<void> {
    await this.s().db('saml_sessions').insert({ id: ulid(), tenant_id: tenantId, session_id: sessionId, role: 'sp', peer_id: providerId, name_id: subject.nameId, name_id_format: subject.nameIdFormat, session_index: subject.sessionIndex, created_at: Date.now(), ended_at: null });
  }

  // ---------- SAML single logout (we are the SP) ----------

  private async samlProviderByEntity(tenantId: string, entityId: string): Promise<ProviderRow | undefined> {
    return (await this.s().providers.list(tenantId)).find((p) => p.kind === 'saml' && p.enabled && (p.config as unknown as SamlUpstreamConfig).entityId === entityId);
  }

  /**
   * SP-initiated single logout: when a signed-out session came from an upstream SAML IdP with a logout endpoint, the
   * browser goes there with our signed LogoutRequest; its LogoutResponse comes back to our SLO endpoint, which then
   * continues to `next` (the relying party's post-logout address, or the signed-out page).
   */
  async startSamlLogout(t: TenantCtx, sessionId: string, next: string | null): Promise<string | null> {
    const row = (await this.s().db('saml_sessions').where({ tenant_id: t.id, session_id: sessionId, role: 'sp' }).orderBy('created_at', 'desc').first()) as { peer_id: string; name_id: string; name_id_format: string | null; session_index: string | null } | undefined;
    if (!row) return null;
    const provider = await this.s().providers.get(t.id, row.peer_id);
    const cfg = provider?.config as unknown as SamlUpstreamConfig | undefined;
    if (!provider || !provider.enabled || !cfg?.sloUrl) return null;
    const requestId = `_${randomBytes(20).toString('hex')}`;
    const handle = randomToken(24);
    await this.s().db('federation_pending').insert({ id: this.digest(handle), tenant_id: t.id, kind: 'saml_slo', data: JSON.stringify({ providerId: provider.id, requestId, next }), expires_at: Date.now() + PENDING_MS });
    const xml = `<samlp:LogoutRequest xmlns:samlp="${NS.samlp}" xmlns:saml="${NS.saml}" ID="${requestId}" Version="2.0" IssueInstant="${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}" Destination="${escAttr(cfg.sloUrl)}"><saml:Issuer>${escText(this.spEntityId(t, provider))}</saml:Issuer><saml:NameID${row.name_id_format ? ` Format="${escAttr(row.name_id_format)}"` : ''}>${escText(row.name_id)}</saml:NameID>${row.session_index ? `<samlp:SessionIndex>${escText(row.session_index)}</samlp:SessionIndex>` : ''}</samlp:LogoutRequest>`;
    const signer = await this.s().federation.keys.signer(t.id, 'saml');
    const query = await signedRedirectQuery('SAMLRequest', deflateRawSync(Buffer.from(xml, 'utf8')).toString('base64'), handle, (d) => signer.sign(d));
    return `${cfg.sloUrl}${cfg.sloUrl.includes('?') ? '&' : '?'}${query}`;
  }

  /**
   * Our SLO endpoint as SP. A LogoutRequest from an upstream IdP (signed, from a registered provider) ends the
   * sign-in sessions it names and is answered with a signed LogoutResponse; a LogoutResponse answers a logout we
   * started and says where to continue.
   */
  async handleSlo(t: TenantCtx, binding: 'redirect' | 'post', params: Record<string, string>, rawQuery: string): Promise<{ kind: 'request'; sessionIds: string[]; provider: ProviderRow; responseUrl: string | null } | { kind: 'response'; next: string | null }> {
    const isRequest = !!params.SAMLRequest;
    const root = decodeMessage(binding, isRequest ? params.SAMLRequest! : (params.SAMLResponse ?? ''));
    const issuer = textOf(child(root, NS.saml, 'Issuer')).trim();
    const provider = await this.samlProviderByEntity(t.id, issuer);
    if (!provider) throw new SamlError(`No enabled SAML identity provider is registered as ${issuer || '(no issuer)'}.`);
    const cfg = provider.config as unknown as SamlUpstreamConfig;
    const certs = cfg.certificates.map(normaliseCertificate);
    const v = binding === 'redirect' ? verifyRedirectSignature(rawQuery, certs) : verifyEnveloped(root, root, certs);
    if (!v.ok) throw new SamlError(v.reason ?? 'The logout message signature does not verify.');
    if (!isRequest) {
      if (root.ns !== NS.samlp || root.local !== 'LogoutResponse') throw new SamlError('Expected a samlp:LogoutResponse.');
      const handle = params.RelayState ?? '';
      const id = this.digest(handle);
      const row = handle ? ((await this.s().db('federation_pending').where({ id, tenant_id: t.id, kind: 'saml_slo' }).first()) as { data: string; expires_at: number } | undefined) : undefined;
      const data = json<{ providerId: string; requestId: string; next: string | null }>(row?.data, { providerId: '', requestId: '', next: null });
      if (!row || Number(row.expires_at) < Date.now() || data.providerId !== provider.id || attr(root, 'InResponseTo') !== data.requestId) throw new SamlError('This logout response does not answer a logout started here.');
      await this.s().db('federation_pending').where({ id }).delete();
      return { kind: 'response', next: data.next };
    }
    if (root.ns !== NS.samlp || root.local !== 'LogoutRequest') throw new SamlError('Expected a samlp:LogoutRequest.');
    const requestId = attr(root, 'ID');
    const nameId = textOf(child(root, NS.saml, 'NameID')).trim();
    if (!requestId || !nameId) throw new SamlError('The LogoutRequest has no ID or NameID.');
    const until = attr(root, 'NotOnOrAfter');
    if (until && Date.parse(until) + 120_000 <= Date.now()) throw new SamlError('The logout request has expired.');
    const indexes = elements(root, NS.samlp, 'SessionIndex').map((e) => textOf(e).trim()).filter(Boolean);
    const q = this.s().db('saml_sessions').where({ tenant_id: t.id, role: 'sp', peer_id: provider.id, name_id: nameId }).whereNull('ended_at');
    if (indexes.length) q.whereIn('session_index', indexes);
    const sessionIds = [...new Set(((await q.select('session_id')) as { session_id: string }[]).map((r) => r.session_id))];
    let responseUrl: string | null = null;
    if (cfg.sloUrl) {
      const xml = `<samlp:LogoutResponse xmlns:samlp="${NS.samlp}" xmlns:saml="${NS.saml}" ID="_${randomBytes(20).toString('hex')}" Version="2.0" IssueInstant="${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}" Destination="${escAttr(cfg.sloUrl)}" InResponseTo="${escAttr(requestId)}"><saml:Issuer>${escText(this.spEntityId(t, provider))}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"></samlp:StatusCode></samlp:Status></samlp:LogoutResponse>`;
      const signer = await this.s().federation.keys.signer(t.id, 'saml');
      const query = await signedRedirectQuery('SAMLResponse', deflateRawSync(Buffer.from(xml, 'utf8')).toString('base64'), params.RelayState ?? null, (d) => signer.sign(d));
      responseUrl = `${cfg.sloUrl}${cfg.sloUrl.includes('?') ? '&' : '?'}${query}`;
    }
    return { kind: 'request', sessionIds, provider, responseUrl };
  }
}


/** Reads IdP metadata: entity ID, the HTTP-Redirect SSO endpoint and signing certificates. */
export function parseIdpMetadata(xml: string): { entityId: string; ssoUrl: string; sloUrl?: string; certificates: string[] } {
  const root = parseXml(xml, 512 * 1024);
  const ed = root.local === 'EntityDescriptor' && root.ns === NS.md ? root : descendants(root, NS.md, 'EntityDescriptor')[0];
  const idp = child(ed, NS.md, 'IDPSSODescriptor');
  const entityId = attr(ed, 'entityID');
  if (!ed || !idp || !entityId) throw new UpstreamError('The metadata has no IDPSSODescriptor.');
  const sso = elements(idp, NS.md, 'SingleSignOnService').find((e) => attr(e, 'Binding') === 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect');
  const ssoUrl = attr(sso, 'Location');
  if (!ssoUrl || !/^https?:\/\//.test(ssoUrl)) throw new UpstreamError('The metadata has no HTTP-Redirect SingleSignOnService.');
  const certificates = elements(idp, NS.md, 'KeyDescriptor')
    .filter((k) => (attr(k, 'use') ?? 'signing') === 'signing')
    .flatMap((k) => descendants(k, NS.ds, 'X509Certificate').map((c) => normaliseCertificate(textOf(c))))
    .filter(Boolean);
  if (!certificates.length) throw new UpstreamError('The metadata has no signing certificate.');
  const slo = attr(elements(idp, NS.md, 'SingleLogoutService').find((e) => attr(e, 'Binding') === 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect'), 'Location');
  return { entityId, ssoUrl, ...(slo && /^https?:\/\//.test(slo) ? { sloUrl: slo } : {}), certificates: [...new Set(certificates)].slice(0, 4) };
}

export { HostRefused };
