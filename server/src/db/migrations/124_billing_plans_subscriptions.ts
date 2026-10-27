import type { Knex } from 'knex';

/*
 * 1.9.0, Sprint 51 (B-162): the plan catalogue, tenants' subscriptions and their history.
 *
 * - `billing_plans`: the platform-wide catalogue: a unique `key`, name, description, `visibility` (`visible` to tenant
 *   admins, or `private`: assigned by a platform admin only), `state` (`active` or `retired`: no new subscriptions),
 *   the trial length offered on a tenant's first subscription, and `current_version`: the approved version in force
 *   (null until a second platform admin approves the first one).
 * - `billing_plan_versions`: what a plan charges and includes, one row per proposed version (dual control): `prices`
 *   (JSON: per currency and cycle length in months, the cycle price, the seat price and the included seats, in integer
 *   minor units), `allowances` (JSON: included usage per meter per month), `entitlements` (JSON: a flat key-value list
 *   for feature flags), `state` (`pending`, `approved`, `rejected`, `withdrawn`), who proposed and who decided, and
 *   `effective_from` (when it was approved). Approved versions are never changed; they are the plan's price history.
 * - `billing_subscriptions`: a tenant's subscription as it is now: plan and the version it is priced by, seats,
 *   currency, state (`trialing`, `active`, `paused`, `cancelled`, `ended`), trial end, start, optional fixed end, the
 *   cycle (`cycle_kind`, `cycle_months`, `anchor_day`), the current period, cancel at period end, a change scheduled
 *   for renewal (`pending_change`, JSON), and `live_tenant`: the tenant id while the subscription is not finished, null
 *   after, so a unique index allows one live subscription per tenant on every dialect.
 * - `billing_subscription_events`: the full history, append-only: every change as a row with the moment it took
 *   effect (`at`), its kind, the subscription's state after it (`snapshot`, JSON) and its proration (`detail`, JSON).
 *   A statement asks what applied at a moment by reading the last row at or before it.
 *
 * Expand only. A build from before this migration ignores the tables, and a tenant without a subscription is billed by
 * usage alone, as before.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('billing_plans'))) {
    await knex.schema.createTable('billing_plans', (t) => {
      t.string('id', 26).primary();
      t.string('key', 64).notNullable().unique('billing_plans_key');
      t.string('name', 100).notNullable();
      t.string('description', 1000).nullable();
      t.string('visibility', 10).notNullable().defaultTo('visible');
      t.string('state', 10).notNullable().defaultTo('active');
      t.integer('trial_days').notNullable().defaultTo(0);
      t.integer('current_version').nullable();
      t.string('created_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.string('updated_by', 26).nullable();
      t.bigInteger('updated_at').notNullable();
    });
  }
  if (!(await knex.schema.hasTable('billing_plan_versions'))) {
    await knex.schema.createTable('billing_plan_versions', (t) => {
      t.string('id', 26).primary();
      t.string('plan_id', 26).notNullable();
      t.integer('version').notNullable();
      t.text('prices').notNullable();
      t.text('allowances').notNullable();
      t.text('entitlements').notNullable();
      t.string('state', 12).notNullable();
      t.string('proposed_by', 26).nullable();
      t.bigInteger('proposed_at').notNullable();
      t.string('decided_by', 26).nullable();
      t.bigInteger('decided_at').nullable();
      t.string('note', 500).nullable();
      t.bigInteger('effective_from').nullable();
      t.unique(['plan_id', 'version'], 'billing_plan_versions_version');
      t.index(['plan_id', 'state'], 'billing_plan_versions_state');
    });
  }
  if (!(await knex.schema.hasTable('billing_subscriptions'))) {
    await knex.schema.createTable('billing_subscriptions', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('live_tenant', 26).nullable().unique('billing_subscriptions_live');
      t.string('plan_id', 26).notNullable();
      t.integer('plan_version').notNullable();
      t.integer('seats').notNullable();
      t.string('currency', 3).notNullable();
      t.string('state', 12).notNullable();
      t.bigInteger('trial_end').nullable();
      t.bigInteger('started_at').notNullable();
      t.bigInteger('ends_at').nullable();
      t.string('cycle_kind', 10).notNullable();
      t.integer('cycle_months').notNullable();
      t.integer('anchor_day').notNullable();
      t.bigInteger('period_start').notNullable();
      t.bigInteger('period_end').notNullable();
      t.boolean('cancel_at_period_end').notNullable().defaultTo(false);
      t.bigInteger('paused_at').nullable();
      t.bigInteger('finished_at').nullable();
      t.text('pending_change').nullable();
      t.integer('rev').notNullable().defaultTo(0);
      t.string('created_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.index(['tenant_id', 'started_at'], 'billing_subscriptions_tenant');
      t.index(['state', 'period_end'], 'billing_subscriptions_due');
    });
  }
  if (!(await knex.schema.hasTable('billing_subscription_events'))) {
    await knex.schema.createTable('billing_subscription_events', (t) => {
      t.string('id', 26).primary();
      t.string('subscription_id', 26).notNullable();
      t.string('tenant_id', 26).notNullable();
      t.integer('seq').notNullable();
      t.bigInteger('at').notNullable();
      t.string('kind', 30).notNullable();
      t.text('snapshot').notNullable();
      t.text('detail').nullable();
      t.string('actor', 26).nullable();
      t.bigInteger('recorded_at').notNullable();
      t.unique(['subscription_id', 'seq'], 'billing_subscription_events_seq');
      t.index(['tenant_id', 'at'], 'billing_subscription_events_at');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const t of ['billing_subscription_events', 'billing_subscriptions', 'billing_plan_versions', 'billing_plans']) await knex.schema.dropTableIfExists(t);
}
