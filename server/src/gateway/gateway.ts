import { AsyncLocalStorage } from 'node:async_hooks';
import type { Logger } from 'pino';
import type { ServicePolicy } from '../platform/egress.js';
import { labelRank, type Label } from '../authz/labels.js';
import { zoneAdmits } from '../authz/policy.js';
import { HttpProblem, tooManyRequests } from '../http/problem.js';
import { TOPICS, type Bus } from '../platform/bus.js';
import type { JobContext, JobQueue } from '../platform/jobs.js';
import { OllamaClient, OllamaError, type ChatMessage, type PsModel, type TagModel } from './ollama.js';
import { OpenAIServer } from './openai-server.js';
import { isUnsupported, orSkip, type ModelServer, type ServerReport } from './server.js';
import type { Evaluation, GatewayRepo, InstanceRow, ModelRow, PoolRow, ProfileRow } from './repo.js';

export interface GatewayOptions {
  pollMs: number;
  timeoutMs: number;
  maxInflight: number;
  maxLoadsPer10Min: number;
  queueTimeoutMs: number;
  /** How long a request may wait for Ollama's first response, which includes loading the model (optional: 5 minutes). */
  loadTimeoutMs?: number;
  /** B-901: which addresses instance URLs may reach (loopback and private stay allowed; metadata never). */
  policy?: ServicePolicy;
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  onPosition?: (n: number) => void;
}

interface Runtime {
  row: InstanceRow;
  client: ModelServer;
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
  /** B-4303: (model, options) pairs already recorded as dropped, so each is noted once per client. */
  dropped: Set<string>;
  /**
   * The keep-alive each placed model's requests carry (-1 pinned, the instance's keep-alive warm), refreshed on every
   * poll. Ollama resets a model's expiry on every request, so a request without one would unpin a pinned model.
   */
  keepAlive: Map<string, string | number>;
}

export interface Lease {
  instance: InstanceRow;
  pool: PoolRow;
  client: ModelServer;
  model: ModelRow;
  /** The model was not resident when the request was admitted: expect a load before the first token. */
  cold: boolean;
  /**
   * Sprint 26a: the request rides on a slot its own turn already holds on this instance (see `Gateway.turn`), so it
   * took no slot of its own and its release frees nothing.
   */
  shared?: boolean;
  release(firstTokenMs?: number | null): void;
}

/** The slots one turn holds (a chat answer and everything it asks for while answering), by instance runtime. */
interface TurnSlots {
  held: Runtime[];
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
  /** Sprint 26a: the slots held by the turn running in the current async context. */
  private readonly turns = new AsyncLocalStorage<TurnSlots>();

  private readonly runtimes = new Map<string, Runtime>();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  /** Label ceiling of a network zone (Sprint 9); the zone service sets it. Null: no current definition, no zone step. */
  zoneCeiling: (zone: string) => Promise<Label | null> = async () => null;
  /**
   * B-4302: reads an instance's bearer token from the vault, as the user who saved it in their tenant (set by
   * createServices). Null: tokens cannot be read here, and an instance that needs one fails its requests.
   */
  tokenResolver: ((tenantId: string, ownerId: string, ref: string, via: string) => Promise<string>) | null = null;

  constructor(
    readonly repo: GatewayRepo,
    private readonly bus: Bus,
    private readonly log: Logger,
    private readonly o: GatewayOptions,
    jobs: JobQueue
  ) {
    jobs.register('model.pull', (p, ctx) => this.pullJob(String(p.modelId), String(p.poolId), ctx), { timeoutMs: 6 * 60 * 60_000 });
    jobs.register('model.evaluate', (p, ctx) => this.evaluateJob(String(p.modelId), ctx), { timeoutMs: 30 * 60_000 });
    jobs.register('instance.probe', (p, ctx) => this.probeJob(String(p.instanceId), ctx), { timeoutMs: 10 * 60_000 });
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

  /** B-4301: the model server for an instance's kind. */
  private serverFor(row: InstanceRow, dropped: Set<string>): ModelServer {
    if (row.kind !== 'openai') return new OllamaClient(row.url, row.tls, this.o.timeoutMs, this.o.policy, this.o.loadTimeoutMs);
    const ref = row.token_ref;
    const server = new OpenAIServer(row.url, {
      socketPath: row.socket_path,
      tls: row.tls,
      timeoutMs: this.o.timeoutMs,
      ...(this.o.policy ? { policy: this.o.policy } : {}),
      ...(this.o.loadTimeoutMs ? { loadTimeoutMs: this.o.loadTimeoutMs } : {}),
      token: ref
        ? async () => {
            if (!this.tokenResolver || !row.token_tenant || !row.token_owner) throw new Error('no vault reader is configured, or the reference has no owner');
            return this.tokenResolver(row.token_tenant, row.token_owner, ref, `model server ${row.name}`);
          }
        : null,
      onDropped: (model, options) => {
        const key = `${model}|${options.sort().join(',')}`;
        if (dropped.has(key)) return;
        dropped.add(key);
        void this.repo.event(row.id, model, 'dropped', `Ollama-only options not sent to the Chat Completions server: ${options.join(', ')}`, 'gateway').catch(() => undefined);
      }
    });
    server.seed(row.settings.reported);
    return server;
  }

  private runtime(row: InstanceRow): Runtime {
    let r = this.runtimes.get(row.id);
    if (r && (r.row.url !== row.url || r.row.kind !== row.kind || r.row.socket_path !== row.socket_path || r.row.token_ref !== row.token_ref || JSON.stringify(r.row.tls) !== JSON.stringify(row.tls))) {
      void r.client.close().catch(() => undefined);
      r = undefined;
    }
    if (!r) {
      const dropped = new Set<string>();
      r = { row, client: this.serverFor(row, dropped), ps: [], tags: [], latencyMs: null, firstTokenMs: null, inflight: 0, waiting: [], loading: new Set(), unloading: new Set(), expectedGone: new Set(), dropped, keepAlive: new Map() };
      this.runtimes.set(row.id, r);
      const rt = r;
      if (rt.client instanceof OllamaClient) rt.client.keepAliveFor = (model) => [...rt.keepAlive].find(([name]) => sameModel(name, model))?.[1];
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
      // One instance's failure (even a throw while building its client) must not stop the others being polled.
      await Promise.all(
        rows.map(async (row) => {
          try {
            await this.poll(this.runtime(row));
          } catch (err) {
            this.log.error({ instance: row.name, err: (err as Error).message }, 'Polling the instance failed');
          }
        })
      );
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
      // B-4301: a server that cannot say what is resident (a Chat Completions server) reports nothing loaded.
      const [version, loaded, tags] = await Promise.all([r.client.version(), orSkip<PsModel[] | null>(r.client.loaded(), null), r.client.models()]);
      const ps = loaded ?? [];
      r.latencyMs = Date.now() - t0;
      const before = r.ps.map((m) => m.name);
      for (const name of before) {
        if (!ps.some((m) => m.name === name) && !r.expectedGone.has(name)) void this.repo.event(r.row.id, name, 'evicted', 'No longer resident: its keep-alive expired or Ollama evicted it for memory', 'ollama');
      }
      r.expectedGone.clear();
      r.ps = ps;
      r.tags = tags;
      r.keepAlive = await this.keepAlives(r.row);
      await this.keepReport(r);
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

  /** The keep-alive per placed model on an instance's pool: -1 for pinned, the instance's keep-alive for warm, none for cold. */
  private async keepAlives(row: InstanceRow): Promise<Map<string, string | number>> {
    const models = new Map((await this.repo.models()).map((m) => [m.id, m.name]));
    const out = new Map<string, string | number>();
    for (const p of await this.repo.placements()) {
      const name = models.get(p.model_id);
      if (p.pool_id !== row.pool_id || !name) continue;
      if (p.residency === 'pinned') out.set(name, -1);
      else if (p.residency === 'warm') out.set(name, row.settings.keepAlive ?? '30m');
    }
    return out;
  }

  /** B-4302: what a Chat Completions server reported goes into the instance's settings when it changes. */
  private async keepReport(r: Runtime): Promise<void> {
    const report = r.client.report?.();
    if (!report) return;
    const merged: ServerReport = { ...(r.row.settings.reported ?? {}), ...report };
    if (JSON.stringify(merged) === JSON.stringify(r.row.settings.reported ?? {})) return;
    const fresh = await this.repo.instance(r.row.id);
    const settings = { ...(fresh?.settings ?? r.row.settings), reported: merged };
    r.row.settings = settings;
    await this.repo.updateInstance(r.row.id, { settings });
  }

  /** Is the model ready on this instance: resident on Ollama, listed on a server that holds its own models. */
  private resident(r: Runtime, name: string): boolean {
    return r.client.supports('loaded') ? r.ps.some((m) => sameModel(m.name, name)) : r.tags.some((t) => sameModel(t.name, name));
  }

  /** Instances in a pool that list the model now (for placing a server-held model). */
  async listedOn(poolId: string, modelName: string): Promise<InstanceRow[]> {
    await this.pollAll();
    return [...this.runtimes.values()].filter((r) => r.row.pool_id === poolId && r.tags.some((t) => sameModel(t.name, modelName))).map((r) => r.row);
  }

  /** B-4304: the models each Chat Completions instance lists, as catalogue candidates (the import picker). */
  async serverCandidates(): Promise<{ instance: InstanceRow; report: ServerReport }[]> {
    const rows = (await this.repo.instances()).filter((i) => i.kind === 'openai');
    await Promise.all(rows.filter((i) => i.state !== 'disabled').map((i) => this.poll(this.runtime(i)).catch(() => undefined)));
    return rows.map((row) => {
      const r = this.runtimes.get(row.id);
      return { instance: r?.row ?? row, report: { ...(row.settings.reported ?? {}), ...(r?.client.report?.() ?? {}) } };
    });
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
          const { token_ref: tokenRef, token_tenant: _tt, token_owner: _to, ...shown } = row;
          return {
            ...shown,
            socketPath: row.socket_path,
            tokenRef,
            supports: r ? { load: r.client.supports('load'), unload: r.client.supports('unload'), pull: r.client.supports('pull'), embed: r.client.supports('embed') } : null,
            reported: row.kind === 'openai' ? { ...(row.settings.reported ?? {}), ...(r?.client.report?.() ?? {}) } : null,
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
    const window = 10 * 60_000;
    const { count: n, oldest } = await this.repo.loadsSince(row.id, Date.now() - window);
    if (n >= this.o.maxLoadsPer10Min) {
      // The window clears one load at a time: the next load is allowed when the oldest one ages out.
      const retry = oldest ? (oldest + window - Date.now()) / 1000 : 60;
      const p = tooManyRequests(`${row.name} has loaded ${n} models in the last ten minutes, its anti-thrash limit. Further loads wait until the window clears.`, retry);
      Object.assign(p.extensions, { limit: 'anti_thrash', loads: n, max: this.o.maxLoadsPer10Min });
      throw p;
    }
  }

  async load(instanceId: string, modelName: string, opts: { pinned?: boolean; actor: string; reason?: string }): Promise<{ evicted: string[]; unsupported?: boolean }> {
    const row = await this.repo.instance(instanceId);
    if (!row) throw new HttpProblem(404, 'Not found', 'Instance not found.');
    if (row.state !== 'active') throw new HttpProblem(409, 'Conflict', `${row.name} is ${row.state}; loads are refused.`);
    const model = await this.catalogModel(modelName);
    if (!['approved', 'deprecated', 'evaluated', 'draft'].includes(model.state) || model.import_state !== 'pulled') throw new HttpProblem(409, 'Conflict', `${model.name} is ${model.state === 'retired' ? 'retired' : 'not pulled yet'}.`);
    const r = this.runtime(row);
    // B-4302: a server that holds its own models has nothing to load; the request is recorded and skipped.
    if (!r.client.supports('load')) {
      await this.repo.event(row.id, model.name, 'unsupported', `Load asked of ${row.name}, a Chat Completions server, which keeps its own models in memory; nothing was sent`, opts.actor);
      return { evicted: [], unsupported: true };
    }
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

  async unload(instanceId: string, modelName: string, actor: string): Promise<{ unsupported?: boolean }> {
    const row = await this.repo.instance(instanceId);
    if (!row) throw new HttpProblem(404, 'Not found', 'Instance not found.');
    const r = this.runtime(row);
    if (!r.client.supports('unload')) {
      await this.repo.event(row.id, modelName, 'unsupported', `Unload asked of ${row.name}, a Chat Completions server, which decides what stays in memory; nothing was sent`, actor);
      return { unsupported: true };
    }
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
    return {};
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
  async acquire(profile: ProfileRow, model: ModelRow, label: Label, opts: { signal: AbortSignal; waitMs?: number; onPosition?: (n: number) => void; embed?: boolean }): Promise<Lease> {
    if (model.state === 'retired') throw new HttpProblem(409, 'Conflict', `${model.name} is retired.`);
    if (!['approved', 'deprecated'].includes(model.state)) throw new HttpProblem(409, 'Conflict', `${model.name} is not approved.`);
    const cleared = (await this.poolsFor(profile, model)).filter((p) => labelRank(p.label_ceiling) >= labelRank(label));
    // The zone step of the policy pipeline: a pool whose zone ceiling is below the data label is never routed to.
    const pools: PoolRow[] = [];
    let zoneDenied: { pool: string; zone: string; ceiling: Label } | null = null;
    for (const p of cleared) {
      const ceiling = await this.zoneCeiling(p.zone);
      if (zoneAdmits(label, ceiling)) pools.push(p);
      else zoneDenied ??= { pool: p.name, zone: p.zone, ceiling: ceiling! };
    }
    if (!pools.length && zoneDenied) throw new HttpProblem(403, 'Forbidden', `Zone ceiling ${zoneDenied.ceiling} is below the data label ${label}: ${zoneDenied.pool} is in the ${zoneDenied.zone} zone, so ${model.name} cannot serve this request there.`, { extensions: { step: 'zone', zone: zoneDenied.zone, zoneCeiling: zoneDenied.ceiling } });
    if (!pools.length) throw new HttpProblem(503, 'No capacity', `No pool cleared for ${label} data runs ${model.name}.`, { extensions: { step: 'zone' } });
    const poolById = new Map(pools.map((p) => [p.id, p]));
    const candidates = () =>
      [...this.runtimes.values()].filter((r) => poolById.has(r.row.pool_id) && r.row.state === 'active' && (r.row.health === 'healthy' || r.row.health === 'degraded') && r.tags.some((t) => sameModel(t.name, model.name)) && (!opts.embed || r.client.supports('embed')));
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
        free.sort((a, b) => Number(this.resident(b, model.name)) - Number(this.resident(a, model.name)) || a.inflight / this.parallel(a.row) - b.inflight / this.parallel(b.row));
        const r = free[0]!;
        r.inflight++;
        let released = false;
        const turn = this.turns.getStore();
        turn?.held.push(r);
        return {
          instance: r.row,
          pool: poolById.get(r.row.pool_id)!,
          client: r.client,
          model,
          cold: !this.resident(r, model.name),
          release: (ftok) => {
            if (released) return;
            released = true;
            r.inflight--;
            const k = turn ? turn.held.indexOf(r) : -1;
            if (k >= 0) turn!.held.splice(k, 1);
            if (ftok != null) r.firstTokenMs = r.firstTokenMs == null ? ftok : Math.round(r.firstTokenMs * 0.8 + ftok * 0.2);
            this.wake(r);
          }
        };
      }
      // Sprint 26a: never queue for a slot this turn itself holds.
      const borrowed = this.borrow(list, poolById, model);
      if (borrowed) return borrowed;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new QueueTimeout(`Every instance serving ${model.name} is busy.`);
      // Wait on the least-queued instance for a slot, then re-pick.
      const target = list.sort((a, b) => a.waiting.length - b.waiting.length)[0]!;
      await new Promise<void>((resolve, reject) => {
        if (opts.signal.aborted) return reject(opts.signal.reason as Error);
        // However the wait ends (a slot, the deadline, an abort, shutdown), the timer and the abort listener go with it:
        // a request that waits many rounds must not pile listeners onto its signal.
        const leave = () => {
          clearTimeout(t);
          opts.signal.removeEventListener('abort', onAbort);
          const i = target.waiting.indexOf(w);
          if (i >= 0) target.waiting.splice(i, 1);
        };
        const onAbort = () => {
          leave();
          reject(opts.signal.reason as Error);
        };
        const w: Waiter = {
          resolve: () => {
            leave();
            resolve();
          },
          reject: (err: Error) => {
            leave();
            reject(err);
          },
          ...(opts.onPosition ? { onPosition: opts.onPosition } : {})
        };
        const t = setTimeout(() => {
          leave();
          reject(new QueueTimeout(`Every instance serving ${model.name} is busy.`));
        }, remaining);
        opts.signal.addEventListener('abort', onAbort, { once: true });
        target.waiting.push(w);
        opts.onPosition?.(target.waiting.length);
      });
    }
  }

  /**
   * Sprint 26a: runs `fn` as one turn. A request made inside it (an embedding, a guard-model verdict on the streamed
   * text, a screen of a tool result, a tool that calls a model) that finds no free slot rides on a slot the same turn
   * already holds on an instance that can serve it, instead of queueing for that slot: the turn would otherwise wait
   * on itself (with one slot per instance, until the queue timeout). Ollama queues the extra request behind the
   * turn's own on that instance. Requests outside a turn, and requests no held slot can serve, queue as before.
   */
  turn<T>(fn: () => Promise<T>): Promise<T> {
    return this.turns.run({ held: [] }, fn);
  }

  /** A lease on a slot the current turn holds on one of `list`, or null. */
  private borrow(list: Runtime[], poolById: Map<string, PoolRow>, model: ModelRow): Lease | null {
    const own = this.turns.getStore()?.held.find((h) => list.includes(h));
    if (!own) return null;
    this.log.debug({ instance: own.row.name, model: model.name }, 'request rides on a slot its turn holds');
    return { instance: own.row, pool: poolById.get(own.row.pool_id)!, client: own.client, model, cold: !this.resident(own, model.name), shared: true, release: () => undefined };
  }

  private wake(r: Runtime): void {
    const next = r.waiting.shift();
    if (next) next.resolve();
    r.waiting.forEach((w, i) => w.onPosition?.(i + 1));
  }

  // ---------- direct model use (embeddings, reranking) ----------

  /**
   * Leases a slot for a catalogue model used without a profile (embedding and reranking models): the model must be
   * approved for the data's label and placed on a pool cleared for it.
   */
  async leaseModel(modelName: string, label: Label, signal: AbortSignal, capability?: string): Promise<Lease> {
    const model = await this.repo.modelByName(modelName);
    if (!model) throw new HttpProblem(409, 'Conflict', `${modelName} is not in the model catalogue.`);
    if (capability && !model.capabilities.includes(capability)) throw new HttpProblem(409, 'Conflict', `${model.name} does not have the ${capability} capability.`);
    if (labelRank(model.label) < labelRank(label)) throw new HttpProblem(403, 'Forbidden', `${model.name} is approved for data up to ${model.label}, not ${label}.`, { extensions: { step: 'zone' } });
    return this.acquire({ pool_id: null } as ProfileRow, model, label, { signal, embed: capability === 'embedding' });
  }

  /** Embeds texts with an embedding model, in batches; returns one vector per input and what it cost. */
  async embed(modelName: string, input: string[], label: Label, signal: AbortSignal = new AbortController().signal): Promise<{ embeddings: number[][]; promptTokens: number; gpuMs: number; poolId: string | null }> {
    if (!input.length) return { embeddings: [], promptTokens: 0, gpuMs: 0, poolId: null };
    // B-4305: an instance without /v1/embeddings is skipped (it is remembered), and the next one that can embed is used.
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.embedOnce(modelName, input, label, signal);
      } catch (err) {
        if (!isUnsupported(err) || attempt >= 3) throw err;
      }
    }
  }

  private async embedOnce(modelName: string, input: string[], label: Label, signal: AbortSignal): Promise<{ embeddings: number[][]; promptTokens: number; gpuMs: number; poolId: string | null }> {
    const lease = await this.leaseModel(modelName, label, signal, 'embedding');
    const out: number[][] = [];
    let promptTokens = 0;
    let gpuMs = 0;
    try {
      for (let i = 0; i < input.length; i += 32) {
        const batch = input.slice(i, i + 32);
        const r = await lease.client.embed(lease.model.name, batch, signal);
        if (!Array.isArray(r.embeddings) || r.embeddings.length !== batch.length) throw new OllamaError(`${lease.model.name} returned ${r.embeddings?.length ?? 0} embeddings for ${batch.length} inputs`, 500);
        out.push(...r.embeddings);
        promptTokens += r.prompt_eval_count ?? batch.reduce((a, x) => a + Math.ceil(x.length / 4), 0);
        gpuMs += ((r.total_duration ?? 0) + (r.load_duration ?? 0)) / 1e6;
      }
      if (lease.cold) this.noteResident(lease.instance.id, lease.model.name);
    } finally {
      lease.release();
    }
    return { embeddings: out, promptTokens, gpuMs, poolId: lease.pool.id };
  }

  /** A short non-streamed completion from a catalogue model (the reranker), without thinking or tools. */
  async complete(modelName: string, messages: ChatMessage[], label: Label, signal: AbortSignal = new AbortController().signal): Promise<{ content: string; promptTokens: number; outputTokens: number }> {
    const lease = await this.leaseModel(modelName, label, signal);
    let content = '';
    let promptTokens = 0;
    let outputTokens = 0;
    try {
      for await (const chunk of lease.client.chat({ model: lease.model.name, messages, options: { temperature: 0 } }, signal)) {
        if (chunk.message?.content) content += chunk.message.content;
        if (chunk.done) {
          promptTokens = chunk.prompt_eval_count ?? 0;
          outputTokens = chunk.eval_count ?? 0;
        }
      }
    } finally {
      lease.release();
    }
    return { content, promptTokens, outputTokens };
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
    if (model.format === 'server') return this.verifyHeld(model, poolId, ctx);
    await this.repo.updateModel(model.id, { import_state: 'pulling', import_error: null });
    const results: Record<string, string> = {};
    try {
      const all = (await this.repo.instances(poolId)).filter((i) => i.state !== 'disabled');
      if (!all.length) throw new Error('The pool has no instances to pull onto');
      // B-4301: a server that holds its own models cannot pull; it is skipped, not failed.
      const instances = all.filter((i) => this.runtime(i).client.supports('pull'));
      for (const row of all) if (!instances.includes(row)) results[row.name] = 'skipped: a Chat Completions server holds its own models';
      if (!instances.length) throw new Error('No instance in the pool can pull: every one is a Chat Completions server, which holds its own models');
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
        const tags = await r.client.models();
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
   * B-4304: a server-held model has nothing to pull. The "pull" checks that an instance in the pool lists it, and
   * deletes nothing anywhere when it does not.
   */
  private async verifyHeld(model: ModelRow, poolId: string, ctx: JobContext): Promise<unknown> {
    const on = await this.listedOn(poolId, model.server_model ?? model.name);
    if (!on.length) {
      await this.repo.updateModel(model.id, { import_state: 'failed', import_error: `No instance in the pool lists ${model.server_model ?? model.name}` });
      throw new Error(`No instance in the pool lists ${model.server_model ?? model.name}; a server-held model is only served where its server lists it`);
    }
    await this.repo.updateModel(model.id, { import_state: 'pulled', import_error: null });
    await ctx.progress(100, 'Held by the server; nothing to pull');
    return { instances: Object.fromEntries(on.map((i) => [i.name, 'held by the server'])) };
  }

  /**
   * B-4302: what a Chat Completions server can do, tried on its first available model: a tool call, and JSON schema
   * output through `response_format`. The answers go into the instance's `settings.reported`.
   */
  private async probeJob(instanceId: string, ctx: JobContext): Promise<ServerReport> {
    const row = await this.repo.instance(instanceId);
    if (!row) throw new Error('Instance not found');
    if (row.kind !== 'openai') throw new Error(`${row.name} is an Ollama instance; the probe is for Chat Completions servers`);
    const r = this.runtime(row);
    await this.poll(r);
    if (r.row.health === 'unreachable') throw new Error(`${row.name} is not answering: ${r.row.health_detail ?? ''}`);
    const model = r.tags.find((t) => !/embed/i.test(t.name))?.name;
    if (!model) throw new Error(`${row.name} lists no chat model to probe`);
    await ctx.progress(10, `Tool call on ${model}`);
    const tools = [{ type: 'function', function: { name: 'calculate', description: 'Evaluates an arithmetic expression exactly', parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } } }];
    let toolsOk = false;
    const notes: string[] = [];
    try {
      for await (const c of r.client.chat({ model, messages: [{ role: 'user', content: 'Use the calculate tool to compute 17 * 23.' }], tools, options: { temperature: 0 } }, ctx.signal)) if (c.message?.tool_calls?.some((t) => t.function.name === 'calculate')) toolsOk = true;
      if (!toolsOk) notes.push('no tool call came back');
    } catch (err) {
      notes.push(`tool call failed: ${(err as Error).message.slice(0, 120)}`);
    }
    await ctx.progress(55, `JSON schema output on ${model}`);
    let schemaOk = false;
    try {
      let text = '';
      const schema = { type: 'object', properties: { city: { type: 'string' }, country: { type: 'string' } }, required: ['city', 'country'] };
      for await (const c of r.client.chat({ model, messages: [{ role: 'user', content: 'Name one city and its country.' }], format: schema, options: { temperature: 0 } }, ctx.signal)) text += c.message?.content ?? '';
      const v = JSON.parse(text.trim()) as Record<string, unknown>;
      schemaOk = typeof v.city === 'string' && typeof v.country === 'string';
      if (!schemaOk) notes.push('the JSON did not follow the schema');
    } catch (err) {
      notes.push(`JSON schema output failed: ${(err as Error).message.slice(0, 120)}`);
    }
    const found = { tools: toolsOk, jsonSchema: schemaOk, probedAt: Date.now(), probedModel: model, probeDetail: notes.length ? notes.join('; ') : null };
    (r.client as { noteProbe?: (p: typeof found) => void }).noteProbe?.(found);
    await this.keepReport(r);
    await ctx.progress(100, `Tools ${toolsOk ? 'work' : 'do not work'}; JSON schema output ${schemaOk ? 'works' : 'does not work'}`);
    return { ...(r.row.settings.reported ?? {}), ...found };
  }

  /**
   * The conformance run behind "evaluated": a chat smoke test on a real instance, and a tool-calling test when the
   * model claims tools (failing it withholds the tools capability from profiles).
   */
  private async evaluateJob(modelId: string, ctx: JobContext): Promise<Evaluation> {
    const model = await this.repo.model(modelId);
    if (!model) throw new Error('Model not found');
    await this.pollAll();
    // B-4304: a server-held model is evaluated on the instance it was registered from when that one can serve it.
    const able = [...this.runtimes.values()].filter((x) => x.row.state === 'active' && x.row.health !== 'unreachable' && x.row.health !== 'unknown' && x.tags.some((t) => sameModel(t.name, model.name)));
    const r = able.find((x) => x.row.id === model.server_instance_id) ?? able[0];
    if (!r) throw new Error(`No healthy instance has ${model.name} pulled`);
    const tests: Evaluation['tests'] = [];
    // B-4304: a server-held model's capabilities are not in a manifest: the tool-calling test always runs, and passing
    // it is what gives the model the tools capability.
    const held = model.format === 'server';
    const caps = held ? [...new Set([...model.capabilities.filter((c) => c !== 'tools'), ...(model.capabilities.includes('embedding') ? [] : ['completion', 'tools'])])] : model.capabilities;
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
    const evaluation: Evaluation = { at: Date.now(), instance: r.row.name, tests, passed, total: tests.length, toolsWithheld: !held && !!toolsTest && !toolsTest.ok };
    const learned = held ? { capabilities: caps.filter((c) => c !== 'tools' || !!toolsTest?.ok), context_length: r.client.report?.().contextLength ?? model.context_length } : {};
    await this.repo.updateModel(model.id, { evaluation, ...learned, ...(smoke?.ok && model.state === 'draft' ? { state: 'evaluated' } : {}) });
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
    const reloadFailures: { instance: string; model: string; error: string }[] = [];
    const placements = (await this.repo.placements()).filter((p) => p.pool_id === poolId && p.residency === 'pinned');
    const models = await this.repo.models();
    for (const [i, row] of rows.entries()) {
      const r = this.runtime(row);
      // B-4301: a Chat Completions server is upgraded by its operator, outside the gateway; the job skips it.
      if (!r.client.supports('load')) {
        done.push(`${row.name} skipped: a Chat Completions server is upgraded outside the gateway`);
        continue;
      }
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
        if (m)
          await this.load(row.id, m.name, { pinned: true, actor: 'upgrade', reason: `Reloaded after upgrade to ${target}` }).catch((err: Error) => {
            this.log.warn({ err: err.message, model: m.name }, 'reload after upgrade failed');
            reloadFailures.push({ instance: row.name, model: m.name, error: err.message });
          });
      }
      done.push(`${row.name} upgraded to ${target}`);
      await ctx.progress(((i + 1) / rows.length) * 100, `${row.name} back in service`);
    }
    return { done, reloadFailures };
  }
}

export const fmtGb = (b: number | null | undefined) => (b == null ? 'unknown' : `${(b / 1e9).toFixed(1)} GB`);
export { OllamaError };
