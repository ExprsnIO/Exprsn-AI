import { ulid } from 'ulid';
import { csvLine } from '../audit/exports.js';
import type { Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { HttpProblem } from '../http/problem.js';
import type { Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import type { CloudActor } from './accounts.js';
import { cloudAudit } from './audit.js';
import { TAG_PREFIX } from './tags.js';

/*
 * 1.9.99-final, Sprint 61 (B-10604): showback, `s.cloud.showback`.
 *
 * Every ingested cloud cost (`cloud_costs`, B-10603 and B-10608) of a month is shown back to the workspace and tenant
 * that caused it, per currency (open decision 17: never converted):
 *
 * 1. **Tags.** A row's tags are those of the resource it names (DigitalOcean and Cloudflare rows name one by its
 *    provider id), else the tags every resource of its deployment shares, plus the deployment's tenant (a
 *    tenant-scoped deployment) and the account's tenant (a tenant-scoped account). `exprsn:workspace` gives the
 *    workspace (method `tag`); `exprsn:pool` the gateway pool, whose cost is split among the workspaces that used it
 *    (method `pool`); `exprsn:tenant` alone the tenant, split among its workspaces (method `tenant`).
 * 2. **Shared costs** (no tag says whose: clusters, databases, the front door, Workers AI, billing adjustments) are
 *    split across all metered usage of the month (method `shared`) by the rule of the row's cost type: `gpu` (GPU
 *    node groups, pools), `model` (model APIs: Bedrock, Azure OpenAI, GenAI, Workers AI), `compute`, `database`,
 *    `storage`, `network` and `other`, each with a basis: `gpu_time` (usage_records.gpu_ms), `tokens` (prompt, output
 *    and thinking tokens), `model_cost` (usage_records.cost_micros in the row's currency, the per-model prices of
 *    B-10505), `requests` (metering records), `storage` (bytes in the file store), `even` or `unallocated`. A model
 *    cost is split only over the usage of the pools that hold that account's model instances, when there are any. A
 *    basis with nothing to weigh by falls back to `requests`; a tenant's cost with no usage at all is split evenly
 *    over its workspaces; whatever is left is the unallocated line.
 * 3. **Exact sums.** Splits are in millionths with the remainders handed out by size, so a month's showback across
 *    all workspaces (and tenant usage outside any workspace) plus the unallocated line equals the month's ingested
 *    total in each currency.
 *
 * Rules are the platform's (`cloud_allocation_rules`, migration 164_cloud_showback; `DEFAULT_RULES` otherwise). The
 * monthly rows are stored in `cloud_showback` by the daily `cloud.showback.compute` job (this month and the last) and by
 * "compute now"; a month never computed is computed on request and not stored. A tenant may put its showback on its
 * B-13 statements as informational lines (`cloud_showback_settings`, default off), never in the statement's total.
 */

const DAY = 86_400_000;
export const COST_TYPES = ['gpu', 'model', 'compute', 'database', 'storage', 'network', 'other'] as const;
export type CostType = (typeof COST_TYPES)[number];
export const BASES = ['gpu_time', 'tokens', 'model_cost', 'requests', 'storage', 'even', 'unallocated'] as const;
export type Basis = (typeof BASES)[number];
export type Method = 'tag' | 'pool' | 'tenant' | 'shared' | 'unallocated';

/** The built-in rule per cost type (what a platform without its own rules uses). */
export const DEFAULT_RULES: Record<CostType, Basis> = { gpu: 'gpu_time', model: 'model_cost', compute: 'requests', database: 'storage', storage: 'storage', network: 'requests', other: 'requests' };

export const COST_TYPE_NAMES: Record<CostType, string> = { gpu: 'GPU time', model: 'Model APIs', compute: 'Compute and clusters', database: 'Databases and caches', storage: 'Object storage', network: 'Network and front door', other: 'Other' };
export const BASIS_NAMES: Record<Basis, string> = { gpu_time: 'GPU time', tokens: 'Tokens', model_cost: 'Model cost', requests: 'Requests', storage: 'Storage used', even: 'Evenly', unallocated: 'Leave unallocated' };

const TABLES = ['cloud_allocation_rules', 'cloud_showback', 'cloud_showback_settings'] as const;

export const showbackMissing = () => new HttpProblem(503, 'Not installed', 'Showback rules and settings need the database migration 164_cloud_showback, which has not been applied.', { extensions: { reason: 'migration_pending' } });

export interface ShowbackLine {
  tenantId: string | null;
  workspaceId: string | null;
  currency: string;
  costType: CostType;
  method: Method;
  amount: number;
}

export interface ShowbackReport {
  month: string;
  computedAt: number;
  /** Read from stored rows (true) or computed for this request (false). */
  stored: boolean;
  rules: { costType: CostType; name: string; basis: Basis; default: boolean }[];
  /** Per currency: the month's ingested total, what is shown back to workspaces and tenants, and the unallocated rest. */
  currencies: { currency: string; ingested: number; allocated: number; unallocated: number }[];
  tenants: { tenantId: string; name: string; currency: string; amount: number; workspaces: { workspaceId: string | null; name: string; amount: number; byType: Partial<Record<CostType, number>> }[] }[];
  unallocated: { currency: string; amount: number; byType: Partial<Record<CostType, number>> }[];
  lines: ShowbackLine[];
}

interface CostIn {
  accountId: string;
  provider: string;
  deploymentId: string | null;
  allocation: string;
  service: string;
  currency: string;
  micros: number;
}

interface UsageAgg {
  tenantId: string;
  workspaceId: string | null;
  poolId: string | null;
  requests: number;
  tokens: number;
  gpuMs: number;
  cost: Record<string, number>;
}

const SERVICE_TYPES: [RegExp, CostType][] = [
  [/gpu|accelerat|inferentia|trainium/i, 'gpu'],
  [/bedrock|openai|cognitive|genai|gen ai|workers ai|foundry|sagemaker|machine learning/i, 'model'],
  [/rds|database|sql|aurora|dynamo|cosmos|redis|cache|elasticache|valkey|d1\b|hyperdrive|postgres|mysql/i, 'database'],
  [/s3|storage|blob|spaces|\br2\b|glacier|backup|snapshot/i, 'storage'],
  [/cloudfront|front ?door|load ?balanc|\bdns\b|route 53|\bnat\b|data transfer|bandwidth|egress|tunnel|vpc|virtual network|waf|cdn|zone/i, 'network'],
  [/ec2|compute|kubernetes|eks|aks|doks|container|droplet|app platform|workers|lambda|functions|virtual machine/i, 'compute']
];
const RESOURCE_TYPES: Record<string, CostType> = { kubernetes_cluster: 'compute', vm: 'compute', container_service: 'compute', node_group: 'compute', database: 'database', cache: 'database', bucket: 'storage', dns_record: 'network', load_balancer: 'network', tunnel: 'network', firewall: 'network', network: 'network', subnet: 'network', secret: 'other' };

/** The cost type of a row: GPU when a pool is named, else the resource's type, else the provider's service name. */
export function costTypeOf(service: string, resourceType: string | null, tags: Record<string, string>): CostType {
  if (tags[`${TAG_PREFIX}pool`]) return 'gpu';
  for (const [re, t] of SERVICE_TYPES) if (t === 'gpu' && re.test(service)) return 'gpu';
  if (resourceType && RESOURCE_TYPES[resourceType]) return RESOURCE_TYPES[resourceType]!;
  for (const [re, t] of SERVICE_TYPES) if (re.test(service)) return t;
  return 'other';
}

/**
 * Splits `micros` over the weights in proportion, in whole millionths, the remainders handed out by size (ties by
 * key), so the parts add up to the amount exactly. Negative amounts (credits) split the same way.
 */
export function splitMicros(micros: number, weights: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  const entries = [...weights.entries()].filter(([, w]) => w > 0).sort((a, b) => a[0].localeCompare(b[0]));
  const total = entries.reduce((n, [, w]) => n + w, 0);
  if (!entries.length || !(total > 0)) return out;
  const sign = micros < 0 ? -1 : 1;
  const abs = Math.abs(micros);
  let given = 0;
  const rest: { k: string; r: number }[] = [];
  for (const [k, w] of entries) {
    const exact = (abs * w) / total;
    const floor = Math.floor(exact);
    out.set(k, floor);
    given += floor;
    rest.push({ k, r: exact - floor });
  }
  rest.sort((a, b) => b.r - a.r || a.k.localeCompare(b.k));
  for (let i = 0; i < abs - given; i++) out.set(rest[i % rest.length]!.k, out.get(rest[i % rest.length]!.k)! + 1);
  if (sign < 0) for (const [k, v] of out) out.set(k, -v);
  for (const [k, v] of out) if (v === 0) out.delete(k);
  return out;
}

const toMicros = (n: number) => Math.round(n * 1e6);
const fromMicros = (m: number) => Math.round(m) / 1e6;
export const monthKey = (t: number) => new Date(t).toISOString().slice(0, 7);
const monthBounds = (m: string) => {
  const start = Date.parse(`${m}-01T00:00:00Z`);
  const end = Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth() + 1, 1);
  return { from: `${m}-01`, to: new Date(end).toISOString().slice(0, 10), start, end };
};
const wsKey = (tenantId: string, workspaceId: string | null) => `${tenantId}|${workspaceId ?? ''}`;
const fromWsKey = (k: string) => {
  const [t, w] = k.split('|');
  return { tenantId: t!, workspaceId: w ? w : null };
};

export class CloudShowback {
  private schema: { ok: boolean; at: number } | null = null;

  constructor(
    private readonly s: () => Services,
    private readonly o: { now?: () => number } = {}
  ) {}

  private get db() {
    return this.s().db;
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** True once migration 164 is applied (rules, stored rows and settings). */
  async installed(): Promise<boolean> {
    const t = Date.now();
    if (this.schema && (this.schema.ok || t - this.schema.at < 30_000)) return this.schema.ok;
    let ok = true;
    try {
      for (const name of TABLES) if (!(await this.db.schema.hasTable(name))) ok = false;
    } catch {
      ok = false;
    }
    this.schema = { ok, at: t };
    return ok;
  }

  resetSchemaCache(): void {
    this.schema = null;
  }

  /** Showback reads the ingested costs (migration 155). */
  async need(): Promise<void> {
    await this.s().cloud.costs.need();
  }

  // ---------- rules ----------

  async rules(): Promise<Record<CostType, Basis>> {
    const out = { ...DEFAULT_RULES };
    if (!(await this.installed())) return out;
    for (const r of (await this.db('cloud_allocation_rules').select('cost_type', 'basis')) as { cost_type: string; basis: string }[]) {
      if ((COST_TYPES as readonly string[]).includes(r.cost_type) && (BASES as readonly string[]).includes(r.basis)) out[r.cost_type as CostType] = r.basis as Basis;
    }
    return out;
  }

  async ruleView(): Promise<ShowbackReport['rules']> {
    const r = await this.rules();
    return COST_TYPES.map((t) => ({ costType: t, name: COST_TYPE_NAMES[t], basis: r[t], default: r[t] === DEFAULT_RULES[t] }));
  }

  /** Sets the platform's rules (finops:manage and platform:manage); a type set to its default keeps no row. */
  async setRules(a: CloudActor, rules: Partial<Record<CostType, Basis>>): Promise<ShowbackReport['rules']> {
    if (!this.s().cloud.accounts.isPlatformAdmin(a.principal)) throw new HttpProblem(403, 'Forbidden', 'Allocation rules are the platform\'s; changing them needs platform:manage.', { extensions: { step: 'role', action: 'platform:manage' } });
    if (!(await this.installed())) throw showbackMissing();
    const before = await this.rules();
    const now = this.now();
    await this.db.transaction(async (trx) => {
      for (const [t, b] of Object.entries(rules) as [CostType, Basis][]) {
        await trx('cloud_allocation_rules').where({ cost_type: t }).del();
        if (b !== DEFAULT_RULES[t]) await trx('cloud_allocation_rules').insert({ cost_type: t, basis: b, updated_by: a.principal.userId, updated_at: now });
      }
    });
    const after = await this.rules();
    const changed = COST_TYPES.filter((t) => before[t] !== after[t]);
    await cloudAudit(this.s(), { tenantId: a.principal.tenantId, action: 'cloud.showback.rules.updated', actor: a, detail: { changed: Object.fromEntries(changed.map((t) => [t, { before: before[t], after: after[t] }])) } });
    return this.ruleView();
  }

  // ---------- the tenant setting: showback lines on statements ----------

  async statementLinesOn(tenantId: string): Promise<boolean> {
    if (!(await this.installed())) return false;
    const r = (await this.db('cloud_showback_settings').where({ tenant_id: tenantId }).first('statement_lines')) as { statement_lines?: unknown } | undefined;
    return !!Number(r?.statement_lines ?? 0);
  }

  async setStatementLines(a: CloudActor, tenantId: string, on: boolean): Promise<{ tenantId: string; statementLines: boolean }> {
    if (!(await this.installed())) throw showbackMissing();
    const before = await this.statementLinesOn(tenantId);
    const now = this.now();
    await this.db.transaction(async (trx) => {
      await trx('cloud_showback_settings').where({ tenant_id: tenantId }).del();
      await trx('cloud_showback_settings').insert({ tenant_id: tenantId, statement_lines: on, updated_by: a.principal.userId, updated_at: now });
    });
    if (before !== on) await cloudAudit(this.s(), { tenantId, action: 'cloud.showback.settings.updated', actor: a, detail: { statementLines: { before, after: on } } });
    return { tenantId, statementLines: on };
  }

  // ---------- compute ----------

  /** Computes a month's showback lines from its ingested costs and the month's usage. */
  async compute(month: string): Promise<ShowbackLine[]> {
    const b = monthBounds(month);
    const db = this.db;
    const rules = await this.rules();
    const costs = ((await db('cloud_costs').where('day', '>=', b.from).where('day', '<', b.to).select('account_id', 'provider', 'deployment_id', 'allocation', 'service', 'currency', 'amount')) as Record<string, unknown>[]).map(
      (r): CostIn => ({ accountId: String(r.account_id), provider: String(r.provider), deploymentId: (r.deployment_id as string | null) ?? null, allocation: String(r.allocation ?? ''), service: String(r.service ?? ''), currency: String(r.currency), micros: toMicros(Number(r.amount)) })
    );
    if (!costs.length) return [];

    // The resources, deployments and accounts the rows name.
    const accountIds = [...new Set(costs.map((c) => c.accountId))];
    const accounts = new Map(((await db('cloud_accounts').whereIn('id', accountIds).select('id', 'scope', 'tenant_id').catch(() => [])) as { id: string; scope: string; tenant_id: string | null }[]).map((a) => [a.id, a]));
    const deps = new Map(((await db('cloud_deployments').whereIn('account_id', accountIds).select('id', 'account_id', 'tenant_id', 'scope').catch(() => [])) as { id: string; account_id: string; tenant_id: string; scope: string }[]).map((d) => [d.id, d]));
    const resRows = (await db('cloud_resources as r').join('cloud_deployments as d', 'd.id', 'r.deployment_id').whereIn('d.account_id', accountIds).select('r.deployment_id', 'r.provider_id', 'r.type', 'r.tags', 'd.account_id').catch(() => [])) as { deployment_id: string; provider_id: string | null; type: string; tags: unknown; account_id: string }[];
    const byProviderId = new Map<string, { type: string; tags: Record<string, string> }>();
    const depTags = new Map<string, Record<string, string>[]>();
    for (const r of resRows) {
      const tags = json<Record<string, string>>(r.tags, {});
      if (r.provider_id) byProviderId.set(`${r.account_id}|${r.provider_id}`, { type: r.type, tags });
      const list = depTags.get(r.deployment_id) ?? [];
      list.push(tags);
      depTags.set(r.deployment_id, list);
    }
    const sharedTags = (deploymentId: string): Record<string, string> => {
      const list = depTags.get(deploymentId) ?? [];
      const out: Record<string, string> = {};
      if (!list.length) return out;
      for (const k of ['tenant', 'workspace', 'pool']) {
        const key = `${TAG_PREFIX}${k}`;
        const v = list[0]![key];
        if (v && list.every((t) => t[key] === v)) out[key] = v;
      }
      return out;
    };

    // Workspaces, tenants and pools, to resolve tag values (ids, else names).
    const workspaces = (await db('workspaces').select('id', 'tenant_id', 'name')) as { id: string; tenant_id: string; name: string }[];
    const wsById = new Map(workspaces.map((w) => [w.id, w]));
    const wsByName = new Map(workspaces.map((w) => [`${w.tenant_id}|${w.name.toLowerCase()}`, w]));
    const tenantIds = new Set(((await db('tenants').select('id')) as { id: string }[]).map((t) => t.id));
    const pools = (await db('pools').select('id', 'name').catch(() => [])) as { id: string; name: string }[];
    const poolOf = (v: string) => pools.find((p) => p.id === v || p.name.toLowerCase() === v.toLowerCase())?.id ?? null;
    const instances = await this.s().gateway.repo.instances().catch(() => []);
    const modelPools = new Map<string, Set<string>>();
    for (const i of instances) {
      const acct = i.settings.cloud?.accountId;
      if (!acct) continue;
      const set = modelPools.get(acct) ?? new Set<string>();
      set.add(i.pool_id);
      modelPools.set(acct, set);
    }

    // The month's usage by tenant, workspace and pool; storage by workspace.
    const usage = await this.usageOf(month);
    const storage = await this.storageOf();

    type Scope = { tenantId?: string; pools?: Set<string> };
    const weights = (basis: Basis, currency: string, scope: Scope): Map<string, number> => {
      const m = new Map<string, number>();
      const pick = (u: UsageAgg) => (!scope.tenantId || u.tenantId === scope.tenantId) && (!scope.pools || (u.poolId != null && scope.pools.has(u.poolId)));
      const add = (k: string, w: number) => w > 0 && m.set(k, (m.get(k) ?? 0) + w);
      if (basis === 'storage') {
        for (const [k, bytes] of storage) if (!scope.tenantId || fromWsKey(k).tenantId === scope.tenantId) add(k, bytes);
      } else if (basis === 'even') {
        for (const w of workspaces) if (!scope.tenantId || w.tenant_id === scope.tenantId) add(wsKey(w.tenant_id, w.id), 1);
      } else if (basis !== 'unallocated') {
        for (const u of usage) {
          if (!pick(u)) continue;
          const w = basis === 'gpu_time' ? u.gpuMs : basis === 'tokens' ? u.tokens : basis === 'model_cost' ? (u.cost[currency] ?? 0) : u.requests;
          add(wsKey(u.tenantId, u.workspaceId), w);
        }
      }
      return m;
    };
    /** The weights for a basis, falling back to tokens (model cost), then requests, then (tenant scope) evenly. */
    const weigh = (basis: Basis, currency: string, scope: Scope): Map<string, number> => {
      if (basis === 'unallocated') return new Map();
      let m = weights(basis, currency, scope);
      if (!m.size && basis === 'model_cost') m = weights('tokens', currency, scope);
      if (!m.size && basis !== 'requests' && basis !== 'even') m = weights('requests', currency, scope);
      if (!m.size && scope.pools) return weigh(basis, currency, { ...(scope.tenantId ? { tenantId: scope.tenantId } : {}) });
      if (!m.size && scope.tenantId) m = weights('even', currency, { tenantId: scope.tenantId });
      return m;
    };

    const lines = new Map<string, ShowbackLine & { micros: number }>();
    const put = (tenantId: string | null, workspaceId: string | null, currency: string, costType: CostType, method: Method, micros: number) => {
      if (!micros) return;
      const k = `${tenantId ?? ''}|${workspaceId ?? ''}|${currency}|${costType}|${method}`;
      const had = lines.get(k) ?? { tenantId, workspaceId, currency, costType, method, amount: 0, micros: 0 };
      had.micros += micros;
      lines.set(k, had);
    };
    const spread = (c: CostIn, costType: CostType, method: Method, w: Map<string, number>, fallbackTenant: string | null) => {
      const parts = splitMicros(c.micros, w);
      if (!parts.size) {
        // Nothing to weigh by: a tenant's cost stays the tenant's (outside any workspace); a shared one is unallocated.
        if (fallbackTenant) put(fallbackTenant, null, c.currency, costType, 'tenant', c.micros);
        else put(null, null, c.currency, costType, 'unallocated', c.micros);
        return;
      }
      for (const [k, v] of parts) {
        const { tenantId, workspaceId } = fromWsKey(k);
        put(tenantId, workspaceId, c.currency, costType, method, v);
      }
    };

    for (const c of costs) {
      const res = c.allocation ? byProviderId.get(`${c.accountId}|${c.allocation}`) : undefined;
      const dep = c.deploymentId ? deps.get(c.deploymentId) : undefined;
      const tags: Record<string, string> = { ...(dep ? sharedTags(dep.id) : {}), ...(res?.tags ?? {}) };
      const acct = accounts.get(c.accountId);
      const tagTenant = tags[`${TAG_PREFIX}tenant`];
      const tenantId = (tagTenant && tenantIds.has(tagTenant) ? tagTenant : null) ?? (dep?.scope === 'tenant' ? dep.tenant_id : null) ?? (acct?.scope === 'tenant' ? acct.tenant_id : null);
      const costType = costTypeOf(c.service, res?.type ?? null, tags);
      const basis = rules[costType];
      const wsTag = tags[`${TAG_PREFIX}workspace`];
      const ws = wsTag ? (wsById.get(wsTag) ?? (tenantId ? wsByName.get(`${tenantId}|${wsTag.toLowerCase()}`) : undefined)) : undefined;
      if (ws && (!tenantId || ws.tenant_id === tenantId)) {
        put(ws.tenant_id, ws.id, c.currency, costType, 'tag', c.micros);
        continue;
      }
      const poolTag = tags[`${TAG_PREFIX}pool`];
      const pool = poolTag ? poolOf(poolTag) : null;
      if (pool) {
        spread(c, costType, 'pool', weigh(basis === 'unallocated' ? 'gpu_time' : basis, c.currency, { pools: new Set([pool]), ...(tenantId ? { tenantId } : {}) }), tenantId);
        continue;
      }
      const scope: Scope = { ...(tenantId ? { tenantId } : {}), ...(costType === 'model' && modelPools.get(c.accountId)?.size ? { pools: modelPools.get(c.accountId)! } : {}) };
      if (tenantId) {
        spread(c, costType, 'tenant', weigh(basis === 'unallocated' ? 'even' : basis, c.currency, scope), tenantId);
        continue;
      }
      spread(c, costType, basis === 'unallocated' ? 'unallocated' : 'shared', weigh(basis, c.currency, scope), null);
    }
    return [...lines.values()].map(({ micros, ...l }) => ({ ...l, amount: fromMicros(micros) })).sort((a, b) => (a.tenantId ?? '~').localeCompare(b.tenantId ?? '~') || (a.workspaceId ?? '~').localeCompare(b.workspaceId ?? '~') || a.currency.localeCompare(b.currency) || a.costType.localeCompare(b.costType) || a.method.localeCompare(b.method));
  }

  private async usageOf(month: string): Promise<UsageAgg[]> {
    const m = Number(month.replace('-', ''));
    const rows = (await this.db('usage_records')
      .where({ month: m })
      .groupBy('tenant_id', 'workspace_id', 'pool_id')
      .select('tenant_id', 'workspace_id', 'pool_id')
      .count({ n: '*' })
      .sum({ p: 'prompt_tokens', o: 'output_tokens', t: 'thinking_tokens', g: 'gpu_ms' })) as Record<string, unknown>[];
    const out = new Map<string, UsageAgg>();
    const key = (r: Record<string, unknown>) => `${String(r.tenant_id)}|${(r.workspace_id as string | null) ?? ''}|${(r.pool_id as string | null) ?? ''}`;
    for (const r of rows) out.set(key(r), { tenantId: String(r.tenant_id), workspaceId: (r.workspace_id as string | null) ?? null, poolId: (r.pool_id as string | null) ?? null, requests: Number(r.n ?? 0), tokens: Number(r.p ?? 0) + Number(r.o ?? 0) + Number(r.t ?? 0), gpuMs: Number(r.g ?? 0), cost: {} });
    if (await this.db.schema.hasColumn('usage_records', 'cost_micros').catch(() => false)) {
      const priced = (await this.db('usage_records').where({ month: m }).whereNotNull('cost_micros').whereNotNull('currency').groupBy('tenant_id', 'workspace_id', 'pool_id', 'currency').select('tenant_id', 'workspace_id', 'pool_id', 'currency').sum({ c: 'cost_micros' })) as Record<string, unknown>[];
      for (const r of priced) {
        const u = out.get(key(r));
        if (u) u.cost[String(r.currency).toUpperCase()] = (u.cost[String(r.currency).toUpperCase()] ?? 0) + Number(r.c ?? 0);
      }
    }
    return [...out.values()];
  }

  /** Bytes in the file store per workspace (not in the trash), as the storage basis. */
  private async storageOf(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const rows = (await this.db('files').whereNull('trashed_at').groupBy('tenant_id', 'workspace_id').select('tenant_id', 'workspace_id').sum({ b: 'size' }).catch(() => [])) as Record<string, unknown>[];
    for (const r of rows) if (Number(r.b ?? 0) > 0) out.set(wsKey(String(r.tenant_id), String(r.workspace_id)), Number(r.b));
    return out;
  }

  /** Computes a month and stores its rows (replacing what was stored); without migration 164, computes only. */
  async computeAndStore(month: string): Promise<{ month: string; lines: number; stored: boolean }> {
    const lines = await this.compute(month);
    if (!(await this.installed())) return { month, lines: lines.length, stored: false };
    const now = this.now();
    await this.db.transaction(async (trx) => {
      await trx('cloud_showback').where({ month }).del();
      const rows = lines.map((l) => ({ id: ulid(), month, tenant_id: l.tenantId, workspace_id: l.workspaceId, currency: l.currency, cost_type: l.costType, method: l.method, amount: String(l.amount), computed_at: now }));
      for (let i = 0; i < rows.length; i += 100) await trx('cloud_showback').insert(rows.slice(i, i + 100));
    });
    return { month, lines: lines.length, stored: true };
  }

  /** The month's lines: stored when the month was computed, else computed now (and not stored). */
  async linesFor(month: string): Promise<{ lines: ShowbackLine[]; stored: boolean; computedAt: number }> {
    if (await this.installed()) {
      const rows = (await this.db('cloud_showback').where({ month })) as Record<string, unknown>[];
      if (rows.length) return { stored: true, computedAt: Math.max(...rows.map((r) => Number(r.computed_at))), lines: rows.map((r) => ({ tenantId: (r.tenant_id as string | null) ?? null, workspaceId: (r.workspace_id as string | null) ?? null, currency: String(r.currency), costType: r.cost_type as CostType, method: r.method as Method, amount: Number(r.amount) })) };
    }
    return { stored: false, computedAt: this.now(), lines: await this.compute(month) };
  }

  // ---------- reads ----------

  /** A month's showback for a principal: every tenant and the unallocated line for platform readers, else their own tenant only. */
  async report(p: Principal, month: string, o: { tenantId?: string } = {}): Promise<ShowbackReport> {
    await this.need();
    const platform = this.s().cloud.accounts.isPlatformAdmin(p);
    const only = platform ? (o.tenantId ?? null) : p.tenantId;
    if (!platform && o.tenantId && o.tenantId !== p.tenantId) throw new HttpProblem(403, 'Forbidden', 'The showback of another tenant is for platform admins.', { extensions: { step: 'tenant' } });
    const { lines, stored, computedAt } = await this.linesFor(month);
    const b = monthBounds(month);
    const ingested = new Map<string, number>();
    // Amounts are decimals kept as text, so they are summed here (in millionths), not by the database.
    for (const r of (await this.db('cloud_costs').where('day', '>=', b.from).where('day', '<', b.to).select('currency', 'amount')) as { currency: string; amount: unknown }[]) ingested.set(String(r.currency), (ingested.get(String(r.currency)) ?? 0) + toMicros(Number(r.amount)));
    const names = await this.names(lines);
    const seen = lines.filter((l) => (only ? l.tenantId === only : true));
    const tenants = new Map<string, ShowbackReport['tenants'][number]>();
    const unalloc = new Map<string, ShowbackReport['unallocated'][number]>();
    const add = (o: Partial<Record<CostType, number>>, t: CostType, v: number) => (o[t] = fromMicros(toMicros(o[t] ?? 0) + toMicros(v)));
    for (const l of seen) {
      if (!l.tenantId) {
        const u = unalloc.get(l.currency) ?? { currency: l.currency, amount: 0, byType: {} };
        u.amount = fromMicros(toMicros(u.amount) + toMicros(l.amount));
        add(u.byType, l.costType, l.amount);
        unalloc.set(l.currency, u);
        continue;
      }
      const k = `${l.tenantId}|${l.currency}`;
      const t = tenants.get(k) ?? { tenantId: l.tenantId, name: names.tenants.get(l.tenantId) ?? l.tenantId, currency: l.currency, amount: 0, workspaces: [] };
      t.amount = fromMicros(toMicros(t.amount) + toMicros(l.amount));
      let w = t.workspaces.find((x) => x.workspaceId === l.workspaceId);
      if (!w) {
        w = { workspaceId: l.workspaceId, name: l.workspaceId ? (names.workspaces.get(l.workspaceId) ?? l.workspaceId) : 'Outside any workspace', amount: 0, byType: {} };
        t.workspaces.push(w);
      }
      w.amount = fromMicros(toMicros(w.amount) + toMicros(l.amount));
      add(w.byType, l.costType, l.amount);
      tenants.set(k, t);
    }
    const currencies = only
      ? [...new Set(seen.map((l) => l.currency))].sort().map((c) => {
          const allocated = fromMicros(seen.filter((l) => l.currency === c).reduce((n, l) => n + toMicros(l.amount), 0));
          return { currency: c, ingested: allocated, allocated, unallocated: 0 };
        })
      : [...new Set([...ingested.keys(), ...lines.map((l) => l.currency)])].sort().map((c) => {
          const allocated = fromMicros(lines.filter((l) => l.currency === c && l.tenantId).reduce((n, l) => n + toMicros(l.amount), 0));
          const un = fromMicros(lines.filter((l) => l.currency === c && !l.tenantId).reduce((n, l) => n + toMicros(l.amount), 0));
          return { currency: c, ingested: fromMicros(ingested.get(c) ?? 0), allocated, unallocated: un };
        });
    for (const t of tenants.values()) t.workspaces.sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
    return { month, computedAt, stored, rules: await this.ruleView(), currencies, tenants: [...tenants.values()].sort((a, b) => a.name.localeCompare(b.name) || a.currency.localeCompare(b.currency)), unallocated: only ? [] : [...unalloc.values()], lines: seen };
  }

  private async names(lines: ShowbackLine[]): Promise<{ tenants: Map<string, string>; workspaces: Map<string, string> }> {
    const t = [...new Set(lines.map((l) => l.tenantId).filter((x): x is string => !!x))];
    const w = [...new Set(lines.map((l) => l.workspaceId).filter((x): x is string => !!x))];
    const tenants = new Map(((t.length ? await this.db('tenants').whereIn('id', t).select('id', 'name') : []) as { id: string; name: string }[]).map((r) => [r.id, r.name]));
    const workspaces = new Map(((w.length ? await this.db('workspaces').whereIn('id', w).select('id', 'name') : []) as { id: string; name: string }[]).map((r) => [r.id, r.name]));
    return { tenants, workspaces };
  }

  /** The report as CSV: one line per tenant, workspace, currency, cost type and method, the unallocated lines, totals per currency. */
  async csv(p: Principal, month: string, o: { tenantId?: string } = {}): Promise<string> {
    const r = await this.report(p, month, o);
    const names = await this.names(r.lines);
    let out = csvLine(['month', 'tenant_id', 'tenant', 'workspace_id', 'workspace', 'currency', 'cost_type', 'method', 'amount']);
    for (const l of r.lines) out += csvLine([month, l.tenantId ?? '', l.tenantId ? (names.tenants.get(l.tenantId) ?? '') : 'Unallocated', l.workspaceId ?? '', l.workspaceId ? (names.workspaces.get(l.workspaceId) ?? '') : '', l.currency, l.costType, l.method, l.amount.toFixed(6)]);
    for (const c of r.currencies) out += csvLine([month, '', 'Total', '', '', c.currency, '', 'total', (c.allocated + c.unallocated).toFixed(6)]);
    return out;
  }

  /**
   * The informational showback lines for a tenant's B-13 statement of a month (YYYYMM), or null when the tenant has
   * not turned them on (the default), migration 164 is missing, or there is nothing to show. Never part of the total.
   */
  async statementSection(tenantId: string, month: number): Promise<{ note: string; month: string; lines: { workspaceId: string | null; workspace: string; costType: CostType; description: string; amount: number; currency: string }[]; totals: Record<string, number> } | null> {
    if (!(await this.statementLinesOn(tenantId))) return null;
    if (!(await this.s().cloud.costs.installed())) return null;
    const m = `${String(month).slice(0, 4)}-${String(month).slice(4, 6)}`;
    const { lines } = await this.linesFor(m);
    const own = lines.filter((l) => l.tenantId === tenantId);
    if (!own.length) return null;
    const names = await this.names(own);
    const grouped = new Map<string, { workspaceId: string | null; workspace: string; costType: CostType; description: string; micros: number; currency: string }>();
    for (const l of own) {
      const k = `${l.workspaceId ?? ''}|${l.costType}|${l.currency}`;
      const workspace = l.workspaceId ? (names.workspaces.get(l.workspaceId) ?? l.workspaceId) : 'Outside any workspace';
      const g = grouped.get(k) ?? { workspaceId: l.workspaceId, workspace, costType: l.costType, description: `Cloud showback: ${workspace}, ${COST_TYPE_NAMES[l.costType]}`, micros: 0, currency: l.currency };
      g.micros += toMicros(l.amount);
      grouped.set(k, g);
    }
    const totals: Record<string, number> = {};
    const out = [...grouped.values()].map(({ micros, ...g }) => {
      totals[g.currency] = fromMicros(toMicros(totals[g.currency] ?? 0) + micros);
      return { ...g, amount: fromMicros(micros) };
    });
    return { note: 'Shown back for information: the cloud costs this tenant caused. They are not charged and not part of the statement\'s total.', month: m, lines: out.sort((a, b) => a.workspace.localeCompare(b.workspace) || a.costType.localeCompare(b.costType)), totals };
  }

  /** The statement's CSV with the showback section appended (only when the section exists). */
  static appendCsv(csv: string, section: NonNullable<Awaited<ReturnType<CloudShowback['statementSection']>>>): string {
    let out = `${csv}${csvLine([])}${csvLine(['showback', section.note])}${csvLine(['showback_workspace', 'cost_type', 'description', 'amount', 'currency'])}`;
    for (const l of section.lines) out += csvLine([l.workspace, l.costType, l.description, l.amount.toFixed(6), l.currency]);
    return out;
  }

  // ---------- jobs ----------

  /** "Compute now": recomputes and stores a month (finops:manage and platform:manage). */
  async computeNow(a: CloudActor, month: string): Promise<{ month: string; lines: number; stored: boolean }> {
    await this.need();
    if (!this.s().cloud.accounts.isPlatformAdmin(a.principal)) throw new HttpProblem(403, 'Forbidden', 'Computing the platform\'s showback needs platform:manage.', { extensions: { step: 'role', action: 'platform:manage' } });
    const r = await this.computeAndStore(month);
    await cloudAudit(this.s(), { tenantId: a.principal.tenantId, action: 'cloud.showback.computed', actor: a, detail: r });
    return r;
  }

  registerJobs(): void {
    this.s().jobs.register('cloud.showback.compute', async (p, ctx) => {
      const now = this.now();
      const months = p.month ? [String(p.month)] : [monthKey(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1) - DAY), monthKey(now)];
      const out = [];
      for (const m of months) out.push(await this.computeAndStore(m));
      await ctx.progress(100, out.map((o) => `${o.month}: ${o.lines} lines`).join(', '));
      return { months: out };
    });
  }

  /** Daily, once ingested costs exist: this month and the last are recomputed and stored. */
  schedule(scheduler: Scheduler): void {
    scheduler.every('cloud.showback.compute', DAY, async () => {
      if (!(await this.installed()) || !(await this.s().cloud.costs.installed())) return [];
      const any = await this.db('cloud_costs').first('id').catch(() => null);
      if (!any) return [];
      const t = await this.s().tenants.bySlug(this.s().cfg.DEFAULT_TENANT);
      return t ? [{ tenantId: t.id, payload: {} }] : [];
    });
  }
}
