import { deflateSync, inflateSync } from 'node:zlib';
import type { Block, ExportDoc, ImageBlock, Run } from './export-doc.js';
import { fitImage } from './export-doc.js';

/*
 * A small PDF 1.4 writer for the chat export: A4 pages, the standard 14 fonts (Helvetica and Courier, so nothing is
 * embedded), WinAnsi encoding with a "?" for any character it cannot encode, word wrap, pagination with a footer on
 * every page, code blocks on a tinted background, ruled tables, and PNG or JPEG pictures as image XObjects (JPEG as
 * is; PNG through the Flate predictor, or decoded when it has an alpha channel, which becomes a soft mask).
 */

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 56;
const BOTTOM = MARGIN + 18; // room for the footer
const CONTENT_W = PAGE_W - 2 * MARGIN;

type FontKey = 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6';
const FONTS: Record<FontKey, string> = { F1: 'Helvetica', F2: 'Helvetica-Bold', F3: 'Helvetica-Oblique', F4: 'Helvetica-BoldOblique', F5: 'Courier', F6: 'Courier-Bold' };

// Advance widths (per 1000 units) of the printable ASCII characters 32..126, from the Adobe core font metrics.
// prettier-ignore
const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
// prettier-ignore
const HELV_B = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

// WinAnsi (Windows-1252) bytes 0x80..0x9F for the Unicode characters they stand for.
const CP1252: Record<number, number> = { 0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f };
const FOLD: Record<number, string> = { 0x2212: '-', 0x2010: '-', 0x2011: '-', 0x00a0: ' ', 0x2009: ' ', 0x202f: ' ', 0x2192: '->', 0x2190: '<-', 0x2264: '<=', 0x2265: '>=', 0x2260: '!=', 0x00d7: 'x', 0x25aa: '-', 0x25e6: '-', 0x2713: 'v', 0x2714: 'v' };

/** A string as WinAnsi bytes; what WinAnsi cannot hold becomes "?" (a few common symbols are spelt out). */
export function winAnsi(s: string): Buffer {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 0x09) out.push(32, 32, 32, 32);
    else if (c >= 0x20 && c <= 0x7e) out.push(c);
    else if (c >= 0xa0 && c <= 0xff && c !== 0xa0) out.push(c);
    else if (CP1252[c] !== undefined) out.push(CP1252[c]!);
    else if (FOLD[c] !== undefined) for (const x of FOLD[c]!) out.push(x.charCodeAt(0));
    else if (c >= 0x20) out.push(0x3f);
  }
  return Buffer.from(out);
}

function widthOf(bytes: Buffer, font: FontKey, size: number): number {
  if (font === 'F5' || font === 'F6') return bytes.length * 0.6 * size;
  const table = font === 'F2' || font === 'F4' ? HELV_B : HELV;
  let w = 0;
  for (const b of bytes) w += b >= 32 && b <= 126 ? table[b - 32]! : 556;
  return (w / 1000) * size;
}

/** A PDF literal string of WinAnsi bytes. */
function lit(bytes: Buffer): string {
  let s = '(';
  for (const b of bytes) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) s += `\\${String.fromCharCode(b)}`;
    else if (b < 32 || b > 126) s += `\\${b.toString(8).padStart(3, '0')}`;
    else s += String.fromCharCode(b);
  }
  return `${s})`;
}

const n2 = (v: number) => (Math.round(v * 100) / 100).toString();

interface Seg {
  bytes: Buffer;
  font: FontKey;
  w: number;
}

const fontFor = (r: Run): FontKey => (r.code ? (r.bold ? 'F6' : 'F5') : r.bold && r.italic ? 'F4' : r.bold ? 'F2' : r.italic ? 'F3' : 'F1');

/** Styled runs wrapped into lines of at most `maxW` points. */
function wrap(runs: Run[], size: number, maxW: number, force?: FontKey): Seg[][] {
  const lines: Seg[][] = [[]];
  let lineW = 0;
  const add = (bytes: Buffer, font: FontKey) => {
    const line = lines[lines.length - 1]!;
    const w = widthOf(bytes, font, size);
    const last = line[line.length - 1];
    if (last && last.font === font) {
      last.bytes = Buffer.concat([last.bytes, bytes]);
      last.w += w;
    } else line.push({ bytes, font, w });
    lineW += w;
  };
  const newline = () => {
    const line = lines[lines.length - 1]!;
    const last = line[line.length - 1];
    if (last && last.bytes[last.bytes.length - 1] === 32) {
      last.bytes = last.bytes.subarray(0, last.bytes.length - 1);
      last.w -= widthOf(Buffer.from(' '), last.font, size);
    }
    lines.push([]);
    lineW = 0;
  };
  for (const r of runs) {
    const font = force ?? fontFor(r);
    for (const part of r.text.split('\n').flatMap((p, i) => (i ? ['\n', p] : [p]))) {
      if (part === '\n') {
        newline();
        continue;
      }
      for (const tok of part.split(/(\s+)/)) {
        if (!tok) continue;
        if (/^\s+$/.test(tok)) {
          if (lineW > 0) add(Buffer.from(' '), font);
          continue;
        }
        let bytes = winAnsi(tok);
        let w = widthOf(bytes, font, size);
        if (lineW > 0 && lineW + w > maxW) newline();
        // A word longer than the line is broken where it must be.
        while (w > maxW && bytes.length > 1) {
          let cut = bytes.length - 1;
          while (cut > 1 && widthOf(bytes.subarray(0, cut), font, size) > maxW - lineW) cut--;
          add(bytes.subarray(0, cut), font);
          newline();
          bytes = bytes.subarray(cut);
          w = widthOf(bytes, font, size);
        }
        add(bytes, font);
      }
    }
  }
  return lines.filter((l, i) => l.length || i < lines.length - 1).map((l) => l);
}

// ---------- pictures ----------

interface PdfImage {
  dict: string;
  data: Buffer;
  smask?: { dict: string; data: Buffer };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Reverses the PNG scanline filters of 8-bit data with `bpp` bytes per pixel. */
function unfilter(raw: Buffer, width: number, height: number, bpp: number): Buffer {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let at = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[at++]!;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[at++]!;
      const a = x >= bpp ? out[row + x - bpp]! : 0;
      const b = y ? out[row - stride + x]! : 0;
      const c = x >= bpp && y ? out[row - stride + x - bpp]! : 0;
      out[row + x] = (v + (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? paeth(a, b, c) : 0)) & 0xff;
    }
  }
  return out;
}

function pngImage(data: Buffer): PdfImage | null {
  let at = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  const idat: Buffer[] = [];
  while (at + 8 <= data.length) {
    const len = data.readUInt32BE(at);
    const name = data.toString('latin1', at + 4, at + 8);
    const body = data.subarray(at + 8, at + 8 + len);
    if (name === 'IHDR') {
      w = body.readUInt32BE(0);
      h = body.readUInt32BE(4);
      depth = body[8]!;
      type = body[9]!;
      interlace = body[12]!;
    } else if (name === 'PLTE') palette = Buffer.from(body);
    else if (name === 'IDAT') idat.push(body);
    else if (name === 'IEND') break;
    at += 12 + len;
  }
  if (!w || !h || interlace || !idat.length) return null;
  const stream = Buffer.concat(idat);
  if (type === 0 || type === 2 || type === 3) {
    if (type !== 3 && depth !== 8) return null;
    if (type === 3 && (!palette || ![1, 2, 4, 8].includes(depth))) return null;
    const colors = type === 2 ? 3 : 1;
    const cs = type === 0 ? '/DeviceGray' : type === 2 ? '/DeviceRGB' : `[/Indexed /DeviceRGB ${palette!.length / 3 - 1} <${palette!.toString('hex')}>]`;
    return { dict: `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace ${cs} /BitsPerComponent ${depth} /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors ${colors} /BitsPerComponent ${depth} /Columns ${w} >>`, data: stream };
  }
  if ((type === 4 || type === 6) && depth === 8) {
    const channels = type === 6 ? 4 : 2;
    const px = unfilter(inflateSync(stream), w, h, channels);
    const colors = channels - 1;
    const color = Buffer.alloc(w * h * colors);
    const alpha = Buffer.alloc(w * h);
    for (let i = 0, j = 0, k = 0; i < px.length; i += channels) {
      for (let c = 0; c < colors; c++) color[j++] = px[i + c]!;
      alpha[k++] = px[i + colors]!;
    }
    return {
      dict: `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace ${colors === 3 ? '/DeviceRGB' : '/DeviceGray'} /BitsPerComponent 8 /Filter /FlateDecode`,
      data: deflateSync(color),
      smask: { dict: `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`, data: deflateSync(alpha) }
    };
  }
  return null;
}

function jpegImage(data: Buffer, b: ImageBlock): PdfImage | null {
  let at = 2;
  let comps = 3;
  while (at + 9 < data.length && data[at] === 0xff) {
    const m = data[at + 1]!;
    if (m >= 0xd0 && m <= 0xd9) {
      at += 2;
      continue;
    }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      comps = data[at + 9]!;
      break;
    }
    at += 2 + data.readUInt16BE(at + 2);
  }
  const cs = comps === 1 ? '/DeviceGray' : comps === 4 ? '/DeviceCMYK /Decode [1 0 1 0 1 0 1 0]' : '/DeviceRGB';
  return { dict: `/Type /XObject /Subtype /Image /Width ${b.width} /Height ${b.height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode`, data };
}

// ---------- layout ----------

/**
 * 1.8.0 (B-123): the page a document is laid out on; A4 portrait when left out (as every chat export is). The app
 * exports' reports choose A4 or US Letter, portrait or landscape.
 */
export interface PdfPageSetup {
  size?: 'a4' | 'letter';
  orientation?: 'portrait' | 'landscape';
}

/**
 * 1.8.0 (B-121): a vector drawing (a dashboard's chart), PDF only: path operators with the origin at the drawing's
 * bottom left, in points, and its text, kept on one page and followed by its alternative text.
 */
export interface PdfDrawingBlock {
  kind: 'drawing';
  width: number;
  height: number;
  ops: string;
  texts: { x: number; y: number; text: string; size: number; anchor: 'start' | 'middle' | 'end'; gray: number; bold?: boolean }[];
  alt: string;
}
export type PdfBlock = Block | PdfDrawingBlock;
export type PdfDoc = Omit<ExportDoc, 'blocks'> & { blocks: PdfBlock[] };

function pageSize(setup?: PdfPageSetup): { w: number; h: number } {
  const [w, h] = setup?.size === 'letter' ? [612, 792] : [PAGE_W, PAGE_H];
  return setup?.orientation === 'landscape' ? { w: h, h: w } : { w, h };
}

class Layout {
  pages: string[][] = [];
  y = 0;
  images: PdfImage[] = [];
  readonly pw: number;
  readonly ph: number;
  readonly cw: number;

  constructor(setup?: PdfPageSetup) {
    const { w, h } = pageSize(setup);
    this.pw = w;
    this.ph = h;
    this.cw = setup ? w - 2 * MARGIN : CONTENT_W;
    this.newPage();
  }

  get ops(): string[] {
    return this.pages[this.pages.length - 1]!;
  }

  newPage(): void {
    this.pages.push([]);
    this.y = this.ph - MARGIN;
  }

  ensure(h: number): void {
    if (this.y - h < BOTTOM && this.y < this.ph - MARGIN) this.newPage();
  }

  text(x: number, y: number, segs: Seg[], size: number, gray = 0): void {
    let cx = x;
    const parts: string[] = [];
    for (const s of segs) {
      if (s.bytes.length) parts.push(`/${s.font} ${n2(size)} Tf 1 0 0 1 ${n2(cx)} ${n2(y)} Tm ${lit(s.bytes)} Tj`);
      cx += s.w;
    }
    if (parts.length) this.ops.push(`BT ${gray ? `${gray} g ` : ''}${parts.join(' ')} ET${gray ? ' 0 g' : ''}`);
  }

  /** Wrapped runs, line by line, breaking pages as they fill. */
  lines(runs: Run[], o: { size: number; x?: number; width?: number; lead?: number; gray?: number; force?: FontKey; bar?: boolean }): void {
    const x = o.x ?? MARGIN;
    const lead = o.lead ?? o.size * 1.4;
    for (const line of wrap(runs, o.size, o.width ?? this.cw - (x - MARGIN), o.force)) {
      this.ensure(lead);
      this.y -= lead;
      if (o.bar) this.ops.push(`0.18 0.36 0.83 rg ${n2(x - 10)} ${n2(this.y - lead * 0.3)} 2 ${n2(lead)} re f 0 g`);
      this.text(x, this.y, line, o.size, o.gray);
    }
  }

  block(b: PdfBlock): void {
    switch (b.kind) {
      case 'drawing': {
        const w = Math.min(b.width, this.cw);
        const k = w / b.width;
        const h = b.height * k;
        this.ensure(h + 8);
        this.y -= h + 4;
        this.ops.push(`q ${n2(k)} 0 0 ${n2(k)} ${n2(MARGIN)} ${n2(this.y)} cm ${b.ops} Q`);
        for (const t of b.texts) {
          const font: FontKey = t.bold ? 'F2' : 'F1';
          const bytes = winAnsi(t.text);
          const tw = widthOf(bytes, font, t.size * k);
          const tx = MARGIN + t.x * k - (t.anchor === 'middle' ? tw / 2 : t.anchor === 'end' ? tw : 0);
          this.text(tx, this.y + t.y * k, [{ bytes, font, w: tw }], t.size * k, t.gray);
        }
        this.lines([{ text: b.alt }], { size: 8.5, gray: 0.37 });
        this.y -= 6;
        break;
      }
      case 'heading': {
        const size = [0, 20, 14, 12, 11][b.level]!;
        this.ensure(size * 3.2);
        this.y -= b.level <= 2 ? size * 0.9 : size * 0.6;
        if (b.level === 2) {
          this.ops.push(`0.82 G 0.6 w ${n2(MARGIN)} ${n2(this.y)} m ${n2(this.pw - MARGIN)} ${n2(this.y)} l S 0 G`);
          this.y -= 4;
        }
        this.lines([{ text: b.text, bold: true }], { size, lead: size * 1.3 });
        this.y -= 3;
        break;
      }
      case 'para':
        if (b.tone === 'quote') this.lines(b.runs.map((r) => ({ ...r, italic: true })), { size: 10.5, x: MARGIN + 14, bar: true });
        else if (b.tone === 'muted') this.lines(b.runs, { size: 8.5, gray: 0.37 });
        else this.lines(b.runs, { size: 10.5 });
        this.y -= 5;
        break;
      case 'item': {
        const x = MARGIN + 18 + b.level * 16;
        const lead = 10.5 * 1.4;
        this.ensure(lead);
        const mark = b.ordered ? `${b.n}.` : b.level ? '-' : '•';
        const bytes = winAnsi(mark);
        this.text(x - 4 - widthOf(bytes, 'F1', 10.5), this.y - lead, [{ bytes, font: 'F1', w: 0 }], 10.5);
        this.lines(b.runs, { size: 10.5, x });
        this.y -= 2;
        break;
      }
      case 'code': {
        const size = 8.5;
        const lead = size * 1.35;
        const max = Math.max(10, Math.floor((this.cw - 12) / (0.6 * size)));
        const rows: string[] = [];
        for (const l of b.text.replace(/\t/g, '    ').split('\n')) for (let i = 0; i === 0 || i < l.length; i += max) rows.push(l.slice(i, i + max));
        this.y -= 2;
        for (const r of rows) {
          this.ensure(lead);
          this.ops.push(`0.955 g ${n2(MARGIN)} ${n2(this.y - lead)} ${n2(this.cw)} ${n2(lead)} re f 0 g`);
          this.y -= lead;
          const bytes = winAnsi(r);
          this.text(MARGIN + 6, this.y + lead * 0.25, [{ bytes, font: 'F5', w: 0 }], size);
        }
        this.y -= 8;
        break;
      }
      case 'table': {
        // 1.8.0 (B-123): optional column widths, right-aligned columns, shaded rows, the header repeated on every
        // page the table runs onto, and a page break before the table; without them, as before.
        if (b.breakBefore && this.y < this.ph - MARGIN) this.newPage();
        const size = b.size ?? 9;
        const lead = size * 1.35;
        const rows = [...(b.header ? [b.header] : []), ...b.rows];
        const n = Math.max(1, ...rows.map((r) => r.length));
        const weights = b.widths && b.widths.length === n && b.widths.every((x) => x > 0) ? b.widths : null;
        const total = weights ? weights.reduce((a, x) => a + x, 0) : n;
        const ws = Array.from({ length: n }, (_, i) => (this.cw * (weights ? weights[i]! : 1)) / total);
        const xs = ws.map((_, i) => MARGIN + ws.slice(0, i).reduce((a, x) => a + x, 0));
        const usable = this.ph - MARGIN - BOTTOM - 8;
        this.y -= 4;
        const drawRow = (r: Run[][], head: boolean, shade: boolean) => {
          let cells = Array.from({ length: n }, (_, i) => wrap((r[i] ?? [{ text: '' }]).map((x) => (head ? { ...x, bold: true } : x)), size, ws[i]! - 8));
          const maxLines = Math.floor((usable - 6) / lead);
          cells = cells.map((c) => c.slice(0, maxLines));
          const h = Math.max(...cells.map((c) => c.length)) * lead + 6;
          const page = this.pages.length;
          this.ensure(h);
          if (b.repeatHeader && b.header && !head && this.pages.length !== page) drawRow(b.header, true, false);
          const top = this.y;
          if (head || shade) this.ops.push(`${head ? '0.955' : '0.975'} g ${n2(MARGIN)} ${n2(top - h)} ${n2(this.cw)} ${n2(h)} re f 0 g`);
          this.ops.push(`0.75 G 0.5 w ${cells.map((_, i) => `${n2(xs[i]!)} ${n2(top - h)} ${n2(ws[i]!)} ${n2(h)} re`).join(' ')} S 0 G`);
          cells.forEach((c, i) =>
            c.forEach((line, li) => {
              const right = !head && b.align?.[i] === 'right';
              const lw = right ? line.reduce((a, sg) => a + sg.w, 0) : 0;
              this.text(right ? xs[i]! + ws[i]! - 4 - lw : xs[i]! + 4, top - 3 - (li + 1) * lead + lead * 0.25, line, size);
            })
          );
          this.y = top - h;
        };
        rows.forEach((r, ri) => {
          const head = ri === 0 && !!b.header;
          drawRow(r, head, !head && !!b.shade?.[ri - (b.header ? 1 : 0)]);
        });
        this.y -= 10;
        break;
      }
      case 'image': {
        const img = b.type === 'image/png' ? pngImage(b.data) : jpegImage(b.data, b);
        if (!img) {
          this.lines([{ text: `[Picture: ${b.alt}]`, italic: true }], { size: 8.5, gray: 0.37 });
          break;
        }
        const { w, h } = fitImage(b, this.cw, this.ph - MARGIN - BOTTOM - 40);
        this.ensure(h + 6);
        this.images.push(img);
        this.y -= h + 4;
        this.ops.push(`q ${n2(w)} 0 0 ${n2(h)} ${n2(MARGIN)} ${n2(this.y)} cm /Im${this.images.length} Do Q`);
        this.lines([{ text: b.alt }], { size: 8.5, gray: 0.37 });
        this.y -= 6;
        break;
      }
      case 'rule':
        this.ensure(12);
        this.y -= 6;
        this.ops.push(`0.75 G 0.5 w ${n2(MARGIN)} ${n2(this.y)} m ${n2(this.pw - MARGIN)} ${n2(this.y)} l S 0 G`);
        this.y -= 6;
        break;
    }
  }
}

/** A PDF text string for the document information dictionary: UTF-16BE with a byte order mark, in hex. */
function infoString(s: string): string {
  const b = Buffer.from(s, 'utf16le');
  for (let i = 0; i + 1 < b.length; i += 2) {
    const t = b[i]!;
    b[i] = b[i + 1]!;
    b[i + 1] = t;
  }
  return `<FEFF${b.toString('hex').toUpperCase()}>`;
}

export function toPdf(doc: ExportDoc | PdfDoc, setup?: PdfPageSetup): Buffer {
  const L = new Layout(setup);
  L.lines([{ text: doc.title, bold: true }], { size: 20, lead: 25 });
  L.y -= 6;
  for (const [k, v] of doc.meta) L.lines([{ text: `${k}: `, bold: true }, { text: v }], { size: 9, lead: 12.5 });
  L.y -= 8;
  for (const b of doc.blocks) L.block(b);

  // Objects: 1 catalog, 2 pages, 3 info, 4..9 fonts, then images (and soft masks), then each page and its content.
  const objs: (string | Buffer)[] = [];
  const add = (o: string | Buffer) => objs.push(o) as number;
  add('');
  add('');
  const at = new Date(doc.createdAt);
  const pdfDate = `D:${at.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;
  add(`<< /Title ${infoString(doc.title)} /Author ${infoString(doc.author)} /Subject ${infoString(`Label: ${doc.label}`)} /Producer (Exprsn-AI) /CreationDate (${pdfDate}) >>`);
  const fontIds: Record<string, number> = {};
  for (const [k, name] of Object.entries(FONTS)) fontIds[k] = add(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`);
  const stream = (dict: string, data: Buffer) => Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]);
  const imageIds = L.images.map((img) => {
    const sm = img.smask ? add(stream(img.smask.dict, img.smask.data)) : null;
    return add(stream(`${img.dict}${sm ? ` /SMask ${sm} 0 R` : ''}`, img.data));
  });
  const resources = `<< /Font << ${Object.entries(fontIds)
    .map(([k, id]) => `/${k} ${id} 0 R`)
    .join(' ')} >>${imageIds.length ? ` /XObject << ${imageIds.map((id, i) => `/Im${i + 1} ${id} 0 R`).join(' ')} >>` : ''} >>`;
  const total = L.pages.length;
  const footTitle = winAnsi(doc.title.length > 70 ? `${doc.title.slice(0, 69)}…` : doc.title);
  const pageIds: number[] = [];
  L.pages.forEach((ops, i) => {
    const foot = winAnsi(`${doc.label}  ·  Page ${i + 1} of ${total}`);
    const footer = `BT 0.45 g /F1 8 Tf 1 0 0 1 ${n2(MARGIN)} 32 Tm ${lit(footTitle)} Tj 1 0 0 1 ${n2(L.pw - MARGIN - widthOf(foot, 'F1', 8))} 32 Tm ${lit(foot)} Tj ET 0 g`;
    const content = deflateSync(Buffer.from([...ops, footer].join('\n'), 'latin1'));
    const cid = add(stream('/Filter /FlateDecode', content));
    pageIds.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${L.pw} ${L.ph}] /Resources ${resources} /Contents ${cid} 0 R >>`));
  });
  objs[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let offset = parts[0]!.length;
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(offset);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), Buffer.isBuffer(o) ? o : Buffer.from(o, 'latin1'), Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(b);
    offset += b.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${offset}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}
