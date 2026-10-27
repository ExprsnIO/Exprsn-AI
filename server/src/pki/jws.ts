import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

/** A JSON Web Key as it arrives (RFC 7517); only its public members are used. */
export type JsonWebKey = Record<string, unknown>;

/*
 * JSON Web Signatures as ACME uses them (RFC 8555 section 6.2, RFC 7515 flattened JSON serialization): a protected
 * header with `alg`, `nonce`, `url` and exactly one of `jwk` (new accounts, revocation by certificate key, the inner
 * key-change JWS) or `kid` (everything else). No unprotected header, no MAC algorithms, no `none`.
 *
 * Accepted algorithms: ES256 (P-256), ES384 (P-384), RS256 (RSA 2048 to 8192 bits) and EdDSA (Ed25519).
 */

export const ACME_ALGS = ['ES256', 'ES384', 'RS256', 'EdDSA'] as const;
export type AcmeAlg = (typeof ACME_ALGS)[number];

/** An RFC 8555 problem (`urn:ietf:params:acme:error:<type>`). */
export class AcmeProblem extends Error {
  /** A Location header to send with the problem (key-change onto a key another account uses). */
  location?: string;

  constructor(
    readonly status: number,
    readonly type: string,
    detail: string,
    readonly extra: Record<string, unknown> = {}
  ) {
    super(detail);
  }

  body(): Record<string, unknown> {
    return { type: `urn:ietf:params:acme:error:${this.type}`, detail: this.message, status: this.status, ...this.extra };
  }
}

export const malformed = (detail: string) => new AcmeProblem(400, 'malformed', detail);

export interface FlattenedJws {
  protected: string;
  payload: string;
  signature: string;
}

export interface JwsHeader {
  alg: AcmeAlg;
  nonce?: string;
  url: string;
  jwk?: JsonWebKey;
  kid?: string;
}

export interface ParsedJws {
  raw: FlattenedJws;
  header: JwsHeader;
  /** The decoded payload: null for POST-as-GET (an empty payload). */
  payload: unknown;
  /** The bytes the signature covers. */
  signingInput: Buffer;
  signature: Buffer;
}

const B64U = /^[A-Za-z0-9_-]*$/;

function b64uJson(s: string, what: string): unknown {
  if (!B64U.test(s)) throw malformed(`The ${what} is not base64url.`);
  try {
    return JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw malformed(`The ${what} is not JSON.`);
  }
}

/** Parses a flattened JWS body (already JSON-decoded) and its protected header; the signature is not checked here. */
export function parseJws(body: unknown): ParsedJws {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw malformed('The request body must be a flattened JWS.');
  const o = body as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!['protected', 'payload', 'signature'].includes(k)) throw malformed(k === 'header' ? 'The JWS must not carry an unprotected header.' : `Unexpected JWS member ${k}.`);
  if (typeof o.protected !== 'string' || typeof o.payload !== 'string' || typeof o.signature !== 'string') throw malformed('The JWS needs protected, payload and signature strings.');
  if (!B64U.test(o.signature) || !o.signature) throw malformed('The JWS signature is not base64url.');
  const h = b64uJson(o.protected, 'protected header');
  if (!h || typeof h !== 'object' || Array.isArray(h)) throw malformed('The protected header must be an object.');
  const header = h as Record<string, unknown>;
  if (typeof header.alg !== 'string') throw malformed('The protected header needs alg.');
  if (!(ACME_ALGS as readonly string[]).includes(header.alg)) throw new AcmeProblem(400, 'badSignatureAlgorithm', `The algorithm ${header.alg.slice(0, 20)} is not accepted.`, { algorithms: [...ACME_ALGS] });
  if (typeof header.url !== 'string') throw malformed('The protected header needs url.');
  if (header.nonce !== undefined && typeof header.nonce !== 'string') throw malformed('The nonce must be a string.');
  const hasJwk = header.jwk !== undefined;
  const hasKid = header.kid !== undefined;
  if (hasJwk === hasKid) throw malformed('The protected header needs exactly one of jwk and kid.');
  if (hasKid && typeof header.kid !== 'string') throw malformed('The kid must be a string.');
  if (hasJwk && (!header.jwk || typeof header.jwk !== 'object' || Array.isArray(header.jwk))) throw malformed('The jwk must be an object.');
  const payload = o.payload === '' ? null : b64uJson(o.payload, 'payload');
  return {
    raw: { protected: o.protected, payload: o.payload, signature: o.signature },
    header: { alg: header.alg as AcmeAlg, url: header.url, ...(typeof header.nonce === 'string' ? { nonce: header.nonce } : {}), ...(hasJwk ? { jwk: header.jwk as JsonWebKey } : {}), ...(hasKid ? { kid: header.kid as string } : {}) },
    payload,
    signingInput: Buffer.from(`${o.protected}.${o.payload}`, 'ascii'),
    signature: Buffer.from(o.signature, 'base64url')
  };
}

/** The public members of a JWK in the order RFC 7638 hashes them (anything else, including private members, is refused). */
export function canonicalJwk(jwk: JsonWebKey): Record<string, string> {
  const s = (v: unknown, what: string): string => {
    if (typeof v !== 'string' || !v || !B64U.test(v)) throw new AcmeProblem(400, 'badPublicKey', `The JWK's ${what} is missing or not base64url.`);
    return v;
  };
  if ('d' in jwk || 'p' in jwk || 'q' in jwk) throw new AcmeProblem(400, 'badPublicKey', 'The JWK holds private key material.');
  if (jwk.kty === 'EC') return { crv: s(jwk.crv, 'crv'), kty: 'EC', x: s(jwk.x, 'x'), y: s(jwk.y, 'y') };
  if (jwk.kty === 'RSA') return { e: s(jwk.e, 'e'), kty: 'RSA', n: s(jwk.n, 'n') };
  if (jwk.kty === 'OKP') return { crv: s(jwk.crv, 'crv'), kty: 'OKP', x: s(jwk.x, 'x') };
  throw new AcmeProblem(400, 'badPublicKey', 'The JWK key type must be EC, RSA or OKP.');
}

/** RFC 7638 thumbprint (SHA-256, base64url). */
export const jwkThumbprint = (jwk: JsonWebKey): string => createHash('sha256').update(JSON.stringify(canonicalJwk(jwk))).digest('base64url');

/** The key for a JWK, checked against the algorithm it is used with. */
export function keyForJwk(jwk: JsonWebKey, alg: AcmeAlg): KeyObject {
  const c = canonicalJwk(jwk);
  let key: KeyObject;
  try {
    key = createPublicKey({ key: c, format: 'jwk' });
  } catch {
    throw new AcmeProblem(400, 'badPublicKey', 'The JWK does not describe a usable public key.');
  }
  if (!algFits(key, alg)) throw new AcmeProblem(400, 'badSignatureAlgorithm', `The ${alg} algorithm does not fit this key.`, { algorithms: [...ACME_ALGS] });
  return key;
}

export function algFits(key: KeyObject, alg: AcmeAlg): boolean {
  const d = key.asymmetricKeyDetails ?? {};
  switch (alg) {
    case 'ES256':
      return key.asymmetricKeyType === 'ec' && d.namedCurve === 'prime256v1';
    case 'ES384':
      return key.asymmetricKeyType === 'ec' && d.namedCurve === 'secp384r1';
    case 'RS256':
      return key.asymmetricKeyType === 'rsa' && (d.modulusLength ?? 0) >= 2048 && (d.modulusLength ?? 0) <= 8192;
    case 'EdDSA':
      return key.asymmetricKeyType === 'ed25519';
  }
}

/** Checks the JWS signature with `key`. */
export function verifyJws(jws: ParsedJws, key: KeyObject): boolean {
  if (!algFits(key, jws.header.alg)) return false;
  try {
    switch (jws.header.alg) {
      case 'ES256':
        return jws.signature.length === 64 && verify('sha256', jws.signingInput, { key, dsaEncoding: 'ieee-p1363' }, jws.signature);
      case 'ES384':
        return jws.signature.length === 96 && verify('sha384', jws.signingInput, { key, dsaEncoding: 'ieee-p1363' }, jws.signature);
      case 'RS256':
        return verify('sha256', jws.signingInput, key, jws.signature);
      case 'EdDSA':
        return verify(null, jws.signingInput, key, jws.signature);
    }
  } catch {
    return false;
  }
}

/** The public JWK of a key (to compare a certificate's key with a revocation request's jwk). */
export function jwkOf(key: KeyObject): Record<string, string> {
  return canonicalJwk(key.export({ format: 'jwk' }) as JsonWebKey);
}
