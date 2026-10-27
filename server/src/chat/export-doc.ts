import type { Transcript, TranscriptMessage } from './sharing.js';

/*
 * The document every rich chat export is drawn from (Word, OpenDocument, PDF, HTML, plain text and RTF): the same
 * transcript the Markdown export uses, read into headings, paragraphs of styled runs, list items, code blocks, tables
 * and pictures. Each format in `export-formats.ts` and `export-pdf.ts` only lays this out; none of them sees the
 * transcript or decides what is included.
 */

export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

export interface ImageBlock {
  kind: 'image';
  data: Buffer;
  type: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  alt: string;
}

export type Block =
  | { kind: 'heading'; level: 1 | 2 | 3 | 4; text: string }
  | { kind: 'para'; runs: Run[]; tone?: 'muted' | 'quote' }
  | { kind: 'item'; ordered: boolean; n: number; level: number; runs: Run[] }
  | { kind: 'code'; text: string; lang?: string }
  | {
      kind: 'table';
      header: Run[][] | null;
      rows: Run[][][];
      /** 1.8.0 (B-123), PDF only, all optional: relative column widths, right-aligned columns, shaded rows (by index in
       * `rows`), the header repeated on each page, a page break before the table, and the text size (9 pt). */
      widths?: number[];
      align?: ('left' | 'right')[];
      shade?: boolean[];
      repeatHeader?: boolean;
      breakBefore?: boolean;
      size?: number;
    }
  | ImageBlock
  | { kind: 'rule' };

export interface ExportDoc {
  title: string;
  /** The lines under the title: label, owner, participants, when and by whom it was exported. */
  meta: [string, string][];
  blocks: Block[];
  /** The tenant's label of the conversation, repeated in headers and footers. */
  label: string;
  /** For document properties. */
  author: string;
  createdAt: string;
}

/** A picture of a message: its bytes when the exporting user may read it, otherwise why it is left out. */
export interface ExportImage {
  alt: string;
  data?: Buffer;
  type?: 'image/png' | 'image/jpeg';
  width?: number;
  height?: number;
  missing?: string;
}

export const runsText = (runs: Run[]): string => runs.map((r) => r.text).join('');

/** A picture's size on the page, in points, at most `maxW` wide and `maxH` high, never enlarged past 1 px = 0.75 pt. */
export function fitImage(img: ImageBlock, maxW: number, maxH: number): { w: number; h: number } {
  let w = img.width * 0.75;
  let h = img.height * 0.75;
  const k = Math.min(1, maxW / w, maxH / h);
  w *= k;
  h *= k;
  return { w: Math.max(1, w), h: Math.max(1, h) };
}

// ---------- Markdown, read leniently ----------

const INLINE = /(`+)([^`]+?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\s][^*]*?)\*|(^|[^\w])_([^_\s][^_]*?)_(?!\w)|\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Inline Markdown: code spans, bold, italics and links (as "text (url)"). Anything else is literal text. */
export function inline(s: string): Run[] {
  const out: Run[] = [];
  const push = (r: Run) => {
    if (!r.text) return;
    const last = out[out.length - 1];
    if (last && !!last.bold === !!r.bold && !!last.italic === !!r.italic && !!last.code === !!r.code) last.text += r.text;
    else out.push(r);
  };
  let at = 0;
  INLINE.lastIndex = 0;
  for (let m = INLINE.exec(s); m; m = INLINE.exec(s)) {
    let start = m.index;
    if (m[6] !== undefined) start += m[6].length; // the character before an underscore italic is text
    push({ text: s.slice(at, start) });
    if (m[2] !== undefined) push({ text: m[2].replace(/^ (.*) $/, '$1'), code: true });
    else if (m[3] !== undefined || m[4] !== undefined) push({ text: (m[3] ?? m[4])!, bold: true });
    else if (m[5] !== undefined || m[7] !== undefined) push({ text: (m[5] ?? m[7])!, italic: true });
    else if (m[8] !== undefined) push({ text: m[8] === m[9] ? m[8] : `${m[8]} (${m[9]})` });
    at = INLINE.lastIndex;
  }
  push({ text: s.slice(at) });
  return out.length ? out : [{ text: '' }];
}

const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));

/** Block Markdown: fenced code, headings, lists, tables, quotes and rules; other lines are paragraphs. */
export function parseMarkdown(src: string, headingBase: 2 | 3 = 3): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let para: string[] = [];
  let quote: string[] = [];
  const flush = () => {
    if (para.length) out.push({ kind: 'para', runs: inline(para.join(' ')) });
    if (quote.length) out.push({ kind: 'para', runs: inline(quote.join(' ')), tone: 'quote' });
    para = [];
    quote = [];
  };
  const counters: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*(```+|~~~+)\s*([\w+#.-]*).*$/.exec(line);
    if (fence) {
      flush();
      const buf: string[] = [];
      const close = fence[1]!;
      for (i++; i < lines.length && !lines[i]!.trim().startsWith(close); i++) buf.push(lines[i]!);
      out.push({ kind: 'code', text: buf.join('\n'), ...(fence[2] ? { lang: fence[2] } : {}) });
      continue;
    }
    if (!line.trim()) {
      flush();
      counters.length = 0;
      continue;
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      const lv = Math.min(4, headingBase + h[1]!.length - 1) as 2 | 3 | 4;
      out.push({ kind: 'heading', level: lv, text: runsText(inline(h[2]!)) });
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      out.push({ kind: 'rule' });
      continue;
    }
    const li = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const level = Math.min(3, Math.floor(li[1]!.replace(/\t/g, '  ').length / 2));
      const ordered = /\d/.test(li[2]!);
      counters.length = level + 1;
      counters[level] = ordered ? (counters[level] ?? (parseInt(li[2]!, 10) || 1) - 1) + 1 : 0;
      out.push({ kind: 'item', ordered, n: counters[level]!, level, runs: inline(li[3]!) });
      continue;
    }
    const prev = out[out.length - 1];
    if (prev && prev.kind === 'item' && !para.length && !quote.length && /^\s+\S/.test(line)) {
      prev.runs = [...prev.runs, ...inline(` ${line.trim()}`)];
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
      flush();
      const header = cells(line).map(inline);
      const rows: Run[][][] = [];
      for (i += 2; i < lines.length && lines[i]!.includes('|') && lines[i]!.trim(); i++) rows.push(cells(lines[i]!).map(inline));
      i--;
      out.push({ kind: 'table', header, rows });
      continue;
    }
    const q = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (q) {
      if (para.length) flush();
      quote.push(q[1]!);
      continue;
    }
    if (quote.length) flush();
    para.push(line.trim());
  }
  flush();
  return out;
}

// ---------- pictures ----------

/** Width and height of a PNG or JPEG, or null when the bytes are neither. */
export function imageInfo(data: Buffer): { type: 'image/png' | 'image/jpeg'; width: number; height: number } | null {
  if (data.length > 24 && data.readUInt32BE(0) === 0x89504e47 && data.toString('latin1', 12, 16) === 'IHDR') return { type: 'image/png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let at = 2;
    while (at + 9 < data.length) {
      if (data[at] !== 0xff) return null;
      const marker = data[at + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += 2;
        continue;
      }
      const len = data.readUInt16BE(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { type: 'image/jpeg', height: data.readUInt16BE(at + 5), width: data.readUInt16BE(at + 7) };
      at += 2 + len;
    }
  }
  return null;
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** The picture views (the shape of GET /api/images/:id) inside a tool's result, a few levels down, each once. */
export function imageViewsIn(out: unknown): { id: string; prompt?: string; edit?: string }[] {
  const found: { id: string; prompt?: string; edit?: string }[] = [];
  const seen = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== 'object' || depth > 4) return;
    if (Array.isArray(v)) {
      v.slice(0, 20).forEach((x) => walk(x, depth + 1));
      return;
    }
    const o = v as Record<string, unknown>;
    if (typeof o.id === 'string' && ULID.test(o.id) && 'state' in o && 'width' in o && ('url' in o || 'batchId' in o)) {
      if (!seen.has(o.id)) {
        seen.add(o.id);
        found.push({ id: o.id, ...(typeof o.prompt === 'string' ? { prompt: o.prompt } : {}), ...(typeof o.edit === 'string' ? { edit: o.edit } : {}) });
      }
      return;
    }
    Object.values(o).forEach((x) => walk(x, depth + 1));
  };
  walk(out, 0);
  return found;
}

// ---------- the transcript as a document ----------

const SHOWN = new Set(['complete', 'stopped']);
const who = (m: TranscriptMessage) => (m.role === 'user' ? 'Question' : `Answer${m.profile ? ` (${m.profile}${m.model ? `, ${m.model}` : ''})` : ''}`);
const stamp = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');

function citationText(c: Record<string, unknown>): string {
  const parts = [c.kb ?? c.kind, c.document ?? c.source ?? c.memory, c.section].filter((x) => typeof x === 'string' && x);
  return `${parts.join(', ') || 'source'}${typeof c.label === 'string' ? ` [${c.label}]` : ''}`;
}

/** Tool results other than pictures, as one line each (as the Markdown export writes them). */
function toolLine(x: Record<string, unknown>): string {
  if (typeof x.expression === 'string') {
    const r = x.result as { decimal?: string } | undefined;
    return `${x.expression}${x.error ? `: ${String(x.error)}` : r?.decimal ? ` = ${r.decimal}` : ''}`;
  }
  return `${String(x.name ?? 'tool')}: ${JSON.stringify(x.result ?? x.output ?? x.error ?? null).slice(0, 2000)}`;
}

export function buildDoc(t: Transcript, o: { by: string; at: string; images: Map<string, ExportImage[]>; group?: { name: string } | null }): ExportDoc {
  const profiles = [...new Set(t.messages.filter((m) => m.role === 'assistant' && m.profile).map((m) => `${m.profile}${m.model ? ` (${m.model})` : ''}`))];
  const owner = t.owner.name ?? t.owner.id;
  const meta: [string, string][] = [
    ['Label', t.label],
    ['Owner', owner],
    ['Participants', [owner, ...profiles].join(', ')],
    ['Started', stamp(t.createdAt)],
    ['Exported', `${o.at.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')} by ${o.by}`],
    ['Conversation', t.id]
  ];
  if (o.group) meta.push(['Group', `${o.group.name} (${t.messages.length} message${t.messages.length === 1 ? '' : 's'})`]);
  const blocks: Block[] = [];
  for (const m of t.messages) {
    blocks.push({ kind: 'heading', level: 2, text: who(m) });
    blocks.push({ kind: 'para', runs: [{ text: `${m.role === 'user' ? owner : 'Assistant'}, ${stamp(m.createdAt)}` }], tone: 'muted' });
    if (m.role === 'assistant' && !SHOWN.has(m.state)) blocks.push({ kind: 'para', runs: [{ text: `Not included: the answer is ${m.state}.`, italic: true }], tone: 'muted' });
    else if (m.role === 'user' && !m.content && m.state !== 'complete') blocks.push({ kind: 'para', runs: [{ text: `Not included: the question is ${m.state}.`, italic: true }], tone: 'muted' });
    else blocks.push(...parseMarkdown(m.content));
    for (const img of o.images.get(m.id) ?? []) {
      if (img.data && img.type && img.width && img.height) blocks.push({ kind: 'image', data: img.data, type: img.type, width: img.width, height: img.height, alt: img.alt });
      else blocks.push({ kind: 'para', runs: [{ text: `[${img.alt}: ${img.missing ?? 'not included'}]`, italic: true }], tone: 'muted' });
    }
    const tools = m.tools.filter((x) => !imageViewsIn(x.output ?? x.result).length);
    if (tools.length) {
      blocks.push({ kind: 'para', runs: [{ text: 'Tools', bold: true }] });
      tools.forEach((x, i) => blocks.push({ kind: 'item', ordered: false, n: i + 1, level: 0, runs: [{ text: toolLine(x), code: true }] }));
    }
    if (m.citations.length) {
      blocks.push({ kind: 'para', runs: [{ text: 'Sources', bold: true }] });
      m.citations.forEach((c, i) => blocks.push({ kind: 'item', ordered: true, n: Number(c.n) || i + 1, level: 0, runs: [{ text: citationText(c) }] }));
    }
  }
  if (!t.messages.length) blocks.push({ kind: 'para', runs: [{ text: 'No messages.', italic: true }], tone: 'muted' });
  return { title: t.title ?? 'Conversation', meta, blocks, label: t.label, author: o.by, createdAt: o.at };
}
