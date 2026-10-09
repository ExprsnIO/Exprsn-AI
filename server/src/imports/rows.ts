import type { ImportFetcher, RepoAccess } from './fetcher.js';
import { SourceError } from './types.js';

/*
 * B-3804: reading a dataset's rows from a source. A resource is read either as a file (CSV, JSON array, JSON Lines,
 * streamed and parsed as it arrives) or through a paged API (CKAN datastore, Socrata SODA, SDMX-CSV, e-Stat, the
 * Indian OGD platform), page by page with the source's own offset and limit parameters. Every reader yields pages of
 * rows (plain objects keyed by column name) and stops at the row cap the caller sets (the sample of a dataset above
 * the quota, or the tenant's maximum), so a large dataset is never read whole into memory.
 */

export type Row = Record<string, unknown>;
export type ResourceApi = 'file' | 'ckan-datastore' | 'socrata' | 'sdmx' | 'estat' | 'ogd';

/** One thing a dataset can be read from: a file or an API endpoint. */
export interface DatasetResource {
  id: string;
  name: string;
  /** csv | json | jsonl | parquet | xlsx | zip | api | other */
  format: string;
  url: string | null;
  api: ResourceApi;
  bytes: number | null;
  rows: number | null;
  /** The configuration (HF config, SDMX flow, CKAN package) and split the resource belongs to. */
  config: string | null;
  split: string | null;
}

export interface ReadOptions {
  signal?: AbortSignal;
  /** The most rows to yield in all (the sample, or the cap). */
  maxRows: number;
  /** Page size for the APIs. */
  pageSize?: number;
  /** The columns to keep (empty: every column). */
  columns?: string[];
}

export const READABLE_FORMATS = new Set(['csv', 'tsv', 'json', 'jsonl', 'ndjson', 'api']);

/** The API behind a resource, from its URL and the source's hints. */
export function apiOf(r: { url?: string | null; format?: string | null; datastore?: boolean; repoType?: string }): ResourceApi {
  if (r.datastore) return 'ckan-datastore';
  const u = (r.url ?? '').toLowerCase();
  if (/\/resource\/[a-z0-9]{4}-[a-z0-9]{4}(\.json|\.csv)?(\?|$)/.test(u) || /socrata\.com\//.test(u)) return 'socrata';
  if (/api\.e-stat\.go\.jp\/rest\/.*getstatsdata/.test(u)) return 'estat';
  if (/api\.data\.gov\.in\/resource\//.test(u)) return 'ogd';
  if (r.repoType === 'sdmx' || /\/sdmx\/.*\/data\//.test(u)) return 'sdmx';
  return 'file';
}

// ---------- CSV ----------

/** A streaming RFC 4180 parser: feed chunks, take complete records; quotes, escaped quotes and newlines inside quotes. */
export class CsvParser {
  private buf = '';
  private readonly sep: string;
  header: string[] | null = null;
  constructor(sep: ',' | ';' | '\t' = ',') {
    this.sep = sep;
  }

  /** Parses as much as is complete; returns rows (objects keyed by header). The first record is the header. */
  push(chunk: string, final = false): Row[] {
    this.buf += chunk;
    const out: Row[] = [];
    let i = 0;
    const b = this.buf;
    while (i < b.length) {
      const rec: string[] = [];
      let j = i;
      let field = '';
      let done = false;
      let complete = false;
      while (j < b.length) {
        const c = b[j]!;
        if (c === '"') {
          j++;
          let closed = false;
          while (j < b.length) {
            const d = b[j]!;
            if (d === '"') {
              if (b[j + 1] === '"') {
                field += '"';
                j += 2;
                continue;
              }
              closed = true;
              j++;
              break;
            }
            field += d;
            j++;
          }
          if (!closed) break; // the quoted field continues in the next chunk
          continue;
        }
        if (c === this.sep) {
          rec.push(field);
          field = '';
          j++;
          continue;
        }
        if (c === '\n' || c === '\r') {
          rec.push(field);
          field = '';
          if (c === '\r' && b[j + 1] === '\n') j++;
          j++;
          done = true;
          complete = true;
          break;
        }
        field += c;
        j++;
      }
      if (!done) {
        if (final && j >= b.length) {
          rec.push(field);
          complete = true;
          i = b.length;
        } else break;
      } else i = j;
      if (!complete) break;
      if (rec.length === 1 && rec[0] === '' ) continue; // a blank line
      if (!this.header) {
        this.header = rec.map((h, k) => (h.trim() || `column_${k + 1}`).replace(/^\uFEFF/, ''));
        continue;
      }
      const row: Row = {};
      this.header.forEach((h, k) => {
        row[h] = k < rec.length ? rec[k] : null;
      });
      out.push(row);
    }
    this.buf = i >= b.length ? '' : b.slice(i);
    return out;
  }
}

/** Streams a response body through a parser by format, yielding pages of rows. */
export async function* parseStream(body: AsyncIterable<Uint8Array>, format: string, o: ReadOptions): AsyncGenerator<Row[]> {
  const dec = new TextDecoder();
  let n = 0;
  const cut = (rows: Row[]) => {
    const keep = rows.slice(0, Math.max(0, o.maxRows - n));
    n += keep.length;
    return keep;
  };
  if (format === 'csv' || format === 'tsv') {
    const p = new CsvParser(format === 'tsv' ? '\t' : ',');
    for await (const chunk of body) {
      if (o.signal?.aborted) throw o.signal.reason as Error;
      const rows = cut(p.push(dec.decode(chunk, { stream: true })));
      if (rows.length) yield rows;
      if (n >= o.maxRows) return;
    }
    const rows = cut(p.push(dec.decode(), true));
    if (rows.length) yield rows;
    return;
  }
  if (format === 'jsonl' || format === 'ndjson') {
    let buf = '';
    const take = (final: boolean) => {
      const lines = buf.split('\n');
      buf = final ? '' : (lines.pop() ?? '');
      return cut(lines.map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l) as Row));
    };
    for await (const chunk of body) {
      if (o.signal?.aborted) throw o.signal.reason as Error;
      buf += dec.decode(chunk, { stream: true });
      const rows = take(false);
      if (rows.length) yield rows;
      if (n >= o.maxRows) return;
    }
    buf += dec.decode();
    const rows = take(true);
    if (rows.length) yield rows;
    return;
  }
  if (format === 'json') {
    // A JSON array (or an object whose first array-valued key holds the rows) read whole, capped by size through the fetcher.
    const parts: Buffer[] = [];
    let total = 0;
    for await (const chunk of body) {
      if (o.signal?.aborted) throw o.signal.reason as Error;
      total += chunk.length;
      if (total > 256 * 1024 * 1024) throw new SourceError('The JSON resource is larger than 256 MB; use a CSV or JSON Lines resource, or the datastore API.');
      parts.push(Buffer.from(chunk));
    }
    const doc = JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
    const arr = Array.isArray(doc) ? doc : typeof doc === 'object' && doc ? (Object.values(doc as Record<string, unknown>).find((v) => Array.isArray(v)) as unknown[] | undefined) ?? [] : [];
    const rows = cut(arr.filter((r) => typeof r === 'object' && r !== null) as Row[]);
    for (let i = 0; i < rows.length; i += 500) yield rows.slice(i, i + 500);
    return;
  }
  throw new SourceError(`${format} resources are not read here: use a CSV, JSON, JSON Lines or API resource.`);
}

// ---------- the paged APIs ----------

interface Page {
  rows: Row[];
  total: number | null;
  /** The next offset, or null when this was the last page. */
  next: number | null;
}

type Pager = (fetcher: ImportFetcher, access: RepoAccess, r: DatasetResource, offset: number, limit: number, signal?: AbortSignal) => Promise<Page>;

const withParams = (url: string, params: Record<string, string | number>) => {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u.toString();
};

const PAGERS: Record<Exclude<ResourceApi, 'file' | 'sdmx'>, Pager> = {
  async 'ckan-datastore'(fetcher, access, r, offset, limit, signal) {
    const { body } = await fetcher.json<{ success?: boolean; result?: { total?: number; records?: Row[] } }>(withParams(r.url!, { offset, limit }), access, { signal });
    if (!body.success || !body.result) throw new SourceError('The CKAN datastore did not answer a datastore_search result.');
    const rows = (body.result.records ?? []).map((x) => {
      const { _id: _drop, ...rest } = x;
      return rest;
    });
    const total = body.result.total ?? null;
    return { rows, total, next: rows.length < limit || (total != null && offset + rows.length >= total) ? null : offset + rows.length };
  },
  async socrata(fetcher, access, r, offset, limit, signal) {
    const { body } = await fetcher.json<Row[]>(withParams(r.url!.replace(/\.csv(\?|$)/, '.json$1'), { $offset: offset, $limit: limit }), access, { signal });
    if (!Array.isArray(body)) throw new SourceError('The Socrata endpoint did not answer a JSON array.');
    return { rows: body, total: null, next: body.length < limit ? null : offset + body.length };
  },
  async estat(fetcher, access, r, offset, limit, signal) {
    // e-Stat: startPosition is 1-based; the answer nests VALUE rows under GET_STATS_DATA.STATISTICAL_DATA.DATA_INF.
    const { body } = await fetcher.json<{ GET_STATS_DATA?: { STATISTICAL_DATA?: { RESULT_INF?: { TOTAL_NUMBER?: number; NEXT_KEY?: number }; DATA_INF?: { VALUE?: Row[] } } } }>(withParams(r.url!, { startPosition: offset + 1, limit }), access, { signal });
    const sd = body.GET_STATS_DATA?.STATISTICAL_DATA;
    if (!sd) throw new SourceError('e-Stat did not answer GET_STATS_DATA.');
    const rows = (sd.DATA_INF?.VALUE ?? []).map((v) => Object.fromEntries(Object.entries(v).map(([k, val]) => [k.replace(/^[@$]/, '') || 'value', val])));
    const next = sd.RESULT_INF?.NEXT_KEY != null ? Number(sd.RESULT_INF.NEXT_KEY) - 1 : rows.length < limit ? null : offset + rows.length;
    return { rows, total: sd.RESULT_INF?.TOTAL_NUMBER ?? null, next };
  },
  async ogd(fetcher, access, r, offset, limit, signal) {
    const { body } = await fetcher.json<{ total?: number; count?: number; records?: Row[] }>(withParams(r.url!, { format: 'json', offset, limit }), access, { signal });
    const rows = body.records ?? [];
    const total = body.total ?? null;
    return { rows, total, next: rows.length < limit || (total != null && offset + rows.length >= total) ? null : offset + rows.length };
  }
};

/**
 * Reads a resource's rows: the paged APIs page by page, files as a stream through the parser of their format. SDMX
 * data is read as SDMX-CSV in one stream (the providers page by period, not by row).
 */
export async function* readRows(fetcher: ImportFetcher, access: RepoAccess, r: DatasetResource, o: ReadOptions): AsyncGenerator<Row[]> {
  const pick = (rows: Row[]) => (o.columns?.length ? rows.map((row) => Object.fromEntries(o.columns!.filter((c) => c in row).map((c) => [c, row[c]]))) : rows);
  if (r.api === 'file' || r.api === 'sdmx') {
    if (!r.url) throw new SourceError(`${r.name} has no URL to read from.`);
    const url = r.api === 'sdmx' ? withParams(r.url, { format: 'SDMX-CSV' }) : r.url;
    const res = await fetcher.request(url, access, { signal: o.signal });
    if (res.status >= 400) throw new SourceError(`${r.name}: the source answered HTTP ${res.status}.`, res.status);
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    const format = r.api === 'sdmx' ? 'csv' : r.format === 'api' || r.format === 'other' ? (ct.includes('csv') ? 'csv' : ct.includes('ndjson') || ct.includes('jsonl') ? 'jsonl' : 'json') : r.format;
    for await (const page of parseStream(res.body ?? (async function* () {})(), format, o)) yield pick(page);
    return;
  }
  const pager = PAGERS[r.api];
  const limit = Math.max(1, Math.min(o.pageSize ?? 1000, o.maxRows));
  let offset = 0;
  let n = 0;
  for (let guard = 0; guard < 100_000; guard++) {
    if (o.signal?.aborted) throw o.signal.reason as Error;
    const page = await pager(fetcher, access, r, offset, Math.min(limit, o.maxRows - n), o.signal);
    const rows = page.rows.slice(0, o.maxRows - n);
    n += rows.length;
    if (rows.length) yield pick(rows);
    if (page.next == null || n >= o.maxRows || !rows.length) return;
    offset = page.next;
  }
}

/** A column's type from the values seen: number, boolean, date or text. */
export function inferType(values: unknown[]): 'number' | 'boolean' | 'date' | 'text' {
  const vs = values.filter((v) => v != null && v !== '');
  if (!vs.length) return 'text';
  const all = (f: (v: unknown) => boolean) => vs.every(f);
  if (all((v) => typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())))) return 'number';
  if (all((v) => typeof v === 'boolean' || (typeof v === 'string' && /^(true|false|yes|no)$/i.test(v.trim())))) return 'boolean';
  if (all((v) => typeof v === 'string' && /^\d{4}-\d{2}(-\d{2})?([T ][\d:.]+Z?)?$/.test(v.trim()))) return 'date';
  return 'text';
}

/** Text of a cell for the detectors and the documents. */
export const cellText = (v: unknown): string => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v));
