import { RateLimiterMemory } from 'rate-limiter-flexible';
import { clears, labelRank, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import type { GuardAction, Guardrails } from '../guardrails/types.js';
import type { CalcWorker } from '../chat/calc.js';
import type { McpService } from '../mcp/service.js';
import type { ScriptService } from '../scripts/service.js';
import { ChainLimit, chainScope, type ChainCtx, type ChainErrorType, type ChainKind, type ChainRef, type ChainService } from '../chain/context.js';
import { functionName, validateAgainst } from './schema.js';
import type { EntryRow, RegistryService, SideEffect } from './service.js';

const RESULT_LIMIT = 64 * 1024;

/** A tool result as the model will see it: context and memory tags defused (as in retrieved context), parsed back. */
function defuseResult(json: string): unknown {
  const safe = json.replace(/<\/?(context|memory)\b/gi, (m) => m.replace('<', '&lt;'));
  try {
    return JSON.parse(safe) as unknown;
  } catch {
    return { text: safe }; // a redaction can leave text that is no longer JSON
  }
}

/** An Ollama tool definition. */
export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ResolvedTool {
  entry: EntryRow;
  /** The function name the model sees. */
  fn: string;
  def: ToolDef;
  sideEffect: SideEffect;
  confirm: 'always' | 'never';
  /** Set for deprecated entries: still callable, with a warning in run details. */
  warning: string | null;
}

export interface ToolCallContext {
  principal: Principal;
  /** The label of the data the call happens in (conversation or run); it must not exceed the tool's ceiling. */
  label: Label;
  source?: { kind: string; id: string };
  signal?: AbortSignal;
  /** The call was approved (agent runs) or confirmed; write and destructive calls need this. */
  approved?: boolean;
  /**
   * B-4101: the chain node the call is made from (an agent run's, a workflow run's). The call becomes its child; a
   * call with none joins the node active in process (`chainScope`), else starts a chain at `chainRoot` (a chat turn)
   * or as a root of its own.
   */
  chain?: ChainRef | null;
  chainRoot?: { kind: ChainKind; ref: string };
}

/** Runs a workflow published as a tool (`impl: 'workflow'`): the workflow service, installed after it is built. */
export interface WorkflowToolRunner {
  /** Why the entry's workflow cannot run now, or null. */
  unavailable(entry: EntryRow): Promise<string | null>;
  runAsTool(ctx: ToolCallContext, entry: EntryRow, args: Record<string, unknown>): Promise<unknown>;
  /** The result of a run that paused (B-1006): still pending, its output, or why it did not succeed. */
  toolResult(ctx: ToolCallContext, entry: EntryRow, runId: string): Promise<CalleeResult>;
  /**
   * B-4104: a workflow an agent lists (`workflows`), as the tool `workflow:<name>` it is offered as: the published
   * version in the caller's workspace with the trigger's schema as input, or why it cannot be offered.
   */
  asCallee(p: Principal, name: string): Promise<EntryRow | { missing: string }>;
}

/** What an awaited callee (a workflow run, a delegated agent run) came to. */
export type CalleeResult = { state: 'pending' } | { state: 'done'; result: unknown } | { state: 'failed'; error: string; type?: ChainErrorType };

/** B-4102: agents an agent delegates to (`agent:<name>`), run by the agent service as child runs. */
export interface AgentToolRunner {
  /** Starts the child run and throws `ToolPending` for it: the calling run awaits its answer. */
  runAsTool(ctx: ToolCallContext, entry: EntryRow, args: Record<string, unknown>): Promise<unknown>;
  toolResult(ctx: ToolCallContext, entry: EntryRow, runId: string): Promise<CalleeResult>;
}

/** The task schema a delegate is offered with when its entry declares no input schema. */
export const DELEGATE_INPUT = { type: 'object', properties: { task: { type: 'string', description: 'What the agent should do, in full: it sees nothing else of this conversation.' } }, required: ['task'] } as const;

/** B-3904: the domain built-ins (`registry/builtin`), installed once the services exist. */
export interface BuiltinRunner {
  run(ctx: ToolCallContext, entry: EntryRow, args: Record<string, unknown>): Promise<unknown>;
}

/** A pending tool result (B-1006): the call started something that finishes later, which the caller can await. */
export interface PendingResult {
  kind: 'workflow-run' | 'agent-run';
  id: string;
}

/** Thrown by an implementation whose work paused: the dispatcher turns it into a pending outcome. */
export class ToolPending extends Error {
  constructor(
    readonly pending: PendingResult,
    message: string
  ) {
    super(message);
  }
}

export interface ToolOutcome {
  name: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  result?: unknown;
  error?: string;
  /** The guardrail's effective action at the tool-call checkpoint. */
  decision: GuardAction | null;
  /** The call did not run: refused by policy or the guardrail. The reason goes back to the model as data. */
  denied?: boolean;
  /** The call did not run: it needs approval first. */
  needsApproval?: boolean;
  /** The call ran but the context guardrail withheld its result from the model. */
  withheld?: boolean;
  /** The call started work that has not finished (a workflow waiting on an approval): await it with `awaitResult`. */
  pending?: PendingResult;
  /** When the tool declares an output schema: did the result match it? */
  valid?: boolean | null;
  /** B-4106: how an awaited callee failed (`budget`, `cancelled`, …), as the error's prefix tells the model. */
  errorType?: ChainErrorType;
  durationMs: number;
}

/**
 * The one place a tool call is dispatched, from chat, agent runs and the registry's test harness. It resolves names
 * to published registry entries the caller may use, offers their schemas to the model, and for each call:
 * validates the arguments, applies the tool's label ceiling and rate limit, passes the `tool-call` guardrail
 * checkpoint (meta: side-effect class, the tool's ceiling), holds write and destructive calls for approval, then runs
 * the built-in, MCP, script or workflow implementation and checks the result against the output schema.
 */
export class ToolDispatcher {
  private readonly limiters = new Map<number, RateLimiterMemory>();
  private workflows: WorkflowToolRunner | null = null;
  private chains: ChainService | null = null;
  private builtins: BuiltinRunner | null = null;
  private agents: AgentToolRunner | null = null;

  constructor(
    private readonly registry: RegistryService,
    private readonly mcp: McpService,
    private readonly scripts: ScriptService,
    private readonly calc: CalcWorker,
    private readonly guard: () => Guardrails
  ) {}

  /** Workflows published as tools run through this runner. */
  useWorkflows(runner: WorkflowToolRunner): void {
    this.workflows = runner;
  }

  /** B-4101: every call that runs is recorded as a `tool-call` node of its chain. */
  useChains(chains: ChainService): void {
    this.chains = chains;
  }

  /** Begins the call's node: a child of the caller's node, of the chat turn, or a new chain. */
  private async chainNode(ctx: ToolCallContext, tool: ResolvedTool): Promise<ChainCtx | null> {
    if (!this.chains) return null;
    const p = ctx.principal;
    let parent: ChainRef | null = ctx.chain ?? chainScope.getStore() ?? null;
    if (!parent && ctx.chainRoot) parent = await this.chains.begin(p.tenantId, { kind: ctx.chainRoot.kind, ref: ctx.chainRoot.ref, principal: p.userId, label: ctx.label });
    return this.chains.begin(p.tenantId, { kind: 'tool-call', callee: `${tool.entry.name}@${tool.entry.version}`, principal: p.userId, label: ctx.label, parent });
  }

  /** B-4102: delegated agents run through this runner. */
  useAgents(runner: AgentToolRunner): void {
    this.agents = runner;
  }

  /** B-3904: the domain built-ins run through this runner. */
  useBuiltins(runner: BuiltinRunner): void {
    this.builtins = runner;
  }

  /** Resolves tool names for a principal and a data label; tools that cannot be offered come back with a reason. */
  async resolve(p: Principal, names: string[], label: Label): Promise<{ tools: ResolvedTool[]; hidden: { name: string; reason: string }[] }> {
    const tools: ResolvedTool[] = [];
    const hidden: { name: string; reason: string }[] = [];
    for (const name of [...new Set(names)]) {
      const entry = await this.registry.resolve(p, name);
      if (!entry) {
        hidden.push({ name, reason: 'not published to this workspace' });
        continue;
      }
      const why = await this.unavailable(p, entry, label);
      if (why) {
        hidden.push({ name, reason: why });
        continue;
      }
      tools.push(this.toResolved(entry));
    }
    return { tools, hidden };
  }

  /**
   * B-4102, B-4104: an agent's delegates and the workflows it lists, as tools: `agent:<name>` (the delegate's input
   * schema, or a `task`) and `workflow:<name>` (the trigger's schema). Each is checked against the data's label like a
   * tool's ceiling; a name that clashes with a tool already offered is hidden.
   */
  async resolveCallees(p: Principal, c: { agents?: string[]; workflows?: string[] }, label: Label, taken: string[] = []): Promise<{ tools: ResolvedTool[]; hidden: { name: string; reason: string }[] }> {
    const tools: ResolvedTool[] = [];
    const hidden: { name: string; reason: string }[] = [];
    const fns = new Set(taken);
    const add = (t: ResolvedTool) => {
      if (fns.has(t.fn)) return hidden.push({ name: t.entry.name, reason: `its function name ${t.fn} is already offered` });
      fns.add(t.fn);
      tools.push(t);
    };
    for (const name of [...new Set(c.agents ?? [])]) {
      const entry = await this.registry.resolve(p, name, 'agent');
      if (!entry) hidden.push({ name: `agent:${name}`, reason: 'not published to this workspace' });
      else if (!this.agents) hidden.push({ name: `agent:${name}`, reason: 'agents cannot be delegated to on this instance' });
      else if (labelRank(label) > labelRank(entry.label)) hidden.push({ name: `agent:${name}`, reason: `its ceiling is ${entry.label}; the data is ${label}` });
      else add(this.agentTool(entry));
    }
    for (const name of [...new Set(c.workflows ?? [])]) {
      if (!this.workflows) {
        hidden.push({ name: `workflow:${name}`, reason: 'workflows are not running on this instance' });
        continue;
      }
      const entry = await this.workflows.asCallee(p, name);
      if ('missing' in entry) hidden.push({ name: `workflow:${name}`, reason: entry.missing });
      else if (labelRank(label) > labelRank(entry.label)) hidden.push({ name: entry.name, reason: `its workspace's ceiling is ${entry.label}; the data is ${label}` });
      else add(this.toResolved(entry));
    }
    return { tools, hidden };
  }

  /** A delegate as a tool: the agent's own registry entry, called as `agent:<name>`. */
  agentTool(entry: EntryRow): ResolvedTool {
    const fn = functionName(`agent:${entry.name}`);
    return {
      entry,
      fn,
      def: { type: 'function', function: { name: fn, description: `Delegate to the agent ${entry.name}, which works on its own and answers. ${entry.description ?? ''}`.trim(), parameters: entry.input_schema ?? (DELEGATE_INPUT as unknown as Record<string, unknown>) } },
      sideEffect: 'read',
      confirm: 'never',
      warning: entry.status === 'deprecated' ? `${entry.name} ${entry.version} is deprecated${entry.replacement ? `; use ${entry.replacement}` : ''}.` : null
    };
  }

  toResolved(entry: EntryRow): ResolvedTool {
    const fn = functionName(entry.name);
    return {
      entry,
      fn,
      def: { type: 'function', function: { name: fn, description: entry.description ?? entry.name, parameters: entry.input_schema ?? { type: 'object', properties: {} } } },
      sideEffect: entry.side_effect ?? 'read',
      confirm: entry.confirm,
      warning: entry.status === 'deprecated' ? `${entry.name} ${entry.version} is deprecated${entry.replacement ? `; use ${entry.replacement}` : ''}.` : null
    };
  }

  private async unavailable(p: Principal, entry: EntryRow, label: Label): Promise<string | null> {
    if (labelRank(label) > labelRank(entry.label)) return `its ceiling is ${entry.label}; the data is ${label}`;
    if (entry.impl === 'mcp') return this.mcp.unavailable(String(entry.definition.serverId), String(entry.definition.tool), p.userId);
    if (entry.impl === 'workflow') return this.workflows ? this.workflows.unavailable(entry) : 'workflows are not running on this instance';
    return null;
  }

  private async limited(entry: EntryRow, userId: string): Promise<boolean> {
    if (!entry.rate_per_hour) return false;
    let l = this.limiters.get(entry.rate_per_hour);
    if (!l) this.limiters.set(entry.rate_per_hour, (l = new RateLimiterMemory({ points: entry.rate_per_hour, duration: 3600 })));
    try {
      await l.consume(`${entry.id}:${userId}`);
      return false;
    } catch {
      return true;
    }
  }

  async call(ctx: ToolCallContext, tool: ResolvedTool, rawArgs: Record<string, unknown>): Promise<ToolOutcome> {
    const started = Date.now();
    const p = ctx.principal;
    let args = rawArgs;
    const out = (o: Partial<ToolOutcome>): ToolOutcome => ({ name: tool.entry.name, arguments: args, ok: false, decision: null, durationMs: Date.now() - started, ...o });

    const invalid = validateAgainst(tool.entry.kind === 'agent' ? (tool.entry.input_schema ?? (DELEGATE_INPUT as unknown as Record<string, unknown>)) : tool.entry.input_schema, args);
    if (invalid.length) return out({ error: `The arguments do not match the tool's input schema: ${invalid.slice(0, 3).join('; ')}.` });
    const why = await this.unavailable(p, tool.entry, ctx.label);
    if (why) return out({ denied: true, error: `tool_unavailable: ${tool.entry.name}: ${why}.` });

    const d = await this.guard().check({
      tenantId: p.tenantId,
      workspaceId: p.workspaceId ?? null,
      checkpoint: 'tool-call',
      text: JSON.stringify({ tool: tool.entry.name, arguments: args }),
      label: ctx.label,
      principal: p,
      ...(ctx.source ? { source: ctx.source } : {}),
      meta: { tool: tool.entry.name, sideEffect: tool.sideEffect, toolLabel: tool.entry.label, ceiling: tool.entry.label, confirm: tool.confirm, impl: tool.entry.impl }
    });
    if (d.action === 'block') return out({ decision: d.action, denied: true, error: `Blocked by the tool-call guardrail${d.reason ? `: ${d.reason}` : '.'}` });
    if (d.action === 'redact') {
      try {
        const red = JSON.parse(d.text) as { arguments?: Record<string, unknown> };
        args = red.arguments ?? args;
      } catch {
        return out({ decision: d.action, denied: true, error: 'The tool-call guardrail redacted the arguments beyond use.' });
      }
    }
    if (!ctx.approved && (d.action === 'require-approval' || tool.sideEffect !== 'read' || tool.confirm === 'always')) {
      return out({ decision: d.action, needsApproval: true, error: `${tool.entry.name} is ${tool.sideEffect === 'read' ? 'held by the tool-call guardrail' : `a ${tool.sideEffect} tool`} and needs approval before it runs.` });
    }
    if (await this.limited(tool.entry, p.userId)) return out({ decision: d.action, denied: true, error: `Rate limit: ${tool.entry.name} allows ${tool.entry.rate_per_hour} calls per user per hour.` });

    let node: ChainCtx | null;
    try {
      node = await this.chainNode(ctx, tool);
    } catch (err) {
      if (err instanceof ChainLimit) {
        // The refused call is recorded under its would-be parent, so the chain shows where it stopped.
        const parent = ctx.chain ?? chainScope.getStore() ?? null;
        if (parent) await this.chains!.refused(p.tenantId, { kind: 'tool-call', callee: `${tool.entry.name}@${tool.entry.version}`, principal: p.userId, label: ctx.label, parent }, err.message).catch(() => undefined);
        return out({ decision: d.action, denied: true, error: `chain_limit: ${err.message}` });
      }
      throw err;
    }
    // The label only rises along a chain: the call runs at the chain's high-water mark, within the tool's ceiling.
    if (node && labelRank(node.label) > labelRank(tool.entry.label)) {
      await this.chains!.finish(node, 'refused', 'above the ceiling');
      return out({ decision: d.action, denied: true, error: `tool_unavailable: ${tool.entry.name}: its ceiling is ${tool.entry.label}; the chain carries ${node.label} data.` });
    }
    if (node) await this.chains!.note(node, { decision: d.action });
    const cctx: ToolCallContext = node ? { ...ctx, label: node.label, chain: { chain: node.chain, node: node.node } } : ctx;
    const run = () => this.execute(cctx, tool.entry, args);
    try {
      const result = node ? await chainScope.run({ chain: node.chain, node: node.node }, run) : await run();
      const o = await this.finishResult(cctx, tool, result, out, d.action);
      if (node) await this.chains!.finish(node, o.ok ? 'succeeded' : 'failed', o.ok ? null : (o.error ?? null));
      return o;
    } catch (err) {
      if (err instanceof ToolPending) {
        if (node) await this.chains!.finish(node, 'waiting');
        return out({ decision: d.action, pending: err.pending, error: err.message });
      }
      if (node) await this.chains!.finish(node, 'failed', (err as Error).message);
      if (ctx.signal?.aborted) throw err;
      return out({ decision: d.action, error: (err as Error).message.slice(0, 1000) });
    }
  }

  /**
   * Picks up a pending result (B-1006): when the work finished, its result passes the output schema check and the
   * context checkpoint like any other; still pending comes back pending.
   */
  async awaitResult(ctx: ToolCallContext, tool: ResolvedTool, args: Record<string, unknown>, pending: PendingResult): Promise<ToolOutcome> {
    const started = Date.now();
    const out = (o: Partial<ToolOutcome>): ToolOutcome => ({ name: tool.entry.name, arguments: args, ok: false, decision: null, durationMs: Date.now() - started, ...o });
    const runner = pending.kind === 'agent-run' ? this.agents : this.workflows;
    if (!runner) return out({ error: 'The pending result can no longer be read on this instance.' });
    const r = await runner.toolResult(ctx, tool.entry, pending.id);
    if (r.state === 'pending') return out({ pending, error: `${tool.entry.name} is still ${pending.kind === 'agent-run' ? 'working' : 'waiting'}.` });
    // The call's node (the parent of the run's) ends with the run, with the typed error its caller gets (B-4106).
    const runNode = this.chains ? await this.chains.find(pending.kind, pending.id) : undefined;
    if (runNode?.parent) await this.chains!.finish({ chain: runNode.chain, node: runNode.parent }, r.state === 'done' ? 'succeeded' : 'failed', r.state === 'failed' ? r.error : null, r.state === 'failed' ? (r.type ?? 'failed') : null);
    if (r.state === 'failed') return out({ error: r.error.slice(0, 1000), errorType: r.type ?? 'failed' });
    return this.finishResult(ctx, tool, r.result, out, null);
  }

  /** Output schema, size cap, the context checkpoint and tag defusing: what every result passes before the model. */
  private async finishResult(ctx: ToolCallContext, tool: ResolvedTool, result: unknown, out: (o: Partial<ToolOutcome>) => ToolOutcome, decision: GuardAction | null): Promise<ToolOutcome> {
    const p = ctx.principal;
    const valid = tool.entry.output_schema ? validateAgainst(tool.entry.output_schema, result).length === 0 : null;
    const text = JSON.stringify(result ?? null);
    const capped = text.length > RESULT_LIMIT ? { truncated: true, text: text.slice(0, RESULT_LIMIT) } : result;
    // Whatever an MCP server, script or workflow returns is untrusted input to the model: the same context
    // checkpoint retrieved knowledge passes, and the same tag defusing, before it goes into the conversation.
    const g = await this.guard().check({
      tenantId: p.tenantId,
      workspaceId: p.workspaceId ?? null,
      checkpoint: 'context',
      text: JSON.stringify(capped ?? null),
      // A result has no label of its own: it takes the label of the context it lands in, which the caller is always
      // cleared for (the harness may run a tool at its ceiling, above the tester's clearance).
      label: clears(p.clearance, ctx.label) ? ctx.label : p.clearance,
      principal: p,
      ...(ctx.source ? { source: ctx.source } : {}),
      meta: { via: 'tool-result', tool: tool.entry.name, impl: tool.entry.impl, sideEffect: tool.sideEffect }
    });
    if (g.action === 'block' || g.action === 'require-approval') {
      return out({ decision: g.action, withheld: true, valid, error: `The result of ${tool.entry.name} was withheld by a guardrail${g.reason ? `: ${g.reason}` : '.'}` });
    }
    return out({ ok: true, result: defuseResult(g.action === 'redact' ? g.text : JSON.stringify(capped ?? null)), decision, valid });
  }

  private async execute(ctx: ToolCallContext, entry: EntryRow, args: Record<string, unknown>): Promise<unknown> {
    switch (entry.impl) {
      case 'builtin':
        if (entry.definition.builtin === 'calculate') return this.calc.evaluate(String(args.expression ?? ''));
        if (this.builtins) return this.builtins.run(ctx, entry, args);
        throw new Error(`Unknown built-in ${String(entry.definition.builtin)}.`);
      case 'mcp': {
        const r = await this.mcp.call(ctx.principal, String(entry.definition.serverId), String(entry.definition.tool), args, ctx.signal);
        const text = (r.content ?? []).filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
        if (r.isError) throw new Error(text || 'The tool reported an error.');
        return r.structuredContent ?? { text };
      }
      case 'script':
        return this.scripts.runAsTool(entry, args, ctx.signal);
      case 'workflow':
        if (!this.workflows) throw new Error('Workflows are not running on this instance.');
        return this.workflows.runAsTool(ctx, entry, args);
      case 'agent':
        if (entry.kind !== 'agent' || !this.agents) throw new Error(`${entry.name} cannot be delegated to on this instance.`);
        return this.agents.runAsTool(ctx, entry, args);
      default:
        throw new Error(`${entry.name} cannot be called (${entry.impl}).`);
    }
  }
}
