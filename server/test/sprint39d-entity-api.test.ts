import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupApp, titles, type AppFixture } from './sprint39d-helpers.js';

/*
 * 1.6.0, Sprint 39d (B-8601): the entity API at /api/apps/:app/:entity. List with filters, sorting, paging and related
 * records; read, create, update, transition and delete; policies and masks as everywhere; keys limited to one app or
 * one entity, read-only or not, refused beyond their scope.
 */
describe('B-8601: the entity API', () => {
  let f: AppFixture;
  beforeEach(async () => {
    f = await setupApp();
  });
  afterEach(async () => {
    await f.h.close();
  });

  it('lists with where, filter, sort, paging and related records; reads, creates, updates, transitions and deletes', async () => {
    const { dee, contoso, emea1 } = f;
    const page = (await dee.get('/api/apps/crm/deal?where=region:eq:emea&sort=amount:desc&limit=1').expect(200)).body as { total: number; nextCursor: string | null; records: { values: { title: string } }[] };
    expect(page.total).toBe(2);
    expect(page.records.map((r) => r.values.title)).toEqual(['Fabrikam']);
    const next = (await dee.get(`/api/apps/crm/deal?where=region:eq:emea&sort=amount:desc&limit=1&cursor=${encodeURIComponent(page.nextCursor!)}`).expect(200)).body as { records: { values: { title: string } }[] };
    expect(next.records.map((r) => r.values.title)).toEqual(['Contoso']);
    // Several conditions combine with and; a JSON filter works too; in takes a list.
    expect(titles((await dee.get('/api/apps/crm/deal?where=region:eq:emea&where=amount:gte:200').expect(200)).body)).toEqual(['Fabrikam']);
    expect(titles((await dee.get(`/api/apps/crm/deal?filter=${encodeURIComponent(JSON.stringify({ field: 'region', op: 'in', value: ['apac'] }))}`).expect(200)).body)).toEqual(['Tailspin']);
    expect(titles((await dee.get('/api/apps/crm/deal?where=title:in:Contoso,Tailspin').expect(200)).body)).toEqual(['Contoso', 'Tailspin']);
    expect((await dee.get('/api/apps/crm/deal?where=region=emea').expect(400)).body.detail).toMatch(/field:op:value/);
    // Related records: the reference field's target, as the reader may read it.
    const related = (await dee.get('/api/apps/crm/deal?where=title:eq:Contoso&include=related').expect(200)).body as { records: { related: Record<string, { values: { name: string } } | null> }[] };
    expect(related.records[0]!.related.company?.values.name).toBe('Contoso Ltd');
    const one = (await dee.get(`/api/apps/crm/deal/${emea1.id}?include=related`).expect(200)).body as { id: string; related: Record<string, { id: string } | null> };
    expect(one.related.company?.id).toBe(contoso.id);
    // Create, update with the version, transition, delete.
    const created = (await dee.post('/api/apps/crm/deal', { values: { title: 'Northwind', amount: 10, region: 'emea' } }).expect(201)).body as { id: string; version: number; state: string };
    expect(created.state).toBe('open');
    const updated = (await dee.patch(`/api/apps/crm/deal/${created.id}`, { values: { amount: 20 }, version: created.version }).expect(200)).body as { version: number; values: { amount: number } };
    expect(updated.values.amount).toBe(20);
    await dee.patch(`/api/apps/crm/deal/${created.id}`, { values: { amount: 30 }, version: created.version }).expect(409);
    expect((await dee.post(`/api/apps/crm/deal/${created.id}/transition`, { to: 'won' }).expect(200)).body.state).toBe('won');
    await dee.del(`/api/apps/crm/deal/${created.id}`).expect(204);
    await dee.get(`/api/apps/crm/deal/${created.id}`).expect(404);
    // The app's own segments are not entities, and an unknown one is 404.
    await dee.get('/api/apps/crm/nope').expect(404);
    expect((await dee.get('/api/apps/crm/forms').expect(200)).body.forms).toEqual([]);
  });

  it('policies narrow the rows and mask the fields on the entity API as on the records routes', async () => {
    const { dee, member } = f;
    await dee.post('/api/apps/crm/policies', { name: 'Own region', entity: 'deal', subjects: [{ kind: 'role', value: 'member' }], rows: { field: 'region', op: 'eq', value: '$user.attributes.region' }, fields: { ssn: { read: true, unmasked: false, mask: 'last4' }, notes: { read: false } } }).expect(201);
    const ana = await member('ana', { region: 'emea' });
    const list = (await ana.get('/api/apps/crm/deal').expect(200)).body as { records: { values: Record<string, unknown>; masked: Record<string, string>; hidden: string[] }[] };
    expect(list.records.map((r) => r.values.title).sort()).toEqual(['Contoso', 'Fabrikam']);
    const contoso = list.records.find((r) => r.values.title === 'Contoso')!;
    expect(contoso.values.ssn).toBe('***-**-6789');
    expect(contoso.masked).toEqual({ ssn: 'last4' });
    expect(contoso.hidden).toEqual(['notes']);
    await ana.get(`/api/apps/crm/deal/${f.apac.id}`).expect(404);
    const cat = await member('cat');
    expect((await cat.get('/api/apps/crm/deal').expect(200)).body.records).toEqual([]);
  });

  it('a key limited to one entity, read-only, lists its rows with masks and is refused on writes, other entities, other apps and the rest of the API', async () => {
    const { dee, bearer, h, wsId } = f;
    await dee.post('/api/apps', { name: 'hr', title: 'HR', label: 'internal', workspaceId: wsId }).expect(201);
    await dee.post('/api/apps/hr/entities', { name: 'leave', title: 'Leave', label: 'internal', definition: { fields: [{ name: 'who', type: 'string', required: true, maxLength: 50 }] } }).expect(201);
    await dee.post('/api/apps/crm/policies', { name: 'Everyone masked', entity: 'deal', subjects: [{ kind: 'everyone' }], fields: { ssn: { read: true, unmasked: false, mask: 'last4' } } }).expect(201);
    // Beyond records:* is refused; a design scope on an app key makes no sense.
    expect((await dee.post('/api/me/api-keys', { name: 'bad', scopes: ['records:read', 'apps:design'], ttlDays: 30, app: { app: 'crm', entity: 'deal' } }).expect(400)).body.detail).toMatch(/records:read and records:write only/);
    await dee.post('/api/me/api-keys', { name: 'bad', scopes: ['records:read'], ttlDays: 30, app: { app: 'nope' } }).expect(404);
    const made = (await dee.post('/api/me/api-keys', { name: 'deal reader', scopes: ['records:read'], ttlDays: 30, app: { app: 'crm', entity: 'deal' } }).expect(201)).body as { key: string; appScope: { app: string; entity: string } };
    expect(made.appScope.entity).toBeTruthy();
    const listed = (await dee.get('/api/me/api-keys').expect(200)).body as { name: string; appScope: unknown }[];
    expect(listed.find((k) => k.name === 'deal reader')?.appScope).toEqual(made.appScope);
    const k = bearer(made.key);
    const page = (await k.get('/api/apps/crm/deal').expect(200)).body as { records: { values: Record<string, unknown> }[] };
    expect(page.records).toHaveLength(3);
    // The designer is not subject to policies on the screen, but a key narrows to records:read, so the mask applies? No:
    // policies exempt holders of apps:design, and the key's scopes leave apps:design out, so the owner reads masked.
    expect(page.records.find((r) => r.values.title === 'Contoso')!.values.ssn).toBe('***-**-6789');
    expect((await k.post('/api/apps/crm/deal', { values: { title: 'X' } }).expect(403)).body.step).toBe('scope');
    expect((await k.get('/api/apps/crm/company').expect(403)).body.detail).toMatch(/limited to the entity deal/);
    expect((await k.get('/api/apps/crm/entities/company/records').expect(403)).body.detail).toMatch(/limited to the entity deal/);
    await k.get('/api/apps/crm/entities/deal/records').expect(200);
    expect((await k.get('/api/apps/hr/leave').expect(403)).body.detail).toMatch(/limited to the app crm/);
    expect((await k.get('/api/apps').expect(403)).body.detail).toMatch(/cannot list or create apps/);
    expect((await k.get('/api/me').expect(403)).body.detail).toMatch(/accepted under \/api\/apps only/);
    // An entity-scoped key reaches that entity's records and nothing else of the app, the API document included.
    await k.get('/api/apps/crm/openapi.json').expect(403);
    // A key for the whole app, with writes, reaches every entity of it and writes; not another app.
    const whole = (await dee.post('/api/me/api-keys', { name: 'crm writer', scopes: ['records:read', 'records:write'], ttlDays: 30, app: { app: 'crm' } }).expect(201)).body as { key: string };
    const w = bearer(whole.key);
    await w.get('/api/apps/crm/company').expect(200);
    await w.get('/api/apps/crm/openapi.json').expect(200);
    const c = (await w.post('/api/apps/crm/deal', { values: { title: 'ByKey', region: 'apac' } }).expect(201)).body as { id: string };
    await w.del(`/api/apps/crm/deal/${c.id}`).expect(204);
    await w.get('/api/apps/hr/leave').expect(403);
    expect(((await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'apikey.created' }).select('target')) as { target: string }[]).some((d) => String(d.target).includes('appScope'))).toBe(true);
  });
});
