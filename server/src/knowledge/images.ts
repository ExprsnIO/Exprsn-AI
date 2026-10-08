import { inflateSync } from 'node:zlib';
import { encodePng } from '../images/png.js';
import { zipEntries } from './extract.js';

/*
 * Sprint 36c (B-8801): images as knowledge documents. Detection from the bytes, the images inside PDF and Word
 * documents, and the vision profile's prompt and answer. No image library: images are passed to the vision model as
 * they are; the only re-encoding is a PDF's raw (Flate) image as a PNG, which is lossless.
 */

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

/** Types a browser shows, so the image itself serves as its thumbnail. HEIC has no thumbnail. */
export const VIEWABLE: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export const isImageType = (t: string | null | undefined): t is ImageType => !!t && (IMAGE_TYPES as readonly string[]).includes(t);

/** The image type of the bytes, or null. HEIC is an ISO-BMFF `ftyp` box with a HEIF brand. */
export function imageType(b: Buffer): ImageType | null {
  if (b.length < 12) return null;
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  const head = b.subarray(0, 6).toString('latin1');
  if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  if (b.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|heim|heis|hevc|hevx|mif1|msf1)$/.test(b.subarray(8, 12).toString('latin1'))) return 'image/heic';
  return null;
}

export interface ImagePart {
  data: Buffer;
  type: ImageType;
}

export interface PartOptions {
  /** At most this many images per document. */
  max: number;
  /** Smaller images (icons, bullets, spacers) are skipped. */
  minBytes: number;
}

export const PART_DEFAULTS: PartOptions = { max: 20, minBytes: 1024 };

/** The images inside a PDF or Word document, in document order. */
export function imageParts(buf: Buffer, type: string, opts: PartOptions = PART_DEFAULTS): ImagePart[] {
  try {
    const all = type === 'application/pdf' ? pdfImages(buf, opts.max * 4) : type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ? docxImages(buf, opts.max * 4) : [];
    return all.filter((p) => p.data.length >= opts.minBytes).slice(0, opts.max);
  } catch {
    return [];
  }
}

/** Word keeps its pictures under word/media/ (in the order they were added). */
function docxImages(buf: Buffer, max: number): ImagePart[] {
  const out: ImagePart[] = [];
  const entries = zipEntries(buf);
  const names = [...entries.keys()].filter((n) => n.startsWith('word/media/')).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  for (const n of names) {
    if (out.length >= max) break;
    const data = entries.get(n)!();
    const t = imageType(data);
    if (t) out.push({ data: Buffer.from(data), type: t });
  }
  return out;
}

/**
 * Image XObjects of a PDF: JPEG (`/DCTDecode`) as stored, and 8-bit DeviceRGB or DeviceGray Flate images as PNG.
 * Other encodings (JPEG 2000, CCITT, indexed colour, masks) are left out.
 */
function pdfImages(buf: Buffer, max: number): ImagePart[] {
  const raw = buf.toString('latin1');
  if (/\/Encrypt\s/.test(raw)) return [];
  const out: ImagePart[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) && out.length < max) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    re.lastIndex = end + 9;
    const dictStart = raw.lastIndexOf('<<', m.index);
    const dict = dictStart >= 0 ? raw.slice(dictStart, m.index) : '';
    if (!/\/Subtype\s*\/Image/.test(dict)) continue;
    let data = buf.subarray(start, end);
    if (/\/DCTDecode/.test(dict)) {
      // The stream ends at the JPEG's end-of-image marker; what follows is the PDF's line end.
      const eoi = data.lastIndexOf(Buffer.from([0xff, 0xd9]));
      if (eoi > 0) data = data.subarray(0, eoi + 2);
      if (imageType(data) === 'image/jpeg') out.push({ data: Buffer.from(data), type: 'image/jpeg' });
      continue;
    }
    if (!/\/FlateDecode/.test(dict) || /\/Filter\s*\[[^\]]*\/[A-Z]\w+[^\]]*\/[A-Z]/.test(dict)) continue;
    const num = (k: string) => Number(new RegExp(`/${k}\\s+(\\d+)`).exec(dict)?.[1] ?? NaN);
    const w = num('Width');
    const h = num('Height');
    const bpc = num('BitsPerComponent');
    const gray = /\/ColorSpace\s*\/DeviceGray/.test(dict);
    const rgb = /\/ColorSpace\s*\/DeviceRGB/.test(dict);
    if (!(w > 0 && h > 0 && w * h <= 25_000_000 && bpc === 8 && (gray || rgb))) continue;
    let pixels: Buffer;
    try {
      pixels = inflateSync(data, { maxOutputLength: 64 * 1024 * 1024 });
    } catch {
      continue;
    }
    const comps = gray ? 1 : 3;
    const predictor = num('Predictor');
    if (predictor >= 10) pixels = unPredict(pixels, w * comps, h, comps);
    if (pixels.length < w * h * comps) continue;
    const rgbData = gray ? Buffer.from(Array.from(pixels.subarray(0, w * h)).flatMap((v) => [v, v, v])) : pixels.subarray(0, w * h * 3);
    out.push({ data: encodePng(w, h, rgbData), type: 'image/png' });
  }
  return out;
}

/** Undoes PNG row predictors (a PDF Flate stream with /Predictor 10 to 15). */
function unPredict(data: Buffer, rowBytes: number, rows: number, bpp: number): Buffer {
  const out = Buffer.alloc(rowBytes * rows);
  let prev = Buffer.alloc(rowBytes);
  for (let y = 0; y < rows; y++) {
    const at = y * (rowBytes + 1);
    if (at + rowBytes + 1 > data.length) break;
    const f = data[at]!;
    const row = Buffer.from(data.subarray(at + 1, at + 1 + rowBytes));
    for (let x = 0; x < rowBytes; x++) {
      const a = x >= bpp ? row[x - bpp]! : 0;
      const b = prev[x]!;
      const c = x >= bpp ? prev[x - bpp]! : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      row[x] = (row[x]! + (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? paeth : 0)) & 0xff;
    }
    row.copy(out, y * rowBytes);
    prev = row;
  }
  return out;
}

// ---------- the vision profile ----------

export const MAX_CAPTION = 2000;
export const MAX_IMAGE_TEXT = 50_000;

/** What the vision profile is asked for an image document. */
export const DESCRIBE_PROMPT =
  'You index images for search. Look at the image and answer with JSON only, in the form {"caption": "<one or two plain sentences saying what the image shows>", "text": "<every piece of text visible in the image, as written, in reading order; an empty string when there is none>"}. Do not add anything the image does not show.';

export interface ImageDescription {
  caption: string;
  text: string;
}

/** The vision profile's answer, validated: a JSON object with a caption and the recognised text (both strings). */
export function parseDescription(answer: string): ImageDescription {
  const m = /\{[\s\S]*\}/.exec(answer);
  let j: { caption?: unknown; text?: unknown; ocr?: unknown } = {};
  try {
    j = m ? (JSON.parse(m[0]) as typeof j) : {};
  } catch {
    j = {};
  }
  const text = j.text ?? j.ocr ?? '';
  if (typeof j.caption !== 'string' || !j.caption.trim() || typeof text !== 'string') throw new Error(`The vision profile did not answer with a caption and the image's text: "${answer.trim().slice(0, 80)}"`);
  return { caption: j.caption.trim().slice(0, MAX_CAPTION), text: text.trim().slice(0, MAX_IMAGE_TEXT) };
}

/** The indexed text of an image document: its caption, then the text read from it. */
export const indexedText = (name: string, d: ImageDescription): string => `# ${name}\n\n${d.caption}${d.text ? `\n\nText in the image:\n\n${d.text}` : ''}`;
