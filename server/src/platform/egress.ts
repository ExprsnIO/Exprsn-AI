import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Agent } from 'undici';
import { parseAllowList, type AllowList } from '../mcp/hosts.js';

/*
 * Operator-chosen service URLs (B-901, ASVS 12.6): pool instances, zone endpoints, image backends, the training
 * worker (connections go through their own internal-only check in `mcp/hosts.ts`). Unlike MCP servers or webhooks,
 * these are commonly on loopback or a private network, so those ranges are the normal case and stay allowed. What
 * is refused:
 *
 * - cloud metadata addresses (169.254.169.254, 169.254.170.2, fd00:ec2::254, 100.100.100.200, 192.0.0.192), always;
 * - the rest of link-local (169.254.0.0/16, fe80::/10), unless `SERVICE_ALLOWED_HOSTS` names the host or network;
 * - unspecified, multicast and broadcast addresses, always;
 * - public addresses only when `SERVICE_INTERNAL_ONLY` is on and the allow-list does not name them.
 *
 * The check runs when an operator saves the URL and again inside the DNS lookup of every connection (the dispatcher
 * below), so a name that later resolves to a metadata address is refused at connect time: the address dialled is
 * the address checked.
 */

const METADATA = new BlockList();
for (const a of ['169.254.169.254', '169.254.169.253', '169.254.170.2', '169.254.170.23', '100.100.100.200', '192.0.0.192']) METADATA.addAddress(a, 'ipv4');
for (const a of ['fd00:ec2::254', 'fd00:ec2::253', 'fd00:ec2::23']) METADATA.addAddress(a, 'ipv6');

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

/** True for the cloud metadata addresses, which no operator setting admits. */
export function isMetadataAddress(ip: string): boolean {
  const a = v4(ip.replace(/^\[|\]$/g, ''));
  return isIP(a) !== 0 && METADATA.check(a, fam(a));
}

/** Why a service may not be reached at this address, or null when it may. */
export function serviceAddressProblem(ip: string, host: string, policy: ServicePolicy): string | null {
  const addr = v4(ip);
  const f = fam(addr);
  const shown = host === addr ? addr : `${host} resolves to ${addr}, which`;
  if (METADATA.check(addr, f)) return `${shown} is a cloud metadata address and is always refused.`;
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
  return isIP(host) ? serviceAddressProblem(host, host, policy) : null;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** A DNS lookup for `net.connect`/undici that refuses addresses the policy refuses (pinning: dial what was checked). */
export function serviceLookup(policy: ServicePolicy) {
  return (hostname: string, options: { all?: boolean; family?: number } & Record<string, unknown>, cb: LookupCb) => {
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

// ---------- 1.6.0 (B-8902): outbound calls of HTTP tools ----------

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
  if (METADATA.check(addr, f)) return `${shown} is a cloud metadata address and is always refused.`;
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
  body?: string;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
  /** Why an address is refused (null: allowed); every address the host resolves to is checked. */
  check: (address: string, host: string) => string | null;
}

export interface GuardedResponse {
  status: number;
  contentType: string | null;
  body: Buffer;
  /** The address dialled (the one that was checked). */
  address: string;
}

/**
 * One request through the outbound address guard: the host is resolved once, every address is checked, the
 * connection is pinned to the checked address (a second DNS answer cannot point elsewhere), redirects are not
 * followed (a 3xx comes back as it is), and the answer is capped. Throws ServiceUrlRefused when refused.
 */
export async function guardedRequest(r: GuardedRequest): Promise<GuardedResponse> {
  if (r.url.protocol !== 'http:' && r.url.protocol !== 'https:') throw new ServiceUrlRefused('Only http:// and https:// are allowed.');
  if (r.url.username || r.url.password) throw new ServiceUrlRefused('Credentials do not belong in the URL.');
  const host = r.url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const addresses = isIP(host) ? [host] : await resolveAll(host);
  if (!addresses.length) throw new ServiceUrlRefused(`${host} does not resolve.`);
  for (const a of addresses) {
    const p = r.check(a, host);
    if (p) throw new ServiceUrlRefused(p);
  }
  const target = addresses[0]!;
  const family = isIP(target) === 6 ? 6 : 4;
  return new Promise<GuardedResponse>((resolve, reject) => {
    const send = r.url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(
      r.url,
      {
        method: r.method,
        headers: { 'user-agent': 'exprsn-ai-tool', ...r.headers, ...(r.body != null ? { 'content-length': String(Buffer.byteLength(r.body)) } : {}) },
        // Dial the address that was checked, whatever the name resolves to now.
        lookup: (_h: string, opts: { all?: boolean }, cb: (...a: unknown[]) => void) => (opts?.all ? cb(null, [{ address: target, family }]) : cb(null, target, family)),
        timeout: r.timeoutMs,
        ...(r.signal ? { signal: r.signal } : {})
      } as never,
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > r.maxBytes) {
            req.destroy(new ServiceUrlRefused(`The answer is larger than ${Math.round(r.maxBytes / 1024)} KB.`));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, contentType: (res.headers['content-type'] as string | undefined) ?? null, body: Buffer.concat(chunks), address: target }));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new ServiceUrlRefused(`No answer within ${r.timeoutMs} ms.`)));
    req.on('error', (err) => reject(err));
    if (r.body != null) req.write(r.body);
    req.end();
  });
}
