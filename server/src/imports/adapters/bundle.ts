import { json } from '../../db/knex.js';
import { formatOf, normaliseLicence, quantizationOf } from '../formats.js';
import { SourceError, type CatalogItem, type ModelDetail, type RemoteFile } from '../types.js';
import { uniq, type AdapterContext, type RepositoryAdapter } from './types.js';

/*
 * The signed import share (B-3803, bundle mode). Model files reach an air-gapped instance in platform bundles: signed
 * by the staging key, verified (signature, digests, SBOM, licences) and promoted to the `models` mirror store
 * (`mirrors/models/sha256/<hex>`, with an index per bundle). This adapter lists what promoted bundles carry, one item
 * per directory (`<dir>/<file>`), and reads the files from the store; nothing goes over the network. A directory may
 * carry `import.json` from staging: `{ licence, source, item, revision }`.
 */

export interface BundleFile {
  path: string;
  sha256: string;
  size: number;
  bundle: string;
  promotedAt: number;
}

/** Every model file in promoted bundles, newest bundle first (a path in two bundles: the newer one wins). */
export async function promotedModelFiles(ctx: Pick<AdapterContext, 's'>): Promise<BundleFile[]> {
  const rows = (await ctx.s.db('platform_bundles').where({ state: 'in production' }).orderBy('promoted_at', 'desc').limit(1000)) as Record<string, unknown>[];
  const out: BundleFile[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const report = json<{ byMirror?: Record<string, number> }>(r.report, {});
    if (!(report.byMirror?.models ?? 0)) continue;
    const idx = await ctx.s.blobs.get(`mirrors/models/index/${String(r.name)}.json`);
    if (!idx) continue;
    let files: { path: string; sha256: string; size: number }[];
    try {
      files = (JSON.parse(idx.toString('utf8')) as { files: { path: string; sha256: string; size: number }[] }).files;
    } catch {
      continue;
    }
    for (const f of files) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      out.push({ ...f, bundle: String(r.name), promotedAt: Number(r.promoted_at ?? 0) });
    }
  }
  return out;
}

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.');
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

async function staged(ctx: AdapterContext, files: BundleFile[]): Promise<{ licence?: string; source?: string; item?: string; revision?: string }> {
  const meta = files.find((f) => baseOf(f.path) === 'import.json');
  if (!meta) return {};
  const b = await ctx.s.blobs.get(`mirrors/models/sha256/${meta.sha256}`);
  try {
    return b ? (JSON.parse(b.toString('utf8')) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export const bundleAdapter: RepositoryAdapter = {
  async probe(ctx) {
    const files = await promotedModelFiles(ctx);
    return `${files.length} model files in promoted bundles.`;
  },

  async *harvest(ctx) {
    const files = await promotedModelFiles(ctx);
    const dirs = new Map<string, BundleFile[]>();
    for (const f of files) dirs.set(dirOf(f.path), [...(dirs.get(dirOf(f.path)) ?? []), f]);
    let n = 0;
    for (const [dir, fs] of dirs) {
      if (n++ >= ctx.maxItems) break;
      const meta = await staged(ctx, fs);
      const licence = normaliseLicence(meta.licence ?? null);
      const formats = uniq(fs.map((f) => formatOf(f.path)).filter((f) => f !== 'metadata' && f !== 'other'));
      const item: CatalogItem = {
        kind: 'model',
        itemId: dir.slice(0, 300),
        name: (meta.item ?? dir).slice(0, 400),
        publisher: meta.source ?? null,
        description: null,
        classification: null,
        licence,
        formats,
        gated: false,
        sizeBytes: fs.reduce((a, f) => a + f.size, 0),
        updated: new Date(Math.max(...fs.map((f) => f.promotedAt))).toISOString(),
        facets: { format: formats, licence: [licence], access: ['open'], quantization: uniq(fs.map((f) => (formatOf(f.path) === 'gguf' ? quantizationOf(baseOf(f.path)) : null))) },
        data: { bundles: uniq(fs.map((f) => f.bundle)), files: fs.length }
      };
      yield item;
    }
  },

  async inspect(ctx, itemId) {
    const fs = (await promotedModelFiles(ctx)).filter((f) => dirOf(f.path) === itemId);
    if (!fs.length) throw new SourceError(`No promoted bundle carries ${itemId}.`, 404);
    const meta = await staged(ctx, fs);
    const files: RemoteFile[] = fs.map((f) => ({ name: f.path.slice(itemId === '.' ? 0 : itemId.length + 1), size: f.size, pin: `sha256:${f.sha256}`, format: formatOf(f.path) }));
    const bundles = uniq(fs.map((f) => f.bundle));
    const detail: ModelDetail = {
      itemId,
      name: meta.item ?? itemId,
      revision: meta.revision ?? `bundle ${bundles.join(', ')}`,
      files,
      variants: files.filter((f) => f.format === 'gguf').map((f) => ({ id: f.name, quantization: quantizationOf(f.name), size: f.size, files: [f.name], digest: null })),
      gated: false,
      access: 'open',
      licence: normaliseLicence(meta.licence ?? null),
      licenceSource: meta.licence ? 'import.json written at staging and signed in the bundle' : 'not stated in the bundle',
      classification: null,
      family: null,
      parameters: null,
      capabilities: [],
      contextLength: null,
      data: { bundles, source: meta.source ?? null }
    };
    return detail;
  },

  async open(ctx, _itemId, _revision, file, from) {
    const hex = (file.pin ?? '').replace(/^sha256:/, '');
    if (!/^[a-f0-9]{64}$/.test(hex)) throw new SourceError(`${file.name} has no bundle digest.`);
    const got = await ctx.s.blobs.getStream(`mirrors/models/sha256/${hex}`);
    if (!got) throw new SourceError(`${file.name} is missing from the models mirror store.`);
    // The store is local: resuming re-reads and skips what is already staged.
    let skip = from;
    const body = (async function* () {
      for await (const c of got.stream as AsyncIterable<Buffer>) {
        if (skip >= c.length) {
          skip -= c.length;
          continue;
        }
        yield skip ? c.subarray(skip) : c;
        skip = 0;
      }
    })();
    return { body, partial: true };
  }
};
