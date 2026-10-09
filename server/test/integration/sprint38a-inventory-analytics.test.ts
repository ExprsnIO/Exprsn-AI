/*
 * 1.6.0, Sprint 38a against real databases. Each block runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 040_inventory_analytics; B-7401/B-7402: the analytics sums by workspace,
 *                                  group (through membership) and model, prices and the chargeback total; B-7301: an
 *                                  inventory entry and the owner publish gate; B-7501: a JSONL export whose proof
 *                                  verifies offline, and a SIEM destination under dual control.
 */
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { verifyAuditExport } from '../../src/audit/export-verify.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { dayOf, monthOf } from '../../src/tenancy/quotas.js';
import { testConfig } from '../helpers.js';

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`Sprint 38a on ${d.name}`, () => {
    it('migrates 040_inventory_analytics; sums usage by dimension with costs; gates an agent on its owner; exports a verifiable JSONL window; dual-controls a SIEM destination', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        for (const t of ['inventory_systems', 'inventory_settings', 'usage_prices', 'audit_siem_destinations']) expect(await db.schema.hasTable(t), t).toBe(true);
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const wsA = await s.tenants.createWorkspace(tenant.id, 'Finance', 'confidential');
        const wsB = await s.tenants.createWorkspace(tenant.id, 'Sales', 'confidential');
        const person = async (username: string, roles: string[]) => {
          const u = await s.users.create(tenant.id, { username, displayName: username.toUpperCase(), clearance: 'confidential' });
          await s.users.update(tenant.id, u.id, { clearance_direct: 'confidential' });
          await s.users.setRoles(u.id, 'direct', roles);
          await s.tenants.addMember(wsA.id, u.id);
          const p = (await loadPrincipal(s, tenant.id, u.id, {}))!;
          p.workspaceId = wsA.id;
          return { u, p };
        };
        const alice = await person('alice', ['member']);
        const bob = await person('bob', ['member']);
        const admin = await person('ta', ['tenant-admin']);
        const admin2 = await person('ta2', ['tenant-admin']);

        // ---- B-7401, B-7402: analytics ----
        const groupId = (await s.groups.create({ p: alice.p, ip: null }, { workspaceId: wsA.id, name: 'Analysts', visibility: 'private', joinMode: 'open', label: 'internal' })).id;
        const now = Date.now();
        const rec = (p: { ws: string; user: string; model: string; kind?: 'chat' | 'agent'; prompt: number; output: number; gpuMs?: number; ts?: number }) =>
          s.quotas.record({ tenantId: tenant.id, workspaceId: p.ws, userId: p.user, kind: p.kind ?? 'chat', profileId: 'general', model: p.model, poolId: 'POOL0000000000000000000001', promptTokens: p.prompt, outputTokens: p.output, gpuMs: p.gpuMs ?? 1000, ts: p.ts ?? now });
        await rec({ ws: wsA.id, user: alice.u.id, model: 'llama3.1:8b', prompt: 1000, output: 500 });
        await rec({ ws: wsA.id, user: alice.u.id, model: 'llama3.1:8b', prompt: 1000, output: 500, ts: now - 86_400_000 });
        await rec({ ws: wsA.id, user: bob.u.id, model: 'qwen2.5:32b', prompt: 2000, output: 1000, gpuMs: 4000 });
        await rec({ ws: wsA.id, user: bob.u.id, model: 'qwen2.5:32b', prompt: 10, output: 20, kind: 'agent', gpuMs: 100 });
        await rec({ ws: wsB.id, user: bob.u.id, model: 'llama3.1:8b', prompt: 300, output: 100 });
        const from = dayOf(now - 2 * 86_400_000), to = dayOf(now);
        const byWs = await s.analytics.summary(tenant.id, 'workspace', from, to);
        expect(byWs.rows.find((r) => r.key === wsA.id)).toMatchObject({ requests: 4, messages: 3, runs: 1, users: 2, prompt: 4010, output: 2020, tokens: 6030, gpuMs: 6100, cost: null });
        expect(byWs.rows.find((r) => r.key === wsB.id)).toMatchObject({ requests: 1, users: 1, tokens: 400 });
        const byGroup = await s.analytics.summary(tenant.id, 'group', from, to);
        expect(byGroup.rows).toEqual([expect.objectContaining({ key: groupId, requests: 2, users: 1, tokens: 3000 })]);
        const byModelInGroup = await s.analytics.summary(tenant.id, 'model', from, to, { groupId });
        expect(byModelInGroup.rows).toEqual([expect.objectContaining({ key: 'llama3.1:8b', tokens: 3000 })]);
        const daily = await s.analytics.daily(tenant.id, from, to);
        expect(daily.reduce((a, x) => a + x.tokens, 0)).toBe(6430);
        expect(daily.find((x) => x.day === to)).toMatchObject({ messages: 3, runs: 1 });

        await s.analytics.setPrice(tenant.id, { scope: 'model', ref: 'llama3.1:8b', currency: 'EUR', inputPerMillion: 0.1, outputPerMillion: 0.4, gpuHour: 0 }, admin.u.id);
        await s.analytics.setPrice(tenant.id, { scope: 'pool', ref: 'POOL0000000000000000000001', currency: 'EUR', inputPerMillion: 0, outputPerMillion: 0, gpuHour: 3.6 }, admin.u.id);
        const priced = await s.analytics.summary(tenant.id, 'workspace', from, to);
        const fin = priced.rows.find((r) => r.key === wsA.id)!;
        expect(fin.cost).toBeCloseTo(2000 / 1e6 * 0.1 + 1000 / 1e6 * 0.4 + (4100 / 3_600_000) * 3.6, 6);
        expect(fin.currency).toBe('EUR');
        const month = monthOf(now);
        const cb = await s.analytics.chargeback(tenant.id, month, wsA.id);
        const sameMonth = monthOf(now - 86_400_000) === month;
        const screen = await s.analytics.summary(tenant.id, 'workspace', dayOf(sameMonth ? now - 86_400_000 : now), to, { workspaceId: wsA.id });
        expect(cb.total.cost).toBeCloseTo(screen.rows[0]!.cost!, 6);
        expect(cb.total.requests).toBe(screen.rows[0]!.requests);
        expect(s.analytics.chargebackCsv(cb).split('\r\n').filter(Boolean).pop()).toMatch(/,TOTAL,,,/);

        // ---- B-7301: the inventory and the owner gate ----
        const agent = await s.registry.create(alice.p, { kind: 'agent', impl: 'agent', name: 'Triage', version: '1.0.0', description: 'Routes support questions to the right specialist and summarises the case.', sideEffect: null, label: 'internal', inputSchema: null, outputSchema: null, definition: { profile: 'general', systemPrompt: 'Be brief.', tools: [], budgets: { steps: 5, tokens: 2000, wallSeconds: 30, toolCalls: 2 } } }, 'ALICE');
        const agentId = agent.id;
        const inv = await s.inventory.list(tenant.id);
        const a = inv.find((x) => x.kind === 'agent' && x.id === agentId)!;
        expect(a).toMatchObject({ name: 'Triage', complete: false });
        expect(a.missing).toContain('owner');
        await s.inventory.assertPublishable(tenant.id, 'agent', agentId); // off by default
        await s.inventory.setSettings(admin.p, { requireOwner: true });
        await expect(s.inventory.assertPublishable(tenant.id, 'agent', agentId)).rejects.toMatchObject({ status: 409 });
        const set = await s.inventory.set(admin.p, 'agent', agentId, { ownerId: bob.u.id, oversightRole: 'Support lead', provenance: 'In-house prompts' });
        expect(set).toMatchObject({ ownerId: bob.u.id, ownerName: 'BOB', complete: true, missing: [] });
        await s.inventory.assertPublishable(tenant.id, 'agent', agentId);
        const reg = await s.inventory.register(tenant.id, 'json');
        // No profile named general exists in this harness, so the agent's lineage is empty here; the unit suite covers lineage.
        expect((JSON.parse(reg.body) as { systems: { kind: string; owner: string | null; impactAssessment: string | null }[] }).systems.find((x) => x.kind === 'agent')).toMatchObject({ owner: 'BOB', impactAssessment: null });

        // ---- B-7501: a JSONL export with its proof, verified offline ----
        s.exports.checkpoints = s.checkpoints;
        const x = await s.exports.request({ tenantId: tenant.id, tenantSlug: tenant.slug, kind: 'audit-jsonl', params: { to: Date.now() }, scope: 'test', maxLabel: 'confidential', userId: admin.u.id });
        await s.jobs.runDue();
        const done = (await s.exports.get(tenant.id, x.id))!;
        expect(done.state).toBe('ready');
        const lines = (await s.exports.content(done))!.toString('utf8').split('\n').filter(Boolean);
        const r = verifyAuditExport(lines);
        expect(r.status).toBe('verified');
        expect(r.events).toBe(done.rows);
        expect((await s.checkpoints.verify(tenant.id)).status).toBe('verified');

        // ---- B-7501: a SIEM destination under dual control (no network: proposed and decided only) ----
        const dest = await s.siemDestinations.propose(admin.p, { name: 'SOC', kind: 'syslog', url: 'siem.example.com:6514' });
        expect(dest.state).toBe('proposed');
        await expect(s.siemDestinations.decide(admin.p, dest.id, 'approve', null)).rejects.toMatchObject({ status: 403 });
        const rejected = await s.siemDestinations.decide(admin2.p, dest.id, 'reject', 'not ours');
        expect(rejected).toMatchObject({ state: 'rejected', decided_by: admin2.u.id, note: 'not ours' });
        const actions = (await db('audit_events').where({ tenant_id: tenant.id }).whereIn('action', ['inventory.updated', 'inventory.settings.updated', 'audit.siem.proposed', 'audit.siem.rejected'])).map((e) => String(e.action));
        expect(new Set(actions)).toEqual(new Set(['inventory.updated', 'inventory.settings.updated', 'audit.siem.proposed', 'audit.siem.rejected']));
      } finally {
        await s.close();
        await db.destroy();
      }
    }, 120_000);
  });
}
