import type { Knex } from 'knex';

/*
 * 1.6.0, Sprint 39b (B-8201 to B-8204): app packages, environments and promotion.
 *
 * - `app_packages`: a versioned, signed package of an app's design (`exprsn-app/2`: entities, forms, triggers, policies,
 *   the workflows the triggers name, records when asked for), sealed with the tenant key. A package is made by an
 *   export, by a promotion (the exact package that moves stage to stage), by a backup taken before each deployment,
 *   or by an import from a git repository. `version` counts up per source app.
 * - `app_pipelines`: an app's environments: three app slots (development, test, production) and the workflow whose
 *   approval step guards the production stage.
 * - `app_deployments`: the deployment history (promotions and rollbacks) with the package, the backup taken first,
 *   the approval run and the report, kept APPS_DEPLOYMENT_HISTORY_DAYS.
 * Expand only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('app_packages', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('app_id', 26).notNullable(); // the app the package was made from
    t.string('app_name', 63).notNullable();
    t.integer('version').notNullable();
    t.string('format', 20).notNullable();
    t.string('source', 20).notNullable(); // export | promotion | backup | git | rollback
    t.string('hash', 64).notNullable(); // SHA-256 of the canonical body without its signature
    t.boolean('with_data').notNullable().defaultTo(false);
    t.integer('size').notNullable();
    t.text('body', 'mediumtext').notNullable(); // the signed package, sealed
    t.string('note', 500).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.index(['tenant_id', 'app_id', 'version'], 'app_packages_app_idx');
  });

  await knex.schema.createTable('app_pipelines', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('name', 100).notNullable();
    t.string('dev_app_id', 26).notNullable();
    t.string('test_app_id', 26).notNullable();
    t.string('prod_app_id', 26).notNullable();
    t.string('approval_workflow_id', 26).nullable();
    t.string('created_by', 26).nullable();
    t.string('updated_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['tenant_id', 'name'], 'app_pipelines_name_uq');
  });

  await knex.schema.createTable('app_deployments', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('pipeline_id', 26).notNullable();
    t.string('kind', 20).notNullable(); // promotion | rollback
    t.string('from_stage', 20).nullable(); // development | test | production (null for a rollback: the backup)
    t.string('to_stage', 20).notNullable();
    t.string('package_id', 26).notNullable();
    t.integer('version').notNullable();
    t.string('source_app_id', 26).nullable();
    t.string('target_app_id', 26).notNullable();
    t.string('backup_package_id', 26).nullable();
    t.string('state', 24).notNullable(); // awaiting-approval | queued | running | succeeded | failed | rejected
    t.string('approval_run_id', 26).nullable();
    t.string('rollback_of', 26).nullable(); // the deployment a rollback undoes
    t.text('report', 'mediumtext').nullable();
    t.string('error', 1000).nullable();
    t.string('job_id', 64).nullable();
    t.string('created_by', 26).nullable();
    t.bigInteger('created_at').notNullable();
    t.bigInteger('started_at').nullable();
    t.bigInteger('finished_at').nullable();
    t.index(['tenant_id', 'pipeline_id', 'created_at'], 'app_deployments_pipeline_idx');
    t.index(['tenant_id', 'target_app_id'], 'app_deployments_target_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  for (const t of ['app_deployments', 'app_pipelines', 'app_packages']) await knex.schema.dropTableIfExists(t);
}
