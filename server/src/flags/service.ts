import { ulid } from 'ulid';
import { isUniqueViolation, type AuditActor } from '../audit/chain.js';
import { permissionsFor } from '../authz/permissions.js';
import { json } from '../db/knex.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import {
  BUILTIN_FLAGS,
  evaluate,
  isOn,
  NEXT_STATES,
  optionsProblem,
  staleWarnings,
  valueProblem,
  type EvalContext,
  type Evaluation,
  type FlagDef,
  type FlagOptions,
  type FlagState,
  type FlagType,
  type FlagValue,
  type Level,
  type LevelValue,
  type RolloutBy,
  type StaleWarning
} from './model.js';

/*
 * 1.9.0, Sprint 52 (B-167 to B-169): feature flags, `s.flags`.
 *
 * Reading (`on`, `value`, `evaluate`, `forClient`) is cached in memory: the definitions with their platform and plan
 * values for 30 seconds, and per tenant its plan (from `s.subscriptions.at`) with its tenant and workspace values for
 * 30 seconds. Every change publishes `feature.flags` on the bus, and each instance drops what it cached (one tenant's
 * entry, or everything); a subscription change (audited `billing.subscription.*`) or an approved plan version drops
 * the tenant's plan, so a plan move reaches flags at once.
 *
 * Writing: definitions, life cycle, plan values and platform values are for platform admins (the routes ask
 * `platform:manage`); a live flag's (active or deprecated) platform default and platform rollout change only through
 * a proposal a second platform admin approves (dual control); a planned flag's change applies at once. Tenant and
 * workspace values are for the tenant's admins (`tenant:manage`), for their own tenant only, and only on flags that
 * are overridable. Every change is audited `flag.*` (label internal).
 *
 * Until migration `137_feature_flags` is applied, every flag answers its built-in default, the admin reads say the
 * flags are unavailable, and writes answer 503.
 */

export const FLAGS_TOPIC = 'feature.flags';
const TTL_MS = 30_000;
const SCHEMA_RECHECK_MS = 30_000;

export interface FlagActor {
  tenantId: string;
  userId: string;
  actor: AuditActor;
  traceId?: string;
}

export interface FlagInput {
  key: string;
  type: FlagType;
  defaultValue: FlagValue;
  options?: FlagOptions;
  description?: string;
  owner?: string;
  state?: 'planned' | 'active';
  reviewAt?: number | null;
  client?: boolean;
  overridable?: boolean;
  rolloutBy?: RolloutBy;
}

export interface FlagPatch {
  description?: string;
  owner?: string;
  reviewAt?: number | null;
  client?: boolean;
  overridable?: boolean;
  rolloutBy?: RolloutBy;
  options?: FlagOptions;
}

/** A change to a flag's platform level: its default, and its platform value with rollout (null clears it). */
export interface PlatformChange {
  defaultValue?: FlagValue;
  platform?: { value: FlagValue; rollout: number | null } | null;
}

export interface ProposalRow {
  id: string;
  flagKey: string;
  change: PlatformChange;
  reason: string | null;
  state: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'superseded';
  proposedBy: string;
  proposedTenant: string;
  proposedAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  note: string | null;
}

interface GlobalSnapshot {
  at: number;
  defs: Map<string, FlagDef>;
  platform: Map<string, LevelValue>;
  /** plan key → flag key → value */
  plans: Map<string, Map<string, LevelValue>>;
}

interface TenantSnapshot {
  at: number;
  plan: { key: string; entitlements: Record<string, FlagValue> } | null;
  tenant: Map<string, LevelValue>;
  /** workspace id → flag key → value */
  workspaces: Map<string, Map<string, LevelValue>>;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function defFromRow(r: Record<string, unknown>): FlagDef {
  return {
    key: String(r.key),
    type: r.type as FlagType,
    defaultValue: json<FlagValue>(r.default_value, false),
    options: json<FlagOptions>(r.options, {}),
    description: String(r.description ?? ''),
    owner: String(r.owner ?? ''),
    state: r.state as FlagState,
    stateChangedAt: Number(r.state_changed_at),
    reviewAt: num(r.review_at),
    client: !!r.client,
    overridable: !!r.overridable,
    rolloutBy: (r.rollout_by as RolloutBy) ?? 'user',
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: Number(r.created_at),
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: Number(r.updated_at)
  };
}

function valueFromRow(r: Record<string, unknown>): LevelValue {
  return {
    id: String(r.id),
    flagKey: String(r.flag_key),
    scope: r.scope as Level,
    scopeId: String(r.scope_id),
    tenantId: (r.tenant_id as string | null) ?? null,
    value: json<FlagValue>(r.value, false),
    rollout: num(r.rollout),
    note: (r.note as string | null) ?? null,
    updatedBy: (r.updated_by as string | null) ?? null,
    updatedAt: Number(r.updated_at)
  };
}

function proposalFromRow(r: Record<string, unknown>): ProposalRow {
  return {
    id: String(r.id),
    flagKey: String(r.flag_key),
    change: json<PlatformChange>(r.change, {}),
    reason: (r.reason as string | null) ?? null,
    state: r.state as ProposalRow['state'],
    proposedBy: String(r.proposed_by),
    proposedTenant: String(r.proposed_tenant),
    proposedAt: Number(r.proposed_at),
    decidedBy: (r.decided_by as string | null) ?? null,
    decidedAt: num(r.decided_at),
    note: (r.note as string | null) ?? null
  };
}

const live = (state: FlagState) => state === 'active' || state === 'deprecated';

export class FeatureFlagService {
  private tablesSeen: boolean | null = null;
  private tablesCheckedAt = 0;
  private global: GlobalSnapshot | null = null;
  private loadingGlobal: Promise<GlobalSnapshot> | null = null;
  private readonly tenants = new Map<string, TenantSnapshot>();
  private readonly loadingTenants = new Map<string, Promise<TenantSnapshot>>();
  private offs: (() => void)[] = [];
  /** Counters for the tests and the screen: cache loads by kind. */
  readonly loads = { global: 0, tenant: 0 };

  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  // ---------- schema ----------

  /** Whether migration 137 is applied. A missing table is checked again at most every 30 seconds. */
  async available(): Promise<boolean> {
    if (this.tablesSeen) return true;
    if (this.tablesSeen === false && Date.now() - this.tablesCheckedAt < SCHEMA_RECHECK_MS) return false;
    try {
      const [a, b, c] = await Promise.all(['feature_flags', 'feature_flag_values', 'feature_flag_proposals'].map((t) => this.db.schema.hasTable(t)));
      this.tablesSeen = !!(a && b && c);
    } catch {
      this.tablesSeen = false;
    }
    this.tablesCheckedAt = Date.now();
    return this.tablesSeen;
  }

  /** Forgets the schema check (tests that apply the migration by hand). */
  resetSchemaCache(): void {
    this.tablesSeen = null;
    this.drop({});
  }

  private async requireTables(): Promise<void> {
    if (!(await this.available())) throw new HttpProblem(503, 'Feature flags unavailable', 'Feature flags are not installed yet: the database migration 137_feature_flags has not been applied. Every flag answers its built-in default until it is.', { extensions: { reason: 'flags_unavailable' } });
  }

  // ---------- cache and bus ----------

  /** Listens for changes on the bus and for subscription and plan changes in the audit chain. */
  init(): void {
    const s = this.s();
    this.offs.push(s.bus.on<{ tenantId?: string }>(FLAGS_TOPIC, (e) => this.drop(e ?? {})));
    this.offs.push(
      s.audit.onAppend((e) => {
        if (e.action.startsWith('billing.subscription.')) this.changed(e.tenant_id);
        else if (e.action === 'billing.plan.approved') this.changed();
      })
    );
  }

  close(): void {
    for (const off of this.offs.splice(0)) off();
  }

  /** Drops cached entries here: one tenant's, or everything. */
  private drop(e: { tenantId?: string }): void {
    if (e.tenantId) this.tenants.delete(e.tenantId);
    else {
      this.global = null;
      this.tenants.clear();
    }
  }

  /** Drops cached entries on every instance. */
  changed(tenantId?: string): void {
    this.s().bus.publish(FLAGS_TOPIC, tenantId ? { tenantId } : {});
  }

  private async globalSnapshot(): Promise<GlobalSnapshot> {
    if (this.global && Date.now() - this.global.at < TTL_MS) return this.global;
    if (this.loadingGlobal) return this.loadingGlobal;
    this.loadingGlobal = (async () => {
      this.loads.global++;
      const [defs, values] = await Promise.all([this.db('feature_flags').select(), this.db('feature_flag_values').whereIn('scope', ['platform', 'plan']).select()]);
      const snap: GlobalSnapshot = { at: Date.now(), defs: new Map(), platform: new Map(), plans: new Map() };
      for (const r of defs as Record<string, unknown>[]) {
        const d = defFromRow(r);
        snap.defs.set(d.key, d);
      }
      for (const r of values as Record<string, unknown>[]) {
        const v = valueFromRow(r);
        if (v.scope === 'platform') snap.platform.set(v.flagKey, v);
        else {
          const m = snap.plans.get(v.scopeId) ?? new Map<string, LevelValue>();
          m.set(v.flagKey, v);
          snap.plans.set(v.scopeId, m);
        }
      }
      this.global = snap;
      return snap;
    })().finally(() => {
      this.loadingGlobal = null;
    });
    return this.loadingGlobal;
  }

  private async tenantSnapshot(tenantId: string): Promise<TenantSnapshot> {
    const hit = this.tenants.get(tenantId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit;
    const pending = this.loadingTenants.get(tenantId);
    if (pending) return pending;
    const p = (async () => {
      this.loads.tenant++;
      const [rows, plan] = await Promise.all([this.db('feature_flag_values').where({ tenant_id: tenantId }).whereIn('scope', ['tenant', 'workspace']).select(), this.planOf(tenantId)]);
      const snap: TenantSnapshot = { at: Date.now(), plan, tenant: new Map(), workspaces: new Map() };
      for (const r of rows as Record<string, unknown>[]) {
        const v = valueFromRow(r);
        if (v.scope === 'tenant') snap.tenant.set(v.flagKey, v);
        else {
          const m = snap.workspaces.get(v.scopeId) ?? new Map<string, LevelValue>();
          m.set(v.flagKey, v);
          snap.workspaces.set(v.scopeId, m);
        }
      }
      this.tenants.set(tenantId, snap);
      return snap;
    })().finally(() => {
      this.loadingTenants.delete(tenantId);
    });
    this.loadingTenants.set(tenantId, p);
    return p;
  }

  /** The tenant's plan now (B-162), or null without a subscription (or without the billing tables). */
  private async planOf(tenantId: string): Promise<TenantSnapshot['plan']> {
    try {
      const sub = await this.s().subscriptions.at(tenantId, Date.now());
      return sub ? { key: sub.plan.key, entitlements: sub.plan.entitlements } : null;
    } catch (err) {
      this.s().log.debug({ err }, 'feature flags: no plan for the tenant');
      return null;
    }
  }

  // ---------- reading: the helper ----------

  /** The evaluation of one flag for a context, with the account of each level. */
  async evaluate(ctx: EvalContext, key: string): Promise<Evaluation> {
    const builtin = BUILTIN_FLAGS.get(key) ?? null;
    if (!(await this.available())) return evaluate(key, ctx, { def: null, builtin, plan: null, values: {} });
    try {
      const g = await this.globalSnapshot();
      const def = g.defs.get(key) ?? null;
      if (!def || !live(def.state)) return evaluate(key, ctx, { def, builtin, plan: null, values: {} });
      const t = await this.tenantSnapshot(ctx.tenantId);
      const ws = ctx.workspaceId ? t.workspaces.get(ctx.workspaceId)?.get(key) : undefined;
      const tv = t.tenant.get(key);
      const pv = t.plan ? g.plans.get(t.plan.key)?.get(key) : undefined;
      const plat = g.platform.get(key);
      return evaluate(key, ctx, { def, builtin, plan: t.plan, values: { ...(ws ? { workspace: ws } : {}), ...(tv ? { tenant: tv } : {}), ...(pv ? { plan: pv } : {}), ...(plat ? { platform: plat } : {}) } });
    } catch (err) {
      // A read never fails a feature: the built-in default answers instead.
      this.s().log.warn({ err, key }, 'feature flag evaluation failed; using the built-in default');
      return evaluate(key, ctx, { def: null, builtin, plan: null, values: {} });
    }
  }

  /** The flag's value for a context (null for an unknown flag without a built-in default). */
  async value(ctx: EvalContext, key: string): Promise<FlagValue | null> {
    return (await this.evaluate(ctx, key)).value;
  }

  /** Whether the flag is on for a context: true, a number above 0, a variant other than `off`. */
  async on(ctx: EvalContext, key: string): Promise<boolean> {
    return isOn(await this.value(ctx, key));
  }

  /** Every flag sent to the web client (`client` true, not removed), evaluated for a context: key → value. */
  async forClient(ctx: EvalContext): Promise<Record<string, FlagValue>> {
    const out: Record<string, FlagValue> = {};
    if (!(await this.available())) return out;
    try {
      const g = await this.globalSnapshot();
      const keys = [...g.defs.values()].filter((d) => d.client && d.state !== 'removed').map((d) => d.key);
      const evals = await Promise.all(keys.map((k) => this.evaluate(ctx, k)));
      for (const e of evals) if (e.value !== null) out[e.key] = e.value;
    } catch (err) {
      this.s().log.warn({ err }, 'feature flags for the client failed');
    }
    return out;
  }

  // ---------- reading: admin ----------

  async get(key: string): Promise<FlagDef> {
    await this.requireTables();
    const r = await this.db('feature_flags').where({ key }).first();
    if (!r) throw notFound('Feature flag');
    return defFromRow(r);
  }

  /** Every flag with its platform value, how many plans, tenants and workspaces set it, stale warnings and a pending proposal. */
  async list(opts: { tenantId?: string } = {}): Promise<{ flag: FlagDef; platform: LevelValue | null; counts: Record<'plan' | 'tenant' | 'workspace', number>; stale: StaleWarning[]; pending: ProposalRow | null; mine?: { tenant: LevelValue | null; workspaces: LevelValue[] } }[]> {
    await this.requireTables();
    const [defs, values, pending] = await Promise.all([this.db('feature_flags').orderBy('key', 'asc'), this.db('feature_flag_values').select('flag_key', 'scope', 'scope_id', 'tenant_id', 'id', 'value', 'rollout', 'note', 'updated_by', 'updated_at'), this.db('feature_flag_proposals').where({ state: 'pending' })]);
    const vals = (values as Record<string, unknown>[]).map(valueFromRow);
    const pend = new Map((pending as Record<string, unknown>[]).map(proposalFromRow).map((p) => [p.flagKey, p]));
    const now = Date.now();
    return (defs as Record<string, unknown>[]).map(defFromRow).map((flag) => {
      const mineAll = vals.filter((v) => v.flagKey === flag.key);
      const platform = mineAll.find((v) => v.scope === 'platform') ?? null;
      const count = (scope: Level) => mineAll.filter((v) => v.scope === scope).length;
      return {
        flag,
        platform,
        counts: { plan: count('plan'), tenant: count('tenant'), workspace: count('workspace') },
        stale: staleWarnings(flag, platform, now),
        pending: pend.get(flag.key) ?? null,
        ...(opts.tenantId ? { mine: { tenant: mineAll.find((v) => v.scope === 'tenant' && v.tenantId === opts.tenantId) ?? null, workspaces: mineAll.filter((v) => v.scope === 'workspace' && v.tenantId === opts.tenantId) } } : {})
      };
    });
  }

  /** The values set on one flag: every level for platform admins, or only one tenant's. */
  async values(key: string, opts: { tenantId?: string } = {}): Promise<LevelValue[]> {
    await this.requireTables();
    const q = this.db('feature_flag_values').where({ flag_key: key }).orderBy('scope', 'asc').orderBy('scope_id', 'asc');
    if (opts.tenantId) q.andWhere({ tenant_id: opts.tenantId });
    return ((await q) as Record<string, unknown>[]).map(valueFromRow);
  }

  async proposals(opts: { key?: string; state?: ProposalRow['state']; limit?: number } = {}): Promise<ProposalRow[]> {
    await this.requireTables();
    const q = this.db('feature_flag_proposals').orderBy('proposed_at', 'desc').limit(opts.limit ?? 100);
    if (opts.key) q.andWhere({ flag_key: opts.key });
    if (opts.state) q.andWhere({ state: opts.state });
    return ((await q) as Record<string, unknown>[]).map(proposalFromRow);
  }

  // ---------- writing ----------

  private audit(by: FlagActor, action: string, key: string, detail: Record<string, unknown>, tenantId = by.tenantId) {
    return this.s().audit.append({ tenantId, action, kind: 'admin', actor: by.actor, target: { flag: key }, label: 'internal', detail, ...(by.traceId ? { traceId: by.traceId } : {}) });
  }

  private checkValue(def: Pick<FlagDef, 'type' | 'options'>, v: unknown, what: string): asserts v is FlagValue {
    const p = valueProblem(def.type, def.options, v);
    if (p) throw badRequest(`${what}: ${p}.`);
  }

  async create(by: FlagActor, input: FlagInput): Promise<FlagDef> {
    await this.requireTables();
    const options = input.options ?? {};
    const op = optionsProblem(input.type, options);
    if (op) throw badRequest(`${input.key}: ${op}.`);
    this.checkValue({ type: input.type, options }, input.defaultValue, 'The default');
    const t = Date.now();
    const state = input.state ?? 'planned';
    try {
      await this.db('feature_flags').insert({
        key: input.key,
        type: input.type,
        default_value: JSON.stringify(input.defaultValue),
        options: Object.keys(options).length ? JSON.stringify(options) : null,
        description: input.description ?? '',
        owner: input.owner ?? '',
        state,
        state_changed_at: t,
        review_at: input.reviewAt ?? null,
        client: input.client ?? true,
        overridable: input.overridable ?? true,
        rollout_by: input.rolloutBy ?? 'user',
        created_by: by.userId,
        created_at: t,
        updated_by: by.userId,
        updated_at: t
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A flag named ${input.key} exists.`);
      throw err;
    }
    const def = await this.get(input.key);
    await this.audit(by, 'flag.feature.created', def.key, { type: def.type, defaultValue: def.defaultValue, state, client: def.client, overridable: def.overridable, rolloutBy: def.rolloutBy });
    this.changed();
    return def;
  }

  async update(by: FlagActor, key: string, patch: FlagPatch): Promise<FlagDef> {
    const before = await this.get(key);
    if (before.state === 'removed') throw conflict(`${key} is removed; bring it back as deprecated first.`);
    const options = patch.options ?? before.options;
    if (patch.options) {
      const op = optionsProblem(before.type, options);
      if (op) throw badRequest(`${key}: ${op}.`);
      this.checkValue({ type: before.type, options }, before.defaultValue, 'The default no longer fits the options');
    }
    const upd: Record<string, unknown> = { updated_by: by.userId, updated_at: Date.now() };
    if (patch.description !== undefined) upd.description = patch.description;
    if (patch.owner !== undefined) upd.owner = patch.owner;
    if (patch.reviewAt !== undefined) upd.review_at = patch.reviewAt;
    if (patch.client !== undefined) upd.client = patch.client;
    if (patch.overridable !== undefined) upd.overridable = patch.overridable;
    if (patch.rolloutBy !== undefined) upd.rollout_by = patch.rolloutBy;
    if (patch.options) upd.options = Object.keys(options).length ? JSON.stringify(options) : null;
    await this.db('feature_flags').where({ key }).update(upd);
    const after = await this.get(key);
    const changes = Object.fromEntries((Object.keys(patch) as (keyof FlagPatch)[]).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).map((k) => [k, { from: before[k], to: after[k] }]));
    await this.audit(by, 'flag.feature.updated', key, { changes });
    this.changed();
    return after;
  }

  /** Moves a flag along its life cycle. */
  async setState(by: FlagActor, key: string, state: FlagState, note: string | null = null): Promise<FlagDef> {
    const before = await this.get(key);
    if (before.state === state) return before;
    if (!NEXT_STATES[before.state].includes(state)) throw conflict(`A ${before.state} flag cannot become ${state}; it may become ${NEXT_STATES[before.state].join(' or ')}.`);
    const t = Date.now();
    await this.db('feature_flags').where({ key }).update({ state, state_changed_at: t, updated_by: by.userId, updated_at: t });
    // A removed flag's pending platform change is moot.
    if (state === 'removed') await this.db('feature_flag_proposals').where({ flag_key: key, state: 'pending' }).update({ state: 'superseded', decided_at: t, note: 'the flag was removed' });
    await this.audit(by, 'flag.feature.state_changed', key, { from: before.state, to: state, note });
    this.changed();
    return this.get(key);
  }

  /**
   * Changes the platform default and/or the platform value with its rollout. A live flag's change waits for a second
   * platform admin; a planned one applies at once.
   */
  async changePlatform(by: FlagActor, key: string, change: PlatformChange, reason: string | null): Promise<{ applied: boolean; flag: FlagDef; proposal: ProposalRow | null }> {
    const def = await this.get(key);
    if (def.state === 'removed') throw conflict(`${key} is removed and takes no new values.`);
    if (change.defaultValue === undefined && change.platform === undefined) throw badRequest('Name a new default or a platform value.');
    if (change.defaultValue !== undefined) this.checkValue(def, change.defaultValue, 'The default');
    if (change.platform) this.checkValue(def, change.platform.value, 'The platform value');
    if (!live(def.state)) {
      await this.applyPlatform(by.userId, def, change);
      await this.audit(by, 'flag.platform.changed', key, { ...change, dualControl: false });
      this.changed();
      return { applied: true, flag: await this.get(key), proposal: null };
    }
    const id = ulid();
    const t = Date.now();
    const open = await this.db('feature_flag_proposals').where({ flag_key: key, state: 'pending' }).first();
    if (open) throw conflict(`A change to ${key} already waits for a second platform admin; approve, reject or withdraw it first.`);
    await this.db('feature_flag_proposals').insert({ id, flag_key: key, change: JSON.stringify(change), reason, state: 'pending', proposed_by: by.userId, proposed_tenant: by.tenantId, proposed_at: t });
    const proposal = proposalFromRow((await this.db('feature_flag_proposals').where({ id }).first()) as Record<string, unknown>);
    await this.audit(by, 'flag.change.proposed', key, { proposal: id, ...change, reason });
    await this.notifySecond(by, def);
    return { applied: false, flag: def, proposal };
  }

  private async applyPlatform(userId: string, def: FlagDef, change: PlatformChange): Promise<void> {
    const t = Date.now();
    await this.db.transaction(async (trx) => {
      if (change.defaultValue !== undefined) await trx('feature_flags').where({ key: def.key }).update({ default_value: JSON.stringify(change.defaultValue), updated_by: userId, updated_at: t });
      if (change.platform === null) await trx('feature_flag_values').where({ flag_key: def.key, scope: 'platform', scope_id: '*' }).delete();
      else if (change.platform) {
        const row = { value: JSON.stringify(change.platform.value), rollout: change.platform.rollout, updated_by: userId, updated_at: t };
        const n = await trx('feature_flag_values').where({ flag_key: def.key, scope: 'platform', scope_id: '*' }).update(row);
        if (!n) await trx('feature_flag_values').insert({ id: ulid(), flag_key: def.key, scope: 'platform', scope_id: '*', tenant_id: null, note: null, ...row });
      }
    });
  }

  private async platformAdmins(tenantId: string): Promise<string[]> {
    const rows = (await this.db('users as u').join('user_roles as r', 'r.user_id', 'u.id').where({ 'u.tenant_id': tenantId, 'u.state': 'active' }).select('u.id', 'r.role')) as { id: string; role: string }[];
    const roles = new Map<string, string[]>();
    for (const r of rows) roles.set(r.id, [...(roles.get(r.id) ?? []), r.role]);
    return [...roles].filter(([, list]) => permissionsFor(list, tenantId).has('platform:manage')).map(([id]) => id);
  }

  private async notifySecond(by: FlagActor, def: FlagDef): Promise<void> {
    const s = this.s();
    const to = (await this.platformAdmins(by.tenantId)).filter((id) => id !== by.userId);
    if (!to.length) return;
    await s.notifications
      .notify({ tenantId: by.tenantId, userIds: to, kind: 'platform.flag', title: `Feature flag ${def.key}: a change waits for a second platform admin`, body: 'A change to a live flag\'s platform default or rollout needs another platform admin to approve it.', route: 'platform', label: 'internal' })
      .catch((err: unknown) => s.log.warn({ err }, 'flag proposal notice failed'));
  }

  private async proposal(id: string): Promise<ProposalRow> {
    await this.requireTables();
    const r = await this.db('feature_flag_proposals').where({ id }).first();
    if (!r) throw notFound('Flag change');
    return proposalFromRow(r);
  }

  /** Approves a pending change: never by its proposer. */
  async approve(by: FlagActor, id: string, note: string | null = null): Promise<{ flag: FlagDef; proposal: ProposalRow }> {
    const p = await this.proposal(id);
    if (p.state !== 'pending') throw conflict(`The change is ${p.state}.`);
    if (p.proposedBy === by.userId) throw forbidden('Dual control: you cannot approve your own change. Another platform admin must approve it.', { step: 'dual-control' });
    const def = await this.get(p.flagKey);
    if (def.state === 'removed') throw conflict(`${def.key} is removed.`);
    // The flag's type and options may have moved since; the value must still fit.
    if (p.change.defaultValue !== undefined) this.checkValue(def, p.change.defaultValue, 'The proposed default');
    if (p.change.platform) this.checkValue(def, p.change.platform.value, 'The proposed platform value');
    const n = await this.db('feature_flag_proposals').where({ id, state: 'pending' }).update({ state: 'approved', decided_by: by.userId, decided_at: Date.now(), note });
    if (!n) throw conflict('The change was decided by someone else.');
    await this.applyPlatform(by.userId, def, p.change);
    await this.audit(by, 'flag.change.approved', def.key, { proposal: id, proposedBy: p.proposedBy, ...p.change, note });
    this.changed();
    return { flag: await this.get(def.key), proposal: await this.proposal(id) };
  }

  /** Rejects a pending change, or withdraws it when the proposer does. */
  async reject(by: FlagActor, id: string, note: string | null = null): Promise<ProposalRow> {
    const p = await this.proposal(id);
    if (p.state !== 'pending') throw conflict(`The change is ${p.state}.`);
    const state = p.proposedBy === by.userId ? 'withdrawn' : 'rejected';
    const n = await this.db('feature_flag_proposals').where({ id, state: 'pending' }).update({ state, decided_by: by.userId, decided_at: Date.now(), note });
    if (!n) throw conflict('The change was decided by someone else.');
    await this.audit(by, state === 'withdrawn' ? 'flag.change.withdrawn' : 'flag.change.rejected', p.flagKey, { proposal: id, proposedBy: p.proposedBy, note });
    return this.proposal(id);
  }

  /**
   * Sets a value at the plan (platform admins), tenant or workspace level (the tenant's admins, their own tenant).
   * `scopeId` is the plan key, or the workspace id; a tenant value is always the actor's own tenant.
   */
  async setValue(by: FlagActor, key: string, scope: 'plan' | 'tenant' | 'workspace', scopeId: string | null, input: { value: FlagValue; rollout: number | null; note?: string | null }): Promise<LevelValue> {
    const def = await this.get(key);
    if (def.state === 'removed') throw conflict(`${key} is removed and takes no new values.`);
    if (scope !== 'plan' && !def.overridable) throw forbidden(`${key} is locked to the platform and plans; tenants cannot override it.`, { step: 'flag' });
    this.checkValue(def, input.value, 'The value');
    const target = await this.targetOf(by, scope, scopeId);
    const t = Date.now();
    const row = { value: JSON.stringify(input.value), rollout: input.rollout, note: input.note ?? null, updated_by: by.userId, updated_at: t };
    const where = { flag_key: key, scope, scope_id: target.scopeId };
    const before = await this.db('feature_flag_values').where(where).first();
    if (before) await this.db('feature_flag_values').where(where).update(row);
    else {
      try {
        await this.db('feature_flag_values').insert({ id: ulid(), ...where, tenant_id: target.tenantId, ...row });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        await this.db('feature_flag_values').where(where).update(row);
      }
    }
    const after = valueFromRow((await this.db('feature_flag_values').where(where).first()) as Record<string, unknown>);
    await this.audit(by, 'flag.value.set', key, { scope, scopeId: target.scopeId, value: input.value, rollout: input.rollout, ...(before ? { before: { value: json(before.value, null), rollout: num(before.rollout) } } : {}), note: input.note ?? null });
    this.changed(scope === 'plan' ? undefined : target.tenantId!);
    return after;
  }

  async clearValue(by: FlagActor, key: string, scope: 'plan' | 'tenant' | 'workspace', scopeId: string | null): Promise<void> {
    await this.get(key);
    const target = await this.targetOf(by, scope, scopeId);
    const where = { flag_key: key, scope, scope_id: target.scopeId };
    const before = await this.db('feature_flag_values').where(where).first();
    if (!before) throw notFound('Flag value');
    await this.db('feature_flag_values').where(where).delete();
    await this.audit(by, 'flag.value.cleared', key, { scope, scopeId: target.scopeId, before: { value: json(before.value, null), rollout: num(before.rollout) } });
    this.changed(scope === 'plan' ? undefined : target.tenantId!);
  }

  private async targetOf(by: FlagActor, scope: 'plan' | 'tenant' | 'workspace', scopeId: string | null): Promise<{ scopeId: string; tenantId: string | null }> {
    if (scope === 'tenant') return { scopeId: by.tenantId, tenantId: by.tenantId };
    if (!scopeId) throw badRequest(scope === 'plan' ? 'Name the plan.' : 'Name the workspace.');
    if (scope === 'workspace') {
      const ws = await this.s().tenants.workspace(by.tenantId, scopeId);
      if (!ws) throw notFound('Workspace');
      return { scopeId, tenantId: by.tenantId };
    }
    const plan = await this.db('billing_plans').where({ key: scopeId }).first().catch(() => null);
    if (!plan) throw notFound('Plan');
    return { scopeId, tenantId: null };
  }
}
