import { readFileSync } from 'node:fs';
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import type { ConnectionOptions } from 'node:tls';
import { AndFilter, Client, EqualityFilter, ExtensibleFilter, FilterParser, InvalidCredentialsError, type Entry, type Filter } from 'ldapts';
import { checkHost, parseAllowList, type AllowList } from '../../mcp/hosts.js';
import { resolveSecretRef, type VaultRefResolver } from '../secrets.js';
import { escapeFilterValue } from './ldap.js';
import { timed, type AdConfig, type AuthResult, type ExternalUser, type IdentityProvider, type Step, type StoreRefusal } from './types.js';

/*
 * 1.9.0, Sprint 54 (B-182): Active Directory as a user store, an LDAP store with AD's own rules (designed from
 * exprsn-platform's `services/auth/src/services/ldapService.js`, which was never mounted, and Microsoft's documented
 * attributes, not ported):
 *
 * - sign-in by sAMAccountName (also `DOMAIN\name`) or userPrincipalName;
 * - the external id is objectGUID as GUID text, so a renamed or moved account stays linked, and directory sync looks
 *   the account up by it (`lookupById`);
 * - groups through LDAP_MATCHING_RULE_IN_CHAIN (1.2.840.113556.1.4.1941), so nested groups count, read with the
 *   paged results control and capped at `maxGroups`;
 * - disabled, locked and expired accounts from userAccountControl, msDS-User-Account-Control-Computed, lockoutTime
 *   and accountExpires are refused before any password is tried; an expired password or "must change at next logon"
 *   (pwdLastSet 0) is refused after the right one, in words; the bind error codes (`data 52e`, `532`, `533`, `701`,
 *   `773`, `775`) are read the same way;
 * - domain controllers from `urls` or DNS SRV records (`_ldap._tcp`, `_gc._tcp` for the Global Catalog, a site's
 *   first), tried in order with failover; the last one that answered is tried first next time;
 * - LDAPS or StartTLS only, certificate verified; a plain bind is never made, in development either.
 *
 * 1.9.9-qa (QA-1, the Sprint 54 leftovers):
 *
 * - the primary group (primaryGroupID, usually Domain Users), which neither memberOf nor the in-chain search
 *   returns, is found by its SID (the account's domain SID with primaryGroupID as the last sub-authority) under the
 *   account's domain and mapped like any group (`primaryGroup`, on by default);
 * - with nesting off, a large memberOf comes back as `memberOf;range=0-1499` (AD's MaxValRange); the rest is read
 *   with base searches for `memberOf;range=<next>-*` until the range ends in `*` (or `maxGroups`);
 * - SRV records are ordered as RFC 2782 says: by priority, then weighted-random within a priority (a weight-0 record
 *   only on a draw of 0 or when it is the last left), every time the candidates are asked for (the records are cached, not the order).
 */

export type SrvRecord = { name: string; port: number; priority: number; weight: number };
export type SrvResolver = (name: string) => Promise<SrvRecord[]>;

/** The bits of userAccountControl and msDS-User-Account-Control-Computed read here. */
export const UAC = { ACCOUNTDISABLE: 0x2, LOCKOUT: 0x10, DONT_EXPIRE_PASSWORD: 0x10000, PASSWORD_EXPIRED: 0x800000 } as const;

/** AD's sub-codes in an invalidCredentials (49) bind error: `... data 775, v4563`. */
export const AD_BIND_CODES: Record<string, 'invalid' | StoreRefusal> = {
  '525': 'invalid', // no such user (said as a wrong password)
  '52e': 'invalid', // wrong password
  '530': 'disabled', // not permitted to sign in at this time
  '531': 'disabled', // not permitted to sign in at this workstation
  '532': 'password_expired',
  '533': 'disabled',
  '701': 'account_expired',
  '773': 'must_change',
  '775': 'locked'
};

/** What a person (or, for locked and disabled, an admin) is told. */
export const AD_REFUSAL_WORDS: Record<StoreRefusal, string> = {
  password_expired: 'Your directory password has expired. Change it in Windows (or ask the help desk), then sign in again.',
  must_change: 'Your directory password must be changed before you can sign in. Change it in Windows (or ask the help desk), then sign in again.',
  account_expired: 'Your directory account has expired. Ask the help desk to extend it.',
  locked: 'The directory account is locked after failed sign-ins.',
  disabled: 'The directory account is disabled.'
};

const LDAP_MATCHING_RULE_IN_CHAIN = '1.2.840.113556.1.4.1941';
const RANGE = /^memberof;range=(\d+)-(\d+|\*)$/i;
/** Range rounds read at most (1,500 values each in AD's default policy): far beyond `maxGroups`'s ceiling. */
const MAX_RANGE_ROUNDS = 50;
const SRV_TTL_MS = 5 * 60_000;
const NEVER = 0x7fffffffffffffffn;

/** objectGUID bytes as GUID text: the first three groups little-endian, as Windows shows it. */
export function guidToString(b: Buffer): string {
  if (b.length !== 16) throw new Error('objectGUID is not 16 bytes');
  const h = (i: number) => b[i]!.toString(16).padStart(2, '0');
  return `${h(3)}${h(2)}${h(1)}${h(0)}-${h(5)}${h(4)}-${h(7)}${h(6)}-${h(8)}${h(9)}-${h(10)}${h(11)}${h(12)}${h(13)}${h(14)}${h(15)}`;
}

/** GUID text back to objectGUID bytes; null when it is not a GUID. */
export function guidToBuffer(s: string): Buffer | null {
  const m = /^\{?([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\}?$/i.exec(s.trim());
  if (!m) return null;
  const le = (hex: string) => Buffer.from(hex, 'hex').reverse();
  return Buffer.concat([le(m[1]!), le(m[2]!), le(m[3]!), Buffer.from(m[4]! + m[5]!, 'hex')]);
}

/** A Windows FILETIME (100 ns since 1601) as epoch milliseconds; null for 0 and "never". */
export function fileTimeToMs(v: string | null): number | null {
  if (v == null || !/^-?\d{1,20}$/.test(v.trim())) return null;
  const n = BigInt(v.trim());
  if (n <= 0n || n >= NEVER) return null;
  return Number(n / 10000n) - 11644473600000;
}

/** A binary SID as text (`S-1-5-21-…`); null when it is not a SID. */
export function sidToString(b: Buffer): string | null {
  if (b.length < 8 || b.length !== 8 + 4 * b[1]!) return null;
  const authority = b.readUIntBE(2, 6);
  const subs: number[] = [];
  for (let i = 0; i < b[1]!; i++) subs.push(b.readUInt32LE(8 + 4 * i));
  return `S-${b[0]}-${authority}${subs.map((x) => `-${x}`).join('')}`;
}

/** The primary group's SID: the account's SID (its domain SID plus its RID) with the RID replaced by primaryGroupID. */
export function primaryGroupSid(userSid: Buffer, primaryGroupId: number): Buffer | null {
  if (sidToString(userSid) == null || userSid[1]! < 2 || !Number.isInteger(primaryGroupId) || primaryGroupId < 0 || primaryGroupId > 0xffffffff) return null;
  const out = Buffer.from(userSid);
  out.writeUInt32LE(primaryGroupId, out.length - 4);
  return out;
}

/**
 * RFC 2782 order: lowest priority first; within a priority, repeatedly draw one at random weighted by weight (the
 * remaining weight-0 records first in the running sum, so they are chosen only when the draw is 0 or nothing else is
 * left).
 */
export function srvOrder<T extends { priority: number; weight: number }>(records: T[], random: () => number = Math.random): T[] {
  const byPriority = new Map<number, T[]>();
  for (const r of records) byPriority.set(r.priority, [...(byPriority.get(r.priority) ?? []), r]);
  const out: T[] = [];
  for (const p of [...byPriority.keys()].sort((a, b) => a - b)) {
    const left = [...byPriority.get(p)!].sort((a, b) => (a.weight === 0 ? 0 : 1) - (b.weight === 0 ? 0 : 1));
    while (left.length) {
      const total = left.reduce((n, r) => n + Math.max(0, r.weight), 0);
      const pick = Math.floor(random() * (total + 1));
      let sum = 0;
      let i = left.findIndex((r) => (sum += Math.max(0, r.weight)) >= pick);
      if (i < 0) i = left.length - 1;
      out.push(left.splice(i, 1)[0]!);
    }
  }
  return out;
}

/** The sub-code of an AD bind error, lower case (`775`), or null. */
export function adBindCode(message: string): string | null {
  return /\bdata ([0-9a-f]{3,4})\b/i.exec(message)?.[1]?.toLowerCase() ?? null;
}

const text = (v: Entry[string] | undefined): string | null => {
  if (v == null) return null;
  const x = Array.isArray(v) ? v[0] : v;
  return x == null ? null : Buffer.isBuffer(x) ? x.toString('utf8') : String(x);
};
const texts = (v: Entry[string] | undefined): string[] => (v == null ? [] : (Array.isArray(v) ? v : [v]).map((x) => (Buffer.isBuffer(x) ? x.toString('utf8') : String(x))));
const buffer = (v: Entry[string] | undefined): Buffer | null => {
  if (v == null) return null;
  const x = Array.isArray(v) ? v[0] : v;
  return Buffer.isBuffer(x) ? x : null;
};
const int = (v: Entry[string] | undefined): number | null => {
  const t = text(v);
  return t != null && /^-?\d{1,12}$/.test(t) ? Number(t) : null;
};

/** The username as typed, in the form the directory is asked with: `CORP\alice` → `alice`. */
export function adUsername(input: string): string {
  const t = input.trim();
  const slash = t.indexOf('\\');
  return slash > 0 && !t.includes('@') ? t.slice(slash + 1) : t;
}

class Transport extends Error {}

export class AdProvider implements IdentityProvider {
  readonly kind = 'ad' as const;
  private srvCache: { at: number; records: (SrvRecord & { url: string })[] } | null = null;
  /** The domain controller that answered last; tried first next time. */
  private preferred: string | null = null;
  /** Primary groups by SID (hex): most accounts share Domain Users, so it is looked up once in a while. */
  private readonly primaryGroups = new Map<string, { at: number; group: { dn: string; cn: string | null } | null }>();

  constructor(
    readonly id: string,
    readonly name: string,
    private readonly cfg: AdConfig,
    /** The directory must be an internal host unless IDENTITY_ALLOWED_HOSTS names it. */
    private readonly allow: AllowList = parseAllowList(''),
    private readonly vault: VaultRefResolver | null = null,
    private readonly srv: SrvResolver = (n) => dns.resolveSrv(n),
    /** RFC 2782's weighted draw (a stand-in in tests). */
    private readonly random: () => number = Math.random
  ) {
    for (const u of cfg.urls) if (u.startsWith('ldap://') && !cfg.startTLS) throw new Error(`${name}: ldap:// without StartTLS is refused; Active Directory is asked over LDAPS or StartTLS only`);
  }

  private tlsOptions(host: string): ConnectionOptions {
    return { ...(isIP(host) ? {} : { servername: host }), minVersion: 'TLSv1.2', rejectUnauthorized: true, ...(this.cfg.caFile ? { ca: readFileSync(this.cfg.caFile) } : {}) };
  }

  /** The domain controllers to try, in order: the configured URLs, or SRV records (a site's first) in RFC 2782 order. */
  async candidates(steps?: Step[]): Promise<string[]> {
    if (this.cfg.urls.length) return this.order(this.cfg.urls);
    if (this.srvCache && Date.now() - this.srvCache.at < SRV_TTL_MS) return this.order(this.srvOrdered(this.srvCache.records));
    const service = this.cfg.globalCatalog ? '_gc._tcp' : '_ldap._tcp';
    const names = [...(this.cfg.site ? [`${service}.${this.cfg.site}._sites.${this.cfg.domain}`] : []), `${service}.${this.cfg.domain}`];
    const records = await timed(
      steps,
      `Find domain controllers (${names.join(', ')})`,
      async () => {
        for (const n of names) {
          const found = await this.srv(n).catch(() => [] as SrvRecord[]);
          // RFC 2782: a single record of target "." means the service is decidedly not available here.
          const usable = found.filter((r) => r.name && r.name !== '.');
          if (!usable.length) continue;
          return usable.slice(0, 50).map((r) => {
            const host = r.name.replace(/\.$/, '').toLowerCase();
            const h = isIP(host) === 6 ? `[${host}]` : host;
            return { ...r, url: this.cfg.startTLS ? `ldap://${h}:${r.port}` : `ldaps://${h}:${this.cfg.ldapsPort ?? (this.cfg.globalCatalog ? 3269 : 636)}` };
          });
        }
        throw new Error(`No SRV records for ${names.join(' or ')}.`);
      },
      (r) => r.map((x) => `${x.url} (priority ${x.priority}, weight ${x.weight})`).join(', ')
    );
    this.srvCache = { at: Date.now(), records };
    return this.order(this.srvOrdered(records));
  }

  /** A fresh RFC 2782 draw over the cached records; ten domain controllers at most, duplicates dropped. */
  private srvOrdered(records: (SrvRecord & { url: string })[]): string[] {
    return [...new Set(srvOrder(records, this.random).map((r) => r.url))].slice(0, 10);
  }

  private order(urls: string[]): string[] {
    return this.preferred && urls.includes(this.preferred) ? [this.preferred, ...urls.filter((u) => u !== this.preferred)] : urls;
  }

  private async open(url: string, steps?: Step[]): Promise<Client> {
    const target = new URL(url);
    if (target.protocol === 'ldap:' && !this.cfg.startTLS) throw new Error('ldap:// without StartTLS is refused.');
    const { addresses } = await timed(steps, `Check ${target.host}`, () => checkHost(target.hostname, this.allow));
    // Dial the address that was checked (TLS still verifies the configured name), so DNS cannot rebind in between.
    const dial = new URL(url);
    dial.hostname = isIP(addresses[0]!) === 6 ? `[${addresses[0]}]` : addresses[0]!;
    const client = new Client({ url: dial.toString(), timeout: this.cfg.timeoutMs, connectTimeout: this.cfg.timeoutMs, ...(target.protocol === 'ldaps:' ? { tlsOptions: this.tlsOptions(target.hostname) } : {}) });
    if (this.cfg.startTLS) await timed(steps, 'StartTLS', () => client.startTLS(this.tlsOptions(target.hostname)));
    return client;
  }

  private async serviceBind(client: Client, steps?: Step[]): Promise<void> {
    await timed(steps, `Service bind as ${this.cfg.bindDN}`, async () => client.bind(this.cfg.bindDN, await resolveSecretRef(this.cfg.bindPassword, this.vault)));
  }

  /** Connects and binds as the service account at the first domain controller that answers. */
  private async connect(steps?: Step[]): Promise<{ client: Client; url: string }> {
    const urls = await this.candidates(steps);
    const failures: string[] = [];
    for (const url of urls) {
      let client: Client | null = null;
      try {
        client = await this.open(url, steps);
        await this.serviceBind(client, steps);
        this.preferred = url;
        return { client, url };
      } catch (err) {
        await client?.unbind().catch(() => undefined);
        // A refused service account is a configuration problem, the same at every domain controller.
        if (err instanceof InvalidCredentialsError) throw new Error(`The service account was refused at ${new URL(url).host}: ${(err as Error).message}`, { cause: err });
        failures.push(`${new URL(url).host}: ${(err as Error).message}`);
      }
    }
    throw new Transport(`No domain controller answered (${failures.join('; ')}).`);
  }

  private attributes(): string[] {
    const c = this.cfg;
    return ['objectGUID', 'sAMAccountName', 'userPrincipalName', c.displayNameAttribute, c.emailAttribute, c.managerAttribute, 'memberOf', 'userAccountControl', 'msDS-User-Account-Control-Computed', 'lockoutTime', 'pwdLastSet', 'accountExpires', 'msDS-UserPasswordExpiryTimeComputed', 'objectSid', 'primaryGroupID'];
  }

  private matchFor(username: string): string {
    const u = adUsername(username);
    const v = escapeFilterValue(u);
    const upn = escapeFilterValue(u.includes('@') ? u : `${u}@${this.cfg.domain}`);
    switch (this.cfg.signInAttribute) {
      case 'sAMAccountName':
        return `(sAMAccountName=${v})`;
      case 'userPrincipalName':
        return `(userPrincipalName=${upn})`;
      case 'either':
        return u.includes('@') ? `(userPrincipalName=${v})` : `(|(sAMAccountName=${v})(userPrincipalName=${upn}))`;
    }
  }

  private async search(client: Client, filter: string | Filter, steps?: Step[]): Promise<Entry | null | 'ambiguous'> {
    const { searchEntries } = await timed(
      steps,
      'Search for the account',
      () => client.search(this.cfg.baseDN, { scope: 'sub', filter, sizeLimit: 2, attributes: this.attributes(), explicitBufferAttributes: ['objectGUID', 'objectSid'] }),
      (r) => `${r.searchEntries.length} match${r.searchEntries.length === 1 ? '' : 'es'} under ${this.cfg.baseDN}`
    );
    if (searchEntries.length > 1) return 'ambiguous';
    return searchEntries[0] ?? null;
  }

  private findUser(client: Client, username: string, steps?: Step[]) {
    return this.search(client, `(&${this.cfg.userFilter.trim()}${this.matchFor(username)})`, steps);
  }

  private findById(client: Client, guid: Buffer, steps?: Step[]) {
    // A filter object, so the GUID's bytes go on the wire as they are (a string filter would re-encode them).
    return this.search(client, new AndFilter({ filters: [FilterParser.parseString(this.cfg.userFilter.trim()), new EqualityFilter({ attribute: 'objectGUID', value: guid as unknown as string })] }), steps);
  }

  /** Refusals the directory's flags show before any password is tried: disabled, locked, expired account. */
  accountRefusal(entry: Entry, now = Date.now()): StoreRefusal | null {
    const uac = int(entry.userAccountControl) ?? 0;
    const computed = int(entry['msDS-User-Account-Control-Computed']);
    if (uac & UAC.ACCOUNTDISABLE) return 'disabled';
    if (computed != null ? computed & UAC.LOCKOUT : (fileTimeToMs(text(entry.lockoutTime)) ?? 0) > 0) return 'locked';
    const expires = fileTimeToMs(text(entry.accountExpires));
    if (expires != null && expires <= now) return 'account_expired';
    return null;
  }

  /** Refusals told only after the right password: must change at next logon, expired password. */
  passwordRefusal(entry: Entry, now = Date.now()): StoreRefusal | null {
    const uac = int(entry.userAccountControl) ?? 0;
    const computed = int(entry['msDS-User-Account-Control-Computed']);
    if (text(entry.pwdLastSet)?.trim() === '0') return 'must_change';
    if (uac & UAC.DONT_EXPIRE_PASSWORD) return null;
    if (computed != null && computed & UAC.PASSWORD_EXPIRED) return 'password_expired';
    const expiry = fileTimeToMs(text(entry['msDS-UserPasswordExpiryTimeComputed']));
    if (expiry != null && expiry <= now) return 'password_expired';
    return null;
  }

  /** memberOf, all of it: a `memberOf;range=a-b` answer is followed with base searches until the range ends. */
  private async memberOf(client: Client, entry: Entry, steps?: Step[]): Promise<string[]> {
    let key = Object.keys(entry).find((k) => RANGE.test(k));
    if (!key) return texts(entry.memberOf);
    const out = texts(entry[key]);
    let rounds = 0;
    await timed(
      steps,
      'Read memberOf by range (a large group list)',
      async () => {
        for (let m = RANGE.exec(key!); m && m[2] !== '*' && out.length < this.cfg.maxGroups && rounds < MAX_RANGE_ROUNDS; m = key ? RANGE.exec(key) : null) {
          const start = Number(m[2]) + 1;
          const { searchEntries } = await client.search(entry.dn, { scope: 'base', filter: '(objectClass=*)', attributes: [`memberOf;range=${start}-*`] });
          rounds++;
          const next = searchEntries[0];
          key = next ? Object.keys(next).find((k) => RANGE.test(k)) : undefined;
          if (!next || !key) break;
          out.push(...texts(next[key]));
        }
      },
      () => `${out.length} values in ${rounds + 1} range${rounds ? 's' : ''}`
    );
    return out;
  }

  /** The account's primary group by SID under its own domain; cached for a few minutes. */
  private async primaryGroupOf(client: Client, entry: Entry, steps?: Step[]): Promise<{ dn: string; cn: string | null } | null> {
    if (!this.cfg.primaryGroup) return null;
    const rid = int(entry.primaryGroupID);
    const sid = buffer(entry.objectSid);
    const groupSid = sid && rid != null ? primaryGroupSid(sid, rid) : null;
    if (!groupSid) return null;
    const key = groupSid.toString('hex');
    const hit = this.primaryGroups.get(key);
    if (hit && Date.now() - hit.at < SRV_TTL_MS) return hit.group;
    // The account's own domain (its trailing DC= components), which with the Global Catalog may not be baseDN's.
    const domainBase = /((?:DC=[^,]+,\s*)*DC=[^,]+)\s*$/i.exec(entry.dn)?.[1] ?? this.cfg.baseDN;
    const group = await timed(
      steps,
      `Resolve the primary group (${sidToString(groupSid)})`,
      async () => {
        const filter = new AndFilter({ filters: [new EqualityFilter({ attribute: 'objectClass', value: 'group' }), new EqualityFilter({ attribute: 'objectSid', value: groupSid as unknown as string })] });
        const { searchEntries } = await client.search(domainBase, { scope: 'sub', filter, sizeLimit: 1, attributes: ['cn'] });
        const g = searchEntries[0];
        return g ? { dn: g.dn, cn: text(g.cn) } : null;
      },
      (g) => g?.dn ?? 'not found'
    );
    if (this.primaryGroups.size > 100) this.primaryGroups.clear();
    this.primaryGroups.set(key, { at: Date.now(), group });
    return group;
  }

  private async groupsFor(client: Client, entry: Entry, steps?: Step[]): Promise<string[]> {
    const name = (dn: string, cn: string | null) => (this.cfg.groupNameAttribute === 'dn' ? dn : (cn ?? /^cn=([^,]+)/i.exec(dn)?.[1] ?? dn));
    const primary = await this.primaryGroupOf(client, entry, steps).catch((err: Error) => {
      // A primary group that cannot be read leaves the other groups as they are (it is never a sign-in failure).
      steps?.push({ title: 'Primary group', ok: false, detail: err.message });
      return null;
    });
    const first = primary ? [name(primary.dn, primary.cn)] : [];
    if (!this.cfg.nestedGroups) {
      const dns = await this.memberOf(client, entry, steps);
      steps?.push({ title: 'Read memberOf (direct groups)', ok: true, detail: `${dns.length} groups${primary ? ' and the primary group' : ''}` });
      return [...new Set([...first, ...dns.map((dn) => name(dn, null))])].slice(0, this.cfg.maxGroups);
    }
    const filter = new AndFilter({ filters: [new EqualityFilter({ attribute: 'objectClass', value: 'group' }), new ExtensibleFilter({ matchType: 'member', rule: LDAP_MATCHING_RULE_IN_CHAIN, value: entry.dn })] });
    return timed(
      steps,
      'Search for groups, nested included',
      async () => {
        const out: string[] = [];
        let pages = 0;
        for await (const page of client.searchPaginated(this.cfg.groupBase ?? this.cfg.baseDN, { scope: 'sub', filter, attributes: ['cn'], paged: { pageSize: this.cfg.pageSize } })) {
          pages++;
          for (const g of page.searchEntries) out.push(name(g.dn, text(g.cn)));
          if (out.length >= this.cfg.maxGroups) break;
        }
        return { groups: [...new Set([...first, ...out])].slice(0, this.cfg.maxGroups), pages };
      },
      (r) => `${r.groups.length} groups in ${r.pages} page${r.pages === 1 ? '' : 's'}`
    ).then((r) => r.groups);
  }

  private toUser(entry: Entry, groups: string[]): ExternalUser {
    const guid = buffer(entry.objectGUID);
    if (!guid || guid.length !== 16) throw new Error(`${entry.dn} has no objectGUID.`);
    const sam = text(entry.sAMAccountName);
    const upn = text(entry.userPrincipalName);
    const username = (this.cfg.usernameFrom === 'userPrincipalName' ? (upn ?? sam) : (sam ?? upn))?.toLowerCase();
    if (!username) throw new Error(`${entry.dn} has no sAMAccountName or userPrincipalName.`);
    return {
      externalId: guidToString(guid),
      username,
      displayName: text(entry[this.cfg.displayNameAttribute]) ?? username,
      email: text(entry[this.cfg.emailAttribute]),
      groups,
      manager: text(entry[this.cfg.managerAttribute])
    };
  }

  async authenticate(username: string, password: string, steps?: Step[]): Promise<AuthResult> {
    // An empty password is an unauthenticated bind, which AD accepts as anonymous: never let it through.
    if (!password) return { status: 'invalid' };
    let client: Client | null = null;
    try {
      ({ client } = await this.connect(steps));
      const entry = await this.findUser(client, username, steps);
      if (entry === 'ambiguous') return { status: 'error', message: 'The sign-in name matched more than one account.' };
      if (!entry) return { status: 'not_found' };
      const before = this.accountRefusal(entry);
      if (before) {
        steps?.push({ title: 'Account state', ok: false, detail: AD_REFUSAL_WORDS[before] });
        return { status: 'disabled', reason: before };
      }
      try {
        await timed(steps, `Bind as ${entry.dn}`, () => (client as Client).bind(entry.dn, password));
      } catch (err) {
        if (!(err instanceof InvalidCredentialsError)) throw err;
        const code = adBindCode((err as Error).message);
        const meaning = code ? AD_BIND_CODES[code] : undefined;
        if (!meaning || meaning === 'invalid') return { status: 'invalid' };
        steps?.push({ title: `Directory code ${code}`, ok: false, detail: AD_REFUSAL_WORDS[meaning] });
        return { status: 'disabled', reason: meaning };
      }
      const after = this.passwordRefusal(entry);
      if (after) {
        steps?.push({ title: 'Password state', ok: false, detail: AD_REFUSAL_WORDS[after] });
        return { status: 'disabled', reason: after };
      }
      // Back to the service account to read groups: the user may not be allowed to search.
      await this.serviceBind(client, steps);
      return { status: 'ok', user: this.toUser(entry, await this.groupsFor(client, entry, steps)) };
    } catch (err) {
      return { status: 'error', message: (err as Error).message };
    } finally {
      await client?.unbind().catch(() => undefined);
    }
  }

  /** Directory sync: a disabled or expired account reads as gone; a locked one (temporary) is still there. */
  private async lookupWith(find: (c: Client) => Promise<Entry | null | 'ambiguous'>, steps?: Step[]): Promise<ExternalUser | null> {
    const { client } = await this.connect(steps);
    try {
      const entry = await find(client);
      if (!entry || entry === 'ambiguous') return null;
      const refusal = this.accountRefusal(entry);
      if (refusal === 'disabled' || refusal === 'account_expired') {
        steps?.push({ title: 'Account state', ok: false, detail: AD_REFUSAL_WORDS[refusal] });
        return null;
      }
      return this.toUser(entry, await this.groupsFor(client, entry, steps));
    } finally {
      await client.unbind().catch(() => undefined);
    }
  }

  lookup(username: string, steps?: Step[]): Promise<ExternalUser | null> {
    return this.lookupWith((c) => this.findUser(c, username, steps), steps);
  }

  async lookupById(externalId: string, steps?: Step[]): Promise<ExternalUser | null> {
    const guid = guidToBuffer(externalId);
    if (!guid) return null;
    return this.lookupWith((c) => this.findById(c, guid, steps), steps);
  }

  async test(steps: Step[]): Promise<boolean> {
    let client: Client | null = null;
    try {
      const c = await this.connect(steps);
      client = c.client;
      steps.push({ title: 'Domain controller', ok: true, detail: new URL(c.url).host });
      await timed(steps, `Read ${this.cfg.baseDN}`, () => (client as Client).search(this.cfg.baseDN, { scope: 'base', attributes: ['dn'] }));
      return true;
    } catch (err) {
      if (!steps.some((s) => !s.ok)) steps.push({ title: 'Connection', ok: false, detail: (err as Error).message });
      return false;
    } finally {
      await client?.unbind().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    // Connections are per request; nothing pooled to close.
  }
}
