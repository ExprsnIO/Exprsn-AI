import type { Knex } from 'knex';

/*
 * Sprint 30 (1.5.0), model-based memory management (032c): B-3701 to B-3703.
 *
 * - `memory_settings`: one row per tenant: the `memory` profile that extracts proposals from chat turns and agent runs
 *   and confirms consolidation candidates (null: the rules extract, nothing is merged), the memory embedding model
 *   (null: the first approved embedding model by name, as before), the similarity from which two memories are
 *   consolidation candidates (`similarity_pct`, 50 to 99), the days after which an episodic or progress memory is
 *   proposed for expiry (`stale_days`, null: never), and the state of the reindex job that follows a model change
 *   (`reindex_*`; recall is by recency while it is `running`).
 * - `memories.superseded_by`: the memory a merge replaced this one with (state `superseded`); the merged memory's
 *   `source` names both (`{merge: [...]}`), so provenance runs both ways.
 * - `memories.expiry_proposal`: JSON `{expiresAt, reason: stale|contradicted, by, similarity, proposedAt}` while an
 *   expiry proposal waits for the owner (or a curator); nothing changes until it is accepted.
 * Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('memory_settings', (t) => {
    t.string('tenant_id', 26).primary();
    t.string('profile', 200).nullable();
    t.string('embed_model', 200).nullable();
    t.integer('similarity_pct').notNullable().defaultTo(85);
    t.integer('stale_days').nullable();
    t.string('reindex_state', 20).notNullable().defaultTo('idle'); // idle | running | done | failed
    t.string('reindex_model', 200).nullable();
    t.string('reindex_job_id', 26).nullable();
    t.integer('reindex_done').notNullable().defaultTo(0);
    t.integer('reindex_total').notNullable().defaultTo(0);
    t.string('reindex_error', 500).nullable();
    t.bigInteger('reindex_started_at').nullable();
    t.bigInteger('reindex_finished_at').nullable();
    t.string('updated_by', 26).nullable();
    t.bigInteger('updated_at').notNullable();
  });
  await knex.schema.alterTable('memories', (t) => {
    t.string('superseded_by', 26).nullable();
    t.text('expiry_proposal').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('memory_settings');
  await knex.schema.alterTable('memories', (t) => {
    t.dropColumn('expiry_proposal');
    t.dropColumn('superseded_by');
  });
}
