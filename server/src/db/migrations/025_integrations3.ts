import type { Knex } from 'knex';
import { ulid } from 'ulid';

/*
 * Sprint 23: knowledge, integrations and accessibility.
 * - Knowledge sources (B-1501, B-1502, B-1503): a sealed secret per source (the access key of an S3-compatible
 *   bucket that is not the platform's). Crawl limits, include patterns and role mappings live in the source's JSON
 *   config; page validators (ETag, Last-Modified) in each document's `version`.
 * - Webhooks (B-1504): one row per ordered endpoint with its next sequence number and the delivery lease, so
 *   instances allocate positions and send the head one at a time.
 * - Billing (B-1505): price book versions with the time each took effect (statements prorate by them), and the
 *   refunds, credit notes and disputes reconciled from Stripe.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('knowledge_sources', (t) => {
    t.text('secret_sealed').nullable(); // JSON { accessKeyId, secretAccessKey }, sealed with the tenant key
  });

  await knex.schema.createTable('webhook_order', (t) => {
    t.string('webhook_id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.bigInteger('next_seq').notNullable().defaultTo(1);
    t.string('holder', 64).nullable(); // the instance sending the head
    t.string('delivery_id', 26).nullable(); // the delivery it is sending
    t.bigInteger('lease_until').nullable();
    t.bigInteger('updated_at').notNullable();
  });

  await knex.schema.createTable('price_book_versions', (t) => {
    t.string('id', 26).primary();
    t.string('book_id', 26).notNullable();
    t.text('items', 'mediumtext').notNullable(); // JSON, as price_books.items
    t.bigInteger('effective_from').notNullable(); // ms; 0 for the book's first version
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.index(['book_id', 'effective_from']);
  });
  // Every existing book's current items apply from the start.
  const books = (await knex('price_books').select('id', 'items', 'created_at')) as { id: string; items: string; created_at: number | string }[];
  for (const b of books) await knex('price_book_versions').insert({ id: ulid(), book_id: b.id, items: b.items, effective_from: 0, created_by: null, created_at: Number(b.created_at) });

  await knex.schema.alterTable('billing_statements', (t) => {
    t.bigInteger('refunded_micros').nullable();
    t.bigInteger('credited_micros').nullable();
    t.bigInteger('disputed_micros').nullable();
    t.string('dispute_status', 40).nullable();
    t.text('credits').nullable(); // JSON: [{ id, amountMicros, state }]
    t.string('provider_charge', 100).nullable(); // the charge that paid the invoice (refunds and disputes name it)
    t.string('provider_payment', 100).nullable(); // its payment intent
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('billing_statements', (t) => {
    for (const c of ['provider_payment', 'provider_charge', 'credits', 'dispute_status', 'disputed_micros', 'credited_micros', 'refunded_micros']) t.dropColumn(c);
  });
  await knex.schema.dropTableIfExists('price_book_versions');
  await knex.schema.dropTableIfExists('webhook_order');
  await knex.schema.alterTable('knowledge_sources', (t) => {
    t.dropColumn('secret_sealed');
  });
}
