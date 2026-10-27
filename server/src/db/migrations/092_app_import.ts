import type { Knex } from 'knex';

/*
 * Sprint 45 (B-127, B-129): spreadsheet and connection imports into app entities (`apps/sheet-import.ts`).
 *
 * - `app_import_keys`: the record each row of a keyed source made, by entity, source (a digest of the connection and
 *   object, saved query or endpoint) and the source's row key, so a re-import updates that record (idempotent).
 * - `app_import_schedules`: a re-import from a connection on a five-field UTC cron, run as its owner (re-checked at
 *   each run). The import's settings are sealed under the tenant key; each due time is claimed with one conditional
 *   update of `next_run_at`, so one instance runs it.
 *
 * The imports themselves are rows of `app_transfers` (kind `import`, the sealed settings in `input`, the sealed CSV
 * of failed rows in `blob_key`), as the CSV import's are. Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('app_import_keys'))) {
    await knex.schema.createTable('app_import_keys', (t) => {
      t.string('entity_id', 26).notNullable();
      t.string('source_ref', 64).notNullable();
      t.string('row_key', 255).notNullable();
      t.string('tenant_id', 26).notNullable();
      t.string('record_id', 26).notNullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.primary(['entity_id', 'source_ref', 'row_key']);
      t.index(['record_id']);
    });
  }
  if (!(await knex.schema.hasTable('app_import_schedules'))) {
    await knex.schema.createTable('app_import_schedules', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('app_id', 26).notNullable();
      t.string('entity_id', 26).notNullable();
      t.string('owner_id', 26).notNullable();
      t.string('cron', 100).notNullable();
      t.text('spec', 'mediumtext').notNullable();
      t.boolean('enabled').notNullable().defaultTo(true);
      t.bigInteger('next_run_at').nullable();
      t.bigInteger('last_run_at').nullable();
      t.string('last_transfer_id', 26).nullable();
      t.string('last_result', 300).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.index(['tenant_id', 'app_id', 'entity_id']);
      t.index(['enabled', 'next_run_at']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('app_import_schedules');
  await knex.schema.dropTableIfExists('app_import_keys');
}
