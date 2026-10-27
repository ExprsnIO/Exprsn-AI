import type { Knex } from 'knex';

/*
 * 1.6.0, Sprint 39c.
 *
 * B-8401 AI field upgrades.
 * - `app_records.ai_pending`: the AI fields a change left to regenerate (JSON list of field names; null means every
 *   AI field, as a new record), read by the fill job so an edit regenerates only the fields that read what changed.
 *
 * B-8402 AI fills over every row.
 * - `app_ai_fills`: a fill or refresh of one AI field over an entity's records as one job: the scope (empty values
 *   only, or every record), the estimate it was started with, its state (`queued`, `running`, `succeeded`, `failed`,
 *   `cancelled`), progress counters and token totals.
 *
 * B-8501 outside tables as entities.
 * - `app_entity_sources`: an entity backed by a table in an outside PostgreSQL or MySQL database through a data
 *   connection: the object, the key column and the field it maps to, the column mapping, whether app writes reach the
 *   table at once, the pull interval, and the last pull's result.
 * - `app_records.external_key`: the outside row's key for a record of a sourced entity.
 * Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('app_records', (t) => {
    t.text('ai_pending').nullable(); // JSON: ["summary"]; null: every AI field
    t.string('external_key', 200).nullable();
    t.index(['entity_id', 'external_key'], 'app_records_external_idx');
  });

  await knex.schema.createTable('app_ai_fills', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('app_id', 26).notNullable();
    t.string('entity_id', 26).notNullable();
    t.string('field', 63).notNullable();
    t.string('scope', 10).notNullable(); // empty | all
    t.string('state', 10).notNullable(); // queued | running | succeeded | failed | cancelled
    t.integer('total').notNullable().defaultTo(0);
    t.integer('done').notNullable().defaultTo(0);
    t.integer('failed').notNullable().defaultTo(0);
    t.integer('skipped').notNullable().defaultTo(0);
    t.bigInteger('prompt_tokens').notNullable().defaultTo(0);
    t.bigInteger('output_tokens').notNullable().defaultTo(0);
    t.text('estimate').nullable(); // JSON: the estimate shown before the start
    t.string('job_id', 26).nullable();
    t.string('started_by', 26).nullable();
    t.string('error', 300).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('started_at').nullable();
    t.bigInteger('finished_at').nullable();
    t.index(['tenant_id', 'entity_id', 'created_at'], 'app_ai_fills_entity_idx');
  });

  await knex.schema.createTable('app_entity_sources', (t) => {
    t.string('entity_id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('app_id', 26).notNullable();
    t.string('connection_id', 26).notNullable();
    t.string('object', 200).notNullable();
    t.string('key_column', 100).notNullable();
    t.string('key_field', 63).nullable();
    t.text('columns').notNullable(); // JSON: {field: column}
    t.string('state_column', 100).nullable();
    t.boolean('writes').notNullable().defaultTo(false);
    t.boolean('delete_missing').notNullable().defaultTo(true);
    t.integer('pull_minutes').nullable();
    t.boolean('enabled').notNullable().defaultTo(true);
    t.bigInteger('next_pull_at').nullable();
    t.bigInteger('last_pull_at').nullable();
    t.text('last_pull_result').nullable(); // JSON: {rows, created, updated, deleted, unchanged, ms, error?}
    t.string('created_by', 26).nullable();
    t.string('updated_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'enabled', 'next_pull_at'], 'app_entity_sources_due_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('app_entity_sources');
  await knex.schema.dropTable('app_ai_fills');
  await knex.schema.alterTable('app_records', (t) => {
    t.dropIndex(['entity_id', 'external_key'], 'app_records_external_idx');
    t.dropColumn('external_key');
    t.dropColumn('ai_pending');
  });
}
