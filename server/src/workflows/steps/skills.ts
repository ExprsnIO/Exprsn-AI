import { labelRank } from '../../authz/labels.js';
import type { ChatMessage } from '../../gateway/ollama.js';
import type { ToolDef } from '../../registry/dispatch.js';
import { guardedByApproval, graphSchema } from '../graph.js';
import { StepBlocked, StepFailed, type StepCall, type StepHost } from './host.js';

/*
 * Skills on a model step (B-3902). Each skill named in `skills[]` must be published to the run's workspace with a
 * ceiling at or above the data's label. Loading one is an invocation in the chain (`skill-load`); its instructions
 * join the system prompt and the tools it names are offered to the model through the dispatcher, so every call the
 * model makes passes the same checks as an agent's: the tool's ceiling, its input schema, the `tool-call` guardrail
 * checkpoint, its rate limit and its side-effect class. A write or destructive call (or one the checkpoint holds) is
 * made only when an Approval step comes before this step on every path; otherwise the model is told it needs an
 * approval and nothing runs. At most `MAX_TOOL_ROUNDS` rounds of calls.
 */

export const MAX_TOOL_ROUNDS = 6;

export interface ChatTurn {
  text: string;
  toolCalls: { name: string; arguments: Record<string, unknown> }[];
  tokens: number;
  gpuMs: number;
}

export interface SkillModelOptions {
  skills: string[];
  messages: ChatMessage[];
  /** Whether the profile's model can call tools. */
  toolsCapable: boolean;
  /** One model call (metered by the caller), with the tools to offer. */
  chat(messages: ChatMessage[], tools: ToolDef[]): Promise<ChatTurn>;
}

export async function modelWithSkills(c: StepCall, host: StepHost, o: SkillModelOptions): Promise<{ text: string; tokens: number; gpuMs: number; detail: Record<string, unknown> }> {
  const parts: string[] = [];
  const toolNames: string[] = [];
  const loaded: { name: string; version: string }[] = [];
  const chain = host.chainOf(c.run);
  for (const name of o.skills) {
    const skill = await host.registry.resolve(c.p, name, 'skill');
    if (!skill) throw new StepFailed(`Skill ${name} is not published to this workspace.`);
    if (labelRank(c.label) > labelRank(skill.label)) throw new StepBlocked(`Blocked by label ceiling: skill ${skill.name} takes data up to ${skill.label}; the data arriving is ${c.label}.`);
    if (chain && host.chains) {
      const node = await host.chains.begin(c.run.tenant_id, { kind: 'skill-load', callee: `${skill.name}@${skill.version}`, principal: c.run.created_by, label: c.label, parent: chain });
      await host.chains.finish(node, 'succeeded');
    }
    parts.push(`Skill ${skill.name} ${skill.version}:\n${String(skill.definition.instructions ?? '')}`);
    for (const t of Array.isArray(skill.definition.tools) ? (skill.definition.tools as unknown[]) : []) if (typeof t === 'string' && !toolNames.includes(t)) toolNames.push(t);
    loaded.push({ name: skill.name, version: skill.version });
  }
  const messages = [...o.messages];
  const sys = messages.findIndex((m) => m.role === 'system');
  if (sys >= 0) messages[sys] = { ...messages[sys]!, content: `${messages[sys]!.content}\n\n${parts.join('\n\n')}` };
  else messages.unshift({ role: 'system', content: parts.join('\n\n') });

  const { tools, hidden } = toolNames.length ? await host.tools.resolve(c.p, toolNames, c.label) : { tools: [], hidden: [] };
  if (tools.length && !o.toolsCapable) throw new StepFailed(`The profile's model cannot call tools, which ${loaded.map((s) => s.name).join(', ')} need.`);
  const guarded = guardedByApproval(graphSchema.parse(JSON.parse(c.run.graph)), c.n.id);
  const calls: { tool: string; ok: boolean; decision: string | null; error: string | null }[] = [];
  let tokens = 0;
  let gpuMs = 0;
  for (let round = 0; ; round++) {
    const turn = await o.chat(messages, tools.map((t) => t.def));
    tokens += turn.tokens;
    gpuMs += turn.gpuMs;
    if (!turn.toolCalls.length || !tools.length) return { text: turn.text, tokens, gpuMs, detail: { skills: loaded, tools: tools.map((t) => t.entry.name), hidden, toolCalls: calls } };
    if (round >= MAX_TOOL_ROUNDS) throw new StepFailed(`The model was still calling tools after ${MAX_TOOL_ROUNDS} rounds.`);
    messages.push({ role: 'assistant', content: turn.text, tool_calls: turn.toolCalls.map((x) => ({ function: { name: x.name, arguments: x.arguments } })) });
    for (const call of turn.toolCalls) {
      const tool = tools.find((t) => t.fn === call.name);
      let content: unknown;
      if (!tool) {
        content = { error: `tool_unavailable: ${call.name} is not a tool of the skills on this step.` };
        calls.push({ tool: call.name, ok: false, decision: null, error: 'not offered' });
      } else {
        const out = await host.tools.call({ principal: c.p, label: c.label, source: { kind: 'workflow-step', id: c.step.id }, signal: c.signal, approved: guarded, chain }, tool, call.arguments ?? {});
        const error = out.needsApproval ? `${out.error} Put an Approval step before this step to let it run.` : out.pending ? `${out.error} A model step does not wait for it.` : (out.error ?? null);
        content = out.ok ? out.result : { error };
        calls.push({ tool: tool.entry.name, ok: out.ok, decision: out.decision, error: out.ok ? null : error });
      }
      messages.push({ role: 'tool', tool_name: call.name, content: JSON.stringify(content ?? null) });
    }
  }
}
