import { z } from 'zod';

/*
 * Sprint 45 (B-127): the safe transformations of a spreadsheet import's mapping step. A fixed vocabulary of kinds,
 * each with options zod checks, applied in order to the rows read from the file (or connection) before they are
 * mapped to fields. No expressions and no code: every kind is a plain function of the cells it names. The server
 * applies the same list in the preview, the dry run and the job (`applyTransforms`); the console's preview asks the
 * server, so there is one implementation.
 *
 * A row is `{ n, values }`: `n` is the row's number in the source (the sheet's row number, the record's position in a
 * CSV or JSON file), which the report and the error CSV name. A transformation may change cells, add columns (split,
 * merge), drop rows (drop-rows, dedupe: reported as skipped with the reason) or fail a row (parse-date, parse-number:
 * reported as failed with the reason, the row is not written).
 */

export const COLUMN_NAME = z.string().trim().min(1).max(200);
const columns = z.array(COLUMN_NAME).min(1).max(200);
const text = z.string().max(1000);

export const DATE_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD.MM.YYYY', 'DD-MM-YYYY', 'MM-DD-YYYY', 'YYYY/MM/DD', 'D/M/YYYY', 'M/D/YYYY', 'DD/MM/YY', 'MM/DD/YY', 'YYYYMMDD'] as const;

export const transformSchema = z.discriminatedUnion('kind', [
  /** Trims the cells and, with `collapse`, turns every run of whitespace inside into one space. */
  z.object({ kind: z.literal('trim'), columns, collapse: z.boolean().default(true) }).strict(),
  z.object({ kind: z.literal('case'), columns, to: z.enum(['upper', 'lower', 'title', 'sentence']) }).strict(),
  /** One column split by a delimiter into the named columns (the last takes the rest); the source is kept unless `drop`. */
  z.object({ kind: z.literal('split'), column: COLUMN_NAME, delimiter: z.string().min(1).max(10), into: z.array(COLUMN_NAME).min(2).max(20), drop: z.boolean().default(false) }).strict(),
  /** Columns joined with a separator into one (empty cells left out unless `keepEmpty`). */
  z.object({ kind: z.literal('merge'), columns: z.array(COLUMN_NAME).min(2).max(20), into: COLUMN_NAME, separator: z.string().max(10).default(' '), keepEmpty: z.boolean().default(false), drop: z.boolean().default(false) }).strict(),
  /** An empty cell takes the value above it (merged cells, grouped reports). */
  z.object({ kind: z.literal('fill-down'), columns }).strict(),
  /** Exact-match replacement: a cell equal to a key becomes its value. */
  z
    .object({ kind: z.literal('replace'), columns, map: z.record(z.string().max(500), z.string().max(1000)).refine((m) => Object.keys(m).length >= 1 && Object.keys(m).length <= 500, 'between 1 and 500 replacements'), ignoreCase: z.boolean().default(false) })
    .strict(),
  /** Dates in a chosen format to ISO (`YYYY-MM-DD`, or with a time `YYYY-MM-DDTHH:mm:ssZ` read as UTC). */
  z.object({ kind: z.literal('parse-date'), columns, format: z.enum(DATE_FORMATS), withTime: z.boolean().default(false) }).strict(),
  /** Numbers written with a decimal comma or point; thousands separators (space, apostrophe, the other mark) dropped. */
  z.object({ kind: z.literal('parse-number'), columns, decimal: z.enum(['.', ',']) }).strict(),
  z.object({ kind: z.literal('default'), columns, value: text }).strict(),
  /** Drops the rows where the column is empty, or equals one of `values`. */
  z
    .object({ kind: z.literal('drop-rows'), column: COLUMN_NAME, when: z.enum(['empty', 'equals']), values: z.array(z.string().max(500)).max(100).default([]), ignoreCase: z.boolean().default(false) })
    .strict()
    .refine((t) => t.when === 'empty' || t.values.length > 0, 'drop-rows with equals lists the values'),
  /** Keeps one row per combination of the columns' values: the first seen or the last. */
  z.object({ kind: z.literal('dedupe'), columns, keep: z.enum(['first', 'last']).default('first') }).strict()
]);
export type Transform = z.infer<typeof transformSchema>;
export const transformsSchema = z.array(transformSchema).max(50).default([]);

export interface Row {
  n: number;
  values: Record<string, unknown>;
}

export interface Transformed {
  columns: string[];
  rows: Row[];
  /** Rows a transformation dropped, with the reason. */
  skipped: { n: number; reason: string }[];
  /** Rows a transformation could not convert: the row is reported as failed and not written. */
  failed: Map<number, string>;
}

const empty = (v: unknown): boolean => v == null || (typeof v === 'string' && v.trim() === '');
const asText = (v: unknown): string => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v));

const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s\-/(])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());
const sentenceCase = (s: string) => {
  const lower = s.toLowerCase();
  const i = lower.search(/\p{L}/u);
  return i < 0 ? lower : lower.slice(0, i) + lower[i]!.toUpperCase() + lower.slice(i + 1);
};

/** A date in `format` as ISO, or null when it does not match or is not a real date. */
export function parseDate(raw: string, format: (typeof DATE_FORMATS)[number], withTime: boolean): string | null {
  const s = raw.trim();
  const order = format === 'YYYYMMDD' ? ['YYYY', 'MM', 'DD'] : format.replace(/[^YMD]+/g, ' ').trim().split(' ');
  let date = s;
  let time = '';
  const sp = /^(\S+)[ T](\d{1,2}:\d{2}(?::\d{2})?)$/.exec(s);
  if (sp) {
    date = sp[1]!;
    time = sp[2]!;
  }
  let parts: string[];
  if (format === 'YYYYMMDD') {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(date);
    if (!m) return null;
    parts = [m[1]!, m[2]!, m[3]!];
  } else {
    const sep = format.replace(/[YMD]/g, '')[0]!;
    parts = date.split(sep);
    if (parts.length !== 3 || parts.some((p) => !/^\d{1,4}$/.test(p))) return null;
  }
  let y = 0;
  let mo = 0;
  let d = 0;
  for (const [i, tok] of order.entries()) {
    const v = parts[i]!;
    if (tok.startsWith('Y')) {
      if (tok.length !== v.length) return null;
      y = Number(v);
      if (tok.length === 2) y += y < 70 ? 2000 : 1900;
    } else if (tok.startsWith('M')) {
      if (tok.length === 2 && v.length !== 2) return null;
      mo = Number(v);
    } else {
      if (tok.length === 2 && v.length !== 2) return null;
      d = Number(v);
    }
  }
  const iso = `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== iso) return null;
  if (!withTime) return time && !/^0?0:00(:00)?$/.test(time) ? null : iso;
  const [hh, mm, ss] = (time || '00:00:00').split(':').map(Number) as [number, number, number?];
  if (hh > 23 || mm > 59 || (ss ?? 0) > 59) return null;
  return `${iso}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss ?? 0).padStart(2, '0')}Z`;
}

/** A number written with `decimal` as its decimal mark, or null. */
export function parseNumber(raw: unknown, decimal: '.' | ','): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  let s = asText(raw).trim().replace(/[\s\u00a0\u202f']/g, '');
  const other = decimal === '.' ? ',' : '.';
  // The other mark groups thousands: only in groups of three.
  if (s.includes(other)) {
    if (!new RegExp(`^[+-]?\\d{1,3}(\\${other}\\d{3})+(\\${decimal}\\d*)?$`).test(s)) return null;
    s = s.split(other).join('');
  }
  if (decimal === ',') s = s.replace(',', '.');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Applies the transformations in order. Pure: the input rows are not changed. */
export function applyTransforms(inColumns: string[], inRows: Row[], list: Transform[]): Transformed {
  let rows = inRows.map((r) => ({ n: r.n, values: { ...r.values } }));
  const cols = [...inColumns];
  const skipped: { n: number; reason: string }[] = [];
  const failed = new Map<number, string>();
  const addColumn = (c: string) => {
    if (!cols.includes(c)) cols.push(c);
  };
  const need = (c: string, step: number) => {
    if (!cols.includes(c)) throw new TransformError(`Step ${step + 1}: there is no column ${c}.`);
  };
  const fail = (n: number, msg: string) => {
    if (!failed.has(n)) failed.set(n, msg);
  };
  for (const [i, t] of list.entries()) {
    const named = 'columns' in t ? t.columns : [];
    for (const c of named) {
      if (t.kind === 'default' || t.kind === 'fill-down' || t.kind === 'trim' || t.kind === 'case' || t.kind === 'replace' || t.kind === 'parse-date' || t.kind === 'parse-number' || t.kind === 'merge' || t.kind === 'dedupe') need(c, i);
    }
    switch (t.kind) {
      case 'trim':
        for (const r of rows) for (const c of t.columns) if (typeof r.values[c] === 'string') r.values[c] = t.collapse ? (r.values[c] as string).replace(/\s+/g, ' ').trim() : (r.values[c] as string).trim();
        break;
      case 'case':
        for (const r of rows) {
          for (const c of t.columns) {
            const v = r.values[c];
            if (typeof v !== 'string') continue;
            r.values[c] = t.to === 'upper' ? v.toUpperCase() : t.to === 'lower' ? v.toLowerCase() : t.to === 'title' ? titleCase(v) : sentenceCase(v);
          }
        }
        break;
      case 'split': {
        need(t.column, i);
        for (const c of t.into) addColumn(c);
        for (const r of rows) {
          const v = r.values[t.column];
          const parts = empty(v) ? [] : asText(v).split(t.delimiter);
          t.into.forEach((c, k) => {
            const piece = k === t.into.length - 1 ? parts.slice(k).join(t.delimiter) : parts[k];
            r.values[c] = piece == null || piece === '' ? null : piece;
          });
          if (t.drop && !t.into.includes(t.column)) delete r.values[t.column];
        }
        if (t.drop && !t.into.includes(t.column)) cols.splice(cols.indexOf(t.column), 1);
        break;
      }
      case 'merge':
        addColumn(t.into);
        for (const r of rows) {
          const parts = t.columns.map((c) => r.values[c]).filter((v) => t.keepEmpty || !empty(v)).map(asText);
          r.values[t.into] = parts.length ? parts.join(t.separator) : null;
          if (t.drop) for (const c of t.columns) if (c !== t.into) delete r.values[c];
        }
        if (t.drop) for (const c of t.columns) if (c !== t.into && cols.includes(c)) cols.splice(cols.indexOf(c), 1);
        break;
      case 'fill-down': {
        const last = new Map<string, unknown>();
        for (const r of rows) {
          for (const c of t.columns) {
            if (empty(r.values[c])) {
              if (last.has(c)) r.values[c] = last.get(c);
            } else last.set(c, r.values[c]);
          }
        }
        break;
      }
      case 'replace': {
        const map = new Map(Object.entries(t.map).map(([k, v]) => [t.ignoreCase ? k.toLowerCase() : k, v]));
        for (const r of rows) {
          for (const c of t.columns) {
            const v = r.values[c];
            if (v == null) continue;
            const key = t.ignoreCase ? asText(v).toLowerCase() : asText(v);
            if (map.has(key)) r.values[c] = map.get(key);
          }
        }
        break;
      }
      case 'parse-date':
        for (const r of rows) {
          for (const c of t.columns) {
            const v = r.values[c];
            if (empty(v)) continue;
            // A workbook's date cells are read as ISO dates already.
            if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(v) && t.format !== 'YYYY-MM-DD') {
              r.values[c] = t.withTime ? (v.length === 10 ? `${v}T00:00:00Z` : `${v.length === 16 ? `${v}:00` : v}Z`) : v.slice(0, 10);
              continue;
            }
            const out = parseDate(asText(v), t.format, t.withTime);
            if (out == null) fail(r.n, `${c}: ${asText(v).slice(0, 60)} is not a date in the format ${t.format}${t.withTime ? ' (with an optional time)' : ''}`);
            else r.values[c] = out;
          }
        }
        break;
      case 'parse-number':
        for (const r of rows) {
          for (const c of t.columns) {
            const v = r.values[c];
            if (empty(v)) continue;
            const out = parseNumber(v, t.decimal);
            if (out == null) fail(r.n, `${c}: ${asText(v).slice(0, 60)} is not a number with ${t.decimal === ',' ? 'a decimal comma' : 'a decimal point'}`);
            else r.values[c] = out;
          }
        }
        break;
      case 'default':
        for (const r of rows) for (const c of t.columns) if (empty(r.values[c])) r.values[c] = t.value;
        break;
      case 'drop-rows': {
        need(t.column, i);
        const vals = new Set(t.values.map((v) => (t.ignoreCase ? v.toLowerCase() : v)));
        rows = rows.filter((r) => {
          const v = r.values[t.column];
          const hit = t.when === 'empty' ? empty(v) : vals.has(t.ignoreCase ? asText(v).toLowerCase() : asText(v));
          if (hit) skipped.push({ n: r.n, reason: t.when === 'empty' ? `dropped: ${t.column} is empty` : `dropped: ${t.column} is ${asText(v).slice(0, 60)}` });
          return !hit;
        });
        break;
      }
      case 'dedupe': {
        const key = (r: Row) => JSON.stringify(t.columns.map((c) => asText(r.values[c]).normalize('NFC').toLowerCase()));
        const keep = new Map<string, Row>();
        if (t.keep === 'first') {
          for (const r of rows) {
            const k = key(r);
            const first = keep.get(k);
            if (first) skipped.push({ n: r.n, reason: `duplicate of row ${first.n} on ${t.columns.join(', ')}` });
            else keep.set(k, r);
          }
        } else {
          for (const r of rows) {
            const k = key(r);
            const prev = keep.get(k);
            if (prev) skipped.push({ n: prev.n, reason: `duplicate of row ${r.n} on ${t.columns.join(', ')} (the last is kept)` });
            keep.set(k, r);
          }
        }
        const kept = new Set(keep.values());
        rows = rows.filter((r) => kept.has(r));
        break;
      }
    }
  }
  skipped.sort((a, b) => a.n - b.n);
  return { columns: cols, rows, skipped, failed };
}

export class TransformError extends Error {}
