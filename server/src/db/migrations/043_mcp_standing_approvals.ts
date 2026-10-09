import type { Knex } from 'knex';

/*
 * Sprint 41a (1.7.0), standing approvals for MCP server write calls (043_mcp_standing_approvals): B-12201. Expand only.
 *
 * - `mcp_standing_approvals`: a person's standing approval for the write (or destructive) calls an MCP client makes
 *   as them in one workspace's MCP server: for one tool or every tool of the server (`tool` null), for one client or
 *   any (`client_id` null), up to a side-effect class, at the label the person held when they granted it, for a
 *   period. A covered call skips the per-call browser approval (the hold of Sprint 37b); a call the tool-call
 *   guardrail holds still waits. Revoked or expired rows stay for the audit trail; `uses` counts the calls it covered.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('mcp_standing_approvals', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('client_id', 100).nullable();
    t.string('tool', 140).nullable();
    t.string('side_effect', 20).notNullable(); // write | destructive: the highest class the approval covers
    t.string('label', 20).notNullable();
    t.string('reason', 300).nullable();
    t.string('state', 20).notNullable(); // active | revoked | expired
    t.string('granted_by', 26).notNullable();
    t.integer('uses').notNullable().defaultTo(0);
    t.bigInteger('last_used_at').nullable();
    t.bigInteger('expires_at').notNullable();
    t.string('revoked_by', 26).nullable();
    t.bigInteger('revoked_at').nullable();
    t.bigInteger('created_at').notNullable();
    t.index(['tenant_id', 'user_id', 'state'], 'mcp_standing_user_idx');
    t.index(['tenant_id', 'state', 'expires_at'], 'mcp_standing_expiry_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('mcp_standing_approvals');
}
