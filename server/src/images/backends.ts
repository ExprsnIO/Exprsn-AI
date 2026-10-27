import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fetch, WebSocket, type Dispatcher } from 'undici';
import { ndjson } from '../gateway/ollama.js';
import { literalProblem, serviceAgent, servicePolicy, type ServicePolicy } from '../platform/egress.js';

/*
 * Image generation runs on a worker behind this interface: a ComfyUI server (HTTP API, a workflow template with
 * placeholders), or a diffusers-style HTTP service. Workers report real progress (queue position, denoising step);
 * the console shows exactly that and never invents a percentage.
 */

export interface GenerateRequest {
  prompt: string;
  negative?: string;
  width: number;
  height: number;
  seed: number;
  steps: number;
  /** 1.7.0: a reference picture the model redraws by the prompt (AI restyle); only a backend that `restyles`. */
  image?: Buffer;
}

export interface GenerateProgress {
  stage: string;
  step?: number;
  steps?: number;
}

export interface GenerateResult {
  image: Buffer;
  /** GPU time the worker reports, when it does. */
  gpuMs?: number;
  /** A safety score the worker computed itself (0–1, higher is less safe), when it has a checker. */
  safety?: number;
  model?: string;
}

export interface ImageSize {
  width: number;
  height: number;
}

export interface ImageBackend {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly model: string | null;
  /** Jobs this worker runs at once (one per GPU). */
  readonly concurrency: number;
  /** Denoising steps per image. */
  readonly steps: number;
  /** The sizes this worker's model was made for, the default first. None declared: the console offers its general list. */
  readonly sizes?: readonly ImageSize[];
  /** 1.7.0: takes a reference picture (`GenerateRequest.image`). */
  readonly restyles?: boolean;
  generate(req: GenerateRequest, o: { signal: AbortSignal; onProgress: (p: GenerateProgress) => void }): Promise<GenerateResult>;
  /** 1.7.0: whether the worker answers and has not failed, asked before image_generate picks it (a few seconds at most). */
  available?(signal?: AbortSignal): Promise<boolean>;
}

/** 1.7.0: one operation of an edit, as the CPU editor takes it (`{op, ...arguments}`; `images/edits.ts` checks them). */
export type EditOp = { op: string } & Record<string, unknown>;

export interface EditResult {
  image: Buffer;
  width: number;
  height: number;
  /** CPU time the editor reports. */
  ms?: number;
}

/** 1.7.0: crop, resize, filters and styles on the CPU: the image worker's `POST /edit` (services/image-worker/edits.py). */
export interface ImageEditor {
  edit(image: Buffer, ops: EditOp[], signal: AbortSignal): Promise<EditResult>;
}

/** The editor over HTTP. A 400 is an operation the editor refused: its reason is the error, for the caller to fix. */
export class HttpImageEditor implements ImageEditor {
  private readonly net: { dispatcher: Dispatcher; refused: string | null };
  constructor(
    private readonly url: string,
    policy: ServicePolicy = servicePolicy()
  ) {
    this.net = { dispatcher: serviceAgent(policy), refused: literalProblem(url, policy) };
  }

  async edit(image: Buffer, ops: EditOp[], signal: AbortSignal): Promise<EditResult> {
    if (this.net.refused) throw new BackendError(`The image editor's address is refused: ${this.net.refused}`);
    const res = await fetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ image: image.toString('base64'), ops }), signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]), dispatcher: this.net.dispatcher });
    const j = (await res.json().catch(() => ({}))) as { image?: string; width?: number; height?: number; cpu_seconds?: number; error?: string };
    if (!res.ok || !j.image) throw new BackendError(j.error ?? `The image editor answered ${res.status}.`);
    return { image: Buffer.from(j.image, 'base64'), width: Number(j.width), height: Number(j.height), ...(j.cpu_seconds != null ? { ms: Math.round(j.cpu_seconds * 1000) } : {}) };
  }
}

export class BackendError extends Error {}

/** "1024x768": each side as the Images API takes it (256 to 2048, a multiple of 8). */
const sizeConfig = z
  .string()
  .regex(/^\d{3,4}x\d{3,4}$/)
  .transform((v): ImageSize => {
    const [width, height] = v.split('x').map(Number) as [number, number];
    return { width, height };
  })
  .refine((v) => [v.width, v.height].every((n) => n >= 256 && n <= 2048 && n % 8 === 0), 'Each side is 256 to 2048 and a multiple of 8');

export const backendConfig = z.array(
  z
    .object({
      id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
      kind: z.enum(['comfyui', 'diffusers']),
      url: z.url(),
      label: z.string().max(100).optional(),
      model: z.string().max(200).optional(),
      /** ComfyUI: path to a workflow in API format, with "{{prompt}}", "{{negative}}", "{{seed}}", "{{width}}", "{{height}}", "{{steps}}". */
      workflow: z.string().optional(),
      concurrency: z.number().int().min(1).max(16).default(1),
      steps: z.number().int().min(1).max(200).default(30),
      /** The sizes offered for this model, as "WIDTHxHEIGHT", the default first. */
      sizes: z.array(sizeConfig).min(1).max(12).optional(),
      timeoutMs: z.number().int().min(10_000).max(3_600_000).default(600_000),
      /** 1.7.0: a diffusers worker that takes a reference picture (`image` on /generate) for AI restyle. */
      restyles: z.boolean().optional()
    })
    .strict()
);
export type BackendConfig = z.infer<typeof backendConfig>[number];

/** Replaces placeholders in a ComfyUI workflow. A value that is only a placeholder takes the typed value. */
export function fillWorkflow(template: unknown, values: Record<string, string | number>): unknown {
  if (typeof template === 'string') {
    const only = /^\{\{(\w+)\}\}$/.exec(template);
    if (only && only[1]! in values) return values[only[1]!];
    return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
  }
  if (Array.isArray(template)) return template.map((x) => fillWorkflow(x, values));
  if (template && typeof template === 'object') return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, fillWorkflow(v, values)]));
  return template;
}

/** B-901: the worker's address is checked (literals here, names in every connection's DNS lookup). */
function pinned(c: BackendConfig, policy: ServicePolicy): { dispatcher: Dispatcher; refused: string | null } {
  // 1.7.0: a worker that answers only when the picture is done (the SD worker) may take longer than undici's default
  // five minutes for the headers; the backend's own timeout applies instead.
  return { dispatcher: serviceAgent(policy, {}, { headersTimeout: c.timeoutMs, bodyTimeout: c.timeoutMs }), refused: literalProblem(c.url, policy) };
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason as Error)), { once: true });
  });

/** ComfyUI: POST /prompt, progress over /ws when available, results from /history and /view. */
export class ComfyUiBackend implements ImageBackend {
  readonly kind = 'comfyui';
  readonly label: string;
  readonly model: string | null;
  readonly concurrency: number;
  readonly steps: number;
  readonly sizes: readonly ImageSize[];
  private readonly template: unknown;
  private readonly net: { dispatcher: Dispatcher; refused: string | null };

  constructor(
    readonly id: string,
    private readonly c: BackendConfig,
    policy: ServicePolicy = servicePolicy()
  ) {
    this.net = pinned(c, policy);
    if (!c.workflow) throw new Error(`Image backend ${id}: a ComfyUI backend needs a workflow file`);
    this.template = JSON.parse(readFileSync(c.workflow, 'utf8'));
    this.label = c.label ?? `comfyui, ${c.model ?? 'workflow'}`;
    this.model = c.model ?? null;
    this.concurrency = c.concurrency;
    this.steps = c.steps;
    this.sizes = c.sizes ?? [];
  }

  private url(p: string): string {
    return new URL(p, this.c.url.endsWith('/') ? this.c.url : `${this.c.url}/`).toString();
  }

  async available(signal?: AbortSignal): Promise<boolean> {
    if (this.net.refused) return false;
    const res = await fetch(this.url('system_stats'), { signal: signal ?? AbortSignal.timeout(3000), dispatcher: this.net.dispatcher }).catch(() => null);
    return !!res?.ok;
  }

  async generate(req: GenerateRequest, o: { signal: AbortSignal; onProgress: (p: GenerateProgress) => void }): Promise<GenerateResult> {
    if (this.net.refused) throw new BackendError(`The ComfyUI address is refused: ${this.net.refused}`);
    if (req.image) throw new BackendError('A ComfyUI backend does not take a reference picture.');
    const dispatcher = this.net.dispatcher;
    const clientId = randomUUID();
    const signal = AbortSignal.any([o.signal, AbortSignal.timeout(this.c.timeoutMs)]);
    const prompt = fillWorkflow(this.template, { prompt: req.prompt, negative: req.negative ?? '', seed: req.seed, width: req.width, height: req.height, steps: req.steps });
    let ws: WebSocket | null;
    {
      try {
        ws = new WebSocket(this.url(`ws?clientId=${clientId}`).replace(/^http/, 'ws'), { dispatcher });
        ws.onmessage = (ev) => {
          try {
            const m = JSON.parse(String(ev.data)) as { type?: string; data?: { value?: number; max?: number } };
            if (m.type === 'progress' && m.data?.max) o.onProgress({ stage: 'Denoising', step: m.data.value ?? 0, steps: m.data.max });
            else if (m.type === 'executing') o.onProgress({ stage: 'Running the workflow' });
          } catch {
            /* binary previews and unknown messages are ignored */
          }
        };
        ws.onerror = () => undefined;
      } catch {
        ws = null;
      }
    }
    try {
      const res = await fetch(this.url('prompt'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, client_id: clientId }), signal, dispatcher });
      if (!res.ok) throw new BackendError(`ComfyUI refused the workflow (${res.status}): ${(await res.text()).slice(0, 300)}`);
      const { prompt_id: id } = (await res.json()) as { prompt_id: string };
      const onAbort = () => void fetch(this.url('interrupt'), { method: 'POST', dispatcher }).catch(() => undefined);
      o.signal.addEventListener('abort', onAbort, { once: true });
      o.onProgress({ stage: 'Queued on the worker' });
      for (;;) {
        await sleep(1000, signal);
        const h = (await (await fetch(this.url(`history/${encodeURIComponent(id)}`), { signal, dispatcher })).json()) as Record<string, { status?: { status_str?: string; messages?: unknown[] }; outputs?: Record<string, { images?: { filename: string; subfolder: string; type: string }[] }> }>;
        const entry = h[id];
        if (!entry) continue;
        if (entry.status?.status_str === 'error') throw new BackendError('The ComfyUI workflow failed on the worker.');
        const img = Object.values(entry.outputs ?? {}).flatMap((x) => x.images ?? [])[0];
        if (!img) continue;
        const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder, type: img.type });
        const bytes = await fetch(this.url(`view?${q}`), { signal, dispatcher });
        if (!bytes.ok) throw new BackendError(`Could not fetch the image from ComfyUI (${bytes.status}).`);
        o.signal.removeEventListener('abort', onAbort);
        return { image: Buffer.from(await bytes.arrayBuffer()), ...(this.model ? { model: this.model } : {}) };
      }
    } finally {
      ws?.close();
    }
  }
}

/**
 * A diffusers-style worker: POST /generate with the request as JSON. It answers either JSON
 * `{image: base64, gpu_seconds?, nsfw_score?}` or NDJSON lines `{step, steps}` followed by that object.
 */
export class DiffusersBackend implements ImageBackend {
  readonly kind = 'diffusers';
  readonly restyles: boolean;
  readonly label: string;
  readonly model: string | null;
  readonly concurrency: number;
  readonly steps: number;
  readonly sizes: readonly ImageSize[];
  private readonly net: { dispatcher: Dispatcher; refused: string | null };

  constructor(
    readonly id: string,
    private readonly c: BackendConfig,
    policy: ServicePolicy = servicePolicy()
  ) {
    this.net = pinned(c, policy);
    this.steps = c.steps;
    this.sizes = c.sizes ?? [];
    this.label = c.label ?? `diffusers, ${c.model ?? 'default model'}`;
    this.model = c.model ?? null;
    this.concurrency = c.concurrency;
    this.restyles = c.restyles ?? false;
  }

  /** The worker's /health: up unless it does not answer or says `failed` (`idle` and `loading` take requests, which wait). */
  async available(signal?: AbortSignal): Promise<boolean> {
    if (this.net.refused) return false;
    const res = await fetch(new URL('health', this.c.url.endsWith('/') ? this.c.url : `${this.c.url}/`), { signal: signal ?? AbortSignal.timeout(3000), dispatcher: this.net.dispatcher }).catch(() => null);
    if (!res?.ok) return false;
    const j = (await res.json().catch(() => null)) as { status?: string } | null;
    return j?.status !== 'failed';
  }

  async generate(req: GenerateRequest, o: { signal: AbortSignal; onProgress: (p: GenerateProgress) => void }): Promise<GenerateResult> {
    if (this.net.refused) throw new BackendError(`The image worker's address is refused: ${this.net.refused}`);
    const signal = AbortSignal.any([o.signal, AbortSignal.timeout(this.c.timeoutMs)]);
    const res = await fetch(new URL('generate', this.c.url.endsWith('/') ? this.c.url : `${this.c.url}/`), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/x-ndjson, application/json' },
      body: JSON.stringify({ prompt: req.prompt, negative_prompt: req.negative ?? '', width: req.width, height: req.height, seed: req.seed, num_inference_steps: req.steps, ...(this.model ? { model: this.model } : {}), ...(req.image ? { image: req.image.toString('base64') } : {}) }),
      signal,
      dispatcher: this.net.dispatcher
    });
    if (!res.ok || !res.body) throw new BackendError(`The image worker answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
    type Final = { image?: string; gpu_seconds?: number; nsfw_score?: number; error?: string; step?: number; steps?: number };
    const finish = (f: Final): GenerateResult => {
      if (f.error) throw new BackendError(f.error);
      if (!f.image) throw new BackendError('The image worker returned no image.');
      return { image: Buffer.from(f.image, 'base64'), ...(f.gpu_seconds != null ? { gpuMs: Math.round(f.gpu_seconds * 1000) } : {}), ...(f.nsfw_score != null ? { safety: Number(f.nsfw_score) } : {}), ...(this.model ? { model: this.model } : {}) };
    };
    if (/ndjson/.test(res.headers.get('content-type') ?? '')) {
      for await (const line of ndjson<Final>(res.body as unknown as AsyncIterable<Uint8Array>)) {
        if (line.image || line.error) return finish(line);
        if (line.step != null) o.onProgress({ stage: 'Denoising', step: line.step, ...(line.steps != null ? { steps: line.steps } : {}) });
      }
      throw new BackendError('The image worker closed the stream without an image.');
    }
    o.onProgress({ stage: 'Generating' });
    return finish((await res.json()) as Final);
  }
}

export function createBackends(raw: string, policy: ServicePolicy = servicePolicy()): ImageBackend[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || '[]');
  } catch {
    throw new Error('IMAGE_BACKENDS is not valid JSON');
  }
  const list = backendConfig.parse(parsed);
  return list.map((c) => (c.kind === 'comfyui' ? new ComfyUiBackend(c.id, c, policy) : new DiffusersBackend(c.id, c, policy)));
}
