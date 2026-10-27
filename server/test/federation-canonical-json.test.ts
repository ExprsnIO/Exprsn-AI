/*
 * 1.9.9-qa (Sprint QA-1): the canonical JSON the Exprsn platform's CA signs v2 tokens over. The vectors file is shared
 * byte for byte with exprsn-platform (`services/ca/tests/fixtures/canonical-json-vectors.json`, checked there by
 * `services/ca/tests/tokenSignature.test.js`), and its token signature was made by the platform's own `signData`
 * (node-forge RSA-PSS), so this also checks that node's verifier accepts it.
 */
import { constants, createHash, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/federation/canonical-json.js';
import { decodePlatformToken, platformSigningInputV2 } from '../src/federation/platform-tokens.js';

interface Vectors {
  vectors: { name: string; input: unknown; expected: string }[];
  token: Record<string, unknown>;
  tokenCanonical: string;
  tokenChecksum: string;
  tokenSignature: string;
  tokenPublicKey: string;
}
const fx = JSON.parse(readFileSync(new URL('./fixtures/canonical-json-vectors.json', import.meta.url), 'utf8')) as Vectors;

describe('canonicalJson (shared with the platform CA)', () => {
  it.each(fx.vectors.map((v) => [v.name, v] as const))('vector: %s', (_name, v) => {
    expect(canonicalJson(v.input)).toBe(v.expected);
  });

  it('the token vector: canonical form, checksum, and the platform\'s signature verifies here', () => {
    const text = canonicalJson(fx.token);
    expect(text).toBe(fx.tokenCanonical);
    expect(createHash('sha256').update(text).digest('hex')).toBe(fx.tokenChecksum);
    const ok = verify('sha256', Buffer.from(text, 'utf8'), { key: fx.tokenPublicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(fx.tokenSignature, 'base64'));
    expect(ok).toBe(true);
  });

  it('the presented token\'s v2 signing input is the same bytes, whatever the field order and with checksum present', () => {
    const shuffled = Object.fromEntries(Object.entries({ ...fx.token, checksum: fx.tokenChecksum, signature: fx.tokenSignature }).reverse());
    const t = decodePlatformToken(Buffer.from(JSON.stringify(shuffled)).toString('base64url'));
    expect(t).not.toBeNull();
    expect(platformSigningInputV2(t!)).toBe(fx.tokenCanonical);
  });

  it('is independent of key order at every depth, keeps array order, omits undefined', () => {
    expect(canonicalJson({ b: { y: 1, x: [{ q: 1, p: 2 }] }, a: { d: null, c: 'c' } })).toBe(canonicalJson({ a: { c: 'c', d: null }, b: { x: [{ p: 2, q: 1 }], y: 1 } }));
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([undefined])).toBe('[null]');
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['bigint', 1n],
    ['function', () => 1],
    ['Date', new Date(0)],
    ['nested Date', { a: { b: new Date(0) } }]
  ])('refuses %s', (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(TypeError);
  });

  it('the legacy form the platform used dropped nested fields', () => {
    const t = { id: 'x', issuer: { domain: 'a' }, data: { userId: 'u' } };
    expect(JSON.stringify(t, Object.keys(t).sort())).toBe('{"data":{},"id":"x","issuer":{}}');
    expect(canonicalJson(t)).toBe('{"data":{"userId":"u"},"id":"x","issuer":{"domain":"a"}}');
  });
});
