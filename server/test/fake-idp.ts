import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export interface FakeUser {
  sub: string;
  preferred_username: string;
  name?: string;
  email?: string;
  groups?: string[];
}

/**
 * An in-process upstream OpenID Connect provider for tests: discovery, JWKS (RS256), and a token endpoint that
 * checks the client secret, redirect URI and PKCE verifier before returning an ID token with the request's nonce.
 * `authorize(url, user)` stands in for the browser visiting the authorization endpoint and returns the code.
 */
export class FakeIdp {
  url = '';
  readonly clientId = 'exprsn-rp';
  readonly clientSecret = 'upstream-secret-value';
  private server: Server | null = null;
  private readonly key: KeyObject;
  private readonly publicJwk: Record<string, unknown>;
  private readonly codes = new Map<string, { user: FakeUser; nonce: string; challenge: string; redirectUri: string }>();
  /** Makes the next ID token carry this nonce instead of the request's (a replay test). */
  nonceOverride: string | null = null;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.key = privateKey;
    this.publicJwk = { ...(publicKey.export({ format: 'jwk' }) as object), kid: 'up-1', use: 'sig', alg: 'RS256' };
  }

  async start(): Promise<void> {
    const app = express();
    app.get('/.well-known/openid-configuration', (_req, res) => {
      res.json({ issuer: this.url, authorization_endpoint: `${this.url}/authorize`, token_endpoint: `${this.url}/token`, jwks_uri: `${this.url}/jwks` });
    });
    app.get('/jwks', (_req, res) => res.json({ keys: [this.publicJwk] }));
    app.post('/token', express.urlencoded({ extended: false }), (req, res) => {
      const auth = req.header('authorization') ?? '';
      const [id, secret] = Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString().split(':').map(decodeURIComponent);
      if (id !== this.clientId || secret !== this.clientSecret) return void res.status(401).json({ error: 'invalid_client' });
      const entry = this.codes.get(String(req.body.code));
      this.codes.delete(String(req.body.code));
      if (!entry) return void res.status(400).json({ error: 'invalid_grant' });
      if (req.body.redirect_uri !== entry.redirectUri) return void res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri' });
      const challenge = b64u(createHash('sha256').update(String(req.body.code_verifier)).digest());
      if (challenge !== entry.challenge) return void res.status(400).json({ error: 'invalid_grant', error_description: 'pkce' });
      const now = Math.floor(Date.now() / 1000);
      res.json({ access_token: 'x', token_type: 'Bearer', id_token: this.idToken({ iss: this.url, aud: this.clientId, iat: now, exp: now + 300, nonce: this.nonceOverride ?? entry.nonce, ...entry.user }) });
    });
    await new Promise<void>((resolve) => {
      this.server = app.listen(0, '127.0.0.1', () => resolve());
    });
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  idToken(claims: Record<string, unknown>): string {
    const header = b64u(JSON.stringify({ alg: 'RS256', kid: 'up-1', typ: 'JWT' }));
    const payload = b64u(JSON.stringify(claims));
    return `${header}.${payload}.${b64u(sign('sha256', Buffer.from(`${header}.${payload}`), this.key))}`;
  }

  /** The user "signs in" at the authorization endpoint the RP redirected to; returns the code for the callback. */
  authorize(authorizeUrl: string, user: FakeUser): { code: string; state: string } {
    const u = new URL(authorizeUrl);
    if (u.searchParams.get('client_id') !== this.clientId) throw new Error('wrong client');
    if (u.searchParams.get('code_challenge_method') !== 'S256') throw new Error('no PKCE');
    const code = randomBytes(16).toString('hex');
    this.codes.set(code, { user, nonce: u.searchParams.get('nonce')!, challenge: u.searchParams.get('code_challenge')!, redirectUri: u.searchParams.get('redirect_uri')! });
    return { code, state: u.searchParams.get('state')! };
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
