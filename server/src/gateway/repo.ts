import { ulid } from 'ulid';
import { json, type Db } from '../db/knex.js';
import type { Label } from '../authz/labels.js';
import type { InstanceTls } from './ollama.js';

export type ThinkLevel = 'off' | 'low' | 'medium' | 'high';
export const THINK_LEVELS: readonly ThinkLevel[] = ['off', 'low', 'medium', 'high'];
export const MODEL_STATES = ['draft', 'evaluated', 'approved', 'deprecated', 'retired'] as const;
export type ModelState = (typeof MODEL_STATES)[number];

export interface PoolRow {
  id: string;
  name: string;
  description: string | null;
  accelerator: 'cuda' | 'rocm' | 'metal' | 'cpu';
  zone: string;
  label_ceiling: Label;
  created_at: number;
  updated_at: number;
}

export interface InstanceSettings {
  memoryBytes?: number;
  hardware?: string;
  node?: string;
  device?: string;
  parallel?: number;
  maxLoaded?: number;
  numCtx?: number;
  kvCacheType?: string;
  keepAlive?: string;
}

export interface InstanceRow {
  id: string;
  pool_id: string;
  name: string;
  url: string;
  deploy: 'docker' | 'baremetal';
  tls: InstanceTls | null;
  settings: InstanceSettings;
  state: 'active' | 'draining' | 'disabled';
  health: 'unknown' | 'healthy' | 'degraded' | 'unreachable';
  health_detail: string | null;
  version: string | null;
  last_seen_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface Evaluation {
  at: number;
  instance: string;
  tests: { name: string; ok: boolean; detail: string }[];
  passed: number;
  total: number;
  toolsWithheld: boolean;
}

export interface ModelRow {
  id: string;
  name: string;
  family: string | null;
  parameter_size: string | null;
  quantization: string | null;
  format: string | null;
  size_bytes: number | null;
  context_length: number | null;
  capabilities: string[];
  source: string;
  expected_digest: string | null;
  digest: string | null;
  license: { name: string; url?: string; notes?: string; recordedBy?: string; recordedAt?: number } | null;
  label: Label;
  state: ModelState;
  import_state: 'pending' | 'pulling' | 'pulled' | 'failed';
  import_error: string | null;
  evaluation: Evaluation | null;
  requested_by: string | null;
  requested_tenant: string | null;
  approved_by: string | null;
  approved_at: number | null;
  retire_at: number | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

export interface PlacementRow {
  id: string;
  model_id: string;
  pool_id: string;
  residency: 'pinned' | 'warm' | 'cold';
  created_by: string | null;
  created_at: number;
}

export interface ProfileRow {
  id: string;
  tenant_id: string;
  name: string;
  display_name: string;
  description: string | null;
  alias_of: string | null;
  model_id: string | null;
  pool_id: string | null;
  num_ctx: number | null;
  temperature: number | null;
  think_default: ThinkLevel;
  think_ceiling: ThinkLevel;
  system_prompt: string | null;
  fallback: { profileId: string; afterQueueWaitMs: number } | null;
  canary: { modelId: string; percent: number } | null;
  tools: string[];
  label: Label;
  status: 'draft' | 'published' | 'disabled';
  version: number;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

const n = (v: unknown): number | null => (v == null ? null : Number(v));

const instanceFrom = (r: Record<string, unknown>): InstanceRow => ({
  ...(r as unknown as InstanceRow),
  tls: json<InstanceTls | null>(r.tls, null),
  settings: json<InstanceSettings>(r.settings, {}),
  last_seen_at: n(r.last_seen_at),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

const modelFrom = (r: Record<string, unknown>): ModelRow => ({
  ...(r as unknown as ModelRow),
  size_bytes: n(r.size_bytes),
  context_length: n(r.context_length),
  capabilities: json<string[]>(r.capabilities, []),
  license: json<ModelRow['license']>(r.license, null),
  evaluation: json<Evaluation | null>(r.evaluation, null),
  approved_at: n(r.approved_at),
  retire_at: n(r.retire_at),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

export const profileFrom = (r: Record<string, unknown>): ProfileRow => ({
  ...(r as unknown as ProfileRow),
  num_ctx: n(r.num_ctx),
  temperature: n(r.temperature),
  fallback: json<ProfileRow['fallback']>(r.fallback, null),
  canary: json<ProfileRow['canary']>(r.canary, null),
  tools: json<string[]>(r.tools, []),
  version: Number(r.version),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

/** Data access for pools, instances, the model catalogue, placements and profiles. */
export class GatewayRepo {
  constructor(private readonly db: Db) {}

  // ---------- pools ----------

  async pools(): Promise<PoolRow[]> {
    return (await this.db('pools').orderBy('name')).map((r: Record<string, unknown>) => ({ ...(r as unknown as PoolRow), created_at: Number(r.created_at), updated_at: Number(r.updated_at) }));
  }

  async pool(id: string): Promise<PoolRow | undefined> {
    return (await this.pools()).find((p) => p.id === id);
  }

  async createPool(input: { name: string; description?: string | null; accelerator: PoolRow['accelerator']; zone: string; labelCeiling: Label }): Promise<PoolRow> {
    const t = Date.now();
    const row: PoolRow = { id: ulid(), name: input.name, description: input.description ?? null, accelerator: input.accelerator, zone: input.zone, label_ceiling: input.labelCeiling, created_at: t, updated_at: t };
    await this.db('pools').insert(row);
    return row;
  }

  async updatePool(id: string, patch: Partial<{ description: string | null; zone: string; labelCeiling: Label; accelerator: PoolRow['accelerator'] }>): Promise<void> {
    const upd: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.description !== undefined) upd.description = patch.description;
    if (patch.zone !== undefined) upd.zone = patch.zone;
    if (patch.labelCeiling !== undefined) upd.label_ceiling = patch.labelCeiling;
    if (patch.accelerator !== undefined) upd.accelerator = patch.accelerator;
    await this.db('pools').where({ id }).update(upd);
  }

  async deletePool(id: string): Promise<void> {
    await this.db('pools').where({ id }).delete();
  }

  // ---------- instances ----------

  async instances(poolId?: string): Promise<InstanceRow[]> {
    const q = this.db('instances');
    if (poolId) q.where({ pool_id: poolId });
    return (await q.orderBy('name')).map(instanceFrom);
  }

  async instance(id: string): Promise<InstanceRow | undefined> {
    const r = await this.db('instances').where({ id }).first();
    return r ? instanceFrom(r) : undefined;
  }

  async createInstance(input: { poolId: string; name: string; url: string; deploy: InstanceRow['deploy']; tls?: InstanceTls | null; settings: InstanceSettings }): Promise<InstanceRow> {
    const t = Date.now();
    const row = { id: ulid(), pool_id: input.poolId, name: input.name, url: input.url, deploy: input.deploy, tls: input.tls ? JSON.stringify(input.tls) : null, settings: JSON.stringify(input.settings), state: 'active', health: 'unknown', health_detail: null, version: null, last_seen_at: null, created_at: t, updated_at: t };
    await this.db('instances').insert(row);
    return instanceFrom(row);
  }

  async updateInstance(id: string, patch: Partial<{ url: string; tls: InstanceTls | null; settings: InstanceSettings; state: InstanceRow['state']; health: InstanceRow['health']; health_detail: string | null; version: string | null; last_seen_at: number }>): Promise<void> {
    const upd: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) upd[k] = k === 'tls' || k === 'settings' ? (v == null ? null : JSON.stringify(v)) : v;
    if (!('health' in patch) || Object.keys(patch).some((k) => !['health', 'health_detail', 'version', 'last_seen_at'].includes(k))) upd.updated_at = Date.now();
    await this.db('instances').where({ id }).update(upd);
  }

  async deleteInstance(id: string): Promise<void> {
    await this.db('instances').where({ id }).delete();
  }

  // ---------- models ----------

  async models(): Promise<ModelRow[]> {
    return (await this.db('models').orderBy('name')).map(modelFrom);
  }

  async model(id: string): Promise<ModelRow | undefined> {
    const r = await this.db('models').where({ id }).first();
    return r ? modelFrom(r) : undefined;
  }

  async modelByName(name: string): Promise<ModelRow | undefined> {
    const r = await this.db('models').where({ name }).first();
    return r ? modelFrom(r) : undefined;
  }

  async createModel(input: { name: string; source: string; expectedDigest: string | null; license: ModelRow['license']; label: Label; notes: string | null; requestedBy: string; requestedTenant: string }): Promise<ModelRow> {
    const t = Date.now();
    const row = {
      id: ulid(),
      name: input.name,
      family: null,
      parameter_size: null,
      quantization: null,
      format: null,
      size_bytes: null,
      context_length: null,
      capabilities: '[]',
      source: input.source,
      expected_digest: input.expectedDigest,
      digest: null,
      license: input.license ? JSON.stringify(input.license) : null,
      label: input.label,
      state: 'draft',
      import_state: 'pending',
      import_error: null,
      evaluation: null,
      requested_by: input.requestedBy,
      requested_tenant: input.requestedTenant,
      approved_by: null,
      approved_at: null,
      retire_at: null,
      notes: input.notes,
      created_at: t,
      updated_at: t
    };
    await this.db('models').insert(row);
    return modelFrom(row);
  }

  async updateModel(id: string, patch: Partial<Omit<ModelRow, 'id' | 'created_at'>>): Promise<void> {
    const upd: Record<string, unknown> = { updated_at: Date.now() };
    for (const [k, v] of Object.entries(patch)) upd[k] = ['capabilities', 'license', 'evaluation'].includes(k) ? (v == null ? null : JSON.stringify(v)) : v;
    await this.db('models').where({ id }).update(upd);
  }

  // ---------- placements ----------

  async placements(): Promise<PlacementRow[]> {
    return (await this.db('placements').orderBy('created_at')).map((r: Record<string, unknown>) => ({ ...(r as unknown as PlacementRow), created_at: Number(r.created_at) }));
  }

  async place(modelId: string, poolId: string, residency: PlacementRow['residency'], by: string): Promise<PlacementRow> {
    const existing = (await this.placements()).find((p) => p.model_id === modelId && p.pool_id === poolId);
    if (existing) {
      await this.db('placements').where({ id: existing.id }).update({ residency });
      return { ...existing, residency };
    }
    const row: PlacementRow = { id: ulid(), model_id: modelId, pool_id: poolId, residency, created_by: by, created_at: Date.now() };
    await this.db('placements').insert(row);
    return row;
  }

  async unplace(id: string): Promise<void> {
    await this.db('placements').where({ id }).delete();
  }

  // ---------- model events ----------

  async event(instanceId: string, model: string, event: 'load' | 'unload' | 'evicted' | 'pull', reason: string | null, actor: string | null): Promise<void> {
    await this.db('model_events').insert({ id: ulid(), instance_id: instanceId, model, event, reason, actor, ts: Date.now() });
  }

  /** Loads on an instance since a time, and when the oldest of them happened (for the anti-thrash window). */
  async loadsSince(instanceId: string, since: number): Promise<{ count: number; oldest: number | null }> {
    const [r] = await this.db('model_events').where({ instance_id: instanceId, event: 'load' }).andWhere('ts', '>=', since).count({ n: '*' }).min({ oldest: 'ts' });
    return { count: Number(r?.n ?? 0), oldest: r?.oldest == null ? null : Number(r.oldest) };
  }

  async events(instanceId: string, limit = 20): Promise<{ model: string; event: string; reason: string | null; actor: string | null; ts: number }[]> {
    return (await this.db('model_events').where({ instance_id: instanceId }).orderBy('ts', 'desc').limit(limit)).map((r: Record<string, unknown>) => ({ model: String(r.model), event: String(r.event), reason: (r.reason as string | null) ?? null, actor: (r.actor as string | null) ?? null, ts: Number(r.ts) }));
  }

  // ---------- profiles ----------

  async profiles(tenantId: string): Promise<ProfileRow[]> {
    return (await this.db('profiles').where({ tenant_id: tenantId }).orderBy('name')).map(profileFrom);
  }

  async profile(tenantId: string, id: string): Promise<ProfileRow | undefined> {
    const r = await this.db('profiles').where({ tenant_id: tenantId, id }).first();
    return r ? profileFrom(r) : undefined;
  }

  async profileByName(tenantId: string, name: string): Promise<ProfileRow | undefined> {
    const r = await this.db('profiles').where({ tenant_id: tenantId, name }).first();
    return r ? profileFrom(r) : undefined;
  }

  private serialise(p: Partial<ProfileRow>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p)) out[k] = ['fallback', 'canary', 'tools'].includes(k) ? (v == null ? null : JSON.stringify(v)) : v;
    return out;
  }

  async createProfile(row: ProfileRow): Promise<void> {
    await this.db('profiles').insert(this.serialise(row));
  }

  async updateProfile(tenantId: string, id: string, patch: Partial<ProfileRow>): Promise<void> {
    await this.db('profiles').where({ tenant_id: tenantId, id }).update(this.serialise({ ...patch, updated_at: Date.now() }));
  }

  async deleteProfile(tenantId: string, id: string): Promise<void> {
    await this.db('profiles').where({ tenant_id: tenantId, id }).delete();
  }

  async snapshot(p: ProfileRow, note: string | null, by: string | null): Promise<void> {
    await this.db('profile_versions').insert({ id: ulid(), profile_id: p.id, version: p.version, snapshot: JSON.stringify(p), note, created_by: by, created_at: Date.now() });
  }

  async versions(profileId: string): Promise<{ version: number; note: string | null; created_by: string | null; created_at: number; snapshot: ProfileRow }[]> {
    return (await this.db('profile_versions').where({ profile_id: profileId }).orderBy('version', 'desc')).map((r: Record<string, unknown>) => ({
      version: Number(r.version),
      note: (r.note as string | null) ?? null,
      created_by: (r.created_by as string | null) ?? null,
      created_at: Number(r.created_at),
      snapshot: json<ProfileRow>(r.snapshot, {} as ProfileRow)
    }));
  }
}
