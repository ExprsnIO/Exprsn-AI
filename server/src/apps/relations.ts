import type { Knex } from 'knex';
import { ulid } from 'ulid';
import { actorFrom } from '../audit/chain.js';
import { clears, highest, LABELS, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import { AppPolicies, type Grant } from './policies.js';
import { applyFilter, checkFilterSize, type Filter, type LinkScope, type QueryContext } from './query.js';
import { titleFieldOf, type EntityDefinition, type Field, type Values } from './schema.js';
import { recordFrom, type Actor, type AppRow, type AppService, type EntityRow, type RecordRow, type RecordView } from './service.js';

/*
 * 1.8.0, Sprint 45 (B-128): many-to-many relationships and back-references ("related records").
 *
 * Two kinds of relation, both declared on one entity and seen from both ends:
 *
 * - one-to-many through the existing `reference` field: with `inverse` set, the target entity shows the records whose
 *   reference points at a record as a read-only back-reference. Nothing new is stored: the back-reference is a records
 *   query over the (indexed) reference field.
 * - many-to-many through a `relation` field: links are rows of `app_record_links` (relation id
 *   `<source entity id>:<field>`, from, to, position), never values of the record. With `inverse` the target entity
 *   shows a back-reference, which `twoWay` makes editable from that side too. A self-relation targets its own entity;
 *   `symmetric` keeps a self-relation's link in both directions, so it reads the same from both records.
 *
 * Access. A link is never a way to see a record: every read of related records (the lists, the entity API's expand,
 * the Records table's summaries, filters and counts) keeps only links whose other end the reader may read now, through
 * the same rules as every record read (the other entity's grant with its row policies and group scope, the reader's
 * clearance, hidden records). Counts are of those visible links only, so a hidden link is neither shown nor counted.
 * The relation field is subject to field policies like any field (read and unmasked to see links, create or update
 * to change them); a back-reference also needs read on the declaring entity's field. Adding a link needs
 * `records:write`, the record readable and its field writable, and the other record readable: an unreadable target is
 * "not found", whether it exists or not. The one integrity rule that counts hidden links is `max`, as it must hold for
 * everyone: a refusal says only that the record has as many links as it may hold.
 *
 * Integrity. Deleting a record removes its links in the same transaction and audits `app.record.unlinked` (reason
 * `deleted`), unless a relation it takes part in says `onDelete: block`, which refuses the delete while any link
 * exists. Removing a relation field or an entity removes its links (`app.relation.cleared`) through the design path,
 * which records the schema version. Links are not record values, so they never change a record's version; a record
 * write that sets them (`values.<relation>` as a list of ids, replacing the links the writer can see) happens in the
 * same transaction as the versioned update, so a stale version still writes nothing.
 */

export type RelationField = Extract<Field, { type: 'relation' }>;
export type ReferenceField = Extract<Field, { type: 'reference' }>;

/** One end of a relation as seen from `entity`. */
export interface RelationEnd {
  /** `<source entity id>:<field>`, the `relation_id` of its links. */
  id: string;
  kind: 'relation' | 'reference';
  /** Its name on `entity`: the declaring field, or the inverse (back-reference). */
  name: string;
  title: string;
  side: 'forward' | 'inverse';
  entity: EntityRow;
  /** The entity at the other end (the same one for a self-relation). */
  other: EntityRow;
  /** The entity that declares the field. */
  source: EntityRow;
  field: RelationField | ReferenceField;
  /** Links may be added and removed from this end (a relation's own field; an inverse when two-way). */
  editable: boolean;
  /** The column of the link holding this end's record, and the other end's. */
  self: 'from_id' | 'to_id';
  peer: 'from_id' | 'to_id';
}

export const relationId = (sourceEntityId: string, field: string): string => `${sourceEntityId}:${field}`;

/** Links one list or summary reads at most per page. */
export const LINK_PAGE_MAX = 100;
/** Records the entity API expands per relation and record at most. */
export const EXPAND_MAX = 50;
/** Links one write may set or one reorder may order. */
const SET_MAX = 1000;

const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

/** The relation ends of `entity`: its relation fields, and the back-references other fields (and its own) declare. */
export function endsOf(entity: EntityRow, entities: readonly EntityRow[]): RelationEnd[] {
  const out: RelationEnd[] = [];
  const byName = new Map(entities.map((e) => [e.name, e]));
  for (const f of entity.definition.fields) {
    if (f.type !== 'relation') continue;
    const other = byName.get(f.entity);
    if (!other) continue;
    out.push({ id: relationId(entity.id, f.name), kind: 'relation', name: f.name, title: f.title ?? f.name, side: 'forward', entity, other, source: entity, field: f, editable: true, self: 'from_id', peer: 'to_id' });
  }
  for (const src of entities) {
    for (const f of src.definition.fields) {
      if ((f.type !== 'relation' && f.type !== 'reference') || f.entity !== entity.name || !f.inverse) continue;
      out.push({ id: relationId(src.id, f.name), kind: f.type, name: f.inverse, title: f.inverseTitle ?? f.inverse, side: 'inverse', entity, other: src, source: src, field: f, editable: f.type === 'relation' && f.twoWay, self: 'to_id', peer: 'from_id' });
    }
  }
  return out;
}

/**
 * Problems of a whole design's relations (entities by name, with the definitions they would have): an inverse whose
 * name another field or inverse of the target already has, and symmetric relations that are not self-relations.
 */
export function relationProblems(entities: readonly { name: string; definition: EntityDefinition }[]): string[] {
  const problems: string[] = [];
  const byName = new Map(entities.map((e) => [e.name, e]));
  const taken = new Map<string, Map<string, string>>();
  for (const e of entities) taken.set(e.name, new Map(e.definition.fields.map((f) => [f.name, `the field ${f.name}`])));
  for (const e of entities) {
    for (const f of e.definition.fields) {
      if (f.type === 'relation' && f.symmetric && f.entity !== e.name) problems.push(`${e.name}.${f.name}: only a self-relation (to ${e.name}) can be symmetric.`);
      if ((f.type !== 'relation' && f.type !== 'reference') || !f.inverse) continue;
      const names = taken.get(f.entity);
      if (!names || !byName.has(f.entity)) continue;
      const seen = names.get(f.inverse);
      if (seen) problems.push(`${e.name}.${f.name}: ${f.entity} already has ${seen} named ${f.inverse}; give the back-reference (inverse) another name.`);
      else names.set(f.inverse, `the back-reference of ${e.name}.${f.name}`);
    }
  }
  return problems;
}

/** The text a record is shown by: its title field, else its id. */
export function titleOf(entity: EntityRow, id: string, values: Values): string {
  const t = titleFieldOf(entity.definition);
  const v = t ? values[t] : null;
  return v == null || v === '' ? id : String(v);
}

interface LinkRow {
  id: string;
  tenant_id: string;
  app_id: string;
  relation_id: string;
  from_id: string;
  to_id: string;
  position: number;
  created_by: string | null;
  created_at: number;
}

/** Link changes a record write makes, checked before its transaction and written inside it. */
export interface LinkPlan {
  add: LinkRow[];
  remove: { relation_id: string; from_id: string; to_id: string }[];
  /** Per end, for the audit after the write. */
  audit: { end: RelationEnd; added: string[]; removed: string[] }[];
}

/** What deleting records takes with it: the links per relation, read before the transaction. */
export interface UnlinkPlan {
  relations: { id: string; field: string; source: string; column: 'from_id' | 'to_id' }[];
}

export class AppRelations {
  constructor(
    private readonly s: () => Services,
    private readonly apps: AppService
  ) {}

  private get db() {
    return this.s().db;
  }

  private labels(p: Principal): Label[] {
    return LABELS.filter((l) => clears(p.clearance, l));
  }

  private ctxOf(entity: EntityRow): QueryContext {
    return { db: this.db, def: entity.definition, entityId: entity.id, pg: this.s().cfg.DB_CLIENT === 'pg' };
  }

  private audit(actor: Actor, tenantId: string, action: string, target: Record<string, unknown>, label: Label, detail: Record<string, unknown>) {
    const who = actor.principal ? actorFrom(actor.principal, actor.ip ?? null) : { service: actor.service ?? 'apps' };
    return this.s().audit.append({ tenantId, action, kind: actor.principal ? 'admin' : 'system', actor: who, target, label, detail, traceId: actor.traceId ?? null });
  }

  async ends(app: AppRow, entity: EntityRow): Promise<RelationEnd[]> {
    return endsOf(entity, await this.apps.entities(app));
  }

  async end(app: AppRow, entity: EntityRow, name: string): Promise<RelationEnd> {
    const e = (await this.ends(app, entity)).find((x) => x.name === name);
    if (!e) throw notFound('Relation');
    return e;
  }

  /** Whether the reader may see this end's links: the field (and for a back-reference the declaring field) readable in full. */
  private checkRead(end: RelationEnd, gSelf: Grant, gOther: Grant): void {
    const own = gSelf.field(end.name);
    if (!own.read || !own.unmasked) throw forbidden(`A policy does not let you read ${end.name}.`, { step: 'policy', field: end.name });
    if (end.side === 'inverse') {
      const decl = gOther.field(end.field.name);
      if (!decl.read || !decl.unmasked) throw forbidden(`A policy does not let you read ${end.source.name}.${end.field.name}, which ${end.name} shows.`, { step: 'policy', field: end.name });
    }
  }

  /** `exists (the other end of l is a record the reader may read [and matches where])`, as `app_records as r`. */
  private visibleOther(p: Principal, end: RelationEnd, gOther: Grant, where?: Filter) {
    const db = this.db;
    const labels = this.labels(p);
    const ctx = this.ctxOf(end.other);
    const filter = AppPolicies.narrow(gOther, where);
    return function (this: Knex.QueryBuilder) {
      this.select(db.raw('1')).from('app_records as r').whereRaw(`r.id = l.${end.peer}`).andWhere('r.tenant_id', p.tenantId).andWhere('r.entity_id', end.other.id).andWhere('r.hidden', false).whereIn('r.label', labels);
      if (filter) applyFilter(this, filter, ctx);
    };
  }

  /** The links of one record on one end that the reader may see (the other end readable). */
  private visibleLinks(p: Principal, end: RelationEnd, gOther: Grant, recordId: string): Knex.QueryBuilder {
    return this.db('app_record_links as l').where('l.relation_id', end.id).andWhere(`l.${end.self}`, recordId).whereExists(this.visibleOther(p, end, gOther));
  }

  // ---------- reading ----------

  /** A page of the records one record is linked to on one end (or, for a reference's back-reference, that point at it). */
  async list(p: Principal, appRef: string, entityRef: string, recordId: string, name: string, o: { limit: number; offset: number }) {
    const { app, entity } = await this.apps.resolve(p, appRef, entityRef);
    const gSelf = await this.apps.grantFor(p, entity);
    await this.apps.readable(p, entity, recordId, gSelf);
    const end = await this.end(app, entity, name);
    const gOther = await this.apps.grantFor(p, end.other);
    this.checkRead(end, gSelf, gOther);
    const info = this.endView(end);
    if (end.kind === 'reference') {
      const page = await this.apps.query(p, app.id, end.other.id, { filter: { field: end.field.name, op: 'eq', value: recordId }, limit: o.limit, offset: o.offset });
      return { ...info, total: page.total ?? 0, limit: o.limit, offset: o.offset, records: page.records.map((r) => ({ ...r, title: titleOf(end.other, r.id, r.values) })) };
    }
    const total = Number(((await this.visibleLinks(p, end, gOther, recordId).count({ n: '*' })) as Record<string, unknown>[])[0]?.n ?? 0);
    const q = this.visibleLinks(p, end, gOther, recordId).select('l.*');
    if (end.side === 'forward') q.orderBy([{ column: 'l.position' }, { column: `l.${end.peer}` }]);
    else q.orderBy([{ column: 'l.created_at' }, { column: 'l.id' }]);
    const links = (await q.limit(o.limit).offset(o.offset)) as LinkRow[];
    const records = await this.records(app, end.other, links.map((l) => l[end.peer]), gOther);
    return {
      ...info,
      total,
      limit: o.limit,
      offset: o.offset,
      records: links.flatMap((l) => {
        const r = records.get(l[end.peer]);
        return r ? [{ ...r, title: titleOf(end.other, r.id, r.values), link: { position: Number(l.position), createdAt: Number(l.created_at), createdBy: l.created_by } }] : [];
      })
    };
  }

  endView(end: RelationEnd) {
    const f = end.field;
    return {
      name: end.name,
      title: end.title,
      kind: end.kind,
      side: end.side,
      entity: end.entity.name,
      other: end.other.name,
      declaredBy: `${end.source.name}.${f.name}`,
      editable: end.editable,
      cardinality: end.kind === 'reference' ? (end.side === 'inverse' ? 'one-to-many' : 'many-to-one') : 'many-to-many',
      ...(f.type === 'relation' ? { required: end.side === 'forward' && f.required, max: end.side === 'forward' ? (f.max ?? null) : null, onDelete: f.onDelete, symmetric: f.symmetric, twoWay: f.twoWay } : {})
    };
  }

  /** Views of records by id, as the reader's grant shows them (the caller has kept only visible ones). */
  private async records(app: AppRow, entity: EntityRow, ids: string[], grant: Grant): Promise<Map<string, RecordView>> {
    if (!ids.length) return new Map();
    const rows = ((await this.db('app_records').where({ tenant_id: app.tenant_id, entity_id: entity.id }).whereIn('id', [...new Set(ids)])) as Record<string, unknown>[]).map(recordFrom);
    const out = new Map<string, RecordView>();
    for (const r of rows) out.set(r.id, await this.apps.view(app, entity, r, undefined, grant));
    return out;
  }

  /**
   * The entity API's `expand` and the Records table's summaries: for each record and each named end, the number of
   * visible links and the first `limit` linked records (one level). Ends the reader may not read are left out.
   */
  async expand(p: Principal, app: AppRow, entity: EntityRow, records: RecordView[], names: string[], limit: number): Promise<(RecordView & { links: Record<string, { total: number; records: (RecordView & { title: string })[] }> })[]> {
    const all = await this.ends(app, entity);
    const unknown = names.filter((n) => !all.some((e) => e.name === n));
    if (unknown.length) throw badRequest(`expand names ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is not a relation' : 'are not relations'} of ${entity.name}. Relations: ${all.map((e) => e.name).join(', ') || 'none'}.`);
    const gSelf = await this.apps.grantFor(p, entity);
    const ends: { end: RelationEnd; gOther: Grant }[] = [];
    for (const n of [...new Set(names)]) {
      const end = all.find((e) => e.name === n)!;
      const gOther = await this.apps.grantFor(p, end.other);
      try {
        this.checkRead(end, gSelf, gOther);
      } catch {
        continue;
      }
      ends.push({ end, gOther });
    }
    const ids = records.map((r) => r.id);
    const per = new Map<string, Record<string, { total: number; records: (RecordView & { title: string })[] }>>(ids.map((id) => [id, {}]));
    for (const { end, gOther } of ends) {
      if (end.kind === 'reference') {
        for (const id of ids) {
          const page = await this.apps.query(p, app.id, end.other.id, { filter: { field: end.field.name, op: 'eq', value: id }, limit, offset: 0 });
          per.get(id)![end.name] = { total: page.total ?? 0, records: page.records.map((r) => ({ ...r, title: titleOf(end.other, r.id, r.values) })) };
        }
        continue;
      }
      const counts = ids.length
        ? ((await this.db('app_record_links as l').where('l.relation_id', end.id).whereIn(`l.${end.self}`, ids).whereExists(this.visibleOther(p, end, gOther)).groupBy(`l.${end.self}`).select(`l.${end.self} as k`).count({ n: '*' })) as { k: string; n: unknown }[])
        : [];
      const total = new Map(counts.map((c) => [String(c.k), Number(c.n)]));
      const pages = new Map<string, LinkRow[]>();
      for (const id of ids) {
        if (!total.get(id)) continue;
        const q = this.visibleLinks(p, end, gOther, id).select('l.*');
        if (end.side === 'forward') q.orderBy([{ column: 'l.position' }, { column: `l.${end.peer}` }]);
        else q.orderBy([{ column: 'l.created_at' }, { column: 'l.id' }]);
        pages.set(id, (await q.limit(limit)) as LinkRow[]);
      }
      const views = await this.records(app, end.other, [...pages.values()].flat().map((l) => l[end.peer]), gOther);
      for (const id of ids) {
        const list = (pages.get(id) ?? []).flatMap((l) => {
          const v = views.get(l[end.peer]);
          return v ? [{ ...v, title: titleOf(end.other, v.id, v.values) }] : [];
        });
        per.get(id)![end.name] = { total: total.get(id) ?? 0, records: list };
      }
    }
    return records.map((r) => ({ ...r, links: per.get(r.id) ?? {} }));
  }

  /**
   * Records of the other end to link, for the add-link picker: searched by title (indexed title fields through the
   * index, else the newest records' titles), through the same query and grant as every read, each marked when it is
   * already linked.
   */
  async candidates(p: Principal, appRef: string, entityRef: string, recordId: string, name: string, q: string | null, limit: number) {
    const { app, entity } = await this.apps.resolve(p, appRef, entityRef);
    const gSelf = await this.apps.grantFor(p, entity);
    await this.apps.readable(p, entity, recordId, gSelf);
    const end = await this.end(app, entity, name);
    const gOther = await this.apps.grantFor(p, end.other);
    this.checkRead(end, gSelf, gOther);
    if (!end.editable) throw conflict(`${end.name} is a read-only back-reference; links are made from ${end.source.name}.${end.field.name}.`);
    const t = titleFieldOf(end.other.definition);
    const tf = t ? end.other.definition.fields.find((f) => f.name === t) : undefined;
    const needle = q?.trim() ? q.trim().normalize('NFC').toLowerCase() : null;
    const byIndex = !!needle && !!tf && (tf.indexed || tf.unique);
    const page = await this.apps.query(p, app.id, end.other.id, { ...(byIndex ? { filter: { field: t!, op: 'contains', value: q!.trim() } } : {}), sort: tf && (tf.indexed || tf.unique) ? [{ field: t!, dir: 'asc' }] : [{ field: 'updatedAt', dir: 'desc' }], limit: needle && !byIndex ? 200 : limit, offset: 0, count: false });
    const found = page.records.map((r) => ({ id: r.id, title: titleOf(end.other, r.id, r.values), label: r.label, state: r.state })).filter((r) => !needle || byIndex || r.title.toLowerCase().includes(needle) || r.id.toLowerCase() === needle).filter((r) => !(end.other.id === entity.id && r.id === recordId)).slice(0, limit);
    const linked = found.length ? new Set(((await this.db('app_record_links').where({ relation_id: end.id, [end.self]: recordId }).whereIn(end.peer, found.map((f) => f.id)).select(end.peer)) as Record<string, string>[]).map((x) => x[end.peer]!)) : new Set<string>();
    return { ...this.endView(end), candidates: found.map((f) => ({ ...f, linked: linked.has(f.id) })) };
  }

  // ---------- query scopes ----------

  /**
   * The link scopes a records query needs: one per relation end its filter, sort or metrics name (`end` or
   * `end.count`), each over the links whose other end the reader may read. A `matches` filter's `where` is a filter of
   * the other entity, read through that entity's grant (its fields must be readable there), one level deep.
   */
  async scopes(p: Principal, app: AppRow, entity: EntityRow, filter: Filter | undefined, fields: string[]): Promise<Map<string, LinkScope> | undefined> {
    const named = new Map<string, Filter[]>();
    const walk = (f: Filter) => {
      if ('field' in f) {
        const base = f.field.endsWith('.count') ? f.field.slice(0, -'.count'.length) : f.field;
        named.set(base, [...(named.get(base) ?? []), ...(f.where ? [f.where] : [])]);
      } else if ('not' in f) walk(f.not);
      else ('and' in f ? f.and : f.or).forEach(walk);
    };
    if (filter) walk(filter);
    for (const n of fields) {
      const base = n.endsWith('.count') ? n.slice(0, -'.count'.length) : n;
      if (!named.has(base)) named.set(base, []);
    }
    if (!named.size) return undefined;
    const ends = (await this.ends(app, entity)).filter((e) => named.has(e.name));
    if (!ends.length) return undefined;
    const gSelf = await this.apps.grantFor(p, entity);
    const out = new Map<string, LinkScope>();
    for (const end of ends) {
      if (end.kind === 'reference') throw badRequest(`${end.name} is the back-reference of the reference ${end.source.name}.${end.field.name}; filter ${end.source.name} by ${end.field.name} instead.`);
      const gOther = await this.apps.grantFor(p, end.other);
      this.checkRead(end, gSelf, gOther);
      for (const w of named.get(end.name) ?? []) {
        checkFilterSize(w);
        AppPolicies.checkReadable(gOther, w, undefined);
      }
      out.set(end.name, this.scope(p, end, gOther));
    }
    return out;
  }

  private scope(p: Principal, end: RelationEnd, gOther: Grant): LinkScope {
    const db = this.db;
    const visible = (where?: Filter) => this.visibleOther(p, end, gOther, where);
    return {
      exists(q, o) {
        const sub = function (this: Knex.QueryBuilder) {
          this.select(db.raw('1')).from('app_record_links as l').where('l.relation_id', end.id).whereRaw(`l.${end.self} = r.id`);
          if (o.ids) this.whereIn(`l.${end.peer}`, o.ids);
          this.whereExists(visible(o.where));
        };
        if (o.negate) q.whereNotExists(sub);
        else q.whereExists(sub);
      },
      count() {
        const c = db('app_record_links as l').select(db.raw('count(*)')).where('l.relation_id', end.id).whereRaw(`l.${end.self} = r.id`).whereExists(visible()).toSQL();
        return { sql: c.sql, bindings: c.bindings };
      }
    };
  }

  // ---------- writing ----------

  /** The record and end a link change starts from, with the checks every change shares. */
  private async start(actor: Actor & { principal: Principal }, app: AppRow, entity: EntityRow, recordId: string, name: string) {
    const p = actor.principal;
    const gSelf = await this.apps.grantFor(p, entity);
    const record = await this.apps.readable(p, entity, recordId, gSelf);
    const end = await this.end(app, entity, name);
    const gOther = await this.apps.grantFor(p, end.other);
    this.checkRead(end, gSelf, gOther);
    if (!end.editable) throw conflict(`${end.name} is a read-only back-reference; links are made from ${end.source.name}.${end.field.name}.`);
    AppPolicies.checkWrite(gSelf, { [end.name]: true }, 'update');
    return { p, gSelf, gOther, record, end, field: end.field as RelationField };
  }

  /** The link's from and to for `record` on `end` and the other record. */
  private pair(end: RelationEnd, recordId: string, otherId: string): { from_id: string; to_id: string } {
    return end.self === 'from_id' ? { from_id: recordId, to_id: otherId } : { from_id: otherId, to_id: recordId };
  }

  private async countFrom(trx: Knex | Knex.Transaction, relation: string, fromId: string): Promise<number> {
    return Number(((await trx('app_record_links').where({ relation_id: relation, from_id: fromId }).count({ n: '*' })) as Record<string, unknown>[])[0]?.n ?? 0);
  }

  private async nextPosition(trx: Knex | Knex.Transaction, relation: string, fromId: string): Promise<number> {
    const r = (await trx('app_record_links').where({ relation_id: relation, from_id: fromId }).max({ m: 'position' }).first()) as { m: number | string | null } | undefined;
    return r?.m == null ? 0 : Number(r.m) + 1;
  }

  /** Adds one link (idempotent: an existing link is returned as it is). */
  async add(actor: Actor & { principal: Principal }, app: AppRow, entity: EntityRow, recordId: string, name: string, otherId: string) {
    const { p, gOther, record, end, field } = await this.start(actor, app, entity, recordId, name);
    if (!ID.test(otherId)) throw badRequest('The record to link is a record id.');
    const other = await this.apps.readable(p, end.other, otherId.toUpperCase(), gOther).catch((err: unknown) => {
      if (err instanceof HttpProblem && err.status === 404) throw notFound(`${end.other.title} record`);
      throw err;
    });
    if (other.id === record.id) throw badRequest('A record is not linked to itself.');
    const pair = this.pair(end, record.id, other.id);
    const existing = (await this.db('app_record_links').where({ relation_id: end.id, ...pair }).first()) as LinkRow | undefined;
    if (existing) return { created: false, ...(await this.linkView(app, end, gOther, existing)) };
    const t = Date.now();
    const rows: LinkRow[] = [];
    await this.db.transaction(async (trx) => {
      for (const pr of field.symmetric ? [pair, { from_id: pair.to_id, to_id: pair.from_id }] : [pair]) {
        if (field.max != null && (await this.countFrom(trx, end.id, pr.from_id)) >= field.max) throw conflict(`The ${pr.from_id === record.id ? 'record' : `${end.other.title} record`} already holds the most links ${field.name} allows (${field.max}).`);
        rows.push({ id: ulid(), tenant_id: app.tenant_id, app_id: app.id, relation_id: end.id, ...pr, position: await this.nextPosition(trx, end.id, pr.from_id), created_by: p.userId, created_at: t });
      }
      await trx('app_record_links').insert(rows);
    });
    await this.audit(actor, app.tenant_id, 'app.record.linked', { app: app.id, entity: entity.id, record: record.id, relation: end.id }, highest(record.label, other.label), { field: end.name, side: end.side, other: other.id, otherEntity: end.other.name, ...(field.symmetric ? { symmetric: true } : {}) });
    return { created: true, ...(await this.linkView(app, end, gOther, rows[0]!)) };
  }

  private async linkView(app: AppRow, end: RelationEnd, gOther: Grant, l: LinkRow) {
    const v = (await this.records(app, end.other, [l[end.peer]], gOther)).get(l[end.peer]);
    return { relation: end.name, record: l[end.self], position: Number(l.position), createdAt: Number(l.created_at), createdBy: l.created_by, linked: v ? { ...v, title: titleOf(end.other, v.id, v.values) } : null };
  }

  /** Removes one link the reader can see. */
  async remove(actor: Actor & { principal: Principal }, app: AppRow, entity: EntityRow, recordId: string, name: string, otherId: string): Promise<void> {
    const { p, gOther, record, end, field } = await this.start(actor, app, entity, recordId, name);
    if (!ID.test(otherId)) throw notFound('Link');
    const id = otherId.toUpperCase();
    const pair = this.pair(end, record.id, id);
    const link = (await this.visibleLinks(p, end, gOther, record.id).where(`l.${end.peer}`, id).first('l.*')) as LinkRow | undefined;
    if (!link) throw notFound('Link');
    if (field.required) {
      // at least one link, as the record the relation belongs to has them in the reader's sight (no hidden link is told)
      const holders = field.symmetric ? [pair.from_id, pair.to_id] : [pair.from_id];
      for (const holder of holders) {
        const fwd = { ...end, self: 'from_id' as const, peer: 'to_id' as const, other: end.side === 'forward' ? end.other : end.entity };
        const g = end.side === 'forward' ? gOther : await this.apps.grantFor(p, entity);
        const n = Number(((await this.visibleLinks(p, fwd, g, holder).count({ n: '*' })) as Record<string, unknown>[])[0]?.n ?? 0);
        if (n <= 1) throw conflict(`${field.title ?? field.name} needs at least one link; add another before removing this one.`);
      }
    }
    await this.db.transaction(async (trx) => {
      await trx('app_record_links').where({ relation_id: end.id, ...pair }).delete();
      if (field.symmetric) await trx('app_record_links').where({ relation_id: end.id, from_id: pair.to_id, to_id: pair.from_id }).delete();
    });
    const other = (await this.db('app_records').where({ id }).first('label')) as { label: Label } | undefined;
    await this.audit(actor, app.tenant_id, 'app.record.unlinked', { app: app.id, entity: entity.id, record: record.id, relation: end.id }, highest(record.label, other?.label ?? record.label), { field: end.name, side: end.side, other: id, otherEntity: end.other.name, reason: 'removed' });
  }

  /** Puts the links the reader can see in the given order (a relation's own field only); hidden links keep their places. */
  async reorder(actor: Actor & { principal: Principal }, app: AppRow, entity: EntityRow, recordId: string, name: string, order: string[]) {
    const { p, gOther, record, end } = await this.start(actor, app, entity, recordId, name);
    if (end.side !== 'forward') throw conflict(`${end.name} is a back-reference; its links are ordered on ${end.source.name}.${end.field.name}.`);
    const ids = order.map((x) => x.toUpperCase());
    if (new Set(ids).size !== ids.length) throw badRequest('A record appears twice in the order.');
    const visible = (await this.visibleLinks(p, end, gOther, record.id).select('l.*').limit(SET_MAX + 1)) as LinkRow[];
    if (visible.length > SET_MAX) throw badRequest(`More than ${SET_MAX} links; they cannot be reordered in one request.`);
    const have = new Set(visible.map((l) => l.to_id));
    if (ids.length !== have.size || ids.some((x) => !have.has(x))) throw conflict('The links changed since you read them; read them again and send every linked record once.');
    const positions = visible.map((l) => Number(l.position)).sort((a, b) => a - b);
    const byTo = new Map(visible.map((l) => [l.to_id, l]));
    await this.db.transaction(async (trx) => {
      for (const [i, to] of ids.entries()) {
        const l = byTo.get(to)!;
        if (Number(l.position) !== positions[i]) await trx('app_record_links').where({ id: l.id }).update({ position: positions[i] });
      }
    });
    await this.audit(actor, app.tenant_id, 'app.record.links.reordered', { app: app.id, entity: entity.id, record: record.id, relation: end.id }, record.label, { field: end.name, links: ids.length });
    return this.list(p, app.id, entity.id, record.id, end.name, { limit: Math.min(LINK_PAGE_MAX, ids.length || 1), offset: 0 });
  }

  // ---------- links set by a record write ----------

  /** The values a record write gives for its relation ends (lists of ids), taken out of the values. */
  splitValues(entity: EntityRow, ends: RelationEnd[], values: Values): { values: Values; links: Map<string, string[]> } {
    const rest: Values = {};
    const links = new Map<string, string[]>();
    const editable = new Map(ends.filter((e) => e.kind === 'relation' && e.editable).map((e) => [e.name, e]));
    for (const [k, v] of Object.entries(values)) {
      if (!editable.has(k)) {
        rest[k] = v;
        continue;
      }
      const list = v == null || v === '' ? [] : Array.isArray(v) ? v : [v];
      if (list.length > SET_MAX || list.some((x) => typeof x !== 'string' || !ID.test(x))) throw new HttpProblem(400, 'Invalid record', `${k}: links are a list of at most ${SET_MAX} record ids.`, { extensions: { problems: [{ field: k, message: `links are a list of at most ${SET_MAX} record ids` }] } });
      links.set(k, [...new Set((list as string[]).map((x) => x.toUpperCase()))]);
    }
    void entity;
    return { values: rest, links };
  }

  /**
   * Checks the links a record write sets (`links`: per end, the ids it should be linked to, replacing those the
   * writer can see) and plans the changes. `existing` is false for a new record. Required relations are checked on a
   * new record unless `skipRequired` (records of a package, whose links come after them).
   */
  async plan(actor: Actor, app: AppRow, entity: EntityRow, ends: RelationEnd[], recordId: string, links: Map<string, string[]>, o: { existing: boolean; skipRequired?: boolean }): Promise<LinkPlan> {
    const plan: LinkPlan = { add: [], remove: [], audit: [] };
    const problems: { field: string; message: string }[] = [];
    const p = actor.principal;
    if (!o.existing && !o.skipRequired) {
      for (const e of ends) if (e.side === 'forward' && e.kind === 'relation' && e.field.required && !(links.get(e.name)?.length)) problems.push({ field: e.name, message: 'needs at least one link' });
    }
    if (links.size && !p) problems.push({ field: [...links.keys()][0]!, message: 'links can only be set by a signed-in person' });
    if (problems.length || !p) {
      if (problems.length) throw new HttpProblem(400, 'Invalid record', problems.map((x) => `${x.field}: ${x.message}`).join('; '), { extensions: { problems } });
      return plan;
    }
    const t = Date.now();
    const positions = new Map<string, number>();
    for (const [name, wanted] of links) {
      const end = ends.find((e) => e.name === name)!;
      const field = end.field as RelationField;
      const gOther = await this.apps.grantFor(p, end.other);
      const gSelf = await this.apps.grantFor(p, entity);
      try {
        this.checkRead(end, gSelf, gOther);
      } catch (err) {
        problems.push({ field: name, message: (err as Error).message });
        continue;
      }
      const current = o.existing ? ((await this.visibleLinks(p, end, gOther, recordId).select(`l.${end.peer} as id`).limit(SET_MAX + 1)) as { id: string }[]).map((x) => x.id) : [];
      const want = new Set(wanted);
      const add = wanted.filter((x) => !current.includes(x));
      const remove = current.filter((x) => !want.has(x));
      for (const id of add) {
        if (id === recordId) {
          problems.push({ field: name, message: 'a record is not linked to itself' });
          continue;
        }
        const ok = await this.apps.readable(p, end.other, id, gOther).then(
          () => true,
          () => false
        );
        if (!ok) problems.push({ field: name, message: `refers to a ${end.other.name} record that does not exist` });
      }
      if (field.required && !wanted.length && (end.side === 'forward' || field.symmetric)) problems.push({ field: name, message: 'needs at least one link' });
      if (problems.length) continue;
      const pairs = (ids: string[]) => ids.flatMap((id) => {
        const pr = this.pair(end, recordId, id);
        return field.symmetric ? [pr, { from_id: pr.to_id, to_id: pr.from_id }] : [pr];
      });
      const adds = pairs(add);
      const removes = pairs(remove);
      if (field.max != null) {
        const holders = new Set(adds.map((x) => x.from_id));
        for (const h of holders) {
          const n = o.existing || h !== recordId ? await this.countFrom(this.db, end.id, h) : 0;
          const after = n + adds.filter((x) => x.from_id === h).length - removes.filter((x) => x.from_id === h).length;
          if (after > field.max) problems.push({ field: name, message: h === recordId ? `takes at most ${field.max} links` : `a ${end.other.name} record already holds the most links ${field.name} allows (${field.max})` });
        }
      }
      for (const pr of adds) {
        const key = `${end.id}\n${pr.from_id}`;
        const next = positions.has(key) ? positions.get(key)! : o.existing || pr.from_id !== recordId ? await this.nextPosition(this.db, end.id, pr.from_id) : 0;
        positions.set(key, next + 1);
        plan.add.push({ id: ulid(), tenant_id: app.tenant_id, app_id: app.id, relation_id: end.id, ...pr, position: next, created_by: p.userId, created_at: t });
      }
      plan.remove.push(...removes.map((x) => ({ relation_id: end.id, ...x })));
      if (add.length || remove.length) plan.audit.push({ end, added: add, removed: remove });
    }
    if (problems.length) throw new HttpProblem(400, 'Invalid record', problems.map((x) => `${x.field}: ${x.message}`).join('; '), { extensions: { problems } });
    return plan;
  }

  /** Writes a plan inside the record write's transaction. */
  async write(trx: Knex.Transaction, plan: LinkPlan): Promise<void> {
    for (const r of plan.remove) await trx('app_record_links').where(r).delete();
    for (const r of plan.add) {
      const dup = await trx('app_record_links').where({ relation_id: r.relation_id, from_id: r.from_id, to_id: r.to_id }).first('id');
      if (!dup) await trx('app_record_links').insert(r);
    }
  }

  /** Audits a written plan: one `app.record.linked` and one `app.record.unlinked` per end that changed. */
  async audited(actor: Actor, app: AppRow, entity: EntityRow, record: Pick<RecordRow, 'id' | 'label'>, plan: LinkPlan): Promise<void> {
    for (const a of plan.audit) {
      const target = { app: app.id, entity: entity.id, record: record.id, relation: a.end.id };
      if (a.added.length) await this.audit(actor, app.tenant_id, 'app.record.linked', target, highest(record.label, a.end.other.label), { field: a.end.name, side: a.end.side, others: a.added.slice(0, 500), otherEntity: a.end.other.name, via: 'record write' });
      if (a.removed.length) await this.audit(actor, app.tenant_id, 'app.record.unlinked', target, highest(record.label, a.end.other.label), { field: a.end.name, side: a.end.side, others: a.removed.slice(0, 500), otherEntity: a.end.other.name, reason: 'record write' });
    }
  }

  // ---------- deletes ----------

  /**
   * Before records of `entity` are deleted: refuses when a relation they take part in blocks deletes and any of them
   * has a link there (every link counts: the rule holds for everyone), and returns what the delete removes.
   */
  async beforeDelete(app: AppRow, entity: EntityRow, ids: string[], o: { block: boolean } = { block: true }): Promise<UnlinkPlan> {
    // every relation the entity's records take part in, with or without a back-reference: as the source (from), as
    // the target (to), and both for a symmetric self-relation
    const touching: { id: string; field: RelationField; source: string; column: 'from_id' | 'to_id' }[] = [];
    for (const src of await this.apps.entities(app)) {
      for (const f of src.definition.fields) {
        if (f.type !== 'relation') continue;
        const id = relationId(src.id, f.name);
        if (src.id === entity.id) touching.push({ id, field: f, source: src.name, column: 'from_id' });
        if (f.entity === entity.name) touching.push({ id, field: f, source: src.name, column: 'to_id' });
      }
    }
    for (const t of touching) {
      if (!o.block || t.field.onDelete !== 'block' || !ids.length) continue;
      const hit = (await this.db('app_record_links').where('relation_id', t.id).whereIn(t.column, ids).first(t.column)) as Record<string, string> | undefined;
      if (hit) throw new HttpProblem(409, 'Linked record', `The record ${hit[t.column]} is linked through ${t.source}.${t.field.name}, which blocks deletes while links exist; remove its links first.`, { extensions: { relation: `${t.source}.${t.field.name}`, record: hit[t.column] } });
    }
    return { relations: touching.map((t) => ({ id: t.id, field: t.field.name, source: t.source, column: t.column })) };
  }

  /** Removes the links of deleted records inside the delete's transaction; returns the count per relation. */
  async unlink(trx: Knex.Transaction, plan: UnlinkPlan, ids: string[]): Promise<{ relation: string; field: string; source: string; links: number }[]> {
    const out: { relation: string; field: string; source: string; links: number }[] = [];
    if (!ids.length) return out;
    for (const r of plan.relations) {
      let n = 0;
      for (let i = 0; i < ids.length; i += 500) n += Number(await trx('app_record_links').where('relation_id', r.id).whereIn(r.column, ids.slice(i, i + 500)).delete());
      const prev = out.find((x) => x.relation === r.id);
      if (prev) prev.links += n;
      else if (n) out.push({ relation: r.id, field: r.field, source: r.source, links: n });
    }
    return out;
  }

  /** Audits the links a delete removed. */
  async auditDeleted(actor: Actor, app: AppRow, entity: EntityRow, records: Pick<RecordRow, 'id' | 'label'>[], removed: { relation: string; field: string; source: string; links: number }[]): Promise<void> {
    if (!removed.length) return;
    await this.audit(actor, app.tenant_id, 'app.record.unlinked', { app: app.id, entity: entity.id, ...(records.length === 1 ? { record: records[0]!.id } : {}) }, highest(entity.label, ...records.map((r) => r.label)), { reason: 'deleted', records: records.map((r) => r.id).slice(0, 500), relations: removed.map((r) => ({ relation: `${r.source}.${r.field}`, links: r.links })) });
  }

  // ---------- design changes ----------

  /** The links of the given relations (`<source entity id>:<field>`), to report and clear. */
  async countOf(relationIds: string[]): Promise<Map<string, number>> {
    if (!relationIds.length) return new Map();
    const rows = (await this.db('app_record_links').whereIn('relation_id', relationIds).groupBy('relation_id').select('relation_id').count({ n: '*' })) as { relation_id: string; n: unknown }[];
    return new Map(rows.map((r) => [r.relation_id, Number(r.n)]));
  }

  /** Removes every link of the given relations (a relation field or its entity removed). */
  async clear(trx: Knex.Transaction | Knex, relationIds: string[]): Promise<void> {
    if (relationIds.length) await trx('app_record_links').whereIn('relation_id', relationIds).delete();
  }

  /** Audits a relation's links cleared by a design change. */
  async auditCleared(actor: Actor, app: AppRow, entity: EntityRow, cleared: { field: string; links: number; why: string }[]): Promise<void> {
    for (const c of cleared) await this.audit(actor, app.tenant_id, 'app.relation.cleared', { app: app.id, entity: entity.id, relation: relationId(entity.id, c.field) }, entity.label, { field: c.field, links: c.links, why: c.why });
  }

  /** What a definition change does to relations that hold links: refused when it would change what a link means. */
  async checkChange(entity: EntityRow, after: EntityDefinition): Promise<{ cleared: string[] }> {
    const before = entity.definition.fields.filter((f): f is RelationField => f.type === 'relation');
    if (!before.length) return { cleared: [] };
    const counts = await this.countOf(before.map((f) => relationId(entity.id, f.name)));
    const cleared: string[] = [];
    for (const f of before) {
      const n = counts.get(relationId(entity.id, f.name)) ?? 0;
      const now = after.fields.find((x) => x.name === f.name);
      if (!now || now.type !== 'relation') {
        if (n) cleared.push(f.name);
        continue;
      }
      if (!n) continue;
      if (now.entity !== f.entity) throw conflict(`${f.name} holds ${n} link${n === 1 ? '' : 's'} to ${f.entity}; its target cannot change. Remove the field (which removes its links) and add a new one.`);
      if (now.symmetric !== f.symmetric) throw conflict(`${f.name} holds ${n} link${n === 1 ? '' : 's'}; it cannot become ${now.symmetric ? 'symmetric' : 'one-directional'} while it has links.`);
      if (now.max != null && now.max < (f.max ?? Number.POSITIVE_INFINITY)) {
        const over = (await this.db('app_record_links').where({ relation_id: relationId(entity.id, f.name) }).groupBy('from_id').select('from_id').count({ n: '*' }).havingRaw('count(*) > ?', [now.max]).first()) as { from_id: string } | undefined;
        if (over) throw conflict(`The record ${over.from_id} holds more than ${now.max} links in ${f.name}; remove some before lowering max.`);
      }
    }
    return { cleared };
  }

  // ---------- packages ----------

  /** The links of an app's relations among exported records, by relation (`<entity>.<field>`), in their order. */
  async exportLinks(entities: readonly EntityRow[], recordIds: ReadonlySet<string>): Promise<{ relation: string; from: string; to: string }[]> {
    const out: { relation: string; from: string; to: string }[] = [];
    const rels = entities.flatMap((e) => e.definition.fields.filter((f) => f.type === 'relation').map((f) => ({ key: `${e.name}.${f.name}`, id: relationId(e.id, f.name) })));
    rels.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const r of rels) {
      const rows = (await this.db('app_record_links').where({ relation_id: r.id }).orderBy([{ column: 'from_id' }, { column: 'position' }, { column: 'to_id' }]).select('from_id', 'to_id')) as { from_id: string; to_id: string }[];
      for (const l of rows) if (recordIds.has(l.from_id) && recordIds.has(l.to_id)) out.push({ relation: r.key, from: l.from_id, to: l.to_id });
    }
    return out;
  }

  /** Imports a package's links between records it created (`idMap`: the package's ids to the new ones). */
  async importLinks(actor: Actor & { principal: Principal }, app: AppRow, entities: readonly EntityRow[], links: readonly { relation: string; from: string; to: string }[], idMap: ReadonlyMap<string, string>): Promise<{ created: number; skipped: number }> {
    const byKey = new Map<string, { id: string; entity: EntityRow }>(entities.flatMap((e) => e.definition.fields.filter((f) => f.type === 'relation').map((f) => [`${e.name}.${f.name}`, { id: relationId(e.id, f.name), entity: e }] as const)));
    let created = 0;
    let skipped = 0;
    const positions = new Map<string, number>();
    const rows: LinkRow[] = [];
    const t = Date.now();
    for (const l of links) {
      const rel = byKey.get(l.relation);
      const from = idMap.get(l.from);
      const to = idMap.get(l.to);
      if (!rel || !from || !to) {
        skipped++;
        continue;
      }
      const key = `${rel.id}\n${from}`;
      const pos = positions.get(key) ?? 0;
      positions.set(key, pos + 1);
      rows.push({ id: ulid(), tenant_id: app.tenant_id, app_id: app.id, relation_id: rel.id, from_id: from, to_id: to, position: pos, created_by: actor.principal.userId, created_at: t });
    }
    if (rows.length) {
      await this.db.transaction(async (trx) => {
        for (let i = 0; i < rows.length; i += 200) {
          const chunk = rows.slice(i, i + 200);
          await trx('app_record_links').insert(chunk);
          created += chunk.length;
        }
      });
      await this.audit(actor, app.tenant_id, 'app.record.linked', { app: app.id }, app.label, { via: 'package', links: created, skipped });
    }
    return { created, skipped };
  }
}
