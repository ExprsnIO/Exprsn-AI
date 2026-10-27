import { z } from 'zod';
import { delimitedRows, fileKind, fileRecords, headerNames, jsonRows, textChunks, type Record_ } from '../imports/tabular.js';
import { SourceError } from '../imports/types.js';
import { xlsxRows, xlsxSheets } from '../imports/xlsx.js';
import { isZip, type Unpack } from '../imports/zip.js';
import type { Row } from './import-transforms.js';

/*
 * Sprint 45 (B-127): the rows of a file imported into an app entity, over the dataset import's readers
 * (`imports/tabular.ts` for CSV, TSV, JSON and JSON Lines, `imports/xlsx.ts` for workbooks, with `imports/zip.ts`'s
 * limits). The bytes come from the file store or an attachment, which have been through quarantine, type sniffing
 * and the scan; this module only reads them, within:
 *
 * - `maxBytes` (IMPORT_ARCHIVE_MAX_BYTES): the most bytes of a file read here (each is read whole);
 * - `unpackedBytes` (IMPORT_ARCHIVE_MAX_UNPACKED_BYTES): the most a workbook unpacks to, every part counted;
 * - `maxRows` (APPS_IMPORT_MAX_ROWS): more data rows than this refuse the import (the job writes each as a record).
 *
 * A workbook's sheet, header row and range are chosen; a delimited file's header row and range too (its columns are
 * lettered like a sheet's). JSON is an array of objects, the usual wrapper keys (`data`, `records`, …) or a dotted
 * path to the array.
 */

export const FORMATS = ['csv', 'tsv', 'json', 'jsonl', 'xlsx'] as const;
export type ImportFormat = (typeof FORMATS)[number];

/** `A1:F200`, `A3:F`, `3:200`, `B:D`: columns by letter, rows by number, either side open. */
export const RANGE = /^([A-Z]{1,3})?(\d{1,7})?(?::([A-Z]{1,3})?(\d{1,7})?)?$/;

export const readOptionsSchema = {
  format: z.enum(FORMATS).optional(),
  /** A workbook's sheet by name (the first visible one without it). */
  sheet: z.string().min(1).max(200).optional(),
  /** The row that names the columns (1-based); the first row with a value in the range without it. */
  headerRow: z.number().int().min(1).max(1_000_000).optional(),
  range: z.string().trim().toUpperCase().max(20).regex(RANGE, 'a range such as A1:F200, A3:F or 2:500').optional(),
  /** JSON: the dotted path to the array of rows (`data.items`). */
  jsonPath: z.string().max(200).regex(/^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+){0,9}$/, 'a dotted path such as data.items').optional()
};
// Parsed again here (other keys of the source are dropped), so a caller cannot pass options the schema has not checked.
const readOptions = z.object(readOptionsSchema);
export type ReadOptions = z.infer<typeof readOptions>;

export interface ReadLimits {
  maxBytes: number;
  unpackedBytes: number;
  maxRows: number;
}

export interface Table {
  format: ImportFormat;
  columns: string[];
  rows: Row[];
  sheets?: { name: string; hidden: boolean }[];
  sheet?: string | null;
  headerRow?: number | null;
}

/** A refusal of the file itself (too large, too many rows, not readable), shown as the problem's detail. */
export class ReadError extends Error {
  constructor(
    message: string,
    readonly status = 422
  ) {
    super(message);
  }
}

const colIndex = (letters: string): number => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
export const colLetters = (i: number): string => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

interface Bounds {
  c0: number;
  c1: number;
  r0: number;
  r1: number;
}

export function parseRange(range: string | undefined): Bounds {
  const out: Bounds = { c0: 0, c1: Number.MAX_SAFE_INTEGER, r0: 1, r1: Number.MAX_SAFE_INTEGER };
  if (!range) return out;
  const m = RANGE.exec(range);
  if (!m) throw new ReadError(`${range} is not a range such as A1:F200.`, 400);
  const [, ca, ra, cb, rb] = m;
  const single = !range.includes(':');
  if (ca) out.c0 = colIndex(ca);
  if (ra) out.r0 = Number(ra);
  if (cb) out.c1 = colIndex(cb);
  else if (single && ca) out.c1 = Number.MAX_SAFE_INTEGER;
  if (rb) out.r1 = Number(rb);
  if (out.c1 < out.c0 || out.r1 < out.r0) throw new ReadError(`The range ${range} ends before it starts.`, 400);
  return out;
}

/** Rows as arrays with their numbers into a table: the header row names the columns, the rows below are the data. */
async function tabulate(raw: AsyncIterable<{ row: number; values: unknown[] }>, o: ReadOptions, limits: ReadLimits): Promise<{ columns: string[]; rows: Row[]; headerRow: number }> {
  const b = parseRange(o.range);
  let header: string[] | null = null;
  let headerRow = 0;
  const rows: Row[] = [];
  for await (const r of raw) {
    if (r.row < b.r0) continue;
    if (r.row > b.r1) break;
    if (o.headerRow && r.row < o.headerRow) continue;
    const cells = r.values.slice(b.c0, b.c1 === Number.MAX_SAFE_INTEGER ? undefined : b.c1 + 1);
    const has = cells.some((v) => v != null && v !== '');
    if (!header) {
      if (!has) continue;
      if (o.headerRow && r.row !== o.headerRow) throw new ReadError(`Row ${o.headerRow} is empty; pick the row that names the columns.`, 400);
      header = headerNames(cells.map((v) => (v == null ? '' : String(v))));
      headerRow = r.row;
      continue;
    }
    if (!has) continue;
    if (rows.length >= limits.maxRows) throw new ReadError(`The file has more than ${limits.maxRows.toLocaleString('en-US')} data rows (APPS_IMPORT_MAX_ROWS). Split it, or choose a range.`, 413);
    const values: Record_ = {};
    header.forEach((name, i) => {
      values[name] = cells[i] ?? null;
    });
    rows.push({ n: r.row, values });
  }
  if (!header) throw new ReadError(o.headerRow ? `The file has no row ${o.headerRow} with a value.` : 'The file has no rows with a value.', 400);
  return { columns: header, rows, headerRow };
}

/** The format of a file: as asked, else by its name, else by its first bytes. */
export function formatOf(bytes: Buffer, name: string | null, asked?: ImportFormat): ImportFormat {
  if (asked) return asked;
  const k = name ? fileKind(null, name) : null;
  if (k && !k.gzip && (FORMATS as readonly string[]).includes(k.kind)) return k.kind as ImportFormat;
  if (isZip(bytes.subarray(0, 4))) return 'xlsx';
  const head = bytes.subarray(0, 512).toString('utf8').replace(/^\ufeff/, '').trimStart();
  if (head.startsWith('[')) return 'json';
  if (head.startsWith('{')) return /^\{[^\n]*\}\s*\n\s*\{/.test(bytes.subarray(0, 65_536).toString('utf8').trimStart()) ? 'jsonl' : 'json';
  return 'csv';
}

async function* once(b: Buffer): AsyncGenerator<Uint8Array> {
  yield b;
}

const recordOf = (v: unknown, n: number): Record_ => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record_;
  throw new ReadError(`Item ${n} of the JSON array is not an object.`);
};

function objectTable(items: Record_[], limits: ReadLimits): { columns: string[]; rows: Row[] } {
  if (items.length > limits.maxRows) throw new ReadError(`The file has more than ${limits.maxRows.toLocaleString('en-US')} records (APPS_IMPORT_MAX_ROWS). Split it.`, 413);
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    for (const k of Object.keys(it)) {
      if (seen.has(k) || columns.length >= 500) continue;
      seen.add(k);
      columns.push(k);
    }
  }
  return { columns, rows: items.map((values, i) => ({ n: i + 1, values: Object.fromEntries(columns.map((c) => [c, values[c] ?? null])) })) };
}

/** Reads a file held in memory into a table. Throws ReadError (or the readers' SourceError) when it cannot. */
export async function readTable(bytes: Buffer, name: string | null, input: ReadOptions, limits: ReadLimits): Promise<Table> {
  const o = readOptions.parse(input);
  if (bytes.length > limits.maxBytes) throw new ReadError(`The file is ${bytes.length.toLocaleString('en-US')} bytes; an import reads at most ${limits.maxBytes.toLocaleString('en-US')} (IMPORT_ARCHIVE_MAX_BYTES).`, 413);
  const format = formatOf(bytes, name, o.format);
  try {
    if (format === 'xlsx') {
      if (!isZip(bytes.subarray(0, 4))) throw new ReadError('The file is not an xlsx workbook.');
      const unpack: Unpack = { used: 0, max: limits.unpackedBytes };
      const sheets = await xlsxSheets(bytes, unpack);
      const sheet = o.sheet ?? (sheets.find((s) => !s.hidden) ?? sheets[0])?.name ?? null;
      const t = await tabulate(xlsxRows(bytes, { unpack, sheet }), o, limits);
      return { format, ...t, sheets, sheet };
    }
    if (format === 'csv' || format === 'tsv') {
      const text = textChunks(once(bytes), { maxBytes: limits.maxBytes });
      const numbered = (async function* () {
        let n = 0;
        for await (const r of delimitedRows(text, { delimiter: format === 'tsv' ? '\t' : null })) yield { row: ++n, values: r as unknown[] };
      })();
      return { format, ...(await tabulate(numbered, o, limits)) };
    }
    if (format === 'jsonl') {
      const items: Record_[] = [];
      for await (const r of fileRecords(once(bytes), 'jsonl', { maxBytes: limits.maxBytes })) {
        items.push(r);
        if (items.length > limits.maxRows) break;
      }
      return { format, ...objectTable(items, limits) };
    }
    let doc: unknown;
    try {
      doc = JSON.parse(bytes.toString('utf8').replace(/^\ufeff/, ''));
    } catch {
      throw new ReadError('The file is not valid JSON.');
    }
    let arr: unknown[];
    if (o.jsonPath) {
      let at: unknown = doc;
      for (const k of o.jsonPath.split('.')) at = at && typeof at === 'object' && !Array.isArray(at) ? (at as Record_)[k] : undefined;
      if (!Array.isArray(at)) throw new ReadError(`${o.jsonPath} is not an array in the file.`, 400);
      arr = at;
    } else arr = jsonRows(doc);
    return { format, ...objectTable(arr.map((v, i) => recordOf(v, i + 1)), limits) };
  } catch (err) {
    if (err instanceof SourceError) throw new ReadError(err.message, /larger than|unpacks to more/.test(err.message) ? 413 : 422);
    throw err;
  }
}

/** Rows from a table-shaped answer (a connection's columns and rows, or a list of objects). */
export function tableOf(columns: string[], rows: unknown[][], start = 1): { columns: string[]; rows: Row[] } {
  const names = headerNames(columns);
  return { columns: names, rows: rows.map((r, i) => ({ n: start + i, values: Object.fromEntries(names.map((c, j) => [c, r[j] ?? null])) })) };
}
