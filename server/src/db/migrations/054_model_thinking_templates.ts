import type { Knex } from 'knex';

/*
 * 1.6.0, Sprint 36b (B-11707): model thinking templates.
 *
 * `models.thinking_mode` records how a catalogue model is made to think: `native` (the server's own think option),
 * `template` (a system instruction makes it reason between two tags, which the gateway separates from the answer) or
 * `none`. Null is a model nobody has said it for: it thinks natively when its manifest says so, as before.
 * `models.thinking_template` is the template of a `template` model (JSON: a built-in's `id`, or `system`, `open`,
 * `close` and `startsOpen`).
 *
 * Expand only: two nullable columns.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('models', (t) => {
    t.string('thinking_mode', 16).nullable(); // native | template | none
    t.text('thinking_template').nullable(); // JSON
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('models', (t) => {
    t.dropColumn('thinking_template');
    t.dropColumn('thinking_mode');
  });
}
