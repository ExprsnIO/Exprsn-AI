import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { servicePolicy, toolAddressProblem } from '../../platform/egress.js';
import { resolveRecords, whois, parsePorts, tcpScan, RECORD_TYPES, type RecordType } from '../../platform/netdiag.js';
import { ToolRefused, type BridgeDeps } from './net-files.js';

/*
 * Migration 053: the network diagnostic built-ins.
 *
 * - `dns.lookup` (read): every DNS record type for a name, or the reverse (PTR) for an address. A DNS query goes to
 *   the resolver, not to the host, so it does not touch the outbound-address guard; it reads nothing of the tenant's.
 * - `whois.lookup` (read): a WHOIS lookup over port 43, IANA then the registry then one registrar referral. Each
 *   WHOIS server is checked to be public before the connection opens (`platform/netdiag.ts`).
 * - `net.scan` (read): a TCP connect scan of one host, but only of a target this tenant may already reach: the host
 *   is resolved and every address checked against the outbound-address guard and the tenant's list of allowed hosts
 *   (the same check the HTTP tools use), so a public host must be on the list and an internal one named by the
 *   operator in SERVICE_ALLOWED_HOSTS. A scan of a host that is not allowed is refused the way a fetch of it is.
 *
 * All three are read-only and audited. `net.scan`, being the one that reaches the target, records the host, the
 * number of ports and how many were open.
 */

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export async function dnsLookupTool(d: BridgeDeps): Promise<unknown> {
  const { args } = d;
  const name = str(args.name);
  if (!name) throw new ToolRefused('Give name: a domain such as example.com, or an address for a reverse lookup.');
  let types: RecordType[] | undefined;
  if (Array.isArray(args.types) && args.types.length) {
    const up = (args.types as unknown[]).map((t) => String(t).toUpperCase());
    const bad = up.filter((t) => !RECORD_TYPES.includes(t as RecordType));
    if (bad.length) throw new ToolRefused(`Not a record type: ${bad.join(', ')}. One of ${RECORD_TYPES.join(', ')}.`);
    types = up as RecordType[];
  }
  const servers = Array.isArray(args.servers) ? (args.servers as unknown[]).map(String) : undefined;
  let result;
  try {
    result = await resolveRecords(name, { ...(types ? { types } : {}), ...(servers ? { servers } : {}) });
  } catch (err) {
    throw new ToolRefused((err as Error).message);
  }
  return {
    name: result.name,
    ...(result.reverse ? { reverse: result.reverse } : {}),
    records: result.records,
    counts: Object.fromEntries(Object.entries(result.records.reduce<Record<string, number>>((m, r) => ((m[r.type] = (m[r.type] ?? 0) + 1), m), {}))),
    noRecords: result.empty,
    resolvers: result.servers,
    ...(result.records.length ? {} : { note: isIP(result.name) ? 'No name reverses to this address.' : 'No records of these types; the name may not exist or may only have records of other types.' })
  };
}

export async function whoisLookupTool(d: BridgeDeps): Promise<unknown> {
  const { args } = d;
  const query = str(args.query);
  if (!query) throw new ToolRefused('Give query: a domain (example.com), a TLD (com) or an address.');
  const server = str(args.server);
  const timeoutMs = num(args.timeoutSeconds) != null ? Math.round(num(args.timeoutSeconds)! * 1000) : undefined;
  let result;
  try {
    result = await whois(query, { ...(server ? { server } : {}), ...(timeoutMs != null ? { timeoutMs } : {}) });
  } catch (err) {
    throw new ToolRefused((err as Error).message);
  }
  const full = str(args.raw) === undefined && args.raw !== true;
  return {
    query: result.query,
    kind: isIP(result.query) ? 'address' : 'domain',
    fields: result.fields,
    servers: result.hops.map((h) => h.server),
    text: full ? result.text.slice(0, 16_000) : result.hops.map((h) => `% server ${h.server}\n${h.text}`).join('\n').slice(0, 32_000),
    ...(result.text.length > 16_000 ? { note: 'The reply was long and is shown trimmed. Pass raw true for every hop.' } : {})
  };
}

async function resolveAddresses(host: string): Promise<string[]> {
  if (isIP(host)) return [host];
  const list = await dnsLookup(host, { all: true, verbatim: true });
  return list.map((x) => x.address);
}

export async function netScanTool(d: BridgeDeps): Promise<unknown> {
  const { s, p, ctx, args } = d;
  let target = str(args.host);
  if (!target) throw new ToolRefused('Give host: a host name or an address to scan.');
  // Accept a URL and reduce it to its host, so a person may paste one.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    try {
      target = new URL(target).hostname;
    } catch {
      throw new ToolRefused(`${target} is not a URL.`);
    }
  }
  target = target.replace(/^\[|\]$/g, '').toLowerCase();

  let ports: number[];
  try {
    ports = parsePorts(args.ports);
  } catch (err) {
    throw new ToolRefused((err as Error).message);
  }

  // The same gate the HTTP tools use: resolve the host and check every address against the outbound-address guard
  // and the tenant's list of allowed hosts. A target that is not allowed is refused, not scanned.
  const policy = servicePolicy(s.cfg);
  const tenant = await s.integrations.allowList(p.tenantId);
  let addresses: string[];
  try {
    addresses = await resolveAddresses(target);
  } catch {
    throw new ToolRefused(`${target} does not resolve to an address, so there is nothing to scan.`);
  }
  if (!addresses.length) throw new ToolRefused(`${target} does not resolve to an address.`);
  for (const a of addresses) {
    const problem = toolAddressProblem(a, target, policy, tenant);
    if (problem) throw new ToolRefused(`${problem} net.scan reaches only hosts this tenant may already connect to; allow it under Registry, Allowed hosts (allowed_hosts.add) to scan it.`);
  }
  const address = addresses[0]!;

  const timeoutMs = num(args.timeoutSeconds) != null ? Math.round(num(args.timeoutSeconds)! * 1000) : 2000;
  const banner = args.banner === true;
  const result = await tcpScan(target, address, ports, { timeoutMs, banner });

  await d.audit('net.scan.ran', { host: target }, ctx.label, { address, ports: ports.length, open: result.open.length, banner });

  const summary = `${result.open.length} of ${ports.length} port${ports.length === 1 ? '' : 's'} open on ${target} (${address}).`;
  return {
    host: result.host,
    address,
    resolvedTo: addresses,
    scanned: ports.length,
    open: result.open,
    // Open ports first (the useful ones), then closed, then filtered, each with its service and any banner.
    ports: result.ports.filter((r) => r.state === 'open').concat(result.ports.filter((r) => r.state !== 'open')),
    elapsedMs: result.elapsedMs,
    summary
  };
}
