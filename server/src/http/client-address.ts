import { BlockList, isIP } from 'node:net';
import type { Express, Request, RequestHandler } from 'express';
import { cloudflareRanges } from './cloudflare-ips.js';

/*
 * 1.9.99-final, Sprint 61 (B-10901): the client address behind the Cloudflare front door.
 *
 * TRUST_PROXY keeps Express's meaning (`loopback`, `uniquelocal`, addresses and ranges, `true`, `false`); the keyword
 * `cloudflare` in its list turns this on. Without it nothing here is installed and an install behaves exactly as
 * before: Express's `trust proxy` alone decides `req.ip` and no Cloudflare header is read.
 *
 * With it:
 *   - Express also trusts Cloudflare's published egress ranges (`http/cloudflare-ips.ts`, or CLOUDFLARE_IP_RANGES)
 *     and the tunnel's connector (CLOUDFLARE_TUNNEL_PEERS), so `X-Forwarded-Proto` from them counts.
 *   - The edge hop is found from the socket outwards: the socket's peer is the tunnel connector, or a Cloudflare
 *     address; or the socket's peer is a local proxy the rest of TRUST_PROXY trusts (an nginx in front) and, walking
 *     X-Forwarded-For from the right through such proxies, the next hop is a Cloudflare address. Only then is
 *     `CF-Connecting-IP` (one valid address) taken as the client (`req.ip`). The tunnel connector counts only as the
 *     socket's own peer, never as an X-Forwarded-For entry a client could write.
 *   - Otherwise `CF-Connecting-IP` is removed from the request, so nothing later can read a spoofed value, and
 *     `req.ip` is what Express computes.
 */

export type EdgeVia = 'tunnel' | 'edge';

declare module 'express-serve-static-core' {
  interface Request {
    /** B-10901: how the request reached this server through Cloudflare, when it did. */
    edge?: { via: EdgeVia; peer: string };
  }
}

const KEYWORDS: Record<string, [string, number, 'ipv4' | 'ipv6'][]> = {
  loopback: [['127.0.0.0', 8, 'ipv4'], ['::1', 128, 'ipv6']],
  linklocal: [['169.254.0.0', 16, 'ipv4'], ['fe80::', 10, 'ipv6']],
  uniquelocal: [['10.0.0.0', 8, 'ipv4'], ['172.16.0.0', 12, 'ipv4'], ['192.168.0.0', 16, 'ipv4'], ['fc00::', 7, 'ipv6']]
};

/** A plain address: an IPv4-mapped IPv6 address as its IPv4 form, brackets and zone ids gone. */
export function plainAddress(a: string | undefined | null): string | null {
  if (!a) return null;
  let x = a.trim().replace(/^\[|\]$/g, '');
  const zone = x.indexOf('%');
  if (zone > 0) x = x.slice(0, zone);
  if (x.toLowerCase().startsWith('::ffff:') && isIP(x.slice(7)) === 4) x = x.slice(7);
  return isIP(x) ? x.toLowerCase() : null;
}

/** Why an entry of a range list is not an address, a range or a keyword, or null. */
export function rangeEntryProblem(entry: string, keywords = true): string | null {
  const e = entry.trim().toLowerCase();
  if (keywords && e in KEYWORDS) return null;
  const [a, len, extra] = e.split('/');
  const v = isIP(a ?? '');
  if (!v || extra !== undefined) return `${entry} is not an address or a range`;
  if (len !== undefined && !(/^\d{1,3}$/.test(len) && Number(len) <= (v === 4 ? 32 : 128))) return `${entry} has a bad prefix length`;
  return null;
}

/** A matcher over a comma-separated list of addresses, ranges and (optionally) the keywords loopback, linklocal, uniquelocal. */
export function addressMatcher(list: string[] | string): (addr: string | null | undefined) => boolean {
  const entries = (Array.isArray(list) ? list : list.split(',')).map((x) => x.trim()).filter(Boolean);
  const block = new BlockList();
  let any = false;
  for (const raw of entries) {
    const e = raw.toLowerCase();
    if (KEYWORDS[e]) {
      for (const [net, len, fam] of KEYWORDS[e]) block.addSubnet(net, len, fam);
      any = true;
      continue;
    }
    if (rangeEntryProblem(e, false)) continue;
    const [a, len] = e.split('/');
    const fam = isIP(a!) === 4 ? 'ipv4' : 'ipv6';
    if (len === undefined) block.addAddress(a!, fam);
    else block.addSubnet(a!, Number(len), fam);
    any = true;
  }
  return (addr) => {
    if (!any) return false;
    const p = plainAddress(addr ?? null);
    if (!p) return false;
    return block.check(p, isIP(p) === 4 ? 'ipv4' : 'ipv6');
  };
}

export interface EdgeTrustConfig {
  TRUST_PROXY: string;
  CLOUDFLARE_TUNNEL_PEERS: string;
  CLOUDFLARE_IP_RANGES: string;
}

/** TRUST_PROXY's entries and whether `cloudflare` is one of them. */
export function trustProxyParts(value: string): { cloudflare: boolean; rest: string } {
  const parts = value.split(',').map((x) => x.trim()).filter(Boolean);
  const cloudflare = parts.some((p) => p.toLowerCase() === 'cloudflare');
  return { cloudflare, rest: parts.filter((p) => p.toLowerCase() !== 'cloudflare').join(',') };
}

/** Express's own value for a TRUST_PROXY string without the `cloudflare` keyword (as `createApp` always set it). */
export function expressTrustValue(value: string): boolean | string {
  return value === 'true' ? true : value === 'false' ? false : value;
}

export interface EdgeTrust {
  /** Whether a peer is one of Cloudflare's egress addresses. */
  isCloudflare: (addr: string | null | undefined) => boolean;
  /** Whether the socket's peer is the tunnel's connector. */
  isTunnelPeer: (addr: string | null | undefined) => boolean;
  /** The Express trust function: the rest of TRUST_PROXY, Cloudflare's ranges and the tunnel connector. */
  trust: (addr: string, i: number) => boolean;
  /** The edge hop of a request, or null when it did not come through Cloudflare. */
  edgeOf: (socketPeer: string | null | undefined, forwardedFor: string | undefined) => { via: EdgeVia; peer: string } | null;
  middleware: RequestHandler;
}

/**
 * The Cloudflare trust for an app, or null when TRUST_PROXY does not name `cloudflare` (then `createApp` sets
 * `trust proxy` exactly as before). `local` is the trust function Express compiled for the rest of TRUST_PROXY.
 */
export function edgeTrust(cfg: EdgeTrustConfig, local: (addr: string, i: number) => boolean): EdgeTrust | null {
  if (!trustProxyParts(cfg.TRUST_PROXY).cloudflare) return null;
  const ranges = cfg.CLOUDFLARE_IP_RANGES.trim() ? cfg.CLOUDFLARE_IP_RANGES : cloudflareRanges();
  const isCloudflare = addressMatcher(ranges);
  const isTunnelPeer = addressMatcher(cfg.CLOUDFLARE_TUNNEL_PEERS);
  const edgeOf: EdgeTrust['edgeOf'] = (socketPeer, forwardedFor) => {
    const hops = [plainAddress(socketPeer), ...(forwardedFor ?? '').split(',').map((x) => plainAddress(x)).reverse()];
    for (let i = 0; i < hops.length; i++) {
      const a = hops[i];
      if (!a) return null;
      if (i === 0 && isTunnelPeer(a)) return { via: 'tunnel', peer: a };
      if (isCloudflare(a)) return { via: 'edge', peer: a };
      // A local proxy in front (nginx): look one hop further out, as Express does.
      if (!local(a, i)) return null;
    }
    return null;
  };
  const middleware: RequestHandler = (req, _res, next) => {
    const via = edgeOf(req.socket?.remoteAddress, headerOne(req, 'x-forwarded-for', true));
    const claimed = plainAddress(headerOne(req, 'cf-connecting-ip', false));
    if (via) {
      req.edge = via;
      if (claimed) Object.defineProperty(req, 'ip', { value: claimed, configurable: true, enumerable: true, writable: true });
    } else if (req.headers['cf-connecting-ip'] !== undefined) {
      // Not from Cloudflare: the header is a client's claim, so nothing after this may read it.
      delete req.headers['cf-connecting-ip'];
    }
    next();
  };
  return { isCloudflare, isTunnelPeer, trust: (addr, i) => local(addr, i) || isCloudflare(addr) || (i === 0 && isTunnelPeer(addr)), edgeOf, middleware };
}

function headerOne(req: Request, name: string, join: boolean): string | undefined {
  const v = req.headers[name];
  if (Array.isArray(v)) return join ? v.join(',') : v.length === 1 ? v[0] : undefined;
  return v;
}

/** Sets `trust proxy` on an app and returns the Cloudflare trust when TRUST_PROXY names it. */
export function applyTrustProxy(app: Express, cfg: EdgeTrustConfig): EdgeTrust | null {
  const { cloudflare, rest } = trustProxyParts(cfg.TRUST_PROXY);
  if (!cloudflare) {
    app.set('trust proxy', expressTrustValue(cfg.TRUST_PROXY));
    return null;
  }
  // Express compiles the rest of the list (keywords, ranges) into its own function; Cloudflare's trust wraps it.
  app.set('trust proxy', rest ? expressTrustValue(rest) : false);
  const local = app.get('trust proxy fn') as (addr: string, i: number) => boolean;
  const edge = edgeTrust(cfg, local)!;
  app.set('trust proxy', edge.trust);
  return edge;
}
