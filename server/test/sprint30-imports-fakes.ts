import { createHash } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import type { ConvertRequest, ConvertResult, TrainerBackend, TrainerInfo } from '../src/training/trainer.js';

/*
 * Sprint 30 fakes (B-3801 to B-3803): just enough of a Hugging Face compatible hub, an Ollama compatible (OCI)
 * registry with the bearer-token flow, a CKAN portal and a generic JSON/XML source (DCAT-AP, SDMX, OpenML,
 * InvenioRDM, Kaggle) to drive harvests, live search, rate limits, gates, resumable downloads and digests. Each listens
 * on 127.0.0.1. Nothing here reaches a real repository. Sprint 40 (B-3804 to B-3806) adds the data itself: the hub's
 * dataset viewer (configurations, splits, paged rows), a CKAN portal's `package_show`, datastore, a Socrata resource
 * and a CSV download; SDMX-CSV is a route of the generic source.
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

/** A zip archive of the given members (deflated unless `store`), as a dataset publisher would pack it. */
export function zipOf(members: { name: string; data: Buffer | string; store?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const m of members) {
    const data = Buffer.from(m.data);
    const packed = m.store ? data : deflateRawSync(data);
    const name = Buffer.from(m.name);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(m.store ? 0 : 8, 8);
    head.writeUInt32LE(crc32(data), 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    head.copy(dir, 8, 6, 30);
    dir.writeUInt32LE(offset, 42);
    locals.push(head, name, packed);
    central.push(dir, name);
    offset += 30 + name.length + packed.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const xmlEsc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** An xlsx workbook with one worksheet per entry: strings shared, numbers, booleans, and dates in a date style. */
export function xlsxOf(sheets: Record<string, (string | number | boolean | Date | null)[][]>, o: { hidden?: string[] } = {}): Buffer {
  const shared: string[] = [];
  const col = (i: number) => {
    let s = '';
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  };
  const cell = (v: string | number | boolean | Date | null, ref: string) => {
    if (v == null) return '';
    if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
    if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
    if (v instanceof Date) return `<c r="${ref}" s="1"><v>${v.getTime() / 86_400_000 + 25_569}</v></c>`;
    let i = shared.indexOf(v);
    if (i < 0) i = shared.push(v) - 1;
    return `<c r="${ref}" t="s"><v>${i}</v></c>`;
  };
  const names = Object.keys(sheets);
  const parts = names.map((n, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="3" width="12"/></cols><sheetData>${sheets[n]!.map((r, y) => `<row r="${y + 1}">${r.map((v, x) => cell(v, `${col(x)}${y + 1}`)).join('')}</row>`).join('')}</sheetData></worksheet>` }));
  return zipOf([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${xmlEsc(n)}" sheetId="${i + 1}"${o.hidden?.includes(n) ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_n, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>` },
    { name: 'xl/styles.xml', data: '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>' },
    ...parts,
    { name: 'xl/sharedStrings.xml', data: `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared.map((v) => `<si><t xml:space="preserve">${xmlEsc(v)}</t></si>`).join('')}</sst>` }
  ]);
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
  /** Datasets the viewer serves: licence, gate, and the rows of each configuration's splits. */
  viewer: Map<string, { licence: string; gated: boolean; classes?: Record<string, string[]>; configs: Record<string, Record<string, Record<string, unknown>[]>> }>;
  /** A gated dataset's Parquet files on the hub itself, by dataset, configuration and split (the tests set them). */
  parquet: Map<string, Record<string, Record<string, Buffer[]>>>;
  /** The Parquet downloads served from the "CDN", which must not have received the credential. */
  parquetDownloads: string[];
  /** The `/rows` calls the viewer answered (offset and length), to show the paging. */
  rowCalls: { dataset: string; split: string; offset: number; length: number }[];
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
  const fake = { repos: new Map(), datasets: [], viewer: new Map(), parquet: new Map(), parquetDownloads: [], rowCalls: [], rateLimit: 0, cut: { after: null }, token: 'hf_recordedtoken', accepted: new Set(), downloads: [], apiCalls: 0 } as unknown as FakeHub;
  const add = (r: Omit<HubRepo, 'sha'>) => fake.repos.set(r.id, { ...r, sha: sha256(r.id).slice(0, 40) });
  add({ id: 'acme/tiny-safetensors', licence: 'apache-2.0', pipeline: 'text-generation', gated: false, downloads: 900, library: 'transformers', files: [hubFile('model.safetensors', safetensors('tiny', 5000)), hubFile('config.json', Buffer.from('{"model_type":"llama"}')), hubFile('tokenizer.json', Buffer.from('{"version":"1.0"}'))] });
  add({ id: 'acme/pickle-only', licence: 'mit', pipeline: 'text-generation', gated: false, downloads: 800, library: 'transformers', files: [hubFile('pytorch_model.bin', pickle()), hubFile('config.json', Buffer.from('{"model_type":"bert"}'))] });
  add({ id: 'acme/gated-llama', licence: 'llama3.1', pipeline: 'text-generation', gated: 'manual', downloads: 700, library: 'transformers', files: [hubFile('model.safetensors', safetensors('gated', 3000)), hubFile('config.json', Buffer.from('{"model_type":"llama"}'))] });
  add({ id: 'acme/nc-model', licence: 'cc-by-nc-4.0', pipeline: 'text-generation', gated: false, downloads: 600, library: 'transformers', files: [hubFile('model.safetensors', safetensors('nc', 3000)), hubFile('config.json', Buffer.from('{}'))] });
  add({ id: 'acme/sneaky', licence: 'mit', pipeline: 'text-generation', gated: false, downloads: 500, library: 'transformers', files: [hubFile('model.safetensors', pickle(3000)), hubFile('config.json', Buffer.from('{}'))] });
  add({ id: 'acme/tiny-gguf', licence: 'mit', pipeline: 'text-generation', gated: false, downloads: 400, library: 'gguf', files: [hubFile('tiny-Q4_K_M.gguf', gguf('q4')), hubFile('tiny-Q8_0.gguf', gguf('q8'))] });
  add({ id: 'acme/sentiment', licence: 'apache-2.0', pipeline: 'text-classification', gated: false, downloads: 300, library: 'transformers', files: [hubFile('model.safetensors', safetensors('cls', 2000))] });
  fake.datasets.push({ id: 'acme/phrasebank', author: 'acme', tags: ['task_categories:text-classification', 'license:cc-by-nc-sa-4.0', 'format:parquet', 'size_categories:1K<n<10K'] }, { id: 'acme/dolly', author: 'acme', tags: ['task_categories:text-generation', 'license:cc-by-sa-3.0', 'format:json', 'size_categories:10K<n<100K'] });
  const sentiments = ['negative', 'neutral', 'positive'];
  fake.viewer.set('acme/phrasebank', { licence: 'cc-by-nc-sa-4.0', gated: false, classes: { label: sentiments }, configs: { sentences_allagree: { train: Array.from({ length: 40 }, (_, i) => ({ sentence: `Operating profit rose to EUR ${i + 1} mn.`, label: i % 3 })) } } });
  fake.viewer.set('acme/dolly', { licence: 'cc-by-sa-3.0', gated: false, configs: { default: { train: Array.from({ length: 250 }, (_, i) => ({ instruction: `Question ${i + 1}: when did the service start?`, context: i === 7 ? 'Ask jane.doe@example.org for the timetable.' : `Context ${i + 1}`, response: i === 9 ? '' : `It started in ${1990 + (i % 30)}.`, category: i % 2 ? 'closed_qa' : 'open_qa' })) } } });
  fake.viewer.set('acme/intents', { licence: 'apache-2.0', gated: false, classes: { label: ['card_arrival', 'refund', 'top_up'] }, configs: { default: { train: Array.from({ length: 450 }, (_, i) => ({ text: i === 3 ? 'My card has not arrived, mail me at sam@example.com' : `${['Where is my card', 'I want my money back', 'How do I add funds'][i % 3]} (${i + 1})?`, label: i % 3 })), test: Array.from({ length: 60 }, (_, i) => ({ text: `Held-out ${['card', 'refund', 'top up'][i % 3]} question ${i + 1}`, label: i % 3 })) } } });
  fake.viewer.set('acme/gated-data', { licence: 'mit', gated: true, configs: { default: { train: [{ text: 'x' }] } } });
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
    // A gated dataset's Parquet files: listed and served by the hub to the token whose account accepted the terms.
    const pq = /^\/api\/datasets\/(.+?)\/parquet(?:\/([^/]+)\/([^/]+)\/(\d+)\.parquet)?$/.exec(p);
    if (pq) {
      const files = fake.parquet.get(pq[1]!);
      if (!files) return send(res, 404, { error: 'not found' });
      if (!(authed(req) && fake.accepted.has(pq[1]!))) return send(res, authed(req) ? 403 : 401, { error: 'Access to this dataset is restricted' });
      if (!pq[2]) return send(res, 200, Object.fromEntries(Object.entries(files).map(([config, sp]) => [config, Object.fromEntries(Object.entries(sp).map(([split, parts]) => [split, parts.map((_b, i) => `${url}/api/datasets/${pq[1]}/parquet/${config}/${split}/${i}.parquet`)]))])));
      if (!files[pq[2]]?.[pq[3]!]?.[Number(pq[4])]) return send(res, 404, { error: 'not found' });
      // As on the real hub: first to the hub's own resolve address (which asks for the token again), then to the CDN.
      res.writeHead(302, { location: `/datasets/${pq[1]}/resolve/refs%2Fconvert%2Fparquet/${pq[2]}/${pq[3]}/${String(pq[4]).padStart(4, '0')}.parquet` });
      return res.end();
    }
    const pqResolve = /^\/datasets\/(.+?)\/resolve\/refs\/convert\/parquet\/([^/]+)\/([^/]+)\/(\d+)\.parquet$/.exec(p);
    if (pqResolve) {
      if (!(authed(req) && fake.accepted.has(pqResolve[1]!))) return send(res, authed(req) ? 403 : 401, { error: 'Access to this dataset is restricted' });
      res.writeHead(302, { location: `/cdn-parquet/${encodeURIComponent(pqResolve[1]!)}/${pqResolve[2]}/${pqResolve[3]}/${Number(pqResolve[4])}` });
      return res.end();
    }
    const pqCdn = /^\/cdn-parquet\/([^/]+)\/([^/]+)\/([^/]+)\/(\d+)$/.exec(u.pathname);
    if (pqCdn) {
      if (req.headers.authorization) return send(res, 400, { error: 'the CDN must not receive the credential' });
      const bytes = fake.parquet.get(decodeURIComponent(pqCdn[1]!))?.[pqCdn[2]!]?.[pqCdn[3]!]?.[Number(pqCdn[4])];
      if (!bytes) return send(res, 404, {});
      fake.parquetDownloads.push(`${decodeURIComponent(pqCdn[1]!)}/${pqCdn[2]}/${pqCdn[3]}/${pqCdn[4]}`);
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(bytes);
    }
    const one = /^\/api\/datasets\/(.+)$/.exec(p);
    if (one) {
      const d = fake.viewer.get(one[1]!);
      if (!d) return send(res, 404, { error: 'Repository not found' });
      return send(res, 200, { id: one[1], author: one[1]!.split('/')[0], sha: sha256(one[1]!).slice(0, 40), gated: d.gated, private: false, lastModified: '2026-01-01T00:00:00.000Z', description: `Dataset ${one[1]}`, cardData: { license: d.licence } });
    }
    if (p.startsWith('/datasets-server/')) {
      // The viewer is another host on the real hub: it must never see the repository's token.
      if (req.headers.authorization) return send(res, 400, { error: 'the dataset viewer must not receive the credential' });
      const id = u.searchParams.get('dataset') ?? '';
      const d = fake.viewer.get(id);
      if (!d) return send(res, 404, { error: 'not found' });
      const splits = Object.entries(d.configs).flatMap(([config, sp]) => Object.entries(sp).map(([split, rows]) => ({ dataset: id, config, split, rows })));
      if (p === '/datasets-server/splits') return send(res, 200, { splits: splits.map(({ rows: _rows, ...x }) => x) });
      if (p === '/datasets-server/size') return send(res, 200, { size: { dataset: { num_rows: splits.reduce((a, x) => a + x.rows.length, 0), num_bytes_original_files: splits.reduce((a, x) => a + JSON.stringify(x.rows).length, 0) }, splits: splits.map((x) => ({ config: x.config, split: x.split, num_rows: x.rows.length, num_bytes_parquet_files: JSON.stringify(x.rows).length })) } });
      if (p === '/datasets-server/rows') {
        const rows = d.configs[u.searchParams.get('config') ?? '']?.[u.searchParams.get('split') ?? ''];
        if (!rows) return send(res, 404, { error: 'no such split' });
        const offset = Number(u.searchParams.get('offset') ?? 0);
        const length = Math.min(100, Number(u.searchParams.get('length') ?? 100));
        fake.rowCalls.push({ dataset: id, split: u.searchParams.get('split')!, offset, length });
        const features = Object.keys(rows[0] ?? {}).map((name, i) => ({ feature_idx: i, name, type: d.classes?.[name] ? { _type: 'ClassLabel', names: d.classes[name] } : { _type: 'Value', dtype: 'string' } }));
        return send(res, 200, { features, rows: rows.slice(offset, offset + length).map((row, i) => ({ row_idx: offset + i, row, truncated_cells: [] })), num_rows_total: rows.length });
      }
      return send(res, 404, { error: 'not found' });
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
  /** Answer manifests and blobs only, as registry.ollama.ai does: 404 for `/v2/`, the catalogue and tag listings. */
  manifestsOnly?: boolean;
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
  // `latest` names the q4 build; a registry's tag listing here never showed it, a manifest request finds it.
  fake.manifests.set('library/tinyllama:latest', fake.manifests.get('library/tinyllama:1b-q4_K_M')!);
  fake.manifestDigest = (tag) => `sha256:${sha256(fake.manifests.get(`library/tinyllama:${tag}`)!)}`;
  const cut = { after: null as number | null };
  const { server, url } = await listen((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/token') {
      fake.tokenRequests++;
      return send(res, 200, { token: 'registry-token' });
    }
    if (req.headers.authorization !== 'Bearer registry-token') return send(res, 401, { errors: [{ code: 'UNAUTHORIZED' }] }, { 'www-authenticate': `Bearer realm="${url}/token",service="fake-registry",scope="repository:library/tinyllama:pull"` });
    // registry.ollama.ai answers manifests and blobs only: no `/v2/`, no catalogue, no tag listing.
    if (fake.manifestsOnly && (u.pathname === '/v2/' || u.pathname === '/v2' || u.pathname === '/v2/_catalog' || u.pathname.endsWith('/tags/list'))) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('404 page not found');
    }
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
  /** The datastore's records by resource id, a Socrata resource's rows by its four-by-four, and files by name. */
  datastore: Map<string, Record<string, unknown>[]>;
  socrata: Map<string, Record<string, unknown>[]>;
  files: Map<string, string | Buffer>;
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
    rateLimit: 0,
    datastore: new Map(),
    socrata: new Map(),
    files: new Map()
  } as unknown as FakeCkan;
  const products = ['Credit card', 'Mortgage', 'Student loan'];
  const quoted = (v: string) => `"${v.replace(/"/g, '""')}"`;
  fake.datastore.set('cc-datastore', Array.from({ length: 2300 }, (_, i) => ({ _id: i + 1, 'Date received': `2026-09-${String((i % 28) + 1).padStart(2, '0')}`, Product: products[i % 3], Issue: `Issue ${(i % 7) + 1}`, 'Consumer complaint narrative': i % 50 === 0 ? `I was charged twice; write to consumer${i}@example.org about it.` : `I was charged twice for purchase ${i + 1}.`, State: ['TX', 'WA', 'NY'][i % 3] })));
  fake.socrata.set('f6w7-q2d2', Array.from({ length: 1200 }, (_, i) => ({ ':id': `row-${String(i + 1).padStart(5, '0')}`, make: i % 2 ? 'TESLA' : 'NISSAN', model: i % 2 ? 'MODEL 3' : 'LEAF', county: ['King', 'Pierce'][i % 2], electric_range: String(150 + (i % 100)) })));
  fake.files.set('banklist.csv', 'Bank Name,City,State,Cert,Acquiring Institution,Closing Date\r\n' + Array.from({ length: 12 }, (_, i) => [quoted(`Bank ${i + 1}, N.A.`), ['Chicago', 'Austin', 'Tulsa'][i % 3], ['IL', 'TX', 'OK'][i % 3], 28000 + i, quoted(`Acquirer "${i + 1}"`), `2025-0${(i % 9) + 1}-17`].join(',')).join('\r\n') + '\r\n');
  // The same list packed, with a note beside it, and a workbook of the vehicle counts (its second sheet is hidden).
  fake.files.set('banklist.zip', zipOf([{ name: 'README.txt', data: 'Failed banks, packed for download.' }, { name: 'data/banklist.csv', data: fake.files.get('banklist.csv')! }]));
  fake.files.set('ev.xlsx', xlsxOf({ Notes: [['Electric vehicles by county']], Vehicles: [['Make', 'Model', 'County', 'Registered', 'Count', 'Plug-in'], ...Array.from({ length: 60 }, (_, i) => [i % 2 ? 'TESLA' : 'NISSAN', i % 2 ? 'MODEL 3' : 'LEAF', ['King', 'Pierce'][i % 2]!, new Date(Date.UTC(2026, 0, 1 + i)), 100 + i, i % 3 === 0])] }, { hidden: ['Notes'] }));
  // Which resources of which package have data behind them (the others are names in the catalogue only).
  const wired: Record<string, Record<string, unknown>[]> = {
    'consumer-complaints': [{ id: 'cc-datastore', name: 'Complaints (datastore)', format: 'CSV', size: 1000, datastore_active: true }, { id: 'cc-json', name: 'complaints.json.zip', format: 'ZIP', size: 2_400_000_000, url: 'https://files.example/complaints.json.zip' }],
    'failed-banks': [{ id: 'banks-csv', name: 'banklist.csv', format: 'CSV', size: fake.files.get('banklist.csv')!.length, url: '/files/banklist.csv' }, { id: 'banks-zip', name: 'banklist.zip', format: 'ZIP', size: fake.files.get('banklist.zip')!.length, url: '/files/banklist.zip' }],
    'ev-population': [{ id: 'ev-xlsx', name: 'Electric_Vehicle_Population_Data.xlsx', format: 'XLSX', size: 50_000_000, url: '/files/ev.xlsx' }, { id: 'ev-api', name: 'Socrata API', format: 'JSON', size: null, url: '/resource/f6w7-q2d2.json' }, { id: 'ev-shp', name: 'ev_boundaries.shp', format: 'SHP', size: 9_000_000, url: '/files/ev.shp' }]
  };
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
    if (u.pathname === '/api/3/action/package_show') {
      const p = fake.packages.find((x) => x.name === u.searchParams.get('id'));
      if (!p) return send(res, 404, { success: false, error: { message: 'Not found' } });
      const resources = (wired[String(p.name)] ?? (p.resources as Record<string, unknown>[])).map((r) => ({ ...r, ...(typeof r.url === 'string' && r.url.startsWith('/') ? { url: `${url}${r.url}` } : {}) }));
      return send(res, 200, { success: true, result: { ...p, resources } });
    }
    if (u.pathname === '/api/3/action/datastore_search') {
      const all = fake.datastore.get(u.searchParams.get('resource_id') ?? '');
      if (!all) return send(res, 404, { success: false, error: { message: 'Resource not found' } });
      const limit = Number(u.searchParams.get('limit') ?? 100);
      const offset = Number(u.searchParams.get('offset') ?? 0);
      return send(res, 200, { success: true, result: { records: all.slice(offset, offset + limit), total: all.length, fields: Object.keys(all[0] ?? {}).map((id) => ({ id, type: 'text' })) } });
    }
    const soc = /^\/resource\/([a-z0-9]{4}-[a-z0-9]{4})\.json$/.exec(u.pathname);
    if (soc) {
      const all = fake.socrata.get(soc[1]!);
      if (!all) return send(res, 404, { error: true, message: 'Not found' });
      const limit = Number(u.searchParams.get('$limit') ?? 1000);
      const offset = Number(u.searchParams.get('$offset') ?? 0);
      return send(res, 200, all.slice(offset, offset + limit));
    }
    const file = /^\/files\/(.+)$/.exec(u.pathname);
    if (file && fake.files.has(file[1]!)) {
      const body = fake.files.get(file[1]!)!;
      res.writeHead(200, { 'content-type': typeof body === 'string' ? 'text/csv' : 'application/octet-stream' });
      return res.end(body);
    }
    send(res, 404, { success: false });
  });
  return Object.assign(fake, { url, close: closer(server) });
}

// ---------- a generic source: answers fixed bodies by path ----------

export interface FakeSource extends Fake {
  /** `refuseAccept`: the route answers 406 to a request whose Accept header matches (the ECB and SDMX media types). */
  routes: Map<string, { status?: number; type?: string; body: unknown; refuseAccept?: RegExp }>;
  seen: { path: string; auth: string | null; accept?: string | null }[];
}

export async function startFakeSource(): Promise<FakeSource> {
  const fake = { routes: new Map(), seen: [] } as unknown as FakeSource;
  const { server, url } = await listen((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    fake.seen.push({ path: u.pathname + u.search, auth: req.headers.authorization ?? null, accept: req.headers.accept ?? null });
    const r = fake.routes.get(u.pathname + u.search) ?? fake.routes.get(u.pathname);
    if (!r) return send(res, 404, { error: 'not found' });
    if (r.refuseAccept?.test(req.headers.accept ?? '')) {
      res.writeHead(406);
      return res.end();
    }
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
