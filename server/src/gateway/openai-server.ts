import { readFileSync } from 'node:fs';
import { Agent, fetch, type Dispatcher } from 'undici';
import { errorKind, runInSpan, SpanKind, startChild, withSpan } from '../observability/tracing.js';
import { literalProblem, serviceAgent, servicePolicy, ServiceUrlRefused, type ServicePolicy } from '../platform/egress.js';
import { OllamaError, type ChatChunk, type ChatMessage, type ChatRequest, type EmbedResult, type InstanceTls, type PsModel, type ShowResult, type TagModel } from './ollama.js';
import { blockedCategories, filterCategories, ProviderFiltered } from './provider-filter.js';
import type { AiGatewayHop } from './ai-gateway-hop.js';
import { Unsupported, type ModelServer, type PullProgress, type ServerOp, type ServerReport } from './server.js';

/**
 * B-4302, B-4303: a Chat Completions server as a gateway model server: Apple's `fm serve` (over a TCP port or a Unix
 * socket), `mlx_lm.server`, llama.cpp's `llama-server`, vLLM. Health comes from `GET /health`, or `GET /v1/models`
 * when there is no `/health`; `/v1/models` lists the models; chat goes to `/v1/chat/completions` (streamed) and is
 * translated into the gateway's Ollama-shaped chunks, so the tool loop, guardrail checkpoints and metering above it
 * are unchanged. The server holds its own models: show, load, unload, pull and delete are `Unsupported`; so are
 * embeddings once `/v1/embeddings` has refused.
 */
export interface OpenAIServerOptions {
  /** A Unix socket the server listens on; the URL is then only the origin sent in requests. */
  socketPath?: string | null;
  tls?: InstanceTls | null;
  timeoutMs: number;
  policy?: ServicePolicy;
  /** First-response limit for chat and embeddings. */
  loadTimeoutMs?: number;
  /** The bearer token (read from the vault once, when first needed). */
  token?: (() => Promise<string | null>) | null;
  /** Ollama-only options a request carried that a Chat Completions server has no use for (B-4303). */
  onDropped?: (model: string, options: string[]) => void;
  /**
   * 1.9.99-final, Sprint 60 (B-10502, B-10503, B-10509): a cloud provider's Chat Completions endpoint. Absent (every
   * instance made before), the server behaves exactly as above. `azure`: Azure OpenAI and AI Foundry deployments
   * (`/openai/deployments/<model>/chat/completions?api-version=...`, the key in `api-key`, the content filter mapped
   * to `ProviderFiltered`); `digitalocean`: GenAI serverless inference (`/v1/...` on the inference endpoint);
   * `workers-ai`: Cloudflare's OpenAI-compatible endpoint (`/v1/...` under `/accounts/<id>/ai`, models from
   * `/models/search`). Cloud endpoints have no `/health` or `/props`, so neither is asked.
   */
  flavour?: CloudFlavour | null;
  /** Azure's `api-version` query parameter (default `AZURE_OPENAI_API_VERSION`). */
  apiVersion?: string | null;
  /** Headers each request carries (an Entra token, an account's token), asked for every request: the source caches and refreshes. */
  authHeaders?: (() => Promise<Record<string, string>>) | null;
  /** The models (Azure: the deployments ARM lists) when the endpoint cannot list them itself. */
  listModels?: (() => Promise<NonNullable<ServerReport['models']>>) | null;
  /**
   * 1.9.99-final, Sprint 61 (B-10908): Cloudflare AI Gateway in front of a cloud endpoint (`cloud/ai-gateway.ts`):
   * inference calls go to the hop's URL with its headers, and an answer from a gateway-side fallback is refused.
   * Absent, every call goes to the endpoint as before.
   */
  aiGateway?: (() => Promise<AiGatewayHop | null>) | null;
}

export type CloudFlavour = 'azure' | 'digitalocean' | 'workers-ai';
export const CLOUD_FLAVOURS: readonly CloudFlavour[] = ['azure', 'digitalocean', 'workers-ai'];
/** The Azure OpenAI data-plane API version used when an instance names none (a GA version). */
export const AZURE_OPENAI_API_VERSION = '2024-10-21';
/** How long a cloud endpoint's model list is kept between polls. */
const CLOUD_MODELS_TTL_MS = 5 * 60_000;
const FLAVOUR_NAME: Record<CloudFlavour, string> = { azure: 'azure-openai', digitalocean: 'do-genai', 'workers-ai': 'workers-ai' };

/** Options with a Chat Completions equivalent, and the name they go by there. */
const MAPPED: Record<string, string> = { temperature: 'temperature', top_p: 'top_p', seed: 'seed', stop: 'stop', presence_penalty: 'presence_penalty', frequency_penalty: 'frequency_penalty', num_predict: 'max_tokens' };

const estimate = (s: string) => Math.ceil(s.length / 4);
const mime = (b64: string) => (b64.startsWith('/9j/') ? 'image/jpeg' : b64.startsWith('R0lGOD') ? 'image/gif' : b64.startsWith('UklGR') ? 'image/webp' : 'image/png');

interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface WireMessage {
  role: string;
  content: string | null | { type: string; text?: string; image_url?: { url: string } }[];
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
  name?: string;
}

/** Ollama-shaped messages to Chat Completions ones: tool calls get ids, and each tool result the id of its call. */
export function toWireMessages(messages: ChatMessage[]): WireMessage[] {
  const out: WireMessage[] = [];
  let pending: string[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const calls = m.tool_calls.map((c, j) => ({ id: c.id ?? `call_${i}_${j}`, type: 'function' as const, function: { name: c.function.name, arguments: JSON.stringify(c.function.arguments ?? {}) } }));
      pending = calls.map((c) => c.id);
      out.push({ role: 'assistant', content: m.content || null, tool_calls: calls });
      return;
    }
    if (m.role === 'tool') {
      const id = pending.shift() ?? `call_${i}_0`;
      out.push({ role: 'tool', tool_call_id: id, content: m.content, ...(m.tool_name ? { name: m.tool_name } : {}) });
      return;
    }
    if (m.images?.length && m.role === 'user') {
      out.push({ role: 'user', content: [{ type: 'text', text: m.content }, ...m.images.map((b) => ({ type: 'image_url', image_url: { url: `data:${mime(b)};base64,${b}` } }))] });
      return;
    }
    out.push({ role: m.role, content: m.content });
  });
  return out;
}

/** The request body for `/v1/chat/completions`, and the Ollama-only options it left out. */
export function toWireRequest(request: ChatRequest): { body: Record<string, unknown>; dropped: string[] } {
  const body: Record<string, unknown> = { model: request.model, messages: toWireMessages(request.messages), stream: true, stream_options: { include_usage: true } };
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(request.options ?? {})) {
    const to = MAPPED[k];
    if (!to) {
      dropped.push(k);
      continue;
    }
    if (v == null || (k === 'num_predict' && Number(v) <= 0)) continue;
    body[to] = v;
  }
  if (request.tools?.length) body.tools = request.tools;
  if (request.format === 'json') body.response_format = { type: 'json_object' };
  else if (request.format && typeof request.format === 'object') body.response_format = { type: 'json_schema', json_schema: { name: 'response', strict: true, schema: request.format } };
  if (request.think !== undefined) dropped.push('think');
  if (request.keep_alive !== undefined) dropped.push('keep_alive');
  return { body, dropped };
}

/** Reads a server-sent event stream's `data:` payloads (one per event; `[DONE]` ends it). */
export async function* sseData(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = '';
  let data: string[] = [];
  const flush = function* () {
    if (data.length) {
      const d = data.join('\n');
      data = [];
      yield d;
    }
  };
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line === '') yield* flush();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  const rest = (buf + decoder.decode()).replace(/\r$/, '');
  if (rest.startsWith('data:')) data.push(rest.slice(5).replace(/^ /, ''));
  yield* flush();
}

interface WireDelta {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
}

interface WireChunk {
  choices?: { delta?: WireDelta; message?: WireDelta; finish_reason?: string | null; content_filter_results?: unknown }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } | null } | null;
  error?: { message?: string; code?: string; innererror?: { content_filter_result?: unknown } } | string;
  /** Azure: the prompt's filter results (a chunk of its own, with no choices, when streamed). */
  prompt_filter_results?: { prompt_index?: number; content_filter_results?: unknown }[];
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

export class OpenAIServer implements ModelServer {
  readonly kind = 'openai' as const;
  private readonly dispatcher: Dispatcher | undefined;
  private readonly base: string;
  private readonly configError: OllamaError | null = null;
  private readonly loadTimeoutMs: number;
  private tokenValue: Promise<string | null> | null = null;
  private healthAt = 0;
  private healthMemo: Promise<{ ok: boolean; body: Record<string, unknown> | null }> | null = null;
  private propsAt = 0;
  private propsMemo: Promise<number | null> | null = null;
  private cloudModelsAt = 0;
  private cloudModelsMemo: Promise<NonNullable<ServerReport['models']>> | null = null;
  private readonly state: ServerReport = {};

  constructor(
    url: string,
    private readonly o: OpenAIServerOptions
  ) {
    this.base = url.replace(/\/+$/, '');
    this.loadTimeoutMs = o.loadTimeoutMs ?? 5 * 60_000;
    if (o.socketPath) {
      // A Unix socket is local to this host: no address to check, no TLS.
      this.dispatcher = new Agent({ connect: { socketPath: o.socketPath } });
      return;
    }
    const policy = o.policy ?? servicePolicy();
    const literal = literalProblem(this.base, policy);
    if (literal) {
      this.configError = new OllamaError(`The instance address is refused: ${literal}`, null);
      return;
    }
    try {
      const tls = o.tls;
      this.dispatcher = serviceAgent(
        policy,
        tls && (tls.caFile || tls.certFile)
          ? {
              ...(tls.caFile ? { ca: readFileSync(tls.caFile) } : {}),
              ...(tls.certFile ? { cert: readFileSync(tls.certFile) } : {}),
              ...(tls.keyFile ? { key: readFileSync(tls.keyFile) } : {}),
              rejectUnauthorized: true
            }
          : {}
      );
    } catch (err) {
      this.configError = new OllamaError(`The instance's mTLS files could not be read: ${(err as Error).message}`, null);
    }
  }

  supports(op: ServerOp): boolean {
    if (op === 'embed') return this.state.embeddings !== false;
    return op === 'version' || op === 'models' || op === 'chat';
  }

  report(): ServerReport {
    return { ...this.state, ...(this.state.models ? { models: this.state.models.map((m) => ({ ...m })) } : {}) };
  }

  private async token(): Promise<string | null> {
    if (!this.o.token) return null;
    this.tokenValue ??= this.o.token().catch((err: Error) => {
      this.tokenValue = null;
      throw new OllamaError(`The instance's token could not be read from the vault: ${err.message}`, null);
    });
    return this.tokenValue;
  }

  /** B-10502: where a Chat Completions call goes: `/v1/<op>`, or on Azure the deployment's path with its api-version. */
  private path(op: 'chat/completions' | 'embeddings', model: string): string {
    if (this.o.flavour !== 'azure') return `/v1/${op}`;
    return `/openai/deployments/${encodeURIComponent(model)}/${op}?api-version=${encodeURIComponent(this.o.apiVersion || AZURE_OPENAI_API_VERSION)}`;
  }

  private req(method: string, path: string, body?: unknown, opts: { timeoutMs?: number | null; signal?: AbortSignal } = {}) {
    const model = body && typeof (body as { model?: unknown }).model === 'string' ? (body as { model: string }).model : null;
    let host: string | null = null;
    try {
      host = this.o.socketPath ? 'unix' : new URL(this.base).hostname;
    } catch {
      /* the config error reports it */
    }
    return withSpan(`chat-completions ${method} ${path}`, SpanKind.CLIENT, { 'http.request.method': method, 'url.path': path, ...(host ? { 'server.address': host } : {}), 'gen_ai.operation.name': path.replace(/\?.*$/, '').replace(/^\/v1\/|^\/openai\/deployments\/[^/]+\//, ''), ...(model ? { 'gen_ai.request.model': model } : {}) }, async (span) => {
      const res = await this.send(method, path, body, opts, span?.traceparent);
      span?.setAttribute('http.response.status_code', res.status);
      return res;
    });
  }

  private async send(method: string, path: string, body: unknown, opts: { timeoutMs?: number | null; signal?: AbortSignal }, traceparent: string | undefined) {
    if (this.configError) throw this.configError;
    const token = await this.token();
    // B-10502: Azure takes a key in `api-key`; an Entra token or an account's token comes from `authHeaders`.
    const auth: Record<string, string> = this.o.authHeaders ? await this.o.authHeaders().catch((err: Error) => {
      throw new OllamaError(`The instance's cloud credential could not be had: ${err.message}`, null);
    }) : token ? (this.o.flavour === 'azure' ? { 'api-key': token } : { authorization: `Bearer ${token}` }) : {};
    const signals: AbortSignal[] = [];
    if (opts.timeoutMs !== null) signals.push(AbortSignal.timeout(opts.timeoutMs ?? this.o.timeoutMs));
    if (opts.signal) signals.push(opts.signal);
    // B-10908: an inference call through Cloudflare AI Gateway (its URL and headers); anything else goes direct.
    const hop = this.o.aiGateway ? await this.o.aiGateway().catch((err: Error) => {
      throw new OllamaError(`The instance's AI Gateway could not be had: ${err.message}`, null);
    }) : null;
    const via = hop ? hop.url(this.base, path) : null;
    let res;
    try {
      res = await fetch(via ?? this.base + path, {
        method,
        headers: { accept: 'application/json, text/event-stream', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(traceparent ? { traceparent } : {}), ...auth, ...(via && hop ? hop.headers() : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signals.length ? AbortSignal.any(signals) : undefined,
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {})
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError' && opts.signal?.aborted) throw err;
      // An address the egress guard refused (in tests: a real cloud host) says so instead of undici's "fetch failed".
      const cause = (err as { cause?: unknown }).cause;
      if (cause instanceof ServiceUrlRefused) throw new OllamaError(cause.message, null);
      throw new OllamaError(`${(err as Error).name === 'TimeoutError' ? 'timed out' : (err as Error).message}`, null);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = text;
      try {
        const j = JSON.parse(text) as { error?: string | { message?: string; code?: string; innererror?: { content_filter_result?: unknown } }; message?: string; errors?: { message?: string }[] };
        // B-10502: Azure's prompt filter answers 400 with `content_filter` and the categories it found.
        if (this.o.flavour === 'azure' && typeof j.error === 'object' && j.error?.code === 'content_filter') throw new ProviderFiltered('azure', 'prompt', blockedCategories(filterCategories(j.error.innererror?.content_filter_result)));
        message = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.message ?? j.errors?.[0]?.message ?? text;
      } catch (err) {
        if (err instanceof ProviderFiltered) throw err;
        // not JSON
      }
      throw new OllamaError(message || `HTTP ${res.status}`, res.status);
    }
    if (via && hop) {
      const model = body && typeof (body as { model?: unknown }).model === 'string' ? (body as { model: string }).model : null;
      const problem = hop.answerProblem((n) => res.headers.get(n), model);
      if (problem) {
        await res.body?.cancel().catch(() => undefined);
        throw new OllamaError(problem, 502);
      }
    }
    return res;
  }

  /** `/health`, read at most once a second (version and models ask for it in the same poll). */
  private health(): Promise<{ ok: boolean; body: Record<string, unknown> | null }> {
    if (this.o.flavour) return Promise.resolve({ ok: false, body: null });
    if (this.healthMemo && Date.now() - this.healthAt < 1000) return this.healthMemo;
    this.healthAt = Date.now();
    this.healthMemo = (async () => {
      try {
        const res = await this.req('GET', '/health');
        const text = await res.text();
        try {
          return { ok: true, body: JSON.parse(text) as Record<string, unknown> };
        } catch {
          return { ok: true, body: null };
        }
      } catch (err) {
        // No /health (404, 405): the model list stands in for it. Anything else is the server not answering.
        if (err instanceof OllamaError && (err.status === 404 || err.status === 405 || err.status === 501)) return { ok: false, body: null };
        throw err;
      }
    })();
    return this.healthMemo;
  }

  /** llama.cpp's `/props`: the running context length (read at most once a minute); null from other servers. */
  private props(): Promise<number | null> {
    if (this.o.flavour) return Promise.resolve(null);
    if (this.propsMemo && Date.now() - this.propsAt < 60_000) return this.propsMemo;
    this.propsAt = Date.now();
    this.propsMemo = (async () => {
      try {
        const props = (await (await this.req('GET', '/props')).json()) as { default_generation_settings?: { n_ctx?: number }; n_ctx?: number };
        const n = Number(props.default_generation_settings?.n_ctx ?? props.n_ctx ?? NaN);
        if (!Number.isFinite(n) || n <= 0) return null;
        if (!this.state.server || this.state.server === 'chat-completions') this.state.server = 'llama.cpp';
        return n;
      } catch {
        return null; // not llama.cpp
      }
    })();
    return this.propsMemo;
  }

  async version(): Promise<string> {
    if (this.o.flavour) {
      this.state.server = FLAVOUR_NAME[this.o.flavour];
      return (this.o.flavour === 'azure' ? `${this.state.server} ${this.o.apiVersion || AZURE_OPENAI_API_VERSION}` : this.state.server).slice(0, 40);
    }
    const [h] = await Promise.all([this.health(), this.props()]);
    const b = h.body ?? {};
    const status = typeof b.status === 'string' ? b.status : '';
    const server = /fm serve/i.test(status) ? 'fm serve' : typeof b.server === 'string' ? b.server : this.state.server && this.state.server !== 'chat-completions' ? this.state.server : 'chat-completions';
    this.state.server = server;
    const v = typeof b.version === 'string' ? b.version : null;
    return (v ? `${server} ${v}` : server).slice(0, 40);
  }

  /** B-10502, B-10509: a cloud endpoint's models: the hook's (Azure deployments), Workers AI's search, else `/v1/models`; kept a few minutes. */
  private cloudModels(): Promise<NonNullable<ServerReport['models']>> {
    if (this.cloudModelsMemo && Date.now() - this.cloudModelsAt < CLOUD_MODELS_TTL_MS) return this.cloudModelsMemo;
    this.cloudModelsAt = Date.now();
    const p = (async () => {
      if (this.o.listModels) return this.o.listModels();
      if (this.o.flavour === 'workers-ai') {
        const r = (await (await this.req('GET', '/models/search?per_page=1000')).json()) as { result?: { name?: string; task?: { name?: string } }[] };
        return (r.result ?? []).filter((m) => typeof m.name === 'string' && /text generation|text embeddings/i.test(m.task?.name ?? '')).map((m) => ({ id: m.name!, available: true, reason: null, ownedBy: m.task?.name ?? null }));
      }
      const list = (await (await this.req('GET', '/v1/models')).json()) as { data?: { id: string; owned_by?: string }[] };
      return (list.data ?? []).map((m) => ({ id: m.id, available: true, reason: null, ownedBy: m.owned_by ?? null }));
    })();
    this.cloudModelsMemo = p;
    p.catch(() => {
      if (this.cloudModelsMemo === p) this.cloudModelsMemo = null;
    });
    return p;
  }

  async models(): Promise<TagModel[]> {
    if (this.o.flavour) {
      this.state.models = (await this.cloudModels()).map((m) => ({ ...m }));
      this.state.contextLength ??= null;
      return this.state.models.filter((m) => m.available).map((m) => ({ name: m.id, model: m.id, size: 0, digest: '', details: { format: 'server', ...(m.ownedBy ? { family: m.ownedBy } : {}) } }));
    }
    const [list, h] = await Promise.all([this.req('GET', '/v1/models').then((r) => r.json() as Promise<{ data?: { id: string; owned_by?: string; meta?: Record<string, unknown> }[] }>), this.health().catch(() => ({ ok: false, body: null }))]);
    const healthModels = Array.isArray(h.body?.models) ? (h.body!.models as { name?: string; available?: boolean; reason?: string }[]) : [];
    const data = list.data ?? [];
    let ctx: number | null = null;
    for (const m of data) {
      const n = Number(m.meta?.n_ctx_train ?? m.meta?.context_length ?? NaN);
      if (Number.isFinite(n) && n > 0) ctx = n;
    }
    const running = await this.props();
    if (running != null) ctx = running;
    if (ctx != null) this.state.contextLength = ctx;
    else this.state.contextLength ??= null;
    this.state.models = data.map((m) => {
      const hm = healthModels.find((x) => x.name === m.id);
      return { id: m.id, available: hm?.available !== false, reason: hm?.available === false ? (hm.reason ?? 'The server reports it unavailable') : null, ownedBy: m.owned_by ?? null };
    });
    return this.state.models.filter((m) => m.available).map((m) => ({ name: m.id, model: m.id, size: Number(data.find((d) => d.id === m.id)?.meta?.size ?? 0) || 0, digest: '', details: { format: 'server', ...(m.ownedBy ? { family: m.ownedBy } : {}) } }));
  }

  loaded(): Promise<PsModel[]> {
    return Promise.reject(new Unsupported('loaded', 'openai'));
  }

  /** What the listing and the probe know about one model, in `/api/show`'s shape. */
  async show(model: string): Promise<ShowResult> {
    if (!this.state.models) await this.models();
    const m = this.state.models?.find((x) => x.id === model);
    if (!m) throw new OllamaError(`model '${model}' not found`, 404);
    const caps = /embed/i.test(model) ? ['embedding'] : ['completion', ...(this.state.tools ? ['tools'] : [])];
    return { details: { format: 'server', ...(m.ownedBy ? { family: m.ownedBy } : {}) }, capabilities: caps, model_info: this.state.contextLength ? { 'server.context_length': this.state.contextLength } : {} };
  }

  load(): Promise<void> {
    return Promise.reject(new Unsupported('load', 'openai'));
  }

  unload(): Promise<void> {
    return Promise.reject(new Unsupported('unload', 'openai'));
  }

  delete(): Promise<void> {
    return Promise.reject(new Unsupported('delete', 'openai'));
  }

  // eslint-disable-next-line require-yield
  async *pull(): AsyncGenerator<PullProgress> {
    throw new Unsupported('pull', 'openai');
  }

  async *chat(request: ChatRequest, signal: AbortSignal, headerTimeoutMs = this.loadTimeoutMs): AsyncGenerator<ChatChunk> {
    const { body, dropped } = toWireRequest(request);
    if (dropped.length) this.o.onDropped?.(request.model, dropped);
    const headers = new AbortController();
    const timer = setTimeout(() => headers.abort(new Error('timed out waiting for the instance')), headerTimeoutMs);
    const span = startChild('gateway chat stream', SpanKind.CLIENT, { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': request.model, 'gen_ai.provider.name': 'openai' });
    const t0 = Date.now();
    let firstAt: number | null = null;
    let res;
    try {
      try {
        res = await runInSpan(span, () => this.req('POST', this.path('chat/completions', request.model), body, { timeoutMs: null, signal: AbortSignal.any([signal, headers.signal]) }));
      } finally {
        clearTimeout(timer);
      }
      const calls = new Map<number, { id?: string; name: string; args: string }>();
      let usage: WireChunk['usage'] = null;
      let finish: string | null = null;
      let content = '';
      let thinking = '';
      // B-10502: Azure's filter results for the completion, the last seen (the final chunk carries the decisive one).
      let filterResults: unknown = null;
      const handle = (c: WireChunk): ChatChunk | null => {
        if (c.error) {
          if (this.o.flavour === 'azure' && typeof c.error === 'object' && c.error.code === 'content_filter') throw new ProviderFiltered('azure', 'prompt', blockedCategories(filterCategories(c.error.innererror?.content_filter_result)));
          throw new OllamaError(typeof c.error === 'string' ? c.error : (c.error.message ?? 'The server failed'), 500);
        }
        if (c.usage) usage = c.usage;
        const choice = c.choices?.[0];
        if (!choice) return null;
        if (choice.finish_reason) finish = choice.finish_reason;
        if (this.o.flavour === 'azure' && choice.content_filter_results) filterResults = choice.content_filter_results;
        const d = choice.delta ?? choice.message ?? {};
        for (const tc of d.tool_calls ?? []) {
          const k = tc.index ?? calls.size;
          const cur = calls.get(k) ?? { name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(k, cur);
        }
        const text = d.content ?? '';
        const reason = d.reasoning_content ?? d.reasoning ?? '';
        if (!text && !reason) return null;
        firstAt ??= Date.now();
        content += text;
        thinking += reason;
        return { message: { role: 'assistant', content: text, ...(reason ? { thinking: reason } : {}) }, done: false };
      };
      const type = res.headers.get('content-type') ?? '';
      if (/event-stream/.test(type) && res.body) {
        for await (const data of sseData(res.body)) {
          if (data.trim() === '[DONE]') break;
          let parsed: WireChunk;
          try {
            parsed = JSON.parse(data) as WireChunk;
          } catch {
            continue;
          }
          const out = handle(parsed);
          if (out) yield out;
        }
      } else {
        // A server that ignored `stream: true` answers with one completion.
        const out = handle((await res.json()) as WireChunk);
        if (out) yield out;
      }
      if (this.o.flavour === 'azure' && finish === 'content_filter') throw new ProviderFiltered('azure', 'completion', blockedCategories(filterCategories(filterResults)), content);
      if (calls.size) {
        firstAt ??= Date.now();
        const list = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => ({ ...(c.id ? { id: c.id } : {}), function: { name: c.name, arguments: parseArgs(c.args) } }));
        yield { message: { role: 'assistant', content: '', tool_calls: list }, done: false };
      }
      const u = usage as WireChunk['usage'];
      const end = Date.now();
      const first = firstAt ?? end;
      // Usage when the server reports it, otherwise the same estimate the gateway uses elsewhere (four characters a token).
      const promptTokens = u?.prompt_tokens ?? request.messages.reduce((a, m) => a + estimate(m.content ?? ''), 0);
      const outputTokens = u?.completion_tokens ?? estimate(content) + estimate(thinking) + [...calls.values()].reduce((a, c) => a + estimate(c.name + c.args), 0);
      // B-7403: token counts on the stream span as gen_ai.usage.* (the server's figures, or the same estimate).
      span?.setAttributes({ 'gen_ai.response.model': request.model, 'gen_ai.usage.input_tokens': promptTokens, 'gen_ai.usage.output_tokens': outputTokens });
      yield {
        message: { role: 'assistant', content: '' },
        done: true,
        done_reason: finish === 'length' ? 'length' : 'stop',
        total_duration: (end - t0) * 1e6,
        load_duration: 0,
        prompt_eval_count: promptTokens,
        prompt_eval_duration: (first - t0) * 1e6,
        eval_count: outputTokens,
        eval_duration: (end - first) * 1e6,
        // Sprint 61 (B-10505): the prompt tokens the provider served from its cache (Azure OpenAI and others report them).
        ...(u?.prompt_tokens_details?.cached_tokens ? { cached_prompt_tokens: u.prompt_tokens_details.cached_tokens } : {})
      };
      span?.ok();
    } catch (err) {
      span?.fail(errorKind(err));
      throw err;
    } finally {
      span?.end();
    }
  }

  /** `/v1/embeddings`; a server without it (Apple's `fm serve`) is remembered as not offering embeddings. */
  async embed(model: string, input: string[], signal?: AbortSignal): Promise<EmbedResult> {
    if (this.state.embeddings === false) throw new Unsupported('embed', 'openai');
    const t0 = Date.now();
    let r: { data?: { index?: number; embedding: number[] }[]; usage?: { prompt_tokens?: number } };
    try {
      r = (await (await this.req('POST', this.path('embeddings', model), { model, input }, { timeoutMs: this.loadTimeoutMs, ...(signal ? { signal } : {}) })).json()) as typeof r;
    } catch (err) {
      if (err instanceof OllamaError && (err.status === 404 || err.status === 405 || err.status === 501)) {
        this.state.embeddings = false;
        throw new Unsupported('embed', 'openai');
      }
      throw err;
    }
    this.state.embeddings = true;
    const data = [...(r.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return { model, embeddings: data.map((d) => d.embedding), total_duration: (Date.now() - t0) * 1e6, load_duration: 0, prompt_eval_count: r.usage?.prompt_tokens ?? input.reduce((a, x) => a + estimate(x), 0) };
  }

  /** Records what the probe found (tools, JSON schema output), so `show` and the instance view can say. */
  noteProbe(p: Pick<ServerReport, 'tools' | 'jsonSchema' | 'probedAt' | 'probedModel' | 'probeDetail'>): void {
    Object.assign(this.state, p);
  }

  /** Seeds what an earlier poll or probe recorded on the instance row, so a restart does not forget it. */
  seed(r: ServerReport | undefined): void {
    if (!r) return;
    for (const k of ['tools', 'jsonSchema', 'embeddings', 'probedAt', 'probedModel', 'probeDetail', 'contextLength', 'server'] as const) if (r[k] !== undefined && this.state[k] === undefined) (this.state as Record<string, unknown>)[k] = r[k];
  }

  async close(): Promise<void> {
    await this.dispatcher?.close();
  }
}
