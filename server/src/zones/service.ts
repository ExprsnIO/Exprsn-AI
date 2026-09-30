import { connect } from 'node:net';
import { ulid } from 'ulid';
import { labelRank, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { isUniqueViolation } from '../audit/chain.js';
import { json } from '../db/knex.js';
import type { PoolRow } from '../gateway/repo.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Scheduler } from '../platform/jobs.js';
import { TOPICS } from '../platform/bus.js';
import type { Services } from '../services.js';
import { diffLines, FORMATS, render, renderAll, type Format, type RenderContext, type RenderZone } from './render.js';
import { DEFAULT_ZONES, EXTERNAL_ZONE, isExternal, RESERVED_IDS, specSchema, validateSet, ZONE_ID, type SetProblem, type ZoneSetMembers, type ZoneSpec, type ZoneSpecPatch } from './spec.js';

type Tenants = () => Promise<{ tenantId: string; payload: Record<string, unknown> }[]>;

export type VersionStatus = 'draft' | 'current' | 'superseded' | 'withdrawn' | 'rejected';

export interface ZoneRow {
  id: string;
  position: number;
  current_version: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface ZoneVersionRow {
  id: string;
  zone_id: string;
  version: number;
  status: VersionStatus;
  spec: ZoneSpec;
  move_pools: string[];
  reason: string | null;
  proposed_by: string | null;
  proposed_at: number | null;
  decided_by: string | null;
  decided_at: number | null;
  decision_note: string | null;
  created_at: number;
  updated_at: number;
}

export interface EndpointRow {
  id: string;
  zone_id: string;
  name: string;
  address: string;
  kind: string;
  state: 'active' | 'drained';
  health: 'unknown' | 'healthy' | 'degraded' | 'unhealthy';
  health_detail: string | null;
  failures: number;
  checks: number;
  failing_since: number | null;
  last_checked_at: number | null;
  last_ok_at: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

/** Something that must move (or be relabelled) before a zone's ceiling can drop to the proposed label. */
export interface Blocker {
  kind: 'pool' | 'placement' | 'profile' | 'connection';
  label: Label;
  pool: string | null;
  model: string | null;
  profile: string | null;
  connection: string | null;
  tenant: string | null;
}

/** One member of a zone as the endpoint-health list shows it. */
export interface Member {
  ref: string;
  name: string;
  kind: 'instance' | 'endpoint' | 'connection' | 'mcp';
  health: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  state: string;
  detail: string | null;
  since: number | null;
  failures: number;
  checks: number;
  address: string | null;
  pool: string | null;
  tenant: string | null;
  drainable: boolean;
}

/** The bus topic that drops every instance's cached zone definitions. */
export const ZONES_CHANGED = 'zones.changed';
const CACHE_MS = 15_000;

const n = (v: unknown): number | null => (v == null ? null : Number(v));

const versionFrom = (r: Record<string, unknown>): ZoneVersionRow => ({
  ...(r as unknown as ZoneVersionRow),
  version: Number(r.version),
  spec: json<ZoneSpec>(r.spec, {} as ZoneSpec),
  move_pools: json<string[]>(r.move_pools, []),
  proposed_at: n(r.proposed_at),
  decided_at: n(r.decided_at),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

const zoneFrom = (r: Record<string, unknown>): ZoneRow => ({
  ...(r as unknown as ZoneRow),
  position: Number(r.position),
  current_version: n(r.current_version),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

const endpointFrom = (r: Record<string, unknown>): EndpointRow => ({
  ...(r as unknown as EndpointRow),
  failures: Number(r.failures),
  checks: Number(r.checks),
  failing_since: n(r.failing_since),
  last_checked_at: n(r.last_checked_at),
  last_ok_at: n(r.last_ok_at),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

const lowest = (a: Label, b: Label): Label => (labelRank(a) <= labelRank(b) ? a : b);
const plural = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

/**
 * Network zones (Sprint 9). Zones are platform-wide, like pools: only system admins (`zones:manage`) see and change
 * them, and every tenant's routing obeys them. A zone is versioned: a proposal creates a draft version, which
 * becomes current only when a second system admin approves it (dual control). The current definitions feed the
 * gateway (a pool's effective ceiling is the lower of its own and its zone's), placement and pool checks, and the
 * rendered NetworkPolicy, Compose and nftables configuration. Reads its collaborators through `s`.
 */
export class ZoneService {
  private cache: { at: number; zones: Promise<Map<string, { version: number; spec: ZoneSpec }>> } | null = null;

  constructor(private readonly s: () => Services) {}

  /** Registers the health sweep, drops the cache on changes from any instance and wires the gateway to the zone ceilings. */
  registerJobs(): void {
    const s = this.s();
    s.bus.on(ZONES_CHANGED, () => {
      this.cache = null;
    });
    s.gateway.zoneCeiling = (zone) => this.ceilingOf(zone);
    s.jobs.register('zones.health', async (_p, ctx) => {
      const out = await this.checkEndpoints();
      await ctx.progress(100, `${out.length} endpoints checked`);
      return { checked: out.length, unhealthy: out.filter((e) => e.health === 'unhealthy').length };
    });
  }

  /** The endpoint health sweep runs once per interval for the whole platform, as a job of the default tenant. */
  schedule(scheduler: Scheduler, _activeTenants: Tenants): void {
    const s = this.s();
    scheduler.every('zones.health', s.cfg.ZONE_HEALTH_MINUTES * 60_000, async () => {
      if (!(await s.db('zone_endpoints').where({ state: 'active' }).first('id'))) return [];
      const t = await s.tenants.bySlug(s.cfg.DEFAULT_TENANT);
      return t ? [{ tenantId: t.id, key: 'platform' }] : [];
    });
  }

  private changed(): void {
    this.cache = null;
    this.s().bus.publish(ZONES_CHANGED, {});
    this.ping();
  }

  /** Tells open Zones screens to refresh (relayed to holders of pools:manage, which every system admin has). */
  private ping(): void {
    this.s().bus.publish(TOPICS.poolState, { tenantId: null, perm: 'pools:manage', event: 'zones.state', data: { at: Date.now() } });
  }

  // ---------- reading ----------

  /** Current definitions by zone id (cached briefly; dropped on every change through the bus). */
  current(): Promise<Map<string, { version: number; spec: ZoneSpec }>> {
    if (!this.cache || Date.now() - this.cache.at > CACHE_MS) {
      const zones = this.loadCurrent();
      this.cache = { at: Date.now(), zones };
      zones.catch(() => {
        this.cache = null;
      });
    }
    return this.cache.zones;
  }

  private async loadCurrent(): Promise<Map<string, { version: number; spec: ZoneSpec }>> {
    const rows = (await this.s().db('zone_versions as v').join('zones as z', function () {
      this.on('z.id', '=', 'v.zone_id').andOn('z.current_version', '=', 'v.version');
    }).orderBy('z.position').orderBy('z.id').select('v.*')) as Record<string, unknown>[];
    return new Map(rows.map(versionFrom).map((v) => [v.zone_id, { version: v.version, spec: v.spec }]));
  }

  /** The label ceiling of a zone, or null when no current definition names it (then no zone ceiling applies). */
  async ceilingOf(zone: string): Promise<Label | null> {
    return (await this.current()).get(zone)?.spec.maxLabel ?? null;
  }

  /** A pool's effective ceiling: the lower of its own and its zone's. */
  async poolCeiling(pool: Pick<PoolRow, 'zone' | 'label_ceiling'>): Promise<Label> {
    const zc = await this.ceilingOf(pool.zone);
    return zc ? lowest(pool.label_ceiling, zc) : pool.label_ceiling;
  }

  /**
   * Refuses a pool in a zone it cannot live in: the external zone (it stays empty), a zone that is not defined once
   * zones are, or a zone whose ceiling is below the pool's own ceiling.
   */
  async assertPoolFits(zone: string, poolCeiling: Label): Promise<void> {
    const zones = await this.current();
    if (!zones.size) return;
    const z = zones.get(zone);
    if (!z) throw new HttpProblem(422, 'Unknown zone', `Zone ${zone} is not defined. Define it under Zones first, or choose one of ${[...zones.keys()].join(', ')}.`, { extensions: { step: 'zone' } });
    if (isExternal(zone, z.spec)) throw forbidden(`The ${zone} zone stays empty: no zone has internet egress in this deployment, so no pool can be placed in it.`, { step: 'zone' });
    if (labelRank(poolCeiling) > labelRank(z.spec.maxLabel)) throw forbidden(`The ${zone} zone's ceiling is ${z.spec.maxLabel}; a pool in it cannot be cleared for ${poolCeiling} data.`, { step: 'zone', zoneCeiling: z.spec.maxLabel });
  }

  /** Refuses a placement of data labelled above the pool's zone ceiling. */
  async assertAdmits(pool: Pick<PoolRow, 'name' | 'zone'>, label: Label): Promise<void> {
    const zc = await this.ceilingOf(pool.zone);
    if (zc && labelRank(label) > labelRank(zc)) throw forbidden(`${pool.name} is in the ${pool.zone} zone, whose ceiling is ${zc}; ${label} models cannot be placed there.`, { step: 'zone', zoneCeiling: zc });
  }

  async zone(id: string): Promise<ZoneRow | undefined> {
    const r = await this.s().db('zones').where({ id }).first();
    return r ? zoneFrom(r) : undefined;
  }

  async versions(zoneId: string): Promise<ZoneVersionRow[]> {
    return ((await this.s().db('zone_versions').where({ zone_id: zoneId }).orderBy('version', 'desc')) as Record<string, unknown>[]).map(versionFrom);
  }

  async version(zoneId: string, version: number): Promise<ZoneVersionRow | undefined> {
    const r = await this.s().db('zone_versions').where({ zone_id: zoneId, version }).first();
    return r ? versionFrom(r) : undefined;
  }

  async draft(zoneId: string): Promise<ZoneVersionRow | undefined> {
    const r = await this.s().db('zone_versions').where({ zone_id: zoneId, status: 'draft' }).orderBy('version', 'desc').first();
    return r ? versionFrom(r) : undefined;
  }

  private async currentVersion(z: ZoneRow): Promise<ZoneVersionRow | undefined> {
    return z.current_version == null ? undefined : this.version(z.id, z.current_version);
  }

  /** Pools, connections, MCP servers and registered endpoints by zone id. */
  async members(): Promise<ZoneSetMembers> {
    const db = this.s().db;
    const [pools, conns, mcp, eps] = await Promise.all([
      this.s().gateway.repo.pools(),
      db('data_connections').select('name', 'zone') as Promise<{ name: string; zone: string }[]>,
      db('mcp_servers').where({ state: 'active' }).select('name', 'zone') as Promise<{ name: string; zone: string }[]>,
      db('zone_endpoints').select('name', 'zone_id') as Promise<{ name: string; zone_id: string }[]>
    ]);
    const byZone: ZoneSetMembers['byZone'] = new Map();
    const at = (z: string) => {
      let m = byZone.get(z);
      if (!m) byZone.set(z, (m = { pools: [], connections: [], mcp: [], endpoints: [] }));
      return m;
    };
    for (const p of pools) at(p.zone).pools.push(p.name);
    for (const c of conns) at(c.zone).connections.push(c.name);
    for (const m of mcp) at(m.zone).mcp.push(m.name);
    for (const e of eps) at(e.zone_id).endpoints.push(e.name);
    return { byZone };
  }

  /**
   * What stands in the way of a zone ceiling: pools whose own ceiling is higher, placements of models labelled above
   * it, profiles above it that route to those pools, and connections above it in the zone. `extraPools` are pools a
   * proposal would move in.
   */
  async blockers(zoneId: string, ceiling: Label, extraPools: string[] = []): Promise<Blocker[]> {
    const s = this.s();
    const [pools, placements, models] = await Promise.all([s.gateway.repo.pools(), s.gateway.repo.placements(), s.gateway.repo.models()]);
    const inZone = pools.filter((p) => p.zone === zoneId || extraPools.includes(p.name));
    const above = (l: Label) => labelRank(l) > labelRank(ceiling);
    const out: Blocker[] = [];
    const blank = { pool: null, model: null, profile: null, connection: null, tenant: null };
    const ids = new Set(inZone.map((p) => p.id));
    for (const p of inZone) if (above(p.label_ceiling)) out.push({ ...blank, kind: 'pool', label: p.label_ceiling, pool: p.name });
    const modelById = new Map(models.map((m) => [m.id, m]));
    const poolById = new Map(pools.map((p) => [p.id, p]));
    for (const pl of placements) {
      const m = modelById.get(pl.model_id);
      if (m && ids.has(pl.pool_id) && above(m.label)) out.push({ ...blank, kind: 'placement', label: m.label, model: m.name, pool: poolById.get(pl.pool_id)!.name });
    }
    if (ids.size) {
      const profiles = (await s.db('profiles as p').leftJoin('tenants as t', 't.id', 'p.tenant_id').whereNot('p.status', 'disabled').select('p.name', 'p.label', 'p.pool_id', 'p.model_id', 't.slug')) as { name: string; label: Label; pool_id: string | null; model_id: string | null; slug: string | null }[];
      for (const pr of profiles) {
        if (!above(pr.label)) continue;
        const reach = pr.pool_id ? (ids.has(pr.pool_id) ? [pr.pool_id] : []) : placements.filter((x) => x.model_id === pr.model_id && ids.has(x.pool_id)).map((x) => x.pool_id);
        for (const pid of reach) out.push({ ...blank, kind: 'profile', label: pr.label, profile: pr.name, tenant: pr.slug, model: pr.model_id ? (modelById.get(pr.model_id)?.name ?? null) : null, pool: poolById.get(pid)?.name ?? null });
      }
    }
    const conns = (await s.db('data_connections as c').leftJoin('tenants as t', 't.id', 'c.tenant_id').where('c.zone', zoneId).select('c.name', 'c.label', 't.slug')) as { name: string; label: Label; slug: string | null }[];
    for (const c of conns) if (above(c.label)) out.push({ ...blank, kind: 'connection', label: c.label, connection: c.name, tenant: c.slug });
    return out;
  }

  // ---------- validation ----------

  private problemsFor(zones: Map<string, ZoneSpec>, members: ZoneSetMembers): SetProblem[] {
    return validateSet(zones, members, this.s().cfg.ZONES_AIR_GAPPED);
  }

  /**
   * Checks a proposed spec against the rest of the current set and the zone's members. Problems the current set
   * already has elsewhere do not block; new ones do (422 "Invalid zone"). A ceiling below what the zone holds is
   * refused with the list of what must move first (422 "Ceiling too low").
   */
  async check(zoneId: string, spec: ZoneSpec, movePools: string[]): Promise<void> {
    const current = await this.loadCurrent();
    const before = new Map([...current].map(([id, z]) => [id, z.spec]));
    const after = new Map(before);
    after.set(zoneId, spec);
    const members = await this.members();
    const moved = await this.s().gateway.repo.pools();
    for (const name of movePools) {
      const pool = moved.find((p) => p.name === name);
      if (!pool) throw notFound(`Pool ${name}`);
    }
    const afterMembers: ZoneSetMembers = { byZone: new Map([...members.byZone].map(([k, v]) => [k, { ...v, pools: v.pools.filter((x) => !movePools.includes(x)) }])) };
    const target = afterMembers.byZone.get(zoneId) ?? { pools: [], connections: [], mcp: [], endpoints: [] };
    afterMembers.byZone.set(zoneId, { ...target, pools: [...target.pools, ...movePools] });
    const known = new Set(this.problemsFor(before, members).map((p) => `${p.zone}|${p.message}`));
    const fresh = this.problemsFor(after, afterMembers).filter((p) => !known.has(`${p.zone}|${p.message}`));
    if (fresh.length) throw new HttpProblem(422, 'Invalid zone', fresh.map((p) => p.message).join(' '), { extensions: { problems: fresh } });
    const blockers = await this.blockers(zoneId, spec.maxLabel, movePools);
    if (blockers.length) {
      const was = current.get(zoneId)?.spec.maxLabel;
      const counts: string[] = [];
      const by = (k: Blocker['kind']) => blockers.filter((b) => b.kind === k).length;
      if (by('placement')) counts.push(plural(by('placement'), 'placed model'));
      if (by('profile')) counts.push(plural(by('profile'), 'profile'));
      if (by('pool')) counts.push(plural(by('pool'), 'pool'));
      if (by('connection')) counts.push(plural(by('connection'), 'connection'));
      const verb = was && labelRank(spec.maxLabel) < labelRank(was) ? `Lowering ${zoneId} to ${spec.maxLabel}` : `A ${spec.maxLabel} ceiling for ${zoneId}`;
      throw new HttpProblem(422, 'Ceiling too low', `${verb} is refused while ${counts.join(', ')} above ${spec.maxLabel} ${blockers.length === 1 ? 'is' : 'are'} there. Move, relabel or deprecate them first.`, { extensions: { step: 'zone-ceiling', zone: zoneId, ceiling: spec.maxLabel, blockers } });
    }
  }

  // ---------- proposals ----------

  /**
   * Proposes a change to a zone as a draft version (or a new zone, as its version 1). `patch` is merged over the
   * zone's current specification. At most one draft per zone is open at a time.
   */
  async propose(p: Principal, zoneId: string, input: { create: boolean; spec?: ZoneSpec; patch?: ZoneSpecPatch; movePools: string[]; reason: string | null }): Promise<ZoneVersionRow> {
    const db = this.s().db;
    if (!ZONE_ID.test(zoneId) || RESERVED_IDS.includes(zoneId)) throw new HttpProblem(422, 'Invalid zone', 'A zone id is lower case letters, digits and dashes, starting with a letter.');
    let z = await this.zone(zoneId);
    let spec: ZoneSpec;
    if (input.create) {
      if (z && (z.current_version != null || (await this.draft(zoneId)))) throw conflict(`Zone ${zoneId} exists. Propose a change to it instead.`);
      if (!input.spec) throw new HttpProblem(422, 'Invalid zone', 'A new zone needs its full definition.');
      spec = input.spec;
    } else {
      if (!z) throw notFound('Zone');
      const cur = await this.currentVersion(z);
      if (!cur) throw conflict(`Zone ${zoneId} has no approved version yet.`);
      const merged = specSchema.safeParse({ ...cur.spec, ...(input.patch ?? {}) });
      if (!merged.success) throw new HttpProblem(422, 'Invalid zone', merged.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      spec = merged.data;
      if (JSON.stringify(spec) === JSON.stringify(cur.spec) && !input.movePools.length) throw conflict('The proposal changes nothing.');
    }
    if (await this.draft(zoneId)) throw conflict(`Zone ${zoneId} already has a draft waiting for review. Approve, reject or withdraw it first.`);
    await this.check(zoneId, spec, input.movePools);
    const t = Date.now();
    if (!z) {
      const max = ((await db('zones').max({ m: 'position' }).first()) as { m: number | null } | undefined)?.m ?? -1;
      z = { id: zoneId, position: Number(max) + 1, current_version: null, created_by: p.userId, created_at: t, updated_at: t };
      try {
        await db('zones').insert(z);
      } catch (err) {
        if (isUniqueViolation(err)) throw conflict(`Zone ${zoneId} was just created by someone else. Reload.`);
        throw err;
      }
    }
    const max = ((await db('zone_versions').where({ zone_id: zoneId }).max({ v: 'version' }).first()) as { v: number | null } | undefined)?.v ?? 0;
    const row: ZoneVersionRow = { id: ulid(), zone_id: zoneId, version: Number(max) + 1, status: 'draft', spec, move_pools: input.movePools, reason: input.reason, proposed_by: p.userId, proposed_at: t, decided_by: null, decided_at: null, decision_note: null, created_at: t, updated_at: t };
    try {
      await db('zone_versions').insert({ ...row, spec: JSON.stringify(spec), move_pools: JSON.stringify(input.movePools) });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('Someone else proposed a change to this zone at the same time. Reload it.');
      throw err;
    }
    await db('zones').where({ id: zoneId }).update({ updated_at: t });
    this.ping();
    return row;
  }

  /** Dual control: a system admin other than the proposer approves, and the draft becomes current (pools move in). */
  async approve(p: Principal, zoneId: string, note: string | null): Promise<{ version: ZoneVersionRow; previous: number | null; moved: string[] }> {
    const db = this.s().db;
    const z = await this.zone(zoneId);
    if (!z) throw notFound('Zone');
    const d = await this.draft(zoneId);
    if (!d) throw notFound('Draft');
    if (d.proposed_by === p.userId) throw forbidden('Dual control: you cannot approve your own proposal. Another system admin must approve it.', { step: 'dual-control' });
    await this.check(zoneId, d.spec, d.move_pools);
    const t = Date.now();
    await db.transaction(async (trx) => {
      const n = await trx('zone_versions').where({ id: d.id, status: 'draft' }).update({ status: 'current', decided_by: p.userId, decided_at: t, decision_note: note, updated_at: t });
      if (!n) throw conflict('The draft changed while you reviewed it. Reload it.');
      if (z.current_version != null) await trx('zone_versions').where({ zone_id: zoneId, version: z.current_version }).update({ status: 'superseded', updated_at: t });
      await trx('zones').where({ id: zoneId }).update({ current_version: d.version, updated_at: t });
      if (d.move_pools.length) await trx('pools').whereIn('name', d.move_pools).update({ zone: zoneId, updated_at: t });
    });
    this.changed();
    return { version: { ...d, status: 'current', decided_by: p.userId, decided_at: t, decision_note: note }, previous: z.current_version, moved: d.move_pools };
  }

  async reject(p: Principal, zoneId: string, note: string | null): Promise<ZoneVersionRow> {
    const d = await this.draft(zoneId);
    if (!d) throw notFound('Draft');
    if (d.proposed_by === p.userId) throw conflict('This is your own proposal: withdraw it instead.');
    const t = Date.now();
    await this.s().db('zone_versions').where({ id: d.id }).update({ status: 'rejected', decided_by: p.userId, decided_at: t, decision_note: note, updated_at: t });
    this.ping();
    return { ...d, status: 'rejected', decided_by: p.userId, decided_at: t, decision_note: note };
  }

  async withdraw(p: Principal, zoneId: string): Promise<ZoneVersionRow> {
    const d = await this.draft(zoneId);
    if (!d) throw notFound('Draft');
    if (d.proposed_by !== p.userId) throw forbidden('Only the proposer can withdraw a draft. Reject it instead.', { step: 'dual-control' });
    await this.s().db('zone_versions').where({ id: d.id }).update({ status: 'withdrawn', updated_at: Date.now() });
    this.ping();
    return { ...d, status: 'withdrawn' };
  }

  /**
   * Creates the default zone set (edge, app, data, directory, inference, sandbox, training, external) for ids that do
   * not exist yet, as approved version 1. A default ceiling is raised to what the zone already holds, so seeding
   * never refuses a request that was allowed before; the response says which were raised.
   */
  async seedDefaults(p: Principal): Promise<{ created: string[]; skipped: string[]; adjusted: { zone: string; from: Label; to: Label }[] }> {
    const db = this.s().db;
    const existing = new Set(((await db('zones').select('id')) as { id: string }[]).map((r) => r.id));
    const created: string[] = [];
    const skipped: string[] = [];
    const adjusted: { zone: string; from: Label; to: Label }[] = [];
    let pos = Number(((await db('zones').max({ m: 'position' }).first()) as { m: number | null } | undefined)?.m ?? -1);
    const t = Date.now();
    for (const d of DEFAULT_ZONES) {
      if (existing.has(d.id)) {
        skipped.push(d.id);
        continue;
      }
      const spec = structuredClone(d.spec);
      if (d.id !== EXTERNAL_ZONE) {
        let high = spec.maxLabel;
        for (const b of await this.blockers(d.id, spec.maxLabel)) if (labelRank(b.label) > labelRank(high)) high = b.label;
        if (high !== spec.maxLabel) {
          adjusted.push({ zone: d.id, from: spec.maxLabel, to: high });
          spec.maxLabel = high;
        }
      }
      try {
        await db.transaction(async (trx) => {
          await trx('zones').insert({ id: d.id, position: ++pos, current_version: 1, created_by: p.userId, created_at: t, updated_at: t });
          await trx('zone_versions').insert({ id: ulid(), zone_id: d.id, version: 1, status: 'current', spec: JSON.stringify(spec), move_pools: '[]', reason: 'Default zone set', proposed_by: p.userId, proposed_at: t, decided_by: p.userId, decided_at: t, decision_note: 'Seeded defaults', created_at: t, updated_at: t });
        });
        created.push(d.id);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        skipped.push(d.id);
      }
    }
    if (created.length) this.changed();
    return { created, skipped, adjusted };
  }

  // ---------- rendering ----------

  private ctx(zones: Map<string, RenderZone>): RenderContext {
    return { zones, corporateCidrs: this.s().cfg.ZONES_CORPORATE_CIDRS.split(',').map((x) => x.trim()).filter(Boolean) };
  }

  private async renderSet(substitute?: RenderZone): Promise<Map<string, RenderZone>> {
    const cur = await this.loadCurrent();
    const out = new Map<string, RenderZone>([...cur].map(([id, z]) => [id, { id, version: z.version, spec: z.spec }]));
    if (substitute) out.set(substitute.id, substitute);
    return out;
  }

  /** The version to show and the one it replaces: the open draft (else current) against current, or version N against the version current before it. */
  async diff(zoneId: string, version?: number) {
    const z = await this.zone(zoneId);
    if (!z) throw notFound('Zone');
    const to = version != null ? await this.version(zoneId, version) : ((await this.draft(zoneId)) ?? (await this.currentVersion(z)));
    if (!to) throw notFound('Version');
    let from: ZoneVersionRow | undefined;
    if (to.status === 'draft') from = await this.currentVersion(z);
    else {
      const r = await this.s().db('zone_versions').where({ zone_id: zoneId }).whereIn('status', ['current', 'superseded']).andWhere('version', '<', to.version).orderBy('version', 'desc').first();
      from = r ? versionFrom(r) : undefined;
    }
    const toZ: RenderZone = { id: zoneId, version: to.version, spec: to.spec, draft: to.status === 'draft' };
    const fromZ: RenderZone | undefined = from ? { id: zoneId, version: from.version, spec: from.spec } : undefined;
    const afterCtx = this.ctx(await this.renderSet(toZ));
    const beforeSet = await this.renderSet(fromZ);
    if (!fromZ) beforeSet.delete(zoneId);
    const beforeCtx = this.ctx(beforeSet);
    const renders = Object.fromEntries(
      FORMATS.map((f) => {
        const before = fromZ ? render(f, fromZ, beforeCtx) : '';
        const after = render(f, toZ, afterCtx);
        return [f, { before, after, ...diffLines(before, after) }];
      })
    ) as Record<Format, { before: string; after: string; text: string; added: number; removed: number }>;
    return { zone: zoneId, from: from ? { version: from.version, status: from.status } : null, to: { version: to.version, status: to.status, reason: to.reason, movePools: to.move_pools, proposedBy: to.proposed_by, proposedAt: to.proposed_at }, renders };
  }

  /** Rendered configuration for download: one zone at a version (default current), or every current zone. */
  async rendered(format: Format, zoneId?: string, version?: number): Promise<{ text: string; filename: string }> {
    const ext = format === 'nftables' ? 'nft' : 'yaml';
    if (!zoneId) return { text: renderAll(format, this.ctx(await this.renderSet())), filename: `exprsn-zones.${format}.${ext}` };
    const z = await this.zone(zoneId);
    if (!z) throw notFound('Zone');
    const v = version != null ? await this.version(zoneId, version) : await this.currentVersion(z);
    if (!v) throw notFound('Version');
    const rz: RenderZone = { id: zoneId, version: v.version, spec: v.spec, draft: v.status === 'draft' };
    return { text: render(format, rz, this.ctx(await this.renderSet(rz))), filename: `${zoneId}-v${v.version}.${format}.${ext}` };
  }

  // ---------- members and health ----------

  /** Every member of every zone with its health: pool instances (from the gateway poller), endpoints, connections, MCP servers. */
  async memberHealth(): Promise<Map<string, { pools: { id: string; name: string; labelCeiling: Label; effectiveCeiling: Label; instances: number }[]; members: Member[] }>> {
    const s = this.s();
    const [snap, eps, conns, mcp] = await Promise.all([
      s.gateway.snapshot(),
      s.db('zone_endpoints').orderBy('name') as Promise<Record<string, unknown>[]>,
      s.db('data_connections as c').leftJoin('tenants as t', 't.id', 'c.tenant_id').select('c.id', 'c.name', 'c.zone', 'c.health', 'c.health_detail', 'c.checked_at', 't.slug') as Promise<Record<string, unknown>[]>,
      s.db('mcp_servers as m').leftJoin('tenants as t', 't.id', 'm.tenant_id').where('m.state', 'active').select('m.id', 'm.name', 'm.zone', 'm.health', 'm.health_detail', 'm.last_checked_at', 'm.last_ok_at', 'm.failures', 'm.url', 't.slug') as Promise<Record<string, unknown>[]>
    ]);
    const out = new Map<string, { pools: { id: string; name: string; labelCeiling: Label; effectiveCeiling: Label; instances: number }[]; members: Member[] }>();
    const at = (z: string) => {
      let v = out.get(z);
      if (!v) out.set(z, (v = { pools: [], members: [] }));
      return v;
    };
    const blank = { detail: null, since: null, failures: 0, checks: 0, address: null, pool: null, tenant: null, drainable: false };
    for (const p of snap) {
      at(p.zone).pools.push({ id: p.id, name: p.name, labelCeiling: p.label_ceiling, effectiveCeiling: await this.poolCeiling(p), instances: p.instances.length });
      for (const i of p.instances) {
        const health = i.health === 'unreachable' ? 'unhealthy' : i.health;
        at(p.zone).members.push({ ...blank, ref: `instance:${i.id}`, name: i.name, kind: 'instance', health, state: i.state, detail: i.health_detail, since: i.last_seen_at, address: i.url, pool: p.name, drainable: true });
      }
    }
    for (const e of eps.map(endpointFrom)) {
      at(e.zone_id).members.push({ ...blank, ref: `endpoint:${e.id}`, name: e.name, kind: 'endpoint', health: e.health, state: e.state, detail: e.health_detail, since: e.health === 'healthy' ? e.last_ok_at : e.failing_since, failures: e.failures, checks: e.checks, address: e.address, drainable: true });
    }
    for (const c of conns) {
      const h = String(c.health);
      at(String(c.zone)).members.push({ ...blank, ref: `connection:${String(c.id)}`, name: String(c.name), kind: 'connection', health: h === 'unreachable' ? 'unhealthy' : (h as Member['health']), state: 'active', detail: (c.health_detail as string | null) ?? null, since: n(c.checked_at), tenant: (c.slug as string | null) ?? null });
    }
    for (const m of mcp) {
      const h = String(m.health);
      const health: Member['health'] = h === 'healthy' ? 'healthy' : h === 'changed' ? 'degraded' : h === 'unreachable' || h === 'incompatible' ? 'unhealthy' : 'unknown';
      at(String(m.zone)).members.push({ ...blank, ref: `mcp:${String(m.id)}`, name: String(m.name), kind: 'mcp', health, state: 'active', detail: (m.health_detail as string | null) ?? null, since: health === 'healthy' ? n(m.last_ok_at) : n(m.last_checked_at), failures: Number(m.failures ?? 0), address: String(m.url), tenant: (m.slug as string | null) ?? null });
    }
    return out;
  }

  /** Zones for the console: current definition, open draft, members with health, and set-wide problems. */
  async overview(p: Principal) {
    const s = this.s();
    const rows = ((await s.db('zones').orderBy('position').orderBy('id')) as Record<string, unknown>[]).map(zoneFrom);
    const all = ((await s.db('zone_versions').whereIn('status', ['current', 'draft'])) as Record<string, unknown>[]).map(versionFrom);
    const health = await this.memberHealth();
    const people = [...new Set(all.map((v) => v.proposed_by).filter((x): x is string => !!x))];
    const names = new Map(((people.length ? await s.db('users').whereIn('id', people).select('id', 'display_name') : []) as { id: string; display_name: string }[]).map((u) => [u.id, u.display_name]));
    const zones = rows
      .map((z) => {
        const cur = all.find((v) => v.zone_id === z.id && v.status === 'current');
        const d = all.find((v) => v.zone_id === z.id && v.status === 'draft');
        const h = health.get(z.id) ?? { pools: [], members: [] };
        return {
          id: z.id,
          position: z.position,
          version: cur?.version ?? null,
          spec: cur?.spec ?? null,
          external: isExternal(z.id, (cur ?? d)?.spec ?? ({ trust: 'private' } as ZoneSpec)),
          draft: d ? { version: d.version, spec: d.spec, reason: d.reason, movePools: d.move_pools, proposedBy: d.proposed_by, proposedByName: d.proposed_by ? (names.get(d.proposed_by) ?? null) : null, proposedAt: d.proposed_at, mine: d.proposed_by === p.userId } : null,
          pools: h.pools,
          members: h.members
        };
      })
      .filter((z) => z.spec || z.draft);
    const defined = new Set(zones.filter((z) => z.spec).map((z) => z.id));
    const undefinedRefs = [...health].filter(([id, h]) => !defined.has(id) && (h.pools.length || h.members.length)).map(([id, h]) => ({ zone: id, pools: h.pools.map((x) => x.name), members: h.members.filter((m) => m.kind !== 'instance').map((m) => `${m.kind} ${m.name}`) }));
    const cur = new Map(zones.filter((z) => z.spec).map((z) => [z.id, z.spec!]));
    const problems = this.problemsFor(cur, await this.members());
    const last = (await s.db('audit_events').where({ tenant_id: p.tenantId }).andWhere('action', 'like', 'zone.%').orderBy('ts', 'desc').first('id', 'action', 'ts', 'target')) as { id: string; action: string; ts: number; target: unknown } | undefined;
    return {
      airGapped: s.cfg.ZONES_AIR_GAPPED,
      corporateCidrs: this.ctx(new Map()).corporateCidrs,
      zones,
      undefinedRefs,
      problems,
      defaults: DEFAULT_ZONES.map((d) => d.id).filter((id) => !rows.some((r) => r.id === id)),
      lastChange: last ? { id: last.id, action: last.action, ts: Number(last.ts), target: json<Record<string, unknown>>(last.target, {}) } : null
    };
  }

  // ---------- endpoints ----------

  async endpoint(zoneId: string, id: string): Promise<EndpointRow | undefined> {
    const r = await this.s().db('zone_endpoints').where({ zone_id: zoneId, id }).first();
    return r ? endpointFrom(r) : undefined;
  }

  async addEndpoint(p: Principal, zoneId: string, input: { name: string; address: string; kind: string }): Promise<EndpointRow> {
    const cur = (await this.current()).get(zoneId);
    if (!cur) throw notFound('Zone');
    if (isExternal(zoneId, cur.spec)) throw forbidden(`The ${zoneId} zone stays empty: no endpoint can be registered in it.`, { step: 'zone' });
    const t = Date.now();
    const row: EndpointRow = { id: ulid(), zone_id: zoneId, name: input.name, address: input.address, kind: input.kind, state: 'active', health: 'unknown', health_detail: null, failures: 0, checks: 0, failing_since: null, last_checked_at: null, last_ok_at: null, created_by: p.userId, created_at: t, updated_at: t };
    try {
      await this.s().db('zone_endpoints').insert(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`An endpoint named ${input.name} exists in ${zoneId}.`);
      throw err;
    }
    return (await this.checkEndpoints(zoneId, row.id))[0] ?? row;
  }

  async removeEndpoint(zoneId: string, id: string): Promise<EndpointRow> {
    const e = await this.endpoint(zoneId, id);
    if (!e) throw notFound('Endpoint');
    await this.s().db('zone_endpoints').where({ id }).delete();
    this.ping();
    return e;
  }

  async setEndpointState(zoneId: string, id: string, state: EndpointRow['state']): Promise<EndpointRow> {
    const e = await this.endpoint(zoneId, id);
    if (!e) throw notFound('Endpoint');
    await this.s().db('zone_endpoints').where({ id }).update({ state, updated_at: Date.now() });
    this.ping();
    return { ...e, state };
  }

  /** Checks active registered endpoints (all, one zone's, or one): an HTTP GET for URLs, a TCP connect for host:port. */
  async checkEndpoints(zoneId?: string, id?: string): Promise<EndpointRow[]> {
    const s = this.s();
    const q = s.db('zone_endpoints').where({ state: 'active' });
    if (zoneId) q.andWhere({ zone_id: zoneId });
    if (id) q.andWhere({ id });
    const rows = ((await q) as Record<string, unknown>[]).map(endpointFrom);
    const out: EndpointRow[] = [];
    let flipped = false;
    await Promise.all(
      rows.map(async (e) => {
        const r = await probe(e.address, s.cfg.ZONE_HEALTH_TIMEOUT_MS);
        const t = Date.now();
        const next: EndpointRow = r.ok
          ? { ...e, health: 'healthy', health_detail: r.detail, failures: 0, checks: 0, failing_since: null, last_checked_at: t, last_ok_at: t }
          : { ...e, failures: e.failures + 1, checks: e.checks + 1, failing_since: e.failing_since ?? t, last_checked_at: t, health_detail: r.detail, health: e.failures + 1 >= s.cfg.ZONE_HEALTH_FAILURES ? 'unhealthy' : 'degraded' };
        if (next.health !== e.health) flipped = true;
        await s.db('zone_endpoints').where({ id: e.id }).update({ health: next.health, health_detail: next.health_detail?.slice(0, 300) ?? null, failures: next.failures, checks: next.checks, failing_since: next.failing_since, last_checked_at: t, last_ok_at: next.last_ok_at });
        out.push(next);
      })
    );
    if (flipped) this.ping();
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}

/** One health check. Only system admins register endpoints; addresses are theirs to choose, like pool instance URLs. */
export async function probe(address: string, timeoutMs: number): Promise<{ ok: boolean; detail: string | null }> {
  const started = Date.now();
  if (/^https?:\/\//i.test(address)) {
    try {
      const res = await fetch(address, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      await res.body?.cancel().catch(() => undefined);
      const ms = Date.now() - started;
      return res.status < 500 ? { ok: true, detail: `HTTP ${res.status} in ${ms} ms` } : { ok: false, detail: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).name === 'TimeoutError' ? `No answer within ${timeoutMs} ms` : ((err as Error & { cause?: { code?: string } }).cause?.code ?? (err as Error).message) };
    }
  }
  const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(address);
  if (!m) return { ok: false, detail: 'Not a URL or host:port' };
  return new Promise((resolve) => {
    const sock = connect({ host: m[1]!, port: Number(m[2]) });
    const done = (ok: boolean, detail: string) => {
      sock.destroy();
      resolve({ ok, detail });
    };
    sock.setTimeout(timeoutMs, () => done(false, `No answer within ${timeoutMs} ms`));
    sock.once('connect', () => done(true, `TCP connect in ${Date.now() - started} ms`));
    sock.once('error', (err: NodeJS.ErrnoException) => done(false, err.code ?? err.message));
  });
}
