import type { Knex } from 'knex';
import { ulid } from 'ulid';

/*
 * 1.6.0, Sprint 37a.
 *
 * B-89 HTTP tool kind:
 * - `registry_http_calls`: the meter of `impl: http` registry tools: one row per call with the tool, host, method,
 *   status, response size and latency (never a header, a query string or a body), for the Registry screen and usage.
 *
 * B-69 prompt-injection defence:
 * - `profiles.trust_marking`: whether untrusted content (retrieved chunks, crawled pages, tool, MCP and HTTP results)
 *   reaches the profile's model datamarked inside its delimiters (B-6901); on by default.
 * - `injection_detections`: what the `untrusted-content` checkpoint found, per source (knowledge, crawl, tool, mcp,
 *   http) and action (annotate or block), for the counts on the Guardrails screen (B-6902). No text is kept here; the
 *   inspected text is in the sealed guard decision.
 * - The platform baseline gets the rule `injection-untrusted` (annotate instructions in untrusted content) as a new
 *   published version, when it exists and does not have it yet. A fresh install seeds it with the baseline.
 * Expand only.
 */

const RULE = {
  id: 'injection-untrusted',
  name: 'Instructions in untrusted content',
  checkpoint: 'untrusted-content',
  type: 'injection',
  mechanism: { kind: 'injection', engine: 'heuristic', threshold: 0.6 },
  action: 'warn',
  stage: 'enforce',
  onError: 'closed',
  severity: 'medium',
  enabled: true,
  description: 'Retrieved chunks, crawled pages, tool results and MCP and HTTP answers that try to instruct the model reach it with a warning. Add a blocking rule in a tenant set to withhold them instead.'
};
const BASELINE = '0000000000000000GRBASELINE';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('profiles', (t) => {
    t.boolean('trust_marking').notNullable().defaultTo(true);
  });

  await knex.schema.createTable('injection_detections', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).nullable();
    t.string('user_id', 26).nullable();
    t.string('source', 20).notNullable(); // knowledge | crawl | tool | mcp | http
    t.string('ref', 200).notNullable(); // the chunk, tool entry or call it came from
    t.string('name', 200).notNullable();
    t.string('action', 20).notNullable(); // annotate | block | allow (a log-only rule)
    t.string('rule_id', 100).nullable();
    t.string('rule_name', 200).nullable();
    t.float('score').nullable();
    t.string('label', 20).notNullable();
    t.bigInteger('created_at').notNullable();
    t.index(['tenant_id', 'created_at'], 'injection_detections_tenant_idx');
  });

  await knex.schema.createTable('registry_http_calls', (t) => {
    t.string('id', 26).primary();
    t.string('tenant_id', 26).notNullable();
    t.string('workspace_id', 26).nullable();
    t.string('user_id', 26).nullable();
    t.string('entry_id', 26).notNullable();
    t.string('tool', 120).notNullable();
    t.string('host', 253).notNullable();
    t.string('method', 10).notNullable();
    t.integer('status').notNullable().defaultTo(0); // 0: no answer (refused, timed out)
    t.integer('bytes').notNullable().defaultTo(0);
    t.integer('latency_ms').notNullable().defaultTo(0);
    t.string('outcome', 20).notNullable(); // ok | http-error | refused | failed
    t.bigInteger('created_at').notNullable();
    t.index(['tenant_id', 'entry_id', 'created_at'], 'registry_http_calls_entry_idx');
  });

  await addBaselineRule(knex);
}

/** Adds the injection rule to the published platform baseline as a new published version (idempotent). */
export async function addBaselineRule(knex: Knex): Promise<void> {
  const set = (await knex('guard_rule_sets').where({ id: BASELINE }).first('published_version')) as { published_version: number | null } | undefined;
  if (!set || set.published_version == null) return; // a fresh install seeds the rule with the baseline
  const current = (await knex('guard_rule_set_versions').where({ set_id: BASELINE, version: Number(set.published_version) }).first('rules')) as { rules: string | null } | undefined;
  const rules = JSON.parse(current?.rules ?? '[]') as { id: string }[];
  if (rules.some((r) => r.id === RULE.id)) return;
  const top = (await knex('guard_rule_set_versions').where({ set_id: BASELINE }).max({ v: 'version' }).first()) as { v: number | string | null } | undefined;
  const version = Number(top?.v ?? set.published_version) + 1;
  const t = Date.now();
  await knex('guard_rule_set_versions').where({ set_id: BASELINE, version: Number(set.published_version) }).update({ status: 'superseded', updated_at: t });
  await knex('guard_rule_set_versions').insert({ id: ulid(), set_id: BASELINE, version, status: 'published', rules: JSON.stringify([...rules, RULE]), note: 'Migration 039 (B-6902): annotate instructions in untrusted content', created_by: null, submitted_by: null, submitted_at: null, approved_by: null, approved_at: null, published_at: t, created_at: t, updated_at: t });
  await knex('guard_rule_sets').where({ id: BASELINE }).update({ published_version: version, updated_at: t });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('registry_http_calls');
  await knex.schema.dropTableIfExists('injection_detections');
  await knex.schema.alterTable('profiles', (t) => {
    t.dropColumn('trust_marking');
  });
}
