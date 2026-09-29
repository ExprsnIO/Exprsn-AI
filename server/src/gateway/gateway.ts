import type { Logger } from 'pino';
import { labelRank, type Label } from '../authz/labels.js';
import { HttpProblem, tooManyRequests } from '../http/problem.js';
import { TOPICS, type Bus } from '../platform/bus.js';
import type { JobContext, JobQueue } from '../platform/jobs.js';
import { OllamaClient, OllamaError, type PsModel, type TagModel } from './ollama.js';
import type { Evaluation, GatewayRepo, InstanceRow, ModelRow, PoolRow, ProfileRow } from './repo.js';

export interface GatewayOptions {
  pollMs: number;
  timeoutMs: number;
  maxInflight: number;
  maxLoadsPer10Min: number;
  queueTimeoutMs: number;
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  onPosition?: (n: number) => void;
}

interface Runtime {
  row: InstanceRow;
  client: OllamaClient;
  ps: PsModel[];
  tags: TagModel[];
  latencyMs: number | null;
  firstTokenMs: number | null;
  inflight: number;
  waiting: Waiter[];
  loading: Set<string>;
  unloading: Set<string>;
  /** Models we asked Ollama to unload; their disappearance is not an eviction. */
  expectedGone: Set<string>;
}

export interface Lease {
  instance: InstanceRow;
  pool: PoolRow;
  client: OllamaClient;
  model: ModelRow;
  /** The model was not resident when the request was admitted: expect a load before the first token. */
  cold: boolean;
  release(firstTokenMs?: number | null): void;
}

export interface ResolvedProfile {
  profile: ProfileRow;
  /** Alias chain followed, first to last. */
  via: string[];
  model: ModelRow;
  canary: boolean;
}

const ESTIMATE_OVERHEAD = 1.2;
const norm = (d: string | null | undefined) => (d ?? '').replace(/^sha256:/, '').toLowerCase();
const sameModel = (a: string, b: string) => a === b || a === `${b}:latest` || `${a}:latest` === b;

export class QueueTimeout extends Error {}

/**
 * The Ollama gateway: the only component that talks to Ollama. It polls every instance's /api/version, /api/ps and
 * /api/tags, keeps health and residency, plans memory before a load, limits load churn per instance, leases
 * request slots (queueing when an instance is at its parallel limit), and runs pull, evaluation and rolling-upgrade
 * jobs. Pools and instances are shared by every tenant; profiles are per tenant.
 */
export class Gateway {
  private readonly runtimes = new Map<string, Runtime>();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    readonly repo: GatewayRepo,
    private readonly bus: Bus,
    private readonly log: Logger,
    private readonly o: GatewayOptions,
    jobs: JobQueue
  ) {
    jobs.register('model.pull', (p, ctx) => this.pullJob(String(p.modelId), String(p.poolId), ctx), { timeoutMs: 6 * 60 * 60_000 });
    jobs.register('model.evaluate', (p, ctx) => this.evaluateJob(String(p.modelId), ctx), { timeoutMs: 30 * 60_000 });
    jobs.register('pool.upgrade', (p, ctx) => this.upgradeJob(String(p.poolId), String(p.targetVersion), Number(p.waitMs ?? 30 * 60_000), ctx), { timeoutMs: 12 * 60 * 60_000 });
  }

  start(): void {
    if (this.timer) return;
    const tick = async () => {
      await this.pollAll().catch((err) => this.log.warn({ err }, 'gateway poll failed'));
      this.timer = setTimeout(tick, this.o.pollMs);
      this.timer.unref();
    };
    void tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const r of this.runtimes.values()) {
      for (const w of r.waiting) w.reject(new Error('shutting down'));
      await r.client.close().catch(() => undefined);
    }
    this.runtimes.clear();
  }

  private runtime(row: InstanceRow): Runtime {
    let r = this.runtimes.get(row.id);
    if (r && (r.row.url !== row.url || JSON.stringify(r.row.tls) !== JSON.stringify(row.tls))) {
      void r.client.close().catch(() => undefined);
      r = undefined;
    }
    if (!r) {
      r = { row, client: new OllamaClient(row.url, row.tls, this.o.timeoutMs), ps: [], tags: [], latencyMs: null, firstTokenMs: null, inflight: 0, waiting: [], loading: new Set(), unloading: new Set(), expectedGone: new Set() };
      this.runtimes.set(row.id, r);
    } else {
      r.row = { ...row, health: r.row.health, health_detail: r.row.health_detail, version: r.row.version, last_seen_at: r.row.last_seen_at };
    }
    return r;
  }

  /** Polls every instance once. Instance rows are re-read so changes made through another server apply here. */
  async pollAll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const rows = await this.repo.instances();
      const ids = new Set(rows.map((r) => r.id));
      for (const [id, r] of this.runtimes) {
        if (!ids.has(id)) {
          for (const w of r.waiting) w.reject(new Error('instance removed'));
          void r.client.close().catch(() => undefined);
          this.runtimes.delete(id);
        }
      }
      await Promise.all(rows.map((row) => this.poll(this.runtime(row))));
      this.publish();
    } finally {
      this.polling = false;
    }
  }

  async pollOne(instanceId: string): Promise<void> {
    const row = await this.repo.instance(instanceId);
    if (row) await this.poll(this.runtime(row));
    this.publish();
  }

  private async poll(r: Runtime): Promise<void> {
    if (r.row.state === 'disabled') {
      r.row.health = 'unknown';
      return;
    }
    const t0 = Date.now();
    try {
      const [version, ps, tags] = await Promise.all([r.client.version(), r.client.ps(), r.client.tags()]);
      r.latencyMs = Date.now() - t0;
      const before = r.ps.map((m) => m.name);
      for (const name of before) {
        if (!ps.some((m) => m.name === name) && !r.expectedGone.has(name)) void this.repo.event(r.row.id, name, 'evicted', 'No longer resident: its keep-alive expired or Ollama evicted it for memory', 'ollama');
      }
      r.expectedGone.clear();
      r.ps = ps;
      r.tags = tags;
      const health = r.latencyMs > this.o.timeoutMs / 2 ? 'degraded' : 'healthy';
      const detail = health === 'degraded' ? `Slow to answer (${r.latencyMs} ms)` : null;
      const changed = r.row.health !== health || r.row.version !== version || r.row.health_detail !== detail;
      Object.assign(r.row, { health, version, health_detail: detail, last_seen_at: Date.now() });
      if (changed || !r.row.last_seen_at || Date.now() % 60_000 < this.o.pollMs) await this.repo.updateInstance(r.row.id, { health, version, health_detail: detail, last_seen_at: Date.now() });
    } catch (err) {
      const detail = `Not answering: ${(err as Error).message}`.slice(0, 300);
      if (r.row.health !== 'unreachable') this.log.warn({ instance: r.row.name, err: (err as Error).message }, 'Ollama instance unreachable');
      const changed = r.row.health !== 'unreachable';
      Object.assign(r.row, { health: 'unreachable', health_detail: detail });
      if (changed) await this.repo.updateInstance(r.row.id, { health: 'unreachable', health_detail: detail });
    }
  }

  private publish(): void {
    this.bus.emitLocal(TOPICS.poolState, { tenantId: null, perm: 'pools:manage', event: 'pools.state', data: { at: Date.now() } });
  }

  // ---------- views ----------

  /** Live state of every pool and instance, with the memory planner's view. */
  async snapshot() {
    const [pools, rows, models, placements] = await Promise.all([this.repo.pools(), this.repo.instances(), this.repo.models(), this.repo.placements()]);
    const byName = new Map(models.map((m) => [m.name, m]));
    return pools.map((p) => ({
      ...p,
      placements: placements.filter((x) => x.pool_id === p.id).map((x) => ({ ...x, model: models.find((m) => m.id === x.model_id)?.name ?? x.model_id })),
      instances: rows
        .filter((i) => i.pool_id === p.id)
        .map((row) => {
          const r = this.runtimes.get(row.id);
          const ps = r?.ps ?? [];
          const memory = this.memory(row, ps);
          return {
            ...row,
            health: r?.row.health ?? row.health,
            health_detail: r?.row.health_detail ?? row.health_detail,
            version: r?.row.version ?? row.version,
            last_seen_at: r?.row.last_seen_at ?? row.last_seen_at,
            latencyMs: r?.latencyMs ?? null,
            firstTokenMs: r?.firstTokenMs ?? null,
            inflight: r?.inflight ?? 0,
            queued: r?.waiting.length ?? 0,
            parallel: this.parallel(row),
            memory,
            loaded: ps.map((m) => {
              const cat = byName.get(m.name) ?? [...byName.values()].find((x) => sameModel(x.name, m.name));
              const placement = cat ? placements.find((x) => x.model_id === cat.id && x.pool_id === p.id) : undefined;
              const estimate = cat?.size_bytes ? Math.round(cat.size_bytes * ESTIMATE_OVERHEAD) : null;
              const measured = m.size_vram || m.size;
              return {
                name: m.name,
                sizeBytes: measured,
                vramBytes: m.size_vram,
                expiresAt: m.expires_at ?? null,
                residency: r?.unloading.has(m.name) ? 'draining' : (placement?.residency ?? 'warm'),
                estimateBytes: estimate,
                drift: estimate ? Math.abs(measured - estimate) / estimate > 0.1 : false
              };
            }),
            loading: [...(r?.loading ?? [])],
            available: (r?.tags ?? []).map((t) => ({ name: t.name, sizeBytes: t.size, digest: t.digest }))
          };
        })
    }));
  }

  private parallel(row: InstanceRow): number {
    return row.settings.parallel ?? this.o.maxInflight;
  }

  memory(row: InstanceRow, ps: PsModel[]): { totalBytes: number | null; usedBytes: number; freeBytes: number | null } {
    const used = ps.reduce((a, m) => a + (m.size_vram || m.size), 0);
    const total = row.settings.memoryBytes ?? null;
    return { totalBytes: total, usedBytes: used, freeBytes: total == null ? null : Math.max(0, total - used) };
  }

  // ---------- memory planner and loads ----------

  /**
   * Plans a load: does the model fit next to what is resident, and if not, which warm (unpinned) models would be
   * evicted, least recently expiring first. Pinned models are never evicted by the planner.
   */
  async plan(instanceId: string, modelName: string) {
    const row = await this.repo.instance(instanceId);
    if (!row) throw new HttpProblem(404, 'Not found', 'Instance not found.');
    const r = this.runtime(row);
    const model = await this.catalogModel(modelName);
    const pinned = new Set((await this.repo.placements()).filter((p) => p.pool_id === row.pool_id && p.residency === 'pinned').map((p) => p.model_id));
    const models = await this.repo.models();
    const isPinned = (name: string) => models.some((m) => sameModel(m.name, name) && pinned.has(m.id));
    const need = Math.round((model.size_bytes ?? r.tags.find((t) => sameModel(t.name, model.name))?.size ?? 0) * ESTIMATE_OVERHEAD);
    const mem = this.memory(row, r.ps);
    const resident = r.ps.some((m) => sameModel(m.name, model.name));
    const maxLoaded = row.settings.maxLoaded ?? null;
    if (resident) return { fits: true, resident: true, needBytes: need, freeBytes: mem.freeBytes, evict: [] as string[], reason: 'Already resident' };
    if (mem.totalBytes == null) {
      const over = maxLoaded != null && r.ps.length >= maxLoaded;
      return { fits: !over, resident: false, needBytes: need, freeBytes: null, evict: over ? [this.lru(r.ps.filter((m) => !isPinned(m.name)))].filter(Boolean) as string[] : [], reason: over ? `At the ${maxLoaded}-model limit` : 'No memory size declared for this instance; Ollama decides' };
    }
    let free = mem.freeBytes ?? 0;
    const evict: string[] = [];
    const candidates = r.ps.filter((m) => !isPinned(m.name)).sort((a, b) => Date.parse(a.expires_at ?? '0') - Date.parse(b.expires_at ?? '0'));
    let count = r.ps.length;
    while ((free < need || (maxLoaded != null && count >= maxLoaded)) && candidates.length) {
      const m = candidates.shift()!;
      evict.push(m.name);
      free += m.size_vram || m.size;
      count--;
    }
    const fits = free >= need && (maxLoaded == null || count < maxLoaded);
    return { fits, resident: false, needBytes: need, freeBytes: mem.freeBytes, evict: fits ? evict : [], reason: fits ? (evict.length ? `Fits after evicting ${evict.join(', ')}` : 'Fits in free memory') : 'Does not fit even after evicting every unpinned model' };
  }

  private lru(ps: PsModel[]): string | undefined {
    return [...ps].sort((a, b) => Date.parse(a.expires_at ?? '0') - Date.parse(b.expires_at ?? '0'))[0]?.name;
  }

  private async catalogModel(name: string): Promise<ModelRow> {
    const m = (await this.repo.modelByName(name)) ?? (await this.repo.models()).find((x) => sameModel(x.name, name));
    if (!m) throw new HttpProblem(404, 'Not found', `Model ${name} is not in the catalogue.`);
    return m;
  }

  /** Anti-thrash: at most N loads per instance in any ten minutes. */
  private async checkThrash(row: InstanceRow): Promise<void> {
    const since = Date.now() - 10 * 60_000;
    const n = await this.repo.loadsSince(row.id, since);
    if (n >= this.o.maxLoadsPer10Min) {
      const p = tooManyRequests(`${row.name} has loaded ${n} models in the last ten minutes, its anti-thrash limit. Further loads wait until the window clears.`, 60);
      Object.assign(p.extensions, { limit: 'anti_thrash', loads: n, max: this.o.maxLoadsPer10Min });
      throw p;
    }
  }

  async load(instanceId: string, modelName: string, opts: { pinned?: boolean; actor: string; reason?: string }): Promise<{ evicted: string[] }> {
    const row = await this.repo.instance(instanceId);
    if (!row) throw new HttpProblem(404, 'Not found', 'Instance not found.');
    if (row.state !== 'active') throw new HttpProblem(409, 'Conflict', `${row.name} is ${row.state}; loads are refused.`);
    const model = await this.catalogModel(modelName);
    if (!['approved', 'deprecated', 'evaluated', 'draft'].includes(model.state) || model.import_state !== 'pulled') throw new HttpProblem(409, 'Conflict', `${model.name} is ${model.state === 'retired' ? 'retired' : 'not pulled yet'}.`);
    const r = this.runtime(row);
    if (!r.tags.some((t) => sameModel(t.name, model.name))) throw new HttpProblem(409, 'Conflict', `${model.name} is not pulled on ${row.name}. Place it on the pool and pull it first.`);
    await this.checkThrash(row);
    const plan = await this.plan(instanceId, model.name);
    if (!plan.fits) throw new HttpProblem(409, 'No spare memory', `${model.name} needs about ${fmtGb(plan.needBytes)} and ${row.name} cannot make room without evicting a pinned model.`, { extensions: { plan } });
    for (const name of plan.evict) {
      r.expectedGone.add(name);
      await r.client.unload(name);
      await this.repo.event(row.id, name, 'unload', `Evicted by the planner to make room for ${model.name}`, opts.actor);
    }
    r.loading.add(model.name);
    this.publish();
    try {
      await r.client.load(model.name, opts.pinned ? -1 : (row.settings.keepAlive ?? '30m'));
      await this.repo.event(row.id, model.name, 'load', opts.reason ?? (opts.pinned ? 'Pinned' : 'Loaded on request'), opts.actor);
    } finally {
      r.loading.delete(model.name);
      await this.poll(r);
      this.publish();
    }
    return { evicted: plan.evict };
  }

  async unload(instanceId: string, modelName: string, actor: string): Promise<void> {
    const row = await this.repo.instance(instanceId);
    if (!row) throw new HttpProblem(404, 'Not found', 'Instance not found.');
    const r = this.runtime(row);
    r.expectedGone.add(modelName);
    r.unloading.add(modelName);
    try {
      await r.client.unload(modelName);
      await this.repo.event(row.id, modelName, 'unload', 'Unloaded on request', actor);
    } finally {
      r.unloading.delete(modelName);
      await this.poll(r);
      this.publish();
    }
  }

  /** Stops routing to an instance, waits for its requests to finish, then unloads everything. */
  async drain(instanceId: string, actor: string, waitMs = 10 * 60_000): Promise<{ unloaded: string[] }> {
    await this.repo.updateInstance(instanceId, { state: 'draining' });
    const row = (await this.repo.instance(instanceId))!;
    const r = this.runtime(row);
    r.row.state = 'draining';
    for (const w of r.waiting.splice(0)) w.reject(new QueueTimeout('The instance is draining'));
    const until = Date.now() + waitMs;
    while (r.inflight > 0 && Date.now() < until) await new Promise((res) => setTimeout(res, 200));
    await this.poll(r);
    const unloaded: string[] = [];
    for (const m of r.ps) {
      r.expectedGone.add(m.name);
      await r.client.unload(m.name).catch(() => undefined);
      await this.repo.event(row.id, m.name, 'unload', 'Instance drained', actor);
      unloaded.push(m.name);
    }
    await this.poll(r);
    this.publish();
    return { unloaded };
  }

  async undrain(instanceId: string): Promise<void> {
    await this.repo.updateInstance(instanceId, { state: 'active' });
    const row = await this.repo.instance(instanceId);
    if (row) this.runtime(row).row.state = 'active';
    this.publish();
  }

  // ---------- routing ----------

  /** Follows aliases and picks the canary model for this request when a canary is running. */
  async resolve(tenantId: string, nameOrId: string, rand = Math.random()): Promise<ResolvedProfile> {
    const via: string[] = [];
    let p = (await this.repo.profile(tenantId, nameOrId)) ?? (await this.repo.profileByName(tenantId, nameOrId));
    for (let depth = 0; p?.alias_of && depth < 5; depth++) {
      via.push(p.name);
      p = await this.repo.profile(tenantId, p.alias_of);
    }
    if (!p || p.alias_of) throw new HttpProblem(404, 'Not found', `Profile ${nameOrId} not found.`);
    if (p.status !== 'published') throw new HttpProblem(409, 'Conflict', `Profile ${p.name} is ${p.status}.`);
    let canary = false;
    let modelId = p.model_id;
    if (p.canary && rand * 100 < p.canary.percent) {
      modelId = p.canary.modelId;
      canary = true;
    }
    const model = modelId ? await this.repo.model(modelId) : undefined;
    if (!model) throw new HttpProblem(409, 'Conflict', `Profile ${p.name} has no model.`);
    return { profile: p, via, model, canary };
  }

  /** Pools a model may run in for this profile: the profile's own, or every pool with a placement. */
  private async poolsFor(profile: ProfileRow, model: ModelRow): Promise<PoolRow[]> {
    const pools = await this.repo.pools();
    if (profile.pool_id) return pools.filter((p) => p.id === profile.pool_id);
    const placed = new Set((await this.repo.placements()).filter((x) => x.model_id === model.id).map((x) => x.pool_id));
    return pools.filter((p) => placed.has(p.id));
  }

  /**
   * Leases a slot on an instance that can serve the model: healthy, active, with the model pulled. Instances with
   * the model resident win, then the least busy. When every candidate is at its parallel limit the request waits in
   * line (onPosition reports its place) until a slot frees or `waitMs` passes.
   */
  async acquire(profile: ProfileRow, model: ModelRow, label: Label, opts: { signal: AbortSignal; waitMs?: number; onPosition?: (n: number) => void }): Promise<Lease> {
    if (model.state === 'retired') throw new HttpProblem(409, 'Conflict', `${model.name} is retired.`);
    if (!['approved', 'deprecated'].includes(model.state)) throw new HttpProblem(409, 'Conflict', `${model.name} is not approved.`);
    const pools = (await this.poolsFor(profile, model)).filter((p) => labelRank(p.label_ceiling) >= labelRank(label));
    if (!pools.length) throw new HttpProblem(503, 'No capacity', `No pool cleared for ${label} data runs ${model.name}.`, { extensions: { step: 'zone' } });
    const poolById = new Map(pools.map((p) => [p.id, p]));
    const candidates = () =>
      [...this.runtimes.values()].filter((r) => poolById.has(r.row.pool_id) && r.row.state === 'active' && (r.row.health === 'healthy' || r.row.health === 'degraded') && r.tags.some((t) => sameModel(t.name, model.name)));
    if (!candidates().length) {
      await this.pollAll();
      if (!candidates().length) throw new HttpProblem(503, 'No capacity', `No healthy instance has ${model.name} available.`);
    }
    const deadline = Date.now() + (opts.waitMs ?? this.o.queueTimeoutMs);
    for (;;) {
      const list = candidates();
      if (!list.length) throw new HttpProblem(503, 'No capacity', `No healthy instance has ${model.name} available.`);
      const free = list.filter((r) => r.inflight < this.parallel(r.row));
      if (free.length) {
        free.sort((a, b) => Number(b.ps.some((m) => sameModel(m.name, model.name))) - Number(a.ps.some((m) => sameModel(m.name, model.name))) || a.inflight / this.parallel(a.row) - b.inflight / this.parallel(b.row));
        const r = free[0]!;
        r.inflight++;
        let released = false;
        return {
          instance: r.row,
          pool: poolById.get(r.row.pool_id)!,
          client: r.client,
          model,
          cold: !r.ps.some((m) => sameModel(m.name, model.name)),
          release: (ftok) => {
            if (released) return;
            released = true;
            r.inflight--;
            if (ftok != null) r.firstTokenMs = r.firstTokenMs == null ? ftok : Math.round(r.firstTokenMs * 0.8 + ftok * 0.2);
            this.wake(r);
          }
        };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new QueueTimeout(`Every instance serving ${model.name} is busy.`);
      // Wait on the least-queued instance for a slot, then re-pick.
      const target = list.sort((a, b) => a.waiting.length - b.waiting.length)[0]!;
      await new Promise<void>((resolve, reject) => {
        const w: Waiter = { resolve, reject, ...(opts.onPosition ? { onPosition: opts.onPosition } : {}) };
        target.waiting.push(w);
        opts.onPosition?.(target.waiting.length);
        const t = setTimeout(() => {
          const i = target.waiting.indexOf(w);
          if (i >= 0) target.waiting.splice(i, 1);
          reject(new QueueTimeout(`Every instance serving ${model.name} is busy.`));
        }, remaining);
        opts.signal.addEventListener('abort', () => {
          clearTimeout(t);
          const i = target.waiting.indexOf(w);
          if (i >= 0) target.waiting.splice(i, 1);
          reject(opts.signal.reason as Error);
        }, { once: true });
        const orig = w.resolve;
        w.resolve = () => {
          clearTimeout(t);
          orig();
        };
      });
    }
  }

  private wake(r: Runtime): void {
    const next = r.waiting.shift();
    if (next) next.resolve();
    r.waiting.forEach((w, i) => w.onPosition?.(i + 1));
  }

  /** Marks a model as seen resident after a request loaded it (so the next pick prefers this instance). */
  noteResident(instanceId: string, modelName: string, sizeBytes = 0): void {
    const r = this.runtimes.get(instanceId);
    if (r && !r.ps.some((m) => sameModel(m.name, modelName))) r.ps.push({ name: modelName, model: modelName, size: sizeBytes, size_vram: sizeBytes, digest: '' });
  }

  // ---------- jobs ----------

  private async pullJob(modelId: string, poolId: string, ctx: JobContext): Promise<unknown> {
    const model = await this.repo.model(modelId);
    if (!model) throw new Error('Model not found');
    const instances = (await this.repo.instances(poolId)).filter((i) => i.state !== 'disabled');
    if (!instances.length) throw new Error('The pool has no instances');
    await this.repo.updateModel(model.id, { import_state: 'pulling', import_error: null });
    const results: Record<string, string> = {};
    try {
      for (const [idx, row] of instances.entries()) {
        const r = this.runtime(row);
        let last = 0;
        for await (const p of r.client.pull(model.name, ctx.signal)) {
          if (p.error) throw new Error(p.error);
          if (p.total && p.completed != null) {
            const pct = ((idx + p.completed / p.total) / instances.length) * 90;
            if (pct - last >= 2) {
              last = pct;
              await ctx.progress(pct, `${row.name}: ${p.status} ${Math.round((p.completed / p.total) * 100)}%`);
            }
          }
        }
        const tags = await r.client.tags();
        const tag = tags.find((t) => sameModel(t.name, model.name));
        if (!tag) throw new Error(`${row.name} does not list ${model.name} after the pull`);
        if (model.expected_digest && norm(tag.digest) !== norm(model.expected_digest)) {
          await r.client.delete(model.name).catch(() => undefined);
          throw new Error(`Digest mismatch on ${row.name}: expected ${norm(model.expected_digest).slice(0, 12)}…, got ${norm(tag.digest).slice(0, 12)}…. The blob was deleted and nothing was registered.`);
        }
        const show = await r.client.show(model.name);
        const format = show.details?.format ?? tag.details?.format ?? null;
        if (format && format !== 'gguf' && format !== 'safetensors') {
          await r.client.delete(model.name).catch(() => undefined);
          throw new Error(`Refused: the model format is ${format}. Only GGUF and safetensors are accepted; pickle checkpoints never are.`);
        }
        const ctxKey = Object.keys(show.model_info ?? {}).find((k) => k.endsWith('.context_length'));
        await this.repo.updateModel(model.id, {
          digest: norm(tag.digest),
          size_bytes: tag.size,
          family: show.details?.family ?? tag.details?.family ?? null,
          parameter_size: show.details?.parameter_size ?? tag.details?.parameter_size ?? null,
          quantization: show.details?.quantization_level ?? tag.details?.quantization_level ?? null,
          format,
          capabilities: show.capabilities ?? ['completion'],
          context_length: ctxKey ? Number((show.model_info ?? {})[ctxKey]) : null
        });
        await this.repo.event(row.id, model.name, 'pull', `Pulled ${norm(tag.digest).slice(0, 12)}`, ctx.job.created_by);
        results[row.name] = norm(tag.digest);
        r.tags = tags;
      }
      await this.repo.updateModel(model.id, { import_state: 'pulled', import_error: null });
      await ctx.progress(100, 'Pulled and verified');
      return { instances: results };
    } catch (err) {
      await this.repo.updateModel(model.id, { import_state: 'failed', import_error: (err as Error).message.slice(0, 500) });
      throw err;
    }
  }

  /**
   * The conformance run behind "evaluated": a chat smoke test on a real instance, and a tool-calling test when the
   * model claims tools (failing it withholds the tools capability from profiles).
   */
  private async evaluateJob(modelId: string, ctx: JobContext): Promise<Evaluation> {
    const model = await this.repo.model(modelId);
    if (!model) throw new Error('Model not found');
    await this.pollAll();
    const r = [...this.runtimes.values()].find((x) => x.row.state === 'active' && x.row.health !== 'unreachable' && x.row.health !== 'unknown' && x.tags.some((t) => sameModel(t.name, model.name)));
    if (!r) throw new Error(`No healthy instance has ${model.name} pulled`);
    const tests: Evaluation['tests'] = [];
    const caps = model.capabilities;
    const run = async (name: string, fn: () => Promise<string>) => {
      try {
        tests.push({ name, ok: true, detail: await fn() });
      } catch (err) {
        tests.push({ name, ok: false, detail: (err as Error).message.slice(0, 300) });
      }
      await ctx.progress((tests.length / 2) * 90, name);
    };
    if (caps.includes('embedding') && !caps.includes('completion')) {
      tests.push({ name: 'Chat smoke test', ok: true, detail: 'Not applicable: an embedding model' });
    } else {
      await run('Chat smoke test', async () => {
        let text = '';
        for await (const c of r.client.chat({ model: model.name, messages: [{ role: 'user', content: 'Reply with the single word: ready' }], options: { temperature: 0, num_predict: 16 }, think: false }, ctx.signal)) text += c.message?.content ?? '';
        if (!text.trim()) throw new Error('Empty answer');
        return `Answered "${text.trim().slice(0, 40)}"`;
      });
    }
    if (caps.includes('tools')) {
      await run('Tool calling', async () => {
        const tools = [{ type: 'function', function: { name: 'calculate', description: 'Evaluates an arithmetic expression exactly', parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } } }];
        for await (const c of r.client.chat({ model: model.name, messages: [{ role: 'user', content: 'Use the calculate tool to compute 17 * 23.' }], tools, options: { temperature: 0 }, think: false }, ctx.signal)) {
          const call = c.message?.tool_calls?.[0];
          if (call) {
            if (call.function.name !== 'calculate') throw new Error(`Called ${call.function.name}, not calculate`);
            return `Called calculate(${JSON.stringify(call.function.arguments).slice(0, 60)})`;
          }
        }
        throw new Error('No tool call in the answer');
      });
    }
    const passed = tests.filter((t) => t.ok).length;
    const smoke = tests.find((t) => t.name === 'Chat smoke test');
    const toolsTest = tests.find((t) => t.name === 'Tool calling');
    const evaluation: Evaluation = { at: Date.now(), instance: r.row.name, tests, passed, total: tests.length, toolsWithheld: !!toolsTest && !toolsTest.ok };
    await this.repo.updateModel(model.id, { evaluation, ...(smoke?.ok && model.state === 'draft' ? { state: 'evaluated' } : {}) });
    return evaluation;
  }

  /**
   * Rolling Ollama upgrade, one instance at a time: drain it, wait for the operator's deployment (Compose, systemd)
   * to bring it back reporting the target version, reload its pinned models, and return it to service. The job
   * stops at the first instance that does not come back healthy, leaving the rest untouched.
   */
  private async upgradeJob(poolId: string, target: string, waitMs: number, ctx: JobContext): Promise<unknown> {
    const rows = (await this.repo.instances(poolId)).filter((i) => i.state !== 'disabled');
    const done: string[] = [];
    const placements = (await this.repo.placements()).filter((p) => p.pool_id === poolId && p.residency === 'pinned');
    const models = await this.repo.models();
    for (const [i, row] of rows.entries()) {
      const r = this.runtime(row);
      await this.pollOne(row.id);
      if (r.row.version === target) {
        done.push(`${row.name} already on ${target}`);
        continue;
      }
      await ctx.progress((i / rows.length) * 100, `Draining ${row.name}`);
      await this.drain(row.id, 'upgrade', Math.min(waitMs, 10 * 60_000));
      await ctx.progress(((i + 0.3) / rows.length) * 100, `Waiting for ${row.name} to report Ollama ${target}`);
      const until = Date.now() + waitMs;
      for (;;) {
        if (ctx.signal.aborted) throw ctx.signal.reason as Error;
        await this.pollOne(row.id);
        if (r.row.version === target && r.row.health !== 'unreachable') break;
        if (Date.now() > until) throw new Error(`${row.name} did not come back on ${target} in time; it stays drained and the remaining instances were not touched`);
        await new Promise((res) => setTimeout(res, Math.min(this.o.pollMs, 5000)));
      }
      await this.undrain(row.id);
      for (const p of placements) {
        const m = models.find((x) => x.id === p.model_id);
        if (m) await this.load(row.id, m.name, { pinned: true, actor: 'upgrade', reason: `Reloaded after upgrade to ${target}` }).catch((err: Error) => this.log.warn({ err: err.message, model: m.name }, 'reload after upgrade failed'));
      }
      done.push(`${row.name} upgraded to ${target}`);
      await ctx.progress(((i + 1) / rows.length) * 100, `${row.name} back in service`);
    }
    return { done };
  }
}

export const fmtGb = (b: number | null | undefined) => (b == null ? 'unknown' : `${(b / 1e9).toFixed(1)} GB`);
export { OllamaError };
