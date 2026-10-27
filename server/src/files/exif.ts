/*
 * 1.8.0 (B-142): image metadata taken out of the copies the file store serves, in process, with no image library.
 * Only the container is rewritten; the pixels are never decoded or re-encoded, so a served copy looks exactly like the
 * original. The original stays as it was uploaded (its owner can still download it).
 *
 * - JPEG (streamed, segment by segment): APP1 (EXIF with its GPS IFD and thumbnail, XMP, extended XMP), APP3 to
 *   APP13 (Photoshop and IPTC in APP13, JUMBF/C2PA in APP11), APP15 and comments go; APP2 goes unless it is an ICC
 *   profile (so MPF indexes of extra images go too), APP0 JFIF stays without its thumbnail, APP14 Adobe stays (it says
 *   how to read the colours). EXIF's Orientation is kept as a one-tag EXIF block, so a phone photo is not shown on its
 *   side. Segments between progressive scans are treated the same way. Anything after the end-of-image marker (MPF
 *   extra images, appended data) goes.
 * - PNG (streamed, chunk by chunk): critical chunks stay, and the ancillary chunks that change how the image looks
 *   (tRNS, cHRM, gAMA, iCCP, sBIT, sRGB, cICP, mDCv, cLLi, bKGD, hIST, pHYs, sPLT, and APNG's acTL, fcTL, fdAT);
 *   everything else goes: eXIf, tEXt, zTXt, iTXt, tIME, caBX (C2PA, which may hold EXIF and location assertions) and
 *   unknown chunks. Nothing after IEND.
 * - WebP (read whole, up to STRIP_BUFFER_MAX): EXIF and XMP chunks and unknown chunks go, VP8X's EXIF and XMP flags are
 *   cleared and the RIFF size is recomputed; ICCP, ANIM, ANMF, ALPH and the bitstream chunks stay.
 * - GIF (read whole): comment extensions and application extensions other than looping (NETSCAPE2.0, ANIMEXTS1.0) and
 *   the ICC profile (ICCRGBG1) go (XMP lives in an application extension). Nothing after the trailer.
 *
 * A file that does not parse fails closed (StripError): it is not served as it is.
 */

export const STRIP_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
/** WebP and GIF are rewritten in memory: larger ones are refused rather than served with their metadata. */
export const STRIP_BUFFER_MAX = 32 * 1024 * 1024;

export class StripError extends Error {}

export const strippable = (type: string | null | undefined): boolean => !!type && STRIP_TYPES.includes(type);

/** Reads exactly what it is asked for from a stream of chunks, keeping the rest for the next read. */
class Reader {
  private buf: Buffer = Buffer.alloc(0);
  private done = false;
  private readonly it: AsyncIterator<Buffer | Uint8Array> | Iterator<Buffer | Uint8Array>;

  constructor(src: AsyncIterable<Buffer | Uint8Array> | Iterable<Buffer | Uint8Array>) {
    this.it = Symbol.asyncIterator in src ? src[Symbol.asyncIterator]() : src[Symbol.iterator]();
  }

  get buffered(): Buffer {
    return this.buf;
  }

  /** The buffered byte at `i` (a method, so each read is fresh). */
  byte(i: number): number | undefined {
    return this.buf[i];
  }

  /** Whether `n` bytes are buffered (reading more if needed). */
  async fill(n: number): Promise<boolean> {
    while (this.buf.length < n && !this.done) {
      const r = await this.it.next();
      if (r.done) this.done = true;
      else if (r.value.length) this.buf = this.buf.length ? Buffer.concat([this.buf, r.value]) : Buffer.from(r.value);
    }
    return this.buf.length >= n;
  }

  take(n: number): Buffer {
    const b = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return b;
  }

  /** `n` bytes onward without holding them all (a PNG IDAT chunk may be large). */
  async *pass(n: number, keep: boolean): AsyncGenerator<Buffer> {
    let left = n;
    while (left > 0) {
      if (!this.buf.length && !(await this.fill(1))) throw new StripError('The image ends in the middle of a part.');
      const part = this.take(Math.min(left, this.buf.length));
      left -= part.length;
      if (keep) yield part;
    }
  }

  async close(): Promise<void> {
    await this.it.return?.(undefined);
  }
}

// ---------- JPEG ----------

const EXIF_ID = Buffer.from('Exif\0\0', 'latin1');
const ICC_ID = Buffer.from('ICC_PROFILE\0', 'latin1');

/** EXIF's Orientation (1 to 8) from an APP1 EXIF payload, or null. Every read is bounds-checked. */
export function exifOrientation(payload: Buffer): number | null {
  if (payload.length < 14 || !payload.subarray(0, 6).equals(EXIF_ID)) return null;
  const t = payload.subarray(6);
  const le = t[0] === 0x49 && t[1] === 0x49;
  if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return null;
  const u16 = (o: number) => (o + 2 <= t.length ? (le ? t.readUInt16LE(o) : t.readUInt16BE(o)) : -1);
  const u32 = (o: number) => (o + 4 <= t.length ? (le ? t.readUInt32LE(o) : t.readUInt32BE(o)) : -1);
  if (u16(2) !== 42) return null;
  const ifd = u32(4);
  const count = u16(ifd);
  if (ifd < 8 || count < 0) return null;
  for (let i = 0; i < Math.min(count, 500); i++) {
    const e = ifd + 2 + i * 12;
    if (u16(e) === 0x0112 && u16(e + 2) === 3) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : null;
    }
  }
  return null;
}

/** An APP1 segment holding only Orientation (big-endian TIFF, one IFD entry, no next IFD). */
function orientationSegment(v: number): Buffer {
  const body = Buffer.alloc(6 + 8 + 2 + 12 + 4);
  EXIF_ID.copy(body, 0);
  body.write('MM', 6, 'latin1');
  body.writeUInt16BE(42, 8);
  body.writeUInt32BE(8, 10);
  body.writeUInt16BE(1, 14);
  body.writeUInt16BE(0x0112, 16);
  body.writeUInt16BE(3, 18);
  body.writeUInt32BE(1, 20);
  body.writeUInt16BE(v, 24);
  body.writeUInt32BE(0, 28);
  const seg = Buffer.alloc(4);
  seg.writeUInt16BE(0xffe1, 0);
  seg.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([seg, body]);
}

/** What becomes of an APPn or COM segment: dropped (null), kept, or replaced. */
function appSegment(marker: number, seg: Buffer): Buffer | null {
  const payload = seg.subarray(4);
  if (marker === 0xe0) {
    // JFIF stays, without its thumbnail; JFXX (a thumbnail extension) goes.
    if (payload.length >= 14 && payload.subarray(0, 5).toString('latin1') === 'JFIF\0') {
      const out = Buffer.from(seg.subarray(0, 4 + 14));
      out.writeUInt16BE(16, 2);
      out[4 + 12] = 0;
      out[4 + 13] = 0;
      return out;
    }
    return null;
  }
  if (marker === 0xe1) {
    const o = exifOrientation(payload);
    return o != null && o !== 1 ? orientationSegment(o) : null;
  }
  if (marker === 0xe2) return payload.subarray(0, ICC_ID.length).equals(ICC_ID) ? seg : null;
  if (marker === 0xee) return payload.subarray(0, 5).toString('latin1') === 'Adobe' ? seg : null;
  return null;
}

async function* jpeg(r: Reader): AsyncGenerator<Buffer> {
  if (!(await r.fill(2)) || r.byte(0) !== 0xff || r.byte(1) !== 0xd8) throw new StripError('Not a JPEG image.');
  yield r.take(2);
  let orientationWritten = false;
  for (;;) {
    if (!(await r.fill(2))) return; // a truncated file ends here, as a viewer would stop
    if (r.byte(0) !== 0xff) throw new StripError('The JPEG has data where a marker belongs.');
    if (r.byte(1) === 0xff) {
      r.take(1); // fill byte before a marker
      continue;
    }
    const marker = r.byte(1)!;
    if (marker === 0xd9) {
      yield r.take(2);
      return; // nothing after the end of the image
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xd8) {
      yield r.take(2);
      continue;
    }
    if (!(await r.fill(4))) throw new StripError('The JPEG ends inside a marker.');
    const len = r.buffered.readUInt16BE(2);
    if (len < 2) throw new StripError('A JPEG segment has an impossible length.');
    if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) {
      if (!(await r.fill(2 + len))) throw new StripError('The JPEG ends inside a segment.');
      const seg = r.take(2 + len);
      const kept = marker === 0xfe ? null : appSegment(marker, seg);
      if (kept && marker === 0xe1) {
        if (orientationWritten) continue;
        orientationWritten = true;
      }
      if (kept) yield kept;
      continue;
    }
    if (marker !== 0xda) {
      yield* r.pass(2 + len, true);
      continue;
    }
    // Start of scan: its header, then entropy-coded data up to the next marker (stuffed 00 and restarts are data).
    yield* r.pass(2 + len, true);
    for (;;) {
      if (!r.buffered.length && !(await r.fill(1))) return;
      const at = r.buffered.indexOf(0xff);
      if (at < 0) {
        yield r.take(r.buffered.length);
        continue;
      }
      if (at > 0) yield r.take(at);
      if (!(await r.fill(2))) {
        yield r.take(r.buffered.length);
        return;
      }
      const next = r.byte(1)!;
      if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
        yield r.take(2);
        continue;
      }
      if (next === 0xff) {
        r.take(1);
        continue;
      }
      break; // a marker: back to the segment loop
    }
  }
}

// ---------- PNG ----------

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_KEEP = new Set(['tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'cICP', 'mDCv', 'cLLi', 'bKGD', 'hIST', 'pHYs', 'sPLT', 'acTL', 'fcTL', 'fdAT']);

async function* png(r: Reader): AsyncGenerator<Buffer> {
  if (!(await r.fill(8)) || !r.buffered.subarray(0, 8).equals(PNG_SIG)) throw new StripError('Not a PNG image.');
  yield r.take(8);
  for (;;) {
    if (!(await r.fill(8))) {
      if (r.buffered.length) throw new StripError('The PNG ends inside a chunk header.');
      return;
    }
    const len = r.buffered.readUInt32BE(0);
    const type = r.buffered.subarray(4, 8).toString('latin1');
    if (len > 0x7fffffff || !/^[A-Za-z]{4}$/.test(type)) throw new StripError('A PNG chunk is not valid.');
    const critical = type[0]! >= 'A' && type[0]! <= 'Z';
    const keep = critical || PNG_KEEP.has(type);
    const head = r.take(8);
    if (keep) yield head;
    yield* r.pass(len + 4, keep);
    if (type === 'IEND') return;
  }
}

// ---------- WebP ----------

const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);

export function stripWebp(b: Buffer): Buffer {
  if (b.length < 12 || b.subarray(0, 4).toString('latin1') !== 'RIFF' || b.subarray(8, 12).toString('latin1') !== 'WEBP') throw new StripError('Not a WebP image.');
  const end = Math.min(b.length, 8 + b.readUInt32LE(4));
  const parts: Buffer[] = [];
  let o = 12;
  while (o + 8 <= end) {
    const id = b.subarray(o, o + 4).toString('latin1');
    const size = b.readUInt32LE(o + 4);
    const total = 8 + size + (size % 2);
    if (o + 8 + size > end) throw new StripError('A WebP chunk runs past the end of the file.');
    if (WEBP_KEEP.has(id)) {
      const chunk = Buffer.from(b.subarray(o, Math.min(end, o + total)));
      if (id === 'VP8X' && size >= 1) chunk[8] = chunk[8]! & ~0x0c; // EXIF (0x08) and XMP (0x04) flags
      parts.push(chunk);
    }
    o += total;
  }
  const body = Buffer.concat(parts);
  const head = Buffer.from('RIFF\0\0\0\0WEBP', 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  return Buffer.concat([head, body]);
}

// ---------- GIF ----------

const GIF_APPS = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0', 'ICCRGBG1012']);

export function stripGif(b: Buffer): Buffer {
  const sig = b.subarray(0, 6).toString('latin1');
  if (b.length < 13 || (sig !== 'GIF87a' && sig !== 'GIF89a')) throw new StripError('Not a GIF image.');
  const parts: Buffer[] = [];
  const need = (n: number) => {
    if (n > b.length) throw new StripError('The GIF ends inside a block.');
  };
  /** The end of a run of sub-blocks starting at `o`. */
  const subBlocks = (o: number): number => {
    for (;;) {
      need(o + 1);
      const n = b[o]!;
      o += 1 + n;
      if (n === 0) return o;
    }
  };
  let o = 13;
  if (b[10]! & 0x80) o += 3 * 2 ** ((b[10]! & 0x07) + 1);
  need(o);
  parts.push(b.subarray(0, o));
  for (;;) {
    need(o + 1);
    const block = b[o]!;
    if (block === 0x3b) {
      parts.push(b.subarray(o, o + 1));
      break; // nothing after the trailer
    }
    if (block === 0x2c) {
      need(o + 10);
      let p = o + 10;
      if (b[o + 9]! & 0x80) p += 3 * 2 ** ((b[o + 9]! & 0x07) + 1);
      const end = subBlocks(p + 1);
      parts.push(b.subarray(o, end));
      o = end;
      continue;
    }
    if (block === 0x21) {
      need(o + 2);
      const label = b[o + 1]!;
      const end = subBlocks(o + 2);
      const app = label === 0xff && b[o + 2] === 11 ? b.subarray(o + 3, o + 14).toString('latin1') : null;
      if (label === 0xf9 || label === 0x01 || (app && GIF_APPS.has(app))) parts.push(b.subarray(o, end));
      o = end;
      continue;
    }
    throw new StripError('The GIF has an unknown block.');
  }
  return Buffer.concat(parts);
}

// ---------- entry points ----------

async function collectAll(src: AsyncIterable<Buffer | Uint8Array> | Iterable<Buffer | Uint8Array>, max: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let n = 0;
  for await (const c of src) {
    n += c.length;
    if (n > max) throw new StripError(`An image of this type is cleaned of its metadata in memory, up to ${max} bytes; this one is larger.`);
    parts.push(Buffer.from(c));
  }
  return Buffer.concat(parts, n);
}

/**
 * The image without its metadata, as a stream. JPEG and PNG are rewritten as they stream; WebP and GIF are read whole
 * (up to STRIP_BUFFER_MAX) first. Other types pass unchanged.
 */
export async function* stripStream(type: string | null, src: AsyncIterable<Buffer | Uint8Array> | Iterable<Buffer | Uint8Array>): AsyncGenerator<Buffer> {
  if (type === 'image/webp' || type === 'image/gif') {
    const all = await collectAll(src, STRIP_BUFFER_MAX);
    yield type === 'image/webp' ? stripWebp(all) : stripGif(all);
    return;
  }
  if (type !== 'image/jpeg' && type !== 'image/png') {
    for await (const c of src) yield Buffer.from(c);
    return;
  }
  const r = new Reader(src);
  try {
    yield* type === 'image/jpeg' ? jpeg(r) : png(r);
  } finally {
    await r.close();
  }
}

/** The image without its metadata, in memory (previews, model calls, small copies). */
export async function stripBuffer(type: string | null, data: Buffer): Promise<Buffer> {
  if (!strippable(type)) return data;
  if (type === 'image/webp') return stripWebp(data);
  if (type === 'image/gif') return stripGif(data);
  const parts: Buffer[] = [];
  for await (const c of stripStream(type, [data])) parts.push(c);
  return Buffer.concat(parts);
}
