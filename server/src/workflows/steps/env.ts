import { json, type Db } from '../../db/knex.js';
import type { Label } from '../../authz/labels.js';
import type { RegistryScope, RegistryService } from '../../registry/service.js';
import { emptyGraph, graphSchema, type PortSchema, type WfGraph } from '../graph.js';
import { isStepKind, STEP_KINDS, type AgentRefInfo, type ScriptRefInfo, type SkillRefInfo, type StepRefs, type WorkflowRefInfo } from './kinds.js';
import type { ScriptStepRunner } from './host.js';
import { DecisionService } from '../../decisions/service.js';
import type { DecisionRefInfo } from './kinds.js';

/*
 * The validation environment for the Workflows 2 kinds (Sprint 32): the workflows sub steps and items run, the agents
 * agent steps run and the skills model steps load, as seen from the workflow's workspace, resolved once per
 * validation. Tool names the new kinds use are returned for the service's own tool lookup.
 */

type Missing = { missing: string };

export interface StepEnv {
  tools: string[];
  workflow(ref: string, version?: number): WorkflowRefInfo | Missing | undefined;
  agent(name: string): AgentRefInfo | Missing | undefined;
  skill(name: string): SkillRefInfo | Missing | undefined;
  script(ref: string, version?: number): ScriptRefInfo | Missing | undefined;
  /** Sprint 46 (B-131): published decision tables of the tenant. */
  decision(ref: string, version?: number): DecisionRefInfo | Missing | undefined;
}

export function refsOf(g: WfGraph): Required<StepRefs> & { skills: string[] } {
  const out = { workflows: [] as { ref: string; version?: number }[], agents: [] as string[], tools: [] as string[], skills: [] as string[], scripts: [] as { ref: string; version?: number }[], decisions: [] as { ref: string; version?: number }[] };
  for (const n of g.nodes) {
    if (n.kind === 'model' && Array.isArray(n.config.skills)) out.skills.push(...n.config.skills.map(String));
    if (!isStepKind(n.kind)) continue;
    const def = STEP_KINDS[n.kind] as { refs?: (c: Record<string, unknown>) => StepRefs; config: { safeParse(v: unknown): { success: boolean; data?: unknown } } };
    const r = def.config.safeParse(n.config);
    if (!r.success || !def.refs) continue;
    const x = def.refs(r.data as Record<string, unknown>);
    out.workflows.push(...(x.workflows ?? []));
    out.agents.push(...(x.agents ?? []));
    out.tools.push(...(x.tools ?? []));
    out.scripts.push(...(x.scripts ?? []));
    out.decisions.push(...(x.decisions ?? []));
  }
  return out;
}

const key = (ref: string, version?: number) => `${ref}@${version ?? ''}`;

export async function stepEnv(db: Db, registry: RegistryService, scope: RegistryScope, g: WfGraph, scriptRunner?: ScriptStepRunner | null): Promise<StepEnv> {
  const refs = refsOf(g);
  const workflows = new Map<string, WorkflowRefInfo | Missing>();
  for (const w of refs.workflows) {
    const k = key(w.ref, w.version);
    if (workflows.has(k)) continue;
    const q = db('workflows').where({ tenant_id: scope.tenantId, workspace_id: scope.workspaceId ?? null }).andWhere((x) => x.where({ id: w.ref }).orWhere({ name: w.ref }));
    const row = (await q.first()) as { id: string; name: string; label: Label; published_version: number | null } | undefined;
    if (!row) {
      workflows.set(k, { missing: 'is not a workflow in this workspace' });
      continue;
    }
    const version = w.version ?? (row.published_version == null ? null : Number(row.published_version));
    if (version == null) {
      workflows.set(k, { missing: 'has no published version' });
      continue;
    }
    const v = (await db('workflow_versions').where({ workflow_id: row.id, version }).first()) as { graph: string } | undefined;
    if (!v) {
      workflows.set(k, { missing: `has no published version ${version}` });
      continue;
    }
    const graph = graphSchema.parse(json(v.graph, emptyGraph()));
    const trigger = graph.nodes.find((n) => n.kind === 'trigger');
    workflows.set(k, { id: row.id, name: row.name, label: row.label, version, input: (trigger?.output as PortSchema | undefined) ?? null });
  }
  const agents = new Map<string, AgentRefInfo | Missing>();
  for (const name of new Set(refs.agents)) {
    const e = await registry.resolve(scope, name, 'agent');
    if (e) agents.set(name, { name: e.name, version: e.version, label: e.label });
    else agents.set(name, { missing: (await registry.referenceStatus(scope.tenantId, [name]))[0]?.status ? 'is not published to this workspace' : 'is not in the registry' });
  }
  const skills = new Map<string, SkillRefInfo | Missing>();
  for (const name of new Set(refs.skills)) {
    const e = await registry.resolve(scope, name, 'skill');
    if (e) skills.set(name, { name: e.name, version: e.version, label: e.label, tools: Array.isArray(e.definition.tools) ? (e.definition.tools as unknown[]).map(String) : [] });
    else skills.set(name, { missing: (await registry.referenceStatus(scope.tenantId, [name]))[0]?.status ? 'is not published to this workspace' : 'is not in the registry' });
  }
  const scripts = new Map<string, ScriptRefInfo | Missing>();
  for (const x of refs.scripts) {
    const k = key(x.ref, x.version);
    if (scripts.has(k)) continue;
    scripts.set(k, scriptRunner ? await scriptRunner.refInfo({ tenantId: scope.tenantId, workspaceId: scope.workspaceId ?? null }, x.ref, x.version) : { missing: 'cannot run: scripts are not available on this server' });
  }
  const decisions = new Map<string, DecisionRefInfo | Missing>();
  const tables = new DecisionService(db);
  for (const x of refs.decisions) {
    const k = key(x.ref, x.version);
    if (decisions.has(k)) continue;
    const info = await tables.refInfo(scope.tenantId, x.ref, x.version);
    decisions.set(k, 'missing' in info ? info : { id: info.id, name: info.name, label: info.label, version: info.version, hitPolicy: info.definition.hitPolicy, aggregation: info.definition.aggregation ?? null, inputs: info.definition.inputs.map((c) => ({ name: c.name, type: c.type })), outputs: info.definition.outputs.map((c) => ({ name: c.name, type: c.type })) });
  }
  return { decision: (ref, version) => decisions.get(key(ref, version)), tools: refs.tools, workflow: (ref, version) => workflows.get(key(ref, version)), agent: (name) => agents.get(name), skill: (name) => skills.get(name), script: (ref, version) => scripts.get(key(ref, version)) };
}
