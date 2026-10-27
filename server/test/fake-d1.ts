/*
 * 1.9.99-final, Sprint 61 (B-10907): Cloudflare D1 for `fake-cloudflare.ts`, under
 * `/client/v4/accounts/<id>/d1/database/<database id>/`: `raw` and `query` run one statement on an in-memory SQLite
 * database (better-sqlite3) per D1 database, answered in the v4 envelope. Every statement it was sent is recorded in
 * `statements`, so a test shows that a refused write never arrived. The account token's "D1 Read" (or "D1 Write") is
 * checked by `fake-cloudflare.ts`. It is never the real Cloudflare.
 */
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { json, type RecordedRequest, type Reply } from './fake-cloud-base.js';

export class FakeD1 {
  readonly databases = new Map<string, Database.Database>();
  /** Every statement received, with its database. */
  readonly statements: { database: string; sql: string; params: unknown[] }[] = [];

  /** A new D1 database seeded with `setup` (run directly, never through the API); returns its id. */
  addDatabase(setup: string, id: string = randomUUID()): string {
    const db = new Database(':memory:');
    db.exec(setup);
    this.databases.set(id, db);
    return id;
  }

  close(): void {
    for (const db of this.databases.values()) db.close();
    this.databases.clear();
  }

  matches(path: string): boolean {
    return /^\/accounts\/[^/]+\/d1\//.test(path);
  }

  private err(status: number, code: number, message: string): Reply {
    return { status, body: { success: false, errors: [{ code, message }], messages: [], result: null } };
  }

  route(r: RecordedRequest, path: string): Reply {
    const m = /^\/accounts\/[^/]+\/d1\/database\/([^/]+)\/(raw|query)$/.exec(path);
    if (!m || r.method !== 'POST') return this.err(404, 7000, 'No route for that URI');
    const id = decodeURIComponent(m[1]!);
    const db = this.databases.get(id);
    if (!db) return this.err(404, 7404, 'The database could not be found.');
    const body = json(r);
    const sql = String(body.sql ?? '');
    const params = Array.isArray(body.params) ? (body.params as unknown[]) : [];
    this.statements.push({ database: id, sql, params });
    try {
      const st = db.prepare(sql);
      const started = Date.now();
      if (!st.reader) {
        const info = st.run(...(params as never[]));
        return { status: 200, body: { success: true, errors: [], messages: [], result: [{ success: true, results: m[2] === 'raw' ? { columns: [], rows: [] } : [], meta: { changes: info.changes, duration: Date.now() - started, rows_read: 0, rows_written: info.changes } }] } };
      }
      const columns = st.columns().map((c) => c.name);
      const rows = st.raw(true).all(...(params as never[])) as unknown[][];
      const results = m[2] === 'raw' ? { columns, rows } : rows.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
      return { status: 200, body: { success: true, errors: [], messages: [], result: [{ success: true, results, meta: { changes: 0, duration: Date.now() - started, rows_read: rows.length, rows_written: 0 } }] } };
    } catch (err) {
      return this.err(400, 7500, `${(err as Error).message}: SQLITE_ERROR`);
    }
  }
}
