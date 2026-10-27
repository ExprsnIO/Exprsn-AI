import { normaliseLicence } from '../formats.js';
import { anyRecords, type ContainerLimits } from '../containers.js';
import { fileKind, type Record_ } from '../tabular.js';
import { NeedsCredential, SourceError, type DatasetDetail, type DatasetResource, type RepoType, type SourceRecord } from '../types.js';
import { ckanBase, fileType, flowsFromXml, frequency, graphOf, isType, literal, literals, lower, opt, prop, sdmxStructure, type CkanPackage, type Node } from './datasets.js';
import { estatDescribe, estatRows, kaggleDescribe, ogdDescribe, ogdRows } from './dataset-sources.js';
import { join, str, stripHtml, type AdapterContext } from './types.js';

/*
 * B-3804: the fetch steps of the dataset repository types. `describe` reads one dataset from the source now (its
 * configurations, splits and resources, the licence and the revision the import is pinned to); `datasetRows` reads
 * the selected rows, page by page where the source has an API and as a parsed stream where it publishes files:
 *
 * - Hugging Face compatible hub: configurations and splits from the dataset viewer, rows from its `/rows` (100 a page).
 *   A gated dataset is not read through the viewer, which is a service of its own and never receives the repository's
 *   token: its rows come from the hub itself, as the Parquet files the hub lists at `/api/datasets/<id>/parquet`,
 *   requested with the token. The hub answers such an address with a redirect to its own resolve address and that
 *   one with a redirect to its CDN: the token goes along the first (same origin) and not along the second.
 * - CKAN: resources from `package_show`; a resource in the datastore through `datastore_search` (limit and offset),
 *   a Socrata resource through its `$limit` and `$offset`, any other CSV, TSV, JSON or JSON Lines resource as a file.
 * - SDMX: the dataflow's data as SDMX-CSV in one streamed answer (SDMX 2.1 has no offset paging; `startPeriod` and
 *   `endPeriod` narrow it).
 * - DCAT-AP, OpenML, InvenioRDM: the dataset's distributions or files.
 * - Kaggle, e-Stat and the OGD platform: `dataset-sources.ts`.
 *
 * A file is CSV, TSV, JSON, JSON Lines or ARFF, read as a stream, or a zip archive, an xlsx workbook, a Parquet file
 * or an XML document, read whole within IMPORT_ARCHIVE_MAX_BYTES (`containers.ts`). Every request goes through the
 * import fetcher, so a resource on a host that is not on the repository's allow-list is refused there.
 */

export interface RowBudget {
  /** Bytes read from the source so far, and the most this import may read. */
  used: number;
  max: number;
}

export interface RowsOptions {
  config: string | null;
  splits: string[];
  resources: DatasetResource[];
  startPeriod?: string | null;
  endPeriod?: string | null;
  /** Stop after this many rows (a sample in publication order); null for every row. */
  limit: number | null;
  /** The dataset is gated: a hub's rows are read from the hub with the token, not from the dataset viewer. */
  gated?: boolean;
  budget: RowBudget;
}

const spend = (b: RowBudget, n: number): void => {
  b.used += n;
  if (b.used > b.max) throw new SourceError(`The source sent more than the ${b.max.toLocaleString('en-US')} bytes this import may fetch. Give a row limit to import a sample.`);
};

const UNREAD = 'files are not read; CSV, TSV, JSON, JSON Lines, ARFF, XML, xlsx, Parquet and zip archives of them are';

/** The caps on a file that is read whole, from the settings (the defaults where a caller has no services). */
const limits = (ctx: AdapterContext): ContainerLimits => {
  const cfg = (ctx.s as AdapterContext['s'] | null)?.cfg;
  return { archiveBytes: cfg?.IMPORT_ARCHIVE_MAX_BYTES ?? 256 * 1024 * 1024, unpackedBytes: cfg?.IMPORT_ARCHIVE_MAX_UNPACKED_BYTES ?? 1024 * 1024 * 1024 };
};

function fileResource(id: string, name: string, format: string | null, size: number | null, url: string | null): DatasetResource {
  const kind = url ? fileKind(format, url) ?? fileKind(format, name) : null;
  const fmt = (kind?.kind ?? format ?? 'unknown').toLowerCase().slice(0, 40);
  return { id: id.slice(0, 300), name: name.slice(0, 300), format: fmt, size, access: kind ? 'file' : 'unsupported', url, note: kind ? null : url ? `${fmt} ${UNREAD}.` : 'The resource has no download address.' };
}

/** A page of an API as parsed JSON, its size counted against the import's budget. */
async function page<T>(ctx: AdapterContext, url: string, budget: RowBudget, auth = true): Promise<T> {
  const { body } = await ctx.fetcher.text(url, ctx.access, { headers: { accept: 'application/json' }, signal: ctx.signal, auth });
  spend(budget, Buffer.byteLength(body));
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new SourceError(`${new URL(url).host} did not answer JSON.`);
  }
}

async function* fileRows(ctx: AdapterContext, r: DatasetResource, budget: RowBudget, headers: Record<string, string> = {}, authOwnRedirects = 0, wanted?: (contentType: string) => boolean): AsyncGenerator<SourceRecord> {
  const kind = fileKind(r.format, r.url) ?? fileKind(r.format, r.name);
  if (!kind || !r.url) throw new SourceError(`${r.name}: ${r.note ?? `${r.format} ${UNREAD}.`}`);
  const res = await ctx.fetcher.request(r.url, ctx.access, { headers, signal: ctx.signal, authOwnRedirects });
  if (res.status < 200 || res.status >= 300 || !res.body) {
    const host = new URL(res.url).host;
    await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) throw new NeedsCredential(`${host} refused ${r.name} (${res.status}).`, res.status);
    throw new SourceError(`${host} answered ${res.status} for ${r.name}.`, res.status);
  }
  // The caller asked for one format and the source may answer another with 200 (SDMX): that is a 406 to the caller.
  if (wanted && !wanted((res.headers.get('content-type') ?? '').toLowerCase())) {
    await res.body[Symbol.asyncIterator]().return?.().catch(() => undefined);
    throw new SourceError(`${new URL(res.url).host} answered ${res.headers.get('content-type') ?? 'no content type'} for ${r.name}.`, 406);
  }
  const before = budget.used;
  for await (const rec of anyRecords(res.body, kind.kind, { maxBytes: Math.max(0, budget.max - before), gzip: kind.gzip, onBytes: (b) => (budget.used = before + b), limits: limits(ctx) })) yield { id: null, values: rec.values, part: rec.part ? `${r.name}: ${rec.part}` : r.name };
}

// ---------- Hugging Face compatible hub ----------

interface HfFeature {
  name: string;
  type?: { _type?: string; names?: string[]; dtype?: string };
}

const hfServer = (ctx: AdapterContext): string => opt(ctx, 'datasetsServer') ?? (new URL(ctx.repo.baseUrl).hostname === 'huggingface.co' ? 'https://datasets-server.huggingface.co' : join(ctx.repo.baseUrl, '/datasets-server'));

async function hfDescribe(ctx: AdapterContext, itemId: string): Promise<DatasetDetail> {
  const { body: info } = await ctx.fetcher.json<{ id?: string; sha?: string; gated?: boolean | string; author?: string; lastModified?: string; description?: string; cardData?: { license?: string | string[]; pretty_name?: string }; tags?: string[] }>(join(ctx.repo.baseUrl, `/api/datasets/${itemId.split('/').map(encodeURIComponent).join('/')}`), ctx.access, { signal: ctx.signal });
  const lic = info.cardData?.license ?? info.tags?.find((t) => t.startsWith('license:'))?.slice(8) ?? null;
  const base = {
    itemId,
    name: (info.cardData?.pretty_name ?? info.id ?? itemId).slice(0, 400),
    publisher: info.author ?? itemId.split('/')[0] ?? null,
    description: stripHtml(info.description),
    revision: info.sha ?? null,
    licence: normaliseLicence(Array.isArray(lic) ? lic[0] : lic),
    licenceSource: 'the dataset card at the pinned revision',
    updates: null,
    resources: []
  };
  if (info.gated) {
    // A gated dataset: what the hub itself lists for the recorded token, or nothing when the token may not read it.
    let files: HubParquet | null = null;
    try {
      files = await hubParquet(ctx, itemId);
    } catch (err) {
      if (!(err instanceof NeedsCredential) && !(err instanceof SourceError && (err.status === 404 || err.status === 501))) throw err;
    }
    const splits = Object.entries(files ?? {}).flatMap(([config, sp]) => Object.keys(sp).map((id) => ({ config, id, rows: null, bytes: null })));
    return { ...base, gated: true, access: splits.length ? 'granted' : 'gated', configurations: [...new Set(splits.map((x) => x.config))].map((c) => ({ id: c, name: c })), splits, rows: null, sizeBytes: null, data: { lastModified: info.lastModified ?? null, read: 'the hub\'s Parquet files, with the recorded token' } };
  }
  // The dataset viewer is a service of its own: the repository's token stays with the hub.
  const server = hfServer(ctx);
  const q = `dataset=${encodeURIComponent(itemId)}`;
  const { body: sp } = await ctx.fetcher.json<{ splits?: { config: string; split: string }[] }>(`${server}/splits?${q}`, ctx.access, { signal: ctx.signal, auth: false });
  let sizes: { config: string; split: string; num_rows?: number; num_bytes_parquet_files?: number }[] = [];
  let total: { num_rows?: number; num_bytes_original_files?: number; num_bytes_parquet_files?: number } = {};
  try {
    const { body } = await ctx.fetcher.json<{ size?: { dataset?: typeof total; splits?: typeof sizes } }>(`${server}/size?${q}`, ctx.access, { signal: ctx.signal, auth: false });
    sizes = body.size?.splits ?? [];
    total = body.size?.dataset ?? {};
  } catch (err) {
    // Sizes are optional (the viewer has none for some datasets): the splits stand without row counts.
    if (!(err instanceof SourceError) || err instanceof NeedsCredential) throw err;
  }
  const splits = (sp.splits ?? []).map((x) => {
    const z = sizes.find((y) => y.config === x.config && y.split === x.split);
    return { config: x.config, id: x.split, rows: z?.num_rows ?? null, bytes: z?.num_bytes_parquet_files ?? null };
  });
  const configs = [...new Set(splits.map((x) => x.config))];
  return { ...base, gated: false, access: 'open', configurations: configs.map((c) => ({ id: c, name: c })), splits, rows: total.num_rows ?? null, sizeBytes: total.num_bytes_original_files ?? total.num_bytes_parquet_files ?? null, data: { lastModified: info.lastModified ?? null } };
}

/** The Parquet files the hub lists for a dataset, by configuration and split. Requested with the token. */
type HubParquet = Record<string, Record<string, string[]>>;

async function hubParquet(ctx: AdapterContext, itemId: string): Promise<HubParquet> {
  const { body } = await ctx.fetcher.json<unknown>(join(ctx.repo.baseUrl, `/api/datasets/${itemId.split('/').map(encodeURIComponent).join('/')}/parquet`), ctx.access, { signal: ctx.signal });
  const host = new URL(ctx.repo.baseUrl).host;
  const out: HubParquet = {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) return out;
  for (const [config, sp] of Object.entries(body as Record_)) {
    if (!sp || typeof sp !== 'object' || Array.isArray(sp)) continue;
    for (const [split, urls] of Object.entries(sp as Record_)) {
      // Only addresses on the hub itself: that is where the token goes.
      const mine = (Array.isArray(urls) ? urls : []).filter((u): u is string => typeof u === 'string' && URL.canParse(u) && new URL(u).host === host);
      if (mine.length) (out[config] ??= {})[split] = mine.slice(0, 2000);
    }
  }
  return out;
}

async function* hubParquetRows(ctx: AdapterContext, itemId: string, o: RowsOptions): AsyncGenerator<SourceRecord> {
  const config = o.config ?? 'default';
  const files = (await hubParquet(ctx, itemId))[config];
  if (!files) throw new NeedsCredential(`The hub lists no Parquet files of ${itemId} (${config}) for the recorded token. Accept the dataset's terms on the hub with the token's account.`);
  for (const split of o.splits) {
    let n = 0;
    for (const [i, url] of (files[split] ?? []).entries()) {
      for await (const rec of fileRows(ctx, { id: `${split}/${i}`, name: split, format: 'parquet', size: null, access: 'file', url, note: null }, o.budget, {}, 1)) yield { id: `${config}/${split}/${n++}`, values: rec.values, part: split };
    }
  }
}

async function* hfRows(ctx: AdapterContext, itemId: string, o: RowsOptions): AsyncGenerator<SourceRecord> {
  if (o.gated) {
    let left = o.limit;
    for await (const rec of hubParquetRows(ctx, itemId, o)) {
      yield rec;
      if (left != null && --left <= 0) return;
    }
    return;
  }
  const server = hfServer(ctx);
  let left = o.limit;
  for (const split of o.splits) {
    let offset = 0;
    for (;;) {
      const length = Math.min(100, left ?? 100);
      if (length <= 0) return;
      const body = await page<{ features?: HfFeature[]; rows?: { row_idx: number; row: Record_ }[]; num_rows_total?: number }>(ctx, `${server}/rows?dataset=${encodeURIComponent(itemId)}&config=${encodeURIComponent(o.config ?? 'default')}&split=${encodeURIComponent(split)}&offset=${offset}&length=${length}`, o.budget, false);
      const rows = body.rows ?? [];
      // A class label arrives as its index; the feature names say what it stands for.
      const classes = new Map((body.features ?? []).filter((f) => f.type?._type === 'ClassLabel' && Array.isArray(f.type.names)).map((f) => [f.name, f.type!.names!]));
      for (const r of rows) {
        const values: Record_ = { ...r.row };
        for (const [name, names] of classes) if (typeof values[name] === 'number' && names[values[name] as number] !== undefined) values[name] = names[values[name] as number];
        yield { id: `${o.config ?? 'default'}/${split}/${r.row_idx}`, values, part: split };
        if (left != null) left--;
      }
      offset += rows.length;
      if (rows.length < length || (body.num_rows_total != null && offset >= body.num_rows_total)) break;
    }
  }
}

// ---------- CKAN (datastore, Socrata, files) ----------

const SOCRATA = /^(https?:\/\/[^/]+)\/(?:resource\/([a-z0-9]{4}-[a-z0-9]{4})(?:\.\w+)?|api\/views\/([a-z0-9]{4}-[a-z0-9]{4})\/rows\.\w+)(?:[?#].*)?$/i;

async function ckanDescribe(ctx: AdapterContext, itemId: string): Promise<DatasetDetail> {
  const { body } = await ctx.fetcher.json<{ success?: boolean; result?: CkanPackage }>(join(ckanBase(ctx.repo.baseUrl), `/api/3/action/package_show?id=${encodeURIComponent(itemId)}`), ctx.access, { signal: ctx.signal });
  const p = body.result;
  if (!body.success || !p) throw new SourceError('The CKAN portal did not answer a package_show result.');
  const extra = (k: string) => p.extras?.find((e) => e.key === k)?.value ?? null;
  const resources = (p.resources ?? []).slice(0, 200).map((r, i): DatasetResource => {
    const id = r.id ?? String(i + 1);
    const name = str(r.name, 300) ?? id;
    const soc = r.url ? SOCRATA.exec(r.url) : null;
    // An API resource has no size of its own (the size the portal lists is the file's it was loaded from).
    if (r.datastore_active) return { id, name, format: 'api', size: null, access: 'ckan-datastore', url: join(ckanBase(ctx.repo.baseUrl), `/api/3/action/datastore_search?resource_id=${encodeURIComponent(id)}`), note: 'CKAN datastore, read page by page' };
    if (soc) return { id, name, format: 'api', size: null, access: 'socrata', url: `${soc[1]}/resource/${(soc[2] ?? soc[3])!.toLowerCase()}.json`, note: 'Socrata API, read page by page' };
    return fileResource(id, name, lower(r.format) || fileType(r.mimetype), typeof r.size === 'number' ? r.size : null, r.url ?? null);
  });
  const size = resources.reduce((a, r) => a + (r.size ?? 0), 0);
  return {
    itemId: (p.name ?? itemId).slice(0, 300),
    name: (p.title ?? p.name ?? itemId).slice(0, 400),
    publisher: p.organization?.title ?? p.organization?.name ?? null,
    description: stripHtml(p.notes),
    revision: p.metadata_modified ?? null,
    licence: normaliseLicence(p.license_id ?? p.license_url ?? p.license_title ?? null),
    licenceSource: 'the package metadata on the portal',
    updates: frequency(p.frequency ?? p.accrual_periodicity ?? extra('accrualPeriodicity') ?? extra('frequency') ?? extra('update_frequency')),
    gated: false,
    configurations: [],
    splits: [],
    resources,
    rows: null,
    sizeBytes: size || null,
    data: {}
  };
}

async function* datastoreRows(ctx: AdapterContext, r: DatasetResource, o: RowsOptions, left: { n: number | null }): AsyncGenerator<SourceRecord> {
  let offset = 0;
  for (;;) {
    const limit = Math.min(1000, left.n ?? 1000);
    if (limit <= 0) return;
    const body = await page<{ success?: boolean; result?: { records?: Record_[]; total?: number } }>(ctx, `${r.url}&limit=${limit}&offset=${offset}`, o.budget);
    if (!body.success || !body.result) throw new SourceError('The CKAN datastore did not answer a datastore_search result.');
    const records = body.result.records ?? [];
    for (const rec of records) {
      const { _id, ...values } = rec;
      yield { id: _id == null ? null : String(_id), values, part: r.name };
      if (left.n != null) left.n--;
    }
    offset += records.length;
    if (records.length < limit || (body.result.total != null && offset >= body.result.total)) return;
  }
}

async function* socrataRows(ctx: AdapterContext, r: DatasetResource, o: RowsOptions, left: { n: number | null }): AsyncGenerator<SourceRecord> {
  let offset = 0;
  for (;;) {
    const limit = Math.min(1000, left.n ?? 1000);
    if (limit <= 0) return;
    // `:id` is Socrata's own row identifier; ordering by it makes the pages stable.
    const body = await page<unknown>(ctx, `${r.url}?$select=${encodeURIComponent(':id,*')}&$order=${encodeURIComponent(':id')}&$limit=${limit}&$offset=${offset}`, o.budget);
    if (!Array.isArray(body)) throw new SourceError('The Socrata resource did not answer an array of rows.');
    for (const rec of body as Record_[]) {
      const { ':id': id, ...values } = rec;
      yield { id: id == null ? null : String(id), values, part: r.name };
      if (left.n != null) left.n--;
    }
    offset += body.length;
    if (body.length < limit) return;
  }
}

// ---------- SDMX 2.1 ----------

const flowRef = (itemId: string): string => {
  const [agency, id, version] = itemId.split(',');
  if (!id) return itemId;
  return !agency || agency === 'all' ? id : `${agency},${id}${version && version !== 'latest' ? `,${version}` : ''}`;
};
const SDMX_MEASURES = /^(OBS_VALUE|OBS_FLAG|OBS_STATUS|CONF_STATUS|OBS_CONF|LAST UPDATE|TIME_FORMAT|DATAFLOW|STRUCTURE|STRUCTURE_ID|ACTION)$/i;

async function sdmxDescribe(ctx: AdapterContext, itemId: string): Promise<DatasetDetail> {
  const [agency, id, version] = itemId.split(',');
  if (!id) throw new SourceError('An SDMX dataset is named agency,dataflow,version.');
  const { body, headers } = await sdmxStructure(ctx, `/dataflow/${agency || 'all'}/${id}/${version || 'latest'}`);
  let name: string | undefined;
  if ((headers.get('content-type') ?? '').includes('json') || body.trimStart().startsWith('{')) {
    const f = (JSON.parse(body) as { data?: { dataflows?: { id: string; name?: string; names?: Record<string, string> }[] } }).data?.dataflows?.find((x) => x.id === id);
    name = f?.name ?? f?.names?.en ?? Object.values(f?.names ?? {})[0];
  } else name = flowsFromXml(body).find((x) => x.id === id)?.name;
  const ref = flowRef(itemId);
  return {
    itemId,
    name: (name ?? id).slice(0, 400),
    publisher: agency && agency !== 'all' ? agency : null,
    description: null,
    revision: version && version !== 'latest' ? version : null,
    licence: normaliseLicence(opt(ctx, 'licence')),
    licenceSource: 'the repository settings (SDMX states no licence per dataflow)',
    updates: frequency(opt(ctx, 'updates')),
    gated: false,
    configurations: [{ id: 'all', name: 'All series' }],
    splits: [],
    resources: [{ id: 'data', name: `SDMX data, /data/${ref}`, format: 'sdmx', size: null, access: 'sdmx', url: join(ctx.repo.baseUrl, `/data/${ref}`), note: 'One streamed SDMX-CSV answer; a series key and a period narrow it' }],
    rows: null,
    sizeBytes: null,
    data: { flow: id, agency: agency ?? null }
  };
}

async function* sdmxRows(ctx: AdapterContext, r: DatasetResource, o: RowsOptions): AsyncGenerator<SourceRecord> {
  // The configuration is the series key (`all`, or dimension values joined by dots, such as M.I15.CP00.EA20).
  const key = o.config && o.config !== 'all' ? `/${o.config.split('/').map(encodeURIComponent).join('/')}` : '';
  // SDMX 2.1 asks for CSV with the Accept header, and the large public providers ignore it: Eurostat answers CSV to
  // `format=SDMX-CSV` and the ECB to `format=csvdata`, both SDMX-ML otherwise. The repository option `dataQuery` names
  // the parameter; without it the header is tried first and then those two, each seen from the answer's first row.
  const set = opt(ctx, 'dataQuery');
  const tries = set ? [set] : [null, 'format=SDMX-CSV', 'format=csvdata'];
  for (const [i, extra] of tries.entries()) {
    const q = [o.startPeriod ? `startPeriod=${encodeURIComponent(o.startPeriod)}` : null, o.endPeriod ? `endPeriod=${encodeURIComponent(o.endPeriod)}` : null, extra].filter(Boolean).join('&');
    const res: DatasetResource = { ...r, format: 'csv', url: `${r.url}${key}${q ? `?${q}` : ''}` };
    const last = i === tries.length - 1;
    let first = true;
    let csv = true;
    const used = o.budget.used;
    try {
      for await (const rec of fileRows(ctx, res, o.budget, { accept: 'application/vnd.sdmx.data+csv;version=1.0.0, text/csv;q=0.9' }, 0, (type) => !/xml|json|html/.test(type))) {
        const cols = Object.keys(rec.values);
        if (first && ((cols.length === 1 && /^\s*[<{]/.test(cols[0]!)) || cols.some((c) => /^\s*<\?xml|^\s*<\w+:\w+/.test(c)))) {
          csv = false;
          break;
        }
        first = false;
        // A row's identity is its series key and period: the provider's own KEY column with the period where it
        // sends one (the ECB), else every column that is not a measure or an attribute of one.
        const id = typeof rec.values.KEY === 'string' && rec.values.KEY ? [rec.values.KEY, rec.values.TIME_PERIOD].filter((v) => v != null && v !== '').join('.') : cols.filter((c) => !SDMX_MEASURES.test(c)).map((c) => String(rec.values[c] ?? '')).join('.');
        const { DATAFLOW: _flow, ...values } = rec.values;
        yield { id: id || null, values, part: r.name };
      }
    } catch (err) {
      // A provider may refuse a format it does not know (400, 406): the next one is tried, the last one's error stands.
      if (!first || !(err instanceof SourceError) || (err.status !== 400 && err.status !== 406 && err.status !== 415) || (last && err.status !== 406)) throw err;
      csv = false;
    }
    if (csv) return;
    if (last) throw new SourceError('The SDMX provider did not answer SDMX-CSV. Set the repository option dataQuery (for example format=SDMX-CSV).');
    o.budget.used = used; // the answer that was not CSV is not counted
  }
}

// ---------- DCAT-AP ----------

async function dcatDescribe(ctx: AdapterContext, itemId: string): Promise<DatasetDetail> {
  if (!/^https?:\/\//i.test(itemId)) throw new SourceError('This DCAT-AP dataset has no address of its own to read its distributions from.');
  // A dataset's identifier is often an http:// address on the catalogue's own https:// host (data.europa.eu): it is
  // read over the catalogue's scheme.
  const at = new URL(itemId);
  const base = new URL(ctx.repo.baseUrl);
  if (at.protocol === 'http:' && base.protocol === 'https:' && at.hostname === base.hostname) at.protocol = 'https:';
  const { body } = await ctx.fetcher.text(at.toString(), ctx.access, { headers: { accept: 'application/ld+json' }, signal: ctx.signal });
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    throw new SourceError('The dataset did not answer JSON-LD.');
  }
  const graph = graphOf(doc);
  const byId = new Map(graph.filter((n) => typeof n['@id'] === 'string').map((n) => [n['@id'] as string, n]));
  const deref = (v: unknown): Node | null => (v && typeof v === 'object' ? ((typeof (v as Node)['@id'] === 'string' && byId.get((v as Node)['@id'] as string)) || (v as Node)) : typeof v === 'string' ? (byId.get(v) ?? null) : null);
  const named = byId.get(itemId);
  const d = (named && isType(named, 'dcat:Dataset') ? named : null) ?? graph.find((n) => isType(n, 'dcat:Dataset')) ?? named;
  if (!d) throw new SourceError('The JSON-LD answer holds no dcat:Dataset.');
  const dists = prop(d, 'dcat:distribution').map(deref).filter((x): x is Node => !!x);
  const resources = dists.slice(0, 200).map((x, i) => {
    const url = literal(prop(x, 'dcat:downloadURL')[0]) ?? literal(prop(x, 'dcat:accessURL')[0]);
    const size = Number(literal(prop(x, 'dcat:byteSize')[0]) ?? NaN);
    return fileResource(typeof x['@id'] === 'string' ? x['@id'] : String(i + 1), literals(prop(x, 'dct:title')) ?? url?.split('/').pop() ?? `distribution ${i + 1}`, fileType(literal(prop(x, 'dct:format')[0]) ?? literal(prop(x, 'dcat:mediaType')[0])), Number.isFinite(size) ? size : null, url);
  });
  const pub = deref(prop(d, 'dct:publisher')[0]);
  return {
    itemId,
    name: (literals(prop(d, 'dct:title')) ?? itemId).slice(0, 400),
    publisher: pub ? (literals(prop(pub, 'foaf:name')) ?? literals(prop(pub, 'skos:prefLabel'))) : null,
    description: stripHtml(literals(prop(d, 'dct:description'))),
    revision: literal(prop(d, 'dct:modified')[0]),
    licence: normaliseLicence(literal(prop(d, 'dct:license')[0]) ?? dists.map((x) => literal(prop(x, 'dct:license')[0])).find(Boolean) ?? null),
    licenceSource: 'the DCAT-AP record',
    updates: frequency(literal(prop(d, 'dct:accrualPeriodicity')[0])),
    gated: false,
    configurations: [],
    splits: [],
    resources,
    rows: null,
    sizeBytes: resources.reduce((a, r) => a + (r.size ?? 0), 0) || null,
    data: {}
  };
}

// ---------- OpenML ----------

async function openmlDescribe(ctx: AdapterContext, itemId: string): Promise<DatasetDetail> {
  if (!/^\d+$/.test(itemId)) throw new SourceError('An OpenML dataset is named by its number.');
  const { body } = await ctx.fetcher.json<{ data_set_description?: { id?: string; name?: string; version?: string; description?: string; licence?: string; url?: string; parquet_url?: string; format?: string; upload_date?: string; creator?: string | string[] } }>(join(ctx.repo.baseUrl, `/api/v1/json/data/${itemId}`), ctx.access, { signal: ctx.signal });
  const d = body.data_set_description;
  if (!d) throw new SourceError('OpenML did not answer a dataset description.');
  const resources: DatasetResource[] = [];
  if (d.url) resources.push(fileResource('arff', `${d.name ?? itemId}.arff`, 'arff', null, d.url));
  if (d.parquet_url) resources.push(fileResource('parquet', `${d.name ?? itemId}.parquet`, 'parquet', null, d.parquet_url));
  return {
    itemId,
    name: `${d.name ?? itemId}${d.version ? ` (v${d.version})` : ''}`.slice(0, 400),
    publisher: Array.isArray(d.creator) ? (d.creator[0] ?? null) : (d.creator ?? null),
    description: stripHtml(d.description),
    revision: d.version ? `v${d.version}` : (d.upload_date ?? null),
    licence: normaliseLicence(d.licence ?? null),
    licenceSource: 'the OpenML dataset description',
    updates: 'static',
    gated: false,
    configurations: [],
    splits: [],
    resources,
    rows: null,
    sizeBytes: null,
    data: {}
  };
}

// ---------- InvenioRDM ----------

async function invenioDescribe(ctx: AdapterContext, itemId: string): Promise<DatasetDetail> {
  type Entry = { key?: string; filename?: string; size?: number; links?: { content?: string; self?: string } };
  const { body: h } = await ctx.fetcher.json<{ id?: string | number; revision_id?: number; updated?: string; metadata?: { title?: string; description?: string; creators?: { person_or_org?: { name?: string }; name?: string }[]; rights?: { id?: string }[]; license?: { id?: string } | string; version?: string }; files?: { entries?: Record<string, Entry> } | Entry[] }>(join(ctx.repo.baseUrl, `/api/records/${encodeURIComponent(itemId)}`), ctx.access, { signal: ctx.signal });
  const m = h.metadata ?? {};
  const files = Array.isArray(h.files) ? h.files : Object.values(h.files?.entries ?? {});
  const resources = files.slice(0, 200).map((f, i) => {
    const key = f.key ?? f.filename ?? String(i + 1);
    return fileResource(key, key, null, f.size ?? null, f.links?.content ?? (f.links?.self && /\/content$/.test(f.links.self) ? f.links.self : join(ctx.repo.baseUrl, `/api/records/${encodeURIComponent(itemId)}/files/${encodeURIComponent(key)}/content`)));
  });
  return {
    itemId,
    name: (m.title ?? itemId).slice(0, 400),
    publisher: m.creators?.[0]?.person_or_org?.name ?? m.creators?.[0]?.name ?? null,
    description: stripHtml(m.description),
    revision: m.version ?? (h.revision_id != null ? `revision ${h.revision_id}` : (h.updated ?? null)),
    licence: normaliseLicence(m.rights?.[0]?.id ?? (typeof m.license === 'string' ? m.license : m.license?.id) ?? null),
    licenceSource: 'the record metadata',
    updates: 'static',
    gated: false,
    configurations: [],
    splits: [],
    resources,
    rows: null,
    sizeBytes: resources.reduce((a, r) => a + (r.size ?? 0), 0) || null,
    data: {}
  };
}

// ---------- the fetch steps, by type ----------

const DESCRIBE: Partial<Record<RepoType, (ctx: AdapterContext, itemId: string) => Promise<DatasetDetail>>> = { hf: hfDescribe, ckan: ckanDescribe, sdmx: sdmxDescribe, dcat: dcatDescribe, openml: openmlDescribe, invenio: invenioDescribe, kaggle: (ctx, itemId) => kaggleDescribe(ctx, itemId, fileResource), estat: estatDescribe, ogd: ogdDescribe };

export const hasDatasetFetch = (type: RepoType): boolean => !!DESCRIBE[type];

/** One dataset as the source states it now. */
export function describeDataset(ctx: AdapterContext, itemId: string): Promise<DatasetDetail> {
  const fn = DESCRIBE[ctx.repo.type];
  if (!fn) throw new SourceError(`Datasets cannot be fetched from this repository type (${ctx.repo.type}).`);
  return fn(ctx, itemId);
}

/** The selected rows, in publication order, until the caller stops reading or `limit` is reached. */
export async function* datasetRows(ctx: AdapterContext, itemId: string, o: RowsOptions): AsyncGenerator<SourceRecord> {
  if (ctx.repo.type === 'hf') {
    yield* hfRows(ctx, itemId, o);
    return;
  }
  const left = { n: o.limit };
  for (const r of o.resources) {
    if (left.n != null && left.n <= 0) return;
    const paged = r.access === 'ckan-datastore' || r.access === 'socrata' || r.access === 'estat' || r.access === 'ogd';
    const rows = r.access === 'ckan-datastore' ? datastoreRows(ctx, r, o, left) : r.access === 'socrata' ? socrataRows(ctx, r, o, left) : r.access === 'estat' ? estatRows(ctx, r, left, (n) => spend(o.budget, n)) : r.access === 'ogd' ? ogdRows(ctx, r, left, (n) => spend(o.budget, n)) : r.access === 'sdmx' ? sdmxRows(ctx, r, o) : fileRows(ctx, r, o.budget);
    for await (const rec of rows) {
      yield rec;
      // The paged readers count their own rows; a file or an SDMX answer is cut here.
      if (!paged && left.n != null && --left.n <= 0) return;
    }
  }
}
