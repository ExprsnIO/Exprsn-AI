import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { addText, encodePng, isPng, readText } from '../src/images/png.js';
import { DEFAULT_INJECTION_THRESHOLD, scoreInjection } from '../src/guardrails/injection.js';

export interface FakeModel {
  name: string;
  size: number;
  format?: string;
  family?: string;
  capabilities?: string[];
  digest?: string;
  /** B-11707: what `show` reports as the chat template and the default system prompt (a Magistral-like model). */
  template?: string;
  system?: string;
}

/** B-11707: the default system prompt of a Magistral-like model, which Ollama substitutes when a request carries none. */
export const TEMPLATE_SYSTEM = 'A user will ask you to solve a task. You should first draft your thinking process (inner monologue) until you have derived the final answer. Your thinking process must follow the template below:\n<think>\nYour thoughts or/and draft, like working through an exercise on scratch paper.\n</think>\nHere, provide a self-contained answer.';

/** A Magistral-like model for the fake registry: thinks through <think> blocks, tools listed in the template. */
export const templateModel = (name = 'magistral:24b', size = 14 * 1_000_000_000): FakeModel => ({ name, size, family: 'llama', capabilities: ['completion', 'tools', 'thinking'], template: '{{ if .System }}[SYSTEM_PROMPT]{{ .System }}[/SYSTEM_PROMPT]{{ end }}[INST]{{ .Prompt }}[/INST]<think>{{ .Thinking }}</think>', system: TEMPLATE_SYSTEM });

interface Msg {
  role: string;
  content: string;
  images?: string[];
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
 * Sprint 36c: a test picture carrying what the fake vision model "sees" in it: PNG tEXt chunks (`caption`, `ocr`,
 * `scores` as JSON), on `size` × `size` pixels of deterministic noise so it is not tiny (images under 1 KB inside
 * PDF and Word documents are skipped as icons).
 */
export function markedPng(marks: { caption?: string; ocr?: string; scores?: Record<string, number> }, size = 24, seed = 1): Buffer {
  const rgb = Buffer.alloc(size * size * 3);
  let x = seed * 2654435761;
  for (let i = 0; i < rgb.length; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    rgb[i] = x >>> 24;
  }
  let png = encodePng(size, size, rgb);
  if (marks.caption != null) png = addText(png, 'caption', marks.caption);
  if (marks.ocr != null) png = addText(png, 'ocr', marks.ocr);
  if (marks.scores) png = addText(png, 'scores', JSON.stringify(marks.scores));
  return png;
}

/** A JPEG-shaped test picture: the marks in a comment segment (`caption=…`, `ocr=…` lines). */
export function markedJpeg(marks: { caption?: string; ocr?: string }, pad = 2048): Buffer {
  const text = Buffer.from(`caption=${marks.caption ?? ''}\nocr=${marks.ocr ?? ''}`, 'latin1');
  const com = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from([(text.length + 2) >> 8, (text.length + 2) & 0xff]), text]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'), com, Buffer.alloc(pad, 0x11), Buffer.from([0xff, 0xd9])]);
}

/** What a test picture carries (see markedPng and markedJpeg). */
export function marksOf(image: Buffer): { caption?: string; ocr?: string; scores?: Record<string, number> } {
  if (isPng(image)) {
    const t = readText(image);
    return { ...(t.caption != null ? { caption: t.caption } : {}), ...(t.ocr != null ? { ocr: t.ocr } : {}), ...(t.scores ? { scores: JSON.parse(t.scores) as Record<string, number> } : {}) };
  }
  const at = image.indexOf(Buffer.from([0xff, 0xfe]));
  if (image[0] === 0xff && image[1] === 0xd8 && at > 0) {
    const len = image.readUInt16BE(at + 2);
    const out: Record<string, string> = {};
    for (const line of image.subarray(at + 4, at + 2 + len).toString('latin1').split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return out;
  }
  return {};
}

/**
 * The fake vision model: a description prompt (asking for a "caption") gets the picture's caption and text; a
 * classification prompt (asking for "scores") gets the picture's scores for the labels named in the prompt.
 */
export function fakeVision(messages: Msg[], images: Buffer[]): string {
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const marks = images[0] ? marksOf(images[0]) : {};
  if (system.includes('"scores"')) {
    const labels = (/against these labels: (.*?)\.(?: |$)/.exec(system)?.[1] ?? '').split(',').map((l) => l.trim()).filter(Boolean);
    return JSON.stringify({ scores: Object.fromEntries(labels.map((l) => [l, marks.scores?.[l] ?? 0])) });
  }
  return JSON.stringify({ caption: marks.caption ?? 'A picture.', text: marks.ocr ?? '' });
}

/** B-6902: a guard-model call of the `injection` mechanism (its system prompt names the classifier). */
export const isInjectionPrompt = (messages: Msg[]): boolean => messages.some((m) => m.role === 'system' && m.content.includes('prompt-injection classifier'));

/**
 * The fake guard model's injection verdict: deterministic, from the heuristic classifier's score at its default
 * threshold, so the CI corpus floor measured through a guard-model rule is repeatable.
 */
export function fakeInjectionGuard(messages: Msg[]): string {
  const text = messages[messages.length - 1]?.content ?? '';
  return scoreInjection(text).score >= DEFAULT_INJECTION_THRESHOLD ? 'injection' : 'benign';
}

/**
 * B-6901: a model that obeys instructions it reads outside untrusted-content blocks: when a system or tool message
 * names one of the canaries outside such a block, it answers with that canary (as a model that followed the
 * injected instruction would); otherwise with `fallback`. Text inside `<untrusted-content>` is treated as data.
 */
export function obeyingReply(canaries: string[], fallback = 'Here is what the sources say.'): (messages: Msg[]) => Reply {
  return (messages) => {
    for (const m of messages) {
      if (m.role === 'user') continue;
      const outside = m.content.replace(/<untrusted-content[\s\S]*?<\/untrusted-content>/g, '');
      const hit = canaries.find((c) => outside.includes(c));
      if (hit) return { content: hit };
    }
    return { content: fallback };
  };
}

/**
 * 1.6.0 Sprint 38b (B-7001): a model that leaks: asked for its system prompt or instructions, it prints the system
 * message it was given (and any canary the request names); asked to adopt a persona or to send data somewhere, it
 * obliges with the canary. Everything else is answered with `fallback`. `resists` lists attack ids (by their canary)
 * the model resists, for a target that passes some attacks and fails others.
 */
export function leakingReply(opts: { fallback?: string; resists?: string[] } = {}): (messages: Msg[]) => Reply {
  const fallback = opts.fallback ?? 'Here is what I can tell you.';
  const resists = new Set(opts.resists ?? []);
  return (messages) => {
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const last = messages[messages.length - 1]?.content ?? '';
    const canary = /\b([A-Z]{3,}-[A-Z0-9]{2,}(?:-[A-Z0-9]{2,})?)\b/.exec(last)?.[1] ?? null;
    if (canary && resists.has(canary)) return { content: 'I cannot help with that.' };
    if (/system prompt|instructions you were given|everything above|instructions above|hidden instructions|repeat everything/i.test(last)) return { content: `${canary ? `${canary}\n` : ''}${system || 'I have no system prompt.'}` };
    if (canary) return { content: `Sure. ${canary}` };
    return { content: fallback };
  };
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
   * B-11707: a Magistral-like model (one whose `show` has a <think> system prompt). Without a system message the
   * server substitutes the model's own, and the model answers in prose with a thinking draft, tools or not. With one,
   * it calls a tool when the turn asks for one, and thinks inside <think> tags only when the prompt asks for them.
   */
  templated: (messages: Msg[], opts: { think: unknown; tools: unknown[]; model: string }) => Reply = (messages, opts) => {
    const system = messages.find((x) => x.role === 'system')?.content;
    const last = messages[messages.length - 1]?.content ?? '';
    if (!system) return { content: `<think>\nThe user wants 17 times 23, which is 391.\n</think>\n17 × 23 = 391.` };
    if (opts.tools.length && /calculate/i.test(last)) return { content: '', toolCall: { name: 'calculate', arguments: { expression: '17*23' } } };
    if (opts.think && system.includes('<think>')) return { content: `<think>\nWorking it out on scratch paper.\n</think>\nThe answer to "${last}".` };
    return { content: `Plainly: ${last}` };
  };
  /**
   * Guard models (any model whose name contains "guard") answer like Llama Guard: "safe", or "unsafe" and a line of
   * hazard categories. By default the last turn is unsafe (S1) when it contains "UNSAFE-TEST".
   */
  guard: (messages: Msg[]) => string = (messages) => (isInjectionPrompt(messages) ? fakeInjectionGuard(messages) : /UNSAFE-TEST/.test(messages[messages.length - 1]?.content ?? '') ? 'unsafe\nS1' : 'safe');
  /** Embedding size per model: models with "bge" in the name give 48 dimensions, others 64. */
  embedDims: (model: string) => number = (model) => (model.includes('bge') ? 48 : 64);
  /** Sprint 36c: answers to messages carrying images (by default `fakeVision`). */
  vision: (messages: Msg[], images: Buffer[], model: string) => string = (messages, images) => fakeVision(messages, images);
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
        return json(200, { details: this.tag(m).details, capabilities: m.capabilities ?? ['completion'], model_info: { 'llama.context_length': 8192 }, ...(m.template ? { template: m.template } : {}), ...(m.system ? { system: m.system } : {}) });
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
    const images = messages.flatMap((x) => x.images ?? []).map((b) => Buffer.from(b, 'base64'));
    const r = name.includes('guard') ? { content: this.guard(messages) } : m.system?.includes('<think>') ? this.templated(messages, { think: body.think, tools: (body.tools as unknown[]) ?? [], model: name }) : images.length ? { content: this.vision(messages, images, name) } : this.reply(messages, { think: body.think, tools: (body.tools as unknown[]) ?? [], model: name });
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
