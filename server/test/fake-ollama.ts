import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';

export interface FakeModel {
  name: string;
  size: number;
  format?: string;
  family?: string;
  capabilities?: string[];
  digest?: string;
}

interface Msg {
  role: string;
  content: string;
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
}

export interface Reply {
  thinking?: string;
  content: string;
  toolCall?: { name: string; arguments: Record<string, unknown> };
}

const digestOf = (name: string) => createHash('sha256').update(name).digest('hex');

/**
 * A deterministic bag-of-words embedding: each word (lower case, plural folded) adds one to a hashed dimension, with
 * a hashed sign, then the vector is normalised. Texts sharing words are close; unrelated texts are nearly orthogonal.
 */
export function embedding(text: string, dims: number): number[] {
  const v = new Array<number>(dims).fill(0);
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2) continue;
    const w = raw.length > 3 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw;
    const h = createHash('sha256').update(w).digest();
    v[h[0]! % dims]! += h[1]! & 1 ? 1 : -1;
  }
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

/**
 * An Ollama stand-in speaking enough of its HTTP API for the gateway and chat: version, tags, ps, show, pull,
 * delete, generate (load and unload) and streamed chat. Replies come from `reply`, streamed word by word.
 */
export class FakeOllama {
  version = '0.12.3';
  /** Models the "registry" can pull. */
  registry = new Map<string, FakeModel>();
  available = new Map<string, FakeModel>();
  loaded = new Map<string, { size: number; expires: number }>();
  requests: { path: string; body: Record<string, unknown> }[] = [];
  chatDelayMs = 5;
  reply: (messages: Msg[], opts: { think: unknown; tools: unknown[]; model: string }) => Reply = (messages) => ({ content: `You said: ${messages[messages.length - 1]?.content ?? ''}` });
  /**
   * Guard models (any model whose name contains "guard") answer like Llama Guard: "safe", or "unsafe" and a line of
   * hazard categories. By default the last turn is unsafe (S1) when it contains "UNSAFE-TEST".
   */
  guard: (messages: Msg[]) => string = (messages) => (/UNSAFE-TEST/.test(messages[messages.length - 1]?.content ?? '') ? 'unsafe\nS1' : 'safe');
  /** Embedding size per model: models with "bge" in the name give 48 dimensions, others 64. */
  embedDims: (model: string) => number = (model) => (model.includes('bge') ? 48 : 64);
  /** When set, requests hang until released (to test queueing and stop). */
  hold: Promise<void> | null = null;
  /** When set, embedding requests hang until released (to test what keeps answering during a reindex). */
  embedHold: Promise<void> | null = null;
  down = false;
  server: Server;
  url = '';

  constructor() {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => void this.handle(req.method ?? 'GET', req.url ?? '/', raw, res, req));
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }

  addAvailable(m: FakeModel): void {
    this.available.set(m.name, { ...m, digest: m.digest ?? digestOf(m.name) });
  }

  private tag(m: FakeModel) {
    return { name: m.name, model: m.name, size: m.size, digest: m.digest ?? digestOf(m.name), details: { format: m.format ?? 'gguf', family: m.family ?? 'llama', parameter_size: '8B', quantization_level: 'Q4_K_M' } };
  }

  private async handle(method: string, path: string, raw: string, res: ServerResponse, req: IncomingMessage) {
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    this.requests.push({ path, body });
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (this.down) {
      req.socket.destroy();
      return;
    }
    const name = String(body.model ?? '');
    switch (`${method} ${path}`) {
      case 'GET /api/version':
        return json(200, { version: this.version });
      case 'GET /api/tags':
        return json(200, { models: [...this.available.values()].map((m) => this.tag(m)) });
      case 'GET /api/ps':
        return json(200, {
          models: [...this.loaded.entries()].map(([n, l]) => ({ ...this.tag(this.available.get(n) ?? { name: n, size: l.size }), size: l.size, size_vram: l.size, expires_at: new Date(l.expires).toISOString() }))
        });
      case 'POST /api/show': {
        const m = this.available.get(name);
        if (!m) return json(404, { error: `model '${name}' not found` });
        return json(200, { details: this.tag(m).details, capabilities: m.capabilities ?? ['completion'], model_info: { 'llama.context_length': 8192 } });
      }
      case 'DELETE /api/delete':
        this.available.delete(name);
        this.loaded.delete(name);
        return json(200, {});
      case 'POST /api/generate': {
        const m = this.available.get(name);
        if (!m) return json(404, { error: `model '${name}' not found` });
        if (body.keep_alive === 0) this.loaded.delete(name);
        else this.loaded.set(name, { size: m.size, expires: Date.now() + 30 * 60_000 });
        return json(200, { model: name, done: true, done_reason: body.keep_alive === 0 ? 'unload' : 'load' });
      }
      case 'POST /api/pull': {
        const m = this.registry.get(name);
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        if (!m) {
          res.end(JSON.stringify({ error: 'pull model manifest: file does not exist' }) + '\n');
          return;
        }
        res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n');
        res.write(JSON.stringify({ status: 'downloading', total: m.size, completed: Math.floor(m.size / 2) }) + '\n');
        res.write(JSON.stringify({ status: 'downloading', total: m.size, completed: m.size }) + '\n');
        this.addAvailable(m);
        res.end(JSON.stringify({ status: 'success' }) + '\n');
        return;
      }
      case 'POST /api/chat':
        return this.chat(body, res, req);
      case 'POST /api/embed': {
        const m = this.available.get(name);
        if (!m) return json(404, { error: `model '${name}' not found` });
        if (this.embedHold) await this.embedHold;
        const input = (Array.isArray(body.input) ? body.input : [body.input]).map(String);
        this.loaded.set(name, { size: m.size, expires: Date.now() + 30 * 60_000 });
        return json(200, { model: name, embeddings: input.map((t) => embedding(t, this.embedDims(name))), total_duration: 2_000_000 * input.length, load_duration: 0, prompt_eval_count: input.reduce((a, t) => a + Math.ceil(t.length / 4), 0) });
      }
      default:
        return json(404, { error: 'not found' });
    }
  }

  private async chat(body: Record<string, unknown>, res: ServerResponse, req: IncomingMessage) {
    const name = String(body.model);
    const m = this.available.get(name);
    if (!m) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `model '${name}' not found` }));
      return;
    }
    let closed = false;
    // The response closing before we end it means the client went away (stop, or a timeout).
    res.on('close', () => {
      if (!res.writableFinished) closed = true;
    });
    void req;
    if (this.hold) await this.hold;
    const cold = !this.loaded.has(name);
    this.loaded.set(name, { size: m.size, expires: Date.now() + 30 * 60_000 });
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const messages = body.messages as Msg[];
    const r = name.includes('guard') ? { content: this.guard(messages) } : this.reply(messages, { think: body.think, tools: (body.tools as unknown[]) ?? [], model: name });
    const send = (o: unknown) => res.write(JSON.stringify(o) + '\n');
    const sleep = () => new Promise((x) => setTimeout(x, this.chatDelayMs));
    let evalCount = 0;
    if (r.thinking && body.think) {
      for (const w of r.thinking.split(/(?<= )/)) {
        if (closed) return;
        send({ model: name, message: { role: 'assistant', content: '', thinking: w }, done: false });
        evalCount++;
        await sleep();
      }
    }
    if (r.toolCall) {
      send({ model: name, message: { role: 'assistant', content: '', tool_calls: [{ function: r.toolCall }] }, done: false });
      evalCount += 5;
    } else {
      for (const w of r.content.split(/(?<= )/)) {
        if (closed) return;
        send({ model: name, message: { role: 'assistant', content: w }, done: false });
        evalCount++;
        await sleep();
      }
    }
    const promptCount = messages.reduce((a, x) => a + Math.ceil((x.content ?? '').length / 4), 0);
    res.end(JSON.stringify({ model: name, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', total_duration: 900_000_000, load_duration: cold ? 400_000_000 : 1_000_000, prompt_eval_count: promptCount, prompt_eval_duration: 100_000_000, eval_count: evalCount, eval_duration: 400_000_000 }) + '\n');
  }
}
