import type { Logger } from 'pino';
import type { Db } from '../db/knex.js';

/**
 * Vector storage for retrieval (knowledge chunks, memories). A collection is one index version or one memory
 * space; every record carries its tenant, a partition (for example `user:<id>`) and the rank of its label, and every
 * search filters on those inside the query, so a caller never sees, ranks or counts a record above its ceiling.
 *
 * Two adapters: vectors in the application database with a brute-force scan (SQLite, MySQL, and PostgreSQL without
 * the extension), and pgvector on PostgreSQL when the `vector` extension is installed (HNSW per collection).
 */
export interface VectorRecord {
  id: string;
  tenantId: string;
  partition: string;
  labelRank: number;
  vector: number[];
}

export interface VectorQuery {
  tenantId: string;
  vector: number[];
  k: number;
  /** Records labelled above this rank are excluded by the query itself. */
  maxLabelRank: number;
  /** Only these partitions, when given. */
  partitions?: string[];
}

export interface VectorHit {
  id: string;
  /** Cosine similarity, -1 to 1. */
  score: number;
}

export interface VectorStore {
  readonly kind: 'db' | 'pgvector';
  upsert(collection: string, records: VectorRecord[]): Promise<void>;
  search(collection: string, q: VectorQuery): Promise<VectorHit[]>;
  /** Deletes records by id in a collection; returns how many. */
  delete(collection: string, ids: string[]): Promise<number>;
  /** Deletes a whole collection; returns how many records. */
  drop(collection: string): Promise<number>;
  /** Deletes every record of a tenant in every collection (offboarding). */
  purgeTenant(tenantId: string): Promise<number>;
}

const COLLECTION = /^[A-Za-z0-9:_-]{1,80}$/;
const checkCollection = (c: string): string => {
  if (!COLLECTION.test(c)) throw new Error(`Invalid vector collection: ${c}`);
  return c;
};

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export const encodeVector = (v: number[]): string => Buffer.from(new Float32Array(v).buffer).toString('base64');
export const decodeVector = (s: string): number[] => {
  const b = Buffer.from(s, 'base64');
  return Array.from(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4)));
};

/** Vectors as Float32 blobs (base64) in the `vectors` table; search scans the filtered rows. */
export class DbVectorStore implements VectorStore {
  readonly kind = 'db' as const;

  constructor(private readonly db: Db) {}

  async upsert(collection: string, records: VectorRecord[]): Promise<void> {
    checkCollection(collection);
    const t = Date.now();
    for (let i = 0; i < records.length; i += 200) {
      const batch = records.slice(i, i + 200);
      await this.db('vectors').where({ collection }).whereIn('id', batch.map((r) => r.id)).delete();
      await this.db('vectors').insert(batch.map((r) => ({ collection, id: r.id, tenant_id: r.tenantId, partition: r.partition, label_rank: r.labelRank, dims: r.vector.length, embedding: encodeVector(r.vector), created_at: t })));
    }
  }

  async search(collection: string, q: VectorQuery): Promise<VectorHit[]> {
    checkCollection(collection);
    const query = this.db('vectors').where({ collection, tenant_id: q.tenantId, dims: q.vector.length }).andWhere('label_rank', '<=', q.maxLabelRank);
    if (q.partitions) query.whereIn('partition', q.partitions.length ? q.partitions : ['']);
    const rows = (await query.select('id', 'embedding')) as { id: string; embedding: string }[];
    return rows
      .map((r) => ({ id: r.id, score: cosine(q.vector, decodeVector(r.embedding)) }))
      .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
      .slice(0, q.k);
  }

  async delete(collection: string, ids: string[]): Promise<number> {
    let n = 0;
    for (let i = 0; i < ids.length; i += 500) n += await this.db('vectors').where({ collection: checkCollection(collection) }).whereIn('id', ids.slice(i, i + 500)).delete();
    return n;
  }

  async drop(collection: string): Promise<number> {
    return this.db('vectors').where({ collection: checkCollection(collection) }).delete();
  }

  async purgeTenant(tenantId: string): Promise<number> {
    return this.db('vectors').where({ tenant_id: tenantId }).delete();
  }
}

const literal = (v: number[]) => `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(',')}]`;
const indexName = (collection: string, dims: number) => `vectors_pg_hnsw_${collection.replace(/[^A-Za-z0-9]/g, '_').toLowerCase()}_${dims}`.slice(0, 63);

/**
 * pgvector: one table for every collection, with an unconstrained `vector` column, and a partial HNSW index per
 * collection and dimension (cosine distance) created with its first records. Searches use the same cast expression
 * so the planner can use that index; the tenant, partition and label filters are in the WHERE clause.
 */
export class PgVectorStore implements VectorStore {
  readonly kind = 'pgvector' as const;
  private ready: Promise<void> | null = null;
  private readonly indexed = new Set<string>();

  constructor(private readonly db: Db) {}

  private init(): Promise<void> {
    this.ready ??= (async () => {
      await this.db.raw(
        'CREATE TABLE IF NOT EXISTS vectors_pg (collection varchar(80) NOT NULL, id varchar(64) NOT NULL, tenant_id varchar(26) NOT NULL, partition varchar(80) NOT NULL, label_rank smallint NOT NULL, dims integer NOT NULL, embedding vector NOT NULL, PRIMARY KEY (collection, id))'
      );
      await this.db.raw('CREATE INDEX IF NOT EXISTS vectors_pg_tenant ON vectors_pg (tenant_id)');
    })();
    return this.ready;
  }

  private async ensureIndex(collection: string, dims: number): Promise<void> {
    const name = indexName(collection, dims);
    if (this.indexed.has(name)) return;
    await this.db.raw(`CREATE INDEX IF NOT EXISTS ${name} ON vectors_pg USING hnsw ((embedding::vector(${dims})) vector_cosine_ops) WITH (m = 16, ef_construction = 200) WHERE collection = '${collection}' AND dims = ${dims}`);
    this.indexed.add(name);
  }

  async upsert(collection: string, records: VectorRecord[]): Promise<void> {
    checkCollection(collection);
    if (!records.length) return;
    await this.init();
    for (const dims of new Set(records.map((r) => r.vector.length))) await this.ensureIndex(collection, dims);
    for (const r of records) {
      await this.db.raw(
        'INSERT INTO vectors_pg (collection, id, tenant_id, partition, label_rank, dims, embedding) VALUES (?, ?, ?, ?, ?, ?, ?::vector) ON CONFLICT (collection, id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, partition = EXCLUDED.partition, label_rank = EXCLUDED.label_rank, dims = EXCLUDED.dims, embedding = EXCLUDED.embedding',
        [collection, r.id, r.tenantId, r.partition, r.labelRank, r.vector.length, literal(r.vector)]
      );
    }
  }

  async search(collection: string, q: VectorQuery): Promise<VectorHit[]> {
    checkCollection(collection);
    await this.init();
    const dims = q.vector.length;
    const parts = q.partitions ? (q.partitions.length ? q.partitions : ['']) : null;
    const res = await this.db.raw(
      `SELECT id, 1 - ((embedding::vector(${dims})) <=> ?::vector(${dims})) AS score FROM vectors_pg WHERE collection = ? AND dims = ? AND tenant_id = ? AND label_rank <= ?${parts ? ` AND partition IN (${parts.map(() => '?').join(',')})` : ''} ORDER BY (embedding::vector(${dims})) <=> ?::vector(${dims}) LIMIT ?`,
      [literal(q.vector), collection, dims, q.tenantId, q.maxLabelRank, ...(parts ?? []), literal(q.vector), q.k]
    );
    return (res.rows as { id: string; score: number | string }[]).map((r) => ({ id: r.id, score: Number(r.score) }));
  }

  async delete(collection: string, ids: string[]): Promise<number> {
    await this.init();
    let n = 0;
    for (let i = 0; i < ids.length; i += 500) n += await this.db('vectors_pg').where({ collection: checkCollection(collection) }).whereIn('id', ids.slice(i, i + 500)).delete();
    return n;
  }

  async drop(collection: string): Promise<number> {
    checkCollection(collection);
    await this.init();
    const dims = ((await this.db('vectors_pg').where({ collection }).distinct('dims')) as { dims: number }[]).map((r) => Number(r.dims));
    const n = await this.db('vectors_pg').where({ collection }).delete();
    for (const d of dims) {
      const name = indexName(collection, d);
      await this.db.raw(`DROP INDEX IF EXISTS ${name}`);
      this.indexed.delete(name);
    }
    return n;
  }

  async purgeTenant(tenantId: string): Promise<number> {
    await this.init();
    return this.db('vectors_pg').where({ tenant_id: tenantId }).delete();
  }
}

/** pgvector when the database is PostgreSQL and the extension is (or can be) installed; otherwise the table scan. */
export async function createVectorStore(db: Db, client: string, log: Logger, mode: 'auto' | 'db' = 'auto'): Promise<VectorStore> {
  if (mode === 'db' || client !== 'pg') return new DbVectorStore(db);
  try {
    await db.raw('CREATE EXTENSION IF NOT EXISTS vector');
    return new PgVectorStore(db);
  } catch (err) {
    log.info({ err: (err as Error).message }, 'pgvector is not available; vectors are searched by table scan');
    return new DbVectorStore(db);
  }
}

/**
 * Picks the adapter lazily on first use, so services can be built synchronously. Every call waits for the choice.
 */
export class LazyVectorStore implements VectorStore {
  private inner: Promise<VectorStore> | null = null;
  private chosen: VectorStore | null = null;

  constructor(private readonly make: () => Promise<VectorStore>) {}

  private get(): Promise<VectorStore> {
    this.inner ??= this.make().then((v) => (this.chosen = v));
    return this.inner;
  }

  /** The adapter in use, once one was chosen (`db` until then). */
  get kind(): 'db' | 'pgvector' {
    return this.chosen?.kind ?? 'db';
  }

  async resolve(): Promise<VectorStore> {
    return this.get();
  }

  async upsert(c: string, r: VectorRecord[]): Promise<void> {
    return (await this.get()).upsert(c, r);
  }

  async search(c: string, q: VectorQuery): Promise<VectorHit[]> {
    return (await this.get()).search(c, q);
  }

  async delete(c: string, ids: string[]): Promise<number> {
    return (await this.get()).delete(c, ids);
  }

  async drop(c: string): Promise<number> {
    return (await this.get()).drop(c);
  }

  async purgeTenant(t: string): Promise<number> {
    return (await this.get()).purgeTenant(t);
  }
}
