import type { Knex } from 'knex';

/*
 * 1.9.0, Sprint 50 (B-155): rule-set tests.
 *
 * `guard_rule_tests` holds the test cases of a rule set, per tenant: the text sealed under the tenant's key with
 * `guardtest:<id>` as associated data (cases may be harmful examples), the label it was given (only someone cleared
 * for it reads the text), its context as JSON (checkpoint, surface, channel, label, role, clearance, account age,
 * new account, spam score), the expectation (`pass`, `block`, `annotate`, `redact`), the rule expected to fire, and
 * where it came from (`manual`, `csv`, `replay`, `decision`, with the decision id in `source_ref`).
 *
 * `guard_rule_test_runs` keeps the recent runs of a set: the version and the rules run (to diff runs), the cause
 * (`change`, `manual`, `publish`, `approve`, `promote`), the counts, and each case's verdict as JSON. No text.
 *
 * Expand only: two new tables.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('guard_rule_tests', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('set_id', 26).notNullable().references('id').inTable('guard_rule_sets').onDelete('CASCADE');
    t.string('name', 200).nullable();
    t.text('text', 'mediumtext').notNullable(); // sealed
    t.string('label', 16).notNullable();
    t.text('context').notNullable(); // JSON
    t.string('expect', 16).notNullable();
    t.string('rule_id', 63).nullable();
    t.string('source', 16).notNullable();
    t.string('source_ref', 26).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'set_id']);
  });
  await knex.schema.createTable('guard_rule_test_runs', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('set_id', 26).notNullable().references('id').inTable('guard_rule_sets').onDelete('CASCADE');
    t.integer('version').nullable();
    t.string('cause', 16).notNullable();
    t.integer('total').notNullable();
    t.integer('passed').notNullable();
    t.integer('failed').notNullable();
    t.text('results', 'mediumtext').notNullable(); // JSON, no text
    t.text('rules', 'mediumtext').notNullable(); // JSON: the rules run
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.index(['tenant_id', 'set_id', 'created_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('guard_rule_test_runs');
  await knex.schema.dropTableIfExists('guard_rule_tests');
}
