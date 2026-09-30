/**
 * Starts e2e/server.ts in a child process (tsx), waits for it to write its state file and answer /readyz, and
 * returns the teardown that stops it. Set E2E_URL to run against a server started by hand instead
 * (`npx tsx e2e/server.ts` writes the same state file).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE_DIR, SERVER_STATE } from './tests/support/state';

const here = path.dirname(fileURLToPath(import.meta.url));

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (process.env.E2E_URL) {
    if (!existsSync(SERVER_STATE)) throw new Error(`E2E_URL is set but ${SERVER_STATE} is missing; start the server with npx tsx e2e/server.ts`);
    return async () => undefined;
  }
  rmSync(STATE_DIR, { recursive: true, force: true });
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', path.join(here, 'server.ts'), '--state', SERVER_STATE], {
    cwd: path.join(here, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env }
  });
  let log = '';
  child.stdout!.on('data', (d: Buffer) => { log += d.toString(); if (process.env.E2E_SERVER_LOG) process.stdout.write(d); });
  child.stderr!.on('data', (d: Buffer) => { log += d.toString(); process.stderr.write(d); });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const ready = await Promise.race([
    (async () => {
      for (let i = 0; i < 600; i++) {
        if (/E2E_READY /.test(log) && existsSync(SERVER_STATE)) {
          const { url } = JSON.parse(readFileSync(SERVER_STATE, 'utf8')) as { url: string };
          const r = await fetch(`${url}/readyz`).catch(() => null);
          if (r?.ok) return true;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    })(),
    exited.then(() => false)
  ]);
  if (!ready) {
    child.kill('SIGKILL');
    throw new Error(`The e2e server did not start:\n${log}`);
  }
  return async () => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 8000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  };
}
