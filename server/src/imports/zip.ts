import { Readable } from 'node:stream';
import { crc32, createInflateRaw } from 'node:zlib';
import { SourceError } from './types.js';

/*
 * B-3804: a zip archive read from memory, for datasets published as archives (Kaggle, a zipped CSV on a portal) and
 * for xlsx workbooks, which are zip archives. Nothing is written to disk and a member's name is never a path: it is
 * shown, and used to tell what the member is. What a hostile archive could do is bounded here:
 *
 * - the central directory lists at most `MAX_ENTRIES` members, and their data may not overlap (an archive whose
 *   members share one compressed block unpacks to many times its size);
 * - a member unpacks to at most the size its header states, and all members read from one archive (and from the
 *   workbooks inside it) to at most `Unpack.max` bytes together;
 * - stored and deflated members only; encrypted members, Zip64 and other methods are refused;
 * - every member read whole is checked against its CRC-32.
 */

export const MAX_ENTRIES = 2000;

export interface ZipEntry {
  /** The member's name as the archive states it, with `/` separators. */
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  crc: number;
  encrypted: boolean;
  directory: boolean;
  /** Where the member's bytes start and end in the archive. */
  start: number;
  end: number;
}

/** Unpacked bytes read so far from one download, and the most it may unpack to. */
export interface Unpack {
  used: number;
  max: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export const isZip = (head: Uint8Array): boolean => head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && ((head[2] === 3 && head[3] === 4) || (head[2] === 5 && head[3] === 6));

/** A name that is safe to show and to judge by: no drive, no leading slash, no `..` segment, no control characters. */
function plainName(raw: string): string | null {
  const name = raw.replace(/\\/g, '/');
  // eslint-disable-next-line no-control-regex
  if (!name || name.length > 1024 || /[\u0000-\u001f\u007f]/.test(name)) return null;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').some((seg) => seg === '..')) return null;
  return name;
}

/** The members of an archive, from its central directory. */
export function zipEntries(buf: Buffer): ZipEntry[] {
  // The end record is the last 22 bytes, or sits before a comment of at most 65 535 bytes.
  let at = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === EOCD && i + 22 + buf.readUInt16LE(i + 20) <= buf.length) {
      at = i;
      break;
    }
  }
  if (at < 0) throw new SourceError('The file is not a zip archive (it has no end record), or it is cut short.');
  const count = buf.readUInt16LE(at + 10);
  const cdSize = buf.readUInt32LE(at + 12);
  const cdStart = buf.readUInt32LE(at + 16);
  if (buf.readUInt16LE(at + 4) !== 0 || buf.readUInt16LE(at + 6) !== 0 || buf.readUInt16LE(at + 8) !== count) throw new SourceError('An archive split over several files is not read.');
  if (count === 0xffff || cdSize === 0xffffffff || cdStart === 0xffffffff) throw new SourceError('Zip64 archives are not read. Pick an uncompressed resource, or a smaller archive.');
  if (count > MAX_ENTRIES) throw new SourceError(`The archive lists ${count.toLocaleString('en-US')} members; at most ${MAX_ENTRIES.toLocaleString('en-US')} are read.`);
  if (cdStart + cdSize > at) throw new SourceError('The archive\'s directory does not fit the file.');
  const out: ZipEntry[] = [];
  let p = cdStart;
  for (let n = 0; n < count; n++) {
    if (p + 46 > at || buf.readUInt32LE(p) !== CENTRAL) throw new SourceError('The archive\'s directory is damaged.');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen + extraLen + commentLen > at) throw new SourceError('The archive\'s directory is damaged.');
    if (compressedSize === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw new SourceError('Zip64 archives are not read. Pick an uncompressed resource, or a smaller archive.');
    const raw = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL) throw new SourceError('A member of the archive is not where its directory says.');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const end = start + compressedSize;
    if (end > cdStart) throw new SourceError('A member of the archive runs past its data.');
    const name = plainName(raw);
    // A member with a name that is no plain relative name is left out: nothing here needs it.
    if (!name) continue;
    out.push({ name, method, compressedSize, size, crc, encrypted: (flags & 1) === 1, directory: name.endsWith('/'), start, end });
  }
  const spans = out.filter((e) => e.compressedSize > 0).sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) if (spans[i]!.start < spans[i - 1]!.end) throw new SourceError('Members of the archive overlap; it is not read.');
  return out;
}

function refuse(e: ZipEntry): void {
  if (e.encrypted) throw new SourceError(`${e.name} is encrypted; encrypted archives are not read.`);
  if (e.method !== 0 && e.method !== 8) throw new SourceError(`${e.name} is packed with a method this import does not read (${e.method}); stored and deflated members are.`);
  if (e.method === 0 && e.size !== e.compressedSize) throw new SourceError(`${e.name} is stored but its sizes differ.`);
}

/** One member's bytes, unpacked as a stream and counted against the archive's allowance. */
export async function* zipMember(buf: Buffer, e: ZipEntry, unpack: Unpack): AsyncGenerator<Uint8Array> {
  refuse(e);
  if (unpack.used + e.size > unpack.max) throw new SourceError(`The archive unpacks to more than the ${unpack.max.toLocaleString('en-US')} bytes an import may unpack (IMPORT_ARCHIVE_MAX_UNPACKED_BYTES).`);
  const packed = buf.subarray(e.start, e.end);
  let seen = 0;
  let crc = 0;
  const count = (c: Uint8Array) => {
    seen += c.length;
    unpack.used += c.length;
    // The header's size is the bound: a member that unpacks past it is not what the directory lists.
    if (seen > e.size) throw new SourceError(`${e.name} unpacks to more than the ${e.size.toLocaleString('en-US')} bytes its header states.`);
    if (unpack.used > unpack.max) throw new SourceError(`The archive unpacks to more than the ${unpack.max.toLocaleString('en-US')} bytes an import may unpack (IMPORT_ARCHIVE_MAX_UNPACKED_BYTES).`);
    crc = crc32(c, crc);
  };
  if (e.method === 0) {
    for (let i = 0; i < packed.length; i += 1 << 20) {
      const c = packed.subarray(i, i + (1 << 20));
      count(c);
      yield c;
    }
  } else {
    const inflate = Readable.from([packed]).pipe(createInflateRaw());
    try {
      for await (const c of inflate as AsyncIterable<Buffer>) {
        count(c);
        yield c;
      }
    } catch (err) {
      if (err instanceof SourceError) throw err;
      throw new SourceError(`${e.name} could not be unpacked: ${(err as Error).message.slice(0, 200)}`);
    } finally {
      inflate.destroy();
    }
  }
  if (seen !== e.size || crc >>> 0 !== e.crc) throw new SourceError(`${e.name} does not match its checksum in the archive.`);
}

/** One member read whole. */
export async function zipBytes(buf: Buffer, e: ZipEntry, unpack: Unpack): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of zipMember(buf, e, unpack)) parts.push(Buffer.from(c));
  return Buffer.concat(parts);
}
