import { normaliseLicence, rowBucket } from '../formats.js';
import { apiOf, type DatasetResource } from '../rows.js';
import { NeedsCredential, SourceError, type CatalogItem, type ImportKind } from '../types.js';
import { join, str, stripHtml, uniq, type AdapterContext, type DatasetDetail, type RepositoryAdapter } from './types.js';

/*
 * The dataset-oriented repository types (B-3801, B-3802): each harvests its catalogue into the snapshot with the
 * classification, licence and format facets of its own taxonomy (CKAN groups and licence ids, DCAT-AP themes and
 * file types, SDMX categorisations, OpenML task types, InvenioRDM resource types, Kaggle tags), and the ones with a
 * search API search live. Fetching the data itself is dataset import (B-3804).
 */

// ---------- B-3804: what a dataset can be read from ----------

const extOf = (name: string | null | undefined): string | null => {
  const m = /\.([a-z0-9]{1,8})(\.gz)?$/i.exec(name ?? '');
  return m ? m[1]!.toLowerCase() : null;
};
const FORMAT_ALIAS: Record<string, string> = { txt: 'other', tab: 'tsv', ndjson: 'jsonl', jsonlines: 'jsonl', 'application/json': 'json', 'text/csv': 'csv', 'text/tab-separated-values': 'tsv', xls: 'xlsx', geojson: 'json' };
/** csv | tsv | json | jsonl | parquet | xlsx | zip | api | other, from a format word, a media type or a file name. */
export const resourceFormat = (format: string | null | undefined, name?: string | null, url?: string | null): string => {
  const raw = lower(format) ?? extOf(name) ?? extOf(url?.split('?')[0]) ?? 'other';
  const f = FORMAT_ALIAS[raw] ?? raw;
  return ['csv', 'tsv', 'json', 'jsonl', 'parquet', 'xlsx', 'zip', 'api', 'sdmx', 'arff'].includes(f) ? f : 'other';
};
const splitOf = (name: string): string | null => {
  const m = /(^|[/_.-])(train|test|validation|valid|dev|eval)([/_.-]|$)/i.exec(name);
  return m ? m[2]!.toLowerCase().replace(/^valid$/, 'validation').replace(/^dev$/, 'validation') : null;
};
export const resource = (x: Partial<DatasetResource> & { id: string; name: string }): DatasetResource => ({
  id: x.id,
  name: x.name,
  format: x.format ?? resourceFormat(null, x.name, x.url),
  url: x.url ?? null,
  api: x.api ?? apiOf({ url: x.url, format: x.format }),
  bytes: x.bytes ?? null,
  rows: x.rows ?? null,
  config: x.config ?? null,
  split: x.split ?? splitOf(x.name)
});
const detail = (x: Partial<DatasetDetail> & { itemId: string; name: string; resources: DatasetResource[] }): DatasetDetail => ({
  revision: null,
  licence: null,
  licenceSource: 'the catalogue',
  publisher: null,
  description: null,
  frequency: null,
  configurations: x.configurations ?? [{ id: 'default', name: 'default', splits: uniq(x.resources.map((r) => r.split)) }],
  landingPage: null,
  data: {},
  ...x
});

const opt = (ctx: AdapterContext, k: string): string | null => (typeof ctx.repo.options[k] === 'string' && (ctx.repo.options[k] as string).trim() ? (ctx.repo.options[k] as string).trim() : null);
const lower = (v: string | null | undefined) => (v ? v.toLowerCase().trim() : null);
const fileType = (v: string | null | undefined): string | null => {
  if (!v) return null;
  const last = v.split(/[/#]/).filter(Boolean).pop() ?? v;
  const t = last.toLowerCase().replace(/^\./, '').replace(/^application\//, '').replace(/^text\//, '');
  return ({ 'vnd.ms-excel': 'xls', 'vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx', 'ld+json': 'jsonld', zip: 'zip', 'csv': 'csv' } as Record<string, string>)[t] ?? t.slice(0, 40);
};
const FREQ: Record<string, string> = { daily: 'daily', day: 'daily', weekly: 'weekly', week: 'weekly', monthly: 'monthly', month: 'monthly', quarterly: 'quarterly', quarter: 'quarterly', annual: 'yearly', yearly: 'yearly', year: 'yearly', irreg: 'irregular', irregular: 'irregular', never: 'static', notplanned: 'static', 'not_planned': 'static', continuous: 'continuous', cont: 'continuous', 'r/p1d': 'daily', 'r/p1w': 'weekly', 'r/p1m': 'monthly', 'r/p3m': 'quarterly', 'r/p1y': 'yearly' };
const frequency = (v: string | null | undefined) => (v ? (FREQ[(v.split(/[/#]/).filter(Boolean).pop() ?? v).toLowerCase()] ?? FREQ[v.toLowerCase()] ?? null) : null);

const dataset = (x: Omit<CatalogItem, 'kind' | 'gated' | 'sizeBytes' | 'updated'> & Partial<Pick<CatalogItem, 'kind' | 'gated' | 'sizeBytes' | 'updated'>>): CatalogItem => ({ kind: 'dataset', gated: false, sizeBytes: null, updated: null, ...x });

// ---------- CKAN ----------

interface CkanPackage {
  name?: string;
  id?: string;
  title?: string;
  notes?: string;
  license_id?: string;
  license_title?: string;
  license_url?: string;
  organization?: { title?: string; name?: string } | null;
  groups?: { title?: string; display_name?: string; name?: string }[];
  tags?: { name?: string; display_name?: string }[];
  resources?: { id?: string; name?: string; format?: string; url?: string; size?: number | null; mimetype?: string; datastore_active?: boolean }[];
  metadata_modified?: string;
  extras?: { key: string; value: string }[];
  frequency?: string;
  accrual_periodicity?: string;
}

const ckanBase = (u: string) => u.replace(/\/+$/, '').replace(/\/api\/3(\/action)?$/, '');

function ckanItem(p: CkanPackage, region: string | null): CatalogItem {
  const groups = uniq((p.groups ?? []).map((g) => g.display_name ?? g.title ?? g.name ?? null));
  const formats = uniq((p.resources ?? []).map((r) => lower(r.format) || fileType(r.mimetype)));
  const licence = normaliseLicence(p.license_id ?? p.license_url ?? p.license_title ?? null);
  const extra = (k: string) => p.extras?.find((e) => e.key === k)?.value ?? null;
  const freq = frequency(p.frequency ?? p.accrual_periodicity ?? extra('accrualPeriodicity') ?? extra('frequency') ?? extra('update_frequency'));
  const publisher = p.organization?.title ?? p.organization?.name ?? null;
  const size = (p.resources ?? []).reduce((a, r) => a + (typeof r.size === 'number' ? r.size : 0), 0);
  return dataset({
    itemId: (p.name ?? p.id ?? '').slice(0, 300),
    name: (p.title ?? p.name ?? '').slice(0, 400),
    publisher,
    description: stripHtml(p.notes),
    classification: groups[0] ?? null,
    licence,
    formats,
    sizeBytes: size || null,
    updated: p.metadata_modified ?? null,
    facets: { classification: groups, licence: [licence], format: formats, publisher: uniq([publisher]), updates: uniq([freq]), region: uniq([region]) },
    data: { tags: uniq((p.tags ?? []).map((t) => t.display_name ?? t.name ?? null)).slice(0, 50), resources: (p.resources ?? []).slice(0, 50).map((r) => ({ name: str(r.name, 300), format: lower(r.format), size: r.size ?? null })), licenceTitle: p.license_title ?? null }
  });
}

async function ckanSearch(ctx: AdapterContext, q: string, rows: number, start: number): Promise<{ count: number; results: CkanPackage[] }> {
  const fq = opt(ctx, 'fq');
  const url = join(ckanBase(ctx.repo.baseUrl), `/api/3/action/package_search?rows=${rows}&start=${start}${q ? `&q=${encodeURIComponent(q)}` : ''}${fq ? `&fq=${encodeURIComponent(fq)}` : ''}`);
  const { body } = await ctx.fetcher.json<{ success?: boolean; result?: { count?: number; results?: CkanPackage[] } }>(url, ctx.access, { signal: ctx.signal });
  if (!body.success || !body.result) throw new SourceError('The CKAN portal did not answer a package_search result.');
  return { count: body.result.count ?? 0, results: body.result.results ?? [] };
}

export const ckanAdapter: RepositoryAdapter = {
  async datasetDetail(ctx, itemId) {
    const base = ckanBase(ctx.repo.baseUrl);
    const { body } = await ctx.fetcher.json<{ success?: boolean; result?: CkanPackage }>(join(base, `/api/3/action/package_show?id=${encodeURIComponent(itemId)}`), ctx.access, { signal: ctx.signal });
    if (!body.success || !body.result) throw new SourceError(`The CKAN portal has no package ${itemId}.`);
    const p = body.result;
    const it = ckanItem(p, opt(ctx, 'region'));
    const resources = (p.resources ?? []).map((r, i) => {
      const id = r.id ?? `r${i + 1}`;
      // A datastore resource is read through datastore_search (paged); the file otherwise.
      if (r.datastore_active) return resource({ id, name: r.name ?? id, format: 'api', url: join(base, `/api/3/action/datastore_search?resource_id=${encodeURIComponent(id)}`), api: 'ckan-datastore', bytes: r.size ?? null });
      return resource({ id, name: r.name ?? id, format: resourceFormat(r.format ?? r.mimetype, r.name, r.url), url: r.url ?? null, bytes: r.size ?? null });
    });
    return detail({ itemId: it.itemId, name: it.name, revision: p.metadata_modified ?? null, licence: it.licence, licenceSource: 'the package (license_id)', publisher: it.publisher, description: it.description, frequency: it.facets.updates?.[0] ?? null, resources, landingPage: join(base, `/dataset/${encodeURIComponent(itemId)}`), data: it.data });
  },
  async probe(ctx) {
    const r = await ckanSearch(ctx, '', 0, 0);
    return `Reachable; ${r.count.toLocaleString('en-US')} datasets.`;
  },
  async *harvest(ctx) {
    const region = opt(ctx, 'region');
    let start = 0;
    while (start < ctx.maxItems) {
      const rows = Math.min(1000, ctx.maxItems - start);
      const r = await ckanSearch(ctx, opt(ctx, 'query') ?? '', rows, start);
      for (const p of r.results) if (p.name ?? p.id) yield ckanItem(p, region);
      start += r.results.length;
      if (!r.results.length || start >= r.count) break;
    }
  },
  async search(ctx, query, _kind, limit) {
    return (await ckanSearch(ctx, query, limit, 0)).results.filter((p) => p.name ?? p.id).map((p) => ckanItem(p, opt(ctx, 'region')));
  }
};

// ---------- DCAT-AP (JSON-LD) ----------

type Node = Record<string, unknown>;
const NS: Record<string, string> = { dct: 'http://purl.org/dc/terms/', dcat: 'http://www.w3.org/ns/dcat#', foaf: 'http://xmlns.com/foaf/0.1/', hydra: 'http://www.w3.org/ns/hydra/core#', skos: 'http://www.w3.org/2004/02/skos/core#' };
const keysFor = (k: string) => {
  const [pre, local] = k.split(':') as [string, string];
  return [k, `${NS[pre]}${local}`, local];
};
const prop = (n: Node, k: string): unknown[] => {
  for (const key of keysFor(k)) {
    const v = n[key];
    if (v !== undefined && v !== null) return Array.isArray(v) ? v : [v];
  }
  return [];
};
const literal = (v: unknown, lang = 'en'): string | null => {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v && typeof v === 'object') {
    const o = v as Node;
    if (typeof o['@value'] === 'string') return o['@value'];
    if (typeof o['@id'] === 'string') return o['@id'];
    const l = o[lang] ?? Object.values(o)[0];
    if (typeof l === 'string') return l;
  }
  return null;
};
const literals = (vs: unknown[], lang = 'en'): string | null => {
  const tagged = vs.find((v) => v && typeof v === 'object' && (v as Node)['@language'] === lang);
  return literal(tagged ?? vs[0], lang);
};
const isType = (n: Node, t: string) => prop(n, '@type').concat(prop(n, 'type')).some((x) => typeof x === 'string' && keysFor(t).includes(x));

function dcatItems(doc: unknown, region: string | null): { items: CatalogItem[]; next: string | null } {
  const graph: Node[] = Array.isArray(doc) ? (doc as Node[]) : Array.isArray((doc as Node)?.['@graph']) ? ((doc as Node)['@graph'] as Node[]) : doc && typeof doc === 'object' ? [doc as Node] : [];
  const byId = new Map(graph.filter((n) => typeof n['@id'] === 'string').map((n) => [n['@id'] as string, n]));
  const deref = (v: unknown): Node | null => (v && typeof v === 'object' ? ((typeof (v as Node)['@id'] === 'string' && byId.get((v as Node)['@id'] as string)) || (v as Node)) : typeof v === 'string' ? (byId.get(v) ?? null) : null);
  const datasets = graph.flatMap((n) => (isType(n, 'dcat:Dataset') ? [n] : prop(n, 'dcat:dataset').map(deref).filter((x): x is Node => !!x)));
  const seen = new Set<string>();
  const items: CatalogItem[] = [];
  for (const d of datasets) {
    const id = (typeof d['@id'] === 'string' ? d['@id'] : literal(prop(d, 'dct:identifier')[0])) ?? null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const dists = prop(d, 'dcat:distribution').map(deref).filter((x): x is Node => !!x);
    const formats = uniq(dists.flatMap((x) => [...prop(x, 'dct:format'), ...prop(x, 'dcat:mediaType')].map((f) => fileType(literal(f)))));
    const licRaw = literal(prop(d, 'dct:license')[0]) ?? dists.map((x) => literal(prop(x, 'dct:license')[0])).find(Boolean) ?? null;
    const licence = normaliseLicence(licRaw);
    const themes = uniq(prop(d, 'dcat:theme').map((t) => {
      const node = deref(t);
      return (node && literals(prop(node, 'skos:prefLabel'))) ?? (literal(t)?.split('/').pop() ?? null);
    }));
    const pub = deref(prop(d, 'dct:publisher')[0]);
    const publisher = pub ? literals(prop(pub, 'foaf:name')) ?? literals(prop(pub, 'skos:prefLabel')) : null;
    const freq = frequency(literal(prop(d, 'dct:accrualPeriodicity')[0]));
    items.push(dataset({
      itemId: id.slice(0, 300),
      name: (literals(prop(d, 'dct:title')) ?? id).slice(0, 400),
      publisher: publisher?.slice(0, 200) ?? null,
      description: stripHtml(literals(prop(d, 'dct:description'))),
      classification: themes[0] ?? null,
      licence,
      formats,
      updated: literal(prop(d, 'dct:modified')[0]),
      facets: { classification: themes, licence: [licence], format: formats, publisher: uniq([publisher]), updates: uniq([freq]), region: uniq([region]) },
      data: {
        keywords: uniq(prop(d, 'dcat:keyword').map((k) => literal(k))).slice(0, 50),
        distributions: dists.length,
        landingPage: literal(prop(d, 'dcat:landingPage')[0]),
        // B-3804: the distributions a dataset import reads from (title, URL, format), at most 20.
        files: dists.slice(0, 20).map((x) => ({ title: literals(prop(x, 'dct:title')) ?? literal(prop(x, 'dct:identifier')[0]), url: literal(prop(x, 'dcat:downloadURL')[0]) ?? literal(prop(x, 'dcat:accessURL')[0]), format: fileType(literal([...prop(x, 'dct:format'), ...prop(x, 'dcat:mediaType')][0])), bytes: Number(literal(prop(x, 'dcat:byteSize')[0])) || null }))
      }
    }));
  }
  const pager = graph.find((n) => prop(n, 'hydra:next').length || prop(n, 'hydra:nextPage').length);
  const next = pager ? literal(prop(pager, 'hydra:next')[0] ?? prop(pager, 'hydra:nextPage')[0]) : null;
  return { items, next };
}

export const dcatAdapter: RepositoryAdapter = {
  async datasetDetail(ctx, itemId, cached) {
    // The catalogue document is paged and large: a dataset's distributions come from the harvested snapshot.
    const files = Array.isArray(cached?.files) ? (cached!.files as { title?: string | null; url?: string | null; format?: string | null; bytes?: number | null }[]) : [];
    if (!files.length) throw new SourceError(`${itemId} has no distribution in the snapshot; refresh the repository's snapshot and try again.`);
    const resources = files.map((f, i) => resource({ id: `d${i + 1}`, name: f.title ?? f.url?.split('/').pop() ?? `distribution ${i + 1}`, format: resourceFormat(f.format, f.title, f.url), url: f.url ?? null, bytes: f.bytes ?? null }));
    void ctx;
    return detail({ itemId, name: String(cached?.name ?? itemId), resources, landingPage: typeof cached?.landingPage === 'string' ? cached.landingPage : null, data: cached ?? {} });
  },
  async probe(ctx) {
    const { body } = await ctx.fetcher.text(ctx.repo.baseUrl, ctx.access, { headers: { accept: 'application/ld+json' }, signal: ctx.signal });
    const { items } = dcatItems(JSON.parse(body), null);
    return `Reachable; the first page lists ${items.length} datasets.`;
  },
  async *harvest(ctx) {
    let url: string | null = ctx.repo.baseUrl;
    let n = 0;
    const seen = new Set<string>();
    while (url && n < ctx.maxItems && !seen.has(url)) {
      seen.add(url);
      const { body } = await ctx.fetcher.text(url, ctx.access, { headers: { accept: 'application/ld+json' }, signal: ctx.signal });
      let doc: unknown;
      try {
        doc = JSON.parse(body);
      } catch {
        throw new SourceError('The DCAT-AP catalogue is not JSON-LD.');
      }
      const page = dcatItems(doc, opt(ctx, 'region'));
      for (const it of page.items) {
        if (n++ >= ctx.maxItems) break;
        yield it;
      }
      url = page.next ? new URL(page.next, url).toString() : null;
    }
  }
};

// ---------- SDMX 2.1 ----------

interface SdmxFlow {
  id: string;
  agencyID?: string;
  version?: string;
  name?: string;
  names?: Record<string, string>;
  description?: string;
}

function flowsFromXml(xml: string): SdmxFlow[] {
  const out: SdmxFlow[] = [];
  for (const m of xml.matchAll(/<(?:\w+:)?Dataflow\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?Dataflow>/g)) {
    const attrs = Object.fromEntries([...m[1]!.matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1]!, a[2]!]));
    if (!attrs.id) continue;
    const names = [...m[2]!.matchAll(/<(?:\w+:)?Name\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?Name>/g)].map((x) => ({ lang: /xml:lang="([\w-]+)"/.exec(x[1]!)?.[1] ?? null, text: x[2]!.trim() }));
    const en = names.find((x) => x.lang === 'en') ?? names[0];
    out.push({ id: attrs.id, agencyID: attrs.agencyID, version: attrs.version, name: en?.text });
  }
  return out;
}

function categorisationsFromXml(xml: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const m of xml.matchAll(/<(?:\w+:)?Categorisation\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Categorisation>/g)) {
    const src = /<(?:\w+:)?Source\b[^>]*>\s*<Ref\b[^>]*id="([^"]+)"/.exec(m[1]!)?.[1] ?? /<(?:\w+:)?Source\b[^>]*>\s*(?:<URN>)?[^<]*Dataflow=[^:]+:([^(]+)\(/.exec(m[1]!)?.[1];
    const tgt = /<(?:\w+:)?Target\b[^>]*>\s*<Ref\b[^>]*id="([^"]+)"/.exec(m[1]!)?.[1] ?? /<(?:\w+:)?Target\b[^>]*>\s*(?:<URN>)?[^<]*\)\.([\w.-]+)/.exec(m[1]!)?.[1];
    if (src && tgt) map.set(src, [...(map.get(src) ?? []), tgt.split('.').pop()!]);
  }
  return map;
}

async function sdmxFlows(ctx: AdapterContext): Promise<SdmxFlow[]> {
  const { body, headers } = await ctx.fetcher.text(join(ctx.repo.baseUrl, '/dataflow/all/all/latest'), ctx.access, { headers: { accept: 'application/vnd.sdmx.structure+json;version=1.0, application/vnd.sdmx.structure+xml;version=2.1;q=0.9, application/xml;q=0.8' }, signal: ctx.signal });
  if ((headers.get('content-type') ?? '').includes('json') || body.trimStart().startsWith('{')) {
    const j = JSON.parse(body) as { data?: { dataflows?: SdmxFlow[] } };
    return (j.data?.dataflows ?? []).map((f) => ({ ...f, name: f.name ?? f.names?.en ?? Object.values(f.names ?? {})[0] }));
  }
  return flowsFromXml(body);
}

export const sdmxAdapter: RepositoryAdapter = {
  async datasetDetail(ctx, itemId, cached) {
    const [agency, flow, version] = itemId.split(',');
    const id = flow ?? itemId;
    // SDMX 2.1 REST: /data/{flow}/all (Eurostat) or /data/{agency},{flow},{version}/all (ECB, the SDMX standard form).
    const path = opt(ctx, 'dataPath') === 'full' ? `/data/${agency ?? 'all'},${id},${version ?? 'latest'}/all` : `/data/${id}`;
    const resources = [resource({ id, name: `${id} (SDMX-CSV)`, format: 'api', url: join(ctx.repo.baseUrl, path), api: 'sdmx', config: id })];
    return detail({ itemId, name: String(cached?.name ?? id), licence: normaliseLicence(opt(ctx, 'licence')), licenceSource: 'the repository', publisher: agency ?? null, frequency: 'monthly', configurations: [{ id, name: id, splits: [] }], resources, data: cached ?? { flow: id, agency, version } });
  },
  async probe(ctx) {
    return `Reachable; ${(await sdmxFlows(ctx)).length.toLocaleString('en-US')} dataflows.`;
  },
  async *harvest(ctx) {
    const flows = await sdmxFlows(ctx);
    let cats = new Map<string, string[]>();
    try {
      const { body } = await ctx.fetcher.text(join(ctx.repo.baseUrl, '/categorisation/all/all/latest'), ctx.access, { headers: { accept: 'application/vnd.sdmx.structure+xml;version=2.1, application/xml;q=0.9' }, signal: ctx.signal });
      cats = categorisationsFromXml(body);
    } catch {
      // Categorisations are optional: flows without one have no classification.
    }
    const licence = normaliseLicence(opt(ctx, 'licence'));
    const region = opt(ctx, 'region');
    let n = 0;
    for (const f of flows) {
      if (n++ >= ctx.maxItems) break;
      const c = uniq(cats.get(f.id) ?? []);
      yield dataset({
        itemId: `${f.agencyID ?? 'all'},${f.id},${f.version ?? 'latest'}`.slice(0, 300),
        name: (f.name ?? f.id).slice(0, 400),
        publisher: f.agencyID ?? null,
        description: stripHtml(f.description),
        classification: c[0] ?? null,
        licence,
        formats: ['sdmx'],
        facets: { classification: c, licence: [licence], format: ['sdmx'], publisher: uniq([f.agencyID]), region: uniq([region]) },
        data: { flow: f.id, agency: f.agencyID ?? null, version: f.version ?? null }
      });
    }
  }
};

// ---------- OpenML ----------

interface OpenmlEntry {
  did: number | string;
  name: string;
  version?: number | string;
  status?: string;
  format?: string;
  quality?: { name: string; value: string | number }[];
}

export const openmlAdapter: RepositoryAdapter = {
  async datasetDetail(ctx, itemId) {
    const { body } = await ctx.fetcher.json<{ data_set_description?: { did?: number | string; name?: string; version?: number | string; licence?: string; description?: string; file_id?: number | string; url?: string; format?: string; default_target_attribute?: string; upload_date?: string } }>(join(ctx.repo.baseUrl, `/api/v1/json/data/${encodeURIComponent(itemId)}`), ctx.access, { signal: ctx.signal });
    const d = body.data_set_description;
    if (!d) throw new SourceError(`OpenML has no dataset ${itemId}.`);
    const resources: DatasetResource[] = [];
    if (d.file_id != null) resources.push(resource({ id: `csv-${d.file_id}`, name: `${d.name ?? itemId}.csv`, format: 'csv', url: join(ctx.repo.baseUrl, `/data/get_csv/${d.file_id}/${encodeURIComponent(d.name ?? 'data')}.csv`) }));
    if (d.url) resources.push(resource({ id: 'arff', name: d.url.split('/').pop() ?? 'data.arff', format: 'arff', url: d.url }));
    return detail({ itemId, name: `${d.name ?? itemId}${d.version ? ` (v${d.version})` : ''}`, revision: d.upload_date ?? null, licence: normaliseLicence(d.licence ?? null), licenceSource: 'the dataset description', description: stripHtml(d.description), resources, landingPage: join(ctx.repo.baseUrl, `/d/${itemId}`), data: { target: d.default_target_attribute ?? null } });
  },
  async probe(ctx) {
    await ctx.fetcher.json(join(ctx.repo.baseUrl, '/api/v1/json/data/list/limit/1'), ctx.access, { signal: ctx.signal });
    return 'Reachable.';
  },
  async *harvest(ctx) {
    const detailMax = Math.max(0, Math.min(5000, Number(ctx.repo.options.detailLimit ?? 50)));
    let offset = 0;
    let details = 0;
    while (offset < ctx.maxItems) {
      const limit = Math.min(1000, ctx.maxItems - offset);
      let list: OpenmlEntry[];
      try {
        const { body } = await ctx.fetcher.json<{ data?: { dataset?: OpenmlEntry[] } }>(join(ctx.repo.baseUrl, `/api/v1/json/data/list/limit/${limit}/offset/${offset}/status/active`), ctx.access, { signal: ctx.signal });
        list = body.data?.dataset ?? [];
      } catch (err) {
        // OpenML answers 412 ("No results") past the end of the list.
        if (err instanceof SourceError && (err.status === 412 || err.status === 404)) break;
        throw err;
      }
      if (!list.length) break;
      for (const d of list) {
        const q = (k: string) => {
          const v = d.quality?.find((x) => x.name === k)?.value;
          return v == null || v === '' ? null : Number(v);
        };
        const classes = q('NumberOfClasses');
        const rows = q('NumberOfInstances');
        const task = classes == null ? null : classes > 0 ? 'Supervised Classification' : 'Supervised Regression';
        let licence = 'unknown';
        let tags: string[] = [];
        if (details < detailMax) {
          details++;
          try {
            const { body } = await ctx.fetcher.json<{ data_set_description?: { licence?: string; tag?: string[] | string } }>(join(ctx.repo.baseUrl, `/api/v1/json/data/${d.did}`), ctx.access, { signal: ctx.signal });
            licence = normaliseLicence(body.data_set_description?.licence ?? null);
            const t = body.data_set_description?.tag;
            tags = Array.isArray(t) ? t : t ? [t] : [];
          } catch {
            /* the list entry stands without its details */
          }
        }
        const fmt = lower(d.format);
        yield dataset({
          itemId: String(d.did),
          name: `${d.name}${d.version ? ` (v${d.version})` : ''}`.slice(0, 400),
          publisher: null,
          description: null,
          classification: task,
          licence,
          formats: uniq([fmt, 'parquet']),
          facets: { classification: uniq([task]), licence: [licence], format: uniq([fmt, 'parquet']), rows: uniq([rowBucket(rows)]) },
          data: { did: Number(d.did), rows, features: q('NumberOfFeatures'), classes, tags: tags.slice(0, 30) }
        });
      }
      offset += list.length;
    }
  }
};

// ---------- InvenioRDM (Zenodo) ----------

interface InvenioHit {
  id?: string | number;
  metadata?: {
    title?: string;
    description?: string;
    creators?: { person_or_org?: { name?: string }; name?: string }[];
    rights?: { id?: string; title?: Record<string, string> | string }[];
    license?: { id?: string } | string;
    resource_type?: { id?: string; type?: string; title?: Record<string, string> };
    subjects?: { subject?: string }[];
    keywords?: string[];
    publication_date?: string;
  };
  files?: { entries?: Record<string, { key?: string; size?: number }> } | { key?: string; size?: number }[];
  updated?: string;
}

function invenioItem(h: InvenioHit): CatalogItem | null {
  const m = h.metadata ?? {};
  if (h.id == null) return null;
  const rt = m.resource_type?.id ?? m.resource_type?.type ?? null;
  const kind: ImportKind = rt && /model|software/.test(rt) ? 'model' : 'dataset';
  const lic = normaliseLicence(m.rights?.[0]?.id ?? (typeof m.license === 'string' ? m.license : m.license?.id) ?? null);
  const files = Array.isArray(h.files) ? h.files : Object.values(h.files?.entries ?? {});
  const formats = uniq(files.map((f) => (f.key && f.key.includes('.') ? f.key.split('.').pop()!.toLowerCase() : null)));
  const subjects = uniq([...(m.subjects ?? []).map((x) => x.subject ?? null), ...(m.keywords ?? [])]).slice(0, 30);
  const creator = m.creators?.[0]?.person_or_org?.name ?? m.creators?.[0]?.name ?? null;
  return {
    kind,
    itemId: String(h.id),
    name: (m.title ?? String(h.id)).slice(0, 400),
    publisher: creator,
    description: stripHtml(m.description),
    classification: rt,
    licence: lic,
    formats,
    gated: false,
    sizeBytes: files.reduce((a, f) => a + (f.size ?? 0), 0) || null,
    updated: h.updated ?? m.publication_date ?? null,
    facets: { classification: uniq([rt]), licence: [lic], format: formats, domain: subjects.slice(0, 5), publisher: uniq([creator]) },
    data: { subjects, files: files.length }
  };
}

async function invenioSearch(ctx: AdapterContext, q: string, size: number, page: number): Promise<{ total: number; hits: InvenioHit[] }> {
  const base = opt(ctx, 'query');
  const query = [base, q].filter(Boolean).map((x) => `(${x})`).join(' AND ');
  const { body } = await ctx.fetcher.json<{ hits?: { total?: number | { value?: number }; hits?: InvenioHit[] } }>(join(ctx.repo.baseUrl, `/api/records?size=${size}&page=${page}${query ? `&q=${encodeURIComponent(query)}` : ''}`), ctx.access, { signal: ctx.signal });
  const t = body.hits?.total;
  return { total: typeof t === 'number' ? t : (t?.value ?? 0), hits: body.hits?.hits ?? [] };
}

export const invenioAdapter: RepositoryAdapter = {
  async datasetDetail(ctx, itemId) {
    const { body: rec } = await ctx.fetcher.json<InvenioHit & { links?: { self_html?: string } }>(join(ctx.repo.baseUrl, `/api/records/${encodeURIComponent(itemId)}`), ctx.access, { signal: ctx.signal });
    const it = invenioItem(rec);
    if (!it) throw new SourceError(`${ctx.repo.baseUrl} has no record ${itemId}.`);
    const { body: files } = await ctx.fetcher.json<{ entries?: { key?: string; size?: number; links?: { content?: string } }[] | Record<string, { key?: string; size?: number; links?: { content?: string } }> }>(join(ctx.repo.baseUrl, `/api/records/${encodeURIComponent(itemId)}/files`), ctx.access, { signal: ctx.signal });
    const entries = Array.isArray(files.entries) ? files.entries : Object.values(files.entries ?? {});
    const resources = entries.filter((f) => f.key).map((f) => resource({ id: f.key!, name: f.key!, format: resourceFormat(null, f.key), url: f.links?.content ?? join(ctx.repo.baseUrl, `/api/records/${encodeURIComponent(itemId)}/files/${encodeURIComponent(f.key!)}/content`), bytes: f.size ?? null }));
    return detail({ itemId, name: it.name, revision: it.updated, licence: it.licence, licenceSource: 'the record (rights)', publisher: it.publisher, description: it.description, resources, landingPage: rec.links?.self_html ?? null, data: it.data });
  },
  async probe(ctx) {
    const r = await invenioSearch(ctx, '', 1, 1);
    return `Reachable; ${r.total.toLocaleString('en-US')} records.`;
  },
  async *harvest(ctx) {
    let page = 1;
    let n = 0;
    while (n < ctx.maxItems) {
      const r = await invenioSearch(ctx, '', 100, page++);
      if (!r.hits.length) break;
      for (const h of r.hits) {
        const it = invenioItem(h);
        if (!it || !ctx.repo.kinds.includes(it.kind)) continue;
        if (n++ >= ctx.maxItems) break;
        yield it;
      }
      if (page > 100) break; // InvenioRDM caps paging at 10 000 results
    }
  },
  async search(ctx, query, kind, limit) {
    return (await invenioSearch(ctx, query, limit, 1)).hits.map(invenioItem).filter((x): x is CatalogItem => !!x && x.kind === kind);
  }
};

// ---------- Kaggle ----------

interface KaggleDataset {
  ref?: string;
  title?: string;
  subtitle?: string;
  licenseName?: string;
  totalBytes?: number;
  lastUpdated?: string;
  ownerName?: string;
  creatorName?: string;
  tags?: { name?: string; ref?: string }[];
  usabilityRating?: number;
  downloadCount?: number;
}

const KAGGLE_LICENCES: Record<string, string> = { 'CC0: Public Domain': 'cc0-1.0', 'CC0-1.0': 'cc0-1.0', 'CC BY-SA 4.0': 'cc-by-sa-4.0', 'Attribution 4.0 International (CC BY 4.0)': 'cc-by-4.0', 'CC BY 4.0': 'cc-by-4.0', 'Attribution-NonCommercial-ShareAlike 4.0 International (CC BY-NC-SA 4.0)': 'cc-by-nc-sa-4.0', 'Database: Open Database, Contents: Database Contents': 'odbl-1.0', 'Open Data Commons Open Database License (ODbL) v1.0': 'odbl-1.0', 'ODC Public Domain Dedication and Licence (PDDL)': 'public-domain', 'Apache 2.0': 'apache-2.0', MIT: 'mit', 'GPL 2': 'gpl-2.0', Unknown: 'unknown', Other: 'other', 'other': 'other', 'unknown': 'unknown' };

function kaggleItem(d: KaggleDataset): CatalogItem | null {
  if (!d.ref) return null;
  const tags = uniq((d.tags ?? []).map((t) => t.name ?? null));
  const licence = d.licenseName ? (KAGGLE_LICENCES[d.licenseName] ?? normaliseLicence(d.licenseName)) : 'unknown';
  const owner = d.ownerName ?? d.creatorName ?? d.ref.split('/')[0] ?? null;
  return dataset({
    itemId: d.ref.slice(0, 300),
    name: (d.title ?? d.ref).slice(0, 400),
    publisher: owner,
    description: str(d.subtitle, 2000),
    classification: tags[0] ?? null,
    licence,
    formats: [],
    sizeBytes: d.totalBytes ?? null,
    updated: d.lastUpdated ?? null,
    facets: { classification: tags, licence: [licence], publisher: uniq([owner]) },
    data: { usability: d.usabilityRating ?? null, downloads: d.downloadCount ?? null }
  });
}

async function kaggleList(ctx: AdapterContext, q: string, page: number): Promise<KaggleDataset[]> {
  if (!ctx.repo.hasCredential) throw new NeedsCredential('Kaggle needs an API token (username:key from kaggle.json) recorded for this repository.');
  const { body } = await ctx.fetcher.json<KaggleDataset[]>(join(ctx.repo.baseUrl, `/api/v1/datasets/list?page=${page}&sortBy=hottest${q ? `&search=${encodeURIComponent(q)}` : ''}`), ctx.access, { signal: ctx.signal });
  if (!Array.isArray(body)) throw new SourceError('Kaggle did not answer a dataset list.');
  return body;
}

export const kaggleAdapter: RepositoryAdapter = {
  async datasetDetail(ctx, itemId, cached) {
    // Kaggle serves a dataset as one zip archive, which the row readers do not open: the import is refused at the
    // format check until the archive's files are published individually.
    return detail({ itemId, name: String(cached?.name ?? itemId), resources: [resource({ id: 'zip', name: `${itemId.split('/').pop()}.zip`, format: 'zip', url: join(ctx.repo.baseUrl, `/api/v1/datasets/download/${itemId}`) })], landingPage: join(ctx.repo.baseUrl, `/datasets/${itemId}`), data: cached ?? {} });
  },
  async probe(ctx) {
    await kaggleList(ctx, '', 1);
    return 'Reachable; the recorded token works.';
  },
  async *harvest(ctx) {
    let page = 1;
    let n = 0;
    while (n < ctx.maxItems) {
      const list = await kaggleList(ctx, opt(ctx, 'query') ?? '', page++);
      if (!list.length) break;
      for (const d of list) {
        const it = kaggleItem(d);
        if (!it) continue;
        if (n++ >= ctx.maxItems) break;
        yield it;
      }
      if (page > 500) break;
    }
  },
  async search(ctx, query, _kind, limit) {
    return (await kaggleList(ctx, query, 1)).map(kaggleItem).filter((x): x is CatalogItem => !!x).slice(0, limit);
  }
};
