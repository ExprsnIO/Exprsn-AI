/*
 * 1.9.99-final, Sprint 60 (B-10503): DigitalOcean GenAI for `fake-do.ts`. Serverless inference on the inference
 * endpoint's paths (`/v1/models`, `/v1/chat/completions`, `/v1/embeddings`) with a model access key (`modelKeys`),
 * plain and streamed; agents listed on the API (`/v2/gen-ai/agents`, with a token holding `genai:read`) with their
 * endpoint `<fake>/agents/<uuid>`, which answers `/api/v1/chat/completions` with the agent's access key
 * (`agentKeys`); the model catalogue on the API (`/v2/gen-ai/models`). In tests every host is the fake's one URL.
 * It is never the real DigitalOcean.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { json, type RecordedRequest, type Reply } from './fake-cloud-base.js';
import { completionReply, defaultAnswer, embeddingReply, textOf, type ModelAnswer, type WireMessage } from './fake-cloud-models.js';

export interface FakeDoAgent {
  uuid: string;
  name: string;
  region: string;
  model: string;
  /** What the agent answers a prompt with. */
  answer: (prompt: string) => string;
  /** Prompts it was asked. */
  asked: string[];
}

export class FakeDoGenAi {
  readonly modelKeys = new Set<string>();
  /** Agent uuid → its access keys. */
  readonly agentKeys = new Map<string, Set<string>>();
  readonly agents = new Map<string, FakeDoAgent>();
  readonly models: { uuid: string; name: string; inference_name: string; usecases: string[] }[] = [
    { uuid: randomUUID(), name: 'Llama 3.3 Instruct (70B)', inference_name: 'llama3.3-70b-instruct', usecases: ['MODEL_USECASE_AGENT', 'MODEL_USECASE_SERVERLESS'] },
    { uuid: randomUUID(), name: 'OpenAI GPT-oss-120b', inference_name: 'openai-gpt-oss-120b', usecases: ['MODEL_USECASE_SERVERLESS'] },
    { uuid: randomUUID(), name: 'GTE Large EN v1.5', inference_name: 'gte-large-en-v1.5', usecases: ['MODEL_USECASE_KNOWLEDGEBASE', 'MODEL_USECASE_EMBEDDING'] }
  ];
  answer: (messages: WireMessage[], tools: { function?: { name?: string } }[]) => ModelAnswer = defaultAnswer;

  constructor(private readonly origin: () => string) {}

  addModelKey(): string {
    const k = `sk-do-${randomBytes(24).toString('hex')}`;
    this.modelKeys.add(k);
    return k;
  }

  addAgent(name: string, answer: (prompt: string) => string = (p) => `Agent ${name} says: ${p}`): { agent: FakeDoAgent; key: string } {
    const agent: FakeDoAgent = { uuid: randomUUID(), name, region: 'tor1', model: 'llama3.3-70b-instruct', answer, asked: [] };
    this.agents.set(agent.uuid, agent);
    const key = randomBytes(24).toString('base64url');
    this.agentKeys.set(agent.uuid, new Set([key]));
    return { agent, key };
  }

  /** The inference and agent endpoints (not the `/v2` API, whose token checks `fake-do.ts` does). */
  matches(path: string): boolean {
    return /^\/v1\/(models|chat\/completions|embeddings)$/.test(path) || /^\/agents\/[^/]+\/api\/v1\/chat\/completions$/.test(path);
  }

  classify(r: Omit<RecordedRequest, 'op'>): string {
    return r.path.startsWith('/agents/') ? 'genai:agent' : `genai:${r.path.slice(4)}`;
  }

  handle(r: RecordedRequest): Reply {
    const bearer = /^Bearer (.+)$/.exec(r.headers.authorization ?? '')?.[1] ?? '';
    const agentPath = /^\/agents\/([^/]+)\/api\/v1\/chat\/completions$/.exec(r.path);
    if (agentPath) {
      const agent = this.agents.get(agentPath[1]!);
      if (!agent) return { status: 404, body: { message: 'agent not found' } };
      if (!this.agentKeys.get(agent.uuid)?.has(bearer)) return { status: 401, body: { message: 'invalid agent access key' } };
      const body = json(r);
      const messages = (body.messages ?? []) as WireMessage[];
      const prompt = textOf([...messages].reverse().find((m) => m.role === 'user')?.content ?? '');
      agent.asked.push(prompt);
      return completionReply(body, agent.model, { content: agent.answer(prompt) });
    }
    if (!this.modelKeys.has(bearer)) return { status: 401, body: { error: { message: 'invalid model access key', type: 'authentication_error' } } };
    if (r.path === '/v1/models') return { status: 200, body: { object: 'list', data: this.models.map((m) => ({ id: m.inference_name, object: 'model', owned_by: 'digitalocean' })) } };
    const body = json(r);
    const model = String(body.model ?? '');
    if (!this.models.some((m) => m.inference_name === model)) return { status: 404, body: { error: { message: `model ${model} not found` } } };
    if (r.path === '/v1/embeddings') return embeddingReply(body, model);
    return completionReply(body, model, this.answer((body.messages ?? []) as WireMessage[], (body.tools ?? []) as { function?: { name?: string } }[]));
  }

  /** `/v2/gen-ai/...` on the API (after the token and scope checks). */
  api(seg: string[]): Reply | null {
    if (seg[1] === 'agents' && !seg[2]) return { status: 200, body: { agents: [...this.agents.values()].map((a) => ({ uuid: a.uuid, name: a.name, region: a.region, model: { name: a.model, inference_name: a.model }, deployment: { url: `${this.origin()}/agents/${a.uuid}`, status: 'STATUS_RUNNING', visibility: 'VISIBILITY_PRIVATE' } })), meta: { total: this.agents.size } } };
    if (seg[1] === 'models' && !seg[2]) return { status: 200, body: { models: this.models, meta: { total: this.models.length } } };
    return null;
  }
}
