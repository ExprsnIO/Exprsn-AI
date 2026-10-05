/*
 * Sprint 31 (B-2902): the PDS's record checks. The AT-Protocol interop fixtures (bluesky-social/atproto-interop-tests,
 * CC0, in `fixtures/atproto-interop`) pin the string syntax, the JSON form of the data model with its DAG-CBOR bytes and
 * CIDs, and the lexicon validator; a few app.bsky records check the bundled lexicons.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cborDecode, cborEncode } from '../src/atproto/cbor.js';
import { Cid } from '../src/atproto/encoding.js';
import { LEXICONS } from '../src/atproto/pds/lexicon-docs.js';
import { DEFAULT_LEXICONS, LexiconError, LexiconSet, validateRecord, validateRecordKey, type LexiconDoc } from '../src/atproto/pds/lexicon.js';
import { blobRefs, DataModelError, dataToJson, jsonToData } from '../src/atproto/pds/lexjson.js';
import * as syntax from '../src/atproto/pds/syntax.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/atproto-interop');
const read = (p: string) => readFileSync(path.join(DIR, p), 'utf8');
const lines = (p: string) => read(p).split('\n').filter((l) => l && !l.startsWith('#'));
const fixture = <T>(p: string) => JSON.parse(read(p)) as T;

describe('B-2902: AT-Protocol string syntax (interop fixtures)', () => {
  const checks: [string, (v: unknown) => boolean][] = [
    ['tid', syntax.isTid],
    ['recordkey', syntax.isRecordKey],
    ['nsid', syntax.isNsid],
    ['handle', syntax.isHandle],
    ['datetime', syntax.isDatetime],
    ['did', syntax.isDid],
    ['aturi', syntax.isAtUri],
    ['language', syntax.isLanguage],
    ['cid', syntax.isCid],
    ['atidentifier', syntax.isAtIdentifier],
    ['uri', syntax.isUri]
  ];
  for (const [name, check] of checks) {
    it(`${name}: accepts every valid example and refuses every invalid one`, () => {
      const valid = lines(`syntax/${name}_syntax_valid.txt`);
      const invalid = lines(`syntax/${name}_syntax_invalid.txt`);
      expect(valid.length).toBeGreaterThan(0);
      expect(invalid.length).toBeGreaterThan(0);
      expect(valid.filter((v) => !check(v))).toEqual([]);
      expect(invalid.filter((v) => check(v))).toEqual([]);
    });
  }

  it('refuses datetimes that are well formed but not real instants, and never throws on odd input', () => {
    expect(lines('syntax/datetime_parse_invalid.txt').filter((v) => syntax.isDatetime(v))).toEqual([]);
    expect(syntax.isDatetime('2023-04-31T00:00:00Z')).toBe(false);
    for (const [, check] of checks) for (const v of [undefined, null, 42, {}, [], '', 'x'.repeat(100_000)]) expect(() => check(v)).not.toThrow();
  });
});

describe('B-2902: the JSON form of the data model (interop fixtures)', () => {
  it('converts each fixture to the reference DAG-CBOR bytes and CID, and back', () => {
    const cases = fixture<{ json: unknown; cbor_base64: string; cid: string }[]>('data-model/data-model-fixtures.json');
    expect(cases.length).toBeGreaterThan(2);
    for (const c of cases) {
      const bytes = cborEncode(jsonToData(c.json));
      expect(bytes.toString('base64').replace(/=+$/, '')).toBe(c.cbor_base64);
      expect(Cid.ofCbor(bytes).toString()).toBe(c.cid);
      expect(dataToJson(cborDecode(Buffer.from(c.cbor_base64, 'base64')))).toEqual(c.json);
    }
  });

  it('accepts the valid examples and refuses the invalid ones', () => {
    for (const c of fixture<{ note: string; json: unknown }[]>('data-model/data-model-valid.json')) expect(() => jsonToData(c.json), c.note).not.toThrow();
    for (const c of fixture<{ note: string; json: unknown }[]>('data-model/data-model-invalid.json')) expect(() => jsonToData(c.json), c.note).toThrow(DataModelError);
  });

  it('refuses lone surrogates and deep nesting, and finds the blobs a record names once each', () => {
    expect(() => jsonToData({ s: 'a\uD800b' })).toThrow(DataModelError);
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = { d: deep };
    expect(() => jsonToData(deep)).toThrow(/deep/);
    const blob = { $type: 'blob', ref: { $link: 'bafkreiccldh766hwcnuxnf2wh6jgzepf2nlu2lvcllt63eww5p6chi4ity' }, mimeType: 'image/jpeg', size: 10 };
    const refs = blobRefs(jsonToData({ a: blob, b: [{ image: blob }], c: { $type: 'com.example.notablob', ref: 1 } }));
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ mimeType: 'image/jpeg', size: 10 });
    expect(refs[0]!.cid.toString()).toBe(blob.ref.$link);
  });
});

describe('B-2902: lexicon validation of records', () => {
  const catalog = new LexiconSet([fixture<LexiconDoc>('lexicon/catalog/record.json')]);

  it('passes every valid interop record and refuses every invalid one', () => {
    const valid = fixture<{ name: string; rkey: string; data: unknown }[]>('lexicon/record-data-valid.json');
    for (const c of valid) {
      expect(validateRecord(catalog, 'example.lexicon.record', jsonToData(c.data)), c.name).toBe('valid');
      expect(() => validateRecordKey(catalog, 'example.lexicon.record', c.rkey), c.name).not.toThrow();
    }
    const invalid = fixture<{ name: string; data: unknown }[]>('lexicon/record-data-invalid.json');
    expect(invalid.length).toBeGreaterThan(40);
    const passed = invalid.filter((c) => {
      try {
        validateRecord(catalog, 'example.lexicon.record', jsonToData(c.data));
        return true;
      } catch (err) {
        expect(err instanceof LexiconError || err instanceof DataModelError, c.name).toBe(true);
        return false;
      }
    });
    expect(passed.map((c) => c.name)).toEqual([]);
    expect(() => validateRecordKey(catalog, 'example.lexicon.record', 'other')).toThrow(/demo/);
  });

  const BLOB = { $type: 'blob', ref: { $link: 'bafkreiccldh766hwcnuxnf2wh6jgzepf2nlu2lvcllt63eww5p6chi4ity' }, mimeType: 'image/jpeg', size: 120_000 };
  const post = (extra: Record<string, unknown> = {}) => ({
    $type: 'app.bsky.feed.post',
    text: 'Hello @alice.example.com',
    createdAt: '2026-10-05T12:00:00.000Z',
    langs: ['en'],
    facets: [{ index: { byteStart: 6, byteEnd: 24 }, features: [{ $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz' }] }],
    embed: { $type: 'app.bsky.embed.images', images: [{ image: BLOB, alt: 'A photo', aspectRatio: { width: 4, height: 3 } }] },
    ...extra
  });
  const check = (collection: string, v: unknown) => validateRecord(DEFAULT_LEXICONS, collection, jsonToData(v));

  it('bundles the Bluesky record types and the definitions they reach', () => {
    for (const nsid of ['app.bsky.feed.post', 'app.bsky.feed.like', 'app.bsky.feed.generator', 'app.bsky.actor.profile', 'app.bsky.graph.follow', 'app.bsky.graph.list', 'app.bsky.labeler.service', 'chat.bsky.actor.declaration'])
      expect(DEFAULT_LEXICONS.record(nsid), nsid).toBeDefined();
    expect(DEFAULT_LEXICONS.get('com.atproto.repo.strongRef')).toBeDefined();
    expect(LEXICONS.every((d) => d.lexicon === 1 && Object.keys(d.defs).length > 0)).toBe(true);
  });

  it('accepts a post with a mention facet and an image, and refuses one over 300 graphemes or without its $type', () => {
    expect(check('app.bsky.feed.post', post())).toBe('valid');
    expect(check('app.bsky.feed.post', post({ text: 'é'.repeat(300) }))).toBe('valid');
    expect(() => check('app.bsky.feed.post', post({ text: 'a'.repeat(301) }))).toThrow(/text: Must be at most 300 characters/);
    const { $type: _t, ...untyped } = post();
    expect(() => check('app.bsky.feed.post', untyped)).toThrow(/\$type/);
    expect(() => check('app.bsky.feed.post', post({ createdAt: 'yesterday' }))).toThrow(/createdAt/);
    expect(() => check('app.bsky.feed.post', post({ embed: { $type: 'app.bsky.embed.images', images: [{ image: { cid: 'bafkreiccldh766hwcnuxnf2wh6jgzepf2nlu2lvcllt63eww5p6chi4ity', mimeType: 'image/jpeg' }, alt: '' }] } }))).toThrow(
      /blob/
    );
    // An open union passes a type it does not know.
    expect(check('app.bsky.feed.post', post({ embed: { $type: 'com.example.embed', x: 1 } }))).toBe('valid');
  });

  it('accepts a like with a strong ref and refuses a profile avatar of the wrong type', () => {
    const subject = { uri: 'at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/app.bsky.feed.post/3kznmn7xqxl22', cid: 'bafyreiclp443lavogvhj3d2ob2cxbfuscni2k5jk7bebjzg7khl3esabwq' };
    expect(check('app.bsky.feed.like', { $type: 'app.bsky.feed.like', subject, createdAt: '2026-10-05T12:00:00Z' })).toBe('valid');
    expect(() => check('app.bsky.feed.like', { $type: 'app.bsky.feed.like', subject: { uri: subject.uri }, createdAt: '2026-10-05T12:00:00Z' })).toThrow(/subject\/cid/);
    expect(check('app.bsky.actor.profile', { $type: 'app.bsky.actor.profile', displayName: 'Alice', avatar: { ...BLOB, mimeType: 'image/png' } })).toBe('valid');
    expect(() => check('app.bsky.actor.profile', { $type: 'app.bsky.actor.profile', avatar: { ...BLOB, mimeType: 'image/gif' } })).toThrow(/avatar: A image\/gif blob is not accepted/);
  });

  it('answers unknown for a collection it has no lexicon for, and checks record keys', () => {
    expect(check('com.example.thing', { $type: 'com.example.thing', anything: [1, 2] })).toBe('unknown');
    expect(() => check('com.example.thing', { $type: 'com.example.other' })).toThrow(/\$type/);
    expect(() => validateRecordKey(DEFAULT_LEXICONS, 'app.bsky.feed.post', '3kznmn7xqxl22')).not.toThrow();
    expect(() => validateRecordKey(DEFAULT_LEXICONS, 'app.bsky.feed.post', 'self')).toThrow(/TID/);
    expect(() => validateRecordKey(DEFAULT_LEXICONS, 'app.bsky.actor.profile', 'self')).not.toThrow();
    expect(() => validateRecordKey(DEFAULT_LEXICONS, 'app.bsky.actor.profile', '3kznmn7xqxl22')).toThrow(/self/);
    expect(() => validateRecordKey(DEFAULT_LEXICONS, 'app.bsky.feed.generator', 'my-feed')).not.toThrow();
    expect(() => validateRecordKey(DEFAULT_LEXICONS, 'com.example.thing', '..')).toThrow();
  });
});
