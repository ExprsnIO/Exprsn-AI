/*
 * 1.9.0: OpenAPI import for REST connections. An OpenAPI 3.0 document (JSON, fetched by URL) and a Swagger 2.0
 * document (YAML, pasted) are read: GET operations only (the others listed with the reason), path and query
 * parameters typed and renamed to {snake_case}, credentials and header parameters left out, a paging guess from the
 * query parameters and the response, a mapping guess from the 200 schema through `$ref`, operations outside the
 * base URL not importable. Importing makes ordinary endpoints (every check of `saveEndpoint`), readable at once.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseOpenApiText, readOpenApi, snake } from '../src/connections/openapi.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';

const PETS = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, name: `Pet ${i + 1}`, born: `2025-0${(i % 9) + 1}-01`, tags: ['a'] }));

const openapi3 = (server: string) => ({
  openapi: '3.0.3',
  info: { title: 'Pet store', version: '2.1.0' },
  servers: [{ url: `${server}/{base}`, variables: { base: { default: 'api/v2' } } }],
  components: {
    securitySchemes: { key: { type: 'apiKey', in: 'query', name: 'access_key' } },
    parameters: { Limit: { name: 'limit', in: 'query', schema: { type: 'integer', default: 3 } } },
    schemas: {
      Pet: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, born: { type: 'string', format: 'date' }, tags: { type: 'array', items: { type: 'string' } } } },
      PetPage: { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Pet' } }, meta: { type: 'object', properties: { nextCursor: { type: 'string' } } } } }
    }
  },
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        summary: 'List pets',
        parameters: [
          { $ref: '#/components/parameters/Limit' },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
          { name: 'species', in: 'query', schema: { type: 'string', enum: ['cat', 'dog'] } },
          { name: 'access_key', in: 'query', schema: { type: 'string' } },
          { name: 'X-Request-Id', in: 'header', schema: { type: 'string' } }
        ],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/PetPage' } } } } }
      },
      post: { operationId: 'createPet', responses: { '201': { description: 'created' } } }
    },
    '/pets/{petId}': {
      parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'integer' } }],
      get: { operationId: 'getPet', responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } } },
      delete: { operationId: 'deletePet', responses: { '204': { description: 'gone' } } }
    },
    '/elsewhere': { get: { operationId: 'elsewhere', servers: [{ url: 'https://other.example.com' }], responses: { '200': { description: 'ok' } } } }
  }
});

const swagger2 = (host: string) => `swagger: "2.0"
info:
  title: Legacy
  version: "1"
host: ${host}
basePath: /api/v2
schemes: [http]
paths:
  /owners:
    get:
      operationId: list_owners
      parameters:
        - { name: page, in: query, type: integer }
        - { name: per_page, in: query, type: integer }
        - { name: since, in: query, type: string, format: date-time }
      responses:
        "200":
          description: ok
          schema:
            type: array
            items:
              $ref: "#/definitions/Owner"
definitions:
  Owner:
    type: object
    properties:
      id: { type: integer }
      full_name: { type: string }
`;

class FakeApi {
  server!: Server;
  url = '';
  seen: { path: string; query: Record<string, string> }[] = [];
  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }
  private send(res: ServerResponse, status: number, body: unknown, type = 'application/json') {
    res.writeHead(status, { 'content-type': type });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  }
  private handle(req: IncomingMessage, res: ServerResponse) {
    const u = new URL(req.url ?? '/', this.url);
    const q = Object.fromEntries(u.searchParams);
    this.seen.push({ path: u.pathname, query: q });
    if (u.pathname === '/openapi.json') return this.send(res, 200, openapi3(this.url));
    if (u.pathname === '/api/v2/pets') {
      const from = q.cursor ? Number(q.cursor) : 0;
      const n = Number(q.limit ?? 3);
      const page = PETS.filter(() => !q.species || q.species === 'cat').slice(from, from + n);
      return this.send(res, 200, { data: page, meta: { nextCursor: from + n < PETS.length ? String(from + n) : null } });
    }
    const m = /^\/api\/v2\/pets\/(\d+)$/.exec(u.pathname);
    if (m) return this.send(res, 200, PETS[Number(m[1]) - 1] ?? {});
    if (u.pathname === '/api/v2/owners') return this.send(res, 200, Number(q.page ?? 1) === 1 ? [{ id: 1, full_name: 'Ana' }] : []);
    return this.send(res, 404, { error: 'no route' });
  }
}

describe('OpenAPI reading', () => {
  it('reads GET operations with typed parameters, paging and mapping guesses', () => {
    const meta = readOpenApi(parseOpenApiText(JSON.stringify(openapi3('http://127.0.0.1:1'))), 'http://127.0.0.1:1/api/v2', null);
    const byId = Object.fromEntries(meta.operations.map((o) => [o.operationId, o]));
    expect(meta).toMatchObject({ specVersion: '3.0.3', title: 'Pet store', servers: ['http://127.0.0.1:1/api/v2'] });
    expect(byId.createPet).toMatchObject({ importable: false, reason: expect.stringMatching(/only GET/) });
    expect(byId.deletePet!.importable).toBe(false);
    expect(byId.elsewhere).toMatchObject({ importable: false, reason: expect.stringMatching(/not under the connection's base URL/) });
    const list = byId.listPets!;
    expect(list).toMatchObject({ importable: true, name: 'list-pets', endpointPath: '/pets', paging: { kind: 'cursor', param: 'cursor', next: '/meta/nextCursor', sizeParam: 'limit', size: 3 }, mapping: { items: '/data' } });
    expect(list.params).toEqual([{ name: 'species', param: 'species', in: 'query', type: 'string', required: false, enum: ['cat', 'dog'] }]);
    expect(list.mapping.fields).toEqual([{ name: 'id', path: '/id', type: 'number' }, { name: 'name', path: '/name', type: 'string' }, { name: 'born', path: '/born', type: 'date' }, { name: 'tags', path: '/tags', type: 'json' }]);
    expect(list.notes.join(' ')).toMatch(/access_key looks like a credential.*header parameter X-Request-Id is not offered/);
    expect(byId.getPet).toMatchObject({ importable: true, endpointPath: '/pets/{pet_id}', params: [{ name: 'petId', param: 'pet_id', in: 'path', type: 'number', required: true }], mapping: { items: '' } });
    expect(snake('X-Request-Id')).toBe('x_request_id');
    expect(() => parseOpenApiText('{"openapi":"2.5","paths":{}}')).toThrow(/2\.5 is not read/);
    expect(() => parseOpenApiText('just: yaml')).toThrow(/neither OpenAPI 3/);
  });
});

describe('OpenAPI import', () => {
  let h: Harness;
  let api: FakeApi;

  beforeEach(async () => {
    api = await new FakeApi().start();
    h = await harness({ OLLAMA_POLL_MS: '600000', SERVICE_ALLOWED_HOSTS: '127.0.0.1' });
    await h.s.integrations.set(h.tenantId, { allowedHosts: ['127.0.0.1'] }, 'test');
  });
  afterEach(async () => {
    await h.close();
    await api.stop();
  });

  async function admin() {
    await localUser(h, 'oaadmin', ['connection-admin', 'tenant-admin', 'member'], 'confidential');
    const c = await loginAdmin(h, 'oaadmin');
    const send = (m: 'post', p: string, b: object = {}) => c.agent[m](p).set('x-csrf-token', c.csrf).send(b);
    return { post: (p: string, b?: object) => send('post', p, b), get: (p: string) => c.agent.get(p) };
  }

  it('imports GET operations by URL as endpoints that read at once; refuses the rest', async () => {
    const a = await admin();
    const conn = (await a.post('/api/admin/rest-connections', { name: 'pets', baseUrl: `${api.url}/api/v2`, label: 'internal' }).expect(201)).body;
    const read = (await a.post(`/api/admin/rest-connections/${conn.id}/openapi`, { url: `${api.url}/openapi.json` }).expect(200)).body;
    expect(read.operations.filter((o: { importable: boolean }) => o.importable).map((o: { operationId: string }) => o.operationId)).toEqual(['listPets', 'getPet']);
    expect(read.connection.openapi).toMatchObject({ url: `${api.url}/openapi.json`, title: 'Pet store' });
    const imp = (await a.post(`/api/admin/rest-connections/${conn.id}/openapi/import`, { operations: [{ operationId: 'listPets' }, { operationId: 'getPet', name: 'pet' }, { operationId: 'createPet' }, { operationId: 'nope' }] }).expect(200)).body;
    expect(imp.created).toEqual([{ operationId: 'listPets', endpoint: 'list-pets' }, { operationId: 'getPet', endpoint: 'pet' }]);
    expect(imp.refused.map((r: { operationId: string }) => r.operationId)).toEqual(['createPet', 'nope']);
    expect(imp.connection.endpoints.map((e: { name: string }) => e.name)).toEqual(['list-pets', 'pet']);

    const all = (await a.post(`/api/rest-connections/${conn.id}/endpoints/list-pets/read`, { params: { species: 'cat' } }).expect(200)).body;
    expect(all.rows.map((r: { id: number }) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(all.columns.map((c: { name: string }) => c.name)).toEqual(['id', 'name', 'born', 'tags']);
    // The page size is the size parameter's documented default (3); the cursor comes from meta.nextCursor.
    expect(api.seen.filter((x) => x.path === '/api/v2/pets').map((x) => x.query)).toEqual([{ species: 'cat', limit: '3' }, { species: 'cat', cursor: '3', limit: '3' }, { species: 'cat', cursor: '6', limit: '3' }]);
    expect((await a.post(`/api/rest-connections/${conn.id}/endpoints/pet/read`, { params: { pet_id: 2 } }).expect(200)).body.rows).toEqual([{ id: 2, name: 'Pet 2', born: '2025-02-01T00:00:00.000Z', tags: ['a'] }]);
    // Importing again makes new names rather than replacing what exists.
    const again = (await a.post(`/api/admin/rest-connections/${conn.id}/openapi/import`, { operations: [{ operationId: 'listPets' }] }).expect(200)).body;
    expect(again.created).toEqual([{ operationId: 'listPets', endpoint: 'list-pets-2' }]);
    const audits = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).whereIn('action', ['connection.rest.openapi.read', 'connection.rest.openapi.imported']).select('action')) as { action: string }[];
    expect(audits.map((x) => x.action)).toEqual(expect.arrayContaining(['connection.rest.openapi.read', 'connection.rest.openapi.imported']));
  });

  it('reads a pasted Swagger 2.0 YAML document; refuses hosts off the list and non-REST connections', async () => {
    const a = await admin();
    const conn = (await a.post('/api/admin/rest-connections', { name: 'legacy', baseUrl: `${api.url}/api/v2`, label: 'internal' }).expect(201)).body;
    const host = new URL(api.url).host;
    const read = (await a.post(`/api/admin/rest-connections/${conn.id}/openapi`, { document: swagger2(host) }).expect(200)).body;
    expect(read.specVersion).toBe('2.0');
    const op = read.operations[0];
    expect(op).toMatchObject({ operationId: 'list_owners', name: 'list_owners', importable: true, paging: { kind: 'page', param: 'page', sizeParam: 'per_page' }, mapping: { items: '', fields: [{ name: 'id', path: '/id', type: 'number' }, { name: 'full_name', path: '/full_name', type: 'string' }] } });
    expect(op.params).toEqual([{ name: 'since', param: 'since', in: 'query', type: 'date', required: false }]);
    const imp = (await a.post(`/api/admin/rest-connections/${conn.id}/openapi/import`, { operations: [{ operationId: 'list_owners' }] }).expect(200)).body;
    expect(imp.created).toHaveLength(1);
    expect((await a.post(`/api/rest-connections/${conn.id}/endpoints/list_owners/read`, {}).expect(200)).body.rows).toEqual([{ id: 1, full_name: 'Ana' }]);
    expect((await a.post(`/api/admin/rest-connections/${conn.id}/openapi`, { url: 'https://specs.example.com/openapi.json' }).expect(422)).body.detail).toMatch(/specs\.example\.com is not on this tenant's list/);
    await a.post(`/api/admin/rest-connections/${conn.id}/openapi`, { url: `${api.url}/openapi.json`, document: '{}' }).expect(400);
    expect((await a.post(`/api/admin/rest-connections/${conn.id}/openapi`, { document: 'openapi: "3.0.0"\npaths: [' }).expect(422)).body.title).toBe('OpenAPI refused');
  });
});
