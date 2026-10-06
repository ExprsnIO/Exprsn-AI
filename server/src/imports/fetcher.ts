import { isIP } from 'node:net';
import { fetch, ProxyAgent, type Dispatcher } from 'undici';
import { parseAllowList, type AllowList } from '../mcp/hosts.js';
import { literalProblem, serviceAgent, servicePolicy, type ServicePolicy } from '../platform/egress.js';
import { NeedsCredential, RateLimited, SourceError } from './types.js';

/*
 * B-3801: every outbound call an import makes goes through here. The rules are the staging proxy's:
 *
 * - The host must be on the allow-list: the base host and the redirect and CDN hosts of a confirmed repository (both
 *   chosen under dual control), or IMPORT_ALLOWED_HOSTS. Redirects are followed by hand and each hop is checked again.
 * - Plain http:// only to hosts IMPORT_ALLOWED_HOSTS names (an internal mirror); everything else is https://.
 * - The credential goes only to the repository's own host on the first request, never along a redirect (a CDN).
 * - Addresses: cloud metadata addresses never, link-local only when IMPORT_ALLOWED_HOSTS names the host; the check
 *   runs inside every connection's DNS lookup, so the address dialled is the one checked. With IMPORT_PROXY_URL the
 *   connection is the proxy's, and the proxy enforces the exported allow-list (`GET /api/imports/proxy-allowlist`).
 * - 429, and 503 with Retry-After, raise `RateLimited`, which the repository turns into a backoff.
 */

export interface RepoAccess {
  /** The repository's base host: the only one that receives the credential. */
  host: string;
  /** Every host the repository may reach (base, extra), with `*.domain` entries. */
  hosts: string[];
  /** Headers carrying the credential, or none. */
  auth: () => Promise<Record<string, string>>;
}

export interface FetchInit {
  method?: 'GET' | 'HEAD' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** Resume from this byte offset (`Range: bytes=<from>-`). */
  from?: number;
  signal?: AbortSignal;
  /** Send the credential (default true; only ever to the base host). */
  auth?: boolean;
}

export interface FetchResult {
  status: number;
  url: string;
  headers: Headers;
  body: AsyncIterable<Uint8Array> | null;
  text(): Promise<string>;
}

const matches = (host: string, entry: string) => (entry.startsWith('*.') ? host.endsWith(entry.slice(1)) && host.length > entry.length - 1 : host === entry);

/** Seconds or an HTTP date, to milliseconds; null when absent or unreadable. */
export function retryAfterMs(v: string | null, now = Date.now()): number | null {
  if (!v) return null;
  if (/^\d+$/.test(v.trim())) return Number(v.trim()) * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

export class ImportFetcher {
  private readonly operator: AllowList;
  private readonly policy: ServicePolicy;
  private readonly dispatcher: Dispatcher;

  constructor(private readonly o: { allowedHosts: string; proxyUrl?: string | null; timeoutMs: number }) {
    this.operator = parseAllowList(o.allowedHosts);
    this.policy = servicePolicy({ SERVICE_ALLOWED_HOSTS: o.allowedHosts, SERVICE_INTERNAL_ONLY: false });
    const timeouts = { headersTimeout: o.timeoutMs, bodyTimeout: o.timeoutMs };
    this.dispatcher = o.proxyUrl ? new ProxyAgent({ uri: o.proxyUrl, ...timeouts }) : serviceAgent(this.policy, {}, timeouts);
  }

  get viaProxy(): boolean {
    return !!this.o.proxyUrl;
  }

  /** True when the operator's IMPORT_ALLOWED_HOSTS names the host (or its address). */
  operatorAllows(host: string): boolean {
    const h = host.toLowerCase();
    if (this.operator.hosts.some((e) => matches(h, e))) return true;
    const fam = isIP(h);
    return fam !== 0 && this.operator.networks.check(h, fam === 6 ? 'ipv6' : 'ipv4');
  }

  /** Why a repository's base URL is refused, or null. */
  baseUrlProblem(raw: string): string | null {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return 'The base URL is not a URL.';
    }
    if (u.username || u.password) return 'Credentials do not belong in the URL; record them in the vault.';
    if (u.protocol === 'http:' && !this.operatorAllows(u.hostname.replace(/^\[|\]$/g, ''))) return 'Use https://. Plain http:// is accepted only for hosts IMPORT_ALLOWED_HOSTS names (an internal mirror).';
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'The base URL must start with https://.';
    return literalProblem(raw, this.policy);
  }

  private hostAllowed(host: string, access: RepoAccess): boolean {
    return access.hosts.some((e) => matches(host, e.toLowerCase())) || this.operatorAllows(host);
  }

  /** One request, following redirects by hand (each hop checked). Never throws for an HTTP status except 429/503. */
  async request(url: string, access: RepoAccess, init: FetchInit = {}): Promise<FetchResult> {
    let current = url;
    for (let hop = 0; hop < 6; hop++) {
      let u: URL;
      try {
        u = new URL(current);
      } catch {
        throw new SourceError(`The source sent an address that is not a URL: ${current.slice(0, 200)}`);
      }
      const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      if (!this.hostAllowed(host, access)) throw new SourceError(`${host} is not on the staging-proxy allow-list for this repository. A second admin adds hosts when confirming a repository.`);
      if (u.protocol === 'http:' && !this.operatorAllows(host)) throw new SourceError(`${host} was reached over plain http://, which only IMPORT_ALLOWED_HOSTS hosts may use.`);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new SourceError(`${u.protocol} is not an allowed protocol.`);
      const literal = literalProblem(current, this.policy);
      if (literal) throw new SourceError(literal);
      const headers: Record<string, string> = { 'user-agent': 'exprsn-ai-import/1.5', ...(init.headers ?? {}) };
      // After a redirect the credential stays behind: a CDN or another host never receives it.
      if (hop > 0) delete headers.authorization;
      if (init.from) headers.range = `bytes=${init.from}-`;
      if (init.auth !== false && hop === 0 && host === access.host.toLowerCase()) Object.assign(headers, await access.auth());
      let res: Awaited<ReturnType<typeof fetch>>;
      try {
        res = await fetch(current, { method: init.method ?? 'GET', headers, body: init.body, redirect: 'manual', dispatcher: this.dispatcher, signal: init.signal ?? AbortSignal.timeout(this.o.timeoutMs) });
      } catch (err) {
        if (init.signal?.aborted) throw err;
        const cause = (err as { cause?: Error }).cause;
        throw new SourceError(`${host} could not be reached: ${(cause?.message ?? (err as Error).message).slice(0, 300)}`);
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        await res.body?.cancel().catch(() => undefined);
        current = new URL(res.headers.get('location')!, current).toString();
        continue;
      }
      if (res.status === 429 || (res.status === 503 && res.headers.get('retry-after'))) {
        await res.body?.cancel().catch(() => undefined);
        throw new RateLimited(retryAfterMs(res.headers.get('retry-after')), `${host} is rate limiting (${res.status}).`);
      }
      const body = res.body as unknown as AsyncIterable<Uint8Array> | null;
      return { status: res.status, url: current, headers: res.headers as unknown as Headers, body, text: () => res.text() };
    }
    throw new SourceError('Too many redirects.');
  }

  /** GET and parse JSON; 401/403 raise NeedsCredential, any other non-2xx SourceError. */
  async json<T = unknown>(url: string, access: RepoAccess, init: FetchInit = {}): Promise<{ body: T; headers: Headers }> {
    const r = await this.request(url, access, { ...init, headers: { accept: 'application/json', ...(init.headers ?? {}) } });
    const text = await r.text();
    check(r.status, text, url);
    try {
      return { body: JSON.parse(text) as T, headers: r.headers };
    } catch {
      throw new SourceError(`${new URL(url).host} did not answer JSON.`);
    }
  }

  /** GET text (XML, JSON-LD); same status handling as `json`. Capped at `max` characters. */
  async text(url: string, access: RepoAccess, init: FetchInit = {}, max = 32 * 1024 * 1024): Promise<{ body: string; headers: Headers }> {
    const r = await this.request(url, access, init);
    const text = await r.text();
    check(r.status, text, url);
    if (text.length > max) throw new SourceError(`${new URL(url).host} answered more than ${max} characters.`);
    return { body: text, headers: r.headers };
  }
}

function check(status: number, text: string, url: string): void {
  if (status >= 200 && status < 300) return;
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  let detail = text.slice(0, 200).replace(/\s+/g, ' ').trim();
  try {
    const j = JSON.parse(text) as { error?: unknown; message?: unknown; detail?: unknown };
    const m = j.error ?? j.message ?? j.detail;
    if (typeof m === 'string') detail = m.slice(0, 200);
  } catch {
    /* not JSON */
  }
  if (status === 401 || status === 403) throw new NeedsCredential(`${host} refused the request (${status})${detail ? `: ${detail}` : ''}.`, status);
  throw new SourceError(`${host} answered ${status}${detail ? `: ${detail}` : ''}.`, status);
}
