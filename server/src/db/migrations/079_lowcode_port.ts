import type { Knex } from 'knex';

/*
 * 1.7.0, the exprsn-platform low-code port (docs/decisions/lowcode-port.md): app flows.
 *
 * - `app_flows`: an app's automation as the Apps canvas edits it. `model` is the flow (trigger, condition tree,
 *   actions) as JSON; it is compiled into the draft of the workflow the flow owns (`workflow_id`), which is what
 *   runs, started by the app trigger `trigger_id` (none for a flow started by hand). `draft_rev` is the workflow draft
 *   revision the flow last wrote, so an edit on the Workflows screen is noticed.
 *
 * Expand only. A build from before this migration ignores the table; the workflows and triggers it made keep running.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('app_flows'))) {
    await knex.schema.createTable('app_flows', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('app_id', 26).notNullable();
      t.string('entity_id', 26).notNullable();
      t.string('name', 63).notNullable();
      t.string('title', 200).nullable();
      t.string('description', 500).nullable();
      t.string('workflow_id', 26).notNullable();
      t.string('workspace_id', 26).nullable();
      t.string('trigger_id', 26).nullable();
      t.boolean('enabled').notNullable().defaultTo(true);
      t.text('model', 'mediumtext').notNullable();
      t.integer('draft_rev').notNullable();
      t.string('created_by', 26).notNullable();
      t.string('updated_by', 26).notNullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.unique(['app_id', 'name']);
      t.index(['tenant_id', 'app_id']);
      t.index(['workflow_id']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('app_flows');
}
