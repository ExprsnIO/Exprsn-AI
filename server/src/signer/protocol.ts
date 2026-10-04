/*
 * The signer's wire protocol (B-1201): length-prefixed JSON over a UNIX socket. Every frame is a 4-byte big-endian
 * length followed by that many bytes of UTF-8 JSON. Binary values travel as base64.
 *
 *   request   { id, op, ...arguments }
 *   response  { id, ok: true, result } | { id, ok: false, error }
 *
 * The first request on a connection must be `hello` with the shared token; anything else, or a wrong token, closes
 * the connection. Frames are capped at 1 MiB, and data to sign at 512 KiB (64 KiB before Sprint 24; a CRL's
 * to-be-signed list can be larger).
 *
 * Sprint 25 (B-1608) adds the key type `ecdsa-secp256k1` to `keygen` and `sign` (signatures as raw r||s, like P-256).
 * The change is additive and the protocol version stays 1: a signer from before it answers "Unknown key type".
 */

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME = 1024 * 1024;
export const MAX_SIGN_BYTES = 512 * 1024;

export type SignerOp = 'hello' | 'health' | 'wrap' | 'unwrap' | 'hmac' | 'keygen' | 'sign' | 'decrypt';

export interface SignerRequest {
  id: number;
  op: SignerOp;
  [arg: string]: unknown;
}

export type SignerResponse = { id: number; ok: true; result: Record<string, unknown> } | { id: number; ok: false; error: string };

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > MAX_FRAME) throw new Error('Signer frame too large');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** Splits a byte stream into frames. `push` returns the complete JSON values received so far. */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: unknown[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len > MAX_FRAME) throw new Error('Signer frame too large');
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      out.push(JSON.parse(body.toString('utf8')) as unknown);
    }
    return out;
  }
}
