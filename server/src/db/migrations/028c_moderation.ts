import type { Knex } from 'knex';

/*
 * Sprint 26 (1.4.0), moderation actions and appeals (028c, B-1901 to B-1907). Built on the guardrail flag queue:
 * every check, report and provider verdict ends in a `guard_flags` row; these tables hold what the queue did not
 * have. One row per moderated object (B-1901: the open flag it has, so a second check reuses it), the actions taken
 * on objects (hide, with the state to restore), reports, appeals, user sanctions, routed review queues (and the
 * queue a flag was routed to), the dead letters of moderation jobs, and external providers with their verdicts.
 * Object ids may be long (AT-Protocol URIs): lookups go through a SHA-256 of type and id. Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('moderation_objects', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('object_type', 30).notNullable();
    t.text('object_id').notNullable();
    t.string('object_hash', 64).notNullable(); // sha256 of "<type>\n<id>"
    t.string('workspace_id', 26).nullable();
    t.string('content_hash', 64).nullable(); // of the text last checked
    t.string('flag_id', 26).nullable(); // the flag the object has (open, or the last one)
    t.integer('generation').notNullable().defaultTo(0); // moves each time a new flag is claimed
    t.string('last_action', 20).nullable(); // the last guardrail verdict
    t.integer('checks').notNullable().defaultTo(0);
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'object_hash']);
  });

  await knex.schema.createTable('moderation_actions', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).nullable();
    t.string('object_type', 30).notNullable();
    t.text('object_id').notNullable();
    t.string('object_hash', 64).notNullable();
    t.string('owner_id', 26).nullable(); // whose object it is (who may appeal)
    t.string('flag_id', 26).nullable();
    t.string('action', 20).notNullable(); // hide
    t.string('prev_state', 30).nullable(); // what restoring puts back
    t.string('state', 20).notNullable(); // applied | reversed
    t.string('source', 20).notNullable(); // reviewer | guardrail | provider
    t.string('created_by', 26).nullable();
    t.string('reason', 500).nullable();
    t.bigInteger('created_at').notNullable();
    t.string('reversed_by', 26).nullable();
    t.bigInteger('reversed_at').nullable();
    t.string('appeal_id', 26).nullable();
    t.index(['tenant_id', 'object_hash']);
    t.index(['tenant_id', 'owner_id']);
  });

  await knex.schema.createTable('moderation_reports', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('reporter_id', 26).notNullable();
    t.string('object_type', 30).notNullable();
    t.text('object_id').notNullable();
    t.string('object_hash', 64).notNullable();
    t.string('workspace_id', 26).nullable();
    t.string('flag_id', 26).notNullable();
    t.string('reason', 200).notNullable();
    t.bigInteger('created_at').notNullable();
    t.index(['tenant_id', 'object_hash', 'reporter_id']);
  });

  await knex.schema.createTable('moderation_appeals', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.integer('number').notNullable();
    t.string('workspace_id', 26).nullable();
    t.string('kind', 20).notNullable(); // action | sanction
    t.string('action_id', 26).nullable();
    t.string('sanction_id', 26).nullable();
    t.string('flag_id', 26).nullable();
    t.string('label', 20).notNullable(); // of the flag behind it: reviewers below it see the appeal redacted
    t.string('user_id', 26).notNullable(); // the appellant
    t.string('filed_by', 26).notNullable(); // the appellant, or a reviewer recording it for them
    t.text('statement').notNullable(); // sealed: the appellant's words
    t.string('state', 20).notNullable(); // pending | reviewing | upheld | denied
    t.string('reviewer_id', 26).nullable();
    t.string('decision_note', 1000).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('reviewed_at').nullable();
    t.bigInteger('decided_at').nullable();
    t.unique(['tenant_id', 'number']);
    t.index(['tenant_id', 'state']);
    t.index(['tenant_id', 'user_id']);
  });

  await knex.schema.createTable('moderation_sanctions', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('kind', 10).notNullable(); // warn | suspend | ban
    t.string('reason', 1000).notNullable();
    t.string('flag_id', 26).nullable();
    t.string('state', 20).notNullable(); // active | expired | lifted | reversed
    t.bigInteger('starts_at').notNullable();
    t.bigInteger('ends_at').nullable(); // null: until lifted (a ban without a duration)
    t.string('created_by', 26).notNullable();
    t.bigInteger('created_at').notNullable();
    t.string('ended_by', 26).nullable();
    t.bigInteger('ended_at').nullable();
    t.string('end_reason', 500).nullable();
    t.index(['tenant_id', 'user_id', 'state']);
    t.index(['state', 'ends_at']);
  });

  await knex.schema.createTable('moderation_queues', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('name', 100).notNullable();
    t.string('workspace_id', 26).nullable(); // null: flags of every workspace
    t.text('rules').nullable(); // JSON rule ids or names; null: any
    t.text('labels').nullable(); // JSON labels; null: any
    t.text('kinds').nullable(); // JSON flag kinds or object types; null: any
    t.integer('priority').notNullable().defaultTo(100); // lower first
    t.integer('sla_minutes').notNullable();
    t.string('escalate_to', 20).notNullable(); // workspace | tenant | platform
    t.integer('escalation_sla_minutes').notNullable().defaultTo(60);
    t.boolean('enabled').notNullable().defaultTo(true);
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'name']);
  });

  await knex.schema.alterTable('guard_flags', (t) => {
    t.string('queue_id', 26).nullable(); // B-1905: the review queue the flag was routed to
    t.bigInteger('escalated_at').nullable();
  });

  await knex.schema.createTable('moderation_dead_letters', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('job_id', 26).notNullable().unique();
    t.string('type', 120).notNullable();
    t.text('payload').notNullable(); // JSON, as queued (texts in it are sealed)
    t.string('error', 1000).nullable();
    t.integer('attempts').notNullable();
    t.string('state', 20).notNullable(); // open | redriven
    t.bigInteger('failed_at').notNullable();
    t.string('redriven_by', 26).nullable();
    t.bigInteger('redriven_at').nullable();
    t.string('redrive_job_id', 26).nullable();
    t.index(['tenant_id', 'state']);
  });

  await knex.schema.createTable('moderation_providers', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('name', 100).notNullable();
    t.string('kind', 20).notNullable(); // json | openai
    t.string('url', 500).notNullable();
    t.text('secret').nullable(); // sealed API key
    t.string('zone', 31).notNullable();
    t.string('mode', 10).notNullable(); // shadow | enforce
    t.boolean('enabled').notNullable().defaultTo(false);
    t.text('object_types').nullable(); // JSON; null: every type
    t.float('threshold').notNullable().defaultTo(0.5);
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'name']);
  });

  await knex.schema.createTable('moderation_provider_verdicts', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('provider_id', 26).notNullable();
    t.string('object_type', 30).notNullable();
    t.text('object_id').notNullable();
    t.string('object_hash', 64).notNullable();
    t.string('mode', 10).notNullable();
    t.boolean('flagged').notNullable();
    t.text('categories').nullable(); // JSON category names
    t.float('score').nullable();
    t.boolean('acted').notNullable().defaultTo(false);
    t.string('flag_id', 26).nullable();
    t.integer('latency_ms').nullable();
    t.bigInteger('created_at').notNullable();
    t.index(['tenant_id', 'provider_id', 'created_at']);
    t.index(['tenant_id', 'object_hash']);
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const table of ['moderation_provider_verdicts', 'moderation_providers', 'moderation_dead_letters', 'moderation_queues', 'moderation_sanctions', 'moderation_appeals', 'moderation_reports', 'moderation_actions', 'moderation_objects']) await knex.schema.dropTableIfExists(table);
  await knex.schema.alterTable('guard_flags', (t) => {
    t.dropColumn('queue_id');
    t.dropColumn('escalated_at');
  });
}
