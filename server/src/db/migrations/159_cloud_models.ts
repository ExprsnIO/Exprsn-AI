import type { Knex } from 'knex';

/*
 * 1.9.99-final, Sprint 60 (B-10501, B-10504): cloud model entries (`cloud/model-import.ts`).
 *
 * `cloud_model_entries`: one row per catalogue model (`models.id`, `format` `server`) that the cloud catalogue import
 * registered from an account: the provider, the account, the region it was listed in, what requests name
 * (`external_id`: the Bedrock model or inference profile id, the Azure deployment, the DigitalOcean or Workers AI
 * model), how it is served (`flavour`: `bedrock`, `azure`, `digitalocean`, `workers-ai`), the offer (`foundation`,
 * `inference_profile`, `deployment`, `model`), the regions it may route to (JSON; an inference profile's), its label
 * ceiling (the lowest of its routing regions' ceilings, capped at `internal` until the account's data terms are
 * attested, open decision 5; never `restricted`), the terms recorded at import (JSON), the model access state, and
 * provider facts (JSON). Unique per account, region and external id, so a re-import updates the row.
 *
 * Expand only: one new table. While it is missing, the import answers 503 `migration_pending`, approval and labels of
 * catalogue models are checked as before, and a Bedrock server checks routing from its listing alone.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('cloud_model_entries'))) {
    await knex.schema.createTable('cloud_model_entries', (t) => {
      t.string('model_id', 26).primary();
      t.string('provider', 20).notNullable();
      t.string('account_id', 26).notNullable();
      t.string('region', 64).notNullable();
      t.string('external_id', 200).notNullable();
      t.string('flavour', 20).notNullable();
      t.string('offer', 30).notNullable();
      t.text('routes_to').notNullable();
      t.string('label_ceiling', 20).notNullable();
      t.text('terms').nullable();
      t.string('access_state', 20).notNullable();
      t.text('details').nullable();
      t.string('imported_by', 26).nullable();
      t.bigInteger('imported_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.unique(['account_id', 'region', 'external_id']);
      t.index(['account_id']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('cloud_model_entries');
}
