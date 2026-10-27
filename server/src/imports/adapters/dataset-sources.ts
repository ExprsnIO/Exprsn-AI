import { normaliseLicence, rowBucket } from '../formats.js';
import type { Record_ } from '../tabular.js';
import { NeedsCredential, RateLimited, SourceError, type CatalogItem, type DatasetDetail, type DatasetResource, type SourceRecord } from '../types.js';
import { frequency, KAGGLE_LICENCES, opt } from './datasets.js';
import { join, str, stripHtml, uniq, type AdapterContext, type RepositoryAdapter } from './types.js';

/*
 * B-3804: the sources that came after the first fetch steps.
 *
 * - e-Stat (the Japanese government's statistics API, version 3.0) and the OGD platform (data.gov.in's API): each has
 *   a catalogue adapter and a paged fetch step. Both take the application's key in the query string, not a header.
 *   The key is read from the vault like any repository credential and added by `keyed` to requests for the
 *   repository's own host only; it is never part of a resource's address (which is stored with the import), and an
 *   error that would quote it has it struck out.
 * - Kaggle: the files of a dataset (`datasets/list/<owner>/<slug>`) and the dataset as one zip archive, downloaded
 *   through `datasets/download`, which redirects to a signed storage address the credential does not follow.
 *
 * The response shapes are the ones the services document; they are exercised against the local fakes only.
 */

const KEY_HEADER = 'x-import-key';

/** The repository's key, from the vault. */
async function keyOf(ctx: AdapterContext, what: string): Promise<string> {
  if (!ctx.repo.hasCredential) throw new NeedsCredential(`${what} needs an application key recorded for this repository.`);
  const key = (await ctx.access.auth())[KEY_HEADER];
  if (!key) throw new NeedsCredential(`${what} needs an application key recorded for this repository.`);
  return key;
}

/**
 * GET a JSON answer from the repository's own host with its key as the query parameter `param`. `check` reads the
 * answer's own error status; whatever it or the request throws has the key struck out, since these services quote
 * the request back in their errors.
 */
async function keyed<T>(ctx: AdapterContext, url: string, param: string, what: string, check: (body: T) => void, onBytes?: (n: number) => void): Promise<T> {
  const u = new URL(url);
  if (u.host.toLowerCase() !== new URL(ctx.repo.baseUrl).host.toLowerCase()) throw new SourceError(`${u.host} is not this repository's host; its key is not sent there.`);
  const key = await keyOf(ctx, what);
  u.searchParams.set(param, key);
  const strike = (m: string) => m.split(key).join('[key]').split(encodeURIComponent(key)).join('[key]');
  try {
    // The key is in the address, so no credential header goes with it.
    const { body } = await ctx.fetcher.text(u.toString(), ctx.access, { headers: { accept: 'application/json' }, signal: ctx.signal, auth: false });
    onBytes?.(Buffer.byteLength(body));
    let parsed: T;
    try {
      parsed = JSON.parse(body) as T;
    } catch {
      throw new SourceError(`${u.host} did not answer JSON.`);
    }
    check(parsed);
    return parsed;
  } catch (err) {
    if (err instanceof RateLimited) throw err;
    if (err instanceof NeedsCredential) throw new NeedsCredential(strike(err.message), err.status);
    if (err instanceof SourceError) throw new SourceError(strike(err.message), err.status);
    throw err;
  }
}

const dataset = (x: Omit<CatalogItem, 'kind' | 'gated' | 'sizeBytes'>): CatalogItem => ({ kind: 'dataset', gated: false, sizeBytes: null, ...x });
/** A value the services give as a string, a number, or `{ "$": … }`. */
const val = (v: unknown): string | null => (v && typeof v === 'object' ? str((v as Record_).$) : str(v));
const arr = <T>(v: T | T[] | null | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

// ---------- e-Stat (api.e-stat.go.jp, version 3.0) ----------

interface EstatResult {
  STATUS?: number | string;
  ERROR_MSG?: string;
}
interface EstatTable {
  '@id'?: string;
  STAT_NAME?: unknown;
  GOV_ORG?: unknown;
  STATISTICS_NAME?: unknown;
  TITLE?: unknown;
  CYCLE?: unknown;
  SURVEY_DATE?: unknown;
  OPEN_DATE?: unknown;
  MAIN_CATEGORY?: unknown;
  SUB_CATEGORY?: unknown;
  OVERALL_TOTAL_NUMBER?: unknown;
  UPDATED_DATE?: unknown;
}
interface EstatClass {
  '@id'?: string;
  '@name'?: string;
  CLASS?: { '@code'?: string; '@name'?: string } | { '@code'?: string; '@name'?: string }[];
}

const ESTAT_CYCLES: Record<string, string> = { 日次: 'daily', 週次: 'weekly', 月次: 'monthly', 四半期: 'quarterly', 半期: 'irregular', 年次: 'yearly', 年度次: 'yearly', daily: 'daily', weekly: 'weekly', monthly: 'monthly', quarterly: 'quarterly', yearly: 'yearly', annual: 'yearly', annually: 'yearly', 'fiscal year': 'yearly' };
const estatCycle = (v: unknown): string | null => {
  const c = val(v);
  return c ? (ESTAT_CYCLES[c] ?? ESTAT_CYCLES[c.toLowerCase()] ?? frequency(c)) : null;
};
const estatLang = (ctx: AdapterContext): string => ((opt(ctx, 'lang') ?? 'E').toUpperCase() === 'J' ? 'J' : 'E');

/** e-Stat answers 200 with a status of its own: 0 is a result, 1 no data, 100 and up an error. */
function estatCheck(r: EstatResult | undefined, what: string): void {
  const status = Number(r?.STATUS ?? NaN);
  if (status === 0 || status === 1 || status === 2) return;
  const msg = str(r?.ERROR_MSG, 300) ?? 'no result';
  if (status === 100) throw new NeedsCredential(`e-Stat refused the application id: ${msg}`, 403);
  throw new SourceError(`e-Stat did not answer ${what} (${Number.isNaN(status) ? 'no status' : status}): ${msg}`);
}

function estatItem(t: EstatTable, region: string | null, licence: string): CatalogItem | null {
  const id = str(t['@id'], 300);
  if (!id) return null;
  const survey = val(t.STAT_NAME);
  const title = [val(t.STATISTICS_NAME), val(t.TITLE)].filter(Boolean).join(': ');
  const publisher = val(t.GOV_ORG);
  const cats = uniq([val(t.MAIN_CATEGORY), val(t.SUB_CATEGORY)]);
  const freq = estatCycle(t.CYCLE);
  const rows = Number(val(t.OVERALL_TOTAL_NUMBER) ?? NaN);
  return dataset({
    itemId: id,
    name: (title || survey || id).slice(0, 400),
    publisher,
    description: [survey, val(t.SURVEY_DATE)].filter(Boolean).join(', ').slice(0, 2000) || null,
    classification: cats[0] ?? null,
    licence,
    formats: ['api'],
    updated: val(t.UPDATED_DATE) ?? val(t.OPEN_DATE),
    facets: { classification: cats, licence: [licence], format: ['api'], publisher: uniq([publisher]), updates: uniq([freq]), region: uniq([region]), rows: uniq([Number.isFinite(rows) ? rowBucket(rows) : null]) },
    data: { survey, rows: Number.isFinite(rows) ? rows : null }
  });
}

async function estatList(ctx: AdapterContext, query: string, limit: number, start: number): Promise<{ total: number; next: number | null; tables: EstatTable[] }> {
  const url = join(ctx.repo.baseUrl, `/json/getStatsList?lang=${estatLang(ctx)}&limit=${limit}&startPosition=${start}${query ? `&searchWord=${encodeURIComponent(query)}` : ''}`);
  const body = await keyed<{ GET_STATS_LIST?: { RESULT?: EstatResult; DATALIST_INF?: { NUMBER?: number | string; RESULT_INF?: { NEXT_KEY?: number | string }; TABLE_INF?: EstatTable | EstatTable[] } } }>(ctx, url, 'appId', 'e-Stat', (x) => estatCheck(x.GET_STATS_LIST?.RESULT, 'the list of tables'));
  const r = body.GET_STATS_LIST;
  const next = Number(r?.DATALIST_INF?.RESULT_INF?.NEXT_KEY ?? NaN);
  return { total: Number(r?.DATALIST_INF?.NUMBER ?? 0) || 0, next: Number.isFinite(next) && next > start ? next : null, tables: arr(r?.DATALIST_INF?.TABLE_INF) };
}

export const estatAdapter: RepositoryAdapter = {
  async probe(ctx) {
    const r = await estatList(ctx, opt(ctx, 'query') ?? '', 1, 1);
    return `Reachable; the application id works. ${r.total.toLocaleString('en-US')} tables.`;
  },
  async *harvest(ctx) {
    const licence = normaliseLicence(opt(ctx, 'licence'));
    const region = opt(ctx, 'region');
    let start: number | null = 1;
    let n = 0;
    while (start != null && n < ctx.maxItems) {
      const r: Awaited<ReturnType<typeof estatList>> = await estatList(ctx, opt(ctx, 'query') ?? '', Math.min(1000, ctx.maxItems - n), start);
      if (!r.tables.length) break;
      for (const t of r.tables) {
        const it = estatItem(t, region, licence);
        if (!it) continue;
        if (n++ >= ctx.maxItems) break;
        yield it;
      }
      start = r.next;
    }
  },
  async search(ctx, query, _kind, limit) {
    const licence = normaliseLicence(opt(ctx, 'licence'));
    return (await estatList(ctx, query, Math.min(100, limit), 1)).tables.map((t) => estatItem(t, opt(ctx, 'region'), licence)).filter((x): x is CatalogItem => !!x);
  }
};

export async function estatDescribe(ctx: AdapterContext, itemId: string): Promise<DatasetDetail> {
  if (!/^[0-9A-Za-z]{1,40}$/.test(itemId)) throw new SourceError('An e-Stat table is named by its statistics data id (digits).');
  const body = await keyed<{ GET_META_INFO?: { RESULT?: EstatResult; METADATA_INF?: { TABLE_INF?: EstatTable; CLASS_INF?: { CLASS_OBJ?: EstatClass | EstatClass[] } } } }>(ctx, join(ctx.repo.baseUrl, `/json/getMetaInfo?lang=${estatLang(ctx)}&statsDataId=${itemId}`), 'appId', 'e-Stat', (x) => estatCheck(x.GET_META_INFO?.RESULT, 'the table'));
  const t = body.GET_META_INFO?.METADATA_INF?.TABLE_INF ?? {};
  const classes = arr(body.GET_META_INFO?.METADATA_INF?.CLASS_INF?.CLASS_OBJ);
  const rows = Number(val(t.OVERALL_TOTAL_NUMBER) ?? NaN);
  const title = [val(t.STATISTICS_NAME), val(t.TITLE)].filter(Boolean).join(': ');
  return {
    itemId,
    name: (title || val(t.STAT_NAME) || itemId).slice(0, 400),
    publisher: val(t.GOV_ORG),
    description: stripHtml([val(t.STAT_NAME), val(t.SURVEY_DATE)].filter(Boolean).join(', ')),
    revision: val(t.UPDATED_DATE) ?? val(t.OPEN_DATE),
    licence: normaliseLicence(opt(ctx, 'licence')),
    licenceSource: 'the repository settings (e-Stat states its terms of use for the whole site, not per table)',
    updates: estatCycle(t.CYCLE),
    gated: false,
    configurations: [],
    splits: [],
    resources: [{ id: 'data', name: `e-Stat table ${itemId}`, format: 'api', size: null, access: 'estat', url: join(ctx.repo.baseUrl, `/json/getStatsData?statsDataId=${itemId}`), note: 'e-Stat API (getStatsData), read page by page' }],
    rows: Number.isFinite(rows) ? rows : null,
    sizeBytes: null,
    data: { classes: classes.map((c) => ({ id: c['@id'] ?? null, name: c['@name'] ?? null, values: arr(c.CLASS).length })) }
  };
}

const ESTAT_PAGE = 10_000;

export async function* estatRows(ctx: AdapterContext, r: DatasetResource, left: { n: number | null }, spend: (n: number) => void): AsyncGenerator<SourceRecord> {
  if (!r.url) throw new SourceError('The e-Stat table has no address.');
  // A class is a dimension of the table (`cat01`, `area`, `time`…): its name heads the column, its items name the codes.
  let classes: Map<string, { name: string; items: Map<string, string> }> | null = null;
  let start: number | null = 1;
  while (start != null) {
    const limit = Math.min(ESTAT_PAGE, left.n ?? ESTAT_PAGE);
    if (limit <= 0) return;
    const body: { GET_STATS_DATA?: { RESULT?: EstatResult; STATISTICAL_DATA?: { RESULT_INF?: { NEXT_KEY?: number | string }; CLASS_INF?: { CLASS_OBJ?: EstatClass | EstatClass[] }; DATA_INF?: { VALUE?: Record<string, unknown> | Record<string, unknown>[] } } } } = await keyed(ctx, `${r.url}&lang=${estatLang(ctx)}&startPosition=${start}&limit=${limit}&metaGetFlg=${classes ? 'N' : 'Y'}`, 'appId', 'e-Stat', (x) => estatCheck(x.GET_STATS_DATA?.RESULT, 'the data'), spend);
    const d = body.GET_STATS_DATA?.STATISTICAL_DATA;
    classes ??= new Map(arr(d?.CLASS_INF?.CLASS_OBJ).filter((c) => c['@id']).map((c) => [c['@id']!, { name: str(c['@name'], 200) ?? c['@id']!, items: new Map(arr(c.CLASS).filter((x) => x['@code'] != null).map((x) => [String(x['@code']), str(x['@name'], 400) ?? String(x['@code'])])) }]));
    const values = arr(d?.DATA_INF?.VALUE);
    for (const v of values) {
      const rec: Record_ = {};
      const codes: string[] = [];
      for (const [k, raw] of Object.entries(v)) {
        if (!k.startsWith('@')) continue;
        const id = k.slice(1);
        const code = raw == null ? '' : String(raw);
        const cls = classes.get(id);
        if (cls) {
          codes.push(code);
          rec[`${id}_code`] = code;
          rec[cls.name] = cls.items.get(code) ?? code;
        } else rec[id] = code;
      }
      const num = typeof v.$ === 'string' && /^[+-]?(\d+\.?\d*|\.\d+)$/.test(v.$.trim()) ? Number(v.$) : null;
      // A cell without a figure ("-", "…", "x") keeps what the table shows.
      rec.value = num ?? (v.$ == null ? null : v.$);
      yield { id: codes.length ? codes.join('.') : null, values: rec, part: r.name };
      if (left.n != null && --left.n <= 0) return;
    }
    const next = Number(d?.RESULT_INF?.NEXT_KEY ?? NaN);
    start = values.length && Number.isFinite(next) && next > start ? next : null;
  }
}

// ---------- the OGD platform (api.data.gov.in) ----------

interface OgdResource {
  index_name?: string;
  title?: string;
  desc?: string;
  org?: string | string[];
  org_type?: string;
  sector?: string | string[];
  source?: string;
  catalog_uuid?: string;
  created?: number | string;
  updated?: number | string;
  created_date?: string;
  updated_date?: string;
  total?: number | string;
  count?: number | string;
  field?: { id?: string; name?: string; type?: string }[];
  records?: Record_[];
  status?: string;
  message?: string;
  error?: string;
}

const ogdStamp = (v: unknown): string | null => {
  if (typeof v === 'number' || (typeof v === 'string' && /^\d{9,13}$/.test(v))) {
    const n = Number(v);
    const d = new Date(n < 1e12 ? n * 1000 : n);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return str(v, 60);
};

function ogdFail(body: { status?: string; message?: string; error?: string }, what: string): void {
  if (body.status && String(body.status).toLowerCase() === 'error') {
    const msg = str(body.message ?? body.error, 300) ?? 'an error';
    if (/key/i.test(msg)) throw new NeedsCredential(`The OGD platform refused the API key: ${msg}`, 403);
    throw new SourceError(`The OGD platform did not answer ${what}: ${msg}`);
  }
}

function ogdItem(r: OgdResource, region: string | null, licence: string): CatalogItem | null {
  const id = str(r.index_name, 300);
  if (!id) return null;
  const orgs = uniq(arr(r.org));
  const sectors = uniq(arr(r.sector));
  return dataset({
    itemId: id,
    name: (str(r.title) ?? id).slice(0, 400),
    publisher: orgs[0] ?? null,
    description: stripHtml(r.desc),
    classification: sectors[0] ?? null,
    licence,
    formats: ['api'],
    updated: ogdStamp(r.updated_date ?? r.updated),
    facets: { classification: sectors, licence: [licence], format: ['api'], publisher: orgs, region: uniq([region]) },
    data: { source: str(r.source), catalogue: str(r.catalog_uuid), fields: (r.field ?? []).slice(0, 100).map((f) => f.name ?? f.id ?? null) }
  });
}

async function ogdList(ctx: AdapterContext, limit: number, offset: number): Promise<{ total: number; records: OgdResource[] }> {
  const path = opt(ctx, 'listPath') ?? '/lists';
  const filter = opt(ctx, 'listQuery') ?? 'filters[active]=1';
  const body = await keyed<{ total?: number | string; records?: OgdResource[]; status?: string; message?: string }>(ctx, join(ctx.repo.baseUrl, `${path}?format=json&offset=${offset}&limit=${limit}${filter ? `&${filter}` : ''}`), 'api-key', 'The OGD platform', (x) => ogdFail(x, 'the list of resources'));
  if (!Array.isArray(body.records)) throw new SourceError('The OGD platform did not answer a list of resources.');
  return { total: Number(body.total ?? 0) || 0, records: body.records };
}

export const ogdAdapter: RepositoryAdapter = {
  async probe(ctx) {
    const r = await ogdList(ctx, 1, 0);
    return `Reachable; the API key works. ${r.total.toLocaleString('en-US')} resources.`;
  },
  async *harvest(ctx) {
    const licence = normaliseLicence(opt(ctx, 'licence'));
    const region = opt(ctx, 'region');
    let offset = 0;
    let n = 0;
    while (n < ctx.maxItems) {
      const r = await ogdList(ctx, Math.min(100, ctx.maxItems - n), offset);
      if (!r.records.length) break;
      for (const x of r.records) {
        const it = ogdItem(x, region, licence);
        if (!it) continue;
        if (n++ >= ctx.maxItems) break;
        yield it;
      }
      offset += r.records.length;
      if (r.total && offset >= r.total) break;
    }
  }
};

const ogdPage = (ctx: AdapterContext): number => Math.max(10, Math.min(10_000, Number(ctx.repo.options.pageSize ?? 1000) || 1000));

export async function ogdDescribe(ctx: AdapterContext, itemId: string): Promise<DatasetDetail> {
  if (!/^[0-9A-Za-z_-]{1,120}$/.test(itemId)) throw new SourceError('An OGD resource is named by its resource id.');
  const url = join(ctx.repo.baseUrl, `/resource/${itemId}?format=json`);
  const body = await keyed<OgdResource>(ctx, `${url}&offset=0&limit=1`, 'api-key', 'The OGD platform', (x) => ogdFail(x, 'the resource'));
  const total = Number(body.total ?? NaN);
  const orgs = uniq(arr(body.org));
  return {
    itemId,
    name: (str(body.title) ?? itemId).slice(0, 400),
    publisher: orgs[0] ?? null,
    description: stripHtml(body.desc),
    revision: ogdStamp(body.updated_date ?? body.updated),
    licence: normaliseLicence(opt(ctx, 'licence')),
    licenceSource: 'the repository settings (the platform states one licence for the whole site, not per resource)',
    updates: frequency(opt(ctx, 'updates')),
    gated: false,
    configurations: [],
    splits: [],
    resources: [{ id: 'data', name: `OGD resource ${itemId}`, format: 'api', size: null, access: 'ogd', url, note: 'OGD platform API, read page by page' }],
    rows: Number.isFinite(total) ? total : null,
    sizeBytes: null,
    data: { fields: (body.field ?? []).slice(0, 200).map((f) => ({ id: f.id ?? null, name: f.name ?? null, type: f.type ?? null })), sectors: uniq(arr(body.sector)) }
  };
}

export async function* ogdRows(ctx: AdapterContext, r: DatasetResource, left: { n: number | null }, spend: (n: number) => void): AsyncGenerator<SourceRecord> {
  if (!r.url) throw new SourceError('The OGD resource has no address.');
  const size = ogdPage(ctx);
  let offset = 0;
  for (;;) {
    const limit = Math.min(size, left.n ?? size);
    if (limit <= 0) return;
    const body = await keyed<OgdResource>(ctx, `${r.url}&offset=${offset}&limit=${limit}`, 'api-key', 'The OGD platform', (x) => ogdFail(x, 'the rows'), spend);
    if (!Array.isArray(body.records)) throw new SourceError('The OGD platform did not answer rows.');
    for (const values of body.records) {
      yield { id: null, values, part: r.name };
      if (left.n != null && --left.n <= 0) return;
    }
    offset += body.records.length;
    const total = Number(body.total ?? NaN);
    // The platform may answer fewer rows than asked for (a key's own page limit): the end is an empty page or the total.
    if (!body.records.length || (Number.isFinite(total) && offset >= total)) return;
  }
}

// ---------- Kaggle ----------

interface KaggleView {
  ref?: string;
  title?: string;
  subtitle?: string;
  description?: string;
  licenseName?: string;
  totalBytes?: number;
  lastUpdated?: string;
  ownerName?: string;
  creatorName?: string;
  currentVersionNumber?: number;
  isPrivate?: boolean;
}

/** One dataset of Kaggle: its files, and the whole dataset as the archive Kaggle packs. `file` builds a resource. */
export async function kaggleDescribe(ctx: AdapterContext, itemId: string, file: (id: string, name: string, format: string | null, size: number | null, url: string | null) => DatasetResource): Promise<DatasetDetail> {
  const m = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/.exec(itemId);
  if (!m) throw new SourceError('A Kaggle dataset is named owner/dataset.');
  if (!ctx.repo.hasCredential) throw new NeedsCredential('Kaggle needs an API token (username:key from kaggle.json) recorded for this repository.');
  const ref = `${encodeURIComponent(m[1]!)}/${encodeURIComponent(m[2]!)}`;
  const { body: d } = await ctx.fetcher.json<KaggleView>(join(ctx.repo.baseUrl, `/api/v1/datasets/view/${ref}`), ctx.access, { signal: ctx.signal });
  let files: { name?: string; totalBytes?: number }[] = [];
  try {
    const { body } = await ctx.fetcher.json<{ datasetFiles?: typeof files; files?: typeof files }>(join(ctx.repo.baseUrl, `/api/v1/datasets/list/${ref}`), ctx.access, { signal: ctx.signal });
    files = body.datasetFiles ?? body.files ?? [];
  } catch (err) {
    // Without the list of files the dataset can still be read as its archive.
    if (!(err instanceof SourceError) || err instanceof NeedsCredential) throw err;
  }
  const download = join(ctx.repo.baseUrl, `/api/v1/datasets/download/${ref}`);
  const resources = files.filter((f) => f.name).slice(0, 199).map((f) => file(f.name!, f.name!, null, typeof f.totalBytes === 'number' ? f.totalBytes : null, `${download}/${f.name!.split('/').map(encodeURIComponent).join('/')}`));
  const archive = file('archive', `${m[2]}.zip`, 'zip', typeof d.totalBytes === 'number' ? d.totalBytes : null, download);
  resources.push({ ...archive, note: 'The whole dataset as one zip archive: every member this import reads, in the archive\'s order' });
  return {
    itemId,
    name: (d.title ?? itemId).slice(0, 400),
    publisher: d.ownerName ?? d.creatorName ?? m[1]!,
    description: stripHtml(d.description ?? d.subtitle),
    revision: d.currentVersionNumber != null ? `version ${d.currentVersionNumber}` : (d.lastUpdated ?? null),
    licence: d.licenseName ? (KAGGLE_LICENCES[d.licenseName] ?? normaliseLicence(d.licenseName)) : 'unknown',
    licenceSource: 'the dataset metadata on Kaggle',
    updates: null,
    gated: false,
    configurations: [],
    splits: [],
    resources,
    rows: null,
    sizeBytes: typeof d.totalBytes === 'number' ? d.totalBytes : null,
    data: { private: !!d.isPrivate }
  };
}
