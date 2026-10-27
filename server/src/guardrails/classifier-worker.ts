import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { request, type Dispatcher } from 'undici';
import { LABELS, type Label } from '../authz/labels.js';
import type { Config } from '../config/index.js';
import { literalProblem, serviceAgent, servicePolicy, type ServicePolicy } from '../platform/egress.js';

/*
 * 1.7.0 (B-3806): the classifier worker. Ollama serves no sequence-classification heads, so a text-classification
 * model imported from a repository is served by a small worker (Python, transformers) behind this contract, over
 * HTTP. docs/classifier-worker.md has the whole contract.
 *
 *   GET  /v1/info                          what the worker runs on and the models it holds
 *   PUT  /v1/models/:digest/files/:name    one file of a model (raw bytes, `x-sha256`); the worker checks the hash
 *   POST /v1/models/:digest/load           { files: [{ name, sha256 }] }: checks every file, recomputes the model
 *                                          digest, loads the model → { labels, multiLabel, maxLength, … };
 *                                          404 { code: "missing", missing: [...] } when files are not held
 *   POST /v1/classify                      { model: digest, texts: [...] } → { results: [{ scores: {label: 0..1} }] };
 *                                          404 { code: "missing" } when the model is not held
 *
 * The worker fetches nothing: it holds only what this server pushed, which is what an import pulled and verified
 * against its pins. The model digest is over the names and SHA-256 hashes of the files (`classifierModelDigest`), so
 * the worker and the catalogue name a model by the same value, and a file that changed is a different model.
 */

export interface WorkerFile {
  name: string;
  sha256: string;
  bytes: number;
}

export interface LoadedClassifierModel {
  labels: string[];
  /** Sigmoid per label (several may apply) instead of a softmax over the labels. */
  multiLabel: boolean;
  /** The longest input the model reads, in tokens; longer text is truncated. */
  maxLength: number | null;
  architecture: string | null;
  device: string | null;
}

export interface ClassifierWorkerInfo {
  contract: number;
  runtime: string | null;
  device: string | null;
  /** Digests (`sha256:<hex>`) of the models the worker holds complete. */
  models: string[];
}

export type WorkerErrorCode = 'unavailable' | 'unreachable' | 'missing' | 'refused' | 'error';

export class ClassifierWorkerError extends Error {
  constructor(
    message: string,
    readonly code: WorkerErrorCode,
    readonly missing: string[] = []
  ) {
    super(message);
  }
}

/** The classifier worker the server drives (a Python service over HTTP; a fake in tests). */
export interface ClassifierWorker {
  readonly kind: string;
  /** False when no worker is configured; `reason` then says what to set. */
  readonly available: boolean;
  readonly reason: string | null;
  /** The highest label of text the worker may be sent. */
  readonly labelCeiling: Label;
  info(): Promise<ClassifierWorkerInfo>;
  putFile(digest: string, file: WorkerFile, body: Readable | Buffer): Promise<void>;
  load(digest: string, files: Pick<WorkerFile, 'name' | 'sha256'>[]): Promise<LoadedClassifierModel>;
  classify(digest: string, texts: string[], signal?: AbortSignal): Promise<Record<string, number>[]>;
}

export const NO_CLASSIFIER_WORKER = 'No classifier worker is configured. A system admin sets CLASSIFIER_WORKER_URL to the worker\'s address.';

/** A file name the worker stores: one path segment, as the hubs name configuration, tokenizer and weight files. */
export const WORKER_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/**
 * The digest a classifier model is pinned by: SHA-256 over one line per file, `<sha256>  <name>\n`, sorted by name
 * (the format of `sha256sum`). The worker computes the same value from the bytes it holds.
 */
export function classifierModelDigest(files: Pick<WorkerFile, 'name' | 'sha256'>[]): string {
  const lines = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((f) => `${f.sha256.toLowerCase()}  ${f.name}\n`);
  return `sha256:${createHash('sha256').update(lines.join('')).digest('hex')}`;
}

const hex = (digest: string) => digest.replace(/^sha256:/, '').toLowerCase();

/** Used when CLASSIFIER_WORKER_URL is unset: every call fails with the same clear reason. */
export class UnavailableClassifierWorker implements ClassifierWorker {
  readonly kind = 'none';
  readonly available = false;
  readonly reason = NO_CLASSIFIER_WORKER;
  readonly labelCeiling: Label = 'public';
  private fail(): never {
    throw new ClassifierWorkerError(NO_CLASSIFIER_WORKER, 'unavailable');
  }
  async info(): Promise<ClassifierWorkerInfo> {
    return this.fail();
  }
  async putFile(): Promise<void> {
    return this.fail();
  }
  async load(): Promise<LoadedClassifierModel> {
    return this.fail();
  }
  async classify(): Promise<Record<string, number>[]> {
    return this.fail();
  }
}

const infoSchema = z.object({ contract: z.number().int().min(1).max(100).default(1), runtime: z.string().max(300).nullable().default(null), device: z.string().max(100).nullable().default(null), models: z.array(z.string().max(100)).max(10_000).default([]) });
const loadedSchema = z.object({
  labels: z.array(z.string().min(1).max(100)).min(1).max(1000),
  multiLabel: z.boolean().default(false),
  maxLength: z.number().int().min(1).nullable().default(null),
  architecture: z.string().max(200).nullable().default(null),
  device: z.string().max(100).nullable().default(null)
});
const classifySchema = z.object({ results: z.array(z.object({ scores: z.record(z.string(), z.number().min(0).max(1)) })).max(10_000) });

/** The HTTP adapter for the worker. */
export class HttpClassifierWorker implements ClassifierWorker {
  readonly kind = 'http';
  readonly available = true;
  readonly reason = null;
  readonly labelCeiling: Label;

  private readonly dispatcher: Dispatcher;
  private readonly refused: string | null;
  private readonly base: string;

  constructor(private readonly o: { url: string; token?: string; timeoutMs: number; labelCeiling?: Label; policy?: ServicePolicy; caFile?: string }) {
    const policy = o.policy ?? servicePolicy();
    this.dispatcher = serviceAgent(policy, o.caFile ? { ca: readFileSync(o.caFile) } : {});
    this.refused = literalProblem(o.url, policy);
    this.base = o.url.endsWith('/') ? o.url : `${o.url}/`;
    this.labelCeiling = o.labelCeiling ?? LABELS[LABELS.length - 1]!;
  }

  private async call<T extends z.ZodType>(method: 'GET' | 'POST' | 'PUT', path: string, schema: T, opts: { json?: unknown; body?: Readable | Buffer; headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<z.infer<T>> {
    if (this.refused) throw new ClassifierWorkerError(`The classifier worker's address is refused: ${this.refused}`, 'refused');
    const timeout = AbortSignal.timeout(opts.timeoutMs ?? this.o.timeoutMs);
    let status: number;
    let text: string;
    try {
      const res = await request(new URL(path, this.base), {
        method,
        headers: { accept: 'application/json', ...(opts.json !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.o.token ? { authorization: `Bearer ${this.o.token}` } : {}), ...(opts.headers ?? {}) },
        body: opts.json !== undefined ? JSON.stringify(opts.json) : (opts.body ?? null),
        signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout,
        dispatcher: this.dispatcher
      });
      status = res.statusCode;
      text = await res.body.text();
    } catch (err) {
      throw new ClassifierWorkerError(`The classifier worker could not be reached: ${(err as Error).message}`, 'unreachable');
    }
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = null;
    }
    if (status < 200 || status >= 300) {
      const j = (parsed ?? {}) as { error?: unknown; detail?: unknown; code?: unknown; missing?: unknown };
      const detail = String(typeof j.detail === 'string' ? j.detail : typeof j.error === 'string' ? j.error : text.slice(0, 500));
      if (status === 404 && j.code === 'missing') throw new ClassifierWorkerError(`The classifier worker does not hold the model: ${detail}`, 'missing', Array.isArray(j.missing) ? j.missing.filter((x): x is string => typeof x === 'string').slice(0, 1000) : []);
      throw new ClassifierWorkerError(`The classifier worker answered ${status}: ${detail.slice(0, 500)}`, status === 409 || status === 422 ? 'refused' : 'error');
    }
    const r = schema.safeParse(parsed);
    if (!r.success) throw new ClassifierWorkerError(`The classifier worker sent an answer that does not match the contract (${r.error.issues[0]?.path.join('.') ?? ''}).`, 'error');
    return r.data;
  }

  info() {
    return this.call('GET', 'v1/info', infoSchema);
  }

  async putFile(digest: string, file: WorkerFile, body: Readable | Buffer): Promise<void> {
    if (!WORKER_FILE_NAME.test(file.name)) throw new ClassifierWorkerError(`${file.name.slice(0, 80)} is not a file name the worker stores.`, 'refused');
    // A weight file takes as long as it takes: an hour at most, not the call timeout.
    await this.call('PUT', `v1/models/${hex(digest)}/files/${encodeURIComponent(file.name)}`, z.unknown(), { body, headers: { 'content-type': 'application/octet-stream', 'content-length': String(file.bytes), 'x-sha256': file.sha256 }, timeoutMs: 3_600_000 });
  }

  load(digest: string, files: Pick<WorkerFile, 'name' | 'sha256'>[]) {
    // Loading reads the weights from disk: several times the call timeout.
    return this.call('POST', `v1/models/${hex(digest)}/load`, loadedSchema, { json: { files: files.map((f) => ({ name: f.name, sha256: f.sha256 })) }, timeoutMs: Math.max(this.o.timeoutMs, 300_000) });
  }

  async classify(digest: string, texts: string[], signal?: AbortSignal): Promise<Record<string, number>[]> {
    const out = await this.call('POST', 'v1/classify', classifySchema, { json: { model: `sha256:${hex(digest)}`, texts }, ...(signal ? { signal } : {}) });
    if (out.results.length !== texts.length) throw new ClassifierWorkerError(`The classifier worker answered ${out.results.length} results for ${texts.length} texts.`, 'error');
    return out.results.map((r) => r.scores);
  }
}

export function createClassifierWorker(cfg: Config): ClassifierWorker {
  if (!cfg.CLASSIFIER_WORKER_URL) return new UnavailableClassifierWorker();
  return new HttpClassifierWorker({
    url: cfg.CLASSIFIER_WORKER_URL,
    ...(cfg.CLASSIFIER_WORKER_TOKEN ? { token: cfg.CLASSIFIER_WORKER_TOKEN } : {}),
    timeoutMs: cfg.CLASSIFIER_WORKER_TIMEOUT_MS,
    labelCeiling: cfg.CLASSIFIER_WORKER_LABEL_CEILING,
    policy: servicePolicy(cfg),
    ...(cfg.CLASSIFIER_WORKER_CA_FILE ? { caFile: cfg.CLASSIFIER_WORKER_CA_FILE } : {})
  });
}
