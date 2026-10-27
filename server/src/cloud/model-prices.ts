import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom, isUniqueViolation } from '../audit/chain.js';
import type { Principal } from '../authz/policy.js';
import type { InstanceRow } from '../gateway/repo.js';
import { HttpProblem, notFound } from '../http/problem.js';
import { signV4 } from '../platform/blob.js';
import { servicePolicy } from '../platform/egress.js';
import type { Services } from '../services.js';
import type { UsageInput, UsagePrice } from '../tenancy/quotas.js';
import type { CloudModelEntry } from './model-import.js';
import { PRICE_SHEET_VERSION } from './prices.js';
import sheetJson from './price-sheet.json' with { type: 'json' };
import { CloudTransport, type TransportOptions } from './providers/transport.js';
import { CloudProviderError } from './providers/types.js';
import type { CloudAccount, Provider } from './types.js';

/*
 * 1.9.99-final, Sprint 61 (B-10505): per-model prices of the cloud model APIs and the one pricer of every cloud model
 * turn (`s.cloud.modelPrices`, installed as `s.quotas.pricer`).
 *
 * A price is a version: provider, region (`*`: every region), the model as the provider prices it, currency, basis
 * (`tokens`: per million input, output and cached input tokens, an embedding model's tokens as input; `neurons`:
 * Workers AI's neurons per million input and output tokens and the price per 1,000 neurons) and the day it takes
 * effect. The version that prices a record is the latest whose effective day is on or before the record's day, so a
 * new price applies from its effective date only and earlier records keep theirs.
 *
 * Sources:
 *   AWS Price List API    `GetProducts` for `AmazonBedrock` and `AmazonBedrockFoundationModels` (SigV4, the
 *                         account's billing credential), the model's input, output and cache-read token prices in a
 *                         region, through the cloud transport;
 *   Azure Retail Prices   `prices.azure.com` (no credential), the Azure OpenAI meters (`Foundry Models`) of a region
 *                         for the deployment's model, version and deployment type (regional, data zone, global);
 *   the price sheet       `price-sheet.json`: `models.entries` (DigitalOcean GenAI has no price API; Bedrock and Azure
 *                         as a fallback) and `workersAi` (neurons); an entry marked `unverified` is shown, never used
 *                         to price a record;
 *   by hand               `PUT /api/admin/cloud/model-prices` (FinOps), a version with its effective day.
 * API and hand-made versions are kept in `cloud_model_prices` (migration 163, not registered yet); without the table
 * the sheet answers alone and nothing is fetched.
 *
 * Metering: a record whose pool holds a cloud instance (`kind: bedrock`, or `kind: openai` with a flavour) is priced
 * from its tokens (prompt tokens a provider served from its cache at the cached rate, once migration 163 adds
 * `usage_records.cached_tokens`; cache writes at the input rate) into `cost_micros`, `currency` and `price_id`
 * (migration 160); a Workers AI record also gets its `neurons`. Every other record is untouched, exactly as before.
 */

export const MODEL_PRICE_SOURCES = ['aws-price-list', 'azure-retail-prices', 'price-sheet', 'manual'] as const;
export type ModelPriceSource = (typeof MODEL_PRICE_SOURCES)[number];
export type ModelPriceBasis = 'tokens' | 'neurons';

export interface ModelPrice {
  /** The `cloud_model_prices` row, or null for a sheet entry. */
  id: string | null;
  provider: Provider;
  region: string;
  model: string;
  currency: string;
  basis: ModelPriceBasis;
  /** Per million tokens, in `currency`. */
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  cachedPerMillion: number | null;
  /** Workers AI: neurons per million input and output tokens, and the price per 1,000 neurons. */
  neuronsInput: number | null;
  neuronsOutput: number | null;
  neuronPrice: number | null;
  /** `YYYY-MM-DD`: the version prices records from this day on. */
  effectiveFrom: string;
  source: ModelPriceSource;
  ref: string | null;
  /** A sheet entry not confirmed against its source page: shown, never used to price a record. */
  unverified: boolean;
  /** What a priced usage record's `price_id` carries. */
  priceId: string;
}

interface SheetModel {
  provider: Provider;
  region: string;
  model: string;
  kind?: string;
  input: number;
  output: number;
  cached?: number;
  effective: string;
  source: string;
  unverified?: boolean;
}

interface NeuronSheet {
  neuronPrice: { price: number; source: string; date: string };
  models: Record<string, { input: number; output: number }>;
}

const SHEET = sheetJson as unknown as { version: string; currency: string; workersAi?: NeuronSheet; models?: { entries: SheetModel[] } };

/** Workers AI's neurons for a call: the model's neurons per million input and output tokens, from the price sheet. */
export function workersAiNeurons(model: string, promptTokens: number, outputTokens: number): number | null {
  const rate = SHEET.workersAi?.models[model];
  if (!rate) return null;
  return Math.round((promptTokens * rate.input + outputTokens * rate.output) / 1_000_000);
}

/** What neurons cost, in micro-units of the sheet's currency (USD 0.011 per 1,000 neurons is 11 micro-dollars each). */
export function neuronCostMicros(neurons: number): number | null {
  const p = SHEET.workersAi?.neuronPrice;
  if (!p) return null;
  return Math.round(neurons * (p.price / 1000) * 1_000_000);
}

/** The price id of the sheet's neuron price (Sprint 60's records carry it). */
export const NEURON_PRICE_ID = `workers-ai:neurons@${PRICE_SHEET_VERSION}`;

export const DAY = (t: number): string => new Date(t).toISOString().slice(0, 10);

/** The provider of a cloud instance's flavour (`kind: bedrock` is AWS). */
export function providerOf(row: Pick<InstanceRow, 'kind' | 'settings'>): Provider | null {
  if (row.kind === 'bedrock') return 'aws';
  const f = row.settings.cloud?.flavour;
  return f === 'azure' ? 'azure' : f === 'digitalocean' ? 'digitalocean' : f === 'workers-ai' ? 'cloudflare' : null;
}

/** Whether an instance is a cloud model server (Bedrock, or a flavoured Chat Completions endpoint). */
export const isCloudInstance = (row: Pick<InstanceRow, 'kind' | 'settings'>): boolean => providerOf(row) !== null;

/** A Bedrock inference profile's model (`eu.anthropic...` → `anthropic...`): priced at the source region's price. */
export const bedrockBaseModel = (id: string): string => id.replace(/^(us|eu|apac|us-gov|global|ca|jp|au)\./, '');

/** The sheet's model entries as prices (unverified ones included, flagged). */
export function sheetModelPrices(): ModelPrice[] {
  const out: ModelPrice[] = (SHEET.models?.entries ?? []).map((e) => ({
    id: null,
    provider: e.provider,
    region: e.region,
    model: e.model,
    currency: SHEET.currency,
    basis: 'tokens',
    inputPerMillion: e.input,
    outputPerMillion: e.output,
    cachedPerMillion: e.cached ?? null,
    neuronsInput: null,
    neuronsOutput: null,
    neuronPrice: null,
    effectiveFrom: e.effective,
    source: 'price-sheet',
    ref: e.source,
    unverified: e.unverified === true,
    priceId: `sheet:${e.provider}/${e.model}@${e.effective}`.slice(0, 100)
  }));
  const w = SHEET.workersAi;
  if (w) {
    for (const [model, rate] of Object.entries(w.models)) {
      out.push({ id: null, provider: 'cloudflare', region: '*', model, currency: SHEET.currency, basis: 'neurons', inputPerMillion: null, outputPerMillion: null, cachedPerMillion: null, neuronsInput: rate.input, neuronsOutput: rate.output, neuronPrice: w.neuronPrice.price, effectiveFrom: w.neuronPrice.date, source: 'price-sheet', ref: w.neuronPrice.source, unverified: false, priceId: NEURON_PRICE_ID });
    }
  }
  return out;
}

/** The cost of a record at a price, in micro-units of its currency, and its neurons (Workers AI). */
export function costAt(price: ModelPrice, u: { promptTokens?: number; outputTokens?: number; thinkingTokens?: number; cachedTokens?: number | null }): { costMicros: number; neurons: number | null } {
  const prompt = Math.max(0, u.promptTokens ?? 0);
  const output = Math.max(0, (u.outputTokens ?? 0) + (u.thinkingTokens ?? 0));
  if (price.basis === 'neurons') {
    const neurons = Math.round((prompt * (price.neuronsInput ?? 0) + output * (price.neuronsOutput ?? 0)) / 1_000_000);
    return { neurons, costMicros: Math.round(neurons * ((price.neuronPrice ?? 0) / 1000) * 1_000_000) };
  }
  const cached = Math.min(prompt, Math.max(0, u.cachedTokens ?? 0));
  const money = (prompt - cached) * (price.inputPerMillion ?? 0) + cached * (price.cachedPerMillion ?? price.inputPerMillion ?? 0) + output * (price.outputPerMillion ?? 0);
  // Per million tokens → per token, then micro-units: the two millions cancel.
  return { neurons: null, costMicros: Math.round(money) };
}

/** The body of `PUT /api/admin/cloud/model-prices` (a price version by hand). */
const money = z.number().min(0).max(100_000);
export const modelPriceSchema = z
  .object({
    provider: z.enum(['aws', 'azure', 'digitalocean', 'cloudflare']),
    region: z.string().trim().regex(/^(\*|[a-z0-9-]{2,40})$/, 'a region or *').default('*'),
    model: z.string().trim().min(1).max(200),
    currency: z.string().trim().regex(/^[A-Z]{3}$/, 'an ISO 4217 code').default('USD'),
    basis: z.enum(['tokens', 'neurons']).default('tokens'),
    inputPerMillion: money.nullable().default(null),
    outputPerMillion: money.nullable().default(null),
    cachedPerMillion: money.nullable().default(null),
    neuronsInput: z.number().int().min(0).max(100_000_000).nullable().default(null),
    neuronsOutput: z.number().int().min(0).max(100_000_000).nullable().default(null),
    neuronPrice: money.nullable().default(null),
    effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
    source: z.string().trim().url().max(300).nullable().default(null),
    note: z.string().trim().max(500).nullable().default(null)
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.basis === 'tokens' && v.inputPerMillion == null) ctx.addIssue({ code: 'custom', path: ['inputPerMillion'], message: 'A token price needs at least the input price.' });
    if (v.basis === 'neurons' && (v.neuronsInput == null || v.neuronPrice == null)) ctx.addIssue({ code: 'custom', path: ['neuronsInput'], message: 'A neuron price needs the neurons per million input tokens and the price per 1,000 neurons.' });
  });
export type ModelPriceInput = z.infer<typeof modelPriceSchema>;

export const modelPriceView = (p: ModelPrice) => ({ id: p.id, provider: p.provider, region: p.region, model: p.model, currency: p.currency, basis: p.basis, inputPerMillion: p.inputPerMillion, outputPerMillion: p.outputPerMillion, cachedPerMillion: p.cachedPerMillion, neuronsInput: p.neuronsInput, neuronsOutput: p.neuronsOutput, neuronPrice: p.neuronPrice, effectiveFrom: p.effectiveFrom, source: p.source, ref: p.ref, unverified: p.unverified, priceId: p.priceId });

const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));

function rowPrice(r: Record<string, unknown>): ModelPrice {
  const source = r.source as ModelPriceSource;
  return {
    id: String(r.id),
    provider: r.provider as Provider,
    region: String(r.region),
    model: String(r.model),
    currency: String(r.currency),
    basis: r.basis === 'neurons' ? 'neurons' : 'tokens',
    inputPerMillion: num(r.input_per_million),
    outputPerMillion: num(r.output_per_million),
    cachedPerMillion: num(r.cached_per_million),
    neuronsInput: num(r.neurons_input),
    neuronsOutput: num(r.neurons_output),
    neuronPrice: num(r.neuron_price),
    effectiveFrom: String(r.effective_from),
    source,
    ref: (r.source_ref as string | null) ?? null,
    unverified: false,
    priceId: `${source}:${String(r.id)}`.slice(0, 100)
  };
}

/** Where a cloud record's model runs: provider, region, the instance, and the name the provider prices it by. */
interface CloudTarget {
  provider: Provider;
  region: string;
  instance: InstanceRow;
}

const sha256 = (b: string) => createHash('sha256').update(b).digest('hex');

export interface ModelPriceEndpoints {
  /** AWS Price List Query API (default `https://api.pricing.us-east-1.amazonaws.com`). */
  awsPricing?: string;
  /** Azure Retail Prices API (default `https://prices.azure.com/api/retail/prices`). */
  azureRetail?: string;
}

/** Normalises a meter or model name for matching (`GPT 4o Mini` → `gpt-4o-mini`). */
const norm = (s: string) => s.toLowerCase().replace(/[\s_]+/g, '-');
/**
 * What may follow a model's name in an Azure meter: a version, the token kind, the deployment type, the unit. The
 * Retail Prices API spells them `gpt 4o 1120 Inp glbl`, `gpt-4o-mini-0718-Outp-regnl`, `gpt 4.1 mini cached Inp DZone`,
 * `gpt 4.1 Inp Data Zone`, `text-embedding-3-large-glbl`, `text embedding 3 small DZ` (checked 2026-10-21).
 */
const AZURE_REST = /^(?:$|-(?:\d+|inp|input|out|outp|output|cached|cchd|cache|glbl|gl|global|regional|regnl|rgnl|dzone|dz|data|tokens?|1m|1k|prompt|completion)(?:-|$))/;
/** The Retail Prices API query of a region's Azure OpenAI meters (service `Foundry Models`, products `Azure OpenAI*`). */
export const azureOpenAiFilter = (region: string): string => `serviceName eq 'Foundry Models' and startswith(productName, 'Azure OpenAI') and armRegionName eq '${region.replace(/'/g, '')}' and priceType eq 'Consumption'`;
/**
 * Of those, the products that do not bill a deployment's tokens at the standard rate (`Azure OpenAI`, `... GPT5`,
 * `... Reasoning`, `... Embedding` do): media (transcription, speech) and fine-tuned priority processing.
 */
const AZURE_PRODUCT_SKIP = /media|\bft\b|fine.?tun|provisioned/i;

/** The Azure deployment type a deployment SKU asks for, and a meter's. */
const azureType = (sku: string | null | undefined): 'global' | 'datazone' | 'regional' => (/^global/i.test(sku ?? '') ? 'global' : /^datazone/i.test(sku ?? '') ? 'datazone' : 'regional');
const meterType = (m: string): 'global' | 'datazone' | 'regional' => (/glbl|global|-gl(?:-|$)/.test(m) ? 'global' : /dzone|data-?zone|-dz(?:-|$)/.test(m) ? 'datazone' : 'regional');
/** The Price List service codes Bedrock's on-demand model prices are listed under (Amazon's own and Marketplace sellers'). */
const BEDROCK_SERVICE_CODES = ['AmazonBedrock', 'AmazonBedrockFoundationModels'] as const;
/**
 * Models the price list does not name by `model`: Amazon's Titan text embeddings carry `titanModel` instead, spelt
 * unlike Bedrock's model name (AmazonBedrock offer file, 2026-10-21).
 */
const BEDROCK_PRICE_NAMES: Record<string, { field: string; value: string }> = {
  'Titan Text Embeddings V2': { field: 'titanModel', value: 'TitanEmbeddingsV2-Text-input' },
  'Titan Embeddings G1 - Text': { field: 'titanModel', value: 'Titan Embeddings G1 Text' }
};
/** Bedrock products that are not the standard on-demand token price of a base model in its own region. */
const BEDROCK_SKIP = /batch|provisioned|custom|training|storage|reserved|flex|priority|latency|long.?context|global|image|audio|video|speech/;
const perMillion = (unit: string | undefined, price: number): number => {
  const u = (unit ?? '').toLowerCase();
  if (/1m|million/.test(u)) return price;
  if (/1k|1,000|thousand/.test(u)) return price * 1000;
  return price * 1_000_000;
};

export interface ModelPriceOptions {
  endpoints?: ModelPriceEndpoints;
  transport?: Omit<TransportOptions, 'provider' | 'policy' | 'counters'>;
  now?: () => number;
}

export class CloudModelPrices {
  private schema: { ok: boolean; at: number } | null = null;
  private endpoints: ModelPriceEndpoints;
  private transports = new Map<Provider, CloudTransport>();
  private targets: { at: number; map: Promise<Map<string, InstanceRow[]>> } | null = null;
  private sheet: ModelPrice[] = sheetModelPrices();
  private readonly now: () => number;
  /** Calls made, per source (tests). */
  readonly calls: Record<'aws-price-list' | 'azure-retail-prices', number> = { 'aws-price-list': 0, 'azure-retail-prices': 0 };

  constructor(
    private readonly s: () => Services,
    private readonly o: ModelPriceOptions = {}
  ) {
    this.endpoints = { ...(o.endpoints ?? {}) };
    this.now = o.now ?? Date.now;
  }

  setEndpoints(e: ModelPriceEndpoints): void {
    this.endpoints = { ...this.endpoints, ...e };
  }

  setTransport(o: Omit<TransportOptions, 'provider' | 'policy' | 'counters'>): void {
    this.o.transport = o;
    this.transports.clear();
  }

  /** Tests: another sheet (the shipped one marks its model entries unverified). */
  useSheet(entries: ModelPrice[] | null): void {
    this.sheet = entries ?? sheetModelPrices();
  }

  async installed(): Promise<boolean> {
    const t = Date.now();
    if (this.schema && (this.schema.ok || t - this.schema.at < 30_000)) return this.schema.ok;
    let ok: boolean;
    try {
      ok = await this.s().db.schema.hasTable('cloud_model_prices');
    } catch {
      ok = false;
    }
    this.schema = { ok, at: t };
    return ok;
  }

  resetSchemaCache(): void {
    this.schema = null;
  }

  /** Forgets which pools hold cloud instances (tests, and an instance added or removed). */
  resetPools(): void {
    this.targets = null;
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

  // ---------- versions ----------

  /** Every version of a model's price in a region (newest first): the table's and the sheet's. */
  async versions(provider: Provider, model: string, region: string | null, currency = 'USD'): Promise<ModelPrice[]> {
    const names = [...new Set([model, ...(provider === 'aws' ? [bedrockBaseModel(model)] : [])])];
    const regionOk = (r: string) => r === '*' || region == null || r === region;
    const rows: ModelPrice[] = [];
    if (await this.installed()) {
      const got = (await this.s().db('cloud_model_prices').where({ provider, currency }).whereIn('model', names).catch(() => [])) as Record<string, unknown>[];
      rows.push(...got.map(rowPrice).filter((p) => regionOk(p.region)));
    }
    rows.push(...this.sheet.filter((p) => p.provider === provider && p.currency === currency && names.includes(p.model) && regionOk(p.region)));
    const rank = (p: ModelPrice) => [p.effectiveFrom, p.region === '*' ? 0 : 1, p.source === 'price-sheet' ? 0 : 1, names.indexOf(p.model) === 0 ? 1 : 0].join('|');
    return rows.sort((a, b) => (rank(a) < rank(b) ? 1 : rank(a) > rank(b) ? -1 : 0));
  }

  /**
   * The version in effect on a day: the latest whose effective day is on or before it (region-specific over `*`,
   * the API's or a hand-made one over the sheet's on the same day). `verified: true` (metering) skips unverified
   * sheet entries.
   */
  async priceAt(provider: Provider, model: string, region: string | null, at: number, o: { currency?: string; verified?: boolean } = {}): Promise<ModelPrice | null> {
    const day = DAY(at);
    const all = await this.versions(provider, model, region, o.currency ?? 'USD');
    return all.find((p) => p.effectiveFrom <= day && (!o.verified || !p.unverified)) ?? null;
  }

  // ---------- metering ----------

  /** Pools that hold a cloud instance, kept for 30 seconds. */
  private cloudPools(): Promise<Map<string, InstanceRow[]>> {
    if (this.targets && Date.now() - this.targets.at < 30_000) return this.targets.map;
    const map = this.s()
      .gateway.repo.instances()
      .then((rows) => {
        const m = new Map<string, InstanceRow[]>();
        for (const r of rows) if (isCloudInstance(r)) m.set(r.pool_id, [...(m.get(r.pool_id) ?? []), r]);
        return m;
      });
    this.targets = { at: Date.now(), map };
    map.catch(() => (this.targets = null));
    return map;
  }

  /** The cloud instance a record ran on (its pool's, preferring the one that lists the model). */
  private async targetOf(u: UsageInput): Promise<CloudTarget | null> {
    if (!u.poolId || !u.model) return null;
    let list = (await this.cloudPools()).get(u.poolId);
    if (!list) {
      // A cloud instance added since the cache was filled: look again, at most once every two seconds, so an Ollama
      // pool's records (never in the map) do not query the instances on every record.
      if (!this.targets || Date.now() - this.targets.at < 2000) return null;
      this.targets = null;
      list = (await this.cloudPools()).get(u.poolId);
      if (!list) return null;
    }
    const lists = (r: InstanceRow) => (r.settings.reported?.models ?? []).some((m) => m.id === u.model);
    const inst = list.find(lists) ?? list[0]!;
    const provider = providerOf(inst)!;
    return { provider, region: inst.settings.cloud?.region ?? '*', instance: inst };
  }

  /** The name a provider prices a model by: an Azure deployment's model, else the model itself. */
  private async pricedName(t: CloudTarget, model: string, entry: CloudModelEntry | null): Promise<string> {
    if (t.provider !== 'azure') return model;
    const fromEntry = (entry?.details?.model as { name?: string } | null | undefined)?.name;
    if (fromEntry) return fromEntry;
    const reported = (t.instance.settings.reported?.models ?? []).find((m) => m.id === model)?.ownedBy;
    return reported ?? model;
  }

  private async entryOf(model: string): Promise<CloudModelEntry | null> {
    const row = await this.s().gateway.repo.modelByName(model).catch(() => undefined);
    return row ? ((await this.s().cloud.modelImport?.entry(row.id).catch(() => null)) ?? null) : null;
  }

  /**
   * A usage record's cost (and a Workers AI record's neurons), when it ran on a cloud model server and a verified
   * price is in effect on its day; null for everything else (an Ollama record, a model without a price).
   */
  async priceUsage(u: UsageInput): Promise<UsagePrice | null> {
    const t = await this.targetOf(u);
    if (!t) return null;
    const entry = await this.entryOf(u.model!);
    const name = await this.pricedName(t, u.model!, entry);
    const region = entry?.region ?? t.region;
    const account = t.instance.settings.cloud?.accountId ? await this.s().cloud.accounts.get(t.instance.settings.cloud.accountId).catch(() => null) : null;
    const currency = (account as (CloudAccount & { billingCurrency?: string }) | null)?.billingCurrency ?? 'USD';
    const price = await this.priceAt(t.provider, name, region === 'global' ? null : region, u.ts ?? Date.now(), { currency, verified: true });
    if (!price) return null;
    const { costMicros, neurons } = costAt(price, u);
    return { ...(price.basis === 'neurons' ? { neurons } : {}), costMicros, currency: price.currency, priceId: price.priceId };
  }

  // ---------- by hand ----------

  /** Records a price version (FinOps). It prices records from its effective day on; earlier ones keep their price. */
  async set(p: Principal, input: ModelPriceInput, ctx: { ip?: string | null; traceId?: string } = {}): Promise<ModelPrice> {
    if (!(await this.installed())) throw new HttpProblem(503, 'Service unavailable', 'Cloud model prices are not installed yet (migration 163_cloud_model_prices).', { extensions: { reason: 'migration_pending' } });
    const row = {
      id: ulid(),
      provider: input.provider,
      region: input.region,
      model: input.model,
      currency: input.currency,
      basis: input.basis,
      input_per_million: input.inputPerMillion == null ? null : String(input.inputPerMillion),
      output_per_million: input.outputPerMillion == null ? null : String(input.outputPerMillion),
      cached_per_million: input.cachedPerMillion == null ? null : String(input.cachedPerMillion),
      neurons_input: input.neuronsInput,
      neurons_output: input.neuronsOutput,
      neuron_price: input.neuronPrice == null ? null : String(input.neuronPrice),
      effective_from: input.effectiveFrom,
      source: 'manual',
      source_ref: input.source,
      note: input.note,
      created_by: p.userId,
      created_at: this.now()
    };
    const db = this.s().db;
    const key = { provider: row.provider, region: row.region, model: row.model, currency: row.currency, effective_from: row.effective_from };
    const existing = (await db('cloud_model_prices').where(key).first()) as Record<string, unknown> | undefined;
    if (existing) {
      const { id: _id, ...rest } = row;
      await db('cloud_model_prices').where({ id: existing.id }).update(rest);
      row.id = String(existing.id);
    } else await db('cloud_model_prices').insert(row);
    await this.s().audit.append({ tenantId: p.tenantId, action: 'cloud.model-price.set', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { provider: row.provider, model: row.model, region: row.region }, detail: { basis: row.basis, currency: row.currency, inputPerMillion: input.inputPerMillion, outputPerMillion: input.outputPerMillion, cachedPerMillion: input.cachedPerMillion, neuronsInput: input.neuronsInput, neuronsOutput: input.neuronsOutput, neuronPrice: input.neuronPrice, effectiveFrom: row.effective_from, replaced: !!existing }, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
    return rowPrice({ ...row });
  }

  /** The table's versions (newest first), optionally for one provider or model. */
  async list(o: { provider?: Provider; model?: string } = {}): Promise<ModelPrice[]> {
    const rows: ModelPrice[] = [];
    if (await this.installed()) {
      const q = this.s().db('cloud_model_prices').orderBy('effective_from', 'desc').limit(1000);
      if (o.provider) q.where({ provider: o.provider });
      if (o.model) q.where({ model: o.model });
      rows.push(...((await q) as Record<string, unknown>[]).map(rowPrice));
    }
    rows.push(...this.sheet.filter((p) => (!o.provider || p.provider === o.provider) && (!o.model || p.model === o.model)));
    return rows;
  }

  // ---------- from the price APIs ----------

  private async store(p: Omit<ModelPrice, 'id' | 'priceId' | 'unverified'>): Promise<'stored' | 'known'> {
    const db = this.s().db;
    const key = { provider: p.provider, region: p.region, model: p.model, currency: p.currency, effective_from: p.effectiveFrom };
    if (await db('cloud_model_prices').where(key).first('id')) return 'known';
    try {
      await db('cloud_model_prices').insert({ id: ulid(), ...key, basis: p.basis, input_per_million: p.inputPerMillion == null ? null : String(p.inputPerMillion), output_per_million: p.outputPerMillion == null ? null : String(p.outputPerMillion), cached_per_million: p.cachedPerMillion == null ? null : String(p.cachedPerMillion), neurons_input: null, neurons_output: null, neuron_price: null, source: p.source, source_ref: (p.ref ?? '').slice(0, 300), note: null, created_by: null, created_at: this.now() });
    } catch (err) {
      if (isUniqueViolation(err)) return 'known';
      throw err;
    }
    return 'stored';
  }

  /**
   * Bedrock's prices of one model in a region from the AWS Price List API, filtered by region and the model's name as
   * the price list names it (`model`): Amazon's, Meta's and Mistral's models are in service code `AmazonBedrock`,
   * third-party sellers' (Anthropic, Cohere, AI21...) in `AmazonBedrockFoundationModels`, so both are asked and merged
   * (the second wins a token kind both list). A product per token kind, told apart by `inferenceType` (`Input tokens`,
   * `Output tokens`, `Prompt cache read input tokens`, `Cache read tokens`); the standard on-demand tier only: batch,
   * provisioned, custom-model, flex, priority, latency-optimized, long-context, cross-region `global` and image, audio
   * and video products are left out (checked against both offer files on 2026-10-21).
   */
  async fetchBedrock(account: CloudAccount, region: string, modelId: string, displayName: string | null): Promise<Omit<ModelPrice, 'id' | 'priceId' | 'unverified'> | null> {
    const c = this.s().cloud.credentials;
    if (!c) throw new CloudProviderError('Cloud credentials are not available in this build.', 'aws', 503, 'cloud_component_missing');
    const keys = (await c.for(account, 'billing')) as { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string };
    if (!keys?.accessKeyId || !keys.secretAccessKey) throw new CloudProviderError(`${account.name}'s billing credential is not an AWS key.`, 'aws', 400, 'wrong_credential');
    const url = new URL('/', this.endpoints.awsPricing ?? 'https://api.pricing.us-east-1.amazonaws.com');
    const name = displayName ?? bedrockBaseModel(modelId);
    const by = BEDROCK_PRICE_NAMES[name] ?? { field: 'model', value: name };
    const filters = [{ Type: 'TERM_MATCH', Field: 'regionCode', Value: region }, { Type: 'TERM_MATCH', Field: by.field, Value: by.value }];
    const found: { input?: number; output?: number; cached?: number; currency: string; date: string } = { currency: 'USD', date: DAY(this.now()) };
    for (const serviceCode of BEDROCK_SERVICE_CODES) {
      const body = JSON.stringify({ ServiceCode: serviceCode, Filters: filters, FormatVersion: 'aws_v1', MaxResults: 100 });
      const headers: Record<string, string> = { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSPriceListService.GetProducts', ...(keys.sessionToken ? { 'x-amz-security-token': keys.sessionToken } : {}) };
      const signed = signV4({ method: 'POST', url, headers, payloadHash: sha256(body), region: 'us-east-1', service: 'pricing', accessKeyId: keys.accessKeyId, secretAccessKey: keys.secretAccessKey, date: new Date(this.now()) });
      this.calls['aws-price-list'] += 1;
      const res = await this.transport('aws').json<{ PriceList?: (string | Record<string, unknown>)[] }>({ method: 'POST', url, headers: signed, body, accountId: account.id }, (status, b) => ({ message: `The AWS Price List API answered ${status}${typeof b === 'object' && b && 'message' in b ? `: ${String((b as { message: unknown }).message).slice(0, 200)}` : ''}.`, code: typeof b === 'object' && b && '__type' in b ? String((b as { __type: unknown }).__type) : null }));
      for (const item of res.body.PriceList ?? []) {
        const p = typeof item === 'string' ? (JSON.parse(item) as Record<string, unknown>) : item;
        const attrs = ((p.product as { attributes?: Record<string, string> } | undefined)?.attributes ?? {}) as Record<string, string>;
        const kind = `${attrs.inferenceType ?? ''} ${attrs.usagetype ?? ''} ${attrs.feature ?? ''} ${attrs.service_tier ?? ''}`.toLowerCase();
        if (BEDROCK_SKIP.test(kind)) continue;
        const which = /cache.?read|cached/.test(kind) ? 'cached' : /cache.?write/.test(kind) ? null : /output/.test(kind) ? 'output' : /input/.test(kind) ? 'input' : null;
        if (!which) continue;
        const terms = (p.terms as { OnDemand?: Record<string, { effectiveDate?: string; priceDimensions?: Record<string, { unit?: string; pricePerUnit?: Record<string, string> }> }> } | undefined)?.OnDemand ?? {};
        for (const term of Object.values(terms)) {
          for (const dim of Object.values(term.priceDimensions ?? {})) {
            const [currency, value] = Object.entries(dim.pricePerUnit ?? {})[0] ?? [];
            const price = Number(value);
            if (!currency || !Number.isFinite(price)) continue;
            found[which] = perMillion(dim.unit, price);
            found.currency = currency;
            if (term.effectiveDate) found.date = term.effectiveDate.slice(0, 10);
          }
        }
      }
    }
    if (found.input == null) return null;
    return { provider: 'aws', region, model: bedrockBaseModel(modelId), currency: found.currency, basis: 'tokens', inputPerMillion: round6(found.input), outputPerMillion: found.output == null ? 0 : round6(found.output), cachedPerMillion: found.cached == null ? null : round6(found.cached), neuronsInput: null, neuronsOutput: null, neuronPrice: null, effectiveFrom: found.date, source: 'aws-price-list', ref: `pricing:GetProducts AmazonBedrock ${displayName ?? modelId} ${region}`.slice(0, 300) };
  }

  /**
   * An Azure OpenAI model's prices in a region from the Retail Prices API: service `Foundry Models`, the products whose
   * name starts `Azure OpenAI` (`Azure OpenAI`, `... GPT5`, `... Reasoning`, `... Embedding`; media and fine-tuned
   * products left out), the meters whose name is the model's (and not a longer model's), of the deployment's type
   * (regional, data zone or global), told apart as input, cached input and output; batch, provisioned and fine-tuning
   * meters are left out. A model priced per version (`gpt 4o 0513`, `0806`, `1120`) is priced at the deployment's
   * version (`2024-11-20` → `1120`), or, without one, at the latest version the meters name.
   */
  async fetchAzure(region: string, model: string, deploymentSku: string | null, currency: string, version: string | null = null): Promise<Omit<ModelPrice, 'id' | 'priceId' | 'unverified'> | null> {
    const want = azureType(deploymentSku);
    const key = norm(model);
    const wantTag = /^\d{4}-\d{2}-\d{2}$/.test(version ?? '') ? `${version!.slice(5, 7)}${version!.slice(8, 10)}` : null;
    const base = this.endpoints.azureRetail ?? 'https://prices.azure.com/api/retail/prices';
    let next: string | null = (() => {
      const u = new URL(base);
      u.searchParams.set('currencyCode', currency);
      u.searchParams.set('$filter', azureOpenAiFilter(region));
      return u.toString();
    })();
    const seen: { tag: string; which: 'input' | 'output' | 'cached'; price: number; currency: string; date: string | null }[] = [];
    for (let page = 0; next && page < 20; page++) {
      this.calls['azure-retail-prices'] += 1;
      const res: { body: { Items?: { currencyCode?: string; retailPrice?: number; unitOfMeasure?: string; productName?: string; skuName?: string; meterName?: string; effectiveStartDate?: string }[]; NextPageLink?: string | null } } = await this.transport('azure').json({ method: 'GET', url: next, accountId: 'azure-retail-prices' }, (status) => ({ message: `The Azure Retail Prices API answered ${status}.`, code: null }));
      for (const i of res.body.Items ?? []) {
        if (AZURE_PRODUCT_SKIP.test(i.productName ?? '')) continue;
        const meter = norm(`${i.meterName ?? i.skuName ?? ''}`);
        if (/batch|provisioned|ptu|fine-?tun|-ft-|training|hosting|realtime|audio|image/.test(meter)) continue;
        const at = meter.indexOf(key);
        if (at < 0 || (at > 0 && /[a-z0-9.]/.test(meter[at - 1]!)) || !AZURE_REST.test(meter.slice(at + key.length))) continue;
        if (meterType(meter) !== want) continue;
        if (typeof i.retailPrice !== 'number') continue;
        const which = /cached|cchd|cache/.test(meter) ? 'cached' : /outp|output|-out(?:-|$)|completion/.test(meter) ? 'output' : 'input';
        const tag = /^-(\d{4})(?:-|$)/.exec(meter.slice(at + key.length))?.[1] ?? '';
        seen.push({ tag, which, price: perMillion(i.unitOfMeasure, i.retailPrice), currency: i.currencyCode ?? currency, date: i.effectiveStartDate ? i.effectiveStartDate.slice(0, 10) : null });
      }
      const n = res.body.NextPageLink;
      next = n && new URL(n).origin === new URL(base).origin ? n : null;
    }
    // The version priced: the deployment's, else the latest named; meters without a version apply to every one.
    const tags = [...new Set(seen.map((x) => x.tag).filter(Boolean))].sort();
    const tag = wantTag ?? tags.at(-1) ?? '';
    const found: { input?: number; output?: number; cached?: number; currency: string; date: string } = { currency, date: DAY(this.now()) };
    let dated = false;
    for (const x of seen) {
      if (x.tag && x.tag !== tag) continue;
      found[x.which] = x.price;
      found.currency = x.currency;
      // The version takes effect when its latest meter did.
      if (x.date && (!dated || x.date > found.date)) {
        found.date = x.date;
        dated = true;
      }
    }
    if (found.input == null) return null;
    return { provider: 'azure', region, model, currency: found.currency, basis: 'tokens', inputPerMillion: round6(found.input), outputPerMillion: found.output == null ? 0 : round6(found.output), cachedPerMillion: found.cached == null ? null : round6(found.cached), neuronsInput: null, neuronsOutput: null, neuronPrice: null, effectiveFrom: found.date, source: 'azure-retail-prices', ref: `prices.azure.com Azure OpenAI ${model}${tag ? ` ${tag}` : ''} ${want} ${region}`.slice(0, 300) };
  }

  /**
   * Fetches the prices of an account's cloud model entries from its provider's price API into the table (AWS and
   * Azure; DigitalOcean and Cloudflare have none, their prices are the sheet's). Never throws for one model: a
   * failure is counted and the sheet still answers.
   */
  async refresh(accountId: string, p?: Principal, ctx: { ip?: string | null; traceId?: string } = {}): Promise<{ account: string; fetched: number; known: number; missing: string[]; failed: { model: string; error: string }[]; skipped?: string }> {
    const s = this.s();
    const account = p ? await s.cloud.accounts.getFor(p, accountId) : await s.cloud.accounts.get(accountId);
    if (!account) throw notFound('Cloud account');
    if (!(await this.installed())) return { account: account.name, fetched: 0, known: 0, missing: [], failed: [], skipped: 'not installed (migration 163_cloud_model_prices)' };
    if (account.provider !== 'aws' && account.provider !== 'azure') return { account: account.name, fetched: 0, known: 0, missing: [], failed: [], skipped: `${account.provider} has no price API; its model prices are the price sheet's` };
    const entries = (await s.cloud.modelImport.entries(account.id)).filter((e) => e.accessState !== 'not_granted');
    const out = { account: account.name, fetched: 0, known: 0, missing: [] as string[], failed: [] as { model: string; error: string }[] };
    const currency = (account as CloudAccount & { billingCurrency?: string }).billingCurrency ?? 'USD';
    const done = new Set<string>();
    for (const e of entries) {
      const model = account.provider === 'azure' ? ((e.details.model as { name?: string } | null)?.name ?? e.externalId) : bedrockBaseModel(e.externalId);
      const k = `${model}|${(e.details.model as { version?: string | null } | null)?.version ?? ''}|${e.region}|${String(e.details.sku ?? '')}`;
      if (done.has(k)) continue;
      done.add(k);
      try {
        const got = account.provider === 'aws' ? await this.fetchBedrock(account, e.region, e.externalId, typeof e.details.name === 'string' && e.details.name !== e.externalId ? e.details.name : null) : await this.fetchAzure(e.region, model, (e.details.sku as string | null) ?? null, currency, (e.details.model as { version?: string | null } | null)?.version ?? null);
        if (!got) {
          out.missing.push(model);
          continue;
        }
        if ((await this.store(got)) === 'stored') out.fetched += 1;
        else out.known += 1;
      } catch (err) {
        out.failed.push({ model, error: (err as Error).message.slice(0, 300) });
      }
    }
    if (p) await s.audit.append({ tenantId: p.tenantId, action: 'cloud.model-prices.refreshed', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { account: account.name }, detail: { fetched: out.fetched, known: out.known, missing: out.missing.length, failed: out.failed.length }, ...(ctx.traceId ? { traceId: ctx.traceId } : {}) });
    return out;
  }

  /** What the model card shows: the version in effect today (unverified sheet entries flagged) and the history. */
  async card(provider: Provider, model: string, region: string | null, currency = 'USD'): Promise<{ current: ReturnType<typeof modelPriceView> | null; metered: boolean; versions: ReturnType<typeof modelPriceView>[] }> {
    const all = await this.versions(provider, model, region, currency);
    const today = DAY(this.now());
    // A verified version in effect wins; an unverified sheet entry is shown (flagged) only when nothing else is.
    const current = all.find((p) => p.effectiveFrom <= today && !p.unverified) ?? all.find((p) => p.effectiveFrom <= today) ?? null;
    const metered = all.some((p) => p.effectiveFrom <= today && !p.unverified);
    return { current: current ? modelPriceView(current) : null, metered, versions: all.slice(0, 20).map(modelPriceView) };
  }
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
