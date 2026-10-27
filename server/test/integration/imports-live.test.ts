/*
 * 1.7.0: the import adapters against the real public repositories of scripts/import-repositories.json. The block
 * runs when its variable is set, and reaches the internet:
 *
 *   TEST_IMPORT_LIVE=1                 every repository below
 *   TEST_IMPORT_LIVE=ollama,sdmx,...   only the named ones (ollama, ckan, sdmx, ecb, zenodo, dcat)
 *
 * Each case probes the repository, takes the first items of a harvest and, for a dataset source, describes one
 * dataset and reads its first rows. Nothing is stored: the adapters are called with a fetcher of their own.
 */
import { describe, expect, it } from 'vitest';
import { ADAPTERS, type AdapterContext } from '../../src/imports/adapters/index.js';
import { datasetRows, describeDataset } from '../../src/imports/adapters/dataset-rows.js';
import { ImportFetcher } from '../../src/imports/fetcher.js';
import type { CatalogItem, RepoType, SourceRecord } from '../../src/imports/types.js';

const want = (process.env.TEST_IMPORT_LIVE ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const on = (name: string) => want.includes('1') || want.includes(name);
/** What the real service answered, for the person running this by hand. */
const say = (...parts: unknown[]) => process.stdout.write(`${parts.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`);

function context(type: RepoType, baseUrl: string, options: Record<string, unknown> = {}, extraHosts: string[] = [], maxItems = 40): AdapterContext {
  const host = new URL(baseUrl).hostname;
  return {
    repo: { id: 'live', tenantId: 'live', type, baseUrl, kinds: ['dataset', 'model'], options, hasCredential: false },
    fetcher: new ImportFetcher({ allowedHosts: '', timeoutMs: 120_000 }),
    access: { host, hosts: [host, ...extraHosts], auth: async () => ({}) },
    maxItems,
    s: null as never
  };
}

async function first(ctx: AdapterContext, n: number): Promise<CatalogItem[]> {
  const out: CatalogItem[] = [];
  for await (const it of ADAPTERS[ctx.repo.type].harvest(ctx)) {
    out.push(it);
    if (out.length >= n) break;
  }
  return out;
}

async function rows(ctx: AdapterContext, itemId: string, o: { config?: string | null; startPeriod?: string | null; resource?: (name: string, format: string | null) => boolean }, n: number): Promise<SourceRecord[]> {
  const d = await describeDataset(ctx, itemId);
  const resources = o.resource ? d.resources.filter((r) => o.resource!(r.name, r.format)).slice(0, 1) : d.resources.slice(0, 1);
  expect(resources.length, `a readable resource of ${itemId}: ${d.resources.map((r) => `${r.name} (${r.format})`).join(', ').slice(0, 400)}`).toBe(1);
  const out: SourceRecord[] = [];
  for await (const r of datasetRows(ctx, itemId, { config: o.config ?? null, splits: [], resources, startPeriod: o.startPeriod ?? null, limit: n, budget: { used: 0, max: 64 * 1024 * 1024 } })) {
    out.push(r);
    if (out.length >= n) break;
  }
  return out;
}

describe.skipIf(!want.length)('import adapters against the real repositories', () => {
  it.skipIf(!on('ollama'))('Ollama registry: named tags, with no tag listing', async () => {
    const ctx = context('ollama', 'https://registry.ollama.ai', { models: ['library/nomic-embed-text', 'library/qwen3-embedding:0.6b'] }, ['*.r2.cloudflarestorage.com']);
    expect(await ADAPTERS.ollama.probe(ctx)).toMatch(/Reachable/);
    const items = await first(ctx, 2);
    expect(items.map((i) => i.itemId)).toEqual(['nomic-embed-text', 'qwen3-embedding']);
    expect((items[0]!.data.variants as { tag: string; digest: string }[])[0]).toMatchObject({ tag: 'latest', digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
    expect((items[1]!.data.variants as { tag: string }[]).map((v) => v.tag)).toEqual(['0.6b']);
    const d = await ADAPTERS.ollama.inspect!(ctx, 'nomic-embed-text', null);
    expect(d.revision).toMatch(/^sha256:/);
    expect(d.files.some((f) => f.format === 'gguf')).toBe(true);
    say('ollama', items.map((i) => `${i.itemId} ${i.licence} ${i.sizeBytes}`), d.name, d.licence);
  }, 180_000);

  it.skipIf(!on('ckan'))('CKAN portals: open.canada.ca, data.gov.uk, data.gov.au', async () => {
    for (const base of ['https://open.canada.ca/data', 'https://ckan.publishing.service.gov.uk', 'https://data.gov.au/data']) {
      const ctx = context('ckan', base, {}, [], 5);
      const probe = await ADAPTERS.ckan.probe(ctx);
      const items = await first(ctx, 5);
      expect(items.length).toBe(5);
      const found = await ADAPTERS.ckan.search!(ctx, 'population', 'dataset', 3);
      say('ckan', base, probe, items[0]!.name, items[0]!.licence, items[0]!.formats, found.length);
      const d = await describeDataset(ctx, items[0]!.itemId);
      expect(d.resources.length + 1).toBeGreaterThan(0);
    }
  }, 300_000);

  it.skipIf(!on('sdmx'))('Eurostat: the dataflow stubs, a dataflow and SDMX-CSV rows', async () => {
    const ctx = context('sdmx', 'https://ec.europa.eu/eurostat/api/dissemination/sdmx/2.1', {}, [], 20_000);
    const items = await first(ctx, 20_000);
    expect(items.length).toBeGreaterThan(5000);
    const gdp = items.find((i) => i.data.flow === 'NAMA_10_GDP')!;
    expect(gdp.name).toMatch(/GDP|Gross domestic product/i);
    const got = await rows(ctx, gdp.itemId, { config: 'A.CP_MEUR.B1GQ.DE', startPeriod: '2020' }, 3);
    expect(got.length).toBe(3);
    expect(Object.keys(got[0]!.values)).toEqual(expect.arrayContaining(['geo', 'TIME_PERIOD', 'OBS_VALUE']));
    say('eurostat', items.length, gdp.itemId, gdp.name, gdp.classification, got[0]);
  }, 600_000);

  it.skipIf(!on('ecb'))('ECB: the dataflows and CSV rows', async () => {
    const ctx = context('sdmx', 'https://data-api.ecb.europa.eu/service', {}, [], 5000);
    const items = await first(ctx, 5000);
    expect(items.length).toBeGreaterThan(50);
    const exr = items.find((i) => i.data.flow === 'EXR')!;
    const got = await rows(ctx, exr.itemId, { config: 'D.USD.EUR.SP00.A', startPeriod: '2026-10' }, 3);
    expect(got.length).toBeGreaterThan(0);
    expect(Object.keys(got[0]!.values)).toEqual(expect.arrayContaining(['CURRENCY', 'TIME_PERIOD', 'OBS_VALUE']));
    say('ecb', items.length, exr.itemId, exr.name, exr.classification, got[0]!.id);
  }, 300_000);

  it.skipIf(!on('zenodo'))('Zenodo: pages of 25 for an anonymous caller', async () => {
    const ctx = context('invenio', 'https://zenodo.org', { query: 'resource_type.type:dataset' }, [], 30);
    ctx.repo.kinds = ['dataset'];
    const items = await first(ctx, 30);
    expect(items.length).toBe(30);
    const d = await describeDataset(ctx, items[0]!.itemId);
    say('zenodo', items[0]!.itemId, items[0]!.name, items[0]!.licence, items[0]!.formats, d.resources.slice(0, 3).map((r) => `${r.name} ${r.format} ${r.url}`));
    expect(d.name).toBeTruthy();
  }, 300_000);

  it.skipIf(!on('dcat'))('data.europa.eu: a hydra-paged dataset listing of named graphs', async () => {
    const ctx = context('dcat', 'https://data.europa.eu/api/hub/repo/datasets?catalogue=jrc&valueType=metadata&limit=20', {}, [], 45);
    expect(await ADAPTERS.dcat.probe(ctx)).toMatch(/20 datasets, with more pages/);
    const items = await first(ctx, 45);
    expect(items.length).toBe(45);
    expect(new Set(items.map((i) => i.itemId)).size).toBe(45);
    const d = await describeDataset(ctx, items[0]!.itemId);
    expect(d.name).toBe(items[0]!.name);
    say('dcat', items[0]!.itemId, items[0]!.name, items[0]!.publisher, items[0]!.licence, items[0]!.formats, items[0]!.classification, d.resources.slice(0, 3).map((r) => `${r.name} ${r.format} ${r.url}`));
  }, 300_000);
});
