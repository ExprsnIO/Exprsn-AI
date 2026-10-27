import { guardedRequest, serviceAddressProblem, servicePolicy, ServiceUrlRefused, type GuardedResponse } from '../platform/egress.js';
import type { Config } from '../config/index.js';

/*
 * 1.9.99-final, Sprint 56 (B-10003 to B-10006): the one way the credential code calls out (STS, IAM, Entra, Microsoft
 * Graph, the issuer's publication targets). Every call goes through the egress guard (`guardedRequest`): the host is
 * resolved once, every address is checked against the operator's service policy (metadata addresses never), the
 * connection is pinned to the checked address, redirects are not followed and the answer is capped. Request and
 * response bodies are never logged: they carry tokens and keys.
 */

export class CloudCallError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** The provider's own error code, when it gave one (AccessDenied, invalid_client...). */
    readonly code: string | null = null
  ) {
    super(message);
  }
}

export interface CloudHttp {
  request(r: { method: string; url: string | URL; headers?: Record<string, string>; body?: string | Buffer; maxBytes?: number }): Promise<GuardedResponse>;
}

/** A guarded client under the operator's service policy (SERVICE_ALLOWED_HOSTS, SERVICE_INTERNAL_ONLY). */
export function cloudHttp(cfg: Pick<Config, 'SERVICE_ALLOWED_HOSTS' | 'SERVICE_INTERNAL_ONLY' | 'CLOUD_HTTP_TIMEOUT_MS'>): CloudHttp {
  const policy = servicePolicy(cfg);
  return {
    async request(r) {
      const url = typeof r.url === 'string' ? new URL(r.url) : r.url;
      try {
        return await guardedRequest({
          method: r.method,
          url,
          headers: { 'user-agent': 'exprsn-ai-cloud', ...(r.headers ?? {}) },
          ...(r.body != null ? { body: r.body } : {}),
          timeoutMs: cfg.CLOUD_HTTP_TIMEOUT_MS,
          maxBytes: r.maxBytes ?? 2 * 1024 * 1024,
          check: (address, host) => serviceAddressProblem(address, host, policy)
        });
      } catch (err) {
        if (err instanceof ServiceUrlRefused) throw new CloudCallError(`${url.host} was refused: ${err.message}`, 502, 'egress-refused');
        throw new CloudCallError(`${url.host} did not answer: ${(err as Error).message}`, 502, 'unreachable');
      }
    }
  };
}

/** The text of one XML element (the first), entities decoded; enough for the AWS Query API's answers. */
export function xmlText(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  if (!m) return null;
  return m[1]!.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
}

/** Every occurrence of an element's inner XML. */
export function xmlAll(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(m[1]!);
  return out;
}

export const form = (o: Record<string, string>): string => new URLSearchParams(o).toString();
