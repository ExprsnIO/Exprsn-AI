import { CLOUD_PROVIDER_HOSTS, cloudAddressProblem, guardedRequest, guardedStream, ServiceUrlRefused, type GuardedResponse, type ServicePolicy } from '../../platform/egress.js';
import { Limiter, MemoryCounterStore, type CounterStore } from '../../platform/ratelimit.js';
import type { Provider } from '../types.js';
import { CloudProviderError } from './types.js';

/*
 * 1.9.99-final, Sprint 56 (B-10101), refined in Sprint 57 (B-10108): the one way an adapter reaches a provider. Every
 * call, whether an adapter makes it itself (DigitalOcean, Cloudflare) or an SDK does (AWS SDK v3 through
 * `smithyHandler`, the Azure ARM clients through `azureHttpClient`), goes through `CloudTransport.send`:
 *
 * 1. the API class of the call (`apiClassOf`: `read`, `list` for list and describe-heavy calls, `mutate`, `billing`),
 *    from the method, the URL and, for AWS, the action;
 * 2. the circuit breaker per provider and account: after `failures` 5xx answers or timeouts in a row it opens and
 *    calls fail at once (`503 circuit_open`) for `openMs`; then one probe goes through (half-open), and its answer
 *    closes the breaker or opens it again;
 * 3. the shared rate limiter, on the counter store (`platform/ratelimit.ts`, Redis when REDIS_URL is set, so every
 *    instance counts together): a token bucket per account, provider and API class plus the account's total for the
 *    provider (and DigitalOcean's hourly allowance). Each bucket refills in slices (`slices` per window, each may spend
 *    twice its share), so a window never admits a burst of its whole allowance at its start. A call over a bucket waits for the slice, and is refused
 *    locally (`429 rate_limited`) only when the wait would pass `maxQueueWaitMs`. Providers that report what is left
 *    (`x-ms-ratelimit-remaining-*` on ARM, DigitalOcean's `ratelimit-remaining`) hold that class back once it is low;
 * 4. the egress guard (`guardedRequest` with `cloudAddressProblem`): only the provider's API hosts or hosts the
 *    operator names in SERVICE_ALLOWED_HOSTS, never a metadata address, an internal address only when named, plain
 *    `http:` only to a named host; the connection is pinned to the checked address and redirects are not followed;
 * 5. retries of throttled calls, honouring `Retry-After` (seconds or a date), `x-ms-retry-after-ms`, DigitalOcean's
 *    `ratelimit-reset`, AWS's throttling error codes (body or `x-amzn-errortype`), else exponential backoff with full
 *    jitter; transport errors and 5xx answers are retried only for calls that change nothing (every class but
 *    `mutate`, so AWS's POSTed Describe calls are retried too).
 *
 * Waits, outcomes and breaker changes go to `metrics` (`cloud/limits-metrics.ts` registers them for Prometheus). The
 * breaker and the holds live in this process; the buckets are shared. The SDKs' own retries are turned off (AWS
 * `maxAttempts: 1`, Azure `retryOptions.maxRetries: 0`), so this is the only retry layer, and their default HTTP
 * clients are never built. Bodies are never logged.
 */

export const API_CLASSES = ['read', 'list', 'mutate', 'billing'] as const;
export type ApiClass = (typeof API_CLASSES)[number];

export interface BucketLimit {
  points: number;
  windowMs: number;
}

export interface BreakerOptions {
  /** 5xx answers or timeouts in a row that open the breaker (default 5). */
  failures?: number;
  /** How long it stays open before one probe is let through (default 30 s). */
  openMs?: number;
}

export type BreakerState = 'closed' | 'open' | 'half_open';

export type WaitReason = 'limiter' | 'retry' | 'hold';
export type CallOutcome = 'ok' | 'error' | 'throttled' | 'unreachable' | 'refused' | 'rate_limited' | 'circuit_open';

/** Where the transport reports waits, outcomes and breaker changes (`cloud/limits-metrics.ts` for Prometheus). */
export interface TransportMetrics {
  waited(provider: Provider, apiClass: ApiClass, reason: WaitReason, ms: number): void;
  called(provider: Provider, apiClass: ApiClass, outcome: CallOutcome): void;
  breaker(provider: Provider, accountId: string, from: BreakerState, to: BreakerState): void;
}

export interface TransportOptions {
  provider: Provider;
  policy: ServicePolicy;
  /** The shared counter store (`s.counters`); a private memory store when absent. */
  counters?: CounterStore;
  /** The account's total for the provider (default per provider, under each provider's published limits). */
  limit?: BucketLimit;
  /** Per API class (defaults in `DEFAULT_CLASS_LIMITS`). */
  classLimits?: Partial<Record<ApiClass, BucketLimit>>;
  /** Refill slices per window (default 6; 1 is a plain fixed window). */
  slices?: number;
  /** The circuit breaker (default on); `false` turns it off. */
  breaker?: BreakerOptions | false;
  /** A provider's "remaining" header at or below this holds the class back (default 2). */
  lowWater?: number;
  metrics?: TransportMetrics;
  timeoutMs?: number;
  maxBytes?: number;
  maxAttempts?: number;
  /** A retry that would wait longer than this is not made; the throttled answer is returned. */
  maxRetryWaitMs?: number;
  /** The longest a call waits for the rate limiter before it is refused locally. */
  maxQueueWaitMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  /** The clock of the breaker and the holds (tests). */
  now?: () => number;
  /**
   * Tests only: calls for an origin go to another (`{ 'https://management.azure.com': 'http://127.0.0.1:4321' }`), for
   * clients that insist on https (the Azure pipeline sends a bearer token to https only). The egress guard checks the
   * address actually dialled, and plain http still needs the host named in SERVICE_ALLOWED_HOSTS.
   */
  testOrigins?: Record<string, string>;
}

export interface CloudRequest {
  method: string;
  url: URL | string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** The account the call is for: the rate limiter's and the breaker's key. */
  accountId: string;
  /** The API class, when the caller knows better than `apiClassOf`. */
  apiClass?: ApiClass;
  signal?: AbortSignal;
  /** 1.9.99-final (B-10203): the CA of a host with a private one (a Kubernetes cluster's API server). */
  ca?: string | Buffer;
  /**
   * 1.9.99-final (B-10501): read a 2xx answer as it arrives (`CloudResponse.stream`; `body` is then empty). An error
   * answer is still read whole, so throttling and retries work as for any call.
   */
  stream?: boolean;
  /** The idle time allowed for this call (default the transport's `timeoutMs`): a model's first token can take minutes. */
  timeoutMs?: number;
  /** 1.9.99-final, Sprint 61 (B-10908): a model call sent through Cloudflare AI Gateway, whose host is admitted too. */
  via?: 'ai-gateway';
}

export interface CloudResponse extends GuardedResponse {
  attempts: number;
  /** The provider's request id header, when it sent one. */
  requestId: string | null;
  apiClass: ApiClass;
  /** B-10501: the body's chunks, for a `stream` call that answered 2xx (read once; `abort` stops it early). */
  stream?: AsyncIterable<Buffer>;
  abort?: () => void;
}

export interface TransportStats {
  calls: number;
  attempts: number;
  throttled: number;
  retries: number;
  limiterWaits: number;
  waitedMs: number;
  refused: number;
  /** Calls per API class. */
  byClass: Record<ApiClass, number>;
  /** Calls refused locally by the limiter (the wait would have been too long). */
  rateLimited: number;
  /** Times a provider's remaining-calls header held a class back. */
  holds: number;
  breakerOpened: number;
  /** Calls refused at once because the breaker was open. */
  circuitRefused: number;
}

/** Calls per minute per account, under each provider's own limits (DigitalOcean 250/min, Cloudflare 1200/5 min, ARM 12000 reads/h...). */
export const DEFAULT_LIMITS: Record<Provider, BucketLimit> = {
  aws: { points: 1200, windowMs: 60_000 },
  azure: { points: 1000, windowMs: 60_000 },
  digitalocean: { points: 240, windowMs: 60_000 },
  cloudflare: { points: 200, windowMs: 60_000 }
};

/** Longer allowances beside the per-minute total: DigitalOcean's 5,000 calls an hour. */
export const DEFAULT_HOURLY: Partial<Record<Provider, BucketLimit>> = {
  digitalocean: { points: 4800, windowMs: 3_600_000 }
};

/**
 * Per API class and account, per minute: mutating calls and billing queries get a smaller share than reads (EC2's
 * mutating buckets are smaller than its describe buckets; ARM writes are a tenth of reads; Cost Explorer, Cost
 * Management and DigitalOcean's billing endpoints allow a few calls a minute).
 */
export const DEFAULT_CLASS_LIMITS: Record<Provider, Record<ApiClass, BucketLimit>> = {
  aws: { read: { points: 1200, windowMs: 60_000 }, list: { points: 600, windowMs: 60_000 }, mutate: { points: 300, windowMs: 60_000 }, billing: { points: 60, windowMs: 60_000 } },
  azure: { read: { points: 1000, windowMs: 60_000 }, list: { points: 500, windowMs: 60_000 }, mutate: { points: 300, windowMs: 60_000 }, billing: { points: 30, windowMs: 60_000 } },
  digitalocean: { read: { points: 240, windowMs: 60_000 }, list: { points: 240, windowMs: 60_000 }, mutate: { points: 120, windowMs: 60_000 }, billing: { points: 30, windowMs: 60_000 } },
  cloudflare: { read: { points: 200, windowMs: 60_000 }, list: { points: 200, windowMs: 60_000 }, mutate: { points: 100, windowMs: 60_000 }, billing: { points: 20, windowMs: 60_000 } }
};

const AWS_THROTTLE = /<Code>(Throttling|ThrottlingException|ThrottledException|RequestLimitExceeded|RequestThrottled|RequestThrottledException|TooManyRequestsException|SlowDown|PriorRequestNotComplete|BandwidthLimitExceeded|ProvisionedThroughputExceededException|EC2ThrottledException)<\/Code>|"__type"\s*:\s*"[^"]*(Throttling|TooManyRequests)[^"]*"|"code"\s*:\s*"[^"]*(Throttling|TooManyRequests)[^"]*"/;
const AWS_THROTTLE_TYPE = /Throttl|TooManyRequests|RequestLimitExceeded|SlowDown/;

const sleepFor = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(resolve, ms);
    t.unref?.();
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason ?? new Error('aborted'))), { once: true });
  });

const REQUEST_ID_HEADERS = ['x-amzn-requestid', 'x-amz-request-id', 'x-amz-id-2', 'x-ms-request-id', 'x-ms-correlation-request-id', 'x-request-id', 'cf-ray'];

const AWS_LIST = /^(Describe|List)/;
const AWS_READ = /^(Get|Simulate|Lookup|Search|Check|Validate|Head|Estimate)/;
const PAGING = ['page', 'per_page', '$skiptoken', '$skipToken', '$top', 'cursor', 'max-items', 'maxitems', 'list-type', 'marker'];

function awsAction(url: URL, headers: Record<string, string>, body?: string | Buffer): string {
  const target = headers['x-amz-target'];
  if (target) return target.split('.').pop() ?? '';
  const q = url.searchParams.get('Action');
  if (q) return q;
  if (body != null) {
    const text = typeof body === 'string' ? body.slice(0, 2048) : body.toString('utf8', 0, 2048);
    const m = /(?:^|&)Action=([A-Za-z0-9]+)/.exec(text);
    if (m) return m[1]!;
  }
  return '';
}

/**
 * The API class of a call: `billing` (Cost Explorer, Pricing, Budgets, Cost Management and Consumption, DigitalOcean
 * `/v2/customers/my/`, Cloudflare `/billing/`), `list` (AWS Describe and List actions, a collection read, a paged
 * read), `read` (any other call that changes nothing) or `mutate`.
 */
export function apiClassOf(provider: Provider, method: string, url: URL, headers: Record<string, string> = {}, body?: string | Buffer): ApiClass {
  const m = method.toUpperCase();
  const path = url.pathname;
  const host = url.hostname.toLowerCase();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const target = lower['x-amz-target'] ?? '';
  if (
    /\/providers\/Microsoft\.(CostManagement|Consumption|Billing|CommerceBilling)\b/i.test(path) ||
    (provider === 'digitalocean' && /^\/v2\/customers\/my\//.test(path)) ||
    (provider === 'cloudflare' && /\/billing\//.test(path)) ||
    (provider === 'aws' && (/^(ce|pricing|api\.pricing|budgets|cur)\./.test(host) || /^(AWSInsightsIndexService|AWSPriceListService|AWSBudgetServiceGateway)\./.test(target)))
  )
    return 'billing';
  const safe = m === 'GET' || m === 'HEAD';
  if (provider === 'aws') {
    const action = awsAction(url, lower, body);
    if (action) return AWS_LIST.test(action) ? 'list' : AWS_READ.test(action) ? 'read' : 'mutate';
    if (!safe) return 'mutate';
    // S3 subresources (`?tagging`, `?location`, `?policy`) are reads of one thing; a bucket's root otherwise lists it.
    if ([...url.searchParams].some(([k, v]) => v === '' && !PAGING.includes(k))) return 'read';
    if (PAGING.some((p) => url.searchParams.has(p)) || path === '/' || /\/(rrset|hostedzone|hostedzones|healthcheck)$/.test(path)) return 'list';
    return 'read';
  }
  if (!safe) return 'mutate';
  if (PAGING.some((p) => url.searchParams.has(p))) return 'list';
  const segs = path.split('/').filter(Boolean);
  // ARM paths alternate a key and its value (subscriptions/{id}/resourceGroups/{rg}/providers/{ns}/{type}/{name}):
  // an odd number of segments ends with a type, which is a collection.
  if (provider === 'azure') return segs.length % 2 === 1 ? 'list' : 'read';
  const last = segs.at(-1) ?? '';
  return /^[A-Za-z][A-Za-z_]*s$/.test(last) ? 'list' : 'read';
}

/** A token bucket on the counter store: the window's allowance, refilled in slices. */
class Bucket {
  private readonly whole: Limiter;
  private readonly slice: Limiter | null;
  constructor(store: CounterStore, name: string, limit: BucketLimit, slices: number) {
    this.whole = new Limiter(store, name, limit.points, limit.windowMs);
    const n = Math.max(1, Math.min(slices, limit.points));
    // A slice may spend up to twice its share, so a short burst (a permission check's probes) is not slowed, while
    // no span of one window ever sees more than the allowance and one slice's burst.
    this.slice = n > 1 ? new Limiter(store, `${name}:s`, Math.min(limit.points, Math.ceil((2 * limit.points) / n)), Math.max(1, Math.floor(limit.windowMs / n))) : null;
  }
  /** Null when admitted, else how long to wait. */
  async take(key: string): Promise<number | null> {
    if (this.slice) {
      const s = await this.slice.consume(key);
      if (!s.allowed) return Math.max(1, s.resetMs);
    }
    const w = await this.whole.consume(key);
    return w.allowed ? null : Math.max(1, w.resetMs);
  }
}

interface BreakerEntry {
  state: BreakerState;
  failures: number;
  openedAt: number;
  probing: boolean;
}

export class CloudTransport {
  readonly stats: TransportStats = { calls: 0, attempts: 0, throttled: 0, retries: 0, limiterWaits: 0, waitedMs: 0, refused: 0, byClass: { read: 0, list: 0, mutate: 0, billing: 0 }, rateLimited: 0, holds: 0, breakerOpened: 0, circuitRefused: 0 };
  private readonly accountBuckets: Bucket[];
  private readonly classBuckets: Record<ApiClass, Bucket>;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly breakers = new Map<string, BreakerEntry>();
  /** `<class>:<account>` (or `*:<account>`) → held until. */
  private readonly holdUntil = new Map<string, number>();

  constructor(readonly o: TransportOptions) {
    const store = o.counters ?? new MemoryCounterStore();
    const slices = o.slices ?? 6;
    const hourly = o.limit ? undefined : DEFAULT_HOURLY[o.provider];
    this.accountBuckets = [new Bucket(store, `cloud:${o.provider}`, o.limit ?? DEFAULT_LIMITS[o.provider], slices), ...(hourly ? [new Bucket(store, `cloud:${o.provider}:h`, hourly, 1)] : [])];
    const classes = { ...DEFAULT_CLASS_LIMITS[o.provider], ...(o.classLimits ?? {}) };
    this.classBuckets = Object.fromEntries(API_CLASSES.map((c) => [c, new Bucket(store, `cloud:${o.provider}:${c}`, classes[c], slices)])) as Record<ApiClass, Bucket>;
    this.sleep = o.sleep ?? sleepFor;
    this.random = o.random ?? Math.random;
    this.now = o.now ?? Date.now;
  }

  get provider(): Provider {
    return this.o.provider;
  }

  /** Whether an answer is the provider's throttling signal. */
  throttled(res: Pick<GuardedResponse, 'status' | 'body' | 'headers'>): boolean {
    if (res.status === 429) return true;
    if (this.o.provider === 'aws') {
      if (res.status !== 400 && res.status !== 503) return false;
      const type = res.headers['x-amzn-errortype'];
      if (type && AWS_THROTTLE_TYPE.test(type)) return true;
      return AWS_THROTTLE.test(res.body.toString('utf8', 0, 4096));
    }
    return res.status === 503 && res.headers['retry-after'] != null;
  }

  /** How long the provider asks us to wait, in ms, or null when it does not say. */
  retryAfterMs(res: Pick<GuardedResponse, 'headers'>, now = Date.now()): number | null {
    const h = res.headers;
    const ms = h['x-ms-retry-after-ms'] ?? h['retry-after-ms'];
    if (ms && /^\d+$/.test(ms)) return Number(ms);
    const ra = h['retry-after'];
    if (ra) {
      if (/^\d+(\.\d+)?$/.test(ra.trim())) return Math.ceil(Number(ra) * 1000);
      const at = Date.parse(ra);
      if (!Number.isNaN(at)) return Math.max(0, at - now);
    }
    const reset = h['ratelimit-reset'];
    if (reset && /^\d+$/.test(reset) && h['ratelimit-remaining'] === '0') return Math.max(0, Number(reset) * 1000 - now);
    return null;
  }

  private backoff(attempt: number): number {
    return Math.floor(this.random() * Math.min(20_000, 250 * 2 ** attempt));
  }

  /** The breaker's state for an account (`closed` when it never saw a failure). */
  breakerState(accountId: string): BreakerState {
    const b = this.breakers.get(accountId);
    if (!b) return 'closed';
    if (b.state === 'open' && this.now() - b.openedAt >= this.breakerOptions().openMs) return 'half_open';
    return b.state;
  }

  private breakerOptions(): Required<BreakerOptions> {
    const b = this.o.breaker || {};
    return { failures: b.failures ?? 5, openMs: b.openMs ?? 30_000 };
  }

  private move(accountId: string, b: BreakerEntry, to: BreakerState): void {
    const from = b.state;
    if (from === to) return;
    b.state = to;
    if (to === 'open') {
      b.openedAt = this.now();
      this.stats.breakerOpened += 1;
    }
    this.o.metrics?.breaker(this.o.provider, accountId, from, to);
  }

  /** Before an attempt: refuses at once while open; lets one probe through once the open time has passed. */
  private gate(accountId: string, apiClass: ApiClass): void {
    if (this.o.breaker === false) return;
    const b = this.breakers.get(accountId);
    if (!b || b.state === 'closed') return;
    const { openMs } = this.breakerOptions();
    const left = b.openedAt + openMs - this.now();
    if (b.state === 'open' && left <= 0) {
      this.move(accountId, b, 'half_open');
      b.probing = true;
      return;
    }
    if (b.state === 'half_open' && !b.probing) {
      b.probing = true;
      return;
    }
    this.stats.circuitRefused += 1;
    this.o.metrics?.called(this.o.provider, apiClass, 'circuit_open');
    const wait = Math.max(1, Math.ceil(Math.max(left, 1000) / 1000));
    throw new CloudProviderError(`Calls to ${this.o.provider} for this account are paused: it failed ${this.breakerOptions().failures} times in a row. Try again in ${wait} s.`, this.o.provider, 503, 'circuit_open', null, b.state === 'open' ? wait : null);
  }

  /** After an attempt: a 5xx answer or a timeout counts against the breaker, anything else closes it. */
  private outcome(accountId: string, failed: boolean): void {
    if (this.o.breaker === false) return;
    let b = this.breakers.get(accountId);
    if (!failed) {
      if (b) {
        b.failures = 0;
        b.probing = false;
        this.move(accountId, b, 'closed');
      }
      return;
    }
    if (!b) this.breakers.set(accountId, (b = { state: 'closed', failures: 0, openedAt: 0, probing: false }));
    b.failures += 1;
    b.probing = false;
    if (b.state === 'half_open' || b.failures >= this.breakerOptions().failures) this.move(accountId, b, 'open');
  }

  /** Why the URL itself may not be called (before any DNS lookup), or null. */
  private urlProblem(url: URL): string | null {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Only https:// is allowed for a cloud API.';
    if (url.username || url.password) return 'Credentials do not belong in the URL.';
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (url.protocol === 'http:' && !this.o.policy.allow.hosts.includes(host) && !this.o.policy.allow.networks.check(host, host.includes(':') ? 'ipv6' : 'ipv4')) return `${host} may be called over plain http:// only when SERVICE_ALLOWED_HOSTS names it (a test endpoint).`;
    return null;
  }

  private heldFor(accountId: string, apiClass: ApiClass): number {
    const now = this.now();
    const until = Math.max(this.holdUntil.get(`${apiClass}:${accountId}`) ?? 0, this.holdUntil.get(`*:${accountId}`) ?? 0);
    return until > now ? until - now : 0;
  }

  private async admit(accountId: string, apiClass: ApiClass, signal?: AbortSignal): Promise<void> {
    const started = Date.now();
    const deadline = started + (this.o.maxQueueWaitMs ?? 120_000);
    const refuse = (waitMs: number) => {
      this.stats.rateLimited += 1;
      this.o.metrics?.called(this.o.provider, apiClass, 'rate_limited');
      return new CloudProviderError(`Calls to ${this.o.provider} for this account are over the local rate limit; try again in ${Math.ceil(waitMs / 1000)} s.`, this.o.provider, 429, 'rate_limited', null, Math.max(1, Math.ceil(waitMs / 1000)));
    };
    const held = this.heldFor(accountId, apiClass);
    if (held > 0) {
      if (Date.now() + held > deadline) throw refuse(held);
      this.stats.waitedMs += held;
      this.o.metrics?.waited(this.o.provider, apiClass, 'hold', held);
      await this.sleep(held, signal);
    }
    let waited = 0;
    for (;;) {
      let wait: number | null = await this.classBuckets[apiClass].take(accountId);
      if (wait == null) for (const b of this.accountBuckets) if ((wait = await b.take(accountId)) != null) break;
      if (wait == null) {
        if (waited) this.o.metrics?.waited(this.o.provider, apiClass, 'limiter', waited);
        return;
      }
      const jittered = wait + Math.floor(this.random() * 50);
      if (Date.now() + jittered > deadline) throw refuse(wait);
      this.stats.limiterWaits += 1;
      this.stats.waitedMs += jittered;
      waited += jittered;
      await this.sleep(jittered, signal);
    }
  }

  /** ARM's `x-ms-ratelimit-remaining-*` and DigitalOcean's `ratelimit-remaining`: hold the class back while it is low. */
  private observeRemaining(accountId: string, apiClass: ApiClass, headers: Record<string, string>): void {
    const low = this.o.lowWater ?? 2;
    const now = this.now();
    let holdKey: string | null = null;
    let until = 0;
    for (const [k, v] of Object.entries(headers)) {
      if (!/^\d+$/.test(v)) continue;
      const n = Number(v);
      if (n > low) continue;
      if (k.startsWith('x-ms-ratelimit-remaining-')) {
        // ARM refills continuously and does not say when: a second per call short of the low-water mark, at most 10 s.
        const cls = /writes|deletes/.test(k) ? 'mutate' : /reads/.test(k) ? (apiClass === 'mutate' ? 'read' : apiClass) : apiClass;
        const ms = Math.min(10_000, (low - n + 1) * 1000);
        this.setHold(`${cls}:${accountId}`, now + ms);
        if (cls !== apiClass && /reads/.test(k)) this.setHold(`${apiClass === 'list' ? 'read' : 'list'}:${accountId}`, now + ms);
      } else if (k === 'ratelimit-remaining' && this.o.provider === 'digitalocean') {
        const reset = Number(headers['ratelimit-reset']);
        if (Number.isFinite(reset) && reset * 1000 > now) {
          holdKey = `*:${accountId}`;
          until = reset * 1000;
        }
      }
    }
    if (holdKey) this.setHold(holdKey, until);
  }

  private setHold(key: string, until: number): void {
    if ((this.holdUntil.get(key) ?? 0) >= until) return;
    this.holdUntil.set(key, until);
    this.stats.holds += 1;
  }

  async send(r: CloudRequest): Promise<CloudResponse> {
    if (!r.accountId) throw new CloudProviderError('A cloud call needs an account; none was given.', this.o.provider, 400, 'no_account');
    let url = typeof r.url === 'string' ? new URL(r.url) : r.url;
    const apiClass = r.apiClass ?? apiClassOf(this.o.provider, r.method, url, r.headers ?? {}, r.body);
    const mapped = this.o.testOrigins?.[url.origin];
    if (mapped) url = new URL(`${url.pathname}${url.search}`, mapped);
    const problem = this.urlProblem(url);
    if (problem) {
      this.stats.refused += 1;
      this.o.metrics?.called(this.o.provider, apiClass, 'refused');
      throw new CloudProviderError(`${url.host} was refused: ${problem}`, this.o.provider, 502, 'egress_refused');
    }
    this.stats.calls += 1;
    this.stats.byClass[apiClass] += 1;
    const safe = apiClass !== 'mutate';
    const max = this.o.maxAttempts ?? 4;
    const hosts = r.via === 'ai-gateway' ? [...CLOUD_PROVIDER_HOSTS[this.o.provider], 'gateway.ai.cloudflare.com'] : CLOUD_PROVIDER_HOSTS[this.o.provider];
    for (let attempt = 1; ; attempt++) {
      this.gate(r.accountId, apiClass);
      await this.admit(r.accountId, apiClass, r.signal);
      this.stats.attempts += 1;
      let res: GuardedResponse;
      let streamed: { body: AsyncIterable<Buffer>; abort: () => void } | null = null;
      try {
        const req = {
          method: r.method,
          url,
          headers: { 'user-agent': 'exprsn-ai-cloud', ...(r.headers ?? {}) },
          ...(r.body != null ? { body: r.body } : {}),
          timeoutMs: r.timeoutMs ?? this.o.timeoutMs ?? 30_000,
          maxBytes: this.o.maxBytes ?? 16 * 1024 * 1024,
          ...(r.signal ? { signal: r.signal } : {}),
          ...(r.ca ? { ca: r.ca } : {}),
          check: (address: string, host: string) => cloudAddressProblem(address, host, this.o.policy, hosts)
        };
        if (r.stream) {
          // B-10501: a 2xx answer is handed on as it arrives; anything else is read whole and treated as any answer.
          const st = await guardedStream(req);
          const ok = st.status >= 200 && st.status < 300;
          if (ok) streamed = { body: st.body, abort: st.abort };
          res = { status: st.status, contentType: st.contentType, address: st.address, headers: st.headers, body: ok ? Buffer.alloc(0) : await st.collect() };
        } else res = await guardedRequest(req);
      } catch (err) {
        if (err instanceof ServiceUrlRefused) {
          this.stats.refused += 1;
          this.o.metrics?.called(this.o.provider, apiClass, 'refused');
          throw new CloudProviderError(`${url.host} was refused: ${err.message}`, this.o.provider, 502, 'egress_refused');
        }
        if (!r.signal?.aborted) this.outcome(r.accountId, true);
        if (safe && attempt < max && !r.signal?.aborted) {
          this.stats.retries += 1;
          const wait = this.backoff(attempt);
          this.o.metrics?.waited(this.o.provider, apiClass, 'retry', wait);
          await this.sleep(wait, r.signal);
          continue;
        }
        this.o.metrics?.called(this.o.provider, apiClass, 'unreachable');
        throw new CloudProviderError(`${url.host} did not answer: ${(err as Error).message}`, this.o.provider, 502, 'unreachable');
      }
      const requestId = REQUEST_ID_HEADERS.map((h) => res.headers[h]).find(Boolean) ?? null;
      const throttled = this.throttled(res);
      if (throttled) this.stats.throttled += 1;
      this.outcome(r.accountId, !throttled && res.status >= 500);
      // A throttled answer is honoured by the retry below (or returned); the remaining count guides the calls after it.
      if (!throttled) this.observeRemaining(r.accountId, apiClass, res.headers);
      const retryable = throttled || (safe && res.status >= 500);
      if (retryable && attempt < max) {
        const asked = this.retryAfterMs(res);
        const wait = asked ?? this.backoff(attempt);
        if (wait <= (this.o.maxRetryWaitMs ?? 60_000)) {
          this.stats.retries += 1;
          this.stats.waitedMs += wait;
          this.o.metrics?.waited(this.o.provider, apiClass, 'retry', wait);
          await this.sleep(wait, r.signal);
          continue;
        }
      }
      this.o.metrics?.called(this.o.provider, apiClass, throttled ? 'throttled' : res.status >= 400 ? 'error' : 'ok');
      return { ...res, attempts: attempt, requestId, apiClass, ...(streamed ? { stream: streamed.body, abort: streamed.abort } : {}) };
    }
  }

  /** `send`, then a JSON body; a non-2xx answer throws `CloudProviderError` with the provider's code and request id. */
  async json<T = unknown>(r: CloudRequest, describe: (status: number, body: unknown) => { message: string; code: string | null }): Promise<{ status: number; body: T; headers: Record<string, string>; requestId: string | null }> {
    const res = await this.send({ ...r, headers: { accept: 'application/json', ...(r.body != null ? { 'content-type': 'application/json' } : {}), ...(r.headers ?? {}) } });
    let body: unknown = null;
    const text = res.body.toString('utf8');
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (res.status >= 200 && res.status < 300) return { status: res.status, body: body as T, headers: res.headers, requestId: res.requestId };
    const d = describe(res.status, body);
    const retry = this.throttled(res) ? Math.ceil((this.retryAfterMs(res) ?? 1000) / 1000) : null;
    throw new CloudProviderError(d.message, this.o.provider, res.status, d.code, res.requestId, retry);
  }
}
