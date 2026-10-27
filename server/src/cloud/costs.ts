import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { json } from '../db/knex.js';
import type { Principal } from '../authz/policy.js';
import { HttpProblem } from '../http/problem.js';
import { signV4 } from '../platform/blob.js';
import { servicePolicy } from '../platform/egress.js';
import type { Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import type { CloudActor } from './accounts.js';
import { cloudAudit } from './audit.js';
import { cloudPlaneMetrics } from './cloud-metrics.js';
import { AZURE_SCOPES } from './azure-calls.js';
import { estimatedBetween } from './billing-spend.js';
import type { ProviderCredential } from './credentials.js';
import { currencyFor } from './prices.js';
import { cloudflareWindow, compareNeurons, fetchCloudflare, type CfDayUsage, type NeuronDay } from './cloudflare-billing.js';
import { CloudTransport, type TransportOptions } from './providers/transport.js';
import { CloudProviderError } from './providers/types.js';
import { monthOf } from './spend.js';
import { TAG_PREFIX } from './tags.js';
import type { CloudAccount, Provider } from './types.js';

/*
 * 1.9.99-final, Sprint 59 (B-10603): billing ingestion, `s.cloud.costs`.
 *
 * Every cloud bill comes back as daily rows in `cloud_costs` (migration 155_cloud_costs): provider, account,
 * deployment (null: unattributed), allocation, service, day (UTC), amount, currency, source and when it was fetched.
 *
 * - AWS: Cost Explorer `GetCostAndUsage` (open decision 9, settled 2026-10-20), DAILY, `UnblendedCost`, grouped by the
 *   `exprsn:deployment` cost allocation tag and SERVICE, filtered to the account's own LINKED_ACCOUNT, signed with the
 *   account's billing credential. Cost Explorer charges per request, so the whole window is ONE request (plus a page
 *   only when the answer has a NextPageToken), and each account is fetched at most once a UTC day by the schedule.
 * - Azure: Cost Management `query` at the subscription scope (ActualCost, Daily, grouped by the `exprsn:deployment` tag
 *   key, the same key as on AWS, and ServiceName), with an ARM token of the billing credential; one query per account
 *   and day, following `nextLink`.
 * - DigitalOcean: no per-tag costs. The balance (kept with the fetch, beside the month-to-date total ingested), the
 *   invoice list, and the invoice items of the current month's preview and of a finished month not yet ingested as
 *   final. Each item's amount is spread over the days of its start and end times, and attributed by its resource id
 *   (`resource_uuid`, else `resource_id`) to the deployment whose graph holds that provider id.
 * - Cloudflare (Sprint 61, B-10608, `cloud/cloudflare-billing.ts`): one GraphQL Analytics request for the window
 *   (Workers, Containers, R2, Tunnel, Workers AI neurons) priced at the published usage rates, and the billing
 *   history, whose charges reconcile each finished month; then the neuron check against `usage_records`.
 *
 * The window is the last `days` days (14 by default) and at least the whole current month: providers revise recent
 * days, so each fetch replaces the rows of the days it covers (idempotent: a re-fetch of the same answer writes the same
 * rows). A fetch is claimed per account and fetch key in `cloud_cost_fetches` (the UTC day for the schedule, the day and
 * hour for a "fetch now"), so two instances never both call, a done key is never called again, and a crashed or
 * failed fetch is taken over by the next run (at most three attempts a key): the daily job is resumable.
 *
 * Only accounts that are active and whose last validation shows billing read access are fetched, so nothing is called
 * until such an account exists. Every call goes through `CloudTransport` (the egress guard, the per-class rate limits
 * with the small `billing` share, retries on throttling, the breaker). Amounts keep the currency the provider billed in
 * (open decision 17): never converted.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;
export const DEFAULT_COST_DAYS = 14;
const MAX_PAGES = 20;
const MAX_ATTEMPTS = 3;
const STALE_RUN_MS = 30 * 60_000;
/** Billing data counts for budgets while the account's last successful fetch is this recent. */
export const BILLING_FRESH_MS = 3 * DAY;
const AZURE_COST_API = '2023-11-01';
export const DEPLOYMENT_TAG = `${TAG_PREFIX}deployment`;
const TABLES = ['cloud_costs', 'cloud_cost_fetches'] as const;

export const COST_SOURCES = ['aws-cost-explorer', 'azure-cost-management', 'digitalocean-invoice', 'digitalocean-preview', 'cloudflare-analytics', 'cloudflare-billing'] as const;
export type CostSource = (typeof COST_SOURCES)[number];

export const costsMissing = () => new HttpProblem(503, 'Not installed', 'Billing ingestion needs the database migration 155_cloud_costs, which has not been applied.', { extensions: { reason: 'migration_pending' } });

export interface CostEndpoints {
  /** Cost Explorer (default `https://ce.us-east-1.amazonaws.com`). */
  awsCostExplorer?: string;
  /** Azure Resource Manager (default `https://management.azure.com`). */
  azureArm?: string;
  /** The DigitalOcean API (default `https://api.digitalocean.com`). */
  digitalocean?: string;
  /** Sprint 61 (B-10608): the Cloudflare API origin (default `https://api.cloudflare.com`). */
  cloudflare?: string;
}

export interface CostOptions {
  endpoints?: CostEndpoints;
  transport?: Omit<TransportOptions, 'provider' | 'policy' | 'counters'>;
  now?: () => number;
  /** Days re-fetched each time (default 14); the window always covers the current month too. */
  days?: number;
}

export interface CostRow {
  accountId: string;
  provider: Provider;
  deploymentId: string | null;
  /** The `exprsn:deployment` tag value (AWS, Azure) or the invoice item's resource id (DigitalOcean); '' when none. */
  allocation: string;
  service: string;
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  amount: number;
  currency: string;
  source: CostSource;
  /** The provider still calls the figure an estimate (Cost Explorer's `Estimated`; a DigitalOcean preview). */
  estimated: boolean;
  fetchedAt: number;
}

export interface CostFetch {
  id: string;
  accountId: string;
  provider: Provider;
  key: string;
  manual: boolean;
  state: 'running' | 'ok' | 'failed';
  attempts: number;
  window: { from: string; to: string } | null;
  requests: number;
  rows: number;
  totals: Record<string, number>;
  note: Record<string, unknown> | null;
  error: string | null;
  requestedBy: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface IngestResult {
  accountId: string;
  state: 'ok' | 'failed' | 'skipped';
  /** Why nothing was fetched (`cached`, `running`, `not_eligible: ...`, `migration_pending`). */
  reason?: string;
  requests: number;
  rows: number;
  window: { from: string; to: string } | null;
  totals: Record<string, number>;
  error?: string;
  /** What was unavailable in an otherwise successful fetch (Cloudflare: `workersAi`), with the error. */
  partial?: Record<string, string>;
}

interface Draft {
  deploymentId: string | null;
  allocation: string;
  service: string;
  day: string;
  amount: number;
  currency: string;
  source: CostSource;
  estimated: boolean;
}

interface Fetched {
  rows: Draft[];
  /** The day ranges (from inclusive, to exclusive) whose rows the answer replaces. */
  ranges: { from: string; to: string; sources: CostSource[] }[];
  requests: number;
  note?: Record<string, unknown>;
  /** The window actually fetched, when it is not the usual one (Cloudflare reaches back to the previous month). */
  window?: { from: string; to: string };
}

export const dayOf = (t: number): string => new Date(t).toISOString().slice(0, 10);
export const dayStart = (d: string): number => Date.parse(`${d}T00:00:00Z`);
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const round2 = (n: number) => Math.round(n * 100) / 100;
const sha256 = (b: string) => createHash('sha256').update(b).digest('hex');
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/** Spreads an amount over the UTC days of [start, end), by the share of each day the interval covers. */
export function spreadOverDays(amount: number, start: number, end: number): { day: string; amount: number }[] {
  if (!(end > start)) return [{ day: dayOf(start), amount }];
  const out: { day: string; amount: number }[] = [];
  let given = 0;
  for (let d = dayStart(dayOf(start)); d < end; d += DAY) {
    const overlap = Math.min(end, d + DAY) - Math.max(start, d);
    if (overlap <= 0) continue;
    const share = round6((amount * overlap) / (end - start));
    out.push({ day: dayOf(d), amount: share });
    given += share;
  }
  // The rounding remainder goes to the last day, so the days add up to the amount exactly.
  if (out.length) out[out.length - 1]!.amount = round6(out[out.length - 1]!.amount + (amount - given));
  return out;
}

/** Sums drafts with the same day, allocation, service and currency. */
function merge(rows: Draft[]): Draft[] {
  const m = new Map<string, Draft>();
  for (const r of rows) {
    const k = `${r.day}|${r.allocation}|${r.service}|${r.currency}`;
    const had = m.get(k);
    if (had) {
      had.amount = round6(had.amount + r.amount);
      had.estimated ||= r.estimated;
    } else m.set(k, { ...r, amount: round6(r.amount) });
  }
  return [...m.values()].filter((r) => r.amount !== 0);
}

const describeAws = (status: number, b: unknown) => ({
  message: `Cost Explorer answered ${status}${typeof b === 'object' && b && ('message' in b || 'Message' in b) ? `: ${String((b as { message?: unknown; Message?: unknown }).message ?? (b as { Message?: unknown }).Message).slice(0, 200)}` : ''}.`,
  code: typeof b === 'object' && b && '__type' in b ? String((b as { __type: unknown }).__type).split('#').pop()! : null
});
const describeAzure = (status: number, b: unknown) => {
  const e = (typeof b === 'object' && b && 'error' in b ? (b as { error: { code?: string; message?: string } }).error : null) ?? null;
  return { message: `Cost Management answered ${status}${e?.message ? `: ${e.message.slice(0, 200)}` : ''}.`, code: e?.code ?? null };
};
const describeDo = (status: number, b: unknown) => ({ message: `DigitalOcean billing answered ${status}${typeof b === 'object' && b && 'message' in b ? `: ${String((b as { message: unknown }).message).slice(0, 200)}` : ''}.`, code: typeof b === 'object' && b && 'id' in b ? String((b as { id: unknown }).id) : null });

interface CeAnswer {
  ResultsByTime?: { TimePeriod?: { Start?: string; End?: string }; Estimated?: boolean; Groups?: { Keys?: string[]; Metrics?: Record<string, { Amount?: string; Unit?: string }> }[] }[];
  NextPageToken?: string | null;
}

interface AzureAnswer {
  properties?: { nextLink?: string | null; columns?: { name: string; type?: string }[]; rows?: unknown[][] };
}

interface DoInvoiceList {
  invoices?: { invoice_uuid?: string; invoice_period?: string; amount?: string }[];
  invoice_preview?: { invoice_uuid?: string; invoice_period?: string; amount?: string; updated_at?: string } | null;
  links?: { pages?: { next?: string } };
}

interface DoItems {
  invoice_items?: { product?: string; resource_id?: string; resource_uuid?: string; description?: string; amount?: string; start_time?: string; end_time?: string }[];
  links?: { pages?: { next?: string } };
}

function fetchFrom(r: Record<string, unknown>): CostFetch {
  return {
    id: String(r.id),
    accountId: String(r.account_id),
    provider: r.provider as Provider,
    key: String(r.fetch_key),
    manual: !!Number(r.manual),
    state: r.state as CostFetch['state'],
    attempts: Number(r.attempts ?? 1),
    window: r.window_from && r.window_to ? { from: String(r.window_from), to: String(r.window_to) } : null,
    requests: Number(r.requests ?? 0),
    rows: Number(r.rows ?? 0),
    totals: json<Record<string, number>>(r.totals, {}),
    note: json<Record<string, unknown> | null>(r.note, null),
    error: (r.error as string | null) ?? null,
    requestedBy: (r.requested_by as string | null) ?? null,
    startedAt: Number(r.started_at),
    finishedAt: r.finished_at == null ? null : Number(r.finished_at)
  };
}

function rowFrom(r: Record<string, unknown>): CostRow {
  return { accountId: String(r.account_id), provider: r.provider as Provider, deploymentId: (r.deployment_id as string | null) ?? null, allocation: String(r.allocation ?? ''), service: String(r.service), day: String(r.day), amount: Number(r.amount), currency: String(r.currency), source: r.source as CostSource, estimated: !!Number(r.estimated), fetchedAt: Number(r.fetched_at) };
}

export class CloudCosts {
  private schema: { ok: boolean; at: number } | null = null;
  private transports = new Map<Provider, CloudTransport>();
  private endpoints: CostEndpoints;
  private readonly now: () => number;
  private readonly days: number;
  /** Provider requests made, per source (tests; the job's report). */
  readonly calls = { 'aws-cost-explorer': 0, 'azure-cost-management': 0, digitalocean: 0, cloudflare: 0 };

  constructor(
    private readonly s: () => Services,
    private readonly o: CostOptions = {}
  ) {
    this.endpoints = { ...(o.endpoints ?? {}) };
    this.now = o.now ?? Date.now;
    this.days = Math.max(1, Math.min(60, o.days ?? DEFAULT_COST_DAYS));
  }

  setEndpoints(e: CostEndpoints): void {
    this.endpoints = { ...this.endpoints, ...e };
  }

  /** Tests: a fast transport. */
  setTransport(t: CostOptions['transport']): void {
    (this.o as { transport?: CostOptions['transport'] }).transport = t;
    this.transports.clear();
  }

  async installed(): Promise<boolean> {
    const t = Date.now();
    if (this.schema && (this.schema.ok || t - this.schema.at < 30_000)) return this.schema.ok;
    let ok = true;
    try {
      for (const name of TABLES) if (!(await this.s().db.schema.hasTable(name))) ok = false;
    } catch {
      ok = false;
    }
    this.schema = { ok, at: t };
    return ok;
  }

  resetSchemaCache(): void {
    this.schema = null;
  }

  async need(): Promise<void> {
    await this.s().cloud.accounts.need();
    if (!(await this.installed())) throw costsMissing();
  }

  private get db() {
    return this.s().db;
  }

  private transport(provider: Provider): CloudTransport {
    let t = this.transports.get(provider);
    if (!t) {
      const s = this.s();
      t = new CloudTransport({ provider, policy: servicePolicy(s.cfg), counters: s.counters, timeoutMs: s.cfg.CLOUD_HTTP_TIMEOUT_MS, ...(this.o.transport ?? {}) });
      this.transports.set(provider, t);
    }
    return t;
  }

  private async cred(account: CloudAccount): Promise<ProviderCredential> {
    const c = this.s().cloud.credentials;
    if (!c) throw new CloudProviderError('Cloud credentials are not available in this build.', account.provider, 503, 'cloud_component_missing');
    return (await c.for(account, 'billing')) as ProviderCredential;
  }

  /** Why an account is not fetched, or null when it is. */
  eligibility(account: CloudAccount): string | null {
    if (account.state !== 'active') return `The account is ${account.state}; only active accounts are fetched.`;
    const billing = account.validation?.features?.find((f) => f.feature === 'billing');
    if (!billing || billing.status !== 'ok') return 'The account\'s last validation does not show billing read access (validate it with a billing role or scope).';
    if (account.provider === 'azure' && !account.providerIds.azureSubscriptionId) return 'The account has no subscription id.';
    if (account.provider === 'cloudflare' && !account.providerIds.cloudflareAccountId) return 'The account has no Cloudflare account id.';
    return null;
  }

  /** The days a fetch at `now` covers: the last `days` days and the whole current month, up to today (exclusive). */
  window(now = this.now()): { from: string; to: string } {
    const today = dayStart(dayOf(now));
    return { from: dayOf(Math.min(today - this.days * DAY, monthOf(now).start)), to: dayOf(today) };
  }

  // ---------- the claim (once per account and key, across instances) ----------

  private async claim(account: CloudAccount, key: string, manual: boolean, requestedBy: string | null, now: number): Promise<{ id: string } | { skip: string }> {
    const id = ulid();
    try {
      await this.db('cloud_cost_fetches').insert({ id, account_id: account.id, provider: account.provider, fetch_key: key, manual, state: 'running', attempts: 1, requests: 0, rows: 0, requested_by: requestedBy, started_at: now });
      return { id };
    } catch {
      const r = (await this.db('cloud_cost_fetches').where({ account_id: account.id, fetch_key: key }).first()) as Record<string, unknown> | undefined;
      if (!r) return { skip: 'running' };
      const f = fetchFrom(r);
      if (f.state === 'ok') return { skip: 'cached' };
      const takeover = (f.state === 'failed' && f.attempts < MAX_ATTEMPTS) || (f.state === 'running' && now - f.startedAt > STALE_RUN_MS && f.attempts < MAX_ATTEMPTS);
      if (!takeover) return { skip: f.state === 'running' ? 'running' : 'attempts_spent' };
      const n = await this.db('cloud_cost_fetches').where({ id: f.id, state: f.state, attempts: f.attempts }).update({ state: 'running', attempts: f.attempts + 1, started_at: now, finished_at: null, error: null, ...(requestedBy ? { requested_by: requestedBy } : {}) });
      return n ? { id: f.id } : { skip: 'running' };
    }
  }

  // ---------- ingest ----------

  /**
   * Fetches one account's costs for the window and replaces its rows for those days. Scheduled fetches are keyed by
   * the UTC day (one a day), manual ones by the day and hour (one an hour).
   */
  async ingestAccount(accountId: string, o: { manual?: boolean; requestedBy?: string | null; jobId?: string | null; now?: number } = {}): Promise<IngestResult> {
    const now = o.now ?? this.now();
    const empty = { accountId, requests: 0, rows: 0, window: null, totals: {} };
    if (!(await this.installed())) return { ...empty, state: 'skipped', reason: 'migration_pending' };
    const account = await this.s().cloud.accounts.get(accountId);
    if (!account) return { ...empty, state: 'skipped', reason: 'not_found' };
    const why = this.eligibility(account);
    if (why) return { ...empty, state: 'skipped', reason: `not_eligible: ${why}` };
    const key = o.manual ? `${new Date(now).toISOString().slice(0, 13)}:manual` : dayOf(now);
    const claimed = await this.claim(account, key, !!o.manual, o.requestedBy ?? null, now);
    if ('skip' in claimed) return { ...empty, state: 'skipped', reason: claimed.skip };
    let win = this.window(now);
    const tenantId = await this.s().cloud.budgets.tenantOf(account);
    const actor = { service: 'cloud-costs', onBehalfOf: o.requestedBy ?? null, jobId: o.jobId ?? null };
    let requests = 0;
    try {
      if (account.provider === 'cloudflare') win = cloudflareWindow(win, now);
      const got = account.provider === 'aws' ? await this.fetchAws(account, win) : account.provider === 'azure' ? await this.fetchAzure(account, win) : account.provider === 'cloudflare' ? await this.fetchCf(account, win, now) : await this.fetchDo(account, win, now);
      requests = got.requests;
      if (got.window) win = got.window;
      const rows = merge(got.rows);
      await this.store(account, rows, got.ranges, now);
      const totals: Record<string, number> = {};
      for (const r of rows) totals[r.currency] = (totals[r.currency] ?? 0) + r.amount;
      for (const k of Object.keys(totals)) totals[k] = round2(totals[k]!);
      await this.db('cloud_cost_fetches').where({ id: claimed.id }).update({ state: 'ok', window_from: win.from, window_to: win.to, requests, rows: rows.length, totals: JSON.stringify(totals), note: got.note ? JSON.stringify(got.note) : null, error: null, finished_at: this.now() });
      cloudPlaneMetrics(this.s().metrics.registry).costIngest(account.provider, 'ok');
      // A partial fetch (Cloudflare: the Workers AI request failed) says what was unavailable, with the error.
      const partial = (got.note as { partial?: Record<string, string> } | undefined)?.partial;
      await cloudAudit(this.s(), { tenantId, action: 'cloud.costs.ingested', actor, detail: { account: account.id, name: account.name, provider: account.provider, manual: !!o.manual, window: win, requests, rows: rows.length, totals, ...(partial ? { partial } : {}) } });
      if (partial) this.s().log.warn({ account: account.id, provider: account.provider, partial }, 'cloud cost fetch partial');
      // Sprint 61 (B-10608): the neuron check runs as its own job once a Cloudflare fetch has stored its analytics.
      if (account.provider === 'cloudflare') await this.s().jobs.enqueue({ tenantId, type: 'cloud.costs.neurons.check', payload: { accountId: account.id, from: win.from, to: win.to } }).catch((err) => this.s().log.warn({ account: account.id, err: String(err) }, 'cloud neuron check not queued'));
      // Sprint 62 (B-10606): the day's rows are in, so the account's spend is checked against its baseline.
      await this.s().jobs.enqueue({ tenantId, type: 'cloud.anomalies.detect', payload: { accountId: account.id } }).catch((err) => this.s().log.warn({ account: account.id, err: String(err) }, 'cloud anomaly check not queued'));
      return { accountId, state: 'ok', requests, rows: rows.length, window: win, totals, ...(partial ? { partial } : {}) };
    } catch (err) {
      const message = clip(err instanceof Error ? err.message : String(err), 480);
      if (err instanceof CloudProviderError || err instanceof HttpProblem) requests ||= 1;
      await this.db('cloud_cost_fetches').where({ id: claimed.id }).update({ state: 'failed', window_from: win.from, window_to: win.to, error: message, finished_at: this.now() });
      cloudPlaneMetrics(this.s().metrics.registry).costIngest(account.provider, 'failed');
      await cloudAudit(this.s(), { tenantId, action: 'cloud.costs.failed', actor, detail: { account: account.id, name: account.name, provider: account.provider, manual: !!o.manual, error: message } }).catch(() => undefined);
      this.s().log.warn({ account: account.id, provider: account.provider, err: message }, 'cloud cost ingest failed');
      return { accountId, state: 'failed', requests, rows: 0, window: win, totals: {}, error: message };
    }
  }

  /** Every eligible account, one after another (the daily job). */
  async ingest(o: { now?: number; jobId?: string | null; progress?: (done: number, of: number) => Promise<void> } = {}): Promise<{ accounts: number; fetched: number; skipped: number; failed: number; results: IngestResult[] }> {
    const out = { accounts: 0, fetched: 0, skipped: 0, failed: 0, results: [] as IngestResult[] };
    if (!(await this.installed())) return out;
    const accounts = (await this.s().cloud.accounts.list(null, { state: 'active' })).filter((a) => !this.eligibility(a));
    out.accounts = accounts.length;
    for (const [i, a] of accounts.entries()) {
      const r = await this.ingestAccount(a.id, { now: o.now, jobId: o.jobId ?? null });
      out.results.push(r);
      if (r.state === 'ok') out.fetched += 1;
      else if (r.state === 'failed') out.failed += 1;
      else out.skipped += 1;
      await o.progress?.(i + 1, accounts.length);
    }
    return out;
  }

  /** Replaces the account's rows of the covered days with the new ones, in one transaction. */
  private async store(account: CloudAccount, rows: Draft[], ranges: Fetched['ranges'], now: number): Promise<void> {
    await this.db.transaction(async (trx) => {
      for (const r of ranges) await trx('cloud_costs').where({ account_id: account.id }).whereIn('source', r.sources).where('day', '>=', r.from).where('day', '<', r.to).del();
      const records = rows.map((r) => ({ id: ulid(), account_id: account.id, provider: account.provider, deployment_id: r.deploymentId, allocation: clip(r.allocation, 200), service: clip(r.service || 'unknown', 200), day: r.day, amount: String(r.amount), currency: r.currency, source: r.source, estimated: r.estimated, fetched_at: now }));
      for (let i = 0; i < records.length; i += 100) await trx('cloud_costs').insert(records.slice(i, i + 100));
    });
  }

  /** The account's deployments by name (the `exprsn:deployment` tag value). */
  private async deploymentsByName(accountId: string): Promise<Map<string, string>> {
    const rows = (await this.db('cloud_deployments').where({ account_id: accountId }).select('id', 'name').catch(() => [])) as { id: string; name: string }[];
    return new Map(rows.map((r) => [String(r.name).toLowerCase(), String(r.id)]));
  }

  // ---------- AWS Cost Explorer ----------

  private async fetchAws(account: CloudAccount, win: { from: string; to: string }): Promise<Fetched> {
    const cred = await this.cred(account);
    if (cred.kind !== 'aws') throw new CloudProviderError(`${account.name}'s billing credential is not an AWS key.`, 'aws', 400, 'wrong_credential');
    const byName = await this.deploymentsByName(account.id);
    const url = new URL('/', this.endpoints.awsCostExplorer ?? 'https://ce.us-east-1.amazonaws.com');
    const rows: Draft[] = [];
    let token: string | null = null;
    let requests = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body: string = JSON.stringify({
        TimePeriod: { Start: win.from, End: win.to },
        Granularity: 'DAILY',
        Metrics: ['UnblendedCost'],
        GroupBy: [{ Type: 'TAG', Key: DEPLOYMENT_TAG }, { Type: 'DIMENSION', Key: 'SERVICE' }],
        ...(account.providerIds.awsAccountId ? { Filter: { Dimensions: { Key: 'LINKED_ACCOUNT', Values: [account.providerIds.awsAccountId] } } } : {}),
        ...(token ? { NextPageToken: token } : {})
      });
      const headers: Record<string, string> = { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSInsightsIndexService.GetCostAndUsage', ...(cred.sessionToken ? { 'x-amz-security-token': cred.sessionToken } : {}) };
      const signed = signV4({ method: 'POST', url, headers, payloadHash: sha256(body), region: 'us-east-1', service: 'ce', accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey, date: new Date(this.now()) });
      this.calls['aws-cost-explorer'] += 1;
      requests += 1;
      const res: { body: CeAnswer } = await this.transport('aws').json<CeAnswer>({ method: 'POST', url, headers: signed, body, accountId: account.id, apiClass: 'billing' }, describeAws);
      for (const t of res.body.ResultsByTime ?? []) {
        const day = t.TimePeriod?.Start;
        if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
        for (const g of t.Groups ?? []) {
          const k0 = g.Keys?.[0] ?? '';
          const tag = k0.includes('$') ? k0.slice(k0.indexOf('$') + 1) : '';
          const m = g.Metrics?.UnblendedCost;
          const amount = Number(m?.Amount);
          if (!Number.isFinite(amount) || amount === 0) continue;
          rows.push({ deploymentId: tag ? (byName.get(tag.toLowerCase()) ?? null) : null, allocation: tag, service: g.Keys?.[1] ?? 'unknown', day, amount, currency: (m?.Unit ?? 'USD').toUpperCase(), source: 'aws-cost-explorer', estimated: !!t.Estimated });
        }
      }
      token = res.body.NextPageToken ?? null;
      if (!token) break;
    }
    return { rows, ranges: [{ ...win, sources: ['aws-cost-explorer'] }], requests };
  }

  // ---------- Azure Cost Management ----------

  private async fetchAzure(account: CloudAccount, win: { from: string; to: string }): Promise<Fetched> {
    const cred = await this.cred(account);
    if (cred.kind !== 'azure') throw new CloudProviderError(`${account.name}'s billing credential is not an Azure identity.`, 'azure', 400, 'wrong_credential');
    const { token } = await cred.getToken(AZURE_SCOPES.arm);
    const byName = await this.deploymentsByName(account.id);
    const base = (this.endpoints.azureArm ?? 'https://management.azure.com').replace(/\/+$/, '');
    let url: string | null = `${base}/subscriptions/${encodeURIComponent(account.providerIds.azureSubscriptionId!)}/providers/Microsoft.CostManagement/query?api-version=${AZURE_COST_API}`;
    const last = dayOf(dayStart(win.to) - DAY);
    const body = JSON.stringify({
      type: 'ActualCost',
      timeframe: 'Custom',
      timePeriod: { from: `${win.from}T00:00:00Z`, to: `${last}T23:59:59Z` },
      dataset: { granularity: 'Daily', aggregation: { totalCost: { name: 'Cost', function: 'Sum' } }, grouping: [{ type: 'TagKey', name: DEPLOYMENT_TAG }, { type: 'Dimension', name: 'ServiceName' }] }
    });
    const rows: Draft[] = [];
    let requests = 0;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      this.calls['azure-cost-management'] += 1;
      requests += 1;
      const res: { body: AzureAnswer } = await this.transport('azure').json<AzureAnswer>({ method: 'POST', url, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body, accountId: account.id, apiClass: 'billing' }, describeAzure);
      const cols = (res.body.properties?.columns ?? []).map((c) => c.name.toLowerCase());
      const at = (...names: string[]) => names.map((n) => cols.indexOf(n)).find((i) => i >= 0) ?? -1;
      const iCost = at('cost', 'pretaxcost', 'costusd');
      const iDate = at('usagedate', 'date');
      const iTagKey = at('tagkey');
      const iTag = at('tagvalue');
      const iSvc = at('servicename');
      const iCur = at('currency', 'billingcurrency');
      for (const r of res.body.properties?.rows ?? []) {
        const amount = Number(r[iCost]);
        if (iCost < 0 || !Number.isFinite(amount) || amount === 0) continue;
        const raw = String(r[iDate] ?? '');
        const day = /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw.slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < win.from || day >= win.to) continue;
        const keyName = iTagKey >= 0 ? String(r[iTagKey] ?? '') : DEPLOYMENT_TAG;
        const tag = keyName.toLowerCase() === DEPLOYMENT_TAG && iTag >= 0 ? String(r[iTag] ?? '') : '';
        rows.push({ deploymentId: tag ? (byName.get(tag.toLowerCase()) ?? null) : null, allocation: tag, service: iSvc >= 0 ? String(r[iSvc] ?? 'unknown') : 'unknown', day, amount, currency: (iCur >= 0 ? String(r[iCur] ?? 'USD') : 'USD').toUpperCase(), source: 'azure-cost-management', estimated: false });
      }
      const next = res.body.properties?.nextLink;
      // Follow only ARM's own origin (the egress guard checks the address too).
      url = next && new URL(next).origin === new URL(base).origin ? next : null;
    }
    return { rows, ranges: [{ ...win, sources: ['azure-cost-management'] }], requests };
  }

  // ---------- DigitalOcean balance and invoices ----------

  private async fetchDo(account: CloudAccount, win: { from: string; to: string }, now: number): Promise<Fetched> {
    const cred = await this.cred(account);
    if (cred.kind !== 'token') throw new CloudProviderError(`${account.name}'s billing credential is not a DigitalOcean token.`, 'digitalocean', 400, 'wrong_credential');
    const base = (this.endpoints.digitalocean ?? 'https://api.digitalocean.com').replace(/\/+$/, '');
    const origin = new URL(base).origin;
    const auth = { authorization: `Bearer ${cred.token}` };
    let requests = 0;
    const get = async <T>(url: string): Promise<T> => {
      this.calls.digitalocean += 1;
      requests += 1;
      return (await this.transport('digitalocean').json<T>({ method: 'GET', url, headers: auth, accountId: account.id, apiClass: 'billing' }, describeDo)).body;
    };
    const balance = await get<{ month_to_date_balance?: string; account_balance?: string; month_to_date_usage?: string; generated_at?: string }>(`${base}/v2/customers/my/balance`);
    const list = await get<DoInvoiceList>(`${base}/v2/customers/my/invoices?per_page=50`);
    const current = monthOf(now).key;
    const fromMonth = win.from.slice(0, 7);
    const prevMonth = monthOf(monthOf(now).start - 1).key;
    // The current month's preview, and finished months (those in the window, and always the last one) not yet ingested
    // from their final invoice.
    const targets: { uuid: string; period: string; final: boolean }[] = [];
    const p = list.invoice_preview;
    if (p?.invoice_uuid) targets.push({ uuid: p.invoice_uuid, period: p.invoice_period ?? current, final: false });
    for (const inv of list.invoices ?? []) {
      if (!inv.invoice_uuid || !inv.invoice_period || (inv.invoice_period < fromMonth && inv.invoice_period !== prevMonth) || inv.invoice_period >= current) continue;
      const done = await this.db('cloud_costs').where({ account_id: account.id, source: 'digitalocean-invoice' }).where('day', '>=', `${inv.invoice_period}-01`).where('day', '<', `${inv.invoice_period}-32`).first('id');
      if (!done) targets.push({ uuid: inv.invoice_uuid, period: inv.invoice_period, final: true });
    }
    const byResource = await this.resourceOwners(account.id);
    const rows: Draft[] = [];
    const ranges: Fetched['ranges'] = [];
    let previewTotal = 0;
    for (const t of targets) {
      if (!/^\d{4}-\d{2}$/.test(t.period)) continue;
      const mStart = Date.parse(`${t.period}-01T00:00:00Z`);
      const mEnd = Date.UTC(new Date(mStart).getUTCFullYear(), new Date(mStart).getUTCMonth() + 1, 1);
      let next: string | null = `${base}/v2/customers/my/invoices/${encodeURIComponent(t.uuid)}?per_page=200`;
      for (let page = 0; next && page < MAX_PAGES; page++) {
        const got: DoItems = await get<DoItems>(next);
        for (const it of got.invoice_items ?? []) {
          const amount = Number(it.amount);
          if (!Number.isFinite(amount) || amount === 0) continue;
          if (!t.final) previewTotal += amount;
          const start = it.start_time ? Date.parse(it.start_time) : mStart;
          let end = it.end_time ? Date.parse(it.end_time) : t.final ? mEnd : now;
          const s0 = Math.max(Number.isFinite(start) ? start : mStart, mStart);
          if (!Number.isFinite(end)) end = t.final ? mEnd : now;
          end = Math.min(end, mEnd, t.final ? mEnd : Math.max(now, s0 + 1));
          const allocation = it.resource_uuid || it.resource_id || '';
          const deploymentId = (it.resource_uuid && byResource.get(it.resource_uuid)) || (it.resource_id && byResource.get(String(it.resource_id))) || null;
          for (const d of spreadOverDays(amount, s0, end)) rows.push({ deploymentId, allocation: String(allocation), service: it.product || 'unknown', day: d.day, amount: d.amount, currency: 'USD', source: t.final ? 'digitalocean-invoice' : 'digitalocean-preview', estimated: !t.final });
        }
        const n = got.links?.pages?.next;
        next = n && new URL(n).origin === origin ? n : null;
      }
      // The invoice is the whole month: its rows replace the month's rows of either kind.
      ranges.push({ from: dayOf(mStart), to: dayOf(mEnd), sources: ['digitalocean-invoice', 'digitalocean-preview'] });
    }
    const note = { balance: { monthToDateUsage: balance.month_to_date_usage ?? null, monthToDateBalance: balance.month_to_date_balance ?? null, accountBalance: balance.account_balance ?? null, generatedAt: balance.generated_at ?? null }, previewTotal: round2(previewTotal), invoices: targets.map((t) => ({ period: t.period, final: t.final })) };
    return { rows, ranges, requests, note };
  }

  // ---------- Cloudflare analytics and billing history (Sprint 61, B-10608) ----------

  private async fetchCf(account: CloudAccount, win: { from: string; to: string }, now: number): Promise<Fetched> {
    const cred = await this.cred(account);
    if (cred.kind !== 'token') throw new CloudProviderError(`${account.name}'s billing credential is not a Cloudflare token.`, 'cloudflare', 400, 'wrong_credential');
    const got = await fetchCloudflare({ s: this.s(), account, token: cred.token, base: this.endpoints.cloudflare ?? 'https://api.cloudflare.com', transport: this.transport('cloudflare'), win, now, owners: await this.resourceOwners(account.id), byName: await this.deploymentsByName(account.id), count: () => void (this.calls.cloudflare += 1) });
    return { rows: got.rows, ranges: got.ranges, requests: got.requests, window: got.window, note: got.note as unknown as Record<string, unknown> };
  }

  /**
   * Workers AI neurons per day from the Cloudflare analytics kept with the account's fetches (the newest fetch that
   * covers a day wins) against the neurons metered on `usage_records` for the pools holding the account's Workers AI
   * instances. A day is a mismatch when they differ by more than 1 %. A day whose newest covering fetch was partial
   * (its Workers AI request failed, `note.analytics.neurons: false`) is "analytics unavailable", never a mismatch.
   */
  async neuronCheck(accountId: string, o: { from: string; to: string }): Promise<{ accountId: string; from: string; to: string; days: NeuronDay[]; mismatches: NeuronDay[]; unavailable: NeuronDay[] }> {
    const analytics: Record<string, number | null> = {};
    if (await this.installed()) {
      const fetches = ((await this.db('cloud_cost_fetches').where({ account_id: accountId, provider: 'cloudflare', state: 'ok' }).orderBy('finished_at', 'asc')) as Record<string, unknown>[]).map(fetchFrom);
      for (const f of fetches) {
        const a = (f.note as { analytics?: { days?: Record<string, CfDayUsage>; neurons?: boolean } } | null)?.analytics;
        if (a?.neurons === false) {
          // The fetch had no Workers AI analytics: every day it covered is unknown, not 0.
          const from = f.window && f.window.from > o.from ? f.window.from : o.from;
          const to = f.window && f.window.to < o.to ? f.window.to : o.to;
          for (let t = Date.parse(`${from}T00:00:00Z`); t < Date.parse(`${to}T00:00:00Z`); t += DAY) analytics[dayOf(t)] = null;
          continue;
        }
        for (const [d, u] of Object.entries(a?.days ?? {})) if (d >= o.from && d < o.to) analytics[d] = Number(u.neurons ?? 0);
      }
    }
    const days = await compareNeurons(this.s(), accountId, analytics, o);
    return { accountId, from: o.from, to: o.to, days, mismatches: days.filter((d) => d.state === 'mismatch'), unavailable: days.filter((d) => d.state === 'unavailable') };
  }

  /** Provider ids (droplet ids, cluster and database UUIDs...) of the account's deployments' resources → deployment. */
  private async resourceOwners(accountId: string): Promise<Map<string, string>> {
    const rows = (await this.db('cloud_resources as r')
      .join('cloud_deployments as d', 'd.id', 'r.deployment_id')
      .where('d.account_id', accountId)
      .whereNotNull('r.provider_id')
      .select('r.provider_id', 'r.deployment_id')
      .catch(() => [])) as { provider_id: string; deployment_id: string }[];
    return new Map(rows.map((r) => [String(r.provider_id), String(r.deployment_id)]));
  }

  // ---------- reads ----------

  /** The last successful fetch of an account, and whether its billing data is fresh enough for budgets. */
  async billingState(accountId: string, now = this.now()): Promise<{ billing: boolean; lastFetchedAt: number | null; reason: string }> {
    if (!(await this.installed())) return { billing: false, lastFetchedAt: null, reason: 'Billing ingestion is not installed (migration 155_cloud_costs).' };
    const r = (await this.db('cloud_cost_fetches').where({ account_id: accountId, state: 'ok' }).orderBy('finished_at', 'desc').first('finished_at')) as { finished_at?: unknown } | undefined;
    const last = r?.finished_at == null ? null : Number(r.finished_at);
    if (last == null) return { billing: false, lastFetchedAt: null, reason: 'No billing data has been fetched for this account yet.' };
    if (now - last > BILLING_FRESH_MS) return { billing: false, lastFetchedAt: last, reason: `The last billing fetch is older than ${BILLING_FRESH_MS / DAY} days.` };
    return { billing: true, lastFetchedAt: last, reason: 'Billing data fetched within the last 3 days.' };
  }

  async rows(accountId: string, o: { from: string; to: string; deploymentId?: string }): Promise<CostRow[]> {
    const q = this.db('cloud_costs').where({ account_id: accountId }).where('day', '>=', o.from).where('day', '<', o.to);
    if (o.deploymentId) q.where({ deployment_id: o.deploymentId });
    return ((await q.orderBy([{ column: 'day' }, { column: 'service' }])) as Record<string, unknown>[]).map(rowFrom);
  }

  async fetches(accountId: string, limit = 20): Promise<CostFetch[]> {
    return ((await this.db('cloud_cost_fetches').where({ account_id: accountId }).orderBy('started_at', 'desc').limit(limit)) as Record<string, unknown>[]).map(fetchFrom);
  }

  /** Rows summed by day, deployment or service (per currency, never converted). */
  async grouped(accountId: string, o: { from: string; to: string; by: 'day' | 'deployment' | 'service'; deploymentId?: string }): Promise<{ key: string; deploymentId: string | null; currency: string; amount: number; estimated: boolean }[]> {
    const m = new Map<string, { key: string; deploymentId: string | null; currency: string; amount: number; estimated: boolean }>();
    for (const r of await this.rows(accountId, o)) {
      const key = o.by === 'day' ? r.day : o.by === 'service' ? r.service : (r.deploymentId ?? '');
      const k = `${key}|${r.currency}`;
      const had = m.get(k) ?? { key, deploymentId: o.by === 'deployment' ? r.deploymentId : null, currency: r.currency, amount: 0, estimated: false };
      had.amount = round6(had.amount + r.amount);
      had.estimated ||= r.estimated;
      m.set(k, had);
    }
    return [...m.values()].map((x) => ({ ...x, amount: round2(x.amount) })).sort((a, b) => a.key.localeCompare(b.key) || a.currency.localeCompare(b.currency));
  }

  /**
   * Estimate against actual per deployment over [from, to) (days, UTC): the applied plans' estimates prorated over the
   * period (as `EstimatedSpend` reckons them) against the ingested rows, in the account's billing currency. Rows in
   * another currency are listed apart; unattributed rows are their own line.
   */
  async estimateVsActual(account: CloudAccount, o: { from: string; to: string; deploymentId?: string }): Promise<EstimateVsActual> {
    const currency = currencyFor(account);
    const deps = (await this.db('cloud_deployments').where({ account_id: account.id }).modify((q) => (o.deploymentId ? q.where({ id: o.deploymentId }) : q)).select('id', 'name', 'state').catch(() => [])) as { id: string; name: string; state: string }[];
    const fromT = dayStart(o.from);
    const toT = Math.min(dayStart(o.to), Math.max(this.now(), fromT));
    const est = await estimatedBetween(this.s, deps.map((d) => d.id), fromT, toT, currency);
    const rows = await this.rows(account.id, o);
    const actual = new Map<string, number>();
    const other: Record<string, number> = {};
    let unattributed = 0;
    for (const r of rows) {
      if (r.currency !== currency) {
        other[r.currency] = (other[r.currency] ?? 0) + r.amount;
        continue;
      }
      if (r.deploymentId) actual.set(r.deploymentId, (actual.get(r.deploymentId) ?? 0) + r.amount);
      else unattributed += r.amount;
    }
    for (const k of Object.keys(other)) other[k] = round2(other[k]!);
    const lines = deps.map((d) => {
      const e = est.get(d.id);
      const a = round2(actual.get(d.id) ?? 0);
      const estimate = e ? round2(e.amount) : 0;
      return { deploymentId: d.id, name: d.name, state: d.state, estimate, actual: a, difference: round2(a - estimate), ratio: estimate > 0 ? Math.round((a / estimate) * 1000) / 1000 : null, excluded: e?.excluded ?? [] };
    });
    const total = { estimate: round2(lines.reduce((n, l) => n + l.estimate, 0)), actual: round2(lines.reduce((n, l) => n + l.actual, 0) + (o.deploymentId ? 0 : unattributed)) };
    return { account: { id: account.id, name: account.name, provider: account.provider }, from: o.from, to: o.to, currency, deployments: lines, unattributed: o.deploymentId ? 0 : round2(unattributed), otherCurrencies: other, total };
  }

  /** Per account a principal may see: this month's billed total, where budgets take spend from, the last fetch. */
  async summary(p: Principal): Promise<CostSummary[]> {
    await this.need();
    const now = this.now();
    const m = monthOf(now);
    const out: CostSummary[] = [];
    for (const a of await this.s().cloud.accounts.list(p)) {
      const rows = await this.rows(a.id, { from: dayOf(m.start), to: dayOf(m.end) });
      const totals: Record<string, number> = {};
      for (const r of rows) totals[r.currency] = (totals[r.currency] ?? 0) + r.amount;
      for (const k of Object.keys(totals)) totals[k] = round2(totals[k]!);
      const [last] = await this.fetches(a.id, 1);
      const state = await this.billingState(a.id, now);
      const currency = currencyFor(a);
      const eva = await this.estimateVsActual(a, { from: dayOf(m.start), to: dayOf(m.end) });
      out.push({ account: { id: a.id, name: a.name, provider: a.provider, scope: a.scope }, month: m.key, currency, monthToDate: totals, budgetSource: state.billing ? 'billing' : 'estimate', reason: state.reason, eligible: this.eligibility(a), lastFetch: last ? { at: last.finishedAt ?? last.startedAt, state: last.state, error: last.error, manual: last.manual } : null, estimate: eva.total.estimate, actual: eva.total.actual });
    }
    return out;
  }

  // ---------- "fetch now" ----------

  /** Queues one manual fetch of an account (finops:manage; a platform account also platform:manage). */
  async requestFetch(a: CloudActor, accountId: string): Promise<{ jobId: string; key: string }> {
    await this.need();
    const acct = await this.s().cloud.accounts.getFor(a.principal, accountId);
    this.s().cloud.accounts.assertCanChange(a.principal, acct);
    const why = this.eligibility(acct);
    if (why) throw new HttpProblem(409, 'Conflict', why, { extensions: { reason: 'billing_not_available' } });
    const now = this.now();
    const key = `${new Date(now).toISOString().slice(0, 13)}:manual`;
    const had = (await this.db('cloud_cost_fetches').where({ account_id: acct.id, fetch_key: key }).first('state', 'attempts')) as { state?: string; attempts?: number } | undefined;
    if (had && (had.state !== 'failed' || Number(had.attempts) >= MAX_ATTEMPTS)) {
      const next = Date.parse(`${key.slice(0, 13)}:00:00Z`) + HOUR;
      throw new HttpProblem(409, 'Conflict', `${acct.name} was already fetched by hand this hour; each fetch is a paid provider request. Try again after ${new Date(next).toISOString()}.`, { extensions: { reason: 'costs_recent', retryAt: next } });
    }
    const tenantId = await this.s().cloud.budgets.tenantOf(acct);
    const job = await this.s().jobs.enqueue({ tenantId, type: 'cloud.costs.ingest', payload: { accountId: acct.id, manual: true, requestedBy: a.principal.userId }, createdBy: a.principal.userId });
    await cloudAudit(this.s(), { tenantId, action: 'cloud.costs.fetch.requested', actor: a, detail: { account: acct.id, name: acct.name, provider: acct.provider, job: job.id } });
    return { jobId: job.id, key };
  }

  // ---------- jobs ----------

  registerJobs(): void {
    this.s().jobs.register('cloud.costs.ingest', async (p, ctx) => {
      if (p.accountId) {
        const r = await this.ingestAccount(String(p.accountId), { manual: !!p.manual, requestedBy: (p.requestedBy as string | undefined) ?? null, jobId: ctx.job.id });
        await ctx.progress(100, r.state === 'ok' ? `${r.rows} cost rows from ${r.requests} requests` : r.state === 'failed' ? `failed: ${r.error}` : `skipped: ${r.reason}`);
        return r;
      }
      const out = await this.ingest({ jobId: ctx.job.id, progress: (done, of) => ctx.progress(Math.round((done / Math.max(1, of)) * 100), `${done} of ${of} accounts`) });
      await ctx.progress(100, `${out.fetched} accounts fetched, ${out.skipped} skipped, ${out.failed} failed`);
      return { accounts: out.accounts, fetched: out.fetched, skipped: out.skipped, failed: out.failed };
    }, { timeoutMs: 30 * 60_000 });
    // Sprint 61 (B-10608): Workers AI neurons in the analytics against the metered ones; a mismatch is audited.
    this.s().jobs.register('cloud.costs.neurons.check', async (p, ctx) => {
      const accountId = String(p.accountId ?? '');
      const account = accountId ? await this.s().cloud.accounts.get(accountId) : null;
      if (!account || account.provider !== 'cloudflare') return { skipped: 'not a Cloudflare account' };
      const win = { from: String(p.from ?? this.window().from), to: String(p.to ?? this.window().to) };
      const r = await this.neuronCheck(account.id, win);
      if (r.mismatches.length) {
        const tenantId = await this.s().cloud.budgets.tenantOf(account);
        await cloudAudit(this.s(), { tenantId, action: 'cloud.costs.neurons.mismatch', actor: { service: 'cloud-costs', onBehalfOf: null, jobId: ctx.job.id }, detail: { account: account.id, name: account.name, window: win, tolerance: 0.01, days: r.mismatches.slice(0, 31).map((d) => ({ day: d.day, analytics: d.analytics, metered: d.metered, difference: d.difference })) } });
        this.s().log.warn({ account: account.id, days: r.mismatches.map((d) => d.day) }, 'Workers AI neurons differ from the metered ones by more than 1 %');
      }
      const na = r.unavailable.length ? `, ${r.unavailable.length} with analytics unavailable` : '';
      await ctx.progress(100, (r.mismatches.length ? `${r.mismatches.length} of ${r.days.length} days differ by more than 1 %` : `${r.days.length - r.unavailable.length} days match within 1 %`) + na);
      return { days: r.days.length, mismatches: r.mismatches.length, unavailable: r.unavailable.length };
    });
  }

  /** Daily, as the platform tenant; nothing is queued until an active account exists. */
  schedule(scheduler: Scheduler): void {
    scheduler.every('cloud.costs.ingest', DAY, async () => {
      if (!(await this.installed())) return [];
      const any = await this.db('cloud_accounts').where({ state: 'active' }).whereIn('provider', ['aws', 'azure', 'digitalocean', 'cloudflare']).first('id').catch(() => null);
      if (!any) return [];
      const t = await this.s().tenants.bySlug(this.s().cfg.DEFAULT_TENANT);
      return t ? [{ tenantId: t.id, payload: {} }] : [];
    });
  }
}

export interface EstimateVsActual {
  account: { id: string; name: string; provider: Provider };
  from: string;
  to: string;
  currency: string;
  deployments: { deploymentId: string; name: string; state: string; estimate: number; actual: number; difference: number; ratio: number | null; excluded: string[] }[];
  unattributed: number;
  otherCurrencies: Record<string, number>;
  total: { estimate: number; actual: number };
}

export interface CostSummary {
  account: { id: string; name: string; provider: Provider; scope: string };
  month: string;
  currency: string;
  /** This month's ingested total per currency. */
  monthToDate: Record<string, number>;
  /** Where the account's budget takes spend from now. */
  budgetSource: 'billing' | 'estimate';
  reason: string;
  /** Why the account is not fetched, or null. */
  eligible: string | null;
  lastFetch: { at: number; state: string; error: string | null; manual: boolean } | null;
  /** This month so far: the applied plans' estimates against the ingested rows (account currency). */
  estimate: number;
  actual: number;
}
