/*
 * Sprint 23 fakes: an S3-compatible bucket (ListObjectsV2 and GET, path style, checking the SigV4 key id) and a
 * small web site whose pages, robots.txt and sitemap a test sets, answering conditional requests with 304.
 */
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

const listen = (server: Server): Promise<string> =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export class FakeS3 {
  url = '';
  objects = new Map<string, { body: string; etag: string }>();
  /** 1.9.99-final, Sprint 61 (B-10906): the signing region of each request (`auto` for R2). */
  requests: { method: string; path: string; keyId: string | null; region?: string | null }[] = [];
  /** Binary objects written through PUT and multipart uploads (B-10906), kept apart from the text `objects` a test seeds. */
  blobs = new Map<string, Buffer>();
  private uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  private uploadSeq = 0;
  constructor(
    readonly bucket: string,
    readonly accessKeyId: string
  ) {}

  private readonly server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => this.serve(req, res, Buffer.concat(chunks)));
  });

  private serve(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
    const u = new URL(req.url ?? '/', 'http://x');
    const keyId = /Credential=([^/]+)\//.exec(String(req.headers.authorization ?? ''))?.[1] ?? null;
    const region = /Credential=[^/]+\/\d{8}\/([^/]+)\//.exec(String(req.headers.authorization ?? ''))?.[1] ?? null;
    this.requests.push({ method: req.method ?? 'GET', path: u.pathname + u.search, keyId, region });
    if (keyId !== this.accessKeyId) {
      res.writeHead(403, { 'content-type': 'application/xml' });
      res.end('<Error><Code>InvalidAccessKeyId</Code></Error>');
      return;
    }
    const [, bucket, ...rest] = u.pathname.split('/');
    if (bucket !== this.bucket) {
      res.writeHead(404);
      res.end('<Error><Code>NoSuchBucket</Code></Error>');
      return;
    }
    if (u.searchParams.get('list-type') === '2') {
      const prefix = u.searchParams.get('prefix') ?? '';
      const items: [string, { etag: string; size: number }][] = [...[...this.objects.entries()].map(([k, v]): [string, { etag: string; size: number }] => [k, { etag: v.etag, size: Buffer.byteLength(v.body) }]), ...[...this.blobs.entries()].map(([k, v]): [string, { etag: string; size: number }] => [k, { etag: 'blob', size: v.length }])].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1));
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<?xml version="1.0"?><ListBucketResult>${items.map(([k, v]) => `<Contents><Key>${esc(k)}</Key><LastModified>2026-09-30T08:00:00.000Z</LastModified><ETag>&quot;${v.etag}&quot;</ETag><Size>${v.size}</Size></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`);
      return;
    }
    const key = decodeURIComponent(rest.join('/'));
    // 1.9.99-final, Sprint 61 (B-10906): writes, deletes and multipart uploads, so a blob store (a backup) can live here.
    const method = req.method ?? 'GET';
    const uploadId = u.searchParams.get('uploadId');
    if (method === 'HEAD' && !key) {
      res.writeHead(200);
      res.end();
      return;
    }
    if (method === 'POST' && u.searchParams.has('uploads')) {
      const id = `up-${++this.uploadSeq}`;
      this.uploads.set(id, { key, parts: new Map() });
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<?xml version="1.0"?><InitiateMultipartUploadResult><Bucket>${esc(this.bucket)}</Bucket><Key>${esc(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
      return;
    }
    if (method === 'PUT' && uploadId) {
      const up = this.uploads.get(uploadId);
      if (!up) {
        res.writeHead(404);
        res.end('<Error><Code>NoSuchUpload</Code></Error>');
        return;
      }
      up.parts.set(Number(u.searchParams.get('partNumber')), body);
      res.writeHead(200, { etag: `"part-${up.parts.size}"` });
      res.end();
      return;
    }
    if (method === 'POST' && uploadId) {
      const up = this.uploads.get(uploadId);
      if (!up) {
        res.writeHead(404);
        res.end('<Error><Code>NoSuchUpload</Code></Error>');
        return;
      }
      this.blobs.set(up.key, Buffer.concat([...up.parts.entries()].sort(([a], [b]) => a - b).map(([, b]) => b)));
      this.uploads.delete(uploadId);
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<?xml version="1.0"?><CompleteMultipartUploadResult><Key>${esc(up.key)}</Key></CompleteMultipartUploadResult>`);
      return;
    }
    if (method === 'DELETE') {
      if (uploadId) this.uploads.delete(uploadId);
      else {
        this.blobs.delete(key);
        this.objects.delete(key);
      }
      res.writeHead(204);
      res.end();
      return;
    }
    if (method === 'PUT') {
      this.blobs.set(key, body);
      res.writeHead(200, { etag: '"put"' });
      res.end();
      return;
    }
    const blob = this.blobs.get(key);
    if (blob) {
      res.writeHead(200, { etag: '"blob"', 'content-length': String(blob.length) });
      res.end(method === 'HEAD' ? undefined : blob);
      return;
    }
    const o = this.objects.get(key);
    res.writeHead(o ? 200 : 404, { etag: o ? `"${o.etag}"` : '' });
    res.end(o?.body ?? '');
  }

  get gets(): string[] {
    return this.requests.filter((r) => !r.path.includes('list-type')).map((r) => r.path);
  }

  async start(): Promise<this> {
    // Sprint 61: a slow run must not find a pooled connection closed under it (the restore reads after the backup).
    this.server.keepAliveTimeout = 120_000;
    this.url = await listen(this.server);
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }
}

export interface FakePage {
  status?: number;
  type?: string;
  body?: string;
  /** A binary body (an image), instead of `body`. */
  data?: Buffer;
  etag?: string;
  location?: string;
}

export class FakeSite {
  url = '';
  pages = new Map<string, FakePage>();
  requests: { path: string; headers: IncomingHttpHeaders; status: number }[] = [];

  private readonly server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const p = this.pages.get(u.pathname + u.search) ?? this.pages.get(u.pathname);
    let status = p ? (p.status ?? 200) : 404;
    if (p?.etag && req.headers['if-none-match'] === p.etag) status = 304;
    this.requests.push({ path: u.pathname + u.search, headers: req.headers, status });
    const headers: Record<string, string> = {};
    if (p?.type) headers['content-type'] = p.type;
    if (p?.etag) headers.etag = p.etag;
    if (p?.location) headers.location = p.location;
    res.writeHead(status, headers);
    res.end(status === 200 ? (p?.data ?? p?.body ?? '') : '');
  });

  /** An HTML page with links. */
  html(path: string, title: string, text: string, links: string[] = [], etag?: string): void {
    this.pages.set(path, { type: 'text/html; charset=utf-8', etag: etag ?? `"${path}-1"`, body: `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>${text}</p>${links.map((l) => `<a href="${l}">${l}</a>`).join(' ')}</body></html>` });
  }

  async start(): Promise<this> {
    this.url = await listen(this.server);
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise((r) => this.server.close(r));
  }
}
