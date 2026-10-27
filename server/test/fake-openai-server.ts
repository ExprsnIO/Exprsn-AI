import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rmSync } from 'node:fs';
import { embedding } from './fake-ollama.js';

/** One message as a Chat Completions client sends it. */
export interface WireMsg {
  role: string;
  content: string | null | { type: string; text?: string }[];
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface OpenAIReply {
  content: string;
  reasoning?: string;
  toolCall?: { name: string; arguments: Record<string, unknown> };
}

export interface FakeServerModel {
  id: string;
  available?: boolean;
  reason?: string;
  ownedBy?: string;
  /** llama.cpp puts `n_ctx_train` and `size` here. */
  meta?: Record<string, unknown>;
}

const text = (c: WireMsg['content']) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text ?? '').join('') : '');

/**
 * B-4303: a Chat Completions server standing in for Apple's `fm serve`, `mlx_lm.server` and llama.cpp's
 * `llama-server`, on a TCP port or a Unix socket: `/health` (in `fm serve`'s shape, llama.cpp's, or absent),
 * `/v1/models`, `/props` (llama.cpp), streamed and plain `/v1/chat/completions` with tool calls split across deltas,
 * `response_format` JSON schema, reasoning deltas and usage (optional, as `fm serve` sends none while streaming),
 * and `/v1/embeddings` when `embeddings` is on. It refuses requests without the bearer token when `token` is set.
 */
export class FakeOpenAIServer {
  style: 'fm' | 'llama' | 'mlx' = 'fm';
  models = new Map<string, FakeServerModel>();
  requests: { method: string; path: string; body: Record<string, unknown>; auth: string | null }[] = [];
  token: string | null = null;
  /** Usage in the last streamed chunk (llama.cpp and vLLM send it; `fm serve` does not). */
  streamUsage = false;
  embeddings = false;
  /** Context length llama.cpp reports from /props. */
  nCtx = 8192;
  chatDelayMs = 2;
  down = false;
  /** By default a request with tools gets a calculate call (as Apple's model makes one), and a tool result an answer. */
  reply: (messages: WireMsg[], opts: { tools: unknown[]; model: string; body: Record<string, unknown> }) => OpenAIReply = (messages, o) => {
    const last = messages[messages.length - 1];
    if (last?.role === 'tool') return { content: `The result is ${text(last.content)}.` };
    if (o.tools.length) return { content: '', toolCall: { name: 'calculate', arguments: { expression: '17 * 23' } } };
    return { content: `You said: ${text(last?.content ?? '')}` };
  };
  server: Server;
  url = '';
  socketPath: string | null = null;

  constructor() {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => void this.handle(req, raw, res));
    });
  }

  async start(opts: { socketPath?: string } = {}): Promise<this> {
    if (opts.socketPath) {
      rmSync(opts.socketPath, { force: true });
      await new Promise<void>((r) => this.server.listen(opts.socketPath, r));
      this.socketPath = opts.socketPath;
      this.url = 'http://localhost';
      return this;
    }
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
    if (this.socketPath) rmSync(this.socketPath, { force: true });
  }

  add(m: FakeServerModel): this {
    this.models.set(m.id, m);
    return this;
  }

  chats(): Record<string, unknown>[] {
    return this.requests.filter((r) => r.path === '/v1/chat/completions').map((r) => r.body);
  }

  private async handle(req: IncomingMessage, raw: string, res: ServerResponse) {
    const method = req.method ?? 'GET';
    const path = (req.url ?? '/').split('?')[0]!;
    let body: Record<string, unknown>;
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    this.requests.push({ method, path, body, auth: (req.headers.authorization as string | undefined) ?? null });
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (this.down) {
      req.socket.destroy();
      return;
    }
    if (this.token && req.headers.authorization !== `Bearer ${this.token}`) return json(401, { error: { message: 'Missing or invalid bearer token', type: 'unauthorized' } });
    const list = [...this.models.values()];
    switch (`${method} ${path}`) {
      case 'GET /health':
        if (this.style === 'mlx') return json(404, { error: { message: 'Not found' } });
        if (this.style === 'llama') return json(200, { status: 'ok' });
        return json(200, { status: 'fm serve is running', models: list.map((m) => ({ name: m.id, available: m.available !== false, ...(m.available === false ? { reason: m.reason ?? 'unavailable' } : {}) })) });
      case 'GET /props':
        if (this.style !== 'llama') return json(404, { error: { message: 'Not found' } });
        return json(200, { default_generation_settings: { n_ctx: this.nCtx }, build_info: 'b6000' });
      case 'GET /v1/models':
        return json(200, { object: 'list', data: list.map((m) => ({ id: m.id, object: 'model', created: 1, owned_by: m.ownedBy ?? 'local', ...(m.meta ? { meta: m.meta } : {}) })) });
      case 'POST /v1/chat/completions':
        return this.chat(body, res);
      case 'POST /v1/embeddings': {
        if (!this.embeddings) return json(404, { error: { code: '404', type: 'not_found', message: 'Not found: POST /v1/embeddings' } });
        const input = (Array.isArray(body.input) ? body.input : [body.input]).map(String);
        return json(200, { object: 'list', model: body.model, data: input.map((t, index) => ({ object: 'embedding', index, embedding: embedding(t, 64) })), usage: { prompt_tokens: input.reduce((a, t) => a + Math.ceil(t.length / 4), 0), total_tokens: 0 } });
      }
      default:
        return json(404, { error: { code: '404', type: 'not_found', message: `Not found: ${method} ${path}` } });
    }
  }

  private async chat(body: Record<string, unknown>, res: ServerResponse) {
    const model = String(body.model ?? '');
    const m = this.models.get(model);
    if (!m) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Model '${model}' not found`, type: 'not_found' } }));
      return;
    }
    if (m.available === false) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: '503', message: `Model '${model}' is unavailable: ${m.reason ?? 'unavailable'}`, type: 'service_unavailable' } }));
      return;
    }
    const messages = (body.messages as WireMsg[]) ?? [];
    const format = body.response_format as { type?: string; json_schema?: { schema?: { properties?: Record<string, unknown> } } } | undefined;
    let r: OpenAIReply;
    if (format?.type === 'json_schema' || format?.type === 'json_object') {
      const props = Object.keys(format.json_schema?.schema?.properties ?? { answer: 1 });
      r = { content: JSON.stringify(Object.fromEntries(props.map((k) => [k, k === 'city' ? 'Lisbon' : k === 'country' ? 'Portugal' : 'yes']))) };
    } else r = this.reply(messages, { tools: (body.tools as unknown[]) ?? [], model, body });
    const id = `chatcmpl-${Date.now()}`;
    const prompt = messages.reduce((a, x) => a + Math.ceil(text(x.content).length / 4), 0);
    let completion = 0;
    if (body.stream !== true) {
      completion = Math.ceil(r.content.length / 4) || 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id, object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: r.toolCall ? null : r.content, ...(r.toolCall ? { tool_calls: [{ id: 'call-1', type: 'function', function: { name: r.toolCall.name, arguments: JSON.stringify(r.toolCall.arguments) } }] } : {}) }, finish_reason: r.toolCall ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } }));
      return;
    }
    let closed = false;
    res.on('close', () => {
      if (!res.writableFinished) closed = true;
    });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const sleep = () => new Promise((x) => setTimeout(x, this.chatDelayMs));
    send({ id, model, choices: [{ delta: { role: 'assistant' } }] });
    if (r.reasoning) {
      for (const w of r.reasoning.split(/(?<= )/)) {
        if (closed) return;
        send({ id, model, choices: [{ delta: { reasoning_content: w } }] });
        completion++;
        await sleep();
      }
    }
    if (r.toolCall) {
      // The arguments arrive in two fragments, as servers stream them.
      const args = JSON.stringify(r.toolCall.arguments);
      const half = Math.ceil(args.length / 2);
      send({ id, model, choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-7F3A', type: 'function', function: { name: r.toolCall.name, arguments: args.slice(0, half) } }] } }] });
      send({ id, model, choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] } }] });
      completion += 5;
      send({ id, model, choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      for (const w of r.content.split(/(?<= )/)) {
        if (closed) return;
        send({ id, model, choices: [{ delta: { content: w } }] });
        completion++;
        await sleep();
      }
      send({ id, model, choices: [{ delta: {}, finish_reason: 'stop' }] });
    }
    if (this.streamUsage) send({ id, model, choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion } });
    res.end('data: [DONE]\n\n');
  }
}
