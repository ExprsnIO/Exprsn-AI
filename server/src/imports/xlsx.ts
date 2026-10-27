import { headerNames, type Record_ } from './tabular.js';
import { SourceError } from './types.js';
import { zipBytes, zipEntries, zipMember, type Unpack, type ZipEntry } from './zip.js';

/*
 * B-3804: the rows of an xlsx workbook. A workbook is a zip archive of XML parts; this reads the first visible
 * worksheet (or the one named), its first row with a value as the header. Cells are read as values: shared and inline
 * strings, numbers, booleans, and dates (a number whose cell style is a date format) as ISO dates. Formulas give
 * their cached value; a cell holding an error gives none. The parts are read with patterns, not an XML parser: a
 * workbook's markup is produced by a spreadsheet program and is regular, and nothing in it is resolved (no entities
 * beyond the five of XML and character references, no external parts). The older binary `.xls` is not read.
 */

const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const unesc = (s: string): string =>
  s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|lt|gt|amp|quot|apos);/g, (_m, e: string) => {
    if (e[0] !== '#') return ENT[e]!;
    const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
  });
const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return m ? unesc(m[1] ?? m[2] ?? '') : null;
};
/** The text of a string item: its `<t>` runs joined, without the phonetic runs. */
const richText = (xml: string): string => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)].map((m) => unesc(m[1] ?? '')).join('');

const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
/** A number format is a date format when it has a date or time letter outside quotes and brackets. */
const isDateFormat = (code: string): boolean => /[dmyhs]/i.test(code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '')) && !/^general$/i.test(code.trim());

/** A spreadsheet serial number as an ISO date, or date and time when it has a fraction. */
export function serialDate(v: number, date1904: boolean): string | null {
  if (!Number.isFinite(v) || v < 0 || v > 2_958_465) return null;
  const ms = Math.round((v - (date1904 ? -1462 : 0) - 25_569) * 86_400_000);
  const iso = new Date(ms).toISOString();
  return Number.isInteger(v) ? iso.slice(0, 10) : iso.slice(0, 19);
}

const columnIndex = (ref: string): number => {
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
};

const MAX_COLUMNS = 2000;
const MAX_SHARED = 5_000_000;

async function part(buf: Buffer, entries: ZipEntry[], name: string, unpack: Unpack): Promise<string | null> {
  const e = entries.find((x) => x.name === name) ?? entries.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return e ? (await zipBytes(buf, e, unpack)).toString('utf8') : null;
}

/** The worksheets of a workbook, in tab order. */
function sheetsOf(workbook: string, rels: string | null): { name: string; path: string; hidden: boolean }[] {
  const targets = new Map<string, string>();
  for (const m of (rels ?? '').matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const id = attr(m[1]!, 'Id');
    const target = attr(m[1]!, 'Target');
    if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`);
  }
  const out: { name: string; path: string; hidden: boolean }[] = [];
  let n = 0;
  for (const m of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    n++;
    const rid = attr(m[1]!, 'r:id') ?? attr(m[1]!, 'id');
    const path = (rid && targets.get(rid)) || `xl/worksheets/sheet${n}.xml`;
    if (path.split('/').includes('..')) continue;
    out.push({ name: attr(m[1]!, 'name') ?? `Sheet${n}`, path, hidden: (attr(m[1]!, 'state') ?? 'visible') !== 'visible' });
  }
  return out;
}

export interface XlsxOptions {
  unpack: Unpack;
  /** The worksheet to read, by name; the first visible one without it. */
  sheet?: string | null;
}

/** The worksheets of a workbook held in memory, in tab order (Sprint 45, B-127: the import's sheet choice). */
export async function xlsxSheets(buf: Buffer, unpack: Unpack): Promise<{ name: string; hidden: boolean }[]> {
  const entries = zipEntries(buf);
  const workbook = await part(buf, entries, 'xl/workbook.xml', unpack);
  if (!workbook) throw new SourceError('The file is not an xlsx workbook (it has no xl/workbook.xml). The older .xls format is not read.');
  return sheetsOf(workbook, await part(buf, entries, 'xl/_rels/workbook.xml.rels', unpack)).map((x) => ({ name: x.name, hidden: x.hidden }));
}

/**
 * The rows of one worksheet as they stand, without a header: each with its row number (1-based, as the sheet numbers
 * it) and its cells by column index. Rows without a value are left out. `xlsxRecords` reads its header from these;
 * the app import (B-127) picks its own header row and range.
 */
export async function* xlsxRows(buf: Buffer, o: XlsxOptions): AsyncGenerator<{ row: number; values: unknown[] }> {
  const entries = zipEntries(buf);
  const workbook = await part(buf, entries, 'xl/workbook.xml', o.unpack);
  if (!workbook) throw new SourceError('The file is not an xlsx workbook (it has no xl/workbook.xml). The older .xls format is not read.');
  const sheets = sheetsOf(workbook, await part(buf, entries, 'xl/_rels/workbook.xml.rels', o.unpack));
  const sheet = o.sheet ? sheets.find((s) => s.name === o.sheet) : (sheets.find((s) => !s.hidden) ?? sheets[0]);
  if (!sheet) throw new SourceError(o.sheet ? `The workbook has no worksheet named ${o.sheet.slice(0, 80)}. It has ${sheets.map((s) => s.name).slice(0, 12).join(', ')}.` : 'The workbook has no worksheet.');
  const entry = entries.find((x) => x.name === sheet.path);
  if (!entry) throw new SourceError(`The workbook lists the worksheet ${sheet.name} but does not hold it.`);

  const shared: string[] = [];
  const sst = await part(buf, entries, 'xl/sharedStrings.xml', o.unpack);
  if (sst) {
    for (const m of sst.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) {
      if (shared.length >= MAX_SHARED) throw new SourceError(`The workbook has more than ${MAX_SHARED.toLocaleString('en-US')} distinct strings.`);
      shared.push(richText(m[1] ?? ''));
    }
  }
  // Which cell styles are dates: the number format of each `xf` in `cellXfs`.
  const dateStyle: boolean[] = [];
  const styles = await part(buf, entries, 'xl/styles.xml', o.unpack);
  if (styles) {
    const custom = new Map<number, string>();
    for (const m of styles.matchAll(/<numFmt\b([^>]*?)\/?>/g)) custom.set(Number(attr(m[1]!, 'numFmtId')), attr(m[1]!, 'formatCode') ?? '');
    const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
    for (const m of xfs.matchAll(/<xf\b([^>]*?)\/?>/g)) {
      const id = Number(attr(m[1]!, 'numFmtId') ?? 0);
      dateStyle.push(custom.has(id) ? isDateFormat(custom.get(id)!) : BUILTIN_DATE.has(id));
    }
  }
  const date1904 = /<workbookPr\b[^>]*\bdate1904\s*=\s*["'](1|true)["']/.test(workbook);

  const cells = (rowXml: string): unknown[] => {
    const out: unknown[] = [];
    let next = 0;
    for (const m of rowXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(m[1]!, 'r');
      const col = ref ? columnIndex(ref) : next;
      next = col + 1;
      if (col < 0 || col >= MAX_COLUMNS) continue;
      const t = attr(m[1]!, 't') ?? 'n';
      const inner = m[2] ?? '';
      const raw = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let v: unknown;
      if (t === 'inlineStr') v = richText(inner);
      else if (raw == null) v = null;
      else if (t === 's') v = shared[Number(raw)] ?? null;
      else if (t === 'str' || t === 'd') v = unesc(raw);
      else if (t === 'b') v = raw.trim() === '1';
      else if (t === 'e') v = null;
      else {
        const num = Number(raw);
        v = !Number.isFinite(num) ? unesc(raw) : dateStyle[Number(attr(m[1]!, 's') ?? -1)] ? (serialDate(num, date1904) ?? num) : num;
      }
      while (out.length < col) out.push(null);
      out[col] = v;
    }
    return out;
  };

  const dec = new TextDecoder('utf-8');
  let text = '';
  let seq = 0;
  const rows = function* (final: boolean): Generator<{ row: number; values: unknown[] }> {
    for (;;) {
      const open = text.search(/<row\b/);
      if (open < 0) {
        // Nothing of a row yet: keep only a tail that could be the start of one.
        if (!final) text = text.slice(-8);
        return;
      }
      const tagEnd = text.indexOf('>', open);
      if (tagEnd < 0) return;
      const stated = Number(attr(text.slice(open + 4, tagEnd), 'r'));
      const rowNo = Number.isInteger(stated) && stated > 0 ? stated : seq + 1;
      let end: number;
      let body: string;
      if (text[tagEnd - 1] === '/') {
        end = tagEnd + 1;
        body = '';
      } else {
        const close = text.indexOf('</row>', tagEnd);
        if (close < 0) {
          text = text.slice(open);
          if (text.length > 64 * 1024 * 1024) throw new SourceError('A row of the worksheet is larger than 64 MB.');
          return;
        }
        end = close + 6;
        body = text.slice(tagEnd + 1, close);
      }
      text = text.slice(end);
      seq = rowNo;
      const values = cells(body);
      if (!values.some((v) => v != null && v !== '')) continue;
      yield { row: rowNo, values };
    }
  };
  for await (const chunk of zipMember(buf, entry, o.unpack)) {
    text += dec.decode(chunk, { stream: true });
    yield* rows(false);
  }
  text += dec.decode();
  yield* rows(true);
}

/** The rows of one worksheet of a workbook held in memory, its first row with a value as the header. */
export async function* xlsxRecords(buf: Buffer, o: XlsxOptions): AsyncGenerator<Record_> {
  let header: string[] | null = null;
  for await (const { values } of xlsxRows(buf, o)) {
    if (!header) {
      header = headerNames(values.map((v) => (v == null ? '' : String(v))));
      continue;
    }
    const rec: Record_ = {};
    for (const [i, name] of header.entries()) rec[name] = values[i] ?? null;
    yield rec;
  }
}
