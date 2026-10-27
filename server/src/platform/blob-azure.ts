import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Config } from '../config/index.js';
import type { CloudResponse, CloudTransport } from '../cloud/providers/transport.js';
import { checkKey, type BlobObject, type BlobStore, type ByteSource } from './blob.js';
import { azureInstallCredential, installTransport, STORAGE_SCOPE, type AzureCredential } from './cloud-identity.js';

/*
 * 1.9.99-final, Sprint 58 (B-10208): `BLOB_STORE=azure`, the Azure Blob service REST API (block blobs) through
 * `CloudTransport`. Authorisation is an Entra token for Storage (the install's identity: a Storage Blob Data
 * Contributor role on the container) or Shared Key with the account key (BLOB_AZURE_ACCOUNT_KEY_FILE).
 *
 * - put: one Put Blob up to `CHUNK_BYTES`, else as putStream.
 * - putStream: Put Block per `CHUNK_BYTES` (8 MiB, so up to about 390 GiB in 50,000 blocks), then Put Block List;
 *   staged blocks are invisible until the list is committed, so a reader never sees half an object, and a failed
 *   upload leaves only uncommitted blocks, which the service discards after a week.
 * - get and getStream: ranged reads of `CHUNK_BYTES` (`x-ms-range`), every read after the first conditional on the
 *   first one's ETag (`If-Match`), so an object replaced while it is read fails instead of mixing two versions.
 * - list: List Blobs by prefix with paging (`marker`); deletePrefix deletes what it lists.
 */

const VERSION = '2021-08-06';

export interface AzureBlobOptions {
  /** The account's blob endpoint: https://<account>.blob.core.windows.net (or a private endpoint, or a path-style emulator URL). */
  endpoint: string;
  container: string;
  transport: CloudTransport;
  /** An Entra identity (tokens for https://storage.azure.com). */
  credential?: AzureCredential;
  /** Shared Key: the account name and its key (base64). */
  account?: string;
  accountKey?: string;
  /** Keys are stored under this prefix (none by default). */
  prefix?: string;
}

const xmlDecode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (xml: string, name: string) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? xmlDecode(m[1]!) : null;
};

export class AzureBlobStore implements BlobStore {
  readonly kind = 'azure' as const;
  /** Block and range size: 8 MiB. */
  static CHUNK_BYTES = 8 * 1024 * 1024;
  /** Names per List Blobs page. */
  static LIST_PAGE = 1000;
  private readonly base: string;
  private readonly account: string;

  constructor(private readonly o: AzureBlobOptions) {
    this.base = `${o.endpoint.replace(/\/+$/, '')}/${o.container}`;
    this.account = o.account ?? new URL(o.endpoint).hostname.split('.')[0]!;
    if (!o.credential && !o.accountKey) throw new Error('The Azure blob store needs an Entra identity or the account key.');
  }

  private k(key: string): string {
    return (this.o.prefix ?? '') + checkKey(key);
  }

  private url(blob: string | null, query: Record<string, string> = {}): URL {
    const u = new URL(blob ? `${this.base}/${blob}` : this.base);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u;
  }

  /** Shared Key (Blob service, 2009-09-19 and later): HMAC-SHA256 over the canonical request with the account key. */
  private sharedKey(method: string, url: URL, headers: Record<string, string>, length: number): string {
    const h = (n: string) => headers[n] ?? '';
    const xms = Object.keys(headers).filter((n) => n.startsWith('x-ms-')).sort().map((n) => `${n}:${headers[n]!.trim()}\n`).join('');
    const params = new Map<string, string[]>();
    for (const [k, v] of url.searchParams) params.set(k.toLowerCase(), [...(params.get(k.toLowerCase()) ?? []), v]);
    const resource = `/${this.account}${url.pathname}` + [...params.keys()].sort().map((k) => `\n${k}:${params.get(k)!.sort().join(',')}`).join('');
    const toSign = [method, h('content-encoding'), h('content-language'), length ? String(length) : '', h('content-md5'), h('content-type'), '', h('if-modified-since'), h('if-match'), h('if-none-match'), h('if-unmodified-since'), h('range')].join('\n') + '\n' + xms + resource;
    const sig = createHmac('sha256', Buffer.from(this.o.accountKey!, 'base64')).update(toSign, 'utf8').digest('base64');
    return `SharedKey ${this.account}:${sig}`;
  }

  private async send(method: string, url: URL, o: { body?: Buffer; headers?: Record<string, string> } = {}): Promise<CloudResponse> {
    const headers: Record<string, string> = { 'x-ms-version': VERSION, 'x-ms-date': new Date().toUTCString(), ...(o.headers ?? {}) };
    if (this.o.accountKey) headers.authorization = this.sharedKey(method, url, headers, o.body?.length ?? 0);
    else headers.authorization = `Bearer ${(await this.o.credential!.getToken(STORAGE_SCOPE)).token}`;
    return this.o.transport.send({ method, url, headers, ...(o.body ? { body: o.body } : method === 'PUT' ? { body: Buffer.alloc(0) } : {}), accountId: 'install-blob' });
  }

  private fail(what: string, key: string, res: CloudResponse): Error {
    const code = res.headers['x-ms-error-code'] ?? tag(res.body.toString('utf8', 0, 4096), 'Code');
    return new Error(`Azure Blob ${what} ${key}: ${res.status}${code ? ` ${code}` : ''}`);
  }

  async put(key: string, data: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    if (data.length > AzureBlobStore.CHUNK_BYTES) {
      await this.putStream(key, Readable.from([data]), contentType);
      return;
    }
    const res = await this.send('PUT', this.url(this.k(key)), { body: data, headers: { 'x-ms-blob-type': 'BlockBlob', 'content-type': contentType } });
    if (res.status !== 201) throw this.fail('PUT', key, res);
  }

  async putStream(key: string, source: ByteSource, contentType = 'application/octet-stream'): Promise<{ bytes: number }> {
    const size = AzureBlobStore.CHUNK_BYTES;
    const blob = this.k(key);
    const ids: string[] = [];
    let bytes = 0;
    let pending: Buffer[] = [];
    let pendingLen = 0;
    const stage = async () => {
      const body = Buffer.concat(pending, pendingLen);
      pending = [];
      pendingLen = 0;
      // Every block id of a blob must have the same length.
      const id = Buffer.from(`exprsn-block-${String(ids.length).padStart(6, '0')}`).toString('base64');
      const res = await this.send('PUT', this.url(blob, { comp: 'block', blockid: id }), { body });
      if (res.status !== 201) throw this.fail(`block ${ids.length + 1} of`, key, res);
      ids.push(id);
    };
    for await (const chunk of source) {
      let c = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      bytes += c.length;
      while (c.length) {
        // A full chunk is staged only once more data follows: a chunk that ends the source may be the whole object.
        if (pendingLen === size) await stage();
        const take = Math.min(size - pendingLen, c.length);
        pending.push(Buffer.from(c.subarray(0, take)));
        pendingLen += take;
        c = c.subarray(take);
      }
    }
    if (!ids.length) {
      // Small object: one Put Blob.
      const res = await this.send('PUT', this.url(blob), { body: Buffer.concat(pending, pendingLen), headers: { 'x-ms-blob-type': 'BlockBlob', 'content-type': contentType } });
      if (res.status !== 201) throw this.fail('PUT', key, res);
      return { bytes };
    }
    if (pendingLen) await stage();
    const xml = `<?xml version="1.0" encoding="utf-8"?><BlockList>${ids.map((id) => `<Latest>${id}</Latest>`).join('')}</BlockList>`;
    const res = await this.send('PUT', this.url(blob, { comp: 'blocklist' }), { body: Buffer.from(xml), headers: { 'content-type': 'application/xml', 'x-ms-blob-content-type': contentType } });
    if (res.status !== 201) throw this.fail('block list of', key, res);
    return { bytes };
  }

  /** The first range of an object: its bytes, total size and ETag; null when it does not exist. */
  private async first(key: string): Promise<{ body: Buffer; size: number; etag: string } | null> {
    const url = this.url(this.k(key));
    const res = await this.send('GET', url, { headers: { 'x-ms-range': `bytes=0-${AzureBlobStore.CHUNK_BYTES - 1}` } });
    if (res.status === 404) return null;
    if (res.status === 416) {
      // A range of an empty blob is not satisfiable: tell an empty blob from a missing one.
      const head = await this.send('HEAD', url);
      if (head.status === 404) return null;
      if (head.status !== 200) throw this.fail('HEAD', key, head);
      return { body: Buffer.alloc(0), size: Number(head.headers['content-length'] ?? 0), etag: head.headers.etag ?? '' };
    }
    if (res.status === 200) return { body: res.body, size: res.body.length, etag: res.headers.etag ?? '' };
    if (res.status !== 206) throw this.fail('GET', key, res);
    const total = Number(/\/(\d+)$/.exec(res.headers['content-range'] ?? '')?.[1] ?? res.body.length);
    return { body: res.body, size: total, etag: res.headers.etag ?? '' };
  }

  private async *rest(key: string, from: number, size: number, etag: string): AsyncGenerator<Buffer> {
    const url = this.url(this.k(key));
    for (let at = from; at < size; at += AzureBlobStore.CHUNK_BYTES) {
      const end = Math.min(size, at + AzureBlobStore.CHUNK_BYTES) - 1;
      const res = await this.send('GET', url, { headers: { 'x-ms-range': `bytes=${at}-${end}`, ...(etag ? { 'if-match': etag } : {}) } });
      if (res.status === 412) throw new Error(`Azure Blob GET ${key}: the object changed while it was read`);
      if (res.status !== 206 && res.status !== 200) throw this.fail('GET', key, res);
      yield res.body;
    }
  }

  async get(key: string): Promise<Buffer | null> {
    const f = await this.first(key);
    if (!f) return null;
    if (f.body.length >= f.size) return f.body;
    const parts = [f.body];
    for await (const b of this.rest(key, f.body.length, f.size, f.etag)) parts.push(b);
    return Buffer.concat(parts);
  }

  async getStream(key: string): Promise<{ stream: Readable; size: number } | null> {
    const f = await this.first(key);
    if (!f) return null;
    const rest = (from: number) => this.rest(key, from, f.size, f.etag);
    const gen = async function* (): AsyncGenerator<Buffer> {
      if (f.body.length) yield f.body;
      if (f.body.length < f.size) yield* rest(f.body.length);
    };
    return { stream: Readable.from(gen()), size: f.size };
  }

  async delete(key: string): Promise<void> {
    const res = await this.send('DELETE', this.url(this.k(key)));
    if (res.status !== 202 && res.status !== 200 && res.status !== 404) throw this.fail('DELETE', key, res);
  }

  async *list(prefix: string): AsyncIterable<BlobObject> {
    const base = this.o.prefix ?? '';
    let marker = '';
    do {
      const q: Record<string, string> = { restype: 'container', comp: 'list', prefix: base + (prefix ? prefix.replace(/\/?$/, '/') : ''), maxresults: String(AzureBlobStore.LIST_PAGE) };
      if (marker) q.marker = marker;
      const res = await this.send('GET', this.url(null, q));
      if (res.status !== 200) throw this.fail('LIST', prefix, res);
      const xml = res.body.toString('utf8');
      for (const m of xml.matchAll(/<Blob>([\s\S]*?)<\/Blob>/g)) {
        const name = tag(m[1]!, 'Name');
        const size = Number(tag(m[1]!, 'Content-Length') ?? 0);
        const at = Date.parse(tag(m[1]!, 'Last-Modified') ?? '');
        if (name && name.startsWith(base)) yield { key: name.slice(base.length), size, ...(Number.isFinite(at) ? { modified: at } : {}) };
      }
      marker = tag(xml, 'NextMarker') ?? '';
    } while (marker);
  }

  async deletePrefix(prefix: string): Promise<number> {
    const keys: string[] = [];
    for await (const o of this.list(prefix.replace(/\/$/, ''))) keys.push(o.key);
    let n = 0;
    for (const key of keys) {
      const res = await this.send('DELETE', this.url(this.k(key)));
      if (res.status === 202 || res.status === 200 || res.status === 404) n++;
    }
    return n;
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await this.send('GET', this.url(null, { restype: 'container' }));
      return { ok: res.status === 200, detail: `Azure Blob container ${this.o.container}: ${res.status}` };
    } catch (err) {
      return { ok: false, detail: (err as Error).message.slice(0, 300) };
    }
  }
}

/** BLOB_STORE=azure from the configuration: the account key when given, else the install's Azure identity. */
export function createAzureBlobStore(cfg: Config): AzureBlobStore {
  return new AzureBlobStore({
    endpoint: cfg.BLOB_AZURE_ENDPOINT as string,
    container: cfg.BLOB_AZURE_CONTAINER as string,
    transport: installTransport(cfg, 'azure', AzureBlobStore.CHUNK_BYTES + 1024 * 1024),
    ...(cfg.BLOB_AZURE_ACCOUNT_KEY ? { accountKey: cfg.BLOB_AZURE_ACCOUNT_KEY, ...(cfg.BLOB_AZURE_ACCOUNT ? { account: cfg.BLOB_AZURE_ACCOUNT } : {}) } : { credential: azureInstallCredential(cfg) })
  });
}
