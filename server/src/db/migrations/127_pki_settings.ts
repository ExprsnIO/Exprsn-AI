import type { Knex } from 'knex';

/*
 * 1.9.0, Sprint 55 (B-187): the certificate authority's settings, saved from Certificates › Settings.
 *
 * - `pki_settings`: one row per scope, `platform` or a tenant id. `data` is a JSON object of the values saved in that
 *   scope (a key that is absent inherits: a tenant from the platform, the platform from the environment). `version`
 *   counts the saves, so two admins saving at once cannot overwrite each other unseen.
 * - `pki_settings_proposals`: changes to the root or the intermediates (subject, key algorithm, validity, path length)
 *   wait here for a second platform admin. `changes` is the JSON object of the proposed values (`null` for "back to
 *   the environment"), `state` is `pending`, `applied`, `rejected` or `withdrawn`. An applied change is read at the
 *   next rotation or re-issue; nothing re-keys when it is approved.
 *
 * Expand only. A build from before this migration ignores the tables, and a build with the code but without this
 * migration reads the environment values (`PkiSettings` checks for the table).
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('pki_settings'))) {
    await knex.schema.createTable('pki_settings', (t) => {
      t.string('scope', 40).primary();
      t.text('data').notNullable();
      t.integer('version').notNullable().defaultTo(0);
      t.string('updated_by', 26).nullable();
      t.bigInteger('updated_at').notNullable();
    });
  }
  if (!(await knex.schema.hasTable('pki_settings_proposals'))) {
    await knex.schema.createTable('pki_settings_proposals', (t) => {
      t.string('id', 26).primary();
      t.string('scope', 40).notNullable();
      t.text('changes').notNullable();
      t.string('state', 16).notNullable().defaultTo('pending');
      t.string('reason', 500).nullable();
      t.string('tenant_id', 26).notNullable();
      t.string('proposed_by', 26).nullable();
      t.bigInteger('proposed_at').notNullable();
      t.string('decided_by', 26).nullable();
      t.bigInteger('decided_at').nullable();
      t.string('note', 500).nullable();
      t.index(['scope', 'state']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('pki_settings_proposals');
  await knex.schema.dropTableIfExists('pki_settings');
}
