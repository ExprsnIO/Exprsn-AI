import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config/index.js';

/** Object storage for exports, attachments and audit checkpoints. Keys are `/`-separated relative paths. */
export interface BlobStore {
  readonly kind: 'fs' | 's3';
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  /** Deletes every object under a prefix; returns how many. */
  deletePrefix(prefix: string): Promise<number>;
  health(): Promise<{ ok: boolean; detail: string }>;
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

  private async send(method: string, url: URL, body?: Buffer, extra: Record<string, string> = {}): Promise<Response> {
    const payloadHash = sha256hex(body ?? '');
    const headers = signV4({ method, url, headers: extra, payloadHash, region: this.o.region, service: 's3', accessKeyId: this.o.accessKeyId, secretAccessKey: this.o.secretAccessKey, date: new Date() });
    delete headers.host;
    return fetch(url, { method, headers, body: body ? new Uint8Array(body) : undefined, signal: AbortSignal.timeout(30_000) });
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
