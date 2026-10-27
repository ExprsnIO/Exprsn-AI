import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { classifierModelDigest } from '../src/guardrails/classifier-worker.js';

/**
 * 1.7.0 (B-3806): a fake classifier worker that speaks the contract in docs/classifier-worker.md. It holds the files
 * it is sent in memory, checks each hash and the model digest as the real worker does, reads the labels from
 * `config.json`, and scores a text by keywords: a label whose keyword (by default the label itself) is in the text
 * gets `hit`, the others share the rest. A model with `problem_type: multi_label_classification` scores each label
 * by itself.
 */
export interface FakeClassifierWorker {
  url: string;
  token: string | null;
  /** Keywords per label (lower case); a label without an entry matches its own name. */
  keywords: Record<string, string[]>;
  hit: number;
  /** Every request: method and path, and for a classify call the texts. */
  calls: { method: string; path: string; texts?: string[]; authorization: string | null }[];
  /** The files held, by model digest (hex) then name. */
  models: Map<string, Map<string, Buffer>>;
  /** Models loaded since the last `forget`. */
  loaded: Set<string>;
  /** Answer the next classify call with this status. */
  failNext: number | null;
  /** Drops every file and loaded model, as a worker on a new machine would have. */
  forget(): void;
  close(): Promise<void>;
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function body(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const send = (res: ServerResponse, status: number, json: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(json));
};

export async function startFakeClassifierWorker(opts: { token?: string } = {}): Promise<FakeClassifierWorker> {
  const fake: FakeClassifierWorker = {
    url: '',
    token: opts.token ?? null,
    keywords: {},
    hit: 0.9,
    calls: [],
    models: new Map(),
    loaded: new Set(),
    failNext: null,
    forget() {
      fake.models.clear();
      fake.loaded.clear();
    },
    close: async () => undefined
  };
  const labelsOf = (files: Map<string, Buffer>): { labels: string[]; multiLabel: boolean; architecture: string | null } => {
    const cfg = JSON.parse((files.get('config.json') ?? Buffer.from('{}')).toString('utf8')) as { id2label?: Record<string, string>; problem_type?: string; architectures?: string[] };
    const map = cfg.id2label ?? {};
    return { labels: Object.keys(map).map(Number).sort((a, b) => a - b).map((i) => String(map[String(i)])), multiLabel: cfg.problem_type === 'multi_label_classification', architecture: cfg.architectures?.[0] ?? null };
  };
  const score = (text: string, labels: string[], multi: boolean): Record<string, number> => {
    const t = text.toLowerCase();
    const hits = labels.filter((l) => (fake.keywords[l] ?? [l.toLowerCase()]).some((k) => t.includes(k)));
    if (multi) return Object.fromEntries(labels.map((l) => [l, hits.includes(l) ? fake.hit : 0.05]));
    const top = hits[0] ?? labels[0]!;
    const rest = (1 - fake.hit) / Math.max(1, labels.length - 1);
    return Object.fromEntries(labels.map((l) => [l, l === top ? fake.hit : rest]));
  };
  const server: Server = createServer((req, res) => {
    void (async () => {
      const u = new URL(req.url ?? '/', 'http://x');
      const authorization = req.headers.authorization ?? null;
      const raw = await body(req);
      const call: FakeClassifierWorker['calls'][number] = { method: req.method ?? 'GET', path: u.pathname, authorization };
      fake.calls.push(call);
      if (fake.token && authorization !== `Bearer ${fake.token}`) return send(res, 401, { error: 'A bearer token is required.' });
      if (req.method === 'GET' && u.pathname === '/v1/info') return send(res, 200, { contract: 1, runtime: 'fake', device: 'cpu', models: [...fake.loaded].map((d) => `sha256:${d}`) });
      const file = /^\/v1\/models\/([a-f0-9]{64})\/files\/([^/]+)$/.exec(u.pathname);
      if (file && req.method === 'PUT') {
        const want = String(req.headers['x-sha256'] ?? '');
        if (sha256(raw) !== want) return send(res, 422, { error: `${decodeURIComponent(file[2]!)} does not match its sha256.` });
        const files = fake.models.get(file[1]!) ?? new Map<string, Buffer>();
        files.set(decodeURIComponent(file[2]!), raw);
        fake.models.set(file[1]!, files);
        return send(res, 200, { name: decodeURIComponent(file[2]!), sha256: want, bytes: raw.length });
      }
      const load = /^\/v1\/models\/([a-f0-9]{64})\/load$/.exec(u.pathname);
      if (load && req.method === 'POST') {
        const want = (JSON.parse(raw.toString('utf8')) as { files: { name: string; sha256: string }[] }).files;
        const files = fake.models.get(load[1]!) ?? new Map<string, Buffer>();
        const missing = want.filter((f) => !files.has(f.name) || sha256(files.get(f.name)!) !== f.sha256).map((f) => f.name);
        if (missing.length) return send(res, 404, { code: 'missing', error: `${missing.length} files are not held`, missing });
        const held = want.map((f) => ({ name: f.name, sha256: sha256(files.get(f.name)!) }));
        if (classifierModelDigest(held) !== `sha256:${load[1]}`) return send(res, 422, { error: 'The files do not add up to the model digest.' });
        const { labels, multiLabel, architecture } = labelsOf(files);
        if (!labels.length) return send(res, 422, { error: 'config.json names no labels.' });
        fake.loaded.add(load[1]!);
        return send(res, 200, { labels, multiLabel, maxLength: 512, architecture, device: 'cpu' });
      }
      if (req.method === 'POST' && u.pathname === '/v1/classify') {
        const b = JSON.parse(raw.toString('utf8')) as { model: string; texts: string[] };
        call.texts = b.texts;
        if (fake.failNext) {
          const status = fake.failNext;
          fake.failNext = null;
          return send(res, status, { error: 'The worker is out of memory.' });
        }
        const digest = b.model.replace(/^sha256:/, '');
        if (!fake.loaded.has(digest)) return send(res, 404, { code: 'missing', error: 'The model is not loaded.' });
        const { labels, multiLabel } = labelsOf(fake.models.get(digest)!);
        return send(res, 200, { results: b.texts.map((t) => ({ scores: score(t, labels, multiLabel) })) });
      }
      send(res, 404, { error: 'not found' });
    })().catch((err: unknown) => send(res, 500, { error: (err as Error).message }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return fake;
}
