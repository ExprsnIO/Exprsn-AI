import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign, type KeyObject } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Request, type Response } from 'express';
import { decodeJwt, keyFromJwk, verifyDpopProof, verifyJwt, verifySignature, type Jwk } from '../src/federation/jose.js';
import type { FakePlcDirectory } from './sprint25b-fakes.js';

/*
 * Test double for Sprint 26 (B-1807, B-1808): a PDS that is its own AT-Protocol authorization server, listening on
 * 127.0.0.1. It checks what a real one checks of a client, as the AT-Protocol OAuth profile describes it:
 *
 * - protected-resource metadata naming itself as the authorization server, and authorization-server metadata;
 * - PAR only, with client authentication by `private_key_jwt` (the client metadata document and its jwks_uri are
 *   fetched through `fetchClient`, so the test can answer from the app under test), PKCE S256, the `atproto` scope,
 *   a registered redirect URI and a DPoP proof carrying the server's nonce (a proof without it gets `use_dpop_nonce`);
 * - the token request: the same client, the code once, the PKCE verifier, and a DPoP proof from the same key as the
 *   PAR; tokens are DPoP-bound (`token_type: DPoP`, `cnf.jkt` in the access token);
 * - `com.atproto.server.getSession` as a resource server: the DPoP scheme, a proof with `ath` and the resource
 *   server's own nonce, from the key the token is bound to;
 * - token revocation, `com.atproto.repo.getRecord` for profile records, and `/.well-known/atproto-did`.
 *
 * `authorize(url, did)` stands in for the person signing in at the authorization page and returns the callback URL.
 */

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export interface FakeAccount {
  did: string;
  handle: string;
  description?: string;
}

interface ParRequest {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  scope: string;
  loginHint: string | null;
  jkt: string;
  expiresAt: number;
}

export class FakePds {
  url = '';
  private server: Server | null = null;
  readonly accounts = new Map<string, FakeAccount>();
  private readonly key: KeyObject;
  private readonly jwk: Jwk;
  /** Current nonces: the authorization server's and the resource server's (they differ, as on a real PDS). */
  asNonce = b64u(randomBytes(12));
  rsNonce = b64u(randomBytes(12));
  private readonly requests = new Map<string, ParRequest>();
  private readonly codes = new Map<string, ParRequest & { did: string }>();
  private readonly jtis = new Set<string>();
  /** What happened, for the test to inspect. */
  readonly log = { nonceRetries: { par: 0, token: 0, session: 0 }, pars: [] as ParRequest[], issued: [] as { access: string; refresh: string; jkt: string; did: string; tokenType: string }[], sessions: [] as { did: string; jkt: string }[], revoked: [] as string[], clientErrors: [] as string[] };
  /** Misbehaviour switches. */
  subOverride: string | null = null;
  issOverride: string | null = null;
  tokenType = 'DPoP';
  wellKnownDid: string | null = null;

  constructor(private readonly fetchClient: (url: string) => Promise<unknown>) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.key = pair.privateKey;
    const j = pair.publicKey.export({ format: 'jwk' }) as Jwk;
    this.jwk = { kty: 'EC', crv: 'P-256', x: j.x, y: j.y };
  }

  /** A DID document for an account on this PDS, registered in the fake PLC directory. */
  register(plc: FakePlcDirectory, account: FakeAccount, o: { pds?: string; alsoKnownAs?: string[] } = {}): void {
    this.accounts.set(account.did, account);
    plc.documents.set(account.did, {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: account.did,
      alsoKnownAs: o.alsoKnownAs ?? [`at://${account.handle}`],
      verificationMethod: [],
      service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: o.pds ?? this.url }]
    });
  }

  private asMetadata() {
    return {
      issuer: this.url,
      authorization_endpoint: `${this.url}/oauth/authorize`,
      token_endpoint: `${this.url}/oauth/token`,
      pushed_authorization_request_endpoint: `${this.url}/oauth/par`,
      revocation_endpoint: `${this.url}/oauth/revoke`,
      require_pushed_authorization_requests: true,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['atproto', 'transition:generic'],
      token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
      token_endpoint_auth_signing_alg_values_supported: ['ES256'],
      dpop_signing_alg_values_supported: ['ES256'],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: true
    };
  }

  private oauthError(res: Response, status: number, error: string, description: string): void {
    this.log.clientErrors.push(`${error}: ${description}`);
    res.status(status).json({ error, error_description: description });
  }

  /** Checks the client assertion against the client's own metadata document and key set. Returns the client_id. */
  private async client(form: Record<string, string>): Promise<{ clientId: string; meta: Record<string, unknown> }> {
    if (form.client_assertion_type !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' || !form.client_assertion) throw new Error('private_key_jwt client authentication is required');
    const meta = (await this.fetchClient(form.client_id!)) as Record<string, unknown>;
    if (meta.client_id !== form.client_id) throw new Error('the client metadata names another client_id');
    if (meta.token_endpoint_auth_method !== 'private_key_jwt' || meta.dpop_bound_access_tokens !== true) throw new Error('the client metadata is not a confidential DPoP client');
    const jwks = (await this.fetchClient(String(meta.jwks_uri))) as { keys: Jwk[] };
    const claims = verifyJwt(form.client_assertion, jwks.keys, { issuer: form.client_id!, audience: this.url, algs: ['ES256'] });
    if (claims.sub !== form.client_id || typeof claims.jti !== 'string') throw new Error('bad client assertion claims');
    if (this.jtis.has(`ca:${claims.jti}`)) throw new Error('client assertion replayed');
    this.jtis.add(`ca:${claims.jti}`);
    return { clientId: form.client_id!, meta };
  }

  /** Checks a DPoP proof for this endpoint with the current nonce. Null when a nonce must be sent first. */
  private dpop(req: Request, path: string, nonce: string, accessToken?: string): { jkt: string } | null {
    const proof = req.header('dpop');
    if (!proof) throw new Error('no DPoP proof');
    const p = verifyDpopProof(proof, { method: req.method, url: `${this.url}${path}`, maxAgeS: 60, ...(accessToken !== undefined ? { accessToken } : {}) });
    if (p.nonce !== nonce) return null;
    if (this.jtis.has(`dpop:${p.jti}`)) throw new Error('DPoP proof replayed');
    this.jtis.add(`dpop:${p.jti}`);
    return { jkt: p.jkt };
  }

  private accessToken(did: string, jkt: string, scope: string): string {
    const now = Math.floor(Date.now() / 1000);
    const header = b64u(JSON.stringify({ alg: 'ES256', typ: 'at+jwt' }));
    const payload = b64u(JSON.stringify({ iss: this.url, aud: this.url, sub: did, scope, cnf: { jkt }, iat: now, exp: now + 300, jti: b64u(randomBytes(8)) }));
    return `${header}.${payload}.${b64u(cryptoSign('sha256', Buffer.from(`${header}.${payload}`), { key: this.key, dsaEncoding: 'ieee-p1363' }))}`;
  }

  async start(): Promise<void> {
    const app = express();
    const form = express.urlencoded({ extended: false });
    app.get('/.well-known/oauth-protected-resource', (_req, res) => res.json({ resource: this.url, authorization_servers: [this.url], scopes_supported: [], bearer_methods_supported: ['header'] }));
    app.get('/.well-known/oauth-authorization-server', (_req, res) => res.json(this.asMetadata()));
    app.get('/.well-known/atproto-did', (_req, res) => (this.wellKnownDid ? res.type('text/plain').send(this.wellKnownDid) : res.status(404).end()));

    app.post('/oauth/par', form, async (req, res) => {
      const f = req.body as Record<string, string>;
      try {
        const proof = this.dpop(req, '/oauth/par', this.asNonce);
        if (!proof) {
          this.log.nonceRetries.par++;
          return void res.status(400).setHeader('DPoP-Nonce', this.asNonce).json({ error: 'use_dpop_nonce', error_description: 'Authorization server requires nonce in DPoP proof' });
        }
        const { clientId, meta } = await this.client(f);
        if (f.response_type !== 'code' || f.code_challenge_method !== 'S256' || !f.code_challenge || !f.state) throw new Error('code flow with PKCE S256 and state is required');
        if (!(meta.redirect_uris as string[]).includes(f.redirect_uri!)) throw new Error('unregistered redirect_uri');
        const scopes = String(f.scope ?? '').split(' ');
        if (!scopes.includes('atproto') || scopes.some((x) => !String(meta.scope).split(' ').includes(x))) throw new Error('scope must include atproto and be in the client metadata');
        const uri = `urn:ietf:params:oauth:request_uri:${b64u(randomBytes(16))}`;
        const r: ParRequest = { clientId, redirectUri: f.redirect_uri!, state: f.state, challenge: f.code_challenge, scope: f.scope!, loginHint: f.login_hint ?? null, jkt: proof.jkt, expiresAt: Date.now() + 60_000 };
        this.requests.set(uri, r);
        this.log.pars.push(r);
        res.setHeader('DPoP-Nonce', this.asNonce);
        res.status(201).json({ request_uri: uri, expires_in: 60 });
      } catch (err) {
        this.oauthError(res, 400, 'invalid_request', (err as Error).message);
      }
    });

    app.post('/oauth/token', form, async (req, res) => {
      const f = req.body as Record<string, string>;
      try {
        const proof = this.dpop(req, '/oauth/token', this.asNonce);
        if (!proof) {
          this.log.nonceRetries.token++;
          return void res.status(400).setHeader('DPoP-Nonce', this.asNonce).json({ error: 'use_dpop_nonce', error_description: 'nonce required' });
        }
        const { clientId } = await this.client(f);
        if (f.grant_type !== 'authorization_code') throw new Error('unsupported grant');
        const code = this.codes.get(f.code ?? '');
        this.codes.delete(f.code ?? '');
        if (!code || code.clientId !== clientId) return void this.oauthError(res, 400, 'invalid_grant', 'unknown code');
        if (code.redirectUri !== f.redirect_uri) return void this.oauthError(res, 400, 'invalid_grant', 'redirect_uri');
        if (b64u(createHash('sha256').update(String(f.code_verifier)).digest()) !== code.challenge) return void this.oauthError(res, 400, 'invalid_grant', 'pkce');
        if (proof.jkt !== code.jkt) return void this.oauthError(res, 400, 'invalid_dpop_proof', 'the token request uses another DPoP key than the PAR');
        const sub = this.subOverride ?? code.did;
        const access = this.accessToken(sub, proof.jkt, code.scope);
        const refresh = b64u(randomBytes(24));
        this.log.issued.push({ access, refresh, jkt: proof.jkt, did: sub, tokenType: this.tokenType });
        res.setHeader('DPoP-Nonce', this.asNonce);
        res.json({ access_token: access, token_type: this.tokenType, refresh_token: refresh, scope: code.scope, sub, expires_in: 300 });
      } catch (err) {
        this.oauthError(res, 400, 'invalid_client', (err as Error).message);
      }
    });

    app.post('/oauth/revoke', form, async (req, res) => {
      const f = req.body as Record<string, string>;
      try {
        const proof = this.dpop(req, '/oauth/revoke', this.asNonce);
        if (!proof) return void res.status(400).setHeader('DPoP-Nonce', this.asNonce).json({ error: 'use_dpop_nonce' });
        await this.client(f);
        this.log.revoked.push(String(f.token));
        res.status(200).end();
      } catch (err) {
        this.oauthError(res, 400, 'invalid_request', (err as Error).message);
      }
    });

    app.get('/xrpc/com.atproto.server.getSession', (req, res) => {
      const auth = req.header('authorization') ?? '';
      if (!auth.startsWith('DPoP ')) return void res.status(401).json({ error: 'AuthenticationRequired', message: 'DPoP scheme required' });
      const token = auth.slice(5);
      try {
        const { header, claims, signingInput, signature } = decodeJwt(token);
        if (header.alg !== 'ES256' || !verifySignature('ES256', signingInput, signature, keyFromJwk(this.jwk))) throw new Error('bad token');
        const proof = this.dpop(req, '/xrpc/com.atproto.server.getSession', this.rsNonce, token);
        if (!proof) {
          this.log.nonceRetries.session++;
          return void res.status(401).setHeader('WWW-Authenticate', 'DPoP error="use_dpop_nonce", error_description="Resource server requires nonce in DPoP proof"').setHeader('DPoP-Nonce', this.rsNonce).json({ error: 'use_dpop_nonce' });
        }
        if ((claims.cnf as { jkt?: string } | undefined)?.jkt !== proof.jkt) throw new Error('the proof key is not the one the token is bound to');
        const account = this.accounts.get(String(claims.sub));
        this.log.sessions.push({ did: String(claims.sub), jkt: proof.jkt });
        res.json({ did: claims.sub, handle: account?.handle ?? 'handle.invalid', active: true });
      } catch (err) {
        res.status(401).json({ error: 'InvalidToken', message: (err as Error).message });
      }
    });

    app.get('/xrpc/com.atproto.repo.getRecord', (req, res) => {
      const a = this.accounts.get(String(req.query.repo));
      if (!a || req.query.collection !== 'app.bsky.actor.profile' || req.query.rkey !== 'self') return void res.status(400).json({ error: 'RecordNotFound', message: 'Could not locate record' });
      res.json({ uri: `at://${a.did}/app.bsky.actor.profile/self`, cid: 'bafyreib2rxk3rh6kzwq', value: { $type: 'app.bsky.actor.profile', description: a.description ?? '' } });
    });

    await new Promise<void>((resolve) => {
      this.server = app.listen(0, '127.0.0.1', () => resolve());
    });
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  /** The person signs in at the authorization page as `did`; returns the callback URL with code, state and iss. */
  authorize(authorizeUrl: string, did: string): string {
    const u = new URL(authorizeUrl);
    if (`${u.origin}${u.pathname}` !== `${this.url}/oauth/authorize`) throw new Error('not this authorization server');
    if ([...u.searchParams.keys()].sort().join(',') !== 'client_id,request_uri') throw new Error('only client_id and request_uri may travel through the browser');
    const r = this.requests.get(u.searchParams.get('request_uri')!);
    this.requests.delete(u.searchParams.get('request_uri')!);
    if (!r || r.expiresAt < Date.now() || r.clientId !== u.searchParams.get('client_id')) throw new Error('unknown request_uri');
    const code = b64u(randomBytes(16));
    this.codes.set(code, { ...r, did });
    const cb = new URL(r.redirectUri);
    cb.searchParams.set('code', code);
    cb.searchParams.set('state', r.state);
    cb.searchParams.set('iss', this.issOverride ?? this.url);
    return cb.toString();
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
