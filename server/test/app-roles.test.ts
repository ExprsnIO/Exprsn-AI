import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppPackages } from '../src/apps/packages.js';
import { mapPlatformRoles, type Dropped } from '../src/apps/platform-import.js';
import { subjectMatches, type UserFacts } from '../src/apps/policies.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * 1.8.0, Sprint 48 (B-143): app-local roles. Each app's own catalogue, assigned directly, through a social group or
 * as a workspace's default; named by row and field policies as `app_role`; shown by explain; carried by packages
 * (the catalogue, not who holds it); never wider than the tenant's permissions or the reader's clearance.
 */

const facts = (o: Partial<UserFacts> = {}): UserFacts => ({ id: '01HUSER000000000000000000A', username: 'ana', clearance: 'internal', roles: ['member'], groups: [], workspaces: [], attributes: {}, ...o });

describe('B-143: the app_role subject', () => {
  it('matches the roles the reader holds in the app, without regard to case', () => {
    expect(subjectMatches({ kind: 'app_role', value: 'Clerk' }, facts({ appRoles: ['clerk'] }))).toBe(true);
    expect(subjectMatches({ kind: 'app_role', value: 'Approver' }, facts({ appRoles: ['clerk'] }))).toBe(false);
    expect(subjectMatches({ kind: 'app_role', value: 'Clerk' }, facts())).toBe(false);
  });

  it('maps platform AppRoles by name and drops their resource permissions', () => {
    const dropped: Dropped[] = [];
    const out = mapPlatformRoles([{ name: 'Clerk', displayName: 'Front-desk clerk', description: 'Enters claims', permissions: { claims: ['create'] } }, { name: 'approver' }, { name: 'APPROVER' }, { name: '%bad' }], new Set(['approver']), dropped);
    expect(out).toEqual([
      { source: 'Clerk', name: 'Clerk', description: 'Front-desk clerk: Enters claims', action: 'create' },
      { source: 'approver', name: 'approver', description: null, action: 'existing' }
    ]);
    expect(dropped.map((d) => d.what)).toEqual(['role Clerk: 1 permission(s)', 'role %bad']);
  });
});

describe('B-143: app-local roles (API)', () => {
  let h: Harness;
  let wsId: string;

  beforeEach(async () => {
    h = await harness();
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Sales', 'confidential')).id;
  }, 60_000);
  afterEach(async () => {
    await h.close();
  });

  async function wrap(c: { agent: Client['agent']; csrf: string }) {
    const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
    await send('put', '/api/me/workspace', { workspaceId: wsId }).expect(200);
    return { ...c, post: (p: string, b?: object) => send('post', p, b), put: (p: string, b?: object) => send('put', p, b), patch: (p: string, b?: object) => send('patch', p, b), del: (p: string) => send('delete', p), get: (p: string) => c.agent.get(p) };
  }
  async function person(name: string, roles: string[] = ['member'], clearance: 'internal' | 'confidential' = 'confidential') {
    const u = await localUser(h, name, roles, clearance);
    await h.s.tenants.addMember(wsId, u.id);
    return { user: u, ...(await wrap(await login(h, name))) };
  }
  async function designer(name = 'dee') {
    const u = await localUser(h, name, ['workflow-admin', 'member'], 'confidential');
    await h.s.tenants.addMember(wsId, u.id);
    return { user: u, ...(await wrap(await loginAdmin(h, name))) };
  }

  const entity = {
    name: 'claim',
    title: 'Claim',
    label: 'internal',
    definition: {
      fields: [
        { name: 'title', type: 'string', required: true, indexed: true, unique: true, maxLength: 120 },
        { name: 'amount', type: 'number', indexed: true, min: 0 },
        { name: 'ssn', type: 'string', maxLength: 20 }
      ]
    }
  };
  const titles = (body: { records: { values: { title: string } }[] }) => body.records.map((r) => r.values.title).sort();
  const audits = async (action: string) => (await h.s.db('audit_events').where({ action })) as { target: string; detail: string | null }[];

  async function setup() {
    const dee = await designer();
    await dee.post('/api/apps', { name: 'claims', title: 'Claims', label: 'confidential', workspaceId: wsId }).expect(201);
    await dee.post('/api/apps/claims/entities', entity).expect(201);
    const rec = async (values: Record<string, unknown>, label?: string) => (await dee.post('/api/apps/claims/entities/claim/records', { values, ...(label ? { label } : {}) }).expect(201)).body as { id: string };
    const small = await rec({ title: 'Small', amount: 50, ssn: '123-45-6789' });
    const large = await rec({ title: 'Large', amount: 5000, ssn: '987-65-4321' });
    const secret = await rec({ title: 'Secret', amount: 10, ssn: '555-66-7777' }, 'confidential');
    return { dee, small, large, secret };
  }

  it('assigns a role directly, through a group and as a workspace default; policies naming it decide rows and fields; explain says which role', async () => {
    const { dee, small } = await setup();
    const ana = await person('ana');
    const bob = await person('bob');
    const cat = await person('cat');
    const dan = await person('dan');

    // the catalogue: names unique per app (without case), an optional description
    const clerk = (await dee.post('/api/apps/claims/roles', { name: 'Clerk', description: 'Enters claims' }).expect(201)).body as { id: string; name: string };
    expect(clerk).toMatchObject({ name: 'Clerk', description: 'Enters claims' });
    expect((await dee.post('/api/apps/claims/roles', { name: 'clerk' }).expect(409)).body.detail).toMatch(/already has a role/);
    const approver = (await dee.post('/api/apps/claims/roles', { name: 'Approver' }).expect(201)).body as { id: string };
    const viewer = (await dee.post('/api/apps/claims/roles', { name: 'Viewer' }).expect(201)).body as { id: string };
    await dee.post('/api/apps/claims/roles', { name: '' }).expect(400);

    // a policy may name only a role of the catalogue
    expect((await dee.post('/api/apps/claims/policies', { name: 'Nope', subjects: [{ kind: 'app_role', value: 'Auditor' }] }).expect(422)).body.title).toBe('Unknown app role');
    // clerks reach small claims and see the SSN masked; approvers reach every claim and see it; viewers only titles
    await dee.post('/api/apps/claims/policies', { name: 'Clerks', entity: 'claim', subjects: [{ kind: 'app_role', value: 'clerk' }], rows: { field: 'amount', op: 'lt', value: 1000 }, fields: { ssn: { read: true, unmasked: false, mask: 'last4' } } }).expect(201);
    await dee.post('/api/apps/claims/policies', { name: 'Approvers', entity: 'claim', subjects: [{ kind: 'app_role', value: 'Approver' }] }).expect(201);
    await dee.post('/api/apps/claims/policies', { name: 'Viewers', entity: 'claim', subjects: [{ kind: 'app_role', value: 'Viewer' }], fields: { ssn: { read: false }, amount: { read: false } } }).expect(201);

    // before any assignment, a member no policy names reaches nothing
    expect(titles((await ana.get('/api/apps/claims/entities/claim/records').expect(200)).body)).toEqual([]);

    // direct: ana is a clerk
    await dee.post(`/api/apps/claims/roles/${clerk.id}/members`, { kind: 'user', username: 'ana' }).expect(201);
    await dee.post(`/api/apps/claims/roles/${clerk.id}/members`, { kind: 'user', username: 'ana' }).expect(409);
    await dee.post(`/api/apps/claims/roles/${clerk.id}/members`, { kind: 'user', username: 'nobody' }).expect(422);
    const anaRead = (await ana.get('/api/apps/claims/entities/claim/records').expect(200)).body;
    expect(titles(anaRead)).toEqual(['Secret', 'Small']);
    expect(anaRead.records.find((r: { values: { title: string } }) => r.values.title === 'Small').values.ssn).toBe('***-**-6789');

    // through a group: bob is a member of a social group that holds Approver
    const g = (await bob.post('/api/groups', { workspaceId: wsId, name: 'Approvals desk', joinMode: 'open', visibility: 'public' }).expect(201)).body as { id: string };
    await dee.post(`/api/apps/claims/roles/${approver.id}/members`, { kind: 'group', id: g.id }).expect(201);
    expect(titles((await bob.get('/api/apps/claims/entities/claim/records').expect(200)).body)).toEqual(['Large', 'Secret', 'Small']);
    // cat joins the group and holds the role too; leaving it ends that at once
    await cat.post(`/api/groups/${g.id}/join`).expect(200);
    expect(titles((await cat.get('/api/apps/claims/entities/claim/records').expect(200)).body)).toEqual(['Large', 'Secret', 'Small']);
    await cat.del(`/api/groups/${g.id}/members/${cat.user.id}`).expect(200);
    expect(titles((await cat.get('/api/apps/claims/entities/claim/records').expect(200)).body)).toEqual([]);

    // a workspace default: every member of Sales is a Viewer (dan holds nothing else)
    const wsMember = (await dee.post(`/api/apps/claims/roles/${viewer.id}/members`, { kind: 'workspace', id: wsId }).expect(201)).body as { id: string };
    const danRead = (await dan.get('/api/apps/claims/entities/claim/records').expect(200)).body;
    expect(titles(danRead)).toEqual(['Large', 'Secret', 'Small']);
    expect(Object.keys(danRead.records[0].values)).toEqual(['title']);
    // a field policy: a viewer cannot filter by a field the role does not read
    await dan.get('/api/apps/claims/entities/claim/records?filter=' + encodeURIComponent(JSON.stringify({ field: 'amount', op: 'gt', value: 1 }))).expect(403);
    // ana now holds Clerk and Viewer: the rows and fields of both
    expect(titles((await ana.get('/api/apps/claims/entities/claim/records').expect(200)).body)).toEqual(['Large', 'Secret', 'Small']);

    // explain names the role and how it is held
    const ex = (await dee.post('/api/apps/claims/entities/claim/policies/explain', { username: 'ana', recordId: small.id, field: 'ssn' }).expect(200)).body;
    expect(ex.user.appRoles).toEqual([
      { key: 'clerk', name: 'Clerk', via: [{ kind: 'user', id: ana.user.id }] },
      { key: 'viewer', name: 'Viewer', via: [{ kind: 'workspace', id: wsId }] }
    ]);
    expect(ex.policies.find((p: { name: string }) => p.name === 'Clerks')).toMatchObject({ matches: true, subject: { kind: 'app_role', value: 'clerk' }, appRole: { name: 'Clerk' } });
    // the record is reached first by the every-row policy (Viewers), the field read by Clerks
    expect(ex.record).toMatchObject({ reachable: true, by: 'Viewers', byRole: 'Viewer' });
    expect(ex.field).toMatchObject({ name: 'ssn', read: true, unmasked: false, by: 'Clerks', byRole: 'Clerk' });
    const exBob = (await dee.post('/api/apps/claims/entities/claim/policies/explain', { username: 'bob' }).expect(200)).body;
    expect(exBob.user.appRoles.find((r: { key: string }) => r.key === 'approver').via).toEqual([{ kind: 'group', id: g.id }]);

    // the catalogue lists assignments with names and what each role can do
    const list = (await dee.get('/api/apps/claims/roles').expect(200)).body.roles as { name: string; members: { kind: string; name: string }[]; policies: { name: string; rows: unknown }[] }[];
    const c = list.find((r) => r.name === 'Clerk')!;
    expect(c.members).toEqual([expect.objectContaining({ kind: 'user', name: 'ANA (ana)' })]);
    expect(c.policies).toEqual([expect.objectContaining({ name: 'Clerks', entity: 'claim', rows: { field: 'amount', op: 'lt', value: 1000 } })]);
    expect(list.find((r) => r.name === 'Approver')!.members).toEqual([expect.objectContaining({ kind: 'group', name: 'Approvals desk' })]);
    expect(((await dee.get('/api/apps/claims/roles/candidates?q=an').expect(200)).body.people as { username: string }[]).map((x) => x.username)).toEqual(['ana', 'dan']);

    // a role a policy names cannot be deleted; renaming it renames it in the policies
    expect((await dee.del(`/api/apps/claims/roles/${viewer.id}`).expect(409)).body.policies).toEqual(['Viewers']);
    await dee.patch(`/api/apps/claims/roles/${viewer.id}`, { name: 'Reader' }).expect(200);
    const pols = (await dee.get('/api/apps/claims/policies').expect(200)).body.policies as { name: string; subjects: unknown[] }[];
    expect(pols.find((p) => p.name === 'Viewers')!.subjects).toEqual([{ kind: 'app_role', value: 'Reader' }]);
    expect(titles((await dan.get('/api/apps/claims/entities/claim/records').expect(200)).body)).toEqual(['Large', 'Secret', 'Small']);
    // unassigning ends it
    await dee.del(`/api/apps/claims/roles/${viewer.id}/members/${wsMember.id}`).expect(204);
    expect(titles((await dan.get('/api/apps/claims/entities/claim/records').expect(200)).body)).toEqual([]);

    // only designers manage roles
    await ana.get('/api/apps/claims/roles').expect(403);
    await ana.post('/api/apps/claims/roles', { name: 'Boss' }).expect(403);
    await ana.post(`/api/apps/claims/roles/${approver.id}/members`, { kind: 'user', id: ana.user.id }).expect(403);

    // every change is audited app.role.*
    expect((await audits('app.role.created')).length).toBe(3);
    expect((await audits('app.role.assigned')).length).toBe(3);
    expect((await audits('app.role.updated'))[0]!.detail).toContain('"from":"Viewer"');
    expect((await audits('app.role.unassigned')).length).toBe(1);
    const assigned = (await audits('app.role.assigned')).map((a) => JSON.parse(a.detail ?? '{}') as { kind: string });
    expect(assigned.map((d) => d.kind).sort()).toEqual(['group', 'user', 'workspace']);
  }, 120_000);

  it('never widens past tenant permissions, clearance or the app', async () => {
    const { dee } = await setup();
    const clerk = (await dee.post('/api/apps/claims/roles', { name: 'Clerk' }).expect(201)).body as { id: string };
    await dee.post('/api/apps/claims/policies', { name: 'Clerks', entity: 'claim', subjects: [{ kind: 'app_role', value: 'Clerk' }] }).expect(201);
    // an internal-cleared clerk: the confidential record stays out of reach
    const eve = await person('eve', ['member'], 'internal');
    await dee.post(`/api/apps/claims/roles/${clerk.id}/members`, { kind: 'user', id: eve.user.id }).expect(201);
    expect(titles((await eve.get('/api/apps/claims/entities/claim/records').expect(200)).body)).toEqual(['Large', 'Small']);
    // a clerk without records:read (a flag reviewer only) still reads nothing
    const fay = await person('fay', ['flag-reviewer']);
    await dee.post(`/api/apps/claims/roles/${clerk.id}/members`, { kind: 'user', id: fay.user.id }).expect(201);
    expect((await fay.get('/api/apps/claims/entities/claim/records').expect(403)).body.step).toBeDefined();
    // a role of one app is nothing in another app, even under the same name
    await dee.post('/api/apps', { name: 'other', title: 'Other', label: 'internal', workspaceId: wsId }).expect(201);
    await dee.post('/api/apps/other/entities', entity).expect(201);
    await dee.post('/api/apps/other/entities/claim/records', { values: { title: 'Elsewhere', amount: 1 } }).expect(201);
    await dee.post('/api/apps/other/roles', { name: 'Clerk' }).expect(201);
    await dee.post('/api/apps/other/policies', { name: 'Clerks', entity: 'claim', subjects: [{ kind: 'app_role', value: 'Clerk' }] }).expect(201);
    expect(titles((await eve.get('/api/apps/other/entities/claim/records').expect(200)).body)).toEqual([]);
    // a group of another workspace cannot hold a role of a workspace app
    const otherWs = (await h.s.tenants.createWorkspace(h.tenantId, 'Other', 'confidential')).id;
    await h.s.tenants.addMember(otherWs, eve.user.id);
    await eve.put('/api/me/workspace', { workspaceId: otherWs }).expect(200);
    const g = (await eve.post('/api/groups', { workspaceId: otherWs, name: 'Elsewhere club', joinMode: 'open', visibility: 'public' }).expect(201)).body as { id: string };
    await h.s.tenants.addMember(otherWs, dee.user.id);
    await dee.post(`/api/apps/claims/roles/${clerk.id}/members`, { kind: 'group', id: g.id }).expect(403);
    await dee.post(`/api/apps/claims/roles/${clerk.id}/members`, { kind: 'workspace', id: otherWs }).expect(403);
  }, 120_000);

  it('packages carry the catalogue, not the assignments', async () => {
    const { dee } = await setup();
    const clerk = (await dee.post('/api/apps/claims/roles', { name: 'Clerk', description: 'Enters claims' }).expect(201)).body as { id: string };
    await dee.post('/api/apps/claims/roles', { name: 'Approver' }).expect(201);
    await dee.post('/api/apps/claims/policies', { name: 'Clerks', entity: 'claim', subjects: [{ kind: 'app_role', value: 'Clerk' }] }).expect(201);
    await dee.post(`/api/apps/claims/roles/${clerk.id}/members`, { kind: 'workspace', id: wsId }).expect(201);
    const made = (await dee.post('/api/apps/claims/packages', {}).expect(201)).body;
    expect(made.package.roles).toEqual([{ name: 'Approver', description: null }, { name: 'Clerk', description: 'Enters claims' }]);
    expect(JSON.stringify(made.package)).not.toContain(wsId);
    // the files for git read back to the same signed package
    const back = AppPackages.fromFiles(AppPackages.files(made.package));
    expect(back).toEqual(made.package);
    expect([...AppPackages.files(made.package).keys()].filter((k) => k.startsWith('roles/'))).toEqual(['roles/001-Approver.json', 'roles/002-Clerk.json']);
    // imported as a new app: the roles and the policy naming one, nobody holding them
    const out = (await dee.post('/api/apps/packages/import', { package: made.package, name: 'claims_copy' }).expect(201)).body;
    expect(out.report.roles).toEqual({ created: ['Approver', 'Clerk'], updated: [], removed: [] });
    const copy = (await dee.get('/api/apps/claims_copy/roles').expect(200)).body.roles as { name: string; members: unknown[]; policies: { name: string }[] }[];
    expect(copy.map((r) => [r.name, r.members.length, r.policies.map((p) => p.name)])).toEqual([['Approver', 0, []], ['Clerk', 0, ['Clerks']]]);
    // deployed onto an app in place: a role the package lacks goes, the ones it has keep their assignments
    const pd = await principalFor('dee');
    const app = await h.s.apps.app(pd, 'claims');
    await dee.post('/api/apps/claims/roles', { name: 'Temp' }).expect(201);
    const report = await h.s.apps.packages.apply({ principal: pd, source: 'api' }, made.package, app, { mode: 'deploy' });
    expect(report.roles).toEqual({ created: [], updated: [], removed: ['Temp'] });
    const after = (await dee.get('/api/apps/claims/roles').expect(200)).body.roles as { name: string; members: unknown[] }[];
    expect(after.map((r) => [r.name, r.members.length])).toEqual([['Approver', 0], ['Clerk', 1]]);
  }, 120_000);

  async function principalFor(username: string) {
    const { loadPrincipal } = await import('../src/http/middleware.js');
    const u = await h.s.users.byUsername(h.tenantId, username);
    const p = await loadPrincipal(h.s, h.tenantId, u!.id, {});
    return { ...p!, workspaceId: wsId };
  }
});
