import { brotliDecompressSync, gunzipSync, zstdDecompressSync } from 'node:zlib';
import { parquetMetadata, parquetReadObjects, snappyUncompress, type Compressors, type FileMetaData } from 'hyparquet';
import type { Record_ } from './tabular.js';
import { SourceError } from './types.js';
import type { Unpack } from './zip.js';

/*
 * B-3804: the rows of a Parquet file held in memory, read with hyparquet (pure JavaScript, no native code), one row
 * group at a time. Snappy is the reader's own code; gzip, Zstandard and Brotli pages are unpacked with node:zlib. A
 * page unpacks to at most the size its header states and never past `MAX_PAGE_BYTES`. The footer says what each row
 * group unpacks to before a page of it is read, so a file that would unpack past the allowance is refused first.
 * Values become what JSON can hold: a 64-bit integer a number when it is exact and a string otherwise, a timestamp an
 * ISO string; bytes are left out.
 */

/** At most this much for one page, whatever its header says: a page is a few megabytes in a file any writer makes. */
const MAX_PAGE_BYTES = 256 * 1024 * 1024;

/** The decompressors, each bounded by the page's stated size and counted against what the file may unpack to. */
function compressors(unpack: Unpack): Compressors {
  const admit = (n: number): number => {
    if (!Number.isSafeInteger(n) || n < 0 || n > MAX_PAGE_BYTES || n > unpack.max) throw new SourceError(`A page of the Parquet file states ${String(n).slice(0, 20)} bytes unpacked, more than is read.`);
    return n;
  };
  const zlib = (fn: (b: Uint8Array, o: { maxOutputLength: number }) => Buffer) => (input: Uint8Array, outputLength: number) => {
    const out = fn(input, { maxOutputLength: Math.max(1, admit(outputLength)) });
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  };
  return {
    SNAPPY: (input, outputLength) => {
      const out = new Uint8Array(admit(outputLength));
      snappyUncompress(input, out);
      return out;
    },
    GZIP: zlib(gunzipSync),
    ZSTD: zlib(zstdDecompressSync),
    BROTLI: zlib(brotliDecompressSync)
  };
}

function plain(v: unknown, depth = 0): unknown {
  if (v == null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString();
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return null;
  if (depth > 16) return null;
  if (Array.isArray(v)) return v.map((x) => plain(x, depth + 1));
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v as Record_).map(([k, x]) => [k, plain(x, depth + 1)]));
  return null;
}

function metadataOf(file: ArrayBuffer): FileMetaData {
  try {
    return parquetMetadata(file);
  } catch (err) {
    throw new SourceError(`The file is not a readable Parquet file: ${(err as Error).message.slice(0, 200)}`);
  }
}

/** The rows of a Parquet file. `unpack` is charged with what each row group unpacks to. */
export async function* parquetRecords(buf: Buffer, o: { unpack: Unpack }): AsyncGenerator<Record_> {
  // A copy with its own ArrayBuffer: the reader slices by offset from zero.
  const file = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const metadata = metadataOf(file);
  if (metadata.row_groups.some((g) => g.columns.some((c) => c.crypto_metadata || c.encrypted_column_metadata))) throw new SourceError('The Parquet file is encrypted; it is not read.');
  const codecs = compressors(o.unpack);
  let rowStart = 0;
  for (const g of metadata.row_groups) {
    const rows = Number(g.num_rows);
    const size = Number(g.total_byte_size);
    if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(size) || rows < 0 || size < 0 || rows > 50_000_000) throw new SourceError('The Parquet file states sizes that cannot be read.');
    o.unpack.used += size;
    if (o.unpack.used > o.unpack.max) throw new SourceError(`The Parquet file unpacks to more than the ${o.unpack.max.toLocaleString('en-US')} bytes an import may unpack (IMPORT_ARCHIVE_MAX_UNPACKED_BYTES). Give a row limit to import a sample.`);
    let got: Record_[];
    try {
      got = (await parquetReadObjects({ file, metadata, rowStart, rowEnd: rowStart + rows, compressors: codecs })) as Record_[];
    } catch (err) {
      throw new SourceError(`The Parquet file could not be read: ${(err as Error).message.slice(0, 200)}`);
    }
    rowStart += rows;
    for (const r of got) yield plain(r) as Record_;
  }
}
