import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent } from 'undici';

/**
 * MCP servers must be internal: every address a server's hostname resolves to has to be private (RFC 1918, unique
 * local IPv6, loopback or the shared CGNAT range), unless an explicit allow-list names the host or its network.
 * Link-local addresses (169.254.0.0/16 and fe80::/10, where cloud metadata services live) and unspecified,
 * multicast and broadcast addresses are always refused. The check runs at registration and again inside the
 * connection's DNS lookup, so a name that later resolves somewhere public (DNS rebinding) is refused at connect time.
 */

const internal = new BlockList();
internal.addSubnet('10.0.0.0', 8, 'ipv4');
internal.addSubnet('172.16.0.0', 12, 'ipv4');
internal.addSubnet('192.168.0.0', 16, 'ipv4');
internal.addSubnet('127.0.0.0', 8, 'ipv4');
internal.addSubnet('100.64.0.0', 10, 'ipv4');
internal.addSubnet('fc00::', 7, 'ipv6');
internal.addAddress('::1', 'ipv6');

const never = new BlockList();
never.addSubnet('169.254.0.0', 16, 'ipv4');
never.addSubnet('0.0.0.0', 8, 'ipv4');
never.addSubnet('224.0.0.0', 4, 'ipv4');
never.addAddress('255.255.255.255', 'ipv4');
never.addSubnet('fe80::', 10, 'ipv6');
never.addSubnet('ff00::', 8, 'ipv6');
never.addAddress('::', 'ipv6');

export interface AllowList {
  hosts: string[];
  networks: BlockList;
  empty: boolean;
}

/** `MCP_ALLOWED_HOSTS`: comma-separated hostnames (`*.example.com` for a domain) and CIDR networks. */
export function parseAllowList(spec: string): AllowList {
  const hosts: string[] = [];
  const networks = new BlockList();
  let n = 0;
  for (const raw of spec.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    const [addr, bits] = raw.split('/');
    const family = addr ? isIP(addr) : 0;
    if (family && bits !== undefined) {
      networks.addSubnet(addr!, Number(bits), family === 6 ? 'ipv6' : 'ipv4');
      n++;
    } else if (family) {
      networks.addAddress(addr!, family === 6 ? 'ipv6' : 'ipv4');
      n++;
    } else {
      hosts.push(raw);
      n++;
    }
  }
  return { hosts, networks, empty: n === 0 };
}

const mappedV4 = (ip: string): string | null => {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1]! : null;
};

const famOf = (ip: string): 'ipv4' | 'ipv6' => (isIP(ip) === 6 ? 'ipv6' : 'ipv4');

const hostAllowed = (host: string, allow: AllowList) => allow.hosts.some((h) => (h.startsWith('*.') ? host.endsWith(h.slice(1)) : host === h));

/** Why an address may not be used for an MCP server, or null when it may. */
export function addressProblem(ip: string, host: string, allow: AllowList): string | null {
  const v4 = mappedV4(ip);
  const addr = v4 ?? ip;
  const fam = famOf(addr);
  if (never.check(addr, fam)) return `${addr} is a link-local, multicast or unspecified address.`;
  if (internal.check(addr, fam)) return null;
  if (hostAllowed(host, allow) || allow.networks.check(addr, fam)) return null;
  return `${host === addr ? addr : `${host} resolves to ${addr}, which`} is a public address. Only internal hosts are accepted${allow.empty ? '' : ' unless the allow-list names them'}.`;
}

export class HostRefused extends Error {}

/** Resolves a URL's host and checks every address. */
export async function checkUrl(raw: string, allow: AllowList): Promise<{ host: string; addresses: string[] }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HostRefused('The endpoint is not a URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HostRefused('The endpoint must be http:// or https://.');
  if (url.username || url.password) throw new HostRefused('Put credentials in the server\'s authorization, not in the URL.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const addresses = isIP(host) ? [host] : await new Promise<string[]>((resolve, reject) => dnsLookup(host, { all: true, verbatim: true }, (err, list) => (err ? reject(new HostRefused(`${host} does not resolve: ${err.code ?? err.message}.`)) : resolve(list.map((x) => x.address)))));
  if (!addresses.length) throw new HostRefused(`${host} does not resolve.`);
  for (const a of addresses) {
    const p = addressProblem(a, host, allow);
    if (p) throw new HostRefused(p);
  }
  return { host, addresses };
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * An undici dispatcher whose connections may only reach allowed addresses: the DNS lookup made for each connection
 * is checked, so the address actually dialled is the one that was checked.
 */
export function guardedAgent(allow: AllowList, timeoutMs: number): Agent {
  const lookup = (hostname: string, options: { all?: boolean; family?: number } & Record<string, unknown>, cb: LookupCb) => {
    dnsLookup(hostname, { ...options, all: true, verbatim: true }, (err, list) => {
      if (err) return cb(err, '', 0);
      for (const a of list) {
        const p = addressProblem(a.address, hostname.toLowerCase(), allow);
        if (p) return cb(Object.assign(new HostRefused(p), { code: 'EREFUSED' }), '', 0);
      }
      if (options.all) return cb(null, list);
      const first = list[0]!;
      cb(null, first.address, first.family);
    });
  };
  return new Agent({ connect: { lookup: lookup as never, timeout: timeoutMs }, headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
}
