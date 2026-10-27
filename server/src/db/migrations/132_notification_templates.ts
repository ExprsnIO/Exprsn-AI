import type { Knex } from 'knex';

/*
 * 1.9.0: notification templates (`platform/notification-templates.ts`).
 *
 * - `notification_templates`: a named preference set per tenant (`name` unique in the tenant): `body`, JSON
 *   `{ kinds: { <kind>: { <channel>: { enabled, timing } } }, quietHours: { mon…sun: { start, end } } | null,
 *   urgentPassesQuiet: boolean | null, digestHour: 0–23 | null, digestWeekday: 0–6 | null }`; its current `version`
 *   (1 when made, one more on every edit); `default_for_new`: the template new members of the tenant get (at most one
 *   per tenant, kept so by the service).
 * - `notification_template_versions`: every version's name and body as it was saved, so a person's preferences can
 *   name the version they came from after the template changes.
 * - `notification_pref_origins`: per person, the template (id, name and version) their preferences were last applied
 *   from, how (`replace` or `fill`), by whom and when, and `snapshot`: their kind choices right after applying (JSON,
 *   like `notification_pref_rules.channels` per kind), so Settings can say how many kinds they changed since.
 *
 * Expand only: three new tables. A build from before this migration ignores them; this build reports templates as not
 * available while they are missing.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('notification_templates'))) {
    await knex.schema.createTable('notification_templates', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('name', 100).notNullable();
      t.string('description', 500).nullable();
      t.integer('version').notNullable().defaultTo(1);
      t.text('body').notNullable();
      t.boolean('default_for_new').notNullable().defaultTo(false);
      t.string('created_by', 26).nullable();
      t.string('updated_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.unique(['tenant_id', 'name']);
    });
  }
  if (!(await knex.schema.hasTable('notification_template_versions'))) {
    await knex.schema.createTable('notification_template_versions', (t) => {
      t.string('template_id', 26).notNullable();
      t.integer('version').notNullable();
      t.string('tenant_id', 26).notNullable();
      t.string('name', 100).notNullable();
      t.string('description', 500).nullable();
      t.text('body').notNullable();
      t.string('created_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.primary(['template_id', 'version']);
      t.index(['tenant_id']);
    });
  }
  if (!(await knex.schema.hasTable('notification_pref_origins'))) {
    await knex.schema.createTable('notification_pref_origins', (t) => {
      t.string('tenant_id', 26).notNullable();
      t.string('user_id', 26).notNullable();
      t.string('template_id', 26).notNullable();
      t.string('template_name', 100).notNullable();
      t.integer('template_version').notNullable();
      t.string('mode', 16).notNullable();
      t.text('snapshot').notNullable();
      t.string('applied_by', 26).nullable();
      t.bigInteger('applied_at').notNullable();
      t.primary(['tenant_id', 'user_id']);
      t.index(['tenant_id', 'template_id']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('notification_pref_origins');
  await knex.schema.dropTableIfExists('notification_template_versions');
  await knex.schema.dropTableIfExists('notification_templates');
}
