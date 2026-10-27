import { createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';

/*
 * 1.9.0, Sprint 54 (B-183): local stand-ins for Microsoft Graph (with Entra ID's token endpoint) and the Google
 * Admin SDK Directory API (with Google's token endpoint). Enough of each for the directory pull: the client
 * credentials grant, the JWT bearer grant with a service account's signature checked, users, a user's groups with
 * paging, and a first page of users and groups. They are never the real services.
 *
 * QA-1: every user page by page (`$top`/`$skiptoken` on Graph, `maxResults`/`pageToken` on Google), and Graph's
 * delta queries: a change log (`touchUser`, `removeUser`, `memberChange`, `renameGroup`, `nestGroup`), links that
 * start from now (`$deltatoken=latest`), changes since a token in pages of `deltaPageSize`, members@delta on groups,
 * a group's transitive members, and 410 for a token older than `expireBefore`.
 */

export interface GraphUser {
  id: string;
  userPrincipalName: string;
  displayName?: string;
  mail?: string;
  accountEnabled?: boolean;
  groups: { id: string; displayName: string; securityEnabled?: boolean }[];
}

export class FakeGraph {
  url = '';
  readonly tenant = 'contoso-tenant';
  readonly clientId = 'graph-app-id';
  readonly clientSecret = 'graph-secret-' + randomBytes(6).toString('hex');
  readonly users = new Map<string, GraphUser>();
  readonly grants: Record<string, string>[] = [];
  readonly requests: { path: string; auth: string | undefined }[] = [];
  /** Sends the second page's link to another host (a test of the origin check). */
  foreignNextLink = false;
  /** Users a page of /users holds when the caller asks for more ($top is capped here, as Graph caps it at 999). */
  userPageSize = 999;
  /** Delta: the change log, a token is the sequence number it was read at. */
  private seq = 0;
  private readonly log: ({ seq: number; kind: 'user'; id: string; removed?: boolean } | { seq: number; kind: 'group'; id: string; removed?: boolean; renamed?: boolean; members?: { id: string; type: 'user' | 'group'; removed?: boolean }[] })[] = [];
  /** A token below this answers 410 Gone (syncStateNotFound). */
  expireBefore = 0;
  deltaPageSize = 2;
  /** Nested groups: a group's member groups (their members count as the parent's transitive members). */
  readonly nested = new Map<string, string[]>();
  private tokens = new Set<string>();
  private server: Server | null = null;

  /** A user's own properties changed (or they were added). */
  touchUser(id: string): void {
    this.log.push({ seq: ++this.seq, kind: 'user', id });
  }

  removeUser(id: string): void {
    this.users.delete(id);
    this.log.push({ seq: ++this.seq, kind: 'user', id, removed: true });
  }

  /** A user added to (or removed from) a group: the group's members@delta names them. */
  memberChange(groupId: string, userId: string, removed = false): void {
    this.log.push({ seq: ++this.seq, kind: 'group', id: groupId, members: [{ id: userId, type: 'user', removed }] });
  }

  /** A group renamed everywhere it is held. */
  renameGroup(groupId: string, displayName: string): void {
    for (const u of this.users.values()) for (const g of u.groups) if (g.id === groupId) g.displayName = displayName;
    this.log.push({ seq: ++this.seq, kind: 'group', id: groupId, renamed: true });
  }

  /** A group added to a group (its members are the parent's transitive members from now on). */
  nestGroup(parentId: string, childId: string): void {
    this.nested.set(parentId, [...(this.nested.get(parentId) ?? []), childId]);
    this.log.push({ seq: ++this.seq, kind: 'group', id: parentId, members: [{ id: childId, type: 'group' }] });
  }

  deleteGroup(groupId: string): void {
    this.log.push({ seq: ++this.seq, kind: 'group', id: groupId, removed: true });
  }

  /** Every delta token issued so far is now too old. */
  expireDeltas(): void {
    this.expireBefore = ++this.seq;
  }

  async start(): Promise<this> {
    const app = express();
    app.post(`/${this.tenant}/oauth2/v2.0/token`, express.urlencoded({ extended: false }), (req, res) => {
      const b = req.body as Record<string, string>;
      this.grants.push(b);
      if (b.grant_type !== 'client_credentials') return void res.status(400).json({ error: 'unsupported_grant_type' });
      if (b.client_id !== this.clientId || b.client_secret !== this.clientSecret) return void res.status(401).json({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' });
      if (b.scope !== 'https://graph.microsoft.com/.default') return void res.status(400).json({ error: 'invalid_scope' });
      const token = 'graph-at-' + randomBytes(8).toString('hex');
      this.tokens.add(token);
      res.json({ token_type: 'Bearer', expires_in: 3599, access_token: token });
    });
    app.use('/v1.0', (req, res, next) => {
      this.requests.push({ path: req.originalUrl, auth: req.headers.authorization });
      if (!this.tokens.has(String(req.headers.authorization ?? '').replace(/^Bearer /, ''))) return void res.status(401).json({ error: { code: 'InvalidAuthenticationToken' } });
      next();
    });
    const find = (key: string) => this.users.get(key) ?? [...this.users.values()].find((u) => u.userPrincipalName.toLowerCase() === key.toLowerCase());
    const view = (u: GraphUser) => ({ id: u.id, userPrincipalName: u.userPrincipalName, displayName: u.displayName ?? u.userPrincipalName, mail: u.mail ?? null, accountEnabled: u.accountEnabled !== false });
    app.get('/v1.0/users/:key/transitiveMemberOf/microsoft.graph.group', (req, res) => {
      const u = find(req.params.key);
      if (!u) return void res.status(404).json({ error: { code: 'Request_ResourceNotFound' } });
      const page = req.query.$skiptoken === '2' ? 2 : 1;
      const half = Math.ceil(u.groups.length / 2);
      const slice = page === 1 ? u.groups.slice(0, half) : u.groups.slice(half);
      const base = this.foreignNextLink ? 'https://graph.evil.example' : this.url;
      res.json({ value: slice.map((g) => ({ '@odata.type': '#microsoft.graph.group', ...g })), ...(page === 1 && u.groups.length > half ? { '@odata.nextLink': `${base}/v1.0/users/${u.id}/transitiveMemberOf/microsoft.graph.group?$skiptoken=2` } : {}) });
    });
    // ---------- delta (registered before /users/:key) ----------
    const delta = (kind: 'user' | 'group') => (req: express.Request, res: express.Response) => {
      const path = kind === 'user' ? 'users' : 'groups';
      const select = typeof req.query.$select === 'string' ? `$select=${req.query.$select}&` : '';
      const tokenParam = String(req.query.$deltatoken ?? '');
      if (tokenParam === 'latest') return void res.json({ value: [], '@odata.deltaLink': `${this.url}/v1.0/${path}/delta?${select}$deltatoken=${this.seq}` });
      const skip = typeof req.query.$skiptoken === 'string' ? req.query.$skiptoken.split(':') : null;
      const since = Number(skip ? skip[0] : tokenParam);
      if (!Number.isInteger(since) || since < this.expireBefore) return void res.status(410).json({ error: { code: 'syncStateNotFound', message: 'The delta token has expired.' } });
      const upTo = skip ? Number(skip[2]) : this.seq;
      const changes = this.log.filter((c) => c.kind === kind && c.seq > since && c.seq <= upTo);
      const offset = skip ? Number(skip[1]) : 0;
      const page = changes.slice(offset, offset + this.deltaPageSize);
      const value = page.map((c) => {
        if (c.removed) return { id: c.id, '@removed': { reason: 'deleted' } };
        if (c.kind === 'user') {
          const u = this.users.get(c.id);
          return u ? view(u) : { id: c.id, '@removed': { reason: 'deleted' } };
        }
        return { '@odata.type': '#microsoft.graph.group', id: c.id, ...(c.renamed ? { displayName: [...this.users.values()].flatMap((u) => u.groups).find((g) => g.id === c.id)?.displayName ?? '' } : {}), ...(c.members ? { 'members@delta': c.members.map((m) => ({ '@odata.type': m.type === 'group' ? '#microsoft.graph.group' : '#microsoft.graph.user', id: m.id, ...(m.removed ? { '@removed': { reason: 'deleted' } } : {}) })) } : {}) };
      });
      const more = offset + this.deltaPageSize < changes.length;
      res.json({ value, ...(more ? { '@odata.nextLink': `${this.url}/v1.0/${path}/delta?$skiptoken=${since}:${offset + this.deltaPageSize}:${upTo}` } : { '@odata.deltaLink': `${this.url}/v1.0/${path}/delta?${select}$deltatoken=${upTo}` }) });
    };
    app.get('/v1.0/users/delta', delta('user'));
    app.get('/v1.0/groups/delta', delta('group'));
    app.get('/v1.0/groups/:id/transitiveMembers/microsoft.graph.user', (req, res) => {
      const under = (gid: string, seen = new Set<string>()): string[] => (seen.has(gid) ? [] : (seen.add(gid), [gid, ...(this.nested.get(gid) ?? []).flatMap((c) => under(c, seen))]));
      const ids = new Set(under(req.params.id));
      res.json({ value: [...this.users.values()].filter((u) => u.groups.some((g) => ids.has(g.id))).map((u) => ({ '@odata.type': '#microsoft.graph.user', id: u.id })) });
    });
    app.get('/v1.0/users/:key', (req, res) => {
      const u = find(req.params.key);
      if (!u) return void res.status(404).json({ error: { code: 'Request_ResourceNotFound' } });
      res.json(view(u));
    });
    app.get('/v1.0/users', (req, res) => {
      const top = Math.min(Number(req.query.$top ?? 100), this.userPageSize);
      const offset = Number(req.query.$skiptoken ?? 0);
      const all = [...this.users.values()];
      const more = offset + top < all.length;
      res.json({ value: all.slice(offset, offset + top).map(view), ...(more ? { '@odata.nextLink': `${this.url}/v1.0/users?$select=id,userPrincipalName,displayName,mail,accountEnabled&$top=${top}&$skiptoken=${offset + top}` } : {}) });
    });
    app.get('/v1.0/groups', (req, res) => {
      const all = new Map<string, { id: string; displayName: string }>();
      for (const u of this.users.values()) for (const g of u.groups) all.set(g.id, { id: g.id, displayName: g.displayName });
      res.json({ value: [...all.values()].slice(0, Number(req.query.$top ?? 100)) });
    });
    await new Promise<void>((r) => (this.server = app.listen(0, '127.0.0.1', () => r())));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this;
  }

  get tokenUrl(): string {
    return `${this.url}/${this.tenant}/oauth2/v2.0/token`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}

export interface GoogleUser {
  id: string;
  primaryEmail: string;
  fullName?: string;
  suspended?: boolean;
  groups: { id: string; email: string; name: string }[];
}

export class FakeGoogle {
  url = '';
  readonly clientEmail = 'exprsn-sync@exprsn-test.iam.gserviceaccount.com';
  readonly admin = 'admin@example.com';
  readonly users = new Map<string, GoogleUser>();
  readonly assertions: Record<string, unknown>[] = [];
  /** Users a page of /users holds at most. */
  userPageSize = 500;
  readonly key: string;
  private readonly publicKey: string;
  private tokens = new Set<string>();
  private server: Server | null = null;

  constructor() {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.key = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    this.publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  /** The service account key file as Google hands it out. */
  serviceAccountJson(): string {
    return JSON.stringify({ type: 'service_account', project_id: 'exprsn-test', private_key_id: 'k1', private_key: this.key, client_email: this.clientEmail, token_uri: `${this.url}/token` });
  }

  async start(): Promise<this> {
    const app = express();
    app.post('/token', express.urlencoded({ extended: false }), (req, res) => {
      const b = req.body as Record<string, string>;
      if (b.grant_type !== 'urn:ietf:params:oauth:grant-type:jwt-bearer' || typeof b.assertion !== 'string') return void res.status(400).json({ error: 'unsupported_grant_type' });
      const [h, p, sig] = b.assertion.split('.');
      const ok = !!sig && verify('sha256', Buffer.from(`${h}.${p}`), createPublicKey(this.publicKey), Buffer.from(sig, 'base64url'));
      const claims = JSON.parse(Buffer.from(p ?? '', 'base64url').toString()) as Record<string, unknown>;
      this.assertions.push(claims);
      const now = Date.now() / 1000;
      if (!ok || claims.iss !== this.clientEmail || claims.aud !== `${this.url}/token` || claims.sub !== this.admin || typeof claims.exp !== 'number' || claims.exp < now || !String(claims.scope).includes('admin.directory.group.readonly')) return void res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
      const token = 'ya29.' + randomBytes(8).toString('hex');
      this.tokens.add(token);
      res.json({ access_token: token, token_type: 'Bearer', expires_in: 3599 });
    });
    const base = '/admin/directory/v1';
    app.use(base, (req, res, next) => {
      if (!this.tokens.has(String(req.headers.authorization ?? '').replace(/^Bearer /, ''))) return void res.status(401).json({ error: { code: 401 } });
      next();
    });
    const find = (key: string) => this.users.get(key) ?? [...this.users.values()].find((u) => u.primaryEmail === key.toLowerCase());
    const view = (u: GoogleUser) => ({ kind: 'admin#directory#user', id: u.id, primaryEmail: u.primaryEmail, name: { fullName: u.fullName ?? u.primaryEmail }, suspended: !!u.suspended, archived: false });
    app.get(`${base}/users/:key`, (req, res) => {
      const u = find(req.params.key);
      if (!u) return void res.status(404).json({ error: { code: 404, message: 'Resource Not Found: userKey' } });
      res.json(view(u));
    });
    app.get(`${base}/users`, (req, res) => {
      if (req.query.customer !== 'my_customer') return void res.status(400).json({});
      const size = Math.min(Number(req.query.maxResults ?? 100), this.userPageSize);
      const offset = Number(req.query.pageToken ?? 0);
      const all = [...this.users.values()];
      res.json({ users: all.slice(offset, offset + size).map(view), ...(offset + size < all.length ? { nextPageToken: String(offset + size) } : {}) });
    });
    app.get(`${base}/groups`, (req, res) => {
      if (typeof req.query.userKey === 'string') {
        const u = find(req.query.userKey);
        if (!u) return void res.status(404).json({});
        // one group per page, to exercise nextPageToken
        const i = Number(req.query.pageToken ?? 0);
        const g = u.groups[i];
        return void res.json({ groups: g ? [g] : [], ...(i + 1 < u.groups.length ? { nextPageToken: String(i + 1) } : {}) });
      }
      const all = new Map<string, { id: string; email: string; name: string }>();
      for (const u of this.users.values()) for (const g of u.groups) all.set(g.id, g);
      res.json({ groups: [...all.values()] });
    });
    await new Promise<void>((r) => (this.server = app.listen(0, '127.0.0.1', () => r())));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
