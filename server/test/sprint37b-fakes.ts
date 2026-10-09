import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FakeMcp } from './fake-mcp.js';

const b64u = (b: Buffer) => b.toString('base64url');

/**
 * Sprint 37b (B-7103): an authorization server for an MCP server stand-in. It publishes the MCP server's protected
 * resource metadata (RFC 9728) and its own metadata (RFC 8414), registers clients (RFC 7591), answers /authorize for
 * the user named by `?user=` (no sign-in page: the test plays the browser), checks PKCE and the resource at /token,
 * rotates refresh tokens, and revokes (RFC 7009). It makes `mcp` accept only its live access tokens and records whose
 * token each call carried.
 */
export class FakeAs {
  server: Server;
  url = '';
  accessTtl = 3600;
  registrations: Record<string, unknown>[] = [];
  revoked: string[] = [];
  tokenRequests: Record<string, string>[] = [];
  private codes = new Map<string, { user: string; challenge: string; redirect: string; client: string; resource: string | null }>();
  private access = new Map<string, { user: string; exp: number }>();
  private refresh = new Map<string, string>();
  private n = 0;

  constructor(private readonly mcp: FakeMcp) {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => this.handle(req, res, raw));
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    this.mcp.challenge = `Bearer resource_metadata="${this.url}/.well-known/oauth-protected-resource/mcp", scope="notes"`;
    this.mcp.authorize = (auth) => this.userOf(auth) !== null;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }

  /** Whose live access token an Authorization header carries, or null. */
  userOf(auth: string | null): string | null {
    const t = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    const a = t ? this.access.get(t) : undefined;
    return a && a.exp > Date.now() ? a.user : null;
  }

  /** Expires every access token now (refresh tokens stay valid). */
  expireAll(): void {
    for (const a of this.access.values()) a.exp = 0;
  }

  private json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private issue(user: string) {
    const at = `at-${user}-${++this.n}-${b64u(randomBytes(6))}`;
    const rt = `rt-${user}-${this.n}-${b64u(randomBytes(6))}`;
    this.access.set(at, { user, exp: Date.now() + this.accessTtl * 1000 });
    this.refresh.set(rt, user);
    return { access_token: at, token_type: 'Bearer', expires_in: this.accessTtl, refresh_token: rt, scope: 'notes' };
  }

  private handle(req: IncomingMessage, res: ServerResponse, raw: string) {
    const u = new URL(req.url ?? '/', this.url);
    if (req.method === 'GET' && u.pathname === '/.well-known/oauth-protected-resource/mcp') return this.json(res, 200, { resource: this.mcp.url, authorization_servers: [this.url], scopes_supported: ['notes'] });
    if (req.method === 'GET' && u.pathname === '/.well-known/oauth-authorization-server')
      return this.json(res, 200, { issuer: this.url, authorization_endpoint: `${this.url}/authorize`, token_endpoint: `${this.url}/token`, registration_endpoint: `${this.url}/register`, revocation_endpoint: `${this.url}/revoke`, code_challenge_methods_supported: ['S256'] });
    if (req.method === 'POST' && u.pathname === '/register') {
      const body = JSON.parse(raw) as Record<string, unknown>;
      this.registrations.push(body);
      return this.json(res, 201, { client_id: `dyn-${this.registrations.length}`, ...body });
    }
    if (req.method === 'GET' && u.pathname === '/authorize') {
      const q = u.searchParams;
      const code = b64u(randomBytes(12));
      this.codes.set(code, { user: q.get('user') ?? 'nobody', challenge: q.get('code_challenge') ?? '', redirect: q.get('redirect_uri') ?? '', client: q.get('client_id') ?? '', resource: q.get('resource') });
      const back = new URL(q.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state') ?? '');
      back.searchParams.set('iss', this.url);
      res.writeHead(302, { location: back.toString() }).end();
      return;
    }
    if (req.method === 'POST' && u.pathname === '/token') {
      const f = Object.fromEntries(new URLSearchParams(raw));
      this.tokenRequests.push(f);
      if (f.grant_type === 'authorization_code') {
        const c = this.codes.get(f.code ?? '');
        this.codes.delete(f.code ?? '');
        if (!c || c.redirect !== f.redirect_uri || c.client !== f.client_id) return this.json(res, 400, { error: 'invalid_grant' });
        if (b64u(createHash('sha256').update(f.code_verifier ?? '').digest()) !== c.challenge) return this.json(res, 400, { error: 'invalid_grant', error_description: 'PKCE' });
        if (c.resource !== f.resource || f.resource !== this.mcp.url) return this.json(res, 400, { error: 'invalid_target' });
        return this.json(res, 200, this.issue(c.user));
      }
      if (f.grant_type === 'refresh_token') {
        const user = this.refresh.get(f.refresh_token ?? '');
        if (!user) return this.json(res, 400, { error: 'invalid_grant' });
        this.refresh.delete(f.refresh_token!);
        return this.json(res, 200, this.issue(user));
      }
      return this.json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (req.method === 'POST' && u.pathname === '/revoke') {
      const f = Object.fromEntries(new URLSearchParams(raw));
      this.revoked.push(f.token ?? '');
      this.access.delete(f.token ?? '');
      this.refresh.delete(f.token ?? '');
      res.writeHead(200).end();
      return;
    }
    res.writeHead(404).end();
  }
}
