import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { AllowList } from '../mcp/hosts.js';
import { tenantHostProblem } from '../integrations/hosts.js';
import { isPublicAddress } from '../platform/egress.js';
import { metadataProblem } from '../platform/metadata.js';

/*
 * HTTP steps call internal hosts and, since 1.7.0 (B-9101), public hosts on the tenant's list of allowed hosts (the
 * list HTTP tools and webhooks read). The host name is resolved once, every address is checked, and the connection
 * is made to the address we checked (so a second DNS answer cannot point elsewhere). Redirects are not followed (a
 * 3xx comes back as it is, so no redirect reaches an unlisted host), and answers are capped.
 *
 * - A host whose addresses are all private (loopback when allowed): the operator's WORKFLOW_HTTP_HOSTS narrows it,
 *   and the tenant's list narrows it further when it has entries (B-303).
 * - A host whose addresses are all public: only when the tenant's list names it (or a network holding every
 *   address). The list is read for each call, so a host removed from it fails the next step.
 * - Cloud metadata, link-local, unspecified and multicast addresses, and a host that answers with both internal and
 *   public addresses: never. Since 1.9.99-final (B-10705) the metadata names and addresses of `platform/metadata.ts`
 *   are refused first, before WORKFLOW_HTTP_HOSTS or the tenant's list is read: `fd00:ec2::254` is in fc00::/7 and
 *   `168.63.129.16` is public, so neither the internal rule nor an allow-list entry may admit them.
 */

export class HttpStepError extends Error {}

/** B-10705: the step's wording of a metadata refusal (it is neither an internal nor a public address). */
const stepMetadata = (m: string) => m.replace(/ and is always refused\.$/, ', not an internal address or a public one, and is never called, whatever a list of allowed hosts names.');

const v4 = (ip: string) => ip.split('.').map(Number) as [number, number, number, number];

/** Private (RFC 1918, unique local) addresses; loopback only when allowed. Link-local (cloud metadata) never. */
export function isInternalAddress(ip: string, allowLoopback: boolean): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = v4(ip);
    if (a === 127) return allowLoopback;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const x = ip.toLowerCase();
  if (x === '::1') return allowLoopback;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
  if (mapped) return isInternalAddress(mapped[1]!, allowLoopback);
  return /^f[cd][0-9a-f]{2}:/.test(x); // fc00::/7
}

export function hostAllowed(host: string, allow: readonly string[]): boolean {
  if (!allow.length) return true;
  const h = host.toLowerCase();
  return allow.some((a) => (a.startsWith('.') ? h.endsWith(a) || h === a.slice(1) : h === a));
}

export interface InternalRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  allowHosts: readonly string[];
  allowLoopback: boolean;
  maxBytes?: number;
  /** The tenant's own allow-list (B-303): when it has entries, an internal host must be on it as well; a public host must always be on it (B-9101). */
  tenantAllow?: AllowList | null;
  /** Tests only: stands in for DNS, and for the route to an address, so a suite can serve a "public" host locally. The address checked is still the one resolved. */
  net?: HttpStepNet;
}

export interface HttpStepNet {
  resolve?: (host: string) => Promise<{ address: string; family: number }[]>;
  dial?: (address: string) => { address: string; family: number } | null;
}

export interface InternalResponse {
  status: number;
  body: unknown;
  contentType: string | null;
}

export async function internalRequest(r: InternalRequest): Promise<InternalResponse> {
  let url: URL;
  try {
    url = new URL(r.url);
  } catch {
    throw new HttpStepError(`Not a valid URL: ${r.url.slice(0, 200)}`);
  }
  if (!/^https?:$/.test(url.protocol)) throw new HttpStepError('Only http:// and https:// are allowed.');
  if (url.username || url.password) throw new HttpStepError('Credentials in the URL are not allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const named = metadataProblem(host.toLowerCase());
  if (named) throw new HttpStepError(stepMetadata(named));
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await (r.net?.resolve ? r.net.resolve(host) : lookup(host, { all: true })).catch(() => []);
  if (!addrs.length) throw new HttpStepError(`${host} does not resolve.`);
  for (const a of addrs) {
    const meta = metadataProblem(host.toLowerCase(), a.address);
    if (meta) throw new HttpStepError(stepMetadata(meta));
  }
  const outside = addrs.filter((a) => !isInternalAddress(a.address, r.allowLoopback));
  if (!outside.length) {
    if (!hostAllowed(host, r.allowHosts)) throw new HttpStepError(`${host} is not on the list of hosts workflows may call.`);
    const refused = tenantHostProblem(host, addrs.map((a) => a.address), r.tenantAllow ?? null);
    if (refused) throw new HttpStepError(refused);
  } else {
    const shown = (ip: string) => (host === ip ? ip : `${host} resolves to ${ip}, which`);
    const never = outside.find((a) => !isPublicAddress(a.address));
    if (never) throw new HttpStepError(`${shown(never.address)} is not an internal address or a public one (loopback, link-local and cloud metadata addresses are never called).`);
    if (outside.length !== addrs.length) throw new HttpStepError(`${host} resolves to both internal and public addresses and is refused.`);
    const list = r.tenantAllow ?? null;
    if (!list || list.empty || tenantHostProblem(host, addrs.map((a) => a.address), list)) throw new HttpStepError(`${host} is a public host that is not on this tenant's list of allowed hosts. A tenant admin adds it under Registry, Allowed hosts.`);
  }
  const target = r.net?.dial?.(addrs[0]!.address) ?? addrs[0]!;
  const max = r.maxBytes ?? 1024 * 1024;

  return new Promise<InternalResponse>((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(
      url,
      {
        method: r.method,
        headers: { 'user-agent': 'exprsn-ai-workflow', ...(r.headers ?? {}), ...(r.body != null ? { 'content-length': Buffer.byteLength(r.body) } : {}) },
        // Connect to the address that was checked, whatever the name resolves to now.
        lookup: (_h, opts, cb) => {
          if ((opts as { all?: boolean }).all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [target]);
          else cb(null, target.address, target.family);
        },
        timeout: r.timeoutMs,
        ...(r.signal ? { signal: r.signal } : {})
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > max) {
            req.destroy(new HttpStepError(`The answer is larger than ${Math.round(max / 1024)} KB.`));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const type = res.headers['content-type'] ?? null;
          let body: unknown = text;
          if (type && /json/.test(type)) {
            try {
              body = JSON.parse(text);
            } catch {
              body = text;
            }
          }
          resolve({ status: res.statusCode ?? 0, body, contentType: type });
        });
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new HttpStepError(`No answer within ${r.timeoutMs} ms.`)));
    req.on('error', (err) => reject(err instanceof HttpStepError ? err : new HttpStepError(`The request failed: ${err.message}`)));
    if (r.body != null) req.write(r.body);
    req.end();
  });
}
