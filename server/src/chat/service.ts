import { ulid } from 'ulid';
import type { Logger } from 'pino';
import { json, type Db } from '../db/knex.js';
import { clears, highest, labelRank, type Label } from '../authz/labels.js';
import { authorize, type Principal } from '../authz/policy.js';
import { actorFrom, type AuditLog } from '../audit/chain.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { TOPICS, type Bus } from '../platform/bus.js';
import type { DataKeys } from '../platform/datakeys.js';
import type { QuotaService } from '../tenancy/quotas.js';
import { QueueTimeout, type Gateway, type Lease, type ResolvedProfile } from '../gateway/gateway.js';
import { THINK_LEVELS, type ProfileRow, type ThinkLevel } from '../gateway/repo.js';
import type { ChatMessage } from '../gateway/ollama.js';
import { CALCULATE_TOOL, type CalcWorker } from './calc.js';
import type { AttachmentRow, AttachmentService } from './attachments.js';
import { allowAll, type GuardDecision, type Guardrails } from '../guardrails/types.js';
import type { ResolvedTool, ToolDispatcher } from '../registry/dispatch.js';
import { formatContext, type AnswerEvent, type ContextItem, type ContextProvider } from './context.js';

export type MessageState = 'queued' | 'streaming' | 'complete' | 'stopped' | 'failed';

export interface ConversationRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  user_id: string;
  kind: 'chat' | 'compare';
  title: string | null;
  profile_id: string | null;
  label: Label;
  head_id: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  tenant_id: string;
  parent_id: string | null;
  role: 'user' | 'assistant';
  content: string | null;
  thinking: string | null;
  tools: string | null;
  state: MessageState;
  profile_id: string | null;
  profile_name: string | null;
  model: string | null;
  instance_id: string | null;
  think: ThinkLevel | null;
  compare_slot: number | null;
  error: string | null;
  label: Label;
  attachments: string | null;
  prompt_tokens: number | null;
  output_tokens: number | null;
  thinking_tokens: number | null;
  calc_calls: number | null;
  gpu_ms: number | null;
  first_token_ms: number | null;
  seq: number;
  canary: boolean;
  created_at: number;
  completed_at: number | null;
  /** JSON: the guardrail outcome of an answer (Sprint 5). */
  guard?: string | null;
  citations?: string | null;
}

export interface Chunk {
  seq: number;
  delta?: string;
  thinking?: string;
  tool?: { name: string; expression: string; result?: { fraction: string; decimal: string; exact: boolean }; error?: string; output?: unknown };
}

interface Stream {
  messageId: string;
  conversationId: string;
  userId: string;
  tenantId: string;
  chunks: Chunk[];
  seq: number;
  content: string;
  thinking: string;
  tools: NonNullable<Chunk['tool']>[];
  state: MessageState;
  ac: AbortController;
  stopRequested: boolean;
  lastFlush: number;
}

export interface Usage {
  promptTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  calcCalls: number;
  gpuMs: number;
  firstTokenMs: number | null;
}

const thinkRank = (t: ThinkLevel) => THINK_LEVELS.indexOf(t);
const MAX_TOOL_ROUNDS = 6;
const ATTACHMENT_TEXT_LIMIT = 100_000;

/**
 * Conversations and generation. A conversation is a tree of messages; `head_id` is the leaf the user is looking at.
 * Editing a user message or regenerating an answer adds a sibling, so every branch is kept. Titles, content and
 * thinking are sealed with the tenant key. Tokens stream to the user's sockets as `chat.chunk` events with sequence
 * numbers; a client that misses some asks `/api/messages/:id/stream?after=<seq>` to catch up.
 */
export class ChatService {
  private readonly streams = new Map<string, Stream>();
  private readonly offStop: () => void;
  private toolDispatch: ToolDispatcher | null = null;
  /** Knowledge and memory add retrieved context to each answer (`context.ts`). */
  readonly contextProviders: ContextProvider[] = [];
  /** Called when an answer finishes (memory proposals). */
  readonly answerListeners: ((e: AnswerEvent) => void)[] = [];

  constructor(
    private readonly db: Db,
    private readonly keys: DataKeys,
    private readonly gateway: Gateway,
    private readonly quotas: QuotaService,
    private readonly audit: AuditLog,
    private readonly bus: Bus,
    private readonly attachments: AttachmentService,
    private readonly calc: CalcWorker,
    private readonly log: Logger,
    private readonly guardrails: Guardrails = allowAll
  ) {
    this.offStop = bus.on<{ messageId: string }>(TOPICS.chatStop, ({ messageId }) => this.abortLocal(messageId));
  }

  /** Registry and MCP tools on a profile's tool list are offered and called through the dispatcher (Sprint 7). */
  useTools(d: ToolDispatcher): void {
    this.toolDispatch = d;
  }

  close(): void {
    this.offStop();
    for (const st of this.streams.values()) {
      st.stopRequested = true;
      st.ac.abort(new Error('shutting down'));
    }
  }

  // ---------- sealing ----------

  private seal(tenantId: string, id: string, field: string, value: string | null): Promise<string | null> {
    return value == null ? Promise.resolve(null) : this.keys.seal(tenantId, value, `${field}:${id}`);
  }

  private async open(tenantId: string, id: string, field: string, value: string | null): Promise<string | null> {
    if (value == null) return null;
    return this.keys.open(tenantId, value, `${field}:${id}`);
  }

  // ---------- conversations ----------

  async listConversations(p: Principal, opts: { limit?: number; kind?: 'chat' | 'compare'; archived?: boolean } = {}) {
    const q = this.db('conversations').where({ tenant_id: p.tenantId, user_id: p.userId });
    if (p.workspaceId) q.andWhere({ workspace_id: p.workspaceId });
    else q.whereNull('workspace_id');
    if (opts.kind) q.andWhere({ kind: opts.kind });
    if (opts.archived) q.whereNotNull('archived_at');
    else q.whereNull('archived_at');
    const rows = (await q.orderBy('updated_at', 'desc').limit(Math.min(opts.limit ?? 100, 500))) as ConversationRow[];
    return Promise.all(rows.map(async (c) => ({ id: c.id, kind: c.kind, title: await this.open(c.tenant_id, c.id, 'title', c.title), label: c.label, profileId: c.profile_id, workspaceId: c.workspace_id, updatedAt: Number(c.updated_at), createdAt: Number(c.created_at), archived: c.archived_at != null })));
  }

  async conversation(p: Principal, id: string): Promise<ConversationRow> {
    const c = (await this.db('conversations').where({ tenant_id: p.tenantId, id }).first()) as ConversationRow | undefined;
    if (!c || c.user_id !== p.userId) throw notFound('Conversation');
    return { ...c, created_at: Number(c.created_at), updated_at: Number(c.updated_at), archived_at: c.archived_at == null ? null : Number(c.archived_at) };
  }

  async createConversation(p: Principal, input: { title?: string | null; label?: Label; kind?: 'chat' | 'compare'; profileId?: string | null }): Promise<ConversationRow> {
    const ws = p.workspaceId ? ((await this.db('workspaces').where({ id: p.workspaceId }).first('label_ceiling')) as { label_ceiling: Label } | undefined) : undefined;
    const label = input.label ?? 'internal';
    if (!clears(p.clearance, label)) throw forbidden(`Your clearance is ${p.clearance}; a ${label} conversation is above it.`, { step: 'clearance' });
    if (ws && labelRank(label) > labelRank(ws.label_ceiling)) throw forbidden(`This workspace's ceiling is ${ws.label_ceiling}.`, { step: 'zone' });
    const t = Date.now();
    const id = ulid();
    const row: ConversationRow = { id, tenant_id: p.tenantId, workspace_id: p.workspaceId ?? null, user_id: p.userId, kind: input.kind ?? 'chat', title: await this.seal(p.tenantId, id, 'title', input.title ?? null), profile_id: input.profileId ?? null, label, head_id: null, created_at: t, updated_at: t, archived_at: null };
    await this.db('conversations').insert(row);
    return row;
  }

  async updateConversation(p: Principal, id: string, patch: { title?: string; archived?: boolean; label?: Label; headId?: string }): Promise<void> {
    const c = await this.conversation(p, id);
    const upd: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.title !== undefined) upd.title = await this.seal(c.tenant_id, c.id, 'title', patch.title);
    if (patch.archived !== undefined) upd.archived_at = patch.archived ? Date.now() : null;
    if (patch.label !== undefined) {
      // A label only rises (high-water mark): content already in the conversation keeps its classification.
      if (labelRank(patch.label) < labelRank(c.label)) throw conflict(`A conversation's label never goes down; it is ${c.label}.`);
      if (!clears(p.clearance, patch.label)) throw forbidden('Above your clearance.', { step: 'clearance' });
      upd.label = patch.label;
    }
    if (patch.headId !== undefined) {
      const m = await this.message(c, patch.headId);
      upd.head_id = await this.leafOf(c.id, m.id);
    }
    await this.db('conversations').where({ id: c.id }).update(upd);
  }

  async deleteConversation(p: Principal, id: string): Promise<void> {
    const c = await this.conversation(p, id);
    for (const m of (await this.db('messages').where({ conversation_id: c.id }).select('id')) as { id: string }[]) this.abortLocal(m.id);
    await this.db('messages').where({ conversation_id: c.id }).delete();
    await this.db('conversations').where({ id: c.id }).delete();
  }

  private async message(c: ConversationRow, id: string): Promise<MessageRow> {
    const m = (await this.db('messages').where({ conversation_id: c.id, id }).first()) as MessageRow | undefined;
    if (!m) throw notFound('Message');
    return m;
  }

  /** The newest leaf under a message, following the most recent child at each step. */
  private async leafOf(conversationId: string, id: string): Promise<string> {
    const all = (await this.db('messages').where({ conversation_id: conversationId }).select('id', 'parent_id', 'created_at')) as { id: string; parent_id: string | null; created_at: number }[];
    let cur = id;
    for (;;) {
      const kids = all.filter((x) => x.parent_id === cur).sort((a, b) => Number(b.created_at) - Number(a.created_at) || (a.id < b.id ? 1 : -1));
      if (!kids.length) return cur;
      cur = kids[0]!.id;
    }
  }

  /** The whole tree, opened, for the conversation view. */
  async view(p: Principal, id: string) {
    const c = await this.conversation(p, id);
    const rows = (await this.db('messages').where({ conversation_id: c.id }).orderBy([{ column: 'created_at' }, { column: 'id' }])) as MessageRow[];
    const messages = await Promise.all(rows.map((m) => this.messageView(m)));
    return { id: c.id, kind: c.kind, title: await this.open(c.tenant_id, c.id, 'title', c.title), label: c.label, profileId: c.profile_id, workspaceId: c.workspace_id, headId: c.head_id, createdAt: c.created_at, updatedAt: c.updated_at, archived: c.archived_at != null, messages };
  }

  private async messageView(m: MessageRow) {
    const live = this.streams.get(m.id);
    const tools = live ? live.tools : json<Chunk['tool'][]>(await this.open(m.tenant_id, m.id, 'tools', m.tools), []);
    return {
      id: m.id,
      parentId: m.parent_id,
      role: m.role,
      content: live ? live.content : ((await this.open(m.tenant_id, m.id, 'content', m.content)) ?? ''),
      thinking: live ? live.thinking : await this.open(m.tenant_id, m.id, 'thinking', m.thinking),
      tools,
      state: live ? live.state : m.state,
      seq: live ? live.seq : Number(m.seq),
      profileId: m.profile_id,
      profile: m.profile_name,
      model: m.model,
      think: m.think,
      compareSlot: m.compare_slot,
      canary: !!m.canary,
      error: m.error,
      label: m.label,
      attachments: json<string[]>(m.attachments, []),
      citations: json<Record<string, unknown>[]>(await this.open(m.tenant_id, m.id, 'citations', m.citations ?? null), []),
      usage: m.role === 'assistant' && m.completed_at ? { promptTokens: Number(m.prompt_tokens ?? 0), outputTokens: Number(m.output_tokens ?? 0), thinkingTokens: Number(m.thinking_tokens ?? 0), calcCalls: Number(m.calc_calls ?? 0), gpuMs: Number(m.gpu_ms ?? 0), firstTokenMs: m.first_token_ms == null ? null : Number(m.first_token_ms) } : null,
      createdAt: Number(m.created_at),
      completedAt: m.completed_at == null ? null : Number(m.completed_at),
      guard: json<Record<string, unknown> | null>(m.guard ?? null, null)
    };
  }

  // ---------- profiles ----------

  /** Profiles the caller may pick: published, with a usable model, labelled at or below their clearance. */
  async profilesFor(p: Principal) {
    const rows = await this.gateway.repo.profiles(p.tenantId);
    const models = await this.gateway.repo.models();
    const snap = await this.gateway.snapshot();
    const loaded = new Set(snap.flatMap((x) => x.instances.flatMap((i) => i.loaded.map((l) => l.name))));
    const out = [];
    for (const row of rows.filter((x) => x.status === 'published')) {
      let target: ProfileRow | undefined = row;
      for (let i = 0; target?.alias_of && i < 5; i++) target = rows.find((x) => x.id === target!.alias_of);
      if (!target || target.alias_of || target.status !== 'published') continue;
      const m = models.find((x) => x.id === target!.model_id);
      if (!m || (m.state !== 'approved' && m.state !== 'deprecated')) continue;
      if (!clears(p.clearance, target.label)) continue;
      out.push({
        id: row.id,
        name: row.name,
        displayName: row.display_name,
        description: row.description ?? target.description,
        aliasOf: row.alias_of ? target.name : null,
        model: m.name,
        label: target.label,
        thinkDefault: target.think_default,
        thinkCeiling: target.think_ceiling,
        tools: target.tools,
        vision: m.capabilities.includes('vision'),
        residency: loaded.has(m.name) || loaded.has(`${m.name}:latest`) ? 'loaded' : 'cold',
        deprecated: m.state === 'deprecated'
      });
    }
    return out;
  }

  // ---------- sending ----------

  private async resolveFor(p: Principal, profile: string, label: Label): Promise<ResolvedProfile> {
    let r: ResolvedProfile;
    try {
      r = await this.gateway.resolve(p.tenantId, profile);
    } catch (err) {
      // Name the profile, so a client comparing several can tell which one is unavailable.
      if (err instanceof HttpProblem) Object.assign(err.extensions, { profile });
      throw err;
    }
    if (r.model.state !== 'approved' && r.model.state !== 'deprecated') {
      throw new HttpProblem(409, 'Profile unavailable', `Profile ${r.profile.name} routes to ${r.model.name}, which is ${r.model.state}.`, { extensions: { profile } });
    }
    if (!clears(p.clearance, r.profile.label)) throw forbidden(`Profile ${r.profile.name} needs ${r.profile.label} clearance.`, { step: 'clearance' });
    const d = authorize(p, 'inference:invoke', { tenantId: p.tenantId, label, zoneCeiling: r.profile.label });
    if (!d.allow) throw forbidden(d.step === 'zone' ? `This conversation is ${label}; profile ${r.profile.name} only handles data up to ${r.profile.label}.` : d.reason, { step: d.step, action: 'inference:invoke' });
    return r;
  }

  private thinkLevel(profile: ProfileRow, requested?: ThinkLevel): ThinkLevel {
    const want = requested ?? profile.think_default;
    return thinkRank(want) > thinkRank(profile.think_ceiling) ? profile.think_ceiling : want;
  }

  private async admit(p: Principal, workspaceId: string | null): Promise<void> {
    const [tenant, ws] = await Promise.all([this.db('tenants').where({ id: p.tenantId }).first('name'), workspaceId ? this.db('workspaces').where({ id: workspaceId }).first('name') : undefined]);
    await this.quotas.admit(p.tenantId, workspaceId, { tenantName: tenant?.name, workspaceName: ws?.name });
  }

  private async readyAttachments(p: Principal, ids: string[]): Promise<AttachmentRow[]> {
    const out: AttachmentRow[] = [];
    for (const id of ids) {
      const a = await this.attachments.get(p.tenantId, id);
      if (!a || a.user_id !== p.userId) throw notFound('Attachment');
      if (a.state !== 'ready') throw conflict(`${a.name} is ${a.state}${a.reason ? `: ${a.reason}` : ''}.`);
      out.push(a);
    }
    return out;
  }

  /** Sends a user message (as a child of `parentId`, or of the head) and starts the answer. */
  async send(p: Principal, conversationId: string, input: { content: string; parentId?: string | null; profile: string; think?: ThinkLevel; attachments?: string[]; label?: Label }) {
    const c = await this.conversation(p, conversationId);
    if (c.kind !== 'chat') throw conflict('This is a comparison; start a chat from one of its answers instead.');
    const atts = await this.readyAttachments(p, input.attachments ?? []);
    const label = highest(c.label, input.label ?? 'public', ...atts.map((a) => a.label));
    const r = await this.resolveFor(p, input.profile, label);
    if (atts.some((a) => a.type.startsWith('image/')) && !r.model.capabilities.includes('vision')) throw conflict(`${r.model.name} cannot read images; pick a profile with a vision model.`);
    await this.admit(p, c.workspace_id);

    const parentId = input.parentId === undefined ? c.head_id : input.parentId;
    if (parentId) {
      const parent = await this.message(c, parentId);
      if (parent.role !== 'assistant') throw conflict('A new message follows an answer.');
    }
    const content = await this.guardInput(p, c.workspace_id, input.content, label, c.id);
    const t = Date.now();
    const user = await this.insertMessage(c, { parent_id: parentId ?? null, role: 'user', content, label, attachments: atts.map((a) => a.id), created_at: t });
    const think = this.thinkLevel(r.profile, input.think);
    const assistant = await this.insertMessage(c, { parent_id: user.id, role: 'assistant', content: '', label, profile: r, think, created_at: t + 1 });
    const title = c.title ? undefined : await this.seal(c.tenant_id, c.id, 'title', content.replace(/\s+/g, ' ').trim().slice(0, 80));
    await this.db('conversations').where({ id: c.id }).update({ head_id: assistant.id, label, profile_id: r.profile.id, updated_at: Date.now(), ...(title ? { title } : {}) });
    this.start(p, { ...c, label }, assistant, r, think, 'chat');
    return { userMessageId: user.id, messageId: assistant.id, profile: r.profile.name, model: r.model.name, think, label };
  }

  /** A new answer beside an existing one (same question), optionally with another profile or thinking level. */
  async regenerate(p: Principal, conversationId: string, messageId: string, input: { profile?: string; think?: ThinkLevel }) {
    const c = await this.conversation(p, conversationId);
    const old = await this.message(c, messageId);
    if (old.role !== 'assistant' || !old.parent_id) throw conflict('Only answers can be regenerated.');
    const r = await this.resolveFor(p, input.profile ?? old.profile_id ?? old.profile_name ?? '', c.label);
    await this.admit(p, c.workspace_id);
    const think = this.thinkLevel(r.profile, input.think ?? old.think ?? undefined);
    const assistant = await this.insertMessage(c, { parent_id: old.parent_id, role: 'assistant', content: '', label: c.label, profile: r, think, compare_slot: old.compare_slot, created_at: Date.now() });
    await this.db('conversations').where({ id: c.id }).update({ head_id: assistant.id, updated_at: Date.now() });
    this.start(p, c, assistant, r, think, c.kind);
    return { messageId: assistant.id, profile: r.profile.name, model: r.model.name, think };
  }

  /** Edits a question: a sibling user message with the new text, and a new answer under it. */
  async edit(p: Principal, conversationId: string, messageId: string, input: { content: string; profile?: string; think?: ThinkLevel }) {
    const c = await this.conversation(p, conversationId);
    const old = await this.message(c, messageId);
    if (old.role !== 'user') throw conflict('Only your own messages can be edited.');
    if (c.kind !== 'chat') throw conflict('Comparisons cannot be edited.');
    const prevAnswer = (await this.db('messages').where({ conversation_id: c.id, parent_id: old.id }).orderBy('created_at', 'desc').first()) as MessageRow | undefined;
    const r = await this.resolveFor(p, input.profile ?? prevAnswer?.profile_id ?? c.profile_id ?? '', c.label);
    await this.admit(p, c.workspace_id);
    const content = await this.guardInput(p, c.workspace_id, input.content, c.label, c.id);
    const t = Date.now();
    const user = await this.insertMessage(c, { parent_id: old.parent_id, role: 'user', content, label: c.label, attachments: json<string[]>(old.attachments, []), created_at: t });
    const think = this.thinkLevel(r.profile, input.think);
    const assistant = await this.insertMessage(c, { parent_id: user.id, role: 'assistant', content: '', label: c.label, profile: r, think, created_at: t + 1 });
    await this.db('conversations').where({ id: c.id }).update({ head_id: assistant.id, updated_at: Date.now() });
    this.start(p, c, assistant, r, think, 'chat');
    return { userMessageId: user.id, messageId: assistant.id, profile: r.profile.name, model: r.model.name, think };
  }

  /** Compare: one prompt, 2–4 profiles answering in parallel, each metered on its own. */
  async compare(p: Principal, input: { prompt: string; profiles: string[]; think?: ThinkLevel; label?: Label }) {
    const label = input.label ?? 'internal';
    const resolved: ResolvedProfile[] = [];
    for (const name of input.profiles) resolved.push(await this.resolveFor(p, name, label));
    await this.admit(p, p.workspaceId ?? null);
    const prompt = await this.guardInput(p, p.workspaceId ?? null, input.prompt, label, null);
    const c = await this.createConversation(p, { title: prompt.replace(/\s+/g, ' ').trim().slice(0, 80), label, kind: 'compare' });
    const t = Date.now();
    const user = await this.insertMessage(c, { parent_id: null, role: 'user', content: prompt, label, created_at: t });
    const columns = [];
    for (const [i, r] of resolved.entries()) {
      const think = this.thinkLevel(r.profile, input.think);
      const m = await this.insertMessage(c, { parent_id: user.id, role: 'assistant', content: '', label, profile: r, think, compare_slot: i, created_at: t + 1 + i });
      columns.push({ slot: i, messageId: m.id, profile: r.profile.name, model: r.model.name, think, canary: r.canary });
      this.start(p, c, m, r, think, 'compare');
    }
    await this.db('conversations').where({ id: c.id }).update({ head_id: columns[0]!.messageId });
    return { conversationId: c.id, userMessageId: user.id, columns };
  }

  private async insertMessage(c: ConversationRow, m: { parent_id: string | null; role: 'user' | 'assistant'; content: string; label: Label; attachments?: string[]; profile?: ResolvedProfile; think?: ThinkLevel; compare_slot?: number | null; created_at: number }): Promise<MessageRow> {
    const id = ulid();
    const row: MessageRow = {
      id,
      conversation_id: c.id,
      tenant_id: c.tenant_id,
      parent_id: m.parent_id,
      role: m.role,
      content: await this.seal(c.tenant_id, id, 'content', m.content),
      thinking: null,
      tools: null,
      state: m.role === 'user' ? 'complete' : 'queued',
      profile_id: m.profile?.profile.id ?? null,
      profile_name: m.profile?.profile.name ?? null,
      model: m.profile?.model.name ?? null,
      instance_id: null,
      think: m.think ?? null,
      compare_slot: m.compare_slot ?? null,
      error: null,
      label: m.label,
      attachments: m.attachments?.length ? JSON.stringify(m.attachments) : null,
      prompt_tokens: null,
      output_tokens: null,
      thinking_tokens: null,
      calc_calls: null,
      gpu_ms: null,
      first_token_ms: null,
      seq: 0,
      canary: m.profile?.canary ?? false,
      created_at: m.created_at,
      completed_at: m.role === 'user' ? m.created_at : null
    };
    await this.db('messages').insert(row);
    return row;
  }

  // ---------- stop and resume ----------

  async stop(p: Principal, conversationId: string, messageId: string): Promise<{ state: MessageState }> {
    const c = await this.conversation(p, conversationId);
    const m = await this.message(c, messageId);
    if (m.state !== 'queued' && m.state !== 'streaming') return { state: m.state };
    if (!this.abortLocal(messageId)) this.bus.publish(TOPICS.chatStop, { messageId });
    return { state: 'stopped' };
  }

  private abortLocal(messageId: string): boolean {
    const st = this.streams.get(messageId);
    if (!st || st.state === 'complete' || st.state === 'failed' || st.state === 'stopped') return false;
    st.stopRequested = true;
    st.ac.abort(new Error('stopped'));
    return true;
  }

  /** Chunks after `after` while streaming here; otherwise the stored message. */
  async resume(p: Principal, conversationId: string, messageId: string, after: number) {
    const c = await this.conversation(p, conversationId);
    const st = this.streams.get(messageId);
    if (st) return { state: st.state, seq: st.seq, chunks: st.chunks.filter((x) => x.seq > after) };
    const m = await this.message(c, messageId);
    const v = await this.messageView(m);
    return { state: v.state, seq: v.seq, content: v.content, thinking: v.thinking, tools: v.tools, usage: v.usage, error: v.error };
  }

  // ---------- generation ----------

  private emit(st: Pick<Stream, 'userId'>, event: string, data: Record<string, unknown>): void {
    this.bus.publish(TOPICS.chatEvent, { userId: st.userId, event, data });
  }

  private start(p: Principal, c: ConversationRow, m: MessageRow, r: ResolvedProfile, think: ThinkLevel, kind: 'chat' | 'compare'): void {
    const st: Stream = { messageId: m.id, conversationId: c.id, userId: p.userId, tenantId: c.tenant_id, chunks: [], seq: 0, content: '', thinking: '', tools: [], state: 'queued', ac: new AbortController(), stopRequested: false, lastFlush: Date.now() };
    this.streams.set(m.id, st);
    void this.generate(p, c, m, r, think, kind, st)
      .catch((err) => this.log.error({ err, message: m.id }, 'generation crashed'))
      .finally(() => {
        // Keep the buffer a little while for clients catching up, then rely on the stored message.
        setTimeout(() => {
          if (this.streams.get(m.id) === st) this.streams.delete(m.id);
        }, 60_000).unref();
      });
  }

  private push(st: Stream, chunk: Omit<Chunk, 'seq'>): void {
    const c: Chunk = { seq: ++st.seq, ...chunk };
    st.chunks.push(c);
    this.emit(st, 'chat.chunk', { conversationId: st.conversationId, messageId: st.messageId, ...c });
  }

  private async flush(st: Stream, final: Record<string, unknown> = {}): Promise<void> {
    st.lastFlush = Date.now();
    await this.db('messages')
      .where({ id: st.messageId })
      .update({
        content: await this.seal(st.tenantId, st.messageId, 'content', st.content),
        thinking: st.thinking ? await this.seal(st.tenantId, st.messageId, 'thinking', st.thinking) : null,
        tools: st.tools.length ? await this.seal(st.tenantId, st.messageId, 'tools', JSON.stringify(st.tools)) : null,
        seq: st.seq,
        state: st.state,
        ...final
      });
  }

  /** The path from the root to a message, opened, as Ollama chat messages (failed answers left out). */
  private async history(c: ConversationRow, parentId: string, vision: boolean): Promise<ChatMessage[]> {
    const rows = (await this.db('messages').where({ conversation_id: c.id })) as MessageRow[];
    const byId = new Map(rows.map((x) => [x.id, x]));
    const path: MessageRow[] = [];
    for (let cur = byId.get(parentId); cur; cur = cur.parent_id ? byId.get(cur.parent_id) : undefined) path.unshift(cur);
    const out: ChatMessage[] = [];
    for (const m of path) {
      if (m.role === 'assistant' && (m.state === 'failed' || m.state === 'queued')) continue;
      let content = (await this.open(m.tenant_id, m.id, 'content', m.content)) ?? '';
      const images: string[] = [];
      for (const aid of json<string[]>(m.attachments, [])) {
        const a = await this.attachments.get(c.tenant_id, aid);
        if (!a || a.state !== 'ready') continue;
        const data = await this.attachments.content(a);
        if (a.type.startsWith('image/')) {
          if (vision) images.push(data.toString('base64'));
        } else {
          const text = data.toString('utf8');
          content += `\n\n<attachment name="${a.name.replace(/"/g, "'")}" label="${a.label}">\n${text.slice(0, ATTACHMENT_TEXT_LIMIT)}${text.length > ATTACHMENT_TEXT_LIMIT ? '\n[truncated]' : ''}\n</attachment>`;
        }
      }
      out.push({ role: m.role, content, ...(images.length ? { images } : {}) });
    }
    return out;
  }

  /**
   * Asks the context providers for material up to the turn's ceiling, adds it as one delimited system message after
   * the profile's prompt, raises the conversation's label to the highest item used and records the citations.
   */
  private async addContext(p: Principal, c: ConversationRow, m: MessageRow, r: ResolvedProfile, lease: Lease, messages: ChatMessage[], st: Stream): Promise<void> {
    if (!this.contextProviders.length) return;
    const query = [...messages].reverse().find((x) => x.role === 'user')?.content ?? '';
    const ws = c.workspace_id ? ((await this.db('workspaces').where({ id: c.workspace_id }).first('label_ceiling')) as { label_ceiling: Label } | undefined) : undefined;
    const caps: Label[] = [p.clearance, r.profile.label, lease.pool.label_ceiling, ...(ws ? [ws.label_ceiling] : [])];
    const ceiling = caps.reduce((a, b) => (labelRank(b) < labelRank(a) ? b : a));
    const items: ContextItem[] = [];
    for (const provider of this.contextProviders) {
      try {
        items.push(...(await provider({ principal: p, tenantId: c.tenant_id, workspaceId: c.workspace_id, conversationId: c.id, messageId: m.id, profile: r.profile, query, label: c.label, ceiling })).filter((x) => labelRank(x.label) <= labelRank(ceiling)));
      } catch (err) {
        this.log.warn({ err, message: m.id }, 'context provider failed');
      }
    }
    if (!items.length) return;
    messages.splice(r.profile.system_prompt ? 1 : 0, 0, { role: 'system', content: formatContext(items) });
    const label = highest(c.label, ...items.map((x) => x.label));
    const citations = items.map((x, i) => ({ n: i + 1, kind: x.tag === 'context' ? 'knowledge' : 'memory', label: x.label, ...x.cite }));
    await this.db('messages').where({ id: m.id }).update({ citations: await this.seal(c.tenant_id, m.id, 'citations', JSON.stringify(citations)), ...(label !== c.label ? { label } : {}) });
    if (label !== c.label) {
      await this.db('conversations').where({ id: c.id }).update({ label });
      c.label = label;
    }
    this.emit(st, 'chat.status', { conversationId: c.id, messageId: m.id, state: 'context', label, citations: citations.length });
  }

  private async generate(p: Principal, c: ConversationRow, m: MessageRow, resolved: ResolvedProfile, think: ThinkLevel, kind: 'chat' | 'compare', st: Stream): Promise<void> {
    const usage: Usage = { promptTokens: 0, outputTokens: 0, thinkingTokens: 0, calcCalls: 0, gpuMs: 0, firstTokenMs: null };
    let lease: Lease | null = null;
    let r = resolved;
    const started = Date.now();
    let promptChars = 0;
    let evalCounted = false;
    this.emit(st, 'chat.status', { conversationId: c.id, messageId: m.id, state: 'queued', profile: r.profile.name, model: r.model.name });
    try {
      const onPosition = (position: number) => this.emit(st, 'chat.status', { conversationId: c.id, messageId: m.id, state: 'queued', position });
      // The fallback chain: when every slot for a profile stays busy past its queue wait, try its fallback, whose own
      // fallback applies in turn (at most three hops, never revisiting a profile).
      const tried = new Set<string>([r.profile.id]);
      for (let hop = 0; ; hop++) {
        const fallback = hop < 3 && r.profile.fallback && !tried.has(r.profile.fallback.profileId) ? r.profile.fallback : null;
        try {
          lease = await this.gateway.acquire(r.profile, r.model, c.label, { signal: st.ac.signal, ...(fallback ? { waitMs: fallback.afterQueueWaitMs } : {}), onPosition });
          break;
        } catch (err) {
          if (!(err instanceof QueueTimeout) || !fallback) throw err;
          const fb = await this.resolveFor(p, fallback.profileId, c.label);
          tried.add(fb.profile.id);
          this.emit(st, 'chat.status', { conversationId: c.id, messageId: m.id, state: 'fallback', from: r.profile.name, profile: fb.profile.name, model: fb.model.name });
          r = fb;
          await this.db('messages').where({ id: m.id }).update({ profile_id: r.profile.id, profile_name: r.profile.name, model: r.model.name, canary: r.canary });
        }
      }
      st.state = 'streaming';
      await this.db('messages').where({ id: m.id }).update({ state: 'streaming', instance_id: lease.instance.id, model: r.model.name });
      this.emit(st, 'chat.status', { conversationId: c.id, messageId: m.id, state: lease.cold ? 'loading' : 'streaming', instance: lease.instance.name, model: r.model.name, profile: r.profile.name });

      const messages: ChatMessage[] = [];
      if (r.profile.system_prompt) messages.push({ role: 'system', content: r.profile.system_prompt });
      messages.push(...(await this.history(c, m.parent_id!, r.model.capabilities.includes('vision'))));
      await this.addContext(p, c, m, r, lease, messages, st);
      promptChars = messages.reduce((a, x) => a + x.content.length, 0);
      const modelTools = r.model.capabilities.includes('tools') && !r.model.evaluation?.toolsWithheld;
      // Beyond calculate: published registry and MCP tools, read-only in chat (write and destructive calls need an
      // approval, which agent runs provide).
      const extra: ResolvedTool[] = modelTools && this.toolDispatch ? (await this.toolDispatch.resolve(p, r.profile.tools.filter((t) => t !== 'calculate'), c.label)).tools.filter((t) => t.sideEffect === 'read' && t.confirm === 'never') : [];
      const toolsOn = (r.profile.tools.includes('calculate') || extra.length > 0) && modelTools;
      const toolDefs = [...(r.profile.tools.includes('calculate') ? [CALCULATE_TOOL] : []), ...extra.map((t) => t.def)];
      const thinkParam = think === 'off' ? false : r.model.name.startsWith('gpt-oss') ? think : true;
      const options: Record<string, unknown> = {};
      if (r.profile.num_ctx) options.num_ctx = r.profile.num_ctx;
      if (r.profile.temperature != null) options.temperature = r.profile.temperature;

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const calls: NonNullable<ChatMessage['tool_calls']> = [];
        let roundContent = '';
        for await (const chunk of lease.client.chat({ model: r.model.name, messages, ...(r.model.capabilities.includes('thinking') ? { think: thinkParam } : {}), ...(toolsOn ? { tools: toolDefs } : {}), options }, st.ac.signal)) {
          const msg = chunk.message;
          if (msg && (msg.content || msg.thinking) && usage.firstTokenMs == null) {
            usage.firstTokenMs = Date.now() - started;
            if (lease.cold) this.gateway.noteResident(lease.instance.id, r.model.name);
            this.emit(st, 'chat.status', { conversationId: c.id, messageId: m.id, state: 'streaming' });
          }
          if (msg?.thinking) {
            st.thinking += msg.thinking;
            this.push(st, { thinking: msg.thinking });
          }
          if (msg?.content) {
            st.content += msg.content;
            roundContent += msg.content;
            this.push(st, { delta: msg.content });
          }
          if (msg?.tool_calls?.length) calls.push(...msg.tool_calls);
          if (chunk.done) {
            evalCounted = true;
            usage.promptTokens += chunk.prompt_eval_count ?? 0;
            usage.outputTokens += chunk.eval_count ?? 0;
            usage.gpuMs += ((chunk.prompt_eval_duration ?? 0) + (chunk.eval_duration ?? 0) + (chunk.load_duration ?? 0)) / 1e6;
          }
          if (Date.now() - st.lastFlush > 2000) await this.flush(st);
        }
        if (!calls.length || !toolsOn) break;
        messages.push({ role: 'assistant', content: roundContent, tool_calls: calls });
        for (const call of calls) {
          const expression = String((call.function.arguments as { expression?: unknown }).expression ?? '');
          let tool: NonNullable<Chunk['tool']>;
          const ext = extra.find((t) => t.fn === call.function.name);
          if (ext) {
            const o = await this.toolDispatch!.call({ principal: p, label: c.label, source: { kind: 'message', id: m.id }, signal: st.ac.signal }, ext, (call.function.arguments ?? {}) as Record<string, unknown>);
            tool = { name: ext.entry.name, expression: JSON.stringify(o.arguments), ...(o.ok ? { output: o.result } : { error: o.error ?? 'The tool failed.' }) };
          } else if (call.function.name !== 'calculate' || !r.profile.tools.includes('calculate')) tool = { name: call.function.name, expression, error: 'Unknown tool' };
          else {
            usage.calcCalls++;
            try {
              tool = { name: 'calculate', expression, result: await this.calc.evaluate(expression) };
            } catch (err) {
              tool = { name: 'calculate', expression, error: (err as Error).message };
            }
          }
          st.tools.push(tool);
          this.push(st, { tool });
          messages.push({ role: 'tool', tool_name: call.function.name, content: JSON.stringify(tool.result ?? tool.output ?? { error: tool.error }) });
        }
      }
      st.state = 'complete';
    } catch (err) {
      if (st.stopRequested) st.state = 'stopped';
      else {
        st.state = 'failed';
        const e = err as Error;
        const detail = err instanceof HttpProblem ? (err.detail ?? err.title) : err instanceof QueueTimeout ? `${e.message} Try again, or pick another profile.` : `The model instance failed: ${e.message}`;
        await this.db('messages').where({ id: m.id }).update({ error: String(detail).slice(0, 500) });
        this.log.warn({ message: m.id, err: e.message }, 'generation failed');
      }
    } finally {
      lease?.release(usage.firstTokenMs);
    }
    const guard = (st.state === 'complete' || st.state === 'stopped') && st.content ? await this.guardOutput(p, c, m, r, st) : null;

    // Metering happens once, on the final chunk; a stopped stream is estimated from what was produced.
    if (!evalCounted && (st.content || st.thinking)) {
      usage.promptTokens = Math.ceil(promptChars / 4);
      usage.outputTokens = Math.ceil((st.content.length + st.thinking.length) / 4);
    }
    if (usage.outputTokens && st.thinking) usage.thinkingTokens = Math.round((usage.outputTokens * st.thinking.length) / (st.thinking.length + st.content.length || 1));
    const metered = usage.promptTokens + usage.outputTokens > 0;
    await this.flush(st, {
      completed_at: Date.now(),
      prompt_tokens: usage.promptTokens,
      output_tokens: usage.outputTokens,
      thinking_tokens: usage.thinkingTokens,
      calc_calls: usage.calcCalls,
      gpu_ms: Math.round(usage.gpuMs),
      first_token_ms: usage.firstTokenMs,
      ...(guard ? { guard: JSON.stringify(guard.summary) } : {})
    });
    // A replaced answer is read back from the store, not from the streamed chunks.
    if (guard?.replaced && this.streams.get(m.id) === st) this.streams.delete(m.id);
    if (metered) {
      await this.quotas.record({ tenantId: c.tenant_id, workspaceId: c.workspace_id, userId: p.userId, apiKeyId: p.apiKeyId, kind, profileId: r.profile.id, model: r.model.name, poolId: lease?.pool.id ?? null, conversationId: c.id, messageId: m.id, promptTokens: usage.promptTokens, outputTokens: usage.outputTokens, thinkingTokens: usage.thinkingTokens, calcCalls: usage.calcCalls, gpuMs: usage.gpuMs });
    }
    const error = st.state === 'failed' ? ((await this.db('messages').where({ id: m.id }).first('error')) as { error: string | null } | undefined)?.error : null;
    this.emit(st, 'chat.done', { conversationId: c.id, messageId: m.id, state: st.state, seq: st.seq, usage, error: error ?? null, profile: r.profile.name, model: r.model.name, ...(guard ? { guard: guard.summary } : {}) });
    for (const fn of this.answerListeners) {
      try {
        fn({ principal: p, tenantId: c.tenant_id, workspaceId: c.workspace_id, conversationId: c.id, userMessageId: m.parent_id, messageId: m.id, state: st.state, label: c.label });
      } catch (err) {
        this.log.warn({ err, message: m.id }, 'answer listener failed');
      }
    }
    if (st.state === 'failed') {
      await this.audit.append({ tenantId: c.tenant_id, action: 'chat.failed', kind: 'system', actor: actorFrom(p), target: { conversation: c.id, message: m.id, profile: r.profile.name, model: r.model.name }, label: c.label, detail: { state: st.state, error: error ?? null } });
    }
  }

  // ---------- guardrails ----------

  /** The user-input checkpoint. A block or hold refuses the send with the reason; a redaction is what is stored and sent. */
  private async guardInput(p: Principal, workspaceId: string | null, text: string, label: Label, conversationId: string | null): Promise<string> {
    const d = await this.guardrails.check({ tenantId: p.tenantId, workspaceId, checkpoint: 'user-input', text, label, principal: p, ...(conversationId ? { source: { kind: 'conversation', id: conversationId } } : {}), meta: { tokens: Math.ceil(text.length / 4), via: 'chat', ...(conversationId ? { conversationId } : {}) } });
    if (d.action === 'block' || d.action === 'require-approval') {
      const rules = [...new Set(d.findings.filter((f) => f.stage === 'enforce' && f.action === d.action).map((f) => f.ruleName))];
      throw new HttpProblem(422, d.action === 'block' ? 'Blocked by guardrail' : 'Held by guardrail', d.reason ?? 'A guardrail refused this message.', { extensions: { step: 'guardrail', action: d.action, rules } });
    }
    return d.text;
  }

  /**
   * The model-output checkpoint, on the finished (or stopped) answer. A block or hold replaces the answer with a
   * notice; a redaction replaces the flagged spans. Either way the stored answer is what the user sees from then on.
   */
  private async guardOutput(p: Principal, c: ConversationRow, m: MessageRow, r: ResolvedProfile, st: Stream): Promise<{ summary: Record<string, unknown>; replaced: boolean } | null> {
    let d: GuardDecision;
    try {
      const q = m.parent_id ? ((await this.db('messages').where({ id: m.parent_id }).first('content')) as { content: string | null } | undefined) : undefined;
      const prompt = q?.content ? await this.open(c.tenant_id, m.parent_id!, 'content', q.content) : null;
      const tools = r.profile.tools.includes('calculate') && r.model.capabilities.includes('tools');
      d = await this.guardrails.check({ tenantId: c.tenant_id, workspaceId: c.workspace_id, checkpoint: 'model-output', text: st.content, label: c.label, principal: p, source: { kind: 'message', id: m.id }, meta: { conversationId: c.id, profile: r.profile.name, model: r.model.name, tools, via: 'chat', ...(prompt ? { prompt } : {}) } });
    } catch (err) {
      this.log.error({ err, message: m.id }, 'model-output guardrail failed');
      d = { action: 'block', text: st.content, findings: [], reason: 'The guardrail check could not run, so the answer is withheld.' };
    }
    const enforced = d.findings.filter((f) => f.stage === 'enforce');
    if (!enforced.length && d.action === 'allow') return null;
    const summary = { action: d.action, ...(d.reason ? { reason: d.reason } : {}), rules: [...new Set(enforced.map((f) => f.ruleName))] };
    let replaced = false;
    if (d.action === 'block' || d.action === 'require-approval') {
      st.content = `This answer was withheld. ${d.reason ?? ''}`.trim();
      replaced = true;
    } else if (d.action === 'redact' && d.text !== st.content) {
      st.content = d.text;
      replaced = true;
    }
    if (replaced) {
      // Clients holding the streamed text see a higher sequence number on chat.done and read the answer again.
      st.seq++;
      st.chunks = [];
    }
    return { summary, replaced };
  }
}
