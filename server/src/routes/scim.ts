import express, { Router, type ErrorRequestHandler, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { HttpProblem } from '../http/problem.js';
import { Limiter } from '../platform/ratelimit.js';
import type { Services } from '../services.js';
import type { Doc } from '../identity/scim/patch.js';
import { ScimError, type ListQuery, type ScimCaller } from '../identity/scim/service.js';
import { ERROR_SCHEMA, resourceTypes, schemaDocs, serviceProviderConfig } from '../identity/scim/schemas.js';

/*
 * 1.6.0, Sprint 37c (B-7201, B-7202): SCIM 2.0 at /scim/v2 (RFC 7644), outside /api: no session, no CSRF; a SCIM
 * token (`Authorization: Bearer exai_scim1_…`) names the tenant and the SCIM store. Bodies are application/scim+json
 * (or application/json) up to 1 MB; answers are application/scim+json; errors use the SCIM error schema
 * (`status`, `scimType`, `detail`). Each address is limited to IDENTITY_SCIM_RATE_PER_MINUTE requests.
 *
 *   GET  /scim/v2/ServiceProviderConfig | /ResourceTypes[/{id}] | /Schemas[/{id}]
 *   GET  /scim/v2/Users   (filter, startIndex, count, attributes, excludedAttributes)      POST /scim/v2/Users
 *   GET | PUT | PATCH | DELETE /scim/v2/Users/{id}
 *   GET  /scim/v2/Groups  (the same query)                                                   POST /scim/v2/Groups
 *   GET | PUT | PATCH | DELETE /scim/v2/Groups/{id}
 *
 * The tokens, the store's status and re-applying the group mappings are under /api/admin/identity-providers/{id}/scim
 * (identity:manage).
 */

const SCIM_TYPE = 'application/scim+json';

function scimError(res: Response, status: number, detail: string, scimType: string | null = null): void {
  if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer realm="scim"');
  res.status(status).type(SCIM_TYPE).json({ schemas: [ERROR_SCHEMA], status: String(status), ...(scimType ? { scimType } : {}), detail });
}

const caller = (res: Response): ScimCaller => res.locals.scim as ScimCaller;

const listQuery = (req: Request): ListQuery => {
  const q = req.query as Record<string, unknown>;
  const str = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : undefined);
  const int = (k: string) => {
    const v = str(k);
    if (v === undefined || v === '') return undefined;
    if (!/^-?\d{1,9}$/.test(v)) throw new ScimError(400, 'invalidValue', `${k} is a whole number.`);
    return Number(v);
  };
  return { filter: str('filter'), startIndex: int('startIndex'), count: int('count'), attributes: str('attributes'), excludedAttributes: str('excludedAttributes') };
};

const bodyOf = (req: Request): Doc => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) throw new ScimError(400, 'invalidSyntax', 'The body is a JSON object.');
  return req.body as Doc;
};

const idOf = (req: Request): string => {
  const id = String((req.params as Record<string, string>).id ?? '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ScimError(404, null, 'Resource not found.');
  return id;
};

const send = (res: Response, status: number, out: { resource: Doc; etag: string }) => {
  res.setHeader('ETag', out.etag);
  const loc = (out.resource.meta as { location?: string } | undefined)?.location;
  if (status === 201 && loc) res.setHeader('Location', loc);
  res.status(status).type(SCIM_TYPE).json(out.resource);
};

export function scimPublicRoutes(s: Services): Router {
  const r = Router();
  const limiter = new Limiter(s.counters, 'scim', s.cfg.IDENTITY_SCIM_RATE_PER_MINUTE, 60_000);
  const limit: RequestHandler = async (req, res, next) => {
    const l = await limiter.consume(req.ip ?? 'unknown');
    if (!l.allowed) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(l.resetMs / 1000))));
      return scimError(res, 429, 'Too many SCIM requests from this address.', 'tooMany');
    }
    next();
  };
  const json = express.json({ limit: '1mb', strict: true, type: ['application/json', SCIM_TYPE, 'application/*+json'] });
  const auth: RequestHandler = async (req, res, next) => {
    res.locals.scim = await s.scim.authenticate(req.header('authorization'), req.ip ?? null, req.traceId ?? null);
    next();
  };
  r.use('/scim/v2', noStore, limit, json, auth);

  // ---- discovery ----

  r.get('/scim/v2/ServiceProviderConfig', (_req, res) => {
    res.type(SCIM_TYPE).json(serviceProviderConfig(s.scim.baseUrl(), s.cfg.IDENTITY_SCIM_MAX_RESULTS));
  });

  r.get('/scim/v2/ResourceTypes', (_req, res) => {
    const list = resourceTypes(s.scim.baseUrl());
    res.type(SCIM_TYPE).json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: list.length, itemsPerPage: list.length, startIndex: 1, Resources: list });
  });

  r.get('/scim/v2/ResourceTypes/:id', (req, res) => {
    const one = resourceTypes(s.scim.baseUrl()).find((x) => x.id === req.params.id);
    if (!one) return scimError(res, 404, 'Resource type not found.');
    res.type(SCIM_TYPE).json(one);
  });

  r.get('/scim/v2/Schemas', (_req, res) => {
    const list = schemaDocs(s.scim.baseUrl());
    res.type(SCIM_TYPE).json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: list.length, itemsPerPage: list.length, startIndex: 1, Resources: list });
  });

  r.get('/scim/v2/Schemas/:id', (req, res) => {
    const one = schemaDocs(s.scim.baseUrl()).find((x) => x.id === req.params.id);
    if (!one) return scimError(res, 404, 'Schema not found.');
    res.type(SCIM_TYPE).json(one);
  });

  // ---- users ----

  r.get('/scim/v2/Users', async (req, res) => {
    res.type(SCIM_TYPE).json(await s.scim.listUsers(caller(res), listQuery(req)));
  });

  r.post('/scim/v2/Users', async (req, res) => {
    send(res, 201, await s.scim.createUser(caller(res), bodyOf(req)));
  });

  r.get('/scim/v2/Users/:id', async (req, res) => {
    send(res, 200, await s.scim.getUser(caller(res), idOf(req), listQuery(req)));
  });

  r.put('/scim/v2/Users/:id', async (req, res) => {
    send(res, 200, await s.scim.replaceUser(caller(res), idOf(req), bodyOf(req), req.header('if-match')));
  });

  r.patch('/scim/v2/Users/:id', async (req, res) => {
    send(res, 200, await s.scim.patchUser(caller(res), idOf(req), bodyOf(req), req.header('if-match')));
  });

  r.delete('/scim/v2/Users/:id', async (req, res) => {
    await s.scim.deleteUser(caller(res), idOf(req), req.header('if-match'));
    res.status(204).end();
  });

  // ---- groups ----

  r.get('/scim/v2/Groups', async (req, res) => {
    res.type(SCIM_TYPE).json(await s.scim.listGroups(caller(res), listQuery(req)));
  });

  r.post('/scim/v2/Groups', async (req, res) => {
    send(res, 201, await s.scim.createGroup(caller(res), bodyOf(req)));
  });

  r.get('/scim/v2/Groups/:id', async (req, res) => {
    send(res, 200, await s.scim.getGroup(caller(res), idOf(req), listQuery(req)));
  });

  r.put('/scim/v2/Groups/:id', async (req, res) => {
    send(res, 200, await s.scim.replaceGroup(caller(res), idOf(req), bodyOf(req), req.header('if-match')));
  });

  r.patch('/scim/v2/Groups/:id', async (req, res) => {
    send(res, 200, await s.scim.patchGroup(caller(res), idOf(req), bodyOf(req), req.header('if-match')));
  });

  r.delete('/scim/v2/Groups/:id', async (req, res) => {
    await s.scim.deleteGroup(caller(res), idOf(req), req.header('if-match'));
    res.status(204).end();
  });

  // Anything else under /scim/v2 (bulk, /Me, /.search) is not offered.
  r.use('/scim/v2', (req, res) => scimError(res, req.method === 'GET' ? 404 : 501, `${req.method} ${req.path.slice(0, 100)} is not offered by this server (no bulk, /Me or /.search).`));

  const onError: ErrorRequestHandler = (err, req, res, next) => {
    if (!req.originalUrl.startsWith('/scim/v2')) return next(err);
    if (err instanceof ScimError) return scimError(res, err.status, err.message, err.scimType);
    if (err instanceof HttpProblem) return scimError(res, err.status, err.detail ?? err.title, err.status === 409 ? 'uniqueness' : null);
    const e = err as { type?: string; status?: number };
    if (e.type === 'entity.parse.failed') return scimError(res, 400, 'The body is not valid JSON.', 'invalidSyntax');
    if (e.type === 'entity.too.large') return scimError(res, 413, 'The body is larger than 1 MB.', 'tooLarge');
    s.log.error({ err, traceId: req.traceId }, 'SCIM request failed');
    return scimError(res, 500, `The server could not complete the request (trace ${req.traceId ?? 'unknown'}).`);
  };
  r.use(onError);
  return r;
}

/** The SCIM store's status and tokens, under Identity (identity:manage). */
export function scimAdminRoutes(s: Services): Router {
  const r = Router();
  const manage = requirePermission(s, 'identity:manage');
  r.use('/identity-providers/:id/scim', noStore, requireAuth());
  const ctx = (req: Request) => ({ ip: ip(req), traceId: req.traceId ?? null });
  const store = (req: Request) => parseBody(z.string().length(26), (req.params as Record<string, string>).id);

  r.get('/identity-providers/:id/scim', manage, async (req, res) => {
    res.json(await s.scim.status(principalOf(req), store(req)));
  });

  r.post('/identity-providers/:id/scim/tokens', manage, async (req, res) => {
    const b = parseBody(z.object({ name: z.string().trim().min(1).max(100), expiresInDays: z.number().int().min(1).max(3650).nullable().optional() }).strict(), req.body);
    res.status(201).json(await s.scim.createToken(principalOf(req), store(req), b, ctx(req)));
  });

  r.delete('/identity-providers/:id/scim/tokens/:tokenId', manage, async (req, res) => {
    res.json(await s.scim.revokeToken(principalOf(req), store(req), parseBody(z.string().length(26), (req.params as Record<string, string>).tokenId), ctx(req)));
  });

  r.post('/identity-providers/:id/scim/reapply', manage, async (req, res) => {
    res.status(202).json(await s.scim.reapply(principalOf(req), store(req), ctx(req)));
  });

  return r;
}
