import type { Label } from '../authz/labels.js';

/*
 * B-3801: the repository types an import can come from, and the one interface every adapter implements. Model
 * import (B-3803) is complete for the Hugging Face compatible hub, the Ollama compatible registry and the signed
 * bundle share; the dataset-oriented types are registry entries with credentials and a browsable catalogue (B-3802)
 * until dataset import (B-3804) gives them `fetch` steps.
 */

export const REPO_TYPES = ['hf', 'ollama', 'ckan', 'dcat', 'sdmx', 'openml', 'invenio', 'kaggle', 'bundle'] as const;
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
}

export const REPO_TYPE_INFO: Record<RepoType, RepoTypeInfo> = {
  hf: { type: 'hf', name: 'Hugging Face compatible hub', kinds: ['model', 'dataset'], protocol: 'Hub API, resolve downloads (Git LFS)', example: 'https://huggingface.co', defaultHosts: ['*.hf.co', 'cdn-lfs.huggingface.co', 'cdn-lfs-us-1.huggingface.co', 'cdn-lfs-eu-1.huggingface.co'], liveSearch: true, credential: 'A read token (Bearer)', credentialRequired: false, modelImport: true },
  ollama: { type: 'ollama', name: 'Ollama compatible registry', kinds: ['model'], protocol: 'OCI distribution: manifests and blobs, resumable pulls', example: 'https://registry.ollama.ai', defaultHosts: ['*.r2.cloudflarestorage.com'], liveSearch: false, credential: 'username:password for the registry token flow (optional)', credentialRequired: false, modelImport: true },
  ckan: { type: 'ckan', name: 'CKAN portal', kinds: ['dataset'], protocol: 'CKAN Action API 3 (package_search)', example: 'https://catalog.data.gov', defaultHosts: [], liveSearch: true, credential: 'An API token (Authorization header, optional)', credentialRequired: false, modelImport: false },
  dcat: { type: 'dcat', name: 'DCAT-AP catalogue', kinds: ['dataset'], protocol: 'DCAT-AP catalogue as JSON-LD, paged with hydra:next', example: 'https://data.europa.eu/api/hub/repo/catalogues/european-union-open-data-portal.jsonld', defaultHosts: [], liveSearch: false, credential: null, credentialRequired: false, modelImport: false },
  sdmx: { type: 'sdmx', name: 'SDMX provider', kinds: ['dataset'], protocol: 'SDMX 2.1 REST structure queries (dataflows, categorisations)', example: 'https://ec.europa.eu/eurostat/api/dissemination/sdmx/2.1', defaultHosts: [], liveSearch: false, credential: null, credentialRequired: false, modelImport: false },
  openml: { type: 'openml', name: 'OpenML', kinds: ['dataset'], protocol: 'OpenML REST API v1 (JSON)', example: 'https://www.openml.org', defaultHosts: [], liveSearch: false, credential: 'An API key (optional)', credentialRequired: false, modelImport: false },
  invenio: { type: 'invenio', name: 'InvenioRDM', kinds: ['dataset', 'model'], protocol: 'InvenioRDM records REST API', example: 'https://zenodo.org', defaultHosts: [], liveSearch: true, credential: 'A personal access token (Bearer, optional)', credentialRequired: false, modelImport: false },
  kaggle: { type: 'kaggle', name: 'Kaggle', kinds: ['dataset'], protocol: 'Kaggle API v1 (datasets/list)', example: 'https://www.kaggle.com', defaultHosts: [], liveSearch: true, credential: 'username:key from kaggle.json', credentialRequired: true, modelImport: false },
  bundle: { type: 'bundle', name: 'Signed bundles on the import share', kinds: ['model'], protocol: 'Signed platform bundles, verified and promoted to the models mirror', example: null, defaultHosts: [], liveSearch: false, credential: null, credentialRequired: false, modelImport: true }
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

export interface ImportOptions {
  tag?: string;
  quantization?: string;
  poolId?: string | null;
  family?: string | null;
  capabilities?: string[];
  notes?: string | null;
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
  /** models | classifiers (a model import, B-3803, B-3806) or training | classifiers | knowledge | store (a dataset import, B-3804). */
  target: 'models' | 'classifiers' | 'training' | 'knowledge' | 'store';
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
  licence: string | null;
  licence_status: LicenceStatus;
  label: Label;
  attribution: string | null;
  size_bytes: number;
  stored_bytes: number;
  job_id: string | null;
  model_id: string | null;
  /** B-3804: what a dataset import produced (rows, hash, the destination's ids and warnings) and the ids themselves. */
  result: Record<string, unknown> | null;
  rows_total: number;
  sample_rows: number | null;
  dataset_id: string | null;
  kb_id: string | null;
  source_id: string | null;
  classifier_id: string | null;
  eval_set: string | null;
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
