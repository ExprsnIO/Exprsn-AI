import { createPublicKey, type KeyObject } from 'node:crypto';
import type { Kms } from '../platform/kms.js';
import { ecdsaToDer, type IssuerKeyType } from './x509.js';

/*
 * Key custody for the CA (B-1601): every issuer and OCSP responder key is made and used in the signer process
 * (`exprsn-ai signer`, B-1201) or in OpenBao transit (B-408). The app stores only a reference — the transit key name,
 * or the signer's wrapped blob, which it cannot open — and the public key. With neither configured the CA is off:
 * it never falls back to a key in this process.
 */

export type Custody = 'signer' | 'openbao';

export interface KeyRef {
  custody: Custody;
  /** The signer key name or the transit key name. */
  keyName: string;
  /** The signer's wrapped blob (opaque to the app); null for transit. */
  wrapped: string | null;
  keyType: IssuerKeyType;
}

export class CustodyUnavailable extends Error {}

export const CUSTODY_MESSAGE = 'The certificate authority needs the signer (SIGNER_SOCKET) or OpenBao transit (KMS_PROVIDER=openbao) to hold its keys; it never holds a private key itself.';

export class PkiKeys {
  constructor(
    private readonly kms: () => Kms,
    private readonly transitPrefix: () => string
  ) {}

  /** Where new keys go: the signer when SIGNER_SOCKET is set, else OpenBao transit, else nowhere. */
  custody(): Custody | null {
    const k = this.kms();
    if (k.heldKeys) return 'signer';
    if (k.kind === 'openbao' && typeof k.createSigningKey === 'function' && typeof k.sign === 'function') return 'openbao';
    return null;
  }

  describe(): string {
    const c = this.custody();
    return c === 'signer' ? 'signer process' : c === 'openbao' ? 'OpenBao transit' : 'unavailable';
  }

  /** Creates a key named after the issuer or responder id; only the public half comes back. */
  async create(id: string, keyType: IssuerKeyType): Promise<{ ref: KeyRef; publicKey: KeyObject }> {
    const custody = this.custody();
    if (custody === 'signer') {
      const keyName = `pki:${id}`;
      const r = await this.kms().heldKeys!.create(keyName, keyType);
      return { ref: { custody, keyName, wrapped: r.wrapped, keyType }, publicKey: createPublicKey(r.publicKey) };
    }
    if (custody === 'openbao') {
      const keyName = `${this.transitPrefix()}pki-${id.toLowerCase()}`;
      const pem = await this.kms().createSigningKey!(keyName, keyType);
      return { ref: { custody, keyName, wrapped: null, keyType }, publicKey: createPublicKey(pem) };
    }
    throw new CustodyUnavailable(CUSTODY_MESSAGE);
  }

  /** Signs to-be-signed DER bytes; the result is in X.509 form (ECDSA as a DER SEQUENCE, RSA as PKCS#1 v1.5). */
  async sign(ref: KeyRef, tbs: Buffer): Promise<Buffer> {
    const k = this.kms();
    let raw: Buffer;
    if (ref.custody === 'signer') {
      if (!k.heldKeys || !ref.wrapped) throw new CustodyUnavailable('This key is held by the signer, which is not configured (SIGNER_SOCKET).');
      raw = await k.heldKeys.sign(ref.keyName, ref.keyType, ref.wrapped, tbs);
    } else {
      if (k.kind !== 'openbao' || typeof k.sign !== 'function') throw new CustodyUnavailable('This key is held in OpenBao transit, which is not configured (KMS_PROVIDER=openbao).');
      raw = await k.sign(ref.keyName, ref.keyType, tbs);
    }
    return ref.keyType === 'ecdsa-p256' ? ecdsaToDer(raw) : raw;
  }
}
