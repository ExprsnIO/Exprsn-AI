import { createHash, createHmac, createPublicKey, sign as cryptoSign, timingSafeEqual, verify as cryptoVerify, type KeyObject } from 'node:crypto';

/*
 * HTTP Message Signatures (RFC 9421) and Content-Digest (RFC 9530), Sprint 20 (B-1203). A deliberately small subset:
 *
 *   components  @method, @target-uri, @authority, @path, @query, and header fields by (lower-case) name, with no
 *               component parameters (no ;sf, ;key, ;bs, ;req)
 *   parameters  created (required when verifying), expires, keyid, alg, nonce, tag
 *   algorithms  ed25519 and hmac-sha256
 *   digests     sha-256 and sha-512 in Content-Digest
 *
 * The structured-field parsing (RFC 8941) covers what Signature-Input, Signature and Content-Digest use: dictionaries
 * whose members are inner lists of strings with parameters, or byte sequences.
 */

export type SigAlg = 'ed25519' | 'hmac-sha256';

type Bare = string | number | boolean | Buffer | { token: string };
interface Item {
  value: Bare;
  params: [string, Bare][];
}
interface InnerList {
  list: Item[];
  params: [string, Bare][];
}
type Member = Item | InnerList;

export class StructuredFieldError extends Error {}

/** Parses an RFC 8941 dictionary (enough of it for message signatures and digests). */
export function parseDictionary(input: string): Map<string, { member: Member; raw: string }> {
  const s = input;
  let i = 0;
  const ws = () => {
    while (s[i] === ' ' || s[i] === '\t') i++;
  };
  const fail = (m: string): never => {
    throw new StructuredFieldError(m);
  };
  const key = (): string => {
    const m = /^[a-z*][a-z0-9_\-.*]*/.exec(s.slice(i));
    if (!m) fail('Expected a key');
    i += m![0].length;
    return m![0];
  };
  const bare = (): Bare => {
    const c = s[i];
    if (c === '"') {
      i++;
      let out = '';
      for (;;) {
        if (i >= s.length) fail('Unterminated string');
        const ch = s[i++]!;
        if (ch === '\\') {
          const n = s[i++];
          if (n !== '"' && n !== '\\') fail('Bad escape in string');
          out += n;
        } else if (ch === '"') return out;
        else if (ch < ' ' || ch > '~') fail('Bad character in string');
        else out += ch;
      }
    }
    if (c === ':') {
      const end = s.indexOf(':', i + 1);
      if (end < 0) fail('Unterminated byte sequence');
      const b = s.slice(i + 1, end);
      if (!/^[A-Za-z0-9+/=]*$/.test(b)) fail('Bad byte sequence');
      i = end + 1;
      return Buffer.from(b, 'base64');
    }
    if (c === '?') {
      const v = s[i + 1];
      if (v !== '0' && v !== '1') fail('Bad boolean');
      i += 2;
      return v === '1';
    }
    const num = /^-?\d{1,15}(\.\d{1,3})?/.exec(s.slice(i));
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    const tok = /^[A-Za-z*][A-Za-z0-9!#$%&'*+\-.^_`|~:/]*/.exec(s.slice(i));
    if (tok) {
      i += tok[0].length;
      return { token: tok[0] };
    }
    return fail('Expected a value');
  };
  const params = (): [string, Bare][] => {
    const out: [string, Bare][] = [];
    while (s[i] === ';') {
      i++;
      ws();
      const k = key();
      let v: Bare = true;
      if (s[i] === '=') {
        i++;
        v = bare();
      }
      out.push([k, v]);
    }
    return out;
  };
  const member = (): Member => {
    if (s[i] === '(') {
      i++;
      const list: Item[] = [];
      for (;;) {
        ws();
        if (s[i] === ')') {
          i++;
          break;
        }
        if (i >= s.length) fail('Unterminated inner list');
        const value = bare();
        list.push({ value, params: params() });
        if (s[i] !== ' ' && s[i] !== ')') fail('Expected a space or ) in an inner list');
      }
      return { list, params: params() };
    }
    const value = bare();
    return { value, params: params() };
  };
  const out = new Map<string, { member: Member; raw: string }>();
  ws();
  while (i < s.length) {
    const k = key();
    let m: Member;
    const start = i;
    if (s[i] === '=') {
      i++;
      m = member();
    } else m = { value: true, params: params() };
    out.set(k, { member: m, raw: s.slice(s[start] === '=' ? start + 1 : start, i) });
    ws();
    if (i >= s.length) break;
    if (s[i] !== ',') fail('Expected a comma between members');
    i++;
    ws();
    if (i >= s.length) fail('Trailing comma');
  }
  return out;
}

const serializeBare = (v: Bare): string => {
  if (typeof v === 'string') return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '?1' : '?0';
  if (Buffer.isBuffer(v)) return `:${v.toString('base64')}:`;
  return v.token;
};
const serializeParams = (p: [string, Bare][]): string => p.map(([k, v]) => (v === true ? `;${k}` : `;${k}=${serializeBare(v)}`)).join('');

/** The canonical serialization of a signature's component list and parameters (the `@signature-params` value). */
export function serializeSignatureParams(components: string[], params: [string, Bare][]): string {
  return `(${components.map((c) => serializeBare(c)).join(' ')})${serializeParams(params)}`;
}

// ---------- Content-Digest (RFC 9530) ----------

export const contentDigest = (body: Buffer | string): string => `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;

/** True when the Content-Digest header carries a sha-256 or sha-512 digest that matches the body (and none that fails). */
export function checkContentDigest(header: string | undefined, body: Buffer | string): boolean {
  if (!header) return false;
  let dict: Map<string, { member: Member }>;
  try {
    dict = parseDictionary(header);
  } catch {
    return false;
  }
  let matched = false;
  for (const [alg, { member }] of dict) {
    if (alg !== 'sha-256' && alg !== 'sha-512') continue;
    if (!('value' in member) || !Buffer.isBuffer(member.value)) return false;
    const want = createHash(alg === 'sha-256' ? 'sha256' : 'sha512').update(body).digest();
    if (member.value.length !== want.length || !timingSafeEqual(member.value, want)) return false;
    matched = true;
  }
  return matched;
}

// ---------- signature base ----------

export interface HttpMessage {
  method: string;
  /** The full target URI, as the client addressed it. */
  url: string;
  headers: Record<string, string | string[] | number | undefined>;
}

export class SignatureError extends Error {}

function componentValue(msg: HttpMessage, name: string): string {
  const u = new URL(msg.url);
  switch (name) {
    case '@method':
      return msg.method.toUpperCase();
    case '@target-uri':
      return u.href;
    case '@authority':
      return u.host.toLowerCase();
    case '@scheme':
      return u.protocol.replace(/:$/, '').toLowerCase();
    case '@path':
      return u.pathname || '/';
    case '@query':
      return u.search || '?';
    case '@request-target':
      return `${u.pathname}${u.search}`;
  }
  if (name.startsWith('@')) throw new SignatureError(`Unsupported derived component ${name}`);
  if (!/^[a-z0-9!#$%&'*+\-.^_`|~]+$/.test(name)) throw new SignatureError(`Invalid component name ${name}`);
  const h = msg.headers[name];
  if (h === undefined) throw new SignatureError(`The signed header ${name} is missing`);
  return (Array.isArray(h) ? h : [String(h)]).map((v) => v.trim().replace(/\s*\r?\n\s*/g, ' ')).join(', ');
}

/** The signature base (RFC 9421 section 2.5) for these components and the serialized signature parameters. */
export function signatureBase(msg: HttpMessage, components: string[], signatureParams: string): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const c of components) {
    if (seen.has(c)) throw new SignatureError(`Component ${c} is listed twice`);
    seen.add(c);
    lines.push(`"${c}": ${componentValue(msg, c)}`);
  }
  lines.push(`"@signature-params": ${signatureParams}`);
  return lines.join('\n');
}

// ---------- signing ----------

export interface SignOptions {
  label?: string;
  components: string[];
  keyid: string;
  alg: SigAlg;
  /** An Ed25519 private key or HMAC secret; or `signer` for a key held elsewhere (the KMS, the signer process). */
  key?: KeyObject | Buffer | string;
  signer?: (base: Buffer) => Promise<Buffer>;
  created?: number;
  expires?: number;
  nonce?: string;
  tag?: string;
}

/** Signs a message: returns the `Signature-Input` and `Signature` header values to add. */
export async function signMessage(msg: HttpMessage, o: SignOptions): Promise<{ 'signature-input': string; signature: string }> {
  const label = o.label ?? 'sig1';
  const params: [string, Bare][] = [['created', o.created ?? Math.floor(Date.now() / 1000)]];
  if (o.expires != null) params.push(['expires', o.expires]);
  if (o.nonce) params.push(['nonce', o.nonce]);
  params.push(['keyid', o.keyid], ['alg', o.alg]);
  if (o.tag) params.push(['tag', o.tag]);
  const sp = serializeSignatureParams(o.components, params);
  const base = Buffer.from(signatureBase(msg, o.components, sp), 'utf8');
  let sig: Buffer;
  if (o.signer) sig = await o.signer(base);
  else if (o.alg === 'hmac-sha256') sig = createHmac('sha256', o.key as Buffer | string).update(base).digest();
  else sig = cryptoSign(null, base, o.key as KeyObject);
  return { 'signature-input': `${label}=${sp}`, signature: `${label}=:${sig.toString('base64')}:` };
}

// ---------- verification ----------

export interface VerifyKey {
  alg: SigAlg;
  /** Ed25519 public key, or the HMAC secret. */
  key: KeyObject | Buffer | string;
}

export interface VerifyOptions {
  /** The key for a keyid (and the alg the signature names, if any), or null when unknown. */
  keyFor(keyid: string | null, alg: string | null): Promise<VerifyKey | null> | VerifyKey | null;
  /** Components every accepted signature must cover. */
  required: string[];
  maxAgeSeconds: number;
  now?: number;
}

export type VerifyResult = { ok: true; label: string; keyid: string | null; components: string[] } | { ok: false; reason: string };

const header1 = (msg: HttpMessage, name: string): string | undefined => {
  const h = msg.headers[name];
  return h === undefined ? undefined : Array.isArray(h) ? h.join(', ') : String(h);
};

/** Verifies the message's signatures: one that covers the required components and verifies with its key is enough. */
export async function verifyMessage(msg: HttpMessage, o: VerifyOptions): Promise<VerifyResult> {
  const input = header1(msg, 'signature-input');
  const sigs = header1(msg, 'signature');
  if (!input || !sigs) return { ok: false, reason: 'The request carries no Signature-Input and Signature headers.' };
  let inputs: Map<string, { member: Member; raw: string }>;
  let values: Map<string, { member: Member; raw: string }>;
  try {
    inputs = parseDictionary(input);
    values = parseDictionary(sigs);
  } catch (err) {
    return { ok: false, reason: `The signature headers are malformed: ${(err as Error).message}.` };
  }
  const now = Math.floor((o.now ?? Date.now()) / 1000);
  let reason = 'No signature label in Signature-Input has a matching Signature.';
  for (const [label, { member }] of inputs) {
    const sv = values.get(label)?.member;
    if (!sv || !('value' in sv) || !Buffer.isBuffer(sv.value)) continue;
    if (!('list' in member)) {
      reason = `Signature-Input ${label} is not an inner list.`;
      continue;
    }
    if (member.list.some((c) => typeof c.value !== 'string' || c.params.length)) {
      reason = `Signature-Input ${label} names a component this server does not support (component parameters).`;
      continue;
    }
    const components = member.list.map((c) => c.value as string);
    const missing = o.required.filter((r) => !components.includes(r));
    if (missing.length) {
      reason = `The signature must cover ${missing.join(', ')}.`;
      continue;
    }
    const p = new Map(member.params);
    const created = p.get('created');
    if (typeof created !== 'number') {
      reason = 'The signature has no created parameter.';
      continue;
    }
    if (Math.abs(now - created) > o.maxAgeSeconds) {
      reason = `The signature was created ${now - created} seconds from now; at most ${o.maxAgeSeconds} are allowed.`;
      continue;
    }
    const expires = p.get('expires');
    if (typeof expires === 'number' && now > expires) {
      reason = 'The signature has expired.';
      continue;
    }
    const keyid = typeof p.get('keyid') === 'string' ? (p.get('keyid') as string) : null;
    const alg = typeof p.get('alg') === 'string' ? (p.get('alg') as string) : null;
    const k = await o.keyFor(keyid, alg);
    if (!k) {
      reason = 'The signing key is not known.';
      continue;
    }
    if (alg && alg !== k.alg) {
      reason = `The signature names ${alg}; the key is ${k.alg}.`;
      continue;
    }
    let base: Buffer;
    try {
      base = Buffer.from(signatureBase(msg, components, serializeSignatureParams(components, member.params)), 'utf8');
    } catch (err) {
      reason = (err as Error).message + '.';
      continue;
    }
    let good: boolean;
    if (k.alg === 'hmac-sha256') {
      const want = createHmac('sha256', k.key as Buffer | string).update(base).digest();
      good = want.length === sv.value.length && timingSafeEqual(want, sv.value);
    } else {
      try {
        good = cryptoVerify(null, base, k.key as KeyObject, sv.value);
      } catch {
        good = false;
      }
    }
    if (good) return { ok: true, label, keyid, components };
    reason = 'The signature does not verify.';
  }
  return { ok: false, reason };
}

/** An Ed25519 public key from its JWK `x` (base64url of the 32 raw bytes), or an SPKI PEM. */
export function ed25519PublicKey(text: string): KeyObject {
  const t = text.trim();
  if (t.includes('BEGIN PUBLIC KEY')) {
    const k = createPublicKey(t);
    if (k.asymmetricKeyType !== 'ed25519') throw new SignatureError('The public key is not an Ed25519 key.');
    return k;
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(t)) throw new SignatureError('Give the Ed25519 public key as its JWK x value (43 base64url characters) or as a PEM.');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: t }, format: 'jwk' });
}
