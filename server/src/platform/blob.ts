import { createHash, createHmac } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rm, stat, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Config } from '../config/index.js';

/** A source of bytes for `putStream`: a Node stream, an async generator, anything async-iterable over buffers. */
export type ByteSource = AsyncIterable<Buffer | Uint8Array>;

export interface BlobObject {
  key: string;
  size: number;
  /** When the object was last written (ms), where the store says (1.6.0, B-4204: the orphan grace period). */
  modified?: number;
}

/** Object storage for exports, attachments and audit checkpoints. Keys are `/`-separated relative paths. */
export interface BlobStore {
  readonly kind: 'fs' | 's3';
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  /** Deletes every object under a prefix; returns how many. */
  deletePrefix(prefix: string): Promise<number>;
  health(): Promise<{ ok: boolean; detail: string }>;
  /**
   * Sprint 15 (B-411): writes an object from a stream without holding it in memory (filesystem: a temporary file
   * renamed into place; S3: multipart upload in fixed-size parts). A reader never sees half an object.
   */
  putStream(key: string, source: ByteSource, contentType?: string): Promise<{ bytes: number }>;
  /** Reads an object as a stream, with its size; null when it does not exist. */
  getStream(key: string): Promise<{ stream: Readable; size: number } | null>;
  /** Every object under a prefix ('' for all), in no particular order. */
  list(prefix: string): AsyncIterable<BlobObject>;
}

const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,511}$/;

export function checkKey(key: string): string {
  if (!SAFE_KEY.test(key) || key.split('/').some((p) => p === '' || p === '.' || p === '..')) throw new Error(`Invalid blob key: ${key}`);
  return key;
}

export class FsBlobStore implements BlobStore {
  readonly kind = 'fs' as const;
  private readonly root: string;

  constructor(dir: string) {
    this.root = path.resolve(dir);
  }

  private file(key: string): string {
    return path.join(this.root, checkKey(key));
  }

  async put(key: string, data: Buffer): Promise<void> {
    const f = this.file(key);
    await mkdir(path.dirname(f), { recursive: true });
    // Write then rename, so a reader never sees half an object.
    const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, f);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.file(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.file(key), { force: true });
  }

  async putStream(key: string, source: ByteSource): Promise<{ bytes: number }> {
    const f = this.file(key);
    await mkdir(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    let bytes = 0;
    const counted = async function* () {
      for await (const c of source) {
        bytes += c.length;
        yield c;
      }
    };
    try {
      await pipeline(Readable.from(counted()), createWriteStream(tmp, { mode: 0o600 }));
      await rename(tmp, f);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    return { bytes };
  }

  async getStream(key: string): Promise<{ stream: Readable; size: number } | null> {
    let fh;
    try {
      fh = await open(this.file(key), 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    // The size and the bytes come from the same open file, so a concurrent replace (a rename) cannot mix them.
    const { size } = await fh.stat();
    return { stream: fh.createReadStream({ highWaterMark: 1024 * 1024 }), size };
  }

  async *list(prefix: string): AsyncIterable<BlobObject> {
    const clean = prefix.replace(/\/$/, '');
    const start = clean ? path.join(this.root, checkKey(clean)) : this.root;
    const walk = async function* (d: string, root: string): AsyncGenerator<BlobObject> {
      let entries;
      try {
        entries = await readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) yield* walk(full, root);
        else if (e.isFile() && !e.name.endsWith('.tmp')) {
          const st = await stat(full).catch(() => null);
          if (st) yield { key: path.relative(root, full).split(path.sep).join('/'), size: st.size, modified: Math.round(st.mtimeMs) };
        }
      }
    };
    yield* walk(start, this.root);
  }

  async deletePrefix(prefix: string): Promise<number> {
    const dir = path.join(this.root, checkKey(prefix.replace(/\/$/, '')));
    let n = 0;
    const walk = async (d: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.isDirectory()) await walk(path.join(d, e.name));
        else n++;
      }
    };
    await walk(dir);
    await rm(dir, { recursive: true, force: true });
    return n;
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      await mkdir(this.root, { recursive: true });
      await stat(this.root);
      return { ok: true, detail: `filesystem ${this.root}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }
}

const sha256hex = (d: string | Buffer) => createHash('sha256').update(d).digest('hex');
const hmacRaw = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d).digest();
const encodePath = (p: string) => p.split('/').map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');

export interface SigV4Input {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  date: Date;
}

/** AWS Signature Version 4 (header auth). Returns the headers to send, including Authorization. */
export function signV4(i: SigV4Input): Record<string, string> {
  const amzDate = i.date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...i.headers, host: i.url.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': i.payloadHash };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  const query = [...i.url.searchParams.entries()]
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
    .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : a[1]! < b[1]! ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonical = [i.method, encodePath(decodeURIComponent(i.url.pathname)), query, names.map((n) => `${n}:${lower[n]}\n`).join(''), names.join(';'), i.payloadHash].join('\n');
  const scope = `${day}/${i.region}/${i.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const kDate = hmacRaw('AWS4' + i.secretAccessKey, day);
  const kSigning = hmacRaw(hmacRaw(hmacRaw(kDate, i.region), i.service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
  return { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

/** S3-compatible object storage (MinIO, Ceph RGW, SeaweedFS, AWS) with SigV4 over fetch. */
export class S3BlobStore implements BlobStore {
  readonly kind = 's3' as const;

  constructor(
    private readonly o: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; pathStyle: boolean; prefix?: string }
  ) {}

  private url(key: string, query: Record<string, string> = {}): URL {
    const base = new URL(this.o.endpoint);
    const u = this.o.pathStyle ? new URL(`${base.origin}/${this.o.bucket}/${key}`) : new URL(`${base.protocol}//${this.o.bucket}.${base.host}/${key}`);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u;
  }

  private async send(method: string, url: URL, body?: Buffer, extra: Record<string, string> = {}, timeoutMs = 30_000): Promise<Response> {
    const payloadHash = sha256hex(body ?? '');
    const headers = signV4({ method, url, headers: extra, payloadHash, region: this.o.region, service: 's3', accessKeyId: this.o.accessKeyId, secretAccessKey: this.o.secretAccessKey, date: new Date() });
    delete headers.host;
    return fetch(url, { method, headers, body: body ? new Uint8Array(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  }

  private k(key: string): string {
    return (this.o.prefix ?? '') + checkKey(key);
  }

  async put(key: string, data: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    const res = await this.send('PUT', this.url(this.k(key)), data, { 'content-type': contentType });
    if (!res.ok) throw new Error(`S3 PUT ${key}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }

  async get(key: string): Promise<Buffer | null> {
    const res = await this.send('GET', this.url(this.k(key)));
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 GET ${key}: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const res = await this.send('DELETE', this.url(this.k(key)));
    if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE ${key}: ${res.status}`);
  }

  /** Multipart parts: 16 MiB (S3's minimum is 5 MiB), so up to 160 GiB in its 10,000 parts. */
  static PART_BYTES = 16 * 1024 * 1024;

  async putStream(key: string, source: ByteSource, contentType = 'application/octet-stream'): Promise<{ bytes: number }> {
    const partBytes = S3BlobStore.PART_BYTES;
    const k = this.k(key);
    let uploadId: string | null = null;
    const etags: string[] = [];
    let bytes = 0;
    let pending: Buffer[] = [];
    let pendingLen = 0;
    const flush = async (last: boolean) => {
      if (!pendingLen && !last) return;
      const body = Buffer.concat(pending, pendingLen);
      pending = [];
      pendingLen = 0;
      if (!uploadId) {
        if (last) {
          // Small object: one PUT.
          const res = await this.send('PUT', this.url(k), body, { 'content-type': contentType }, 10 * 60_000);
          if (!res.ok) throw new Error(`S3 PUT ${key}: ${res.status} ${(await res.text()).slice(0, 200)}`);
          return;
        }
        const res = await this.send('POST', this.url(k, { uploads: '' }), undefined, { 'content-type': contentType });
        const xml = await res.text();
        if (!res.ok) throw new Error(`S3 multipart start ${key}: ${res.status} ${xml.slice(0, 200)}`);
        uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(xml)?.[1] ?? null;
        if (!uploadId) throw new Error(`S3 multipart start ${key}: no upload id`);
      }
      if (!body.length && etags.length) return;
      const res = await this.send('PUT', this.url(k, { partNumber: String(etags.length + 1), uploadId }), body, {}, 10 * 60_000);
      if (!res.ok) throw new Error(`S3 part ${etags.length + 1} of ${key}: ${res.status} ${(await res.text()).slice(0, 200)}`);
      etags.push(res.headers.get('etag') ?? '');
    };
    try {
      for await (const chunk of source) {
        let c = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        bytes += c.length;
        while (pendingLen + c.length >= partBytes) {
          const take = partBytes - pendingLen;
          pending.push(c.subarray(0, take));
          pendingLen += take;
          c = c.subarray(take);
          await flush(false);
        }
        if (c.length) {
          pending.push(Buffer.from(c));
          pendingLen += c.length;
        }
      }
      await flush(true);
      if (uploadId) {
        const xml = `<CompleteMultipartUpload>${etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
        const res = await this.send('POST', this.url(k, { uploadId }), Buffer.from(xml), { 'content-type': 'application/xml' });
        const text = await res.text();
        // S3 can answer 200 with an error document when completion fails late.
        if (!res.ok || /<Error>/.test(text)) throw new Error(`S3 multipart complete ${key}: ${res.status} ${text.slice(0, 200)}`);
      }
      return { bytes };
    } catch (err) {
      if (uploadId) await this.send('DELETE', this.url(k, { uploadId })).catch(() => undefined);
      throw err;
    }
  }

  async getStream(key: string): Promise<{ stream: Readable; size: number } | null> {
    const url = this.url(this.k(key));
    const headers = signV4({ method: 'GET', url, headers: {}, payloadHash: sha256hex(''), region: this.o.region, service: 's3', accessKeyId: this.o.accessKeyId, secretAccessKey: this.o.secretAccessKey, date: new Date() });
    delete headers.host;
    const res = await fetch(url, { method: 'GET', headers });
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok || !res.body) throw new Error(`S3 GET ${key}: ${res.status}`);
    return { stream: Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>), size: Number(res.headers.get('content-length') ?? 0) };
  }

  async *list(prefix: string): AsyncIterable<BlobObject> {
    let token: string | undefined;
    const base = this.o.prefix ?? '';
    do {
      const q: Record<string, string> = { 'list-type': '2', prefix: base + (prefix ? prefix.replace(/\/?$/, '/') : '') };
      if (token) q['continuation-token'] = token;
      const res = await this.send('GET', this.url('', q));
      if (!res.ok) throw new Error(`S3 LIST ${prefix}: ${res.status}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = /<Key>([^<]+)<\/Key>/.exec(m[1]!)?.[1]?.replace(/&amp;/g, '&');
        const size = Number(/<Size>(\d+)<\/Size>/.exec(m[1]!)?.[1] ?? 0);
        const at = Date.parse(/<LastModified>([^<]+)<\/LastModified>/.exec(m[1]!)?.[1] ?? '');
        if (key && key.startsWith(base)) yield { key: key.slice(base.length), size, ...(Number.isFinite(at) ? { modified: at } : {}) };
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextContinuationToken>([^<]+)</.exec(xml)?.[1] : undefined;
    } while (token);
  }

  async deletePrefix(prefix: string): Promise<number> {
    let n = 0;
    let token: string | undefined;
    do {
      const q: Record<string, string> = { 'list-type': '2', prefix: this.k(prefix.replace(/\/?$/, '/')) };
      if (token) q['continuation-token'] = token;
      const res = await this.send('GET', this.url('', q));
      if (!res.ok) throw new Error(`S3 LIST ${prefix}: ${res.status}`);
      const xml = await res.text();
      const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]!.replace(/&amp;/g, '&'));
      for (const key of keys) {
        const r = await this.send('DELETE', this.url(key));
        if (r.ok || r.status === 404) n++;
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextContinuationToken>([^<]+)</.exec(xml)?.[1] : undefined;
    } while (token);
    return n;
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await this.send('HEAD', this.url(''));
      return { ok: res.ok, detail: `S3 bucket ${this.o.bucket}: ${res.status}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message };
    }
  }
}

export function createBlobStore(cfg: Config): BlobStore {
  if (cfg.BLOB_STORE === 's3') {
    return new S3BlobStore({
      endpoint: cfg.S3_ENDPOINT as string,
      region: cfg.S3_REGION,
      bucket: cfg.S3_BUCKET as string,
      accessKeyId: cfg.S3_ACCESS_KEY_ID as string,
      secretAccessKey: cfg.S3_SECRET_ACCESS_KEY as string,
      pathStyle: cfg.S3_FORCE_PATH_STYLE
    });
  }
  return new FsBlobStore(cfg.BLOB_DIR);
}
