import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { request, type Agent } from 'undici';
import { signV4 } from '../../../platform/blob.js';
import { cleanPath, LOCATION_LIMITS, RemoteError, type Connector, type ConnectorContext, type Listing, type ReadResult, type RemoteEntry, type S3Config, type S3Secret } from '../model.js';
import { pinnedAgent, resolveChecked } from '../net.js';

/*
 * An S3-compatible bucket as a linked location: AWS, MinIO, Ceph RGW or any self-hosted endpoint. Requests are signed
 * with SigV4 (`platform/blob.ts`) and sent through the pinned dispatcher of `net.ts`. Folders are key prefixes ending
 * in `/` (ListObjectsV2 with a delimiter). Uploads above 64 MiB go as a multipart upload in 16 MiB parts.
 */

const MULTIPART_ABOVE = 64 * 1024 * 1024;
const PART_BYTES = 16 * 1024 * 1024;
const UNSIGNED = 'UNSIGNED-PAYLOAD';

// ---------- a small XML reader for flat S3 and Azure answers ----------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Entities and character references decoded; anything else left as it is. */
export function xmlDecode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e]!));
}

/** Refuses markup declarations: these answers never carry a DOCTYPE or entity definitions. */
export function xmlCheck(xml: string): string {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new RemoteError('The server answered with XML that declares a DOCTYPE; it was not read.');
  return xml;
}

/** The inner XML of every `<tag>…</tag>` (or `<tag/>`, as empty) in order; the tag must not nest in itself. */
export function xmlAll(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${tag}>)`, 'g');
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push(m[1] ?? '');
  return out;
}

/** The decoded text of the first `<tag>` in `xml`, or null. */
export function xmlOne(xml: string, tag: string): string | null {
  const all = xmlAll(xml, tag);
  return all.length ? xmlDecode(all[0]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')) : null;
}

/** A path segment encoded as S3 and Azure expect in a URL path. */
export const encodeKey = (key: string): string => key.split('/').map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');

/** Collects a stream into parts of `size` bytes (the last may be shorter). */
export async function* parts(data: AsyncIterable<Buffer>, size: number): AsyncGenerator<Buffer> {
  let held: Buffer[] = [];
  let n = 0;
  for await (const c of data) {
    let chunk = Buffer.isBuffer(c) ? c : Buffer.from(c);
    while (chunk.length) {
      const take = Math.min(size - n, chunk.length);
      held.push(chunk.subarray(0, take));
      n += take;
      chunk = chunk.subarray(take);
      if (n === size) {
        yield Buffer.concat(held, n);
        held = [];
        n = 0;
      }
    }
  }
  if (n) yield Buffer.concat(held, n);
}

const sha256hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const unquote = (s: string | null | undefined) => (s ? s.replace(/^"|"$/g, '') : null);
const header = (h: Record<string, string | string[] | undefined>, k: string): string | null => {
  const v = h[k];
  return v == null ? null : Array.isArray(v) ? v.join(', ') : v;
};

async function text(body: AsyncIterable<Buffer>, max = 1024 * 1024): Promise<string> {
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

export class S3Connector implements Connector {
  readonly kind = 's3' as const;
  readonly writable: boolean;
  private agent: Agent | null = null;
  private checked = false;
  private readonly base: string;
  private readonly endpoint: URL;

  constructor(
    private readonly config: S3Config,
    private readonly secret: S3Secret,
    private readonly ctx: ConnectorContext,
    o: { readOnly?: boolean } = {}
  ) {
    this.writable = !o.readOnly;
    try {
      this.endpoint = new URL(config.endpoint);
    } catch {
      throw new RemoteError(`Not a URL: ${config.endpoint}`, 400);
    }
    if (this.endpoint.protocol !== 'https:' && this.endpoint.protocol !== 'http:') throw new RemoteError('An S3 endpoint is http:// or https://.', 400);
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

  private url(key: string, query: Record<string, string> = {}): URL {
    const e = this.endpoint;
    const u = this.config.pathStyle ? new URL(`${e.origin}/${encodeURIComponent(this.config.bucket)}/${encodeKey(key)}`) : new URL(`${e.protocol}//${this.config.bucket}.${e.host}/${encodeKey(key)}`);
    // Encoded by hand (RFC 3986, a space as %20): URLSearchParams would write a space as +, which S3 signs differently.
    u.search = Object.entries(query)
      .map(([k, v]) => `${encodeKey(k)}=${encodeKey(v).replace(/\//g, '%2F')}`)
      .join('&');
    return u;
  }

  private async send(method: string, url: URL, o: { body?: Buffer | AsyncIterable<Buffer>; length?: number; payloadHash?: string; headers?: Record<string, string> } = {}): Promise<Sent> {
    const extra: Record<string, string> = { ...(o.headers ?? {}) };
    if (this.secret.sessionToken) extra['x-amz-security-token'] = this.secret.sessionToken;
    const payloadHash = o.payloadHash ?? (Buffer.isBuffer(o.body) ? sha256hex(o.body) : o.body ? UNSIGNED : sha256hex(''));
    const signed = signV4({ method, url, headers: extra, payloadHash, region: this.config.region || 'us-east-1', service: 's3', accessKeyId: this.secret.accessKeyId, secretAccessKey: this.secret.secretAccessKey, date: new Date() });
    delete signed.host;
    const length = Buffer.isBuffer(o.body) ? o.body.length : o.length;
    if (length != null) signed['content-length'] = String(length);
    const body = o.body == null ? undefined : Buffer.isBuffer(o.body) ? o.body : Readable.from(o.body);
    try {
      const res = await request(url, { method: method as 'GET', headers: signed, body, dispatcher: await this.dispatcher(), ...(this.ctx.signal ? { signal: this.ctx.signal } : {}) });
      return { status: res.statusCode, headers: res.headers as Sent['headers'], body: res.body as unknown as Sent['body'] };
    } catch (err) {
      if (err instanceof RemoteError) throw err;
      const cause = (err as { cause?: unknown }).cause;
      if (cause instanceof RemoteError) throw cause;
      throw new RemoteError(`${this.endpoint.host} could not be reached: ${(err as Error).message}`);
    }
  }

  /** A RemoteError from an S3 error answer (its Code and Message, in plain words where they are common). */
  private async fail(res: Sent, what: string): Promise<never> {
    const xml = res.status === 304 || res.status === 204 ? '' : await text(res.body).catch(() => '');
    const code = /<Code>([^<]*)<\/Code>/.exec(xml)?.[1] ?? null;
    const message = /<Message>([^<]*)<\/Message>/.exec(xml)?.[1] ?? null;
    if (code === 'NoSuchBucket') throw new RemoteError(`The bucket ${this.config.bucket} does not exist.`, 404);
    if (code === 'NoSuchKey' || (res.status === 404 && !code)) throw new RemoteError(`Not found: ${what}.`, 404);
    if (res.status === 403 || code === 'InvalidAccessKeyId' || code === 'SignatureDoesNotMatch' || code === 'AccessDenied') {
      throw new RemoteError(`The keys were refused${code ? ` (${code})` : ''}${message ? `: ${xmlDecode(message)}` : ''}.`, 403);
    }
    throw new RemoteError(`S3 answered ${res.status}${code ? ` ${code}` : ''}${message ? `: ${xmlDecode(message)}` : ''} for ${what}.`);
  }

  async test(): Promise<{ ok: true; detail: string }> {
    const res = await this.send('GET', this.url('', { 'list-type': '2', 'max-keys': '1', ...(this.base ? { prefix: this.base } : {}) }));
    if (res.status !== 200) await this.fail(res, `the bucket ${this.config.bucket}`);
    const xml = xmlCheck(await text(res.body));
    const any = xmlAll(xml, 'Contents').length > 0;
    return { ok: true, detail: `The bucket ${this.config.bucket} answered at ${this.endpoint.host}${this.base ? ` under ${this.base}` : ''}${any ? '' : '; nothing is stored there yet'}.` };
  }

  async list(dir: string, cursor?: string | null): Promise<Listing> {
    const d = cleanPath(dir);
    const prefix = this.base + (d ? `${d}/` : '');
    const q: Record<string, string> = { 'list-type': '2', delimiter: '/', 'max-keys': String(LOCATION_LIMITS.pageSize) };
    if (prefix) q.prefix = prefix;
    if (cursor) q['continuation-token'] = cursor;
    const res = await this.send('GET', this.url('', q));
    if (res.status !== 200) await this.fail(res, d || 'the bucket');
    const xml = xmlCheck(await text(res.body, 16 * 1024 * 1024));
    const entries: RemoteEntry[] = [];
    for (const cp of xmlAll(xml, 'CommonPrefixes')) {
      const p = xmlOne(cp, 'Prefix');
      if (!p || !p.startsWith(this.base)) continue;
      const rel = p.slice(this.base.length).replace(/\/$/, '');
      if (!rel) continue;
      entries.push({ path: rel, name: rel.split('/').pop()!, dir: true, size: null, modified: null });
    }
    for (const c of xmlAll(xml, 'Contents')) {
      const key = xmlOne(c, 'Key');
      if (!key || !key.startsWith(this.base) || key === prefix || key.endsWith('/')) continue;
      const rel = key.slice(this.base.length);
      const modified = xmlOne(c, 'LastModified');
      entries.push({ path: rel, name: rel.split('/').pop()!, dir: false, size: Number(xmlOne(c, 'Size') ?? 0), modified: modified ? Date.parse(modified) || null : null, etag: unquote(xmlOne(c, 'ETag')) });
    }
    const truncated = xmlOne(xml, 'IsTruncated') === 'true';
    return { entries, next: truncated ? xmlOne(xml, 'NextContinuationToken') : null };
  }

  async stat(path: string): Promise<RemoteEntry | null> {
    const p = cleanPath(path);
    if (!p) return { path: '', name: '', dir: true, size: null, modified: null };
    const res = await this.send('HEAD', this.url(this.base + p));
    await res.body.dump?.().catch(() => undefined);
    if (res.status === 200) {
      const lm = header(res.headers, 'last-modified');
      const len = header(res.headers, 'content-length');
      return { path: p, name: p.split('/').pop()!, dir: false, size: len == null ? null : Number(len), modified: lm ? Date.parse(lm) || null : null, etag: unquote(header(res.headers, 'etag')), type: header(res.headers, 'content-type') };
    }
    if (res.status !== 404) throw new RemoteError(res.status === 403 ? 'The keys were refused.' : `S3 answered ${res.status} for ${p}.`, res.status === 403 ? 403 : 502);
    // A folder exists while anything is stored under it.
    const l = await this.send('GET', this.url('', { 'list-type': '2', 'max-keys': '1', prefix: `${this.base}${p}/` }));
    if (l.status !== 200) await this.fail(l, p);
    const xml = xmlCheck(await text(l.body));
    return xmlAll(xml, 'Contents').length || xmlAll(xml, 'CommonPrefixes').length ? { path: p, name: p.split('/').pop()!, dir: true, size: null, modified: null } : null;
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
    const key = this.base + p;
    const headers: Record<string, string> = { 'content-type': type || 'application/octet-stream' };
    if (size > MULTIPART_ABOVE) return this.multipart(key, data, headers);
    // A streamed body is sent unsigned over TLS; over plain HTTP (internal hosts only) it is read and hashed first.
    const body = this.endpoint.protocol === 'https:' ? data : Buffer.concat(await collectAll(data));
    const res = await this.send('PUT', this.url(key), { body, length: size, headers });
    if (res.status !== 200) await this.fail(res, p);
    await res.body.dump?.().catch(() => undefined);
    return { etag: unquote(header(res.headers, 'etag')) };
  }

  private async multipart(key: string, data: AsyncIterable<Buffer>, headers: Record<string, string>): Promise<{ etag: string | null }> {
    const start = await this.send('POST', this.url(key, { uploads: '' }), { body: Buffer.alloc(0), headers });
    if (start.status !== 200) await this.fail(start, key);
    const id = xmlOne(xmlCheck(await text(start.body)), 'UploadId');
    if (!id) throw new RemoteError('S3 did not start the multipart upload.');
    const etags: string[] = [];
    try {
      let n = 0;
      for await (const part of parts(data, PART_BYTES)) {
        n++;
        const res = await this.send('PUT', this.url(key, { partNumber: String(n), uploadId: id }), { body: part });
        if (res.status !== 200) await this.fail(res, `${key}, part ${n}`);
        await res.body.dump?.().catch(() => undefined);
        etags.push(header(res.headers, 'etag') ?? '');
      }
      const xml = `<CompleteMultipartUpload>${etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
      const done = await this.send('POST', this.url(key, { uploadId: id }), { body: Buffer.from(xml), headers: { 'content-type': 'application/xml' } });
      if (done.status !== 200) await this.fail(done, key);
      const answer = xmlCheck(await text(done.body));
      // S3 may answer 200 with an error in the body.
      if (/<Error>/.test(answer)) throw new RemoteError(`S3 did not finish the upload: ${xmlOne(answer, 'Message') ?? xmlOne(answer, 'Code') ?? 'unknown error'}.`);
      return { etag: unquote(xmlOne(answer, 'ETag')) };
    } catch (err) {
      await this.send('DELETE', this.url(key, { uploadId: id })).then((r) => r.body.dump?.(), () => undefined).catch(() => undefined);
      throw err;
    }
  }

  async close(): Promise<void> {
    const a = this.agent;
    this.agent = null;
    if (a) await a.close().catch(() => undefined);
  }
}

async function collectAll(data: AsyncIterable<Buffer>): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const c of data) out.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return out;
}
