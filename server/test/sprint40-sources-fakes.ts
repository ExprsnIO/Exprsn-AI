import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { zipOf, type Fake } from './sprint30-imports-fakes.js';

/*
 * Sprint 40 (B-3804), the later sources: just enough of Kaggle's API (a dataset's metadata, its files, downloads that
 * redirect to a storage address), of the e-Stat API 3.0 (getStatsList, getMetaInfo, getStatsData with NEXT_KEY paging)
 * and of the OGD platform's API (the resource list and paged resource rows) to drive a dataset import. Each listens on
 * 127.0.0.1 and records what it was sent, so a test can show where a credential went. The shapes follow the services'
 * documentation; nothing here was compared with a live answer.
 */

async function listen(handler: (req: IncomingMessage, res: ServerResponse, u: URL, base: string) => unknown): Promise<{ url: string; close(): Promise<void> }> {
  let base = '';
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res, new URL(req.url ?? '/', 'http://x'), base)).catch((err: Error) => {
      if (!res.headersSent) res.statusCode = 500;
      res.end(err.message);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: base,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      })
  };
}

const send = (res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(data));
};

// ---------- Kaggle ----------

export interface FakeKaggle extends Fake {
  /** `username:key`, as kaggle.json holds it. */
  credential: string;
  datasets: Map<string, { title: string; licenceName: string; version: number; files: Map<string, Buffer | string> }>;
  /** Files Kaggle serves packed although they are listed by their own name. */
  packed: Set<string>;
  /** Every request: its path, and whether it carried the credential. */
  seen: { path: string; auth: boolean }[];
}

export async function startFakeKaggle(): Promise<FakeKaggle> {
  const fake = { credential: 'northwind:0123456789abcdef', datasets: new Map(), packed: new Set(), seen: [] } as unknown as FakeKaggle;
  const { url, close } = await listen((req, res, u) => {
    const authed = req.headers.authorization === `Basic ${Buffer.from(fake.credential).toString('base64')}`;
    fake.seen.push({ path: u.pathname, auth: !!req.headers.authorization });
    const p = decodeURIComponent(u.pathname);
    // The signed storage address a download redirects to: another service, which must not see the credential.
    const stored = /^\/storage\/(.+?)\/(.+?)\/(.+)$/.exec(p);
    if (stored) {
      if (req.headers.authorization) return send(res, 400, { error: 'the storage host must not receive the credential' });
      const d = fake.datasets.get(`${stored[1]}/${stored[2]}`);
      if (!d) return send(res, 404, {});
      const name = stored[3]!;
      const body = name === '__archive__' ? zipOf([...d.files].map(([n, data]) => ({ name: n, data }))) : fake.packed.has(name) ? zipOf([{ name, data: d.files.get(name)! }]) : d.files.get(name);
      if (body == null) return send(res, 404, {});
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(body);
    }
    if (!p.startsWith('/api/v1/datasets/')) return send(res, 404, { message: 'not found' });
    if (!authed) return send(res, 401, { message: 'Unauthenticated' });
    const m = /^\/api\/v1\/datasets\/(view|list|download)\/([^/]+)\/([^/]+)(?:\/(.+))?$/.exec(p);
    const d = m ? fake.datasets.get(`${m[2]}/${m[3]}`) : null;
    if (!m || !d) return send(res, 404, { message: 'Not found' });
    const ref = `${m[2]}/${m[3]}`;
    const bytes = [...d.files.values()].reduce((a, f) => a + Buffer.byteLength(f), 0);
    if (m[1] === 'view') return send(res, 200, { ref, title: d.title, subtitle: `${d.title} from ${m[2]}`, licenseName: d.licenceName, totalBytes: bytes, ownerName: m[2], currentVersionNumber: d.version, lastUpdated: '2026-09-01T00:00:00.000Z', isPrivate: false });
    if (m[1] === 'list') return send(res, 200, { datasetFiles: [...d.files].map(([name, f]) => ({ name, totalBytes: Buffer.byteLength(f), creationDate: '2026-09-01T00:00:00.000Z' })) });
    if (m[4] && !d.files.has(m[4])) return send(res, 404, { message: 'No such file' });
    res.writeHead(302, { location: `/storage/${ref}/${m[4] ? encodeURIComponent(m[4]) : '__archive__'}?X-Goog-Signature=abc` });
    return res.end();
  });
  return Object.assign(fake, { url, close });
}

// ---------- e-Stat (API 3.0) ----------

export interface FakeEstat extends Fake {
  appId: string;
  tables: Map<string, { title: string; survey: string; org: string; cycle: string; updated: string; category: string; classes: { id: string; name: string; items: [string, string][] }[]; values: Record<string, string>[] }>;
  /** Every request's path and query, and whether it carried a credential header. */
  seen: { path: string; query: string; header: boolean }[];
}

export async function startFakeEstat(): Promise<FakeEstat> {
  const fake = { appId: 'estat-app-id-9f3c', tables: new Map(), seen: [] } as unknown as FakeEstat;
  const { url, close } = await listen((req, res, u) => {
    fake.seen.push({ path: u.pathname, query: u.search, header: !!(req.headers.authorization ?? req.headers['x-import-key']) });
    const call = /^\/rest\/3\.0\/app\/json\/(getStatsList|getMetaInfo|getStatsData)$/.exec(u.pathname)?.[1];
    if (!call) return send(res, 404, {});
    const root = call === 'getStatsList' ? 'GET_STATS_LIST' : call === 'getMetaInfo' ? 'GET_META_INFO' : 'GET_STATS_DATA';
    // e-Stat answers 200 with its own status; a wrong id quotes the id it was sent.
    if (u.searchParams.get('appId') !== fake.appId) return send(res, 200, { [root]: { RESULT: { STATUS: 100, ERROR_MSG: `The application id is not valid. (appId=${u.searchParams.get('appId') ?? ''})` } } });
    const info = (id: string, t: NonNullable<ReturnType<FakeEstat['tables']['get']>>) => ({ '@id': id, STAT_NAME: { '@code': '00200573', $: t.survey }, GOV_ORG: { '@code': '00200', $: t.org }, STATISTICS_NAME: t.survey, TITLE: { '@no': '1', $: t.title }, CYCLE: t.cycle, SURVEY_DATE: '202601-202608', OPEN_DATE: '2026-09-19', MAIN_CATEGORY: { '@code': '07', $: t.category }, OVERALL_TOTAL_NUMBER: t.values.length, UPDATED_DATE: t.updated });
    const classInf = (t: NonNullable<ReturnType<FakeEstat['tables']['get']>>) => ({ CLASS_OBJ: t.classes.map((c) => ({ '@id': c.id, '@name': c.name, CLASS: c.items.length === 1 ? { '@code': c.items[0]![0], '@name': c.items[0]![1], '@level': '1' } : c.items.map(([code, name]) => ({ '@code': code, '@name': name, '@level': '1' })) })) });
    if (call === 'getStatsList') {
      const q = (u.searchParams.get('searchWord') ?? '').toLowerCase();
      const all = [...fake.tables].filter(([, t]) => !q || t.title.toLowerCase().includes(q));
      const start = Number(u.searchParams.get('startPosition') ?? 1);
      const limit = Number(u.searchParams.get('limit') ?? 100);
      const page = all.slice(start - 1, start - 1 + limit);
      const next = start - 1 + limit < all.length ? { NEXT_KEY: start + limit } : {};
      return send(res, 200, { GET_STATS_LIST: { RESULT: { STATUS: 0, ERROR_MSG: '正常に終了しました。' }, DATALIST_INF: { NUMBER: all.length, RESULT_INF: { FROM_NUMBER: start, TO_NUMBER: start + page.length - 1, ...next }, TABLE_INF: page.length === 1 ? info(...page[0]!) : page.map((x) => info(...x)) } } });
    }
    const id = u.searchParams.get('statsDataId') ?? '';
    const t = fake.tables.get(id);
    if (!t) return send(res, 200, { [root]: { RESULT: { STATUS: 101, ERROR_MSG: 'The statistics data id does not exist.' } } });
    if (call === 'getMetaInfo') return send(res, 200, { GET_META_INFO: { RESULT: { STATUS: 0 }, METADATA_INF: { TABLE_INF: info(id, t), CLASS_INF: classInf(t) } } });
    const start = Number(u.searchParams.get('startPosition') ?? 1);
    const limit = Number(u.searchParams.get('limit') ?? 100_000);
    const page = t.values.slice(start - 1, start - 1 + limit);
    const next = start - 1 + limit < t.values.length ? { NEXT_KEY: start + limit } : {};
    return send(res, 200, { GET_STATS_DATA: { RESULT: { STATUS: 0 }, STATISTICAL_DATA: { RESULT_INF: { TOTAL_NUMBER: t.values.length, FROM_NUMBER: start, TO_NUMBER: start + page.length - 1, ...next }, TABLE_INF: info(id, t), ...(u.searchParams.get('metaGetFlg') === 'N' ? {} : { CLASS_INF: classInf(t) }), DATA_INF: { VALUE: page } } } });
  });
  return Object.assign(fake, { url, close });
}

// ---------- the OGD platform (api.data.gov.in) ----------

export interface FakeOgd extends Fake {
  key: string;
  /** The most rows the platform answers in one page, whatever is asked for. */
  pageCap: number;
  resources: Map<string, { title: string; desc: string; org: string[]; sector: string[]; updated: number; records: Record<string, unknown>[] }>;
  seen: { path: string; query: string; header: boolean }[];
}

export async function startFakeOgd(): Promise<FakeOgd> {
  const fake = { key: 'ogd-key-579b464d', pageCap: 1000, resources: new Map(), seen: [] } as unknown as FakeOgd;
  const { url, close } = await listen((req, res, u) => {
    fake.seen.push({ path: u.pathname, query: u.search, header: !!(req.headers.authorization ?? req.headers['x-import-key']) });
    if (u.searchParams.get('api-key') !== fake.key) return send(res, 403, { status: 'error', message: `Key not authorised: ${u.searchParams.get('api-key') ?? ''}` });
    const offset = Number(u.searchParams.get('offset') ?? 0);
    const limit = Math.min(fake.pageCap, Number(u.searchParams.get('limit') ?? 10));
    const head = (id: string, r: NonNullable<ReturnType<FakeOgd['resources']['get']>>) => ({ index_name: id, title: r.title, desc: r.desc, org_type: 'Central', org: r.org, sector: r.sector, source: 'data.gov.in', catalog_uuid: `cat-${id}`, created: r.updated - 86_400, updated: r.updated, field: Object.keys(r.records[0] ?? {}).map((k) => ({ id: k, name: k, type: 'keyword' })) });
    if (u.pathname === '/lists') {
      const all = [...fake.resources];
      return send(res, 200, { total: all.length, count: Math.min(limit, all.length - offset), limit: String(limit), offset: String(offset), records: all.slice(offset, offset + limit).map(([id, r]) => head(id, r)) });
    }
    const m = /^\/resource\/([^/]+)$/.exec(u.pathname);
    const r = m ? fake.resources.get(m[1]!) : null;
    if (!m || !r) return send(res, 404, { status: 'error', message: 'Resource id does not exist' });
    const page = r.records.slice(offset, offset + limit);
    return send(res, 200, { ...head(m[1]!, r), updated_date: new Date(r.updated * 1000).toISOString(), active: '1', status: 'ok', message: 'Resource lists', total: r.records.length, count: page.length, limit: String(limit), offset: String(offset), records: page });
  });
  return Object.assign(fake, { url, close });
}
