import type { Knex } from 'knex';

/*
 * Sprint 25 (B-1704 to B-1706): database leases, vault references and rotation schedules.
 * - Database engines: a tenant's PostgreSQL or MySQL server with an admin login (its password sealed with the tenant
 *   data key, or a `vault:` reference read as the user who registered the engine), a zone and a label.
 * - Engine roles: what a lease may do, from a fixed set of privilege templates (read, read-write) on named schemas.
 * - Leases: one generated database account each, with its expiry, its cap and its revocation state. The password is
 *   returned once at issue and never stored.
 * - `vault_owner` on user stores, data connections and MCP servers: the user whose vault policy resolves the
 *   object's `vault:` references (who saved them).
 * - Rotation schedules on KV secrets and transit keys, with the notice already sent for the current version.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('vault_db_engines', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('name', 64).notNullable();
    t.string('dialect', 20).notNullable(); // postgres | mysql
    t.string('endpoint', 300).notNullable();
    t.string('database', 200).nullable();
    t.boolean('tls').notNullable().defaultTo(false);
    t.string('zone', 63).notNullable();
    t.string('label', 20).notNullable();
    t.string('admin_username', 200).notNullable();
    t.text('admin_password_sealed').nullable();
    t.string('admin_password_ref', 600).nullable();
    t.string('user_host', 100).notNullable().defaultTo('%'); // MySQL account host
    t.integer('default_ttl_s').notNullable();
    t.integer('max_ttl_s').notNullable();
    t.string('state', 20).notNullable().defaultTo('active');
    t.string('owner_id', 26).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'name']);
  });

  await knex.schema.createTable('vault_db_roles', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('engine_id', 26).notNullable();
    t.string('name', 32).notNullable();
    t.string('privileges', 20).notNullable(); // read | readwrite
    t.text('schemas').notNullable(); // JSON array of schema names (PostgreSQL)
    t.integer('default_ttl_s').nullable();
    t.integer('max_ttl_s').nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['engine_id', 'name']);
  });

  await knex.schema.createTable('vault_db_leases', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('engine_id', 26).notNullable();
    t.string('engine_name', 64).notNullable();
    t.string('role_id', 26).notNullable();
    t.string('role_name', 32).notNullable();
    t.text('grants').notNullable(); // JSON: the privileges and schemas granted at issue, revoked at the end
    t.string('label', 20).notNullable();
    t.string('username', 64).notNullable();
    t.string('state', 20).notNullable(); // active | revoking | revoked | expired
    t.string('issued_to', 26).nullable();
    t.string('api_key_id', 26).nullable();
    t.bigInteger('issued_at').notNullable();
    t.bigInteger('expires_at').notNullable();
    t.bigInteger('max_expires_at').notNullable();
    t.integer('renewals').notNullable().defaultTo(0);
    t.bigInteger('ended_at').nullable();
    t.string('ended_by', 26).nullable();
    t.string('end_reason', 40).nullable();
    t.integer('attempts').notNullable().defaultTo(0);
    t.string('last_error', 500).nullable();
    t.bigInteger('next_attempt_at').nullable();
    t.index(['state', 'expires_at']);
    t.index(['tenant_id', 'engine_id']);
    t.unique(['engine_id', 'username']);
  });

  for (const table of ['identity_providers', 'data_connections', 'mcp_servers']) {
    await knex.schema.alterTable(table, (t) => {
      t.string('vault_owner', 26).nullable();
    });
  }

  await knex.schema.alterTable('vault_secrets', (t) => {
    t.bigInteger('rotation_period_ms').nullable();
    t.string('owner_id', 26).nullable();
    t.string('rotation_notice', 20).nullable(); // due | overdue: the last notice sent for rotation_notice_version
    t.integer('rotation_notice_version').nullable();
    t.bigInteger('rotation_notified_at').nullable();
  });

  await knex.schema.alterTable('vault_transit_keys', (t) => {
    t.bigInteger('rotation_period_ms').nullable();
    t.boolean('auto_rotate').notNullable().defaultTo(false);
    t.string('owner_id', 26).nullable();
    t.string('rotation_notice', 20).nullable();
    t.integer('rotation_notice_version').nullable();
    t.bigInteger('rotation_notified_at').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('vault_transit_keys', (t) => {
    t.dropColumns('rotation_period_ms', 'auto_rotate', 'owner_id', 'rotation_notice', 'rotation_notice_version', 'rotation_notified_at');
  });
  await knex.schema.alterTable('vault_secrets', (t) => {
    t.dropColumns('rotation_period_ms', 'owner_id', 'rotation_notice', 'rotation_notice_version', 'rotation_notified_at');
  });
  for (const table of ['identity_providers', 'data_connections', 'mcp_servers']) {
    await knex.schema.alterTable(table, (t) => {
      t.dropColumn('vault_owner');
    });
  }
  for (const table of ['vault_db_leases', 'vault_db_roles', 'vault_db_engines']) await knex.schema.dropTableIfExists(table);
}
