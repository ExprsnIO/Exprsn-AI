import { fetch as undiciFetch, type Dispatcher } from 'undici';
import { literalProblem, serviceAgent, ServiceUrlRefused, type ServicePolicy } from '../platform/egress.js';

/*
 * External moderation providers (B-1906). Off by default (MODERATION_EXTERNAL_PROVIDERS), registered per tenant in a
 * zone whose egress reaches outside the site, and run in shadow (the verdict is recorded, nothing happens) or enforce
 * (a flagged verdict files a flag and hides the object). Two wire formats:
 *
 * - `json`: POST {url} with `{ "input": text, "type": objectType }`, answered `{ "flagged": bool, "score"?: 0..1,
 *   "categories"?: string[] }`.
 * - `openai`: the OpenAI moderation API shape: POST {url} with `{ "input": text }`, answered `{ "results": [{ "flagged",
 *   "categories": {name: bool}, "category_scores": {name: number} }] }`.
 *
 * The key goes as `Authorization: Bearer`. Every connection goes through the service address checks
 * (`SERVICE_ALLOWED_HOSTS`, `SERVICE_INTERNAL_ONLY`): cloud metadata and link-local addresses are always refused.
 */

export type ProviderKind = 'json' | 'openai';

export interface ProviderVerdict {
  flagged: boolean;
  score: number | null;
  categories: string[];
}

export interface ProviderCall {
  kind: ProviderKind;
  url: string;
  secret: string | null;
  text: string;
  objectType: string;
  threshold: number;
}

export interface ModerationProviderClient {
  classify(call: ProviderCall): Promise<ProviderVerdict>;
  close(): Promise<void>;
}

const MAX_BYTES = 256 * 1024;
const MAX_INPUT = 32_000;

export class HttpModerationProviders implements ModerationProviderClient {
  private agent: Dispatcher | null = null;

  constructor(
    private readonly policy: () => ServicePolicy,
    private readonly timeoutMs: number
  ) {}

  private dispatcher(): Dispatcher {
    return (this.agent ??= serviceAgent(this.policy(), {}, { headersTimeout: this.timeoutMs, bodyTimeout: this.timeoutMs }));
  }

  async classify(call: ProviderCall): Promise<ProviderVerdict> {
    const refused = literalProblem(call.url, this.policy());
    if (refused) throw new ServiceUrlRefused(refused);
    const input = call.text.slice(0, MAX_INPUT);
    const res = await undiciFetch(call.url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', ...(call.secret ? { authorization: `Bearer ${call.secret}` } : {}) },
      body: JSON.stringify(call.kind === 'openai' ? { input } : { input, type: call.objectType }),
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
      dispatcher: this.dispatcher()
    });
    const chunks: Buffer[] = [];
    let size = 0;
    if (res.body) {
      for await (const c of res.body) {
        size += (c as Uint8Array).length;
        if (size > MAX_BYTES) throw new Error('The provider answered with too much data.');
        chunks.push(Buffer.from(c as Uint8Array));
      }
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`The provider answered ${res.status}.`);
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new Error('The provider did not answer with JSON.');
    }
    return parseVerdict(call.kind, body, call.threshold);
  }

  async close(): Promise<void> {
    await this.agent?.close();
    this.agent = null;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9/-]+/g, '-').slice(0, 60);

/** Reads a provider's answer; a score at or above the threshold counts as flagged even when the provider said not. */
export function parseVerdict(kind: ProviderKind, body: unknown, threshold: number): ProviderVerdict {
  if (!isObj(body)) throw new Error('The provider answer is not an object.');
  if (kind === 'openai') {
    const r = Array.isArray(body.results) && isObj(body.results[0]) ? body.results[0] : null;
    if (!r || typeof r.flagged !== 'boolean') throw new Error('The provider answer has no results[0].flagged.');
    const cats = isObj(r.categories) ? Object.entries(r.categories).filter(([, v]) => v === true).map(([k]) => clean(k)) : [];
    const scores = isObj(r.category_scores) ? Object.values(r.category_scores).filter((v): v is number => typeof v === 'number' && Number.isFinite(v)) : [];
    const score = scores.length ? Math.max(...scores) : null;
    return { flagged: r.flagged || (score != null && score >= threshold), score, categories: cats.slice(0, 20) };
  }
  if (typeof body.flagged !== 'boolean') throw new Error('The provider answer has no flagged field.');
  const score = typeof body.score === 'number' && Number.isFinite(body.score) ? Math.min(1, Math.max(0, body.score)) : null;
  const cats = Array.isArray(body.categories) ? body.categories.filter((c): c is string => typeof c === 'string').map(clean) : [];
  return { flagged: body.flagged || (score != null && score >= threshold), score, categories: cats.slice(0, 20) };
}
