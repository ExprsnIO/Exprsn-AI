import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/knex.js';
import { restoreRows } from '../src/ops/restore.js';
import { testConfig } from './helpers.js';

/*
 * QA-1: a backup taken after an expand-only migration added a column (knowledge_documents.created_by, migration 144)
 * restores into a schema without that column: the column is skipped and reported, as a missing table is, and every
 * row still arrives. Before, the insert failed and the restore drill reported "Rows restored: failed".
 */
describe('restoreRows and columns the target lacks', () => {
  it('skips and reports them, and restores every row', async () => {
    const db = createDb(testConfig());
    try {
      await db.schema.createTable('docs', (t) => {
        t.string('id').primary();
        t.string('name');
      });
      async function* lines() {
        yield JSON.stringify({ format: 'exprsn-backup/1', id: 'B1' });
        yield JSON.stringify(['docs', { id: 'd1', name: 'one', created_by: 'u1' }]);
        yield JSON.stringify(['docs', { id: 'd2', name: 'two', created_by: null }]);
        yield JSON.stringify(['gone', { id: 'x' }]);
      }
      const r = await restoreRows(db, 'sqlite', lines(), new Set(['docs']), { id: 'B1' });
      expect(r.counts.get('docs')).toBe(2);
      expect(r.skipped).toEqual(['gone']);
      expect(r.skippedColumns).toEqual(['docs.created_by']);
      expect(await db('docs').orderBy('id')).toEqual([{ id: 'd1', name: 'one' }, { id: 'd2', name: 'two' }]);
    } finally {
      await db.destroy();
    }
  });
});
