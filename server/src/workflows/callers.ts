import { clears, type Label } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import type { Services } from '../services.js';
import { emptyGraph, graphSchema, type WfGraph } from './graph.js';

/*
 * Sprint 32e (B-3910): what starts a workflow, for the console's "Triggers and callers" tab. One read over what
 * already exists elsewhere: the app triggers that name the workflow (1.4.0, B-2206), the registry tools it is
 * published as (B-1006), the other workflows whose sub, map or loop steps run it (B-3901, B-3905), the plugins granted
 * `call:workflow` (B-2003), and when each kind of start last happened, from the run history the caller may see. The
 * workflow's own event or schedule trigger is `GET /workflows/:id/triggers` (B-3903).
 */

type Json = Record<string, unknown>;
const parse = <T>(v: unknown, fallback: T): T => {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v as T;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
const num = (v: unknown) => (v == null ? null : Number(v));

/** The kind of start a run's `trigger` column records. */
export function startKind(trigger: string): string {
  const k = trigger.split(':')[0]!;
  return ['manual', 'api', 'record', 'schedule', 'event', 'plugin', 'workflow', 'tool', 'replay'].includes(k) ? k : 'manual';
}

/** Steps of a graph that run the workflow `id` (or `name`): sub-workflow steps and map or loop items. */
function callingSteps(g: WfGraph, id: string, name: string): { id: string; title: string; kind: string; version: number | null }[] {
  return g.nodes
    .filter((n) => (n.kind === 'sub' || n.kind === 'map' || n.kind === 'loop') && (n.config.workflow === id || n.config.workflow === name))
    .map((n) => ({ id: n.id, title: n.title, kind: n.kind, version: typeof n.config.version === 'number' ? n.config.version : null }));
}

export async function workflowCallers(s: Services, p: Principal, ref: string) {
  const w = await s.workflows.workflow(p, ref);
  const db = s.db;
  const manage = effectivePermissions(p).has('workflows:manage');

  // App triggers (record and schedule) that start this workflow, in apps the caller is cleared for.
  const triggers = (await db('app_triggers as t')
    .join('apps as a', 'a.id', 't.app_id')
    .leftJoin('app_entities as e', 'e.id', 't.entity_id')
    .where({ 't.tenant_id': p.tenantId, 't.workflow_id': w.id })
    .select('t.id', 't.kind', 't.events', 't.cron', 't.owner_id', 't.enabled', 't.next_run_at', 't.last_run_at', 't.last_run_id', 't.last_result', 'a.id as app_id', 'a.name as app_name', 'a.title as app_title', 'a.label as app_label', 'e.name as entity_name', 'e.title as entity_title')) as Json[];
  const visibleTriggers = triggers.filter((t) => clears(p.clearance, t.app_label as Label));

  // Other workflows in the same workspace whose draft or published version runs this one.
  const scope = w.workspace_id ? { tenant_id: p.tenantId, workspace_id: w.workspace_id } : { tenant_id: p.tenantId, workspace_id: null };
  const others = ((await db('workflows').where(scope).whereNot({ id: w.id }).select('id', 'name', 'label', 'draft', 'published_version')) as Json[]).filter((o) => clears(p.clearance, o.label as Label));
  const workflows: Json[] = [];
  for (const o of others) {
    const draft = graphSchema.safeParse(parse(o.draft, emptyGraph()));
    const steps = new Map<string, Json>();
    if (draft.success) for (const st of callingSteps(draft.data, w.id, w.name)) steps.set(st.id, { ...st, in: 'draft' });
    const pv = num(o.published_version);
    if (pv) {
      const v = (await db('workflow_versions').where({ workflow_id: o.id, version: pv }).first('graph')) as Json | undefined;
      const g = graphSchema.safeParse(parse(v?.graph, emptyGraph()));
      if (g.success) for (const st of callingSteps(g.data, w.id, w.name)) steps.set(st.id, { ...st, in: steps.has(st.id) ? 'published and draft' : 'published' });
    }
    for (const st of steps.values()) workflows.push({ workflowId: o.id, workflow: o.name, label: o.label, publishedVersion: pv, step: st.id, stepTitle: st.title, kind: st.kind, version: st.version, in: st.in });
  }

  // Registry tools the workflow is published as (agents and chat call them).
  const tools = (await s.registry.workflowEntries(p.tenantId, w.id)).map((e) => ({ id: e.id, name: e.name, version: e.version, status: e.status, sideEffect: e.side_effect, label: e.label, workflowVersion: Number(e.definition.version) }));

  // Plugins that may start any published workflow of the tenant.
  const plugins = ((await db('plugins').where({ tenant_id: p.tenantId }).whereIn('state', ['installed', 'enabled']).select('id', 'plugin_key', 'name', 'version', 'state', 'max_label', 'installed_by', 'granted')) as Json[])
    .filter((x) => parse<string[]>(x.granted, []).includes('call:workflow'))
    .map((x) => ({ id: x.id, key: x.plugin_key, name: x.name, version: x.version, state: x.state, maxLabel: x.max_label, installedBy: (x.installed_by as string | null) ?? null }));

  // When each kind of start last happened, from the runs the caller may see (as the run history shows them).
  const q = db('workflow_runs').where({ tenant_id: p.tenantId, workflow_id: w.id }).whereNot({ mode: 'dry' });
  if (!manage) q.andWhere({ created_by: p.userId });
  const runs = ((await q.orderBy('created_at', 'desc').limit(500).select('id', 'trigger', 'label', 'state', 'created_at')) as Json[]).filter((r) => clears(p.clearance, r.label as Label));
  const last: Record<string, { runId: string; at: number; state: string; trigger: string; count: number }> = {};
  for (const r of runs) {
    const k = startKind(String(r.trigger));
    if (last[k]) last[k].count++;
    else last[k] = { runId: String(r.id), at: Number(r.created_at), state: String(r.state), trigger: String(r.trigger), count: 1 };
  }

  const owners = [...new Set([...visibleTriggers.map((t) => String(t.owner_id)), ...plugins.map((x) => x.installedBy).filter((x): x is string => !!x)])];
  const names = owners.length ? new Map(((await db('users').whereIn('id', owners).select('id', 'display_name', 'username')) as Json[]).map((u) => [String(u.id), String(u.display_name || u.username)])) : new Map<string, string>();

  return {
    workflowId: w.id,
    appTriggers: visibleTriggers.map((t) => ({
      id: t.id,
      kind: t.kind,
      app: t.app_id,
      appName: t.app_name,
      appTitle: t.app_title,
      entity: t.entity_name ?? null,
      entityTitle: t.entity_title ?? null,
      events: t.events ? String(t.events).split(',').map((x) => x.trim()).filter(Boolean) : [],
      cron: t.cron ?? null,
      ownerId: t.owner_id,
      ownerName: names.get(String(t.owner_id)) ?? null,
      enabled: !!t.enabled,
      nextRunAt: num(t.next_run_at),
      lastRunAt: num(t.last_run_at),
      lastRunId: t.last_run_id ?? null,
      lastResult: t.last_result ?? null
    })),
    workflows,
    tools,
    plugins: plugins.map((x) => ({ ...x, installedByName: x.installedBy ? (names.get(x.installedBy) ?? null) : null })),
    lastRuns: last
  };
}
