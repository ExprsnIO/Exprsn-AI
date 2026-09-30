import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { PassThrough, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import type { Db } from '../db/knex.js';
import type { BlobStore, ByteSource } from '../platform/blob.js';
import { entryHeader, TAR_END, tarPadding, tarStream } from './tar.js';

/*
 * Streaming pieces of backups and restores (B-410): the dump is read in pages and written through gzip and
 * AES-256-GCM straight into the blob store, and a restore reads it back the same way, so neither holds a database
 * or a blob store in memory.
 */

const PAGE = 1000;

/** Primary-key columns of a table, in key order (empty when it has none). */
export async function primaryKey(db: Db, client: string, table: string): Promise<string[]> {
  if (client === 'sqlite') return ((await db.raw(`PRAGMA table_info(${JSON.stringify(table)})`)) as { name: string; pk: number }[]).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  if (client === 'pg') {
    const r = await db.raw('SELECT a.attname AS name FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = ?::regclass AND i.indisprimary', [table]);
    return (r.rows as { name: string }[]).map((x) => x.name);
  }
  const [rows] = (await db.raw("SELECT column_name AS name FROM information_schema.key_column_usage WHERE table_schema = database() AND table_name = ? AND constraint_name = 'PRIMARY' ORDER BY ordinal_position", [table])) as [{ name: string }[]];
  return rows.map((x) => x.name);
}

/** Every row of a table, a page at a time: keyset pages on a one-column key, offset pages on a composite one. */
export async function* tableRows(db: Db, client: string, table: string): AsyncGenerator<Record<string, unknown>> {
  const pk = await primaryKey(db, client, table);
  if (pk.length === 1) {
    const col = pk[0]!;
    let last: unknown = undefined;
    for (;;) {
      const q = db(table).select('*').orderBy(col).limit(PAGE);
      if (last !== undefined) q.where(col, '>', last as string);
      const rows = (await q) as Record<string, unknown>[];
      yield* rows;
      if (rows.length < PAGE) return;
      last = rows[rows.length - 1]![col];
    }
  }
  if (pk.length > 1 || client === 'sqlite') {
    for (let offset = 0; ; offset += PAGE) {
      const q = db(table).select('*').limit(PAGE).offset(offset);
      if (pk.length) for (const c of pk) q.orderBy(c);
      else q.orderByRaw('rowid');
      const rows = (await q) as Record<string, unknown>[];
      yield* rows;
      if (rows.length < PAGE) return;
    }
  }
  // No key on PostgreSQL or MySQL: one read (such tables are small bookkeeping tables in this schema).
  yield* (await db(table).select('*')) as Record<string, unknown>[];
}

/** A pass-through that hashes and counts what flows through it. */
export function tap(): { stream: Transform; digest: () => string; bytes: () => number } {
  const h = createHash('sha256');
  let n = 0;
  let d: string | null = null;
  const stream = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      h.update(chunk);
      n += chunk.length;
      cb(null, chunk);
    }
  });
  return { stream, digest: () => (d ??= h.digest('hex')), bytes: () => n };
}

/**
 * Writes `plain` through optional gzip and AES-256-GCM into the blob store. Returns the sha256 and size of what was
 * encrypted (the archive), the sealed size and the tag.
 */
export async function sealToBlob(o: { blobs: BlobStore; key: string; plain: ByteSource; gzip: boolean; dek: Buffer; iv: Buffer; aad: string }): Promise<{ sha256: string; plainBytes: number; bytes: number; tag: string }> {
  const cipher = createCipheriv('aes-256-gcm', o.dek, o.iv);
  cipher.setAAD(Buffer.from(o.aad));
  const archive = tap();
  const sealed = tap();
  const src = Readable.from(o.plain);
  const chain = o.gzip ? src.pipe(createGzip()) : src;
  const out = pipeline(chain, archive.stream, cipher, sealed.stream);
  const put = o.blobs.putStream(o.key, sealed.stream as AsyncIterable<Buffer>, 'application/octet-stream');
  // If the store fails, stop the producer too (nothing would read the sealed stream any more).
  put.catch((err: Error) => sealed.stream.destroy(err));
  await Promise.all([out, put]);
  return { sha256: archive.digest(), plainBytes: archive.bytes(), bytes: sealed.bytes(), tag: cipher.getAuthTag().toString('base64') };
}

/**
 * Reads a sealed archive back: decrypts, checks the digest of the archive, optionally gunzips. The GCM tag and the
 * digest are only known at the end: `done()` throws if either fails, so a caller that writes what it reads must
 * treat everything as provisional until then (a restore runs in a transaction and commits after `done`).
 */
export async function openFromBlob(o: { blobs: BlobStore; key: string; dek: Buffer; iv: string; tag: string; aad: string; sha256: string; gunzip: boolean }): Promise<{ stream: AsyncIterable<Buffer>; done: () => Promise<void>; sealedBytes: number }> {
  const got = await o.blobs.getStream(o.key);
  if (!got) throw new Error(`The archive ${o.key} is missing from the blob store.`);
  const decipher = createDecipheriv('aes-256-gcm', o.dek, Buffer.from(o.iv, 'base64'));
  decipher.setAAD(Buffer.from(o.aad));
  decipher.setAuthTag(Buffer.from(o.tag, 'base64'));
  const archive = tap();
  const out = new PassThrough();
  // pipeline destroys every stream on an error, so a reader of `out` sees the failure instead of waiting forever.
  const p = o.gunzip ? pipeline(got.stream, decipher, archive.stream, createGunzip(), out) : pipeline(got.stream, decipher, archive.stream, out);
  let failed: Error | null = null;
  const settled = p.then(
    () => undefined,
    (err: Error) => {
      failed = err;
    }
  );
  const plain = (err: unknown) => new Error(/authenticate/i.test((err as Error).message) ? 'The archive does not authenticate: it was changed or the key is wrong.' : (err as Error).message);
  return {
    stream: (async function* () {
      try {
        for await (const c of out as AsyncIterable<Buffer>) yield c;
      } catch (err) {
        throw plain(err);
      }
    })(),
    sealedBytes: got.size,
    done: async () => {
      await settled;
      if (failed) throw plain(failed);
      const digest = archive.digest();
      if (digest !== o.sha256) throw new Error(`The archive digest ${digest.slice(0, 12)}… does not match the manifest.`);
    }
  };
}

/** Lines of text from a byte stream. */
export async function* lines(source: AsyncIterable<Buffer>): AsyncGenerator<string> {
  let rest = '';
  for await (const c of source) {
    rest += c.toString('utf8');
    let nl: number;
    while ((nl = rest.indexOf('\n')) >= 0) {
      yield rest.slice(0, nl);
      rest = rest.slice(nl + 1);
    }
  }
  if (rest) yield rest;
}

/** Column types of a table on PostgreSQL (for values whose JSON form differs by engine, like booleans). */
async function columnTypes(db: Db, client: string, table: string): Promise<Map<string, string>> {
  if (client !== 'pg') return new Map();
  const r = await db.raw('SELECT column_name AS c, data_type AS t FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?', [table]);
  return new Map((r.rows as { c: string; t: string }[]).map((x) => [x.c, x.t]));
}

/** A dumped value as the target engine binds it. */
export function bindValue(v: unknown, client: string, type?: string): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    const o = v as { $b64?: string };
    if (typeof o.$b64 === 'string' && Object.keys(o).length === 1) return Buffer.from(o.$b64, 'base64');
    if (type === 'json' || type === 'jsonb') return JSON.stringify(v);
    return JSON.stringify(v);
  }
  if (typeof v === 'boolean') return client === 'pg' && type === 'boolean' ? v : v ? 1 : 0;
  if (typeof v === 'number' && client === 'pg' && type === 'boolean') return v !== 0;
  if (typeof v === 'string' && client === 'pg' && type === 'boolean') return v === '1' || v === 'true';
  return v;
}

/**
 * Restores the rows of a dump (`[table, row]` lines after a header line) into `db`, a batch at a time. Tables the
 * target schema lacks are skipped and reported. Returns the rows restored per table.
 */
export async function restoreRows(db: Db, client: string, src: AsyncIterable<string>, schema: Set<string>, expectHeader: { id: string }, onTable?: (table: string, rows: number) => Promise<void>): Promise<{ counts: Map<string, number>; skipped: string[] }> {
  const counts = new Map<string, number>();
  const skipped = new Set<string>();
  let table: string | null = null;
  let batch: Record<string, unknown>[] = [];
  let types = new Map<string, string>();
  let first = true;
  const flush = async () => {
    if (!table || !batch.length) return;
    const cols = Object.keys(batch[0]!).length || 1;
    const chunk = Math.max(1, Math.min(200, Math.floor((client === 'sqlite' ? 30_000 : 60_000) / cols)));
    for (let i = 0; i < batch.length; i += chunk) await db(table).insert(batch.slice(i, i + chunk));
    counts.set(table, (counts.get(table) ?? 0) + batch.length);
    batch = [];
  };
  for await (const line of src) {
    if (first) {
      first = false;
      const head = JSON.parse(line || '{}') as { format?: string; id?: string };
      if (head.format !== 'exprsn-backup/1' || head.id !== expectHeader.id) throw new Error('The archive header does not match the backup.');
      continue;
    }
    if (!line) continue;
    const [t, row] = JSON.parse(line) as [string, Record<string, unknown>];
    if (t !== table) {
      await flush();
      if (table) await onTable?.(table, counts.get(table) ?? 0);
      table = t;
      types = schema.has(t) ? await columnTypes(db, client, t) : new Map();
      if (!counts.has(t)) counts.set(t, 0);
    }
    if (!schema.has(t)) {
      skipped.add(t);
      continue;
    }
    batch.push(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, bindValue(v, client, types.get(k))])));
    if (batch.length >= 500) await flush();
  }
  await flush();
  if (table) await onTable?.(table, counts.get(table) ?? 0);
  return { counts, skipped: [...skipped] };
}

/**
 * Foreign keys are checked at commit, not per row, while a restore runs (the dump is in table-name order).
 * SQLite: `defer_foreign_keys` inside the transaction; MySQL: the session's checks off inside the transaction;
 * PostgreSQL: the constraints are made deferrable first (the application owns its tables) and put back after.
 */
export async function deferForeignKeys(trx: Db, client: string): Promise<void> {
  if (client === 'sqlite') await trx.raw('PRAGMA defer_foreign_keys = ON');
  else if (client === 'mysql') await trx.raw('SET FOREIGN_KEY_CHECKS = 0');
  else await trx.raw('SET CONSTRAINTS ALL DEFERRED');
}

export async function pgForeignKeys(db: Db): Promise<{ table: string; name: string }[]> {
  const r = await db.raw("SELECT conrelid::regclass::text AS t, conname AS n FROM pg_constraint WHERE contype = 'f' AND connamespace = current_schema()::regnamespace");
  return (r.rows as { t: string; n: string }[]).map((x) => ({ table: x.t, name: x.n }));
}

export async function setPgDeferrable(db: Db, fks: { table: string; name: string }[], deferrable: boolean): Promise<void> {
  for (const f of fks) await db.raw(`ALTER TABLE ?? ALTER CONSTRAINT ?? ${deferrable ? 'DEFERRABLE INITIALLY DEFERRED' : 'NOT DEFERRABLE'}`, [f.table.replace(/^"|"$/g, ''), f.name]);
}

/** Rows in every table of the application schema: a restore refuses a database that is not empty. */
export async function rowCounts(db: Db, tables: string[]): Promise<{ table: string; rows: number }[]> {
  const out: { table: string; rows: number }[] = [];
  for (const t of tables) {
    const [r] = await db(t).count({ n: '*' });
    out.push({ table: t, rows: Number(r?.n ?? 0) });
  }
  return out;
}

/** The blob store as a tar stream (paths are object keys), skipping keys under any of `exclude`. */
export async function* blobTar(blobs: BlobStore, exclude: string[], counter: { objects: number; bytes: number }): AsyncGenerator<Buffer> {
  for await (const o of blobs.list('')) {
    if (exclude.some((p) => o.key.startsWith(p))) continue;
    const got = await blobs.getStream(o.key);
    if (!got) continue; // deleted since the listing
    yield entryHeader(o.key, got.size);
    let n = 0;
    for await (const c of got.stream as AsyncIterable<Buffer>) {
      n += c.length;
      if (n > got.size) throw new Error(`${o.key} grew while it was being backed up.`);
      yield c;
    }
    if (n !== got.size) throw new Error(`${o.key} changed while it was being backed up.`);
    yield tarPadding(got.size);
    counter.objects++;
    counter.bytes += got.size;
  }
  yield TAR_END;
}

/** Writes every object of a blob tar into `blobs`. Returns how many. */
export async function restoreBlobTar(blobs: BlobStore, source: AsyncIterable<Buffer>): Promise<{ objects: number; bytes: number }> {
  let objects = 0;
  let bytes = 0;
  for await (const e of tarStream(source)) {
    const r = await blobs.putStream(e.path, e.body());
    objects++;
    bytes += r.bytes;
  }
  return { objects, bytes };
}
