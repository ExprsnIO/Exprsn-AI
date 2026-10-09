import { Router, type Request } from 'express';
import { z } from 'zod';
import { LABELS } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { badRequest, notFound } from '../http/problem.js';
import { AppEmbeds, embedConfigSchema, embedKeyInputSchema, embedKeyView } from '../apps/embeds.js';
import { formDefinitionSchema, formView } from '../apps/forms.js';
import { appScopeGuard, RESERVED_SEGMENTS } from '../apps/key-scope.js';
import { OPS, filterSchema, sortSchema, type Filter, type Sort } from '../apps/query.js';
import { entityDefinitionSchema, fieldSchema, nameSchema, statesSchema } from '../apps/schema.js';
import { schemaVersionView } from '../apps/schema-api.js';
import { entityView, type Actor, type AppRow, type EntityRow, type RecordView } from '../apps/service.js';
import type { Services } from '../services.js';

const id26 = z.string().length(26);
const ref = z.string().min(1).max(63);
const label = z.enum(LABELS);
const values = z.record(z.string().max(63), z.unknown()).refine((v) => Object.keys(v).length <= 200, 'at most 200 fields');

const listQuery = z.object({
  filter: z.string().max(20_000).optional(),
  where: z.union([z.string().max(2000), z.array(z.string().max(2000)).max(20)]).optional(),
  sort: z.string().max(300).optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  cursor: z.string().min(1).max(16_000).optional(),
  include: z.enum(['related']).optional()
});

function sortParam(raw: string | undefined): Sort | undefined {
  if (!raw) return undefined;
  return parseBody(
    sortSchema,
    raw.split(',').map((x) => {
      const [field, dir] = x.split(':');
      return { field: field?.trim() ?? '', dir: dir?.trim() || 'asc' };
    })
  );
}

/** `where=field:op:value` conditions, combined with and; `in` takes a comma-separated list. */
function whereParam(raw: string | string[] | undefined): Filter | undefined {
  if (!raw) return undefined;
  const list = Array.isArray(raw) ? raw : [raw];
  const conds: Filter[] = list.map((w) => {
    const m = /^([a-zA-Z_][a-zA-Z0-9_]{0,62}):([a-zA-Z]+)(?::(.*))?$/s.exec(w);
    if (!m) throw badRequest('where is field:op:value, for example region:eq:emea or amount:gte:100.');
    const op = m[2] as (typeof OPS)[number];
    if (!OPS.includes(op)) throw badRequest(`where: the operator ${m[2]} is not one of ${OPS.join(', ')}.`);
    const v = m[3] ?? '';
    const typed = (x: string): unknown => (x === 'true' ? true : x === 'false' ? false : x !== '' && !Number.isNaN(Number(x)) && /^-?\d+(\.\d+)?$/.test(x) ? Number(x) : x);
    return op === 'exists' ? { field: m[1]!, op } : op === 'in' ? { field: m[1]!, op, value: v.split(',').map((x) => typed(x.trim())) } : { field: m[1]!, op, value: typed(v) };
  });
  return conds.length === 1 ? conds[0] : { and: conds };
}

function filterParam(raw: string | undefined): Filter | undefined {
  if (!raw) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw badRequest('filter is not valid JSON.');
  }
  return parseBody(filterSchema, v);
}

/**
 * 1.6.0, Sprint 39d (B-8601 to B-8603, B-8701, B-8702): the entity API of an app, its schema API, OpenAPI document and
 * client, and its embed settings. Mounted after the app's own routes, so `/apps/:app/<segment>` reaches an entity only
 * when the segment is none of the app's own (`entities`, `forms`, `policies`, `triggers`, `schema`, `embed`, ...).
 */
export function appEntityApiRoutes(s: Services): Router {
  const r = Router();
  r.use('/apps', noStore, requireAuth(), appScopeGuard(s));
  const read = requirePermission(s, 'records:read');
  const write = requirePermission(s, 'records:write');
  const design = requirePermission(s, 'apps:design');
  const a = s.apps;

  const actor = (req: Request): Actor & { principal: Principal } => ({ principal: principalOf(req), source: 'api', ip: ip(req), traceId: req.traceId });
  const param = (req: Request, k: string) => parseBody(ref, req.params[k]);
  const baseUrl = (req: Request) => (s.cfg.API_PUBLIC_URL ? s.cfg.API_PUBLIC_URL.replace(/\/+$/, '') : new URL(s.cfg.PUBLIC_URL).origin) + (req.originalUrl.startsWith('/api/') ? '' : '');

  /** The entity named by the path; the app's own segments and an embedded session's entity list are refused here. */
  const entityOf = async (req: Request): Promise<{ app: AppRow; entity: EntityRow }> => {
    const name = param(req, 'entity');
    if (RESERVED_SEGMENTS.has(name)) throw notFound('Entity');
    const out = await a.resolve(principalOf(req), param(req, 'app'), name);
    if (req.embedSession) AppEmbeds.checkEntity(req.embedSession, out.entity.name);
    return out;
  };

  /** With include=related: the records the reference and entity-lookup fields point at, each one the reader may read or null. */
  const withRelated = async (req: Request, app: AppRow, entity: EntityRow, records: RecordView[]): Promise<RecordView[]> => {
    const p = principalOf(req);
    const links = entity.definition.fields.filter((f) => f.type === 'reference' || (f.type === 'lookup' && f.source === 'entity'));
    if (!links.length) return records.map((x) => ({ ...x, related: {} }));
    const cache = new Map<string, Promise<RecordView | null>>();
    const fetchOne = (target: string, id: string) => {
      const key = `${target}/${id}`;
      let pr = cache.get(key);
      if (!pr) {
        pr = a.get(p, app.id, target, id).catch(() => null);
        cache.set(key, pr);
      }
      return pr;
    };
    return Promise.all(
      records.map(async (rec) => {
        const related: Record<string, RecordView | null> = {};
        for (const f of links) {
          const v = rec.values[f.name];
          const target = f.type === 'reference' ? f.entity : f.type === 'lookup' ? (f.entity ?? '') : '';
          related[f.name] = typeof v === 'string' && v ? await fetchOne(target, v) : null;
        }
        return { ...rec, related };
      })
    );
  };

  // ---------- schema API (B-8602) ----------

  r.get('/apps/:app/schema', design, async (req, res) => {
    const app = await a.designable(principalOf(req), param(req, 'app'));
    const entities = await a.entities(app);
    const forms = await a.forms.list(app);
    const current = await a.schema.current(app);
    res.json({ app: app.name, version: current.version, hash: current.hash, changedAt: current.changedAt, entities: entities.map(entityView), forms: forms.map((f) => formView(f.form, f.entity)) });
  });

  r.get('/apps/:app/schema/versions', design, async (req, res) => {
    const app = await a.designable(principalOf(req), param(req, 'app'));
    const q = parseBody(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }), req.query);
    res.json({ versions: (await a.schema.versions(app, q.limit)).map(schemaVersionView) });
  });

  r.get('/apps/:app/schema/versions/:version', design, async (req, res) => {
    const app = await a.designable(principalOf(req), param(req, 'app'));
    res.json(schemaVersionView(await a.schema.version(app, parseBody(z.coerce.number().int().min(1), req.params.version))));
  });

  const entityBody = z.object({ title: z.string().trim().min(1).max(200).optional(), label: label.optional(), definition: entityDefinitionSchema }).strict();

  r.put('/apps/:app/schema/entities/:entity', design, async (req, res) => {
    const app = await a.designable(principalOf(req), param(req, 'app'));
    const name = parseBody(nameSchema, req.params.entity);
    const body = parseBody(entityBody, req.body);
    const out = await a.schema.setEntity(actor(req), app, { name, ...body });
    res.status(out.created ? 201 : 200).json({ ...entityView(out.entity), schema: await a.schema.current(app) });
  });

  r.delete('/apps/:app/schema/entities/:entity', design, async (req, res) => {
    const app = await a.designable(principalOf(req), param(req, 'app'));
    await a.schema.removeEntity(actor(req), app, param(req, 'entity'));
    res.status(204).end();
  });

  r.post('/apps/:app/schema/entities/:entity/fields', design, async (req, res) => {
    const app = await a.designable(principalOf(req), param(req, 'app'));
    const body = parseBody(z.object({ field: fieldSchema, rev: z.number().int().min(1).optional() }).strict(), req.body);
    const entity = await a.schema.addField(actor(req), app, param(req, 'entity'), body.field, body.rev);
    res.status(201).json({ ...entityView(entity), schema: await a.schema.current(app) });
  });

  r.patch('/apps/:app/schema/entities/:entity/fields/:field', design, async (req, res) => {
    const app = await a.designable(principalOf(req), param(req, 'app'));
    const body = parseBody(z.object({ patch: z.record(z.string().max(63), z.unknown()), rev: z.number().int().min(1).optional() }).strict(), req.body);
    const entity = await a.schema.updateField(actor(req), app, param(req, 'entity'), parseBody(nameSchema, req.params.field), body.patch, body.rev);
    res.json({ ...entityView(entity), schema: await a.schema.current(app) });
  });

  r.delete('/apps/:app/schema/entities/:entity/fields/:field', design, async (req, res) => {
    const app = await a.designable(principalOf(req), param(req, 'app'));
    const entity = await a.schema.removeField(actor(req), app, param(req, 'entity'), parseBody(nameSchema, req.params.field));
    res.json({ ...entityView(entity), schema: await a.schema.current(app) });
  });

  r.put('/apps/:app/schema/entities/:entity/states', design, async (req, res) => {
    const app = await a.designable(principalOf(req), param(req, 'app'));
    const body = parseBody(z.object({ states: statesSchema.nullable(), rev: z.number().int().min(1).optional() }).strict(), req.body);
    const entity = await a.schema.setStates(actor(req), app, param(req, 'entity'), body.states, body.rev);
    res.json({ ...entityView(entity), schema: await a.schema.current(app) });
  });

  r.put('/apps/:app/schema/forms/:form', design, async (req, res) => {
    const app = await a.designable(principalOf(req), param(req, 'app'));
    const name = parseBody(nameSchema, req.params.form);
    const body = parseBody(z.object({ title: z.string().trim().min(1).max(200).optional(), entity: ref, definition: formDefinitionSchema, ratePerMinute: z.number().int().min(1).max(10_000).optional() }).strict(), req.body);
    const out = await a.schema.setForm(actor(req), app, { name, ...body });
    res.status(out.created ? 201 : 200).json({ ...formView(out.form, out.entity), schema: await a.schema.current(app) });
  });

  r.delete('/apps/:app/schema/forms/:form', design, async (req, res) => {
    const app = await a.designable(principalOf(req), param(req, 'app'));
    await a.schema.removeForm(actor(req), app, param(req, 'form'));
    res.status(204).end();
  });

  // ---------- OpenAPI and the client (B-8603) ----------

  r.get('/apps/:app/openapi.json', read, async (req, res) => {
    const app = await a.app(principalOf(req), param(req, 'app'));
    const entities = await a.entities(app);
    const current = await a.schema.current(app);
    if (req.header('if-none-match') === `"${current.hash}"`) return void res.status(304).end();
    res.setHeader('ETag', `"${current.hash}"`);
    res.json(a.schema.openapi(app, entities, current, baseUrl(req)));
  });

  for (const format of ['ts', 'js'] as const) {
    r.get(`/apps/:app/client.${format}`, read, async (req, res) => {
      const app = await a.app(principalOf(req), param(req, 'app'));
      const entities = await a.entities(app);
      const current = await a.schema.current(app);
      if (req.header('if-none-match') === `"${current.hash}"`) return void res.status(304).end();
      res.setHeader('ETag', `"${current.hash}"`);
      res.setHeader('Content-Type', `${format === 'ts' ? 'application/typescript' : 'text/javascript'}; charset=utf-8`);
      res.setHeader('Content-Disposition', `attachment; filename="${app.name}-client.${format}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(a.schema.client(app, entities, current, format));
    });
  }

  // ---------- embedding (B-8701, B-8702) ----------

  const embedView = async (app: AppRow) => {
    const config = await a.embeds.config(app);
    return { ...config, audience: AppEmbeds.audience(app), signedUrl: `${new URL(s.cfg.PUBLIC_URL).origin}/embed/app/${app.tenant_id}/${app.name}`, frameAncestors: a.embeds.frameAncestors(config).join(' ') };
  };

  r.get('/apps/:app/embed', design, async (req, res) => {
    const app = await a.designable(principalOf(req), param(req, 'app'));
    const origin = new URL(s.cfg.PUBLIC_URL).origin;
    res.json({
      ...(await embedView(app)),
      keys: (await a.embeds.keys(app)).map(embedKeyView),
      pages: (await a.embeds.pages(app)).map((p) => ({ id: p.id, form: p.form.name, formId: p.form.id, formTitle: p.form.title, entity: p.entity.name, enabled: p.enabled, public: p.form.public, url: `${origin}/embed/${p.id}`, createdBy: p.created_by, createdAt: p.created_at })),
      sessions: (await a.embeds.sessions(app, 50)).map((x) => ({ id: x.id, user: x.user_id, username: x.username, key: x.key_id, host: x.host, expiresAt: x.expires_at, createdAt: x.created_at, lastSeenAt: x.last_seen_at, revokedAt: x.revoked_at }))
    });
  });

  r.put('/apps/:app/embed', design, async (req, res) => {
    const app = await a.designable(principalOf(req), param(req, 'app'));
    await a.embeds.update(actor(req), app, parseBody(embedConfigSchema, req.body));
    res.json(await embedView(app));
  });

  r.post('/apps/:app/embed/keys', design, async (req, res) => {
    const app = await a.designable(principalOf(req), param(req, 'app'));
    const out = await a.embeds.addKey(actor(req), app, parseBody(embedKeyInputSchema, req.body));
    res.status(201).json({ ...embedKeyView(out.key), ...(out.secret ? { secret: out.secret, notice: 'This is the only time the secret is shown.' } : {}) });
  });

  r.delete('/apps/:app/embed/keys/:id', design, async (req, res) => {
    const app = await a.designable(principalOf(req), param(req, 'app'));
    res.json(embedKeyView(await a.embeds.revokeKey(actor(req), app, parseBody(id26, req.params.id))));
  });

  r.post('/apps/:app/embed/pages', design, async (req, res) => {
    const app = await a.designable(principalOf(req), param(req, 'app'));
    const body = parseBody(z.object({ form: ref }).strict(), req.body);
    const p = await a.embeds.addPage(actor(req), app, body.form);
    res.status(201).json({ id: p.id, form: p.form.name, formTitle: p.form.title, entity: p.entity.name, enabled: p.enabled, url: `${new URL(s.cfg.PUBLIC_URL).origin}/embed/${p.id}`, createdAt: p.created_at });
  });

  r.delete('/apps/:app/embed/pages/:id', design, async (req, res) => {
    const app = await a.designable(principalOf(req), param(req, 'app'));
    await a.embeds.removePage(actor(req), app, parseBody(id26, req.params.id));
    res.status(204).end();
  });

  r.post('/apps/:app/embed/sessions/revoke', design, async (req, res) => {
    const app = await a.designable(principalOf(req), param(req, 'app'));
    const body = parseBody(z.object({ id: id26.optional() }).strict(), req.body ?? {});
    res.json({ revoked: await a.embeds.revokeSessions(actor(req), app, body.id) });
  });

  // ---------- the entity API (B-8601) ----------

  r.get('/apps/:app/:entity', read, async (req, res) => {
    const { app, entity } = await entityOf(req);
    const q = parseBody(listQuery, req.query);
    const parts = [filterParam(q.filter), whereParam(q.where)].filter((f): f is Filter => !!f);
    const filter = parts.length > 1 ? { and: parts } : parts[0];
    const sort = sortParam(q.sort);
    const out = await a.query(principalOf(req), app.id, entity.id, { ...(filter ? { filter } : {}), ...(sort ? { sort } : {}), ...(q.q ? { q: q.q } : {}), ...(q.cursor ? { cursor: q.cursor } : {}), limit: q.limit, offset: q.offset });
    const records = q.include === 'related' ? await withRelated(req, app, entity, out.records) : out.records;
    res.json({ total: out.total, limit: out.limit, offset: out.offset, nextCursor: out.nextCursor, records });
  });

  r.post('/apps/:app/:entity', write, async (req, res) => {
    const { app, entity } = await entityOf(req);
    const body = parseBody(z.object({ values, label: label.optional() }).strict(), req.body);
    res.status(201).json(await a.createRecord(actor(req), app, entity, body));
  });

  r.get('/apps/:app/:entity/:id', read, async (req, res) => {
    const { app, entity } = await entityOf(req);
    const q = parseBody(z.object({ include: z.enum(['related']).optional() }), req.query);
    const rec = await a.get(principalOf(req), app.id, entity.id, parseBody(id26, req.params.id));
    res.json(q.include === 'related' ? (await withRelated(req, app, entity, [rec]))[0] : rec);
  });

  r.patch('/apps/:app/:entity/:id', write, async (req, res) => {
    const { app, entity } = await entityOf(req);
    const body = parseBody(z.object({ values, version: z.number().int().min(1).optional() }).strict(), req.body);
    res.json(await a.updateRecord(actor(req), app, entity, parseBody(id26, req.params.id), body));
  });

  r.delete('/apps/:app/:entity/:id', write, async (req, res) => {
    const { app, entity } = await entityOf(req);
    await a.removeRecord(actor(req), app, entity, parseBody(id26, req.params.id));
    res.status(204).end();
  });

  r.post('/apps/:app/:entity/:id/transition', write, async (req, res) => {
    const { app, entity } = await entityOf(req);
    const body = parseBody(z.object({ to: z.string().min(1).max(60), version: z.number().int().min(1).optional(), note: z.string().max(300).nullable().optional() }).strict(), req.body);
    res.json(await a.transition(actor(req), app, entity, parseBody(id26, req.params.id), body.to, { ...(body.version ? { version: body.version } : {}), note: body.note ?? null }));
  });

  return r;
}
