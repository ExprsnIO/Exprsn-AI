import { resolveTxt } from 'node:dns';
import { ServiceUrlRefused } from '../platform/egress.js';
import type { DidDocument, GuardedFetch } from './did.js';

/*
 * AT-Protocol handles (B-1807, https://atproto.com/specs/handle). A handle is a domain name; it names a DID through a
 * DNS TXT record at `_atproto.<handle>` (`did=<did>`) or the text at `https://<handle>/.well-known/atproto-did`. The
 * HTTPS fetch goes through the service URL checks (B-901): every address the name resolves to is checked when the
 * connection is made, so a handle pointing at a link-local or cloud metadata address is refused rather than fetched,
 * and a refusal is reported as such (it never falls through to "not found"). A handle only counts for a DID when the
 * DID's document names it back (`alsoKnownAs: at://<handle>`), which `verifiedHandle` checks.
 */

export class HandleError extends Error {
  constructor(
    readonly code: 'syntax' | 'refused' | 'not_found' | 'conflict' | 'mismatch',
    message: string
  ) {
    super(message);
  }
}

/** The TLDs the specification reserves; `.test` is accepted outside production only. */
const RESERVED_TLDS = new Set(['alt', 'arpa', 'example', 'internal', 'invalid', 'local', 'localhost', 'onion']);

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** The DIDs this server resolves: did:plc and did:web. */
export const DID_RE = /^did:(plc:[a-z2-7]{24}|web:[a-z0-9.-]+(%3a\d{1,5})?(:[A-Za-z0-9._~%-]{1,100}){0,5})$/i;

export const isResolvableDid = (v: string): boolean => v.length <= 300 && DID_RE.test(v);

/** A handle in its normal form (lower case), or a HandleError('syntax'). */
export function normaliseHandle(input: string, o: { production: boolean }): string {
  const h = input.trim().replace(/^@/, '').replace(/^at:\/\//, '').toLowerCase();
  if (!h || h.length > 253) throw new HandleError('syntax', 'A handle is a domain name of at most 253 characters.');
  const labels = h.split('.');
  if (labels.length < 2 || labels.some((l) => !LABEL.test(l))) throw new HandleError('syntax', 'A handle is a domain name such as alice.example.com.');
  const tld = labels.at(-1)!;
  if (/^[0-9]/.test(tld)) throw new HandleError('syntax', 'A handle cannot end in a number.');
  if (RESERVED_TLDS.has(tld) || (tld === 'test' && o.production)) throw new HandleError('syntax', `Handles under .${tld} are not allowed.`);
  return h;
}

/** The DID a document says it is, and the handles it claims (`at://` entries of alsoKnownAs). */
export function handlesOf(doc: unknown): string[] {
  const d = doc as Partial<DidDocument> | null;
  const aka = d && Array.isArray(d.alsoKnownAs) ? d.alsoKnownAs : [];
  return aka.filter((a): a is string => typeof a === 'string' && a.startsWith('at://')).map((a) => a.slice(5).toLowerCase());
}

/** The PDS endpoint (`#atproto_pds`, type AtprotoPersonalDataServer) of a DID document, or null. */
export function pdsOf(doc: unknown, did: string): string | null {
  const d = doc as Partial<DidDocument> | null;
  if (!d || typeof d !== 'object' || d.id !== did) return null;
  const svc = (Array.isArray(d.service) ? d.service : []).find((x) => x && (x.id === '#atproto_pds' || x.id === `${did}#atproto_pds`) && x.type === 'AtprotoPersonalDataServer');
  const ep = svc && typeof svc.serviceEndpoint === 'string' ? svc.serviceEndpoint : null;
  if (!ep) return null;
  try {
    const u = new URL(ep);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.search || u.hash) return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** Unwraps undici's "fetch failed" to the service URL check that refused the connection, if that is what happened. */
export function refusalOf(err: unknown): ServiceUrlRefused | null {
  for (let e = err as { cause?: unknown } | null, i = 0; e && i < 5; e = e.cause as { cause?: unknown } | null, i++) {
    if (e instanceof ServiceUrlRefused) return e;
  }
  return null;
}

export interface HandleResolverOptions {
  production: boolean;
  timeoutMs?: number;
  /** Where the HTTPS method reads a handle's DID (tests point it at a local double; the default is the spec's). */
  wellKnownUrl?: (handle: string) => string;
  /** The DNS TXT lookup (tests may replace it). */
  txt?: (name: string) => Promise<string[][]>;
}

const dnsTxt = (name: string, timeoutMs: number): Promise<string[][]> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error(`DNS TXT lookup for ${name} timed out`), { code: 'ETIMEOUT' })), timeoutMs);
    timer.unref?.();
    resolveTxt(name, (err, records) => {
      clearTimeout(timer);
      if (err) return reject(err);
      resolve(records);
    });
  });

export class HandleResolver {
  constructor(
    private readonly http: GuardedFetch,
    private readonly o: HandleResolverOptions
  ) {}

  private async byDns(handle: string): Promise<string | null> {
    let records: string[][];
    try {
      records = this.o.txt ? await this.o.txt(`_atproto.${handle}`) : await dnsTxt(`_atproto.${handle}`, this.o.timeoutMs ?? 5000);
    } catch {
      // NXDOMAIN, no TXT record, a timeout: the HTTPS method is tried next.
      return null;
    }
    const dids = [...new Set(records.map((parts) => parts.join('')).filter((v) => v.startsWith('did=')).map((v) => v.slice(4).trim()))];
    if (dids.length > 1) throw new HandleError('conflict', `_atproto.${handle} names more than one DID.`);
    if (dids.length === 1 && !isResolvableDid(dids[0]!)) throw new HandleError('not_found', `_atproto.${handle} does not name a did:plc or did:web.`);
    return dids[0] ?? null;
  }

  private async byHttps(handle: string): Promise<string | null> {
    const url = this.o.wellKnownUrl ? this.o.wellKnownUrl(handle) : `https://${handle}/.well-known/atproto-did`;
    let r: { status: number; text: string };
    try {
      r = await this.http.request(url);
    } catch (err) {
      const refused = err instanceof ServiceUrlRefused ? err : refusalOf(err);
      if (refused) throw new HandleError('refused', `The handle ${handle} was refused: ${refused.message}`);
      return null;
    }
    if (r.status !== 200) return null;
    const did = r.text.trim();
    return isResolvableDid(did) ? did : null;
  }

  /** The DID a handle names: DNS first, then HTTPS. Throws HandleError. */
  async resolve(input: string): Promise<{ handle: string; did: string; method: 'dns' | 'https' }> {
    const handle = normaliseHandle(input, { production: this.o.production });
    const dns = await this.byDns(handle);
    if (dns) return { handle, did: dns, method: 'dns' };
    const https = await this.byHttps(handle);
    if (https) return { handle, did: https, method: 'https' };
    throw new HandleError('not_found', `The handle ${handle} does not name a DID (no _atproto TXT record and no /.well-known/atproto-did).`);
  }

  /**
   * The handle a DID document claims, checked both ways: the document names it and it resolves back to the DID.
   * Null when the document claims none or the claim does not hold (the account then has no valid handle).
   */
  async verifiedHandle(did: string, doc: unknown): Promise<string | null> {
    for (const claimed of handlesOf(doc).slice(0, 3)) {
      try {
        const r = await this.resolve(claimed);
        if (r.did === did) return r.handle;
      } catch {
        // An invalid claimed handle leaves the account without one.
      }
    }
    return null;
  }
}
