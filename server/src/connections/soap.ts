import { attr, elements, escAttr, escText, lookupNs, parseXml, textOf, XmlError, type XmlElement } from '../federation/xml.js';

/*
 * 1.9.0: SOAP for API connections of protocol `soap`.
 *
 * - `parseWsdl` reads a WSDL 1.1 document with the strict parser (no DOCTYPE, so no entity expansion and no external
 *   entities; no processing instructions; depth and size capped): services, their SOAP 1.1 and SOAP 1.2 ports and
 *   addresses, each bound operation with its soapAction, style (document or rpc) and input and output messages, and
 *   from the inline XSD the input element's child elements (name, type, minOccurs, maxOccurs). `wsdl:import`,
 *   `xsd:import` and `xsd:include` are not followed: they are listed in `notes`, and an operation whose input lies in
 *   them has no fields (its arguments are sent in the order given).
 * - `buildEnvelope` writes the request: the arguments are text, escaped, in the input element's child elements (never
 *   raw XML), wrapped for document/literal (or the bare element), or as parts of the operation's element for rpc.
 * - `readEnvelope` reads the answer: a Fault is an error with its faultstring (1.1) or Reason (1.2); otherwise the
 *   Body's first element becomes JSON for the endpoint's mapping: element local names as keys, repeated siblings as
 *   arrays, attributes as "@name", text-only elements as strings, xsi:nil as null.
 */

export const NS = {
  wsdl: 'http://schemas.xmlsoap.org/wsdl/',
  soap11: 'http://schemas.xmlsoap.org/wsdl/soap/',
  soap12: 'http://schemas.xmlsoap.org/wsdl/soap12/',
  xsd: 'http://www.w3.org/2001/XMLSchema',
  xsi: 'http://www.w3.org/2001/XMLSchema-instance',
  env11: 'http://schemas.xmlsoap.org/soap/envelope/',
  env12: 'http://www.w3.org/2003/05/soap-envelope'
} as const;

export const MAX_WSDL_BYTES = 2 * 1024 * 1024;

export interface SoapField {
  name: string;
  type: string;
  minOccurs: number;
  /** null: unbounded. */
  maxOccurs: number | null;
}

export interface SoapPort {
  service: string;
  name: string;
  binding: string;
  soapVersion: '1.1' | '1.2';
  address: string;
}

export interface SoapOperation {
  name: string;
  port: string;
  soapVersion: '1.1' | '1.2';
  soapAction: string;
  style: 'document' | 'rpc';
  input: {
    /** document: the element the body carries; rpc: the operation's wrapper in `namespace`. */
    element: { ns: string; name: string } | null;
    namespace: string | null;
    /** document/literal with a simple-typed element: the element itself is the one value. */
    bare: boolean;
    /** Whether the child elements are namespace-qualified (elementFormDefault). */
    qualified: boolean;
    parts: { name: string; element?: string; type?: string }[];
    fields: SoapField[];
  };
  output: { element: { ns: string; name: string } | null; parts: { name: string; element?: string; type?: string }[] };
}

export interface ServiceMeta {
  targetNamespace: string | null;
  ports: SoapPort[];
  operations: SoapOperation[];
  notes: string[];
}

type QName = { ns: string; local: string };

function qname(el: XmlElement, value: string | undefined): QName | null {
  if (!value) return null;
  const i = value.indexOf(':');
  const prefix = i < 0 ? '' : value.slice(0, i);
  const local = i < 0 ? value : value.slice(i + 1);
  const ns = lookupNs(el, prefix);
  return { ns: ns ?? '', local };
}

const qkey = (q: QName) => `{${q.ns}}${q.local}`;
const qtext = (q: QName | null) => (q ? (q.ns === NS.xsd ? `xsd:${q.local}` : q.local) : 'anyType');

const occurs = (v: string | undefined, dflt: number): number | null => (v === undefined ? dflt : v === 'unbounded' ? null : Math.max(0, Number.parseInt(v, 10) || 0));

interface SchemaInfo {
  tns: string;
  qualified: boolean;
}

/** Reads a WSDL 1.1 document. Throws XmlError (malformed, a DOCTYPE) or Error (not a WSDL) with a plain message. */
export function parseWsdl(text: string): ServiceMeta {
  const root = parseXml(text, MAX_WSDL_BYTES);
  if (root.ns !== NS.wsdl || root.local !== 'definitions') {
    if (root.local === 'description') throw new Error('This is a WSDL 2.0 description; only WSDL 1.1 is read.');
    throw new Error('This is not a WSDL 1.1 document (no wsdl:definitions root).');
  }
  const notes: string[] = [];
  const tns = attr(root, 'targetNamespace') ?? null;
  const w = (el: XmlElement, local: string) => elements(el, NS.wsdl, local);

  for (const imp of w(root, 'import')) notes.push(`wsdl:import of ${attr(imp, 'location') ?? attr(imp, 'namespace') ?? 'a document'} is not followed.`);

  // Schemas: top-level elements and complex types, with their schema's namespace and form.
  const elementsByName = new Map<string, { el: XmlElement; s: SchemaInfo }>();
  const typesByName = new Map<string, { el: XmlElement; s: SchemaInfo }>();
  for (const types of w(root, 'types')) {
    for (const schema of elements(types, NS.xsd, 'schema')) {
      const s: SchemaInfo = { tns: attr(schema, 'targetNamespace') ?? '', qualified: attr(schema, 'elementFormDefault') === 'qualified' };
      for (const imp of [...elements(schema, NS.xsd, 'import'), ...elements(schema, NS.xsd, 'include')]) {
        notes.push(`xsd:${imp.local} of ${attr(imp, 'schemaLocation') ?? attr(imp, 'namespace') ?? 'a schema'} is not followed.`);
      }
      for (const e of elements(schema, NS.xsd, 'element')) if (attr(e, 'name')) elementsByName.set(`{${s.tns}}${attr(e, 'name')}`, { el: e, s });
      for (const t of elements(schema, NS.xsd, 'complexType')) if (attr(t, 'name')) typesByName.set(`{${s.tns}}${attr(t, 'name')}`, { el: t, s });
    }
  }

  /** The child elements of a complex type, with a complexContent extension's base first (one level of each). */
  const fieldsOfType = (ct: XmlElement, s: SchemaInfo, seen: Set<string>): SoapField[] => {
    const out: SoapField[] = [];
    const ext = elements(ct, NS.xsd, 'complexContent').flatMap((cc) => elements(cc, NS.xsd, 'extension'));
    for (const x of ext) {
      const b = qname(x, attr(x, 'base'));
      const bt = b ? typesByName.get(qkey(b)) : undefined;
      if (bt && !seen.has(qkey(b!))) out.push(...fieldsOfType(bt.el, bt.s, new Set([...seen, qkey(b!)])));
    }
    const groups = [ct, ...ext].flatMap((g) => [...elements(g, NS.xsd, 'sequence'), ...elements(g, NS.xsd, 'all'), ...elements(g, NS.xsd, 'choice')]);
    for (const g of groups) {
      const inChoice = g.local === 'choice';
      for (const c of elements(g, NS.xsd, 'element')) {
        const ref = qname(c, attr(c, 'ref'));
        const name = attr(c, 'name') ?? ref?.local;
        if (!name) continue;
        const refEl = ref ? elementsByName.get(qkey(ref)) : undefined;
        const type = attr(c, 'type') ? qtext(qname(c, attr(c, 'type'))) : refEl && attr(refEl.el, 'type') ? qtext(qname(refEl.el, attr(refEl.el, 'type'))) : elements(c, NS.xsd, 'complexType').length ? 'complex' : 'xsd:string';
        out.push({ name, type, minOccurs: inChoice ? 0 : (occurs(attr(c, 'minOccurs'), 1) ?? 1), maxOccurs: occurs(attr(c, 'maxOccurs'), 1) });
      }
    }
    void s;
    return out.slice(0, 200);
  };

  /** An element's fields when it is complex; null when it is simple (a bare value). */
  const fieldsOfElement = (q: QName): { fields: SoapField[]; bare: boolean; qualified: boolean } | null => {
    const found = elementsByName.get(qkey(q));
    if (!found) return null;
    const { el, s } = found;
    const inline = elements(el, NS.xsd, 'complexType')[0];
    if (inline) return { fields: fieldsOfType(inline, s, new Set()), bare: false, qualified: s.qualified };
    const t = qname(el, attr(el, 'type'));
    const named = t ? typesByName.get(qkey(t)) : undefined;
    if (named) return { fields: fieldsOfType(named.el, named.s, new Set([qkey(t!)])), bare: false, qualified: s.qualified };
    return { fields: [{ name: q.local, type: qtext(t), minOccurs: 1, maxOccurs: 1 }], bare: true, qualified: s.qualified };
  };

  const messages = new Map<string, { name: string; element?: QName; type?: QName }[]>();
  for (const m of w(root, 'message')) {
    messages.set(`{${tns ?? ''}}${attr(m, 'name')}`, w(m, 'part').map((p) => ({ name: attr(p, 'name') ?? '', ...(attr(p, 'element') ? { element: qname(p, attr(p, 'element'))! } : {}), ...(attr(p, 'type') ? { type: qname(p, attr(p, 'type'))! } : {}) })));
  }
  const portTypes = new Map<string, Map<string, { input: QName | null; output: QName | null }>>();
  for (const pt of w(root, 'portType')) {
    const ops = new Map<string, { input: QName | null; output: QName | null }>();
    const msg = (el: XmlElement | undefined) => (el ? qname(el, attr(el, 'message')) : null);
    for (const op of w(pt, 'operation')) ops.set(attr(op, 'name') ?? '', { input: msg(w(op, 'input')[0]), output: msg(w(op, 'output')[0]) });
    portTypes.set(`{${tns ?? ''}}${attr(pt, 'name')}`, ops);
  }
  interface BindingOp {
    soapAction: string;
    style: 'document' | 'rpc' | null;
    namespace: string | null;
    use: string | null;
  }
  const bindings = new Map<string, { portType: QName | null; version: '1.1' | '1.2'; style: 'document' | 'rpc'; ops: Map<string, BindingOp> }>();
  for (const b of w(root, 'binding')) {
    const sb = elements(b, NS.soap11, 'binding')[0] ?? elements(b, NS.soap12, 'binding')[0];
    if (!sb) continue; // an HTTP or other binding
    const version: '1.1' | '1.2' = sb.ns === NS.soap12 ? '1.2' : '1.1';
    const sns = sb.ns;
    const ops = new Map<string, BindingOp>();
    for (const op of w(b, 'operation')) {
      const so = elements(op, sns, 'operation')[0];
      const body = w(op, 'input').flatMap((i) => elements(i, sns, 'body'))[0];
      const st = attr(so, 'style');
      ops.set(attr(op, 'name') ?? '', { soapAction: attr(so, 'soapAction') ?? '', style: st === 'rpc' || st === 'document' ? st : null, namespace: attr(body, 'namespace') ?? null, use: attr(body, 'use') ?? null });
    }
    bindings.set(`{${tns ?? ''}}${attr(b, 'name')}`, { portType: qname(b, attr(b, 'type')), version, style: attr(sb, 'style') === 'rpc' ? 'rpc' : 'document', ops });
  }

  const ports: SoapPort[] = [];
  const operations: SoapOperation[] = [];
  for (const svc of w(root, 'service')) {
    for (const port of w(svc, 'port')) {
      const bq = qname(port, attr(port, 'binding'));
      const b = bq ? bindings.get(qkey(bq)) : undefined;
      if (!b) continue;
      const addr = elements(port, b.version === '1.2' ? NS.soap12 : NS.soap11, 'address')[0];
      const p: SoapPort = { service: attr(svc, 'name') ?? '', name: attr(port, 'name') ?? '', binding: bq!.local, soapVersion: b.version, address: attr(addr, 'location') ?? '' };
      ports.push(p);
      const pt = b.portType ? portTypes.get(qkey(b.portType)) : undefined;
      for (const [name, bo] of b.ops) {
        const po = pt?.get(name);
        const style = bo.style ?? b.style;
        if (bo.use && bo.use !== 'literal') notes.push(`${name} on ${p.name} uses ${bo.use} encoding; only literal is sent.`);
        const inParts = po?.input ? (messages.get(qkey(po.input)) ?? []) : [];
        const outParts = po?.output ? (messages.get(qkey(po.output)) ?? []) : [];
        const partView = (x: { name: string; element?: QName; type?: QName }) => ({ name: x.name, ...(x.element ? { element: x.element.local } : {}), ...(x.type ? { type: qtext(x.type) } : {}) });
        let input: SoapOperation['input'];
        if (style === 'rpc') {
          input = { element: null, namespace: bo.namespace ?? tns, bare: false, qualified: false, parts: inParts.map(partView), fields: inParts.map((x) => ({ name: x.name, type: qtext(x.type ?? x.element ?? null), minOccurs: 1, maxOccurs: 1 })) };
        } else {
          const part = inParts.find((x) => x.element) ?? null;
          const f = part?.element ? fieldsOfElement(part.element) : null;
          input = { element: part?.element ? { ns: part.element.ns, name: part.element.local } : null, namespace: null, bare: f?.bare ?? false, qualified: f?.qualified ?? true, parts: inParts.map(partView), fields: f?.fields ?? [] };
          if (part?.element && !f) notes.push(`The input element ${part.element.local} of ${name} is not in an inline schema; its arguments are sent in the order given.`);
        }
        const outEl = outParts.find((x) => x.element)?.element;
        operations.push({ name, port: p.name, soapVersion: b.version, soapAction: bo.soapAction, style, input, output: { element: outEl ? { ns: outEl.ns, name: outEl.local } : null, parts: outParts.map(partView) } });
      }
    }
  }
  if (!ports.length) throw new Error('The WSDL has no SOAP 1.1 or SOAP 1.2 port.');
  return { targetNamespace: tns, ports, operations: operations.slice(0, 1000), notes: [...new Set(notes)].slice(0, 50) };
}

/** Whether `address` lies under `base`: same origin, and the base path as a prefix. */
export function underBase(base: string, address: string): boolean {
  try {
    const b = new URL(base);
    const a = new URL(address);
    if (a.username || a.password) return false;
    const prefix = b.pathname.replace(/\/+$/, '');
    return a.origin === b.origin && (!prefix || a.pathname === prefix || a.pathname.startsWith(`${prefix}/`));
  } catch {
    return false;
  }
}

const WRITE_VERBS = ['create', 'add', 'insert', 'update', 'set', 'save', 'put', 'delete', 'remove', 'cancel', 'submit', 'send', 'post', 'approve', 'execute', 'run', 'process', 'transfer', 'pay', 'charge', 'book', 'register', 'reset', 'change', 'modify', 'upsert', 'merge', 'import', 'upload', 'purge', 'close', 'open', 'write', 'edit', 'assign', 'grant', 'revoke', 'enable', 'disable', 'start', 'stop', 'void', 'refund'];

/** An operation whose name starts with a write verb (`CreateOrder`, `set_price`, `deleteUser`; not `Settings`). */
export function writeLikeOperation(name: string): string | null {
  const lower = name.toLowerCase();
  for (const v of WRITE_VERBS) {
    if (!lower.startsWith(v)) continue;
    const next = name[v.length];
    if (next === undefined || next === '_' || next === '-' || /[A-Z0-9]/.test(next)) return name.slice(0, v.length);
  }
  return null;
}

/** One argument's values: a list repeats the element; null leaves it out. */
export type SoapArg = [name: string, values: string[]];

/** The request envelope and its HTTP headers. Argument values are text, always escaped. */
export function buildEnvelope(op: SoapOperation, args: SoapArg[]): { body: string; headers: Record<string, string> } {
  const env = op.soapVersion === '1.2' ? NS.env12 : NS.env11;
  const elems = (prefix: string | null) => args.map(([n, vs]) => vs.map((v) => `<${prefix ? `${prefix}:` : ''}${n}>${escText(v)}</${prefix ? `${prefix}:` : ''}${n}>`).join('')).join('');
  let inner: string;
  if (op.style === 'rpc') {
    inner = `<m:${op.name} xmlns:m="${escAttr(op.input.namespace ?? '')}">${elems(null)}</m:${op.name}>`;
  } else if (op.input.element && op.input.bare) {
    const v = args.find(([n]) => n === op.input.element!.name)?.[1][0] ?? args[0]?.[1][0] ?? '';
    inner = `<m:${op.input.element.name} xmlns:m="${escAttr(op.input.element.ns)}">${escText(v)}</m:${op.input.element.name}>`;
  } else if (op.input.element) {
    inner = `<m:${op.input.element.name} xmlns:m="${escAttr(op.input.element.ns)}">${elems(op.input.qualified ? 'm' : null)}</m:${op.input.element.name}>`;
  } else inner = elems(null);
  const body = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="${env}"><soap:Body>${inner}</soap:Body></soap:Envelope>`;
  const headers: Record<string, string> =
    op.soapVersion === '1.2'
      ? { 'content-type': `application/soap+xml; charset=utf-8${op.soapAction ? `; action="${op.soapAction.replace(/["\\\r\n]/g, '')}"` : ''}`, accept: 'application/soap+xml, text/xml' }
      : { 'content-type': 'text/xml; charset=utf-8', soapaction: `"${op.soapAction.replace(/["\\\r\n]/g, '')}"`, accept: 'text/xml' };
  return { body, headers };
}

/** An element as JSON: attributes as "@name", repeated children as arrays, text-only as a string, xsi:nil as null. */
export function xmlToJson(el: XmlElement, depth = 0): unknown {
  if (depth > 64) return null;
  if (el.attrs.some((a) => a.ns === NS.xsi && a.local === 'nil' && (a.value === 'true' || a.value === '1'))) return null;
  const kids = elements(el);
  const attrs = el.attrs.filter((a) => a.ns !== NS.xsi);
  if (!kids.length && !attrs.length) return textOf(el);
  const out: Record<string, unknown> = {};
  for (const a of attrs) out[`@${a.local}`] = a.value;
  const groups = new Map<string, unknown[]>();
  for (const k of kids) {
    const list = groups.get(k.local) ?? [];
    list.push(xmlToJson(k, depth + 1));
    groups.set(k.local, list);
  }
  for (const [k, vs] of groups) out[k] = vs.length === 1 ? vs[0] : vs;
  if (!kids.length) {
    const t = textOf(el);
    if (t.trim()) out['#text'] = t;
  }
  return out;
}

export class SoapFault extends Error {
  constructor(
    message: string,
    readonly code: string | null
  ) {
    super(message);
  }
}

/** The Body's first element as JSON (`{ [local]: value }`), or a SoapFault. */
export function readEnvelope(text: string, maxBytes: number): Record<string, unknown> {
  let root: XmlElement;
  try {
    root = parseXml(text, maxBytes);
  } catch (err) {
    throw new XmlError(`The answer is not XML the strict parser accepts: ${(err as Error).message}`);
  }
  if (root.local !== 'Envelope' || (root.ns !== NS.env11 && root.ns !== NS.env12)) throw new XmlError('The answer is not a SOAP envelope.');
  const body = elements(root, root.ns, 'Body')[0];
  if (!body) throw new XmlError('The SOAP envelope has no Body.');
  const first = elements(body)[0];
  if (!first) return {};
  if (first.local === 'Fault' && first.ns === root.ns) {
    if (root.ns === NS.env11) throw new SoapFault(textOf(elements(first, '', 'faultstring')[0] ?? elements(first, undefined, 'faultstring')[0]).trim() || 'SOAP Fault', textOf(elements(first, undefined, 'faultcode')[0]).trim() || null);
    const reason = elements(first, NS.env12, 'Reason').flatMap((r) => elements(r, NS.env12, 'Text'))[0];
    const code = elements(first, NS.env12, 'Code').flatMap((c) => elements(c, NS.env12, 'Value'))[0];
    throw new SoapFault(textOf(reason).trim() || 'SOAP Fault', textOf(code).trim() || null);
  }
  return { [first.local]: xmlToJson(first) };
}
