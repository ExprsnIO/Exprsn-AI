import { fetch as undiciFetch, type Dispatcher } from 'undici';
import { literalProblem, serviceAgent, ServiceUrlRefused, type ServicePolicy } from '../platform/egress.js';
import { cborEncode } from './cbor.js';
import { parseDidKey, parseMultikey, verifySignature, type Curve } from './crypto.js';
import { base32Encode, Cid, sha256 } from './encoding.js';
import type { KeyObject } from 'node:crypto';

/*
 * DIDs for AT-Protocol (B-1609, B-1611): DID documents, did:web addresses, did:plc operations, and resolution of other
 * parties' DIDs through the service URL checks (B-901).
 *
 * did:plc (https://web.plc.directory/spec/v0.1/did-plc): an operation is a DAG-CBOR map signed (ECDSA-SHA256, low-S,
 * compact, base64url without padding in `sig`) by one of the rotation keys in force; the DID is `did:plc:` and the
 * first 24 characters of base32(sha256(DAG-CBOR of the signed genesis operation)); each later operation names its
 * predecessor's CID (CIDv1, dag-cbor, sha2-256) in `prev` and is signed by a rotation key of that predecessor.
 */

export const DID_CONTEXT = ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1', 'https://w3id.org/security/suites/secp256k1-2019/v1'];

export interface PlcService {
  type: string;
  endpoint: string;
}

export interface PlcOperation {
  type: 'plc_operation';
  rotationKeys: string[];
  verificationMethods: Record<string, string>;
  alsoKnownAs: string[];
  services: Record<string, PlcService>;
  prev: string | null;
  sig?: string;
}

export interface DidDocument {
  '@context': string[];
  id: string;
  alsoKnownAs: string[];
  verificationMethod: { id: string; type: string; controller: string; publicKeyMultibase: string }[];
  service: { id: string; type: string; serviceEndpoint: string }[];
}

/** The bytes a PLC operation's signature covers: the operation without `sig`. */
export const plcSigningBytes = (op: PlcOperation): Buffer => cborEncode({ ...op, sig: undefined });

export async function signPlcOperation(op: PlcOperation, sign: (bytes: Buffer) => Promise<Buffer>): Promise<PlcOperation> {
  const sig = await sign(plcSigningBytes(op));
  return { ...op, sig: sig.toString('base64url') };
}

export function plcDidForGenesis(signed: PlcOperation): string {
  if (!signed.sig || signed.prev !== null) throw new Error('A genesis operation is signed and has no prev');
  return 'did:plc:' + base32Encode(sha256(cborEncode(signed))).slice(0, 24);
}

export const plcOperationCid = (signed: PlcOperation): string => Cid.ofCbor(cborEncode(signed)).toString();

/** True when one of `rotationKeys` (did:key) signed the operation. */
export function verifyPlcOperation(op: PlcOperation, rotationKeys: readonly string[]): boolean {
  if (!op.sig || !/^[A-Za-z0-9_-]{80,90}$/.test(op.sig)) return false;
  const sig = Buffer.from(op.sig, 'base64url');
  const bytes = plcSigningBytes(op);
  return rotationKeys.some((k) => {
    try {
      const { curve, key } = parseDidKey(k);
      return verifySignature(curve, key, bytes, sig);
    } catch {
      return false;
    }
  });
}

/** The DID document an operation describes (as a PLC directory renders it, and as did:web serves it). */
export function didDocument(did: string, o: { alsoKnownAs: string[]; verificationMethods: Record<string, string>; services: Record<string, PlcService> }): DidDocument {
  return {
    '@context': DID_CONTEXT,
    id: did,
    alsoKnownAs: o.alsoKnownAs,
    verificationMethod: Object.entries(o.verificationMethods).map(([id, key]) => ({ id: `${did}#${id}`, type: 'Multikey', controller: did, publicKeyMultibase: key.replace(/^did:key:/, '') })),
    service: Object.entries(o.services).map(([id, svc]) => ({ id: `#${id}`, type: svc.type, serviceEndpoint: svc.endpoint }))
  };
}

/** `did:web:<host>[%3A<port>][:<path segments>]` for a URL's host and a path under it. */
export function didWebFor(url: URL, path: string[] = []): string {
  const host = url.port ? `${url.hostname.toLowerCase()}%3A${url.port}` : url.hostname.toLowerCase();
  return ['did:web', host, ...path.map(encodeURIComponent)].join(':');
}

/** Where a did:web's document lives: `/.well-known/did.json` for a bare host, `/<path>/did.json` otherwise. */
export function didWebDocumentUrl(did: string, scheme: 'https' | 'http' = 'https'): string {
  const m = /^did:web:([^:]+)((?::[^:]+)*)$/.exec(did);
  if (!m) throw new Error('Not a did:web');
  const host = decodeURIComponent(m[1]!);
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(host)) throw new Error('A did:web names a host');
  const path = m[2] ? m[2].slice(1).split(':').map(decodeURIComponent) : [];
  if (path.some((p) => !p || p === '.' || p === '..' || p.includes('/'))) throw new Error('Bad did:web path');
  return path.length ? `${scheme}://${host}/${path.map(encodeURIComponent).join('/')}/did.json` : `${scheme}://${host}/.well-known/did.json`;
}

/** A labeler's signing key (`#atproto_label`) and endpoint (`#atproto_labeler`) from its DID document. */
export function labelerFromDocument(doc: unknown, did: string): { curve: Curve; key: KeyObject; multikey: string; endpoint: string | null } {
  const d = doc as Partial<DidDocument> | null;
  if (!d || typeof d !== 'object' || d.id !== did) throw new Error('The DID document does not describe this DID');
  const vm = (Array.isArray(d.verificationMethod) ? d.verificationMethod : []).find((v) => v && (v.id === '#atproto_label' || v.id === `${did}#atproto_label`));
  if (!vm || typeof vm.publicKeyMultibase !== 'string') throw new Error('The DID document has no #atproto_label key');
  const { curve, key } = parseMultikey(vm.publicKeyMultibase);
  const svc = (Array.isArray(d.service) ? d.service : []).find((x) => x && (x.id === '#atproto_labeler' || x.id === `${did}#atproto_labeler`));
  const endpoint = svc && typeof svc.serviceEndpoint === 'string' && /^https?:\/\//.test(svc.serviceEndpoint) ? svc.serviceEndpoint : null;
  return { curve, key, multikey: vm.publicKeyMultibase, endpoint };
}

const MAX_DOC_BYTES = 64 * 1024;

/**
 * Fetches JSON from another party (a PLC directory, a did:web host) through the operator service URL checks (B-901):
 * address literals are checked here and every DNS answer at connect time, redirects are refused, the body is capped.
 */
export class GuardedFetch {
  private agent: Dispatcher | null = null;

  constructor(
    private readonly policy: () => ServicePolicy,
    private readonly timeoutMs = 5000
  ) {}

  private dispatcher(): Dispatcher {
    return (this.agent ??= serviceAgent(this.policy(), {}, { headersTimeout: this.timeoutMs, bodyTimeout: this.timeoutMs }));
  }

  /**
   * Sprint 26 (B-1808): `form` posts application/x-www-form-urlencoded instead of JSON, `headers` adds request headers
   * (DPoP, authorization), and the response headers come back (a DPoP-Nonce, WWW-Authenticate).
   */
  async request(url: string, init: { method?: 'GET' | 'POST'; body?: unknown; form?: Record<string, string>; headers?: Record<string, string> } = {}): Promise<{ status: number; json: unknown; text: string; headers: Headers }> {
    const refused = literalProblem(url, this.policy());
    if (refused) throw new ServiceUrlRefused(refused);
    if (!/^https?:\/\//.test(url)) throw new ServiceUrlRefused('Only http and https addresses are fetched.');
    const res = await undiciFetch(url, {
      method: init.method ?? 'GET',
      headers: { accept: 'application/json', ...(init.form ? { 'content-type': 'application/x-www-form-urlencoded' } : init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers },
      body: init.form ? new URLSearchParams(init.form).toString() : init.body !== undefined ? JSON.stringify(init.body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
      dispatcher: this.dispatcher()
    });
    const chunks: Buffer[] = [];
    let size = 0;
    if (res.body) {
      for await (const c of res.body) {
        size += (c as Uint8Array).length;
        if (size > MAX_DOC_BYTES) throw new Error(`${url} answered with more than ${MAX_DOC_BYTES} bytes`);
        chunks.push(Buffer.from(c as Uint8Array));
      }
    }
    const text = Buffer.concat(chunks).toString('utf8');
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json, text, headers: res.headers as unknown as Headers };
  }

  async close(): Promise<void> {
    await this.agent?.close();
    this.agent = null;
  }
}

/** Resolves did:plc (through the PLC directory) and did:web (over https) to their documents. */
export class DidResolver {
  private readonly cache = new Map<string, { at: number; doc: unknown }>();

  constructor(
    private readonly http: GuardedFetch,
    private readonly plcUrl: () => string,
    private readonly ttlMs = 5 * 60_000,
    private readonly maxEntries = 1000
  ) {}

  async resolve(did: string, fresh = false): Promise<unknown> {
    const hit = this.cache.get(did);
    if (!fresh && hit && Date.now() - hit.at < this.ttlMs) return hit.doc;
    let url: string;
    if (/^did:plc:[a-z2-7]{24}$/.test(did)) url = `${this.plcUrl().replace(/\/$/, '')}/${did}`;
    else if (did.startsWith('did:web:')) url = didWebDocumentUrl(did);
    else throw new Error('Only did:plc and did:web are resolved');
    const r = await this.http.request(url);
    if (r.status !== 200 || !r.json) throw new Error(`${did} did not resolve (${r.status})`);
    if (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(did, { at: Date.now(), doc: r.json });
    return r.json;
  }
}
