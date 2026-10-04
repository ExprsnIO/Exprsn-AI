import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';
import { listRoutes, OPENAPI_FILE, recordMounts } from './openapi-routes.js';

// Before any app is built: Express 5 does not keep the paths routers are mounted at.
recordMounts();

type Op = { summary?: string; requestBody?: unknown; responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>; 'x-exprsn-since'?: string };
type Doc = { openapi: string; paths: Record<string, Record<string, Op>>; components: { schemas: Record<string, unknown> } };
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];

/**
 * B-2104: docs/openapi.json covers every route the app registers, and lists none it does not. Operations added in
 * 1.4.0 are described in full, and what the server answers matches what the document says.
 */
describe('OpenAPI document (B-2104)', () => {
  let h: Harness;
  const doc = JSON.parse(readFileSync(OPENAPI_FILE, 'utf8')) as Doc;
  const ops = Object.entries(doc.paths).flatMap(([p, item]) => Object.entries(item).filter(([m]) => METHODS.includes(m)).map(([m, op]) => ({ key: `${m} ${p}`, op })));

  beforeAll(async () => {
    h = await harness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('documents every registered route and no route that is gone', () => {
    const routes = listRoutes(h.app).map((r) => `${r.method} ${r.path}`);
    expect(routes.length).toBeGreaterThan(500);
    const documented = new Set(ops.map((o) => o.key));
    const missing = routes.filter((r) => !documented.has(r));
    expect(missing, 'routes missing from docs/openapi.json (npx tsx server/test/openapi-routes.ts --write)').toEqual([]);
    const registered = new Set(routes);
    expect(ops.map((o) => o.key).filter((k) => !registered.has(k)), 'operations in docs/openapi.json the app no longer registers').toEqual([]);
  });

  it('describes the 1.4.0 operations in full, with references that resolve', () => {
    expect(doc.openapi).toBe('3.1.0');
    const recent = ops.filter((o) => o.op['x-exprsn-since'] === '1.4.0');
    expect(recent.map((o) => o.key)).toEqual(expect.arrayContaining(['get /api/events/catalogue', 'post /api/admin/plugins', 'put /api/admin/plugins/{id}/grants']));
    for (const { key, op } of recent) {
      expect(op.summary && op.summary !== 'See docs/api.md', key).toBeTruthy();
      const ok = Object.entries(op.responses ?? {}).filter(([code]) => /^2/.test(code));
      expect(ok.length, key).toBeGreaterThan(0);
      if (ok.every(([code]) => code !== '204')) expect(ok.some(([, r]) => r.content?.['application/json']?.schema), key).toBe(true);
      if (/^(post|put) /.test(key) && !/\/(enable|disable)$/.test(key)) expect(op.requestBody, key).toBeTruthy();
    }
    const refs = [...JSON.stringify(doc).matchAll(/"\$ref":"#\/components\/(schemas|responses)\/([^"]+)"/g)];
    for (const [, kind, name] of refs) expect((doc.components as Record<string, Record<string, unknown>>)[kind!]![name!], `${kind}/${name}`).toBeDefined();
  });

  it('matches what the server answers for the plugin routes', async () => {
    // References are to `#/components/...`: each schema is compiled inside a root that carries the components.
    const ajv = new Ajv2020({ strict: false });
    const compile = (schema: unknown) => ajv.compile({ components: doc.components, ...(schema as object) });
    const plugin = compile({ $ref: '#/components/schemas/Plugin' });
    await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    const a = await loginAdmin(h, 'ta');
    const manifest = { key: 'audit-mirror', name: 'Audit mirror', version: '0.1.0', kind: 'declarative', events: ['user.*'], capabilities: ['read:events', 'emit:log'], actions: [{ type: 'log', on: 'user.created' }] };
    const created = (await a.agent.post('/api/admin/plugins').set('x-csrf-token', a.csrf).send({ manifest }).expect(201)).body;
    expect(plugin(created), JSON.stringify(plugin.errors)).toBe(true);
    const got = (await a.agent.get(`/api/admin/plugins/${created.id}`).expect(200)).body;
    expect(compile(doc.paths['/api/admin/plugins/{id}']!.get!.responses!['200']!.content!['application/json']!.schema)(got)).toBe(true);
    const cat = (await a.agent.get('/api/events/catalogue').expect(200)).body;
    expect(compile(doc.paths['/api/events/catalogue']!.get!.responses!['200']!.content!['application/json']!.schema)(cat)).toBe(true);
  });
});
