import { formatOf, normaliseLicence, parameterBucket, quantizationOf } from '../formats.js';
import { SourceError, type CatalogItem, type ModelDetail, type RemoteFile, type Variant } from '../types.js';
import { join, str, uniq, type RepositoryAdapter } from './types.js';

/*
 * A Hugging Face compatible hub (huggingface.co, or a mirror that speaks the same API): `GET /api/models` and
 * `/api/datasets` for the catalogue (search, pipeline tags, licence and format tags), `/api/models/<id>/revision/<rev>`
 * for the files of one commit with their LFS sha256 (or git blob ids for small files), and `/<id>/resolve/<sha>/<file>`
 * for downloads, which redirect to the CDN. The licence is read from the model card at the pinned commit, never from
 * the snapshot.
 */

interface HfListItem {
  id?: string;
  modelId?: string;
  author?: string;
  pipeline_tag?: string;
  library_name?: string;
  tags?: string[];
  downloads?: number;
  likes?: number;
  lastModified?: string;
  gated?: boolean | string;
  private?: boolean;
  description?: string;
  siblings?: { rfilename: string; size?: number; blobId?: string; lfs?: { sha256?: string; size?: number } }[];
  safetensors?: { total?: number };
  cardData?: { license?: string | string[]; license_name?: string; pipeline_tag?: string };
  config?: { model_type?: string; architectures?: string[] };
  sha?: string;
  gguf?: { total?: number; context_length?: number; architecture?: string };
}

const tagValues = (tags: string[] | undefined, prefix: string) => (tags ?? []).filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length));

const SIZE_BUCKETS: Record<string, string> = { 'n<1K': 'under 10k rows', '1K<n<10K': 'under 10k rows', '10K<n<100K': '10k to 1M rows', '100K<n<1M': '10k to 1M rows', '1M<n<10M': '1M to 100M rows', '10M<n<100M': '1M to 100M rows', '100M<n<1B': 'over 100M rows', '1B<n<10B': 'over 100M rows', '10B<n<100B': 'over 100M rows', '100B<n<1T': 'over 100M rows', 'n>1T': 'over 100M rows' };

function licenceOf(m: HfListItem): string {
  const card = m.cardData?.license;
  const raw = Array.isArray(card) ? card[0] : card;
  if (raw === 'other' && m.cardData?.license_name) return normaliseLicence(m.cardData.license_name);
  return normaliseLicence(raw ?? tagValues(m.tags, 'license:')[0] ?? null);
}

function modelItem(m: HfListItem): CatalogItem {
  const id = m.id ?? m.modelId ?? '';
  const tags = m.tags ?? [];
  const exts = uniq((m.siblings ?? []).map((s) => formatOf(s.rfilename)).filter((f) => f !== 'metadata' && f !== 'other'));
  const formats = uniq([...exts, ...['gguf', 'safetensors', 'onnx'].filter((f) => tags.includes(f)), ...(tags.includes('pytorch') && !exts.length ? ['pickle'] : [])]);
  const licence = licenceOf(m);
  const gated = !!m.gated;
  const params = m.safetensors?.total ?? m.gguf?.total ?? null;
  return {
    kind: 'model',
    itemId: id,
    name: id,
    publisher: m.author ?? (id.includes('/') ? id.split('/')[0]! : null),
    description: null,
    classification: m.pipeline_tag ?? null,
    licence,
    formats,
    gated,
    sizeBytes: null,
    updated: m.lastModified ?? null,
    facets: {
      classification: uniq([m.pipeline_tag]),
      format: formats,
      licence: [licence],
      parameters: uniq([parameterBucket(params)]),
      access: [gated ? 'gated' : 'open'],
      library: uniq([m.library_name])
    },
    data: { downloads: m.downloads ?? null, likes: m.likes ?? null, tags: tags.slice(0, 50), parameters: params }
  };
}

function datasetItem(d: HfListItem): CatalogItem {
  const id = d.id ?? '';
  const tags = d.tags ?? [];
  const licence = licenceOf(d);
  const classes = tagValues(tags, 'task_categories:');
  const formats = tagValues(tags, 'format:');
  const rows = uniq(tagValues(tags, 'size_categories:').map((s) => SIZE_BUCKETS[s] ?? null));
  return {
    kind: 'dataset',
    itemId: id,
    name: id,
    publisher: d.author ?? (id.includes('/') ? id.split('/')[0]! : null),
    description: str(d.description, 2000),
    classification: classes[0] ?? null,
    licence,
    formats,
    gated: !!d.gated,
    sizeBytes: null,
    updated: d.lastModified ?? null,
    facets: { classification: uniq(classes), licence: [licence], format: uniq(formats), rows, region: uniq(tagValues(tags, 'region:')), publisher: uniq([d.author]) },
    data: { downloads: d.downloads ?? null, likes: d.likes ?? null, tags: tags.slice(0, 50), languages: tagValues(tags, 'language:').slice(0, 20) }
  };
}

const nextLink = (link: string | null): string | null => {
  if (!link) return null;
  const m = /<([^>]+)>;\s*rel="?next"?/.exec(link);
  return m ? m[1]! : null;
};

export const hfAdapter: RepositoryAdapter = {
  async probe(ctx) {
    const { body } = await ctx.fetcher.json<unknown[]>(join(ctx.repo.baseUrl, '/api/models?limit=1'), ctx.access, { signal: ctx.signal });
    if (!Array.isArray(body)) throw new SourceError('The hub did not answer a model list.');
    if (ctx.repo.hasCredential) {
      const who = await ctx.fetcher.json<{ name?: string }>(join(ctx.repo.baseUrl, '/api/whoami-v2'), ctx.access, { signal: ctx.signal });
      return `Reachable; the recorded token belongs to ${who.body.name ?? 'an unnamed account'}.`;
    }
    return 'Reachable anonymously.';
  },

  async *harvest(ctx) {
    const search = typeof ctx.repo.options.search === 'string' ? ctx.repo.options.search : '';
    const author = typeof ctx.repo.options.author === 'string' ? ctx.repo.options.author : '';
    for (const kind of ctx.repo.kinds) {
      const path = kind === 'model' ? 'models' : 'datasets';
      let url: string | null = join(ctx.repo.baseUrl, `/api/${path}?full=true&sort=downloads&direction=-1&limit=${Math.min(1000, ctx.maxItems)}${search ? `&search=${encodeURIComponent(search)}` : ''}${author ? `&author=${encodeURIComponent(author)}` : ''}`);
      let n = 0;
      while (url && n < ctx.maxItems) {
        const { body, headers }: { body: HfListItem[]; headers: Headers } = await ctx.fetcher.json<HfListItem[]>(url, ctx.access, { signal: ctx.signal });
        if (!Array.isArray(body) || !body.length) break;
        for (const m of body) {
          if (n >= ctx.maxItems) break;
          if (!(m.id ?? m.modelId) || m.private) continue;
          n++;
          yield kind === 'model' ? modelItem(m) : datasetItem(m);
        }
        url = nextLink(headers.get('link'));
      }
    }
  },

  async search(ctx, query, kind, limit) {
    const path = kind === 'model' ? 'models' : 'datasets';
    const { body } = await ctx.fetcher.json<HfListItem[]>(join(ctx.repo.baseUrl, `/api/${path}?full=true&sort=downloads&direction=-1&limit=${limit}&search=${encodeURIComponent(query)}`), ctx.access, { signal: ctx.signal });
    if (!Array.isArray(body)) throw new SourceError('The hub did not answer a list.');
    return body.filter((m) => (m.id ?? m.modelId) && !m.private).map((m) => (kind === 'model' ? modelItem(m) : datasetItem(m)));
  },

  async inspect(ctx, itemId, revision) {
    const rev = revision || 'main';
    const { body: m } = await ctx.fetcher.json<HfListItem>(join(ctx.repo.baseUrl, `/api/models/${itemId}/revision/${encodeURIComponent(rev)}?blobs=true`), ctx.access, { signal: ctx.signal });
    if (!m.sha) throw new SourceError(`The hub did not name the commit of ${itemId} at ${rev}.`);
    const files: RemoteFile[] = (m.siblings ?? []).map((s) => ({
      name: s.rfilename,
      size: s.lfs?.size ?? s.size ?? null,
      pin: s.lfs?.sha256 ? `sha256:${s.lfs.sha256}` : s.blobId ? `gitsha1:${s.blobId}` : null,
      format: formatOf(s.rfilename)
    }));
    const variants: Variant[] = files.filter((f) => f.format === 'gguf').map((f) => ({ id: f.name, quantization: quantizationOf(f.name), size: f.size, files: [f.name], digest: null }));
    let access: ModelDetail['access'] = m.gated ? 'gated' : 'open';
    if (m.gated) {
      // Gated: the API lists the files, but only an account that accepted the gate can download them.
      const probe = files.find((f) => f.format === 'metadata') ?? files[0];
      if (probe) {
        const r = await ctx.fetcher.request(join(ctx.repo.baseUrl, `/${itemId}/resolve/${m.sha}/${encodeURI(probe.name)}`), ctx.access, { method: 'HEAD', signal: ctx.signal });
        await r.text().catch(() => '');
        access = r.status >= 200 && r.status < 400 ? 'granted' : 'gated';
      }
    }
    const params = m.safetensors?.total ?? m.gguf?.total ?? null;
    const tags = m.tags ?? [];
    return {
      itemId,
      name: itemId,
      revision: m.sha,
      files,
      variants,
      gated: !!m.gated,
      access,
      licence: licenceOf(m),
      licenceSource: `the model card at commit ${m.sha.slice(0, 12)}`,
      classification: m.pipeline_tag ?? m.cardData?.pipeline_tag ?? null,
      family: m.config?.model_type ?? m.gguf?.architecture ?? null,
      parameters: params ? String(params) : null,
      capabilities: m.pipeline_tag === 'feature-extraction' || m.pipeline_tag === 'sentence-similarity' ? ['embedding'] : m.pipeline_tag === 'text-generation' || m.pipeline_tag === 'image-text-to-text' ? ['completion'] : [],
      contextLength: m.gguf?.context_length ?? null,
      data: { tags: tags.slice(0, 50), library: m.library_name ?? null, downloads: m.downloads ?? null }
    };
  },

  async acceptGate(ctx, itemId) {
    if (!ctx.repo.hasCredential) throw new SourceError('A gated repository needs a read token recorded for this repository; the gate is accepted with that token.');
    const who = await ctx.fetcher.json<{ name?: string }>(join(ctx.repo.baseUrl, '/api/whoami-v2'), ctx.access, { signal: ctx.signal });
    const r = await ctx.fetcher.request(join(ctx.repo.baseUrl, `/${itemId}/ask-access`), ctx.access, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '', signal: ctx.signal });
    await r.text().catch(() => '');
    if (r.status >= 400) throw new SourceError(`The hub refused the access request for ${itemId} (${r.status}).`, r.status);
    return { account: who.body.name ?? null };
  },

  async open(ctx, itemId, revision, file, from) {
    const r = await ctx.fetcher.request(join(ctx.repo.baseUrl, `/${itemId}/resolve/${revision}/${file.name.split('/').map(encodeURIComponent).join('/')}`), ctx.access, { from, signal: ctx.signal });
    if (r.status === 401 || r.status === 403) {
      await r.text().catch(() => '');
      throw new SourceError(`${file.name}: the hub refused the download (${r.status}). For a gated repository, accept the gate with the recorded token.`, r.status);
    }
    if (r.status !== 200 && r.status !== 206) {
      await r.text().catch(() => '');
      throw new SourceError(`${file.name}: the hub answered ${r.status}.`, r.status);
    }
    if (!r.body) throw new SourceError(`${file.name}: empty response.`);
    return { body: r.body, partial: r.status === 206 };
  }
};
