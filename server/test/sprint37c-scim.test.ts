import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { matches, parseFilter, parsePatchPath, ENTERPRISE_SCHEMA, USER_SCHEMA, GROUP_SCHEMA } from '../src/identity/scim/filter.js';
import { applyPatch, normalise } from '../src/identity/scim/patch.js';
import { project } from '../src/identity/scim/service.js';
import { FakeIdp } from './fake-idp.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';
import { drain } from './retrieval-seed.js';

/*
 * 1.6.0, Sprint 37c (B-7201, B-7202): SCIM 2.0 provisioning, and the local conformance suite that stands in for the
 * Microsoft Entra ID SCIM Validator and Okta's SCIM 2.0 test suite (neither can be run from here: they call the
 * service from the internet). Each block below names the validator checks it covers; docs/identity.md lists them.
 */

const ERR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

describe('SCIM filters, paths and PATCH (RFC 7644 3.4.2.2, 3.5.2)', () => {
  const alice = {
    schemas: [USER_SCHEMA, ENTERPRISE_SCHEMA],
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    externalId: 'Ext-1',
    userName: 'Alice@Contoso.com',
    name: { givenName: 'Alice', familyName: 'Ng' },
    active: true,
    emails: [{ type: 'work', value: 'alice@contoso.com', primary: true }, { type: 'home', value: 'a@home.example' }],
    [ENTERPRISE_SCHEMA]: { department: 'Finance', manager: { value: 'M1' } },
    meta: { lastModified: '2026-10-01T10:00:00Z', version: 'W/"3"' }
  };

  it('parses and evaluates the grammar: precedence, not, value filters, case rules, dates, presence', () => {
    const t = (f: string) => matches(alice, parseFilter(f));
    expect(t('userName eq "alice@contoso.com"')).toBe(true); // caseExact false
    expect(t('USERNAME EQ "ALICE@CONTOSO.COM"')).toBe(true); // operators and names without case
    expect(t('externalId eq "ext-1"')).toBe(false); // caseExact true
    expect(t('externalId eq "Ext-1"')).toBe(true);
    expect(t('urn:ietf:params:scim:schemas:core:2.0:User:userName sw "alice"')).toBe(true);
    expect(t(`${ENTERPRISE_SCHEMA}:department eq "finance"`)).toBe(true);
    expect(t(`${ENTERPRISE_SCHEMA}:manager.value eq "M1"`)).toBe(true);
    expect(t('name.familyName co "g"')).toBe(true);
    expect(t('emails[type eq "work" and value ew "@contoso.com"]')).toBe(true);
    expect(t('emails[type eq "other"]')).toBe(false);
    expect(t('emails co "home.example"')).toBe(true); // a multi-valued attribute compares its values
    expect(t('emails.type eq "home"')).toBe(true);
    expect(t('title pr')).toBe(false);
    expect(t('name pr and active eq true')).toBe(true);
    expect(t('active eq false or userName eq "x" and active eq true')).toBe(false); // and binds tighter than or
    expect(t('(active eq false or userName sw "al") and active eq true')).toBe(true);
    expect(t('not (userName eq "bob")')).toBe(true);
    expect(t('meta.lastModified gt "2026-09-30T00:00:00Z"')).toBe(true);
    expect(t('meta.lastModified lt "2026-10-01T09:00:00+00:00"')).toBe(false);
    expect(t('userName ne "bob"')).toBe(true);
    for (const bad of ['userName eq', 'userName zz "x"', 'userName eq "x', '(userName eq "x"', 'userName eq x', '', 'a.b.c eq "x"', '(' .repeat(40) + 'a pr' + ')'.repeat(40)]) {
      expect(() => parseFilter(bad), bad).toThrow();
    }
    expect(parsePatchPath('emails[type eq "work"].value')).toMatchObject({ path: { attr: 'emails', sub: 'value' }, filter: { kind: 'cmp' } });
    expect(parsePatchPath('members[value eq "2819c223"]').filter).toBeTruthy();
  });

  it('applies Entra ID and Okta PATCH shapes; drops unknown, read-only and write-only attributes', () => {
    const set = { core: USER_SCHEMA, extensions: [ENTERPRISE_SCHEMA] };
    const doc = normalise({ USERNAME: 'a@b.c', ACTIVE: 'True', password: 'p', groups: [{ value: 'g' }], id: 'x', unknown: 1, emails: [{ value: 'a@b.c', primary: 'true' }, { value: 'b@b.c', primary: true }] }, set);
    expect(doc).toEqual({ userName: 'a@b.c', active: true, emails: [{ value: 'a@b.c', primary: false }, { value: 'b@b.c', primary: true }] });
    const next = applyPatch(
      doc,
      [
        { op: 'Replace', path: 'active', value: 'False' },
        { op: 'Add', path: 'name.givenName', value: 'Ann' },
        { op: 'Replace', path: 'emails[type eq "work"].value', value: 'ann@b.c' },
        { op: 'Add', path: `${ENTERPRISE_SCHEMA}:department`, value: 'Ops' },
        { op: 'replace', value: { displayName: 'Ann B', 'name.familyName': 'B' } },
        { op: 'add', value: { [ENTERPRISE_SCHEMA]: { employeeNumber: '42' } } },
        { op: 'remove', path: 'emails[value eq "b@b.c"]' }
      ],
      set
    );
    expect(next).toEqual({ userName: 'a@b.c', active: false, emails: [{ value: 'a@b.c', primary: false }, { type: 'work', value: 'ann@b.c' }], name: { givenName: 'Ann', familyName: 'B' }, displayName: 'Ann B', [ENTERPRISE_SCHEMA]: { department: 'Ops', employeeNumber: '42' } });
    expect(() => applyPatch(doc, [{ op: 'remove' }], set)).toThrow(/path/);
    expect(() => applyPatch(doc, [{ op: 'move', path: 'x' }], set)).toThrow(/add, replace or remove/);
    expect(() => applyPatch(doc, [{ op: 'replace', path: 'id', value: 'y' }], set)).toThrow(/server/);
    expect(() => applyPatch(doc, [{ op: 'add', path: 'groups', value: [{ value: 'g' }] }], set)).toThrow(/read only/);
    expect(() => applyPatch(doc, [{ op: 'replace', path: 'emails[type eq', value: 'x' }], set)).toThrow();
    // Groups: Entra removes members with a value list; Okta with a value filter.
    const g = { core: GROUP_SCHEMA, extensions: [] };
    const group = { displayName: 'Ops', members: [{ value: 'u1' }, { value: 'u2' }, { value: 'u3' }] };
    expect(applyPatch(group, [{ op: 'Remove', path: 'members', value: [{ value: 'u1' }] }], g).members).toEqual([{ value: 'u2' }, { value: 'u3' }]);
    expect(applyPatch(group, [{ op: 'remove', path: 'members[value eq "u2"]' }], g).members).toEqual([{ value: 'u1' }, { value: 'u3' }]);
    expect(applyPatch(group, [{ op: 'add', path: 'members', value: [{ value: 'u3' }, { value: 'u4' }] }], g).members).toHaveLength(4);
    expect(applyPatch(group, [{ op: 'replace', value: { id: 'ignored', displayName: 'Ops 2' } }], g).displayName).toBe('Ops 2');
  });

  it('projects attributes and excludedAttributes, always keeping id and schemas', () => {
    const r = { schemas: [USER_SCHEMA], id: 'x', userName: 'a', name: { givenName: 'A', familyName: 'B' }, emails: [{ value: 'e', type: 'work' }], meta: { version: 'W/"1"' } };
    expect(project(r, 'userName,name.givenName')).toEqual({ schemas: [USER_SCHEMA], id: 'x', userName: 'a', name: { givenName: 'A' } });
    expect(project(r, undefined, 'emails,name.familyName,id')).toEqual({ schemas: [USER_SCHEMA], id: 'x', userName: 'a', name: { givenName: 'A' }, meta: { version: 'W/"1"' } });
  });
});

describe('SCIM 2.0 conformance (the checks of the Entra ID SCIM Validator and Okta SCIM 2.0 tests)', () => {
  let h: Harness;
  let admin: Client;
  let store: string;
  let token: string;
  const as = (method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string, body?: object) => {
    const r = admin.agent[method](path).set('x-csrf-token', admin.csrf);
    return body ? r.send(body) : r;
  };
  const scim = (method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string, body?: object, t = token) => {
    const r = request(h.app)[method](`/scim/v2${path}`).set('authorization', `Bearer ${t}`);
    return body ? r.set('content-type', 'application/scim+json').send(JSON.stringify(body)) : r;
  };
  const newUser = (userName: string, extra: Record<string, unknown> = {}) => ({
    schemas: [USER_SCHEMA, ENTERPRISE_SCHEMA],
    userName,
    active: true,
    displayName: `${userName.split('@')[0]} Display`,
    emails: [{ primary: true, type: 'work', value: userName }],
    name: { formatted: 'x', familyName: 'Fam', givenName: 'Giv' },
    externalId: `ext-${userName}`,
    title: 'Engineer',
    preferredLanguage: 'en-GB',
    phoneNumbers: [{ type: 'mobile', value: '+44 20 7946 0000' }],
    addresses: [{ type: 'work', streetAddress: '1 Main St', locality: 'London', country: 'GB' }],
    [ENTERPRISE_SCHEMA]: { employeeNumber: '1001', department: 'Finance' },
    ...extra
  });

  beforeEach(async () => {
    h = await harness();
    await localUser(h, 'root', ['tenant-admin'], 'restricted');
    admin = await loginAdmin(h, 'root');
    store = (await as('post', '/api/admin/identity-providers', { name: 'Entra ID', kind: 'scim', config: { defaultRoles: ['member'] } }).expect(201)).body.id;
    token = (await as('post', `/api/admin/identity-providers/${store}/scim/tokens`, { name: 'Entra provisioning' }).expect(201)).body.token;
  });
  afterEach(async () => {
    await h.close();
  });

  it('discovery and authentication: ServiceProviderConfig, Schemas, ResourceTypes; refuses missing, wrong, revoked and expired tokens', async () => {
    const spc = (await scim('get', '/ServiceProviderConfig').expect(200).expect('content-type', /application\/scim\+json/)).body;
    expect(spc).toMatchObject({ patch: { supported: true }, bulk: { supported: false }, filter: { supported: true, maxResults: 200 }, changePassword: { supported: false }, sort: { supported: false }, etag: { supported: true }, authenticationSchemes: [expect.objectContaining({ type: 'oauthbearertoken' })] });
    const schemas = (await scim('get', '/Schemas').expect(200)).body;
    expect(schemas.Resources.map((x: { id: string }) => x.id)).toEqual([USER_SCHEMA, ENTERPRISE_SCHEMA, GROUP_SCHEMA]);
    expect((await scim('get', `/Schemas/${USER_SCHEMA}`).expect(200)).body.attributes.find((a: { name: string }) => a.name === 'userName')).toMatchObject({ required: true, uniqueness: 'server', caseExact: false });
    expect((await scim('get', '/ResourceTypes').expect(200)).body.Resources.map((x: { id: string }) => x.id)).toEqual(['User', 'Group']);
    await scim('get', '/ResourceTypes/User').expect(200);
    await scim('get', '/ResourceTypes/Nope').expect(404);

    const none = await request(h.app).get('/scim/v2/Users').expect(401);
    expect(none.body).toMatchObject({ schemas: [ERR], status: '401' });
    expect(none.headers['www-authenticate']).toMatch(/Bearer/);
    await scim('get', '/Users', undefined, 'exai_scim1_000000000000_' + 'A'.repeat(43)).expect(401);
    await scim('get', '/Users', undefined, token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')).expect(401);
    // Unsupported endpoints answer in the SCIM error format.
    expect((await scim('post', '/Bulk', { Operations: [] }).expect(501)).body.schemas).toEqual([ERR]);
    expect((await scim('get', '/Me').expect(404)).body.schemas).toEqual([ERR]);
    // A malformed body.
    const bad = await request(h.app).post('/scim/v2/Users').set('authorization', `Bearer ${token}`).set('content-type', 'application/scim+json').send('{"userName":');
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ scimType: 'invalidSyntax' });

    // Status, then revocation and expiry, from the Identity screen's routes.
    const status = (await as('get', `/api/admin/identity-providers/${store}/scim`).expect(200)).body;
    expect(status).toMatchObject({ baseUrl: expect.stringMatching(/\/scim\/v2$/), users: 0, groups: 0, tokens: [expect.objectContaining({ name: 'Entra provisioning', state: 'active', lastUsedAt: expect.any(Number) })] });
    expect(JSON.stringify(status)).not.toContain(token);
    const second = (await as('post', `/api/admin/identity-providers/${store}/scim/tokens`, { name: 'Expiring', expiresInDays: 1 }).expect(201)).body;
    await h.s.db('scim_tokens').where({ id: second.id }).update({ expires_at: Date.now() - 1 });
    expect((await scim('get', '/Users', undefined, second.token).expect(401)).body.detail).toMatch(/expired/);
    await as('delete', `/api/admin/identity-providers/${store}/scim/tokens/${status.tokens[0].id}`).expect(200);
    expect((await scim('get', '/Users').expect(401)).body.detail).toMatch(/revoked/);
    const actions = ((await h.s.db('audit_events').where('action', 'like', 'scim.token.%').select('action')) as { action: string }[]).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['scim.token.created', 'scim.token.revoked']));
    // Tokens are for SCIM stores only, and need identity:manage.
    const local = (await h.s.providers.list(h.tenantId)).find((p) => p.kind === 'local')!;
    await as('post', `/api/admin/identity-providers/${local.id}/scim/tokens`, { name: 'x' }).expect(400);
  });

  it('users: create, get, filter (case rules, no match), PATCH (Entra and Okta shapes), PUT, paging, projection, ETags, duplicates, delete', async () => {
    // Create
    const created = await scim('post', '/Users', newUser('Alice.Ng@contoso.com')).expect(201);
    const u = created.body;
    expect(created.headers.location).toBe(u.meta.location);
    expect(created.headers.etag).toBe('W/"1"');
    expect(u).toMatchObject({ schemas: [USER_SCHEMA, ENTERPRISE_SCHEMA], userName: 'Alice.Ng@contoso.com', active: true, externalId: 'ext-Alice.Ng@contoso.com', name: { givenName: 'Giv', familyName: 'Fam' }, title: 'Engineer', [ENTERPRISE_SCHEMA]: { employeeNumber: '1001', department: 'Finance' }, meta: { resourceType: 'User', version: 'W/"1"', location: expect.stringMatching(new RegExp(`/scim/v2/Users/${u.id}$`)) } });
    expect(u.password).toBeUndefined();
    const row = (await h.s.users.get(h.tenantId, u.id))!;
    expect(row).toMatchObject({ username: 'alice.ng@contoso.com', display_name: 'Alice.Ng Display', email: 'Alice.Ng@contoso.com', state: 'active' });
    expect(await h.s.users.roleIds(u.id)).toEqual(['member']); // the store's default roles
    // Duplicate userName (any case) is a uniqueness conflict.
    expect((await scim('post', '/Users', newUser('alice.ng@CONTOSO.com')).expect(409)).body).toMatchObject({ schemas: [ERR], status: '409', scimType: 'uniqueness' });
    await scim('post', '/Users', { schemas: [USER_SCHEMA], displayName: 'No name' }).expect(400);
    // A username of another store is never taken over.
    await localUser(h, 'bob@contoso.com', ['member']);
    expect((await scim('post', '/Users', newUser('Bob@contoso.com')).expect(409)).body.scimType).toBe('uniqueness');

    // Get and filter
    expect((await scim('get', `/Users/${u.id}`).expect(200)).body.id).toBe(u.id);
    const missing = await scim('get', '/Users/01ARZ3NDEKTSV4RRFFQ69G5FAV').expect(404);
    expect(missing.body).toMatchObject({ schemas: [ERR], status: '404' });
    const byName = (await scim('get', `/Users?filter=${encodeURIComponent('userName eq "ALICE.NG@contoso.com"')}`).expect(200)).body;
    expect(byName).toMatchObject({ schemas: [LIST], totalResults: 1, itemsPerPage: 1, startIndex: 1, Resources: [expect.objectContaining({ id: u.id })] });
    expect((await scim('get', `/Users?filter=${encodeURIComponent('externalId eq "ext-Alice.Ng@contoso.com"')}`).expect(200)).body.totalResults).toBe(1);
    expect((await scim('get', `/Users?filter=${encodeURIComponent('externalId eq "EXT-alice.ng@contoso.com"')}`).expect(200)).body.totalResults).toBe(0);
    expect((await scim('get', `/Users?filter=${encodeURIComponent('userName eq "nobody@contoso.com"')}`).expect(200)).body).toMatchObject({ totalResults: 0, Resources: [] });
    expect((await scim('get', `/Users?filter=${encodeURIComponent('userName eq')}`).expect(400)).body.scimType).toBe('invalidFilter');

    // PATCH, as Entra ID sends it (capitalised ops, booleans as strings, paths with value filters and the extension)
    const patched = await scim('patch', `/Users/${u.id}`, {
      schemas: [PATCH],
      Operations: [
        { op: 'Replace', path: 'displayName', value: 'Alice Ng' },
        { op: 'Replace', path: 'name.givenName', value: 'Alice' },
        { op: 'Replace', path: 'emails[type eq "work"].value', value: 'alice@contoso.com' },
        { op: 'Add', path: `${ENTERPRISE_SCHEMA}:department`, value: 'Treasury' },
        { op: 'Add', path: `${ENTERPRISE_SCHEMA}:manager`, value: { value: 'M-77' } },
        { op: 'Replace', path: 'title', value: 'Lead' }
      ]
    }).expect(200);
    expect(patched.headers.etag).toBe('W/"2"');
    expect(patched.body).toMatchObject({ displayName: 'Alice Ng', name: { givenName: 'Alice' }, title: 'Lead', emails: [expect.objectContaining({ value: 'alice@contoso.com' })], [ENTERPRISE_SCHEMA]: { department: 'Treasury', manager: { value: 'M-77' } } });
    expect((await h.s.users.get(h.tenantId, u.id))!).toMatchObject({ display_name: 'Alice Ng', email: 'alice@contoso.com' });
    // ... and as Okta sends it (no path, a value object)
    await scim('patch', `/Users/${u.id}`, { schemas: [PATCH], Operations: [{ op: 'replace', value: { nickName: 'Al' } }] }).expect(200);
    // Errors
    expect((await scim('patch', `/Users/${u.id}`, { schemas: [PATCH], Operations: [{ op: 'replace', path: 'id', value: 'x' }] }).expect(400)).body.scimType).toBe('mutability');
    expect((await scim('patch', `/Users/${u.id}`, { schemas: [PATCH], Operations: [{ op: 'remove' }] }).expect(400)).body.scimType).toBe('noTarget');
    expect((await scim('patch', `/Users/${u.id}`, { schemas: [PATCH], Operations: [{ op: 'add', path: 'shoeSize', value: 9 }] }).expect(400)).body.scimType).toBe('invalidPath');
    // If-Match with a stale version is refused; with the current one it applies.
    await scim('patch', `/Users/${u.id}`, { schemas: [PATCH], Operations: [{ op: 'replace', path: 'title', value: 'x' }] }).set('if-match', 'W/"1"').expect(412);
    const cur = String((await scim('get', `/Users/${u.id}`).expect(200)).headers.etag);
    await scim('patch', `/Users/${u.id}`, { schemas: [PATCH], Operations: [{ op: 'replace', path: 'title', value: 'Principal' }] }).set('if-match', cur).expect(200);

    // PUT replaces the whole resource (Okta): attributes not sent are gone.
    const put = (await scim('put', `/Users/${u.id}`, { schemas: [USER_SCHEMA], userName: 'alice.ng@contoso.com', active: true, name: { givenName: 'Alice', familyName: 'Ng' }, emails: [{ value: 'alice@contoso.com', primary: true }] }).expect(200)).body;
    expect(put.title).toBeUndefined();
    expect(put[ENTERPRISE_SCHEMA]).toBeUndefined();
    expect(put.schemas).toEqual([USER_SCHEMA]);
    expect((await h.s.users.get(h.tenantId, u.id))!.display_name).toBe('Alice Ng'); // from the name parts now

    // Paging and projection
    for (const n of ['c1', 'c2', 'c3', 'c4']) await scim('post', '/Users', newUser(`${n}@contoso.com`)).expect(201);
    const page = (await scim('get', '/Users?startIndex=2&count=2').expect(200)).body;
    expect(page).toMatchObject({ totalResults: 5, itemsPerPage: 2, startIndex: 2 });
    expect(page.Resources.map((r: { userName: string }) => r.userName)).toEqual(['c1@contoso.com', 'c2@contoso.com']);
    expect((await scim('get', '/Users?count=0').expect(200)).body).toMatchObject({ totalResults: 5, itemsPerPage: 0, Resources: [] });
    expect((await scim('get', '/Users?startIndex=x').expect(400)).body.scimType).toBe('invalidValue');
    const proj = (await scim('get', `/Users?attributes=userName&filter=${encodeURIComponent('userName sw "c"')}&count=1`).expect(200)).body;
    expect(proj).toMatchObject({ totalResults: 4, itemsPerPage: 1 });
    expect(Object.keys(proj.Resources[0]).sort()).toEqual(['id', 'schemas', 'userName']);
    const ex = (await scim('get', `/Users/${u.id}?excludedAttributes=emails,name`).expect(200)).body;
    expect(ex.emails).toBeUndefined();
    expect(ex.userName).toBe('alice.ng@contoso.com');
    // Complex filters are evaluated over the store's users.
    const complex = (await scim('get', `/Users?filter=${encodeURIComponent('emails[type eq "work" and value ew "@contoso.com"] and not (userName sw "alice")')}`).expect(200)).body;
    expect(complex.totalResults).toBe(4);

    // Delete: 204, then 404; the user row stays, disabled, with no SCIM link.
    await scim('delete', `/Users/${u.id}`).expect(204);
    await scim('get', `/Users/${u.id}`).expect(404);
    expect((await h.s.users.get(h.tenantId, u.id))!).toMatchObject({ state: 'disabled', disabled_reason: 'SCIM: deleted' });
    expect(await h.s.db('user_identities').where({ user_id: u.id, provider_id: store })).toHaveLength(0);
    // Re-created with the same userName, the same user is adopted and enabled again.
    const back = (await scim('post', '/Users', newUser('alice.ng@contoso.com')).expect(201)).body;
    expect(back.id).toBe(u.id);
    expect((await h.s.users.get(h.tenantId, u.id))!.state).toBe('active');
    const audit = ((await h.s.db('audit_events').where('action', 'like', 'scim.user.%').select('action')) as { action: string }[]).map((a) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['scim.user.created', 'scim.user.patched', 'scim.user.replaced', 'scim.user.deleted', 'scim.user.reactivated']));
  });

  it('groups: create with members, filter by displayName without members, PATCH add and remove (both shapes), rename, duplicates, delete; membership maps to roles', async () => {
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Finance', 'confidential')).id;
    // The store gives no roles by itself here; the group mapping does.
    await as('patch', `/api/admin/identity-providers/${store}`, { config: { defaultRoles: [] } }).expect(200);
    const a = (await scim('post', '/Users', newUser('a@contoso.com')).expect(201)).body;
    const b = (await scim('post', '/Users', newUser('b@contoso.com')).expect(201)).body;
    const c = (await scim('post', '/Users', newUser('c@contoso.com')).expect(201)).body;
    await as('post', '/api/admin/group-mappings', { providerId: store, group: 'Finance Analysts', role: 'knowledge-curator', clearance: 'confidential', workspaceId: ws }).expect(201);

    const g = await scim('post', '/Groups', { schemas: [GROUP_SCHEMA], displayName: 'Finance Analysts', externalId: 'g-ext-1', members: [{ value: a.id }, { value: b.id }] }).expect(201);
    expect(g.body).toMatchObject({ schemas: [GROUP_SCHEMA], displayName: 'Finance Analysts', externalId: 'g-ext-1', members: [expect.objectContaining({ value: a.id, type: 'User' }), expect.objectContaining({ value: b.id })], meta: { resourceType: 'Group', version: 'W/"1"' } });
    const gid = g.body.id;
    expect(await h.s.users.roleIds(a.id)).toEqual(['knowledge-curator']);
    expect((await h.s.users.get(h.tenantId, a.id))!.clearance).toBe('confidential');
    expect(await h.s.users.workspaceIds(a.id)).toContain(ws);
    expect(await h.s.users.roleIds(c.id)).toEqual([]);
    // The user's resource lists the group (read only).
    expect((await scim('get', `/Users/${a.id}`).expect(200)).body.groups).toEqual([expect.objectContaining({ value: gid, display: 'Finance Analysts' })]);

    expect((await scim('post', '/Groups', { schemas: [GROUP_SCHEMA], displayName: 'finance analysts' }).expect(409)).body.scimType).toBe('uniqueness');
    expect((await scim('post', '/Groups', { schemas: [GROUP_SCHEMA], displayName: 'X', members: [{ value: 'NOPE' }] }).expect(400)).body.scimType).toBe('invalidValue');
    const found = (await scim('get', `/Groups?filter=${encodeURIComponent('displayName eq "Finance Analysts"')}&excludedAttributes=members`).expect(200)).body;
    expect(found).toMatchObject({ totalResults: 1, Resources: [expect.objectContaining({ id: gid, displayName: 'Finance Analysts' })] });
    expect(found.Resources[0].members).toBeUndefined();
    expect((await scim('get', `/Groups/${gid}?excludedAttributes=members`).expect(200)).body.members).toBeUndefined();
    expect((await scim('get', `/Groups?filter=${encodeURIComponent(`members[value eq "${b.id}"]`)}`).expect(200)).body.totalResults).toBe(1);

    // Entra ID: Add members, then Remove members with a value list.
    await scim('patch', `/Groups/${gid}`, { schemas: [PATCH], Operations: [{ op: 'Add', path: 'members', value: [{ value: c.id }] }] }).expect(200);
    expect(await h.s.users.roleIds(c.id)).toEqual(['knowledge-curator']);
    await scim('patch', `/Groups/${gid}`, { schemas: [PATCH], Operations: [{ op: 'Remove', path: 'members', value: [{ value: a.id }] }] }).expect(200);
    expect(await h.s.users.roleIds(a.id)).toEqual([]);
    expect(await h.s.users.workspaceIds(a.id)).not.toContain(ws);
    // Okta: remove with a value filter; replace the name with a value object.
    await scim('patch', `/Groups/${gid}`, { schemas: [PATCH], Operations: [{ op: 'remove', path: `members[value eq "${b.id}"]` }] }).expect(200);
    expect(await h.s.users.roleIds(b.id)).toEqual([]);
    const renamed = (await scim('patch', `/Groups/${gid}`, { schemas: [PATCH], Operations: [{ op: 'replace', value: { id: gid, displayName: 'Finance Team' } }] }).expect(200)).body;
    expect(renamed).toMatchObject({ displayName: 'Finance Team', members: [expect.objectContaining({ value: c.id })] });
    expect(await h.s.users.roleIds(c.id)).toEqual([]); // the mapping names the old name
    // Mappings changed afterwards are re-applied by job from the Identity screen.
    await as('post', '/api/admin/group-mappings', { providerId: store, group: 'Finance Team', role: 'flag-reviewer', clearance: 'internal' }).expect(201);
    await as('post', `/api/admin/identity-providers/${store}/scim/reapply`).expect(202);
    await drain(h);
    expect(await h.s.users.roleIds(c.id)).toEqual(['flag-reviewer']);

    // PUT replaces the members.
    const put = (await scim('put', `/Groups/${gid}`, { schemas: [GROUP_SCHEMA], displayName: 'Finance Team', members: [{ value: a.id }] }).expect(200)).body;
    expect(put.members.map((m: { value: string }) => m.value)).toEqual([a.id]);
    expect(await h.s.users.roleIds(c.id)).toEqual([]);
    expect(await h.s.users.roleIds(a.id)).toEqual(['flag-reviewer']);
    // Delete: members lose what it gave them.
    await scim('delete', `/Groups/${gid}`).expect(204);
    await scim('get', `/Groups/${gid}`).expect(404);
    expect(await h.s.users.roleIds(a.id)).toEqual([]);
    const actions = ((await h.s.db('audit_events').where('action', 'like', 'scim.%').select('action')) as { action: string }[]).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['scim.group.created', 'scim.group.patched', 'scim.group.replaced', 'scim.group.deleted', 'scim.user.access.changed', 'scim.mappings.reapplied']));
  });

  it('a second SCIM store, or another tenant, sees none of this store\'s users; deleting the store drops its records', async () => {
    const other = (await as('post', '/api/admin/identity-providers', { name: 'Okta', kind: 'scim', config: {} }).expect(201)).body.id;
    const t2 = (await as('post', `/api/admin/identity-providers/${other}/scim/tokens`, { name: 'Okta' }).expect(201)).body.token;
    const u = (await scim('post', '/Users', newUser('x@contoso.com')).expect(201)).body;
    expect((await scim('get', '/Users', undefined, t2).expect(200)).body.totalResults).toBe(0);
    await scim('get', `/Users/${u.id}`, undefined, t2).expect(404);
    // The same userName from the second store is refused: that user belongs to the first store.
    expect((await scim('post', '/Users', newUser('x@contoso.com'), t2).expect(409)).body.scimType).toBe('uniqueness');
    // A disabled store answers 403.
    await as('patch', `/api/admin/identity-providers/${other}`, { enabled: false }).expect(200);
    await scim('get', '/Users', undefined, t2).expect(403);
    // Sign-in stores must be upstream stores of the tenant.
    await as('patch', `/api/admin/identity-providers/${other}`, { config: { signInStores: [store] } }).expect(400);
    await as('delete', `/api/admin/identity-providers/${store}`).expect(204);
    expect(await h.s.db('scim_users').where({ provider_id: store })).toHaveLength(0);
    await scim('get', '/Users').expect(401);
  });

  describe('deprovisioning through SCIM (B-7201 done when)', () => {
    const idp = new FakeIdp();
    beforeAll(async () => {
      await idp.start();
      process.env.UPSTREAM_SECRET_SCIM = idp.clientSecret;
    });
    afterAll(async () => idp.stop());

    it('deactivating a user through SCIM ends their open console session within one request, and their keys and app passwords', async () => {
      // Entra ID provisions the user; they sign in through the tenant's OIDC store of the same provider.
      const upstream = (await as('post', '/api/admin/federation/upstream', { name: 'Entra sign-in', protocol: 'oidc', source: idp.url, clientId: idp.clientId, clientSecret: 'env:UPSTREAM_SECRET_SCIM' }).expect(201)).body.id;
      await as('patch', `/api/admin/identity-providers/${store}`, { config: { defaultRoles: ['member'], signInStores: [upstream] } }).expect(200);
      const u = (await scim('post', '/Users', newUser('Priya@contoso.com', { displayName: 'Priya N' })).expect(201)).body;

      const browser = request.agent(h.app);
      const start = await browser.get(`/federation/oidc/start?provider=${upstream}`).expect(302);
      // The upstream's own groups do not decide roles for a SCIM user; its name does not overwrite the SCIM one.
      const { code, state } = idp.authorize(start.headers.location!, { sub: 'entra-oid-1', preferred_username: 'priya@contoso.com', name: 'Someone Else', groups: ['admins'] });
      await browser.get(`/federation/oidc/callback?${new URLSearchParams({ code, state })}`).expect(302);
      expect((await browser.get('/api/auth/session').expect(200)).body).toMatchObject({ authenticated: true, stage: 'active' });
      expect((await browser.get('/api/me').expect(200)).body.user).toMatchObject({ id: u.id, username: 'priya@contoso.com' });
      expect((await h.s.users.get(h.tenantId, u.id))!.display_name).toBe('Priya N');
      expect(await h.s.users.roleIds(u.id)).toEqual(['member']);
      const key = await h.s.apiKeys.create({ tenantId: h.tenantId, userId: u.id, name: 'cli', scopes: ['chat:read'], ttlDays: 30 });
      await request(h.app).get('/api/me').set('authorization', `Bearer ${key.key}`).expect(200);
      await h.s.dav.passwords.create({ tenantId: h.tenantId, userId: u.id, name: 'Calendar', scopes: ['caldav'], ttlDays: null });

      // Entra ID turns the account off.
      const off = await scim('patch', `/Users/${u.id}`, { schemas: [PATCH], Operations: [{ op: 'Replace', path: 'active', value: 'False' }] }).expect(200);
      expect(off.body.active).toBe(false);
      // The very next request of the open session is no longer signed in; nor is the API key.
      await browser.get('/api/me').expect(401);
      expect((await browser.get('/api/auth/session').expect(200)).body.authenticated).toBe(false);
      await request(h.app).get('/api/me').set('authorization', `Bearer ${key.key}`).expect(401);
      expect((await h.s.users.get(h.tenantId, u.id))!).toMatchObject({ state: 'disabled', disabled_reason: 'SCIM: deactivated' });
      const ev = (await h.s.db('audit_events').where({ action: 'scim.user.deactivated' }).first()) as { detail: string; actor: string };
      expect(JSON.parse(ev.detail).revoked).toMatchObject({ sessions: 1, apiKeys: 1, appPasswords: 1 });
      expect(JSON.parse(ev.actor)).toMatchObject({ service: 'scim' });
      // A disabled user cannot sign in again through the upstream store.
      const again = await request.agent(h.app).get(`/federation/oidc/start?provider=${upstream}`).expect(302);
      const second = idp.authorize(again.headers.location!, { sub: 'entra-oid-1', preferred_username: 'priya@contoso.com', groups: [] });
      const refused = await request(h.app).get(`/federation/oidc/callback?${new URLSearchParams(second)}`);
      expect(refused.status).toBeGreaterThanOrEqual(400);
      // Reactivated by SCIM: they may sign in again (nothing ended is restored).
      await scim('patch', `/Users/${u.id}`, { schemas: [PATCH], Operations: [{ op: 'replace', value: { active: true } }] }).expect(200);
      expect((await h.s.users.get(h.tenantId, u.id))!.state).toBe('active');
      // An administrator's own disable is not undone by SCIM.
      await h.s.users.update(h.tenantId, u.id, { state: 'disabled', disabled_reason: 'Disabled by an admin' });
      await scim('patch', `/Users/${u.id}`, { schemas: [PATCH], Operations: [{ op: 'replace', path: 'active', value: false }] }).expect(200);
      await scim('patch', `/Users/${u.id}`, { schemas: [PATCH], Operations: [{ op: 'replace', path: 'active', value: true }] }).expect(200);
      expect((await h.s.users.get(h.tenantId, u.id))!.state).toBe('disabled');
    });
  });
});
