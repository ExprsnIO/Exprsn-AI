import { elements, escAttr, escText, parseXml, textOf, XmlError, type XmlElement } from '../federation/xml.js';

/*
 * XML for WebDAV, CalDAV and CardDAV. Request bodies go through the strict parser the SAML code uses
 * (federation/xml.ts): no DOCTYPE, so no entity expansion and no external entities; no processing instructions; at
 * most 64 levels deep; and a size cap here. Responses are written as strings with every text and attribute escaped.
 * Property names travel in Clark notation (`{DAV:}getetag`).
 */

export { escText, escAttr, textOf, elements, XmlError, type XmlElement };

export const NS = {
  dav: 'DAV:',
  cal: 'urn:ietf:params:xml:ns:caldav',
  card: 'urn:ietf:params:xml:ns:carddav',
  cs: 'http://calendarserver.org/ns/',
  ical: 'http://apple.com/ns/ical/',
  me: 'https://exprsn.ai/ns/dav'
} as const;

/** Prefixes declared on every multistatus root, so the common properties need no declaration of their own. */
const PREFIXES: Record<string, string> = { [NS.dav]: 'd', [NS.cal]: 'cal', [NS.card]: 'card', [NS.cs]: 'cs', [NS.ical]: 'ic', [NS.me]: 'x' };
export const ROOT_DECLS = Object.entries(PREFIXES)
  .map(([ns, p]) => `xmlns:${p}="${escAttr(ns)}"`)
  .join(' ');

/** At most this many bytes of XML in a request body. */
export const MAX_XML_BYTES = 1024 * 1024;

export const clark = (ns: string, local: string): string => `{${ns}}${local}`;
export const clarkOf = (el: XmlElement): string => clark(el.ns, el.local);

export function splitClark(c: string): { ns: string; local: string } {
  const m = /^\{([^}]*)\}(.+)$/.exec(c);
  return m ? { ns: m[1]!, local: m[2]! } : { ns: '', local: c };
}

/** Parses a request body; an empty body is null. Malformed XML is a DavError 400. */
export function parseBody(body: Buffer): XmlElement | null {
  if (!body.length) return null;
  if (body.length > MAX_XML_BYTES) throw new DavError(413, 'The XML body is too large.');
  try {
    return parseXml(body.toString('utf8'), MAX_XML_BYTES);
  } catch (err) {
    if (err instanceof XmlError || err instanceof RangeError) throw new DavError(400, `The XML body is not acceptable: ${err.message}`);
    throw err;
  }
}

export const isEl = (el: XmlElement | undefined, ns: string, local: string): el is XmlElement => !!el && el.ns === ns && el.local === local;

/** The child elements in a namespace (any namespace when `ns` is undefined). */
export const kids = (el: XmlElement | undefined, ns?: string, local?: string): XmlElement[] => (el ? elements(el, ns, local) : []);
export const kid = (el: XmlElement | undefined, ns: string, local: string): XmlElement | undefined => kids(el, ns, local)[0];

/** An element by Clark name with inner XML (already escaped), or empty. Unknown namespaces are declared inline. */
export function el(name: string, inner = ''): string {
  const { ns, local } = splitClark(name);
  const p = PREFIXES[ns];
  if (p) return inner ? `<${p}:${local}>${inner}</${p}:${local}>` : `<${p}:${local}/>`;
  const decl = ns ? ` xmlns="${escAttr(ns)}"` : ' xmlns=""';
  return inner ? `<${local}${decl}>${inner}</${local}>` : `<${local}${decl}/>`;
}

/** Re-serialises a parsed element (a dead property value, an owner element) with its namespaces declared. */
export function serialise(e: XmlElement): string {
  const decl = ` xmlns="${escAttr(e.ns)}"`;
  const attrs = e.attrs.filter((a) => !a.prefix).map((a) => ` ${a.local}="${escAttr(a.value)}"`).join('');
  const inner = e.children.map((c) => (c.type === 'text' ? escText(c.value) : serialise(c))).join('');
  return inner ? `<${e.local}${decl}${attrs}>${inner}</${e.local}>` : `<${e.local}${decl}${attrs}/>`;
}

/** The inner XML of an element, re-serialised (dead property values keep their markup). */
export const innerXml = (e: XmlElement): string => e.children.map((c) => (c.type === 'text' ? escText(c.value) : serialise(c))).join('');

export const href = (h: string): string => el('{DAV:}href', escText(h));

export interface PropStat {
  status: number;
  props: string[];
  /** A precondition element for an error (RFC 4918 16), as XML. */
  error?: string;
}

export interface MsResponse {
  href: string;
  status?: number;
  propstats?: PropStat[];
  error?: string;
  description?: string;
}

export const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  207: 'Multi-Status',
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  412: 'Precondition Failed',
  423: 'Locked',
  424: 'Failed Dependency',
  507: 'Insufficient Storage'
};

export const statusLine = (n: number): string => `HTTP/1.1 ${n} ${STATUS_TEXT[n] ?? 'Status'}`;

function response(r: MsResponse): string {
  let out = href(r.href);
  if (r.propstats) {
    for (const ps of r.propstats) {
      if (!ps.props.length) continue;
      out += el('{DAV:}propstat', el('{DAV:}prop', ps.props.join('')) + el('{DAV:}status', statusLine(ps.status)) + (ps.error ? el('{DAV:}error', ps.error) : ''));
    }
  } else out += el('{DAV:}status', statusLine(r.status ?? 200));
  if (r.error) out += el('{DAV:}error', r.error);
  if (r.description) out += el('{DAV:}responsedescription', escText(r.description));
  return el('{DAV:}response', out);
}

/** A complete 207 Multi-Status body. */
export function multistatus(responses: MsResponse[], extra = ''): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<d:multistatus ${ROOT_DECLS}>${responses.map(response).join('')}${extra}</d:multistatus>`;
}

/** A document whose root is one element (`<d:prop>` for LOCK, `<d:error>` for a failed precondition). */
export function doc(rootClark: string, inner: string): string {
  const { ns, local } = splitClark(rootClark);
  return `<?xml version="1.0" encoding="utf-8"?>\n<${PREFIXES[ns] ?? 'd'}:${local} ${ROOT_DECLS}>${inner}</${PREFIXES[ns] ?? 'd'}:${local}>`;
}

/**
 * An error a DAV handler answers with its own status and, for a failed precondition or postcondition (RFC 4918 16,
 * RFC 4791 and 6352 preconditions), a `<d:error>` body naming it. Other errors become problem details as on the API.
 */
export class DavError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The precondition element's Clark name (`{DAV:}valid-sync-token`). */
    readonly condition?: string,
    readonly headers: Record<string, string> = {}
  ) {
    super(message);
  }
}
