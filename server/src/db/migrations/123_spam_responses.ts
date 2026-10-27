import type { Knex } from 'knex';

/*
 * 1.9.0, Sprint 50 (B-161, B-158): graduated spam responses and the moderation metrics.
 *
 * - `spam_responses`: one row per response applied to a person on a surface under an enforcing policy: its kind
 *   (`slow` a minimum interval between writes, `hold` writes held for review, `limit` a cap per hour, `case` a flag in
 *   the moderation queue), its state (`active`, `lifted` by a moderator or an upheld appeal, `expired`), the score and
 *   reasons that triggered it (signals and counts, never content), when it ends, the warning sanction the person may
 *   appeal (`sanction_id`) and the case's flag (`flag_id`). Never a ban: there is no kind for one.
 * - `moderation_metrics_daily`: aggregates per tenant and UTC day (`day`, YYYY-MM-DD): `metric` names what is counted
 *   (guardrail hits per rule and per set, decisions by action, appeals decided and upheld, time to decision in the
 *   flag, held-write and appeal queues, spam responses by kind), `dim` the rule, set, action, queue or kind (empty for
 *   none), `n` the count and `total` a sum (milliseconds for time to decision). Rewritten for a day by the
 *   `moderation.metrics.rollup` job from the source tables; no content.
 *
 * Expand only. A build from before this migration ignores the tables.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('spam_responses'))) {
    await knex.schema.createTable('spam_responses', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('user_id', 26).notNullable();
      t.string('surface', 20).notNullable();
      t.string('kind', 10).notNullable();
      t.string('state', 10).notNullable();
      t.integer('score').notNullable();
      t.text('reasons').nullable();
      t.string('sanction_id', 26).nullable();
      t.string('flag_id', 26).nullable();
      t.bigInteger('starts_at').notNullable();
      t.bigInteger('ends_at').nullable();
      t.bigInteger('created_at').notNullable();
      t.string('lifted_by', 26).nullable();
      t.bigInteger('lifted_at').nullable();
      t.string('lift_reason', 500).nullable();
      t.index(['tenant_id', 'user_id', 'state'], 'spam_responses_user');
      t.index(['tenant_id', 'state', 'ends_at'], 'spam_responses_state');
      t.index(['tenant_id', 'created_at'], 'spam_responses_time');
      t.index(['sanction_id'], 'spam_responses_sanction');
    });
  }
  if (!(await knex.schema.hasTable('moderation_metrics_daily'))) {
    await knex.schema.createTable('moderation_metrics_daily', (t) => {
      t.string('tenant_id', 26).notNullable();
      t.string('day', 10).notNullable();
      t.string('metric', 40).notNullable();
      t.string('dim', 200).notNullable().defaultTo('');
      t.bigInteger('n').notNullable().defaultTo(0);
      t.bigInteger('total').notNullable().defaultTo(0);
      t.bigInteger('rolled_at').notNullable();
      t.primary(['tenant_id', 'day', 'metric', 'dim']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const t of ['moderation_metrics_daily', 'spam_responses']) await knex.schema.dropTableIfExists(t);
}
