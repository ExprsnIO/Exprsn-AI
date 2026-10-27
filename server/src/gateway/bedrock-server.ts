import { errorKind, runInSpan, SpanKind, startChild } from '../observability/tracing.js';
import { OllamaError, type ChatChunk, type ChatMessage, type ChatRequest, type EmbedResult, type PsModel, type ShowResult, type TagModel } from './ollama.js';
import { ProviderFiltered, type FilterCategory } from './provider-filter.js';
import type { BedrockGuardrailSetting } from './repo.js';
import { Unsupported, type ModelServer, type PullProgress, type ServerOp, type ServerReport } from './server.js';

/*
 * 1.9.99-final, Sprint 60 (B-10501): Amazon Bedrock as a gateway model server (`kind: bedrock`). Bedrock's Converse
 * API is not Chat Completions, so it gets its own `ModelServer`: this file maps the gateway's Ollama-shaped requests
 * and chunks onto Converse and ConverseStream, and embeddings onto InvokeModel (Titan, Cohere), so the tool loop,
 * guardrail checkpoints, fallback and metering above it are unchanged. Where requests go, how they are signed and the
 * residency checks are the backend's (`cloud/bedrock.ts`: SigV4 with the account's session, the regional endpoint,
 * every call through the cloud transport). Bedrock holds its own models: show, load, unload, pull and delete are
 * `Unsupported` or answered from the listing.
 *
 * Mapping (Ollama → Converse):
 *   system messages      → `system: [{ text }]`, in order
 *   user                 → `{ role: 'user', content: [{ text }, { image }...] }`
 *   assistant            → `{ role: 'assistant', content: [{ text }?, { toolUse: { toolUseId, name, input } }...] }`
 *   tool                 → `{ toolResult: { toolUseId, content: [{ text }] } }` in a user turn, paired in order with
 *                          the calls of the assistant turn before it (as `openai-server.ts` pairs tool_call_id)
 *   consecutive turns of one role are merged (Converse requires alternation)
 *   tools                → `toolConfig.tools[].toolSpec { name, description, inputSchema: { json } }`
 *   temperature, top_p, num_predict, stop → `inferenceConfig { temperature, topP, maxTokens, stopSequences }`;
 *                          other options, `think`, `format` and `keep_alive` are dropped and noted (B-4303)
 * Stream (ConverseStream events → chunks): `contentBlockDelta.text` → content, `.reasoningContent.text` → thinking,
 * `contentBlockStart.toolUse` + `contentBlockDelta.toolUse.input` → one tool_calls chunk at the end (with Bedrock's
 * toolUseId as the call id), `messageStop.stopReason` → done_reason (`max_tokens` → `length`), `metadata.usage` →
 * prompt_eval_count and eval_count (the estimate of four characters a token when it is missing).
 *
 * 1.9.99-final, Sprint 61: prompt-cache reads and writes count as prompt tokens, the reads also as
 * `cached_prompt_tokens` (priced at the cached rate, B-10505). A Bedrock Guardrail (B-10506) is an extra layer on the
 * instance (`settings.cloud.guardrail`): attached as `guardrailConfig` (`mode: converse`, an intervention ends with
 * `stopReason: guardrail_intervened` and its trace names what fired), or called with ApplyGuardrail on the last user
 * message before the call and on the answer after it (`mode: apply`). Either way an intervention is a
 * `ProviderFiltered` error (provider `bedrock`), which the gateway's lease client records as a guardrail decision;
 * Exprsn-AI's own checkpoints run before and after whatever the guardrail decides, and turning it off changes none.
 */

/** One model or inference profile the account offers in the instance's region. */
export interface BedrockOffer {
  id: string;
  kind: 'foundation' | 'inference_profile';
  provider: string | null;
  name: string | null;
  input: string[];
  output: string[];
  /** ConverseStream is offered (false: chat uses Converse). */
  streaming: boolean;
  available: boolean;
  reason?: string | null;
  /** An inference profile's routing regions. */
  regions?: string[];
}

export interface ConverseOutput {
  output?: { message?: { role?: string; content?: ConverseBlock[] } };
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; cacheReadInputTokens?: number; cacheWriteInputTokens?: number };
  /** With a guardrail attached and its trace enabled: what each assessment found. */
  trace?: { guardrail?: { inputAssessment?: Record<string, GuardrailAssessment>; outputAssessments?: Record<string, GuardrailAssessment[]> } };
}

/** One Bedrock Guardrail assessment (ApplyGuardrail's `assessments`, Converse's trace). Matched text is never kept. */
export interface GuardrailAssessment {
  topicPolicy?: { topics?: { name?: string; type?: string; action?: string }[] };
  contentPolicy?: { filters?: { type?: string; confidence?: string; filterStrength?: string; action?: string }[] };
  wordPolicy?: { customWords?: { action?: string }[]; managedWordLists?: { type?: string; action?: string }[] };
  sensitiveInformationPolicy?: { piiEntities?: { type?: string; action?: string }[]; regexes?: { name?: string; action?: string }[] };
  contextualGroundingPolicy?: { filters?: { type?: string; score?: number; threshold?: number; action?: string }[] };
}

export interface ApplyGuardrailOutput {
  action?: 'GUARDRAIL_INTERVENED' | 'NONE' | string;
  outputs?: { text?: string }[];
  assessments?: GuardrailAssessment[];
}

/** What fired in a set of assessments, as filter categories (`content:hate`, `topic:<name>`, `pii:email`...). */
export function guardrailCategories(list: GuardrailAssessment[]): FilterCategory[] {
  const out: FilterCategory[] = [];
  const acted = (a?: string) => !!a && a !== 'NONE';
  const add = (category: string, action: string | undefined, severity?: string | null) => out.push({ category, filtered: acted(action), detected: acted(action), ...(severity ? { severity: severity.toLowerCase() } : {}) });
  for (const a of list) {
    for (const t of a.topicPolicy?.topics ?? []) add(`topic:${(t.name ?? 'denied').toLowerCase().replace(/\s+/g, '_').slice(0, 60)}`, t.action);
    for (const f of a.contentPolicy?.filters ?? []) add(`content:${(f.type ?? 'unknown').toLowerCase()}`, f.action, f.confidence ?? null);
    for (const w of a.wordPolicy?.customWords ?? []) add('word:custom', w.action);
    for (const w of a.wordPolicy?.managedWordLists ?? []) add(`word:${(w.type ?? 'managed').toLowerCase()}`, w.action);
    for (const e of a.sensitiveInformationPolicy?.piiEntities ?? []) add(`pii:${(e.type ?? 'unknown').toLowerCase()}`, e.action);
    for (const r of a.sensitiveInformationPolicy?.regexes ?? []) add(`regex:${(r.name ?? 'custom').toLowerCase().slice(0, 60)}`, r.action);
    for (const g of a.contextualGroundingPolicy?.filters ?? []) add(`grounding:${(g.type ?? 'grounding').toLowerCase()}`, g.action);
  }
  // One category per name: an action on any of its findings wins.
  const by = new Map<string, FilterCategory>();
  for (const c of out) {
    const had = by.get(c.category);
    if (!had || (c.filtered && !had.filtered)) by.set(c.category, c);
  }
  return [...by.values()];
}

export type ConverseBlock = {
  text?: string;
  image?: { format: string; source: { bytes: string } };
  toolUse?: { toolUseId: string; name: string; input: unknown };
  toolResult?: { toolUseId: string; content: { text?: string; json?: unknown }[]; status?: 'success' | 'error' };
  reasoningContent?: { reasoningText?: { text?: string } };
};

/** What the server needs from the cloud side (`cloud/bedrock.ts`): listing, residency, and the three runtime calls. */
export interface BedrockBackend {
  readonly region: string;
  /** What the account offers in the region (cached by the backend). */
  offers(signal?: AbortSignal): Promise<BedrockOffer[]>;
  /** Refuses (403) a model whose routing regions the account does not allow for the model's label. */
  guard(modelId: string): Promise<void>;
  converse(modelId: string, body: Record<string, unknown>, signal: AbortSignal, timeoutMs: number): Promise<ConverseOutput>;
  /** ConverseStream's events, decoded from the event-stream framing (`cloud/aws-event-stream.ts`). */
  converseStream(modelId: string, body: Record<string, unknown>, signal: AbortSignal, timeoutMs: number): AsyncIterable<{ type: string; body: Record<string, unknown> }>;
  invoke(modelId: string, body: Record<string, unknown>, signal: AbortSignal | undefined, timeoutMs: number): Promise<{ body: unknown; inputTokens: number | null }>;
  /** Sprint 61 (B-10506): ApplyGuardrail on a text, as the prompt (`INPUT`) or the answer (`OUTPUT`). */
  applyGuardrail?(id: string, version: string, source: 'INPUT' | 'OUTPUT', text: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<ApplyGuardrailOutput>;
  close?(): Promise<void>;
}

const MAPPED: Record<string, string> = { temperature: 'temperature', top_p: 'topP', num_predict: 'maxTokens', stop: 'stopSequences' };
const estimate = (s: string) => Math.ceil(s.length / 4);
const imageFormat = (b64: string) => (b64.startsWith('/9j/') ? 'jpeg' : b64.startsWith('R0lGOD') ? 'gif' : b64.startsWith('UklGR') ? 'webp' : 'png');
/** Bedrock's toolUseId is `[a-zA-Z0-9_-]+`, at most 64 characters. */
const toolId = (id: string | undefined, fallback: string) => (id && /^[\w-]{1,64}$/.test(id) ? id : fallback);

interface Turn {
  role: 'user' | 'assistant';
  content: ConverseBlock[];
}

/** Ollama-shaped messages to Converse's `system` and `messages`. */
export function toConverseMessages(messages: ChatMessage[]): { system: { text: string }[]; messages: Turn[]; toolNames: string[] } {
  const system: { text: string }[] = [];
  const turns: Turn[] = [];
  const toolNames = new Set<string>();
  let pending: string[] = [];
  const push = (role: Turn['role'], content: ConverseBlock[]) => {
    if (!content.length) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content.push(...content);
    else turns.push({ role, content });
  };
  messages.forEach((m, i) => {
    if (m.role === 'system') {
      if (m.content.trim()) system.push({ text: m.content });
      return;
    }
    if (m.role === 'assistant') {
      const blocks: ConverseBlock[] = [];
      if (m.content.trim()) blocks.push({ text: m.content });
      pending = [];
      (m.tool_calls ?? []).forEach((c, j) => {
        const id = toolId(c.id, `tooluse_${i}_${j}`);
        pending.push(id);
        toolNames.add(c.function.name);
        blocks.push({ toolUse: { toolUseId: id, name: c.function.name, input: c.function.arguments ?? {} } });
      });
      push('assistant', blocks);
      return;
    }
    if (m.role === 'tool') {
      const id = pending.shift() ?? `tooluse_${i}_0`;
      push('user', [{ toolResult: { toolUseId: id, content: [{ text: m.content || '(no output)' }] } }]);
      return;
    }
    const blocks: ConverseBlock[] = [];
    if (m.content.trim() || !m.images?.length) blocks.push({ text: m.content.trim() ? m.content : '(empty message)' });
    for (const b of m.images ?? []) blocks.push({ image: { format: imageFormat(b), source: { bytes: b } } });
    push('user', blocks);
  });
  // Converse starts with a user turn.
  if (turns[0]?.role === 'assistant') turns.unshift({ role: 'user', content: [{ text: '(conversation continues)' }] });
  return { system, messages: turns, toolNames: [...toolNames] };
}

interface WireTool {
  type?: string;
  function?: { name?: string; description?: string; parameters?: unknown };
}

/** The Converse request body for a chat request, and the options it left out. */
export function toConverseRequest(request: ChatRequest): { body: Record<string, unknown>; dropped: string[] } {
  const { system, messages, toolNames } = toConverseMessages(request.messages);
  const body: Record<string, unknown> = { messages };
  if (system.length) body.system = system;
  const dropped: string[] = [];
  const inference: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(request.options ?? {})) {
    const to = MAPPED[k];
    if (!to) {
      dropped.push(k);
      continue;
    }
    if (v == null || (k === 'num_predict' && Number(v) <= 0)) continue;
    inference[to] = k === 'stop' ? (Array.isArray(v) ? v.map(String) : [String(v)]) : k === 'num_predict' ? Math.floor(Number(v)) : v;
  }
  if (Object.keys(inference).length) body.inferenceConfig = inference;
  const tools = ((request.tools ?? []) as WireTool[])
    .filter((t) => t?.function?.name)
    .map((t) => ({ toolSpec: { name: t.function!.name!, ...(t.function!.description ? { description: t.function!.description } : {}), inputSchema: { json: (t.function!.parameters as Record<string, unknown> | undefined) ?? { type: 'object', properties: {} } } } }));
  // A conversation that carries tool turns needs a tool configuration even when this round offers no tools.
  for (const name of toolNames) if (!tools.some((t) => t.toolSpec.name === name)) tools.push({ toolSpec: { name, inputSchema: { json: { type: 'object', properties: {} } } } });
  if (tools.length) body.toolConfig = { tools };
  if (request.format !== undefined) dropped.push('format');
  if (request.think !== undefined) dropped.push('think');
  if (request.keep_alive !== undefined) dropped.push('keep_alive');
  return { body, dropped };
}

const parseArgs = (raw: string): Record<string, unknown> => {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return { _raw: raw };
  }
};

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Any failure from the backend as the gateway's error, keeping the provider's status (429 throttling, 403 access). */
function asGatewayError(err: unknown): Error {
  if (err instanceof OllamaError || (err as Error).name === 'AbortError') return err as Error;
  const e = err as { message?: string; status?: number; type?: string };
  const status = typeof e.status === 'number' ? e.status : e.type === 'throttlingException' ? 429 : e.type === 'validationException' ? 400 : e.type === 'accessDeniedException' ? 403 : 502;
  const out = new OllamaError(e.message ?? 'Bedrock failed', status);
  (out as { cause?: unknown }).cause = err;
  return out;
}

export interface BedrockServerOptions {
  /** First-response and idle limit for model calls (default 5 minutes). */
  loadTimeoutMs?: number;
  /** Options a request carried that Converse has no use for (B-4303). */
  onDropped?: (model: string, options: string[]) => void;
  /** Sprint 61 (B-10506): the instance's Bedrock Guardrail, an extra layer (`settings.cloud.guardrail`). */
  guardrail?: BedrockGuardrailSetting | null;
}

export class BedrockServer implements ModelServer {
  readonly kind = 'bedrock' as const;
  private readonly loadTimeoutMs: number;
  private readonly state: ServerReport = { server: 'bedrock', contextLength: null };
  private offered: BedrockOffer[] = [];
  /** Models whose ConverseStream refused the request (some models stream no tool use): they use Converse. */
  private readonly unary = new Set<string>();

  constructor(
    private readonly backend: BedrockBackend,
    private readonly o: BedrockServerOptions = {}
  ) {
    this.loadTimeoutMs = o.loadTimeoutMs ?? 5 * 60_000;
  }

  supports(op: ServerOp): boolean {
    return op === 'version' || op === 'models' || op === 'chat' || op === 'embed';
  }

  report(): ServerReport {
    return { ...this.state, ...(this.state.models ? { models: this.state.models.map((m) => ({ ...m })) } : {}) };
  }

  async version(): Promise<string> {
    await this.refresh();
    return `bedrock ${this.backend.region}`.slice(0, 40);
  }

  private async refresh(): Promise<BedrockOffer[]> {
    try {
      this.offered = await this.backend.offers();
    } catch (err) {
      throw asGatewayError(err);
    }
    this.state.models = this.offered.map((m) => ({ id: m.id, available: m.available, reason: m.available ? null : (m.reason ?? 'Not offered in this region'), ownedBy: m.provider }));
    this.state.embeddings = this.offered.some((m) => m.output.includes('EMBEDDING'));
    return this.offered;
  }

  async models(): Promise<TagModel[]> {
    const list = await this.refresh();
    return list.filter((m) => m.available).map((m) => ({ name: m.id, model: m.id, size: 0, digest: '', details: { format: 'server', ...(m.provider ? { family: m.provider } : {}) } }));
  }

  loaded(): Promise<PsModel[]> {
    return Promise.reject(new Unsupported('loaded', 'bedrock'));
  }

  async show(model: string): Promise<ShowResult> {
    if (!this.offered.length) await this.refresh();
    const m = this.offered.find((x) => x.id === model);
    if (!m) throw new OllamaError(`model '${model}' not found`, 404);
    const caps = m.output.includes('EMBEDDING') ? ['embedding'] : ['completion', ...(m.input.includes('IMAGE') ? ['vision'] : [])];
    return { details: { format: 'server', ...(m.provider ? { family: m.provider } : {}) }, capabilities: caps, model_info: {} };
  }

  load(): Promise<void> {
    return Promise.reject(new Unsupported('load', 'bedrock'));
  }

  unload(): Promise<void> {
    return Promise.reject(new Unsupported('unload', 'bedrock'));
  }

  delete(): Promise<void> {
    return Promise.reject(new Unsupported('delete', 'bedrock'));
  }

  // eslint-disable-next-line require-yield
  async *pull(): AsyncGenerator<PullProgress> {
    throw new Unsupported('pull', 'bedrock');
  }

  async *chat(request: ChatRequest, signal: AbortSignal, headerTimeoutMs = this.loadTimeoutMs): AsyncGenerator<ChatChunk> {
    const { body, dropped } = toConverseRequest(request);
    if (dropped.length) this.o.onDropped?.(request.model, dropped);
    const gr = this.o.guardrail?.enabled ? this.o.guardrail : null;
    const grDetail: Record<string, string> = gr ? { guardrailId: gr.id, guardrailVersion: gr.version, guardrailMode: gr.mode } : {};
    if (gr?.mode === 'converse') body.guardrailConfig = { guardrailIdentifier: gr.id, guardrailVersion: gr.version, trace: 'enabled' };
    const span = startChild('gateway chat stream', SpanKind.CLIENT, { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': request.model, 'gen_ai.provider.name': 'aws.bedrock' });
    const t0 = Date.now();
    let firstAt: number | null = null;
    try {
      await runInSpan(span, () => this.backend.guard(request.model)).catch((err: unknown) => {
        throw asGatewayError(err);
      });
      if (gr?.mode === 'apply') await this.applyGuardrail(gr, 'INPUT', [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '', '', signal, headerTimeoutMs, grDetail);
      const offer = this.offered.find((x) => x.id === request.model);
      const calls = new Map<number, { id: string; name: string; args: string }>();
      let usage: ConverseOutput['usage'] | null = null;
      let stop: string | null = null;
      let content = '';
      let thinking = '';
      const text = (t: string, reason: string): ChatChunk | null => {
        if (!t && !reason) return null;
        firstAt ??= Date.now();
        content += t;
        thinking += reason;
        return { message: { role: 'assistant', content: t, ...(reason ? { thinking: reason } : {}) }, done: false };
      };
      let streamed = false;
      let trace: ConverseOutput['trace'] | null = null;
      if (offer?.streaming !== false && !this.unary.has(request.model)) {
        try {
          const streamBody = gr?.mode === 'converse' ? { ...body, guardrailConfig: { ...(body.guardrailConfig as Record<string, unknown>), streamProcessingMode: 'sync' } } : body;
          for await (const ev of this.backend.converseStream(request.model, streamBody, signal, headerTimeoutMs)) {
            streamed = true;
            const b = ev.body;
            const index = Number(b.contentBlockIndex ?? 0);
            if (ev.type === 'contentBlockStart') {
              const tu = asObject(asObject(b.start).toolUse);
              if (tu.name) calls.set(index, { id: String(tu.toolUseId ?? `tooluse_${index}`), name: String(tu.name), args: '' });
            } else if (ev.type === 'contentBlockDelta') {
              const d = asObject(b.delta);
              const tu = asObject(d.toolUse);
              if (typeof tu.input === 'string') {
                const cur = calls.get(index) ?? { id: `tooluse_${index}`, name: '', args: '' };
                cur.args += tu.input;
                calls.set(index, cur);
              }
              const out = text(typeof d.text === 'string' ? d.text : '', typeof asObject(d.reasoningContent).text === 'string' ? String(asObject(d.reasoningContent).text) : '');
              if (out) yield out;
            } else if (ev.type === 'messageStop') {
              stop = typeof b.stopReason === 'string' ? b.stopReason : stop;
            } else if (ev.type === 'metadata') {
              usage = asObject(b.usage) as ConverseOutput['usage'];
              if (b.trace) trace = asObject(b.trace) as ConverseOutput['trace'];
            }
          }
        } catch (err) {
          // A model that streams no tool use (or no streaming at all) says so before the first event: use Converse.
          const e = err as { type?: string; code?: string | null; status?: number; message?: string };
          const refusal = !streamed && (e.type === 'validationException' || e.code === 'ValidationException' || e.status === 400) && /stream/i.test(e.message ?? '');
          if (!refusal) throw asGatewayError(err);
          this.unary.add(request.model);
        }
      }
      if (!streamed) {
        let r: ConverseOutput;
        try {
          r = await this.backend.converse(request.model, body, signal, headerTimeoutMs);
        } catch (err) {
          throw asGatewayError(err);
        }
        stop = r.stopReason ?? null;
        usage = r.usage ?? null;
        trace = r.trace ?? null;
        let i = 0;
        for (const block of r.output?.message?.content ?? []) {
          if (block.toolUse) calls.set(i, { id: block.toolUse.toolUseId, name: block.toolUse.name, args: JSON.stringify(block.toolUse.input ?? {}) });
          const out = text(block.text ?? '', block.reasoningContent?.reasoningText?.text ?? '');
          if (out) yield out;
          i++;
        }
      }
      // B-10506: the guardrail intervened (attached to Converse), or its ApplyGuardrail check of the answer did.
      if (stop === 'guardrail_intervened') {
        const g = trace?.guardrail ?? {};
        const input = Object.values(g.inputAssessment ?? {});
        const output = Object.values(g.outputAssessments ?? {}).flat();
        const inputFired = guardrailCategories(input).some((c) => c.filtered);
        const cats = guardrailCategories(inputFired ? input : output.length ? output : input);
        throw new ProviderFiltered('bedrock', inputFired || (!output.length && !content) ? 'prompt' : 'completion', cats, inputFired ? '' : content, grDetail);
      }
      if (gr?.mode === 'apply' && content.trim()) await this.applyGuardrail(gr, 'OUTPUT', content, content, signal, headerTimeoutMs, grDetail);
      if (calls.size) {
        firstAt ??= Date.now();
        const list = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => ({ id: c.id, function: { name: c.name, arguments: parseArgs(c.args) } }));
        yield { message: { role: 'assistant', content: '', tool_calls: list }, done: false };
      }
      const u = usage as ConverseOutput['usage'] | null;
      const end = Date.now();
      const first = firstAt ?? end;
      // Sprint 61 (B-10505): prompt-cache reads and writes are prompt tokens too; the reads are priced at the cached rate.
      const cacheRead = Math.max(0, Number(u?.cacheReadInputTokens ?? 0));
      const cacheWrite = Math.max(0, Number(u?.cacheWriteInputTokens ?? 0));
      const promptTokens = u?.inputTokens != null ? u.inputTokens + cacheRead + cacheWrite : request.messages.reduce((a, m) => a + estimate(m.content ?? ''), 0);
      const outputTokens = u?.outputTokens ?? estimate(content) + estimate(thinking) + [...calls.values()].reduce((a, c) => a + estimate(c.name + c.args), 0);
      span?.setAttributes({ 'gen_ai.response.model': request.model, 'gen_ai.usage.input_tokens': promptTokens, 'gen_ai.usage.output_tokens': outputTokens });
      yield {
        message: { role: 'assistant', content: '' },
        done: true,
        done_reason: stop === 'max_tokens' ? 'length' : 'stop',
        total_duration: (end - t0) * 1e6,
        load_duration: 0,
        prompt_eval_count: promptTokens,
        prompt_eval_duration: (first - t0) * 1e6,
        eval_count: outputTokens,
        eval_duration: (end - first) * 1e6,
        ...(cacheRead ? { cached_prompt_tokens: cacheRead } : {})
      };
      span?.ok();
    } catch (err) {
      span?.fail(errorKind(err));
      throw err;
    } finally {
      span?.end();
    }
  }

  /** ApplyGuardrail on a text; an intervention is a `ProviderFiltered` error (the prompt's or the answer's). */
  private async applyGuardrail(gr: BedrockGuardrailSetting, source: 'INPUT' | 'OUTPUT', text: string, partial: string, signal: AbortSignal, timeoutMs: number, detail: Record<string, string>): Promise<void> {
    if (!text.trim()) return;
    if (!this.backend.applyGuardrail) throw new OllamaError('This Bedrock backend cannot call ApplyGuardrail.', 503);
    let r: ApplyGuardrailOutput;
    try {
      r = await this.backend.applyGuardrail(gr.id, gr.version, source, text, signal, timeoutMs);
    } catch (err) {
      throw asGatewayError(err);
    }
    if (r.action !== 'GUARDRAIL_INTERVENED') return;
    throw new ProviderFiltered('bedrock', source === 'INPUT' ? 'prompt' : 'completion', guardrailCategories(r.assessments ?? []), partial, detail);
  }

  /**
   * Embeddings through InvokeModel: Amazon Titan (`amazon.titan-embed-*`, one text a call: `inputText` →
   * `embedding`, `inputTextTokenCount`) and Cohere (`cohere.embed-*`, up to 96 texts: `texts`, `input_type` →
   * `embeddings`). Token counts from the body, else Bedrock's `X-Amzn-Bedrock-Input-Token-Count`, else the estimate.
   */
  async embed(model: string, input: string[], signal?: AbortSignal): Promise<EmbedResult> {
    const t0 = Date.now();
    const family = /(^|\.)amazon\.titan-embed/.test(model) ? 'titan' : /(^|\.)cohere\.embed/.test(model) ? 'cohere' : null;
    if (!family) throw new OllamaError(`${model} is not an embedding model this server can call (Amazon Titan or Cohere embeddings).`, 400);
    try {
      await this.backend.guard(model);
      const embeddings: number[][] = [];
      let tokens = 0;
      if (family === 'titan') {
        for (const text of input) {
          const r = await this.backend.invoke(model, { inputText: text }, signal, this.loadTimeoutMs);
          const b = asObject(r.body);
          if (!Array.isArray(b.embedding)) throw new OllamaError(`${model} answered without an embedding`, 502);
          embeddings.push(b.embedding as number[]);
          tokens += Number(b.inputTextTokenCount ?? r.inputTokens ?? estimate(text));
        }
      } else {
        for (let i = 0; i < input.length; i += 96) {
          const batch = input.slice(i, i + 96);
          const r = await this.backend.invoke(model, { texts: batch, input_type: 'search_document', truncate: 'END' }, signal, this.loadTimeoutMs);
          const b = asObject(r.body);
          const raw = b.embeddings;
          // `embedding_types` answers `{ float: [...] }`; the default answers the list itself.
          const list = Array.isArray(raw) ? raw : Array.isArray(asObject(raw).float) ? (asObject(raw).float as unknown[]) : null;
          if (!list || list.length !== batch.length) throw new OllamaError(`${model} returned ${list?.length ?? 0} embeddings for ${batch.length} inputs`, 502);
          embeddings.push(...(list as number[][]));
          tokens += r.inputTokens ?? batch.reduce((a, x) => a + estimate(x), 0);
        }
      }
      return { model, embeddings, total_duration: (Date.now() - t0) * 1e6, load_duration: 0, prompt_eval_count: tokens };
    } catch (err) {
      throw asGatewayError(err);
    }
  }

  async close(): Promise<void> {
    await this.backend.close?.();
  }
}

/** A `kind: bedrock` instance on a server with no cloud plane (or before it is wired): every call says why. */
export class UnavailableServer implements ModelServer {
  constructor(
    readonly kind: 'bedrock',
    private readonly why: string
  ) {}
  supports(op: ServerOp): boolean {
    return op === 'version' || op === 'models' || op === 'chat' || op === 'embed';
  }
  private fail(): never {
    throw new OllamaError(this.why, 503);
  }
  async version(): Promise<string> {
    return this.fail();
  }
  async models(): Promise<TagModel[]> {
    return this.fail();
  }
  loaded(): Promise<PsModel[]> {
    return Promise.reject(new Unsupported('loaded', this.kind));
  }
  async show(): Promise<ShowResult> {
    return this.fail();
  }
  load(): Promise<void> {
    return Promise.reject(new Unsupported('load', this.kind));
  }
  unload(): Promise<void> {
    return Promise.reject(new Unsupported('unload', this.kind));
  }
  delete(): Promise<void> {
    return Promise.reject(new Unsupported('delete', this.kind));
  }
  // eslint-disable-next-line require-yield
  async *pull(): AsyncGenerator<PullProgress> {
    throw new Unsupported('pull', this.kind);
  }
  // eslint-disable-next-line require-yield
  async *chat(): AsyncGenerator<ChatChunk> {
    this.fail();
  }
  async embed(): Promise<EmbedResult> {
    return this.fail();
  }
  async close(): Promise<void> {}
}
