import { ulid } from 'ulid';
import { z } from 'zod';
import { clears, labelRank, type Label } from '../authz/labels.js';
import { authorize, type Principal } from '../authz/policy.js';
import { actorFrom } from '../audit/chain.js';
import { badRequest, forbidden, HttpProblem } from '../http/problem.js';
import { QueueTimeout, type Lease, type ResolvedProfile } from '../gateway/gateway.js';
import { THINK_LEVELS, type ThinkLevel } from '../gateway/repo.js';
import type { ChatMessage } from '../gateway/ollama.js';
import type { Services } from '../services.js';

/*
 * The OpenAI-compatible API (B-301), behind `/v1`. It is a thin translation onto the same paths chat uses: profiles
 * (and their aliases) are the models, resolved and cleared exactly as in chat (clearance, zone ceiling, workspace
 * ceiling), quotas admit the request (429 when a limit is reached), every caller-supplied message passes the
 * `user-input` checkpoint and the answer the `model-output` checkpoint, the gateway leases the slot (the only path to
 * Ollama), and the usage is metered as kind `api`. Requests are stateless: nothing is stored as a conversation.
 */

const text = z.string().max(400_000);
const contentPart = z.union([
  z.object({ type: z.literal('text'), text }).passthrough(),
  z.object({ type: z.literal('image_url'), image_url: z.union([z.string(), z.object({ url: z.string(), detail: z.string().optional() }).passthrough()]) }).passthrough()
]);
const content = z.union([text, z.array(contentPart).max(64)]).nullable().optional();
const toolCall = z.object({ id: z.string().max(200), type: z.literal('function').default('function'), function: z.object({ name: z.string().max(200), arguments: z.string().max(200_000) }) });

export const chatBody = z
  .object({
    model: z.string().min(1).max(200),
    messages: z
      .array(
        z.discriminatedUnion('role', [
          z.object({ role: z.literal('system'), content, name: z.string().max(100).optional() }).passthrough(),
          z.object({ role: z.literal('developer'), content, name: z.string().max(100).optional() }).passthrough(),
          z.object({ role: z.literal('user'), content, name: z.string().max(100).optional() }).passthrough(),
          z.object({ role: z.literal('assistant'), content, tool_calls: z.array(toolCall).max(64).optional(), name: z.string().max(100).optional() }).passthrough(),
          z.object({ role: z.literal('tool'), content, tool_call_id: z.string().max(200) }).passthrough()
        ])
      )
      .min(1)
      .max(500),
    tools: z.array(z.object({ type: z.literal('function'), function: z.object({ name: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/), description: z.string().max(4000).optional(), parameters: z.record(z.string(), z.unknown()).optional(), strict: z.boolean().nullable().optional() }).passthrough() })).max(128).optional(),
    tool_choice: z.union([z.enum(['none', 'auto', 'required']), z.object({ type: z.literal('function'), function: z.object({ name: z.string() }) })]).optional(),
    temperature: z.number().min(0).max(2).nullable().optional(),
    top_p: z.number().min(0).max(1).nullable().optional(),
    max_tokens: z.number().int().min(1).max(1_000_000).nullable().optional(),
    max_completion_tokens: z.number().int().min(1).max(1_000_000).nullable().optional(),
    stop: z.union([z.string().max(200), z.array(z.string().max(200)).max(8)]).nullable().optional(),
    seed: z.number().int().nullable().optional(),
    presence_penalty: z.number().min(-2).max(2).nullable().optional(),
    frequency_penalty: z.number().min(-2).max(2).nullable().optional(),
    n: z.literal(1).nullable().optional(),
    stream: z.boolean().nullable().optional(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).passthrough().nullable().optional(),
    user: z.string().max(200).optional(),
    reasoning_effort: z.enum(['minimal', 'low', 'medium', 'high']).nullable().optional()
  })
  .passthrough();
export type ChatBody = z.infer<typeof chatBody>;

export const embeddingsBody = z
  .object({
    model: z.string().min(1).max(200),
    input: z.union([z.string().max(400_000), z.array(z.string().max(400_000)).min(1).max(256)]),
    encoding_format: z.enum(['float', 'base64']).optional(),
    dimensions: z.number().int().positive().optional(),
    user: z.string().max(200).optional()
  })
  .passthrough();
export type EmbeddingsBody = z.infer<typeof embeddingsBody>;

export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface CompletionResult {
  id: string;
  created: number;
  model: string;
  content: string;
  toolCalls: OpenAiToolCall[];
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter';
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/** A problem with the OpenAI error `code` (and `param`) the translation layer should report. */
export const apiProblem = (status: number, detail: string, code: string, param?: string) => new HttpProblem(status, status === 400 ? 'Bad request' : 'Error', detail, { extensions: { code, ...(param ? { param } : {}) } });

const thinkRank = (t: ThinkLevel) => THINK_LEVELS.indexOf(t);

const partsText = (c: ChatBody['messages'][number]['content']): { text: string; images: string[] } => {
  if (c == null) return { text: '', images: [] };
  if (typeof c === 'string') return { text: c, images: [] };
  const texts: string[] = [];
  const images: string[] = [];
  for (const p of c) {
    if (p.type === 'text') texts.push(p.text);
    else {
      const url = typeof p.image_url === 'string' ? p.image_url : p.image_url.url;
      // Only inline images: the server never fetches a URL on a caller's behalf.
      const m = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(url);
      if (!m) throw apiProblem(400, 'Only data: URLs with base64 images are accepted in image_url.', 'invalid_image_url', 'messages');
      images.push(m[1]!.replace(/\s+/g, ''));
    }
  }
  return { text: texts.join('\n'), images };
};

export class OpenAiService {
  constructor(
    private readonly s: () => Services,
    private readonly o: { streamMode: 'checked' | 'live' }
  ) {}

  get streamMode(): 'checked' | 'live' {
    return this.o.streamMode;
  }

  /** Profiles and aliases the caller may use, plus the embedding models in the catalogue. */
  async models(p: Principal) {
    const s = this.s();
    const profiles = await s.chat.profilesFor(p);
    const rows = await s.gateway.repo.profiles(p.tenantId);
    const created = new Map(rows.map((r) => [r.id, Math.floor(Number(r.created_at) / 1000)]));
    const out = profiles.map((x) => ({ id: x.name, object: 'model' as const, created: created.get(x.id) ?? 0, owned_by: p.tenantSlug, meta: { kind: 'profile', displayName: x.displayName, aliasOf: x.aliasOf, model: x.model, label: x.label, vision: x.vision, deprecated: x.deprecated } }));
    const names = new Set(out.map((x) => x.id));
    for (const m of await s.gateway.repo.models()) {
      if (!m.capabilities.includes('embedding') || (m.state !== 'approved' && m.state !== 'deprecated') || names.has(m.name)) continue;
      out.push({ id: m.name, object: 'model', created: Math.floor(Number(m.created_at) / 1000), owned_by: 'exprsn-ai', meta: { kind: 'embedding', displayName: m.name, aliasOf: null, model: m.name, label: m.label, vision: false, deprecated: m.state === 'deprecated' } });
    }
    return out;
  }

  private async checkLabel(p: Principal, label: Label): Promise<void> {
    if (!clears(p.clearance, label)) throw forbidden(`Your clearance is ${p.clearance}; ${label} data is above it.`, { step: 'clearance' });
    if (p.workspaceId) {
      const ws = await this.s().tenants.workspace(p.tenantId, p.workspaceId);
      if (ws && labelRank(label) > labelRank(ws.label_ceiling)) throw forbidden(`This workspace's ceiling is ${ws.label_ceiling}; the request is ${label}.`, { step: 'zone' });
    }
  }

  /** Resolves a model name to a profile the caller may use for data at `label`, as chat does. */
  private async resolve(p: Principal, name: string, label: Label): Promise<ResolvedProfile> {
    let r: ResolvedProfile;
    try {
      r = await this.s().gateway.resolve(p.tenantId, name);
    } catch (err) {
      if (err instanceof HttpProblem && err.status === 404) throw apiProblem(404, `The model ${name} does not exist or you do not have access to it.`, 'model_not_found', 'model');
      throw err;
    }
    if (r.model.state !== 'approved' && r.model.state !== 'deprecated') throw new HttpProblem(409, 'Profile unavailable', `Model ${r.profile.name} routes to ${r.model.name}, which is ${r.model.state}.`);
    if (!clears(p.clearance, r.profile.label)) throw apiProblem(404, `The model ${name} does not exist or you do not have access to it.`, 'model_not_found', 'model');
    const d = authorize(p, 'inference:invoke', { tenantId: p.tenantId, label, zoneCeiling: r.profile.label, profiles: [name, r.profile.name] });
    if (!d.allow) throw forbidden(d.step === 'zone' ? `The request is ${label}; model ${r.profile.name} only handles data up to ${r.profile.label}.` : d.reason, { step: d.step, action: 'inference:invoke' });
    return r;
  }

  private async admit(p: Principal): Promise<void> {
    const s = this.s();
    const [tenant, ws] = await Promise.all([s.tenants.byId(p.tenantId), p.workspaceId ? s.tenants.workspace(p.tenantId, p.workspaceId) : undefined]);
    await s.quotas.admit(p.tenantId, p.workspaceId ?? null, { tenantName: tenant?.name, workspaceName: ws?.name });
  }

  /** The user-input checkpoint on everything the caller sent. A block refuses the request; a redaction is what the model sees. */
  private async guardIn(p: Principal, texts: string[], label: Label, requestId: string): Promise<string[]> {
    const out: string[] = [];
    for (const t of texts) {
      if (!t) {
        out.push(t);
        continue;
      }
      const d = await this.s().guardrails.check({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, checkpoint: 'user-input', text: t, label, principal: p, source: { kind: 'api-request', id: requestId }, meta: { tokens: Math.ceil(t.length / 4), via: 'openai-api' } });
      if (d.action === 'block' || d.action === 'require-approval') throw apiProblem(400, d.reason ?? 'A guardrail refused this request.', 'content_filter', 'messages');
      out.push(d.text);
    }
    return out;
  }

  /** Converts the request's messages to Ollama's, after the input checkpoint. */
  private async messages(p: Principal, body: ChatBody, r: ResolvedProfile, label: Label, requestId: string): Promise<ChatMessage[]> {
    const vision = r.model.capabilities.includes('vision');
    const parsed = body.messages.map((m) => ({ m, ...partsText(m.content) }));
    if (!vision && parsed.some((x) => x.images.length)) throw apiProblem(400, `${r.model.name} cannot read images; use a model with vision.`, 'model_not_vision_capable', 'messages');
    const guarded = await this.guardIn(p, parsed.map((x) => (x.m.role === 'assistant' ? '' : x.text)), label, requestId);
    const toolNames = new Map<string, string>();
    const out: ChatMessage[] = [];
    if (r.profile.system_prompt) out.push({ role: 'system', content: r.profile.system_prompt });
    parsed.forEach(({ m, text, images }, i) => {
      const t = m.role === 'assistant' ? text : guarded[i]!;
      if (m.role === 'assistant') {
        const calls = (m.tool_calls ?? []).map((c) => {
          toolNames.set(c.id, c.function.name);
          let args: Record<string, unknown> = {};
          try {
            const v = JSON.parse(c.function.arguments || '{}') as unknown;
            if (v && typeof v === 'object' && !Array.isArray(v)) args = v as Record<string, unknown>;
          } catch {
            throw apiProblem(400, `The arguments of tool call ${c.id} are not valid JSON.`, 'invalid_tool_arguments', 'messages');
          }
          return { function: { name: c.function.name, arguments: args } };
        });
        out.push({ role: 'assistant', content: t, ...(calls.length ? { tool_calls: calls } : {}) });
      } else if (m.role === 'tool') {
        out.push({ role: 'tool', content: t, tool_name: toolNames.get(m.tool_call_id) ?? m.tool_call_id });
      } else out.push({ role: m.role === 'developer' ? 'system' : m.role, content: t, ...(images.length ? { images } : {}) });
    });
    return out;
  }

  private think(r: ResolvedProfile, effort: ChatBody['reasoning_effort']): boolean | 'low' | 'medium' | 'high' | undefined {
    if (!r.model.capabilities.includes('thinking')) return undefined;
    let want: ThinkLevel = effort ? (effort === 'minimal' ? 'off' : effort) : r.profile.think_default;
    if (thinkRank(want) > thinkRank(r.profile.think_ceiling)) want = r.profile.think_ceiling;
    if (want === 'off') return false;
    return r.model.name.startsWith('gpt-oss') ? want : true;
  }

  /**
   * One chat completion. `onDelta` receives answer text as it is generated (only when the stream mode is `live`); the
   * returned content is what passed the output checkpoint.
   */
  async chat(p: Principal, body: ChatBody, label: Label, signal: AbortSignal, opts: { id?: string; onDelta?: (text: string) => void } = {}): Promise<CompletionResult> {
    const s = this.s();
    const id = opts.id ?? `chatcmpl-${ulid()}`;
    const onDelta = opts.onDelta;
    const created = Math.floor(Date.now() / 1000);
    await this.checkLabel(p, label);
    let r = await this.resolve(p, body.model, label);
    const toolsWanted = !!body.tools?.length && body.tool_choice !== 'none';
    if (toolsWanted && (!r.model.capabilities.includes('tools') || r.model.evaluation?.toolsWithheld)) throw apiProblem(400, `${body.model} does not support tools.`, 'tools_not_supported', 'tools');
    await this.admit(p);
    const messages = await this.messages(p, body, r, label, id);
    if (body.tool_choice === 'required' || typeof body.tool_choice === 'object') {
      const which = typeof body.tool_choice === 'object' ? `the ${body.tool_choice.function.name} tool` : 'one of the tools';
      messages.push({ role: 'system', content: `Answer by calling ${which}.` });
    }

    const started = Date.now();
    let lease: Lease | null = null;
    let content = '';
    const calls: NonNullable<ChatMessage['tool_calls']> = [];
    let promptTokens = 0;
    let outputTokens = 0;
    let gpuMs = 0;
    let firstTokenMs: number | null = null;
    let doneReason: string | undefined;
    let counted = false;
    let failed: Error | null = null;
    try {
      const tried = new Set<string>([r.profile.id]);
      for (let hop = 0; ; hop++) {
        const fallback = hop < 3 && r.profile.fallback && !tried.has(r.profile.fallback.profileId) ? r.profile.fallback : null;
        try {
          lease = await s.gateway.acquire(r.profile, r.model, label, { signal, ...(fallback ? { waitMs: fallback.afterQueueWaitMs } : {}) });
          break;
        } catch (err) {
          if (!(err instanceof QueueTimeout) || !fallback) throw err;
          r = await this.resolve(p, fallback.profileId, label);
          tried.add(r.profile.id);
        }
      }
      const options: Record<string, unknown> = {};
      if (r.profile.num_ctx) options.num_ctx = r.profile.num_ctx;
      const temperature = body.temperature ?? r.profile.temperature;
      if (temperature != null) options.temperature = temperature;
      if (body.top_p != null) options.top_p = body.top_p;
      const maxTokens = body.max_completion_tokens ?? body.max_tokens;
      if (maxTokens != null) options.num_predict = maxTokens;
      if (body.stop != null) options.stop = Array.isArray(body.stop) ? body.stop : [body.stop];
      if (body.seed != null) options.seed = body.seed;
      if (body.presence_penalty != null) options.presence_penalty = body.presence_penalty;
      if (body.frequency_penalty != null) options.frequency_penalty = body.frequency_penalty;
      const think = this.think(r, body.reasoning_effort);
      const tools = toolsWanted ? body.tools!.map((t) => ({ type: 'function', function: { name: t.function.name, ...(t.function.description ? { description: t.function.description } : {}), parameters: t.function.parameters ?? { type: 'object', properties: {} } } })) : undefined;
      for await (const chunk of lease.client.chat({ model: r.model.name, messages, ...(think !== undefined ? { think } : {}), ...(tools ? { tools } : {}), options }, signal)) {
        const msg = chunk.message;
        if (msg && (msg.content || msg.thinking) && firstTokenMs == null) {
          firstTokenMs = Date.now() - started;
          if (lease.cold) s.gateway.noteResident(lease.instance.id, r.model.name);
        }
        if (msg?.content) {
          content += msg.content;
          if (onDelta && this.o.streamMode === 'live') onDelta(msg.content);
        }
        if (msg?.tool_calls?.length) calls.push(...msg.tool_calls);
        if (chunk.done) {
          counted = true;
          doneReason = chunk.done_reason;
          promptTokens += chunk.prompt_eval_count ?? 0;
          outputTokens += chunk.eval_count ?? 0;
          gpuMs += ((chunk.prompt_eval_duration ?? 0) + (chunk.eval_duration ?? 0) + (chunk.load_duration ?? 0)) / 1e6;
        }
      }
    } catch (err) {
      failed = err as Error;
    } finally {
      lease?.release(firstTokenMs);
    }
    if (!counted && content) {
      promptTokens = Math.ceil(messages.reduce((a, x) => a + x.content.length, 0) / 4);
      outputTokens = Math.ceil(content.length / 4);
    }
    if (promptTokens + outputTokens > 0) {
      await s.quotas.record({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, userId: p.userId, apiKeyId: p.apiKeyId, kind: 'api', profileId: r.profile.id, model: r.model.name, poolId: lease?.pool.id ?? null, promptTokens, outputTokens, gpuMs });
    }
    if (failed) {
      if (signal.aborted) throw failed;
      const detail = failed instanceof HttpProblem ? (failed.detail ?? failed.title) : failed instanceof QueueTimeout ? failed.message : `The model instance failed: ${failed.message}`;
      await s.audit.append({ tenantId: p.tenantId, action: 'api.chat.failed', kind: 'system', actor: actorFrom(p), target: { request: id, profile: r.profile.name, model: r.model.name }, label, detail: { error: String(detail).slice(0, 500) } });
      if (failed instanceof HttpProblem) throw failed;
      if (failed instanceof QueueTimeout) throw new HttpProblem(503, 'No capacity', `${failed.message} Try again later.`, { headers: { 'Retry-After': '5' } });
      throw new HttpProblem(502, 'Upstream error', String(detail));
    }

    let finishReason: CompletionResult['finishReason'] = calls.length ? 'tool_calls' : doneReason === 'length' ? 'length' : 'stop';
    if (content) {
      let d;
      try {
        d = await s.guardrails.check({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, checkpoint: 'model-output', text: content, label, principal: p, source: { kind: 'api-request', id }, meta: { profile: r.profile.name, model: r.model.name, via: 'openai-api' } });
      } catch (err) {
        s.log.error({ err, request: id }, 'model-output guardrail failed');
        d = { action: 'block' as const, text: content, findings: [], reason: 'The guardrail check could not run, so the answer is withheld.' };
      }
      if (d.action === 'block' || d.action === 'require-approval') {
        content = `This answer was withheld. ${d.reason ?? ''}`.trim();
        finishReason = 'content_filter';
      } else if (d.action === 'redact' && d.text !== content) {
        content = d.text;
        finishReason = 'content_filter';
      }
    }
    return {
      id,
      created,
      model: body.model,
      content,
      toolCalls: calls.map((c) => ({ id: `call_${ulid().toLowerCase()}`, type: 'function', function: { name: c.function.name, arguments: JSON.stringify(c.function.arguments ?? {}) } })),
      finishReason,
      usage: { prompt_tokens: promptTokens, completion_tokens: outputTokens, total_tokens: promptTokens + outputTokens }
    };
  }

  async embeddings(p: Principal, body: EmbeddingsBody, label: Label, signal: AbortSignal) {
    const s = this.s();
    await this.checkLabel(p, label);
    const model = await s.gateway.repo.modelByName(body.model);
    if (!model || !model.capabilities.includes('embedding') || (model.state !== 'approved' && model.state !== 'deprecated')) throw apiProblem(404, `The model ${body.model} does not exist or is not an embedding model.`, 'model_not_found', 'model');
    if (body.dimensions != null) throw apiProblem(400, 'dimensions is not supported; the model decides the vector size.', 'unsupported_parameter', 'dimensions');
    const d = authorize(p, 'inference:invoke', { tenantId: p.tenantId, label, zoneCeiling: model.label });
    if (!d.allow) throw forbidden(d.step === 'zone' ? `The request is ${label}; ${model.name} only handles data up to ${model.label}.` : d.reason, { step: d.step, action: 'inference:invoke' });
    await this.admit(p);
    const inputs = typeof body.input === 'string' ? [body.input] : body.input;
    if (inputs.some((x) => !x)) throw badRequest('An input is empty.');
    const texts = await this.guardIn(p, inputs, label, `embed-${ulid()}`);
    const r = await s.gateway.embed(model.name, texts, label, signal);
    await s.quotas.record({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, userId: p.userId, apiKeyId: p.apiKeyId, kind: 'embed', model: model.name, poolId: r.poolId, promptTokens: r.promptTokens, gpuMs: r.gpuMs });
    const base64 = body.encoding_format === 'base64';
    return {
      object: 'list' as const,
      data: r.embeddings.map((v, index) => ({ object: 'embedding' as const, index, embedding: base64 ? Buffer.from(new Float32Array(v).buffer).toString('base64') : v })),
      model: model.name,
      usage: { prompt_tokens: r.promptTokens, total_tokens: r.promptTokens }
    };
  }
}
