import type { Knex } from 'knex';

/*
 * 1.9.99-final, Sprint 59 (B-10603): billing ingestion (`cloud/costs.ts`).
 *
 * - `cloud_costs`: the daily rows a cloud bill comes back as, one per account, day (`YYYY-MM-DD`, UTC), allocation,
 *   service and currency: the provider, the deployment it is attributed to (null: unattributed), the allocation key
 *   (the `exprsn:deployment` tag's value on AWS and Azure, the invoice item's resource id on DigitalOcean, '' when
 *   there is none), the amount (a decimal as text, so every dialect keeps it exactly), the currency the provider
 *   billed in (open decision 17: never converted), the source (`aws-cost-explorer`, `azure-cost-management`,
 *   `digitalocean-invoice`, `digitalocean-preview`), whether the provider still calls the figure an estimate, and when
 *   it was fetched. A re-fetch replaces the rows of the days it covers (providers revise recent days).
 * - `cloud_cost_fetches`: one row per account and fetch key (the UTC day of a scheduled fetch, or the day and hour of
 *   a "fetch now"), so each account is fetched at most once a day by the schedule and once an hour by hand, across
 *   instances; a crashed or failed fetch is taken over (at most three attempts a key). It keeps the window, the number
 *   of provider requests, the rows written, the totals per currency, the DigitalOcean balance and the error.
 *
 * Expand only: two new tables. While they are missing, nothing is fetched, the cost routes answer 503
 * `migration_pending`, and budgets keep reckoning spend from the applied plans' estimates.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('cloud_costs'))) {
    await knex.schema.createTable('cloud_costs', (t) => {
      t.string('id', 26).primary();
      t.string('account_id', 26).notNullable();
      t.string('provider', 20).notNullable();
      t.string('deployment_id', 26).nullable();
      t.string('allocation', 200).notNullable(); // tag value or resource id; '' when unattributed
      t.string('service', 200).notNullable();
      t.string('day', 10).notNullable(); // YYYY-MM-DD (UTC)
      t.string('amount', 32).notNullable();
      t.string('currency', 3).notNullable();
      t.string('source', 32).notNullable();
      t.boolean('estimated').notNullable().defaultTo(false);
      t.bigInteger('fetched_at').notNullable();
      t.unique(['account_id', 'day', 'allocation', 'service', 'currency']);
      t.index(['account_id', 'day']);
      t.index(['deployment_id', 'day']);
    });
  }
  if (!(await knex.schema.hasTable('cloud_cost_fetches'))) {
    await knex.schema.createTable('cloud_cost_fetches', (t) => {
      t.string('id', 26).primary();
      t.string('account_id', 26).notNullable();
      t.string('provider', 20).notNullable();
      t.string('fetch_key', 24).notNullable(); // YYYY-MM-DD, or YYYY-MM-DDTHH:manual
      t.boolean('manual').notNullable().defaultTo(false);
      t.string('state', 10).notNullable(); // running | ok | failed
      t.integer('attempts').notNullable().defaultTo(1);
      t.string('window_from', 10).nullable();
      t.string('window_to', 10).nullable(); // exclusive
      t.integer('requests').notNullable().defaultTo(0);
      t.integer('rows').notNullable().defaultTo(0);
      t.text('totals').nullable(); // JSON { currency: amount }
      t.text('note').nullable(); // JSON (DigitalOcean balance, pages)
      t.string('error', 500).nullable();
      t.string('requested_by', 26).nullable();
      t.bigInteger('started_at').notNullable();
      t.bigInteger('finished_at').nullable();
      t.unique(['account_id', 'fetch_key']);
      t.index(['account_id', 'started_at']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('cloud_cost_fetches');
  await knex.schema.dropTableIfExists('cloud_costs');
}
