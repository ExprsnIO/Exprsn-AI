import { Asn1Error, bits, children, enumerated, expect, generalizedTime, octets, oid, parse, readOid, readUnsigned, seq, tagged, tlv, type Asn1 } from './asn1.js';
import { signatureAlgorithm, type IssuerKeyType } from './x509.js';

/*
 * OCSP (RFC 6960) request parsing and response encoding. The responder (`service.ts`) matches each CertID to an
 * issuer by its name and key hashes (SHA-1 or SHA-256), looks the serial up and signs a BasicOCSPResponse with the
 * issuer's delegated responder key, which the signer or OpenBao holds.
 */

export const OCSP_OIDS = { basic: '1.3.6.1.5.5.7.48.1.1', nonce: '1.3.6.1.5.5.7.48.1.2', sha1: '1.3.14.3.2.26', sha256: '2.16.840.1.101.3.4.2.1' } as const;

/** OCSPResponseStatus values (4.2.1). */
export const OCSP_STATUS = { successful: 0, malformedRequest: 1, internalError: 2, tryLater: 3, sigRequired: 5, unauthorized: 6 } as const;

export interface OcspCertId {
  hash: 'sha1' | 'sha256';
  nameHash: Buffer;
  keyHash: Buffer;
  serial: Buffer;
  /** The CertID exactly as the client sent it; the response must echo it. */
  raw: Buffer;
}

export interface OcspRequest {
  certIds: OcspCertId[];
  /** The whole nonce extension (RFC 8954) to echo back, or null. */
  nonce: Buffer | null;
}

export const MAX_OCSP_REQUESTS = 10;

export class OcspRequestError extends Error {}

function certId(n: Asn1): OcspCertId {
  const [alg, nameHash, keyHash, serial] = children(expect(n, 0x30, 'CertID'));
  const algOid = readOid(children(expect(alg, 0x30, 'hashAlgorithm'))[0]);
  const hash = algOid === OCSP_OIDS.sha1 ? 'sha1' : algOid === OCSP_OIDS.sha256 ? 'sha256' : null;
  if (!hash) throw new OcspRequestError('Unsupported CertID hash algorithm');
  return { hash, nameHash: expect(nameHash, 0x04, 'issuerNameHash').value, keyHash: expect(keyHash, 0x04, 'issuerKeyHash').value, serial: readUnsigned(serial, 'serialNumber'), raw: n.raw };
}

/** Parses an OCSPRequest. A signed request is accepted, but its signature is not used (no requestor is trusted). */
export function parseOcspRequest(der: Buffer): OcspRequest {
  try {
    const top = children(parse(der));
    const tbs = children(expect(top[0], 0x30, 'tbsRequest'));
    let i = 0;
    if (tbs[i]?.tag === 0xa0) {
      const v = children(tbs[i]!)[0];
      if (!v || v.tag !== 0x02 || v.value.length !== 1 || v.value[0] !== 0) throw new OcspRequestError('Only OCSP version 1 requests are accepted');
      i++;
    }
    if (tbs[i]?.tag === 0xa1) i++; // requestorName
    const list = children(expect(tbs[i], 0x30, 'requestList'));
    i++;
    if (!list.length) throw new OcspRequestError('Empty request list');
    if (list.length > MAX_OCSP_REQUESTS) throw new OcspRequestError('Too many requests');
    const certIds = list.map((r) => certId(children(expect(r, 0x30, 'Request'))[0]!));
    let nonce: Buffer | null = null;
    if (tbs[i]?.tag === 0xa2) {
      for (const e of children(children(tbs[i]!)[0] ?? expect(undefined, 0x30, 'extensions'))) {
        const parts = children(e);
        if (readOid(parts[0]) !== OCSP_OIDS.nonce) continue;
        const value = expect(parts[parts.length - 1], 0x04, 'extnValue').value;
        // RFC 8954: the nonce is 1 to 32 octets (inside an OCTET STRING).
        if (value.length < 1 || value.length > 34) throw new OcspRequestError('The nonce must be 1 to 32 octets');
        nonce = e.raw;
      }
    }
    return { certIds, nonce };
  } catch (err) {
    if (err instanceof OcspRequestError) throw err;
    if (err instanceof Asn1Error) throw new OcspRequestError(err.message);
    throw new OcspRequestError('The request does not parse');
  }
}

/** A response with no body: malformedRequest, internalError, tryLater or unauthorized. */
export const ocspError = (status: number): Buffer => seq(enumerated(status));

export type SingleStatus = { status: 'good' } | { status: 'unknown' } | { status: 'revoked'; revokedAt: number; reason: number | null };

export interface SingleResponse {
  certId: OcspCertId;
  status: SingleStatus;
  thisUpdate: number;
  nextUpdate: number;
}

function single(r: SingleResponse): Buffer {
  const status =
    r.status.status === 'good'
      ? tlv(0x80, Buffer.alloc(0))
      : r.status.status === 'unknown'
        ? tlv(0x82, Buffer.alloc(0))
        : tlv(0xa1, generalizedTime(r.status.revokedAt), ...(r.status.reason !== null && r.status.reason !== 0 ? [tagged(0, true, enumerated(r.status.reason))] : []));
  return seq(r.certId.raw, status, generalizedTime(r.thisUpdate), tagged(0, true, generalizedTime(r.nextUpdate)));
}

/** The ResponseData to sign: responder by key hash, producedAt, the single responses and the echoed nonce. */
export function tbsResponseData(o: { responderKeyHash: Buffer; producedAt: number; responses: SingleResponse[]; nonce: Buffer | null }): Buffer {
  return seq(tagged(2, true, octets(o.responderKeyHash)), generalizedTime(o.producedAt), seq(...o.responses.map(single)), ...(o.nonce ? [tagged(1, true, seq(o.nonce))] : []));
}

/** A successful OCSPResponse around a signed BasicOCSPResponse, with the responder's certificate chain. */
export function ocspResponse(o: { tbs: Buffer; keyType: IssuerKeyType; signature: Buffer; certs: Buffer[] }): Buffer {
  const basic = seq(o.tbs, signatureAlgorithm(o.keyType), bits(o.signature), ...(o.certs.length ? [tagged(0, true, seq(...o.certs))] : []));
  return seq(enumerated(OCSP_STATUS.successful), tagged(0, true, seq(oid(OCSP_OIDS.basic), octets(basic))));
}
