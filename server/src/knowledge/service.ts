import { createHash, randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import type { Logger } from 'pino';
import { json, type Db } from '../db/knex.js';
import { clears, highest, LABELS, labelRank, type Label } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import type { CredentialVault } from '../vault/credential-moves.js';
import type { AuditLog } from '../audit/chain.js';
import { clamScan, classify } from '../chat/attachments.js';
import type { ContextItem, ContextRequest } from '../chat/context.js';
import type { InjectionDefence } from '../guardrails/injection.js';
import { findObject } from '../connections/dialects.js';
import { engineInfo, isSqlEngine, type Engine } from '../connections/engines.js';
import { allowed as allowedObject, type ConnectionRow, type ConnectionService } from '../connections/service.js';
import type { Gateway } from '../gateway/gateway.js';
import type { Guardrails } from '../guardrails/types.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { BlobStore } from '../platform/blob.js';
import type { DataKeys } from '../platform/datakeys.js';
import type { JobContext, JobQueue } from '../platform/jobs.js';
import type { VectorStore } from '../platform/vectors.js';
import { decodeVector, encodeVector } from '../platform/vectors.js';
import type { QuotaService } from '../tenancy/quotas.js';
import { chunkText, DEFAULT_CHUNKING, type ChunkOptions, type TextChunk } from './chunk.js';
import { detectType, DOCX as DOCX_TYPE, ExtractionError, extractText } from './extract.js';
import { gitItems, globRegex, parseS3, S3Reader, type GitFetcher, type S3Settings, type SourceItem } from './sources.js';
import { crawl } from './crawl.js';
import { textDiff } from './diff.js';
import { checkHost, guardedAgent, HostRefused, namedHost, parseAllowList, type AllowList } from '../mcp/hosts.js';
import { bm25, rrf, termCounts, TermKeys, tokenize } from './terms.js';
import { aclAllows, readAcl, readerEntries, rowAcl, type AccessKind } from './acl.js';
import { ReplicationManager } from './replication.js';
import type { MaskedChange } from '../connections/service.js';
import type { FolderSourceProvider } from '../files/service.js';
import type { ClassifierRow, ClassifierService } from '../guardrails/classifiers.js';
import { complete } from '../guardrails/model.js';
import type { ImageSafety } from '../images/safety.js';
import type { DatasetSourceConfig } from '../imports/types.js';
import { embeddingProfile, usageWorkspace } from '../tenancy/usage-attribution.js';
import { categoryAncestors, categoryPaths, CategoryError, labelCategory, type CategoryFilter } from './categories.js';
import { DESCRIBE_PROMPT, imageParts, indexedText, isImageType, parseDescription, VIEWABLE, type ImageDescription } from './images.js';

export const SOURCE_KINDS = ['upload', 's3', 'git', 'database', 'web', 'folder', 'dataset', 'saved-query', 'rest'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const SCHEDULES = ['15m', 'hourly', 'daily', 'manual'] as const;
export type Schedule = (typeof SCHEDULES)[number];
const SCHEDULE_MS: Record<Schedule, number> = { '15m': 15 * 60_000, hourly: 60 * 60_000, daily: 24 * 60 * 60_000, manual: 0 };
const EMBED_CACHE_MS = 30 * 24 * 60 * 60_000;

/** Where an indexing run's model calls are metered: the base's workspace and the person who added the document. */
interface Meter {
  workspaceId: string | null;
  userId: string | null;
}

/** `KnowledgeService.embed`'s options: the call's signal, and where its usage is counted (`tenancy/usage-attribution.ts`). */
export interface EmbedOptions {
  signal?: AbortSignal | undefined;
  /** The object's workspace, else the caller's current one; the tenant's default workspace when neither is given. */
  workspaceId?: string | null | undefined;
  /** The profile to record; when left out, the tenant's published profile for the model. */
  profileId?: string | null | undefined;
  /** Profile names a setting gives, preferred when several published profiles route to the model. */
  preferProfiles?: (string | null | undefined)[] | undefined;
}
/** Crawled images under this size are icons and spacers, not pictures worth describing. */
const CRAWL_IMAGE_MIN_BYTES = 8 * 1024;
/** The recorded changes a source keeps; older ones go as new ones arrive. */
const CHANGES_KEPT = 1000;
/** B-3805: how many retired, failed and cancelled index versions of a dataset source's refreshes stay listed. */
const REFRESH_VERSIONS_KEPT = 5;

export interface KbRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  name: string;
  description: string | null;
  label: Label;
  embed_model: string;
  reranker: string | null;
  sharing: 'members' | 'curators';
  status: 'draft' | 'published';
  chunking: ChunkOptions;
  serving_index_id: string | null;
  /** Sprint 36c (B-8801): the profile whose vision model captions and reads image documents. */
  vision_profile: string | null;
  /** B-8802: the published vision classifiers (ids) that label the base's images. */
  image_classifiers: string[];
  /** Migration 045: `required` takes changes through revisions only (`knowledge/revisions.ts`). */
  review?: 'off' | 'required';
  review_workflow_id?: string | null;
  review_four_eyes?: number | boolean | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface IndexRow {
  id: string;
  tenant_id: string;
  kb_id: string;
  version: number;
  embed_model: string;
  dims: number | null;
  state: 'building' | 'serving' | 'retired' | 'cancelled' | 'failed';
  progress: number;
  message: string | null;
  chunks: number;
  job_id: string | null;
  error: string | null;
  created_by: string | null;
  created_at: number;
  built_at: number | null;
}

export interface SourceRow {
  id: string;
  tenant_id: string;
  kb_id: string;
  kind: SourceKind;
  location: string;
  config: {
    bucket?: string;
    prefix?: string;
    url?: string;
    ref?: string | null;
    path?: string;
    connectionId?: string;
    object?: string;
    idColumn?: string | null;
    watermarkColumn?: string | null;
    engine?: Engine;
    /** MongoDB: the document fields whose text is indexed (dotted paths allowed). */
    fields?: string[];
    accessColumn?: string | null;
    accessKind?: AccessKind;
    replication?: boolean;
    publication?: string | null;
    /** B-1501: S3 include patterns, and a bucket on another S3-compatible endpoint (its keys are sealed apart). */
    include?: string[];
    endpoint?: string | null;
    region?: string;
    pathStyle?: boolean;
    /** B-1502: a crawl's limits. */
    maxDepth?: number;
    maxPages?: number;
    pathPrefix?: string;
    sitemap?: boolean;
    /** A crawl also indexes the images of its pages (described by the base's vision profile), up to `maxMedia`. */
    media?: boolean;
    maxMedia?: number;
    /** A crawl records what each sync found new, changed (with the line diff of the text) and gone. */
    changes?: boolean;
    /** B-1503: rows are read as each mapped PostgreSQL role, and the groups whose role saw a row may retrieve it. */
    roleMappings?: RoleMapping[];
    /** B-2405: a file store folder (and its subfolders). */
    folderId?: string;
    /** B-3805: an imported dataset: its repository, selection, column mapping and refresh schedule. */
    dataset?: DatasetSourceConfig;
    /** 1.8.0 (B-125, B-126): the saved query or REST endpoint whose rows the source indexes (`ExternalSourceProvider`). */
    external?: ExternalSourceConfig;
  };
  /** B-1501: the sealed secret access key of the source's own S3-compatible endpoint. */
  secret_sealed?: string | null;
  /** 1.7.0 (B-9208): the vault reference the credential is read through once it was moved; the sealed value stays. */
  secret_ref?: string | null;
  label_floor: Label;
  schedule: Schedule;
  state: 'idle' | 'syncing' | 'failed';
  watermark: string | null;
  last_sync_at: number | null;
  last_error: string | null;
  last_trace: string | null;
  job_id: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface AddSourceInput {
  kind: SourceKind;
  location: string;
  labelFloor?: Label;
  schedule?: Schedule;
  ref?: string | null;
  path?: string;
  connectionId?: string;
  idColumn?: string | null;
  watermarkColumn?: string | null;
  accessColumn?: string | null;
  accessKind?: AccessKind;
  replication?: boolean;
  publication?: string | null;
  /** B-1501 */
  include?: string[];
  endpoint?: string | null;
  region?: string;
  pathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** B-1502 */
  maxDepth?: number;
  maxPages?: number;
  pathPrefix?: string;
  sitemap?: boolean;
  /** Web sites: index the pages' images, and record what changes between syncs. */
  media?: boolean;
  maxMedia?: number;
  changes?: boolean;
  /** B-1503 */
  roleMappings?: RoleMapping[];
  /** MongoDB collections: the text fields to index. */
  fields?: string[];
  /** 1.8.0 (B-125, B-126): a saved query (`queryId`) or a REST endpoint (`connectionId` and `resource`), its parameters, and the fields that name a row. */
  queryId?: string;
  resource?: string;
  params?: Record<string, unknown>;
  idField?: string | null;
  titleField?: string | null;
}

/** 1.8.0 (B-125, B-126): what a `saved-query` or `rest` source reads. */
export interface ExternalSourceConfig {
  ref?: string;
  connectionId?: string;
  endpoint?: string;
  params?: Record<string, unknown>;
  idField?: string | null;
  titleField?: string | null;
}

/** 1.8.0 (B-125, B-126): sources whose rows come from a saved query or a REST endpoint (set when the services are built). */
export interface ExternalSourceProvider {
  /** Checks the source as the curator adding it; returns where it reads and the label floor its rows need. */
  check(p: Principal, input: AddSourceInput): Promise<{ location: string; external: ExternalSourceConfig; floor: Label }>;
  /** The rows as documents, read under the governed path of the query or endpoint (a full listing). */
  items(s: SourceRow, signal: AbortSignal): Promise<SourceItem[]>;
}

/** B-3805: what refreshes a source of kind `dataset` (the import service; set when the services are built). */
export interface DatasetSourceProvider {
  refresh(by: string | null, s: SourceRow): Promise<{ jobId: string }>;
}

export interface RoleMapping {
  group: string;
  role: string;
}

export type DocState = 'quarantined' | 'scanning' | 'queued' | 'indexing' | 'indexed' | 'unchanged' | 'failed' | 'rejected' | 'removed' | 'hidden';

export interface DocRow {
  id: string;
  tenant_id: string;
  kb_id: string;
  source_id: string;
  external_key: string;
  name: string;
  type: string | null;
  size: number;
  sha256: string | null;
  version: string | null;
  label: Label;
  auto_label: Label | null;
  manual_label: Label | null;
  label_origin: string;
  detections: Record<string, number> | null;
  state: DocState;
  error: string | null;
  trace_id: string | null;
  blob_key: string | null;
  chunks: number;
  created_at: number;
  updated_at: number;
  indexed_at: number | null;
  /** Row-level access entries (B-1002), or null when the row carries none. */
  acl: string[] | null;
  /** Sprint 36c: the document an image was taken out of (a PDF or Word document), or null. */
  parent_id: string | null;
  /** `image` for image documents. */
  media: 'image' | null;
  /** Migration 144 (QA-1): who uploaded or added the document; null for synced documents and older rows (absent before 144). */
  created_by?: string | null;
  /** Sealed JSON: the caption and recognised text the vision profile wrote, and its model. */
  vision: string | null;
  /** The image safety check's score, when a classifier is configured. */
  safety_score: number | null;
}

/** B-8802: one label a vision classifier gave an image document. */
export interface DocLabel {
  label: string;
  score: number;
  hit: boolean;
  classifierId: string;
  classifier: string;
  version: number;
  /** Migration 046: given by a draft classifier, which has not passed its evaluation yet. */
  provisional: boolean;
}

/** Migration 046: a category a vision classifier's label filed an image under. */
export interface FiledByClassifier {
  category: string;
  classifierId: string;
  classifier: string;
  provisional: boolean;
}

/** B-8803: label filters on a search (image documents only). */
export interface LabelFilter {
  any?: string[];
  all?: string[];
  /** The lowest score that counts; without it, each classifier's own threshold decides. */
  minScore?: number;
}

/** B-8803: what an image hit carries besides its chunk. */
export interface ImageHit {
  caption: string | null;
  ocr: string | null;
  labels: DocLabel[];
  thumbnail: string | null;
}

export interface SearchHit {
  chunkId: string;
  kbId: string;
  kb: string;
  documentId: string;
  document: string;
  source: string;
  heading: string | null;
  label: Label;
  vector: number | null;
  keyword: number | null;
  fused: number;
  rerank: number | null;
  text?: string;
  withheld?: string;
  /** Sprint 36c (B-8803): an image document's caption, text excerpt, labels and thumbnail. */
  image?: ImageHit;
  /** Migration 043: the categories the hit's document is filed under. */
  categories?: string[];
  /** B-6901: a crawled page (a `web` source) or any other knowledge. */
  origin?: 'knowledge' | 'crawl';
}

export interface KnowledgeOptions {
  maxBytes: number;
  clamd?: { host: string; port: number };
  s3?: S3Settings;
  git: GitFetcher;
  /** Logical replication for PostgreSQL sources (B-1003): KNOWLEDGE_REPLICATION and its tick. */
  replication?: { enabled: boolean; tickMs: number };
  /**
   * B-1501, B-1502: where a source's own S3 endpoint or a crawled site may be: internal addresses, plus the hosts
   * and networks in KNOWLEDGE_ALLOWED_HOSTS. Link-local and metadata addresses never.
   */
  allowedHosts?: AllowList;
  /** Per-request timeout for crawls and S3 endpoints of sources (ms). */
  fetchTimeoutMs?: number;
}

export interface KnowledgeDeps {
  db: Db;
  keys: DataKeys;
  blobs: BlobStore;
  jobs: JobQueue;
  gateway: Gateway;
  vectors: VectorStore;
  audit: AuditLog;
  quotas: QuotaService;
  guard: Guardrails;
  connections: ConnectionService;
  log: Logger;
  /** The workspaces a principal may act in (ids). */
  workspaces: (p: Principal) => Promise<string[]>;
  /** 1.7.0 (B-9804): the social groups a principal counts as a member of now (ids); none when not given. */
  socialGroups?: (p: Principal) => Promise<string[]>;
  /** Sprint 36c: the image safety check (read when used, so a later replacement applies). */
  safety?: () => ImageSafety;
  safetyThreshold?: number;
  /** IMAGE_SAFETY_REQUIRED: without a safety classifier, images are rejected rather than indexed unchecked. */
  safetyRequired?: boolean;
  /** B-8802: the classifier registry, for the bases' vision classifiers. */
  classifiers?: ClassifierService;
  /** B-6902: the untrusted-content checkpoint every chunk passes before a model reads it (`contextFor`). */
  injection?: () => InjectionDefence;
}

const num = (v: unknown) => (v == null ? null : Number(v));
const kbFrom = (r: Record<string, unknown>): KbRow => ({ ...(r as unknown as KbRow), chunking: json<ChunkOptions>(r.chunking, DEFAULT_CHUNKING), vision_profile: (r.vision_profile as string | null | undefined) ?? null, image_classifiers: json<string[]>(r.image_classifiers, []), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
const indexFrom = (r: Record<string, unknown>): IndexRow => ({ ...(r as unknown as IndexRow), version: Number(r.version), dims: num(r.dims), progress: Number(r.progress), chunks: Number(r.chunks), created_at: Number(r.created_at), built_at: num(r.built_at) });
const sourceFrom = (r: Record<string, unknown>): SourceRow => ({ ...(r as unknown as SourceRow), secret_sealed: (r.secret_sealed as string | null | undefined) ?? null, config: json<SourceRow['config']>(r.config, {}), last_sync_at: num(r.last_sync_at), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
const docFrom = (r: Record<string, unknown>): DocRow => ({ ...(r as unknown as DocRow), size: Number(r.size), chunks: Number(r.chunks), detections: json<Record<string, number> | null>(r.detections, null), created_at: Number(r.created_at), updated_at: Number(r.updated_at), indexed_at: num(r.indexed_at), acl: readAcl(r.acl), parent_id: (r.parent_id as string | null | undefined) ?? null, media: r.media === 'image' ? 'image' : null, vision: (r.vision as string | null | undefined) ?? null, safety_score: num(r.safety_score) });
/** An image whose safety check passed and which was described: its picture may be shown. */
const SHOWN = ['indexed', 'unchanged', 'queued', 'indexing'];
export const thumbnailUrl = (d: Pick<DocRow, 'id' | 'media' | 'type' | 'state' | 'indexed_at'>): string | null => (d.media === 'image' && VIEWABLE.includes(d.type ?? '') && SHOWN.includes(d.state) && d.indexed_at ? `/api/knowledge/documents/${d.id}/thumbnail` : null);
/** How long the vision profile may take to describe or classify one image, queueing included. */
const VISION_TIMEOUT_MS = 180_000;
/** The OCR excerpt a search hit carries. */
const OCR_EXCERPT = 300;
const labelsUpTo = (l: Label): Label[] => LABELS.filter((x) => labelRank(x) <= labelRank(l));
const traceId = () => randomBytes(16).toString('hex');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const DETECTION_NAMES: Record<string, string> = { payment_card: 'payment card', iban: 'IBAN', us_ssn: 'national identifier', email: 'email', phone: 'phone' };
/** The classifier findings that decided a label, by name ("IBAN", "payment card"). */
const findingsFor = (detections: Record<string, number> | null, label: Label): string[] =>
  Object.keys(detections ?? {})
    .filter((k) => (label === 'confidential' ? ['payment_card', 'iban', 'us_ssn'].includes(k) : label === 'internal'))
    .map((k) => DETECTION_NAMES[k] ?? k);

export const kbView = (k: KbRow, extra: { documents?: number; chunks?: number; access?: 'read' | 'manage' | null; serving?: IndexRow | null; building?: IndexRow | null; lastSyncAt?: number | null } = {}) => ({
  id: k.id,
  name: k.name,
  description: k.description,
  workspaceId: k.workspace_id,
  label: k.label,
  embedModel: k.embed_model,
  reranker: k.reranker,
  sharing: k.sharing,
  status: k.status,
  chunking: k.chunking,
  visionProfile: k.vision_profile,
  imageClassifiers: k.image_classifiers,
  documents: extra.documents ?? 0,
  chunks: extra.chunks ?? 0,
  access: extra.access ?? null,
  serving: extra.serving ? indexView(extra.serving) : null,
  building: extra.building ? indexView(extra.building) : null,
  lastSyncAt: extra.lastSyncAt ?? null,
  createdAt: k.created_at,
  updatedAt: k.updated_at
});

export const indexView = (i: IndexRow) => ({ id: i.id, version: i.version, embedModel: i.embed_model, dims: i.dims, state: i.state, progress: i.progress, message: i.message, chunks: i.chunks, jobId: i.job_id, error: i.error, createdAt: i.created_at, builtAt: i.built_at });

export const sourceView = (s: SourceRow, docs = 0) => ({
  id: s.id,
  kind: s.kind,
  location: s.location,
  config: { ...s.config },
  labelFloor: s.label_floor,
  schedule: s.schedule,
  state: s.state,
  watermark: s.watermark,
  lastSyncAt: s.last_sync_at,
  lastError: s.last_error,
  lastTrace: s.last_trace,
  jobId: s.job_id,
  documents: docs,
  createdAt: s.created_at
});

/** One thing a sync found: a document new, changed or gone (migration 044). */
export interface ChangeRow {
  id: string;
  tenant_id: string;
  kb_id: string;
  source_id: string;
  document_id: string;
  kind: 'added' | 'changed' | 'removed';
  name: string;
  label: Label;
  added: number;
  removed: number;
  diff_sealed: string | null;
  truncated: number;
  created_at: number;
}

const changeFrom = (r: Record<string, unknown>): ChangeRow => ({ ...(r as unknown as ChangeRow), added: Number(r.added), removed: Number(r.removed), truncated: Number(r.truncated), created_at: Number(r.created_at) });

export const changeView = (c: ChangeRow) => ({ id: c.id, kind: c.kind, document: c.name, documentId: c.document_id, sourceId: c.source_id, label: c.label, added: c.added, removed: c.removed, hasDiff: !!c.diff_sealed, truncated: !!c.truncated, at: c.created_at });

export const docView = (d: DocRow, source?: SourceRow, labels?: DocLabel[], categories?: string[]) => ({
  id: d.id,
  name: d.name,
  parentId: d.parent_id,
  media: d.media,
  thumbnail: thumbnailUrl(d),
  safetyScore: d.safety_score,
  ...(labels ? { labels } : {}),
  ...(categories ? { categories } : {}),
  sourceId: d.source_id,
  source: source ? (source.kind === 'upload' ? 'Uploads' : source.location) : null,
  type: d.type,
  size: d.size,
  sha256: d.sha256,
  label: d.label,
  autoLabel: d.auto_label,
  manualLabel: d.manual_label,
  labelOrigin: d.label_origin,
  detections: d.detections,
  state: d.state,
  error: d.error,
  traceId: d.trace_id,
  chunks: d.chunks,
  access: d.acl,
  createdAt: d.created_at,
  updatedAt: d.updated_at,
  indexedAt: d.indexed_at
});

/**
 * One database row as a source item: a text document of `column: value` lines, versioned by its content hash,
 * carrying the row's access list when the source has an access column. Shared by the watermark sync and the
 * replication stream so both write the same document for the same row.
 */
export function rowItem(cfg: SourceRow['config'], id: string, columns: string[], row: unknown[], access: unknown): SourceItem {
  // MongoDB sources name the fields to index; the id, watermark and access fields are read beside them, not indexed.
  const keep = cfg.fields?.length ? new Set(cfg.fields) : null;
  const body = `# ${cfg.object} ${id}\n\n` + columns.flatMap((col, j) => (keep && !keep.has(col) ? [] : [`${col}: ${row[j] == null ? '' : row[j] instanceof Date ? (row[j] as Date).toISOString() : String(row[j])}`])).join('\n');
  const data = Buffer.from(body, 'utf8');
  return { key: `${cfg.object}#${id}`, name: `${cfg.object} #${id}`, version: sha(data), size: data.length, read: async () => data, ...(cfg.accessColumn ? { acl: rowAcl(cfg.accessKind ?? 'group', access) } : {}) };
}

/**
 * Knowledge bases: sources (uploads through quarantine, S3 prefixes, Git repositories, database views through a
 * data connection) sync into documents, which are extracted, classified, chunked by structure, embedded through
 * the gateway and written to the serving index (and to an index being built beside it). Chunk text is sealed; the
 * keyword index holds keyed hashes; vectors live in the `VectorStore`. Search fuses vector and keyword rankings
 * (reciprocal rank fusion), optionally reranks with a model, and filters by label inside every query. Reindexing
 * builds a new index version by job and switches to it atomically.
 */
export class KnowledgeService {
  readonly terms: TermKeys;
  /** Whether migration 144 (`knowledge_documents.created_by`) is applied: cached once true, rechecked every 30 s while not. */
  private docCreator: { ok: boolean; at: number } | null = null;
  /** 1.7.0 (B-9208): reads a source's keys that were moved to the vault (set by createServices). */
  credentialVault: CredentialVault | null = null;
  readonly replication: ReplicationManager;
  private readonly db: Db;
  /** Sprint 26d (B-2405): the file store's folders as sources; set when the file store is built. */
  folders: FolderSourceProvider | null = null;
  /** B-3805: the import service, which fetches the rows of dataset sources as import jobs. */
  datasets: DatasetSourceProvider | null = null;
  /** 1.8.0 (B-125, B-126): saved queries and REST endpoints as sources. */
  external: Partial<Record<'saved-query' | 'rest', ExternalSourceProvider>> = {};
  /** Migration 045: told when a document leaves the scan or the index (indexed, failed or rejected). */
  readonly settled: ((doc: DocRow) => Promise<void>)[] = [];

  constructor(
    private readonly d: KnowledgeDeps,
    private readonly o: KnowledgeOptions
  ) {
    this.db = d.db;
    this.terms = new TermKeys(d.db, d.keys);
    this.replication = new ReplicationManager(
      {
        db: d.db,
        connections: d.connections,
        log: d.log,
        sources: async () => ((await this.db('knowledge_sources').where({ kind: 'database' })) as Record<string, unknown>[]).map(sourceFrom),
        apply: (src, changes) => this.applyReplicated(src, changes)
      },
      o.replication ?? { enabled: false, tickMs: 10_000 }
    );
    d.jobs.register('knowledge.scan', (p, ctx) => this.scanJob(String(p.documentId), ctx.job.created_by ?? null), { timeoutMs: 10 * 60_000 });
    d.jobs.register('knowledge.index', (p, ctx) => this.indexJob(String(p.documentId), ctx), { timeoutMs: 30 * 60_000 });
    d.jobs.register('knowledge.sync', (p, ctx) => this.syncJob(String(p.sourceId), ctx), { timeoutMs: 2 * 60 * 60_000 });
    d.jobs.register('knowledge.reindex', (p, ctx) => this.reindexJob(String(p.indexId), ctx), { timeoutMs: 12 * 60 * 60_000 });
    d.jobs.register('knowledge.sync-due', (p, ctx) => this.syncDue(String(p.tenantId ?? ctx.job.tenant_id)));
    // Sprint 36c (B-8802): an image document's labels, and the labels of a base's images again after a new version.
    d.jobs.register('knowledge.classify', (p, ctx) => this.classifyJob(String(p.documentId), p.classifierId ? String(p.classifierId) : null, ctx.job.created_by ?? null), { timeoutMs: 30 * 60_000 });
    d.jobs.register('knowledge.reclassify', (p, ctx) => this.reclassifyJob(String(p.kbId), p.classifierId ? String(p.classifierId) : null, ctx), { timeoutMs: 12 * 60 * 60_000 });
  }

  // ---------- sealing ----------

  private sealChunk(tenantId: string, id: string, v: { text: string; heading: string | null }): Promise<string> {
    return this.d.keys.seal(tenantId, JSON.stringify(v), `chunk:${id}`);
  }

  private async openChunk(tenantId: string, id: string, sealed: string): Promise<{ text: string; heading: string | null }> {
    return json(await this.d.keys.open(tenantId, sealed, `chunk:${id}`), { text: '', heading: null });
  }

  private async content(d: DocRow): Promise<Buffer> {
    if (!d.blob_key) throw new ExtractionError('The document has no stored content.');
    const sealed = await this.d.blobs.get(d.blob_key);
    if (!sealed) throw new ExtractionError('The stored content is missing.');
    return this.d.keys.openBytes(d.tenant_id, sealed.toString(), `kdoc:${d.id}`);
  }

  private async store(d: Pick<DocRow, 'id' | 'tenant_id'>, data: Buffer, prefix = 'knowledge'): Promise<string> {
    const key = `${prefix}/${d.tenant_id}/${d.id}`;
    await this.d.blobs.put(key, Buffer.from(await this.d.keys.sealBytes(d.tenant_id, data, `kdoc:${d.id}`)));
    return key;
  }

  // ---------- access ----------

  private canCurate(p: Principal): boolean {
    return effectivePermissions(p).has('knowledge:manage');
  }

  /** Knowledge bases the principal may read, with their access: curators see every one in the tenant. */
  async visible(p: Principal): Promise<{ kb: KbRow; access: 'read' | 'manage' }[]> {
    const all = ((await this.db('knowledge_bases').where({ tenant_id: p.tenantId }).orderBy('name')) as Record<string, unknown>[]).map(kbFrom);
    if (this.canCurate(p)) return all.map((kb) => ({ kb, access: 'manage' as const }));
    const ws = await this.d.workspaces(p);
    // 1.7.0 (B-9804): a grant to a social group counts while the caller counts as one of its members.
    const groups = this.d.socialGroups ? await this.d.socialGroups(p) : [];
    const grants = (await this.db('knowledge_access')
      .where({ tenant_id: p.tenantId })
      .andWhere((q) => {
        void q.where({ principal_kind: 'user', principal_id: p.userId }).orWhere((w) => w.where({ principal_kind: 'workspace' }).whereIn('principal_id', ws.length ? ws : ['']));
        if (groups.length) void q.orWhere((w) => w.where({ principal_kind: 'social_group' }).whereIn('principal_id', groups));
      })) as { kb_id: string; access: 'read' | 'manage' }[];
    const out: { kb: KbRow; access: 'read' | 'manage' }[] = [];
    for (const kb of all) {
      const g = grants.filter((x) => x.kb_id === kb.id);
      if (g.some((x) => x.access === 'manage')) out.push({ kb, access: 'manage' });
      else if (g.length || (kb.sharing === 'members' && (!kb.workspace_id || ws.includes(kb.workspace_id)))) out.push({ kb, access: 'read' });
    }
    return out;
  }

  async base(p: Principal, id: string, need: 'read' | 'manage' = 'read'): Promise<KbRow> {
    const hit = (await this.visible(p)).find((x) => x.kb.id === id);
    if (!hit) throw notFound('Knowledge base');
    if (need === 'manage' && hit.access !== 'manage') throw forbidden('Changing a knowledge base needs the knowledge curator role or manage access to it.', { step: 'role', action: 'knowledge:manage' });
    return hit.kb;
  }

  private async kbRow(id: string): Promise<KbRow> {
    return kbFrom(await this.db('knowledge_bases').where({ id }).first());
  }

  async indexRow(id: string): Promise<IndexRow | undefined> {
    const r = await this.db('knowledge_indexes').where({ id }).first();
    return r ? indexFrom(r) : undefined;
  }

  async indexes(kbId: string): Promise<IndexRow[]> {
    return ((await this.db('knowledge_indexes').where({ kb_id: kbId }).orderBy('version', 'desc')) as Record<string, unknown>[]).map(indexFrom);
  }

  /** The serving index and any index being built beside it: new documents go to both. */
  private async liveIndexes(kbId: string): Promise<IndexRow[]> {
    return ((await this.db('knowledge_indexes').where({ kb_id: kbId }).whereIn('state', ['serving', 'building'])) as Record<string, unknown>[]).map(indexFrom);
  }

  async source(tenantId: string, id: string): Promise<SourceRow> {
    const r = await this.db('knowledge_sources').where({ tenant_id: tenantId, id }).first();
    if (!r) throw notFound('Source');
    return sourceFrom(r);
  }

  async sources(kbId: string): Promise<SourceRow[]> {
    return ((await this.db('knowledge_sources').where({ kb_id: kbId }).orderBy('created_at')) as Record<string, unknown>[]).map(sourceFrom);
  }

  async document(tenantId: string, id: string): Promise<DocRow> {
    const r = await this.db('knowledge_documents').where({ tenant_id: tenantId, id }).first();
    if (!r) throw notFound('Document');
    return docFrom(r);
  }

  /** Summary rows for the list: counts of documents and chunks the principal is cleared for. */
  async summaries(p: Principal) {
    const list = await this.visible(p);
    const ids = list.map((x) => x.kb.id);
    const cleared = labelsUpTo(p.clearance);
    const docs = new Map(((await this.db('knowledge_documents').whereIn('kb_id', ids.length ? ids : ['']).whereIn('label', cleared).whereNot({ state: 'removed' }).whereNull('staged_index_id').groupBy('kb_id').select('kb_id').count({ n: '*' })) as { kb_id: string; n: number }[]).map((r) => [r.kb_id, Number(r.n)]));
    const idx = ((await this.db('knowledge_indexes').whereIn('kb_id', ids.length ? ids : ['']).whereIn('state', ['serving', 'building'])) as Record<string, unknown>[]).map(indexFrom);
    const synced = new Map(((await this.db('knowledge_sources').whereIn('kb_id', ids.length ? ids : ['']).groupBy('kb_id').select('kb_id').max({ t: 'last_sync_at' })) as { kb_id: string; t: number | null }[]).map((r) => [r.kb_id, num(r.t)]));
    return list.map(({ kb, access }) => {
      const serving = idx.find((i) => i.kb_id === kb.id && i.state === 'serving') ?? null;
      return kbView(kb, { documents: docs.get(kb.id) ?? 0, chunks: serving?.chunks ?? 0, access, serving, building: idx.find((i) => i.kb_id === kb.id && i.state === 'building') ?? null, lastSyncAt: synced.get(kb.id) ?? null });
    });
  }

  // ---------- knowledge bases ----------

  /** An embedding model the base may use: in the catalogue, approved, with the embedding capability, cleared for the label. */
  private async checkEmbedModel(name: string, label: Label): Promise<void> {
    const m = await this.d.gateway.repo.modelByName(name);
    if (!m) throw conflict(`${name} is not in the model catalogue. Import and approve it on the Models screen first.`);
    if (!m.capabilities.includes('embedding')) throw conflict(`${name} is not an embedding model.`);
    if (m.state !== 'approved' && m.state !== 'deprecated') throw conflict(`${name} is ${m.state}; only approved models embed.`);
    if (labelRank(m.label) < labelRank(label)) throw conflict(`${name} is approved for data up to ${m.label}; this knowledge base is ${label}.`);
  }

  async create(p: Principal, input: { name: string; description: string | null; label: Label; embedModel: string; reranker: string | null; sharing: 'members' | 'curators'; workspaceId: string | null; chunking?: ChunkOptions }): Promise<KbRow> {
    if (!clears(p.clearance, input.label)) throw forbidden(`Your clearance is ${p.clearance}; a ${input.label} knowledge base is above it.`, { step: 'clearance' });
    if (input.workspaceId) {
      const ws = (await this.db('workspaces').where({ tenant_id: p.tenantId, id: input.workspaceId }).first()) as { label_ceiling: Label } | undefined;
      if (!ws) throw notFound('Workspace');
      if (labelRank(input.label) > labelRank(ws.label_ceiling)) throw forbidden(`This workspace's ceiling is ${ws.label_ceiling}.`, { step: 'zone' });
    }
    await this.checkEmbedModel(input.embedModel, input.label);
    if (input.reranker && !(await this.d.gateway.repo.modelByName(input.reranker))) throw conflict(`${input.reranker} is not in the model catalogue.`);
    const t = Date.now();
    const id = ulid();
    const indexId = ulid();
    await this.db.transaction(async (trx) => {
      await trx('knowledge_bases').insert({ id, tenant_id: p.tenantId, workspace_id: input.workspaceId, name: input.name, description: input.description, label: input.label, embed_model: input.embedModel, reranker: input.reranker, sharing: input.sharing, status: 'draft', chunking: JSON.stringify(input.chunking ?? DEFAULT_CHUNKING), serving_index_id: indexId, created_by: p.userId, created_at: t, updated_at: t });
      await trx('knowledge_indexes').insert({ id: indexId, tenant_id: p.tenantId, kb_id: id, version: 1, embed_model: input.embedModel, dims: null, state: 'serving', progress: 100, chunks: 0, created_by: p.userId, created_at: t, built_at: t });
    });
    return this.kbRow(id);
  }

  async update(p: Principal, id: string, patch: { name?: string; description?: string | null; label?: Label; reranker?: string | null; sharing?: 'members' | 'curators'; status?: 'draft' | 'published'; chunking?: ChunkOptions; visionProfile?: string | null; imageClassifiers?: string[] }): Promise<KbRow> {
    const kb = await this.base(p, id, 'manage');
    if (patch.label && !clears(p.clearance, patch.label)) throw forbidden(`Your clearance is ${p.clearance}.`, { step: 'clearance' });
    if (patch.visionProfile) await this.checkVisionProfile(p.tenantId, patch.visionProfile, patch.label ?? kb.label);
    const classifierIds = patch.imageClassifiers ? await this.checkImageClassifiers(p.tenantId, patch.imageClassifiers) : null;
    if (patch.reranker && !(await this.d.gateway.repo.modelByName(patch.reranker))) throw conflict(`${patch.reranker} is not in the model catalogue.`);
    if (patch.label && labelRank(patch.label) > labelRank(kb.label)) await this.checkEmbedModel(kb.embed_model, patch.label);
    const upd: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.name !== undefined) upd.name = patch.name;
    if (patch.description !== undefined) upd.description = patch.description;
    if (patch.label !== undefined) upd.label = patch.label;
    if (patch.reranker !== undefined) upd.reranker = patch.reranker;
    if (patch.sharing !== undefined) upd.sharing = patch.sharing;
    if (patch.status !== undefined) upd.status = patch.status;
    if (patch.chunking !== undefined) upd.chunking = JSON.stringify(patch.chunking);
    if (patch.visionProfile !== undefined) upd.vision_profile = patch.visionProfile;
    if (classifierIds) upd.image_classifiers = JSON.stringify(classifierIds);
    await this.db('knowledge_bases').where({ id: kb.id }).update(upd);
    if (classifierIds) {
      // Labels of classifiers no longer named go at once; a newly named one labels the images in the background.
      const gone = kb.image_classifiers.filter((c) => !classifierIds.includes(c));
      if (gone.length) {
        await this.db('knowledge_doc_labels').where({ kb_id: kb.id }).whereIn('classifier_id', gone).delete();
        // The categories those labels filed images under go with them.
        const filed = (await this.db('knowledge_doc_categories').where({ kb_id: kb.id }).whereIn('classifier_id', gone).distinct('document_id')) as { document_id: string }[];
        for (const r of filed) await this.syncLabelCategories({ id: r.document_id, tenant_id: kb.tenant_id, kb_id: kb.id });
      }
      const added = classifierIds.filter((c) => !kb.image_classifiers.includes(c));
      for (const c of added) await this.d.jobs.enqueue({ tenantId: kb.tenant_id, type: 'knowledge.reclassify', payload: { kbId: kb.id, classifierId: c }, createdBy: p.userId, maxAttempts: 2 });
    }
    // A higher floor applies to documents already indexed: their chunks take it at once.
    if (patch.label && labelRank(patch.label) > labelRank(kb.label)) {
      for (const d of ((await this.db('knowledge_documents').where({ kb_id: kb.id })) as Record<string, unknown>[]).map(docFrom)) {
        if (labelRank(d.label) < labelRank(patch.label)) await this.applyLabel(d, patch.label, d.label_origin);
      }
    }
    return this.kbRow(kb.id);
  }

  /**
   * B-8801: a vision profile for image documents: a profile of the tenant whose model reads images, cleared for the
   * base's label.
   */
  private async checkVisionProfile(tenantId: string, name: string, label: Label): Promise<void> {
    let r;
    try {
      r = await this.d.gateway.resolve(tenantId, name);
    } catch {
      throw conflict(`There is no profile ${name} that routes to a model.`);
    }
    if (!r.model.capabilities.includes('vision')) throw conflict(`The profile ${name} routes to ${r.model.name}, which cannot read images. Pick a profile with a vision model.`);
    if (labelRank(r.profile.label) < labelRank(label)) throw conflict(`The profile ${name} is cleared for data up to ${r.profile.label}; this knowledge base is ${label}.`);
    if (labelRank(r.model.label) < labelRank(label)) throw conflict(`${r.model.name} is approved for data up to ${r.model.label}; this knowledge base is ${label}.`);
  }

  /**
   * B-8802: the image classifiers a base may name: `vision` classifiers of the tenant (ids or slugs). Since migration
   * 046 a draft may be named too: its labels, and the categories they file images under, are provisional until it is
   * published (a guardrail rule may use a draft the same way).
   */
  private async checkImageClassifiers(tenantId: string, refs: string[]): Promise<string[]> {
    const ids: string[] = [];
    if (refs.length && !this.d.classifiers) throw conflict('Classifiers are not available on this server.');
    for (const ref of [...new Set(refs)]) {
      const c = await this.d.classifiers!.get(tenantId, ref);
      if (!c) throw notFound(`Classifier ${ref}`);
      if (c.engine !== 'vision') throw conflict(`${c.name} is a ${c.engine} classifier; image documents are labelled by vision classifiers.`);
      if (!ids.includes(c.id)) ids.push(c.id);
    }
    return ids;
  }

  async remove(p: Principal, id: string): Promise<{ documents: number }> {
    const kb = await this.base(p, id, 'manage');
    const docs = ((await this.db('knowledge_documents').where({ kb_id: kb.id })) as Record<string, unknown>[]).map(docFrom);
    for (const src of await this.sources(kb.id)) await this.replication.release(src);
    for (const i of await this.indexes(kb.id)) await this.d.vectors.drop(i.id);
    for (const d of docs) if (d.blob_key) await this.d.blobs.delete(d.blob_key);
    await this.db('knowledge_terms').whereIn('index_id', this.db('knowledge_indexes').where({ kb_id: kb.id }).select('id')).delete();
    await this.db('knowledge_chunks').where({ kb_id: kb.id }).delete();
    await this.db('knowledge_doc_labels').where({ kb_id: kb.id }).delete();
    await this.db('knowledge_doc_categories').where({ kb_id: kb.id }).delete();
    await this.db('knowledge_doc_changes').where({ kb_id: kb.id }).delete();
    for (const table of ['knowledge_revisions', 'knowledge_references', 'knowledge_reviewers']) await this.db(table).where({ kb_id: kb.id }).delete();
    await this.db('knowledge_bases').where({ id: kb.id }).delete();
    return { documents: docs.length };
  }

  // ---------- access list ----------

  async accessList(kb: KbRow) {
    const rows = (await this.db('knowledge_access').where({ kb_id: kb.id }).orderBy('created_at')) as { id: string; principal_kind: string; principal_id: string; access: string; created_by: string | null; created_at: number }[];
    const names = async (kind: string, id: string): Promise<string> => {
      const r = kind === 'user' ? await this.db('users').where({ id }).first('display_name as n') : kind === 'workspace' ? await this.db('workspaces').where({ id }).first('name as n') : kind === 'social_group' ? await this.db('social_groups').where({ id }).first('name as n') : await this.db('profiles').where({ id }).first('display_name as n');
      return (r as { n?: string } | undefined)?.n ?? id;
    };
    return Promise.all(rows.map(async (r) => ({ id: r.id, kind: r.principal_kind, principalId: r.principal_id, name: await names(r.principal_kind, r.principal_id), access: r.access, createdBy: r.created_by ? await names('user', r.created_by) : null, createdAt: Number(r.created_at) })));
  }

  async grant(p: Principal, kbId: string, input: { kind: 'workspace' | 'user' | 'profile' | 'social_group'; id: string; access: 'read' | 'manage' }) {
    const kb = await this.base(p, kbId, 'manage');
    const table = input.kind === 'user' ? 'users' : input.kind === 'workspace' ? 'workspaces' : input.kind === 'social_group' ? 'social_groups' : 'profiles';
    const target = await this.db(table).where({ tenant_id: p.tenantId, id: input.id }).modify((q) => { if (input.kind === 'social_group') void q.whereNot({ state: 'deleted' }); }).first();
    if (!target) throw notFound(input.kind === 'user' ? 'User' : input.kind === 'workspace' ? 'Workspace' : input.kind === 'social_group' ? 'Group' : 'Profile');
    if (input.kind === 'profile' && input.access !== 'read') throw conflict('A profile can only read a knowledge base (retrieval in chat).');
    await this.db('knowledge_access').where({ kb_id: kb.id, principal_kind: input.kind, principal_id: input.id }).delete();
    await this.db('knowledge_access').insert({ id: ulid(), tenant_id: p.tenantId, kb_id: kb.id, principal_kind: input.kind, principal_id: input.id, access: input.access, created_by: p.userId, created_at: Date.now() });
    return kb;
  }

  async revoke(p: Principal, kbId: string, grantId: string) {
    const kb = await this.base(p, kbId, 'manage');
    const n = await this.db('knowledge_access').where({ kb_id: kb.id, id: grantId }).delete();
    if (!n) throw notFound('Access entry');
    return kb;
  }

  // ---------- sources ----------

  async addSource(p: Principal, kbId: string, input: AddSourceInput): Promise<SourceRow> {
    const kb = await this.base(p, kbId, 'manage');
    const floor = highest(kb.label, input.labelFloor ?? kb.label);
    if (!clears(p.clearance, floor)) throw forbidden(`Your clearance is ${p.clearance}.`, { step: 'clearance' });
    let location = input.location.trim();
    let config: SourceRow['config'] = {};
    let secret: string | null = null;
    if (input.kind !== 'web' && (input.media || input.changes || input.maxMedia != null)) throw new HttpProblem(400, 'Invalid request', 'Indexing images and recording changes are for web sites.');
    if (input.kind === 'dataset') throw conflict('A dataset becomes a knowledge source through the import wizard (POST /api/imports/datasets with target knowledge), which records its licence and column mapping.');
    if (input.kind === 'upload') {
      const existing = (await this.sources(kb.id)).find((s) => s.kind === 'upload');
      if (existing) throw conflict('This knowledge base already has an upload source; upload files to it.');
      location = 'Uploads';
    } else if (input.kind === 's3') {
      const s3 = parseS3(location);
      if (!s3) throw new HttpProblem(400, 'Invalid request', 'Give the S3 location as s3://bucket/prefix/.');
      const include = (input.include ?? []).map((x) => x.trim()).filter(Boolean);
      for (const g of include) globRegex(g);
      if (input.endpoint) {
        // B-1501: an S3-compatible bucket of its own, on an internal endpoint (or one KNOWLEDGE_ALLOWED_HOSTS names).
        if (!input.accessKeyId || !input.secretAccessKey) throw new HttpProblem(400, 'Invalid request', 'A bucket on its own endpoint needs an access key id and a secret access key.');
        await this.checkFetchUrl(input.endpoint, 'S3 endpoint');
        secret = JSON.stringify({ accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey });
        config = { bucket: s3.bucket, prefix: s3.prefix, include, endpoint: input.endpoint.replace(/\/+$/, ''), region: input.region ?? 'us-east-1', pathStyle: input.pathStyle ?? true };
      } else {
        if (input.accessKeyId || input.secretAccessKey) throw new HttpProblem(400, 'Invalid request', 'Keys go with an endpoint; without one the platform\'s S3 credentials are used.');
        if (!this.o.s3) throw conflict('S3 is not configured on this platform (S3_ENDPOINT and its credentials). Give the bucket\'s own endpoint and keys, or ask an operator to configure S3.');
        config = { bucket: s3.bucket, prefix: s3.prefix, include };
      }
    } else if (input.kind === 'web') {
      // B-1502: an internal web site, crawled within its own origin.
      const url = await this.checkFetchUrl(location, 'site');
      location = url;
      const pathPrefix = (input.pathPrefix ?? '').trim();
      if (pathPrefix && !pathPrefix.startsWith('/')) throw new HttpProblem(400, 'Invalid request', 'A path prefix starts with /.');
      if (input.media && !kb.vision_profile) throw conflict(`${kb.name} has no vision profile, so the images of a site cannot be described. Name one in the knowledge base settings first.`);
      config = { url, maxDepth: input.maxDepth ?? 2, maxPages: input.maxPages ?? 100, pathPrefix, sitemap: input.sitemap ?? true, ...(input.media ? { media: true, maxMedia: input.maxMedia ?? 25 } : {}), ...(input.changes ? { changes: true } : {}) };
    } else if (input.kind === 'folder') {
      // B-2405: a file store folder the curator can read; its files are indexed up to the base's label.
      if (!this.folders) throw conflict('The file store is not available on this server.');
      const f = await this.folders.check(p, location);
      if (await this.db('knowledge_sources').where({ kb_id: kb.id, kind: 'folder', location: `folder: ${f.name}` }).whereRaw("config like ?", [`%${f.id}%`]).first('id')) throw conflict(`${f.name} is already a source of this knowledge base.`);
      location = `folder: ${f.name}`;
      config = { folderId: f.id };
    } else if (input.kind === 'saved-query' || input.kind === 'rest') {
      // 1.8.0 (B-125, B-126): rows of a saved query or a REST endpoint, read through its governed path at each sync.
      const provider = this.external[input.kind];
      if (!provider) throw conflict(`${input.kind === 'rest' ? 'REST connections are' : 'Saved queries are'} not available on this server.`);
      const out = await provider.check(p, input);
      location = out.location;
      config = { external: out.external };
      if (labelRank(out.floor) > labelRank(floor)) input = { ...input, labelFloor: out.floor };
    } else if (input.kind === 'git') {
      location = location.replace(/^git:\s*/i, '');
      config = { url: location, ref: input.ref ?? null, path: input.path ?? '' };
    } else {
      if (!input.connectionId) throw new HttpProblem(400, 'Invalid request', 'Pick the data connection the view is read through.');
      const conn = await this.d.connections.get(p.tenantId, input.connectionId);
      if (conn.engine === 'mongodb') return this.addMongoSource(p, kb, conn, input, location, floor);
      if (input.fields?.length) throw conflict('Fields are for MongoDB collections; a table or view is indexed whole.');
      if (!isSqlEngine(conn.engine) || !engineInfo(conn.engine).knowledgeSource) throw conflict('Only SQL tables and views, and MongoDB collections, can be a knowledge source.');
      const object = location.replace(/^(pg|mysql|mssql|azure-sql|oracle|snowflake|bigquery):\s*/i, '');
      // Unqualified names take the engine's home schema (PostgreSQL public, MySQL the connection's database, …).
      const schema = findObject(conn.schema ?? [], object, conn);
      if (!schema) throw conflict(`${object} is not in ${conn.name}'s introspected schema. Refresh the schema on the Connections screen.`);
      if (!allowedObject(conn, schema.name)) throw conflict(`${schema.name} is not on ${conn.name}'s schema allow-list.`);
      const cols = schema.columns.map((c) => c.name);
      // Oracle and Snowflake list unquoted names in upper case: the default picks match regardless of case.
      const named = (n: string) => cols.find((c) => c.toLowerCase() === n) ?? null;
      const wm = input.watermarkColumn ?? named('updated_at');
      if (wm && !cols.includes(wm)) throw conflict(`${schema.name} has no column ${wm}.`);
      const idCol = input.idColumn ?? named('id') ?? cols[0] ?? null;
      if (idCol && !cols.includes(idCol)) throw conflict(`${schema.name} has no column ${idCol}.`);
      if (input.accessColumn && !cols.includes(input.accessColumn)) throw conflict(`${schema.name} has no column ${input.accessColumn}.`);
      if (input.replication && conn.engine !== 'postgres') throw conflict('Logical replication is for PostgreSQL sources; MySQL sources sync by watermark.');
      if (input.replication && schema.kind === 'view') throw conflict(`${schema.name} is a view: PostgreSQL replicates tables only. Point the source at the table, or leave replication off to sync the view by watermark.`);
      if (input.replication && !idCol) throw conflict('Replication needs an id column to match changed rows to documents.');
      if (input.roleMappings?.length) await this.checkRoleMappings(p.tenantId, conn, schema.name, input, idCol);
      location = `${conn.engine === 'postgres' ? 'pg' : conn.engine}: ${schema.name}`;
      config = { connectionId: conn.id, object: schema.name, idColumn: idCol, watermarkColumn: input.roleMappings?.length ? null : wm, engine: conn.engine, accessColumn: input.accessColumn ?? null, ...(input.accessColumn ? { accessKind: input.accessKind ?? 'group' } : {}), ...(input.replication ? { replication: true, publication: input.publication ?? 'exprsn_knowledge' } : {}), ...(input.roleMappings?.length ? { roleMappings: input.roleMappings.map((m) => ({ group: m.group.trim().toLowerCase(), role: m.role })) } : {}) };
      // Rows are read at the connection's label: the source floor is at least that.
      if (labelRank(conn.label) > labelRank(floor)) input = { ...input, labelFloor: conn.label };
    }
    return this.insertSource(p, kb.id, input, location, config, secret, floor);
  }

  private async insertSource(p: Principal, kbId: string, input: AddSourceInput, location: string, config: SourceRow['config'], secret: string | null, floor: Label): Promise<SourceRow> {
    const t = Date.now();
    const id = ulid();
    await this.db('knowledge_sources').insert({ id, tenant_id: p.tenantId, kb_id: kbId, kind: input.kind, location, config: JSON.stringify(config), secret_sealed: secret ? await this.d.keys.seal(p.tenantId, secret, `knowledge-source:${id}`) : null, label_floor: highest(floor, input.labelFloor ?? floor), schedule: input.kind === 'upload' ? 'manual' : (input.schedule ?? '15m'), state: 'idle', created_by: p.userId, created_at: t, updated_at: t });
    const s = await this.source(p.tenantId, id);
    if (s.kind !== 'upload') await this.sync(p.userId, s);
    return this.source(p.tenantId, id);
  }

  /**
   * A MongoDB collection as a database source: the collection must be introspected and allow-listed; `fields` names
   * the text to index (by default the text fields of the sampled schema), `idColumn` the field that identifies a
   * document (`_id` by default), `watermarkColumn` an optional field that grows on every change (`updatedAt` or
   * `updated_at` when the sampled schema has one; null for none), and `accessColumn` an optional field listing the groups or users who may retrieve each document (B-1002). Documents
   * carry at least the connection's label. Replication and role mappings are PostgreSQL only.
   */
  private async addMongoSource(p: Principal, kb: { id: string }, conn: ConnectionRow, input: AddSourceInput, location: string, floor: Label): Promise<SourceRow> {
    if (input.replication) throw conflict('Logical replication is for PostgreSQL sources; MongoDB sources sync by watermark.');
    if (input.roleMappings?.length) throw conflict('Row security through database roles is for PostgreSQL sources.');
    const object = location.replace(/^mongo(db)?:\s*/i, '');
    const schema = (conn.schema ?? []).find((o) => o.name === object);
    if (!schema) throw conflict(`${object} is not in ${conn.name}'s introspected schema. Refresh the schema on the Connections screen.`);
    if (!allowedObject(conn, schema.name)) throw conflict(`${schema.name} is not on ${conn.name}'s allow-list.`);
    const cols = schema.columns.map((c) => c.name);
    // An explicit null keeps the source without a watermark (every sync reads the collection again).
    const wm = input.watermarkColumn === null ? null : input.watermarkColumn || (cols.includes('updatedAt') ? 'updatedAt' : cols.includes('updated_at') ? 'updated_at' : null);
    const idCol = input.idColumn || '_id';
    let fields = [...new Set((input.fields ?? []).map((f) => f.trim()).filter(Boolean))];
    // Without `fields`, the text fields of the sampled schema (not the id, watermark or access field) are indexed.
    if (!fields.length) fields = schema.columns.filter((c) => c.type === 'string' && ![idCol, wm, input.accessColumn].includes(c.name)).map((c) => c.name).slice(0, 50);
    if (!fields.length) throw new HttpProblem(400, 'Invalid request', `The sampled documents of ${schema.name} have no text fields. Name the fields whose text is indexed, such as title and body.`);
    const FIELD = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
    for (const f of [...fields, idCol, wm, input.accessColumn]) if (f != null && !FIELD.test(f)) throw new HttpProblem(400, 'Invalid request', `${f} is not a field name: letters, digits, _, - and dots for nested fields.`);
    const config: SourceRow['config'] = { connectionId: conn.id, object: schema.name, idColumn: idCol, watermarkColumn: wm, engine: 'mongodb', fields, accessColumn: input.accessColumn ?? null, ...(input.accessColumn ? { accessKind: input.accessKind ?? 'group' } : {}) };
    // Documents are read at the connection's label: the source floor is at least that.
    if (labelRank(conn.label) > labelRank(floor)) input = { ...input, labelFloor: conn.label };
    return this.insertSource(p, kb.id, input, `mongo: ${schema.name}`, config, null, floor);
  }

  private get allow(): AllowList {
    return this.o.allowedHosts ?? parseAllowList('');
  }

  /**
   * Checks an S3 endpoint or a site's start URL (B-1501, B-1502): http(s) without credentials, and every address the
   * host resolves to internal (or named in KNOWLEDGE_ALLOWED_HOSTS), never link-local or metadata. Returns the URL
   * without its fragment.
   */
  private async checkFetchUrl(raw: string, what: string): Promise<string> {
    let u: URL;
    try {
      u = new URL(raw.trim());
    } catch {
      throw new HttpProblem(400, 'Invalid request', `The ${what} is not a URL.`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpProblem(400, 'Invalid request', `The ${what} must start with http:// or https://.`);
    if (u.username || u.password) throw new HttpProblem(400, 'Invalid request', 'Credentials do not belong in the URL.');
    try {
      await checkHost(u.hostname, this.allow);
    } catch (err) {
      if (err instanceof HostRefused) throw conflict(`${err.message} Knowledge sources reach internal hosts, and those an operator names in KNOWLEDGE_ALLOWED_HOSTS.`);
      throw err;
    }
    u.hash = '';
    return u.toString();
  }

  /** A dispatcher whose every connection is checked against the knowledge host rules, plus the literal check. */
  private async fetchAgent(url: string) {
    // Address literals skip the dispatcher's lookup, so the host is checked here as well.
    await checkHost(new URL(url).hostname, this.allow);
    const t = this.o.fetchTimeoutMs ?? 30_000;
    return guardedAgent(this.allow, t);
  }

  /**
   * Row security through database roles (B-1503): PostgreSQL only; not with an access column or replication (the
   * stream would bypass the policies); each role must exist, have the connection's account as a member, be neither
   * superuser nor BYPASSRLS, and may select the object; the object must enforce row security for the role (a table
   * with it enabled, and forced if the role owns it; a view only with security_invoker).
   */
  private async checkRoleMappings(tenantId: string, conn: { id: string; engine: string; name: string }, object: string, input: AddSourceInput, idCol: string | null): Promise<void> {
    const maps = input.roleMappings ?? [];
    if (conn.engine !== 'postgres') throw conflict('Row security through database roles is for PostgreSQL sources.');
    if (input.accessColumn) throw conflict('Use either an access column or role mappings, not both.');
    if (input.replication) throw conflict('Replicated changes do not pass through row security policies; role mappings sync by full reads instead. Turn replication off.');
    if (!idCol) throw conflict('Role mappings need an id column to merge what each role sees.');
    const groups = new Set<string>();
    for (const m of maps) {
      const g = m.group.trim().toLowerCase();
      if (groups.has(g)) throw conflict(`The group ${m.group} is mapped twice.`);
      groups.add(g);
    }
    const roles = [...new Set(maps.map((m) => m.role))];
    let check;
    try {
      check = await this.d.connections.roleCheck(tenantId, conn.id, object, roles);
    } catch (err) {
      if (err instanceof HttpProblem) throw err;
      throw conflict(`The roles could not be checked on ${conn.name}: ${(err as Error).message}`);
    }
    const o = check.object;
    if (o.kind === 'missing' || o.kind === 'other') throw conflict(`${object} is not a table or view on ${conn.name}.`);
    if (o.kind === 'view' && !o.securityInvoker) throw conflict(`${object} is a view that reads as its owner, so row security would not see the mapped roles. Create it WITH (security_invoker = true) (PostgreSQL 15 or later), or point the source at the table.`);
    if (o.kind === 'table' && !o.rowSecurity) throw conflict(`${object} does not have row level security enabled (ALTER TABLE ${object} ENABLE ROW LEVEL SECURITY), so every mapped role would see every row.`);
    for (const r of check.roles) {
      if (!r.exists) throw conflict(`There is no role ${r.role} on ${conn.name}.`);
      if (!r.member) throw conflict(`The connection's account ${check.account} is not a member of ${r.role}: GRANT ${r.role} TO ${check.account};`);
      if (r.bypass) throw conflict(`${r.role} is a superuser or has BYPASSRLS, so row security does not apply to it.`);
      if (!r.canSelect) throw conflict(`${r.role} may not select from ${object}: GRANT SELECT ON ${object} TO ${r.role};`);
      if (o.kind === 'table' && o.owner === r.role && !o.forced) throw conflict(`${r.role} owns ${object}, and owners bypass row security unless it is forced (ALTER TABLE ${object} FORCE ROW LEVEL SECURITY).`);
    }
  }

  /** Queues a sync of a source unless one is already queued or running. */
  async sync(by: string | null, s: SourceRow): Promise<{ jobId: string }> {
    if (s.kind === 'upload') throw conflict('Uploads have no sync; upload the files instead.');
    if (s.job_id) {
      const j = await this.d.jobs.get(s.tenant_id, s.job_id);
      if (j && (j.state === 'queued' || j.state === 'running')) return { jobId: j.id };
    }
    // B-3805: a dataset source is refreshed by an import job, which re-fetches, re-scrubs and applies the rows.
    if (s.kind === 'dataset') {
      if (!this.datasets) throw conflict('Dataset import is not available on this server.');
      const out = await this.datasets.refresh(by, s);
      await this.db('knowledge_sources').where({ id: s.id }).update({ state: 'syncing', job_id: out.jobId, updated_at: Date.now() });
      return out;
    }
    const job = await this.d.jobs.enqueue({ tenantId: s.tenant_id, type: 'knowledge.sync', payload: { sourceId: s.id }, createdBy: by, maxAttempts: 2 });
    await this.db('knowledge_sources').where({ id: s.id }).update({ state: 'syncing', job_id: job.id, updated_at: Date.now() });
    return { jobId: job.id };
  }

  /**
   * A manual refresh of a whole base the caller manages. `all` queues a sync of every source that has one (a web
   * source fetches its pages and their images again; unchanged documents are skipped). `images` keeps what was
   * fetched and has the vision profile describe every image document again (caption and the text read in it).
   */
  async refresh(p: Principal, kbId: string, what: 'all' | 'images'): Promise<{ what: 'all' | 'images'; sources: number; images: number; jobs: string[] }> {
    const kb = await this.base(p, kbId, 'manage');
    const jobs: string[] = [];
    if (what === 'all') {
      const sources = (await this.sources(kb.id)).filter((s) => s.kind !== 'upload');
      for (const s of sources) jobs.push((await this.sync(p.userId, s)).jobId);
      return { what, sources: sources.length, images: 0, jobs };
    }
    if (!kb.vision_profile) throw conflict(`${kb.name} has no vision profile, so its images cannot be described. Name one in Image settings first.`);
    const docs = ((await this.db('knowledge_documents').where({ kb_id: kb.id, media: 'image' }).whereNotIn('state', ['quarantined', 'scanning', 'rejected', 'removed', 'hidden', 'queued']).select('id', 'tenant_id')) as { id: string; tenant_id: string }[]);
    for (let i = 0; i < docs.length; i += 500) await this.db('knowledge_documents').whereIn('id', docs.slice(i, i + 500).map((d) => d.id)).update({ state: 'queued', error: null, trace_id: null, updated_at: Date.now() });
    for (const d of docs) jobs.push((await this.d.jobs.enqueue({ tenantId: d.tenant_id, type: 'knowledge.index', payload: { documentId: d.id }, createdBy: p.userId, maxAttempts: 1 })).id);
    return { what, sources: 0, images: docs.length, jobs };
  }

  /**
   * B-3805: a source of kind `dataset` on a base the caller manages. Nothing is synced here: the import job that
   * asked for it fetches the rows and calls `applyDataset`.
   */
  async addDatasetSource(p: Principal, kbId: string, input: { location: string; labelFloor: Label; dataset: DatasetSourceConfig }): Promise<SourceRow> {
    const kb = await this.base(p, kbId, 'manage');
    const floor = highest(kb.label, input.labelFloor);
    if (!clears(p.clearance, floor)) throw forbidden(`Your clearance is ${p.clearance}.`, { step: 'clearance' });
    const t = Date.now();
    const id = ulid();
    // The refresh schedule is the dataset's own (`config.dataset`), so the 15-minute tick leaves the source alone.
    await this.db('knowledge_sources').insert({ id, tenant_id: p.tenantId, kb_id: kb.id, kind: 'dataset', location: input.location.slice(0, 500), config: JSON.stringify({ dataset: input.dataset }), secret_sealed: null, label_floor: floor, schedule: 'manual', state: 'idle', created_by: p.userId, created_at: t, updated_at: t });
    return this.source(p.tenantId, id);
  }

  /**
   * B-3805: the rows of a dataset source as documents (a full listing: rows the publisher dropped are removed).
   * The first load fills the serving index. A refresh of a source that has rows in it builds the next index version
   * beside the serving one and swaps it in (`refreshBeside`), so search answers from the last good rows until then.
   */
  async applyDataset(s: SourceRow, items: SourceItem[], ctx: Pick<JobContext, 'signal' | 'progress'>): Promise<{ added: number; changed: number; unchanged: number; removed: number; setAside?: number; indexVersion?: number; retiredVersion?: number }> {
    await this.db('knowledge_sources').where({ id: s.id }).update({ state: 'syncing', updated_at: Date.now() });
    await this.discardStaged(s);
    const serving = (await this.indexes(s.kb_id)).find((i) => i.state === 'serving');
    const loaded = serving ? await this.db('knowledge_documents').where({ source_id: s.id }).whereIn('state', ['indexed', 'unchanged']).first('id') : null;
    if (!serving || !loaded) return this.apply(s, items, true, ctx, 'text/markdown');
    return this.refreshBeside(s, serving, items, ctx);
  }

  /**
   * What a refresh that did not finish left behind, and what a finished one replaced: the documents of the source
   * that belong to one index version only, and a version still marked as building for it.
   */
  private async discardStaged(s: SourceRow): Promise<void> {
    for (const idx of ((await this.db('knowledge_indexes').where({ kb_id: s.kb_id, source_id: s.id, state: 'building' })) as Record<string, unknown>[]).map(indexFrom)) {
      await this.db('knowledge_indexes').where({ id: idx.id, state: 'building' }).update({ state: 'cancelled', message: 'The refresh stopped; the partial index was discarded' });
      await this.dropIndex(idx.id);
    }
    for (const d of ((await this.db('knowledge_documents').where({ source_id: s.id }).whereNotNull('staged_index_id')) as Record<string, unknown>[]).map(docFrom)) await this.purgeDocument(d);
  }

  /** The chunks an index holds, by document: how many and the lowest id, which tells one writing of them from the next. */
  private async chunkSets(indexId: string): Promise<Map<string, string>> {
    const rows = (await this.db('knowledge_chunks').where({ index_id: indexId }).groupBy('document_id').select('document_id').count({ n: '*' }).min({ m: 'id' })) as { document_id: string; n: number; m: string }[];
    return new Map(rows.map((r) => [r.document_id, `${Number(r.n)}:${r.m}`]));
  }

  /**
   * Copies a document's chunks, keyword terms and vectors from one index version into another without embedding
   * them again. A chunk is sealed with its id, so each is opened and sealed under its new one.
   */
  private async copyChunks(from: IndexRow, to: IndexRow, documentId: string): Promise<{ from: string; to: string } | null> {
    const rows = (await this.db('knowledge_chunks').where({ index_id: from.id, document_id: documentId }).orderBy('seq')) as (Record<string, unknown> & { id: string; tenant_id: string; content: string })[];
    if (!rows.length) return null;
    const ids = new Map<string, string>();
    const out: Record<string, unknown>[] = [];
    for (const r of rows) {
      const id = ulid();
      ids.set(r.id, id);
      out.push({ ...r, id, index_id: to.id, content: await this.sealChunk(r.tenant_id, id, await this.openChunk(r.tenant_id, r.id, r.content)) });
    }
    for (let i = 0; i < out.length; i += 100) await this.db('knowledge_chunks').insert(out.slice(i, i + 100));
    const old = [...ids.keys()];
    for (let i = 0; i < old.length; i += 200) {
      const terms = (await this.db('knowledge_terms').where({ index_id: from.id }).whereIn('chunk_id', old.slice(i, i + 200)).select('tenant_id', 'chunk_id', 'term', 'tf', 'label_rank')) as { tenant_id: string; chunk_id: string; term: string; tf: number; label_rank: number }[];
      for (let j = 0; j < terms.length; j += 200) await this.db('knowledge_terms').insert(terms.slice(j, j + 200).map((t) => ({ ...t, index_id: to.id, chunk_id: ids.get(t.chunk_id)! })));
    }
    await this.d.vectors.copy(from.id, to.id, [...ids]);
    const lowest = (xs: string[]) => xs.reduce((a, b) => (a < b ? a : b));
    return { from: `${rows.length}:${lowest(old)}`, to: `${rows.length}:${lowest([...ids.values()])}` };
  }

  /**
   * B-3805: a refresh of a dataset source as a new index version, built beside the serving one and swapped in.
   *
   * New and changed rows become staged documents, indexed into the new version only; the rows they replace, and the
   * rows the publisher dropped, stay as they are in the serving version. Everything else in the base (unchanged rows,
   * the documents of its other sources) is copied across with its vectors. One transaction then makes the new
   * version the serving one, retires the old one and gives the staged documents their keys. Until it commits, search
   * reads the old version; when the refresh fails or is cancelled the new version and its documents are discarded and
   * nothing that serves has changed.
   */
  private async refreshBeside(s: SourceRow, serving: IndexRow, items: SourceItem[], ctx: Pick<JobContext, 'signal' | 'progress'>): Promise<{ added: number; changed: number; unchanged: number; removed: number; setAside?: number; indexVersion: number; retiredVersion: number }> {
    const building = (await this.indexes(s.kb_id)).find((i) => i.state === 'building');
    if (building) throw conflict(`Index v${building.version} of this knowledge base is building. The refresh needs a version of its own; it is tried again later.`);
    const kb = await this.kbRow(s.kb_id);
    const last = ((await this.db('knowledge_indexes').where({ kb_id: s.kb_id }).max({ v: 'version' })) as { v: number }[])[0]?.v ?? 0;
    const id = ulid();
    await this.db('knowledge_indexes').insert({ id, tenant_id: s.tenant_id, kb_id: s.kb_id, version: Number(last) + 1, embed_model: serving.embed_model, dims: serving.dims, state: 'building', progress: 0, message: `Refresh of ${s.location}`.slice(0, 300), chunks: 0, created_by: null, created_at: Date.now(), source_id: s.id });
    const idx = (await this.indexRow(id))!;
    try {
      const existing = new Map(((await this.db('knowledge_documents').where({ source_id: s.id }).whereNull('parent_id').whereNull('staged_index_id')) as Record<string, unknown>[]).map(docFrom).map((d) => [d.external_key, d]));
      const seen = new Set<string>();
      // The documents the new version leaves out: rows that changed (their new text is staged) and rows that are gone.
      const superseded = new Set<string>();
      let added = 0;
      let changed = 0;
      let unchanged = 0;
      let removed = 0;
      let setAside = 0;
      const step = async (i: number) => {
        const cur = await this.indexRow(idx.id);
        if (cur?.state !== 'building') throw conflict('The index build of this refresh was cancelled.');
        await this.db('knowledge_indexes').where({ id: idx.id }).update({ progress: Math.floor(((i + 1) / Math.max(1, items.length)) * 60), message: `Refresh of ${s.location}: ${i + 1} of ${items.length} rows read`.slice(0, 300) });
        await ctx.progress(((i + 1) / Math.max(1, items.length)) * 60, `Read ${i + 1} of ${items.length}`);
      };
      for (const [i, it] of items.entries()) {
        if (ctx.signal.aborted) throw ctx.signal.reason as Error;
        const key = sha(it.key);
        seen.add(key);
        const prev = existing.get(key);
        if (prev?.state === 'removed') continue;
        if (prev && it.version && prev.version === it.version && prev.state !== 'failed') {
          unchanged++;
          continue;
        }
        const data = await it.read();
        const hash = sha(data);
        if (prev && prev.sha256 === hash && prev.state !== 'failed') {
          await this.db('knowledge_documents').where({ id: prev.id }).update({ version: it.version });
          unchanged++;
          continue;
        }
        const docId = ulid();
        const t = Date.now();
        const blobKey = await this.store({ id: docId, tenant_id: s.tenant_id }, data);
        await this.db('knowledge_documents').insert({ id: docId, tenant_id: s.tenant_id, kb_id: s.kb_id, source_id: s.id, external_key: sha(`staged:${idx.id}:${it.key}`), staged_key: key, staged_index_id: idx.id, name: it.name.slice(0, 300), type: 'text/markdown', size: data.length, sha256: hash, version: it.version, label: highest(kb.label, s.label_floor), auto_label: null, manual_label: prev?.manual_label ?? null, label_origin: 'inherited', detections: null, state: 'queued', blob_key: blobKey, chunks: 0, created_at: prev?.created_at ?? t, updated_at: t, acl: it.acl == null ? null : JSON.stringify(it.acl) });
        if (prev) {
          superseded.add(prev.id);
          changed++;
        } else added++;
        const doc = await this.document(s.tenant_id, docId);
        try {
          await this.indexInto(doc, [idx]);
        } catch (err) {
          if (!(await this.setAside(doc, err))) throw err;
          setAside++;
        }
        if (i % 20 === 19 || i === items.length - 1) await step(i);
      }
      for (const [key, d] of existing) {
        if (seen.has(key) || d.state === 'removed') continue;
        superseded.add(d.id);
        removed++;
      }

      // Everything else the serving version holds goes across as it is. Syncs of the base's other sources write to
      // both versions while this one builds, so a second look catches what changed under the copy.
      const copied = new Map<string, { from: string; to: string }>();
      for (let pass = 0; pass < 3; pass++) {
        const from = await this.chunkSets(serving.id);
        const to = await this.chunkSets(idx.id);
        let moved = 0;
        const todo = [...from].filter(([docId]) => !superseded.has(docId));
        for (const [n, [docId, set]] of todo.entries()) {
          if (ctx.signal.aborted) throw ctx.signal.reason as Error;
          const mine = copied.get(docId);
          const has = to.get(docId);
          // Written here by a sync since, or copied and still current: nothing to do.
          if (has && (!mine || mine.to !== has || mine.from === set)) continue;
          if (has) await this.removeFromIndex(idx.id, docId);
          const out = await this.copyChunks(serving, idx, docId);
          if (out) copied.set(docId, out);
          moved++;
          if (pass === 0 && n % 50 === 49) {
            const cur = await this.indexRow(idx.id);
            if (cur?.state !== 'building') throw conflict('The index build of this refresh was cancelled.');
            await this.db('knowledge_indexes').where({ id: idx.id }).update({ progress: 60 + Math.floor(((n + 1) / todo.length) * 38), message: `Refresh of ${s.location}: ${n + 1} of ${todo.length} unchanged documents carried over`.slice(0, 300) });
            await ctx.progress(60 + ((n + 1) / todo.length) * 38, `Carried over ${n + 1} of ${todo.length}`);
          }
        }
        // A document deleted from the serving version after its copy was made.
        for (const [docId, mine] of copied) {
          if (from.has(docId) || to.get(docId) !== mine.to) continue;
          await this.removeFromIndex(idx.id, docId);
          copied.delete(docId);
          moved++;
        }
        if (!moved) break;
      }

      // The switch: one transaction moves serving to the new version, retires the old one, and hands the staged
      // documents the keys of the rows they replace.
      const chunks = await this.countChunks(idx.id);
      const gone = [...superseded];
      const switched = await this.db.transaction(async (trx) => {
        const n = await trx('knowledge_indexes').where({ id: idx.id, state: 'building' }).update({ state: 'serving', progress: 100, built_at: Date.now(), message: null, chunks });
        if (!n) return false;
        await trx('knowledge_indexes').where({ id: serving.id }).update({ state: 'retired' });
        await trx('knowledge_bases').where({ id: s.kb_id }).update({ serving_index_id: idx.id, updated_at: Date.now() });
        for (let i = 0; i < gone.length; i += 500) await trx('knowledge_documents').whereIn('id', gone.slice(i, i + 500)).update({ external_key: trx.ref('id'), staged_index_id: serving.id });
        await trx('knowledge_documents').where({ source_id: s.id, staged_index_id: idx.id }).update({ external_key: trx.ref('staged_key'), staged_key: null, staged_index_id: null });
        return true;
      });
      if (!switched) throw conflict('The index build of this refresh was cancelled.');
      // The old version, and the rows only it held, are not needed any more.
      await this.dropIndex(serving.id);
      await this.discardStaged(s);
      const old = (await this.db('knowledge_indexes').where({ kb_id: s.kb_id, source_id: s.id }).whereIn('state', ['retired', 'cancelled', 'failed']).orderBy('version', 'desc').offset(REFRESH_VERSIONS_KEPT).limit(1000).select('id')) as { id: string }[];
      if (old.length) await this.db('knowledge_indexes').whereIn('id', old.map((x) => x.id)).delete();
      await ctx.progress(100, `Index v${idx.version} serves`);
      return { added, changed, unchanged, removed, ...(setAside ? { setAside } : {}), indexVersion: idx.version, retiredVersion: serving.version };
    } catch (err) {
      // Nothing that serves was touched: the partial version and its staged documents go, the last good one stays.
      const n = await this.db('knowledge_indexes').where({ id: idx.id, state: 'building' }).update({ state: 'failed', error: (err as Error).message.slice(0, 500), message: 'The refresh failed; the serving version is unchanged' });
      const cur = await this.indexRow(idx.id);
      if (n || cur?.state === 'cancelled' || cur?.state === 'failed') {
        await this.dropIndex(idx.id);
        await this.discardStaged(s);
      }
      throw err;
    }
  }

  /** B-3805: how a refresh of a dataset source ended. A failed one leaves the documents of the last good one. */
  async settleDataset(s: SourceRow, out: { dataset: DatasetSourceConfig; watermark?: string | null; error?: string | null }): Promise<void> {
    const t = Date.now();
    await this.db('knowledge_sources').where({ id: s.id }).update({ config: JSON.stringify({ ...s.config, dataset: out.dataset }), state: out.error ? 'failed' : 'idle', last_sync_at: t, last_error: out.error ? out.error.slice(0, 500) : null, last_trace: out.error ? traceId() : null, ...(out.watermark !== undefined ? { watermark: out.watermark } : {}), updated_at: t });
  }

  /** B-3805: every dataset source of a tenant (the import service's refresh tick reads their schedules). */
  async datasetSources(tenantId: string): Promise<SourceRow[]> {
    return ((await this.db('knowledge_sources').where({ tenant_id: tenantId, kind: 'dataset' })) as Record<string, unknown>[]).map(sourceFrom);
  }

  async removeSource(p: Principal, sourceId: string): Promise<{ documents: number }> {
    const s = await this.source(p.tenantId, sourceId);
    await this.base(p, s.kb_id, 'manage');
    const docs = ((await this.db('knowledge_documents').where({ source_id: s.id })) as Record<string, unknown>[]).map(docFrom);
    await this.replication.release(s);
    for (const d of docs) await this.purgeDocument(d);
    await this.db('knowledge_doc_changes').where({ source_id: s.id }).delete();
    await this.db('knowledge_sources').where({ id: s.id }).delete();
    return { documents: docs.length };
  }

  // ---------- documents ----------

  async documents(p: Principal, kbId: string, opts: { q?: string; limit?: number; media?: 'image'; labels?: LabelFilter; categories?: CategoryFilter } = {}) {
    const kb = await this.base(p, kbId);
    // A document staged for an index version that is still building (B-3805) is not part of the base yet.
    const q = this.db('knowledge_documents').where({ kb_id: kb.id }).whereNull('staged_index_id').whereIn('label', labelsUpTo(p.clearance));
    if (opts.q) q.andWhere('name', 'like', `%${opts.q.replace(/[%_\\]/g, (c) => '\\' + c)}%`);
    if (opts.media) q.andWhere({ media: opts.media });
    // B-8804: the label filter chips: image documents carrying the labels.
    if (opts.labels && (opts.labels.any?.length || opts.labels.all?.length)) {
      const ids = await this.docsWithLabels([kb.id], opts.labels, labelRank(p.clearance));
      q.whereIn('id', ids.size ? [...ids] : ['']);
    }
    if (opts.categories && (opts.categories.any?.length || opts.categories.all?.length)) {
      const ids = await this.docsInCategories([kb.id], opts.categories);
      q.whereIn('id', ids.size ? [...ids] : ['']);
    }
    let rows = ((await q.orderBy('updated_at', 'desc').limit(Math.min(opts.limit ?? 200, 1000))) as Record<string, unknown>[]).map(docFrom);
    if (!this.canCurate(p) && rows.some((d) => d.acl)) {
      const reader = await readerEntries(this.db, p);
      rows = rows.filter((d) => aclAllows(d.acl, reader));
    }
    const sources = new Map((await this.sources(kb.id)).map((s) => [s.id, s]));
    const labels = await this.labelsOf(rows.filter((d) => d.media === 'image').map((d) => d.id));
    const categories = await this.categoriesOf(rows.map((d) => d.id));
    const filed = await this.filedByClassifier(rows.filter((d) => d.media === 'image').map((d) => d.id));
    return rows.map((d) => ({ ...docView(d, sources.get(d.source_id), d.media === 'image' ? (labels.get(d.id) ?? []) : undefined, categories.get(d.id) ?? []), ...(filed.has(d.id) ? { filedByClassifier: filed.get(d.id)! } : {}) }));
  }

  // ---------- categories (migration 043) ----------

  /** The categories documents are filed under, by document, in order. A document filed nowhere has no entry. */
  async categoriesOf(docIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    for (let i = 0; i < docIds.length; i += 500) {
      for (const r of (await this.db('knowledge_doc_categories').whereIn('document_id', docIds.slice(i, i + 500)).andWhere({ direct: 1 }).orderBy('path').select('document_id', 'path')) as { document_id: string; path: string }[]) out.set(r.document_id, [...(out.get(r.document_id) ?? []), r.path]);
    }
    return out;
  }

  /**
   * The documents of these bases in or under the filter's categories, with the images taken out of them (a PDF's
   * pictures are filed where the PDF is). Who may read them is the caller's question: this is only where they are.
   */
  async docsInCategories(kbIds: string[], f: CategoryFilter): Promise<Set<string>> {
    const any = [...new Set(f.any ?? [])];
    const all = [...new Set(f.all ?? [])];
    const rows = (await this.db('knowledge_doc_categories').whereIn('kb_id', kbIds.length ? kbIds : ['']).whereIn('path', [...new Set([...any, ...all])].concat([''])).select('document_id', 'path')) as { document_id: string; path: string }[];
    const filed = new Map<string, Set<string>>();
    for (const r of rows) filed.set(r.document_id, (filed.get(r.document_id) ?? new Set()).add(r.path));
    const out = new Set<string>();
    for (const [doc, has] of filed) if ((!any.length || any.some((c) => has.has(c))) && all.every((c) => has.has(c))) out.add(doc);
    const ids = [...out];
    for (let i = 0; i < ids.length; i += 500) for (const r of (await this.db('knowledge_documents').whereIn('parent_id', ids.slice(i, i + 500)).select('id')) as { id: string }[]) out.add(r.id);
    return out;
  }

  /**
   * The categories in use in these bases, each with how many documents the reader may see are in or under it and how
   * many are filed in it directly. With `searchable`, only documents a search can return count. Documents with row
   * access count only for a curator.
   */
  async categoryCounts(p: Principal, kbs: KbRow[], opts: { searchable?: boolean } = {}): Promise<{ path: string; depth: number; documents: number; direct: number }[]> {
    if (!kbs.length) return [];
    const q = this.db('knowledge_doc_categories as c')
      .join('knowledge_documents as d', 'd.id', 'c.document_id')
      .whereIn('c.kb_id', kbs.map((x) => x.id))
      .whereIn('d.label', labelsUpTo(p.clearance));
    if (opts.searchable) q.whereIn('d.state', ['indexed', 'unchanged']);
    else q.whereNotIn('d.state', ['removed', 'hidden']);
    if (!this.canCurate(p)) q.whereNull('d.acl');
    const rows = (await q.groupBy('c.path', 'c.depth').select('c.path', 'c.depth').countDistinct({ n: 'c.document_id' }).sum({ direct: 'c.direct' })) as { path: string; depth: number; n: number | string; direct: number | string }[];
    return rows.map((r) => ({ path: r.path, depth: Number(r.depth), documents: Number(r.n), direct: Number(r.direct) })).sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Files a document under categories: `set` replaces them, `add` and `remove` change them. Needs manage access on
   * the base. A category is stored once in one spelling (`categoryPath`); a document carries at most
   * `MAX_CATEGORIES` that were given to it. The categories a vision classifier filed an image under follow its
   * labels and are not changed here; `before` and `after` list them too.
   */
  async setCategories(p: Principal, id: string, input: unknown, mode: 'set' | 'add' | 'remove' = 'set'): Promise<{ doc: DocRow; before: string[]; after: string[] }> {
    const { doc } = await this.documentFor(p, id, 'manage');
    if (doc.state === 'removed') throw notFound('Document');
    const now = await this.categoryRows(doc.id);
    let manual: string[];
    try {
      const given = categoryPaths(input, 100);
      manual = mode === 'set' ? categoryPaths(given) : mode === 'add' ? categoryPaths([...now.manual, ...given]) : now.manual.filter((c) => !given.some((g) => c === g || c.startsWith(`${g}/`)));
    } catch (err) {
      if (err instanceof CategoryError) throw badRequest(err.message);
      throw err;
    }
    await this.writeCategories(doc, manual, now.filed, p.userId);
    const all = (list: string[]) => [...new Set([...list, ...now.filed.map((f) => f.path)])].sort();
    return { doc, before: all(now.manual), after: all(manual) };
  }

  /** A document's own categories: the ones given to it and the ones a classifier filed it under. */
  private async categoryRows(docId: string): Promise<{ manual: string[]; filed: { path: string; classifierId: string }[] }> {
    const rows = (await this.db('knowledge_doc_categories').where({ document_id: docId, direct: 1 }).orderBy('path').select('path', 'origin', 'classifier_id')) as { path: string; origin: string; classifier_id: string | null }[];
    return { manual: rows.filter((r) => r.origin !== 'classifier').map((r) => r.path), filed: rows.filter((r) => r.origin === 'classifier' && r.classifier_id).map((r) => ({ path: r.path, classifierId: r.classifier_id! })) };
  }

  /**
   * Replaces a document's category rows: one per category and per category that one is under. A category given to
   * the document and also filed by a classifier is kept as given.
   */
  private async writeCategories(doc: Pick<DocRow, 'id' | 'tenant_id' | 'kb_id'>, manual: string[], filed: { path: string; classifierId: string }[], by: string | null): Promise<void> {
    const t = Date.now();
    const given = new Set(manual);
    const underGiven = new Set(manual.flatMap(categoryAncestors));
    const auto = new Map(filed.filter((f) => !given.has(f.path)).map((f) => [f.path, f.classifierId]));
    const rows = [...new Set([...manual, ...auto.keys()].flatMap(categoryAncestors))].map((path) => ({ document_id: doc.id, path, tenant_id: doc.tenant_id, kb_id: doc.kb_id, depth: path.split('/').length, direct: given.has(path) || auto.has(path) ? 1 : 0, origin: underGiven.has(path) ? 'manual' : 'classifier', classifier_id: given.has(path) ? null : (auto.get(path) ?? null), created_by: by, created_at: t }));
    await this.db.transaction(async (trx) => {
      await trx('knowledge_doc_categories').where({ document_id: doc.id }).delete();
      if (rows.length) await trx('knowledge_doc_categories').insert(rows);
    });
  }

  /**
   * Migration 046: files an image under the categories of its labels, `images/<classifier>/<label>` for each label
   * a classifier of the base gave it at or above the threshold, and takes away the ones whose label no longer holds.
   * The categories given to the document stay.
   */
  private async syncLabelCategories(doc: Pick<DocRow, 'id' | 'tenant_id' | 'kb_id'>): Promise<void> {
    const hits = (await this.db('knowledge_doc_labels as l').join('classifiers as c', 'c.id', 'l.classifier_id').where({ 'l.document_id': doc.id, 'l.hit': true }).select('l.label', 'c.id', 'c.slug')) as { label: string; id: string; slug: string }[];
    const filed = hits.map((h) => ({ path: labelCategory(h.slug, h.label), classifierId: h.id })).filter((f): f is { path: string; classifierId: string } => !!f.path);
    const now = await this.categoryRows(doc.id);
    if (now.filed.map((f) => `${f.path}|${f.classifierId}`).sort().join(',') === filed.map((f) => `${f.path}|${f.classifierId}`).sort().join(',')) return;
    await this.writeCategories(doc, now.manual, filed, null);
  }

  /** The categories vision classifiers filed these documents under, by document, with whether each is provisional. */
  async filedByClassifier(docIds: string[]): Promise<Map<string, FiledByClassifier[]>> {
    const out = new Map<string, FiledByClassifier[]>();
    if (!docIds.length) return out;
    const rows = (await this.db('knowledge_doc_categories as k').join('classifiers as c', 'c.id', 'k.classifier_id').whereIn('k.document_id', docIds.slice(0, 1000).concat([''])).andWhere({ 'k.direct': 1, 'k.origin': 'classifier' }).orderBy('k.path').select('k.document_id', 'k.path', 'c.id', 'c.name', 'c.status')) as { document_id: string; path: string; id: string; name: string; status: string }[];
    for (const r of rows) out.set(r.document_id, [...(out.get(r.document_id) ?? []), { category: r.path, classifierId: r.id, classifier: r.name, provisional: r.status !== 'published' }]);
    return out;
  }

  // ---------- image labels (B-8802, B-8803) ----------

  /** The labels of image documents, by document: hits first, then by score. */
  async labelsOf(docIds: string[]): Promise<Map<string, DocLabel[]>> {
    const out = new Map<string, DocLabel[]>();
    if (!docIds.length) return out;
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < docIds.length; i += 500) rows.push(...((await this.db('knowledge_doc_labels').whereIn('document_id', docIds.slice(i, i + 500))) as Record<string, unknown>[]));
    const known = new Map(((await this.db('classifiers').whereIn('id', [...new Set(rows.map((r) => String(r.classifier_id)))].concat([''])).select('id', 'name', 'status')) as { id: string; name: string; status: string }[]).map((c) => [c.id, c]));
    for (const r of rows) {
      const list = out.get(String(r.document_id)) ?? [];
      list.push({ label: String(r.label), score: Math.round(Number(r.score) * 1000) / 1000, hit: !!r.hit, classifierId: String(r.classifier_id), classifier: known.get(String(r.classifier_id))?.name ?? String(r.classifier_id), version: Number(r.classifier_version), provisional: known.get(String(r.classifier_id))?.status !== 'published' });
      out.set(String(r.document_id), list);
    }
    for (const list of out.values()) list.sort((a, b) => Number(b.hit) - Number(a.hit) || b.score - a.score || a.label.localeCompare(b.label));
    return out;
  }

  /**
   * The image documents of these bases carrying the filter's labels at or above the minimum score (or, without one,
   * at or above each classifier's threshold), among documents at or below `maxRank`.
   */
  async docsWithLabels(kbIds: string[], f: LabelFilter, maxRank: number): Promise<Set<string>> {
    const any = [...new Set(f.any ?? [])];
    const all = [...new Set(f.all ?? [])];
    const q = this.db('knowledge_doc_labels').whereIn('kb_id', kbIds.length ? kbIds : ['']).whereIn('label', [...new Set([...any, ...all])]).andWhere('label_rank', '<=', maxRank);
    if (f.minScore != null) q.andWhere('score', '>=', f.minScore);
    else q.andWhere({ hit: true });
    const rows = (await q.select('document_id', 'label')) as { document_id: string; label: string }[];
    const carried = new Map<string, Set<string>>();
    for (const r of rows) carried.set(r.document_id, (carried.get(r.document_id) ?? new Set()).add(r.label));
    const out = new Set<string>();
    for (const [doc, has] of carried) if ((!any.length || any.some((l) => has.has(l))) && all.every((l) => has.has(l))) out.add(doc);
    return out;
  }

  /** The label names a base's image documents carry (for the filter chips), with how many documents carry each. */
  async labelCounts(p: Principal, kbId: string): Promise<{ label: string; documents: number }[]> {
    const kb = await this.base(p, kbId);
    const rows = (await this.db('knowledge_doc_labels').where({ kb_id: kb.id, hit: true }).andWhere('label_rank', '<=', labelRank(p.clearance)).groupBy('label').select('label').countDistinct({ n: 'document_id' })) as { label: string; n: number | string }[];
    return rows.map((r) => ({ label: r.label, documents: Number(r.n) })).sort((a, b) => b.documents - a.documents || a.label.localeCompare(b.label));
  }

  /** The vision profile's description of an image document, opened. */
  private async describedAs(d: DocRow): Promise<(ImageDescription & { model?: string }) | null> {
    if (!d.vision) return null;
    return json<(ImageDescription & { model?: string }) | null>(await this.d.keys.open(d.tenant_id, d.vision, `kdoc-vision:${d.id}`), null);
  }

  /** An image document's caption, text, labels, safety score, thumbnail and (for a PDF or Word document) its image parts. */
  async imageDetail(p: Principal, doc: DocRow) {
    const parts = ((await this.db('knowledge_documents').where({ parent_id: doc.id }).whereIn('label', labelsUpTo(p.clearance)).orderBy('name')) as Record<string, unknown>[]).map(docFrom);
    const described = doc.media === 'image' ? await this.describedAs(doc) : null;
    const labels = doc.media === 'image' ? ((await this.labelsOf([doc.id])).get(doc.id) ?? []) : [];
    const partLabels = await this.labelsOf(parts.map((x) => x.id));
    return {
      caption: described?.caption ?? null,
      text: described?.text ?? null,
      visionModel: described?.model ?? null,
      labels,
      parts: parts.map((x) => docView(x, undefined, partLabels.get(x.id) ?? []))
    };
  }

  /** B-8803: the picture of an image document the principal may read (its label within their clearance), once checked. */
  async thumbnail(p: Principal, id: string): Promise<{ data: Buffer; type: string }> {
    const { doc } = await this.documentFor(p, id);
    if (!thumbnailUrl(doc) || !doc.blob_key) throw notFound('Thumbnail');
    return { data: await this.content(doc), type: doc.type! };
  }

  /** A document the principal may see (its label at or below their clearance). */
  async documentFor(p: Principal, id: string, need: 'read' | 'manage' = 'read'): Promise<{ doc: DocRow; kb: KbRow }> {
    const doc = await this.document(p.tenantId, id);
    const kb = await this.base(p, doc.kb_id, need);
    if (!clears(p.clearance, doc.label)) throw notFound('Document');
    if (doc.acl && !this.canCurate(p) && !aclAllows(doc.acl, await readerEntries(this.db, p))) throw notFound('Document');
    return { doc, kb };
  }

  /**
   * 2.0.0: a document's stored original (the uploaded or fetched bytes) for a reader, as Files imports it. The reader
   * passes the same checks as for its text (base access, label, row access), the document must be indexed, and no part
   * of it may be labelled above the reader's clearance: the original holds every part, so a document whose text shows
   * a withheld section is refused (its text can still be imported).
   */
  async originalOf(p: Principal, id: string): Promise<{ doc: DocRow; kb: KbRow; data: Buffer }> {
    const { doc, kb } = await this.documentFor(p, id);
    if (doc.state !== 'indexed') throw conflict(`The document is ${doc.state}; only an indexed document's original can be copied.`);
    const above = await this.db('knowledge_chunks').where({ document_id: doc.id }).andWhere('label_rank', '>', labelRank(p.clearance)).first('id');
    if (above) throw forbidden('Part of this document is above your clearance, so its original is not offered; import its text instead.', { step: 'clearance' });
    return { doc, kb, data: await this.content(doc) };
  }

  /**
   * A document's text in order, for the built-in tool `knowledge_read`: the chunks of the serving index the reader is
   * cleared for, from section `from`, until about `maxChars` (always at least one section). Each section passes the
   * `context` checkpoint like a search hit; a withheld one says why and carries no text.
   */
  async readDocument(p: Principal, id: string, opts: { from?: number; maxChars?: number } = {}): Promise<{ doc: DocRow; kb: KbRow; sections: { n: number; heading: string | null; label: Label; text?: string; withheld?: string }[]; total: number; next: number | null }> {
    const { doc, kb } = await this.documentFor(p, id);
    if (doc.state === 'hidden' || doc.state === 'removed') throw notFound('Document');
    const from = Math.max(0, opts.from ?? 0);
    const budget = opts.maxChars ?? 12_000;
    const base = () => this.db('knowledge_chunks').where({ index_id: kb.serving_index_id ?? '', document_id: doc.id }).andWhere('label_rank', '<=', labelRank(p.clearance));
    const total = Number(((await base().count({ n: '*' })) as { n: number }[])[0]?.n ?? 0);
    const rows = (await base().andWhere('seq', '>=', from).orderBy('seq').limit(200).select('id', 'tenant_id', 'seq', 'content', 'label')) as { id: string; tenant_id: string; seq: number; content: string; label: Label }[];
    const sections: { n: number; heading: string | null; label: Label; text?: string; withheld?: string }[] = [];
    let chars = 0;
    let next: number | null = null;
    for (const c of rows) {
      const opened = await this.openChunk(c.tenant_id, c.id, c.content);
      if (sections.length && chars + opened.text.length > budget) {
        next = Number(c.seq);
        break;
      }
      const g = await this.d.guard.check({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, checkpoint: 'context', text: opened.text, label: c.label, principal: p, source: { kind: 'chunk', id: c.id }, meta: { kb: kb.id, document: doc.id } });
      const held = g.action === 'block' || g.action === 'require-approval';
      const text = g.action === 'redact' ? g.text : opened.text;
      sections.push({ n: Number(c.seq), heading: opened.heading, label: c.label, ...(held ? { withheld: g.reason ?? 'Withheld by a guardrail rule.' } : { text }) });
      if (!held) chars += text.length;
    }
    if (next == null && rows.length === 200 && total > from + rows.length) next = Number(rows[rows.length - 1]!.seq) + 1;
    return { doc, kb, sections, total, next };
  }

  /** Whether `knowledge_documents.created_by` exists (migration 144, not registered yet in every build). */
  async hasDocumentCreator(): Promise<boolean> {
    const t = Date.now();
    if (this.docCreator && (this.docCreator.ok || t - this.docCreator.at < 30_000)) return this.docCreator.ok;
    const ok = await this.db.schema.hasColumn('knowledge_documents', 'created_by').catch(() => false);
    this.docCreator = { ok, at: t };
    return ok;
  }

  /** `{ created_by }` for a new document row while the column exists, else nothing. */
  private async creatorColumn(userId: string | null | undefined): Promise<{ created_by?: string | null }> {
    return (await this.hasDocumentCreator()) ? { created_by: userId ?? null } : {};
  }

  /** Uploads go to sealed quarantine; a scan job checks type, malware and classification before indexing. */
  async upload(p: Principal, kbId: string, input: { name: string; label: Label; data: Buffer; categories?: unknown }): Promise<DocRow> {
    const kb = await this.base(p, kbId, 'manage');
    if (kb.review === 'required') throw conflict(`${kb.name} takes changes through review: propose a revision of a reference (Knowledge, References, or the tool knowledge_propose) instead of adding a document.`);
    if (!clears(p.clearance, input.label)) throw forbidden('Above your clearance.', { step: 'clearance' });
    if (input.data.length > this.o.maxBytes) throw new HttpProblem(413, 'Payload too large', 'The file is larger than the upload limit.');
    let categories: string[];
    try {
      categories = categoryPaths(input.categories);
    } catch (err) {
      if (err instanceof CategoryError) throw badRequest(err.message);
      throw err;
    }
    let source = (await this.sources(kb.id)).find((s) => s.kind === 'upload');
    if (!source) source = await this.addSource(p, kb.id, { kind: 'upload', location: 'Uploads' });
    const t = Date.now();
    const id = ulid();
    const blobKey = await this.store({ id, tenant_id: p.tenantId }, input.data, 'knowledge-quarantine');
    const label = highest(source.label_floor, input.label);
    // Each upload is its own document, even with a name seen before.
    await this.db('knowledge_documents').insert({ id, tenant_id: p.tenantId, kb_id: kb.id, source_id: source.id, external_key: sha(`upload:${id}`), name: input.name.slice(0, 300), type: null, size: input.data.length, sha256: sha(input.data), version: null, label, auto_label: null, manual_label: labelRank(input.label) > labelRank(source.label_floor) ? input.label : null, label_origin: 'pending', detections: null, state: 'quarantined', blob_key: blobKey, chunks: 0, created_at: t, updated_at: t, ...(await this.creatorColumn(p.userId)) });
    if (categories.length) await this.writeCategories({ id, tenant_id: p.tenantId, kb_id: kb.id }, categories, [], p.userId);
    await this.d.jobs.enqueue({ tenantId: p.tenantId, type: 'knowledge.scan', payload: { documentId: id }, createdBy: p.userId, maxAttempts: 2 });
    return this.document(p.tenantId, id);
  }

  /**
   * Migration 045: the document of an approved revision (`knowledge/revisions.ts`). The approval is the right to add
   * it, so there is no manage check; it goes through quarantine, the scan and classification like any upload.
   */
  async publishControlled(kb: Pick<KbRow, 'id' | 'tenant_id'>, by: string | null, input: { name: string; label: Label; data: Buffer; categories: string[]; version: string }): Promise<DocRow> {
    if (input.data.length > this.o.maxBytes) throw new HttpProblem(413, 'Payload too large', 'The revision is larger than the upload limit.');
    let source = (await this.sources(kb.id)).find((s) => s.kind === 'upload');
    const t = Date.now();
    if (!source) {
      const sid = ulid();
      await this.db('knowledge_sources').insert({ id: sid, tenant_id: kb.tenant_id, kb_id: kb.id, kind: 'upload', location: 'Uploads', config: JSON.stringify({}), secret_sealed: null, label_floor: 'public', schedule: 'manual', state: 'idle', created_by: by, created_at: t, updated_at: t });
      source = await this.source(kb.tenant_id, sid);
    }
    const id = ulid();
    const blobKey = await this.store({ id, tenant_id: kb.tenant_id }, input.data, 'knowledge-quarantine');
    const label = highest(source.label_floor, input.label);
    await this.db('knowledge_documents').insert({ id, tenant_id: kb.tenant_id, kb_id: kb.id, source_id: source.id, external_key: sha(`upload:${id}`), name: input.name.slice(0, 300), type: null, size: input.data.length, sha256: sha(input.data), version: input.version, label, auto_label: null, manual_label: labelRank(input.label) > labelRank(source.label_floor) ? input.label : null, label_origin: 'pending', detections: null, state: 'quarantined', blob_key: blobKey, chunks: 0, created_at: t, updated_at: t, ...(await this.creatorColumn(by)) });
    if (input.categories.length) await this.writeCategories({ id, tenant_id: kb.tenant_id, kb_id: kb.id }, input.categories, [], by);
    await this.d.jobs.enqueue({ tenantId: kb.tenant_id, type: 'knowledge.scan', payload: { documentId: id }, createdBy: by, maxAttempts: 2 });
    return this.document(kb.tenant_id, id);
  }

  /** Migration 045: removes the document of a superseded, failed or retired revision from every index. */
  async discard(tenantId: string, documentId: string): Promise<void> {
    const r = await this.db('knowledge_documents').where({ tenant_id: tenantId, id: documentId }).first();
    if (r) await this.purgeDocument(docFrom(r));
  }

  private async tellSettled(documentId: string): Promise<void> {
    if (!this.settled.length) return;
    const r = await this.db('knowledge_documents').where({ id: documentId }).first();
    if (!r) return;
    for (const fn of this.settled) await fn(docFrom(r)).catch((err: unknown) => this.d.log.warn({ document: documentId, err: (err as Error).message }, 'a listener of a settled knowledge document failed'));
  }

  /** Relabels a document: never below the classifier's finding or the source's floor, never above the curator. */
  async relabel(p: Principal, id: string, label: Label): Promise<DocRow> {
    const { doc } = await this.documentFor(p, id, 'manage');
    if (!clears(p.clearance, label)) throw forbidden(`Your clearance is ${p.clearance}.`, { step: 'clearance' });
    const src = await this.source(p.tenantId, doc.source_id);
    const kb = await this.kbRow(doc.kb_id);
    const parentLabel: Label = doc.parent_id ? ((((await this.db('knowledge_documents').where({ id: doc.parent_id }).first('label')) as { label?: Label } | undefined)?.label) ?? 'public') : 'public';
    const floor = highest(kb.label, src.label_floor, doc.auto_label ?? 'public', parentLabel);
    if (labelRank(label) < labelRank(floor)) {
      const found = findingsFor(doc.detections, doc.auto_label ?? 'public').join(', ');
      if (doc.auto_label && labelRank(label) < labelRank(doc.auto_label)) throw conflict(`The auto-classifier found ${found || 'personal data'}, so the label cannot go below ${doc.auto_label}.`);
      if (labelRank(label) < labelRank(parentLabel)) throw conflict(`This image is part of a ${parentLabel} document, so its label cannot go below ${parentLabel}.`);
      throw conflict(`The label cannot go below the floor of ${highest(kb.label, src.label_floor)}.`);
    }
    await this.db('knowledge_documents').where({ id: doc.id }).update({ manual_label: label });
    await this.applyLabel({ ...doc, manual_label: label }, highest(floor, label), 'manual');
    return this.document(p.tenantId, id);
  }

  /** Writes a new effective label to a document and every chunk of it, at once, and refreshes its vectors. */
  private async applyLabel(doc: DocRow, label: Label, origin: string): Promise<void> {
    await this.db('knowledge_documents').where({ id: doc.id }).update({ label, label_origin: origin, updated_at: Date.now() });
    const rank = labelRank(label);
    // An image's labels are metadata at the image's own label (B-8805).
    await this.db('knowledge_doc_labels').where({ document_id: doc.id }).update({ label_rank: rank });
    const chunks = (await this.db('knowledge_chunks').where({ document_id: doc.id }).select('id', 'index_id')) as { id: string; index_id: string }[];
    await this.db('knowledge_chunks').where({ document_id: doc.id }).update({ label, label_rank: rank });
    for (let i = 0; i < chunks.length; i += 500) await this.db('knowledge_terms').whereIn('chunk_id', chunks.slice(i, i + 500).map((c) => c.id)).update({ label_rank: rank });
    // Vectors carry the rank too: rewrite them from the embedding cache.
    if (chunks.length) await this.d.jobs.enqueue({ tenantId: doc.tenant_id, type: 'knowledge.index', payload: { documentId: doc.id }, maxAttempts: 3 });
    // A document's image parts are never below it (Sprint 36c).
    for (const part of ((await this.db('knowledge_documents').where({ parent_id: doc.id })) as Record<string, unknown>[]).map(docFrom)) {
      if (labelRank(part.label) < rank) await this.applyLabel(part, label, 'inherited from the document');
    }
  }

  async reindexDocument(p: Principal, id: string): Promise<{ jobId: string }> {
    const { doc } = await this.documentFor(p, id, 'manage');
    if (['quarantined', 'scanning', 'rejected', 'removed', 'hidden'].includes(doc.state)) throw conflict(`${doc.name} is ${doc.state} and cannot be indexed.`);
    await this.db('knowledge_documents').where({ id: doc.id }).update({ state: 'queued', error: null, trace_id: null, updated_at: Date.now() });
    const job = await this.d.jobs.enqueue({ tenantId: doc.tenant_id, type: 'knowledge.index', payload: { documentId: doc.id }, createdBy: p.userId, maxAttempts: 1 });
    return { jobId: job.id };
  }

  /**
   * Removes a document from every index and deletes its content. A synced document is kept as `removed` so the
   * next sync does not bring it back; an upload is deleted.
   */
  async removeDocument(p: Principal, id: string): Promise<DocRow> {
    const { doc } = await this.documentFor(p, id, 'manage');
    const src = await this.source(p.tenantId, doc.source_id);
    await this.purgeDocument(doc, src.kind !== 'upload');
    return doc;
  }

  private async purgeDocument(doc: DocRow, keepTombstone = false): Promise<void> {
    // A document's image parts go with it.
    for (const part of ((await this.db('knowledge_documents').where({ parent_id: doc.id })) as Record<string, unknown>[]).map(docFrom)) await this.purgeDocument(part);
    for (const idx of await this.indexes(doc.kb_id)) await this.removeFromIndex(idx.id, doc.id);
    await this.db('knowledge_doc_labels').where({ document_id: doc.id }).delete();
    await this.db('knowledge_doc_categories').where({ document_id: doc.id }).delete();
    if (doc.blob_key) await this.d.blobs.delete(doc.blob_key);
    if (keepTombstone) await this.db('knowledge_documents').where({ id: doc.id }).update({ state: 'removed', blob_key: null, chunks: 0, vision: null, updated_at: Date.now() });
    else await this.db('knowledge_documents').where({ id: doc.id }).delete();
  }

  private async removeFromIndex(indexId: string, documentId: string): Promise<void> {
    const ids = ((await this.db('knowledge_chunks').where({ index_id: indexId, document_id: documentId }).select('id')) as { id: string }[]).map((r) => r.id);
    if (!ids.length) return;
    for (let i = 0; i < ids.length; i += 500) await this.db('knowledge_terms').where({ index_id: indexId }).whereIn('chunk_id', ids.slice(i, i + 500)).delete();
    await this.d.vectors.delete(indexId, ids);
    await this.db('knowledge_chunks').where({ index_id: indexId, document_id: documentId }).delete();
  }

  // ---------- index builds ----------

  /** Builds a new index version beside the serving one (optionally with another embedding model). */
  async reindex(p: Principal, kbId: string, input: { embedModel?: string }): Promise<IndexRow> {
    const kb = await this.base(p, kbId, 'manage');
    const building = (await this.indexes(kb.id)).find((i) => i.state === 'building');
    if (building) throw conflict(`Index v${building.version} is already building.`);
    const model = input.embedModel ?? kb.embed_model;
    await this.checkEmbedModel(model, kb.label);
    const version = ((await this.db('knowledge_indexes').where({ kb_id: kb.id }).max({ v: 'version' })) as { v: number }[])[0]?.v ?? 0;
    const id = ulid();
    await this.db('knowledge_indexes').insert({ id, tenant_id: kb.tenant_id, kb_id: kb.id, version: Number(version) + 1, embed_model: model, dims: null, state: 'building', progress: 0, chunks: 0, created_by: p.userId, created_at: Date.now() });
    const job = await this.d.jobs.enqueue({ tenantId: kb.tenant_id, type: 'knowledge.reindex', payload: { indexId: id }, createdBy: p.userId, maxAttempts: 2 });
    await this.db('knowledge_indexes').where({ id }).update({ job_id: job.id });
    return (await this.indexRow(id))!;
  }

  async cancelBuild(p: Principal, kbId: string): Promise<IndexRow> {
    const kb = await this.base(p, kbId, 'manage');
    const building = (await this.indexes(kb.id)).find((i) => i.state === 'building');
    if (!building) throw conflict('No index is building.');
    await this.db('knowledge_indexes').where({ id: building.id }).update({ state: 'cancelled', message: 'Cancelled; the partial index was discarded' });
    if (building.job_id) await this.d.jobs.cancel(kb.tenant_id, building.job_id);
    await this.dropIndex(building.id);
    return (await this.indexRow(building.id))!;
  }

  private async dropIndex(indexId: string): Promise<void> {
    await this.d.vectors.drop(indexId);
    await this.db('knowledge_terms').where({ index_id: indexId }).delete();
    await this.db('knowledge_chunks').where({ index_id: indexId }).delete();
    await this.db('knowledge_indexes').where({ id: indexId }).update({ chunks: 0 });
  }

  private async reindexJob(indexId: string, ctx: JobContext): Promise<unknown> {
    const idx = await this.indexRow(indexId);
    if (!idx || idx.state !== 'building') return { skipped: `index is ${idx?.state ?? 'gone'}` };
    const docs = ((await this.db('knowledge_documents').where({ kb_id: idx.kb_id }).whereIn('state', ['indexed', 'unchanged', 'queued', 'indexing'])) as Record<string, unknown>[]).map(docFrom);
    let done = 0;
    let failed = 0;
    for (const d of docs) {
      if (ctx.signal.aborted) throw ctx.signal.reason as Error;
      const cur = await this.indexRow(indexId);
      if (cur?.state !== 'building') return { stopped: cur?.state };
      // Documents synced during the build were written to this index already.
      const has = await this.db('knowledge_chunks').where({ index_id: indexId, document_id: d.id }).first('id');
      if (!has) {
        try {
          await this.indexInto(d, [idx]);
        } catch (err) {
          failed++;
          ctx.log.warn({ err: (err as Error).message, document: d.id }, 'reindex of a document failed');
        }
      }
      done++;
      const chunks = await this.countChunks(indexId);
      await this.db('knowledge_indexes').where({ id: indexId }).update({ progress: Math.floor((done / Math.max(1, docs.length)) * 99), chunks, message: `Embedded ${done} of ${docs.length} documents` });
      await ctx.progress((done / Math.max(1, docs.length)) * 99, `Embedded ${done} of ${docs.length} documents`);
    }
    // The switch: one transaction moves serving to the new index and retires the old one.
    const old = (await this.indexes(idx.kb_id)).find((i) => i.state === 'serving');
    const chunks = await this.countChunks(indexId);
    const switched = await this.db.transaction(async (trx) => {
      const n = await trx('knowledge_indexes').where({ id: indexId, state: 'building' }).update({ state: 'serving', progress: 100, built_at: Date.now(), message: failed ? `${failed} documents failed; retry them from the Documents tab` : null, chunks });
      if (!n) return false;
      if (old) await trx('knowledge_indexes').where({ id: old.id }).update({ state: 'retired' });
      await trx('knowledge_bases').where({ id: idx.kb_id }).update({ serving_index_id: indexId, embed_model: idx.embed_model, updated_at: Date.now() });
      return true;
    });
    if (!switched) return { stopped: 'cancelled' };
    if (old) await this.dropIndex(old.id);
    return { version: idx.version, documents: docs.length, failed, retired: old?.version ?? null };
  }

  private async countChunks(indexId: string): Promise<number> {
    return Number(((await this.db('knowledge_chunks').where({ index_id: indexId }).count({ n: '*' })) as { n: number }[])[0]?.n ?? 0);
  }

  // ---------- scanning and indexing ----------

  /** `by`: who queued the scan (an upload), carried to the index job so its embeddings are metered for them. */
  private async scanJob(documentId: string, by: string | null = null): Promise<unknown> {
    const r = await this.db('knowledge_documents').where({ id: documentId }).first();
    if (!r) return { skipped: 'gone' };
    const doc = docFrom(r);
    if (doc.state !== 'quarantined' && doc.state !== 'scanning') return { skipped: doc.state };
    await this.db('knowledge_documents').where({ id: doc.id }).update({ state: 'scanning' });
    const reject = async (reason: string) => {
      if (doc.blob_key) await this.d.blobs.delete(doc.blob_key);
      await this.db('knowledge_documents').where({ id: doc.id }).update({ state: 'rejected', error: reason.slice(0, 500), trace_id: traceId(), blob_key: null, label_origin: 'rejected', updated_at: Date.now() });
      await this.tellSettled(doc.id);
      return { state: 'rejected', reason };
    };
    const data = await this.content(doc);
    const type = detectType(data, doc.name);
    if ('rejected' in type) return reject(type.rejected);
    if (this.o.clamd) {
      const found = await clamScan(this.o.clamd.host, this.o.clamd.port, data);
      if (found) return reject(`Malware detected: ${found}`);
    }
    const key = await this.store(doc, data);
    if (doc.blob_key) await this.d.blobs.delete(doc.blob_key);
    await this.db('knowledge_documents').where({ id: doc.id }).update({ type: type.type, blob_key: key, state: 'queued', updated_at: Date.now() });
    await this.d.jobs.enqueue({ tenantId: doc.tenant_id, type: 'knowledge.index', payload: { documentId: doc.id }, ...(by ? { createdBy: by } : {}), maxAttempts: 2 });
    return { state: 'queued', type: type.type };
  }

  private async indexJob(documentId: string, ctx: JobContext): Promise<unknown> {
    const r = await this.db('knowledge_documents').where({ id: documentId }).first();
    if (!r) return { skipped: 'gone' };
    const doc = docFrom(r);
    if (['quarantined', 'scanning', 'rejected', 'removed', 'hidden'].includes(doc.state)) return { skipped: doc.state };
    const targets = await this.liveIndexes(doc.kb_id);
    await ctx.progress(10, `Extracting ${doc.name}`);
    let out: Awaited<ReturnType<KnowledgeService['indexInto']>>;
    try {
      out = await this.indexInto(doc, targets, ctx.job.created_by ?? undefined);
    } catch (err) {
      // An upload the pools may not embed at its label ends rejected with the reason, not stuck in "indexing".
      if (!(await this.setAside(doc, err))) throw err;
      out = { state: 'rejected', chunks: 0, error: (err as Error).message };
    }
    await this.tellSettled(doc.id);
    return out;
  }

  /**
   * No pool may run the embedding model on data of this document's label (the classifier raised it: a public page
   * with an email address, for example). Retrying cannot help, so the document is set aside: out of every index,
   * `rejected`, with the reason. False for any other error, which the caller lets fail and retry.
   */
  private async setAside(doc: Pick<DocRow, 'id' | 'kb_id'>, err: unknown): Promise<boolean> {
    if (!(err instanceof HttpProblem) || err.extensions?.step !== 'zone') return false;
    for (const idx of await this.liveIndexes(doc.kb_id)) await this.removeFromIndex(idx.id, doc.id);
    await this.db('knowledge_documents').where({ id: doc.id }).update({ state: 'rejected', error: `Not indexed: ${err.detail ?? err.title}`.slice(0, 500), trace_id: traceId(), chunks: 0, updated_at: Date.now() });
    return true;
  }

  /**
   * Extracts, classifies, chunks and embeds one document into the given indexes. Extraction problems leave the
   * document `failed` with the reason and a trace id, out of retrieval; other errors propagate so the job retries.
   * The model calls are metered in the base's workspace (else the tenant's default) for `by` (whoever queued this
   * index), else the document's `created_by` (who uploaded or added it, migration 144), else whoever added its source:
   * a background reindex or refresh credits the uploader, not the source's creator.
   */
  async indexInto(doc: DocRow, targets: IndexRow[], by?: string | null): Promise<{ state: DocState; chunks: number; label?: Label; error?: string }> {
    const kb = await this.kbRow(doc.kb_id);
    const src = await this.source(doc.tenant_id, doc.source_id);
    const meter: Meter = { workspaceId: kb.workspace_id, userId: by ?? doc.created_by ?? src.created_by ?? null };
    await this.db('knowledge_documents').where({ id: doc.id }).update({ state: 'indexing', updated_at: Date.now() });
    // An image taken out of a document is at least that document's label.
    const parentLabel: Label = doc.parent_id ? ((((await this.db('knowledge_documents').where({ id: doc.parent_id }).first('label')) as { label?: Label } | undefined)?.label) ?? 'public') : 'public';
    const before = highest(kb.label, src.label_floor, parentLabel, doc.manual_label ?? 'public');
    let text: string;
    let type = doc.type;
    let described: (ImageDescription & { model: string }) | null = null;
    let safetyScore: number | null = null;
    let parts: ReturnType<typeof imageParts> = [];
    try {
      const data = await this.content(doc);
      if (!type) {
        const t = detectType(data, doc.name);
        if ('rejected' in t) throw new ExtractionError(t.rejected);
        type = t.type;
      }
      if (isImageType(type)) {
        // B-8801: the image safety check, then the vision profile's caption and text become the indexed text.
        const checked = await this.checkImage(doc, data, type, before, targets);
        if ('rejected' in checked) return checked.rejected;
        safetyScore = checked.score;
        described = await this.describe(doc, kb, data, before, meter);
        text = indexedText(doc.name, described);
      } else {
        // A PDF or Word document's images become its parts when the base has a vision profile.
        if (kb.vision_profile && !doc.parent_id && (type === 'application/pdf' || type === DOCX_TYPE)) parts = imageParts(data, type);
        try {
          text = extractText(data, type);
        } catch (err) {
          // A scan has no text layer, but its pages are images the vision profile reads.
          if (!(err instanceof ExtractionError) || !parts.length) throw err;
          text = '';
        }
      }
    } catch (err) {
      if (!(err instanceof ExtractionError)) throw err;
      for (const idx of targets) await this.removeFromIndex(idx.id, doc.id);
      await this.db('knowledge_documents').where({ id: doc.id }).update({ state: 'failed', type, ...(isImageType(type) ? { media: 'image' } : {}), error: err.message.slice(0, 500), trace_id: traceId(), chunks: 0, updated_at: Date.now() });
      return { state: 'failed', chunks: 0, error: err.message };
    }
    const c = classify(text);
    const auto: Label = c.label;
    const label = highest(before, auto);
    const origin = doc.manual_label && labelRank(doc.manual_label) >= labelRank(label) ? 'manual' : labelRank(auto) >= labelRank(label) && auto !== 'public' ? `auto-classifier, ${findingsFor(c.detections, auto).join(', ')}` : 'inherited';
    if (kb.workspace_id) {
      const ws = (await this.db('workspaces').where({ id: kb.workspace_id }).first('label_ceiling')) as { label_ceiling: Label } | undefined;
      if (ws && labelRank(label) > labelRank(ws.label_ceiling)) {
        for (const idx of targets) await this.removeFromIndex(idx.id, doc.id);
        await this.db('knowledge_documents').where({ id: doc.id }).update({ state: 'rejected', label, auto_label: auto, detections: JSON.stringify(c.detections), error: `Classified ${label}, above the workspace ceiling of ${ws.label_ceiling}.`, trace_id: traceId(), chunks: 0, updated_at: Date.now() });
        return { state: 'rejected', chunks: 0, label };
      }
    }
    const chunks = text ? chunkText(text, kb.chunking) : [];
    for (const idx of targets) await this.writeChunks(idx, doc, chunks, label, meter);
    const vision = described ? await this.d.keys.seal(doc.tenant_id, JSON.stringify(described), `kdoc-vision:${doc.id}`) : null;
    await this.db('knowledge_documents').where({ id: doc.id }).update({ state: 'indexed', type, label, auto_label: auto, label_origin: origin, detections: JSON.stringify(c.detections), error: null, trace_id: null, chunks: chunks.length, indexed_at: Date.now(), updated_at: Date.now(), ...(described ? { media: 'image', vision, safety_score: safetyScore } : {}) });
    await this.db('knowledge_doc_labels').where({ document_id: doc.id }).update({ label_rank: labelRank(label) });
    // B-8802: the base's vision classifiers label the image in the background.
    if (described && kb.image_classifiers.length) await this.d.jobs.enqueue({ tenantId: doc.tenant_id, type: 'knowledge.classify', payload: { documentId: doc.id }, ...(meter.userId ? { createdBy: meter.userId } : {}), maxAttempts: 2 });
    if (!doc.parent_id && (type === 'application/pdf' || type === DOCX_TYPE)) await this.syncParts(doc, kb.vision_profile ? parts : [], label);
    return { state: 'indexed', chunks: chunks.length, label };
  }

  /**
   * B-8801: the image safety check on an image document before anything else reads it. A flagged image (or, with
   * IMAGE_SAFETY_REQUIRED, one no classifier looked at) is rejected: its content is deleted and it never reaches an
   * index. The check failing to run fails the document, which a retry runs again.
   */
  private async checkImage(doc: DocRow, data: Buffer, type: string, label: Label, targets: IndexRow[]): Promise<{ score: number | null } | { rejected: { state: DocState; chunks: number; label: Label; error: string } }> {
    const safety = this.d.safety?.();
    let verdict;
    try {
      verdict = safety ? await safety.classify(data, type) : null;
    } catch (err) {
      throw new ExtractionError(`The image safety check could not run: ${(err as Error).message}`);
    }
    const flagged = verdict && verdict.score >= (this.d.safetyThreshold ?? 0.5);
    const unchecked = !verdict && !!this.d.safetyRequired;
    if (!flagged && !unchecked) return { score: verdict ? verdict.score : null };
    const reason = flagged ? `Withheld by the image safety check (${verdict!.classifier} scored ${verdict!.score.toFixed(2)}).` : 'Withheld: no image safety classifier is configured, and this server requires one.';
    for (const idx of targets) await this.removeFromIndex(idx.id, doc.id);
    await this.db('knowledge_doc_labels').where({ document_id: doc.id }).delete();
    await this.syncLabelCategories(doc);
    if (doc.blob_key) await this.d.blobs.delete(doc.blob_key);
    await this.db('knowledge_documents').where({ id: doc.id }).update({ state: 'rejected', type, media: 'image', error: reason, trace_id: traceId(), blob_key: null, vision: null, chunks: 0, safety_score: verdict?.score ?? null, label_origin: 'rejected', updated_at: Date.now() });
    await this.d.audit.append({ tenantId: doc.tenant_id, action: 'knowledge.image.withheld', kind: 'system', actor: { service: 'knowledge' }, target: { kb: doc.kb_id, document: doc.id }, label, detail: verdict ? { score: verdict.score, classifier: verdict.classifier, categories: verdict.categories } : { reason: 'not classified', required: true } });
    return { rejected: { state: 'rejected', chunks: 0, label, error: reason } };
  }

  /** B-8801: the vision profile's caption and the text it reads in the image, validated, metered as indexing. */
  private async describe(doc: DocRow, kb: KbRow, data: Buffer, label: Label, meter: Meter): Promise<ImageDescription & { model: string }> {
    if (!kb.vision_profile) throw new ExtractionError('This knowledge base has no vision profile, so its images cannot be described. Name one in the knowledge base settings, then retry.');
    let out;
    try {
      out = await complete(this.d.gateway, doc.tenant_id, kb.vision_profile, label, [{ role: 'system', content: DESCRIBE_PROMPT }, { role: 'user', content: 'Describe this image and read its text.', images: [data.toString('base64')] }], VISION_TIMEOUT_MS, 'vision');
    } catch (err) {
      throw new ExtractionError(`The vision profile ${kb.vision_profile} could not describe the image: ${err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message}`);
    }
    await this.d.quotas.record({ tenantId: doc.tenant_id, workspaceId: await usageWorkspace(this.db, doc.tenant_id, meter.workspaceId), userId: meter.userId, kind: 'embed', model: out.model, profileId: out.profileId, poolId: out.poolId, promptTokens: out.promptTokens, outputTokens: out.outputTokens });
    try {
      return { ...parseDescription(out.text), model: out.model };
    } catch (err) {
      throw new ExtractionError((err as Error).message);
    }
  }

  /**
   * B-8801: a PDF or Word document's images as its parts: each is a document of its own (a child of this one, from
   * the same source, at least its label), through quarantine and the safety check like an upload. An unchanged
   * image keeps its document; images no longer in the document are removed.
   */
  private async syncParts(doc: DocRow, parts: ReturnType<typeof imageParts>, label: Label): Promise<void> {
    const existing = new Map(((await this.db('knowledge_documents').where({ parent_id: doc.id })) as Record<string, unknown>[]).map(docFrom).map((d) => [d.external_key, d]));
    const keep = new Set<string>();
    const t = Date.now();
    for (const [i, part] of parts.entries()) {
      const key = sha(`${doc.id}#image-${i + 1}`);
      const hash = sha(part.data);
      keep.add(key);
      const prev = existing.get(key);
      if (prev && prev.sha256 === hash && prev.state !== 'failed' && prev.state !== 'rejected') {
        if (labelRank(prev.label) < labelRank(label)) await this.applyLabel(prev, label, 'inherited from the document');
        continue;
      }
      if (prev) await this.purgeDocument(prev);
      const id = ulid();
      const blobKey = await this.store({ id, tenant_id: doc.tenant_id }, part.data, 'knowledge-quarantine');
      await this.db('knowledge_documents').insert({ id, tenant_id: doc.tenant_id, kb_id: doc.kb_id, source_id: doc.source_id, external_key: key, name: `${doc.name}, image ${i + 1}`.slice(0, 300), type: null, size: part.data.length, sha256: hash, version: null, label, auto_label: null, manual_label: null, label_origin: 'inherited from the document', detections: null, state: 'quarantined', blob_key: blobKey, chunks: 0, created_at: t, updated_at: t, acl: doc.acl == null ? null : JSON.stringify(doc.acl), parent_id: doc.id, media: 'image', ...(await this.creatorColumn(doc.created_by ?? null)) });
      await this.d.jobs.enqueue({ tenantId: doc.tenant_id, type: 'knowledge.scan', payload: { documentId: id }, maxAttempts: 2 });
    }
    for (const [key, d] of existing) if (!keep.has(key)) await this.purgeDocument(d);
  }

  // ---------- image classification (B-8802) ----------

  /** The vision classifiers a base names (optionally only one of them): published ones, and drafts provisionally. */
  private async imageClassifiers(kb: KbRow, only: string | null): Promise<ClassifierRow[]> {
    const out: ClassifierRow[] = [];
    if (!this.d.classifiers) return out;
    for (const id of kb.image_classifiers) {
      if (only && id !== only) continue;
      const c = await this.d.classifiers.get(kb.tenant_id, id);
      if (c && c.engine === 'vision') out.push(c);
    }
    return out;
  }

  /**
   * Scores one image document with the base's vision classifiers and stores the labels as tags on it, with their
   * scores and the classifier's version. Without `force`, a classifier whose current version already labelled the
   * document is skipped (a reclassify after a new version touches only what is stale).
   */
  private async classifyDocument(doc: DocRow, kb: KbRow, only: string | null, force: boolean, userId: string | null = null): Promise<number> {
    const list = await this.imageClassifiers(kb, only);
    if (!list.length) return 0;
    let data: Buffer | null = null;
    let n = 0;
    for (const c of list) {
      const have = (await this.db('knowledge_doc_labels').where({ document_id: doc.id, classifier_id: c.id }).first('classifier_version')) as { classifier_version?: number } | undefined;
      if (have && Number(have.classifier_version) === c.version && !force) continue;
      data ??= await this.content(doc);
      const r = await this.d.classifiers!.scoreImage(doc.tenant_id, c, data, doc.label, VISION_TIMEOUT_MS);
      if (r.usage) await this.d.quotas.record({ tenantId: doc.tenant_id, workspaceId: await usageWorkspace(this.db, doc.tenant_id, kb.workspace_id), userId, kind: 'embed', model: r.usage.model, profileId: r.usage.profileId, poolId: r.usage.poolId, promptTokens: r.usage.promptTokens, outputTokens: r.usage.outputTokens });
      const t = Date.now();
      const rank = labelRank(doc.label);
      await this.db.transaction(async (trx) => {
        await trx('knowledge_doc_labels').where({ document_id: doc.id, classifier_id: c.id }).delete();
        await trx('knowledge_doc_labels').insert(c.config.labels.map((l) => ({ id: ulid(), tenant_id: doc.tenant_id, kb_id: doc.kb_id, document_id: doc.id, classifier_id: c.id, classifier_version: c.version, label: l.label, score: r.scores[l.label] ?? 0, hit: r.hits.includes(l.label), label_rank: rank, created_at: t })));
      });
      n++;
    }
    if (n) await this.syncLabelCategories(doc);
    return n;
  }

  /** `by`: who added the image or asked for the classification (null for a background relabel). */
  private async classifyJob(documentId: string, only: string | null, by: string | null = null): Promise<unknown> {
    const r = await this.db('knowledge_documents').where({ id: documentId }).first();
    if (!r) return { skipped: 'gone' };
    const doc = docFrom(r);
    if (doc.media !== 'image' || !['indexed', 'unchanged'].includes(doc.state)) return { skipped: doc.state };
    return { classified: await this.classifyDocument(doc, await this.kbRow(doc.kb_id), only, true, by) };
  }

  /** Labels a base's images again: after a new classifier version (stale ones only), or on request (all). */
  private async reclassifyJob(kbId: string, only: string | null, ctx: JobContext): Promise<unknown> {
    const kbRaw = await this.db('knowledge_bases').where({ id: kbId }).first();
    if (!kbRaw) return { skipped: 'gone' };
    const kb = kbFrom(kbRaw);
    const force = !!ctx.job.payload?.force;
    const docs = ((await this.db('knowledge_documents').where({ kb_id: kb.id, media: 'image' }).whereIn('state', ['indexed', 'unchanged']).orderBy('id')) as Record<string, unknown>[]).map(docFrom);
    let classified = 0;
    let failed = 0;
    for (const [i, d] of docs.entries()) {
      if (ctx.signal.aborted) throw ctx.signal.reason as Error;
      try {
        if (await this.classifyDocument(d, kb, only, force, ctx.job.created_by ?? null)) classified++;
      } catch (err) {
        failed++;
        ctx.log.warn({ err: (err as Error).message, document: d.id }, 'classifying an image failed');
      }
      await ctx.progress(((i + 1) / docs.length) * 100, `Classified ${i + 1} of ${docs.length} images`);
    }
    await this.d.audit.append({ tenantId: kb.tenant_id, action: 'knowledge.reclassified', kind: 'system', actor: { service: 'knowledge' }, target: { kb: kb.id, ...(only ? { classifier: only } : {}) }, label: kb.label, detail: { images: docs.length, classified, failed, force } });
    return { images: docs.length, classified, failed };
  }

  /** B-8802: a classifier has a new version (or was published): every base naming it labels its images again. */
  async classifierVersioned(c: ClassifierRow): Promise<number> {
    if (c.engine !== 'vision') return 0;
    const q = this.db('knowledge_bases').where('image_classifiers', 'like', `%${c.id}%`);
    if (c.tenant_id) q.andWhere({ tenant_id: c.tenant_id });
    const kbs = ((await q) as Record<string, unknown>[]).map(kbFrom).filter((k) => k.image_classifiers.includes(c.id));
    for (const kb of kbs) await this.d.jobs.enqueue({ tenantId: kb.tenant_id, type: 'knowledge.reclassify', payload: { kbId: kb.id, classifierId: c.id }, maxAttempts: 2 });
    return kbs.length;
  }

  /** Re-classifies a base's images (or one image) now, with every classifier it names. */
  async reclassify(p: Principal, kbId: string, documentId?: string): Promise<{ jobId: string; images: number }> {
    const kb = await this.base(p, kbId, 'manage');
    if (!kb.image_classifiers.length) throw conflict(`${kb.name} names no image classifier. Pick one in its settings first.`);
    if (documentId) {
      const { doc } = await this.documentFor(p, documentId, 'manage');
      if (doc.kb_id !== kb.id) throw notFound('Document');
      if (doc.media !== 'image' || !['indexed', 'unchanged'].includes(doc.state)) throw conflict(`${doc.name} is not an indexed image.`);
      const job = await this.d.jobs.enqueue({ tenantId: kb.tenant_id, type: 'knowledge.classify', payload: { documentId: doc.id }, createdBy: p.userId, maxAttempts: 1 });
      return { jobId: job.id, images: 1 };
    }
    const images = Number(((await this.db('knowledge_documents').where({ kb_id: kb.id, media: 'image' }).whereIn('state', ['indexed', 'unchanged']).count({ n: '*' })) as { n: number }[])[0]?.n ?? 0);
    const job = await this.d.jobs.enqueue({ tenantId: kb.tenant_id, type: 'knowledge.reclassify', payload: { kbId: kb.id, force: true }, createdBy: p.userId, maxAttempts: 1 });
    return { jobId: job.id, images };
  }

  private async writeChunks(idx: IndexRow, doc: DocRow, chunks: TextChunk[], label: Label, meter: Meter): Promise<void> {
    await this.removeFromIndex(idx.id, doc.id);
    if (!chunks.length) return;
    const vectors = await this.embed(doc.tenant_id, idx.embed_model, chunks.map((c) => (c.heading ? `${c.heading}\n\n${c.text}` : c.text)), label, meter.userId, { workspaceId: meter.workspaceId });
    const dims = vectors[0]!.length;
    if (idx.dims == null) {
      await this.db('knowledge_indexes').where({ id: idx.id }).whereNull('dims').update({ dims });
      idx.dims = dims;
    } else if (idx.dims !== dims) throw new Error(`${idx.embed_model} returned ${dims} dimensions; index v${idx.version} has ${idx.dims}.`);
    const rank = labelRank(label);
    const t = Date.now();
    const rows = [];
    const terms = [];
    const records = [];
    for (const [i, c] of chunks.entries()) {
      const id = ulid();
      rows.push({ id, tenant_id: doc.tenant_id, kb_id: doc.kb_id, index_id: idx.id, document_id: doc.id, seq: i, content: await this.sealChunk(doc.tenant_id, id, { text: c.text, heading: c.heading }), label, label_rank: rank, tokens: 0, created_at: t, acl: doc.acl == null ? null : JSON.stringify(doc.acl) });
      const { counts, length } = termCounts(`${c.heading ?? ''} ${c.text}`);
      rows[rows.length - 1]!.tokens = length;
      const hashed = await this.terms.terms(doc.tenant_id, [...counts.keys()]);
      for (const [w, tf] of counts) terms.push({ tenant_id: doc.tenant_id, index_id: idx.id, chunk_id: id, term: hashed.get(w)!, tf, label_rank: rank });
      records.push({ id, tenantId: doc.tenant_id, partition: doc.kb_id, labelRank: rank, vector: vectors[i]! });
    }
    for (let i = 0; i < rows.length; i += 100) await this.db('knowledge_chunks').insert(rows.slice(i, i + 100));
    for (let i = 0; i < terms.length; i += 200) await this.db('knowledge_terms').insert(terms.slice(i, i + 200));
    await this.d.vectors.upsert(idx.id, records);
    await this.db('knowledge_indexes').where({ id: idx.id }).update({ chunks: await this.countChunks(idx.id) });
  }

  /**
   * Embeddings through the gateway, cached per tenant and model by a keyed hash of the text for 30 days. What is not
   * cached is metered as `embed` (`tenancy/usage-attribution.ts`): in `o.workspaceId` (the object's workspace, else the
   * caller's) or the tenant's default workspace, on `o.profileId` or the tenant's published profile for the model, for
   * `userId` (null for background work).
   */
  async embed(tenantId: string, model: string, texts: string[], label: Label, userId: string | null, o: EmbedOptions = {}): Promise<number[][]> {
    const signal = o.signal;
    const hashes = await Promise.all(texts.map((t) => this.terms.text(tenantId, `embed:${model}`, t)));
    const cached = new Map<string, number[]>();
    const fresh = Date.now() - EMBED_CACHE_MS;
    for (let i = 0; i < hashes.length; i += 500) {
      const rows = (await this.db('embedding_cache').where({ tenant_id: tenantId, model }).whereIn('hash', hashes.slice(i, i + 500)).andWhere('created_at', '>', fresh).select('hash', 'embedding')) as { hash: string; embedding: string }[];
      for (const r of rows) cached.set(r.hash, decodeVector(r.embedding));
    }
    const missing = [...new Set(hashes.filter((h) => !cached.has(h)))];
    if (missing.length) {
      const inputs = missing.map((h) => texts[hashes.indexOf(h)]!);
      const r = await this.d.gateway.embed(model, inputs, label, signal);
      const [workspaceId, profileId] = await Promise.all([usageWorkspace(this.db, tenantId, o.workspaceId), o.profileId !== undefined ? o.profileId : embeddingProfile(this.db, tenantId, model, o.preferProfiles)]);
      await this.d.quotas.record({ tenantId, workspaceId, userId, kind: 'embed', model, profileId, poolId: r.poolId, promptTokens: r.promptTokens, gpuMs: r.gpuMs });
      await this.db('embedding_cache').where({ tenant_id: tenantId, model }).whereIn('hash', missing).delete();
      const t = Date.now();
      const rows = missing.map((h, i) => ({ tenant_id: tenantId, model, hash: h, dims: r.embeddings[i]!.length, embedding: encodeVector(r.embeddings[i]!), created_at: t }));
      for (let i = 0; i < rows.length; i += 200) await this.db('embedding_cache').insert(rows.slice(i, i + 200));
      missing.forEach((h, i) => cached.set(h, r.embeddings[i]!));
    }
    return hashes.map((h) => cached.get(h)!);
  }

  // ---------- sync ----------

  private async syncDue(tenantId: string): Promise<{ queued: number }> {
    const now = Date.now();
    let queued = 0;
    for (const s of ((await this.db('knowledge_sources').where({ tenant_id: tenantId }).whereNot({ schedule: 'manual' }).whereNot({ kind: 'upload' }).whereNot({ kind: 'dataset' })) as Record<string, unknown>[]).map(sourceFrom)) {
      if (s.state === 'syncing') continue;
      if (s.last_sync_at && now - s.last_sync_at < SCHEDULE_MS[s.schedule]) continue;
      await this.sync(null, s);
      queued++;
    }
    return { queued };
  }

  private async syncJob(sourceId: string, ctx: JobContext): Promise<unknown> {
    const r = await this.db('knowledge_sources').where({ id: sourceId }).first();
    if (!r) return { skipped: 'gone' };
    const s = sourceFrom(r);
    await this.db('knowledge_sources').where({ id: s.id }).update({ state: 'syncing' });
    try {
      const out = await this.runSync(s, ctx);
      await this.db('knowledge_sources').where({ id: s.id }).update({ state: 'idle', last_sync_at: Date.now(), last_error: null, last_trace: null, ...(out.watermark !== undefined ? { watermark: out.watermark } : {}), updated_at: Date.now() });
      return out;
    } catch (err) {
      await this.db('knowledge_sources').where({ id: s.id }).update({ state: 'failed', last_error: (err as Error).message.slice(0, 500), last_trace: traceId(), last_sync_at: Date.now(), updated_at: Date.now() });
      throw err;
    }
  }

  private async runSync(s: SourceRow, ctx: JobContext): Promise<{ added: number; changed: number; unchanged: number; removed: number; watermark?: string | null; skipped?: number; skippedUrls?: { url: string; reason: string }[]; images?: number; recorded?: number }> {
    if (s.kind === 's3') {
      if (s.config.endpoint) {
        // B-1501: the source's own S3-compatible endpoint and keys, dialled through the knowledge host rules.
        if (!s.secret_sealed) throw new Error('The source has no keys; remove it and add it again.');
        // 1.7.0 (B-9208): from the vault once the keys were moved there.
        const opened = s.secret_ref && this.credentialVault ? await this.credentialVault.read('knowledge-source', s.tenant_id, s.secret_ref, `knowledge-source:${s.id}`) : await this.d.keys.open(s.tenant_id, s.secret_sealed, `knowledge-source:${s.id}`);
        const keys = json<{ accessKeyId: string; secretAccessKey: string }>(opened, { accessKeyId: '', secretAccessKey: '' });
        const agent = await this.fetchAgent(s.config.endpoint);
        try {
          const listing = await new S3Reader({ endpoint: s.config.endpoint, region: s.config.region ?? 'us-east-1', accessKeyId: keys.accessKeyId, secretAccessKey: keys.secretAccessKey, pathStyle: s.config.pathStyle ?? true }, agent).list(s.config.bucket!, s.config.prefix ?? '', this.o.maxBytes, ctx.signal, s.config.include ?? []);
          return { ...(await this.apply(s, listing.items, true, ctx)), watermark: listing.newest ?? s.watermark };
        } finally {
          await agent.close().catch(() => undefined);
        }
      }
      if (!this.o.s3) throw new Error('S3 is not configured on this platform.');
      const listing = await new S3Reader(this.o.s3).list(s.config.bucket!, s.config.prefix ?? '', this.o.maxBytes, ctx.signal, s.config.include ?? []);
      return { ...(await this.apply(s, listing.items, true, ctx)), watermark: listing.newest ?? s.watermark };
    }
    if (s.kind === 'web') {
      // B-1502: the crawl offers every page it reached; pages no longer reached are removed.
      const cfg = s.config;
      const agent = await this.fetchAgent(cfg.url!);
      try {
        const prev = new Map(((await this.db('knowledge_documents').where({ source_id: s.id }).whereNull('parent_id').whereNot({ state: 'removed' })) as Record<string, unknown>[]).map(docFrom).map((d) => [d.external_key, d]));
        const out = await crawl({
          start: cfg.url!,
          maxDepth: cfg.maxDepth ?? 2,
          maxPages: cfg.maxPages ?? 100,
          pathPrefix: cfg.pathPrefix ?? '',
          sitemap: cfg.sitemap ?? true,
          maxBytes: this.o.maxBytes,
          timeoutMs: this.o.fetchTimeoutMs ?? 30_000,
          dispatcher: agent,
          signal: ctx.signal,
          // A site's Crawl-delay is kept up to half a minute (the crawler's own default stops at five seconds).
          maxDelayMs: 30_000,
          previous: async (url) => {
            const d = prev.get(sha(url));
            return d && d.blob_key && d.state !== 'failed' ? { version: d.version, body: () => this.content(d) } : null;
          },
          // Images come from the site itself, or from a host the operator's list names (never one that is merely internal).
          ...(cfg.media ? { media: { max: cfg.maxMedia ?? 25, minBytes: CRAWL_IMAGE_MIN_BYTES, allowed: (host: string) => namedHost(host, this.allow) } } : {})
        });
        const applied = await this.apply(s, out.items, true, ctx);
        return { ...applied, ...(cfg.media ? { images: out.images } : {}), skipped: out.skipped.length, skippedUrls: out.skipped.slice(0, 50), watermark: new Date().toISOString() };
      } finally {
        await agent.close().catch(() => undefined);
      }
    }
    if (s.kind === 'git') {
      const co = await this.o.git.checkout(s.config.url!, s.config.ref ?? null, ctx.signal);
      try {
        if (co.commit === s.watermark) {
          const docs = Number(((await this.db('knowledge_documents').where({ source_id: s.id }).whereNot({ state: 'removed' }).count({ n: '*' })) as { n: number }[])[0]?.n ?? 0);
          return { added: 0, changed: 0, unchanged: docs, removed: 0, watermark: co.commit };
        }
        const items = await gitItems(co.dir, s.config.path ?? '', this.o.maxBytes);
        return { ...(await this.apply(s, items, true, ctx)), watermark: co.commit };
      } finally {
        await co.cleanup();
      }
    }
    if (s.kind === 'folder') {
      // B-2405: the folder's files, at most the base's label (a document never sits below its own label).
      if (!this.folders) throw new Error('The file store is not available on this server.');
      const kb = await this.kbRow(s.kb_id);
      const items = await this.folders.items(s.tenant_id, s.config.folderId!, highest(kb.label, s.label_floor), this.o.maxBytes);
      return { ...(await this.apply(s, items, true, ctx)), watermark: new Date().toISOString() };
    }
    if (s.kind === 'saved-query' || s.kind === 'rest') {
      const provider = this.external[s.kind];
      if (!provider) throw new Error(`${s.kind} sources are not available on this server.`);
      return { ...(await this.apply(s, await provider.items(s, ctx.signal), true, ctx, 'text/plain')), watermark: new Date().toISOString() };
    }
    if (s.kind === 'database' && s.config.roleMappings?.length) return this.syncAsRoles(s, ctx);
    if (s.kind === 'database') {
      const cfg = s.config;
      // MongoDB reads only the named fields, plus the id, watermark and access fields beside them.
      const fields = cfg.fields?.length ? [...new Set([cfg.idColumn ?? '_id', ...cfg.fields, ...(cfg.watermarkColumn ? [cfg.watermarkColumn] : []), ...(cfg.accessColumn ? [cfg.accessColumn] : [])])] : null;
      const r = await this.d.connections.readRows(s.tenant_id, cfg.connectionId!, cfg.object!, { watermarkColumn: cfg.watermarkColumn ?? null, after: cfg.watermarkColumn ? s.watermark : null, limit: 5000, rawColumn: cfg.accessColumn ?? null, ...(fields ? { fields } : {}) });
      const idAt = cfg.idColumn ? r.columns.indexOf(cfg.idColumn) : -1;
      const wmAt = cfg.watermarkColumn ? r.columns.indexOf(cfg.watermarkColumn) : -1;
      const accessAt = cfg.accessColumn ? r.columns.indexOf(cfg.accessColumn) : -1;
      if (cfg.accessColumn && accessAt < 0) throw new Error(`${cfg.object} no longer has the access column ${cfg.accessColumn}; nothing was synced.`);
      let watermark = s.watermark;
      let best: unknown = null;
      const later = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() > b.getTime() : typeof a === 'number' && typeof b === 'number' ? a > b : String(a) > String(b));
      const items: SourceItem[] = r.rows.map((row, i) => {
        const id = idAt >= 0 ? String(row[idAt]) : String(i + 1);
        // Rows arrive ordered by the watermark column; the last is the newest, compared in its own type.
        if (wmAt >= 0 && row[wmAt] != null && (best == null || later(row[wmAt], best))) {
          best = row[wmAt];
          watermark = best instanceof Date ? best.toISOString() : String(best);
        }
        // The access value comes unmasked (an email address names a user); the document body has it masked.
        return rowItem(cfg, id, r.columns, row, accessAt >= 0 ? r.raw?.[i] : undefined);
      });
      // With a watermark only changed rows arrive, so absence means nothing; without one, it means the row is gone.
      const out = await this.apply(s, items, !cfg.watermarkColumn, ctx, 'text/plain');
      return { ...out, watermark: cfg.watermarkColumn ? watermark : null };
    }
    if (s.kind === 'dataset') throw new Error('A dataset source is refreshed by an import job, not by this sync.');
    throw new Error('Uploads have no sync.');
  }

  /**
   * B-1503: reads the whole object once per mapped role (inside a read-only transaction under `SET LOCAL ROLE`), so
   * PostgreSQL's own grants and row security policies decide what each role sees. A row's document may be retrieved
   * by the groups whose role saw it; a row no mapped role sees is not indexed (and is removed if it was). When roles
   * see different values for the same row, each variant is its own document for the groups that saw it.
   */
  private async syncAsRoles(s: SourceRow, ctx: JobContext): Promise<{ added: number; changed: number; unchanged: number; removed: number; watermark: null }> {
    const cfg = s.config;
    const variants = new Map<string, Map<string, { columns: string[]; row: unknown[]; groups: Set<string> }>>();
    for (const m of cfg.roleMappings ?? []) {
      if (ctx.signal.aborted) throw ctx.signal.reason as Error;
      const r = await this.d.connections.readRows(s.tenant_id, cfg.connectionId!, cfg.object!, { watermarkColumn: null, after: null, limit: 5000, role: m.role });
      if (r.capped) this.d.log.warn({ source: s.id, role: m.role }, 'role mapping read capped at 5000 rows');
      const idAt = cfg.idColumn ? r.columns.indexOf(cfg.idColumn) : -1;
      if (idAt < 0) throw new Error(`${cfg.object} no longer has the id column ${cfg.idColumn ?? ''}; nothing was synced.`);
      for (const row of r.rows) {
        const id = String(row[idAt]);
        const body = rowItem({ ...cfg, accessColumn: null }, id, r.columns, row, undefined);
        const byBody = variants.get(id) ?? new Map();
        variants.set(id, byBody);
        const v = byBody.get(body.version!) ?? { columns: r.columns, row, groups: new Set<string>() };
        v.groups.add(m.group.toLowerCase());
        byBody.set(body.version!, v);
      }
    }
    const items: SourceItem[] = [];
    for (const [id, byBody] of variants) {
      const several = byBody.size > 1;
      for (const [hash, v] of byBody) {
        const it = rowItem({ ...cfg, accessColumn: null }, id, v.columns, v.row, undefined);
        items.push({ ...it, ...(several ? { key: `${it.key}#${hash.slice(0, 16)}` } : {}), acl: [...v.groups].sort().map((g) => `g:${g}`), version: `${it.version}:${[...v.groups].sort().join(',')}`.slice(0, 200) });
      }
    }
    return { ...(await this.apply(s, items, true, ctx, 'text/plain')), watermark: null };
  }

  /**
   * Applies a listing to the source's documents: new keys become documents, changed versions or content are
   * re-indexed, unchanged ones are skipped by version or content hash, and (for full listings) keys no longer
   * present are removed. Removed tombstones stay removed.
   */
  private async apply(s: SourceRow, items: SourceItem[], full: boolean, ctx: Pick<JobContext, 'signal' | 'progress'>, forceType?: string): Promise<{ added: number; changed: number; unchanged: number; removed: number; recorded?: number; setAside?: number }> {
    // A document's image parts (Sprint 36c) follow their document, not the listing.
    const existing = new Map(((await this.db('knowledge_documents').where({ source_id: s.id }).whereNull('parent_id')) as Record<string, unknown>[]).map(docFrom).map((d) => [d.external_key, d]));
    const seen = new Set<string>();
    let added = 0;
    let changed = 0;
    let unchanged = 0;
    let removed = 0;
    // Migration 044: what this sync finds new, changed and gone is recorded (the first sync only fills the source).
    const record = !!s.config.changes;
    let recorded = 0;
    let setAside = 0;
    const kb = await this.kbRow(s.kb_id);
    for (const [i, it] of items.entries()) {
      if (ctx.signal.aborted) throw ctx.signal.reason as Error;
      const key = sha(it.key);
      seen.add(key);
      const prev = existing.get(key);
      if (prev?.state === 'removed') continue;
      if (prev && it.version && prev.version === it.version && prev.state !== 'failed') {
        if (prev.state === 'indexed' || prev.state === 'unchanged') await this.db('knowledge_documents').where({ id: prev.id }).update({ state: 'unchanged' });
        unchanged++;
        continue;
      }
      const data = await it.read();
      const hash = sha(data);
      if (prev && prev.sha256 === hash && prev.state !== 'failed') {
        await this.db('knowledge_documents').where({ id: prev.id }).update({ version: it.version, state: prev.state === 'indexed' ? 'unchanged' : prev.state });
        // Same content, new access list (B-1503: a policy now shows the row to other roles): the chunks follow.
        if (it.acl !== undefined && JSON.stringify(it.acl) !== JSON.stringify(prev.acl)) {
          const acl = it.acl == null ? null : JSON.stringify(it.acl);
          await this.db('knowledge_documents').where({ id: prev.id }).update({ acl });
          await this.db('knowledge_chunks').where({ document_id: prev.id }).update({ acl });
        }
        unchanged++;
        continue;
      }
      const type = forceType ?? it.type ?? (() => {
        const t = detectType(data, it.name);
        return 'type' in t ? t.type : null;
      })();
      const t = Date.now();
      let doc: DocRow;
      // The text as it was, read before the stored copy is replaced.
      const was = prev && record ? await this.changeText(prev, await this.content(prev).catch(() => null)) : null;
      if (prev) {
        const blobKey = await this.store(prev, data);
        await this.db('knowledge_documents').where({ id: prev.id }).update({ name: it.name.slice(0, 300), size: data.length, sha256: hash, version: it.version, type, blob_key: blobKey, state: 'queued', updated_at: t, ...(it.acl !== undefined ? { acl: it.acl == null ? null : JSON.stringify(it.acl) } : {}) });
        doc = await this.document(s.tenant_id, prev.id);
        changed++;
      } else {
        const id = ulid();
        const blobKey = await this.store({ id, tenant_id: s.tenant_id }, data);
        await this.db('knowledge_documents').insert({ id, tenant_id: s.tenant_id, kb_id: s.kb_id, source_id: s.id, external_key: key, name: it.name.slice(0, 300), type, size: data.length, sha256: hash, version: it.version, label: highest(kb.label, s.label_floor), auto_label: null, manual_label: null, label_origin: 'inherited', detections: null, state: 'queued', blob_key: blobKey, chunks: 0, created_at: t, updated_at: t, acl: it.acl == null ? null : JSON.stringify(it.acl) });
        doc = await this.document(s.tenant_id, id);
        added++;
      }
      if (!type) {
        await this.db('knowledge_documents').where({ id: doc.id }).update({ state: 'failed', error: 'The file type is not accepted.', trace_id: traceId() });
        continue;
      }
      let out: Awaited<ReturnType<KnowledgeService['indexInto']>>;
      try {
        out = await this.indexInto(doc, await this.liveIndexes(s.kb_id));
      } catch (err) {
        // No pool may run the embedding model on data of this document's label (the classifier raised it, a public
        // page with an email address for example): the document is set aside with the reason and the rest of the
        // listing goes on. Its version is kept, so it is not tried again until it changes or is reindexed by hand.
        if (!(await this.setAside(doc, err))) throw err;
        setAside++;
        await ctx.progress(((i + 1) / Math.max(1, items.length)) * 100, `Synced ${i + 1} of ${items.length}`);
        continue;
      }
      if (record && out.state === 'indexed' && (prev || s.last_sync_at)) {
        const now = await this.changeText(await this.document(s.tenant_id, doc.id), data);
        if (await this.recordChange(s, doc, prev ? 'changed' : 'added', out.label ?? doc.label, was, now)) recorded++;
      }
      await ctx.progress(((i + 1) / Math.max(1, items.length)) * 100, `Synced ${i + 1} of ${items.length}`);
    }
    if (full) {
      for (const [key, d] of existing) {
        if (seen.has(key) || d.state === 'removed') continue;
        if (record && (d.state === 'indexed' || d.state === 'unchanged') && (await this.recordChange(s, d, 'removed', d.label, null, null))) recorded++;
        await this.purgeDocument(d);
        removed++;
      }
    }
    if (recorded) {
      const old = (await this.db('knowledge_doc_changes').where({ source_id: s.id }).orderBy('created_at', 'desc').orderBy('id', 'desc').offset(CHANGES_KEPT).limit(5000).select('id')) as { id: string }[];
      for (let i = 0; i < old.length; i += 500) await this.db('knowledge_doc_changes').whereIn('id', old.slice(i, i + 500).map((x) => x.id)).delete();
    }
    return { added, changed, unchanged, removed, ...(record ? { recorded } : {}), ...(setAside ? { setAside } : {}) };
  }

  // ---------- differentials (migration 044) ----------

  /** What a document says, for comparing two syncs: its extracted text, or an image's caption and the text read in it. */
  private async changeText(d: DocRow, data: Buffer | null): Promise<string | null> {
    try {
      if (d.media === 'image' || isImageType(d.type)) {
        const v = await this.describedAs(d);
        return v ? indexedText(d.name, v) : null;
      }
      return data && d.type ? extractText(data, d.type) : null;
    } catch {
      return null;
    }
  }

  /**
   * Records one finding of a sync. A changed document whose text is the same as before (only its markup differs) is
   * no change and is not recorded; one whose text could not be read on either side is recorded without a diff.
   */
  private async recordChange(s: SourceRow, doc: Pick<DocRow, 'id' | 'name'>, kind: ChangeRow['kind'], label: Label, was: string | null, now: string | null): Promise<boolean> {
    const count = (t: string | null) => (t ? t.split('\n').filter((l) => l.trim()).length : 0);
    let added = kind === 'added' ? count(now) : 0;
    let removed = 0;
    let diff: string | null = null;
    let truncated = false;
    if (kind === 'changed' && was != null && now != null) {
      const d = textDiff(was, now);
      if (!d.added && !d.removed) return false;
      ({ added, removed, truncated } = d);
      diff = d.text;
    }
    const id = ulid();
    await this.db('knowledge_doc_changes').insert({ id, tenant_id: s.tenant_id, kb_id: s.kb_id, source_id: s.id, document_id: doc.id, kind, name: doc.name.slice(0, 300), label, label_rank: labelRank(label), added, removed, diff_sealed: diff ? await this.d.keys.seal(s.tenant_id, diff, `kdoc-change:${id}`) : null, truncated: truncated ? 1 : 0, created_at: Date.now() });
    return true;
  }

  /** What the syncs of a base's sources found, newest first, at or below the reader's clearance. */
  async changes(p: Principal, kbId: string, opts: { sourceId?: string; documentId?: string; since?: number; limit?: number } = {}): Promise<ChangeRow[]> {
    const kb = await this.base(p, kbId);
    const q = this.db('knowledge_doc_changes').where({ kb_id: kb.id }).andWhere('label_rank', '<=', labelRank(p.clearance));
    if (opts.sourceId) void q.andWhere({ source_id: opts.sourceId });
    if (opts.documentId) void q.andWhere({ document_id: opts.documentId });
    if (opts.since) void q.andWhere('created_at', '>=', opts.since);
    return ((await q.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(Math.min(opts.limit ?? 100, 500))) as Record<string, unknown>[]).map(changeFrom);
  }

  /**
   * One recorded change with its line diff. The diff is knowledge content: it passes the `context` checkpoint like a
   * search hit, and a withheld one says why and carries no text.
   */
  async change(p: Principal, id: string): Promise<{ change: ChangeRow; kb: KbRow; diff: string | null; withheld?: string }> {
    const r = (await this.db('knowledge_doc_changes').where({ tenant_id: p.tenantId, id }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Change');
    const change = changeFrom(r);
    const kb = await this.base(p, change.kb_id);
    if (!clears(p.clearance, change.label)) throw notFound('Change');
    if (!change.diff_sealed) return { change, kb, diff: null };
    const text = await this.d.keys.open(change.tenant_id, change.diff_sealed, `kdoc-change:${change.id}`);
    const g = await this.d.guard.check({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, checkpoint: 'context', text, label: change.label, principal: p, source: { kind: 'document', id: change.document_id }, meta: { kb: kb.id, document: change.document_id } });
    if (g.action === 'block' || g.action === 'require-approval') return { change, kb, diff: null, withheld: g.reason ?? 'Withheld by a guardrail rule.' };
    return { change, kb, diff: g.action === 'redact' ? g.text : text };
  }

  /**
   * One committed transaction from a source's replication stream (B-1003): inserted and updated rows become or
   * refresh documents exactly as the watermark sync writes them, deleted rows are removed from every index, and a
   * truncate removes every document of the source. Nothing is acknowledged to the database until this resolves.
   */
  async applyReplicated(s: SourceRow, changes: MaskedChange[]): Promise<{ upserted: number; removed: number }> {
    const cfg = s.config;
    const ctx = { signal: new AbortController().signal, progress: async () => undefined };
    let removed = 0;
    let upserted = 0;
    const idOf = (ch: MaskedChange, row: unknown[] | null) => {
      const at = cfg.idColumn ? ch.columns.indexOf(cfg.idColumn) : -1;
      return at >= 0 && row && row[at] != null ? String(row[at]) : null;
    };
    const remove = async (id: string) => {
      const d = await this.db('knowledge_documents').where({ source_id: s.id, external_key: sha(`${cfg.object}#${id}`) }).first();
      if (d && d.state !== 'removed') {
        await this.purgeDocument(docFrom(d));
        removed++;
      }
    };
    for (const ch of changes) {
      if (ch.op === 'truncate') {
        for (const d of ((await this.db('knowledge_documents').where({ source_id: s.id }).whereNot({ state: 'removed' })) as Record<string, unknown>[]).map(docFrom)) {
          await this.purgeDocument(d);
          removed++;
        }
        continue;
      }
      if (ch.op === 'delete') {
        const id = idOf(ch, ch.old);
        if (id) await remove(id);
        else this.d.log.warn({ source: s.id }, 'a replicated delete carries no id column value; set REPLICA IDENTITY FULL or make the id column the primary key');
        continue;
      }
      const id = idOf(ch, ch.values);
      if (!id) continue;
      // An update that changed the id moves the document.
      const oldId = ch.op === 'update' ? idOf(ch, ch.old) : null;
      if (oldId && oldId !== id) await remove(oldId);
      const out = await this.apply(s, [rowItem(cfg, id, ch.columns, ch.values!, ch.raw)], false, ctx, 'text/plain');
      upserted += out.added + out.changed;
    }
    return { upserted, removed };
  }

  // ---------- search ----------

  /**
   * Hybrid search over the serving indexes of the given bases. The label filter (`ceiling`) is part of every query:
   * vectors, keyword terms and chunk rows above it are never read, ranked or counted.
   */
  async search(p: Principal, kbs: KbRow[], query: string, opts: { k?: number; ceiling?: Label; queryLabel?: Label; rerank?: boolean; withText?: boolean; signal?: AbortSignal; lenient?: boolean; labels?: LabelFilter; categories?: CategoryFilter } = {}): Promise<{ hits: SearchHit[]; ceiling: Label; vectorSkipped: string | null }> {
    const ceiling = opts.ceiling && labelRank(opts.ceiling) < labelRank(p.clearance) ? opts.ceiling : p.clearance;
    const maxRank = labelRank(ceiling);
    const k = opts.k ?? 8;
    // B-8803: a label filter keeps only the chunks of image documents carrying the labels, inside the ranking.
    // Migration 043: a category filter keeps the chunks of documents in or under the categories, the same way.
    let allowed: Set<string> | null = null;
    let within: Set<string> | null = null;
    if (opts.labels && (opts.labels.any?.length || opts.labels.all?.length)) within = await this.docsWithLabels(kbs.map((x) => x.id), opts.labels, maxRank);
    if (opts.categories && (opts.categories.any?.length || opts.categories.all?.length)) {
      const filed = await this.docsInCategories(kbs.map((x) => x.id), opts.categories);
      within = within ? new Set([...within].filter((id) => filed.has(id))) : filed;
    }
    if (within) {
      const docIds = [...within];
      allowed = new Set();
      for (let i = 0; i < docIds.length; i += 500) for (const r of (await this.db('knowledge_chunks').whereIn('document_id', docIds.slice(i, i + 500)).andWhere('label_rank', '<=', maxRank).select('id')) as { id: string }[]) allowed.add(r.id);
      if (!allowed.size) return { hits: [], ceiling, vectorSkipped: null };
    }
    const keep = (id: string) => !allowed || allowed.has(id);
    const words = [...new Set(tokenize(query))];
    const vectorList: { id: string; score: number }[] = [];
    const keywordList: { id: string; score: number }[] = [];
    let vectorSkipped: string | null = null;
    for (const kb of kbs) {
      if (!kb.serving_index_id) continue;
      const idx = await this.indexRow(kb.serving_index_id);
      if (!idx || !idx.chunks) continue;
      // Vector ranking.
      try {
        const [vec] = await this.embed(p.tenantId, idx.embed_model, [query], opts.queryLabel ?? 'internal', p.userId, { signal: opts.signal, workspaceId: kb.workspace_id ?? p.workspaceId ?? null });
        for (const h of await this.d.vectors.search(idx.id, { tenantId: p.tenantId, vector: vec!, k: allowed ? Math.max(40, Math.min(1000, allowed.size)) : 40, maxLabelRank: maxRank })) if (keep(h.id)) vectorList.push(h);
      } catch (err) {
        if (!opts.lenient) throw err;
        vectorSkipped = (err as Error).message;
      }
      // Keyword ranking (BM25 over keyed-hash terms).
      if (words.length) {
        const hashed = await this.terms.terms(p.tenantId, words);
        const rows = ((await this.db('knowledge_terms').where({ index_id: idx.id }).whereIn('term', [...hashed.values()]).andWhere('label_rank', '<=', maxRank).select('chunk_id', 'term', 'tf')) as { chunk_id: string; term: string; tf: number }[]).filter((r) => keep(r.chunk_id));
        if (rows.length) {
          const stats = ((await this.db('knowledge_chunks').where({ index_id: idx.id }).andWhere('label_rank', '<=', maxRank).count({ n: '*' }).avg({ a: 'tokens' })) as { n: number; a: number }[])[0]!;
          const df = new Map<string, number>();
          const tf = new Map<string, Map<string, number>>();
          for (const r of rows) {
            df.set(r.term, (df.get(r.term) ?? 0) + 1);
            const m = tf.get(r.chunk_id) ?? new Map<string, number>();
            m.set(r.term, Number(r.tf));
            tf.set(r.chunk_id, m);
          }
          const lengths = new Map(((await this.db('knowledge_chunks').whereIn('id', [...tf.keys()]).select('id', 'tokens')) as { id: string; tokens: number }[]).map((x) => [x.id, Number(x.tokens)]));
          const qterms = [...hashed.values()];
          for (const [id, m] of tf) keywordList.push({ id, score: bm25(qterms, m, df, Number(stats.n), lengths.get(id) ?? 0, Number(stats.a)) });
        }
      }
    }
    vectorList.sort((a, b) => b.score - a.score);
    keywordList.sort((a, b) => b.score - a.score);
    const fused = rrf([vectorList.slice(0, 40).map((x) => x.id), keywordList.slice(0, 40).map((x) => x.id)]);
    // Row-level access (B-1002): chunks whose row names neither the reader nor one of their groups are dropped
    // before ranking is cut to k, so they are never read, returned or counted.
    const restricted = fused.size ? ((await this.db('knowledge_chunks').whereIn('id', [...fused.keys()]).whereNotNull('acl').select('id', 'acl')) as { id: string; acl: string }[]) : [];
    if (restricted.length) {
      const reader = await readerEntries(this.db, p);
      for (const r of restricted) if (!aclAllows(readAcl(r.acl), reader)) fused.delete(r.id);
    }
    const vScore = new Map(vectorList.map((x) => [x.id, x.score]));
    const maxKw = keywordList[0]?.score ?? 0;
    const kScore = new Map(keywordList.map((x) => [x.id, maxKw ? x.score / maxKw : 0]));
    const reranking = !!opts.rerank && kbs.some((x) => x.reranker);
    const candidates = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, reranking ? Math.max(k * 2, 10) : k);
    if (!candidates.length) return { hits: [], ceiling, vectorSkipped };
    const chunkRows = (await this.db('knowledge_chunks').whereIn('id', candidates.map((c) => c[0])).andWhere('label_rank', '<=', maxRank)) as { id: string; tenant_id: string; kb_id: string; document_id: string; content: string; label: Label }[];
    const byId = new Map(chunkRows.map((r) => [r.id, r]));
    const docs = new Map(((await this.db('knowledge_documents').whereIn('id', [...new Set(chunkRows.map((r) => r.document_id))])) as Record<string, unknown>[]).map(docFrom).map((d) => [d.id, d]));
    const srcs = new Map(((await this.db('knowledge_sources').whereIn('id', [...new Set([...docs.values()].map((d) => d.source_id))])) as Record<string, unknown>[]).map(sourceFrom).map((s) => [s.id, s]));
    const kbById = new Map(kbs.map((x) => [x.id, x]));
    let hits: SearchHit[] = [];
    for (const [id, score] of candidates) {
      const c = byId.get(id);
      if (!c) continue;
      const d = docs.get(c.document_id);
      if (d?.state === 'hidden') continue; // Sprint 26 (B-1903): hidden by moderation until an appeal restores it
      const opened = await this.openChunk(c.tenant_id, c.id, c.content);
      const src = d ? srcs.get(d.source_id) : undefined;
      hits.push({ chunkId: c.id, kbId: c.kb_id, kb: kbById.get(c.kb_id)?.name ?? '', documentId: c.document_id, document: d?.name ?? '', source: src ? (src.kind === 'upload' ? 'Uploads' : src.location) : '', heading: opened.heading, label: c.label, vector: vScore.has(id) ? Number(vScore.get(id)!.toFixed(4)) : null, keyword: kScore.has(id) ? Number(kScore.get(id)!.toFixed(4)) : null, fused: Number(score.toFixed(5)), rerank: null, text: opened.text, origin: src?.kind === 'web' ? 'crawl' : 'knowledge' });
    }
    if (reranking) hits = await this.rerank(p, hits, query, kbs, opts.queryLabel ?? 'internal', opts.signal);
    hits = hits.slice(0, k);
    // B-8803: image hits carry the caption, an excerpt of the image's text, its labels and its thumbnail.
    const imageDocs = [...new Set(hits.map((h) => h.documentId))].map((id) => docs.get(id)).filter((d): d is DocRow => d?.media === 'image');
    if (imageDocs.length) {
      const labels = await this.labelsOf(imageDocs.map((d) => d.id));
      const described = new Map(await Promise.all(imageDocs.map(async (d) => [d.id, await this.describedAs(d)] as const)));
      for (const h of hits) {
        const d = docs.get(h.documentId);
        if (d?.media !== 'image') continue;
        const v = described.get(d.id);
        h.image = { caption: v?.caption ?? null, ocr: v?.text ? (v.text.length > OCR_EXCERPT ? `${v.text.slice(0, OCR_EXCERPT)}…` : v.text) : null, labels: labels.get(d.id) ?? [], thumbnail: thumbnailUrl(d) };
      }
    }
    const filed = await this.categoriesOf([...new Set(hits.flatMap((h) => [h.documentId, docs.get(h.documentId)?.parent_id ?? '']))].filter(Boolean));
    for (const h of hits) {
      const c = filed.get(h.documentId) ?? filed.get(docs.get(h.documentId)?.parent_id ?? '');
      if (c) h.categories = c;
    }
    // The context checkpoint: each retrieved chunk before anyone sees it.
    for (const h of hits) {
      const g = await this.d.guard.check({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, checkpoint: 'context', text: h.text ?? '', label: h.label, principal: p, source: { kind: 'chunk', id: h.chunkId }, meta: { kb: h.kbId, document: h.documentId } });
      if (g.action === 'block' || g.action === 'require-approval') {
        h.withheld = g.reason ?? 'Withheld by a guardrail rule.';
        delete h.text;
        // The caption and text of a withheld image are what the rule withheld.
        if (h.image) h.image = { ...h.image, caption: null, ocr: null };
      } else if (g.action === 'redact') h.text = g.text;
      // An image hit's caption and excerpt are checked as well: withheld, or redacted where a rule rewrites them.
      if (h.image && (h.image.caption || h.image.ocr)) {
        const both = `${h.image.caption ?? ''}\n\n${h.image.ocr ?? ''}`;
        const gi = await this.d.guard.check({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, checkpoint: 'context', text: both, label: h.label, principal: p, source: { kind: 'chunk', id: h.chunkId }, meta: { kb: h.kbId, document: h.documentId, via: 'image' } });
        if (gi.action === 'block' || gi.action === 'require-approval') h.image = { ...h.image, caption: null, ocr: null };
        else if (gi.action === 'redact' && gi.text !== both) {
          const [caption, ...rest] = gi.text.split('\n\n');
          h.image = { ...h.image, caption: caption || null, ocr: rest.join('\n\n') || null };
        }
      }
    }
    if (!opts.withText) for (const h of hits) {
      delete h.text;
      if (h.image) h.image = { ...h.image, caption: null, ocr: null };
    }
    return { hits, ceiling, vectorSkipped };
  }

  /** Scores each candidate with the reranking model (0 to 10), then orders by that score. */
  private async rerank(p: Principal, hits: SearchHit[], query: string, kbs: KbRow[], label: Label, signal?: AbortSignal): Promise<SearchHit[]> {
    const model = kbs.find((x) => x.reranker)?.reranker;
    if (!model) return hits;
    for (const h of hits) {
      try {
        const r = await this.d.gateway.complete(
          model,
          [
            { role: 'system', content: 'You judge search results. Rate how well the passage answers the query, from 0 (unrelated) to 10 (answers it). Reply with the number only.' },
            { role: 'user', content: `Query: ${query}\n\nPassage:\n${(h.text ?? '').slice(0, 4000)}` }
          ],
          highest(label, h.label),
          signal
        );
        const n = Number(/\d+(\.\d+)?/.exec(r.content)?.[0]);
        h.rerank = Number.isFinite(n) ? Math.max(0, Math.min(1, n / 10)) : null;
      } catch (err) {
        this.d.log.warn({ err: (err as Error).message, tenant: p.tenantId }, 'reranking failed; keeping the fused order');
        return hits;
      }
    }
    return [...hits].sort((a, b) => (b.rerank ?? -1) - (a.rerank ?? -1) || b.fused - a.fused);
  }

  // ---------- chat ----------

  async bindings(conversationId: string): Promise<string[]> {
    return ((await this.db('knowledge_bindings').where({ conversation_id: conversationId }).select('kb_id')) as { kb_id: string }[]).map((r) => r.kb_id);
  }

  async bind(p: Principal, conversationId: string, kbIds: string[]): Promise<string[]> {
    const conv = (await this.db('conversations').where({ tenant_id: p.tenantId, id: conversationId }).first()) as { user_id: string } | undefined;
    if (!conv || conv.user_id !== p.userId) throw notFound('Conversation');
    const visible = new Set((await this.visible(p)).map((x) => x.kb.id));
    const bad = kbIds.find((id) => !visible.has(id));
    if (bad) throw notFound('Knowledge base');
    await this.db('knowledge_bindings').where({ conversation_id: conversationId }).delete();
    if (kbIds.length) await this.db('knowledge_bindings').insert([...new Set(kbIds)].map((kb_id) => ({ conversation_id: conversationId, kb_id, tenant_id: p.tenantId, created_at: Date.now() })));
    return this.bindings(conversationId);
  }

  /** The chat context provider: published bases bound to the conversation or granted to the profile, which the user may read. */
  async contextFor(req: ContextRequest): Promise<ContextItem[]> {
    const ids = new Set(req.kbIds ?? [...(await this.bindings(req.conversationId)), ...((await this.db('knowledge_access').where({ tenant_id: req.tenantId, principal_kind: 'profile', principal_id: req.profile.id }).select('kb_id')) as { kb_id: string }[]).map((r) => r.kb_id)]);
    if (!ids.size || !req.query.trim()) return [];
    const kbs = (await this.visible(req.principal)).map((x) => x.kb).filter((kb) => ids.has(kb.id) && kb.status === 'published');
    if (!kbs.length) return [];
    const { hits } = await this.search(req.principal, kbs, req.query, { k: 6, ceiling: req.ceiling, queryLabel: req.label, rerank: true, withText: true, lenient: true });
    const items: ContextItem[] = [];
    for (const h of hits) {
      if (h.withheld || !h.text) continue;
      const origin = h.origin ?? 'knowledge';
      const item: ContextItem = { tag: 'context' as const, label: h.label, attrs: { source: `${h.kb}: ${h.document}`, ...(h.heading ? { section: h.heading } : {}) }, text: h.text, cite: { kbId: h.kbId, kb: h.kb, documentId: h.documentId, document: h.document, chunkId: h.chunkId, section: h.heading, score: h.rerank ?? h.fused }, origin };
      // B-6902: the untrusted-content checkpoint, before a model reads the chunk: a block withholds it, a milder
      // action annotates it (the warning goes with it into the prompt).
      const defence = this.d.injection?.();
      if (defence) {
        const v = await defence.screen({ tenantId: req.tenantId, workspaceId: req.workspaceId, principal: req.principal, label: h.label, source: origin, ref: h.chunkId, name: `${h.kb}: ${h.document}`, text: h.text, meta: { kb: h.kbId, document: h.documentId, conversationId: req.conversationId } });
        if (v.action === 'block') continue;
        item.text = v.text;
        item.untrusted = v;
      }
      items.push(item);
    }
    return items;
  }

  /** Deletes everything a tenant holds in knowledge (offboarding): vectors by tenant, then blobs. */
  async purgeTenant(tenantId: string): Promise<void> {
    await this.d.vectors.purgeTenant(tenantId);
    this.terms.forget(tenantId);
  }
}
