import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import type { Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { HttpProblem } from '../http/problem.js';
import type { Services } from '../services.js';
import { graphSchema, NODE_KINDS } from '../workflows/graph.js';
import { generate, ModelUnavailable, parseJsonObject } from './ai.js';
import { checkDefinition, entityDefinitionSchema, FIELD_TYPES, nameSchema } from './schema.js';
import type { Actor } from './service.js';

/*
 * Natural-language drafts (B-2207): a local model, through the gateway and a published profile, turns a description
 * into an entity definition or a workflow graph. A draft is only a suggestion: it is validated with the same schemas
 * and checks as a saved one, returned with its problems, and never saved. The description passes the `user-input`
 * guardrail checkpoint first.
 */

const ENTITY_SYSTEM = `You design data entities for a low-code app. Answer with one JSON object and nothing else:
{"name": "lower_snake_case", "title": "Title", "definition": {"fields": [{"name": "lower_snake_case", "type": one of ${FIELD_TYPES.filter((t) => t !== 'ai' && t !== 'formula').map((t) => `"${t}"`).join(', ')}, "title": "Label", "required": false, "indexed": false}], "states": optional {"initial": "new", "states": [{"name": "new"}], "transitions": [{"from": ["new"], "to": "done"}]}}}
Enum fields have "options": [{"value": "..."}]. Reference fields have "entity": the referenced entity's name. Keep names short.`;

const FLOW_SYSTEM = `You design workflow graphs. Answer with one JSON object and nothing else:
{"name": "lower-case-name", "graph": {"nodes": [{"id": "trigger", "kind": "trigger", "title": "Trigger", "config": {"source": "record"}}], "edges": [{"from": "trigger", "to": "next"}]}}
Node kinds: ${NODE_KINDS.join(', ')}. A record node has config {"action": "create" | "update" | "transition", "app": "...", "entity": "...", "record": "{{input.record.id}}", "values": {"field": "{{input.record.values.field}}"}, "to": "state"}. Exactly one trigger, no cycles.`;

export const draftSchema = z.object({ kind: z.enum(['entity', 'workflow']), prompt: z.string().trim().min(3).max(4000), profile: z.string().min(1).max(63) }).strict();

export async function draft(s: Services, actor: Actor & { principal: Principal }, input: z.infer<typeof draftSchema>, label: Label) {
  const p = actor.principal;
  const g = await s.guardrails.check({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, checkpoint: 'user-input', text: input.prompt, label, principal: p, source: { kind: 'app-draft', id: p.userId } });
  if (g.action === 'block' || g.action === 'require-approval') throw new HttpProblem(422, 'Description refused', `The description was refused by the content rules${g.reason ? `: ${g.reason}` : '.'}`);
  let text: string;
  try {
    text = await generate(s, { tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, profile: input.profile, system: input.kind === 'entity' ? ENTITY_SYSTEM : FLOW_SYSTEM, prompt: g.action === 'redact' ? g.text : input.prompt, label, principal: p, userId: p.userId, json: true, source: { kind: 'app-draft', id: p.userId } });
  } catch (err) {
    if (err instanceof HttpProblem) throw err;
    if (err instanceof ModelUnavailable) throw new HttpProblem(503, 'Model unavailable', err.message);
    throw new HttpProblem(503, 'Model unavailable', `The model could not be reached: ${(err as Error).message}`);
  }
  const obj = parseJsonObject(text);
  const problems: string[] = [];
  let out: Record<string, unknown>;
  if (input.kind === 'entity') {
    const name = nameSchema.safeParse(obj.name);
    const def = entityDefinitionSchema.safeParse(obj.definition);
    if (!name.success) problems.push('name: not a valid entity name');
    if (!def.success) problems.push(...def.error.issues.slice(0, 10).map((i) => `definition.${i.path.join('.')}: ${i.message}`));
    else problems.push(...checkDefinition(def.data, new Set([String(obj.name ?? ''), ...def.data.fields.flatMap((f) => (f.type === 'reference' ? [f.entity] : []))])));
    out = { name: name.success ? name.data : null, title: typeof obj.title === 'string' ? obj.title.slice(0, 200) : null, definition: def.success ? def.data : (obj.definition ?? null) };
  } else {
    const graph = graphSchema.safeParse(obj.graph);
    if (!graph.success) problems.push(...graph.error.issues.slice(0, 10).map((i) => `graph.${i.path.join('.')}: ${i.message}`));
    else {
      const v = await s.workflows.validate({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null }, graph.data, label);
      problems.push(...v.errors.map((e) => e.message));
    }
    out = { name: typeof obj.name === 'string' ? obj.name.slice(0, 100) : null, graph: graph.success ? graph.data : (obj.graph ?? null) };
  }
  await s.audit.append({ tenantId: p.tenantId, action: 'app.draft.created', kind: 'admin', actor: actorFrom(p, actor.ip ?? null), target: { kind: input.kind, profile: input.profile }, label, detail: { valid: problems.length === 0, problems: problems.length }, traceId: actor.traceId ?? null });
  return { kind: input.kind, draft: out, valid: problems.length === 0, problems };
}
