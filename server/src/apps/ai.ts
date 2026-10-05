import { labelRank, type Label } from '../authz/labels.js';
import { authorize, type Principal } from '../authz/policy.js';
import type { Lease } from '../gateway/gateway.js';
import type { ChatMessage, ChatRequest } from '../gateway/ollama.js';
import { HttpProblem } from '../http/problem.js';
import type { Services } from '../services.js';

/*
 * Model calls for the low-code apps (B-2207): AI fields and natural-language drafts. Only the gateway talks to Ollama:
 * the profile is resolved and its model must be approved, the caller (when there is one) must hold
 * `inference:invoke` within the profile's label ceiling, the data's label must fit under the profile's, the tenant's
 * quota is admitted and the use metered. The answer passes the `model-output` guardrail checkpoint.
 */

export class ModelUnavailable extends Error {}

export interface GenerateInput {
  tenantId: string;
  workspaceId: string | null;
  profile: string;
  system?: string;
  prompt: string;
  label: Label;
  /** Who the call is for; null for work without a person (a public form's record). */
  principal: Principal | null;
  userId: string | null;
  json?: boolean;
  signal?: AbortSignal;
  source: { kind: string; id: string };
}

export async function generate(s: Services, input: GenerateInput): Promise<string> {
  const r = await s.gateway.resolve(input.tenantId, input.profile);
  if (r.model.state !== 'approved' && r.model.state !== 'deprecated') throw new ModelUnavailable(`Profile ${r.profile.name} routes to ${r.model.name}, which is ${r.model.state}.`);
  if (input.principal) {
    const d = authorize(input.principal, 'inference:invoke', { tenantId: input.tenantId, label: input.label, zoneCeiling: r.profile.label });
    if (!d.allow) throw new ModelUnavailable(d.reason);
  } else if (labelRank(input.label) > labelRank(r.profile.label)) throw new ModelUnavailable(`Profile ${r.profile.name} handles data up to ${r.profile.label}; the record is ${input.label}.`);
  await s.quotas.admit(input.tenantId, input.workspaceId);
  const messages: ChatMessage[] = [];
  const system = [r.profile.system_prompt, input.system].filter(Boolean).join('\n\n');
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: input.prompt });
  const options: Record<string, unknown> = {};
  if (r.profile.num_ctx) options.num_ctx = r.profile.num_ctx;
  if (r.profile.temperature != null) options.temperature = r.profile.temperature;
  const req: ChatRequest & { format?: unknown } = { model: r.model.name, messages, options };
  if (r.model.capabilities.includes('thinking')) req.think = false;
  if (input.json) req.format = 'json';
  const signal = input.signal ?? AbortSignal.timeout(s.cfg.OLLAMA_TIMEOUT_MS);
  let lease: Lease | null = null;
  let text = '';
  let prompt = 0;
  let output = 0;
  let gpuMs = 0;
  try {
    lease = await s.gateway.acquire(r.profile, r.model, input.label, { signal });
    for await (const chunk of lease.client.chat(req, signal)) {
      if (chunk.message?.content) text += chunk.message.content;
      if (chunk.done) {
        prompt += chunk.prompt_eval_count ?? 0;
        output += chunk.eval_count ?? 0;
        gpuMs += ((chunk.prompt_eval_duration ?? 0) + (chunk.eval_duration ?? 0) + (chunk.load_duration ?? 0)) / 1e6;
      }
    }
  } finally {
    lease?.release();
  }
  if (!prompt && !output) {
    prompt = Math.ceil(messages.reduce((a, m) => a + m.content.length, 0) / 4);
    output = Math.ceil(text.length / 4);
  }
  await s.quotas.record({ tenantId: input.tenantId, workspaceId: input.workspaceId, userId: input.userId, kind: 'workflow', profileId: r.profile.id, model: r.model.name, poolId: lease?.pool.id ?? null, promptTokens: prompt, outputTokens: output, gpuMs });
  const d = await s.guardrails.check({ tenantId: input.tenantId, workspaceId: input.workspaceId, checkpoint: 'model-output', text, label: input.label, ...(input.principal ? { principal: input.principal } : {}), source: input.source });
  if (d.action === 'block' || d.action === 'require-approval') throw new ModelUnavailable(`The answer was held by guardrails${d.reason ? `: ${d.reason}` : '.'}`);
  return d.action === 'redact' ? d.text : text;
}

/** The first JSON object in a model's answer (models sometimes wrap it in a code fence). */
export function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) throw new HttpProblem(422, 'Draft not usable', 'The model did not answer with a JSON object.');
  try {
    const v = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v as Record<string, unknown>;
  } catch {
    throw new HttpProblem(422, 'Draft not usable', 'The model did not answer with valid JSON.');
  }
}
