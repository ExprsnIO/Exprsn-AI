import type { ChatChunk, ChatMessage, ChatRequest } from './ollama.js';
import type { ModelServer } from './server.js';

/*
 * B-11707: model thinking templates.
 *
 * A catalogue model records how it is made to think (`models.thinking_mode`):
 * - `native`: the model server's own think option, as before.
 * - `template`: a system instruction makes the model reason between two tags (Magistral's `<think>` … `</think>`),
 *   and the gateway separates that text from the answer. Every caller of a lease's client then sees it as
 *   `message.thinking`, exactly as native thinking arrives, so the stream guards, the full output check, the sealed
 *   `thinking` column and the console's thinking panel treat both alike. The tags never reach the answer.
 * - `none`: the model does not think; a `think` option is never sent.
 * A model nobody has recorded a mode for thinks natively when its manifest lists the capability.
 */

export type ThinkingMode = 'native' | 'template' | 'none';
export const THINKING_MODES: readonly ThinkingMode[] = ['native', 'template', 'none'];

export interface ThinkingTemplate {
  /** A built-in's id, or `custom`. */
  id: string;
  name: string;
  /** Joins the system prompt of a request that asks for thinking. Empty: the model reasons in its tags unprompted. */
  system: string;
  open: string;
  close: string;
  /** The model's chat template already wrote the opening tag: the answer starts inside the thinking. */
  startsOpen?: boolean;
}

/** What `models.thinking_template` holds: a built-in by id, or a custom template. */
export type StoredTemplate = { id: string } | { system: string; open: string; close: string; startsOpen?: boolean };

const MAGISTRAL = `A user will ask you to solve a task. You should first draft your thinking process (inner monologue) until you have derived the final answer. Afterwards, write a self-contained summary of your thoughts (i.e. your summary should be succinct but contain all the critical steps you needed to reach the conclusion). You should use Markdown to format your response. Write both your thoughts and summary in the same language as the task posed by the user. NEVER use \\boxed{} in your response.

Your thinking process must follow the template below:
<think>
Your thoughts or/and draft, like working through an exercise on scratch paper. Be as casual and as long as you want until you are confident to generate a correct answer.
</think>

Here, provide a concise summary that reflects your reasoning and presents a clear final answer to the user. Don't mention that this is a summary.`;

const MAGISTRAL_TOKENS = `First draft your thinking process (inner monologue) until you arrive at a response. Format your response using Markdown, and use LaTeX for any mathematical equations. Write both your thoughts and the response in the same language as the input.

Your thinking process must follow the template below:[THINK]Your thoughts or/and draft, like working through an exercise on scratch paper. Be as casual and as long as you want until you are confident to generate the response. Use the same language as the input.[/THINK]Here, provide a self-contained response.`;

/** The built-in templates, by id. */
export const THINKING_TEMPLATES: Readonly<Record<string, ThinkingTemplate>> = {
  magistral: { id: 'magistral', name: 'Magistral (<think> tags)', system: MAGISTRAL, open: '<think>', close: '</think>' },
  'magistral-think-tokens': { id: 'magistral-think-tokens', name: 'Magistral 1.1 and later ([THINK] tokens)', system: MAGISTRAL_TOKENS, open: '[THINK]', close: '[/THINK]' },
  'think-tags': { id: 'think-tags', name: 'Reasons in <think> tags unprompted', system: '', open: '<think>', close: '</think>' }
};

/** The template a stored value names: a built-in from the code (so a corrected built-in reaches every model), or the custom one. */
export function resolveTemplate(stored: StoredTemplate | null | undefined): ThinkingTemplate | null {
  if (!stored) return null;
  if ('id' in stored) return THINKING_TEMPLATES[stored.id] ?? null;
  if (!stored.open || !stored.close) return null;
  return { id: 'custom', name: 'Custom', system: stored.system ?? '', open: stored.open, close: stored.close, ...(stored.startsOpen ? { startsOpen: true } : {}) };
}

export interface ModelThinking {
  mode: ThinkingMode;
  /** Whether someone recorded the mode on the catalogue entry (false: taken from the manifest's capabilities). */
  recorded: boolean;
  template: ThinkingTemplate | null;
}

/** How a model thinks. `capabilities` is the stored list (see `effectiveCapabilities` for the one callers read). */
export function thinkingOf(m: { thinking_mode?: string | null; thinking_template?: StoredTemplate | null; capabilities: string[] }): ModelThinking {
  const mode = THINKING_MODES.includes(m.thinking_mode as ThinkingMode) ? (m.thinking_mode as ThinkingMode) : null;
  if (mode === 'template') {
    const template = resolveTemplate(m.thinking_template);
    // A template that no longer resolves (a built-in removed) leaves the model without thinking, never with a broken one.
    return template ? { mode, recorded: true, template } : { mode: 'none', recorded: true, template: null };
  }
  if (mode) return { mode, recorded: true, template: null };
  return { mode: m.capabilities.includes('thinking') ? 'native' : 'none', recorded: false, template: null };
}

/** The capabilities callers read: `thinking` is there exactly when the model's recorded mode says it thinks. */
export function effectiveCapabilities(stored: string[], mode: string | null | undefined, template: StoredTemplate | null | undefined): string[] {
  if (!mode) return stored;
  const t = thinkingOf({ thinking_mode: mode, thinking_template: template ?? null, capabilities: stored });
  const without = stored.filter((c) => c !== 'thinking');
  return t.mode === 'none' ? without : [...without, 'thinking'];
}

/** Splits a stream of answer text into thinking (between the tags) and answer, whatever the chunk boundaries. */
export class ThinkSplitter {
  private buf = '';
  private inside: boolean;
  /** Leading white space of the answer is dropped: at its start and after each closing tag. */
  private strip = true;

  constructor(
    private readonly open: string,
    private readonly close: string,
    startsOpen = false
  ) {
    this.inside = startsOpen;
  }

  /** The length of the longest end of `text` that is a start of `tag` (kept back until the next chunk settles it). */
  private static partial(text: string, tag: string): number {
    for (let n = Math.min(tag.length - 1, text.length); n > 0; n--) if (text.endsWith(tag.slice(0, n))) return n;
    return 0;
  }

  private emit(out: { content: string; thinking: string }, text: string): void {
    if (!text) return;
    if (this.inside) {
      out.thinking += text;
      return;
    }
    if (this.strip) {
      text = text.replace(/^\s+/, '');
      if (!text) return;
      this.strip = false;
    }
    out.content += text;
  }

  push(text: string): { content: string; thinking: string } {
    const out = { content: '', thinking: '' };
    this.buf += text;
    for (;;) {
      const tag = this.inside ? this.close : this.open;
      const at = this.buf.indexOf(tag);
      if (at < 0) break;
      this.emit(out, this.buf.slice(0, at));
      this.buf = this.buf.slice(at + tag.length);
      this.inside = !this.inside;
      if (!this.inside) this.strip = true;
    }
    const keep = ThinkSplitter.partial(this.buf, this.inside ? this.close : this.open);
    this.emit(out, this.buf.slice(0, this.buf.length - keep));
    this.buf = keep ? this.buf.slice(-keep) : '';
    return out;
  }

  /** What was kept back, at the end of the stream: an unfinished tag is text after all. */
  end(): { content: string; thinking: string } {
    const out = { content: '', thinking: '' };
    this.emit(out, this.buf);
    this.buf = '';
    return out;
  }
}

/** The request a template model is sent: no `think` option, and the template's instruction when thinking is asked for. */
export function templateRequest(request: ChatRequest, template: ThinkingTemplate): ChatRequest {
  const { think, ...rest } = request;
  if (!think || !template.system) return rest;
  const messages: ChatMessage[] = [...request.messages];
  const first = messages[0];
  if (first?.role === 'system') messages[0] = { ...first, content: first.content ? `${template.system}\n\n${first.content}` : template.system };
  else messages.unshift({ role: 'system', content: template.system });
  return { ...rest, messages };
}

/** A template model's stream with its thinking moved from the answer text to `message.thinking`. */
export async function* splitThinking(chunks: AsyncIterable<ChatChunk>, template: ThinkingTemplate): AsyncGenerator<ChatChunk> {
  const split = new ThinkSplitter(template.open, template.close, template.startsOpen);
  let role = 'assistant';
  let ended = false;
  for await (const chunk of chunks) {
    const msg = chunk.message;
    if (msg?.role) role = msg.role;
    const part = msg?.content ? split.push(msg.content) : { content: '', thinking: '' };
    if (chunk.done) {
      const rest = split.end();
      part.content += rest.content;
      part.thinking += rest.thinking;
      ended = true;
    }
    const thinking = (msg?.thinking ?? '') + part.thinking;
    if (!msg) {
      if (part.content || thinking) yield { ...chunk, message: { role, content: part.content, ...(thinking ? { thinking } : {}) } };
      else yield chunk;
      continue;
    }
    // A chunk that held only part of a tag carries nothing now; its text arrives with a later one.
    if (!part.content && !thinking && !msg.tool_calls?.length && !chunk.done) continue;
    const { thinking: _native, ...plain } = msg;
    yield { ...chunk, message: { ...plain, content: part.content, ...(thinking ? { thinking } : {}) } };
  }
  if (!ended) {
    const rest = split.end();
    if (rest.content || rest.thinking) yield { message: { role, content: rest.content, ...(rest.thinking ? { thinking: rest.thinking } : {}) }, done: false };
  }
}

/**
 * The client a lease hands out for a model: the server's own for a native model; for a template model one whose
 * `chat` adds the template's instruction and separates the thinking; for a model that does not think one that never
 * sends the think option.
 */
export function withThinking(client: ModelServer, model: { thinking_mode?: string | null; thinking_template?: StoredTemplate | null; capabilities: string[] }): ModelServer {
  const t = thinkingOf(model);
  if (!t.recorded || t.mode === 'native') return client;
  const template = t.template;
  const chat: ModelServer['chat'] = template
    ? (request, signal, headerTimeoutMs) => splitThinking(client.chat(templateRequest(request, template), signal, headerTimeoutMs), template)
    : (request, signal, headerTimeoutMs) => {
        const { think: _think, ...rest } = request;
        return client.chat(rest, signal, headerTimeoutMs);
      };
  return new Proxy(client, {
    get(target, key) {
      if (key === 'chat') return chat;
      const v = Reflect.get(target, key, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    }
  });
}
