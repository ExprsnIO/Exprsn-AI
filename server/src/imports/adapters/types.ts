import type { Services } from '../../services.js';
import type { ImportFetcher, RepoAccess } from '../fetcher.js';
import type { DatasetResource } from '../rows.js';
import type { CatalogItem, ImportKind, ModelDetail, PinnedFile, RepoType } from '../types.js';

export interface AdapterRepo {
  id: string;
  tenantId: string;
  type: RepoType;
  baseUrl: string;
  kinds: ImportKind[];
  options: Record<string, unknown>;
  hasCredential: boolean;
}

export interface AdapterContext {
  repo: AdapterRepo;
  fetcher: ImportFetcher;
  access: RepoAccess;
  signal?: AbortSignal;
  /** The most items a harvest keeps, per kind. */
  maxItems: number;
  s: Services;
}

export interface OpenedFile {
  body: AsyncIterable<Uint8Array>;
  /** True when the source honoured the requested offset (206); false when it sent the whole file again. */
  partial: boolean;
}

/**
 * One repository type. `harvest` and `probe` are required; `search` when the source can be searched live; the model
 * methods only for the types that import models (B-3803).
 */
export interface RepositoryAdapter {
  /** A cheap request that shows the source answers (and that the credential works when there is one). */
  probe(ctx: AdapterContext): Promise<string>;
  /** The catalogue snapshot, item by item (the caller stops at `maxItems`). */
  harvest(ctx: AdapterContext): AsyncIterable<CatalogItem>;
  search?(ctx: AdapterContext, query: string, kind: ImportKind, limit: number): Promise<CatalogItem[]>;
  inspect?(ctx: AdapterContext, itemId: string, revision?: string | null): Promise<ModelDetail>;
  acceptGate?(ctx: AdapterContext, itemId: string): Promise<{ account: string | null }>;
  open?(ctx: AdapterContext, itemId: string, revision: string, file: PinnedFile, from: number): Promise<OpenedFile>;
  /**
   * B-3804: what a dataset can be read from: its configurations, splits and resources (files or paged APIs), the
   * licence as the source states it now, and the update frequency a knowledge set's refresh follows. `cached` is the
   * catalogue snapshot's data for the item, when there is one.
   */
  datasetDetail?(ctx: AdapterContext, itemId: string, cached: Record<string, unknown> | null): Promise<DatasetDetail>;
}

/** B-3804: one dataset as the select step shows it. */
export interface DatasetDetail {
  itemId: string;
  name: string;
  /** The source's revision or modification stamp, pinned on the manifest. */
  revision: string | null;
  licence: string | null;
  licenceSource: string;
  publisher: string | null;
  description: string | null;
  /** daily | weekly | monthly | quarterly | yearly | null, as the publisher states it. */
  frequency: string | null;
  configurations: { id: string; name: string; splits: string[] }[];
  resources: DatasetResource[];
  /** A link to the dataset's page on the source. */
  landingPage: string | null;
  data: Record<string, unknown>;
}

/** Joins a base URL and a path without doubling or dropping slashes. */
export const join = (base: string, path: string): string => `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;

export const str = (v: unknown, max = 400): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : null);

export const stripHtml = (v: unknown, max = 2000): string | null => {
  const t = str(v, max * 2);
  return t ? t.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim().slice(0, max) : null;
};

export const uniq = (xs: (string | null | undefined)[]): string[] => [...new Set(xs.filter((x): x is string => !!x).map((x) => x.slice(0, 200)))];

/** Reads a whole body up to `max` bytes. */
export async function readAll(body: AsyncIterable<Uint8Array> | null, max: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let n = 0;
  if (!body) return Buffer.alloc(0);
  for await (const c of body) {
    n += c.length;
    if (n > max) throw new Error(`more than ${max} bytes`);
    parts.push(Buffer.from(c));
  }
  return Buffer.concat(parts);
}
