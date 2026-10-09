import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/*
 * Sprint 40b fakes (B-3804 to B-3806): an open-data portal that speaks CKAN (package_search, package_show, a paged
 * datastore_search), serves files (CSV, JSON, JSON Lines, an XLSX nobody can read here), a Socrata-style endpoint, an
 * SDMX provider (dataflows and SDMX-CSV data) and a Hugging Face compatible hub with dataset repositories; and a
 * classifier worker that scores an imported engine by keyword. Rows are mutable so a knowledge set's refresh sees
 * changed, new and removed rows. Each listens on 127.0.0.1; nothing here reaches a real source.
 */

export interface Fake {
  url: string;
  close(): Promise<void>;
}

export type Row = Record<string, unknown>;
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => unknown): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      (req as IncomingMessage & { body: string }).body = body;
      Promise.resolve(handler(req, res)).catch((err: Error) => {
        if (!res.headersSent) res.statusCode = 500;
        res.end(err.message);
      });
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
  res.end(data === undefined ? '' : typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
};

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (rows: Row[], columns?: string[]): string => {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
};

/** The complaints table: a text column, a label column, an e-mail column the PII detectors flag, a region. */
export const complaints = (n: number): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    product: ['credit card', 'mortgage', 'checking', 'auto loan'][i % 4],
    narrative: `Complaint ${i + 1}: the ${['fee', 'statement', 'payment', 'refund'][i % 4]} was wrong and nobody answered.`,
    email: `person${i + 1}@example.org`,
    region: ['north', 'south'][i % 2],
    received: `2026-0${(i % 9) + 1}-15`
  }));

// ---------- an open-data portal: CKAN, files, Socrata, SDMX ----------

export interface FakePortal extends Fake {
  calls: string[];
  rateLimit: number;
  /** The datastore rows of `consumer-complaints` (mutable). */
  rows: Row[];
  /** The SDMX-CSV rows of the PRC_HICP flow (mutable). */
  hicp: Row[];
  files: Map<string, { type: string; body: Buffer | string }>;
}

export async function startFakePortal(): Promise<FakePortal> {
  const fake = { calls: [], rateLimit: 0, rows: complaints(2500), hicp: [], files: new Map() } as unknown as FakePortal;
  fake.hicp = Array.from({ length: 24 }, (_, i) => ({ DATAFLOW: 'ESTAT:PRC_HICP_MIDX(1.0)', FREQ: 'M', geo: i % 2 ? 'DE' : 'FR', TIME_PERIOD: `2026-${String((i % 12) + 1).padStart(2, '0')}`, OBS_VALUE: (100 + i * 0.3).toFixed(1) }));
  const pkg = (name: string, title: string, licence: string, org: string, resources: Row[], extra: Row = {}) => ({ name, id: name, title, notes: `<p>${title} from ${org}</p>`, license_id: licence, organization: { title: org }, groups: [{ display_name: 'Finance' }], tags: [], metadata_modified: '2026-09-30T00:00:00', frequency: 'monthly', resources, ...extra });
  let url = '';
  const packages = (): Row[] => [
    pkg('consumer-complaints', 'Consumer Complaint Database', 'us-pd', 'CFPB', [
      { id: 'ds-complaints', name: 'Complaints (datastore)', format: 'CSV', url: `${url}/files/complaints.csv`, datastore_active: true, size: 240_000 },
      { id: 'complaints-json', name: 'Complaints (JSON)', format: 'JSON', url: `${url}/files/complaints.json`, size: 120_000 }
    ]),
    pkg('failed-banks', 'Failed Bank List', 'cc-by-nc-4.0', 'FDIC', [{ id: 'banks-csv', name: 'banks.csv', format: 'CSV', url: `${url}/files/banks.csv`, size: 2_000 }]),
    pkg('spreadsheet-only', 'Spreadsheet only', 'us-pd', 'Someone', [{ id: 'xlsx', name: 'data.xlsx', format: 'XLSX', url: `${url}/files/data.xlsx`, size: 5_000 }]),
    pkg('small-labelled', 'Banking intents', 'cc-by-4.0', 'Banking lab', [{ id: 'intents-csv', name: 'intents.csv', format: 'CSV', url: `${url}/files/intents.csv`, size: 3_000 }])
  ];
  const { server, url: u0 } = await listen((req, res) => {
    url = u0;
    const u = new URL(req.url ?? '/', 'http://x');
    fake.calls.push(u.pathname + u.search);
    if (fake.rateLimit > 0) {
      fake.rateLimit--;
      return send(res, 429, { error: 'slow down' }, { 'retry-after': '2' });
    }
    const p = u.pathname;
    if (p === '/api/3/action/package_search') {
      const q = (u.searchParams.get('q') ?? '').toLowerCase();
      const all = packages().filter((x) => !q || JSON.stringify(x).toLowerCase().includes(q));
      return send(res, 200, { success: true, result: { count: all.length, results: all } });
    }
    if (p === '/api/3/action/package_show') {
      const x = packages().find((x) => x.name === u.searchParams.get('id'));
      return x ? send(res, 200, { success: true, result: x }) : send(res, 404, { success: false });
    }
    if (p === '/api/3/action/datastore_search') {
      const offset = Number(u.searchParams.get('offset') ?? 0);
      const limit = Math.min(Number(u.searchParams.get('limit') ?? 100), 1000);
      const page = fake.rows.slice(offset, offset + limit).map((r, i) => ({ _id: offset + i + 1, ...r }));
      return send(res, 200, { success: true, result: { total: fake.rows.length, records: page } });
    }
    if (p === '/resource/abcd-1234.json') {
      const offset = Number(u.searchParams.get('$offset') ?? 0);
      const limit = Number(u.searchParams.get('$limit') ?? 1000);
      return send(res, 200, fake.rows.slice(offset, offset + limit));
    }
    if (p === '/files/complaints.csv') return send(res, 200, toCsv(fake.rows), { 'content-type': 'text/csv' });
    if (p === '/files/complaints.json') return send(res, 200, fake.rows.slice(0, 300));
    if (p === '/files/banks.csv') return send(res, 200, toCsv([{ bank: 'First Bank', city: 'Austin', closed: '2026-01-02' }, { bank: 'Second Bank', city: 'Boise', closed: '2026-02-03' }]), { 'content-type': 'text/csv' });
    if (p === '/files/intents.csv') return send(res, 200, toCsv([...Array.from({ length: 12 }, (_, i) => ({ text: `I want a refund for charge ${i}`, label: 'refund' })), ...Array.from({ length: 9 }, (_, i) => ({ text: `My card ${i} is lost`, label: 'card_lost' })), { text: 'Why was I charged a fee', label: 'fees' }]), { 'content-type': 'text/csv' });
    if (p === '/files/data.xlsx') return send(res, 200, Buffer.from('PK\u0003\u0004 not a spreadsheet anyone reads here'), { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const f = fake.files.get(p);
    if (f) return send(res, 200, f.body, { 'content-type': f.type });
    if (p === '/sdmx/dataflow/all/all/latest') return send(res, 200, '<m:Structure><m:Structures><s:Dataflows><s:Dataflow id="PRC_HICP_MIDX" agencyID="ESTAT" version="1.0"><c:Name xml:lang="en">HICP monthly index</c:Name></s:Dataflow></s:Dataflows></m:Structures></m:Structure>', { 'content-type': 'application/xml' });
    if (p === '/sdmx/categorisation/all/all/latest') return send(res, 200, '<s:Categorisations/>', { 'content-type': 'application/xml' });
    if (p === '/sdmx/data/PRC_HICP_MIDX') return send(res, 200, toCsv(fake.hicp, ['DATAFLOW', 'FREQ', 'geo', 'TIME_PERIOD', 'OBS_VALUE']), { 'content-type': 'text/csv' });
    send(res, 404, { error: 'not found' });
  });
  url = u0;
  return Object.assign(fake, { url: u0, close: closer(server) });
}

// ---------- a Hugging Face compatible hub with dataset repositories ----------

export interface HubDataset {
  id: string;
  licence: string;
  files: { name: string; body: Buffer | string; type?: string }[];
  configs?: string[];
}

export interface FakeDataHub extends Fake {
  datasets: Map<string, HubDataset>;
  calls: string[];
  /** Model repositories (for the imported classifier engine, B-3806). */
  models: Map<string, { id: string; licence: string; pipeline: string; files: { name: string; bytes: Buffer }[] }>;
  downloads: string[];
}

/** A tiny but well-formed safetensors file. */
export function safetensors(seed: string, size = 3000): Buffer {
  const header = Buffer.from(JSON.stringify({ w: { dtype: 'F32', shape: [size / 4], data_offsets: [0, size] }, __metadata__: { seed } }), 'utf8');
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(header.length));
  return Buffer.concat([len, header, Buffer.alloc(size, seed.charCodeAt(0))]);
}

export async function startFakeDataHub(): Promise<FakeDataHub> {
  const fake = { datasets: new Map(), calls: [], models: new Map(), downloads: [] } as unknown as FakeDataHub;
  const intents = [...Array.from({ length: 220 }, (_, i) => ({ text: `Refund request number ${i}: the charge was not mine`, label: 'refund' })), ...Array.from({ length: 205 }, (_, i) => ({ text: `Lost card report ${i}: please block it`, label: 'card_lost' }))];
  fake.datasets.set('acme/banking', { id: 'acme/banking', licence: 'apache-2.0', files: [{ name: 'train.csv', body: toCsv(intents.slice(0, 400)) }, { name: 'test.csv', body: toCsv(intents.slice(400)) }, { name: 'README.md', body: '# banking' }] });
  fake.datasets.set('acme/phrasebank', { id: 'acme/phrasebank', licence: 'cc-by-nc-sa-4.0', files: [{ name: 'data/train.jsonl', body: Array.from({ length: 30 }, (_, i) => JSON.stringify({ sentence: `Sentence ${i} about profit`, sentiment: i % 3 ? 'positive' : 'negative' })).join('\n') + '\n' }], configs: ['sentences_allagree'] });
  fake.models.set('acme/intent-cls', { id: 'acme/intent-cls', licence: 'apache-2.0', pipeline: 'text-classification', files: [{ name: 'model.safetensors', bytes: safetensors('cls', 2000) }, { name: 'config.json', bytes: Buffer.from(JSON.stringify({ model_type: 'bert', architectures: ['BertForSequenceClassification'], id2label: { '0': 'refund', '1': 'card_lost' } })) }, { name: 'tokenizer.json', bytes: Buffer.from('{"version":"1.0"}') }] });
  const sha = (id: string) => sha256(id).slice(0, 40);
  const { server, url } = await listen((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const p = decodeURIComponent(u.pathname);
    fake.calls.push(p + u.search);
    if (p === '/api/models') {
      const q = (u.searchParams.get('search') ?? '').toLowerCase();
      return send(res, 200, [...fake.models.values()].filter((m) => !q || m.id.includes(q)).map((m) => ({ id: m.id, author: 'acme', pipeline_tag: m.pipeline, library_name: 'transformers', tags: [`license:${m.licence}`, 'safetensors'], downloads: 5, likes: 1, lastModified: '2026-09-01T00:00:00.000Z', gated: false, private: false })));
    }
    if (p === '/api/datasets') {
      const q = (u.searchParams.get('search') ?? '').toLowerCase();
      return send(res, 200, [...fake.datasets.values()].filter((d) => !q || d.id.includes(q)).map((d) => ({ id: d.id, author: 'acme', tags: [`license:${d.licence}`, 'task_categories:text-classification', 'format:csv'], downloads: 1, likes: 0, lastModified: '2026-01-01T00:00:00.000Z', gated: false, private: false, description: `Dataset ${d.id}` })));
    }
    const ds = /^\/api\/datasets\/(.+)$/.exec(p);
    if (ds) {
      const d = fake.datasets.get(ds[1]!);
      if (!d) return send(res, 404, { error: 'Repository not found' });
      return send(res, 200, { id: d.id, author: 'acme', sha: sha(d.id), tags: [`license:${d.licence}`, 'task_categories:text-classification'], cardData: { license: d.licence, ...(d.configs ? { configs: d.configs.map((c) => ({ config_name: c })) } : {}) }, siblings: d.files.map((f) => ({ rfilename: f.name, size: Buffer.byteLength(f.body) })), gated: false, private: false, lastModified: '2026-01-01T00:00:00.000Z' });
    }
    const rev = /^\/api\/models\/(.+)\/revision\/([^/]+)$/.exec(p);
    if (rev) {
      const m = fake.models.get(rev[1]!);
      if (!m || (rev[2] !== 'main' && rev[2] !== sha(m.id))) return send(res, 404, { error: 'Repository not found' });
      return send(res, 200, { id: m.id, sha: sha(m.id), pipeline_tag: m.pipeline, library_name: 'transformers', tags: [`license:${m.licence}`, 'safetensors'], gated: false, cardData: { license: m.licence }, config: { model_type: 'bert' }, siblings: m.files.map((f) => ({ rfilename: f.name, size: f.bytes.length, ...(f.name.endsWith('.safetensors') ? { lfs: { sha256: sha256(f.bytes), size: f.bytes.length } } : { blobId: createHash('sha1').update(`blob ${f.bytes.length}\0`).update(f.bytes).digest('hex') }) })) });
    }
    const dres = /^\/datasets\/(.+)\/resolve\/([^/]+)\/(.+)$/.exec(p);
    if (dres) {
      const d = fake.datasets.get(dres[1]!);
      const f = d?.files.find((x) => x.name === dres[3]);
      if (!d || !f) return send(res, 404, { error: 'Not found' });
      fake.downloads.push(`${d.id}:${f.name}`);
      return send(res, 200, f.body, { 'content-type': f.type ?? (f.name.endsWith('.jsonl') ? 'application/x-ndjson' : f.name.endsWith('.csv') ? 'text/csv' : 'text/plain') });
    }
    const mres = /^\/(.+)\/resolve\/([^/]+)\/(.+)$/.exec(p);
    if (mres) {
      const m = fake.models.get(mres[1]!);
      const f = m?.files.find((x) => x.name === mres[3]);
      if (!m || !f) return send(res, 404, { error: 'Not found' });
      const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? '');
      const from = range ? Number(range[1]) : 0;
      const body = f.bytes.subarray(from);
      res.writeHead(range ? 206 : 200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length), ...(range ? { 'content-range': `bytes ${from}-${f.bytes.length - 1}/${f.bytes.length}` } : {}) });
      if (req.method === 'HEAD') return res.end();
      return res.end(body);
    }
    send(res, 404, { error: 'not found' });
  });
  return Object.assign(fake, { url, close: closer(server) });
}

// ---------- the classifier worker ----------

export interface FakeClassifierWorker extends Fake {
  calls: { model: string; text: string; labels: string[] }[];
  fetch: typeof fetch;
}

/** Scores by keyword: a text that mentions a label (or `refund`, `lost`) gets 0.9 for it, 0.1 for the rest. */
export async function startFakeClassifierWorker(): Promise<FakeClassifierWorker> {
  const fake = { calls: [] } as unknown as FakeClassifierWorker;
  const { server, url } = await listen((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname !== '/classify' || req.method !== 'POST') return send(res, 404, { error: 'not found' });
    const body = JSON.parse((req as IncomingMessage & { body: string }).body || '{}') as { model: { ref: string }; text: string; labels: string[] };
    fake.calls.push({ model: body.model?.ref, text: body.text, labels: body.labels });
    const t = body.text.toLowerCase();
    const scores: Record<string, number> = {};
    for (const l of body.labels) scores[l] = t.includes(l.replace(/_/g, ' ')) || t.includes(l) || (l === 'card_lost' && t.includes('lost')) ? 0.9 : 0.1;
    send(res, 200, { scores });
  });
  fake.fetch = fetch;
  return Object.assign(fake, { url, close: closer(server) });
}
