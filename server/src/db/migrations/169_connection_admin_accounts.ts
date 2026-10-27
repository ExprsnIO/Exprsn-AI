import type { Knex } from 'knex';

/*
 * 2.0.x: schema changes through data connections (connections/ddl.ts). A connection may hold a second, separate
 * account that only the Schema designer and the Queues tab use to create objects; queries never use it.
 *
 * - `admin_credential`: `{ username, password }` sealed under the tenant key with `connection-admin:<id>`, as the read
 *   credential is with `connection:<id>`; `admin_account` the user name shown; `admin_vault_owner` who saved a `vault:`
 *   reference (it resolves as them); `admin_credential_ref` the vault reference once moved (credential-moves.ts);
 *   `admin_set_at` when it was last set.
 *
 * Expand only: nullable columns. A build from before this migration never reads them.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('data_connections')) || (await knex.schema.hasColumn('data_connections', 'admin_credential'))) return;
  await knex.schema.alterTable('data_connections', (t) => {
    t.text('admin_credential').nullable();
    t.string('admin_account', 200).nullable();
    t.string('admin_vault_owner', 26).nullable();
    t.string('admin_credential_ref', 400).nullable();
    t.bigInteger('admin_set_at').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('data_connections')) || !(await knex.schema.hasColumn('data_connections', 'admin_credential'))) return;
  await knex.schema.alterTable('data_connections', (t) => {
    t.dropColumn('admin_set_at');
    t.dropColumn('admin_credential_ref');
    t.dropColumn('admin_vault_owner');
    t.dropColumn('admin_account');
    t.dropColumn('admin_credential');
  });
}
