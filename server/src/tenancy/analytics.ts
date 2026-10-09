import { ulid } from 'ulid';
import type { Db } from '../db/knex.js';
import { csvLine } from '../audit/exports.js';
import { dayToDate } from './quotas.js';

export const ANALYTICS_DIMENSIONS = ['tenant', 'workspace', 'group', 'model', 'profile', 'user'] as const;
export type AnalyticsDimension = (typeof ANALYTICS_DIMENSIONS)[number];

/** Request kinds that count as messages (a turn answered) and as runs (an agent or workflow run). */
const MESSAGE_KINDS = ['chat', 'compare', 'api', 'channel'];
const RUN_KINDS = ['agent', 'workflow'];

export interface PriceRow {
  id: string;
  tenant_id: string;
  scope: 'model' | 'pool';
  ref: string;
  currency: string;
  input_per_million: number;
  output_per_million: number;
  gpu_hour: number;
  note: string | null;
  updated_by: string;
  created_at: number;
  updated_at: number;
}

export interface PriceInput {
  scope: 'model' | 'pool';
  ref: string;
  currency: string;
  inputPerMillion: number;
  outputPerMillion: number;
  gpuHour: number;
  note?: string | null;
}

export interface AnalyticsRow {
  key: string | null;
  name: string;
  requests: number;
  messages: number;
  runs: number;
  users: number;
  prompt: number;
  output: number;
  thinking: number;
  tokens: number;
  gpuMs: number;
  /** Null when no price applies to any of the row's models or pools. */
  cost: number | null;
  currency: string | null;
}

const priceFrom = (r: Record<string, unknown>): PriceRow => ({ ...(r as unknown as PriceRow), input_per_million: Number(r.input_per_million), output_per_million: Number(r.output_per_million), gpu_hour: Number(r.gpu_hour), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
export const priceView = (p: PriceRow) => ({ id: p.id, scope: p.scope, ref: p.ref, currency: p.currency, inputPerMillion: p.input_per_million, outputPerMillion: p.output_per_million, gpuHour: p.gpu_hour, note: p.note, updatedBy: p.updated_by, updatedAt: p.updated_at });

/** Cost of one aggregate at a price: tokens per million, GPU time per hour. A model price wins over a pool price. */
export function costOf(x: { prompt: number; output: number; gpuMs: number }, price: PriceRow | undefined): number | null {
  if (!price) return null;
  return Math.round(((x.prompt / 1e6) * price.input_per_million + (x.output / 1e6) * price.output_per_million + (x.gpuMs / 3_600_000) * price.gpu_hour) * 1e6) / 1e6;
}

/**
 * B-7401 to B-7403: usage and cost analytics over the metering records (`usage_records`): messages, tokens, users and
 * runs by tenant, workspace, group, model, profile and user over a day range, and a cost per row from the tenant's
 * prices (B-7402: a rate per million input and output tokens and per GPU-hour, per model or per pool). Every figure
 * is a sum over the same records the quotas read, so a day's totals here equal the metering of that day. The
 * chargeback export per workspace and month is the same computation, so its total equals the screen's.
 */
export class AnalyticsService {
  constructor(private readonly db: Db) {}

  // ---------- prices ----------

  async prices(tenantId: string): Promise<PriceRow[]> {
    return ((await this.db('usage_prices').where({ tenant_id: tenantId }).orderBy(['scope', 'ref'])) as Record<string, unknown>[]).map(priceFrom);
  }

  async setPrice(tenantId: string, input: PriceInput, by: string): Promise<PriceRow> {
    const t = Date.now();
    const existing = await this.db('usage_prices').where({ tenant_id: tenantId, scope: input.scope, ref: input.ref }).first();
    const row = { currency: input.currency.toUpperCase(), input_per_million: input.inputPerMillion, output_per_million: input.outputPerMillion, gpu_hour: input.gpuHour, note: input.note ?? null, updated_by: by, updated_at: t };
    if (existing) {
      await this.db('usage_prices').where({ id: existing.id }).update(row);
      return priceFrom({ ...existing, ...row });
    }
    const full = { id: ulid(), tenant_id: tenantId, scope: input.scope, ref: input.ref, created_at: t, ...row };
    await this.db('usage_prices').insert(full);
    return priceFrom(full);
  }

  async deletePrice(tenantId: string, id: string): Promise<PriceRow | null> {
    const r = await this.db('usage_prices').where({ tenant_id: tenantId, id }).first();
    if (!r) return null;
    await this.db('usage_prices').where({ id }).delete();
    return priceFrom(r);
  }

  private priceIndex(prices: PriceRow[]) {
    const models = new Map(prices.filter((p) => p.scope === 'model').map((p) => [p.ref, p]));
    const pools = new Map(prices.filter((p) => p.scope === 'pool').map((p) => [p.ref, p]));
    return (model: string | null, pool: string | null): PriceRow | undefined => (model ? models.get(model) : undefined) ?? (pool ? pools.get(pool) : undefined);
  }

  // ---------- aggregates ----------

  /**
   * One row per value of the dimension. `tenantId` null means every tenant (system admins, `by: tenant`). Costs are
   * summed per (model, pool) inside each row; a row with records no price covers reports null, as a partial figure
   * would read as a total.
   */
  async summary(tenantId: string | null, by: AnalyticsDimension, fromDay: number, toDay: number, o: { workspaceId?: string | null; groupId?: string | null } = {}): Promise<{ rows: AnalyticsRow[]; currency: string | null }> {
    const col = { tenant: 'r.tenant_id', workspace: 'r.workspace_id', group: 'gm.group_id', model: 'r.model', profile: 'r.profile_id', user: 'r.user_id' }[by];
    const q = this.db('usage_records as r').whereBetween('r.day', [fromDay, toDay]);
    if (tenantId) q.andWhere('r.tenant_id', tenantId);
    if (o.workspaceId) q.andWhere('r.workspace_id', o.workspaceId);
    if (by === 'group' || o.groupId) {
      q.join('group_members as gm', function () {
        this.on('gm.user_id', '=', 'r.user_id').andOn('gm.tenant_id', '=', 'r.tenant_id');
      });
      if (o.groupId) q.andWhere('gm.group_id', o.groupId);
    }
    const raw = (await q
      .groupBy(col, 'r.model', 'r.pool_id')
      .select({ key: col }, 'r.model', 'r.pool_id')
      .sum({ prompt: 'r.prompt_tokens', output: 'r.output_tokens', thinking: 'r.thinking_tokens', gpu_ms: 'r.gpu_ms' })
      .count({ requests: '*' })
      .sum({ messages: this.db.raw(`case when r.kind in (${MESSAGE_KINDS.map(() => '?').join(',')}) then 1 else 0 end`, MESSAGE_KINDS) })
      .sum({ runs: this.db.raw(`case when r.kind in (${RUN_KINDS.map(() => '?').join(',')}) then 1 else 0 end`, RUN_KINDS) })
      .countDistinct({ users: 'r.user_id' })) as Record<string, unknown>[];
    const prices = tenantId ? await this.prices(tenantId) : [];
    const price = this.priceIndex(prices);
    const currency = prices[0]?.currency ?? null;
    // Distinct users per key cannot be summed over (model, pool) groups: count them in a second pass.
    const users = new Map<string | null, number>();
    const uq = this.db('usage_records as r').whereBetween('r.day', [fromDay, toDay]);
    if (tenantId) uq.andWhere('r.tenant_id', tenantId);
    if (o.workspaceId) uq.andWhere('r.workspace_id', o.workspaceId);
    if (by === 'group' || o.groupId) {
      uq.join('group_members as gm', function () {
        this.on('gm.user_id', '=', 'r.user_id').andOn('gm.tenant_id', '=', 'r.tenant_id');
      });
      if (o.groupId) uq.andWhere('gm.group_id', o.groupId);
    }
    for (const r of (await uq.groupBy(col).select({ key: col }).countDistinct({ users: 'r.user_id' })) as Record<string, unknown>[]) users.set((r.key as string | null) ?? null, Number(r.users ?? 0));
    const rows = new Map<string | null, AnalyticsRow & { priced: boolean; unpriced: boolean }>();
    for (const r of raw) {
      const key = (r.key as string | null) ?? null;
      const row = rows.get(key) ?? { key, name: '', requests: 0, messages: 0, runs: 0, users: users.get(key) ?? 0, prompt: 0, output: 0, thinking: 0, tokens: 0, gpuMs: 0, cost: 0, currency, priced: false, unpriced: false };
      const part = { prompt: Number(r.prompt ?? 0), output: Number(r.output ?? 0), gpuMs: Number(r.gpu_ms ?? 0) };
      row.requests += Number(r.requests ?? 0);
      row.messages += Number(r.messages ?? 0);
      row.runs += Number(r.runs ?? 0);
      row.prompt += part.prompt;
      row.output += part.output;
      row.thinking += Number(r.thinking ?? 0);
      row.gpuMs += part.gpuMs;
      const c = costOf(part, price((r.model as string | null) ?? null, (r.pool_id as string | null) ?? null));
      if (c == null) row.unpriced = true;
      else {
        row.priced = true;
        row.cost = (row.cost ?? 0) + c;
      }
      rows.set(key, row);
    }
    const out = [...rows.values()].map(({ priced, unpriced, ...row }) => ({ ...row, tokens: row.prompt + row.output + row.thinking, cost: priced && !unpriced ? Math.round((row.cost ?? 0) * 1e6) / 1e6 : null, currency: priced && !unpriced ? currency : null }));
    return { rows: out.sort((a, b) => b.tokens - a.tokens), currency };
  }

  /** Per day over the range: messages, runs, tokens and GPU time (zero-filled by the route). */
  async daily(tenantId: string, fromDay: number, toDay: number, workspaceId?: string | null): Promise<{ day: number; messages: number; runs: number; tokens: number; gpuMs: number }[]> {
    const q = this.db('usage_records as r').whereBetween('r.day', [fromDay, toDay]).andWhere('r.tenant_id', tenantId);
    if (workspaceId) q.andWhere('r.workspace_id', workspaceId);
    const rows = (await q
      .groupBy('r.day')
      .select('r.day')
      .sum({ p: 'r.prompt_tokens', o: 'r.output_tokens', t: 'r.thinking_tokens', g: 'r.gpu_ms' })
      .sum({ messages: this.db.raw(`case when r.kind in (${MESSAGE_KINDS.map(() => '?').join(',')}) then 1 else 0 end`, MESSAGE_KINDS) })
      .sum({ runs: this.db.raw(`case when r.kind in (${RUN_KINDS.map(() => '?').join(',')}) then 1 else 0 end`, RUN_KINDS) })) as Record<string, unknown>[];
    return rows.map((r) => ({ day: Number(r.day), messages: Number(r.messages ?? 0), runs: Number(r.runs ?? 0), tokens: Number(r.p ?? 0) + Number(r.o ?? 0) + Number(r.t ?? 0), gpuMs: Number(r.g ?? 0) })).sort((a, b) => a.day - b.day);
  }

  /**
   * B-7402: the chargeback for one month, per workspace and model (or every workspace): tokens, GPU time and cost at
   * the tenant's prices, with a total line. The same sums as `summary`, so the total equals the screen's.
   */
  async chargeback(tenantId: string, month: number, workspaceId?: string | null): Promise<{ month: number; currency: string | null; rows: { workspaceId: string | null; workspace: string; model: string | null; pool: string | null; requests: number; prompt: number; output: number; gpuMs: number; cost: number | null }[]; total: { requests: number; prompt: number; output: number; gpuMs: number; cost: number | null; unpriced: number } }> {
    const q = this.db('usage_records as r').leftJoin('workspaces as w', 'w.id', 'r.workspace_id').where('r.tenant_id', tenantId).andWhere('r.month', month);
    if (workspaceId) q.andWhere('r.workspace_id', workspaceId);
    const raw = (await q
      .groupBy('r.workspace_id', 'w.name', 'r.model', 'r.pool_id')
      .select('r.workspace_id', 'w.name as workspace', 'r.model', 'r.pool_id')
      .sum({ prompt: 'r.prompt_tokens', output: 'r.output_tokens', gpu_ms: 'r.gpu_ms' })
      .count({ requests: '*' })) as Record<string, unknown>[];
    const prices = await this.prices(tenantId);
    const price = this.priceIndex(prices);
    const rows = raw.map((r) => {
      const part = { prompt: Number(r.prompt ?? 0), output: Number(r.output ?? 0), gpuMs: Number(r.gpu_ms ?? 0) };
      return { workspaceId: (r.workspace_id as string | null) ?? null, workspace: (r.workspace as string | null) ?? 'No workspace', model: (r.model as string | null) ?? null, pool: (r.pool_id as string | null) ?? null, requests: Number(r.requests ?? 0), ...part, cost: costOf(part, price((r.model as string | null) ?? null, (r.pool_id as string | null) ?? null)) };
    }).sort((a, b) => a.workspace.localeCompare(b.workspace) || String(a.model).localeCompare(String(b.model)));
    const unpriced = rows.filter((r) => r.cost == null).length;
    const total = { requests: 0, prompt: 0, output: 0, gpuMs: 0, cost: unpriced || !rows.length ? null : 0, unpriced };
    for (const r of rows) {
      total.requests += r.requests;
      total.prompt += r.prompt;
      total.output += r.output;
      total.gpuMs += r.gpuMs;
      if (total.cost != null && r.cost != null) total.cost = Math.round((total.cost + r.cost) * 1e6) / 1e6;
    }
    return { month, currency: prices[0]?.currency ?? null, rows, total };
  }

  chargebackCsv(c: Awaited<ReturnType<AnalyticsService['chargeback']>>): string {
    const m = String(c.month);
    const label = `${m.slice(0, 4)}-${m.slice(4, 6)}`;
    let out = csvLine(['month', 'workspace', 'model', 'pool', 'requests', 'prompt_tokens', 'output_tokens', 'gpu_seconds', 'cost', 'currency']);
    for (const r of c.rows) out += csvLine([label, r.workspace, r.model, r.pool, r.requests, r.prompt, r.output, (r.gpuMs / 1000).toFixed(1), r.cost == null ? '' : r.cost.toFixed(6), r.cost == null ? '' : c.currency]);
    out += csvLine([label, 'TOTAL', '', '', c.total.requests, c.total.prompt, c.total.output, (c.total.gpuMs / 1000).toFixed(1), c.total.cost == null ? '' : c.total.cost.toFixed(6), c.total.cost == null ? '' : c.currency]);
    return out;
  }
}

export const dayLabel = dayToDate;
