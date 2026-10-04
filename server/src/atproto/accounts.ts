import { createHash, createPrivateKey, randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import type { AuditActor } from '../audit/chain.js';
import { isUniqueViolation } from '../audit/chain.js';
import { hmac, randomToken, safeEqual } from '../crypto/index.js';
import { json } from '../db/knex.js';
import type { TenantCtx } from '../federation/oidc.js';
import type { Jwk } from '../federation/jose.js';
import { atprotoConfigSchema, type ExternalUser, type Step } from '../identity/providers/types.js';
import type { ProviderRow } from '../repos/providers.js';
import type { Services } from '../services.js';
import { HandleError, HandleResolver, handlesOf, isResolvableDid, pdsOf, refusalOf } from './handles.js';
import { AtOAuthClient, AtOAuthError, newDpopKey, pkcePair, type AsMetadata, type ClientCredentials, type DpopKey } from './oauth-client.js';

/*
 * AT-Protocol accounts (B-1807, B-1808).
 *
 * User DIDs (B-1807). A user claims a DID (or a handle, resolved to its DID); the claim is proven by a single-use
 * challenge published in the account's own repository (the `app.bsky.actor.profile` record's description, read from
 * the account's PDS, which only the account can write), or by signing in at the account's authorization server (the
 * OAuth flow of B-1808 in "link" mode). Only then is the DID bound to the user (`verified_did`), and a DID is bound to
 * one user per tenant. A handle is accepted for the DID only when it resolves to the DID (DNS TXT or HTTPS, through
 * the service URL checks) and the DID document names it back.
 *
 * Sign-in (B-1808). Handle → DID → DID document → PDS → its authorization server → PAR with PKCE and DPoP → the
 * browser → the callback (state bound to the browser by the federation cookie, `iss` checked) → the token request with
 * DPoP → the account's DID in `sub`, checked against the PDS's own authorization server and with a getSession call at
 * the PDS using the DPoP-bound token. Tokens are revoked at once (best effort) and never stored: Exprsn-AI only needs to
 * know who signed in. A DID bound to a user signs in as that user; any other account is provisioned by the tenant's
 * `atproto` user store with its DID as its only group, so group mappings name DIDs.
 */

export class AtAccountError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extensions: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

export interface UserDidRow {
  id: string;
  tenant_id: string;
  user_id: string;
  did: string;
  verified_did: string | null;
  proof: 'profile' | 'oauth' | null;
  challenge_hash: string | null;
  challenge_expires_at: number | null;
  pds: string | null;
  handle: string | null;
  handle_checked_at: number | null;
  verified_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface AccountActor {
  tenantId: string;
  userId: string | null;
  actor: AuditActor;
  traceId?: string | null;
}

/** The console session a "link" sign-in was started from; the DID is bound to its user. */
export interface LinkBinding {
  sessionId: string;
  userId: string;
}

interface PendingSignIn {
  providerId: string | null;
  browser: string;
  returnTo: string | null;
  link?: LinkBinding;
  expectDid: string | null;
  handle: string | null;
  issuer: string;
  pds: string;
  verifier: string;
  dpopSealed: string;
  dpopJwk: Jwk;
}

export interface FinishedSignIn {
  row: ProviderRow | null;
  did: string;
  handle: string | null;
  pds: string;
  issuer: string;
  returnTo: string | null;
  link?: LinkBinding;
  /** The user the DID is bound to in this tenant, if any. */
  boundUserId: string | null;
  /** What the atproto store provisions when the DID is not bound. */
  user: ExternalUser;
}

const CHALLENGE_MS = 24 * 3600_000;
const PENDING_MS = 10 * 60_000;
const CHALLENGE_RE = /exprsn-ai-verify-[0-9a-f]{32}/g;
const SCOPE = 'atproto';
const sha256hex = (v: string) => createHash('sha256').update(v).digest('hex');
const USERNAME = /^[a-z0-9][a-z0-9._@-]{0,189}$/;

/** A username for an account without a valid handle: the DID with its separators made safe. */
export const usernameForDid = (did: string): string => did.toLowerCase().replace(/%3a/g, '-').replace(/[^a-z0-9.-]+/g, '-').slice(0, 190);

const fromRow = (r: Record<string, unknown>): UserDidRow => ({
  ...(r as unknown as UserDidRow),
  challenge_expires_at: r.challenge_expires_at == null ? null : Number(r.challenge_expires_at),
  handle_checked_at: r.handle_checked_at == null ? null : Number(r.handle_checked_at),
  verified_at: r.verified_at == null ? null : Number(r.verified_at),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

export class AtprotoAccounts {
  private handleResolver: HandleResolver | null = null;
  private oauthClient: AtOAuthClient | null = null;

  constructor(private readonly s: () => Services) {}

  get handles(): HandleResolver {
    const s = this.s();
    return (this.handleResolver ??= new HandleResolver(s.atproto.http, { production: s.cfg.NODE_ENV === 'production', timeoutMs: s.cfg.FEDERATION_TIMEOUT_MS }));
  }

  get oauth(): AtOAuthClient {
    return (this.oauthClient ??= new AtOAuthClient(this.s().atproto.http, { production: this.s().cfg.NODE_ENV === 'production' }));
  }

  // ---------- resolution ----------

  /**
   * Resolves what a person typed (a handle, or a DID) to the DID, its document, its PDS and, when a handle was typed,
   * that handle (which the document must name back). Throws AtAccountError with the step that failed.
   */
  async resolveAccount(input: string, o: { fresh?: boolean } = {}): Promise<{ did: string; handle: string | null; pds: string; doc: unknown; via: 'did' | 'dns' | 'https' }> {
    const typed = input.trim();
    let did: string;
    let handle: string | null = null;
    let via: 'did' | 'dns' | 'https' = 'did';
    if (typed.startsWith('did:')) {
      if (!isResolvableDid(typed)) throw new AtAccountError(400, 'Only did:plc and did:web accounts are supported.', { step: 'did' });
      did = typed;
    } else {
      try {
        const r = await this.handles.resolve(typed);
        did = r.did;
        handle = r.handle;
        via = r.method;
      } catch (err) {
        if (err instanceof HandleError) throw new AtAccountError(err.code === 'refused' ? 422 : 400, err.message, { step: 'handle', reason: err.code });
        throw err;
      }
    }
    let doc: unknown;
    try {
      doc = await this.s().atproto.resolver.resolve(did, o.fresh);
    } catch (err) {
      const refused = refusalOf(err);
      throw new AtAccountError(refused ? 422 : 502, refused ? `The DID document address was refused: ${refused.message}` : `${did} could not be resolved.`, { step: 'did_document' });
    }
    if ((doc as { id?: unknown } | null)?.id !== did) throw new AtAccountError(422, 'The DID document does not describe this DID.', { step: 'did_document' });
    if (handle && !handlesOf(doc).includes(handle)) throw new AtAccountError(422, `The DID document of ${did} does not name ${handle} as its handle.`, { step: 'handle', reason: 'mismatch' });
    const pds = pdsOf(doc, did);
    if (!pds) throw new AtAccountError(422, 'The DID document names no PDS (#atproto_pds).', { step: 'pds' });
    return { did, handle, pds, doc, via };
  }

  /** Diagnostic: every step from a handle or DID to the authorization server, as the identity screens show checks. */
  async check(input: string): Promise<{ ok: boolean; steps: Step[]; did?: string; handle?: string | null; pds?: string; issuer?: string }> {
    const steps: Step[] = [];
    const t0 = performance.now();
    let acct;
    try {
      acct = await this.resolveAccount(input, { fresh: true });
      steps.push({ title: 'Resolve the account', ok: true, ms: Math.round(performance.now() - t0), detail: `${acct.handle ? `${acct.handle} (${acct.via}) → ` : ''}${acct.did} → ${acct.pds}` });
    } catch (err) {
      steps.push({ title: 'Resolve the account', ok: false, ms: Math.round(performance.now() - t0), detail: err instanceof AtAccountError ? err.message : 'The account could not be resolved.' });
      return { ok: false, steps };
    }
    const t1 = performance.now();
    try {
      const issuer = await this.oauth.authServerOf(acct.pds);
      await this.oauth.authServer(issuer);
      steps.push({ title: 'Find its authorization server', ok: true, ms: Math.round(performance.now() - t1), detail: issuer });
      return { ok: true, steps, did: acct.did, handle: acct.handle, pds: acct.pds, issuer };
    } catch (err) {
      steps.push({ title: 'Find its authorization server', ok: false, ms: Math.round(performance.now() - t1), detail: err instanceof AtOAuthError ? err.message : 'The authorization server could not be reached.' });
      return { ok: false, steps, did: acct.did, handle: acct.handle, pds: acct.pds };
    }
  }

  // ---------- B-1807: user DIDs ----------

  async binding(tenantId: string, userId: string): Promise<UserDidRow | undefined> {
    const r = (await this.s().db('atproto_user_dids').where({ tenant_id: tenantId, user_id: userId }).first()) as Record<string, unknown> | undefined;
    return r ? fromRow(r) : undefined;
  }

  async bindingById(tenantId: string, id: string): Promise<UserDidRow | undefined> {
    const r = (await this.s().db('atproto_user_dids').where({ tenant_id: tenantId, id }).first()) as Record<string, unknown> | undefined;
    return r ? fromRow(r) : undefined;
  }

  /** The user a verified DID is bound to in a tenant. */
  async boundUser(tenantId: string, did: string): Promise<string | null> {
    const r = (await this.s().db('atproto_user_dids').where({ tenant_id: tenantId, verified_did: did }).first('user_id')) as { user_id: string } | undefined;
    return r?.user_id ?? null;
  }

  async list(tenantId: string, o: { verified?: boolean; limit: number; offset: number }): Promise<(UserDidRow & { username: string | null })[]> {
    const q = this.s()
      .db('atproto_user_dids as d')
      .leftJoin('users as u', 'u.id', 'd.user_id')
      .where('d.tenant_id', tenantId)
      .orderBy('d.created_at', 'desc')
      .limit(o.limit)
      .offset(o.offset)
      .select('d.*', 'u.username');
    if (o.verified === true) q.whereNotNull('d.verified_did');
    if (o.verified === false) q.whereNull('d.verified_did');
    return ((await q) as Record<string, unknown>[]).map((r) => ({ ...fromRow(r), username: (r.username as string | null) ?? null }));
  }

  private async audit(by: AccountActor, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>): Promise<void> {
    await this.s().audit.append({ tenantId: by.tenantId, action, kind: 'admin', actor: by.actor, target, ...(detail ? { detail } : {}), traceId: by.traceId ?? null });
  }

  /**
   * Claims a DID for a user (replacing any earlier claim or binding of theirs) and issues the challenge, which is
   * returned once and stored as a SHA-256 only.
   */
  async claim(by: AccountActor, userId: string, input: string): Promise<{ row: UserDidRow; token: string; expiresAt: number }> {
    const acct = await this.resolveAccount(input, { fresh: true });
    const other = await this.boundUser(by.tenantId, acct.did);
    if (other && other !== userId) throw new AtAccountError(409, 'This DID is already bound to another account in this tenant.', { step: 'did' });
    const token = `exprsn-ai-verify-${randomBytes(16).toString('hex')}`;
    const now = Date.now();
    const expiresAt = now + CHALLENGE_MS;
    const prev = await this.binding(by.tenantId, userId);
    const fields = { did: acct.did, verified_did: prev?.verified_did === acct.did ? acct.did : null, proof: prev?.verified_did === acct.did ? prev.proof : null, challenge_hash: sha256hex(token), challenge_expires_at: expiresAt, pds: acct.pds, handle: acct.handle && prev?.verified_did === acct.did ? acct.handle : null, handle_checked_at: null, verified_at: prev?.verified_did === acct.did ? prev.verified_at : null, updated_at: now };
    if (prev) await this.s().db('atproto_user_dids').where({ id: prev.id }).update(fields);
    else await this.s().db('atproto_user_dids').insert({ id: ulid(), tenant_id: by.tenantId, user_id: userId, created_at: now, ...fields });
    const row = (await this.binding(by.tenantId, userId))!;
    await this.audit(by, 'atproto.did.claimed', { user: userId, did: acct.did }, { replaced: prev && prev.did !== acct.did ? prev.did : null, handle: acct.handle });
    return { row, token, expiresAt };
  }

  /**
   * Verifies the open challenge: the account's profile record (read from its own PDS) must carry the token. On
   * success the DID is bound to the user and the challenge is used up.
   */
  async verify(by: AccountActor, userId: string): Promise<UserDidRow> {
    const row = await this.binding(by.tenantId, userId);
    if (!row || !row.challenge_hash || !row.challenge_expires_at) throw new AtAccountError(409, 'There is no open challenge. Claim the DID first.', { step: 'challenge' });
    if (row.challenge_expires_at < Date.now()) throw new AtAccountError(409, 'The challenge has expired. Claim the DID again for a new one.', { step: 'challenge' });
    const acct = await this.resolveAccount(row.did, { fresh: true });
    const url = `${this.oauth.secureUrl(acct.pds, 'PDS address').replace(/\/+$/, '')}/xrpc/com.atproto.repo.getRecord?${new URLSearchParams({ repo: acct.did, collection: 'app.bsky.actor.profile', rkey: 'self' })}`;
    let found: boolean;
    try {
      const r = await this.s().atproto.http.request(url);
      const body = r.json as { uri?: unknown; value?: { description?: unknown } } | null;
      // The record must be the account's own (its at:// URI names the DID), not one the PDS serves for another repo.
      const own = typeof body?.uri === 'string' && body.uri.startsWith(`at://${acct.did}/`);
      const text = typeof body?.value?.description === 'string' ? body.value.description : '';
      found = r.status === 200 && own && (text.match(CHALLENGE_RE) ?? []).some((t) => safeEqual(sha256hex(t), row.challenge_hash!));
    } catch (err) {
      const refused = refusalOf(err);
      throw new AtAccountError(refused ? 422 : 502, refused ? `The PDS address was refused: ${refused.message}` : 'The PDS could not be reached.', { step: 'pds' });
    }
    if (!found) {
      await this.audit(by, 'atproto.did.verify_failed', { user: userId, did: row.did }, { proof: 'profile' });
      throw new AtAccountError(409, 'The challenge was not found in the profile description of this account.', { step: 'proof' });
    }
    return this.bind(by, userId, { did: acct.did, pds: acct.pds, proof: 'profile', handle: await this.handles.verifiedHandle(acct.did, acct.doc) });
  }

  /** Binds a proven DID to a user (one user per DID in a tenant). */
  async bind(by: AccountActor, userId: string, o: { did: string; pds: string; proof: 'profile' | 'oauth'; handle: string | null }): Promise<UserDidRow> {
    const other = await this.boundUser(by.tenantId, o.did);
    if (other && other !== userId) throw new AtAccountError(409, 'This DID is already bound to another account in this tenant.', { step: 'did' });
    const now = Date.now();
    const fields = { did: o.did, verified_did: o.did, proof: o.proof, challenge_hash: null, challenge_expires_at: null, pds: o.pds, handle: o.handle, handle_checked_at: o.handle ? now : null, verified_at: now, updated_at: now };
    try {
      const prev = await this.binding(by.tenantId, userId);
      if (prev) await this.s().db('atproto_user_dids').where({ id: prev.id }).update(fields);
      else await this.s().db('atproto_user_dids').insert({ id: ulid(), tenant_id: by.tenantId, user_id: userId, created_at: now, ...fields });
    } catch (err) {
      if (isUniqueViolation(err)) throw new AtAccountError(409, 'This DID is already bound to another account in this tenant.', { step: 'did' });
      throw err;
    }
    await this.audit(by, 'atproto.did.verified', { user: userId, did: o.did }, { proof: o.proof, handle: o.handle });
    return (await this.binding(by.tenantId, userId))!;
  }

  /** Sets the handle shown for a bound DID: it must resolve to that DID and be named by its document. */
  async setHandle(by: AccountActor, userId: string, input: string): Promise<UserDidRow> {
    const row = await this.binding(by.tenantId, userId);
    if (!row?.verified_did) throw new AtAccountError(409, 'Bind a DID first; a handle is checked against it.', { step: 'did' });
    const acct = await this.resolveAccount(input, { fresh: true });
    if (acct.did !== row.verified_did) throw new AtAccountError(422, `${acct.handle ?? input} names ${acct.did}, not your DID ${row.verified_did}.`, { step: 'handle', reason: 'mismatch' });
    await this.s().db('atproto_user_dids').where({ id: row.id }).update({ handle: acct.handle, handle_checked_at: Date.now(), pds: acct.pds, updated_at: Date.now() });
    await this.audit(by, 'atproto.handle.set', { user: userId, did: acct.did }, { handle: acct.handle, via: acct.via });
    return (await this.binding(by.tenantId, userId))!;
  }

  async remove(by: AccountActor, row: UserDidRow, reason: 'self' | 'admin'): Promise<void> {
    await this.s().db('atproto_user_dids').where({ id: row.id, tenant_id: by.tenantId }).delete();
    await this.audit(by, 'atproto.did.removed', { user: row.user_id, did: row.did }, { verified: !!row.verified_did, by: reason });
  }

  // ---------- B-1808: sign-in as an OAuth client ----------

  clientId(t: TenantCtx): string {
    return `${t.issuer}/federation/atproto/client-metadata.json`;
  }

  redirectUri(t: TenantCtx): string {
    return `${t.issuer}/federation/atproto/callback`;
  }

  /** The client metadata document the authorization servers fetch (its URL is the client_id). */
  clientMetadata(t: TenantCtx): Record<string, unknown> {
    return {
      client_id: this.clientId(t),
      client_name: `Exprsn-AI (${t.name})`,
      client_uri: new URL(t.issuer).origin,
      application_type: 'web',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      redirect_uris: [this.redirectUri(t)],
      scope: SCOPE,
      token_endpoint_auth_method: 'private_key_jwt',
      token_endpoint_auth_signing_alg: 'ES256',
      jwks_uri: `${t.issuer}/.well-known/jwks.json`,
      dpop_bound_access_tokens: true
    };
  }

  private async credentials(t: TenantCtx): Promise<ClientCredentials> {
    const signer = await this.s().federation.keys.signer(t.id, 'oidc');
    return { clientId: this.clientId(t), redirectUri: this.redirectUri(t), signer };
  }

  private digest(handle: string): string {
    return hmac(this.s().cfg.SESSION_SECRET, `federation-pending:${handle}`);
  }

  private async provider(tenantId: string, id: string): Promise<ProviderRow> {
    const row = await this.s().providers.get(tenantId, id);
    if (!row || row.kind !== 'atproto' || !row.enabled) throw new AtAccountError(404, 'That sign-in option is not available.', { step: 'provider' });
    return row;
  }

  /**
   * Starts an AT-Protocol sign-in (or, with `link`, a proof of control for the signed-in user): resolves the account,
   * finds its authorization server, pushes the authorization request with PKCE and a DPoP proof, and returns the
   * address to send the browser to with the browser binding for the federation cookie.
   */
  async start(t: TenantCtx, o: { providerId: string | null; input: string; returnTo: string | null; link?: LinkBinding }): Promise<{ url: string; browser: string }> {
    const row = o.providerId ? await this.provider(t.id, o.providerId) : null;
    if (!row && !o.link) throw new AtAccountError(404, 'That sign-in option is not available.', { step: 'provider' });
    const acct = await this.resolveAccount(o.input, { fresh: true });
    let issuer: string;
    let as: AsMetadata;
    try {
      issuer = await this.oauth.authServerOf(acct.pds);
      as = await this.oauth.authServer(issuer);
    } catch (err) {
      if (err instanceof AtOAuthError) throw new AtAccountError(502, err.message, { step: 'authorization_server' });
      throw err;
    }
    const cfg = row ? atprotoConfigSchema.parse(row.config ?? {}) : null;
    if (cfg?.authServers.length && !cfg.authServers.includes(issuer)) throw new AtAccountError(403, `This tenant does not accept accounts from ${issuer}.`, { step: 'authorization_server' });
    const browser = randomToken(24);
    const state = randomToken(24);
    const id = this.digest(state);
    const { verifier, challenge } = pkcePair();
    const dpop = newDpopKey();
    const dpopSealed = await this.s().keys.seal(t.id, JSON.stringify(dpop.key.export({ format: 'jwk' })), `atproto-dpop:${id}`);
    let requestUri: string;
    try {
      requestUri = await this.oauth.par(as, await this.credentials(t), dpop, { state, challenge, loginHint: acct.handle ?? acct.did, scope: SCOPE });
    } catch (err) {
      if (err instanceof AtOAuthError) throw new AtAccountError(502, err.message, { step: 'par' });
      throw err;
    }
    const pending: PendingSignIn = { providerId: row?.id ?? null, browser: this.digest(`browser:${browser}`), returnTo: o.returnTo, ...(o.link ? { link: o.link } : {}), expectDid: acct.did, handle: acct.handle, issuer, pds: acct.pds, verifier, dpopSealed, dpopJwk: dpop.jwk };
    await this.s().db('federation_pending').insert({ id, tenant_id: t.id, kind: 'atproto', data: JSON.stringify(pending), expires_at: Date.now() + PENDING_MS });
    return { url: this.oauth.authorizeUrl(as, this.clientId(t), requestUri), browser };
  }

  /** Takes (single use) the pending sign-in for a state, checking the browser binding first. */
  private async takePending(tenantId: string, state: string | undefined, browser: string | undefined): Promise<{ id: string; data: PendingSignIn }> {
    if (!state || state.length > 100) throw new AtAccountError(400, 'The sign-in response has no state. Start again.', { step: 'state' });
    const id = this.digest(state);
    const row = (await this.s().db('federation_pending').where({ id, tenant_id: tenantId, kind: 'atproto' }).first()) as { data: string; expires_at: number } | undefined;
    if (!row) throw new AtAccountError(400, 'This sign-in response was already used or is unknown. Start again.', { step: 'state' });
    const data = json<PendingSignIn>(row.data, { browser: '' } as PendingSignIn);
    if (!browser || !safeEqual(this.digest(`browser:${browser}`), data.browser)) throw new AtAccountError(400, 'This sign-in was started in another browser. Start again.', { step: 'browser' });
    if (!(await this.s().db('federation_pending').where({ id }).delete())) throw new AtAccountError(400, 'This sign-in response was already used. Start again.', { step: 'state' });
    if (Number(row.expires_at) < Date.now()) throw new AtAccountError(400, 'The sign-in took too long. Start again.', { step: 'state' });
    return { id, data };
  }

  /**
   * Completes the sign-in at the callback: the `iss` must be the authorization server the request went to, the code
   * is exchanged with DPoP, and the DID in `sub` must be the one asked for, use this authorization server through its
   * own PDS, and be the account the token reaches at the PDS.
   */
  async finish(t: TenantCtx, query: Record<string, unknown>, browser: string | undefined): Promise<FinishedSignIn> {
    const { id, data } = await this.takePending(t.id, typeof query.state === 'string' ? query.state : undefined, browser);
    if (query.iss !== data.issuer) throw new AtAccountError(400, 'The response does not come from the authorization server the sign-in went to.', { step: 'iss' });
    if (typeof query.error === 'string') throw new AtAccountError(400, `The authorization server refused the sign-in: ${query.error.slice(0, 100)}${typeof query.error_description === 'string' ? ` (${query.error_description.slice(0, 200)})` : ''}.`, { step: 'authorize' });
    if (typeof query.code !== 'string' || !query.code || query.code.length > 2000) throw new AtAccountError(400, 'The authorization server returned no code.', { step: 'authorize' });
    const row = data.providerId ? await this.provider(t.id, data.providerId) : null;
    const dpop: DpopKey = { key: createPrivateKey({ key: JSON.parse(await this.s().keys.open(t.id, data.dpopSealed, `atproto-dpop:${id}`)) as Jwk, format: 'jwk' }), jwk: data.dpopJwk };
    const client = await this.credentials(t);
    let as: AsMetadata;
    let tokens;
    try {
      as = await this.oauth.authServer(data.issuer);
      tokens = await this.oauth.exchange(as, client, dpop, { code: query.code, verifier: data.verifier });
    } catch (err) {
      if (err instanceof AtOAuthError) throw new AtAccountError(400, err.message, { step: 'token' });
      throw err;
    }
    try {
      if (data.expectDid && tokens.sub !== data.expectDid) throw new AtAccountError(400, 'The authorization server signed in another account than the one asked for.', { step: 'sub' });
      // The DID's own PDS must name this authorization server: an authorization server cannot answer for accounts
      // it does not hold.
      const acct = await this.resolveAccount(tokens.sub, { fresh: true });
      let issuer: string;
      try {
        issuer = await this.oauth.authServerOf(acct.pds);
      } catch (err) {
        if (err instanceof AtOAuthError) throw new AtAccountError(400, err.message, { step: 'authorization_server' });
        throw err;
      }
      if (issuer !== data.issuer) throw new AtAccountError(400, "The account's PDS does not use the authorization server that answered.", { step: 'authorization_server' });
      let session;
      try {
        session = await this.oauth.session(acct.pds, dpop, tokens.accessToken);
      } catch (err) {
        if (err instanceof AtOAuthError) throw new AtAccountError(400, err.message, { step: 'pds_session' });
        throw err;
      }
      if (session.did !== tokens.sub) throw new AtAccountError(400, 'The token reaches another account at the PDS.', { step: 'pds_session' });
      const handle = await this.handles.verifiedHandle(acct.did, acct.doc);
      const username = handle && USERNAME.test(handle) ? handle : usernameForDid(acct.did);
      return {
        row,
        did: acct.did,
        handle,
        pds: acct.pds,
        issuer,
        returnTo: data.returnTo,
        ...(data.link ? { link: data.link } : {}),
        boundUserId: await this.boundUser(t.id, acct.did),
        user: { externalId: acct.did, username, displayName: handle ?? acct.did, email: null, groups: [acct.did] }
      };
    } finally {
      // Exprsn-AI only needed to learn who signed in: the tokens are given back and never stored.
      if (tokens.refreshToken) void this.oauth.revoke(as, client, dpop, tokens.refreshToken);
      void this.oauth.revoke(as, client, dpop, tokens.accessToken);
    }
  }

  /** The User stores "Test connection" for an atproto store: the client metadata and the client assertion key. */
  async test(row: ProviderRow, steps: Step[]): Promise<boolean> {
    const s = this.s();
    const t = await s.federation.tenantById(row.tenant_id);
    if (!t) return false;
    const https = t.issuer.startsWith('https://');
    steps.push({ title: 'Client metadata address', ok: https || s.cfg.NODE_ENV !== 'production', detail: `${this.clientId(t)}${https ? '' : ' (authorization servers on the internet require https)'}` });
    try {
      const signer = await s.federation.keys.signer(t.id, 'oidc');
      steps.push({ title: 'Client assertion key', ok: signer.alg === 'ES256', detail: `${signer.kid} (${signer.alg}${signer.remote ? ', outside the process' : ''})` });
    } catch (err) {
      steps.push({ title: 'Client assertion key', ok: false, detail: (err as Error).message });
    }
    const cfg = atprotoConfigSchema.safeParse(row.config ?? {});
    steps.push({ title: 'Store settings', ok: cfg.success, detail: cfg.success ? `${cfg.data.boundOnly ? 'bound DIDs only' : 'bound DIDs, and other accounts by group mapping'}; ${cfg.data.authServers.length ? `authorization servers ${cfg.data.authServers.join(', ')}` : 'any authorization server'}` : 'invalid' });
    return steps.every((x) => x.ok);
  }
}
