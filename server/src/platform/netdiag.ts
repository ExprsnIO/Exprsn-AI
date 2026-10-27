import { Resolver } from 'node:dns/promises';
import { connect, BlockList, isIP, type Socket } from 'node:net';
import { lookup as dnsLookup } from 'node:dns';
import { isMetadataAddress } from './metadata.js';

/*
 * 1.7.0 (B-NET): the building blocks for the network diagnostic tools (`registry/builtin/net-diagnostics.ts`):
 *
 * - `resolveRecords`: every DNS record type for a name, or the reverse (PTR) for an address, over the system
 *   resolver. Read-only: a DNS query goes to the resolver, not to the host, so there is no outbound-address concern.
 * - `whois`: a WHOIS query over TCP port 43, starting at IANA for the referral and following it to the registry and
 *   then the registrar, each connection refused if the WHOIS server resolves to an internal or metadata address
 *   (WHOIS servers are public infrastructure; a crafted referral must not point the query at an internal host).
 * - `tcpScan`: a TCP connect scan of one host. The caller checks the target against the outbound-address guard
 *   first (`toolAddressProblem`), exactly as the HTTP tools do, so a scan only reaches hosts the tenant's list of
 *   allowed hosts or the operator's policy already admits — never an arbitrary public host.
 *
 * Everything here is bounded: record types are a fixed set, WHOIS follows at most two referrals and caps the reply,
 * the scan caps the number of ports, the per-connection timeout and the concurrency.
 */

// ---------- DNS ----------

/** The record types a lookup of a name returns, in the order they are reported. */
export const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'SOA', 'TXT', 'SRV', 'CAA', 'NAPTR'] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export interface DnsRecord {
  type: string;
  value: string;
  /** The structured answer for a record that is more than a string (MX, SOA, SRV, CAA). */
  data?: Record<string, unknown>;
}

export interface DnsResult {
  name: string;
  /** Set when the input was an address: the names it reverses to. */
  reverse?: string[];
  records: DnsRecord[];
  /** Record types that returned no answer (not an error, just empty). */
  empty: string[];
  /** The resolver(s) asked. */
  servers: string[];
}

const flat = (v: unknown): string => (Array.isArray(v) ? v.join(' ') : String(v));

/** One resolver answer turned into the reported records; the structured parts kept for the richer types. */
function toRecords(type: RecordType, answers: unknown[]): DnsRecord[] {
  return answers.map((a): DnsRecord => {
    switch (type) {
      case 'MX': {
        const m = a as { priority: number; exchange: string };
        return { type, value: `${m.priority} ${m.exchange}`, data: { priority: m.priority, exchange: m.exchange } };
      }
      case 'SOA': {
        const s = a as Record<string, unknown>;
        return { type, value: `${s.nsname} ${s.hostmaster} ${s.serial} ${s.refresh} ${s.retry} ${s.expire} ${s.minttl}`, data: s };
      }
      case 'SRV': {
        const s = a as { priority: number; weight: number; port: number; name: string };
        return { type, value: `${s.priority} ${s.weight} ${s.port} ${s.name}`, data: { ...s } };
      }
      case 'CAA': {
        const s = a as Record<string, unknown>;
        const kv = Object.entries(s).find(([k]) => k !== 'critical');
        return { type, value: `${s.critical ?? 0} ${kv ? `${kv[0]} "${kv[1]}"` : ''}`.trim(), data: s };
      }
      case 'TXT':
        return { type, value: flat(a) };
      case 'NAPTR':
        return { type, value: flat(Object.values(a as Record<string, unknown>)), data: a as Record<string, unknown> };
      default:
        return { type, value: String(a) };
    }
  });
}

/**
 * Every record type for a name, or the reverse of an address. `servers` overrides the system resolvers (each must
 * be an IP). Errors for a single type that just mean "no such record" are folded into `empty`, not thrown.
 */
export async function resolveRecords(input: string, opts: { servers?: string[]; types?: RecordType[] } = {}): Promise<DnsResult> {
  const name = input.trim().replace(/\.$/, '');
  if (!name) throw new Error('Give a domain name or an address.');
  const resolver = new Resolver({ timeout: 5000, tries: 2 });
  if (opts.servers?.length) {
    for (const srv of opts.servers) if (!isIP(srv)) throw new Error(`A DNS server must be an address, not ${srv}.`);
    resolver.setServers(opts.servers);
  }
  const servers = resolver.getServers();

  if (isIP(name)) {
    let reverse: string[];
    try {
      reverse = await resolver.reverse(name);
    } catch {
      reverse = [];
    }
    return { name, reverse, records: reverse.map((v) => ({ type: 'PTR', value: v })), empty: reverse.length ? [] : ['PTR'], servers };
  }

  const types = opts.types?.length ? opts.types : RECORD_TYPES;
  const records: DnsRecord[] = [];
  const empty: string[] = [];
  await Promise.all(
    types.map(async (type) => {
      try {
        const answers = (await resolver.resolve(name, type)) as unknown[];
        if (answers.length) records.push(...toRecords(type, answers));
        else empty.push(type);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENODATA' || code === 'ENOTFOUND' || code === 'NOTIMP') empty.push(type);
        else throw new Error(`${type}: ${code ?? (err as Error).message}`, { cause: err });
      }
    })
  );
  const order = new Map(RECORD_TYPES.map((t, i) => [t as string, i]));
  records.sort((a, b) => (order.get(a.type)! - order.get(b.type)!) || a.value.localeCompare(b.value));
  return { name, records, empty: empty.sort(), servers };
}

// ---------- not-public guard (WHOIS servers must be reachable on the public internet) ----------

const notPublic = new BlockList();
notPublic.addSubnet('10.0.0.0', 8, 'ipv4');
notPublic.addSubnet('172.16.0.0', 12, 'ipv4');
notPublic.addSubnet('192.168.0.0', 16, 'ipv4');
notPublic.addSubnet('127.0.0.0', 8, 'ipv4');
notPublic.addSubnet('100.64.0.0', 10, 'ipv4');
notPublic.addSubnet('169.254.0.0', 16, 'ipv4');
notPublic.addSubnet('0.0.0.0', 8, 'ipv4');
notPublic.addSubnet('224.0.0.0', 4, 'ipv4');
notPublic.addAddress('255.255.255.255', 'ipv4');
notPublic.addSubnet('fc00::', 7, 'ipv6');
notPublic.addSubnet('fe80::', 10, 'ipv6');
notPublic.addSubnet('ff00::', 8, 'ipv6');
notPublic.addAddress('::1', 'ipv6');
notPublic.addAddress('::', 'ipv6');

const mappedV4 = (ip: string): string => /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1] ?? ip;
const famOf = (ip: string): 'ipv4' | 'ipv6' => (isIP(ip) === 6 ? 'ipv6' : 'ipv4');

/** Resolve a host and keep only its public addresses, refusing a server that lives only on an internal address. */
async function publicAddress(host: string): Promise<string> {
  const addresses = isIP(host)
    ? [host]
    : await new Promise<string[]>((resolve, reject) =>
        dnsLookup(host, { all: true, verbatim: true }, (err, list) => (err ? reject(new Error(`${host} does not resolve.`)) : resolve(list.map((x) => x.address))))
      );
  // B-10705: never a cloud metadata address (168.63.129.16 and 192.0.0.192 are outside the ranges above).
  const first = addresses.map((a) => mappedV4(a)).find((a) => !notPublic.check(a, famOf(a)) && !isMetadataAddress(a));
  if (!first) throw new Error(`${host} resolves only to an internal address and is not a public WHOIS server.`);
  return first;
}

// ---------- WHOIS ----------

export interface WhoisHop {
  server: string;
  query: string;
  text: string;
}

export interface WhoisResult {
  query: string;
  hops: WhoisHop[];
  /** The last, most specific reply. */
  text: string;
  fields: Record<string, string>;
}

const WHOIS_PORT = 43;
const WHOIS_MAX_BYTES = 128 * 1024;

/** One WHOIS request over port 43; the host is checked to be public before the connection opens. */
async function whoisQuery(server: string, query: string, timeoutMs: number): Promise<string> {
  const address = await publicAddress(server);
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const sock = connect({ host: address, port: WHOIS_PORT });
    sock.setTimeout(timeoutMs);
    // Send the query but do not half-close: some servers (whois.iana.org) answer nothing to a client FIN, and the
    // server closes the connection once it has sent the record, which ends the read.
    sock.once('connect', () => sock.write(`${query}\r\n`));
    sock.on('data', (c: Buffer) => {
      size += c.length;
      if (size > WHOIS_MAX_BYTES) {
        sock.destroy();
        resolve(Buffer.concat(chunks).toString('utf8'));
        return;
      }
      chunks.push(c);
    });
    sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    sock.on('timeout', () => {
      sock.destroy();
      reject(new Error(`${server} did not answer within ${timeoutMs} ms.`));
    });
    sock.on('error', (err) => reject(new Error(`${server}: ${(err as Error).message}`)));
  });
}

/** The referral WHOIS server named in a reply, if any (the registry's `refer:`/`whois:`, a registrar's server). */
function referralServer(text: string): string | null {
  const patterns = [/^\s*refer:\s*(\S+)/im, /whois server:\s*(\S+)/i, /^\s*whois:\s*(\S+)/im, /registrar whois server:\s*(\S+)/i];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m?.[1]) return m[1].trim().replace(/\.$/, '').toLowerCase();
  }
  return null;
}

/** The common fields out of a WHOIS reply, names normalised to lower case with spaces. */
function parseFields(text: string): Record<string, string> {
  const want = new Map<string, string>([
    ['registrar', 'registrar'],
    ['registrant', 'registrant'],
    ['registrant organization', 'registrant organization'],
    ['registrant country', 'registrant country'],
    ['creation date', 'created'],
    ['created', 'created'],
    ['registered on', 'created'],
    ['registry expiry date', 'expires'],
    ['expiry date', 'expires'],
    ['expires on', 'expires'],
    ['updated date', 'updated'],
    ['last updated', 'updated'],
    ['registrar iana id', 'registrar iana id'],
    ['registrar abuse contact email', 'registrar abuse email'],
    ['name server', 'name servers'],
    ['nserver', 'name servers'],
    ['dnssec', 'dnssec'],
    ['org', 'org'],
    ['orgname', 'org'],
    ['netname', 'netname'],
    ['cidr', 'cidr'],
    ['inetnum', 'inetnum'],
    ['netrange', 'netrange'],
    ['country', 'country']
  ]);
  const out: Record<string, string> = {};
  const multi = new Set(['name servers', 'domain status', 'status']);
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z][A-Za-z0-9 /_-]*?)\s*:\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const raw = m[1]!.toLowerCase();
    const key = want.get(raw) ?? (/^(domain )?status$/.test(raw) ? 'status' : null);
    if (!key) continue;
    const value = m[2]!;
    if (multi.has(key)) out[key] = out[key] ? `${out[key]}, ${value}` : value;
    else if (!(key in out)) out[key] = value;
  }
  return out;
}

/**
 * A WHOIS lookup for a domain or an address: IANA first for the referral, then the registry, then one registrar
 * referral, each connection refused unless the WHOIS server is public. At most three hops.
 */
export async function whois(query: string, opts: { server?: string; timeoutMs?: number } = {}): Promise<WhoisResult> {
  const q = query.trim().replace(/\.$/, '');
  if (!q) throw new Error('Give a domain or an address to look up.');
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 10_000, 1000), 30_000);
  const hops: WhoisHop[] = [];
  const asked = new Set<string>();
  let server = (opts.server ?? 'whois.iana.org').toLowerCase();
  // IANA wants the address or the TLD, not the full domain, for the first hop.
  let ask = opts.server ? q : isIP(q) ? q : (q.split('.').pop() ?? q);

  for (let hop = 0; hop < 3; hop++) {
    if (asked.has(`${server}|${ask}`)) break;
    asked.add(`${server}|${ask}`);
    const text = await whoisQuery(server, ask, timeoutMs);
    hops.push({ server, query: ask, text });
    const next = referralServer(text);
    if (!next || next === server) break;
    server = next;
    ask = q; // from the registry on, the full domain
  }
  const last = hops[hops.length - 1];
  return { query: q, hops, text: last?.text ?? '', fields: parseFields(hops.map((h) => h.text).join('\n')) };
}

// ---------- TCP connect scan ----------

export interface PortResult {
  port: number;
  state: 'open' | 'closed' | 'filtered';
  service?: string;
  latencyMs: number;
  /** A short, printable first line of a banner, when the service sent one on connect. */
  banner?: string;
}

/** Well-known services for the common ports, for a readable result (not a protocol probe). */
const SERVICES: Record<number, string> = {
  20: 'ftp-data', 21: 'ftp', 22: 'ssh', 23: 'telnet', 25: 'smtp', 53: 'domain', 80: 'http', 110: 'pop3', 111: 'rpcbind',
  119: 'nntp', 123: 'ntp', 135: 'msrpc', 139: 'netbios-ssn', 143: 'imap', 161: 'snmp', 389: 'ldap', 443: 'https',
  445: 'microsoft-ds', 465: 'smtps', 514: 'syslog', 587: 'submission', 631: 'ipp', 636: 'ldaps', 993: 'imaps',
  995: 'pop3s', 1025: 'nfs', 1433: 'ms-sql', 1521: 'oracle', 1723: 'pptp', 2049: 'nfs', 2082: 'cpanel', 2375: 'docker',
  2376: 'docker-s', 3000: 'http-alt', 3306: 'mysql', 3389: 'ms-wbt', 5000: 'http-alt', 5432: 'postgresql',
  5672: 'amqp', 5900: 'vnc', 5984: 'couchdb', 6379: 'redis', 7001: 'weblogic', 8000: 'http-alt', 8080: 'http-proxy',
  8081: 'http-alt', 8086: 'influxdb', 8091: 'http-alt', 8443: 'https-alt', 8500: 'consul', 9000: 'http-alt',
  9092: 'kafka', 9200: 'elasticsearch', 9300: 'elasticsearch', 11211: 'memcached', 15672: 'rabbitmq-mgmt',
  27017: 'mongodb', 5601: 'kibana', 6443: 'kube-apiserver'
};

/** The default ports a scan covers when none are given: common internet and service ports. */
export const DEFAULT_PORTS = [21, 22, 25, 53, 80, 110, 143, 389, 443, 445, 465, 587, 993, 995, 3306, 3389, 5432, 6379, 8080, 8443];
export const MAX_PORTS = 1024;

/** Parse a ports argument: an array of numbers, or a string such as "22,80,443,8000-8010". Capped and de-duplicated. */
export function parsePorts(input: unknown): number[] {
  if (input == null) return DEFAULT_PORTS;
  const tokens: string[] = Array.isArray(input) ? input.map(String) : String(input).split(',');
  const ports = new Set<number>();
  for (const tok of tokens) {
    const t = tok.trim();
    if (!t) continue;
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(t);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 1 || hi > 65535 || hi < lo) throw new Error(`"${t}" is not a port range between 1 and 65535.`);
      if (hi - lo + 1 > MAX_PORTS) throw new Error(`The range ${t} has more than ${MAX_PORTS} ports.`);
      for (let p = lo; p <= hi; p++) ports.add(p);
    } else {
      const p = Number(t);
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`"${t}" is not a port between 1 and 65535.`);
      ports.add(p);
    }
    if (ports.size > MAX_PORTS) throw new Error(`A scan covers at most ${MAX_PORTS} ports in one call.`);
  }
  if (!ports.size) throw new Error('No ports to scan.');
  return [...ports].sort((a, b) => a - b);
}

/** One TCP connect attempt; `banner` is true to read a short greeting the service may send on connect. */
function probe(address: string, port: number, timeoutMs: number, wantBanner: boolean): Promise<PortResult> {
  return new Promise<PortResult>((resolve) => {
    const t0 = Date.now();
    const service = SERVICES[port];
    const base = service ? { service } : {};
    let sock: Socket;
    const done = (r: Omit<PortResult, 'port' | 'latencyMs'>) => {
      sock.destroy();
      resolve({ port, latencyMs: Date.now() - t0, ...base, ...r });
    };
    try {
      sock = connect({ host: address, port });
    } catch {
      resolve({ port, state: 'filtered', latencyMs: 0, ...base });
      return;
    }
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => {
      if (!wantBanner) {
        done({ state: 'open' });
        return;
      }
      const chunks: Buffer[] = [];
      sock.setTimeout(Math.min(timeoutMs, 750));
      const finish = () => {
        const line = Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0]?.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 120);
        done({ state: 'open', ...(line ? { banner: line } : {}) });
      };
      sock.on('data', (c: Buffer) => {
        chunks.push(c);
        if (Buffer.concat(chunks).length >= 256) finish();
      });
      sock.once('timeout', finish);
      sock.once('end', finish);
    });
    sock.once('timeout', () => done({ state: 'filtered' }));
    sock.once('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      done({ state: code === 'ECONNREFUSED' ? 'closed' : 'filtered' });
    });
  });
}

export interface ScanResult {
  host: string;
  address: string;
  ports: PortResult[];
  open: number[];
  elapsedMs: number;
}

/**
 * A TCP connect scan of one address (already resolved and checked by the caller against the outbound-address guard).
 * Ports are probed with a bounded concurrency; `banner` reads a short greeting from the ports that answer with one.
 */
export async function tcpScan(host: string, address: string, ports: number[], opts: { timeoutMs?: number; concurrency?: number; banner?: boolean } = {}): Promise<ScanResult> {
  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 2000, 100), 10_000);
  const concurrency = Math.min(Math.max(opts.concurrency ?? 64, 1), 256);
  const banner = opts.banner === true;
  const t0 = Date.now();
  const results: PortResult[] = new Array(ports.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, ports.length) }, async () => {
      for (let i = next++; i < ports.length; i = next++) results[i] = await probe(address, ports[i]!, timeoutMs, banner);
    })
  );
  return { host, address, ports: results, open: results.filter((r) => r.state === 'open').map((r) => r.port), elapsedMs: Date.now() - t0 };
}
