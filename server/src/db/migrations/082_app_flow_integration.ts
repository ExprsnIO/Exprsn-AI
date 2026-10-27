import type { Knex } from 'knex';

/*
 * 1.7.0, app flows integrated with the rest of the environment (docs/decisions/lowcode-port.md, follow-up 3 and the
 * webhook trigger): the incoming webhook of a webhook flow.
 *
 * - `app_flows.hook_enabled`: the hook takes requests (off by default); `hook_secret` the HMAC secret, sealed under
 *   the tenant key with `appflowhook:<flow id>` as associated data; `hook_secret_at` when it was made or rotated;
 *   `hook_owner` who turned the hook on, as whom its runs start.
 * - `app_flow_hook_nonces`: the signatures accepted in the last ten minutes, so a replay is refused on every
 *   instance. Rows expire (`expires_at`) and are swept as requests arrive.
 *
 * Expand only: a build from before this migration ignores the columns and the table.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasColumn('app_flows', 'hook_enabled'))) {
    await knex.schema.alterTable('app_flows', (t) => {
      t.boolean('hook_enabled').notNullable().defaultTo(false);
      t.text('hook_secret').nullable();
      t.bigInteger('hook_secret_at').nullable();
      t.string('hook_owner', 26).nullable();
    });
  }
  if (!(await knex.schema.hasTable('app_flow_hook_nonces'))) {
    await knex.schema.createTable('app_flow_hook_nonces', (t) => {
      t.string('flow_id', 26).notNullable();
      t.string('digest', 64).notNullable();
      t.bigInteger('expires_at').notNullable();
      t.primary(['flow_id', 'digest']);
      t.index(['expires_at']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('app_flow_hook_nonces');
  if (await knex.schema.hasColumn('app_flows', 'hook_enabled')) {
    await knex.schema.alterTable('app_flows', (t) => {
      t.dropColumn('hook_enabled');
      t.dropColumn('hook_secret');
      t.dropColumn('hook_secret_at');
      t.dropColumn('hook_owner');
    });
  }
}
