import type { Knex } from 'knex';

/*
 * 1.7.0, Sprint 42 (B-9208): third-party credentials move to vault paths.
 *
 * A nullable reference column beside each sealed credential. NULL (every existing row): the integration reads its
 * sealed value, as before. A `vault:integrations/<kind>/<id>#<field>` reference, written by the move an admin runs:
 * the integration reads the vault secret as the tenant service `integration.<kind>`. The sealed columns are not
 * touched by the migration or by the move; removing them is a later step.
 *
 *   webhooks.secret_ref                 beside secret_sealed
 *   mcp_servers.credential_ref          beside credential
 *   data_connections.credential_ref     beside credential (the password inside it)
 *   moderation_providers.secret_ref     beside secret
 *   channels.identity_secret_ref        beside identity_secret
 *   channels.webhook_secret_ref         beside webhook_secret
 *   knowledge_sources.secret_ref        beside secret_sealed
 *   mcp_oauth.client_secret_ref         beside client_secret (an MCP server's OAuth client)
 *
 * Expand only; no existing row changes. A build from before this migration ignores the columns and reads the sealed
 * values, which stay current: a credential changed after its move is written to both places.
 */
const COLUMNS: [string, string][] = [
  ['webhooks', 'secret_ref'],
  ['mcp_servers', 'credential_ref'],
  ['data_connections', 'credential_ref'],
  ['moderation_providers', 'secret_ref'],
  ['channels', 'identity_secret_ref'],
  ['channels', 'webhook_secret_ref'],
  ['knowledge_sources', 'secret_ref'],
  ['mcp_oauth', 'client_secret_ref']
];

export async function up(knex: Knex): Promise<void> {
  for (const [table, column] of COLUMNS) {
    if ((await knex.schema.hasTable(table)) && !(await knex.schema.hasColumn(table, column))) {
      await knex.schema.alterTable(table, (t) => {
        t.string(column, 600).nullable();
      });
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const [table, column] of COLUMNS) {
    if ((await knex.schema.hasTable(table)) && (await knex.schema.hasColumn(table, column))) {
      await knex.schema.alterTable(table, (t) => {
        t.dropColumn(column);
      });
    }
  }
}
