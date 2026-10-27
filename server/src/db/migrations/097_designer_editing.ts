import type { Knex } from 'knex';

/*
 * 1.8.0, Sprint 47 (B-137): workflow tags and favourites (`workflows/tags.ts`).
 *
 * - `workflow_tags`: the tenant's tags on a workflow, one row per (workflow, tag). A tag is lower-case letters, digits
 *   and hyphens; the vocabulary is the tenant's (the distinct tags of the workflows a person may see). Changed by
 *   workflow admins, audited `workflow.tags.updated`.
 * - `workflow_favourites`: a person's starred workflows, one row per (user, workflow). Personal: nobody else reads
 *   them.
 *
 * Both are removed with their workflow. Step comments (also B-137) need no table: they are kept on the step in the
 * draft graph (`nodes[].comments`), so versions and bundles carry them. Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('workflow_tags'))) {
    await knex.schema.createTable('workflow_tags', (t) => {
      t.string('tenant_id', 26).notNullable();
      t.string('workflow_id', 26).notNullable();
      t.string('tag', 40).notNullable();
      t.string('created_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.primary(['workflow_id', 'tag']);
      t.index(['tenant_id', 'tag'], 'workflow_tags_tenant_tag');
    });
  }
  if (!(await knex.schema.hasTable('workflow_favourites'))) {
    await knex.schema.createTable('workflow_favourites', (t) => {
      t.string('tenant_id', 26).notNullable();
      t.string('user_id', 26).notNullable();
      t.string('workflow_id', 26).notNullable();
      t.bigInteger('created_at').notNullable();
      t.primary(['user_id', 'workflow_id']);
      t.index(['workflow_id'], 'workflow_favourites_workflow');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('workflow_favourites');
  await knex.schema.dropTableIfExists('workflow_tags');
}
