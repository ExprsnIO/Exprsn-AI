import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { request, type Dispatcher } from 'undici';
import { cleanPath, LOCATION_LIMITS, RemoteError, type Connector, type ConnectorContext, type IpfsConfig, type IpfsSecret, type Listing, type ReadResult, type RemoteEntry } from '../model.js';
import { pinnedAgent, resolveChecked } from '../net.js';

/*
 * IPFS as a linked location. Two modes:
 *
 * - `rpc`: a Kubo node's RPC API (POST /api/v0/...): list a directory (`ls`), read (`cat`), add (`add`, CIDv1 with
 *   raw leaves, pinned when the location says so). Read and write.
 * - `gateway`: an HTTP gateway (GET /ipfs/<cid>/<path>), read only. Listing a directory needs a gateway that answers
 *   `application/vnd.ipld.dag-json`; others only fetch files by CID.
 *
 * Paths: the location's root is a CID, `/ipfs/<cid>[/path]` or `/ipns/<name>`; a path below it appends to it. With
 * no root, the first segment of a path is the CID itself ("fetch by CID").
 *
 * A file added with CIDv1 and raw leaves has the same CID as Files' own `cid` (raw codec, SHA2-256) only when it fits
 * in one chunk (256 KiB with Kubo's default chunker); a larger file is chunked into a UnixFS DAG whose root CID differs.
 */

const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,200}|z[1-9A-HJ-NP-Za-km-z]{20,200}|k[0-9a-z]{20,200})$/;

interface KuboLink {
  Name: string;
  Hash: string;
  Size: number;
  Type: number;
}

export class IpfsConnector implements Connector {
  readonly kind = 'ipfs' as const;
  readonly writable: boolean;
  private agent: Dispatcher | null = null;
  private checked = false;

  constructor(
    private readonly config: IpfsConfig,
    private readonly secret: IpfsSecret,
    private readonly ctx: ConnectorContext,
    o: { readOnly?: boolean } = {}
  ) {
    this.writable = config.mode === 'rpc' && !o.readOnly;
  }

  private base(): URL {
    let u: URL;
    try {
      u = new URL(this.config.endpoint);
    } catch {
      throw new RemoteError('The IPFS endpoint is not a URL.', 400);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new RemoteError('The IPFS endpoint must be http or https.', 400);
    if (u.username || u.password) throw new RemoteError('Credentials do not belong in the URL; give an Authorization header instead.', 400);
    return u;
  }

  private async dispatcher(): Promise<Dispatcher> {
    if (!this.checked) {
      // IP literals skip the dispatcher's lookup, so the host is checked here first.
      await resolveChecked(this.base().hostname, this.ctx.check);
      this.checked = true;
    }
    this.agent ??= pinnedAgent(this.ctx.check, this.ctx.timeoutMs);
    return this.agent;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const auth = this.secret && 'authorization' in this.secret ? this.secret.authorization : undefined;
    return { 'user-agent': 'exprsn-ai-files', ...(auth ? { authorization: auth } : {}), ...extra };
  }

  /** The IPFS path of a location path: `/ipfs/<cid>/a/b` or `/ipns/<name>/a/b`. */
  ipfsPath(path: string): string {
    const rel = cleanPath(path);
    const root = (this.config.root ?? '').trim().replace(/\/+$/, '');
    let base: string;
    if (!root) {
      if (!rel) throw new RemoteError('This location has no root: give a CID.', 400);
      const [first, ...rest] = rel.split('/');
      if (!CID_RE.test(first!)) throw new RemoteError(`${first} is not a CID.`, 400);
      return `/ipfs/${[first, ...rest].join('/')}`;
    }
    if (root.startsWith('/ipfs/') || root.startsWith('/ipns/')) base = root;
    else if (CID_RE.test(root)) base = `/ipfs/${root}`;
    else throw new RemoteError('The root is a CID, /ipfs/<cid> or /ipns/<name>.', 400);
    return rel ? `${base}/${rel}` : base;
  }

  private async rpc(cmd: string, args: Record<string, string>, body?: { stream: AsyncIterable<Buffer>; contentType: string }): Promise<Dispatcher.ResponseData<unknown>> {
    const u = new URL(`/api/v0/${cmd}`, this.base());
    for (const [k, v] of Object.entries(args)) u.searchParams.append(k, v);
    const res = await request(u, { method: 'POST', dispatcher: await this.dispatcher(), headers: this.headers(body ? { 'content-type': body.contentType } : {}), ...(body ? { body: Readable.from(body.stream) } : {}), headersTimeout: this.ctx.timeoutMs, bodyTimeout: this.ctx.timeoutMs, ...(this.ctx.signal ? { signal: this.ctx.signal } : {}) } as Parameters<typeof request>[1]).catch((err: Error) => {
      throw err instanceof RemoteError ? err : new RemoteError(`IPFS node ${u.host}: ${err.message}`);
    });
    if (res.statusCode >= 400) {
      const text = (await res.body.text().catch(() => '')).slice(0, 300);
      let msg = text;
      try {
        msg = (JSON.parse(text) as { Message?: string }).Message ?? text;
      } catch {
        // plain text
      }
      throw new RemoteError(`IPFS ${cmd}: ${msg || res.statusCode}`, /not found|no link named|could not resolve/i.test(msg) ? 404 : 502);
    }
    return res;
  }

  private async gateway(path: string, accept?: string): Promise<Dispatcher.ResponseData<unknown>> {
    const u = new URL(path.split('/').map((s) => encodeURIComponent(s)).join('/'), this.base());
    const res = await request(u, { method: 'GET', dispatcher: await this.dispatcher(), headers: this.headers(accept ? { accept } : {}), headersTimeout: this.ctx.timeoutMs, bodyTimeout: this.ctx.timeoutMs, maxRedirections: 0, ...(this.ctx.signal ? { signal: this.ctx.signal } : {}) } as Parameters<typeof request>[1]).catch((err: Error) => {
      throw err instanceof RemoteError ? err : new RemoteError(`IPFS gateway ${u.host}: ${err.message}`);
    });
    if (res.statusCode === 404) {
      await res.body.dump();
      throw new RemoteError(`${path}: not found.`, 404);
    }
    if (res.statusCode >= 300) {
      await res.body.dump();
      throw new RemoteError(`IPFS gateway answered ${res.statusCode} for ${path}.`);
    }
    return res;
  }

  async test(): Promise<{ ok: true; detail: string }> {
    if (this.config.mode === 'rpc') {
      const v = (await (await this.rpc('version', {})).body.json()) as { Version?: string };
      let id = '';
      try {
        id = ((await (await this.rpc('id', {})).body.json()) as { ID?: string }).ID ?? '';
      } catch {
        // `id` may be forbidden on a restricted API
      }
      return { ok: true, detail: `Kubo ${v.Version ?? 'unknown version'} at ${this.base().host}${id ? `, peer ${id}` : ''}${this.config.root ? `; root ${this.config.root}` : ''}.` };
    }
    if (this.config.root) await this.stat('');
    return { ok: true, detail: `Gateway ${this.base().host} reachable${this.config.root ? `; root ${this.config.root} found` : ''}. Read only.` };
  }

  async list(dir: string, cursor?: string | null): Promise<Listing> {
    const rel = cleanPath(dir);
    if (!this.config.root && !rel) return { entries: [], next: null };
    const target = this.ipfsPath(rel);
    let all: RemoteEntry[];
    if (this.config.mode === 'rpc') {
      const out = (await (await this.rpc('ls', { arg: target, resolve_type: 'true', size: 'true' })).body.json()) as { Objects?: { Links?: KuboLink[] }[] };
      all = (out.Objects?.[0]?.Links ?? []).map((l) => ({ path: rel ? `${rel}/${l.Name}` : l.Name, name: l.Name, dir: l.Type === 1, size: l.Type === 1 ? null : Number(l.Size ?? 0), modified: null, etag: l.Hash }));
    } else {
      const res = await this.gateway(target, 'application/vnd.ipld.dag-json');
      const ct = String(res.headers['content-type'] ?? '');
      if (!/dag-json|application\/json/.test(ct)) {
        await res.body.dump();
        throw new RemoteError('This gateway does not list directories; fetch files by CID.', 501);
      }
      const node = (await res.body.json()) as { Links?: { Name?: string; Hash?: { '/': string }; Tsize?: number }[] };
      if (!Array.isArray(node.Links)) throw new RemoteError('This gateway does not list directories; fetch files by CID.', 501);
      // A dag-pb link does not say whether it is a file or a folder; entries are offered as files.
      all = node.Links.filter((l) => l.Name).map((l) => ({ path: rel ? `${rel}/${l.Name}` : l.Name!, name: l.Name!, dir: false, size: l.Tsize ?? null, modified: null, etag: l.Hash?.['/'] ?? null }));
    }
    all.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    const from = Math.max(0, Number(cursor ?? 0) || 0);
    const to = from + LOCATION_LIMITS.pageSize;
    return { entries: all.slice(from, to), next: to < all.length ? String(to) : null };
  }

  async stat(path: string): Promise<RemoteEntry | null> {
    const rel = cleanPath(path);
    const target = this.ipfsPath(rel);
    const name = rel.split('/').pop() ?? '';
    try {
      if (this.config.mode === 'rpc') {
        const s = (await (await this.rpc('files/stat', { arg: target })).body.json()) as { Hash?: string; Size?: number; Type?: string };
        return { path: rel, name, dir: s.Type === 'directory', size: s.Type === 'directory' ? null : Number(s.Size ?? 0), modified: null, etag: s.Hash ?? null };
      }
      const u = new URL(target.split('/').map((s) => encodeURIComponent(s)).join('/'), this.base());
      const res = await request(u, { method: 'HEAD', dispatcher: await this.dispatcher(), headers: this.headers(), headersTimeout: this.ctx.timeoutMs });
      await res.body.dump();
      if (res.statusCode === 404) return null;
      // A gateway sends a folder to the same path with a trailing slash; that redirect is how a folder is told apart
      // (it is not followed, and any other redirect is refused).
      const location = String(res.headers.location ?? '');
      if ([301, 302, 307, 308].includes(res.statusCode) && location && new URL(location, u).pathname === `${u.pathname}/`) {
        return { path: rel, name, dir: true, size: null, modified: null, etag: String(res.headers['x-ipfs-roots'] ?? res.headers.etag ?? '') || null };
      }
      if (res.statusCode >= 300) throw new RemoteError(`IPFS gateway answered ${res.statusCode} for ${target}.`);
      const len = res.headers['content-length'];
      return { path: rel, name, dir: false, size: len ? Number(len) : null, modified: null, etag: String(res.headers['x-ipfs-roots'] ?? res.headers.etag ?? '') || null, type: String(res.headers['content-type'] ?? '') || null };
    } catch (err) {
      if (err instanceof RemoteError && err.status === 404) return null;
      throw err;
    }
  }

  async read(path: string): Promise<ReadResult> {
    const target = this.ipfsPath(path);
    if (this.config.mode === 'rpc') {
      const res = await this.rpc('cat', { arg: target });
      const len = res.headers['x-content-length'] ?? res.headers['content-length'];
      return { stream: res.body as AsyncIterable<Buffer>, size: len ? Number(len) : null, type: null };
    }
    const res = await this.gateway(target);
    const len = res.headers['content-length'];
    return { stream: res.body as AsyncIterable<Buffer>, size: len ? Number(len) : null, type: String(res.headers['content-type'] ?? '') || null };
  }

  async write(path: string, data: AsyncIterable<Buffer>, _size: number, type: string | null): Promise<{ etag?: string | null; cid?: string | null }> {
    if (!this.writable) throw new RemoteError(this.config.mode === 'gateway' ? 'A gateway is read only; link a Kubo node to add files.' : 'This location is read-only.', 403);
    const rel = cleanPath(path);
    const name = (rel.split('/').pop() || 'file').replace(/["\r\n]/g, '_');
    const boundary = `----exprsn${randomBytes(12).toString('hex')}`;
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${encodeURIComponent(name)}"\r\nContent-Type: ${type || 'application/octet-stream'}\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const stream = (async function* () {
      yield head;
      for await (const c of data) yield c;
      yield tail;
    })();
    const res = await this.rpc('add', { 'cid-version': '1', 'raw-leaves': 'true', pin: this.config.pin ? 'true' : 'false', 'wrap-with-directory': 'false', progress: 'false' }, { stream, contentType: `multipart/form-data; boundary=${boundary}` });
    const text = await res.body.text();
    const last = text.trim().split('\n').pop() ?? '';
    let hash: string | undefined;
    try {
      hash = (JSON.parse(last) as { Hash?: string }).Hash;
    } catch {
      // not JSON
    }
    if (!hash) throw new RemoteError('The IPFS node did not return a CID.');
    return { cid: hash, etag: hash };
  }

  async close(): Promise<void> {
    const a = this.agent;
    this.agent = null;
    if (a) await a.close().catch(() => undefined);
  }
}
