/*
 * Sprint 23 fakes: an S3-compatible bucket (ListObjectsV2 and GET, path style, checking the SigV4 key id) and a
 * small web site whose pages, robots.txt and sitemap a test sets, answering conditional requests with 304.
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const listen = (server: Server): Promise<string> =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export class FakeS3 {
  url = '';
  objects = new Map<string, { body: string; etag: string }>();
  requests: { method: string; path: string; keyId: string | null }[] = [];
  constructor(
    readonly bucket: string,
    readonly accessKeyId: string
  ) {}

  private readonly server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const keyId = /Credential=([^/]+)\//.exec(String(req.headers.authorization ?? ''))?.[1] ?? null;
    this.requests.push({ method: req.method ?? 'GET', path: u.pathname + u.search, keyId });
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
      const items = [...this.objects.entries()].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1));
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<?xml version="1.0"?><ListBucketResult>${items.map(([k, v]) => `<Contents><Key>${esc(k)}</Key><LastModified>2026-09-30T08:00:00.000Z</LastModified><ETag>&quot;${v.etag}&quot;</ETag><Size>${Buffer.byteLength(v.body)}</Size></Contents>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`);
      return;
    }
    const o = this.objects.get(decodeURIComponent(rest.join('/')));
    res.writeHead(o ? 200 : 404, { etag: o ? `"${o.etag}"` : '' });
    res.end(o?.body ?? '');
  });

  get gets(): string[] {
    return this.requests.filter((r) => !r.path.includes('list-type')).map((r) => r.path);
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

export interface FakePage {
  status?: number;
  type?: string;
  body?: string;
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
    res.end(status === 200 ? (p?.body ?? '') : '');
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
