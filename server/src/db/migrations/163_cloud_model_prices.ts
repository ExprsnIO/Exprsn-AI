import type { Knex } from 'knex';

/*
 * 1.9.99-final, Sprint 61 (B-10505, B-10507): versioned cloud model prices and data-terms attestations.
 *
 * - `cloud_model_prices`: one row per price version of a cloud model (`cloud/model-prices.ts`): provider, the region
 *   it applies to (`*` for every region), the model as requests name it (a Bedrock model id, an Azure model name, a
 *   DigitalOcean or Workers AI model), the currency, the basis (`tokens`: per million input, output and cached input
 *   tokens, embeddings priced as input tokens; `neurons`: Workers AI's neurons per million input and output tokens and
 *   the price per 1,000 neurons), the day it takes effect (`effective_from`, `YYYY-MM-DD`; a version applies from that
 *   day only, until the next one), where it came from (`aws-price-list`, `azure-retail-prices`, `price-sheet`,
 *   `manual`) and its reference. Unique per provider, region, model, currency and day, so a refresh that finds the
 *   same price again changes nothing.
 * - `cloud_model_attestations`: the account's data terms for one cloud model entry (no training on prompts and
 *   outputs, the retention, abuse monitoring, the document they are stated in), proposed by one cloud admin and
 *   approved by another (dual control); an active one raises the entry's ceiling to `confidential` (open decision 5),
 *   never `restricted`, and only for an entry that runs in one region. Revoking it drops the ceiling back.
 * - `usage_records.cached_tokens`: the prompt tokens a provider served from its prompt cache (priced at the cached
 *   rate), null for everything else.
 *
 * Expand only. Without these, prices come from the price sheet and the APIs uncached, nothing can be attested (every
 * cloud entry stays at `internal`), and cached tokens are priced as input tokens.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('cloud_model_prices'))) {
    await knex.schema.createTable('cloud_model_prices', (t) => {
      t.string('id', 26).primary();
      t.string('provider', 20).notNullable();
      t.string('region', 64).notNullable();
      t.string('model', 200).notNullable();
      t.string('currency', 3).notNullable();
      t.string('basis', 10).notNullable();
      t.string('input_per_million', 40).nullable();
      t.string('output_per_million', 40).nullable();
      t.string('cached_per_million', 40).nullable();
      t.integer('neurons_input').nullable();
      t.integer('neurons_output').nullable();
      t.string('neuron_price', 40).nullable();
      t.string('effective_from', 10).notNullable();
      t.string('source', 30).notNullable();
      t.string('source_ref', 300).nullable();
      t.string('note', 500).nullable();
      t.string('created_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.unique(['provider', 'region', 'model', 'currency', 'effective_from'], { indexName: 'cloud_model_prices_version_unique' }); // named: the default is 71 characters, over MySQL's 64
      t.index(['provider', 'model']);
    });
  }
  if (!(await knex.schema.hasTable('cloud_model_attestations'))) {
    await knex.schema.createTable('cloud_model_attestations', (t) => {
      t.string('id', 26).primary();
      t.string('model_id', 26).notNullable();
      t.string('account_id', 26).notNullable();
      t.text('terms').notNullable();
      t.string('state', 20).notNullable();
      t.string('proposed_by', 26).notNullable();
      t.string('proposed_tenant', 26).notNullable();
      t.bigInteger('proposed_at').notNullable();
      t.string('decided_by', 26).nullable();
      t.bigInteger('decided_at').nullable();
      t.string('note', 500).nullable();
      t.index(['model_id', 'state']);
      t.index(['account_id']);
    });
  }
  if (!(await knex.schema.hasColumn('usage_records', 'cached_tokens'))) {
    await knex.schema.alterTable('usage_records', (t) => {
      t.bigInteger('cached_tokens').nullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('usage_records', 'cached_tokens')) await knex.schema.alterTable('usage_records', (t) => t.dropColumn('cached_tokens'));
  await knex.schema.dropTableIfExists('cloud_model_attestations');
  await knex.schema.dropTableIfExists('cloud_model_prices');
}
