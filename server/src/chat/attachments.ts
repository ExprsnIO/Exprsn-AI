import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import { ulid } from 'ulid';
import { json, type Db } from '../db/knex.js';
import { highest, labelRank, type Label } from '../authz/labels.js';
import type { BlobStore } from '../platform/blob.js';
import type { DataKeys } from '../platform/datakeys.js';
import type { JobQueue } from '../platform/jobs.js';
import { TOPICS, type Bus } from '../platform/bus.js';

export interface AttachmentRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  user_id: string;
  name: string;
  type: string;
  declared_type: string | null;
  size: number;
  sha256: string;
  state: 'quarantined' | 'scanning' | 'rejected' | 'ready';
  label: Label;
  reason: string | null;
  findings: { scanner?: string; detections?: Record<string, number> } | null;
  blob_key: string | null;
  created_at: number;
}

const fromRow = (r: Record<string, unknown>): AttachmentRow => ({ ...(r as unknown as AttachmentRow), size: Number(r.size), findings: json(r.findings, null), created_at: Number(r.created_at) });

export const attachmentView = (a: AttachmentRow) => ({ id: a.id, name: a.name, type: a.type, size: a.size, state: a.state, label: a.label, reason: a.reason, findings: a.findings, createdAt: a.created_at });

/** Media types accepted as attachments, detected from the bytes rather than trusted from the upload. */
const TEXT_TYPES = ['text/plain', 'text/markdown', 'text/csv', 'application/json'];
const IMAGE_SIGNATURES: [string, (b: Buffer) => boolean][] = [
  ['image/png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP']
];

export function sniff(buf: Buffer, name: string): { type: string } | { rejected: string } {
  for (const [type, test] of IMAGE_SIGNATURES) if (test(buf)) return { type };
  if (buf.includes(0)) return { rejected: 'Binary content of a type that is not accepted (text, Markdown, CSV, JSON, PNG, JPEG, WebP).' };
  const text = buf.toString('utf8');
  if (Buffer.from(text, 'utf8').length !== buf.length || text.includes('�')) return { rejected: 'The text is not valid UTF-8.' };
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'json') {
    try {
      JSON.parse(text);
      return { type: 'application/json' };
    } catch {
      return { rejected: 'The file is named .json but is not valid JSON.' };
    }
  }
  return { type: ext === 'md' || ext === 'markdown' ? 'text/markdown' : ext === 'csv' ? 'text/csv' : 'text/plain' };
}

export const luhn = (digits: string): boolean => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
};

export const ibanValid = (iban: string): boolean => {
  const s = iban.replace(/\s/g, '').toUpperCase();
  const r = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of r) {
    const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
};

/**
 * Classifies text for personal and financial data. Only kinds and counts are kept, never the matches.
 * Payment cards (Luhn-checked) and IBANs (mod-97) and national identifiers make it confidential; email addresses and
 * phone numbers alone make it internal.
 */
export function classify(text: string): { label: Label; detections: Record<string, number> } {
  const detections: Record<string, number> = {};
  const add = (k: string, n: number) => {
    if (n) detections[k] = (detections[k] ?? 0) + n;
  };
  add('email', (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? []).length);
  add('payment_card', (text.match(/\b(?:\d[ -]?){13,19}\b/g) ?? []).map((m) => m.replace(/\D/g, '')).filter((d) => d.length >= 13 && d.length <= 19 && luhn(d)).length);
  add('iban', (text.match(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g) ?? []).filter(ibanValid).length);
  add('us_ssn', (text.match(/\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g) ?? []).length);
  add('phone', (text.match(/(?:\+\d{1,3}[ .-]?)?\(?\d{2,4}\)?[ .-]\d{3,4}[ .-]\d{3,4}\b/g) ?? []).length);
  const confidential = detections.payment_card || detections.iban || detections.us_ssn;
  const label: Label = confidential ? 'confidential' : detections.email || detections.phone ? 'internal' : 'public';
  return { label, detections };
}

/** ClamAV clamd INSTREAM: returns null when clean, or the signature name when infected. */
export async function clamScan(host: string, port: number, data: Buffer, timeoutMs = 30_000): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const sock = connect({ host, port });
    let answer = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('clamd did not answer in time'));
    }, timeoutMs);
    sock.on('connect', () => {
      sock.write('zINSTREAM\0');
      for (let i = 0; i < data.length; i += 64 * 1024) {
        const chunk = data.subarray(i, i + 64 * 1024);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.length);
        sock.write(len);
        sock.write(chunk);
      }
      sock.write(Buffer.alloc(4));
    });
    sock.on('data', (d) => (answer += d.toString()));
    sock.on('end', () => {
      clearTimeout(timer);
      const a = answer.replace(/\0/g, '').trim();
      if (/OK$/.test(a)) resolve(null);
      else if (/FOUND$/.test(a)) resolve(a.replace(/^stream:\s*/, '').replace(/\s*FOUND$/, ''));
      else reject(new Error(`clamd: ${a || 'no answer'}`));
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Attachments: uploaded bytes are sealed into quarantine, then a job sniffs the real type, scans with ClamAV when
 * configured, classifies the text, and only then moves the file to the attachment store as ready. A chat request can
 * use only ready attachments, and the conversation's label rises to the attachment's.
 */
export class AttachmentService {
  constructor(
    private readonly db: Db,
    private readonly blobs: BlobStore,
    private readonly keys: DataKeys,
    private readonly jobs: JobQueue,
    private readonly bus: Bus,
    private readonly o: { maxBytes: number; clamd?: { host: string; port: number } }
  ) {
    jobs.register('attachment.scan', (p) => this.scan(String(p.id)), { timeoutMs: 5 * 60_000 });
  }

  async upload(input: { tenantId: string; workspaceId: string | null; userId: string; name: string; declaredType: string | null; label: Label; data: Buffer }): Promise<AttachmentRow> {
    const id = ulid();
    const key = `quarantine/${input.tenantId}/${id}`;
    await this.blobs.put(key, Buffer.from(await this.keys.sealBytes(input.tenantId, input.data, `attachment:${id}`)));
    const row: AttachmentRow = {
      id,
      tenant_id: input.tenantId,
      workspace_id: input.workspaceId,
      user_id: input.userId,
      name: input.name.slice(0, 255),
      type: 'application/octet-stream',
      declared_type: input.declaredType?.slice(0, 100) ?? null,
      size: input.data.length,
      sha256: createHash('sha256').update(input.data).digest('hex'),
      state: 'quarantined',
      label: input.label,
      reason: null,
      findings: null,
      blob_key: key,
      created_at: Date.now()
    };
    await this.db('attachments').insert({ ...row, findings: null });
    await this.jobs.enqueue({ tenantId: input.tenantId, type: 'attachment.scan', payload: { id }, createdBy: input.userId, maxAttempts: 2 });
    return row;
  }

  async get(tenantId: string, id: string): Promise<AttachmentRow | undefined> {
    const r = await this.db('attachments').where({ tenant_id: tenantId, id }).first();
    return r ? fromRow(r) : undefined;
  }

  /** Deletes an attachment and its stored content (conversation retention). */
  async remove(tenantId: string, id: string): Promise<boolean> {
    const a = await this.get(tenantId, id);
    if (!a) return false;
    if (a.blob_key) await this.blobs.delete(a.blob_key);
    await this.db('attachments').where({ tenant_id: tenantId, id }).delete();
    return true;
  }

  async content(a: AttachmentRow): Promise<Buffer> {
    const sealed = await this.blobs.get(a.blob_key!);
    if (!sealed) throw new Error('Attachment content is missing');
    return this.keys.openBytes(a.tenant_id, sealed.toString(), `attachment:${a.id}`);
  }

  private async scan(id: string): Promise<unknown> {
    const a = fromRow(await this.db('attachments').where({ id }).first());
    await this.db('attachments').where({ id }).update({ state: 'scanning' });
    const reject = async (reason: string, findings: AttachmentRow['findings'] = null) => {
      await this.blobs.delete(a.blob_key!);
      await this.db('attachments').where({ id }).update({ state: 'rejected', reason, findings: findings ? JSON.stringify(findings) : null, blob_key: null });
      this.emit(a, 'rejected');
      return { state: 'rejected', reason };
    };
    const data = await this.content(a);
    if (data.length > this.o.maxBytes) return reject('The file is larger than the attachment limit.');
    const type = sniff(data, a.name);
    if ('rejected' in type) return reject(type.rejected);
    let scanner = 'type check only (no ClamAV configured)';
    if (this.o.clamd) {
      const found = await clamScan(this.o.clamd.host, this.o.clamd.port, data);
      if (found) return reject(`Malware detected: ${found}`, { scanner: 'clamav' });
      scanner = 'clamav: clean';
    }
    let label = a.label;
    let detections: Record<string, number> = {};
    if (TEXT_TYPES.includes(type.type)) {
      const c = classify(data.toString('utf8'));
      detections = c.detections;
      label = highest(a.label, c.label);
    }
    // Owner and workspace limits: a file classified above what may be processed here is not admitted.
    const user = (await this.db('users').where({ id: a.user_id }).first('clearance')) as { clearance: Label } | undefined;
    const ws = a.workspace_id ? ((await this.db('workspaces').where({ id: a.workspace_id }).first('label_ceiling')) as { label_ceiling: Label } | undefined) : undefined;
    const findings = { scanner, detections };
    if (user && labelRank(label) > labelRank(user.clearance)) return reject(`Classified ${label}, above your clearance.`, findings);
    if (ws && labelRank(label) > labelRank(ws.label_ceiling)) return reject(`Classified ${label}, above this workspace's ceiling of ${ws.label_ceiling}.`, findings);
    const key = `attachments/${a.tenant_id}/${a.id}`;
    const sealed = await this.blobs.get(a.blob_key!);
    await this.blobs.put(key, sealed!);
    await this.blobs.delete(a.blob_key!);
    await this.db('attachments').where({ id }).update({ state: 'ready', type: type.type, label, findings: JSON.stringify(findings), blob_key: key });
    this.emit({ ...a, label }, 'ready');
    return { state: 'ready', type: type.type, label, detections };
  }

  private emit(a: AttachmentRow, state: string): void {
    this.bus.publish(TOPICS.chatEvent, { userId: a.user_id, event: 'attachment.state', data: { id: a.id, state } });
  }
}
