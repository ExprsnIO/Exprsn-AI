import { cborDecode, cborEncode, type CborValue } from '../cbor.js';
import { Cid } from '../encoding.js';
import { Limiter } from '../../platform/ratelimit.js';
import type { Services } from '../../services.js';
import { writeCar } from './car.js';
import { blobRefs, dataToJson, DataModelError, jsonToData } from './lexjson.js';
import { DEFAULT_LEXICONS, LexiconError, validateRecord, validateRecordKey } from './lexicon.js';
import { buildMst, coveringProof, keyHeight, loadMst, type MstTree } from './mst.js';
import { recordProofCar, repoCar, signCommit } from './repo.js';
import { sequence, type SeqInput } from './sequencer.js';
import { sha256hex, signingRef, XrpcError, type PdsAccountRow, type PdsActor, type PdsService } from './service.js';
import { isNsid, isRecordKey } from './syntax.js';
import { nextTid } from './tid.js';

/*
 * Repositories (B-2902): `com.atproto.repo` writes and reads, and the `com.atproto.sync` exports.
 *
 * A write (`createRecord`, `putRecord`, `deleteRecord`, `applyWrites`) is one commit. Each record is read from its
 * JSON form into the data model, checked against its lexicon (`validate: true` requires a known lexicon, unset checks
 * known ones only, `false` skips), its blobs must be this account's and have passed the scan, and it must fit in
 * MAX_RECORD_BYTES. The tree is rebuilt from the record list (`mst.ts`), the commit signed with the account's key in
 * the signer or OpenBao, and then one transaction swaps the head (compare-and-swap on `rev`, so two writers to one repo
 * cannot both win; the loser starts again), stores the new records and nodes, deletes the blocks nothing points at any
 * more, and sequences the `#commit` event. That event carries the new blocks and, as sync 1.1 asks, the covering
 * proof of every operation, the previous tree root (`prevData`) and each changed record's previous CID (`prev`), so a
 * relay can check the commit against the tree it already had.
 *
 * Reads answer `RepoNotFound`, `RepoTakendown` or `RepoDeactivated` when the repo is gone, taken down or deactivated.
 */

export const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_WRITES = 200;
const MAX_EVENT_BYTES = 2_000_000;

export interface WriteInput {
  action: 'create' | 'update' | 'delete';
  collection: string;
  rkey?: string | undefined;
  value?: unknown;
  /** The record's current CID must be this (null: it must not exist). */
  swapRecord?: string | null | undefined;
}

export interface WriteResult {
  action: 'create' | 'update' | 'delete';
  uri: string;
  cid?: string;
  validationStatus?: 'valid' | 'unknown';
}

interface Prepared {
  action: 'create' | 'update' | 'delete';
  collection: string;
  rkey: string;
  key: string;
  cid: Cid | null;
  bytes: Buffer | null;
  prev: string | null;
  blobs: string[];
  validationStatus?: 'valid' | 'unknown';
}

interface Block {
  cid: string;
  kind: 'commit' | 'mst' | 'record';
  bytes: Buffer;
}

class Retry extends Error {}

const isDeadlock = (err: unknown): boolean => {
  const e = err as { code?: unknown; errno?: unknown } | null;
  return !!e && (e.code === 'ER_LOCK_DEADLOCK' || e.errno === 1213 || e.code === '40P01' || e.code === 'SQLITE_BUSY');
};

export class RepoStore {
  private limiter: Limiter | null = null;

  constructor(
    private readonly pds: PdsService,
    private readonly s: () => Services
  ) {}

  private get db() {
    return this.s().db;
  }

  /** Refuses reads of a repo that is gone, taken down or deactivated, with the protocol's error names. */
  assertReadable(a: PdsAccountRow | undefined, did?: string): asserts a is PdsAccountRow {
    if (!a) throw new XrpcError(400, 'RepoNotFound', `Could not find repo for DID: ${did ?? 'unknown'}`);
    if (a.state === 'takendown') throw new XrpcError(400, 'RepoTakendown', `Repo has been takendown: ${a.did}`);
    if (a.state === 'deactivated') throw new XrpcError(400, 'RepoDeactivated', `Repo has been deactivated: ${a.did}`);
  }

  private assertWritable(a: PdsAccountRow): void {
    if (a.state === 'takendown') throw new XrpcError(400, 'AccountTakedown', 'Account has been taken down');
    if (a.state !== 'active') throw new XrpcError(400, 'AccountDeactivated', 'Account is deactivated');
    if (!a.commit_cid || !a.rev || !a.data_cid) throw new XrpcError(400, 'RepoNotFound', 'The repo has no commit yet.');
  }

  // ---------- commits ----------

  /** The first commit of a new account's empty repo, with its events (B-2901). */
  async initialCommit(a: PdsAccountRow): Promise<{ commitCid: string; rev: string; dataCid: string; blocks: Block[]; events: SeqInput[] }> {
    const tree = buildMst([]);
    const rev = nextTid();
    const signed = await signCommit({ did: a.did, version: 3, data: tree.root.cid, rev, prev: null }, (bytes) => this.pds.sign(signingRef(a), bytes));
    const blocks: Block[] = [
      { cid: tree.root.cid.toString(), kind: 'mst', bytes: tree.root.bytes },
      { cid: signed.cid.toString(), kind: 'commit', bytes: signed.bytes }
    ];
    const events: SeqInput[] = [
      { did: a.did, type: 'commit', body: { repo: a.did, commit: signed.cid, rev, since: null, blocks: writeCar(signed.cid, [[signed.cid, signed.bytes], [tree.root.cid, tree.root.bytes]]), ops: [], rebase: false, tooBig: false, blobs: [] } },
      { did: a.did, type: 'sync', body: { did: a.did, rev, blocks: writeCar(signed.cid, [[signed.cid, signed.bytes]]) } }
    ];
    return { commitCid: signed.cid.toString(), rev, dataCid: tree.root.cid.toString(), blocks, events };
  }

  /** A `#sync` event for the repo as it is (an activated migration, a repo whose history was replaced). */
  async sequenceSync(a: PdsAccountRow): Promise<void> {
    if (!a.commit_cid || !a.rev) return;
    const commit = await this.block(a.id, a.commit_cid);
    if (!commit) return;
    const cid = Cid.parse(a.commit_cid);
    await this.db.transaction(async (trx) => {
      await sequence(trx, [{ did: a.did, type: 'sync', body: { did: a.did, rev: a.rev!, blocks: writeCar(cid, [[cid, commit]]) } }]);
    });
    this.pds.announce();
  }

  /** The records of a repo as MST leaves (`collection/rkey` → CID). */
  async leafMap(accountId: string): Promise<Map<string, string>> {
    const rows = (await this.db('pds_records').where({ account_id: accountId }).select('collection', 'rkey', 'cid')) as { collection: string; rkey: string; cid: string }[];
    return new Map(rows.map((r) => [`${r.collection}/${r.rkey}`, r.cid]));
  }

  private async prepare(a: PdsAccountRow, writes: WriteInput[], current: Map<string, string>, validate: boolean | undefined): Promise<Prepared[]> {
    const out: Prepared[] = [];
    const seen = new Set<string>();
    for (const [i, w] of writes.entries()) {
      const where = writes.length > 1 ? ` (write ${i + 1})` : '';
      if (!isNsid(w.collection)) throw new XrpcError(400, 'InvalidRequest', `Invalid collection${where}: ${String(w.collection).slice(0, 100)}`);
      const rkey = w.rkey ?? (w.action === 'create' ? nextTid() : undefined);
      if (!rkey || !isRecordKey(rkey)) throw new XrpcError(400, 'InvalidRequest', `Invalid record key${where}: ${String(rkey ?? '').slice(0, 100)}`);
      const key = `${w.collection}/${rkey}`;
      if (seen.has(key)) throw new XrpcError(400, 'InvalidRequest', `The same record is written twice in one commit: ${key}`);
      seen.add(key);
      const prev = current.get(key) ?? null;
      if (w.swapRecord !== undefined && (w.swapRecord ?? null) !== prev) throw new XrpcError(400, 'InvalidSwap', `Record was at ${prev ?? 'null'}`);
      if (w.action === 'delete') {
        if (!prev) throw new XrpcError(400, 'InvalidRequest', `Could not find record${where}: ${key}`);
        out.push({ action: 'delete', collection: w.collection, rkey, key, cid: null, bytes: null, prev, blobs: [] });
        continue;
      }
      if (w.action === 'create' && prev) throw new XrpcError(400, 'InvalidRequest', `Record already exists${where}: ${key}`);
      if (w.action === 'update' && !prev) throw new XrpcError(400, 'InvalidRequest', `Could not find record${where}: ${key}`);
      let data: CborValue;
      try {
        data = jsonToData(w.value);
      } catch (err) {
        throw new XrpcError(400, 'InvalidRequest', `Invalid record${where}: ${(err as Error).message}`);
      }
      const rec = data as Record<string, CborValue>;
      if (rec.$type === undefined) {
        // A record without $type is given the collection's (as the reference PDS does for its own writes).
        rec.$type = w.collection;
      }
      if (rec.$type !== w.collection) throw new XrpcError(400, 'InvalidRequest', `Invalid $type${where}: expected ${w.collection}, got ${String(rec.$type).slice(0, 100)}`);
      let validationStatus: 'valid' | 'unknown' = 'unknown';
      if (validate !== false) {
        try {
          validationStatus = validateRecord(DEFAULT_LEXICONS, w.collection, rec);
          if (validationStatus === 'valid') validateRecordKey(DEFAULT_LEXICONS, w.collection, rkey);
        } catch (err) {
          if (err instanceof LexiconError || err instanceof DataModelError) throw new XrpcError(400, 'InvalidRecord', `Invalid ${w.collection} record${where}: ${err.message}`);
          throw err;
        }
        if (validate === true && validationStatus === 'unknown') throw new XrpcError(400, 'InvalidRequest', `Lexicon not found: ${w.collection}`);
      }
      const bytes = cborEncode(rec);
      if (bytes.length > MAX_RECORD_BYTES) throw new XrpcError(400, 'RecordTooBig', `A record is at most ${MAX_RECORD_BYTES} bytes${where}.`);
      const refs = blobRefs(rec);
      for (const b of refs) {
        const row = (await this.db('pds_blobs').where({ account_id: a.id, cid: b.cid.toString() }).first('state', 'mime', 'size', 'taken_down')) as { state: string; mime: string; size: number | string; taken_down: unknown } | undefined;
        if (!row || row.state !== 'ready') throw new XrpcError(400, 'BlobNotFound', `Could not find blob${where}: ${b.cid.toString()} (upload it first with com.atproto.repo.uploadBlob; a blob that failed its scan cannot be used)`);
        if (row.mime !== b.mimeType || Number(row.size) !== b.size) throw new XrpcError(400, 'InvalidRequest', `The blob ${b.cid.toString()} is ${row.mime}, ${String(row.size)} bytes; the record says ${b.mimeType}, ${b.size}${where}.`);
      }
      out.push({ action: prev ? 'update' : 'create', collection: w.collection, rkey, key, cid: Cid.ofCbor(bytes), bytes, prev, blobs: refs.map((b) => b.cid.toString()), validationStatus });
    }
    return out;
  }

  private writeLimiter(): Limiter {
    return (this.limiter ??= new Limiter(this.s().counters, 'pds-writes', this.s().cfg.PDS_WRITES_PER_HOUR, 3600_000));
  }

  /**
   * One commit of writes. `swapCommit` must be the head's CID when given. Returns the new head and, per write, the
   * record's URI, CID and validation status.
   */
  async applyWrites(by: PdsActor, account: PdsAccountRow, writes: WriteInput[], o: { validate?: boolean | undefined; swapCommit?: string | undefined } = {}): Promise<{ commit: { cid: string; rev: string }; results: WriteResult[] }> {
    if (!writes.length) throw new XrpcError(400, 'InvalidRequest', 'No writes.');
    if (writes.length > MAX_WRITES) throw new XrpcError(400, 'InvalidRequest', `Too many writes. Max: ${MAX_WRITES}`);
    const l = await this.writeLimiter().consume(account.id, writes.length);
    if (!l.allowed) throw new XrpcError(429, 'RateLimitExceeded', 'Too many writes to this repo; slow down.', { 'Retry-After': String(Math.max(1, Math.ceil(l.resetMs / 1000))) });
    // One commit at a time per repo on this instance; across instances the compare-and-swap on rev decides.
    return this.serially(account.id, async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.commitOnce(by, account.id, writes, o);
        } catch (err) {
          // A lost compare-and-swap, or a deadlock the database broke (MySQL 1213, PostgreSQL 40P01): start again.
          if ((err instanceof Retry || isDeadlock(err)) && attempt < 6) continue;
          if (err instanceof Retry) throw new XrpcError(409, 'Conflict', 'The repo changed while this commit was made; try again.');
          throw err;
        }
      }
    });
  }

  private readonly queues = new Map<string, Promise<unknown>>();

  private serially<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.queues.set(key, tail);
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return run;
  }

  private async commitOnce(by: PdsActor, accountId: string, writes: WriteInput[], o: { validate?: boolean | undefined; swapCommit?: string | undefined }) {
    const a = await this.pds.accountById(accountId);
    if (!a) throw new XrpcError(400, 'RepoNotFound', 'Could not find repo');
    this.assertWritable(a);
    if (o.swapCommit !== undefined && o.swapCommit !== a.commit_cid) throw new XrpcError(400, 'InvalidSwap', `Commit was at ${a.commit_cid}`);
    const current = await this.leafMap(a.id);
    const ops = await this.prepare(a, writes, current, o.validate);
    const next = new Map(current);
    for (const op of ops) {
      if (op.action === 'delete') next.delete(op.key);
      else next.set(op.key, op.cid!.toString());
    }
    const tree = buildMst([...next].map(([key, cid]) => ({ key, value: Cid.parse(cid) })), { checkKeys: false });
    const stored = new Set(((await this.db('pds_blocks').where({ account_id: a.id, kind: 'mst' }).select('cid')) as { cid: string }[]).map((r) => r.cid));
    const newNodes = [...tree.blocks].filter(([cid]) => !stored.has(cid));
    const removedNodes = [...stored].filter((cid) => !tree.blocks.has(cid));
    const proof = new Map<string, Buffer>();
    for (const op of ops) coveringProof(tree, op.key, proof);
    const records = new Map<string, Buffer>();
    for (const op of ops) if (op.cid && op.bytes) records.set(op.cid.toString(), op.bytes);

    const rev = nextTid(a.rev);
    const signed = await signCommit({ did: a.did, version: 3, data: tree.root.cid, rev, prev: null }, (bytes) => this.pds.sign(signingRef(a), bytes));
    const car = writeCar(signed.cid, [[signed.cid, signed.bytes], ...newNodes, ...proof, ...records]);
    if (car.length > MAX_EVENT_BYTES) throw new XrpcError(400, 'InvalidRequest', 'Too many writes. Max event size: 2MB');
    const body: Record<string, CborValue | undefined> = {
      repo: a.did,
      commit: signed.cid,
      rev,
      since: a.rev,
      blocks: car,
      ops: ops.map((op) => ({ action: op.action, path: op.key, cid: op.cid, ...(op.prev ? { prev: Cid.parse(op.prev) } : {}) })),
      prevData: Cid.parse(a.data_cid!),
      rebase: false,
      tooBig: false,
      blobs: []
    };
    const now = Date.now();
    await this.db.transaction(async (trx) => {
      const swapped = await trx('pds_accounts').where({ id: a.id, rev: a.rev }).update({ commit_cid: signed.cid.toString(), rev, data_cid: tree.root.cid.toString(), updated_at: now });
      if (!swapped) throw new Retry();
      // Only rows that exist are deleted (a delete that matches nothing takes gap locks on MySQL).
      const replaced = ops.filter((op) => op.prev).map((op) => sha256hex(op.key));
      if (replaced.length) await trx('pds_records').where({ account_id: a.id }).whereIn('path_hash', replaced).delete();
      const live = ops.filter((op) => op.action !== 'delete');
      if (live.length) {
        await trx('pds_records').insert(live.map((op) => ({ account_id: a.id, path_hash: sha256hex(op.key), coll_hash: sha256hex(op.collection), collection: op.collection, rkey: op.rkey, cid: op.cid!.toString(), height: keyHeight(op.key), rev, created_at: now, updated_at: now })));
      }
      const blocks: Block[] = [{ cid: signed.cid.toString(), kind: 'commit', bytes: signed.bytes }, ...newNodes.map(([cid, bytes]): Block => ({ cid, kind: 'mst', bytes })), ...[...records].map(([cid, bytes]): Block => ({ cid, kind: 'record', bytes }))];
      for (const b of blocks) await trx('pds_blocks').insert({ account_id: a.id, cid: b.cid, kind: b.kind, size: b.bytes.length, data: b.bytes.toString('base64'), rev }).onConflict(['account_id', 'cid']).ignore();
      const gone = [...removedNodes, a.commit_cid!];
      // A record block goes when no record (under any key) still has its CID.
      for (const op of ops) if (op.prev && op.prev !== op.cid?.toString() && !(await trx('pds_records').where({ account_id: a.id, cid: op.prev }).first('cid'))) gone.push(op.prev);
      for (let i = 0; i < gone.length; i += 200) await trx('pds_blocks').where({ account_id: a.id }).whereIn('cid', gone.slice(i, i + 200)).delete();
      if (replaced.length) await trx('pds_blob_refs').where({ account_id: a.id }).whereIn('path_hash', replaced).delete();
      const refs = live.flatMap((op) => op.blobs.map((cid) => ({ account_id: a.id, cid, path_hash: sha256hex(op.key), rev })));
      if (refs.length) await trx('pds_blob_refs').insert(refs);
      await sequence(trx, [{ did: a.did, type: 'commit', body }]);
    });
    this.pds.announce();
    await this.pds.audit(by, 'pds.repo.committed', { account: a.id, did: a.did }, { rev, commit: signed.cid.toString(), creates: ops.filter((x) => x.action === 'create').length, updates: ops.filter((x) => x.action === 'update').length, deletes: ops.filter((x) => x.action === 'delete').length, collections: [...new Set(ops.map((x) => x.collection))].slice(0, 20) });
    return {
      commit: { cid: signed.cid.toString(), rev },
      results: ops.map((op): WriteResult => ({ action: op.action, uri: `at://${a.did}/${op.key}`, ...(op.cid ? { cid: op.cid.toString(), validationStatus: op.validationStatus ?? 'unknown' } : {}) }))
    };
  }

  // ---------- reads ----------

  async block(accountId: string, cid: string): Promise<Buffer | null> {
    const r = (await this.db('pds_blocks').where({ account_id: accountId, cid }).first('data')) as { data: string } | undefined;
    return r ? Buffer.from(r.data, 'base64') : null;
  }

  /** `com.atproto.repo.getRecord`: the record's JSON form, or null. With `cid`, only that version. */
  async getRecord(a: PdsAccountRow, collection: string, rkey: string, cid?: string): Promise<{ uri: string; cid: string; value: unknown } | null> {
    if (!isNsid(collection) || !isRecordKey(rkey)) return null;
    const r = (await this.db('pds_records').where({ account_id: a.id, path_hash: sha256hex(`${collection}/${rkey}`) }).first('cid')) as { cid: string } | undefined;
    if (!r || (cid && cid !== r.cid)) return null;
    const bytes = await this.block(a.id, r.cid);
    if (!bytes) return null;
    return { uri: `at://${a.did}/${collection}/${rkey}`, cid: r.cid, value: dataToJson(cborDecode(bytes)) };
  }

  /** `com.atproto.repo.listRecords`: newest record key first (or oldest with `reverse`), paged by record key. */
  async listRecords(a: PdsAccountRow, collection: string, o: { limit: number; cursor?: string | undefined; reverse?: boolean | undefined }): Promise<{ records: { uri: string; cid: string; value: unknown }[]; cursor?: string }> {
    if (!isNsid(collection)) return { records: [] };
    const q = this.db('pds_records').where({ account_id: a.id, coll_hash: sha256hex(collection) }).orderBy('rkey', o.reverse ? 'asc' : 'desc').limit(o.limit).select('rkey', 'cid');
    if (o.cursor) q.andWhere('rkey', o.reverse ? '>' : '<', o.cursor);
    const rows = (await q) as { rkey: string; cid: string }[];
    const blocks = new Map<string, Buffer>();
    for (let i = 0; i < rows.length; i += 200) {
      const got = (await this.db('pds_blocks').where({ account_id: a.id }).whereIn('cid', rows.slice(i, i + 200).map((r) => r.cid)).select('cid', 'data')) as { cid: string; data: string }[];
      for (const g of got) blocks.set(g.cid, Buffer.from(g.data, 'base64'));
    }
    const records = rows.filter((r) => blocks.has(r.cid)).map((r) => ({ uri: `at://${a.did}/${collection}/${r.rkey}`, cid: r.cid, value: dataToJson(cborDecode(blocks.get(r.cid)!)) }));
    return { records, ...(rows.length === o.limit ? { cursor: rows.at(-1)!.rkey } : {}) };
  }

  async collections(accountId: string): Promise<string[]> {
    return ((await this.db('pds_records').where({ account_id: accountId }).distinct('collection').orderBy('collection')) as { collection: string }[]).map((r) => r.collection);
  }

  /** The current tree, read from the stored blocks and checked (canonical shape, every node present). */
  async tree(a: PdsAccountRow): Promise<{ tree: MstTree; blocks: Map<string, Buffer> }> {
    const rows = (await this.db('pds_blocks').where({ account_id: a.id }).select('cid', 'data')) as { cid: string; data: string }[];
    const blocks = new Map(rows.map((r) => [r.cid, Buffer.from(r.data, 'base64')]));
    return { tree: loadMst(blocks, Cid.parse(a.data_cid!)), blocks };
  }

  /** `com.atproto.sync.getRepo`: the whole repo as a CAR file, or (with `since`) the blocks added after that rev. */
  async exportCar(a: PdsAccountRow, since?: string): Promise<Buffer> {
    const commitCid = Cid.parse(a.commit_cid!);
    const commitBytes = (await this.block(a.id, a.commit_cid!))!;
    if (since) {
      const rows = (await this.db('pds_blocks').where({ account_id: a.id }).andWhere('rev', '>', since).whereNot({ cid: a.commit_cid! }).select('cid', 'data')) as { cid: string; data: string }[];
      return writeCar(commitCid, [[commitCid, commitBytes], ...rows.map((r): [string, Buffer] => [r.cid, Buffer.from(r.data, 'base64')])]);
    }
    const { tree, blocks } = await this.tree(a);
    return repoCar(commitCid, commitBytes, tree, (cid) => blocks.get(cid.toString()));
  }

  /** `com.atproto.sync.getRecord`: the commit, the MST path and the record (or the proof that it is absent). */
  async recordCar(a: PdsAccountRow, collection: string, rkey: string): Promise<Buffer> {
    const { tree, blocks } = await this.tree(a);
    const key = `${collection}/${rkey}`;
    const value = tree.leaves.find((l) => l.key === key)?.value;
    return recordProofCar(Cid.parse(a.commit_cid!), blocks.get(a.commit_cid!)!, tree, key, value ? (blocks.get(value.toString()) ?? null) : null);
  }

  /** `com.atproto.sync.getBlocks`: the blocks asked for, as a CAR file without a root; refuses when one is missing. */
  async blocksCar(a: PdsAccountRow, cids: string[]): Promise<Buffer> {
    const rows = (await this.db('pds_blocks').where({ account_id: a.id }).whereIn('cid', cids).select('cid', 'data')) as { cid: string; data: string }[];
    const found = new Map(rows.map((r) => [r.cid, Buffer.from(r.data, 'base64')]));
    const missing = cids.filter((c) => !found.has(c));
    if (missing.length) throw new XrpcError(400, 'BlockNotFound', `Could not find cids: ${missing.slice(0, 10).join(', ')}`);
    return writeCar(null, cids.map((c): [string, Buffer] => [c, found.get(c)!]));
  }

  /**
   * Replaces an inactive account's repo with an imported one (a migration in, B-2905): the records as they were, under
   * a new commit signed with this account's key (`rev` after the imported one), and the blob references the records
   * make. The account must be deactivated, so nothing is sequenced until it is activated (which sends `#sync`).
   */
  async replaceRepo(by: PdsActor, a: PdsAccountRow, records: { key: string; value: Cid; bytes: Buffer }[], importedRev: string): Promise<{ cid: string; rev: string; records: number }> {
    if (a.state !== 'deactivated') throw new XrpcError(400, 'InvalidRequest', 'A repo is imported into a deactivated account (activate it afterwards).');
    const tree = buildMst(records.map((r) => ({ key: r.key, value: r.value })));
    const rev = nextTid(a.rev && a.rev > importedRev ? a.rev : importedRev);
    const signed = await signCommit({ did: a.did, version: 3, data: tree.root.cid, rev, prev: null }, (bytes) => this.pds.sign(signingRef(a), bytes));
    const now = Date.now();
    await this.db.transaction(async (trx) => {
      const swapped = await trx('pds_accounts').where({ id: a.id, state: 'deactivated' }).update({ commit_cid: signed.cid.toString(), rev, data_cid: tree.root.cid.toString(), updated_at: now });
      if (!swapped) throw new XrpcError(409, 'Conflict', 'The account changed meanwhile.');
      await trx('pds_records').where({ account_id: a.id }).delete();
      await trx('pds_blocks').where({ account_id: a.id }).delete();
      await trx('pds_blob_refs').where({ account_id: a.id }).delete();
      const put = async (cid: string, kind: Block['kind'], bytes: Buffer) => trx('pds_blocks').insert({ account_id: a.id, cid, kind, size: bytes.length, data: bytes.toString('base64'), rev }).onConflict(['account_id', 'cid']).ignore();
      await put(signed.cid.toString(), 'commit', signed.bytes);
      for (const [cid, bytes] of tree.blocks) await put(cid, 'mst', bytes);
      for (const r of records) {
        await put(r.value.toString(), 'record', r.bytes);
        const slash = r.key.indexOf('/');
        await trx('pds_records').insert({ account_id: a.id, path_hash: sha256hex(r.key), coll_hash: sha256hex(r.key.slice(0, slash)), collection: r.key.slice(0, slash), rkey: r.key.slice(slash + 1), cid: r.value.toString(), height: keyHeight(r.key), rev, created_at: now, updated_at: now });
        const refs = [...new Set(blobRefs(cborDecode(r.bytes)).map((b) => b.cid.toString()))];
        if (refs.length) await trx('pds_blob_refs').insert(refs.map((cid) => ({ account_id: a.id, cid, path_hash: sha256hex(r.key), rev })));
      }
    });
    await this.pds.audit(by, 'pds.repo.imported', { account: a.id, did: a.did }, { rev, commit: signed.cid.toString(), records: records.length, importedRev });
    return { cid: signed.cid.toString(), rev, records: records.length };
  }
}
