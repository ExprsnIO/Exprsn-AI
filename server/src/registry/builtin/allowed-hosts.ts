import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { hostEntryProblem, tenantHostProblem } from '../../integrations/hosts.js';
import { parseAllowList } from '../../mcp/hosts.js';
import { servicePolicy, toolAddressProblem } from '../../platform/egress.js';
import { ToolRefused, type BridgeDeps } from './net-files.js';

/*
 * Migration 049: the tenant's list of allowed hosts as built-in tools.
 *
 * - `allowed_hosts.check` (read): whether the request tools (`http_fetch`, `http_request`, `http_download`, `impl: http`
 *   tools) may reach a host now, why not, and the entry that would allow it.
 * - `allowed_hosts.list` (read), `allowed_hosts.add` and `allowed_hosts.remove` (write): the list itself, for holders
 *   of `tenant:manage`, as the console's Registry, Allowed hosts does it (`routes/admin/integrations.ts`), with the
 *   same audit event.
 *
 * The list has two effects, and `add` says so when it matters: it admits public hosts for the request tools, and once
 * it has any entry it narrows where webhooks, workflow HTTP steps and mail channels may connect to the hosts on it.
 * It never admits an internal address: those are the operator's `SERVICE_ALLOWED_HOSTS`.
 */

const MAX_ENTRIES = 200;
/** Suffixes under which anyone can register: a wildcard on one of them allows the whole registry. */
const PUBLIC_SECOND_LEVEL = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'ne.jp', 'or.jp', 'com.br', 'com.cn', 'com.mx', 'co.in', 'co.za', 'com.sg', 'com.tr', 'com.ar', 'co.kr', 'com.hk', 'com.tw']);
/** Hosting suffixes where every customer has a subdomain: a wildcard there allows other people's sites. */
const SHARED_HOSTING = ['github.io', 'githubusercontent.com', 'herokuapp.com', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com', 'appspot.com', 'azurewebsites.net', 'cloudfront.net', 'amazonaws.com', 'blob.core.windows.net', 'ngrok.io', 'ngrok-free.app', 'trycloudflare.com', 'repl.co', 'glitch.me', 'onrender.com', 'fly.dev', 'blogspot.com', 'wordpress.com', 's3.amazonaws.com'];

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

/** A host, `*.domain`, address or network out of what a person pastes: a URL, a host with a port, mixed case, an IDN. */
export function normaliseEntry(raw: string): { entry: string; note?: string } {
  let x = raw.trim();
  if (!x) throw new ToolRefused('Give a host: a domain such as api.example.com, *.example.com, an address or a network.');
  let note: string | undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(x)) {
    let u: URL;
    try {
      u = new URL(x);
    } catch {
      throw new ToolRefused(`${x} is not a URL.`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ToolRefused(`${x} is not an http or https URL.`);
    note = `Taken from the URL: the list holds hosts, not paths or ports, so every path on ${u.hostname} is allowed.`;
    x = u.hostname;
  }
  x = x.replace(/^\[|\]$/g, '');
  // An address or network is kept as written; a name loses a port, a path and a trailing dot.
  const [addr] = x.split('/');
  if (addr && isIP(addr)) return { entry: x.toLowerCase(), ...(note ? { note } : {}) };
  x = x.replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  const wildcard = x.startsWith('*.');
  const name = wildcard ? x.slice(2) : x;
  if (/[*?]/.test(name)) throw new ToolRefused(`${raw} is not a host: a wildcard goes at the front only, as in *.example.com.`);
  const ascii = [...name].every((c) => c.charCodeAt(0) < 128) ? name.toLowerCase() : domainToASCII(name);
  if (!ascii) throw new ToolRefused(`${raw} is not a valid host name.`);
  if (ascii !== name.toLowerCase()) note = `${note ? `${note} ` : ''}${name} is stored in its ASCII form ${ascii}.`;
  return { entry: `${wildcard ? '*.' : ''}${ascii}`, ...(note ? { note } : {}) };
}

/** Why an entry should not be on a tenant's list, or null. */
function entryRefusal(entry: string, policy: ReturnType<typeof servicePolicy>): string | null {
  const problem = hostEntryProblem(entry);
  if (problem) return problem;
  const [addr, bits] = entry.split('/');
  const fam = addr ? isIP(addr) : 0;
  if (fam) {
    // The tenant's list never admits an internal address, so an entry for one would only mislead.
    const p = toolAddressProblem(addr!, addr!, policy, parseAllowList(entry));
    if (p) return `${entry} cannot be allowed from here: ${p}`;
    if (bits !== undefined && Number(bits) < (fam === 4 ? 16 : 32)) return `${entry} is a very large network (more than 65,000 addresses): give the hosts, or a network of /${fam === 4 ? 16 : 32} or smaller.`;
    return null;
  }
  const name = entry.replace(/^\*\./, '');
  const labels = name.split('.');
  if (labels.length < 2) return entry.startsWith('*.') ? `${entry} would allow every site under .${name}. Name the organisation's own domain.` : `${entry} is a single label, not a domain: give the full name, such as api.example.com.`;
  if (entry.startsWith('*.')) {
    if (labels.length === 2 && PUBLIC_SECOND_LEVEL.has(name)) return `${entry} would allow every site registered under .${name}. Name the organisation's own domain.`;
    const shared = SHARED_HOSTING.find((h) => name === h);
    if (shared) return `${entry} would allow every customer of ${shared}, not one site. Name the one host, such as myproject.${shared}.`;
  }
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local') || name.endsWith('.internal') || name.endsWith('.lan')) return `${entry} is an internal name. The tenant's list admits public hosts only; internal hosts are named by the operator in SERVICE_ALLOWED_HOSTS.`;
  return null;
}

async function resolve(host: string): Promise<string[]> {
  if (isIP(host)) return [host];
  try {
    return (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    return [];
  }
}

const policyOf = (d: BridgeDeps) => servicePolicy(d.s.cfg);

export async function hostsCheck(d: BridgeDeps): Promise<unknown> {
  const { s, p, args } = d;
  const target = str(args.target);
  if (!target) throw new ToolRefused('Give target: a URL or a host.');
  const { entry: host } = normaliseEntry(target);
  if (host.startsWith('*.') || host.includes('/')) throw new ToolRefused('Give one host or URL to check, not a pattern or a network.');
  const policy = policyOf(d);
  const list = await s.integrations.allowList(p.tenantId);
  const addresses = await resolve(host);
  if (!addresses.length) return { host, allowed: false, resolves: false, reason: `${host} does not resolve to an address, so nothing can reach it.` };
  const problems = [...new Set(addresses.map((a) => toolAddressProblem(a, host, policy, list)).filter((x): x is string => !!x))];
  const internal = problems.some((x) => /internal address|metadata|unspecified/.test(x));
  const narrowed = tenantHostProblem(host, addresses, list);
  const parent = host.split('.').slice(1).join('.');
  return {
    host,
    allowed: problems.length === 0,
    resolves: true,
    addresses: addresses.slice(0, 8),
    ...(problems.length ? { reason: problems[0] } : { reason: `${host} is allowed for http_fetch, http_request, http_download and HTTP tools.` }),
    ...(problems.length && !internal ? { toAllow: { entry: host, ...(parent.includes('.') && !isIP(host) ? { orWithSubdomains: `*.${parent}` } : {}), how: 'A tenant admin adds it: allowed_hosts.add, or Registry, Allowed hosts in the console.' } } : {}),
    ...(internal ? { toAllow: { how: 'Internal addresses are allowed only by the operator, in SERVICE_ALLOWED_HOSTS; the tenant list cannot admit them.' } } : {}),
    webhooksAndWorkflowSteps: narrowed ? 'refused: the list has entries and this host is not among them' : 'not narrowed by the list'
  };
}

async function listView(d: BridgeDeps) {
  const { s, p } = d;
  const x = await s.integrations.get(p.tenantId);
  const split = (v: string | undefined) => (v ? v.split(',').map((h) => h.trim()).filter(Boolean) : []);
  return { hosts: x.allowedHosts, count: x.allowedHosts.length, updatedAt: x.updatedAt == null ? null : new Date(x.updatedAt).toISOString(), operator: { internalHostsForTools: split(s.cfg.SERVICE_ALLOWED_HOSTS), webhooks: split(s.cfg.WEBHOOK_ALLOWED_HOSTS), workflowSteps: split(s.cfg.WORKFLOW_HTTP_HOSTS) } };
}

export async function hostsList(d: BridgeDeps): Promise<unknown> {
  const v = await listView(d);
  return { ...v, effects: v.count ? 'Public hosts on this list may be reached by http_fetch, http_request, http_download and HTTP tools. Because the list has entries, webhooks, workflow HTTP steps and mail channels connect only to hosts on it.' : 'The list is empty: the request tools reach no public host, and webhooks, workflow HTTP steps and mail channels are not narrowed by it.' };
}

/** The webhooks of the tenant whose host the list would refuse: what a first entry starts to narrow. */
async function webhooksOutside(d: BridgeDeps, hosts: string[]): Promise<string[]> {
  if (!hosts.length) return [];
  const list = parseAllowList(hosts.join(','));
  const rows = (await d.s.db('webhooks').where({ tenant_id: d.p.tenantId, state: 'active' }).select('name', 'url')) as { name: string; url: string }[];
  const out: string[] = [];
  for (const w of rows) {
    let host: string;
    try {
      host = new URL(w.url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (tenantHostProblem(host, [], list)) out.push(`${w.name} (${host})`);
  }
  return out;
}

export async function hostsAdd(d: BridgeDeps): Promise<unknown> {
  const { s, p, args, ctx } = d;
  const raw = Array.isArray(args.hosts) ? (args.hosts as unknown[]).map(String) : str(args.host) ? [str(args.host)!] : [];
  if (!raw.length) throw new ToolRefused('Give host (or hosts): a domain, *.domain, an address or a network.');
  if (raw.length > 20) throw new ToolRefused('At most 20 hosts in one call.');
  const reason = str(args.reason);
  if (!reason || reason.length < 8) throw new ToolRefused('Give a reason: what will reach this host and why. It is recorded with the change.');
  const policy = policyOf(d);
  const notes: string[] = [];
  const wanted: string[] = [];
  for (const r of raw) {
    const { entry, note } = normaliseEntry(r);
    if (note) notes.push(note);
    const entries = [entry];
    // example.com does not cover www.example.com, and *.example.com does not cover example.com: both on request.
    if (args.includeSubdomains === true && !entry.startsWith('*.') && !isIP(entry.split('/')[0]!)) entries.push(`*.${entry}`);
    for (const e of entries) {
      const refusal = entryRefusal(e, policy);
      if (refusal) throw new ToolRefused(`${refusal} Nothing was changed.`);
      wanted.push(e);
    }
    // A name that resolves to an internal address is refused by the guard whatever the list says.
    if (!entry.startsWith('*.') && !entry.includes('/') && !isIP(entry)) {
      const addresses = await resolve(entry);
      if (!addresses.length) notes.push(`${entry} does not resolve to an address at the moment: check the spelling.`);
      else {
        const internal = addresses.map((a) => toolAddressProblem(a, entry, policy, parseAllowList(entry))).find((x) => x);
        if (internal) throw new ToolRefused(`${internal} Adding it to the tenant's list would not change that. Nothing was changed.`);
      }
    }
  }
  const before = await s.integrations.get(p.tenantId);
  const have = new Set(before.allowedHosts);
  const added = [...new Set(wanted)].filter((e) => !have.has(e));
  const already = [...new Set(wanted)].filter((e) => have.has(e));
  if (!added.length) return { added: [], already, hosts: before.allowedHosts, count: before.allowedHosts.length, note: 'Every entry was already on the list; nothing was changed.' };
  const next = [...before.allowedHosts, ...added];
  if (next.length > MAX_ENTRIES) throw new ToolRefused(`The list would have ${next.length} entries; it holds at most ${MAX_ENTRIES}. Nothing was changed.`);
  const warnings: string[] = [];
  if (!before.allowedHosts.length) {
    const outside = await webhooksOutside(d, next);
    warnings.push(`This is the first entry. From now on webhooks, workflow HTTP steps and mail channels of this tenant connect only to hosts on the list.${outside.length ? ` Active webhooks that are now refused: ${outside.slice(0, 20).join(', ')}. Add their hosts or remove the entry.` : ' No active webhook is affected.'}`);
  }
  for (const e of added) if (e.startsWith('*.')) warnings.push(`${e} allows every subdomain of ${e.slice(2)}, including ones created later.`);
  const after = await s.integrations.set(p.tenantId, { allowedHosts: next }, p.userId);
  await d.audit('tenant.hosts.updated', { tenant: p.tenantId }, ctx.label, { before: before.allowedHosts, after: after.allowedHosts, added, reason: reason.slice(0, 500) });
  return { added, ...(already.length ? { already } : {}), hosts: after.allowedHosts, count: after.allowedHosts.length, ...(warnings.length ? { warnings } : {}), ...(notes.length ? { notes } : {}), note: `${added.join(', ')} ${added.length === 1 ? 'is' : 'are'} now allowed for http_fetch, http_request, http_download and HTTP tools in this tenant.` };
}

export async function hostsRemove(d: BridgeDeps): Promise<unknown> {
  const { s, p, args, ctx } = d;
  const raw = Array.isArray(args.hosts) ? (args.hosts as unknown[]).map(String) : str(args.host) ? [str(args.host)!] : [];
  if (!raw.length) throw new ToolRefused('Give host (or hosts): the entries to take off the list, as allowed_hosts.list shows them.');
  const reason = str(args.reason);
  if (!reason || reason.length < 8) throw new ToolRefused('Give a reason. It is recorded with the change.');
  const drop = new Set(raw.map((r) => normaliseEntry(r).entry));
  const before = await s.integrations.get(p.tenantId);
  const removed = before.allowedHosts.filter((h) => drop.has(h));
  const missing = [...drop].filter((h) => !before.allowedHosts.includes(h));
  if (!removed.length) return { removed: [], notOnList: missing, hosts: before.allowedHosts, count: before.allowedHosts.length, note: 'None of these is on the list; nothing was changed. Entries are matched exactly: *.example.com and example.com are two entries.' };
  const next = before.allowedHosts.filter((h) => !drop.has(h));
  const after = await s.integrations.set(p.tenantId, { allowedHosts: next }, p.userId);
  await d.audit('tenant.hosts.updated', { tenant: p.tenantId }, ctx.label, { before: before.allowedHosts, after: after.allowedHosts, removed, reason: reason.slice(0, 500) });
  return { removed, ...(missing.length ? { notOnList: missing } : {}), hosts: after.allowedHosts, count: after.allowedHosts.length, note: next.length ? `${removed.join(', ')} can no longer be reached by the request tools.` : 'The list is now empty: the request tools reach no public host, and webhooks, workflow HTTP steps and mail channels are no longer narrowed by it.' };
}
