import { ulid } from 'ulid';
import { hmac, randomToken } from '../crypto/index.js';
import { json } from '../db/knex.js';
import { clears, labelRank, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { actorFrom } from '../audit/chain.js';
import { badRequest, conflict, forbidden, notFound } from '../http/problem.js';
import { TOPICS } from '../platform/bus.js';
import { loadPrincipal, workspacesFor } from '../http/middleware.js';
import type { Services } from '../services.js';
import type { ArtifactView } from './artifacts.js';
import type { ConversationRow } from './service.js';

/*
 * Conversation sharing (B-305) and export (B-306).
 *
 * The owner shares a conversation read-only with a user or a workspace of the same tenant, or through a link. A link
 * token is shown once and stored as an HMAC digest; opening it needs a signed-in user of the same tenant. Every read
 * checks, at that moment, that the share is live (not revoked, not expired) and that the reader's clearance covers the
 * conversation's label as it is now, so revoking or a label rising above the reader ends access at once. Readers get a
 * transcript of the active branch; nothing they hold lets them write, because every chat write route resolves the
 * conversation through its owner.
 *
 * Exports are Markdown or JSON documents of the active branch with its citations, produced by a job, passed through
 * the `export` guardrail checkpoint, sealed with the tenant key in the blob store, and downloadable by the requester.
 */

export type ShareKind = 'user' | 'workspace' | 'link';

export interface ShareRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  kind: ShareKind;
  user_id: string | null;
  workspace_id: string | null;
  token_hash: string | null;
  expires_at: number | null;
  created_by: string;
  created_at: number;
  revoked_at: number | null;
  revoked_by: string | null;
  last_viewed_at: number | null;
  /** Sprint 16: a link that opens signed-out (only while the conversation is `public` and the tenant allows it). */
  anonymous?: boolean | number;
}

/** The tenant's sharing settings (Sprint 16). Anonymous links are off by default. */
export interface SharingSettings {
  anonymousLinks: boolean;
  anonymousMaxHours: number;
  updatedBy: string | null;
  updatedAt: number | null;
}

/**
 * What the socket layer hears when access to a shared conversation may have ended: a share revoked, or the
 * conversation's label raised above some readers. Readers' live subscriptions are re-checked at once.
 */
export interface ShareAccessEvent {
  tenantId: string;
  conversationId: string;
  shareId?: string;
  label?: Label;
}

/** A transcript for an anonymous reader: no owner, no ids of people. */
export type PublicTranscript = Omit<Transcript, 'owner'>;

export interface ExportRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  user_id: string;
  format: 'markdown' | 'json';
  label: Label;
  state: 'queued' | 'running' | 'ready' | 'failed';
  file: string;
  blob_key: string | null;
  bytes: number | null;
  error: string | null;
  job_id: string | null;
  created_at: number;
}

interface MessageRow {
  id: string;
  tenant_id: string;
  parent_id: string | null;
  role: 'user' | 'assistant';
  content: string | null;
  tools: string | null;
  state: string;
  profile_name: string | null;
  model: string | null;
  label: Label;
  citations?: string | null;
  error: string | null;
  created_at: number;
  completed_at: number | null;
  /** 1.7.0 (B-11701): sealed thinking, carried by exports the policy allows. */
  thinking?: string | null;
}

export interface TranscriptMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  state: string;
  profile: string | null;
  model: string | null;
  label: Label;
  citations: Record<string, unknown>[];
  tools: Record<string, unknown>[];
  createdAt: number;
  completedAt: number | null;
  /** 1.7.0 (B-11701): the thinking, only in exports the policy lets carry it. */
  thinking?: string | null;
}

export interface Transcript {
  id: string;
  title: string | null;
  label: Label;
  owner: { id: string; name: string | null };
  createdAt: number;
  updatedAt: number;
  messages: TranscriptMessage[];
  /** 1.6.0 (B-8001): the artifacts whose versions come from the shown messages, with sandboxed render links. */
  artifacts: ArtifactView[];
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const shareFromRow = (r: Record<string, unknown>): ShareRow => ({ ...(r as unknown as ShareRow), expires_at: num(r.expires_at), created_at: Number(r.created_at), revoked_at: num(r.revoked_at), last_viewed_at: num(r.last_viewed_at), anonymous: !!r.anonymous });
const exportFromRow = (r: Record<string, unknown>): ExportRow => ({ ...(r as unknown as ExportRow), bytes: num(r.bytes), created_at: Number(r.created_at) });
const live = (x: ShareRow, now = Date.now()) => x.revoked_at == null && (x.expires_at == null || x.expires_at > now);
/** Answers that are not finished (or are held for review) are never shown to readers or exported. */
const SHOWN = new Set(['complete', 'stopped']);

export class ConversationSharing {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  private tokenHash(token: string): string {
    return hmac(this.s().cfg.SESSION_SECRET, `share-link:${token}`);
  }

  private async conversationRow(tenantId: string, id: string): Promise<ConversationRow | undefined> {
    const c = (await this.db('conversations').where({ tenant_id: tenantId, id }).first()) as ConversationRow | undefined;
    return c ? { ...c, created_at: Number(c.created_at), updated_at: Number(c.updated_at) } : undefined;
  }

  // ---------- shares (owner side) ----------

  // ---------- tenant settings (Sprint 16) ----------

  async settings(tenantId: string): Promise<SharingSettings> {
    const r = (await this.db('chat_sharing_settings').where({ tenant_id: tenantId }).first()) as { anonymous_links: boolean | number; anonymous_max_hours: number; updated_by: string | null; updated_at: number } | undefined;
    return { anonymousLinks: !!r?.anonymous_links, anonymousMaxHours: r ? Number(r.anonymous_max_hours) : 72, updatedBy: r?.updated_by ?? null, updatedAt: r ? Number(r.updated_at) : null };
  }

  async setSettings(tenantId: string, userId: string, input: { anonymousLinks: boolean; anonymousMaxHours?: number }): Promise<SharingSettings> {
    const before = await this.settings(tenantId);
    const row = { anonymous_links: input.anonymousLinks, anonymous_max_hours: input.anonymousMaxHours ?? before.anonymousMaxHours, updated_by: userId, updated_at: Date.now() };
    if (!(await this.db('chat_sharing_settings').where({ tenant_id: tenantId }).update(row))) await this.db('chat_sharing_settings').insert({ tenant_id: tenantId, ...row });
    return this.settings(tenantId);
  }

  // ---------- shares (owner side) ----------

  async create(p: Principal, conversationId: string, input: { kind: 'user'; userId: string } | { kind: 'workspace'; workspaceId: string } | { kind: 'link'; expiresInHours: number; anonymous?: boolean }): Promise<{ share: ShareRow; token?: string }> {
    const c = await this.s().chat.conversation(p, conversationId);
    const t = Date.now();
    const base: ShareRow = { id: ulid(), tenant_id: p.tenantId, conversation_id: c.id, kind: input.kind, user_id: null, workspace_id: null, token_hash: null, expires_at: null, created_by: p.userId, created_at: t, revoked_at: null, revoked_by: null, last_viewed_at: null, anonymous: false };
    let token: string | undefined;
    if (input.kind === 'user') {
      const u = await this.s().users.get(p.tenantId, input.userId);
      if (!u || u.state !== 'active') throw notFound('User');
      if (u.id === p.userId) throw conflict('This is your own conversation.');
      if (!clears(u.clearance as Label, c.label)) throw forbidden(`${u.display_name}'s clearance is ${u.clearance}; this conversation is ${c.label}.`, { step: 'clearance' });
      const dup = (await this.db('conversation_shares').where({ tenant_id: p.tenantId, conversation_id: c.id, kind: 'user', user_id: u.id }).whereNull('revoked_at').first()) as Record<string, unknown> | undefined;
      if (dup) throw conflict(`The conversation is already shared with ${u.display_name}.`);
      base.user_id = u.id;
    } else if (input.kind === 'workspace') {
      const ws = await this.s().tenants.workspace(p.tenantId, input.workspaceId);
      if (!ws) throw notFound('Workspace');
      if (labelRank(c.label) > labelRank(ws.label_ceiling)) throw forbidden(`${ws.name}'s ceiling is ${ws.label_ceiling}; this conversation is ${c.label}.`, { step: 'zone' });
      const dup = (await this.db('conversation_shares').where({ tenant_id: p.tenantId, conversation_id: c.id, kind: 'workspace', workspace_id: ws.id }).whereNull('revoked_at').first()) as Record<string, unknown> | undefined;
      if (dup) throw conflict(`The conversation is already shared with ${ws.name}.`);
      base.workspace_id = ws.id;
    } else {
      if (input.anonymous) {
        // B-706: opt-in per tenant, public conversations only, and never longer than the tenant allows.
        const set = await this.settings(p.tenantId);
        if (!set.anonymousLinks) throw forbidden('Anonymous links are turned off for this tenant. A tenant admin can turn them on.', { step: 'policy' });
        if (c.label !== 'public') throw forbidden(`Only public conversations can have an anonymous link; this one is ${c.label}.`, { step: 'label' });
        if (input.expiresInHours > set.anonymousMaxHours) throw badRequest(`Anonymous links expire within ${set.anonymousMaxHours} hours in this tenant.`);
        base.anonymous = true;
      }
      token = `exs_${randomToken(32)}`;
      base.token_hash = this.tokenHash(token);
      base.expires_at = t + input.expiresInHours * 3_600_000;
    }
    await this.db('conversation_shares').insert(base);
    return { share: base, ...(token ? { token } : {}) };
  }

  async list(p: Principal, conversationId: string): Promise<ShareRow[]> {
    const c = await this.s().chat.conversation(p, conversationId);
    return ((await this.db('conversation_shares').where({ tenant_id: p.tenantId, conversation_id: c.id }).orderBy('created_at', 'desc')) as Record<string, unknown>[]).map(shareFromRow);
  }

  async revoke(p: Principal, conversationId: string, shareId: string): Promise<ShareRow> {
    const c = await this.s().chat.conversation(p, conversationId);
    const r = await this.db('conversation_shares').where({ tenant_id: p.tenantId, conversation_id: c.id, id: shareId }).first();
    if (!r) throw notFound('Share');
    const x = shareFromRow(r);
    if (x.revoked_at != null) return x;
    const t = Date.now();
    await this.db('conversation_shares').where({ id: x.id }).update({ revoked_at: t, revoked_by: p.userId });
    // Live readers through this share lose the stream at once, on every instance (B-705).
    this.s().bus.publish(TOPICS.shareAccess, { tenantId: p.tenantId, conversationId: c.id, shareId: x.id } satisfies ShareAccessEvent);
    return { ...x, revoked_at: t, revoked_by: p.userId };
  }

  // ---------- reading (reader side) ----------

  /** The live share that lets `p` read the conversation, or null. The owner needs none. */
  private async grantFor(p: Principal, c: ConversationRow): Promise<ShareRow | null> {
    const rows = ((await this.db('conversation_shares').where({ tenant_id: p.tenantId, conversation_id: c.id }).whereIn('kind', ['user', 'workspace']).whereNull('revoked_at')) as Record<string, unknown>[]).map(shareFromRow).filter((x) => live(x));
    const direct = rows.find((x) => x.kind === 'user' && x.user_id === p.userId);
    if (direct) return direct;
    const wsShares = rows.filter((x) => x.kind === 'workspace');
    if (!wsShares.length) return null;
    const mine = new Set((await this.s().tenants.workspacesForUser(p.tenantId, p.userId)).map((w) => w.id));
    return wsShares.find((x) => x.workspace_id && mine.has(x.workspace_id)) ?? null;
  }

  /** The conversation, when `p` owns it or holds a live share and is cleared for its current label. */
  async readable(p: Principal, conversationId: string): Promise<{ c: ConversationRow; via: 'owner' | ShareRow }> {
    const c = await this.conversationRow(p.tenantId, conversationId);
    if (!c) throw notFound('Conversation');
    if (c.user_id === p.userId) return { c, via: 'owner' };
    const grant = await this.grantFor(p, c);
    if (!grant) throw notFound('Conversation');
    if (!clears(p.clearance, c.label)) throw forbidden(`This conversation is now ${c.label}; your clearance is ${p.clearance}.`, { step: 'clearance' });
    return { c, via: grant };
  }

  async sharedWithMe(p: Principal) {
    const mine = (await this.s().tenants.workspacesForUser(p.tenantId, p.userId)).map((w) => w.id);
    const q = this.db('conversation_shares as s')
      .join('conversations as c', 'c.id', 's.conversation_id')
      .where('s.tenant_id', p.tenantId)
      .whereNull('s.revoked_at')
      .andWhereNot('c.user_id', p.userId)
      .andWhere((b) => {
        b.where({ 's.kind': 'user', 's.user_id': p.userId });
        if (mine.length) b.orWhere((x) => x.where('s.kind', 'workspace').whereIn('s.workspace_id', mine));
      })
      .select('s.*', 'c.title as c_title', 'c.label as c_label', 'c.user_id as c_owner', 'c.updated_at as c_updated');
    const rows = (await q.orderBy('s.created_at', 'desc')) as Record<string, unknown>[];
    const seen = new Set<string>();
    const out = [];
    for (const r of rows) {
      const x = shareFromRow(r);
      if (!live(x) || seen.has(x.conversation_id) || !clears(p.clearance, r.c_label as Label)) continue;
      seen.add(x.conversation_id);
      const owner = await this.s().users.get(p.tenantId, String(r.c_owner));
      out.push({ conversationId: x.conversation_id, shareId: x.id, kind: x.kind, title: r.c_title ? await this.s().keys.open(p.tenantId, String(r.c_title), `title:${x.conversation_id}`) : null, label: r.c_label as Label, owner: owner?.display_name ?? null, sharedAt: x.created_at, updatedAt: Number(r.c_updated) });
    }
    return out;
  }

  async openShared(p: Principal, conversationId: string): Promise<Transcript> {
    const { c, via } = await this.readable(p, conversationId);
    if (via !== 'owner') await this.db('conversation_shares').where({ id: via.id }).update({ last_viewed_at: Date.now() });
    return this.transcript(c, p.clearance);
  }

  /** Opens a share link. The reader must be signed in to the same tenant and cleared for the label. */
  async openLink(p: Principal, token: string, ip: string | null): Promise<{ transcript: Transcript; share: ShareRow }> {
    const r = await this.db('conversation_shares').where({ token_hash: this.tokenHash(token), kind: 'link' }).first();
    // A link from another tenant is simply not found: tenants never see each other's conversations.
    if (!r || r.tenant_id !== p.tenantId) throw notFound('Shared conversation');
    const x = shareFromRow(r);
    if (!live(x)) throw notFound('Shared conversation');
    const c = await this.conversationRow(p.tenantId, x.conversation_id);
    if (!c) throw notFound('Shared conversation');
    if (!clears(p.clearance, c.label)) throw forbidden(`This conversation is ${c.label}; your clearance is ${p.clearance}.`, { step: 'clearance' });
    await this.db('conversation_shares').where({ id: x.id }).update({ last_viewed_at: Date.now() });
    await this.s().audit.append({ tenantId: p.tenantId, action: 'conversation.share.opened', kind: 'admin', actor: actorFrom(p, ip), target: { conversation: c.id, share: x.id }, label: c.label, detail: { kind: 'link' } });
    return { transcript: await this.transcript(c, p.clearance), share: x };
  }

  /**
   * Opens an anonymous link (B-706), signed-out. It works only while the link is live, the tenant still allows
   * anonymous links, and the conversation is `public` at this moment: a label raised since, the setting turned off, a
   * revocation or expiry all end it. Every open is audited with the address; nothing is kept for the reader (no
   * session, no cookie). Any refusal looks the same, so a link says nothing about what is behind it.
   */
  async openAnonymous(token: string, ip: string | null, traceId?: string): Promise<PublicTranscript> {
    const gone = () => notFound('Shared conversation');
    const r = await this.db('conversation_shares').where({ token_hash: this.tokenHash(token), kind: 'link' }).first();
    if (!r || !r.anonymous) throw gone();
    const x = shareFromRow(r);
    if (!live(x)) throw gone();
    if (!(await this.settings(x.tenant_id)).anonymousLinks) throw gone();
    const tenant = await this.s().tenants.byId(x.tenant_id);
    if (!tenant || tenant.state !== 'active') throw gone();
    const c = await this.conversationRow(x.tenant_id, x.conversation_id);
    if (!c || c.label !== 'public') throw gone();
    await this.db('conversation_shares').where({ id: x.id }).update({ last_viewed_at: Date.now() });
    await this.s().audit.append({ tenantId: x.tenant_id, action: 'conversation.share.opened', kind: 'system', actor: { ip: ip ?? null }, target: { conversation: c.id, share: x.id }, label: c.label, detail: { kind: 'link', anonymous: true }, traceId: traceId ?? null });
    const t = await this.transcript(c, 'public');
    const { owner: _owner, ...rest } = t;
    return rest;
  }

  /** The active branch (root to head), opened, with citations the reader is cleared for. */
  async transcript(c: ConversationRow, clearance: Label, opts: { thinking?: boolean } = {}): Promise<Transcript> {
    const keys = this.s().keys;
    const rows = (await this.db('messages').where({ conversation_id: c.id })) as MessageRow[];
    const byId = new Map(rows.map((m) => [m.id, m]));
    const path: MessageRow[] = [];
    for (let cur = c.head_id ? byId.get(c.head_id) : undefined; cur; cur = cur.parent_id ? byId.get(cur.parent_id) : undefined) path.unshift(cur);
    const owner = await this.s().users.get(c.tenant_id, c.user_id);
    const messages: TranscriptMessage[] = [];
    for (const m of path) {
      // A question held for review (or rejected) is not shown to readers, nor its answer.
      const shown = m.role === 'user' ? m.state !== 'held' && m.state !== 'withdrawn' && m.state !== 'hidden' : SHOWN.has(m.state);
      const content = shown && m.content ? await keys.open(c.tenant_id, m.content, `content:${m.id}`) : '';
      const citations = shown && m.citations ? json<Record<string, unknown>[]>(await keys.open(c.tenant_id, m.citations, `citations:${m.id}`), []) : [];
      const tools = shown && m.tools ? json<Record<string, unknown>[]>(await keys.open(c.tenant_id, m.tools, `tools:${m.id}`), []) : [];
      const thinking = opts.thinking && shown && m.thinking ? await keys.open(c.tenant_id, m.thinking, `thinking:${m.id}`) : null;
      messages.push({
        ...(opts.thinking ? { thinking } : {}),
        id: m.id,
        role: m.role,
        content,
        state: m.state,
        profile: m.profile_name,
        model: m.model,
        label: m.label,
        citations: citations.filter((x) => typeof x.label !== 'string' || clears(clearance, x.label as Label)),
        tools,
        createdAt: Number(m.created_at),
        completedAt: num(m.completed_at)
      });
    }
    const artifacts = await this.s().chatArtifacts.forTranscript(c.id, messages.filter((m) => m.role === 'assistant' && SHOWN.has(m.state)).map((m) => m.id), clearance);
    return { id: c.id, artifacts, title: c.title ? await keys.open(c.tenant_id, c.title, `title:${c.id}`) : null, label: c.label, owner: { id: c.user_id, name: owner?.display_name ?? null }, createdAt: c.created_at, updatedAt: c.updated_at, messages };
  }

  // ---------- exports ----------

  registerJobs(): void {
    this.s().jobs.register('conversation.export', (p, ctx) => this.runExport(String(p.exportId), ctx.progress));
  }

  async requestExport(p: Principal, conversationId: string, format: 'markdown' | 'json'): Promise<ExportRow> {
    const { c } = await this.readable(p, conversationId);
    if (!clears(p.clearance, c.label)) throw forbidden(`This conversation is ${c.label}; your clearance is ${p.clearance}.`, { step: 'clearance' });
    const id = ulid();
    const stamp = new Date().toISOString().slice(0, 10);
    const row: ExportRow = { id, tenant_id: p.tenantId, conversation_id: c.id, user_id: p.userId, format, label: c.label, state: 'queued', file: `conversation-${stamp}-${id.slice(-6).toLowerCase()}.${format === 'json' ? 'json' : 'md'}`, blob_key: null, bytes: null, error: null, job_id: null, created_at: Date.now() };
    await this.db('conversation_exports').insert(row);
    const job = await this.s().jobs.enqueue({ tenantId: p.tenantId, type: 'conversation.export', payload: { exportId: id }, createdBy: p.userId, maxAttempts: 2 });
    await this.db('conversation_exports').where({ id }).update({ job_id: job.id });
    return { ...row, job_id: job.id };
  }

  async getExport(p: Principal, id: string): Promise<ExportRow> {
    const r = await this.db('conversation_exports').where({ tenant_id: p.tenantId, id, user_id: p.userId }).first();
    if (!r) throw notFound('Export');
    return exportFromRow(r);
  }

  async listExports(p: Principal, conversationId?: string): Promise<ExportRow[]> {
    const q = this.db('conversation_exports').where({ tenant_id: p.tenantId, user_id: p.userId });
    if (conversationId) q.andWhere({ conversation_id: conversationId });
    return ((await q.orderBy('created_at', 'desc').limit(50)) as Record<string, unknown>[]).map(exportFromRow);
  }

  /** The file, opened, for its requester, who must still be able to read the conversation at its current label. */
  async download(p: Principal, id: string): Promise<{ row: ExportRow; data: Buffer }> {
    const row = await this.getExport(p, id);
    if (row.state !== 'ready' || !row.blob_key) throw conflict(`The export is ${row.state}.`);
    await this.readable(p, row.conversation_id);
    if (!clears(p.clearance, row.label)) throw forbidden(`The export is ${row.label}; your clearance is ${p.clearance}.`, { step: 'clearance' });
    const sealed = await this.s().blobs.get(row.blob_key);
    if (!sealed) throw notFound('Export file');
    return { row, data: await this.s().keys.openBytes(row.tenant_id, sealed.toString('utf8'), `conversation-export:${row.id}`) };
  }

  private async runExport(id: string, progress: (pct: number, m?: string) => Promise<void>): Promise<unknown> {
    const s = this.s();
    const r = await this.db('conversation_exports').where({ id }).first();
    if (!r) throw new Error(`Export ${id} not found`);
    const e = exportFromRow(r);
    await this.db('conversation_exports').where({ id }).update({ state: 'running' });
    try {
      const p = await loadPrincipal(s, e.tenant_id, e.user_id, {});
      if (!p) throw new Error('The requester is no longer active.');
      p.workspaceId = (await workspacesFor(s, p))[0]?.id ?? null;
      // Access is checked again when the job runs: a share revoked in between ends the export.
      const { c } = await this.readable(p, e.conversation_id);
      // 1.7.0 (B-11701): the thinking rides in the export only when the policy says so and the exporter may see it.
      const policy = await s.thinking.policyFor(c.tenant_id, c.workspace_id);
      const t = await this.transcript(c, p.clearance, { thinking: policy.exports && s.thinking.visibleTo(policy, p, c.user_id) });
      await progress(40, `${t.messages.length} messages`);
      const exportedAt = new Date().toISOString();
      let text = e.format === 'json' ? JSON.stringify({ format: 'exprsn-ai.conversation.v1', exportedAt, exportedBy: p.username, conversation: t }, null, 2) : toMarkdown(t, p.username, exportedAt);
      const d = await s.guardrails.check({ tenantId: e.tenant_id, workspaceId: c.workspace_id, checkpoint: 'export', text, label: c.label, principal: p, source: { kind: 'conversation', id: c.id }, meta: { via: 'conversation-export', format: e.format } });
      if (d.action === 'block' || d.action === 'require-approval') throw new Error(`Refused by guardrails${d.reason ? `: ${d.reason}` : '.'}`);
      if (d.action === 'redact') text = d.text;
      const data = Buffer.from(text, 'utf8');
      const key = `conversation-exports/${e.tenant_id}/${e.id}.sealed`;
      await s.blobs.put(key, Buffer.from(await s.keys.sealBytes(e.tenant_id, data, `conversation-export:${e.id}`), 'utf8'), 'application/octet-stream');
      await this.db('conversation_exports').where({ id }).update({ state: 'ready', blob_key: key, bytes: data.length, label: c.label });
      await s.audit.append({ tenantId: e.tenant_id, action: 'conversation.export.ready', kind: 'system', actor: { service: 'exports', user: e.user_id }, target: { conversation: c.id, export: e.id }, label: c.label, detail: { format: e.format, bytes: data.length, messages: t.messages.length, guard: d.action } });
      return { bytes: data.length, messages: t.messages.length };
    } catch (err) {
      await this.db('conversation_exports').where({ id }).update({ state: 'failed', error: String((err as Error).message).slice(0, 500) });
      throw err;
    }
  }
}

const who = (m: TranscriptMessage) => (m.role === 'user' ? 'Question' : `Answer${m.profile ? ` (${m.profile}${m.model ? `, ${m.model}` : ''})` : ''}`);

function citationLine(c: Record<string, unknown>): string {
  const parts = [c.kb ?? c.kind, c.document ?? c.source ?? c.memory, c.section].filter((x) => typeof x === 'string' && x);
  return `${String(c.n ?? '')}. ${parts.join(', ') || 'source'}${typeof c.label === 'string' ? ` [${c.label}]` : ''}`;
}

export function toMarkdown(t: Transcript, by: string, at: string): string {
  const out = [`# ${t.title ?? 'Conversation'}`, '', `- Label: ${t.label}`, `- Owner: ${t.owner.name ?? t.owner.id}`, `- Exported: ${at} by ${by}`, `- Conversation: ${t.id}`, ''];
  for (const m of t.messages) {
    out.push(`## ${who(m)}`, '');
    if (m.role === 'assistant' && !SHOWN.has(m.state)) out.push(`_Not included: the answer is ${m.state}._`, '');
    else out.push(m.content, '');
    if (m.tools.length) {
      out.push('Tools:', '');
      for (const x of m.tools) out.push(`- ${String(x.name ?? 'tool')}: ${JSON.stringify(x.result ?? x.output ?? x.error ?? null)}`);
      out.push('');
    }
    if (m.citations.length) {
      out.push('Sources:', '');
      for (const c of m.citations) out.push(citationLine(c));
      out.push('');
    }
  }
  return out.join('\n');
}

export const shareView = (x: ShareRow, extra: { userName?: string | null; workspaceName?: string | null } = {}) => ({
  id: x.id,
  conversationId: x.conversation_id,
  kind: x.kind,
  userId: x.user_id,
  userName: extra.userName ?? null,
  workspaceId: x.workspace_id,
  workspaceName: extra.workspaceName ?? null,
  expiresAt: x.expires_at,
  createdAt: x.created_at,
  revokedAt: x.revoked_at,
  lastViewedAt: x.last_viewed_at,
  anonymous: !!x.anonymous,
  state: x.revoked_at != null ? 'revoked' : x.expires_at != null && x.expires_at <= Date.now() ? 'expired' : 'active'
});

export const exportView = (e: ExportRow) => ({ id: e.id, conversationId: e.conversation_id, format: e.format, label: e.label, state: e.state, file: e.file, bytes: e.bytes, error: e.error, jobId: e.job_id, createdAt: e.created_at });
