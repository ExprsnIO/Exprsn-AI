import { ulid } from 'ulid';
import { json, type Db } from '../db/knex.js';
import { isUniqueViolation } from '../audit/chain.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Bus } from '../platform/bus.js';
import { relaxes, validateRules, type Rule } from './rules.js';

export type SetScope = 'platform' | 'tenant' | 'workspace' | 'agent';
export type VersionStatus = 'draft' | 'pending' | 'published' | 'superseded' | 'withdrawn';

/** Precedence, most authoritative first. The most restrictive result across every level wins. */
export const SCOPE_ORDER: SetScope[] = ['platform', 'tenant', 'workspace', 'agent'];

export interface RuleSetRow {
  id: string;
  scope: SetScope;
  tenant_id: string | null;
  workspace_id: string | null;
  agent: string | null;
  name: string;
  description: string | null;
  published_version: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface VersionRow {
  id: string;
  set_id: string;
  version: number;
  status: VersionStatus;
  rules: Rule[];
  note: string | null;
  created_by: string | null;
  submitted_by: string | null;
  submitted_at: number | null;
  approved_by: string | null;
  approved_at: number | null;
  published_at: number | null;
  created_at: number;
  updated_at: number;
}

/** A rule as it applies to a check: with its set, level and whether it comes from a draft under review. */
export interface ActiveRule {
  rule: Rule;
  set: { id: string; name: string; scope: SetScope; workspaceId: string | null; agent: string | null };
  version: number;
  /** From a version awaiting review: evaluated in shadow only. */
  pending: boolean;
}

const setFrom = (r: Record<string, unknown>): RuleSetRow => ({
  ...(r as unknown as RuleSetRow),
  published_version: r.published_version == null ? null : Number(r.published_version),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

const versionFrom = (r: Record<string, unknown>): VersionRow => ({
  ...(r as unknown as VersionRow),
  version: Number(r.version),
  rules: json<Rule[]>(r.rules, []),
  submitted_at: r.submitted_at == null ? null : Number(r.submitted_at),
  approved_at: r.approved_at == null ? null : Number(r.approved_at),
  published_at: r.published_at == null ? null : Number(r.published_at),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

/** The bus topic that drops every instance's cached effective rules for a tenant (null: every tenant). */
export const GUARD_CHANGED = 'guardrails.changed';
const CACHE_MS = 15_000;
export const PLATFORM_SET_ID = '0000000000000000GRBASELINE';

/** The platform baseline a fresh installation starts with: deterministic, and published. */
const BASELINE: Rule[] = [
  { id: 'secrets-input', name: 'Secrets and private keys', checkpoint: 'user-input', type: 'pattern', mechanism: { kind: 'secrets', detectors: ['private_key', 'cloud_access_key', 'bearer_token'], threshold: 0.9 }, action: 'block', stage: 'enforce', onError: 'closed', severity: 'high', enabled: true },
  { id: 'secrets-out', name: 'Secrets and private keys', checkpoint: 'model-output', type: 'pattern', mechanism: { kind: 'secrets', detectors: ['private_key', 'cloud_access_key', 'bearer_token'], threshold: 0.9 }, action: 'block', stage: 'enforce', onError: 'closed', severity: 'high', enabled: true },
  { id: 'clearance-ctx', name: 'Chunk above clearance', checkpoint: 'context', type: 'label', mechanism: { kind: 'label', against: 'clearance' }, action: 'block', stage: 'enforce', onError: 'closed', severity: 'high', enabled: true },
  { id: 'mem-secrets', name: 'Secrets in memory', checkpoint: 'memory', type: 'pattern', mechanism: { kind: 'secrets', detectors: ['private_key', 'cloud_access_key', 'bearer_token'], threshold: 0.9 }, action: 'block', stage: 'enforce', onError: 'closed', severity: 'high', enabled: true }
];

/**
 * Rule sets ("guardrail profiles") and their versions. A set has at most one open draft (draft, or pending once
 * review is requested) beside its published version; publishing supersedes the previous version, so every published
 * version stays for diffs. The platform baseline belongs to platform guardrail admins and publishes only when a
 * second one approves; tenant sets cannot relax a baseline rule.
 */
export class RuleSetService {
  private readonly cache = new Map<string, { at: number; rules: Promise<ActiveRule[]> }>();
  private seeded: Promise<void> | null = null;

  constructor(
    private readonly db: Db,
    private readonly bus: Bus
  ) {
    bus.on<{ tenantId: string | null }>(GUARD_CHANGED, ({ tenantId }) => {
      if (tenantId) this.cache.delete(tenantId);
      else this.cache.clear();
    });
  }

  private changed(tenantId: string | null): void {
    this.bus.publish(GUARD_CHANGED, { tenantId });
  }

  ensureBaseline(): Promise<void> {
    this.seeded ??= (async () => {
      if (await this.db('guard_rule_sets').where({ id: PLATFORM_SET_ID }).first('id')) return;
      const t = Date.now();
      try {
        await this.db('guard_rule_sets').insert({ id: PLATFORM_SET_ID, scope: 'platform', tenant_id: null, workspace_id: null, agent: null, name: 'Platform baseline', description: 'Applies to every tenant. Owned by platform guardrail admins; changes need a second approver.', published_version: 1, created_by: null, created_at: t, updated_at: t });
        await this.db('guard_rule_set_versions').insert({ id: ulid(), set_id: PLATFORM_SET_ID, version: 1, status: 'published', rules: JSON.stringify(BASELINE), note: 'Initial baseline', created_by: null, submitted_by: null, submitted_at: null, approved_by: null, approved_at: null, published_at: t, created_at: t, updated_at: t });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    })().catch((err) => {
      this.seeded = null;
      throw err;
    });
    return this.seeded;
  }

  // ---------- reading ----------

  /** The platform baseline and every set of the tenant. */
  async list(tenantId: string): Promise<RuleSetRow[]> {
    await this.ensureBaseline();
    const rows = await this.db('guard_rule_sets').where((q) => q.where({ scope: 'platform' }).orWhere({ tenant_id: tenantId })).orderBy('created_at');
    return rows.map(setFrom).sort((a, b) => SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope));
  }

  async get(tenantId: string, id: string): Promise<RuleSetRow> {
    await this.ensureBaseline();
    const r = await this.db('guard_rule_sets').where({ id }).first();
    if (!r || (r.scope !== 'platform' && r.tenant_id !== tenantId)) throw notFound('Rule set');
    return setFrom(r);
  }

  async versions(setId: string): Promise<VersionRow[]> {
    return ((await this.db('guard_rule_set_versions').where({ set_id: setId }).orderBy('version', 'desc')) as Record<string, unknown>[]).map(versionFrom);
  }

  async version(setId: string, version: number): Promise<VersionRow | undefined> {
    const r = await this.db('guard_rule_set_versions').where({ set_id: setId, version }).first();
    return r ? versionFrom(r) : undefined;
  }

  async published(set: RuleSetRow): Promise<VersionRow | undefined> {
    return set.published_version == null ? undefined : this.version(set.id, set.published_version);
  }

  async draft(setId: string): Promise<VersionRow | undefined> {
    const r = await this.db('guard_rule_set_versions').where({ set_id: setId }).whereIn('status', ['draft', 'pending']).orderBy('version', 'desc').first();
    return r ? versionFrom(r) : undefined;
  }

  /** Published baseline rules by id, to refuse lower levels that would relax them. */
  async baselineRules(): Promise<Map<string, Rule>> {
    await this.ensureBaseline();
    const set = await this.db('guard_rule_sets').where({ id: PLATFORM_SET_ID }).first();
    const v = set?.published_version != null ? await this.version(PLATFORM_SET_ID, Number(set.published_version)) : undefined;
    return new Map((v?.rules ?? []).map((r) => [r.id, r]));
  }

  /**
   * Rules that apply in a tenant (cached briefly, dropped on every change through the bus): every published set's
   * rules at every level, plus the rules of versions awaiting review, which run in shadow meanwhile.
   */
  async active(tenantId: string): Promise<ActiveRule[]> {
    let hit = this.cache.get(tenantId);
    if (!hit || Date.now() - hit.at > CACHE_MS) {
      hit = { at: Date.now(), rules: this.load(tenantId) };
      this.cache.set(tenantId, hit);
      hit.rules.catch(() => this.cache.delete(tenantId));
    }
    return hit.rules;
  }

  private async load(tenantId: string): Promise<ActiveRule[]> {
    const sets = await this.list(tenantId);
    const out: ActiveRule[] = [];
    for (const s of sets) {
      const set = { id: s.id, name: s.name, scope: s.scope, workspaceId: s.workspace_id, agent: s.agent };
      const pub = await this.published(s);
      for (const rule of pub?.rules ?? []) out.push({ rule, set, version: pub!.version, pending: false });
      const d = await this.draft(s.id);
      if (d?.status === 'pending') for (const rule of d.rules) out.push({ rule: { ...rule, stage: 'shadow' }, set, version: d.version, pending: true });
    }
    return out;
  }

  /** The active rules that apply to a workspace (and agent, when the check names one). */
  async forCheck(tenantId: string, workspaceId: string | null, agent: string | null): Promise<ActiveRule[]> {
    return (await this.active(tenantId)).filter(({ set }) => {
      if (set.scope === 'workspace') return set.workspaceId === workspaceId;
      if (set.scope === 'agent') return !!agent && set.agent === agent && (!set.workspaceId || set.workspaceId === workspaceId);
      return true;
    });
  }

  // ---------- writing ----------

  async create(tenantId: string, input: { name: string; scope: 'tenant' | 'workspace' | 'agent'; workspaceId?: string | null; agent?: string | null; description?: string | null }, by: string): Promise<RuleSetRow> {
    const t = Date.now();
    const row: RuleSetRow = { id: ulid(), scope: input.scope, tenant_id: tenantId, workspace_id: input.scope === 'tenant' ? null : (input.workspaceId ?? null), agent: input.scope === 'agent' ? (input.agent ?? null) : null, name: input.name, description: input.description ?? null, published_version: null, created_by: by, created_at: t, updated_at: t };
    if (row.scope === 'workspace' && !row.workspace_id) throw new HttpProblem(422, 'Invalid rule set', 'A workspace rule set names its workspace.');
    if (row.scope === 'agent' && !row.agent) throw new HttpProblem(422, 'Invalid rule set', 'An agent rule set names its agent.');
    await this.db('guard_rule_sets').insert(row);
    return row;
  }

  /**
   * Refuses a draft for a tenant-level set that would relax a platform baseline rule ("Baseline locked"): a rule with
   * a baseline rule's id must be at least as strict. Stricter rules and new rules are always allowed.
   */
  async checkNotRelaxing(set: RuleSetRow, rules: Rule[]): Promise<void> {
    if (set.scope === 'platform') return;
    const base = await this.baselineRules();
    for (const r of rules) {
      const b = base.get(r.id);
      const why = b ? relaxes(b, r) : null;
      if (why) {
        throw forbidden(`Baseline locked: ${b!.name} (${b!.id}) belongs to the platform baseline, owned by platform guardrail admins. A tenant rule set can add stricter rules but cannot relax it; this change ${why}.`, { step: 'baseline-locked', ruleId: r.id, owner: 'Platform guardrail admins' });
      }
    }
  }

  /** Replaces the rules of the set's open draft, creating the draft (next version, from the published rules) first. */
  async saveDraft(set: RuleSetRow, rules: unknown, by: string, note?: string | null): Promise<VersionRow> {
    const valid = validateRules(rules);
    await this.checkNotRelaxing(set, valid);
    const t = Date.now();
    let d = await this.draft(set.id);
    if (d?.status === 'pending') throw conflict(`Version ${d.version} is waiting for review. Withdraw it to change it.`);
    if (!d) {
      const max = ((await this.db('guard_rule_set_versions').where({ set_id: set.id }).max({ v: 'version' }).first()) as { v: number | null } | undefined)?.v ?? 0;
      d = { id: ulid(), set_id: set.id, version: Number(max) + 1, status: 'draft', rules: valid, note: note ?? null, created_by: by, submitted_by: null, submitted_at: null, approved_by: null, approved_at: null, published_at: null, created_at: t, updated_at: t };
      try {
        await this.db('guard_rule_set_versions').insert({ ...d, rules: JSON.stringify(valid) });
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict('Someone else started a draft of this rule set at the same time. Reload it.');
        throw err;
      }
    } else {
      await this.db('guard_rule_set_versions').where({ id: d.id }).update({ rules: JSON.stringify(valid), updated_at: t, ...(note !== undefined ? { note } : {}) });
      d = { ...d, rules: valid, updated_at: t };
    }
    await this.db('guard_rule_sets').where({ id: set.id }).update({ updated_at: t });
    return d;
  }

  /** The rules to edit from: the open draft, else the published version. */
  async workingRules(set: RuleSetRow): Promise<Rule[]> {
    return (await this.draft(set.id))?.rules ?? (await this.published(set))?.rules ?? [];
  }

  async withdraw(set: RuleSetRow): Promise<VersionRow> {
    const d = await this.draft(set.id);
    if (!d) throw notFound('Draft');
    await this.db('guard_rule_set_versions').where({ id: d.id }).update({ status: 'withdrawn', updated_at: Date.now() });
    if (d.status === 'pending') this.changed(set.tenant_id);
    return d;
  }

  async submit(set: RuleSetRow, by: string): Promise<VersionRow> {
    const d = await this.draft(set.id);
    if (!d) throw notFound('Draft');
    if (d.status === 'pending') throw conflict(`Version ${d.version} is already waiting for review.`);
    const t = Date.now();
    await this.db('guard_rule_set_versions').where({ id: d.id }).update({ status: 'pending', submitted_by: by, submitted_at: t, updated_at: t });
    this.changed(set.tenant_id);
    return { ...d, status: 'pending', submitted_by: by, submitted_at: t };
  }

  /** Publishes the open draft, superseding the published version. Callers enforce dual control first. */
  async publish(set: RuleSetRow, by: string): Promise<VersionRow> {
    const d = await this.draft(set.id);
    if (!d) throw notFound('Draft');
    await this.checkNotRelaxing(set, d.rules);
    const t = Date.now();
    if (set.published_version != null) await this.db('guard_rule_set_versions').where({ set_id: set.id, version: set.published_version }).update({ status: 'superseded', updated_at: t });
    await this.db('guard_rule_set_versions').where({ id: d.id }).update({ status: 'published', approved_by: by, approved_at: t, published_at: t, updated_at: t });
    await this.db('guard_rule_sets').where({ id: set.id }).update({ published_version: d.version, updated_at: t });
    this.changed(set.scope === 'platform' ? null : set.tenant_id);
    return { ...d, status: 'published', approved_by: by, approved_at: t, published_at: t };
  }
}
