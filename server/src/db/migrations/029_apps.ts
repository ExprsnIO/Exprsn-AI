import type { Knex } from 'knex';

/*
 * Sprint 27 (1.4.0), low-code data apps (029): B-2201 to B-2208.
 *
 * - `apps`: an app belongs to a tenant, and to one of its workspaces unless it is tenant-wide (`workspace_id` null).
 *   `scope_key` is the workspace id or `tenant`, so app names are unique per scope on every dialect (a unique index
 *   over a nullable column lets duplicates through on PostgreSQL and MySQL).
 * - `app_entities`: typed fields, an optional state machine and display settings, as JSON (`definition`). The design
 *   is not tenant content; records are.
 * - `app_records`: one row per record. The values are sealed with the tenant key (`data`, the record id as associated
 *   data). `state` is the record's place in its entity's state machine; `hidden` is set by moderation.
 * - `app_record_values`: the clear index of the fields an entity marks `indexed` (B-2202): one row per record and
 *   field, a lower-cased string (`v_norm`, byte-ordered on every dialect) or a number (`v_num`: numbers, dates as epoch
 *   milliseconds, booleans as 0 and 1). Filters, sorts, search and aggregation run on this table, never on `data`.
 * - `app_unique_values`: one row per unique field value, keyed by a hash of the normalised value; its primary key is
 *   what refuses a duplicate, on all three databases, inside the transaction that writes the record.
 * - `app_forms`: forms over an entity with conditional fields; a public form has a link token (stored as an HMAC).
 * - `app_triggers`: record-event and schedule triggers that start a published workflow as their owner.
 * - `app_transfers`: CSV imports and exports run as jobs (the CSV sealed, in the row or the blob store).
 * Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  const mysql = /mysql/.test(String(knex.client.config.client));

  await knex.schema.createTable('apps', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).nullable();
    t.string('scope_key', 26).notNullable();
    t.string('name', 63).notNullable();
    t.string('title', 200).notNullable();
    t.text('description').nullable();
    t.string('label', 20).notNullable();
    t.string('created_by', 26).nullable();
    t.string('updated_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'scope_key', 'name']);
    t.index(['tenant_id', 'workspace_id']);
  });

  await knex.schema.createTable('app_entities', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('app_id', 26).notNullable();
    t.string('name', 63).notNullable();
    t.string('title', 200).notNullable();
    t.string('label', 20).notNullable();
    t.text('definition', 'mediumtext').notNullable();
    t.integer('rev').notNullable().defaultTo(1);
    t.string('created_by', 26).nullable();
    t.string('updated_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['app_id', 'name']);
    t.index(['tenant_id']);
  });

  await knex.schema.createTable('app_records', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('app_id', 26).notNullable();
    t.string('entity_id', 26).notNullable();
    t.string('workspace_id', 26).nullable();
    t.string('label', 20).notNullable();
    t.string('state', 60).nullable();
    t.text('data', 'mediumtext').notNullable();
    t.boolean('hidden').notNullable().defaultTo(false);
    t.integer('version').notNullable().defaultTo(1);
    t.string('source', 20).notNullable(); // api | form | import | workflow
    t.string('ai_state', 20).nullable(); // pending | filled | failed
    t.string('ai_error', 300).nullable();
    t.string('created_by', 26).nullable();
    t.string('updated_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'entity_id', 'created_at']);
    t.index(['entity_id', 'state']);
  });

  await knex.schema.createTable('app_record_values', (t) => {
    t.string('record_id', 26).notNullable();
    t.string('tenant_id', 26).notNullable();
    t.string('entity_id', 26).notNullable();
    t.string('field', 63).notNullable();
    // Byte order and exact comparison on MySQL too (its default collation ignores case and accents).
    const v = t.string('v_norm', 255).nullable();
    if (mysql) v.collate('utf8mb4_bin');
    t.double('v_num').nullable();
    t.primary(['record_id', 'field']);
    t.index(['entity_id', 'field', 'v_norm']);
    t.index(['entity_id', 'field', 'v_num']);
  });

  await knex.schema.createTable('app_unique_values', (t) => {
    t.string('entity_id', 26).notNullable();
    t.string('field', 63).notNullable();
    t.string('value_hash', 64).notNullable();
    t.string('record_id', 26).notNullable();
    t.string('tenant_id', 26).notNullable();
    t.primary(['entity_id', 'field', 'value_hash']);
    t.index(['record_id']);
  });

  await knex.schema.createTable('app_forms', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('app_id', 26).notNullable();
    t.string('entity_id', 26).notNullable();
    t.string('name', 63).notNullable();
    t.string('title', 200).notNullable();
    t.text('definition', 'mediumtext').notNullable();
    t.boolean('public').notNullable().defaultTo(false);
    t.string('token_hash', 64).nullable();
    t.integer('rate_per_minute').notNullable().defaultTo(10);
    t.string('created_by', 26).nullable();
    t.string('updated_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['app_id', 'name']);
    t.unique(['token_hash']);
  });

  await knex.schema.createTable('app_triggers', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('app_id', 26).notNullable();
    t.string('entity_id', 26).notNullable();
    t.string('kind', 20).notNullable(); // record | schedule
    t.string('events', 200).nullable(); // comma-separated: created, updated, deleted, transitioned
    t.string('cron', 120).nullable();
    t.string('workflow_id', 26).notNullable();
    t.string('workspace_id', 26).nullable();
    t.string('owner_id', 26).notNullable();
    t.boolean('enabled').notNullable().defaultTo(true);
    t.bigInteger('next_run_at').nullable();
    t.bigInteger('last_run_at').nullable();
    t.string('last_run_id', 26).nullable();
    t.string('last_result', 300).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'entity_id', 'kind']);
    t.index(['kind', 'enabled', 'next_run_at']);
  });

  await knex.schema.createTable('app_transfers', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('app_id', 26).notNullable();
    t.string('entity_id', 26).notNullable();
    t.string('kind', 10).notNullable(); // import | export
    t.string('state', 20).notNullable(); // queued | running | succeeded | failed
    t.boolean('dry_run').notNullable().defaultTo(false);
    t.text('input', 'mediumtext').nullable(); // the sealed CSV of an import, or the export's request
    t.string('blob_key', 300).nullable(); // the sealed CSV an export wrote
    t.text('summary').nullable();
    t.text('report', 'mediumtext').nullable();
    t.string('error', 500).nullable();
    t.string('job_id', 64).nullable();
    t.string('created_by', 26).notNullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('finished_at').nullable();
    t.index(['tenant_id', 'created_by']);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const t of ['app_transfers', 'app_triggers', 'app_forms', 'app_unique_values', 'app_record_values', 'app_records', 'app_entities', 'apps']) await knex.schema.dropTableIfExists(t);
}
