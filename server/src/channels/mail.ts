import { isIP } from 'node:net';
import nodemailer from 'nodemailer';
import { ulid } from 'ulid';
import { isUniqueViolation, type AuditActor } from '../audit/chain.js';
import { badRequest, HttpProblem, notFound, tooManyRequests } from '../http/problem.js';
import { tenantHostProblem } from '../integrations/hosts.js';
import { checkServiceHost, serviceAddressProblem, servicePolicy } from '../platform/egress.js';
import { headerSafe } from '../platform/email-templates.js';
import type { Services } from '../services.js';
import { fromGeneric, fromMailgunEvent, fromMailgunForm, midHash, normalizeMid, parseRaw, replySubject, verifyGeneric, verifyMailgun, type Inbound, type InboundBounce, type InboundMessage } from './email.js';
import { imapflowFetcher, type ImapFetcher } from './imap.js';
import type { ChannelRow, ChannelService, MessageRow, SessionRow } from './service.js';

/*
 * Email channels (B-2303): mail comes in by IMAP polling (`channels.imap-poll`, one job per channel per tick, so one
 * instance reads a mailbox at a time) and by signed provider webhooks; it is threaded into sessions by Message-ID; the
 * answers go out from an outbox, one `channels.send` job per message with retries; bounces are recorded and mark the
 * outbox row. Hosts are checked against the operator's service address rules and the tenant's allowed hosts, and the
 * connection dials the address that was checked. Credentials are `vault:` references that resolve as the user who
 * saved them.
 *
 * Threading: a message joins a session when its In-Reply-To or References name a Message-ID of that session AND it
 * comes from the session's customer address. A forged In-Reply-To from another sender starts a new session instead
 * of reading into someone else's thread. A reply to a closed session reopens it.
 */

export interface OutboundMail {
  from: string;
  to: string;
  subject: string;
  text: string;
  messageId: string;
  inReplyTo?: string;
  references?: string;
  headers?: Record<string, string>;
}

export interface ChannelMailer {
  sendMail(m: OutboundMail): Promise<unknown>;
}

export interface SmtpTarget {
  address: string;
  servername: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

export interface ChannelIo {
  imap: ImapFetcher;
  smtp: (t: SmtpTarget) => ChannelMailer;
  /** The platform's mail transport (SMTP_URL), for channels without SMTP settings of their own. */
  platform: ChannelMailer | null;
}

const HOST = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export const defaultSmtp = (t: SmtpTarget): ChannelMailer =>
  nodemailer.createTransport({ host: t.address, port: t.port, secure: t.secure, requireTLS: !t.secure, auth: { user: t.user, pass: t.pass }, tls: { servername: t.servername }, connectionTimeout: 20_000, greetingTimeout: 15_000, socketTimeout: 60_000 }) as unknown as ChannelMailer;

export type IngestResult = { action: 'started' | 'joined' | 'duplicate' | 'ignored' | 'bounce'; session?: string; reason?: string };

export class ChannelMail {
  private readonly io: ChannelIo;

  constructor(
    private readonly s: () => Services,
    private readonly ch: ChannelService,
    io: Partial<ChannelIo>
  ) {
    this.io = { imap: io.imap ?? imapflowFetcher, smtp: io.smtp ?? defaultSmtp, platform: io.platform ?? null };
  }

  private get db() {
    return this.s().db;
  }

  registerJobs(): void {
    const s = this.s();
    s.jobs.register('channels.imap-poll', async (p, ctx) => this.poll(ctx.job.tenant_id, String(p.channelId), ctx.signal), { timeoutMs: 5 * 60_000 });
    s.jobs.register('channels.send', async (p, ctx) => this.send(ctx.job.tenant_id, String(p.outboxId), ctx.job.attempts >= ctx.job.max_attempts));
  }

  schedule(): void {
    const s = this.s();
    if (s.cfg.CHANNELS_IMAP_POLL_SECONDS <= 0) return;
    s.scheduler.every('channels.imap-poll', s.cfg.CHANNELS_IMAP_POLL_SECONDS * 1000, async () => {
      const rows = (await this.db('channels').where({ kind: 'email', state: 'active' }).select('id', 'tenant_id', 'settings')) as { id: string; tenant_id: string; settings: string }[];
      return rows.filter((r) => /"imap":\{/.test(String(r.settings))).map((r) => ({ tenantId: r.tenant_id, payload: { channelId: r.id }, key: r.id }));
    });
  }

  /** A host name or address a channel may name (the address rules are checked again at every connection). */
  async checkHostSyntax(host: string): Promise<void> {
    const h = host.trim().toLowerCase();
    if (isIP(h)) {
      const problem = serviceAddressProblem(h, h, servicePolicy(this.s().cfg));
      if (problem) throw badRequest(problem);
      return;
    }
    if (!HOST.test(h) || h.length > 253) throw badRequest(`${host.slice(0, 80)} is not a host name.`);
  }

  /** Resolves and checks a mail host for a tenant: the operator's rules, then the tenant's allowed hosts. */
  private async target(tenantId: string, host: string): Promise<{ address: string; servername: string }> {
    const checked = await checkServiceHost(host, servicePolicy(this.s().cfg));
    const refused = tenantHostProblem(checked.host, checked.addresses, await this.s().integrations.allowList(tenantId));
    if (refused) throw new Error(refused);
    return { address: checked.addresses[0]!, servername: checked.host };
  }

  private async secret(c: ChannelRow, ref: string, via: string): Promise<string> {
    return this.s().vault.resolveFor(c.tenant_id, c.vault_owner, ref, { via: `channel:${c.id}:${via}` });
  }

  // ---------- IMAP ----------

  async poll(tenantId: string, channelId: string, signal?: AbortSignal) {
    const c = await this.ch.row(tenantId, channelId);
    const imap = c?.settings.email?.imap;
    if (!c || c.state !== 'active' || c.kind !== 'email' || !imap) return { skipped: 'no IMAP mailbox' };
    const cur = (await this.db('channel_imap_cursors').where({ channel_id: c.id }).first()) as { uid_validity: number | null; last_uid: number; last_error: string | null } | undefined;
    if (!cur) await this.db('channel_imap_cursors').insert({ channel_id: c.id, tenant_id: c.tenant_id, uid_validity: null, last_uid: 0, polled_at: null, last_error: null });
    const cursor = { uidValidity: cur?.uid_validity == null ? null : Number(cur.uid_validity), lastUid: Number(cur?.last_uid ?? 0) };
    const counts = { read: 0, started: 0, joined: 0, duplicate: 0, ignored: 0, bounce: 0, failed: 0 };
    try {
      const where = await this.target(c.tenant_id, imap.host);
      const pass = await this.secret(c, imap.passwordRef, 'imap');
      const batch = await this.io.imap({ ...where, port: imap.port, secure: imap.secure, user: imap.user, pass, mailbox: imap.mailbox }, cursor, this.s().cfg.CHANNELS_IMAP_BATCH, signal);
      if (cursor.uidValidity !== batch.uidValidity) await this.db('channel_imap_cursors').where({ channel_id: c.id }).update({ uid_validity: batch.uidValidity, last_uid: 0 });
      for (const m of batch.messages) {
        counts.read++;
        try {
          const parsed = m.raw.length ? await parseRaw(m.raw) : null;
          const r = parsed ? await this.ingest(c, parsed, 'imap') : { action: 'ignored' as const };
          counts[r.action]++;
        } catch (err) {
          // One bad message does not stop the mailbox: it is skipped and counted.
          counts.failed++;
          this.s().log.warn({ err: (err as Error).message, channel: c.id, uid: m.uid }, 'channel mail skipped');
        }
        await this.db('channel_imap_cursors').where({ channel_id: c.id }).update({ last_uid: m.uid });
      }
      await this.db('channel_imap_cursors').where({ channel_id: c.id }).update({ polled_at: Date.now(), last_error: null });
      if (batch.more) await this.s().jobs.enqueue({ tenantId: c.tenant_id, type: 'channels.imap-poll', payload: { channelId: c.id }, dedupeKey: `channels.imap-poll:more:${c.id}:${batch.messages.at(-1)?.uid ?? 0}`, maxAttempts: 1 });
      return { ...counts, more: batch.more };
    } catch (err) {
      const msg = (err as Error).message.slice(0, 500);
      await this.db('channel_imap_cursors').where({ channel_id: c.id }).update({ polled_at: Date.now(), last_error: msg });
      // Audited when the error changes, not at every tick.
      if (cur?.last_error !== msg) await this.s().audit.append({ tenantId: c.tenant_id, action: 'channel.imap.failed', kind: 'system', actor: { service: 'channels.imap' }, target: { channel: c.id, workspace: c.workspace_id }, label: c.label, detail: { error: msg } });
      throw err;
    }
  }

  // ---------- inbound ----------

  private async findThread(c: ChannelRow, mids: string[], senderKey: string): Promise<SessionRow | null> {
    if (!mids.length) return null;
    const rows = (await this.db('channel_threads').where({ channel_id: c.id }).whereIn('mid_hash', mids.map(midHash)).select('session_id')) as { session_id: string }[];
    for (const id of [...new Set(rows.map((r) => r.session_id))]) {
      const sess = await this.ch.session(c.tenant_id, id);
      if (sess && sess.customer_key === senderKey && sess.state !== 'hidden') return sess;
    }
    return null;
  }

  private async remember(sess: SessionRow, mid: string, direction: 'in' | 'out'): Promise<boolean> {
    const id = ulid();
    try {
      await this.db('channel_threads').insert({ id, tenant_id: sess.tenant_id, channel_id: sess.channel_id, session_id: sess.id, mid_hash: midHash(mid), mid: await this.ch.seal(sess.tenant_id, mid, `channel-thread:${id}`), direction, created_at: Date.now() });
      return true;
    } catch {
      return false; // seen already (unique per channel)
    }
  }

  /** Takes one inbound message or bounce into the channel. Idempotent per Message-ID. */
  async ingest(c: ChannelRow, inbound: Inbound, source: 'imap' | 'generic' | 'mailgun'): Promise<IngestResult> {
    if (inbound.kind === 'bounce') return { action: (await this.recordBounce(c, inbound, source)) ? 'bounce' : 'duplicate' };
    return this.ingestMessage(c, inbound, source);
  }

  private async ingestMessage(c: ChannelRow, m: InboundMessage, source: string): Promise<IngestResult> {
    const own = c.settings.email?.address.toLowerCase();
    if (m.automatic) return { action: 'ignored', reason: 'automatic message' };
    if (own && m.from.address === own) return { action: 'ignored', reason: 'from the channel itself' };
    if (!m.text.trim()) return { action: 'ignored', reason: 'no text' };
    const mid = m.messageId ?? `generated-${ulid()}@exprsn-ai.invalid`;
    if (await this.db('channel_threads').where({ channel_id: c.id, mid_hash: midHash(mid) }).first('id')) return { action: 'duplicate' };
    const senderKey = this.ch.customerKeyFor(c.tenant_id, 'email', m.from.address);
    let sess = await this.findThread(c, [...(m.inReplyTo ? [m.inReplyTo] : []), ...m.references], senderKey);
    let action: IngestResult['action'] = 'joined';
    if (sess && (sess.state === 'closed')) {
      const t = Date.now();
      await this.db('channel_sessions').where({ id: sess.id, state: 'closed' }).update({ state: 'open', closed_at: null, updated_at: t });
      sess = (await this.ch.session(c.tenant_id, sess.id))!;
    }
    if (!sess) {
      sess = await this.ch.createSession(c, { kind: 'email', key: senderKey, customer: { name: m.from.name, email: m.from.address, externalId: null }, subject: m.subject });
      action = 'started';
      await this.s().audit.append({ tenantId: c.tenant_id, action: 'channel.session.started', kind: 'system', actor: { service: `channels.${source}` }, target: { channel: c.id, session: sess.id, workspace: c.workspace_id }, label: c.label, detail: { customer: 'email' } });
    }
    if (!(await this.remember(sess, mid, 'in'))) {
      // Another instance took the same message at the same moment: drop the session this one just opened for it.
      if (action === 'started') await this.db('channel_sessions').where({ id: sess.id, next_seq: 1 }).delete();
      return { action: 'duplicate' };
    }
    const actor: AuditActor = { service: `channels.${source}` };
    try {
      const { customer } = await this.ch.receive(c, sess, m.text, 'email', { ip: null, traceId: null, deferReply: true });
      await this.ch.queueReply(sess, customer.id);
    } catch (err) {
      if (err instanceof HttpProblem && err.status === 422) {
        // Refused by a guardrail: recorded (audited by receive) and not answered.
        await this.s().audit.append({ tenantId: c.tenant_id, action: 'channel.mail.refused', kind: 'system', actor, target: { channel: c.id, session: sess.id, workspace: c.workspace_id }, label: sess.label, detail: { source } });
        return { action: 'ignored', session: sess.id, reason: 'refused by a guardrail' };
      }
      throw err;
    }
    return { action, session: sess.id };
  }

  async recordBounce(c: ChannelRow, b: InboundBounce, source: string): Promise<boolean> {
    const t = Date.now();
    const reportHash = b.reportId ? midHash(`report:${b.reportId}`) : null;
    if (reportHash && (await this.db('channel_bounces').where({ channel_id: c.id, report_hash: reportHash }).first('id'))) return false;
    const out = b.messageId ? ((await this.db('channel_outbox').where({ channel_id: c.id, header_id: `<${b.messageId}>` }).first('id', 'session_id')) as { id: string; session_id: string } | undefined) : undefined;
    try {
      await this.db('channel_bounces').insert({ id: ulid(), tenant_id: c.tenant_id, channel_id: c.id, outbox_id: out?.id ?? null, recipient_key: b.recipient ? this.ch.customerKeyFor(c.tenant_id, 'email', b.recipient) : null, kind: b.type, status: b.status, reason: b.reason, source, report_hash: reportHash, created_at: t });
    } catch (err) {
      if (reportHash && isUniqueViolation(err)) return false; // the same report, recorded by another instance meanwhile
      throw err;
    }
    if (out) await this.db('channel_outbox').where({ id: out.id }).update({ state: 'bounced', bounced_at: t, last_error: `${b.type} bounce${b.status ? ` ${b.status}` : ''}`.slice(0, 500) });
    await this.s().audit.append({ tenantId: c.tenant_id, action: 'channel.bounce.recorded', kind: 'system', actor: { service: `channels.${source}` }, target: { channel: c.id, workspace: c.workspace_id, ...(out ? { outbox: out.id, session: out.session_id } : {}) }, label: c.label, detail: { kind: b.type, status: b.status } });
    this.ch.event(c.tenant_id, 'channel.bounce.recorded', c.label, { channel: c.id, session: out?.session_id ?? null, workspace: c.workspace_id, kind: b.type });
    return true;
  }

  async bounces(c: ChannelRow, limit = 100) {
    const rows = (await this.db('channel_bounces').where({ channel_id: c.id }).orderBy('created_at', 'desc').limit(limit)) as Record<string, unknown>[];
    return rows.map((r) => ({ id: r.id, outboxId: r.outbox_id ?? null, kind: r.kind, status: r.status ?? null, reason: r.reason ?? null, source: r.source, createdAt: Number(r.created_at) }));
  }

  // ---------- webhooks ----------

  /**
   * A provider webhook for an email channel. The signature is checked before anything is parsed; every refusal
   * answers the same way. Replays inside the tolerance window are acknowledged and dropped.
   */
  async webhook(key: string, provider: 'generic' | 'mailgun', raw: Buffer, contentType: string, headers: { timestamp?: string; signature?: string }, ip: string | null): Promise<{ accepted: boolean; result: IngestResult | null }> {
    const s = this.s();
    const c = await this.ch.byKey(key);
    const refuse = () => new HttpProblem(401, 'Invalid signature', 'The webhook signature does not verify for this channel.');
    if (!c || c.kind !== 'email' || c.state !== 'active') throw notFound('Channel');
    const l = await s.counters.hit(`channel-webhook:${c.id}`, 60_000);
    if (l.count > s.cfg.CHANNELS_WEBHOOK_PER_MINUTE) throw tooManyRequests('Too many webhook calls for this channel.', l.resetMs / 1000);
    const tol = s.cfg.CHANNELS_WEBHOOK_TOLERANCE_SECONDS;
    let inbound: Inbound | null;
    let replayKey: string;
    if (provider === 'generic') {
      const secret = await this.ch.secret(c, 'webhook');
      const problem = secret ? verifyGeneric(secret, headers.timestamp, headers.signature, raw, tol) : 'no secret';
      if (problem) {
        s.log.warn({ channel: c.id, reason: problem, ip }, 'channel webhook refused');
        throw refuse();
      }
      replayKey = `${headers.timestamp}:${headers.signature}`;
      let body: unknown;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        throw badRequest('The body is not JSON.');
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('The body is a JSON object.');
      try {
        inbound = await fromGeneric(body as Record<string, unknown>);
      } catch (err) {
        throw badRequest((err as Error).message);
      }
    } else {
      const ref = c.settings.email?.mailgunKeyRef;
      if (!ref) throw notFound('Endpoint');
      const signingKey = await this.secret(c, ref, 'mailgun');
      let fields: Record<string, unknown>;
      let event = false;
      if (/json/i.test(contentType)) {
        try {
          fields = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        } catch {
          throw badRequest('The body is not JSON.');
        }
        event = true;
      } else if (/x-www-form-urlencoded/i.test(contentType)) {
        fields = Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
      } else {
        throw new HttpProblem(415, 'Unsupported media type', 'Send Mailgun routes as application/x-www-form-urlencoded (forward without attachments), and events as JSON.');
      }
      const sig = (event ? fields.signature : fields) as Record<string, unknown> | undefined;
      const problem = verifyMailgun(signingKey, sig?.timestamp, sig?.token, sig?.signature, tol);
      if (problem) {
        s.log.warn({ channel: c.id, reason: problem, ip }, 'channel webhook refused');
        throw refuse();
      }
      replayKey = String(sig?.token);
      inbound = event ? fromMailgunEvent(fields) : fromMailgunForm(fields);
    }
    const replay = await s.counters.hit(`channel-webhook-seen:${c.id}:${replayKey}`, tol * 2000);
    if (replay.count > 1) return { accepted: true, result: { action: 'duplicate' } };
    if (!inbound) return { accepted: true, result: { action: 'ignored' } };
    return { accepted: true, result: await this.ingest(c, inbound, provider) };
  }

  // ---------- outbound ----------

  /** Queues an answer for the session's customer, threaded under the last message they sent. */
  async queueOutbound(c: ChannelRow, sess: SessionRow, m: MessageRow, automatic: boolean): Promise<void> {
    const customer = await this.ch.customerOf(sess);
    const mail = c.settings.email;
    if (!customer.email || !mail) return;
    const threads = (await this.db('channel_threads').where({ session_id: sess.id }).orderBy('created_at').select('id', 'mid', 'direction')) as { id: string; mid: string; direction: string }[];
    const mids: { mid: string; dir: string }[] = [];
    for (const t of threads) mids.push({ mid: (await this.ch.open(sess.tenant_id, t.mid, `channel-thread:${t.id}`)) ?? '', dir: t.direction });
    const lastIn = [...mids].reverse().find((x) => x.dir === 'in')?.mid;
    const refs = mids.map((x) => x.mid).filter(Boolean).slice(-20);
    const domain = mail.address.split('@')[1] ?? 'exprsn-ai.invalid';
    const id = ulid();
    const headerId = `<${ulid().toLowerCase()}.${c.id.toLowerCase()}@${domain}>`;
    const subject = replySubject(await this.ch.open(sess.tenant_id, sess.subject, `channel-subject:${sess.id}`));
    await this.db('channel_outbox').insert({
      id,
      tenant_id: sess.tenant_id,
      channel_id: c.id,
      session_id: sess.id,
      message_id: m.id,
      recipient: await this.ch.seal(sess.tenant_id, customer.email, `channel-outbox-to:${id}`),
      recipient_key: this.ch.customerKeyFor(sess.tenant_id, 'email', customer.email),
      subject: await this.ch.seal(sess.tenant_id, subject, `channel-outbox-subject:${id}`),
      header_id: headerId,
      in_reply_to: lastIn ? `<${lastIn}>` : null,
      refs: refs.length ? refs.map((x) => `<${x}>`).join(' ') : null,
      state: 'queued',
      automatic,
      attempts: 0,
      last_error: null,
      created_at: Date.now(),
      sent_at: null,
      bounced_at: null
    });
    await this.remember(sess, normalizeMid(headerId)!, 'out');
    await this.s().jobs.enqueue({ tenantId: sess.tenant_id, type: 'channels.send', payload: { outboxId: id }, dedupeKey: `channels.send:${id}`, maxAttempts: 5 });
  }

  private async mailer(c: ChannelRow): Promise<ChannelMailer> {
    const smtp = c.settings.email?.smtp;
    if (!smtp) {
      if (!this.io.platform) throw new Error('Neither the channel nor the server (SMTP_URL) has an SMTP server.');
      return this.io.platform;
    }
    const where = await this.target(c.tenant_id, smtp.host);
    return this.io.smtp({ ...where, port: smtp.port, secure: smtp.secure, user: smtp.user, pass: await this.secret(c, smtp.passwordRef, 'smtp') });
  }

  /** Sends one outbox message. Retried by the queue; the last failure marks the row failed. */
  async send(tenantId: string, outboxId: string, last: boolean) {
    const row = (await this.db('channel_outbox').where({ tenant_id: tenantId, id: outboxId }).first()) as Record<string, unknown> | undefined;
    if (!row || row.state !== 'queued') return { skipped: row ? String(row.state) : 'gone' };
    const c = await this.ch.row(tenantId, String(row.channel_id));
    const mail = c?.settings.email;
    if (!c || !mail) {
      await this.db('channel_outbox').where({ id: outboxId }).update({ state: 'failed', last_error: 'The channel is gone.' });
      return { failed: 'channel gone' };
    }
    const m = await this.db('channel_messages').where({ id: String(row.message_id) }).first();
    if (!m || m.state !== 'delivered') {
      await this.db('channel_outbox').where({ id: outboxId }).update({ state: 'failed', last_error: 'The message is no longer deliverable.' });
      return { failed: 'message withdrawn' };
    }
    const to = (await this.ch.open(tenantId, String(row.recipient), `channel-outbox-to:${outboxId}`)) ?? '';
    const subject = (await this.ch.open(tenantId, String(row.subject), `channel-outbox-subject:${outboxId}`)) ?? '';
    const text = (await this.ch.open(tenantId, String(m.body), `channel-message:${String(m.id)}`)) ?? '';
    const automatic = !!row.automatic;
    const from = mail.fromName ? `"${headerSafe(mail.fromName).replace(/["\\]/g, '')}" <${mail.address}>` : mail.address;
    await this.db('channel_outbox').where({ id: outboxId }).increment('attempts', 1);
    try {
      const transport = await this.mailer(c);
      await transport.sendMail({
        from,
        to: headerSafe(to),
        subject: headerSafe(subject),
        text: `${text}\n`,
        messageId: String(row.header_id),
        ...(row.in_reply_to ? { inReplyTo: String(row.in_reply_to) } : {}),
        ...(row.refs ? { references: String(row.refs) } : {}),
        // RFC 3834: answers written by the model are automatic, so well-behaved robots do not answer them back.
        headers: { ...(automatic ? { 'Auto-Submitted': 'auto-replied' } : {}), 'X-Exprsn-Channel': c.id }
      });
    } catch (err) {
      const msg = (err as Error).message.slice(0, 500);
      await this.db('channel_outbox').where({ id: outboxId }).update({ ...(last ? { state: 'failed' } : {}), last_error: msg });
      if (last) await this.s().audit.append({ tenantId, action: 'channel.mail.failed', kind: 'system', actor: { service: 'channels.outbox' }, target: { channel: c.id, session: String(row.session_id), workspace: c.workspace_id, outbox: outboxId }, label: c.label, detail: { error: msg } });
      throw err;
    }
    await this.db('channel_outbox').where({ id: outboxId }).update({ state: 'sent', sent_at: Date.now(), last_error: null });
    return { sent: true };
  }
}
