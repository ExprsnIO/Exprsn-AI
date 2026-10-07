import { labelRank } from '../../authz/labels.js';
import type { ChatMessage } from '../../gateway/ollama.js';
import type { ToolDef } from '../../registry/dispatch.js';
import { skillClosure } from '../../registry/skills.js';
import { guardedByApproval, graphSchema } from '../graph.js';
import { StepBlocked, StepFailed, type StepCall, type StepHost, type WAIT } from './host.js';
import { toolResultContent, type UntrustedVerdict } from '../../guardrails/injection.js';

/*
 * Skills on a model step (B-3902, B-4103). Each skill named in `skills[]` loads with its closure (the skills it builds
 * on, each once, dependencies first); every skill of the closure must be published to the run's workspace with a
 * ceiling at or above the data's label. Loading one is an invocation in the chain (`skill-load`); its instructions
 * join the system prompt and the tools the closure needs are offered to the model through the dispatcher, so every
 * call the model makes passes the same checks as an agent's: the tool's ceiling, its input schema, the `tool-call`
 * guardrail checkpoint, its rate limit and its side-effect class. A write or destructive call (or one the checkpoint
 * holds) runs when an Approval step comes before this step on every path; otherwise (B-4106) the step pauses on an
 * approval for that call (the model step's `approverRole`, default workflow-admin) and continues from where it was
 * once someone decides: approved, the call runs; rejected, the model is told and nothing runs. At most
 * `MAX_TOOL_ROUNDS` rounds of calls.
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
  /** B-6901: the profile's trust marking (datamark untrusted tool results); on when unset. */
  trustMarking?: boolean;
  /** One model call (metered by the caller), with the tools to offer. */
  chat(messages: ChatMessage[], tools: ToolDef[]): Promise<ChatTurn>;
  /** Who approves a held call, and how long they have. */
  approverRole: string;
  approvalTimeoutMs: number;
}

type CallRecord = { tool: string; ok: boolean; decision: string | null; error: string | null; approvedBy?: string | null };

/** What a held step continues from (sealed in the step). */
interface SkillHold {
  messages: ChatMessage[];
  rounds: number;
  calls: CallRecord[];
  queue: { name: string; arguments: Record<string, unknown> }[];
  tokens: number;
  gpuMs: number;
}

export interface SkillModelResult {
  text: string;
  /** Tokens and GPU time of model calls made before the step paused (already metered, not yet counted for the run). */
  carried: { tokens: number; gpuMs: number };
  detail: Record<string, unknown>;
}

export async function modelWithSkills(c: StepCall, host: StepHost, o: SkillModelOptions): Promise<SkillModelResult | typeof WAIT> {
  const closure = await skillClosure(host.registry, c.p, o.skills);
  const miss = closure.missing[0];
  if (miss) throw new StepFailed(`Skill ${miss.name} ${miss.reason}${miss.neededBy ? ` (${miss.neededBy} needs it)` : ''}.`);
  for (const skill of closure.skills) if (labelRank(c.label) > labelRank(skill.label)) throw new StepBlocked(`Blocked by label ceiling: skill ${skill.name} takes data up to ${skill.label}; the data arriving is ${c.label}.`);
  const loaded = closure.skills.map((s) => ({ name: s.name, version: s.version }));
  const chain = host.chainOf(c.run);
  const held = await host.takeHold<SkillHold>(c);

  let messages: ChatMessage[];
  let rounds = 0;
  let calls: CallRecord[] = [];
  let queue: SkillHold['queue'] = [];
  let carried = { tokens: 0, gpuMs: 0 };
  if (held) {
    ({ messages, rounds, calls, queue } = held.state);
    carried = { tokens: held.state.tokens, gpuMs: held.state.gpuMs };
  } else {
    // Each skill of the closure loads once, as a node of the run's chain.
    if (chain && host.chains) {
      for (const skill of closure.skills) await host.chains.finish(await host.chains.begin(c.run.tenant_id, { kind: 'skill-load', callee: `${skill.name}@${skill.version}`, principal: c.run.created_by, label: c.label, parent: chain }), 'succeeded');
    }
    const parts = closure.skills.map((skill) => `Skill ${skill.name} ${skill.version}:\n${String(skill.definition.instructions ?? '')}`);
    messages = [...o.messages];
    const sys = messages.findIndex((m) => m.role === 'system');
    if (sys >= 0) messages[sys] = { ...messages[sys]!, content: `${messages[sys]!.content}\n\n${parts.join('\n\n')}` };
    else messages.unshift({ role: 'system', content: parts.join('\n\n') });
  }

  const { tools, hidden } = closure.tools.length ? await host.tools.resolve(c.p, closure.tools, c.label) : { tools: [], hidden: [] };
  if (tools.length && !o.toolsCapable) throw new StepFailed(`The profile's model cannot call tools, which ${loaded.map((s) => s.name).join(', ')} need.`);
  const guarded = guardedByApproval(graphSchema.parse(JSON.parse(c.run.graph)), c.n.id);
  let decision = held ? { decision: held.decision, by: held.by, note: held.note } : null;
  let tokens = 0;
  let gpuMs = 0;
  const done = (text: string): SkillModelResult => ({ text, carried, detail: { skills: loaded, tools: tools.map((t) => t.entry.name), hidden, toolCalls: calls } });
  for (;;) {
    if (!queue.length) {
      const turn = await o.chat(messages, tools.map((t) => t.def));
      tokens += turn.tokens;
      gpuMs += turn.gpuMs;
      if (!turn.toolCalls.length || !tools.length) return done(turn.text);
      if (rounds >= MAX_TOOL_ROUNDS) throw new StepFailed(`The model was still calling tools after ${MAX_TOOL_ROUNDS} rounds.`);
      rounds++;
      messages.push({ role: 'assistant', content: turn.text, tool_calls: turn.toolCalls.map((x) => ({ function: { name: x.name, arguments: x.arguments } })) });
      queue = turn.toolCalls.map((x) => ({ name: x.name, arguments: x.arguments ?? {} }));
    }
    while (queue.length) {
      const call = queue[0]!;
      const tool = tools.find((t) => t.fn === call.name);
      let content: unknown;
      let untrusted: UntrustedVerdict | null = null;
      // The call the step paused on comes back with its decision.
      const decided = decision;
      decision = null;
      if (!tool) {
        content = { error: `tool_unavailable: ${call.name} is not a tool of the skills on this step.` };
        calls.push({ tool: call.name, ok: false, decision: null, error: 'not offered' });
      } else if (decided?.decision === 'rejected') {
        const error = `Rejected by ${decided.by ?? 'the approver'}${decided.note ? `: ${decided.note.replace(/[.\s]+$/, '')}` : ''}. Nothing was run.`;
        content = { error };
        calls.push({ tool: tool.entry.name, ok: false, decision: null, error, approvedBy: null });
      } else {
        const out = await host.tools.call({ principal: c.p, label: c.label, source: { kind: 'workflow-step', id: c.step.id }, signal: c.signal, approved: guarded || decided?.decision === 'approved', chain }, tool, call.arguments);
        if (out.needsApproval) {
          // B-4106: the call is held: the step (and so the chain) pauses until an approver decides.
          const state: SkillHold = { messages, rounds, calls, queue, tokens: carried.tokens + tokens, gpuMs: carried.gpuMs + gpuMs };
          return host.hold(c, state, { tool: tool.entry.name, version: tool.entry.version, sideEffect: tool.sideEffect, arguments: out.arguments, reason: out.error ?? null, skills: loaded.map((s) => s.name) }, { role: o.approverRole, timeoutMs: o.approvalTimeoutMs });
        }
        const error = out.pending ? `${out.error} A model step does not wait for it.` : (out.error ?? null);
        content = out.ok ? out.result : { error };
        if (out.ok) untrusted = out.untrusted ?? null;
        calls.push({ tool: tool.entry.name, ok: out.ok, decision: out.decision, error: out.ok ? null : error, ...(decided ? { approvedBy: decided.by } : {}) });
      }
      messages.push({ role: 'tool', tool_name: call.name, content: toolResultContent(content ?? null, { name: tool?.entry.name ?? call.name, untrusted, marking: o.trustMarking !== false }) });
      queue = queue.slice(1);
    }
  }
}
