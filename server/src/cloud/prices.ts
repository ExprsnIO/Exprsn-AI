import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { json } from '../db/knex.js';
import { servicePolicy } from '../platform/egress.js';
import { signV4 } from '../platform/blob.js';
import type { Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import type { DesiredResource, Plan, PlanEstimate } from './graph.js';
import { CloudTransport, type TransportOptions } from './providers/transport.js';
import { CloudProviderError } from './providers/types.js';
import sheetJson from './price-sheet.json' with { type: 'json' };
import { deploymentSpecSchema, HOURS_PER_MONTH, PROVIDER_SKUS, SIZE_PRESETS, specAssumptions, type DeployProvider, type DeploymentSpec } from './spec.js';
import type { CloudAccount, Provider } from './types.js';

/*
 * 1.9.99-final, Sprint 57 (B-10601): the price catalogue and the estimate every plan carries.
 *
 * Sources, each called only through `CloudTransport` (the egress guard and the rate limiter):
 * - AWS: the Price List Query API (`GetProducts`, SigV4 with the account's billing credential), for EC2, RDS for
 *   PostgreSQL and ElastiCache instance hours;
 * - Azure: the Retail Prices API (`prices.azure.com`, no credential), for virtual machine hours, in the account's
 *   currency;
 * - DigitalOcean: `/v2/sizes` (the account's token), for droplet and node sizes;
 * - the maintained price sheet (`price-sheet.json`, each entry with its source page and date) for what has no API
 *   (DigitalOcean databases, caches, load balancers and App Platform; Cloudflare; the AWS and Azure fees not queried),
 *   and as the fallback when an API cannot be reached.
 *
 * API prices are cached in `cloud_prices` (migration 150_cloud_prices) and refreshed daily by the job
 * `cloud.prices.refresh`; a lookup older than a day is fetched again on use, and a failed fetch falls back to the stale
 * row, then to the sheet. Without the table, estimates use the sheet only and say so.
 *
 * Currency (open decision 17): the account's billing currency, USD by default, with no conversion. A price in another
 * currency is listed but left out of the total, and the estimate says so.
 */

export const PRICE_SOURCES = ['aws-price-list', 'azure-retail-prices', 'digitalocean-sizes', 'price-sheet'] as const;
export type PriceSource = (typeof PRICE_SOURCES)[number];
export const PRICE_UNITS = ['hour', 'month', 'gb-month', 'gb'] as const;
export type PriceUnit = (typeof PRICE_UNITS)[number];

export const DEFAULT_CURRENCY = 'USD';
const DAY_MS = 24 * 60 * 60_000;
export const PRICE_TTL_MS = DAY_MS;

export interface Price {
  provider: Provider;
  /** The region it applies to, or `*` (the sheet's every-region list price). */
  region: string;
  /** `<service>:<provider sku>`: `ec2:m6i.xlarge`, `vm:Standard_D4s_v5`, `droplet:s-4vcpu-8gb`, `do-db:db-s-2vcpu-4gb`... */
  sku: string;
  unit: PriceUnit;
  price: number;
  currency: string;
  source: PriceSource;
  /** The API call or the sheet entry's page. */
  ref: string;
  /** The price's date: its effective date (AWS, Azure), the day it was fetched (DigitalOcean), or the sheet entry's date. */
  date: string;
  fetchedAt: number | null;
  /** A cached API price older than a day, used because a fresh fetch failed. */
  stale?: boolean;
}

/** One priced line of an estimate. */
export interface EstimateLine {
  /** The resource key, or `(egress)` and `(front door)` for the deployment's own lines. */
  key: string;
  type: string;
  sku: string;
  unit: PriceUnit;
  quantity: number;
  monthly: number | null;
  /** Why it is not in the total (no price, another currency). */
  note?: string;
}

export interface PlanPrice {
  sku: string;
  unit: PriceUnit;
  price: number;
  currency: string;
  source: PriceSource;
  ref: string;
  date: string;
  region: string;
  stale?: boolean;
}

export interface Assumptions {
  /** Hours a month every always-on resource runs (730 by default). */
  hours: number;
  /** Database storage, GB. */
  storageGb: number;
  /** Internet egress per month, GB. */
  egressGb: number;
  notes: string[];
}

export interface Estimate extends PlanEstimate {
  monthly: number;
  /** After the plan minus before it (an upgrade's delta; negative for a scale-down or destroy). */
  delta: number;
  before: number;
  currency: string;
  assumptions: Assumptions;
  prices: PlanPrice[];
  lines: EstimateLine[];
  /** Whether the price cache is installed (migration 150_cloud_prices); without it the prices are the sheet's. */
  cache: boolean;
  at: number;
}

interface SheetEntry {
  provider: Provider;
  region: string;
  sku: string;
  unit: PriceUnit;
  price: number;
  source: string;
  date: string;
  /** Not confirmed against the provider's page yet: never priced (Sprint 59's snapshot and copy prices list it, flagged). */
  unverified?: boolean;
}

const SHEET = sheetJson as { version: string; currency: string; prices: SheetEntry[] };
export const PRICE_SHEET_VERSION = SHEET.version;

/** The sheet's entries as prices. */
export function sheetPrices(): Price[] {
  return SHEET.prices.filter((e) => !e.unverified).map((e) => ({ provider: e.provider, region: e.region, sku: e.sku, unit: e.unit, price: e.price, currency: SHEET.currency, source: 'price-sheet', ref: e.source, date: e.date, fetchedAt: null }));
}

export function sheetPrice(provider: Provider, sku: string, unit: PriceUnit, region: string): Price | null {
  const all = sheetPrices().filter((p) => p.provider === provider && p.sku === sku && p.unit === unit);
  return all.find((p) => p.region === region) ?? all.find((p) => p.region === '*') ?? null;
}

/** The account's billing currency (open decision 17): USD unless the account names another. */
export function currencyFor(account: CloudAccount | null | undefined): string {
  const c = (account as (CloudAccount & { billingCurrency?: string }) | null | undefined)?.billingCurrency;
  return c && /^[A-Z]{3}$/.test(c) ? c : DEFAULT_CURRENCY;
}

const round = (n: number) => Math.round(n * 100) / 100;
const day = (t: number | string) => new Date(t).toISOString().slice(0, 10);

// ---------- what a resource uses ----------

export interface Usage {
  key: string;
  type: string;
  sku: string;
  unit: PriceUnit;
  quantity: number;
  provider?: Provider;
}

/** Hours, or a month's share, for `count` of something billed per `unit` that runs `hours` a month. */
const per = (unit: PriceUnit, count: number, hours: number) => (unit === 'month' ? count * Math.min(1, hours / HOURS_PER_MONTH) : count * hours);

const nodeSku = (provider: DeployProvider, size: string) => (provider === 'aws' ? `ec2:${size}` : provider === 'azure' ? `vm:${size}` : `droplet:${size}`);
/** DigitalOcean bills droplets by the month (capped hourly), GPU droplets by the hour. */
const nodeUnit = (provider: DeployProvider, gpu: boolean): PriceUnit => (provider === 'digitalocean' && !gpu ? 'month' : 'hour');

/** What a desired resource uses per month, as the renderer (`cloud/render.ts`) shapes its spec. Free types (subnets, firewalls, records, tunnels) use nothing. */
export function usageOf(r: DesiredResource, provider: DeployProvider, a: Pick<Assumptions, 'hours' | 'storageGb'>): Usage[] {
  const s = r.spec as Record<string, unknown>;
  const hours = a.hours;
  const u = (sku: string, unit: PriceUnit, quantity: number): Usage => ({ key: r.key, type: r.type, sku, unit, quantity });
  const ha = s.ha === true;
  switch (r.type) {
    case 'network': {
      if (s.nat !== 'gateway') return [];
      return [u('nat:gateway', provider === 'digitalocean' ? 'month' : 'hour', per(provider === 'digitalocean' ? 'month' : 'hour', 1, hours))];
    }
    case 'kubernetes_cluster':
      if (provider === 'aws') return [u('eks:cluster', 'hour', hours)];
      if (provider === 'azure') return [u(ha ? 'aks:standard' : 'aks:free', 'hour', hours)];
      return [u(ha ? 'doks:ha' : 'doks:standard', 'month', per('month', 1, hours))];
    case 'node_group':
    case 'vm': {
      const size = String(s.size ?? '');
      if (!size) return [];
      const gpu = !!s.gpu;
      const unit = nodeUnit(provider, gpu);
      if (r.type === 'vm') return [u(nodeSku(provider, size), unit, per(unit, 1, s.scaleToZero ? Number(s.busyHours ?? 0) : hours))];
      if (gpu) {
        const min = Number(s.min ?? 0);
        const max = Number(s.max ?? min);
        const busy = max > min ? Number(s.busyHours ?? 0) : 0;
        return [u(nodeSku(provider, size), unit, per(unit, min, hours) + per(unit, 1, busy))];
      }
      return [u(nodeSku(provider, size), unit, per(unit, Number(s.count ?? 1), hours))];
    }
    case 'container_service': {
      const replicas = Number(s.replicas ?? 1);
      const vcpu = Number(s.vcpu ?? 1);
      const mem = Number(s.memoryGb ?? 2);
      if (provider === 'aws') return [u('fargate:vcpu', 'hour', replicas * vcpu * hours), u('fargate:gb', 'hour', replicas * mem * hours)];
      if (provider === 'azure') return [u('containerapps:vcpu', 'hour', replicas * vcpu * hours), u('containerapps:gb', 'hour', replicas * mem * hours)];
      return [u(`apps:${vcpu}vcpu-${mem}gb`, 'month', per('month', replicas, hours))];
    }
    case 'database': {
      const size = String(s.size ?? '');
      const nodes = ha ? 2 : 1;
      const storage = Number(s.storageGb ?? a.storageGb);
      // Sprint 59 (B-10303): Aurora and Azure MySQL have their own SKUs (the sheet prices what it has confirmed).
      if (provider === 'aws' && s.service === 'aurora') return [u(`aurora:${size}`, 'hour', nodes * hours), u('aurora:storage', 'gb-month', storage)];
      if (provider === 'aws') return [u(`rds:${size}`, 'hour', nodes * hours), u('rds:storage-gp3', 'gb-month', nodes * storage)];
      if (provider === 'azure' && s.engine === 'mysql') return [u(`mysql:${size}`, 'hour', nodes * hours), u('mysql:storage', 'gb-month', nodes * storage)];
      if (provider === 'azure') return [u(`postgres:${size}`, 'hour', nodes * hours), u('postgres:storage', 'gb-month', nodes * storage)];
      return [u(`do-db:${size}`, 'month', per('month', nodes, hours))];
    }
    case 'cache': {
      const size = String(s.size ?? '');
      const nodes = ha && provider !== 'azure' ? 2 : 1; // Azure's Standard and Premium tiers include the replica
      if (provider === 'aws') return [u(`elasticache:${size}`, 'hour', nodes * hours)];
      if (provider === 'azure') return [u(`redis:${size}`, 'hour', hours)];
      return [u(`do-cache:${size}`, 'month', per('month', nodes, hours))];
    }
    case 'load_balancer':
      if (provider === 'aws') return [u('elb:alb', 'hour', hours)];
      if (provider === 'azure') return [u('lb:standard', 'hour', hours)];
      return [u('do-lb:small', 'month', per('month', 1, hours))];
    case 'bucket': {
      const gb = Number(s.sizeGb ?? 0);
      if (!gb) return [];
      return [u(provider === 'aws' ? 's3:standard' : provider === 'azure' ? 'blob:hot-lrs' : 'spaces:storage', 'gb-month', gb)];
    }
    default:
      return [];
  }
}

/** The deployment's own lines: internet egress (and NAT processing), and a Cloudflare front door's plan. */
export function deploymentUsage(provider: DeployProvider, resources: DesiredResource[], a: Assumptions, spec: DeploymentSpec | null): Usage[] {
  if (!resources.length) return [];
  const out: Usage[] = [];
  if (a.egressGb > 0) {
    out.push({ key: '(egress)', type: 'egress', sku: 'egress:internet', unit: 'gb', quantity: a.egressGb });
    if (provider !== 'digitalocean' && resources.some((r) => r.type === 'network' && r.spec.nat === 'gateway')) out.push({ key: '(egress)', type: 'nat', sku: 'nat:processed', unit: 'gb', quantity: a.egressGb });
  }
  if (spec?.frontDoor.kind === 'cloudflare') out.push({ key: '(front door)', type: 'front_door', sku: `cf:zone-${spec.frontDoor.plan}`, unit: 'month', quantity: 1, provider: 'cloudflare' });
  return out;
}

// ---------- the API sources ----------

export interface PriceEndpoints {
  /** AWS Price List Query API (default `https://api.pricing.us-east-1.amazonaws.com`). */
  awsPricing?: string;
  /** Azure Retail Prices API (default `https://prices.azure.com/api/retail/prices`). */
  azureRetail?: string;
  /** DigitalOcean API origin (default `https://api.digitalocean.com`). */
  digitalocean?: string;
}

/** Which source serves a SKU, or null for the sheet only. */
export function apiSourceOf(provider: Provider, sku: string): PriceSource | null {
  if (provider === 'aws' && /^(ec2|rds|elasticache):/.test(sku) && !sku.startsWith('rds:storage')) return 'aws-price-list';
  if (provider === 'azure' && sku.startsWith('vm:')) return 'azure-retail-prices';
  if (provider === 'digitalocean' && sku.startsWith('droplet:')) return 'digitalocean-sizes';
  return null;
}

interface AwsKeys {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

const sha256 = (b: string) => createHash('sha256').update(b).digest('hex');

/** The AWS Price List filters for a SKU (on-demand, Linux, shared tenancy; PostgreSQL single-AZ; Redis). */
function awsQuery(sku: string, region: string): { ServiceCode: string; Filters: { Type: 'TERM_MATCH'; Field: string; Value: string }[] } | null {
  const [svc, type] = [sku.slice(0, sku.indexOf(':')), sku.slice(sku.indexOf(':') + 1)];
  const f = (Field: string, Value: string) => ({ Type: 'TERM_MATCH' as const, Field, Value });
  if (svc === 'ec2') return { ServiceCode: 'AmazonEC2', Filters: [f('instanceType', type), f('regionCode', region), f('operatingSystem', 'Linux'), f('tenancy', 'Shared'), f('preInstalledSw', 'NA'), f('capacitystatus', 'Used')] };
  if (svc === 'rds') return { ServiceCode: 'AmazonRDS', Filters: [f('instanceType', type), f('regionCode', region), f('databaseEngine', 'PostgreSQL'), f('deploymentOption', 'Single-AZ')] };
  if (svc === 'elasticache') return { ServiceCode: 'AmazonElastiCache', Filters: [f('instanceType', type), f('regionCode', region), f('cacheEngine', 'Redis')] };
  return null;
}

/** The on-demand price per hour in a Price List product, with its effective date. */
function awsOnDemand(item: string | Record<string, unknown>): { price: number; currency: string; date: string } | null {
  const p = typeof item === 'string' ? (JSON.parse(item) as Record<string, unknown>) : item;
  const terms = (p.terms as { OnDemand?: Record<string, { effectiveDate?: string; priceDimensions?: Record<string, { unit?: string; pricePerUnit?: Record<string, string> }> }> } | undefined)?.OnDemand ?? {};
  for (const term of Object.values(terms)) {
    for (const dim of Object.values(term.priceDimensions ?? {})) {
      if (dim.unit && !/^hrs?$/i.test(dim.unit)) continue;
      const [currency, value] = Object.entries(dim.pricePerUnit ?? {})[0] ?? [];
      const price = Number(value);
      if (currency && Number.isFinite(price) && price > 0) return { price, currency, date: (term.effectiveDate ?? String(p.publicationDate ?? new Date().toISOString())).slice(0, 10) };
    }
  }
  return null;
}

// ---------- the catalogue ----------

export interface PriceOptions {
  endpoints?: PriceEndpoints;
  /** Transport settings (tests: a fast `sleep`). */
  transport?: Omit<TransportOptions, 'provider' | 'policy' | 'counters'>;
  now?: () => number;
}

export interface PriceContext {
  account: CloudAccount | null;
  currency: string;
  /** False: cache and sheet only (no API call). */
  fetch?: boolean;
}

export class CloudPrices {
  private schema: { ok: boolean; at: number } | null = null;
  private transports = new Map<Provider, CloudTransport>();
  private endpoints: PriceEndpoints;
  private readonly now: () => number;
  /** Calls made, per source (for the tests and the job's report). */
  readonly calls: Record<Exclude<PriceSource, 'price-sheet'>, number> = { 'aws-price-list': 0, 'azure-retail-prices': 0, 'digitalocean-sizes': 0 };

  constructor(
    private readonly s: () => Services,
    private readonly o: PriceOptions = {}
  ) {
    this.endpoints = { ...(o.endpoints ?? {}) };
    this.now = o.now ?? Date.now;
  }

  setEndpoints(e: PriceEndpoints): void {
    this.endpoints = { ...this.endpoints, ...e };
  }

  async installed(): Promise<boolean> {
    const t = this.now();
    if (this.schema && (this.schema.ok || t - this.schema.at < 30_000)) return this.schema.ok;
    let ok: boolean;
    try {
      ok = await this.s().db.schema.hasTable('cloud_prices');
    } catch {
      ok = false;
    }
    this.schema = { ok, at: t };
    return ok;
  }

  resetSchemaCache(): void {
    this.schema = null;
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

  private async cred(account: CloudAccount, purpose: 'billing' | 'read'): Promise<unknown> {
    const c = this.s().cloud.credentials;
    if (!c) throw new CloudProviderError('Cloud credentials are not available in this build.', account.provider, 503, 'cloud_component_missing');
    return c.for(account, purpose);
  }

  // ---------- fetchers (one SKU, or every DigitalOcean size) ----------

  private async fetchAws(account: CloudAccount, sku: string, region: string): Promise<Price | null> {
    const q = awsQuery(sku, region);
    if (!q) return null;
    const keys = (await this.cred(account, 'billing')) as AwsKeys & { kind?: string };
    if (!keys?.accessKeyId) throw new CloudProviderError(`${account.name}'s credential is not an AWS key.`, 'aws', 400, 'wrong_credential');
    const url = new URL('/', this.endpoints.awsPricing ?? 'https://api.pricing.us-east-1.amazonaws.com');
    const body = JSON.stringify({ ...q, FormatVersion: 'aws_v1', MaxResults: 10 });
    const headers: Record<string, string> = { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSPriceListService.GetProducts', ...(keys.sessionToken ? { 'x-amz-security-token': keys.sessionToken } : {}) };
    const signed = signV4({ method: 'POST', url, headers, payloadHash: sha256(body), region: 'us-east-1', service: 'pricing', accessKeyId: keys.accessKeyId, secretAccessKey: keys.secretAccessKey, date: new Date(this.now()) });
    this.calls['aws-price-list'] += 1;
    const res = await this.transport('aws').json<{ PriceList?: (string | Record<string, unknown>)[] }>({ method: 'POST', url, headers: signed, body, accountId: account.id }, (status, b) => ({ message: `The AWS Price List API answered ${status}${typeof b === 'object' && b && 'message' in b ? `: ${String((b as { message: unknown }).message).slice(0, 200)}` : ''}.`, code: typeof b === 'object' && b && '__type' in b ? String((b as { __type: unknown }).__type) : null }));
    const found = (res.body.PriceList ?? []).map(awsOnDemand).filter((x) => !!x).sort((a, b) => a.price - b.price)[0];
    if (!found) return null;
    return { provider: 'aws', region, sku, unit: 'hour', price: found.price, currency: found.currency, source: 'aws-price-list', ref: `pricing:GetProducts ${q.ServiceCode} ${sku.split(':')[1]}`, date: found.date, fetchedAt: this.now() };
  }

  private async fetchAzure(accountId: string, sku: string, region: string, currency: string): Promise<Price | null> {
    const arm = sku.slice(sku.indexOf(':') + 1);
    const filter = `serviceName eq 'Virtual Machines' and armRegionName eq '${region.replace(/'/g, '')}' and armSkuName eq '${arm.replace(/'/g, '')}' and priceType eq 'Consumption'`;
    const url = new URL(this.endpoints.azureRetail ?? 'https://prices.azure.com/api/retail/prices');
    url.searchParams.set('currencyCode', currency);
    url.searchParams.set('$filter', filter);
    this.calls['azure-retail-prices'] += 1;
    const res = await this.transport('azure').json<{ Items?: { currencyCode?: string; retailPrice?: number; unitOfMeasure?: string; productName?: string; skuName?: string; meterName?: string; effectiveStartDate?: string; type?: string }[] }>({ method: 'GET', url, accountId: accountId || 'azure-retail-prices' }, (status) => ({ message: `The Azure Retail Prices API answered ${status}.`, code: null }));
    const items = (res.body.Items ?? []).filter((i) => (i.type ?? 'Consumption') === 'Consumption' && /hour/i.test(i.unitOfMeasure ?? '') && !/windows/i.test(i.productName ?? '') && !/spot|low priority/i.test(`${i.skuName ?? ''} ${i.meterName ?? ''}`) && typeof i.retailPrice === 'number' && i.retailPrice > 0);
    const best = items.sort((a, b) => a.retailPrice! - b.retailPrice!)[0];
    if (!best) return null;
    return { provider: 'azure', region, sku, unit: 'hour', price: best.retailPrice!, currency: best.currencyCode ?? currency, source: 'azure-retail-prices', ref: `prices.azure.com Virtual Machines ${arm}`, date: (best.effectiveStartDate ?? new Date(this.now()).toISOString()).slice(0, 10), fetchedAt: this.now() };
  }

  /** Every DigitalOcean size (one paged call), monthly and hourly. */
  private async fetchDoSizes(account: CloudAccount): Promise<Price[]> {
    const cred = (await this.cred(account, 'read')) as { token?: string };
    if (!cred?.token) throw new CloudProviderError(`${account.name}'s credential is not a DigitalOcean token.`, 'digitalocean', 400, 'wrong_credential');
    const out: Price[] = [];
    let next: string | null = new URL('/v2/sizes?per_page=200', this.endpoints.digitalocean ?? 'https://api.digitalocean.com').toString();
    const today = day(this.now());
    for (let page = 0; next && page < 10; page++) {
      this.calls['digitalocean-sizes'] += 1;
      const res: { body: { sizes?: { slug: string; price_monthly?: number; price_hourly?: number; available?: boolean }[]; links?: { pages?: { next?: string } } } } = await this.transport('digitalocean').json({ method: 'GET', url: next, headers: { authorization: `Bearer ${cred.token}` }, accountId: account.id }, (status, b) => ({ message: `DigitalOcean answered ${status}${typeof b === 'object' && b && 'message' in b ? `: ${String((b as { message: unknown }).message).slice(0, 200)}` : ''}.`, code: typeof b === 'object' && b && 'id' in b ? String((b as { id: unknown }).id) : null }));
      for (const z of res.body.sizes ?? []) {
        const base = { provider: 'digitalocean' as const, region: '*', sku: `droplet:${z.slug}`, currency: 'USD', source: 'digitalocean-sizes' as const, ref: `/v2/sizes ${z.slug}`, date: today, fetchedAt: this.now() };
        if (typeof z.price_monthly === 'number') out.push({ ...base, unit: 'month', price: z.price_monthly });
        if (typeof z.price_hourly === 'number') out.push({ ...base, unit: 'hour', price: z.price_hourly });
      }
      const n = res.body.links?.pages?.next;
      // Follow only the API's own origin (the egress guard checks the address too).
      next = n && new URL(n).origin === new URL(this.endpoints.digitalocean ?? 'https://api.digitalocean.com').origin ? n : null;
    }
    return out;
  }

  // ---------- the cache ----------

  private async cached(provider: Provider, region: string, sku: string, unit: PriceUnit, currency: string): Promise<Price | null> {
    const r = (await this.s().db('cloud_prices').where({ provider, sku, unit, currency }).whereIn('region', [region, '*']).orderBy('fetched_at', 'desc').first()) as Record<string, unknown> | undefined;
    if (!r) return null;
    return { provider, region: String(r.region), sku, unit, price: Number(r.price), currency: String(r.currency), source: r.source as PriceSource, ref: String(r.source_ref ?? ''), date: String(r.price_date), fetchedAt: Number(r.fetched_at) };
  }

  private async store(prices: Price[]): Promise<void> {
    const db = this.s().db;
    for (const p of prices) {
      const key = { provider: p.provider, region: p.region, sku: p.sku, unit: p.unit, currency: p.currency };
      const row = { price: String(p.price), source: p.source, source_ref: p.ref.slice(0, 300), price_date: p.date, fetched_at: p.fetchedAt ?? this.now() };
      const n = await db('cloud_prices').where(key).update(row);
      if (!n) await db('cloud_prices').insert({ id: ulid(), ...key, ...row });
    }
  }

  /**
   * One price: a fresh cached API price, else the API (cached), else a stale cached price, else the sheet. Without the
   * cache table, the sheet only. Null when nothing prices it.
   */
  async lookup(provider: Provider, region: string, sku: string, unit: PriceUnit, ctx: PriceContext): Promise<Price | null> {
    const api = apiSourceOf(provider, sku);
    const installed = await this.installed();
    if (!api || !installed) return sheetPrice(provider, sku, unit, region);
    const hit = await this.cached(provider, region, sku, unit, ctx.currency).catch(() => null);
    if (hit && this.now() - (hit.fetchedAt ?? 0) < PRICE_TTL_MS) return hit;
    if (ctx.fetch !== false && (ctx.account || api === 'azure-retail-prices')) {
      try {
        const got = await this.fetchOne(provider, region, sku, ctx);
        if (got.length) await this.store(got);
        const fresh = got.find((p) => p.sku === sku && p.unit === unit && (p.region === region || p.region === '*'));
        if (fresh) return fresh;
      } catch (err) {
        this.s().log.warn({ provider, sku, err: (err as Error).message }, 'cloud price fetch failed; using the cache or the price sheet');
      }
    }
    if (hit) return { ...hit, stale: true };
    return sheetPrice(provider, sku, unit, region);
  }

  private async fetchOne(provider: Provider, region: string, sku: string, ctx: PriceContext): Promise<Price[]> {
    if (provider === 'aws') {
      const p = await this.fetchAws(ctx.account!, sku, region);
      return p ? [p] : [];
    }
    if (provider === 'azure') {
      const p = await this.fetchAzure(ctx.account?.id ?? '', sku, region, ctx.currency);
      return p ? [p] : [];
    }
    if (provider === 'digitalocean') return this.fetchDoSizes(ctx.account!);
    return [];
  }

  /**
   * The daily refresh (`cloud.prices.refresh`): every active platform account's preset SKUs in each of its regions,
   * from its provider's API, into the cache. Failures are counted, never thrown; the sheet still answers.
   */
  async refresh(): Promise<{ skipped?: string; fetched: number; failed: number; accounts: number }> {
    if (!(await this.installed())) return { skipped: 'not installed (migration 150_cloud_prices)', fetched: 0, failed: 0, accounts: 0 };
    // Only accounts something is deployed on: nothing calls a price API until someone creates a deployment.
    const deployed = new Set(((await this.s().db('cloud_deployments').whereNot({ state: 'destroyed' }).distinct('account_id').catch(() => [])) as { account_id: string }[]).map((r) => r.account_id));
    const accounts = (await this.s().cloud.accounts.list(null, { scope: 'platform' }).catch(() => [])).filter((a) => (a.state === 'active' || a.state === 'attention') && a.provider !== 'cloudflare' && deployed.has(a.id));
    let fetched = 0;
    let failed = 0;
    for (const a of accounts) {
      const currency = currencyFor(a);
      const provider = a.provider as DeployProvider;
      try {
        if (provider === 'digitalocean') {
          const all = await this.fetchDoSizes(a);
          await this.store(all);
          fetched += all.length;
          continue;
        }
        for (const r of a.regions) {
          for (const sku of presetSkus(provider)) {
            if (!apiSourceOf(provider, sku)) continue;
            try {
              const p = provider === 'aws' ? await this.fetchAws(a, sku, r.region) : await this.fetchAzure(a.id, sku, r.region, currency);
              if (p) {
                await this.store([p]);
                fetched += 1;
              }
            } catch {
              failed += 1;
            }
          }
        }
      } catch {
        failed += 1;
      }
    }
    return { fetched, failed, accounts: accounts.length };
  }

  registerJobs(): void {
    this.s().jobs.register('cloud.prices.refresh', async (_p, ctx) => {
      const out = await this.refresh();
      await ctx.progress(100, out.skipped ?? `${out.fetched} prices fetched, ${out.failed} failed, ${out.accounts} accounts`);
      return out;
    });
  }

  /** Daily, as the platform tenant. */
  schedule(scheduler: Scheduler): void {
    scheduler.every('cloud.prices.refresh', DAY_MS, async () => {
      const t = await this.s().tenants.bySlug(this.s().cfg.DEFAULT_TENANT);
      return t ? [{ tenantId: t.id, payload: {} }] : [];
    });
  }

  // ---------- estimates ----------

  /** Prices a set of resources: their lines and the prices used. */
  async price(provider: DeployProvider, region: string, resources: DesiredResource[], a: Assumptions, spec: DeploymentSpec | null, ctx: PriceContext): Promise<{ monthly: number; lines: EstimateLine[]; prices: PlanPrice[] }> {
    const usages = [...resources.flatMap((r) => usageOf(r, provider, a).map((u) => ({ ...u, region: r.region ?? region }))), ...deploymentUsage(provider, resources, a, spec).map((u) => ({ ...u, region }))];
    const lines: EstimateLine[] = [];
    const prices = new Map<string, PlanPrice>();
    let monthly = 0;
    for (const u of usages) {
      const prov = u.provider ?? provider;
      const p = await this.lookup(prov, prov === 'cloudflare' ? 'global' : u.region, u.sku, u.unit, prov === provider ? ctx : { ...ctx, account: null });
      if (!p) {
        lines.push({ key: u.key, type: u.type, sku: u.sku, unit: u.unit, quantity: u.quantity, monthly: null, note: 'No price for this SKU in the catalogue or the price sheet.' });
        continue;
      }
      prices.set(`${p.sku}|${p.unit}|${p.region}`, { sku: p.sku, unit: p.unit, price: p.price, currency: p.currency, source: p.source, ref: p.ref, date: p.date, region: p.region, ...(p.stale ? { stale: true } : {}) });
      if (p.currency !== ctx.currency) {
        lines.push({ key: u.key, type: u.type, sku: u.sku, unit: u.unit, quantity: u.quantity, monthly: null, note: `Priced in ${p.currency}, not ${ctx.currency}; not converted, so not in the total.` });
        continue;
      }
      const m = p.price * u.quantity;
      monthly += m;
      lines.push({ key: u.key, type: u.type, sku: u.sku, unit: u.unit, quantity: round(u.quantity * 1000) / 1000, monthly: round(m) });
    }
    return { monthly, lines, prices: [...prices.values()] };
  }

  /**
   * The estimate of a change from `before` to `after` (B-10601): the monthly cost after it, the delta, the assumptions
   * and every price used with its source and date.
   */
  async estimate(input: { provider: DeployProvider; region: string; account: CloudAccount | null; before: DesiredResource[]; after: DesiredResource[]; spec: DeploymentSpec | null; /** The spec `before` was rendered from (an upgrade's old spec); default `spec`. */ beforeSpec?: DeploymentSpec | null; assumptions?: Partial<Assumptions>; /** False: cached and sheet prices only, no API call (the wizard's dry run). */ fetch?: boolean }): Promise<Estimate> {
    const currency = currencyFor(input.account);
    const base = input.spec ? specAssumptions(input.spec) : { hours: HOURS_PER_MONTH, storageGb: 0, egressGb: 0 };
    const a: Assumptions = { ...base, ...input.assumptions, notes: [...(input.assumptions?.notes ?? [])] };
    const cache = await this.installed();
    const ctx: PriceContext = { account: input.account, currency, ...(input.fetch === false ? { fetch: false } : {}) };
    const after = await this.price(input.provider, input.region, input.after, a, input.spec, ctx);
    const beforeSpec = input.beforeSpec === undefined ? input.spec : input.beforeSpec;
    const b: Assumptions = beforeSpec && beforeSpec !== input.spec ? { ...a, ...specAssumptions(beforeSpec), ...input.assumptions, notes: [] } : a;
    const before = await this.price(input.provider, input.region, input.before, b, beforeSpec, ctx);
    a.notes.push(`${a.hours} hours a month for always-on resources; month-priced resources are prorated to that.`);
    if (input.after.some((r) => r.type === 'node_group' && r.spec.gpu) || input.after.some((r) => r.type === 'vm' && r.spec.scaleToZero)) a.notes.push('GPU pools: nodes at their minimum run all month; one node above the minimum is assumed busy for the pool\'s busyHours.');
    if (input.after.some((r) => r.type === 'database' && r.spec.ha)) a.notes.push('A highly available database or cache is priced as two nodes.');
    if (input.after.some((r) => ['subnet', 'firewall', 'dns_record', 'tunnel'].includes(r.type))) a.notes.push('Subnets, firewalls, DNS records and tunnels are not priced (no charge, or included in the zone or plan).');
    if (!cache) a.notes.push('The price cache is not installed (migration 150_cloud_prices): every price is from the price sheet.');
    if ([...after.prices, ...before.prices].some((p) => p.stale)) a.notes.push('Some API prices are older than a day: the refresh failed and the last fetched price is used.');
    if (currency === DEFAULT_CURRENCY && !(input.account as { billingCurrency?: string } | null)?.billingCurrency) a.notes.push('Currency: USD, the default billing currency (open decision 17); nothing is converted.');
    const seen = new Map<string, PlanPrice>();
    for (const p of [...after.prices, ...before.prices]) seen.set(`${p.sku}|${p.unit}|${p.region}`, p);
    return {
      monthly: round(after.monthly),
      before: round(before.monthly),
      delta: round(after.monthly - before.monthly),
      currency,
      assumptions: a,
      prices: [...seen.values()].sort((x, y) => x.sku.localeCompare(y.sku)),
      lines: after.lines,
      cache,
      at: this.now()
    };
  }

  /**
   * The planner's hook (`s.cloud.estimatePlan`, `EstimatePlanFn` in `graph.ts`): the plan's desired graph against what
   * the deployment has now. Reads the deployment and its graph (migration 148); null when they cannot be read.
   */
  estimatePlan = async (plan: Plan): Promise<Estimate | null> => {
    const db = this.s().db;
    const d = (await db('cloud_deployments').where({ id: plan.deploymentId }).first().catch(() => null)) as Record<string, unknown> | null | undefined;
    if (!d) return null;
    const provider = d.provider as Provider;
    if (provider !== 'aws' && provider !== 'azure' && provider !== 'digitalocean') return null;
    const parsed = deploymentSpecSchema.safeParse(json(d.spec, null));
    const spec = parsed.success ? parsed.data : null;
    const account = await this.s().cloud.accounts.get(String(d.account_id)).catch(() => null);
    const deleted = new Set(plan.steps.filter((x) => x.action === 'delete').map((x) => x.key));
    const after = plan.purpose === 'destroy' ? [] : plan.desired.filter((r) => !deleted.has(r.key));
    const rows = (await db('cloud_resources').where({ deployment_id: plan.deploymentId }).whereNotIn('state', ['deleted', 'missing', 'planned']).catch(() => [])) as Record<string, unknown>[];
    const before = rows.map((r) => json<DesiredResource | null>(r.desired, null)).filter((r): r is DesiredResource => !!r);
    return this.estimate({ provider, region: String(d.region), account, before, after, spec, ...(spec ? {} : { assumptions: { storageGb: 0, egressGb: 0, notes: ['The deployment has no spec: no egress or front door is estimated.'] } }) });
  };
}

/** Every SKU a provider's presets use (what the daily refresh fetches). */
export function presetSkus(provider: DeployProvider): string[] {
  const k = PROVIDER_SKUS[provider];
  const node = (size: string) => nodeSku(provider, size);
  const db = (size: string) => (provider === 'aws' ? `rds:${size}` : provider === 'azure' ? `postgres:${size}` : `do-db:${size}`);
  const cache = (size: string) => (provider === 'aws' ? `elasticache:${size}` : provider === 'azure' ? `redis:${size}` : `do-cache:${size}`);
  const sizes = Object.keys(SIZE_PRESETS) as (keyof typeof SIZE_PRESETS)[];
  return [...new Set([...sizes.map((z) => node(k.app[z])), ...sizes.map((z) => db(k.database[z])), ...sizes.map((z) => cache(k.cache[z])), ...Object.values(k.gpu).flatMap((g) => (g ? [node(g.sku)] : []))])];
}
