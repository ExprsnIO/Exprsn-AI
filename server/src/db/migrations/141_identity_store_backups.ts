import type { Knex } from 'knex';

/*
 * 1.9.0, Sprint 54 (B-186): store backups kept in the blob store (`identity/store-backups.ts`).
 *
 * - `identity_store_backups`: one row per backup saved to the blob store (a downloaded backup leaves only its audit
 *   entry). `blob_key` is where the sealed, signed archive is (`identity/store-backups/<tenant>/<id>.json`); `sha256`
 *   the digest of the archive as stored; `counts` a JSON summary (versions, mappings, links, users, factors); the
 *   archive itself holds the store's configuration versions with secret references only. `provider_id` has no
 *   foreign key, so a backup outlives its store.
 *
 * Expand only: one new table. This build reports saved backups as not available while it is missing (a download
 * still works).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('identity_store_backups'))) {
    await knex.schema.createTable('identity_store_backups', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('provider_id', 26).notNullable();
      t.string('provider_name', 100).notNullable();
      t.string('kind', 20).notNullable();
      t.string('format', 40).notNullable();
      t.string('blob_key', 300).notNullable();
      t.string('sha256', 64).notNullable();
      t.bigInteger('bytes').notNullable();
      t.text('counts').notNullable(); // JSON
      t.string('created_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.index(['tenant_id', 'provider_id']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('identity_store_backups');
}
