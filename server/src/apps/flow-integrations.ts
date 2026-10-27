import { isIP } from 'node:net';
import { labelRank, type Label } from '../authz/labels.js';
import { authorize, type Principal } from '../authz/policy.js';
import { tenantHostProblem } from '../integrations/hosts.js';
import type { Services } from '../services.js';
import { guardedByApproval, toolNeedsApproval, type WfGraph } from '../workflows/graph.js';
import { scriptNeedsApproval } from '../workflows/steps/kinds.js';
import type { FlowAction, FlowRow } from './flows.js';
import type { AppRow, EntityRow } from './service.js';

/*
 * The integration actions of app flows (migration 082_app_flow_integration): run a tool, run a script, ask an agent,
 * an AI step, a direct message and an HTTP request. Each compiles onto the existing workflow step kind (`tool`,
 * `script`, `agent`, `model`, `tool` with `messages.send`, `http`), so its publish checks and run-time guards are the
 * Workflows ones. What this module adds is checked when a flow is saved, in the flow's words, before the workflow is
 * written:
 *
 * - a tool, the messaging tool, an agent or a script must be callable from the flow's workspace by the designer;
 * - a write tool (or one that always asks first), and a script version whose reviewed tool writes, needs an approval
 *   action before it on every path: such a flow is refused, rather than pausing for an approval at run time;
 * - a tool, an agent and a profile must be cleared for the entity's label, which is the label every run carries;
 * - an HTTP request goes only to a host the tenant's list of allowed hosts names (the step itself also takes internal
 *   hosts on WORKFLOW_HTTP_HOSTS; a flow does not), with credentials as vault references (`flowProblems`).
 */

/** The built-in tool a message action calls. */
export const MESSAGE_TOOL = 'messages.send';

/** The host an HTTP action calls (lower case, no brackets), or null when the URL cannot be read. */
export function httpHostOf(url: string): string | null {
  try {
    return new URL(url.replace(/\{\{[^}]*\}\}/g, 'x')).hostname.replace(/^\[|\]$/g, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Published profiles of the tenant with the label they are cleared for (aliases followed). */
export async function publishedProfiles(s: Services, tenantId: string): Promise<{ name: string; label: Label; displayName: string | null }[]> {
  const rows = await s.gateway.repo.profiles(tenantId);
  const out: { name: string; label: Label; displayName: string | null }[] = [];
  for (const r of rows) {
    let t: (typeof rows)[number] | undefined = r;
    for (let i = 0; t?.alias_of && i < 5; i++) t = rows.find((x) => x.id === t!.alias_of);
    if (t && !t.alias_of && t.status === 'published' && r.status === 'published') out.push({ name: r.name, label: t.label, displayName: r.display_name ?? null });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

const fits = (ceiling: Label, label: Label) => labelRank(ceiling) >= labelRank(label);

/** Problems with the integration actions of a compiled flow, against what the designer may call here. */
export async function integrationProblems(s: Services, p: Principal, entity: EntityRow, actions: FlowAction[], graph: WfGraph): Promise<string[]> {
  const out: string[] = [];
  const label = entity.label;
  const scope = { tenantId: p.tenantId, workspaceId: p.workspaceId ?? null };
  let tools: Awaited<ReturnType<Services['workflows']['callableTools']>> | null = null;
  let callees: Awaited<ReturnType<Services['workflows']['callees']>> | null = null;
  let profiles: Awaited<ReturnType<typeof publishedProfiles>> | null = null;
  let hosts: Awaited<ReturnType<Services['integrations']['allowList']>> | undefined;
  for (const [i, a] of actions.entries()) {
    const where = `action ${i + 1} (${a.type})`;
    const id = `act${i + 1}`;
    const approvalFirst = 'put an approval action (with no run condition) before it, so a person approves the run first';
    if (a.type === 'tool' || a.type === 'message') {
      tools ??= await s.workflows.callableTools(p);
      const name = a.type === 'tool' ? a.tool : MESSAGE_TOOL;
      const t = tools.find((x) => x.name === name);
      if (!t) {
        out.push(a.type === 'tool' ? `${where}: ${name} is not a tool published to this workspace.` : `${where}: a message needs the built-in ${MESSAGE_TOOL} tool, which is not published to this workspace.`);
        continue;
      }
      if (!fits(t.label, label)) out.push(`${where}: ${name} takes data up to ${t.label}; this flow's runs carry ${label} data.`);
      if (toolNeedsApproval(t) && !guardedByApproval(graph, id)) out.push(`${where}: ${name} is a ${t.sideEffect} tool${t.confirm === 'always' ? ' that asks for confirmation' : ''}: ${approvalFirst}.`);
    } else if (a.type === 'script') {
      if (!authorize(p, 'scripts:run').allow) out.push(`${where}: a script action needs the scripts:run permission.`);
      const info = await s.scripts.refInfo(scope, a.script, a.version);
      if ('missing' in info) {
        out.push(`${where}: script ${a.script}${a.version ? ` version ${a.version}` : ''} ${info.missing}.`);
        continue;
      }
      if (labelRank(info.label) > labelRank(label)) out.push(`${where}: script ${info.name} is ${info.label}, above this flow's ${label} label.`);
      if (info.ceiling && !fits(info.ceiling, label)) out.push(`${where}: ${info.tool ?? info.name} takes data up to ${info.ceiling}; this flow's runs carry ${label} data.`);
      if (scriptNeedsApproval(info) && !guardedByApproval(graph, id)) out.push(`${where}: ${info.name} version ${info.version} is published as the ${info.sideEffect} tool ${info.tool ?? ''}: ${approvalFirst}.`);
    } else if (a.type === 'agent') {
      callees ??= await s.workflows.callees(p);
      const ag = callees.agents.find((x) => x.name === a.agent);
      if (!ag) out.push(`${where}: agent ${a.agent} is not published to this workspace.`);
      else if (!fits(ag.label, label)) out.push(`${where}: agent ${a.agent} is cleared up to ${ag.label}; this flow's runs carry ${label} data.`);
    } else if (a.type === 'ai') {
      profiles ??= await publishedProfiles(s, p.tenantId);
      const pr = profiles.find((x) => x.name === a.profile);
      if (!pr) out.push(`${where}: profile ${a.profile} is not published.`);
      else if (!fits(pr.label, label)) out.push(`${where}: profile ${a.profile} is cleared up to ${pr.label}; this flow's runs carry ${label} data. Pick a profile cleared for ${label}.`);
    } else if (a.type === 'http') {
      if (hosts === undefined) hosts = await s.integrations.allowList(p.tenantId);
      const host = httpHostOf(a.url);
      if (host && (!hosts || hosts.empty || tenantHostProblem(host, isIP(host) ? [host] : [], hosts))) out.push(`${where}: ${host} is not on this tenant's list of allowed hosts. A tenant admin adds it under Registry, Allowed hosts.`);
    } else if (a.type === 'decision') {
      // Sprint 46 (B-131): a published table at or below the flow's label, with the columns the action maps.
      const info = await s.decisions.refInfo(p.tenantId, a.table, a.version);
      if ('missing' in info) {
        out.push(`${where}: decision table ${a.table}${a.version ? ` version ${a.version}` : ''} ${info.missing}.`);
        continue;
      }
      if (labelRank(info.label) > labelRank(label)) out.push(`${where}: decision table ${info.name} is ${info.label}, above this flow's ${label} label.`);
      const cols = new Set(info.definition.inputs.map((c) => c.name));
      for (const k of Object.keys(a.inputs)) if (!cols.has(k)) out.push(`${where}: ${info.name} has no input column ${k}.`);
    }
  }
  return out;
}

/** The canvas's pickers: what the designer may call here, and the profiles cleared for `label`. */
export async function palette(s: Services, p: Principal, label: Label) {
  const tools = (await s.workflows.callableTools(p)).map((t) => ({ name: t.name, version: t.version, description: t.description, impl: t.impl, sideEffect: t.sideEffect, confirm: t.confirm, label: t.label, status: t.status, inputSchema: t.inputSchema, needsApproval: toolNeedsApproval(t), fits: fits(t.label, label) }));
  const callees = await s.workflows.callees(p);
  const profiles = (await publishedProfiles(s, p.tenantId)).filter((x) => fits(x.label, label));
  return {
    label,
    tools,
    scripts: callees.scripts,
    agents: callees.agents.map((a) => ({ name: a.name, version: a.version, description: a.description, label: a.label, fits: fits(a.label, label) })),
    profiles,
    messaging: tools.some((t) => t.name === MESSAGE_TOOL),
    canRunScripts: authorize(p, 'scripts:run').allow,
    // Sprint 46 (B-131): published decision tables the caller may read, with their columns.
    decisions: (await s.decisions.list(p)).filter((t) => t.publishedVersion != null).map((t) => ({ name: t.name, title: t.title, label: t.label, version: t.publishedVersion, hitPolicy: t.hitPolicy, fits: fits(t.label, label) }))
  };
}

/** The run input of a webhook flow: the verified payload, under `payload`. */
export function webhookInput(app: Pick<AppRow, 'name'>, entity: Pick<EntityRow, 'name'>, flow: Pick<FlowRow, 'id' | 'name'>, payload: Record<string, unknown>, receivedAt = new Date().toISOString()): Record<string, unknown> {
  return { event: 'webhook', app: app.name, entity: entity.name, flow: flow.name, payload, receivedAt, trigger: { id: flow.id, depth: 1 } };
}
