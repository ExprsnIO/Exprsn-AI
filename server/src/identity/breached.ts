import { createHash } from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';

export type BreachedMode = 'off' | 'hibp' | 'file' | 'both';

export interface BreachResult {
  breached: boolean;
  /** Which source answered "breached", when one did. */
  source?: 'hibp' | 'file';
  /** A source that could not be checked (the check fails open); the caller audits it. */
  unavailable?: { source: 'hibp' | 'file'; reason: string }[];
}

export interface BreachedSettings {
  mode: BreachedMode;
  hibpUrl: string;
  timeoutMs: number;
  file?: string;
}

export const sha1Hex = (password: string): string => createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();

/**
 * Breached-password check (ASVS 2.1.7). Two sources:
 *  - the Have I Been Pwned range API, by k-anonymity: only the first five hex characters of the SHA-1 leave the
 *    server, the full hash is compared locally against the returned suffixes (padding requested, zero counts ignored);
 *  - a local file of uppercase SHA-1 hashes, sorted, one per line with an optional ":count" (HIBP's "ordered by
 *    hash" download or any list in that format), searched by binary search over byte offsets so it is never loaded.
 * A source that cannot be reached fails open: the password is accepted and `unavailable` says why, for the audit.
 */
export class BreachedPasswords {
  constructor(private readonly cfg: BreachedSettings) {}

  get enabled(): boolean {
    return this.cfg.mode !== 'off';
  }

  async check(password: string): Promise<BreachResult> {
    if (this.cfg.mode === 'off') return { breached: false };
    const hash = sha1Hex(password);
    const unavailable: NonNullable<BreachResult['unavailable']> = [];
    if (this.cfg.mode === 'file' || this.cfg.mode === 'both') {
      try {
        if (await this.inFile(hash)) return { breached: true, source: 'file' };
      } catch (err) {
        unavailable.push({ source: 'file', reason: (err as Error).message });
      }
    }
    if (this.cfg.mode === 'hibp' || this.cfg.mode === 'both') {
      try {
        if (await this.inRange(hash)) return { breached: true, source: 'hibp' };
      } catch (err) {
        unavailable.push({ source: 'hibp', reason: (err as Error).message });
      }
    }
    return unavailable.length ? { breached: false, unavailable } : { breached: false };
  }

  /** GET <base>/range/<prefix>; the answer lists SUFFIX:COUNT lines for every hash with that prefix. */
  private async inRange(hash: string): Promise<boolean> {
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);
    const url = `${this.cfg.hibpUrl.replace(/\/+$/, '')}/range/${prefix}`;
    const res = await fetch(url, { headers: { 'Add-Padding': 'true', 'User-Agent': 'Exprsn-AI password check' }, signal: AbortSignal.timeout(this.cfg.timeoutMs), redirect: 'error' });
    if (!res.ok) throw new Error(`range API answered ${res.status}`);
    const body = await res.text();
    for (const line of body.split('\n')) {
      const [s, n] = line.trim().split(':');
      if (s && s.toUpperCase() === suffix && Number(n ?? '1') > 0) return true;
    }
    return false;
  }

  private async inFile(hash: string): Promise<boolean> {
    if (!this.cfg.file) throw new Error('BREACHED_FILE is not set');
    const fh = await open(this.cfg.file, 'r');
    try {
      return await searchSorted(fh, (await fh.stat()).size, hash);
    } finally {
      await fh.close();
    }
  }
}

/** Reads the first complete line that starts at or after `pos`. Returns null past the end of the file. */
async function lineFrom(fh: FileHandle, pos: number, size: number): Promise<{ text: string; start: number; end: number } | null> {
  let start = pos;
  if (pos > 0) {
    // Find the newline at or after pos-1: the line after it starts at or after pos.
    let at = pos - 1;
    for (;;) {
      if (at >= size) return null;
      const buf = Buffer.alloc(Math.min(256, size - at));
      const { bytesRead } = await fh.read(buf, 0, buf.length, at);
      if (!bytesRead) return null;
      const i = buf.subarray(0, bytesRead).indexOf(0x0a);
      if (i >= 0) {
        start = at + i + 1;
        break;
      }
      at += bytesRead;
    }
  }
  if (start >= size) return null;
  let text = '';
  let at = start;
  while (at < size) {
    const buf = Buffer.alloc(Math.min(256, size - at));
    const { bytesRead } = await fh.read(buf, 0, buf.length, at);
    if (!bytesRead) break;
    const chunk = buf.subarray(0, bytesRead);
    const i = chunk.indexOf(0x0a);
    if (i >= 0) {
      text += chunk.subarray(0, i).toString('latin1');
      return { text: text.replace(/\r$/, ''), start, end: at + i + 1 };
    }
    text += chunk.toString('latin1');
    at += bytesRead;
    if (text.length > 4096) throw new Error('BREACHED_FILE has a line longer than 4 KiB; is it the right format?');
  }
  return { text: text.replace(/\r$/, ''), start, end: size };
}

/** Binary search over byte offsets of a file of sorted lines whose first 40 characters are an uppercase SHA-1. */
export async function searchSorted(fh: FileHandle, size: number, hash: string): Promise<boolean> {
  let lo = 0;
  let hi = size;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const line = await lineFrom(fh, mid, size);
    if (!line || line.start >= hi) {
      hi = mid;
      continue;
    }
    const key = line.text.slice(0, 40).toUpperCase();
    if (key === hash) return true;
    if (key < hash) lo = line.end;
    else hi = mid;
  }
  return false;
}
