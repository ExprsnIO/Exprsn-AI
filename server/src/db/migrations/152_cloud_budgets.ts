import type { Knex } from 'knex';

/*
 * 1.9.99-final, Sprint 58 (B-10602, B-10206): budgets per cloud account, their alert state and overrides; and the
 * certificate push targets of the load-balancer hook kinds.
 *
 * - `cloud_budgets`: one row per account: the monthly amount (a decimal as text, so every dialect keeps it exactly),
 *   its currency (open decision 17: the account's billing currency, USD by default, never converted), the hard stop
 *   (`actual`: past 100 % of month-to-date spend, the default; `forecast`: past 100 % of the month's forecast; `off`:
 *   alerts only) and who set it.
 * - `cloud_budget_alerts`: one row per account, month (`YYYY-MM`, UTC), basis (`actual`, `forecast`) and threshold
 *   (50, 80, 100) once it was crossed, so each alert is sent once a month.
 * - `cloud_budget_overrides`: proposals to lift the hard stop for at most 7 days, with a reason; a second admin
 *   approves (dual control). States: pending, approved (active until `expires_at`), rejected, withdrawn, expired,
 *   revoked.
 * - `platform_cert_hooks`: two nullable columns for the hook kinds that push a renewed certificate to a cloud load
 *   balancer (`aws-acm`, `azure-appgw`, `do-lb`): the cloud account and the target (JSON: the load balancer, the
 *   listener or gateway certificate name, and what the last push left there, such as the ACM certificate ARN).
 *
 * Expand only: three new tables and two nullable columns. While it is missing, no budget can be set (the routes
 * answer 503 `migration_pending`), no plan is refused for budget, and the load-balancer hook kinds are refused.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('cloud_budgets'))) {
    await knex.schema.createTable('cloud_budgets', (t) => {
      t.string('account_id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('amount', 32).notNullable();
      t.string('currency', 3).notNullable();
      t.string('hard_stop', 10).notNullable().defaultTo('actual'); // actual | forecast | off
      t.string('updated_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.index(['tenant_id']);
    });
  }
  if (!(await knex.schema.hasTable('cloud_budget_alerts'))) {
    await knex.schema.createTable('cloud_budget_alerts', (t) => {
      t.string('id', 26).primary();
      t.string('account_id', 26).notNullable();
      t.string('month', 7).notNullable(); // YYYY-MM (UTC)
      t.string('basis', 10).notNullable(); // actual | forecast
      t.integer('threshold').notNullable(); // 50 | 80 | 100
      t.string('spend', 32).notNullable();
      t.string('amount', 32).notNullable();
      t.string('currency', 3).notNullable();
      t.string('audit_id', 26).nullable();
      t.bigInteger('fired_at').notNullable();
      t.unique(['account_id', 'month', 'basis', 'threshold']);
    });
  }
  if (!(await knex.schema.hasTable('cloud_budget_overrides'))) {
    await knex.schema.createTable('cloud_budget_overrides', (t) => {
      t.string('id', 26).primary();
      t.string('account_id', 26).notNullable();
      t.string('tenant_id', 26).notNullable();
      t.string('state', 12).notNullable(); // pending | approved | rejected | withdrawn | expired | revoked
      t.string('reason', 500).notNullable();
      t.integer('hours').notNullable(); // at most 168
      t.string('proposed_by', 26).notNullable();
      t.bigInteger('proposed_at').notNullable();
      t.string('decided_by', 26).nullable();
      t.bigInteger('decided_at').nullable();
      t.string('note', 500).nullable();
      t.bigInteger('starts_at').nullable();
      t.bigInteger('expires_at').nullable();
      t.index(['account_id', 'state']);
    });
  }
  if ((await knex.schema.hasTable('platform_cert_hooks')) && !(await knex.schema.hasColumn('platform_cert_hooks', 'target'))) {
    await knex.schema.alterTable('platform_cert_hooks', (t) => {
      t.string('account_id', 26).nullable();
      t.text('target').nullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('cloud_budget_overrides');
  await knex.schema.dropTableIfExists('cloud_budget_alerts');
  await knex.schema.dropTableIfExists('cloud_budgets');
  if ((await knex.schema.hasTable('platform_cert_hooks')) && (await knex.schema.hasColumn('platform_cert_hooks', 'target'))) {
    await knex.schema.alterTable('platform_cert_hooks', (t) => {
      t.dropColumn('target');
      t.dropColumn('account_id');
    });
  }
}
