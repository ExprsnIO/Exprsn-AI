import { ulid } from 'ulid';
import { z } from 'zod';
import { isUniqueViolation } from '../audit/chain.js';
import { clears, LABELS, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { json, type Db } from '../db/knex.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { CellError, checkDefinition, definitionInputSchema, definitionSchema, DecisionError, emptyDefinition, evaluate, normalize, type Definition, type DecisionCheck, type Evaluation } from './table.js';

/*
 * Decision tables (Sprint 46, B-131): versioned, tenant-scoped objects with a label, as workflows are. The draft is
 * edited and checked; publishing checks it (`checkDefinition`) and stores it as the next version, which workflow
 * `decision` steps (by name, a pinned version or the latest published), app-flow `decision` actions and the built-in
 * tool `decision.evaluate` evaluate. Reading a table needs clearance for its label; tables are seen from every
 * workspace of the tenant. The routes check the permissions (`agents:run` to read and evaluate, `workflows:manage` to
 * design, publish, export and import) and write the audit entries.
 */

export const DECISION_FORMAT = 'exprsn-decision/1';
export const tableName = z.string().trim().regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/, 'Lower-case letters, digits, _ . and -');

export interface TableRow {
  id: string;
  tenant_id: string;
  name: string;
  title: string | null;
  description: string | null;
  label: Label;
  draft: string;
  draft_rev: number;
  published_version: number | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

const rowFrom = (r: Record<string, unknown>): TableRow => ({
  id: String(r.id),
  tenant_id: String(r.tenant_id),
  name: String(r.name),
  title: (r.title as string | null) ?? null,
  description: (r.description as string | null) ?? null,
  label: r.label as Label,
  draft: String(r.draft),
  draft_rev: Number(r.draft_rev),
  published_version: r.published_version == null ? null : Number(r.published_version),
  created_by: (r.created_by as string | null) ?? null,
  updated_by: (r.updated_by as string | null) ?? null,
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

export const exportSchema = z
  .object({
    format: z.literal(DECISION_FORMAT),
    exportedAt: z.string().max(40).optional(),
    table: z.object({ name: tableName, title: z.string().max(200).nullable().optional(), description: z.string().max(500).nullable().optional(), label: z.enum(LABELS) }).strict(),
    version: z.number().int().min(1).nullable().optional(),
    definition: z.unknown()
  })
  .strict();
export type DecisionExport = z.infer<typeof exportSchema>;

/** What a workflow `decision` step sees of a table at publish. */
export interface DecisionRef {
  id: string;
  name: string;
  label: Label;
  version: number;
  definition: Definition;
}

/** A definition as stored (always the normalized, structured form). */
function parseStored(text: string): Definition {
  const r = definitionSchema.safeParse(json(text, null));
  return r.success ? r.data : emptyDefinition();
}

/** The API's definition (text or structured cells) as stored, or a 400 naming the cell that does not parse. */
export function definitionFrom(raw: unknown): Definition {
  const input = definitionInputSchema.safeParse(raw);
  if (!input.success) {
    const i = input.error.issues[0]!;
    throw badRequest(`The definition is not valid: ${i.path.join('.') || 'definition'}: ${i.message}`, { errors: input.error.issues.slice(0, 20).map((x) => ({ path: x.path.join('.'), message: x.message })) });
  }
  try {
    return normalize(input.data);
  } catch (err) {
    if (err instanceof CellError) throw badRequest(err.message, { errors: [{ rule: err.rule, column: err.column, message: err.message }] });
    throw err;
  }
}

export class DecisionService {
  constructor(private readonly db: Db) {}

  /** A table by id or name, as the caller may see it (404 when it is above their clearance). */
  async table(p: Principal, ref: string): Promise<TableRow> {
    const r = await this.db('decision_tables').where({ tenant_id: p.tenantId }).andWhere((q) => q.where({ id: ref }).orWhere({ name: ref })).first();
    if (!r) throw notFound('Decision table');
    const t = rowFrom(r as Record<string, unknown>);
    if (!clears(p.clearance, t.label)) throw notFound('Decision table');
    return t;
  }

  private summary(t: TableRow) {
    return { id: t.id, name: t.name, title: t.title, description: t.description, label: t.label, draftRev: t.draft_rev, publishedVersion: t.published_version, createdBy: t.created_by, updatedBy: t.updated_by, createdAt: t.created_at, updatedAt: t.updated_at };
  }

  async list(p: Principal) {
    const rows = ((await this.db('decision_tables').where({ tenant_id: p.tenantId }).orderBy('name')) as Record<string, unknown>[]).map(rowFrom).filter((t) => clears(p.clearance, t.label));
    return rows.map((t) => {
      const d = parseStored(t.draft);
      return { ...this.summary(t), hitPolicy: d.hitPolicy, inputs: d.inputs.length, outputs: d.outputs.length, rules: d.rules.length };
    });
  }

  async view(p: Principal, ref: string) {
    const t = await this.table(p, ref);
    const draft = parseStored(t.draft);
    const versions = (await this.db('decision_table_versions').where({ table_id: t.id }).orderBy('version', 'desc')) as Record<string, unknown>[];
    const published = versions.find((v) => Number(v.version) === t.published_version);
    return {
      ...this.summary(t),
      draft,
      dirty: !published || JSON.stringify(json(published.definition, null)) !== JSON.stringify(draft),
      check: checkDefinition(draft),
      versions: versions.map((v) => ({ version: Number(v.version), state: String(v.state), note: (v.note as string | null) ?? null, publishedBy: (v.published_by as string | null) ?? null, publishedAt: Number(v.published_at), rules: parseStored(String(v.definition)).rules.length }))
    };
  }

  async version(p: Principal, ref: string, version: number) {
    const t = await this.table(p, ref);
    const v = (await this.db('decision_table_versions').where({ table_id: t.id, version }).first()) as Record<string, unknown> | undefined;
    if (!v) throw notFound(`Version ${version} of ${t.name}`);
    return { id: t.id, name: t.name, version, state: String(v.state), note: (v.note as string | null) ?? null, publishedBy: (v.published_by as string | null) ?? null, publishedAt: Number(v.published_at), definition: parseStored(String(v.definition)) };
  }

  async create(p: Principal, input: { name: string; title?: string | null; description?: string | null; label: Label; definition?: Definition }): Promise<TableRow> {
    if (!clears(p.clearance, input.label)) throw forbidden(`Your clearance is ${p.clearance}; a ${input.label} decision table is above it.`, { step: 'clearance' });
    const t = Date.now();
    const row: TableRow = { id: ulid(), tenant_id: p.tenantId, name: input.name, title: input.title ?? null, description: input.description ?? null, label: input.label, draft: JSON.stringify(input.definition ?? emptyDefinition()), draft_rev: 1, published_version: null, created_by: p.userId, updated_by: p.userId, created_at: t, updated_at: t };
    try {
      await this.db('decision_tables').insert(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A decision table named ${input.name} exists.`);
      throw err;
    }
    return row;
  }

  /** Saves the draft; `rev` (the revision the editor loaded) guards against overwriting someone else's save. */
  async saveDraft(p: Principal, ref: string, input: { definition?: Definition; title?: string | null; description?: string | null; label?: Label; rev?: number }) {
    const t = await this.table(p, ref);
    if (input.rev != null && input.rev !== t.draft_rev) throw conflict(`The draft changed since you opened it (revision ${t.draft_rev}, you have ${input.rev}). Reload it and apply your change again.`);
    const upd: Record<string, unknown> = { draft_rev: t.draft_rev + 1, updated_by: p.userId, updated_at: Date.now() };
    if (input.definition) upd.draft = JSON.stringify(input.definition);
    if (input.title !== undefined) upd.title = input.title;
    if (input.description !== undefined) upd.description = input.description;
    if (input.label) {
      if (!clears(p.clearance, input.label)) throw forbidden('Above your clearance.', { step: 'clearance' });
      upd.label = input.label;
    }
    const n = await this.db('decision_tables').where({ id: t.id, draft_rev: t.draft_rev }).update(upd);
    if (n !== 1) throw conflict('The draft changed while saving. Reload it and apply your change again.');
    return this.view(p, t.id);
  }

  /** Checks the draft and publishes it as the next version; a draft with problems is refused (422) with all of them. */
  async publish(p: Principal, ref: string, note: string | null): Promise<{ table: TableRow; version: number; check: DecisionCheck }> {
    const t = await this.table(p, ref);
    const d = parseStored(t.draft);
    const check = checkDefinition(d);
    if (!check.ok) throw new HttpProblem(422, 'Decision table invalid', `Publishing failed: ${check.errors[0]!.message}${check.errors.length > 1 ? ` (${check.errors.length - 1} more)` : ''}`, { extensions: { errors: check.errors, warnings: check.warnings } });
    const last = (await this.db('decision_table_versions').where({ table_id: t.id }).max({ v: 'version' }).first()) as { v: number | null } | undefined;
    const version = Number(last?.v ?? 0) + 1;
    await this.db.transaction(async (trx) => {
      await trx('decision_table_versions').where({ table_id: t.id, state: 'published' }).update({ state: 'deprecated' });
      await trx('decision_table_versions').insert({ id: ulid(), tenant_id: t.tenant_id, table_id: t.id, version, definition: JSON.stringify(d), state: 'published', note, published_by: p.userId, published_at: Date.now() });
      await trx('decision_tables').where({ id: t.id }).update({ published_version: version, updated_at: Date.now(), updated_by: p.userId });
    });
    return { table: t, version, check };
  }

  /** Published workflows (their current version) whose decision steps name the table. */
  async usedBy(t: Pick<TableRow, 'tenant_id' | 'id' | 'name'>): Promise<{ workflow: string; workflowId: string; version: number; steps: string[] }[]> {
    const rows = (await this.db('workflows as w').join('workflow_versions as v', function () {
      this.on('v.workflow_id', '=', 'w.id').andOn('v.version', '=', 'w.published_version');
    }).where('w.tenant_id', t.tenant_id).select('w.id', 'w.name', 'v.version', 'v.graph')) as { id: string; name: string; version: number; graph: string }[];
    const out = [];
    for (const r of rows) {
      const g = json<{ nodes?: { id: string; kind: string; config?: { table?: unknown } }[] }>(r.graph, {});
      const steps = (g.nodes ?? []).filter((n) => n.kind === 'decision' && (n.config?.table === t.name || n.config?.table === t.id)).map((n) => n.id);
      if (steps.length) out.push({ workflow: r.name, workflowId: r.id, version: Number(r.version), steps });
    }
    return out;
  }

  async remove(p: Principal, ref: string): Promise<TableRow> {
    const t = await this.table(p, ref);
    const used = await this.usedBy(t);
    if (used.length) throw new HttpProblem(409, 'Still in use', `${t.name} is used by the published workflow${used.length === 1 ? '' : 's'} ${used.map((u) => u.workflow).join(', ')}; publish ${used.length === 1 ? 'it' : 'them'} without the decision step before deleting the table.`, { extensions: { usedBy: used } });
    await this.db.transaction(async (trx) => {
      await trx('decision_table_versions').where({ table_id: t.id }).delete();
      await trx('decision_tables').where({ id: t.id }).delete();
    });
    return t;
  }

  /** The definition a test, a step or the tool evaluates: a version, the latest published one, or the draft. */
  async definitionOf(t: TableRow, version: number | 'draft' | 'published'): Promise<{ version: number | null; definition: Definition }> {
    if (version === 'draft') return { version: null, definition: parseStored(t.draft) };
    const v = version === 'published' ? t.published_version : version;
    if (v == null) throw conflict(`${t.name} has no published version yet.`);
    const row = (await this.db('decision_table_versions').where({ table_id: t.id, version: v }).first('definition')) as { definition: string } | undefined;
    if (!row) throw notFound(`Version ${v} of ${t.name}`);
    return { version: v, definition: parseStored(row.definition) };
  }

  /** Evaluates a table as `p` sees it; a broken unique or any policy, or an input of the wrong type, is a 422. */
  async evaluateAs(p: Principal, ref: string, version: number | 'draft' | 'published', inputs: Record<string, unknown>): Promise<{ table: TableRow; version: number | null; result: Evaluation }> {
    const t = await this.table(p, ref);
    const d = await this.definitionOf(t, version);
    return { table: t, version: d.version, result: evaluateOrProblem(d.definition, inputs) };
  }

  exportOf(t: TableRow, version: number | null, definition: Definition): DecisionExport {
    return { format: DECISION_FORMAT, exportedAt: new Date().toISOString(), table: { name: t.name, title: t.title, description: t.description, label: t.label }, version, definition };
  }

  /** Creates a table from an export, its definition as the draft (never published); `name` renames it. */
  async import(p: Principal, raw: unknown, o: { name?: string }): Promise<TableRow> {
    const doc = exportSchema.safeParse(raw);
    if (!doc.success) throw badRequest(`The file is not an ${DECISION_FORMAT} export: ${doc.error.issues[0]?.path.join('.') ?? ''} ${doc.error.issues[0]?.message ?? ''}`.trim());
    const definition = definitionFrom(doc.data.definition);
    return this.create(p, { name: o.name ?? doc.data.table.name, title: doc.data.table.title ?? null, description: doc.data.table.description ?? null, label: doc.data.table.label, definition });
  }

  // ---------- for workflows ----------

  /** A table at publish of a workflow (tenant-wide, no person): its version, or why it cannot be used. */
  async refInfo(tenantId: string, ref: string, version?: number): Promise<DecisionRef | { missing: string }> {
    const r = await this.db('decision_tables').where({ tenant_id: tenantId }).andWhere((q) => q.where({ id: ref }).orWhere({ name: ref })).first();
    if (!r) return { missing: 'is not a decision table here' };
    const t = rowFrom(r as Record<string, unknown>);
    const v = version ?? t.published_version;
    if (v == null) return { missing: 'has no published version' };
    const row = (await this.db('decision_table_versions').where({ table_id: t.id, version: v }).first('definition')) as { definition: string } | undefined;
    if (!row) return { missing: `has no published version ${v}` };
    return { id: t.id, name: t.name, label: t.label, version: v, definition: parseStored(row.definition) };
  }

  /** The table a running step evaluates, as the run's owner: `blocked` when it is above their clearance. */
  async forStep(p: Principal, ref: string, version?: number): Promise<DecisionRef | { missing: string; blocked?: boolean }> {
    const info = await this.refInfo(p.tenantId, ref, version);
    if ('missing' in info) return info;
    if (!clears(p.clearance, info.label)) return { missing: `is ${info.label}, above the clearance of the run's owner (${p.clearance})`, blocked: true };
    return info;
  }
}

/** `evaluate`, with its refusals as 422 problems naming the rules. */
export function evaluateOrProblem(d: Definition, inputs: Record<string, unknown>): Evaluation {
  try {
    return evaluate(d, inputs);
  } catch (err) {
    if (err instanceof DecisionError) throw new HttpProblem(422, err.code === 'input' ? 'Input refused' : 'Hit policy violated', err.message, { extensions: { code: err.code, rules: err.rules } });
    throw err;
  }
}
