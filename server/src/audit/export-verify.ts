import { canonicalJson, sha256 } from '../crypto/index.js';

/**
 * B-7501: a JSONL audit export and its offline verification. The file is one JSON document per line:
 *
 *   {"type":"header", tenant, from, to, exportedAt, events, redacted, first:{seq,prev_hash}, last:{seq,hash}}
 *   {"type":"event", ...the audit event as stored (every field the hash covers, plus the hash)}   (one per event)
 *   {"type":"event", seq, id, ts, prev_hash, hash, redacted: true}                               (above the exporter's clearance)
 *   {"type":"proof", checkpoint:{tenant, seq, hash, ts, key, signature, payload}, algorithm}
 *
 * Verification needs nothing but the file: each event's hash is recomputed over its canonical JSON (the same
 * function the server uses, `hashEvent`), each prev_hash must equal the hash before it, and the last hash must equal
 * the signed checkpoint's hash, whose payload names that sequence number. A redacted event cannot be recomputed; its
 * stored hash is taken as the link (the proof is then "chained with N redacted links"). The checkpoint's HMAC can be
 * checked by whoever holds the key (`exprsn-ai audit:verify` does, online).
 */
export interface ExportHeader {
  type: 'header';
  tenant: string;
  from: number | null;
  to: number | null;
  exportedAt: string;
  events: number;
  redacted: number;
  first: { seq: number; prev_hash: string } | null;
  last: { seq: number; hash: string } | null;
}

export interface ExportProof {
  type: 'proof';
  algorithm: 'sha256-chain';
  checkpoint: { tenant: string; seq: number; hash: string; ts: number; key: string; signature: string; payload: string } | null;
}

export interface ExportVerifyReport {
  status: 'verified' | 'broken' | 'unsigned';
  events: number;
  redacted: number;
  checkpoint: { seq: number; hash: string } | null;
  brokenAt?: { seq: number; reason: string };
  reason?: string;
}

type Line = Record<string, unknown>;

export function hashOfExportedEvent(e: Line): string {
  const { hash: _hash, type: _type, ...rest } = e;
  void _hash;
  void _type;
  return sha256(canonicalJson(rest));
}

/** Verifies the lines of a JSONL export (strings or parsed objects). */
export function verifyAuditExport(lines: (string | Line)[]): ExportVerifyReport {
  const docs: Line[] = [];
  for (const l of lines) {
    if (typeof l === 'string') {
      if (!l.trim()) continue;
      docs.push(JSON.parse(l) as Line);
    } else docs.push(l);
  }
  const header = docs.find((d) => d.type === 'header') as ExportHeader | undefined;
  const proof = docs.find((d) => d.type === 'proof') as ExportProof | undefined;
  const events = docs.filter((d) => d.type === 'event');
  let redacted = 0;
  let prev: string | null = header?.first?.prev_hash ?? null;
  let lastSeq: number | null = null;
  for (const e of events) {
    const seq = Number(e.seq);
    if (lastSeq != null && seq !== lastSeq + 1) return { status: 'broken', events: events.length, redacted, checkpoint: null, brokenAt: { seq, reason: `sequence ${lastSeq + 1} is missing` } };
    if (prev != null && e.prev_hash !== prev) return { status: 'broken', events: events.length, redacted, checkpoint: null, brokenAt: { seq, reason: 'prev_hash does not equal the hash before it' } };
    if (e.redacted === true) redacted++;
    else if (hashOfExportedEvent(e) !== e.hash) return { status: 'broken', events: events.length, redacted, checkpoint: null, brokenAt: { seq, reason: 'the hash does not cover the event' } };
    prev = String(e.hash);
    lastSeq = seq;
  }
  if (!proof?.checkpoint) return { status: 'unsigned', events: events.length, redacted, checkpoint: null, reason: 'the export carries no signed checkpoint' };
  const c = proof.checkpoint;
  if (!events.length) return { status: 'unsigned', events: 0, redacted, checkpoint: { seq: c.seq, hash: c.hash }, reason: 'the window holds no events' };
  if (c.seq !== lastSeq) return { status: 'broken', events: events.length, redacted, checkpoint: { seq: c.seq, hash: c.hash }, brokenAt: { seq: lastSeq!, reason: `the checkpoint signs sequence ${c.seq}, the export ends at ${lastSeq}` } };
  if (c.hash !== prev) return { status: 'broken', events: events.length, redacted, checkpoint: { seq: c.seq, hash: c.hash }, brokenAt: { seq: lastSeq!, reason: 'the last hash does not equal the checkpoint hash' } };
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(c.payload) as Record<string, unknown>;
  } catch {
    return { status: 'broken', events: events.length, redacted, checkpoint: { seq: c.seq, hash: c.hash }, brokenAt: { seq: c.seq, reason: 'the checkpoint payload is not JSON' } };
  }
  if (payload.seq !== c.seq || payload.hash !== c.hash || payload.tenant !== c.tenant || payload.ts !== c.ts) return { status: 'broken', events: events.length, redacted, checkpoint: { seq: c.seq, hash: c.hash }, brokenAt: { seq: c.seq, reason: 'the signed payload does not name this checkpoint' } };
  if (header && header.events !== events.length) return { status: 'broken', events: events.length, redacted, checkpoint: { seq: c.seq, hash: c.hash }, brokenAt: { seq: lastSeq!, reason: `the header counts ${header.events} events, the file holds ${events.length}` } };
  return { status: 'verified', events: events.length, redacted, checkpoint: { seq: c.seq, hash: c.hash } };
}
