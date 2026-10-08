import { createHash, randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import type { Logger } from 'pino';
import { json, type Db } from '../db/knex.js';
import { clears, highest, LABELS, labelRank, type Label } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import type { AuditLog } from '../audit/chain.js';
import { clamScan, classify } from '../chat/attachments.js';
import type { ContextItem, ContextRequest } from '../chat/context.js';
import type { InjectionDefence } from '../guardrails/injection.js';
import { allowed as allowedObject, type ConnectionRow, type ConnectionService } from '../connections/service.js';
import type { Gateway } from '../gateway/gateway.js';
import type { Guardrails } from '../guardrails/types.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
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
import { checkHost, guardedAgent, HostRefused, parseAllowList, type AllowList } from '../mcp/hosts.js';
import { bm25, rrf, termCounts, TermKeys, tokenize } from './terms.js';
import { aclAllows, readAcl, readerEntries, rowAcl, type AccessKind } from './acl.js';
import { ReplicationManager } from './replication.js';
import type { MaskedChange } from '../connections/service.js';
import type { FolderSourceProvider } from '../files/service.js';
import type { ClassifierRow, ClassifierService } from '../guardrails/classifiers.js';
import { complete } from '../guardrails/model.js';
import type { ImageSafety } from '../images/safety.js';
import { DESCRIBE_PROMPT, imageParts, indexedText, isImageType, parseDescription, VIEWABLE, type ImageDescription } from './images.js';

export const SOURCE_KINDS = ['upload', 's3', 'git', 'database', 'web', 'folder'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const SCHEDULES = ['15m', 'hourly', 'daily', 'manual'] as const;
export type Schedule = (typeof SCHEDULES)[number];
const SCHEDULE_MS: Record<Schedule, number> = { '15m': 15 * 60_000, hourly: 60 * 60_000, daily: 24 * 60 * 60_000, manual: 0 };
const EMBED_CACHE_MS = 30 * 24 * 60 * 60_000;

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
    engine?: 'postgres' | 'mysql' | 'mongodb';
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
    /** B-1503: rows are read as each mapped PostgreSQL role, and the groups whose role saw a row may retrieve it. */
    roleMappings?: RoleMapping[];
    /** B-2405: a file store folder (and its subfolders). */
    folderId?: string;
  };
  /** B-1501: the sealed secret access key of the source's own S3-compatible endpoint. */
  secret_sealed?: string | null;
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
  /** B-1503 */
  roleMappings?: RoleMapping[];
  /** MongoDB collections: the text fields to index. */
  fields?: string[];
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

export const docView = (d: DocRow, source?: SourceRow, labels?: DocLabel[]) => ({
  id: d.id,
  name: d.name,
  parentId: d.parent_id,
  media: d.media,
  thumbnail: thumbnailUrl(d),
  safetyScore: d.safety_score,
  ...(labels ? { labels } : {}),
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
  readonly replication: ReplicationManager;
  private readonly db: Db;
  /** Sprint 26d (B-2405): the file store's folders as sources; set when the file store is built. */
  folders: FolderSourceProvider | null = null;

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
    d.jobs.register('knowledge.scan', (p) => this.scanJob(String(p.documentId)), { timeoutMs: 10 * 60_000 });
    d.jobs.register('knowledge.index', (p, ctx) => this.indexJob(String(p.documentId), ctx), { timeoutMs: 30 * 60_000 });
    d.jobs.register('knowledge.sync', (p, ctx) => this.syncJob(String(p.sourceId), ctx), { timeoutMs: 2 * 60 * 60_000 });
    d.jobs.register('knowledge.reindex', (p, ctx) => this.reindexJob(String(p.indexId), ctx), { timeoutMs: 12 * 60 * 60_000 });
    d.jobs.register('knowledge.sync-due', (p, ctx) => this.syncDue(String(p.tenantId ?? ctx.job.tenant_id)));
    // Sprint 36c (B-8802): an image document's labels, and the labels of a base's images again after a new version.
    d.jobs.register('knowledge.classify', (p) => this.classifyJob(String(p.documentId), p.classifierId ? String(p.classifierId) : null), { timeoutMs: 30 * 60_000 });
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
    const grants = (await this.db('knowledge_access')
      .where({ tenant_id: p.tenantId })
      .andWhere((q) => q.where({ principal_kind: 'user', principal_id: p.userId }).orWhere((w) => w.where({ principal_kind: 'workspace' }).whereIn('principal_id', ws.length ? ws : ['']))) ) as { kb_id: string; access: 'read' | 'manage' }[];
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
    const docs = new Map(((await this.db('knowledge_documents').whereIn('kb_id', ids.length ? ids : ['']).whereIn('label', cleared).whereNot({ state: 'removed' }).groupBy('kb_id').select('kb_id').count({ n: '*' })) as { kb_id: string; n: number }[]).map((r) => [r.kb_id, Number(r.n)]));
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
      if (gone.length) await this.db('knowledge_doc_labels').where({ kb_id: kb.id }).whereIn('classifier_id', gone).delete();
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

  /** B-8802: the image classifiers a base may name: published `vision` classifiers of the tenant (ids or slugs). */
  private async checkImageClassifiers(tenantId: string, refs: string[]): Promise<string[]> {
    const ids: string[] = [];
    if (refs.length && !this.d.classifiers) throw conflict('Classifiers are not available on this server.');
    for (const ref of [...new Set(refs)]) {
      const c = await this.d.classifiers!.get(tenantId, ref);
      if (!c) throw notFound(`Classifier ${ref}`);
      if (c.engine !== 'vision') throw conflict(`${c.name} is a ${c.engine} classifier; image documents are labelled by vision classifiers.`);
      if (c.status !== 'published') throw conflict(`${c.name} is a draft. A classifier labels documents once it is published, after an evaluation with enough samples per label.`);
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
    await this.db('knowledge_bases').where({ id: kb.id }).delete();
    return { documents: docs.length };
  }

  // ---------- access list ----------

  async accessList(kb: KbRow) {
    const rows = (await this.db('knowledge_access').where({ kb_id: kb.id }).orderBy('created_at')) as { id: string; principal_kind: string; principal_id: string; access: string; created_by: string | null; created_at: number }[];
    const names = async (kind: string, id: string): Promise<string> => {
      const r = kind === 'user' ? await this.db('users').where({ id }).first('display_name as n') : kind === 'workspace' ? await this.db('workspaces').where({ id }).first('name as n') : await this.db('profiles').where({ id }).first('display_name as n');
      return (r as { n?: string } | undefined)?.n ?? id;
    };
    return Promise.all(rows.map(async (r) => ({ id: r.id, kind: r.principal_kind, principalId: r.principal_id, name: await names(r.principal_kind, r.principal_id), access: r.access, createdBy: r.created_by ? await names('user', r.created_by) : null, createdAt: Number(r.created_at) })));
  }

  async grant(p: Principal, kbId: string, input: { kind: 'workspace' | 'user' | 'profile'; id: string; access: 'read' | 'manage' }) {
    const kb = await this.base(p, kbId, 'manage');
    const table = input.kind === 'user' ? 'users' : input.kind === 'workspace' ? 'workspaces' : 'profiles';
    const target = await this.db(table).where({ tenant_id: p.tenantId, id: input.id }).first();
    if (!target) throw notFound(input.kind === 'user' ? 'User' : input.kind === 'workspace' ? 'Workspace' : 'Profile');
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
      config = { url, maxDepth: input.maxDepth ?? 2, maxPages: input.maxPages ?? 100, pathPrefix, sitemap: input.sitemap ?? true };
    } else if (input.kind === 'folder') {
      // B-2405: a file store folder the curator can read; its files are indexed up to the base's label.
      if (!this.folders) throw conflict('The file store is not available on this server.');
      const f = await this.folders.check(p, location);
      if (await this.db('knowledge_sources').where({ kb_id: kb.id, kind: 'folder', location: `folder: ${f.name}` }).whereRaw("config like ?", [`%${f.id}%`]).first('id')) throw conflict(`${f.name} is already a source of this knowledge base.`);
      location = `folder: ${f.name}`;
      config = { folderId: f.id };
    } else if (input.kind === 'git') {
      location = location.replace(/^git:\s*/i, '');
      config = { url: location, ref: input.ref ?? null, path: input.path ?? '' };
    } else {
      if (!input.connectionId) throw new HttpProblem(400, 'Invalid request', 'Pick the data connection the view is read through.');
      const conn = await this.d.connections.get(p.tenantId, input.connectionId);
      if (conn.engine === 'mongodb') return this.addMongoSource(p, kb, conn, input, location, floor);
      if (input.fields?.length) throw conflict('Fields are for MongoDB collections; a table or view is indexed whole.');
      if (conn.engine !== 'postgres' && conn.engine !== 'mysql') throw conflict('Only PostgreSQL and MySQL tables and views, and MongoDB collections, can be a knowledge source.');
      const object = location.replace(/^(pg|mysql):\s*/i, '');
      // PostgreSQL names default to the public schema, MySQL names to the connection's database.
      const home = conn.engine === 'postgres' ? 'public' : (conn.database ?? '');
      const schema = (conn.schema ?? []).find((o) => o.name.toLowerCase() === object.toLowerCase() || (!!home && o.name.toLowerCase() === `${home}.${object}`.toLowerCase()));
      if (!schema) throw conflict(`${object} is not in ${conn.name}'s introspected schema. Refresh the schema on the Connections screen.`);
      if (!conn.allow_list.map((x) => x.toLowerCase()).includes(schema.name.toLowerCase())) throw conflict(`${schema.name} is not on ${conn.name}'s schema allow-list.`);
      const cols = schema.columns.map((c) => c.name);
      const wm = input.watermarkColumn ?? (cols.includes('updated_at') ? 'updated_at' : null);
      if (wm && !cols.includes(wm)) throw conflict(`${schema.name} has no column ${wm}.`);
      const idCol = input.idColumn ?? (cols.includes('id') ? 'id' : (cols[0] ?? null));
      if (idCol && !cols.includes(idCol)) throw conflict(`${schema.name} has no column ${idCol}.`);
      if (input.accessColumn && !cols.includes(input.accessColumn)) throw conflict(`${schema.name} has no column ${input.accessColumn}.`);
      if (input.replication && conn.engine !== 'postgres') throw conflict('Logical replication is for PostgreSQL sources; MySQL sources sync by watermark.');
      if (input.replication && schema.kind === 'view') throw conflict(`${schema.name} is a view: PostgreSQL replicates tables only. Point the source at the table, or leave replication off to sync the view by watermark.`);
      if (input.replication && !idCol) throw conflict('Replication needs an id column to match changed rows to documents.');
      if (input.roleMappings?.length) await this.checkRoleMappings(p.tenantId, conn, schema.name, input, idCol);
      location = `${conn.engine === 'postgres' ? 'pg' : 'mysql'}: ${schema.name}`;
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
    const job = await this.d.jobs.enqueue({ tenantId: s.tenant_id, type: 'knowledge.sync', payload: { sourceId: s.id }, createdBy: by, maxAttempts: 2 });
    await this.db('knowledge_sources').where({ id: s.id }).update({ state: 'syncing', job_id: job.id, updated_at: Date.now() });
    return { jobId: job.id };
  }

  async removeSource(p: Principal, sourceId: string): Promise<{ documents: number }> {
    const s = await this.source(p.tenantId, sourceId);
    await this.base(p, s.kb_id, 'manage');
    const docs = ((await this.db('knowledge_documents').where({ source_id: s.id })) as Record<string, unknown>[]).map(docFrom);
    await this.replication.release(s);
    for (const d of docs) await this.purgeDocument(d);
    await this.db('knowledge_sources').where({ id: s.id }).delete();
    return { documents: docs.length };
  }

  // ---------- documents ----------

  async documents(p: Principal, kbId: string, opts: { q?: string; limit?: number; media?: 'image'; labels?: LabelFilter } = {}) {
    const kb = await this.base(p, kbId);
    const q = this.db('knowledge_documents').where({ kb_id: kb.id }).whereIn('label', labelsUpTo(p.clearance));
    if (opts.q) q.andWhere('name', 'like', `%${opts.q.replace(/[%_\\]/g, (c) => '\\' + c)}%`);
    if (opts.media) q.andWhere({ media: opts.media });
    // B-8804: the label filter chips: image documents carrying the labels.
    if (opts.labels && (opts.labels.any?.length || opts.labels.all?.length)) {
      const ids = await this.docsWithLabels([kb.id], opts.labels, labelRank(p.clearance));
      q.whereIn('id', ids.size ? [...ids] : ['']);
    }
    let rows = ((await q.orderBy('updated_at', 'desc').limit(Math.min(opts.limit ?? 200, 1000))) as Record<string, unknown>[]).map(docFrom);
    if (!this.canCurate(p) && rows.some((d) => d.acl)) {
      const reader = await readerEntries(this.db, p);
      rows = rows.filter((d) => aclAllows(d.acl, reader));
    }
    const sources = new Map((await this.sources(kb.id)).map((s) => [s.id, s]));
    const labels = await this.labelsOf(rows.filter((d) => d.media === 'image').map((d) => d.id));
    return rows.map((d) => docView(d, sources.get(d.source_id), d.media === 'image' ? (labels.get(d.id) ?? []) : undefined));
  }

  // ---------- image labels (B-8802, B-8803) ----------

  /** The labels of image documents, by document: hits first, then by score. */
  async labelsOf(docIds: string[]): Promise<Map<string, DocLabel[]>> {
    const out = new Map<string, DocLabel[]>();
    if (!docIds.length) return out;
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < docIds.length; i += 500) rows.push(...((await this.db('knowledge_doc_labels').whereIn('document_id', docIds.slice(i, i + 500))) as Record<string, unknown>[]));
    const names = new Map(((await this.db('classifiers').whereIn('id', [...new Set(rows.map((r) => String(r.classifier_id)))].concat([''])).select('id', 'name')) as { id: string; name: string }[]).map((c) => [c.id, c.name]));
    for (const r of rows) {
      const list = out.get(String(r.document_id)) ?? [];
      list.push({ label: String(r.label), score: Math.round(Number(r.score) * 1000) / 1000, hit: !!r.hit, classifierId: String(r.classifier_id), classifier: names.get(String(r.classifier_id)) ?? String(r.classifier_id), version: Number(r.classifier_version) });
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

  /** Uploads go to sealed quarantine; a scan job checks type, malware and classification before indexing. */
  async upload(p: Principal, kbId: string, input: { name: string; label: Label; data: Buffer }): Promise<DocRow> {
    const kb = await this.base(p, kbId, 'manage');
    if (!clears(p.clearance, input.label)) throw forbidden('Above your clearance.', { step: 'clearance' });
    if (input.data.length > this.o.maxBytes) throw new HttpProblem(413, 'Payload too large', 'The file is larger than the upload limit.');
    let source = (await this.sources(kb.id)).find((s) => s.kind === 'upload');
    if (!source) source = await this.addSource(p, kb.id, { kind: 'upload', location: 'Uploads' });
    const t = Date.now();
    const id = ulid();
    const blobKey = await this.store({ id, tenant_id: p.tenantId }, input.data, 'knowledge-quarantine');
    const label = highest(source.label_floor, input.label);
    // Each upload is its own document, even with a name seen before.
    await this.db('knowledge_documents').insert({ id, tenant_id: p.tenantId, kb_id: kb.id, source_id: source.id, external_key: sha(`upload:${id}`), name: input.name.slice(0, 300), type: null, size: input.data.length, sha256: sha(input.data), version: null, label, auto_label: null, manual_label: labelRank(input.label) > labelRank(source.label_floor) ? input.label : null, label_origin: 'pending', detections: null, state: 'quarantined', blob_key: blobKey, chunks: 0, created_at: t, updated_at: t });
    await this.d.jobs.enqueue({ tenantId: p.tenantId, type: 'knowledge.scan', payload: { documentId: id }, createdBy: p.userId, maxAttempts: 2 });
    return this.document(p.tenantId, id);
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

  private async scanJob(documentId: string): Promise<unknown> {
    const r = await this.db('knowledge_documents').where({ id: documentId }).first();
    if (!r) return { skipped: 'gone' };
    const doc = docFrom(r);
    if (doc.state !== 'quarantined' && doc.state !== 'scanning') return { skipped: doc.state };
    await this.db('knowledge_documents').where({ id: doc.id }).update({ state: 'scanning' });
    const reject = async (reason: string) => {
      if (doc.blob_key) await this.d.blobs.delete(doc.blob_key);
      await this.db('knowledge_documents').where({ id: doc.id }).update({ state: 'rejected', error: reason.slice(0, 500), trace_id: traceId(), blob_key: null, label_origin: 'rejected', updated_at: Date.now() });
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
    await this.d.jobs.enqueue({ tenantId: doc.tenant_id, type: 'knowledge.index', payload: { documentId: doc.id }, maxAttempts: 2 });
    return { state: 'queued', type: type.type };
  }

  private async indexJob(documentId: string, ctx: JobContext): Promise<unknown> {
    const r = await this.db('knowledge_documents').where({ id: documentId }).first();
    if (!r) return { skipped: 'gone' };
    const doc = docFrom(r);
    if (['quarantined', 'scanning', 'rejected', 'removed', 'hidden'].includes(doc.state)) return { skipped: doc.state };
    const targets = await this.liveIndexes(doc.kb_id);
    await ctx.progress(10, `Extracting ${doc.name}`);
    return this.indexInto(doc, targets);
  }

  /**
   * Extracts, classifies, chunks and embeds one document into the given indexes. Extraction problems leave the
   * document `failed` with the reason and a trace id, out of retrieval; other errors propagate so the job retries.
   */
  async indexInto(doc: DocRow, targets: IndexRow[]): Promise<{ state: DocState; chunks: number; label?: Label; error?: string }> {
    const kb = await this.kbRow(doc.kb_id);
    const src = await this.source(doc.tenant_id, doc.source_id);
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
        described = await this.describe(doc, kb, data, before);
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
    for (const idx of targets) await this.writeChunks(idx, doc, chunks, label);
    const vision = described ? await this.d.keys.seal(doc.tenant_id, JSON.stringify(described), `kdoc-vision:${doc.id}`) : null;
    await this.db('knowledge_documents').where({ id: doc.id }).update({ state: 'indexed', type, label, auto_label: auto, label_origin: origin, detections: JSON.stringify(c.detections), error: null, trace_id: null, chunks: chunks.length, indexed_at: Date.now(), updated_at: Date.now(), ...(described ? { media: 'image', vision, safety_score: safetyScore } : {}) });
    await this.db('knowledge_doc_labels').where({ document_id: doc.id }).update({ label_rank: labelRank(label) });
    // B-8802: the base's vision classifiers label the image in the background.
    if (described && kb.image_classifiers.length) await this.d.jobs.enqueue({ tenantId: doc.tenant_id, type: 'knowledge.classify', payload: { documentId: doc.id }, maxAttempts: 2 });
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
    if (doc.blob_key) await this.d.blobs.delete(doc.blob_key);
    await this.db('knowledge_documents').where({ id: doc.id }).update({ state: 'rejected', type, media: 'image', error: reason, trace_id: traceId(), blob_key: null, vision: null, chunks: 0, safety_score: verdict?.score ?? null, label_origin: 'rejected', updated_at: Date.now() });
    await this.d.audit.append({ tenantId: doc.tenant_id, action: 'knowledge.image.withheld', kind: 'system', actor: { service: 'knowledge' }, target: { kb: doc.kb_id, document: doc.id }, label, detail: verdict ? { score: verdict.score, classifier: verdict.classifier, categories: verdict.categories } : { reason: 'not classified', required: true } });
    return { rejected: { state: 'rejected', chunks: 0, label, error: reason } };
  }

  /** B-8801: the vision profile's caption and the text it reads in the image, validated, metered as indexing. */
  private async describe(doc: DocRow, kb: KbRow, data: Buffer, label: Label): Promise<ImageDescription & { model: string }> {
    if (!kb.vision_profile) throw new ExtractionError('This knowledge base has no vision profile, so its images cannot be described. Name one in the knowledge base settings, then retry.');
    let out;
    try {
      out = await complete(this.d.gateway, doc.tenant_id, kb.vision_profile, label, [{ role: 'system', content: DESCRIBE_PROMPT }, { role: 'user', content: 'Describe this image and read its text.', images: [data.toString('base64')] }], VISION_TIMEOUT_MS, 'vision');
    } catch (err) {
      throw new ExtractionError(`The vision profile ${kb.vision_profile} could not describe the image: ${err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message}`);
    }
    await this.d.quotas.record({ tenantId: doc.tenant_id, workspaceId: kb.workspace_id, userId: null, kind: 'embed', model: out.model, profileId: out.profileId, poolId: out.poolId, promptTokens: out.promptTokens, outputTokens: out.outputTokens });
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
      await this.db('knowledge_documents').insert({ id, tenant_id: doc.tenant_id, kb_id: doc.kb_id, source_id: doc.source_id, external_key: key, name: `${doc.name}, image ${i + 1}`.slice(0, 300), type: null, size: part.data.length, sha256: hash, version: null, label, auto_label: null, manual_label: null, label_origin: 'inherited from the document', detections: null, state: 'quarantined', blob_key: blobKey, chunks: 0, created_at: t, updated_at: t, acl: doc.acl == null ? null : JSON.stringify(doc.acl), parent_id: doc.id, media: 'image' });
      await this.d.jobs.enqueue({ tenantId: doc.tenant_id, type: 'knowledge.scan', payload: { documentId: id }, maxAttempts: 2 });
    }
    for (const [key, d] of existing) if (!keep.has(key)) await this.purgeDocument(d);
  }

  // ---------- image classification (B-8802) ----------

  /** The published vision classifiers a base names (optionally only one of them). */
  private async imageClassifiers(kb: KbRow, only: string | null): Promise<ClassifierRow[]> {
    const out: ClassifierRow[] = [];
    if (!this.d.classifiers) return out;
    for (const id of kb.image_classifiers) {
      if (only && id !== only) continue;
      const c = await this.d.classifiers.get(kb.tenant_id, id);
      if (c && c.engine === 'vision' && c.status === 'published') out.push(c);
    }
    return out;
  }

  /**
   * Scores one image document with the base's vision classifiers and stores the labels as tags on it, with their
   * scores and the classifier's version. Without `force`, a classifier whose current version already labelled the
   * document is skipped (a reclassify after a new version touches only what is stale).
   */
  private async classifyDocument(doc: DocRow, kb: KbRow, only: string | null, force: boolean): Promise<number> {
    const list = await this.imageClassifiers(kb, only);
    if (!list.length) return 0;
    let data: Buffer | null = null;
    let n = 0;
    for (const c of list) {
      const have = (await this.db('knowledge_doc_labels').where({ document_id: doc.id, classifier_id: c.id }).first('classifier_version')) as { classifier_version?: number } | undefined;
      if (have && Number(have.classifier_version) === c.version && !force) continue;
      data ??= await this.content(doc);
      const r = await this.d.classifiers!.scoreImage(doc.tenant_id, c, data, doc.label, VISION_TIMEOUT_MS);
      if (r.usage) await this.d.quotas.record({ tenantId: doc.tenant_id, workspaceId: kb.workspace_id, userId: null, kind: 'embed', model: r.usage.model, profileId: r.usage.profileId, poolId: r.usage.poolId, promptTokens: r.usage.promptTokens, outputTokens: r.usage.outputTokens });
      const t = Date.now();
      const rank = labelRank(doc.label);
      await this.db.transaction(async (trx) => {
        await trx('knowledge_doc_labels').where({ document_id: doc.id, classifier_id: c.id }).delete();
        await trx('knowledge_doc_labels').insert(c.config.labels.map((l) => ({ id: ulid(), tenant_id: doc.tenant_id, kb_id: doc.kb_id, document_id: doc.id, classifier_id: c.id, classifier_version: c.version, label: l.label, score: r.scores[l.label] ?? 0, hit: r.hits.includes(l.label), label_rank: rank, created_at: t })));
      });
      n++;
    }
    return n;
  }

  private async classifyJob(documentId: string, only: string | null): Promise<unknown> {
    const r = await this.db('knowledge_documents').where({ id: documentId }).first();
    if (!r) return { skipped: 'gone' };
    const doc = docFrom(r);
    if (doc.media !== 'image' || !['indexed', 'unchanged'].includes(doc.state)) return { skipped: doc.state };
    return { classified: await this.classifyDocument(doc, await this.kbRow(doc.kb_id), only, true) };
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
        if (await this.classifyDocument(d, kb, only, force)) classified++;
      } catch (err) {
        failed++;
        ctx.log.warn({ err: (err as Error).message, document: d.id }, 'classifying an image failed');
      }
      await ctx.progress(((i + 1) / docs.length) * 100, `Classified ${i + 1} of ${docs.length} images`);
    }
    await this.d.audit.append({ tenantId: kb.tenant_id, action: 'knowledge.reclassified', kind: 'system', actor: { service: 'knowledge' }, target: { kb: kb.id, ...(only ? { classifier: only } : {}) }, label: kb.label, detail: { images: docs.length, classified, failed, force } });
    return { images: docs.length, classified, failed };
  }

  /** B-8802: a published classifier has a new version: every base naming it labels its images again. */
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

  private async writeChunks(idx: IndexRow, doc: DocRow, chunks: TextChunk[], label: Label): Promise<void> {
    await this.removeFromIndex(idx.id, doc.id);
    if (!chunks.length) return;
    const vectors = await this.embed(doc.tenant_id, idx.embed_model, chunks.map((c) => (c.heading ? `${c.heading}\n\n${c.text}` : c.text)), label, null);
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

  /** Embeddings through the gateway, cached per tenant and model by a keyed hash of the text for 30 days. */
  async embed(tenantId: string, model: string, texts: string[], label: Label, userId: string | null, signal?: AbortSignal): Promise<number[][]> {
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
      await this.d.quotas.record({ tenantId, workspaceId: null, userId, kind: 'embed', model, poolId: r.poolId, promptTokens: r.promptTokens, gpuMs: r.gpuMs });
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
    for (const s of ((await this.db('knowledge_sources').where({ tenant_id: tenantId }).whereNot({ schedule: 'manual' }).whereNot({ kind: 'upload' })) as Record<string, unknown>[]).map(sourceFrom)) {
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

  private async runSync(s: SourceRow, ctx: JobContext): Promise<{ added: number; changed: number; unchanged: number; removed: number; watermark?: string | null; skipped?: number; skippedUrls?: { url: string; reason: string }[] }> {
    if (s.kind === 's3') {
      if (s.config.endpoint) {
        // B-1501: the source's own S3-compatible endpoint and keys, dialled through the knowledge host rules.
        if (!s.secret_sealed) throw new Error('The source has no keys; remove it and add it again.');
        const keys = json<{ accessKeyId: string; secretAccessKey: string }>(await this.d.keys.open(s.tenant_id, s.secret_sealed, `knowledge-source:${s.id}`), { accessKeyId: '', secretAccessKey: '' });
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
          previous: async (url) => {
            const d = prev.get(sha(url));
            return d && d.blob_key && d.state !== 'failed' ? { version: d.version, body: () => this.content(d) } : null;
          }
        });
        const applied = await this.apply(s, out.items, true, ctx);
        return { ...applied, skipped: out.skipped.length, skippedUrls: out.skipped.slice(0, 50), watermark: new Date().toISOString() };
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
  private async apply(s: SourceRow, items: SourceItem[], full: boolean, ctx: Pick<JobContext, 'signal' | 'progress'>, forceType?: string): Promise<{ added: number; changed: number; unchanged: number; removed: number }> {
    // A document's image parts (Sprint 36c) follow their document, not the listing.
    const existing = new Map(((await this.db('knowledge_documents').where({ source_id: s.id }).whereNull('parent_id')) as Record<string, unknown>[]).map(docFrom).map((d) => [d.external_key, d]));
    const seen = new Set<string>();
    let added = 0;
    let changed = 0;
    let unchanged = 0;
    let removed = 0;
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
      await this.indexInto(doc, await this.liveIndexes(s.kb_id));
      await ctx.progress(((i + 1) / Math.max(1, items.length)) * 100, `Synced ${i + 1} of ${items.length}`);
    }
    if (full) {
      for (const [key, d] of existing) {
        if (seen.has(key) || d.state === 'removed') continue;
        await this.purgeDocument(d);
        removed++;
      }
    }
    return { added, changed, unchanged, removed };
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
  async search(p: Principal, kbs: KbRow[], query: string, opts: { k?: number; ceiling?: Label; queryLabel?: Label; rerank?: boolean; withText?: boolean; signal?: AbortSignal; lenient?: boolean; labels?: LabelFilter } = {}): Promise<{ hits: SearchHit[]; ceiling: Label; vectorSkipped: string | null }> {
    const ceiling = opts.ceiling && labelRank(opts.ceiling) < labelRank(p.clearance) ? opts.ceiling : p.clearance;
    const maxRank = labelRank(ceiling);
    const k = opts.k ?? 8;
    // B-8803: a label filter keeps only the chunks of image documents carrying the labels, inside the ranking.
    let allowed: Set<string> | null = null;
    if (opts.labels && (opts.labels.any?.length || opts.labels.all?.length)) {
      const docIds = [...(await this.docsWithLabels(kbs.map((x) => x.id), opts.labels, maxRank))];
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
        const [vec] = await this.embed(p.tenantId, idx.embed_model, [query], opts.queryLabel ?? 'internal', p.userId, opts.signal);
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
