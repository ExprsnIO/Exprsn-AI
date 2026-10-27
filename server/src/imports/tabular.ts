import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { detectPii, PII_KINDS } from '../guardrails/detectors.js';
import { SourceError } from './types.js';

/*
 * B-3804: rows out of the files a dataset is published as. CSV and TSV (RFC 4180 quoting, the delimiter read from
 * the first line), JSON Lines, a JSON array (or an object holding one), and ARFF are read as a stream, so a row limit
 * stops the download early; `.gz` is unpacked on the way. Zip archives, xlsx workbooks, Parquet and XML are files
 * that are read whole (`containers.ts`); `fileKind` names them, `fileRecords` reads only the text kinds.
 * `profile` is the schema preview: a type and a sample value per column, and the columns the PII detectors or the
 * column's name flag.
 */

export type TextKind = 'csv' | 'tsv' | 'json' | 'jsonl' | 'arff';
/** The text kinds, read as a stream, and the kinds read whole from memory. */
export type FileKind = TextKind | 'zip' | 'xlsx' | 'parquet' | 'xml';
export const isTextKind = (k: FileKind): k is TextKind => k === 'csv' || k === 'tsv' || k === 'json' || k === 'jsonl' || k === 'arff';
export type Record_ = Record<string, unknown>;

const KINDS: Record<string, FileKind> = { csv: 'csv', tsv: 'tsv', tab: 'tsv', json: 'json', geojson: 'json', jsonl: 'jsonl', ndjson: 'jsonl', jsonlines: 'jsonl', arff: 'arff', 'sdmx-csv': 'csv', txt: 'csv', zip: 'zip', xlsx: 'xlsx', xlsm: 'xlsx', parquet: 'parquet', pq: 'parquet', xml: 'xml' };

/** What a file is and whether it is gzipped, from the format the source states, then its name. Null: not readable. */
export function fileKind(format: string | null | undefined, name: string | null | undefined): { kind: FileKind; gzip: boolean } | null {
  const path = (name ?? '').split(/[?#]/)[0]!.toLowerCase();
  const gzip = /\.gz$/.test(path);
  const ext = /\.([a-z0-9-]+)$/.exec(path.replace(/\.gz$/, ''))?.[1] ?? null;
  const stated = (format ?? '').toLowerCase().trim().replace(/^\./, '');
  const kind = KINDS[stated] ?? (ext ? KINDS[ext] : undefined);
  // A stated format the name contradicts with another readable one (a "CSV" resource that is data.json): the name.
  return kind ? { kind: ext && KINDS[ext] && ext !== 'txt' ? KINDS[ext]! : kind, gzip } : null;
}

/** Decodes a byte stream as UTF-8 text, stopping with an error past `maxBytes` (counted before unpacking). */
export async function* textChunks(body: AsyncIterable<Uint8Array>, o: { maxBytes: number; gzip?: boolean; onBytes?: (n: number) => void }): AsyncGenerator<string> {
  let seen = 0;
  const counted = (async function* () {
    for await (const c of body) {
      seen += c.length;
      o.onBytes?.(seen);
      if (seen > o.maxBytes) throw new SourceError(`The file is larger than the ${o.maxBytes.toLocaleString('en-US')} bytes this import may fetch. Give a row limit to import a sample.`);
      yield c;
    }
  })();
  const bytes: AsyncIterable<Uint8Array> = o.gzip ? (Readable.from(counted).pipe(createGunzip()) as AsyncIterable<Uint8Array>) : counted;
  const dec = new TextDecoder('utf-8');
  let first = true;
  for await (const c of bytes) {
    let t = dec.decode(c, { stream: true });
    if (first && t) {
      first = false;
      if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
    }
    if (t) yield t;
  }
  const tail = dec.decode();
  if (tail) yield tail;
}

const detectDelimiter = (line: string): string => {
  const count = (d: string) => line.split(d).length - 1;
  const [tab, semi, comma] = [count('\t'), count(';'), count(',')];
  return tab > comma && tab >= semi ? '\t' : semi > comma ? ';' : ',';
};

/** Delimited rows as arrays of fields. Quoted fields may hold the delimiter, line breaks and doubled quotes. */
export async function* delimitedRows(text: AsyncIterable<string>, o: { delimiter?: string | null; quotes?: string } = {}): AsyncGenerator<string[]> {
  const quotes = o.quotes ?? '"';
  let delim = o.delimiter ?? null;
  let field = '';
  let row: string[] = [];
  let quote: string | null = null;
  let pending = false; // a quote inside a quoted field: the next character says whether it closes the field
  let any = false;
  let cr = false;
  let head = '';
  const out: string[][] = [];
  const feed = (chunk: string) => {
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i]!;
      if (quote) {
        if (pending) {
          pending = false;
          if (c === quote) {
            field += c;
            continue;
          }
          quote = null;
        } else if (c === quote) {
          pending = true;
          continue;
        } else {
          field += c;
          continue;
        }
      }
      if (c === '\n' && cr) {
        cr = false;
        continue;
      }
      cr = c === '\r';
      if (c === '\n' || c === '\r') {
        if (any || field !== '') {
          row.push(field);
          out.push(row);
        }
        row = [];
        field = '';
        any = false;
      } else if (c === delim) {
        row.push(field);
        field = '';
        any = true;
      } else if (field === '' && quotes.includes(c)) {
        quote = c;
        any = true;
      } else {
        field += c;
        any = true;
      }
    }
  };
  for await (const chunk of text) {
    if (delim == null) {
      head += chunk;
      const nl = head.search(/[\r\n]/);
      if (nl < 0 && head.length < 65_536) continue;
      delim = detectDelimiter(nl < 0 ? head : head.slice(0, nl));
      feed(head);
      head = '';
    } else feed(chunk);
    while (out.length) yield out.shift()!;
  }
  if (delim == null && head) {
    delim = detectDelimiter(head);
    feed(head);
  }
  if (any || field !== '') {
    row.push(field);
    out.push(row);
  }
  while (out.length) yield out.shift()!;
}

/** Names for a header row: trimmed, empty ones numbered, repeats suffixed, so every column has its own key. */
export function headerNames(cells: string[]): string[] {
  const seen = new Map<string, number>();
  return cells.map((c, i) => {
    const base = c.trim().slice(0, 200) || `column_${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n > 1 ? `${base}_${n}` : base;
  });
}

async function* delimitedRecords(text: AsyncIterable<string>, delimiter: string | null): AsyncGenerator<Record_> {
  let header: string[] | null = null;
  for await (const r of delimitedRows(text, { delimiter })) {
    if (!header) {
      header = headerNames(r);
      continue;
    }
    const rec: Record_ = {};
    for (const [i, name] of header.entries()) rec[name] = r[i] ?? '';
    yield rec;
  }
}

async function* lines(text: AsyncIterable<string>): AsyncGenerator<string> {
  let buf = '';
  for await (const chunk of text) {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
    }
    if (buf.length > 16 * 1024 * 1024) throw new SourceError('A line of the file is longer than 16 MB.');
  }
  if (buf) yield buf;
}

const asRecord = (v: unknown, n: number): Record_ => {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record_;
  if (Array.isArray(v)) return Object.fromEntries(v.map((x, i) => [`column_${i + 1}`, x]));
  throw new SourceError(`Row ${n} of the file is not an object.`);
};

async function* jsonlRecords(text: AsyncIterable<string>): AsyncGenerator<Record_> {
  let n = 0;
  for await (const line of lines(text)) {
    if (!line.trim()) continue;
    n++;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      throw new SourceError(`Line ${n} of the file is not valid JSON.`);
    }
    yield asRecord(v, n);
  }
}

/** The array of rows in a JSON document: the document itself, or the first of the usual keys that holds an array. */
export function jsonRows(doc: unknown): unknown[] {
  if (Array.isArray(doc)) return doc;
  if (doc && typeof doc === 'object') {
    const o = doc as Record_;
    for (const k of ['data', 'records', 'results', 'result', 'rows', 'items', 'features', 'value']) {
      const v = o[k];
      if (Array.isArray(v)) return v;
      if (v && typeof v === 'object' && Array.isArray((v as Record_).records)) return (v as Record_).records as unknown[];
    }
  }
  throw new SourceError('The JSON file holds no array of rows.');
}

async function* jsonRecords(text: AsyncIterable<string>): AsyncGenerator<Record_> {
  // A JSON document is read whole (there is no streaming parser here); `textChunks` has capped its size.
  let all = '';
  for await (const c of text) {
    all += c;
    if (all.length > 256 * 1024 * 1024) throw new SourceError('A JSON file is read whole and this one is larger than 256 MB. Pick the CSV or JSON Lines resource.');
  }
  let doc: unknown;
  try {
    doc = JSON.parse(all);
  } catch {
    throw new SourceError('The file is not valid JSON.');
  }
  let n = 0;
  for (const v of jsonRows(doc)) yield asRecord(v, ++n);
}

async function* arffRecords(text: AsyncIterable<string>): AsyncGenerator<Record_> {
  const names: string[] = [];
  let data = false;
  const dataLines = (async function* (src: AsyncGenerator<string>) {
    for await (const line of src) {
      const t = line.trim();
      if (!data) {
        const a = /^@attribute\s+(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|(\S+))\s+/i.exec(t);
        if (a) names.push((a[1] ?? a[2] ?? a[3] ?? '').replace(/\\(.)/g, '$1'));
        else if (/^@data\b/i.test(t)) data = true;
        continue;
      }
      if (!t || t.startsWith('%')) continue;
      if (t.startsWith('{')) throw new SourceError('Sparse ARFF rows are not read. Pick another resource.');
      yield `${line}\n`;
    }
  })(lines(text));
  let header: string[] | null = null;
  for await (const r of delimitedRows(dataLines, { delimiter: ',', quotes: '"\'' })) {
    header ??= headerNames(names);
    const rec: Record_ = {};
    for (const [i, name] of header.entries()) {
      const v = (r[i] ?? '').trim();
      rec[name] = v === '?' ? null : v;
    }
    yield rec;
  }
}

/** The rows of one text file, as a stream. */
export function fileRecords(body: AsyncIterable<Uint8Array>, kind: TextKind, o: { maxBytes: number; gzip?: boolean; onBytes?: (n: number) => void }): AsyncGenerator<Record_> {
  const text = textChunks(body, o);
  return kind === 'csv' ? delimitedRecords(text, null) : kind === 'tsv' ? delimitedRecords(text, '\t') : kind === 'jsonl' ? jsonlRecords(text) : kind === 'arff' ? arffRecords(text) : jsonRecords(text);
}

// ---------- schema preview ----------

export interface ColumnProfile {
  name: string;
  /** string, int, decimal, bool, date, month, or `class (…)` for a column with a few repeated values. */
  type: string;
  sample: string | null;
  /** Rows of the preview with a value in the column. */
  filled: number;
  /** Why the column is flagged, in words (null: not flagged). */
  pii: string | null;
  /** Findings of the PII detectors by kind, in the previewed rows. */
  detected: Record<string, number>;
}

/** A value as text: what a column mapping writes into a document, a prompt or an eval case. */
export const cellText = (v: unknown): string => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' ? String(v) : v instanceof Date ? v.toISOString() : JSON.stringify(v));

const NAME_FLAGS: [RegExp, string][] = [
  [/(^|[^a-z])(e-?mail)([^a-z]|$)/i, 'email address by name'],
  [/(^|[^a-z])(phone|mobile|telephone|fax)([^a-z]|$)/i, 'phone number by name'],
  [/(^|[^a-z])(ssn|social[ _-]?security|national[ _-]?id|passport|tax[ _-]?id|nric)([^a-z]|$)/i, 'national identifier by name'],
  [/(^|[^a-z])(first|last|full|sur|given|family)[ _-]?name([^a-z]|$)|(^|[^a-z])(beneficiary|patient|customer|employee|person|owner|applicant)([^a-z]|$)/i, 'may name natural persons'],
  [/(^|[^a-z])(address|street|zip|postal|postcode)([^a-z]|$)/i, 'address, a quasi-identifier'],
  [/(^|[^a-z])(birth|dob|date[ _-]of[ _-]birth|age)([^a-z]|$)/i, 'age or birth date, a quasi-identifier'],
  [/(^|[^a-z])(race|ethnic|ethnicity|sex|gender|religion|nationality|marital)([^a-z]|$)/i, 'protected attribute'],
  [/(^|[^a-z])(vin|licen[cs]e[ _-]?plate|ip[ _-]?address|device[ _-]?id|account[ _-]?(no|number))([^a-z]|$)/i, 'identifier of a vehicle, device or account'],
  [/(^|[^a-z])(narrative|comment|comments|free[ _-]?text|notes?|message|complaint)([^a-z]|$)/i, 'free text may name people']
];

const typeOf = (values: string[]): string => {
  if (!values.length) return 'string';
  const all = (re: RegExp) => values.every((v) => re.test(v));
  if (all(/^[+-]?\d{1,15}$/)) return 'int';
  if (all(/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/)) return 'decimal';
  if (all(/^(true|false)$/i)) return 'bool';
  if (all(/^\d{4}-\d{2}$/)) return 'month';
  if (all(/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/)) return 'date';
  return 'string';
};

/** The schema preview: every column of the sampled rows with its type, a sample value and its PII flag. */
export function profile(rows: Record_[]): ColumnProfile[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (seen.has(k) || names.length >= 500) continue;
      seen.add(k);
      names.push(k);
    }
  }
  return names.map((name) => {
    const values = rows.map((r) => r[name]).filter((v) => v != null && v !== '');
    const texts = values.map(cellText);
    const typed = values.every((v) => typeof v === 'number') && values.length ? (values.every((v) => Number.isInteger(v)) ? 'int' : 'decimal') : values.every((v) => typeof v === 'boolean') && values.length ? 'bool' : values.some((v) => typeof v === 'object') ? (values.every((v) => Array.isArray(v)) ? 'list' : 'object') : typeOf(texts);
    const distinct = new Set(texts);
    // A few values that repeat: a class. Its values are listed when they fit.
    const isClass = (typed === 'string' || typed === 'int') && distinct.size > 0 && distinct.size <= 20 && texts.length >= distinct.size * 2 && [...distinct].every((v) => v.length <= 60);
    const list = [...distinct].sort();
    const type = isClass ? `class (${list.length <= 5 ? list.join(', ') : list.length})` : typed;
    const detected: Record<string, number> = {};
    if (typed === 'string' || typed === 'object' || typed === 'list') {
      for (const t of texts) for (const k of new Set(detectPii(t.slice(0, 20_000), PII_KINDS).map((d) => d.kind))) detected[k] = (detected[k] ?? 0) + 1;
    }
    const found = Object.entries(detected).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k.replace(/_/g, ' ')} in ${n} row${n === 1 ? '' : 's'}`);
    const byName = NAME_FLAGS.find(([re]) => re.test(name))?.[1] ?? null;
    return { name, type, sample: texts[0] != null ? texts[0].slice(0, 160) : null, filled: values.length, pii: found.length ? found.join(', ') : byName, detected };
  });
}
