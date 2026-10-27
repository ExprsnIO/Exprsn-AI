import { createHmac } from 'node:crypto';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import { safeEqual, sha256 } from '../crypto/index.js';

/*
 * Email for customer channels (B-2303): parsing inbound mail (from IMAP or a provider webhook) into one shape,
 * threading by Message-ID, delivery reports (bounces), and the webhook signatures.
 *
 * Inbound shapes:
 * - raw RFC 5322 messages (IMAP, or `raw` in a generic webhook), parsed with mailparser;
 * - the generic JSON webhook: `{"type": "message", "from", "fromName"?, "subject"?, "text", "messageId",
 *   "inReplyTo"?, "references"?}` or `{"type": "bounce", "recipient", "messageId"?, "kind"?, "status"?, "reason"?}`,
 *   signed with `X-Exprsn-Timestamp` (unix seconds) and `X-Exprsn-Signature: v1=<hex HMAC-SHA256 of
 *   "<timestamp>.<raw body>">` under the channel's webhook secret;
 * - Mailgun: inbound routes (`forward()`, form-encoded: `sender`, `from`, `subject`, `body-plain`, `Message-Id`,
 *   `In-Reply-To`, `References`, `timestamp`, `token`, `signature`) and event webhooks (JSON with `signature` and
 *   `event-data`; `failed` and `complained` become bounces), signed with HMAC-SHA256 of timestamp + token under the
 *   Mailgun webhook signing key.
 */

export interface InboundMessage {
  kind: 'message';
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: { address: string; name: string | null };
  subject: string | null;
  text: string;
  /** An automatic message (auto-reply, list traffic): recorded nowhere and never answered, so two robots cannot loop. */
  automatic: boolean;
}

export interface InboundBounce {
  kind: 'bounce';
  /** The report's own id (the delivery report's Message-ID, the provider's event id), to record it once. */
  reportId?: string | null;
  /** The Message-ID of the message that bounced, when the report carries it. */
  messageId: string | null;
  recipient: string | null;
  type: 'hard' | 'soft' | 'complaint';
  status: string | null;
  reason: string | null;
}

export type Inbound = InboundMessage | InboundBounce;

export const MAX_TEXT = 20_000;

/** A Message-ID without its angle brackets and whitespace, or null when it is not one. */
export function normalizeMid(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const x = v.trim().replace(/^<|>$/g, '').trim();
  return x && x.length <= 998 && !/[\s<>]/.test(x) ? x : null;
}

export const midHash = (mid: string): string => sha256(`mid:${mid}`);

/** The Message-IDs in a References or In-Reply-To value (a string, or a list of them). */
export function midList(v: unknown): string[] {
  const parts = Array.isArray(v) ? v : typeof v === 'string' ? [v] : [];
  const out: string[] = [];
  for (const p of parts) {
    if (typeof p !== 'string') continue;
    const found = p.match(/<[^<>\s]+>/g) ?? p.split(/\s+/);
    for (const f of found) {
      const m = normalizeMid(f);
      if (m && !out.includes(m)) out.push(m);
    }
  }
  return out.slice(-50);
}

/**
 * Drops the quoted part of a reply (the "On … wrote:" line and what follows, or `>` lines), so the model and the
 * transcript see what the customer wrote this time. Falls back to the whole text when nothing would be left.
 */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^On .{3,200} wrote:\s*$/.test(l) || (/^On .{3,200}$/.test(l) && /wrote:\s*$/.test(lines[i + 1] ?? '')) || /^-{2,}\s*Original Message\s*-{2,}/i.test(l) || /^_{5,}$/.test(l)) break;
    if (/^>/.test(l)) continue;
    out.push(l);
  }
  const kept = out.join('\n').trim();
  return (kept || text.trim()).slice(0, MAX_TEXT);
}

const firstAddress = (a: AddressObject | AddressObject[] | undefined): { address: string; name: string | null } | null => {
  const list = Array.isArray(a) ? a : a ? [a] : [];
  for (const o of list) for (const v of o.value) if (v.address) return { address: v.address.trim().toLowerCase(), name: v.name?.trim() || null };
  return null;
};

/** Reads a delivery status report (RFC 3464) out of a parsed message, or null when it is not one. */
function dsnOf(m: ParsedMail): InboundBounce | null {
  const ct = m.headers.get('content-type') as { value?: string; params?: Record<string, string> } | undefined;
  const isReport = ct?.value === 'multipart/report' && /delivery-status/i.test(ct.params?.['report-type'] ?? '');
  const feedback = ct?.value === 'multipart/report' && /feedback-report/i.test(ct.params?.['report-type'] ?? '');
  if (!isReport && !feedback) return null;
  const parts = [m.text ?? '', ...m.attachments.filter((a) => /^(text|message)\//i.test(a.contentType)).map((a) => a.content.toString('utf8'))].join('\n');
  const field = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, 'im').exec(parts)?.[1]?.trim() ?? null;
  const recipient = (field('Final-Recipient') ?? field('Original-Recipient') ?? '').replace(/^rfc822;\s*/i, '').trim().toLowerCase() || null;
  const status = field('Status');
  const action = (field('Action') ?? '').toLowerCase();
  const original = /^Message-ID:\s*(<[^>\s]+>)/im.exec(m.attachments.map((a) => a.content.toString('utf8')).join('\n'))?.[1] ?? /^Message-ID:\s*(<[^>\s]+>)/gim.exec(parts.slice(Math.max(0, parts.search(/^Final-Recipient:/im))))?.[1] ?? null;
  if (feedback) return { kind: 'bounce', messageId: normalizeMid(original), recipient, type: 'complaint', status: null, reason: field('Feedback-Type') };
  if (action && action !== 'failed' && action !== 'delayed') return null; // delivered, relayed, expanded: not a bounce
  return { kind: 'bounce', messageId: normalizeMid(original), recipient, type: action === 'delayed' || status?.startsWith('4') ? 'soft' : 'hard', status: status?.slice(0, 20) ?? null, reason: (field('Diagnostic-Code') ?? null)?.slice(0, 500) ?? null };
}

/** Parses a raw message (IMAP, or `raw` in the generic webhook). */
export async function parseRaw(raw: Buffer | string): Promise<Inbound | null> {
  const m = await simpleParser(raw, { skipHtmlToText: false, skipTextToHtml: true, skipImageLinks: true, maxHtmlLengthToParse: 1_000_000 });
  const bounce = dsnOf(m);
  if (bounce) return { ...bounce, reportId: normalizeMid(m.messageId) };
  const from = firstAddress(m.from);
  if (!from) return null;
  const auto = String(m.headers.get('auto-submitted') ?? 'no').toLowerCase();
  const precedence = String(m.headers.get('precedence') ?? '').toLowerCase();
  const automatic = (auto !== 'no' && auto !== '') || ['bulk', 'junk', 'list', 'auto_reply'].includes(precedence) || m.headers.has('list-id') || /^(mailer-daemon|postmaster)@/i.test(from.address);
  return {
    kind: 'message',
    messageId: normalizeMid(m.messageId),
    inReplyTo: normalizeMid(m.inReplyTo) ?? midList(m.inReplyTo)[0] ?? null,
    references: midList(m.references),
    from,
    subject: m.subject?.trim().slice(0, 500) || null,
    text: stripQuoted(m.text ?? ''),
    automatic
  };
}

// ---------- webhook shapes ----------

const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const address = (v: unknown): { address: string; name: string | null } | null => {
  const s = str(v, 400);
  if (!s) return null;
  const m = /^\s*(?:"?([^"<]*)"?\s*)?<([^<>\s]+@[^<>\s]+)>\s*$/.exec(s) ?? /^()([^<>\s"]+@[^<>\s"]+)$/.exec(s);
  return m ? { address: m[2]!.toLowerCase(), name: m[1]?.trim() || null } : null;
};

/** The generic JSON webhook body. Throws with a reason the sender can fix. */
export async function fromGeneric(body: Record<string, unknown>): Promise<Inbound | null> {
  if (body.type === 'bounce') {
    const kind = body.kind === 'soft' || body.kind === 'complaint' ? body.kind : 'hard';
    return { kind: 'bounce', reportId: str(body.id, 200), messageId: normalizeMid(body.messageId), recipient: str(body.recipient, 320)?.toLowerCase() ?? null, type: kind, status: str(body.status, 20), reason: str(body.reason, 500) };
  }
  if (body.type !== 'message') throw new Error('type must be "message" or "bounce".');
  if (typeof body.raw === 'string') return parseRaw(body.raw);
  const from = address(body.fromName && typeof body.from === 'string' ? `"${String(body.fromName).replace(/"/g, '')}" <${body.from}>` : body.from);
  if (!from) throw new Error('from must be an email address.');
  if (typeof body.text !== 'string') throw new Error('text is required.');
  return { kind: 'message', messageId: normalizeMid(body.messageId), inReplyTo: normalizeMid(body.inReplyTo), references: midList(body.references), from, subject: str(body.subject, 500), text: stripQuoted(body.text), automatic: body.automatic === true };
}

/** A Mailgun inbound route post (form fields). */
export function fromMailgunForm(f: Record<string, unknown>): Inbound | null {
  const from = address(f.from) ?? address(f.sender);
  if (!from) return null;
  const headers = (() => {
    try {
      const h = JSON.parse(String(f['message-headers'] ?? '[]')) as unknown;
      return Array.isArray(h) ? (h as [string, string][]) : [];
    } catch {
      return [];
    }
  })();
  const header = (name: string) => headers.find((x) => Array.isArray(x) && String(x[0]).toLowerCase() === name)?.[1];
  const auto = String(header('auto-submitted') ?? 'no').toLowerCase();
  const text = typeof f['stripped-text'] === 'string' && f['stripped-text'].trim() ? String(f['stripped-text']) : String(f['body-plain'] ?? '');
  return {
    kind: 'message',
    messageId: normalizeMid(f['Message-Id'] ?? header('message-id')),
    inReplyTo: normalizeMid(f['In-Reply-To'] ?? header('in-reply-to')),
    references: midList(f.References ?? header('references')),
    from,
    subject: str(f.subject, 500),
    text: stripQuoted(text),
    automatic: auto !== 'no' || /^(mailer-daemon|postmaster)@/i.test(from.address)
  };
}

/** A Mailgun event webhook (`failed`, `complained`); other events are acknowledged and ignored. */
export function fromMailgunEvent(body: Record<string, unknown>): Inbound | null {
  const e = (body['event-data'] ?? {}) as Record<string, unknown>;
  const event = String(e.event ?? '');
  if (event !== 'failed' && event !== 'complained') return null;
  const msg = (e.message ?? {}) as { headers?: Record<string, unknown> };
  const ds = (e['delivery-status'] ?? {}) as Record<string, unknown>;
  return {
    kind: 'bounce',
    reportId: str(e.id, 200),
    messageId: normalizeMid(msg.headers?.['message-id']),
    recipient: str(e.recipient, 320)?.toLowerCase() ?? null,
    type: event === 'complained' ? 'complaint' : e.severity === 'temporary' ? 'soft' : 'hard',
    status: ds.code != null ? String(ds.code).slice(0, 20) : null,
    reason: str(ds.description, 500) ?? str(ds.message, 500)
  };
}

// ---------- signatures ----------

/** The generic webhook signature: `v1=<hex HMAC-SHA256("<timestamp>.<body>")>`, within the tolerance. */
export function verifyGeneric(secret: string, timestamp: string | undefined, signature: string | undefined, raw: Buffer, toleranceS: number, nowMs = Date.now()): string | null {
  if (!timestamp || !/^\d{1,12}$/.test(timestamp)) return 'X-Exprsn-Timestamp is missing.';
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > toleranceS) return 'The timestamp is outside the tolerance.';
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex');
  const given = (signature ?? '').split(',').map((x) => x.trim()).filter((x) => x.startsWith('v1=')).map((x) => x.slice(3));
  return given.some((g) => safeEqual(g, expected)) ? null : 'The signature does not verify.';
}

export const signGeneric = (secret: string, timestamp: string, raw: string | Buffer): string => `v1=${createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex')}`;

/** Mailgun's signature: hex HMAC-SHA256 of timestamp + token under the webhook signing key, within the tolerance. */
export function verifyMailgun(key: string, timestamp: unknown, token: unknown, signature: unknown, toleranceS: number, nowMs = Date.now()): string | null {
  if (typeof timestamp !== 'string' && typeof timestamp !== 'number') return 'The Mailgun timestamp is missing.';
  if (typeof token !== 'string' || typeof signature !== 'string' || token.length < 10 || token.length > 200) return 'The Mailgun token or signature is missing.';
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > toleranceS) return 'The timestamp is outside the tolerance.';
  const expected = createHmac('sha256', key).update(`${timestamp}${token}`).digest('hex');
  return safeEqual(signature.toLowerCase(), expected) ? null : 'The signature does not verify.';
}

export const signMailgun = (key: string, timestamp: string, token: string): string => createHmac('sha256', key).update(`${timestamp}${token}`).digest('hex');

/** `Re: <subject>` without stacking prefixes. */
export const replySubject = (subject: string | null): string => {
  const s = (subject ?? '').replace(/[\r\n]+/g, ' ').trim();
  return /^re:/i.test(s) ? s.slice(0, 200) : `Re: ${s || 'your message'}`.slice(0, 200);
};
