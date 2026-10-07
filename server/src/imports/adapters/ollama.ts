import { createHash } from 'node:crypto';
import { formatOf, normaliseLicence, parameterBucket } from '../formats.js';
import type { FetchInit, FetchResult } from '../fetcher.js';
import { SourceError, type CatalogItem, type RemoteFile, type Variant } from '../types.js';
import { join, readAll, str, uniq, type AdapterContext, type RepositoryAdapter } from './types.js';

/*
 * An Ollama compatible registry (registry.ollama.ai, or any OCI distribution registry holding Ollama models): tags
 * from `/v2/<name>/tags/list`, the manifest of each tag (its digest is what Ollama reports for the model, so it is
 * the pin), the config blob (family, parameter size, quantization) and the license layer, read from the manifest at
 * request time. Blobs download with ranges, so a pull resumes. The registry's bearer-token flow is followed when a
 * request answers 401 with `WWW-Authenticate: Bearer`.
 *
 * The public library has no catalogue endpoint; the repository's `models` option names the models to track. A
 * private registry that answers `/v2/_catalog` is harvested whole.
 */

const MANIFEST_ACCEPT = 'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json';

interface Layer {
  mediaType: string;
  digest: string;
  size: number;
}
interface Manifest {
  config?: Layer;
  layers?: Layer[];
}
interface ConfigBlob {
  model_format?: string;
  model_family?: string;
  model_families?: string[];
  model_type?: string;
  file_type?: string;
}

const tokens = new WeakMap<AdapterContext, Map<string, string>>();

const repoPath = (itemId: string) => (itemId.includes('/') ? itemId : `library/${itemId}`);

function parseChallenge(h: string | null): { realm: string; service?: string; scope?: string } | null {
  if (!h || !/^bearer\s/i.test(h)) return null;
  const out: Record<string, string> = {};
  for (const m of h.slice(7).matchAll(/(\w+)="([^"]*)"/g)) out[m[1]!] = m[2]!;
  return out.realm ? { realm: out.realm, ...(out.service ? { service: out.service } : {}), ...(out.scope ? { scope: out.scope } : {}) } : null;
}

/** A registry request with the bearer-token flow. */
async function call(ctx: AdapterContext, url: string, init: FetchInit = {}): Promise<FetchResult> {
  const cache = tokens.get(ctx) ?? new Map<string, string>();
  tokens.set(ctx, cache);
  const path = new URL(url).pathname.split('/').slice(2, -2).join('/');
  const cached = cache.get(path);
  const send = (token: string | undefined) => ctx.fetcher.request(url, ctx.access, { ...init, auth: false, headers: { ...(init.headers ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  let r = await send(cached);
  if (r.status !== 401) return r;
  const ch = parseChallenge(r.headers.get('www-authenticate'));
  await r.text().catch(() => '');
  if (!ch) return r;
  const realm = new URL(ch.realm);
  if (ch.service) realm.searchParams.set('service', ch.service);
  if (ch.scope) realm.searchParams.set('scope', ch.scope);
  // The recorded username:password goes to the token realm only when it is the registry's own host.
  const t = await ctx.fetcher.json<{ token?: string; access_token?: string }>(realm.toString(), ctx.access, { signal: ctx.signal, auth: realm.hostname === new URL(ctx.repo.baseUrl).hostname });
  const token = t.body.token ?? t.body.access_token;
  if (!token) throw new SourceError('The registry token service answered no token.');
  cache.set(path, token);
  r = await send(token);
  return r;
}

async function getJson<T>(ctx: AdapterContext, url: string, accept = 'application/json'): Promise<{ body: T; digest: string | null; raw: Buffer }> {
  const r = await call(ctx, url, { headers: { accept }, signal: ctx.signal });
  const raw = await readAll(r.body, 8 * 1024 * 1024);
  if (r.status === 401 || r.status === 403) throw new SourceError(`The registry refused ${new URL(url).pathname} (${r.status}).`, r.status);
  if (r.status < 200 || r.status >= 300) throw new SourceError(`The registry answered ${r.status} for ${new URL(url).pathname}.`, r.status);
  try {
    return { body: JSON.parse(raw.toString('utf8')) as T, digest: r.headers.get('docker-content-digest'), raw };
  } catch {
    throw new SourceError(`The registry did not answer JSON for ${new URL(url).pathname}.`);
  }
}

async function blobText(ctx: AdapterContext, path: string, digest: string, max = 256 * 1024): Promise<string> {
  const r = await call(ctx, join(ctx.repo.baseUrl, `/v2/${path}/blobs/${digest}`), { signal: ctx.signal });
  if (r.status !== 200) {
    await r.text().catch(() => '');
    throw new SourceError(`The registry answered ${r.status} for blob ${digest.slice(0, 19)}.`, r.status);
  }
  return (await readAll(r.body, max)).toString('utf8');
}

interface TagInfo {
  tag: string;
  digest: string;
  size: number;
  config: ConfigBlob;
  licence: string | null;
  manifest: Manifest;
}

async function tagInfo(ctx: AdapterContext, itemId: string, ref: string, withLicence: boolean): Promise<TagInfo> {
  const path = repoPath(itemId);
  const m = await getJson<Manifest>(ctx, join(ctx.repo.baseUrl, `/v2/${path}/manifests/${ref}`), MANIFEST_ACCEPT);
  const digest = `sha256:${createHash('sha256').update(m.raw).digest('hex')}`;
  if (m.digest && m.digest !== digest) throw new SourceError(`The registry's Docker-Content-Digest for ${itemId}:${ref} does not match the manifest it sent.`);
  const layers = m.body.layers ?? [];
  let config: ConfigBlob = {};
  if (m.body.config?.digest) {
    try {
      config = JSON.parse(await blobText(ctx, path, m.body.config.digest, 64 * 1024)) as ConfigBlob;
    } catch {
      config = {};
    }
  }
  const lic = layers.find((l) => l.mediaType === 'application/vnd.ollama.image.license');
  const licence = withLicence && lic ? normaliseLicence(await blobText(ctx, path, lic.digest, 512 * 1024).catch(() => '')) : null;
  return { tag: ref, digest, size: layers.reduce((a, l) => a + l.size, 0) + (m.body.config?.size ?? 0), config, licence, manifest: m.body };
}

async function tagsOf(ctx: AdapterContext, itemId: string): Promise<string[]> {
  const { body } = await getJson<{ tags?: string[] }>(ctx, join(ctx.repo.baseUrl, `/v2/${repoPath(itemId)}/tags/list`));
  return (body.tags ?? []).filter((t) => /^[\w][\w.-]{0,127}$/.test(t));
}

const short = (itemId: string) => (itemId.startsWith('library/') ? itemId.slice(8) : itemId);

async function item(ctx: AdapterContext, itemId: string): Promise<CatalogItem> {
  const maxTags = Math.max(1, Math.min(200, Number(ctx.repo.options.maxTags ?? 25)));
  const tags = (await tagsOf(ctx, itemId)).slice(0, maxTags);
  const infos: TagInfo[] = [];
  for (const [i, t] of tags.entries()) infos.push(await tagInfo(ctx, itemId, t, i === 0));
  const licence = infos[0]?.licence ?? 'unknown';
  const family = uniq(infos.map((x) => x.config.model_family));
  const quants = uniq(infos.map((x) => x.config.file_type));
  const params = uniq(infos.map((x) => parameterBucket(x.config.model_type)));
  return {
    kind: 'model',
    itemId: short(itemId),
    name: short(itemId),
    publisher: itemId.includes('/') && !itemId.startsWith('library/') ? itemId.split('/')[0]! : null,
    description: null,
    classification: family[0] ?? null,
    licence,
    formats: ['gguf'],
    gated: false,
    sizeBytes: infos[0]?.size ?? null,
    updated: null,
    facets: { classification: family, family, format: ['gguf'], licence: [licence], parameters: params, quantization: quants, access: ['open'] },
    data: { variants: infos.map((x) => ({ tag: x.tag, digest: x.digest, size: x.size, quantization: x.config.file_type ?? null, parameters: x.config.model_type ?? null })), tags: tags.length }
  };
}

export const ollamaAdapter: RepositoryAdapter = {
  async probe(ctx) {
    const r = await call(ctx, join(ctx.repo.baseUrl, '/v2/'), { signal: ctx.signal });
    await r.text().catch(() => '');
    if (r.status !== 200 && r.status !== 401) throw new SourceError(`The registry answered ${r.status} for /v2/.`, r.status);
    return 'Reachable (OCI distribution API).';
  },

  async *harvest(ctx) {
    let names: string[] = Array.isArray(ctx.repo.options.models) ? (ctx.repo.options.models as unknown[]).filter((x): x is string => typeof x === 'string') : [];
    if (!names.length) {
      try {
        const { body } = await getJson<{ repositories?: string[] }>(ctx, join(ctx.repo.baseUrl, `/v2/_catalog?n=${Math.min(ctx.maxItems, 10_000)}`));
        names = body.repositories ?? [];
      } catch (err) {
        if (err instanceof SourceError && (err.status === 404 || err.status === 401 || err.status === 403)) throw new SourceError('This registry has no catalogue endpoint. Name the models to track in the repository\'s options (`models`).');
        throw err;
      }
    }
    let n = 0;
    for (const name of names) {
      if (n++ >= ctx.maxItems) break;
      yield await item(ctx, name);
    }
  },

  async inspect(ctx, itemId, revision) {
    const tags = await tagsOf(ctx, itemId);
    const ref = revision || (tags.includes('latest') ? 'latest' : tags[0]);
    if (!ref) throw new SourceError(`${itemId} has no tags.`);
    const t = await tagInfo(ctx, itemId, ref, true);
    const files: RemoteFile[] = [
      { name: 'manifest.json', size: null, pin: t.digest, format: 'manifest', mediaType: null },
      ...(t.manifest.config ? [{ name: `config-${t.manifest.config.digest.slice(7, 19)}`, size: t.manifest.config.size, pin: t.manifest.config.digest, format: 'metadata' as const, mediaType: t.manifest.config.mediaType }] : []),
      ...(t.manifest.layers ?? []).map((l) => ({ name: `${l.mediaType.replace('application/vnd.ollama.image.', '')}-${l.digest.slice(7, 19)}`, size: l.size, pin: l.digest, format: formatOf('', l.mediaType), mediaType: l.mediaType }))
    ];
    const variants: Variant[] = [{ id: ref, quantization: t.config.file_type ?? null, size: t.size, files: files.map((f) => f.name), digest: t.digest }, ...tags.filter((x) => x !== ref).slice(0, 100).map((x) => ({ id: x, quantization: null, size: null, files: [], digest: null }))];
    return {
      itemId: short(itemId),
      name: `${short(itemId)}:${ref}`,
      revision: t.digest,
      files,
      variants,
      gated: false,
      access: 'open',
      licence: t.licence ?? 'unknown',
      licenceSource: `the license layer of the manifest ${t.digest.slice(0, 19)}`,
      classification: t.config.model_family ?? null,
      family: t.config.model_family ?? null,
      parameters: str(t.config.model_type, 40),
      capabilities: [],
      contextLength: null,
      data: { tag: ref, quantization: t.config.file_type ?? null, format: t.config.model_format ?? null }
    };
  },

  async open(ctx, itemId, revision, file, from) {
    const path = repoPath(itemId);
    const url = file.format === 'manifest' ? join(ctx.repo.baseUrl, `/v2/${path}/manifests/${file.pin}`) : join(ctx.repo.baseUrl, `/v2/${path}/blobs/${file.pin}`);
    const r = await call(ctx, url, { from: file.format === 'manifest' ? 0 : from, signal: ctx.signal, headers: file.format === 'manifest' ? { accept: MANIFEST_ACCEPT } : {} });
    if (r.status !== 200 && r.status !== 206) {
      await r.text().catch(() => '');
      throw new SourceError(`${file.name}: the registry answered ${r.status}.`, r.status);
    }
    if (!r.body) throw new SourceError(`${file.name}: empty response.`);
    return { body: r.body, partial: r.status === 206 };
  }
};
