import type { Knex } from 'knex';

/*
 * 1.8.0, Sprint 44 (B-124): scheduled delivery of app views, reports, dashboards and records
 * (`apps/subscriptions.ts`).
 *
 * - `app_subscriptions`: one subscription: the object (kind, id, its app and entity), the format, the schedule (a cron
 *   or a preset's cron with an IANA zone, as workflow schedules), its state and failure count. The rest of what the
 *   owner chose (name, parameters, filters, the folder, the webhook address, the options and the message) is sealed in
 *   `spec` under the tenant key (`app-subscription:<id>`); a webhook's HMAC secret is sealed apart
 *   (`app-subscription-secret:<id>`). Each due time is claimed with one conditional update of `next_run_at`, so one
 *   instance runs it.
 * - `app_subscription_recipients`: who receives a render: the owner (who may or may not get it by email, and whose
 *   render the file store and the webhook get) and the other people a designer added, each rendered as themselves.
 *   `unsubscribed_at` is set by the signed link in the email and stops only that person's copies; `last_hash` is the
 *   SHA-256 of that person's last delivered render, for "only if changed".
 * - `app_subscription_runs`: one row per due time (unique per subscription and time), how it was started (`schedule`
 *   or `manual`) and the attempts of its job. (Column names avoid words MySQL and PostgreSQL reserve: `row_count`,
 *   `started_by`.)
 * - `app_subscription_deliveries`: the delivery history: per run, destination and recipient, the outcome and why, the
 *   rows, the size and, for the file store, the file id. No content is stored here; the only copy is the file store's.
 *
 * Expand only: a build from before this migration ignores the tables.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('app_subscriptions'))) {
    await knex.schema.createTable('app_subscriptions', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('app_id', 26).notNullable();
      t.string('owner_id', 26).notNullable();
      t.string('kind', 16).notNullable();
      t.string('object_id', 64).notNullable();
      t.string('entity_id', 26).nullable();
      t.string('label', 16).notNullable();
      t.string('format', 8).notNullable();
      t.string('cron', 120).notNullable();
      t.string('preset', 60).nullable();
      t.string('timezone', 64).notNullable();
      t.text('spec', 'mediumtext').notNullable();
      t.text('webhook_secret').nullable();
      t.string('state', 16).notNullable();
      t.string('paused_reason', 300).nullable();
      t.integer('failures').notNullable().defaultTo(0);
      t.bigInteger('next_run_at').nullable();
      t.bigInteger('last_run_at').nullable();
      t.string('last_outcome', 20).nullable();
      t.string('last_problem', 300).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.index(['tenant_id', 'owner_id'], 'app_subs_owner');
      t.index(['state', 'next_run_at'], 'app_subs_due');
    });
  }
  if (!(await knex.schema.hasTable('app_subscription_recipients'))) {
    await knex.schema.createTable('app_subscription_recipients', (t) => {
      t.string('subscription_id', 26).notNullable();
      t.string('user_id', 26).notNullable();
      t.string('tenant_id', 26).notNullable();
      t.string('role', 10).notNullable();
      t.boolean('email').notNullable().defaultTo(true);
      t.bigInteger('unsubscribed_at').nullable();
      t.string('last_hash', 64).nullable();
      t.bigInteger('created_at').notNullable();
      t.primary(['subscription_id', 'user_id']);
      t.index(['tenant_id', 'user_id'], 'app_sub_rcpt_user');
    });
  }
  if (!(await knex.schema.hasTable('app_subscription_runs'))) {
    await knex.schema.createTable('app_subscription_runs', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('subscription_id', 26).notNullable();
      t.bigInteger('due_at').notNullable();
      t.string('started_by', 10).notNullable();
      t.string('state', 16).notNullable();
      t.integer('attempts').notNullable().defaultTo(0);
      t.string('job_id', 26).nullable();
      t.string('problem', 300).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('finished_at').nullable();
      t.unique(['subscription_id', 'due_at'], { indexName: 'app_sub_runs_due' });
    });
  }
  if (!(await knex.schema.hasTable('app_subscription_deliveries'))) {
    await knex.schema.createTable('app_subscription_deliveries', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('subscription_id', 26).notNullable();
      t.string('run_id', 26).notNullable();
      t.string('destination', 10).notNullable();
      t.string('recipient_id', 26).nullable();
      t.string('outcome', 20).notNullable();
      t.string('reason', 300).nullable();
      t.integer('row_count').nullable();
      t.bigInteger('bytes').nullable();
      t.boolean('truncated').notNullable().defaultTo(false);
      t.string('file_id', 26).nullable();
      t.integer('status_code').nullable();
      t.bigInteger('created_at').notNullable();
      t.index(['subscription_id', 'created_at'], 'app_sub_dlv_sub');
      t.index(['run_id'], 'app_sub_dlv_run');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('app_subscription_deliveries');
  await knex.schema.dropTableIfExists('app_subscription_runs');
  await knex.schema.dropTableIfExists('app_subscription_recipients');
  await knex.schema.dropTableIfExists('app_subscriptions');
}
