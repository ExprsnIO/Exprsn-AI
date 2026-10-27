import { z } from 'zod';
import { ExtractionError, zipEntries } from '../../knowledge/extract.js';
import { serialDate } from '../../imports/xlsx.js';
import { columnName, xmlText } from '../../imports/xlsx-writer.js';
import { zip } from '../../platform/zip-writer.js';
import { COLUMN_TYPES, DOC_LIMITS, DocumentError, MIME, type Cell, type CellValue, type Column, type Sheet, type Workbook } from './model.js';
import { columnLetter, inferColumns } from './normalize.js';

/*
 * Spreadsheets as the Workbook model: CSV, Excel (.xlsx) and OpenDocument spreadsheets (.ods), read and written.
 *
 * The XML parts are read with a small element parser (`parseXml`) that resolves nothing: the five XML entities and
 * character references only, and a part with a DOCTYPE is refused, so no entity expansion or outside reference can
 * happen. Archives are read with `knowledge/extract.ts` (its inflate is capped) and written with
 * `platform/zip-writer.ts`.
 *
 * What a workbook can hold that the model cannot (merged cells, charts, images, comments, validation, conditional
 * formats, shared formulas past their first cell) is left out or kept as values, and named in `notes`.
 */

// ---------- limits ----------

const L = DOC_LIMITS;
export const tooMany = (what: string, max: number) => new DocumentError(`The workbook has more ${what} than the ${max.toLocaleString('en-US')} that can be edited here.`);

export class Budget {
  cells = 0;
  add(n: number): void {
    this.cells += n;
    if (this.cells > L.maxCells) throw tooMany('cells', L.maxCells);
  }
}

export const checkText = (s: string): string => {
  if (s.length > L.maxCellChars) throw new DocumentError(`A cell holds more than ${L.maxCellChars.toLocaleString('en-US')} characters.`);
  return s;
};

// ---------- a small XML element parser ----------

interface XEl {
  name: string;
  attrs: Record<string, string>;
  kids: XNode[];
}
type XNode = XEl | string;

const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const unesc = (s: string): string =>
  s.indexOf('&') < 0
    ? s
    : s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|lt|gt|amp|quot|apos);/g, (_m, e: string) => {
        if (e[0] !== '#') return ENT[e]!;
        const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
      });

const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!([A-Za-z]+)|<\/([^\s>]+)\s*>|<([A-Za-z_][\w.:-]*)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)|(<)/y;
const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const MAX_NODES = 8_000_000;

function parseXml(xml: string, part: string): XEl {
  const root: XEl = { name: '#document', attrs: {}, kids: [] };
  const stack: XEl[] = [root];
  let nodes = 0;
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < xml.length) {
    const m = TOKEN.exec(xml);
    if (!m) throw new DocumentError(`${part} is not well-formed XML.`);
    const top = stack[stack.length - 1]!;
    if (m[2] !== undefined) throw new DocumentError(`${part} declares a ${m[2].toUpperCase() === 'DOCTYPE' ? 'DOCTYPE' : m[2]}, which is not accepted.`);
    if (m[9] !== undefined) throw new DocumentError(`${part} is not well-formed XML.`);
    if (m[1] !== undefined) top.kids.push(m[1]);
    else if (m[3] !== undefined) {
      const at = stack.map((e) => e.name).lastIndexOf(m[3]);
      if (at > 0) stack.length = at;
    } else if (m[4] !== undefined) {
      if (++nodes > MAX_NODES) throw new DocumentError(`${part} is too large to edit here.`);
      const attrs: Record<string, string> = {};
      for (const a of (m[5] ?? '').matchAll(ATTR)) attrs[a[1]!] = unesc(a[2] ?? a[3] ?? '');
      const el: XEl = { name: m[4], attrs, kids: [] };
      top.kids.push(el);
      if (m[6] !== '/') stack.push(el);
    } else if (m[7] !== undefined) top.kids.push(unesc(m[7]));
  }
  return root;
}

const local = (name: string) => name.slice(name.indexOf(':') + 1);
const els = (e: XEl | undefined, name?: string): XEl[] => (e ? (e.kids.filter((k) => typeof k !== 'string' && (!name || local(k.name) === name)) as XEl[]) : []);
const el = (e: XEl | undefined, name: string): XEl | undefined => els(e, name)[0];
/** The first descendant (depth first) with this local name. */
function find(e: XEl | undefined, name: string): XEl | undefined {
  if (!e) return undefined;
  for (const k of e.kids) {
    if (typeof k === 'string') continue;
    if (local(k.name) === name) return k;
    const hit = find(k, name);
    if (hit) return hit;
  }
  return undefined;
}
function findAll(e: XEl | undefined, name: string, out: XEl[] = []): XEl[] {
  if (!e) return out;
  for (const k of e.kids) {
    if (typeof k === 'string') continue;
    if (local(k.name) === name) out.push(k);
    else findAll(k, name, out);
  }
  return out;
}
/** An attribute by its qualified name, else by its local name (prefixes vary between writers). */
function attr(e: XEl | undefined, q: string): string | undefined {
  if (!e) return undefined;
  if (q in e.attrs) return e.attrs[q];
  const want = local(q);
  for (const [k, v] of Object.entries(e.attrs)) if (local(k) === want) return v;
  return undefined;
}
const textOf = (e: XNode): string => (typeof e === 'string' ? e : e.kids.map(textOf).join(''));

// ---------- archives ----------

function openZip(buf: Buffer, what: string): (name: string) => string | null {
  let entries: Map<string, () => Buffer>;
  try {
    entries = zipEntries(buf);
  } catch (err) {
    throw new DocumentError(`The file is not a readable ${what}: ${(err as Error).message}`);
  }
  const lower = new Map([...entries.keys()].map((k) => [k.toLowerCase(), k]));
  return (name) => {
    const key = entries.has(name) ? name : lower.get(name.toLowerCase());
    if (!key) return null;
    try {
      return entries.get(key)!().toString('utf8');
    } catch (err) {
      if (err instanceof ExtractionError) throw new DocumentError(`The ${what} could not be read: ${err.message}`);
      throw err;
    }
  };
}

// ---------- shared helpers ----------

const isText = (c: Cell | undefined): boolean => !!c && !c.f && typeof c.v === 'string' && c.v.trim() !== '';
/** A first row reads as a header when every cell of it is non-empty text and data follows. */
const looksLikeHeader = (rows: Cell[][]): boolean => rows.length > 1 && (rows[0]?.length ?? 0) > 0 && rows[0]!.every(isText);

export function finishSheet(name: string, rows: Cell[][], widths: (number | undefined)[], header?: boolean): Sheet {
  const n = Math.max(0, ...rows.map((r) => r.length));
  if (n > L.maxColumns) throw tooMany('columns', L.maxColumns);
  for (const r of rows) for (let i = 0; i < r.length; i++) if (!r[i]) r[i] = { v: null };
  const columns: Column[] = Array.from({ length: n }, (_, i) => ({ name: columnLetter(i), type: 'text' as const, ...(widths[i] != null ? { width: widths[i] } : {}) }));
  const sheet: Sheet = { name, header: header ?? looksLikeHeader(rows), columns, rows };
  sheet.columns = inferColumns(sheet);
  return sheet;
}

/** A sheet name a spreadsheet accepts, unique in the workbook. */
export function sheetName(raw: string, taken: Set<string>): string {
  const base = raw.replace(/[[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || 'Sheet';
  let name = base;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base.slice(0, 31 - ` (${i})`.length)} (${i})`;
  taken.add(name.toLowerCase());
  return name;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/;

/** An ISO date or date-time (no zone) as a serial number of the 1900 date system, or null. */
function toSerial(v: string): number | null {
  const d = ISO_DATE.test(v) ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : ISO_DATETIME.exec(v);
  if (!d) return null;
  const ms = Date.UTC(+d[1]!, +d[2]! - 1, +d[3]!, +(d[4] ?? 0), +(d[5] ?? 0), +(d[6] ?? 0));
  if (!Number.isFinite(ms)) return null;
  const serial = ms / 86_400_000 + 25_569;
  return serial >= 1 ? Math.round(serial * 86_400) / 86_400 : null;
}

/** A number as plain digits (no exponent) when it is in an everyday range. */
function plainNumber(n: number): string {
  const s = String(n);
  if (!/e/i.test(s)) return s;
  return n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
}

// ---------- CSV ----------

const DELIMITERS = [',', ';', '\t', '|'] as const;

/** Counts of each candidate delimiter outside quotes on the first lines; the most consistent one wins. */
function sniff(text: string): string {
  const lines: Record<string, number>[] = [];
  let cur: Record<string, number> = {};
  let quoted = false;
  for (let i = 0; i < text.length && lines.length < 20; i++) {
    const ch = text[i]!;
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      lines.push(cur);
      cur = {};
    } else if (!quoted && (DELIMITERS as readonly string[]).includes(ch)) cur[ch] = (cur[ch] ?? 0) + 1;
  }
  if (Object.keys(cur).length || !lines.length) lines.push(cur);
  let best = ',';
  let bestScore = -1;
  for (const d of DELIMITERS) {
    const counts = lines.map((l) => l[d] ?? 0);
    const min = Math.min(...counts);
    const total = counts.reduce((a, b) => a + b, 0);
    if (!total) continue;
    // Consistent on every line beats more on some.
    const score = (min > 0 && counts.every((c) => c === counts[0]) ? 1_000_000 : min > 0 ? 1_000 : 0) + total;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

function parseCsv(text: string, d: string, budget: Budget): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  // Whether anything of the current field, and of the current row, has been read.
  let inField = false;
  let inRow = false;
  const endField = () => {
    row.push(checkText(field));
    if (row.length > L.maxColumns) throw tooMany('columns', L.maxColumns);
    field = '';
    inField = false;
  };
  const endRow = () => {
    endField();
    budget.add(row.length);
    rows.push(row);
    row = [];
    inRow = false;
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"' && !inField) {
      // A quoted field: up to the closing quote, "" for a quote.
      inField = inRow = true;
      i++;
      for (;;) {
        const q = text.indexOf('"', i);
        if (q < 0) {
          field += text.slice(i);
          i = text.length;
          break;
        }
        field += text.slice(i, q);
        if (text[q + 1] === '"') {
          field += '"';
          i = q + 2;
        } else {
          i = q + 1;
          break;
        }
      }
    } else if (ch === d) {
      endField();
      inRow = true;
      i++;
    } else if (ch === '\r' || ch === '\n') {
      endRow();
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      // Plain text up to the next delimiter, quote or line end, in one step.
      let j = i + 1;
      while (j < text.length) {
        const c = text[j]!;
        if (c === d || c === '\r' || c === '\n' || c === '"') break;
        j++;
      }
      field += text.slice(i, j);
      inField = inRow = true;
      i = j;
    }
  }
  if (inRow) endRow();
  return rows;
}

export function csvToWorkbook(text: string, o: { delimiter?: ',' | ';' | '\t' | '|' } = {}): { workbook: Workbook; delimiter: string } {
  const t = text.replace(/^\uFEFF/, '');
  const delimiter = o.delimiter ?? sniff(t);
  const grid = parseCsv(t, delimiter, new Budget());
  const rows = grid.map((r) => r.map((v): Cell => ({ v })));
  const sheet: Sheet = { name: 'Sheet1', header: true, columns: [], rows };
  if (Math.max(0, ...rows.map((r) => r.length)) > L.maxColumns) throw tooMany('columns', L.maxColumns);
  sheet.columns = inferColumns(sheet);
  return { workbook: { sheets: [sheet] }, delimiter };
}

const csvValue = (c: Cell | undefined): string => {
  if (!c) return '';
  const v = c.v == null && c.f ? `=${c.f}` : c.v;
  if (v == null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? plainNumber(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return v;
};

export function workbookToCsv(sheet: Sheet, delimiter = ','): string {
  const quote = (s: string) => (s.includes(delimiter) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return sheet.rows.map((r) => r.map((c) => quote(csvValue(c))).join(delimiter) + '\r\n').join('');
}

// ---------- XLSX: reading ----------

export const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
export const isDateFormat = (code: string): boolean => /[dmyhs]/i.test(code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '')) && !/^general$/i.test(code.trim());
const on = (e: XEl | undefined): boolean => !!e && !['0', 'false'].includes((attr(e, 'val') ?? '1').toLowerCase());

/** A cell reference's 0-based column and row (A1 → 0, 0). */
function refOf(ref: string): { col: number; row: number } | null {
  const m = /^\$?([A-Z]{1,4})\$?(\d{1,8})$/.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(m[2]) - 1 };
}

/** A string item's text: its `<t>` runs, without phonetic runs. */
const siText = (si: XEl): string =>
  si.kids
    .map((k) => (typeof k === 'string' ? '' : local(k.name) === 't' ? textOf(k) : local(k.name) === 'r' ? els(k, 't').map(textOf).join('') : ''))
    .join('');

export function xlsxToWorkbook(buf: Buffer): { workbook: Workbook; notes: string[] } {
  const part = openZip(buf, 'xlsx workbook');
  const wbXml = part('xl/workbook.xml');
  if (!wbXml) throw new DocumentError('The file is not an xlsx workbook (it has no xl/workbook.xml).');
  const wb = parseXml(wbXml, 'xl/workbook.xml');
  const notes = new Set<string>();
  const date1904 = ['1', 'true'].includes(attr(find(wb, 'workbookPr'), 'date1904') ?? '');

  const targets = new Map<string, string>();
  const rels = part('xl/_rels/workbook.xml.rels');
  if (rels) {
    for (const r of findAll(parseXml(rels, 'xl/_rels/workbook.xml.rels'), 'Relationship')) {
      const id = attr(r, 'Id');
      const target = attr(r, 'Target');
      if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);
    }
  }

  const shared: string[] = [];
  const sst = part('xl/sharedStrings.xml');
  if (sst) for (const si of findAll(parseXml(sst, 'xl/sharedStrings.xml'), 'si')) shared.push(siText(si));

  // Per cell style: date or date-time format, bold, italic.
  const xfs: { date: boolean; b: boolean; i: boolean }[] = [];
  const stylesXml = part('xl/styles.xml');
  if (stylesXml) {
    const st = parseXml(stylesXml, 'xl/styles.xml');
    const custom = new Map<number, string>();
    for (const f of findAll(find(st, 'numFmts'), 'numFmt')) custom.set(Number(attr(f, 'numFmtId')), attr(f, 'formatCode') ?? '');
    const fonts = els(find(st, 'fonts'), 'font').map((f) => ({ b: on(el(f, 'b')), i: on(el(f, 'i')) }));
    for (const x of els(find(st, 'cellXfs'), 'xf')) {
      const id = Number(attr(x, 'numFmtId') ?? 0);
      const font = fonts[Number(attr(x, 'fontId') ?? 0)];
      xfs.push({ date: custom.has(id) ? isDateFormat(custom.get(id)!) : BUILTIN_DATE.has(id), b: !!font?.b, i: !!font?.i });
    }
  }

  const list = findAll(find(wb, 'sheets'), 'sheet');
  if (list.length > L.maxSheets) throw tooMany('sheets', L.maxSheets);
  const budget = new Budget();
  const sheets: Sheet[] = [];
  list.forEach((s, n) => {
    const name = attr(s, 'name') ?? `Sheet${n + 1}`;
    const rid = attr(s, 'r:id') ?? attr(s, 'id');
    const path = (rid && targets.get(rid)) || `xl/worksheets/sheet${n + 1}.xml`;
    if (path.split('/').includes('..')) throw new DocumentError(`The workbook points the sheet ${name} outside itself.`);
    const xml = part(path);
    if (xml == null) throw new DocumentError(`The workbook lists the sheet ${name} but does not hold it.`);
    if ((attr(s, 'state') ?? 'visible') !== 'visible') notes.add(`The sheet ${name} is hidden in the workbook; it is shown here and saved visible.`);
    const ws = parseXml(xml, path);
    if (find(ws, 'mergeCells')) notes.add('Merged cells are shown as separate cells and saved unmerged.');
    if (find(ws, 'drawing') || find(ws, 'legacyDrawing')) notes.add('Charts, images and comments are not shown and are left out when the workbook is saved.');
    if (find(ws, 'dataValidations')) notes.add('Data validation rules are left out when the workbook is saved.');
    if (find(ws, 'conditionalFormatting')) notes.add('Conditional formats are left out when the workbook is saved.');

    const widths: (number | undefined)[] = [];
    for (const c of findAll(find(ws, 'cols'), 'col')) {
      const w = Number(attr(c, 'width'));
      if (!Number.isFinite(w)) continue;
      const min = Math.max(1, Number(attr(c, 'min') ?? 1));
      const max = Math.min(L.maxColumns, Number(attr(c, 'max') ?? min));
      for (let i = min; i <= max; i++) widths[i - 1] = Math.round(w * 100) / 100;
    }

    const rows: Cell[][] = [];
    let nextRow = 0;
    for (const r of findAll(find(ws, 'sheetData'), 'row')) {
      const stated = Number(attr(r, 'r'));
      const ri = Number.isInteger(stated) && stated > 0 ? stated - 1 : nextRow;
      nextRow = ri + 1;
      if (ri >= L.maxCells) throw tooMany('rows', L.maxCells);
      let nextCol = 0;
      for (const c of els(r, 'c')) {
        const at = refOf(attr(c, 'r') ?? '') ?? { col: nextCol, row: ri };
        nextCol = at.col + 1;
        if (at.col >= L.maxColumns) throw tooMany('columns', L.maxColumns);
        const t = attr(c, 't') ?? 'n';
        const style = xfs[Number(attr(c, 's') ?? 0)];
        const fEl = el(c, 'f');
        const raw = el(c, 'v') ? textOf(el(c, 'v')!) : undefined;
        let v: CellValue;
        if (t === 'inlineStr') v = el(c, 'is') ? siText(el(c, 'is')!) : '';
        else if (raw == null) v = null;
        else if (t === 's') v = shared[Number(raw)] ?? null;
        else if (t === 'str' || t === 'd' || t === 'e') v = raw;
        else if (t === 'b') v = raw.trim() === '1' || raw.trim().toLowerCase() === 'true';
        else {
          const num = Number(raw);
          v = !Number.isFinite(num) ? raw : style?.date ? (serialDate(num, date1904) ?? num) : num;
        }
        let f: string | undefined;
        if (fEl) {
          const text = textOf(fEl).trim();
          const kind = attr(fEl, 't');
          if (text && kind !== 'dataTable') f = text;
          else if (kind === 'shared') notes.add('Formulas copied across cells (shared formulas) are kept as values past their first cell.');
        }
        if (v == null && !f) continue;
        if (typeof v === 'string') checkText(v);
        const cell: Cell = { v };
        if (f) cell.f = f;
        if (style?.b) cell.b = true;
        if (style?.i) cell.i = true;
        while (rows.length <= ri) rows.push([]);
        const row = rows[ri]!;
        while (row.length < at.col) row.push({ v: null });
        if (row.length === at.col) budget.add(1);
        row[at.col] = cell;
      }
    }
    budget.add(rows.reduce((n, r) => n + r.filter((c) => c.v == null && !c.f).length, 0));
    sheets.push(finishSheet(name, rows, widths));
  });
  if (!sheets.length) sheets.push({ name: 'Sheet1', header: false, columns: [], rows: [] });
  return { workbook: { sheets }, notes: [...notes] };
}

// ---------- XLSX: writing ----------

const XLSX_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
/** Style index: number format (0 general, 1 date, 2 date and time) times four, plus the font (0, bold, italic, both). */
const xfIndex = (fmt: 0 | 1 | 2, b: boolean, i: boolean) => fmt * 4 + (b ? 1 : 0) + (i ? 2 : 0);
const preserve = (s: string) => (/^\s|\s$|\n/.test(s) ? ' xml:space="preserve"' : '');

function xlsxSheetXml(sheet: Sheet, strings: { id(s: string): number }): string {
  const n = Math.max(sheet.columns.length, ...sheet.rows.map((r) => r.length), 1);
  const widths = sheet.columns.map((c) => c.width).filter((w): w is number => w != null);
  const cols = widths.length
    ? `<cols>${sheet.columns
        .map((c, i) => (c.width != null ? `<col min="${i + 1}" max="${i + 1}" width="${Math.round(c.width * 100) / 100}" customWidth="1"/>` : ''))
        .join('')}</cols>`
    : '';
  const pane = sheet.header && sheet.rows.length ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' : '';
  const out: string[] = [];
  sheet.rows.forEach((row, ri) => {
    const cells: string[] = [];
    row.forEach((c, ci) => {
      if (!c) return;
      const ref = `${columnName(ci)}${ri + 1}`;
      const head = sheet.header && ri === 0;
      const type = head ? 'text' : (sheet.columns[ci]?.type ?? 'text');
      let v = c.v;
      let fmt: 0 | 1 | 2 = 0;
      if (typeof v === 'string' && (type === 'date' || type === 'datetime') && !c.f) {
        const serial = toSerial(v);
        if (serial != null) {
          fmt = Number.isInteger(serial) && ISO_DATE.test(v) ? 1 : 2;
          v = serial;
        }
      }
      const s = xfIndex(fmt, !!c.b || head, !!c.i);
      const sAttr = s ? ` s="${s}"` : '';
      if (c.f) {
        const f = `<f>${xmlText(c.f.replace(/^=/, ''))}</f>`;
        if (v == null) cells.push(`<c r="${ref}"${sAttr}>${f}</c>`);
        else if (typeof v === 'number' && Number.isFinite(v)) cells.push(`<c r="${ref}"${sAttr}>${f}<v>${v}</v></c>`);
        else if (typeof v === 'boolean') cells.push(`<c r="${ref}"${sAttr} t="b">${f}<v>${v ? 1 : 0}</v></c>`);
        else cells.push(`<c r="${ref}"${sAttr} t="str">${f}<v>${xmlText(String(v))}</v></c>`);
        return;
      }
      if (v == null || v === '') {
        if (s) cells.push(`<c r="${ref}"${sAttr}/>`);
        return;
      }
      if (typeof v === 'number') cells.push(Number.isFinite(v) ? `<c r="${ref}"${sAttr}><v>${v}</v></c>` : `<c r="${ref}"${sAttr} t="s"><v>${strings.id(String(v))}</v></c>`);
      else if (typeof v === 'boolean') cells.push(`<c r="${ref}"${sAttr} t="b"><v>${v ? 1 : 0}</v></c>`);
      else cells.push(`<c r="${ref}"${sAttr} t="s"><v>${strings.id(v)}</v></c>`);
    });
    if (cells.length) out.push(`<row r="${ri + 1}">${cells.join('')}</row>`);
  });
  const last = `${columnName(n - 1)}${Math.max(1, sheet.rows.length)}`;
  return (
    XLSX_XML +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>` +
    cols +
    `<sheetData>${out.join('')}</sheetData>` +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>'
  );
}

export function workbookToXlsx(wb: Workbook): Buffer {
  if (!wb.sheets.length) throw new DocumentError('A workbook has at least one sheet.');
  const list: string[] = [];
  const index = new Map<string, number>();
  const strings = {
    id(s: string): number {
      let i = index.get(s);
      if (i == null) {
        i = list.length;
        list.push(s);
        index.set(s, i);
      }
      return i;
    }
  };
  const taken = new Set<string>();
  const names = wb.sheets.map((s) => sheetName(s.name, taken));
  const sheetXml = wb.sheets.map((s) => xlsxSheetXml(s, strings));
  const fonts = ['', '<b/>', '<i/>', '<b/><i/>'].map((x) => `<font>${x}<sz val="11"/><name val="Calibri"/><family val="2"/></font>`).join('');
  const xfs = [0, 164, 165]
    .flatMap((fmt) => [0, 1, 2, 3].map((font) => `<xf numFmtId="${fmt}" fontId="${font}" fillId="0" borderId="0" xfId="0"${fmt ? ' applyNumberFormat="1"' : ''}${font ? ' applyFont="1"' : ''}/>`))
    .join('');
  return zip([
    {
      name: '[Content_Types].xml',
      data:
        XLSX_XML +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        wb.sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>'
    },
    {
      name: '_rels/.rels',
      data: XLSX_XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
    },
    {
      name: 'xl/workbook.xml',
      data:
        XLSX_XML +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>' +
        names.map((n, i) => `<sheet name="${xmlText(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        '</sheets><calcPr calcId="0" fullCalcOnLoad="1"/></workbook>'
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        XLSX_XML +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        wb.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${wb.sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        `<Relationship Id="rId${wb.sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`
    },
    {
      name: 'xl/styles.xml',
      data:
        XLSX_XML +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts>' +
        `<fonts count="4">${fonts}</fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        `<cellXfs count="12">${xfs}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`
    },
    ...sheetXml.map((data, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data })),
    {
      name: 'xl/sharedStrings.xml',
      data: XLSX_XML + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${list.length}" uniqueCount="${list.length}">${list.map((s) => `<si><t${preserve(s)}>${xmlText(s)}</t></si>`).join('')}</sst>`
    }
  ]);
}

// ---------- ODS: formulas ----------

/** Splits a formula into literal strings (odd indices) and the rest (even indices). */
const outsideStrings = (f: string, fn: (s: string) => string): string =>
  f
    .split(/("(?:[^"]|"")*")/)
    .map((part, i) => (i % 2 ? part : fn(part)))
    .join('');

/** `of:=SUM([.A1:.A3];[$Sheet2.B1])` → `SUM(A1:A3,Sheet2!B1)`. */
export function fromOdfFormula(f: string): string {
  const body = f.replace(/^(?:[a-z]+:)?=/i, '');
  return outsideStrings(body, (s) =>
    s
      .replace(/\[([^\]]*)\]/g, (_m, inner: string) => {
        const parts = inner.split(':').map((p) => {
          const m = /^\$?('(?:[^']|'')*'|[^.]*)\.(.+)$/.exec(p);
          return m ? { sheet: m[1]!, cell: m[2]! } : { sheet: '', cell: p };
        });
        const sheet = parts[0]!.sheet;
        const prefix = sheet ? `${/^'/.test(sheet) || /^[A-Za-z_][\w.]*$/.test(sheet) ? sheet : `'${sheet.replace(/'/g, "''")}'`}!` : '';
        return prefix + parts.map((p) => p.cell).join(':');
      })
      .replace(/;/g, ',')
  );
}

/** `SUM(A1:A3,Sheet2!B1)` → `of:=SUM([.A1:.A3];[$Sheet2.B1])`. */
export function toOdfFormula(f: string): string {
  const body = f.replace(/^=/, '');
  const REF = /(?<![\w.$'])(?:('(?:[^']|'')+'|[A-Za-z_][\w.]*)!)?(\$?[A-Z]{1,3}\$?\d{1,7})(?::(\$?[A-Z]{1,3}\$?\d{1,7}))?(?![\w(])/g;
  return (
    'of:=' +
    outsideStrings(body, (s) =>
      s
        .replace(/,/g, ';')
        .replace(REF, (_m, sheet: string | undefined, a: string, b: string | undefined) => `[${sheet ? `$${sheet}` : ''}.${a}${b ? `:.${b}` : ''}]`)
    )
  );
}

// ---------- ODS: reading ----------

/** A paragraph's text: spans and links followed, `text:s` spaces, tabs and line breaks kept, raw whitespace collapsed. */
function odfText(e: XEl): string {
  let out = '';
  for (const k of e.kids) {
    if (typeof k === 'string') {
      out += k.replace(/[ \t\r\n]+/g, ' ');
      continue;
    }
    const n = local(k.name);
    if (n === 's') out += ' '.repeat(Math.min(10_000, Math.max(1, Number(attr(k, 'text:c') ?? 1) || 1)));
    else if (n === 'tab') out += '\t';
    else if (n === 'line-break') out += '\n';
    else if (n === 'annotation' || n === 'note') continue;
    else out += odfText(k);
  }
  return out;
}

/** A length in characters from an ODF length (cm, mm, in, pt): about 0.25 cm a character. */
function odfWidth(len: string | undefined): number | undefined {
  const m = /^([\d.]+)(cm|mm|in|pt|pc)$/.exec(len ?? '');
  if (!m) return undefined;
  const cm = Number(m[1]) * ({ cm: 1, mm: 0.1, in: 2.54, pt: 2.54 / 72, pc: 2.54 / 6 } as Record<string, number>)[m[2]!]!;
  return Math.round((cm / 0.25) * 100) / 100;
}

export function odsToWorkbook(buf: Buffer): { workbook: Workbook; notes: string[] } {
  const part = openZip(buf, 'OpenDocument spreadsheet');
  const mime = part('mimetype');
  if (mime != null && mime.trim() !== MIME.ods) throw new DocumentError(`The file is ${mime.trim().slice(0, 80) || 'not'} an OpenDocument spreadsheet.`);
  const xml = part('content.xml');
  if (!xml) throw new DocumentError('The file is not an OpenDocument spreadsheet (it has no content.xml).');
  const doc = parseXml(xml, 'content.xml');
  const notes = new Set<string>();

  const cellStyles = new Map<string, { b: boolean; i: boolean }>();
  const colWidths = new Map<string, number>();
  for (const st of [...findAll(find(doc, 'automatic-styles'), 'style'), ...findAll(find(doc, 'styles'), 'style')]) {
    const name = attr(st, 'style:name');
    if (!name) continue;
    const family = attr(st, 'style:family');
    if (family === 'table-cell') {
      const tp = find(st, 'text-properties');
      cellStyles.set(name, { b: attr(tp, 'fo:font-weight') === 'bold' || Number(attr(tp, 'fo:font-weight')) >= 600, i: attr(tp, 'fo:font-style') === 'italic' });
    } else if (family === 'table-column') {
      const w = odfWidth(attr(find(st, 'table-column-properties'), 'style:column-width'));
      if (w != null) colWidths.set(name, w);
    }
  }

  const tables = findAll(find(doc, 'spreadsheet'), 'table');
  if (tables.length > L.maxSheets) throw tooMany('sheets', L.maxSheets);
  const budget = new Budget();
  const sheets: Sheet[] = [];
  tables.forEach((t, n) => {
    const name = attr(t, 'table:name') ?? `Sheet${n + 1}`;
    const widths: (number | undefined)[] = [];
    for (const c of findAll(t, 'table-column')) {
      const rep = Math.min(L.maxColumns, Math.max(1, Number(attr(c, 'table:number-columns-repeated') ?? 1) || 1));
      const w = colWidths.get(attr(c, 'table:style-name') ?? '');
      for (let i = 0; i < rep && widths.length < L.maxColumns; i++) widths.push(w);
    }
    if (find(t, 'shapes') || findAll(t, 'frame').length) notes.add('Charts and images are not shown and are left out when the spreadsheet is saved.');

    const rows: Cell[][] = [];
    let pendingRows = 0;
    for (const r of findAll(t, 'table-row')) {
      const row: Cell[] = [];
      let pendingCells = 0;
      for (const c of r.kids) {
        if (typeof c === 'string') continue;
        const kind = local(c.name);
        if (kind !== 'table-cell' && kind !== 'covered-table-cell') continue;
        const rep = Math.max(1, Number(attr(c, 'table:number-columns-repeated') ?? 1) || 1);
        const formula = attr(c, 'table:formula');
        const vt = attr(c, 'office:value-type');
        const paras = els(c, 'p');
        let v: CellValue = null;
        if (vt === 'float' || vt === 'percentage' || vt === 'currency') {
          const num = Number(attr(c, 'office:value'));
          v = Number.isFinite(num) ? num : null;
        } else if (vt === 'date') v = attr(c, 'office:date-value') ?? null;
        else if (vt === 'boolean') v = ['true', '1'].includes((attr(c, 'office:boolean-value') ?? '').toLowerCase());
        else if (vt === 'time') v = paras.length ? paras.map(odfText).join('\n') : (attr(c, 'office:time-value') ?? null);
        else if (vt === 'string' || paras.length) v = attr(c, 'office:string-value') ?? paras.map(odfText).join('\n');
        if (kind === 'covered-table-cell' && (v == null || v === '')) notes.add('Merged cells are shown as separate cells and saved unmerged.');
        if (typeof v === 'string') checkText(v);
        if (v == null && !formula) {
          // Empty cells: expanded only when something follows them in the row.
          pendingCells += rep;
          continue;
        }
        if (row.length + pendingCells + rep > L.maxColumns) throw tooMany('columns', L.maxColumns);
        for (; pendingCells > 0; pendingCells--) row.push({ v: null });
        const style = cellStyles.get(attr(c, 'table:style-name') ?? '');
        for (let i = 0; i < rep; i++) {
          const cell: Cell = { v };
          if (formula) cell.f = fromOdfFormula(formula);
          if (style?.b) cell.b = true;
          if (style?.i) cell.i = true;
          row.push(cell);
        }
      }
      const rep = Math.max(1, Number(attr(r, 'table:number-rows-repeated') ?? 1) || 1);
      if (!row.length) {
        pendingRows += rep;
        continue;
      }
      if (rows.length + pendingRows + rep > L.maxCells) throw tooMany('rows', L.maxCells);
      for (; pendingRows > 0; pendingRows--) rows.push([]);
      for (let i = 0; i < rep; i++) {
        budget.add(row.length);
        rows.push(i ? row.map((c) => ({ ...c })) : row);
      }
    }
    sheets.push(finishSheet(name, rows, widths));
  });
  if (!sheets.length) sheets.push({ name: 'Sheet1', header: false, columns: [], rows: [] });
  return { workbook: { sheets }, notes: [...notes] };
}

// ---------- ODS: writing ----------

const ODF_NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2" ' +
  'xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" office:version="1.3"';

/** One line of a paragraph: runs of spaces as `text:s`, tabs as `text:tab`. */
const odfLine = (s: string): string =>
  s
    .split(/(\t| {2,}|^ )/)
    .map((p) => (p === '\t' ? '<text:tab/>' : /^ +$/.test(p) && p.length ? (p.length === 1 ? '<text:s/>' : ` <text:s text:c="${p.length - 1}"/>`) : xmlText(p)))
    .join('');
const odfParas = (s: string) => s.split('\n').map((l) => `<text:p>${odfLine(l)}</text:p>`).join('');

function odsCell(c: Cell | undefined, type: Column['type'], head: boolean): string {
  if (!c || (c.v == null && !c.f && !c.b && !c.i)) return '<table:table-cell/>';
  const bold = !!c.b || head;
  const style = bold && c.i ? 'ce3' : bold ? 'ce1' : c.i ? 'ce2' : '';
  const s = style ? ` table:style-name="${style}"` : '';
  const f = c.f ? ` table:formula="${xmlText(toOdfFormula(c.f))}"` : '';
  const v = c.v;
  if (v == null) return `<table:table-cell${s}${f}/>`;
  if (typeof v === 'number' && Number.isFinite(v)) return `<table:table-cell${s}${f} office:value-type="float" office:value="${v}"><text:p>${xmlText(plainNumber(v))}</text:p></table:table-cell>`;
  if (typeof v === 'boolean') return `<table:table-cell${s}${f} office:value-type="boolean" office:boolean-value="${v}"><text:p>${v ? 'TRUE' : 'FALSE'}</text:p></table:table-cell>`;
  const text = String(v);
  if (!head && (type === 'date' || type === 'datetime') && (ISO_DATE.test(text) || ISO_DATETIME.test(text))) return `<table:table-cell${s}${f} office:value-type="date" office:date-value="${xmlText(text.replace(' ', 'T'))}"><text:p>${xmlText(text)}</text:p></table:table-cell>`;
  return `<table:table-cell${s}${f} office:value-type="string">${odfParas(text)}</table:table-cell>`;
}

export function workbookToOds(wb: Workbook): Buffer {
  if (!wb.sheets.length) throw new DocumentError('A workbook has at least one sheet.');
  const taken = new Set<string>();
  const colStyles: string[] = [];
  const tables = wb.sheets.map((sheet) => {
    const name = sheetName(sheet.name, taken);
    const n = Math.max(sheet.columns.length, ...sheet.rows.map((r) => r.length), 1);
    const cols = Array.from({ length: n }, (_, i) => {
      const w = sheet.columns[i]?.width;
      if (w == null) return '<table:table-column/>';
      const id = `co${colStyles.length + 1}`;
      colStyles.push(`<style:style style:name="${id}" style:family="table-column"><style:table-column-properties style:column-width="${(w * 0.25).toFixed(3)}cm"/></style:style>`);
      return `<table:table-column table:style-name="${id}"/>`;
    }).join('');
    const rows = sheet.rows
      .map((r, ri) => {
        const head = sheet.header && ri === 0;
        const cells = r.map((c, ci) => odsCell(c, sheet.columns[ci]?.type ?? 'text', head));
        // Trailing empty cells need not be written.
        while (cells.length && cells[cells.length - 1] === '<table:table-cell/>') cells.pop();
        return `<table:table-row>${cells.length ? cells.join('') : '<table:table-cell/>'}</table:table-row>`;
      })
      .join('');
    return `<table:table table:name="${xmlText(name)}">${cols}${rows || '<table:table-row><table:table-cell/></table:table-row>'}</table:table>`;
  });
  const content =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<office:document-content ${ODF_NS}><office:automatic-styles>${colStyles.join('')}` +
    '<style:style style:name="ce1" style:family="table-cell"><style:text-properties fo:font-weight="bold"/></style:style>' +
    '<style:style style:name="ce2" style:family="table-cell"><style:text-properties fo:font-style="italic"/></style:style>' +
    '<style:style style:name="ce3" style:family="table-cell"><style:text-properties fo:font-weight="bold" fo:font-style="italic"/></style:style>' +
    `</office:automatic-styles><office:body><office:spreadsheet>${tables.join('')}</office:spreadsheet></office:body></office:document-content>`;
  return zip([
    { name: 'mimetype', data: MIME.ods, store: true },
    {
      name: 'META-INF/manifest.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8"?>\n<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">' +
        `<manifest:file-entry manifest:full-path="/" manifest:version="1.3" manifest:media-type="${MIME.ods}"/>` +
        '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>' +
        '<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/></manifest:manifest>'
    },
    { name: 'content.xml', data: content },
    { name: 'styles.xml', data: `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-styles ${ODF_NS}><office:styles/></office:document-styles>` },
    { name: 'meta.xml', data: `<?xml version="1.0" encoding="UTF-8"?>\n<office:document-meta ${ODF_NS}><office:meta><meta:generator>Exprsn-AI</meta:generator></office:meta></office:document-meta>` }
  ]);
}

// ---------- validating a model from a request ----------

const cellSchema = z
  .object({
    v: z.union([z.string().max(L.maxCellChars), z.number(), z.boolean(), z.null()]),
    f: z.string().min(1).max(8192).optional(),
    b: z.boolean().optional(),
    i: z.boolean().optional()
  })
  .strict();
const columnSchema = z
  .object({
    name: z.string().max(255),
    type: z.enum(COLUMN_TYPES),
    width: z.number().min(0).max(255).optional(),
    required: z.boolean().optional()
  })
  .strict();
const sheetSchema = z
  .object({
    name: z.string().min(1).max(31),
    header: z.boolean(),
    columns: z.array(columnSchema).max(L.maxColumns),
    rows: z.array(z.array(cellSchema).max(L.maxColumns)).max(L.maxCells)
  })
  .strict();
const workbookSchema = z.object({ sheets: z.array(sheetSchema).min(1).max(L.maxSheets) }).strict();

/** An untrusted workbook from a request, checked against the model and the limits. */
export function validateWorkbook(input: unknown): Workbook {
  const r = workbookSchema.safeParse(input);
  if (!r.success) {
    const issue = r.error.issues[0]!;
    throw new DocumentError(`The workbook is not valid at ${issue.path.join('.') || 'its top level'}: ${issue.message}`);
  }
  const wb = r.data as Workbook;
  const seen = new Set<string>();
  let cells = 0;
  for (const s of wb.sheets) {
    if (/[[\]:*?/\\]/.test(s.name) || /^'|'$/.test(s.name)) throw new DocumentError(`The sheet name ${s.name} has a character spreadsheets do not allow ([ ] : * ? / \\ or a quote at either end).`);
    if (seen.has(s.name.toLowerCase())) throw new DocumentError(`Two sheets are named ${s.name}.`);
    seen.add(s.name.toLowerCase());
    for (const row of s.rows) cells += row.length;
    if (cells > L.maxCells) throw tooMany('cells', L.maxCells);
  }
  return wb;
}
