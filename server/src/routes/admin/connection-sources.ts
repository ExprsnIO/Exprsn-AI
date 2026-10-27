import { Router, type Request } from 'express';
import { z } from 'zod';
import { badRequest, notFound } from '../../http/problem.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../../http/middleware.js';
import { queryCreateSchema, queryUpdateSchema, queryView } from '../../connections/saved-queries.js';
import { endpointCreateSchema, endpointDefinitionSchema, endpointUpdateSchema, endpointView, restConnectionCreateSchema, restConnectionUpdateSchema, restConnectionView, wsdlRefreshSchema } from '../../connections/rest.js';
import type { Services } from '../../services.js';

const params = z.record(z.string().max(63), z.unknown()).refine((v) => Object.keys(v).length <= 30, 'At most 30 parameters').default({});
const runBody = z.object({ params, limit: z.number().int().min(1).max(5000).optional(), cursor: z.string().max(4000).nullable().optional() }).strict();

/**
 * 1.8.0, Sprint 45 (B-125, B-126): designing saved connection queries and REST connections with their endpoints
 * (1.9.0: also GraphQL, SOAP and OData connections, with the WSDL and $metadata refresh, the GraphQL schema helper
 * and OpenAPI import for REST)
 * (`connections:manage`, as the connections themselves; mounted under /admin), including the test run and the
 * endpoint test call. Every object is filtered by clearance (above it, a 404) and every change is audited
 * (`connection.query.*`, `connection.rest.*`).
 */
export function connectionSourceAdminRoutes(s: Services): Router {
  const r = Router();
  r.use(['/connection-queries', '/rest-connections', '/connections/:id/queries'], noStore, requireAuth());
  const manage = requirePermission(s, 'connections:manage');
  const q = s.savedQueries;
  const rc = s.restConnections;
  const ctx = (req: Request) => ({ ip: ip(req), traceId: req.traceId });
  const id = (req: Request, k = 'id') => String(req.params[k]);

  // ---------- saved queries ----------

  r.get('/connections/:id/queries', manage, async (req, res) => {
    const p = principalOf(req);
    const c = await s.connections.get(p.tenantId, id(req));
    res.json(await Promise.all((await q.listFor(p, c.id)).map((x) => q.view(x))));
  });

  r.post('/connections/:id/queries', manage, async (req, res) => {
    const body = parseBody(queryCreateSchema, req.body);
    const p = principalOf(req);
    res.status(201).json(await q.view(await q.create(p, id(req), body, ctx(req))));
  });

  r.get('/connection-queries/:id', manage, async (req, res) => {
    const p = principalOf(req);
    const row = await q.get(p.tenantId, id(req));
    if (!(await q.listFor(p)).some((x) => x.id === row.id)) throw notFound('Saved query');
    res.json(await q.view(row));
  });

  r.put('/connection-queries/:id', manage, async (req, res) => {
    const body = parseBody(queryUpdateSchema, req.body);
    res.json(await q.view(await q.update(principalOf(req), id(req), body, ctx(req))));
  });

  r.post('/connection-queries/:id/publish', manage, async (req, res) => {
    const body = parseBody(z.object({ note: z.string().trim().max(500).nullable().default(null) }).strict(), req.body ?? {});
    const out = await q.publish(principalOf(req), id(req), body.note, ctx(req));
    res.json({ version: out.version, query: await q.view(out.query) });
  });

  r.post('/connection-queries/:id/test', manage, async (req, res) => {
    const body = parseBody(z.object({ version: z.union([z.number().int().min(1), z.literal('draft'), z.literal('published')]).default('draft'), params, limit: z.number().int().min(1).max(200).default(20) }).strict(), req.body ?? {});
    res.json(await q.test(principalOf(req), id(req), body.version, body.params, { limit: body.limit, ...ctx(req) }));
  });

  r.delete('/connection-queries/:id', manage, async (req, res) => {
    await q.remove(principalOf(req), id(req), ctx(req));
    res.status(204).end();
  });

  // ---------- REST connections ----------

  r.get('/rest-connections', manage, async (req, res) => {
    const p = principalOf(req);
    res.json(await Promise.all((await rc.listFor(p)).map((c) => rc.view(c))));
  });

  r.post('/rest-connections', manage, async (req, res) => {
    const body = parseBody(restConnectionCreateSchema, req.body);
    res.status(201).json(restConnectionView(await rc.create(principalOf(req), body, ctx(req))));
  });

  r.get('/rest-connections/:id', manage, async (req, res) => {
    const p = principalOf(req);
    const c = (await rc.listFor(p)).find((x) => x.id === id(req) || x.name === id(req));
    if (!c) throw notFound('REST connection');
    res.json({ ...(await rc.view(c)), usedBy: await rc.usedBy(c) });
  });

  r.patch('/rest-connections/:id', manage, async (req, res) => {
    const body = parseBody(restConnectionUpdateSchema, req.body);
    const c = await rc.update(principalOf(req), id(req), body, ctx(req));
    res.json(await rc.view(c));
  });

  r.delete('/rest-connections/:id', manage, async (req, res) => {
    await rc.remove(principalOf(req), id(req), ctx(req));
    res.status(204).end();
  });

  r.post('/rest-connections/:id/test', manage, async (req, res) => {
    res.json(await rc.test(principalOf(req), id(req), ctx(req)));
  });

  /** 1.9.0, SOAP: fetch the WSDL again from its URL (or a new one), or take an uploaded document; re-read it. */
  r.post('/rest-connections/:id/wsdl', manage, async (req, res) => {
    const body = parseBody(wsdlRefreshSchema, req.body ?? {});
    const out = await rc.refreshWsdl(principalOf(req), id(req), body, ctx(req));
    res.json({ connection: await rc.view(out.connection), missing: out.missing });
  });

  /** 1.9.0, SOAP: the stored WSDL document itself (the view lists only what was read from it). */
  r.get('/rest-connections/:id/wsdl', manage, async (req, res) => {
    const text = await rc.wsdlDocument(principalOf(req), id(req));
    res.type('application/xml').setHeader('Content-Disposition', 'attachment; filename="service.wsdl"');
    res.send(text);
  });

  /** 1.9.0, OData: read the service's $metadata again; lists the endpoints whose entity set is gone. */
  r.post('/rest-connections/:id/odata/metadata', manage, async (req, res) => {
    const out = await rc.refreshMetadata(principalOf(req), id(req), ctx(req));
    res.json({ connection: await rc.view(out.connection), missing: out.missing });
  });

  /** 1.9.0, REST: read an OpenAPI 3 or Swagger 2.0 document (by URL or as text) and list its importable operations. */
  r.post('/rest-connections/:id/openapi', manage, async (req, res) => {
    const body = parseBody(z.object({ url: z.string().trim().url().max(2000).optional(), document: z.string().min(10).max(4 * 1024 * 1024).optional() }).strict(), req.body ?? {});
    const out = await rc.readOpenApi(principalOf(req), id(req), body, ctx(req));
    res.json({ connection: await rc.view(out.connection), specVersion: out.meta.specVersion, title: out.meta.title, version: out.meta.version, servers: out.meta.servers, operations: out.meta.operations, notes: out.meta.notes });
  });

  /** 1.9.0, REST: the chosen GET operations of the read OpenAPI document become endpoints. */
  r.post('/rest-connections/:id/openapi/import', manage, async (req, res) => {
    const body = parseBody(z.object({ operations: z.array(z.object({ operationId: z.string().min(1).max(200), name: z.string().trim().regex(/^[a-z][a-z0-9_-]{0,62}$/).optional() }).strict()).min(1).max(200) }).strict(), req.body);
    const out = await rc.importOpenApi(principalOf(req), id(req), body.operations, ctx(req));
    const p = principalOf(req);
    const c = (await rc.listFor(p)).find((x) => x.id === id(req) || x.name === id(req));
    res.json({ ...out, connection: c ? await rc.view(c) : null });
  });

  /** 1.9.0, GraphQL: the Query type's root fields with their arguments, for the endpoint editor. */
  r.get('/rest-connections/:id/graphql/schema', manage, async (req, res) => {
    res.json(await rc.graphqlSchema(principalOf(req), id(req), ctx(req)));
  });

  r.post('/rest-connections/:id/endpoints', manage, async (req, res) => {
    const body = parseBody(endpointCreateSchema, req.body);
    const e = await rc.saveEndpoint(principalOf(req), id(req), body, ctx(req));
    res.status(e.version === 1 ? 201 : 200).json(endpointView(e));
  });

  r.patch('/rest-connections/:id/endpoints/:endpoint', manage, async (req, res) => {
    const body = parseBody(endpointUpdateSchema, req.body);
    res.json(endpointView(await rc.updateEndpoint(principalOf(req), id(req), id(req, 'endpoint'), body, ctx(req))));
  });

  r.delete('/rest-connections/:id/endpoints/:endpoint', manage, async (req, res) => {
    await rc.removeEndpoint(principalOf(req), id(req), id(req, 'endpoint'), ctx(req));
    res.status(204).end();
  });

  /** The endpoint editor's test call: the saved endpoint, or the definition being edited (`definition`). */
  r.post('/rest-connections/:id/endpoints/:endpoint/test', manage, async (req, res) => {
    const body = parseBody(z.object({ params, limit: z.number().int().min(1).max(200).default(20), definition: endpointDefinitionSchema.optional() }).strict(), req.body ?? {});
    const name = id(req, 'endpoint');
    const p = principalOf(req);
    const saved = name === '_draft' ? null : name;
    if (!saved && !body.definition) throw badRequest('Give the definition to test.');
    res.json(await rc.testEndpoint(p, id(req), body.definition ? null : saved, body.definition ?? null, body.params, { limit: body.limit, ...ctx(req) }));
  });

  return r;
}

/**
 * 1.8.0, Sprint 45 (B-125, B-126): the read API (`connections:query`): published saved queries and REST endpoints the
 * caller may read, run with parameters, returning typed columns, rows, truncation and a cursor. The same governed path
 * as the tool `connections.query`; charts and reports read through it later.
 */
export function connectionSourceRoutes(s: Services): Router {
  const r = Router();
  r.use(['/connection-queries', '/rest-connections'], noStore, requireAuth());
  const read = requirePermission(s, 'connections:query');
  const ctx = (req: Request) => ({ ip: ip(req), traceId: req.traceId });

  r.get('/connection-queries', read, async (req, res) => {
    const p = principalOf(req);
    const rows = (await s.savedQueries.listFor(p)).filter((x) => x.published_version != null && !x.write);
    res.json(await Promise.all(rows.map(async (x) => {
      const v = queryView(x, await s.connections.get(p.tenantId, x.connection_id).catch(() => null), await s.savedQueries.versions(x));
      return { id: v.id, name: v.name, title: v.title, description: v.description, label: v.label, connection: v.connection, engine: v.engine, publishedVersion: v.publishedVersion, params: v.params, lookups: v.lookups };
    })));
  });

  r.post('/connection-queries/:id/run', read, async (req, res) => {
    const body = parseBody(runBody, req.body ?? {});
    res.json(await s.savedQueries.run(principalOf(req), String(req.params.id), body.params, { ...(body.limit ? { limit: body.limit } : {}), cursor: body.cursor ?? null, via: 'api', ...ctx(req) }));
  });

  r.get('/rest-connections', read, async (req, res) => {
    const p = principalOf(req);
    const out = [];
    for (const c of await s.restConnections.listFor(p)) out.push({ id: c.id, name: c.name, title: c.title, label: c.label, protocol: c.protocol, endpoints: (await s.restConnections.endpoints(c)).map((e) => ({ name: e.name, title: e.title, description: e.description, params: e.definition.params, paging: e.definition.paging.kind, lookups: e.lookups })) });
    res.json(out);
  });

  r.post('/rest-connections/:id/endpoints/:endpoint/read', read, async (req, res) => {
    const body = parseBody(runBody, req.body ?? {});
    res.json(await s.restConnections.read(principalOf(req), String(req.params.id), String(req.params.endpoint), body.params, { ...(body.limit ? { limit: body.limit } : {}), cursor: body.cursor ?? null, via: 'api', ...ctx(req) }));
  });

  return r;
}
