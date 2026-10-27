import sheetJson from './price-sheet.json' with { type: 'json' };
import type { Services } from '../services.js';
import type { CloudTransport } from './providers/transport.js';
import { CloudProviderError } from './providers/types.js';
import { namePrefix } from './tags.js';
import type { CloudAccount } from './types.js';

/*
 * 1.9.99-final, Sprint 61 (B-10608): Cloudflare billing for `cloud/costs.ts`.
 *
 * Cloudflare has no per-resource cost API, so a fetch is three calls through the Cloudflare transport with the
 * account's billing token, at most once a UTC day per account (the claim in `cloud_cost_fetches`, as for the others):
 *
 * 1. TWO GraphQL Analytics requests (`POST /client/v4/graphql`) for the whole window, each with one aliased dataset per
 *    product and calendar month (`workers0`, `workers1`, ...: Cloudflare answers at most 31 days per dataset query,
 *    developers.cloudflare.com/r2/platform/metrics-analytics/ and /analytics/graphql-api/tutorials/querying-workers-metrics/):
 *    Workers (`workersInvocationsAdaptive`: requests and CPU time per script), Containers
 *    (`containersUsageAdaptiveGroups`: CPU seconds and allocated memory and disk byte-seconds per application id, the
 *    dataset Cloudflare names for billing estimates, developers.cloudflare.com/analytics/graphql-api/tutorials/querying-container-metrics/),
 *    R2 (`r2StorageAdaptiveGroups`: stored bytes per bucket; `r2OperationsAdaptiveGroups`: operations per bucket and
 *    action) in the first; Workers AI (`aiInferenceAdaptiveGroups`: neurons per model) alone in the second, because
 *    that dataset has no public schema page and an unknown field fails the whole GraphQL request. When the Workers AI
 *    request fails, the other products' rows are still written: the fetch is partial (`note.partial.workersAi`, the
 *    error without secrets), has no Workers AI rows, and the neuron check reports its days as analytics unavailable
 *    (`note.analytics.neurons: false`). Cloudflare Tunnel costs nothing and has no documented analytics dataset, so it
 *    is not queried. Each
 *    day's usage is priced at the published usage rates below (included allocations are not subtracted), as
 *    `cloudflare-analytics` rows marked estimated, attributed by the script, application or bucket to the deployment
 *    that owns it (its provider id, else the `exprsn-<account>-<deployment>-` name prefix). The day's neurons are kept
 *    with the fetch (`note.analytics`) for the neuron check.
 * 2. The account's billing history (`GET /client/v4/accounts/{account_id}/billing/history`, "Billing Read",
 *    developers.cloudflare.com/api/resources/billing/subresources/history/methods/list/; the user-level
 *    `/user/billing/history` is deprecated), paged to the end (its order is not documented): what Cloudflare actually
 *    charged. For each FINISHED month in the window that has
 *    charges, one `cloudflare-billing` row per day carries the difference between the month's charges and its priced
 *    analytics (plan fees, included allowances, rounding), unattributed, so the month's rows add up to what was billed
 *    while the daily attribution stays. Charges in a currency other than the analytics' (USD) replace that month's
 *    analytics rows instead (never converted, open decision 17).
 *
 * The window is the usual one (the last 14 days and the whole current month) extended back to the start of the
 * previous month, so the last finished month is always reconciled from complete analytics in the same request.
 *
 * Dataset and field names, checked against developers.cloudflare.com on 2026-10-21 (the nightly sandbox run, B-10804,
 * confirms them against the live schema):
 * - documented: `workersInvocationsAdaptive` with `sum { requests }` and `dimensions { scriptName }`;
 *   `containersUsageAdaptiveGroups` with `dimensions { date applicationId }` and
 *   `sum { cpuTimeSec allocatedMemory allocatedDisk }`; `r2StorageAdaptiveGroups` with `max { payloadSize metadataSize }`
 *   and `dimensions { bucketName }`; `r2OperationsAdaptiveGroups` with `sum { requests }` and
 *   `dimensions { bucketName actionType }`.
 * - NOT confirmed by Cloudflare's public docs: `sum { cpuTimeUs }` on `workersInvocationsAdaptive` (the docs show only
 *   `quantiles { cpuTimeP50 cpuTimeP99 }`); the `date` dimension and `date_geq`/`date_lt` filters on the Workers and R2
 *   datasets (the docs show `datetime`); `aiInferenceAdaptiveGroups` with `sum { totalNeurons }` and
 *   `dimensions { modelId }` (no public schema page).
 * The fake (`server/test/fake-cloudflare-billing.ts`) serves the same shapes.
 */

const DAY = 86_400_000;
const SHEET = sheetJson as unknown as { currency: string; workersAi?: { neuronPrice: { price: number } } };

/**
 * Usage rates (USD) beyond the included allowances, from Cloudflare's pricing pages, each checked on 2026-10-21
 * (`sources` says where; review at every release). Included allowances are not subtracted here.
 */
export const CF_USAGE_RATES = {
  currency: 'USD',
  date: '2026-10-21',
  /** Workers Paid, Standard: USD 0.30 per additional million requests, 0.02 per additional million CPU ms. */
  workersRequestsPerMillion: 0.3,
  workersCpuMsPerMillion: 0.02,
  /** Containers (Workers Paid): USD 0.000020 per vCPU-second (active use), 0.0000025 per GiB-second of memory and
   * 0.00000007 per GB-second of disk (both provisioned). Egress (0.025 to 0.05 per GB by region) is not priced here. */
  containersVcpuSecond: 0.00002,
  containersGibSecond: 0.0000025,
  containersDiskGbSecond: 0.00000007,
  /** R2 Standard: USD 0.015 per GB-month, 4.50 per million Class A and 0.36 per million Class B operations
   * (Infrequent Access, 0.01 / 9.00 / 0.90, is not told apart by the analytics and is priced as Standard). */
  r2GbMonth: 0.015,
  r2ClassAPerMillion: 4.5,
  r2ClassBPerMillion: 0.36,
  /** Workers AI: per 1,000 neurons (USD 0.011 on the pricing page), from the price sheet's `workersAi.neuronPrice` (B-10509). */
  get neuronsPerThousand(): number {
    return SHEET.workersAi?.neuronPrice.price ?? 0.011;
  },
  /** Cloudflare Tunnel: no charge (1,000 tunnels per account included; Tunnels for Platforms, USD 4.50 per additional
   * tunnel a month, is not priced here). */
  tunnel: 0,
  sources: {
    workers: 'https://developers.cloudflare.com/workers/platform/pricing/ (2026-10-21)',
    containers: 'https://developers.cloudflare.com/containers/pricing/ (2026-10-21)',
    r2: 'https://developers.cloudflare.com/r2/pricing/ (2026-10-21)',
    workersAi: 'https://developers.cloudflare.com/workers-ai/platform/pricing/ (2026-10-21)',
    tunnel: 'https://developers.cloudflare.com/tunnel/features/tunnels-for-platforms/ (2026-10-21)'
  }
} as const;

/** R2 operations by class, as developers.cloudflare.com/r2/pricing/ lists them (2026-10-21): Class A mutate and list,
 * Class B read (anything else), free deletes. `ListObjectsV2` and `DeleteObjects` are not on the page (kept with
 * their S3 siblings, unconfirmed). */
const R2_CLASS_A = new Set(['PutObject', 'CopyObject', 'CompleteMultipartUpload', 'CreateMultipartUpload', 'UploadPart', 'UploadPartCopy', 'ListObjects', 'ListObjectsV2', 'ListMultipartUploads', 'ListParts', 'ListBuckets', 'PutBucket', 'PutBucketCors', 'PutBucketEncryption', 'PutBucketLifecycleConfiguration', 'LifecycleStorageTierTransition']);
const R2_FREE = new Set(['DeleteObject', 'DeleteObjects', 'AbortMultipartUpload', 'DeleteBucket']);

export const CF_SERVICES = { workers: 'Workers', containers: 'Containers', r2: 'R2', tunnel: 'Tunnel', workersAi: 'Workers AI', adjustment: 'Cloudflare billing' } as const;

/** The datasets of the first GraphQL request, by the alias prefix the answer is read by. */
export const CF_ANALYTICS_DATASETS = {
  workers: 'workersInvocationsAdaptive { dimensions { date scriptName } sum { requests cpuTimeUs } }',
  containers: 'containersUsageAdaptiveGroups { dimensions { date applicationId } sum { cpuTimeSec allocatedMemory allocatedDisk } }',
  r2Storage: 'r2StorageAdaptiveGroups { dimensions { date bucketName } max { payloadSize metadataSize } }',
  r2Operations: 'r2OperationsAdaptiveGroups { dimensions { date bucketName actionType } sum { requests } }'
} as const;
/** The second GraphQL request's dataset, asked for on its own: it is not in Cloudflare's public schema docs. */
export const CF_WORKERS_AI_DATASETS = {
  workersAi: 'aiInferenceAdaptiveGroups { dimensions { date modelId } sum { totalNeurons } }'
} as const;

/** The window cut at month boundaries: every piece is at most 31 days, Cloudflare's limit for one dataset query. */
export function cloudflareChunks(win: { from: string; to: string }): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (let t = dayStart(win.from), end = dayStart(win.to); t < end; ) {
    const next = Math.min(nextMonth(t), end);
    out.push({ from: dayOf(t), to: dayOf(next) });
    t = next;
  }
  return out;
}

/** A GraphQL query: the given datasets for every month (`<alias><n>`, read back by those aliases). */
export function cfAnalyticsQuery(chunks: number, datasets: Record<string, string> = CF_ANALYTICS_DATASETS, name = 'ExprsnCosts'): string {
  const vars = Array.from({ length: chunks }, (_, i) => `, $from${i}: Date!, $to${i}: Date!`).join('');
  const fields: string[] = [];
  for (let i = 0; i < chunks; i++)
    for (const [alias, sel] of Object.entries(datasets)) {
      const at = sel.indexOf(' ');
      fields.push(`      ${alias}${i}: ${sel.slice(0, at)}(limit: 10000, filter: { date_geq: $from${i}, date_lt: $to${i} }) ${sel.slice(at + 1)}`);
    }
  return `query ${name}($accountTag: string!${vars}) {\n  viewer {\n    accounts(filter: { accountTag: $accountTag }) {\n${fields.join('\n')}\n    }\n  }\n}`;
}

interface Group<D, S> {
  dimensions?: D;
  sum?: S;
  max?: S;
}
type CfGroup = Group<Record<string, string | undefined>, Record<string, number | undefined>>;
export interface CfAnalyticsAnswer {
  data?: {
    viewer?: {
      /** By `<alias><n>` (`workers0`, `containers1`, ...). */
      accounts?: Record<string, CfGroup[] | undefined>[];
    } | null;
  } | null;
  errors?: { message?: string; path?: string[] }[] | null;
}

interface CfHistory {
  success?: boolean;
  result?: { id?: string; type?: string; action?: string; description?: string; occurred_at?: string; amount?: number | string; currency?: string; status?: string }[];
  result_info?: { page?: number; per_page?: number; count?: number; total_count?: number; total_pages?: number };
}

/** A daily cost row as `cloud/costs.ts` stores it (its `Draft`). */
export interface CfDraft {
  deploymentId: string | null;
  allocation: string;
  service: string;
  day: string;
  amount: number;
  currency: string;
  source: 'cloudflare-analytics' | 'cloudflare-billing';
  estimated: boolean;
}

/** Per day: the usage the analytics reported (kept with the fetch). */
export interface CfDayUsage {
  neurons: number;
  workersRequests: number;
  workersCpuMs: number;
  containerVcpuSeconds: number;
  r2StoredGb: number;
  r2ClassA: number;
  r2ClassB: number;
}

export interface CfFetched {
  rows: CfDraft[];
  ranges: { from: string; to: string; sources: ('cloudflare-analytics' | 'cloudflare-billing')[] }[];
  requests: number;
  window: { from: string; to: string };
  note: {
    /** `neurons: false` when the Workers AI request failed: the days' neurons are unknown, not 0. */
    analytics: { days: Record<string, CfDayUsage>; rates: string; neurons: boolean };
    /** Present when part of the analytics was unavailable (the rest was still written). */
    partial?: { workersAi: string };
    billing: { month: string; currency: string; charged: number; analytics: number | null; adjustment: number | null }[]; charges: number };
}

function dayOf(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}
function dayStart(d: string): number {
  return Date.parse(`${d}T00:00:00Z`);
}
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const isDay = (d: unknown): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
const monthStart = (t: number): number => Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), 1);
function nextMonth(t: number): number {
  return Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth() + 1, 1);
}

const describeCf = (status: number, b: unknown) => {
  const e = (b as { errors?: { code?: number; message?: string }[] } | null)?.errors?.[0];
  return { message: `Cloudflare billing answered ${status}${e?.message ? `: ${String(e.message).slice(0, 200)}` : ''}.`, code: e?.code != null ? String(e.code) : null };
};

/** The window a Cloudflare fetch covers: the usual one, from the start of the previous month at the latest. */
export function cloudflareWindow(win: { from: string; to: string }, now: number): { from: string; to: string } {
  const prev = dayOf(monthStart(monthStart(now) - 1));
  return { from: win.from < prev ? win.from : prev, to: win.to };
}

export interface CfFetchContext {
  s: Services;
  account: CloudAccount;
  token: string;
  /** The API origin (default `https://api.cloudflare.com`). */
  base: string;
  transport: CloudTransport;
  win: { from: string; to: string };
  now: number;
  /** Provider ids of the account's resources → deployment id. */
  owners: Map<string, string>;
  /** The account's deployments by lower-case name. */
  byName: Map<string, string>;
  /** Counts a provider request. */
  count: () => void;
}

/** Fetches a Cloudflare account's analytics and billing history and turns them into daily rows. */
export async function fetchCloudflare(c: CfFetchContext): Promise<CfFetched> {
  const accountTag = c.account.providerIds.cloudflareAccountId;
  if (!accountTag) throw new CloudProviderError(`The account ${c.account.name} has no Cloudflare account id.`, 'cloudflare', 400, 'no_account_id');
  const api = `${c.base.replace(/\/+$/, '')}/client/v4`;
  const win = cloudflareWindow(c.win, c.now);
  const headers = { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' };
  let requests = 0;

  // ---------- 1. GraphQL Analytics: the documented products, then Workers AI on its own ----------
  const chunks = cloudflareChunks(win);
  const variables: Record<string, string> = { accountTag };
  chunks.forEach((k, i) => Object.assign(variables, { [`from${i}`]: k.from, [`to${i}`]: k.to }));
  const graphql = async (datasets: Record<string, string>, name: string) => {
    c.count();
    requests += 1;
    const res = await c.transport.json<CfAnalyticsAnswer>({ method: 'POST', url: `${api}/graphql`, headers, body: JSON.stringify({ query: cfAnalyticsQuery(chunks.length, datasets, name), variables }), accountId: c.account.id, apiClass: 'billing' }, describeCf);
    if (res.body.errors?.length) throw new CloudProviderError(`Cloudflare analytics answered with errors: ${String(res.body.errors[0]?.message ?? 'unknown').slice(0, 200)}`, 'cloudflare', 502, 'analytics_error');
    const answered = res.body.data?.viewer?.accounts?.[0] ?? {};
    return (alias: string) => chunks.flatMap((_, i) => answered[`${alias}${i}`] ?? []);
  };
  const groups = await graphql(CF_ANALYTICS_DATASETS, 'ExprsnCosts');
  // A failure here (an unknown field, a missing permission) leaves the other products' rows standing: partial.
  let partial: { workersAi: string } | undefined;
  let workersAi: CfGroup[] = [];
  try {
    workersAi = (await graphql(CF_WORKERS_AI_DATASETS, 'ExprsnWorkersAi'))('workersAi');
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).split(c.token).join('[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 300);
    partial = { workersAi: `Workers AI neurons were unavailable: ${message}` };
  }
  const acct = { workers: groups('workers'), containers: groups('containers'), r2Storage: groups('r2Storage'), r2Operations: groups('r2Operations'), workersAi };
  const prefix = namePrefix(c.account.name);
  const deploymentOf = (name: string): string | null => {
    if (!name) return null;
    const own = c.owners.get(name);
    if (own) return own;
    if (!name.startsWith(prefix)) return null;
    const rest = name.slice(prefix.length).toLowerCase();
    let best: { len: number; id: string } | null = null;
    for (const [n, id] of c.byName) if ((rest === n || rest.startsWith(`${n}-`)) && (!best || n.length > best.len)) best = { len: n.length, id };
    return best?.id ?? null;
  };
  const days: Record<string, CfDayUsage> = {};
  const usage = (d: string): CfDayUsage => (days[d] ??= { neurons: 0, workersRequests: 0, workersCpuMs: 0, containerVcpuSeconds: 0, r2StoredGb: 0, r2ClassA: 0, r2ClassB: 0 });
  const rows: CfDraft[] = [];
  const R = CF_USAGE_RATES;
  const push = (day: string, service: string, allocation: string, amount: number) => {
    if (!(amount > 0) || day < win.from || day >= win.to) return;
    rows.push({ deploymentId: deploymentOf(allocation), allocation, service, day, amount: round6(amount), currency: R.currency, source: 'cloudflare-analytics', estimated: true });
  };
  const inWin = (d: unknown): d is string => isDay(d) && d >= win.from && d < win.to;
  for (const g of acct.workers) {
    const d = g.dimensions?.date;
    if (!inWin(d)) continue;
    const reqs = num(g.sum?.requests);
    const cpuMs = num(g.sum?.cpuTimeUs) / 1000;
    usage(d).workersRequests += reqs;
    usage(d).workersCpuMs += cpuMs;
    push(d, CF_SERVICES.workers, String(g.dimensions?.scriptName ?? ''), (reqs / 1e6) * R.workersRequestsPerMillion + (cpuMs / 1e6) * R.workersCpuMsPerMillion);
  }
  for (const g of acct.containers) {
    const d = g.dimensions?.date;
    if (!inWin(d)) continue;
    const cpu = num(g.sum?.cpuTimeSec);
    // Allocated memory and disk come in byte-seconds: memory is priced per GiB-second, disk per GB-second.
    const memGibSec = num(g.sum?.allocatedMemory) / 2 ** 30;
    const diskGbSec = num(g.sum?.allocatedDisk) / 1e9;
    usage(d).containerVcpuSeconds += cpu;
    push(d, CF_SERVICES.containers, String(g.dimensions?.applicationId ?? ''), cpu * R.containersVcpuSecond + memGibSec * R.containersGibSecond + diskGbSec * R.containersDiskGbSecond);
  }
  for (const g of acct.r2Storage) {
    const d = g.dimensions?.date;
    if (!inWin(d)) continue;
    const gb = (num(g.max?.payloadSize) + num(g.max?.metadataSize)) / 1e9;
    usage(d).r2StoredGb += gb;
    const t = dayStart(d);
    const daysInMonth = Math.round((nextMonth(t) - monthStart(t)) / DAY);
    push(d, CF_SERVICES.r2, String(g.dimensions?.bucketName ?? ''), (gb * R.r2GbMonth) / daysInMonth);
  }
  for (const g of acct.r2Operations) {
    const d = g.dimensions?.date;
    if (!inWin(d)) continue;
    const action = String(g.dimensions?.actionType ?? '');
    if (R2_FREE.has(action)) continue;
    const n = num(g.sum?.requests);
    const classA = R2_CLASS_A.has(action);
    if (classA) usage(d).r2ClassA += n;
    else usage(d).r2ClassB += n;
    push(d, CF_SERVICES.r2, String(g.dimensions?.bucketName ?? ''), (n / 1e6) * (classA ? R.r2ClassAPerMillion : R.r2ClassBPerMillion));
  }
  for (const g of acct.workersAi) {
    const d = g.dimensions?.date;
    if (!inWin(d)) continue;
    const neurons = num(g.sum?.totalNeurons);
    usage(d).neurons += neurons;
    // Workers AI is not a deployment's resource: the model id is the allocation, and showback splits it by the
    // metered usage of the pools that hold this account's Workers AI instances.
    push(d, CF_SERVICES.workersAi, String(g.dimensions?.modelId ?? ''), (neurons / 1000) * R.neuronsPerThousand);
  }
  for (const u of Object.values(days)) for (const k of Object.keys(u) as (keyof CfDayUsage)[]) u[k] = round6(u[k]);

  // ---------- 2. the account's billing history (charges), every page (its order is not documented) ----------
  const charges: { day: string; amount: number; currency: string }[] = [];
  const PER_PAGE = 50;
  for (let page = 1; page <= 20; page++) {
    c.count();
    requests += 1;
    const h = await c.transport.json<CfHistory>({ method: 'GET', url: `${api}/accounts/${encodeURIComponent(accountTag)}/billing/history?per_page=${PER_PAGE}&page=${page}`, headers: { authorization: headers.authorization }, accountId: c.account.id, apiClass: 'billing' }, describeCf);
    const items = h.body.result ?? [];
    for (const it of items) {
      const at = Date.parse(String(it.occurred_at ?? ''));
      if (!Number.isFinite(at)) continue;
      const d = dayOf(at);
      if (d < win.from || d >= win.to || (it.type && it.type !== 'charge')) continue;
      const amount = num(it.amount);
      if (amount) charges.push({ day: d, amount, currency: String(it.currency ?? 'USD').toUpperCase() });
    }
    const info = h.body.result_info;
    const per = num(info?.per_page) || PER_PAGE;
    const pages = num(info?.total_pages) || (info?.total_count != null ? Math.ceil(num(info.total_count) / per) : 0);
    if (!items.length || !pages || page >= pages) break;
  }

  // ---------- 3. reconcile each finished month that has charges ----------
  const ranges: CfFetched['ranges'] = [{ ...win, sources: ['cloudflare-analytics'] }];
  const billing: CfFetched['note']['billing'] = [];
  const current = monthStart(c.now);
  const byMonth = new Map<string, Map<string, number>>();
  for (const ch of charges) {
    const m = ch.day.slice(0, 7);
    if (dayStart(`${m}-01`) >= current) continue;
    const cur = byMonth.get(m) ?? new Map<string, number>();
    cur.set(ch.currency, (cur.get(ch.currency) ?? 0) + ch.amount);
    byMonth.set(m, cur);
  }
  let out = rows;
  for (const [m, perCurrency] of byMonth) {
    const ms = dayStart(`${m}-01`);
    const me = nextMonth(ms);
    const from = dayOf(Math.max(ms, dayStart(win.from)));
    const to = dayOf(me);
    if (from >= to) continue;
    const days0: string[] = [];
    for (let t = dayStart(from); t < me; t += DAY) days0.push(dayOf(t));
    ranges.push({ from, to, sources: ['cloudflare-billing'] });
    for (const [currency, charged] of perCurrency) {
      if (currency === R.currency) {
        const analytics = round6(out.filter((r) => r.day >= from && r.day < to).reduce((n, r) => n + r.amount, 0));
        const adjustment = round6(charged - analytics);
        billing.push({ month: m, currency, charged: round6(charged), analytics, adjustment });
        spread(adjustment, days0).forEach((amount, i) => out.push({ deploymentId: null, allocation: '', service: CF_SERVICES.adjustment, day: days0[i]!, amount, currency, source: 'cloudflare-billing', estimated: false }));
      } else {
        // Another currency: the month's charges stand on their own and its analytics rows (USD) are dropped.
        out = out.filter((r) => r.source !== 'cloudflare-analytics' || r.day < from || r.day >= to);
        billing.push({ month: m, currency, charged: round6(charged), analytics: null, adjustment: null });
        spread(charged, days0).forEach((amount, i) => out.push({ deploymentId: null, allocation: '', service: CF_SERVICES.adjustment, day: days0[i]!, amount, currency, source: 'cloudflare-billing', estimated: false }));
      }
    }
  }
  return { rows: out, ranges, requests, window: win, note: { analytics: { days, rates: R.date, neurons: !partial }, ...(partial ? { partial } : {}), billing, charges: charges.length } };
}

/** An amount spread evenly over days, the rounding remainder on the last one, so the parts add up exactly. */
function spread(amount: number, days: string[]): number[] {
  if (!days.length) return [];
  const each = round6(amount / days.length);
  const out = days.map(() => each);
  out[out.length - 1] = round6(amount - each * (days.length - 1));
  return out;
}

// ---------- the neuron check ----------

export interface NeuronDay {
  day: string;
  /** null when the day's Workers AI analytics were unavailable (the fetch was partial). */
  analytics: number | null;
  metered: number;
  /** |analytics − metered| / max(analytics, metered), or 0 when both are 0 (or the analytics are unavailable). */
  difference: number;
  /** Within the tolerance; false for a mismatch and for a day whose analytics are unavailable. */
  ok: boolean;
  /** `unavailable`: no Workers AI analytics for the day ("analytics unavailable"), never a mismatch. */
  state: 'ok' | 'mismatch' | 'unavailable';
}

/** Workers AI neurons may differ from the metered ones by this share before a mismatch is reported. */
export const NEURON_TOLERANCE = 0.01;

/** The pools that hold a Workers AI instance of this account. */
export async function workersAiPoolsOf(s: Services, accountId: string): Promise<string[]> {
  const rows = await s.gateway.repo.instances().catch(() => []);
  return [...new Set(rows.filter((r) => r.settings.cloud?.flavour === 'workers-ai' && r.settings.cloud?.accountId === accountId).map((r) => r.pool_id))];
}

/** Per day: the analytics' neurons (null: unavailable) against the neurons metered on `usage_records` for the account's Workers AI pools. */
export async function compareNeurons(s: Services, accountId: string, analytics: Record<string, number | null>, o: { from: string; to: string }): Promise<NeuronDay[]> {
  const pools = await workersAiPoolsOf(s, accountId);
  const metered = new Map<string, number>();
  if (pools.length && (await s.db.schema.hasColumn('usage_records', 'neurons').catch(() => false))) {
    const rows = (await s.db('usage_records')
      .whereIn('pool_id', pools)
      .where('day', '>=', Number(o.from.replace(/-/g, '')))
      .where('day', '<', Number(o.to.replace(/-/g, '')))
      .whereNotNull('neurons')
      .groupBy('day')
      .select('day')
      .sum({ n: 'neurons' })) as { day: number | string; n: number | string | null }[];
    for (const r of rows) {
      const d = String(r.day);
      metered.set(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, Number(r.n ?? 0));
    }
  }
  const all = [...new Set([...Object.keys(analytics), ...metered.keys()])].filter((d) => d >= o.from && d < o.to).sort();
  return all.map((day): NeuronDay => {
    const m = metered.get(day) ?? 0;
    if (analytics[day] === null) return { day, analytics: null, metered: m, difference: 0, ok: false, state: 'unavailable' };
    const a = Number(analytics[day] ?? 0);
    const top = Math.max(a, m);
    const difference = top > 0 ? Math.abs(a - m) / top : 0;
    const ok = difference <= NEURON_TOLERANCE;
    return { day, analytics: a, metered: m, difference: Math.round(difference * 1e6) / 1e6, ok, state: ok ? 'ok' : 'mismatch' };
  });
}
