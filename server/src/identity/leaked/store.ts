import { randomBytes } from 'node:crypto';
import { mkdir, open, rm, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { BlobStore } from '../../platform/blob.js';
import { Bloom, bloomSize, type BloomSize } from './bloom.js';
import { lines, parseLine, WIDTH, type HashKind, type ImportFormat } from './hashes.js';

/*
 * 1.9.0, Sprint 55 (B-192): how a list version is laid out in the blob store, how it is built, and how it is read.
 *
 *   <prefix>/staging.bin            the parsed import: fixed-width binary digests, in the order read (deleted once built)
 *   <prefix>/staging/mirror-NNNN    an HIBP mirror's chunks, one per batch of range prefixes, already in order
 *   <prefix>/shards/<hex>.bin       sorted, de-duplicated digests whose hex starts with <hex> (2, 4 or 6 characters,
 *                                   chosen so a shard holds about SHARD_TARGET digests)
 *   <prefix>/bloom.bin              the Bloom filter over every digest of the version
 *
 * Building never holds the import in memory: the staged digests are partitioned by their first byte into 256 files in
 * a private work directory, each bucket is sorted in memory when it fits the sort budget (otherwise partitioned again
 * by the next byte), and the sorted stream is cut into shards as it goes. Memory is the sort budget, one shard and the
 * Bloom filter, whatever the size of the import.
 */

export const SHARD_TARGET = 65_536;
const FLUSH_BYTES = 16 * 1024;

export interface ShardMeta {
  prefix: string;
  entries: number;
  bytes: number;
}

export interface BuildOptions {
  blobs: BlobStore;
  kind: HashKind;
  blobPrefix: string;
  /** An upper bound of the number of digests (before de-duplication): sizes the filter and the shards. */
  total: number;
  fpRate: number;
  bloomMaxBytes: number;
  workDir: string;
  sortBudgetBytes?: number;
  /** The digests arrive in ascending order (an HIBP mirror): no partition or sort, only checked. */
  sorted?: boolean;
  progress?: (pct: number, message: string) => Promise<void> | void;
  signal?: AbortSignal;
}

export interface BuildResult {
  entries: number;
  duplicates: number;
  prefixLen: number;
  shards: ShardMeta[];
  bloom: BloomSize;
  bytes: number;
}

export const stagingKey = (prefix: string): string => `${prefix}/staging.bin`;
export const shardKey = (prefix: string, hex: string): string => `${prefix}/shards/${hex}.bin`;
export const bloomKey = (prefix: string): string => `${prefix}/bloom.bin`;

/** Shard prefix length in hex characters: even, at least 2, so shards hold about SHARD_TARGET digests. */
export function prefixLenFor(total: number): number {
  let len = 2;
  while (len < 6 && total / Math.pow(16, len) > SHARD_TARGET) len += 2;
  return len;
}

// ---------- staging ----------

export interface StageCounts {
  lines: number;
  invalid: number;
  /** Line numbers of the first invalid lines (never their content). */
  invalidLines: number[];
  records: number;
  bytes: number;
}

/**
 * Parses an import as it streams in and writes only the digests to the staging object. A plain-text line is hashed
 * and dropped at once. Throws when more than `maxBytes` arrive.
 */
export async function stage(blobs: BlobStore, key: string, input: { format: ImportFormat; kind: HashKind; source: AsyncIterable<Buffer | Uint8Array | string>; maxBytes: number; signal?: AbortSignal }): Promise<StageCounts> {
  const counts: StageCounts = { lines: 0, invalid: 0, invalidLines: [], records: 0, bytes: 0 };
  const width = WIDTH[input.kind];
  const max = input.maxBytes;
  const counted = async function* () {
    for await (const c of input.source) {
      counts.bytes += typeof c === 'string' ? Buffer.byteLength(c) : c.length;
      if (counts.bytes > max) throw Object.assign(new Error(`The upload is larger than ${max} bytes (LEAKED_UPLOAD_MAX_BYTES).`), { code: 'too_large' });
      yield c;
    }
  };
  const records = async function* (): AsyncGenerator<Buffer> {
    let block = Buffer.allocUnsafe(width * 4096);
    let used = 0;
    for await (const line of lines(counted())) {
      input.signal?.throwIfAborted();
      counts.lines++;
      if (line === null) {
        counts.invalid++;
        if (counts.invalidLines.length < 20) counts.invalidLines.push(counts.lines);
        continue;
      }
      if (input.format === 'plain' && line.length === 0) continue;
      const d = parseLine(input.format, input.kind, line);
      if (d === 'skip') continue;
      if (d === null) {
        counts.invalid++;
        if (counts.invalidLines.length < 20) counts.invalidLines.push(counts.lines);
        continue;
      }
      d.copy(block, used);
      used += width;
      counts.records++;
      if (used === block.length) {
        yield block;
        block = Buffer.allocUnsafe(width * 4096);
        used = 0;
      }
    }
    if (used) yield block.subarray(0, used);
  };
  await blobs.putStream(key, records());
  return counts;
}

// ---------- building ----------

/** Re-chunks a byte stream into whole records (callers may get any chunking from a blob stream). */
async function* recordBlocks(source: AsyncIterable<Buffer | Uint8Array>, width: number): AsyncGenerator<Buffer> {
  let carry = Buffer.alloc(0);
  for await (const raw of source) {
    const c = Buffer.isBuffer(raw) ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    const buf = carry.length ? Buffer.concat([carry, c]) : c;
    const whole = buf.length - (buf.length % width);
    if (whole) yield buf.subarray(0, whole);
    carry = Buffer.from(buf.subarray(whole));
  }
  if (carry.length) throw new Error('The staged list is not a whole number of digests');
}

/** Cuts a sorted stream of digests into shards, drops duplicates and fills the Bloom filter. */
class ShardWriter {
  readonly shards: ShardMeta[] = [];
  entries = 0;
  duplicates = 0;
  bytes = 0;
  private key = '';
  private parts: Buffer[] = [];
  private block: Buffer;
  private used = 0;
  private last: Buffer;
  private hasLast = false;

  constructor(
    private readonly o: { blobs: BlobStore; blobPrefix: string; width: number; prefixLen: number; bloom: Bloom; maxShardBytes: number; checkOrder: boolean }
  ) {
    this.block = Buffer.allocUnsafe(o.width * 4096);
    this.last = Buffer.alloc(o.width);
  }

  async push(buf: Buffer, off: number): Promise<void> {
    const w = this.o.width;
    if (this.hasLast) {
      const c = buf.compare(this.last, 0, w, off, off + w);
      if (c === 0) {
        this.duplicates++;
        return;
      }
      if (c < 0 && this.o.checkOrder) throw new Error('The digests are not in ascending order');
    }
    buf.copy(this.last, 0, off, off + w);
    this.hasLast = true;
    const key = buf.toString('hex', off, off + this.o.prefixLen / 2).toUpperCase();
    if (key !== this.key) {
      await this.flush();
      this.key = key;
    }
    this.o.bloom.add(buf, off);
    buf.copy(this.block, this.used, off, off + w);
    this.used += w;
    this.entries++;
    if (this.used === this.block.length) {
      this.parts.push(this.block);
      this.block = Buffer.allocUnsafe(w * 4096);
      this.used = 0;
      if (this.parts.length * this.block.length > this.o.maxShardBytes) throw new Error(`Shard ${this.key} is too large: the list is not made of uniformly distributed hashes`);
    }
  }

  async flush(): Promise<void> {
    if (!this.key) return;
    const data = Buffer.concat([...this.parts, this.block.subarray(0, this.used)]);
    this.parts = [];
    this.used = 0;
    if (data.length) {
      await this.o.blobs.put(shardKey(this.o.blobPrefix, this.key), data);
      this.shards.push({ prefix: this.key, entries: data.length / this.o.width, bytes: data.length });
      this.bytes += data.length;
    }
    this.key = '';
  }
}

async function appendAll(fh: FileHandle, buf: Buffer): Promise<void> {
  let off = 0;
  while (off < buf.length) off += (await fh.write(buf, off, buf.length - off)).bytesWritten;
}

/** Splits a file of records into 256 files by the byte at `depth`. Returns the bucket files (missing when empty). */
async function partition(source: AsyncIterable<Buffer>, width: number, depth: number, dir: string, onRecords?: (n: number) => Promise<void> | void, signal?: AbortSignal): Promise<(string | null)[]> {
  await mkdir(dir, { recursive: true });
  const files: (string | null)[] = new Array(256).fill(null);
  const handles: (FileHandle | null)[] = new Array(256).fill(null);
  const pending: Buffer[] = Array.from({ length: 256 }, () => Buffer.allocUnsafe(FLUSH_BYTES - (FLUSH_BYTES % width)));
  const fill = new Array<number>(256).fill(0);
  const flush = async (b: number) => {
    if (!fill[b]) return;
    if (!handles[b]) {
      files[b] = path.join(dir, `b${b.toString(16).padStart(2, '0')}.bin`);
      handles[b] = await open(files[b]!, 'w', 0o600);
    }
    await appendAll(handles[b]!, pending[b]!.subarray(0, fill[b]));
    fill[b] = 0;
  };
  try {
    for await (const blk of source) {
      signal?.throwIfAborted();
      for (let off = 0; off < blk.length; off += width) {
        const b = blk[off + depth]!;
        blk.copy(pending[b]!, fill[b]!, off, off + width);
        fill[b]! += width;
        if (fill[b] === pending[b]!.length) await flush(b);
      }
      await onRecords?.(blk.length / width);
    }
    for (let b = 0; b < 256; b++) await flush(b);
  } finally {
    await Promise.all(handles.map((h) => h?.close()));
  }
  return files;
}

async function* fileBlocks(file: string): AsyncGenerator<Buffer> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (!bytesRead) break;
      yield Buffer.from(buf.subarray(0, bytesRead));
    }
  } finally {
    await fh.close();
  }
}

/** Sorts one bucket (all records share their first `depth` bytes) in memory and feeds the writer. */
async function sortBucket(file: string, width: number, depth: number, writer: ShardWriter): Promise<void> {
  const fh = await open(file, 'r');
  let buf: Buffer;
  try {
    const { size } = await fh.stat();
    buf = Buffer.allocUnsafe(size);
    let off = 0;
    while (off < size) {
      const { bytesRead } = await fh.read(buf, off, size - off, off);
      if (!bytesRead) break;
      off += bytesRead;
    }
  } finally {
    await fh.close();
  }
  const n = buf.length / width;
  const keys = new Uint32Array(n);
  const keyAt = Math.min(depth, width - 4);
  for (let i = 0; i < n; i++) keys[i] = buf.readUInt32BE(i * width + keyAt);
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => keys[a]! - keys[b]! || buf.compare(buf, b * width, b * width + width, a * width, a * width + width));
  for (let i = 0; i < n; i++) await writer.push(buf, idx[i]! * width);
}

/** Builds a version's shards and Bloom filter from staged digests. */
export async function build(source: AsyncIterable<Buffer | Uint8Array>, o: BuildOptions): Promise<BuildResult> {
  const width = WIDTH[o.kind];
  const prefixLen = prefixLenFor(o.total);
  const size = bloomSize(o.total, o.fpRate, o.bloomMaxBytes);
  const bloom = new Bloom(size.bits, size.hashes);
  const budget = o.sortBudgetBytes ?? 64 * 1024 * 1024;
  const writer = new ShardWriter({ blobs: o.blobs, blobPrefix: o.blobPrefix, width, prefixLen, bloom, maxShardBytes: Math.max(budget, 8 * 1024 * 1024), checkOrder: !!o.sorted });
  const total = Math.max(1, o.total);
  let seen = 0;
  let lastPct = -1;
  const report = async (from: number, span: number, done: number, message: string) => {
    const pct = Math.floor(from + (span * Math.min(done, total)) / total);
    if (pct !== lastPct) {
      lastPct = pct;
      await o.progress?.(pct, message);
    }
  };
  const blocks = recordBlocks(source, width);
  if (o.sorted) {
    for await (const blk of blocks) {
      o.signal?.throwIfAborted();
      for (let off = 0; off < blk.length; off += width) await writer.push(blk, off);
      seen += blk.length / width;
      await report(0, 90, seen, 'Writing shards');
    }
  } else {
    const work = path.join(o.workDir, `exprsn-leaked-${randomBytes(8).toString('hex')}`);
    await mkdir(work, { recursive: true, mode: 0o700 });
    try {
      const buckets = await partition(blocks, width, 0, work, (n) => {
        seen += n;
        return report(0, 45, seen, 'Partitioning by prefix');
      }, o.signal);
      let sorted = 0;
      const sortOne = async (file: string, depth: number): Promise<void> => {
        o.signal?.throwIfAborted();
        const { size: bytes } = await stat(file);
        if (bytes <= budget || depth >= width - 1) {
          await sortBucket(file, width, depth, writer);
          sorted += bytes / width;
          await report(45, 45, sorted, 'Sorting and writing shards');
        } else {
          const sub = await partition(recordBlocks(fileBlocks(file), width), width, depth, path.join(work, `d${depth}-${path.basename(file, '.bin')}`), undefined, o.signal);
          await rm(file, { force: true });
          for (const f of sub) if (f) await sortOne(f, depth + 1);
          return;
        }
        await rm(file, { force: true });
      };
      for (const f of buckets) if (f) await sortOne(f, 1);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
  await writer.flush();
  await o.progress?.(92, 'Writing the Bloom filter');
  const header = bloom.header();
  const data = bloom.data;
  await o.blobs.putStream(bloomKey(o.blobPrefix), (async function* () {
    yield header;
    for (let off = 0; off < data.length; off += 8 * 1024 * 1024) yield Buffer.from(data.buffer, data.byteOffset + off, Math.min(8 * 1024 * 1024, data.length - off));
  })());
  return { entries: writer.entries, duplicates: writer.duplicates, prefixLen, shards: writer.shards, bloom: size, bytes: writer.bytes };
}

// ---------- reading ----------

/** A byte-budgeted cache of shard contents shared by every version reader. */
export class ShardCache {
  private readonly map = new Map<string, Buffer>();
  private bytes = 0;
  constructor(private readonly maxBytes: number) {}

  get(key: string): Buffer | undefined {
    const v = this.map.get(key);
    if (v) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, v: Buffer): void {
    if (v.length > this.maxBytes) return;
    this.map.set(key, v);
    this.bytes += v.length;
    for (const [k, old] of this.map) {
      if (this.bytes <= this.maxBytes) break;
      this.map.delete(k);
      this.bytes -= old.length;
    }
  }

  dropPrefix(prefix: string): void {
    for (const [k, v] of this.map) {
      if (k.startsWith(prefix)) {
        this.map.delete(k);
        this.bytes -= v.length;
      }
    }
  }
}

/** One built version, opened for lookups: the Bloom filter in memory, shards read through the cache. */
export class VersionReader {
  private readonly inflight = new Map<string, Promise<Buffer | null>>();

  constructor(
    readonly id: string,
    readonly kind: HashKind,
    private readonly blobs: BlobStore,
    private readonly blobPrefix: string,
    private readonly prefixLen: number,
    private readonly shardSet: Set<string>,
    private readonly bloom: Bloom,
    private readonly cache: ShardCache
  ) {}

  static async open(blobs: BlobStore, cache: ShardCache, v: { id: string; kind: HashKind; blobPrefix: string; prefixLen: number; shards: string[] }): Promise<VersionReader> {
    const buf = await blobs.get(bloomKey(v.blobPrefix));
    if (!buf) throw new Error('The list version\'s Bloom filter is missing from the blob store');
    return new VersionReader(v.id, v.kind, blobs, v.blobPrefix, v.prefixLen, new Set(v.shards), Bloom.from(buf), cache);
  }

  private async shard(hex: string): Promise<Buffer | null> {
    const key = shardKey(this.blobPrefix, hex);
    const hit = this.cache.get(key);
    if (hit) return hit;
    let p = this.inflight.get(key);
    if (!p) {
      p = this.blobs.get(key).then((b) => {
        if (!b) throw new Error('A shard of the list is missing from the blob store');
        this.cache.set(key, b);
        return b;
      });
      p.finally(() => this.inflight.delete(key)).catch(() => undefined);
      this.inflight.set(key, p);
    }
    return p;
  }

  /** Whether the version holds this digest (the Bloom filter first, then a binary search of one shard). */
  async has(digest: Buffer): Promise<boolean> {
    if (!this.bloom.has(digest)) return false;
    const hex = digest.toString('hex', 0, this.prefixLen / 2).toUpperCase();
    if (!this.shardSet.has(hex)) return false;
    const buf = await this.shard(hex);
    return !!buf && binarySearch(buf, WIDTH[this.kind], digest);
  }

  /** Every digest whose upper-case hex starts with `prefix` (five characters: the range API's k-anonymous prefix). */
  async range(prefix: string): Promise<Buffer[]> {
    const width = WIDTH[this.kind];
    const keys = this.prefixLen <= prefix.length ? [prefix.slice(0, this.prefixLen)] : [...'0123456789ABCDEF'].map((c) => (prefix + c).slice(0, this.prefixLen));
    const out: Buffer[] = [];
    for (const k of keys) {
      if (!this.shardSet.has(k)) continue;
      const buf = await this.shard(k);
      if (!buf) continue;
      for (let off = 0; off < buf.length; off += width) {
        if (buf.toString('hex', off, off + 3).toUpperCase().startsWith(prefix)) out.push(buf.subarray(off, off + width));
      }
    }
    return out;
  }
}

export function binarySearch(buf: Buffer, width: number, digest: Buffer): boolean {
  let lo = 0;
  let hi = buf.length / width;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const c = digest.compare(buf, mid * width, mid * width + width, 0, width);
    if (c === 0) return true;
    if (c > 0) lo = mid + 1;
    else hi = mid;
  }
  return false;
}
