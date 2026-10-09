import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import type { Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { conflict, HttpProblem } from '../http/problem.js';
import type { Services } from '../services.js';
import { FORMULA_FUNCTIONS } from './formula.js';
import { generate, ModelUnavailable, parseJsonObject } from './ai.js';
import { checkDefinition, entityDefinitionSchema, FIELD_TYPES, nameSchema, type EntityDefinition, type Field } from './schema.js';
import type { Actor, AppRow, AppService, EntityRow } from './service.js';
import type { RecordEvent } from './service.js';

/*
 * Data model generation (1.6.0, B-8301). A description of an app becomes a draft of its whole data model from a local
 * model through the gateway and a published profile: entities with typed fields, relations (reference fields),
 * formulas, state machines and record triggers naming existing workflows. The draft is validated with the same
 * schemas and checks as a saved entity, compared with the app's current entities as a diff (new, changed, same) and
 * returned, never saved; accepting it (`apply`) creates the new entities, adds the drafted fields and state machines
 * to existing ones (nothing is removed) and creates the triggers whose workflow exists, in one request, audited.
 */

const MAX_ENTITIES = 12;

const SYSTEM = `You design the data model of a low-code app. Answer with one JSON object and nothing else:
{"entities": [{"name": "lower_snake_case", "title": "Title", "definition": {"fields": [...], "states": optional}}], "triggers": optional [{"entity": "name", "events": ["created"], "workflow": "workflow name"}]}
A field is {"name": "lower_snake_case", "type": one of ${FIELD_TYPES.filter((t) => t !== 'ai').map((t) => `"${t}"`).join(', ')}, "title": "Label", "required": false, "indexed": false}.
Enum fields have "options": [{"value": "..."}]. Reference fields have "entity": another entity's name (a relation). Formula fields have "expression" over the entity's own fields using only these functions: ${FORMULA_FUNCTIONS.join(', ')}.
A state machine is {"initial": "new", "states": [{"name": "new"}, {"name": "approved"}], "transitions": [{"from": ["new"], "to": "approved", "roles": optional ["workspace-admin"]}]}.
At most ${MAX_ENTITIES} entities, each with at most 30 fields. Keep names short. Do not invent workflows: list a trigger only when the description names one.`;

export const modelDraftSchema = z.object({ prompt: z.string().trim().min(3).max(4000), profile: z.string().min(1).max(63) }).strict();

const draftEntitySchema = z.object({ name: nameSchema, title: z.string().trim().min(1).max(200).optional(), label: z.string().optional(), definition: entityDefinitionSchema }).strict();
const draftTriggerSchema = z.object({ entity: nameSchema, events: z.array(z.enum(['created', 'updated', 'deleted', 'transitioned'])).min(1).max(4), workflow: z.string().trim().min(1).max(100) }).strict();
export const modelApplySchema = z.object({ entities: z.array(draftEntitySchema).min(1).max(MAX_ENTITIES), triggers: z.array(draftTriggerSchema).max(50).default([]) }).strict();
export type ModelApply = z.infer<typeof modelApplySchema>;

export interface EntityDiff {
  entity: string;
  change: 'new' | 'changed' | 'same';
  addedFields: string[];
  changedFields: string[];
  removedFields: string[];
  states: 'added' | 'changed' | 'same' | null;
  problems: string[];
}

const fieldSig = (f: Field) => JSON.stringify({ ...f, title: undefined, description: undefined });

/** How a drafted entity differs from the saved one (fields the draft does not carry are listed, never removed). */
export function diffEntity(name: string, draft: EntityDefinition, saved: EntityDefinition | null): EntityDiff {
  if (!saved) return { entity: name, change: 'new', addedFields: draft.fields.map((f) => f.name), changedFields: [], removedFields: [], states: draft.states ? 'added' : null, problems: [] };
  const before = new Map(saved.fields.map((f) => [f.name, f]));
  const after = new Map(draft.fields.map((f) => [f.name, f]));
  const addedFields = draft.fields.filter((f) => !before.has(f.name)).map((f) => f.name);
  const changedFields = draft.fields.filter((f) => before.has(f.name) && fieldSig(before.get(f.name)!) !== fieldSig(f)).map((f) => f.name);
  const removedFields = saved.fields.filter((f) => !after.has(f.name)).map((f) => f.name);
  const states = !draft.states ? null : !saved.states ? 'added' : JSON.stringify(draft.states) === JSON.stringify(saved.states) ? 'same' : 'changed';
  const change = addedFields.length || changedFields.length || states === 'added' || states === 'changed' ? 'changed' : 'same';
  return { entity: name, change, addedFields, changedFields, removedFields, states, problems: [] };
}

/** The saved definition with the drafted fields added or replaced by name and the drafted state machine, nothing removed. */
export function mergeDefinition(saved: EntityDefinition, draft: EntityDefinition): EntityDefinition {
  const byName = new Map(draft.fields.map((f) => [f.name, f]));
  const fields = saved.fields.map((f) => byName.get(f.name) ?? f);
  for (const f of draft.fields) if (!saved.fields.some((x) => x.name === f.name)) fields.push(f);
  return { ...saved, fields, ...(draft.states ? { states: draft.states } : {}), ...(draft.titleField ? { titleField: draft.titleField } : {}) };
}

export class ModelDrafts {
  constructor(
    private readonly s: () => Services,
    private readonly apps: AppService
  ) {}

  /** Validates drafted entities against the app and each other; returns the diff per entity and the problems. */
  private async check(app: AppRow, entities: { name: string; definition: EntityDefinition }[], triggers: { entity: string; events: RecordEvent[]; workflow: string }[]) {
    const saved = new Map((await this.apps.entities(app)).map((e) => [e.name, e]));
    const names = new Set([...saved.keys(), ...entities.map((e) => e.name)]);
    const problems: string[] = [];
    if (new Set(entities.map((e) => e.name)).size !== entities.length) problems.push('The draft names an entity twice.');
    const diff: EntityDiff[] = [];
    for (const e of entities) {
      const old = saved.get(e.name);
      const def = old ? mergeDefinition(old.definition, e.definition) : e.definition;
      const d = diffEntity(e.name, e.definition, old?.definition ?? null);
      d.problems = checkDefinition(def, names).map((x) => `${e.name}: ${x}`);
      if (old) {
        for (const f of e.definition.fields) {
          const o = old.definition.fields.find((x) => x.name === f.name);
          if (o && o.type !== f.type) d.problems.push(`${e.name}: ${f.name} is ${o.type}; the draft makes it ${f.type}, which an entity with records refuses.`);
        }
      }
      problems.push(...d.problems);
      diff.push(d);
    }
    const workflows = await this.s().db('workflows').where({ tenant_id: app.tenant_id }).select('id', 'name', 'workspace_id');
    const triggerChecks = triggers.map((t) => {
      const wf = (workflows as { id: string; name: string; workspace_id: string | null }[]).find((w) => w.name === t.workflow && (!w.workspace_id || !app.workspace_id || w.workspace_id === app.workspace_id));
      const ok = names.has(t.entity) && !!wf;
      return { ...t, workflowId: wf?.id ?? null, ok, problem: !names.has(t.entity) ? `trigger: there is no entity ${t.entity}.` : !wf ? `trigger: there is no workflow named ${t.workflow}; it is skipped.` : null };
    });
    return { diff, problems, triggers: triggerChecks, saved };
  }

  async draft(actor: Actor & { principal: Principal }, app: AppRow, input: z.infer<typeof modelDraftSchema>, label: Label) {
    const s = this.s();
    const p = actor.principal;
    const g = await s.guardrails.check({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, checkpoint: 'user-input', text: input.prompt, label, principal: p, source: { kind: 'app-draft', id: p.userId } });
    if (g.action === 'block' || g.action === 'require-approval') throw new HttpProblem(422, 'Description refused', `The description was refused by the content rules${g.reason ? `: ${g.reason}` : '.'}`);
    const existing = (await this.apps.entities(app)).map((e) => ({ name: e.name, fields: e.definition.fields.map((f) => `${f.name}:${f.type}`) }));
    const context = existing.length ? `\n\nThe app already has these entities (extend them or add to them; never rename): ${JSON.stringify(existing)}` : '';
    let text: string;
    try {
      text = await generate(s, { tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, profile: input.profile, system: SYSTEM + context, prompt: g.action === 'redact' ? g.text : input.prompt, label, principal: p, userId: p.userId, json: true, source: { kind: 'app-draft', id: p.userId } });
    } catch (err) {
      if (err instanceof HttpProblem) throw err;
      if (err instanceof ModelUnavailable) throw new HttpProblem(503, 'Model unavailable', err.message);
      throw new HttpProblem(503, 'Model unavailable', `The model could not be reached: ${(err as Error).message}`);
    }
    const obj = parseJsonObject(text);
    const parsed = modelApplySchema.safeParse({ entities: Array.isArray(obj.entities) ? obj.entities : [], triggers: Array.isArray(obj.triggers) ? obj.triggers : [] });
    const problems: string[] = [];
    let entities: ModelApply['entities'] = [];
    let triggers: ModelApply['triggers'] = [];
    if (!parsed.success) {
      problems.push(...parsed.error.issues.slice(0, 15).map((i) => `${i.path.join('.')}: ${i.message}`));
      // keep what parses on its own, so the designer can edit the rest
      for (const e of Array.isArray(obj.entities) ? obj.entities : []) {
        const one = draftEntitySchema.safeParse(e);
        if (one.success) entities.push(one.data);
      }
      for (const t of Array.isArray(obj.triggers) ? obj.triggers : []) {
        const one = draftTriggerSchema.safeParse(t);
        if (one.success) triggers.push(one.data);
      }
    } else {
      entities = parsed.data.entities;
      triggers = parsed.data.triggers;
    }
    const c = await this.check(app, entities, triggers);
    problems.push(...c.problems);
    await s.audit.append({ tenantId: p.tenantId, action: 'app.model.drafted', kind: 'admin', actor: actorFrom(p, actor.ip ?? null), target: { app: app.id, name: app.name, profile: input.profile }, label, detail: { entities: entities.length, triggers: triggers.length, valid: problems.length === 0, problems: problems.length }, traceId: actor.traceId ?? null });
    return { draft: { entities, triggers }, diff: c.diff, triggers: c.triggers.map((t) => ({ entity: t.entity, events: t.events, workflow: t.workflow, ok: t.ok, problem: t.problem })), valid: problems.length === 0, problems };
  }

  /** Accepts a draft: new entities created (in dependency order), existing ones extended, triggers added. */
  async apply(actor: Actor & { principal: Principal }, app: AppRow, input: ModelApply) {
    const s = this.s();
    const p = actor.principal;
    const c = await this.check(app, input.entities, input.triggers);
    if (c.problems.length) throw new HttpProblem(422, 'Draft not valid', c.problems[0]!, { extensions: { problems: c.problems } });
    const created: string[] = [];
    const updated: string[] = [];
    const unchanged: string[] = [];
    const existing = new Set((await this.apps.entities(app)).map((e) => e.name));
    // New entities whose references point at entities not yet created wait for them; a cycle is created without the
    // reference fields first, then completed.
    const pending = input.entities.filter((e) => !existing.has(e.name));
    const needs = (e: ModelApply['entities'][number]) => e.definition.fields.flatMap((f) => (f.type === 'reference' ? [f.entity] : f.type === 'lookup' && f.source === 'entity' && f.entity ? [f.entity] : [])).filter((n) => n !== e.name);
    for (let pass = 0; pending.length && pass <= input.entities.length; pass++) {
      for (let i = 0; i < pending.length; ) {
        const e = pending[i]!;
        if (needs(e).every((n) => existing.has(n))) {
          await this.apps.createEntity(actor, app.id, { name: e.name, ...(e.title ? { title: e.title } : {}), definition: e.definition });
          existing.add(e.name);
          created.push(e.name);
          pending.splice(i, 1);
        } else i++;
      }
    }
    if (pending.length) {
      const later: typeof pending = [];
      for (const e of pending) {
        const plain: EntityDefinition = { ...e.definition, fields: e.definition.fields.filter((f) => !(f.type === 'reference' || (f.type === 'lookup' && f.source === 'entity')) || existing.has((f as { entity?: string }).entity ?? '')) };
        if (!plain.fields.length) throw conflict(`${e.name} has only reference fields in a cycle; add a plain field.`);
        await this.apps.createEntity(actor, app.id, { name: e.name, ...(e.title ? { title: e.title } : {}), definition: plain });
        existing.add(e.name);
        created.push(e.name);
        later.push(e);
      }
      for (const e of later) await this.apps.updateEntity(actor, app.id, e.name, { definition: e.definition });
    }
    for (const e of input.entities) {
      if (created.includes(e.name)) continue;
      const row: EntityRow = (await this.apps.entityOf(app, e.name))!;
      const d = diffEntity(e.name, e.definition, row.definition);
      if (d.change === 'same') {
        unchanged.push(e.name);
        continue;
      }
      await this.apps.updateEntity(actor, app.id, e.name, { definition: mergeDefinition(row.definition, e.definition), ...(e.title ? { title: e.title } : {}) });
      updated.push(e.name);
    }
    const triggers: { entity: string; workflow: string; created: boolean; reason: string | null }[] = [];
    for (const t of c.triggers) {
      if (!t.ok) {
        triggers.push({ entity: t.entity, workflow: t.workflow, created: false, reason: t.problem });
        continue;
      }
      try {
        await this.apps.triggers.create(actor, app.id, { entity: t.entity, kind: 'record', events: t.events, workflow: t.workflowId! });
        triggers.push({ entity: t.entity, workflow: t.workflow, created: true, reason: null });
      } catch (err) {
        triggers.push({ entity: t.entity, workflow: t.workflow, created: false, reason: (err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message).slice(0, 200) });
      }
    }
    await s.audit.append({ tenantId: p.tenantId, action: 'app.model.applied', kind: 'admin', actor: actorFrom(p, actor.ip ?? null), target: { app: app.id, name: app.name }, label: app.label, detail: { created, updated, unchanged, triggers: triggers.filter((t) => t.created).length }, traceId: actor.traceId ?? null });
    return { created, updated, unchanged, triggers };
  }
}
