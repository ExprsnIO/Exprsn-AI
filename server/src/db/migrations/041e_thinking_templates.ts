import type { Knex } from 'knex';

/**
 * 1.6.0 Sprint 36b (B-11707): how a model is made to think. `thinking` is native (the server's think parameter), template
 * (a convention in the system prompt, as Magistral's <think> blocks) or none; null means derived from the capabilities.
 * `thinking_template` keeps a template model's convention (its default system prompt as the server reports it).
 * Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('models', (t) => {
    t.string('thinking', 10).nullable(); // native | template | none
    t.text('thinking_template').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('models', (t) => {
    t.dropColumn('thinking_template');
    t.dropColumn('thinking');
  });
}
