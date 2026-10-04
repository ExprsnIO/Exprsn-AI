import { createPublicKey, type KeyObject } from 'node:crypto';
import type { Kms, SigningKeyType } from '../platform/kms.js';
import { SECP256K1_NOT_IN_TRANSIT } from '../platform/kms.js';
import { compressPublicKey, formatDidKey, multikey, normaliseLowS, type Curve } from './crypto.js';

/*
 * Custody of AT-Protocol keys (B-1608): label signing keys and did:plc rotation keys are made and used in the signer
 * process (both curves) or OpenBao transit (P-256 only: transit has no secp256k1 key type), never in this process and
 * never exported. The app keeps the transit key name or the signer's wrapped blob (which it cannot open) and the
 * public key. Every signature is folded to low-S here, since neither the signer nor transit promises it.
 */

export type AtCustody = 'signer' | 'openbao';

export interface AtKeyRef {
  custody: AtCustody;
  keyName: string;
  wrapped: string | null;
  curve: Curve;
}

export class AtCustodyError extends Error {}

export const AT_CUSTODY_MESSAGE = 'AT-Protocol keys need the signer (SIGNER_SOCKET) or OpenBao transit (KMS_PROVIDER=openbao); this process never holds a private key.';

const kmsType = (curve: Curve): SigningKeyType => (curve === 'secp256k1' ? 'ecdsa-secp256k1' : 'ecdsa-p256');

export class AtprotoKeys {
  constructor(
    private readonly kms: () => Kms,
    private readonly transitPrefix: () => string
  ) {}

  custody(): AtCustody | null {
    const k = this.kms();
    if (k.heldKeys) return 'signer';
    if (k.kind === 'openbao' && typeof k.createSigningKey === 'function' && typeof k.sign === 'function') return 'openbao';
    return null;
  }

  /** The curves the configured custody can hold. */
  curves(): Curve[] {
    const c = this.custody();
    return c === 'signer' ? ['secp256k1', 'p256'] : c === 'openbao' ? ['p256'] : [];
  }

  /** secp256k1 where the signer holds keys (the AT-Protocol default), P-256 under OpenBao. */
  defaultCurve(): Curve {
    return this.custody() === 'signer' ? 'secp256k1' : 'p256';
  }

  async create(id: string, curve: Curve): Promise<{ ref: AtKeyRef; publicKey: KeyObject; multikey: string; didKey: string }> {
    const custody = this.custody();
    let ref: AtKeyRef;
    let publicKey: KeyObject;
    if (custody === 'signer') {
      const keyName = `atproto:${id}`;
      const r = await this.kms().heldKeys!.create(keyName, kmsType(curve));
      ref = { custody, keyName, wrapped: r.wrapped, curve };
      publicKey = createPublicKey(r.publicKey);
    } else if (custody === 'openbao') {
      if (curve === 'secp256k1') throw new AtCustodyError(SECP256K1_NOT_IN_TRANSIT);
      const keyName = `${this.transitPrefix()}atproto-${id.toLowerCase()}`;
      publicKey = createPublicKey(await this.kms().createSigningKey!(keyName, 'ecdsa-p256'));
      ref = { custody, keyName, wrapped: null, curve };
    } else throw new AtCustodyError(AT_CUSTODY_MESSAGE);
    const c = compressPublicKey(publicKey);
    if (c.curve !== curve) throw new Error('The key store returned a key on another curve');
    return { ref, publicKey, multikey: multikey(curve, c.compressed), didKey: formatDidKey(curve, c.compressed) };
  }

  /** ECDSA-SHA256 over `data`: the compact 64-byte r||s, low-S. */
  async sign(ref: AtKeyRef, data: Buffer): Promise<Buffer> {
    const k = this.kms();
    let raw: Buffer;
    if (ref.custody === 'signer') {
      if (!k.heldKeys || !ref.wrapped) throw new AtCustodyError('This key is held by the signer, which is not configured (SIGNER_SOCKET).');
      raw = await k.heldKeys.sign(ref.keyName, kmsType(ref.curve), ref.wrapped, data);
    } else {
      if (k.kind !== 'openbao' || typeof k.sign !== 'function') throw new AtCustodyError('This key is held in OpenBao transit, which is not configured (KMS_PROVIDER=openbao).');
      raw = await k.sign(ref.keyName, kmsType(ref.curve), data);
    }
    return normaliseLowS(ref.curve, raw);
  }
}
