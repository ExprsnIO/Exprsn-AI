import { ulid } from 'ulid';
import { actorFrom, type AuditActor } from '../audit/chain.js';
import { csvLine } from '../audit/exports.js';
import { clears, isLabel, labelRank, type Label } from '../authz/labels.js';
import { ROLES } from '../authz/permissions.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { randomToken } from '../crypto/index.js';
import { json } from '../db/knex.js';
import type { ChatMessage } from '../gateway/ollama.js';
import { flagRef, type FlagRow } from '../guardrails/flags.js';
import type { GuardDecision } from '../guardrails/types.js';
import { workspacesFor } from '../http/middleware.js';
import { badRequest, conflict, forbidden, HttpProblem, notFound, tooManyRequests, unauthorized } from '../http/problem.js';
import type { ModeratedObject } from '../moderation/registry.js';
import { TOPICS, type IntegrationEvent } from '../platform/bus.js';
import { Limiter } from '../platform/ratelimit.js';
import type { Services } from '../services.js';
import { isVaultRef } from '../vault/policy.js';
import { generateReply, resolveTarget, TargetUnavailable } from './generate.js';
import { ChannelMail, type ChannelIo } from './mail.js';
import { customerKey, sessionKey, signSession, verifyIdentity, verifySession } from './tokens.js';

/*
 * Customer-service channels (B-2301 to B-2304). A channel lives in one workspace and answers customers with a
 * published profile or agent, at the channel's label: the label must fit under the workspace ceiling and the
 * profile's (and agent's) label, and the gateway leases only pools cleared for it. Customers reach chat channels
 * through the public endpoints (`/api/public/channels`), anonymously or with an identity assertion the channel's site
 * signs; email channels take mail by IMAP polling and provider webhooks and answer from an SMTP outbox (`mail.ts`).
 *
 * Every customer message passes the `user-input` checkpoint and every answer the `model-output` checkpoint at the
 * channel's label. An answer is held for review (a `hold` flag, B-2302) when the channel reviews every answer, when it
 * reviews escalated sessions and this one is escalated (the customer asked for a person, or a guardrail asked for
 * review), or when a guardrail requires approval. A reviewer approves, edits or rejects it; only then does the
 * customer receive it (as edited). Transcripts are sealed per row with the tenant key; each channel can purge sessions
 * after its retention period (B-2304), and transcripts export as CSV.
 */

export const CHANNEL_KINDS = ['chat', 'email'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];
export const REVIEW_MODES = ['never', 'escalated', 'always'] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];
export const TARGET_KINDS = ['profile', 'agent'] as const;
export const SESSION_STATES = ['open', 'escalated', 'closed', 'hidden'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const SESSION_OBJECT = 'channel-session';
export const MESSAGE_OBJECT = 'channel-message';
/** The flag source kind of a held reply. */
export const HELD_SOURCE = 'channel-message';

/** The most text one customer message carries. */
export const MAX_MESSAGE = 8000;
/** How many earlier messages a reply sees. */
const HISTORY = 30;

export interface MailSettings {
  /** The channel's own address: the From of replies, and mail from it is never answered. */
  address: string;
  fromName: string | null;
  imap: { host: string; port: number; secure: boolean; user: string; passwordRef: string; mailbox: string } | null;
  smtp: { host: string; port: number; secure: boolean; user: string; passwordRef: string } | null;
  /** The Mailgun webhook signing key, as a vault reference (`/email/mailgun` is refused without it). */
  mailgunKeyRef: string | null;
}

export interface ChannelSettings {
  greeting: string | null;
  email: MailSettings | null;
}

export interface ChannelRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  name: string;
  kind: ChannelKind;
  state: 'active' | 'paused' | 'deleted';
  label: Label;
  target_kind: 'profile' | 'agent';
  target_name: string;
  instructions: string | null;
  review_mode: ReviewMode;
  allow_anonymous: boolean;
  messages_per_minute: number;
  sessions_per_hour: number;
  retention_days: number | null;
  public_key: string;
  settings: ChannelSettings;
  identity_secret: string | null;
  webhook_secret: string | null;
  vault_owner: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface SessionRow {
  id: string;
  tenant_id: string;
  channel_id: string;
  workspace_id: string;
  label: Label;
  state: SessionState;
  customer_kind: 'anonymous' | 'identified' | 'email';
  customer_key: string | null;
  customer: string | null;
  subject: string | null;
  next_seq: number;
  escalated_at: number | null;
  escalation: string | null;
  last_activity_at: number;
  closed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  id: string;
  tenant_id: string;
  session_id: string;
  channel_id: string;
  seq: number;
  role: 'customer' | 'assistant' | 'agent' | 'notice';
  state: 'delivered' | 'held' | 'rejected' | 'hidden';
  via: 'web' | 'email' | 'reviewer';
  body: string;
  original: string | null;
  label: Label;
  flag_id: string | null;
  author_id: string | null;
  created_at: number;
  delivered_at: number | null;
}

export interface Customer {
  name: string | null;
  email: string | null;
  externalId: string | null;
}

export interface Ctx {
  p: Principal;
  ip: string | null;
  traceId?: string | null;
}

const num = (v: unknown) => Number(v);
const numOrNull = (v: unknown) => (v == null ? null : Number(v));
const label = (v: unknown): Label => (isLabel(v) ? v : 'internal');

export const channelFrom = (r: Record<string, unknown>): ChannelRow => ({
  ...(r as unknown as ChannelRow),
  label: label(r.label),
  allow_anonymous: !!r.allow_anonymous,
  messages_per_minute: num(r.messages_per_minute),
  sessions_per_hour: num(r.sessions_per_hour),
  retention_days: numOrNull(r.retention_days),
  settings: { greeting: null, email: null, ...json<Partial<ChannelSettings>>(r.settings, {}) },
  created_at: num(r.created_at),
  updated_at: num(r.updated_at)
});
export const sessionFrom = (r: Record<string, unknown>): SessionRow => ({
  ...(r as unknown as SessionRow),
  label: label(r.label),
  next_seq: num(r.next_seq),
  escalated_at: numOrNull(r.escalated_at),
  last_activity_at: num(r.last_activity_at),
  closed_at: numOrNull(r.closed_at),
  created_at: num(r.created_at),
  updated_at: num(r.updated_at)
});
export const messageFrom = (r: Record<string, unknown>): MessageRow => ({ ...(r as unknown as MessageRow), seq: num(r.seq), label: label(r.label), created_at: num(r.created_at), delivered_at: numOrNull(r.delivered_at) });

const aad = {
  instructions: (id: string) => `channel-instructions:${id}`,
  identity: (id: string) => `channel-identity:${id}`,
  webhook: (id: string) => `channel-webhook:${id}`,
  customer: (id: string) => `channel-customer:${id}`,
  subject: (id: string) => `channel-subject:${id}`,
  body: (id: string) => `channel-message:${id}`,
  original: (id: string) => `channel-original:${id}`
};
export const channelAad = aad;

/** Roles holding `channels:review` (for escalation notices). */
const REVIEWER_ROLES = ROLES.filter((r) => r.permissions === '*' || r.permissions.includes('channels:review')).map((r) => r.id);

/** The guidance every channel's answers start from, before the profile's, agent's and channel's own instructions. */
const BASE_SYSTEM = 'You answer customers of this organisation in a support channel. Be accurate, brief and polite. If you cannot help or are unsure, say so and tell the customer that a person from the team will follow up. Never claim to be a person.';

export interface ChannelInput {
  workspaceId?: string;
  name: string;
  kind: ChannelKind;
  label: Label;
  target: { kind: 'profile' | 'agent'; name: string };
  instructions?: string | null;
  reviewMode?: ReviewMode;
  allowAnonymous?: boolean;
  messagesPerMinute?: number;
  sessionsPerHour?: number;
  retentionDays?: number | null;
  greeting?: string | null;
  email?: MailSettings | null;
}

export class ChannelService {
  readonly mail: ChannelMail;
  private started = false;
  private key: Buffer | null = null;
  private readonly limits: { sessions: Limiter | null } = { sessions: null };

  constructor(
    private readonly s: () => Services,
    io: Partial<ChannelIo> = {}
  ) {
    this.mail = new ChannelMail(s, this, io);
  }

  private get db() {
    return this.s().db;
  }

  private get tokenKey(): Buffer {
    return (this.key ??= sessionKey(this.s().cfg.SESSION_SECRET));
  }

  private get sessionLimiter(): Limiter {
    return (this.limits.sessions ??= new Limiter(this.s().counters, 'channel-sessions', this.s().cfg.CHANNELS_SESSIONS_PER_HOUR, 3_600_000));
  }

  // ---------- wiring ----------

  /** Jobs (replies, IMAP polls, the outbox, retention, exports) and moderated object types. */
  init(): void {
    if (this.started) return;
    this.started = true;
    const s = this.s();
    s.jobs.register('channels.reply', async (p) => this.replyJob(String(p.tenantId), String(p.sessionId), String(p.messageId)));
    s.jobs.register('channels.retention', async (p, ctx) => this.purgeExpired(String(p.tenantId ?? ctx.job.tenant_id)));
    s.jobs.register('channels.export', async (p, ctx) => this.exportJob(ctx.job.tenant_id, ctx.job.id, p, ctx.progress), { timeoutMs: 30 * 60_000 });
    this.mail.registerJobs();
    this.registerModeration();
  }

  /** Recurring work: retention purges and IMAP polls, through the scheduler (each tick runs on one instance). */
  schedule(): void {
    const s = this.s();
    const tenants = async () => (await s.tenants.list()).filter((t) => t.state === 'active').map((t) => ({ tenantId: t.id, payload: { tenantId: t.id } }));
    s.scheduler.every('channels.retention', s.cfg.CHANNELS_RETENTION_SWEEP_MINUTES * 60_000, tenants);
    this.mail.schedule();
  }

  private async audit(actor: AuditActor, tenantId: string, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>, lbl?: Label, traceId?: string | null, kind: 'admin' | 'system' = 'admin'): Promise<void> {
    await this.s().audit.append({ tenantId, action, kind, actor, target, ...(detail ? { detail } : {}), ...(lbl ? { label: lbl } : {}), traceId: traceId ?? null });
  }

  private auditCtx(ctx: Ctx, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>, lbl?: Label): Promise<void> {
    return this.audit(actorFrom(ctx.p, ctx.ip), ctx.p.tenantId, action, target, detail, lbl, ctx.traceId);
  }

  /** A named catalogue event (`channel.*`) for webhooks and plugins: ids only, never customer text. */
  event(tenantId: string, type: string, lbl: Label, data: Record<string, unknown>): void {
    this.s().bus.emitLocal(TOPICS.integrationEvent, { tenantId, type, label: lbl, id: `${type}:${ulid()}`, data } satisfies IntegrationEvent);
  }

  /** Tells reviewers' consoles (the `channels:review` permission room) that a channel's sessions changed. */
  private changed(tenantId: string, data: Record<string, unknown>): void {
    this.s().bus.publish(TOPICS.poolState, { tenantId, perm: 'channels:review', event: 'channels.changed', data });
  }

  async seal(tenantId: string, text: string, a: string): Promise<string> {
    return this.s().keys.seal(tenantId, text, a);
  }

  async open(tenantId: string, sealed: string | null, a: string): Promise<string | null> {
    return sealed == null ? null : this.s().keys.open(tenantId, sealed, a);
  }

  customerKeyFor(tenantId: string, kind: 'email' | 'id', value: string): string {
    return customerKey(this.s().cfg.SESSION_SECRET, tenantId, kind, value);
  }

  // ---------- channels (channels:manage, channels:review) ----------

  async row(tenantId: string, id: string): Promise<ChannelRow | null> {
    const r = await this.db('channels').where({ tenant_id: tenantId, id }).whereNot({ state: 'deleted' }).first();
    return r ? channelFrom(r) : null;
  }

  async byKey(key: string): Promise<ChannelRow | null> {
    const r = await this.db('channels').where({ public_key: key }).whereNot({ state: 'deleted' }).first();
    return r ? channelFrom(r) : null;
  }

  /** A channel the caller may see: in a workspace they act in, at or below their clearance. */
  async visible(p: Principal, id: string, workspaces?: string[]): Promise<ChannelRow> {
    const c = await this.row(p.tenantId, id);
    const ws = workspaces ?? (await this.workspaceIds(p));
    if (!c || !ws.includes(c.workspace_id) || !clears(p.clearance, c.label)) throw notFound('Channel');
    return c;
  }

  async workspaceIds(p: Principal): Promise<string[]> {
    return (await workspacesFor(this.s(), p)).map((w) => w.id);
  }

  async view(c: ChannelRow) {
    const base = this.s().cfg.PUBLIC_URL.replace(/\/$/, '');
    return {
      id: c.id,
      workspaceId: c.workspace_id,
      name: c.name,
      kind: c.kind,
      state: c.state,
      label: c.label,
      target: { kind: c.target_kind, name: c.target_name },
      instructions: await this.open(c.tenant_id, c.instructions, aad.instructions(c.id)),
      reviewMode: c.review_mode,
      allowAnonymous: c.allow_anonymous,
      messagesPerMinute: c.messages_per_minute,
      sessionsPerHour: c.sessions_per_hour,
      retentionDays: c.retention_days,
      publicKey: c.public_key,
      greeting: c.settings.greeting,
      email: c.settings.email,
      ...(c.kind === 'email' ? { webhooks: { generic: `${base}/api/public/channels/${c.public_key}/email/generic`, mailgun: `${base}/api/public/channels/${c.public_key}/email/mailgun` } } : {}),
      createdBy: c.created_by,
      createdAt: c.created_at,
      updatedAt: c.updated_at
    };
  }

  async list(p: Principal, workspaceId?: string | null) {
    const ws = await this.workspaceIds(p);
    const q = this.db('channels').where({ tenant_id: p.tenantId }).whereNot({ state: 'deleted' }).whereIn('workspace_id', workspaceId ? ws.filter((w) => w === workspaceId) : ws);
    const rows = ((await q.orderBy('name')) as Record<string, unknown>[]).map(channelFrom).filter((c) => clears(p.clearance, c.label));
    return Promise.all(rows.map((c) => this.view(c)));
  }

  /** The checks a channel's binding passes when it is saved: workspace, label, target and vault references. */
  private async checkBinding(ctx: Ctx, c: { workspaceId: string; label: Label; target: { kind: 'profile' | 'agent'; name: string }; email: MailSettings | null; kind: ChannelKind }): Promise<void> {
    const s = this.s();
    const ws = await s.tenants.workspace(ctx.p.tenantId, c.workspaceId);
    if (!ws || !(await this.workspaceIds(ctx.p)).includes(ws.id)) throw notFound('Workspace');
    if (!clears(ctx.p.clearance, c.label)) throw forbidden(`Your clearance is ${ctx.p.clearance}; a ${c.label} channel is above it.`, { step: 'clearance' });
    if (labelRank(c.label) > labelRank(ws.label_ceiling)) throw forbidden(`The workspace's ceiling is ${ws.label_ceiling}; the channel is ${c.label}.`, { step: 'zone' });
    try {
      await resolveTarget(s, { tenantId: ctx.p.tenantId, workspaceId: ws.id, targetKind: c.target.kind, targetName: c.target.name, label: c.label });
    } catch (err) {
      if (err instanceof TargetUnavailable) throw new HttpProblem(422, 'Target unavailable', err.message, { extensions: { step: 'target' } });
      throw err;
    }
    if (c.kind === 'email' && !c.email) throw badRequest('An email channel needs its email settings (at least the address).');
    if (c.kind === 'chat' && c.email) throw badRequest('Email settings belong to email channels.');
    const refs = [c.email?.imap?.passwordRef, c.email?.smtp?.passwordRef, c.email?.mailgunKeyRef].filter((x): x is string => !!x);
    for (const r of refs) if (!isVaultRef(r)) throw badRequest('Mail credentials are vault references (vault:<path>#<key>), never values.');
    if (refs.length) await s.vault.assertRefsReadable(ctx.p, refs, { ip: ctx.ip, traceId: ctx.traceId ?? null });
    for (const host of [c.email?.imap?.host, c.email?.smtp?.host].filter((x): x is string => !!x)) await this.mail.checkHostSyntax(host);
  }

  async create(ctx: Ctx, input: ChannelInput) {
    const p = ctx.p;
    const workspaceId = input.workspaceId ?? p.workspaceId ?? null;
    if (!workspaceId) throw badRequest('Name the workspace the channel belongs to.');
    const email = input.email ?? null;
    await this.checkBinding(ctx, { workspaceId, label: input.label, target: input.target, email, kind: input.kind });
    const id = ulid();
    const t = Date.now();
    const identitySecret = randomToken(32);
    const webhookSecret = input.kind === 'email' ? randomToken(32) : null;
    const refs = !!(email?.imap || email?.smtp || email?.mailgunKeyRef);
    const row = {
      id,
      tenant_id: p.tenantId,
      workspace_id: workspaceId,
      name: input.name,
      kind: input.kind,
      state: 'active',
      label: input.label,
      target_kind: input.target.kind,
      target_name: input.target.name,
      instructions: input.instructions ? await this.seal(p.tenantId, input.instructions, aad.instructions(id)) : null,
      review_mode: input.reviewMode ?? 'escalated',
      allow_anonymous: input.allowAnonymous ?? true,
      messages_per_minute: input.messagesPerMinute ?? 10,
      sessions_per_hour: input.sessionsPerHour ?? 10,
      retention_days: input.retentionDays === undefined ? 30 : input.retentionDays,
      public_key: `chn_${randomToken(18)}`,
      settings: JSON.stringify({ greeting: input.greeting ?? null, email } satisfies ChannelSettings),
      identity_secret: await this.seal(p.tenantId, identitySecret, aad.identity(id)),
      webhook_secret: webhookSecret ? await this.seal(p.tenantId, webhookSecret, aad.webhook(id)) : null,
      vault_owner: refs ? p.userId : null,
      created_by: p.userId,
      created_at: t,
      updated_at: t
    };
    await this.db('channels').insert(row);
    const c = channelFrom(row);
    await this.auditCtx(ctx, 'channel.created', { channel: id, workspace: workspaceId }, { kind: c.kind, label: c.label, target: input.target, reviewMode: c.review_mode, retentionDays: c.retention_days }, c.label);
    // The secrets are shown once: the identity key signs customers' identity assertions, the webhook key signs mail.
    return { ...(await this.view(c)), secrets: { identitySecret, ...(webhookSecret ? { webhookSecret } : {}) } };
  }

  async update(ctx: Ctx, id: string, patch: Partial<Omit<ChannelInput, 'kind' | 'workspaceId'>> & { state?: 'active' | 'paused' }) {
    const c = await this.visible(ctx.p, id);
    const next = {
      label: patch.label ?? c.label,
      target: patch.target ?? { kind: c.target_kind, name: c.target_name },
      email: patch.email !== undefined ? patch.email : c.settings.email
    };
    if (patch.label || patch.target || patch.email !== undefined) await this.checkBinding(ctx, { workspaceId: c.workspace_id, ...next, kind: c.kind });
    const upd: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.name !== undefined) upd.name = patch.name;
    if (patch.state !== undefined) upd.state = patch.state;
    if (patch.label !== undefined) upd.label = patch.label;
    if (patch.target !== undefined) Object.assign(upd, { target_kind: patch.target.kind, target_name: patch.target.name });
    if (patch.instructions !== undefined) upd.instructions = patch.instructions ? await this.seal(c.tenant_id, patch.instructions, aad.instructions(c.id)) : null;
    if (patch.reviewMode !== undefined) upd.review_mode = patch.reviewMode;
    if (patch.allowAnonymous !== undefined) upd.allow_anonymous = patch.allowAnonymous;
    if (patch.messagesPerMinute !== undefined) upd.messages_per_minute = patch.messagesPerMinute;
    if (patch.sessionsPerHour !== undefined) upd.sessions_per_hour = patch.sessionsPerHour;
    if (patch.retentionDays !== undefined) upd.retention_days = patch.retentionDays;
    if (patch.greeting !== undefined || patch.email !== undefined) upd.settings = JSON.stringify({ greeting: patch.greeting !== undefined ? patch.greeting : c.settings.greeting, email: next.email } satisfies ChannelSettings);
    if (patch.email !== undefined && (next.email?.imap || next.email?.smtp || next.email?.mailgunKeyRef)) upd.vault_owner = ctx.p.userId;
    await this.db('channels').where({ id: c.id }).update(upd);
    const after = (await this.row(c.tenant_id, c.id))!;
    // A lower label keeps older sessions at the label they were held at; they are not relabelled.
    const changed = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
    await this.auditCtx(ctx, 'channel.updated', { channel: c.id, workspace: c.workspace_id }, { fields: changed, label: after.label, state: after.state }, after.label);
    return this.view(after);
  }

  async remove(ctx: Ctx, id: string) {
    const c = await this.visible(ctx.p, id);
    const t = Date.now();
    await this.db('channels').where({ id: c.id }).update({ state: 'deleted', updated_at: t });
    const closed = await this.db('channel_sessions').where({ channel_id: c.id }).whereIn('state', ['open', 'escalated']).update({ state: 'closed', closed_at: t, updated_at: t });
    await this.auditCtx(ctx, 'channel.deleted', { channel: c.id, workspace: c.workspace_id }, { sessionsClosed: closed }, c.label);
    return { deleted: true, sessionsClosed: closed };
  }

  /** A new identity or webhook secret, shown once; the old one stops working at once. */
  async rotateSecret(ctx: Ctx, id: string, which: 'identity' | 'webhook') {
    const c = await this.visible(ctx.p, id);
    if (which === 'webhook' && c.kind !== 'email') throw badRequest('Only email channels have a webhook secret.');
    const secret = randomToken(32);
    await this.db('channels').where({ id: c.id }).update(which === 'identity' ? { identity_secret: await this.seal(c.tenant_id, secret, aad.identity(c.id)), updated_at: Date.now() } : { webhook_secret: await this.seal(c.tenant_id, secret, aad.webhook(c.id)), updated_at: Date.now() });
    await this.auditCtx(ctx, 'channel.secret.rotated', { channel: c.id, workspace: c.workspace_id }, { which }, c.label);
    return { [which === 'identity' ? 'identitySecret' : 'webhookSecret']: secret };
  }

  async secret(c: ChannelRow, which: 'identity' | 'webhook'): Promise<string | null> {
    return which === 'identity' ? this.open(c.tenant_id, c.identity_secret, aad.identity(c.id)) : this.open(c.tenant_id, c.webhook_secret, aad.webhook(c.id));
  }

  // ---------- sessions and messages ----------

  async session(tenantId: string, id: string): Promise<SessionRow | null> {
    const r = await this.db('channel_sessions').where({ tenant_id: tenantId, id }).first();
    return r ? sessionFrom(r) : null;
  }

  /** Inserts a message with the session's next sequence number (a compare-and-set, so instances never collide). */
  async addMessage(sess: SessionRow, m: { role: MessageRow['role']; state: MessageRow['state']; via: MessageRow['via']; text: string; authorId?: string | null; original?: string | null; id?: string }): Promise<MessageRow> {
    const id = m.id ?? ulid();
    for (let attempt = 0; ; attempt++) {
      const cur = (await this.db('channel_sessions').where({ id: sess.id }).first('next_seq')) as { next_seq: number } | undefined;
      if (!cur) throw notFound('Session');
      const seq = Number(cur.next_seq);
      const t = Date.now();
      const moved = await this.db('channel_sessions').where({ id: sess.id, next_seq: seq }).update({ next_seq: seq + 1, last_activity_at: t, updated_at: t });
      if (!moved) {
        if (attempt > 20) throw conflict('The session is busy; try again.');
        continue;
      }
      const row = {
        id,
        tenant_id: sess.tenant_id,
        session_id: sess.id,
        channel_id: sess.channel_id,
        seq,
        role: m.role,
        state: m.state,
        via: m.via,
        body: await this.seal(sess.tenant_id, m.text, aad.body(id)),
        original: m.original ? await this.seal(sess.tenant_id, m.original, aad.original(id)) : null,
        label: sess.label,
        flag_id: null,
        author_id: m.authorId ?? null,
        created_at: t,
        delivered_at: m.state === 'delivered' ? t : null
      };
      await this.db('channel_messages').insert(row);
      return messageFrom(row);
    }
  }

  async text(m: MessageRow): Promise<string> {
    return (await this.open(m.tenant_id, m.body, aad.body(m.id))) ?? '';
  }

  async customerOf(sess: SessionRow): Promise<Customer> {
    return json<Customer>(await this.open(sess.tenant_id, sess.customer, aad.customer(sess.id)), { name: null, email: null, externalId: null });
  }

  /** Creates a session (chat or email); the caller audits it. */
  async createSession(c: ChannelRow, input: { kind: SessionRow['customer_kind']; key: string | null; customer: Customer; subject?: string | null }): Promise<SessionRow> {
    const id = ulid();
    const t = Date.now();
    const row = {
      id,
      tenant_id: c.tenant_id,
      channel_id: c.id,
      workspace_id: c.workspace_id,
      label: c.label,
      state: 'open',
      customer_kind: input.kind,
      customer_key: input.key,
      customer: input.customer.name || input.customer.email || input.customer.externalId ? await this.seal(c.tenant_id, JSON.stringify(input.customer), aad.customer(id)) : null,
      subject: input.subject ? await this.seal(c.tenant_id, input.subject, aad.subject(id)) : null,
      next_seq: 1,
      escalated_at: null,
      escalation: null,
      last_activity_at: t,
      closed_at: null,
      created_at: t,
      updated_at: t
    };
    await this.db('channel_sessions').insert(row);
    const sess = sessionFrom(row);
    this.event(c.tenant_id, 'channel.session.started', c.label, { channel: c.id, session: id, workspace: c.workspace_id, customer: input.kind });
    this.changed(c.tenant_id, { channel: c.id, session: id, change: 'started' });
    return sess;
  }

  // ---------- customers (public endpoints) ----------

  private tokenFor(sess: SessionRow): { token: string; expiresAt: number } {
    const exp = Date.now() + this.s().cfg.CHANNELS_SESSION_HOURS * 3_600_000;
    return { token: signSession(this.tokenKey, { tenantId: sess.tenant_id, channelId: sess.channel_id, sessionId: sess.id, exp }), expiresAt: exp };
  }

  /**
   * Starts a customer session on a chat channel (or resumes an identified customer's open one). Rate-limited per
   * address across channels (CHANNELS_SESSIONS_PER_HOUR) and per channel (its own `sessionsPerHour`).
   */
  async startCustomer(key: string, input: { identity?: string; name?: string }, ip: string | null, traceId?: string | null) {
    const c = await this.byKey(key);
    // An unknown, paused or email channel answers like a missing one.
    if (!c || c.state !== 'active' || c.kind !== 'chat') throw notFound('Channel');
    const addr = ip ?? 'unknown';
    const global = await this.sessionLimiter.consume(addr);
    if (!global.allowed) throw tooManyRequests('Too many new sessions from this address; try again later.', global.resetMs / 1000);
    const per = await this.s().counters.hit(`channel-sessions:${c.id}:${addr}`, 3_600_000);
    if (per.count > c.sessions_per_hour) throw tooManyRequests('Too many new sessions from this address; try again later.', per.resetMs / 1000);
    let kind: SessionRow['customer_kind'] = 'anonymous';
    let customer: Customer = { name: input.name?.trim().slice(0, 200) || null, email: null, externalId: null };
    let ckey: string | null = null;
    if (input.identity) {
      const secret = await this.secret(c, 'identity');
      try {
        const id = verifyIdentity(secret ?? '', input.identity);
        kind = 'identified';
        customer = { name: id.name ?? customer.name, email: id.email, externalId: id.sub };
        ckey = this.customerKeyFor(c.tenant_id, 'id', id.sub);
      } catch (err) {
        throw new HttpProblem(401, 'Identity not accepted', (err as Error).message);
      }
    } else if (!c.allow_anonymous) {
      throw new HttpProblem(401, 'Identity required', 'This channel answers signed-in customers only: send the identity assertion from the site.');
    }
    // An identified customer comes back to their open session.
    let sess: SessionRow | null = null;
    if (ckey) {
      const r = await this.db('channel_sessions').where({ channel_id: c.id, customer_key: ckey }).whereIn('state', ['open', 'escalated']).orderBy('last_activity_at', 'desc').first();
      sess = r ? sessionFrom(r) : null;
    }
    let resumed = !!sess;
    if (!sess) {
      sess = await this.createSession(c, { kind, key: ckey, customer });
      if (c.settings.greeting) await this.addMessage(sess, { role: 'notice', state: 'delivered', via: 'web', text: c.settings.greeting });
      await this.audit({ ip, via: 'channel' }, c.tenant_id, 'channel.session.started', { channel: c.id, session: sess.id, workspace: c.workspace_id }, { customer: kind }, c.label, traceId, 'system');
    } else {
      resumed = true;
    }
    const tok = this.tokenFor(sess);
    return { ...tok, resumed, ...(await this.customerView(c, sess, 0)) };
  }

  /** The session a customer token names, while the token, the session and the channel are all live. */
  async customerAuth(token: string | undefined): Promise<{ c: ChannelRow; sess: SessionRow }> {
    const claims = token ? verifySession(this.tokenKey, token) : null;
    const refuse = () => unauthorized('The session token is missing, expired or no longer valid. Start a new session.');
    if (!claims) throw refuse();
    const sess = await this.session(claims.tenantId, claims.sessionId);
    if (!sess || sess.channel_id !== claims.channelId || sess.state === 'closed' || sess.state === 'hidden') throw refuse();
    const c = await this.row(claims.tenantId, claims.channelId);
    if (!c || c.state !== 'active') throw refuse();
    return { c, sess };
  }

  /** What the customer sees: their messages and delivered answers; a held answer shows as pending, without text. */
  async customerView(c: ChannelRow, sess: SessionRow, after: number) {
    const rows = ((await this.db('channel_messages').where({ session_id: sess.id }).andWhere('seq', '>', after).whereNot({ state: 'hidden' }).orderBy('seq').limit(500)) as Record<string, unknown>[]).map(messageFrom);
    const messages = [];
    for (const m of rows) {
      if (m.state === 'rejected') continue;
      messages.push({ seq: m.seq, role: m.role, state: m.state === 'held' ? ('pending' as const) : ('delivered' as const), text: m.state === 'held' ? null : await this.text(m), at: m.delivered_at ?? m.created_at });
    }
    return { session: { id: sess.id, channel: c.name, state: sess.state === 'escalated' ? 'escalated' : 'open', label: sess.label, escalated: sess.state === 'escalated' }, messages };
  }

  /** A customer's message and the answer to it (delivered, or pending review). */
  async customerSend(token: string | undefined, text: string, ip: string | null, traceId?: string | null) {
    const { c, sess } = await this.customerAuth(token);
    const l = await this.s().counters.hit(`channel-messages:${sess.id}`, 60_000);
    if (l.count > c.messages_per_minute) throw tooManyRequests('Too many messages in this session; wait a moment.', l.resetMs / 1000);
    const { customer, reply } = await this.receive(c, sess, text, 'web', { ip, traceId: traceId ?? null });
    const latest = (await this.session(sess.tenant_id, sess.id)) ?? sess;
    return { message: { seq: customer.seq }, reply: reply ? { seq: reply.seq, role: reply.role, state: reply.state === 'held' ? 'pending' : 'delivered', text: reply.state === 'held' ? null : await this.text(reply) } : null, session: { state: latest.state, escalated: latest.state === 'escalated' } };
  }

  async customerEscalate(token: string | undefined, reason: string | null, ip: string | null, traceId?: string | null) {
    const { c, sess } = await this.customerAuth(token);
    await this.escalate(c, sess, reason ? `Customer: ${reason}` : 'The customer asked for a person', { ip, via: 'channel' }, traceId);
    return { escalated: true };
  }

  async customerClose(token: string | undefined, ip: string | null, traceId?: string | null) {
    const { c, sess } = await this.customerAuth(token);
    await this.close(c, sess, { ip, via: 'channel' }, 'customer', traceId);
    return { closed: true };
  }

  /** Marks a session escalated (once) and tells the channel's reviewers. */
  async escalate(c: ChannelRow, sess: SessionRow, reason: string, actor: AuditActor, traceId?: string | null): Promise<void> {
    const t = Date.now();
    const n = await this.db('channel_sessions').where({ id: sess.id, state: 'open' }).update({ state: 'escalated', escalated_at: t, escalation: reason.slice(0, 500), updated_at: t });
    if (!n) return;
    await this.audit(actor, c.tenant_id, 'channel.session.escalated', { channel: c.id, session: sess.id, workspace: c.workspace_id }, { reason: reason.slice(0, 200) }, c.label, traceId, 'system');
    this.event(c.tenant_id, 'channel.session.escalated', c.label, { channel: c.id, session: sess.id, workspace: c.workspace_id, reason: reason.slice(0, 200) });
    this.changed(c.tenant_id, { channel: c.id, session: sess.id, change: 'escalated' });
    const reviewers = await this.reviewersOf(c);
    if (reviewers.length) await this.s().notifications.notify({ tenantId: c.tenant_id, userIds: reviewers, kind: 'channel', title: `A session in ${c.name} was escalated`, body: reason.slice(0, 200), route: `channels?id=${c.id}&session=${sess.id}`, label: c.label });
  }

  async close(c: ChannelRow, sess: SessionRow, actor: AuditActor, by: string, traceId?: string | null): Promise<void> {
    const t = Date.now();
    const n = await this.db('channel_sessions').where({ id: sess.id }).whereIn('state', ['open', 'escalated']).update({ state: 'closed', closed_at: t, updated_at: t });
    if (!n) return;
    await this.audit(actor, c.tenant_id, 'channel.session.closed', { channel: c.id, session: sess.id, workspace: c.workspace_id }, { by }, c.label, traceId, actor.user ? 'admin' : 'system');
    this.event(c.tenant_id, 'channel.session.closed', c.label, { channel: c.id, session: sess.id, workspace: c.workspace_id });
    this.changed(c.tenant_id, { channel: c.id, session: sess.id, change: 'closed' });
  }

  /** Active users holding `channels:review` who may act in the channel's workspace and are cleared for its label. */
  private async reviewersOf(c: ChannelRow): Promise<string[]> {
    const db = this.db;
    const rows = (await db('users as u')
      .join('user_roles as r', 'r.user_id', 'u.id')
      .where({ 'u.tenant_id': c.tenant_id, 'u.state': 'active' })
      .whereIn('r.role', REVIEWER_ROLES)
      .distinct('u.id', 'u.clearance')) as { id: string; clearance: string }[];
    const ws = await this.s().tenants.workspace(c.tenant_id, c.workspace_id);
    const members = ws?.visibility === 'tenant' ? null : new Set(((await db('workspace_members').where({ workspace_id: c.workspace_id }).select('user_id')) as { user_id: string }[]).map((r) => r.user_id));
    const admins = new Set(((await db('user_roles').whereIn('user_id', rows.map((r) => r.id)).whereIn('role', ['tenant-admin', 'system-admin']).select('user_id')) as { user_id: string }[]).map((r) => r.user_id));
    return rows.filter((u) => isLabel(u.clearance) && clears(u.clearance, c.label) && (!members || members.has(u.id) || admins.has(u.id))).map((u) => u.id);
  }

  // ---------- answering ----------

  /**
   * Takes a customer message (chat or email) into the session, then answers it: the message passes `user-input`
   * (a block refuses it; a hold escalates the session), the answer passes `model-output`, and the answer is delivered
   * or held for review. Email answers are not generated here but by a job (`queueReply`).
   */
  async receive(c: ChannelRow, sess: SessionRow, raw: string, via: 'web' | 'email', ctx: { ip: string | null; traceId: string | null; deferReply?: boolean; messageId?: string }): Promise<{ customer: MessageRow; reply: MessageRow | null }> {
    const s = this.s();
    const msgId = ctx.messageId ?? ulid();
    const text = raw.trim().slice(0, MAX_MESSAGE);
    if (!text) throw badRequest('The message is empty.');
    let d: GuardDecision;
    try {
      d = await s.guardrails.check({ tenantId: c.tenant_id, workspaceId: c.workspace_id, checkpoint: 'user-input', text, label: sess.label, source: { kind: MESSAGE_OBJECT, id: msgId }, meta: { via: `channel-${via}`, channel: c.id, tokens: Math.ceil(text.length / 4) } });
    } catch (err) {
      s.log.error({ err, channel: c.id }, 'channel user-input guardrail failed');
      d = { action: 'block', text, findings: [], reason: 'The message could not be checked; try again later.' };
    }
    const reviewable = d.action === 'require-approval' && d.findings.some((f) => f.stage === 'enforce' && f.action === 'require-approval' && !f.detail?.startsWith('unavailable:'));
    if (d.action === 'block' || (d.action === 'require-approval' && !reviewable)) {
      await this.audit({ ip: ctx.ip, via: `channel-${via}` }, c.tenant_id, 'channel.message.refused', { channel: c.id, session: sess.id, workspace: c.workspace_id }, { checkpoint: 'user-input', action: d.action, rules: d.findings.filter((f) => f.stage === 'enforce').map((f) => f.ruleName).slice(0, 5) }, sess.label, ctx.traceId, 'system');
      throw new HttpProblem(422, 'Message refused', d.reason ?? 'This message cannot be accepted here.', { extensions: { step: 'guardrail', action: d.action } });
    }
    const customer = await this.addMessage(sess, { id: msgId, role: 'customer', state: 'delivered', via, text: d.text });
    this.event(c.tenant_id, 'channel.message.received', sess.label, { channel: c.id, session: sess.id, workspace: c.workspace_id, message: customer.id, via });
    this.changed(c.tenant_id, { channel: c.id, session: sess.id, change: 'message' });
    if (reviewable) await this.escalate(c, sess, `A guardrail asked for review: ${d.reason ?? d.findings.find((f) => f.action === 'require-approval')?.ruleName ?? 'held'}`, { service: 'guardrails' }, ctx.traceId);
    if (ctx.deferReply) return { customer, reply: null };
    const reply = await this.answer(c, (await this.session(sess.tenant_id, sess.id)) ?? sess, customer, ctx.traceId);
    return { customer, reply };
  }

  /** Queues the answer to an email message (the poll and the webhook return before the model is asked). */
  async queueReply(sess: SessionRow, messageId: string): Promise<void> {
    await this.s().jobs.enqueue({ tenantId: sess.tenant_id, type: 'channels.reply', payload: { tenantId: sess.tenant_id, sessionId: sess.id, messageId }, dedupeKey: `channels.reply:${messageId}`, maxAttempts: 1 });
  }

  private async replyJob(tenantId: string, sessionId: string, messageId: string) {
    const sess = await this.session(tenantId, sessionId);
    if (!sess || sess.state === 'hidden') return { skipped: 'session gone' };
    const c = await this.row(tenantId, sess.channel_id);
    if (!c || c.state !== 'active') return { skipped: 'channel inactive' };
    const m = await this.db('channel_messages').where({ id: messageId, session_id: sess.id }).first();
    if (!m) return { skipped: 'message gone' };
    // Answered already (a retry, or a newer message answered both)?
    const later = await this.db('channel_messages').where({ session_id: sess.id }).andWhere('seq', '>', Number(m.seq)).whereIn('role', ['assistant', 'agent']).first('id');
    if (later) return { skipped: 'already answered' };
    const reply = await this.answer(c, sess, messageFrom(m), null);
    return { reply: reply.id, state: reply.state };
  }

  /** The history a reply sees: delivered messages, oldest first (held, rejected and hidden ones are left out). */
  private async history(sess: SessionRow): Promise<ChatMessage[]> {
    const rows = ((await this.db('channel_messages').where({ session_id: sess.id, state: 'delivered' }).orderBy('seq', 'desc').limit(HISTORY)) as Record<string, unknown>[]).map(messageFrom).reverse();
    const out: ChatMessage[] = [];
    for (const m of rows) {
      if (m.role === 'notice') continue;
      out.push({ role: m.role === 'customer' ? 'user' : 'assistant', content: await this.text(m) });
    }
    return out;
  }

  /** Generates, screens and stores the answer to a customer message; delivers it or holds it for review. */
  async answer(c: ChannelRow, sess: SessionRow, customer: MessageRow, traceId: string | null): Promise<MessageRow> {
    const s = this.s();
    const instructions = await this.open(c.tenant_id, c.instructions, aad.instructions(c.id));
    const actor: AuditActor = { service: 'channel', via: c.id };
    let text: string;
    let meta: Record<string, unknown>;
    try {
      const target = await resolveTarget(s, { tenantId: c.tenant_id, workspaceId: c.workspace_id, targetKind: c.target_kind, targetName: c.target_name, label: sess.label });
      const out = await generateReply(s, { tenantId: c.tenant_id, workspaceId: c.workspace_id, label: sess.label, target, system: [BASE_SYSTEM, instructions].filter(Boolean).join('\n\n'), history: await this.history(sess), timeoutMs: s.cfg.CHANNELS_REPLY_TIMEOUT_MS });
      text = out.text;
      meta = { profile: out.profile, model: out.model, ...(target.agent ? { agent: target.agent.name } : {}) };
    } catch (err) {
      // Fails soft: the customer is told a person will follow up, and the session goes to the reviewers.
      const reason = err instanceof TargetUnavailable ? err.message : err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message;
      s.log.warn({ err: reason, channel: c.id, session: sess.id }, 'channel answer failed');
      await this.audit(actor, c.tenant_id, 'channel.reply.failed', { channel: c.id, session: sess.id, workspace: c.workspace_id }, { error: String(reason).slice(0, 300) }, sess.label, traceId, 'system');
      const notice = await this.addMessage(sess, { role: 'notice', state: 'delivered', via: customer.via === 'email' ? 'email' : 'web', text: 'We could not answer automatically just now. A person from the team will follow up.' });
      await this.escalate(c, sess, 'The model could not answer', actor, traceId);
      if (customer.via === 'email') await this.mail.queueOutbound(c, sess, notice, true);
      return notice;
    }
    const replyId = ulid();
    let d: GuardDecision;
    try {
      d = await s.guardrails.check({ tenantId: c.tenant_id, workspaceId: c.workspace_id, checkpoint: 'model-output', text, label: sess.label, source: { kind: MESSAGE_OBJECT, id: replyId }, meta: { ...meta, via: 'channel', channel: c.id } });
    } catch (err) {
      s.log.error({ err, channel: c.id }, 'channel model-output guardrail failed');
      d = { action: 'require-approval', text, findings: [], reason: 'The answer could not be checked, so it waits for a reviewer.' };
    }
    if (d.action === 'block') {
      await this.audit(actor, c.tenant_id, 'channel.reply.blocked', { channel: c.id, session: sess.id, workspace: c.workspace_id }, { rules: d.findings.filter((f) => f.stage === 'enforce').map((f) => f.ruleName).slice(0, 5) }, sess.label, traceId, 'system');
      const notice = await this.addMessage(sess, { role: 'notice', state: 'delivered', via: customer.via === 'email' ? 'email' : 'web', text: 'We cannot answer that here. A person from the team will follow up.' });
      await this.escalate(c, sess, 'A guardrail blocked the answer', actor, traceId);
      if (customer.via === 'email') await this.mail.queueOutbound(c, sess, notice, true);
      return notice;
    }
    if (!text) text = 'Thank you. A person from the team will follow up.';
    const guardHold = d.action === 'require-approval';
    const current = (await this.session(sess.tenant_id, sess.id)) ?? sess;
    const hold = guardHold || c.review_mode === 'always' || (c.review_mode === 'escalated' && current.state === 'escalated');
    const body = d.action === 'redact' ? d.text : text;
    const reply = await this.addMessage(current, { id: replyId, role: 'assistant', state: hold ? 'held' : 'delivered', via: customer.via === 'email' ? 'email' : 'web', text: body });
    if (hold) {
      const f = d.findings.find((x) => x.stage === 'enforce' && x.action === 'require-approval');
      const why = guardHold ? (d.reason ?? 'A guardrail held this answer for review.') : c.review_mode === 'always' ? 'This channel reviews every answer before the customer sees it.' : `The session is escalated: ${current.escalation ?? 'a person was asked for'}.`;
      const flag = await s.guard.flags.create({
        tenantId: c.tenant_id,
        workspaceId: c.workspace_id,
        kind: 'hold',
        checkpoint: guardHold ? 'model-output' : 'channel-review',
        ruleId: f?.ruleId ?? null,
        ruleName: f?.ruleName ?? (c.review_mode === 'always' ? `Channel ${c.name}: every answer` : `Channel ${c.name}: escalated session`),
        setId: f?.setId ?? null,
        stage: 'enforce',
        action: 'require-approval',
        severity: 'medium',
        label: sess.label,
        text: body,
        span: f?.span ?? null,
        note: why,
        actor: { user: null, name: `Customer session in ${c.name}`, via: 'channel' },
        source: { kind: HELD_SOURCE, id: reply.id }
      });
      await this.db('channel_messages').where({ id: reply.id }).update({ flag_id: flag.id });
      reply.flag_id = flag.id;
      await this.audit(actor, c.tenant_id, 'channel.reply.held', { channel: c.id, session: sess.id, workspace: c.workspace_id, message: reply.id, flag: flagRef(flag) }, { reason: why.slice(0, 200), ...meta }, sess.label, traceId, 'system');
      this.event(c.tenant_id, 'channel.reply.held', sess.label, { channel: c.id, session: sess.id, workspace: c.workspace_id, message: reply.id, flag: flagRef(flag) });
      this.changed(c.tenant_id, { channel: c.id, session: sess.id, change: 'held' });
      return reply;
    }
    await this.delivered(c, current, reply, false, actor, traceId, meta);
    return reply;
  }

  /** After a reply reaches the customer: the event, the audit entry and, for email, the outbox. */
  private async delivered(c: ChannelRow, sess: SessionRow, reply: MessageRow, edited: boolean, actor: AuditActor, traceId: string | null | undefined, meta: Record<string, unknown> = {}): Promise<void> {
    await this.audit(actor, c.tenant_id, 'channel.reply.sent', { channel: c.id, session: sess.id, workspace: c.workspace_id, message: reply.id }, { edited, role: reply.role, ...meta }, sess.label, traceId, actor.user ? 'admin' : 'system');
    this.event(c.tenant_id, 'channel.reply.sent', sess.label, { channel: c.id, session: sess.id, workspace: c.workspace_id, message: reply.id, edited });
    this.changed(c.tenant_id, { channel: c.id, session: sess.id, change: 'reply' });
    if (sess.customer_kind === 'email') await this.mail.queueOutbound(c, sess, reply, reply.role === 'assistant');
  }

  // ---------- reviewers (channels:review) ----------

  private async sessionFor(p: Principal, channelId: string, sessionId: string): Promise<{ c: ChannelRow; sess: SessionRow }> {
    const c = await this.visible(p, channelId);
    const sess = await this.session(p.tenantId, sessionId);
    if (!sess || sess.channel_id !== c.id || !clears(p.clearance, sess.label)) throw notFound('Session');
    return { c, sess };
  }

  private async sessionSummary(sess: SessionRow) {
    const customer = await this.customerOf(sess);
    return {
      id: sess.id,
      channelId: sess.channel_id,
      state: sess.state,
      label: sess.label,
      customer: { kind: sess.customer_kind, ...customer },
      subject: await this.open(sess.tenant_id, sess.subject, aad.subject(sess.id)),
      escalatedAt: sess.escalated_at,
      escalation: sess.escalation,
      messages: sess.next_seq - 1,
      lastActivityAt: sess.last_activity_at,
      closedAt: sess.closed_at,
      createdAt: sess.created_at
    };
  }

  async sessions(p: Principal, channelId: string, q: { state?: SessionState; before?: number; limit?: number }) {
    const c = await this.visible(p, channelId);
    const query = this.db('channel_sessions').where({ tenant_id: p.tenantId, channel_id: c.id });
    if (q.state) query.andWhere({ state: q.state });
    if (q.before) query.andWhere('last_activity_at', '<', q.before);
    const rows = ((await query.orderBy('last_activity_at', 'desc').limit(q.limit ?? 50)) as Record<string, unknown>[]).map(sessionFrom).filter((x) => clears(p.clearance, x.label));
    return Promise.all(rows.map((x) => this.sessionSummary(x)));
  }

  private async messageView(m: MessageRow, flags: Map<string, FlagRow>) {
    const f = m.flag_id ? flags.get(m.flag_id) : undefined;
    return {
      id: m.id,
      seq: m.seq,
      role: m.role,
      state: m.state,
      via: m.via,
      text: await this.text(m),
      original: await this.open(m.tenant_id, m.original, aad.original(m.id)),
      flag: f ? { id: f.id, ref: flagRef(f), state: f.state } : null,
      authorId: m.author_id,
      createdAt: m.created_at,
      deliveredAt: m.delivered_at
    };
  }

  private async flagsFor(rows: MessageRow[]): Promise<Map<string, FlagRow>> {
    const ids = rows.map((m) => m.flag_id).filter((x): x is string => !!x);
    if (!ids.length) return new Map();
    const list = (await this.db('guard_flags').whereIn('id', ids).select('id', 'number', 'state')) as FlagRow[];
    return new Map(list.map((f) => [f.id, { ...f, number: Number(f.number) }]));
  }

  async transcript(p: Principal, channelId: string, sessionId: string) {
    const { sess } = await this.sessionFor(p, channelId, sessionId);
    const rows = ((await this.db('channel_messages').where({ session_id: sess.id }).orderBy('seq')) as Record<string, unknown>[]).map(messageFrom);
    const flags = await this.flagsFor(rows);
    const outbox = (await this.db('channel_outbox').where({ session_id: sess.id }).orderBy('created_at').select('id', 'message_id', 'state', 'attempts', 'last_error', 'sent_at', 'bounced_at')) as Record<string, unknown>[];
    return {
      ...(await this.sessionSummary(sess)),
      transcript: await Promise.all(rows.map((m) => this.messageView(m, flags))),
      outbox: outbox.map((o) => ({ id: o.id, messageId: o.message_id, state: o.state, attempts: Number(o.attempts), error: o.last_error ?? null, sentAt: numOrNull(o.sent_at), bouncedAt: numOrNull(o.bounced_at) }))
    };
  }

  /** A person answers in the session (delivered at once; by email for email sessions). */
  async agentReply(ctx: Ctx, channelId: string, sessionId: string, text: string) {
    const { c, sess } = await this.sessionFor(ctx.p, channelId, sessionId);
    if (sess.state === 'closed' || sess.state === 'hidden') throw conflict(`The session is ${sess.state}.`);
    const m = await this.addMessage(sess, { role: 'agent', state: 'delivered', via: 'reviewer', text: text.trim().slice(0, MAX_MESSAGE), authorId: ctx.p.userId });
    await this.delivered(c, sess, m, false, actorFrom(ctx.p, ctx.ip), ctx.traceId);
    return { id: m.id, seq: m.seq };
  }

  async closeByReviewer(ctx: Ctx, channelId: string, sessionId: string) {
    const { c, sess } = await this.sessionFor(ctx.p, channelId, sessionId);
    await this.close(c, sess, actorFrom(ctx.p, ctx.ip), 'reviewer', ctx.traceId);
    return { closed: true };
  }

  /** Held replies in the caller's workspaces and clearance, oldest first. */
  async heldQueue(p: Principal) {
    const ws = await this.workspaceIds(p);
    const rows = (await this.db('channel_messages as m')
      .join('channel_sessions as s', 's.id', 'm.session_id')
      .join('channels as c', 'c.id', 'm.channel_id')
      .where({ 'm.tenant_id': p.tenantId, 'm.state': 'held' })
      .whereIn('s.workspace_id', ws.length ? ws : ['-'])
      .orderBy('m.created_at')
      .limit(500)
      .select('m.*', 'c.name as channel_name')) as (Record<string, unknown> & { channel_name: string })[];
    const msgs = rows.map((r) => ({ m: messageFrom(r), channelName: r.channel_name })).filter((x) => clears(p.clearance, x.m.label));
    const flags = await this.flagsFor(msgs.map((x) => x.m));
    return Promise.all(msgs.map(async (x) => ({ ...(await this.messageView(x.m, flags)), channelId: x.m.channel_id, channelName: x.channelName, sessionId: x.m.session_id })));
  }

  /**
   * A reviewer's decision on a held reply (B-2302): `approve` delivers it as written, `edit` delivers the reviewer's
   * text (the model's is kept as the original), `reject` withdraws it and tells the customer a person will follow up.
   * The flag records the decision through the flag queue's own path.
   */
  async decideHeld(ctx: Ctx, messageId: string, input: { decision: 'approve' | 'edit' | 'reject'; text?: string; reason?: string | null }) {
    const p = ctx.p;
    const m = await this.heldMessage(p, messageId);
    if (input.decision === 'edit' && !input.text?.trim()) throw badRequest('An edit needs the text the customer should receive.');
    if (!m.flag_id) throw conflict('This reply has no flag to decide.');
    const flagRow = (await this.db('guard_flags').where({ id: m.flag_id }).first('number')) as { number: number } | undefined;
    if (!flagRow) throw conflict('The reply\'s flag is gone.');
    const ws = await this.workspaceIds(p);
    const decision = input.decision === 'reject' ? 'rejected' : 'approved';
    let out: Awaited<ReturnType<ChannelService['resolveHeld']>> | null = null;
    const f = await this.s().guard.flags.decideHold(p, `F-${flagRow.number}`, ws, decision, input.reason ?? null, async () => {
      out = await this.resolveHeld(ctx, messageId, decision, input.decision === 'edit' ? input.text!.trim().slice(0, MAX_MESSAGE) : undefined);
    });
    const res = out as Awaited<ReturnType<ChannelService['resolveHeld']>> | null;
    return { message: res?.message ?? null, state: res?.state ?? null, edited: input.decision === 'edit', flag: { id: f.id, ref: flagRef(f), state: f.state } };
  }

  private async heldMessage(p: Principal, messageId: string): Promise<MessageRow> {
    const r = await this.db('channel_messages').where({ tenant_id: p.tenantId, id: messageId }).first();
    if (!r) throw notFound('Reply');
    const m = messageFrom(r);
    const sess = await this.session(p.tenantId, m.session_id);
    if (!sess || !(await this.workspaceIds(p)).includes(sess.workspace_id) || !clears(p.clearance, m.label)) throw notFound('Reply');
    if (m.state !== 'held') throw conflict(`The reply was already ${m.state}.`);
    return m;
  }

  /**
   * Applies a decision to a held reply (also called from the flag queue's decide route for `channel-message` flags):
   * compare-and-set on `held`, so only one decision lands.
   */
  async resolveHeld(ctx: Ctx | Principal, messageId: string, decision: 'approved' | 'rejected', edited?: string): Promise<{ message: string; state: MessageRow['state'] }> {
    const c0: Ctx = 'p' in ctx ? ctx : { p: ctx, ip: null };
    const p = c0.p;
    if (!effectivePermissions(p).has('channels:review') && !effectivePermissions(p).has('flags:review')) throw forbidden('Deciding a held customer reply needs channels:review.', { step: 'role' });
    const m = await this.heldMessage(p, messageId);
    const sess = (await this.session(p.tenantId, m.session_id))!;
    const c = await this.db('channels').where({ id: m.channel_id }).first().then((r: Record<string, unknown> | undefined) => (r ? channelFrom(r) : null));
    if (!c) throw notFound('Channel');
    const t = Date.now();
    const actor = actorFrom(p, c0.ip);
    if (decision === 'rejected') {
      const n = await this.db('channel_messages').where({ id: m.id, state: 'held' }).update({ state: 'rejected' });
      if (!n) throw conflict('The reply was decided meanwhile.');
      await this.audit(actor, c.tenant_id, 'channel.reply.rejected', { channel: c.id, session: sess.id, workspace: c.workspace_id, message: m.id }, {}, sess.label, c0.traceId, 'admin');
      this.event(c.tenant_id, 'channel.reply.rejected', sess.label, { channel: c.id, session: sess.id, workspace: c.workspace_id, message: m.id });
      if (sess.state !== 'closed' && sess.state !== 'hidden') {
        const notice = await this.addMessage(sess, { role: 'notice', state: 'delivered', via: m.via, text: 'A person from the team will follow up on this.' });
        if (sess.customer_kind === 'email') await this.mail.queueOutbound(c, sess, notice, true);
      }
      this.changed(c.tenant_id, { channel: c.id, session: sess.id, change: 'rejected' });
      return { message: m.id, state: 'rejected' };
    }
    const patch: Record<string, unknown> = { state: 'delivered', delivered_at: t };
    if (edited !== undefined) {
      patch.original = await this.seal(m.tenant_id, await this.text(m), aad.original(m.id));
      patch.body = await this.seal(m.tenant_id, edited, aad.body(m.id));
      patch.author_id = p.userId;
    }
    const n = await this.db('channel_messages').where({ id: m.id, state: 'held' }).update(patch);
    if (!n) throw conflict('The reply was decided meanwhile.');
    if (edited !== undefined) await this.audit(actor, c.tenant_id, 'channel.reply.edited', { channel: c.id, session: sess.id, workspace: c.workspace_id, message: m.id }, { length: edited.length }, sess.label, c0.traceId, 'admin');
    const after = { ...m, ...(patch as Partial<MessageRow>), state: 'delivered' as const, delivered_at: t };
    await this.delivered(c, sess, after, edited !== undefined, actor, c0.traceId);
    return { message: m.id, state: 'delivered' };
  }

  /** The held reply's text for the flag queue's detail view. */
  async heldText(tenantId: string, messageId: string): Promise<{ conversationId: string; state: string; content: string } | null> {
    const r = await this.db('channel_messages').where({ tenant_id: tenantId, id: messageId }).first();
    if (!r) return null;
    const m = messageFrom(r);
    return { conversationId: m.session_id, state: m.state, content: await this.text(m) };
  }

  // ---------- transcripts as CSV (B-2304) ----------

  static readonly CSV_HEADER = ['channel', 'session', 'seq', 'time', 'role', 'state', 'via', 'label', 'text', 'original'];

  private async csvRows(sess: SessionRow, channelName: string): Promise<string> {
    const rows = ((await this.db('channel_messages').where({ session_id: sess.id }).orderBy('seq')) as Record<string, unknown>[]).map(messageFrom);
    let out = '';
    for (const m of rows) out += csvLine([channelName, sess.id, m.seq, new Date(m.created_at).toISOString(), m.role, m.state, m.via, m.label, await this.text(m), (await this.open(m.tenant_id, m.original, aad.original(m.id))) ?? '']);
    return out;
  }

  async transcriptCsv(ctx: Ctx, channelId: string, sessionId: string): Promise<{ name: string; body: string }> {
    const { c, sess } = await this.sessionFor(ctx.p, channelId, sessionId);
    const body = csvLine(ChannelService.CSV_HEADER) + (await this.csvRows(sess, c.name));
    await this.auditCtx(ctx, 'channel.transcript.exported', { channel: c.id, session: sess.id, workspace: c.workspace_id }, { sessions: 1 }, sess.label);
    return { name: `transcript-${sess.id}.csv`, body };
  }

  /** Every session of a channel in a time range, as one CSV built by a job and sealed in the blob store. */
  async startExport(ctx: Ctx, channelId: string, range: { from?: number; to?: number }) {
    const c = await this.visible(ctx.p, channelId);
    const job = await this.s().jobs.enqueue({ tenantId: ctx.p.tenantId, type: 'channels.export', payload: { channelId: c.id, from: range.from ?? 0, to: range.to ?? Date.now(), clearance: ctx.p.clearance }, createdBy: ctx.p.userId, maxAttempts: 2 });
    await this.auditCtx(ctx, 'channel.transcript.export_started', { channel: c.id, workspace: c.workspace_id, job: job.id }, { from: range.from ?? null, to: range.to ?? null }, c.label);
    return { jobId: job.id, state: job.state };
  }

  private exportKey(tenantId: string, jobId: string): string {
    return `channels/${tenantId}/exports/${jobId}.csv.sealed`;
  }

  private async exportJob(tenantId: string, jobId: string, payload: Record<string, unknown>, progress: (pct: number, m?: string) => Promise<void>) {
    const c = await this.row(tenantId, String(payload.channelId));
    if (!c) return { sessions: 0 };
    const clearance = isLabel(payload.clearance) ? payload.clearance : 'public';
    const sessions = ((await this.db('channel_sessions').where({ tenant_id: tenantId, channel_id: c.id }).andWhere('created_at', '>=', Number(payload.from ?? 0)).andWhere('created_at', '<=', Number(payload.to ?? Date.now())).orderBy('created_at').limit(10_000)) as Record<string, unknown>[]).map(sessionFrom).filter((x) => clears(clearance, x.label));
    let body = csvLine(ChannelService.CSV_HEADER);
    for (const [i, sess] of sessions.entries()) {
      body += await this.csvRows(sess, c.name);
      if (i % 50 === 0) await progress(Math.round((i / Math.max(1, sessions.length)) * 100), `${i} of ${sessions.length} sessions`);
    }
    const sealed = await this.s().keys.sealBytes(tenantId, Buffer.from(body, 'utf8'), `channel-export:${jobId}`);
    await this.s().blobs.put(this.exportKey(tenantId, jobId), Buffer.from(sealed, 'utf8'));
    return { sessions: sessions.length, bytes: Buffer.byteLength(body) };
  }

  async exportDownload(ctx: Ctx, jobId: string): Promise<{ name: string; body: Buffer }> {
    const job = await this.s().jobs.get(ctx.p.tenantId, jobId);
    if (!job || job.type !== 'channels.export' || job.created_by !== ctx.p.userId) throw notFound('Export');
    if (job.state !== 'succeeded') throw conflict(`The export is ${job.state}.`);
    const c = await this.visible(ctx.p, String(job.payload.channelId));
    const raw = await this.s().blobs.get(this.exportKey(ctx.p.tenantId, jobId));
    if (!raw) throw notFound('Export');
    const body = await this.s().keys.openBytes(ctx.p.tenantId, raw.toString('utf8'), `channel-export:${jobId}`);
    await this.auditCtx(ctx, 'channel.transcript.exported', { channel: c.id, workspace: c.workspace_id, job: jobId }, { sessions: (job.result as { sessions?: number } | null)?.sessions ?? null }, c.label);
    return { name: `channel-${c.id}-${jobId}.csv`, body };
  }

  // ---------- retention (B-2304) ----------

  /**
   * Deletes sessions whose last activity is older than their channel's retention period, with their messages,
   * threads and outbox rows (cascade). Open review flags for their held replies are closed as rejected: there is
   * nothing left to release.
   */
  async purgeExpired(tenantId: string): Promise<{ channels: number; sessions: number }> {
    const channels = ((await this.db('channels').where({ tenant_id: tenantId }).whereNotNull('retention_days')) as Record<string, unknown>[]).map(channelFrom);
    let total = 0;
    let touched = 0;
    for (const c of channels) {
      const cutoff = Date.now() - (c.retention_days ?? 0) * 86_400_000;
      let purged = 0;
      for (;;) {
        const ids = ((await this.db('channel_sessions').where({ channel_id: c.id }).andWhere('last_activity_at', '<', cutoff).limit(200).select('id')) as { id: string }[]).map((r) => r.id);
        if (!ids.length) break;
        const held = ((await this.db('channel_messages').whereIn('session_id', ids).whereNotNull('flag_id').select('flag_id')) as { flag_id: string }[]).map((r) => r.flag_id);
        if (held.length) await this.db('guard_flags').whereIn('id', held).andWhere({ state: 'open' }).update({ state: 'rejected', decided_at: Date.now(), reason: 'The session was purged by the channel retention period.' });
        await this.db('channel_outbox').whereIn('session_id', ids).delete();
        await this.db('channel_threads').whereIn('session_id', ids).delete();
        await this.db('channel_messages').whereIn('session_id', ids).delete();
        purged += await this.db('channel_sessions').whereIn('id', ids).delete();
      }
      if (purged) {
        touched++;
        total += purged;
        await this.audit({ service: 'channels.retention' }, tenantId, 'channel.session.purged', { channel: c.id, workspace: c.workspace_id }, { sessions: purged, retentionDays: c.retention_days }, c.label, null, 'system');
        this.event(tenantId, 'channel.session.purged', c.label, { channel: c.id, workspace: c.workspace_id, sessions: purged });
      }
    }
    return { channels: touched, sessions: total };
  }

  async purgeNow(ctx: Ctx, channelId: string) {
    const c = await this.visible(ctx.p, channelId);
    const job = await this.s().jobs.enqueue({ tenantId: ctx.p.tenantId, type: 'channels.retention', payload: { tenantId: ctx.p.tenantId }, createdBy: ctx.p.userId, maxAttempts: 1 });
    await this.auditCtx(ctx, 'channel.purge.requested', { channel: c.id, workspace: c.workspace_id, job: job.id }, { retentionDays: c.retention_days }, c.label);
    return { jobId: job.id };
  }

  // ---------- moderation (B-1902 registry) ----------

  private registerModeration(): void {
    const reg = this.s().moderation.registry;
    const db = () => this.s().db;
    const reviewer = (p: Principal, o: ModeratedObject, workspaces: string[]) => clears(p.clearance, o.label) && effectivePermissions(p).has('channels:review') && !!o.workspaceId && workspaces.includes(o.workspaceId);
    if (!reg.get(SESSION_OBJECT))
      reg.register({
        type: SESSION_OBJECT,
        description: 'A customer session in a channel (a hidden session ends its customer token and leaves the queues)',
        resolve: async (tenantId, id) => {
          const sess = await this.session(tenantId, id);
          return sess ? { type: SESSION_OBJECT, id: sess.id, tenantId, workspaceId: sess.workspace_id, label: sess.label, ownerId: null, state: sess.state } : null;
        },
        canRead: async (p, o, ws) => reviewer(p, o, ws),
        text: async (o) => {
          const rows = ((await db()('channel_messages').where({ session_id: o.id, role: 'customer' }).orderBy('seq').limit(20)) as Record<string, unknown>[]).map(messageFrom);
          return (await Promise.all(rows.map((m) => this.text(m)))).join('\n\n');
        },
        hide: async (o) => {
          if (!o.state || o.state === 'hidden') return null;
          const n = await db()('channel_sessions').where({ id: o.id, tenant_id: o.tenantId, state: o.state }).update({ state: 'hidden', updated_at: Date.now() });
          return n ? o.state : null;
        },
        restore: async (o, prev) => (await db()('channel_sessions').where({ id: o.id, tenant_id: o.tenantId, state: 'hidden' }).update({ state: prev, updated_at: Date.now() })) > 0
      });
    if (!reg.get(MESSAGE_OBJECT))
      reg.register({
        type: MESSAGE_OBJECT,
        description: 'A message in a customer session (a hidden message leaves the transcript the customer sees and the model\'s history)',
        resolve: async (tenantId, id) => {
          const r = await db()('channel_messages').where({ tenant_id: tenantId, id }).first();
          if (!r) return null;
          const m = messageFrom(r);
          const sess = await this.session(tenantId, m.session_id);
          return { type: MESSAGE_OBJECT, id: m.id, tenantId, workspaceId: sess?.workspace_id ?? null, label: m.label, ownerId: m.author_id, state: m.state };
        },
        canRead: async (p, o, ws) => reviewer(p, o, ws),
        text: async (o) => {
          const r = await db()('channel_messages').where({ id: o.id }).first();
          return r ? this.text(messageFrom(r)) : '';
        },
        hide: async (o) => {
          if (o.state !== 'delivered') return null;
          const n = await db()('channel_messages').where({ id: o.id, tenant_id: o.tenantId, state: 'delivered' }).update({ state: 'hidden' });
          return n ? 'delivered' : null;
        },
        restore: async (o, prev) => (await db()('channel_messages').where({ id: o.id, tenant_id: o.tenantId, state: 'hidden' }).update({ state: prev })) > 0
      });
  }
}
