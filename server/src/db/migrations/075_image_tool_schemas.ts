import type { Knex } from 'knex';
import { imageTools } from '../../registry/builtin/image-catalog.js';

/*
 * 1.7.0 (2026-10-14): the image built-ins' schemas and descriptions as `registry/builtin/image-catalog.ts` has them
 * now. A model in chat wrote `"image": "latest"`, which the seeded pattern (an id only) refused; the pattern also takes
 * the words for the newest picture (`NEWEST_WORDS`), which the tool reads as "left out". Rows seeded by migration 074
 * are updated in place (schema hash `builtin-<name>-2`); nothing else changes.
 */
export async function up(knex: Knex): Promise<void> {
  const now = Date.now();
  for (const b of imageTools()) {
    const hash = `builtin-${b.builtin}-2`;
    await knex('registry_entries').where({ id: b.id, impl: 'builtin' }).update({ description: b.description, input_schema: JSON.stringify(b.inputSchema), output_schema: JSON.stringify(b.outputSchema), schema_hash: hash, approved_hash: hash, updated_at: now });
  }
}

export async function down(): Promise<void> {
  // The earlier pattern only refused more; nothing to undo.
}
