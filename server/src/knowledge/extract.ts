import { inflateRawSync, inflateSync } from 'node:zlib';
import { imageType } from './images.js';

/**
 * Text extraction for knowledge documents, with no external tools: plain text, Markdown, CSV and JSON as they are;
 * HTML with scripts and styles dropped and headings kept as Markdown; DOCX from its document part; and the text
 * layer of PDFs (Flate-compressed or plain content streams, literal and hex strings). Scanned PDFs (images only),
 * PDFs with custom font encodings and encrypted PDFs are reported, not guessed at. Headings are kept as Markdown so
 * chunking can follow the structure.
 */
export class ExtractionError extends Error {}

export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const TEXT_TYPES = ['text/plain', 'text/markdown', 'text/csv', 'application/json', 'text/html'];
/** Sprint 36c (B-8801): images are documents too, described by the knowledge base's vision profile. */
export const ACCEPTED = [...TEXT_TYPES, 'application/pdf', DOCX, 'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/heic'];

/** File name extensions a Git or S3 source picks up. */
export const INDEXABLE_EXT = /\.(md|markdown|txt|text|rst|csv|json|html?|pdf|docx)$/i;

const MAX_INFLATE = 64 * 1024 * 1024;

/** Detects the media type from the bytes (and, for text, the name). */
export function detectType(buf: Buffer, name: string): { type: string } | { rejected: string } {
  const image = imageType(buf);
  if (image) return { type: image };
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return { type: 'application/pdf' };
  if (buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    try {
      if (zipEntries(buf).has('word/document.xml')) return { type: DOCX };
    } catch {
      // not a readable zip
    }
    return { rejected: 'A zip archive that is not a Word document. Accepted: text, Markdown, CSV, JSON, HTML, PDF, DOCX and images (PNG, JPEG, WebP, GIF, HEIC).' };
  }
  if (buf.includes(0)) return { rejected: 'Binary content of a type that is not accepted (text, Markdown, CSV, JSON, HTML, PDF, DOCX, PNG, JPEG, WebP, GIF, HEIC).' };
  const text = buf.toString('utf8');
  if (text.includes('�')) return { rejected: 'The text is not valid UTF-8.' };
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'json') {
    try {
      JSON.parse(text);
      return { type: 'application/json' };
    } catch {
      return { rejected: 'The file is named .json but is not valid JSON.' };
    }
  }
  if (ext === 'html' || ext === 'htm' || /^\s*(<!doctype html|<html[\s>])/i.test(text)) return { type: 'text/html' };
  return { type: ext === 'md' || ext === 'markdown' ? 'text/markdown' : ext === 'csv' ? 'text/csv' : 'text/plain' };
}

export function extractText(buf: Buffer, type: string): string {
  switch (type) {
    case 'application/pdf':
      return pdfText(buf);
    case DOCX:
      return docxText(buf);
    case 'text/html':
      return htmlText(buf.toString('utf8'));
    default:
      return buf.toString('utf8').replace(/^\uFEFF/, '');
  }
}

// ---------- HTML and XML ----------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©', reg: '®', euro: '€' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlText(html: string): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, n: string, inner: string) => `\n\n${'#'.repeat(Number(n))} ${inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}\n\n`);
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<(br|hr)\b[^>]*>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|li|tr|table|ul|ol|blockquote|pre|header|footer|dd|dt)\s*>/gi, '\n\n');
  s = s.replace(/<\/t[dh]\s*>/gi, '\t');
  s = s.replace(/<[^>]+>/g, ' ');
  return tidy(decodeEntities(s));
}

const tidy = (s: string) =>
  s
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

// ---------- ZIP and DOCX ----------

/** The entries of a zip archive (stored or deflated), read from its central directory. */
export function zipEntries(buf: Buffer): Map<string, () => Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ExtractionError('The archive has no central directory.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, () => Buffer>();
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ExtractionError('The archive directory is damaged.');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    out.set(name, () => {
      if (flags & 1) throw new ExtractionError('The document is password protected.');
      if (buf.readUInt32LE(local) !== 0x04034b50) throw new ExtractionError('The archive entry is damaged.');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data, { maxOutputLength: MAX_INFLATE });
      throw new ExtractionError(`The archive uses compression method ${method}, which is not supported.`);
    });
  }
  return out;
}

export function docxText(buf: Buffer): string {
  let entries;
  try {
    entries = zipEntries(buf);
  } catch (err) {
    throw err instanceof ExtractionError ? err : new ExtractionError('The Word document could not be read.');
  }
  const doc = entries.get('word/document.xml');
  if (!doc) throw new ExtractionError('The Word document has no body.');
  const xml = doc().toString('utf8');
  const paras: string[] = [];
  for (const m of xml.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>|<w:p\/>/g)) {
    const p = m[0];
    const style = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] ?? '';
    const level = /^(?:Heading|heading)\s?(\d)$/.exec(style)?.[1] ?? (style === 'Title' ? '1' : null);
    let text = '';
    for (const r of p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)) text += r[1] !== undefined ? decodeEntities(r[1]) : r[0] === '<w:tab/>' ? '\t' : '\n';
    if (!text.trim()) {
      paras.push('');
      continue;
    }
    paras.push(level ? `${'#'.repeat(Number(level))} ${text.trim()}` : text);
  }
  const out = tidy(paras.join('\n\n'));
  if (!out) throw new ExtractionError('The Word document has no text.');
  return out;
}

// ---------- PDF ----------

/** Reads a PDF literal string starting after `(`; returns the bytes and the index after the closing `)`. */
function pdfLiteral(s: string, i: number): [string, number] {
  let depth = 1;
  let out = '';
  for (; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\') {
      const n = s[++i] ?? '';
      if (n === 'n') out += '\n';
      else if (n === 'r') out += '\r';
      else if (n === 't') out += '\t';
      else if (n === 'b' || n === 'f') out += ' ';
      else if (/[0-7]/.test(n)) {
        let oct = n;
        while (oct.length < 3 && /[0-7]/.test(s[i + 1] ?? '')) oct += s[++i];
        out += String.fromCharCode(parseInt(oct, 8));
      } else if (n === '\r' || n === '\n') {
        if (n === '\r' && s[i + 1] === '\n') i++;
      } else out += n;
    } else if (c === '(') {
      depth++;
      out += c;
    } else if (c === ')') {
      if (--depth === 0) return [out, i + 1];
      out += c;
    } else out += c;
  }
  return [out, i];
}

/** PDF string bytes as text: UTF-16BE with a byte-order mark, otherwise Latin-1 (PDFDocEncoding is close enough). */
function pdfDecode(bytes: string): string {
  if (bytes.charCodeAt(0) === 0xfe && bytes.charCodeAt(1) === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1));
    return out;
  }
  return bytes;
}

const hexBytes = (h: string) => {
  const clean = h.replace(/[^0-9a-f]/gi, '');
  let out = '';
  for (let i = 0; i < clean.length; i += 2) out += String.fromCharCode(parseInt(clean.slice(i, i + 2).padEnd(2, '0'), 16));
  return out;
};

/** The text shown by one content stream: Tj, TJ, ' and " operators, with line breaks from moves and text blocks. */
export function contentStreamText(s: string): string {
  let out = '';
  const operands: (string | number | (string | number)[])[] = [];
  let i = 0;
  const readArray = (): (string | number)[] => {
    const arr: (string | number)[] = [];
    i++;
    while (i < s.length && s[i] !== ']') {
      const c = s[i]!;
      if (c === '(') {
        const [str, next] = pdfLiteral(s, i + 1);
        arr.push(pdfDecode(str));
        i = next;
      } else if (c === '<') {
        const end = s.indexOf('>', i);
        arr.push(pdfDecode(hexBytes(s.slice(i + 1, end < 0 ? s.length : end))));
        i = end < 0 ? s.length : end + 1;
      } else if (/[-+.\d]/.test(c)) {
        const m = /^[-+]?\d*\.?\d+/.exec(s.slice(i, i + 32));
        arr.push(m ? Number(m[0]) : 0);
        i += m ? m[0].length : 1;
      } else i++;
    }
    i++;
    return arr;
  };
  while (i < s.length) {
    const c = s[i]!;
    if (c === '%') {
      while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++;
    } else if (c === '(') {
      const [str, next] = pdfLiteral(s, i + 1);
      operands.push(pdfDecode(str));
      i = next;
    } else if (c === '<' && s[i + 1] === '<') {
      const end = s.indexOf('>>', i);
      i = end < 0 ? s.length : end + 2;
    } else if (c === '<') {
      const end = s.indexOf('>', i);
      operands.push(pdfDecode(hexBytes(s.slice(i + 1, end < 0 ? s.length : end))));
      i = end < 0 ? s.length : end + 1;
    } else if (c === '[') {
      operands.push(readArray());
    } else if (/[-+.\d]/.test(c)) {
      const m = /^[-+]?\d*\.?\d+/.exec(s.slice(i, i + 32));
      operands.push(m ? Number(m[0]) : 0);
      i += m ? m[0].length : 1;
    } else if (/[A-Za-z'"*]/.test(c)) {
      const m = /^[A-Za-z'"*]+\d?/.exec(s.slice(i, i + 8))!;
      const op = m[0];
      i += op.length;
      if (op === 'Tj' || op === "'" || op === '"') {
        if (op !== 'Tj') out += '\n';
        const str = operands[operands.length - 1];
        if (typeof str === 'string') out += str;
      } else if (op === 'TJ') {
        const arr = operands[operands.length - 1];
        if (Array.isArray(arr)) for (const x of arr) out += typeof x === 'string' ? x : x < -200 ? ' ' : '';
      } else if (op === 'T*') out += '\n';
      else if (op === 'Td' || op === 'TD') {
        const y = operands[operands.length - 1];
        if (typeof y === 'number' && y !== 0) out += '\n';
        else out += ' ';
      } else if (op === 'ET') out += '\n';
      else if (op === 'BI') {
        const end = s.indexOf('EI', i);
        i = end < 0 ? s.length : end + 2;
      }
      operands.length = 0;
    } else if (c === '/') {
      const m = /^\/[^\s/<>[\]()%{}]*/.exec(s.slice(i, i + 128))!;
      i += m[0].length;
    } else i++;
  }
  return out;
}

export function pdfText(buf: Buffer): string {
  const raw = buf.toString('latin1');
  if (/\/Encrypt\s/.test(raw)) throw new ExtractionError('The PDF is password protected, so its text could not be extracted. Upload an unlocked copy, or remove the password and retry.');
  const parts: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    const dictStart = raw.lastIndexOf('<<', m.index);
    const dict = dictStart >= 0 ? raw.slice(dictStart, m.index) : '';
    re.lastIndex = end + 9;
    if (/\/Subtype\s*\/Image|\/DCTDecode|\/JPXDecode|\/CCITTFax|\/Type\s*\/XRef|\/Type\s*\/ObjStm|\/Length1/.test(dict)) continue;
    let data = buf.subarray(start, end);
    if (/\/FlateDecode/.test(dict)) {
      try {
        data = inflateSync(data, { maxOutputLength: MAX_INFLATE });
      } catch {
        try {
          data = inflateSync(data.subarray(0, data.length - 1), { maxOutputLength: MAX_INFLATE });
        } catch {
          continue;
        }
      }
    } else if (/\/Filter/.test(dict)) continue;
    const text = data.toString('latin1');
    if (!/\bBT\b/.test(text)) continue;
    parts.push(contentStreamText(text));
  }
  // eslint-disable-next-line no-control-regex
  const out = tidy(parts.join('\n\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''));
  if (!out) throw new ExtractionError('No text layer was found in the PDF. It may be a scan; text recognition is not available.');
  return out;
}
