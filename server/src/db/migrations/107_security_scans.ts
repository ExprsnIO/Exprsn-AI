import type { Knex } from 'knex';

/*
 * 1.8.0, Sprint 48 (B-144): security scan results as a promotion gate (`security/scans.ts`).
 *
 * - `security_scan_results`: one uploaded report (Trivy JSON, SARIF or a CycloneDX SBOM) attached to one artefact by
 *   its digest: an app package (`app-package`, `sha256:<package hash>`), a plugin bundle (`plugin-bundle`, the bundle
 *   digest or `sha256:<manifest hash>` for an inline manifest) or a script runner image (`script-image`, the image's
 *   `sha256:` digest). A result applies only to that exact digest. `findings` holds the normalised findings (severity,
 *   id, package, version, fixed version, licence, path) as JSON; `summary` the counts. The raw report is not kept,
 *   only its SHA-256 (`report_digest`).
 *   `label` is the artefact's (the app's label, a plugin's event ceiling, `internal` for an image): a reader sees a
 *   result only with that clearance.
 * - `security_scan_policies`: one row per tenant: the gate's thresholds (critical and high counts above which a
 *   promotion is refused), the maximum age of a result in days, what happens without a result (`warn`: allowed with a
 *   warning, the default; `refuse`), and the licence deny-list (SPDX ids, JSON).
 * - `security_scan_exceptions`: accepted findings, each with a reason, an expiry and who accepted it. A request is
 *   `pending` until someone other than the requester approves it (dual control); only `active`, unexpired exceptions
 *   count at the gate.
 *
 * Expand only: a build from before this migration ignores the tables.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('security_scan_results'))) {
    await knex.schema.createTable('security_scan_results', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('artefact_kind', 20).notNullable();
      t.string('artefact_digest', 80).notNullable();
      t.string('artefact_ref', 300).nullable();
      t.string('artefact_name', 200).nullable();
      t.string('label', 16).notNullable().defaultTo('internal');
      t.string('format', 16).notNullable();
      t.string('tool', 100).nullable();
      t.string('tool_version', 60).nullable();
      t.string('report_digest', 80).notNullable();
      t.text('summary').notNullable();
      t.text('findings', 'mediumtext').notNullable();
      t.integer('finding_count').notNullable().defaultTo(0);
      t.bigInteger('scanned_at').notNullable();
      t.string('uploaded_by', 26).nullable();
      t.string('uploaded_via', 16).notNullable();
      t.bigInteger('uploaded_at').notNullable();
      t.index(['tenant_id', 'artefact_kind', 'artefact_digest'], 'sec_scan_artefact');
      t.index(['tenant_id', 'uploaded_at'], 'sec_scan_uploaded');
    });
  }
  if (!(await knex.schema.hasTable('security_scan_policies'))) {
    await knex.schema.createTable('security_scan_policies', (t) => {
      t.string('tenant_id', 26).primary();
      t.integer('max_critical').nullable();
      t.integer('max_high').nullable();
      t.integer('max_age_days').nullable();
      t.string('missing', 10).notNullable();
      t.text('licence_deny').notNullable();
      t.integer('version').notNullable().defaultTo(1);
      t.string('updated_by', 26).nullable();
      t.bigInteger('updated_at').notNullable();
    });
  }
  if (!(await knex.schema.hasTable('security_scan_exceptions'))) {
    await knex.schema.createTable('security_scan_exceptions', (t) => {
      t.string('id', 26).primary();
      t.string('tenant_id', 26).notNullable();
      t.string('finding_id', 200).notNullable();
      t.string('package', 200).nullable();
      t.string('artefact_kind', 20).nullable();
      t.string('artefact_digest', 80).nullable();
      t.string('reason', 1000).notNullable();
      t.bigInteger('expires_at').notNullable();
      t.string('state', 12).notNullable();
      t.string('requested_by', 26).notNullable();
      t.bigInteger('requested_at').notNullable();
      t.string('decided_by', 26).nullable();
      t.bigInteger('decided_at').nullable();
      t.string('note', 500).nullable();
      t.index(['tenant_id', 'state'], 'sec_scan_exc_state');
      t.index(['tenant_id', 'finding_id'], 'sec_scan_exc_finding');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('security_scan_exceptions');
  await knex.schema.dropTableIfExists('security_scan_policies');
  await knex.schema.dropTableIfExists('security_scan_results');
}
