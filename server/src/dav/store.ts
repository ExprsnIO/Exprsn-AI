import { createHash } from 'node:crypto';
import type { Knex } from 'knex';
import { ulid } from 'ulid';
import { isLabel, type Label } from '../authz/labels.js';
import type { Services } from '../services.js';

/*
 * Personal calendars and address books (B-3102, B-3103), their objects, the change log behind sync-collection
 * (RFC 6578) and dead properties (PROPPATCH). Object bodies, descriptions and property values are sealed with the
 * tenant key, with the row id (or the resource and property) as associated data.
 */

export type CollectionKind = 'calendar' | 'addressbook';

export interface CollectionRow {
  id: string;
  tenant_id: string;
  owner_id: string;
  kind: CollectionKind;
  slug: string;
  name: string;
  description: string | null;
  color: string | null;
  time_zone: string | null;
  components: string;
  label: Label;
  sync_seq: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface ObjectRow {
  id: string;
  tenant_id: string;
  collection_id: string;
  name: string;
  uid: string;
  etag: string;
  component: string | null;
  starts_at: number | null;
  ends_at: number | null;
  size: number;
  body: string;
  sync_seq: number;
  created_at: number;
  updated_at: number;
}

const n = (v: unknown): number | null => (v == null ? null : Number(v));
const collFrom = (r: Record<string, unknown>): CollectionRow => ({
  ...(r as unknown as CollectionRow),
  label: isLabel(r.label) ? r.label : 'internal',
  sync_seq: Number(r.sync_seq ?? 0),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at),
  deleted_at: n(r.deleted_at)
});
const objFrom = (r: Record<string, unknown>): ObjectRow => ({
  ...(r as unknown as ObjectRow),
  starts_at: n(r.starts_at),
  ends_at: n(r.ends_at),
  size: Number(r.size),
  sync_seq: Number(r.sync_seq),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

/** How long a deletion is remembered for sync-collection; a sync token older than this is refused. */
export const TOMBSTONE_DAYS = 90;

export const etagOf = (body: string | Buffer): string => createHash('sha256').update(body).digest('hex').slice(0, 32);
export const propKey = (clark: string): string => createHash('sha256').update(clark).digest('hex');

export class DavStore {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  // ---------- collections ----------

  async collections(tenantId: string, ownerId: string, kind: CollectionKind): Promise<CollectionRow[]> {
    return ((await this.db('dav_collections').where({ tenant_id: tenantId, owner_id: ownerId, kind }).whereNull('deleted_at').orderBy('created_at')) as Record<string, unknown>[]).map(collFrom);
  }

  async collection(tenantId: string, id: string): Promise<CollectionRow | null> {
    const r = await this.db('dav_collections').where({ tenant_id: tenantId, id }).whereNull('deleted_at').first();
    return r ? collFrom(r) : null;
  }

  /** A user's collection by the href segment it lives at. */
  async bySlug(tenantId: string, ownerId: string, kind: CollectionKind, slug: string): Promise<CollectionRow | null> {
    const r = await this.db('dav_collections').where({ tenant_id: tenantId, owner_id: ownerId, kind, slug }).whereNull('deleted_at').first();
    return r ? collFrom(r) : null;
  }

  async createCollection(input: { tenantId: string; ownerId: string; kind: CollectionKind; slug: string; name: string; description?: string | null; color?: string | null; timeZone?: string | null; components?: string[]; label: Label }): Promise<CollectionRow> {
    const t = Date.now();
    const id = ulid();
    const row = {
      id,
      tenant_id: input.tenantId,
      owner_id: input.ownerId,
      kind: input.kind,
      slug: input.slug.slice(0, 200),
      name: input.name.slice(0, 200),
      description: input.description ? await this.s().keys.seal(input.tenantId, input.description, `dav-collection:${id}`) : null,
      color: input.color ?? null,
      time_zone: input.timeZone ?? null,
      components: (input.components ?? []).join(','),
      label: input.label,
      sync_seq: 0,
      created_at: t,
      updated_at: t,
      deleted_at: null
    };
    await this.db('dav_collections').insert(row);
    return collFrom(row);
  }

  async description(c: CollectionRow): Promise<string | null> {
    return c.description ? ((await this.s().keys.open(c.tenant_id, c.description, `dav-collection:${c.id}`)) ?? null) : null;
  }

  async updateCollection(c: CollectionRow, patch: { name?: string; description?: string | null; color?: string | null; timeZone?: string | null }): Promise<void> {
    const upd: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.name !== undefined) upd.name = patch.name.slice(0, 200);
    if (patch.description !== undefined) upd.description = patch.description ? await this.s().keys.seal(c.tenant_id, patch.description, `dav-collection:${c.id}`) : null;
    if (patch.color !== undefined) upd.color = patch.color?.slice(0, 20) ?? null;
    if (patch.timeZone !== undefined) upd.time_zone = patch.timeZone?.slice(0, 64) ?? null;
    await this.db('dav_collections').where({ id: c.id }).update(upd);
  }

  /** Marks the collection deleted and removes its objects and their properties. */
  async deleteCollection(c: CollectionRow): Promise<void> {
    await this.db.transaction(async (trx) => {
      await trx('dav_collections').where({ id: c.id }).update({ deleted_at: Date.now() });
      await trx('dav_objects').where({ collection_id: c.id }).delete();
      await trx('dav_tombstones').where({ collection_id: c.id }).delete();
      await trx('dav_properties').where({ resource: `coll:${c.id}` }).delete();
    });
  }

  /** Moves the collection's change counter on and returns the new value. */
  private async bump(trx: Knex, collectionId: string): Promise<number> {
    await trx('dav_collections').where({ id: collectionId }).update({ sync_seq: trx.raw('?? + 1', ['sync_seq']), updated_at: Date.now() });
    const r = (await trx('dav_collections').where({ id: collectionId }).first('sync_seq')) as { sync_seq: unknown };
    return Number(r.sync_seq);
  }

  // ---------- objects ----------

  async objects(c: CollectionRow, o: { range?: { start: number; end: number } | null; component?: string | null } = {}): Promise<ObjectRow[]> {
    const q = this.db('dav_objects').where({ collection_id: c.id });
    if (o.component) q.andWhere((w) => w.where({ component: o.component }).orWhereNull('component'));
    if (o.range) {
      q.andWhere((w) => w.whereNull('starts_at').orWhere('starts_at', '<', o.range!.end));
      q.andWhere((w) => w.whereNull('ends_at').orWhere('ends_at', '>=', o.range!.start));
    }
    return ((await q.orderBy('name').limit(20_000)) as Record<string, unknown>[]).map(objFrom);
  }

  async object(c: CollectionRow, name: string): Promise<ObjectRow | null> {
    const r = await this.db('dav_objects').where({ collection_id: c.id, name }).first();
    return r ? objFrom(r) : null;
  }

  async objectsByName(c: CollectionRow, names: string[]): Promise<ObjectRow[]> {
    const out: ObjectRow[] = [];
    for (let i = 0; i < names.length; i += 500) out.push(...((await this.db('dav_objects').where({ collection_id: c.id }).whereIn('name', names.slice(i, i + 500))) as Record<string, unknown>[]).map(objFrom));
    return out;
  }

  async byUid(c: CollectionRow, uid: string): Promise<ObjectRow | null> {
    const r = await this.db('dav_objects').where({ collection_id: c.id, uid }).first();
    return r ? objFrom(r) : null;
  }

  async body(o: ObjectRow): Promise<string> {
    return (await this.s().keys.open(o.tenant_id, o.body, `dav-object:${o.id}`)) ?? '';
  }

  /** Writes an object (new, or replacing the one with the same name); returns its row. */
  async putObject(c: CollectionRow, input: { name: string; uid: string; component: string | null; startsAt: number | null; endsAt: number | null; body: string }, existing: ObjectRow | null): Promise<ObjectRow> {
    const id = existing?.id ?? ulid();
    const sealed = await this.s().keys.seal(c.tenant_id, input.body, `dav-object:${id}`);
    const t = Date.now();
    const etag = etagOf(input.body);
    let row: ObjectRow | null = null;
    await this.db.transaction(async (trx) => {
      const seq = await this.bump(trx, c.id);
      const fields = { uid: input.uid.slice(0, 255), etag, component: input.component, starts_at: input.startsAt, ends_at: input.endsAt, size: Buffer.byteLength(input.body, 'utf8'), body: sealed, sync_seq: seq, updated_at: t };
      if (existing) {
        await trx('dav_objects').where({ id }).update(fields);
        row = { ...existing, ...fields };
      } else {
        const raw = { id, tenant_id: c.tenant_id, collection_id: c.id, name: input.name, created_at: t, ...fields };
        await trx('dav_objects').insert(raw);
        row = objFrom(raw);
      }
    });
    return row!;
  }

  async deleteObject(c: CollectionRow, o: ObjectRow): Promise<void> {
    await this.db.transaction(async (trx) => {
      const seq = await this.bump(trx, c.id);
      await trx('dav_objects').where({ id: o.id }).delete();
      await trx('dav_tombstones').insert({ id: ulid(), tenant_id: c.tenant_id, collection_id: c.id, name: o.name, sync_seq: seq, deleted_at: Date.now() });
      // Tombstones are kept for TOMBSTONE_DAYS; sync tokens older than that are refused (the client syncs afresh).
      await trx('dav_tombstones').where({ collection_id: c.id }).andWhere('deleted_at', '<', Date.now() - TOMBSTONE_DAYS * 86_400_000).delete();
    });
  }

  /** Objects changed and removed since a sync token's counter. */
  async changesSince(c: CollectionRow, seq: number): Promise<{ changed: ObjectRow[]; removed: string[] }> {
    const changed = ((await this.db('dav_objects').where({ collection_id: c.id }).andWhere('sync_seq', '>', seq).orderBy('sync_seq').limit(20_000)) as Record<string, unknown>[]).map(objFrom);
    const tomb = (await this.db('dav_tombstones').where({ collection_id: c.id }).andWhere('sync_seq', '>', seq).select('name')) as { name: string }[];
    const live = new Set(changed.map((o) => o.name));
    return { changed, removed: [...new Set(tomb.map((t) => t.name))].filter((x) => !live.has(x)) };
  }

  // ---------- dead properties ----------

  async properties(tenantId: string, resource: string): Promise<{ ns: string; local: string; value: string }[]> {
    const rows = (await this.db('dav_properties').where({ resource })) as { tenant_id: string; ns: string; local: string; value: string; prop_key: string }[];
    const out = [];
    for (const r of rows) {
      if (r.tenant_id !== tenantId) continue;
      out.push({ ns: r.ns, local: r.local, value: (await this.s().keys.open(tenantId, r.value, `dav-prop:${resource}:${r.prop_key}`)) ?? '' });
    }
    return out;
  }

  async setProperty(tenantId: string, resource: string, ns: string, local: string, value: string): Promise<void> {
    const key = propKey(`{${ns}}${local}`);
    const sealed = await this.s().keys.seal(tenantId, value, `dav-prop:${resource}:${key}`);
    const t = Date.now();
    const n2 = await this.db('dav_properties').where({ resource, prop_key: key }).update({ value: sealed, updated_at: t });
    if (!n2) await this.db('dav_properties').insert({ resource, prop_key: key, tenant_id: tenantId, ns: ns.slice(0, 512), local: local.slice(0, 255), value: sealed, updated_at: t });
  }

  async removeProperty(resource: string, ns: string, local: string): Promise<void> {
    await this.db('dav_properties').where({ resource, prop_key: propKey(`{${ns}}${local}`) }).delete();
  }

  async countProperties(resource: string): Promise<number> {
    const r = (await this.db('dav_properties').where({ resource }).count({ c: '*' }))[0] as { c: unknown };
    return Number(r.c);
  }

  async copyProperties(tenantId: string, from: string, to: string): Promise<void> {
    for (const p of await this.properties(tenantId, from)) await this.setProperty(tenantId, to, p.ns, p.local, p.value);
  }

  async dropProperties(resource: string): Promise<void> {
    await this.db('dav_properties').where({ resource }).delete();
  }
}
