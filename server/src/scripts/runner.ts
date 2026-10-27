import { spawn } from 'node:child_process';

export const LANGUAGES = ['python', 'javascript', 'typescript', 'bash', 'sh', 'perl', 'ruby', 'tcl', 'lua', 'php', 'awk', 'jq', 'sql', 'powershell'] as const;
export type Language = (typeof LANGUAGES)[number];

/**
 * The images scripts run in. Python and JavaScript keep their own; TypeScript runs on the Node.js image; the other
 * scripting languages share the tools image (deploy/docker/script-tools: Bash, Perl, Ruby, Tcl, Lua, PHP, gawk, jq,
 * SQLite and the usual command-line tools); PowerShell has its own.
 */
export const IMAGE_KEYS = ['python', 'javascript', 'tools', 'powershell'] as const;
export type ImageKey = (typeof IMAGE_KEYS)[number];
export type ScriptImages = Record<'python' | 'javascript', string> & Partial<Record<'tools' | 'powershell', string>>;
export const DEFAULT_TOOLS_IMAGE = 'exprsn-ai/scripts:1';
export const DEFAULT_POWERSHELL_IMAGE = 'mcr.microsoft.com/powershell:lts-ubuntu-22.04';
export const IMAGE_OF: Record<Language, ImageKey> = {
  python: 'python', javascript: 'javascript', typescript: 'javascript',
  bash: 'tools', sh: 'tools', perl: 'tools', ruby: 'tools', tcl: 'tools', lua: 'tools', php: 'tools', awk: 'tools', jq: 'tools', sql: 'tools',
  powershell: 'powershell'
};
export const imageFor = (images: ScriptImages, language: Language): string => {
  const key = IMAGE_OF[language];
  return key === 'tools' ? (images.tools ?? DEFAULT_TOOLS_IMAGE) : key === 'powershell' ? (images.powershell ?? DEFAULT_POWERSHELL_IMAGE) : images[key];
};

/** Writes the source (the first argument) to /tmp, then has the interpreter read it: /tmp is noexec, so it is never run directly. */
const fromFile = (file: string, cmd: string): string[] => ['sh', '-c', `printf '%s' "$1" > /tmp/${file} && exec ${cmd} /tmp/${file}`, 'script'];

/**
 * SQL runs in an in-memory SQLite database in safe mode (no .shell, .system, extensions or file functions). The
 * script's stdin is the one-row table `input(body)` (a promoted tool's arguments as JSON: json_extract(body, '$.x'));
 * results print as JSON arrays. The SQL goes in on sqlite3's stdin, so a leading `--` comment is not taken for an option.
 */
const SQL_RUN = `body=$(cat; printf x); body=\${body%x}; q=$(printf '%s' "$body" | sed "s/'/''/g"); printf '%s\\n' "CREATE TEMP TABLE input AS SELECT '$q' AS body;" "$1" | exec sqlite3 -safe -bail -json :memory:`;

/** The command line that runs a script's source in its image; stdin is the script's input. */
export function commandFor(language: Language, source: string): string[] {
  switch (language) {
    case 'python': return ['python3', '-I', '-c', source];
    case 'javascript': return ['node', '--input-type=module', '-e', source];
    case 'typescript': return [...fromFile('main.ts', 'node --no-warnings --experimental-strip-types'), source];
    case 'bash': return ['bash', '-c', source, 'script'];
    case 'sh': return ['sh', '-c', source, 'script'];
    case 'perl': return ['perl', '-e', source];
    case 'ruby': return ['ruby', '-e', source];
    case 'tcl': return [...fromFile('main.tcl', 'tclsh'), source];
    case 'lua': return [...fromFile('main.lua', 'lua'), source];
    case 'php': return [...fromFile('main.php', 'php -f'), source];
    case 'awk': return ['gawk', '--sandbox', '--', source];
    case 'jq': return ['jq', source];
    case 'sql': return ['sh', '-c', SQL_RUN, 'script', source];
    case 'powershell': return [...fromFile('main.ps1', 'pwsh -NoLogo -NoProfile -NonInteractive -File'), source];
  }
}

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
  /** The OCI runtime containers run under (runsc for gVisor), when one is configured. */
  readonly ociRuntime?: string | null;
  available(): Promise<boolean>;
  run(req: RunRequest, signal?: AbortSignal): Promise<RunResult>;
  /**
   * 1.4.0 (B-2004): a run that talks back. stdin stays open after `req.stdin`; every stdout line that starts with
   * `BROKER_MARK` is a JSON message handed to `onMessage`, and its answer (when not null) is written to stdin as one
   * JSON line. Other output is captured as stdout. This is how a plugin handler in the sandbox, which has no
   * network, reaches the platform: through the host, one brokered call at a time.
   */
  session?(req: RunRequest, onMessage: MessageHandler, signal?: AbortSignal): Promise<RunResult>;
}

/** Marks a protocol line on a session's stdout (a record separator, then a fixed word). */
export const BROKER_MARK = '\u001eexprsn-broker ';
/** The longest protocol line accepted from a sandbox (a call and its arguments). */
export const MAX_MESSAGE_BYTES = 1024 * 1024;

export type MessageHandler = (message: unknown) => Promise<unknown>;

export class RunnerUnavailable extends Error {}

/**
 * Spawns a process for a run and collects its output: the shared core of the container adapter's `run` and
 * `session`, and of the tests' process runner. With `onMessage`, stdout is read line by line and protocol lines are
 * answered on stdin (in order, one at a time); without it stdin is closed after `req.stdin`.
 */
export function spawnRun(bin: string, args: string[], req: RunRequest, o: { kill: () => void; signal?: AbortSignal | undefined; onMessage?: MessageHandler | undefined; env?: NodeJS.ProcessEnv }): Promise<RunResult> {
  const started = Date.now();
  const cap = req.limits.outputKb * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], ...(o.env ? { env: o.env } : {}) });
    const err = capture(child.stderr, cap);
    let out: () => { text: string; truncated: boolean };
    let failure: string | null = null;
    let timedOut = false;
    let settled: () => Promise<void> = () => Promise.resolve();
    const kill = () => {
      o.kill();
      child.kill('SIGKILL');
    };
    if (o.onMessage) {
      const handler = o.onMessage;
      const kept: string[] = [];
      let size = 0;
      let truncated = false;
      let pending = '';
      let chain: Promise<void> = Promise.resolve();
      const keep = (line: string) => {
        if (size >= cap) {
          truncated = true;
          return;
        }
        const take = line.slice(0, cap - size);
        if (take.length < line.length) truncated = true;
        kept.push(take);
        size += Buffer.byteLength(take);
      };
      const onLine = (line: string) => {
        if (!line.startsWith(BROKER_MARK)) return keep(`${line}\n`);
        let msg: unknown;
        try {
          msg = JSON.parse(line.slice(BROKER_MARK.length));
        } catch {
          return keep('[a malformed broker message was dropped]\n');
        }
        chain = chain.then(async () => {
          const reply = await handler(msg);
          if (reply != null && child.stdin.writable) child.stdin.write(`${JSON.stringify(reply)}\n`);
        }).catch((e: unknown) => {
          failure = `The broker failed: ${(e as Error).message}`;
          kill();
        });
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (c: string) => {
        pending += c;
        let i: number;
        while ((i = pending.indexOf('\n')) >= 0) {
          onLine(pending.slice(0, i));
          pending = pending.slice(i + 1);
        }
        if (pending.length > MAX_MESSAGE_BYTES) {
          failure = `A line of output passed ${MAX_MESSAGE_BYTES} bytes.`;
          pending = '';
          kill();
        }
      });
      out = () => {
        if (pending) keep(pending);
        return { text: kept.join(''), truncated };
      };
      // The last messages (a handler's result) are handled before the run is reported.
      settled = () => chain;
    } else out = capture(child.stdout, cap);
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, req.limits.timeoutSeconds * 1000 + 2000); // container start-up gets a little grace
    const onAbort = () => kill();
    o.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new RunnerUnavailable(`${bin} could not start: ${e.message}`));
    });
    child.on('close', (code) => void settled().then(() => {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      const so = out();
      const se = err();
      if (o.signal?.aborted) return reject(o.signal.reason as Error);
      const stderr = failure ? `${se.text}${se.text && !se.text.endsWith('\n') ? '\n' : ''}${failure}\n` : se.text;
      resolve({ stdout: so.text, stderr, exitCode: timedOut ? null : failure ? 1 : code, timedOut, truncated: so.truncated || se.truncated, durationMs: Date.now() - started });
    }));
    child.stdin.on('error', () => undefined);
    if (o.onMessage) child.stdin.write(`${req.stdin ?? ''}\n`);
    else child.stdin.end(req.stdin ?? '');
  });
}

/** Runs the engine's CLI for a check (version, info); a missing binary answers code null. */
export type Probe = (bin: string, args: string[]) => Promise<{ code: number | null; stdout: string }>;

const spawnProbe: Probe = (bin, args) =>
  new Promise((resolve) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (c: Buffer) => {
      if (out.length < 65_536) out += c.toString('utf8');
    });
    const t = setTimeout(() => p.kill('SIGKILL'), 5000);
    p.on('error', () => {
      clearTimeout(t);
      resolve({ code: null, stdout: '' });
    });
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, stdout: out });
    });
  });

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
 * argument to the interpreter (or written to /tmp by `sh` for those that only read files), stdin as the script's
 * input; nothing is mounted from the host.
 */
export class ContainerRunner implements ScriptRunner {
  private readonly runtime: string | null;
  private readonly probe: Probe;
  /** Why the configured runtime cannot be used, after `available()` looked (for the runtime view). */
  runtimeProblem: string | null = null;

  constructor(
    private readonly bin: 'docker' | 'podman',
    private readonly images: ScriptImages,
    opts: { runtime?: string | null; probe?: Probe } = {}
  ) {
    this.runtime = opts.runtime ?? null;
    this.probe = opts.probe ?? spawnProbe;
  }

  /** `docker`, or `docker (runsc)` when an OCI runtime such as gVisor is configured (B-1008). */
  get name(): string {
    return this.runtime ? `${this.bin} (${this.runtime})` : this.bin;
  }

  /** The OCI runtime passed with --runtime, or null for the engine's default (runc). */
  get ociRuntime(): string | null {
    return this.runtime;
  }

  /**
   * The engine answers, and when a runtime is configured, the engine knows it: `docker info` lists it under
   * Runtimes (podman is asked to use it). A missing runtime makes the runner unavailable: runs are refused rather
   * than silently falling back to runc.
   */
  async available(): Promise<boolean> {
    const v = await this.probe(this.bin, ['version']);
    if (v.code !== 0) return false;
    if (!this.runtime) return true;
    if (this.bin === 'docker') {
      const r = await this.probe(this.bin, ['info', '--format', '{{json .Runtimes}}']);
      let names: string[];
      try {
        names = Object.keys(JSON.parse(r.stdout.trim() || '{}') as Record<string, unknown>);
      } catch {
        names = [];
      }
      this.runtimeProblem = r.code === 0 && names.includes(this.runtime) ? null : `docker does not list the ${this.runtime} runtime (docker info: ${names.join(', ') || 'none'}).`;
    } else {
      const r = await this.probe(this.bin, ['--runtime', this.runtime, 'info', '--format', '{{.Host.OCIRuntime.Name}}']);
      this.runtimeProblem = r.code === 0 ? null : `podman cannot use the ${this.runtime} runtime.`;
    }
    return this.runtimeProblem == null;
  }

  args(req: RunRequest): string[] {
    const l = req.limits;
    const [entry, ...cmd] = commandFor(req.language, req.source);
    return [
      'run', '--rm', '-i',
      ...(this.runtime ? [`--runtime=${this.runtime}`] : []),
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
      ...(req.language === 'powershell' ? ['--env', 'POWERSHELL_TELEMETRY_OPTOUT=1', '--env', 'DOTNET_CLI_TELEMETRY_OPTOUT=1', '--env', 'POWERSHELL_UPDATECHECK=Off'] : []),
      '--stop-timeout', '1',
      // the image's own entrypoint (node's docker-entrypoint.sh, say) is bypassed: the interpreter is the entrypoint
      '--entrypoint', entry!,
      imageFor(this.images, req.language),
      ...cmd
    ];
  }

  private runtimeChecked: Promise<boolean> | null = null;

  /**
   * Runs one script. With a runtime configured, the engine is asked once whether it has it; without it every run
   * is refused (never run under runc instead).
   */
  async run(req: RunRequest, signal?: AbortSignal): Promise<RunResult> {
    if (this.runtime) {
      this.runtimeChecked ??= this.available();
      if (!(await this.runtimeChecked)) {
        this.runtimeChecked = null; // look again next time: the operator may install it
        throw new RunnerUnavailable(this.runtimeProblem ?? `${this.bin} is not available.`);
      }
    }
    return this.exec(req, signal);
  }

  /** B-2004: a run that talks back to the host (see `ScriptRunner.session`), under the same limits and checks. */
  async session(req: RunRequest, onMessage: MessageHandler, signal?: AbortSignal): Promise<RunResult> {
    if (this.runtime) {
      this.runtimeChecked ??= this.available();
      if (!(await this.runtimeChecked)) {
        this.runtimeChecked = null;
        throw new RunnerUnavailable(this.runtimeProblem ?? `${this.bin} is not available.`);
      }
    }
    return this.exec(req, signal, onMessage);
  }

  private exec(req: RunRequest, signal?: AbortSignal, onMessage?: MessageHandler): Promise<RunResult> {
    return spawnRun(this.bin, this.args(req), req, {
      signal,
      onMessage,
      kill: () => void spawn(this.bin, ['kill', `exai-script-${req.id.toLowerCase()}`], { stdio: 'ignore' }).on('error', () => undefined)
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
  constructor(
    private readonly images: ScriptImages,
    private readonly runtime: string | null = null
  ) {}

  get name(): string {
    return this.runtime ? `auto (${this.runtime})` : 'auto';
  }

  get ociRuntime(): string | null {
    return this.runtime;
  }

  private pick(): Promise<ScriptRunner> {
    this.picked ??= (async () => {
      for (const bin of ['docker', 'podman'] as const) {
        const r = new ContainerRunner(bin, this.images, { runtime: this.runtime });
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

  async session(req: RunRequest, onMessage: MessageHandler, signal?: AbortSignal): Promise<RunResult> {
    const r = await this.pick();
    if (!r.session) throw new RunnerUnavailable('No script sandbox is configured on this server (SCRIPT_RUNNER=none, or neither docker nor podman is installed).');
    return r.session(req, onMessage, signal);
  }
}

export function createScriptRunner(cfg: { SCRIPT_RUNNER: 'auto' | 'docker' | 'podman' | 'none'; SCRIPT_IMAGE_PYTHON: string; SCRIPT_IMAGE_NODE: string; SCRIPT_IMAGE_TOOLS?: string | undefined; SCRIPT_IMAGE_POWERSHELL?: string | undefined; SCRIPT_RUNTIME?: string | undefined }): ScriptRunner {
  const images: ScriptImages = { python: cfg.SCRIPT_IMAGE_PYTHON, javascript: cfg.SCRIPT_IMAGE_NODE, tools: cfg.SCRIPT_IMAGE_TOOLS ?? DEFAULT_TOOLS_IMAGE, powershell: cfg.SCRIPT_IMAGE_POWERSHELL ?? DEFAULT_POWERSHELL_IMAGE };
  if (cfg.SCRIPT_RUNNER === 'none') return new UnavailableRunner();
  if (cfg.SCRIPT_RUNNER === 'auto') return new AutoRunner(images, cfg.SCRIPT_RUNTIME ?? null);
  return new ContainerRunner(cfg.SCRIPT_RUNNER, images, { runtime: cfg.SCRIPT_RUNTIME ?? null });
}
