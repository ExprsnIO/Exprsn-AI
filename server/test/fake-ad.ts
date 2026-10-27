import { randomBytes } from 'node:crypto';
import { createServer as createNetServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { createServer as createTlsServer, TLSSocket } from 'node:tls';
import { BerReader, BerWriter, PagedResultsControl } from 'ldapts';

/*
 * 1.9.0, Sprint 54 (B-182): an in-process stand-in for an Active Directory domain controller, enough of LDAPv3 for
 * the `ad` store: simple bind (with AD's `data 52e/532/533/701/773/775` sub-codes), search with and/or/not,
 * equality (objectGUID compared as bytes), presence, substrings and LDAP_MATCHING_RULE_IN_CHAIN over `member`, the
 * paged results control, StartTLS, and LDAPS. It is never the live directory.
 *
 * QA-1: objectSid on accounts and groups (a domain SID plus a RID), primaryGroupID (only resolved when a group with
 * that RID exists), and AD's MaxValRange for memberOf: past `maxValRange` values it answers `memberOf;range=0-<n>`
 * and serves the rest to `memberOf;range=<a>-*` asks.
 */

type Value = string | Buffer;
type Filter =
  | { op: 'and' | 'or'; fs: Filter[] }
  | { op: 'not'; f: Filter }
  | { op: 'eq'; a: string; v: Buffer }
  | { op: 'present'; a: string }
  | { op: 'sub'; a: string; initial?: string; any: string[]; final?: string }
  | { op: 'ext'; a: string; rule: string; v: string };

interface Entry {
  dn: string;
  attrs: Map<string, { name: string; values: Value[] }>;
}

export interface FakeAdUser {
  sam: string;
  upn?: string;
  password: string;
  displayName?: string;
  mail?: string;
  ou?: string;
  guid?: Buffer;
  userAccountControl?: number;
  computed?: number;
  lockoutTime?: string;
  pwdLastSet?: string;
  accountExpires?: string;
  passwordExpiry?: string;
  objectClass?: string[];
  /** The primary group's RID (513 is Domain Users). */
  primaryGroupID?: number;
}

/** A binary SID: revision 1, authority 5 (NT), the sub-authorities little-endian. */
export function sidBytes(subs: number[]): Buffer {
  const b = Buffer.alloc(8 + 4 * subs.length);
  b[0] = 1;
  b[1] = subs.length;
  b.writeUIntBE(5, 2, 6);
  subs.forEach((x, i) => b.writeUInt32LE(x, 8 + 4 * i));
  return b;
}

const RULE_IN_CHAIN = '1.2.840.113556.1.4.1941';
const PAGED = '1.2.840.113556.1.4.319';
const STARTTLS = '1.3.6.1.4.1.1466.20037';
const lc = (s: string) => s.toLowerCase();

export class FakeAd {
  readonly base: string;
  readonly bindDN: string;
  readonly bindPassword = 'svc-' + randomBytes(6).toString('hex');
  private readonly entries = new Map<string, Entry>();
  private readonly passwords = new Map<string, string>();
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  port = 0;
  /** What was asked, for the assertions. */
  readonly binds: string[] = [];
  readonly searches: { base: string; paged: number | null; pageCookie: string }[] = [];
  readonly pagesServed: number[] = [];
  startTlsCount = 0;
  /** The domain SID's sub-authorities (S-1-5-21-a-b-c). */
  readonly domainSid = [21, 1004336348, 1177238915, 682003330];
  private nextRid = 1100;
  /** AD's MaxValRange for memberOf (Infinity: never ranged). */
  maxValRange = Infinity;
  /** The range asks served (`memberOf;range=1500-*`), for the assertions. */
  readonly rangeAsks: string[] = [];

  constructor(
    readonly domain = 'corp.example.com',
    private readonly tls: { key: string; cert: string } | null = null,
    /** `ldaps`: TLS from the first byte; `starttls`: plain until the StartTLS extended operation. */
    readonly mode: 'ldaps' | 'starttls' = 'ldaps'
  ) {
    this.base = domain.split('.').map((p) => `DC=${p}`).join(',');
    this.bindDN = `CN=svc-exprsn,OU=Service Accounts,${this.base}`;
    this.put(this.base, { objectClass: ['top', 'domain'] });
    this.put(this.bindDN, { objectClass: ['top', 'user'], sAMAccountName: ['svc-exprsn'], userPrincipalName: [`svc-exprsn@${domain}`] });
    this.passwords.set(lc(this.bindDN), this.bindPassword);
  }

  private put(dn: string, attrs: Record<string, Value[]>): Entry {
    const e: Entry = { dn, attrs: new Map() };
    for (const [k, v] of Object.entries(attrs)) e.attrs.set(lc(k), { name: k, values: v });
    this.entries.set(lc(dn), e);
    return e;
  }

  userDn(sam: string, ou = 'Staff'): string {
    return `CN=${sam},OU=${ou},${this.base}`;
  }

  addUser(u: FakeAdUser): { dn: string; guid: Buffer } {
    const dn = this.userDn(u.sam, u.ou);
    const guid = u.guid ?? randomBytes(16);
    const attrs: Record<string, Value[]> = {
      objectClass: u.objectClass ?? ['top', 'person', 'organizationalPerson', 'user'],
      objectCategory: ['person'],
      objectGUID: [guid],
      sAMAccountName: [u.sam],
      userPrincipalName: [u.upn ?? `${u.sam}@${this.domain}`],
      displayName: [u.displayName ?? u.sam],
      userAccountControl: [String(u.userAccountControl ?? 0x200)],
      pwdLastSet: [u.pwdLastSet ?? '133000000000000000'],
      accountExpires: [u.accountExpires ?? '9223372036854775807'],
      lockoutTime: [u.lockoutTime ?? '0'],
      objectSid: [sidBytes([...this.domainSid, this.nextRid++])],
      primaryGroupID: [String(u.primaryGroupID ?? 513)]
    };
    if (u.mail) attrs.mail = [u.mail];
    if (u.computed != null) attrs['msDS-User-Account-Control-Computed'] = [String(u.computed)];
    if (u.passwordExpiry) attrs['msDS-UserPasswordExpiryTimeComputed'] = [u.passwordExpiry];
    this.put(dn, attrs);
    this.passwords.set(lc(dn), u.password);
    return { dn, guid };
  }

  /** Renames an account (its DN and sAMAccountName change; its objectGUID stays). */
  rename(oldSam: string, newSam: string, ou = 'Staff'): string {
    const old = this.entries.get(lc(this.userDn(oldSam, ou)))!;
    this.entries.delete(lc(old.dn));
    const dn = this.userDn(newSam, ou);
    old.dn = dn;
    old.attrs.set('samaccountname', { name: 'sAMAccountName', values: [newSam] });
    old.attrs.set('userprincipalname', { name: 'userPrincipalName', values: [`${newSam}@${this.domain}`] });
    this.entries.set(lc(dn), old);
    const pw = this.passwords.get(lc(this.userDn(oldSam, ou)));
    if (pw) this.passwords.set(lc(dn), pw);
    for (const g of this.entries.values()) {
      const m = g.attrs.get('member');
      if (m) m.values = m.values.map((v) => (lc(String(v)) === lc(this.userDn(oldSam, ou)) ? dn : v));
    }
    return dn;
  }

  set(sam: string, attr: string, value: string, ou = 'Staff'): void {
    this.entries.get(lc(this.userDn(sam, ou)))!.attrs.set(lc(attr), { name: attr, values: [value] });
  }

  groupDn(cn: string): string {
    return `CN=${cn},OU=Groups,${this.base}`;
  }

  addGroup(cn: string, members: string[], opts: { rid?: number; dn?: string } = {}): string {
    const dn = opts.dn ?? this.groupDn(cn);
    this.put(dn, { objectClass: ['top', 'group'], cn: [cn], member: members, objectSid: [sidBytes([...this.domainSid, opts.rid ?? this.nextRid++])] });
    return dn;
  }

  private memberOf(dn: string): string[] {
    return [...this.entries.values()].filter((g) => (g.attrs.get('member')?.values ?? []).some((v) => lc(String(v)) === lc(dn))).map((g) => g.dn);
  }

  private inChain(group: Entry, target: string, seen = new Set<string>()): boolean {
    if (seen.has(lc(group.dn))) return false;
    seen.add(lc(group.dn));
    for (const m of group.attrs.get('member')?.values ?? []) {
      if (lc(String(m)) === lc(target)) return true;
      const inner = this.entries.get(lc(String(m)));
      if (inner && this.inChain(inner, target, seen)) return true;
    }
    return false;
  }

  private values(e: Entry, a: string): Value[] {
    if (lc(a) === 'memberof') return this.memberOf(e.dn);
    if (lc(a) === 'distinguishedname') return [e.dn];
    return e.attrs.get(lc(a))?.values ?? [];
  }

  private matches(e: Entry, f: Filter): boolean {
    switch (f.op) {
      case 'and':
        return f.fs.every((x) => this.matches(e, x));
      case 'or':
        return f.fs.some((x) => this.matches(e, x));
      case 'not':
        return !this.matches(e, f.f);
      case 'present':
        return lc(f.a) === 'objectclass' || this.values(e, f.a).length > 0;
      case 'eq':
        return this.values(e, f.a).some((v) => (Buffer.isBuffer(v) ? v.equals(f.v) : lc(v) === lc(f.v.toString('utf8'))));
      case 'sub':
        return this.values(e, f.a).some((raw) => {
          const v = lc(String(raw));
          let i = 0;
          if (f.initial) {
            if (!v.startsWith(lc(f.initial))) return false;
            i = f.initial.length;
          }
          for (const part of f.any) {
            const j = v.indexOf(lc(part), i);
            if (j < 0) return false;
            i = j + part.length;
          }
          return !f.final || v.slice(i).endsWith(lc(f.final));
        });
      case 'ext':
        if (f.rule === RULE_IN_CHAIN && lc(f.a) === 'member') return this.inChain(e, f.v);
        return false;
    }
  }

  // ---------- the wire ----------

  async start(): Promise<this> {
    const onSocket = (sock: Socket) => this.serve(sock);
    this.server = this.mode === 'ldaps' ? createTlsServer({ key: this.tls!.key, cert: this.tls!.cert }, onSocket) : createNetServer(onSocket);
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    return this;
  }

  get url(): string {
    return `${this.mode === 'ldaps' ? 'ldaps' : 'ldap'}://localhost:${this.port}`;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  private serve(initial: Socket): void {
    let sock: Socket = initial;
    this.sockets.add(sock);
    let buf = Buffer.alloc(0);
    let bound: string | null = null;
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const r = new BerReader(buf);
        let seq: number | null;
        try {
          seq = r.readSequence();
        } catch {
          return;
        }
        if (seq == null || r.remain < r.length) return;
        const end = r.offset + r.length;
        const message = buf.subarray(0, end);
        buf = buf.subarray(end);
        const upgraded = this.handle(new BerReader(message), sock, (dn) => (bound = dn), () => bound);
        if (upgraded) {
          sock.off('data', onData);
          const secure = new TLSSocket(sock, { isServer: true, key: this.tls!.key, cert: this.tls!.cert });
          this.sockets.add(secure);
          sock = secure;
          secure.on('data', onData);
          secure.on('error', () => undefined);
          return;
        }
      }
    };
    sock.on('data', onData);
    sock.on('error', () => undefined);
  }

  /** Handles one message; true when the socket must now be upgraded to TLS (after a StartTLS answer). */
  private handle(r: BerReader, sock: Socket, setBound: (dn: string | null) => void, bound: () => string | null): boolean {
    r.readSequence();
    const id = r.readInt()!;
    const tag = r.peek();
    const send = (b: Buffer) => sock.write(b);
    if (tag === 0x42) {
      sock.end();
      return false;
    }
    if (tag === 0x60) {
      r.readSequence(0x60);
      r.readInt();
      const dn = r.readString() ?? '';
      const password = r.readString(0x80) ?? '';
      this.binds.push(dn);
      if (!password) {
        setBound(null);
        send(result(id, 0x61, 0));
        return false;
      }
      const key = this.resolveBindName(dn);
      const want = key ? this.passwords.get(key) : undefined;
      const fail = (code: string) => send(result(id, 0x61, 49, `80090308: LdapErr: DSID-0C09044E, comment: AcceptSecurityContext error, data ${code}, v4563`));
      if (!key || want !== password) {
        fail(key ? '52e' : '525');
        return false;
      }
      const e = this.entries.get(key)!;
      const uac = Number(this.values(e, 'userAccountControl')[0] ?? 0);
      const lockout = String(this.values(e, 'lockoutTime')[0] ?? '0');
      const expires = String(this.values(e, 'accountExpires')[0] ?? '0');
      if (uac & 2) {
        fail('533');
        return false;
      }
      if (lockout !== '0') {
        fail('775');
        return false;
      }
      if (expires !== '0' && expires !== '9223372036854775807' && Number(BigInt(expires) / 10000n) - 11644473600000 < Date.now()) {
        fail('701');
        return false;
      }
      if (String(this.values(e, 'pwdLastSet')[0] ?? '') === '0') {
        fail('773');
        return false;
      }
      const expiry = String(this.values(e, 'msDS-UserPasswordExpiryTimeComputed')[0] ?? '');
      if (expiry && expiry !== '9223372036854775807' && Number(BigInt(expiry) / 10000n) - 11644473600000 < Date.now()) {
        fail('532');
        return false;
      }
      setBound(e.dn);
      send(result(id, 0x61, 0));
      return false;
    }
    if (tag === 0x77) {
      r.readSequence(0x77);
      const oid = r.readString(0x80) ?? '';
      if (oid === STARTTLS && this.mode === 'starttls' && !(sock instanceof TLSSocket)) {
        this.startTlsCount++;
        send(result(id, 0x78, 0));
        return true;
      }
      send(result(id, 0x78, 2, 'unsupported extended operation'));
      return false;
    }
    if (tag === 0x63) {
      r.readSequence(0x63);
      const base = r.readString() ?? '';
      const scope = r.readEnumeration() ?? 2;
      r.readEnumeration();
      const sizeLimit = r.readInt() ?? 0;
      r.readInt();
      r.readBoolean();
      const filter = readFilter(r);
      r.readSequence();
      const attrEnd = r.offset + r.length;
      const wanted: string[] = [];
      while (r.offset < attrEnd) wanted.push(r.readString() ?? '');
      let paged: { size: number; cookie: string } | null = null;
      if (r.remain > 0 && r.peek() === 0xa0) {
        r.readSequence(0xa0);
        const cEnd = r.offset + r.length;
        while (r.offset < cEnd) {
          r.readSequence();
          const oneEnd = r.offset + r.length;
          const oid = r.readString() ?? '';
          if (r.peek() === 0x01) r.readBoolean();
          const value = r.offset < oneEnd ? r.readString(0x04, true) : null;
          if (oid === PAGED && value) {
            const v = new BerReader(value);
            v.readSequence();
            const size = v.readInt() ?? 0;
            const cookie = v.readString(0x04, true) ?? Buffer.alloc(0);
            paged = { size, cookie: cookie.toString('utf8') };
          }
          r.offset = oneEnd;
        }
      }
      this.searches.push({ base, paged: paged?.size ?? null, pageCookie: paged?.cookie ?? '' });
      // AD: a search needs a bind (anonymous is refused).
      if (!bound()) {
        send(result(id, 0x65, 1, '000004DC: LdapErr: DSID-0C090A5C, comment: In order to perform this operation a successful bind must be completed on the connection., data 0, v4563'));
        return false;
      }
      const under = [...this.entries.values()].filter((e) => {
        const dn = lc(e.dn);
        const b = lc(base);
        if (scope === 0) return dn === b;
        if (scope === 1) return dn.endsWith(',' + b) && dn.slice(0, -(b.length + 1)).split(',').length === 1;
        return dn === b || dn.endsWith(',' + b);
      });
      let found = under.filter((e) => this.matches(e, filter)).sort((a, b) => a.dn.localeCompare(b.dn));
      let controls: PagedResultsControl[] | undefined;
      if (paged && paged.size > 0) {
        const offset = paged.cookie ? Number(paged.cookie) : 0;
        const next = offset + paged.size;
        const page = found.slice(offset, next);
        this.pagesServed.push(page.length);
        controls = [new PagedResultsControl({ value: { size: found.length, cookie: next < found.length ? Buffer.from(String(next)) : Buffer.alloc(0) } })];
        found = page;
      } else if (sizeLimit > 0) found = found.slice(0, sizeLimit);
      for (const e of found) send(this.entryMessage(id, e, wanted));
      send(result(id, 0x65, 0, '', controls));
      return false;
    }
    send(result(id, 0x78, 2, 'unsupported operation'));
    return false;
  }

  private resolveBindName(name: string): string | null {
    if (this.entries.has(lc(name))) return lc(name);
    // AD accepts a userPrincipalName (or DOMAIN\sam) as the bind name.
    const sam = /\\(.+)$/.exec(name)?.[1];
    for (const e of this.entries.values()) {
      if (this.values(e, 'userPrincipalName').some((v) => lc(String(v)) === lc(name))) return lc(e.dn);
      if (sam && this.values(e, 'sAMAccountName').some((v) => lc(String(v)) === lc(sam))) return lc(e.dn);
    }
    return null;
  }

  private entryMessage(id: number, e: Entry, wanted: string[]): Buffer {
    const names = wanted.filter((w) => w && w !== 'dn' && w !== '*');
    const all = names.length === 0;
    const out: { name: string; values: Value[] }[] = [];
    if (all) for (const a of e.attrs.values()) out.push(a);
    else {
      for (const w of names) {
        // AD's range retrieval: `memberOf;range=a-*` asks for values from a; at most maxValRange come back.
        const ranged = /^memberof;range=(\d+)-(\d+|\*)$/i.exec(w);
        if (ranged || (lc(w) === 'memberof' && this.memberOf(e.dn).length > this.maxValRange)) {
          const every = this.memberOf(e.dn);
          const from = ranged ? Number(ranged[1]) : 0;
          if (ranged) this.rangeAsks.push(w);
          const slice = every.slice(from, from + this.maxValRange);
          const last = from + slice.length >= every.length;
          out.push({ name: `memberOf;range=${from}-${last ? '*' : from + slice.length - 1}`, values: slice });
          continue;
        }
        const values = this.values(e, w);
        if (!values.length) continue;
        out.push({ name: e.attrs.get(lc(w))?.name ?? (lc(w) === 'memberof' ? 'memberOf' : w), values });
      }
    }
    const w = new BerWriter();
    w.startSequence();
    w.writeInt(id);
    w.startSequence(0x64);
    w.writeString(e.dn);
    w.startSequence();
    for (const a of out) {
      w.startSequence();
      w.writeString(a.name);
      w.startSequence(0x31);
      for (const v of a.values) {
        if (Buffer.isBuffer(v)) w.writeBuffer(v, 0x04);
        else w.writeString(v);
      }
      w.endSequence();
      w.endSequence();
    }
    w.endSequence();
    w.endSequence();
    w.endSequence();
    return w.buffer;
  }
}

function result(id: number, tag: number, code: number, diag = '', controls?: PagedResultsControl[]): Buffer {
  const w = new BerWriter();
  w.startSequence();
  w.writeInt(id);
  w.startSequence(tag);
  w.writeEnumeration(code);
  w.writeString('');
  w.writeString(diag);
  w.endSequence();
  if (controls?.length) {
    w.startSequence(0xa0);
    for (const c of controls) c.write(w);
    w.endSequence();
  }
  w.endSequence();
  return w.buffer;
}

function readFilter(r: BerReader): Filter {
  const tag = r.peek();
  switch (tag) {
    case 0xa0:
    case 0xa1: {
      r.readSequence(tag);
      const end = r.offset + r.length;
      const fs: Filter[] = [];
      while (r.offset < end) fs.push(readFilter(r));
      return { op: tag === 0xa0 ? 'and' : 'or', fs };
    }
    case 0xa2:
      r.readSequence(tag);
      return { op: 'not', f: readFilter(r) };
    case 0xa3: {
      r.readSequence(tag);
      const a = r.readString() ?? '';
      const v = r.readString(0x04, true) ?? Buffer.alloc(0);
      return { op: 'eq', a, v };
    }
    case 0x87:
      return { op: 'present', a: r.readString(0x87) ?? '' };
    case 0xa4: {
      r.readSequence(tag);
      const a = r.readString() ?? '';
      r.readSequence();
      const end = r.offset + r.length;
      const f: Filter = { op: 'sub', a, any: [] };
      while (r.offset < end) {
        const t = r.peek()!;
        const v = r.readString(t) ?? '';
        if (t === 0x80) f.initial = v;
        else if (t === 0x81) f.any.push(v);
        else f.final = v;
      }
      return f;
    }
    case 0xa9: {
      r.readSequence(tag);
      const end = r.offset + r.length;
      let rule = '';
      let a = '';
      let v = '';
      while (r.offset < end) {
        const t = r.peek()!;
        if (t === 0x81) rule = r.readString(0x81) ?? '';
        else if (t === 0x82) a = r.readString(0x82) ?? '';
        else if (t === 0x83) v = r.readString(0x83) ?? '';
        else r.readString(t, true);
      }
      return { op: 'ext', a, rule, v };
    }
    default:
      throw new Error(`fake AD: filter tag 0x${(tag ?? 0).toString(16)} not supported`);
  }
}
