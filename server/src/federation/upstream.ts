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
import { pkceChallenge, verifyJwt, type Jwk } from './jose.js';
import type { TenantCtx } from './oidc.js';
import { certInfo } from './saml.js';
import { normaliseCertificate } from './x509.js';
import { attr, child, descendants, elements, escAttr, escText, NS, parseXml, textOf, verifyEnveloped, type XmlElement } from './xml.js';

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

  private async getJson<T>(url: string): Promise<T> {
    const text = await this.get(url, 'application/json');
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new UpstreamError(`${url} did not return JSON.`);
    }
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
  async startOidc(t: TenantCtx, providerId: string, returnTo: string | null): Promise<{ url: string; browser: string }> {
    const row = await this.provider(t.id, providerId, 'oidc');
    const cfg = row.config as unknown as OidcUpstreamConfig;
    const doc = await this.discovery(cfg);
    const browser = randomToken(24);
    const nonce = randomToken(24);
    const verifier = randomBytes(48).toString('base64url');
    const state = await this.savePending(t.id, { providerId: row.id, browser: this.digest(`browser:${browser}`), returnTo, nonce, verifier });
    const url = new URL(doc.authorization_endpoint);
    url.search = new URLSearchParams({ response_type: 'code', client_id: cfg.clientId, redirect_uri: this.redirectUri(t), scope: cfg.scopes.includes('openid') ? cfg.scopes : `openid ${cfg.scopes}`, state, nonce, code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256' }).toString();
    return { url: url.toString(), browser };
  }

  /** Completes an upstream OIDC sign-in: code exchange, then ID token verification against the upstream key set. */
  async finishOidc(t: TenantCtx, query: Record<string, unknown>, browser: string | undefined): Promise<{ row: ProviderRow; user: ExternalUser; returnTo: string | null }> {
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
    const sub = claimString(claims.sub);
    if (!sub) throw new UpstreamError('The ID token has no subject.');
    const username = claimString(claims[cfg.usernameClaim])?.toLowerCase() ?? null;
    if (!username || !USERNAME.test(username)) throw new UpstreamError(`The ID token has no usable ${cfg.usernameClaim} claim.`);
    return {
      row,
      returnTo: pending.returnTo,
      user: { externalId: sub, username, displayName: claimString(claims[cfg.displayNameClaim]) ?? username, email: claimString(claims[cfg.emailClaim]), groups: claimList(claims[cfg.groupsClaim]).slice(0, 500) }
    };
  }

  // ---------- SAML service provider ----------

  spEntityId(t: TenantCtx, row: ProviderRow): string {
    return `${t.issuer}/federation/saml/${row.id}`;
  }

  acsUrl(t: TenantCtx): string {
    return `${t.issuer}/federation/saml/acs`;
  }

  spMetadata(t: TenantCtx, row: ProviderRow): string {
    return `<?xml version="1.0" encoding="UTF-8"?><md:EntityDescriptor xmlns:md="${NS.md}" entityID="${escAttr(this.spEntityId(t, row))}"><md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol"><md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${escAttr(this.acsUrl(t))}" index="0"/></md:SPSSODescriptor></md:EntityDescriptor>`;
  }

  /** Starts an upstream SAML sign-in with an AuthnRequest over the HTTP-Redirect binding. */
  async startSaml(t: TenantCtx, providerId: string, returnTo: string | null): Promise<{ url: string; browser: string }> {
    const row = await this.provider(t.id, providerId, 'saml');
    const cfg = row.config as unknown as SamlUpstreamConfig;
    const browser = randomToken(24);
    const requestId = `_${randomBytes(20).toString('hex')}`;
    const relay = await this.savePending(t.id, { providerId: row.id, browser: this.digest(`browser:${browser}`), returnTo, requestId });
    const xml = `<samlp:AuthnRequest xmlns:samlp="${NS.samlp}" xmlns:saml="${NS.saml}" ID="${requestId}" Version="2.0" IssueInstant="${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}" Destination="${escAttr(cfg.ssoUrl)}" AssertionConsumerServiceURL="${escAttr(this.acsUrl(t))}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"><saml:Issuer>${escText(this.spEntityId(t, row))}</saml:Issuer></samlp:AuthnRequest>`;
    const url = new URL(cfg.ssoUrl);
    url.searchParams.set('SAMLRequest', deflateRawSync(Buffer.from(xml, 'utf8')).toString('base64'));
    url.searchParams.set('RelayState', relay);
    return { url: url.toString(), browser };
  }

  /**
   * Completes an upstream SAML sign-in. The response must answer our request (InResponseTo), be addressed to our
   * ACS and audience, be in its validity window, and carry exactly one assertion signed (itself, or inside a signed
   * response) by a registered certificate. Encrypted and unsolicited assertions are refused.
   */
  async finishSaml(t: TenantCtx, form: Record<string, string>, browser: string | undefined): Promise<{ row: ProviderRow; user: ExternalUser; returnTo: string | null }> {
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
    if (descendants(root, NS.saml, 'EncryptedAssertion').length) throw new UpstreamError('Encrypted assertions are not supported.');
    const all = descendants(root, NS.saml, 'Assertion');
    const assertions = elements(root, NS.saml, 'Assertion');
    if (assertions.length !== 1 || all.length !== 1) throw new UpstreamError('The response must carry exactly one assertion.');
    const assertion = assertions[0]!;
    const certs = cfg.certificates.map(normaliseCertificate);
    const signedAssertion = verifyEnveloped(root, assertion, certs);
    if (!signedAssertion.ok) {
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
    const nameId = textOf(child(subject, NS.saml, 'NameID')).trim();
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
      user: { externalId: nameId, username, displayName: first(cfg.displayNameAttribute) ?? username, email: first(cfg.emailAttribute), groups: (attrs.get(cfg.groupsAttribute) ?? []).slice(0, 500) }
    };
  }
}

/** Reads IdP metadata: entity ID, the HTTP-Redirect SSO endpoint and signing certificates. */
export function parseIdpMetadata(xml: string): { entityId: string; ssoUrl: string; certificates: string[] } {
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
  return { entityId, ssoUrl, certificates: [...new Set(certificates)].slice(0, 4) };
}

export { HostRefused };
