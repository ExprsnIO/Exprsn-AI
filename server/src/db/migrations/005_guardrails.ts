import type { Knex } from 'knex';

/*
 * Sprint 5: guardrail rule sets (versioned, platform baseline or per tenant, workspace or agent), the decisions the
 * checkpoints record (the inspected text is sealed, for shadow replay), the flag queue with its history, labelled
 * eval cases, and the classifier registry. Messages gain the guard outcome of their turn.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('guard_rule_sets', (t) => {
    t.string('id', 26).primary();
    t.string('scope', 20).notNullable(); // platform | tenant | workspace | agent
    t.string('tenant_id', 26).nullable(); // null for the platform baseline
    t.string('workspace_id', 26).nullable();
    t.string('agent', 100).nullable();
    t.string('name', 100).notNullable();
    t.string('description', 500).nullable();
    t.integer('published_version').nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'scope']);
  });

  await knex.schema.createTable('guard_rule_set_versions', (t) => {
    t.string('id', 26).primary();
    t.string('set_id', 26).notNullable().references('id').inTable('guard_rule_sets').onDelete('CASCADE');
    t.integer('version').notNullable();
    t.string('status', 20).notNullable(); // draft | pending | published | superseded | withdrawn
    t.text('rules', 'mediumtext').notNullable(); // JSON array of rules (the whole set at this version)
    t.string('note', 500).nullable();
    t.string('created_by', 26).nullable();
    t.string('submitted_by', 26).nullable();
    t.bigInteger('submitted_at').nullable();
    t.string('approved_by', 26).nullable();
    t.bigInteger('approved_at').nullable();
    t.bigInteger('published_at').nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['set_id', 'version']);
  });

  await knex.schema.createTable('guard_decisions', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).nullable();
    t.string('user_id', 26).nullable();
    t.string('checkpoint', 30).notNullable();
    t.string('label', 20).notNullable();
    t.string('action', 20).notNullable();
    t.text('text', 'mediumtext').nullable(); // sealed, kept for shadow replay until the retention window ends
    t.text('meta').nullable(); // JSON: the checkpoint facts rules may test
    t.text('findings').nullable(); // JSON
    t.text('timings').nullable(); // JSON: rule key → milliseconds
    t.string('source_kind', 30).nullable();
    t.string('source_id', 100).nullable();
    t.integer('latency_ms').notNullable().defaultTo(0);
    t.bigInteger('created_at').notNullable();
    t.index(['tenant_id', 'checkpoint', 'created_at']);
  });

  await knex.schema.createTable('guard_flags', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.integer('number').notNullable();
    t.string('workspace_id', 26).nullable();
    t.string('kind', 20).notNullable(); // rule | fail-open | report | reviewer
    t.string('checkpoint', 30).notNullable();
    t.string('rule_id', 100).nullable();
    t.string('rule_name', 200).notNullable();
    t.string('set_id', 26).nullable();
    t.string('set_name', 200).nullable();
    t.integer('set_version').nullable();
    t.string('stage', 20).notNullable(); // enforce | shadow
    t.string('action', 20).nullable(); // what the rule did (or would have done)
    t.string('severity', 10).notNullable(); // high | medium | low
    t.string('label', 20).notNullable();
    t.text('excerpt', 'mediumtext').nullable(); // sealed JSON {before, span, after}
    t.string('note', 1000).nullable();
    t.text('actor').nullable(); // JSON {user, name, via}
    t.string('source_kind', 30).nullable();
    t.string('source_id', 100).nullable();
    t.string('conversation_id', 26).nullable();
    t.string('state', 20).notNullable(); // open | confirmed | dismissed
    t.string('assignee', 26).nullable();
    t.string('escalated_to', 20).nullable(); // workspace | tenant | platform
    t.integer('sla_minutes').notNullable();
    t.bigInteger('due_at').notNullable();
    t.bigInteger('breach_notified_at').nullable();
    t.string('decided_by', 26).nullable();
    t.bigInteger('decided_at').nullable();
    t.string('reason', 500).nullable();
    t.string('eval_set', 100).nullable();
    t.bigInteger('created_at').notNullable();
    t.unique(['tenant_id', 'number']);
    t.index(['tenant_id', 'state', 'due_at']);
  });

  await knex.schema.createTable('guard_flag_events', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('flag_id', 26).notNullable().references('id').inTable('guard_flags').onDelete('CASCADE');
    t.string('action', 20).notNullable(); // created | confirmed | dismissed | escalated | reassigned | eval | breached
    t.string('actor', 26).nullable();
    t.string('note', 500).nullable();
    t.bigInteger('created_at').notNullable();
    t.index(['tenant_id', 'created_at']);
  });

  await knex.schema.createTable('eval_cases', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('eval_set', 100).notNullable();
    t.string('expected', 100).notNullable(); // positive | negative for a rule; a label name for a classifier
    t.text('text', 'mediumtext').notNullable(); // sealed
    t.string('label', 20).notNullable();
    t.string('flag_id', 26).nullable();
    t.string('rule_id', 100).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.index(['tenant_id', 'eval_set']);
  });

  await knex.schema.createTable('classifiers', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).nullable(); // null: a platform classifier every tenant uses
    t.string('slug', 63).notNullable();
    t.string('name', 100).notNullable();
    t.string('engine', 20).notNullable(); // deterministic | linear | guard | llm
    t.string('description', 1000).nullable();
    t.string('status', 20).notNullable(); // draft | published
    t.integer('version').notNullable();
    t.string('owner', 100).nullable();
    t.string('dataset', 100).nullable();
    t.text('config', 'mediumtext').notNullable(); // JSON: labels and thresholds, detectors, profile, trained weights
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['tenant_id', 'slug']);
  });

  // The last evaluation per tenant: a platform classifier is measured on each tenant's own labelled cases.
  await knex.schema.createTable('classifier_metrics', (t) => {
    t.string('classifier_id', 26).notNullable().references('id').inTable('classifiers').onDelete('CASCADE');
    t.string('tenant_id', 26).notNullable();
    t.text('metrics', 'mediumtext').notNullable(); // JSON
    t.bigInteger('updated_at').notNullable();
    t.primary(['classifier_id', 'tenant_id']);
  });

  await knex.schema.createTable('classifier_versions', (t) => {
    t.string('id', 26).primary();
    t.string('classifier_id', 26).notNullable().references('id').inTable('classifiers').onDelete('CASCADE');
    t.string('tenant_id', 26).nullable();
    t.integer('version').notNullable();
    t.text('config', 'mediumtext').notNullable();
    t.string('note', 500).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
  });

  await knex.schema.createTable('label_names', (t) => {
    t.string('tenant_id', 26).notNullable();
    t.string('label', 20).notNullable();
    t.string('name', 40).notNullable();
    t.bigInteger('updated_at').notNullable();
    t.primary(['tenant_id', 'label']);
  });

  await knex.schema.alterTable('messages', (t) => {
    t.text('guard').nullable(); // JSON: the guardrail outcome of the turn {action, reason, rules}
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('messages', (t) => {
    t.dropColumn('guard');
  });
  for (const table of ['label_names', 'classifier_versions', 'classifier_metrics', 'classifiers', 'eval_cases', 'guard_flag_events', 'guard_flags', 'guard_decisions', 'guard_rule_set_versions', 'guard_rule_sets']) await knex.schema.dropTableIfExists(table);
}
