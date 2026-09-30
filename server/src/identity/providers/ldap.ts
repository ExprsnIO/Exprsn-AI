import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import type { ConnectionOptions } from 'node:tls';
import { Client, InvalidCredentialsError, type Entry } from 'ldapts';
import { checkHost, parseAllowList, type AllowList } from '../../mcp/hosts.js';
import { resolveSecret } from '../secrets.js';
import { timed, type AuthResult, type ExternalUser, type IdentityProvider, type LdapConfig, type Step } from './types.js';

/** RFC 4515 escaping for values placed inside a search filter. */
export function escapeFilterValue(value: string): string {
  return value.replace(/[\\*()\0]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

export function renderFilter(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => escapeFilterValue(vars[k] ?? ''));
}

const first = (v: Entry[string] | undefined): string | null => {
  if (v == null) return null;
  const x = Array.isArray(v) ? v[0] : v;
  return x == null ? null : Buffer.isBuffer(x) ? x.toString('utf8') : String(x);
};
const all = (v: Entry[string] | undefined): string[] => {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => (Buffer.isBuffer(x) ? x.toString('utf8') : String(x)));
};

/**
 * OpenLDAP (or any LDAPv3 directory): service bind → search for the user → bind as the user with their password
 * → read groups. Only LDAPS or StartTLS unless explicitly allowed for development; a clear bind is never used in production.
 */
export class LdapProvider implements IdentityProvider {
  readonly kind = 'ldap' as const;

  constructor(
    readonly id: string,
    readonly name: string,
    private readonly cfg: LdapConfig,
    private readonly production: boolean,
    /** The directory must be an internal host unless IDENTITY_ALLOWED_HOSTS names it. */
    private readonly allow: AllowList = parseAllowList('')
  ) {
    if (cfg.url.startsWith('ldap://') && !cfg.startTLS && (!cfg.allowInsecure || production)) {
      throw new Error(`${name}: ldap:// without StartTLS is refused; use ldaps:// or startTLS`);
    }
  }

  private tlsOptions(): ConnectionOptions {
    const host = new URL(this.cfg.url).hostname;
    return {
      ...(isIP(host) ? {} : { servername: host }),
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
      ...(this.cfg.caFile ? { ca: readFileSync(this.cfg.caFile) } : {})
    };
  }

  private async connect(steps?: Step[]): Promise<Client> {
    const { addresses } = await timed(steps, 'Check the directory host', () => checkHost(new URL(this.cfg.url).hostname, this.allow));
    // Dial the address that was checked (TLS still verifies the configured name), so DNS cannot rebind in between.
    const dial = new URL(this.cfg.url);
    dial.hostname = isIP(addresses[0]!) === 6 ? `[${addresses[0]}]` : addresses[0]!;
    const client = new Client({
      url: dial.toString(),
      timeout: this.cfg.timeoutMs,
      connectTimeout: this.cfg.timeoutMs,
      ...(this.cfg.url.startsWith('ldaps://') ? { tlsOptions: this.tlsOptions() } : {})
    });
    if (this.cfg.startTLS) {
      await timed(steps, 'StartTLS', () => client.startTLS(this.tlsOptions()));
    }
    return client;
  }

  private async serviceBind(client: Client, steps?: Step[]): Promise<void> {
    await timed(steps, `Service bind as ${this.cfg.bindDN}`, () => client.bind(this.cfg.bindDN, resolveSecret(this.cfg.bindPassword)));
  }

  private async findUser(client: Client, username: string, steps?: Step[]): Promise<Entry | null | 'ambiguous'> {
    const filter = renderFilter(this.cfg.userFilter, { username });
    const { searchEntries } = await timed(
      steps,
      'Search for the user',
      () =>
        client.search(this.cfg.userBase, {
          scope: 'sub',
          filter,
          sizeLimit: 2,
          attributes: ['dn', this.cfg.usernameAttribute, this.cfg.displayNameAttribute, this.cfg.emailAttribute, 'memberOf']
        }),
      (r) => `${r.searchEntries.length} match${r.searchEntries.length === 1 ? '' : 'es'} under ${this.cfg.userBase}`
    );
    if (searchEntries.length === 0) return null;
    if (searchEntries.length > 1) return 'ambiguous';
    return searchEntries[0] ?? null;
  }

  private async groupsFor(client: Client, entry: Entry, username: string, steps?: Step[]): Promise<string[]> {
    if (this.cfg.groupMode === 'memberOf') {
      const dns = all(entry.memberOf);
      steps?.push({ title: 'Read memberOf', ok: true, detail: `${dns.length} groups` });
      return this.cfg.groupNameAttribute === 'dn' ? dns : dns.map((dn) => /^cn=([^,]+)/i.exec(dn)?.[1] ?? dn);
    }
    const filter = renderFilter(this.cfg.groupFilter, { dn: entry.dn, username });
    const { searchEntries } = await timed(
      steps,
      'Search for groups',
      () => client.search(this.cfg.groupBase as string, { scope: 'sub', filter, attributes: ['dn', 'cn'], sizeLimit: 1000 }),
      (r) => `${r.searchEntries.length} groups`
    );
    return searchEntries.map((g) => (this.cfg.groupNameAttribute === 'dn' ? g.dn : (first(g.cn) ?? g.dn)));
  }

  private toUser(entry: Entry, username: string, groups: string[]): ExternalUser {
    return {
      externalId: entry.dn,
      username: first(entry[this.cfg.usernameAttribute]) ?? username,
      displayName: first(entry[this.cfg.displayNameAttribute]) ?? username,
      email: first(entry[this.cfg.emailAttribute]),
      groups
    };
  }

  async authenticate(username: string, password: string, steps?: Step[]): Promise<AuthResult> {
    // An empty password is an unauthenticated bind, which many servers accept: never let it through.
    if (!password) return { status: 'invalid' };
    let client: Client | null = null;
    try {
      client = await this.connect(steps);
      await this.serviceBind(client, steps);
      const entry = await this.findUser(client, username, steps);
      if (entry === 'ambiguous') return { status: 'error', message: 'userFilter matched more than one entry' };
      if (!entry) return { status: 'not_found' };
      try {
        await timed(steps, `Bind as ${entry.dn}`, () => (client as Client).bind(entry.dn, password));
      } catch (err) {
        if (err instanceof InvalidCredentialsError) return { status: 'invalid' };
        throw err;
      }
      // Re-bind as the service account to read groups: the user may not be allowed to search.
      await this.serviceBind(client, steps);
      const groups = await this.groupsFor(client, entry, username, steps);
      return { status: 'ok', user: this.toUser(entry, username, groups) };
    } catch (err) {
      return { status: 'error', message: (err as Error).message };
    } finally {
      await client?.unbind().catch(() => undefined);
    }
  }

  async lookup(username: string, steps?: Step[]): Promise<ExternalUser | null> {
    const client = await this.connect(steps);
    try {
      await this.serviceBind(client, steps);
      const entry = await this.findUser(client, username, steps);
      if (!entry || entry === 'ambiguous') return null;
      return this.toUser(entry, username, await this.groupsFor(client, entry, username, steps));
    } finally {
      await client.unbind().catch(() => undefined);
    }
  }

  async test(steps: Step[]): Promise<boolean> {
    let client: Client | null = null;
    try {
      client = await this.connect(steps);
      await this.serviceBind(client, steps);
      await timed(steps, `Read ${this.cfg.userBase}`, () => (client as Client).search(this.cfg.userBase, { scope: 'base', attributes: ['dn'] }));
      return true;
    } catch {
      return false;
    } finally {
      await client?.unbind().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    // Connections are per request; nothing pooled to close.
  }
}
