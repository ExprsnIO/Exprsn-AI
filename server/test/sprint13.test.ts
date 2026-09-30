import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ulid } from 'ulid';
import { TOPICS } from '../src/platform/bus.js';
import { dayOf, monthOf } from '../src/tenancy/quotas.js';
import { internalRequest } from '../src/workflows/http.js';
import { parseAllowList } from '../src/mcp/hosts.js';
import { hostEntryProblem, tenantHostProblem } from '../src/integrations/hosts.js';
import { fillTemplate, variablesOf } from '../src/prompts/service.js';
import { priceFor } from '../src/billing/service.js';
import { matchesEvent, verifySignature } from '../src/webhooks/service.js';
import { FakeOllama } from './fake-ollama.js';
import { seedGateway } from './seed-gateway.js';
import { FakeReceiver, FakeStripe } from './sprint13-fakes.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';

const GB = 1_000_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(10);
  }
}

async function listen(h: Harness): Promise<{ server: Server; url: string }> {
  const server = createServer(h.app);
  // The wildcard address, as supertest uses, so this port cannot also be bound by another test process (see sprint13-fakes.ts).
  await new Promise<void>((r) => server.listen(0, r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function apiKey(h: Harness, userId: string, scopes = ['inference:invoke', 'models:read', 'chat:read'] as never[]) {
  return (await h.s.apiKeys.create({ tenantId: h.tenantId, userId, name: `k-${ulid()}`, scopes, ttlDays: 30 })).key;
}

/**
 * A minimal client that speaks the wire format the official `openai` npm client uses: JSON requests with a bearer
 * key, `{ error: { message, type, code } }` on failure, and for streams server-sent events of
 * `chat.completion.chunk` objects ending with `data: [DONE]` (an `error` object in the stream is thrown).
 */
class OpenAiWire {
  constructor(
    private readonly baseURL: string,
    private readonly apiKey: string,
    private readonly headers: Record<string, string> = {}
  ) {}

  private async req(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.baseURL}${path}`, { method, headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', accept: 'application/json', ...this.headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }

  private async json(res: Response): Promise<Record<string, unknown>> {
    const j = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw Object.assign(new Error(String((j.error as { message?: string })?.message)), { status: res.status, error: j.error });
    return j;
  }

  private async *stream(b: Record<string, unknown>): AsyncGenerator<Record<string, unknown>> {
    const res = await this.req('POST', '/chat/completions', { ...b, stream: true });
    if (!res.ok) await this.json(res);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error('stream ended without [DONE]');
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') return;
          const j = JSON.parse(data) as Record<string, unknown>;
          if (j.error) throw Object.assign(new Error(String((j.error as { message?: string }).message)), { error: j.error });
          yield j;
        }
      }
    }
  }

  models = { list: async () => this.json(await this.req('GET', '/models')) };
  embeddings = { create: async (b: Record<string, unknown>) => this.json(await this.req('POST', '/embeddings', b)) };
  chat = {
    completions: {
      create: async (b: Record<string, unknown>) => this.json(await this.req('POST', '/chat/completions', b)),
      stream: (b: Record<string, unknown>) => this.stream(b)
    }
  };
}

async function seedEmbedding(h: Harness, ollama: FakeOllama, poolId: string) {
  const repo = h.s.gateway.repo;
  ollama.addAvailable({ name: 'bge-small', size: GB, capabilities: ['embedding'] });
  const m = await repo.createModel({ name: 'bge-small', source: 'Ollama library', expectedDigest: null, license: { name: 'test' }, label: 'confidential', notes: null, requestedBy: 'x', requestedTenant: h.tenantId });
  await repo.updateModel(m.id, { state: 'approved', import_state: 'pulled', capabilities: ['embedding'], size_bytes: GB });
  await repo.place(m.id, poolId, 'warm', 'x');
  await h.s.gateway.pollAll();
}

describe('B-301 OpenAI-compatible API', () => {
  let h: Harness;
  let ollama: FakeOllama;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    ollama = await new FakeOllama().start();
    ({ server, url: base } = await listen(h));
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await h.close();
    await ollama.stop();
  });

  it('lists profiles and embedding models, chats, streams and embeds with a bearer API key', async () => {
    const { pool } = await seedGateway(h, ollama, { label: 'internal', system_prompt: 'Be brief.' });
    await seedEmbedding(h, ollama, pool.id);
    const u = await localUser(h, 'dev', ['member']);
    const client = new OpenAiWire(`${base}/v1`, await apiKey(h, u.id));

    const models = await client.models.list();
    expect(models.object).toBe('list');
    expect((models.data as { id: string; object: string }[]).map((m) => m.id).sort()).toEqual(['bge-small', 'general']);

    const done = await client.chat.completions.create({ model: 'general', messages: [{ role: 'user', content: 'hello there' }], temperature: 0.5, max_tokens: 50, stop: ['\n\n'] });
    expect(done).toMatchObject({ object: 'chat.completion', model: 'general', choices: [{ index: 0, message: { role: 'assistant', content: 'You said: hello there' }, finish_reason: 'stop' }] });
    const usage = done.usage as { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    expect(usage.total_tokens).toBe(usage.prompt_tokens + usage.completion_tokens);
    // The profile's system prompt goes first; the request's options reach the model.
    expect(ollama.requests.filter((r) => r.path === '/api/chat').at(-1)!.body).toMatchObject({ messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'hello there' }], options: { temperature: 0.5, num_predict: 50, stop: ['\n\n'], num_ctx: 8192 } });
    const rec = await h.s.db('usage_records').where({ tenant_id: h.tenantId, kind: 'api' });
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ user_id: u.id, model: 'llama3.1:8b' });
    expect(rec[0].api_key_id).toBeTruthy();

    const chunks: Record<string, unknown>[] = [];
    for await (const c of client.chat.completions.stream({ model: 'general', messages: [{ role: 'user', content: 'stream me' }], stream_options: { include_usage: true } })) chunks.push(c);
    expect(chunks.every((c) => c.object === 'chat.completion.chunk')).toBe(true);
    expect(new Set(chunks.map((c) => c.id)).size).toBe(1);
    const text = chunks.flatMap((c) => (c.choices as { delta: { content?: string } }[]).map((x) => x.delta.content ?? '')).join('');
    expect(text).toBe('You said: stream me');
    expect((chunks.at(-2)!.choices as { finish_reason: string }[])[0]!.finish_reason).toBe('stop');
    expect(chunks.at(-1)!.usage).toMatchObject({ total_tokens: expect.any(Number) });

    const emb = await client.embeddings.create({ model: 'bge-small', input: ['alpha beta', 'gamma'] });
    expect(emb).toMatchObject({ object: 'list', model: 'bge-small' });
    expect((emb.data as { embedding: number[] }[]).map((d) => d.embedding.length)).toEqual([48, 48]);
    // The official client asks for base64 by default: little-endian float32.
    const b64 = await client.embeddings.create({ model: 'bge-small', input: 'alpha beta', encoding_format: 'base64' });
    const buf = Buffer.from((b64.data as { embedding: string }[])[0]!.embedding, 'base64');
    const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    expect(floats.length).toBe(48);
    expect(floats[0]).toBeCloseTo((emb.data as { embedding: number[] }[])[0]!.embedding[0]!, 5);
    expect(await h.s.db('usage_records').where({ tenant_id: h.tenantId, kind: 'embed' })).toHaveLength(2);
  });

  it('returns tool calls and continues after the tool result', async () => {
    await seedGateway(h, ollama, { label: 'internal' });
    ollama.reply = (messages, { tools }) => (tools.length && messages.at(-1)?.role === 'user' ? { content: '', toolCall: { name: 'get_weather', arguments: { city: 'Oslo' } } } : { content: `Weather: ${messages.at(-1)?.content ?? ''}` });
    const u = await localUser(h, 'dev', ['member']);
    const client = new OpenAiWire(`${base}/v1`, await apiKey(h, u.id));
    const tools = [{ type: 'function', function: { name: 'get_weather', description: 'Weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
    const first = await client.chat.completions.create({ model: 'general', messages: [{ role: 'user', content: 'Weather in Oslo?' }], tools });
    const choice = (first.choices as { message: { content: string | null; tool_calls: { id: string; type: string; function: { name: string; arguments: string } }[] }; finish_reason: string }[])[0]!;
    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message.content).toBeNull();
    const call = choice.message.tool_calls[0]!;
    expect(call).toMatchObject({ type: 'function', function: { name: 'get_weather' } });
    expect(call.id).toMatch(/^call_/);
    expect(JSON.parse(call.function.arguments)).toEqual({ city: 'Oslo' });
    expect(ollama.requests.filter((r) => r.path === '/api/chat').at(-1)!.body.tools).toHaveLength(1);

    const second = await client.chat.completions.create({ model: 'general', tools, messages: [{ role: 'user', content: 'Weather in Oslo?' }, { role: 'assistant', content: null, tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: 'sunny, 18 C' }] });
    expect((second.choices as { message: { content: string } }[])[0]!.message.content).toBe('Weather: sunny, 18 C');
    const sent = ollama.requests.filter((r) => r.path === '/api/chat').at(-1)!.body.messages as { role: string; tool_name?: string; tool_calls?: unknown[] }[];
    expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(sent[1]!.tool_calls).toEqual([{ function: { name: 'get_weather', arguments: { city: 'Oslo' } } }]);
    expect(sent[2]!.tool_name).toBe('get_weather');

    // Streamed tool calls arrive as indexed deltas.
    const chunks: Record<string, unknown>[] = [];
    for await (const c of client.chat.completions.stream({ model: 'general', messages: [{ role: 'user', content: 'Weather?' }], tools })) chunks.push(c);
    const deltas = chunks.flatMap((c) => (c.choices as { delta: { tool_calls?: { index: number; function: { name: string } }[] } }[]).flatMap((x) => x.delta.tool_calls ?? []));
    expect(deltas).toMatchObject([{ index: 0, function: { name: 'get_weather' } }]);
    expect((chunks.at(-1)!.choices as { finish_reason: string }[])[0]!.finish_reason).toBe('tool_calls');
  });

  it('applies bearer-only auth, clearance, quotas and guardrails, with OpenAI-shaped errors', async () => {
    await seedGateway(h, ollama, { label: 'internal' });
    const u = await localUser(h, 'dev', ['member']);
    const key = await apiKey(h, u.id);
    const post = (body: object, headers: Record<string, string> = {}) => request(h.app).post('/v1/chat/completions').set({ authorization: `Bearer ${key}`, ...headers }).send(body);

    // No bearer credential: a session cookie is not enough here.
    const m = await login(h, 'dev');
    const noKey = await request(h.app).get('/v1/models').set('cookie', m.cookie).expect(401);
    expect(noKey.body.error).toMatchObject({ type: 'authentication_error', code: 'missing_api_key' });
    expect((await request(h.app).get('/v1/models').set('authorization', 'Bearer exai_k1_nope').expect(401)).body.error.type).toBe('authentication_error');

    const missing = await post({ model: 'nope', messages: [{ role: 'user', content: 'hi' }] }).expect(404);
    expect(missing.body.error).toMatchObject({ type: 'invalid_request_error', code: 'model_not_found', param: 'model' });
    const invalid = await post({ model: 'general', messages: [] }).expect(400);
    expect(invalid.body.error).toMatchObject({ type: 'invalid_request_error', param: 'messages' });

    // Clearance: an internal user cannot send confidential data.
    const above = await post({ model: 'general', messages: [{ role: 'user', content: 'hi' }] }, { 'x-data-label': 'confidential' }).expect(403);
    expect(above.body.error).toMatchObject({ type: 'permission_error', code: 'denied_clearance' });

    // A key without inference:invoke is refused by the permission step.
    const readOnly = await apiKey(h, u.id, ['chat:read'] as never[]);
    expect((await request(h.app).get('/v1/models').set('authorization', `Bearer ${readOnly}`).expect(403)).body.error.code).toBe('denied_scope');

    // Guardrails: the input checkpoint refuses; the output checkpoint withholds.
    const seen: string[] = [];
    h.s.guardrails = {
      check: async (i) => {
        seen.push(i.checkpoint);
        if (i.checkpoint === 'user-input' && i.text.includes('forbidden')) return { action: 'block', text: i.text, findings: [], reason: 'That topic is off limits.' };
        if (i.checkpoint === 'model-output' && i.text.includes('secret')) return { action: 'block', text: i.text, findings: [], reason: 'The answer quoted a secret.' };
        return { action: 'allow', text: i.text, findings: [] };
      }
    };
    const blocked = await post({ model: 'general', messages: [{ role: 'system', content: 'ok' }, { role: 'user', content: 'a forbidden topic' }] }).expect(400);
    expect(blocked.body.error).toMatchObject({ code: 'content_filter', message: 'That topic is off limits.' });
    const withheld = await post({ model: 'general', messages: [{ role: 'user', content: 'tell me the secret' }] }).expect(200);
    expect(withheld.body.choices[0]).toMatchObject({ finish_reason: 'content_filter', message: { content: 'This answer was withheld. The answer quoted a secret.' } });
    expect(seen).toContain('model-output');
    // Streaming in the default checked mode never sends the withheld text.
    const s = await request(h.app).post('/v1/chat/completions').set('authorization', `Bearer ${key}`).send({ model: 'general', stream: true, messages: [{ role: 'user', content: 'tell me the secret' }] }).expect(200);
    expect(s.text).not.toContain('You said');
    expect(s.text).toContain('content_filter');
    expect(s.text.trim().endsWith('data: [DONE]')).toBe(true);

    // Quotas: a spent daily limit is a 429 with the OpenAI quota code and Retry-After.
    await h.s.quotas.set(h.tenantId, null, { tokensPerDay: 1 }, 'test');
    const limited = await post({ model: 'general', messages: [{ role: 'user', content: 'hi' }] }).expect(429);
    expect(limited.body.error).toMatchObject({ type: 'rate_limit_error', code: 'insufficient_quota' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('streams tokens as they are generated in live mode', async () => {
    await h.close();
    h = await harness({ OLLAMA_POLL_MS: '600000', OPENAI_STREAM_MODE: 'live' });
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    ({ server, url: base } = await listen(h));
    await seedGateway(h, ollama, { label: 'internal' });
    const u = await localUser(h, 'dev', ['member']);
    const client = new OpenAiWire(`${base}/v1`, await apiKey(h, u.id));
    const chunks: Record<string, unknown>[] = [];
    for await (const c of client.chat.completions.stream({ model: 'general', messages: [{ role: 'user', content: 'one two three' }] })) chunks.push(c);
    const pieces = chunks.map((c) => (c.choices as { delta: { content?: string } }[])[0]!.delta.content).filter(Boolean);
    expect(pieces.length).toBeGreaterThan(3);
    expect(pieces.join('')).toBe('You said: one two three');
  });
});

describe('B-302 and B-303 webhooks and the tenant host allow-list', () => {
  let h: Harness;
  let hook: FakeReceiver;

  beforeEach(async () => {
    h = await harness({ WEBHOOK_RETRY_BASE_MS: '10', WEBHOOK_MAX_ATTEMPTS: '3', WEBHOOK_BREAKER_THRESHOLD: '3', WEBHOOK_BREAKER_COOLDOWN_MS: '60000' });
    hook = await new FakeReceiver().start();
  });
  afterEach(async () => {
    await h.close();
    await hook.stop();
  });

  async function admin() {
    await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    const c = await loginAdmin(h, 'ta');
    return { ...c, post: (p: string, b: object = {}) => c.agent.post(p).set('x-csrf-token', c.csrf).send(b), patch: (p: string, b: object) => c.agent.patch(p).set('x-csrf-token', c.csrf).send(b), put: (p: string, b: object) => c.agent.put(p).set('x-csrf-token', c.csrf).send(b) };
  }

  const deliveries = (webhookId: string) => h.s.db('webhook_deliveries').where({ webhook_id: webhookId }).orderBy('created_at');
  const drain = async (rounds = 20) => {
    for (let i = 0; i < rounds; i++) {
      await h.s.jobs.runDue();
      await sleep(15);
    }
  };

  it('signs deliveries, sends them as jobs, filters by event and label, and shows the secret once', async () => {
    const a = await admin();
    const created = await a.post('/api/admin/webhooks', { name: 'ops', url: `${hook.url}/hook`, events: ['demo.*', 'job.*', 'flag.*'], maxLabel: 'internal' }).expect(201);
    const secret = created.body.secret as string;
    expect(secret).toMatch(/^whsec_/);
    const list = (await a.agent.get('/api/admin/webhooks').expect(200)).body;
    expect(JSON.stringify(list)).not.toContain(secret);
    const row = await h.s.db('webhooks').where({ id: created.body.id }).first();
    expect(row.secret_sealed).not.toContain(secret);

    await h.s.audit.append({ tenantId: h.tenantId, action: 'demo.happened', kind: 'admin', actor: { service: 'test' }, target: { thing: 1 }, label: 'internal' });
    await h.s.audit.append({ tenantId: h.tenantId, action: 'demo.secret', kind: 'admin', actor: { service: 'test' }, target: {}, label: 'confidential' });
    await h.s.audit.append({ tenantId: h.tenantId, action: 'other.thing', kind: 'admin', actor: { service: 'test' }, target: {}, label: 'internal' });
    await until(async () => (await deliveries(created.body.id)).length >= 1);
    await sleep(30);
    // Not delivered until the job runs; the confidential event and the unsubscribed one are never queued.
    expect(hook.got).toHaveLength(0);
    expect((await deliveries(created.body.id)).map((d) => d.event)).toEqual(['demo.happened']);
    await drain(2);
    expect(hook.got).toHaveLength(1);
    const got = hook.got[0]!;
    expect(got.headers['x-exprsn-event']).toBe('demo.happened');
    expect(got.headers['x-exprsn-delivery-id']).toBeTruthy();
    expect(verifySignature(secret, got.headers['x-exprsn-timestamp'] as string, got.headers['x-exprsn-signature'] as string, got.body)).toBe(true);
    expect(verifySignature(secret, got.headers['x-exprsn-timestamp'] as string, got.headers['x-exprsn-signature'] as string, got.body + ' ')).toBe(false);
    expect(verifySignature('whsec_other', got.headers['x-exprsn-timestamp'] as string, got.headers['x-exprsn-signature'] as string, got.body)).toBe(false);
    expect(JSON.parse(got.body)).toMatchObject({ type: 'demo.happened', label: 'internal', data: { action: 'demo.happened', target: { thing: 1 } } });
    expect((await deliveries(created.body.id))[0]).toMatchObject({ state: 'succeeded', attempts: 1, status_code: 200 });

    // Job states and flag events.
    h.s.jobs.register('test.noop', async () => ({ ok: true }));
    await h.s.jobs.enqueue({ tenantId: h.tenantId, type: 'test.noop' });
    h.s.bus.emitLocal(TOPICS.integrationEvent, { tenantId: h.tenantId, type: 'flag.created', label: 'internal', id: 'flag-event:x1', data: { flag: 'F-1' } });
    h.s.bus.emitLocal(TOPICS.integrationEvent, { tenantId: h.tenantId, type: 'flag.created', label: 'internal', id: 'flag-event:x1', data: { flag: 'F-1' } });
    await drain(4);
    const events = (await deliveries(created.body.id)).map((d) => d.event);
    expect(events).toContain('job.succeeded');
    // The same occurrence seen twice is delivered once.
    expect(events.filter((e) => e === 'flag.created')).toHaveLength(1);
    // Deliveries are jobs, but never announce themselves.
    expect(hook.got.every((g) => !String(JSON.parse(g.body).data?.type ?? '').startsWith('webhook.'))).toBe(true);

    // Replay sends the same body again, as a new delivery.
    const first = (await deliveries(created.body.id))[0]!;
    const replay = await a.post(`/api/admin/webhooks/${created.body.id}/deliveries/${first.id}/replay`).expect(202);
    expect(replay.body.replayOf).toBe(first.id);
    await drain(2);
    const again = hook.got.filter((g) => g.headers['x-exprsn-delivery-id'] === replay.body.id);
    expect(again).toHaveLength(1);
    expect(again[0]!.body).toBe(got.body);

    // Rotating the secret returns a new one, once.
    const rotated = await a.post(`/api/admin/webhooks/${created.body.id}/secret`).expect(200);
    expect(rotated.body.secret).not.toBe(secret);
    const audit = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).select('action')).map((x) => x.action);
    expect(audit).toEqual(expect.arrayContaining(['webhook.created', 'webhook.delivery.replayed', 'webhook.secret.rotated']));
  });

  it('retries a failing endpoint with backoff, then opens the breaker', async () => {
    const a = await admin();
    hook.status = 500;
    const created = await a.post('/api/admin/webhooks', { name: 'flaky', url: `${hook.url}/hook`, events: ['demo.*'] }).expect(201);
    await h.s.audit.append({ tenantId: h.tenantId, action: 'demo.one', kind: 'admin', actor: { service: 'test' }, target: {} });
    await until(async () => (await deliveries(created.body.id)).length === 1);
    await h.s.jobs.runDue();
    let d = (await deliveries(created.body.id))[0]!;
    expect(d).toMatchObject({ state: 'pending', attempts: 1, status_code: 500 });
    expect(Number(d.next_attempt_at)).toBeGreaterThan(Date.now() - 5);
    await drain();
    d = (await deliveries(created.body.id))[0]!;
    expect(d).toMatchObject({ state: 'failed', attempts: 3 });
    expect(hook.got).toHaveLength(3);
    const w = (await a.agent.get('/api/admin/webhooks').expect(200)).body.webhooks[0];
    expect(w).toMatchObject({ breaker: 'open', failures: 3 });
    expect(w.retryAt).toBeGreaterThan(Date.now());

    // While the breaker is open, a new event waits for the cool-down instead of hitting the endpoint.
    hook.status = 200;
    await h.s.audit.append({ tenantId: h.tenantId, action: 'demo.two', kind: 'admin', actor: { service: 'test' }, target: {} });
    await until(async () => (await deliveries(created.body.id)).length === 2);
    await drain(3);
    expect(hook.got).toHaveLength(3);
    const waiting = (await deliveries(created.body.id))[1]!;
    expect(waiting).toMatchObject({ state: 'pending', attempts: 0 });
    expect(Number(waiting.next_attempt_at)).toBeGreaterThan(Date.now() + 30_000);
    const actions = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).select('action')).map((x) => x.action);
    expect(actions).toContain('webhook.breaker.opened');

    // After the cool-down the next attempt is the trial: success closes the breaker.
    await h.s.db('webhooks').where({ id: created.body.id }).update({ opened_at: Date.now() - 61_000 });
    await h.s.db('jobs').where({ type: 'webhook.deliver', state: 'queued' }).update({ run_at: Date.now() });
    await drain(2);
    expect((await deliveries(created.body.id))[1]).toMatchObject({ state: 'succeeded' });
    expect((await h.s.db('webhooks').where({ id: created.body.id }).first()).breaker).toBe('closed');
  });

  it('refuses non-internal and link-local endpoints, and hosts outside the tenant list', async () => {
    const a = await admin();
    for (const url of ['http://169.254.169.254/latest', 'http://8.8.8.8/hook', 'ftp://10.0.0.1/x']) {
      const r = await a.post('/api/admin/webhooks', { name: `x${Math.random()}`.slice(0, 20), url, events: ['*'] });
      expect([400, 422]).toContain(r.status);
    }
    // B-303: the tenant narrows to its own list.
    const bad = await a.put('/api/admin/integrations/hosts', { hosts: ['not a host!'] }).expect(400);
    expect(bad.body.detail).toMatch(/not a hostname/);
    await a.put('/api/admin/integrations/hosts', { hosts: ['hooks.example.internal', '10.20.0.0/16'] }).expect(200);
    const refused = await a.post('/api/admin/webhooks', { name: 'local', url: `${hook.url}/hook`, events: ['*'] }).expect(422);
    expect(refused.body.detail).toMatch(/not on this tenant's list/);
    // A webhook made before the list changed is refused when it delivers.
    await a.put('/api/admin/integrations/hosts', { hosts: [] }).expect(200);
    const ok = await a.post('/api/admin/webhooks', { name: 'local', url: `${hook.url}/hook`, events: ['demo.*'] }).expect(201);
    await a.put('/api/admin/integrations/hosts', { hosts: ['hooks.example.internal'] }).expect(200);
    await h.s.webhooks.emit(h.tenantId, 'demo.x', 'internal', 'e1', {});
    await h.s.jobs.runDue();
    const d = (await deliveries(ok.body.id))[0]!;
    expect(d).toMatchObject({ state: 'failed', attempts: 1 });
    expect(d.error).toMatch(/not on this tenant's list/);
    expect(hook.got).toHaveLength(0);
    await a.put('/api/admin/integrations/hosts', { hosts: ['127.0.0.1/32'] }).expect(200);
    await a.post('/api/admin/webhooks', { name: 'by-network', url: `${hook.url}/hook`, events: ['*'] }).expect(201);
    const actions = (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'tenant.hosts.updated' })).length;
    expect(actions).toBe(4);

    // Members cannot manage webhooks.
    await localUser(h, 'mem', ['member']);
    const m = await login(h, 'mem');
    await m.agent.get('/api/admin/webhooks').expect(403);
  });

  it('checks the tenant list in workflow HTTP steps', async () => {
    const target = await new FakeReceiver().start();
    try {
      const url = `${target.url}/x`;
      await expect(internalRequest({ method: 'GET', url, timeoutMs: 2000, allowHosts: [], allowLoopback: true, tenantAllow: parseAllowList('api.example.internal') })).rejects.toThrow(/not on this tenant's list/);
      expect((await internalRequest({ method: 'GET', url, timeoutMs: 2000, allowHosts: [], allowLoopback: true, tenantAllow: parseAllowList('127.0.0.0/8') })).status).toBe(200);
      expect((await internalRequest({ method: 'GET', url, timeoutMs: 2000, allowHosts: [], allowLoopback: true, tenantAllow: null })).status).toBe(200);
      // The workflow service reads the tenant's list from the settings.
      await h.s.integrations.set(h.tenantId, { allowedHosts: ['api.example.internal'] }, 'test');
      expect(tenantHostProblem('127.0.0.1', ['127.0.0.1'], await h.s.integrations.allowList(h.tenantId))).toMatch(/not on this tenant's list/);
    } finally {
      await target.stop();
    }
  });

  it('parses host entries and event patterns', () => {
    expect(hostEntryProblem('*.corp.example')).toBeNull();
    expect(hostEntryProblem('10.0.0.0/8')).toBeNull();
    expect(hostEntryProblem('10.0.0.0/2')).toMatch(/prefix/);
    expect(hostEntryProblem('http://x')).not.toBeNull();
    expect(tenantHostProblem('a.corp.example', ['10.1.1.1'], parseAllowList('*.corp.example'))).toBeNull();
    expect(tenantHostProblem('corp.example', ['10.1.1.1'], parseAllowList('*.corp.example'))).not.toBeNull();
    expect(matchesEvent(['job.*'], 'job.failed')).toBe(true);
    expect(matchesEvent(['job.*'], 'jobs.failed')).toBe(false);
    expect(matchesEvent(['*'], 'anything')).toBe(true);
  });
});

describe('B-304 prompt library', () => {
  let h: Harness;
  let ollama: FakeOllama;
  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    ollama = await new FakeOllama().start();
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  it('fills variables in one pass and reports missing ones', () => {
    expect(variablesOf('Hi {{ name }}, {{name}} and {{topic}}')).toEqual(['name', 'topic']);
    expect(fillTemplate('Summarise {{topic}} in a {{tone}} tone', { topic: '{{tone}}' }, [{ name: 'tone', default: 'plain' }])).toEqual({ text: 'Summarise {{tone}} in a plain tone', missing: [] });
    expect(fillTemplate('{{a}} {{b}}', {}).missing).toEqual(['a', 'b']);
  });

  it('versions templates through a lifecycle and inserts a filled template into chat', async () => {
    await seedGateway(h, ollama, { label: 'internal' });
    await localUser(h, 'curator', ['member', 'knowledge-curator']);
    await localUser(h, 'mem', ['member']);
    const cur = await login(h, 'curator');
    const mem = await login(h, 'mem');
    const cpost = (p: string, b: object) => cur.agent.post(p).set('x-csrf-token', cur.csrf).send(b);
    const mpost = (p: string, b: object) => mem.agent.post(p).set('x-csrf-token', mem.csrf).send(b);

    const t = await cpost('/api/prompts', { name: 'Summary', description: 'Summarise a topic', body: 'Summarise {{topic}} in a {{tone}} tone.', variables: [{ name: 'tone', description: 'Voice', default: 'plain' }] }).expect(201);
    expect(t.body).toMatchObject({ state: 'draft', version: 1, publishedVersion: null, scope: 'tenant', label: 'internal' });
    await cpost('/api/prompts', { name: 'Bad', body: 'x', variables: [{ name: 'nope' }] }).expect(400);
    await cpost('/api/prompts', { name: 'Secret', body: 'x', label: 'confidential' }).expect(403);
    await mpost('/api/prompts', { name: 'Mine', body: 'x' }).expect(403);

    // A draft is invisible to members.
    expect((await mem.agent.get('/api/prompts').expect(200)).body.templates).toEqual([]);
    await mem.agent.get(`/api/prompts/${t.body.id}`).expect(404);
    await cpost(`/api/prompts/${t.body.id}/state`, { state: 'published' }).expect(200);
    const listed = (await mem.agent.get('/api/prompts').expect(200)).body;
    expect(listed.canManage).toBe(false);
    expect(listed.templates.map((x: { name: string }) => x.name)).toEqual(['Summary']);

    // A new version is not used until it is published.
    await cpost(`/api/prompts/${t.body.id}/versions`, { body: 'Brief on {{topic}}.', notes: 'shorter' }).expect(201);
    const r1 = await mpost(`/api/prompts/${t.body.id}/render`, { variables: { topic: 'the Q3 plan' } }).expect(200);
    expect(r1.body).toMatchObject({ text: 'Summarise the Q3 plan in a plain tone.', template: { version: 1 } });
    const miss = await mpost(`/api/prompts/${t.body.id}/render`, { variables: {} }).expect(400);
    expect(miss.body.missing).toEqual(['topic']);
    await mpost(`/api/prompts/${t.body.id}/render`, { variables: { topic: 'x' }, version: 2 }).expect(403);
    expect((await mem.agent.get(`/api/prompts/${t.body.id}`).expect(200)).body.versions).toHaveLength(1);
    expect((await cur.agent.get(`/api/prompts/${t.body.id}`).expect(200)).body.versions).toHaveLength(2);

    // Chat: the filled text is what is sent and stored.
    const sent = await mpost('/api/chat', { content: r1.body.text, profile: 'general' }).expect(202);
    await until(async () => (await h.s.db('messages').where({ id: sent.body.messageId }).first()).completed_at != null);
    const view = (await mem.agent.get(`/api/conversations/${sent.body.conversationId}`).expect(200)).body;
    expect(view.messages[0]).toMatchObject({ role: 'user', content: 'Summarise the Q3 plan in a plain tone.' });
    expect(view.messages[1].content).toBe('You said: Summarise the Q3 plan in a plain tone.');

    // Body is sealed at rest.
    const v = await h.s.db('prompt_versions').where({ template_id: t.body.id, version: 1 }).first();
    expect(v.body).not.toContain('Summarise');

    await cpost(`/api/prompts/${t.body.id}/state`, { state: 'published', version: 2 }).expect(200);
    expect((await mpost(`/api/prompts/${t.body.id}/render`, { variables: { topic: 'x' } }).expect(200)).body.text).toBe('Brief on x.');
    await cpost(`/api/prompts/${t.body.id}/state`, { state: 'retired' }).expect(200);
    expect((await mem.agent.get('/api/prompts').expect(200)).body.templates).toEqual([]);
    await cpost(`/api/prompts/${t.body.id}/state`, { state: 'published' }).expect(409);
    const actions = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).select('action')).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['prompt.created', 'prompt.published', 'prompt.version.added', 'prompt.retired']));
  });
});

describe('B-305 and B-306 sharing and export', () => {
  let h: Harness;
  let ollama: FakeOllama;
  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    ollama = await new FakeOllama().start();
    await seedGateway(h, ollama, { label: 'internal' });
  });
  afterEach(async () => {
    await h.close();
    await ollama.stop();
  });

  async function user(name: string, clearance: 'public' | 'internal' | 'confidential' = 'internal') {
    const u = await localUser(h, name, ['member'], clearance);
    const c = await login(h, name);
    // Sign-in recomputes clearance from the stores; pin it for the test.
    await h.s.db('users').where({ id: u.id }).update({ clearance });
    return { ...u, ...c, post: (p: string, b: object = {}) => c.agent.post(p).set('x-csrf-token', c.csrf).send(b), del: (p: string) => c.agent.delete(p).set('x-csrf-token', c.csrf) };
  }

  async function converse(o: Awaited<ReturnType<typeof user>>, text: string, conversationId?: string) {
    const sent = conversationId ? await o.post(`/api/conversations/${conversationId}/messages`, { content: text, profile: 'general' }).expect(202) : await o.post('/api/chat', { content: text, profile: 'general' }).expect(202);
    await until(async () => (await h.s.db('messages').where({ id: sent.body.messageId }).first()).completed_at != null);
    return { conversationId: (conversationId ?? sent.body.conversationId) as string, messageId: sent.body.messageId as string, userMessageId: sent.body.userMessageId as string };
  }

  it('shares read-only with a user and by link, within the label and tenant, and revokes at once', async () => {
    const owner = await user('owner');
    const reader = await user('reader');
    const low = await user('low', 'public');
    const c = await converse(owner, 'Plan for the launch');

    await owner.post(`/api/conversations/${c.conversationId}/shares`, { kind: 'user', userId: low.id }).expect(403);
    await reader.post(`/api/conversations/${c.conversationId}/shares`, { kind: 'user', userId: low.id }).expect(404);
    const share = await owner.post(`/api/conversations/${c.conversationId}/shares`, { kind: 'user', userId: reader.id }).expect(201);
    expect(share.body).toMatchObject({ kind: 'user', userName: 'READER', state: 'active' });

    const mine = (await reader.agent.get('/api/shared-conversations').expect(200)).body;
    expect(mine).toMatchObject([{ conversationId: c.conversationId, title: 'Plan for the launch', owner: 'OWNER' }]);
    const view = (await reader.agent.get(`/api/shared-conversations/${c.conversationId}`).expect(200)).body;
    expect(view).toMatchObject({ readOnly: true, label: 'internal' });
    expect(view.messages.map((m: { content: string }) => m.content)).toEqual(['Plan for the launch', 'You said: Plan for the launch']);

    // A reader can see but not write, and gets nothing through the owner's routes.
    await reader.post(`/api/conversations/${c.conversationId}/messages`, { content: 'mine now', profile: 'general' }).expect(404);
    await reader.agent.get(`/api/conversations/${c.conversationId}`).expect(404);
    await reader.post(`/api/conversations/${c.conversationId}/shares`, { kind: 'link', expiresInHours: 1 }).expect(404);

    // Raising the label above the reader's clearance ends access, as does revoking.
    await h.s.db('conversations').where({ id: c.conversationId }).update({ label: 'confidential' });
    await reader.agent.get(`/api/shared-conversations/${c.conversationId}`).expect(403);
    await h.s.db('conversations').where({ id: c.conversationId }).update({ label: 'internal' });
    await owner.del(`/api/conversations/${c.conversationId}/shares/${share.body.id}`).expect(204);
    await reader.agent.get(`/api/shared-conversations/${c.conversationId}`).expect(404);
    expect((await reader.agent.get('/api/shared-conversations').expect(200)).body).toEqual([]);

    // Links: the token is shown once and stored hashed; opening needs a user of the same tenant.
    const link = await owner.post(`/api/conversations/${c.conversationId}/shares`, { kind: 'link', expiresInHours: 2 }).expect(201);
    expect(link.body.url).toContain(`#/chat?shared=${link.body.token}`);
    const stored = await h.s.db('conversation_shares').where({ id: link.body.id }).first();
    expect(stored.token_hash).not.toContain(link.body.token);
    const opened = await reader.post('/api/shared-links/open', { token: link.body.token }).expect(200);
    expect(opened.body.messages).toHaveLength(2);
    await low.post('/api/shared-links/open', { token: link.body.token }).expect(403);

    const other = await h.s.tenants.create({ slug: 'other', name: 'Other' });
    const stranger = await h.s.users.create(other.id, { username: 'x', displayName: 'X', clearance: 'confidential' });
    await h.s.users.setRoles(stranger.id, 'direct', ['member']);
    const key = (await h.s.apiKeys.create({ tenantId: other.id, userId: stranger.id, name: 'k', scopes: ['chat:read'], ttlDays: 1 })).key;
    await request(h.app).post('/api/shared-links/open').set('authorization', `Bearer ${key}`).send({ token: link.body.token }).expect(404);

    // An expired link stops working, and so does a revoked one.
    await h.s.db('conversation_shares').where({ id: link.body.id }).update({ expires_at: Date.now() - 1 });
    await reader.post('/api/shared-links/open', { token: link.body.token }).expect(404);
    await h.s.db('conversation_shares').where({ id: link.body.id }).update({ expires_at: Date.now() + 60_000 });
    await owner.del(`/api/conversations/${c.conversationId}/shares/${link.body.id}`).expect(204);
    await reader.post('/api/shared-links/open', { token: link.body.token }).expect(404);

    const actions = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).select('action')).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['conversation.shared', 'conversation.share.revoked', 'conversation.share.opened']));
  });

  it('shares with a workspace', async () => {
    const owner = await user('owner');
    const reader = await user('reader');
    const outsider = await user('outsider');
    const ws = await h.s.tenants.createWorkspace(h.tenantId, 'Launch', 'internal');
    await h.s.tenants.addMember(ws.id, reader.id);
    const c = await converse(owner, 'Workspace note');
    await owner.post(`/api/conversations/${c.conversationId}/shares`, { kind: 'workspace', workspaceId: ws.id }).expect(201);
    await reader.agent.get(`/api/shared-conversations/${c.conversationId}`).expect(200);
    await outsider.agent.get(`/api/shared-conversations/${c.conversationId}`).expect(404);
  });

  it('exports the active branch with citations as Markdown and JSON, by job, clearance-gated and audited', async () => {
    const owner = await user('owner');
    const reader = await user('reader');
    const first = await converse(owner, 'First question');
    // Editing the question makes a new branch; the export follows the head.
    const edited = await owner.post(`/api/conversations/${first.conversationId}/messages/${first.userMessageId}/edit`, { content: 'Second question', profile: 'general' }).expect(202);
    await until(async () => (await h.s.db('messages').where({ id: edited.body.messageId }).first()).completed_at != null);
    const citations = [{ n: 1, kind: 'knowledge', label: 'internal', kb: 'Handbook', document: 'launch.md', section: 'Dates' }, { n: 2, kind: 'knowledge', label: 'confidential', kb: 'Board', document: 'secret.md' }];
    await h.s.db('messages').where({ id: edited.body.messageId }).update({ citations: await h.s.keys.seal(h.tenantId, JSON.stringify(citations), `citations:${edited.body.messageId}`) });

    const x = await owner.post(`/api/conversations/${first.conversationId}/exports`, { format: 'markdown' }).expect(202);
    expect(x.body.state).toBe('queued');
    await owner.agent.get(`/api/conversation-exports/${x.body.id}/download`).expect(409);
    await h.s.jobs.runDue();
    expect((await owner.agent.get(`/api/conversation-exports/${x.body.id}`).expect(200)).body).toMatchObject({ state: 'ready', format: 'markdown' });
    const md = await owner.agent.get(`/api/conversation-exports/${x.body.id}/download`).buffer(true).parse((res, cb) => {
      let d = '';
      res.on('data', (c: Buffer) => (d += c.toString('utf8')));
      res.on('end', () => cb(null, d));
    }).expect(200);
    const text = md.body as string;
    expect(md.headers['content-disposition']).toMatch(/attachment; filename="conversation-.*\.md"/);
    expect(text).toContain('Second question');
    expect(text).toContain('You said: Second question');
    // The title comes from the first question; the first branch itself is not in the export.
    expect(text.startsWith('# First question\n')).toBe(true);
    expect(text).not.toContain('## Question\n\nFirst question');
    expect(text).not.toContain('You said: First question');
    expect(text).toContain('1. Handbook, launch.md, Dates [internal]');
    // The owner is internal: a confidential citation is left out.
    expect(text).not.toContain('secret.md');
    const blob = await h.s.db('conversation_exports').where({ id: x.body.id }).first();
    expect((await h.s.blobs.get(blob.blob_key))!.toString('utf8')).not.toContain('Second question');

    const j = await owner.post(`/api/conversations/${first.conversationId}/exports`, { format: 'json' }).expect(202);
    await h.s.jobs.runDue();
    const doc = JSON.parse((await owner.agent.get(`/api/conversation-exports/${j.body.id}/download`).buffer(true).parse((res, cb) => {
      let d = '';
      res.on('data', (c: Buffer) => (d += c.toString('utf8')));
      res.on('end', () => cb(null, d));
    }).expect(200)).body as string);
    expect(doc.conversation.messages.map((m: { content: string }) => m.content)).toEqual(['Second question', 'You said: Second question']);
    expect(doc.conversation.messages[1].citations).toEqual([citations[0]]);

    // Someone without access cannot export; a reader above whose clearance the conversation rises cannot either.
    await reader.post(`/api/conversations/${first.conversationId}/exports`, { format: 'json' }).expect(404);
    await owner.post(`/api/conversations/${first.conversationId}/shares`, { kind: 'user', userId: reader.id }).expect(201);
    await reader.post(`/api/conversations/${first.conversationId}/exports`, { format: 'json' }).expect(202);
    await h.s.db('conversations').where({ id: first.conversationId }).update({ label: 'confidential' });
    await reader.post(`/api/conversations/${first.conversationId}/exports`, { format: 'json' }).expect(403);
    await reader.agent.get(`/api/conversation-exports/${x.body.id}`).expect(404);

    const actions = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).select('action')).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['conversation.export.requested', 'conversation.export.ready', 'conversation.export.downloaded']));
  });
});

describe('B-307 billing', () => {
  let h: Harness;
  let stripe: FakeStripe;
  beforeEach(async () => {
    stripe = await new FakeStripe().start();
    h = await harness({ BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: stripe.key, STRIPE_API_URL: stripe.url });
  });
  afterEach(async () => {
    await h.close();
    await stripe.stop();
  });

  it('picks the most specific price', () => {
    const items = [
      { match: 'any' as const, value: null, usage: '*', meter: 'prompt_tokens' as const, perUnits: 1_000_000, unitPriceMicros: 1 },
      { match: 'model' as const, value: 'm', usage: '*', meter: 'prompt_tokens' as const, perUnits: 1_000_000, unitPriceMicros: 2 },
      { match: 'model' as const, value: 'm', usage: 'api', meter: 'prompt_tokens' as const, perUnits: 1_000_000, unitPriceMicros: 3 },
      { match: 'profile' as const, value: 'p', usage: '*', meter: 'prompt_tokens' as const, perUnits: 1_000_000, unitPriceMicros: 4 }
    ];
    expect(priceFor(items, 'prompt_tokens', 'chat', 'x', null)!.unitPriceMicros).toBe(1);
    expect(priceFor(items, 'prompt_tokens', 'chat', 'm', null)!.unitPriceMicros).toBe(2);
    expect(priceFor(items, 'prompt_tokens', 'api', 'm', null)!.unitPriceMicros).toBe(3);
    expect(priceFor(items, 'prompt_tokens', 'api', 'm', 'p')!.unitPriceMicros).toBe(4);
    expect(priceFor(items, 'output_tokens', 'api', 'm', 'p')).toBeNull();
  });

  it('computes statements that reconcile with the usage report, exports them, and pushes a finished month to Stripe', async () => {
    await localUser(h, 'root', ['system-admin'], 'restricted');
    await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    await localUser(h, 'mem', ['member']);
    const root = await loginAdmin(h, 'root');
    const ta = await loginAdmin(h, 'ta');
    const mem = await login(h, 'mem');
    const rpost = (p: string, b: object = {}) => root.agent.post(p).set('x-csrf-token', root.csrf).send(b);

    const now = Date.now();
    const d = new Date(now);
    const lastMonthTs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 15);
    const rec = (o: Partial<Parameters<typeof h.s.quotas.record>[0]>) => h.s.quotas.record({ tenantId: h.tenantId, workspaceId: null, userId: null, kind: 'chat', model: 'llama3.1:8b', promptTokens: 0, outputTokens: 0, gpuMs: 0, ...o });
    await rec({ promptTokens: 600_000, outputTokens: 200_000, gpuMs: 3_600_000 });
    await rec({ promptTokens: 400_000, outputTokens: 100_000, gpuMs: 1_800_000 });
    await rec({ kind: 'api', promptTokens: 1000, outputTokens: 500 });
    await rec({ kind: 'embed', model: 'bge-small', promptTokens: 5000 });
    await rec({ promptTokens: 2_000_000, outputTokens: 0, ts: lastMonthTs });

    const book = await rpost('/api/admin/billing/price-books', {
      name: 'Internal chargeback',
      currency: 'EUR',
      isDefault: true,
      items: [
        { match: 'model', value: 'llama3.1:8b', usage: '*', meter: 'prompt_tokens', perUnits: 1_000_000, unitPriceMicros: 500_000 },
        { match: 'model', value: 'llama3.1:8b', usage: '*', meter: 'output_tokens', perUnits: 1_000_000, unitPriceMicros: 1_500_000 },
        { match: 'any', value: null, usage: '*', meter: 'gpu_seconds', perUnits: 3600, unitPriceMicros: 2_000_000 }
      ]
    }).expect(201);
    expect(book.body).toMatchObject({ currency: 'EUR', isDefault: true });
    await ta.agent.post('/api/admin/billing/price-books').set('x-csrf-token', ta.csrf).send({ name: 'x', items: [] }).expect(403);
    await mem.agent.get('/api/admin/billing/statements').expect(403);

    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const st = (await ta.agent.get(`/api/admin/billing/statements/${month}`).expect(200)).body;
    expect(st).toMatchObject({ state: 'preview', currency: 'EUR', book: { name: 'Internal chargeback' } });
    // Chat: 1M prompt tokens at 0.50, 300k output at 1.50, 1.5 GPU-hours at 2.00 = 0.50 + 0.45 + 3.00; the API use
    // of the same model is priced by the same items (0.0005 + 0.00075); requests and the embedding model are unpriced.
    expect(st.totalMicros).toBe(500_000 + 450_000 + 3_000_000 + 1250);
    expect(st.lines.filter((l: { priced: boolean }) => !l.priced).map((l: { kind: string; meter: string }) => `${l.kind}:${l.meter}`).sort()).toEqual(['api:requests', 'chat:requests', 'embed:prompt_tokens', 'embed:requests']);

    // The totals match the usage report for the same month.
    const from = Number(`${month.replace('-', '')}01`);
    const report = (await ta.agent.get(`/api/admin/usage/summary?by=model&from=${from}&to=${dayOf(now)}`).expect(200)).body.rows as { prompt: number; output: number; requests: number; gpuMs: number }[];
    const sum = (k: 'prompt' | 'output' | 'requests' | 'gpuMs') => report.reduce((a, r) => a + r[k], 0);
    expect(st.totals).toMatchObject({ promptTokens: sum('prompt'), outputTokens: sum('output'), requests: sum('requests'), gpuSeconds: sum('gpuMs') / 1000 });

    const csv = await ta.agent.get(`/api/admin/billing/statements/${month}/export?format=csv`).expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\r\n')[0]).toBe('month,kind,model,profile,meter,quantity,per_units,unit_price,amount,currency,priced');
    expect(csv.text).toContain(`${month},total,,,,,,,3.951250,EUR,`);
    const json = await ta.agent.get(`/api/admin/billing/statements/${month}/export?format=json`).expect(200);
    expect(JSON.parse(json.text)).toMatchObject({ totalMicros: 3_951_250, currency: 'EUR' });

    // The current month cannot be invoiced; last month can, once a customer is set.
    await rpost(`/api/admin/billing/statements/${month}/push`).expect(409);
    const last = new Date(lastMonthTs);
    const lastMonth = `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, '0')}`;
    expect((await rpost(`/api/admin/billing/statements/${lastMonth}/push`).expect(409)).body.detail).toMatch(/no billing customer/);
    await root.agent.put(`/api/admin/billing/tenants/${h.tenantId}`).set('x-csrf-token', root.csrf).send({ billingCustomer: 'cus_123' }).expect(200);
    const pushed = await rpost(`/api/admin/billing/statements/${lastMonth}/push`).expect(200);
    expect(pushed.body).toMatchObject({ state: 'pushed', providerRef: 'in_1', totalMicros: 1_000_000 });
    expect(stripe.items).toHaveLength(1);
    expect(stripe.items[0]).toMatchObject({ customer: 'cus_123', currency: 'eur', amount: '100' });
    expect(stripe.invoices[0]).toMatchObject({ customer: 'cus_123', pending_invoice_items_behavior: 'include', auto_advance: 'false' });
    expect(stripe.requests.every((r) => r.idempotencyKey?.startsWith('exprsn-'))).toBe(true);
    await rpost(`/api/admin/billing/statements/${lastMonth}/push`).expect(409);
    await rpost(`/api/admin/billing/statements/${lastMonth}/compute`).expect(409);

    const list = (await ta.agent.get('/api/admin/billing/statements').expect(200)).body;
    expect(list.statements.map((x: { month: string; state: string }) => `${x.month}:${x.state}`)).toEqual([`${month}:preview`, `${lastMonth}:pushed`]);
    expect(monthOf(lastMonthTs)).toBe(Number(lastMonth.replace('-', '')));

    // The scheduled close leaves a pushed statement alone.
    expect(await h.s.billing.closePrevious(h.tenantId)).toMatchObject({ skipped: 'statement is pushed' });
    const actions = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).select('action')).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['billing.price-book.created', 'billing.tenant.updated', 'billing.statement.pushed', 'billing.statement.exported']));
  });
});
