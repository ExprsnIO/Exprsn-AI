import { ulid } from 'ulid';
import type { Db } from '../db/knex.js';
import { canonicalJson } from '../crypto/index.js';
import type { Kms } from '../platform/kms.js';
import type { BlobStore } from '../platform/blob.js';
import type { AuditLog } from './chain.js';

export interface Checkpoint {
  id: string;
  tenant_id: string;
  seq: number;
  hash: string;
  ts: number;
  key: string;
  signature: string;
  blob_key: string | null;
  created_by: string;
}

export interface VerifyReport {
  status: 'verified' | 'broken';
  checked: number;
  head: string;
  brokenAt?: { seq: number; id: string; reason: string };
  checkpoints: { checked: number; failed: { seq: number; reason: string }[] };
  lastGoodCheckpoint: { seq: number; hash: string; ts: number } | null;
}

const fromRow = (r: Record<string, unknown>): Checkpoint => ({ ...(r as unknown as Checkpoint), seq: Number(r.seq), ts: Number(r.ts) });

/**
 * Signed checkpoints of the audit chain. A checkpoint records (tenant, seq, head hash, time), HMAC-signed by the KMS
 * with a key the database cannot reach, and a copy is written to the blob store. Verification recomputes the chain
 * and checks every checkpoint against it: rewriting history, even consistently, breaks at the first checkpoint.
 */
export class AuditCheckpoints {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditLog,
    private readonly kms: Kms,
    private readonly blobs: BlobStore,
    private readonly keyName: string
  ) {}

  private payload(c: Pick<Checkpoint, 'tenant_id' | 'seq' | 'hash' | 'ts'>): string {
    return canonicalJson({ tenant: c.tenant_id, seq: c.seq, hash: c.hash, ts: c.ts });
  }

  /** Signs the current head. Returns null when the chain is empty or the head is already checkpointed. */
  async create(tenantId: string, by: string): Promise<Checkpoint | null> {
    const head = await this.audit.head(tenantId);
    if (!head) return null;
    const last = await this.latest(tenantId);
    if (last && last.seq >= head.seq) return null;
    const c: Checkpoint = { id: ulid(), tenant_id: tenantId, seq: head.seq, hash: head.hash, ts: Date.now(), key: this.keyName, signature: '', blob_key: null, created_by: by };
    c.signature = await this.kms.hmac(this.keyName, this.payload(c));
    c.blob_key = `audit-checkpoints/${tenantId}/${String(c.seq).padStart(12, '0')}.json`;
    await this.blobs.put(c.blob_key, Buffer.from(JSON.stringify({ ...c, payload: this.payload(c) }, null, 2)), 'application/json');
    try {
      await this.db('audit_checkpoints').insert(c);
    } catch {
      return null; // another instance signed the same head
    }
    return c;
  }

  async latest(tenantId: string): Promise<Checkpoint | null> {
    const r = await this.db('audit_checkpoints').where({ tenant_id: tenantId }).orderBy('seq', 'desc').first();
    return r ? fromRow(r) : null;
  }

  async list(tenantId: string, limit = 50): Promise<Checkpoint[]> {
    return (await this.db('audit_checkpoints').where({ tenant_id: tenantId }).orderBy('seq', 'desc').limit(limit)).map(fromRow);
  }

  async verify(tenantId: string): Promise<VerifyReport> {
    const chain = await this.audit.verify(tenantId);
    const cps = (await this.db('audit_checkpoints').where({ tenant_id: tenantId }).orderBy('seq', 'asc')).map(fromRow);
    const failed: { seq: number; reason: string }[] = [];
    let lastGood: VerifyReport['lastGoodCheckpoint'] = null;
    for (const c of cps) {
      let reason: string | null = null;
      if (!(await this.kms.verifyHmac(c.key, this.payload(c), c.signature).catch(() => false))) reason = 'signature does not verify';
      else if (chain.brokenAt && c.seq >= chain.brokenAt.seq) reason = 'after the break in the chain';
      else {
        const at = await this.audit.hashAt(tenantId, c.seq);
        if (at !== c.hash) reason = at ? 'the chain at this sequence has a different hash' : 'the event at this sequence is missing';
      }
      if (reason) failed.push({ seq: c.seq, reason });
      else if (!failed.length) lastGood = { seq: c.seq, hash: c.hash, ts: c.ts };
    }
    const status = chain.status === 'broken' || failed.length ? 'broken' : 'verified';
    const brokenAt = chain.brokenAt ?? (failed[0] ? { seq: failed[0].seq, id: '', reason: `checkpoint: ${failed[0].reason}` } : undefined);
    return { status, checked: chain.checked, head: chain.head, ...(brokenAt ? { brokenAt } : {}), checkpoints: { checked: cps.length, failed }, lastGoodCheckpoint: lastGood };
  }
}
