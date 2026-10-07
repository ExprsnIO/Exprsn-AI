import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import type { ConvertRequest, ConvertResult, TrainerBackend, TrainerInfo } from '../src/training/trainer.js';

/*
 * Sprint 30 fakes (B-3801 to B-3803): just enough of a Hugging Face compatible hub, an Ollama compatible (OCI)
 * registry with the bearer-token flow, a CKAN portal and a generic JSON/XML source (DCAT-AP, SDMX, OpenML,
 * InvenioRDM, Kaggle) to drive harvests, live search, rate limits, gates, resumable downloads and digests. Each listens
 * on 127.0.0.1. Nothing here reaches a real repository.
 */

export interface Fake {
  url: string;
  close(): Promise<void>;
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const gitSha1 = (b: Buffer) => createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => unknown): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err: Error) => {
      if (!res.headersSent) res.statusCode = 500;
      res.end(err.message);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const closer = (server: Server) => () =>
  new Promise<void>((r) => {
    server.closeAllConnections();
    server.close(() => r());
  });

const send = (res: ServerResponse, status: number, data?: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(data === undefined ? '' : JSON.stringify(data));
};

/** Serves bytes honouring `Range: bytes=N-`; `cutAfter` drops the connection after that many bytes (once). */
function serveBytes(req: IncomingMessage, res: ServerResponse, bytes: Buffer, cut: { after: number | null }) {
  const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
  const from = m ? Number(m[1]) : 0;
  const body = bytes.subarray(from);
  res.writeHead(m ? 206 : 200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length), ...(m ? { 'content-range': `bytes ${from}-${bytes.length - 1}/${bytes.length}` } : {}) });
  if (req.method === 'HEAD') return res.end();
  if (cut.after != null && cut.after < body.length) {
    const n = cut.after;
    cut.after = null;
    res.write(body.subarray(0, n), () => setTimeout(() => res.destroy(), 20));
    return;
  }
  res.end(body);
}

/** A tiny but well-formed safetensors file. */
export function safetensors(seed: string, size = 3000): Buffer {
  const header = Buffer.from(JSON.stringify({ __metadata__: { seed }, w: { dtype: 'F32', shape: [Math.floor((size - 200) / 4)], data_offsets: [0, Math.floor((size - 200) / 4) * 4] } }));
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(header.length));
  return Buffer.concat([len, header, Buffer.alloc(Math.floor((size - 200) / 4) * 4, seed.length % 251)]);
}
export const gguf = (seed: string, size = 2000) => Buffer.concat([Buffer.from('GGUF'), Buffer.from([3, 0, 0, 0]), Buffer.alloc(size, seed.charCodeAt(0))]);
export const pickle = (size = 600) => Buffer.concat([Buffer.from([0x80, 0x04, 0x95]), Buffer.alloc(size, 7)]);

// ---------- Hugging Face compatible hub ----------

interface HubFile {
  name: string;
  bytes: Buffer;
  lfs: boolean;
}
interface HubRepo {
  id: string;
  sha: string;
  licence: string;
  pipeline: string;
  gated: false | 'manual' | 'auto';
  files: HubFile[];
  downloads: number;
  library?: string;
}

export interface FakeHub extends Fake {
  repos: Map<string, HubRepo>;
  datasets: { id: string; tags: string[]; author: string }[];
  /** Answer 429 to the next N API calls (Retry-After: 2). */
  rateLimit: number;
  /** Drop the next file download after this many bytes. */
  cut: { after: number | null };
  token: string;
  accepted: Set<string>;
  downloads: { file: string; range: string | null }[];
  apiCalls: number;
  /** Swap a file's bytes and digest under the same commit (the "changed under the same revision" case). */
  tamper(repo: string, file: string, bytes: Buffer): void;
}

const hubFile = (name: string, bytes: Buffer): HubFile => ({ name, bytes, lfs: /\.(safetensors|gguf|bin)$/.test(name) });

export async function startFakeHub(): Promise<FakeHub> {
  const fake = { repos: new Map(), datasets: [], rateLimit: 0, cut: { after: null }, token: 'hf_recordedtoken', accepted: new Set(), downloads: [], apiCalls: 0 } as unknown as FakeHub;
  const add = (r: Omit<HubRepo, 'sha'>) => fake.repos.set(r.id, { ...r, sha: sha256(r.id).slice(0, 40) });
  add({ id: 'acme/tiny-safetensors', licence: 'apache-2.0', pipeline: 'text-generation', gated: false, downloads: 900, library: 'transformers', files: [hubFile('model.safetensors', safetensors('tiny', 5000)), hubFile('config.json', Buffer.from('{"model_type":"llama"}')), hubFile('tokenizer.json', Buffer.from('{"version":"1.0"}'))] });
  add({ id: 'acme/pickle-only', licence: 'mit', pipeline: 'text-generation', gated: false, downloads: 800, library: 'transformers', files: [hubFile('pytorch_model.bin', pickle()), hubFile('config.json', Buffer.from('{"model_type":"bert"}'))] });
  add({ id: 'acme/gated-llama', licence: 'llama3.1', pipeline: 'text-generation', gated: 'manual', downloads: 700, library: 'transformers', files: [hubFile('model.safetensors', safetensors('gated', 3000)), hubFile('config.json', Buffer.from('{"model_type":"llama"}'))] });
  add({ id: 'acme/nc-model', licence: 'cc-by-nc-4.0', pipeline: 'text-generation', gated: false, downloads: 600, library: 'transformers', files: [hubFile('model.safetensors', safetensors('nc', 3000)), hubFile('config.json', Buffer.from('{}'))] });
  add({ id: 'acme/sneaky', licence: 'mit', pipeline: 'text-generation', gated: false, downloads: 500, library: 'transformers', files: [hubFile('model.safetensors', pickle(3000)), hubFile('config.json', Buffer.from('{}'))] });
  add({ id: 'acme/tiny-gguf', licence: 'mit', pipeline: 'text-generation', gated: false, downloads: 400, library: 'gguf', files: [hubFile('tiny-Q4_K_M.gguf', gguf('q4')), hubFile('tiny-Q8_0.gguf', gguf('q8'))] });
  add({ id: 'acme/sentiment', licence: 'apache-2.0', pipeline: 'text-classification', gated: false, downloads: 300, library: 'transformers', files: [hubFile('model.safetensors', safetensors('cls', 2000))] });
  fake.datasets.push({ id: 'acme/phrasebank', author: 'acme', tags: ['task_categories:text-classification', 'license:cc-by-nc-sa-4.0', 'format:parquet', 'size_categories:1K<n<10K'] }, { id: 'acme/dolly', author: 'acme', tags: ['task_categories:text-generation', 'license:cc-by-sa-3.0', 'format:json', 'size_categories:10K<n<100K'] });
  fake.tamper = (repo, file, bytes) => {
    const r = fake.repos.get(repo)!;
    r.files = r.files.map((f) => (f.name === file ? { ...f, bytes } : f));
  };
  const tags = (r: HubRepo) => [`license:${r.licence}`, ...new Set(r.files.map((f) => (f.name.endsWith('.gguf') ? 'gguf' : f.name.endsWith('.safetensors') ? 'safetensors' : f.name.endsWith('.bin') ? 'pytorch' : null)).filter((x) => x !== null) as string[])];
  const listItem = (r: HubRepo) => ({ id: r.id, author: r.id.split('/')[0], pipeline_tag: r.pipeline, library_name: r.library, tags: tags(r), downloads: r.downloads, likes: 1, lastModified: '2026-09-01T00:00:00.000Z', gated: r.gated, private: false, siblings: r.files.map((f) => ({ rfilename: f.name })) });
  const authed = (req: IncomingMessage) => req.headers.authorization === `Bearer ${fake.token}`;
  const { server, url } = await listen((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const p = decodeURIComponent(u.pathname);
    if (p.startsWith('/api/')) {
      fake.apiCalls++;
      if (fake.rateLimit > 0) {
        fake.rateLimit--;
        return send(res, 429, { error: 'Too many requests' }, { 'retry-after': '2' });
      }
    }
    if (p === '/api/whoami-v2') return authed(req) ? send(res, 200, { name: 'northwind-ml' }) : send(res, 401, { error: 'Invalid credentials' });
    if (p === '/api/models') {
      const q = (u.searchParams.get('search') ?? '').toLowerCase();
      const limit = Number(u.searchParams.get('limit') ?? 1000);
      const offset = Number(u.searchParams.get('cursor') ?? 0);
      const all = [...fake.repos.values()].filter((r) => !q || r.id.toLowerCase().includes(q)).sort((a, b) => b.downloads - a.downloads);
      const page = all.slice(offset, offset + limit);
      const next = offset + limit < all.length ? `<${url}/api/models?limit=${limit}&cursor=${offset + limit}${q ? `&search=${q}` : ''}>; rel="next"` : null;
      return send(res, 200, page.map(listItem), next ? { link: next } : {});
    }
    if (p === '/api/datasets') {
      const q = (u.searchParams.get('search') ?? '').toLowerCase();
      return send(res, 200, fake.datasets.filter((d) => !q || d.id.includes(q)).map((d) => ({ ...d, downloads: 1, lastModified: '2026-01-01T00:00:00.000Z', gated: false, private: false, description: `Dataset ${d.id}` })));
    }
    const rev = /^\/api\/models\/(.+)\/revision\/([^/]+)$/.exec(p);
    if (rev) {
      const r = fake.repos.get(rev[1]!);
      if (!r || (rev[2] !== 'main' && rev[2] !== r.sha)) return send(res, 404, { error: 'Repository not found' });
      return send(res, 200, { id: r.id, sha: r.sha, pipeline_tag: r.pipeline, library_name: r.library, tags: tags(r), gated: r.gated, cardData: { license: r.licence }, config: { model_type: 'llama' }, safetensors: { total: 7_600_000_000 }, siblings: r.files.map((f) => ({ rfilename: f.name, size: f.bytes.length, blobId: gitSha1(f.bytes), ...(f.lfs ? { lfs: { sha256: sha256(f.bytes), size: f.bytes.length, pointerSize: 134 } } : {}) })) });
    }
    const ask = /^\/(.+)\/ask-access$/.exec(p);
    if (ask && req.method === 'POST') {
      if (!authed(req)) return send(res, 401, { error: 'Sign in' });
      fake.accepted.add(ask[1]!);
      return send(res, 200, { ok: true });
    }
    const resolve = /^\/(.+)\/resolve\/([^/]+)\/(.+)$/.exec(p);
    if (resolve) {
      const r = fake.repos.get(resolve[1]!);
      const f = r?.files.find((x) => x.name === resolve[3]);
      if (!r || !f || resolve[2] !== r.sha) return send(res, 404, { error: 'Entry not found' });
      if (r.gated && !(authed(req) && fake.accepted.has(r.id))) return send(res, 403, { error: 'Access to this repository is restricted' });
      // LFS files redirect to the "CDN" (same host here); small files are served directly.
      if (f.lfs) {
        res.writeHead(302, { location: `/cdn/${encodeURIComponent(r.id)}/${encodeURIComponent(f.name)}` });
        return res.end();
      }
      fake.downloads.push({ file: f.name, range: req.headers.range ?? null });
      return serveBytes(req, res, f.bytes, fake.cut);
    }
    const cdn = /^\/cdn\/([^/]+)\/([^/]+)$/.exec(u.pathname);
    if (cdn) {
      if (req.headers.authorization) return send(res, 400, { error: 'the CDN must not receive the credential' });
      const r = fake.repos.get(decodeURIComponent(cdn[1]!));
      const f = r?.files.find((x) => x.name === decodeURIComponent(cdn[2]!));
      if (!f) return send(res, 404, {});
      fake.downloads.push({ file: f.name, range: req.headers.range ?? null });
      return serveBytes(req, res, f.bytes, fake.cut);
    }
    send(res, 404, { error: 'not found' });
  });
  return Object.assign(fake, { url, close: closer(server) });
}

// ---------- Ollama compatible registry ----------

export interface FakeRegistry extends Fake {
  manifests: Map<string, Buffer>;
  blobs: Map<string, Buffer>;
  tokenRequests: number;
  manifestDigest(tag: string): string;
}

export async function startFakeRegistry(): Promise<FakeRegistry> {
  const fake = { manifests: new Map(), blobs: new Map(), tokenRequests: 0 } as unknown as FakeRegistry;
  const blob = (b: Buffer) => {
    const d = `sha256:${sha256(b)}`;
    fake.blobs.set(d, b);
    return d;
  };
  const addTag = (tag: string, model: Buffer, licence: string) => {
    const config = Buffer.from(JSON.stringify({ model_format: 'gguf', model_family: 'llama', model_type: '1.1B', file_type: tag.includes('q8') ? 'Q8_0' : 'Q4_K_M' }));
    const layers = [
      { mediaType: 'application/vnd.ollama.image.model', b: model },
      { mediaType: 'application/vnd.ollama.image.license', b: Buffer.from(licence) },
      { mediaType: 'application/vnd.ollama.image.template', b: Buffer.from('{{ .Prompt }}') }
    ];
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.docker.distribution.manifest.v2+json', config: { mediaType: 'application/vnd.docker.container.image.v1+json', digest: blob(config), size: config.length }, layers: layers.map((l) => ({ mediaType: l.mediaType, digest: blob(l.b), size: l.b.length })) }));
    fake.manifests.set(`library/tinyllama:${tag}`, manifest);
    fake.manifests.set(`library/tinyllama:sha256:${sha256(manifest)}`, manifest);
  };
  addTag('1b-q4_K_M', gguf('ollama-q4', 4000), 'MIT License\n\nCopyright (c) 2026 Tiny\n\nPermission is hereby granted, free of charge, to any person obtaining a copy');
  addTag('1b-q8_0', gguf('ollama-q8', 6000), 'MIT License\n\nPermission is hereby granted, free of charge');
  fake.manifestDigest = (tag) => `sha256:${sha256(fake.manifests.get(`library/tinyllama:${tag}`)!)}`;
  const cut = { after: null as number | null };
  const { server, url } = await listen((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/token') {
      fake.tokenRequests++;
      return send(res, 200, { token: 'registry-token' });
    }
    if (req.headers.authorization !== 'Bearer registry-token') return send(res, 401, { errors: [{ code: 'UNAUTHORIZED' }] }, { 'www-authenticate': `Bearer realm="${url}/token",service="fake-registry",scope="repository:library/tinyllama:pull"` });
    if (u.pathname === '/v2/' || u.pathname === '/v2') return send(res, 200, {});
    if (u.pathname === '/v2/_catalog') return send(res, 200, { repositories: ['library/tinyllama'] });
    if (u.pathname === '/v2/library/tinyllama/tags/list') return send(res, 200, { name: 'library/tinyllama', tags: ['1b-q4_K_M', '1b-q8_0'] });
    const m = /^\/v2\/(.+)\/manifests\/(.+)$/.exec(u.pathname);
    if (m) {
      const b = fake.manifests.get(`${m[1]}:${decodeURIComponent(m[2]!)}`);
      if (!b) return send(res, 404, { errors: [{ code: 'MANIFEST_UNKNOWN' }] });
      res.writeHead(200, { 'content-type': 'application/vnd.docker.distribution.manifest.v2+json', 'docker-content-digest': `sha256:${sha256(b)}` });
      return res.end(b);
    }
    const bl = /^\/v2\/(.+)\/blobs\/(.+)$/.exec(u.pathname);
    if (bl) {
      const b = fake.blobs.get(decodeURIComponent(bl[2]!));
      if (!b) return send(res, 404, {});
      return serveBytes(req, res, b, cut);
    }
    send(res, 404, {});
  });
  return Object.assign(fake, { url, close: closer(server) });
}

// ---------- CKAN ----------

export interface FakeCkan extends Fake {
  packages: Record<string, unknown>[];
  calls: string[];
  rateLimit: number;
}

export async function startFakeCkan(): Promise<FakeCkan> {
  const pkg = (name: string, title: string, group: string, licence: string, formats: string[], org: string) => ({ name, title, notes: `<p>${title} from ${org}</p>`, license_id: licence, organization: { title: org }, groups: [{ display_name: group }], tags: [{ name: group.toLowerCase() }], resources: formats.map((f) => ({ name: `${name}.${f}`, format: f.toUpperCase(), size: 1000 })), metadata_modified: '2026-10-01T05:00:00', extras: [{ key: 'accrualPeriodicity', value: 'R/P1M' }] });
  const fake = {
    packages: [
      pkg('consumer-complaints', 'Consumer Complaint Database', 'Finance', 'us-pd', ['csv', 'json'], 'CFPB'),
      pkg('failed-banks', 'Failed Bank List', 'Finance', 'us-pd', ['csv'], 'FDIC'),
      pkg('college-scorecard', 'College Scorecard', 'Education', 'us-pd', ['csv', 'api'], 'Department of Education'),
      pkg('ev-population', 'Electric Vehicle Population Data', 'Transport', 'odc-odbl', ['csv', 'json'], 'Washington State'),
      pkg('air-quality', 'Air Quality Index', 'Environment', 'cc-by', ['csv'], 'EPA')
    ],
    calls: [],
    rateLimit: 0
  } as unknown as FakeCkan;
  const { server, url } = await listen((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    fake.calls.push(u.pathname + u.search);
    if (fake.rateLimit > 0) {
      fake.rateLimit--;
      return send(res, 429, { error: 'slow down' }, { 'retry-after': '120' });
    }
    if (u.pathname === '/api/3/action/package_search') {
      const q = (u.searchParams.get('q') ?? '').toLowerCase();
      const rows = Number(u.searchParams.get('rows') ?? 10);
      const start = Number(u.searchParams.get('start') ?? 0);
      const all = fake.packages.filter((p) => !q || JSON.stringify(p).toLowerCase().includes(q));
      return send(res, 200, { success: true, result: { count: all.length, results: all.slice(start, start + rows) } });
    }
    send(res, 404, { success: false });
  });
  return Object.assign(fake, { url, close: closer(server) });
}

// ---------- a generic source: answers fixed bodies by path ----------

export interface FakeSource extends Fake {
  routes: Map<string, { status?: number; type?: string; body: unknown }>;
  seen: { path: string; auth: string | null }[];
}

export async function startFakeSource(): Promise<FakeSource> {
  const fake = { routes: new Map(), seen: [] } as unknown as FakeSource;
  const { server, url } = await listen((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    fake.seen.push({ path: u.pathname + u.search, auth: req.headers.authorization ?? null });
    const r = fake.routes.get(u.pathname + u.search) ?? fake.routes.get(u.pathname);
    if (!r) return send(res, 404, { error: 'not found' });
    res.writeHead(r.status ?? 200, { 'content-type': r.type ?? 'application/json' });
    res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
  });
  return Object.assign(fake, { url, close: closer(server) });
}

// ---------- the GPU worker's conversion ----------

/**
 * Stands in for the training worker's `POST /v1/convert` on an import: reads every staged artefact back from the
 * platform with the grant (checking its sha256), "converts" it and uploads the GGUF, and answers the digest the pools
 * will report for the pushed model.
 */
export class FakeConverter implements TrainerBackend {
  readonly kind = 'fake-converter';
  readonly available = true;
  readonly reason = null;
  converts: ConvertRequest[] = [];
  digests: string[] = [];
  read: { name: string; sha256: string }[] = [];
  private app: Parameters<typeof request>[0] | null = null;

  useApp(app: Parameters<typeof request>[0]): this {
    this.app = app;
    return this;
  }

  private async call(method: 'get' | 'put', url: string, token: string, body?: Buffer): Promise<{ status: number; body: Buffer }> {
    const u = new URL(url);
    let r = request(this.app!)[method](u.pathname + u.search).set('authorization', `Bearer ${token}`);
    if (body) r = r.set('content-type', 'application/octet-stream').send(body);
    const res = await r.buffer(true).parse((resp, cb) => {
      const chunks: Buffer[] = [];
      resp.on('data', (c: Buffer) => chunks.push(c));
      resp.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    return { status: res.status, body: res.body as Buffer };
  }

  async convert(req: ConvertRequest): Promise<ConvertResult> {
    this.converts.push(req);
    if (!req.source) throw new Error('not an import');
    const parts: Buffer[] = [];
    for (const f of req.source.files) {
      const got = await this.call('get', `${req.source.artifacts.url}/${f.artifact}`, req.source.artifacts.token);
      if (got.status !== 200) throw new Error(`artefact read answered ${got.status}`);
      if (sha256(got.body) !== f.sha256) throw new Error(`${f.name} does not match its sha256`);
      this.read.push({ name: f.name, sha256: f.sha256 });
      parts.push(got.body);
    }
    const out = Buffer.concat([Buffer.from('GGUF'), Buffer.from(req.quantization), ...parts]);
    const put = await this.call('put', `${req.source.artifacts.url}/model.gguf?kind=gguf`, req.source.artifacts.token, out);
    if (put.status !== 201) throw new Error(`upload answered ${put.status}`);
    const digest = `sha256:${sha256(Buffer.concat([Buffer.from('manifest:'), out]))}`;
    this.digests.push(digest);
    return { name: req.name, artifact: 'exprsn-artifact:model.gguf', digest, sizeBytes: out.length, quantization: req.quantization === 'as-is' ? 'Q4_K_M' : req.quantization, tool: 'llama.cpp convert_hf_to_gguf + llama-quantize (fake)' };
  }

  async info(): Promise<TrainerInfo> {
    return { contract: 2, container: 'fake', trainers: [], accelerators: ['cuda'], gpus: { total: 1, free: 1 } };
  }
  async submit(): Promise<{ id: string }> {
    throw new Error('not used');
  }
  async status(): Promise<never> {
    throw new Error('not used');
  }
  async checkpoint(): Promise<never> {
    throw new Error('not used');
  }
  async cancel(): Promise<void> {}
  async evaluate(): Promise<never> {
    throw new Error('not used');
  }
}
