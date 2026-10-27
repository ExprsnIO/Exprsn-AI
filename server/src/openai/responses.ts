import { ulid } from 'ulid';
import { z } from 'zod';
import { highest, type Label } from '../authz/labels.js';
import { authorize, type Principal } from '../authz/policy.js';
import { HttpProblem } from '../http/problem.js';
import type { Services } from '../services.js';
import { apiProblem, type ChatBody, type CompletionResult, type Extensions, type InputMode } from './service.js';

/*
 * `POST /v1/responses` (B-1302): a documented subset of OpenAI's Responses API, translated onto the chat completions
 * path (same profiles, clearance, quotas, guardrails, metering). Supported: `model`, `input` (a string or an array of
 * messages, function calls and function call outputs), `instructions`, `tools` (function tools, returned to the
 * caller as `function_call` items), `tool_choice`, `temperature`, `top_p`, `max_output_tokens`, `reasoning.effort`,
 * `metadata`, `stream` (events `response.created`, `response.output_text.delta`, `response.completed`), `store` and
 * `previous_response_id`. With `store: true` the exchange is saved as a chat conversation of the caller (it shows in
 * Chat and can be continued there or with `previous_response_id`, which names a stored response). The id of a stored
 * response is `resp_<message id>`. Built-in tools, background mode, `include`, conversations objects, truncation and
 * audio are not supported. `store` defaults to false here (OpenAI's default is true).
 */

const text = z.string().max(400_000);
const part = z.union([
  z.object({ type: z.enum(['input_text', 'output_text']), text }).passthrough(),
  z.object({ type: z.literal('input_image'), image_url: z.string().max(20_000_000) }).passthrough()
]);
const message = z.object({ type: z.literal('message').optional(), role: z.enum(['user', 'assistant', 'system', 'developer']), content: z.union([text, z.array(part).max(64)]) }).passthrough();
const functionCall = z.object({ type: z.literal('function_call'), call_id: z.string().min(1).max(200), name: z.string().min(1).max(64), arguments: z.string().max(200_000), id: z.string().max(200).optional() }).passthrough();
const functionOutput = z.object({ type: z.literal('function_call_output'), call_id: z.string().min(1).max(200), output: z.string().max(400_000) }).passthrough();
const item = z.union([functionCall, functionOutput, message]);

export const responsesBody = z
  .object({
    model: z.string().min(1).max(200),
    input: z.union([text.min(1), z.array(item).min(1).max(500)]),
    instructions: z.string().max(100_000).nullable().optional(),
    stream: z.boolean().nullable().optional(),
    store: z.boolean().nullable().optional(),
    previous_response_id: z.string().max(100).nullable().optional(),
    tools: z.array(z.object({ type: z.literal('function'), name: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/), description: z.string().max(4000).nullable().optional(), parameters: z.record(z.string(), z.unknown()).nullable().optional(), strict: z.boolean().nullable().optional() }).passthrough()).max(128).optional(),
    tool_choice: z.union([z.enum(['none', 'auto', 'required']), z.object({ type: z.literal('function'), name: z.string().min(1).max(64) })]).optional(),
    temperature: z.number().min(0).max(2).nullable().optional(),
    top_p: z.number().min(0).max(1).nullable().optional(),
    max_output_tokens: z.number().int().min(1).max(1_000_000).nullable().optional(),
    reasoning: z.object({ effort: z.enum(['minimal', 'low', 'medium', 'high']).nullable().optional() }).passthrough().nullable().optional(),
    metadata: z.record(z.string().max(64), z.string().max(512)).nullable().optional(),
    user: z.string().max(200).optional()
  })
  .passthrough();
export type ResponsesBody = z.infer<typeof responsesBody>;

type ChatMessageIn = ChatBody['messages'][number];

/** The id of a stored response is the id of its assistant message. */
export const responseId = (messageId: string) => `resp_${messageId}`;
const messageIdOf = (id: string): string | null => {
  const m = /^resp_([0-9A-HJKMNP-TV-Z]{26})$/.exec(id);
  return m ? m[1]! : null;
};

export interface ResponseObject {
  id: string;
  object: 'response';
  created_at: number;
  status: 'completed' | 'incomplete' | 'in_progress';
  incomplete_details: { reason: string } | null;
  error: null;
  model: string;
  instructions: string | null;
  previous_response_id: string | null;
  store: boolean;
  output: Record<string, unknown>[];
  tools: unknown[];
  tool_choice: unknown;
  temperature: number | null;
  top_p: number | null;
  max_output_tokens: number | null;
  metadata: Record<string, string>;
  usage: { input_tokens: number; output_tokens: number; total_tokens: number; input_tokens_details: { cached_tokens: number }; output_tokens_details: { reasoning_tokens: number } } | null;
  exprsn?: unknown;
}

export class ResponsesApi {
  constructor(private readonly s: () => Services) {}

  /** The input items as chat completion messages, after the stored history and the instructions. */
  private translate(body: ResponsesBody): ChatMessageIn[] {
    const items = typeof body.input === 'string' ? [{ role: 'user' as const, content: body.input }] : body.input;
    const out: ChatMessageIn[] = [];
    for (const it of items) {
      if ('type' in it && it.type === 'function_call') {
        const call = { id: it.call_id, type: 'function' as const, function: { name: it.name, arguments: it.arguments } };
        const last = out[out.length - 1];
        // Consecutive function calls belong to one assistant turn.
        if (last && last.role === 'assistant' && Array.isArray(last.tool_calls) && !last.content) last.tool_calls.push(call);
        else out.push({ role: 'assistant', content: null, tool_calls: [call] });
        continue;
      }
      if ('type' in it && it.type === 'function_call_output') {
        out.push({ role: 'tool', content: it.output, tool_call_id: it.call_id });
        continue;
      }
      const m = it as z.infer<typeof message>;
      const content = typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'input_image' ? { type: 'image_url' as const, image_url: { url: (p as { image_url: string }).image_url } } : { type: 'text' as const, text: (p as { text: string }).text }));
      out.push({ role: m.role, content } as ChatMessageIn);
    }
    return out;
  }

  /** The new turn's text as the stored question: what the user wrote, and function results as plain lines. */
  private question(body: ResponsesBody): string {
    if (typeof body.input === 'string') return body.input;
    const lines: string[] = [];
    for (const it of body.input) {
      if ('type' in it && it.type === 'function_call_output') lines.push(`Function result (${it.call_id}): ${it.output}`);
      else if (!('type' in it) || it.type === 'message' || it.type === undefined) {
        const m = it as z.infer<typeof message>;
        if (m.role !== 'user') continue;
        lines.push(typeof m.content === 'string' ? m.content : m.content.map((p) => ('text' in p ? String(p.text) : '[image]')).join('\n'));
      }
    }
    return lines.join('\n\n');
  }

  /** The response object for a result (or for the opening event, before there is one). */
  private object(body: ResponsesBody, id: string, created: number, r: CompletionResult | null, previous: string | null, store: boolean): ResponseObject {
    const output: Record<string, unknown>[] = [];
    if (r?.content) output.push({ type: 'message', id: `msg_${id.slice(5)}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: r.content, annotations: [] }] });
    for (const c of r?.toolCalls ?? []) output.push({ type: 'function_call', id: `fc_${c.id}`, call_id: c.id, name: c.function.name, arguments: c.function.arguments, status: 'completed' });
    const incomplete = r && (r.finishReason === 'length' || r.finishReason === 'content_filter');
    return {
      id,
      object: 'response',
      created_at: created,
      status: !r ? 'in_progress' : incomplete ? 'incomplete' : 'completed',
      incomplete_details: incomplete ? { reason: r.finishReason === 'length' ? 'max_output_tokens' : 'content_filter' } : null,
      error: null,
      model: body.model,
      instructions: body.instructions ?? null,
      previous_response_id: previous,
      store,
      output,
      tools: body.tools ?? [],
      tool_choice: body.tool_choice ?? 'auto',
      temperature: body.temperature ?? null,
      top_p: body.top_p ?? null,
      max_output_tokens: body.max_output_tokens ?? null,
      metadata: body.metadata ?? {},
      usage: r ? { input_tokens: r.usage.prompt_tokens, output_tokens: r.usage.completion_tokens, total_tokens: r.usage.total_tokens, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } : null,
      ...(r?.exprsn ? { exprsn: r.exprsn } : {})
    };
  }

  /**
   * One response. `onEvent` receives the streaming events (the opening event just before the first text, so a refusal
   * before generation is still an ordinary error); `approved` runs a request a reviewer approved (B-1301).
   */
  async create(p: Principal, body: ResponsesBody, label: Label, signal: AbortSignal, opts: { ext?: Extensions; approved?: boolean; onEvent?: (type: string, data: Record<string, unknown>) => void } = {}): Promise<ResponseObject> {
    const s = this.s();
    const store = !!body.store;
    if (store) {
      const d = authorize(p, 'chat:write');
      if (!d.allow) throw new HttpProblem(403, 'Forbidden', `store: true saves a conversation and needs chat:write: ${d.reason}`, { extensions: { code: `denied_${d.step}`, param: 'store', step: d.step, action: 'chat:write' } });
    }
    let previous: { messageId: string; label: Label; messages: ChatMessageIn[] } | null = null;
    if (body.previous_response_id) {
      const mid = messageIdOf(body.previous_response_id);
      if (!mid) throw apiProblem(404, `Response ${body.previous_response_id} was not found. Only stored responses (store: true) can be continued.`, 'response_not_found', 'previous_response_id');
      try {
        const t = await s.chat.apiThread(p, mid);
        previous = { messageId: mid, label: t.label, messages: t.messages as ChatMessageIn[] };
      } catch (err) {
        if (err instanceof HttpProblem && err.status === 404) throw apiProblem(404, `Response ${body.previous_response_id} was not found. Only stored responses (store: true) can be continued.`, 'response_not_found', 'previous_response_id');
        throw err;
      }
    }
    // A continued conversation keeps its label: the request is at least as sensitive as what it continues.
    const effective = previous ? highest(label, previous.label) : label;
    const instructions: ChatMessageIn[] = body.instructions ? [{ role: 'system', content: body.instructions }] : [];
    const history = previous?.messages ?? [];
    const messages = [...instructions, ...history, ...this.translate(body)];
    const stored = new Set(history.map((_, i) => i + instructions.length));
    const chatBody: ChatBody = {
      model: body.model,
      messages,
      ...(body.tools?.length ? { tools: body.tools.map((t) => ({ type: 'function' as const, function: { name: t.name, ...(t.description ? { description: t.description } : {}), ...(t.parameters ? { parameters: t.parameters } : {}) } })) } : {}),
      ...(body.tool_choice ? { tool_choice: typeof body.tool_choice === 'string' ? body.tool_choice : { type: 'function' as const, function: { name: body.tool_choice.name } } } : {}),
      ...(body.temperature != null ? { temperature: body.temperature } : {}),
      ...(body.top_p != null ? { top_p: body.top_p } : {}),
      ...(body.max_output_tokens != null ? { max_completion_tokens: body.max_output_tokens } : {}),
      ...(body.reasoning?.effort ? { reasoning_effort: body.reasoning.effort } : {})
    };
    const messageId = ulid();
    const id = store ? responseId(messageId) : `resp_${ulid()}`;
    const created = Math.floor(Date.now() / 1000);
    const prevId = body.previous_response_id ?? null;
    const ext = opts.ext ?? {};
    const input: InputMode = opts.approved ? { approved: true, stored } : s.openai.holds.mode(p, 'responses', body, ext, effective, { stored });
    let seq = 0;
    let opened = false;
    const open = () => {
      if (opened || !opts.onEvent) return;
      opened = true;
      opts.onEvent('response.created', { type: 'response.created', sequence_number: seq++, response: this.object(body, id, created, null, prevId, store) });
    };
    const r = await s.openai.chat(p, chatBody, effective, signal, {
      ext,
      input,
      ...(opts.onEvent
        ? {
            onDelta: (delta: string) => {
              open();
              opts.onEvent!('response.output_text.delta', { type: 'response.output_text.delta', sequence_number: seq++, item_id: `msg_${id.slice(5)}`, output_index: 0, content_index: 0, delta });
            }
          }
        : {})
    });
    if (opts.onEvent && !opened) {
      open();
      // Checked mode: the text is released after the output checkpoint, in one piece.
      if (r.content) opts.onEvent('response.output_text.delta', { type: 'response.output_text.delta', sequence_number: seq++, item_id: `msg_${id.slice(5)}`, output_index: 0, content_index: 0, delta: r.content });
    }
    if (store && r.resolved) {
      await s.chat.recordApiExchange(p, {
        id: messageId,
        previousId: previous?.messageId ?? null,
        label: r.resolved.label,
        question: this.question(body),
        answer: r.content,
        calls: r.toolCalls.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })),
        profileId: r.resolved.profileId,
        profileName: r.resolved.profileName,
        model: r.resolved.model,
        usage: { promptTokens: r.resolved.promptTokens, outputTokens: r.resolved.outputTokens, gpuMs: r.resolved.gpuMs },
        guard: r.finishReason === 'content_filter' ? { action: r.content.startsWith('This answer was withheld.') ? 'block' : 'redact', via: 'openai-api' } : null
      });
    }
    const out = this.object(body, id, created, r, prevId, store);
    opts.onEvent?.('response.completed', { type: 'response.completed', sequence_number: seq++, response: out });
    return out;
  }

  /** A stored response, for its owner. */
  async retrieve(p: Principal, id: string): Promise<ResponseObject> {
    const mid = messageIdOf(id);
    if (!mid) throw apiProblem(404, `Response ${id} was not found.`, 'response_not_found');
    let v: Awaited<ReturnType<Services['chat']['apiStored']>>;
    try {
      v = await this.s().chat.apiStored(p, mid);
    } catch (err) {
      if (err instanceof HttpProblem && (err.status === 404 || err.status === 409)) throw apiProblem(404, `Response ${id} was not found.`, 'response_not_found');
      throw err;
    }
    const output: Record<string, unknown>[] = [];
    if (v.content) output.push({ type: 'message', id: `msg_${mid}`, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: v.content, annotations: [] }] });
    for (const c of v.calls) output.push({ type: 'function_call', id: `fc_${c.id}`, call_id: c.id, name: c.name, arguments: c.arguments, status: 'completed' });
    return {
      id,
      object: 'response',
      created_at: Math.floor(v.createdAt / 1000),
      status: v.state === 'complete' ? 'completed' : 'incomplete',
      incomplete_details: v.state === 'complete' ? null : { reason: 'stopped' },
      error: null,
      model: v.profile ?? v.model ?? '',
      instructions: null,
      previous_response_id: v.previousId ? responseId(v.previousId) : null,
      store: true,
      output,
      tools: [],
      tool_choice: 'auto',
      temperature: null,
      top_p: null,
      max_output_tokens: null,
      metadata: {},
      usage: { input_tokens: v.usage.promptTokens, output_tokens: v.usage.outputTokens, total_tokens: v.usage.promptTokens + v.usage.outputTokens, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } }
    };
  }
}
