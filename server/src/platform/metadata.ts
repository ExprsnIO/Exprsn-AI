import { BlockList, isIP } from 'node:net';

/*
 * 1.9.99-final, Sprint 59 (B-10705): the cloud instance metadata endpoints, which no outbound call of Exprsn-AI may
 * reach, whatever an operator or a tenant allow-lists. A metadata service hands out the machine's (or the task's, or
 * the pod's) cloud credentials to anything that can send it an HTTP request, so a server-side request forgery to it
 * is a credential theft. Every egress check (`mcp/hosts.ts`, `platform/egress.ts`, `workflows/http.ts` and the call
 * sites that dial on their own) asks `isMetadataAddress` for every address it is about to dial and `isMetadataHost`
 * for the name it was given, before any allow-list is consulted.
 *
 * Addresses (`METADATA_V4`, `METADATA_V6`):
 *   169.254.169.254  AWS EC2 IMDS, Azure IMDS, GCP, DigitalOcean, Oracle, OpenStack: the common one
 *   169.254.169.253  AWS VPC DNS resolver on the same link (kept with the metadata set since B-901)
 *   169.254.170.2    AWS ECS task metadata and task-role credentials (Fargate and EC2 launch types)
 *   169.254.170.23   AWS EKS Pod Identity agent (task-role style credentials for pods)
 *   169.254.0.23     Tencent Cloud metadata (metadata.tencentyun.com)
 *   100.100.100.200  Alibaba Cloud ECS metadata
 *   192.0.0.192      Oracle Cloud (OCI) metadata, legacy address
 *   168.63.129.16    Azure WireServer (VM agent, extensions' settings and their protected secrets, the health probe)
 *   fd00:ec2::254    AWS IMDS over IPv6 (Nitro)
 *   fd00:ec2::253    AWS VPC DNS over IPv6
 *   fd00:ec2::23     AWS EKS Pod Identity agent over IPv6
 *   fd20:ce::254     GCP metadata over IPv6
 *
 * An IPv6 spelling of an IPv4 metadata address is the same address: IPv4-mapped (`::ffff:169.254.169.254`, also in
 * hex), IPv4-compatible (`::a9fe:a9fe`), SIIT (`::ffff:0:a9fe:a9fe`), the NAT64 well-known prefix
 * (`64:ff9b::a9fe:a9fe`, which a DNS64 resolver hands out and a NAT64 gateway forwards) and 6to4 (`2002:a9fe:a9fe::`).
 * The decimal, octal and hex spellings of an IPv4 literal (`2852039166`, `0251.0376.0251.0376`, `0xa9fea9fe`) never
 * reach these checks as such: the WHATWG URL parser normalises them to dotted decimal first.
 *
 * Names (`METADATA_HOSTS`): `metadata.google.internal` (and `metadata.goog`, and the bare `metadata` a GCP search
 * domain completes), `instance-data` and `instance-data.ec2.internal` (AWS), `metadata.tencentyun.com`, and every name
 * under `metadata.google.internal`. A name is refused before it is resolved, so a refusal does not depend on what the
 * local resolver answers; and every address a normal name resolves to is checked, so a name that resolves to a
 * metadata address (DNS rebinding, a planted record) is refused at connect time too.
 */

export const METADATA_V4 = ['169.254.169.254', '169.254.169.253', '169.254.170.2', '169.254.170.23', '169.254.0.23', '100.100.100.200', '192.0.0.192', '168.63.129.16'] as const;
export const METADATA_V6 = ['fd00:ec2::254', 'fd00:ec2::253', 'fd00:ec2::23', 'fd20:ce::254'] as const;
export const METADATA_HOSTS = ['metadata.google.internal', 'metadata.goog', 'metadata', 'instance-data', 'instance-data.ec2.internal', 'metadata.tencentyun.com'] as const;

const BLOCK = new BlockList();
for (const a of METADATA_V4) BLOCK.addAddress(a, 'ipv4');
for (const a of METADATA_V6) BLOCK.addAddress(a, 'ipv6');

/** The eight 16-bit groups of an IPv6 address (a trailing dotted IPv4 part allowed), or null when it is not one. */
function groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);
  if (isIP(s) !== 6) return null;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    const o = dotted[1]!.split('.').map(Number);
    s = `${s.slice(0, -dotted[1]!.length)}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
  }
  const [head, tail] = s.includes('::') ? (s.split('::') as [string, string]) : [s, null];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = tail === null ? [] : new Array<string>(8 - h.length - t.length).fill('0');
  const all = [...h, ...fill, ...t].map((x) => parseInt(x || '0', 16));
  return all.length === 8 && all.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? all : null;
}

const v4of = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

/**
 * The IPv4 address an IPv6 address carries (IPv4-mapped, IPv4-compatible, SIIT, NAT64 well-known prefix, 6to4), or
 * null. `::` and `::1` carry none.
 */
export function embeddedV4(ip: string): string | null {
  const g = groups(ip.replace(/^\[|\]$/g, ''));
  if (!g) return null;
  const zero = (from: number, to: number) => g.slice(from, to).every((n) => n === 0);
  if (zero(0, 5) && g[5] === 0xffff) return v4of(g[6]!, g[7]!); // ::ffff:a.b.c.d
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return v4of(g[6]!, g[7]!); // ::ffff:0:a.b.c.d (SIIT)
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4of(g[6]!, g[7]!); // 64:ff9b::a.b.c.d (NAT64)
  if (zero(0, 6) && (g[6]! !== 0 || g[7]! > 1)) return v4of(g[6]!, g[7]!); // ::a.b.c.d (IPv4-compatible)
  if (g[0] === 0x2002) return v4of(g[1]!, g[2]!); // 2002:aabb:ccdd:: (6to4)
  return null;
}

/** True for a cloud instance metadata address in any spelling (brackets, IPv6 forms of an IPv4 one, a zone index). */
export function isMetadataAddress(ip: string): boolean {
  const a = ip.trim().replace(/^\[|\]$/g, '').toLowerCase();
  const fam = isIP(a);
  if (fam === 4) return BLOCK.check(a, 'ipv4');
  const g = groups(a);
  if (!g) return false;
  const inner = embeddedV4(a);
  if (inner && BLOCK.check(inner, 'ipv4')) return true;
  const canonical = g.map((n) => n.toString(16)).join(':');
  return BLOCK.check(canonical, 'ipv6');
}

/** True for a metadata service's name, or for an address literal that is a metadata address. */
export function isMetadataHost(host: string): boolean {
  const h = host.trim().replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
  if (!h) return false;
  if (isIP(h) || (h.includes(':') && groups(h))) return isMetadataAddress(h);
  return (METADATA_HOSTS as readonly string[]).includes(h) || h.endsWith('.metadata.google.internal');
}

/** The refusal for a host or an address it resolved to, or null. `shown` names the host for the message. */
export function metadataProblem(host: string, address?: string): string | null {
  if (isMetadataHost(host)) return `${host} is a cloud metadata address and is always refused.`;
  if (address && isMetadataAddress(address)) return `${host === address ? address : `${host} resolves to ${address}, which`} is a cloud metadata address and is always refused.`;
  return null;
}

/** The refusal for a URL's host, or null (an unparseable URL is left to the caller's own check). */
export function metadataUrlProblem(raw: string | URL): string | null {
  let host: string;
  try {
    host = (typeof raw === 'string' ? new URL(raw) : raw).hostname;
  } catch {
    return null;
  }
  return metadataProblem(host.replace(/^\[|\]$/g, '').toLowerCase());
}
