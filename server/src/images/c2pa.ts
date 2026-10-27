import { createHash, createPublicKey, randomUUID, verify as cryptoVerify, X509Certificate, type KeyObject } from 'node:crypto';
import { crc32, isPng } from './png.js';

/*
 * 1.6.0, Sprint 39a (B-7901): C2PA content credentials for generated images, built here from the parts the
 * specification is made of, with no library: a CBOR encoder and decoder (RFC 8949, the subset claims use), JUMBF boxes
 * (ISO 19566-5), the manifest store a PNG carries in its `caBX` chunk, a COSE_Sign1 signature (RFC 9052, ES256, the
 * certificate chain in the protected header under label 33, RFC 9360) and the verifier that reads it all back.
 *
 * What a manifest holds: the assertion store (`c2pa.actions` with one `c2pa.created` action by a trained algorithmic
 * source, `c2pa.hash.data` binding the manifest to every byte of the file outside its own chunk, and
 * `io.exprsn.generation`, the model, profile, tenant, time, seed, size and label of the job), the claim (the hashed
 * references to those assertions, the generator and the format) and the claim signature (the COSE_Sign1 over the claim
 * bytes, signed by the tenant's content-credentials certificate, which the tenant CA issued).
 *
 * Deviations a conformance validator may notice are listed in docs/security.md: no RFC 3161 time stamp (the signing
 * time is the action's `when`), no `c2pa.ingredient` chain for variations, and the hashed-URI hash is the SHA-256 of
 * the assertion's content box (the `cbor` or `json` box with its header), which `verify` checks the same way.
 */

// ---------- CBOR ----------

export type CborValue = number | bigint | string | Buffer | boolean | null | undefined | CborValue[] | CborMap;
export type CborMap = Map<number | string, CborValue> | { [key: string]: CborValue };

function head(major: number, n: number | bigint): Buffer {
  const m = major << 5;
  if (typeof n === 'bigint') {
    if (n < 0x100000000n) return head(major, Number(n));
    const b = Buffer.alloc(9);
    b[0] = m | 27;
    b.writeBigUInt64BE(n, 1);
    return b;
  }
  if (n < 24) return Buffer.from([m | n]);
  if (n < 0x100) return Buffer.from([m | 24, n]);
  if (n < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = m | 25;
    b.writeUInt16BE(n, 1);
    return b;
  }
  if (n < 0x100000000) {
    const b = Buffer.alloc(5);
    b[0] = m | 26;
    b.writeUInt32BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = m | 27;
  b.writeBigUInt64BE(BigInt(n), 1);
  return b;
}

/** Encodes a value as deterministic CBOR (RFC 8949 §4.2.1: map keys sorted by their encoding, length first). */
export function cborEncode(v: CborValue): Buffer {
  if (v === null || v === undefined) return Buffer.from([0xf6]);
  if (v === true) return Buffer.from([0xf5]);
  if (v === false) return Buffer.from([0xf4]);
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new Error('CBOR: only integers are encoded');
    return v >= 0 ? head(0, v) : head(1, -1 - v);
  }
  if (typeof v === 'bigint') return v >= 0n ? head(0, v) : head(1, -1n - v);
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, b.length), b]);
  }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cborEncode)]);
  const entries: [Buffer, Buffer][] = (v instanceof Map ? [...v.entries()] : Object.entries(v)).map(([k, x]) => [cborEncode(k), cborEncode(x)]);
  entries.sort((a, b) => a[0].length - b[0].length || Buffer.compare(a[0], b[0]));
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, x]) => [k, x])]);
}

export class CborError extends Error {}

/** Decodes one CBOR item; maps with only text keys come back as objects, others as Maps. Tags are unwrapped. */
export function cborDecode(buf: Buffer): CborValue {
  let i = 0;
  const need = (n: number) => {
    if (i + n > buf.length) throw new CborError('CBOR: truncated');
  };
  const arg = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) {
      need(1);
      return buf[i++]!;
    }
    if (info === 25) {
      need(2);
      const n = buf.readUInt16BE(i);
      i += 2;
      return n;
    }
    if (info === 26) {
      need(4);
      const n = buf.readUInt32BE(i);
      i += 4;
      return n;
    }
    if (info === 27) {
      need(8);
      const n = buf.readBigUInt64BE(i);
      i += 8;
      if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborError('CBOR: integer too large');
      return Number(n);
    }
    throw new CborError('CBOR: indefinite lengths are not used');
  };
  const item = (depth: number): CborValue => {
    if (depth > 32) throw new CborError('CBOR: nested too deep');
    need(1);
    const b = buf[i++]!;
    const major = b >> 5;
    const info = b & 0x1f;
    switch (major) {
      case 0:
        return arg(info);
      case 1:
        return -1 - arg(info);
      case 2: {
        const n = arg(info);
        need(n);
        const out = buf.subarray(i, i + n);
        i += n;
        return Buffer.from(out);
      }
      case 3: {
        const n = arg(info);
        need(n);
        const out = buf.subarray(i, i + n).toString('utf8');
        i += n;
        return out;
      }
      case 4: {
        const n = arg(info);
        const out: CborValue[] = [];
        for (let k = 0; k < n; k++) out.push(item(depth + 1));
        return out;
      }
      case 5: {
        const n = arg(info);
        const m = new Map<number | string, CborValue>();
        let textOnly = true;
        for (let k = 0; k < n; k++) {
          const key = item(depth + 1);
          if (typeof key !== 'string' && typeof key !== 'number') throw new CborError('CBOR: unsupported map key');
          if (typeof key !== 'string') textOnly = false;
          m.set(key, item(depth + 1));
        }
        return textOnly ? Object.fromEntries(m as Map<string, CborValue>) : m;
      }
      case 6:
        arg(info); // the tag number: not kept
        return item(depth + 1);
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22 || info === 23) return null;
        throw new CborError('CBOR: floats and other simple values are not used');
      default:
        throw new CborError('CBOR: bad major type');
    }
  };
  const v = item(0);
  if (i !== buf.length) throw new CborError('CBOR: trailing bytes');
  return v;
}

// ---------- JUMBF (ISO 19566-5) ----------

const uuidOf = (ascii: string): Buffer => Buffer.concat([Buffer.from(ascii, 'latin1'), Buffer.from('001100108000' + '00AA00389B71', 'hex')]);
/** The C2PA and JUMBF content-type UUIDs: four ASCII bytes, then the ISO 19566-5 suffix. */
export const UUID = {
  manifestStore: uuidOf('c2pa'),
  manifest: uuidOf('c2ma'),
  assertionStore: uuidOf('c2as'),
  claim: uuidOf('c2cl'),
  claimSignature: uuidOf('c2cs'),
  cbor: uuidOf('cbor'),
  json: uuidOf('json')
} as const;

export interface JumbfBox {
  type: string;
  /** The bytes after the 8-byte header. */
  data: Buffer;
  /** Offset of this box's header in the buffer it was read from. */
  offset: number;
  /** For a superbox: its description and children. */
  uuid?: Buffer;
  label?: string;
  children?: JumbfBox[];
}

const box = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(8 + data.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data]);
};
const description = (uuid: Buffer, label: string): Buffer => box('jumd', Buffer.concat([uuid, Buffer.from([0x03]), Buffer.from(label, 'utf8'), Buffer.from([0])]));
export const superbox = (uuid: Buffer, label: string, children: Buffer[]): Buffer => box('jumb', Buffer.concat([description(uuid, label), ...children]));
export const cborBox = (v: CborValue): Buffer => box('cbor', cborEncode(v));
export const jsonBox = (v: unknown): Buffer => box('json', Buffer.from(JSON.stringify(v), 'utf8'));

/** Reads consecutive boxes; a `jumb` box is parsed into its description and children. */
export function readBoxes(buf: Buffer, base = 0): JumbfBox[] {
  const out: JumbfBox[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i);
    if (len < 8 || i + len > buf.length) throw new Error('JUMBF: bad box length');
    const type = buf.subarray(i + 4, i + 8).toString('latin1');
    const data = buf.subarray(i + 8, i + len);
    const b: JumbfBox = { type, data, offset: base + i };
    if (type === 'jumb') {
      const inner = readBoxes(data, base + i + 8);
      const d = inner[0];
      if (!d || d.type !== 'jumd' || d.data.length < 17) throw new Error('JUMBF: a superbox starts with its description');
      b.uuid = d.data.subarray(0, 16);
      const toggles = d.data[16]!;
      if (toggles & 0x02) {
        const end = d.data.indexOf(0, 17);
        b.label = d.data.subarray(17, end < 0 ? d.data.length : end).toString('utf8');
      }
      b.children = inner.slice(1);
    }
    out.push(b);
    i += len;
  }
  return out;
}

export const child = (b: JumbfBox | undefined, label: string): JumbfBox | undefined => b?.children?.find((c) => c.label === label);
/** The content box of an assertion, claim or signature superbox: the first non-description child. */
const content = (b: JumbfBox | undefined): JumbfBox | undefined => b?.children?.[0];
const sha256 = (b: Buffer): Buffer => createHash('sha256').update(b).digest();
/** The bytes a hashed URI covers: the content box of the referenced superbox, header included. */
const contentBytes = (b: JumbfBox): Buffer => {
  const c = content(b);
  if (!c) throw new Error('JUMBF: an empty superbox');
  return Buffer.concat([headerOf(c), c.data]);
};
const headerOf = (c: JumbfBox): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(8 + c.data.length);
  return Buffer.concat([len, Buffer.from(c.type, 'latin1')]);
};

// ---------- PNG embedding ----------

const CHUNK = 'caBX';
const IEND = Buffer.from('IEND', 'latin1');

/** Where a manifest store chunk would go (just before IEND), and the chunk the file already carries, if any. */
export function locateChunk(png: Buffer): { iend: number; existing: { start: number; length: number } | null } {
  if (!isPng(png)) throw new Error('Not a PNG');
  let i = 8;
  let existing: { start: number; length: number } | null = null;
  while (i + 12 <= png.length) {
    const len = png.readUInt32BE(i);
    const type = png.subarray(i + 4, i + 8).toString('latin1');
    if (type === CHUNK) existing = { start: i, length: 12 + len };
    if (type === 'IEND') return { iend: i, existing };
    i += 12 + len;
  }
  const iend = png.lastIndexOf(IEND) - 4;
  if (iend < 8) throw new Error('PNG has no IEND chunk');
  return { iend, existing };
}

/** Removes an existing `caBX` chunk (a re-signed file carries one manifest store). */
export function withoutManifest(png: Buffer): Buffer {
  const { existing } = locateChunk(png);
  if (!existing) return png;
  return Buffer.concat([png.subarray(0, existing.start), png.subarray(existing.start + existing.length)]);
}

const chunkOf = (payload: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length);
  const body = Buffer.concat([Buffer.from(CHUNK, 'latin1'), payload]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** The SHA-256 of the file with the byte ranges in `exclusions` left out. */
export function hashWithExclusions(file: Buffer, exclusions: { start: number; length: number }[]): Buffer {
  const h = createHash('sha256');
  let at = 0;
  for (const e of [...exclusions].sort((a, b) => a.start - b.start)) {
    if (e.start < at) throw new Error('C2PA: overlapping exclusions');
    h.update(file.subarray(at, e.start));
    at = e.start + e.length;
  }
  h.update(file.subarray(at));
  return h.digest();
}

// ---------- building a manifest ----------

export interface GenerationInfo {
  job: string;
  tenant: string;
  tenantName: string | null;
  workspace: string | null;
  user: string;
  username: string;
  model: string | null;
  profile: string | null;
  backend: string;
  seed: number;
  steps: number;
  width: number;
  height: number;
  promptSha256: string;
  label: string;
  createdAt: string;
  generator: string;
}

export interface ClaimSigner {
  /** ES256 over the Sig_structure bytes; the result is raw r || s (64 bytes). */
  sign(data: Buffer): Promise<Buffer>;
  /** The signing certificate first, then its chain up to (not including) the trusted root, DER. */
  chain: Buffer[];
}

export const DIGITAL_SOURCE_TYPE = 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia';
const ALG_ES256 = -7;
const HEADER_ALG = 1;
const HEADER_X5CHAIN = 33;

function buildStore(info: GenerationInfo, dataHash: Buffer, exclusion: { start: number; length: number }, signature: Buffer, chain: Buffer[], ids: { label: string; instanceId: string }): { store: Buffer; claimBytes: Buffer; sigStructure: Buffer } {
  const actions = cborBox({
    actions: [
      {
        action: 'c2pa.created',
        when: info.createdAt,
        softwareAgent: info.generator,
        digitalSourceType: DIGITAL_SOURCE_TYPE,
        parameters: { 'io.exprsn.job': info.job, ...(info.model ? { 'io.exprsn.model': info.model } : {}) }
      }
    ]
  });
  const hashData = cborBox({ exclusions: [{ start: exclusion.start, length: exclusion.length }], name: 'jumbf manifest', alg: 'sha256', hash: dataHash, pad: Buffer.alloc(0) });
  const generation = jsonBox({
    'io.exprsn.generation': {
      job: info.job,
      tenant: info.tenant,
      tenantName: info.tenantName,
      workspace: info.workspace,
      user: info.user,
      username: info.username,
      model: info.model,
      profile: info.profile,
      backend: info.backend,
      seed: info.seed,
      steps: info.steps,
      width: info.width,
      height: info.height,
      promptSha256: info.promptSha256,
      label: info.label,
      time: info.createdAt
    }
  });
  const assertions: [string, Buffer, Buffer][] = [
    ['c2pa.actions', UUID.cbor, actions],
    ['c2pa.hash.data', UUID.cbor, hashData],
    ['io.exprsn.generation', UUID.json, generation]
  ];
  const assertionStore = superbox(UUID.assertionStore, 'c2pa.assertions', assertions.map(([label, uuid, content]) => superbox(uuid, label, [content])));
  const claim = {
    'dc:title': `Exprsn-AI image ${info.job}`,
    'dc:format': 'image/png',
    instanceID: ids.instanceId,
    claim_generator: info.generator.replace(/\s+/g, '_'),
    claim_generator_info: [{ name: info.generator.split('/')[0] ?? info.generator, version: info.generator.split('/')[1] ?? '' }],
    signature: 'self#jumbf=c2pa.signature',
    assertions: assertions.map(([label, , content]) => ({ url: `self#jumbf=c2pa.assertions/${label}`, hash: sha256(content) })),
    alg: 'sha256'
  };
  const claimBytes = cborEncode(claim);
  const protectedHeader = cborEncode(new Map<number, CborValue>([[HEADER_ALG, ALG_ES256], [HEADER_X5CHAIN, chain]]));
  const sigStructure = cborEncode(['Signature1', protectedHeader, Buffer.alloc(0), claimBytes]);
  const cose = cborEncode([protectedHeader, new Map<number, CborValue>(), null, signature]);
  const manifest = superbox(UUID.manifest, ids.label, [assertionStore, superbox(UUID.claim, 'c2pa.claim', [box('cbor', claimBytes)]), superbox(UUID.claimSignature, 'c2pa.signature', [box('cbor', cose)])]);
  return { store: superbox(UUID.manifestStore, 'c2pa', [manifest]), claimBytes, sigStructure };
}

/**
 * Signs a PNG: the manifest store goes into a `caBX` chunk before IEND, and its data hash covers every other byte.
 * The chunk's size does not depend on the hash or the signature (both fixed length), so one dry run finds where the
 * chunk sits and how long it is, the hash is taken with that range excluded, and the signed store is the same size.
 */
export async function signPng(png: Buffer, info: GenerationInfo, signer: ClaimSigner): Promise<{ png: Buffer; label: string; instanceId: string; signedAt: string }> {
  if (signer.chain.length === 0) throw new Error('C2PA: a signing certificate is needed');
  const base = withoutManifest(png);
  const { iend } = locateChunk(base);
  const ids = { label: `urn:uuid:${randomUUID()}`, instanceId: `xmp:iid:${randomUUID()}` };
  // The chunk's length is itself in the manifest (as a CBOR integer whose width depends on its value): settle it.
  let exclusion = { start: iend, length: 0 };
  let dry = buildStore(info, Buffer.alloc(32), exclusion, Buffer.alloc(64), signer.chain, ids);
  for (let i = 0; i < 4 && exclusion.length !== 12 + dry.store.length; i++) {
    exclusion = { start: iend, length: 12 + dry.store.length };
    dry = buildStore(info, Buffer.alloc(32), exclusion, Buffer.alloc(64), signer.chain, ids);
  }
  if (exclusion.length !== 12 + dry.store.length) throw new Error('C2PA: the manifest size did not settle');
  const dataHash = hashWithExclusions(Buffer.concat([base.subarray(0, iend), Buffer.alloc(exclusion.length), base.subarray(iend)]), [exclusion]);
  const unsigned = buildStore(info, dataHash, exclusion, Buffer.alloc(64), signer.chain, ids);
  const signature = await signer.sign(unsigned.sigStructure);
  if (signature.length !== 64) throw new Error('C2PA: ES256 signatures are 64 bytes');
  const signed = buildStore(info, dataHash, exclusion, signature, signer.chain, ids);
  if (signed.store.length !== dry.store.length) throw new Error('C2PA: the manifest store changed size while signing');
  return { png: Buffer.concat([base.subarray(0, iend), chunkOf(signed.store), base.subarray(iend)]), label: ids.label, instanceId: ids.instanceId, signedAt: info.createdAt };
}

// ---------- reading and verifying ----------

export interface ReadManifest {
  label: string;
  claim: Record<string, CborValue>;
  claimBytes: Buffer;
  assertions: { label: string; box: JumbfBox; value: CborValue | unknown }[];
  signature: { protected: Map<number, CborValue>; protectedBytes: Buffer; signature: Buffer; chain: Buffer[] };
  chunk: { start: number; length: number };
}

const asMap = (v: CborValue): Map<number | string, CborValue> => (v instanceof Map ? v : typeof v === 'object' && v !== null && !Buffer.isBuffer(v) && !Array.isArray(v) ? new Map(Object.entries(v)) : new Map());

/** Reads the manifest store a PNG carries; null when it carries none. */
export function readPng(png: Buffer): ReadManifest | null {
  const { existing } = locateChunk(png);
  if (!existing) return null;
  const payload = png.subarray(existing.start + 8, existing.start + existing.length - 4);
  const [store] = readBoxes(payload, existing.start + 8);
  if (!store || store.type !== 'jumb' || !store.uuid?.equals(UUID.manifestStore)) throw new Error('C2PA: the caBX chunk holds no manifest store');
  const manifest = store.children?.find((c) => c.uuid?.equals(UUID.manifest));
  if (!manifest?.label) throw new Error('C2PA: no manifest in the store');
  const claimBox = content(child(manifest, 'c2pa.claim'));
  const sigBox = content(child(manifest, 'c2pa.signature'));
  const assertionStore = child(manifest, 'c2pa.assertions');
  if (!claimBox || !sigBox || !assertionStore) throw new Error('C2PA: the manifest lacks a claim, a signature or its assertions');
  const claim = cborDecode(claimBox.data);
  if (typeof claim !== 'object' || claim === null || claim instanceof Map || Array.isArray(claim) || Buffer.isBuffer(claim)) throw new Error('C2PA: the claim is not a map');
  const cose = cborDecode(sigBox.data);
  if (!Array.isArray(cose) || cose.length !== 4 || !Buffer.isBuffer(cose[0]) || !Buffer.isBuffer(cose[3])) throw new Error('C2PA: the signature is not a COSE_Sign1');
  const prot = asMap(cborDecode(cose[0])) as Map<number, CborValue>;
  const chainRaw = prot.get(HEADER_X5CHAIN);
  const chain = (Array.isArray(chainRaw) ? chainRaw : Buffer.isBuffer(chainRaw) ? [chainRaw] : []).filter((c): c is Buffer => Buffer.isBuffer(c));
  const assertions = (assertionStore.children ?? []).map((b) => {
    const c = content(b);
    const value = c?.type === 'cbor' ? cborDecode(c.data) : c?.type === 'json' ? (JSON.parse(c.data.toString('utf8')) as unknown) : null;
    return { label: b.label ?? '', box: b, value };
  });
  return { label: manifest.label, claim: claim as Record<string, CborValue>, claimBytes: claimBox.data, assertions, signature: { protected: prot, protectedBytes: cose[0], signature: cose[3], chain }, chunk: existing };
}

export interface VerifyResult {
  present: boolean;
  verified: boolean;
  checks: { claimHashes: boolean; dataHash: boolean; signature: boolean; chain: boolean; anchor: boolean | null; certificateValid: boolean };
  problems: string[];
  manifest: { label: string; generator: string | null; instanceId: string | null; created: string | null; action: string | null; model: string | null; profile: string | null; tenant: string | null; tenantName: string | null; job: string | null } | null;
  signer: { subject: string; issuer: string; fingerprint: string; notBefore: string; notAfter: string } | null;
}

const none: VerifyResult['checks'] = { claimHashes: false, dataHash: false, signature: false, chain: false, anchor: null, certificateValid: false };

/** ES256 signature bytes from the raw r || s form to DER, as node's `verify` wants it. */
export function rawToDer(sig: Buffer): Buffer {
  const int = (b: Buffer): Buffer => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0 && (b[i + 1]! & 0x80) === 0) i++;
    let v = b.subarray(i);
    if (v[0]! & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
    return Buffer.concat([Buffer.from([0x02, v.length]), v]);
  };
  const body = Buffer.concat([int(sig.subarray(0, 32)), int(sig.subarray(32))]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

/** ES256 signature bytes from DER to the raw r || s form COSE uses. */
export function derToRaw(der: Buffer): Buffer {
  if (der[0] !== 0x30) throw new Error('C2PA: not a DER ECDSA signature');
  let i = 2;
  const read = (): Buffer => {
    if (der[i] !== 0x02) throw new Error('C2PA: not a DER ECDSA signature');
    const n = der[i + 1]!;
    let v = der.subarray(i + 2, i + 2 + n);
    i += 2 + n;
    while (v.length > 32 && v[0] === 0) v = v.subarray(1);
    return Buffer.concat([Buffer.alloc(32 - v.length), v]);
  };
  const r = read();
  const s = read();
  return Buffer.concat([r, s]);
}

/**
 * Verifies a PNG's content credentials: every hashed assertion matches the claim, the data hash covers the file,
 * the COSE signature verifies with the leaf certificate, each certificate is signed by the next, and (when anchors
 * are given) the chain ends at a trusted certificate. Nothing here needs the database.
 */
export function verifyPng(png: Buffer, o: { anchors?: Buffer[]; at?: number } = {}): VerifyResult {
  let read: ReadManifest | null;
  try {
    read = readPng(png);
  } catch (err) {
    return { present: true, verified: false, checks: none, problems: [(err as Error).message], manifest: null, signer: null };
  }
  if (!read) return { present: false, verified: false, checks: none, problems: ['The image carries no C2PA manifest.'], manifest: null, signer: null };
  const problems: string[] = [];
  const checks = { ...none };

  // 1. The claim's hashed URIs name the assertions and match their bytes.
  const refs = Array.isArray(read.claim.assertions) ? (read.claim.assertions as CborValue[]) : [];
  const byLabel = new Map(read.assertions.map((a) => [a.label, a]));
  let hashesOk = refs.length > 0;
  for (const ref of refs) {
    const r = asMap(ref);
    const url = String(r.get('url') ?? '');
    const hash = r.get('hash');
    const label = url.replace(/^self#jumbf=c2pa\.assertions\//, '');
    const a = byLabel.get(label);
    if (!a || !Buffer.isBuffer(hash) || !sha256(contentBytes(a.box)).equals(hash)) {
      hashesOk = false;
      problems.push(`The assertion ${label} does not match the claim.`);
    }
  }
  checks.claimHashes = hashesOk;

  // 2. The data hash: the file without the manifest chunk.
  const hd = byLabel.get('c2pa.hash.data')?.value;
  const hdMap = asMap(hd as CborValue);
  const exclusions = (Array.isArray(hdMap.get('exclusions')) ? (hdMap.get('exclusions') as CborValue[]) : []).map((e) => {
    const m = asMap(e);
    return { start: Number(m.get('start')), length: Number(m.get('length')) };
  });
  const expected = hdMap.get('hash');
  if (Buffer.isBuffer(expected) && exclusions.length) {
    const coversChunk = exclusions.some((e) => e.start === read!.chunk.start && e.length === read!.chunk.length);
    checks.dataHash = coversChunk && hashWithExclusions(png, exclusions).equals(expected);
    if (!checks.dataHash) problems.push(coversChunk ? 'The image bytes do not match the manifest’s data hash.' : 'The data hash does not exclude the manifest chunk.');
  } else problems.push('The manifest has no data hash.');

  // 3. The signature over the claim, with the leaf certificate's key.
  const chain = read.signature.chain;
  let leaf: X509Certificate | null = null;
  let signer: VerifyResult['signer'] = null;
  try {
    leaf = chain[0] ? new X509Certificate(chain[0]) : null;
  } catch {
    problems.push('The signing certificate cannot be parsed.');
  }
  if (leaf) {
    signer = { subject: leaf.subject, issuer: leaf.issuer, fingerprint: leaf.fingerprint256.replace(/:/g, '').toLowerCase(), notBefore: new Date(leaf.validFrom).toISOString(), notAfter: new Date(leaf.validTo).toISOString() };
    const alg = read.signature.protected.get(HEADER_ALG);
    if (alg !== ALG_ES256) problems.push(`Unsupported signature algorithm ${String(alg)}.`);
    else {
      const sigStructure = cborEncode(['Signature1', read.signature.protectedBytes, Buffer.alloc(0), read.claimBytes]);
      try {
        checks.signature = read.signature.signature.length === 64 && cryptoVerify('sha256', sigStructure, { key: leaf.publicKey, dsaEncoding: 'der' }, rawToDer(read.signature.signature));
      } catch {
        checks.signature = false;
      }
      if (!checks.signature) problems.push('The claim signature does not verify.');
    }
    const at = o.at ?? Date.now();
    checks.certificateValid = new Date(leaf.validFrom).getTime() <= at && new Date(leaf.validTo).getTime() >= at;
    if (!checks.certificateValid) problems.push('The signing certificate was not valid at that time.');
  } else problems.push('The signature carries no certificate chain.');

  // 4. Each certificate is issued by the next; the last by an anchor when anchors are given.
  let chainOk = !!leaf;
  const certs: X509Certificate[] = [];
  for (const der of chain) {
    try {
      certs.push(new X509Certificate(der));
    } catch {
      chainOk = false;
    }
  }
  for (let i = 0; chainOk && i + 1 < certs.length; i++) {
    if (!certs[i]!.checkIssued(certs[i + 1]!) || !certs[i]!.verify(certs[i + 1]!.publicKey)) {
      chainOk = false;
      problems.push(`Certificate ${i + 1} in the chain was not issued by certificate ${i + 2}.`);
    }
  }
  checks.chain = chainOk;
  if (o.anchors && certs.length) {
    const last = certs[certs.length - 1]!;
    const anchors = o.anchors.map((a) => new X509Certificate(a));
    checks.anchor = anchors.some((a) => (last.fingerprint256 === a.fingerprint256 && last.verify(a.publicKey)) || (last.checkIssued(a) && last.verify(a.publicKey)));
    if (!checks.anchor) problems.push('The chain does not end at a trusted certificate.');
  }

  const gen = (byLabel.get('io.exprsn.generation')?.value as { 'io.exprsn.generation'?: Record<string, unknown> } | null)?.['io.exprsn.generation'] ?? null;
  const actions = asMap(byLabel.get('c2pa.actions')?.value as CborValue).get('actions');
  const first = Array.isArray(actions) ? asMap(actions[0] as CborValue) : new Map();
  const verified = checks.claimHashes && checks.dataHash && checks.signature && checks.chain && checks.certificateValid && checks.anchor !== false;
  return {
    present: true,
    verified,
    checks,
    problems,
    manifest: {
      label: read.label,
      generator: typeof read.claim.claim_generator === 'string' ? read.claim.claim_generator : null,
      instanceId: typeof read.claim.instanceID === 'string' ? read.claim.instanceID : null,
      created: typeof first.get('when') === 'string' ? String(first.get('when')) : null,
      action: typeof first.get('action') === 'string' ? String(first.get('action')) : null,
      model: typeof gen?.model === 'string' ? gen.model : null,
      profile: typeof gen?.profile === 'string' ? gen.profile : null,
      tenant: typeof gen?.tenant === 'string' ? gen.tenant : null,
      tenantName: typeof gen?.tenantName === 'string' ? gen.tenantName : null,
      job: typeof gen?.job === 'string' ? gen.job : null
    },
    signer
  };
}

/** The public key of a DER certificate (for callers that sign in tests). */
export const publicKeyOf = (der: Buffer): KeyObject => createPublicKey(new X509Certificate(der).publicKey);
