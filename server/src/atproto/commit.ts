import type { KeyObject } from 'node:crypto';
import { cborDecode } from './cbor.js';
import { decompressPublicKey, parseMultikey, verifySignature, type Curve } from './crypto.js';
import type { DidResolver } from './did.js';
import { base58Decode, Cid, CODEC_DAG_CBOR } from './encoding.js';
import { blockMatches } from './pds/car.js';
import { mstLookup, type MstLookup } from './pds/mst.js';
import { commitSigningBytes } from './pds/repo.js';

/*
 * Relay commit verification (B-3604; https://atproto.com/specs/repository and /specs/sync).
 *
 * A subscribeRepos `#commit` frame names the repo (its DID), the CID of a signed commit object and a CAR of blocks:
 * the commit itself, the Merkle search tree (MST) nodes the change touched, and the records. Before a record from a
 * relay is believed, the commit is checked here:
 *
 *  1. every block used hashes to its CID (a CAR file only claims its CIDs);
 *  2. the commit is `{ did, version: 3, data, rev, prev, sig }` (version 2 accepted), `did` is the frame's repo and
 *     `rev` the frame's rev;
 *  3. `sig` is a compact, low-S ECDSA-SHA256 signature over the DAG-CBOR of the commit without `sig`, by the
 *     `#atproto` key in the repo's DID document, resolved through the service URL checks with caching (`did.ts`).
 *     When it fails, the document is fetched once more (at most once a minute per DID) in case the key rotated;
 *  4. each operation is proven against the signed tree root `data`: a create or update by walking the MST to its
 *     path and finding exactly the operation's CID (and the record block hashing to it), a delete by walking to where
 *     the path would be and finding nothing. A node the walk needs that is not in the CAR leaves the operation
 *     unproven.
 *
 * Anything that fails drops the whole commit; the firehose consumer audits it (as inbound labels are, B-1611).
 *
 * The repository format is the PDS's (`pds/`): the MST walk (`mstLookup`), its node format and key layers are in
 * `pds/mst.ts`, the CAR reader and `blockMatches` in `pds/car.ts`, and the signed bytes of a commit
 * (`commitSigningBytes`) in `pds/repo.ts`. This file holds what only a relay needs: the frame's proof shape, the
 * `#atproto` key from a DID document, and the lenient commit check (version 2 accepted, unknown fields signed as sent).
 */

export interface CommitOp {
  action: 'create' | 'update' | 'delete';
  /** `<collection>/<rkey>` */
  path: string;
  cid: string | null;
}

/** What a `#commit` frame carries for verification (`firehose-frames.ts` builds it). */
export interface CommitProof {
  repo: string;
  rev: string | null;
  commit: Cid | null;
  blocks: Map<string, Buffer>;
  ops: CommitOp[];
  tooBig: boolean;
  /** The CAR could not be read. */
  unreadable: boolean;
}

export type CommitFailure = 'commit' | 'repo' | 'resolve' | 'document' | 'signature' | 'proof' | 'too-big';

export type CommitCheck = { ok: true; rev: string } | { ok: false; reason: CommitFailure; detail: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v) && !(v instanceof Cid);

class Unproven extends Error {}

/** A block from the CAR whose bytes match its CID, decoded; `null` when the CAR does not carry it. */
function block(blocks: Map<string, Buffer>, cid: Cid): unknown {
  const bytes = blocks.get(cid.toString());
  if (!bytes) return null;
  if (cid.codec !== CODEC_DAG_CBOR || !blockMatches(cid, bytes)) throw new Unproven(`block ${cid.toString().slice(0, 20)}… does not match its CID`);
  try {
    return cborDecode(bytes);
  } catch (err) {
    throw new Unproven(`block ${cid.toString().slice(0, 20)}… is not DAG-CBOR: ${(err as Error).message}`);
  }
}

/** The repo signing key (`#atproto`) from a DID document: Multikey, or the older secp256k1/P-256 2019 suites. */
export function repoKeyFromDocument(doc: unknown, did: string): { curve: Curve; key: KeyObject; multikey: string } {
  const d = doc as { id?: unknown; verificationMethod?: unknown } | null;
  if (!d || typeof d !== 'object' || d.id !== did) throw new Error('The DID document does not describe this DID');
  const vms = Array.isArray(d.verificationMethod) ? (d.verificationMethod as Record<string, unknown>[]) : [];
  const vm = vms.find((v) => v && (v.id === '#atproto' || v.id === `${did}#atproto`));
  if (!vm || typeof vm.publicKeyMultibase !== 'string') throw new Error('The DID document has no #atproto key');
  const mb = vm.publicKeyMultibase;
  if (vm.type === 'EcdsaSecp256k1VerificationKey2019' || vm.type === 'EcdsaSecp256r1VerificationKey2019') {
    if (!mb.startsWith('z') || mb.length > 100) throw new Error('The #atproto key is not base58btc');
    const curve: Curve = vm.type === 'EcdsaSecp256k1VerificationKey2019' ? 'secp256k1' : 'p256';
    return { curve, key: decompressPublicKey(curve, base58Decode(mb.slice(1))), multikey: mb };
  }
  const k = parseMultikey(mb);
  return { curve: k.curve, key: k.key, multikey: mb };
}

const REFRESH_MS = 60_000;

/** Verifies `#commit` frames against the repo's DID key (see the comment at the top). */
export class CommitVerifier {
  private readonly refreshed = new Map<string, number>();

  constructor(private readonly resolver: Pick<DidResolver, 'resolve'>) {}

  private async key(did: string, fresh: boolean): Promise<{ curve: Curve; key: KeyObject } | CommitCheck> {
    let doc: unknown;
    try {
      doc = await this.resolver.resolve(did, fresh);
    } catch (err) {
      return { ok: false, reason: 'resolve', detail: `${did} could not be resolved: ${(err as Error).message}`.slice(0, 300) };
    }
    try {
      return repoKeyFromDocument(doc, did);
    } catch (err) {
      return { ok: false, reason: 'document', detail: `${did}: ${(err as Error).message}`.slice(0, 300) };
    }
  }

  async verify(p: CommitProof): Promise<CommitCheck> {
    const fail = (reason: CommitFailure, detail: string): CommitCheck => ({ ok: false, reason, detail: detail.slice(0, 300) });
    if (p.tooBig) return fail('too-big', 'The relay sent the commit without its blocks (tooBig).');
    if (p.unreadable) return fail('commit', 'The blocks are not a readable CAR file.');
    if (!p.commit) return fail('commit', 'The frame names no commit.');
    let commit: Record<string, unknown>;
    try {
      const v = block(p.blocks, p.commit);
      if (v === null) return fail('commit', 'The commit block is not in the CAR file.');
      if (!isObj(v)) return fail('commit', 'The commit is not a map.');
      commit = v;
    } catch (err) {
      return fail('commit', (err as Error).message);
    }
    const { did, version, data, rev, prev, sig } = commit;
    if (typeof did !== 'string' || (version !== 3 && version !== 2) || !(data instanceof Cid) || typeof rev !== 'string' || !(prev === null || prev === undefined || prev instanceof Cid) || !Buffer.isBuffer(sig)) return fail('commit', 'The commit object is malformed.');
    if (did !== p.repo) return fail('repo', `The commit is for ${did.slice(0, 200)}, not the frame's repo.`);
    if (p.rev !== null && rev !== p.rev) return fail('commit', "The commit's rev is not the frame's rev.");

    const bytes = commitSigningBytes(commit);
    let k = await this.key(did, false);
    if ('ok' in k) return k;
    let good = verifySignature(k.curve, k.key, bytes, sig);
    if (!good && Date.now() - (this.refreshed.get(did) ?? 0) > REFRESH_MS) {
      // The repo may have rotated its key: fetch the document once more.
      this.refreshed.set(did, Date.now());
      if (this.refreshed.size > 10_000) this.refreshed.delete(this.refreshed.keys().next().value!);
      k = await this.key(did, true);
      if ('ok' in k) return k;
      good = verifySignature(k.curve, k.key, bytes, sig);
    }
    if (!good) return fail('signature', `The commit signature does not verify against ${did.slice(0, 200)}#atproto.`);

    for (const op of p.ops) {
      let r: MstLookup;
      try {
        r = mstLookup(p.blocks, data, op.path);
      } catch (err) {
        return fail('proof', `${op.path}: ${(err as Error).message}`);
      }
      if ('missing' in r) return fail('proof', `${op.path}: the tree node ${r.missing.slice(0, 20)}… is not in the CAR file.`);
      if (op.action === 'delete') {
        if (!('absent' in r)) return fail('proof', `${op.path} is deleted but still in the signed tree.`);
        continue;
      }
      if (!('found' in r)) return fail('proof', `${op.path} is not in the signed tree.`);
      if (!op.cid || r.found.toString() !== op.cid) return fail('proof', `${op.path}: the signed tree holds another version of the record.`);
      const rec = p.blocks.get(op.cid);
      if (rec && !blockMatches(op.cid, rec)) return fail('proof', `${op.path}: the record block does not match its CID.`);
    }
    return { ok: true, rev };
  }
}
