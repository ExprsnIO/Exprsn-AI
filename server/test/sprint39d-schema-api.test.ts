import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loopbackServerFor } from './loopback.js';
import { setupApp, type AppFixture } from './sprint39d-helpers.js';

/*
 * 1.6.0, Sprint 39d (B-8602, B-8603): every design change leaves a schema version; the schema API adds, changes and
 * removes entities, fields, state machines and forms; the OpenAPI document and the generated client follow the schema,
 * and the client creates a record against a fresh app with nothing hand-written.
 */
describe('B-8602, B-8603: the schema API, OpenAPI and the client', () => {
  let f: AppFixture;
  beforeEach(async () => {
    f = await setupApp();
  });
  afterEach(async () => {
    await f.h.close();
  });

  it('records a version for every design change, whichever route made it, and the schema API changes the design', async () => {
    const { dee, h } = f;
    const before = (await dee.get('/api/apps/crm/schema').expect(200)).body as { version: number; hash: string; entities: { name: string }[]; forms: unknown[] };
    expect(before.version).toBe(2); // company, deal
    expect(before.entities.map((e) => e.name)).toEqual(['company', 'deal']);
    const versions = (await dee.get('/api/apps/crm/schema/versions').expect(200)).body.versions as { version: number; kind: string; target: string; source: string }[];
    expect(versions.map((v) => [v.version, v.kind, v.target, v.source])).toEqual([[2, 'entity.created', 'deal', 'api'], [1, 'entity.created', 'company', 'api']]);

    // A field through the schema API: shows in the app, bumps the version, the version row names it.
    const added = (await dee.post('/api/apps/crm/schema/entities/deal/fields', { field: { name: 'owner', type: 'string', maxLength: 60, indexed: true } }).expect(201)).body as { definition: { fields: { name: string }[] }; schema: { version: number; hash: string } };
    expect(added.definition.fields.map((x) => x.name)).toContain('owner');
    expect(added.schema.version).toBe(3);
    expect(added.schema.hash).not.toBe(before.hash);
    const app = (await dee.get('/api/apps/crm').expect(200)).body as { entities: { name: string; definition: { fields: { name: string }[] } }[] };
    expect(app.entities.find((e) => e.name === 'deal')!.definition.fields.some((x) => x.name === 'owner')).toBe(true);
    const v3 = (await dee.get('/api/apps/crm/schema/versions/3').expect(200)).body as { kind: string; summary: string; source: string; change: { field: { name: string } } };
    expect(v3.kind).toBe('field.added');
    expect(v3.source).toBe('schema-api');
    expect(v3.change.field.name).toBe('owner');
    await dee.post('/api/apps/crm/schema/entities/deal/fields', { field: { name: 'owner', type: 'string', maxLength: 60 } }).expect(409);
    await dee.post('/api/apps/crm/schema/entities/deal/fields', { field: { name: 'id', type: 'string', maxLength: 60 } }).expect(400);
    // Change and remove a field; set and remove the state machine.
    expect((await dee.patch('/api/apps/crm/schema/entities/deal/fields/owner', { patch: { maxLength: 80, title: 'Owner' } }).expect(200)).body.schema.version).toBe(4);
    await dee.patch('/api/apps/crm/schema/entities/deal/fields/owner', { patch: { type: 'number' } }).expect(200); // the type stays
    expect((await dee.get('/api/apps/crm/schema/versions/4').expect(200)).body.kind).toBe('field.updated');
    expect((await dee.del('/api/apps/crm/schema/entities/deal/fields/owner').expect(200)).body.definition.fields.some((x: { name: string }) => x.name === 'owner')).toBe(false);
    await dee.del('/api/apps/crm/schema/entities/deal/fields/owner').expect(404);
    const states = (await dee.put('/api/apps/crm/schema/entities/company/states', { states: { initial: 'new', states: [{ name: 'new' }, { name: 'active' }], transitions: [{ from: ['new'], to: 'active' }] } }).expect(200)).body as { definition: { states: { initial: string } }; schema: { version: number } };
    expect(states.definition.states.initial).toBe('new');
    expect((await dee.get(`/api/apps/crm/schema/versions/${states.schema.version}`).expect(200)).body.kind).toBe('states.set');
    await dee.put('/api/apps/crm/schema/entities/company/states', { states: null }).expect(200);
    // Create and replace an entity; create and replace a form; delete both.
    await dee.put('/api/apps/crm/schema/entities/contact', { title: 'Contact', definition: { fields: [{ name: 'email', type: 'string', maxLength: 200, required: true }] } }).expect(201);
    await dee.put('/api/apps/crm/schema/entities/contact', { definition: { fields: [{ name: 'email', type: 'string', maxLength: 200, required: true }, { name: 'phone', type: 'string', maxLength: 40 }] } }).expect(200);
    await dee.put('/api/apps/crm/schema/forms/intake', { entity: 'contact', definition: { fields: [{ field: 'email' }] } }).expect(201);
    await dee.put('/api/apps/crm/schema/forms/intake', { title: 'Intake', entity: 'contact', definition: { fields: [{ field: 'email' }, { field: 'phone' }] } }).expect(200);
    await dee.del('/api/apps/crm/schema/forms/intake').expect(204);
    await dee.del('/api/apps/crm/schema/entities/contact').expect(204);
    const after = (await dee.get('/api/apps/crm/schema/versions').expect(200)).body.versions as { kind: string; target: string }[];
    expect(after.slice(0, 6).map((v) => `${v.kind}:${v.target}`)).toEqual(['entity.deleted:contact', 'form.deleted:intake', 'form.updated:intake', 'form.created:intake', 'field.added:contact', 'entity.created:contact']);
    // The audit chain carries each version.
    const audited = (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'app.schema.versioned' }).count({ n: '*' })) as { n: number | string }[];
    expect(Number(audited[0]!.n)).toBe(after.length);
    // A member cannot read the schema; a stale rev is refused.
    const ana = await f.member('ana');
    await ana.get('/api/apps/crm/schema').expect(403);
    await dee.post('/api/apps/crm/schema/entities/deal/fields', { field: { name: 'late', type: 'boolean' }, rev: 1 }).expect(409);
  });

  it('the OpenAPI document and the client follow the schema, and the client creates a record with nothing hand-written', async () => {
    const { dee, h, wsId } = f;
    const doc = (await dee.get('/api/apps/crm/openapi.json').expect(200)).body as { openapi: string; info: { version: string; 'x-exprsn-schema-hash': string }; paths: Record<string, Record<string, { operationId: string; requestBody?: { content: { 'application/json': { schema: { properties: { to?: { enum: string[] } } } } } } }>>; components: { schemas: Record<string, unknown> } };
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.version).toBe('2');
    expect(Object.keys(doc.paths).sort()).toEqual(['/api/apps/crm/company', '/api/apps/crm/company/{id}', '/api/apps/crm/deal', '/api/apps/crm/deal/{id}', '/api/apps/crm/deal/{id}/transition']);
    expect(doc.paths['/api/apps/crm/deal']!.get!.operationId).toBe('list_deal');
    expect(doc.paths['/api/apps/crm/deal/{id}/transition']!.post!.requestBody!.content['application/json'].schema.properties.to!.enum).toEqual(['open', 'won', 'lost']);
    expect(Object.keys(doc.components.schemas)).toEqual(expect.arrayContaining(['Deal', 'DealInput', 'DealValues', 'DealPage', 'Company']));
    const etag = String((await dee.get('/api/apps/crm/openapi.json').expect(200)).headers.etag);
    expect(etag).toBe(`"${doc.info['x-exprsn-schema-hash']}"`);
    await dee.agent.get('/api/apps/crm/openapi.json').set('if-none-match', etag).expect(304);
    // A schema change changes the document at once.
    await dee.post('/api/apps/crm/schema/entities/deal/fields', { field: { name: 'owner', type: 'string', maxLength: 60 } }).expect(201);
    const doc2 = (await dee.get('/api/apps/crm/openapi.json').expect(200)).body as typeof doc;
    expect(doc2.info.version).toBe('3');
    expect((doc2.components.schemas.DealValues as { properties: Record<string, unknown> }).properties.owner).toBeTruthy();
    // The typed client names the entities; the JavaScript one runs.
    const ts = (await dee.get('/api/apps/crm/client.ts').expect(200)).text;
    expect(ts).toContain('export interface DealValues');
    expect(ts).toContain('state: string | null');
    expect(ts).toContain('schemaVersion: 3');
    const js = (await dee.get('/api/apps/crm/client.js').expect(200)).text;
    expect(js).not.toContain(': ClientOptions');
    const dir = mkdtempSync(path.join(tmpdir(), 'exai-client-'));
    const file = path.join(dir, 'client.mjs');
    writeFileSync(file, js);
    const mod = (await import(pathToFileURL(file).href)) as { createClient: (o: { baseUrl: string; token: string; workspace?: string }) => Record<string, { list: (q?: unknown) => Promise<{ total: number; records: { id: string; values: Record<string, unknown> }[] }>; create: (v: Record<string, unknown>) => Promise<{ id: string; values: Record<string, unknown> }>; get: (id: string, include?: string) => Promise<{ id: string; related?: Record<string, unknown> }>; update: (id: string, v: Record<string, unknown>, version?: number) => Promise<{ version: number }>; delete: (id: string) => Promise<void> }> & { schemaVersion: number } };
    const port = (loopbackServerFor(h.app)!.address() as AddressInfo).port;
    const plain = (await h.s.apiKeys.create({ tenantId: h.tenantId, userId: dee.user.id, name: 'client', scopes: ['records:read', 'records:write'], ttlDays: 1 })).key;
    const c = mod.createClient({ baseUrl: `http://127.0.0.1:${port}`, token: plain, workspace: wsId });
    expect(c.schemaVersion).toBe(3);
    const made = await c.deal!.create({ title: 'Via client', amount: 5, region: 'emea', owner: 'dee' });
    expect(made.values.title).toBe('Via client');
    const page = await c.deal!.list({ where: ['title:eq:Via client'] });
    expect(page.total).toBe(1);
    expect((await c.deal!.update(made.id, { amount: 6 })).version).toBe(2);
    await c.deal!.delete(made.id);
    expect((await c.deal!.list({ where: ['title:eq:Via client'] })).total).toBe(0);
    await expect(c.deal!.get('00000000000000000000000000')).rejects.toMatchObject({ status: 404 });
  });
});
