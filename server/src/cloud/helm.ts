import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

/*
 * 1.9.99-final, Sprint 58 (B-10203, open decision 7): the pinned `helm` binary the deploy worker installs the chart
 * with (the chart in `deploy/helm/exprsn-ai` stays the single source). `HELM_BIN` names it (default `helm` on the
 * PATH). Every call:
 *
 * - runs the binary as a child process with an argument array, never through a shell;
 * - gets a private working directory (0700) for Helm's cache, config and data homes and the values file (0600),
 *   deleted afterwards, and an environment of its own (no variable of this process reaches it, so no cloud
 *   credential or secret does);
 * - gets the cluster's kubeconfig only as `--kubeconfig <file>` (a private temporary file, `cloud/kubeconfig.ts`);
 * - is refused when the binary's version is not the pinned one (`HELM_PINNED`), so an upgrade of Helm is a reviewed
 *   change here, not whatever is on the PATH.
 *
 * The values never hold a secret: secrets reach the pods from a Kubernetes Secret the chart only names.
 */

/** The Helm release this build is tested with (3.19.0; linux-amd64 sha256 a7f81ce08007091b86d8bd696eb4d86b8d0f2e1b9f6c714be62f82f96a594496). */
export const HELM_PINNED = '3.19.0';

/** The chart, next to the server in a checkout and in the worker image (`/app/deploy/helm/exprsn-ai`). */
export function chartDir(): string {
  return fileURLToPath(new URL('../../../deploy/helm/exprsn-ai', import.meta.url));
}

export interface HelmRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** How the binary is run (tests: a stand-in for the commands that need a cluster). */
export type HelmExec = (bin: string, args: string[], o: { env: Record<string, string>; cwd: string; timeoutMs: number }) => Promise<HelmRun>;

export const execHelm: HelmExec = (bin, args, o) =>
  new Promise((resolve) => {
    execFile(bin, args, { env: o.env, cwd: o.cwd, timeout: o.timeoutMs, maxBuffer: 32 * 1024 * 1024, shell: false, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 127) : 0;
      resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err && code === 127 ? String(err.message) : '') });
    });
  });

export class HelmError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly output: string
  ) {
    super(message);
  }
}

export interface ReleaseInfo {
  name: string;
  namespace: string;
  revision: number;
  status: string;
  chart: string | null;
  appVersion: string | null;
}

export interface HelmOptions {
  bin: string;
  exec?: HelmExec;
  /** The pinned version (`3.19.0`); the binary must report it. */
  pinned?: string;
  timeoutMs?: number;
  /** Where the private working directories go (default the OS temporary directory). */
  tmp?: string;
}

const clip = (s: string) => s.replace(/\s+$/g, '').slice(-2000);

export class Helm {
  private checked: string | null = null;

  constructor(readonly o: HelmOptions) {}

  get bin(): string {
    return this.o.bin;
  }

  /** Runs one command in a private directory; `values` become a 0600 file passed with `--values`. */
  async run(args: string[], o: { values?: unknown; kubeconfig?: string; timeoutMs?: number } = {}): Promise<HelmRun> {
    const dir = await mkdtemp(join(this.o.tmp ?? tmpdir(), 'exprsn-helm-'));
    try {
      const env: Record<string, string> = { HOME: dir, HELM_CACHE_HOME: join(dir, 'cache'), HELM_CONFIG_HOME: join(dir, 'config'), HELM_DATA_HOME: join(dir, 'data'), PATH: '/usr/bin:/bin', HELM_NO_PLUGINS: '1', LANG: 'C' };
      const full = [...args];
      if (o.values !== undefined) {
        const file = join(dir, 'values.yaml');
        await writeFile(file, stringify(o.values), { mode: 0o600, flag: 'wx' });
        full.push('--values', file);
      }
      if (o.kubeconfig) full.push('--kubeconfig', o.kubeconfig);
      return await (this.o.exec ?? execHelm)(this.o.bin, full, { env, cwd: dir, timeoutMs: o.timeoutMs ?? this.o.timeoutMs ?? 15 * 60_000 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** The binary's version (`3.19.0`), or null when it cannot be run. */
  async version(): Promise<string | null> {
    const r = await this.run(['version', '--short']);
    if (r.code !== 0) return null;
    return /v?(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1] ?? null;
  }

  /** Refuses a binary that is missing or not the pinned release. */
  async assertPinned(): Promise<string> {
    if (this.checked) return this.checked;
    const v = await this.version();
    if (!v) throw new HelmError(`The helm binary (${this.o.bin}) cannot be run. Set HELM_BIN to the pinned Helm ${this.o.pinned ?? HELM_PINNED}.`, 'helm_missing', '');
    if (v !== (this.o.pinned ?? HELM_PINNED)) throw new HelmError(`helm is ${v}, not the pinned ${this.o.pinned ?? HELM_PINNED}; set HELM_BIN to the pinned binary.`, 'helm_version_mismatch', '');
    this.checked = v;
    return v;
  }

  /** Whether the pinned binary is there (tests skip what needs it otherwise). */
  async available(): Promise<boolean> {
    try {
      await this.assertPinned();
      return true;
    } catch {
      return false;
    }
  }

  private fail(what: string, r: HelmRun): never {
    throw new HelmError(`helm ${what} failed (exit ${r.code}): ${clip(r.stderr || r.stdout).split('\n').slice(-8).join(' ')}`, 'helm_failed', clip(r.stderr || r.stdout));
  }

  /** The manifests the chart renders with these values (no cluster). */
  async template(o: { chart: string; release: string; namespace: string; values: unknown; kubeVersion?: string }): Promise<string> {
    await this.assertPinned();
    const r = await this.run(['template', o.release, o.chart, '--namespace', o.namespace, ...(o.kubeVersion ? ['--kube-version', o.kubeVersion] : [])], { values: o.values });
    if (r.code !== 0) this.fail('template', r);
    return r.stdout;
  }

  /** `helm lint --strict` with these values (no cluster). */
  async lint(o: { chart: string; values: unknown; kubeVersion?: string }): Promise<{ ok: boolean; output: string }> {
    await this.assertPinned();
    const r = await this.run(['lint', o.chart, '--strict', ...(o.kubeVersion ? ['--kube-version', o.kubeVersion] : [])], { values: o.values });
    return { ok: r.code === 0, output: clip(r.stdout + r.stderr) };
  }

  /** Installs or upgrades the release and waits for it (the chart's migrate Job runs as its pre-install/pre-upgrade hook). */
  async upgradeInstall(o: { chart: string; release: string; namespace: string; values: unknown; kubeconfig: string; timeoutSeconds: number }): Promise<ReleaseInfo> {
    await this.assertPinned();
    const r = await this.run(['upgrade', '--install', o.release, o.chart, '--namespace', o.namespace, '--create-namespace', '--wait', '--wait-for-jobs', '--timeout', `${o.timeoutSeconds}s`, '--history-max', '10', '--output', 'json'], { values: o.values, kubeconfig: o.kubeconfig, timeoutMs: (o.timeoutSeconds + 60) * 1000 });
    if (r.code !== 0) this.fail('upgrade --install', r);
    return parseRelease(r.stdout, o.release, o.namespace);
  }

  /** Back to an earlier revision of the release, waiting for it. */
  async rollback(o: { release: string; namespace: string; revision: number; kubeconfig: string; timeoutSeconds: number }): Promise<void> {
    await this.assertPinned();
    const r = await this.run(['rollback', o.release, String(o.revision), '--namespace', o.namespace, '--wait', '--timeout', `${o.timeoutSeconds}s`], { kubeconfig: o.kubeconfig, timeoutMs: (o.timeoutSeconds + 60) * 1000 });
    if (r.code !== 0) this.fail('rollback', r);
  }

  /** The release's revisions, oldest first. */
  async history(o: { release: string; namespace: string; kubeconfig: string }): Promise<ReleaseInfo[]> {
    await this.assertPinned();
    const r = await this.run(['history', o.release, '--namespace', o.namespace, '--output', 'json', '--max', '20'], { kubeconfig: o.kubeconfig });
    if (r.code !== 0) {
      if (/not found/i.test(r.stderr)) return [];
      this.fail('history', r);
    }
    const list = JSON.parse(r.stdout || '[]') as { revision: number; status: string; chart?: string; app_version?: string }[];
    return list.map((x) => ({ name: o.release, namespace: o.namespace, revision: Number(x.revision), status: String(x.status), chart: x.chart ?? null, appVersion: x.app_version ?? null }));
  }
}

function parseRelease(stdout: string, release: string, namespace: string): ReleaseInfo {
  try {
    const j = JSON.parse(stdout) as { name?: string; namespace?: string; version?: number; info?: { status?: string }; chart?: { metadata?: { version?: string; appVersion?: string } } };
    return { name: j.name ?? release, namespace: j.namespace ?? namespace, revision: Number(j.version ?? 0), status: j.info?.status ?? 'unknown', chart: j.chart?.metadata?.version ?? null, appVersion: j.chart?.metadata?.appVersion ?? null };
  } catch {
    throw new HelmError('helm upgrade answered something that is not a release.', 'helm_failed', stdout.slice(0, 500));
  }
}

/** The configured binary: HELM_BIN, else `helm` on the PATH (resolved here, since the child gets a minimal PATH). */
export function helmBin(configured: string | undefined): string {
  if (configured && configured !== 'helm') return configured;
  for (const d of (process.env.PATH ?? '').split(':')) {
    if (d && existsSync(join(d, 'helm'))) return join(d, 'helm');
  }
  return 'helm';
}
