import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { maskValue, redactSpansForTest, resolveRows, subjectMatches, type UserFacts } from './sprint38c-policies-helpers.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';
import { drain } from './retrieval-seed.js';

const facts = (o: Partial<UserFacts> = {}): UserFacts => ({ id: '01HUSER000000000000000000A', username: 'ana', clearance: 'confidential', roles: ['member'], groups: ['sales', 'emea-team'], workspaces: ['ws1'], attributes: { region: 'emea' }, ...o });

describe('B-8101: policy rows and subjects', () => {
  it('substitutes user facts for placeholders, and a missing fact means the policy grants nothing', () => {
    expect(resolveRows({ field: 'region', op: 'eq', value: '$user.attributes.region' }, facts())).toEqual({ field: 'region', op: 'eq', value: 'emea' });
    expect(resolveRows({ field: 'owner', op: 'eq', value: '$user.id' }, facts())).toEqual({ field: 'owner', op: 'eq', value: '01HUSER000000000000000000A' });
    expect(resolveRows({ field: 'team', op: 'in', value: ['$user.groups'] }, facts())).toEqual({ field: 'team', op: 'in', value: ['sales', 'emea-team'] });
    expect(resolveRows({ and: [{ field: 'region', op: 'eq', value: '$user.attributes.region' }, { field: 'stage', op: 'eq', value: 'Won' }] }, facts({ attributes: {} }))).toBeNull();
    expect(resolveRows({ field: 'team', op: 'in', value: ['$user.groups'] }, facts({ groups: [] }))).toBeNull();
  });

  it('matches subjects by role, group, workspace and user', () => {
    const u = facts();
    expect(subjectMatches({ kind: 'everyone' }, u)).toBe(true);
    expect(subjectMatches({ kind: 'role', value: 'member' }, u)).toBe(true);
    expect(subjectMatches({ kind: 'role', value: 'auditor' }, u)).toBe(false);
    expect(subjectMatches({ kind: 'group', value: 'Sales' }, u)).toBe(true);
    expect(subjectMatches({ kind: 'workspace', value: 'ws1' }, u)).toBe(true);
    expect(subjectMatches({ kind: 'user', value: 'ANA' }, u)).toBe(true);
    expect(subjectMatches({ kind: 'user', value: 'bob' }, u)).toBe(false);
  });

  it('masks values by format', () => {
    expect(maskValue('123-45-6789', 'last4')).toBe('***-**-6789');
    expect(maskValue('4111 1111 1111 1111', 'last4')).toBe('**** **** **** 1111');
    expect(maskValue(1234567, 'last4')).toBe('***4567');
    expect(maskValue('abc', 'last4')).toBe('abc');
    expect(maskValue('secret', 'hash')).toMatch(/^[0-9a-f]{12}$/);
    expect(maskValue('secret', 'hidden')).toBeNull();
    expect(maskValue(null, 'last4')).toBeNull();
    expect(redactSpansForTest).toBeTypeOf('function');
  });
});

describe('B-8101 to B-8103: policies on an app (API)', () => {
  let h: Harness;
  let wsId: string;

  beforeEach(async () => {
    h = await harness();
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Sales', 'confidential')).id;
  });
  afterEach(async () => {
    await h.close();
  });

  async function wrap(c: { agent: Client['agent']; csrf: string }) {
    const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
    await send('put', '/api/me/workspace', { workspaceId: wsId }).expect(200);
    return { ...c, post: (p: string, b?: object) => send('post', p, b), put: (p: string, b?: object) => send('put', p, b), patch: (p: string, b?: object) => send('patch', p, b), del: (p: string) => send('delete', p), get: (p: string) => c.agent.get(p) };
  }
  async function member(name: string, attributes: Record<string, string> | null = null) {
    const u = await localUser(h, name, ['member'], 'confidential');
    await h.s.tenants.addMember(wsId, u.id);
    if (attributes) await h.s.users.update(h.tenantId, u.id, { attributes: JSON.stringify(attributes) });
    return { user: u, ...(await wrap(await login(h, name))) };
  }
  async function designer(name = 'dee') {
    const u = await localUser(h, name, ['workflow-admin', 'member'], 'confidential');
    await h.s.tenants.addMember(wsId, u.id);
    return { user: u, ...(await wrap(await loginAdmin(h, name))) };
  }

  const entity = {
    name: 'deal',
    title: 'Deal',
    label: 'internal',
    definition: {
      fields: [
        { name: 'title', type: 'string', required: true, indexed: true, unique: true, maxLength: 120 },
        { name: 'amount', type: 'number', indexed: true, min: 0 },
        { name: 'region', type: 'string', indexed: true, maxLength: 20 },
        { name: 'ssn', type: 'string', maxLength: 20 },
        { name: 'notes', type: 'string', multiline: true, maxLength: 500 }
      ]
    }
  };

  async function setup() {
    const dee = await designer();
    await dee.post('/api/apps', { name: 'crm', title: 'CRM', label: 'confidential', workspaceId: wsId }).expect(201);
    await dee.post('/api/apps/crm/entities', entity).expect(201);
    const rec = async (values: Record<string, unknown>) => (await dee.post('/api/apps/crm/entities/deal/records', { values }).expect(201)).body as { id: string };
    const emea1 = await rec({ title: 'Contoso', amount: 100, region: 'emea', ssn: '123-45-6789', notes: 'first' });
    const emea2 = await rec({ title: 'Fabrikam', amount: 250, region: 'emea', ssn: '987-65-4321' });
    const apac = await rec({ title: 'Tailspin', amount: 400, region: 'apac', ssn: '555-66-7777' });
    return { dee, emea1, emea2, apac };
  }

  const titles = (body: { records: { values: { title: string } }[] }) => body.records.map((r) => r.values.title).sort();

  it('rows by the user’s attribute reach the screen, the API, counts and exports; fields are masked or hidden; writes are limited', async () => {
    const { dee, emea1, apac } = await setup();
    const ana = await member('ana', { region: 'emea' });
    const bob = await member('bob', { region: 'apac' });
    const cat = await member('cat');

    // Without policies every member reads every record in full.
    expect(titles((await ana.get('/api/apps/crm/entities/deal/records').expect(200)).body)).toEqual(['Contoso', 'Fabrikam', 'Tailspin']);

    // Refused policies: an unindexed field, an unknown placeholder, a list placeholder with eq.
    expect((await dee.post('/api/apps/crm/policies', { name: 'bad', subjects: [{ kind: 'everyone' }], rows: { field: 'notes', op: 'eq', value: 'x' } }).expect(422)).body.title).toBe('Field not indexed');
    expect((await dee.post('/api/apps/crm/policies', { name: 'bad', subjects: [{ kind: 'everyone' }], rows: { field: 'region', op: 'eq', value: '$user.region' } }).expect(422)).body.title).toBe('Unknown placeholder');
    expect((await dee.post('/api/apps/crm/policies', { name: 'bad', subjects: [{ kind: 'everyone' }], rows: { field: 'region', op: 'eq', value: '$user.groups' } }).expect(422)).body.title).toBe('List placeholder');
    await dee.post('/api/apps/crm/policies', { name: 'bad', subjects: [{ kind: 'everyone' }], fields: { nope: { read: false } } }).expect(422);

    const policy = (
      await dee
        .post('/api/apps/crm/policies', {
          name: 'Own region',
          entity: 'deal',
          subjects: [{ kind: 'role', value: 'member' }],
          rows: { field: 'region', op: 'eq', value: '$user.attributes.region' },
          fields: { ssn: { read: true, unmasked: false, mask: 'last4' }, amount: { update: false }, notes: { read: false } }
        })
        .expect(201)
    ).body;
    expect(policy).toMatchObject({ name: 'Own region', entity: 'deal', enabled: true, otherFields: { read: true, unmasked: true, create: true, update: true } });
    expect((await dee.get('/api/apps/crm/policies').expect(200)).body).toMatchObject({ policies: [{ id: policy.id }], placeholders: expect.arrayContaining(['$user.id', '$user.attributes.<name>']) });

    // Ana (emea) reaches the emea rows only, with the SSN masked and the notes hidden.
    const page = (await ana.get('/api/apps/crm/entities/deal/records').expect(200)).body;
    expect(titles(page)).toEqual(['Contoso', 'Fabrikam']);
    expect(page.total).toBe(2);
    const contoso = page.records.find((r: { values: { title: string } }) => r.values.title === 'Contoso');
    expect(contoso.values).toEqual({ title: 'Contoso', amount: 100, region: 'emea', ssn: '***-**-6789' });
    expect(contoso.masked).toEqual({ ssn: 'last4' });
    expect(contoso.hidden).toEqual(['notes']);
    // The same through the query body, a count, a single read, and the records a bulk read would miss.
    expect(titles((await ana.post('/api/apps/crm/entities/deal/records/query', { filter: { field: 'amount', op: 'gte', value: 0 } }).expect(200)).body)).toEqual(['Contoso', 'Fabrikam']);
    const agg = (await ana.post('/api/apps/crm/entities/deal/records/aggregate', { metrics: [{ op: 'count' }, { op: 'sum', field: 'amount' }] }).expect(200)).body;
    expect(agg.groups[0]!.values).toEqual([2, 350]);
    await ana.get(`/api/apps/crm/entities/deal/records/${apac.id}`).expect(404);
    expect((await ana.get(`/api/apps/crm/entities/deal/records/${emea1.id}`).expect(200)).body.values.ssn).toBe('***-**-6789');
    // Bob (apac) reaches the apac row; Cat, with no region, reaches nothing and may not create.
    expect(titles((await bob.get('/api/apps/crm/entities/deal/records').expect(200)).body)).toEqual(['Tailspin']);
    const none = (await cat.get('/api/apps/crm/entities/deal/records').expect(200)).body;
    expect(none.records).toEqual([]);
    expect(none.total).toBe(0);
    expect((await cat.post('/api/apps/crm/entities/deal/records', { values: { title: 'Mine', region: 'emea' } }).expect(403)).body.step).toBe('policy');

    // Hidden fields cannot be filtered or sorted by; a masked one can.
    expect((await ana.get('/api/apps/crm/entities/deal/records?sort=notes:asc').expect(403)).body).toMatchObject({ step: 'policy', field: 'notes' });
    await ana.post('/api/apps/crm/entities/deal/records/query', { filter: { field: 'notes', op: 'contains', value: 'first' } }).expect(403);

    // Writes: amount is not updatable under the policy, the title is; a record outside the rows is not there to update.
    expect((await ana.patch(`/api/apps/crm/entities/deal/records/${emea1.id}`, { values: { amount: 5 } }).expect(403)).body).toMatchObject({ step: 'policy', fields: ['amount'] });
    expect((await ana.patch(`/api/apps/crm/entities/deal/records/${emea1.id}`, { values: { title: 'Contoso Ltd' } }).expect(200)).body.values.title).toBe('Contoso Ltd');
    await ana.patch(`/api/apps/crm/entities/deal/records/${apac.id}`, { values: { title: 'x' } }).expect(404);
    await ana.del(`/api/apps/crm/entities/deal/records/${apac.id}`).expect(404);
    const bulk = await ana.post('/api/apps/crm/entities/deal/records/bulk', { update: [{ id: emea1.id, values: { amount: 1 } }] }).expect(403);
    expect(bulk.body.detail).toMatch(/update 1: .*amount/);
    expect((await ana.post('/api/apps/crm/entities/deal/records', { values: { title: 'New emea', region: 'emea', ssn: '111-22-3333' } }).expect(201)).body.values.ssn).toBe('***-**-3333');

    // An export carries what the exporter reaches, masked.
    const x = (await ana.post('/api/apps/crm/entities/deal/records/export', {}).expect(202)).body;
    await drain(h);
    const file = await ana.get(`/api/apps/transfers/${x.id}/download`).expect(200);
    const lines = file.text.trim().split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('id,state,label,createdAt,updatedAt,title,amount,region,ssn,notes');
    expect(lines.slice(1).every((l: string) => /\*\*\*-\*\*-\d{4}/.test(l) && l.includes('emea'))).toBe(true);
    expect(lines.some((l: string) => l.includes('Tailspin'))).toBe(false);

    // The designer is not subject to policies, and explain says why each reader gets what they get.
    expect(titles((await dee.get('/api/apps/crm/entities/deal/records').expect(200)).body)).toEqual(['Contoso Ltd', 'Fabrikam', 'New emea', 'Tailspin']);
    const ex = (await dee.post('/api/apps/crm/entities/deal/policies/explain', { userId: bob.user.id, recordId: apac.id, field: 'ssn' }).expect(200)).body;
    expect(ex).toMatchObject({ policed: true, none: false, user: { username: 'bob', attributes: { region: 'apac' } }, record: { reachable: true, by: 'Own region' }, field: { name: 'ssn', read: true, unmasked: false, mask: 'last4', by: 'Own region' } });
    expect(ex.policies).toEqual([expect.objectContaining({ name: 'Own region', matches: true, rows: { field: 'region', op: 'eq', value: 'apac' } })]);
    const exCat = (await dee.post('/api/apps/crm/entities/deal/policies/explain', { userId: cat.user.id, recordId: emea1.id }).expect(200)).body;
    expect(exCat).toMatchObject({ none: true, record: { reachable: false }, policies: [expect.objectContaining({ matches: false, reason: expect.stringMatching(/not set for this user/) })] });
    const exDee = (await dee.post('/api/apps/crm/entities/deal/policies/explain', { userId: dee.user.id, recordId: apac.id }).expect(200)).body;
    expect(exDee).toMatchObject({ policed: false, user: { designer: true }, record: { reachable: true, by: 'designer (apps:design)' } });

    // A second policy naming Ana widens her grant: every row, and the SSN unmasked (grants combine permissively).
    await dee.post('/api/apps/crm/policies', { name: 'Ana sees all', entity: 'deal', subjects: [{ kind: 'user', value: ana.user.id }], fields: { ssn: { read: true, unmasked: true }, notes: { read: true } } }).expect(201);
    const widened = (await ana.get('/api/apps/crm/entities/deal/records').expect(200)).body;
    expect(titles(widened)).toEqual(['Contoso Ltd', 'Fabrikam', 'New emea', 'Tailspin']);
    expect(widened.records.find((r: { values: { title: string } }) => r.values.title === 'Contoso Ltd').values).toMatchObject({ ssn: '123-45-6789', notes: 'first' });
    // Bob is unchanged.
    expect(titles((await bob.get('/api/apps/crm/entities/deal/records').expect(200)).body)).toEqual(['Tailspin']);

    // Disabling and deleting policies; members cannot touch them.
    await ana.get('/api/apps/crm/policies').expect(403);
    await dee.put(`/api/apps/crm/policies/${policy.id}`, { ...policy, enabled: false, entity: 'deal', subjects: policy.subjects, rows: policy.rows, fields: policy.fields, otherFields: policy.otherFields, id: undefined, createdBy: undefined, updatedBy: undefined, createdAt: undefined, updatedAt: undefined, description: null }).expect(200);
    expect(titles((await bob.get('/api/apps/crm/entities/deal/records').expect(200)).body)).toEqual([]);
    await dee.del(`/api/apps/crm/policies/${policy.id}`).expect(204);
    const actions = ((await h.s.db('audit_events').where({ tenant_id: h.tenantId }).where('action', 'like', 'app.policy.%').select('action')) as { action: string }[]).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['app.policy.created', 'app.policy.updated', 'app.policy.deleted']));
  });

  it('a tenant admin sets the attributes policies compare, and a group subject reaches directory groups', async () => {
    const { dee, emea1 } = await setup();
    const ta = await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    const admin = await loginAdmin(h, 'ta');
    const ana = await member('ana');
    void ta;
    const patch = await admin.agent.patch(`/api/admin/users/${ana.user.id}`).set('x-csrf-token', admin.csrf).send({ attributes: { region: 'emea', dept: 'sales' } }).expect(200);
    expect(patch.body.ok).toBe(true);
    expect((await admin.agent.get(`/api/admin/users/${ana.user.id}`).expect(200)).body.attributes).toEqual({ region: 'emea', dept: 'sales' });
    await admin.agent.patch(`/api/admin/users/${ana.user.id}`).set('x-csrf-token', admin.csrf).send({ attributes: { 'Bad Key': 'x' } }).expect(400);
    // A directory group on the user's identity link is a policy subject.
    const local = (await h.s.providers.list(h.tenantId)).find((p) => p.kind === 'local')!;
    await h.s.users.upsertIdentity(ana.user.id, local.id, ana.user.id, ['Finance Ops']);
    await dee.post('/api/apps/crm/policies', { name: 'Finance group', entity: 'deal', subjects: [{ kind: 'group', value: 'finance ops' }], rows: { field: 'region', op: 'eq', value: '$user.attributes.region' } }).expect(201);
    expect(titles((await ana.get('/api/apps/crm/entities/deal/records').expect(200)).body)).toEqual(['Contoso', 'Fabrikam']);
    expect((await ana.get(`/api/apps/crm/entities/deal/records/${emea1.id}`).expect(200)).body.hidden).toEqual([]);
  });
});
