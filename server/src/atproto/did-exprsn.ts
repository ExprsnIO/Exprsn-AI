import { parseMultikey } from './crypto.js';
import type { DidDocument, PlcService } from './did.js';

/*
 * 1.7.0, Sprint 43 (B-11301, decision D6a): `did:exprsn`, the exprsn-platform's self-certifying DID method.
 *
 * The method-specific id is the multibase (base58btc) multicodec public key, the same string a `did:key` carries:
 * `did:exprsn:zQ3sh...` for a secp256k1 key, `did:exprsn:zDn...` for P-256. Nothing is registered anywhere and no
 * network is asked: the DID document is derived from the DID itself, so a signature made with the key verifies
 * offline. Exprsn-AI keeps the private half of each user's key in the signer (or OpenBao transit for P-256), like an
 * AT-Protocol account key; it does not derive keys from a shared secret as the platform did with
 * `ATPROTO_USER_DID_SECRET`.
 *
 * The document names the key twice: `#atproto` (what a service-auth JWT is verified against) and `#atproto_label`
 * (what a label is verified against), so both verify under a `did:exprsn` with the code that verifies them for
 * `did:plc` and `did:web`. The platform's documents carry `#atproto_label` only; they still verify labels here.
 * `alsoKnownAs` and services are added where the resolving server knows them (a user's hosted PDS `did:plc`).
 */

export const DID_EXPRSN_PREFIX = 'did:exprsn:';
export const DID_EXPRSN_RE = /^did:exprsn:z[1-9A-HJ-NP-Za-km-z]{40,60}$/;

export const isDidExprsn = (did: string): boolean => DID_EXPRSN_RE.test(did);

/** `did:exprsn:<multikey>` for a multibase public key (`z...`). */
export function didExprsnFromMultikey(multikey: string): string {
  const did = `${DID_EXPRSN_PREFIX}${multikey}`;
  if (!isDidExprsn(did)) throw new Error('Not a multibase public key');
  parseMultikey(multikey);
  return did;
}

/** The key a `did:exprsn` (or `did:key`) carries, and its `did:key` form. */
export function keyOfSelfCertifying(did: string) {
  const id = did.startsWith(DID_EXPRSN_PREFIX) ? did.slice(DID_EXPRSN_PREFIX.length) : did.startsWith('did:key:') ? did.slice('did:key:'.length) : null;
  if (!id) throw new Error('Not a self-certifying DID');
  const k = parseMultikey(id);
  return { ...k, multikey: id, didKey: `did:key:${id}` };
}

/**
 * The DID document of a `did:exprsn` or `did:key`, derived offline. The key parses or this throws: a DID whose id is
 * not a valid compressed key on a curve AT-Protocol uses does not resolve.
 */
export function selfCertifyingDocument(did: string, o: { alsoKnownAs?: string[]; services?: Record<string, PlcService> } = {}): DidDocument {
  const { multikey } = keyOfSelfCertifying(did);
  return {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
    id: did,
    alsoKnownAs: o.alsoKnownAs ?? [],
    verificationMethod: ['atproto', 'atproto_label'].map((fragment) => ({ id: `${did}#${fragment}`, type: 'Multikey', controller: did, publicKeyMultibase: multikey })),
    service: Object.entries(o.services ?? {}).map(([id, s]) => ({ id: `#${id}`, type: s.type, serviceEndpoint: s.endpoint }))
  } as DidDocument;
}
