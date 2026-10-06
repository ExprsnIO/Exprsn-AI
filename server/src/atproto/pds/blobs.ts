import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { Cid, CODEC_RAW } from '../encoding.js';
import { decryptStream, encryptStream, newFileKey, packKey, unpackKey } from '../../files/crypt.js';
import { clamStream } from '../../files/scan.js';
import type { Services } from '../../services.js';
import { XrpcError, type PdsAccountRow, type PdsActor, type PdsService } from './service.js';

/*
 * Blobs (B-2903): `com.atproto.repo.uploadBlob`, `com.atproto.sync.getBlob` and `listBlobs`, on the blob store and
 * through the attachment quarantine.
 *
 * An upload streams into quarantine, sealed as file content is (`files/crypt.ts`: 64 KiB AES-256-GCM segments under a
 * per-blob key that the tenant key seals), while its size is counted against the tenant's limit and its SHA-256 taken
 * for the CID (CIDv1, raw codec). Then, before the upload is answered: the type is read from the bytes (never from the
 * name or the declared type) and must be one of the tenant's accepted types; ClamAV sees every byte (INSTREAM) when it
 * is configured; only then does the blob move out of quarantine and become `ready`. A blob that fails either check is
 * deleted and recorded as `rejected`, and a record cannot use it; when ClamAV cannot be reached the upload is refused
 * (503) rather than let through. Only a `ready` blob of a repo that is not taken down is ever served.
 *
 * Blobs no record uses are deleted a day after their upload or their last use (`pds.trim`).
 */

export interface BlobRow {
  id: string;
  account_id: string;
  tenant_id: string;
  cid: string;
  mime: string;
  size: number;
  state: 'quarantined' | 'scanning' | 'ready' | 'rejected';
  reason: string | null;
  blob_key: string | null;
  sealed_key: string | null;
  taken_down: boolean;
  created_at: number;
  scanned_at: number | null;
}

const blobFrom = (r: Record<string, unknown>): BlobRow => ({
  ...(r as unknown as BlobRow),
  size: Number(r.size),
  taken_down: r.taken_down === true || r.taken_down === 1 || r.taken_down === '1' || r.taken_down === 't',
  created_at: Number(r.created_at),
  scanned_at: r.scanned_at == null ? null : Number(r.scanned_at)
});

/** The MIME type of a blob from its first bytes (images and MP4 video), or null. */
export function sniffBlobType(head: Buffer): string | null {
  const text = (a: number, b: number) => head.subarray(a, b).toString('latin1');
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') return 'image/webp';
  if (text(0, 6) === 'GIF87a' || text(0, 6) === 'GIF89a') return 'image/gif';
  if (text(4, 8) === 'ftyp') {
    const brand = text(8, 12);
    if (['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V '].includes(brand)) return 'video/mp4';
    if (brand === 'qt  ') return 'video/quicktime';
  }
  return null;
}

/** Whether a MIME type is in an accepted list (entries may be `type/*`). */
export const typeAccepted = (mime: string, accepted: readonly string[]): boolean => accepted.some((a) => a === mime || a === '*/*' || (a.endsWith('/*') && mime.startsWith(a.slice(0, -1))));

export class PdsBlobs {
  constructor(
    private readonly pds: PdsService,
    private readonly s: () => Services
  ) {}

  private get db() {
    return this.s().db;
  }

  async byCid(accountId: string, cid: string): Promise<BlobRow | undefined> {
    const r = (await this.db('pds_blobs').where({ account_id: accountId, cid }).first()) as Record<string, unknown> | undefined;
    return r ? blobFrom(r) : undefined;
  }

  private aad = (id: string) => `pds-blob:${id}`;

  /** Uploads, checks and stores a blob; returns the blob reference a record uses. */
  async upload(by: PdsActor, a: PdsAccountRow, body: AsyncIterable<Buffer | Uint8Array>, o: { declaredBytes: number | null }): Promise<{ $type: 'blob'; ref: Cid; mimeType: string; size: number }> {
    const s = this.s();
    // An account migrating in takes its blobs before it is activated.
    if (a.state !== 'active' && !(a.state === 'deactivated' && a.migrating)) throw new XrpcError(400, a.state === 'takendown' ? 'AccountTakedown' : 'AccountDeactivated', a.state === 'takendown' ? 'Account has been taken down' : 'Account is deactivated');
    const limits = this.pds.limits(await this.pds.hosting(a.tenant_id));
    const tooLarge = () => new XrpcError(400, 'BlobTooLarge', `A blob is at most ${limits.maxBytes} bytes here.`);
    if (o.declaredBytes != null && o.declaredBytes > limits.maxBytes) throw tooLarge();
    const id = ulid();
    const key = newFileKey();
    const quarantine = `pds/${a.tenant_id}/quarantine/${id}`;
    const hash = createHash('sha256');
    let size = 0;
    let head = Buffer.alloc(0);
    const counted = async function* (): AsyncGenerator<Buffer> {
      for await (const c of body) {
        const b = Buffer.isBuffer(c) ? c : Buffer.from(c.buffer, c.byteOffset, c.byteLength);
        size += b.length;
        if (size > limits.maxBytes) throw tooLarge();
        if (head.length < 64) head = Buffer.concat([head, b.subarray(0, 64 - head.length)]);
        hash.update(b);
        yield b;
      }
    };
    try {
      await s.blobs.putStream(quarantine, encryptStream(counted(), key, this.aad(id)), 'application/octet-stream');
    } catch (err) {
      await s.blobs.delete(quarantine).catch(() => undefined);
      throw err;
    }
    const cid = Cid.create(CODEC_RAW, hash.digest());
    const mime = sniffBlobType(head);
    const existing = await this.byCid(a.id, cid.toString());
    if (existing && existing.state === 'ready' && !existing.taken_down) {
      await s.blobs.delete(quarantine).catch(() => undefined);
      return { $type: 'blob', ref: cid, mimeType: existing.mime, size: existing.size };
    }
    const sealedKey = await s.keys.sealBytes(a.tenant_id, packKey(key), `pds-blob-key:${id}`);
    const now = Date.now();
    if (existing) {
      // The same bytes again after a rejection: checked again (the scanner's signatures may have changed).
      await this.db('pds_blobs').where({ id: existing.id }).delete();
      if (existing.blob_key) await s.blobs.delete(existing.blob_key).catch(() => undefined);
    }
    await this.db('pds_blobs').insert({ id, account_id: a.id, tenant_id: a.tenant_id, cid: cid.toString(), mime: mime ?? 'application/octet-stream', size, state: 'scanning', reason: null, blob_key: quarantine, sealed_key: sealedKey, taken_down: false, created_at: now, scanned_at: null });
    const reject = async (reason: string, error: string) => {
      await s.blobs.delete(quarantine).catch(() => undefined);
      await this.db('pds_blobs').where({ id }).update({ state: 'rejected', reason: reason.slice(0, 500), blob_key: null, sealed_key: null, scanned_at: Date.now() });
      await this.pds.audit(by, 'pds.blob.rejected', { account: a.id, did: a.did, blob: cid.toString() }, { reason, size });
      return new XrpcError(400, error, reason);
    };
    if (!mime || !typeAccepted(mime, limits.types)) throw await reject(`The blob is ${mime ?? 'of a type that could not be recognised'}; accepted here: ${limits.types.join(', ')}.`, 'InvalidMimeType');
    let scanner = 'type check only (no ClamAV configured)';
    if (s.cfg.CLAMD_HOST) {
      let found: string | null;
      try {
        found = await clamStream(s.cfg.CLAMD_HOST, s.cfg.CLAMD_PORT, decryptStream((await s.blobs.getStream(quarantine))!.stream as AsyncIterable<Buffer>, key, this.aad(id)));
      } catch (err) {
        // Fail closed: nothing unscanned is kept.
        await s.blobs.delete(quarantine).catch(() => undefined);
        await this.db('pds_blobs').where({ id }).delete();
        s.log.warn({ err }, 'pds: ClamAV could not scan a blob');
        throw new XrpcError(503, 'ScannerUnavailable', 'The malware scanner is unavailable; try the upload again later.');
      }
      if (found) throw await reject(`Malware detected: ${found}`, 'BlobRejected');
      scanner = 'clamav: clean';
    }
    const store = `pds/${a.tenant_id}/store/${id}`;
    const got = await s.blobs.getStream(quarantine);
    if (!got) throw new Error('The quarantined blob is missing.');
    await s.blobs.putStream(store, got.stream as AsyncIterable<Buffer>, 'application/octet-stream');
    await s.blobs.delete(quarantine);
    await this.db('pds_blobs').where({ id }).update({ state: 'ready', blob_key: store, scanned_at: Date.now() });
    await this.pds.audit(by, 'pds.blob.stored', { account: a.id, did: a.did, blob: cid.toString() }, { mime, size, scanner });
    return { $type: 'blob', ref: cid, mimeType: mime, size };
  }

  /** The bytes of a ready blob, decrypted as they are read; null when there is none to serve. */
  async open(a: PdsAccountRow, cid: string): Promise<{ blob: BlobRow; stream: AsyncIterable<Buffer> } | null> {
    const b = await this.byCid(a.id, cid);
    if (!b || b.state !== 'ready' || b.taken_down || !b.blob_key || !b.sealed_key) return null;
    const key = unpackKey(await this.s().keys.openBytes(a.tenant_id, b.sealed_key, `pds-blob-key:${b.id}`));
    const got = await this.s().blobs.getStream(b.blob_key);
    if (!got) return null;
    return { blob: b, stream: decryptStream(got.stream as AsyncIterable<Buffer>, key, this.aad(b.id)) };
  }

  /** `com.atproto.sync.listBlobs`: the CIDs of ready blobs the repo's records use, in CID order. */
  async list(a: PdsAccountRow, o: { limit: number; cursor?: string | undefined; since?: string | undefined }): Promise<{ cids: string[]; cursor?: string }> {
    const q = this.db('pds_blob_refs as r').join('pds_blobs as b', (j) => j.on('b.account_id', 'r.account_id').andOn('b.cid', 'r.cid')).where({ 'r.account_id': a.id, 'b.state': 'ready' }).distinct('r.cid').orderBy('r.cid', 'asc').limit(o.limit);
    if (o.cursor) q.andWhere('r.cid', '>', o.cursor);
    if (o.since) q.andWhere('r.rev', '>', o.since);
    const cids = ((await q) as { cid: string }[]).map((r) => r.cid);
    return { cids, ...(cids.length === o.limit ? { cursor: cids.at(-1)! } : {}) };
  }

  /** The blobs the repo's records use that are not here (a migration in uploads them next). */
  async missing(a: PdsAccountRow, o: { limit: number; cursor?: string | undefined }): Promise<{ blobs: { cid: string; recordUri: string }[]; cursor?: string }> {
    const q = this.db('pds_blob_refs as r')
      .leftJoin('pds_blobs as b', (j) => j.on('b.account_id', 'r.account_id').andOn('b.cid', 'r.cid'))
      .join('pds_records as p', (j) => j.on('p.account_id', 'r.account_id').andOn('p.path_hash', 'r.path_hash'))
      .where({ 'r.account_id': a.id })
      .andWhere((w) => w.whereNull('b.id').orWhereNot('b.state', 'ready'))
      .orderBy('r.cid', 'asc')
      .limit(o.limit)
      .select('r.cid', 'p.collection', 'p.rkey');
    if (o.cursor) q.andWhere('r.cid', '>', o.cursor);
    const rows = (await q) as { cid: string; collection: string; rkey: string }[];
    return { blobs: rows.map((r) => ({ cid: r.cid, recordUri: `at://${a.did}/${r.collection}/${r.rkey}` })), ...(rows.length === o.limit ? { cursor: rows.at(-1)!.cid } : {}) };
  }

  /** Deletes blobs no record uses that were uploaded (or last used) before `before`, and rejected ones' rows. */
  async sweep(before: number): Promise<number> {
    const rows = (await this.db('pds_blobs as b')
      .leftJoin('pds_blob_refs as r', (j) => j.on('r.account_id', 'b.account_id').andOn('r.cid', 'b.cid'))
      .whereNull('r.cid')
      .andWhere('b.created_at', '<', before)
      .select('b.id', 'b.blob_key')
      .limit(1000)) as { id: string; blob_key: string | null }[];
    for (const r of rows) {
      if (r.blob_key) await this.s().blobs.delete(r.blob_key).catch(() => undefined);
      await this.db('pds_blobs').where({ id: r.id }).delete();
    }
    return rows.length;
  }
}
