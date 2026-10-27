import { clears, labelRank, type Label } from '../authz/labels.js';
import { authorize, type Principal } from '../authz/policy.js';
import type { Lease, ResolvedProfile } from '../gateway/gateway.js';
import type { ChatMessage, ChatRequest } from '../gateway/ollama.js';
import { toolResultContent } from '../guardrails/injection.js';
import { HttpProblem } from '../http/problem.js';
import type { ResolvedTool } from '../registry/dispatch.js';
import type { AgentDefinition } from '../registry/service.js';
import { skillClosure } from '../registry/skills.js';
import type { Services } from '../services.js';

/*
 * Model calls for customer channels (B-2301). Only the gateway talks to Ollama. A channel is bound to a published
 * profile, or to a published agent: its profile and system prompt, and nothing else unless the channel turns the
 * agent's tools on (`generateAgentReply`), which offers the read tools among them and never a write.
 * The channel's label must fit under the profile's (and the agent's) label, and the gateway only leases a pool cleared
 * for it, so an answer never comes from a model or pool below the channel's label. The tenant's quota is admitted and
 * the use metered to the channel's workspace.
 */

export class TargetUnavailable extends Error {}

export interface Target {
  resolved: ResolvedProfile;
  /** The agent's published name and version, when the channel is bound to an agent. */
  agent: { name: string; version: string; label: Label } | null;
  /** The agent's definition (its tools and skills), for a channel that runs them. */
  def: AgentDefinition | null;
  system: string | null;
}

/** The profile (and agent) a channel answers with, checked against the channel's label now. */
export async function resolveTarget(s: Services, c: { tenantId: string; workspaceId: string; targetKind: 'profile' | 'agent'; targetName: string; label: Label }): Promise<Target> {
  let profileName = c.targetName;
  let agent: Target['agent'] = null;
  let system: string | null = null;
  let adef: AgentDefinition | null = null;
  if (c.targetKind === 'agent') {
    const e = await s.registry.resolve({ tenantId: c.tenantId, workspaceId: c.workspaceId }, c.targetName, 'agent');
    if (!e) throw new TargetUnavailable(`No published agent named ${c.targetName} is visible in the channel's workspace.`);
    const def = e.definition as unknown as AgentDefinition;
    if (labelRank(c.label) > labelRank(e.label)) throw new TargetUnavailable(`Agent ${e.name} handles data up to ${e.label}; the channel is ${c.label}.`);
    profileName = def.profile;
    adef = def;
    system = def.systemPrompt ?? null;
    agent = { name: e.name, version: e.version, label: e.label };
  }
  let resolved: ResolvedProfile;
  try {
    resolved = await s.gateway.resolve(c.tenantId, profileName);
  } catch (err) {
    throw new TargetUnavailable(err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message);
  }
  if (resolved.model.state !== 'approved' && resolved.model.state !== 'deprecated') throw new TargetUnavailable(`Profile ${resolved.profile.name} routes to ${resolved.model.name}, which is ${resolved.model.state}.`);
  if (labelRank(c.label) > labelRank(resolved.profile.label)) throw new TargetUnavailable(`Profile ${resolved.profile.name} handles data up to ${resolved.profile.label}; the channel is ${c.label}.`);
  return { resolved, agent, def: adef, system };
}

export interface GenerateInput {
  tenantId: string;
  workspaceId: string;
  label: Label;
  target: Target;
  system: string;
  history: ChatMessage[];
  timeoutMs: number;
}

/** One answer, not streamed (the customer endpoint answers when the reply is ready or held). */
export async function generateReply(s: Services, input: GenerateInput): Promise<{ text: string; model: string; profile: string; promptTokens: number; outputTokens: number }> {
  const r = input.target.resolved;
  await s.quotas.admit(input.tenantId, input.workspaceId);
  const messages: ChatMessage[] = [{ role: 'system', content: [r.profile.system_prompt, input.target.system, input.system].filter(Boolean).join('\n\n') }, ...input.history];
  const options: Record<string, unknown> = {};
  if (r.profile.num_ctx) options.num_ctx = r.profile.num_ctx;
  if (r.profile.temperature != null) options.temperature = r.profile.temperature;
  const req: ChatRequest = { model: r.model.name, messages, options };
  if (r.model.capabilities.includes('thinking')) req.think = false;
  const signal = AbortSignal.timeout(input.timeoutMs);
  let lease: Lease | null = null;
  let text = '';
  let prompt = 0;
  let output = 0;
  let gpuMs = 0;
  let firstTokenMs: number | null = null;
  const started = Date.now();
  try {
    lease = await s.gateway.acquire(r.profile, r.model, input.label, { signal });
    for await (const chunk of lease.client.chat(req, signal)) {
      if (chunk.message?.content) {
        if (firstTokenMs == null) firstTokenMs = Date.now() - started;
        text += chunk.message.content;
      }
      if (chunk.done) {
        prompt += chunk.prompt_eval_count ?? 0;
        output += chunk.eval_count ?? 0;
        gpuMs += ((chunk.prompt_eval_duration ?? 0) + (chunk.eval_duration ?? 0) + (chunk.load_duration ?? 0)) / 1e6;
      }
    }
  } finally {
    lease?.release(firstTokenMs);
  }
  if (!prompt && !output) {
    prompt = Math.ceil(messages.reduce((a, m) => a + m.content.length, 0) / 4);
    output = Math.ceil(text.length / 4);
  }
  await s.quotas.record({ tenantId: input.tenantId, workspaceId: input.workspaceId, userId: null, kind: 'channel', profileId: r.profile.id, model: r.model.name, poolId: lease?.pool.id ?? null, promptTokens: prompt, outputTokens: output, gpuMs });
  return { text: text.trim(), model: r.model.name, profile: r.profile.name, promptTokens: prompt, outputTokens: output };
}

/** What one reply of a channel that runs its agent's tools may spend. */
export const AGENT_REPLY = { modelCalls: 8, toolCalls: 10 } as const;

export interface AgentReplyInput extends GenerateInput {
  /** The account the tools run as (the channel's `runAs`), in the channel's workspace, cleared at most for the label. */
  principal: Principal;
  sessionId: string;
}

/**
 * One answer of a channel whose agent's tools are on: the agent's loop, bounded and read-only. The model is offered
 * the agent's own tools and those of its skills' closure that are read tools needing no confirmation (as chat offers
 * a profile's tools); a write or destructive tool is never offered here, because nobody at a customer channel can
 * approve it. Every call goes through the one dispatcher as the channel's run-as account, at the session's label:
 * the tool's ceiling, the `tool-call` checkpoint, the domain service's own rules, and the result marked as untrusted
 * content. The skills' instructions join the system prompt. Model calls follow the profile's fallback chain. At most
 * `AGENT_REPLY.modelCalls` model calls and `AGENT_REPLY.toolCalls` tool calls; then the model answers without tools.
 */
export async function generateAgentReply(s: Services, input: AgentReplyInput): Promise<{ text: string; model: string; profile: string; promptTokens: number; outputTokens: number; tools: { name: string; ok: boolean }[]; fallbackFrom: string[] }> {
  const r = input.target.resolved;
  const def = input.target.def;
  if (!def) throw new TargetUnavailable('The channel runs an agent\'s tools, but it is not bound to an agent.');
  const p = input.principal;
  await s.quotas.admit(input.tenantId, input.workspaceId);
  const closure = await skillClosure(s.registry, p, def.skills ?? []);
  const names = [...new Set([...(def.tools ?? []), ...closure.tools])];
  const offered: ResolvedTool[] = (await s.tools.resolve(p, names, input.label)).tools.filter((t) => t.sideEffect === 'read' && t.confirm === 'never');
  const capable = (x: ResolvedProfile) => x.model.capabilities.includes('tools') && !x.model.evaluation?.toolsWithheld;
  const skills = closure.skills.map((k) => `Skill ${k.name} ${k.version}:\n${String(k.definition.instructions ?? '')}`);
  const limits = offered.length ? `You have tools. Use them to look things up before you answer; you cannot change, send or save anything from this channel, so never say that you did. After at most ${AGENT_REPLY.toolCalls} tool calls, answer with what you have.` : null;
  const messages: ChatMessage[] = [{ role: 'system', content: [r.profile.system_prompt, input.target.system, ...skills, input.system, limits].filter(Boolean).join('\n\n') }, ...input.history];
  const signal = AbortSignal.timeout(input.timeoutMs);
  /** A fallback profile the run-as account may use at this label; with tools on offer, one whose model can call them. */
  const usable = async (id: string): Promise<ResolvedProfile | null> => {
    const fb = await s.gateway.resolve(input.tenantId, id);
    if (fb.model.state !== 'approved' && fb.model.state !== 'deprecated') return null;
    if (!clears(p.clearance, fb.profile.label) || labelRank(input.label) > labelRank(fb.profile.label)) return null;
    if (!authorize(p, 'inference:invoke', { tenantId: input.tenantId, label: input.label, zoneCeiling: fb.profile.label }).allow) return null;
    return offered.length && !capable(fb) ? null : fb;
  };
  let prompt = 0;
  let output = 0;
  const fallbackFrom: string[] = [];
  const called: { name: string; ok: boolean }[] = [];
  for (let round = 1; ; round++) {
    const withTools = offered.length > 0 && capable(r) && round < AGENT_REPLY.modelCalls && called.length < AGENT_REPLY.toolCalls;
    let content = '';
    let calls: NonNullable<ChatMessage['tool_calls']> = [];
    let pt = 0;
    let ot = 0;
    let gpuMs = 0;
    const got = await s.gateway.runFollowing(r, input.label, { signal }, usable, async (use, lease: Lease) => {
      content = '';
      calls = [];
      try {
        const options: Record<string, unknown> = {};
        if (use.profile.num_ctx) options.num_ctx = use.profile.num_ctx;
        if (use.profile.temperature != null) options.temperature = use.profile.temperature;
        const req: ChatRequest = { model: use.model.name, messages, options, ...(withTools ? { tools: offered.map((t) => t.def) } : {}) };
        if (use.model.capabilities.includes('thinking')) req.think = false;
        for await (const chunk of lease.client.chat(req, signal)) {
          if (chunk.message?.content) content += chunk.message.content;
          if (chunk.message?.tool_calls?.length) calls.push(...chunk.message.tool_calls);
          if (chunk.done) {
            pt = chunk.prompt_eval_count ?? 0;
            ot = chunk.eval_count ?? 0;
            gpuMs = ((chunk.prompt_eval_duration ?? 0) + (chunk.eval_duration ?? 0) + (chunk.load_duration ?? 0)) / 1e6;
          }
        }
      } finally {
        lease.release(null);
      }
    });
    const used = got.resolved;
    for (const f of got.from) if (!fallbackFrom.includes(f)) fallbackFrom.push(f);
    if (!pt && !ot) {
      pt = Math.ceil(messages.reduce((a, m) => a + m.content.length, 0) / 4);
      ot = Math.ceil(content.length / 4);
    }
    prompt += pt;
    output += ot;
    await s.quotas.record({ tenantId: input.tenantId, workspaceId: input.workspaceId, userId: null, kind: 'channel', profileId: used.profile.id, model: used.model.name, poolId: got.lease.pool.id, promptTokens: pt, outputTokens: ot, gpuMs });
    const wanted = withTools ? calls.filter((c) => c?.function?.name) : [];
    if (!wanted.length) return { text: content.trim(), model: used.model.name, profile: used.profile.name, promptTokens: prompt, outputTokens: output, tools: called, fallbackFrom };
    messages.push({ role: 'assistant', content, tool_calls: wanted });
    for (const call of wanted) {
      const tool = offered.find((t) => t.fn === call.function.name);
      const args = (call.function.arguments ?? {}) as Record<string, unknown>;
      if (!tool || called.length >= AGENT_REPLY.toolCalls) {
        messages.push({ role: 'tool', tool_name: call.function.name, content: JSON.stringify({ error: tool ? `No tool calls are left for this answer (${AGENT_REPLY.toolCalls}). Answer with what you have.` : `tool_unavailable: ${call.function.name} is not one of the tools offered here.` }) });
        continue;
      }
      const o = await s.tools.call({ principal: p, label: input.label, source: { kind: 'channel-session', id: input.sessionId }, signal, approved: false }, tool, args);
      called.push({ name: tool.entry.name, ok: o.ok });
      messages.push({ role: 'tool', tool_name: call.function.name, content: toolResultContent(o.ok ? o.result : { error: o.error ?? `${tool.entry.name} did not run.` }, { name: tool.entry.name, untrusted: o.ok ? (o.untrusted ?? null) : null, marking: r.profile.trust_marking !== false }) });
    }
  }
}
