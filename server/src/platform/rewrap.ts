import { randomBytes } from 'node:crypto';
import { canonicalJson } from '../crypto/index.js';
import { lines, openFromBlob, sealToBlob } from '../ops/restore.js';
import type { Config } from '../config/index.js';
import type { Db } from '../db/knex.js';
import type { BlobStore } from './blob.js';
import { LocalKms, OpenBaoKms, type Kms } from './kms.js';

/**
 * Key-encryption-key re-wrap (B-407). A KEK change (a new DATA_KEY, or moving between the local KMS and OpenBao)
 * does not re-encrypt any content: every tenant data key is unwrapped with the previous KEK and wrapped again with
 * the new one, and what the KMS signed directly (audit checkpoints, backup manifests and their archive keys) is
 * verified with the previous key and signed again with the new one. Each row is committed on its own and a row
 * the new KEK already opens is skipped, so a run can be interrupted and repeated.
 *
 * Until the re-wrap is done, `withPrevious` lets the running servers read with either key: unwrap and verify try
 * the current KMS first, then the previous one; everything new is wrapped and signed with the current one only.
 */

/** The previous KMS from DATA_KEY_PREVIOUS / KMS_PREVIOUS_PROVIDER, or null when none is configured. */
export function createPreviousKms(cfg: Config): Kms | null {
  const kind = cfg.KMS_PREVIOUS_PROVIDER ?? (cfg.DATA_KEY_PREVIOUS ? 'local' : null);
  if (kind === 'openbao') {
    if (cfg.KMS_PROVIDER === 'openbao') return null; // the same transit engine: OpenBao re-wraps its own versions
    const token = cfg.OPENBAO_TOKEN as string;
    return new OpenBaoKms(cfg.OPENBAO_ADDR as string, () => token, cfg.OPENBAO_TRANSIT_MOUNT, cfg.OPENBAO_CA_FILE);
  }
  if (kind === 'local') {
    const key = cfg.DATA_KEY_PREVIOUS ?? (cfg.KMS_PROVIDER === 'openbao' ? cfg.DATA_KEY : undefined);
    return key ? new LocalKms(key) : null;
  }
  return null;
}

/**
 * The current KMS, reading with the previous one as a fallback. Built by prototype delegation, so every other
 * method (including any added to `Kms` later) is the current KMS's own.
 */
export function withPrevious(current: Kms, previous: Kms | null): Kms {
  if (!previous) return current;
  const k = Object.create(current) as Kms & { previousKms: Kms };
  k.previousKms = previous;
  k.unwrap = async (name, wrapped, aad) => {
    try {
      return await current.unwrap.call(k, name, wrapped, aad);
    } catch (err) {
      try {
        return await previous.unwrap(name, wrapped, aad);
      } catch {
        throw err;
      }
    }
  };
  k.verifyHmac = async (name, data, mac) => (await current.verifyHmac.call(k, name, data, mac).catch(() => false)) || (await previous.verifyHmac(name, data, mac).catch(() => false));
  return k;
}

/** The KMS a read should fall back to, if `kms` came from `withPrevious`. */
export const previousOf = (kms: Kms): Kms | null => (kms as Kms & { previousKms?: Kms }).previousKms ?? null;

export interface RewrapReport {
  target: string;
  dataKeys: { total: number; rewrapped: number; already: number; destroyed: number; failed: { id: string; scope: string; version: number; error: string }[] };
  checkpoints: { total: number; resigned: number; already: number; failed: { id: string; error: string }[] };
  backups: { total: number; rewrapped: number; already: number; failed: { id: string; error: string }[] };
  verified: boolean;
}

interface KeyRow {
  id: string;
  tenant_id: string;
  version: number;
  kms: string;
  key_name: string;
  wrapped: string | null;
  state: string;
}

const dekAad = (r: Pick<KeyRow, 'tenant_id' | 'version'>) => `dek:${r.tenant_id}:${r.version}`;

async function firstOk<T>(attempts: (() => Promise<T>)[]): Promise<T> {
  let last: unknown = new Error('No key opened it');
  for (const a of attempts) {
    try {
      return await a();
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

/**
 * Re-wraps every data key, re-signs every checkpoint and re-wraps every backup manifest from `previous` to
 * `target`. `kekName` maps a key scope to its KEK name under the target (the prefix may differ). Then verifies that
 * every row opens with `target` alone.
 */
export async function rewrapAll(o: { db: Db; blobs: BlobStore; target: Kms; previous: Kms; kekName: (scope: string) => string; progress?: (msg: string) => void }): Promise<RewrapReport> {
  const { db, target, previous } = o;
  const report: RewrapReport = {
    target: target.kind,
    dataKeys: { total: 0, rewrapped: 0, already: 0, destroyed: 0, failed: [] },
    checkpoints: { total: 0, resigned: 0, already: 0, failed: [] },
    backups: { total: 0, rewrapped: 0, already: 0, failed: [] },
    verified: false
  };

  // 1. Tenant (and platform) data keys.
  const rows = (await db('tenant_keys').orderBy('tenant_id').orderBy('version')) as KeyRow[];
  report.dataKeys.total = rows.length;
  for (const row of rows) {
    if (!row.wrapped) {
      report.dataKeys.destroyed++;
      continue;
    }
    const aad = dekAad(row);
    const name = o.kekName(row.tenant_id);
    if (row.kms === target.kind && row.key_name === name && (await target.unwrap(name, row.wrapped, aad).then(() => true, () => false))) {
      report.dataKeys.already++;
      continue;
    }
    try {
      const dek = await firstOk([() => previous.unwrap(row.key_name, row.wrapped!, aad), () => target.unwrap(row.key_name, row.wrapped!, aad)]);
      await target.ensureKey(name);
      const wrapped = await target.wrap(name, dek, aad);
      const back = await target.unwrap(name, wrapped, aad);
      if (!back.equals(dek)) throw new Error('The re-wrapped key does not open to the same key');
      // Only if nobody changed the row meanwhile (another run, or a destroy).
      const n = await db('tenant_keys').where({ id: row.id, wrapped: row.wrapped }).update({ wrapped, kms: target.kind, key_name: name });
      if (n) report.dataKeys.rewrapped++;
      else report.dataKeys.already++;
    } catch (err) {
      report.dataKeys.failed.push({ id: row.id, scope: row.tenant_id, version: Number(row.version), error: (err as Error).message.slice(0, 300) });
    }
    o.progress?.(`data key ${row.tenant_id} v${row.version}`);
  }

  // 2. Audit checkpoints: verified with the previous key, signed again with the target.
  const cps = (await db('audit_checkpoints').select('id', 'tenant_id', 'seq', 'hash', 'ts', 'key', 'signature', 'blob_key', 'created_by')) as { id: string; tenant_id: string; seq: number; hash: string; ts: number; key: string; signature: string; blob_key: string | null; created_by: string }[];
  report.checkpoints.total = cps.length;
  for (const c of cps) {
    const payload = canonicalJson({ tenant: c.tenant_id, seq: Number(c.seq), hash: c.hash, ts: Number(c.ts) });
    if (await target.verifyHmac(c.key, payload, c.signature).catch(() => false)) {
      report.checkpoints.already++;
      continue;
    }
    try {
      if (!(await previous.verifyHmac(c.key, payload, c.signature).catch(() => false))) throw new Error('The signature does not verify with the previous key either');
      await target.ensureKey(c.key);
      const signature = await target.hmac(c.key, payload);
      await db('audit_checkpoints').where({ id: c.id, signature: c.signature }).update({ signature });
      if (c.blob_key) await o.blobs.put(c.blob_key, Buffer.from(JSON.stringify({ id: c.id, tenant_id: c.tenant_id, seq: Number(c.seq), hash: c.hash, ts: Number(c.ts), key: c.key, signature, blob_key: c.blob_key, created_by: c.created_by, payload }, null, 2)), 'application/json');
      report.checkpoints.resigned++;
    } catch (err) {
      report.checkpoints.failed.push({ id: c.id, error: (err as Error).message.slice(0, 300) });
    }
  }

  // 3. Backups: the archive holds audit checkpoints signed with the previous key, so the database archive is
  // rewritten (streamed) with those rows signed again, under a fresh archive key wrapped by the target; the blob
  // archive's key is re-wrapped; and the manifest is signed again.
  const backups = (await db('platform_backups').where({ state: 'succeeded' }).whereNotNull('manifest_key').select('id', 'manifest_key')) as { id: string; manifest_key: string }[];
  report.backups.total = backups.length;
  for (const b of backups) {
    try {
      const raw = await o.blobs.get(b.manifest_key);
      if (!raw) throw new Error('The manifest is missing from the blob store');
      type Part = { blob: string; sha256: string; bytes: number; iv: string; tag: string; kek: string; wrappedKey: string };
      const doc = JSON.parse(raw.toString('utf8')) as { manifest: { id: string; archive: Part; blobs?: Part | null }; signature: string };
      const m = doc.manifest;
      if (await target.verifyHmac(m.archive.kek, canonicalJson(m), doc.signature).catch(() => false)) {
        report.backups.already++;
        continue;
      }
      if (!(await previous.verifyHmac(m.archive.kek, canonicalJson(m), doc.signature).catch(() => false))) throw new Error('The manifest signature does not verify with the previous key either');
      await target.ensureKey(m.archive.kek);
      const oldBlob = m.archive.blob;
      const dek = await previous.unwrap(m.archive.kek, m.archive.wrappedKey, `backup:${m.id}`);
      const src = await openFromBlob({ blobs: o.blobs, key: oldBlob, dek, iv: m.archive.iv, tag: m.archive.tag, aad: `exprsn-backup:${m.id}`, sha256: m.archive.sha256, gunzip: true });
      const resign = async function* (): AsyncGenerator<Buffer> {
        for await (const line of lines(src.stream)) {
          if (line.startsWith('["audit_checkpoints",')) {
            const [t, row] = JSON.parse(line) as [string, { tenant_id: string; seq: number; hash: string; ts: number; key: string; signature: string }];
            const payload = canonicalJson({ tenant: row.tenant_id, seq: Number(row.seq), hash: row.hash, ts: Number(row.ts) });
            if (await previous.verifyHmac(row.key, payload, row.signature).catch(() => false)) {
              await target.ensureKey(row.key);
              row.signature = await target.hmac(row.key, payload);
            }
            yield Buffer.from(JSON.stringify([t, row]) + '\n');
          } else yield Buffer.from(line + '\n');
        }
      };
      const newDek = randomBytes(32);
      const iv = randomBytes(12);
      const newBlob = `platform/backups/${m.id}.r${Date.now()}.bin`;
      const sealed = await sealToBlob({ blobs: o.blobs, key: newBlob, plain: resign(), gzip: true, dek: newDek, iv, aad: `exprsn-backup:${m.id}` });
      await src.done();
      m.archive = { ...m.archive, blob: newBlob, sha256: sealed.sha256, bytes: sealed.bytes, iv: iv.toString('base64'), tag: sealed.tag, wrappedKey: await target.wrap(m.archive.kek, newDek, `backup:${m.id}`) };
      if (m.blobs) {
        const bdek = await previous.unwrap(m.blobs.kek, m.blobs.wrappedKey, `backup-blobs:${m.id}`);
        m.blobs.wrappedKey = await target.wrap(m.blobs.kek, bdek, `backup-blobs:${m.id}`);
      }
      const signature = await target.hmac(m.archive.kek, canonicalJson(m));
      await o.blobs.put(b.manifest_key, Buffer.from(JSON.stringify({ manifest: m, signature }, null, 2)), 'application/json');
      await db('platform_backups').where({ id: b.id }).update({ signature: signature.slice(0, 200), blob_key: newBlob });
      await o.blobs.delete(oldBlob);
      report.backups.rewrapped++;
    } catch (err) {
      report.backups.failed.push({ id: b.id, error: (err as Error).message.slice(0, 300) });
    }
  }

  // 4. Verify with the target alone.
  let ok = !report.dataKeys.failed.length && !report.checkpoints.failed.length && !report.backups.failed.length;
  for (const row of (await db('tenant_keys').whereNotNull('wrapped')) as KeyRow[]) {
    if (!(await target.unwrap(row.key_name, row.wrapped!, dekAad(row)).then(() => true, () => false))) {
      ok = false;
      if (!report.dataKeys.failed.some((f) => f.id === row.id)) report.dataKeys.failed.push({ id: row.id, scope: row.tenant_id, version: Number(row.version), error: 'Does not open with the new key' });
    }
  }
  report.verified = ok;
  return report;
}
