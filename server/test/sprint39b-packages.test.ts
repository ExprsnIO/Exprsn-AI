import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppPackages, PACKAGE_FORMAT, type AppPackage } from '../src/apps/packages.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { audits, buildCrm, designer, env, type C, type Env } from './sprint39b-helpers.js';

/*
 * 1.6.0, Sprint 39b, B-8201: an app's whole design (and its records when asked) as a versioned, signed package that
 * imports into an empty workspace and runs the same way; a tampered package is refused; a package applied to an app in
 * place reconciles its design; the one-file-per-object layout reassembles to the same signed document.
 */
describe('B-8201: app packages', () => {
  let e: Env;
  let d: C;

  beforeEach(async () => {
    e = await env();
    d = await designer(e);
    await buildCrm(e, d);
  });
  afterEach(async () => {
    await e.h.close();
  });

  it('packages the design with a version per app, signed, and lists the versions', async () => {
    const v1 = (await d.post('/api/apps/crm/packages', {}).expect(201)).body;
    expect(v1).toMatchObject({ version: 1, source: 'export', format: PACKAGE_FORMAT, withData: false, hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const pkg: AppPackage = v1.package;
    expect(pkg).toMatchObject({ format: PACKAGE_FORMAT, version: 1, app: { name: 'crm', label: 'confidential' }, key: expect.stringMatching(/app-bundles$/), signature: expect.any(String) });
    expect(pkg.entities.map((x) => x.name)).toEqual(['deal', 'task']);
    expect(pkg.forms.map((f) => f.name)).toEqual(['new_deal']);
    expect(pkg.triggers).toEqual([{ entity: 'deal', kind: 'record', events: ['updated'], cron: null, workflow: 'on-update', enabled: true }]);
    expect(pkg.policies.map((p) => p.name)).toEqual(['Own region']);
    expect(pkg.workflows.map((w) => w.name)).toEqual(['on-update']);
    expect(pkg.workflows[0]!.bundle).toMatchObject({ format: 'exprsn-workflow/1', signature: expect.any(String) });
    expect(pkg.records).toBeUndefined();
    expect(AppPackages.hashOf(pkg)).toBe(v1.hash);

    const v2 = (await d.post('/api/apps/crm/packages', { note: 'second' }).expect(201)).body;
    expect(v2.version).toBe(2);
    const list = (await d.get('/api/apps/crm/packages').expect(200)).body;
    expect(list.packages.map((p: { version: number; note: string | null }) => [p.version, p.note])).toEqual([
      [2, 'second'],
      [1, null]
    ]);
    expect(list.stage).toBeNull();
    const one = (await d.get(`/api/apps/crm/packages/${v1.id}`).expect(200)).body;
    expect(one.package.signature).toBe(pkg.signature);
    expect((await audits(e, 'app.package.created')).length).toBe(2);
  });

  it('imports into an empty workspace as the same app, records and references included when asked', async () => {
    const deal = (await d.post('/api/apps/crm/entities/deal/records', { values: { title: 'Contoso', amount: 10, region: 'emea' } }).expect(201)).body;
    await d.post('/api/apps/crm/entities/task/records', { values: { name: 'Call back', deal: deal.id } }).expect(201);
    await d.post(`/api/apps/crm/entities/deal/records/${deal.id}/transition`, { to: 'won' }).expect(200);
    const pkg: AppPackage = (await d.post('/api/apps/crm/packages', { withData: true }).expect(201)).body.package;
    expect(pkg.records?.map((r) => [r.entity, r.state])).toEqual([
      ['deal', 'won'],
      ['task', null]
    ]);

    const other = (await e.h.s.tenants.createWorkspace(e.h.tenantId, 'Other', 'confidential')).id;
    await e.h.s.tenants.addMember(other, d.user.id);
    const out = (await d.post('/api/apps/packages/import', { package: pkg, name: 'crm_copy', workspaceId: other }).expect(201)).body;
    expect(out).toMatchObject({ name: 'crm_copy', label: 'confidential' });
    expect(out.report).toMatchObject({ entities: { created: ['deal', 'task'], updated: [], removed: [], kept: [] }, forms: { created: ['new_deal'] }, policies: { created: 1, removed: 0 }, records: { created: 2, skipped: [] } });
    // the workflow the trigger names exists in the designer's scope by name, so the trigger was created on it
    expect(out.report.workflows).toMatchObject({ existing: ['on-update'], imported: [], failed: [] });
    expect(out.report.triggers).toMatchObject({ created: 1, skipped: [] });
    expect(out.package).toMatchObject({ version: 1, withData: true });

    await d.put('/api/me/workspace', { workspaceId: other }).expect(200);
    const copy = (await d.get('/api/apps/crm_copy').expect(200)).body;
    expect(copy.entities.map((x: { name: string }) => x.name)).toEqual(['deal', 'task']);
    const deals = (await d.post('/api/apps/crm_copy/entities/deal/records/query', {}).expect(200)).body;
    expect(deals.total).toBe(1);
    expect(deals.records[0]).toMatchObject({ values: { title: 'Contoso', amount: 10, twice: 20 }, state: 'won', label: 'confidential' });
    const tasks = (await d.post('/api/apps/crm_copy/entities/task/records/query', {}).expect(200)).body;
    expect(tasks.records[0].values.deal).toBe(deals.records[0].id); // re-pointed to the new id
    expect((await d.get('/api/apps/crm_copy/policies').expect(200)).body.policies.map((p: { name: string }) => p.name)).toEqual(['Own region']);
    expect((await d.get('/api/apps/crm_copy/triggers').expect(200)).body.triggers).toHaveLength(1);
    expect((await audits(e, 'app.imported')).length).toBe(1);
  });

  it('refuses a package changed after signing, signed elsewhere or unsigned, and leaves nothing behind', async () => {
    const pkg: AppPackage = (await d.post('/api/apps/crm/packages', {}).expect(201)).body.package;
    const tampered = JSON.parse(JSON.stringify(pkg)) as AppPackage;
    tampered.entities[0]!.definition.fields[0]!.required = false;
    const r = await d.post('/api/apps/packages/import', { package: tampered, name: 'crm_bad' }).expect(422);
    expect(r.body).toMatchObject({ title: 'Package refused' });
    expect(r.body.detail).toMatch(/signature does not verify/);
    await d.post('/api/apps/packages/import', { package: { ...pkg, key: 'someone-else' }, name: 'crm_bad' }).expect(422);
    const { signature: _s, ...unsigned } = pkg;
    void _s;
    await d.post('/api/apps/packages/import', { package: unsigned, name: 'crm_bad' }).expect(422);
    await d.post('/api/apps/packages/import', { package: { ...pkg, signature: 'local:v1:AAAA' }, name: 'crm_bad' }).expect(422);
    // the old bundle door takes a package too, and refuses the same way
    await d.post('/api/apps/import', { bundle: tampered, name: 'crm_bad' }).expect(422);
    await d.get('/api/apps/crm_bad').expect(404);
    expect((await audits(e, 'app.import.refused')).length).toBe(5);
    const ok = (await d.post('/api/apps/import', { bundle: pkg, name: 'crm_ok' }).expect(201)).body;
    expect(ok.report.entities.created).toEqual(['deal', 'task']);
  });

  it('applies a package to an app in place: entities, forms, triggers and policies reconciled by name', async () => {
    const pkg: AppPackage = (await d.post('/api/apps/crm/packages', {}).expect(201)).body.package;
    const target = (await d.post('/api/apps', { name: 'crm_test', title: 'CRM test', label: 'confidential' }).expect(201)).body;
    // the target already has a deal entity with an extra field and records, an entity the package lacks, and a form
    await d.post('/api/apps/crm_test/entities', { name: 'deal', title: 'Old deal', definition: { fields: [{ name: 'title', type: 'string', required: true, indexed: true, unique: true, maxLength: 120 }, { name: 'amount', type: 'number' }, { name: 'legacy', type: 'string' }] } }).expect(201);
    await d.post('/api/apps/crm_test/entities', { name: 'note', title: 'Note', definition: { fields: [{ name: 'text', type: 'string' }] } }).expect(201);
    await d.post('/api/apps/crm_test/entities/note/records', { values: { text: 'keep me' } }).expect(201);
    await d.post('/api/apps/crm_test/entities', { name: 'empty', title: 'Empty', definition: { fields: [{ name: 'x', type: 'string' }] } }).expect(201);
    await d.post('/api/apps/crm_test/forms', { name: 'old_form', entity: 'deal', definition: { fields: [{ field: 'title' }] } }).expect(201);

    const p = (await loadPrincipal(e.h.s, e.h.tenantId, d.user.id, {}))!;
    p.workspaceId = e.wsId;
    const targetRow = (await e.h.s.apps.appById(e.h.tenantId, target.id))!;
    const report = await e.h.s.apps.packages.apply({ principal: p, source: 'api' }, pkg, targetRow, { mode: 'deploy' });
    expect(report.entities).toEqual({ created: ['task'], updated: ['deal'], removed: ['empty'], kept: ['note'] });
    expect(report.forms).toEqual({ created: ['new_deal'], updated: [], removed: ['old_form'] });
    expect(report.triggers).toMatchObject({ created: 1, removed: 0, skipped: [] });
    expect(report.policies).toEqual({ created: 1, removed: 0 });
    const after = (await d.get('/api/apps/crm_test').expect(200)).body;
    expect(after.entities.map((x: { name: string; title: string }) => [x.name, x.title])).toEqual([
      ['deal', 'Deal'],
      ['note', 'Note'],
      ['task', 'Task']
    ]);
    expect(after.entities[0].definition.fields.map((f: { name: string }) => f.name)).toEqual(['title', 'amount', 'region', 'twice']);
    expect(after.forms.map((f: { name: string }) => f.name)).toEqual(['new_deal']);
    // applying the same package again changes nothing
    const again = await e.h.s.apps.packages.apply({ principal: p, source: 'api' }, pkg, (await e.h.s.apps.appById(e.h.tenantId, target.id))!, { mode: 'deploy' });
    expect(again.entities).toEqual({ created: [], updated: [], removed: [], kept: ['note'] });
    expect(again.forms).toEqual({ created: [], updated: [], removed: [] });
  });

  it('lays the package out as one file per object and reassembles the same signed document', async () => {
    const pkg: AppPackage = (await d.post('/api/apps/crm/packages', {}).expect(201)).body.package;
    const files = AppPackages.files(pkg);
    expect([...files.keys()].sort()).toEqual(['app.json', 'entities/deal.json', 'entities/task.json', 'forms/new_deal.json', 'package.json', 'policies/001-Own_region.json', 'triggers/001-deal-record.json', 'workflows/on-update.json']);
    expect(files.get('entities/deal.json')).toContain('\n  "definition": {\n'); // readable, two-space, sorted keys
    const back = AppPackages.fromFiles(files);
    expect(back).toEqual(JSON.parse(JSON.stringify(pkg)));
    const p = (await loadPrincipal(e.h.s, e.h.tenantId, d.user.id, {}))!;
    await expect(e.h.s.apps.packages.verify({ principal: p, source: 'api' }, back)).resolves.toMatchObject({ version: 1 });
    // a changed file no longer verifies
    const edited = new Map(files);
    edited.set('entities/deal.json', files.get('entities/deal.json')!.replace('"Deal"', '"Deals"'));
    await expect(e.h.s.apps.packages.verify({ principal: p, source: 'api' }, AppPackages.fromFiles(edited))).rejects.toMatchObject({ status: 422 });
    expect(() => AppPackages.fromFiles(new Map())).toThrow(/no package.json/);
  });
});
