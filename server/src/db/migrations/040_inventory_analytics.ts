import type { Knex } from 'knex';

/*
 * 1.6.0, Sprint 38a.
 *
 * B-7301, B-7302 AI system inventory. Every model, profile, agent, workflow, tool, MCP server and dataset is a system
 * in the inventory; the objects themselves stay where they are, and `inventory_systems` holds what the register adds
 * to each: an accountable owner, a human-oversight role, data provenance, a lineage note, known issues and the
 * tenant's impact assessment. A system without an owner is incomplete; an agent that is incomplete is not published.
 *
 * B-7402 usage prices: a price per model or per pool (`scope`, `ref`), as a rate per million input and output tokens
 * and per GPU-hour, in one currency per tenant. Costs are computed from `usage_records` at read time; nothing is
 * stored per request.
 *
 * B-7501 audit streaming per tenant: `audit_siem_destinations` are HTTPS (NDJSON batches) or syslog-over-TLS
 * (RFC 5424, RFC 6587 octet counting) endpoints a tenant admin proposes and a second admin approves (dual control).
 * Only active destinations receive events. Bearer tokens are sealed with the tenant key. Delivery counters and the
 * last error are kept on the row so the Usage and audit screen shows them. Time-windowed JSONL audit exports with
 * their chain proof use the existing `exports` table with `kind = 'audit-jsonl'`.
 *
 * Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('inventory_systems', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('kind', 20).notNullable(); // model | profile | agent | workflow | tool | mcp-server | dataset
    t.string('ref_id', 100).notNullable();
    t.string('owner_id', 26).nullable();
    t.string('oversight_role', 100).nullable();
    t.text('provenance').nullable();
    t.text('lineage').nullable();
    t.text('known_issues').nullable();
    t.text('impact_assessment').nullable();
    t.string('updated_by', 26).notNullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'kind', 'ref_id']);
  });

  // Per tenant: whether publishing an agent needs an owner in the inventory (off until a model admin turns it on, so
  // existing tenants keep publishing until their register is filled in).
  await knex.schema.createTable('inventory_settings', (t) => {
    t.string('tenant_id', 26).primary();
    t.boolean('require_owner').notNullable().defaultTo(false);
    t.string('updated_by', 26).notNullable();
    t.bigInteger('updated_at').notNullable();
  });

  await knex.schema.createTable('usage_prices', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('scope', 10).notNullable(); // model | pool
    t.string('ref', 200).notNullable(); // the model name, or the pool id
    t.string('currency', 3).notNullable();
    t.decimal('input_per_million', 14, 6).notNullable().defaultTo(0);
    t.decimal('output_per_million', 14, 6).notNullable().defaultTo(0);
    t.decimal('gpu_hour', 14, 6).notNullable().defaultTo(0);
    t.string('note', 300).nullable();
    t.string('updated_by', 26).notNullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'scope', 'ref']);
  });

  await knex.schema.createTable('audit_siem_destinations', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('name', 100).notNullable();
    t.string('kind', 10).notNullable(); // https | syslog
    t.string('url', 500).notNullable(); // https://host/path, or syslog host:port
    t.text('token').nullable(); // sealed bearer token (https)
    t.text('ca_pem').nullable(); // a private CA for the TLS connection (syslog), else the system store
    t.string('state', 20).notNullable(); // proposed | active | rejected | disabled
    t.string('proposed_by', 26).notNullable();
    t.bigInteger('proposed_at').notNullable();
    t.string('approved_by', 26).nullable();
    t.bigInteger('approved_at').nullable();
    t.string('decided_by', 26).nullable();
    t.bigInteger('decided_at').nullable();
    t.string('note', 300).nullable();
    t.integer('delivered').notNullable().defaultTo(0);
    t.integer('dropped').notNullable().defaultTo(0);
    t.bigInteger('last_delivered_at').nullable();
    t.string('last_error', 300).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'state']);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['audit_siem_destinations', 'usage_prices', 'inventory_settings', 'inventory_systems']) await knex.schema.dropTableIfExists(table);
}
