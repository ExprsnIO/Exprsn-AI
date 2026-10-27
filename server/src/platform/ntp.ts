import { createSocket } from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

/** Seconds between the NTP era (1900) and the Unix epoch (1970). */
const NTP_EPOCH_OFFSET = 2_208_988_800;

export interface SntpResult {
  server: string;
  /** How far this server's clock is from the NTP server's: positive means ours is behind. */
  offsetMs: number;
  /** Round-trip delay of the query, less the time the server held it. */
  delayMs: number;
  stratum: number;
  /** The server's reference identifier (a four-letter source for stratum 1, else the upstream address). */
  refId: string;
}

/** An NTP timestamp (seconds and fraction since 1900) as Unix milliseconds. */
export function readTimestamp(buf: Buffer, offset: number): number {
  const seconds = buf.readUInt32BE(offset);
  const fraction = buf.readUInt32BE(offset + 4);
  return (seconds - NTP_EPOCH_OFFSET) * 1000 + (fraction * 1000) / 2 ** 32;
}

export function writeTimestamp(buf: Buffer, offset: number, ms: number): void {
  const seconds = Math.floor(ms / 1000) + NTP_EPOCH_OFFSET;
  const fraction = Math.round(((ms % 1000) / 1000) * 2 ** 32);
  buf.writeUInt32BE(seconds >>> 0, offset);
  buf.writeUInt32BE(Math.min(fraction, 2 ** 32 - 1) >>> 0, offset + 4);
}

/** `host`, `host:port` or `[v6]:port`. */
export function parseNtpServer(spec: string): { host: string; port: number } {
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(spec);
  if (v6) return { host: v6[1]!, port: v6[2] ? Number(v6[2]) : 123 };
  if (isIP(spec) === 6) return { host: spec, port: 123 };
  const [host, port] = spec.split(':');
  return { host: host!, port: port ? Number(port) : 123 };
}

/**
 * One SNTP (RFC 4330) client query. The request carries a random transmit timestamp, and a reply is accepted only
 * when it echoes that value as its originate timestamp, comes from a server in mode 4 with a non-zero stratum
 * (stratum 0 is a kiss-o'-death) and a synchronised leap indicator. Offset and delay use the four timestamps.
 */
export function sntpQuery(spec: string, timeoutMs = 2000): Promise<SntpResult> {
  const { host, port } = parseNtpServer(spec);
  const socket = createSocket(isIP(host) === 6 ? 'udp6' : 'udp4');
  const req = Buffer.alloc(48);
  req[0] = (0 << 6) | (4 << 3) | 3; // LI 0, version 4, mode 3 (client)
  // The transmit timestamp is a nonce the server must echo; its value is not used for the arithmetic.
  randomBytes(8).copy(req, 40);
  const nonce = req.subarray(40, 48);
  return new Promise<SntpResult>((resolve, reject) => {
    let t1 = 0;
    const done = (err: Error | null, r?: SntpResult) => {
      clearTimeout(timer);
      socket.close();
      if (err) reject(err);
      else resolve(r!);
    };
    const timer = setTimeout(() => done(new Error(`No answer from ${spec} within ${timeoutMs} ms`)), timeoutMs);
    socket.on('error', (err) => done(err));
    socket.on('message', (msg) => {
      const t4 = Date.now();
      if (msg.length < 48) return;
      if (!msg.subarray(24, 32).equals(nonce)) return; // not an answer to this query
      const li = msg[0]! >> 6;
      const mode = msg[0]! & 7;
      const stratum = msg[1]!;
      if (mode !== 4) return done(new Error(`${spec} answered in mode ${mode}, not as a server`));
      if (stratum === 0) return done(new Error(`${spec} refused the query (kiss code ${msg.subarray(12, 16).toString('ascii')})`));
      if (li === 3) return done(new Error(`${spec} is not synchronised`));
      const t2 = readTimestamp(msg, 32);
      const t3 = readTimestamp(msg, 40);
      if (!t3) return done(new Error(`${spec} sent no transmit time`));
      const offsetMs = (t2 - t1 + (t3 - t4)) / 2;
      const delayMs = Math.max(0, t4 - t1 - (t3 - t2));
      const ref = msg.subarray(12, 16);
      const refId = stratum === 1 ? ref.toString('ascii').replace(/\0+$/, '') : [...ref].join('.');
      done(null, { server: spec, offsetMs: Math.round(offsetMs), delayMs: Math.round(delayMs), stratum, refId });
    });
    t1 = Date.now();
    socket.send(req, port, host, (err) => {
      if (err) done(err);
    });
  });
}

/** One server's answer in a quorum check. */
export interface NtpServerResult {
  server: string;
  offsetMs: number | null;
  delayMs: number | null;
  stratum: number | null;
  error: string | null;
  /** Further than the outlier limit from the median of the answers. */
  outlier: boolean;
}

export interface NtpQuorum {
  servers: NtpServerResult[];
  /** The median offset of the servers that answered (null when none did). */
  offsetMs: number | null;
  skewMs: number | null;
  /** The servers that disagree with the median. */
  outliers: string[];
  /** More than half of the servers answered and agree with the median. */
  quorum: boolean;
  /** Plain-language warning, or null when every server answered and agreed. */
  warning: string | null;
}

/** The median of some numbers (the mean of the middle two for an even count). */
export function median(values: number[]): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

/**
 * B-1406: asks several SNTP servers at once and reports the median offset. SNTP is unauthenticated, so one server
 * (or one spoofed answer) can lie; with three or more servers the median is the honest value as long as most of them
 * are honest, and the liar is named as an outlier. With two that disagree, nobody can tell which is right: both are
 * named and there is no quorum.
 */
export async function ntpQuorum(specs: string[], o: { timeoutMs: number; outlierMs: number }, query: (spec: string, timeoutMs: number) => Promise<SntpResult> = sntpQuery): Promise<NtpQuorum> {
  const answers = await Promise.all(
    specs.map(async (server) => {
      try {
        const r = await query(server, o.timeoutMs);
        return { server, offsetMs: r.offsetMs, delayMs: r.delayMs, stratum: r.stratum, error: null, outlier: false };
      } catch (err) {
        return { server, offsetMs: null, delayMs: null, stratum: null, error: (err as Error).message.slice(0, 200), outlier: false };
      }
    })
  );
  const ok = answers.filter((a) => a.offsetMs !== null);
  const mid = median(ok.map((a) => a.offsetMs!));
  if (mid === null) return { servers: answers, offsetMs: null, skewMs: null, outliers: [], quorum: false, warning: specs.length ? 'No NTP server answered.' : null };
  for (const a of ok) a.outlier = Math.abs(a.offsetMs! - mid) > o.outlierMs;
  let outliers = ok.filter((a) => a.outlier).map((a) => a.server);
  const agreeing = ok.length - outliers.length;
  // Two answers that disagree: the median is their mean, so neither is "the" outlier. Both are named.
  if (ok.length === 2 && Math.abs(ok[0]!.offsetMs! - ok[1]!.offsetMs!) > o.outlierMs) {
    for (const a of ok) a.outlier = true;
    outliers = ok.map((a) => a.server);
  }
  const honest = ok.filter((a) => !a.outlier).map((a) => a.offsetMs!);
  // The reported offset is the median of the agreeing servers (the median of all when nobody agrees).
  const offsetMs = Math.round(median(honest) ?? mid);
  const quorum = specs.length > 0 && agreeing * 2 > specs.length && !(ok.length === 2 && outliers.length === 2);
  const failed = answers.filter((a) => a.error).map((a) => a.server);
  const parts: string[] = [];
  if (outliers.length) parts.push(`${outliers.join(', ')} ${outliers.length === 1 ? 'disagrees' : 'disagree'} with the other servers by more than ${o.outlierMs} ms${ok.length === 2 ? '; with two servers it is not possible to tell which is right' : ' and ' + (outliers.length === 1 ? 'is' : 'are') + ' left out'}`);
  if (failed.length) parts.push(`${failed.join(', ')} did not answer`);
  if (!quorum && specs.length > 1) parts.push('no majority of servers agrees, so the skew is not trustworthy');
  return { servers: answers, offsetMs, skewMs: Math.abs(offsetMs), outliers, quorum, warning: parts.length ? parts.join('; ') + '.' : null };
}
