import type { Knex } from 'knex';

/*
 * The file store over WebDAV (036c_dav_files): B-3201 to B-3203, planned for Sprint 34 and built beside Sprint 30's
 * CalDAV and CardDAV (032_dav), which stand without it.
 *
 * - `dav_locks`: WebDAV locks (RFC 4918 class 2) on file-store paths, for Finder and Office. A lock is on a path, not
 *   a resource; `root_hash` is a SHA-256 of the tenant and the locked path for lookups by path, and the path itself
 *   (`root`) is kept for prefix checks. `owner` is the client's DAV:owner XML as sent. Expired rows are ignored and
 *   pruned.
 * Dead properties of files and folders use 032_dav's `dav_properties` (`file:<id>`, `folder:<id>`).
 * Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('dav_locks', (t) => {
    t.string('token', 64).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.text('root').notNullable();
    t.string('root_hash', 64).notNullable();
    t.string('depth', 10).notNullable(); // 0 | infinity
    t.string('scope', 20).notNullable(); // exclusive | shared
    t.text('owner').nullable();
    t.integer('timeout_s').notNullable();
    t.bigInteger('expires_at').notNullable();
    t.bigInteger('created_at').notNullable();
    t.index(['tenant_id', 'root_hash'], 'dav_locks_root_idx');
    t.index(['expires_at'], 'dav_locks_expiry_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('dav_locks');
}
