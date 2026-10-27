import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dayOf, monthOf } from '../src/tenancy/quotas.js';
import { costOf } from '../src/tenancy/analytics.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

const send = (c: Client, method: 'post' | 'put' | 'patch' | 'delete', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);

describe('B-7401, B-7402: usage and cost analytics', () => {
  let h: Harness;
  let admin: Client;
  let wsA: string;
  let wsB: string;
  let aliceId: string;
  let bobId: string;
  let groupId: string;
  const DAY = 86_400_000;

  beforeEach(async () => {
    h = await harness();
    await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    admin = await loginAdmin(h, 'ta');
    wsA = (await h.s.tenants.createWorkspace(h.tenantId, 'Finance', 'confidential')).id;
    wsB = (await h.s.tenants.createWorkspace(h.tenantId, 'Sales', 'confidential')).id;
    aliceId = (await localUser(h, 'alice', ['member'], 'confidential')).id;
    bobId = (await localUser(h, 'bob', ['member'], 'confidential')).id;
    await h.s.tenants.addMember(wsA, aliceId);
    await h.s.tenants.addMember(wsA, bobId);
    const alice = await login(h, 'alice');
    groupId = ((await send(alice, 'post', '/api/groups', { workspaceId: wsA, name: 'Analysts', visibility: 'private', joinMode: 'open' }).expect(201)).body as { id: string }).id;
    // Metering records across two days, two workspaces, two models, a user outside the group, and an agent run.
    const now = Date.now();
    const rec = (p: { workspaceId: string; userId: string; model: string; profileId?: string; kind?: 'chat' | 'agent' | 'embed'; prompt: number; output: number; gpuMs?: number; ts?: number }) =>
      h.s.quotas.record({ tenantId: h.tenantId, workspaceId: p.workspaceId, userId: p.userId, kind: p.kind ?? 'chat', profileId: p.profileId ?? 'general', model: p.model, poolId: 'POOL00000000000000000000000', promptTokens: p.prompt, outputTokens: p.output, gpuMs: p.gpuMs ?? 1000, ts: p.ts ?? now });
    await rec({ workspaceId: wsA, userId: aliceId, model: 'llama3.1:8b', prompt: 1000, output: 500 });
    await rec({ workspaceId: wsA, userId: aliceId, model: 'llama3.1:8b', prompt: 1000, output: 500, ts: now - DAY });
    await rec({ workspaceId: wsA, userId: bobId, model: 'qwen2.5:32b', prompt: 2000, output: 1000, gpuMs: 4000 });
    await rec({ workspaceId: wsA, userId: bobId, model: 'qwen2.5:32b', prompt: 10, output: 20, kind: 'agent', gpuMs: 100 });
    await rec({ workspaceId: wsB, userId: bobId, model: 'llama3.1:8b', prompt: 300, output: 100 });
  });
  afterEach(async () => {
    await h.close();
  });

  it('totals per dimension equal the metering records, and the group dimension follows membership', async () => {
    const byWs = (await admin.agent.get('/api/admin/analytics/summary?by=workspace&days=14').expect(200)).body as { rows: Record<string, unknown>[]; total: Record<string, unknown>; currency: string | null };
    const fin = byWs.rows.find((r) => r.name === 'Finance')!;
    expect(fin).toMatchObject({ key: wsA, requests: 4, messages: 3, runs: 1, users: 2, prompt: 4010, output: 2020, tokens: 6030, gpuMs: 6100, cost: null, currency: null });
    expect(byWs.rows.find((r) => r.name === 'Sales')).toMatchObject({ requests: 1, messages: 1, runs: 0, users: 1, tokens: 400 });
    expect(byWs.total).toMatchObject({ requests: 5, messages: 4, runs: 1, tokens: 6430, gpuMs: 7100, cost: null });
    expect(byWs.currency).toBeNull();

    // A day's totals are that day's records: today holds everything but one message.
    const today = (await admin.agent.get(`/api/admin/analytics/summary?by=model&from=${dayOf(Date.now())}&to=${dayOf(Date.now())}`).expect(200)).body as { rows: Record<string, unknown>[]; total: { tokens: number; requests: number } };
    expect(today.total).toMatchObject({ requests: 4, tokens: 6430 - 1500 });
    const daily = (await admin.agent.get('/api/admin/analytics/daily?days=3').expect(200)).body as { day: string; messages: number; runs: number; tokens: number }[];
    expect(daily.length).toBe(3);
    expect(daily[2]).toMatchObject({ messages: 3, runs: 1, tokens: 4930 });
    expect(daily[1]).toMatchObject({ messages: 1, runs: 0, tokens: 1500 });

    // Per user, per profile, per model; the group holds alice's records only.
    const byUser = (await admin.agent.get('/api/admin/analytics/summary?by=user&days=14').expect(200)).body as { rows: Record<string, unknown>[] };
    expect(byUser.rows.find((r) => r.key === aliceId)).toMatchObject({ name: 'ALICE', requests: 2, tokens: 3000 });
    const byGroup = (await admin.agent.get('/api/admin/analytics/summary?by=group&days=14').expect(200)).body as { rows: Record<string, unknown>[] };
    expect(byGroup.rows).toEqual([expect.objectContaining({ key: groupId, name: 'Analysts', requests: 2, users: 1, tokens: 3000 })]);
    const inGroup = (await admin.agent.get(`/api/admin/analytics/summary?by=model&group=${groupId}&days=14`).expect(200)).body as { rows: Record<string, unknown>[] };
    expect(inGroup.rows).toEqual([expect.objectContaining({ key: 'llama3.1:8b', tokens: 3000 })]);
    // Across tenants is for system admins.
    await admin.agent.get('/api/admin/analytics/summary?by=tenant').expect(403);
    // Members do not read analytics.
    const alice = await login(h, 'alice');
    await alice.agent.get('/api/admin/analytics/summary').expect(403);
  });

  it('prices give each row a cost, and the chargeback export sums to the screen\'s total', async () => {
    // One currency per tenant; a price per model, a pool price for what no model price covers.
    const p1 = (await send(admin, 'put', '/api/admin/analytics/prices', { scope: 'model', ref: 'llama3.1:8b', currency: 'eur', inputPerMillion: 0.1, outputPerMillion: 0.4, gpuHour: 0 }).expect(200)).body;
    expect(p1).toMatchObject({ scope: 'model', ref: 'llama3.1:8b', currency: 'EUR', inputPerMillion: 0.1, outputPerMillion: 0.4 });
    await send(admin, 'put', '/api/admin/analytics/prices', { scope: 'model', ref: 'qwen2.5:32b', currency: 'usd', inputPerMillion: 1 }).expect(403);
    const byWs0 = (await admin.agent.get('/api/admin/analytics/summary?by=workspace&days=14').expect(200)).body as { rows: Record<string, unknown>[]; total: { cost: number | null } };
    // Finance has qwen records with no price: its cost is null rather than a partial figure; Sales is fully priced.
    expect(byWs0.rows.find((r) => r.name === 'Finance')!.cost).toBeNull();
    expect(byWs0.rows.find((r) => r.name === 'Sales')).toMatchObject({ cost: costOf({ prompt: 300, output: 100, gpuMs: 1000 }, { input_per_million: 0.1, output_per_million: 0.4, gpu_hour: 0 } as never), currency: 'EUR' });
    expect(byWs0.total.cost).toBeNull();
    await send(admin, 'put', '/api/admin/analytics/prices', { scope: 'pool', ref: 'POOL00000000000000000000000', currency: 'EUR', gpuHour: 3.6 }).expect(200);
    const prices = (await admin.agent.get('/api/admin/analytics/prices').expect(200)).body as { prices: { scope: string; ref: string }[] };
    expect(prices.prices.map((p) => `${p.scope}:${p.ref}`)).toEqual(['model:llama3.1:8b', 'pool:POOL00000000000000000000000']);

    const byWs = (await admin.agent.get('/api/admin/analytics/summary?by=workspace&days=14').expect(200)).body as { rows: { name: string; cost: number }[]; total: { cost: number } };
    const fin = byWs.rows.find((r) => r.name === 'Finance')!;
    // llama: 2000 prompt, 1000 output at the model price; qwen: 4100 GPU-ms at 3.6/hour = 0.0041.
    expect(fin.cost).toBeCloseTo(2000 / 1e6 * 0.1 + 1000 / 1e6 * 0.4 + (4100 / 3_600_000) * 3.6, 6);
    expect(byWs.total.cost).toBeCloseTo(fin.cost + byWs.rows.find((r) => r.name === 'Sales')!.cost, 6);

    const month = monthOf(Date.now());
    const cb = (await admin.agent.get(`/api/admin/analytics/chargeback?month=${month}&workspace=${wsA}`).expect(200)).body as { total: { cost: number; requests: number; unpriced: number }; rows: { model: string; cost: number }[]; currency: string; workspace: { name: string } };
    expect(cb.workspace.name).toBe('Finance');
    expect(cb.currency).toBe('EUR');
    expect(cb.total.unpriced).toBe(0);
    // The month's chargeback equals the screen's figure for the same records (the month holds both days here, unless
    // yesterday was last month: then it equals today's share).
    const sameMonth = monthOf(Date.now() - DAY) === month;
    const screen = (await admin.agent.get(`/api/admin/analytics/summary?by=workspace&workspace=${wsA}&from=${dayOf(sameMonth ? Date.now() - DAY : Date.now())}&to=${dayOf(Date.now())}`).expect(200)).body as { total: { cost: number; requests: number } };
    expect(cb.total.cost).toBeCloseTo(screen.total.cost, 6);
    expect(cb.total.requests).toBe(screen.total.requests);
    expect(cb.rows.reduce((a, r) => a + r.cost, 0)).toBeCloseTo(cb.total.cost, 6);

    const csv = await admin.agent.get(`/api/admin/analytics/chargeback?month=${month}&workspace=${wsA}&format=csv`).expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    const lines = csv.text.split('\r\n').filter(Boolean);
    expect(lines[0]).toBe('month,workspace,model,pool,requests,prompt_tokens,output_tokens,gpu_seconds,cost,currency');
    expect(lines[lines.length - 1]).toMatch(new RegExp(`^${String(month).slice(0, 4)}-${String(month).slice(4, 6)},TOTAL,,,${cb.total.requests},`));
    expect(lines[lines.length - 1]!.endsWith(`${cb.total.cost.toFixed(6)},EUR`)).toBe(true);
    expect((await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'analytics.chargeback.exported' })).length).toBe(2);
    expect((await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'analytics.price.set' })).length).toBe(2);

    // Removing a price.
    const id = ((await admin.agent.get('/api/admin/analytics/prices').expect(200)).body as { prices: { id: string; scope: string }[] }).prices.find((p) => p.scope === 'pool')!.id;
    await send(admin, 'delete', `/api/admin/analytics/prices/${id}`).expect(204);
    await send(admin, 'delete', `/api/admin/analytics/prices/${id}`).expect(404);
    // Auditors read prices and analytics but do not set prices.
    await localUser(h, 'aud', ['auditor'], 'confidential');
    const aud = await loginAdmin(h, 'aud');
    await aud.agent.get('/api/admin/analytics/prices').expect(200);
    await send(aud, 'put', '/api/admin/analytics/prices', { scope: 'model', ref: 'x', currency: 'EUR' }).expect(403);
  });
});
