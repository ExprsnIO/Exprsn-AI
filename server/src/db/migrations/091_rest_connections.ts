import type { Knex } from 'knex';

/*
 * Sprint 45 (B-126): REST APIs as connection sources. Expand only.
 *
 * - `rest_connections`: a tenant's REST connection: base URL (its host on the tenant's list of allowed hosts), zone,
 *   label, the authentication kind and its plain settings (user name, header or parameter name, token URL, client id,
 *   scope), the sealed secret (`credential`, under `rest-connection:<id>`; a `vault:` reference is kept as written and
 *   resolved as `vault_owner`), the vault reference it is read through once moved (`credential_ref`, B-9208), default
 *   headers (no credential literals), the timeout and the size cap.
 * - `rest_endpoints`: the named GET resources of a connection: path template, typed parameters, query parameters,
 *   paging and the response mapping (items pointer, fields with types), and whether app lookups may use it.
 * - `app_entity_sources.kind` (`table` or `rest`) and `params` (an endpoint's parameter values): an entity may be
 *   pulled from a REST endpoint, read-only.
 *
 * A build from before this migration ignores the tables and the two columns.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('rest_connections'))) {
    await knex.schema.createTable('rest_connections', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('name', 63).notNullable();
      t.string('title', 200).nullable();
      t.string('base_url', 2000).notNullable();
      t.string('zone', 63).notNullable();
      t.string('label', 20).notNullable();
      t.string('auth_kind', 30).notNullable();
      t.text('auth_config').notNullable();
      t.text('credential').nullable();
      t.string('credential_ref', 500).nullable();
      t.string('vault_owner', 26).nullable();
      t.text('default_headers').notNullable();
      t.integer('timeout_ms').notNullable();
      t.integer('max_bytes').notNullable();
      t.string('health', 20).notNullable();
      t.string('health_detail', 500).nullable();
      t.bigInteger('checked_at').nullable();
      t.integer('version').notNullable().defaultTo(1);
      t.string('created_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.unique(['tenant_id', 'name']);
    });
  }
  if (!(await knex.schema.hasTable('rest_endpoints'))) {
    await knex.schema.createTable('rest_endpoints', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('connection_id', 26).notNullable();
      t.string('name', 63).notNullable();
      t.string('title', 200).nullable();
      t.string('description', 1000).nullable();
      t.text('definition', 'mediumtext').notNullable();
      t.boolean('lookups').notNullable().defaultTo(false);
      t.integer('version').notNullable().defaultTo(1);
      t.string('created_by', 26).nullable();
      t.string('updated_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.unique(['connection_id', 'name']);
      t.index(['tenant_id']);
    });
  }
  if (await knex.schema.hasTable('app_entity_sources')) {
    if (!(await knex.schema.hasColumn('app_entity_sources', 'kind'))) {
      await knex.schema.alterTable('app_entity_sources', (t) => {
        t.string('kind', 10).notNullable().defaultTo('table');
      });
    }
    if (!(await knex.schema.hasColumn('app_entity_sources', 'params'))) {
      await knex.schema.alterTable('app_entity_sources', (t) => {
        t.text('params').nullable();
      });
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('rest_endpoints');
  await knex.schema.dropTableIfExists('rest_connections');
}
