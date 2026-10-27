/*
 * 1.9.9-qa (Sprint QA-1): canonical JSON as the Exprsn platform's CA signs its v2 tokens
 * (exprsn-platform `services/ca/crypto/canonical.js`, RFC 8785 JCS-style). Byte-identical output is pinned by the
 * shared vectors in `server/test/fixtures/canonical-json-vectors.json` (the same file is in the platform's
 * `services/ca/tests/fixtures/`).
 *
 * - Object keys sorted by UTF-16 code units (the default `sort()`), at every depth; members whose value is
 *   `undefined` are omitted.
 * - Arrays keep their order; an `undefined` element is `null`.
 * - Strings and numbers exactly as `JSON.stringify` (ECMAScript Number-to-String, which JCS specifies); -0 is 0.
 * - No whitespace.
 * - Anything that is not plain JSON data (NaN, Infinity, bigint, functions, symbols, Dates and other class
 *   instances) throws, so a value never signs as something else.
 */

const isPlainObject = (v: object): boolean => {
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
};

/** The canonical JSON text of plain JSON data. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
  if (Array.isArray(value)) return `[${value.map((v: unknown) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  if (!isPlainObject(value)) throw new TypeError('canonicalJson: only plain objects are supported');
  const o = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(o).sort()) {
    if (o[key] === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonicalJson(o[key])}`);
  }
  return `{${parts.join(',')}}`;
}
