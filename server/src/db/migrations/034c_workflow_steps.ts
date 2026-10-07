import type { Knex } from 'knex';
import { BUILTIN_TOOLS } from '../../registry/builtin/catalog.js';

/*
 * Sprint 32c (1.5.0), Workflows 2 steps: B-3904, B-3907, B-3908.
 *
 * - `registry_entries`: the domain built-in tools (`impl: builtin`, platform entries like `calculate`): messages.send,
 *   feed.post, files.write_version, groups.create_event and channels.answer.
 * - `feed_posts.source_kind`, `source_id`: what made a post when it was not typed by a person (a workflow run, an
 *   agent run, a conversation, a plugin), shown on the post as its source.
 * - `workflow_approvals.form` (JSON: the app form an approval asks the approver to fill in) and `answers` (sealed: the
 *   approver's answers, validated like a submission, which become the step's output).
 *
 * Expand only: new nullable columns and new rows.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('feed_posts', (t) => {
    t.string('source_kind', 40).nullable();
    t.string('source_id', 64).nullable();
  });
  await knex.schema.alterTable('workflow_approvals', (t) => {
    t.text('form').nullable();
    t.text('answers', 'mediumtext').nullable();
  });
  const t = Date.now();
  for (const b of BUILTIN_TOOLS) {
    if (await knex('registry_entries').where({ id: b.id }).first('id')) continue;
    const hash = `builtin-${b.builtin}-1`;
    await knex('registry_entries').insert({
      id: b.id,
      tenant_id: null,
      workspace_id: null,
      kind: 'tool',
      name: b.name,
      version: '1.0.0',
      description: b.description,
      impl: 'builtin',
      side_effect: b.sideEffect,
      confirm: 'never',
      rate_per_hour: null,
      label: b.label,
      input_schema: JSON.stringify(b.inputSchema),
      output_schema: JSON.stringify(b.outputSchema),
      definition: JSON.stringify({ builtin: b.builtin }),
      status: 'published',
      schema_hash: hash,
      approved_hash: hash,
      checks: JSON.stringify([{ name: 'Built into the platform', ok: true, detail: 'Ships with the server; acts through the domain service as the caller; reviewed with each release.' }]),
      checked_at: t,
      owner_id: null,
      owner_name: 'Platform',
      publish_scope: 'platform',
      created_at: t,
      updated_at: t
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex('registry_entries').whereIn('id', BUILTIN_TOOLS.map((b) => b.id)).delete();
  await knex.schema.alterTable('workflow_approvals', (t) => {
    t.dropColumn('form');
    t.dropColumn('answers');
  });
  await knex.schema.alterTable('feed_posts', (t) => {
    t.dropColumn('source_kind');
    t.dropColumn('source_id');
  });
}
