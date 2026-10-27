import type { BlobStore } from '../../platform/blob.js';
import { WIDTH, type HashKind } from './hashes.js';

/*
 * 1.9.0, Sprint 55 (B-192): a local mirror of the Pwned Passwords corpus through its range API.
 *
 * The corpus is read as the API serves it, one range per five-hex-character prefix (16^5 = 1,048,576 requests), at
 * most LEAKED_MIRROR_RPS requests a second with a few in flight. Prefixes are fetched in batches; each batch's digests
 * (prefix + suffix, count 0 padding dropped, counts never kept) go into one chunk in the blob store, and only then does
 * the version's cursor move past the batch. A stopped or failed mirror resumes from the cursor: the batch it was in is
 * fetched again and its chunk replaced. Because prefixes are walked in order and each range is sorted, the chunks in
 * order are the whole corpus in ascending order, which the builder reads without sorting.
 *
 * This is an explicit admin action (a platform list, `platform:manage`), never automatic. Tests point it at a fake
 * range server; it never contacts anything but the URL it is given.
 */

export const RANGE_PREFIXES = 16 ** 5;
export const MIRROR_BATCH = 4096;

export const chunkKey = (blobPrefix: string, batch: number): string => `${blobPrefix}/staging/mirror-${String(batch).padStart(6, '0')}.bin`;
export const prefixHex = (i: number): string => i.toString(16).toUpperCase().padStart(5, '0');

/** Spaces request starts `1000 / rps` ms apart across every worker. */
export class RateGate {
  private next = 0;
  private readonly interval: number;
  constructor(rps: number) {
    this.interval = 1000 / Math.max(0.1, rps);
  }

  async take(signal?: AbortSignal): Promise<void> {
    const t = Date.now();
    const at = Math.max(t, this.next);
    this.next = at + this.interval;
    if (at > t) await sleep(at - t, signal);
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });

export interface MirrorOptions {
  baseUrl: string;
  kind: HashKind;
  blobs: BlobStore;
  blobPrefix: string;
  rps: number;
  concurrency?: number;
  timeoutMs: number;
  /** The first prefix not yet fetched, and how many prefixes there are (16^5, fewer in tests). */
  cursor: number;
  total: number;
  batch?: number;
  signal?: AbortSignal;
  /** Called after each batch's chunk is written: the new cursor and how many digests the batch held. */
  advanced(cursor: number, records: number): Promise<void>;
  fetch?: typeof fetch;
}

/** One range: `SUFFIX:COUNT` lines; returns the full digests with a count above zero, in order. */
async function fetchRange(o: MirrorOptions, prefix: string, gate: RateGate): Promise<Buffer[]> {
  const width = WIDTH[o.kind];
  const url = `${o.baseUrl.replace(/\/+$/, '')}/range/${prefix}${o.kind === 'ntlm' ? '?mode=ntlm' : ''}`;
  const doFetch = o.fetch ?? fetch;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    await gate.take(o.signal);
    try {
      const res = await doFetch(url, { headers: { 'User-Agent': 'Exprsn-AI leaked-password mirror' }, signal: o.signal ? AbortSignal.any([o.signal, AbortSignal.timeout(o.timeoutMs)]) : AbortSignal.timeout(o.timeoutMs), redirect: 'error' });
      if (res.status === 429 || res.status >= 500) {
        const after = Number(res.headers.get('retry-after') ?? '');
        await res.body?.cancel().catch(() => undefined);
        lastErr = new Error(`range API answered ${res.status} for ${prefix}`);
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : 250 * 2 ** attempt, o.signal);
        continue;
      }
      if (!res.ok) throw new Error(`range API answered ${res.status} for ${prefix}`);
      const out: Buffer[] = [];
      for (const raw of (await res.text()).split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const [suffix, count] = line.split(':');
        if (!suffix || Number(count ?? '1') <= 0) continue;
        const hex = prefix + suffix.toUpperCase();
        if (hex.length !== width * 2 || !/^[0-9A-F]+$/.test(hex)) throw new Error(`range ${prefix} has a line that is not a ${o.kind} suffix`);
        out.push(Buffer.from(hex, 'hex'));
      }
      out.sort(Buffer.compare);
      return out;
    } catch (err) {
      if (o.signal?.aborted) throw err;
      lastErr = err as Error;
      if (/answered 4\d\d/.test(lastErr.message) && !/429/.test(lastErr.message)) throw lastErr;
      await sleep(250 * 2 ** attempt, o.signal);
    }
  }
  throw lastErr ?? new Error(`range ${prefix} failed`);
}

/** Fetches from `cursor` to `total`, a batch at a time; resumable. */
export async function runMirror(o: MirrorOptions): Promise<void> {
  const gate = new RateGate(o.rps);
  const batch = o.batch ?? MIRROR_BATCH;
  const workers = Math.max(1, Math.min(o.concurrency ?? 4, 16));
  let cursor = o.cursor - (o.cursor % batch);
  while (cursor < o.total) {
    o.signal?.throwIfAborted();
    const end = Math.min(o.total, cursor + batch);
    const results: Buffer[][] = new Array(end - cursor);
    let next = cursor;
    let failed: { err: unknown } | null = null;
    // On the first failure the other workers finish the request they are in and stop, so nothing of this run is
    // still in flight when it throws (a resume starts clean at the batch's first prefix).
    const worker = async () => {
      for (;;) {
        if (failed) return;
        const i = next++;
        if (i >= end) return;
        try {
          results[i - cursor] = await fetchRange(o, prefixHex(i), gate);
        } catch (err) {
          failed ??= { err };
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: workers }, worker));
    if (failed) throw (failed as { err: unknown }).err;
    const flat = results.flat();
    await o.blobs.put(chunkKey(o.blobPrefix, cursor / batch), Buffer.concat(flat));
    cursor = end;
    await o.advanced(cursor, flat.length);
  }
}

/** The mirror's chunks in order, as one stream for the builder, and their total size. */
export async function mirrorChunks(blobs: BlobStore, blobPrefix: string, total: number, batch = MIRROR_BATCH): Promise<{ bytes: number; stream: AsyncIterable<Buffer> }> {
  const n = Math.ceil(total / batch);
  let bytes = 0;
  const keys: string[] = [];
  for (let b = 0; b < n; b++) {
    const k = chunkKey(blobPrefix, b);
    const s = await blobs.getStream(k);
    if (!s) throw new Error(`Mirror chunk ${b} is missing; resume the mirror`);
    s.stream.destroy();
    bytes += s.size;
    keys.push(k);
  }
  return {
    bytes,
    stream: (async function* () {
      for (const k of keys) {
        const s = await blobs.getStream(k);
        if (!s) throw new Error('A mirror chunk disappeared while building');
        for await (const c of s.stream) yield c as Buffer;
      }
    })()
  };
}
