import { describe, expect, it } from 'vitest';
import { createDb, migrate } from '../src/db/knex.js';
import { testConfig } from './helpers.js';

/**
 * MySQL refuses identifiers longer than 64 characters, and Knex names indexes and constraints after their table and
 * columns, so a long table name with a few columns passes on SQLite and PostgreSQL and then fails the migration on
 * MySQL (028c_moderation did, in CI only). This runs every migration on SQLite and checks every table, index and
 * constraint name the migrations create.
 */
describe('migration identifiers', () => {
  it('stay within MySQL’s 64-character limit', async () => {
    const db = createDb(testConfig());
    const sql: string[] = [];
    db.on('query', (q: { sql: string }) => void sql.push(q.sql));
    try {
      await migrate(db);
    } finally {
      await db.destroy();
    }
    const names = new Set<string>();
    const patterns = [
      /create\s+(?:unique\s+)?index\s+(?:if\s+not\s+exists\s+)?[`"]([^`"]+)[`"]/gi,
      /constraint\s+[`"]([^`"]+)[`"]/gi,
      /create\s+table\s+(?:if\s+not\s+exists\s+)?[`"]([^`"]+)[`"]/gi
    ];
    for (const s of sql) for (const re of patterns) for (const m of s.matchAll(re)) names.add(m[1]!);
    expect(names.size).toBeGreaterThan(100);
    const tooLong = [...names].filter((n) => n.length > 64).map((n) => `${n} (${n.length})`);
    expect(tooLong).toEqual([]);
  });
});
