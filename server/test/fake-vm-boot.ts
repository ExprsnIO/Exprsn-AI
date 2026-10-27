/*
 * 1.9.99-final, Sprint 58 (B-10204): what an app VM's first boot prints on its console, for the cloud fakes. The
 * fakes do not run the installer (the shell test `deploy-from-release.test.ts` runs the real one against a good and a
 * tampered tarball); they read the bootstrap in the user data the adapter sent, look up what the release URL really
 * serves (`releases`: URL to the sha256 of its bytes, which a test sets, a tampered tarball having another digest)
 * and print the lines the installer prints in that case: a refusal before anything from the archive runs, or the
 * verified install. It is never a real VM.
 */

export interface BootResult {
  console: string;
  url: string | null;
  pinned: string | null;
  /** The wrapped-token JSON the adapter put in place of the placeholder. */
  bootstrap: Record<string, unknown> | null;
  installed: boolean;
}

const MARK = 'exprsn-install:';

export function simulateBoot(userData: string | null | undefined, releases: Map<string, string>): BootResult {
  const text = userData ?? '';
  const url = /^\s*URL='([^']*)'/m.exec(text)?.[1] ?? null;
  const pinned = /^\s*SHA='([a-f0-9]*)'/m.exec(text)?.[1] ?? null;
  const tokenLine = /path: \/run\/exprsn-bootstrap\/token\n\s+permissions: '0600'\n\s+content: '(.*)'/.exec(text)?.[1] ?? null;
  let bootstrap: Record<string, unknown> | null = null;
  try {
    bootstrap = tokenLine ? (JSON.parse(tokenLine.replace(/''/g, "'")) as Record<string, unknown>) : null;
  } catch {
    bootstrap = null;
  }
  const lines = ['[    0.000000] Linux version 6.8.0 (fake)', 'Cloud-init v. 24.4 running modules:final'];
  const done = (installed: boolean, extra: string[]): BootResult => ({ console: [...lines, ...extra, 'Cloud-init v. 24.4 finished'].join('\n'), url, pinned, bootstrap, installed });
  if (!url || !pinned) return done(false, []);
  if (!url.startsWith('https://')) return done(false, [`${MARK} refused the release URL is not https`]);
  const actual = releases.get(url);
  if (!actual) return done(false, [`${MARK} refused the release tarball could not be downloaded`]);
  if (actual !== pinned) return done(false, [`${MARK} refused sha256 mismatch: expected ${pinned}, got ${actual}`]);
  if (!text.includes(`--from-release '${url}'`) || !text.includes(`--sha256 ${pinned}`)) return done(false, [`${MARK} refused the installer was not asked for --from-release with the pinned digest`]);
  const creds = bootstrap && typeof bootstrap.token === 'string' ? `${MARK} credentials loaded as systemd credentials` : `${MARK} credentials pending: no wrapped token`;
  return done(true, [`${MARK} verified sha256 ${pinned}`, creds, `${MARK} installed from ${url}`]);
}
