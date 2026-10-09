import { ulid } from 'ulid';
import type { Logger } from 'pino';
import { json, type Db } from '../db/knex.js';
import { clears, highest, LABELS, labelRank, type Label } from '../authz/labels.js';
import type { HoldLookup } from '../compliance/holds.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { actorFrom, type AuditLog } from '../audit/chain.js';
import { csvLine } from '../audit/exports.js';
import type { AnswerEvent, ContextItem, ContextRequest } from '../chat/context.js';
import type { Guardrails } from '../guardrails/types.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { BlobStore } from '../platform/blob.js';
import type { DataKeys } from '../platform/datakeys.js';
import type { JobContext, JobQueue } from '../platform/jobs.js';
import { cosine, type VectorStore } from '../platform/vectors.js';
import type { Gateway } from '../gateway/gateway.js';
import type { TermKeys } from '../knowledge/terms.js';
import { askProfile, consolidationMessages, consolidationSchema, extractionMessages, extractionSchema } from './model.js';

export type MemoryScope = 'user' | 'workspace' | 'agent';
export type MemoryState = 'proposed' | 'active' | 'superseded';
export const USER_TYPES = ['user', 'episodic'] as const;
export const WORKSPACE_TYPES = ['convention', 'glossary', 'contact'] as const;
/** What an agent may propose about its own work (Sprint 12): progress on a task, a quirk of a tool or source. */
export const AGENT_TYPES = ['progress', 'quirk'] as const;
const COLLECTION = 'memory';
export const EXTRACT_JOB = 'memory.extract';
export const CONSOLIDATE_JOB = 'memory.consolidate';
export const REINDEX_JOB = 'memory.reindex';
/** Types whose memories go stale: what happened once, and progress on a task. */
const STALE_TYPES = ['episodic', 'progress'];
/** Profile calls one consolidation run may make (pairs judged), and memories per owner it compares. */
const MAX_JUDGED = 50;
const MAX_PER_OWNER = 300;
/** How long after an accepted expiry proposal the memory is purged. */
const EXPIRY_GRACE_MS = 24 * 3_600_000;

/** One memory a merge proposal replaces: its id and the version it was proposed against, and where it came from. */
export interface MergeSource {
  memoryId: string;
  version: number;
  origin: string;
  source: unknown;
}

export interface ExpiryProposal {
  expiresAt: number;
  reason: 'stale' | 'contradicted';
  /** The memory that contradicts this one. */
  by: string | null;
  similarity: number | null;
  proposedAt: number;
}

/** The per-tenant memory settings (B-3701 to B-3703). */
export interface MemorySettings {
  profile: string | null;
  embedModel: string | null;
  /** The model memories are embedded with now: the setting, or the first approved embedding model by name. */
  effectiveEmbedModel: string | null;
  similarity: number;
  staleDays: number | null;
  reindex: { state: 'idle' | 'running' | 'done' | 'failed'; model: string | null; jobId: string | null; done: number; total: number; error: string | null; startedAt: number | null; finishedAt: number | null };
  updatedBy: string | null;
  updatedAt: number | null;
}

interface SettingsRow {
  profile: string | null;
  embed_model: string | null;
  similarity_pct: number;
  stale_days: number | null;
  reindex_state: MemorySettings['reindex']['state'];
  reindex_model: string | null;
  reindex_job_id: string | null;
  reindex_done: number;
  reindex_total: number;
  reindex_error: string | null;
  reindex_started_at: number | null;
  reindex_finished_at: number | null;
  updated_by: string | null;
  updated_at: number | null;
}

const DEFAULT_SETTINGS: SettingsRow = { profile: null, embed_model: null, similarity_pct: 85, stale_days: null, reindex_state: 'idle', reindex_model: null, reindex_job_id: null, reindex_done: 0, reindex_total: 0, reindex_error: null, reindex_started_at: null, reindex_finished_at: null, updated_by: null, updated_at: null };

/** What an agent run gives memory extraction (the agent service opens the run's sealed input and output). */
export type RunTexts = (tenantId: string, runId: string) => Promise<{ agent: string; label: Label; input: string; output: string | null; userId: string; workspaceId: string | null } | null>;

/** A run that finished under a memory policy allowing proposals (from the agent service). */
export interface RunMemoryEvent {
  tenantId: string;
  workspaceId: string | null;
  userId: string;
  runId: string;
  agent: string;
  label: Label;
  types: string[];
  /** Proposals the policy still allows for this run (after the ones made through the `remember` tool). */
  remaining: number;
}

export interface MemoryRow {
  id: string;
  tenant_id: string;
  scope: MemoryScope;
  owner_id: string;
  type: string;
  content: string;
  label: Label;
  source_label: Label;
  state: MemoryState;
  /** A chat turn, (for an agent's proposal) the run that proposed it, or (for a merge) the memories it replaces. */
  source: { conversationId: string; messageId: string } | { runId: string } | { merge: MergeSource[]; similarity: number; model: string } | null;
  origin: 'manual' | 'chat' | 'extraction' | 'agent' | 'consolidation';
  author_id: string | null;
  accepted_by: string | null;
  embed_model: string | null;
  expires_at: number | null;
  /** The merged memory that replaced this one (state `superseded`). */
  superseded_by: string | null;
  expiry_proposal: ExpiryProposal | null;
  version: number;
  created_at: number;
  updated_at: number;
}

const num = (v: unknown) => (v == null ? null : Number(v));
const fromRow = (r: Record<string, unknown>): MemoryRow => ({ ...(r as unknown as MemoryRow), source: json(r.source, null), expires_at: num(r.expires_at), superseded_by: (r.superseded_by as string | null | undefined) ?? null, expiry_proposal: json<ExpiryProposal | null>(r.expiry_proposal, null), version: Number(r.version), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
const labelsUpTo = (l: Label): Label[] => LABELS.filter((x) => labelRank(x) <= labelRank(l));
const partition = (m: Pick<MemoryRow, 'scope' | 'owner_id'>) => `${m.scope}:${m.owner_id}`;
const mergeSources = (m: Pick<MemoryRow, 'source'>): MergeSource[] | null => (m.source && 'merge' in m.source && Array.isArray(m.source.merge) ? m.source.merge : null);
/** The key under which a judged pair is remembered when its proposal is rejected (never asked again). */
const pairKey = (a: string, b: string) => `pair:${[a, b].sort().join(':')}`;

/** A proposal's text as stored: one line, no trailing full stop, a capital first letter. */
export function normaliseProposal(text: string): string {
  const v = text.replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '').trim();
  return v ? v[0]!.toUpperCase() + v.slice(1) : v;
}

/** Things a memory must never hold: credentials and key material. */
const CREDENTIAL = /\b(passwords?|passwd|pwd|passphrase|secret|api[ _-]?keys?|access[ _-]?keys?|tokens?|private[ _-]?key|bearer)\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9]{16,}|\bAKIA[0-9A-Z]{16}\b|\bexai_k1_/i;

/** Phrases in a user message that propose a memory, and how each is written down. */
const EXTRACTORS: [RegExp, (m: RegExpExecArray) => string][] = [
  [/\bremember (?:that )?(.{4,300}?)(?:[.!?](?:\s|$)|$)/i, (m) => m[1]!],
  [/\bI (?:always )?prefer (.{3,200}?)(?:[.!?](?:\s|$)|$)/i, (m) => `Prefers ${m[1]!}`],
  [/\bcall me ([\p{L}][\p{L} '-]{0,40}?)(?:[.!?,](?:\s|$)|$)/iu, (m) => `Prefers to be called ${m[1]!}`],
  [/\bI(?:'m| am) (?:currently )?working on (.{3,200}?)(?:[.!?](?:\s|$)|$)/i, (m) => `Current project: ${m[1]!}`],
  [/\bmy (manager|team|role|job title|time ?zone|department|cost centre|cost center) is (.{2,120}?)(?:[.!?](?:\s|$)|$)/i, (m) => `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)}: ${m[2]!}`]
];

export function extractProposals(text: string): string[] {
  const out: string[] = [];
  for (const [re, fmt] of EXTRACTORS) {
    const m = re.exec(text);
    if (!m) continue;
    const v = fmt(m).replace(/\s+/g, ' ').trim();
    if (v.length >= 4) out.push(v[0]!.toUpperCase() + v.slice(1));
  }
  return [...new Set(out)];
}

export interface MemoryDeps {
  db: Db;
  keys: DataKeys;
  blobs: BlobStore;
  jobs: JobQueue;
  gateway: Gateway;
  vectors: VectorStore;
  audit: AuditLog;
  guard: Guardrails;
  terms: TermKeys;
  log: Logger;
  embed: (tenantId: string, model: string, texts: string[], label: Label, userId: string | null) => Promise<number[][]>;
  /** 1.6.0 (B-7602): users and workspaces under a legal hold, whose memories are not purged. */
  holds?: HoldLookup;
}

/**
 * Memory: labelled facts that outlive a conversation, in three scopes (a user's own, a workspace's conventions,
 * glossary and contacts, and agents' progress and tool quirks). Nothing is remembered until a person accepts it:
 * chat proposes, the user (or a curator, for a workspace) accepts or rejects, and a rejected text is not proposed
 * again. Every write and every read into a prompt passes the `memory` checkpoint; credentials are never stored and
 * restricted memories are refused by tenant policy. Text is sealed; embeddings live in the `VectorStore`; forgetting
 * deletes the record, its versions, its vector and every export file that could hold it, and is audited.
 *
 * Since 1.5.0 (Sprint 30) a tenant may name a `memory` profile: it extracts proposals from chat turns and agent runs
 * (the rules still run when there is none or it fails), and it confirms consolidation candidates (near-duplicates by
 * embedding similarity become merge proposals; stale or contradicted memories get expiry proposals). The embedding
 * model is a tenant setting too; changing it reindexes every memory while recall falls back to recency.
 */
export class MemoryService {
  private readonly db: Db;
  /** Opens an agent run's input and output for extraction (the agent service, installed after it is built). */
  runTexts: RunTexts | null = null;

  constructor(private readonly d: MemoryDeps) {
    this.db = d.db;
    d.jobs.register(EXTRACT_JOB, (p, ctx) => (p.runId ? this.extractRunJob(p, ctx.job.tenant_id) : this.extractJob(p)));
    d.jobs.register('memory.export', (p) => this.exportJob(String(p.exportId)));
    d.jobs.register('memory.purge', (p, ctx) => this.purgeExpired(String(p.tenantId ?? ctx.job.tenant_id)));
    d.jobs.register(CONSOLIDATE_JOB, (p, ctx) => this.consolidate(String(p.tenantId ?? ctx.job.tenant_id), ctx), { timeoutMs: 60 * 60_000 });
    d.jobs.register(REINDEX_JOB, (p, ctx) => this.reindexJob(String(p.tenantId ?? ctx.job.tenant_id), String(p.model), ctx), { timeoutMs: 6 * 60 * 60_000 });
  }

  get backend(): string {
    return this.d.vectors.kind === 'pgvector' ? 'PostgreSQL and pgvector' : 'the application database';
  }

  private seal(m: Pick<MemoryRow, 'tenant_id' | 'id'>, text: string, field = 'memory'): Promise<string> {
    return this.d.keys.seal(m.tenant_id, text, `${field}:${m.id}`);
  }

  private open(m: Pick<MemoryRow, 'tenant_id' | 'id'>, sealed: string, field = 'memory'): Promise<string> {
    return this.d.keys.open(m.tenant_id, sealed, `${field}:${m.id}`);
  }

  private curator(p: Principal): boolean {
    return effectivePermissions(p).has('knowledge:manage');
  }

  /**
   * The model memories at this label are embedded with: the tenant's setting (B-3703) when it names an approved
   * embedding model cleared for the label, else none; without a setting, the first approved embedding model in the
   * catalogue by name. None means memories are recalled by recency.
   */
  private async embedModel(tenantId: string, label: Label, st?: SettingsRow): Promise<string | null> {
    const settings = st ?? (await this.settingsRow(tenantId));
    const usable = (await this.d.gateway.repo.models()).filter((m) => m.capabilities.includes('embedding') && (m.state === 'approved' || m.state === 'deprecated') && labelRank(m.label) >= labelRank(label));
    if (settings.embed_model) return usable.some((m) => m.name === settings.embed_model) ? settings.embed_model : null;
    return usable.sort((a, b) => (a.name < b.name ? -1 : 1))[0]?.name ?? null;
  }

  // ---------- settings (B-3701 to B-3703) ----------

  private async settingsRow(tenantId: string): Promise<SettingsRow> {
    const r = (await this.db('memory_settings').where({ tenant_id: tenantId }).first()) as Record<string, unknown> | undefined;
    if (!r) return DEFAULT_SETTINGS;
    return { ...(r as unknown as SettingsRow), similarity_pct: Number(r.similarity_pct), stale_days: num(r.stale_days), reindex_done: Number(r.reindex_done), reindex_total: Number(r.reindex_total), reindex_started_at: num(r.reindex_started_at), reindex_finished_at: num(r.reindex_finished_at), updated_at: num(r.updated_at) };
  }

  /** Writes settings columns; `updated_at` moves only when the patch carries it (a person's change, not a job's). */
  private async saveSettings(tenantId: string, patch: Partial<SettingsRow>): Promise<void> {
    const n = await this.db('memory_settings').where({ tenant_id: tenantId }).update(patch);
    if (!n) await this.db('memory_settings').insert({ ...DEFAULT_SETTINGS, ...patch, tenant_id: tenantId, updated_at: patch.updated_at ?? Date.now() });
  }

  async settings(tenantId: string): Promise<MemorySettings> {
    const r = await this.settingsRow(tenantId);
    return {
      profile: r.profile,
      embedModel: r.embed_model,
      effectiveEmbedModel: await this.embedModel(tenantId, 'public', r),
      similarity: r.similarity_pct / 100,
      staleDays: r.stale_days,
      reindex: { state: r.reindex_state, model: r.reindex_model, jobId: r.reindex_job_id, done: r.reindex_done, total: r.reindex_total, error: r.reindex_error, startedAt: r.reindex_started_at, finishedAt: r.reindex_finished_at },
      updatedBy: r.updated_by,
      updatedAt: r.updated_at
    };
  }

  /** Embedding models the setting may name: approved (or deprecated) models with the embedding capability. */
  async embeddingModels(): Promise<{ name: string; label: Label; state: string }[]> {
    return (await this.d.gateway.repo.models()).filter((m) => m.capabilities.includes('embedding') && (m.state === 'approved' || m.state === 'deprecated')).map((m) => ({ name: m.name, label: m.label, state: m.state }));
  }

  /**
   * Changes the tenant's memory settings. A profile must resolve; an embedding model must be an approved embedding
   * model. When the effective embedding model changes, every memory is reindexed by a job (recall is by recency
   * while it runs). Audited with the before and after.
   */
  async setSettings(p: Principal, ip: string | null, traceId: string, input: { profile?: string | null | undefined; embedModel?: string | null | undefined; similarity?: number | undefined; staleDays?: number | null | undefined }): Promise<MemorySettings> {
    const before = await this.settings(p.tenantId);
    if (input.profile) {
      try {
        await this.d.gateway.resolve(p.tenantId, input.profile);
      } catch (err) {
        if (err instanceof HttpProblem) throw new HttpProblem(422, 'Unknown profile', `Profile ${input.profile} cannot be the memory profile: ${err.detail ?? err.message}`);
        throw err;
      }
    }
    if (input.embedModel && !(await this.embeddingModels()).some((m) => m.name === input.embedModel)) throw new HttpProblem(422, 'Not an embedding model', `${input.embedModel} is not an approved embedding model.`);
    const patch: Partial<SettingsRow> = { updated_by: p.userId, updated_at: Date.now() };
    if (input.profile !== undefined) patch.profile = input.profile;
    if (input.embedModel !== undefined) patch.embed_model = input.embedModel;
    if (input.similarity !== undefined) patch.similarity_pct = Math.round(input.similarity * 100);
    if (input.staleDays !== undefined) patch.stale_days = input.staleDays;
    await this.saveSettings(p.tenantId, patch);
    let after = await this.settings(p.tenantId);
    await this.d.audit.append({ tenantId: p.tenantId, action: 'memory.settings.updated', kind: 'admin', actor: actorFrom(p, ip), target: { tenant: p.tenantId }, label: 'internal', traceId, detail: { before: { profile: before.profile, embedModel: before.embedModel, similarity: before.similarity, staleDays: before.staleDays }, after: { profile: after.profile, embedModel: after.embedModel, similarity: after.similarity, staleDays: after.staleDays } } });
    if (after.effectiveEmbedModel && after.effectiveEmbedModel !== before.effectiveEmbedModel) {
      await this.startReindex(p, ip, traceId);
      after = await this.settings(p.tenantId);
    }
    return after;
  }

  async get(tenantId: string, id: string): Promise<MemoryRow> {
    const r = await this.db('memories').where({ tenant_id: tenantId, id }).first();
    if (!r) throw notFound('Memory');
    return fromRow(r);
  }

  /** A memory the principal may see: their own, their current workspace's, or an agent's, at or below clearance. */
  async visible(p: Principal, id: string, need: 'read' | 'write' = 'read'): Promise<MemoryRow> {
    const m = await this.get(p.tenantId, id);
    if (!clears(p.clearance, m.label)) throw notFound('Memory');
    if (m.scope === 'user' && m.owner_id !== p.userId) throw notFound('Memory');
    if (m.scope === 'workspace') {
      if (m.owner_id !== p.workspaceId) throw notFound('Memory');
      if (m.state === 'proposed' && m.author_id !== p.userId && !this.curator(p)) throw notFound('Memory');
      if (need === 'write' && !this.curator(p)) throw forbidden('Workspace memories are changed by knowledge curators; members propose.', { step: 'role', action: 'knowledge:manage' });
    }
    if (m.scope === 'agent' && need === 'write' && !this.curator(p)) throw forbidden('Agent memories are changed by knowledge curators.', { step: 'role', action: 'knowledge:manage' });
    return m;
  }

  // ---------- views ----------

  async list(p: Principal, tab: 'mine' | 'workspace' | 'agents') {
    const q = this.db('memories').where({ tenant_id: p.tenantId }).whereIn('label', labelsUpTo(p.clearance));
    if (tab === 'mine') q.andWhere({ scope: 'user', owner_id: p.userId });
    else if (tab === 'workspace') {
      q.andWhere({ scope: 'workspace', owner_id: p.workspaceId ?? '' });
      if (!this.curator(p)) q.andWhere((w) => w.whereNot({ state: 'proposed' }).orWhere({ author_id: p.userId }));
    } else q.andWhere({ scope: 'agent' });
    const rows = ((await q.orderBy('updated_at', 'desc').limit(1000)) as Record<string, unknown>[]).map(fromRow);
    return Promise.all(rows.map((m) => this.view(p, m)));
  }

  async counts(p: Principal): Promise<{ mine: number; workspace: number; agents: number }> {
    const base = () => this.db('memories').where({ tenant_id: p.tenantId }).whereIn('label', labelsUpTo(p.clearance));
    const count = async (q: ReturnType<typeof base>) => Number(((await q.count({ n: '*' })) as { n: number }[])[0]?.n ?? 0);
    const ws = base().andWhere({ scope: 'workspace', owner_id: p.workspaceId ?? '' });
    if (!this.curator(p)) ws.andWhere((w) => w.whereNot({ state: 'proposed' }).orWhere({ author_id: p.userId }));
    return { mine: await count(base().andWhere({ scope: 'user', owner_id: p.userId })), workspace: await count(ws), agents: await count(base().andWhere({ scope: 'agent' })) };
  }

  private async names(ids: (string | null)[]): Promise<Map<string, string>> {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    if (!list.length) return new Map();
    return new Map(((await this.db('users').whereIn('id', list).select('id', 'display_name')) as { id: string; display_name: string }[]).map((u) => [u.id, u.display_name]));
  }

  async view(p: Principal, m: MemoryRow) {
    const versions = (await this.db('memory_versions').where({ memory_id: m.id }).orderBy('created_at', 'desc')) as { version: number; note: string; actor: string | null; created_at: number }[];
    const names = await this.names([m.author_id, m.accepted_by, ...versions.map((v) => v.actor)]);
    let source: { conversationId: string; title: string | null } | null = null;
    const run = m.source && 'runId' in m.source ? m.source.runId : null;
    if (m.source && 'conversationId' in m.source) {
      const c = (await this.db('conversations').where({ tenant_id: m.tenant_id, id: m.source.conversationId }).first()) as { id: string; user_id: string; title: string | null } | undefined;
      source = { conversationId: m.source.conversationId, title: c && c.user_id === p.userId && c.title ? await this.d.keys.open(m.tenant_id, c.title, `title:${c.id}`).catch(() => null) : null };
    }
    return {
      id: m.id,
      scope: m.scope,
      ownerId: m.owner_id,
      type: m.type,
      text: await this.open(m, m.content),
      label: m.label,
      sourceLabel: m.source_label,
      state: m.state,
      origin: m.origin,
      source,
      run,
      author: m.author_id ? (names.get(m.author_id) ?? null) : m.scope === 'agent' ? m.owner_id : null,
      authorId: m.author_id,
      acceptedBy: m.accepted_by ? (names.get(m.accepted_by) ?? null) : null,
      backend: this.backend,
      embedded: !!m.embed_model,
      embedModel: m.embed_model,
      expiresAt: m.expires_at,
      merge: mergeSources(m) ? { memories: mergeSources(m)!.map((x) => x.memoryId), similarity: (m.source as { similarity: number }).similarity } : null,
      supersededBy: m.superseded_by,
      expiryProposal: m.expiry_proposal,
      version: m.version,
      history: versions.map((v) => ({ version: Number(v.version), note: v.note, actor: v.actor ? (names.get(v.actor) ?? null) : null, at: Number(v.created_at) })),
      createdAt: m.created_at,
      updatedAt: m.updated_at
    };
  }

  // ---------- the memory checkpoint ----------

  /** Tenant policy, the built-in credential ban, then the guardrail rules for the `memory` checkpoint on write. */
  private async checkWrite(p: Principal | null, tenantId: string, workspaceId: string | null, text: string, label: Label, meta: Record<string, unknown>): Promise<string> {
    if (label === 'restricted') throw new HttpProblem(422, 'Refused by tenant policy', 'Tenant policy does not allow restricted memories, so nothing was saved.', { extensions: { step: 'policy', checkpoint: 'memory' } });
    if (CREDENTIAL.test(text)) throw new HttpProblem(422, 'Refused by the memory checkpoint', 'It looks like a credential. Credentials are never stored in memory.', { extensions: { step: 'guardrail', checkpoint: 'memory' } });
    const g = await this.d.guard.check({ tenantId, workspaceId, checkpoint: 'memory', text, label, ...(p ? { principal: p } : {}), meta: { op: 'write', ...meta } });
    if (g.action === 'block' || g.action === 'require-approval') throw new HttpProblem(422, 'Refused by the memory checkpoint', g.reason ?? 'A guardrail rule refused this memory.', { extensions: { step: 'guardrail', checkpoint: 'memory' } });
    return g.action === 'redact' ? g.text : text;
  }

  // ---------- writes ----------

  private async insert(input: { tenantId: string; scope: MemoryScope; ownerId: string; type: string; text: string; label: Label; sourceLabel: Label; state: MemoryState; origin: MemoryRow['origin']; source: MemoryRow['source']; authorId: string | null; acceptedBy: string | null; expiresAt: number | null; note: string }): Promise<MemoryRow> {
    const t = Date.now();
    const id = ulid();
    const row = { id, tenant_id: input.tenantId };
    const content = await this.seal(row, input.text);
    await this.db('memories').insert({ id, tenant_id: input.tenantId, scope: input.scope, owner_id: input.ownerId, type: input.type, content, label: input.label, source_label: input.sourceLabel, state: input.state, source: input.source ? JSON.stringify(input.source) : null, origin: input.origin, author_id: input.authorId, accepted_by: input.acceptedBy, embed_model: null, expires_at: input.expiresAt, version: 1, created_at: t, updated_at: t });
    await this.db('memory_versions').insert({ id: ulid(), memory_id: id, tenant_id: input.tenantId, version: 1, content: await this.seal({ tenant_id: input.tenantId, id }, input.text, 'memory-version'), note: input.note, actor: input.authorId, created_at: t });
    const m = await this.get(input.tenantId, id);
    if (m.state === 'active') await this.embed(m, input.text);
    return this.get(input.tenantId, id);
  }

  /** Writes the memory's vector (when an embedding model exists); failures leave it recalled by recency. */
  private async embed(m: MemoryRow, text: string): Promise<void> {
    try {
      const model = await this.embedModel(m.tenant_id, m.label);
      await this.d.vectors.delete(COLLECTION, [m.id]);
      if (!model) {
        await this.db('memories').where({ id: m.id }).update({ embed_model: null });
        return;
      }
      const [vec] = await this.d.embed(m.tenant_id, model, [text], m.label, m.author_id);
      await this.d.vectors.upsert(COLLECTION, [{ id: m.id, tenantId: m.tenant_id, partition: partition(m), labelRank: labelRank(m.label), vector: vec! }]);
      await this.db('memories').where({ id: m.id }).update({ embed_model: model });
    } catch (err) {
      this.d.log.warn({ err: (err as Error).message, memory: m.id }, 'memory embedding failed; it is recalled by recency');
      await this.db('memories').where({ id: m.id }).update({ embed_model: null });
    }
  }

  async add(p: Principal, input: { text: string; scope: 'user' | 'workspace'; type: string; label: Label; expiresAt: number | null }): Promise<MemoryRow> {
    if (!clears(p.clearance, input.label)) throw forbidden(`Your clearance is ${p.clearance}.`, { step: 'clearance' });
    if (input.scope === 'workspace' && !p.workspaceId) throw conflict('Pick a workspace first; workspace memories belong to one.');
    if (input.scope === 'workspace') {
      const ws = (await this.db('workspaces').where({ id: p.workspaceId }).first('label_ceiling')) as { label_ceiling: Label } | undefined;
      if (ws && labelRank(input.label) > labelRank(ws.label_ceiling)) throw forbidden(`This workspace's ceiling is ${ws.label_ceiling}.`, { step: 'zone' });
    }
    const text = await this.checkWrite(p, p.tenantId, p.workspaceId ?? null, input.text, input.label, { scope: input.scope });
    const curator = input.scope === 'workspace' && this.curator(p);
    return this.insert({
      tenantId: p.tenantId,
      scope: input.scope,
      ownerId: input.scope === 'user' ? p.userId : p.workspaceId!,
      type: input.type,
      text,
      label: input.label,
      sourceLabel: 'public',
      state: input.scope === 'user' || curator ? 'active' : 'proposed',
      origin: 'manual',
      source: null,
      authorId: p.userId,
      acceptedBy: input.scope === 'user' || curator ? p.userId : null,
      expiresAt: input.expiresAt,
      note: input.scope === 'user' ? 'added here' : curator ? 'added by a curator' : 'proposed by a member; waits for a curator'
    });
  }

  /**
   * Accepts a proposal. A merge proposal (B-3702) becomes the new memory and retires the memories it replaces: each
   * is `superseded`, links to the new one and keeps its history; they must be unchanged since the proposal.
   */
  async accept(p: Principal, id: string): Promise<{ memory: MemoryRow; replaced: string[] }> {
    const m = await this.visible(p, id, 'write');
    if (m.state !== 'proposed') throw conflict(`This memory is ${m.state}.`);
    const replaced: MemoryRow[] = [];
    for (const src of mergeSources(m) ?? []) {
      const o = (await this.db('memories').where({ tenant_id: m.tenant_id, id: src.memoryId }).first()) as Record<string, unknown> | undefined;
      if (!o) throw conflict('A memory this merge replaces was forgotten; reject the proposal.');
      const old = fromRow(o);
      if (old.state !== 'active' || old.version !== src.version || partition(old) !== partition(m)) throw conflict('A memory this merge replaces changed after the proposal; reject it and consolidate again.');
      replaced.push(old);
    }
    const text = await this.open(m, m.content);
    await this.checkWrite(p, m.tenant_id, p.workspaceId ?? null, text, m.label, { scope: m.scope, accept: true, ...(replaced.length ? { merge: replaced.map((r) => r.id) } : {}) });
    const t = Date.now();
    await this.db.transaction(async (trx) => {
      await trx('memories').where({ id: m.id }).update({ state: 'active', accepted_by: p.userId, version: m.version + 1, updated_at: t });
      await trx('memory_versions').insert({ id: ulid(), memory_id: m.id, tenant_id: m.tenant_id, version: m.version + 1, content: null, note: replaced.length ? `accepted; merges ${replaced.map((r) => r.id).join(' and ')}` : 'accepted', actor: p.userId, created_at: t });
      for (const old of replaced) {
        await trx('memories').where({ id: old.id }).update({ state: 'superseded', superseded_by: m.id, expiry_proposal: null, version: old.version + 1, updated_at: t });
        await trx('memory_versions').insert({ id: ulid(), memory_id: old.id, tenant_id: old.tenant_id, version: old.version + 1, content: null, note: `merged into ${m.id}`, actor: p.userId, created_at: t });
      }
    });
    if (replaced.length) await this.d.vectors.delete(COLLECTION, replaced.map((r) => r.id));
    await this.embed({ ...m, state: 'active' }, text);
    return { memory: await this.get(p.tenantId, id), replaced: replaced.map((r) => r.id) };
  }

  private rejectionHash(tenantId: string, key: string): Promise<string> {
    return this.d.terms.text(tenantId, 'memory-reject', key.toLowerCase());
  }

  private async rejected(tenantId: string, ownerKey: string, key: string): Promise<boolean> {
    return !!(await this.db('memory_rejections').where({ tenant_id: tenantId, owner_key: ownerKey, hash: await this.rejectionHash(tenantId, key) }).first());
  }

  private async remember(tenantId: string, ownerKey: string, key: string): Promise<void> {
    await this.db('memory_rejections').insert({ tenant_id: tenantId, owner_key: ownerKey, hash: await this.rejectionHash(tenantId, key), created_at: Date.now() }).catch(() => undefined);
  }

  /** Discards a proposal and remembers not to propose the same text (or, for a merge, the same pair) again. */
  async reject(p: Principal, id: string): Promise<MemoryRow> {
    const m = await this.visible(p, id, 'write');
    if (m.state !== 'proposed') throw conflict(`This memory is ${m.state}; forget it instead.`);
    const text = await this.open(m, m.content);
    await this.remember(m.tenant_id, partition(m), text);
    const merge = mergeSources(m);
    if (merge && merge.length === 2) await this.remember(m.tenant_id, partition(m), pairKey(merge[0]!.memoryId, merge[1]!.memoryId));
    await this.db('memories').where({ id: m.id }).delete();
    return m;
  }

  /**
   * Decides an expiry proposal (B-3702): accepting sets the memory to expire (it is purged after a day's grace),
   * rejecting clears the proposal and remembers not to propose it again for the same reason.
   */
  async decideExpiry(p: Principal, id: string, decision: 'accept' | 'reject'): Promise<{ memory: MemoryRow; proposal: ExpiryProposal }> {
    const m = await this.visible(p, id, 'write');
    const proposal = m.expiry_proposal;
    if (!proposal) throw conflict('This memory has no expiry proposal.');
    const t = Date.now();
    if (decision === 'accept') {
      const expiresAt = Math.max(proposal.expiresAt, t);
      await this.db('memories').where({ id: m.id }).update({ expires_at: expiresAt, expiry_proposal: null, version: m.version + 1, updated_at: t });
      await this.db('memory_versions').insert({ id: ulid(), memory_id: m.id, tenant_id: m.tenant_id, version: m.version + 1, content: null, note: `expiry set to ${new Date(expiresAt).toISOString().slice(0, 10)} (${proposal.reason === 'stale' ? 'stale' : `contradicted by ${proposal.by}`})`, actor: p.userId, created_at: t });
    } else {
      await this.db('memories').where({ id: m.id }).update({ expiry_proposal: null });
      await this.remember(m.tenant_id, partition(m), `expire:${m.id}:${proposal.reason}`);
      if (proposal.by) await this.remember(m.tenant_id, partition(m), pairKey(m.id, proposal.by));
    }
    return { memory: await this.get(p.tenantId, id), proposal };
  }

  async edit(p: Principal, id: string, patch: { text?: string; label?: Label; expiresAt?: number | null }): Promise<{ memory: MemoryRow; changed: string[] }> {
    const m = await this.visible(p, id, 'write');
    const changed: string[] = [];
    const label = patch.label ?? m.label;
    if (!clears(p.clearance, label)) throw forbidden(`Your clearance is ${p.clearance}.`, { step: 'clearance' });
    if (labelRank(label) < labelRank(m.source_label)) throw conflict(`The source is ${m.source_label}, so the memory cannot be lower.`);
    let text = await this.open(m, m.content);
    const textChanged = patch.text !== undefined && patch.text !== text;
    if (textChanged || patch.label !== undefined) text = await this.checkWrite(p, m.tenant_id, p.workspaceId ?? null, patch.text ?? text, label, { scope: m.scope, edit: true });
    const upd: Record<string, unknown> = { updated_at: Date.now() };
    const notes: string[] = [];
    if (textChanged) {
      upd.content = await this.seal(m, text);
      changed.push('text');
      notes.push('edited');
    }
    if (patch.label !== undefined && patch.label !== m.label) {
      upd.label = patch.label;
      changed.push('label');
      notes.push(`relabelled ${patch.label}`);
    }
    if (patch.expiresAt !== undefined && patch.expiresAt !== m.expires_at) {
      upd.expires_at = patch.expiresAt;
      changed.push('expiry');
      notes.push(patch.expiresAt ? `expiry set to ${new Date(patch.expiresAt).toISOString().slice(0, 10)}` : 'expiry removed');
    }
    if (!changed.length) return { memory: m, changed };
    upd.version = m.version + 1;
    await this.db('memories').where({ id: m.id }).update(upd);
    await this.db('memory_versions').insert({ id: ulid(), memory_id: m.id, tenant_id: m.tenant_id, version: m.version + 1, content: textChanged ? await this.seal(m, text, 'memory-version') : null, note: notes.join(', '), actor: p.userId, created_at: Date.now() });
    const after = await this.get(p.tenantId, id);
    if (after.state === 'active' && (textChanged || changed.includes('label'))) await this.embed(after, text);
    return { memory: after, changed };
  }

  /** Deletes a memory from every backend: the record and its versions, its vector, and export files that could hold it. */
  async forget(m: MemoryRow): Promise<{ vectors: number; exports: number; versions: number }> {
    const vectors = await this.d.vectors.delete(COLLECTION, [m.id]);
    const versions = Number(((await this.db('memory_versions').where({ memory_id: m.id }).count({ n: '*' })) as { n: number }[])[0]?.n ?? 0);
    await this.db('memory_versions').where({ memory_id: m.id }).delete();
    await this.db('memories').where({ id: m.id }).delete();
    // Export files made before now may contain the memory: they are deleted too.
    const files = (await this.db('memory_exports').where({ tenant_id: m.tenant_id, owner_id: m.scope === 'agent' ? '*' : m.owner_id }).whereNotNull('blob_key').andWhere('created_at', '<=', Date.now())) as { id: string; blob_key: string; scope: string }[];
    let exports = 0;
    for (const f of files.filter((x) => (m.scope === 'user' ? x.scope === 'mine' : m.scope === 'workspace' ? x.scope === 'workspace' : x.scope === 'agents'))) {
      await this.d.blobs.delete(f.blob_key);
      await this.db('memory_exports').where({ id: f.id }).update({ state: 'purged', blob_key: null });
      exports++;
    }
    return { vectors, exports, versions };
  }

  // ---------- chat ----------

  /** Queues extraction of memory proposals from the user's message after an answer completes. */
  onAnswer(e: AnswerEvent): void {
    if (e.state !== 'complete' || !e.userMessageId) return;
    void this.d.jobs
      .enqueue({ tenantId: e.tenantId, type: EXTRACT_JOB, payload: { messageId: e.userMessageId, conversationId: e.conversationId, userId: e.principal.userId, workspaceId: e.workspaceId }, createdBy: e.principal.userId, maxAttempts: 1 })
      .catch((err: Error) => this.d.log.warn({ err: err.message }, 'memory extraction could not be queued'));
  }

  /** Queues extraction of agent memory proposals from a run that finished under a policy allowing them (B-3701). */
  onRun(e: RunMemoryEvent): void {
    if (e.remaining <= 0 || !e.types.length) return;
    void this.d.jobs
      .enqueue({ tenantId: e.tenantId, type: EXTRACT_JOB, payload: { runId: e.runId, types: e.types, remaining: e.remaining }, createdBy: e.userId, maxAttempts: 1 })
      .catch((err: Error) => this.d.log.warn({ err: err.message }, 'memory extraction could not be queued'));
  }

  /**
   * Candidate memories from a text: the tenant's memory profile when one is set and it answers well-formed JSON,
   * else (no profile, a model error, a malformed answer) the rules. A fallback is audited with its reason.
   */
  private async candidates(tenantId: string, kind: 'chat' | 'run', data: Record<string, string>, rulesText: string, label: Label, types: readonly [string, ...string[]], target: Record<string, unknown>): Promise<{ via: 'model' | 'rules'; items: { text: string; type: string }[] }> {
    const st = await this.settingsRow(tenantId);
    if (st.profile) {
      try {
        const r = await askProfile(this.d.gateway, tenantId, st.profile, label, extractionMessages(kind, data, types), extractionSchema(types));
        return { via: 'model', items: r.value.memories.map((m) => ({ text: m.text, type: m.type ?? types[0] })) };
      } catch (err) {
        const reason = (err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message).slice(0, 300);
        this.d.log.warn({ err: reason, profile: st.profile }, 'memory profile failed; the rules extract instead');
        await this.d.audit.append({ tenantId, action: 'memory.extraction.fallback', kind: 'system', actor: { service: EXTRACT_JOB }, target, label, detail: { profile: st.profile, reason } });
      }
    }
    return { via: 'rules', items: extractProposals(rulesText).map((text) => ({ text, type: types[0] })) };
  }

  private async extractJob(p: Record<string, unknown>): Promise<unknown> {
    const msg = (await this.db('messages').where({ id: String(p.messageId) }).first()) as { id: string; tenant_id: string; content: string | null; label: Label; role: string } | undefined;
    if (!msg || msg.role !== 'user' || !msg.content) return { proposals: 0 };
    const text = await this.d.keys.open(msg.tenant_id, msg.content, `content:${msg.id}`);
    const userId = String(p.userId);
    const found = await this.candidates(msg.tenant_id, 'chat', { message: text }, text, msg.label, USER_TYPES, { message: msg.id });
    let proposals = 0;
    const refused: string[] = [];
    const existing = ((await this.db('memories').where({ tenant_id: msg.tenant_id, scope: 'user', owner_id: userId })) as Record<string, unknown>[]).map(fromRow);
    const held = new Set<string>();
    for (const e of existing) held.add((await this.open(e, e.content)).toLowerCase());
    for (const c of found.items) {
      const candidate = normaliseProposal(c.text);
      if (candidate.length < 4 || held.has(candidate.toLowerCase())) continue;
      // The rejection list: a text the user rejected before is never proposed again, whoever wrote it.
      if (await this.rejected(msg.tenant_id, `user:${userId}`, candidate)) continue;
      try {
        const clean = await this.checkWrite(null, msg.tenant_id, (p.workspaceId as string | null) ?? null, candidate, msg.label, { scope: 'user', proposal: true, via: found.via });
        await this.insert({ tenantId: msg.tenant_id, scope: 'user', ownerId: userId, type: c.type, text: clean, label: msg.label, sourceLabel: msg.label, state: 'proposed', origin: 'extraction', source: { conversationId: String(p.conversationId), messageId: msg.id }, authorId: null, acceptedBy: null, expiresAt: null, note: `proposed after a chat turn (${found.via === 'model' ? 'memory profile' : 'rules'}); passed the memory checkpoint` });
        held.add(candidate.toLowerCase());
        proposals++;
      } catch (err) {
        refused.push(err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message);
        await this.d.audit.append({ tenantId: msg.tenant_id, action: 'memory.proposal.refused', kind: 'system', actor: { service: EXTRACT_JOB, user: userId }, target: { message: msg.id }, label: msg.label, detail: { reason: refused[refused.length - 1] } });
      }
    }
    return { via: found.via, proposals, refused: refused.length };
  }

  /** Agent memory proposals from a finished run's task and answer (B-3701), within what the policy still allows. */
  private async extractRunJob(p: Record<string, unknown>, tenantId: string): Promise<unknown> {
    const runId = String(p.runId);
    const run = this.runTexts ? await this.runTexts(tenantId, runId) : null;
    if (!run?.output) return { proposals: 0 };
    const types = (Array.isArray(p.types) ? p.types.map(String) : []).filter((t) => (AGENT_TYPES as readonly string[]).includes(t));
    let remaining = Number(p.remaining ?? 0);
    if (!types.length || remaining <= 0) return { proposals: 0 };
    const found = await this.candidates(tenantId, 'run', { task: run.input, answer: run.output }, run.output, run.label, types as [string, ...string[]], { run: runId, agent: run.agent });
    let proposals = 0;
    let refused = 0;
    for (const c of found.items) {
      if (remaining <= 0) break;
      const type = types.includes(c.type) ? c.type : types[0]!;
      try {
        await this.proposeAgent({ tenantId, workspaceId: run.workspaceId, principal: null, userId: run.userId, service: EXTRACT_JOB }, { agent: run.agent, runId, text: c.text, type, label: run.label, via: found.via });
        proposals++;
        remaining--;
      } catch (err) {
        // Already held, or rejected before: skipped quietly. Refused by the checkpoint: audited.
        if (err instanceof HttpProblem && err.status === 409) continue;
        refused++;
        await this.d.audit.append({ tenantId, action: 'memory.proposal.refused', kind: 'system', actor: { service: EXTRACT_JOB, user: run.userId }, target: { run: runId, agent: run.agent }, label: run.label, detail: { reason: err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message } });
      }
    }
    return { via: found.via, proposals, refused };
  }

  /**
   * A memory an agent run proposes about its own work (Sprint 12), under the agent's memory policy (checked by the
   * caller). It passes the same write checks as any memory (tenant policy, the credential ban, the `memory` checkpoint
   * with the agent's rule sets), is never a text a curator rejected before or one the agent already holds, and waits
   * for a knowledge curator to accept it.
   */
  async proposeForAgent(p: Principal, input: { agent: string; runId: string; text: string; type: string; label: Label }): Promise<MemoryRow> {
    return this.proposeAgent({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, principal: p, userId: p.userId, service: 'agents' }, input);
  }

  private async proposeAgent(ctx: { tenantId: string; workspaceId: string | null; principal: Principal | null; userId: string; service: string }, input: { agent: string; runId: string; text: string; type: string; label: Label; via?: 'model' | 'rules' }): Promise<MemoryRow> {
    const text = input.via ? normaliseProposal(input.text) : input.text.replace(/\s+/g, ' ').trim();
    if (text.length < 4 || text.length > 1000) throw new HttpProblem(422, 'Invalid memory', 'A memory is 4 to 1000 characters.');
    if (await this.rejected(ctx.tenantId, `agent:${input.agent}`, text)) throw conflict('A curator rejected this memory before, so it is not proposed again.');
    for (const e of ((await this.db('memories').where({ tenant_id: ctx.tenantId, scope: 'agent', owner_id: input.agent }).whereNot({ state: 'superseded' })) as Record<string, unknown>[]).map(fromRow)) {
      if ((await this.open(e, e.content)).toLowerCase() === text.toLowerCase()) throw conflict('The agent already has this memory or a proposal for it.');
    }
    const clean = await this.checkWrite(ctx.principal, ctx.tenantId, ctx.workspaceId, text, input.label, { scope: 'agent', agent: input.agent, proposal: true, run: input.runId, ...(input.via ? { via: input.via } : {}) });
    const how = input.via ? ` (extracted by the ${input.via === 'model' ? 'memory profile' : 'rules'})` : '';
    const m = await this.insert({ tenantId: ctx.tenantId, scope: 'agent', ownerId: input.agent, type: input.type, text: clean, label: input.label, sourceLabel: input.label, state: 'proposed', origin: 'agent', source: { runId: input.runId }, authorId: null, acceptedBy: null, expiresAt: null, note: `proposed by run ${input.runId}${how}; passed the memory checkpoint` });
    await this.d.audit.append({ tenantId: ctx.tenantId, action: 'memory.proposed', kind: 'system', actor: { service: ctx.service, user: ctx.userId }, target: { memory: m.id, agent: input.agent, run: input.runId }, label: m.label, detail: { type: m.type, scope: 'agent', ...(input.via ? { via: input.via } : {}) } });
    return m;
  }

  /** The chat context provider: active, unexpired memories of the user and the workspace, up to the ceiling. */
  async contextFor(req: ContextRequest): Promise<ContextItem[]> {
    const parts = [`user:${req.principal.userId}`, ...(req.workspaceId ? [`workspace:${req.workspaceId}`] : [])];
    const base = () =>
      this.db('memories')
        .where({ tenant_id: req.tenantId, state: 'active' })
        .whereIn('label', labelsUpTo(req.ceiling))
        .andWhere((w) => w.where({ scope: 'user', owner_id: req.principal.userId }).orWhere((x) => x.where({ scope: 'workspace', owner_id: req.workspaceId ?? '' })))
        .andWhere((w) => w.whereNull('expires_at').orWhere('expires_at', '>', Date.now()));
    let rows = ((await base().orderBy('updated_at', 'desc').limit(10)) as Record<string, unknown>[]).map(fromRow);
    // While a reindex runs (B-3703) the vectors are of two models: recall is by recency until it is done.
    const st = await this.settingsRow(req.tenantId);
    const model = st.reindex_state === 'running' ? null : await this.embedModel(req.tenantId, 'public', st);
    if (model && req.query.trim()) {
      try {
        const [vec] = await this.d.embed(req.tenantId, model, [req.query], req.label, req.principal.userId);
        const hits = await this.d.vectors.search(COLLECTION, { tenantId: req.tenantId, vector: vec!, k: 8, maxLabelRank: labelRank(req.ceiling), partitions: parts });
        // Only vectors of the model the query was embedded with are comparable.
        const byVector = hits.length ? ((await base().whereIn('id', hits.map((h) => h.id)).andWhere({ embed_model: model })) as Record<string, unknown>[]).map(fromRow) : [];
        const order = new Map(hits.map((h, i) => [h.id, i]));
        rows = [...byVector.sort((a, b) => order.get(a.id)! - order.get(b.id)!), ...rows.filter((r) => !order.has(r.id))].slice(0, 10);
      } catch (err) {
        this.d.log.warn({ err: (err as Error).message }, 'memory recall by vector failed; using the most recent');
      }
    }
    const out: ContextItem[] = [];
    for (const m of rows) {
      const text = await this.open(m, m.content);
      const g = await this.d.guard.check({ tenantId: req.tenantId, workspaceId: req.workspaceId, checkpoint: 'memory', text, label: m.label, principal: req.principal, source: { kind: 'memory', id: m.id }, meta: { op: 'read', scope: m.scope } });
      if (g.action === 'block' || g.action === 'require-approval') continue;
      out.push({ tag: 'memory', label: m.label, attrs: { scope: m.scope === 'user' ? 'user' : 'workspace', type: m.type }, text: g.action === 'redact' ? g.text : text, cite: { memoryId: m.id, scope: m.scope, type: m.type } });
    }
    return out;
  }

  /**
   * Memories of an agent (scope `agent`, owned by the agent's name) for a run's context: accepted, unexpired, at or
   * below the run's label, most recent first, each through the `memory` checkpoint like chat's.
   */
  async forAgent(p: Principal, agent: string, label: Label, limit = 10): Promise<{ id: string; type: string; label: Label; text: string }[]> {
    const rows = ((await this.db('memories')
      .where({ tenant_id: p.tenantId, scope: 'agent', owner_id: agent, state: 'active' })
      .whereIn('label', labelsUpTo(label))
      .andWhere((w) => w.whereNull('expires_at').orWhere('expires_at', '>', Date.now()))
      .orderBy('updated_at', 'desc')
      .limit(limit)) as Record<string, unknown>[]).map(fromRow);
    const out = [];
    for (const m of rows) {
      const text = await this.open(m, m.content);
      const g = await this.d.guard.check({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, checkpoint: 'memory', text, label: m.label, principal: p, source: { kind: 'memory', id: m.id }, meta: { op: 'read', scope: 'agent', agent } });
      if (g.action === 'block' || g.action === 'require-approval') continue;
      out.push({ id: m.id, type: m.type, label: m.label, text: g.action === 'redact' ? g.text : text });
    }
    return out;
  }

  // ---------- consolidation (B-3702) ----------

  /** Queues a consolidation run now (it also runs daily for every tenant). */
  async requestConsolidation(p: Principal, ip: string | null, traceId: string): Promise<{ jobId: string }> {
    const job = await this.d.jobs.enqueue({ tenantId: p.tenantId, type: CONSOLIDATE_JOB, payload: { tenantId: p.tenantId }, createdBy: p.userId, dedupeKey: `${CONSOLIDATE_JOB}:${p.tenantId}:manual:${Math.floor(Date.now() / 60_000)}`, maxAttempts: 1 });
    await this.d.audit.append({ tenantId: p.tenantId, action: 'memory.consolidation.requested', kind: 'admin', actor: actorFrom(p, ip), target: { job: job.id }, label: 'internal', traceId });
    return { jobId: job.id };
  }

  /**
   * Finds what to tidy and proposes it; nothing changes until a person accepts. Stale memories (episodic or progress,
   * untouched for the tenant's `staleDays`) get an expiry proposal. With a memory profile and an embedding model,
   * active memories of the same owner whose vectors are at least `similarity` alike are judged by the profile: the
   * same fact becomes one merge proposal (a new proposed memory naming both), a contradiction an expiry proposal for
   * the outdated one. A pair already proposed, or whose proposal was rejected, is not judged again.
   */
  async consolidate(tenantId: string, ctx?: JobContext): Promise<{ merges: number; expiries: number; stale: number; judged: number; failures: number }> {
    const st = await this.settingsRow(tenantId);
    const now = Date.now();
    const out = { merges: 0, expiries: 0, stale: 0, judged: 0, failures: 0 };
    if (st.stale_days) {
      const old = ((await this.db('memories').where({ tenant_id: tenantId, state: 'active' }).whereIn('type', STALE_TYPES).whereNull('expires_at').whereNull('expiry_proposal').andWhere('updated_at', '<', now - st.stale_days * 86_400_000).limit(1000)) as Record<string, unknown>[]).map(fromRow);
      for (const m of old) {
        if (await this.rejected(tenantId, partition(m), `expire:${m.id}:stale`)) continue;
        await this.proposeExpiry(m, { expiresAt: now + EXPIRY_GRACE_MS, reason: 'stale', by: null, similarity: null, proposedAt: now });
        out.stale++;
      }
    }
    if (st.profile && st.reindex_state !== 'running') {
      const owners = (await this.db('memories').where({ tenant_id: tenantId, state: 'active' }).distinct('scope', 'owner_id')) as { scope: MemoryScope; owner_id: string }[];
      for (const [i, owner] of owners.entries()) {
        if (ctx?.signal.aborted || out.judged >= MAX_JUDGED) break;
        const r = await this.consolidateOwner(tenantId, st, owner, MAX_JUDGED - out.judged);
        out.merges += r.merges;
        out.expiries += r.expiries;
        out.judged += r.judged;
        out.failures += r.failures;
        await ctx?.progress(Math.round(((i + 1) / owners.length) * 100), `${owner.scope} memories`);
      }
    }
    await this.d.audit.append({ tenantId, action: 'memory.consolidated', kind: 'system', actor: { service: CONSOLIDATE_JOB }, target: { tenant: tenantId }, label: 'internal', detail: { ...out, profile: st.profile } });
    return out;
  }

  private async consolidateOwner(tenantId: string, st: SettingsRow, owner: { scope: MemoryScope; owner_id: string }, budget: number): Promise<{ merges: number; expiries: number; judged: number; failures: number }> {
    const out = { merges: 0, expiries: 0, judged: 0, failures: 0 };
    const now = Date.now();
    const all = ((await this.db('memories').where({ tenant_id: tenantId, scope: owner.scope, owner_id: owner.owner_id }).whereNot({ state: 'superseded' })) as Record<string, unknown>[]).map(fromRow);
    // Memories already in a pending merge or expiry proposal wait for that decision first.
    const busy = new Set<string>();
    for (const m of all) {
      if (m.state === 'proposed') for (const src of mergeSources(m) ?? []) busy.add(src.memoryId);
      if (m.expiry_proposal) busy.add(m.id);
    }
    const rows = all
      .filter((m) => m.state === 'active' && (m.expires_at == null || m.expires_at > now) && !busy.has(m.id))
      .sort((a, b) => b.updated_at - a.updated_at)
      .slice(0, MAX_PER_OWNER);
    if (rows.length < 2) return out;
    const top = highest(...rows.map((m) => m.label));
    const model = await this.embedModel(tenantId, top, st);
    if (!model) return out;
    const texts = await Promise.all(rows.map((m) => this.open(m, m.content)));
    let vecs: number[][];
    try {
      vecs = await this.d.embed(tenantId, model, texts, top, null);
    } catch (err) {
      this.d.log.warn({ err: (err as Error).message }, 'memory consolidation could not embed; skipped');
      out.failures++;
      return out;
    }
    const threshold = st.similarity_pct / 100;
    const pairs: { i: number; j: number; score: number }[] = [];
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
      const score = cosine(vecs[i]!, vecs[j]!);
      if (score >= threshold) pairs.push({ i, j, score });
    }
    pairs.sort((a, b) => b.score - a.score);
    const used = new Set<string>();
    for (const pair of pairs) {
      if (out.judged >= budget) break;
      const a = rows[pair.i]!;
      const b = rows[pair.j]!;
      if (used.has(a.id) || used.has(b.id)) continue;
      if (await this.rejected(tenantId, partition(a), pairKey(a.id, b.id))) continue;
      out.judged++;
      let verdict;
      try {
        verdict = (await askProfile(this.d.gateway, tenantId, st.profile!, highest(a.label, b.label), consolidationMessages({ text: texts[pair.i]!, updatedAt: a.updated_at }, { text: texts[pair.j]!, updatedAt: b.updated_at }), consolidationSchema)).value;
      } catch (err) {
        out.failures++;
        this.d.log.warn({ err: (err as Error).message, profile: st.profile }, 'memory profile could not judge a pair; nothing proposed');
        continue;
      }
      const score = Math.round(pair.score * 1000) / 1000;
      if (verdict.relation === 'same' && verdict.merged) {
        if (await this.proposeMerge(a, b, verdict.merged, score, model)) {
          used.add(a.id);
          used.add(b.id);
          out.merges++;
        }
      } else if (verdict.relation === 'contradicts' && verdict.outdated) {
        const [outdated, by] = verdict.outdated === 'a' ? [a, b] : [b, a];
        if (await this.rejected(tenantId, partition(outdated), `expire:${outdated.id}:contradicted`)) continue;
        await this.proposeExpiry(outdated, { expiresAt: now + EXPIRY_GRACE_MS, reason: 'contradicted', by: by.id, similarity: score, proposedAt: now });
        used.add(outdated.id);
        out.expiries++;
      }
    }
    return out;
  }

  /** Files a merge proposal: a new proposed memory naming both sources, labelled as high as they are. */
  private async proposeMerge(a: MemoryRow, b: MemoryRow, merged: string, similarity: number, model: string): Promise<MemoryRow | null> {
    const text = normaliseProposal(merged);
    const label = highest(a.label, b.label);
    if (text.length < 4 || (await this.rejected(a.tenant_id, partition(a), text))) return null;
    let clean: string;
    try {
      clean = await this.checkWrite(null, a.tenant_id, a.scope === 'workspace' ? a.owner_id : null, text, label, { scope: a.scope, proposal: true, merge: [a.id, b.id] });
    } catch (err) {
      await this.d.audit.append({ tenantId: a.tenant_id, action: 'memory.proposal.refused', kind: 'system', actor: { service: CONSOLIDATE_JOB }, target: { merges: [a.id, b.id] }, label, detail: { reason: err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message } });
      return null;
    }
    const newer = a.updated_at >= b.updated_at ? a : b;
    const expiresAt = a.expires_at != null && b.expires_at != null ? Math.max(a.expires_at, b.expires_at) : null;
    const source = { merge: [a, b].map((m) => ({ memoryId: m.id, version: m.version, origin: m.origin, source: m.source })), similarity, model };
    const m = await this.insert({ tenantId: a.tenant_id, scope: a.scope, ownerId: a.owner_id, type: a.type === b.type ? a.type : newer.type, text: clean, label, sourceLabel: highest(a.source_label, b.source_label), state: 'proposed', origin: 'consolidation', source, authorId: null, acceptedBy: null, expiresAt, note: `proposed by consolidation: merges ${a.id} and ${b.id} (similarity ${similarity}); passed the memory checkpoint` });
    await this.d.audit.append({ tenantId: a.tenant_id, action: 'memory.merge.proposed', kind: 'system', actor: { service: CONSOLIDATE_JOB }, target: { memory: m.id, merges: [a.id, b.id], scope: a.scope }, label, detail: { similarity, model } });
    return m;
  }

  private async proposeExpiry(m: MemoryRow, proposal: ExpiryProposal): Promise<void> {
    await this.db('memories').where({ id: m.id }).update({ expiry_proposal: JSON.stringify(proposal) });
    await this.d.audit.append({ tenantId: m.tenant_id, action: 'memory.expiry.proposed', kind: 'system', actor: { service: CONSOLIDATE_JOB }, target: { memory: m.id, scope: m.scope, ...(proposal.by ? { by: proposal.by } : {}) }, label: m.label, detail: { reason: proposal.reason, expiresAt: proposal.expiresAt, similarity: proposal.similarity } });
  }

  // ---------- reindex (B-3703) ----------

  /** Queues a reindex of every active memory with the tenant's embedding model; recall is by recency until it ends. */
  async startReindex(p: Principal, ip: string | null, traceId: string): Promise<MemorySettings> {
    const model = await this.embedModel(p.tenantId, 'public');
    if (!model) throw conflict('There is no embedding model to reindex with.');
    const total = Number(((await this.db('memories').where({ tenant_id: p.tenantId, state: 'active' }).count({ n: '*' })) as { n: number }[])[0]?.n ?? 0);
    await this.saveSettings(p.tenantId, { reindex_state: 'running', reindex_model: model, reindex_done: 0, reindex_total: total, reindex_error: null, reindex_started_at: Date.now(), reindex_finished_at: null, reindex_job_id: null });
    const job = await this.d.jobs.enqueue({ tenantId: p.tenantId, type: REINDEX_JOB, payload: { tenantId: p.tenantId, model }, createdBy: p.userId, maxAttempts: 3 });
    await this.saveSettings(p.tenantId, { reindex_job_id: job.id });
    await this.d.audit.append({ tenantId: p.tenantId, action: 'memory.reindex.started', kind: 'admin', actor: actorFrom(p, ip), target: { job: job.id }, label: 'internal', traceId, detail: { model, memories: total } });
    return this.settings(p.tenantId);
  }

  /**
   * Embeds every active memory with the model (those already embedded with it are skipped, so a retry resumes),
   * in batches per label. A memory the model is not cleared for is left unembedded (recalled by recency). A newer
   * model change supersedes the run.
   */
  private async reindexJob(tenantId: string, model: string, ctx: JobContext): Promise<unknown> {
    const current = async () => (await this.settingsRow(tenantId)).reindex_model === model;
    if (!(await current())) return { superseded: true };
    try {
      await this.saveSettings(tenantId, { reindex_state: 'running', reindex_error: null });
      const rows = ((await this.db('memories').where({ tenant_id: tenantId, state: 'active' }).orderBy('id')) as Record<string, unknown>[]).map(fromRow);
      const todo = rows.filter((m) => m.embed_model !== model);
      let done = rows.length - todo.length;
      await this.saveSettings(tenantId, { reindex_total: rows.length, reindex_done: done });
      let skipped = 0;
      for (const label of LABELS) {
        const group = todo.filter((m) => m.label === label);
        if (!group.length) continue;
        const cleared = (await this.embedModel(tenantId, label)) === model;
        for (let i = 0; i < group.length; i += 32) {
          if (ctx.signal.aborted) throw new Error('The reindex was cancelled.');
          if (!(await current())) return { superseded: true, done };
          const batch = group.slice(i, i + 32);
          if (cleared) {
            const vecs = await this.d.embed(tenantId, model, await Promise.all(batch.map((m) => this.open(m, m.content))), label, null);
            await this.d.vectors.upsert(COLLECTION, batch.map((m, k) => ({ id: m.id, tenantId, partition: partition(m), labelRank: labelRank(m.label), vector: vecs[k]! })));
            await this.db('memories').whereIn('id', batch.map((m) => m.id)).update({ embed_model: model });
          } else {
            await this.d.vectors.delete(COLLECTION, batch.map((m) => m.id));
            await this.db('memories').whereIn('id', batch.map((m) => m.id)).update({ embed_model: null });
            skipped += batch.length;
          }
          done += batch.length;
          await this.saveSettings(tenantId, { reindex_done: done });
          await ctx.progress(rows.length ? Math.round((done / rows.length) * 100) : 100, `${done} of ${rows.length} memories`);
        }
      }
      await this.saveSettings(tenantId, { reindex_state: 'done', reindex_finished_at: Date.now() });
      await this.d.audit.append({ tenantId, action: 'memory.reindexed', kind: 'system', actor: { service: REINDEX_JOB }, target: { tenant: tenantId }, label: 'internal', detail: { model, memories: rows.length, embedded: todo.length - skipped, unembedded: skipped } });
      return { model, memories: rows.length, embedded: todo.length - skipped, unembedded: skipped };
    } catch (err) {
      if (await current()) await this.saveSettings(tenantId, { reindex_state: 'failed', reindex_error: (err as Error).message.slice(0, 500), reindex_finished_at: Date.now() });
      await this.d.audit.append({ tenantId, action: 'memory.reindex.failed', kind: 'system', actor: { service: REINDEX_JOB }, target: { tenant: tenantId }, label: 'internal', detail: { model, error: (err as Error).message.slice(0, 300) } });
      throw err;
    }
  }

  // ---------- export ----------

  async requestExport(p: Principal, tab: 'mine' | 'workspace' | 'agents', format: 'json' | 'csv') {
    if (tab !== 'mine' && !this.curator(p)) throw forbidden('Exporting workspace or agent memories needs the knowledge curator role.', { step: 'role', action: 'knowledge:manage' });
    if (tab === 'workspace' && !p.workspaceId) throw conflict('Pick a workspace first.');
    const id = ulid();
    const ownerId = tab === 'mine' ? p.userId : tab === 'workspace' ? p.workspaceId! : '*';
    const file = `memory-${tab}-${new Date().toISOString().slice(0, 10)}-${id.slice(-6).toLowerCase()}.${format}`;
    await this.db('memory_exports').insert({ id, tenant_id: p.tenantId, user_id: p.userId, scope: tab, owner_id: ownerId, format, file, state: 'queued', max_label: p.clearance, created_at: Date.now() });
    const job = await this.d.jobs.enqueue({ tenantId: p.tenantId, type: 'memory.export', payload: { exportId: id }, createdBy: p.userId });
    await this.db('memory_exports').where({ id }).update({ job_id: job.id });
    return { id, file, jobId: job.id };
  }

  async exportRow(p: Principal, id: string) {
    const r = (await this.db('memory_exports').where({ tenant_id: p.tenantId, id }).first()) as { id: string; user_id: string; state: string; file: string; format: string; rows: number | null; label: Label | null; blob_key: string | null; created_at: number } | undefined;
    if (!r || r.user_id !== p.userId) throw notFound('Export');
    return r;
  }

  async exportContent(tenantId: string, r: { id: string; blob_key: string | null }): Promise<Buffer> {
    if (!r.blob_key) throw conflict('The export file is not available.');
    const sealed = await this.d.blobs.get(r.blob_key);
    if (!sealed) throw conflict('The export file is missing.');
    return this.d.keys.openBytes(tenantId, sealed.toString(), `memory-export:${r.id}`);
  }

  private async exportJob(id: string): Promise<unknown> {
    const e = (await this.db('memory_exports').where({ id }).first()) as { id: string; tenant_id: string; user_id: string; scope: 'mine' | 'workspace' | 'agents'; owner_id: string; format: 'json' | 'csv'; max_label: Label };
    const q = this.db('memories').where({ tenant_id: e.tenant_id }).whereIn('label', labelsUpTo(e.max_label));
    if (e.scope === 'mine') q.andWhere({ scope: 'user', owner_id: e.owner_id });
    else if (e.scope === 'workspace') q.andWhere({ scope: 'workspace', owner_id: e.owner_id });
    else q.andWhere({ scope: 'agent' });
    const rows = ((await q.orderBy('created_at')) as Record<string, unknown>[]).map(fromRow);
    const items = [];
    for (const m of rows) {
      const versions = (await this.db('memory_versions').where({ memory_id: m.id }).orderBy('version')) as { version: number; note: string; created_at: number }[];
      items.push({ id: m.id, scope: m.scope, type: m.type, text: await this.open(m, m.content), label: m.label, state: m.state, origin: m.origin, source: m.source, author: m.author_id, expiresAt: m.expires_at ? new Date(m.expires_at).toISOString() : null, versions: versions.map((v) => ({ version: Number(v.version), note: v.note, at: new Date(Number(v.created_at)).toISOString() })) });
    }
    const top = highest(...rows.map((m) => m.label));
    const body = e.format === 'json' ? JSON.stringify({ exported: new Date().toISOString(), label: top, memories: items }, null, 2) : csvLine(['id', 'scope', 'type', 'text', 'label', 'state', 'origin', 'expires_at', 'versions']) + items.map((i) => csvLine([i.id, i.scope, i.type, i.text, i.label, i.state, i.origin, i.expiresAt, i.versions.map((v) => `v${v.version} ${v.note}`).join('; ')])).join('');
    const key = `memory-exports/${e.tenant_id}/${e.id}`;
    await this.d.blobs.put(key, Buffer.from(await this.d.keys.sealBytes(e.tenant_id, Buffer.from(body, 'utf8'), `memory-export:${e.id}`)));
    await this.db('memory_exports').where({ id }).update({ state: 'ready', rows: items.length, label: top, blob_key: key });
    await this.d.audit.append({ tenantId: e.tenant_id, action: 'memory.exported', kind: 'system', actor: { service: 'memory.export', user: e.user_id }, target: { export: e.id, scope: e.scope }, label: top, detail: { rows: items.length, format: e.format } });
    return { rows: items.length, label: top };
  }

  // ---------- expiry ----------

  async purgeExpired(tenantId: string): Promise<{ purged: number }> {
    const held = (await this.d.holds?.held(tenantId)) ?? { users: [], workspaces: [] };
    const rows = ((await this.db('memories').where({ tenant_id: tenantId }).whereNotNull('expires_at').andWhere('expires_at', '<=', Date.now())) as Record<string, unknown>[])
      .map(fromRow)
      .filter((m) => !((m.scope === 'user' && held.users.includes(m.owner_id)) || (m.scope === 'workspace' && held.workspaces.includes(m.owner_id))));
    for (const m of rows) {
      await this.forget(m);
      await this.d.audit.append({ tenantId, action: 'memory.expired', kind: 'system', actor: { service: 'memory.purge' }, target: { memory: m.id, scope: m.scope }, label: m.label });
    }
    return { purged: rows.length };
  }

  /** Audits a forget made through the API. */
  async auditForget(p: Principal, ip: string | null, traceId: string, m: MemoryRow, result: Record<string, unknown>): Promise<void> {
    await this.d.audit.append({ tenantId: p.tenantId, action: 'memory.forgotten', kind: 'admin', actor: actorFrom(p, ip), target: { memory: m.id, scope: m.scope, owner: m.owner_id }, label: m.label, detail: result, traceId });
  }
}
