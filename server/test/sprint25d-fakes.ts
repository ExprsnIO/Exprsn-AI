import { spawnRun, type MessageHandler, type RunRequest, type RunResult, type ScriptRunner } from '../src/scripts/runner.js';

/**
 * Sprint 25d: a script runner for the plugin tests that runs the real handler program (the prelude, the plugin's
 * source and its entry call) as a local `node` or `python3` process, through the same `spawnRun` the container
 * adapter uses, so the broker protocol is exercised end to end without a container runtime. It gives no isolation:
 * tests only.
 */
export class ProcessRunner implements ScriptRunner {
  readonly name = 'process (tests)';
  requests: RunRequest[] = [];

  async available(): Promise<boolean> {
    return true;
  }

  async run(req: RunRequest, signal?: AbortSignal): Promise<RunResult> {
    return this.exec(req, signal);
  }

  async session(req: RunRequest, onMessage: MessageHandler, signal?: AbortSignal): Promise<RunResult> {
    return this.exec(req, signal, onMessage);
  }

  private exec(req: RunRequest, signal?: AbortSignal, onMessage?: MessageHandler): Promise<RunResult> {
    this.requests.push(req);
    const [bin, args] = req.language === 'python' ? ['python3', ['-I', '-c', req.source]] : [process.execPath, ['--input-type=module', '-e', req.source]];
    return spawnRun(bin, args, req, { signal, onMessage, kill: () => undefined, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp' } });
  }
}

/**
 * A runner whose session is played by a test function: it receives the hello line (event, config and the scoped
 * token) and a `call` that speaks the broker protocol over the session, as a handler would.
 */
export class ScriptedSession implements ScriptRunner {
  readonly name = 'scripted (tests)';
  play: (hello: { token: string; event: { type: string; data: Record<string, unknown> }; config: Record<string, unknown> }, call: (api: string, args?: Record<string, unknown>) => Promise<{ status: number; body?: unknown; detail?: string }>) => Promise<unknown> = async () => null;

  async available(): Promise<boolean> {
    return true;
  }

  async run(): Promise<RunResult> {
    throw new Error('not used');
  }

  async session(req: RunRequest, onMessage: MessageHandler): Promise<RunResult> {
    const hello = JSON.parse(req.stdin ?? '{}') as Parameters<ScriptedSession['play']>[0];
    let n = 0;
    const call = async (api: string, args: Record<string, unknown> = {}) => (await onMessage({ t: 'call', id: ++n, token: hello.token, api, args })) as { status: number; body?: unknown; detail?: string };
    const result = await this.play(hello, call);
    await onMessage({ t: 'done', result });
    return { stdout: 'played\n', stderr: '', exitCode: 0, timedOut: false, truncated: false, durationMs: 1 };
  }
}
