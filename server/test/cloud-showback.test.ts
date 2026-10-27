import { ulid } from 'ulid';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { costTypeOf, splitMicros, type ShowbackLine } from '../src/cloud/showback.js';
import type { CloudAccount, Provider, ProviderIds } from '../src/cloud/types.js';
import { seedAccount } from './cloud-credentials-helpers.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * 1.9.99-final, Sprint 61 (B-10604): showback over ingested cloud costs (rows written here as ingestion writes them;
 * no provider is called). Allocation by the `exprsn:workspace`, `exprsn:pool` and `exprsn:tenant` tags (and a
 * tenant-scoped deployment), shared costs split by the rule of their cost type (GPU time, tokens and model cost,
 * requests, storage), monthly per workspace and tenant, the CSV export, statement lines only when the tenant turns them
 * on, currencies kept apart, and the month's showback plus the unallocated line equal to the month's ingested total.
 * Migrations 146, 148, 155, 160 and 164 are applied here when the harness lacks them (164 is not registered yet).
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const M = '2026-10';
const T0 = Date.parse('2026-10-20T08:00:00Z');

async function install(h: Harness): Promise<void> {
  const db = h.s.db;
  if (!(await db.schema.hasTable('cloud_accounts'))) await (await import('../src/db/migrations/146_cloud_accounts.js')).up(db);
  if (!(await db.schema.hasTable('cloud_deployments'))) await (await import('../src/db/migrations/148_cloud_journal.js')).up(db);
  if (!(await db.schema.hasTable('cloud_costs'))) await (await import('../src/db/migrations/155_cloud_costs.js')).up(db);
  if (!(await db.schema.hasColumn('usage_records', 'neurons'))) await (await import('../src/db/migrations/160_cloud_model_servers.js')).up(db);
  if (!(await db.schema.hasTable('cloud_showback'))) await (await import('../src/db/migrations/164_cloud_showback.js')).up(db);
  h.s.cloud.accounts.resetSchemaCache();
  h.s.cloud.deployments.resetSchemaCache();
  h.s.cloud.costs.resetSchemaCache();
  h.s.cloud.showback.resetSchemaCache();
}

describe('showback (B-10604)', () => {
  let h: Harness;
  let tenantB: string;
  const ws: Record<string, string> = {};
  const acc: Record<string, CloudAccount> = {};
  const dep: Record<string, string> = {};
  let poolX: string;
  let root: Client;
  let analyst: Client;

  const account = async (provider: Provider, name: string, providerIds: ProviderIds, o: { scope?: 'platform' | 'tenant'; tenantId?: string } = {}) => seedAccount(h, { provider, mode: 'vaulted', name, providerIds, ...(o.scope ? { scope: o.scope } : {}), ...(o.tenantId ? { tenantId: o.tenantId } : {}) });
  const deployment = async (a: CloudAccount, name: string, o: { scope?: 'platform' | 'tenant'; tenantId?: string; resources?: { type: string; providerId: string; tags: Record<string, string> }[] } = {}) => {
    const id = ulid();
    await h.s.db('cloud_deployments').insert({ id, tenant_id: o.tenantId ?? h.tenantId, scope: o.scope ?? 'platform', account_id: a.id, provider: a.provider, name, region: 'eu-central-1', label: 'internal', state: 'ready', health: 'healthy', observed_version: 0, created_at: T0, updated_at: T0 });
    for (const [i, r] of (o.resources ?? []).entries()) await h.s.db('cloud_resources').insert({ id: ulid(), deployment_id: id, key: `r${i}`, type: r.type, region: 'eu-central-1', provider_id: r.providerId, desired: JSON.stringify({ key: `r${i}`, type: r.type, spec: {} }), depends_on: '[]', tags: JSON.stringify({ 'exprsn:managed': 'true', 'exprsn:account': a.name, 'exprsn:deployment': name, ...r.tags }), state: 'ready', created_at: T0, updated_at: T0 });
    return id;
  };
  const cost = (a: CloudAccount, o: { deploymentId?: string | null; allocation?: string; service: string; amount: string; currency?: string; day?: string }) =>
    h.s.db('cloud_costs').insert({ id: ulid(), account_id: a.id, provider: a.provider, deployment_id: o.deploymentId ?? null, allocation: o.allocation ?? '', service: o.service, day: o.day ?? '2026-10-12', amount: o.amount, currency: o.currency ?? 'USD', source: 'aws-cost-explorer', estimated: false, fetched_at: T0 });
  const usage = (tenantId: string, workspaceId: string, poolId: string | null, o: { gpuMs?: number; tokens?: number; costMicros?: number | null; n?: number }) =>
    Promise.all(
      Array.from({ length: o.n ?? 1 }, () =>
        h.s.db('usage_records').insert({ id: ulid(), tenant_id: tenantId, workspace_id: workspaceId, user_id: null, kind: 'chat', model: 'm', pool_id: poolId, prompt_tokens: o.tokens ?? 0, output_tokens: 0, thinking_tokens: 0, calc_calls: 0, gpu_ms: o.gpuMs ?? 0, day: 20261012, month: 202610, ts: Date.parse('2026-10-12T10:00:00Z'), neurons: null, cost_micros: o.costMicros ?? null, currency: o.costMicros != null ? 'USD' : null, price_id: null })
      )
    );
  const file = (tenantId: string, workspaceId: string, size: number) => h.s.db('files').insert({ id: ulid(), tenant_id: tenantId, workspace_id: workspaceId, folder_id: null, owner_id: ulid(), name: `f-${ulid()}`, name_lower: `f-${ulid()}`.toLowerCase(), label: 'internal', state: 'ready', current_version: 1, size, type: 'text/plain', created_at: T0, updated_at: T0 });
  const amountOf = (lines: ShowbackLine[], f: (l: ShowbackLine) => boolean) => Math.round(lines.filter(f).reduce((n, l) => n + l.amount, 0) * 1e6) / 1e6;

  beforeAll(async () => {
    h = await harness({ SERVICE_ALLOWED_HOSTS: '127.0.0.1' });
    await install(h);
    tenantB = (await h.s.tenants.create({ slug: 'showback-b', name: 'Tenant B' })).id;
    ws.a1 = (await h.s.tenants.createWorkspace(h.tenantId, 'Research', 'internal')).id;
    ws.a2 = (await h.s.tenants.createWorkspace(h.tenantId, 'Support', 'internal')).id;
    ws.b1 = (await h.s.tenants.createWorkspace(tenantB, 'Lab', 'internal')).id;
    poolX = (await h.s.gateway.repo.createPool({ name: 'gpu-x', accelerator: 'cuda', zone: 'inference', labelCeiling: 'internal' })).id;
    acc.aws = await account('aws', 'aws-sb', { awsAccountId: '111122223333' });
    acc.az = await account('azure', 'az-sb', { azureTenantId: 't', azureSubscriptionId: 's' });
    acc.doB = await account('digitalocean', 'do-b', { doTeamId: 'team-b' }, { scope: 'tenant', tenantId: tenantB });
    dep.shared = await deployment(acc.aws, 'shared', { resources: [{ type: 'kubernetes_cluster', providerId: 'eks-1', tags: {} }, { type: 'database', providerId: 'rds-1', tags: {} }] });
    dep.a1 = await deployment(acc.aws, 'research-app', { resources: [{ type: 'vm', providerId: 'i-1', tags: { 'exprsn:workspace': ws.a1 } }, { type: 'bucket', providerId: 'b-1', tags: { 'exprsn:workspace': ws.a1 } }] });
    dep.gpu = await deployment(acc.aws, 'gpu', { resources: [{ type: 'node_group', providerId: 'ng-1', tags: { 'exprsn:pool': poolX } }] });
    dep.b = await deployment(acc.doB, 'b-app', { scope: 'tenant', tenantId: tenantB, resources: [{ type: 'vm', providerId: '4242', tags: { 'exprsn:tenant': tenantB } }] });

    // The month's usage: requests A1 1, A2 2, B1 1; GPU time on pool X A1 1 s, B1 3 s; model cost A2 3,000, B1 1,000 micros.
    await usage(h.tenantId, ws.a1, poolX, { gpuMs: 1000, tokens: 100 });
    await usage(h.tenantId, ws.a2, null, { tokens: 150, costMicros: 1500, n: 2 });
    await usage(tenantB, ws.b1, poolX, { gpuMs: 3000, tokens: 600, costMicros: 1000 });
    // Storage: A1 100 bytes, B1 200 bytes (a trashed file does not count).
    await file(h.tenantId, ws.a1, 100);
    await file(tenantB, ws.b1, 200);
    await h.s.db('files').insert({ id: ulid(), tenant_id: tenantB, workspace_id: ws.b1, folder_id: null, owner_id: ulid(), name: 'gone', name_lower: 'gone', label: 'internal', state: 'ready', current_version: 1, size: 9999, type: 'text/plain', created_at: T0, updated_at: T0, trashed_at: T0 });

    await cost(acc.aws, { deploymentId: dep.a1, allocation: 'research-app', service: 'Amazon Elastic Compute Cloud - Compute', amount: '10' }); // tag: A1
    await cost(acc.aws, { deploymentId: dep.gpu, allocation: 'gpu', service: 'Amazon Elastic Compute Cloud - Compute', amount: '20' }); // pool: GPU time 1:3
    await cost(acc.aws, { deploymentId: dep.shared, allocation: 'shared', service: 'Amazon Elastic Kubernetes Service', amount: '9' }); // compute: requests 1:2:1
    await cost(acc.aws, { deploymentId: dep.shared, allocation: 'shared', service: 'Amazon Relational Database Service', amount: '6' }); // database: storage 1:2
    await cost(acc.aws, { service: 'Tax', amount: '1' }); // other: requests
    await cost(acc.aws, { service: 'Amazon Bedrock', amount: '4' }); // model: model cost 3:1
    await cost(acc.doB, { deploymentId: dep.b, allocation: '4242', service: 'Droplets', amount: '5' }); // tenant B's own (account, deployment and tag)
    await cost(acc.az, { service: 'Virtual Machines', amount: '7', currency: 'EUR' }); // another currency, never converted
    await cost(acc.aws, { service: 'Tax', amount: '100', day: '2026-09-30' }); // another month

    await localUser(h, 'sbroot', ['system-admin'], 'restricted');
    await localUser(h, 'sbanalyst', ['finops-analyst'], 'internal');
    root = await loginAdmin(h, 'sbroot');
    analyst = await loginAdmin(h, 'sbanalyst');
  }, 180_000);

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await h.s.db('cloud_allocation_rules').del();
    await h.s.db('cloud_showback').del();
    await h.s.db('cloud_showback_settings').del();
  });

  it('splits exactly, credits too, and types costs by resource and service', () => {
    const parts = splitMicros(1_000_000, new Map([['a', 1], ['b', 1], ['c', 1]]));
    expect([...parts.values()].reduce((n, v) => n + v, 0)).toBe(1_000_000);
    expect(splitMicros(-10, new Map([['a', 1], ['b', 3]]))).toEqual(new Map([['a', -3], ['b', -7]]));
    expect(splitMicros(5, new Map())).toEqual(new Map());
    expect(costTypeOf('Amazon Relational Database Service', null, {})).toBe('database');
    expect(costTypeOf('Anything', 'node_group', { 'exprsn:pool': 'p' })).toBe('gpu');
    expect(costTypeOf('Workers AI', null, {})).toBe('model');
    expect(costTypeOf('R2', null, {})).toBe('storage');
    expect(costTypeOf('Amazon CloudFront', null, {})).toBe('network');
    expect(costTypeOf('Tax', null, {})).toBe('other');
  });

  it('allocates by tags, splits shared costs per rule, and the month across workspaces plus unallocated equals the ingested total', async () => {
    const lines = await h.s.cloud.showback.compute(M);
    const usd = lines.filter((l) => l.currency === 'USD');
    // The tagged deployment is A1's.
    expect(usd.filter((l) => l.method === 'tag')).toEqual([{ tenantId: h.tenantId, workspaceId: ws.a1, currency: 'USD', costType: 'compute', method: 'tag', amount: 10 }]);
    // The GPU pool by GPU time: A1 1 s, B1 3 s.
    expect(amountOf(usd, (l) => l.method === 'pool' && l.workspaceId === ws.a1)).toBe(5);
    expect(amountOf(usd, (l) => l.method === 'pool' && l.workspaceId === ws.b1)).toBe(15);
    // The cluster by requests (1:2:1), the database by storage (1:2), tax by requests, Bedrock by model cost (3:1).
    expect(amountOf(usd, (l) => l.method === 'shared' && l.costType === 'compute' && l.workspaceId === ws.a2)).toBe(4.5);
    expect(amountOf(usd, (l) => l.method === 'shared' && l.costType === 'database' && l.workspaceId === ws.b1)).toBe(4);
    expect(amountOf(usd, (l) => l.method === 'shared' && l.costType === 'database' && l.workspaceId === ws.a1)).toBe(2);
    expect(amountOf(usd, (l) => l.costType === 'other' && l.workspaceId === ws.a2)).toBe(0.5);
    expect(amountOf(usd, (l) => l.costType === 'model' && l.workspaceId === ws.a2)).toBe(3);
    expect(amountOf(usd, (l) => l.costType === 'model' && l.workspaceId === ws.b1)).toBe(1);
    // Tenant B's own droplet stays in tenant B.
    expect(usd.filter((l) => l.method === 'tenant')).toEqual([expect.objectContaining({ tenantId: tenantB, workspaceId: ws.b1, amount: 5 })]);
    // The month's total, per currency: everything shown back plus the unallocated line equals what was ingested.
    expect(amountOf(usd, () => true)).toBe(55);
    expect(amountOf(lines.filter((l) => l.currency === 'EUR'), () => true)).toBe(7);
    // Per workspace.
    expect(amountOf(usd, (l) => l.workspaceId === ws.a1)).toBe(10 + 5 + 2.25 + 2 + 0.25);
    expect(amountOf(usd, (l) => l.workspaceId === ws.b1)).toBe(15 + 2.25 + 4 + 0.25 + 1 + 5);
    expect(amountOf(usd, (l) => !l.tenantId)).toBe(0);

    // A rule leaves databases unallocated: the identity still holds, with the database on the unallocated line.
    await root.agent.put('/api/admin/cloud/showback/rules').set('x-csrf-token', root.csrf).send({ rules: { database: 'unallocated', compute: 'tokens' } }).expect(200);
    const after = await h.s.cloud.showback.compute(M);
    expect(amountOf(after, (l) => l.currency === 'USD' && !l.tenantId && l.costType === 'database')).toBe(6);
    // The cluster by tokens now: A1 100, A2 300, B1 600.
    expect(amountOf(after, (l) => l.currency === 'USD' && l.method === 'shared' && l.costType === 'compute' && l.workspaceId === ws.b1)).toBe(5.4);
    expect(amountOf(after.filter((l) => l.currency === 'USD'), () => true)).toBe(55);
    const rules = (await analyst.agent.get('/api/admin/cloud/showback/rules').expect(200)).body;
    expect(rules.rules.find((r: { costType: string }) => r.costType === 'database')).toMatchObject({ basis: 'unallocated', default: false });
    expect((await h.s.audit.list(h.tenantId, { action: 'cloud.showback.rules.updated' })).length).toBeGreaterThan(0);
  });

  it('reports monthly per tenant and workspace, per currency, and only the own tenant to a tenant reader', async () => {
    const all = (await root.agent.get(`/api/admin/cloud/showback?month=${M}`).expect(200)).body;
    expect(all.stored).toBe(false);
    expect(all.currencies).toEqual([{ currency: 'EUR', ingested: 7, allocated: 7, unallocated: 0 }, { currency: 'USD', ingested: 55, allocated: 55, unallocated: 0 }]);
    const b = all.tenants.find((t: { tenantId: string; currency: string }) => t.tenantId === tenantB && t.currency === 'USD');
    expect(b).toMatchObject({ name: 'Tenant B', amount: 27.5, workspaces: [expect.objectContaining({ workspaceId: ws.b1, name: 'Lab', amount: 27.5 })] });
    // Stored by "compute now", then read back as stored with the same figures.
    await analyst.agent.post(`/api/admin/cloud/showback/${M}/compute`).set('x-csrf-token', analyst.csrf).expect(403);
    expect((await root.agent.post(`/api/admin/cloud/showback/${M}/compute`).set('x-csrf-token', root.csrf).expect(200)).body).toMatchObject({ month: M, stored: true });
    const stored = (await root.agent.get(`/api/admin/cloud/showback?month=${M}`).expect(200)).body;
    expect(stored.stored).toBe(true);
    expect(stored.currencies).toEqual(all.currencies);
    // A reader without platform:manage sees only their own tenant (here the platform tenant), and no unallocated line.
    const own = (await analyst.agent.get(`/api/admin/cloud/showback?month=${M}`).expect(200)).body;
    expect(own.tenants.every((t: { tenantId: string }) => t.tenantId === h.tenantId)).toBe(true);
    expect(own.unallocated).toEqual([]);
    expect(own.lines.every((l: ShowbackLine) => l.tenantId === h.tenantId)).toBe(true);
    await analyst.agent.get(`/api/admin/cloud/showback?month=${M}&tenant=${tenantB}`).expect(403);
    await analyst.agent.get('/api/admin/cloud/showback?month=2026-13').expect(400);
  });

  it('exports CSV, audited, with a total per currency', async () => {
    const res = await root.agent.get(`/api/admin/cloud/showback/export?month=${M}&format=csv`).expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toContain(`showback-${M}.csv`);
    const lines = String(res.text).trim().split(/\r\n/);
    expect(lines[0]).toBe('month,tenant_id,tenant,workspace_id,workspace,currency,cost_type,method,amount');
    expect(lines).toContain(`${M},,Total,,,USD,,total,55.000000`);
    expect(lines).toContain(`${M},,Total,,,EUR,,total,7.000000`);
    expect(lines.some((l) => l.startsWith(`${M},${tenantB},Tenant B,${ws.b1},Lab,USD,compute,tenant,5.000000`))).toBe(true);
    const json = await root.agent.get(`/api/admin/cloud/showback/export?month=${M}&format=json`).expect(200);
    expect(JSON.parse(json.text)).toMatchObject({ month: M });
    expect((await h.s.audit.list(h.tenantId, { action: 'cloud.showback.exported' })).length).toBeGreaterThanOrEqual(2);
  });

  it('puts showback lines on the B-13 statement only when the tenant turns them on, outside the total', async () => {
    const before = (await root.agent.get(`/api/admin/billing/statements/${M}`).expect(200)).body;
    expect(before).not.toHaveProperty('showback');
    const csvBefore = (await root.agent.get(`/api/admin/billing/statements/${M}/export?format=csv`).expect(200)).text;
    expect(csvBefore).not.toContain('showback');
    expect((await root.agent.get('/api/admin/cloud/showback/settings').expect(200)).body).toMatchObject({ tenantId: h.tenantId, statementLines: false });
    await analyst.agent.put('/api/admin/cloud/showback/settings').set('x-csrf-token', analyst.csrf).send({ statementLines: true }).expect(403);
    await root.agent.put('/api/admin/cloud/showback/settings').set('x-csrf-token', root.csrf).send({ statementLines: true }).expect(200);
    const after = (await root.agent.get(`/api/admin/billing/statements/${M}`).expect(200)).body;
    expect(after.showback.lines.length).toBeGreaterThan(0);
    expect(after.showback.totals).toEqual({ USD: 27.5, EUR: 5.25 });
    expect(after.showback.lines.every((l: { description: string }) => l.description.startsWith('Cloud showback: '))).toBe(true);
    // Nothing else on the statement changed.
    const { showback: _s, computedAt: _c1, ...rest } = after;
    const { computedAt: _c2, ...was } = before;
    expect(rest).toEqual(was);
    expect((await root.agent.get(`/api/admin/billing/statements/${M}/export?format=csv`).expect(200)).text).toContain('showback_workspace,cost_type,description,amount,currency');
    // Tenant B's statement stays as it was (its own setting is off).
    expect((await root.agent.get(`/api/admin/billing/statements/${M}?tenant=${tenantB}`).expect(200)).body).not.toHaveProperty('showback');
    expect((await h.s.audit.list(h.tenantId, { action: 'cloud.showback.settings.updated' })).length).toBeGreaterThan(0);
  });

  it('without migration 164: computed on request with the default rules, nothing stored, no statement lines, changes refused', async () => {
    await root.agent.put('/api/admin/cloud/showback/settings').set('x-csrf-token', root.csrf).send({ statementLines: true }).expect(200);
    await (await import('../src/db/migrations/164_cloud_showback.js')).down(h.s.db);
    h.s.cloud.showback.resetSchemaCache();
    try {
      const r = (await root.agent.get(`/api/admin/cloud/showback?month=${M}`).expect(200)).body;
      expect(r).toMatchObject({ stored: false, currencies: expect.arrayContaining([{ currency: 'USD', ingested: 55, allocated: 55, unallocated: 0 }]) });
      expect((await root.agent.get('/api/admin/cloud/showback/rules').expect(200)).body).toMatchObject({ installed: false });
      expect((await root.agent.put('/api/admin/cloud/showback/rules').set('x-csrf-token', root.csrf).send({ rules: { gpu: 'tokens' } }).expect(503)).body).toMatchObject({ reason: 'migration_pending' });
      await root.agent.put('/api/admin/cloud/showback/settings').set('x-csrf-token', root.csrf).send({ statementLines: false }).expect(503);
      expect((await root.agent.get(`/api/admin/billing/statements/${M}`).expect(200)).body).not.toHaveProperty('showback');
    } finally {
      await (await import('../src/db/migrations/164_cloud_showback.js')).up(h.s.db);
      h.s.cloud.showback.resetSchemaCache();
    }
  });
});
