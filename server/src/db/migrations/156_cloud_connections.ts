import type { Knex } from 'knex';

/*
 * 1.9.99-final, Sprint 59 (B-10306): data connections made from a cloud account.
 *
 * - `cloud_discovered`: what the last discovery of an account found (RDS instances and Aurora clusters, DocumentDB
 *   clusters, DynamoDB tables, Azure flexible servers, Cosmos DB accounts and MongoDB vCore clusters, DigitalOcean
 *   database clusters), one row per account and provider id, with the normalised instance as JSON (endpoints, port,
 *   engine, the connection engine it maps to, the federated options it offers). Never a secret: no password, key or
 *   CA private part is ever in it. Rows not seen by a later discovery are removed by it.
 * - `cloud_connection_links`: one row per data connection made from an account: the instance (provider id, kind,
 *   region), which endpoint was used (`private` or `public`) and the host added to the tenant's allowed hosts with it,
 *   how the connection authenticates (`password`: the admin password in the vault; `lease`: per-connection users
 *   from a B-1704 lease engine and role; `rds-iam`, `entra`: short-lived tokens through the account's credential;
 *   `account`: the account's own session, DynamoDB and Cosmos DB; `key`: a vaulted key), the database user for the
 *   token options, the lease engine and role, the CA bundle (public certificates only), and the deployment resource
 *   it came from when it was provisioned.
 *
 * Expand only: two new tables. While it is missing, discovery answers from the providers without a cache, and the
 * connect action answers 503 `migration_pending`; connections behave exactly as before.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('cloud_discovered'))) {
    await knex.schema.createTable('cloud_discovered', (t) => {
      t.string('id', 26).primary();
      t.string('account_id', 26).notNullable();
      t.string('provider_id', 500).notNullable();
      t.string('kind', 30).notNullable();
      t.string('name', 255).notNullable();
      t.string('region', 64).nullable();
      t.string('engine', 20).nullable();
      t.text('instance', 'mediumtext').notNullable();
      t.bigInteger('seen_at').notNullable();
      t.unique(['account_id', 'provider_id']);
      t.index(['account_id', 'kind']);
    });
  }
  if (!(await knex.schema.hasTable('cloud_connection_links'))) {
    await knex.schema.createTable('cloud_connection_links', (t) => {
      t.string('connection_id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('account_id', 26).notNullable();
      t.string('provider_id', 500).notNullable();
      t.string('kind', 30).notNullable();
      t.string('region', 64).nullable();
      t.string('endpoint_kind', 10).notNullable(); // private | public
      t.string('host', 255).notNullable();
      t.string('auth', 10).notNullable(); // password | lease | rds-iam | entra | account | key
      t.string('db_user', 200).nullable();
      t.string('lease_engine', 64).nullable();
      t.string('lease_role', 32).nullable();
      t.text('ca_pem', 'mediumtext').nullable();
      t.string('deployment_id', 26).nullable();
      t.string('resource_key', 100).nullable();
      t.string('created_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.index(['tenant_id']);
      t.index(['account_id']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('cloud_connection_links');
  await knex.schema.dropTableIfExists('cloud_discovered');
}
