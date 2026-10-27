import type { Knex } from 'knex';

/*
 * 2.0.0, linked storage in Files (`files/locations/`).
 *
 * - `file_locations`: a workspace's linked location (S3, Azure Blob, a local store, SFTP, FTP, IPFS). `config` is the
 *   kind's settings in JSON (no secrets); `secret_sealed` the credentials sealed with the tenant key (associated data
 *   `file-location:<id>`). `label` is the label files copied in from it get at least. `read_only` refuses sending out.
 * - `file_local_roots`: directories on the server host an operator offers as local stores (`platform:manage`), to every
 *   tenant (`tenants` null) or to the tenants listed (JSON array).
 *
 * Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('file_locations'))) {
    await knex.schema.createTable('file_locations', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('workspace_id', 26).notNullable();
      t.string('name', 120).notNullable();
      t.string('kind', 16).notNullable();
      t.text('config').notNullable();
      t.text('secret_sealed').nullable();
      t.string('label', 20).notNullable();
      t.boolean('read_only').notNullable().defaultTo(false);
      t.string('state', 16).notNullable().defaultTo('unchecked');
      t.bigInteger('last_checked_at').nullable();
      t.string('last_error', 500).nullable();
      t.string('created_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.index(['tenant_id', 'workspace_id'], 'file_locations_ws');
    });
  }
  if (!(await knex.schema.hasTable('file_local_roots'))) {
    await knex.schema.createTable('file_local_roots', (t) => {
      t.string('id', 26).primary();
      t.string('name', 120).notNullable();
      t.string('path', 1024).notNullable();
      t.boolean('read_only').notNullable().defaultTo(true);
      t.text('tenants').nullable();
      t.string('created_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('file_local_roots');
  await knex.schema.dropTableIfExists('file_locations');
}
