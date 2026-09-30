import type { Knex } from 'knex';

/*
 * Sprint 13: integrations. Per-tenant integration settings (the outbound host allow-list, the price book and the
 * billing customer), outbound webhooks with their delivery log, the prompt library, conversation shares and
 * exports, price books and monthly statements. Webhook secrets, prompt bodies and delivery payloads are sealed with
 * the tenant key; share-link tokens are stored as HMAC digests.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('tenant_integrations', (t) => {
    t.string('tenant_id', 26).primary();
    t.text('allowed_hosts').notNullable(); // JSON: hostnames, *.domain and CIDRs; empty means no tenant narrowing
    t.string('price_book_id', 26).nullable();
    t.string('billing_customer', 100).nullable(); // the provider's customer id (Stripe cus_…)
    t.string('updated_by', 26).nullable();
    t.bigInteger('updated_at').notNullable();
  });

  await knex.schema.createTable('webhooks', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('name', 100).notNullable();
    t.string('url', 2000).notNullable();
    t.text('events').notNullable(); // JSON: event patterns (exact, prefix.*, or *)
    t.string('max_label', 20).notNullable(); // events labelled above this are not sent
    t.text('secret_sealed').notNullable();
    t.string('state', 20).notNullable(); // active | disabled
    t.string('breaker', 20).notNullable().defaultTo('closed'); // closed | open
    t.integer('failures').notNullable().defaultTo(0); // consecutive failed attempts
    t.bigInteger('opened_at').nullable();
    t.bigInteger('last_delivery_at').nullable();
    t.string('last_status', 20).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'name']);
  });

  await knex.schema.createTable('webhook_deliveries', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('webhook_id', 26).notNullable();
    t.string('event', 120).notNullable();
    t.string('event_id', 120).notNullable();
    t.string('label', 20).notNullable();
    t.text('payload', 'mediumtext').notNullable(); // sealed JSON body
    t.string('state', 20).notNullable(); // pending | succeeded | failed
    t.integer('attempts').notNullable().defaultTo(0);
    t.integer('status_code').nullable();
    t.string('error', 1000).nullable();
    t.bigInteger('next_attempt_at').nullable();
    t.integer('duration_ms').nullable();
    t.string('replay_of', 26).nullable();
    t.string('job_id', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('delivered_at').nullable();
    t.index(['tenant_id', 'webhook_id', 'created_at']);
    // One delivery per event per subscription, however many instances see the event (replays get their own key).
    t.string('dedupe_key', 200).notNullable().unique();
  });

  await knex.schema.createTable('prompt_templates', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).nullable(); // null: tenant-wide
    t.string('name', 100).notNullable();
    t.string('description', 500).nullable();
    t.string('label', 20).notNullable();
    t.string('state', 20).notNullable(); // draft | published | deprecated | retired
    t.integer('version').notNullable(); // the latest version
    t.integer('published_version').nullable(); // the version chat and the API use
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'workspace_id']);
  });

  await knex.schema.createTable('prompt_versions', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('template_id', 26).notNullable();
    t.integer('version').notNullable();
    t.text('body', 'mediumtext').notNullable(); // sealed
    t.text('variables').notNullable(); // JSON: [{ name, description, default }]
    t.string('notes', 500).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.unique(['template_id', 'version']);
  });

  await knex.schema.createTable('conversation_shares', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('conversation_id', 26).notNullable();
    t.string('kind', 20).notNullable(); // user | workspace | link
    t.string('user_id', 26).nullable();
    t.string('workspace_id', 26).nullable();
    t.string('token_hash', 64).nullable().unique();
    t.bigInteger('expires_at').nullable();
    t.string('created_by', 26).notNullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('revoked_at').nullable();
    t.string('revoked_by', 26).nullable();
    t.bigInteger('last_viewed_at').nullable();
    t.index(['tenant_id', 'conversation_id']);
    t.index(['tenant_id', 'user_id']);
  });

  await knex.schema.createTable('conversation_exports', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('conversation_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('format', 20).notNullable(); // markdown | json
    t.string('label', 20).notNullable();
    t.string('state', 20).notNullable(); // queued | running | ready | failed
    t.string('file', 200).notNullable();
    t.string('blob_key', 512).nullable();
    t.integer('bytes').nullable();
    t.string('error', 500).nullable();
    t.string('job_id', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.index(['tenant_id', 'user_id']);
  });

  await knex.schema.createTable('price_books', (t) => {
    t.string('id', 26).primary();
    t.string('name', 100).notNullable().unique();
    t.string('currency', 3).notNullable();
    t.boolean('is_default').notNullable().defaultTo(false);
    t.string('state', 20).notNullable(); // active | retired
    t.text('items').notNullable(); // JSON: [{ match, value, usage, meter, perUnits, unitPriceMicros }]
    t.string('updated_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });

  await knex.schema.createTable('billing_statements', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.integer('month').notNullable(); // YYYYMM, UTC
    t.string('book_id', 26).nullable();
    t.string('book_name', 100).nullable();
    t.string('currency', 3).notNullable();
    t.bigInteger('total_micros').notNullable();
    t.text('lines', 'mediumtext').notNullable(); // JSON
    t.text('totals').notNullable(); // JSON: usage totals for the month
    t.string('state', 20).notNullable(); // open | closed | pushed | push failed
    t.string('provider_ref', 100).nullable();
    t.string('push_error', 500).nullable();
    t.bigInteger('computed_at').notNullable();
    t.bigInteger('pushed_at').nullable();
    t.unique(['tenant_id', 'month']);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const t of ['billing_statements', 'price_books', 'conversation_exports', 'conversation_shares', 'prompt_versions', 'prompt_templates', 'webhook_deliveries', 'webhooks', 'tenant_integrations']) {
    await knex.schema.dropTableIfExists(t);
  }
}
