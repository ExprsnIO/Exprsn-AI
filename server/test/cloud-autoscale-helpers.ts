/*
 * 1.9.99-final, Sprint 60 (B-10402, B-10403, B-10605): the world the autoscale, spot and savings suites share. Nothing
 * reaches a cloud: the provider is an in-memory adapter per provider that records every node group update (and can
 * refuse spot capacity), the credentials are a stub, and a GPU "node" is the fake Ollama behind a gateway instance
 * that the fake cloud turns on (`active`) a boot time after a scale-up from zero and off (`disabled`) when the group
 * goes to zero. Migrations 146, 148, 152 and 158 (and 157 when present) are applied by hand until they are registered.
 */
import type { Principal } from '../src/authz/policy.js';
import type { DesiredResource, Plan } from '../src/cloud/graph.js';
import { capabilityTable, CloudProviderError, type CloudProvider, type ObservedResource, type ResourceSpec } from '../src/cloud/providers/types.js';
import { monthOf, type SpendFigure, type SpendSource } from '../src/cloud/spend.js';
import type { CloudAccount, Provider } from '../src/cloud/types.js';
import type { PoolRow, ProfileRow } from '../src/gateway/repo.js';
import { seedAccount } from './cloud-credentials-helpers.js';
import { FakeOllama } from './fake-ollama.js';
import { seedGateway } from './seed-gateway.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A provider's node groups in memory; `update` records the size asked for and may refuse spot capacity. */
export class MemCloud implements CloudProvider {
  readonly capabilities = capabilityTable({});
  readonly store = new Map<string, ObservedResource>();
  readonly updates: { providerId: string; count: number; purchase: string | null; at: number }[] = [];
  /** Refuse growing a spot group (an InsufficientInstanceCapacity answer). */
  noSpot = false;
  /** Called after every size change (the world boots or stops the node). */
  onScale: ((providerId: string, count: number) => void) | null = null;
  constructor(readonly kind: Provider) {}
  supports() {
    return 'built' as const;
  }
  async identity() {
    return { ok: true } as never;
  }
  async checkPermissions() {
    return [];
  }
  private observe(spec: ResourceSpec, id = `mem-${spec.type}-${spec.name}`): ObservedResource {
    return { type: spec.type, providerId: id, name: spec.name, state: 'ready', tags: spec.tags, props: { ...(spec.props as Record<string, unknown>) } };
  }
  async find(_ctx: unknown, spec: ResourceSpec) {
    return [...this.store.values()].find((o) => o.type === spec.type && o.name === spec.name) ?? null;
  }
  async describe(_ctx: unknown, ref: { providerId: string }) {
    return this.store.get(ref.providerId) ?? null;
  }
  async list() {
    return [...this.store.values()];
  }
  async create(_ctx: unknown, spec: ResourceSpec) {
    const o = this.observe(spec);
    this.store.set(o.providerId, o);
    return { done: true as const, resource: o };
  }
  async update(_ctx: unknown, ref: { providerId: string }, spec: ResourceSpec) {
    const props = spec.props as Record<string, unknown>;
    const before = Number(this.store.get(ref.providerId)?.props.count ?? 0);
    const count = Number(props.count ?? 0);
    if (this.noSpot && props.purchase === 'spot' && count > before) throw new CloudProviderError('There is no Spot capacity available that matches your request.', this.kind, 500, this.kind === 'azure' ? 'SkuNotAvailable' : 'InsufficientInstanceCapacity', 'req-spot-1');
    const o = this.observe(spec, ref.providerId);
    this.store.set(o.providerId, o);
    this.updates.push({ providerId: ref.providerId, count, purchase: (props.purchase as string | undefined) ?? null, at: Date.now() });
    this.onScale?.(ref.providerId, count);
    return { done: true as const, resource: o, requestId: `req-${this.updates.length}` };
  }
  async delete(_ctx: unknown, ref: { providerId: string }) {
    this.store.delete(ref.providerId);
    return { done: true as const, resource: null };
  }
  async poll() {
    return { state: 'succeeded' as const, resource: null };
  }
}

/** A spend source the test sets (for the hard stop). */
export class TestSpend implements SpendSource {
  actual = 0;
  forecastAmount = 0;
  private fig(amount: number, currency = 'USD', now = Date.now()): SpendFigure {
    return { amount, currency, source: 'estimate', deployments: 1, excluded: [], month: monthOf(now).key, at: now };
  }
  async actualMonthToDate(_id: string, o: { currency?: string; now?: number } = {}) {
    return this.fig(this.actual, o.currency, o.now);
  }
  async forecast(_id: string, o: { currency?: string; now?: number } = {}) {
    return this.fig(this.forecastAmount, o.currency, o.now);
  }
}

const VALIDATED = { at: Date.now(), ok: true, identity: { ok: true }, features: ['deploy', 'compute'].map((f) => ({ feature: f, name: f, status: 'ok', required: [], missing: [], reason: null })) };
export const SIZES: Record<Provider, string> = { aws: 'g5.xlarge', azure: 'Standard_NC40ads_H100_v5', digitalocean: 'gpu-h100x1-80gb', cloudflare: '' };
/** The price sheet's on-demand hourly prices of those sizes (`cloud/price-sheet.json`). */
export const SHEET_PRICE: Record<Provider, number> = { aws: 1.006, azure: 6.98, digitalocean: 4.41, cloudflare: 0 };

const MIGRATIONS: [string, () => Promise<{ up: (db: Harness['s']['db']) => Promise<void> }>, boolean][] = [
  ['cloud_accounts', () => import('../src/db/migrations/146_cloud_accounts.js'), false],
  ['cloud_deployments', () => import('../src/db/migrations/148_cloud_journal.js'), false],
  ['cloud_budgets', () => import('../src/db/migrations/152_cloud_budgets.js'), false],
  ['cloud_gpu_pool_links', () => import('../src/db/migrations/157_cloud_gpu_pools.js'), false],
  ['cloud_scale_policies', () => import('../src/db/migrations/158_cloud_autoscale.js'), true]
];

export async function installCloud(h: Harness, opts: { autoscale?: boolean } = {}): Promise<void> {
  for (const [table, load, mine] of MIGRATIONS) {
    if (mine && opts.autoscale === false) continue;
    if (!(await h.s.db.schema.hasTable(table))) await (await load()).up(h.s.db);
  }
  h.s.cloud.accounts.resetSchemaCache();
  h.s.cloud.deployments.resetSchemaCache();
  h.s.cloud.budgets.resetSchemaCache();
  h.s.cloud.autoscale.resetSchemaCache();
  (h.s.cloud.gpuPools as { reset?: () => void }).reset?.();
}

export interface CloudPoolWorld {
  h: Harness;
  ollama: FakeOllama;
  clouds: Record<Provider, MemCloud>;
  spend: TestSpend;
  accounts: Partial<Record<Provider, CloudAccount>>;
  admin: { principal: Principal; ip: string };
  pool: PoolRow;
  profile: ProfileRow;
  instanceId: string;
  /** How long a fake node takes from a scale-up to answering healthy. */
  bootMs: number;
  closed: boolean;
  close(): Promise<void>;
}

const principal = (h: Harness, userId: string, username: string): Principal => ({ kind: 'user', userId, tenantId: h.tenantId, tenantSlug: h.s.cfg.DEFAULT_TENANT, username, displayName: username, roles: ['system-admin'], clearance: 'restricted', scopes: null, sessionId: null, apiKeyId: null, mfa: true });

/** A harness with a gateway pool on the fake Ollama and the fake clouds; no node group yet (`cloudPool`). */
export async function cloudWorld(env: Record<string, string> = {}): Promise<CloudPoolWorld> {
  const h = await harness({ OLLAMA_POLL_MS: '600000', SERVICE_ALLOWED_HOSTS: '127.0.0.1', ...env });
  await installCloud(h);
  const clouds = { aws: new MemCloud('aws'), azure: new MemCloud('azure'), digitalocean: new MemCloud('digitalocean'), cloudflare: new MemCloud('cloudflare') };
  Object.defineProperty(h.s.cloud, 'providers', { value: { providerFor: (k: Provider) => clouds[k] }, configurable: true });
  (h.s.cloud as { credentials: unknown }).credentials = { for: async () => ({ kind: 'token', token: 'test' }) };
  h.s.cloud.engine.options.sleep = async () => undefined;
  (h.s.cloud as { estimatePlan: unknown }).estimatePlan = async (plan: Plan) => ({ monthly: 0, delta: 0, currency: 'USD', prices: [], deploymentId: plan.deploymentId });
  const spend = new TestSpend();
  h.s.cloud.budgets.spend = spend;
  const ollama = await new FakeOllama().start();
  ollama.chatDelayMs = 0;
  const seeded = await seedGateway(h, ollama);
  const u = await localUser(h, 'cloudadmin', ['system-admin'], 'restricted');
  const instanceId = (await h.s.gateway.repo.instances(seeded.pool.id))[0]!.id;
  const w: CloudPoolWorld = {
    h,
    ollama,
    clouds,
    spend,
    accounts: {},
    admin: { principal: principal(h, u.id, 'cloudadmin'), ip: '127.0.0.1' },
    pool: seeded.pool,
    profile: seeded.profile,
    instanceId,
    bootMs: 300,
    closed: false,
    close: async () => {
      w.closed = true;
      h.s.cloud.autoscale.stop();
      // Let a boot the fake cloud scheduled, and a replacement asked for in the background, settle first.
      await sleep(w.bootMs + 300);
      await h.close();
      await ollama.stop();
    }
  };
  return w;
}

/** The node the fake cloud runs: on (`active`) `bootMs` after a scale-up from zero, off when the group goes to zero. */
function wireNode(w: CloudPoolWorld, cloud: MemCloud): void {
  cloud.onScale = (_id, count) => {
    if (w.closed) return;
    const repo = w.h.s.gateway.repo;
    if (count === 0) void repo.updateInstance(w.instanceId, { state: 'disabled' }).then(() => w.h.s.gateway.pollAll());
    else
      setTimeout(() => {
        if (w.closed) return;
        // Only a node that was stopped boots again; a drained (reclaimed) one stays drained.
        void repo.instance(w.instanceId).then(async (i) => {
          if (i?.state !== 'disabled') return;
          await repo.updateInstance(w.instanceId, { state: 'active' });
          await w.h.s.gateway.pollAll();
        });
      }, w.bootMs);
  };
}

/**
 * Makes the world's pool a cloud GPU pool on `provider`: an account, a deployment whose GPU node group is applied on
 * the fake cloud, and the pool's scale policy naming it.
 */
export async function cloudPool(w: CloudPoolWorld, provider: Provider, o: { min?: number; max?: number; desired?: number; idleMinutes?: number; queueDepth?: number; purchase?: 'on_demand' | 'spot'; maxColdWaitMinutes?: number } = {}) {
  const h = w.h;
  let account = w.accounts[provider];
  if (!account) {
    const ids = provider === 'aws' ? { awsAccountId: '123456789012' } : provider === 'azure' ? { azureTenantId: '00000000-0000-0000-0000-000000000001', azureSubscriptionId: '00000000-0000-0000-0000-000000000002' } : { doTeamId: 'team-1' };
    const seeded = await seedAccount(h, { provider, mode: 'vaulted', name: `${provider}-gpu`, providerIds: ids as never, refs: { token: `vault:cloud/${provider}-gpu#token` } });
    await h.s.db('cloud_accounts').where({ id: seeded.id }).update({ validation: JSON.stringify(VALIDATED) });
    account = (await h.s.cloud.accounts.get(seeded.id))!;
    w.accounts[provider] = account;
  }
  const d = await h.s.cloud.deployments.create(w.admin, { name: `gpu-${provider}-${Math.random().toString(36).slice(2, 7)}`, accountId: account.id });
  const min = o.min ?? 0;
  const max = o.max ?? 3;
  const spot = o.purchase === 'spot';
  const group = (key: string, purchase: string | null): DesiredResource => ({ key, type: 'node_group', spec: { role: 'gpu', gpu: 'h100', size: SIZES[provider], min: purchase === 'on_demand' && spot ? 0 : min, max, busyHours: 0, scaleToZero: min === 0, ...(purchase ? { purchase } : {}) }, dependsOn: [], protect: false, region: null, tags: { pool: 'gpu' } });
  const desired = [group('gpu-pool', spot ? 'spot' : null), ...(spot ? [group('gpu-pool-od', 'on_demand')] : [])];
  const plan = await h.s.cloud.plans.create(w.admin, d.id, desired);
  const { jobId } = await h.s.cloud.plans.apply(w.admin, plan.id, plan.hash);
  await h.s.cloud.engine.apply(plan.id, { jobId, onBehalfOf: w.admin.principal.userId });
  wireNode(w, w.clouds[provider]);
  await h.s.cloud.autoscale.setPolicy(w.admin, w.pool.id, { min, max, idleMinutes: o.idleMinutes ?? 15, queueDepth: o.queueDepth ?? 2, maxColdWaitMinutes: o.maxColdWaitMinutes ?? 10, capacity: spot ? 'spot' : 'on_demand', onDemandFallback: true, deploymentId: d.id, resourceKey: 'gpu-pool' });
  if (o.desired != null) await h.s.db('cloud_scale_policies').where({ pool_id: w.pool.id }).update({ desired: o.desired });
  return { deployment: d, account };
}

/** A signed-in admin (system-admin, restricted clearance, MFA enrolled). */
export async function adminClient(w: CloudPoolWorld, name: string) {
  await localUser(w.h, name, ['system-admin'], 'restricted');
  return loginAdmin(w.h, name);
}
