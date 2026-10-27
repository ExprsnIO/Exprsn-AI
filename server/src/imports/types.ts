import type { Label } from '../authz/labels.js';

/*
 * B-3801: the repository types an import can come from, and the one interface every adapter implements. Model
 * import (B-3803) is complete for the Hugging Face compatible hub, the Ollama compatible registry and the signed
 * bundle share. Dataset import (B-3804) gives the dataset-oriented types their fetch steps (`describe` and `rows` in
 * `adapters/dataset-rows.ts` and `adapters/dataset-sources.ts`): `datasetImport` says which types have them.
 */

export const REPO_TYPES = ['hf', 'ollama', 'modelsdev', 'ckan', 'dcat', 'sdmx', 'openml', 'invenio', 'kaggle', 'estat', 'ogd', 'bundle'] as const;
export type RepoType = (typeof REPO_TYPES)[number];
export type ImportKind = 'model' | 'dataset';

export interface RepoTypeInfo {
  type: RepoType;
  name: string;
  kinds: ImportKind[];
  /** The protocol the adapter speaks, as the Repositories tab shows it. */
  protocol: string;
  /** A base URL to suggest (the public instance), or null when there is none. */
  example: string | null;
  /** Redirect and CDN hosts the type's downloads go through, added to the allow-list with the base host. */
  defaultHosts: string[];
  /** The source has a search API the browse step can call live (otherwise the snapshot only). */
  liveSearch: boolean;
  /** What the credential is: a bearer token, an API key, `username:key`… (null: none is used). */
  credential: string | null;
  /** The credential is required (Kaggle). */
  credentialRequired: boolean;
  /** Model import is implemented for this type. */
  modelImport: boolean;
  /** Dataset import (B-3804) is implemented for this type. */
  datasetImport: boolean;
}

export const REPO_TYPE_INFO: Record<RepoType, RepoTypeInfo> = {
  hf: { type: 'hf', name: 'Hugging Face compatible hub', kinds: ['model', 'dataset'], protocol: 'Hub API, resolve downloads (Git LFS), dataset viewer rows, Parquet files for gated datasets', example: 'https://huggingface.co', defaultHosts: ['*.hf.co', 'cdn-lfs.huggingface.co', 'cdn-lfs-us-1.huggingface.co', 'cdn-lfs-eu-1.huggingface.co', 'datasets-server.huggingface.co'], liveSearch: true, credential: 'A read token (Bearer)', credentialRequired: false, modelImport: true, datasetImport: true },
  ollama: { type: 'ollama', name: 'Ollama compatible registry', kinds: ['model'], protocol: 'OCI distribution: manifests and blobs, resumable pulls', example: 'https://registry.ollama.ai', defaultHosts: ['*.r2.cloudflarestorage.com'], liveSearch: false, credential: 'username:password for the registry token flow (optional)', credentialRequired: false, modelImport: true, datasetImport: false },
  modelsdev: { type: 'modelsdev', name: 'Models.dev catalogue', kinds: ['model'], protocol: 'Models.dev api.json: a catalogue of models and their metadata (capabilities, modalities, limits, cost, open weights). Browse and compare only; it serves no weights', example: 'https://models.dev', defaultHosts: [], liveSearch: false, credential: null, credentialRequired: false, modelImport: false, datasetImport: false },
  ckan: { type: 'ckan', name: 'CKAN portal', kinds: ['dataset'], protocol: 'CKAN Action API 3 (package_search, datastore_search), Socrata resources, CSV and JSON downloads', example: 'https://catalog.data.gov', defaultHosts: [], liveSearch: true, credential: 'An API token (Authorization header, optional)', credentialRequired: false, modelImport: false, datasetImport: true },
  dcat: { type: 'dcat', name: 'DCAT-AP catalogue', kinds: ['dataset'], protocol: 'DCAT-AP catalogue as JSON-LD, paged with hydra:next; CSV and JSON distributions', example: 'https://data.europa.eu/api/hub/repo/catalogues/european-union-open-data-portal.jsonld', defaultHosts: [], liveSearch: false, credential: null, credentialRequired: false, modelImport: false, datasetImport: true },
  sdmx: { type: 'sdmx', name: 'SDMX provider', kinds: ['dataset'], protocol: 'SDMX 2.1 REST: structure queries (dataflows, categorisations) and data as SDMX-CSV', example: 'https://ec.europa.eu/eurostat/api/dissemination/sdmx/2.1', defaultHosts: [], liveSearch: false, credential: null, credentialRequired: false, modelImport: false, datasetImport: true },
  openml: { type: 'openml', name: 'OpenML', kinds: ['dataset'], protocol: 'OpenML REST API v1 (JSON), ARFF downloads', example: 'https://www.openml.org', defaultHosts: [], liveSearch: false, credential: 'An API key (optional)', credentialRequired: false, modelImport: false, datasetImport: true },
  invenio: { type: 'invenio', name: 'InvenioRDM', kinds: ['dataset', 'model'], protocol: 'InvenioRDM records REST API, CSV and JSON files', example: 'https://zenodo.org', defaultHosts: [], liveSearch: true, credential: 'A personal access token (Bearer, optional)', credentialRequired: false, modelImport: false, datasetImport: true },
  kaggle: { type: 'kaggle', name: 'Kaggle', kinds: ['dataset'], protocol: 'Kaggle API v1 (datasets/list, view and download): files and zip archives', example: 'https://www.kaggle.com', defaultHosts: ['storage.googleapis.com'], liveSearch: true, credential: 'username:key from kaggle.json', credentialRequired: true, modelImport: false, datasetImport: true },
  estat: { type: 'estat', name: 'e-Stat', kinds: ['dataset'], protocol: 'e-Stat API 3.0 (getStatsList, getMetaInfo, getStatsData as JSON)', example: 'https://api.e-stat.go.jp/rest/3.0/app', defaultHosts: [], liveSearch: true, credential: 'An application id (appId)', credentialRequired: true, modelImport: false, datasetImport: true },
  ogd: { type: 'ogd', name: 'OGD platform', kinds: ['dataset'], protocol: 'OGD platform API (resource lists and paged resource rows as JSON)', example: 'https://api.data.gov.in', defaultHosts: [], liveSearch: false, credential: 'An API key (api-key)', credentialRequired: true, modelImport: false, datasetImport: true },
  bundle: { type: 'bundle', name: 'Signed bundles on the import share', kinds: ['model'], protocol: 'Signed platform bundles, verified and promoted to the models mirror', example: null, defaultHosts: [], liveSearch: false, credential: null, credentialRequired: false, modelImport: true, datasetImport: false }
};

/** One model or dataset as a catalogue lists it. `facets` are the source's own taxonomy, by facet key. */
export interface CatalogItem {
  kind: ImportKind;
  itemId: string;
  name: string;
  publisher: string | null;
  description: string | null;
  classification: string | null;
  licence: string | null;
  formats: string[];
  gated: boolean;
  sizeBytes: number | null;
  updated: string | null;
  facets: Record<string, string[]>;
  data: Record<string, unknown>;
}

/** The facet keys and their headings, by kind. */
export const FACETS: Record<ImportKind, [string, string][]> = {
  model: [
    ['classification', 'Classification'],
    ['format', 'Format'],
    ['licence', 'Licence'],
    ['parameters', 'Parameters'],
    ['access', 'Access'],
    ['library', 'Library'],
    ['family', 'Family'],
    ['quantization', 'Quantization']
  ],
  dataset: [
    ['classification', 'Classification'],
    ['domain', 'Domain'],
    ['format', 'Format'],
    ['licence', 'Licence'],
    ['publisher', 'Publisher'],
    ['rows', 'Rows'],
    ['region', 'Region'],
    ['updates', 'Updates']
  ]
};

/** A file of a model as the source publishes it, with the digest it is pinned to. */
export interface RemoteFile {
  name: string;
  size: number | null;
  /** `sha256:<hex>` (LFS objects, OCI blobs) or `gitsha1:<hex>` (small files in a git repository). */
  pin: string | null;
  format: FileFormat;
  /** A layer's media type (OCI), or null. */
  mediaType?: string | null;
}

export type FileFormat = 'gguf' | 'safetensors' | 'pickle' | 'onnx' | 'metadata' | 'manifest' | 'other';

/** A GGUF build of a model: an Ollama tag, or a published `.gguf` file on a hub. */
export interface Variant {
  id: string;
  /** The quantization, as the source names it (q4_K_M, Q8_0…). */
  quantization: string | null;
  size: number | null;
  /** Files that make it up. */
  files: string[];
  /** The manifest digest (Ollama), pinned at request time. */
  digest: string | null;
}

/** What the select step shows for one model: revision, files, variants, gate, licence (read from the source now). */
export interface ModelDetail {
  itemId: string;
  name: string;
  revision: string;
  files: RemoteFile[];
  variants: Variant[];
  gated: boolean;
  /** For a gated item: whether the recorded token can read its files now. */
  access: 'open' | 'granted' | 'gated';
  licence: string | null;
  /** Where the licence was read from (the card at the revision, the manifest's license layer…). */
  licenceSource: string;
  classification: string | null;
  family: string | null;
  parameters: string | null;
  capabilities: string[];
  contextLength: number | null;
  data: Record<string, unknown>;
}

// ---------- datasets (B-3804) ----------

export const DATASET_TARGETS = ['training', 'classifiers', 'knowledge', 'store'] as const;
export type DatasetTarget = (typeof DATASET_TARGETS)[number];
export type ImportTarget = 'models' | DatasetTarget;

/** How a resource's rows are read: a paged API, a file that is parsed, or not at all. */
export type ResourceAccess = 'hf-rows' | 'ckan-datastore' | 'socrata' | 'sdmx' | 'estat' | 'ogd' | 'file' | 'unsupported';

export interface DatasetResource {
  id: string;
  name: string;
  /** csv, tsv, json, jsonl, arff, zip, xlsx, parquet, xml, sdmx, api, or what the source names (pdf, shp…). */
  format: string;
  size: number | null;
  access: ResourceAccess;
  url: string | null;
  /** Why an unsupported resource cannot be read, or a note on a supported one. */
  note: string | null;
}

/** What the select step shows for one dataset: configurations, splits and resources, read from the source now. */
export interface DatasetDetail {
  itemId: string;
  name: string;
  publisher: string | null;
  description: string | null;
  /** A commit, a modification stamp or a version: what the import is pinned to and the manifest records. */
  revision: string | null;
  licence: string | null;
  licenceSource: string;
  /** The publisher's update frequency (daily, weekly, monthly, quarterly, yearly, static…), when it states one. */
  updates: string | null;
  gated: boolean;
  /** For a gated dataset: whether the recorded token can read its rows now (`granted`) or not (`gated`). */
  access?: 'open' | 'granted' | 'gated';
  configurations: { id: string; name: string }[];
  splits: { config: string; id: string; rows: number | null; bytes: number | null }[];
  resources: DatasetResource[];
  rows: number | null;
  sizeBytes: number | null;
  data: Record<string, unknown>;
}

export interface DatasetSelection {
  config?: string | null;
  splits?: string[];
  resources?: string[];
}

/** One row as a source gives it: its values by column, and the id the source gives the row when it has one. */
export interface SourceRecord {
  id: string | null;
  values: Record<string, unknown>;
  /** The split or resource the row came from. */
  part: string | null;
}

export const REFRESHES = ['manual', 'daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'publisher'] as const;
export type Refresh = (typeof REFRESHES)[number];
export type Cadence = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';

/** B-3805: what a knowledge source of kind `dataset` keeps: where its rows come from and how they become documents. */
export interface DatasetSourceConfig {
  repositoryId: string;
  item: string;
  name: string;
  config: string | null;
  splits: string[];
  resources: string[];
  startPeriod: string | null;
  endPeriod: string | null;
  /** A row limit (the first rows in publication order), or null for every row. */
  sample: number | null;
  dropColumns: string[];
  titleColumn: string | null;
  textColumns: string[];
  metadataColumns: string[];
  idColumn: string | null;
  /** One document per value of this column instead of one per row. */
  groupBy: string | null;
  /** `publisher` follows the frequency the publisher states; `cadence` is what that resolves to now. */
  refresh: Refresh;
  cadence: Cadence | null;
  nextRefreshAt: number | null;
  licence: string | null;
  /** `pending` until the first import completes: a source whose licence was never cleared is not refreshed. */
  licenceStatus: LicenceStatus | 'pending';
  attribution: string | null;
  lastImport: string | null;
  lastRows: number | null;
  lastHash: string | null;
}

export interface ImportOptions {
  tag?: string;
  quantization?: string;
  poolId?: string | null;
  family?: string | null;
  capabilities?: string[];
  notes?: string | null;
  /** B-3806: `classifier` when the classifier worker serves the model (a text-classification model). */
  serving?: 'classifier';
  /** B-3806: whether the import also makes a draft classifier over the model, and its name. */
  classifierDraft?: { create: boolean; name: string | null };
}

export interface Selection {
  variants: string[];
  files: string[];
}

export interface PinnedFile {
  name: string;
  size: number | null;
  pin: string | null;
  format: FileFormat;
  mediaType?: string | null;
  /** Bytes stored so far (parts), and the parts themselves, for a download that resumes. */
  done: number;
  parts: { key: string; bytes: number }[];
  /** After verification: the sha256 of the bytes and the content-addressed blob key. */
  sha256: string | null;
  blob: string | null;
  state: 'pending' | 'downloading' | 'verified' | 'failed';
}

export interface Check {
  name: string;
  result: 'passed' | 'refused' | 'warning' | 'info' | 'waiting';
  detail: string;
}

export interface LogEntry {
  at: number;
  title: string;
  meta: string;
  tone: 'ok' | 'warn' | 'danger' | '';
}

export type ImportState = 'queued' | 'waiting on licence' | 'queued for bundle' | 'running' | 'complete' | 'refused' | 'failed' | 'cancelled';
export const LIVE_STATES: readonly ImportState[] = ['queued', 'waiting on licence', 'queued for bundle', 'running'];
export type LicenceStatus = 'allowed' | 'exception pending' | 'exception granted' | 'exception refused';

export interface ImportRow {
  id: string;
  tenant_id: string;
  ref: string;
  workspace_id: string | null;
  kind: ImportKind;
  repository_id: string;
  item_id: string;
  item_name: string;
  revision: string | null;
  target: ImportTarget;
  mode: 'direct' | 'bundle';
  state: ImportState;
  stage: string | null;
  progress: number;
  note: string | null;
  files: PinnedFile[];
  options: ImportOptions & { variant?: string | null; manifestDigest?: string | null; variantDigests?: Record<string, string> };
  checks: Check[];
  log: LogEntry[];
  manifest: Record<string, unknown> | null;
  /** B-3804: what a dataset import made, by target. */
  result: Record<string, unknown> | null;
  licence: string | null;
  licence_status: LicenceStatus;
  label: Label;
  attribution: string | null;
  size_bytes: number;
  stored_bytes: number;
  job_id: string | null;
  model_id: string | null;
  error: string | null;
  requested_by: string;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  finished_at: number | null;
}

/** A source answered 429 (or 503 with Retry-After): the repository backs off. */
export class RateLimited extends Error {
  constructor(
    readonly retryAfterMs: number | null,
    message: string
  ) {
    super(message);
  }
}

/** The source answered an error, could not be reached, or sent something the adapter cannot read. */
export class SourceError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null
  ) {
    super(message);
  }
}

/** The source needs a credential the repository does not have, or refused the one it has. */
export class NeedsCredential extends SourceError {}

/** An import is refused by a check (pickle, format, digest): nothing is registered. */
export class ImportRefused extends Error {
  constructor(
    message: string,
    readonly reason: string
  ) {
    super(message);
  }
}
