import { z } from 'zod';
import { type Cell, type CellValue, type Column, type ColumnType, type Sheet } from './model.js';

/*
 * Column types and normalising for tables (CSV and spreadsheets). Pure functions over the sheet model: nothing here
 * reads or writes files.
 *
 * A column's type is inferred from its data rows: a type wins when at least 90% of the non-empty values read as it.
 * Normalising cleans the data rows of a sheet (the header row is left as it is, apart from `headerCase`): spaces,
 * empty markers such as N/A, values converted to their column's type (numbers without thousands separators or
 * currency signs, booleans as true or false, dates as YYYY-MM-DD), empty and duplicate rows, ragged rows. A value that
 * does not convert is kept as it was and reported, so nothing is lost silently. Formula cells are never changed.
 */

const SHARE = 0.9;
export const DEFAULT_EMPTY_MARKERS = ['NULL', 'null', 'N/A', 'n/a', 'NA', '-', '—'];

// ---------- reading values ----------

const isEmpty = (v: CellValue): boolean => v == null || (typeof v === 'string' && v.trim() === '');

/** A number written by a person: thousands separators, currency signs, a sign or brackets for negatives. */
export function parseNumber(raw: string): number | null {
  let s = raw.trim().replace(/[\s\u00a0\u202f]/g, '');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/^([+-]?)[$€£¥₹]/, '$1').replace(/[$€£¥₹]$/, '');
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else if (/^[+-]?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^[+-]?\d+,\d{1,2}$/.test(s) || /^[+-]?\d+,\d{4,}$/.test(s)) s = s.replace(',', '.');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

const TRUE = new Set(['true', 'yes', 'y', 't', '1']);
const FALSE = new Set(['false', 'no', 'n', 'f', '0']);
export function parseBoolean(raw: string): boolean | null {
  const s = raw.trim().toLowerCase();
  return TRUE.has(s) ? true : FALSE.has(s) ? false : null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthOf = (name: string): number | null => {
  const i = MONTHS.indexOf(name.slice(0, 3).toLowerCase());
  return i < 0 ? null : i + 1;
};
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function ymd(y: number, m: number, d: number): string | null {
  if (y < 100) y += y < 50 ? 2000 : 1900;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1000 || y > 9999) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
}

/** A date as YYYY-MM-DD: ISO, d/m/y or m/d/y (`dayFirst` decides only when both read), "12 Mar 2024", "Mar 12, 2024". */
export function parseDate(raw: string, dayFirst = false): string | null {
  const s = raw.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return ymd(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const a = +m[1]!;
    const b = +m[2]!;
    const y = +m[3]!;
    if (a > 12) return ymd(y, b, a);
    if (b > 12) return ymd(y, a, b);
    return dayFirst ? ymd(y, b, a) : ymd(y, a, b);
  }
  m = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})\.?,?[\s-]+(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const mo = monthOf(m[2]!);
    return mo ? ymd(+m[3]!, mo, +m[1]!) : null;
  }
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s);
  if (m) {
    const mo = monthOf(m[1]!);
    return mo ? ymd(+m[3]!, mo, +m[2]!) : null;
  }
  return null;
}

/** A date and time as YYYY-MM-DDTHH:MM:SS (with the offset when one was given). */
export function parseDateTime(raw: string, dayFirst = false): string | null {
  const m = /^(.+?)[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*([AaPp][Mm])?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(raw.trim());
  if (!m) return null;
  const date = parseDate(m[1]!, dayFirst);
  if (!date) return null;
  let h = +m[2]!;
  const min = +m[3]!;
  const sec = m[4] ? +m[4] : 0;
  if (m[5]) {
    if (h < 1 || h > 12) return null;
    const pm = m[5].toLowerCase() === 'pm';
    h = (h % 12) + (pm ? 12 : 0);
  }
  if (h > 23 || min > 59 || sec > 59) return null;
  const zone = m[6] ? (m[6] === 'Z' ? 'Z' : m[6].length === 5 ? `${m[6].slice(0, 3)}:${m[6].slice(3)}` : m[6]) : '';
  return `${date}T${pad(h)}:${pad(min)}:${pad(sec)}${zone}`;
}

const EMAIL = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+\.[A-Za-z]{2,}$/;
const URL_RE = /^(https?:\/\/|www\.)[^\s]+\.[^\s]+$/i;

const asText = (v: CellValue): string => (v == null ? '' : typeof v === 'string' ? v : String(v));

/** Whether one non-empty value reads as the type. */
function fits(type: ColumnType, v: CellValue): boolean {
  if (typeof v === 'number') return type === 'number' || (type === 'integer' && Number.isInteger(v));
  if (typeof v === 'boolean') return type === 'boolean';
  const s = asText(v).trim();
  switch (type) {
    case 'integer': {
      // A code with leading zeros (007, 00123) is not a number.
      if (/^[+-]?0\d/.test(s)) return false;
      const n = parseNumber(s);
      return n != null && Number.isInteger(n) && !/[.,]\d*$/.test(s.replace(/,\d{3}/g, ''));
    }
    case 'number':
      return !/^[+-]?0\d+$/.test(s) && parseNumber(s.replace(/%$/, '')) != null;
    case 'boolean':
      return parseBoolean(s) != null;
    case 'date':
      return parseDate(s) != null;
    case 'datetime':
      return parseDateTime(s) != null;
    case 'email':
      return EMAIL.test(s);
    case 'url':
      return URL_RE.test(s);
    default:
      return true;
  }
}

/** The type that at least 90% of the non-empty values read as; text when none does. */
export function inferColumnType(values: CellValue[]): ColumnType {
  const vals = values.filter((v) => !isEmpty(v));
  if (!vals.length) return 'text';
  const need = Math.ceil(vals.length * SHARE);
  const count = (t: ColumnType) => vals.reduce<number>((n, v) => n + (fits(t, v) ? 1 : 0), 0);
  // Only 0 and 1 are numbers, not booleans: a boolean column has at least one word in it.
  const words = vals.some((v) => typeof v === 'boolean' || (typeof v === 'string' && /^[a-z]+$/i.test(v.trim())));
  if (words && count('boolean') >= need) return 'boolean';
  if (count('integer') >= need) return 'integer';
  if (count('number') >= need) return 'number';
  if (count('date') >= need) return 'date';
  if (count('datetime') >= need) return 'datetime';
  if (count('email') >= need) return 'email';
  if (count('url') >= need) return 'url';
  return 'text';
}

export const columnLetter = (i: number): string => {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

const widthOf = (sheet: Sheet): number => Math.max(sheet.columns.length, ...sheet.rows.map((r) => r.length), 0);

/** Columns named from the header row (or A, B, …), typed from the data rows; widths and required flags are kept. */
export function inferColumns(sheet: Sheet): Column[] {
  const n = widthOf(sheet);
  const data = sheet.header ? sheet.rows.slice(1) : sheet.rows;
  const head = sheet.header ? (sheet.rows[0] ?? []) : [];
  const out: Column[] = [];
  for (let i = 0; i < n; i++) {
    const prev = sheet.columns[i];
    const name = sheet.header ? asText(head[i]?.v ?? null).trim() || columnLetter(i) : columnLetter(i);
    const col: Column = { name, type: inferColumnType(data.map((r) => (r[i]?.f ? null : (r[i]?.v ?? null)))) };
    if (prev?.width != null) col.width = prev.width;
    if (prev?.required) col.required = true;
    out.push(col);
  }
  return out;
}

// ---------- normalising ----------

export interface NormalizeOptions {
  trim?: boolean;
  collapseSpaces?: boolean;
  emptyMarkers?: string[];
  coerce?: boolean;
  dayFirst?: boolean;
  removeEmptyRows?: boolean;
  removeEmptyColumns?: boolean;
  dedupe?: boolean;
  padRows?: boolean;
  textCase?: 'none' | 'lower' | 'upper' | 'title';
  headerCase?: 'none' | 'snake' | 'title' | 'lower';
}

export interface NormalizeReport {
  changedCells: number;
  removedRows: number;
  removedColumns: number;
  duplicateRows: number;
  invalidCount: number;
  /** The first 500; `row` and `col` are 0-based in the returned grid (the header row is row 0 when there is one). */
  invalid: { row: number; col: number; column: string; value: string; reason: string }[];
  requiredMissing: number;
}

const optionsSchema = z
  .object({
    trim: z.boolean().optional(),
    collapseSpaces: z.boolean().optional(),
    emptyMarkers: z.array(z.string().max(40)).max(50).optional(),
    coerce: z.boolean().optional(),
    dayFirst: z.boolean().optional(),
    removeEmptyRows: z.boolean().optional(),
    removeEmptyColumns: z.boolean().optional(),
    dedupe: z.boolean().optional(),
    padRows: z.boolean().optional(),
    textCase: z.enum(['none', 'lower', 'upper', 'title']).optional(),
    headerCase: z.enum(['none', 'snake', 'title', 'lower']).optional()
  })
  .strict();

export function validateNormalizeOptions(input: unknown): NormalizeOptions {
  return optionsSchema.parse(input ?? {});
}

const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s\-_/(])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());
const snakeCase = (s: string) =>
  s
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '');

const MAX_INVALID = 500;

/** Converts one string to a column's type: the new value, or `bad` with why when it does not read as the type. */
function convert(type: ColumnType, s: string, o: { dayFirst: boolean; percent: boolean }): { v: CellValue } | { bad: string } {
  switch (type) {
    case 'number': {
      const pct = /%$/.test(s.trim());
      const n = parseNumber(s.replace(/%\s*$/, ''));
      if (n == null) return { bad: 'not a number' };
      return { v: pct && o.percent ? Number((n / 100).toPrecision(15)) : n };
    }
    case 'integer': {
      const n = parseNumber(s);
      if (n == null) return { bad: 'not a number' };
      if (!Number.isInteger(n)) return { bad: 'not a whole number' };
      return { v: n };
    }
    case 'boolean': {
      const b = parseBoolean(s);
      return b == null ? { bad: 'not true or false' } : { v: b };
    }
    case 'date': {
      const d = parseDate(s, o.dayFirst) ?? parseDateTime(s, o.dayFirst)?.slice(0, 10) ?? null;
      return d ? { v: d } : { bad: 'not a date' };
    }
    case 'datetime': {
      const d = parseDateTime(s, o.dayFirst) ?? (parseDate(s, o.dayFirst) ? `${parseDate(s, o.dayFirst)}T00:00:00` : null);
      return d ? { v: d } : { bad: 'not a date and time' };
    }
    case 'email':
      return EMAIL.test(s) ? { v: s.toLowerCase() } : { bad: 'not an email address' };
    case 'url':
      return URL_RE.test(s) ? { v: s } : { bad: 'not a web address' };
    default:
      return { v: s };
  }
}

/** Normalises a sheet's data rows. Never changes its argument. */
export function normalizeSheet(sheet: Sheet, opts: NormalizeOptions = {}): { sheet: Sheet; report: NormalizeReport } {
  const o = {
    trim: opts.trim ?? true,
    collapseSpaces: opts.collapseSpaces ?? true,
    emptyMarkers: new Set(opts.emptyMarkers ?? DEFAULT_EMPTY_MARKERS),
    coerce: opts.coerce ?? true,
    dayFirst: opts.dayFirst ?? false,
    removeEmptyRows: opts.removeEmptyRows ?? true,
    removeEmptyColumns: opts.removeEmptyColumns ?? false,
    dedupe: opts.dedupe ?? false,
    padRows: opts.padRows ?? true,
    textCase: opts.textCase ?? 'none',
    headerCase: opts.headerCase ?? 'none'
  };
  const report: NormalizeReport = { changedCells: 0, removedRows: 0, removedColumns: 0, duplicateRows: 0, invalidCount: 0, invalid: [], requiredMissing: 0 };
  let ncols = widthOf(sheet);
  const inferred = inferColumns(sheet);
  let columns: Column[] = Array.from({ length: ncols }, (_, i) => ({ ...(sheet.columns[i] ?? inferred[i]!) }));
  const header: Cell[] | null = sheet.header ? (sheet.rows[0] ?? []).map((c) => ({ ...c })) : null;
  let data: Cell[][] = (sheet.header ? sheet.rows.slice(1) : sheet.rows).map((r) => r.map((c) => ({ ...c })));

  // A column takes percentages as fractions only when every value in it is written with %.
  const percent = columns.map((c, i) => {
    if (c.type !== 'number') return false;
    const vals = data.map((r) => r[i]).filter((x): x is Cell => !!x && !x.f && typeof x.v === 'string' && x.v.trim() !== '');
    return vals.length > 0 && vals.every((x) => /%\s*$/.test(x.v as string));
  });

  // Problems are kept against the row objects and column indices, and placed once rows and columns have moved.
  const problems: { row: Cell[]; col: number; value: string; reason: string }[] = [];
  for (const row of data) {
    for (let i = 0; i < row.length; i++) {
      const cell = row[i]!;
      if (cell.f) continue;
      const before = cell.v;
      let v = cell.v;
      if (typeof v === 'string') {
        if (o.trim) v = v.trim();
        if (o.collapseSpaces) v = v.replace(/[ \t\u00a0]{2,}/g, ' ').replace(/\t/g, ' ');
        if (o.emptyMarkers.has(v.trim())) v = '';
      }
      const col = columns[i];
      const type = col?.type ?? 'text';
      if (o.coerce && !isEmpty(v) && type !== 'text') {
        if (typeof v === 'string') {
          const r = convert(type, v, { dayFirst: o.dayFirst, percent: percent[i] ?? false });
          if ('bad' in r) problems.push({ row, col: i, value: v, reason: r.bad });
          else v = r.v;
        } else if (typeof v === 'number' && type === 'boolean' && (v === 0 || v === 1)) v = v === 1;
        else if (typeof v === 'number' && type === 'integer' && !Number.isInteger(v)) problems.push({ row, col: i, value: String(v), reason: 'not a whole number' });
        else if (typeof v === 'boolean' && type !== 'boolean') problems.push({ row, col: i, value: String(v), reason: `not ${type === 'integer' ? 'a number' : `a ${type}`}` });
        else if (typeof v === 'number' && (type === 'email' || type === 'url' || type === 'date' || type === 'datetime')) problems.push({ row, col: i, value: String(v), reason: `not ${type === 'email' ? 'an email address' : type === 'url' ? 'a web address' : 'a date'}` });
      }
      if (typeof v === 'string' && type === 'text' && v && o.textCase !== 'none') v = o.textCase === 'lower' ? v.toLowerCase() : o.textCase === 'upper' ? v.toUpperCase() : titleCase(v);
      if (v !== before) {
        cell.v = v;
        report.changedCells++;
      }
    }
  }

  if (o.removeEmptyRows) {
    const kept = data.filter((r) => r.some((c) => !!c.f || !isEmpty(c.v)));
    report.removedRows = data.length - kept.length;
    data = kept;
  }
  if (o.dedupe) {
    const seen = new Set<string>();
    const kept: Cell[][] = [];
    for (const r of data) {
      const key = JSON.stringify(r.map((c) => [c.v ?? null, c.f ?? null]).concat(Array.from({ length: Math.max(0, ncols - r.length) }, () => [null, null])).map((x) => (x[0] === '' && x[1] == null ? [null, null] : x)));
      if (seen.has(key)) {
        report.duplicateRows++;
        continue;
      }
      seen.add(key);
      kept.push(r);
    }
    data = kept;
  }
  // Column positions after the empty columns go: index map from old to new (-1 when removed).
  let map = Array.from({ length: ncols }, (_, i) => i);
  let headerOut = header;
  if (o.removeEmptyColumns && ncols) {
    const keep = Array.from({ length: ncols }, (_, i) => data.some((r) => !!r[i]?.f || !isEmpty(r[i]?.v ?? null)));
    let n = 0;
    map = keep.map((k) => (k ? n++ : -1));
    report.removedColumns = ncols - n;
    if (report.removedColumns) {
      const pick = <T>(arr: T[]) => arr.filter((_, i) => i >= keep.length || keep[i]);
      // In place, so the problems still point at their rows.
      for (const r of data) {
        const out = pick(r);
        r.length = 0;
        r.push(...out);
      }
      headerOut = header ? pick(header) : null;
      columns = pick(columns);
      ncols = n;
    }
  }
  if (o.padRows) {
    for (const r of data) while (r.length < ncols) r.push({ v: null });
    if (headerOut) while (headerOut.length < ncols) headerOut.push({ v: null });
  }
  if (headerOut && o.headerCase !== 'none') {
    headerOut.forEach((c, i) => {
      if (typeof c.v !== 'string' || c.f) return;
      const v = o.headerCase === 'snake' ? snakeCase(c.v) : o.headerCase === 'lower' ? c.v.toLowerCase() : titleCase(c.v);
      if (v !== c.v) {
        headerOut![i] = { ...c, v };
        report.changedCells++;
      }
    });
  }
  // Names follow the (possibly changed) header.
  columns = columns.map((c, i) => (headerOut ? { ...c, name: asText(headerOut[i]?.v ?? null).trim() || c.name } : c));

  const offset = headerOut ? 1 : 0;
  const rowIndex = new Map(data.map((r, i) => [r, i]));
  const placed: NormalizeReport['invalid'] = [];
  for (const p of problems) {
    const r = rowIndex.get(p.row);
    const col = map[p.col] ?? -1;
    if (r == null || col < 0) continue;
    placed.push({ row: r + offset, col, column: columns[col]?.name ?? columnLetter(col), value: p.value.slice(0, 200), reason: p.reason });
  }
  columns.forEach((c, i) => {
    if (!c.required) return;
    data.forEach((r, ri) => {
      if (r[i]?.f || !isEmpty(r[i]?.v ?? null)) return;
      report.requiredMissing++;
      placed.push({ row: ri + offset, col: i, column: c.name, value: '', reason: 'required' });
    });
  });
  placed.sort((a, b) => a.row - b.row || a.col - b.col);
  report.invalidCount = placed.length;
  report.invalid = placed.slice(0, MAX_INVALID);
  return { sheet: { name: sheet.name, header: sheet.header, columns, rows: headerOut ? [headerOut, ...data] : data }, report };
}

