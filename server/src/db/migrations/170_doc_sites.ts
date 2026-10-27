import type { Knex } from 'knex';

/*
 * 2.0.x Docs portal (`docs/service.ts`): documentation sites built from knowledge bases. A site names its bases in
 * order (`kb_ids`, JSON), an optional home page (`home_kb_id` + `home_slug`, a reference) and whether the bases' other
 * documents show as a Library. Who reads a site's pages is decided by the knowledge bases, never by the site row.
 *
 * Expand only: a new table.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('doc_sites')) return;
  await knex.schema.createTable('doc_sites', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('slug', 80).notNullable();
    t.string('title', 200).notNullable();
    t.text('description').nullable();
    t.text('kb_ids').notNullable(); // JSON array, in the order the site shows them
    t.string('home_kb_id', 26).nullable();
    t.string('home_slug', 240).nullable();
    t.boolean('library').notNullable().defaultTo(true);
    t.integer('version').notNullable().defaultTo(1);
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'slug']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('doc_sites');
}
