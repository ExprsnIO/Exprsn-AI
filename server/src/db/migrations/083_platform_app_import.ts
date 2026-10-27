import type { Knex } from 'knex';

/*
 * 1.7.0, importing the exprsn-platform's low-code apps into Apps (apps/platform-import.ts,
 * docs/decisions/lowcode-port.md, "Importing platform apps").
 *
 * - `app_platform_imports`: one dry run (`state` planned) and, once started, its import (queued, running, succeeded,
 *   failed). `plan` is the mapping report of the dry run, `report` the per-record results of the import. A credential
 *   passed in for this import (not the configured one) is kept sealed with the tenant key in `credential` only until
 *   the import ends.
 * - `app_platform_links`: which Exprsn-AI object each platform object was imported as (`kind` app, entity, record,
 *   form, flow), by the platform's base URL and id, so a second import updates instead of duplicating. A link whose
 *   target is gone is replaced by the next import.
 *
 * Expand only. A build from before this migration ignores both tables.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('app_platform_imports'))) {
    await knex.schema.createTable('app_platform_imports', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('source', 500).notNullable();
      t.string('source_app_id', 64).notNullable();
      t.string('source_app_key', 64).notNullable();
      t.string('target_app_id', 26).nullable();
      t.string('target_name', 63).notNullable();
      t.string('label', 20).notNullable();
      t.string('workspace_id', 26).nullable();
      t.string('state', 20).notNullable();
      t.text('options').notNullable();
      t.text('credential').nullable();
      t.string('fingerprint', 64).notNullable();
      t.text('plan', 'mediumtext').nullable();
      t.text('report', 'mediumtext').nullable();
      t.text('summary').nullable();
      t.string('error', 500).nullable();
      t.string('job_id', 26).nullable();
      t.string('created_by', 26).notNullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('started_at').nullable();
      t.bigInteger('finished_at').nullable();
      t.index(['tenant_id', 'created_by', 'created_at']);
    });
  }
  if (!(await knex.schema.hasTable('app_platform_links'))) {
    await knex.schema.createTable('app_platform_links', (t) => {
      t.string('tenant_id', 26).notNullable();
      t.string('source', 500).notNullable();
      t.string('kind', 10).notNullable();
      t.string('source_id', 64).notNullable();
      t.string('target_app_id', 26).notNullable();
      t.string('target_id', 26).notNullable();
      t.string('import_id', 26).notNullable();
      t.bigInteger('updated_at').notNullable();
      t.primary(['tenant_id', 'source', 'kind', 'source_id']);
      t.index(['target_app_id']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('app_platform_links');
  await knex.schema.dropTableIfExists('app_platform_imports');
}
