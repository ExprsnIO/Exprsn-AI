import { ExtractionError, zipEntries } from '../../knowledge/extract.js';
import { xmlText } from '../../imports/xlsx-writer.js';
import { zip } from '../../platform/zip-writer.js';
import { mergeRuns } from './markdown.js';
import { DOC_LIMITS, DocumentError, MIME, safeHref, type Block, type ListItem, type RichDoc, type Run } from './model.js';

/*
 * OpenDocument text (`.odt`) to and from the RichDoc model. Reading parses content.xml and styles.xml with the small
 * XML reader below (no DTD, no entities beyond the predefined five and character references) and keeps the text,
 * headings, lists, tables, quotes, preformatted text, links and the bold, italic, underline, strike and monospace marks;
 * what it cannot keep (images, notes, comments, tracked changes, merged cells) is counted in `notes`. Writing builds an
 * ODF 1.3 package with its own styles; LibreOffice opens it, and reading it back gives the same model.
 */

// ---------- a small XML reader ----------

export interface XmlEl {
  name: string;
  attrs: Record<string, string>;
  children: (XmlEl | string)[];
}

const NS: Record<string, string> = {
  'urn:oasis:names:tc:opendocument:xmlns:office:1.0': 'office',
  'urn:oasis:names:tc:opendocument:xmlns:style:1.0': 'style',
  'urn:oasis:names:tc:opendocument:xmlns:text:1.0': 'text',
  'urn:oasis:names:tc:opendocument:xmlns:table:1.0': 'table',
  'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0': 'draw',
  'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0': 'fo',
  'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0': 'svg',
  'urn:oasis:names:tc:opendocument:xmlns:meta:1.0': 'meta',
  'http://www.w3.org/1999/xlink': 'xlink',
  'http://purl.org/dc/elements/1.1/': 'dc'
};

const PREDEFINED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);?/g, (m, e: string) => {
    if (!m.endsWith(';')) throw new DocumentError('The document XML has a stray &.');
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!(code > 0 && code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) throw new DocumentError('The document XML has a bad character reference.');
      return String.fromCodePoint(code);
    }
    const v = PREDEFINED[e];
    if (v === undefined) throw new DocumentError(`The document XML uses the entity &${e}; which is not allowed.`);
    return v;
  });
}

/** Parses XML into elements; namespace prefixes are rewritten to the usual ODF ones. */
export function parseXml(xml: string): XmlEl {
  const root: XmlEl = { name: '#root', attrs: {}, children: [] };
  const stack: { el: XmlEl; ns: Map<string, string> }[] = [{ el: root, ns: new Map([['xml', 'xml']]) }];
  const canon = (qname: string, ns: Map<string, string>, isAttr: boolean): string => {
    const at = qname.indexOf(':');
    if (at < 0) return isAttr ? qname : (NS[ns.get('') ?? ''] ? `${NS[ns.get('')!]}:${qname}` : qname);
    const prefix = qname.slice(0, at);
    const uri = ns.get(prefix);
    const p = uri ? (NS[uri] ?? prefix) : prefix;
    return `${p}:${qname.slice(at + 1)}`;
  };
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > i) {
      const t = xml.slice(i, textEnd);
      if (stack.length > 1) stack[stack.length - 1]!.el.children.push(decode(t));
      else if (t.trim()) throw new DocumentError('The document XML has text outside its root element.');
    }
    if (lt < 0) break;
    if (xml.startsWith('<?', lt)) {
      const e = xml.indexOf('?>', lt);
      if (e < 0) throw new DocumentError('The document XML is cut off.');
      i = e + 2;
      continue;
    }
    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt);
      if (e < 0) throw new DocumentError('The document XML is cut off.');
      i = e + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt);
      if (e < 0) throw new DocumentError('The document XML is cut off.');
      stack[stack.length - 1]!.el.children.push(xml.slice(lt + 9, e));
      i = e + 3;
      continue;
    }
    if (xml.startsWith('<!', lt)) throw new DocumentError('The document XML has a DOCTYPE or other declaration, which is not allowed.');
    const gt = xml.indexOf('>', lt);
    if (gt < 0) throw new DocumentError('The document XML is cut off.');
    // A `>` inside an attribute value: find the real end of the tag.
    let end = gt;
    let q: string | null = null;
    for (let k = lt + 1; k < n; k++) {
      const c = xml[k];
      if (q) {
        if (c === q) q = null;
      } else if (c === '"' || c === "'") q = c;
      else if (c === '>') {
        end = k;
        break;
      }
      if (k === n - 1) throw new DocumentError('The document XML is cut off.');
    }
    const tag = xml.slice(lt + 1, end);
    i = end + 1;
    if (tag.startsWith('/')) {
      if (stack.length <= 1) throw new DocumentError('The document XML closes an element it never opened.');
      stack.pop();
      continue;
    }
    const selfClose = tag.endsWith('/');
    const body = selfClose ? tag.slice(0, -1) : tag;
    const m = /^([^\s/>]+)/.exec(body);
    if (!m) throw new DocumentError('The document XML has an element without a name.');
    const raw: [string, string][] = [];
    const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a: RegExpExecArray | null;
    const rest = body.slice(m[1]!.length);
    while ((a = attrRe.exec(rest))) raw.push([a[1]!, decode(a[3] ?? a[4] ?? '')]);
    const parentNs = stack[stack.length - 1]!.ns;
    let ns = parentNs;
    for (const [k, v] of raw) {
      if (k === 'xmlns' || k.startsWith('xmlns:')) {
        if (ns === parentNs) ns = new Map(parentNs);
        ns.set(k === 'xmlns' ? '' : k.slice(6), v);
      }
    }
    const attrs: Record<string, string> = {};
    for (const [k, v] of raw) if (k !== 'xmlns' && !k.startsWith('xmlns:')) attrs[canon(k, ns, true)] = v;
    const el: XmlEl = { name: canon(m[1]!, ns, false), attrs, children: [] };
    stack[stack.length - 1]!.el.children.push(el);
    if (!selfClose) {
      if (stack.length > 400) throw new DocumentError('The document XML is nested too deeply.');
      stack.push({ el, ns });
    }
  }
  if (stack.length > 1) throw new DocumentError('The document XML is cut off.');
  const top = root.children.find((c): c is XmlEl => typeof c !== 'string');
  if (!top) throw new DocumentError('The document XML has no root element.');
  return top;
}

const kids = (el: XmlEl | undefined, name?: string): XmlEl[] => (el ? el.children.filter((c): c is XmlEl => typeof c !== 'string' && (!name || c.name === name)) : []);
const kid = (el: XmlEl | undefined, name: string) => kids(el, name)[0];
const textOf = (el: XmlEl): string => el.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');

// ---------- styles ----------

interface TextProps {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  code?: boolean;
}

interface StyleDef {
  name: string;
  family: string;
  parent?: string;
  props: TextProps;
}

/** Paragraph styles whose own text properties are their look, not marks of the text (a heading is bold anyway). */
const NAMED = /^(Heading(_20_\d)?|Title|Subtitle|Table_20_Heading|Table_20_Contents|Quotations|Preformatted_20_Text|Horizontal_20_Line|Text_20_body|Standard)$/;
const MONO = /mono|courier|consolas|menlo|code|typewriter/i;

class Styles {
  readonly byName = new Map<string, StyleDef>();
  readonly lists = new Map<string, Map<number, boolean>>();
  readonly mono = new Set<string>();

  read(root: XmlEl | undefined) {
    if (!root) return;
    for (const decls of kids(root, 'office:font-face-decls'))
      for (const f of kids(decls, 'style:font-face')) {
        if (f.attrs['style:font-pitch'] === 'fixed' || MONO.test(f.attrs['style:name'] ?? '') || MONO.test(f.attrs['svg:font-family'] ?? '')) this.mono.add(f.attrs['style:name'] ?? '');
      }
    for (const sec of [kid(root, 'office:styles'), kid(root, 'office:automatic-styles')]) {
      for (const st of kids(sec, 'style:style')) {
        const tp = kid(st, 'style:text-properties');
        const props: TextProps = {};
        if (tp) {
          const w = tp.attrs['fo:font-weight'];
          if (w) props.b = w === 'bold' || Number(w) >= 600;
          const sty = tp.attrs['fo:font-style'];
          if (sty) props.i = sty === 'italic' || sty === 'oblique';
          const ul = tp.attrs['style:text-underline-style'];
          if (ul) props.u = ul !== 'none';
          const lt = tp.attrs['style:text-line-through-style'];
          if (lt) props.s = lt !== 'none';
          const font = tp.attrs['style:font-name'] ?? tp.attrs['fo:font-family'];
          if (font) props.code = this.mono.has(font) || MONO.test(font);
        }
        const name = st.attrs['style:name'];
        if (name) this.byName.set(name, { name, family: st.attrs['style:family'] ?? '', ...(st.attrs['style:parent-style-name'] ? { parent: st.attrs['style:parent-style-name'] } : {}), props });
      }
      for (const ls of kids(sec, 'text:list-style')) {
        const levels = new Map<number, boolean>();
        for (const lv of kids(ls)) {
          const n = Number(lv.attrs['text:level'] ?? 1);
          if (lv.name === 'text:list-level-style-number') levels.set(n, true);
          else if (lv.name === 'text:list-level-style-bullet' || lv.name === 'text:list-level-style-image') levels.set(n, false);
        }
        if (ls.attrs['style:name']) this.lists.set(ls.attrs['style:name'], levels);
      }
    }
  }

  /** The style and its parents, nearest first. */
  chain(name: string | undefined): StyleDef[] {
    const out: StyleDef[] = [];
    for (let cur = name ? this.byName.get(name) : undefined; cur && out.length < 20; cur = cur.parent ? this.byName.get(cur.parent) : undefined) out.push(cur);
    if (!out.length && name) out.push({ name, family: '', props: {} });
    return out;
  }

  /** Marks of a text style, nearer styles winning. */
  marks(name: string | undefined, stopAtNamed = false): TextProps {
    const out: TextProps = {};
    for (const st of this.chain(name)) {
      if (stopAtNamed && NAMED.test(st.name)) break;
      for (const k of ['b', 'i', 'u', 's', 'code'] as const) if (out[k] === undefined && st.props[k] !== undefined) out[k] = st.props[k];
    }
    return out;
  }

  /** What kind of paragraph a paragraph style makes. */
  role(name: string | undefined): { kind: 'quote' | 'code' | 'hr' | 'heading' | 'p'; level?: number } {
    for (const st of this.chain(name)) {
      if (st.name === 'Quotations') return { kind: 'quote' };
      if (st.name === 'Preformatted_20_Text' || st.name === 'Source_20_Text') return { kind: 'code' };
      if (st.name === 'Horizontal_20_Line') return { kind: 'hr' };
      const h = /^Heading_20_(\d)$/.exec(st.name);
      if (h) return { kind: 'heading', level: Math.min(6, Math.max(1, Number(h[1]))) };
    }
    return { kind: 'p' };
  }
}

const apply = (base: TextProps, over: TextProps): TextProps => {
  const out = { ...base };
  for (const k of ['b', 'i', 'u', 's', 'code'] as const) if (over[k] !== undefined) out[k] = over[k];
  return out;
};

// ---------- reading ----------

interface Counts {
  images: number;
  frames: number;
  notes: number;
  comments: number;
  changes: number;
  merged: number;
  blocks: number;
}

class Reader {
  readonly counts: Counts = { images: 0, frames: 0, notes: 0, comments: 0, changes: 0, merged: 0, blocks: 0 };
  constructor(private readonly st: Styles) {}

  /** A paragraph's runs. Spaces collapse as ODF says; `text:s`, `text:tab` and `text:line-break` give exact white space. */
  runs(p: XmlEl, base: TextProps): Run[] {
    const out: Run[] = [];
    let last = '';
    let started = false;
    const emit = (text: string, m: TextProps & { href?: string }, collapsible: boolean) => {
      if (!text) return;
      let t = text;
      if (collapsible) {
        t = t.replace(/[\t\r\n ]+/g, ' ');
        if (t.startsWith(' ') && (!started || last === ' ')) t = t.slice(1);
        if (!t) return;
      }
      const r: Run = { text: t };
      for (const k of ['b', 'i', 'u', 's', 'code'] as const) if (m[k]) r[k] = true;
      if (m.href) r.href = m.href;
      out.push(r);
      started = true;
      last = collapsible ? t.slice(-1) : '';
    };
    const walk = (el: XmlEl, m: TextProps & { href?: string }) => {
      for (const c of el.children) {
        if (typeof c === 'string') {
          emit(c, m, true);
          continue;
        }
        switch (c.name) {
          case 'text:span':
            walk(c, { ...apply(m, this.st.marks(c.attrs['text:style-name'])), ...(m.href ? { href: m.href } : {}) });
            break;
          case 'text:a': {
            const href = safeHref(c.attrs['xlink:href']);
            const { href: _h, ...rest } = m;
            walk(c, href ? { ...rest, href } : rest);
            break;
          }
          case 'text:s':
            emit(' '.repeat(Math.min(1000, Math.max(1, Number(c.attrs['text:c'] ?? 1) || 1))), m, false);
            break;
          case 'text:tab':
            emit('\t', m, false);
            break;
          case 'text:line-break':
            emit('\n', m, false);
            break;
          case 'text:note':
            this.counts.notes++;
            break;
          case 'office:annotation':
            this.counts.comments++;
            break;
          case 'office:annotation-end':
          case 'text:bookmark':
          case 'text:bookmark-start':
          case 'text:bookmark-end':
          case 'text:reference-mark':
          case 'text:reference-mark-start':
          case 'text:reference-mark-end':
          case 'text:soft-page-break':
          case 'text:change':
          case 'text:change-start':
          case 'text:change-end':
          case 'text:alphabetical-index-mark':
          case 'text:toc-mark':
            break;
          case 'draw:frame':
          case 'draw:a':
            if (kids(c, 'draw:image').length || (c.name === 'draw:a' && kids(c, 'draw:frame').some((f) => kids(f, 'draw:image').length))) this.counts.images++;
            else this.counts.frames++;
            break;
          default:
            if (c.name.startsWith('draw:')) this.counts.frames++;
            else walk(c, m);
        }
      }
    };
    walk(p, base);
    return mergeRuns(out);
  }

  private tick() {
    if (++this.counts.blocks > DOC_LIMITS.maxBlocks) throw new DocumentError(`The document has more than ${DOC_LIMITS.maxBlocks} blocks.`);
  }

  blocks(parent: XmlEl, out: Block[]) {
    for (const el of kids(parent)) {
      switch (el.name) {
        case 'text:h': {
          this.tick();
          const lv = Number(el.attrs['text:outline-level'] ?? 1) || 1;
          out.push({ type: 'heading', level: Math.min(6, Math.max(1, lv)) as 1, runs: this.runs(el, {}) });
          break;
        }
        case 'text:p':
          this.paragraph(el, out);
          break;
        case 'text:list':
          this.tick();
          out.push({ type: 'list', ...this.list(el, 1, el.attrs['text:style-name']) });
          break;
        case 'table:table':
          this.table(el, out);
          break;
        case 'text:tracked-changes':
          this.counts.changes++;
          break;
        case 'text:section':
        case 'text:index-body':
        case 'text:table-of-content':
        case 'text:alphabetical-index':
        case 'text:illustration-index':
        case 'text:bibliography':
          this.blocks(el, out);
          break;
        case 'draw:frame':
        case 'draw:a':
          if (kids(el, 'draw:image').length) this.counts.images++;
          else this.counts.frames++;
          break;
        default:
          if (el.name.startsWith('draw:')) this.counts.frames++;
      }
    }
  }

  private paragraph(el: XmlEl, out: Block[]) {
    const style = el.attrs['text:style-name'];
    const role = this.st.role(style);
    const runs = this.runs(el, role.kind === 'p' ? this.st.marks(style, true) : {});
    const text = runs.map((r) => r.text).join('');
    const prev = out[out.length - 1];
    if (role.kind === 'hr') {
      if (!text.trim()) {
        this.tick();
        out.push({ type: 'hr' });
        return;
      }
    } else if (role.kind === 'code') {
      if (prev?.type === 'code' && this.lastWasCode) prev.text += `\n${text}`;
      else {
        this.tick();
        out.push({ type: 'code', text });
      }
      this.lastWasCode = true;
      return;
    }
    this.lastWasCode = false;
    if (!text) return;
    if (role.kind === 'quote') {
      if (prev?.type === 'quote' && this.lastWasQuote) prev.runs = mergeRuns([...prev.runs, { text: '\n' }, ...runs]);
      else {
        this.tick();
        out.push({ type: 'quote', runs });
      }
      this.lastWasQuote = true;
      return;
    }
    this.lastWasQuote = false;
    this.tick();
    if (role.kind === 'heading') out.push({ type: 'heading', level: role.level as 1, runs });
    else out.push({ type: 'paragraph', runs });
  }

  private lastWasCode = false;
  private lastWasQuote = false;

  private list(el: XmlEl, level: number, styleName: string | undefined): { ordered: boolean; start?: number; items: ListItem[] } {
    if (level > 10) throw new DocumentError('Lists are nested more than 10 deep.');
    const style = el.attrs['text:style-name'] ?? styleName;
    const ordered = (style ? this.st.lists.get(style)?.get(level) : undefined) ?? false;
    const items: ListItem[] = [];
    let start: number | undefined;
    for (const it of kids(el)) {
      if (it.name !== 'text:list-item' && it.name !== 'text:list-header') continue;
      this.tick();
      if (!items.length && it.attrs['text:start-value']) start = Number(it.attrs['text:start-value']) || undefined;
      const item: ListItem = { runs: [] };
      const runs: Run[] = [];
      for (const c of kids(it)) {
        if (c.name === 'text:list') {
          if (!item.children) item.children = this.list(c, level + 1, style);
          continue;
        }
        if (c.name === 'text:p' || c.name === 'text:h') {
          const r = this.runs(c, c.name === 'text:p' ? this.st.marks(c.attrs['text:style-name'], true) : {});
          if (!r.length) continue;
          if (runs.length) runs.push({ text: '\n' });
          runs.push(...r);
        }
      }
      item.runs = mergeRuns(runs);
      // A task item is written with a ballot box before its text.
      const box = /^([\u2610\u2611\u2612]) /.exec(item.runs[0]?.text ?? '');
      if (box) {
        item.checked = box[1] !== '\u2610';
        item.runs[0]!.text = item.runs[0]!.text.slice(2);
        if (!item.runs[0]!.text) item.runs.shift();
      }
      items.push(item);
    }
    return { ordered, ...(ordered && start !== undefined && start !== 1 ? { start } : {}), items };
  }

  private table(el: XmlEl, out: Block[]) {
    // Repeated empty cells and rows are how spreadsheets pad a table out; they do not widen or lengthen it here.
    const rows: { cells: Run[][]; width: number; header: boolean; filler: boolean }[] = [];
    const addRow = (row: XmlEl, header: boolean) => {
      const cells: Run[][] = [];
      let width = 0;
      for (const c of kids(row)) {
        if (c.name !== 'table:table-cell' && c.name !== 'table:covered-table-cell') continue;
        if (c.name === 'table:covered-table-cell') this.counts.merged++;
        const runs: Run[] = [];
        for (const p of kids(c)) {
          if (p.name !== 'text:p' && p.name !== 'text:h') continue;
          const r = this.runs(p, p.name === 'text:p' ? this.st.marks(p.attrs['text:style-name'], true) : {});
          if (!r.length) continue;
          if (runs.length) runs.push({ text: '\n' });
          runs.push(...r);
        }
        const rep = Math.min(DOC_LIMITS.maxColumns, Math.max(1, Number(c.attrs['table:number-columns-repeated'] ?? 1) || 1));
        const merged = mergeRuns(runs);
        for (let k = 0; k < rep && cells.length < DOC_LIMITS.maxColumns; k++) cells.push(merged.map((x) => ({ ...x })));
        if (merged.length || rep === 1) width = cells.length;
      }
      const rep = Math.min(10_000, Math.max(1, Number(row.attrs['table:number-rows-repeated'] ?? 1) || 1));
      const empty = cells.every((c) => !c.length);
      for (let k = 0; k < (empty ? 1 : rep); k++) rows.push({ cells: cells.map((c) => c.map((x) => ({ ...x }))), width, header, filler: empty && rep > 1 });
    };
    const walk = (parent: XmlEl, header: boolean) => {
      for (const c of kids(parent)) {
        if (c.name === 'table:table-row') addRow(c, header);
        else if (c.name === 'table:table-header-rows') walk(c, true);
        else if (c.name === 'table:table-rows' || c.name === 'table:table-row-group') walk(c, header);
      }
    };
    walk(el, false);
    while (rows.length && rows[rows.length - 1]!.filler) rows.pop();
    if (!rows.length) return;
    const width = Math.max(1, ...rows.map((r) => r.width));
    this.tick();
    out.push({ type: 'table', header: rows[0]!.header, rows: rows.map((r) => Array.from({ length: width }, (_, k) => r.cells[k] ?? [])) });
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function odtToDoc(buf: Buffer): { doc: RichDoc; notes: string[] } {
  let entries: Map<string, () => Buffer>;
  try {
    entries = zipEntries(buf);
  } catch (err) {
    if (err instanceof ExtractionError) throw new DocumentError(`The file is not a readable OpenDocument package: ${err.message}`);
    throw err;
  }
  const read = (name: string): string | null => {
    const get = entries.get(name);
    if (!get) return null;
    try {
      return get().toString('utf8');
    } catch (err) {
      if (err instanceof ExtractionError) throw new DocumentError(err.message);
      if (err instanceof RangeError) throw new DocumentError('A part of the document unpacks to more than the size allowed.');
      throw err;
    }
  };
  const mime = read('mimetype')?.trim();
  if (mime !== MIME.odt) throw new DocumentError(mime ? `The package is ${mime}, not an OpenDocument text.` : 'The package has no mimetype: it is not an OpenDocument file.');
  const content = read('content.xml');
  if (content == null) throw new DocumentError('The package has no content.xml.');
  const st = new Styles();
  const stylesXml = read('styles.xml');
  if (stylesXml) st.read(parseXml(stylesXml));
  const root = parseXml(content);
  st.read(root);
  const text = kid(kid(root, 'office:body'), 'office:text');
  const blocks: Block[] = [];
  const r = new Reader(st);
  if (text) r.blocks(text, blocks);
  const c = r.counts;
  const notes: string[] = [];
  if (c.images) notes.push(`${plural(c.images, 'image was', 'images were')} left out: images are not edited here.`);
  if (c.frames) notes.push(`${plural(c.frames, 'text box or drawing was', 'text boxes or drawings were')} left out.`);
  if (c.notes) notes.push(`${plural(c.notes, 'footnote or endnote was', 'footnotes or endnotes were')} left out.`);
  if (c.comments) notes.push(`${plural(c.comments, 'comment was', 'comments were')} left out.`);
  if (c.changes) notes.push('Tracked changes were left out: the text is shown as it reads now.');
  if (c.merged) notes.push(`${plural(c.merged, 'merged table cell becomes', 'merged table cells become')} empty cells.`);
  return { doc: { blocks }, notes };
}

// ---------- writing ----------

const NSDECL =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"';
const FONTS = '<office:font-face-decls><style:font-face style:name="Liberation Serif" svg:font-family="\'Liberation Serif\'" style:font-family-generic="roman" style:font-pitch="variable"/><style:font-face style:name="Liberation Sans" svg:font-family="\'Liberation Sans\'" style:font-family-generic="swiss" style:font-pitch="variable"/><style:font-face style:name="Liberation Mono" svg:font-family="\'Liberation Mono\'" style:font-family-generic="modern" style:font-pitch="fixed"/></office:font-face-decls>';
const HEAD_SIZES = ['130%', '115%', '101%', '95%', '85%', '85%'];

function listStyle(name: string, ordered: boolean): string {
  let out = `<text:list-style style:name="${name}" style:display-name="${ordered ? 'Numbering 123' : 'List 1'}">`;
  for (let lv = 1; lv <= 10; lv++) {
    const indent = (0.25 * lv + 0.25).toFixed(2);
    const props = `<style:list-level-properties text:list-level-position-and-space-mode="label-alignment"><style:list-level-label-alignment text:label-followed-by="listtab" text:list-tab-stop-position="${indent}in" fo:text-indent="-0.25in" fo:margin-left="${indent}in"/></style:list-level-properties>`;
    out += ordered
      ? `<text:list-level-style-number text:level="${lv}" style:num-suffix="." style:num-format="1">${props}</text:list-level-style-number>`
      : `<text:list-level-style-bullet text:level="${lv}" text:bullet-char="${lv % 3 === 1 ? '•' : lv % 3 === 2 ? '◦' : '▪'}">${props}</text:list-level-style-bullet>`;
  }
  return `${out}</text:list-style>`;
}

function stylesXml(): string {
  const heads = HEAD_SIZES.map(
    (size, k) =>
      `<style:style style:name="Heading_20_${k + 1}" style:display-name="Heading ${k + 1}" style:family="paragraph" style:parent-style-name="Heading" style:next-style-name="Text_20_body" style:default-outline-level="${k + 1}" style:class="text"><style:text-properties fo:font-size="${size}" fo:font-weight="bold"/></style:style>`
  ).join('');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-styles ${NSDECL} office:version="1.3">${FONTS}<office:styles>` +
    '<style:default-style style:family="paragraph"><style:paragraph-properties fo:margin-top="0in" fo:margin-bottom="0.08in"/><style:text-properties style:font-name="Liberation Serif" fo:font-size="12pt" fo:language="en" fo:country="US"/></style:default-style>' +
    '<style:style style:name="Standard" style:family="paragraph" style:class="text"/>' +
    '<style:style style:name="Text_20_body" style:display-name="Text body" style:family="paragraph" style:parent-style-name="Standard" style:class="text"><style:paragraph-properties fo:margin-top="0in" fo:margin-bottom="0.1in" fo:line-height="115%"/></style:style>' +
    '<style:style style:name="Heading" style:family="paragraph" style:parent-style-name="Standard" style:next-style-name="Text_20_body" style:class="text"><style:paragraph-properties fo:margin-top="0.17in" fo:margin-bottom="0.08in" fo:keep-with-next="always"/><style:text-properties style:font-name="Liberation Sans" fo:font-size="14pt"/></style:style>' +
    heads +
    '<style:style style:name="Quotations" style:family="paragraph" style:parent-style-name="Standard" style:class="html"><style:paragraph-properties fo:margin-left="0.39in" fo:margin-right="0.39in" fo:margin-top="0in" fo:margin-bottom="0.1in"/></style:style>' +
    '<style:style style:name="Preformatted_20_Text" style:display-name="Preformatted Text" style:family="paragraph" style:parent-style-name="Standard" style:class="html"><style:paragraph-properties fo:margin-top="0in" fo:margin-bottom="0in"/><style:text-properties style:font-name="Liberation Mono" fo:font-size="10pt"/></style:style>' +
    '<style:style style:name="Horizontal_20_Line" style:display-name="Horizontal Line" style:family="paragraph" style:parent-style-name="Standard" style:class="html"><style:paragraph-properties fo:margin-top="0in" fo:margin-bottom="0.2in" fo:padding="0in" fo:border-left="none" fo:border-right="none" fo:border-top="none" fo:border-bottom="0.75pt double #808080"/><style:text-properties fo:font-size="6pt"/></style:style>' +
    '<style:style style:name="Table_20_Contents" style:display-name="Table Contents" style:family="paragraph" style:parent-style-name="Standard" style:class="extra"/>' +
    '<style:style style:name="Table_20_Heading" style:display-name="Table Heading" style:family="paragraph" style:parent-style-name="Table_20_Contents" style:class="extra"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-weight="bold"/></style:style>' +
    '<style:style style:name="Internet_20_link" style:display-name="Internet link" style:family="text"><style:text-properties fo:color="#000080" style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"/></style:style>' +
    listStyle('Numbering_20_123', true) +
    listStyle('List_20_1', false) +
    '</office:styles><office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="8.5in" fo:page-height="11in" fo:margin-top="0.79in" fo:margin-bottom="0.79in" fo:margin-left="0.79in" fo:margin-right="0.79in"/></style:page-layout></office:automatic-styles>' +
    '<office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"/></office:master-styles></office:document-styles>'
  );
}

const MARKS = ['b', 'i', 'u', 's', 'code'] as const;
const markKey = (r: Run) => MARKS.filter((k) => r[k]).join('');

function textProps(key: string): string {
  const a: string[] = [];
  if (key.includes('b')) a.push('fo:font-weight="bold" style:font-weight-asian="bold" style:font-weight-complex="bold"');
  if (key.includes('i')) a.push('fo:font-style="italic" style:font-style-asian="italic" style:font-style-complex="italic"');
  if (key.includes('u')) a.push('style:text-underline-style="solid" style:text-underline-width="auto" style:text-underline-color="font-color"');
  if (key.includes('s')) a.push('style:text-line-through-style="solid" style:text-line-through-type="single"');
  if (key.includes('code')) a.push('style:font-name="Liberation Mono"');
  return `<style:text-properties ${a.join(' ')}/>`;
}

class Writer {
  readonly spanStyles = new Map<string, string>();
  tables = 0;

  span(key: string): string {
    let n = this.spanStyles.get(key);
    if (!n) {
      n = `T${this.spanStyles.size + 1}`;
      this.spanStyles.set(key, n);
    }
    return n;
  }

  /** Runs as paragraph content: spaces that ODF would collapse become `text:s`. */
  runs(runs: Run[]): string {
    let out = '';
    let prevSpace = true;
    const text = (t: string) => {
      let s = '';
      for (let k = 0; k < t.length; ) {
        const c = t[k]!;
        if (c === ' ') {
          let n = 0;
          while (t[k + n] === ' ') n++;
          if (prevSpace) s += n === 1 ? '<text:s/>' : `<text:s text:c="${n}"/>`;
          else s += n === 1 ? ' ' : n === 2 ? ' <text:s/>' : ` <text:s text:c="${n - 1}"/>`;
          prevSpace = true;
          k += n;
          continue;
        }
        if (c === '\t') s += '<text:tab/>';
        else if (c === '\n') s += '<text:line-break/>';
        else if (c === '\r') {
          k++;
          continue;
        } else {
          let j = k;
          while (j < t.length && !/[ \t\n\r]/.test(t[j]!)) j++;
          s += xmlText(t.slice(k, j));
          prevSpace = false;
          k = j;
          continue;
        }
        prevSpace = c === '\t' ? false : c === '\n';
        k++;
      }
      return s;
    };
    const list = mergeRuns(runs.map((r) => ({ ...r, href: safeHref(r.href) })).map((r) => (r.href ? r : (({ href: _h, ...rest }) => rest)(r))));
    for (let i = 0; i < list.length; ) {
      const href = list[i]!.href;
      let j = i;
      while (j < list.length && list[j]!.href === href) j++;
      let inner = '';
      for (const r of list.slice(i, j)) {
        const key = markKey(r);
        inner += key ? `<text:span text:style-name="${this.span(key)}">${text(r.text)}</text:span>` : text(r.text);
      }
      out += href ? `<text:a xlink:type="simple" xlink:href="${xmlText(href)}" text:style-name="Internet_20_link" text:visited-style-name="Visited_20_Internet_20_Link">${inner}</text:a>` : inner;
      i = j;
    }
    return out;
  }

  list(l: { ordered: boolean; start?: number; items: ListItem[] }, depth: number): string {
    let out = `<text:list text:style-name="${l.ordered ? 'Numbering_20_123' : 'List_20_1'}">`;
    l.items.forEach((it, n) => {
      const start = n === 0 && l.ordered && l.start !== undefined && l.start !== 1 ? ` text:start-value="${l.start}"` : '';
      const runs = it.checked === undefined ? it.runs : [{ text: it.checked ? '\u2611 ' : '\u2610 ' }, ...it.runs];
      out += `<text:list-item${start}><text:p text:style-name="Standard">${this.runs(runs)}</text:p>`;
      if (it.children && it.children.items.length && depth < 10) out += this.list(it.children, depth + 1);
      out += '</text:list-item>';
    });
    return `${out}</text:list>`;
  }

  block(b: Block): string {
    switch (b.type) {
      case 'heading':
        return `<text:h text:style-name="Heading_20_${b.level}" text:outline-level="${b.level}">${this.runs(b.runs)}</text:h>`;
      case 'paragraph':
        return `<text:p text:style-name="Standard">${this.runs(b.runs)}</text:p>`;
      case 'quote':
        return `<text:p text:style-name="Quotations">${this.runs(b.runs)}</text:p>`;
      case 'code':
        return b.text
          .split('\n')
          .map((line) => `<text:p text:style-name="Preformatted_20_Text">${this.runs(line ? [{ text: line }] : [])}</text:p>`)
          .join('');
      case 'hr':
        return '<text:p text:style-name="Horizontal_20_Line"/>';
      case 'list':
        return b.items.length ? this.list(b, 1) : '';
      case 'table': {
        if (!b.rows.length) return '';
        const width = Math.max(1, ...b.rows.map((r) => r.length));
        const name = `Table${++this.tables}`;
        const row = (r: Run[][], head: boolean) =>
          `<table:table-row>${Array.from({ length: width }, (_, k) => `<table:table-cell office:value-type="string"><text:p text:style-name="${head ? 'Table_20_Heading' : 'Table_20_Contents'}">${this.runs(r[k] ?? [])}</text:p></table:table-cell>`).join('')}</table:table-row>`;
        const head = b.header ? `<table:table-header-rows>${row(b.rows[0]!, true)}</table:table-header-rows>` : '';
        const body = (b.header ? b.rows.slice(1) : b.rows).map((r) => row(r, false)).join('');
        return `<table:table table:name="${name}"><table:table-column table:number-columns-repeated="${width}"/>${head}${body}</table:table>`;
      }
    }
    return '';
  }
}

export function docToOdt(doc: RichDoc, o: { title?: string } = {}): Buffer {
  if (doc.blocks.length > DOC_LIMITS.maxBlocks) throw new DocumentError(`The document has more than ${DOC_LIMITS.maxBlocks} blocks.`);
  const w = new Writer();
  const body = doc.blocks.map((b) => w.block(b)).join('');
  const auto = [...w.spanStyles].map(([key, name]) => `<style:style style:name="${name}" style:family="text">${textProps(key)}</style:style>`).join('');
  const content = `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-content ${NSDECL} office:version="1.3">${FONTS}<office:automatic-styles>${auto}</office:automatic-styles><office:body><office:text>${body || '<text:p text:style-name="Standard"/>'}</office:text></office:body></office:document-content>`;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, '');
  const meta = `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-meta ${NSDECL} office:version="1.3"><office:meta><meta:generator>Exprsn-AI</meta:generator>${o.title ? `<dc:title>${xmlText(o.title)}</dc:title>` : ''}<meta:creation-date>${now}</meta:creation-date><dc:date>${now}</dc:date></office:meta></office:document-meta>`;
  const manifest =
    '<?xml version="1.0" encoding="UTF-8"?>\n<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">' +
    `<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="${MIME.odt}"/>` +
    '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>' +
    '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>' +
    '<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>' +
    '</manifest:manifest>';
  return zip([
    { name: 'mimetype', data: MIME.odt, store: true },
    { name: 'content.xml', data: content },
    { name: 'styles.xml', data: stylesXml() },
    { name: 'meta.xml', data: meta },
    { name: 'META-INF/manifest.xml', data: manifest }
  ]);
}

/** The text of a parsed element (for tests and callers that only need words). */
export const xmlTextOf = textOf;
