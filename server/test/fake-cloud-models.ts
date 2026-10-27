/*
 * 1.9.99-final, Sprint 60 (B-10502, B-10503, B-10509): the Chat Completions answer the cloud model fakes share
 * (`fake-azure-openai.ts`, the GenAI part of `fake-do.ts`, the Workers AI part of `fake-cloudflare.ts`): plain or
 * streamed (server-sent events, usage in the last chunk), tool calls split across two deltas, and room for a
 * provider's extras on each choice (Azure's `content_filter_results`). They are never the real services.
 */
import type { Reply } from './fake-cloud-base.js';

export interface WireMessage {
  role: string;
  content: string | null | { type: string; text?: string }[];
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface ModelAnswer {
  content: string;
  toolCall?: { name: string; arguments: Record<string, unknown> };
  /** Overrides the finish reason (`content_filter`). */
  finish?: string;
  /** Extra fields on the (last) choice, such as Azure's `content_filter_results`. */
  choiceExtra?: Record<string, unknown>;
  /** Extra fields on the first streamed chunk / the completion, such as Azure's `prompt_filter_results`. */
  extra?: Record<string, unknown>;
}

export const textOf = (c: WireMessage['content']): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text ?? '').join('') : '');

/** The default model: a tool result is answered, a request with tools gets a call of the first tool, else an echo. */
export function defaultAnswer(messages: WireMessage[], tools: { function?: { name?: string } }[]): ModelAnswer {
  const last = messages[messages.length - 1];
  if (last?.role === 'tool') return { content: `The tool said: ${textOf(last.content)}` };
  const first = tools[0]?.function?.name;
  if (first) return { content: '', toolCall: { name: first, arguments: { expression: '17 * 23' } } };
  return { content: `You said: ${textOf(last?.content ?? '')}` };
}

const estimate = (s: string) => Math.max(1, Math.ceil(s.length / 4));

/** A Chat Completions reply for `body`, streamed when it asks; `usage` from the estimate unless given. */
export function completionReply(body: Record<string, unknown>, model: string, a: ModelAnswer, o: { usage?: { prompt_tokens: number; completion_tokens: number } } = {}): Reply {
  const messages = (body.messages ?? []) as WireMessage[];
  const usage = o.usage ?? { prompt_tokens: messages.reduce((n, m) => n + estimate(textOf(m.content)), 0), completion_tokens: estimate(a.content + (a.toolCall ? JSON.stringify(a.toolCall) : '')) };
  const id = `chatcmpl-${Math.random().toString(36).slice(2, 10)}`;
  const created = Math.floor(Date.now() / 1000);
  const finish = a.finish ?? (a.toolCall ? 'tool_calls' : 'stop');
  const call = a.toolCall ? { id: `call_${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name: a.toolCall.name, arguments: JSON.stringify(a.toolCall.arguments) } } : null;
  if (body.stream !== true) {
    return { status: 200, body: { id, object: 'chat.completion', created, model, choices: [{ index: 0, message: { role: 'assistant', content: a.content || (call ? null : ''), ...(call ? { tool_calls: [call] } : {}) }, finish_reason: finish, ...(a.choiceExtra ?? {}) }], usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens }, ...(a.extra ?? {}) } };
  }
  const events: unknown[] = [];
  if (a.extra) events.push({ id, object: 'chat.completion.chunk', created, model: '', choices: [], ...a.extra });
  events.push({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
  const words = a.content.split(/(?<= )/);
  for (const w of words) if (w) events.push({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { content: w }, finish_reason: null }] });
  if (call) {
    const args = call.function.arguments;
    const half = Math.floor(args.length / 2);
    events.push({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.function.name, arguments: args.slice(0, half) } }] }, finish_reason: null }] });
    events.push({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] }, finish_reason: null }] });
  }
  events.push({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: finish, ...(a.choiceExtra ?? {}) }] });
  const streamUsage = (body.stream_options as { include_usage?: boolean } | undefined)?.include_usage === true;
  if (streamUsage) events.push({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens } });
  return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n' };
}

/** `/v1/embeddings`: a small deterministic vector per input. */
export function embeddingReply(body: Record<string, unknown>, model: string): Reply {
  const input = Array.isArray(body.input) ? (body.input as string[]) : [String(body.input ?? '')];
  const vec = (s: string) => Array.from({ length: 8 }, (_, i) => ((s.charCodeAt(i % Math.max(1, s.length)) || 1) % 17) / 17);
  return { status: 200, body: { object: 'list', model, data: input.map((s, index) => ({ object: 'embedding', index, embedding: vec(s) })), usage: { prompt_tokens: input.reduce((n, s) => n + estimate(s), 0), total_tokens: input.reduce((n, s) => n + estimate(s), 0) } } };
}
