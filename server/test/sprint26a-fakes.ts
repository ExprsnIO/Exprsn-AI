import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/*
 * Sprint 26a (B-1804): a stand-in for GitHub's OAuth app endpoints and the REST API the GitHub store reads.
 *
 * - `GET /login/oauth/authorize` is never fetched by the server (the browser goes there); tests call `authorize()`
 *   with the redirect's parameters and a user, which records a code bound to the PKCE challenge and redirect URI.
 * - `POST /login/oauth/access_token` exchanges the code (once) for a token, checking the client, the redirect URI and
 *   the PKCE verifier.
 * - `GET /api/user`, `/api/user/emails`, `/api/user/orgs`, `/api/user/teams` answer for the token's user.
 */

export interface GitHubUser {
  id: number;
  login: string;
  name?: string;
  emails?: { email: string; primary: boolean; verified: boolean }[];
  orgs?: string[];
  teams?: { org: string; slug: string }[];
}

export class FakeGitHub {
  readonly clientId = 'gh-client';
  readonly clientSecret = 'gh-secret-value';
  url = '';
  readonly requests: { method: string; path: string; auth?: string }[] = [];
  private readonly codes = new Map<string, { user: GitHubUser; challenge: string; redirectUri: string }>();
  private readonly tokens = new Map<string, GitHubUser>();
  private readonly server: Server;

  constructor() {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => this.handle(req, res, raw));
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }

  /** The user approves the app at GitHub: returns the code GitHub would put on the redirect. */
  authorize(authorizeUrl: string, user: GitHubUser): { code: string; state: string; redirectUri: string } {
    const u = new URL(authorizeUrl);
    if (u.pathname !== '/login/oauth/authorize') throw new Error(`unexpected authorize path ${u.pathname}`);
    if (u.searchParams.get('client_id') !== this.clientId) throw new Error('wrong client_id');
    if (u.searchParams.get('code_challenge_method') !== 'S256') throw new Error('no PKCE');
    const code = randomBytes(10).toString('hex');
    const redirectUri = u.searchParams.get('redirect_uri')!;
    this.codes.set(code, { user, challenge: u.searchParams.get('code_challenge')!, redirectUri });
    return { code, state: u.searchParams.get('state')!, redirectUri };
  }

  private json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private handle(req: IncomingMessage, res: ServerResponse, raw: string) {
    const url = new URL(req.url ?? '/', this.url);
    this.requests.push({ method: req.method ?? 'GET', path: url.pathname, ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) });
    if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
      const form = new URLSearchParams(raw);
      if (form.get('client_id') !== this.clientId || form.get('client_secret') !== this.clientSecret) return this.json(res, 200, { error: 'incorrect_client_credentials' });
      const c = this.codes.get(form.get('code') ?? '');
      if (!c) return this.json(res, 200, { error: 'bad_verification_code' });
      this.codes.delete(form.get('code')!);
      if (c.redirectUri !== form.get('redirect_uri')) return this.json(res, 200, { error: 'redirect_uri_mismatch' });
      const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
      if (challenge !== c.challenge) return this.json(res, 200, { error: 'bad_verification_code', error_description: 'PKCE verification failed' });
      const token = `gho_${randomBytes(16).toString('hex')}`;
      this.tokens.set(token, c.user);
      return this.json(res, 200, { access_token: token, token_type: 'bearer', scope: 'read:org,read:user,user:email' });
    }
    if (req.method === 'GET' && url.pathname === '/api/') return this.json(res, 200, { current_user_url: `${this.url}/api/user` });
    if (req.method === 'GET' && url.pathname.startsWith('/api/user')) {
      const user = this.tokens.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (!user) return this.json(res, 401, { message: 'Bad credentials' });
      const page = Number(url.searchParams.get('page') ?? '1');
      switch (url.pathname) {
        case '/api/user':
          return this.json(res, 200, { id: user.id, login: user.login, name: user.name ?? null, email: null });
        case '/api/user/emails':
          return this.json(res, 200, user.emails ?? []);
        case '/api/user/orgs':
          return this.json(res, 200, page > 1 ? [] : (user.orgs ?? []).map((login, i) => ({ login, id: i + 1 })));
        case '/api/user/teams':
          return this.json(res, 200, page > 1 ? [] : (user.teams ?? []).map((t, i) => ({ id: i + 1, slug: t.slug, name: t.slug, organization: { login: t.org } })));
      }
    }
    this.json(res, 404, { message: 'Not Found' });
  }
}
