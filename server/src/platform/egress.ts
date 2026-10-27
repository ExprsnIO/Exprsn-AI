import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as http2Connect, constants as h2c, type ClientHttp2Session, type IncomingHttpHeaders, type OutgoingHttpHeaders } from 'node:http2';
import { BlockList, isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { Agent, fetch as undiciFetch } from 'undici';
import { parseAllowList, type AllowList } from '../mcp/hosts.js';
import { isMetadataAddress as isMeta, metadataProblem, metadataUrlProblem } from './metadata.js';

/*
 * Operator-chosen service URLs (B-901, ASVS 12.6): pool instances, zone endpoints, image backends, the training
 * worker (connections go through their own internal-only check in `mcp/hosts.ts`). Unlike MCP servers or webhooks,
 * these are commonly on loopback or a private network, so those ranges are the normal case and stay allowed. What
 * is refused:
 *
 * - cloud metadata addresses and names (`platform/metadata.ts`: 169.254.169.254, 169.254.170.2, fd00:ec2::254,
 *   100.100.100.200, 192.0.0.192, 168.63.129.16, metadata.google.internal, and their IPv6 spellings), always, whatever
 *   an allow-list names (B-10705);
 * - the rest of link-local (169.254.0.0/16, fe80::/10), unless `SERVICE_ALLOWED_HOSTS` names the host or network;
 * - unspecified, multicast and broadcast addresses, always;
 * - public addresses only when `SERVICE_INTERNAL_ONLY` is on and the allow-list does not name them.
 *
 * The check runs when an operator saves the URL and again inside the DNS lookup of every connection (the dispatcher
 * below), so a name that later resolves to a metadata address is refused at connect time: the address dialled is
 * the address checked.
 */

const LINK_LOCAL = new BlockList();
LINK_LOCAL.addSubnet('169.254.0.0', 16, 'ipv4');
LINK_LOCAL.addSubnet('fe80::', 10, 'ipv6');

const NEVER = new BlockList();
NEVER.addSubnet('0.0.0.0', 8, 'ipv4');
NEVER.addSubnet('224.0.0.0', 4, 'ipv4');
NEVER.addAddress('255.255.255.255', 'ipv4');
NEVER.addSubnet('ff00::', 8, 'ipv6');
NEVER.addAddress('::', 'ipv6');

const PRIVATE = new BlockList();
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE.addSubnet('100.64.0.0', 10, 'ipv4');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');
PRIVATE.addAddress('::1', 'ipv6');

export interface ServicePolicy {
  allow: AllowList;
  /** Public addresses need the allow-list too. */
  internalOnly: boolean;
}

const policies = new Map<string, ServicePolicy>();

/** The policy from `SERVICE_ALLOWED_HOSTS` and `SERVICE_INTERNAL_ONLY` (cached per setting). */
export function servicePolicy(cfg: { SERVICE_ALLOWED_HOSTS?: string; SERVICE_INTERNAL_ONLY?: boolean } = {}): ServicePolicy {
  const spec = cfg.SERVICE_ALLOWED_HOSTS ?? '';
  const internalOnly = cfg.SERVICE_INTERNAL_ONLY ?? false;
  const key = `${internalOnly ? 1 : 0}|${spec}`;
  let p = policies.get(key);
  if (!p) policies.set(key, (p = { allow: parseAllowList(spec), internalOnly }));
  return p;
}

const v4 = (ip: string): string => /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1] ?? ip;
const fam = (ip: string): 'ipv4' | 'ipv6' => (isIP(ip) === 6 ? 'ipv6' : 'ipv4');
const named = (host: string, allow: AllowList) => allow.hosts.some((h) => (h.startsWith('*.') ? host.endsWith(h.slice(1)) : host === h));

/** True for the cloud metadata addresses, which no operator setting admits (B-10705: `platform/metadata.ts`). */
export function isMetadataAddress(ip: string): boolean {
  return isMeta(ip);
}

export { isMetadataHost, metadataProblem, metadataUrlProblem } from './metadata.js';

/** Why a service may not be reached at this address, or null when it may. */
export function serviceAddressProblem(ip: string, host: string, policy: ServicePolicy): string | null {
  const addr = v4(ip);
  const f = fam(addr);
  const shown = host === addr ? addr : `${host} resolves to ${addr}, which`;
  const meta = metadataProblem(host, ip);
  if (meta) return meta;
  if (NEVER.check(addr, f)) return `${shown} is an unspecified, multicast or broadcast address.`;
  const allowed = named(host, policy.allow) || policy.allow.networks.check(addr, f);
  if (LINK_LOCAL.check(addr, f)) return allowed ? null : `${shown} is a link-local address. Name it in SERVICE_ALLOWED_HOSTS if the service really lives there.`;
  if (PRIVATE.check(addr, f) || allowed || !policy.internalOnly) return null;
  return `${shown} is a public address. With SERVICE_INTERNAL_ONLY on, only internal hosts and those in SERVICE_ALLOWED_HOSTS are accepted.`;
}

export class ServiceUrlRefused extends Error {}

const resolveAll = (host: string): Promise<string[]> =>
  new Promise((resolve, reject) => dnsLookup(host, { all: true, verbatim: true }, (err, list) => (err ? reject(new ServiceUrlRefused(`${host} does not resolve: ${err.code ?? err.message}.`)) : resolve(list.map((x) => x.address)))));

/** Resolves a host (or takes an address literal) and checks every address; throws ServiceUrlRefused. */
export async function checkServiceHost(hostname: string, policy: ServicePolicy): Promise<{ host: string; addresses: string[] }> {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw new ServiceUrlRefused('The address has no host.');
  const meta = metadataProblem(host);
  if (meta) throw new ServiceUrlRefused(meta);
  const addresses = isIP(host) ? [host] : await resolveAll(host);
  if (!addresses.length) throw new ServiceUrlRefused(`${host} does not resolve.`);
  for (const a of addresses) {
    const p = serviceAddressProblem(a, host, policy);
    if (p) throw new ServiceUrlRefused(p);
  }
  return { host, addresses };
}

/**
 * Checks a service URL when an operator saves it. A name that does not resolve yet is accepted (the service may not
 * be up), because every connection re-checks the address it dials; an address literal is checked at once.
 */
export async function checkServiceUrl(raw: string, policy: ServicePolicy, o: { protocols?: string[]; requireResolve?: boolean } = {}): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ServiceUrlRefused('The address is not a URL.');
  }
  const protocols = o.protocols ?? ['http:', 'https:'];
  if (!protocols.includes(url.protocol)) throw new ServiceUrlRefused(`The address must start with ${protocols.map((p) => `${p}//`).join(' or ')}.`);
  if (url.username || url.password) throw new ServiceUrlRefused('Credentials do not belong in the URL.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  try {
    await checkServiceHost(host, policy);
  } catch (err) {
    if (!o.requireResolve && !isIP(host) && /does not resolve/.test((err as Error).message)) return;
    throw err;
  }
}

/** The problem with a URL's host when it is an address literal (these never reach a DNS lookup), else null. */
export function literalProblem(raw: string, policy: ServicePolicy): string | null {
  let host: string;
  try {
    host = new URL(raw).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return 'The address is not a URL.';
  }
  // B-10705: a metadata service's name is refused before anything resolves it, like an address literal.
  return isIP(host) ? serviceAddressProblem(host, host, policy) : metadataProblem(host);
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** A DNS lookup for `net.connect`/undici that refuses addresses the policy refuses (pinning: dial what was checked). */
export function serviceLookup(policy: ServicePolicy) {
  return (hostname: string, options: { all?: boolean; family?: number } & Record<string, unknown>, cb: LookupCb) => {
    const meta = metadataProblem(hostname.toLowerCase()) ?? offlineCloudProblem(hostname);
    if (meta) return queueMicrotask(() => cb(Object.assign(new ServiceUrlRefused(meta), { code: 'EREFUSED' }), '', 0));
    dnsLookup(hostname, { ...options, all: true, verbatim: true }, (err, list) => {
      if (err) return cb(err, '', 0);
      for (const a of list) {
        const p = serviceAddressProblem(a.address, hostname.toLowerCase(), policy);
        if (p) return cb(Object.assign(new ServiceUrlRefused(p), { code: 'EREFUSED' }), '', 0);
      }
      if (options.all) return cb(null, list);
      const first = list[0];
      if (!first) return cb(Object.assign(new Error(`${hostname} does not resolve`), { code: 'ENOTFOUND' }), '', 0);
      cb(null, first.address, first.family);
    });
  };
}

/**
 * An undici dispatcher for an operator-chosen service: every connection's DNS lookup is checked against the policy
 * (address literals are checked by the caller with `literalProblem`, since they skip the lookup). Extra connect
 * options (a CA, a client certificate) pass through.
 */
export function serviceAgent(policy: ServicePolicy, connect: Record<string, unknown> = {}, timeouts: { headersTimeout?: number; bodyTimeout?: number } = {}): Agent {
  return new Agent({ connect: { ...connect, lookup: serviceLookup(policy) as never }, ...timeouts });
}

// ---------- 1.9.99-final (B-10705): metadata refusal for the calls that have no policy of their own ----------

/*
 * Some outbound calls go to a URL only the operator sets and so had no address check at all: the OpenBao address,
 * the S3 endpoint, the Stripe API base, the HIBP range API, the legacy SIEM URL, the ACME directory, the image safety
 * classifier, the in-cluster Kubernetes API, SAML metadata by URL. None of them may reach a metadata service either.
 * They keep every other address they reached before (loopback and private networks included); only metadata names
 * and addresses are refused, by name before the request and by address inside the connection's DNS lookup.
 */

/** A DNS lookup that refuses metadata names and every metadata address a name resolves to; nothing else changes. */
export function metadataLookup() {
  return (hostname: string, options: { all?: boolean; family?: number } & Record<string, unknown>, cb: LookupCb) => {
    const host = hostname.toLowerCase();
    const meta = metadataProblem(host);
    if (meta) return queueMicrotask(() => cb(Object.assign(new ServiceUrlRefused(meta), { code: 'EREFUSED' }), '', 0));
    dnsLookup(hostname, { ...options, all: true, verbatim: true }, (err, list) => {
      if (err) return cb(err, '', 0);
      for (const a of list) {
        const p = metadataProblem(host, a.address);
        if (p) return cb(Object.assign(new ServiceUrlRefused(p), { code: 'EREFUSED' }), '', 0);
      }
      if (options.all) return cb(null, list);
      const first = list[0];
      if (!first) return cb(Object.assign(new Error(`${hostname} does not resolve`), { code: 'ENOTFOUND' }), '', 0);
      cb(null, first.address, first.family);
    });
  };
}

/** An undici dispatcher that refuses metadata names and addresses (connect options such as a CA pass through). */
export function metadataSafeAgent(connect: Record<string, unknown> = {}, timeouts: { headersTimeout?: number; bodyTimeout?: number } = {}): Agent {
  return new Agent({ connect: { ...connect, lookup: metadataLookup() as never }, ...timeouts });
}

let sharedSafeAgent: Agent | null = null;
/** One shared metadata-refusing dispatcher for calls that used the global one. */
export function metadataSafeDispatcher(): Agent {
  return (sharedSafeAgent ??= metadataSafeAgent());
}

/** Throws ServiceUrlRefused when a URL's host is a metadata name or address literal (literals skip the lookup). */
export function assertNotMetadataUrl(raw: string | URL): void {
  const p = metadataUrlProblem(raw);
  if (p) throw new ServiceUrlRefused(p);
}

/**
 * `fetch` for an operator-set URL: refuses a metadata host before the request and a metadata address at connect time.
 * A caller's own dispatcher is kept only when it is a metadata-safe one (`metadataSafeAgent`, `serviceAgent`,
 * `guardedAgent`); pass `connect` options (a CA) to get one.
 */
export async function metadataSafeFetch(url: string | URL, init: RequestInit & { dispatcher?: unknown } = {}): Promise<Response> {
  assertNotMetadataUrl(url);
  // 1.9.99-final, Sprint 61 (B-10906): tests never reach a real object store either (an R2 or S3 endpoint without its fake).
  const offline = offlineCloudProblem(new URL(String(url)).hostname);
  if (offline) throw new ServiceUrlRefused(offline);
  // undici's own fetch: an Agent from the undici package does not plug into Node's bundled fetch.
  return (await undiciFetch(url, { ...init, dispatcher: init.dispatcher ?? metadataSafeDispatcher() } as never)) as unknown as Response;
}

// ---------- 1.6.0 (B-8902): outbound calls of HTTP tools ----------

/**
 * True for an address on the public internet: not cloud metadata, not unspecified, multicast or broadcast, not
 * link-local, and not private, loopback or carrier-grade NAT. Workflow HTTP steps (B-9101) reach such an address
 * only through the tenant's list of allowed hosts.
 */
export function isPublicAddress(ip: string): boolean {
  const addr = v4(ip);
  const f = fam(addr);
  return !isMeta(ip) && !NEVER.check(addr, f) && !LINK_LOCAL.check(addr, f) && !PRIVATE.check(addr, f);
}

/**
 * Why an HTTP tool may not reach this address, or null when it may. Cloud metadata, unspecified, multicast and
 * broadcast addresses are always refused; link-local, private and loopback addresses only when the operator's
 * service allow-list (`SERVICE_ALLOWED_HOSTS`) names the host or network; public addresses only when the tenant's list
 * of allowed hosts names the host (or a network holding the address). A tenant's list never admits an internal host.
 */
export function toolAddressProblem(ip: string, host: string, policy: ServicePolicy, tenant: AllowList | null): string | null {
  const addr = v4(ip);
  const f = fam(addr);
  const shown = host === addr ? addr : `${host} resolves to ${addr}, which`;
  const meta = metadataProblem(host, ip);
  if (meta) return meta;
  if (NEVER.check(addr, f)) return `${shown} is an unspecified, multicast or broadcast address.`;
  const operator = named(host, policy.allow) || policy.allow.networks.check(addr, f);
  if (LINK_LOCAL.check(addr, f) || PRIVATE.check(addr, f)) return operator ? null : `${shown} is an internal address. HTTP tools reach internal hosts only when the operator names them in SERVICE_ALLOWED_HOSTS.`;
  if (tenant && !tenant.empty && (named(host, tenant) || tenant.networks.check(addr, f))) return null;
  return `${shown} is a public address that is not on this tenant's list of allowed hosts. A tenant admin adds it under Registry, Allowed hosts.`;
}

export interface GuardedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  /** 1.9.0 (B-151): bytes too (an encrypted Web Push payload). */
  body?: string | Buffer;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
  /** Why an address is refused (null: allowed); every address the host resolves to is checked. */
  check: (address: string, host: string) => string | null;
  /** 1.9.99-final (B-10203): the trust anchors for an https host with a private CA (a Kubernetes cluster's API). */
  ca?: string | Buffer;
}

export interface GuardedResponse {
  status: number;
  contentType: string | null;
  body: Buffer;
  /** The address dialled (the one that was checked). */
  address: string;
  /** The response headers, names in lower case (a repeated header joined with ", "). */
  headers: Record<string, string>;
}

/**
 * One request through the outbound address guard: the host is resolved once, every address is checked, the
 * connection is pinned to the checked address (a second DNS answer cannot point elsewhere), redirects are not
 * followed (a 3xx comes back as it is), and the answer is capped. Throws ServiceUrlRefused when refused.
 */
export async function guardedRequest(r: GuardedRequest): Promise<GuardedResponse> {
  const { ordered, target, family } = await checkedTarget(r);
  return new Promise<GuardedResponse>((resolve, reject) => {
    const send = r.url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(
      r.url,
      {
        method: r.method,
        headers: { 'user-agent': 'exprsn-ai-tool', ...r.headers, ...(r.body != null ? { 'content-length': String(Buffer.byteLength(r.body)) } : {}) },
        // Dial the address that was checked, whatever the name resolves to now.
        lookup: (_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => (opts?.all ? cb(null, ordered.map((x) => ({ address: x, family: isIP(x) === 6 ? 6 : 4 }))) : cb(null, target, family)),
        timeout: r.timeoutMs,
        ...(r.signal ? { signal: r.signal } : {}),
        ...(r.ca && r.url.protocol === 'https:' ? { ca: r.ca } : {})
      } as never,
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let tooLarge: ServiceUrlRefused | null = null;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > r.maxBytes) {
            // Refused here, and the request torn down without an error: destroyed with one, the error was emitted
            // again on an object with no listener under full-suite load (an uncaught exception in
            // rest-connections.test.ts, QA-1). A capped answer is still never handed on cut short.
            if (!tooLarge) {
              tooLarge = new ServiceUrlRefused(`The answer is larger than ${Math.round(r.maxBytes / 1024)} KB.`);
              reject(tooLarge);
              res.destroy();
              req.destroy();
            }
            return;
          }
          chunks.push(c);
        });
        // A capped answer is refused, never handed on cut short (the end can arrive before the destroy's error).
        res.on('end', () => (tooLarge ? reject(tooLarge) : resolve({ status: res.statusCode ?? 0, contentType: (res.headers['content-type'] as string | undefined) ?? null, body: Buffer.concat(chunks), address: target, headers: responseHeaders(res.headers) })));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new ServiceUrlRefused(`No answer within ${r.timeoutMs} ms.`)));
    req.on('error', (err) => reject(err));
    if (r.body != null) req.write(r.body);
    req.end();
  });
}

const responseHeaders = (h: Record<string, string | string[] | undefined>): Record<string, string> => Object.fromEntries(Object.entries(h).filter(([, v]) => v != null).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]));

/** 1.9.99-final (B-10501): a streamed answer: the status and headers at once, the body as it arrives. */
export interface GuardedStream extends Omit<GuardedResponse, 'body'> {
  /** The body's chunks as they arrive, capped at `maxBytes` in all (over it, the iteration throws). Read it once. */
  body: AsyncIterable<Buffer>;
  /** Reads what is left of the body into one buffer (for an error answer), capped as `guardedRequest` caps it. */
  collect(): Promise<Buffer>;
  /** Tears the connection down (a reader that stops early). */
  abort(): void;
}

/**
 * `guardedRequest` for an answer read as it arrives (Bedrock's ConverseStream): the same checks (resolved once, every
 * address checked, pinned, no redirects, capped), but the promise settles with the status and headers, and the body is
 * an async iterable. `timeoutMs` is the idle time allowed between chunks, as for `guardedRequest`.
 */
export async function guardedStream(r: GuardedRequest): Promise<GuardedStream> {
  const { ordered, target, family } = await checkedTarget(r);
  return new Promise<GuardedStream>((resolve, reject) => {
    const send = r.url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(
      r.url,
      {
        method: r.method,
        headers: { 'user-agent': 'exprsn-ai-tool', ...r.headers, ...(r.body != null ? { 'content-length': String(Buffer.byteLength(r.body)) } : {}) },
        lookup: (_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => (opts?.all ? cb(null, ordered.map((x) => ({ address: x, family: isIP(x) === 6 ? 6 : 4 }))) : cb(null, target, family)),
        timeout: r.timeoutMs,
        ...(r.signal ? { signal: r.signal } : {}),
        ...(r.ca && r.url.protocol === 'https:' ? { ca: r.ca } : {})
      } as never,
      (res) => {
        let size = 0;
        let read = false;
        const body = (async function* () {
          read = true;
          for await (const c of res as AsyncIterable<Buffer>) {
            size += c.length;
            if (size > r.maxBytes) {
              res.destroy();
              req.destroy();
              throw new ServiceUrlRefused(`The answer is larger than ${Math.round(r.maxBytes / 1024)} KB.`);
            }
            yield c;
          }
        })();
        resolve({
          status: res.statusCode ?? 0,
          contentType: (res.headers['content-type'] as string | undefined) ?? null,
          address: target,
          headers: responseHeaders(res.headers),
          body,
          collect: async () => {
            if (read) return Buffer.alloc(0);
            const chunks: Buffer[] = [];
            for await (const c of body) chunks.push(c);
            return Buffer.concat(chunks);
          },
          abort: () => {
            res.destroy();
            req.destroy();
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new ServiceUrlRefused(`No answer within ${r.timeoutMs} ms.`)));
    req.on('error', (err) => reject(err));
    if (r.body != null) req.write(r.body);
    req.end();
  });
}

/** What `guardedRequest` and `guardedStream` check before dialling: the URL, the offline rule, every address. */
async function checkedTarget(r: GuardedRequest): Promise<{ ordered: string[]; target: string; family: 4 | 6 }> {
  if (r.url.protocol !== 'http:' && r.url.protocol !== 'https:') throw new ServiceUrlRefused('Only http:// and https:// are allowed.');
  if (r.url.username || r.url.password) throw new ServiceUrlRefused('Credentials do not belong in the URL.');
  const host = r.url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  // Tests run offline (EXPRSN_TESTS_OFFLINE, set by the Vitest setup and the e2e server): a real cloud provider host is
  // refused before it is even resolved, so an adapter with a missing fake endpoint fails loudly instead of calling out.
  if (process.env.EXPRSN_TESTS_OFFLINE === '1' && Object.values(CLOUD_PROVIDER_HOSTS).some((p) => hostMatches(host, p))) throw new ServiceUrlRefused(`real cloud host blocked in tests: ${host} (point the adapter at its fake)`);
  // B-10705: a metadata name or address is refused whatever the caller's check allows (an operator's allow-list too).
  const meta = metadataProblem(host);
  if (meta) throw new ServiceUrlRefused(meta);
  const addresses = isIP(host) ? [host] : await resolveAll(host);
  if (!addresses.length) throw new ServiceUrlRefused(`${host} does not resolve.`);
  for (const a of addresses) {
    const p = metadataProblem(host, a) ?? r.check(a, host);
    if (p) throw new ServiceUrlRefused(p);
  }
  // IPv4 first (a host without an IPv6 route would wait out the timeout on an AAAA answer); with `all`, every checked
  // address is offered so Node's family selection can fall back from one to the next.
  const ordered = [...addresses.filter((x) => isIP(x) === 4), ...addresses.filter((x) => isIP(x) !== 4)];
  const target = ordered[0]!;
  const family: 4 | 6 = isIP(target) === 6 ? 6 : 4;
  return { ordered, target, family };
}

// ---------- 1.9.0 (B-151, B-152): HTTP/2 through the same guard ----------

/*
 * APNs speaks only HTTP/2, and FCM's HTTP v1 API is best used over one multiplexed connection, so push delivery needs
 * `node:http2`. Rather than open those sessions beside the guard, this is the guard's HTTP/2 path, with the same
 * steps as `guardedRequest`: the host is resolved once, every address is checked by the caller's `check`, and the TLS
 * socket is dialled to the checked address (the name only goes into SNI and certificate verification), so a later
 * DNS answer cannot move the session. Only `https:` (ALPN `h2`); no cleartext h2c. Each request on the session is
 * capped (size and time) by `guardedHttp2Request`, and redirects are never followed (HTTP/2 push is refused).
 */

export interface GuardedHttp2Connect {
  /** The origin: `https://host[:port]`. */
  url: URL;
  check: (address: string, host: string) => string | null;
  connectTimeoutMs: number;
  /** Extra trust anchors (tests) and a client certificate (APNs certificate auth). */
  ca?: string | Buffer;
  cert?: string | Buffer;
  key?: string | Buffer;
}

/** Opens one HTTP/2 session to a checked, pinned address. Throws ServiceUrlRefused when the host is refused. */
export async function guardedHttp2Connect(o: GuardedHttp2Connect): Promise<{ session: ClientHttp2Session; address: string }> {
  if (o.url.protocol !== 'https:') throw new ServiceUrlRefused('HTTP/2 connections are made to https:// only.');
  if (o.url.username || o.url.password) throw new ServiceUrlRefused('Credentials do not belong in the URL.');
  const host = o.url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const meta = metadataProblem(host);
  if (meta) throw new ServiceUrlRefused(meta);
  const addresses = isIP(host) ? [host] : await resolveAll(host);
  if (!addresses.length) throw new ServiceUrlRefused(`${host} does not resolve.`);
  for (const a of addresses) {
    const p = metadataProblem(host, a) ?? o.check(a, host);
    if (p) throw new ServiceUrlRefused(p);
  }
  const port = Number(o.url.port || 443);
  // Every address was checked; dial them in order until one answers (an IPv6 loopback with nothing listening, say).
  let last: unknown = null;
  for (const target of addresses) {
    try {
      return { session: await dialHttp2(o, host, target, port), address: target };
    } catch (err) {
      last = err;
      if (err instanceof ServiceUrlRefused || !/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EADDRNOTAVAIL/.test(String((err as { code?: string }).code ?? ''))) throw err;
    }
  }
  throw last as Error;
}

function dialHttp2(o: GuardedHttp2Connect, host: string, target: string, port: number): Promise<ClientHttp2Session> {
  return new Promise((resolve, reject) => {
    const session = http2Connect(o.url.origin, {
      // Dial the checked address; the name is only the TLS server name.
      createConnection: () => tlsConnect({ host: target, port, ...(isIP(host) ? {} : { servername: host }), ALPNProtocols: ['h2'], ...(o.ca ? { ca: o.ca } : {}), ...(o.cert ? { cert: o.cert } : {}), ...(o.key ? { key: o.key } : {}) }),
      settings: { enablePush: false }
    });
    const timer = setTimeout(() => {
      session.destroy();
      reject(new ServiceUrlRefused(`No HTTP/2 connection to ${host} within ${o.connectTimeoutMs} ms.`));
    }, o.connectTimeoutMs);
    timer.unref();
    const onError = (err: Error) => {
      clearTimeout(timer);
      reject(err);
    };
    session.once('error', onError);
    session.once('connect', () => {
      clearTimeout(timer);
      session.removeListener('error', onError);
      // An error after connecting closes the session; its pool sees 'close'.
      session.on('error', () => undefined);
      resolve(session);
    });
  });
}

export interface GuardedHttp2Request {
  method: string;
  /** Path and query, starting with /. */
  path: string;
  headers: Record<string, string>;
  body?: string | Buffer;
  timeoutMs: number;
  maxBytes: number;
}

/** One request on a guarded session, its answer capped in size and time. */
export function guardedHttp2Request(session: ClientHttp2Session, r: GuardedHttp2Request): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    if (session.closed || session.destroyed) return reject(new Error('The HTTP/2 session is closed.'));
    const headers: OutgoingHttpHeaders = { ...r.headers, [h2c.HTTP2_HEADER_METHOD]: r.method, [h2c.HTTP2_HEADER_PATH]: r.path };
    if (r.body != null) headers['content-length'] = String(Buffer.byteLength(r.body));
    let stream: ReturnType<ClientHttp2Session['request']>;
    try {
      stream = session.request(headers, { endStream: r.body == null });
    } catch (err) {
      return reject(err as Error);
    }
    let status = 0;
    let got: Record<string, string> = {};
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const fail = (err: Error) => {
      if (done) return;
      done = true;
      stream.close(h2c.NGHTTP2_CANCEL);
      reject(err);
    };
    stream.setTimeout(r.timeoutMs, () => fail(new ServiceUrlRefused(`No answer within ${r.timeoutMs} ms.`)));
    stream.on('response', (h: IncomingHttpHeaders) => {
      status = Number(h[h2c.HTTP2_HEADER_STATUS] ?? 0);
      got = Object.fromEntries(Object.entries(h).filter(([k, v]) => !k.startsWith(':') && v != null).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v)]));
    });
    stream.on('data', (c: Buffer) => {
      size += c.length;
      if (size > r.maxBytes) return fail(new ServiceUrlRefused(`The answer is larger than ${Math.round(r.maxBytes / 1024)} KB.`));
      chunks.push(c);
    });
    stream.on('end', () => {
      if (done) return;
      done = true;
      resolve({ status, headers: got, body: Buffer.concat(chunks) });
    });
    stream.on('error', (err) => fail(err));
    stream.on('close', () => fail(new Error(`The HTTP/2 stream closed before its answer (code ${stream.rstCode ?? 0}).`)));
    if (r.body != null) stream.end(r.body);
  });
}

// ---------- 1.9.99-final (B-10101): the cloud providers' endpoints ----------

/**
 * The hosts each cloud provider's API answers on. The provider adapters (`cloud/providers/`) reach only these (or a
 * host the operator names in SERVICE_ALLOWED_HOSTS, such as a VPC endpoint or a test fake), and only at a public
 * address unless the operator names the host or its network.
 */
export const CLOUD_PROVIDER_HOSTS: Record<'aws' | 'azure' | 'digitalocean' | 'cloudflare', readonly string[]> = {
  aws: ['*.amazonaws.com', '*.amazonaws.com.cn', '*.api.aws'],
  // prices.azure.com: the Retail Prices API the price catalogue reads (1.9.99-final, B-10601; no credential is sent).
  // *.azmk8s.io and *.k8s.ondigitalocean.com: the API servers of the AKS and DOKS clusters a deployment made (1.9.99-final, B-10203).
  // *.documents.azure.com: the Cosmos DB for NoSQL data plane (1.9.99-final, B-10304); listed so tests refuse it offline.
  // 1.9.99-final, Sprint 60 (B-10502): Azure OpenAI and AI Foundry data planes (*.openai.azure.com, *.cognitiveservices.azure.com, *.services.ai.azure.com).
  azure: ['*.openai.azure.com', '*.cognitiveservices.azure.com', '*.services.ai.azure.com', 'management.azure.com', 'login.microsoftonline.com', 'graph.microsoft.com', '*.blob.core.windows.net', '*.vault.azure.net', 'management.usgovcloudapi.net', 'management.chinacloudapi.cn', 'prices.azure.com', '*.azmk8s.io', '*.documents.azure.com'],
  // 1.9.99-final, Sprint 60 (B-10503): GenAI serverless inference and agent endpoints.
  digitalocean: ['inference.do-ai.run', '*.agents.do-ai.run', '*.do-ai.run', 'api.digitalocean.com', '*.digitaloceanspaces.com', '*.k8s.ondigitalocean.com'],
  // 1.9.99-final, Sprint 61 (B-10905, B-10908): AI Gateway's proxy and Workers' own hostnames, listed so tests refuse them offline.
  // Sprint 61 (B-10904): an Access team's signing keys (<team>.cloudflareaccess.com/cdn-cgi/access/certs).
  cloudflare: ['api.cloudflare.com', '*.r2.cloudflarestorage.com', 'gateway.ai.cloudflare.com', '*.workers.dev', '*.cloudflareaccess.com']
};

const hostMatches = (host: string, patterns: readonly string[]) => patterns.some((h) => (h.startsWith('*.') ? host.endsWith(h.slice(1)) : host === h));

/**
 * Tests run offline (EXPRSN_TESTS_OFFLINE): why a real cloud provider host may not be dialled, or null. Used by
 * `guardedRequest` and (1.9.99-final, Sprint 60) by `serviceLookup`, which the Chat Completions client's dispatcher
 * uses, so a cloud model endpoint without its fake fails loudly instead of calling out.
 */
export function offlineCloudProblem(host: string): string | null {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (process.env.EXPRSN_TESTS_OFFLINE === '1' && Object.values(CLOUD_PROVIDER_HOSTS).some((p) => hostMatches(h, p))) return `real cloud host blocked in tests: ${h} (point the adapter at its fake)`;
  return null;
}

/**
 * Why a cloud adapter may not call this address, or null when it may. Cloud metadata, unspecified, multicast and
 * broadcast addresses are always refused (an operator setting cannot admit them). The host must be one of the
 * provider's API hosts or named in SERVICE_ALLOWED_HOSTS; and link-local, private and loopback addresses are refused
 * unless SERVICE_ALLOWED_HOSTS names the host or the network, so a provider name that resolves inward is refused at
 * connect time.
 */
export function cloudAddressProblem(ip: string, host: string, policy: ServicePolicy, providerHosts: readonly string[]): string | null {
  const addr = v4(ip);
  const f = fam(addr);
  const shown = host === addr ? addr : `${host} resolves to ${addr}, which`;
  const meta = metadataProblem(host, ip);
  if (meta) return meta;
  if (NEVER.check(addr, f)) return `${shown} is an unspecified, multicast or broadcast address.`;
  const operator = named(host, policy.allow) || policy.allow.networks.check(addr, f);
  if (!operator && !hostMatches(host, providerHosts)) return `${host} is not one of this provider's API hosts. Name it in SERVICE_ALLOWED_HOSTS if it really is one (a private endpoint).`;
  if ((LINK_LOCAL.check(addr, f) || PRIVATE.check(addr, f)) && !operator) return `${shown} is an internal address. A cloud API is reached at an internal address only when SERVICE_ALLOWED_HOSTS names the host or its network.`;
  return null;
}
