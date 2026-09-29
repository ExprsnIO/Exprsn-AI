import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

/*
 * HTTP steps may only call internal hosts. The host name is resolved once, every address must be private, and the
 * connection is made to the address we checked (so a second DNS answer cannot point elsewhere). Redirects are not
 * followed, answers are capped, and an optional allow-list narrows the hosts further.
 */

export class HttpStepError extends Error {}

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
  method: 'GET' | 'POST' | 'PUT';
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  allowHosts: readonly string[];
  allowLoopback: boolean;
  maxBytes?: number;
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
  if (!hostAllowed(host, r.allowHosts)) throw new HttpStepError(`${host} is not on the list of hosts workflows may call.`);
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new HttpStepError(`${host} does not resolve.`);
  const bad = addrs.find((a) => !isInternalAddress(a.address, r.allowLoopback));
  if (bad) throw new HttpStepError(`${host} resolves to ${bad.address}, which is not an internal address. HTTP steps only call internal hosts.`);
  const target = addrs[0]!;
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
