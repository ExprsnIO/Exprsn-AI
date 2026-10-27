import { createHmac, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { request, type Agent } from 'undici';
import { cleanPath, LOCATION_LIMITS, RemoteError, type AzureConfig, type AzureSecret, type Connector, type ConnectorContext, type Listing, type ReadResult, type RemoteEntry } from '../model.js';
import { pinnedAgent, resolveChecked } from '../net.js';
import { encodeKey, parts, xmlAll, xmlCheck, xmlDecode, xmlOne } from './s3.js';

/*
 * An Azure Blob container as a linked location, over the Blob REST API (version 2023-11-03). Authorised with the
 * account's shared key (the Shared Key scheme: a canonical string of the request signed with HMAC-SHA256) or with a
 * SAS token added to every URL. The endpoint is the account's own host (https://<account>.blob.core.windows.net) or
 * a path-style one such as Azurite's (http://127.0.0.1:10000/<account>), whose canonical resource names the account
 * twice: once as the account and once as the first segment of the path. Folders are name prefixes ending in `/`.
 */

export const AZURE_VERSION = '2023-11-03';
const PUT_BLOB_MAX = 256 * 1024 * 1024;
const BLOCK_BYTES = 8 * 1024 * 1024;

/** The Shared Key string to sign of a request (exported for the tests' fake, which checks it the same way). */
export function azureStringToSign(account: string, method: string, url: URL, headers: Record<string, string>): string {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const len = h['content-length'];
  const canonHeaders = Object.keys(h)
    .filter((k) => k.startsWith('x-ms-'))
    .sort()
    .map((k) => `${k}:${h[k]!.trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const params = new Map<string, string[]>();
  for (const [k, v] of url.searchParams) params.set(k.toLowerCase(), [...(params.get(k.toLowerCase()) ?? []), v]);
  const canonResource = `/${account}${url.pathname}` + [...params.keys()].sort().map((k) => `\n${k}:${params.get(k)!.sort().join(',')}`).join('');
  return [method, h['content-encoding'] ?? '', h['content-language'] ?? '', len && len !== '0' ? len : '', h['content-md5'] ?? '', h['content-type'] ?? '', '', h['if-modified-since'] ?? '', h['if-match'] ?? '', h['if-none-match'] ?? '', h['if-unmodified-since'] ?? '', h.range ?? ''].join('\n') + '\n' + canonHeaders + canonResource;
}

const header = (h: Record<string, string | string[] | undefined>, k: string): string | null => {
  const v = h[k];
  return v == null ? null : Array.isArray(v) ? v.join(', ') : v;
};

async function text(body: AsyncIterable<Buffer>, max = 16 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of body) {
    n += c.length;
    if (n > max) break;
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

interface Sent {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Buffer> & { dump?: () => Promise<void> };
}

export class AzureConnector implements Connector {
  readonly kind = 'azure' as const;
  readonly writable: boolean;
  private agent: Agent | null = null;
  private checked = false;
  private readonly endpoint: URL;
  /** The path before the container: empty for the account's own host, `/<account>` for a path-style endpoint. */
  private readonly basePath: string;
  private readonly base: string;

  constructor(
    private readonly config: AzureConfig,
    private readonly secret: AzureSecret,
    private readonly ctx: ConnectorContext,
    o: { readOnly?: boolean } = {}
  ) {
    this.writable = !o.readOnly;
    try {
      this.endpoint = new URL(config.endpoint);
    } catch {
      throw new RemoteError(`Not a URL: ${config.endpoint}`, 400);
    }
    if (this.endpoint.protocol !== 'https:' && this.endpoint.protocol !== 'http:') throw new RemoteError('An Azure endpoint is http:// or https://.', 400);
    if (!/^[a-z0-9]{3,24}$/.test(config.account)) throw new RemoteError('An Azure storage account name is 3 to 24 lower-case letters and digits.', 400);
    if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(config.container)) throw new RemoteError('An Azure container name is 3 to 63 lower-case letters, digits and dashes.', 400);
    this.basePath = this.endpoint.pathname.replace(/\/+$/, '');
    const prefix = cleanPath(config.prefix ?? '');
    this.base = prefix ? `${prefix}/` : '';
  }

  private async dispatcher(): Promise<Agent> {
    if (!this.checked) {
      await resolveChecked(this.endpoint.hostname, this.ctx.check);
      this.checked = true;
    }
    this.agent ??= pinnedAgent(this.ctx.check, this.ctx.timeoutMs);
    return this.agent;
  }

  private url(blob: string | null, query: Record<string, string> = {}): URL {
    const u = new URL(`${this.endpoint.origin}${this.basePath}/${this.config.container}${blob ? `/${encodeKey(blob)}` : ''}`);
    const q = Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    if ('sas' in this.secret) q.push(this.secret.sas.replace(/^\?/, ''));
    u.search = q.join('&');
    return u;
  }

  private async send(method: string, url: URL, o: { body?: Buffer | AsyncIterable<Buffer>; length?: number; headers?: Record<string, string> } = {}): Promise<Sent> {
    const headers: Record<string, string> = { 'x-ms-date': new Date().toUTCString(), 'x-ms-version': AZURE_VERSION, ...(o.headers ?? {}) };
    const length = Buffer.isBuffer(o.body) ? o.body.length : o.length;
    if (length != null) headers['content-length'] = String(length);
    else if (method === 'PUT') headers['content-length'] = '0';
    if ('accountKey' in this.secret) {
      const sts = azureStringToSign(this.config.account, method, url, headers);
      headers.authorization = `SharedKey ${this.config.account}:${createHmac('sha256', Buffer.from(this.secret.accountKey, 'base64')).update(sts, 'utf8').digest('base64')}`;
    }
    const body = o.body == null ? undefined : Buffer.isBuffer(o.body) ? o.body : Readable.from(o.body);
    try {
      const res = await request(url, { method: method as 'GET', headers, body, dispatcher: await this.dispatcher(), ...(this.ctx.signal ? { signal: this.ctx.signal } : {}) });
      return { status: res.statusCode, headers: res.headers as Sent['headers'], body: res.body as unknown as Sent['body'] };
    } catch (err) {
      if (err instanceof RemoteError) throw err;
      const cause = (err as { cause?: unknown }).cause;
      if (cause instanceof RemoteError) throw cause;
      throw new RemoteError(`${this.endpoint.host} could not be reached: ${(err as Error).message}`);
    }
  }

  private async fail(res: Sent, what: string): Promise<never> {
    const xml = await text(res.body, 1024 * 1024).catch(() => '');
    const code = /<Code>([^<]*)<\/Code>/.exec(xml)?.[1] ?? header(res.headers, 'x-ms-error-code');
    const message = /<Message>([^<]*)<\/Message>/.exec(xml)?.[1] ?? null;
    if (code === 'ContainerNotFound') throw new RemoteError(`The container ${this.config.container} does not exist.`, 404);
    if (code === 'BlobNotFound' || (res.status === 404 && !code)) throw new RemoteError(`Not found: ${what}.`, 404);
    if (res.status === 403 || code === 'AuthenticationFailed' || code === 'AuthorizationFailure') throw new RemoteError(`The ${'sas' in this.secret ? 'SAS token' : 'account key'} was refused${code ? ` (${code})` : ''}.`, 403);
    throw new RemoteError(`Azure answered ${res.status}${code ? ` ${code}` : ''}${message ? `: ${xmlDecode(message).split('\n')[0]}` : ''} for ${what}.`);
  }

  async test(): Promise<{ ok: true; detail: string }> {
    const res = await this.send('GET', this.url(null, { restype: 'container', comp: 'list', maxresults: '1', ...(this.base ? { prefix: this.base } : {}) }));
    if (res.status !== 200) await this.fail(res, `the container ${this.config.container}`);
    await text(res.body).then(xmlCheck);
    return { ok: true, detail: `The container ${this.config.container} of ${this.config.account} answered at ${this.endpoint.host}${this.base ? ` under ${this.base}` : ''}.` };
  }

  async list(dir: string, cursor?: string | null): Promise<Listing> {
    const d = cleanPath(dir);
    const prefix = this.base + (d ? `${d}/` : '');
    const q: Record<string, string> = { restype: 'container', comp: 'list', delimiter: '/', maxresults: String(LOCATION_LIMITS.pageSize) };
    if (prefix) q.prefix = prefix;
    if (cursor) q.marker = cursor;
    const res = await this.send('GET', this.url(null, q));
    if (res.status !== 200) await this.fail(res, d || 'the container');
    const xml = xmlCheck(await text(res.body));
    const entries: RemoteEntry[] = [];
    for (const bp of xmlAll(xml, 'BlobPrefix')) {
      const name = xmlOne(bp, 'Name');
      if (!name || !name.startsWith(this.base)) continue;
      const rel = name.slice(this.base.length).replace(/\/$/, '');
      if (rel) entries.push({ path: rel, name: rel.split('/').pop()!, dir: true, size: null, modified: null });
    }
    for (const b of xmlAll(xml, 'Blob')) {
      const name = xmlOne(b, 'Name');
      if (!name || !name.startsWith(this.base) || name.endsWith('/')) continue;
      const rel = name.slice(this.base.length);
      const props = xmlAll(b, 'Properties')[0] ?? '';
      const lm = xmlOne(props, 'Last-Modified');
      entries.push({ path: rel, name: rel.split('/').pop()!, dir: false, size: Number(xmlOne(props, 'Content-Length') ?? 0), modified: lm ? Date.parse(lm) || null : null, etag: xmlOne(props, 'Etag')?.replace(/^"|"$/g, '') ?? null, type: xmlOne(props, 'Content-Type') });
    }
    const next = xmlOne(xml, 'NextMarker');
    return { entries, next: next || null };
  }

  async stat(path: string): Promise<RemoteEntry | null> {
    const p = cleanPath(path);
    if (!p) return { path: '', name: '', dir: true, size: null, modified: null };
    const res = await this.send('HEAD', this.url(this.base + p));
    await res.body.dump?.().catch(() => undefined);
    if (res.status === 200) {
      const lm = header(res.headers, 'last-modified');
      const len = header(res.headers, 'content-length');
      return { path: p, name: p.split('/').pop()!, dir: false, size: len == null ? null : Number(len), modified: lm ? Date.parse(lm) || null : null, etag: header(res.headers, 'etag')?.replace(/^"|"$/g, '') ?? null, type: header(res.headers, 'content-type') };
    }
    if (res.status !== 404) throw new RemoteError(res.status === 403 ? 'The credentials were refused.' : `Azure answered ${res.status} for ${p}.`, res.status === 403 ? 403 : 502);
    const l = await this.send('GET', this.url(null, { restype: 'container', comp: 'list', maxresults: '1', prefix: `${this.base}${p}/` }));
    if (l.status !== 200) await this.fail(l, p);
    const xml = xmlCheck(await text(l.body));
    return xmlAll(xml, 'Blob').length || xmlAll(xml, 'BlobPrefix').length ? { path: p, name: p.split('/').pop()!, dir: true, size: null, modified: null } : null;
  }

  async read(path: string): Promise<ReadResult> {
    const p = cleanPath(path);
    if (!p) throw new RemoteError('Choose a file, not the root.', 400);
    const res = await this.send('GET', this.url(this.base + p));
    if (res.status !== 200) await this.fail(res, p);
    const len = header(res.headers, 'content-length');
    return { stream: res.body, size: len == null ? null : Number(len), type: header(res.headers, 'content-type') };
  }

  async write(path: string, data: AsyncIterable<Buffer>, size: number, type: string | null): Promise<{ etag?: string | null; cid?: string | null }> {
    if (!this.writable) throw new RemoteError('This location is read-only.', 403);
    const p = cleanPath(path);
    if (!p) throw new RemoteError('Give the file a name.', 400);
    const blob = this.base + p;
    const contentType = type || 'application/octet-stream';
    if (size <= PUT_BLOB_MAX) {
      const res = await this.send('PUT', this.url(blob), { body: data, length: size, headers: { 'x-ms-blob-type': 'BlockBlob', 'content-type': contentType } });
      if (res.status !== 201) await this.fail(res, p);
      await res.body.dump?.().catch(() => undefined);
      return { etag: header(res.headers, 'etag')?.replace(/^"|"$/g, '') ?? null };
    }
    // Larger blobs: blocks of 8 MiB, then the block list. Block ids are base64 of equal-length strings.
    const run = randomBytes(6).toString('hex');
    const ids: string[] = [];
    for await (const part of parts(data, BLOCK_BYTES)) {
      const id = Buffer.from(`${run}-${String(ids.length).padStart(6, '0')}`).toString('base64');
      const res = await this.send('PUT', this.url(blob, { comp: 'block', blockid: id }), { body: part });
      if (res.status !== 201) await this.fail(res, `${p}, block ${ids.length + 1}`);
      await res.body.dump?.().catch(() => undefined);
      ids.push(id);
    }
    const list = Buffer.from(`<?xml version="1.0" encoding="utf-8"?><BlockList>${ids.map((id) => `<Latest>${id}</Latest>`).join('')}</BlockList>`);
    const res = await this.send('PUT', this.url(blob, { comp: 'blocklist' }), { body: list, headers: { 'content-type': 'application/xml', 'x-ms-blob-content-type': contentType } });
    if (res.status !== 201) await this.fail(res, p);
    await res.body.dump?.().catch(() => undefined);
    return { etag: header(res.headers, 'etag')?.replace(/^"|"$/g, '') ?? null };
  }

  async close(): Promise<void> {
    const a = this.agent;
    this.agent = null;
    if (a) await a.close().catch(() => undefined);
  }
}
