import { readFileSync } from 'node:fs';
import { fetch, type Dispatcher } from 'undici';
import { errorKind, runInSpan, SpanKind, startChild, withSpan } from '../observability/tracing.js';
import { literalProblem, serviceAgent, servicePolicy, type ServicePolicy } from '../platform/egress.js';

export interface InstanceTls {
  caFile?: string;
  certFile?: string;
  keyFile?: string;
}

export interface PsModel {
  name: string;
  model: string;
  size: number;
  size_vram: number;
  digest: string;
  expires_at?: string;
  details?: { family?: string; parameter_size?: string; quantization_level?: string; format?: string };
}

export interface TagModel {
  name: string;
  model: string;
  size: number;
  digest: string;
  modified_at?: string;
  details?: { family?: string; parameter_size?: string; quantization_level?: string; format?: string };
}

export interface ShowResult {
  details?: { family?: string; parameter_size?: string; quantization_level?: string; format?: string };
  model_info?: Record<string, unknown>;
  capabilities?: string[];
  license?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;
  images?: string[];
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  think?: boolean | 'low' | 'medium' | 'high';
  tools?: unknown[];
  options?: Record<string, unknown>;
  keep_alive?: string | number;
}

export interface ChatChunk {
  message?: { role: string; content?: string; thinking?: string; tool_calls?: ChatMessage['tool_calls'] };
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
  error?: string;
}

export interface EmbedResult {
  model?: string;
  embeddings: number[][];
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
}

export class OllamaError extends Error {
  constructor(
    message: string,
    readonly status: number | null
  ) {
    super(message);
  }
}

/** Reads a streamed newline-delimited JSON body. */
export async function* ndjson<T>(body: AsyncIterable<Uint8Array>): AsyncGenerator<T> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line) as T;
    }
  }
  const rest = (buf + decoder.decode()).trim();
  if (rest) yield JSON.parse(rest) as T;
}

/**
 * A client for one Ollama endpoint. Only the gateway talks to Ollama, over the internal network, optionally with
 * mutual TLS (the instance's CA, client certificate and key are file paths on this server).
 */
export class OllamaClient {
  private readonly dispatcher: Dispatcher | undefined;
  private readonly base: string;
  /** Set when the instance's mTLS files cannot be read: every request fails with it, so only this instance is affected. */
  private readonly configError: OllamaError | null = null;

  constructor(
    url: string,
    tls: InstanceTls | null,
    private readonly timeoutMs: number,
    /** B-901: the addresses this client may dial; checked again in every connection's DNS lookup. */
    policy: ServicePolicy = servicePolicy()
  ) {
    this.base = url.replace(/\/+$/, '');
    const literal = literalProblem(this.base, policy);
    if (literal) {
      this.configError = new OllamaError(`The instance address is refused: ${literal}`, null);
      return;
    }
    try {
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

  /** B-1401: each call is a client span (method, API path, instance host, model), and carries the W3C traceparent. */
  private req(method: string, path: string, body?: unknown, opts: { timeoutMs?: number | null; signal?: AbortSignal } = {}) {
    const model = body && typeof (body as { model?: unknown }).model === 'string' ? (body as { model: string }).model : null;
    let host: string | null = null;
    try {
      host = new URL(this.base).hostname;
    } catch {
      /* the config error reports it */
    }
    return withSpan(`ollama ${method} ${path}`, SpanKind.CLIENT, { 'http.request.method': method, 'url.path': path, ...(host ? { 'server.address': host } : {}), 'gen_ai.operation.name': path.replace(/^\/api\//, ''), ...(model ? { 'gen_ai.request.model': model } : {}) }, async (span) => {
      const res = await this.send(method, path, body, opts, span?.traceparent);
      span?.setAttribute('http.response.status_code', res.status);
      return res;
    });
  }

  private async send(method: string, path: string, body: unknown, opts: { timeoutMs?: number | null; signal?: AbortSignal }, traceparent: string | undefined) {
    if (this.configError) throw this.configError;
    const signals: AbortSignal[] = [];
    if (opts.timeoutMs !== null) signals.push(AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs));
    if (opts.signal) signals.push(opts.signal);
    let res;
    try {
      res = await fetch(this.base + path, {
        method,
        headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(traceparent ? { traceparent } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signals.length ? AbortSignal.any(signals) : undefined,
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {})
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError' && opts.signal?.aborted) throw err;
      throw new OllamaError(`${(err as Error).name === 'TimeoutError' ? 'timed out' : (err as Error).message}`, null);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        // not JSON
      }
      throw new OllamaError(message || `HTTP ${res.status}`, res.status);
    }
    return res;
  }

  async version(): Promise<string> {
    return ((await (await this.req('GET', '/api/version')).json()) as { version: string }).version;
  }

  async ps(): Promise<PsModel[]> {
    return ((await (await this.req('GET', '/api/ps')).json()) as { models?: PsModel[] }).models ?? [];
  }

  async tags(): Promise<TagModel[]> {
    return ((await (await this.req('GET', '/api/tags')).json()) as { models?: TagModel[] }).models ?? [];
  }

  async show(model: string): Promise<ShowResult> {
    return (await (await this.req('POST', '/api/show', { model })).json()) as ShowResult;
  }

  /** Loads a model into memory (an empty generate request) and sets how long it stays. */
  async load(model: string, keepAlive: string | number, timeoutMs = 10 * 60_000): Promise<void> {
    await (await this.req('POST', '/api/generate', { model, keep_alive: keepAlive, stream: false }, { timeoutMs })).text();
  }

  async unload(model: string): Promise<void> {
    await (await this.req('POST', '/api/generate', { model, keep_alive: 0, stream: false })).text();
  }

  async delete(model: string): Promise<void> {
    await (await this.req('DELETE', '/api/delete', { model })).text();
  }

  async *pull(model: string, signal?: AbortSignal): AsyncGenerator<{ status: string; digest?: string; total?: number; completed?: number; error?: string }> {
    const res = await this.req('POST', '/api/pull', { model, stream: true }, { timeoutMs: null, ...(signal ? { signal } : {}) });
    if (!res.body) return;
    yield* ndjson(res.body);
  }

  /**
   * Streams a chat completion. The caller's signal stops generation (Ollama stops when the connection closes).
   * Response headers must arrive within `headerTimeoutMs` (a cold load can take minutes); the stream itself has no
   * time limit.
   */
  async *chat(request: ChatRequest, signal: AbortSignal, headerTimeoutMs = 5 * 60_000): AsyncGenerator<ChatChunk> {
    const headers = new AbortController();
    const timer = setTimeout(() => headers.abort(new Error('timed out waiting for the instance')), headerTimeoutMs);
    // B-1401: the whole stream is one span (the call itself, up to the response headers, is a child of it).
    const span = startChild('gateway chat stream', SpanKind.CLIENT, { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': request.model });
    let res;
    try {
      try {
        res = await runInSpan(span, () => this.req('POST', '/api/chat', { ...request, stream: true }, { timeoutMs: null, signal: AbortSignal.any([signal, headers.signal]) }));
      } finally {
        clearTimeout(timer);
      }
      if (!res.body) return;
      for await (const chunk of ndjson<ChatChunk>(res.body)) {
        if (chunk.error) throw new OllamaError(chunk.error, 500);
        yield chunk;
      }
      span?.ok();
    } catch (err) {
      span?.fail(errorKind(err));
      throw err;
    } finally {
      span?.end();
    }
  }

  /** Embeddings for a batch of inputs (`/api/embed`), truncated to the model's context. */
  async embed(model: string, input: string[], signal?: AbortSignal): Promise<EmbedResult> {
    return (await (await this.req('POST', '/api/embed', { model, input, truncate: true }, { timeoutMs: 5 * 60_000, ...(signal ? { signal } : {}) })).json()) as EmbedResult;
  }

  async close(): Promise<void> {
    await this.dispatcher?.close();
  }
}
