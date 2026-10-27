import type { CborValue } from '../cbor.js';
import { Cid } from '../encoding.js';

/*
 * The JSON form of AT-Protocol data (B-2902; https://atproto.com/specs/data-model), as XRPC bodies carry records, and
 * its conversion to and from the data model that DAG-CBOR encodes (`../cbor.ts`):
 *
 *   JSON                                        data model
 *   {"$link": "<base32 CID>"}                   a Cid (a link, CBOR tag 42)
 *   {"$bytes": "<base64, no padding>"}          a Buffer (CBOR bytes)
 *   {"$type": "blob", "ref": {"$link": …},      the same map with `ref` as a Cid; mimeType a string, size an integer
 *    "mimeType": …, "size": …}
 *
 * Everything else maps one to one. The data model has no floats (a JSON number must be a safe integer; 123.0 is the
 * integer 123), `$type` is a non-empty string wherever it appears, `$link` and `$bytes` objects have no other keys, a
 * blob has exactly its four keys, strings are well-formed Unicode, and nesting is at most MAX_DEPTH deep. A record is a
 * map at the top. The interop fixtures in `test/fixtures/atproto-interop/data-model` (CC0) pin the round trip.
 */

export const MAX_DEPTH = 32;

export class DataModelError extends Error {
  constructor(
    message: string,
    readonly path: string
  ) {
    super(path ? `${path}: ${message}` : message);
  }
}

type Obj = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v) && !(v instanceof Uint8Array) && !(v instanceof Cid);

const wellFormed = (s: string): boolean => !/[\uD800-\uDFFF]/.test(s) || Buffer.from(s, 'utf8').toString('utf8') === s;

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

const at = (path: string, key: string | number) => (typeof key === 'number' ? `${path}[${key}]` : `${path}/${key}`);

function linkFrom(v: unknown, path: string): Cid {
  if (!isPlainObject(v) || Object.keys(v).length !== 1 || typeof v.$link !== 'string') throw new DataModelError('A link is {"$link": "<CID>"} and nothing else.', path);
  try {
    return Cid.parse(v.$link);
  } catch {
    throw new DataModelError(`${JSON.stringify(v.$link.slice(0, 80))} is not a CID.`, path);
  }
}

function convert(v: unknown, path: string, depth: number): CborValue {
  if (depth > MAX_DEPTH) throw new DataModelError(`Nested more than ${MAX_DEPTH} deep.`, path);
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new DataModelError('Numbers are integers (no floats) within ±2^53.', path);
    return v;
  }
  if (typeof v === 'string') {
    if (!wellFormed(v)) throw new DataModelError('The string is not well-formed Unicode.', path);
    return v;
  }
  if (Array.isArray(v)) return v.map((x, i) => convert(x, at(path, i), depth + 1));
  if (!isPlainObject(v)) throw new DataModelError(`A ${typeof v} is not AT-Protocol data.`, path);
  if ('$link' in v) return linkFrom(v, path);
  if ('$bytes' in v) {
    const b = v.$bytes;
    if (Object.keys(v).length !== 1 || typeof b !== 'string' || !B64.test(b)) throw new DataModelError('Bytes are {"$bytes": "<base64>"} and nothing else.', path);
    return Buffer.from(b, 'base64');
  }
  if ('$type' in v && (typeof v.$type !== 'string' || !v.$type)) throw new DataModelError('$type is a non-empty string.', at(path, '$type'));
  if (v.$type === 'blob') {
    const keys = Object.keys(v).sort().join(',');
    if (keys !== '$type,mimeType,ref,size') throw new DataModelError('A blob has exactly $type, ref, mimeType and size.', path);
    if (typeof v.mimeType !== 'string' || !v.mimeType || !wellFormed(v.mimeType)) throw new DataModelError('A blob mimeType is a string.', at(path, 'mimeType'));
    if (typeof v.size !== 'number' || !Number.isSafeInteger(v.size) || v.size < 0) throw new DataModelError('A blob size is a non-negative integer.', at(path, 'size'));
    return { $type: 'blob', ref: linkFrom(v.ref, at(path, 'ref')), mimeType: v.mimeType, size: v.size };
  }
  const out: Record<string, CborValue> = {};
  for (const [k, x] of Object.entries(v)) {
    if (!wellFormed(k)) throw new DataModelError('A key is not well-formed Unicode.', path);
    if (x === undefined) continue;
    out[k] = convert(x, at(path, k), depth + 1);
  }
  return out;
}

/** Any JSON value to the data model. Throws DataModelError. */
export const jsonValueToData = (v: unknown): CborValue => convert(v, '', 0);

/** A record (or other top-level object) in JSON form to the data model; the top must be a map. Throws DataModelError. */
export function jsonToData(v: unknown): CborValue {
  if (!isPlainObject(v) || '$link' in v || '$bytes' in v) throw new DataModelError('The top level is an object.', '');
  return convert(v, '', 0);
}

/** The data model to its JSON form (links as `$link`, bytes as unpadded base64 `$bytes`). */
export function dataToJson(v: CborValue | undefined): unknown {
  if (v === undefined || v === null || typeof v !== 'object') return v;
  if (v instanceof Cid) return { $link: v.toString() };
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { $bytes: Buffer.from(v).toString('base64').replace(/=+$/, '') };
  if (Array.isArray(v)) return v.map((x) => dataToJson(x));
  const out: Obj = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = dataToJson(x);
  return out;
}

export interface BlobRef {
  cid: Cid;
  mimeType: string;
  size: number;
}

/** Every blob a record names, wherever it is (once per CID, first occurrence wins). */
export function blobRefs(v: CborValue | undefined): BlobRef[] {
  const out = new Map<string, BlobRef>();
  const walk = (x: CborValue | undefined, depth: number): void => {
    if (depth > MAX_DEPTH + 1 || x === null || x === undefined || typeof x !== 'object' || x instanceof Cid || Buffer.isBuffer(x) || x instanceof Uint8Array) return;
    if (Array.isArray(x)) return x.forEach((y) => walk(y, depth + 1));
    const o = x as Record<string, CborValue | undefined>;
    if (o.$type === 'blob' && o.ref instanceof Cid && typeof o.mimeType === 'string' && typeof o.size === 'number') {
      const key = o.ref.toString();
      if (!out.has(key)) out.set(key, { cid: o.ref, mimeType: o.mimeType, size: o.size });
      return;
    }
    for (const y of Object.values(o)) walk(y, depth + 1);
  };
  walk(v, 0);
  return [...out.values()];
}
