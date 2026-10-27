import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Principal } from '../authz/policy.js';
import { ip, parseBody, principalOf, requirePermission } from '../http/middleware.js';
import { forbidden } from '../http/problem.js';
import { AppEmbeds } from '../apps/embeds.js';
import { scopeOf } from '../apps/key-scope.js';
import type { Filter } from '../apps/query.js';
import { EXPAND_MAX, LINK_PAGE_MAX, type RelationEnd } from '../apps/relations.js';
import type { Actor, AppRow, EntityRow, RecordView } from '../apps/service.js';
import type { Services } from '../services.js';

const ref = z.string().min(1).max(63);
const id26 = z.string().length(26);
const relationName = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);

export const linkPageQuery = z.object({ limit: z.coerce.number().int().min(1).max(LINK_PAGE_MAX).default(25), offset: z.coerce.number().int().min(0).max(100_000).default(0) });
export const linkBody = z.object({ id: id26 }).strict();
export const orderBody = z.object({ order: z.array(id26).max(1000) }).strict();
/** `expand=a,b` and `expandLimit`, on record lists and reads. */
export const expandQuery = z.object({ expand: z.string().max(700).optional(), expandLimit: z.coerce.number().int().min(1).max(EXPAND_MAX).default(10) });

export const expandNames = (raw: string | undefined): string[] =>
  raw
    ? raw
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 20)
    : [];

/** The relation names (without `.count`) a filter and sort refer to. */
export function namedFields(filter: Filter | undefined, sort: { field: string }[] | undefined): string[] {
  const out: string[] = [];
  const walk = (f: Filter) => {
    if ('field' in f) out.push(f.field);
    else if ('not' in f) walk(f.not);
    else ('and' in f ? f.and : f.or).forEach(walk);
  };
  if (filter) walk(filter);
  for (const s of sort ?? []) out.push(s.field);
  return out.map((n) => (n.endsWith('.count') ? n.slice(0, -'.count'.length) : n));
}

/**
 * 1.8.0 (B-128): a credential limited to one entity (an app-scoped key naming one, or an embedded session's entity
 * list) reaches no other entity's records through a relation either: not in a link list, an expand, a filter or a
 * count. A credential limited to the app only, and a person's session, reach every entity of the app.
 */
export async function checkLinkScope(s: Services, req: Request, app: AppRow, entity: EntityRow, names: string[]): Promise<void> {
  const scope = scopeOf(req);
  if (!names.length || (!scope?.entity && !req.embedSession?.scope.entities)) return;
  const ends = (await s.apps.relations.ends(app, entity)).filter((e) => names.includes(e.name));
  for (const e of ends) {
    if (req.embedSession) AppEmbeds.checkEntity(req.embedSession, e.other.name);
    if (scope?.entity && e.other.id !== scope.entity) throw forbidden(`This credential is limited to the entity ${entity.name}; ${e.name} links to ${e.other.name}.`, { step: 'scope' });
  }
}

/** Records with their relations expanded (one level), as the entity API and the Records table read them. */
export async function withLinks(s: Services, req: Request, app: AppRow, entity: EntityRow, records: RecordView[], q: { expand?: string | undefined; expandLimit: number }): Promise<RecordView[]> {
  const names = expandNames(q.expand);
  if (!names.length) return records;
  await checkLinkScope(s, req, app, entity, names);
  return s.apps.relations.expand(principalOf(req), app, entity, records, names, q.expandLimit);
}

const endInfo = (e: RelationEnd) => ({ name: e.name, title: e.title, kind: e.kind, side: e.side, other: e.other.name, otherTitle: e.other.title, declaredBy: `${e.source.name}.${e.field.name}`, editable: e.editable, required: e.side === 'forward' && e.field.required, ...(e.field.type === 'relation' ? { max: e.side === 'forward' ? (e.field.max ?? null) : null, onDelete: e.field.onDelete, symmetric: e.field.symmetric, twoWay: e.field.twoWay } : {}) });

/**
 * 1.8.0, Sprint 45 (B-128): a record's links on one relation (or back-reference), and the add-link picker. Mounted
 * inside `routes/apps.ts`, behind its `/apps` guards. Reading needs `records:read`, changing links `records:write`;
 * the service checks the rest (the record readable and its field writable, the other record readable).
 */
export function appRelationRoutes(s: Services): Router {
  const r = Router();
  const read = requirePermission(s, 'records:read');
  const write = requirePermission(s, 'records:write');
  const a = s.apps;
  const actor = (req: Request): Actor & { principal: Principal } => ({ principal: principalOf(req), source: 'api', ip: ip(req), traceId: req.traceId });
  const param = (req: Request, k: string) => parseBody(ref, req.params[k]);
  const at = async (req: Request) => {
    const { app, entity } = await a.resolve(principalOf(req), param(req, 'app'), param(req, 'entity'));
    const name = parseBody(relationName, req.params.relation);
    await checkLinkScope(s, req, app, entity, [name]);
    return { app, entity, id: parseBody(id26, req.params.id), name };
  };

  /** The relation ends of an entity (its relation fields and the back-references other entities declare). */
  r.get('/apps/:app/entities/:entity/relations', read, async (req, res) => {
    const { app, entity } = await a.resolve(principalOf(req), param(req, 'app'), param(req, 'entity'));
    res.json({ relations: (await a.relations.ends(app, entity)).map(endInfo) });
  });

  r.get('/apps/:app/entities/:entity/records/:id/links/:relation', read, async (req, res) => {
    const { app, entity, id, name } = await at(req);
    res.json(await a.relations.list(principalOf(req), app.id, entity.id, id, name, parseBody(linkPageQuery, req.query)));
  });

  r.get('/apps/:app/entities/:entity/records/:id/links/:relation/candidates', read, async (req, res) => {
    const { app, entity, id, name } = await at(req);
    const q = parseBody(z.object({ q: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(50).default(10) }), req.query);
    res.json(await a.relations.candidates(principalOf(req), app.id, entity.id, id, name, q.q ?? null, q.limit));
  });

  r.post('/apps/:app/entities/:entity/records/:id/links/:relation', write, async (req, res) => {
    const { app, entity, id, name } = await at(req);
    const out = await a.relations.add(actor(req), app, entity, id, name, parseBody(linkBody, req.body).id);
    res.status(out.created ? 201 : 200).json(out);
  });

  r.put('/apps/:app/entities/:entity/records/:id/links/:relation/order', write, async (req, res) => {
    const { app, entity, id, name } = await at(req);
    res.json(await a.relations.reorder(actor(req), app, entity, id, name, parseBody(orderBody, req.body).order));
  });

  r.delete('/apps/:app/entities/:entity/records/:id/links/:relation/:target', write, async (req, res) => {
    const { app, entity, id, name } = await at(req);
    await a.relations.remove(actor(req), app, entity, id, name, parseBody(id26, req.params.target));
    res.status(204).end();
  });

  return r;
}
