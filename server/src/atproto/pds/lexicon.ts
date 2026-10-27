import { Cid } from '../encoding.js';
import { LEXICONS } from './lexicon-docs.js';
import { isAtIdentifier, isAtUri, isCid, isDatetime, isDid, isHandle, isLanguage, isNsid, isRecordKey, isTid, isUri } from './syntax.js';

/*
 * Lexicon validation of records (B-2902; https://atproto.com/specs/lexicon). A record written to the PDS through
 * `com.atproto.repo.*` is checked against the lexicon of its collection when the PDS knows one (the bundled
 * `lexicon-docs.ts`): the answer is `valid`, or `unknown` for a collection without a known record type (which the
 * caller may refuse or accept, as the reference PDS does with `validate`), or a LexiconError naming the path and the
 * rule that failed. Values are in the data model (after `jsonToData`): links are Cid instances, bytes are Buffers.
 *
 * Rules, as the specification states them: string lengths count UTF-8 bytes and graphemes (`Intl.Segmenter`); objects
 * may carry properties their schema does not name; a property that is present but null must be listed in `nullable`;
 * an open union accepts a `$type` it does not know (unchecked), a closed one does not; `unknown` is any map that is not
 * a blob; `knownValues` and `default` are hints and not enforced on input. Blobs are the `{$type: 'blob', ref, mimeType,
 * size}` form; the legacy `{cid, mimeType}` form is refused. The interop fixtures in
 * `test/fixtures/atproto-interop/lexicon` (CC0) pin the behaviour.
 */

export interface LexiconDoc {
  lexicon: 1;
  id: string;
  revision?: number;
  description?: string;
  defs: Record<string, unknown>;
}

export class LexiconError extends Error {
  constructor(
    message: string,
    readonly path: string
  ) {
    super(path ? `${path}: ${message}` : message);
  }
}

type Obj = Record<string, unknown>;
type Def = Obj & { type?: string };

const MAX_DEPTH = 128;
const MAX_NODES = 100_000;

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v) && !(v instanceof Uint8Array) && !(v instanceof Cid);

/** `nsid` or `nsid#name`, with `#name` resolved against the document it appears in, as the full `nsid#name`. */
const fullRef = (ref: string, from: string): string => (ref.startsWith('#') ? `${from}${ref}` : ref.includes('#') ? ref : `${ref}#main`);

export class LexiconSet {
  private readonly docs = new Map<string, LexiconDoc>();

  constructor(docs: readonly LexiconDoc[]) {
    for (const d of docs) {
      if (!d || d.lexicon !== 1 || !isNsid(d.id) || !isObj(d.defs)) throw new Error(`Not a lexicon document: ${String(d?.id)}`);
      if (this.docs.has(d.id)) throw new Error(`Lexicon ${d.id} is given twice`);
      this.docs.set(d.id, d);
    }
  }

  has(nsid: string): boolean {
    return this.docs.has(nsid);
  }

  /** A definition by `nsid` (its main) or `nsid#name`. */
  get(ref: string): unknown {
    const [nsid, name] = fullRef(ref, '').split('#') as [string, string];
    const doc = this.docs.get(nsid);
    return doc && Object.prototype.hasOwnProperty.call(doc.defs, name) ? doc.defs[name] : undefined;
  }

  /** The record definition of a collection, if it has one. */
  record(collection: string): Def | undefined {
    const def = this.get(collection) as Def | undefined;
    return isObj(def) && def.type === 'record' ? def : undefined;
  }
}

const FORMATS: Record<string, (v: string) => boolean> = {
  'at-identifier': isAtIdentifier,
  'at-uri': isAtUri,
  cid: isCid,
  datetime: isDatetime,
  did: isDid,
  handle: isHandle,
  language: isLanguage,
  nsid: isNsid,
  'record-key': isRecordKey,
  tid: isTid,
  uri: isUri
};

let segmenter: Intl.Segmenter | null = null;
const graphemes = (s: string): number => {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let n = 0;
  for (const _ of segmenter.segment(s)) n++;
  return n;
};

const mimeMatches = (accept: unknown[], mime: string): boolean =>
  accept.some((a) => typeof a === 'string' && (a === '*/*' || a === mime || (a.endsWith('/*') && mime.startsWith(a.slice(0, -1)))));

class Validator {
  private nodes = 0;

  constructor(private readonly set: LexiconSet) {}

  private fail(path: string, message: string): never {
    throw new LexiconError(message, path || '/');
  }

  private resolve(ref: string, from: string, path: string): { def: Def; nsid: string; full: string } {
    const full = fullRef(ref, from);
    const def = this.set.get(full);
    if (!isObj(def)) this.fail(path, `The schema refers to ${full}, which is not a known lexicon definition.`);
    return { def, nsid: full.split('#')[0]!, full };
  }

  /** Validates `v` against `def`, which appears in the document `nsid`. */
  value(def: Def, nsid: string, v: unknown, path: string, depth: number): void {
    if (depth > MAX_DEPTH) this.fail(path, 'The value is nested too deeply.');
    if (++this.nodes > MAX_NODES) this.fail(path, 'The value has too many parts.');
    switch (def.type) {
      case 'boolean':
        if (typeof v !== 'boolean') this.fail(path, 'Expected a boolean.');
        if (typeof def.const === 'boolean' && v !== def.const) this.fail(path, `Must be ${String(def.const)}.`);
        return;
      case 'integer':
        return this.integer(def, v, path);
      case 'string':
        return this.string(def, v, path);
      case 'bytes': {
        if (!Buffer.isBuffer(v) && !(v instanceof Uint8Array)) this.fail(path, 'Expected bytes.');
        const n = (v as Uint8Array).length;
        if (typeof def.minLength === 'number' && n < def.minLength) this.fail(path, `Must be at least ${def.minLength} bytes long.`);
        if (typeof def.maxLength === 'number' && n > def.maxLength) this.fail(path, `Must be at most ${def.maxLength} bytes long.`);
        return;
      }
      case 'cid-link':
        if (!(v instanceof Cid)) this.fail(path, 'Expected a CID link.');
        return;
      case 'blob':
        return this.blob(def, v, path);
      case 'array': {
        if (!Array.isArray(v)) this.fail(path, 'Expected an array.');
        if (typeof def.minLength === 'number' && v.length < def.minLength) this.fail(path, `Must have at least ${def.minLength} items.`);
        if (typeof def.maxLength === 'number' && v.length > def.maxLength) this.fail(path, `Must have at most ${def.maxLength} items.`);
        if (!isObj(def.items)) this.fail(path, 'The array schema has no items.');
        v.forEach((x, i) => this.value(def.items as Def, nsid, x, `${path}[${i}]`, depth + 1));
        return;
      }
      case 'object':
        return this.object(def, nsid, v, path, depth);
      case 'record':
        if (!isObj(def.record)) this.fail(path, 'The record schema has no object.');
        return this.object(def.record as Def, nsid, v, path, depth);
      case 'ref': {
        if (typeof def.ref !== 'string') this.fail(path, 'The schema has a ref without a target.');
        const r = this.resolve(def.ref, nsid, path);
        if (r.def.type === 'token') {
          if (v !== r.full) this.fail(path, `Must be the token ${r.full}.`);
          return;
        }
        return this.value(r.def, r.nsid, v, path, depth + 1);
      }
      case 'union':
        return this.union(def, nsid, v, path, depth);
      case 'unknown':
        if (!isObj(v)) this.fail(path, 'Expected an object.');
        if (v.$type === 'blob') this.fail(path, 'A blob is not allowed here.');
        return;
      case 'token':
        return this.fail(path, 'A token is used as a value only through a ref.');
      default:
        this.fail(path, `The schema type ${String(def.type)} cannot describe record data.`);
    }
  }

  private integer(def: Def, v: unknown, path: string): void {
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) this.fail(path, 'Expected an integer.');
    if (typeof def.const === 'number' && v !== def.const) this.fail(path, `Must be ${def.const}.`);
    if (Array.isArray(def.enum) && !def.enum.includes(v)) this.fail(path, `Must be one of ${def.enum.join(', ')}.`);
    if (typeof def.minimum === 'number' && v < def.minimum) this.fail(path, `Must be at least ${def.minimum}.`);
    if (typeof def.maximum === 'number' && v > def.maximum) this.fail(path, `Must be at most ${def.maximum}.`);
  }

  private string(def: Def, v: unknown, path: string): void {
    if (typeof v !== 'string') this.fail(path, 'Expected a string.');
    if (typeof def.const === 'string' && v !== def.const) this.fail(path, `Must be ${JSON.stringify(def.const)}.`);
    if (Array.isArray(def.enum) && !def.enum.includes(v)) this.fail(path, `Must be one of ${def.enum.map((x) => JSON.stringify(x)).join(', ')}.`);
    const bytes = Buffer.byteLength(v, 'utf8');
    if (typeof def.minLength === 'number' && bytes < def.minLength) this.fail(path, `Must be at least ${def.minLength} bytes long (UTF-8).`);
    if (typeof def.maxLength === 'number' && bytes > def.maxLength) this.fail(path, `Must be at most ${def.maxLength} bytes long (UTF-8).`);
    // A string has no more graphemes than UTF-8 bytes or UTF-16 code units: the segmenter runs only when those do not decide.
    if (typeof def.maxGraphemes === 'number' && bytes > def.maxGraphemes && graphemes(v) > def.maxGraphemes) this.fail(path, `Must be at most ${def.maxGraphemes} characters long.`);
    if (typeof def.minGraphemes === 'number' && (v.length < def.minGraphemes || graphemes(v) < def.minGraphemes)) this.fail(path, `Must be at least ${def.minGraphemes} characters long.`);
    if (typeof def.format === 'string') {
      const check = FORMATS[def.format];
      if (!check) this.fail(path, `The schema names an unknown string format, ${def.format}.`);
      if (!check(v)) this.fail(path, `Must be a valid ${def.format}.`);
    }
  }

  private blob(def: Def, v: unknown, path: string): void {
    if (!isObj(v) || v.$type !== 'blob') this.fail(path, 'Expected a blob ({$type: "blob", ref, mimeType, size}).');
    if (!(v.ref instanceof Cid)) this.fail(`${path}/ref`, 'Expected a CID link.');
    if (typeof v.mimeType !== 'string' || !v.mimeType) this.fail(`${path}/mimeType`, 'Expected a MIME type.');
    if (typeof v.size !== 'number' || !Number.isSafeInteger(v.size) || v.size < 0) this.fail(`${path}/size`, 'Expected a size in bytes.');
    if (Array.isArray(def.accept) && !mimeMatches(def.accept, v.mimeType)) this.fail(path, `A ${v.mimeType} blob is not accepted here (accepted: ${def.accept.join(', ')}).`);
    if (typeof def.maxSize === 'number' && v.size > def.maxSize) this.fail(path, `The blob is ${v.size} bytes; at most ${def.maxSize} are allowed.`);
  }

  private object(def: Def, nsid: string, v: unknown, path: string, depth: number): void {
    if (!isObj(v)) this.fail(path, 'Expected an object.');
    const props = isObj(def.properties) ? (def.properties as Record<string, Def>) : {};
    const nullable = new Set(Array.isArray(def.nullable) ? (def.nullable as string[]) : []);
    for (const k of Array.isArray(def.required) ? (def.required as string[]) : []) {
      if (v[k] === undefined) this.fail(`${path}/${k}`, 'Required, and missing.');
    }
    for (const [k, schema] of Object.entries(props)) {
      const x = v[k];
      if (x === undefined) continue;
      if (x === null) {
        if (!nullable.has(k)) this.fail(`${path}/${k}`, 'Must not be null.');
        continue;
      }
      if (!isObj(schema)) this.fail(`${path}/${k}`, 'The schema for this property is malformed.');
      this.value(schema, nsid, x, `${path}/${k}`, depth + 1);
    }
  }

  private union(def: Def, nsid: string, v: unknown, path: string, depth: number): void {
    if (!isObj(v)) this.fail(path, 'Expected an object with a $type.');
    if (typeof v.$type !== 'string' || !v.$type) this.fail(`${path}/$type`, 'A union member names its $type.');
    const refs = (Array.isArray(def.refs) ? (def.refs as string[]) : []).map((r) => fullRef(r, nsid));
    const wanted = fullRef(v.$type, '');
    if (!refs.includes(wanted)) {
      if (def.closed === true) this.fail(`${path}/$type`, `Must be one of ${refs.map((r) => r.replace(/#main$/, '')).join(', ')}.`);
      return; // an open union: a type this schema does not know is not checked
    }
    const r = this.resolve(wanted, nsid, path);
    this.value(r.def, r.nsid, v, path, depth + 1);
  }
}

/**
 * Validates a record for `collection`: `valid`, or `unknown` when the set has no record type for it (the record must
 * still be an object naming its collection in `$type`). Throws LexiconError.
 */
export function validateRecord(set: LexiconSet, collection: string, value: unknown): 'valid' | 'unknown' {
  if (!isObj(value)) throw new LexiconError('A record is an object.', '/');
  if (value.$type !== collection) throw new LexiconError(`A record names its collection in $type (${collection}).`, '/$type');
  const def = set.record(collection);
  if (!def) return 'unknown';
  new Validator(set).value(def, collection, value, '', 0);
  return 'valid';
}

/** Checks a record key against the collection's key rule (`tid`, `nsid`, `literal:<value>` or `any`). Throws LexiconError. */
export function validateRecordKey(set: LexiconSet, collection: string, rkey: string): void {
  if (!isRecordKey(rkey)) throw new LexiconError('Not a valid record key.', '/rkey');
  const def = set.record(collection);
  const rule = typeof def?.key === 'string' ? def.key : 'any';
  if (rule === 'tid' && !isTid(rkey)) throw new LexiconError(`${collection} records are keyed by a TID.`, '/rkey');
  if (rule === 'nsid' && !isNsid(rkey)) throw new LexiconError(`${collection} records are keyed by an NSID.`, '/rkey');
  if (rule.startsWith('literal:') && rkey !== rule.slice('literal:'.length)) throw new LexiconError(`The ${collection} record's key is ${rule.slice('literal:'.length)}.`, '/rkey');
}

/** The lexicons bundled with the server (`lexicon-docs.ts`). */
export const DEFAULT_LEXICONS = new LexiconSet(LEXICONS);
