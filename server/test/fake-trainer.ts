import { createDecipheriv, createHash } from 'node:crypto';
import request from 'supertest';
import type { Checkpoint, ConvertRequest, ConvertResult, EvalRequest, EvalResult, RunStatus, SealedDataset, TrainerBackend, TrainerInfo, TrainSpec } from '../src/training/trainer.js';

/** How the fake reaches the platform's worker endpoints (a SuperTest agent on the app, set with `useApp`). */
type Call = (method: 'post' | 'put' | 'get', url: string, token: string, body?: Buffer) => Promise<{ status: number; body: Buffer; json: () => unknown }>;

interface FakeRun {
  id: string;
  spec: TrainSpec;
  data: string;
  /** Contract 2: where checkpoints and GGUF files go. */
  artifacts: SealedDataset['artifacts'] | null;
  state: RunStatus['state'];
  step: number;
  gpuMs: number;
  points: { step: number; loss: number }[];
  checkpoint: Checkpoint | null;
}

/**
 * Stands in for the Python GPU worker. Each status call advances a running run by `stepsPerPoll` steps and
 * `msPerPoll` of wall time per GPU; `preemptAt` makes the worker checkpoint and preempt a run when it reaches that
 * step; `failAt` fails it. Runs resume from `spec.resumeFrom`, so a test can see that training did not restart.
 *
 * Sprint 18 (B-905): the fake speaks worker contract 2 by default (`contract = 1` for the old behaviour). A sealed
 * submit is recorded as it would travel (`requests`), the run key is fetched once from the platform, the rows are
 * decrypted into `submits[].data`, and checkpoints and GGUF files are uploaded to the platform's artefact store and
 * read back on resume (`resumedFrom`). Call `useApp(app)` so the fake can reach the platform's worker endpoints.
 */
export class FakeTrainer implements TrainerBackend {
  readonly kind = 'fake';
  readonly available = true;
  readonly reason = null;
  gpus = 4;
  stepsPerPoll = 500;
  msPerPoll = 60_000;
  preemptAt: number | null = null;
  failAt: number | null = null;
  /** Eval scores by suite; `tools` is reported as cases. */
  scores: Record<string, number> = { heldout: 0.78, regression: 0.97, redteam: 0.99 };
  runs = new Map<string, FakeRun>();
  submits: { spec: TrainSpec; data: string }[] = [];
  /** The contract the fake reports in info (2: sealed rows and platform-held artefacts). */
  contract: 1 | 2 = 2;
  /** Each submit body as the HTTP adapter would send it (JSON). */
  requests: string[] = [];
  /** Checkpoint bytes read back from the platform on resume, by run id. */
  resumedFrom = new Map<string, string>();
  private call: Call | null = null;

  /** Lets the fake call the platform's worker endpoints on this app (through SuperTest, no port needed). */
  useApp(app: Parameters<typeof request>[0]): this {
    this.call = async (method, url, token, body) => {
      const u = new URL(url);
      let r = request(app)[method](u.pathname + u.search).set('authorization', `Bearer ${token}`);
      if (body) r = r.set('content-type', 'application/octet-stream').send(body);
      const res = await r.buffer(true).parse((resp, cb) => {
        const chunks: Buffer[] = [];
        resp.on('data', (c: Buffer) => chunks.push(c));
        resp.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      const raw = res.body as Buffer;
      return { status: res.status, body: raw, json: () => JSON.parse(raw.toString('utf8')) };
    };
    return this;
  }

  private platform(): Call {
    if (!this.call) throw new Error('FakeTrainer: call useApp(app) so contract 2 can reach the platform');
    return this.call;
  }

  /** Contract 2: fetches the run key once and decrypts the rows, as the Python worker does. */
  async openSealed(sealed: SealedDataset): Promise<string> {
    const r = await this.platform()('post', sealed.key.url, sealed.key.token);
    if (r.status !== 200) throw new Error(`key fetch answered ${r.status}: ${r.body.toString('utf8')}`);
    const key = Buffer.from((r.json() as { key: string }).key, 'base64');
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
    d.setAAD(Buffer.from(sealed.aad));
    d.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    const plain = Buffer.concat([d.update(Buffer.from(sealed.ciphertext, 'base64')), d.final()]);
    if (createHash('sha256').update(plain).digest('hex') !== sealed.sha256) throw new Error('sealed rows digest mismatch');
    return plain.toString('utf8');
  }

  /** Contract 2: stores a checkpoint (synthetic weights) in the platform and returns its reference. */
  private async upload(r: FakeRun, name: string, kind: string, body: Buffer): Promise<string> {
    const res = await this.platform()('put', `${r.artifacts!.url}/${name}?kind=${kind}`, r.artifacts!.token, body);
    if (res.status !== 201) throw new Error(`artifact upload answered ${res.status}: ${res.body.toString('utf8')}`);
    return (res.json() as { ref: string }).ref;
  }

  private async makeCheckpoint(r: FakeRun): Promise<Checkpoint> {
    if (!r.artifacts) return { step: r.step, ref: `s3://checkpoints/${r.spec.job}/step-${r.step}`, at: Date.now() };
    const ref = await this.upload(r, `step-${r.step}.safetensors`, 'checkpoint', Buffer.from(`WEIGHTS job=${r.spec.job} step=${r.step}`));
    return { step: r.step, ref, at: Date.now() };
  }
  evalCalls: EvalRequest[] = [];
  converts: ConvertRequest[] = [];
  private seq = 0;

  private busy(): number {
    return [...this.runs.values()].filter((r) => r.state === 'running').reduce((n, r) => n + r.spec.hardware.gpus, 0);
  }

  async info(): Promise<TrainerInfo> {
    return { contract: this.contract, container: 'trainer:2026.09.1@sha256:5be0aa', trainers: ['unsloth', 'axolotl', 'trl'], accelerators: ['cuda'], gpus: { total: this.gpus, free: Math.max(0, this.gpus - this.busy()) } };
  }

  async submit(spec: TrainSpec, data: Buffer | SealedDataset): Promise<{ id: string }> {
    const id = `run-${++this.seq}`;
    let text: string;
    let artifacts: SealedDataset['artifacts'] | null = null;
    if (Buffer.isBuffer(data)) {
      this.requests.push(JSON.stringify({ spec, data: data.toString('utf8') }));
      text = data.toString('utf8');
    } else {
      this.requests.push(JSON.stringify({ spec, contract: 2, sealed: data }));
      text = await this.openSealed(data);
      artifacts = data.artifacts;
      if (spec.resumeFrom?.ref.startsWith('exprsn-artifact:')) {
        const name = spec.resumeFrom.ref.slice('exprsn-artifact:'.length);
        const got = await this.platform()('get', `${artifacts.url}/${name}`, artifacts.token);
        if (got.status !== 200) throw new Error(`checkpoint read answered ${got.status}`);
        this.resumedFrom.set(id, got.body.toString('utf8'));
      }
    }
    this.submits.push({ spec, data: text });
    const step = spec.resumeFrom?.step ?? 0;
    this.runs.set(id, { id, spec, data: text, artifacts, state: 'running', step, gpuMs: 0, points: [], checkpoint: spec.resumeFrom });
    return { id };
  }

  private loss(step: number, steps: number): number {
    return Math.round((2.3 * Math.exp((-3 * step) / Math.max(1, steps)) + 0.3) * 1000) / 1000;
  }

  async status(id: string): Promise<RunStatus> {
    const r = this.runs.get(id);
    if (!r) throw new Error(`no run ${id}`);
    const steps = r.spec.steps;
    if (r.state === 'running') {
      let next = Math.min(steps, r.step + this.stepsPerPoll);
      r.gpuMs += this.msPerPoll * r.spec.hardware.gpus;
      if (this.failAt != null && next >= this.failAt) {
        r.step = this.failAt;
        r.state = 'failed';
      } else {
        if (this.preemptAt != null && r.step < this.preemptAt && next >= this.preemptAt) next = this.preemptAt;
        for (let s = r.step + 100 - (r.step % 100); s <= next; s += 100) r.points.push({ step: s, loss: this.loss(s, steps) });
        r.step = next;
        if (r.step % r.spec.checkpointEvery === 0 || r.step === steps) r.checkpoint = await this.makeCheckpoint(r);
        if (this.preemptAt != null && r.step === this.preemptAt) {
          r.checkpoint = await this.makeCheckpoint(r);
          r.state = 'preempted';
          this.preemptAt = null;
        } else if (r.step >= steps) r.state = 'succeeded';
      }
    }
    return { state: r.state, step: r.step, steps, epoch: Math.round((r.step / steps) * r.spec.method.epochs * 100) / 100, loss: r.points.length ? r.points[r.points.length - 1]!.loss : null, points: r.points.slice(-50), checkpoint: r.checkpoint, gpuMs: r.gpuMs, error: r.state === 'failed' ? `CUDA out of memory at step ${r.step}.` : null, container: 'trainer:2026.09.1@sha256:5be0aa' };
  }

  async checkpoint(id: string): Promise<Checkpoint> {
    const r = this.runs.get(id)!;
    r.checkpoint = await this.makeCheckpoint(r);
    r.state = 'checkpointed';
    return r.checkpoint;
  }

  async cancel(id: string): Promise<void> {
    const r = this.runs.get(id);
    if (r) r.state = 'cancelled';
  }

  async evaluate(req: EvalRequest): Promise<EvalResult> {
    this.evalCalls.push(req);
    if (req.suite === 'tools') return { score: 0, base: null, passed: Math.round((this.scores.tools ?? 1) * 44), total: 44 };
    return { score: this.scores[req.suite] ?? 0.99, base: 0.6, passed: null, total: null };
  }

  async convert(req: ConvertRequest): Promise<ConvertResult> {
    this.converts.push(req);
    const run = [...this.runs.values()].reverse().find((r) => r.spec.job === req.job && r.artifacts);
    const artifact = run ? await this.upload(run, `model-${req.quantization}.gguf`, 'gguf', Buffer.from(`GGUF ${req.name}`)) : `s3://models/${req.job}/model-${req.quantization}.gguf`;
    return { name: req.name, artifact, digest: `sha256:${'ab'.repeat(32)}`, sizeBytes: 4_900_000_000, quantization: req.quantization, tool: 'llama.cpp convert_hf_to_gguf + llama-quantize' };
  }
}
