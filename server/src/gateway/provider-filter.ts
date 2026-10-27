import type { Label } from '../authz/labels.js';
import { OllamaError, type ChatChunk, type ChatRequest } from './ollama.js';
import type { ModelServer } from './server.js';

/*
 * 1.9.99-final, Sprint 60 (B-10502): a cloud provider's own content filter, as the gateway sees it. Azure OpenAI and
 * AI Foundry deployments run Azure AI Content Safety on the prompt and on the completion:
 *
 *   - a prompt it filters is refused with `400` and `error.code: content_filter` (`innererror.content_filter_result`
 *     names the categories), streamed or not;
 *   - a completion it filters ends with `finish_reason: content_filter`, with `content_filter_results` on the choice
 *     (in the last chunk when streamed), after any text that had already passed.
 *
 * The model server throws `ProviderFiltered` for both, with the categories that were filtered (hate, sexual,
 * violence, self_harm with their severity; jailbreak, protected material, profanity and custom blocklists as
 * detected). The lease client the gateway hands out for a cloud instance (`withProviderFilter`) reports it to the
 * sink, which records it as a guardrail decision (`GuardrailEngine.recordProvider`), and the error goes on to the
 * caller: a provider's block is final, the fallback chain does not retry it elsewhere. Exprsn-AI's own checkpoints
 * still run before and after, whatever the provider decides.
 */

export interface FilterCategory {
  /** Azure's category name: `hate`, `sexual`, `violence`, `self_harm`, `jailbreak`, `protected_material_text`, ... */
  category: string;
  filtered: boolean;
  /** `safe`, `low`, `medium` or `high` for the harm categories. */
  severity?: string | null;
  /** For the detection categories (jailbreak, protected material, profanity). */
  detected?: boolean | null;
}

export type FilterStage = 'prompt' | 'completion';

export class ProviderFiltered extends OllamaError {
  constructor(
    readonly provider: string,
    readonly stage: FilterStage,
    readonly categories: FilterCategory[],
    /** What had streamed before the filter stopped the completion (empty for a prompt). */
    readonly partial = '',
    /** 1.9.99-final, Sprint 61 (B-10506): facts for the decision's meta (a Bedrock Guardrail's id, version and mode). */
    readonly detail: Record<string, string | number | boolean> = {}
  ) {
    const named = categories.filter((c) => c.filtered).map(describeCategory);
    super(`${provider === 'azure' ? "Azure's content filter" : provider === 'bedrock' ? 'The Bedrock Guardrail' : `${provider}'s content filter`} blocked the ${stage === 'prompt' ? 'prompt' : 'answer'}${named.length ? ` (${named.join(', ')})` : ''}.`, 400);
  }
}

export const isProviderFiltered = (err: unknown): err is ProviderFiltered => err instanceof ProviderFiltered;

export const describeCategory = (c: FilterCategory): string => `${c.category.replace(/_/g, ' ')}${c.severity && c.severity !== 'safe' ? ` (${c.severity})` : c.detected ? ' (detected)' : ''}`;

/**
 * Azure's `content_filter_results` (or `content_filter_result`) object as a list: every category it names, filtered
 * or not; custom blocklists by id.
 */
export function filterCategories(results: unknown): FilterCategory[] {
  if (!results || typeof results !== 'object') return [];
  const out: FilterCategory[] = [];
  for (const [category, v] of Object.entries(results as Record<string, unknown>)) {
    if (!v || typeof v !== 'object' || category === 'error') continue;
    const o = v as { filtered?: unknown; severity?: unknown; detected?: unknown; details?: unknown };
    if (category === 'custom_blocklists' && Array.isArray(o.details)) {
      for (const d of o.details as { filtered?: unknown; id?: unknown }[]) out.push({ category: `blocklist:${String(d.id ?? 'custom')}`, filtered: d.filtered === true, detected: d.filtered === true });
      continue;
    }
    out.push({ category, filtered: o.filtered === true, ...(typeof o.severity === 'string' ? { severity: o.severity } : {}), ...(typeof o.detected === 'boolean' ? { detected: o.detected } : {}) });
  }
  return out;
}

/** The categories of a set of results that were filtered; when none says so, every category above `safe` or detected. */
export function blockedCategories(list: FilterCategory[]): FilterCategory[] {
  const filtered = list.filter((c) => c.filtered);
  return filtered.length ? filtered : list.filter((c) => (c.severity && c.severity !== 'safe') || c.detected);
}

/** What the sink is told about one block. */
export interface ProviderFilterEvent {
  provider: string;
  stage: FilterStage;
  categories: FilterCategory[];
  /** The inspected text: the last user message for a prompt, the partial answer for a completion. */
  text: string;
  tenantId: string | null;
  label: Label;
  profileId: string | null;
  instance: { id: string; name: string };
  model: string;
  /** Sprint 61 (B-10506): the provider's own facts (a Bedrock Guardrail's id, version and mode), into the decision's meta. */
  detail?: Record<string, string | number | boolean>;
}

export type ProviderFilterSink = (e: ProviderFilterEvent) => Promise<void>;

/**
 * The lease client for a cloud instance: `chat` reports a provider's block to `sink` (once, never failing the call
 * for it), then rethrows it.
 */
export function withProviderFilter(client: ModelServer, ctx: Omit<ProviderFilterEvent, 'provider' | 'stage' | 'categories' | 'text' | 'model' | 'detail'>, sink: ProviderFilterSink, onError?: (err: unknown) => void): ModelServer {
  const chat = async function* (request: ChatRequest, signal: AbortSignal, headerTimeoutMs?: number): AsyncGenerator<ChatChunk> {
    try {
      yield* client.chat(request, signal, headerTimeoutMs);
    } catch (err) {
      if (isProviderFiltered(err)) {
        const lastUser = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
        await sink({ ...ctx, provider: err.provider, stage: err.stage, categories: err.categories, text: err.stage === 'prompt' ? lastUser : err.partial, model: request.model, ...(Object.keys(err.detail).length ? { detail: err.detail } : {}) }).catch((e: unknown) => onError?.(e));
      }
      throw err;
    }
  };
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'chat') return chat;
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    }
  });
}
