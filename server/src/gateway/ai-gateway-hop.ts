import { AsyncLocalStorage } from 'node:async_hooks';
import type { Label } from '../authz/labels.js';
import type { ChatChunk, ChatRequest } from './ollama.js';
import type { ModelServer } from './server.js';

/*
 * 1.9.99-final, Sprint 61 (B-10908): the seam between a cloud model server and Cloudflare AI Gateway
 * (`cloud/ai-gateway.ts` builds the hop). A cloud instance with `settings.cloud.aiGateway` sends its inference calls
 * (chat, embeddings, Converse) to the gateway instead of the provider: `url` rewrites the address, `headers` adds the
 * gateway's own headers (its token, and whether this call may be cached or logged, which depends on the label of the
 * conversation it serves), and `answerProblem` refuses an answer the gateway served from a fallback model.
 *
 * The label travels with the call, not the request body: the gateway's lease wraps the client (`withAiGatewayLabel`)
 * so every request made while a lease's chat or embedding runs sees its label; a call made outside a lease (the
 * poller, an evaluation) has none and is treated as above `internal` (no caching, no logs).
 */

export interface AiGatewayHop {
  /** Where a call goes through the gateway, or null to call the provider directly (listing models, health). */
  url(base: string, path: string): string | null;
  /** The gateway's headers for this call (its token; `cf-aig-skip-cache`, `cf-aig-cache-ttl`, `cf-aig-collect-log`). */
  headers(): Record<string, string>;
  /** Why the gateway's answer may not be used (a gateway-side fallback to another model), or null. */
  answerProblem(header: (name: string) => string | null | undefined, model: string | null): string | null;
}

const scope = new AsyncLocalStorage<{ label: Label }>();

/** The label of the lease the current call serves, or null outside one. */
export const aiGatewayLabel = (): Label | null => scope.getStore()?.label ?? null;

/** Runs `fn` with `label` as the current lease's label. */
export const withLabel = <T>(label: Label, fn: () => T): T => scope.run({ label }, fn);

/**
 * A lease's client whose chat and embedding calls carry the lease's label to the AI Gateway hop. The chat stream is
 * advanced inside the label's scope, so the request its first step makes sees it.
 */
export function withAiGatewayLabel(client: ModelServer, label: Label): ModelServer {
  const chat = async function* (request: ChatRequest, signal: AbortSignal, headerTimeoutMs?: number): AsyncGenerator<ChatChunk> {
    const it = withLabel(label, () => client.chat(request, signal, headerTimeoutMs));
    try {
      for (;;) {
        const r = await withLabel(label, () => it.next());
        if (r.done) return;
        yield r.value;
      }
    } finally {
      await withLabel(label, () => it.return?.(undefined)).catch(() => undefined);
    }
  };
  return new Proxy(client, {
    get(target, prop, recv) {
      if (prop === 'chat') return chat;
      if (prop === 'embed') return (model: string, input: string[], signal?: AbortSignal) => withLabel(label, () => target.embed(model, input, signal));
      const v = Reflect.get(target, prop, recv) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    }
  });
}
