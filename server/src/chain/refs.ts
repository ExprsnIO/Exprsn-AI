import { json, type Db } from '../db/knex.js';
import { labelRank, type Label } from '../authz/labels.js';
import type { EntryRow, RegistryService } from '../registry/service.js';
import { skillNames } from '../registry/skills.js';
import { emptyGraph, graphSchema, type WfGraph } from '../workflows/graph.js';
import { refsOf } from '../workflows/steps/env.js';

/*
 * Chain checks at publish (B-4105): the reference graph across agents, skills, tools and workflows, built from the
 * registry and the published workflow versions of the tenant.
 *
 * Edges, by how they are taken at run time:
 * - optional, a model's choice: an agent's delegates (`agents`), workflows (`workflows`) and tools, a skill's tools;
 * - closure: a skill's sub-skills (each skill loads once, so a loop of them ends by itself);
 * - mandatory, taken whenever the step runs: an agent's skills, a workflow's sub-workflow, map and loop workflows, agent
 *   steps, model-step skills and tool steps, and a workflow tool's workflow.
 *
 * At publish a cycle made only of mandatory edges cannot terminate and is refused; a cycle through an optional edge
 * is allowed with a warning (the chain's depth and budgets bound it at run time); a cycle of sub-skills is allowed.
 * An agent's delegates and workflows must be published, and none may carry data above the agent's ceiling (a
 * delegate's ceiling, a workflow's label), since what they return reaches the agent. "Used by" lists what references
 * an entry or a workflow, and retiring one that something published still uses is refused.
 */

export type RefKind = 'agent' | 'skill' | 'tool' | 'workflow';
export type RefVia = 'delegate' | 'handoff' | 'workflow' | 'tool' | 'skill' | 'sub-skill' | 'skill-tool' | 'sub-workflow' | 'agent-step' | 'model-skill' | 'tool-step' | 'workflow-tool';

const OPTIONAL: ReadonlySet<RefVia> = new Set(['delegate', 'handoff', 'workflow', 'tool', 'skill-tool']);
const CLOSURE: ReadonlySet<RefVia> = new Set(['sub-skill']);

export interface RefEdge {
  kind: RefKind;
  /** A registry name, or a workflow's name or id. */
  name: string;
  via: RefVia;
}

export interface RefProblem {
  code: 'cycle' | 'ceiling' | 'unpublished';
  message: string;
  /** For cycles: the references around it, `kind:name` from the entry being checked. */
  path?: string[];
}

export interface RefCheck {
  problems: RefProblem[];
  warnings: RefProblem[];
}

export interface UsedBy {
  kind: RefKind;
  /** The registry entry id, or the workflow id. */
  id: string;
  name: string;
  version: string | null;
  status: string;
  via: RefVia;
  /** True when the referrer is published (or deprecated): it may run and reach the entry now. */
  live: boolean;
}

interface Resolved {
  key: string;
  kind: RefKind;
  name: string;
  label: Label;
  edges: RefEdge[];
}

interface WfRow {
  id: string;
  name: string;
  label: Label;
  workspace_id: string | null;
  published_version: number | null;
}

/** The references an agent or skill definition (or a tool backed by a workflow) makes. */
export function entryEdges(e: Pick<EntryRow, 'kind' | 'impl' | 'definition'>): RefEdge[] {
  const out: RefEdge[] = [];
  if (e.kind === 'agent') {
    for (const n of skillNames(e, 'tools')) out.push({ kind: 'tool', name: n, via: 'tool' });
    for (const n of skillNames(e, 'skills')) out.push({ kind: 'skill', name: n, via: 'skill' });
    for (const n of listOf(e.definition.agents)) out.push({ kind: 'agent', name: n, via: 'delegate' });
    // 1.6.0 (B-7801): a specialist the agent may hand the conversation to is referenced like a delegate.
    for (const n of listOf(e.definition.handoffs)) if (!listOf(e.definition.agents).includes(n)) out.push({ kind: 'agent', name: n, via: 'handoff' });
    for (const n of listOf(e.definition.workflows)) out.push({ kind: 'workflow', name: n, via: 'workflow' });
  } else if (e.kind === 'skill') {
    for (const n of skillNames(e, 'skills')) out.push({ kind: 'skill', name: n, via: 'sub-skill' });
    for (const n of skillNames(e, 'tools')) out.push({ kind: 'tool', name: n, via: 'skill-tool' });
  } else if (e.impl === 'workflow' && typeof e.definition.workflowId === 'string') out.push({ kind: 'workflow', name: e.definition.workflowId, via: 'workflow-tool' });
  return out;
}

/** The references a workflow graph's steps make. */
export function workflowEdges(g: WfGraph): RefEdge[] {
  const r = refsOf(g);
  const out: RefEdge[] = [];
  for (const w of r.workflows) out.push({ kind: 'workflow', name: w.ref, via: 'sub-workflow' });
  for (const a of r.agents) out.push({ kind: 'agent', name: a, via: 'agent-step' });
  for (const s of r.skills) out.push({ kind: 'skill', name: s, via: 'model-skill' });
  for (const t of r.tools) out.push({ kind: 'tool', name: t, via: 'tool-step' });
  for (const n of g.nodes) if (n.kind === 'tool' && String(n.config.tool ?? '').trim()) out.push({ kind: 'tool', name: String(n.config.tool).trim(), via: 'tool-step' });
  return dedupe(out);
}

const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : []);
const dedupe = (edges: RefEdge[]) => {
  const seen = new Set<string>();
  return edges.filter((e) => {
    const k = `${e.kind}:${e.name}:${e.via}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};
const KIND_WORD: Record<RefKind, string> = { agent: 'agent', skill: 'skill', tool: 'tool', workflow: 'workflow' };
const VIA_WORD: Record<RefVia, string> = { delegate: 'delegates to', handoff: 'hands the conversation to', workflow: 'starts', tool: 'calls', skill: 'loads', 'sub-skill': 'needs', 'skill-tool': 'needs', 'sub-workflow': 'runs', 'agent-step': 'runs', 'model-skill': 'loads', 'tool-step': 'calls', 'workflow-tool': 'runs' };

/** At most this many references are followed per check (a large registry is checked in bounded time). */
const MAX_VISITS = 400;

export class ChainRefs {
  constructor(
    private readonly db: Db,
    private readonly registry: Pick<RegistryService, 'list'>
  ) {}

  /** The newest callable version of a registry name in the tenant (published first, then deprecated). */
  private async entry(tenantId: string, kind: Exclude<RefKind, 'workflow'>, name: string, cache: Map<string, EntryRow | null>): Promise<EntryRow | null> {
    const k = `${kind}:${name}`;
    if (cache.has(k)) return cache.get(k)!;
    const rows = (await this.registry.list(tenantId, { kind })).filter((e) => e.name === name && (e.status === 'published' || e.status === 'deprecated') && e.approved_hash === e.schema_hash);
    const e = rows.find((x) => x.status === 'published') ?? rows[0] ?? null;
    cache.set(k, e);
    return e;
  }

  private async workflow(tenantId: string, workspaceId: string | null | undefined, ref: string): Promise<WfRow | null> {
    const q = this.db('workflows').where({ tenant_id: tenantId }).andWhere((x) => x.where({ id: ref }).orWhere({ name: ref }));
    if (workspaceId !== undefined) q.andWhere({ workspace_id: workspaceId });
    const r = (await q.first('id', 'name', 'label', 'workspace_id', 'published_version')) as WfRow | undefined;
    return r ? { ...r, published_version: r.published_version == null ? null : Number(r.published_version) } : null;
  }

  private async publishedGraph(w: WfRow): Promise<WfGraph | null> {
    if (w.published_version == null) return null;
    const v = (await this.db('workflow_versions').where({ workflow_id: w.id, version: w.published_version }).first('graph')) as { graph: string } | undefined;
    const g = graphSchema.safeParse(json(v?.graph, emptyGraph()));
    return g.success ? g.data : null;
  }

  /** A reference, resolved to what it would run now, or null when nothing callable is there. */
  private async resolve(tenantId: string, from: { workspaceId: string | null }, e: RefEdge, cache: Map<string, EntryRow | null>): Promise<Resolved | null> {
    if (e.kind === 'workflow') {
      const w = await this.workflow(tenantId, e.via === 'workflow-tool' ? undefined : from.workspaceId, e.name);
      const g = w ? await this.publishedGraph(w) : null;
      if (!w || !g) return null;
      return { key: `workflow:${w.id}`, kind: 'workflow', name: w.name, label: w.label, edges: workflowEdges(g) };
    }
    const entry = await this.entry(tenantId, e.kind, e.name, cache);
    if (!entry) return null;
    return { key: `${e.kind}:${entry.name}`, kind: e.kind, name: entry.name, label: entry.label, edges: entryEdges(entry) };
  }

  /**
   * The chain checks for something about to be published: `start` is the agent or skill entry (its definition as
   * submitted) or the workflow (its graph). Unpublished delegates, skills and workflows of an agent or skill, ceilings
   * and cycles; a workflow's own unpublished references are its validation's `unavailable` errors.
   */
  async check(tenantId: string, start: { kind: RefKind; name: string; id?: string; label: Label; workspaceId: string | null; edges: RefEdge[] }): Promise<RefCheck> {
    const out: RefCheck = { problems: [], warnings: [] };
    const cache = new Map<string, EntryRow | null>();
    const startKey = start.kind === 'workflow' ? `workflow:${start.id ?? start.name}` : `${start.kind}:${start.name}`;
    const display = new Map<string, string>([[startKey, start.name]]);
    const label = (k: string) => `${k.slice(0, k.indexOf(':'))} ${display.get(k) ?? k.slice(k.indexOf(':') + 1)}`;

    // First hop: what the agent or skill names must be callable, and what returns data must stay within its ceiling.
    const first: { edge: RefEdge; to: Resolved | null }[] = [];
    for (const edge of start.edges) first.push({ edge, to: await this.resolve(tenantId, { workspaceId: start.workspaceId }, edge, cache) });
    if (start.kind !== 'workflow') {
      for (const { edge, to } of first) {
        if (edge.kind === 'tool') continue; // tools have their own check ("Referenced tools published")
        if (!to) out.problems.push({ code: 'unpublished', message: `${KIND_WORD[edge.kind]} ${edge.name} is not published${edge.kind === 'workflow' ? ' in this workspace' : ''}` });
        else if ((edge.via === 'delegate' || edge.via === 'handoff' || edge.via === 'workflow') && labelRank(to.label) > labelRank(start.label)) out.problems.push({ code: 'ceiling', message: `${KIND_WORD[edge.kind]} ${to.name} handles ${to.label} data, above this agent's ceiling (${start.label}); what it returns would reach the agent` });
      }
    }

    // Cycles: depth-first over what each reference would run now, from the entry being published.
    const seenCycles = new Set<string>();
    const onStack: string[] = [startKey];
    const vias: RefVia[] = [];
    const done = new Set<string>();
    let visits = 0;
    const record = (toKey: string, via: RefVia) => {
      const i = onStack.indexOf(toKey);
      const keys = onStack.slice(i);
      const edges = [...vias.slice(i), via];
      const id = [...keys].sort().join('|');
      if (seenCycles.has(id)) return;
      seenCycles.add(id);
      const words = keys.map((k, j) => `${label(k)} ${VIA_WORD[edges[j]!]}`).join(' ') + ` ${label(toKey)}`;
      if (edges.every((v) => CLOSURE.has(v))) return out.warnings.push({ code: 'cycle', message: `${words}: each skill loads once, so the closure ends`, path: [...keys, toKey] });
      if (edges.some((v) => OPTIONAL.has(v))) return out.warnings.push({ code: 'cycle', message: `${words}: a model chooses each call, so the cycle can end; CHAIN_MAX_DEPTH and the root's budgets bound it`, path: [...keys, toKey] });
      return out.problems.push({ code: 'cycle', message: `${words}: every step of the cycle always runs, so it cannot terminate`, path: [...keys, toKey] });
    };
    const walk = async (from: { workspaceId: string | null }, edges: RefEdge[]): Promise<void> => {
      for (const edge of edges) {
        if (visits++ > MAX_VISITS) return;
        const to = await this.resolve(tenantId, from, edge, cache);
        if (!to) continue;
        if (!display.has(to.key)) display.set(to.key, to.name);
        if (onStack.includes(to.key)) {
          record(to.key, edge.via);
          continue;
        }
        if (done.has(to.key)) continue;
        onStack.push(to.key);
        vias.push(edge.via);
        const ws = to.kind === 'workflow' ? ((await this.workflow(tenantId, undefined, to.key.slice('workflow:'.length)))?.workspace_id ?? null) : from.workspaceId;
        await walk({ workspaceId: ws }, to.edges);
        onStack.pop();
        vias.pop();
        done.add(to.key);
      }
    };
    await walk({ workspaceId: start.workspaceId }, start.edges);
    return out;
  }

  /** The check for a registry entry, as one more automated check (`Chain references`). */
  async checkEntry(e: EntryRow): Promise<{ name: string; ok: boolean; detail: string; warnings: string[] }> {
    const r = await this.check(e.tenant_id ?? '', { kind: e.kind, name: e.name, label: e.label, workspaceId: e.workspace_id, edges: entryEdges(e) });
    const ok = !r.problems.length;
    return {
      name: 'Chain references',
      ok,
      detail: ok ? (r.warnings.length ? `References resolve. ${r.warnings.map((w) => w.message[0]!.toUpperCase() + w.message.slice(1)).join('. ')}.` : 'Every delegate, skill and workflow it names is published, within its ceiling, and no cycle cannot terminate.') : `${r.problems.map((p) => p.message[0]!.toUpperCase() + p.message.slice(1)).join('. ')}.`,
      warnings: r.warnings.map((w) => w.message)
    };
  }

  /**
   * What references a registry name or a workflow in the tenant: agents and skills (not retired), workflow tools,
   * and workflows whose draft or published version names it. `live` marks referrers that may run now.
   */
  async usedBy(tenantId: string, target: { kind: RefKind; name: string; id?: string }): Promise<UsedBy[]> {
    const names = new Set([target.name, ...(target.id ? [target.id] : [])]);
    const out: UsedBy[] = [];
    for (const e of (await this.registry.list(tenantId)).filter((x) => x.tenant_id === tenantId && x.status !== 'retired')) {
      for (const edge of entryEdges(e)) {
        if (edge.kind !== target.kind || !names.has(edge.name)) continue;
        out.push({ kind: e.kind, id: e.id, name: e.name, version: e.version, status: e.status, via: edge.via, live: e.status === 'published' || e.status === 'deprecated' });
      }
    }
    const wfs = (await this.db('workflows').where({ tenant_id: tenantId }).select('id', 'name', 'label', 'workspace_id', 'published_version', 'draft')) as (WfRow & { draft: string })[];
    for (const w of wfs) {
      if (target.kind === 'workflow' && target.id === w.id) continue;
      const pv = w.published_version == null ? null : Number(w.published_version);
      const published = pv != null ? await this.publishedGraph({ ...w, published_version: pv }) : null;
      const draft = graphSchema.safeParse(json(w.draft, emptyGraph()));
      const hits = new Map<RefVia, boolean>();
      for (const [g, live] of [[published, true], [draft.success ? draft.data : null, false]] as const) {
        if (!g) continue;
        for (const edge of workflowEdges(g)) if (edge.kind === target.kind && names.has(edge.name)) hits.set(edge.via, (hits.get(edge.via) ?? false) || live);
      }
      for (const [via, live] of hits) out.push({ kind: 'workflow', id: w.id, name: w.name, version: pv == null ? null : String(pv), status: live ? 'published' : 'draft', via, live });
    }
    return out;
  }
}
