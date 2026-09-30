import { ulid } from 'ulid';
import type { Logger } from 'pino';
import { json, type Db } from '../db/knex.js';
import { clears, highest, LABELS, labelRank, type Label } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { actorFrom, type AuditLog } from '../audit/chain.js';
import { csvLine } from '../audit/exports.js';
import type { AnswerEvent, ContextItem, ContextRequest } from '../chat/context.js';
import type { Guardrails } from '../guardrails/types.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { BlobStore } from '../platform/blob.js';
import type { DataKeys } from '../platform/datakeys.js';
import type { JobQueue } from '../platform/jobs.js';
import type { VectorStore } from '../platform/vectors.js';
import type { Gateway } from '../gateway/gateway.js';
import type { TermKeys } from '../knowledge/terms.js';

export type MemoryScope = 'user' | 'workspace' | 'agent';
export type MemoryState = 'proposed' | 'active' | 'superseded';
export const USER_TYPES = ['user', 'episodic'] as const;
export const WORKSPACE_TYPES = ['convention', 'glossary', 'contact'] as const;
const COLLECTION = 'memory';

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
  source: { conversationId: string; messageId: string } | null;
  origin: 'manual' | 'chat' | 'extraction';
  author_id: string | null;
  accepted_by: string | null;
  embed_model: string | null;
  expires_at: number | null;
  version: number;
  created_at: number;
  updated_at: number;
}

const num = (v: unknown) => (v == null ? null : Number(v));
const fromRow = (r: Record<string, unknown>): MemoryRow => ({ ...(r as unknown as MemoryRow), source: json(r.source, null), expires_at: num(r.expires_at), version: Number(r.version), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
const labelsUpTo = (l: Label): Label[] => LABELS.filter((x) => labelRank(x) <= labelRank(l));
const partition = (m: Pick<MemoryRow, 'scope' | 'owner_id'>) => `${m.scope}:${m.owner_id}`;

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
}

/**
 * Memory: labelled facts that outlive a conversation, in three scopes (a user's own, a workspace's conventions,
 * glossary and contacts, and agents' progress and tool quirks). Nothing is remembered until a person accepts it:
 * chat proposes, the user (or a curator, for a workspace) accepts or rejects, and a rejected text is not proposed
 * again. Every write and every read into a prompt passes the `memory` checkpoint; credentials are never stored and
 * restricted memories are refused by tenant policy. Text is sealed; embeddings live in the `VectorStore`; forgetting
 * deletes the record, its versions, its vector and every export file that could hold it, and is audited.
 */
export class MemoryService {
  private readonly db: Db;

  constructor(private readonly d: MemoryDeps) {
    this.db = d.db;
    d.jobs.register('memory.extract', (p) => this.extractJob(p));
    d.jobs.register('memory.export', (p) => this.exportJob(String(p.exportId)));
    d.jobs.register('memory.purge', (p, ctx) => this.purgeExpired(String(p.tenantId ?? ctx.job.tenant_id)));
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

  /** The first approved embedding model in the catalogue, or none (memories are then recalled by recency). */
  private async embedModel(label: Label): Promise<string | null> {
    const models = (await this.d.gateway.repo.models()).filter((m) => m.capabilities.includes('embedding') && (m.state === 'approved' || m.state === 'deprecated') && labelRank(m.label) >= labelRank(label));
    return models.sort((a, b) => (a.name < b.name ? -1 : 1))[0]?.name ?? null;
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
    if (m.source) {
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
      author: m.author_id ? (names.get(m.author_id) ?? null) : m.scope === 'agent' ? m.owner_id : null,
      authorId: m.author_id,
      acceptedBy: m.accepted_by ? (names.get(m.accepted_by) ?? null) : null,
      backend: this.backend,
      embedded: !!m.embed_model,
      expiresAt: m.expires_at,
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
      const model = await this.embedModel(m.label);
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

  async accept(p: Principal, id: string): Promise<MemoryRow> {
    const m = await this.visible(p, id, 'write');
    if (m.state !== 'proposed') throw conflict(`This memory is ${m.state}.`);
    const text = await this.open(m, m.content);
    await this.checkWrite(p, m.tenant_id, p.workspaceId ?? null, text, m.label, { scope: m.scope, accept: true });
    await this.db('memories').where({ id: m.id }).update({ state: 'active', accepted_by: p.userId, version: m.version + 1, updated_at: Date.now() });
    await this.db('memory_versions').insert({ id: ulid(), memory_id: m.id, tenant_id: m.tenant_id, version: m.version + 1, content: null, note: 'accepted', actor: p.userId, created_at: Date.now() });
    await this.embed({ ...m, state: 'active' }, text);
    return this.get(p.tenantId, id);
  }

  /** Discards a proposal and remembers not to propose the same text again. */
  async reject(p: Principal, id: string): Promise<MemoryRow> {
    const m = await this.visible(p, id, 'write');
    if (m.state !== 'proposed') throw conflict(`This memory is ${m.state}; forget it instead.`);
    const text = await this.open(m, m.content);
    const hash = await this.d.terms.text(m.tenant_id, 'memory-reject', text.toLowerCase());
    await this.db('memory_rejections').insert({ tenant_id: m.tenant_id, owner_key: partition(m), hash, created_at: Date.now() }).catch(() => undefined);
    await this.db('memories').where({ id: m.id }).delete();
    return m;
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
      .enqueue({ tenantId: e.tenantId, type: 'memory.extract', payload: { messageId: e.userMessageId, conversationId: e.conversationId, userId: e.principal.userId, workspaceId: e.workspaceId }, createdBy: e.principal.userId, maxAttempts: 1 })
      .catch((err: Error) => this.d.log.warn({ err: err.message }, 'memory extraction could not be queued'));
  }

  private async extractJob(p: Record<string, unknown>): Promise<unknown> {
    const msg = (await this.db('messages').where({ id: String(p.messageId) }).first()) as { id: string; tenant_id: string; content: string | null; label: Label; role: string } | undefined;
    if (!msg || msg.role !== 'user' || !msg.content) return { proposals: 0 };
    const text = await this.d.keys.open(msg.tenant_id, msg.content, `content:${msg.id}`);
    const userId = String(p.userId);
    let proposals = 0;
    const refused: string[] = [];
    for (const candidate of extractProposals(text)) {
      const hash = await this.d.terms.text(msg.tenant_id, 'memory-reject', candidate.toLowerCase());
      if (await this.db('memory_rejections').where({ tenant_id: msg.tenant_id, owner_key: `user:${userId}`, hash }).first()) continue;
      const existing = ((await this.db('memories').where({ tenant_id: msg.tenant_id, scope: 'user', owner_id: userId })) as Record<string, unknown>[]).map(fromRow);
      let dup = false;
      for (const e of existing) if ((await this.open(e, e.content)).toLowerCase() === candidate.toLowerCase()) dup = true;
      if (dup) continue;
      try {
        const clean = await this.checkWrite(null, msg.tenant_id, (p.workspaceId as string | null) ?? null, candidate, msg.label, { scope: 'user', proposal: true });
        await this.insert({ tenantId: msg.tenant_id, scope: 'user', ownerId: userId, type: 'user', text: clean, label: msg.label, sourceLabel: msg.label, state: 'proposed', origin: 'extraction', source: { conversationId: String(p.conversationId), messageId: msg.id }, authorId: null, acceptedBy: null, expiresAt: null, note: 'proposed after a chat turn; passed the memory checkpoint' });
        proposals++;
      } catch (err) {
        refused.push(err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message);
        await this.d.audit.append({ tenantId: msg.tenant_id, action: 'memory.proposal.refused', kind: 'system', actor: { service: 'memory.extract', user: userId }, target: { message: msg.id }, label: msg.label, detail: { reason: refused[refused.length - 1] } });
      }
    }
    return { proposals, refused: refused.length };
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
    const model = await this.embedModel('public');
    if (model && req.query.trim()) {
      try {
        const [vec] = await this.d.embed(req.tenantId, model, [req.query], req.label, req.principal.userId);
        const hits = await this.d.vectors.search(COLLECTION, { tenantId: req.tenantId, vector: vec!, k: 8, maxLabelRank: labelRank(req.ceiling), partitions: parts });
        const byVector = hits.length ? ((await base().whereIn('id', hits.map((h) => h.id))) as Record<string, unknown>[]).map(fromRow) : [];
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
    const rows = ((await this.db('memories').where({ tenant_id: tenantId }).whereNotNull('expires_at').andWhere('expires_at', '<=', Date.now())) as Record<string, unknown>[]).map(fromRow);
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
