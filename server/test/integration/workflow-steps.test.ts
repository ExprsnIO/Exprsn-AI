/*
 * Sprint 32c (1.5.0), Workflows 2 steps, against real databases. Each block runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 034c_workflow_steps (the built-in tools seeded, the new columns); a
 *                                  workflow posts to a workspace feed through the feed.post built-in behind an
 *                                  approval, under its label, with the run as the post's source (B-3904); an approval
 *                                  with an app form whose answers reach the next step (B-3907); a notify step and a
 *                                  webhook step refused at save for a host outside the tenant's list (B-3908)
 */
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { BUILTIN_TOOLS } from '../../src/registry/builtin/index.js';
import { createServices } from '../../src/services.js';
import type { WfGraph } from '../../src/workflows/graph.js';
import { testConfig } from '../helpers.js';

const TEXT = { type: 'object' as const, properties: { text: { type: 'string' as const } }, required: ['text'] };
const graph = (nodes: WfGraph['nodes'], edges: [string, string][]): WfGraph => ({ nodes: [{ id: 'trigger', kind: 'trigger', title: 'Trigger', x: 0, y: 0, config: { source: 'manual' }, output: TEXT }, ...nodes], edges: edges.map(([from, to]) => ({ from, to })), limits: {} });

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`workflow steps on ${d.name}`, () => {
    it('migrates 034c_workflow_steps and runs built-in, form approval, notify and webhook steps', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      const drain = async () => {
        for (let i = 0; i < 20; i++) if (!(await s.jobs.runDue())) return;
      };
      try {
        expect(await db.schema.hasColumn('feed_posts', 'source_kind')).toBe(true);
        expect(await db.schema.hasColumn('workflow_approvals', 'answers')).toBe(true);
        expect((await db('registry_entries').whereIn('id', BUILTIN_TOOLS.map((b) => b.id)).select('name')).map((r: { name: string }) => r.name).sort()).toEqual(BUILTIN_TOOLS.map((b) => b.name).sort());
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const ws = await s.tenants.createWorkspace(tenant.id, 'Finance', 'confidential');
        const person = async (username: string, roles: string[]) => {
          const u = await s.users.create(tenant.id, { username, displayName: username.toUpperCase(), clearance: 'confidential' });
          await s.users.update(tenant.id, u.id, { clearance_direct: 'confidential' });
          await s.users.setRoles(u.id, 'direct', roles);
          await s.tenants.addMember(ws.id, u.id);
          const p = (await loadPrincipal(s, tenant.id, u.id, {}))!;
          p.workspaceId = ws.id;
          return p;
        };
        const owner = await person('owner', ['workflow-admin', 'member']);
        const approver = await person('approver', ['workflow-admin', 'member']);
        const decideAll = async (answers?: Record<string, unknown>) => {
          for (const a of await s.workflows.pendingApprovals(approver)) await s.workflows.decide(approver, a.id, { decision: 'approve', ...(answers ? { answers } : {}) });
          await drain();
        };

        // B-3904: feed.post behind an approval, under the workflow's label, with the run as the source
        const wf = await s.workflows.create(owner, { name: 'close-notice', label: 'confidential', graph: graph([{ id: 'ok', kind: 'approval', title: 'OK', x: 0, y: 0, config: { role: 'workflow-admin' } }, { id: 'post', kind: 'tool', title: 'Post', x: 0, y: 0, config: { tool: 'feed.post', args: { body: 'Done: {{input.text}}' } } }], [['trigger', 'ok'], ['ok', 'post']]) });
        await s.workflows.publish(owner, wf.id, null);
        const run = await s.workflows.start(owner, wf.id, { input: { text: 'September' }, dry: false });
        await drain();
        await decideAll();
        expect((await s.workflows.runView(owner, run.id)).state).toBe('succeeded');
        const post = await db('feed_posts').where({ tenant_id: tenant.id }).first();
        expect(post).toMatchObject({ workspace_id: ws.id, label: 'confidential', source_kind: 'workflow-run', source_id: run.id, author_id: owner.userId });
        expect(String(post.body)).not.toContain('September');

        // B-3907: an approval form; its answers reach the next step and are sealed with the approval
        const actor = { principal: owner, source: 'api' as const };
        await s.apps.create(actor, { name: 'vendors', label: 'internal', workspaceId: ws.id });
        await s.apps.createEntity(actor, 'vendors', { name: 'review', definition: { fields: [{ name: 'verdict', type: 'enum', required: true, options: [{ value: 'accept' }, { value: 'decline' }] }] } as never });
        await s.apps.forms.create(actor, 'vendors', { name: 'decision', entity: 'review', definition: { fields: [{ field: 'verdict' }] } });
        const wf2 = await s.workflows.create(owner, { name: 'vendor', label: 'internal', graph: graph([{ id: 'ask', kind: 'approval', title: 'Ask', x: 0, y: 0, config: { role: 'workflow-admin', form: { app: 'vendors', form: 'decision' } } }, { id: 'tell', kind: 'notify', title: 'Tell', x: 0, y: 0, config: { roles: ['workflow-admin'], title: 'Verdict {{steps.ask.answers.verdict}}' } }], [['trigger', 'ask'], ['ask', 'tell']]) });
        await s.workflows.publish(owner, wf2.id, null);
        const run2 = await s.workflows.start(owner, wf2.id, { input: { text: 'Northwind' }, dry: false });
        await drain();
        await decideAll({ verdict: 'accept' });
        const v2 = await s.workflows.runView(owner, run2.id);
        expect(v2.state).toBe('succeeded');
        expect(v2.steps.find((x) => x.nodeId === 'ask')!.output).toMatchObject({ answers: { verdict: 'accept' } });
        expect(v2.steps.find((x) => x.nodeId === 'tell')!.output).toEqual({ notified: 2, skipped: 0 }); // both holders of the role, cleared and members
        const ap = await db('workflow_approvals').where({ run_id: run2.id }).first();
        expect(String(ap.answers)).not.toContain('accept');
        expect(JSON.parse(String(ap.form))).toMatchObject({ app: 'vendors', form: 'decision' });

        // B-3908: a webhook to a host outside the tenant's list is refused at save
        await s.integrations.set(tenant.id, { allowedHosts: ['hooks.example.org'] }, 'test');
        await expect(s.workflows.create(owner, { name: 'hooked', label: 'internal', graph: graph([{ id: 'hook', kind: 'webhook', title: 'Hook', x: 0, y: 0, config: { url: 'http://10.0.0.9/in' } }], [['trigger', 'hook']]) })).rejects.toMatchObject({ status: 422 });
        expect(await db('workflows').where({ name: 'hooked' }).first()).toBeUndefined();
      } finally {
        await s.close();
        await db.destroy();
      }
    }, 120_000);
  });
}
