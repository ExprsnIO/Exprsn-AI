import type { Principal } from '../authz/policy.js';
import type { Services } from '../services.js';
import { NEURON_PRICE_ID } from './model-prices.js';
import type { Provider } from './types.js';

/*
 * 1.9.99-final, Sprint 62 (B-10607): what the Cloud spend screen needs beside the budgets, costs, showback and
 * anomaly routes: a month's ingested spend per day and provider (per currency, never converted), the cloud model
 * calls priced at metering (`usage_records.cost_micros`, B-10505) per model and profile, and the idle GPU saving
 * (B-10605). Only the accounts the caller may see count; model usage is the caller's tenant's, every tenant's for a
 * platform admin.
 */

export interface SpendOverview {
  month: string;
  accounts: { id: string; name: string; provider: Provider; scope: string }[];
  daily: { day: string; provider: Provider; currency: string; amount: number }[];
  totals: { provider: Provider; currency: string; amount: number; estimated: boolean }[];
  tokens: { model: string; provider: Provider | null; profileId: string | null; profile: string | null; currency: string; inputTokens: number; outputTokens: number; neurons: number | null; cost: number; calls: number }[];
  savings: { provider: Provider; currency: string; hours: number; saving: number | null }[];
  anomaliesOpen: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** The provider a priced usage record's `price_id` names. */
async function providersOf(s: Services, priceIds: string[]): Promise<Map<string, Provider>> {
  const out = new Map<string, Provider>();
  const rowIds: string[] = [];
  for (const id of priceIds) {
    if (id === NEURON_PRICE_ID || id.startsWith('workers-ai:')) out.set(id, 'cloudflare');
    else if (id.startsWith('sheet:')) out.set(id, id.slice(6).split('/')[0] as Provider);
    else if (id.includes(':')) rowIds.push(id);
  }
  if (rowIds.length) {
    const rows = (await s.db('cloud_model_prices').whereIn('id', rowIds.map((x) => x.slice(x.indexOf(':') + 1))).select('id', 'provider').catch(() => [])) as { id: string; provider: string }[];
    const byRow = new Map(rows.map((r) => [String(r.id), r.provider as Provider]));
    for (const id of rowIds) {
      const p = byRow.get(id.slice(id.indexOf(':') + 1));
      if (p) out.set(id, p);
    }
  }
  return out;
}

export async function spendOverview(s: Services, p: Principal, month: string): Promise<SpendOverview> {
  await s.cloud.costs.need();
  const accounts = await s.cloud.accounts.list(p);
  const ids = accounts.map((a) => a.id);
  const from = `${month}-01`;
  const [y, m] = month.split('-').map(Number) as [number, number];
  const to = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const rows = ids.length ? ((await s.db('cloud_costs').whereIn('account_id', ids).where('day', '>=', from).where('day', '<', to).groupBy('day', 'provider', 'currency', 'estimated').select('day', 'provider', 'currency', 'estimated').sum({ amount: 'amount' })) as { day: string; provider: string; currency: string; estimated: unknown; amount: unknown }[]) : [];
  const daily = new Map<string, { day: string; provider: Provider; currency: string; amount: number }>();
  const totals = new Map<string, { provider: Provider; currency: string; amount: number; estimated: boolean }>();
  for (const r of rows) {
    const k = `${r.day}|${r.provider}|${r.currency}`;
    const d = daily.get(k) ?? { day: String(r.day), provider: r.provider as Provider, currency: String(r.currency), amount: 0 };
    d.amount = round6(d.amount + Number(r.amount));
    daily.set(k, d);
    const tk = `${r.provider}|${r.currency}`;
    const t = totals.get(tk) ?? { provider: r.provider as Provider, currency: String(r.currency), amount: 0, estimated: false };
    t.amount = round6(t.amount + Number(r.amount));
    t.estimated ||= !!Number(r.estimated);
    totals.set(tk, t);
  }

  // Cloud model calls priced at metering, this month.
  let tokens: SpendOverview['tokens'] = [];
  if (await s.db.schema.hasColumn('usage_records', 'cost_micros').catch(() => false)) {
    const q = s.db('usage_records').where({ month: y * 100 + m }).whereNotNull('cost_micros').whereNotNull('price_id');
    if (!s.cloud.accounts.isPlatformAdmin(p)) q.where({ tenant_id: p.tenantId });
    const got = (await q.groupBy('model', 'profile_id', 'currency', 'price_id').select('model', 'profile_id', 'currency', 'price_id').sum({ input: 'prompt_tokens', output: 'output_tokens', neurons: 'neurons', micros: 'cost_micros' }).count({ calls: '*' })) as { model: string; profile_id: string | null; currency: string | null; price_id: string; input: unknown; output: unknown; neurons: unknown; micros: unknown; calls: unknown }[];
    const provs = await providersOf(s, [...new Set(got.map((r) => String(r.price_id)))]);
    const profileIds = [...new Set(got.map((r) => r.profile_id).filter((x): x is string => !!x))];
    const profiles = profileIds.length ? new Map(((await s.db('profiles').whereIn('id', profileIds).select('id', 'name')) as { id: string; name: string }[]).map((r) => [String(r.id), String(r.name)])) : new Map<string, string>();
    const merged = new Map<string, SpendOverview['tokens'][number]>();
    for (const r of got) {
      const provider = provs.get(String(r.price_id)) ?? null;
      const k = `${r.model}|${r.profile_id ?? ''}|${r.currency ?? ''}|${provider ?? ''}`;
      const e = merged.get(k) ?? { model: String(r.model), provider, profileId: r.profile_id ?? null, profile: r.profile_id ? (profiles.get(r.profile_id) ?? null) : null, currency: String(r.currency ?? 'USD'), inputTokens: 0, outputTokens: 0, neurons: null, cost: 0, calls: 0 };
      e.inputTokens += Number(r.input ?? 0);
      e.outputTokens += Number(r.output ?? 0);
      if (r.neurons != null && Number(r.neurons) > 0) e.neurons = (e.neurons ?? 0) + Number(r.neurons);
      e.cost = round6(e.cost + Number(r.micros ?? 0) / 1e6);
      e.calls += Number(r.calls ?? 0);
      merged.set(k, e);
    }
    tokens = [...merged.values()].map((t) => ({ ...t, cost: round2(t.cost) })).sort((a, b) => b.cost - a.cost || a.model.localeCompare(b.model));
  }

  // Idle GPU hours avoided by scale-to-zero this month, and their estimated saving.
  const saved = await s.cloud.autoscale.savings(month).catch(() => []);
  const sv = new Map<string, { provider: Provider; currency: string; hours: number; saving: number | null }>();
  for (const r of saved) {
    const k = `${r.provider}|${r.currency}`;
    const e = sv.get(k) ?? { provider: r.provider, currency: r.currency, hours: 0, saving: null };
    e.hours = Math.round((e.hours + r.hours) * 1000) / 1000;
    if (r.saving != null) e.saving = round2((e.saving ?? 0) + r.saving);
    sv.set(k, e);
  }

  let anomaliesOpen: number | null = null;
  if (ids.length && (await s.cloud.anomalies.installed())) {
    const r = (await s.db('cloud_anomalies').whereIn('account_id', ids).where({ state: 'open' }).count({ n: '*' }).first()) as { n?: unknown } | undefined;
    anomaliesOpen = Number(r?.n ?? 0);
  }

  return {
    month,
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, provider: a.provider, scope: a.scope })),
    daily: [...daily.values()].map((d) => ({ ...d, amount: round2(d.amount) })).sort((a, b) => a.day.localeCompare(b.day) || a.provider.localeCompare(b.provider)),
    totals: [...totals.values()].map((t) => ({ ...t, amount: round2(t.amount) })).sort((a, b) => a.provider.localeCompare(b.provider) || a.currency.localeCompare(b.currency)),
    tokens,
    savings: [...sv.values()],
    anomaliesOpen
  };
}
