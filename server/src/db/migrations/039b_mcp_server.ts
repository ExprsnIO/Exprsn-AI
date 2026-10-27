import type { Knex } from 'knex';
import { BUILTIN_TOOLS } from '../../registry/builtin/catalog.js';

/*
 * Sprint 37b (1.6.0), the MCP server and MCP authorization (039b_mcp_server): B-7101 to B-7103. Expand only.
 *
 * - `mcp_publications`: one row per workspace that publishes an MCP server (B-7101): on or off, the tool groups it
 *   publishes (workflows, agents, knowledge, tools, records), the highest label a call may carry (the caller's
 *   clearance is lowered to it for every call), and whether tokens must be DPoP-bound.
 * - `mcp_server_settings`: per tenant, whether MCP clients may register themselves with the tenant's issuer (RFC 7591
 *   dynamic client registration, off by default).
 * - `mcp_server_holds`: write and destructive calls (and calls the tool-call guardrail holds) made over MCP wait here
 *   until the caller approves them from a browser session; the arguments are sealed, matched again by their hash.
 * - `oidc_codes.resource`, `oidc_refresh_tokens.resource` (B-7102, RFC 8707): the resource a grant was issued for,
 *   which becomes the access token's audience and stays with the grant through refreshes. Null: the API (`/api`).
 * - `oidc_clients.dynamic`: the client registered itself (RFC 7591), listed on the MCP server page.
 * - `mcp_oauth` (B-7103): how this server reaches an MCP server's authorization server: discovered (RFC 9728 and
 *   RFC 8414) or entered by hand, the client it registered or was given (the secret sealed), scopes and resource.
 * - `mcp_oauth_states`: authorization requests in flight (PKCE verifier sealed, bound to the browser that started).
 * - `mcp_tokens.refresh_token` (sealed), `source` (`manual` for a pasted token, `oauth`), `refreshed_at`.
 * - `registry_entries`: the built-in record tools (`records.*`, added to the catalogue by this sprint).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('mcp_publications', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).notNullable();
    t.boolean('enabled').notNullable().defaultTo(false);
    t.string('groups', 200).notNullable(); // JSON array of group names
    t.string('label', 20).notNullable().defaultTo('internal');
    t.boolean('require_dpop').notNullable().defaultTo(false);
    t.string('created_by', 26).nullable();
    t.string('updated_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'workspace_id'], { indexName: 'mcp_publications_ws_uq' });
  });
  await knex.schema.createTable('mcp_server_settings', (t) => {
    t.string('tenant_id', 26).primary();
    t.boolean('dynamic_registration').notNullable().defaultTo(false);
    t.string('updated_by', 26).nullable();
    t.bigInteger('updated_at').notNullable();
  });
  await knex.schema.createTable('mcp_server_holds', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('client_id', 100).nullable();
    t.string('tool', 140).notNullable();
    t.string('args_hash', 64).notNullable();
    t.text('args', 'mediumtext').notNullable(); // sealed
    t.string('side_effect', 20).notNullable();
    t.string('label', 20).notNullable();
    t.string('reason', 500).nullable();
    t.string('state', 20).notNullable(); // pending | approved | rejected | used | expired
    t.string('decided_by', 26).nullable();
    t.bigInteger('decided_at').nullable();
    t.bigInteger('used_at').nullable();
    t.bigInteger('expires_at').notNullable();
    t.bigInteger('created_at').notNullable();
    t.index(['tenant_id', 'user_id', 'state'], 'mcp_server_holds_user_idx');
  });
  await knex.schema.alterTable('oidc_codes', (t) => {
    t.string('resource', 500).nullable();
  });
  await knex.schema.alterTable('oidc_refresh_tokens', (t) => {
    t.string('resource', 500).nullable();
  });
  await knex.schema.alterTable('oidc_clients', (t) => {
    t.boolean('dynamic').notNullable().defaultTo(false);
  });
  await knex.schema.createTable('mcp_oauth', (t) => {
    t.string('server_id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('mode', 20).notNullable(); // discovered | manual
    t.string('resource', 500).nullable();
    t.string('issuer', 500).nullable();
    t.string('authorization_endpoint', 500).notNullable();
    t.string('token_endpoint', 500).notNullable();
    t.string('registration_endpoint', 500).nullable();
    t.string('revocation_endpoint', 500).nullable();
    t.string('client_id', 300).notNullable();
    t.text('client_secret').nullable(); // sealed
    t.boolean('registered').notNullable().defaultTo(false);
    t.string('scopes', 500).nullable();
    t.text('metadata').nullable();
    t.string('updated_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id'], 'mcp_oauth_tenant_idx');
  });
  await knex.schema.createTable('mcp_oauth_states', (t) => {
    t.string('id', 64).primary(); // HMAC of the state value
    t.string('tenant_id', 26).notNullable();
    t.string('server_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.text('verifier').notNullable(); // sealed
    t.string('binding', 64).notNullable(); // HMAC of the browser cookie's value
    t.string('return_to', 200).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('expires_at').notNullable();
  });
  await knex.schema.alterTable('mcp_tokens', (t) => {
    t.text('refresh_token').nullable(); // sealed
    t.string('source', 10).notNullable().defaultTo('manual');
    t.bigInteger('refreshed_at').nullable();
  });
  const now = Date.now();
  for (const b of BUILTIN_TOOLS) {
    if (await knex('registry_entries').where({ id: b.id }).first('id')) continue;
    const hash = `builtin-${b.builtin}-1`;
    await knex('registry_entries').insert({
      id: b.id,
      tenant_id: null,
      workspace_id: null,
      kind: 'tool',
      name: b.name,
      version: '1.0.0',
      description: b.description,
      impl: 'builtin',
      side_effect: b.sideEffect,
      confirm: 'never',
      rate_per_hour: null,
      label: b.label,
      input_schema: JSON.stringify(b.inputSchema),
      output_schema: JSON.stringify(b.outputSchema),
      definition: JSON.stringify({ builtin: b.builtin }),
      status: 'published',
      schema_hash: hash,
      approved_hash: hash,
      checks: JSON.stringify([{ name: 'Built into the platform', ok: true, detail: 'Ships with the server; acts through the domain service as the caller; reviewed with each release.' }]),
      checked_at: now,
      owner_id: null,
      owner_name: 'Platform',
      publish_scope: 'platform',
      created_at: now,
      updated_at: now
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex('registry_entries').where({ impl: 'builtin' }).andWhere('name', 'like', 'records.%').delete();
  await knex.schema.alterTable('mcp_tokens', (t) => {
    t.dropColumn('refresh_token');
    t.dropColumn('source');
    t.dropColumn('refreshed_at');
  });
  await knex.schema.alterTable('oidc_clients', (t) => {
    t.dropColumn('dynamic');
  });
  await knex.schema.alterTable('oidc_refresh_tokens', (t) => {
    t.dropColumn('resource');
  });
  await knex.schema.alterTable('oidc_codes', (t) => {
    t.dropColumn('resource');
  });
  for (const table of ['mcp_oauth_states', 'mcp_oauth', 'mcp_server_holds', 'mcp_server_settings', 'mcp_publications']) await knex.schema.dropTableIfExists(table);
}
