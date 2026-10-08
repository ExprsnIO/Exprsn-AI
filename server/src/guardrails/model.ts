import type { Label } from '../authz/labels.js';
import type { Gateway } from '../gateway/gateway.js';
import type { ChatMessage } from '../gateway/ollama.js';

/** How long a guard-model or LLM-classifier call may take, queueing included, before its rule's onError applies. */
export const MODEL_TIMEOUT_MS = 20_000;

/**
 * One non-streamed completion through the gateway (only the gateway talks to Ollama): the tenant profile names the
 * model and pool, and the pool must be cleared for the label of the text being inspected.
 */
export async function complete(gateway: Gateway, tenantId: string, profile: string, label: Label, messages: ChatMessage[], timeoutMs = MODEL_TIMEOUT_MS, need?: 'vision'): Promise<{ text: string; model: string; promptTokens: number; outputTokens: number; poolId: string | null; profileId: string }> {
  const r = await gateway.resolve(tenantId, profile);
  // Sprint 36c: an image goes only to a model recorded as reading images.
  if (need === 'vision' && !r.model.capabilities.includes('vision')) throw new Error(`The profile ${profile} routes to ${r.model.name}, which cannot read images; pick a profile with a vision model.`);
  const signal = AbortSignal.timeout(timeoutMs);
  const lease = await gateway.acquire(r.profile, r.model, label, { signal, waitMs: Math.min(timeoutMs, 10_000) });
  try {
    let text = '';
    let promptTokens = 0;
    let outputTokens = 0;
    const options: Record<string, unknown> = { temperature: 0 };
    if (r.profile.num_ctx) options.num_ctx = r.profile.num_ctx;
    for await (const c of lease.client.chat({ model: r.model.name, messages, options, ...(r.model.capabilities.includes('thinking') ? { think: false } : {}) }, signal, timeoutMs)) {
      text += c.message?.content ?? '';
      if (c.done) {
        promptTokens = Number(c.prompt_eval_count ?? 0);
        outputTokens = Number(c.eval_count ?? 0);
      }
    }
    return { text, model: r.model.name, promptTokens, outputTokens, poolId: lease.pool.id, profileId: r.profile.id };
  } finally {
    lease.release();
  }
}

/** Llama Guard's hazard categories (S1–S14), for display. */
export const GUARD_CATEGORIES: Record<string, string> = {
  S1: 'violent crimes',
  S2: 'non-violent crimes',
  S3: 'sex-related crimes',
  S4: 'child sexual exploitation',
  S5: 'defamation',
  S6: 'specialised advice',
  S7: 'privacy',
  S8: 'intellectual property',
  S9: 'indiscriminate weapons',
  S10: 'hate',
  S11: 'suicide and self-harm',
  S12: 'sexual content',
  S13: 'elections',
  S14: 'code interpreter abuse'
};

/**
 * Parses a Llama Guard style verdict: "safe", or "unsafe" and a line of categories ("unsafe\nS1,S10"). Anything else
 * is an error, so the rule's onError decides rather than a guess.
 */
export function parseGuardVerdict(output: string): { safe: boolean; categories: string[] } {
  const lines = output.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const head = lines[0]?.toLowerCase();
  if (head === 'safe') return { safe: true, categories: [] };
  if (head === 'unsafe') return { safe: false, categories: (lines[1] ?? '').split(/[,\s]+/).map((c) => c.toUpperCase()).filter((c) => /^S\d{1,2}$/.test(c)) };
  throw new Error(`The guard model answered neither safe nor unsafe: "${output.trim().slice(0, 60)}"`);
}

/**
 * The conversation a guard model classifies: the text as the user's turn, or as the assistant's reply to the prompt
 * when checking model output (Llama Guard rates the last turn).
 */
export function guardMessages(text: string, asAnswer: boolean, prompt?: string): ChatMessage[] {
  return asAnswer ? [{ role: 'user', content: prompt ?? '' }, { role: 'assistant', content: text }] : [{ role: 'user', content: text }];
}
