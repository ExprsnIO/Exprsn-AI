import type { Knex } from 'knex';
import { imageTools } from '../../registry/builtin/image-catalog.js';

/*
 * 1.7.0 (2026-10-14): pictures edited and restyled from chat.
 *
 * - `image_jobs.source_kind` and `source_id`: the picture an edit or a restyle starts from, `image` (another row of
 *   this table) or `attachment` (a picture attached in chat); null for a picture generated from a prompt.
 * - `image_jobs.edits`: the operations of an edit as JSON (crop, resize, ... see `images/edits.ts`); null for a
 *   generated or restyled picture. An edit runs on the CPU editor, not on a backend, and `backend` is `editor`.
 * - `image_jobs.conversation_id`: the conversation a tool made the picture in, so the chat can find "the newest
 *   picture here" and show it.
 * - The built-in tools image_list, image_generate, image_crop, image_resize, image_rotate, image_blur, image_adjust,
 *   image_effect, image_style, image_edit and image_restyle as platform entries (`registry/builtin/image-catalog.ts`).
 *
 * Expand only. A build from before this migration ignores the columns and the tools fail as unknown built-ins.
 */
export async function up(knex: Knex): Promise<void> {
  const has = async (c: string) => knex.schema.hasColumn('image_jobs', c);
  const add = { source_kind: !(await has('source_kind')), source_id: !(await has('source_id')), edits: !(await has('edits')), conversation_id: !(await has('conversation_id')) };
  if (Object.values(add).some(Boolean)) {
    await knex.schema.alterTable('image_jobs', (t) => {
      if (add.source_kind) t.string('source_kind', 20).nullable();
      if (add.source_id) t.string('source_id', 26).nullable();
      if (add.edits) t.text('edits').nullable();
      if (add.conversation_id) {
        t.string('conversation_id', 26).nullable();
        t.index(['tenant_id', 'user_id', 'conversation_id'], 'image_jobs_conversation_idx');
      }
    });
  }

  const now = Date.now();
  for (const b of imageTools()) {
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
      checks: JSON.stringify([{ name: 'Built into the platform', ok: true, detail: 'Ships with the server; acts through the images service as the caller, on the caller\'s own pictures only; reviewed with each release.' }]),
      checked_at: now,
      owner_id: null,
      owner_name: 'Platform',
      publish_scope: 'platform',
      created_at: now,
      updated_at: now
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex('registry_entries').where({ impl: 'builtin' }).whereIn('name', imageTools().map((b) => b.name)).delete();
  if (await knex.schema.hasColumn('image_jobs', 'conversation_id')) {
    await knex.schema.alterTable('image_jobs', (t) => {
      t.dropIndex(['tenant_id', 'user_id', 'conversation_id'], 'image_jobs_conversation_idx');
      t.dropColumn('conversation_id');
      t.dropColumn('edits');
      t.dropColumn('source_id');
      t.dropColumn('source_kind');
    });
  }
}
