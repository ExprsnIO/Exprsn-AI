import { Cid, CODEC_RAW } from '../atproto/encoding.js';

/*
 * A file version's content identifier: the CIDv1 of its bytes with the raw codec and a SHA2-256 multihash, written in
 * base32 (`bafkrei…`). It is what an AT-Protocol PDS gives the same bytes as a blob (`atproto/pds/blobs.ts`), so a file
 * and a blob of the same content name each other. It is derived from the sha256 every version already keeps: nothing
 * extra is stored.
 */

const HEX64 = /^[0-9a-f]{64}$/;

/** The CID of a version whose sha256 is `sha256hex`, or null for a missing or malformed hash. */
export function cidOf(sha256hex: string | null | undefined): string | null {
  if (!sha256hex || !HEX64.test(sha256hex)) return null;
  return Cid.create(CODEC_RAW, Buffer.from(sha256hex, 'hex')).toString();
}

/** The sha256 (hex) inside a raw-codec SHA2-256 CID, or null when the text is not one. */
export function sha256OfCid(text: string): string | null {
  let cid: Cid;
  try {
    cid = Cid.parse(text.trim());
  } catch {
    return null;
  }
  if (cid.codec !== CODEC_RAW) return null;
  const b = cid.bytes;
  // version 1, codec 0x55, then the multihash: 0x12 (sha2-256), 0x20 (32 bytes), digest.
  if (b.length !== 36 || b[0] !== 1 || b[1] !== CODEC_RAW || b[2] !== 0x12 || b[3] !== 0x20) return null;
  return b.subarray(4).toString('hex');
}
