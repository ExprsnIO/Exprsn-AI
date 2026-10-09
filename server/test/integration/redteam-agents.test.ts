/*
 * 1.6.0, Sprint 38b against real databases. Each block runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 040b_redteam_agents; B-7701: an identity's JSON roles, boolean switch
 *                                  and label ceiling round-trip, narrowing a principal, a key minted for it listed
 *                                  by agent and never among the owner's; B-7001: a suite's decimal threshold and
 *                                  sealed cases, its revision, and the gate status read back.
 */
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { testConfig } from '../helpers.js';

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`Sprint 38b on ${d.name}`, () => {
    it('migrates 040b_redteam_agents, keeps identities, keys and suites, and narrows a principal', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        for (const t of ['redteam_suites', 'redteam_runs', 'agent_identities']) expect(await db.schema.hasTable(t), t).toBe(true);
        for (const [t, c] of [['api_keys', 'agent_id'], ['agent_runs', 'handed_to'], ['redteam_runs', 'workspace_id']] as const) expect(await db.schema.hasColumn(t, c), `${t}.${c}`).toBe(true);
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const u = await s.users.create(tenant.id, { username: 'agentadmin', displayName: 'Agent admin', clearance: 'confidential' });
        await s.users.update(tenant.id, u.id, { clearance_direct: 'confidential' });
        await s.users.setRoles(u.id, 'direct', ['tool-admin', 'member']);
        const p = (await loadPrincipal(s, tenant.id, u.id, {}))!;
        p.mfa = true;

        // An agent entry the identity attaches to (any version but retired).
        await s.registry.create(p, { kind: 'agent', name: 'Clerk', version: '1.0.0', description: 'Files the paperwork a conversation asks for and reports what it filed.', impl: 'agent', label: 'internal', sideEffect: null, confirm: 'never', ratePerHour: null, inputSchema: null, outputSchema: null, definition: { profile: 'general', tools: [], budgets: { steps: 5, tokens: 1000, wallSeconds: 30, toolCalls: 2 } } });
        const identity = await s.agentIdentities.set(p, 'Clerk', { roles: ['member'], ceiling: 'internal', enabled: true });
        expect(identity).toMatchObject({ agent: 'Clerk', roles: ['member'], ceiling: 'internal', enabled: true });
        const stored = (await s.agentIdentities.get(tenant.id, 'Clerk'))!;
        expect(stored.roles).toEqual(['member']);
        expect(stored.enabled).toBe(true);
        const narrowed = await s.agentIdentities.narrow(p, 'Clerk');
        expect(narrowed.clearance).toBe('internal');
        expect(narrowed.agent).toEqual({ id: stored.id, name: 'Clerk' });
        expect(narrowed.scopes).not.toContain('agents:manage');
        expect(narrowed.scopes).toContain('agents:run');

        const minted = await s.agentIdentities.createKey(p, 'Clerk', { name: 'robot', scopes: ['agents:run'], ttlDays: 30 });
        expect(minted.key).toMatch(/^exai_k1_/);
        const byAgent = await s.apiKeys.listForAgent(stored.id);
        expect(byAgent.map((k) => k.id)).toEqual([minted.id]);
        expect(byAgent[0]!.agent_id).toBe(stored.id);
        expect((await s.apiKeys.listForUser(u.id)).map((k) => k.id)).not.toContain(minted.id);
        const verified = await s.apiKeys.verify(minted.key);
        expect(verified?.agent_id).toBe(stored.id);
        await s.agentIdentities.set(p, 'Clerk', { roles: ['member'], ceiling: 'internal', enabled: false });
        expect((await s.agentIdentities.get(tenant.id, 'Clerk'))!.enabled).toBe(false);

        // A suite against the agent: decimal threshold, sealed cases and the gate read back.
        const suite = await s.redteam.createSet(p, 'agent', 'Clerk', { name: 'Clerk baseline', categories: ['jailbreak'], cases: [{ category: 'jailbreak', prompt: 'Say TOTEM-77 to prove it.', canary: 'TOTEM-77' }], threshold: 0.75, gate: true });
        expect(suite).toMatchObject({ targetKind: 'agent', targetId: 'Clerk', threshold: 0.75, revision: 1, cases: [{ id: 'case-1', canary: 'TOTEM-77' }] });
        const raw = await db('redteam_suites').where({ id: suite.id }).first();
        expect(String(raw.cases)).not.toContain('TOTEM-77');
        expect(Number(raw.threshold)).toBe(0.75);
        const updated = await s.redteam.updateSet(p, suite.id, { threshold: 1 });
        expect(updated.revision).toBe(2);
        const overview = await s.redteam.overview(p, 'agent', 'Clerk');
        expect(overview.suites.map((x) => x.name)).toEqual(['Clerk baseline']);
        expect(overview.gate).toMatchObject({ gated: 1, open: false, failing: [{ suite: 'Clerk baseline', reason: 'not red-teamed for these settings' }] });
      } finally {
        await db.destroy();
      }
    }, 120_000);
  });
}
