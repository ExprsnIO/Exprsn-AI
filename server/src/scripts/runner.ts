import { spawn } from 'node:child_process';

export const LANGUAGES = ['python', 'javascript'] as const;
export type Language = (typeof LANGUAGES)[number];

export interface ScriptLimits {
  timeoutSeconds: number;
  memoryMb: number;
  cpus: number;
  pids: number;
  outputKb: number;
}

/** Defaults, and the most a script may ask for. */
export const DEFAULT_LIMITS: ScriptLimits = { timeoutSeconds: 60, memoryMb: 512, cpus: 1, pids: 64, outputKb: 64 };
export const MAX_LIMITS: ScriptLimits = { timeoutSeconds: 600, memoryMb: 4096, cpus: 4, pids: 256, outputKb: 1024 };

export interface RunRequest {
  id: string;
  language: Language;
  source: string;
  stdin?: string;
  limits: ScriptLimits;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

/**
 * Where scripts execute. The container adapter runs each script in a fresh, disposable container; tests use an
 * in-process fake. Adapters must give no network, a read-only root, a non-root user and the requested limits.
 */
export interface ScriptRunner {
  readonly name: string;
  available(): Promise<boolean>;
  run(req: RunRequest, signal?: AbortSignal): Promise<RunResult>;
}

export class RunnerUnavailable extends Error {}

/** Collects a stream up to a byte cap, then drains the rest. */
function capture(stream: NodeJS.ReadableStream, cap: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  stream.on('data', (c: Buffer) => {
    if (size >= cap) {
      truncated = true;
      return;
    }
    const take = c.subarray(0, cap - size);
    if (take.length < c.length) truncated = true;
    chunks.push(take);
    size += take.length;
  });
  return () => ({ text: Buffer.concat(chunks).toString('utf8'), truncated });
}

/**
 * The container adapter: `docker run` or `podman run` (the CLI, so rootless Podman works too) with no network, a
 * read-only root filesystem, a small noexec tmpfs as the only writable place, all capabilities dropped,
 * no-new-privileges, the nobody user, and memory, CPU, process and wall-time limits. The source is passed as an
 * argument to the interpreter, stdin as the script's input; nothing is mounted from the host.
 */
export class ContainerRunner implements ScriptRunner {
  constructor(
    private readonly bin: 'docker' | 'podman',
    private readonly images: Record<Language, string>
  ) {}

  get name(): string {
    return this.bin;
  }

  available(): Promise<boolean> {
    return new Promise((resolve) => {
      const p = spawn(this.bin, ['version'], { stdio: 'ignore' });
      const t = setTimeout(() => p.kill('SIGKILL'), 5000);
      p.on('error', () => resolve(false));
      p.on('close', (code) => {
        clearTimeout(t);
        resolve(code === 0);
      });
    });
  }

  args(req: RunRequest): string[] {
    const l = req.limits;
    const cmd = req.language === 'python' ? ['python3', '-I', '-c', req.source] : ['node', '--input-type=module', '-e', req.source];
    return [
      'run', '--rm', '-i',
      '--name', `exai-script-${req.id.toLowerCase()}`,
      '--network', 'none',
      '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m',
      '--memory', `${l.memoryMb}m`, '--memory-swap', `${l.memoryMb}m`,
      '--cpus', String(l.cpus),
      '--pids-limit', String(l.pids),
      '--user', '65534:65534',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--workdir', '/tmp',
      '--env', 'HOME=/tmp', '--env', 'PYTHONDONTWRITEBYTECODE=1', '--env', 'NODE_OPTIONS=--max-old-space-size=' + Math.max(32, Math.floor(l.memoryMb * 0.75)),
      '--stop-timeout', '1',
      this.images[req.language],
      ...cmd
    ];
  }

  run(req: RunRequest, signal?: AbortSignal): Promise<RunResult> {
    const started = Date.now();
    const cap = req.limits.outputKb * 1024;
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, this.args(req), { stdio: ['pipe', 'pipe', 'pipe'] });
      const out = capture(child.stdout, cap);
      const err = capture(child.stderr, cap);
      let timedOut = false;
      const kill = () => {
        spawn(this.bin, ['kill', `exai-script-${req.id.toLowerCase()}`], { stdio: 'ignore' }).on('error', () => undefined);
        child.kill('SIGKILL');
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, req.limits.timeoutSeconds * 1000 + 2000); // container start-up gets a little grace
      const onAbort = () => kill();
      signal?.addEventListener('abort', onAbort, { once: true });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new RunnerUnavailable(`${this.bin} could not start: ${e.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const o = out();
        const e = err();
        if (signal?.aborted) return reject(signal.reason as Error);
        resolve({ stdout: o.text, stderr: e.text, exitCode: timedOut ? null : code, timedOut, truncated: o.truncated || e.truncated, durationMs: Date.now() - started });
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(req.stdin ?? '');
    });
  }
}

/** No sandbox configured: every run is refused with a plain reason. */
export class UnavailableRunner implements ScriptRunner {
  readonly name = 'none';
  async available(): Promise<boolean> {
    return false;
  }
  async run(): Promise<RunResult> {
    throw new RunnerUnavailable('No script sandbox is configured on this server (SCRIPT_RUNNER=none, or neither docker nor podman is installed).');
  }
}

/** Picks docker or podman, whichever answers first, at first use. */
export class AutoRunner implements ScriptRunner {
  private picked: Promise<ScriptRunner> | null = null;
  constructor(private readonly images: Record<Language, string>) {}

  get name(): string {
    return 'auto';
  }

  private pick(): Promise<ScriptRunner> {
    this.picked ??= (async () => {
      for (const bin of ['docker', 'podman'] as const) {
        const r = new ContainerRunner(bin, this.images);
        if (await r.available()) return r;
      }
      return new UnavailableRunner();
    })();
    return this.picked;
  }

  async available(): Promise<boolean> {
    return (await this.pick()).available();
  }

  async run(req: RunRequest, signal?: AbortSignal): Promise<RunResult> {
    return (await this.pick()).run(req, signal);
  }
}

export function createScriptRunner(cfg: { SCRIPT_RUNNER: 'auto' | 'docker' | 'podman' | 'none'; SCRIPT_IMAGE_PYTHON: string; SCRIPT_IMAGE_NODE: string }): ScriptRunner {
  const images = { python: cfg.SCRIPT_IMAGE_PYTHON, javascript: cfg.SCRIPT_IMAGE_NODE };
  if (cfg.SCRIPT_RUNNER === 'none') return new UnavailableRunner();
  if (cfg.SCRIPT_RUNNER === 'auto') return new AutoRunner(images);
  return new ContainerRunner(cfg.SCRIPT_RUNNER, images);
}
