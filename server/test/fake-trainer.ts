import type { Checkpoint, ConvertRequest, ConvertResult, EvalRequest, EvalResult, RunStatus, TrainerBackend, TrainerInfo, TrainSpec } from '../src/training/trainer.js';

interface FakeRun {
  id: string;
  spec: TrainSpec;
  data: string;
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
  evalCalls: EvalRequest[] = [];
  converts: ConvertRequest[] = [];
  private seq = 0;

  private busy(): number {
    return [...this.runs.values()].filter((r) => r.state === 'running').reduce((n, r) => n + r.spec.hardware.gpus, 0);
  }

  async info(): Promise<TrainerInfo> {
    return { container: 'trainer:2026.09.1@sha256:5be0aa', trainers: ['unsloth', 'axolotl', 'trl'], accelerators: ['cuda'], gpus: { total: this.gpus, free: Math.max(0, this.gpus - this.busy()) } };
  }

  async submit(spec: TrainSpec, data: Buffer): Promise<{ id: string }> {
    const id = `run-${++this.seq}`;
    this.submits.push({ spec, data: data.toString('utf8') });
    const step = spec.resumeFrom?.step ?? 0;
    this.runs.set(id, { id, spec, data: data.toString('utf8'), state: 'running', step, gpuMs: 0, points: [], checkpoint: spec.resumeFrom });
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
        if (r.step % r.spec.checkpointEvery === 0 || r.step === steps) r.checkpoint = { step: r.step, ref: `s3://checkpoints/${r.spec.job}/step-${r.step}`, at: Date.now() };
        if (this.preemptAt != null && r.step === this.preemptAt) {
          r.checkpoint = { step: r.step, ref: `s3://checkpoints/${r.spec.job}/step-${r.step}`, at: Date.now() };
          r.state = 'preempted';
          this.preemptAt = null;
        } else if (r.step >= steps) r.state = 'succeeded';
      }
    }
    return { state: r.state, step: r.step, steps, epoch: Math.round((r.step / steps) * r.spec.method.epochs * 100) / 100, loss: r.points.length ? r.points[r.points.length - 1]!.loss : null, points: r.points.slice(-50), checkpoint: r.checkpoint, gpuMs: r.gpuMs, error: r.state === 'failed' ? `CUDA out of memory at step ${r.step}.` : null, container: 'trainer:2026.09.1@sha256:5be0aa' };
  }

  async checkpoint(id: string): Promise<Checkpoint> {
    const r = this.runs.get(id)!;
    r.checkpoint = { step: r.step, ref: `s3://checkpoints/${r.spec.job}/step-${r.step}`, at: Date.now() };
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
    return { name: req.name, artifact: `s3://models/${req.job}/model-${req.quantization}.gguf`, digest: `sha256:${'ab'.repeat(32)}`, sizeBytes: 4_900_000_000, quantization: req.quantization, tool: 'llama.cpp convert_hf_to_gguf + llama-quantize' };
  }
}
