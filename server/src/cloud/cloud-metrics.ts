import client from 'prom-client';
import { json } from '../db/knex.js';
import type { Services } from '../services.js';
import { cloudTransportMetrics } from './limits-metrics.js';
import { registerAnomalyMetrics } from './anomaly-metrics.js';
import { PROVIDERS, type Provider } from './types.js';

/*
 * 1.9.99-final, Sprint 59 (B-10702): the cloud plane's Prometheus metrics, beside the transport's
 * (`limits-metrics.ts`: `exprsn_cloud_wait_seconds`, `exprsn_cloud_calls_total`, the breakers). Registered once per
 * registry, the way `observability/ops-metrics.ts` does it. Labels are providers, steps, states, kinds and bases,
 * never an account, a deployment or a tenant (an account appears only inside a count).
 *
 * Events, counted where they happen:
 *   exprsn_cloud_operations_total{step,state}           every journal row appended (`journal.ts`): started, pending,
 *                                                      succeeded, adopted, failed, cancelled per step kind
 *   exprsn_cloud_apply_duration_seconds{provider,state} one observation per apply run that ends (`apply.ts`): applied,
 *                                                      failed, cancelled; a resumed apply counts the resumed run
 *   exprsn_cloud_drift_findings_detected_total{kind}   new drift findings (`drift.ts`): field, missing, unmanaged
 *   exprsn_cloud_budget_alerts_total{basis,threshold}  budget alerts sent (`budgets.ts`)
 *   exprsn_cloud_cost_ingests_total{provider,outcome}  billing cost fetches (`costs.ts`, job cloud.costs.ingest): ok, failed
 *
 * State, read when Prometheus scrapes (from the database, or from the last budget evaluation):
 *   exprsn_cloud_deployments{provider,state}           deployments by state
 *   exprsn_cloud_operations_inflight{state}            steps whose latest journal row is started or pending
 *   exprsn_cloud_drift_findings{kind,state="open"}      open drift findings
 *   exprsn_cloud_budget_burn_ratio{provider,basis}     the highest share of a monthly budget spent (actual) or
 *                                                      forecast this month among the provider's accounts (1 = 100 %)
 *   exprsn_cloud_budgets{provider,band}                accounts with a budget by band: under_50, 50, 80, 100
 *   exprsn_cloud_budgets_stopped{provider}             accounts whose hard stop is engaged (no active override)
 *   exprsn_cloud_budget_spend_source{provider,source}  accounts with a budget by where their spend came from: billing
 *                                                      (a cost fetch under 3 days old, B-10603) or estimate
 *   exprsn_cloud_gpu_nodes{provider,state}             GPU nodes: provisioned, minimum, joined, idle (see below)
 *   exprsn_cloud_gpu_idle_seconds_total{provider}      idle GPU node-seconds, integrated at each scrape
 *
 * GPU idle time, as far as it is observable before Sprint 60 joins GPU pools to the gateway (B-104):
 *   - provisioned: the GPU nodes the provider reports: a GPU node group's current size (`observed.props.count`,
 *     its desired size until the provider has reported one) and every GPU VM that is not stopped or deleted;
 *   - minimum: the GPU node groups' `min` (what never scales away; scale-to-zero groups have 0);
 *   - joined: since Sprint 60 (B-10401), a node that enrolled itself into its GPU pool's gateway pool and whose
 *     instance is active and healthy: a node group's enrolled instances (through its link, `cloud_gpu_pool_links`,
 *     at most the group's provisioned count), and a GPU VM whose private address is the host of an active, healthy
 *     gateway pool instance (as before; an enrolled VM's instance is on its private address);
 *   - idle = provisioned − joined: a GPU node that costs money and serves no model through Exprsn-AI.
 *   The counter adds idle × the seconds since the previous scrape on this instance; every instance reads the same
 *   graph, so a dashboard takes `max without (instance)` of the rate rather than the sum. Sprint 60 narrows "joined"
 *   to "busy" (a running lease on the instance) without changing the metric's name.
 */

export interface CloudPlaneMetrics {
  journalRow(step: string, state: string): void;
  applyEnded(provider: Provider, state: string, seconds: number): void;
  driftDetected(kind: string, n?: number): void;
  budgetAlert(basis: string, threshold: number): void;
  /** B-10603: one billing cost fetch ended (`costs.ts`). */
  costIngest(provider: Provider, outcome: 'ok' | 'failed'): void;
  /** The last evaluation of one account's budget (`budgets.ts`); null when the budget was removed. */
  budgetStatus(accountId: string, s: { provider: Provider; pctActual: number; pctForecast: number; stopped: boolean; source?: string } | null): void;
}

const byRegistry = new WeakMap<client.Registry, CloudPlaneMetrics>();
/** A budget evaluation older than this is dropped (the check runs hourly by default; two missed runs and it goes). */
const BUDGET_STALE_MS = 3 * 3_600_000;

/** The event hooks, registered on first use; cheap enough to call from every journal append. */
export function cloudPlaneMetrics(registry: client.Registry): CloudPlaneMetrics {
  const have = byRegistry.get(registry);
  if (have) return have;
  const registers = [registry];
  const ops = new client.Counter({ name: 'exprsn_cloud_operations_total', help: 'Cloud operation journal rows by step kind and state (B-10702)', labelNames: ['step', 'state'], registers });
  const apply = new client.Histogram({
    name: 'exprsn_cloud_apply_duration_seconds',
    help: 'Time an apply run took, by provider and how it ended: applied, failed, cancelled (B-10702)',
    labelNames: ['provider', 'state'],
    buckets: [5, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400],
    registers
  });
  const drift = new client.Counter({ name: 'exprsn_cloud_drift_findings_detected_total', help: 'New cloud drift findings by kind: field, missing, unmanaged (B-10702)', labelNames: ['kind'], registers });
  const alerts = new client.Counter({ name: 'exprsn_cloud_budget_alerts_total', help: 'Cloud budget alerts sent, by basis (actual, forecast) and threshold percent (B-10702)', labelNames: ['basis', 'threshold'], registers });
  const budgets = new Map<string, { provider: Provider; pctActual: number; pctForecast: number; stopped: boolean; source?: string; at: number }>();
  const ingests = new client.Counter({ name: 'exprsn_cloud_cost_ingests_total', help: 'Billing cost fetches by provider and outcome: ok, failed (B-10603, B-10702)', labelNames: ['provider', 'outcome'], registers });
  const fresh = () => {
    const now = Date.now();
    for (const [k, v] of budgets) if (now - v.at > BUDGET_STALE_MS) budgets.delete(k);
    return [...budgets.values()];
  };
  new client.Gauge({
    name: 'exprsn_cloud_budget_burn_ratio',
    help: 'The highest share of a monthly cloud budget spent (basis actual) or forecast (basis forecast) this month among the provider\'s accounts; 1 is 100 % (B-10702)',
    labelNames: ['provider', 'basis'],
    registers,
    collect() {
      this.reset();
      const list = fresh();
      for (const p of PROVIDERS) {
        const mine = list.filter((b) => b.provider === p);
        if (!mine.length) continue;
        this.set({ provider: p, basis: 'actual' }, Math.max(...mine.map((b) => b.pctActual)) / 100);
        this.set({ provider: p, basis: 'forecast' }, Math.max(...mine.map((b) => b.pctForecast)) / 100);
      }
    }
  });
  new client.Gauge({
    name: 'exprsn_cloud_budgets',
    help: 'Cloud accounts with a budget, by provider and band of actual spend this month: under_50, 50, 80, 100 (B-10702)',
    labelNames: ['provider', 'band'],
    registers,
    collect() {
      this.reset();
      const list = fresh();
      for (const p of PROVIDERS) {
        const mine = list.filter((b) => b.provider === p);
        if (!mine.length) continue;
        const band = (pct: number) => (pct >= 100 ? '100' : pct >= 80 ? '80' : pct >= 50 ? '50' : 'under_50');
        for (const b of ['under_50', '50', '80', '100']) this.set({ provider: p, band: b }, mine.filter((x) => band(x.pctActual) === b).length);
      }
    }
  });
  new client.Gauge({
    name: 'exprsn_cloud_budgets_stopped',
    help: 'Cloud accounts whose budget hard stop is engaged now (plans that add cost are refused), by provider (B-10702)',
    labelNames: ['provider'],
    registers,
    collect() {
      this.reset();
      const list = fresh();
      for (const p of PROVIDERS) this.set({ provider: p }, list.filter((b) => b.provider === p && b.stopped).length);
    }
  });
  new client.Gauge({
    name: 'exprsn_cloud_budget_spend_source',
    help: 'Cloud accounts with a budget by where this month\'s spend came from: billing (cost data under 3 days old) or estimate (B-10603, B-10702)',
    labelNames: ['provider', 'source'],
    registers,
    collect() {
      this.reset();
      const list = fresh();
      for (const p of PROVIDERS) {
        const mine = list.filter((b) => b.provider === p);
        if (!mine.length) continue;
        for (const src of ['billing', 'estimate']) this.set({ provider: p, source: src }, mine.filter((b) => (b.source ?? 'estimate') === src).length);
      }
    }
  });
  const m: CloudPlaneMetrics = {
    costIngest: (provider, outcome) => ingests.inc({ provider, outcome }),
    journalRow: (step, state) => ops.inc({ step, state }),
    applyEnded: (provider, state, seconds) => apply.observe({ provider, state }, Math.max(0, seconds)),
    driftDetected: (kind, n = 1) => {
      if (n > 0) drift.inc({ kind }, n);
    },
    budgetAlert: (basis, threshold) => alerts.inc({ basis, threshold: String(threshold) }),
    budgetStatus: (accountId, s) => {
      if (!s) budgets.delete(accountId);
      else budgets.set(accountId, { ...s, at: Date.now() });
    }
  };
  byRegistry.set(registry, m);
  return m;
}

/** 1.9.99-final, Sprint 60 (B-10402, B-10403): autoscale decisions and spot interruption notices. */
export interface AutoscaleMetrics {
  scale(direction: 'up' | 'down', reason: string, outcome: 'applied' | 'refused' | 'failed'): void;
  interruption(provider: Provider, kind: string): void;
}

const autoscaleByRegistry = new WeakMap<client.Registry, AutoscaleMetrics>();

/**
 * exprsn_cloud_autoscale_total{direction,reason,outcome}  GPU pool scale decisions (`autoscale.ts`): up or down, why
 *                                                        (idle, queue, cold, manual, interruption, fallback), and
 *                                                        applied, refused (the budget's hard stop) or failed
 * exprsn_cloud_interruptions_total{provider,kind}         spot interruption notices posted by nodes
 */
export function autoscaleMetrics(registry: client.Registry): AutoscaleMetrics {
  const have = autoscaleByRegistry.get(registry);
  if (have) return have;
  const registers = [registry];
  const scale = new client.Counter({ name: 'exprsn_cloud_autoscale_total', help: 'GPU pool scale decisions by direction, reason and outcome (B-10402)', labelNames: ['direction', 'reason', 'outcome'], registers });
  const notices = new client.Counter({ name: 'exprsn_cloud_interruptions_total', help: 'Spot interruption notices posted by GPU nodes, by provider and kind (B-10403)', labelNames: ['provider', 'kind'], registers });
  const m: AutoscaleMetrics = {
    scale: (direction, reason, outcome) => scale.inc({ direction, reason, outcome }),
    interruption: (provider, kind) => notices.inc({ provider, kind })
  };
  autoscaleByRegistry.set(registry, m);
  return m;
}

/** What `gpuNodes` counts per provider. */
export interface GpuCount {
  provisioned: number;
  minimum: number;
  joined: number;
}

const GPU_VM_GONE = new Set(['stopped', 'stopping', 'terminated', 'shutting-down', 'deallocated', 'off', 'deleted']);

/** GPU nodes per provider from the resource graph and the gateway's instances (the definition above). */
export async function gpuNodes(s: Services): Promise<Record<Provider, GpuCount>> {
  const out = Object.fromEntries(PROVIDERS.map((p) => [p, { provisioned: 0, minimum: 0, joined: 0 }])) as Record<Provider, GpuCount>;
  const rows = (await s.db('cloud_resources as r')
    .join('cloud_deployments as d', 'd.id', 'r.deployment_id')
    .whereIn('r.type', ['node_group', 'vm'])
    .whereNotIn('r.state', ['planned', 'deleted', 'missing'])
    .select('r.type', 'r.desired', 'r.observed', 'd.provider', 'r.deployment_id', 'r.key')) as { type: string; desired: unknown; observed: unknown; provider: string; deployment_id: string; key: string }[];
  // B-10401: a node group's enrolled, healthy instances, by deployment and graph key (no migration 157: none).
  const enrolled = new Map<string, number>();
  try {
    const linked = (await s.db('cloud_gpu_pool_links as l')
      .join('cloud_gpu_enrolments as e', 'e.link_id', 'l.id')
      .join('instances as i', 'i.id', 'e.instance_id')
      .where({ 'l.kind': 'node_group', 'i.state': 'active', 'i.health': 'healthy' })
      .whereNot({ 'l.state': 'removed' })
      .select('l.deployment_id', 'l.resource_key', 'i.id')) as { deployment_id: string; resource_key: string; id: string }[];
    const seen = new Set<string>();
    for (const x of linked) {
      if (seen.has(x.id)) continue;
      seen.add(x.id);
      const k = `${x.deployment_id}|${x.resource_key}`;
      enrolled.set(k, (enrolled.get(k) ?? 0) + 1);
    }
  } catch {
    /* no GPU pool tables yet */
  }
  const hosts = new Set<string>();
  try {
    const inst = (await s.db('instances').where({ state: 'active', health: 'healthy' }).select('url')) as { url: string }[];
    for (const i of inst) {
      try {
        hosts.add(new URL(i.url).hostname.replace(/^\[|\]$/g, '').toLowerCase());
      } catch {
        /* not a URL */
      }
    }
  } catch {
    /* no gateway tables: nothing is joined */
  }
  for (const r of rows) {
    const p = r.provider as Provider;
    if (!out[p]) continue;
    const desired = json<{ spec?: Record<string, unknown> }>(r.desired, {});
    const spec = desired.spec ?? {};
    if (spec.role !== 'gpu') continue;
    const observed = json<{ props?: Record<string, unknown>; state?: string } | null>(r.observed, null);
    const props = observed?.props ?? {};
    if (r.type === 'node_group') {
      const count = Number(props.count ?? spec.count ?? spec.min ?? 0);
      const nodes = Number.isFinite(count) ? Math.max(0, count) : 0;
      out[p].provisioned += nodes;
      out[p].minimum += Math.max(0, Number(spec.min ?? 0) || 0);
      out[p].joined += Math.min(nodes, enrolled.get(`${r.deployment_id}|${r.key}`) ?? 0);
    } else {
      const status = String(props.status ?? observed?.state ?? '').toLowerCase();
      if (GPU_VM_GONE.has(status)) continue;
      out[p].provisioned += 1;
      const ip = typeof props.privateIp === 'string' ? props.privateIp.toLowerCase() : null;
      if (ip && hosts.has(ip)) out[p].joined += 1;
    }
  }
  return out;
}

/** The scrape-time gauges (database reads) and the transport's metrics, registered at start (`ops-metrics.ts`). */
export function registerCloudMetrics(s: Services): void {
  const registry = s.metrics.registry;
  const registers = [registry];
  // Registered now, so /metrics lists them (and the dashboards find them) before the first cloud call.
  cloudTransportMetrics(registry);
  cloudPlaneMetrics(registry);
  registerAnomalyMetrics(s); // Sprint 62 (B-10606): spend anomalies detected and open

  new client.Gauge({
    name: 'exprsn_cloud_deployments',
    help: 'Cloud deployments by provider and state (B-10702)',
    labelNames: ['provider', 'state'],
    registers,
    async collect() {
      try {
        const rows = (await s.db('cloud_deployments').groupBy('provider', 'state').select('provider', 'state').count({ n: '*' })) as { provider: string; state: string; n: number | string }[];
        this.reset();
        for (const r of rows) this.set({ provider: r.provider, state: r.state }, Number(r.n));
      } catch {
        // no cloud tables yet, or the database is down (the readiness probe says so)
      }
    }
  });

  new client.Gauge({
    name: 'exprsn_cloud_operations_inflight',
    help: 'Cloud operation steps whose latest journal row is started or pending, in the last day (B-10702)',
    labelNames: ['state'],
    registers,
    async collect() {
      try {
        const since = Date.now() - 86_400_000;
        const rows = (await s.db('cloud_operations').where('at', '>=', since).orderBy('id', 'asc').select('plan_id', 'resource_key', 'step', 'state')) as { plan_id: string | null; resource_key: string; step: string; state: string }[];
        const last = new Map<string, string>();
        for (const r of rows) last.set(`${r.plan_id ?? '-'}|${r.resource_key}|${r.step}`, r.state);
        this.reset();
        this.set({ state: 'started' }, [...last.values()].filter((x) => x === 'started').length);
        this.set({ state: 'pending' }, [...last.values()].filter((x) => x === 'pending').length);
      } catch {
        /* see above */
      }
    }
  });

  new client.Gauge({
    name: 'exprsn_cloud_drift_findings',
    help: 'Open cloud drift findings by kind: field, missing, unmanaged (B-10702)',
    labelNames: ['kind', 'state'],
    registers,
    async collect() {
      try {
        const rows = (await s.db('cloud_drift_findings').where({ state: 'open' }).groupBy('kind').select('kind').count({ n: '*' })) as { kind: string; n: number | string }[];
        this.reset();
        for (const k of ['field', 'missing', 'unmanaged']) this.set({ kind: k, state: 'open' }, 0);
        for (const r of rows) this.set({ kind: r.kind, state: 'open' }, Number(r.n));
      } catch {
        /* migration 149 not applied yet */
      }
    }
  });

  // 1.9.99-final, Sprint 60 (B-10605): idle GPU hours avoided by scale-to-zero this month, and their estimated saving.
  autoscaleMetrics(registry);
  const savingsNow = async () => {
    try {
      return await s.cloud.autoscale.savings();
    } catch {
      return [];
    }
  };
  new client.Gauge({
    name: 'exprsn_cloud_gpu_saved_hours',
    help: 'GPU node-hours avoided this month (UTC) by scaling cloud GPU pools down when idle, by provider (B-10605)',
    labelNames: ['provider'],
    registers,
    async collect() {
      const rows = await savingsNow();
      this.reset();
      for (const p of PROVIDERS) this.set({ provider: p }, rows.filter((r) => r.provider === p).reduce((a, r) => a + r.hours, 0));
    }
  });
  new client.Gauge({
    name: 'exprsn_cloud_gpu_savings',
    help: 'Estimated saving this month (UTC) of the GPU node-hours avoided by scale-to-zero, at the on-demand price, by provider and currency (B-10605)',
    labelNames: ['provider', 'currency'],
    registers,
    async collect() {
      const rows = await savingsNow();
      this.reset();
      const sums = new Map<string, number>();
      for (const r of rows) if (r.saving != null) sums.set(`${r.provider}|${r.currency}`, (sums.get(`${r.provider}|${r.currency}`) ?? 0) + r.saving);
      for (const [k, v] of sums) {
        const [provider, currency] = k.split('|') as [string, string];
        this.set({ provider, currency }, Math.round(v * 100) / 100);
      }
    }
  });

  const idle = new client.Counter({ name: 'exprsn_cloud_gpu_idle_seconds_total', help: 'GPU node-seconds provisioned but not joined to a healthy gateway pool instance, integrated at each scrape (B-10702)', labelNames: ['provider'], registers });
  let last: { at: number; idle: Record<string, number> } | null = null;
  new client.Gauge({
    name: 'exprsn_cloud_gpu_nodes',
    help: 'GPU nodes by provider and state: provisioned, minimum (the node groups\' floor), joined (serving through a gateway pool), idle (provisioned, not joined) (B-10702)',
    labelNames: ['provider', 'state'],
    registers,
    async collect() {
      let counts: Record<Provider, GpuCount>;
      try {
        counts = await gpuNodes(s);
      } catch {
        return;
      }
      const now = Date.now();
      this.reset();
      const nowIdle: Record<string, number> = {};
      for (const p of PROVIDERS) {
        const c = counts[p];
        const i = Math.max(0, c.provisioned - c.joined);
        nowIdle[p] = i;
        this.set({ provider: p, state: 'provisioned' }, c.provisioned);
        this.set({ provider: p, state: 'minimum' }, c.minimum);
        this.set({ provider: p, state: 'joined' }, c.joined);
        this.set({ provider: p, state: 'idle' }, i);
        // Left Riemann sum: the idle count seen at the previous scrape held until now.
        const before = last?.idle[p] ?? 0;
        if (last && before > 0) idle.inc({ provider: p }, (before * (now - last.at)) / 1000);
        else idle.inc({ provider: p }, 0);
      }
      last = { at: now, idle: nowIdle };
    }
  });
}
