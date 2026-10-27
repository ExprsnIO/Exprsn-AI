import { DOC_LIMITS, DocumentError, safeHref, type Block, type ListItem, type RichDoc, type Run } from './model.js';

/*
 * Markdown to and from the RichDoc model: the CommonMark and GFM subset a document editor needs (headings, paragraphs,
 * emphasis, strike, code, links, lists with tasks, quotes, code blocks, pipe tables, thematic breaks). Emphasis follows
 * CommonMark's delimiter-run rules, so what `docToMarkdown` writes reads back the same. HTML is never markup here: it
 * stays text. Underline has no Markdown form and is dropped on write; a table without a header row gets one.
 */

type Marks = Omit<Run, 'text'>;
const MARK_KEYS = ['b', 'i', 'u', 's', 'code'] as const;

const sameMarks = (a: Marks, b: Marks) => MARK_KEYS.every((k) => !!a[k] === !!b[k]) && (a.href ?? '') === (b.href ?? '');

function run(text: string, m: Marks): Run {
  const r: Run = { text };
  for (const k of MARK_KEYS) if (m[k]) r[k] = true;
  if (m.href) r.href = m.href;
  return r;
}

/** Joins neighbours with the same marks and drops empty runs. */
export function mergeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    if (!r.text) continue;
    const last = out[out.length - 1];
    if (last && sameMarks(last, r)) last.text += r.text;
    else out.push({ ...r });
  }
  return out;
}

// ---------- inline parsing ----------

const PUNCT = /[!-/:-@[-`{-~]/;
const isPunct = (c: string | undefined) => !!c && (PUNCT.test(c) || /\p{P}/u.test(c));
const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', '#39': "'" };

type Node = { kind: 'text'; text: string } | { kind: 'runs'; runs: Run[] } | { kind: 'delim'; ch: '*' | '_' | '~'; len: number; orig: number; open: boolean; close: boolean; active: boolean };

/** The end of a code span opening at `i` with `n` backticks, or -1. */
function codeEnd(s: string, i: number, n: number): number {
  for (let j = i + n; j < s.length; ) {
    if (s[j] !== '`') {
      j++;
      continue;
    }
    let k = 0;
    while (s[j + k] === '`') k++;
    if (k === n) return j;
    j += k;
  }
  return -1;
}

/** The index of the `]` matching the `[` at `i`, skipping escapes and code spans, or -1. */
function closeBracket(s: string, i: number): number {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') j++;
    else if (c === '`') {
      let n = 0;
      while (s[j + n] === '`') n++;
      const e = codeEnd(s, j, n);
      j = e < 0 ? j + n - 1 : e + n - 1;
    } else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return j;
  }
  return -1;
}

/** A link destination and optional title after `(` at `i`: the destination and the index after `)`, or null. */
function linkTail(s: string, i: number): { dest: string; end: number } | null {
  let j = i + 1;
  while (s[j] === ' ' || s[j] === '\n') j++;
  let dest = '';
  if (s[j] === '<') {
    const e = s.indexOf('>', j);
    if (e < 0 || s.slice(j, e).includes('\n')) return null;
    dest = s.slice(j + 1, e);
    j = e + 1;
  } else {
    let depth = 0;
    for (; j < s.length; j++) {
      const c = s[j]!;
      if (c === '\\' && j + 1 < s.length && PUNCT.test(s[j + 1]!)) {
        dest += s[++j];
        continue;
      }
      if (/\s/.test(c)) break;
      if (c === '(') depth++;
      if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      dest += c;
    }
  }
  while (s[j] === ' ' || s[j] === '\n') j++;
  const q = s[j];
  if (q === '"' || q === "'" || q === '(') {
    const closer = q === '(' ? ')' : q;
    let k = j + 1;
    for (; k < s.length && s[k] !== closer; k++) if (s[k] === '\\') k++;
    if (k >= s.length) return null;
    j = k + 1;
    while (s[j] === ' ' || s[j] === '\n') j++;
  }
  return s[j] === ')' ? { dest, end: j + 1 } : null;
}

const plain = (runs: Run[]) => runs.map((r) => r.text).join('');

/** Inline Markdown as runs, every run carrying `base` (a link's href, for its text). */
export function inlineRuns(s: string, base: Marks = {}): Run[] {
  const nodes: Node[] = [];
  let buf = '';
  const flush = () => {
    if (buf) nodes.push({ kind: 'text', text: buf });
    buf = '';
  };
  for (let i = 0; i < s.length; ) {
    const c = s[i]!;
    if (c === '\\') {
      const n = s[i + 1];
      if (n === '\n') {
        buf += '\n';
        i += 2;
        while (s[i] === ' ') i++;
        continue;
      }
      if (n && PUNCT.test(n)) {
        buf += n;
        i += 2;
        continue;
      }
      buf += c;
      i++;
      continue;
    }
    if (c === '\n') {
      const hard = / {2,}$/.test(buf);
      buf = buf.replace(/ +$/, '') + (hard ? '\n' : ' ');
      i++;
      while (s[i] === ' ') i++;
      continue;
    }
    if (c === '`') {
      let n = 0;
      while (s[i + n] === '`') n++;
      const e = codeEnd(s, i, n);
      if (e < 0) {
        buf += '`'.repeat(n);
        i += n;
        continue;
      }
      let text = s.slice(i + n, e).replace(/\n/g, ' ');
      if (text.length > 1 && text.startsWith(' ') && text.endsWith(' ') && text.trim()) text = text.slice(1, -1);
      flush();
      nodes.push({ kind: 'runs', runs: [run(text, { ...base, code: true })] });
      i = e + n;
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let n = 0;
      while (s[i + n] === c) n++;
      const before = i > 0 ? s[i - 1] : undefined;
      const after = s[i + n];
      const left = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before));
      const right = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after));
      let open = left;
      let close = right;
      if (c === '_') {
        open = left && (!right || isPunct(before));
        close = right && (!left || isPunct(after));
      }
      if (c === '~' && n !== 2) {
        buf += c.repeat(n);
        i += n;
        continue;
      }
      flush();
      nodes.push({ kind: 'delim', ch: c, len: n, orig: n, open, close, active: true });
      i += n;
      continue;
    }
    if ((c === '!' && s[i + 1] === '[') || c === '[') {
      const at = c === '!' ? i + 1 : i;
      const e = closeBracket(s, at);
      const tail = e > 0 && s[e + 1] === '(' ? linkTail(s, e + 1) : null;
      if (!tail) {
        buf += c;
        i++;
        continue;
      }
      const label = s.slice(at + 1, e);
      const href = safeHref(tail.dest);
      flush();
      if (c === '!') {
        const alt = plain(inlineRuns(label)) || tail.dest;
        nodes.push({ kind: 'runs', runs: [run(alt, href ? { ...base, href } : base)] });
      } else nodes.push({ kind: 'runs', runs: inlineRuns(label, href ? { ...base, href } : base) });
      i = tail.end;
      continue;
    }
    if (c === '<') {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]*)>/i.exec(s.slice(i));
      if (m) {
        flush();
        const href = safeHref(m[1]);
        nodes.push({ kind: 'runs', runs: [run(m[1]!, href ? { ...base, href } : base)] });
        i += m[0].length;
        continue;
      }
    }
    if (c === '&') {
      const m = /^&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]+);/.exec(s.slice(i, i + 12));
      if (m) {
        const name = m[1]!;
        let ch: string | undefined;
        if (name[0] === '#') {
          const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
          ch = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�';
        } else ch = ENTITIES[name];
        if (ch !== undefined) {
          buf += ch;
          i += m[0].length;
          continue;
        }
      }
    }
    buf += c;
    i++;
  }
  flush();
  return mergeRuns(resolve(nodes, base));
}

/** CommonMark's emphasis pass over the delimiter runs, then the nodes as runs with their marks. */
function resolve(nodes: Node[], base: Marks): Run[] {
  const ranges: { from: number; to: number; mark: 'b' | 'i' | 's' }[] = [];
  for (let ci = 0; ci < nodes.length; ci++) {
    const c = nodes[ci]!;
    if (c.kind !== 'delim' || !c.close || !c.active) continue;
    while (c.len > 0) {
      let oi = -1;
      for (let k = ci - 1; k >= 0; k--) {
        const o = nodes[k]!;
        if (o.kind !== 'delim' || !o.active || !o.open || o.ch !== c.ch || o.len === 0) continue;
        if (o.ch !== '~' && (o.close || c.open) && (o.orig + c.orig) % 3 === 0 && !(o.orig % 3 === 0 && c.orig % 3 === 0)) continue;
        oi = k;
        break;
      }
      if (oi < 0) break;
      const o = nodes[oi] as Extract<Node, { kind: 'delim' }>;
      const use = c.ch === '~' ? 2 : o.len >= 2 && c.len >= 2 ? 2 : 1;
      ranges.push({ from: oi, to: ci, mark: c.ch === '~' ? 's' : use === 2 ? 'b' : 'i' });
      o.len -= use;
      c.len -= use;
      for (let k = oi + 1; k < ci; k++) {
        const d = nodes[k]!;
        if (d.kind === 'delim') d.active = false;
      }
    }
  }
  const out: Run[] = [];
  nodes.forEach((n, idx) => {
    const m: Marks = { ...base };
    for (const r of ranges) if (r.from < idx && idx < r.to) m[r.mark] = true;
    if (n.kind === 'text') out.push(run(n.text, m));
    else if (n.kind === 'delim') {
      if (n.len) out.push(run(n.ch.repeat(n.len), m));
    } else
      for (const r of n.runs) {
        const merged: Marks = { ...r };
        for (const k of ['b', 'i', 's'] as const) if (m[k]) merged[k] = true;
        out.push(run(r.text, merged));
      }
  });
  return out;
}

// ---------- block parsing ----------

const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?=[ \t]|$)(.*)$/;
const HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( {0,3})([-+*]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const DELIM_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const blank = (l: string | undefined) => l === undefined || !l.trim();
const indentOf = (l: string) => /^ */.exec(l)![0].length;

function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') {
      cur += '\\|';
      i++;
    } else if (t[i] === '|') {
      cells.push(cur);
      cur = '';
    } else cur += t[i];
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

const isTableStart = (lines: string[], i: number) => lines[i]!.includes('|') && i + 1 < lines.length && DELIM_ROW.test(lines[i + 1]!) && lines[i + 1]!.includes('-') && splitRow(lines[i]!).length === splitRow(lines[i + 1]!).length;

/** Whether a line starts a block that ends a paragraph. */
function interrupts(lines: string[], i: number): boolean {
  const l = lines[i]!;
  if (FENCE.test(l) || ATX.test(l) || HR.test(l) || QUOTE.test(l) || isTableStart(lines, i)) return true;
  const m = ITEM.exec(l);
  return !!m && !!m[4]?.trim() && (/^[-+*]$/.test(m[2]!) || /^1[.)]$/.test(m[2]!));
}

class Counter {
  blocks = 0;
  add(n = 1) {
    this.blocks += n;
    if (this.blocks > DOC_LIMITS.maxBlocks) throw new DocumentError(`The document has more than ${DOC_LIMITS.maxBlocks} blocks.`);
  }
}

function parseBlocks(lines: string[], count: Counter): Block[] {
  const out: Block[] = [];
  const push = (b: Block) => {
    count.add();
    out.push(b);
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence && !(fence[2]![0] === '`' && fence[3]!.includes('`'))) {
      const ind = fence[1]!.length;
      const mark = fence[2]!;
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const l = lines[i]!;
        const close = new RegExp(`^ {0,3}${mark[0] === '`' ? '`' : '~'}{${mark.length},}[ \\t]*$`).test(l);
        i++;
        if (close) break;
        body.push(l.replace(new RegExp(`^ {0,${ind}}`), ''));
      }
      const lang = fence[3]!.trim().split(/\s+/)[0];
      push({ type: 'code', ...(lang ? { lang } : {}), text: body.join('\n') });
      continue;
    }
    const atx = ATX.exec(line);
    if (atx) {
      const text = atx[2]!.replace(/(^|[ \t]+)#+[ \t]*$/, '').trim();
      push({ type: 'heading', level: atx[1]!.length as 1, runs: inlineRuns(text) });
      i++;
      continue;
    }
    if (HR.test(line)) {
      push({ type: 'hr' });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) inner.push(lines[i++]!.replace(QUOTE, ''));
      const runs: Run[] = [];
      for (const b of parseBlocks(inner, count)) {
        const part = blockRuns(b);
        if (!part.length) continue;
        if (runs.length) runs.push({ text: '\n' });
        runs.push(...part);
      }
      push({ type: 'quote', runs: mergeRuns(runs) });
      continue;
    }
    if (ITEM.test(line)) {
      i = parseList(lines, i, push, count);
      continue;
    }
    if (isTableStart(lines, i)) {
      const width = splitRow(line).length;
      const rows: Run[][][] = [splitRow(line).map((c) => inlineRuns(c))];
      i += 2;
      while (i < lines.length && !blank(lines[i]) && lines[i]!.includes('|')) {
        const cells = splitRow(lines[i++]!).slice(0, width);
        while (cells.length < width) cells.push('');
        rows.push(cells.map((c) => inlineRuns(c)));
      }
      push({ type: 'table', header: true, rows });
      continue;
    }
    if (indentOf(line) >= 4) {
      const body: string[] = [];
      while (i < lines.length && (blank(lines[i]) || indentOf(lines[i]!) >= 4)) body.push(lines[i++]!.slice(4));
      while (body.length && !body[body.length - 1]!.trim()) body.pop();
      push({ type: 'code', text: body.join('\n') });
      continue;
    }
    // A paragraph, or a setext heading when an underline follows.
    const para: string[] = [line.trimStart()];
    i++;
    let level: 1 | 2 | 0 = 0;
    while (i < lines.length && !blank(lines[i])) {
      const l = lines[i]!;
      if (/^ {0,3}=+[ \t]*$/.test(l)) {
        level = 1;
        i++;
        break;
      }
      if (/^ {0,3}-+[ \t]*$/.test(l)) {
        level = 2;
        i++;
        break;
      }
      if (interrupts(lines, i)) break;
      para.push(l.trimStart());
      i++;
    }
    const text = para.join('\n').replace(/[ \t]+$/, '');
    push(level ? { type: 'heading', level, runs: inlineRuns(text) } : { type: 'paragraph', runs: inlineRuns(text) });
  }
  return out;
}

/** A block's runs, as a quote or list item flattens it. */
function blockRuns(b: Block): Run[] {
  if (b.type === 'heading' || b.type === 'paragraph' || b.type === 'quote') return b.runs;
  if (b.type === 'code') return b.text ? [{ text: b.text, code: true }] : [];
  if (b.type === 'list') {
    const out: Run[] = [];
    const walk = (items: ListItem[]) =>
      items.forEach((it) => {
        if (out.length) out.push({ text: '\n' });
        out.push(...it.runs);
        if (it.children) walk(it.children.items);
      });
    walk(b.items);
    return out;
  }
  if (b.type === 'table') {
    const out: Run[] = [];
    b.rows.forEach((r, ri) => {
      if (ri) out.push({ text: '\n' });
      r.forEach((c, ci) => {
        if (ci) out.push({ text: ' | ' });
        out.push(...c);
      });
    });
    return out;
  }
  return [];
}

function parseList(lines: string[], start: number, push: (b: Block) => void, count: Counter): number {
  const first = ITEM.exec(lines[start]!)!;
  const ordered = /\d/.test(first[2]!);
  const marker = ordered ? first[2]!.slice(-1) : first[2]!;
  const base = first[1]!.length;
  const items: ListItem[] = [];
  let startNo = ordered ? parseInt(first[2]!, 10) : 1;
  let i = start;
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]!);
    if (!m || m[1]!.length > base + 3) break;
    const isOrd = /\d/.test(m[2]!);
    if (isOrd !== ordered || (ordered ? m[2]!.slice(-1) : m[2]!) !== marker) break;
    if (items.length === 0 && ordered) startNo = parseInt(m[2]!, 10);
    const gap = m[3] ?? ' ';
    const width = m[1]!.length + m[2]!.length + (gap.length > 4 || !m[4] ? 1 : gap.length);
    const body: string[] = [m[4] ?? ''];
    i++;
    while (i < lines.length) {
      const l = lines[i]!;
      if (blank(l)) {
        let k = i;
        while (k < lines.length && blank(lines[k])) k++;
        if (k < lines.length && indentOf(lines[k]!) >= width) {
          for (; i < k; i++) body.push('');
          continue;
        }
        break;
      }
      if (indentOf(l) >= width) {
        body.push(l.slice(width));
        i++;
        continue;
      }
      // A lazy continuation of the item's paragraph.
      if (!blank(body[body.length - 1]) && !interrupts(lines, i) && !ITEM.test(l)) {
        body.push(l.trimStart());
        i++;
        continue;
      }
      break;
    }
    let checked: boolean | undefined;
    const task = /^\[([ xX])\][ \t]+/.exec(body[0]!);
    if (task) {
      checked = task[1] !== ' ';
      body[0] = body[0]!.slice(task[0].length);
    }
    const blocks = parseBlocks(body, count);
    const item: ListItem = { runs: [] };
    const runs: Run[] = [];
    for (const b of blocks) {
      if (b.type === 'list' && !item.children) {
        item.children = { ordered: b.ordered, items: b.items };
        continue;
      }
      const part = blockRuns(b);
      if (!part.length) continue;
      if (runs.length) runs.push({ text: '\n' });
      runs.push(...part);
    }
    item.runs = mergeRuns(runs);
    if (checked !== undefined) item.checked = checked;
    items.push(item);
    // Blank lines between items keep the list going.
    let k = i;
    while (k < lines.length && blank(lines[k])) k++;
    if (k > i && k < lines.length && ITEM.test(lines[k]!)) i = k;
  }
  push({ type: 'list', ordered, ...(ordered && startNo !== 1 ? { start: startNo } : {}), items });
  return i;
}

export function markdownToDoc(text: string): RichDoc {
  if (text.length > DOC_LIMITS.maxChars) throw new DocumentError(`The document has more than ${DOC_LIMITS.maxChars} characters.`);
  const lines = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/^[ \t]+/, (ws) => ws.replace(/\t/g, '    ')));
  return { blocks: parseBlocks(lines, new Counter()) };
}

// ---------- writing ----------

function escapeText(t: string): string {
  let out = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (/[\\`*[\]<>|]/.test(c)) out += `\\${c}`;
    else if (c === '_' && (!/[\p{L}\p{N}]/u.test(t[i - 1] ?? '') || !/[\p{L}\p{N}]/u.test(t[i + 1] ?? ''))) out += '\\_';
    else if (c === '~' && (t[i - 1] === '~' || t[i + 1] === '~' || i === 0 || i === t.length - 1)) out += '\\~';
    else if (c === '&' && /^&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]+);/.test(t.slice(i, i + 12))) out += '\\&';
    else out += c;
  }
  return out;
}

/** Escapes what would start a block at the beginning of a line. */
function escapeLineStart(line: string): string {
  if (/^#{1,6}([ \t]|$)/.test(line) || /^[-+=]/.test(line) || /^>/.test(line)) return `\\${line}`;
  const num = /^(\d{1,9})([.)])/.exec(line);
  if (num) return `${num[1]}\\${line.slice(num[1]!.length)}`;
  if (/^ /.test(line)) return `&#32;${line.slice(1)}`;
  return line;
}

function codeSpan(text: string): string {
  const t = text.replace(/\n/g, ' ');
  let n = 1;
  const runs = t.match(/`+/g) ?? [];
  while (runs.some((r) => r.length === n)) n++;
  const f = '`'.repeat(n);
  const pad = t.startsWith('`') || t.endsWith('`') || (t.startsWith(' ') && t.endsWith(' ') && t.trim() !== '');
  return pad ? `${f} ${t} ${f}` : `${f}${t}${f}`;
}

const DELIM = { s: '~~', b: '**', i: '*' } as const;
const STACK_ORDER = ['s', 'b', 'i'] as const;

/** Moves spaces at the edges of a marked run out of its marks (Markdown emphasis cannot start or end with a space). */
function hoist(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of mergeRuns(runs)) {
    if (r.code || !(r.b || r.i || r.s)) {
      out.push(r);
      continue;
    }
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(r.text)!;
    const bare = r.href ? { href: r.href } : {};
    if (m[1]) out.push({ text: m[1], ...bare });
    if (m[2]) out.push({ ...r, text: m[2] });
    if (m[3]) out.push({ text: m[3], ...bare });
  }
  return mergeRuns(out);
}

function marksMd(runs: Run[]): string {
  let out = '';
  const stack: ('s' | 'b' | 'i')[] = [];
  for (const r of runs) {
    const want = STACK_ORDER.filter((k) => r[k]);
    let keep = 0;
    while (keep < stack.length && want.includes(stack[keep]!)) keep++;
    while (stack.length > keep) out += DELIM[stack.pop()!];
    for (const k of want) {
      if (stack.includes(k)) continue;
      stack.push(k);
      out += DELIM[k];
    }
    if (r.code) out += codeSpan(r.text);
    else out += r.text.split('\n').map(escapeText).join('\\\n');
  }
  while (stack.length) out += DELIM[stack.pop()!];
  return out;
}

const destination = (href: string) => (/^[^\s()<>\\]+$/.test(href) ? href : `<${href.replace(/[<>\n ]/g, (c) => encodeURIComponent(c))}>`);

/** Runs as inline Markdown; a hard break is a backslash at the end of a line. */
function inlineMd(input: Run[]): string {
  const runs = hoist(
    input.map((r) => {
      const { href: _h, ...rest } = r;
      const href = safeHref(r.href);
      return href ? { ...rest, href } : rest;
    })
  );
  let out = '';
  for (let i = 0; i < runs.length; ) {
    const href = runs[i]!.href;
    let j = i;
    while (j < runs.length && runs[j]!.href === href) j++;
    const group = runs.slice(i, j).map(({ href: _h, ...r }) => r as Run);
    out += href ? `[${marksMd(group)}](${destination(href)})` : marksMd(group);
    i = j;
  }
  return out;
}

/** Inline Markdown split into lines, each escaped at its start and prefixed (all but the first) with `prefix`. */
function blockLines(runs: Run[], prefix: string): string {
  const text = inlineMd(runs).replace(/\\\n$/, '');
  return text
    .split('\n')
    .map((l, i) => (i ? prefix : '') + escapeLineStart(l))
    .join('\n');
}

function listMd(list: { ordered: boolean; start?: number; items: ListItem[] }, indent: string, alt: boolean): string {
  const out: string[] = [];
  list.items.forEach((it, n) => {
    const marker = list.ordered ? `${(list.start ?? 1) + n}${alt ? ')' : '.'}` : alt ? '*' : '-';
    const pad = ' '.repeat(marker.length + 1);
    const task = it.checked === undefined ? '' : it.checked ? '[x] ' : '[ ] ';
    const body = it.runs.length ? blockLines(it.runs, indent + pad) : '';
    out.push(`${indent}${marker} ${task}${body}`.replace(/[ \t]+$/, ''));
    if (it.children && it.children.items.length) out.push(listMd(it.children, indent + pad, false));
  });
  return out.join('\n');
}

function tableMd(b: Extract<Block, { type: 'table' }>): string {
  const width = Math.max(1, ...b.rows.map((r) => r.length));
  const cell = (c: Run[] | undefined) => (c ? inlineMd(c.map((r) => ({ ...r, text: r.text.replace(/\n/g, ' ') }))) : '') || ' ';
  const row = (r: Run[][]) => `| ${Array.from({ length: width }, (_, k) => cell(r[k])).join(' | ')} |`;
  const rows = b.header ? b.rows : [[], ...b.rows];
  const head = row(rows[0] ?? []);
  const sep = `| ${Array.from({ length: width }, () => '---').join(' | ')} |`;
  return [head, sep, ...rows.slice(1).map(row)].join('\n');
}

export function docToMarkdown(doc: RichDoc): string {
  const out: string[] = [];
  let prev: Block | null = null;
  let alt = false;
  for (const b of doc.blocks) {
    switch (b.type) {
      case 'heading': {
        const t = inlineMd(b.runs.map((r) => ({ ...r, text: r.text.replace(/\n/g, ' ') }))).replace(/#+\s*$/, (m) => m.replace(/#/g, '\\#'));
        out.push(`${'#'.repeat(b.level)}${t ? ` ${t}` : ''}`);
        break;
      }
      case 'paragraph':
        if (b.runs.some((r) => r.text)) out.push(blockLines(b.runs, ''));
        break;
      case 'quote':
        out.push(`> ${blockLines(b.runs, '> ')}`.replace(/ $/, ''));
        break;
      case 'code': {
        const longest = Math.max(2, ...(b.text.match(/`+/g) ?? []).map((x) => x.length));
        const fence = '`'.repeat(longest + 1);
        const lang = (b.lang ?? '').replace(/[`\s]/g, '');
        out.push(`${fence}${lang}\n${b.text}${b.text ? '\n' : ''}${fence}`);
        break;
      }
      case 'list':
        alt = prev?.type === 'list' && prev.ordered === b.ordered ? !alt : false;
        if (b.items.length) out.push(listMd(b, '', alt));
        break;
      case 'table':
        if (b.rows.length) out.push(tableMd(b));
        break;
      case 'hr':
        out.push('---');
        break;
    }
    prev = b;
  }
  return out.length ? `${out.join('\n\n')}\n` : '';
}

// ---------- plain text ----------

export function docToText(doc: RichDoc): string {
  const t = (runs: Run[]) => runs.map((r) => r.text).join('');
  const list = (items: ListItem[], ordered: boolean, start: number, depth: number): string =>
    items
      .map((it, n) => `${'  '.repeat(depth)}${ordered ? `${start + n}.` : '-'} ${it.checked === undefined ? '' : it.checked ? '[x] ' : '[ ] '}${t(it.runs)}${it.children ? `\n${list(it.children.items, it.children.ordered, 1, depth + 1)}` : ''}`)
      .join('\n');
  return doc.blocks
    .map((b) => {
      switch (b.type) {
        case 'heading':
        case 'paragraph':
        case 'quote':
          return t(b.runs);
        case 'code':
          return b.text;
        case 'list':
          return list(b.items, b.ordered, b.start ?? 1, 0);
        case 'table':
          return b.rows.map((r) => r.map(t).join('\t')).join('\n');
        case 'hr':
          return '---';
      }
      return '';
    })
    .filter((x) => x !== '')
    .join('\n\n');
}

// ---------- validation of a model from a request ----------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Checks an untrusted RichDoc and returns a clean copy (only known fields, links made safe). */
export function validateDoc(input: unknown): RichDoc {
  const fail = (msg: string): never => {
    throw new DocumentError(msg);
  };
  let chars = 0;
  let nodes = 0;
  const tick = () => {
    if (++nodes > DOC_LIMITS.maxBlocks * 20) fail('The document has too many parts.');
  };
  const runs = (v: unknown, where: string): Run[] => {
    if (!Array.isArray(v)) return fail(`${where}: runs must be a list.`);
    return v.map((r) => {
      tick();
      if (!isObj(r) || typeof r.text !== 'string') return fail(`${where}: each run needs text.`);
      chars += r.text.length;
      if (chars > DOC_LIMITS.maxChars) fail(`The document has more than ${DOC_LIMITS.maxChars} characters.`);
      const out: Run = { text: r.text };
      for (const k of MARK_KEYS) {
        if (r[k] !== undefined && typeof r[k] !== 'boolean') fail(`${where}: ${k} must be true or false.`);
        if (r[k]) out[k] = true;
      }
      if (r.href !== undefined && r.href !== null) {
        if (typeof r.href !== 'string') fail(`${where}: href must be text.`);
        const h = safeHref(r.href as string);
        if (h) out.href = h;
      }
      return out;
    });
  };
  const items = (v: unknown, depth: number): ListItem[] => {
    if (depth > 10) fail('Lists are nested more than 10 deep.');
    if (!Array.isArray(v)) return fail('A list needs items.');
    return v.map((it) => {
      tick();
      if (!isObj(it)) return fail('A list item must be an object.');
      const out: ListItem = { runs: runs(it.runs, 'A list item') };
      if (it.checked !== undefined && it.checked !== null) {
        if (typeof it.checked !== 'boolean') fail('checked must be true or false.');
        out.checked = it.checked as boolean;
      }
      if (it.children !== undefined && it.children !== null) {
        if (!isObj(it.children) || typeof it.children.ordered !== 'boolean') fail('A nested list needs ordered and items.');
        const c = it.children as Record<string, unknown>;
        out.children = { ordered: c.ordered as boolean, items: items(c.items, depth + 1) };
      }
      return out;
    });
  };
  if (!isObj(input) || !Array.isArray(input.blocks)) return fail('A document needs a list of blocks.');
  if (input.blocks.length > DOC_LIMITS.maxBlocks) fail(`The document has more than ${DOC_LIMITS.maxBlocks} blocks.`);
  const blocks = input.blocks.map((b, n): Block => {
    const where = `Block ${n + 1}`;
    if (!isObj(b)) return fail(`${where} must be an object.`);
    switch (b.type) {
      case 'heading': {
        const level = b.level;
        if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 6) return fail(`${where}: a heading level is 1 to 6.`);
        return { type: 'heading', level: level as 1, runs: runs(b.runs, where) };
      }
      case 'paragraph':
      case 'quote':
        return { type: b.type, runs: runs(b.runs, where) };
      case 'list': {
        if (typeof b.ordered !== 'boolean') return fail(`${where}: ordered must be true or false.`);
        const out: Block = { type: 'list', ordered: b.ordered, items: items(b.items, 1) };
        if (b.start !== undefined && b.start !== null) {
          if (typeof b.start !== 'number' || !Number.isInteger(b.start) || b.start < 0 || b.start > 999_999_999) return fail(`${where}: start must be a whole number.`);
          if (b.ordered && b.start !== 1) out.start = b.start;
        }
        return out;
      }
      case 'code': {
        if (typeof b.text !== 'string') return fail(`${where}: code needs text.`);
        chars += b.text.length;
        if (chars > DOC_LIMITS.maxChars) fail(`The document has more than ${DOC_LIMITS.maxChars} characters.`);
        const lang = typeof b.lang === 'string' && /^[\w+#.-]{1,40}$/.test(b.lang) ? b.lang : undefined;
        return { type: 'code', ...(lang ? { lang } : {}), text: b.text };
      }
      case 'table': {
        if (typeof b.header !== 'boolean' || !Array.isArray(b.rows)) return fail(`${where}: a table needs header and rows.`);
        const rows = b.rows.map((r) => {
          if (!Array.isArray(r)) return fail(`${where}: each row is a list of cells.`);
          if (r.length > DOC_LIMITS.maxColumns) fail(`${where}: more than ${DOC_LIMITS.maxColumns} columns.`);
          return r.map((c) => runs(c, where));
        });
        return { type: 'table', header: b.header, rows };
      }
      case 'hr':
        return { type: 'hr' };
      default:
        return fail(`${where}: unknown block type.`);
    }
  });
  return { blocks };
}
