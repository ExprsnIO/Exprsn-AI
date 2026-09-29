import { createHash, randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import type { Logger } from 'pino';
import { json, type Db } from '../db/knex.js';
import { clears, highest, LABELS, labelRank, type Label } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import type { AuditLog } from '../audit/chain.js';
import { clamScan, classify } from '../chat/attachments.js';
import type { ContextItem, ContextRequest } from '../chat/context.js';
import type { ConnectionService } from '../connections/service.js';
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
import { detectType, ExtractionError, extractText } from './extract.js';
import { gitItems, parseS3, S3Reader, type GitFetcher, type S3Settings, type SourceItem } from './sources.js';
import { bm25, rrf, termCounts, TermKeys, tokenize } from './terms.js';

export const SOURCE_KINDS = ['upload', 's3', 'git', 'database'] as const;
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
  config: { bucket?: string; prefix?: string; url?: string; ref?: string | null; path?: string; connectionId?: string; object?: string; idColumn?: string | null; watermarkColumn?: string | null };
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

export type DocState = 'quarantined' | 'scanning' | 'queued' | 'indexing' | 'indexed' | 'unchanged' | 'failed' | 'rejected' | 'removed';

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
}

export interface KnowledgeOptions {
  maxBytes: number;
  clamd?: { host: string; port: number };
  s3?: S3Settings;
  git: GitFetcher;
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
}

const num = (v: unknown) => (v == null ? null : Number(v));
const kbFrom = (r: Record<string, unknown>): KbRow => ({ ...(r as unknown as KbRow), chunking: json<ChunkOptions>(r.chunking, DEFAULT_CHUNKING), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
const indexFrom = (r: Record<string, unknown>): IndexRow => ({ ...(r as unknown as IndexRow), version: Number(r.version), dims: num(r.dims), progress: Number(r.progress), chunks: Number(r.chunks), created_at: Number(r.created_at), built_at: num(r.built_at) });
const sourceFrom = (r: Record<string, unknown>): SourceRow => ({ ...(r as unknown as SourceRow), config: json<SourceRow['config']>(r.config, {}), last_sync_at: num(r.last_sync_at), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
const docFrom = (r: Record<string, unknown>): DocRow => ({ ...(r as unknown as DocRow), size: Number(r.size), chunks: Number(r.chunks), detections: json<Record<string, number> | null>(r.detections, null), created_at: Number(r.created_at), updated_at: Number(r.updated_at), indexed_at: num(r.indexed_at) });
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

export const docView = (d: DocRow, source?: SourceRow) => ({
  id: d.id,
  name: d.name,
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
  createdAt: d.created_at,
  updatedAt: d.updated_at,
  indexedAt: d.indexed_at
});

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
  private readonly db: Db;

  constructor(
    private readonly d: KnowledgeDeps,
    private readonly o: KnowledgeOptions
  ) {
    this.db = d.db;
    this.terms = new TermKeys(d.db, d.keys);
    d.jobs.register('knowledge.scan', (p) => this.scanJob(String(p.documentId)), { timeoutMs: 10 * 60_000 });
    d.jobs.register('knowledge.index', (p, ctx) => this.indexJob(String(p.documentId), ctx), { timeoutMs: 30 * 60_000 });
    d.jobs.register('knowledge.sync', (p, ctx) => this.syncJob(String(p.sourceId), ctx), { timeoutMs: 2 * 60 * 60_000 });
    d.jobs.register('knowledge.reindex', (p, ctx) => this.reindexJob(String(p.indexId), ctx), { timeoutMs: 12 * 60 * 60_000 });
    d.jobs.register('knowledge.sync-due', (p, ctx) => this.syncDue(String(p.tenantId ?? ctx.job.tenant_id)));
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

  async update(p: Principal, id: string, patch: { name?: string; description?: string | null; label?: Label; reranker?: string | null; sharing?: 'members' | 'curators'; status?: 'draft' | 'published'; chunking?: ChunkOptions }): Promise<KbRow> {
    const kb = await this.base(p, id, 'manage');
    if (patch.label && !clears(p.clearance, patch.label)) throw forbidden(`Your clearance is ${p.clearance}.`, { step: 'clearance' });
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
    await this.db('knowledge_bases').where({ id: kb.id }).update(upd);
    // A higher floor applies to documents already indexed: their chunks take it at once.
    if (patch.label && labelRank(patch.label) > labelRank(kb.label)) {
      for (const d of ((await this.db('knowledge_documents').where({ kb_id: kb.id })) as Record<string, unknown>[]).map(docFrom)) {
        if (labelRank(d.label) < labelRank(patch.label)) await this.applyLabel(d, patch.label, d.label_origin);
      }
    }
    return this.kbRow(kb.id);
  }

  async remove(p: Principal, id: string): Promise<{ documents: number }> {
    const kb = await this.base(p, id, 'manage');
    const docs = ((await this.db('knowledge_documents').where({ kb_id: kb.id })) as Record<string, unknown>[]).map(docFrom);
    for (const i of await this.indexes(kb.id)) await this.d.vectors.drop(i.id);
    for (const d of docs) if (d.blob_key) await this.d.blobs.delete(d.blob_key);
    await this.db('knowledge_terms').whereIn('index_id', this.db('knowledge_indexes').where({ kb_id: kb.id }).select('id')).delete();
    await this.db('knowledge_chunks').where({ kb_id: kb.id }).delete();
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

  async addSource(p: Principal, kbId: string, input: { kind: SourceKind; location: string; labelFloor?: Label; schedule?: Schedule; ref?: string | null; path?: string; connectionId?: string; idColumn?: string | null; watermarkColumn?: string | null }): Promise<SourceRow> {
    const kb = await this.base(p, kbId, 'manage');
    const floor = highest(kb.label, input.labelFloor ?? kb.label);
    if (!clears(p.clearance, floor)) throw forbidden(`Your clearance is ${p.clearance}.`, { step: 'clearance' });
    let location = input.location.trim();
    let config: SourceRow['config'] = {};
    if (input.kind === 'upload') {
      const existing = (await this.sources(kb.id)).find((s) => s.kind === 'upload');
      if (existing) throw conflict('This knowledge base already has an upload source; upload files to it.');
      location = 'Uploads';
    } else if (input.kind === 's3') {
      const s3 = parseS3(location);
      if (!s3) throw new HttpProblem(400, 'Invalid request', 'Give the S3 location as s3://bucket/prefix/.');
      if (!this.o.s3) throw conflict('S3 is not configured on this platform (S3_ENDPOINT and its credentials). Credentials come from the platform, never from this form.');
      config = { bucket: s3.bucket, prefix: s3.prefix };
    } else if (input.kind === 'git') {
      location = location.replace(/^git:\s*/i, '');
      config = { url: location, ref: input.ref ?? null, path: input.path ?? '' };
    } else {
      if (!input.connectionId) throw new HttpProblem(400, 'Invalid request', 'Pick the data connection the view is read through.');
      const conn = await this.d.connections.get(p.tenantId, input.connectionId);
      if (conn.engine !== 'postgres') throw conflict('Only PostgreSQL tables and views can be a knowledge source.');
      const object = location.replace(/^pg:\s*/i, '');
      const schema = (conn.schema ?? []).find((o) => o.name.toLowerCase() === object.toLowerCase() || o.name.toLowerCase() === `public.${object.toLowerCase()}`);
      if (!schema) throw conflict(`${object} is not in ${conn.name}'s introspected schema. Refresh the schema on the Connections screen.`);
      if (!conn.allow_list.map((x) => x.toLowerCase()).includes(schema.name.toLowerCase())) throw conflict(`${schema.name} is not on ${conn.name}'s schema allow-list.`);
      const cols = schema.columns.map((c) => c.name);
      const wm = input.watermarkColumn ?? (cols.includes('updated_at') ? 'updated_at' : null);
      if (wm && !cols.includes(wm)) throw conflict(`${schema.name} has no column ${wm}.`);
      const idCol = input.idColumn ?? (cols.includes('id') ? 'id' : (cols[0] ?? null));
      if (idCol && !cols.includes(idCol)) throw conflict(`${schema.name} has no column ${idCol}.`);
      location = `pg: ${schema.name}`;
      config = { connectionId: conn.id, object: schema.name, idColumn: idCol, watermarkColumn: wm };
      // Rows are read at the connection's label: the source floor is at least that.
      if (labelRank(conn.label) > labelRank(floor)) input = { ...input, labelFloor: conn.label };
    }
    const t = Date.now();
    const id = ulid();
    await this.db('knowledge_sources').insert({ id, tenant_id: p.tenantId, kb_id: kb.id, kind: input.kind, location, config: JSON.stringify(config), label_floor: highest(floor, input.labelFloor ?? floor), schedule: input.kind === 'upload' ? 'manual' : (input.schedule ?? '15m'), state: 'idle', created_by: p.userId, created_at: t, updated_at: t });
    const s = await this.source(p.tenantId, id);
    if (s.kind !== 'upload') await this.sync(p.userId, s);
    return this.source(p.tenantId, id);
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
    for (const d of docs) await this.purgeDocument(d);
    await this.db('knowledge_sources').where({ id: s.id }).delete();
    return { documents: docs.length };
  }

  // ---------- documents ----------

  async documents(p: Principal, kbId: string, opts: { q?: string; limit?: number } = {}) {
    const kb = await this.base(p, kbId);
    const q = this.db('knowledge_documents').where({ kb_id: kb.id }).whereIn('label', labelsUpTo(p.clearance));
    if (opts.q) q.andWhere('name', 'like', `%${opts.q.replace(/[%_\\]/g, (c) => '\\' + c)}%`);
    const rows = ((await q.orderBy('updated_at', 'desc').limit(Math.min(opts.limit ?? 200, 1000))) as Record<string, unknown>[]).map(docFrom);
    const sources = new Map((await this.sources(kb.id)).map((s) => [s.id, s]));
    return rows.map((d) => docView(d, sources.get(d.source_id)));
  }

  /** A document the principal may see (its label at or below their clearance). */
  async documentFor(p: Principal, id: string, need: 'read' | 'manage' = 'read'): Promise<{ doc: DocRow; kb: KbRow }> {
    const doc = await this.document(p.tenantId, id);
    const kb = await this.base(p, doc.kb_id, need);
    if (!clears(p.clearance, doc.label)) throw notFound('Document');
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
    const floor = highest(kb.label, src.label_floor, doc.auto_label ?? 'public');
    if (labelRank(label) < labelRank(floor)) {
      const found = findingsFor(doc.detections, doc.auto_label ?? 'public').join(', ');
      if (doc.auto_label && labelRank(label) < labelRank(doc.auto_label)) throw conflict(`The auto-classifier found ${found || 'personal data'}, so the label cannot go below ${doc.auto_label}.`);
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
    const chunks = (await this.db('knowledge_chunks').where({ document_id: doc.id }).select('id', 'index_id')) as { id: string; index_id: string }[];
    await this.db('knowledge_chunks').where({ document_id: doc.id }).update({ label, label_rank: rank });
    for (let i = 0; i < chunks.length; i += 500) await this.db('knowledge_terms').whereIn('chunk_id', chunks.slice(i, i + 500).map((c) => c.id)).update({ label_rank: rank });
    // Vectors carry the rank too: rewrite them from the embedding cache.
    if (chunks.length) await this.d.jobs.enqueue({ tenantId: doc.tenant_id, type: 'knowledge.index', payload: { documentId: doc.id }, maxAttempts: 3 });
  }

  async reindexDocument(p: Principal, id: string): Promise<{ jobId: string }> {
    const { doc } = await this.documentFor(p, id, 'manage');
    if (['quarantined', 'scanning', 'rejected', 'removed'].includes(doc.state)) throw conflict(`${doc.name} is ${doc.state} and cannot be indexed.`);
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
    for (const idx of await this.indexes(doc.kb_id)) await this.removeFromIndex(idx.id, doc.id);
    if (doc.blob_key) await this.d.blobs.delete(doc.blob_key);
    if (keepTombstone) await this.db('knowledge_documents').where({ id: doc.id }).update({ state: 'removed', blob_key: null, chunks: 0, updated_at: Date.now() });
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
    if (['quarantined', 'scanning', 'rejected', 'removed'].includes(doc.state)) return { skipped: doc.state };
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
    let text: string;
    let type = doc.type;
    try {
      const data = await this.content(doc);
      if (!type) {
        const t = detectType(data, doc.name);
        if ('rejected' in t) throw new ExtractionError(t.rejected);
        type = t.type;
      }
      text = extractText(data, type);
    } catch (err) {
      if (!(err instanceof ExtractionError)) throw err;
      for (const idx of targets) await this.removeFromIndex(idx.id, doc.id);
      await this.db('knowledge_documents').where({ id: doc.id }).update({ state: 'failed', type, error: err.message.slice(0, 500), trace_id: traceId(), chunks: 0, updated_at: Date.now() });
      return { state: 'failed', chunks: 0, error: err.message };
    }
    const c = classify(text);
    const auto: Label = c.label;
    const label = highest(kb.label, src.label_floor, auto, doc.manual_label ?? 'public');
    const origin = doc.manual_label && labelRank(doc.manual_label) >= labelRank(label) ? 'manual' : labelRank(auto) >= labelRank(label) && auto !== 'public' ? `auto-classifier, ${findingsFor(c.detections, auto).join(', ')}` : 'inherited';
    if (kb.workspace_id) {
      const ws = (await this.db('workspaces').where({ id: kb.workspace_id }).first('label_ceiling')) as { label_ceiling: Label } | undefined;
      if (ws && labelRank(label) > labelRank(ws.label_ceiling)) {
        for (const idx of targets) await this.removeFromIndex(idx.id, doc.id);
        await this.db('knowledge_documents').where({ id: doc.id }).update({ state: 'rejected', label, auto_label: auto, detections: JSON.stringify(c.detections), error: `Classified ${label}, above the workspace ceiling of ${ws.label_ceiling}.`, trace_id: traceId(), chunks: 0, updated_at: Date.now() });
        return { state: 'rejected', chunks: 0, label };
      }
    }
    const chunks = chunkText(text, kb.chunking);
    for (const idx of targets) await this.writeChunks(idx, doc, chunks, label);
    await this.db('knowledge_documents').where({ id: doc.id }).update({ state: 'indexed', type, label, auto_label: auto, label_origin: origin, detections: JSON.stringify(c.detections), error: null, trace_id: null, chunks: chunks.length, indexed_at: Date.now(), updated_at: Date.now() });
    return { state: 'indexed', chunks: chunks.length, label };
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
      rows.push({ id, tenant_id: doc.tenant_id, kb_id: doc.kb_id, index_id: idx.id, document_id: doc.id, seq: i, content: await this.sealChunk(doc.tenant_id, id, { text: c.text, heading: c.heading }), label, label_rank: rank, tokens: 0, created_at: t });
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

  private async runSync(s: SourceRow, ctx: JobContext): Promise<{ added: number; changed: number; unchanged: number; removed: number; watermark?: string | null }> {
    if (s.kind === 's3') {
      if (!this.o.s3) throw new Error('S3 is not configured on this platform.');
      const listing = await new S3Reader(this.o.s3).list(s.config.bucket!, s.config.prefix ?? '', this.o.maxBytes, ctx.signal);
      return { ...(await this.apply(s, listing.items, true, ctx)), watermark: listing.newest ?? s.watermark };
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
    if (s.kind === 'database') {
      const cfg = s.config;
      const r = await this.d.connections.readRows(s.tenant_id, cfg.connectionId!, cfg.object!, { watermarkColumn: cfg.watermarkColumn ?? null, after: cfg.watermarkColumn ? s.watermark : null, limit: 5000 });
      const idAt = cfg.idColumn ? r.columns.indexOf(cfg.idColumn) : -1;
      const wmAt = cfg.watermarkColumn ? r.columns.indexOf(cfg.watermarkColumn) : -1;
      let watermark = s.watermark;
      const items: SourceItem[] = r.rows.map((row, i) => {
        const id = idAt >= 0 ? String(row[idAt]) : String(i + 1);
        const body = `# ${cfg.object} ${id}\n\n` + r.columns.map((col, j) => `${col}: ${row[j] == null ? '' : String(row[j])}`).join('\n');
        if (wmAt >= 0 && row[wmAt] != null) {
          const v = row[wmAt] instanceof Date ? (row[wmAt] as Date).toISOString() : String(row[wmAt]);
          if (!watermark || v > watermark) watermark = v;
        }
        const data = Buffer.from(body, 'utf8');
        return { key: `${cfg.object}#${id}`, name: `${cfg.object} #${id}`, version: sha(data), size: data.length, read: async () => data };
      });
      // With a watermark only changed rows arrive, so absence means nothing; without one, it means the row is gone.
      const out = await this.apply(s, items, !cfg.watermarkColumn, ctx, 'text/plain');
      return { ...out, watermark: cfg.watermarkColumn ? watermark : null };
    }
    throw new Error('Uploads have no sync.');
  }

  /**
   * Applies a listing to the source's documents: new keys become documents, changed versions or content are
   * re-indexed, unchanged ones are skipped by version or content hash, and (for full listings) keys no longer
   * present are removed. Removed tombstones stay removed.
   */
  private async apply(s: SourceRow, items: SourceItem[], full: boolean, ctx: JobContext, forceType?: string): Promise<{ added: number; changed: number; unchanged: number; removed: number }> {
    const existing = new Map(((await this.db('knowledge_documents').where({ source_id: s.id })) as Record<string, unknown>[]).map(docFrom).map((d) => [d.external_key, d]));
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
        unchanged++;
        continue;
      }
      const type = forceType ?? (() => {
        const t = detectType(data, it.name);
        return 'type' in t ? t.type : null;
      })();
      const t = Date.now();
      let doc: DocRow;
      if (prev) {
        const blobKey = await this.store(prev, data);
        await this.db('knowledge_documents').where({ id: prev.id }).update({ name: it.name.slice(0, 300), size: data.length, sha256: hash, version: it.version, type, blob_key: blobKey, state: 'queued', updated_at: t });
        doc = await this.document(s.tenant_id, prev.id);
        changed++;
      } else {
        const id = ulid();
        const blobKey = await this.store({ id, tenant_id: s.tenant_id }, data);
        await this.db('knowledge_documents').insert({ id, tenant_id: s.tenant_id, kb_id: s.kb_id, source_id: s.id, external_key: key, name: it.name.slice(0, 300), type, size: data.length, sha256: hash, version: it.version, label: highest(kb.label, s.label_floor), auto_label: null, manual_label: null, label_origin: 'inherited', detections: null, state: 'queued', blob_key: blobKey, chunks: 0, created_at: t, updated_at: t });
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

  // ---------- search ----------

  /**
   * Hybrid search over the serving indexes of the given bases. The label filter (`ceiling`) is part of every query:
   * vectors, keyword terms and chunk rows above it are never read, ranked or counted.
   */
  async search(p: Principal, kbs: KbRow[], query: string, opts: { k?: number; ceiling?: Label; queryLabel?: Label; rerank?: boolean; withText?: boolean; signal?: AbortSignal; lenient?: boolean } = {}): Promise<{ hits: SearchHit[]; ceiling: Label; vectorSkipped: string | null }> {
    const ceiling = opts.ceiling && labelRank(opts.ceiling) < labelRank(p.clearance) ? opts.ceiling : p.clearance;
    const maxRank = labelRank(ceiling);
    const k = opts.k ?? 8;
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
        for (const h of await this.d.vectors.search(idx.id, { tenantId: p.tenantId, vector: vec!, k: 40, maxLabelRank: maxRank })) vectorList.push(h);
      } catch (err) {
        if (!opts.lenient) throw err;
        vectorSkipped = (err as Error).message;
      }
      // Keyword ranking (BM25 over keyed-hash terms).
      if (words.length) {
        const hashed = await this.terms.terms(p.tenantId, words);
        const rows = (await this.db('knowledge_terms').where({ index_id: idx.id }).whereIn('term', [...hashed.values()]).andWhere('label_rank', '<=', maxRank).select('chunk_id', 'term', 'tf')) as { chunk_id: string; term: string; tf: number }[];
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
      const opened = await this.openChunk(c.tenant_id, c.id, c.content);
      const src = d ? srcs.get(d.source_id) : undefined;
      hits.push({ chunkId: c.id, kbId: c.kb_id, kb: kbById.get(c.kb_id)?.name ?? '', documentId: c.document_id, document: d?.name ?? '', source: src ? (src.kind === 'upload' ? 'Uploads' : src.location) : '', heading: opened.heading, label: c.label, vector: vScore.has(id) ? Number(vScore.get(id)!.toFixed(4)) : null, keyword: kScore.has(id) ? Number(kScore.get(id)!.toFixed(4)) : null, fused: Number(score.toFixed(5)), rerank: null, text: opened.text });
    }
    if (reranking) hits = await this.rerank(p, hits, query, kbs, opts.queryLabel ?? 'internal', opts.signal);
    hits = hits.slice(0, k);
    // The context checkpoint: each retrieved chunk before anyone sees it.
    for (const h of hits) {
      const g = await this.d.guard.check({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, checkpoint: 'context', text: h.text ?? '', label: h.label, principal: p, source: { kind: 'chunk', id: h.chunkId }, meta: { kb: h.kbId, document: h.documentId } });
      if (g.action === 'block' || g.action === 'require-approval') {
        h.withheld = g.reason ?? 'Withheld by a guardrail rule.';
        delete h.text;
      } else if (g.action === 'redact') h.text = g.text;
    }
    if (!opts.withText) for (const h of hits) delete h.text;
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
    const ids = new Set([...(await this.bindings(req.conversationId)), ...((await this.db('knowledge_access').where({ tenant_id: req.tenantId, principal_kind: 'profile', principal_id: req.profile.id }).select('kb_id')) as { kb_id: string }[]).map((r) => r.kb_id)]);
    if (!ids.size || !req.query.trim()) return [];
    const kbs = (await this.visible(req.principal)).map((x) => x.kb).filter((kb) => ids.has(kb.id) && kb.status === 'published');
    if (!kbs.length) return [];
    const { hits } = await this.search(req.principal, kbs, req.query, { k: 6, ceiling: req.ceiling, queryLabel: req.label, rerank: true, withText: true, lenient: true });
    return hits
      .filter((h) => !h.withheld && h.text)
      .map((h) => ({ tag: 'context' as const, label: h.label, attrs: { source: `${h.kb}: ${h.document}`, ...(h.heading ? { section: h.heading } : {}) }, text: h.text!, cite: { kbId: h.kbId, kb: h.kb, documentId: h.documentId, document: h.document, chunkId: h.chunkId, section: h.heading, score: h.rerank ?? h.fused } }));
  }

  /** Deletes everything a tenant holds in knowledge (offboarding): vectors by tenant, then blobs. */
  async purgeTenant(tenantId: string): Promise<void> {
    await this.d.vectors.purgeTenant(tenantId);
    this.terms.forget(tenantId);
  }
}
