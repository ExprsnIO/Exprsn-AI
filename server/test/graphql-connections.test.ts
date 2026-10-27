/*
 * 1.9.0: GraphQL as an API connection protocol, against an in-process fake GraphQL endpoint. The document classifier
 * (one query only, caps, fragments, introspection), typed variables from parameters, cursor paging over variables
 * with pageInfo, partial errors as warnings, an errors-only answer as a failure, mutations refused before anything is
 * sent, the schema helper, the connection test, and a knowledge source read through a GraphQL endpoint.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyGraphql, MAX_DEPTH } from '../src/connections/graphql.js';
import { graphqlVariables } from '../src/connections/rest.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';
import { client, drain, seedRetrieval } from './retrieval-seed.js';

const PEOPLE = Array.from({ length: 23 }, (_, i) => ({ id: String(i + 1), name: `Person ${i + 1}`, active: i % 2 === 0, score: i * 1.5 }));

class FakeGraphql {
  server!: Server;
  url = '';
  seen: { query: string; variables: Record<string, unknown>; auth: string | undefined }[] = [];

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
  private send(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    let raw = '';
    for await (const c of req) raw += String(c);
    if (req.method !== 'POST') return this.send(res, 405, { errors: [{ message: 'POST only' }] });
    const { query, variables } = JSON.parse(raw || '{}') as { query: string; variables?: Record<string, unknown> };
    const v = variables ?? {};
    this.seen.push({ query, variables: v, auth: req.headers.authorization });
    if (query.includes('__schema')) {
      const scalar = (name: string) => ({ kind: 'SCALAR', name, ofType: null });
      return this.send(res, 200, { data: { __schema: { queryType: { name: 'Query' }, types: [{ name: 'Query', kind: 'OBJECT', fields: [{ name: 'people', description: 'Everyone', args: [{ name: 'first', type: scalar('Int') }, { name: 'after', type: scalar('String') }, { name: 'active', type: scalar('Boolean') }], type: { kind: 'NON_NULL', name: null, ofType: { kind: 'OBJECT', name: 'PersonConnection', ofType: null } } }] }, { name: 'Person', kind: 'OBJECT', fields: [] }] } } });
    }
    if (/^\s*\{\s*__typename\s*\}\s*$/.test(query)) return this.send(res, 200, { data: { __typename: 'Query' } });
    if (query.includes('broken')) return this.send(res, 200, { data: null, errors: [{ message: 'Cannot query field "broken" on type "Query".' }] });
    if (query.includes('partial')) return this.send(res, 200, { data: { people: { nodes: PEOPLE.slice(0, 2) } }, errors: [{ message: 'score could not be computed for 1 person' }] });
    if (query.includes('people')) {
      const list = typeof v.active === 'boolean' ? PEOPLE.filter((p) => p.active === v.active) : PEOPLE;
      const from = typeof v.after === 'string' ? Number(Buffer.from(v.after, 'base64url').toString()) : 0;
      const first = typeof v.first === 'number' ? v.first : 10;
      const nodes = list.slice(from, from + first);
      const end = from + nodes.length;
      return this.send(res, 200, { data: { people: { nodes, pageInfo: { endCursor: Buffer.from(String(end)).toString('base64url'), hasNextPage: end < list.length } } } });
    }
    return this.send(res, 400, { errors: [{ message: 'Unknown query' }] });
  }
}

describe('the GraphQL classifier', () => {
  it('reads one query, refuses mutations, subscriptions, several operations, cycles, and documents past the caps', () => {
    expect(classifyGraphql('query People($first: Int = 10, $after: String) { people(first: $first, after: $after) { nodes { id ...P } pageInfo { endCursor } } } fragment P on Person { name }')).toMatchObject({ ok: true, operation: 'query', name: 'People', variables: ['first', 'after'] });
    expect(classifyGraphql('{ people { nodes { id } } }')).toMatchObject({ ok: true, operation: 'query' });
    expect(classifyGraphql('mutation { deletePerson(id: "1") { id } }')).toMatchObject({ ok: false, operation: 'mutation', problems: [expect.stringMatching(/mutation is refused/)] });
    expect(classifyGraphql('subscription { people { id } }').problems[0]).toMatch(/subscription is refused/);
    expect(classifyGraphql('query A { a } query B { b }').problems[0]).toMatch(/exactly one operation/);
    expect(classifyGraphql('query A { a } mutation B { b }').ok).toBe(false);
    expect(classifyGraphql('{ a { ...F } } fragment F on X { b { ...F } }').problems[0]).toMatch(/spreads itself/);
    expect(classifyGraphql('{ a { ...Missing } }').problems[0]).toMatch(/not defined/);
    const deep = '{ ' + Array.from({ length: MAX_DEPTH + 1 }, (_, i) => `f${i} {`).join(' ') + ' x ' + '}'.repeat(MAX_DEPTH + 1) + ' }';
    expect(classifyGraphql(deep).problems.join(' ')).toMatch(/deeper than 12/);
    expect(classifyGraphql('{ ' + Array.from({ length: 501 }, (_, i) => `f${i}`).join(' ') + ' }').problems.join(' ')).toMatch(/more than 500 fields/);
    expect(classifyGraphql('{ __schema { types { name } } }').problems[0]).toMatch(/Introspection/);
    expect(classifyGraphql('{ __schema { types { name } } }', { allowIntrospection: true }).ok).toBe(true);
    expect(classifyGraphql('{ a(s: "unterminated) }').problems[0]).toMatch(/could not be read/);
    // Strings, block strings and comments do not hide an operation keyword.
    expect(classifyGraphql('# mutation { x }\n{ a(s: "mutation { x }", t: """mutation""") }').ok).toBe(true);
  });

  it('fills variables from parameters: a lone placeholder keeps its type, literals stay as written', () => {
    expect(graphqlVariables({ active: '{active}', first: 5, q: 'name:{who}*', none: '{missing}', tags: ['a'] }, { active: false, who: 'Ann' })).toEqual({ active: false, first: 5, q: 'name:Ann*', tags: ['a'] });
  });
});

describe('GraphQL connections (1.9.0)', () => {
  let h: Harness;
  let api: FakeGraphql;

  beforeEach(async () => {
    api = await new FakeGraphql().start();
    h = await harness({ OLLAMA_POLL_MS: '600000', SERVICE_ALLOWED_HOSTS: '127.0.0.1' });
    await h.s.integrations.set(h.tenantId, { allowedHosts: ['127.0.0.1'] }, 'test');
  });
  afterEach(async () => {
    await h.close();
    await api.stop();
  });

  async function admin() {
    await localUser(h, 'gqladmin', ['connection-admin', 'tenant-admin', 'member'], 'confidential');
    const c = await loginAdmin(h, 'gqladmin');
    const send = (m: 'post' | 'patch', p: string, b: object = {}) => c.agent[m](p).set('x-csrf-token', c.csrf).send(b);
    return { post: (p: string, b?: object) => send('post', p, b), patch: (p: string, b?: object) => send('patch', p, b), get: (p: string) => c.agent.get(p) };
  }
  type Admin = Awaited<ReturnType<typeof admin>>;

  const PEOPLE_QUERY = 'query People($first: Int, $after: String, $active: Boolean) { people(first: $first, after: $after, active: $active) { nodes { id name active score } pageInfo { endCursor hasNextPage } } }';
  const PAGED = { path: '', params: [{ name: 'active', type: 'boolean' }], graphql: { query: PEOPLE_QUERY, variables: { active: '{active}' } }, paging: { kind: 'cursor', param: 'after', sizeParam: 'first', size: 10, next: '/data/people/pageInfo/endCursor', hasNext: '/data/people/pageInfo/hasNextPage' }, mapping: { items: '/data/people/nodes', fields: [{ name: 'id', path: 'id', type: 'number' }, { name: 'name', path: 'name' }, { name: 'active', path: 'active', type: 'boolean' }] } };

  async function connection(a: Admin) {
    return (await a.post('/api/admin/rest-connections', { name: 'people-gql', protocol: 'graphql', baseUrl: `${api.url}/graphql`, label: 'internal', auth: { kind: 'bearer', secret: 'gql-token' }, timeoutMs: 2000 }).expect(201)).body as { id: string; protocol: string };
  }

  it('reads pages over variables, binds typed parameters, and stops at hasNextPage', async () => {
    const a = await admin();
    const c = await connection(a);
    expect(c.protocol).toBe('graphql');
    await a.post(`/api/admin/rest-connections/${c.id}/endpoints`, { name: 'people', definition: PAGED }).expect(201);
    const all = (await a.post(`/api/rest-connections/${c.id}/endpoints/people/read`, {}).expect(200)).body;
    expect(all).toMatchObject({ truncated: false, pages: 3 });
    expect(all.rows).toHaveLength(23);
    expect(all.rows[1]).toEqual({ id: 2, name: 'Person 2', active: false });
    // The query text is sent as written; parameters and paging travel as variables, numbers as numbers.
    expect(new Set(api.seen.map((x) => x.query))).toEqual(new Set([PEOPLE_QUERY]));
    expect(api.seen.map((x) => x.variables)).toEqual([{ first: 10 }, { first: 10, after: Buffer.from('10').toString('base64url') }, { first: 10, after: Buffer.from('20').toString('base64url') }]);
    expect(api.seen.every((x) => x.auth === 'Bearer gql-token')).toBe(true);
    api.seen = [];
    const active = (await a.post(`/api/rest-connections/${c.id}/endpoints/people/read`, { params: { active: true }, limit: 5 }).expect(200)).body;
    expect(active.rows.every((r: { active: boolean }) => r.active)).toBe(true);
    expect(active.truncated).toBe(true);
    expect(api.seen[0]!.variables).toEqual({ first: 10, active: true });
    const more = (await a.post(`/api/rest-connections/${c.id}/endpoints/people/read`, { params: { active: true }, cursor: active.nextCursor }).expect(200)).body;
    expect(more.rows).toHaveLength(7);
    // A parameter of the wrong type is refused before anything is sent.
    api.seen = [];
    await a.post(`/api/rest-connections/${c.id}/endpoints/people/read`, { params: { active: 'maybe' } }).expect(400);
    expect(api.seen).toHaveLength(0);
    const audits = (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'connection.rest.read' }).select('detail')) as { detail: string }[];
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.every((x) => x.detail.includes('"protocol":"graphql"') && !x.detail.includes('gql-token') && !x.detail.includes('People('))).toBe(true);
  });

  it('refuses mutations, subscriptions and introspection at save and in a draft test, before anything is sent', async () => {
    const a = await admin();
    const c = await connection(a);
    api.seen = [];
    const mutation = { ...PAGED, graphql: { query: 'mutation { deletePerson(id: "1") { id } }', variables: {} }, paging: { kind: 'none' } };
    expect((await a.post(`/api/admin/rest-connections/${c.id}/endpoints`, { name: 'drop', definition: mutation }).expect(422)).body.detail).toMatch(/A mutation is refused: API connections only read/);
    expect((await a.post(`/api/admin/rest-connections/${c.id}/endpoints/_draft/test`, { definition: mutation }).expect(422)).body.detail).toMatch(/mutation is refused/);
    await a.post(`/api/admin/rest-connections/${c.id}/endpoints`, { name: 'subs', definition: { ...mutation, graphql: { query: 'subscription { people { id } }' } } }).expect(422);
    await a.post(`/api/admin/rest-connections/${c.id}/endpoints`, { name: 'intro', definition: { ...mutation, graphql: { query: '{ __schema { types { name } } }' } } }).expect(422);
    // Link paging is for REST; a GraphQL endpoint without its query is refused; a REST-shaped endpoint is too.
    await a.post(`/api/admin/rest-connections/${c.id}/endpoints`, { name: 'linked', definition: { ...PAGED, paging: { kind: 'link' } } }).expect(422);
    await a.post(`/api/admin/rest-connections/${c.id}/endpoints`, { name: 'plain', definition: { path: '/people', mapping: {} } }).expect(422);
    expect(api.seen.some((x) => /mutation|subscription|__schema/.test(x.query))).toBe(false);
    expect(api.seen).toHaveLength(0);
    // A stored definition that a later rule refuses is refused at read too.
    await a.post(`/api/admin/rest-connections/${c.id}/endpoints`, { name: 'people', definition: PAGED }).expect(201);
    await h.s.db('rest_endpoints').where({ connection_id: c.id, name: 'people' }).update({ definition: JSON.stringify({ ...PAGED, graphql: { query: 'mutation { x }', variables: {} } }) });
    await a.post(`/api/rest-connections/${c.id}/endpoints/people/read`, {}).expect(422);
    expect(api.seen).toHaveLength(0);
    // A GraphQL endpoint on a REST connection is refused.
    const rest = (await a.post('/api/admin/rest-connections', { name: 'plain-rest', baseUrl: `${api.url}/api`, label: 'internal' }).expect(201)).body;
    expect((await a.post(`/api/admin/rest-connections/${rest.id}/endpoints`, { name: 'gql', definition: PAGED }).expect(422)).body.detail).toMatch(/This is a REST connection/);
  });

  it('reads partial data with a warning, fails on errors without data, lists the schema, and tests the connection', async () => {
    const a = await admin();
    const c = await connection(a);
    await a.post(`/api/admin/rest-connections/${c.id}/endpoints`, { name: 'partial', definition: { path: '', graphql: { query: '{ partial: people { nodes { id name } } }' }, mapping: { items: '/data/people/nodes' } } }).expect(201);
    await a.post(`/api/admin/rest-connections/${c.id}/endpoints`, { name: 'broken', definition: { path: '', graphql: { query: '{ broken }' }, mapping: { items: '/data' } } }).expect(201);
    const partial = (await a.post(`/api/rest-connections/${c.id}/endpoints/partial/read`, {}).expect(200)).body;
    expect(partial.rows).toHaveLength(2);
    expect(partial.warnings).toEqual([expect.stringMatching(/1 error beside partial data: score could not be computed/)]);
    const broken = (await a.post(`/api/rest-connections/${c.id}/endpoints/broken/read`, {}).expect(502)).body;
    expect(broken).toMatchObject({ title: 'GraphQL error' });
    expect(broken.detail).toMatch(/Cannot query field "broken"/);
    const schema = (await a.get(`/api/admin/rest-connections/${c.id}/graphql/schema`).expect(200)).body;
    expect(schema).toEqual({ queryType: 'Query', fields: [{ name: 'people', description: 'Everyone', type: 'PersonConnection!', args: [{ name: 'first', type: 'Int' }, { name: 'after', type: 'String' }, { name: 'active', type: 'Boolean' }] }] });
    expect((await a.post(`/api/admin/rest-connections/${c.id}/test`).expect(200)).body).toMatchObject({ ok: true, status: 200, health: 'healthy', detail: expect.stringMatching(/with Query/) });
    expect(await h.s.db('audit_events').where({ action: 'connection.rest.graphql.schema' }).first()).toBeTruthy();
  });

  it('a knowledge source reads a GraphQL endpoint as it reads a REST one', async () => {
    const ollama = await new FakeOllama().start();
    try {
      await seedRetrieval(h, ollama);
      const a = await admin();
      const c = await connection(a);
      await a.post(`/api/admin/rest-connections/${c.id}/endpoints`, { name: 'people', definition: { ...PAGED, params: [] , graphql: { query: PEOPLE_QUERY, variables: {} } } }).expect(201);
      const curator = await client(h, 'cura', ['member', 'knowledge-curator'], 'confidential');
      const kb = (await curator.post('/api/knowledge/bases', { name: 'People', label: 'internal', embedModel: 'nomic-embed-text' }).expect(201)).body;
      await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 'rest', connectionId: c.id, resource: 'people', idField: 'id', titleField: 'name' }).expect(201);
      await drain(h);
      expect((await curator.get(`/api/knowledge/bases/${kb.id}`)).body.sources[0]).toMatchObject({ state: 'idle', documents: 23 });
      const hit = (await curator.post('/api/knowledge/search', { kbIds: [kb.id], query: 'Person 17', rerank: false })).body.hits[0];
      expect(hit.text).toContain('name: Person 17');
    } finally {
      await ollama.stop();
    }
  });
});
