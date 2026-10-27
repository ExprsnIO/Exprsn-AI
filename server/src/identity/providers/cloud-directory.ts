import { createPrivateKey, sign } from 'node:crypto';
import type { ProviderRow } from '../../repos/providers.js';
import { guardedRequest, serviceAddressProblem, servicePolicy, ServiceUrlRefused } from '../../platform/egress.js';
import { resolveSecretRef, type VaultRefResolver } from '../secrets.js';
import { FederatedProvider, type FederatedTester } from './federated.js';
import type { AuthResult, CloudDirectoryConfig, ExternalUser, IdentityProvider, OidcUpstreamConfig, Step } from './types.js';

/*
 * 1.9.0, Sprint 54 (B-183): the user and group pull of a cloud directory behind an upstream OIDC store, so Microsoft
 * Entra ID and Google Workspace accounts join directory sync with its safety stop, and the groups mappings name are
 * the directory's at sign-in and at every sync (never the ID token's group ids at one and names at the other).
 *
 * - Microsoft Graph: the client credentials grant (the app registration's own permission, `User.Read.All` and
 *   `GroupMember.Read.All`), users by id or userPrincipalName, groups by `transitiveMemberOf` (nested included).
 * - Google Directory API: a service account's signed assertion (RFC 7523 JWT bearer, domain-wide delegation to the
 *   admin in `subject`), users by id or primary email, their groups.
 *
 * Every request goes through the egress guard (`guardedRequest`: resolved once, every address checked against the
 * operator's service policy, the connection pinned to the checked address, no redirects, answers capped), and a
 * paging link is followed only on the API's own origin. Credentials are `vault:` references read as the admin who
 * saved the store; the access token lives in memory until it expires and is never stored.
 *
 * 1.9.9-qa (QA-1, the Sprint 54 leftovers):
 *
 * - `listUsers` pages through every user of the directory, for the full import before first sign-in
 *   (`identity/directory-import.ts`);
 * - Microsoft Graph delta queries (`/users/delta`, `/groups/delta`): `deltaLatest` takes links that start from now
 *   (`$deltatoken=latest`, nothing read), `deltaChanges` follows a saved pair and says which accounts changed, so
 *   directory sync looks up only those: the accounts in the users delta, the members added or removed in the groups
 *   delta, and every account under a group that itself changed (renamed: what mappings name changed) or that was
 *   added to or removed from a group (its transitive members). A 410 (the link expired), a deleted group (its members
 *   are gone with it) or too many changes mean a full pull. The Google Directory API has no incremental
 *   listing of users or memberships (its `users.watch` is push notifications to a public address, which this server
 *   does not take), so a Google directory is always pulled in full.
 */

export interface DirectoryResponse {
  status: number;
  body: unknown;
}

/** How the pull reaches the directory: the egress guard in the server, a stand-in in tests. */
export interface DirectoryNet {
  request(url: string, init: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string }): Promise<DirectoryResponse>;
}

/** The egress guard for directory calls: the operator's service policy (SERVICE_ALLOWED_HOSTS, SERVICE_INTERNAL_ONLY). */
export function directoryNet(cfg: { SERVICE_ALLOWED_HOSTS?: string; SERVICE_INTERNAL_ONLY?: boolean; FEDERATION_TIMEOUT_MS?: number }): DirectoryNet {
  const policy = servicePolicy(cfg);
  return {
    async request(url, init) {
      const res = await guardedRequest({
        method: init.method ?? 'GET',
        url: new URL(url),
        headers: { accept: 'application/json', 'user-agent': 'Exprsn-AI', ...init.headers },
        ...(init.body != null ? { body: init.body } : {}),
        timeoutMs: cfg.FEDERATION_TIMEOUT_MS ?? 10_000,
        maxBytes: 4 * 1024 * 1024,
        check: (address, host) => serviceAddressProblem(address, host, policy)
      });
      const text = res.body.toString('utf8');
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      return { status: res.status, body };
    }
  };
}

export class DirectoryError extends Error {}

/** Each API's endpoints, scope and group naming when the store leaves them out. */
export function directoryDefaults(d: CloudDirectoryConfig): Required<Pick<CloudDirectoryConfig, 'tokenUrl' | 'apiUrl' | 'scope' | 'groupName'>> & { customer: string } {
  if (d.api === 'msgraph') {
    return { tokenUrl: d.tokenUrl ?? '', apiUrl: (d.apiUrl ?? 'https://graph.microsoft.com/v1.0').replace(/\/+$/, ''), scope: d.scope ?? 'https://graph.microsoft.com/.default', groupName: d.groupName ?? 'displayName', customer: '' };
  }
  return {
    tokenUrl: d.tokenUrl ?? 'https://oauth2.googleapis.com/token',
    apiUrl: (d.apiUrl ?? 'https://admin.googleapis.com/admin/directory/v1').replace(/\/+$/, ''),
    scope: d.scope ?? 'https://www.googleapis.com/auth/admin.directory.user.readonly https://www.googleapis.com/auth/admin.directory.group.readonly',
    groupName: d.groupName ?? 'email',
    customer: d.customer ?? 'my_customer'
  };
}

export interface DirectoryUser {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  enabled: boolean;
}

const MAX_PAGES = 20;
/** Pages of users the full import reads at most (999 a page on Graph, 500 on Google). */
const MAX_USER_PAGES = 200;
/** Pages of one delta round followed at most; more changes than that and a full pull is cheaper. */
const MAX_DELTA_PAGES = 100;
/** Changed groups whose members are read in one delta run at most; more and a full pull is cheaper. */
const MAX_DELTA_GROUPS = 25;
const MAX_GROUPS = 2000;
const ID = /^[A-Za-z0-9._@:-]{1,200}$/;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const USER_DELTA_SELECT = 'id,userPrincipalName,displayName,mail,accountEnabled';
const GROUP_DELTA_SELECT = 'id,displayName,members';

/** A JWT signed RS256 with a service account's key (Google's token endpoint checks it). */
export function signedAssertion(key: { client_email: string; private_key: string }, claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ iss: key.client_email, ...claims })}`;
  return `${input}.${sign('sha256', Buffer.from(input), createPrivateKey(key.private_key)).toString('base64url')}`;
}

export class CloudDirectoryClient {
  private token: { value: string; until: number } | null = null;
  private readonly d: ReturnType<typeof directoryDefaults>;

  constructor(
    private readonly cfg: CloudDirectoryConfig,
    private readonly net: DirectoryNet,
    private readonly vault: VaultRefResolver | null
  ) {
    this.d = directoryDefaults(cfg);
  }

  get api(): 'msgraph' | 'google' {
    return this.cfg.api;
  }

  /** The two addresses the pull calls (checked when the store is saved). */
  urls(): string[] {
    return [this.d.tokenUrl, this.d.apiUrl];
  }

  private async post(url: string, form: Record<string, string>): Promise<DirectoryResponse> {
    return this.net.request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  }

  /** An access token: the client credentials grant (Graph) or a signed assertion (Google); cached until it expires. */
  async accessToken(steps?: Step[]): Promise<string> {
    if (this.token && this.token.until > Date.now()) return this.token.value;
    const t0 = performance.now();
    try {
      let res: DirectoryResponse;
      if (this.cfg.api === 'msgraph') {
        const secret = await resolveSecretRef(this.cfg.clientSecret!, this.vault);
        res = await this.post(this.d.tokenUrl, { grant_type: 'client_credentials', client_id: this.cfg.clientId!, client_secret: secret, scope: this.d.scope });
      } else {
        let key: { client_email?: unknown; private_key?: unknown };
        try {
          key = JSON.parse(await resolveSecretRef(this.cfg.serviceAccount!, this.vault)) as typeof key;
        } catch (err) {
          if (err instanceof SyntaxError) throw new DirectoryError('The service account key is not JSON.');
          throw err;
        }
        if (typeof key.client_email !== 'string' || typeof key.private_key !== 'string') throw new DirectoryError('The service account key has no client_email or private_key.');
        const now = Math.floor(Date.now() / 1000);
        const assertion = signedAssertion({ client_email: key.client_email, private_key: key.private_key }, { sub: this.cfg.subject, scope: this.d.scope, aud: this.d.tokenUrl, iat: now, exp: now + 3600 });
        res = await this.post(this.d.tokenUrl, { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
      }
      const b = (res.body ?? {}) as { access_token?: unknown; token_type?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown };
      if (res.status !== 200 || typeof b.access_token !== 'string' || !b.access_token) {
        throw new DirectoryError(`The directory token request failed: ${typeof b.error === 'string' ? b.error.slice(0, 100) : `HTTP ${res.status}`}${typeof b.error_description === 'string' ? ` (${b.error_description.slice(0, 200)})` : ''}.`);
      }
      if (typeof b.token_type === 'string' && b.token_type.toLowerCase() !== 'bearer') throw new DirectoryError('The directory returned a token that is not a bearer token.');
      const ttl = typeof b.expires_in === 'number' && b.expires_in > 0 ? Math.min(b.expires_in, 3600) : 300;
      this.token = { value: b.access_token, until: Date.now() + Math.max(ttl - 60, 30) * 1000 };
      steps?.push({ title: this.cfg.api === 'msgraph' ? 'Client credentials grant' : 'Service account assertion grant', ok: true, ms: Math.round(performance.now() - t0) });
      return b.access_token;
    } catch (err) {
      steps?.push({ title: this.cfg.api === 'msgraph' ? 'Client credentials grant' : 'Service account assertion grant', ok: false, ms: Math.round(performance.now() - t0), detail: (err as Error).message });
      throw err;
    }
  }

  private async get(pathOrUrl: string, steps?: Step[]): Promise<DirectoryResponse> {
    const url = pathOrUrl.startsWith('https://') || pathOrUrl.startsWith('http://') ? pathOrUrl : `${this.d.apiUrl}${pathOrUrl}`;
    // A paging link is followed on the API's own origin only.
    if (new URL(url).origin !== new URL(this.d.apiUrl).origin) throw new DirectoryError('The directory sent a paging link to another host.');
    const token = await this.accessToken(steps);
    const res = await this.net.request(url, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 401) this.token = null;
    return res;
  }

  private ok(res: DirectoryResponse, what: string): Record<string, unknown> {
    if (res.status !== 200 || !res.body || typeof res.body !== 'object') throw new DirectoryError(`The directory answered HTTP ${res.status} for ${what}.`);
    return res.body as Record<string, unknown>;
  }

  private toUser(b: Record<string, unknown>): DirectoryUser | null {
    const id = str(b.id);
    if (!id || !ID.test(id)) return null;
    if (this.cfg.api === 'msgraph') {
      const upn = str(b.userPrincipalName)?.toLowerCase();
      if (!upn) return null;
      return { id, username: upn, displayName: str(b.displayName) ?? upn, email: str(b.mail)?.toLowerCase() ?? null, enabled: b.accountEnabled !== false };
    }
    const email = str(b.primaryEmail)?.toLowerCase();
    if (!email) return null;
    const name = (b.name ?? {}) as { fullName?: unknown };
    return { id, username: email, displayName: str(name.fullName) ?? email, email, enabled: b.suspended !== true && b.archived !== true };
  }

  /** One user by the directory's id or sign-in name; null when the directory does not have them. */
  async user(key: string, steps?: Step[]): Promise<DirectoryUser | null> {
    if (!key || key.length > 320 || /[/?#\s]/.test(key)) return null;
    const path = this.cfg.api === 'msgraph' ? `/users/${encodeURIComponent(key)}?$select=id,userPrincipalName,displayName,mail,accountEnabled` : `/users/${encodeURIComponent(key)}?projection=basic`;
    const res = await this.get(path, steps);
    if (res.status === 404) return null;
    return this.toUser(this.ok(res, 'the user'));
  }

  /** The user's groups as mappings name them (Graph: nested included). */
  async groupsOf(userId: string, steps?: Step[]): Promise<string[]> {
    const out: string[] = [];
    if (this.cfg.api === 'msgraph') {
      let next: string | null = `/users/${encodeURIComponent(userId)}/transitiveMemberOf/microsoft.graph.group?$select=id,displayName,securityEnabled&$top=999`;
      for (let page = 0; next && page < MAX_PAGES && out.length < MAX_GROUPS; page++) {
        const b = this.ok(await this.get(next, steps), 'the groups');
        for (const g of Array.isArray(b.value) ? (b.value as Record<string, unknown>[]) : []) {
          if (this.cfg.securityGroupsOnly && g.securityEnabled !== true) continue;
          const name = this.d.groupName === 'id' ? str(g.id) : str(g.displayName);
          if (name) out.push(name);
        }
        next = str(b['@odata.nextLink']);
      }
    } else {
      let pageToken: string | null = null;
      for (let page = 0; page < MAX_PAGES && out.length < MAX_GROUPS; page++) {
        const b = this.ok(await this.get(`/groups?userKey=${encodeURIComponent(userId)}&maxResults=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, steps), 'the groups');
        for (const g of Array.isArray(b.groups) ? (b.groups as Record<string, unknown>[]) : []) {
          const name = this.d.groupName === 'name' ? str(g.name) : str(g.email)?.toLowerCase();
          if (name) out.push(name);
        }
        pageToken = str(b.nextPageToken);
        if (!pageToken) break;
      }
    }
    return [...new Set(out)].slice(0, MAX_GROUPS);
  }

  /** Every user of the directory, page by page (the full import), capped at `max`. */
  async *listUsers(max = 100_000, steps?: Step[]): AsyncGenerator<DirectoryUser[]> {
    let seen = 0;
    if (this.cfg.api === 'msgraph') {
      let next: string | null = '/users?$select=id,userPrincipalName,displayName,mail,accountEnabled&$top=999';
      for (let page = 0; next && page < MAX_USER_PAGES && seen < max; page++) {
        const b = this.ok(await this.get(next, steps), 'the users');
        const users = (Array.isArray(b.value) ? (b.value as Record<string, unknown>[]) : []).map((x) => this.toUser(x)).filter((x): x is DirectoryUser => !!x).slice(0, max - seen);
        seen += users.length;
        yield users;
        next = str(b['@odata.nextLink']);
      }
      return;
    }
    const c = encodeURIComponent(this.d.customer);
    let pageToken: string | null = null;
    for (let page = 0; page < MAX_USER_PAGES && seen < max; page++) {
      const b = this.ok(await this.get(`/users?customer=${c}&maxResults=500&projection=basic${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, steps), 'the users');
      const users = (Array.isArray(b.users) ? (b.users as Record<string, unknown>[]) : []).map((x) => this.toUser(x)).filter((x): x is DirectoryUser => !!x).slice(0, max - seen);
      seen += users.length;
      yield users;
      pageToken = str(b.nextPageToken);
      if (!pageToken) return;
    }
  }

  /** Graph only: delta links that start from now, without reading the directory (`$deltatoken=latest`). */
  async deltaLatest(steps?: Step[]): Promise<{ users: string; groups: string }> {
    if (this.cfg.api !== 'msgraph') throw new DirectoryError('Only Microsoft Graph has delta queries.');
    const link = async (path: string, what: string) => {
      const b = this.ok(await this.get(path, steps), what);
      const l = str(b['@odata.deltaLink']);
      if (!l) throw new DirectoryError(`The directory gave no delta link for ${what}.`);
      return l;
    };
    return {
      users: await link(`/users/delta?$select=${USER_DELTA_SELECT}&$deltatoken=latest`, 'the users'),
      groups: await link(`/groups/delta?$select=${GROUP_DELTA_SELECT}&$deltatoken=latest`, 'the groups')
    };
  }

  /**
   * Graph only: what changed since a pair of delta links. `changes` are the ids of accounts whose own properties or
   * group memberships changed (directly; a removed account is among them); `expired` when the directory answered
   * 410; `full` (with why) when a change cannot be placed on accounts.
   */
  async deltaChanges(links: { users: string; groups: string }, steps?: Step[]): Promise<{ kind: 'changes'; ids: Set<string>; links: { users: string; groups: string } } | { kind: 'expired' } | { kind: 'full'; why: string }> {
    if (this.cfg.api !== 'msgraph') throw new DirectoryError('Only Microsoft Graph has delta queries.');
    const ids = new Set<string>();
    const round = async (start: string, what: string, each: (e: Record<string, unknown>) => string | null): Promise<string | { kind: 'expired' } | { kind: 'full'; why: string }> => {
      let next: string | null = start;
      for (let page = 0; next && page < MAX_DELTA_PAGES; page++) {
        const res = await this.get(next, steps);
        // 410 Gone (resyncRequired, syncStateNotFound): the saved link is too old to follow.
        if (res.status === 410) return { kind: 'expired' };
        const b = this.ok(res, `the ${what} delta`);
        for (const e of Array.isArray(b.value) ? (b.value as Record<string, unknown>[]) : []) {
          const why = each(e);
          if (why) return { kind: 'full', why };
        }
        const done = str(b['@odata.deltaLink']);
        if (done) return done;
        next = str(b['@odata.nextLink']);
      }
      return { kind: 'full', why: `more than ${MAX_DELTA_PAGES} pages of ${what} changes` };
    };
    const users = await round(links.users, 'users', (e) => {
      const id = str(e.id);
      if (id && ID.test(id)) ids.add(id);
      return null;
    });
    if (typeof users !== 'string') return users;
    // Groups whose transitive members are all affected: renamed ones, and groups added to or removed from a group.
    const expand = new Set<string>();
    const groups = await round(links.groups, 'groups', (e) => {
      const gid = str(e.id);
      if (!gid || !ID.test(gid)) return null;
      if (e['@removed']) return 'a group was deleted';
      // Anything beyond the id and the member changes may be a rename, which changes what mappings name.
      if (Object.keys(e).some((k) => k !== 'id' && k !== 'members@delta' && !k.startsWith('@odata.') && !k.startsWith('@'))) expand.add(gid);
      for (const m of Array.isArray(e['members@delta']) ? (e['members@delta'] as Record<string, unknown>[]) : []) {
        const id = str(m.id);
        if (!id || !ID.test(id)) continue;
        if ((str(m['@odata.type']) ?? '#microsoft.graph.user') === '#microsoft.graph.group') expand.add(id);
        else ids.add(id);
      }
      return expand.size > MAX_DELTA_GROUPS ? `more than ${MAX_DELTA_GROUPS} groups changed` : null;
    });
    if (typeof groups !== 'string') return groups;
    for (const gid of expand) {
      let next: string | null = `/groups/${encodeURIComponent(gid)}/transitiveMembers/microsoft.graph.user?$select=id&$top=999`;
      for (let page = 0; next && page < MAX_PAGES; page++) {
        const res = await this.get(next, steps);
        // Gone since the delta was read: its members are no longer known, so pull everyone.
        if (res.status === 404) return { kind: 'full', why: 'a changed group is no longer there' };
        const b = this.ok(res, 'a changed group\'s members');
        for (const m of Array.isArray(b.value) ? (b.value as Record<string, unknown>[]) : []) {
          const id = str(m.id);
          if (id && ID.test(id)) ids.add(id);
        }
        next = str(b['@odata.nextLink']);
      }
    }
    steps?.push({ title: 'Read the changes since the last sync (Graph delta)', ok: true, detail: `${ids.size} account${ids.size === 1 ? '' : 's'} changed${expand.size ? `, ${expand.size} group${expand.size === 1 ? '' : 's'} read for members` : ''}` });
    return { kind: 'changes', ids, links: { users, groups } };
  }

  /** A first page of users and groups, for the store's test and the pull preview. */
  async sample(limit = 10, steps?: Step[]): Promise<{ users: DirectoryUser[]; groups: string[] }> {
    const n = Math.max(1, Math.min(limit, 50));
    if (this.cfg.api === 'msgraph') {
      const u = this.ok(await this.get(`/users?$select=id,userPrincipalName,displayName,mail,accountEnabled&$top=${n}`, steps), 'the users');
      const g = this.ok(await this.get(`/groups?$select=id,displayName&$top=${n}`, steps), 'the groups');
      return {
        users: (Array.isArray(u.value) ? (u.value as Record<string, unknown>[]) : []).map((x) => this.toUser(x)).filter((x): x is DirectoryUser => !!x),
        groups: (Array.isArray(g.value) ? (g.value as Record<string, unknown>[]) : []).map((x) => (this.d.groupName === 'id' ? str(x.id) : str(x.displayName))).filter((x): x is string => !!x)
      };
    }
    const c = encodeURIComponent(this.d.customer);
    const u = this.ok(await this.get(`/users?customer=${c}&maxResults=${n}&projection=basic`, steps), 'the users');
    const g = this.ok(await this.get(`/groups?customer=${c}&maxResults=${n}`, steps), 'the groups');
    return {
      users: (Array.isArray(u.users) ? (u.users as Record<string, unknown>[]) : []).map((x) => this.toUser(x)).filter((x): x is DirectoryUser => !!x),
      groups: (Array.isArray(g.groups) ? (g.groups as Record<string, unknown>[]) : []).map((x) => (this.d.groupName === 'name' ? str(x.name) : str(x.email)?.toLowerCase())).filter((x): x is string => !!x)
    };
  }
}

/**
 * An upstream OIDC store with a directory: sign-in stays a redirect (no passwords here), but the store can be looked
 * up, so directory sync refreshes and disables its users like an LDAP store's.
 */
export class CloudDirectoryProvider implements IdentityProvider {
  readonly kind = 'oidc' as const;
  readonly id: string;
  readonly name: string;
  readonly client: CloudDirectoryClient;
  private readonly upstream: FederatedProvider;

  constructor(row: ProviderRow, tester: FederatedTester | null, net: DirectoryNet, vault: VaultRefResolver | null) {
    this.id = row.id;
    this.name = row.name;
    this.upstream = new FederatedProvider(row, tester);
    this.client = new CloudDirectoryClient((row.config as unknown as OidcUpstreamConfig).directory!, net, vault);
  }

  authenticate(username: string, password: string, steps?: Step[]): Promise<AuthResult> {
    return this.upstream.authenticate(username, password, steps);
  }

  private async full(u: DirectoryUser | null, steps?: Step[]): Promise<ExternalUser | null> {
    if (!u) return null;
    if (!u.enabled) {
      steps?.push({ title: 'Account state', ok: false, detail: 'The directory account is disabled or suspended.' });
      return null;
    }
    const groups = await this.client.groupsOf(u.id, steps);
    steps?.push({ title: 'Read groups from the directory', ok: true, detail: `${groups.length} groups` });
    return { externalId: u.id, username: u.username, displayName: u.displayName, email: u.email, groups };
  }

  async lookup(username: string, steps?: Step[]): Promise<ExternalUser | null> {
    return this.full(await this.client.user(username.trim().toLowerCase(), steps), steps);
  }

  async lookupById(externalId: string, steps?: Step[]): Promise<ExternalUser | null> {
    return this.full(await this.client.user(externalId, steps), steps);
  }

  async test(steps: Step[]): Promise<boolean> {
    const upstream = await this.upstream.test(steps);
    let directory = false;
    try {
      const s = await this.client.sample(5, steps);
      steps.push({ title: `Read the directory (${this.client.api === 'msgraph' ? 'Microsoft Graph' : 'Google Directory API'})`, ok: true, detail: `${s.users.length} users and ${s.groups.length} groups on the first page` });
      directory = true;
    } catch (err) {
      steps.push({ title: 'Read the directory', ok: false, detail: err instanceof ServiceUrlRefused || err instanceof DirectoryError ? err.message : (err as Error).message });
    }
    return upstream && directory;
  }

  async close(): Promise<void> {}
}
