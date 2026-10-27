import type { Knex } from 'knex';
import type { Db } from '../db/knex.js';
import type { DocKind } from './indexer.js';
import { prefixHash, type SearchKeys, termHash } from './keys.js';
import type { ParsedQuery, Unit } from './normalise.js';

/*
 * 1.9.0, Sprint 52 (B-170): answering a query from the blind index. Every word, phrase and prefix of the query is
 * hashed with the tenant's active key and looked up in `search_postings` (restricted to the partitions the reader may
 * read when there are not too many); all of them must match (AND). A phrase needs its words at consecutive positions;
 * a prefix is expanded to the terms `search_prefixes` lists for its first four characters (the opened text decides
 * the rest). The documents left are filtered on `search_docs` (author, dates, label, file, link, visibility: whatever
 * the caller's `where` says) before they are counted, then ranked by BM25 with each document's length.
 *
 * Caps: at most ROWS_PER_UNIT postings are read for one word, and PREFIX_TERMS terms for one prefix; a word that
 * common matches only part of its documents (the ranking is then approximate, never wider than the reader's scope).
 */

const ROWS_PER_UNIT = 50_000;
const PREFIX_TERMS = 500;
const SCOPE_FILTER_MAX = 900;
const K1 = 1.2;
const B = 0.75;

export interface DocMeta {
  doc_kind: DocKind;
  doc_id: string;
  scope_id: string;
  parent_id: string | null;
  workspace_id: string | null;
  group_id: string | null;
  author_id: string;
  label: string;
  visibility: string | null;
  created_at: number;
  length: number;
  has_file: boolean;
  has_link: boolean;
}

export interface Ranked {
  meta: DocMeta;
  score: number;
}

interface Posting {
  doc_kind: string;
  doc_id: string;
  pos: number;
}

const metaFrom = (r: Record<string, unknown>): DocMeta => ({ ...(r as unknown as DocMeta), created_at: Number(r.created_at), length: Number(r.length ?? 0), has_file: !!Number(r.has_file ?? 0) || r.has_file === true, has_link: !!Number(r.has_link ?? 0) || r.has_link === true });
const keyOf = (kind: string, id: string) => `${kind}:${id}`;

export interface IndexQuery {
  tenantId: string;
  version: number;
  pq: ParsedQuery;
  kinds: DocKind[];
  /** The partitions (conversations; groups and workspaces) the reader may read; null for no restriction here. */
  scopes: string[] | null;
  /** More conditions on `search_docs` (applied before counting). */
  where?: (qb: Knex.QueryBuilder) => void;
}

export class IndexReader {
  private readonly sizes = new Map<string, { n: number; avg: number; at: number }>();

  constructor(
    private readonly db: () => Db,
    private readonly keys: SearchKeys
  ) {}

  private postings(q: IndexQuery, termHashes: string[]): Promise<Posting[]> {
    if (!termHashes.length) return Promise.resolve([]);
    const qb = this.db()('search_postings').where({ tenant_id: q.tenantId, key_version: q.version }).whereIn('doc_kind', q.kinds);
    if (termHashes.length === 1) qb.andWhere({ term: termHashes[0] });
    else qb.whereIn('term', termHashes);
    if (q.scopes && q.scopes.length <= SCOPE_FILTER_MAX) qb.whereIn('scope_id', q.scopes);
    return qb.limit(ROWS_PER_UNIT).select('doc_kind', 'doc_id', 'pos') as Promise<Posting[]>;
  }

  /** Documents matching one unit, with the term frequency in each. */
  private async unit(q: IndexQuery, key: Buffer, u: Unit): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (u.kind === 'term') {
      for (const r of await this.postings(q, [termHash(key, u.term)])) out.set(keyOf(r.doc_kind, r.doc_id), (out.get(keyOf(r.doc_kind, r.doc_id)) ?? 0) + 1);
      return out;
    }
    if (u.kind === 'prefix') {
      const termsOf = ((await this.db()('search_prefixes').where({ tenant_id: q.tenantId, key_version: q.version, prefix: prefixHash(key, u.prefix) }).limit(PREFIX_TERMS).select('term')) as { term: string }[]).map((r) => r.term);
      for (const r of await this.postings(q, termsOf)) out.set(keyOf(r.doc_kind, r.doc_id), (out.get(keyOf(r.doc_kind, r.doc_id)) ?? 0) + 1);
      return out;
    }
    // A phrase: every word's positions, then the documents where they follow one another.
    const positions: Map<string, Set<number>>[] = [];
    for (const t of u.terms) {
      const m = new Map<string, Set<number>>();
      for (const r of await this.postings(q, [termHash(key, t)])) {
        const k = keyOf(r.doc_kind, r.doc_id);
        const set = m.get(k) ?? new Set<number>();
        set.add(Number(r.pos));
        m.set(k, set);
      }
      if (!m.size) return out;
      positions.push(m);
    }
    for (const [k, first] of positions[0]!) {
      let n = 0;
      for (const p of first) if (positions.every((m, i) => m.get(k)?.has(p + i))) n++;
      if (n) out.set(k, n);
    }
    return out;
  }

  /** Documents of these kinds in the tenant, and their average length (for BM25), cached a minute. */
  private async size(tenantId: string, kinds: DocKind[]): Promise<{ n: number; avg: number }> {
    const id = `${tenantId}:${kinds.join(',')}`;
    const hit = this.sizes.get(id);
    if (hit && Date.now() - hit.at < 60_000) return hit;
    const r = (await this.db()('search_docs').where({ tenant_id: tenantId }).whereIn('doc_kind', kinds).count({ n: '*' }).avg({ avg: 'length' })) as { n: number | string; avg: number | string | null }[];
    const v = { n: Number(r[0]?.n ?? 0), avg: Number(r[0]?.avg ?? 0) || 1, at: Date.now() };
    this.sizes.set(id, v);
    return v;
  }

  /** The documents that match, filtered, counted and ranked (best first, then newest). */
  async search(q: IndexQuery): Promise<{ ranked: Ranked[]; total: number }> {
    if (!q.pq.units.length || (q.scopes && !q.scopes.length) || !q.kinds.length) return { ranked: [], total: 0 };
    const key = await this.keys.key(q.tenantId, q.version);
    const units: Map<string, number>[] = [];
    for (const u of q.pq.units) {
      const m = await this.unit(q, key, u);
      if (!m.size) return { ranked: [], total: 0 };
      units.push(m);
    }
    // All units must match: start from the smallest.
    const order = [...units].sort((a, b) => a.size - b.size);
    let candidates = [...order[0]!.keys()];
    for (const m of order.slice(1)) candidates = candidates.filter((k) => m.has(k));
    if (!candidates.length) return { ranked: [], total: 0 };
    // Filters on what each document is, before counting.
    const scopes = q.scopes && q.scopes.length > SCOPE_FILTER_MAX ? new Set(q.scopes) : null;
    const metas: DocMeta[] = [];
    for (const kind of q.kinds) {
      const ids = candidates.filter((k) => k.startsWith(`${kind}:`)).map((k) => k.slice(kind.length + 1));
      for (let i = 0; i < ids.length; i += 500) {
        // By the primary key (kind, id); the tenant is checked on the rows (an index led by the tenant would scan it).
        const qb = this.db()('search_docs').where({ doc_kind: kind }).whereIn('doc_id', ids.slice(i, i + 500));
        if (q.where) q.where(qb);
        for (const r of (await qb.select('*')) as Record<string, unknown>[]) {
          const m = metaFrom(r);
          if (r.tenant_id === q.tenantId && (!scopes || scopes.has(m.scope_id))) metas.push(m);
        }
      }
    }
    const { n, avg } = await this.size(q.tenantId, q.kinds);
    const N = Math.max(n, metas.length);
    const ranked = metas.map((meta) => {
      const k = keyOf(meta.doc_kind, meta.doc_id);
      let score = 0;
      for (const m of units) {
        const tf = m.get(k) ?? 0;
        const df = m.size;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        score += (idf * (tf * (K1 + 1))) / (tf + K1 * (1 - B + (B * (meta.length || 1)) / avg));
      }
      return { meta, score };
    });
    ranked.sort((a, b) => b.score - a.score || b.meta.created_at - a.meta.created_at || (b.meta.doc_id < a.meta.doc_id ? -1 : 1));
    return { ranked, total: ranked.length };
  }
}
