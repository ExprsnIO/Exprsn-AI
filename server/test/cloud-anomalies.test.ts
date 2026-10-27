import { ulid } from 'ulid';
import type { Registry } from 'prom-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { assess, robustBaseline, ANOMALY_MIN_HISTORY_DAYS } from '../src/cloud/anomalies.js';
import type { CloudAccount } from '../src/cloud/types.js';
import { seedAccount } from './cloud-credentials-helpers.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * 1.9.99-final, Sprint 62 (B-10606): spend anomalies. Daily spend per account and service against a robust 14-day
 * baseline (median and MAD) over ingested cost rows (written here as ingestion writes them; no provider is called).
 * A tripled NAT gateway cost raises one alert naming the deployment and the top contributors (service, region,
 * deployment, tag), as a notice of kind cloud.anomaly and the audit event cloud.anomaly.detected that a webhook
 * receives, counted in exprsn_cloud_anomalies_total; the same day is never alerted twice; normal variation and too
 * little history raise nothing; acknowledging stops repeat notices; the routes and their permissions; the overview.
 * Migrations 146, 148, 155 and 166 are applied here when the harness lacks them (166 is not registered yet).
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-21T09:00:00Z');
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const YESTERDAY = dayOf(NOW - DAY);
const NAT = 'Amazon VPC NAT Gateway';

async function install(h: Harness): Promise<void> {
  const db = h.s.db;
  if (!(await db.schema.hasTable('cloud_accounts'))) await (await import('../src/db/migrations/146_cloud_accounts.js')).up(db);
  if (!(await db.schema.hasTable('cloud_deployments'))) await (await import('../src/db/migrations/148_cloud_journal.js')).up(db);
  if (!(await db.schema.hasTable('cloud_costs'))) await (await import('../src/db/migrations/155_cloud_costs.js')).up(db);
  if (!(await db.schema.hasTable('cloud_anomalies'))) await (await import('../src/db/migrations/166_cloud_anomalies.js')).up(db);
  h.s.cloud.accounts.resetSchemaCache();
  h.s.cloud.deployments.resetSchemaCache();
  h.s.cloud.costs.resetSchemaCache();
  h.s.cloud.anomalies.resetSchemaCache();
}

async function metric(reg: Registry, name: string, labels: Record<string, string> = {}): Promise<number> {
  const m = reg.getSingleMetric(name);
  if (!m) throw new Error(`${name} is not registered`);
  const got = await m.get();
  return got.values.filter((v) => Object.entries(labels).every(([k, x]) => String((v.labels as Record<string, unknown>)[k]) === x)).reduce((n, v) => n + v.value, 0);
}

describe('the robust baseline', () => {
  it('is the median and the median absolute deviation, so one spike does not move it', () => {
    expect(robustBaseline([60, 61, 59, 60, 62, 58, 60])).toEqual({ median: 60, mad: 1 });
    expect(robustBaseline([60, 60, 60, 60, 60, 60, 600]).median).toBe(60);
    expect(robustBaseline([1, 2, 3, 4])).toEqual({ median: 2.5, mad: 1 });
  });

  it('calls a tripled day an anomaly and ordinary variation not', () => {
    const base = [58, 62, 60, 55, 65, 60, 61, 59, 63, 57, 60, 62, 58, 60];
    expect(assess(180, base)).toMatchObject({ anomalous: true, median: 60, ratio: 3 });
    expect(assess(72, base).anomalous).toBe(false); // within the spread, and less than 50 % above
    // Fifty percent above but tiny: below the absolute floor.
    expect(assess(9, [3, 3, 3, 3, 3, 3, 3, 3]).reasons).toEqual(expect.arrayContaining(['less than 50 above the baseline']));
    // Too little history decides nothing.
    expect(assess(180, [60, 60, 60]).anomalous).toBe(false);
    expect(ANOMALY_MIN_HISTORY_DAYS).toBe(7);
  });
});

describe('spend anomalies (B-10606)', () => {
  let h: Harness;
  let aws: CloudAccount;
  let quiet: CloudAccount;
  let fresh: CloudAccount;
  const dep: Record<string, string> = {};
  let root: Client;
  let analyst: Client;
  let fin: { id: string };
  let wsId: string;

  const deployment = async (a: CloudAccount, name: string, region: string, resources: { type: string; providerId: string; tags: Record<string, string> }[]) => {
    const id = ulid();
    await h.s.db('cloud_deployments').insert({ id, tenant_id: h.tenantId, scope: 'platform', account_id: a.id, provider: a.provider, name, region, label: 'internal', state: 'ready', health: 'healthy', observed_version: 0, created_at: NOW, updated_at: NOW });
    for (const [i, r] of resources.entries()) await h.s.db('cloud_resources').insert({ id: ulid(), deployment_id: id, key: `r${i}`, type: r.type, region, provider_id: r.providerId, desired: JSON.stringify({ key: `r${i}`, type: r.type, spec: {} }), depends_on: '[]', tags: JSON.stringify({ 'exprsn:managed': 'true', 'exprsn:account': a.name, 'exprsn:deployment': name, ...r.tags }), state: 'ready', created_at: NOW, updated_at: NOW });
    return id;
  };
  const cost = (a: CloudAccount, o: { deploymentId?: string | null; allocation?: string; service: string; amount: number; day: string; currency?: string }) =>
    h.s.db('cloud_costs').insert({ id: ulid(), account_id: a.id, provider: a.provider, deployment_id: o.deploymentId ?? null, allocation: o.allocation ?? '', service: o.service, day: o.day, amount: String(o.amount), currency: o.currency ?? 'USD', source: 'aws-cost-explorer', estimated: false, fetched_at: NOW });
  /** `n` days of history before yesterday, then yesterday. */
  const days = (n: number) => Array.from({ length: n }, (_, i) => dayOf(NOW - (n + 1 - i) * DAY));

  beforeAll(async () => {
    h = await harness({ SERVICE_ALLOWED_HOSTS: '127.0.0.1' });
    await install(h);
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Finance Ops', 'internal')).id;
    aws = await seedAccount(h, { provider: 'aws', mode: 'vaulted', name: 'aws-prod', providerIds: { awsAccountId: '111122223333' } });
    quiet = await seedAccount(h, { provider: 'aws', mode: 'vaulted', name: 'aws-quiet', providerIds: { awsAccountId: '444455556666' } });
    fresh = await seedAccount(h, { provider: 'aws', mode: 'vaulted', name: 'aws-new', providerIds: { awsAccountId: '777788889999' } });
    dep.prod = await deployment(aws, 'nw-prod-eu', 'eu-central-1', [{ type: 'nat_gateway', providerId: 'nat-0abc', tags: { 'exprsn:workspace': wsId } }]);
    dep.lab = await deployment(aws, 'nw-lab', 'us-east-1', [{ type: 'vm', providerId: 'i-lab', tags: {} }]);

    // aws-prod: 14 ordinary days of NAT (nw-prod-eu about 50, nw-lab 10), EC2 steady; yesterday nw-prod-eu's NAT
    // cost triples while EC2 and nw-lab stay ordinary.
    const wobble = [0, 2, -1, 3, -2, 1, 0, -3, 2, 1, -1, 0, 2, -2];
    for (const [i, d] of days(14).entries()) {
      await cost(aws, { deploymentId: dep.prod, allocation: 'nw-prod-eu', service: NAT, amount: 50 + wobble[i]!, day: d });
      await cost(aws, { deploymentId: dep.lab, allocation: 'nw-lab', service: NAT, amount: 10, day: d });
      await cost(aws, { deploymentId: dep.prod, allocation: 'nw-prod-eu', service: 'Amazon Elastic Compute Cloud - Compute', amount: 400 + wobble[i]! * 5, day: d });
    }
    await cost(aws, { deploymentId: dep.prod, allocation: 'nw-prod-eu', service: NAT, amount: 170, day: YESTERDAY });
    await cost(aws, { deploymentId: dep.lab, allocation: 'nw-lab', service: NAT, amount: 10, day: YESTERDAY });
    await cost(aws, { deploymentId: dep.prod, allocation: 'nw-prod-eu', service: 'Amazon Elastic Compute Cloud - Compute', amount: 430, day: YESTERDAY });

    // aws-quiet: ordinary variation only (a busy Monday at +30 %).
    for (const [i, d] of days(14).entries()) await cost(quiet, { service: 'Amazon Relational Database Service', amount: 120 + wobble[i]! * 4, day: d });
    await cost(quiet, { service: 'Amazon Relational Database Service', amount: 156, day: YESTERDAY });

    // aws-new: connected four days ago, so a tripled day has too little history to judge.
    for (const d of days(4)) await cost(fresh, { service: NAT, amount: 60, day: d });
    await cost(fresh, { service: NAT, amount: 180, day: YESTERDAY });

    fin = await localUser(h, 'anfin', ['finops-analyst'], 'internal');
    await localUser(h, 'anroot', ['system-admin'], 'restricted');
    await localUser(h, 'anmember', ['member'], 'internal');
    root = await loginAdmin(h, 'anroot');
    analyst = await loginAdmin(h, 'anfin');
  }, 180_000);

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await h.s.db('cloud_anomalies').del();
  });

  it('a tripled NAT gateway cost raises one alert naming the deployment and the top contributors, as a notice, a webhook and a metric', async () => {
    const reg = h.s.metrics.registry;
    const before = await metric(reg, 'exprsn_cloud_anomalies_total', { provider: 'aws' });
    const { row: hook } = await h.s.webhooks.create(h.tenantId, 'test', { name: 'anomalies', url: 'http://127.0.0.1:9/hook', events: ['cloud.anomaly.*'], maxLabel: 'internal' });

    const found = await h.s.cloud.anomalies.detectAccount(aws.id, { now: NOW });
    expect(found).toHaveLength(1);
    const a = found[0]!;
    expect(a).toMatchObject({ accountId: aws.id, provider: 'aws', day: YESTERDAY, service: NAT, currency: 'USD', actual: 180, state: 'open', historyDays: 14 });
    expect(a.baseline).toBe(60);
    expect(a.ratio).toBe(3);
    expect(a.increasePct).toBe(200);
    // Top contributors: the service, nw-prod-eu (not nw-lab, which stayed flat), its region and its workspace tag.
    expect(a.top.deployment).toMatchObject({ dimension: 'deployment', key: dep.prod, name: 'nw-prod-eu', actual: 170, baseline: 50, extra: 120 });
    expect(a.top.region).toMatchObject({ name: 'eu-central-1', extra: 120 });
    expect(a.top.tag).toMatchObject({ name: `exprsn:workspace=${wsId}`, extra: 120 });
    expect(a.contributors.find((c) => c.dimension === 'service')).toMatchObject({ name: NAT, actual: 180, baseline: 60, extra: 120 });
    expect(a.contributors.some((c) => c.dimension === 'deployment' && c.name === 'nw-lab')).toBe(false);

    // The notice (kind cloud.anomaly) to the FinOps reader names the deployment.
    const notes = (await h.s.db('notifications').where({ kind: 'cloud.anomaly', user_id: fin.id })) as { title: string; body: string; route: string }[];
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toBe(`aws-prod: ${NAT} up 200 % on ${YESTERDAY}`);
    expect(notes[0]!.body).toContain('deployment nw-prod-eu (+120.00)');
    expect(notes[0]!.body).toContain('region eu-central-1');
    expect(notes[0]!.route).toBe(`cloud-spend?tab=anomalies&anomaly=${a.id}`);

    // The audit event cloud.anomaly.detected, naming the deployment, which the webhook subscribed to cloud.anomaly.* receives.
    const audits = await h.s.audit.list(h.tenantId, { action: 'cloud.anomaly.detected' });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.target).toMatchObject({ deployment: dep.prod, name: 'nw-prod-eu' });
    expect(audits[0]!.detail).toMatchObject({ anomaly: a.id, account: aws.id, service: NAT, actual: 180, baseline: 60 });
    expect(a.auditId).toBe(audits[0]!.id);
    await new Promise((r) => setTimeout(r, 100));
    const deliveries = (await h.s.db('webhook_deliveries').where({ webhook_id: hook.id })) as { id: string; payload: string }[];
    const types = await Promise.all(deliveries.map(async (d) => (JSON.parse(await h.s.keys.open(h.tenantId, d.payload, `webhook-delivery:${d.id}`)) as { type: string }).type));
    expect(types.filter((t) => t === 'cloud.anomaly.detected')).toHaveLength(1);

    // The metric counts it, and the open gauge sees it.
    expect(await metric(reg, 'exprsn_cloud_anomalies_total', { provider: 'aws' })).toBe(before + 1);
    expect(await metric(reg, 'exprsn_cloud_anomalies_open', { provider: 'aws' })).toBe(1);

    // No repeat the same day: a second run (another instance, the daily fallback) stores and announces nothing.
    expect(await h.s.cloud.anomalies.detectAccount(aws.id, { now: NOW + 3_600_000 })).toEqual([]);
    expect(await h.s.cloud.anomalies.detect({ now: NOW + 7_200_000 })).toMatchObject({ anomalies: 0 });
    expect(await h.s.db('cloud_anomalies').where({ account_id: aws.id })).toHaveLength(1);
    expect(await h.s.db('notifications').where({ kind: 'cloud.anomaly', user_id: fin.id })).toHaveLength(1);
    expect(await h.s.audit.list(h.tenantId, { action: 'cloud.anomaly.detected' })).toHaveLength(1);
    expect(await metric(reg, 'exprsn_cloud_anomalies_total', { provider: 'aws' })).toBe(before + 1);
    await h.s.db('notifications').where({ kind: 'cloud.anomaly' }).del();
  });

  it('normal variation and too little history raise nothing', async () => {
    expect(await h.s.cloud.anomalies.detectAccount(quiet.id, { now: NOW })).toEqual([]);
    expect(await h.s.cloud.anomalies.detectAccount(fresh.id, { now: NOW })).toEqual([]);
    // The EC2 service of aws-prod rose 7 % and is no anomaly either.
    const found = await h.s.cloud.anomalies.detectAccount(aws.id, { now: NOW });
    expect(found.map((x) => x.service)).toEqual([NAT]);
    await h.s.db('notifications').where({ kind: 'cloud.anomaly' }).del();
  });

  it('lists and acknowledges through the routes; acknowledging stops repeat notices for a few days', async () => {
    const [a] = await h.s.cloud.anomalies.detectAccount(aws.id, { now: NOW });
    const list = (await analyst.agent.get('/api/admin/cloud/anomalies').expect(200)).body as { anomalies: { id: string; state: string; account: { name: string }; top: { deployment: { name: string } } }[] };
    expect(list.anomalies).toEqual([expect.objectContaining({ id: a!.id, state: 'open', account: expect.objectContaining({ name: 'aws-prod' }), top: expect.objectContaining({ deployment: expect.objectContaining({ name: 'nw-prod-eu' }) }) })]);
    expect((await analyst.agent.get(`/api/admin/cloud/anomalies/${a!.id}`).expect(200)).body.service).toBe(NAT);
    expect((await analyst.agent.get('/api/admin/cloud/anomalies?state=acknowledged').expect(200)).body.anomalies).toEqual([]);
    // finops:read alone does not acknowledge; finops:manage (and platform:manage for a platform account) does.
    await analyst.agent.post(`/api/admin/cloud/anomalies/${a!.id}/acknowledge`).set('x-csrf-token', analyst.csrf).send({ note: 'image pulls' }).expect(403);
    const ack = (await root.agent.post(`/api/admin/cloud/anomalies/${a!.id}/acknowledge`).set('x-csrf-token', root.csrf).send({ note: 'Image pulls after a spot replacement' }).expect(200)).body;
    expect(ack).toMatchObject({ state: 'acknowledged', note: 'Image pulls after a spot replacement' });
    expect((await root.agent.post(`/api/admin/cloud/anomalies/${a!.id}/acknowledge`).set('x-csrf-token', root.csrf).send({}).expect(409)).body.reason).toBe('anomaly_acknowledged');
    expect(await h.s.audit.list(h.tenantId, { action: 'cloud.anomaly.acknowledged' })).toHaveLength(1);

    // The next day the NAT cost is still high: stored as acknowledged, no notice, audited as suppressed.
    await cost(aws, { deploymentId: dep.prod, allocation: 'nw-prod-eu', service: NAT, amount: 175, day: dayOf(NOW) });
    await cost(aws, { deploymentId: dep.lab, allocation: 'nw-lab', service: NAT, amount: 10, day: dayOf(NOW) });
    const notesBefore = (await h.s.db('notifications').where({ kind: 'cloud.anomaly' })).length;
    const next = await h.s.cloud.anomalies.detectAccount(aws.id, { now: NOW + DAY });
    expect(next).toEqual([expect.objectContaining({ day: dayOf(NOW), state: 'acknowledged', suppressedBy: a!.id })]);
    expect((await h.s.db('notifications').where({ kind: 'cloud.anomaly' })).length).toBe(notesBefore);
    expect(await h.s.audit.list(h.tenantId, { action: 'cloud.anomaly.suppressed' })).toHaveLength(1);
    await h.s.db('cloud_costs').where({ account_id: aws.id, day: dayOf(NOW) }).del();

    // A member without finops:read or cloud:read is refused.
    const member = await loginAdmin(h, 'anmember');
    await member.agent.get('/api/admin/cloud/anomalies').expect(403);
    await member.agent.get('/api/admin/cloud/spend').expect(403);
    await h.s.db('notifications').where({ kind: 'cloud.anomaly' }).del();
  });

  it('the spend overview has the month per day and provider, and the open anomalies', async () => {
    await h.s.cloud.anomalies.detectAccount(aws.id, { now: NOW });
    const month = YESTERDAY.slice(0, 7);
    const o = (await analyst.agent.get(`/api/admin/cloud/spend?month=${month}`).expect(200)).body as { month: string; daily: { day: string; provider: string; amount: number }[]; totals: { provider: string; currency: string; amount: number }[]; anomaliesOpen: number; accounts: unknown[] };
    expect(o.month).toBe(month);
    expect(o.accounts).toHaveLength(3);
    expect(o.daily.find((d) => d.day === YESTERDAY && d.provider === 'aws')!.amount).toBe(170 + 10 + 430 + 156 + 180);
    expect(o.totals.find((t) => t.provider === 'aws' && t.currency === 'USD')!.amount).toBeGreaterThan(0);
    expect(o.anomaliesOpen).toBe(1);
    await analyst.agent.get('/api/admin/cloud/spend?month=2026-13').expect(400);
  });

  it('without migration 166 nothing is detected and the routes answer 503', async () => {
    await (await import('../src/db/migrations/166_cloud_anomalies.js')).down(h.s.db);
    h.s.cloud.anomalies.resetSchemaCache();
    try {
      expect(await h.s.cloud.anomalies.detectAccount(aws.id, { now: NOW })).toEqual([]);
      expect((await analyst.agent.get('/api/admin/cloud/anomalies').expect(503)).body.reason).toBe('migration_pending');
      expect((await analyst.agent.get(`/api/admin/cloud/spend?month=${YESTERDAY.slice(0, 7)}`).expect(200)).body.anomaliesOpen).toBeNull();
    } finally {
      await (await import('../src/db/migrations/166_cloud_anomalies.js')).up(h.s.db);
      h.s.cloud.anomalies.resetSchemaCache();
    }
  });
});
