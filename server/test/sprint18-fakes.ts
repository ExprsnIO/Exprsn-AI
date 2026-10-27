import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/*
 * Sprint 18 fakes (B-909): just enough of the Verdaccio (npm publish), devpi (legacy upload) and Harbor (OCI
 * distribution push with the Docker token flow) APIs to check what the push job sends. Each listens on 127.0.0.1.
 */

export interface Fake {
  url: string;
  close(): Promise<void>;
}

const body = (req: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    handler(req, res).catch((err: Error) => {
      res.statusCode = 500;
      res.end(err.message);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const closer = (server: Server) => () => new Promise<void>((r) => {
  server.closeAllConnections();
  server.close(() => r());
});

const send = (res: ServerResponse, status: number, data?: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(data === undefined ? '' : JSON.stringify(data));
};

// ---------- Verdaccio ----------

export interface FakeVerdaccio extends Fake {
  /** Package documents by name, as `npm view` would read them. */
  packages: Map<string, { name: string; versions: Record<string, { dist: { shasum: string; integrity: string } }>; 'dist-tags': Record<string, string>; tarballs: Record<string, Buffer> }>;
  publishes: number;
}

export async function startFakeVerdaccio(token: string): Promise<FakeVerdaccio> {
  const fake = { packages: new Map(), publishes: 0 } as unknown as FakeVerdaccio;
  const { server, url } = await listen(async (req, res) => {
    const name = decodeURIComponent((req.url ?? '/').slice(1).split('?')[0]!);
    if (req.method === 'GET') {
      const p = fake.packages.get(name);
      return p ? send(res, 200, { name: p.name, versions: p.versions, 'dist-tags': p['dist-tags'] }) : send(res, 404, { error: 'not found' });
    }
    if (req.method !== 'PUT') return send(res, 405, { error: 'method' });
    if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: 'unauthorized' });
    const doc = JSON.parse((await body(req)).toString('utf8')) as { name: string; versions: Record<string, { dist: { shasum: string; integrity: string } }>; 'dist-tags': Record<string, string>; _attachments: Record<string, { data: string; length: number }> };
    if (doc.name !== name) return send(res, 400, { error: 'name mismatch' });
    const cur = fake.packages.get(name) ?? { name, versions: {}, 'dist-tags': {}, tarballs: {} };
    for (const [v, meta] of Object.entries(doc.versions)) {
      if (cur.versions[v]) return send(res, 409, { error: 'this package is already present' });
      const [file, att] = Object.entries(doc._attachments)[0]!;
      const tgz = Buffer.from(att.data, 'base64');
      if (tgz.length !== att.length || createHash('sha1').update(tgz).digest('hex') !== meta.dist.shasum) return send(res, 400, { error: 'attachment does not match its shasum' });
      cur.versions[v] = meta;
      cur.tarballs[file] = tgz;
    }
    cur['dist-tags'] = { ...cur['dist-tags'], ...doc['dist-tags'] };
    fake.packages.set(name, cur);
    fake.publishes++;
    send(res, 201, { ok: 'created new package' });
  });
  fake.url = url;
  fake.close = closer(server);
  return fake;
}

// ---------- devpi ----------

export interface FakeDevpi extends Fake {
  uploads: { index: string; name: string; version: string; filetype: string; filename: string; sha256: string; bytes: number }[];
}

/** A multipart/form-data reader for the legacy upload API (fields and one file). */
function multipart(buf: Buffer, boundary: string): Map<string, { value: Buffer; filename: string | null }> {
  const out = new Map<string, { value: Buffer; filename: string | null }>();
  const sep = Buffer.from(`--${boundary}`);
  let at = buf.indexOf(sep);
  while (at >= 0) {
    const next = buf.indexOf(sep, at + sep.length);
    if (next < 0) break;
    const part = buf.subarray(at + sep.length + 2, next - 2);
    const head = part.indexOf('\r\n\r\n');
    const headers = part.subarray(0, head).toString('utf8');
    const name = /name="([^"]+)"/.exec(headers)?.[1];
    const filename = /filename="([^"]+)"/.exec(headers)?.[1] ?? null;
    if (name) out.set(name, { value: part.subarray(head + 4), filename });
    at = next;
  }
  return out;
}

export async function startFakeDevpi(user: string, password: string): Promise<FakeDevpi> {
  const fake = { uploads: [] } as unknown as FakeDevpi;
  const { server, url } = await listen(async (req, res) => {
    if (req.method !== 'POST') return send(res, 405, {});
    if (req.headers.authorization !== `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`) return send(res, 401, {});
    const boundary = /boundary=(.+)$/.exec(req.headers['content-type'] ?? '')?.[1];
    if (!boundary) return send(res, 400, {});
    const f = multipart(await body(req), boundary);
    if (f.get(':action')?.value.toString() !== 'file_upload') return send(res, 400, {});
    const content = f.get('content');
    if (!content?.filename) return send(res, 400, {});
    const sha256 = createHash('sha256').update(content.value).digest('hex');
    if (sha256 !== f.get('sha256_digest')?.value.toString()) return send(res, 400, { error: 'digest' });
    if (fake.uploads.some((u) => u.filename === content.filename)) return send(res, 409, { message: 'already exists' });
    fake.uploads.push({ index: (req.url ?? '').replace(/^\/|\/$/g, ''), name: f.get('name')!.value.toString(), version: f.get('version')!.value.toString(), filetype: f.get('filetype')!.value.toString(), filename: content.filename, sha256, bytes: content.value.length });
    send(res, 200, { result: 'ok' });
  });
  fake.url = url;
  fake.close = closer(server);
  return fake;
}

// ---------- Harbor (OCI distribution) ----------

export interface FakeHarbor extends Fake {
  blobs: Map<string, Buffer>;
  /** Manifests by `<repo>@<reference>` (tags and digests). */
  manifests: Map<string, { mediaType: string; body: Buffer }>;
  tokens: number;
}

export async function startFakeHarbor(user: string, password: string): Promise<FakeHarbor> {
  const fake = { blobs: new Map(), manifests: new Map(), tokens: 0 } as unknown as FakeHarbor;
  const issued = new Set<string>();
  const uploads = new Map<string, string>();
  const { server, url } = await listen(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/service/token') {
      if (req.headers.authorization !== `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`) return send(res, 401, {});
      const t = randomUUID();
      issued.add(t);
      fake.tokens++;
      return send(res, 200, { token: t });
    }
    const m = /^\/v2\/(.+)\/(blobs\/uploads|blobs|manifests)\/?(.*)$/.exec(u.pathname);
    if (!m) return send(res, 404, {});
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token || !issued.has(token)) return send(res, 401, { errors: [{ code: 'UNAUTHORIZED' }] }, { 'www-authenticate': `Bearer realm="${fake.url}/service/token",service="harbor-registry",scope="repository:${m[1]}:pull,push"` });
    const [, repo, what, ref] = m;
    if (what === 'blobs') {
      const b = fake.blobs.get(ref!);
      return send(res, b ? 200 : 404, undefined, b ? { 'content-length': String(b.length), 'docker-content-digest': ref! } : {});
    }
    if (what === 'blobs/uploads') {
      if (req.method === 'POST') {
        const id = randomUUID();
        uploads.set(id, repo!);
        return send(res, 202, undefined, { location: `/v2/${repo}/blobs/uploads/${id}` });
      }
      if (req.method === 'PUT' && uploads.has(ref!)) {
        const data = await body(req);
        const digest = u.searchParams.get('digest')!;
        if (`sha256:${createHash('sha256').update(data).digest('hex')}` !== digest) return send(res, 400, { errors: [{ code: 'DIGEST_INVALID' }] });
        uploads.delete(ref!);
        fake.blobs.set(digest, data);
        return send(res, 201, undefined, { location: `/v2/${repo}/blobs/${digest}`, 'docker-content-digest': digest });
      }
      return send(res, 404, {});
    }
    const key = `${repo}@${ref}`;
    if (req.method === 'HEAD' || req.method === 'GET') {
      const x = fake.manifests.get(key);
      if (!x) return send(res, 404, {});
      res.writeHead(200, { 'content-type': x.mediaType, 'docker-content-digest': `sha256:${createHash('sha256').update(x.body).digest('hex')}` });
      return void res.end(req.method === 'GET' ? x.body : undefined);
    }
    if (req.method === 'PUT') {
      const data = await body(req);
      const mf = JSON.parse(data.toString('utf8')) as { config?: { digest: string }; layers?: { digest: string }[] };
      for (const d of [mf.config?.digest, ...(mf.layers ?? []).map((l) => l.digest)].filter(Boolean) as string[]) if (!fake.blobs.has(d)) return send(res, 400, { errors: [{ code: 'MANIFEST_BLOB_UNKNOWN', detail: d }] });
      fake.manifests.set(key, { mediaType: String(req.headers['content-type']), body: data });
      return send(res, 201, undefined, { 'docker-content-digest': `sha256:${createHash('sha256').update(data).digest('hex')}` });
    }
    send(res, 405, {});
  });
  fake.url = url;
  fake.close = closer(server);
  return fake;
}
