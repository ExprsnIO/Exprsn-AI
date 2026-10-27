import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { parseXml, XmlError, type XmlElement } from '../federation/xml.js';
import { parquetRecords } from './parquet.js';
import { fileKind, fileRecords, isTextKind, type FileKind, type Record_ } from './tabular.js';
import { SourceError } from './types.js';
import { xlsxRecords } from './xlsx.js';
import { isZip, zipBytes, zipEntries, zipMember, type Unpack, type ZipEntry } from './zip.js';

/*
 * B-3804: rows out of the files that cannot be read as a stream of text: a zip archive (its members that are files
 * this import reads, in the archive's order), an xlsx workbook, a Parquet file and an XML document. Each is held in
 * memory whole, so each is capped: at most `archiveBytes` downloaded (IMPORT_ARCHIVE_MAX_BYTES, and never more than
 * the import's own byte budget) and at most `unpackedBytes` unpacked from it (IMPORT_ARCHIVE_MAX_UNPACKED_BYTES),
 * counted across every member and every workbook inside an archive. An archive inside an archive is not opened, and
 * neither is a gzipped member. `anyRecords` is the one entry: it also reads the text kinds (`tabular.ts`), and notices
 * a zip archive served where a CSV or JSON file was announced (Kaggle packs large files that way).
 */

export interface ContainerLimits {
  /** The most bytes of a file that is read whole. */
  archiveBytes: number;
  /** The most bytes one download may unpack to. */
  unpackedBytes: number;
}

export interface AnyOptions {
  /** What is left of the import's byte budget. */
  maxBytes: number;
  gzip?: boolean;
  onBytes?: (n: number) => void;
  limits: ContainerLimits;
  /** The worksheet of a workbook to read (the first visible one without it). */
  sheet?: string | null;
}

export interface PartRecord {
  values: Record_;
  /** The member of an archive the row came from, or null. */
  part: string | null;
}

const WHAT: Record<string, string> = { zip: 'A zip archive', xlsx: 'An xlsx workbook', parquet: 'A Parquet file', xml: 'An XML file' };
const MAX_XML_CHARS = 64 * 1024 * 1024;

/** A download read whole, within the import's budget and the cap on files held in memory. */
async function whole(body: AsyncIterable<Uint8Array>, kind: FileKind, o: AnyOptions, unpack: Unpack, head: Uint8Array[] = []): Promise<Buffer> {
  let seen = 0;
  const counted = (async function* () {
    const take = (c: Uint8Array) => {
      seen += c.length;
      o.onBytes?.(seen);
      if (seen > o.maxBytes) throw new SourceError(`The file is larger than the ${o.maxBytes.toLocaleString('en-US')} bytes this import may fetch. Give a row limit to import a sample.`);
      if (seen > o.limits.archiveBytes) throw new SourceError(`${WHAT[kind] ?? 'The file'} is read whole, and this one is larger than ${o.limits.archiveBytes.toLocaleString('en-US')} bytes (IMPORT_ARCHIVE_MAX_BYTES). Pick a CSV or JSON Lines resource, which is read as a stream.`);
      return c;
    };
    for (const c of head) yield take(c);
    for await (const c of body) yield take(c);
  })();
  const parts: Buffer[] = [];
  if (!o.gzip) {
    for await (const c of counted) parts.push(Buffer.from(c.buffer, c.byteOffset, c.byteLength));
    return Buffer.concat(parts);
  }
  const gunzip = Readable.from(counted).pipe(createGunzip());
  try {
    for await (const c of gunzip as AsyncIterable<Buffer>) {
      unpack.used += c.length;
      if (unpack.used > unpack.max) throw new SourceError(`The file unpacks to more than the ${unpack.max.toLocaleString('en-US')} bytes an import may unpack (IMPORT_ARCHIVE_MAX_UNPACKED_BYTES).`);
      parts.push(c);
    }
  } catch (err) {
    if (err instanceof SourceError) throw err;
    throw new SourceError(`The file could not be unpacked: ${(err as Error).message.slice(0, 200)}`);
  } finally {
    gunzip.destroy();
  }
  return Buffer.concat(parts);
}

// ---------- XML ----------

const kidsOf = (el: XmlElement): XmlElement[] => el.children.filter((c): c is XmlElement => c.type === 'element');
const textOf = (el: XmlElement): string => el.children.map((c) => (c.type === 'text' ? c.value : '')).join('').trim();

/** An element as a value: its text when it holds none, an object of its attributes and children otherwise. */
function xmlValue(el: XmlElement, depth = 0): unknown {
  const kids = kidsOf(el);
  if (!kids.length && !el.attrs.length) return textOf(el);
  if (depth > 12) return null;
  const out: Record_ = {};
  for (const a of el.attrs) out[`@${a.local}`] = a.value;
  for (const k of kids) {
    const v = xmlValue(k, depth + 1);
    if (!(k.local in out)) out[k.local] = v;
    else if (Array.isArray(out[k.local])) (out[k.local] as unknown[]).push(v);
    else out[k.local] = [out[k.local], v];
  }
  const text = textOf(el);
  if (text) out[kids.length ? '#text' : 'value'] = text;
  return out;
}

/**
 * The rows of an XML document: the element that repeats most under the root, looked for through wrappers that hold
 * one element only (`<response><rows><row/>…`). A document with no repeated element has no rows.
 */
export function xmlRows(text: string): Record_[] {
  let root: XmlElement;
  try {
    root = parseXml(text, MAX_XML_CHARS);
  } catch (err) {
    if (err instanceof XmlError || err instanceof RangeError) throw new SourceError(`The file is not XML this import reads: ${err.message.slice(0, 200)}`);
    throw err;
  }
  let at = root;
  for (let depth = 0; depth < 6; depth++) {
    const kids = kidsOf(at);
    const counts = new Map<string, number>();
    for (const k of kids) counts.set(k.local, (counts.get(k.local) ?? 0) + 1);
    const [name, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
    if (name && n >= 2) {
      return kids.filter((k) => k.local === name).map((k) => {
        const v = xmlValue(k);
        return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record_) : { value: v };
      });
    }
    // One element (a wrapper), perhaps beside a header: look inside the one that has element children.
    const inner = kids.filter((k) => kidsOf(k).length);
    if (inner.length !== 1) break;
    at = inner[0]!;
  }
  throw new SourceError('The XML file has no repeated element to read as rows. Pick a CSV or JSON resource.');
}

// ---------- zip ----------

const skipped = (e: ZipEntry): boolean => e.directory || e.name.startsWith('__MACOSX/') || (e.name.split('/').pop() ?? '').startsWith('.');

async function* memberRecords(buf: Buffer, e: ZipEntry, kind: FileKind, unpack: Unpack, sheet: string | null): AsyncGenerator<Record_> {
  if (isTextKind(kind)) yield* fileRecords(zipMember(buf, e, unpack), kind, { maxBytes: Number.MAX_SAFE_INTEGER });
  else if (kind === 'xlsx') yield* xlsxRecords(await zipBytes(buf, e, unpack), { unpack, sheet });
  else if (kind === 'parquet') yield* parquetRecords(await zipBytes(buf, e, unpack), { unpack });
  else if (kind === 'xml') yield* xmlRows((await zipBytes(buf, e, unpack)).toString('utf8'));
}

/** The rows of every readable member of an archive, in its order. `want` narrows it to one kind when it has one. */
export async function* zipRecords(buf: Buffer, o: { unpack: Unpack; want?: FileKind | null; sheet?: string | null }): AsyncGenerator<PartRecord> {
  const entries = zipEntries(buf);
  // A workbook announced as an archive: read as the workbook it is.
  if (entries.some((e) => e.name === 'xl/workbook.xml')) {
    for await (const values of xlsxRecords(buf, { unpack: o.unpack, sheet: o.sheet ?? null })) yield { values, part: null };
    return;
  }
  const files = entries.filter((e) => !skipped(e));
  const readable = files.flatMap((e) => {
    const k = fileKind(null, e.name);
    // A gzipped member or an archive in the archive would be a second unpacking: neither is opened.
    return k && !k.gzip && k.kind !== 'zip' ? [{ e, kind: k.kind }] : [];
  });
  // A `.txt` member beside data files is a note about them (a README), not a table.
  const tables = readable.filter((x) => !/\.txt$/i.test(x.e.name));
  const candidates = tables.length ? tables : readable;
  const wanted = o.want ? candidates.filter((x) => x.kind === o.want) : [];
  const picked = wanted.length ? wanted : candidates;
  if (!picked.length) {
    const names = files.slice(0, 6).map((e) => e.name.slice(0, 80)).join(', ');
    throw new SourceError(`The archive holds no file this import reads${names ? ` (it holds ${names}${files.length > 6 ? ' and others' : ''})` : ''}. CSV, TSV, JSON, JSON Lines, ARFF, XML, xlsx and Parquet members are read; an archive inside an archive is not.`);
  }
  for (const { e, kind } of picked) for await (const values of memberRecords(buf, e, kind, o.unpack, o.sheet ?? null)) yield { values, part: e.name };
}

// ---------- the one entry ----------

/** The rows of one downloaded file of any kind this import reads. */
export async function* anyRecords(body: AsyncIterable<Uint8Array>, kind: FileKind, o: AnyOptions): AsyncGenerator<PartRecord> {
  const unpack: Unpack = { used: 0, max: o.limits.unpackedBytes };
  if (isTextKind(kind)) {
    if (o.gzip) {
      for await (const values of fileRecords(body, kind, o)) yield { values, part: null };
      return;
    }
    // The first bytes say whether this is the text it was announced as, or a zip archive holding it.
    const it = body[Symbol.asyncIterator]();
    const head: Uint8Array[] = [];
    let have = 0;
    let done = false;
    while (have < 4 && !done) {
      const n = await it.next();
      if (n.done) done = true;
      else if (n.value.length) {
        head.push(n.value);
        have += n.value.length;
      }
    }
    const rest: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({ next: () => (done ? Promise.resolve({ done: true as const, value: undefined }) : it.next()), return: async () => (await it.return?.()) ?? { done: true as const, value: undefined } }) };
    if (isZip(Buffer.concat(head.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).subarray(0, 4))) {
      yield* zipRecords(await whole(rest, 'zip', o, unpack, head), { unpack, want: kind, sheet: o.sheet ?? null });
      return;
    }
    const joined = (async function* () {
      yield* head;
      yield* rest;
    })();
    for await (const values of fileRecords(joined, kind, o)) yield { values, part: null };
    return;
  }
  const buf = await whole(body, kind, o, unpack);
  if (kind === 'zip') yield* zipRecords(buf, { unpack, sheet: o.sheet ?? null });
  else if (kind === 'xlsx') for await (const values of xlsxRecords(buf, { unpack, sheet: o.sheet ?? null })) yield { values, part: null };
  else if (kind === 'parquet') for await (const values of parquetRecords(buf, { unpack })) yield { values, part: null };
  else for (const values of xmlRows(buf.toString('utf8'))) yield { values, part: null };
}
