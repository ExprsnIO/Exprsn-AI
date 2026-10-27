import type { Knex } from 'knex';

/*
 * 1.9.99-final, Sprint 57 (B-10601): the price catalogue's cache (`cloud/prices.ts`).
 *
 * - `cloud_prices`: one row per provider, region (`*` for every region), SKU (`<service>:<provider sku>`), unit and
 *   currency: the price (a decimal as text, so every dialect keeps it exactly), its source (`aws-price-list`,
 *   `azure-retail-prices`, `digitalocean-sizes`), the call it came from, the price's own date and when it was
 *   fetched. Refreshed daily by `cloud.prices.refresh`; a row older than a day is fetched again on use.
 *
 * Expand only: one new table. While it is missing, estimates use the maintained price sheet only and say so.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('cloud_prices'))) {
    await knex.schema.createTable('cloud_prices', (t) => {
      t.string('id', 26).primary();
      t.string('provider', 20).notNullable();
      t.string('region', 40).notNullable();
      t.string('sku', 120).notNullable();
      t.string('unit', 12).notNullable(); // hour | month | gb-month | gb
      t.string('currency', 3).notNullable();
      t.string('price', 32).notNullable();
      t.string('source', 24).notNullable();
      t.string('source_ref', 300).nullable();
      t.string('price_date', 10).notNullable(); // YYYY-MM-DD
      t.bigInteger('fetched_at').notNullable();
      t.unique(['provider', 'region', 'sku', 'unit', 'currency']);
      t.index(['provider', 'sku']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('cloud_prices');
}
