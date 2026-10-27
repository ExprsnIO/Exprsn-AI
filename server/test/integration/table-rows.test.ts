/*
 * tableRows on PostgreSQL (2026-10-26): a table with no primary key is read in pages of heap blocks (TID range
 * scans), not in one query.
 * knowledge_terms (no key, 17 million rows) used to come back as one result and filled the heap in every nightly
 * ops.blobs.verify. Runs when TEST_PG_URL is set; the table is made and dropped by the test.
 */
import { randomBytes } from 'node:crypto';
import knexFactory, { type Knex } from 'knex';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tableRows } from '../../src/ops/restore.js';
import type { Db } from '../../src/db/knex.js';

const URL = process.env.TEST_PG_URL;

describe.skipIf(!URL)('tableRows on PostgreSQL', () => {
  let db: Knex;
  const keyless = `rows_nokey_${randomBytes(4).toString('hex')}`;
  const ROWS = 10_000;

  beforeAll(async () => {
    db = knexFactory({ client: 'pg', connection: URL, pool: { min: 0, max: 2 } });
    await db.schema.createTable(keyless, (t) => {
      t.string('chunk_id', 26).notNullable();
      t.string('term', 32).notNullable();
      t.integer('tf').notNullable();
    });
    for (let i = 0; i < ROWS; i += 1_000) {
      await db(keyless).insert(Array.from({ length: Math.min(1_000, ROWS - i) }, (_, j) => ({ chunk_id: `c${i + j}`, term: `t${(i + j) % 97}`, tf: i + j })));
    }
    // Holes in the heap, as deletes and updates leave them: no row may be lost or read twice.
    await db(keyless).where('tf', '<', 100).delete();
    await db(keyless).where('tf', '>=', 9_000).update({ term: 'moved' });
  });

  afterAll(async () => {
    await db.schema.dropTableIfExists(keyless);
    await db.destroy();
  });

  it('reads every row of a keyless table once, a few blocks per query, columns unchanged', async () => {
    const sizes: number[] = [];
    db.on('query-response', (res: { rows?: unknown[] }) => { if (Array.isArray(res?.rows)) sizes.push(res.rows.length); });
    const seen = new Map<number, Record<string, unknown>>();
    for await (const r of tableRows(db as unknown as Db, 'pg', keyless)) {
      expect(seen.has(Number(r.tf))).toBe(false);
      seen.set(Number(r.tf), r);
    }
    db.removeAllListeners('query-response');
    expect(seen.size).toBe(ROWS - 100);
    // 8 blocks of these small rows hold under 2,000; the old single read returned all 9,900 at once.
    expect(Math.max(...sizes)).toBeLessThan(2_000);
    expect(sizes.filter((n) => n > 0).length).toBeGreaterThanOrEqual(5);
    const sample = seen.get(9_100)!;
    expect(Object.keys(sample).sort()).toEqual(['chunk_id', 'term', 'tf']);
    expect(sample.term).toBe('moved');
  });
});
