import type { ChatChunk, ChatRequest, EmbedResult, PsModel, ShowResult, TagModel } from './ollama.js';

/**
 * B-4301: what the gateway needs from a model server. `OllamaClient` implements it unchanged; `OpenAIServer`
 * (B-4302) implements it over the Chat Completions API that Apple's `fm serve`, `mlx_lm.server`, llama.cpp's
 * `llama-server` and vLLM speak. A method the server cannot do throws `Unsupported`, and `supports` says so up front:
 * the gateway, placements and the catalogue treat that as "skip", never as an error.
 */
export type ServerKind = 'ollama' | 'openai';
export const SERVER_KINDS: readonly ServerKind[] = ['ollama', 'openai'];
export type ServerOp = 'version' | 'models' | 'loaded' | 'show' | 'load' | 'unload' | 'pull' | 'delete' | 'chat' | 'embed';

export interface PullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
  error?: string;
}

/** What a Chat Completions server told the gateway about itself; kept in the instance's `settings.reported`. */
export interface ServerReport {
  /** Which server answered, when it says (`fm serve`, `llama.cpp`, `mlx`), else `chat-completions`. */
  server?: string;
  /** The context length the server reports for its model (llama.cpp's `n_ctx`), null when it does not say. */
  contextLength?: number | null;
  /** Whether a tool call came back from the probe (null: not probed yet). */
  tools?: boolean | null;
  /** Whether `response_format` JSON schema output came back valid from the probe (null: not probed yet). */
  jsonSchema?: boolean | null;
  /** Whether `/v1/embeddings` answers (false once it refused; null: not tried). */
  embeddings?: boolean | null;
  /** Every model the server lists, with whether it can be used now (Apple's `pcc` is listed but unavailable). */
  models?: { id: string; available: boolean; reason?: string | null; ownedBy?: string | null }[];
  probedAt?: number | null;
  probedModel?: string | null;
  probeDetail?: string | null;
}

export class Unsupported extends Error {
  constructor(
    readonly op: ServerOp,
    readonly kind: ServerKind
  ) {
    super(`${op} is not available on ${kind === 'openai' ? 'a Chat Completions server' : 'this server'}`);
  }
}

export const isUnsupported = (err: unknown): err is Unsupported => err instanceof Unsupported;

/** Resolves to `fallback` when the server does not support the call; any other failure still rejects. */
export async function orSkip<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (isUnsupported(err)) return fallback;
    throw err;
  }
}

export interface ModelServer {
  readonly kind: ServerKind;
  supports(op: ServerOp): boolean;
  version(): Promise<string>;
  /** The models the server can serve now (Ollama's `/api/tags`, a server's `/v1/models`). */
  models(): Promise<TagModel[]>;
  /** The models resident in memory (Ollama's `/api/ps`). */
  loaded(): Promise<PsModel[]>;
  show(model: string): Promise<ShowResult>;
  load(model: string, keepAlive: string | number, timeoutMs?: number): Promise<void>;
  unload(model: string): Promise<void>;
  delete(model: string): Promise<void>;
  pull(model: string, signal?: AbortSignal): AsyncGenerator<PullProgress>;
  /** Streams a chat answer in the gateway's (Ollama-shaped) chunks, whatever the server speaks. */
  chat(request: ChatRequest, signal: AbortSignal, headerTimeoutMs?: number): AsyncGenerator<ChatChunk>;
  embed(model: string, input: string[], signal?: AbortSignal): Promise<EmbedResult>;
  /** What the server reported about itself, for servers that report (Chat Completions servers). */
  report?(): ServerReport;
  close(): Promise<void>;
}
