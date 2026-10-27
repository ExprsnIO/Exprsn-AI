/*
 * 1.9.99-final, Sprint 61 (B-10908): an in-process stand-in for Cloudflare AI Gateway
 * (`/v1/<account>/<gateway>/<provider>/...`). It checks the gateway token (`cf-aig-authorization`), passes the
 * request on to the provider's fake (`upstream`, per provider: workers-ai, azure-openai, custom-digitalocean,
 * aws-bedrock) with every header but its own, and behaves as the gateway does with what it saw: a request is logged
 * (prompt and answer, in `logs`) unless `cf-aig-collect-log: false`; an answer is cached and served again
 * (`cf-aig-cache-status: HIT`) unless `cf-aig-skip-cache: true`. `fallback` makes it answer as a fallback step
 * (`cf-aig-step`, `cf-aig-model`), as a gateway-side fallback would. It is never the real Cloudflare.
 */
import { createHash } from 'node:crypto';
import { FakeCloudBase, type RecordedRequest, type Reply } from './fake-cloud-base.js';

export interface GatewayLog {
  provider: string;
  path: string;
  /** The request body as sent (the prompt) and the answer's first bytes. */
  request: string;
  response: string;
}

export class FakeAiGateway extends FakeCloudBase {
  accountId = '';
  gatewayId = '';
  readonly tokens = new Set<string>();
  /** Where each provider's calls go: the provider's fake URL for the rest of the path. */
  readonly upstream = new Map<string, (rest: string, query: string) => string>();
  readonly logs: GatewayLog[] = [];
  private readonly cache = new Map<string, Reply>();
  /** Answer as fallback step `step` with `model` (a gateway-side fallback); null: as the requested provider. */
  fallback: { step: string; model: string } | null = null;

  protected classify(r: Omit<RecordedRequest, 'op'>): string {
    const m = /^\/v1\/[^/]+\/[^/]+\/([^/]+)\//.exec(r.path);
    return `aig:${m?.[1] ?? 'unknown'}`;
  }

  protected throttleReply(_r: RecordedRequest, retryAfterS: number): Reply {
    return { status: 429, headers: { 'retry-after': String(retryAfterS) }, body: { success: false, error: [{ code: 2003, message: 'Rate limited' }] } };
  }

  protected async handle(r: RecordedRequest): Promise<Reply> {
    const m = /^\/v1\/([^/]+)\/([^/]+)\/([^/]+)(\/.*)$/.exec(r.path);
    if (!m) return { status: 404, body: { success: false, error: [{ code: 2001, message: 'Not found' }] } };
    const [, account, gateway, provider, rest] = m;
    if (account !== this.accountId || gateway !== this.gatewayId) return { status: 404, body: { success: false, error: [{ code: 2001, message: 'Gateway not found' }] } };
    const token = /^Bearer (.+)$/.exec(r.headers['cf-aig-authorization'] ?? '')?.[1];
    if (!token || !this.tokens.has(token)) return { status: 401, body: { success: false, error: [{ code: 2009, message: 'Unauthorized' }] } };
    const to = this.upstream.get(provider!);
    if (!to) return { status: 400, body: { success: false, error: [{ code: 2008, message: `Unknown provider ${provider}` }] } };
    const query = r.query.toString();
    const skipCache = r.headers['cf-aig-skip-cache'] === 'true';
    const collect = r.headers['cf-aig-collect-log'] !== 'false';
    const key = createHash('sha256').update(`${provider}|${rest}|${query}|${r.raw?.toString('base64') ?? r.body}`).digest('hex');
    let reply: Reply;
    const cached = skipCache ? undefined : this.cache.get(key);
    if (cached) reply = { ...cached, headers: { ...(cached.headers ?? {}), 'cf-aig-cache-status': 'HIT' } };
    else {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(r.headers)) if (!/^(host|content-length|connection|cf-aig-.*)$/i.test(k)) headers[k] = v;
      const res = await fetch(to(rest!, query ? `?${query}` : ''), { method: r.method, headers, ...(r.method === 'GET' || r.method === 'HEAD' ? {} : { body: new Uint8Array(r.raw ?? Buffer.from(r.body)) }) });
      const body = Buffer.from(await res.arrayBuffer());
      const out: Record<string, string> = { 'cf-aig-cache-status': skipCache ? 'BYPASS' : 'MISS' };
      const ct = res.headers.get('content-type');
      if (ct) out['content-type'] = ct;
      for (const h of ['x-amzn-requestid', 'x-amzn-errortype', 'x-amzn-bedrock-input-token-count']) {
        const v = res.headers.get(h);
        if (v) out[h] = v;
      }
      reply = { status: res.status, headers: out, body };
      if (!skipCache && res.status === 200) this.cache.set(key, reply);
    }
    if (collect) this.logs.push({ provider: provider!, path: rest!, request: r.body, response: Buffer.isBuffer(reply.body) ? reply.body.subarray(0, 2000).toString('utf8') : String(reply.body ?? '') });
    if (this.fallback) reply = { ...reply, headers: { ...(reply.headers ?? {}), 'cf-aig-step': this.fallback.step, 'cf-aig-model': this.fallback.model } };
    return reply;
  }

  override reset(): void {
    super.reset();
    this.logs.length = 0;
    this.cache.clear();
    this.fallback = null;
  }
}
