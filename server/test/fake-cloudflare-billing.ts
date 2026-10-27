/*
 * 1.9.99-final, Sprint 61 (B-10608): Cloudflare billing for `fake-cloudflare.ts`: the GraphQL Analytics API
 * (`POST /client/v4/graphql`, "Account Analytics Read") with the datasets `cloud/cloudflare-billing.ts` asks for
 * (Workers invocations, Containers usage, R2 storage and operations, Workers AI inference), each field filtered by the
 * query's `accountTag` and its own `date_geq`/`date_lt` variables (at most 31 days, as Cloudflare allows) and
 * answered under the query's aliases; and the account's billing history
 * (`GET /client/v4/accounts/{account_id}/billing/history`, "Billing Read") with paging (`page`, `per_page`;
 * `result_info.total_count`). A dataset the fake does not know answers a GraphQL error, as Cloudflare does for an
 * unknown field; `unknownDatasets` makes a known one unknown (a schema the code got wrong, e.g. Workers AI's, which
 * `cloud/cloudflare-billing.ts` asks for in its own request). It is never the real Cloudflare.
 */
import { randomBytes } from 'node:crypto';
import { json, type RecordedRequest, type Reply } from './fake-cloud-base.js';

type Row = { dimensions: Record<string, string>; sum?: Record<string, number>; max?: Record<string, number> };

const DATASETS = ['workersInvocationsAdaptive', 'containersUsageAdaptiveGroups', 'r2StorageAdaptiveGroups', 'r2OperationsAdaptiveGroups', 'aiInferenceAdaptiveGroups'] as const;
const DAY = 86_400_000;
type Dataset = (typeof DATASETS)[number];

export interface FakeCharge {
  id: string;
  type: 'charge';
  action: string;
  description: string;
  occurred_at: string;
  amount: number;
  currency: string;
}

export class FakeCloudflareBilling {
  /** Analytics rows per dataset (one per day and dimension). */
  readonly data = new Map<Dataset, Row[]>(DATASETS.map((d) => [d, []]));
  readonly charges: FakeCharge[] = [];
  /** Page size of the billing history. */
  historyPageSize = 50;
  /** Datasets answered as unknown fields (the whole request fails, as on Cloudflare). */
  readonly unknownDatasets = new Set<string>();
  /** The account the analytics belong to (set by `fake-cloudflare.ts`). */
  constructor(private readonly accountId: () => string) {}

  clear(): void {
    for (const d of DATASETS) this.data.set(d, []);
    this.charges.length = 0;
    this.historyPageSize = 50;
    this.unknownDatasets.clear();
  }

  workers(day: string, scriptName: string, requests: number, cpuTimeUs: number): void {
    this.data.get('workersInvocationsAdaptive')!.push({ dimensions: { date: day, scriptName }, sum: { requests, cpuTimeUs } });
  }
  /** Allocated memory and disk in byte-seconds, as `containersUsageAdaptiveGroups` reports them. */
  containers(day: string, applicationId: string, cpuTimeSec: number, allocatedMemory = 0, allocatedDisk = 0): void {
    this.data.get('containersUsageAdaptiveGroups')!.push({ dimensions: { date: day, applicationId }, sum: { cpuTimeSec, allocatedMemory, allocatedDisk } });
  }
  r2Storage(day: string, bucketName: string, payloadSize: number): void {
    this.data.get('r2StorageAdaptiveGroups')!.push({ dimensions: { date: day, bucketName }, max: { payloadSize, metadataSize: 0 } });
  }
  r2Operations(day: string, bucketName: string, actionType: string, requests: number): void {
    this.data.get('r2OperationsAdaptiveGroups')!.push({ dimensions: { date: day, bucketName, actionType }, sum: { requests } });
  }
  neurons(day: string, modelId: string, totalNeurons: number): void {
    this.data.get('aiInferenceAdaptiveGroups')!.push({ dimensions: { date: day, modelId }, sum: { totalNeurons } });
  }
  charge(occurredAt: string, amount: number, description = 'Workers Paid', currency = 'USD'): FakeCharge {
    const c: FakeCharge = { id: randomBytes(16).toString('hex'), type: 'charge', action: 'subscription', description, occurred_at: occurredAt, amount, currency };
    this.charges.push(c);
    return c;
  }

  /** What the analytics hold for a day (the tests' own view, outside the code under test). */
  neuronsOn(day: string): number {
    return this.data.get('aiInferenceAdaptiveGroups')!.filter((r) => r.dimensions.date === day).reduce((n, r) => n + (r.sum?.totalNeurons ?? 0), 0);
  }

  matches(path: string): boolean {
    return path === '/graphql' || path === `/accounts/${this.accountId()}/billing/history`;
  }

  route(r: RecordedRequest, path: string): Reply {
    if (path === '/graphql' && r.method === 'POST') return this.graphql(r);
    if (path.endsWith('/billing/history') && r.method === 'GET') {
      const per = Math.max(1, Math.min(Number(r.query.get('per_page')) || this.historyPageSize, this.historyPageSize));
      const page = Math.max(1, Number(r.query.get('page')) || 1);
      // The account-level history documents no order or type filter: answer oldest first, so nothing may rely on it.
      const items = [...this.charges].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
      const slice = items.slice((page - 1) * per, page * per);
      return { status: 200, body: { success: true, errors: [], messages: [], result: slice, result_info: { page, per_page: per, count: slice.length, total_count: items.length } } };
    }
    return { status: 404, body: { success: false, errors: [{ code: 7000, message: 'No route for that URI' }], messages: [], result: null } };
  }

  private graphql(r: RecordedRequest): Reply {
    const b = json(r) as { query?: string; variables?: Record<string, string> };
    const q = String(b.query ?? '');
    const v = b.variables ?? {};
    if (!q.includes('viewer')) return { status: 200, body: { data: null, errors: [{ message: 'the query must select viewer' }] } };
    const fields = [...q.matchAll(/(\w+)\s*:\s*(\w+)\s*\(([^)]*)\)/g)]
      .map((m) => ({ alias: m[1]!, dataset: m[2]!, from: /date_geq:\s*\$(\w+)/.exec(m[3]!)?.[1], to: /date_lt:\s*\$(\w+)/.exec(m[3]!)?.[1] }))
      .filter((f) => f.dataset !== 'accounts');
    const unknown = fields.find((f) => !(DATASETS as readonly string[]).includes(f.dataset) || this.unknownDatasets.has(f.dataset));
    if (unknown) return { status: 200, body: { data: null, errors: [{ message: `unknown field "${unknown.dataset}"`, path: ['viewer', 'accounts', unknown.alias] }] } };
    const isDay = (d: string | undefined): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);
    for (const f of fields) {
      const from = f.from ? v[f.from] : undefined;
      const to = f.to ? v[f.to] : undefined;
      if (!isDay(from) || !isDay(to)) return { status: 200, body: { data: null, errors: [{ message: 'date_geq and date_lt are required', path: ['viewer', 'accounts', f.alias] }] } };
      if (Date.parse(to) - Date.parse(from) > 31 * DAY) return { status: 200, body: { data: null, errors: [{ message: 'the time range is wider than 31 days', path: ['viewer', 'accounts', f.alias] }] } };
    }
    if (v.accountTag !== this.accountId()) return { status: 200, body: { data: { viewer: { accounts: [] } }, errors: null } };
    const account: Record<string, Row[]> = {};
    for (const f of fields) account[f.alias] = this.data.get(f.dataset as Dataset)!.filter((row) => row.dimensions.date! >= v[f.from!]! && row.dimensions.date! < v[f.to!]!);
    return { status: 200, body: { data: { viewer: { accounts: [account] } }, errors: null } };
  }
}
