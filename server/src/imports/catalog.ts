import { ulid } from 'ulid';
import type { Knex } from 'knex';
import { json } from '../db/knex.js';
import type { Services } from '../services.js';
import { ADAPTERS } from './adapters/index.js';
import type { RepositoryRow } from './repositories.js';
import { FACETS, RateLimited, REPO_TYPE_INFO, type CatalogItem, type ImportKind } from './types.js';

/*
 * B-3802: browsing a repository. The snapshot is the harvested catalogue; each item's facet values (from the source's
 * own taxonomy) are rows of `import_catalog_facets`. Facet counts are disjunctive: a value's count is the number of
 * items that match the search and every other selected facet, which is exactly how many rows selecting that value
 * returns. A search runs live against the source when it can be searched and is reachable (not rate limited, not
 * air-gapped); the live rows are filtered and counted the same way in memory. When the source rate-limits, the
 * repository backs off and browsing answers from the snapshot until the backoff ends.
 */

export interface BrowseQuery {
  kind: ImportKind;
  q: string;
  facets: Record<string, string>;
  limit: number;
  offset: number;
  live: 'auto' | 'on' | 'off';
}

export interface CatalogRowView {
  itemId: string;
  name: string;
  publisher: string | null;
  description: string | null;
  classification: string | null;
  licence: string | null;
  licenceAllowed: boolean;
  formats: string[];
  gated: boolean;
  sizeBytes: number | null;
  updated: string | null;
  facets: Record<string, string[]>;
  data: Record<string, unknown>;
}

const tokens = (q: string) => q.toLowerCase().split(/\s+/).map((t) => t.trim()).filter(Boolean).slice(0, 8);
const searchText = (it: CatalogItem) => [it.itemId, it.name, it.publisher, it.description?.slice(0, 1000), it.classification, ...Object.values(it.facets).flat()].filter(Boolean).join(' ').toLowerCase().slice(0, 4000);
const likeEscape = (t: string) => t.replace(/[\\%_]/g, (c) => `\\${c}`);

export class CatalogStore {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  /** Replaces a repository's snapshot with the harvested items (one transaction). Returns how many were kept. */
  async replace(r: RepositoryRow, items: CatalogItem[]): Promise<number> {
    const t = Date.now();
    const rows: Record<string, unknown>[] = [];
    const facets: Record<string, unknown>[] = [];
    for (const [i, it] of items.entries()) {
      const id = ulid();
      rows.push({
        id,
        tenant_id: r.tenant_id,
        repository_id: r.id,
        kind: it.kind,
        item_id: it.itemId.slice(0, 300),
        name: (it.name || it.itemId).slice(0, 400),
        publisher: it.publisher?.slice(0, 200) ?? null,
        description: it.description?.slice(0, 4000) ?? null,
        classification: it.classification?.slice(0, 120) ?? null,
        licence: it.licence?.slice(0, 120) ?? null,
        formats: JSON.stringify(it.formats.slice(0, 20)),
        gated: it.gated,
        size_bytes: it.sizeBytes,
        updated: it.updated?.slice(0, 40) ?? null,
        search: searchText(it),
        data: JSON.stringify(it.data ?? {}),
        position: i,
        harvested_at: t
      });
      const seen = new Set<string>();
      for (const [facet, values] of Object.entries(it.facets)) {
        for (const v of values.slice(0, 30)) {
          const value = v.slice(0, 200);
          const k = `${facet}\u0000${value}`;
          if (!value || seen.has(k)) continue;
          seen.add(k);
          facets.push({ catalog_id: id, repository_id: r.id, facet: facet.slice(0, 40), value });
        }
      }
    }
    await this.db.transaction(async (trx) => {
      await trx('import_catalog_facets').where({ repository_id: r.id }).delete();
      await trx('import_catalog').where({ repository_id: r.id }).delete();
      for (let i = 0; i < rows.length; i += 200) await trx('import_catalog').insert(rows.slice(i, i + 200));
      for (let i = 0; i < facets.length; i += 400) await trx('import_catalog_facets').insert(facets.slice(i, i + 400));
    });
    return rows.length;
  }

  /** The snapshot row of one item, or null. */
  async item(r: RepositoryRow, kind: ImportKind, itemId: string): Promise<(CatalogRowView & { harvestedAt: number }) | null> {
    const row = await this.db('import_catalog').where({ repository_id: r.id, kind, item_id: itemId }).first();
    if (!row) return null;
    const allowed = await this.s().imports.allowedLicences(r.tenant_id);
    return { ...(await this.views([row], allowed))[0]!, harvestedAt: Number(row.harvested_at) };
  }

  private async views(rows: Record<string, unknown>[], allowed: Set<string>): Promise<CatalogRowView[]> {
    const ids = rows.map((r) => String(r.id));
    const fs = ids.length ? ((await this.db('import_catalog_facets').whereIn('catalog_id', ids)) as { catalog_id: string; facet: string; value: string }[]) : [];
    const byId = new Map<string, Record<string, string[]>>();
    for (const f of fs) {
      const m = byId.get(f.catalog_id) ?? {};
      (m[f.facet] ??= []).push(f.value);
      byId.set(f.catalog_id, m);
    }
    return rows.map((r) => ({
      itemId: String(r.item_id),
      name: String(r.name),
      publisher: (r.publisher as string | null) ?? null,
      description: (r.description as string | null) ?? null,
      classification: (r.classification as string | null) ?? null,
      licence: (r.licence as string | null) ?? null,
      licenceAllowed: allowed.has(String(r.licence ?? '')),
      formats: json<string[]>(r.formats, []),
      gated: Boolean(r.gated),
      sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes),
      updated: (r.updated as string | null) ?? null,
      facets: byId.get(String(r.id)) ?? {},
      data: json<Record<string, unknown>>(r.data, {})
    }));
  }

  private filtered(r: RepositoryRow, q: BrowseQuery, except: string | null): Knex.QueryBuilder {
    const db = this.db;
    const query = db('import_catalog as c').where({ 'c.repository_id': r.id, 'c.kind': q.kind });
    for (const t of tokens(q.q)) query.andWhereRaw('c.search like ? escape ?', [`%${likeEscape(t)}%`, '\\']);
    for (const [facet, value] of Object.entries(q.facets)) {
      if (facet === except) continue;
      query.whereExists(function () {
        void this.select(db.raw('1')).from('import_catalog_facets as f').whereRaw('f.catalog_id = c.id').andWhere({ 'f.facet': facet, 'f.value': value });
      });
    }
    return query;
  }

  async snapshot(r: RepositoryRow, q: BrowseQuery) {
    const allowed = await this.s().imports.allowedLicences(r.tenant_id);
    const [{ total }] = (await this.filtered(r, q, null).count({ total: '*' })) as { total: number | string }[] as [{ total: number | string }];
    const rows = (await this.filtered(r, q, null).select('c.*').orderBy('c.position').orderBy('c.id').limit(q.limit).offset(q.offset)) as Record<string, unknown>[];
    const facets = [];
    for (const [key, label] of FACETS[q.kind]) {
      const counts = (await this.db('import_catalog_facets as f')
        .where({ 'f.repository_id': r.id, 'f.facet': key })
        .whereIn('f.catalog_id', this.filtered(r, q, key).select('c.id'))
        .groupBy('f.value')
        .select({ value: 'f.value' })
        .countDistinct({ count: 'f.catalog_id' })
        .orderBy('count', 'desc')
        .orderBy('f.value')
        .limit(50)) as { value: string; count: number | string }[];
      if (counts.length || q.facets[key]) facets.push({ key, label, values: counts.map((c) => ({ value: c.value, count: Number(c.count), selected: q.facets[key] === c.value })) });
    }
    return { total: Number(total), items: await this.views(rows, allowed), facets };
  }

  /** Live rows, filtered and counted in memory with the same rules as the snapshot. */
  private live(items: CatalogItem[], q: BrowseQuery, allowed: Set<string>) {
    const has = (it: CatalogItem, facet: string, value: string) => (it.facets[facet] ?? []).includes(value);
    const matching = (except: string | null) => items.filter((it) => it.kind === q.kind && Object.entries(q.facets).every(([f, v]) => f === except || has(it, f, v)));
    const rows = matching(null);
    const facets = [];
    for (const [key, label] of FACETS[q.kind]) {
      const counts = new Map<string, number>();
      for (const it of matching(key)) for (const v of new Set(it.facets[key] ?? [])) counts.set(v, (counts.get(v) ?? 0) + 1);
      const values = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 50).map(([value, count]) => ({ value, count, selected: q.facets[key] === value }));
      if (values.length || q.facets[key]) facets.push({ key, label, values });
    }
    const view = (it: CatalogItem): CatalogRowView => ({ itemId: it.itemId, name: it.name, publisher: it.publisher, description: it.description, classification: it.classification, licence: it.licence, licenceAllowed: allowed.has(it.licence ?? ''), formats: it.formats, gated: it.gated, sizeBytes: it.sizeBytes, updated: it.updated, facets: it.facets, data: it.data });
    return { total: rows.length, items: rows.slice(q.offset, q.offset + q.limit).map(view), facets };
  }

  async browse(r: RepositoryRow, q: BrowseQuery) {
    const s = this.s();
    const reg = s.imports.repositories;
    const info = REPO_TYPE_INFO[r.type];
    let reason: string | null = null;
    if (q.live === 'off') reason = 'Live search is off for this request.';
    else if (!info.liveSearch || !ADAPTERS[r.type].search) reason = `${info.name} has no search API; browsing the snapshot.`;
    else if (s.cfg.IMPORT_CONNECTIVITY === 'bundle') reason = 'This instance is air-gapped; browsing the snapshot.';
    else if (reg.backingOff(r)) reason = `${r.name} is rate limiting the staging proxy; showing the snapshot until ${new Date(r.backoff_until!).toISOString()}.`;
    else if (!q.q.trim() && q.live === 'auto') reason = 'No search terms: the snapshot lists the whole catalogue.';
    if (!reason) {
      try {
        const items = await ADAPTERS[r.type].search!(reg.context(r), q.q, q.kind, Math.min(100, Math.max(q.limit + q.offset, 50)));
        await reg.markOk(r, `Live search answered ${items.length} items.`);
        return { source: 'live' as const, liveReason: null, ...this.live(items, q, await s.imports.allowedLicences(r.tenant_id)) };
      } catch (err) {
        await reg.markError(r, err);
        const until = err instanceof RateLimited ? (await reg.get(r.tenant_id, r.id)).backoff_until : null;
        reason = err instanceof RateLimited ? `${r.name} is rate limiting the staging proxy; showing the snapshot until ${new Date(until ?? Date.now()).toISOString()}.` : `Live search failed (${(err as Error).message.slice(0, 200)}); showing the snapshot.`;
      }
    }
    return { source: 'snapshot' as const, liveReason: reason, ...(await this.snapshot(r, q)) };
  }
}
