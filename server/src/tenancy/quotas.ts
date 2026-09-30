import { ulid } from 'ulid';
import type { Db } from '../db/knex.js';
import { tooManyRequests } from '../http/problem.js';

export interface QuotaLimits {
  tokensPerDay: number | null;
  gpuSecondsPerMonth: number | null;
  trainingGpuHoursPerMonth: number | null;
}

export interface QuotaView extends QuotaLimits {
  scope: 'tenant' | 'workspace';
  workspaceId: string | null;
  used: { tokensToday: number; gpuSecondsMonth: number; trainingGpuHoursMonth: number };
  resets: { daily: number; monthly: number };
  updatedAt: number | null;
}

export interface UsageInput {
  tenantId: string;
  workspaceId: string | null;
  userId: string | null;
  apiKeyId?: string | null;
  kind: 'chat' | 'compare' | 'api' | 'load' | 'embed' | 'training' | 'agent' | 'workflow' | 'image' | 'media';
  profileId?: string | null;
  model?: string | null;
  poolId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  promptTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  calcCalls?: number;
  gpuMs?: number;
  ts?: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
export const dayOf = (ts: number): number => {
  const d = new Date(ts);
  return Number(`${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`);
};
export const monthOf = (ts: number): number => Math.floor(dayOf(ts) / 100);
export const nextDay = (ts: number): number => {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};
export const nextMonth = (ts: number): number => {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
};
export const dayToDate = (day: number): string => `${String(day).slice(0, 4)}-${String(day).slice(4, 6)}-${String(day).slice(6, 8)}`;

const num = (v: unknown): number | null => (v == null ? null : Number(v));

/**
 * Quotas per tenant (the total) and per workspace (nested under it). Interactive requests are admitted only while
 * every applicable limit has room; otherwise they fail with 429, Retry-After set to the reset, and a problem detail
 * naming the limit and who can raise it. Windows are UTC days and months.
 */
export class QuotaService {
  constructor(private readonly db: Db) {}

  async limits(tenantId: string, workspaceId: string | null): Promise<QuotaLimits & { updatedAt: number | null }> {
    const r = await this.db('quotas').where({ tenant_id: tenantId, workspace_id: workspaceId }).first();
    return { tokensPerDay: num(r?.tokens_per_day), gpuSecondsPerMonth: num(r?.gpu_seconds_per_month), trainingGpuHoursPerMonth: num(r?.training_gpu_hours_per_month), updatedAt: num(r?.updated_at) };
  }

  async set(tenantId: string, workspaceId: string | null, limits: Partial<QuotaLimits>, by: string): Promise<void> {
    const existing = await this.db('quotas').where({ tenant_id: tenantId, workspace_id: workspaceId }).first();
    const row: Record<string, unknown> = { updated_by: by, updated_at: Date.now() };
    if (limits.tokensPerDay !== undefined) row.tokens_per_day = limits.tokensPerDay;
    if (limits.gpuSecondsPerMonth !== undefined) row.gpu_seconds_per_month = limits.gpuSecondsPerMonth;
    if (limits.trainingGpuHoursPerMonth !== undefined) row.training_gpu_hours_per_month = limits.trainingGpuHoursPerMonth;
    if (existing) await this.db('quotas').where({ id: existing.id }).update(row);
    else await this.db('quotas').insert({ id: ulid(), tenant_id: tenantId, workspace_id: workspaceId, ...row });
  }

  async used(tenantId: string, workspaceId: string | null, ts = Date.now()): Promise<QuotaView['used']> {
    const base = () => this.db('usage_records').where(workspaceId ? { tenant_id: tenantId, workspace_id: workspaceId } : { tenant_id: tenantId });
    type Sums = Record<string, unknown> | undefined;
    const day = ((await base().andWhere({ day: dayOf(ts) }).sum({ p: 'prompt_tokens', o: 'output_tokens' })) as Record<string, unknown>[])[0] as Sums;
    const month = ((await base().andWhere({ month: monthOf(ts) }).whereNot({ kind: 'training' }).sum({ g: 'gpu_ms' })) as Record<string, unknown>[])[0] as Sums;
    const train = ((await base().andWhere({ month: monthOf(ts), kind: 'training' }).sum({ g: 'gpu_ms' })) as Record<string, unknown>[])[0] as Sums;
    return {
      tokensToday: Number(day?.p ?? 0) + Number(day?.o ?? 0),
      gpuSecondsMonth: Math.round(Number(month?.g ?? 0) / 1000),
      trainingGpuHoursMonth: Math.round((Number(train?.g ?? 0) / 3_600_000) * 10) / 10
    };
  }

  async view(tenantId: string, workspaceId: string | null): Promise<QuotaView> {
    const now = Date.now();
    const [l, used] = await Promise.all([this.limits(tenantId, workspaceId), this.used(tenantId, workspaceId, now)]);
    return { scope: workspaceId ? 'workspace' : 'tenant', workspaceId, tokensPerDay: l.tokensPerDay, gpuSecondsPerMonth: l.gpuSecondsPerMonth, trainingGpuHoursPerMonth: l.trainingGpuHoursPerMonth, used, resets: { daily: nextDay(now), monthly: nextMonth(now) }, updatedAt: l.updatedAt };
  }

  /** Throws 429 when the workspace or the tenant has reached a limit. `extraTokens` reserves room for the request. */
  async admit(tenantId: string, workspaceId: string | null, opts: { tenantName?: string; workspaceName?: string } = {}): Promise<void> {
    const now = Date.now();
    const scopes: { id: string | null; name: string; raise: string }[] = [];
    if (workspaceId) scopes.push({ id: workspaceId, name: opts.workspaceName ?? 'This workspace', raise: 'a tenant admin' });
    scopes.push({ id: null, name: opts.tenantName ?? 'This tenant', raise: 'a system admin' });
    for (const sc of scopes) {
      const l = await this.limits(tenantId, sc.id);
      if (l.tokensPerDay == null && l.gpuSecondsPerMonth == null) continue;
      const u = await this.used(tenantId, sc.id, now);
      if (l.tokensPerDay != null && u.tokensToday >= l.tokensPerDay) {
        throw withLimit(tooManyRequests(`${sc.name} used ${u.tokensToday.toLocaleString('en-US')} of ${l.tokensPerDay.toLocaleString('en-US')} tokens today. Requests are refused until the daily reset; ${sc.raise} can raise the limit.`, (nextDay(now) - now) / 1000), {
          limit: 'tokens_per_day', scope: sc.id ? 'workspace' : 'tenant', used: u.tokensToday, max: l.tokensPerDay, resets_at: new Date(nextDay(now)).toISOString(), raised_by: sc.raise
        });
      }
      if (l.gpuSecondsPerMonth != null && u.gpuSecondsMonth >= l.gpuSecondsPerMonth) {
        throw withLimit(tooManyRequests(`${sc.name} used ${u.gpuSecondsMonth.toLocaleString('en-US')} of ${l.gpuSecondsPerMonth.toLocaleString('en-US')} GPU-seconds this month; ${sc.raise} can raise the limit.`, (nextMonth(now) - now) / 1000), {
          limit: 'gpu_seconds_per_month', scope: sc.id ? 'workspace' : 'tenant', used: u.gpuSecondsMonth, max: l.gpuSecondsPerMonth, resets_at: new Date(nextMonth(now)).toISOString(), raised_by: sc.raise
        });
      }
    }
  }

  async record(u: UsageInput): Promise<void> {
    const ts = u.ts ?? Date.now();
    await this.db('usage_records').insert({
      id: ulid(),
      tenant_id: u.tenantId,
      workspace_id: u.workspaceId,
      user_id: u.userId,
      api_key_id: u.apiKeyId ?? null,
      kind: u.kind,
      profile_id: u.profileId ?? null,
      model: u.model ?? null,
      pool_id: u.poolId ?? null,
      conversation_id: u.conversationId ?? null,
      message_id: u.messageId ?? null,
      prompt_tokens: Math.max(0, Math.round(u.promptTokens ?? 0)),
      output_tokens: Math.max(0, Math.round(u.outputTokens ?? 0)),
      thinking_tokens: Math.max(0, Math.round(u.thinkingTokens ?? 0)),
      calc_calls: u.calcCalls ?? 0,
      gpu_ms: Math.max(0, Math.round(u.gpuMs ?? 0)),
      day: dayOf(ts),
      month: monthOf(ts),
      ts
    });
  }

  /** Aggregated usage for the Usage screen. `tenantId` null means every tenant (system admins). */
  async summary(tenantId: string | null, by: 'user' | 'model' | 'workspace' | 'tenant' | 'profile', fromDay: number, toDay: number, workspaceId?: string | null) {
    const col = { user: 'r.user_id', model: 'r.model', workspace: 'r.workspace_id', tenant: 'r.tenant_id', profile: 'r.profile_id' }[by];
    const q = this.db('usage_records as r').whereBetween('r.day', [fromDay, toDay]);
    if (tenantId) q.andWhere('r.tenant_id', tenantId);
    if (workspaceId) q.andWhere('r.workspace_id', workspaceId);
    const rows = await q
      .groupBy(col)
      .select({ key: col })
      .sum({ prompt: 'r.prompt_tokens', output: 'r.output_tokens', thinking: 'r.thinking_tokens', calc: 'r.calc_calls', gpu_ms: 'r.gpu_ms' })
      .count({ requests: '*' });
    return rows
      .map((r: Record<string, unknown>) => ({ key: (r.key as string | null) ?? null, prompt: Number(r.prompt ?? 0), output: Number(r.output ?? 0), thinking: Number(r.thinking ?? 0), calc: Number(r.calc ?? 0), gpuMs: Number(r.gpu_ms ?? 0), requests: Number(r.requests ?? 0) }))
      .sort((a, b) => b.prompt + b.output - (a.prompt + a.output));
  }

  async daily(tenantId: string | null, fromDay: number, toDay: number, workspaceId?: string | null): Promise<{ day: number; tokens: number; gpuMs: number }[]> {
    const q = this.db('usage_records').whereBetween('day', [fromDay, toDay]);
    if (tenantId) q.andWhere({ tenant_id: tenantId });
    if (workspaceId) q.andWhere({ workspace_id: workspaceId });
    const rows = await q.groupBy('day').select('day').sum({ p: 'prompt_tokens', o: 'output_tokens', g: 'gpu_ms' });
    return rows.map((r: Record<string, unknown>) => ({ day: Number(r.day), tokens: Number(r.p ?? 0) + Number(r.o ?? 0), gpuMs: Number(r.g ?? 0) })).sort((a, b) => a.day - b.day);
  }
}

function withLimit(p: ReturnType<typeof tooManyRequests>, ext: Record<string, unknown>) {
  Object.assign(p.extensions, ext);
  return p;
}
