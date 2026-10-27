import { ulid } from 'ulid';
import { actorFrom } from '../../audit/chain.js';
import { clears, isLabel, labelRank, type Label } from '../../authz/labels.js';
import { authorize, type Principal } from '../../authz/policy.js';
import type { Permission } from '../../authz/permissions.js';
import { canonicalJson, sha256 } from '../../crypto/index.js';
import { json } from '../../db/knex.js';
import { workspacesFor } from '../../http/middleware.js';
import { conflict, notFound } from '../../http/problem.js';
import { functionName } from '../../registry/schema.js';
import type { PendingResult, ResolvedTool, ToolCallContext, ToolOutcome } from '../../registry/dispatch.js';
import type { EntryRow } from '../../registry/service.js';
import type { Services } from '../../services.js';
import { isMcpGroup, MCP_GROUPS, mcpResource, type McpGroup } from './resource.js';

/*
 * B-7101: each workspace can publish an MCP server. A client acting for a signed-in user (an OAuth token from the
 * tenant's issuer, B-7102) lists and calls tools in the groups the workspace publishes and the client picked:
 *
 * - workflows: the workspace's published workflows, as `workflow_<name>` (their trigger's schema as the input);
 * - agents: the agents published to the workspace, as `agent_<name>` (a run started as the user, its answer awaited);
 * - knowledge: one search tool per published knowledge base the user may read, `knowledge_<name>`;
 * - tools: the registry tools published to the workspace (built-ins, MCP, scripts, workflows published as tools);
 * - records: the built-in record tools over low-code apps (`records_query`, `records_create`, ...).
 *
 * Everything goes through what the console goes through: the user's roles narrowed by the token's scopes, the
 * user's clearance lowered to the label the workspace publishes at (so nothing above it reaches the client), the
 * tool dispatcher with its label ceilings, the `tool-call` and `context` guardrail checkpoints and rate limits, and
 * approval: a write or destructive call, or one the guardrail holds, waits until the user approves it from a browser
 * session (never with the token that asked) and runs when the client calls again with the same arguments. Every call
 * is audited as `mcp.server.call`.
 */

/** How long a held call waits for a decision, and how long an approval stays usable. */
export const HOLD_PENDING_MS = 60 * 60_000;
export const HOLD_APPROVED_MS = 15 * 60_000;

export interface PublicationRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  enabled: boolean;
  groups: McpGroup[];
  label: Label;
  require_dpop: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

const pubFrom = (r: Record<string, unknown>): PublicationRow => ({
  ...(r as unknown as PublicationRow),
  enabled: !!r.enabled,
  groups: json<unknown[]>(r.groups, []).filter(isMcpGroup),
  label: isLabel(r.label) ? r.label : 'internal',
  require_dpop: !!r.require_dpop,
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

export interface HoldRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  user_id: string;
  client_id: string | null;
  tool: string;
  args_hash: string;
  args: string;
  side_effect: string;
  label: Label;
  reason: string | null;
  state: 'pending' | 'approved' | 'rejected' | 'used' | 'expired';
  decided_by: string | null;
  decided_at: number | null;
  used_at: number | null;
  expires_at: number;
  created_at: number;
}

/** A tool as an MCP client sees it, with what it stands for here. */
export interface McpServerTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean; title?: string };
  group: McpGroup | 'status';
  sideEffect: 'read' | 'write' | 'destructive';
  target: { kind: 'entry'; tool: ResolvedTool } | { kind: 'agent'; entry: EntryRow } | { kind: 'knowledge'; kbId: string; tool: ResolvedTool } | { kind: 'status' };
}

/** What a tools/call comes back with, before it is put in MCP's result shape. */
export interface McpCallOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
  held?: { id: string; expiresAt: number };
  pending?: { handle: string; kind: string; id: string };
  outcome: 'ok' | 'error' | 'denied' | 'held' | 'pending' | 'withheld' | 'unknown';
}

const GROUP_PERMS: Record<McpGroup, Permission[]> = {
  workflows: ['agents:run'],
  agents: ['agents:run'],
  knowledge: ['knowledge:read'],
  tools: ['tools:invoke'],
  records: ['records:read', 'records:write']
};

/** Built-ins that belong to their own group rather than to `tools`. */
const OWN_GROUP = (name: string) => name === 'knowledge_search' || name.startsWith('records.');

const STATUS_TOOL = 'exprsn_run_status';

const annotationsFor = (side: 'read' | 'write' | 'destructive', title: string) => ({ title, readOnlyHint: side === 'read', destructiveHint: side === 'destructive', openWorldHint: false });

export class McpServerService {
  /** How long a call waits for an agent run or a paused workflow before it answers with a handle to ask again. */
  waitMs = 20_000;

  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  // ---------- settings and publications ----------

  async dynamicRegistration(tenantId: string): Promise<boolean> {
    const r = (await this.db('mcp_server_settings').where({ tenant_id: tenantId }).first('dynamic_registration')) as { dynamic_registration: unknown } | undefined;
    return !!r?.dynamic_registration;
  }

  async setDynamicRegistration(tenantId: string, on: boolean, by: string): Promise<void> {
    const row = { tenant_id: tenantId, dynamic_registration: on, updated_by: by, updated_at: Date.now() };
    const n = await this.db('mcp_server_settings').where({ tenant_id: tenantId }).update(row);
    if (!n) await this.db('mcp_server_settings').insert(row);
  }

  async publication(tenantId: string, workspaceId: string): Promise<PublicationRow | null> {
    const r = await this.db('mcp_publications').where({ tenant_id: tenantId, workspace_id: workspaceId }).first();
    return r ? pubFrom(r) : null;
  }

  async publications(tenantId: string): Promise<PublicationRow[]> {
    return ((await this.db('mcp_publications').where({ tenant_id: tenantId })) as Record<string, unknown>[]).map(pubFrom);
  }

  /** Every workspace of the tenant with its publication (off when it has none), as the MCP server page shows them. */
  async overview(tenantId: string, tenantSlug: string) {
    const [workspaces, pubs] = await Promise.all([this.s().tenants.workspaces(tenantId), this.publications(tenantId)]);
    return workspaces
      .filter((w) => w.state === 'active')
      .map((w) => {
        const p = pubs.find((x) => x.workspace_id === w.id);
        return { workspaceId: w.id, workspace: w.name, ceiling: w.label_ceiling, url: mcpResource(this.s().cfg, tenantSlug, w.id), enabled: p?.enabled ?? false, groups: p?.groups ?? [...MCP_GROUPS], label: p?.label ?? 'internal', requireDpop: p?.require_dpop ?? false, updatedAt: p?.updated_at ?? null };
      });
  }

  async publish(p: Principal, workspaceId: string, input: { enabled?: boolean; groups?: McpGroup[]; label?: Label; requireDpop?: boolean }): Promise<PublicationRow> {
    const ws = await this.s().tenants.workspace(p.tenantId, workspaceId);
    if (!ws) throw notFound('Workspace');
    const cur = await this.publication(p.tenantId, workspaceId);
    const label = input.label ?? cur?.label ?? 'internal';
    if (labelRank(label) > labelRank(ws.label_ceiling)) throw conflict(`${ws.name}'s ceiling is ${ws.label_ceiling}; its MCP server cannot publish ${label} data.`);
    const t = Date.now();
    const groups = [...new Set(input.groups ?? cur?.groups ?? [...MCP_GROUPS])];
    const row = { enabled: input.enabled ?? cur?.enabled ?? false, groups: JSON.stringify(groups), label, require_dpop: input.requireDpop ?? cur?.require_dpop ?? false, updated_by: p.userId, updated_at: t };
    if (cur) await this.db('mcp_publications').where({ id: cur.id }).update(row);
    else await this.db('mcp_publications').insert({ id: ulid(), tenant_id: p.tenantId, workspace_id: workspaceId, created_by: p.userId, created_at: t, ...row });
    return (await this.publication(p.tenantId, workspaceId))!;
  }

  /** The enabled MCP servers of the workspaces the user may act in, with their connection URLs. */
  async forUser(p: Principal) {
    const ws = await workspacesFor(this.s(), p);
    const pubs = (await this.publications(p.tenantId)).filter((x) => x.enabled);
    return ws
      .filter((w) => pubs.some((x) => x.workspace_id === w.id))
      .map((w) => {
        const x = pubs.find((y) => y.workspace_id === w.id)!;
        return { workspaceId: w.id, workspace: w.name, url: mcpResource(this.s().cfg, p.tenantSlug, w.id), groups: x.groups, label: x.label, requireDpop: x.require_dpop };
      });
  }

  /**
   * The principal a call acts as: the token's user in the endpoint's workspace (when they may use it), their clearance
   * lowered to the label the workspace publishes at. Null when the user may not act in the workspace.
   */
  async callerIn(p: Principal, pub: PublicationRow): Promise<Principal | null> {
    const ws = (await workspacesFor(this.s(), p)).find((w) => w.id === pub.workspace_id);
    if (!ws) return null;
    return { ...p, workspaceId: ws.id, clearance: clears(p.clearance, pub.label) ? pub.label : p.clearance };
  }

  // ---------- the catalogue ----------

  private can(p: Principal, perm: Permission): boolean {
    return authorize(p, perm, { tenantId: p.tenantId }).allow;
  }

  /** The tools a caller sees in the groups asked for, filtered by their permissions, workspace and label. */
  async catalog(p: Principal, groups: McpGroup[]): Promise<McpServerTool[]> {
    const s = this.s();
    const label = p.clearance;
    const out: McpServerTool[] = [];
    const add = (t: McpServerTool) => {
      if (!out.some((x) => x.name === t.name)) out.push(t);
    };
    const entryTool = (group: McpGroup, t: ResolvedTool, name = t.fn): McpServerTool => ({
      name,
      title: t.entry.name,
      description: `${t.def.function.description}${t.sideEffect === 'read' ? '' : ` (${t.sideEffect}: each call waits for your approval in Exprsn-AI)`}`.slice(0, 2000),
      inputSchema: t.def.function.parameters,
      annotations: annotationsFor(t.sideEffect, t.entry.name),
      group,
      sideEffect: t.sideEffect,
      target: { kind: 'entry', tool: t }
    });
    // Agents also need inference:invoke: their runs call the model as the caller.
    const want = (g: McpGroup) => groups.includes(g) && GROUP_PERMS[g].some((x) => this.can(p, x)) && (g !== 'agents' || this.can(p, 'inference:invoke'));

    if (want('workflows')) {
      const rows = (await s.db('workflows').where({ tenant_id: p.tenantId, workspace_id: p.workspaceId ?? null }).whereNotNull('published_version').orderBy('name').limit(200).select('name')) as { name: string }[];
      const { tools } = await s.tools.resolveCallees(p, { workflows: rows.map((r) => r.name) }, label);
      for (const t of tools) add(entryTool('workflows', t));
    }
    if (want('agents')) {
      const names = [...new Set((await s.registry.list(p.tenantId, { kind: 'agent', status: 'published' })).map((e) => e.name))].slice(0, 200);
      for (const name of names) {
        const e = await s.registry.resolve(p, name, 'agent');
        if (!e || labelRank(label) > labelRank(e.label)) continue;
        const fn = functionName(`agent_${e.name}`);
        const t = s.tools.agentTool(e);
        add({ name: fn, title: e.name, description: `Starts a run of the agent ${e.name} as you and returns its answer. ${e.description ?? ''}`.trim().slice(0, 2000), inputSchema: t.def.function.parameters, annotations: annotationsFor('read', e.name), group: 'agents', sideEffect: 'read', target: { kind: 'agent', entry: e } });
      }
    }
    if (want('knowledge')) {
      const search = (await s.tools.resolve(p, ['knowledge_search'], label)).tools[0];
      if (search) {
        const kbs = (await s.knowledge.visible(p)).map((x) => x.kb).filter((kb) => kb.status === 'published' && (!kb.workspace_id || kb.workspace_id === p.workspaceId));
        for (const kb of kbs.slice(0, 100)) {
          add({
            name: functionName(`knowledge_${kb.name}`),
            title: kb.name,
            description: `Searches the knowledge base ${kb.name}${kb.description ? `: ${kb.description}` : '.'} Hits above ${label} are not returned.`.slice(0, 2000),
            inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 2000, description: 'What to look for' }, k: { type: 'integer', minimum: 1, maximum: 20, description: 'How many hits (8 when left out)' } }, required: ['query'], additionalProperties: false },
            annotations: annotationsFor('read', kb.name),
            group: 'knowledge',
            sideEffect: 'read',
            target: { kind: 'knowledge', kbId: kb.id, tool: search }
          });
        }
      }
    }
    if (want('tools')) {
      const names = [...new Set((await s.registry.list(p.tenantId, { kind: 'tool' })).filter((e) => e.status === 'published' || e.status === 'deprecated').map((e) => e.name))].filter((n) => !OWN_GROUP(n)).slice(0, 300);
      const { tools } = await s.tools.resolve(p, names, label);
      for (const t of tools) add(entryTool('tools', t));
    }
    if (want('records')) {
      const names = ['records.entities', 'records.query', 'records.count', 'records.aggregate'].filter(() => this.can(p, 'records:read')).concat(this.can(p, 'records:write') ? ['records.create', 'records.update', 'records.delete'] : []);
      const { tools } = await s.tools.resolve(p, names, label);
      for (const t of tools) add(entryTool('records', t));
    }
    if (out.some((t) => t.group === 'workflows' || t.group === 'agents')) {
      add({ name: STATUS_TOOL, title: 'Run status', description: 'The answer of an agent or workflow run that was still working when its tool returned: pass the handle that call gave.', inputSchema: { type: 'object', properties: { handle: { type: 'string', maxLength: 200 } }, required: ['handle'], additionalProperties: false }, annotations: annotationsFor('read', 'Run status'), group: 'status', sideEffect: 'read', target: { kind: 'status' } });
    }
    return out;
  }

  // ---------- calls ----------

  /** Runs one tools/call as the caller. Every call, whatever its outcome, is audited. */
  async call(p: Principal, groups: McpGroup[], name: string, args: Record<string, unknown>, meta: { clientId: string | null; ip: string | null; traceId: string | null; signal?: AbortSignal }): Promise<McpCallOutcome> {
    const started = Date.now();
    const tool = (await this.catalog(p, groups)).find((t) => t.name === name);
    let out: McpCallOutcome;
    let holdId: string | null = null;
    if (!tool) out = { ok: false, outcome: 'unknown', error: `No tool ${name} is published to you here.` };
    else {
      const callId = ulid();
      const ctx: ToolCallContext = { principal: p, label: p.clearance, source: { kind: 'mcp-call', id: callId }, ...(meta.signal ? { signal: meta.signal } : {}) };
      const approval = await this.claimApproval(p, tool.name, args);
      holdId = approval;
      if (approval) ctx.approved = true;
      try {
        out = await this.run(ctx, tool, args);
        if (out.outcome === 'held') {
          const h = await this.hold(p, tool, args, meta.clientId, out.error ?? null);
          holdId = h.id;
          out = { ok: false, outcome: 'held', held: { id: h.id, expiresAt: h.expires_at }, error: `${tool.title} is held for your approval (${out.error ?? 'it changes data'}). Approve it in Exprsn-AI under Settings, MCP access, then call ${tool.name} again with the same arguments within ${Math.round(HOLD_APPROVED_MS / 60_000)} minutes.` };
        }
      } catch (err) {
        if (meta.signal?.aborted) throw err;
        out = { ok: false, outcome: 'error', error: (err as Error).message.slice(0, 1000) };
      }
    }
    await this.s().audit.append({
      tenantId: p.tenantId,
      action: 'mcp.server.call',
      kind: 'decision',
      actor: { ...actorFrom(p, meta.ip), ...(meta.clientId ? { service: meta.clientId } : {}) },
      target: { workspace: p.workspaceId ?? null, tool: name },
      label: p.clearance,
      detail: { group: tool?.group ?? null, outcome: out.outcome, sideEffect: tool?.sideEffect ?? null, hold: holdId, error: out.ok ? null : (out.error ?? null)?.slice(0, 300) ?? null, durationMs: Date.now() - started },
      traceId: meta.traceId
    });
    return out;
  }

  private fromOutcome(o: ToolOutcome, kind: string): McpCallOutcome {
    if (o.ok) return { ok: true, outcome: 'ok', result: o.result };
    if (o.needsApproval) return { ok: false, outcome: 'held', error: o.error ?? 'it needs approval' };
    if (o.pending) return { ok: false, outcome: 'pending', pending: { handle: `${o.pending.kind === 'agent-run' ? 'agent' : 'workflow'}:${o.pending.id}:${kind}`, kind: o.pending.kind, id: o.pending.id }, error: o.error ?? 'still working' };
    return { ok: false, outcome: o.withheld ? 'withheld' : o.denied ? 'denied' : 'error', error: o.error ?? 'The call failed.' };
  }

  private async run(ctx: ToolCallContext, tool: McpServerTool, args: Record<string, unknown>): Promise<McpCallOutcome> {
    const s = this.s();
    const t = tool.target;
    if (t.kind === 'entry') {
      const o = await s.tools.call(ctx, t.tool, args);
      return this.awaited(ctx, t.tool, args, this.fromOutcome(o, t.tool.entry.name), o.pending);
    }
    if (t.kind === 'knowledge') {
      const query = typeof args.query === 'string' ? args.query : '';
      if (!query.trim()) return { ok: false, outcome: 'error', error: 'query is required.' };
      const o = await s.tools.call(ctx, t.tool, { kbIds: [t.kbId], query, ...(typeof args.k === 'number' ? { k: args.k } : {}) });
      return this.fromOutcome(o, t.tool.entry.name);
    }
    if (t.kind === 'agent') return this.runAgent(ctx, t.entry, args);
    return this.status(ctx, String(args.handle ?? ''));
  }

  /** Waits a while for work a call started that paused (a workflow on an approval step). */
  private async awaited(ctx: ToolCallContext, tool: ResolvedTool, args: Record<string, unknown>, first: McpCallOutcome, pending: PendingResult | undefined): Promise<McpCallOutcome> {
    if (first.outcome !== 'pending' || !pending) return first;
    const until = Date.now() + this.waitMs;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 250));
      const o = await this.s().tools.awaitResult(ctx, tool, args, pending);
      if (!o.pending) return this.fromOutcome(o, tool.entry.name);
    }
    return first;
  }

  /**
   * An agent as a tool: the `tool-call` checkpoint first (an agent run reads, its own tool calls are approved inside
   * the run as in the console), then a run started as the caller, awaited for a while; its answer passes the
   * `context` checkpoint like any tool result.
   */
  private async runAgent(ctx: ToolCallContext, entry: EntryRow, args: Record<string, unknown>): Promise<McpCallOutcome> {
    const s = this.s();
    const p = ctx.principal;
    const d = await s.guardrails.check({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, checkpoint: 'tool-call', text: JSON.stringify({ tool: `agent:${entry.name}`, arguments: args }), label: ctx.label, principal: p, ...(ctx.source ? { source: ctx.source } : {}), meta: { tool: `agent:${entry.name}`, sideEffect: 'read', toolLabel: entry.label, ceiling: entry.label, impl: 'agent' } });
    if (d.action === 'block') return { ok: false, outcome: 'denied', error: `Blocked by the tool-call guardrail${d.reason ? `: ${d.reason}` : '.'}` };
    if (d.action === 'require-approval' && !ctx.approved) return { ok: false, outcome: 'held', error: d.reason ?? 'held by the tool-call guardrail' };
    const task = entry.input_schema ? JSON.stringify(args) : String(args.task ?? '').trim();
    if (!task) return { ok: false, outcome: 'error', error: `The task for ${entry.name} is empty.` };
    const run = await s.agents.start(p, { agent: entry.name, input: task, label: ctx.label });
    await s.audit.append({ tenantId: p.tenantId, action: 'agent.run.started', kind: 'admin', actor: actorFrom(p, null), target: { run: run.id, agent: run.agent, version: run.agentVersion }, label: run.label, detail: { via: 'mcp', budgets: run.budgets } });
    return this.agentResult(ctx, entry, run.id, Date.now() + this.waitMs);
  }

  private async agentResult(ctx: ToolCallContext, entry: EntryRow, runId: string, until: number): Promise<McpCallOutcome> {
    const s = this.s();
    for (;;) {
      const r = await s.agents.toolResult(ctx, entry, runId);
      if (r.state === 'done') return this.screened(ctx, entry.name, r.result);
      if (r.state === 'failed') return { ok: false, outcome: 'error', error: r.error };
      if (Date.now() >= until) return { ok: false, outcome: 'pending', pending: { handle: `agent:${runId}:${entry.name}`, kind: 'agent-run', id: runId }, error: `${entry.name} is still working on it as run ${runId}.` };
      await new Promise((res) => setTimeout(res, 250));
    }
  }

  /** The `context` checkpoint a result passes before it leaves for the client, as the dispatcher applies to tool results. */
  private async screened(ctx: ToolCallContext, name: string, result: unknown): Promise<McpCallOutcome> {
    const p = ctx.principal;
    const g = await this.s().guardrails.check({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, checkpoint: 'context', text: JSON.stringify(result ?? null), label: ctx.label, principal: p, ...(ctx.source ? { source: ctx.source } : {}), meta: { via: 'tool-result', tool: name, impl: 'agent', sideEffect: 'read' } });
    if (g.action === 'block' || g.action === 'require-approval') return { ok: false, outcome: 'withheld', error: `The result of ${name} was withheld by a guardrail${g.reason ? `: ${g.reason}` : '.'}` };
    if (g.action === 'redact') {
      try {
        return { ok: true, outcome: 'ok', result: JSON.parse(g.text) as unknown };
      } catch {
        return { ok: true, outcome: 'ok', result: { text: g.text } };
      }
    }
    return { ok: true, outcome: 'ok', result };
  }

  /** `exprsn_run_status`: the answer of a run an earlier call left working, for the same user. */
  private async status(ctx: ToolCallContext, handle: string): Promise<McpCallOutcome> {
    const s = this.s();
    const m = /^(agent|workflow):([0-9A-HJKMNP-TV-Z]{26}):(.{1,150})$/.exec(handle);
    if (!m) return { ok: false, outcome: 'error', error: 'Unknown handle.' };
    const [, kind, id, name] = m as unknown as [string, 'agent' | 'workflow', string, string];
    if (kind === 'agent') {
      let run;
      try {
        run = await s.agents.get(ctx.principal, id);
      } catch {
        return { ok: false, outcome: 'error', error: 'Unknown handle.' };
      }
      if (run.user_id !== ctx.principal.userId) return { ok: false, outcome: 'error', error: 'Unknown handle.' };
      const entry = await s.registry.get(ctx.principal.tenantId, run.agent_id);
      if (!entry) return { ok: false, outcome: 'error', error: 'The agent behind this run no longer exists.' };
      return this.agentResult(ctx, entry, id, Date.now());
    }
    const run = (await s.db('workflow_runs').where({ tenant_id: ctx.principal.tenantId, id }).first('created_by')) as { created_by: string } | undefined;
    if (!run || run.created_by !== ctx.principal.userId) return { ok: false, outcome: 'error', error: 'Unknown handle.' };
    const callee = (await s.tools.resolveCallees(ctx.principal, { workflows: [name.replace(/^workflow:/, '')] }, ctx.label)).tools[0];
    if (!callee) return { ok: false, outcome: 'error', error: 'The workflow behind this run is no longer published to you.' };
    const o = await s.tools.awaitResult(ctx, callee, {}, { kind: 'workflow-run', id });
    return this.fromOutcome(o, callee.entry.name);
  }

  // ---------- held calls ----------

  private argsHash(tool: string, args: Record<string, unknown>): string {
    return sha256(`${tool}\n${canonicalJson(args)}`);
  }

  private async hold(p: Principal, tool: McpServerTool, args: Record<string, unknown>, clientId: string | null, reason: string | null): Promise<HoldRow> {
    const s = this.s();
    const id = ulid();
    const t = Date.now();
    const row: HoldRow = { id, tenant_id: p.tenantId, workspace_id: p.workspaceId ?? '', user_id: p.userId, client_id: clientId, tool: tool.name, args_hash: this.argsHash(tool.name, args), args: await s.keys.seal(p.tenantId, JSON.stringify(args), `mcp-hold:${id}`), side_effect: tool.sideEffect, label: p.clearance, reason: reason?.slice(0, 500) ?? null, state: 'pending', decided_by: null, decided_at: null, used_at: null, expires_at: t + HOLD_PENDING_MS, created_at: t };
    await this.db('mcp_server_holds').insert(row);
    await s.notifications.notify({ tenantId: p.tenantId, userIds: [p.userId], kind: 'mcp', title: `An MCP client asks to run ${tool.title}`, body: 'Approve or reject it under Settings, MCP access. Nothing runs until you approve.', route: 'settings?tab=mcp', label: p.clearance }).catch(() => undefined);
    return row;
  }

  /** An approved, unused hold for exactly this call (same user, workspace, tool and arguments), claimed once. */
  private async claimApproval(p: Principal, tool: string, args: Record<string, unknown>): Promise<string | null> {
    const rows = (await this.db('mcp_server_holds').where({ tenant_id: p.tenantId, user_id: p.userId, workspace_id: p.workspaceId ?? '', tool, args_hash: this.argsHash(tool, args), state: 'approved' }).andWhere('expires_at', '>', Date.now()).orderBy('created_at').select('id')) as { id: string }[];
    for (const r of rows) {
      const n = await this.db('mcp_server_holds').where({ id: r.id, state: 'approved' }).update({ state: 'used', used_at: Date.now() });
      if (n) return r.id;
    }
    return null;
  }

  async holds(p: Principal, state: 'pending' | 'all' = 'pending') {
    const s = this.s();
    const now = Date.now();
    await this.db('mcp_server_holds').where({ tenant_id: p.tenantId, user_id: p.userId }).whereIn('state', ['pending', 'approved']).andWhere('expires_at', '<=', now).update({ state: 'expired' });
    const q = this.db('mcp_server_holds').where({ tenant_id: p.tenantId, user_id: p.userId });
    if (state === 'pending') q.whereIn('state', ['pending', 'approved']);
    const rows = (await q.orderBy('created_at', 'desc').limit(100)) as HoldRow[];
    const names = new Map(((await this.s().tenants.workspaces(p.tenantId)) ?? []).map((w) => [w.id, w.name]));
    return Promise.all(
      rows.map(async (h) => ({
        id: h.id,
        workspaceId: h.workspace_id,
        workspace: names.get(h.workspace_id) ?? null,
        client: h.client_id,
        tool: h.tool,
        sideEffect: h.side_effect,
        label: h.label,
        reason: h.reason,
        state: h.state,
        arguments: clears(p.clearance, h.label) ? json<Record<string, unknown>>(await s.keys.open(h.tenant_id, h.args, `mcp-hold:${h.id}`), {}) : null,
        createdAt: Number(h.created_at),
        expiresAt: Number(h.expires_at),
        decidedAt: h.decided_at == null ? null : Number(h.decided_at)
      }))
    );
  }

  async decide(p: Principal, id: string, decision: 'approve' | 'reject'): Promise<HoldRow> {
    const h = (await this.db('mcp_server_holds').where({ tenant_id: p.tenantId, user_id: p.userId, id }).first()) as HoldRow | undefined;
    if (!h) throw notFound('Held call');
    if (h.state !== 'pending' || Number(h.expires_at) <= Date.now()) throw conflict(h.state === 'pending' ? 'This held call expired; ask the client to call again.' : `This call was already ${h.state}.`);
    const t = Date.now();
    const upd = decision === 'approve' ? { state: 'approved', decided_by: p.userId, decided_at: t, expires_at: t + HOLD_APPROVED_MS } : { state: 'rejected', decided_by: p.userId, decided_at: t };
    const n = await this.db('mcp_server_holds').where({ id, state: 'pending' }).update(upd);
    if (!n) throw conflict('This call was decided meanwhile.');
    return { ...h, ...upd } as HoldRow;
  }
}
