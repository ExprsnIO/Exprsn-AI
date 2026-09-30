import { randomBytes } from 'node:crypto';
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
import { formatContext, passageSpan, type AnswerEvent, type ContextItem, type ContextProvider } from './context.js';
import { StreamGuard, type Release } from '../guardrails/stream.js';
import type { FlagService } from '../guardrails/flags.js';
import type { Notifications } from '../platform/notifications.js';
import { DbStreamStore, type Chunk, type StreamStore } from './streams.js';

export type { Chunk } from './streams.js';

/**
 * `held`: waiting on a reviewer (invisible to the user); `withdrawn`: rejected by the reviewer; `interrupted`: the
 * instance generating it stopped, and the stored part can be continued.
 */
export type MessageState = 'queued' | 'streaming' | 'complete' | 'stopped' | 'failed' | 'held' | 'withdrawn' | 'interrupted';

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
  generator?: string | null;
  heartbeat_at?: number | null;
}

interface Stream {
  messageId: string;
  conversationId: string;
  userId: string;
  tenantId: string;
  /** Recent chunks, for catch-up from this instance. */
  chunks: Chunk[];
  /** Chunks not yet written to the shared catch-up buffer. */
  pending: Chunk[];
  seq: number;
  /** Everything the model produced (for the final check and storage). */
  content: string;
  thinking: string;
  /** What was released to the user after screening (what views and snapshots show while streaming). */
  shown: string;
  shownThinking: string;
  tools: NonNullable<Chunk['tool']>[];
  state: MessageState;
  ac: AbortController;
  stopRequested: boolean;
  /** Stopped because this instance is shutting down: the answer is interrupted, not stopped. */
  shutdown: boolean;
  lastFlush: number;
  /** Screened-prefix guards for the answer and the thinking (null when no deterministic rule applies). */
  guard: StreamGuard | null;
  thinkGuard: StreamGuard | null;
  /** A streaming screen asked for review: nothing more is released. */
  held: boolean;
  /** The streaming screen could not load: nothing is released until the full check has passed the answer. */
  deferred: boolean;
  /** Retrieved material of the turn, for the passages stored with the citations. */
  context: { items: ContextItem[]; citations: Record<string, unknown>[] } | null;
  /** Store writes and snapshots, one at a time. */
  io: Promise<void>;
  timer: NodeJS.Timeout | null;
}

/** What a continued answer starts from. */
interface Continuation {
  content: string;
  thinking: string;
  tools: NonNullable<Chunk['tool']>[];
  seq: number;
  usage: { promptTokens: number; outputTokens: number; thinkingTokens: number; calcCalls: number; gpuMs: number };
}

/** Thrown inside the token loop when the streaming screen blocks: the generation stops. */
class GuardHalt extends Error {}

export interface ChatOptions {
  /** The shared catch-up buffer (Redis or database); the database when unset. */
  store?: StreamStore;
  /** Held answers are filed in the flag queue for a reviewer. */
  flags?: FlagService;
  notifications?: Notifications;
  /** A streaming answer whose generator has not been heard from for this long is interrupted. */
  leaseMs?: number;
}

const LIVE: MessageState[] = ['queued', 'streaming'];
const LOCAL_CHUNKS = 10_000;

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
  /** This instance, as recorded on the answers it generates. */
  readonly instance = randomBytes(10).toString('hex');
  readonly store: StreamStore;
  private readonly leaseMs: number;
  private readonly sweeper: NodeJS.Timeout;
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
    private readonly guardrails: Guardrails = allowAll,
    private readonly opts: ChatOptions = {}
  ) {
    this.offStop = bus.on<{ messageId: string }>(TOPICS.chatStop, ({ messageId }) => this.abortLocal(messageId));
    this.store = opts.store ?? new DbStreamStore(db, keys);
    this.leaseMs = opts.leaseMs ?? 30_000;
    // Every instance looks for answers whose generator went quiet; marking one is a single conditional update.
    this.sweeper = setInterval(() => void this.sweepInterrupted().catch((err: Error) => this.log.warn({ err: err.message }, 'interrupted-stream sweep failed')), this.leaseMs);
    this.sweeper.unref();
  }

  /** Registry and MCP tools on a profile's tool list are offered and called through the dispatcher (Sprint 7). */
  useTools(d: ToolDispatcher): void {
    this.toolDispatch = d;
  }

  close(): void {
    this.offStop();
    clearInterval(this.sweeper);
    for (const st of this.streams.values()) {
      if (st.timer) clearInterval(st.timer);
      st.stopRequested = true;
      st.shutdown = true;
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

  /** A conversation's label may never rise above its workspace's ceiling, however it is raised. */
  private async assertWorkspaceCeiling(workspaceId: string | null, label: Label): Promise<void> {
    if (!workspaceId) return;
    const ws = (await this.db('workspaces').where({ id: workspaceId }).first('label_ceiling')) as { label_ceiling: Label } | undefined;
    if (ws && labelRank(label) > labelRank(ws.label_ceiling)) throw forbidden(`This workspace's ceiling is ${ws.label_ceiling}; this message would make the conversation ${label}.`, { step: 'zone' });
  }

  async createConversation(p: Principal, input: { title?: string | null; label?: Label; kind?: 'chat' | 'compare'; profileId?: string | null }): Promise<ConversationRow> {
    const label = input.label ?? 'internal';
    if (!clears(p.clearance, label)) throw forbidden(`Your clearance is ${p.clearance}; a ${label} conversation is above it.`, { step: 'clearance' });
    await this.assertWorkspaceCeiling(p.workspaceId ?? null, label);
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
    await this.removeConversations([c.id]);
  }

  /** Deletes conversations with their messages and catch-up buffers (the owner's delete, and retention). */
  private async removeConversations(ids: string[]): Promise<number> {
    let messages = 0;
    for (let i = 0; i < ids.length; i += 200) {
      const batch = ids.slice(i, i + 200);
      const mids = ((await this.db('messages').whereIn('conversation_id', batch).select('id')) as { id: string }[]).map((m) => m.id);
      for (const mid of mids) this.abortLocal(mid);
      await this.store.drop(mids).catch((err: Error) => this.log.warn({ err: err.message }, 'stream buffer not dropped'));
      await this.db('messages').whereIn('conversation_id', batch).delete();
      await this.db('conversations').whereIn('id', batch).delete();
      messages += mids.length;
    }
    return messages;
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
    await this.interruptStale(c.id);
    const rows = (await this.db('messages').where({ conversation_id: c.id }).orderBy([{ column: 'created_at' }, { column: 'id' }])) as MessageRow[];
    const messages = await Promise.all(rows.map((m) => this.messageView(m, p)));
    return { id: c.id, kind: c.kind, title: await this.open(c.tenant_id, c.id, 'title', c.title), label: c.label, profileId: c.profile_id, workspaceId: c.workspace_id, headId: c.head_id, createdAt: c.created_at, updatedAt: c.updated_at, archived: c.archived_at != null, messages };
  }

  /**
   * A message as its owner sees it. While streaming, only the screened text. A held answer shows nothing but its
   * state until a reviewer approves it. A citation's quoted passage is left out when it is above the reader's clearance.
   */
  private async messageView(m: MessageRow, p?: Principal) {
    const live = this.streams.get(m.id);
    const held = m.state === 'held' && !live;
    const tools = held ? [] : live ? live.tools : json<Chunk['tool'][]>(await this.open(m.tenant_id, m.id, 'tools', m.tools), []);
    const citations = held ? [] : json<Record<string, unknown>[]>(await this.open(m.tenant_id, m.id, 'citations', m.citations ?? null), []).map((c) => (c.passage != null && (!p || !clears(p.clearance, c.label as Label)) ? { ...c, passage: null, span: null, restricted: true } : c));
    return {
      id: m.id,
      parentId: m.parent_id,
      role: m.role,
      content: held ? '' : live ? live.shown : ((await this.open(m.tenant_id, m.id, 'content', m.content)) ?? ''),
      thinking: held ? null : live ? live.shownThinking || null : await this.open(m.tenant_id, m.id, 'thinking', m.thinking),
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
      citations,
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
    for (const row of rows.filter((x) => x.status === 'published' && (!p.profiles || p.profiles.includes(x.name)))) {
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
    const d = authorize(p, 'inference:invoke', { tenantId: p.tenantId, label, zoneCeiling: r.profile.label, profiles: [profile, r.profile.name] });
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
    await this.assertWorkspaceCeiling(c.workspace_id, label);
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
      completed_at: m.role === 'user' ? m.created_at : null,
      ...(m.role === 'assistant' ? { generator: this.instance, heartbeat_at: Date.now() } : {})
    };
    await this.db('messages').insert(row);
    return row;
  }

  // ---------- stop, catch-up, interruption, continuation ----------

  async stop(p: Principal, conversationId: string, messageId: string): Promise<{ state: MessageState }> {
    const c = await this.conversation(p, conversationId);
    const m = await this.message(c, messageId);
    if (!LIVE.includes(m.state)) return { state: m.state };
    if (!this.abortLocal(messageId)) this.bus.publish(TOPICS.chatStop, { messageId });
    return { state: 'stopped' };
  }

  private abortLocal(messageId: string): boolean {
    const st = this.streams.get(messageId);
    if (!st || !LIVE.includes(st.state)) return false;
    st.stopRequested = true;
    st.ac.abort(new Error('stopped'));
    return true;
  }

  /**
   * Catch-up for a client that missed chunks, from any instance. Streaming here: the recent chunks. Streaming on
   * another instance: the shared buffer's chunks after `after`, or, for a client behind the last stored snapshot, that
   * snapshot with the buffered chunks after it applied. Otherwise the stored message. Only screened text is returned.
   */
  async resume(p: Principal, conversationId: string, messageId: string, after: number) {
    const c = await this.conversation(p, conversationId);
    // The message must belong to the caller's conversation before the process-wide stream map is consulted.
    let m = await this.message(c, messageId);
    const st = this.streams.get(m.id);
    if (st && st.conversationId === c.id && st.state !== 'held') {
      const first = st.chunks[0]?.seq ?? st.seq + 1;
      if (after + 1 >= first || after >= st.seq) return { state: st.state, seq: st.seq, chunks: st.chunks.filter((x) => x.seq > after) };
      return { state: st.state, seq: st.seq, content: st.shown, thinking: st.shownThinking || null, tools: st.tools, usage: null, error: null };
    }
    if (await this.interruptIfStale(m)) m = await this.message(c, messageId);
    for (let attempt = 0; LIVE.includes(m.state) && !st && attempt < 3; attempt++) {
      const chunks = await this.store.after(m.tenant_id, m.id, after);
      const row = await this.message(c, messageId);
      m = row;
      if (!LIVE.includes(row.state)) break;
      const snap = Number(row.seq);
      if (after >= snap || chunks[0]?.seq === after + 1) return { state: row.state, seq: chunks.length ? chunks[chunks.length - 1]!.seq : Math.max(after, snap), chunks };
      // Behind the snapshot: the snapshot, then whatever the buffer holds after it.
      const later = chunks.filter((x) => x.seq > snap);
      if (later.length && later[0]!.seq !== snap + 1) continue; // a newer snapshot landed between the two reads
      const v = await this.messageView(row, p);
      let content = v.content;
      let thinking = v.thinking ?? '';
      const tools = [...v.tools];
      for (const x of later) {
        if (x.delta) content += x.delta;
        if (x.thinking) thinking += x.thinking;
        if (x.tool) tools.push(x.tool);
      }
      return { state: row.state, seq: later.length ? later[later.length - 1]!.seq : snap, content, thinking: thinking || null, tools, usage: null, error: null };
    }
    const v = await this.messageView(m, p);
    return { state: v.state, seq: v.seq, content: v.content, thinking: v.thinking, tools: v.tools, usage: v.usage, error: v.error };
  }

  /** A queued or streaming answer that no instance is generating any more: its generator missed the lease. */
  private stale(m: MessageRow): boolean {
    if (!LIVE.includes(m.state)) return false;
    const local = this.streams.get(m.id);
    if (local && LIVE.includes(local.state)) return false;
    const beat = m.heartbeat_at != null ? Number(m.heartbeat_at) : Number(m.created_at);
    return Date.now() - beat > this.leaseMs;
  }

  private async interruptIfStale(m: MessageRow): Promise<boolean> {
    return this.stale(m) ? this.markInterrupted(m) : false;
  }

  private async interruptStale(conversationId: string): Promise<void> {
    for (const m of (await this.db('messages').where({ conversation_id: conversationId }).whereIn('state', LIVE)) as MessageRow[]) await this.interruptIfStale(m);
  }

  /** Marks every answer whose generator went quiet (any tenant, or one) as interrupted; returns how many. */
  async sweepInterrupted(tenantId?: string): Promise<number> {
    const cutoff = Date.now() - this.leaseMs;
    const q = this.db('messages')
      .whereIn('state', LIVE)
      .andWhere((w) => w.where('heartbeat_at', '<', cutoff).orWhere((x) => x.whereNull('heartbeat_at').andWhere('created_at', '<', cutoff)));
    if (tenantId) q.andWhere({ tenant_id: tenantId });
    let n = 0;
    for (const m of (await q.limit(500)) as MessageRow[]) if (await this.interruptIfStale(m)) n++;
    return n;
  }

  /** One conditional update, so only one instance marks (and reports) each interruption. */
  private async markInterrupted(m: MessageRow): Promise<boolean> {
    const cutoff = Date.now() - this.leaseMs;
    const n = await this.db('messages')
      .where({ id: m.id })
      .whereIn('state', LIVE)
      .andWhere((w) => w.where('heartbeat_at', '<', cutoff).orWhereNull('heartbeat_at'))
      .update({ state: 'interrupted' });
    if (!n) return false;
    await this.store.drop([m.id]).catch(() => undefined);
    const c = (await this.db('conversations').where({ id: m.conversation_id }).first('user_id', 'label')) as { user_id: string; label: Label } | undefined;
    if (c) {
      this.bus.publish(TOPICS.chatEvent, { userId: c.user_id, event: 'chat.done', data: { conversationId: m.conversation_id, messageId: m.id, state: 'interrupted', seq: Number(m.seq) } });
      await this.audit.append({ tenantId: m.tenant_id, action: 'chat.interrupted', kind: 'system', actor: { service: 'chat', user: c.user_id }, target: { conversation: m.conversation_id, message: m.id }, label: c.label, detail: { generator: m.generator ?? null, seq: Number(m.seq) } });
    }
    return true;
  }

  /**
   * Continues an interrupted (or stopped) answer from its stored text: the same message, its sequence numbers going
   * on from where they were. The model gets the stored text as the start of its answer and writes the rest; the
   * finished answer (old and new text) passes the output check as a whole.
   */
  async continue(p: Principal, conversationId: string, messageId: string, input: { profile?: string; think?: ThinkLevel }) {
    const c = await this.conversation(p, conversationId);
    let m = await this.message(c, messageId);
    if (await this.interruptIfStale(m)) m = await this.message(c, messageId);
    const local = this.streams.get(m.id);
    if (m.role !== 'assistant' || (m.state !== 'interrupted' && m.state !== 'stopped') || (local && LIVE.includes(local.state))) throw conflict(`Only an interrupted or stopped answer can be continued; this one is ${local && LIVE.includes(local.state) ? local.state : m.state}.`);
    const r = await this.resolveFor(p, input.profile ?? m.profile_id ?? m.profile_name ?? '', c.label);
    await this.admit(p, c.workspace_id);
    const think = this.thinkLevel(r.profile, input.think ?? m.think ?? undefined);
    const from: Continuation = {
      content: (await this.open(m.tenant_id, m.id, 'content', m.content)) ?? '',
      thinking: (await this.open(m.tenant_id, m.id, 'thinking', m.thinking)) ?? '',
      tools: json<NonNullable<Chunk['tool']>[]>(await this.open(m.tenant_id, m.id, 'tools', m.tools), []),
      seq: Number(m.seq),
      usage: { promptTokens: Number(m.prompt_tokens ?? 0), outputTokens: Number(m.output_tokens ?? 0), thinkingTokens: Number(m.thinking_tokens ?? 0), calcCalls: Number(m.calc_calls ?? 0), gpuMs: Number(m.gpu_ms ?? 0) }
    };
    const claimed = await this.db('messages').where({ id: m.id, state: m.state }).update({ state: 'queued', error: null, completed_at: null, generator: this.instance, heartbeat_at: Date.now(), profile_id: r.profile.id, profile_name: r.profile.name, model: r.model.name, think, canary: r.canary });
    if (!claimed) throw conflict('This answer changed while you asked; reload the conversation.');
    await this.db('conversations').where({ id: c.id }).update({ updated_at: Date.now() });
    this.start(p, c, { ...m, state: 'queued' }, r, think, c.kind, from);
    return { messageId: m.id, profile: r.profile.name, model: r.model.name, think, from: from.seq };
  }

  // ---------- held answers ----------

  /**
   * A reviewer's decision on a held answer, from the flag queue. Approved: the answer becomes visible as it was
   * generated. Rejected: it is withdrawn and its text replaced with a notice. The owner is told either way, and a
   * reviewer never decides on their own answer.
   */
  async resolveHold(reviewer: Principal, messageId: string, decision: 'approved' | 'rejected'): Promise<{ conversationId: string; state: MessageState; label: Label }> {
    const m = (await this.db('messages').where({ tenant_id: reviewer.tenantId, id: messageId }).first()) as MessageRow | undefined;
    if (!m) throw notFound('Message');
    if (m.state !== 'held') throw conflict(`This answer is ${m.state}, not held for review.`);
    const c = (await this.db('conversations').where({ id: m.conversation_id }).first()) as ConversationRow | undefined;
    if (!c) throw notFound('Conversation');
    if (c.user_id === reviewer.userId) throw forbidden('This answer was held in your own conversation; another reviewer decides on it.', { step: 'dual-control' });
    const state: MessageState = decision === 'approved' ? 'complete' : 'withdrawn';
    const seq = Number(m.seq) + 1;
    const guard = { ...json<Record<string, unknown>>(m.guard ?? null, {}), review: { decision, by: reviewer.displayName, at: Date.now() } };
    const upd: Record<string, unknown> = { state, seq, guard: JSON.stringify(guard) };
    if (decision === 'rejected') Object.assign(upd, { content: await this.seal(m.tenant_id, m.id, 'content', 'This answer was withdrawn after review.'), thinking: null, tools: null, citations: null });
    const n = await this.db('messages').where({ id: m.id, state: 'held' }).update(upd);
    if (!n) throw conflict('Another reviewer decided on this answer first.');
    this.bus.publish(TOPICS.chatEvent, { userId: c.user_id, event: 'chat.released', data: { conversationId: c.id, messageId: m.id, state, seq } });
    await this.opts.notifications?.notify({ tenantId: m.tenant_id, userIds: [c.user_id], kind: 'chat', title: decision === 'approved' ? 'An answer held for review is now available' : 'An answer held for review was withdrawn', body: decision === 'approved' ? 'A reviewer approved it.' : 'A reviewer rejected it.', route: `chat?id=${c.id}`, label: m.label });
    return { conversationId: c.id, state, label: m.label };
  }

  /** The held answer's text for a reviewer cleared for it (the flag detail shows it in full). */
  async heldText(tenantId: string, messageId: string): Promise<{ conversationId: string; state: MessageState; content: string; label: Label } | null> {
    const m = (await this.db('messages').where({ tenant_id: tenantId, id: messageId }).first()) as MessageRow | undefined;
    if (!m) return null;
    return { conversationId: m.conversation_id, state: m.state, content: (await this.open(m.tenant_id, m.id, 'content', m.content)) ?? '', label: m.label };
  }

  // ---------- retention ----------

  /**
   * The tenant's retention policy (ASVS 8.3.4): conversations not updated for more than N days are deleted with
   * their messages, catch-up buffers and the attachments no remaining message uses. Answers still generating are left
   * for the next run. The purge is audited with its counts.
   */
  async purgeExpired(tenantId: string): Promise<{ days: number | null; conversations: number; messages: number; attachments: number }> {
    const policy = (await this.db('chat_retention').where({ tenant_id: tenantId }).first()) as { conversation_days: number | null } | undefined;
    const days = policy?.conversation_days == null ? null : Number(policy.conversation_days);
    if (!days) return { days: null, conversations: 0, messages: 0, attachments: 0 };
    const cutoff = Date.now() - days * 86_400_000;
    const busy = this.db('messages').where({ tenant_id: tenantId }).whereIn('state', LIVE).select('conversation_id');
    let conversations = 0;
    let messages = 0;
    let attachments = 0;
    for (;;) {
      const ids = ((await this.db('conversations').where({ tenant_id: tenantId }).andWhere('updated_at', '<', cutoff).whereNotIn('id', busy.clone()).limit(500).select('id')) as { id: string }[]).map((x) => x.id);
      if (!ids.length) break;
      const used = new Set<string>();
      for (const r of (await this.db('messages').whereIn('conversation_id', ids).whereNotNull('attachments').select('attachments')) as { attachments: string }[]) for (const a of json<string[]>(r.attachments, [])) used.add(a);
      messages += await this.removeConversations(ids);
      conversations += ids.length;
      for (const aid of used) {
        const stillUsed = await this.db('messages').where({ tenant_id: tenantId }).andWhere('attachments', 'like', `%${aid}%`).first('id');
        if (!stillUsed && (await this.attachments.remove(tenantId, aid))) attachments++;
      }
      if (ids.length < 500) break;
    }
    await this.db('chat_retention').where({ tenant_id: tenantId }).update({ last_run_at: Date.now(), last_purged: conversations });
    if (conversations) await this.audit.append({ tenantId, action: 'chat.retention.purged', kind: 'system', actor: { service: 'chat.retention' }, target: { tenant: tenantId }, detail: { days, before: cutoff, conversations, messages, attachments } });
    return { days, conversations, messages, attachments };
  }

  // ---------- generation ----------

  private emit(st: Pick<Stream, 'userId'>, event: string, data: Record<string, unknown>): void {
    this.bus.publish(TOPICS.chatEvent, { userId: st.userId, event, data });
  }

  private start(p: Principal, c: ConversationRow, m: MessageRow, r: ResolvedProfile, think: ThinkLevel, kind: 'chat' | 'compare', from?: Continuation): void {
    const st: Stream = {
      messageId: m.id,
      conversationId: c.id,
      userId: p.userId,
      tenantId: c.tenant_id,
      chunks: [],
      pending: [],
      seq: from?.seq ?? 0,
      content: from?.content ?? '',
      thinking: from?.thinking ?? '',
      shown: from?.content ?? '',
      shownThinking: from?.thinking ?? '',
      tools: from ? [...from.tools] : [],
      state: 'queued',
      ac: new AbortController(),
      stopRequested: false,
      shutdown: false,
      lastFlush: Date.now(),
      guard: null,
      thinkGuard: null,
      held: false,
      deferred: false,
      context: null,
      io: Promise.resolve(),
      timer: null
    };
    // The heartbeat keeps the lease on this answer and writes chunks to the shared buffer while the model is quiet.
    st.timer = setInterval(() => void this.beat(st), Math.max(250, Math.floor(this.leaseMs / 3)));
    st.timer.unref();
    this.streams.set(m.id, st);
    void this.generate(p, c, m, r, think, kind, st, from)
      .catch((err) => this.log.error({ err, message: m.id }, 'generation crashed'))
      .finally(() => {
        if (st.timer) clearInterval(st.timer);
        // Keep the buffer a little while for clients catching up, then rely on the stored message.
        setTimeout(() => {
          if (this.streams.get(m.id) === st) this.streams.delete(m.id);
        }, 60_000).unref();
      });
  }

  /** Store writes for one stream run one after another, in order. */
  private io(st: Stream, fn: () => Promise<void>): Promise<void> {
    const next = st.io.then(fn);
    st.io = next.catch((err: Error) => this.log.warn({ err: err.message, message: st.messageId }, 'stream store write failed'));
    return next;
  }

  private async writePending(st: Stream): Promise<void> {
    const batch = st.pending.splice(0);
    if (!batch.length) return;
    try {
      await this.store.append(st.tenantId, st.messageId, batch);
    } catch (err) {
      st.pending.unshift(...batch);
      throw err;
    }
  }

  private beat(st: Stream): void {
    if (!LIVE.includes(st.state)) return;
    void this.io(st, async () => {
      await this.writePending(st);
      await this.db('messages').where({ id: st.messageId }).whereIn('state', LIVE).update({ heartbeat_at: Date.now(), generator: this.instance });
    }).catch(() => undefined);
  }

  private push(st: Stream, chunk: Omit<Chunk, 'seq'>): void {
    const c: Chunk = { seq: ++st.seq, ...chunk };
    st.chunks.push(c);
    if (st.chunks.length > LOCAL_CHUNKS) st.chunks.splice(0, st.chunks.length - LOCAL_CHUNKS);
    st.pending.push(c);
    if (chunk.delta) st.shown += chunk.delta;
    if (chunk.thinking) st.shownThinking += chunk.thinking;
    this.emit(st, 'chat.chunk', { conversationId: st.conversationId, messageId: st.messageId, ...c });
  }

  /**
   * Stores the answer. While streaming: a snapshot of the released text at the current sequence number (then the
   * shared buffer drops what the snapshot covers). At the end (`final`): the answer as checked, and the buffer goes.
   */
  private flush(st: Stream, final?: Record<string, unknown>): Promise<void> {
    st.lastFlush = Date.now();
    return this.io(st, async () => {
      await this.writePending(st);
      const seq = st.seq;
      const content = final ? st.content : st.shown;
      const thinking = final ? st.thinking : st.shownThinking;
      const tools = st.tools.slice();
      await this.db('messages')
        .where({ id: st.messageId })
        .update({
          content: await this.seal(st.tenantId, st.messageId, 'content', content),
          thinking: thinking ? await this.seal(st.tenantId, st.messageId, 'thinking', thinking) : null,
          tools: tools.length ? await this.seal(st.tenantId, st.messageId, 'tools', JSON.stringify(tools)) : null,
          seq,
          state: st.state,
          heartbeat_at: Date.now(),
          ...(final ?? {})
        });
      if (final) await this.store.drop([st.messageId]);
      else await this.store.trim(st.messageId, seq);
    });
  }

  /** The path from the root to a message, opened, as Ollama chat messages (failed, held and withdrawn answers left out). */
  private async history(c: ConversationRow, parentId: string, vision: boolean): Promise<ChatMessage[]> {
    const rows = (await this.db('messages').where({ conversation_id: c.id })) as MessageRow[];
    const byId = new Map(rows.map((x) => [x.id, x]));
    const path: MessageRow[] = [];
    for (let cur = byId.get(parentId); cur; cur = cur.parent_id ? byId.get(cur.parent_id) : undefined) path.unshift(cur);
    const out: ChatMessage[] = [];
    for (const m of path) {
      if (m.role === 'assistant' && ['failed', 'queued', 'held', 'withdrawn'].includes(m.state)) continue;
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
   * the profile's prompt, raises the conversation's label to the highest item used and records the citations. The
   * items are kept with the stream: when the answer is finished, each knowledge citation gets its passage.
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
    st.context = { items, citations };
    await this.db('messages').where({ id: m.id }).update({ citations: await this.seal(c.tenant_id, m.id, 'citations', JSON.stringify(citations)), ...(label !== c.label ? { label } : {}) });
    if (label !== c.label) {
      await this.db('conversations').where({ id: c.id }).update({ label });
      c.label = label;
    }
    this.emit(st, 'chat.status', { conversationId: c.id, messageId: m.id, state: 'context', label, citations: citations.length });
  }

  /**
   * The citations with the passage of each knowledge chunk the answer draws on: the chunk id (already there), the
   * span within the chunk and its text, sealed with the rest. Memories get no passage (a forgotten memory must not
   * live on in old answers).
   */
  private async citationsWithPassages(st: Stream): Promise<string | null> {
    if (!st.context) return null;
    const { items, citations } = st.context;
    const out = citations.map((cite, i) => {
      const it = items[i];
      if (!it || it.tag !== 'context') return cite;
      const [s, e] = passageSpan(it.text, st.content);
      return { ...cite, span: [s, e], passage: it.text.slice(s, e) };
    });
    return this.seal(st.tenantId, st.messageId, 'citations', JSON.stringify(out));
  }

  /** The streaming screen for this answer: the deterministic `model-output` rules, loaded once. */
  private async startGuards(p: Principal, c: ConversationRow, r: ResolvedProfile, st: Stream, from?: Continuation): Promise<void> {
    if (!this.guardrails.streamScreen) return;
    let screen: Awaited<ReturnType<NonNullable<Guardrails['streamScreen']>>>;
    try {
      screen = await this.guardrails.streamScreen({ tenantId: c.tenant_id, workspaceId: c.workspace_id, checkpoint: 'model-output', label: c.label, principal: p, source: { kind: 'message', id: st.messageId }, meta: { conversationId: c.id, profile: r.profile.name, model: r.model.name, via: 'chat' } });
    } catch (err) {
      // Without the screen nothing is released until the finished answer has passed the full check.
      this.log.warn({ err, message: st.messageId }, 'streaming screen unavailable; the answer is sent once checked');
      st.deferred = true;
      return;
    }
    if (!screen) return;
    st.guard = new StreamGuard(screen);
    st.thinkGuard = new StreamGuard(screen);
    if (from) {
      st.guard.preload(from.content);
      st.thinkGuard.preload(from.thinking);
    }
  }

  /** Model text goes out only as far as the streaming screen has passed it. */
  private async release(st: Stream, kind: 'delta' | 'thinking', text: string): Promise<void> {
    if (st.deferred) return;
    const g = kind === 'delta' ? st.guard : st.thinkGuard;
    if (!g) {
      if (!st.held) this.push(st, { [kind]: text });
      return;
    }
    this.released(st, kind, await g.push(text));
  }

  private released(st: Stream, kind: 'delta' | 'thinking', out: Release): void {
    if (out.text && !st.held) this.push(st, { [kind]: out.text });
    if (out.halted) throw new GuardHalt(out.decision?.reason ?? 'Blocked by a guardrail.');
    if (out.held && !st.held) {
      st.held = true;
      this.emit(st, 'chat.status', { conversationId: st.conversationId, messageId: st.messageId, state: 'held' });
    }
  }

  /** The end of the answer, screened like the rest (a block here is decided by the full check that follows). */
  private async finishGuards(st: Stream): Promise<void> {
    for (const [g, kind] of [[st.guard, 'delta'], [st.thinkGuard, 'thinking']] as const) {
      if (!g || st.held || g.halted) continue;
      try {
        this.released(st, kind, await g.finish());
      } catch (err) {
        if (!(err instanceof GuardHalt)) throw err;
      }
    }
  }

  private async generate(p: Principal, c: ConversationRow, m: MessageRow, resolved: ResolvedProfile, think: ThinkLevel, kind: 'chat' | 'compare', st: Stream, from?: Continuation): Promise<void> {
    const usage: Usage = { promptTokens: 0, outputTokens: 0, thinkingTokens: 0, calcCalls: 0, gpuMs: 0, firstTokenMs: null };
    let lease: Lease | null = null;
    let r = resolved;
    const started = Date.now();
    let promptChars = 0;
    let evalCounted = false;
    let lastWrite = Date.now();
    const produced = { content: st.content.length, thinking: st.thinking.length };
    this.emit(st, 'chat.status', { conversationId: c.id, messageId: m.id, state: 'queued', profile: r.profile.name, model: r.model.name, ...(from ? { continuing: from.seq } : {}) });
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
      await this.db('messages').where({ id: m.id }).update({ state: 'streaming', instance_id: lease.instance.id, model: r.model.name, heartbeat_at: Date.now(), generator: this.instance });
      this.emit(st, 'chat.status', { conversationId: c.id, messageId: m.id, state: lease.cold ? 'loading' : 'streaming', instance: lease.instance.name, model: r.model.name, profile: r.profile.name });

      const messages: ChatMessage[] = [];
      if (r.profile.system_prompt) messages.push({ role: 'system', content: r.profile.system_prompt });
      messages.push(...(await this.history(c, m.parent_id!, r.model.capabilities.includes('vision'))));
      await this.addContext(p, c, m, r, lease, messages, st);
      // A continued answer: the stored text is the start of the model's turn, which it carries on.
      if (from?.content) messages.push({ role: 'assistant', content: from.content });
      await this.startGuards(p, c, r, st, from);
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
            await this.release(st, 'thinking', msg.thinking);
          }
          if (msg?.content) {
            st.content += msg.content;
            roundContent += msg.content;
            await this.release(st, 'delta', msg.content);
          }
          if (msg?.tool_calls?.length) calls.push(...msg.tool_calls);
          if (chunk.done) {
            evalCounted = true;
            usage.promptTokens += chunk.prompt_eval_count ?? 0;
            usage.outputTokens += chunk.eval_count ?? 0;
            usage.gpuMs += ((chunk.prompt_eval_duration ?? 0) + (chunk.eval_duration ?? 0) + (chunk.load_duration ?? 0)) / 1e6;
          }
          if (Date.now() - st.lastFlush > 2000) await this.flush(st);
          else if (Date.now() - lastWrite > 250 && st.pending.length) {
            lastWrite = Date.now();
            void this.io(st, () => this.writePending(st)).catch(() => undefined);
          }
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
          if (!st.held) this.push(st, { tool });
          messages.push({ role: 'tool', tool_name: call.function.name, content: JSON.stringify(tool.result ?? tool.output ?? { error: tool.error }) });
        }
      }
      st.state = 'complete';
    } catch (err) {
      if (err instanceof GuardHalt) {
        // The streaming screen blocked: stop the model; the full check below withholds the answer.
        st.state = 'complete';
        st.ac.abort(err);
      } else if (st.shutdown) st.state = 'interrupted';
      else if (st.stopRequested) st.state = 'stopped';
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
    if (st.state === 'complete' || st.state === 'stopped') await this.finishGuards(st);
    if (st.state === 'failed' || st.state === 'interrupted') {
      // Only what passed the screen is kept: an unscreened tail never reaches storage.
      st.content = st.shown;
      st.thinking = st.shownThinking;
    }
    // A screen that stopped the thinking must withhold the answer even when no answer text was produced.
    const screened = !!(st.guard?.halted || st.thinkGuard?.halted || st.held);
    const guard = (st.state === 'complete' || st.state === 'stopped') && (st.content || screened) ? await this.guardOutput(p, c, m, r, st) : null;
    if (guard?.held) st.state = 'held';
    if (st.deferred && !guard?.replaced && !guard?.held && (st.state === 'complete' || st.state === 'stopped')) {
      if (st.thinking) this.push(st, { thinking: st.thinking });
      if (st.content) this.push(st, { delta: st.content });
    }

    // Metering happens once, on the final chunk; a stopped stream is estimated from what was produced.
    const newContent = st.content.length - produced.content;
    const newThinking = st.thinking.length - produced.thinking;
    if (!evalCounted && (newContent > 0 || newThinking > 0)) {
      usage.promptTokens = Math.ceil(promptChars / 4);
      usage.outputTokens = Math.ceil((Math.max(0, newContent) + Math.max(0, newThinking)) / 4);
    }
    if (usage.outputTokens && st.thinking) usage.thinkingTokens = Math.round((usage.outputTokens * st.thinking.length) / (st.thinking.length + st.content.length || 1));
    const metered = usage.promptTokens + usage.outputTokens > 0;
    const prior = from?.usage ?? { promptTokens: 0, outputTokens: 0, thinkingTokens: 0, calcCalls: 0, gpuMs: 0 };
    const passages = st.state !== 'failed' && !(guard?.replaced && guard.decision.action === 'block') ? await this.citationsWithPassages(st) : null;
    await this.flush(st, {
      completed_at: st.state === 'interrupted' ? null : Date.now(),
      prompt_tokens: prior.promptTokens + usage.promptTokens,
      output_tokens: prior.outputTokens + usage.outputTokens,
      thinking_tokens: prior.thinkingTokens + usage.thinkingTokens,
      calc_calls: prior.calcCalls + usage.calcCalls,
      gpu_ms: Math.round(prior.gpuMs + usage.gpuMs),
      first_token_ms: usage.firstTokenMs,
      ...(guard ? { guard: JSON.stringify(guard.summary) } : {}),
      ...(passages ? { citations: passages } : {})
    });
    // A replaced or held answer is read back from the store, not from the streamed chunks.
    if ((guard?.replaced || guard?.held) && this.streams.get(m.id) === st) this.streams.delete(m.id);
    if (metered) {
      await this.quotas.record({ tenantId: c.tenant_id, workspaceId: c.workspace_id, userId: p.userId, apiKeyId: p.apiKeyId, kind, profileId: r.profile.id, model: r.model.name, poolId: lease?.pool.id ?? null, conversationId: c.id, messageId: m.id, promptTokens: usage.promptTokens, outputTokens: usage.outputTokens, thinkingTokens: usage.thinkingTokens, calcCalls: usage.calcCalls, gpuMs: usage.gpuMs });
    }
    if (guard?.held) await this.fileHold(p, c, m, st, guard.decision);
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

  /** Files a held answer in the flag queue, where a reviewer cleared for its label approves or rejects it. */
  private async fileHold(p: Principal, c: ConversationRow, m: MessageRow, st: Stream, d: GuardDecision): Promise<void> {
    try {
      const f = d.findings.find((x) => x.stage === 'enforce' && x.action === 'require-approval');
      const flag = await this.opts.flags!.create({
        tenantId: c.tenant_id,
        workspaceId: c.workspace_id,
        kind: 'hold',
        checkpoint: 'model-output',
        ruleId: f?.ruleId ?? null,
        ruleName: f?.ruleName ?? 'Held for review',
        setId: f?.setId ?? null,
        stage: 'enforce',
        action: 'require-approval',
        severity: 'medium',
        label: c.label,
        text: st.content,
        span: f?.span ?? null,
        note: d.reason ?? 'A guardrail held this answer for review.',
        actor: { user: p.userId, name: p.displayName, via: 'chat' },
        source: { kind: 'message', id: m.id },
        conversationId: c.id
      });
      await this.audit.append({ tenantId: c.tenant_id, action: 'chat.held', kind: 'system', actor: actorFrom(p), target: { conversation: c.id, message: m.id, flag: `F-${flag.number}` }, label: c.label, detail: { rule: f?.ruleName ?? null, reason: d.reason ?? null } });
    } catch (err) {
      this.log.error({ err, message: m.id }, 'held answer could not be filed for review');
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
   * The model-output checkpoint, on the finished (or stopped) answer, with every rule (guard model and classifiers
   * included). A block replaces the answer with a notice; a hold keeps it, invisible, for a reviewer (or replaces it
   * when there is no review queue); a redaction replaces the flagged spans. What the streaming screen already
   * stopped stays stopped. The stored answer is what the user sees from then on.
   */
  private async guardOutput(p: Principal, c: ConversationRow, m: MessageRow, r: ResolvedProfile, st: Stream): Promise<{ summary: Record<string, unknown>; replaced: boolean; held: boolean; decision: GuardDecision } | null> {
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
    const halt = st.guard?.halted ?? st.thinkGuard?.halted ?? null;
    const hold = st.held ? (st.guard?.held ?? st.thinkGuard?.held ?? { action: 'require-approval' as const, text: st.content, findings: [], reason: 'Held for review while streaming.' }) : null;
    if (halt && d.action !== 'block') d = { ...d, action: 'block', reason: halt.reason ?? d.reason ?? 'Blocked by a guardrail.', findings: [...d.findings, ...halt.findings] };
    else if (hold && d.action !== 'block' && d.action !== 'require-approval') {
      const reason = hold.reason ?? d.reason;
      d = { ...d, action: 'require-approval', ...(reason ? { reason } : {}), findings: [...d.findings, ...hold.findings] };
    }
    const enforced = d.findings.filter((f) => f.stage === 'enforce');
    if (!enforced.length && d.action === 'allow') return null;
    const summary = { action: d.action, ...(d.reason ? { reason: d.reason } : {}), rules: [...new Set(enforced.map((f) => f.ruleName))] };
    let replaced = false;
    let held = false;
    if (d.action === 'require-approval' && this.opts.flags) held = true;
    else if (d.action === 'block' || d.action === 'require-approval') {
      st.content = `This answer was withheld. ${d.reason ?? ''}`.trim();
      st.thinking = '';
      replaced = true;
    } else if (d.action === 'redact' && d.text !== st.content) {
      st.content = d.text;
      replaced = true;
    }
    if (replaced || held) {
      // Clients holding the streamed text see a higher sequence number on chat.done and read the answer again.
      st.seq++;
      st.chunks = [];
    }
    return { summary, replaced, held, decision: d };
  }
}
