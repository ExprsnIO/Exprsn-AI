import type { Knex } from 'knex';
import { BUILTIN_TEMPLATES, templateNeeds } from '../../workflows/template-catalog.js';

/*
 * 1.8.0, Sprint 47 (B-136): the workflow template gallery (`workflows/templates.ts`).
 *
 * `workflow_templates`: a workflow graph with what it needs and its gallery metadata. `scope` is `builtin` for the
 * starters that ship with the server (tenant_id null) or the tenant's id for one saved from a workflow ("save as
 * template"), so a name is unique per scope on every dialect (a unique index over a nullable tenant id is not).
 * `needs` (JSON) lists the references a new workflow must bind (tools, profiles, apps, decision tables, roles,
 * connections, knowledge bases, vault references); `tags` is a JSON array. The graph is the one `exprsn-workflow/1`
 * bundles carry, and "use template" goes through the bundle import path (`WorkflowBundles.instantiate`).
 *
 * The built-in starters are inserted here from `workflows/template-catalog.ts`, as migration 034c seeds the built-in
 * tools; `WorkflowTemplates.syncBuiltins` refreshes a starter whose catalogue version changed. Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('workflow_templates'))) {
    await knex.schema.createTable('workflow_templates', (t) => {
      t.string('id', 26).primary();
      t.string('scope', 26).notNullable(); // builtin | <tenant id>
      t.string('tenant_id', 26).nullable();
      t.string('workspace_id', 26).nullable();
      t.string('name', 63).notNullable();
      t.string('title', 120).notNullable();
      t.string('summary', 500).notNullable();
      t.string('category', 40).notNullable();
      t.text('tags').notNullable(); // JSON array
      t.string('icon', 40).notNullable();
      t.string('version', 20).notNullable();
      t.string('label', 20).notNullable();
      t.text('graph', 'mediumtext').notNullable(); // JSON WfGraph
      t.text('needs').notNullable(); // JSON TemplateNeeds
      t.string('source_workflow', 26).nullable();
      t.integer('uses').notNullable().defaultTo(0);
      t.string('created_by', 26).nullable();
      t.string('updated_by', 26).nullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('updated_at').notNullable();
      t.unique(['scope', 'name'], { indexName: 'workflow_templates_scope_name_uq' });
      t.index(['scope', 'category'], 'workflow_templates_category_idx');
    });
  }
  const now = Date.now();
  for (const b of BUILTIN_TEMPLATES) {
    if (await knex('workflow_templates').where({ id: b.id }).first('id')) continue;
    await knex('workflow_templates').insert({
      id: b.id,
      scope: 'builtin',
      tenant_id: null,
      workspace_id: null,
      name: b.name,
      title: b.title,
      summary: b.summary,
      category: b.category,
      tags: JSON.stringify(b.tags),
      icon: b.icon,
      version: b.version,
      label: b.label,
      graph: JSON.stringify(b.graph),
      needs: JSON.stringify(templateNeeds(b.graph)),
      source_workflow: null,
      uses: 0,
      created_by: null,
      updated_by: null,
      created_at: now,
      updated_at: now
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('workflow_templates');
}
