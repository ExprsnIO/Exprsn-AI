import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { fetch, type Dispatcher } from 'undici';
import type { Config } from '../config/index.js';
import { literalProblem, serviceAgent, servicePolicy, type ServicePolicy } from '../platform/egress.js';

/*
 * The GPU training worker. The TypeScript side orchestrates and governs (datasets, approval, windows, quotas, the
 * queue, evals thresholds, registration); a Python worker (Unsloth, Axolotl or HF TRL/PEFT on CUDA, ROCm or MLX)
 * does the GPU work behind this contract, over HTTP:
 *
 *   GET  /v1/info                 container digest, trainers, accelerators, GPUs total and free
 *   POST /v1/runs                 { spec, data }: starts a run (resuming from spec.resumeFrom when set) → { id }
 *   GET  /v1/runs/:id             state, step, loss points, last checkpoint, GPU time of this run
 *   POST /v1/runs/:id/checkpoint  { reason }: writes a checkpoint at the current step, stops, releases the GPUs
 *   POST /v1/runs/:id/cancel      stops after the current step, keeping the last checkpoint
 *   POST /v1/evals                one suite on one hardware class → score, base score, cases
 *   POST /v1/convert              a checkpoint to GGUF (llama.cpp convert + quantize), pushed where Ollama pulls from
 *
 * Contract versions (the worker reports `contract` in /v1/info; absent means 1):
 *
 *   1  POST /v1/runs carries { spec, data }: the scrubbed rows in plaintext. Refused unless
 *      TRAINER_PLAINTEXT_FALLBACK is set.
 *   2  (Sprint 18, B-905) POST /v1/runs carries { spec, contract: 2, sealed }: the rows encrypted with a fresh
 *      AES-256-GCM run key. The worker fetches that key once (POST sealed.key.url with the bearer sealed.key.token,
 *      over mTLS) and uploads checkpoints and GGUF files to sealed.artifacts.url (PUT <url>/<name>?kind=...), where
 *      they are sealed under the tenant key in the platform's blob store; a checkpoint's `ref` is then
 *      `exprsn-artifact:<name>`, read back with GET <url>/<name> to resume or convert. docs/training-worker.md has the
 *      whole contract.
 *
 * The worker never sees the tenant keys.
 */

export type RunState = 'queued' | 'running' | 'checkpointed' | 'preempted' | 'succeeded' | 'failed' | 'cancelled';

export interface Checkpoint {
  step: number;
  /** Where the worker keeps it (an object-store URI); opaque to the orchestrator. */
  ref: string;
  at: number;
}

export interface TrainSpec {
  /** The training job's id; the worker tags its artefacts with it. */
  job: string;
  name: string;
  baseModel: string;
  baseDigest: string | null;
  method: { kind: 'lora' | 'qlora' | 'full'; rank: number | null; alpha: number | null; learningRate: number; epochs: number; seed: number; seqLen: number; microBatch: number };
  trainer: 'unsloth' | 'axolotl' | 'trl';
  hardware: { accelerator: 'cuda' | 'rocm' | 'metal'; gpus: number; memoryGb: number };
  steps: number;
  checkpointEvery: number;
  dataset: { id: string; name: string; version: number; hash: string; rows: number; splits: { train: number; val: number; test: number } };
  resumeFrom: Checkpoint | null;
}

export interface RunStatus {
  state: RunState;
  step: number;
  steps: number;
  epoch: number;
  loss: number | null;
  /** Loss points the worker still holds (the orchestrator keeps the series and ignores steps it already has). */
  points: { step: number; loss: number }[];
  checkpoint: Checkpoint | null;
  /** GPU time of this run so far (GPU count times wall time). */
  gpuMs: number;
  error: string | null;
  container: string | null;
}

export interface TrainerInfo {
  /** The contract version the worker speaks (1 when it does not say). */
  contract?: number;
  container: string | null;
  trainers: string[];
  accelerators: string[];
  gpus: { total: number; free: number };
}

export interface EvalRequest {
  model: string;
  base: string | null;
  /** The checkpoint to evaluate before conversion, when the model is not in the catalogue yet. */
  checkpoint: Checkpoint | null;
  suite: string;
  hardware: string;
}

export interface EvalResult {
  score: number;
  base: number | null;
  passed: number | null;
  total: number | null;
}

export interface ConvertRequest {
  job: string;
  name: string;
  checkpoint: Checkpoint;
  baseModel: string;
  /** Q4_K_M, Q5_K_M, Q8_0, or `adapter` (a LoRA adapter on the pinned base); `as-is` packages a published GGUF unchanged. */
  quantization: string;
  /**
   * 1.5.0 (B-3803): an import rather than a training run. The files are staged as artefacts the worker reads with
   * `artifacts` (GET <url>/<name>, the same bearer), checks against `sha256`, converts (or packages, for `as-is`) and
   * pushes where Ollama pulls from, like a run's checkpoint.
   */
  source?: { kind: 'import'; repository: string; item: string; revision: string; files: { name: string; artifact: string; sha256: string; bytes: number; format: string }[]; artifacts: { url: string; token: string; expiresAt: number } };
}

export interface ConvertResult {
  /** The reference Ollama pulls (the worker pushes the GGUF to the registry the pools pull from). */
  name: string;
  /** Where the GGUF file is kept. */
  artifact: string;
  digest: string;
  sizeBytes: number;
  quantization: string;
  tool: string;
}

/** Contract 2 (B-905): the dataset as the submit request carries it, encrypted with a run key the worker fetches once. */
export interface SealedDataset {
  contract: 2;
  cipher: 'aes-256-gcm';
  /** Base64 of the 12-byte IV, the 16-byte GCM tag and the encrypted JSON Lines. */
  iv: string;
  tag: string;
  ciphertext: string;
  /** Associated data bound into the GCM tag. */
  aad: string;
  /** SHA-256 of the plaintext JSON Lines, to check after decrypting. */
  sha256: string;
  rows: number;
  /** POST once with `Authorization: Bearer <token>` → { key (base64), cipher, aad }. */
  key: { url: string; token: string; expiresAt: number };
  /** PUT <url>/<name>?kind=checkpoint|gguf to store an artefact, GET <url>/<name> to read it back, same bearer. */
  artifacts: { url: string; token: string; expiresAt: number };
}

export const ARTIFACT_REF = 'exprsn-artifact:';

/** The GPU training worker the orchestrator drives (a Python trainer over HTTP; a fake in tests). */
export interface TrainerBackend {
  readonly kind: string;
  /** False when no worker is configured; `reason` then says what to set. */
  readonly available: boolean;
  readonly reason: string | null;
  info(): Promise<TrainerInfo>;
  /** Contract 1 takes the rows (a Buffer); contract 2 the sealed dataset. */
  submit(spec: TrainSpec, data: Buffer | SealedDataset): Promise<{ id: string }>;
  status(id: string): Promise<RunStatus>;
  checkpoint(id: string, reason: 'pause' | 'preempt' | 'window' | 'quota' | 'duration'): Promise<Checkpoint>;
  cancel(id: string): Promise<void>;
  evaluate(req: EvalRequest): Promise<EvalResult>;
  convert(req: ConvertRequest): Promise<ConvertResult>;
}

export class TrainerError extends Error {}

export const NO_TRAINER = 'No GPU training worker is configured. A system admin sets TRAINER_URL to the Python trainer\'s address.';

/** Used when TRAINER_URL is unset: every call fails with the same clear reason. */
export class UnavailableTrainer implements TrainerBackend {
  readonly kind = 'none';
  readonly available = false;
  readonly reason = NO_TRAINER;
  private fail(): never {
    throw new TrainerError(NO_TRAINER);
  }
  async info(): Promise<TrainerInfo> {
    return this.fail();
  }
  async submit(): Promise<{ id: string }> {
    return this.fail();
  }
  async status(): Promise<RunStatus> {
    return this.fail();
  }
  async checkpoint(): Promise<Checkpoint> {
    return this.fail();
  }
  async cancel(): Promise<void> {
    return this.fail();
  }
  async evaluate(): Promise<EvalResult> {
    return this.fail();
  }
  async convert(): Promise<ConvertResult> {
    return this.fail();
  }
}

const checkpointSchema = z.object({ step: z.number().int().min(0), ref: z.string().min(1).max(1000), at: z.number().optional() }).transform((c) => ({ step: c.step, ref: c.ref, at: c.at ?? Date.now() }));
const infoSchema = z.object({ contract: z.number().int().min(1).max(100).default(1), container: z.string().max(300).nullable().default(null), trainers: z.array(z.string()).default([]), accelerators: z.array(z.string()).default([]), gpus: z.object({ total: z.number().int().min(0), free: z.number().int().min(0) }) });
const statusSchema = z.object({
  state: z.enum(['queued', 'running', 'checkpointed', 'preempted', 'succeeded', 'failed', 'cancelled']),
  step: z.number().int().min(0),
  steps: z.number().int().min(0),
  epoch: z.number().min(0).default(0),
  loss: z.number().nullable().default(null),
  points: z.array(z.object({ step: z.number().int().min(0), loss: z.number() })).max(10_000).default([]),
  checkpoint: checkpointSchema.nullable().default(null),
  gpuMs: z.number().min(0).default(0),
  error: z.string().max(2000).nullable().default(null),
  container: z.string().max(300).nullable().default(null)
});
const evalSchema = z.object({ score: z.number(), base: z.number().nullable().default(null), passed: z.number().int().nullable().default(null), total: z.number().int().nullable().default(null) });
const convertSchema = z.object({ name: z.string().min(1).max(200), artifact: z.string().min(1).max(1000), digest: z.string().min(1).max(100), sizeBytes: z.number().int().min(0), quantization: z.string().max(40), tool: z.string().max(200).default('llama.cpp') });

/** The HTTP adapter for the Python worker. */
export class HttpTrainer implements TrainerBackend {
  readonly kind = 'http';
  readonly available = true;
  readonly reason = null;

  private readonly dispatcher: Dispatcher;
  private readonly refused: string | null;

  constructor(private readonly o: { url: string; token?: string; timeoutMs: number; policy?: ServicePolicy; tls?: { caFile?: string; certFile?: string; keyFile?: string } }) {
    const policy = o.policy ?? servicePolicy();
    // B-905: mutual TLS to the worker when TRAINER_CA_FILE / TRAINER_CERT_FILE / TRAINER_KEY_FILE are set.
    const t = o.tls ?? {};
    this.dispatcher = serviceAgent(policy, { ...(t.caFile ? { ca: readFileSync(t.caFile) } : {}), ...(t.certFile ? { cert: readFileSync(t.certFile) } : {}), ...(t.keyFile ? { key: readFileSync(t.keyFile) } : {}) });
    this.refused = literalProblem(o.url, policy);
  }

  private async call<T extends z.ZodType>(method: 'GET' | 'POST', path: string, schema: T, body?: unknown): Promise<z.infer<T>> {
    if (this.refused) throw new TrainerError(`The training worker's address is refused: ${this.refused}`);
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(new URL(path, this.o.url.endsWith('/') ? this.o.url : `${this.o.url}/`), {
        method,
        headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.o.token ? { authorization: `Bearer ${this.o.token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.o.timeoutMs),
        dispatcher: this.dispatcher
      });
    } catch (err) {
      throw new TrainerError(`The training worker could not be reached: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 500);
      try {
        const j = JSON.parse(text) as { error?: string; detail?: string };
        detail = j.detail ?? j.error ?? detail;
      } catch {
        /* not JSON */
      }
      throw new TrainerError(`The training worker answered ${res.status}: ${detail}`);
    }
    const r = schema.safeParse(text ? JSON.parse(text) : {});
    if (!r.success) throw new TrainerError(`The training worker sent an answer that does not match the contract (${r.error.issues[0]?.path.join('.') ?? ''}).`);
    return r.data;
  }

  info() {
    return this.call('GET', 'v1/info', infoSchema);
  }

  submit(spec: TrainSpec, data: Buffer | SealedDataset) {
    const body = Buffer.isBuffer(data) ? { spec, data: data.toString('utf8') } : { spec, contract: 2, sealed: data };
    return this.call('POST', 'v1/runs', z.object({ id: z.string().min(1).max(200) }), body);
  }

  status(id: string) {
    return this.call('GET', `v1/runs/${encodeURIComponent(id)}`, statusSchema);
  }

  checkpoint(id: string, reason: string) {
    return this.call('POST', `v1/runs/${encodeURIComponent(id)}/checkpoint`, checkpointSchema, { reason });
  }

  async cancel(id: string): Promise<void> {
    await this.call('POST', `v1/runs/${encodeURIComponent(id)}/cancel`, z.unknown(), {});
  }

  evaluate(req: EvalRequest) {
    return this.call('POST', 'v1/evals', evalSchema, req);
  }

  convert(req: ConvertRequest) {
    return this.call('POST', 'v1/convert', convertSchema, req);
  }
}

export function createTrainer(cfg: Config): TrainerBackend {
  if (!cfg.TRAINER_URL) return new UnavailableTrainer();
  return new HttpTrainer({ url: cfg.TRAINER_URL, ...(cfg.TRAINER_TOKEN ? { token: cfg.TRAINER_TOKEN } : {}), timeoutMs: cfg.TRAINER_TIMEOUT_MS, policy: servicePolicy(cfg), tls: { ...(cfg.TRAINER_CA_FILE ? { caFile: cfg.TRAINER_CA_FILE } : {}), ...(cfg.TRAINER_CERT_FILE ? { certFile: cfg.TRAINER_CERT_FILE } : {}), ...(cfg.TRAINER_KEY_FILE ? { keyFile: cfg.TRAINER_KEY_FILE } : {}) } });
}
