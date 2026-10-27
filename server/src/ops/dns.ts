import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { connect as tcpConnect, isIP } from 'node:net';
import { fetch as undiciFetch } from 'undici';
import type { Config } from '../config/index.js';
import { checkUrl, guardedAgent, parseAllowList } from '../mcp/hosts.js';

/**
 * ACME dns-01 (B-409). The CA looks up `_acme-challenge.<name>` and expects a TXT record holding
 * base64url(sha256(key authorization)) (RFC 8555 section 8.4). A DNS provider publishes and removes that record.
 */
export interface DnsProvider {
  readonly name: string;
  present(domain: string, value: string): Promise<void>;
  cleanup(domain: string, value: string): Promise<void>;
}

/** The TXT value for a key authorization. */
export const dns01Value = (keyAuthorization: string): string => createHash('sha256').update(keyAuthorization).digest('base64url');

/** `_acme-challenge.<name>`, with a wildcard's `*.` removed (the record is on the base name). */
export const challengeName = (domain: string): string => `_acme-challenge.${domain.replace(/^\*\./, '').replace(/\.$/, '')}`;

/**
 * An operator's hook: POSTs `{ action: present | cleanup, domain, fqdn, value }` to ACME_DNS_WEBHOOK_URL, signed with
 * HMAC-SHA256 over `<timestamp>.<body>` in `X-Exprsn-Signature: t=<timestamp>,v1=<hex>`. The hook updates whatever
 * DNS the site runs and answers 2xx once the record is in place.
 */
export class WebhookDnsProvider implements DnsProvider {
  readonly name: string;

  constructor(
    private readonly url: string,
    private readonly secret: string,
    private readonly allowedHosts: string,
    private readonly timeoutMs = 30_000
  ) {
    this.name = `webhook at ${new URL(url).host}`;
  }

  private async call(action: 'present' | 'cleanup', domain: string, value: string): Promise<void> {
    const allow = parseAllowList(this.allowedHosts);
    await checkUrl(this.url, allow);
    const body = JSON.stringify({ action, domain, fqdn: challengeName(domain), value });
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', this.secret).update(`${t}.${body}`).digest('hex');
    const agent = guardedAgent(allow, this.timeoutMs);
    try {
      const res = await undiciFetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-exprsn-signature': `t=${t},v1=${sig}` }, body, dispatcher: agent, signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error' });
      const text = await res.text();
      if (!res.ok) throw new Error(`The DNS hook answered ${res.status} to ${action} for ${domain}${text ? `: ${text.slice(0, 200)}` : ''}`);
    } finally {
      await agent.close().catch(() => undefined);
    }
  }

  present(domain: string, value: string): Promise<void> {
    return this.call('present', domain, value);
  }

  cleanup(domain: string, value: string): Promise<void> {
    return this.call('cleanup', domain, value);
  }
}

/** Checks the webhook signature (for hook implementers and the tests). */
export function verifyWebhookSignature(secret: string, header: string, body: string, maxAgeS = 300, now = Date.now()): boolean {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!m) return false;
  if (Math.abs(now / 1000 - Number(m[1])) > maxAgeS) return false;
  const want = createHmac('sha256', secret).update(`${m[1]}.${body}`).digest();
  return timingSafeEqual(want, Buffer.from(m[2]!, 'hex'));
}

// ---------- RFC 2136 dynamic update with TSIG (RFC 8945) ----------

const TYPE_TXT = 16;
const TYPE_SOA = 6;
const TYPE_TSIG = 250;
const CLASS_IN = 1;
const CLASS_NONE = 254;
const CLASS_ANY = 255;
const OPCODE_UPDATE = 5;
const RCODES = ['NOERROR', 'FORMERR', 'SERVFAIL', 'NXDOMAIN', 'NOTIMP', 'REFUSED', 'YXDOMAIN', 'YXRRSET', 'NXRRSET', 'NOTAUTH', 'NOTZONE'];
const TSIG_ERRORS: Record<number, string> = { 16: 'BADSIG', 17: 'BADKEY', 18: 'BADTIME', 22: 'BADTRUNC' };

/** A domain name in wire format, lower-cased (canonical, as TSIG needs). */
export function encodeName(name: string): Buffer {
  const labels = name.replace(/\.$/, '').toLowerCase().split('.').filter(Boolean);
  const parts: Buffer[] = [];
  for (const l of labels) {
    const b = Buffer.from(l, 'ascii');
    if (!b.length || b.length > 63) throw new Error(`Invalid DNS label in ${name}`);
    parts.push(Buffer.from([b.length]), b);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

/** Reads a (possibly compressed) name at `offset`; returns it and the offset after it. */
export function decodeName(msg: Buffer, offset: number): { name: string; next: number } {
  const labels: string[] = [];
  let pos = offset;
  let next = -1;
  for (let guard = 0; guard < 128; guard++) {
    const len = msg[pos]!;
    if (len === 0) {
      pos++;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (next < 0) next = pos + 2;
      pos = ((len & 0x3f) << 8) | msg[pos + 1]!;
      continue;
    }
    labels.push(msg.subarray(pos + 1, pos + 1 + len).toString('ascii'));
    pos += 1 + len;
  }
  return { name: labels.join('.').toLowerCase(), next: next < 0 ? pos : next };
}

const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const u48 = (n: number) => {
  const b = Buffer.alloc(6);
  b.writeUIntBE(n, 0, 6);
  return b;
};

function rr(name: string, type: number, cls: number, ttl: number, rdata: Buffer): Buffer {
  return Buffer.concat([encodeName(name), u16(type), u16(cls), u32(ttl), u16(rdata.length), rdata]);
}

const txtRdata = (value: string): Buffer => {
  const b = Buffer.from(value, 'utf8');
  if (b.length > 255) throw new Error('TXT value too long');
  return Buffer.concat([Buffer.from([b.length]), b]);
};

/** The TSIG variables that are MACed after the message (RFC 8945 section 4.3.3). */
function tsigVariables(keyName: string, algorithm: string, timeSigned: number, fudge: number, error: number, other: Buffer): Buffer {
  return Buffer.concat([encodeName(keyName), u16(CLASS_ANY), u32(0), encodeName(algorithm), u48(timeSigned), u16(fudge), u16(error), u16(other.length), other]);
}

export interface TsigKey {
  name: string;
  algorithm: 'hmac-sha256' | 'hmac-sha512';
  /** The shared secret, base64 (as in a BIND key file). */
  secret: string;
}

const hmacAlg = (a: TsigKey['algorithm']) => (a === 'hmac-sha512' ? 'sha512' : 'sha256');

/**
 * Signs a message: appends the TSIG record and bumps ARCOUNT. Returns the signed message and its MAC. A response is
 * signed with the request's MAC prefixed (`requestMac`), as a server does.
 */
export function signTsig(msg: Buffer, key: TsigKey, now = Date.now(), fudge = 300, requestMac?: Buffer): { signed: Buffer; mac: Buffer } {
  const id = msg.readUInt16BE(0);
  const timeSigned = Math.floor(now / 1000);
  const prefix = requestMac ? Buffer.concat([u16(requestMac.length), requestMac]) : Buffer.alloc(0);
  const mac = createHmac(hmacAlg(key.algorithm), Buffer.from(key.secret, 'base64')).update(Buffer.concat([prefix, msg, tsigVariables(key.name, key.algorithm, timeSigned, fudge, 0, Buffer.alloc(0))])).digest();
  const rdata = Buffer.concat([encodeName(key.algorithm), u48(timeSigned), u16(fudge), u16(mac.length), mac, u16(id), u16(0), u16(0)]);
  const signed = Buffer.concat([msg, rr(key.name, TYPE_TSIG, CLASS_ANY, 0, rdata)]);
  signed.writeUInt16BE(msg.readUInt16BE(10) + 1, 10);
  return { signed, mac };
}

export interface ParsedTsig {
  keyName: string;
  algorithm: string;
  timeSigned: number;
  fudge: number;
  mac: Buffer;
  originalId: number;
  error: number;
  other: Buffer;
  /** Offset of the TSIG record: the message without it is `msg.subarray(0, start)` with ARCOUNT less one. */
  start: number;
}

/** Skips a resource record, returning the offset after it and its type, class and rdata. */
function readRr(msg: Buffer, offset: number): { name: string; type: number; cls: number; ttl: number; rdata: Buffer; next: number } {
  const n = decodeName(msg, offset);
  const type = msg.readUInt16BE(n.next);
  const cls = msg.readUInt16BE(n.next + 2);
  const ttl = msg.readUInt32BE(n.next + 4);
  const len = msg.readUInt16BE(n.next + 8);
  const rdata = msg.subarray(n.next + 10, n.next + 10 + len);
  return { name: n.name, type, cls, ttl, rdata, next: n.next + 10 + len };
}

export interface ParsedMessage {
  id: number;
  flags: number;
  opcode: number;
  rcode: number;
  zone: { name: string; type: number; cls: number }[];
  /** The answer section (the prerequisite section of an UPDATE). */
  answers: { name: string; type: number; cls: number; ttl: number; rdata: Buffer }[];
  /** The authority section (the update section of an UPDATE). */
  updates: { name: string; type: number; cls: number; ttl: number; rdata: Buffer }[];
  additional: { name: string; type: number; cls: number; ttl: number; rdata: Buffer; start: number }[];
}

/** Parses a DNS message's sections (enough for UPDATE requests and responses). */
export function parseMessage(msg: Buffer): ParsedMessage {
  const id = msg.readUInt16BE(0);
  const flags = msg.readUInt16BE(2);
  const counts = [4, 6, 8, 10].map((o) => msg.readUInt16BE(o));
  let pos = 12;
  const zone: ParsedMessage['zone'] = [];
  for (let i = 0; i < counts[0]!; i++) {
    const n = decodeName(msg, pos);
    zone.push({ name: n.name, type: msg.readUInt16BE(n.next), cls: msg.readUInt16BE(n.next + 2) });
    pos = n.next + 4;
  }
  const answers: ParsedMessage['answers'] = [];
  for (let i = 0; i < counts[1]!; i++) {
    const r = readRr(msg, pos);
    answers.push(r);
    pos = r.next;
  }
  const updates: ParsedMessage['updates'] = [];
  for (let i = 0; i < counts[2]!; i++) {
    const r = readRr(msg, pos);
    updates.push(r);
    pos = r.next;
  }
  const additional: ParsedMessage['additional'] = [];
  for (let i = 0; i < counts[3]!; i++) {
    const start = pos;
    const r = readRr(msg, pos);
    additional.push({ ...r, start });
    pos = r.next;
  }
  return { id, flags, opcode: (flags >> 11) & 0xf, rcode: flags & 0xf, zone, answers, updates, additional };
}

export function parseTsig(msg: Buffer): ParsedTsig | null {
  const m = parseMessage(msg);
  const t = m.additional[m.additional.length - 1];
  if (!t || t.type !== TYPE_TSIG) return null;
  const alg = decodeName(t.rdata, 0);
  let p = alg.next;
  const timeSigned = t.rdata.readUIntBE(p, 6);
  const fudge = t.rdata.readUInt16BE(p + 6);
  const macLen = t.rdata.readUInt16BE(p + 8);
  const mac = t.rdata.subarray(p + 10, p + 10 + macLen);
  p += 10 + macLen;
  const originalId = t.rdata.readUInt16BE(p);
  const error = t.rdata.readUInt16BE(p + 2);
  const otherLen = t.rdata.readUInt16BE(p + 4);
  return { keyName: t.name, algorithm: alg.name, timeSigned, fudge, mac, originalId, error, other: t.rdata.subarray(p + 6, p + 6 + otherLen), start: t.start };
}

/**
 * Verifies a TSIG-signed message. For a response, pass the request's MAC: it is prefixed (with its length) to what
 * is MACed, binding the answer to the question.
 */
export function verifyTsig(msg: Buffer, key: TsigKey, requestMac?: Buffer, now = Date.now()): { ok: boolean; reason?: string } {
  const t = parseTsig(msg);
  if (!t) return { ok: false, reason: 'unsigned' };
  if (t.keyName !== key.name.replace(/\.$/, '').toLowerCase()) return { ok: false, reason: 'BADKEY' };
  if (t.algorithm !== key.algorithm) return { ok: false, reason: 'BADKEY' };
  const body = Buffer.from(msg.subarray(0, t.start));
  body.writeUInt16BE(body.readUInt16BE(10) - 1, 10);
  body.writeUInt16BE(t.originalId, 0);
  const prefix = requestMac ? Buffer.concat([u16(requestMac.length), requestMac]) : Buffer.alloc(0);
  const want = createHmac(hmacAlg(key.algorithm), Buffer.from(key.secret, 'base64')).update(Buffer.concat([prefix, body, tsigVariables(t.keyName, t.algorithm, t.timeSigned, t.fudge, t.error, t.other)])).digest();
  if (want.length !== t.mac.length || !timingSafeEqual(want, t.mac)) return { ok: false, reason: 'BADSIG' };
  if (Math.abs(now / 1000 - t.timeSigned) > t.fudge) return { ok: false, reason: 'BADTIME' };
  return { ok: true };
}

/** An UPDATE message adding (or deleting) one TXT record, unsigned. */
export function buildTxtUpdate(o: { id: number; zone: string; name: string; value: string; ttl: number; remove: boolean }): Buffer {
  const header = Buffer.concat([u16(o.id), u16(OPCODE_UPDATE << 11), u16(1), u16(0), u16(1), u16(0)]);
  const zone = Buffer.concat([encodeName(o.zone), u16(TYPE_SOA), u16(CLASS_IN)]);
  // Delete one RR from an RRset: class NONE, TTL 0, the exact rdata (RFC 2136 section 2.5.4).
  const update = o.remove ? rr(o.name, TYPE_TXT, CLASS_NONE, 0, txtRdata(o.value)) : rr(o.name, TYPE_TXT, CLASS_IN, o.ttl, txtRdata(o.value));
  return Buffer.concat([header, zone, update]);
}

/** B-904: a plain query (one question, no recursion wanted), e.g. for the SOA that names a record's zone. */
export function buildQuery(o: { id: number; name: string; type: number }): Buffer {
  return Buffer.concat([u16(o.id), u16(0), u16(1), u16(0), u16(0), u16(0), encodeName(o.name), u16(o.type), u16(CLASS_IN)]);
}

export const DNS_TYPE_SOA = TYPE_SOA;

/** The zone apex from an SOA answer, or from the SOA in the authority section of a referral or NXDOMAIN answer. */
export function soaOwner(msg: ParsedMessage): string | null {
  return (msg.answers.find((r) => r.type === TYPE_SOA) ?? msg.updates.find((r) => r.type === TYPE_SOA))?.name ?? null;
}

/** Frames a message for DNS over TCP (RFC 1035 section 4.2.2: a two-byte length first). */
export const tcpFrame = (msg: Buffer): Buffer => Buffer.concat([u16(msg.length), msg]);

export const txtValue = (rdata: Buffer): string => {
  const parts: string[] = [];
  for (let p = 0; p < rdata.length; ) {
    const n = rdata[p]!;
    parts.push(rdata.subarray(p + 1, p + 1 + n).toString('utf8'));
    p += 1 + n;
  }
  return parts.join('');
};

/**
 * RFC 2136 dynamic update to the zone's primary, signed with a TSIG key; the answer's TSIG is checked too. Sprint 18
 * (B-904): over UDP with a fallback to TCP when the answer is truncated or UDP gets no answer (or TCP only, or UDP
 * only), and the zone found from the SOA record when it is not configured.
 */
export class Rfc2136DnsProvider implements DnsProvider {
  readonly name: string;
  private readonly host: string;
  private readonly port: number;
  private readonly zones = new Map<string, string>();

  constructor(
    server: string,
    private readonly zone: string | null,
    private readonly key: TsigKey,
    private readonly timeoutMs = 5000,
    private readonly ttl = 60,
    private readonly transport: 'auto' | 'udp' | 'tcp' = 'auto'
  ) {
    const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(server);
    if (v6) {
      this.host = v6[1]!;
      this.port = v6[2] ? Number(v6[2]) : 53;
    } else if (isIP(server) === 6) {
      this.host = server;
      this.port = 53;
    } else {
      const [h, p] = server.split(':');
      this.host = h!;
      this.port = p ? Number(p) : 53;
    }
    this.name = `RFC 2136 at ${server} (${zone ? `zone ${zone.replace(/\.$/, '')}` : 'zone from SOA'}, ${transport === 'auto' ? 'UDP with TCP fallback' : transport.toUpperCase()})`;
  }

  private sendUdp(msg: Buffer): Promise<Buffer> {
    const socket = createSocket(isIP(this.host) === 6 ? 'udp6' : 'udp4');
    const id = msg.readUInt16BE(0);
    return new Promise<Buffer>((resolve, reject) => {
      const done = (err: Error | null, r?: Buffer) => {
        clearTimeout(timer);
        socket.close();
        if (err) reject(err);
        else resolve(r!);
      };
      const timer = setTimeout(() => done(new Error(`No answer from the DNS server ${this.host}:${this.port} within ${this.timeoutMs} ms`)), this.timeoutMs);
      socket.on('error', (err) => done(err));
      socket.on('message', (m) => {
        if (m.length >= 12 && m.readUInt16BE(0) === id) done(null, m);
      });
      socket.send(msg, this.port, this.host, (err) => {
        if (err) done(err);
      });
    });
  }

  private sendTcp(msg: Buffer): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const sock = tcpConnect({ host: this.host, port: this.port });
      let buf = Buffer.alloc(0);
      const done = (err: Error | null, r?: Buffer) => {
        clearTimeout(timer);
        sock.destroy();
        if (err) reject(err);
        else resolve(r!);
      };
      const timer = setTimeout(() => done(new Error(`No answer over TCP from the DNS server ${this.host}:${this.port} within ${this.timeoutMs} ms`)), this.timeoutMs);
      sock.on('error', (err) => done(err));
      sock.on('connect', () => sock.write(tcpFrame(msg)));
      sock.on('data', (c: Buffer) => {
        buf = Buffer.concat([buf, c]);
        if (buf.length > 65_537) return done(new Error('The DNS answer over TCP is too long.'));
        if (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) done(null, buf.subarray(2, 2 + buf.readUInt16BE(0)));
      });
      sock.on('end', () => done(new Error('The DNS server closed the TCP connection without an answer.')));
    });
  }

  /** One exchange over the configured transport; `auto` retries over TCP on a truncated answer or no UDP answer. */
  async exchange(msg: Buffer): Promise<{ answer: Buffer; transport: 'udp' | 'tcp' }> {
    if (this.transport === 'tcp') return { answer: await this.sendTcp(msg), transport: 'tcp' };
    let answer: Buffer;
    try {
      answer = await this.sendUdp(msg);
    } catch (err) {
      if (this.transport === 'udp') throw err;
      return { answer: await this.sendTcp(msg), transport: 'tcp' };
    }
    const truncated = (answer.readUInt16BE(2) & 0x0200) !== 0;
    if (truncated && this.transport === 'auto') return { answer: await this.sendTcp(msg), transport: 'tcp' };
    return { answer, transport: 'udp' };
  }

  /** The zone that holds `name`: the configured one, or the owner of the SOA the server answers with. */
  async zoneFor(name: string): Promise<string> {
    if (this.zone) return this.zone.replace(/\.$/, '').toLowerCase();
    const cached = this.zones.get(name);
    if (cached) return cached;
    const { answer } = await this.exchange(buildQuery({ id: randomBytes(2).readUInt16BE(0), name, type: TYPE_SOA }));
    const owner = soaOwner(parseMessage(answer));
    if (!owner) throw new Error(`The DNS server did not name the zone of ${name} (no SOA in its answer); set ACME_DNS_RFC2136_ZONE.`);
    this.zones.set(name, owner);
    return owner;
  }

  private async update(domain: string, value: string, remove: boolean): Promise<void> {
    const name = challengeName(domain);
    const zone = await this.zoneFor(name);
    if (name !== zone && !name.endsWith(`.${zone}`)) throw new Error(`${name} is not inside the zone ${zone} (ACME_DNS_RFC2136_ZONE).`);
    const msg = buildTxtUpdate({ id: randomBytes(2).readUInt16BE(0), zone, name, value, ttl: this.ttl, remove });
    const { signed, mac } = signTsig(msg, this.key);
    const { answer: res } = await this.exchange(signed);
    const parsed = parseMessage(res);
    const tsig = parseTsig(res);
    if (tsig?.error) throw new Error(`The DNS server refused the update: TSIG ${TSIG_ERRORS[tsig.error] ?? tsig.error}.`);
    if (parsed.rcode !== 0) throw new Error(`The DNS server refused the update of ${name}: ${RCODES[parsed.rcode] ?? parsed.rcode}.`);
    const v = verifyTsig(res, this.key, mac);
    if (!v.ok) throw new Error(`The DNS server's answer is not signed with the TSIG key (${v.reason}).`);
  }

  present(domain: string, value: string): Promise<void> {
    return this.update(domain, value, false);
  }

  cleanup(domain: string, value: string): Promise<void> {
    return this.update(domain, value, true);
  }
}

export function createDnsProvider(cfg: Config): DnsProvider | null {
  if (cfg.ACME_DNS_PROVIDER === 'webhook' && cfg.ACME_DNS_WEBHOOK_URL && cfg.ACME_DNS_WEBHOOK_SECRET) return new WebhookDnsProvider(cfg.ACME_DNS_WEBHOOK_URL, cfg.ACME_DNS_WEBHOOK_SECRET, cfg.PLATFORM_ALLOWED_HOSTS);
  if (cfg.ACME_DNS_PROVIDER === 'rfc2136' && cfg.ACME_DNS_RFC2136_SERVER && cfg.ACME_DNS_TSIG_NAME && cfg.ACME_DNS_TSIG_SECRET) {
    return new Rfc2136DnsProvider(cfg.ACME_DNS_RFC2136_SERVER, cfg.ACME_DNS_RFC2136_ZONE ?? null, { name: cfg.ACME_DNS_TSIG_NAME, algorithm: cfg.ACME_DNS_TSIG_ALGORITHM, secret: cfg.ACME_DNS_TSIG_SECRET }, 5000, 60, cfg.ACME_DNS_RFC2136_TRANSPORT);
  }
  return null;
}
