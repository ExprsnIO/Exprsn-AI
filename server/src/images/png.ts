import { deflateSync } from 'node:zlib';

/* Just enough PNG: CRC-32, chunk writing, a tEXt chunk for the provenance manifest, and a tiny encoder (for fakes). */

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export const isPng = (b: Buffer): boolean => b.length > 8 && b.subarray(0, 8).equals(SIGNATURE);

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Inserts a tEXt chunk just before IEND. */
export function addText(png: Buffer, keyword: string, text: string): Buffer {
  if (!isPng(png)) throw new Error('Not a PNG');
  const iend = png.lastIndexOf(Buffer.from('IEND', 'latin1')) - 4;
  if (iend < 8) throw new Error('PNG has no IEND chunk');
  return Buffer.concat([png.subarray(0, iend), chunk('tEXt', Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')])), png.subarray(iend)]);
}

/** Reads the tEXt chunks of a PNG. */
export function readText(png: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 8;
  while (i + 8 <= png.length) {
    const len = png.readUInt32BE(i);
    const type = png.subarray(i + 4, i + 8).toString('latin1');
    if (type === 'tEXt') {
      const data = png.subarray(i + 8, i + 8 + len);
      const z = data.indexOf(0);
      out[data.subarray(0, z).toString('latin1')] = data.subarray(z + 1).toString('latin1');
    }
    i += 12 + len;
  }
  return out;
}

export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (!isPng(png) || png.length < 24) return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** Encodes RGB pixels (width × height × 3 bytes) as a PNG. */
export function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
