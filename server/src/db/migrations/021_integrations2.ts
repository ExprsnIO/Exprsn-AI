import type { Knex } from 'knex';

/*
 * Sprint 19: knowledge, integrations and workflows.
 * - Row-level access for database knowledge sources (B-1002): the access list a row carries, on its document and on
 *   every chunk of it, checked at retrieval.
 * - Logical replication for PostgreSQL knowledge sources (B-1003): one row per source that streams, with the lease
 *   that decides which instance holds the stream and the last acknowledged LSN.
 * - Webhooks (B-1004): ordered delivery per endpoint (a sequence per delivery) and Ed25519 signing keys per tenant.
 * - Billing (B-1005): price books owned by a tenant, a currency and tax rates per tenant, taxes on statements,
 *   and the Stripe events received (one row per event id, so a redelivered event is applied once).
 * - Workflows (B-1006): the caller of a run started as a tool (an agent run that awaits its result).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('knowledge_documents', (t) => {
    t.text('acl').nullable(); // JSON: ["g:<group>", "u:<user>"]; null means the base's access alone
  });
  await knex.schema.alterTable('knowledge_chunks', (t) => {
    t.text('acl').nullable();
  });

  await knex.schema.createTable('knowledge_replication', (t) => {
    t.string('source_id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('slot', 63).notNullable();
    t.string('publication', 63).notNullable();
    t.string('state', 20).notNullable(); // starting | streaming | fallback | stopped
    t.string('holder', 64).nullable(); // the instance holding the stream
    t.bigInteger('lease_until').nullable();
    t.string('lsn', 40).nullable(); // last acknowledged LSN
    t.bigInteger('last_change_at').nullable();
    t.integer('changes').notNullable().defaultTo(0);
    t.string('error', 1000).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id']);
  });

  await knex.schema.alterTable('webhooks', (t) => {
    t.boolean('ordered').notNullable().defaultTo(false);
    t.string('signing', 20).notNullable().defaultTo('hmac'); // hmac | ed25519
  });
  await knex.schema.alterTable('webhook_deliveries', (t) => {
    t.bigInteger('seq').nullable(); // per webhook, in the order events were queued
    t.index(['webhook_id', 'state', 'seq']);
  });
  await knex.schema.createTable('webhook_signing_keys', (t) => {
    t.string('id', 26).primary(); // the key id sent as x-exprsn-key-id
    t.string('tenant_id', 26).notNullable();
    t.string('public_key', 100).notNullable(); // base64url of the raw 32-byte Ed25519 public key
    t.text('private_sealed').notNullable(); // PKCS#8 DER, sealed with the tenant key
    t.string('state', 20).notNullable(); // active | retired
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('retired_at').nullable();
    t.index(['tenant_id', 'state']);
  });

  await knex.schema.alterTable('price_books', (t) => {
    t.string('tenant_id', 26).nullable(); // null: a platform book any tenant may use
  });
  await knex.schema.alterTable('tenant_integrations', (t) => {
    t.string('billing_currency', 3).nullable();
    t.text('tax_rates').nullable(); // JSON: [{ name, ratePpm }]
  });
  await knex.schema.alterTable('billing_statements', (t) => {
    t.bigInteger('subtotal_micros').nullable();
    t.bigInteger('tax_micros').nullable();
    t.text('taxes').nullable(); // JSON: [{ name, ratePpm, amountMicros }]
    t.bigInteger('paid_at').nullable();
    t.string('provider_status', 40).nullable(); // the last provider event applied
  });
  await knex.schema.createTable('billing_provider_events', (t) => {
    t.string('id', 100).primary(); // the provider's event id (Stripe evt_…)
    t.string('provider', 20).notNullable();
    t.string('type', 100).notNullable();
    t.string('tenant_id', 26).nullable();
    t.string('statement_id', 26).nullable();
    t.string('result', 200).notNullable();
    t.bigInteger('received_at').notNullable();
  });

  await knex.schema.alterTable('workflow_runs', (t) => {
    t.string('caller_kind', 20).nullable(); // agent-run: an agent run awaits this run's result
    t.string('caller_id', 26).nullable();
    t.index(['caller_kind', 'caller_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('workflow_runs', (t) => {
    t.dropIndex(['caller_kind', 'caller_id']);
    t.dropColumn('caller_id');
    t.dropColumn('caller_kind');
  });
  await knex.schema.dropTableIfExists('billing_provider_events');
  await knex.schema.alterTable('billing_statements', (t) => {
    for (const c of ['provider_status', 'paid_at', 'taxes', 'tax_micros', 'subtotal_micros']) t.dropColumn(c);
  });
  await knex.schema.alterTable('tenant_integrations', (t) => {
    t.dropColumn('tax_rates');
    t.dropColumn('billing_currency');
  });
  await knex.schema.alterTable('price_books', (t) => {
    t.dropColumn('tenant_id');
  });
  await knex.schema.dropTableIfExists('webhook_signing_keys');
  await knex.schema.alterTable('webhook_deliveries', (t) => {
    t.dropIndex(['webhook_id', 'state', 'seq']);
    t.dropColumn('seq');
  });
  await knex.schema.alterTable('webhooks', (t) => {
    t.dropColumn('signing');
    t.dropColumn('ordered');
  });
  await knex.schema.dropTableIfExists('knowledge_replication');
  await knex.schema.alterTable('knowledge_chunks', (t) => {
    t.dropColumn('acl');
  });
  await knex.schema.alterTable('knowledge_documents', (t) => {
    t.dropColumn('acl');
  });
}
