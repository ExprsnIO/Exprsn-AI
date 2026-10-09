/*
 * 1.7.0, Sprint 41c against real databases. Each block runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 043c_thinking; a tenant and a workspace thinking policy (the workspace's
 *                                  wins, a reset makes it inherit), the thinking-token budget summed from the meter
 *                                  with the drop flag as a boolean, the usage summary's thinking columns, and the
 *                                  retention sweep that drops a message's thinking but keeps its token count.
 */
import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { testConfig } from '../helpers.js';

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`Sprint 41c on ${d.name}`, () => {
    it('migrates 043c_thinking; keeps policies per tenant and workspace; meters the budget and the drop; sweeps thinking past its retention', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      try {
        expect(await db.schema.hasTable('thinking_policies')).toBe(true);
        for (const [t, c] of [['profiles', 'thinking_budget'], ['profiles', 'plan_first'], ['profiles', 'reflect'], ['profiles', 'reflect_profile'], ['messages', 'plan'], ['messages', 'checked'], ['messages', 'thinking_purge_at'], ['agent_runs', 'plan'], ['agent_runs', 'plan_state'], ['chain_nodes', 'plan'], ['chain_nodes', 'think'], ['chain_nodes', 'thinking_tokens'], ['usage_records', 'thinking_dropped']] as const) {
          expect(await db.schema.hasColumn(t, c), `${t}.${c}`).toBe(true);
        }
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const u = await s.users.create(tenant.id, { username: 'owner', displayName: 'OWNER', clearance: 'internal' });
        await s.users.setRoles(u.id, 'direct', ['model-admin']);
        const ws = await s.tenants.createWorkspace(tenant.id, 'Finance', 'confidential');
        const p = { kind: 'user' as const, userId: u.id, tenantId: tenant.id, tenantSlug: tenant.slug, username: 'owner', displayName: 'OWNER', roles: ['model-admin'], clearance: 'internal' as const, scopes: null, sessionId: null, apiKeyId: null, mfa: true, workspaceId: ws.id };

        // Policies: the tenant's, then the workspace's over it, then a reset.
        expect(await s.thinking.policyFor(tenant.id, ws.id)).toMatchObject({ scope: 'default', visibility: 'author', exports: true });
        await s.thinking.setPolicy(p, null, { visibility: 'reviewers', retentionDays: 7, exports: false });
        expect(await s.thinking.policyFor(tenant.id, ws.id)).toMatchObject({ scope: 'tenant', visibility: 'reviewers', retentionDays: 7, exports: false });
        await s.thinking.setPolicy(p, ws.id, { visibility: 'nobody', budgetTokensPerDay: 5000 });
        expect(await s.thinking.policyFor(tenant.id, ws.id)).toMatchObject({ scope: 'workspace', visibility: 'nobody', retentionDays: null, exports: true, budgetTokensPerDay: 5000 });
        expect((await s.thinking.policies(tenant.id, ws.id)).workspace).toMatchObject({ visibility: 'nobody' });
        await s.thinking.setPolicy(p, ws.id, {}, true);
        expect(await s.thinking.policyFor(tenant.id, ws.id)).toMatchObject({ scope: 'tenant', visibility: 'reviewers' });
        expect(await db('audit_events').where({ action: 'thinking.policy.updated' })).toHaveLength(3);

        // The budget: thinking tokens summed per profile and per workspace for today, the drop flag a boolean.
        const profileId = ulid();
        await s.quotas.record({ tenantId: tenant.id, workspaceId: ws.id, userId: u.id, kind: 'chat', profileId, model: 'm', thinkingTokens: 120, thinkingDropped: true });
        await s.quotas.record({ tenantId: tenant.id, workspaceId: null, userId: u.id, kind: 'chat', profileId, model: 'm', thinkingTokens: 30 });
        const b = await s.thinking.budget(tenant.id, ws.id, { id: profileId, thinking_budget: 100 }, 'high');
        expect(b).toMatchObject({ level: 'low', dropped: true, limit: 'profile', profile: { used: 150, limit: 100 }, workspace: { used: 120, limit: null } });
        await s.thinking.setPolicy(p, ws.id, { budgetTokensPerDay: 100 });
        const b2 = await s.thinking.budget(tenant.id, ws.id, { id: ulid(), thinking_budget: null }, 'medium');
        expect(b2).toMatchObject({ level: 'low', dropped: true, limit: 'workspace', workspace: { used: 120, limit: 100 } });
        expect((await s.thinking.budget(tenant.id, ws.id, { id: ulid(), thinking_budget: null }, 'off')).dropped).toBe(false);
        const view = await s.quotas.view(tenant.id, ws.id);
        expect(view.used).toMatchObject({ thinkingTokensToday: 120, thinkingDropsToday: 1 });
        const rec = await db('usage_records').where({ profile_id: profileId }).orderBy('ts').first();
        expect(rec.thinking_dropped === true || rec.thinking_dropped === 1).toBe(true);

        // Retention: the sweep drops the thinking of a message past its purge time and keeps its token count.
        const conv = ulid();
        await db('conversations').insert({ id: conv, tenant_id: tenant.id, workspace_id: ws.id, user_id: u.id, kind: 'chat', title: await s.keys.seal(tenant.id, 'T', `title:${conv}`), label: 'internal', head_id: null, created_at: Date.now(), updated_at: Date.now(), archived_at: null });
        const mid = ulid();
        await db('messages').insert({ id: mid, conversation_id: conv, tenant_id: tenant.id, parent_id: null, role: 'assistant', content: await s.keys.seal(tenant.id, 'Answer', `content:${mid}`), thinking: await s.keys.seal(tenant.id, 'Draft', `thinking:${mid}`), state: 'complete', label: 'internal', thinking_tokens: 42, seq: 1, canary: false, created_at: Date.now(), completed_at: Date.now(), thinking_purge_at: Date.now() - 1 });
        const keep = ulid();
        await db('messages').insert({ id: keep, conversation_id: conv, tenant_id: tenant.id, parent_id: mid, role: 'assistant', content: await s.keys.seal(tenant.id, 'Answer', `content:${keep}`), thinking: await s.keys.seal(tenant.id, 'Draft', `thinking:${keep}`), state: 'complete', label: 'internal', thinking_tokens: 7, seq: 1, canary: false, created_at: Date.now(), completed_at: Date.now(), thinking_purge_at: Date.now() + 86_400_000 });
        expect(await s.thinking.purgeThinking(tenant.id)).toBe(1);
        const purged = await db('messages').where({ id: mid }).first();
        expect(purged.thinking).toBeNull();
        expect(Number(purged.thinking_tokens)).toBe(42);
        expect((await db('messages').where({ id: keep }).first()).thinking).not.toBeNull();
        expect(await s.thinking.purgeThinking(tenant.id)).toBe(0);

        // A profile's new fields round-trip through the repo.
        const pool = await s.gateway.repo.createPool({ name: 'p', accelerator: 'cuda', zone: 'inference', labelCeiling: 'internal' });
        const pid = ulid();
        const t = Date.now();
        await s.gateway.repo.createProfile({ id: pid, tenant_id: tenant.id, name: 'careful', display_name: 'Careful', description: null, alias_of: null, model_id: null, pool_id: pool.id, num_ctx: null, temperature: null, think_default: 'medium', think_ceiling: 'high', system_prompt: null, fallback: null, canary: null, tools: [], agents: [], skills: null, trust_marking: true, thinking_budget: 2500, plan_first: true, reflect: true, reflect_profile: 'judge', label: 'internal', status: 'draft', version: 1, updated_by: u.id, created_at: t, updated_at: t });
        const row = (await s.gateway.repo.profile(tenant.id, pid))!;
        expect(row).toMatchObject({ thinking_budget: 2500, plan_first: true, reflect: true, reflect_profile: 'judge' });
      } finally {
        await db.destroy();
      }
    }, 120_000);
  });
}
