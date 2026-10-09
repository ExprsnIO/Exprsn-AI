import type { Knex } from 'knex';

/*
 * 1.7.0, Sprint 41d (B-12301 to B-12304): finding what you can use. Expand only.
 *
 * - `registry_entries.purpose`, `examples` (JSON array of example prompts), `category`: what the catalogue card shows
 *   (B-12304). They are not part of the schema hash, so filling them on a published entry does not invalidate its
 *   approval; entries published before this migration keep working without them.
 * - `workflows.purpose`, `examples`, `category`: the same for a workflow's catalogue card.
 * - `profiles.suggestions`: composer suggestions on for this profile (B-12303); on by default.
 * - `catalog_notices`: one row per person and catalogue entry (B-12302): the entry's publish (or newly offered) notice
 *   went out (`sent`), waits for the weekly digest (`pending`), or the person had notices off (`skipped`). The unique
 *   key is what makes a notice go out once.
 * - `catalog_preferences`: per person, how publish notices reach them (`each`, `digest`, `off`) and when the last
 *   weekly digest went out.
 * - `catalog_vectors`: the embedding of each entry version's description, purpose and examples under one model, with
 *   the hash of the text it was computed from (B-12303).
 * - `catalog_dismissals`: suggestions a person dismissed in a conversation (B-12303).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('registry_entries', (t) => {
    t.text('purpose').nullable();
    t.text('examples').nullable(); // JSON string[]
    t.string('category', 60).nullable();
  });

  await knex.schema.alterTable('workflows', (t) => {
    t.text('purpose').nullable();
    t.text('examples').nullable(); // JSON string[]
    t.string('category', 60).nullable();
  });

  await knex.schema.alterTable('profiles', (t) => {
    t.boolean('suggestions').notNullable().defaultTo(true);
  });

  await knex.schema.createTable('catalog_notices', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('entry_key', 240).notNullable(); // <kind>:<name>
    t.string('entry_kind', 20).notNullable(); // workflow | agent | tool | skill
    t.string('entry_name', 200).notNullable();
    t.string('version', 40).nullable();
    t.string('label', 20).notNullable();
    t.string('state', 16).notNullable(); // sent | pending | skipped
    t.string('notification_id', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('sent_at').nullable();
    t.unique(['tenant_id', 'user_id', 'entry_key'], { indexName: 'catalog_notices_once_uq' });
    t.index(['tenant_id', 'state'], 'catalog_notices_state_idx');
  });

  await knex.schema.createTable('catalog_preferences', (t) => {
    t.string('tenant_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('notices', 16).notNullable().defaultTo('each'); // each | digest | off
    t.bigInteger('last_digest_at').nullable();
    t.bigInteger('updated_at').notNullable();
    t.primary(['tenant_id', 'user_id']);
  });

  await knex.schema.createTable('catalog_vectors', (t) => {
    t.string('tenant_id', 26).notNullable();
    t.string('entry_key', 240).notNullable();
    t.string('version', 40).notNullable();
    t.string('model', 200).notNullable();
    t.string('text_hash', 64).notNullable();
    t.text('vector').notNullable(); // base64 float32
    t.bigInteger('created_at').notNullable();
    t.primary(['tenant_id', 'entry_key', 'version', 'model']);
  });

  await knex.schema.createTable('catalog_dismissals', (t) => {
    t.string('tenant_id', 26).notNullable();
    t.string('conversation_id', 26).notNullable();
    t.string('user_id', 26).notNullable();
    t.string('entry_key', 240).notNullable();
    t.bigInteger('created_at').notNullable();
    t.primary(['conversation_id', 'entry_key']);
    t.index(['tenant_id', 'user_id'], 'catalog_dismissals_user_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('catalog_dismissals');
  await knex.schema.dropTableIfExists('catalog_vectors');
  await knex.schema.dropTableIfExists('catalog_preferences');
  await knex.schema.dropTableIfExists('catalog_notices');
  await knex.schema.alterTable('profiles', (t) => {
    t.dropColumn('suggestions');
  });
  await knex.schema.alterTable('workflows', (t) => {
    t.dropColumn('purpose');
    t.dropColumn('examples');
    t.dropColumn('category');
  });
  await knex.schema.alterTable('registry_entries', (t) => {
    t.dropColumn('purpose');
    t.dropColumn('examples');
    t.dropColumn('category');
  });
}
