/**
 * 1.6.0 Sprint 36b (B-11707): how a model is made to think.
 *
 * A catalogue entry records one of three modes: `native` (the server's `think` parameter, as Qwen 3 and gpt-oss
 * accept it), `template` (a convention in the system prompt, as Magistral's `<think>` blocks, which the model's own
 * default system prompt describes), or `none`. Profiles inherit the mode from their model: a profile asks for a
 * level (off, low, medium, high) and this module turns the level into the request the model understands, so a
 * profile on a template model thinks without a hand-written convention in its system prompt. Ollama substitutes the
 * model's default system prompt when a request carries none; sending our own loses that convention, which is why the
 * template is appended here and why the catalogue evaluation sends a system prompt as chat does.
 */
import type { ChatMessage, ShowResult } from './ollama.js';
import type { ThinkLevel } from './repo.js';

export type ThinkingMode = 'native' | 'template' | 'none';
export const THINKING_MODES: ThinkingMode[] = ['native', 'template', 'none'];

/** The convention appended to the system prompt of a template model when no better one is recorded. */
export const DEFAULT_THINK_TEMPLATE =
  'First draft your thinking process (inner monologue) until you have derived the final answer, then write the answer. ' +
  'Your thinking process must follow the template below:\n<think>\nYour thoughts or draft, like working through an exercise on scratch paper.\n</think>\n' +
  'Here, write the answer the user will read: concise and self-contained.';

/** What a template model is told when thinking is off: without any system message the server substitutes the model's own, which asks for a draft. */
export const NO_THINK_PROMPT = 'Answer the user directly and concisely, without a thinking draft.';

/** A system prompt the catalogue evaluation sends, as chat sends a profile's, so the server substitutes none of its own. */
export const EVALUATION_SYSTEM_PROMPT = 'You are a careful assistant answering a conformance test. Follow the instruction exactly; when a tool fits the task, call it.';

export type ThinkingModelLike = { name: string; capabilities: string[]; thinking?: ThinkingMode | null; thinking_template?: string | null };

/** The mode of a model: what the catalogue records, else derived from its capabilities. */
export function thinkingMode(m: Pick<ThinkingModelLike, 'capabilities' | 'thinking'>): ThinkingMode {
  if (m.thinking) return m.thinking;
  return m.capabilities.includes('thinking') ? 'native' : 'none';
}

const hasThinkTags = (s: string | undefined): boolean => !!s && /<think>/i.test(s);

/**
 * What the server's `show` says about thinking: a chat template that renders `<think>` and a default system prompt
 * that asks for it mean a template model (its default system prompt is kept as the convention); the thinking
 * capability alone means native; otherwise none.
 */
export function detectThinking(show: Pick<ShowResult, 'capabilities' | 'template' | 'system'>): { thinking: ThinkingMode; thinking_template: string | null } {
  const native = (show.capabilities ?? []).includes('thinking');
  if (hasThinkTags(show.system)) return { thinking: 'template', thinking_template: show.system!.trim() };
  if (hasThinkTags(show.template) && !native) return { thinking: 'template', thinking_template: null };
  return { thinking: native ? 'native' : 'none', thinking_template: null };
}

/** The server parameter for a level on a native model (gpt-oss takes the level; others a boolean). */
export const nativeThinkParam = (modelName: string, level: ThinkLevel): boolean | 'low' | 'medium' | 'high' => (level === 'off' ? false : modelName.startsWith('gpt-oss') ? level : true);

/**
 * Turns a profile's thinking level into the request for its model. For a template model with thinking on, the
 * convention is appended to the system message (one is added when the profile has none) unless the prompt already
 * carries `<think>`; the server still gets `think: true` when it claims the capability, so one that parses the tags
 * delivers thinking separately, and `ThinkSplitter` catches the tags of one that does not. With thinking off, a
 * template model without a system prompt gets one that asks for a direct answer, or the server would substitute
 * the model's own and the draft would come anyway.
 */
export function thinkingRequest(model: ThinkingModelLike, level: ThinkLevel, messages: ChatMessage[]): { think?: boolean | 'low' | 'medium' | 'high' } {
  const mode = thinkingMode(model);
  if (mode === 'none') return {};
  if (mode === 'native') return model.capabilities.includes('thinking') ? { think: nativeThinkParam(model.name, level) } : {};
  const on = level !== 'off';
  const system = messages.find((m) => m.role === 'system');
  if (on) {
    const convention = model.thinking_template?.trim() || DEFAULT_THINK_TEMPLATE;
    if (!system) messages.unshift({ role: 'system', content: convention });
    else if (!hasThinkTags(system.content)) system.content = `${system.content.trimEnd()}\n\n${convention}`;
  } else if (!system) messages.unshift({ role: 'system', content: NO_THINK_PROMPT }); // or the server substitutes the model's own
  return model.capabilities.includes('thinking') ? { think: on } : {};
}

/** Splits `<think>…</think>` out of a streamed answer, across chunk boundaries; text outside the tags is content. */
export class ThinkSplitter {
  private inThink = false;
  private buffer = '';
  private seen = false;

  constructor(private readonly open = '<think>', private readonly close = '</think>') {}

  feed(chunk: string): { thinking: string; content: string } {
    this.buffer += chunk;
    let thinking = '';
    let content = '';
    for (;;) {
      if (this.inThink) {
        const i = this.buffer.indexOf(this.close);
        if (i < 0) {
          const keep = this.tail(this.close);
          thinking += this.buffer.slice(0, this.buffer.length - keep);
          this.buffer = this.buffer.slice(this.buffer.length - keep);
          return { thinking, content };
        }
        thinking += this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + this.close.length).replace(/^\n/, '');
        this.inThink = false;
      } else {
        const i = this.buffer.indexOf(this.open);
        if (i < 0) {
          const keep = this.tail(this.open);
          content += this.buffer.slice(0, this.buffer.length - keep);
          this.buffer = this.buffer.slice(this.buffer.length - keep);
          return { thinking, content };
        }
        content += this.buffer.slice(0, i);
        this.buffer = this.buffer.slice(i + this.open.length).replace(/^\n/, '');
        this.inThink = true;
        this.seen = true;
      }
    }
  }

  /** What is left when the stream ends: an unterminated block counts as thinking, anything else as content. */
  flush(): { thinking: string; content: string } {
    const rest = this.buffer;
    this.buffer = '';
    return this.inThink ? { thinking: rest, content: '' } : { thinking: '', content: rest };
  }

  /** Whether a `<think>` block was seen. */
  get split(): boolean {
    return this.seen;
  }

  private tail(tag: string): number {
    // A partial tag at the end of the buffer waits for the next chunk.
    for (let n = Math.min(tag.length - 1, this.buffer.length); n > 0; n--) if (tag.startsWith(this.buffer.slice(-n))) return n;
    return 0;
  }
}

/** One-shot split of a finished answer. */
export function splitThink(text: string): { thinking: string; content: string } {
  const s = new ThinkSplitter();
  const a = s.feed(text);
  const b = s.flush();
  return { thinking: a.thinking + b.thinking, content: a.content + b.content };
}
