import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localUser, loginAdmin, type Client } from './helpers.js';
import { approvalWorkflow, audits, buildCrm, designer, drain, env, member, ok, publishWorkflow, type C, type Env } from './sprint39b-helpers.js';

/*
 * 1.6.0, Sprint 39b, B-8202 and B-8203: a pipeline's three stages, promotion that cannot skip a stage, the production
 * promotion that waits for the Workflows approval step and lands the exact package that passed test, the backup
 * before each deployment, the history and a rollback that restores the previous version's schema.
 */
describe('B-8202, B-8203: environments, promotion, history and rollback', () => {
  let e: Env;
  let d: C;
  let approver: Client;
  const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);

  beforeEach(async () => {
    e = await env();
    d = await designer(e);
    await buildCrm(e, d);
    await d.post('/api/apps', { name: 'crm_test', title: 'CRM test', label: 'confidential' }).expect(201);
    await d.post('/api/apps', { name: 'crm_prod', title: 'CRM production', label: 'confidential' }).expect(201);
    await approvalWorkflow(e, d);
    await localUser(e.h, 'approver', ['workflow-admin', 'member'], 'confidential');
    await e.h.s.tenants.addMember(e.wsId, (await e.h.s.users.byUsername(e.h.tenantId, 'approver'))!.id);
    approver = await loginAdmin(e.h, 'approver');
  });
  afterEach(async () => {
    await e.h.close();
  });

  const entityNames = async (app: string) => ((await d.get(`/api/apps/${app}`).expect(200)).body.entities as { name: string }[]).map((x) => x.name);
  const deployment = async (id: string) => (await d.get(`/api/apps/deployments/${id}`).expect(200)).body;

  async function pipeline(approval: string | null = 'release-gate') {
    return (await ok(d.post('/api/apps/pipelines', { name: 'CRM', development: 'crm', test: 'crm_test', production: 'crm_prod', approvalWorkflow: approval }), 201)).body;
  }

  async function approve(decision: 'approve' | 'reject') {
    await drain(e); // the approval run reaches its approval step
    const list = (await approver.agent.get('/api/workflow-approvals').expect(200)).body as { id: string; shown: string | null }[];
    expect(list).toHaveLength(1);
    await post(approver, `/api/workflow-approvals/${list[0]!.id}`, { decision }).expect(200);
    await drain(e);
    return list[0]!;
  }

  it('needs three different apps and a published workflow with an approval step', async () => {
    const r = await d.post('/api/apps/pipelines', { name: 'Bad', development: 'crm', test: 'crm', production: 'crm_prod' }).expect(400);
    expect(r.body.detail).toMatch(/three different apps/);
    await publishWorkflow(e, d, 'no-approval', [], [], 'api');
    const r2 = await d.post('/api/apps/pipelines', { name: 'Bad', development: 'crm', test: 'crm_test', production: 'crm_prod', approvalWorkflow: 'no-approval' }).expect(409);
    expect(r2.body.detail).toMatch(/no approval step/);
    const p = await pipeline();
    expect(p).toMatchObject({ name: 'CRM', stages: { development: { name: 'crm' }, test: { name: 'crm_test' }, production: { name: 'crm_prod' } }, approvalWorkflow: { name: 'release-gate' }, last: { test: null, production: null }, activeDeployment: null });
    expect((await d.get('/api/apps/pipelines').expect(200)).body.pipelines.map((x: { name: string }) => x.name)).toEqual(['CRM']);
    expect((await d.get('/api/apps/crm_test/packages').expect(200)).body.stage).toMatchObject({ pipeline: p.id, stage: 'test' });
    await d.post('/api/apps/pipelines', { name: 'CRM', development: 'crm', test: 'crm_test', production: 'crm_prod' }).expect(409);
    // a member who cannot design apps sees no pipeline
    const m = await member(e, 'mem');
    await m.get('/api/apps/pipelines').expect(403);
  });

  it('promotes development to test as a new package, backs the target up first, and cannot skip to production', async () => {
    const p = await pipeline();
    const early = await d.post(`/api/apps/pipelines/${p.id}/promote`, { to: 'production' }).expect(409);
    expect(early.body.detail).toMatch(/Nothing has passed test/);

    const dep = (await ok(d.post(`/api/apps/pipelines/${p.id}/promote`, { to: 'test', note: 'first' }), 202)).body;
    expect(dep).toMatchObject({ kind: 'promotion', from: 'development', to: 'test', version: 1, state: 'queued', backupPackageId: null });
    // a second promotion waits for the first
    expect((await d.post(`/api/apps/pipelines/${p.id}/promote`, { to: 'test' }).expect(409)).body.detail).toMatch(/still going/);
    await drain(e);
    const done = await deployment(dep.id);
    expect(done).toMatchObject({ state: 'succeeded', backupPackageId: expect.any(String), createdByName: expect.any(String) });
    expect(done.report).toMatchObject({ entities: { created: ['deal', 'task'] }, forms: { created: ['new_deal'] }, policies: { created: 1 }, triggers: { created: 1 } });
    expect(await entityNames('crm_test')).toEqual(['deal', 'task']);
    // the backup is a package of the (empty) test app, kept beside the promotion package
    const testPackages = (await d.get('/api/apps/crm_test/packages').expect(200)).body.packages;
    expect(testPackages.map((x: { source: string; version: number }) => [x.source, x.version])).toEqual([['backup', 1]]);
    const devPackages = (await d.get('/api/apps/crm/packages').expect(200)).body.packages;
    expect(devPackages.map((x: { source: string; version: number; note: string }) => [x.source, x.version, x.note])).toEqual([['promotion', 1, 'first']]);
    expect((await audits(e, 'app.package.promoted')).length).toBe(1);
    const view = (await d.get(`/api/apps/pipelines/${p.id}`).expect(200)).body;
    expect(view.last.test).toMatchObject({ id: dep.id, version: 1 });
  });

  it('promotes test to production only through the approval step, landing the exact package that passed test', async () => {
    const p = await pipeline();
    const toTest = (await d.post(`/api/apps/pipelines/${p.id}/promote`, { to: 'test' }).expect(202)).body;
    await drain(e);
    // development moves on; production still gets what test has
    await d.post('/api/apps/crm/entities', { name: 'note', title: 'Note', definition: { fields: [{ name: 'text', type: 'string' }] } }).expect(201);

    const noGate = await pipeline(null).catch(() => null);
    void noGate;
    const dep = (await ok(d.post(`/api/apps/pipelines/${p.id}/promote`, { to: 'production', note: 'ship it' }), 202)).body;
    expect(dep).toMatchObject({ from: 'test', to: 'production', state: 'awaiting-approval', packageId: toTest.packageId, version: 1, approvalRunId: expect.any(String) });
    await drain(e);
    expect((await deployment(dep.id)).state).toBe('awaiting-approval');
    expect(await entityNames('crm_prod')).toEqual([]);
    const run = await e.h.s.db('workflow_runs').where({ id: dep.approvalRunId }).first();
    expect(run).toMatchObject({ state: 'waiting', caller_kind: 'app-deployment', caller_id: dep.id, trigger: 'api:app-deployment' });

    const a = await approve('approve');
    expect(a.shown).toBe('Deploy crm_prod v1 to production');
    const done = await deployment(dep.id);
    expect(done).toMatchObject({ state: 'succeeded', packageId: toTest.packageId, backupPackageId: expect.any(String) });
    expect(await entityNames('crm_prod')).toEqual(['deal', 'task']); // not the note added to development since
    expect((await audits(e, 'app.package.promotion.approved')).length).toBe(1);
    expect((await audits(e, 'app.package.promoted')).length).toBe(2);
    const history = (await d.get(`/api/apps/pipelines/${p.id}/deployments`).expect(200)).body.deployments;
    expect(history.map((x: { to: string; state: string }) => [x.to, x.state])).toEqual([
      ['production', 'succeeded'],
      ['test', 'succeeded']
    ]);
  });

  it('a rejected approval leaves production untouched and the requester told', async () => {
    const p = await pipeline();
    await d.post(`/api/apps/pipelines/${p.id}/promote`, { to: 'test' }).expect(202);
    await drain(e);
    const dep = (await d.post(`/api/apps/pipelines/${p.id}/promote`, { to: 'production' }).expect(202)).body;
    await approve('reject');
    const done = await deployment(dep.id);
    expect(done.state).toBe('rejected');
    expect(done.error).toMatch(/approval run rejected/);
    expect(await entityNames('crm_prod')).toEqual([]);
    expect((await audits(e, 'app.package.promotion.rejected')).length).toBe(1);
    const notes = await e.h.s.db('notifications').where({ tenant_id: e.h.tenantId, user_id: d.user.id, title: 'Promotion to production rejected' });
    expect(notes).toHaveLength(1);
    // without an approval workflow a production promotion is refused outright
    await d.patch(`/api/apps/pipelines/${p.id}`, { approvalWorkflow: null }).expect(200);
    expect((await d.post(`/api/apps/pipelines/${p.id}/promote`, { to: 'production' }).expect(409)).body.detail).toMatch(/needs an approval/);
  });

  it('rolls a deployment back to the backup taken before it, and the rollback is audited', async () => {
    const p = await pipeline();
    await d.post(`/api/apps/pipelines/${p.id}/promote`, { to: 'test' }).expect(202);
    await drain(e);
    // a second version: a new entity, a field gone, a form renamed
    await d.post('/api/apps/crm/entities', { name: 'note', title: 'Note', definition: { fields: [{ name: 'text', type: 'string' }] } }).expect(201);
    await d.del('/api/apps/crm/forms/new_deal').expect(204);
    await d.post('/api/apps/crm/forms', { name: 'quick_deal', entity: 'deal', definition: { fields: [{ field: 'title' }] } }).expect(201);
    const second = (await d.post(`/api/apps/pipelines/${p.id}/promote`, { to: 'test' }).expect(202)).body;
    expect(second.version).toBe(2);
    await drain(e);
    expect((await deployment(second.id)).report).toMatchObject({ entities: { created: ['note'], updated: [], removed: [], kept: [] }, forms: { created: ['quick_deal'], removed: ['new_deal'] } });
    expect(await entityNames('crm_test')).toEqual(['deal', 'note', 'task']);
    // a record in the test app's note entity: the rollback keeps the entity and says so
    await d.post('/api/apps/crm_test/entities/note/records', { values: { text: 'kept' } }).expect(201);

    const rb = (await ok(d.post(`/api/apps/deployments/${second.id}/rollback`, { note: 'back to v1' }), 202)).body;
    expect(rb).toMatchObject({ kind: 'rollback', from: null, to: 'test', rollbackOf: second.id, state: 'queued', version: expect.any(Number) });
    await drain(e);
    const done = await deployment(rb.id);
    expect(done).toMatchObject({ state: 'succeeded', backupPackageId: expect.any(String) });
    expect(done.report).toMatchObject({ entities: { kept: ['note'] }, forms: { created: ['new_deal'], removed: ['quick_deal'] } });
    const forms = (await d.get('/api/apps/crm_test').expect(200)).body.forms.map((f: { name: string }) => f.name);
    expect(forms).toEqual(['new_deal']);
    expect((await audits(e, 'app.package.rolled_back')).length).toBe(1);
    const history = (await d.get(`/api/apps/pipelines/${p.id}/deployments`).expect(200)).body.deployments;
    expect(history.map((x: { kind: string; version: number; state: string }) => [x.kind, x.version, x.state])).toEqual([
      ['rollback', done.version, 'succeeded'],
      ['promotion', 2, 'succeeded'],
      ['promotion', 1, 'succeeded']
    ]);
    // only a succeeded deployment with a backup rolls back
    expect((await d.post(`/api/apps/deployments/${rb.id}/rollback`, {}).expect(202)).body.kind).toBe('rollback');
    await drain(e);
    // and deleting the pipeline takes its history with it
    await d.del(`/api/apps/pipelines/${p.id}`).expect(204);
    await d.get(`/api/apps/deployments/${rb.id}`).expect(404);
  });
});
