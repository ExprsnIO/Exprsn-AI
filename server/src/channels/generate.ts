import { labelRank, type Label } from '../authz/labels.js';
import type { Lease, ResolvedProfile } from '../gateway/gateway.js';
import type { ChatMessage, ChatRequest } from '../gateway/ollama.js';
import { HttpProblem } from '../http/problem.js';
import type { AgentDefinition } from '../registry/service.js';
import type { Services } from '../services.js';

/*
 * Model calls for customer channels (B-2301). Only the gateway talks to Ollama. A channel is bound to a published
 * profile, or to a published agent (its profile and system prompt; customer channels never run an agent's tools).
 * The channel's label must fit under the profile's (and the agent's) label, and the gateway only leases a pool cleared
 * for it, so an answer never comes from a model or pool below the channel's label. The tenant's quota is admitted and
 * the use metered to the channel's workspace.
 */

export class TargetUnavailable extends Error {}

export interface Target {
  resolved: ResolvedProfile;
  /** The agent's published name and version, when the channel is bound to an agent. */
  agent: { name: string; version: string; label: Label } | null;
  system: string | null;
}

/** The profile (and agent) a channel answers with, checked against the channel's label now. */
export async function resolveTarget(s: Services, c: { tenantId: string; workspaceId: string; targetKind: 'profile' | 'agent'; targetName: string; label: Label }): Promise<Target> {
  let profileName = c.targetName;
  let agent: Target['agent'] = null;
  let system: string | null = null;
  if (c.targetKind === 'agent') {
    const e = await s.registry.resolve({ tenantId: c.tenantId, workspaceId: c.workspaceId }, c.targetName, 'agent');
    if (!e) throw new TargetUnavailable(`No published agent named ${c.targetName} is visible in the channel's workspace.`);
    const def = e.definition as unknown as AgentDefinition;
    if (labelRank(c.label) > labelRank(e.label)) throw new TargetUnavailable(`Agent ${e.name} handles data up to ${e.label}; the channel is ${c.label}.`);
    profileName = def.profile;
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
  return { resolved, agent, system };
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
