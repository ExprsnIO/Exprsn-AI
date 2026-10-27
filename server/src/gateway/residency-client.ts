import type { ChatChunk, ChatRequest, EmbedResult } from './ollama.js';
import type { ModelServer } from './server.js';

/*
 * 1.9.99-final, Sprint 61 (B-10507): the lease client of a cloud instance checks every chat and embedding call
 * before it goes out (`check`: the residency and egress rules of `cloud/model-residency.ts`, with the request's own
 * label). A refusal ends the call before any byte reaches the provider. Every other method is the server's own.
 */
export function withResidency(client: ModelServer, check: (model: string) => Promise<void>): ModelServer {
  const chat = async function* (request: ChatRequest, signal: AbortSignal, headerTimeoutMs?: number): AsyncGenerator<ChatChunk> {
    await check(request.model);
    yield* client.chat(request, signal, headerTimeoutMs);
  };
  const embed = async (model: string, input: string[], signal?: AbortSignal): Promise<EmbedResult> => {
    await check(model);
    return client.embed(model, input, signal);
  };
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'chat') return chat;
      if (prop === 'embed') return embed;
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    }
  });
}
