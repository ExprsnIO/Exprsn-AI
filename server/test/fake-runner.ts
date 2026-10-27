import type { RunRequest, RunResult, ScriptRunner } from '../src/scripts/runner.js';

/**
 * The test adapter for the script sandbox: records each request and answers from `handler`, so tests exercise
 * checks, jobs, sealing and promotion without a container runtime.
 */
export class FakeRunner implements ScriptRunner {
  readonly name = 'fake';
  requests: RunRequest[] = [];
  handler: (req: RunRequest) => Partial<RunResult> | Promise<Partial<RunResult>> = (req) => ({ stdout: req.stdin ?? '', exitCode: 0 });

  async available(): Promise<boolean> {
    return true;
  }

  async run(req: RunRequest, signal?: AbortSignal): Promise<RunResult> {
    this.requests.push(req);
    if (signal?.aborted) throw signal.reason as Error;
    const r = await this.handler(req);
    return { stdout: '', stderr: '', exitCode: 0, timedOut: false, truncated: false, durationMs: 12, ...r };
  }
}
