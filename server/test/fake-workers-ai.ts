/*
 * 1.9.99-final, Sprint 60 (B-10509): Workers AI for `fake-cloudflare.ts`, under `/client/v4/accounts/<id>/ai/`:
 * the OpenAI-compatible `v1/chat/completions` (plain and streamed, tool calls, usage) and `v1/embeddings`, and
 * `models/search` in the v4 envelope. The account token's "Workers AI Read" is checked by `fake-cloudflare.ts`. It is
 * never the real Cloudflare.
 */
import { json, type RecordedRequest, type Reply } from './fake-cloud-base.js';
import { completionReply, defaultAnswer, embeddingReply, type ModelAnswer, type WireMessage } from './fake-cloud-models.js';

export class FakeWorkersAi {
  readonly models: { id: string; name: string; task: { name: string }; description: string }[] = [
    { id: 'a1', name: '@cf/meta/llama-3.1-8b-instruct', task: { name: 'Text Generation' }, description: 'Llama 3.1 8B Instruct' },
    { id: 'a2', name: '@cf/meta/llama-3.2-1b-instruct', task: { name: 'Text Generation' }, description: 'Llama 3.2 1B Instruct' },
    { id: 'a3', name: '@cf/baai/bge-m3', task: { name: 'Text Embeddings' }, description: 'BGE M3' },
    { id: 'a4', name: '@cf/black-forest-labs/flux-1-schnell', task: { name: 'Text-to-Image' }, description: 'FLUX.1 schnell' }
  ];
  answer: (messages: WireMessage[], tools: { function?: { name?: string } }[]) => ModelAnswer = defaultAnswer;
  /** Fixed usage for the next answers (null: estimated from the text). */
  usage: { prompt_tokens: number; completion_tokens: number } | null = null;

  matches(path: string): boolean {
    return /^\/accounts\/[^/]+\/ai\//.test(path);
  }

  route(r: RecordedRequest, path: string): Reply {
    const rest = path.replace(/^\/accounts\/[^/]+\/ai\//, '');
    if (rest === 'models/search' && r.method === 'GET') return { status: 200, body: { success: true, errors: [], messages: [], result: this.models, result_info: { count: this.models.length, page: 1, per_page: 1000, total_count: this.models.length } } };
    const body = json(r);
    const model = String(body.model ?? '');
    if ((rest === 'v1/chat/completions' || rest === 'v1/embeddings') && r.method === 'POST') {
      if (!this.models.some((m) => m.name === model)) return { status: 400, body: { errors: [{ code: 5007, message: `No such model ${model} or task` }], success: false, result: {}, messages: [] } };
      if (rest === 'v1/embeddings') return embeddingReply(body, model);
      return completionReply(body, model, this.answer((body.messages ?? []) as WireMessage[], (body.tools ?? []) as { function?: { name?: string } }[]), this.usage ? { usage: this.usage } : {});
    }
    return { status: 404, body: { success: false, errors: [{ code: 7000, message: 'No route for that URI' }], messages: [], result: null } };
  }
}
