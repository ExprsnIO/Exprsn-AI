import { RateLimiterMemory } from 'rate-limiter-flexible';
import { labelRank, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import type { GuardAction, Guardrails } from '../guardrails/types.js';
import type { CalcWorker } from '../chat/calc.js';
import type { McpService } from '../mcp/service.js';
import type { ScriptService } from '../scripts/service.js';
import { functionName, validateAgainst } from './schema.js';
import type { EntryRow, RegistryService, SideEffect } from './service.js';

const RESULT_LIMIT = 64 * 1024;

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
}

/** Runs a workflow published as a tool (`impl: 'workflow'`): the workflow service, installed after it is built. */
export interface WorkflowToolRunner {
  /** Why the entry's workflow cannot run now, or null. */
  unavailable(entry: EntryRow): Promise<string | null>;
  runAsTool(ctx: ToolCallContext, entry: EntryRow, args: Record<string, unknown>): Promise<unknown>;
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
  /** When the tool declares an output schema: did the result match it? */
  valid?: boolean | null;
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

    const invalid = validateAgainst(tool.entry.input_schema, args);
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

    try {
      const result = await this.execute(ctx, tool.entry, args);
      const text = JSON.stringify(result ?? null);
      const capped = text.length > RESULT_LIMIT ? { truncated: true, text: text.slice(0, RESULT_LIMIT) } : result;
      const valid = tool.entry.output_schema ? validateAgainst(tool.entry.output_schema, result).length === 0 : null;
      return out({ ok: true, result: capped, decision: d.action, valid });
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      return out({ decision: d.action, error: (err as Error).message.slice(0, 1000) });
    }
  }

  private async execute(ctx: ToolCallContext, entry: EntryRow, args: Record<string, unknown>): Promise<unknown> {
    switch (entry.impl) {
      case 'builtin':
        if (entry.definition.builtin === 'calculate') return this.calc.evaluate(String(args.expression ?? ''));
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
      default:
        throw new Error(`${entry.name} cannot be called (${entry.impl}).`);
    }
  }
}
