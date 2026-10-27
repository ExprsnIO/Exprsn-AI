/*
 * 1.9.99-final, Sprint 60 (B-10502): an in-process stand-in for an Azure OpenAI / AI Foundry resource's data plane:
 * `/openai/deployments/<deployment>/chat/completions` and `/embeddings`, each with a required `api-version`, plain and
 * streamed. Authentication: an API key in `api-key` (`keys`) or an Entra bearer token the test accepts
 * (`acceptToken`, wired to `FakeAzure`'s tokens for the Cognitive Services scope). Azure AI Content Safety: every
 * answer carries `prompt_filter_results` and `content_filter_results`; `filterPrompt` makes a prompt answer 400
 * `content_filter` with `innererror.content_filter_result`, and `filterCompletion` ends a completion with
 * `finish_reason: content_filter` after its first words. `seedArm` puts the Cognitive Services account and its
 * deployments into a `FakeAzure` for ARM discovery. It is never the real Azure.
 */
import { FakeCloudBase, json, type RecordedRequest, type Reply } from './fake-cloud-base.js';
import type { FakeAzure } from './fake-azure.js';
import { completionReply, defaultAnswer, embeddingReply, textOf, type ModelAnswer, type WireMessage } from './fake-cloud-models.js';

export type FilterResults = Record<string, { filtered: boolean; severity?: string; detected?: boolean }>;

/** Results with every harm category safe (what Azure sends on an answer nothing was filtered from). */
export const SAFE: FilterResults = { hate: { filtered: false, severity: 'safe' }, self_harm: { filtered: false, severity: 'safe' }, sexual: { filtered: false, severity: 'safe' }, violence: { filtered: false, severity: 'safe' } };

export class FakeAzureOpenAI extends FakeCloudBase {
  readonly keys = new Set<string>();
  /** Entra bearer tokens: true when the token is valid for the Cognitive Services scope. */
  acceptToken: (token: string) => boolean = () => false;
  /** Deployment name → the model under it. A deployment not listed answers 404 DeploymentNotFound. */
  readonly deployments = new Map<string, { model: string; version?: string }>();
  /** Results for a prompt (the last user message); a result with `filtered: true` refuses the prompt with 400. */
  filterPrompt: (text: string) => FilterResults | null = () => null;
  /** Results for a completion; one with `filtered: true` stops it with `finish_reason: content_filter`. */
  filterCompletion: (text: string) => FilterResults | null = () => null;
  answer: (messages: WireMessage[], tools: { function?: { name?: string } }[]) => ModelAnswer = defaultAnswer;

  protected classify(r: Omit<RecordedRequest, 'op'>): string {
    const m = /^\/openai\/deployments\/[^/]+\/(chat\/completions|embeddings)$/.exec(r.path);
    return m ? `aoai:${m[1]}` : `aoai:${r.method} ${r.path}`;
  }

  protected throttleReply(_r: RecordedRequest, retryAfterS: number): Reply {
    return { status: 429, headers: { 'retry-after': String(retryAfterS) }, body: { error: { code: '429', message: 'Requests to the ChatCompletions_Create Operation have exceeded the token rate limit.' } } };
  }

  protected handle(r: RecordedRequest): Reply {
    const key = r.headers['api-key'];
    const bearer = /^Bearer (.+)$/.exec(r.headers.authorization ?? '')?.[1];
    if (!(key && this.keys.has(key)) && !(bearer && this.acceptToken(bearer))) return { status: 401, body: { error: { code: '401', message: 'Access denied due to invalid subscription key or wrong API endpoint.' } } };
    const m = /^\/openai\/deployments\/([^/]+)\/(chat\/completions|embeddings)$/.exec(r.path);
    if (!m) return { status: 404, body: { error: { code: '404', message: 'Resource not found' } } };
    if (!/^\d{4}-\d{2}-\d{2}(-preview)?$/.test(r.query.get('api-version') ?? '')) return { status: 404, body: { error: { code: '404', message: 'Resource not found' } } };
    const dep = this.deployments.get(decodeURIComponent(m[1]!));
    if (!dep) return { status: 404, body: { error: { code: 'DeploymentNotFound', message: 'The API deployment for this resource does not exist.' } } };
    const body = json(r);
    if (m[2] === 'embeddings') return embeddingReply(body, dep.model);
    const messages = (body.messages ?? []) as WireMessage[];
    const lastUser = [...messages].reverse().find((x) => x.role === 'user');
    const pf = this.filterPrompt(textOf(lastUser?.content ?? ''));
    if (pf && Object.values(pf).some((c) => c.filtered)) {
      return { status: 400, body: { error: { message: "The response was filtered due to the prompt triggering Azure OpenAI's content management policy.", type: null, param: 'prompt', code: 'content_filter', status: 400, innererror: { code: 'ResponsibleAIPolicyViolation', content_filter_result: pf } } } };
    }
    const a = this.answer(messages, (body.tools ?? []) as { function?: { name?: string } }[]);
    const cf = this.filterCompletion(a.content);
    const blocked = !!cf && Object.values(cf).some((c) => c.filtered);
    const shown: ModelAnswer = blocked ? { content: a.content.split(' ').slice(0, 2).join(' '), finish: 'content_filter', choiceExtra: { content_filter_results: cf } } : { ...a, choiceExtra: { content_filter_results: cf ?? SAFE } };
    return completionReply(body, dep.model, { ...shown, extra: { prompt_filter_results: [{ prompt_index: 0, content_filter_results: pf ?? SAFE }] } });
  }

  /**
   * Puts a Cognitive Services account (kind OpenAI) with its deployments into `az`'s ARM, so ARM lists them:
   * `/subscriptions/<sub>/providers/Microsoft.CognitiveServices/accounts` and `<account>/deployments`.
   */
  seedArm(az: FakeAzure, o: { subscription: string; resourceGroup: string; account: string; location?: string; endpoint?: string; states?: Record<string, string> }): string {
    const id = `/subscriptions/${o.subscription}/resourceGroups/${o.resourceGroup}/providers/Microsoft.CognitiveServices/accounts/${o.account}`;
    const endpoint = o.endpoint ?? `${this.url}/`;
    az.resources.set(id.toLowerCase(), { id, name: o.account, type: 'Microsoft.CognitiveServices/accounts', location: o.location ?? 'swedencentral', tags: {}, etag: 'e', body: { kind: 'OpenAI', sku: { name: 'S0' }, properties: { endpoint, endpoints: { 'OpenAI Language Model Instance API': endpoint }, provisioningState: 'Succeeded' } } } as never);
    for (const [name, d] of this.deployments) {
      const did = `${id}/deployments/${name}`;
      az.resources.set(did.toLowerCase(), { id: did, name, type: 'Microsoft.CognitiveServices/accounts/deployments', tags: {}, etag: 'e', body: { sku: { name: 'Standard', capacity: 10 }, properties: { model: { format: 'OpenAI', name: d.model, version: d.version ?? '1' }, provisioningState: o.states?.[name] ?? 'Succeeded', capabilities: /embed/.test(d.model) ? { embeddings: 'true' } : { chatCompletion: 'true' } } } } as never);
    }
    return id;
  }
}
