import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Registry } from 'prom-client';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import type { Principal } from '../src/authz/policy.js';
import { gpuNodes } from '../src/cloud/cloud-metrics.js';
import type { DesiredResource } from '../src/cloud/graph.js';
import { ProviderRegistry } from '../src/cloud/providers/registry.js';
import { monthOf, type SpendFigure, type SpendSource } from '../src/cloud/spend.js';
import type { CloudAccount } from '../src/cloud/types.js';
import { servicePolicy } from '../src/platform/egress.js';
import { seedAccount } from './cloud-credentials-helpers.js';
import type { RecordedRequest, Reply } from './fake-cloud-base.js';
import { FakeDigitalOcean } from './fake-do.js';
import { harness, type Harness } from './helpers.js';

/*
 * 1.9.99-final, Sprint 59 (B-10702): the cloud plane's metrics, dashboard and alert rules.
 *
 * - Each new metric moves when its event happens: journal rows and the apply duration from a real apply against the
 *   DigitalOcean fake (127.0.0.1, no network), drift from a rule added by hand at the fake, budget burn from an
 *   evaluation over a test spend source, GPU nodes and idle time from a graph with GPU node groups and VMs.
 * - The dashboard renders against the test metrics: every panel's expression names only metrics this server exports
 *   (or a recording rule of the cloud rules), and promtool parses every expression.
 * - promtool checks the rules and runs their unit tests (`exprsn-ai-cloud.rules.test.yml`) when it is available
 *   (PROMTOOL, toolchain/prometheus/bin/promtool, PATH, or the prom/prometheus image already pulled), and says why it
 *   skipped otherwise.
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const obs = path.join(repo, 'deploy/observability');
const ALLOWED = '127.0.0.1,::1,localhost';

class Fake extends FakeDigitalOcean {
  private rid = 0;
  protected override handle(r: RecordedRequest): Reply {
    const rep = super.handle(r);
    return { ...rep, headers: { ...(rep.headers ?? {}), 'x-request-id': `req-${++this.rid}` } };
  }
}

class TestSpend implements SpendSource {
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

const VALIDATED = { at: Date.now(), ok: true, identity: { ok: true }, features: [{ feature: 'deploy', name: 'Deploy', status: 'ok', required: [], missing: [], reason: null }, { feature: 'billing', name: 'Billing', status: 'ok', required: [], missing: [], reason: null }] };

const admin = (h: Harness): Principal => ({ kind: 'user', userId: 'u-metrics', tenantId: h.tenantId, tenantSlug: h.s.cfg.DEFAULT_TENANT, username: 'metrics-admin', displayName: 'Metrics admin', roles: ['system-admin'], clearance: 'restricted', scopes: null, sessionId: null, apiKeyId: null, mfa: true });

/** The value of one series (summed over the label values given), read the way a scrape reads it (collect runs). */
async function value(reg: Registry, name: string, labels: Record<string, string> = {}): Promise<number> {
  const m = reg.getSingleMetric(name);
  if (!m) throw new Error(`${name} is not registered`);
  const got = await m.get();
  return got.values.filter((v) => Object.entries(labels).every(([k, x]) => String((v.labels as Record<string, unknown>)[k]) === x)).reduce((n, v) => n + v.value, 0);
}

/** The names a scrape of this registry serves (histograms and summaries with their suffixes). */
async function exported(reg: Registry): Promise<Set<string>> {
  return new Set((await reg.getMetricsAsJSON()).flatMap((m) => [m.name, `${m.name}_bucket`, `${m.name}_count`, `${m.name}_sum`]));
}

const net: DesiredResource = { key: 'core', type: 'network', spec: { cidr: '10.30.0.0/20' }, dependsOn: [], protect: false, region: null };
const fw: DesiredResource = { key: 'web', type: 'firewall', spec: { ingress: [{ protocol: 'tcp', ports: '443', sources: ['0.0.0.0/0'] }] }, dependsOn: ['core'], protect: false, region: null };

describe('cloud metrics move when their events happen (B-10702)', () => {
  let h: Harness;
  let fake: Fake;
  let account: CloudAccount;
  let reg: Registry;
  const spend = new TestSpend();
  const actor = () => ({ principal: admin(h), ip: '127.0.0.1' });

  beforeAll(async () => {
    h = await harness({ SERVICE_ALLOWED_HOSTS: ALLOWED });
    const migrations: [string, () => Promise<{ up: (db: Harness['s']['db']) => Promise<void> }>][] = [
      ['cloud_accounts', () => import('../src/db/migrations/146_cloud_accounts.js')],
      ['cloud_deployments', () => import('../src/db/migrations/148_cloud_journal.js')],
      ['cloud_drift_findings', () => import('../src/db/migrations/149_cloud_lifecycle.js')],
      ['cloud_budgets', () => import('../src/db/migrations/152_cloud_budgets.js')],
      ['cloud_costs', () => import('../src/db/migrations/155_cloud_costs.js')]
    ];
    for (const [table, m] of migrations) if (!(await h.s.db.schema.hasTable(table))) await (await m()).up(h.s.db);
    h.s.cloud.accounts.resetSchemaCache();
    h.s.cloud.deployments.resetSchemaCache();
    h.s.cloud.budgets.resetSchemaCache();
    fake = await new Fake().start();
    fake.settleAfter = 1;
    const token = fake.addToken();
    const registry = new ProviderRegistry({ policy: servicePolicy({ SERVICE_ALLOWED_HOSTS: ALLOWED }), endpoints: { digitalocean: { api: fake.url } }, transport: { sleep: async () => undefined, random: () => 0.5 } });
    Object.defineProperty(h.s.cloud, 'providers', { value: registry, configurable: true });
    (h.s.cloud as { credentials: unknown }).credentials = { for: async () => ({ kind: 'token', token }) };
    h.s.cloud.engine.options.sleep = async () => undefined;
    h.s.cloud.budgets.spend = spend;
    const seeded = await seedAccount(h, { provider: 'digitalocean', mode: 'vaulted', name: 'do-metrics', providerIds: { doTeamId: fake.account.team.uuid }, refs: { token: 'vault:cloud/do-metrics#token' } });
    await h.s.db('cloud_accounts').where({ id: seeded.id }).update({ validation: JSON.stringify(VALIDATED) });
    account = (await h.s.cloud.accounts.get(seeded.id))!;
    reg = h.s.metrics.registry;
  });
  afterAll(async () => {
    await fake?.stop();
    await h?.close();
  });

  it('registers every cloud metric at start, before any cloud call', async () => {
    const names = await exported(reg);
    for (const n of ['exprsn_cloud_operations_total', 'exprsn_cloud_operations_inflight', 'exprsn_cloud_apply_duration_seconds', 'exprsn_cloud_deployments', 'exprsn_cloud_drift_findings', 'exprsn_cloud_drift_findings_detected_total', 'exprsn_cloud_budget_burn_ratio', 'exprsn_cloud_budgets', 'exprsn_cloud_budgets_stopped', 'exprsn_cloud_budget_alerts_total', 'exprsn_cloud_budget_spend_source', 'exprsn_cloud_cost_ingests_total', 'exprsn_cloud_gpu_nodes', 'exprsn_cloud_gpu_idle_seconds_total', 'exprsn_cloud_wait_seconds', 'exprsn_cloud_calls_total', 'exprsn_cloud_breakers_open']) expect(names.has(n), n).toBe(true);
    // The scrape answers with them (nothing throws without cloud rows).
    expect(await reg.metrics()).toMatch(/exprsn_cloud_gpu_nodes\{provider="aws",state="idle"\} 0/);
  });

  it('an apply moves operations by state, steps in flight, deployments by state and the apply duration', async () => {
    const before = { started: await value(reg, 'exprsn_cloud_operations_total', { state: 'started' }), succeeded: await value(reg, 'exprsn_cloud_operations_total', { state: 'succeeded', step: 'create' }), applies: await value(reg, 'exprsn_cloud_apply_duration_seconds', {}) };
    const d = await h.s.cloud.deployments.create(actor(), { name: 'metrics-1', accountId: account.id });
    expect(await value(reg, 'exprsn_cloud_deployments', { provider: 'digitalocean', state: 'draft' })).toBeGreaterThanOrEqual(1);
    const plan = await h.s.cloud.plans.create(actor(), d.id, [net, fw]);
    const { jobId } = await h.s.cloud.plans.apply(actor(), plan.id, plan.hash);
    const outcome = await h.s.cloud.engine.apply(plan.id, { jobId, onBehalfOf: 'u-metrics' });
    expect(outcome.state).toBe('applied');
    expect(await value(reg, 'exprsn_cloud_operations_total', { state: 'started' })).toBeGreaterThanOrEqual(before.started + 2);
    expect(await value(reg, 'exprsn_cloud_operations_total', { state: 'succeeded', step: 'create' })).toBe(before.succeeded + 2);
    const hist = (await reg.getSingleMetric('exprsn_cloud_apply_duration_seconds')!.get()).values;
    const count = hist.filter((v) => (v as { metricName?: string }).metricName === 'exprsn_cloud_apply_duration_seconds_count' && v.labels.provider === 'digitalocean' && v.labels.state === 'applied').reduce((n, v) => n + v.value, 0);
    expect(count).toBe(1);
    expect(before.applies).toBeGreaterThanOrEqual(0);
    expect(await value(reg, 'exprsn_cloud_deployments', { provider: 'digitalocean', state: 'applied' })).toBe(1);
    // Nothing is left started or pending once the apply has ended.
    expect(await value(reg, 'exprsn_cloud_operations_inflight', { state: 'started' })).toBe(0);
    // A step that is only started (an instance died mid-call) counts as in flight.
    await h.s.cloud.journal.append({ deploymentId: d.id, planId: plan.id, resourceKey: 'ghost', step: 'create', idempotencyKey: 'exs-ghost', attempt: 1, state: 'started' });
    expect(await value(reg, 'exprsn_cloud_operations_inflight', { state: 'started' })).toBe(1);
    await h.s.cloud.journal.append({ deploymentId: d.id, planId: plan.id, resourceKey: 'ghost', step: 'create', idempotencyKey: 'exs-ghost', attempt: 1, state: 'failed', error: 'test' });
    expect(await value(reg, 'exprsn_cloud_operations_inflight', { state: 'started' })).toBe(0);
    expect(await value(reg, 'exprsn_cloud_operations_total', { state: 'failed', step: 'create' })).toBeGreaterThanOrEqual(1);
  });

  it('drift moves the detected counter and the open findings gauge', async () => {
    const d = (await h.s.cloud.deployments.list(admin(h))).find((x) => x.name === 'metrics-1')!;
    const fwId = (await h.s.cloud.deployments.resources(d.id)).find((r) => r.key === 'web')!.providerId!;
    const before = await value(reg, 'exprsn_cloud_drift_findings_detected_total', { kind: 'field' });
    expect(await value(reg, 'exprsn_cloud_drift_findings', { kind: 'field', state: 'open' })).toBe(0);
    fake.firewalls.get(fwId)!.inbound_rules.push({ protocol: 'tcp', ports: '22', sources: { addresses: ['0.0.0.0/0'] } });
    const out = await h.s.cloud.lifecycle.drift.detect((await h.s.cloud.deployments.get(d.id))!);
    expect(out.fresh).toHaveLength(1);
    expect(await value(reg, 'exprsn_cloud_drift_findings_detected_total', { kind: 'field' })).toBe(before + 1);
    expect(await value(reg, 'exprsn_cloud_drift_findings', { kind: 'field', state: 'open' })).toBe(1);
    // Seen again, the same finding is not new.
    await h.s.cloud.lifecycle.drift.detect((await h.s.cloud.deployments.get(d.id))!);
    expect(await value(reg, 'exprsn_cloud_drift_findings_detected_total', { kind: 'field' })).toBe(before + 1);
  });

  it('a budget evaluation moves budget burn, the bands, the hard stop and the alerts sent', async () => {
    await h.s.cloud.budgets.set(actor(), account.id, { amount: 1000, hardStop: 'actual' });
    spend.actual = 550;
    spend.forecastAmount = 900;
    const now = Date.now();
    await h.s.cloud.budgets.evaluate(account.id, now);
    expect(await value(reg, 'exprsn_cloud_budget_burn_ratio', { provider: 'digitalocean', basis: 'actual' })).toBeCloseTo(0.55, 5);
    expect(await value(reg, 'exprsn_cloud_budget_burn_ratio', { provider: 'digitalocean', basis: 'forecast' })).toBeCloseTo(0.9, 5);
    expect(await value(reg, 'exprsn_cloud_budgets', { provider: 'digitalocean', band: '50' })).toBe(1);
    expect(await value(reg, 'exprsn_cloud_budgets_stopped', { provider: 'digitalocean' })).toBe(0);
    expect(await value(reg, 'exprsn_cloud_budget_alerts_total', { basis: 'forecast', threshold: '80' })).toBe(1);
    // No billing data yet for this account: the spend is the estimate (B-10603).
    expect(await value(reg, 'exprsn_cloud_budget_spend_source', { provider: 'digitalocean', source: 'estimate' })).toBe(1);
    spend.actual = 1200;
    await h.s.cloud.budgets.evaluate(account.id, now + 1000);
    expect(await value(reg, 'exprsn_cloud_budgets', { provider: 'digitalocean', band: '100' })).toBe(1);
    expect(await value(reg, 'exprsn_cloud_budgets_stopped', { provider: 'digitalocean' })).toBe(1);
    expect(await value(reg, 'exprsn_cloud_budget_alerts_total', { basis: 'actual', threshold: '100' })).toBe(1);
    // Removing the budget removes the account from the gauges.
    await h.s.cloud.budgets.remove(actor(), account.id);
    expect(await value(reg, 'exprsn_cloud_budgets_stopped', { provider: 'digitalocean' })).toBe(0);
    expect(await value(reg, 'exprsn_cloud_budget_burn_ratio', { provider: 'digitalocean' })).toBe(0);
  });

  it('a billing cost fetch moves the cost ingest counter (B-10603)', async () => {
    const before = await value(reg, 'exprsn_cloud_cost_ingests_total', { provider: 'digitalocean' });
    const r = await h.s.cloud.costs.ingestAccount(account.id, { manual: true });
    expect(['ok', 'failed'], JSON.stringify(r)).toContain(r.state);
    expect(await value(reg, 'exprsn_cloud_cost_ingests_total', { provider: 'digitalocean', outcome: r.state })).toBeGreaterThanOrEqual(1);
    expect(await value(reg, 'exprsn_cloud_cost_ingests_total', { provider: 'digitalocean' })).toBe(before + 1);
  });

  it('GPU nodes: provisioned, minimum, joined and idle from the graph and the gateway, and idle time accumulates', async () => {
    const d = await h.s.cloud.deployments.create(actor(), { name: 'metrics-gpu', accountId: account.id });
    const t = Date.now();
    const row = (key: string, type: string, spec: Record<string, unknown>, observed: Record<string, unknown> | null, state = 'ready') => ({ id: ulid(), deployment_id: d.id, key, type, region: 'fra1', provider_id: `p-${key}`, locator: null, desired: JSON.stringify({ key, type, spec, dependsOn: [], protect: false, region: null }), observed: observed ? JSON.stringify({ type, providerId: `p-${key}`, name: key, state: 'ready', tags: {}, props: observed }) : null, observed_hash: null, observed_at: t, depends_on: '[]', protect: false, tags: '{}', state, created_op: null, created_audit: null, last_verified: null, created_at: t, updated_at: t });
    await h.s.db('cloud_resources').insert([
      row('gpu-pool', 'node_group', { role: 'gpu', gpu: 'l4', min: 1, max: 4 }, { count: 3, min: 1 }),
      row('gpu-zero', 'node_group', { role: 'gpu', gpu: 'l4', min: 0, max: 2 }, { count: 0, min: 0 }),
      row('app-pool', 'node_group', { role: 'app', min: 2 }, { count: 2 }),
      row('gpu-vm-0', 'vm', { role: 'gpu', gpu: 'l4' }, { privateIp: '10.30.0.21', status: 'active' }),
      row('gpu-vm-1', 'vm', { role: 'gpu', gpu: 'l4' }, { privateIp: '10.30.0.22', status: 'active' }),
      row('gpu-vm-2', 'vm', { role: 'gpu', gpu: 'l4' }, { privateIp: '10.30.0.23', status: 'off' }),
      row('gpu-gone', 'vm', { role: 'gpu', gpu: 'l4' }, { privateIp: '10.30.0.24' }, 'deleted')
    ]);
    const pool = ulid();
    await h.s.db('pools').insert({ id: pool, name: `metrics-gpu-${pool.slice(-6).toLowerCase()}`, accelerator: 'cuda', zone: 'inference', label_ceiling: 'internal', created_at: t, updated_at: t });
    await h.s.db('instances').insert({ id: ulid(), pool_id: pool, name: 'gpu-vm-0', url: 'http://10.30.0.21:11434', deploy: 'baremetal', settings: '{}', state: 'active', health: 'healthy', created_at: t, updated_at: t });
    await h.s.db('instances').insert({ id: ulid(), pool_id: pool, name: 'gpu-vm-1', url: 'http://10.30.0.22:11434', deploy: 'baremetal', settings: '{}', state: 'active', health: 'unreachable', created_at: t, updated_at: t });

    // 3 + 0 node group nodes, two running GPU VMs (the stopped and the deleted one do not count); one VM serves a healthy instance.
    expect((await gpuNodes(h.s)).digitalocean).toEqual({ provisioned: 5, minimum: 1, joined: 1 });
    expect(await value(reg, 'exprsn_cloud_gpu_nodes', { provider: 'digitalocean', state: 'provisioned' })).toBe(5);
    expect(await value(reg, 'exprsn_cloud_gpu_nodes', { provider: 'digitalocean', state: 'minimum' })).toBe(1);
    expect(await value(reg, 'exprsn_cloud_gpu_nodes', { provider: 'digitalocean', state: 'joined' })).toBe(1);
    expect(await value(reg, 'exprsn_cloud_gpu_nodes', { provider: 'digitalocean', state: 'idle' })).toBe(4);
    // Idle time: four idle nodes held over the time between two scrapes.
    const idleBefore = await value(reg, 'exprsn_cloud_gpu_idle_seconds_total', { provider: 'digitalocean' });
    await new Promise((r) => setTimeout(r, 250));
    await value(reg, 'exprsn_cloud_gpu_nodes', { provider: 'digitalocean' });
    const idleAfter = await value(reg, 'exprsn_cloud_gpu_idle_seconds_total', { provider: 'digitalocean' });
    expect(idleAfter - idleBefore).toBeGreaterThanOrEqual(4 * 0.2);
    expect(idleAfter - idleBefore).toBeLessThan(4 * 10);
  });
});

// ---------------------------------------------------------------- dashboard and rules

interface Panel { title: string; type: string; targets?: { expr: string }[]; gridPos?: object; panels?: Panel[] }

const dashboard = () => JSON.parse(readFileSync(path.join(obs, 'grafana/exprsn-ai-cloud.json'), 'utf8')) as { uid: string; title: string; schemaVersion: number; panels: Panel[]; templating: { list: { name: string }[] } };
const rules = () => YAML.parse(readFileSync(path.join(obs, 'prometheus/exprsn-ai-cloud.rules.yml'), 'utf8')) as { groups: { name: string; rules: { alert?: string; record?: string; expr: string; labels?: Record<string, string>; annotations?: Record<string, string> }[] }[] };
const dashboardExprs = () => dashboard().panels.flatMap((p) => (p.targets ?? []).map((t) => ({ panel: p.title, expr: t.expr })));
/** Metric names in an expression: identifiers that are not functions, keywords or label names. */
const metricNames = (expr: string) => (expr.replace(/\{[^}]*\}/g, '{}').replace(/"[^"]*"/g, '""').match(/\b(?:exprsn_[a-z0-9_]+|exprsn:[a-z0-9_:]+)\b/g) ?? []);

describe('the cloud dashboard and rules render against the exported metrics (B-10702)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('every dashboard panel queries metrics the server exports', async () => {
    const names = await exported(h.s.metrics.registry);
    const d = dashboard();
    expect(d.uid).toBe('exprsn-ai-cloud');
    expect(d.schemaVersion).toBeGreaterThanOrEqual(36);
    expect(d.templating.list.map((v) => v.name)).toEqual(expect.arrayContaining(['datasource', 'job']));
    const exprs = dashboardExprs();
    expect(exprs.length).toBeGreaterThan(15);
    for (const { panel, expr } of exprs) {
      const used = metricNames(expr);
      expect(used.length, `${panel}: ${expr}`).toBeGreaterThan(0);
      for (const n of used) expect(names.has(n), `${n} in ${panel}`).toBe(true);
      expect(expr, panel).toContain('job=~"$job"');
    }
    // Every B-10702 subject has a panel.
    const all = exprs.map((e) => e.expr).join('\n');
    for (const m of ['exprsn_cloud_operations_total', 'exprsn_cloud_apply_duration_seconds_bucket', 'exprsn_cloud_wait_seconds_sum', 'exprsn_cloud_drift_findings', 'exprsn_cloud_budget_burn_ratio', 'exprsn_cloud_gpu_idle_seconds_total']) expect(all).toContain(m);
    for (const p of d.panels) expect(p.gridPos, p.title).toBeTruthy();
  });

  it('every rule names exported metrics (or a recording rule), and every alert is complete', async () => {
    const names = await exported(h.s.metrics.registry);
    const r = rules();
    const recorded = new Set(r.groups.flatMap((g) => g.rules.filter((x) => x.record).map((x) => x.record!)));
    const runbook = readFileSync(path.join(repo, 'docs/runbooks/alerts.md'), 'utf8').toLowerCase();
    for (const g of r.groups)
      for (const x of g.rules) {
        for (const n of metricNames(x.expr)) expect(names.has(n) || recorded.has(n), `${n} in ${x.alert ?? x.record}`).toBe(true);
        if (x.alert) {
          expect(x.labels?.severity).toMatch(/^(critical|warning|info)$/);
          expect(x.annotations?.summary).toBeTruthy();
          const anchor = x.annotations?.runbook ?? '';
          expect(anchor).toBe(`docs/runbooks/alerts.md#${x.alert.toLowerCase()}`);
          expect(runbook, `runbook section for ${x.alert}`).toContain(`## ${x.alert.toLowerCase()}`);
        }
      }
  });
});

// ---------------------------------------------------------------- promtool

/** How to run promtool here, or why it cannot run. */
function findPromtool(): { run: (args: string[], dir: string) => { status: number | null; out: string }; how: string } | { skip: string } {
  const local = [process.env.PROMTOOL, path.resolve(repo, '../toolchain/prometheus/bin/promtool')].filter((x): x is string => !!x && existsSync(x));
  const onPath = spawnSync('sh', ['-c', 'command -v promtool'], { encoding: 'utf8' }).stdout.trim();
  const bin = local[0] ?? (onPath || null);
  if (bin) return { how: bin, run: (args, dir) => { const r = spawnSync(bin, args, { cwd: dir, encoding: 'utf8', timeout: 120_000 }); return { status: r.status, out: `${r.stdout}${r.stderr}` }; } };
  const image = process.env.PROMETHEUS_IMAGE ?? 'prom/prometheus:v3.5.0';
  const have = spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf8', timeout: 30_000 });
  if (have.status === 0) return { how: `docker ${image}`, run: (args, dir) => { const r = spawnSync('docker', ['run', '--rm', '--network', 'none', '-v', `${dir}:/rules:ro`, '-w', '/rules', '--entrypoint', '/bin/promtool', image, ...args], { encoding: 'utf8', timeout: 180_000 }); return { status: r.status, out: `${r.stdout}${r.stderr}` }; } };
  return { skip: `promtool is not available (no PROMTOOL, no toolchain/prometheus/bin/promtool, none on PATH, and the ${image} image is not pulled); CI runs it from the image.` };
}

describe('promtool on the cloud rules (B-10702)', () => {
  const tool = findPromtool();
  const skip = 'skip' in tool ? tool.skip : null;
  if (skip) process.stderr.write(`cloud-metrics: ${skip}\n`);

  it.skipIf(!!skip)('promtool check rules passes every rules file and test rules passes the cloud rules\' unit tests', () => {
    if ('skip' in tool) return;
    const dir = path.join(obs, 'prometheus');
    const check = tool.run(['check', 'rules', 'exprsn-ai.rules.yml', 'exprsn-ai-cloud.rules.yml'], dir);
    expect(check.status, check.out).toBe(0);
    expect(check.out).toMatch(/exprsn-ai-cloud\.rules\.yml[\s\S]*SUCCESS/);
    const test = tool.run(['test', 'rules', 'exprsn-ai-cloud.rules.test.yml', 'exprsn-ai.rules.test.yml'], dir);
    expect(test.status, test.out).toBe(0);
  });

  it.skipIf(!!skip)('promtool parses every dashboard expression', () => {
    if ('skip' in tool) return;
    const tmp = mkdtempSync(path.join(tmpdir(), 'exprsn-dash-'));
    try {
      const doc = { groups: [{ name: 'dashboard', rules: dashboardExprs().map((e, i) => ({ record: `exprsn:dashboard_check_${i}`, expr: e.expr.replace(/\$job/g, '.+') })) }] };
      writeFileSync(path.join(tmp, 'dashboard.rules.yml'), YAML.stringify(doc));
      const r = tool.run(['check', 'rules', 'dashboard.rules.yml'], tmp);
      expect(r.status, r.out).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
