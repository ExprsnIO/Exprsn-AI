import { createHash, createPublicKey, sign as cryptoSign, verify as cryptoVerify, X509Certificate, type KeyObject } from 'node:crypto';

/*
 * Just enough XML for SAML, written to be strict rather than general:
 *   - a parser that refuses DOCTYPE (so no entity expansion or external entities), processing instructions other
 *     than the XML declaration, unknown entity references and unbound namespace prefixes; comments are dropped and
 *     adjacent text is merged, so a comment cannot split a NameID into two readings;
 *   - Exclusive XML Canonicalization 1.0 without comments (with an optional InclusiveNamespaces prefix list);
 *   - XML-DSig enveloped signatures (RSA-SHA256 or ECDSA-SHA256 over SHA-256 digests) for signing our own
 *     assertions and verifying signed SAML messages. Verification checks that the reference points at the element
 *     being verified, that its ID is unique in the document, and callers read data only from that element.
 */

export const NS = {
  xml: 'http://www.w3.org/XML/1998/namespace',
  xmlns: 'http://www.w3.org/2000/xmlns/',
  ds: 'http://www.w3.org/2000/09/xmldsig#',
  excC14n: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  saml: 'urn:oasis:names:tc:SAML:2.0:assertion',
  samlp: 'urn:oasis:names:tc:SAML:2.0:protocol',
  md: 'urn:oasis:names:tc:SAML:2.0:metadata',
  xenc: 'http://www.w3.org/2001/04/xmlenc#',
  xenc11: 'http://www.w3.org/2009/xmlenc11#'
};

export const ALG = {
  rsaSha256: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
  ecdsaSha256: 'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256',
  sha256: 'http://www.w3.org/2001/04/xmlenc#sha256',
  enveloped: 'http://www.w3.org/2000/09/xmldsig#enveloped-signature'
};

export interface XmlAttr {
  name: string;
  prefix: string | null;
  local: string;
  ns: string;
  value: string;
}

export interface XmlElement {
  type: 'element';
  name: string;
  prefix: string | null;
  local: string;
  ns: string;
  attrs: XmlAttr[];
  /** Namespace declarations made on this element: prefix ('' for the default namespace) → URI. */
  decls: Map<string, string>;
  children: XmlNode[];
  parent: XmlElement | null;
}

export interface XmlText {
  type: 'text';
  value: string;
}

export type XmlNode = XmlElement | XmlText;

export class XmlError extends Error {}

const NAME = /^[A-Za-z_][A-Za-z0-9._-]*(?::[A-Za-z_][A-Za-z0-9._-]*)?$/;
const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(raw: string): string {
  return raw.replace(/&([^;&\s]{0,10});/g, (_m, ent: string) => {
    if (ent.startsWith('#x')) return String.fromCodePoint(parseInt(ent.slice(2), 16));
    if (ent.startsWith('#')) return String.fromCodePoint(parseInt(ent.slice(1), 10));
    const v = ENTITIES[ent];
    if (v === undefined) throw new XmlError(`Unknown entity &${ent};`);
    return v;
  }).replace(/\r\n?/g, '\n');
}

const split = (qname: string): [string | null, string] => {
  const i = qname.indexOf(':');
  return i < 0 ? [null, qname] : [qname.slice(0, i), qname.slice(i + 1)];
};

/** Resolves a prefix ('' for the default namespace) in scope at `el`; '' when the default namespace is unset. */
export function lookupNs(el: XmlElement | null, prefix: string): string | undefined {
  if (prefix === 'xml') return NS.xml;
  for (let e = el; e; e = e.parent) {
    const v = e.decls.get(prefix);
    if (v !== undefined) return v;
  }
  return prefix === '' ? '' : undefined;
}

/** Parses a document and returns its root element. */
export function parseXml(input: string, maxBytes = 1_000_000): XmlElement {
  if (input.length > maxBytes) throw new XmlError('The XML document is too large.');
  let i = 0;
  const src = input.replace(/^\uFEFF/, '');
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let depth = 0;

  const pushText = (value: string) => {
    const top = stack[stack.length - 1];
    if (!top) {
      if (value.trim()) throw new XmlError('Text outside the root element.');
      return;
    }
    const last = top.children[top.children.length - 1];
    if (last?.type === 'text') last.value += value;
    else if (value) top.children.push({ type: 'text', value });
  };

  if (src.startsWith('<?xml')) {
    const end = src.indexOf('?>');
    if (end < 0) throw new XmlError('Unterminated XML declaration.');
    i = end + 2;
  }
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      pushText(decode(src.slice(i)));
      break;
    }
    if (lt > i) pushText(decode(src.slice(i, lt)));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end < 0) throw new XmlError('Unterminated comment.');
      i = end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      if (!stack.length) throw new XmlError('CDATA outside the root element.');
      const end = src.indexOf(']]>', lt + 9);
      if (end < 0) throw new XmlError('Unterminated CDATA section.');
      pushText(src.slice(lt + 9, end).replace(/\r\n?/g, '\n'));
      i = end + 3;
      continue;
    }
    if (src.startsWith('<!', lt)) throw new XmlError('DOCTYPE and markup declarations are refused.');
    if (src.startsWith('<?', lt)) throw new XmlError('Processing instructions are refused.');
    if (src.startsWith('</', lt)) {
      const end = src.indexOf('>', lt);
      if (end < 0) throw new XmlError('Unterminated end tag.');
      const name = src.slice(lt + 2, end).trim();
      const top = stack.pop();
      if (!top || top.name !== name) throw new XmlError(`Mismatched end tag </${name}>.`);
      depth--;
      i = end + 1;
      continue;
    }
    // Start tag: scan to the closing '>' outside quoted attribute values.
    let j = lt + 1;
    let quote = '';
    for (; j < src.length; j++) {
      const c = src[j];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      else if (c === '<') throw new XmlError('Unexpected < inside a tag.');
    }
    if (j >= src.length) throw new XmlError('Unterminated start tag.');
    let body = src.slice(lt + 1, j);
    const selfClosing = body.endsWith('/');
    if (selfClosing) body = body.slice(0, -1);
    const m = /^([^\s/>]+)/.exec(body);
    if (!m || !NAME.test(m[1]!)) throw new XmlError('Invalid element name.');
    const qname = m[1]!;
    const rawAttrs: { name: string; value: string }[] = [];
    const attrRe = /\s+([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let rest = body.slice(qname.length);
    let am: RegExpExecArray | null;
    let consumed = 0;
    while ((am = attrRe.exec(rest))) {
      if (am.index !== consumed) throw new XmlError('Malformed attributes.');
      if (!NAME.test(am[1]!)) throw new XmlError('Invalid attribute name.');
      if (am[3] !== undefined ? am[3].includes('<') : am[4]!.includes('<')) throw new XmlError('< in an attribute value.');
      rawAttrs.push({ name: am[1]!, value: decode((am[3] ?? am[4] ?? '').replace(/[\t\n\r]/g, ' ')) });
      consumed = attrRe.lastIndex;
    }
    rest = rest.slice(consumed);
    if (rest.trim()) throw new XmlError('Malformed attributes.');
    if (new Set(rawAttrs.map((a) => a.name)).size !== rawAttrs.length) throw new XmlError('Duplicate attribute.');
    const parent = stack[stack.length - 1] ?? null;
    if (!parent && root) throw new XmlError('More than one root element.');
    const [prefix, local] = split(qname);
    const el: XmlElement = { type: 'element', name: qname, prefix, local, ns: '', attrs: [], decls: new Map(), children: [], parent };
    for (const a of rawAttrs) {
      if (a.name === 'xmlns') el.decls.set('', a.value);
      else if (a.name.startsWith('xmlns:')) {
        if (!a.value) throw new XmlError('Empty namespace for a prefix.');
        el.decls.set(a.name.slice(6), a.value);
      }
    }
    const ns = lookupNs(el, prefix ?? '');
    if (ns === undefined) throw new XmlError(`Unbound prefix ${prefix}.`);
    el.ns = ns;
    for (const a of rawAttrs) {
      if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) continue;
      const [ap, al] = split(a.name);
      const ans = ap ? lookupNs(el, ap) : '';
      if (ans === undefined) throw new XmlError(`Unbound prefix ${ap}.`);
      el.attrs.push({ name: a.name, prefix: ap, local: al, ns: ans, value: a.value });
    }
    if (parent) parent.children.push(el);
    else root = el;
    if (!selfClosing) {
      stack.push(el);
      if (++depth > 64) throw new XmlError('The XML document is nested too deeply.');
    }
    i = j + 1;
  }
  if (stack.length) throw new XmlError(`Unclosed element <${stack[stack.length - 1]!.name}>.`);
  if (!root) throw new XmlError('No root element.');
  return root;
}

// ---------- navigation ----------

export const elements = (el: XmlElement, ns?: string, local?: string): XmlElement[] =>
  el.children.filter((c): c is XmlElement => c.type === 'element' && (ns === undefined || c.ns === ns) && (local === undefined || c.local === local));

export const child = (el: XmlElement | undefined, ns: string, local: string): XmlElement | undefined => (el ? elements(el, ns, local)[0] : undefined);

export function descendants(el: XmlElement, ns: string, local: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (e: XmlElement) => {
    for (const c of elements(e)) {
      if (c.ns === ns && c.local === local) out.push(c);
      walk(c);
    }
  };
  walk(el);
  return out;
}

export const attr = (el: XmlElement | undefined, name: string): string | undefined => el?.attrs.find((a) => a.name === name && !a.prefix)?.value;

export const textOf = (el: XmlElement | undefined): string => (el ? el.children.map((c) => (c.type === 'text' ? c.value : textOf(c))).join('') : '');

// ---------- escaping ----------

export const escText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
export const escAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;').replace(/\t/g, '&#x9;').replace(/\n/g, '&#xA;').replace(/\r/g, '&#xD;');

// ---------- Exclusive C14N ----------

/**
 * Exclusive XML Canonicalization (without comments) of the subtree at `apex`, leaving out `exclude` (the enveloped
 * signature). `inclusivePrefixes` is the InclusiveNamespaces PrefixList ('#default' for the default namespace).
 */
export function exclusiveC14n(apex: XmlElement, opts: { exclude?: XmlElement; inclusivePrefixes?: string[] } = {}): string {
  const inclusive = new Set((opts.inclusivePrefixes ?? []).map((p) => (p === '#default' ? '' : p)));
  const out: string[] = [];
  const render = (el: XmlElement, rendered: Map<string, string>) => {
    const used = new Set<string>([el.prefix ?? '']);
    for (const a of el.attrs) if (a.prefix && a.prefix !== 'xml') used.add(a.prefix);
    for (const p of inclusive) if (lookupNs(el, p) !== undefined && (p !== '' || lookupNs(el, '') !== '')) used.add(p);
    const decls: [string, string][] = [];
    const next = new Map(rendered);
    for (const p of used) {
      if (p === 'xml') continue;
      const uri = lookupNs(el, p) ?? '';
      const have = rendered.get(p) ?? '';
      if (uri !== have || (p !== '' && !rendered.has(p))) {
        if (p === '' && uri === '' && !rendered.has('')) continue;
        decls.push([p, uri]);
        next.set(p, uri);
      }
    }
    decls.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const attrs = [...el.attrs].sort((a, b) => (a.ns === b.ns ? (a.local < b.local ? -1 : a.local > b.local ? 1 : 0) : a.ns < b.ns ? -1 : 1));
    out.push('<', el.name);
    for (const [p, uri] of decls) out.push(p ? ` xmlns:${p}="${escAttr(uri)}"` : ` xmlns="${escAttr(uri)}"`);
    for (const a of attrs) out.push(` ${a.name}="${escAttr(a.value)}"`);
    out.push('>');
    for (const c of el.children) {
      if (c.type === 'text') out.push(escText(c.value));
      else if (c !== opts.exclude) render(c, next);
    }
    out.push('</', el.name, '>');
  };
  render(apex, new Map());
  return out.join('');
}

// ---------- XML-DSig ----------

const sha256b64 = (s: string) => createHash('sha256').update(s, 'utf8').digest('base64');

/**
 * Signs `xml` (a document whose root carries an `ID` attribute) with an enveloped signature inserted after the
 * element named by `afterLocal` (the Issuer), or first. Returns the signed document as a string.
 */
export function signEnveloped(xml: string, key: KeyObject, certificateB64: string, opts: { afterLocal?: string } = {}): string {
  const rsa = key.asymmetricKeyType === 'rsa';
  const { signedInfo, place } = prepareEnveloped(xml, rsa, opts);
  const sig = rsa ? cryptoSign('sha256', Buffer.from(exclusiveC14n(parseXml(signedInfo))), key) : cryptoSign('sha256', Buffer.from(exclusiveC14n(parseXml(signedInfo))), { key, dsaEncoding: 'ieee-p1363' });
  return place(sig, certificateB64);
}

/** The same, RSA-SHA256 through a signer that may be a KMS (`sign` returns a PKCS#1 v1.5 signature). */
export async function signEnvelopedWith(xml: string, sign: (data: Buffer) => Promise<Buffer>, certificateB64: string, opts: { afterLocal?: string } = {}): Promise<string> {
  const { signedInfo, place } = prepareEnveloped(xml, true, opts);
  return place(await sign(Buffer.from(exclusiveC14n(parseXml(signedInfo)))), certificateB64);
}

function prepareEnveloped(xml: string, rsa: boolean, opts: { afterLocal?: string }): { signedInfo: string; place: (sig: Buffer, cert: string) => string } {
  const root = parseXml(xml);
  const id = attr(root, 'ID');
  if (!id) throw new XmlError('The element to sign has no ID.');
  const digest = sha256b64(exclusiveC14n(root));
  const signedInfo = `<ds:SignedInfo xmlns:ds="${NS.ds}"><ds:CanonicalizationMethod Algorithm="${NS.excC14n}"></ds:CanonicalizationMethod><ds:SignatureMethod Algorithm="${rsa ? ALG.rsaSha256 : ALG.ecdsaSha256}"></ds:SignatureMethod><ds:Reference URI="#${escAttr(id)}"><ds:Transforms><ds:Transform Algorithm="${ALG.enveloped}"></ds:Transform><ds:Transform Algorithm="${NS.excC14n}"></ds:Transform></ds:Transforms><ds:DigestMethod Algorithm="${ALG.sha256}"></ds:DigestMethod><ds:DigestValue>${digest}</ds:DigestValue></ds:Reference></ds:SignedInfo>`;
  const place = (sig: Buffer, certificateB64: string) => {
    const signature = `<ds:Signature xmlns:ds="${NS.ds}">${signedInfo}<ds:SignatureValue>${sig.toString('base64')}</ds:SignatureValue><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certificateB64}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></ds:Signature>`;
    // Insert right after the first child named afterLocal (the Issuer), found in the serialized text.
    if (opts.afterLocal) {
      const re = new RegExp(`</([A-Za-z_][\\w.-]*:)?${opts.afterLocal}>`);
      const m = re.exec(xml);
      if (m) return xml.slice(0, m.index + m[0].length) + signature + xml.slice(m.index + m[0].length);
    }
    const close = xml.indexOf('>', xml.indexOf('<' + root.name)) + 1;
    return xml.slice(0, close) + signature + xml.slice(close);
  };
  return { signedInfo, place };
}

/**
 * Builds an HTTP-Redirect binding query (SAML bindings 3.4.4.1): `SAMLRequest` or `SAMLResponse` (DEFLATE, base64),
 * RelayState, SigAlg (RSA-SHA256) and the signature over exactly those encoded parameters.
 */
export async function signedRedirectQuery(param: 'SAMLRequest' | 'SAMLResponse', deflatedB64: string, relayState: string | null, sign: (data: Buffer) => Promise<Buffer>): Promise<string> {
  const parts = [`${param}=${encodeURIComponent(deflatedB64)}`];
  if (relayState) parts.push(`RelayState=${encodeURIComponent(relayState)}`);
  parts.push(`SigAlg=${encodeURIComponent(ALG.rsaSha256)}`);
  const signed = parts.join('&');
  return `${signed}&Signature=${encodeURIComponent((await sign(Buffer.from(signed))).toString('base64'))}`;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

const allIds = (el: XmlElement, out: string[] = []): string[] => {
  for (const a of el.attrs) if (!a.prefix && (a.local === 'ID' || a.local === 'Id' || a.local === 'id')) out.push(a.value);
  for (const c of elements(el)) allIds(c, out);
  return out;
};

const inclusiveList = (transformOrMethod: XmlElement | undefined): string[] => {
  const inc = transformOrMethod ? child(transformOrMethod, NS.excC14n, 'InclusiveNamespaces') : undefined;
  return inc ? (attr(inc, 'PrefixList') ?? '').split(/\s+/).filter(Boolean) : [];
};

/**
 * Verifies the enveloped signature that is a direct child of `target`, against `certs` (base64 DER). The whole
 * document (`root`) is needed to check that the referenced ID is unique, which defeats signature wrapping.
 */
export function verifyEnveloped(root: XmlElement, target: XmlElement, certs: string[]): VerifyResult {
  const sigs = elements(target, NS.ds, 'Signature');
  if (sigs.length !== 1) return { ok: false, reason: sigs.length ? 'More than one signature.' : 'The element is not signed.' };
  const sig = sigs[0]!;
  const signedInfo = child(sig, NS.ds, 'SignedInfo');
  const c14n = child(signedInfo, NS.ds, 'CanonicalizationMethod');
  const method = attr(child(signedInfo, NS.ds, 'SignatureMethod'), 'Algorithm');
  const refs = signedInfo ? elements(signedInfo, NS.ds, 'Reference') : [];
  if (!signedInfo || attr(c14n, 'Algorithm') !== NS.excC14n) return { ok: false, reason: 'Only exclusive canonicalization is accepted.' };
  if (method !== ALG.rsaSha256 && method !== ALG.ecdsaSha256) return { ok: false, reason: 'Only RSA-SHA256 and ECDSA-SHA256 signatures are accepted.' };
  if (refs.length !== 1) return { ok: false, reason: 'Exactly one reference is required.' };
  const ref = refs[0]!;
  const id = attr(target, 'ID');
  if (!id || attr(ref, 'URI') !== `#${id}`) return { ok: false, reason: 'The signature does not reference this element.' };
  if (allIds(root).filter((x) => x === id).length !== 1) return { ok: false, reason: 'The referenced ID is not unique.' };
  const transforms = elements(child(ref, NS.ds, 'Transforms') ?? target, NS.ds, 'Transform');
  const algs = transforms.map((t) => attr(t, 'Algorithm'));
  if (!algs.length || algs.some((a) => a !== ALG.enveloped && a !== NS.excC14n) || !algs.includes(ALG.enveloped)) return { ok: false, reason: 'Unsupported transforms.' };
  if (attr(child(ref, NS.ds, 'DigestMethod'), 'Algorithm') !== ALG.sha256) return { ok: false, reason: 'Only SHA-256 digests are accepted.' };
  const excTransform = transforms.find((t) => attr(t, 'Algorithm') === NS.excC14n);
  const digest = sha256b64(exclusiveC14n(target, { exclude: sig, inclusivePrefixes: inclusiveList(excTransform) }));
  if (digest !== textOf(child(ref, NS.ds, 'DigestValue')).replace(/\s+/g, '')) return { ok: false, reason: 'The digest does not match: the content was changed.' };
  const canonicalSignedInfo = exclusiveC14n(signedInfo, { inclusivePrefixes: inclusiveList(c14n) });
  const value = Buffer.from(textOf(child(sig, NS.ds, 'SignatureValue')).replace(/\s+/g, ''), 'base64');
  for (const cert of certs) {
    let key: KeyObject;
    try {
      key = new X509Certificate(Buffer.from(cert, 'base64')).publicKey;
    } catch {
      continue;
    }
    const ok = method === ALG.rsaSha256
      ? key.asymmetricKeyType === 'rsa' && cryptoVerify('sha256', Buffer.from(canonicalSignedInfo), key, value)
      : key.asymmetricKeyType === 'ec' && cryptoVerify('sha256', Buffer.from(canonicalSignedInfo), { key, dsaEncoding: 'ieee-p1363' }, value);
    if (ok) return { ok: true };
  }
  return { ok: false, reason: 'The signature does not verify with the registered certificate.' };
}

/** Verifies an HTTP-Redirect binding signature over the raw query parameters (SAMLRequest or SAMLResponse, RelayState, SigAlg). */
export function verifyRedirectSignature(rawQuery: string, certs: string[]): VerifyResult {
  const pairs = rawQuery.split('&').map((p) => {
    const i = p.indexOf('=');
    return [i < 0 ? p : p.slice(0, i), i < 0 ? '' : p.slice(i + 1)] as const;
  });
  const get = (k: string) => pairs.find(([n]) => n === k)?.[1];
  const sigAlg = get('SigAlg');
  const signature = get('Signature');
  if (!sigAlg || !signature) return { ok: false, reason: 'The request is not signed.' };
  const alg = decodeURIComponent(sigAlg);
  if (alg !== ALG.rsaSha256 && alg !== ALG.ecdsaSha256) return { ok: false, reason: 'Only RSA-SHA256 and ECDSA-SHA256 signatures are accepted.' };
  const message = get('SAMLRequest') !== undefined ? 'SAMLRequest' : 'SAMLResponse';
  const signed = [message, 'RelayState', 'SigAlg'].filter((k) => get(k) !== undefined).map((k) => `${k}=${get(k)}`).join('&');
  const value = Buffer.from(decodeURIComponent(signature), 'base64');
  for (const cert of certs) {
    try {
      const key = new X509Certificate(Buffer.from(cert, 'base64')).publicKey;
      const ok = alg === ALG.rsaSha256 ? cryptoVerify('sha256', Buffer.from(signed), key, value) : cryptoVerify('sha256', Buffer.from(signed), { key, dsaEncoding: 'ieee-p1363' }, value);
      if (ok) return { ok: true };
    } catch {
      /* try the next certificate */
    }
  }
  return { ok: false, reason: 'The request signature does not verify.' };
}

export const publicKeyOfCert = (b64: string): KeyObject => createPublicKey(new X509Certificate(Buffer.from(b64, 'base64')).publicKey.export({ type: 'spki', format: 'pem' }));
