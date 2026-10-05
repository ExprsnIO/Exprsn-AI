/*
 * AT-Protocol string syntax (B-2902; https://atproto.com/specs: handle, nsid, record-key, tid, did, at-uri, lexicon
 * string formats). Each check takes anything and answers true or false; none throws. The length is checked before any
 * pattern, and the patterns have no nested unbounded repetition (a repeated group always starts with a fixed
 * separator), so no input makes them backtrack badly. The interop fixtures in `test/fixtures/atproto-interop/syntax`
 * (CC0, bluesky-social/atproto-interop-tests) pin them.
 */

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

const LABEL = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

/** A handle: a domain name of at least two labels, at most 253 characters, whose last label does not start with a digit. */
export function isHandle(v: unknown): boolean {
  if (!str(v, 253)) return false;
  const labels = v.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return false;
  return /^[a-zA-Z]/.test(labels[labels.length - 1]!);
}

const NSID_NAME = /^[a-zA-Z][a-zA-Z0-9]{0,62}$/;

/** An NSID: a reversed domain authority (two or more labels, the first not starting with a digit) and a name. */
export function isNsid(v: unknown): boolean {
  if (!str(v, 317)) return false;
  const segs = v.split('.');
  if (segs.length < 3) return false;
  const name = segs.pop()!;
  if (!NSID_NAME.test(name)) return false;
  if (!segs.every((s) => LABEL.test(s))) return false;
  return !/^[0-9]/.test(segs[0]!);
}

/** A record key: 1 to 512 of `A-Za-z0-9 . _ : ~ -`, but not `.` or `..`. */
export function isRecordKey(v: unknown): boolean {
  return str(v, 512) && v !== '.' && v !== '..' && /^[a-zA-Z0-9._:~-]+$/.test(v);
}

/** A TID: 13 characters of base32-sortable, the first with the high bit clear. */
export function isTid(v: unknown): boolean {
  return typeof v === 'string' && v.length === 13 && /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/.test(v);
}

/** A DID (any method, as the protocol's generic syntax allows): `did:<method>:<id>`, at most 2048 characters. */
export function isDid(v: unknown): boolean {
  return str(v, 2048) && /^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$/.test(v);
}

/** A handle or a DID. */
export const isAtIdentifier = (v: unknown): boolean => (typeof v === 'string' && v.startsWith('did:') ? isDid(v) : isHandle(v));

/**
 * An at:// URI in the lexicon's restricted form: `at://<handle or DID>[/<collection NSID>[/<record key>]]`, at most
 * 8 KB, no query or fragment.
 */
export function isAtUri(v: unknown): boolean {
  if (!str(v, 8192) || !v.startsWith('at://')) return false;
  const parts = v.slice(5).split('/');
  if (parts.length > 3) return false;
  if (!isAtIdentifier(parts[0])) return false;
  if (parts.length >= 2 && !isNsid(parts[1])) return false;
  if (parts.length === 3 && !isRecordKey(parts[2])) return false;
  return true;
}

const DATETIME = /^[0-9]{4}-[01][0-9]-[0-3][0-9]T[0-2][0-9]:[0-6][0-9]:[0-6][0-9](\.[0-9]{1,20})?(Z|[+-][0-2][0-9]:[0-5][0-9])$/;

/** An RFC 3339 datetime with seconds and a time zone (`Z` or an offset other than `-00:00`) that is a real instant. */
export function isDatetime(v: unknown): boolean {
  if (!str(v, 64) || !DATETIME.test(v) || v.endsWith('-00:00')) return false;
  const t = Date.parse(v);
  if (Number.isNaN(t)) return false;
  // The parsed instant must exist and be in year 0 or later (an offset can push 0000-01-01 into year -1).
  if (new Date(t).toISOString().startsWith('-')) return false;
  // Date.parse rolls some impossible dates over (31 April); the fields must survive the round trip.
  const [y, m, d] = v.slice(0, 10).split('-').map(Number) as [number, number, number];
  const day = new Date(Date.UTC(2000, m - 1, d));
  return y >= 0 && m >= 1 && m <= 12 && d >= 1 && day.getUTCMonth() === m - 1 && day.getUTCDate() === d;
}

/** A BCP-47 language tag, by its syntax only (a primary subtag of two or three letters, `i`, or private-use `x`, then subtags). */
export function isLanguage(v: unknown): boolean {
  return str(v, 128) && /^(i|[xX]|[a-z]{2,3})(-[a-zA-Z0-9]+)*$/.test(v);
}

/** A generic URI: a scheme, a colon and at least one more character, no whitespace, at most 8 KB. */
export function isUri(v: unknown): boolean {
  return str(v, 8192) && /^[a-zA-Z][a-zA-Z0-9+.-]*:(\/\/)?[^\s/][^\s]*$/.test(v);
}

/** A CID in string form, by its syntax only (CIDv0 `Qm…` strings are not allowed). */
export function isCid(v: unknown): boolean {
  return str(v, 256) && v.length >= 8 && /^[a-zA-Z0-9+=]+$/.test(v) && !v.startsWith('Qmb');
}
