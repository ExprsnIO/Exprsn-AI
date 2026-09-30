/*
 * The import bundle container is a plain POSIX tar (ustar, with pax path records), so a bundle can be built with
 * `tar` on the far side of the diode. Only regular files and directories are accepted: links, devices and anything
 * else make the whole bundle invalid. The reader works on a buffer and never writes to disk.
 */

export interface TarEntry {
  path: string;
  size: number;
  /** Byte offset of the entry's data in the archive. */
  offset: number;
}

export class TarError extends Error {}

const BLOCK = 512;

const str = (b: Buffer, start: number, len: number): string => {
  const s = b.subarray(start, start + len);
  const nul = s.indexOf(0);
  return (nul < 0 ? s : s.subarray(0, nul)).toString('utf8');
};

const octal = (b: Buffer, start: number, len: number): number => {
  const raw = b.subarray(start, start + len);
  if (raw[0]! & 0x80) {
    // base-256 (GNU) for sizes over 8 GiB
    let n = 0;
    for (let i = 1; i < raw.length; i++) n = n * 256 + raw[i]!;
    return n;
  }
  const s = str(b, start, len).trim();
  return s ? Number.parseInt(s, 8) : 0;
};

function checksumOk(h: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
  return sum === octal(h, 148, 8);
}

/** A bundle path must be relative and stay inside the bundle. */
export function safePath(p: string): string {
  const clean = p.replace(/^\.\//, '');
  if (!clean || clean.startsWith('/') || clean.includes('\\') || clean.includes('\0') || clean.split('/').some((x) => x === '..' || x === '')) throw new TarError(`Unsafe path in bundle: ${JSON.stringify(p).slice(0, 120)}`);
  return clean;
}

function paxPath(data: Buffer): string | null {
  let i = 0;
  let found: string | null = null;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const len = Number.parseInt(data.subarray(i, sp).toString(), 10);
    if (!len) break;
    const rec = data.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (rec.slice(0, eq) === 'path') found = rec.slice(eq + 1);
    i += len;
  }
  return found;
}

/**
 * Yields regular-file entries in archive order. Stops early when the caller stops iterating, so reading the first
 * entries (the manifest and its signature) does not touch the rest of the archive.
 */
export function* tarEntries(buf: Buffer): Generator<TarEntry> {
  let pos = 0;
  let nextPath: string | null = null;
  while (pos + BLOCK <= buf.length) {
    const h = buf.subarray(pos, pos + BLOCK);
    if (h.every((x) => x === 0)) return;
    if (!checksumOk(h)) throw new TarError(`Corrupt tar header at byte ${pos}`);
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156]! || 0x30);
    const prefix = h.subarray(257, 262).toString() === 'ustar' ? str(h, 345, 155) : '';
    const dataStart = pos + BLOCK;
    if (dataStart + size > buf.length) throw new TarError('The tar archive is truncated');
    pos = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') {
      nextPath = paxPath(buf.subarray(dataStart, dataStart + size));
      continue;
    }
    if (type === 'g') continue;
    const path = nextPath ?? (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100));
    nextPath = null;
    if (type === '5') continue;
    if (type !== '0') throw new TarError(`Bundle entry ${JSON.stringify(path).slice(0, 120)} is not a regular file (type ${type})`);
    yield { path: safePath(path), size, offset: dataStart };
  }
  throw new TarError('The tar archive has no end marker');
}

const field = (h: Buffer, value: string, start: number, len: number) => h.write(value, start, len, 'utf8');

function header(path: string, size: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  field(h, path, 0, 100);
  field(h, '0000644\0', 100, 8);
  field(h, '0000000\0', 108, 8);
  field(h, '0000000\0', 116, 8);
  field(h, size.toString(8).padStart(11, '0') + '\0', 124, 12);
  field(h, Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136, 12);
  h[156] = 0x30;
  field(h, 'ustar\0', 257, 6);
  field(h, '00', 263, 2);
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const x of h) sum += x;
  field(h, sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

/** Writes a ustar archive (paths up to 100 bytes). Used by tests and tooling that build bundles. */
export function writeTar(files: { path: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    if (Buffer.byteLength(f.path) > 100) throw new TarError(`Path too long for this writer: ${f.path}`);
    parts.push(header(f.path, f.data.length), f.data, Buffer.alloc((BLOCK - (f.data.length % BLOCK)) % BLOCK));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}
