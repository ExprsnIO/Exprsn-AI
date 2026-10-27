import type { Knex } from 'knex';

/*
 * 1.7.0, Sprint 41 (B-9601, B-9602): guardrail rules drafted from a description.
 *
 * `guard_rule_drafts` holds one rule a model drafted for a rule set: the validated rule as JSON, exactly as it was
 * shown in the diff (saving takes the rule from this row, never from the request), who asked and through which
 * profile, and its state (`drafted`, then `saved` once it joined the set's draft in shadow). A saved row marks the
 * rule as drafted by a model: `enforce_approved_by` and `enforce_approved_at` are set when a second guardrail admin
 * approved a version in which the rule enforces, and until then such a version cannot be published directly.
 *
 * Expand only: one new table.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('guard_rule_drafts', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('set_id', 26).notNullable().references('id').inTable('guard_rule_sets').onDelete('CASCADE');
    t.string('rule_id', 63).notNullable();
    t.text('rule', 'mediumtext').notNullable(); // JSON: the drafted rule, stage shadow
    t.string('profile', 63).notNullable();
    t.string('status', 16).notNullable(); // drafted | saved
    t.string('created_by', 26).notNullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('saved_at').nullable();
    t.integer('saved_version').nullable();
    t.string('enforce_approved_by', 26).nullable();
    t.bigInteger('enforce_approved_at').nullable();
    t.index(['set_id', 'rule_id']);
    t.index(['tenant_id', 'status']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('guard_rule_drafts');
}
