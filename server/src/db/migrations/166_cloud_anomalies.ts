import type { Knex } from 'knex';

/*
 * 1.9.99-final, Sprint 62 (B-10606): spend anomalies (`cloud/anomalies.ts`).
 *
 * - `cloud_anomalies`: one row per account, day (`YYYY-MM-DD`, UTC), service and currency whose ingested spend
 *   (`cloud_costs`) stood out against its 14-day baseline: the provider, the tenant the notices went to, the day's
 *   actual, the baseline's median and median absolute deviation, the robust score and the ratio (decimals as text, so
 *   every dialect keeps them exactly), the days of history the baseline had, the top contributors (JSON: service,
 *   region, deployment and tag, each with its actual, baseline and extra), the state (`open`, `acknowledged`; a repeat
 *   inside an acknowledgement's quiet days is stored `acknowledged` with `suppressed_by`), who acknowledged it and why,
 *   and the audit entry it was announced with. The unique key is what makes it one alert per account, day and service
 *   across re-runs and instances.
 *
 * Expand only: one new table. While it is missing, nothing is detected, no notice is sent, and the anomaly routes
 * answer 503 `migration_pending`.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('cloud_anomalies')) return;
  await knex.schema.createTable('cloud_anomalies', (t) => {
    t.string('id', 26).primary();
    t.string('account_id', 26).notNullable();
    t.string('tenant_id', 26).notNullable();
    t.string('provider', 20).notNullable();
    t.string('day', 10).notNullable(); // YYYY-MM-DD (UTC)
    t.string('service', 200).notNullable();
    t.string('currency', 3).notNullable();
    t.string('actual', 32).notNullable();
    t.string('baseline', 32).notNullable(); // the median of the baseline days
    t.string('mad', 32).notNullable(); // median absolute deviation of the baseline days
    t.string('score', 32).notNullable(); // (actual − median) / (1.4826 × MAD, floored)
    t.string('ratio', 32).nullable(); // actual / median; null when the median is 0
    t.integer('history_days').notNullable();
    t.text('contributors').notNullable(); // JSON
    t.string('state', 20).notNullable(); // open | acknowledged
    t.string('suppressed_by', 26).nullable();
    t.string('acknowledged_by', 26).nullable();
    t.bigInteger('acknowledged_at').nullable();
    t.string('note', 500).nullable();
    t.string('audit_id', 64).nullable();
    t.bigInteger('detected_at').notNullable();
    t.unique(['account_id', 'day', 'service', 'currency'], { indexName: 'cloud_anomalies_account_day_service_uq' });
    t.index(['account_id', 'service', 'day'], 'cloud_anomalies_account_service_day_idx');
    t.index(['state', 'day'], 'cloud_anomalies_state_day_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('cloud_anomalies');
}
