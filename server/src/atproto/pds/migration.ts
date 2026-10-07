import { randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import { hmac } from '../../crypto/index.js';
import type { Services } from '../../services.js';
import { decompressPublicKey, multikey, parseMultikey, type Curve } from '../crypto.js';
import { base58Decode } from '../encoding.js';
import { plcOperationCid, signPlcOperation, verifyPlcOperation, type DidDocument, type PlcOperation, type PlcService } from '../did.js';
import { handlesOf, pdsOf } from '../handles.js';
import { verifyRepoCar, RepoError } from './repo.js';
import { sequence } from './sequencer.js';
import { peekServiceJwt, TokenError, verifyServiceJwt } from './tokens.js';
import { rotationRef, XrpcError, type PdsAccountRow, type PdsActor, type PdsService } from './service.js';

/*
 * Account migration (B-2905), as https://atproto.com/guides/account-migration describes it, both ways.
 *
 * In. The new account is made by `createAccount` with the DID it brings and an inter-service token from the old PDS
 * (`getServiceAuth`, audience this PDS, method createAccount), checked against the DID's `#atproto` key; it starts
 * deactivated. `importRepo` takes the old repo's CAR file, which must verify against that same key (hashes, signature,
 * canonical tree), and keeps its records under a new commit signed with this account's key; `listMissingBlobs` and
 * `uploadBlob` bring the blobs through the scan. `getRecommendedDidCredentials` gives the keys and endpoint for the
 * DID, the old PDS signs the PLC operation, and `submitPlcOperation` checks that it names this PDS, this account's
 * signing key and its rotation key before sending it to the PLC directory. `activateAccount` checks the DID document
 * (resolved afresh) and announces the repo with `#sync`.
 *
 * Out. `getServiceAuth` (a privileged app password only, for createAccount), `getRepo`, `listBlobs`/`getBlob`, then
 * `signPlcOperation` with a single-use token. The token is not emailed: `requestPlcOperationSignature` tells the user
 * (a notification) to take it from the console, where showing it needs a recent sign-in, so whoever moves the DID has
 * proved they hold the Exprsn-AI account as well as an app password. `deactivateAccount` then stops the account here.
 */

const TOKEN_MINUTES = 15;

export class PdsMigration {
  constructor(
    private readonly pds: PdsService,
    private readonly s: () => Services
  ) {}

  private get db() {
    return this.s().db;
  }

  private async document(did: string): Promise<DidDocument> {
    let doc: unknown;
    try {
      doc = await this.s().atproto.resolver.resolve(did, true);
    } catch (err) {
      throw new XrpcError(400, 'DidNotResolved', `${did} could not be resolved: ${(err as Error).message}`);
    }
    const d = doc as DidDocument | null;
    if (!d || d.id !== did) throw new XrpcError(400, 'DidNotResolved', `The document of ${did} does not describe it.`);
    return d;
  }

  /**
   * The `#atproto` signing key a DID document names, as a Multikey (`z…` with its multicodec prefix). Documents in the
   * legacy form (`EcdsaSecp256k1VerificationKey2019` / `EcdsaSecp256r1VerificationKey2019`: the key's bytes in base58btc
   * without a multicodec, uncompressed), which older PLC directories still render, are read too.
   */
  static signingKeyOf(doc: DidDocument): string | null {
    const vm = (Array.isArray(doc.verificationMethod) ? doc.verificationMethod : []).find((v) => v && (v.id === '#atproto' || v.id === `${doc.id}#atproto`));
    if (!vm || typeof vm.publicKeyMultibase !== 'string') return null;
    const legacy: Record<string, Curve> = { EcdsaSecp256k1VerificationKey2019: 'secp256k1', EcdsaSecp256r1VerificationKey2019: 'p256' };
    const curve = legacy[vm.type];
    if (!curve) return vm.publicKeyMultibase;
    try {
      if (!vm.publicKeyMultibase.startsWith('z') || vm.publicKeyMultibase.length > 200) return null;
      const raw = base58Decode(vm.publicKeyMultibase.slice(1));
      if (raw.length === 33 && (raw[0] === 2 || raw[0] === 3)) return multikey(curve, raw);
      if (raw.length !== 65 || raw[0] !== 4) return null;
      const compressed = Buffer.concat([Buffer.from([raw[64]! & 1 ? 3 : 2]), raw.subarray(1, 33)]);
      // The point must be on the curve, and its y the one given (not merely of the same parity).
      const y = Buffer.from(decompressPublicKey(curve, compressed).export({ format: 'jwk' }).y ?? '', 'base64url');
      return y.equals(raw.subarray(33)) ? multikey(curve, compressed) : null;
    } catch {
      return null;
    }
  }

  /** Checks the inter-service token that comes with `createAccount` for an existing DID. */
  async checkCreateAuth(header: string | undefined, did: string): Promise<void> {
    const m = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    if (!m) throw new XrpcError(401, 'AuthMissing', 'Creating an account for an existing DID needs a service token from its current PDS (com.atproto.server.getServiceAuth).');
    const peek = peekServiceJwt(m[1]!);
    if (peek.claims.iss !== did) throw new XrpcError(401, 'InvalidToken', 'The service token was not issued by this DID.');
    const key = PdsMigration.signingKeyOf(await this.document(did));
    if (!key) throw new XrpcError(400, 'DidNotResolved', `The document of ${did} names no #atproto key.`);
    try {
      verifyServiceJwt(m[1]!, { multikey: key, aud: this.pds.serviceDid(), lxm: 'com.atproto.server.createAccount' });
    } catch (err) {
      throw new XrpcError(401, err instanceof TokenError ? err.code : 'InvalidToken', (err as Error).message);
    }
  }

  private assertMigrating(a: PdsAccountRow): void {
    if (!a.migrating || a.state !== 'deactivated') throw new XrpcError(400, 'InvalidRequest', 'Only an account migrating in (deactivated until activated) takes this.');
  }

  /** `com.atproto.repo.importRepo`: the old repo, verified against the DID's current signing key. */
  async importRepo(by: PdsActor, a: PdsAccountRow, car: Buffer): Promise<{ records: number; rev: string; cid: string }> {
    this.assertMigrating(a);
    const key = PdsMigration.signingKeyOf(await this.document(a.did));
    if (!key) throw new XrpcError(400, 'DidNotResolved', `The document of ${a.did} names no #atproto key.`);
    // The repo was signed by the key in force before the move, or (when the DID already moved) by ours.
    const keys = [...new Set([key, a.key_multikey])].map((k) => parseMultikey(k));
    let verified;
    let lastErr: Error | null = null;
    for (const k of keys) {
      try {
        verified = verifyRepoCar(car, { did: a.did, key: { curve: k.curve, key: k.key }, maxBytes: this.s().cfg.PDS_IMPORT_MAX_BYTES });
        break;
      } catch (err) {
        lastErr = err as Error;
        if (!(err instanceof RepoError) || !/signature/.test(lastErr.message)) break;
      }
    }
    if (!verified) throw new XrpcError(400, 'InvalidRepo', `The repo does not verify: ${(lastErr as Error).message}`);
    const out = await this.pds.repo.replaceRepo(by, a, verified.records, verified.commit.rev);
    return { records: out.records, rev: out.rev, cid: out.cid };
  }

  async checkStatus(a: PdsAccountRow) {
    const blobs = (await this.db('pds_blob_refs').where({ account_id: a.id }).countDistinct({ n: 'cid' })) as { n: number | string }[];
    const imported = (await this.db('pds_blobs').where({ account_id: a.id, state: 'ready' }).count({ n: '*' })) as { n: number | string }[];
    const blocks = (await this.db('pds_blocks').where({ account_id: a.id }).count({ n: '*' })) as { n: number | string }[];
    let validDid: boolean;
    try {
      const doc = await this.document(a.did);
      validDid = pdsOf(doc, a.did) === this.pds.publicUrl() && PdsMigration.signingKeyOf(doc) === a.key_multikey;
    } catch {
      validDid = false;
    }
    return {
      activated: a.state === 'active',
      validDid,
      repoCommit: a.commit_cid,
      repoRev: a.rev,
      repoBlocks: Number(blocks[0]?.n ?? 0),
      indexedRecords: await this.pds.recordCount(a.id),
      privateStateValues: 0,
      expectedBlobs: Number(blobs[0]?.n ?? 0),
      importedBlobs: Number(imported[0]?.n ?? 0)
    };
  }

  /** What the DID should say for this account to live here (`getRecommendedDidCredentials`). */
  credentials(a: PdsAccountRow): { rotationKeys: string[]; alsoKnownAs: string[]; verificationMethods: Record<string, string>; services: Record<string, PlcService> } {
    return {
      rotationKeys: a.rot_multikey ? [`did:key:${a.rot_multikey}`] : [],
      alsoKnownAs: [`at://${a.handle}`],
      verificationMethods: { atproto: `did:key:${a.key_multikey}` },
      services: { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: this.pds.publicUrl() } }
    };
  }

  /** `com.atproto.identity.submitPlcOperation`: a signed operation that moves the DID here, sent to the PLC directory. */
  async submitPlcOperation(by: PdsActor, a: PdsAccountRow, op: PlcOperation): Promise<void> {
    if (!a.did.startsWith('did:plc:')) throw new XrpcError(400, 'InvalidRequest', 'Only a did:plc takes PLC operations.');
    const want = this.credentials(a);
    if (op.type !== 'plc_operation' || typeof op.sig !== 'string') throw new XrpcError(400, 'InvalidRequest', 'A signed plc_operation is expected.');
    if (op.verificationMethods?.atproto !== want.verificationMethods.atproto) throw new XrpcError(400, 'InvalidRequest', 'The operation must name this account’s signing key as #atproto.');
    const pds = op.services?.atproto_pds;
    if (!pds || pds.type !== 'AtprotoPersonalDataServer' || pds.endpoint !== this.pds.publicUrl()) throw new XrpcError(400, 'InvalidRequest', `The operation must name this PDS (${this.pds.publicUrl()}) as #atproto_pds.`);
    if (!op.alsoKnownAs?.includes(`at://${a.handle}`)) throw new XrpcError(400, 'InvalidRequest', `The operation must name the handle at://${a.handle}.`);
    if (want.rotationKeys.length && !want.rotationKeys.some((k) => op.rotationKeys?.includes(k))) throw new XrpcError(400, 'InvalidRequest', 'The operation must keep this PDS’s rotation key.');
    await this.pds.submitPlc(a.did, op);
    await this.db.transaction(async (trx) => {
      await trx('pds_accounts').where({ id: a.id }).update({ plc_op: JSON.stringify(op), plc_prev: plcOperationCid(op), did_method: 'plc', updated_at: Date.now() });
      await sequence(trx, [{ did: a.did, type: 'identity', body: { did: a.did, handle: a.handle } }]);
    });
    this.pds.announce();
    await this.pds.audit(by, 'pds.plc.submitted', { account: a.id, did: a.did }, { cid: plcOperationCid(op) });
  }

  /** Before a migrated account is activated: its DID must name this PDS and this account's signing key. */
  async assertReady(a: PdsAccountRow): Promise<void> {
    if (!a.commit_cid) throw new XrpcError(400, 'InvalidRequest', 'Import the repo first (com.atproto.repo.importRepo).');
    const doc = await this.document(a.did);
    if (pdsOf(doc, a.did) !== this.pds.publicUrl()) throw new XrpcError(400, 'InvalidRequest', `The DID document does not name this PDS (${this.pds.publicUrl()}) yet; submit the PLC operation first.`);
    if (PdsMigration.signingKeyOf(doc) !== a.key_multikey) throw new XrpcError(400, 'InvalidRequest', 'The DID document does not name this account’s signing key yet.');
    if (!handlesOf(doc).includes(a.handle)) throw new XrpcError(400, 'InvalidRequest', `The DID document does not name the handle ${a.handle}.`);
  }

  // ---------- migrating out ----------

  private tokenHash(token: string): string {
    return hmac(this.s().cfg.SESSION_SECRET, 'pds-plc-token:' + token.trim());
  }

  /** A single-use token for `signPlcOperation`, shown once in the console (TOKEN_MINUTES). */
  async plcToken(by: PdsActor, a: PdsAccountRow): Promise<{ token: string; expiresAt: number }> {
    const token = randomBytes(6).toString('hex').toUpperCase().replace(/(.{6})(.{6})/, '$1-$2');
    const now = Date.now();
    await this.db('pds_tokens').where({ account_id: a.id, purpose: 'plc' }).whereNull('used_at').update({ used_at: now });
    await this.db('pds_tokens').insert({ id: ulid(), account_id: a.id, purpose: 'plc', token_hash: this.tokenHash(token), created_at: now, expires_at: now + TOKEN_MINUTES * 60_000, used_at: null });
    await this.pds.audit(by, 'pds.plc.token_issued', { account: a.id, did: a.did });
    return { token, expiresAt: now + TOKEN_MINUTES * 60_000 };
  }

  /** `com.atproto.identity.requestPlcOperationSignature`: tells the user where to get the token. */
  async requestSignature(a: PdsAccountRow): Promise<void> {
    await this.s().notifications.notify({ tenantId: a.tenant_id, userIds: [a.user_id], kind: 'security', title: `A move of ${a.handle} to another server was started`, body: 'To finish it, open your AT-Protocol settings and get a confirmation code. If this was not you, revoke your app passwords.', route: 'settings', email: true });
  }

  /** `com.atproto.identity.signPlcOperation`: an operation after the last one, with the fields given, signed by this PDS's rotation key. */
  async signPlcOperation(by: PdsActor, a: PdsAccountRow, input: { token: string; rotationKeys?: string[] | undefined; alsoKnownAs?: string[] | undefined; verificationMethods?: Record<string, string> | undefined; services?: Record<string, PlcService> | undefined }): Promise<PlcOperation> {
    const rot = rotationRef(a);
    if (!a.did.startsWith('did:plc:') || !a.plc_op || !a.plc_prev || !rot) throw new XrpcError(400, 'InvalidRequest', 'This PDS does not hold a rotation key for this DID.');
    const used = await this.db('pds_tokens').where({ account_id: a.id, purpose: 'plc', token_hash: this.tokenHash(input.token) }).whereNull('used_at').andWhere('expires_at', '>', Date.now()).update({ used_at: Date.now() });
    if (!used) throw new XrpcError(400, 'InvalidToken', 'The confirmation code is wrong, used or expired. Get a new one in the console.');
    const { sig: _sig, ...last } = a.plc_op;
    const op: PlcOperation = {
      ...last,
      ...(input.rotationKeys ? { rotationKeys: input.rotationKeys } : {}),
      ...(input.alsoKnownAs ? { alsoKnownAs: input.alsoKnownAs } : {}),
      ...(input.verificationMethods ? { verificationMethods: input.verificationMethods } : {}),
      ...(input.services ? { services: input.services } : {}),
      prev: a.plc_prev
    };
    const signed = await signPlcOperation(op, (bytes) => this.pds.sign(rot, bytes));
    if (!verifyPlcOperation(signed, a.plc_op.rotationKeys)) throw new Error('The signed PLC operation does not verify against the current rotation keys');
    await this.pds.audit(by, 'pds.plc.signed', { account: a.id, did: a.did }, { services: Object.fromEntries(Object.entries(op.services).map(([k, v]) => [k, v.endpoint])), rotationKeys: op.rotationKeys.length });
    return signed;
  }
}
