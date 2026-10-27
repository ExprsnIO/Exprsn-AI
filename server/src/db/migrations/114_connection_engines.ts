import type { Knex } from 'knex';

/*
 * 1.9.0: more connection types. Expand only.
 *
 * - `data_connections.options`: the engine's own settings as JSON (SQL Server and Azure SQL schema,
 *   application intent and authentication; Oracle schema and certificate DN; Snowflake authentication, warehouse,
 *   role and schema; BigQuery location and byte cap). Never a secret: credentials stay sealed in `credential`.
 *   `engine` (string 20) already holds the new names: mssql, azure-sql, oracle, snowflake, bigquery.
 * - `rest_connections.protocol`: `rest` (as before), `graphql` or `soap`.
 * - `rest_connections.wsdl_url`, `wsdl` and `wsdl_at`: a SOAP connection's service description, as fetched or uploaded
 *   (the document itself, capped), and `service_meta`: what was read from it (services, ports, operations and their
 *   messages) as JSON.
 *
 * A build from before this migration ignores the columns; a connection of a new engine or protocol is then listed
 * with an engine it does not install, and refuses to run.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('data_connections', 'options'))) {
    await knex.schema.alterTable('data_connections', (t) => {
      t.text('options').nullable();
    });
  }
  if (await knex.schema.hasTable('rest_connections')) {
    if (!(await knex.schema.hasColumn('rest_connections', 'protocol'))) {
      await knex.schema.alterTable('rest_connections', (t) => {
        t.string('protocol', 10).notNullable().defaultTo('rest');
      });
    }
    if (!(await knex.schema.hasColumn('rest_connections', 'wsdl_url'))) {
      await knex.schema.alterTable('rest_connections', (t) => {
        t.string('wsdl_url', 2000).nullable();
        t.text('wsdl', 'mediumtext').nullable();
        t.bigInteger('wsdl_at').nullable();
        t.text('service_meta', 'mediumtext').nullable();
      });
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('rest_connections')) {
    for (const col of ['service_meta', 'wsdl_at', 'wsdl', 'wsdl_url', 'protocol']) {
      if (await knex.schema.hasColumn('rest_connections', col)) await knex.schema.alterTable('rest_connections', (t) => void t.dropColumn(col));
    }
  }
  if (await knex.schema.hasColumn('data_connections', 'options')) await knex.schema.alterTable('data_connections', (t) => void t.dropColumn('options'));
}
