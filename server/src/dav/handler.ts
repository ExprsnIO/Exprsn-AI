import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { attr } from '../federation/xml.js';
import { isTimeZone } from '../groups/time.js';
import { HttpProblem } from '../http/problem.js';
import { Limiter } from '../platform/ratelimit.js';
import type { Services } from '../services.js';
import { davAuthenticate, REALM } from './auth.js';
import { busyOf, deleteGroupEvent, freeBusy, groupEventBusy, putCalendarObject, putGroupEvent, renderGroupEvent, CAL_COMPONENTS } from './caldav.js';
import { addressData, directoryCard, putCard } from './carddav.js';
import { calendarFilterMatches, cardFilterMatches, checkFilter, filterComponent, filterRange, type TimeRange } from './filters.js';
import { MAX_OBJECT_BYTES, parseObject, parseUtc, prop, type IcsComponent } from './ics.js';
import { parseIf, submittedTokens, type IfList } from './if.js';
import { COLLECTION_SETTABLE, liveNames, liveValue, PROTECTED, reportsFor, supportsSync, type PropContext } from './props.js';
import { personalLabel } from './service.js';
import { currentToken, sync } from './sync.js';
import { audit, BASE, children, destinationSegs, GROUP_PREFIX, DIRECTORY, hrefFor, hrefOf, need, pathOf, resolve, segmentsOf, type DavCtx, type Node } from './tree.js';
import { clark, clarkOf, DavError, doc, el, escText, innerXml, isEl, kid, kids, multistatus, NS, parseBody, statusLine, textOf, type MsResponse, type PropStat, type XmlElement } from './xml.js';

/*
 * The DAV front door (B-3101): one router for /dav, mounted outside the JSON API with its own body handling (XML
 * request bodies are read raw, capped and parsed strictly; PUT bodies are capped per resource type), its own
 * authentication (app passwords, dav/auth.ts) and its own rate limit. Methods:
 *
 *   OPTIONS, GET, HEAD, PUT, DELETE        RFC 4918 and 7231, with If-Match / If-None-Match (a stale ETag is 412)
 *   PROPFIND, PROPPATCH                    RFC 4918 9.1, 9.2 (all-or-nothing PROPPATCH; dead properties sealed)
 *   MKCOL (extended, RFC 5689), MKCALENDAR personal address books and calendars
 *   COPY, MOVE                             objects between one's own calendars or address books
 *   REPORT                                 sync-collection (RFC 6578), calendar-query, calendar-multiget,
 *                                          free-busy-query (RFC 4791), addressbook-query, addressbook-multiget
 *                                          (RFC 6352), expand-property (RFC 3253, without expansion)
 *
 * The If header (RFC 4918 10.4) is evaluated on ETags and lock tokens; without locks (the file store's B-32 adds
 * them) a lock-token condition never holds.
 */

export const DAV_METHODS = ['options', 'get', 'head', 'put', 'delete', 'propfind', 'proppatch', 'mkcol', 'mkcalendar', 'report', 'copy', 'move'] as const;
export const DAV_HEADER = '1, 3, calendar-access, addressbook, extended-mkcol';

type Handler = (ctx: DavCtx, req: Request, res: Response, segs: string[]) => Promise<void>;

const D = (l: string) => clark(NS.dav, l);
const C = (l: string) => clark(NS.cal, l);
const R = (l: string) => clark(NS.card, l);

const DRAIN_LIMIT = 8 * 1024 * 1024;

/** Reads a request body up to `max` bytes; more is a 413. */
export async function readBody(req: Request, max: number): Promise<Buffer> {
  const tooLarge = () => new DavError(413, `The body is larger than ${max} bytes.`);
  const declared = Number(req.header('content-length') ?? NaN);
  const parts: Buffer[] = [];
  let n = 0;
  let over = Number.isFinite(declared) && declared > max;
  // A body over the cap is read and dropped (up to a bound) before the 413, so the client sees the answer rather
  // than a connection reset; past the bound the connection is closed.
  for await (const c of req as AsyncIterable<Buffer>) {
    n += c.length;
    if (n > max) over = true;
    if (over) {
      if (n > DRAIN_LIMIT) {
        req.destroy();
        throw tooLarge();
      }
      continue;
    }
    parts.push(c);
  }
  if (over) throw tooLarge();
  return Buffer.concat(parts, n);
}

export function sendXml(res: Response, status: number, body: string): void {
  res.status(status).setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.send(body);
}

export function depthOf(req: Request, dflt: '0' | '1' | 'infinity'): '0' | '1' | 'infinity' {
  const d = (req.header('depth') ?? dflt).trim().toLowerCase();
  if (d !== '0' && d !== '1' && d !== 'infinity') throw new DavError(400, 'Depth is 0, 1 or infinity.');
  return d;
}

const quoted = (etag: string) => `"${etag}"`;
const unquote = (v: string) => v.trim().replace(/^W\//, '').replace(/^"|"$/g, '');

/** Hook for lock-token conditions in If headers: does `token` name a lock on `path`? (No locks before B-32.) */
export type TokenCheck = (ctx: DavCtx, path: string, token: string) => Promise<boolean>;

export interface DavExtensions {
  tokenMatches?: TokenCheck;
}

/** If-Match, If-None-Match and the If header against the target (null when it does not exist). 412 when one fails. */
export async function preconditions(ctx: DavCtx, req: Request, segs: string[], node: Node | null, lists: IfList[], ext: DavExtensions): Promise<void> {
  const ifMatch = req.header('if-match');
  if (ifMatch) {
    const ok = ifMatch.trim() === '*' ? !!node : !!node?.etag && ifMatch.split(',').map(unquote).includes(node.etag);
    if (!ok) throw new DavError(412, 'The resource changed since you read it (If-Match).');
  }
  const ifNone = req.header('if-none-match');
  if (ifNone && !['GET', 'HEAD'].includes(req.method)) {
    const hit = ifNone.trim() === '*' ? !!node : !!node?.etag && ifNone.split(',').map(unquote).includes(node.etag);
    if (hit) throw new DavError(412, 'The resource exists or matches (If-None-Match).');
  }
  if (!lists.length) return;
  const here = pathOf(segs);
  for (const list of lists) {
    const target = list.resource ?? here;
    let n: Node | null = node;
    if (target !== here) n = target === BASE || target.startsWith(`${BASE}/`) ? await resolve(ctx, segmentsOf(target)) : null;
    let all = true;
    for (const c of list.conditions) {
      let hit: boolean;
      if (c.etag !== undefined) hit = !!n?.etag && n.etag === unquote(c.etag);
      else hit = !!ext.tokenMatches && (await ext.tokenMatches(ctx, target, c.token!));
      if (c.not ? hit : !hit) {
        all = false;
        break;
      }
    }
    if (all) return;
  }
  throw new DavError(412, 'No list in the If header holds.');
}

// ---------- properties ----------

interface PropRequest {
  mode: 'allprop' | 'propname' | 'prop';
  names: string[];
  include: string[];
}

function propRequestOf(root: XmlElement | null): PropRequest {
  if (!root) return { mode: 'allprop', names: [], include: [] };
  if (kid(root, NS.dav, 'propname')) return { mode: 'propname', names: [], include: [] };
  if (kid(root, NS.dav, 'allprop')) return { mode: 'allprop', names: [], include: kids(kid(root, NS.dav, 'include')).map(clarkOf) };
  const p = kid(root, NS.dav, 'prop');
  if (!p) throw new DavError(400, 'A propfind names prop, allprop or propname.');
  return { mode: 'prop', names: kids(p).map(clarkOf), include: [] };
}

function propContext(ctx: DavCtx): PropContext {
  const tokens = new Map<string, Promise<string>>();
  return {
    ctx,
    syncToken: (n) => {
      const k = hrefOf(n);
      if (!tokens.has(k)) tokens.set(k, currentToken(ctx, n));
      return tokens.get(k)!;
    }
  };
}

/** The data of a calendar object or vCard, as GET answers it. */
export async function dataOf(ctx: DavCtx, n: Node): Promise<string> {
  if (n.kind === 'cal-object' || n.kind === 'card') return ctx.s.dav.store.body(n.obj!);
  if (n.kind === 'group-event') return renderGroupEvent(ctx, n);
  if (n.kind === 'dir-card') return directoryCard(n.user!, (await ctx.s.tenants.byId(ctx.p.tenantId))?.name ?? ctx.p.tenantSlug);
  throw new DavError(405, 'A collection has no content.');
}

/** Properties a REPORT computes from the data (calendar-data, address-data). */
type DataProp = (n: Node) => Promise<string | undefined>;

async function propstats(pc: PropContext, n: Node, req: PropRequest, extra: Map<string, DataProp> = new Map()): Promise<PropStat[]> {
  const found: string[] = [];
  const missing: string[] = [];
  const dead = n.deadKey ? await pc.ctx.s.dav.store.properties(pc.ctx.p.tenantId, n.deadKey) : [];
  const deadXml = (d: { ns: string; local: string; value: string }) => el(clark(d.ns, d.local), d.value);
  if (req.mode === 'propname') {
    return [{ status: 200, props: [...new Set([...liveNames(n), ...dead.map((d) => clark(d.ns, d.local))])].map((x) => el(x)) }];
  }
  const names = req.mode === 'allprop' ? [...new Set([...liveNames(n, { allprop: true }), ...req.include])] : req.names;
  for (const name of names) {
    const x = extra.get(name);
    const v = x ? await x(n) : await liveValue(pc, n, name);
    if (v !== undefined) {
      found.push(el(name, v));
      continue;
    }
    const d = dead.find((p) => clark(p.ns, p.local) === name);
    if (d) found.push(deadXml(d));
    else if (req.mode === 'prop') missing.push(el(name));
  }
  if (req.mode === 'allprop') for (const d of dead) if (!names.includes(clark(d.ns, d.local))) found.push(deadXml(d));
  return [
    { status: 200, props: found },
    { status: 404, props: missing }
  ];
}

const MAX_PROPFIND_NODES = 5000;

const propfind: Handler = async (ctx, req, res, segs) => {
  const node = await resolve(ctx, segs);
  if (!node) throw new DavError(404, 'Not found.');
  const depth = depthOf(req, 'infinity');
  const body = parseBody(await readBody(req, 1024 * 1024));
  if (body && !isEl(body, NS.dav, 'propfind')) throw new DavError(400, 'The body is not a propfind.');
  const preq = propRequestOf(body);
  const nodes: Node[] = [node];
  if (depth !== '0' && node.collection) {
    let frontier = [node];
    for (let level = 0; frontier.length; level++) {
      const next: Node[] = [];
      for (const f of frontier) next.push(...(await children(ctx, f)));
      nodes.push(...next);
      if (nodes.length > MAX_PROPFIND_NODES) throw new DavError(403, 'Too many resources for Depth: infinity; ask level by level.', '{DAV:}propfind-finite-depth');
      if (depth === '1') break;
      frontier = next.filter((x) => x.collection);
      if (level > 32) break;
    }
  }
  const pc = propContext(ctx);
  const out: MsResponse[] = [];
  for (const n of nodes) out.push({ href: hrefOf(n), propstats: await propstats(pc, n, preq) });
  sendXml(res, 207, multistatus(out));
};

const proppatch: Handler = async (ctx, req, res, segs) => {
  const node = await resolve(ctx, segs);
  if (!node) throw new DavError(404, 'Not found.');
  await preconditions(ctx, req, segs, node, parseIf(req.header('if')), {});
  const body = parseBody(await readBody(req, 1024 * 1024));
  if (!body || !isEl(body, NS.dav, 'propertyupdate')) throw new DavError(400, 'The body is not a propertyupdate.');
  const ops: { set: boolean; prop: XmlElement }[] = [];
  for (const op of kids(body, NS.dav)) {
    if (op.local !== 'set' && op.local !== 'remove') continue;
    for (const p of kids(kid(op, NS.dav, 'prop'))) ops.push({ set: op.local === 'set', prop: p });
  }
  const personal = node.kind === 'calendar' || node.kind === 'book';
  if (personal) await need(ctx, node.kind === 'calendar' ? 'calendars:write' : 'contacts:write', node.label);
  const failures = new Map<string, { status: number; error?: string }>();
  for (const { set, prop: p } of ops) {
    const name = clarkOf(p);
    if (PROTECTED.has(name) || (name === D('displayname') && !personal)) failures.set(name, { status: 403, error: el(D('cannot-modify-protected-property')) });
    else if (personal && COLLECTION_SETTABLE.has(name)) {
      if (name === C('calendar-timezone') && set && !tzidOf(textOf(p))) failures.set(name, { status: 409, error: el(C('valid-calendar-data')) });
    } else if (!node.deadKey) failures.set(name, { status: 403, error: el(D('cannot-modify-protected-property')) });
    else if (set && innerXml(p).length > 64 * 1024) failures.set(name, { status: 507 });
  }
  const names = [...new Set(ops.map((o) => clarkOf(o.prop)))];
  if (!failures.size && node.deadKey && ops.some((o) => o.set) && (await ctx.s.dav.store.countProperties(node.deadKey)) + ops.length > 200) for (const n2 of names) failures.set(n2, { status: 507 });
  if (failures.size) {
    const stats: PropStat[] = [];
    for (const [name, f] of failures) stats.push({ status: f.status, props: [el(name)], ...(f.error ? { error: f.error } : {}) });
    const rest = names.filter((x) => !failures.has(x));
    if (rest.length) stats.push({ status: 424, props: rest.map((x) => el(x)) });
    sendXml(res, 207, multistatus([{ href: hrefOf(node), propstats: stats }]));
    return;
  }
  const live: Record<string, string | null> = {};
  for (const { set, prop: p } of ops) {
    const name = clarkOf(p);
    if (personal && COLLECTION_SETTABLE.has(name)) live[name] = set ? textOf(p) : null;
    else if (set) await ctx.s.dav.store.setProperty(ctx.p.tenantId, node.deadKey!, p.ns, p.local, innerXml(p));
    else await ctx.s.dav.store.removeProperty(node.deadKey!, p.ns, p.local);
  }
  if (personal && Object.keys(live).length) {
    const patch: Parameters<Services['dav']['store']['updateCollection']>[1] = {};
    if (D('displayname') in live) patch.name = (live[D('displayname')] ?? '').trim() || node.coll!.name;
    if (C('calendar-description') in live) patch.description = live[C('calendar-description')];
    if (R('addressbook-description') in live) patch.description = live[R('addressbook-description')];
    if (clark(NS.ical, 'calendar-color') in live) patch.color = live[clark(NS.ical, 'calendar-color')];
    if (C('calendar-timezone') in live) patch.timeZone = live[C('calendar-timezone')] ? tzidOf(live[C('calendar-timezone')]!) : null;
    await ctx.s.dav.store.updateCollection(node.coll!, patch);
  }
  await audit(ctx, 'dav.properties.updated', { resource: node.deadKey ?? hrefOf(node), kind: node.kind }, { set: ops.filter((o) => o.set).map((o) => clarkOf(o.prop)), removed: ops.filter((o) => !o.set).map((o) => clarkOf(o.prop)) }, node.label);
  sendXml(res, 207, multistatus([{ href: hrefOf(node), propstats: [{ status: 200, props: names.map((x) => el(x)) }] }]));
};

/** The IANA zone of a CALDAV:calendar-timezone value (a VCALENDAR with one VTIMEZONE), or of a bare zone name. */
function tzidOf(v: string): string | null {
  if (isTimeZone(v.trim())) return v.trim();
  try {
    const root = parseObject(v);
    const tz = root.components.find((c) => c.name === 'VTIMEZONE');
    const id = tz ? prop(tz, 'TZID')?.value.trim() : undefined;
    return id && isTimeZone(id) ? id : (id ?? null);
  } catch {
    return null;
  }
}

// ---------- collections ----------

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._~@+-]{0,199}$/;

async function createCollection(ctx: DavCtx, segs: string[], kind: 'calendar' | 'addressbook', setProps: XmlElement[]): Promise<void> {
  const [, owner, slug] = segs;
  await need(ctx, kind === 'calendar' ? 'calendars:write' : 'contacts:write');
  if (!slug || segs.length !== 3 || owner !== ctx.p.userId) throw new DavError(403, 'Calendars and address books are created in your own home.');
  if (!SLUG.test(slug) || slug.startsWith(GROUP_PREFIX) || slug === DIRECTORY) throw new DavError(403, 'That name is reserved or not allowed for a collection.');
  if (await ctx.s.dav.store.bySlug(ctx.p.tenantId, ctx.p.userId, kind, slug)) throw new DavError(405, 'Something exists at that path.');
  if ((await ctx.s.dav.store.collections(ctx.p.tenantId, ctx.p.userId, kind)).length >= 100) throw new DavError(507, 'At most 100 calendars and 100 address books each.');
  const get = (c: string) => setProps.find((p) => clarkOf(p) === c);
  const comps = kids(get(C('supported-calendar-component-set')), NS.cal, 'comp').map((c) => (attr(c, 'name') ?? '').toUpperCase());
  if (comps.some((c) => !(CAL_COMPONENTS as readonly string[]).includes(c))) throw new DavError(403, 'Calendars take VEVENT, VTODO and VJOURNAL.', '{urn:ietf:params:xml:ns:caldav}supported-calendar-component');
  const desc = get(kind === 'calendar' ? C('calendar-description') : R('addressbook-description'));
  const tz = get(C('calendar-timezone'));
  const c = await ctx.s.dav.store.createCollection({
    tenantId: ctx.p.tenantId,
    ownerId: ctx.p.userId,
    kind,
    slug,
    name: textOf(get(D('displayname'))).trim() || slug,
    description: desc ? textOf(desc) : null,
    color: textOf(get(clark(NS.ical, 'calendar-color'))).trim().slice(0, 20) || null,
    timeZone: tz ? tzidOf(textOf(tz)) : null,
    components: kind === 'calendar' ? (comps.length ? comps : ['VEVENT', 'VTODO']) : [],
    label: personalLabel(ctx.p.clearance)
  });
  await audit(ctx, 'dav.collection.created', { collection: c.id, kind }, { name: c.name }, c.label);
}

const mkcalendar: Handler = async (ctx, req, res, segs) => {
  if (segs[0] !== 'calendars') throw new DavError(403, 'Calendars are created in your calendar home.');
  const body = parseBody(await readBody(req, 256 * 1024));
  if (body && !isEl(body, NS.cal, 'mkcalendar')) throw new DavError(400, 'The body is not a mkcalendar.');
  await createCollection(ctx, segs, 'calendar', kids(kid(kid(body ?? undefined, NS.dav, 'set'), NS.dav, 'prop')));
  res.status(201).setHeader('Content-Length', '0');
  res.end();
};

const mkcol: Handler = async (ctx, req, res, segs) => {
  const body = parseBody(await readBody(req, 256 * 1024));
  if (!body) throw new DavError(403, 'Plain collections cannot be made here; create a calendar (MKCALENDAR) or an address book (extended MKCOL).', '{DAV:}valid-resourcetype');
  if (!isEl(body, NS.dav, 'mkcol')) throw new DavError(415, 'The body is not an extended MKCOL.');
  const setProps = kids(kid(kid(body, NS.dav, 'set'), NS.dav, 'prop'));
  const types = kids(setProps.find((p) => clarkOf(p) === D('resourcetype'))).map(clarkOf);
  if (types.includes(R('addressbook')) && segs[0] === 'addressbooks') await createCollection(ctx, segs, 'addressbook', setProps);
  else if (types.includes(C('calendar')) && segs[0] === 'calendars') await createCollection(ctx, segs, 'calendar', setProps);
  else throw new DavError(403, 'Only calendars and address books can be made here.', '{DAV:}valid-resourcetype');
  res.status(201).setHeader('Content-Length', '0');
  res.end();
};

// ---------- content ----------

const get: Handler = async (ctx, req, res, segs) => {
  const node = await resolve(ctx, segs);
  if (!node) throw new DavError(404, 'Not found.');
  if (node.collection) {
    const text = `${node.displayName ?? 'Collection'}: a WebDAV collection. Use a CalDAV or CardDAV client.\n`;
    res.status(200).type('text/plain; charset=utf-8').setHeader('Content-Length', String(Buffer.byteLength(text)));
    res.end(req.method === 'HEAD' ? undefined : text);
    return;
  }
  if (node.etag) res.setHeader('ETag', quoted(node.etag));
  if (node.modified != null) res.setHeader('Last-Modified', new Date(node.modified).toUTCString());
  const inm = req.header('if-none-match');
  if (inm && node.etag && (inm.trim() === '*' || inm.split(',').map(unquote).includes(node.etag))) {
    res.status(304).end();
    return;
  }
  const data = Buffer.from(await dataOf(ctx, node), 'utf8');
  res.status(200).setHeader('Content-Type', node.contentType ?? 'application/octet-stream');
  res.setHeader('Content-Length', String(data.length));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(req.method === 'HEAD' ? undefined : data);
};

const put: Handler = async (ctx, req, res, segs) => {
  const node = await resolve(ctx, segs);
  if (node?.collection) throw new DavError(405, 'PUT does not replace a collection.');
  await preconditions(ctx, req, segs, node, parseIf(req.header('if')), {});
  const parent = segs.length ? await resolve(ctx, segs.slice(0, -1)) : null;
  if (!parent) throw new DavError(409, 'The parent collection does not exist.');
  const name = segs[segs.length - 1]!;
  const type = (req.header('content-type') ?? '').toLowerCase();
  const text = (await readBody(req, MAX_OBJECT_BYTES)).toString('utf8');
  let out: { created: boolean; etag: string | null };
  // Lenient about the declared type (clients differ), but a vCard is not a calendar object and the other way round.
  if (parent.kind === 'calendar') {
    if (/^text\/(x-)?vcard/.test(type)) throw new DavError(403, 'A calendar takes text/calendar.', '{urn:ietf:params:xml:ns:caldav}supported-calendar-data');
    out = await putCalendarObject(ctx, parent, name, node, text);
  } else if (parent.kind === 'book') {
    if (/^text\/calendar/.test(type)) throw new DavError(403, 'An address book takes text/vcard.', '{urn:ietf:params:xml:ns:carddav}supported-address-data');
    out = await putCard(ctx, parent, name, node, text);
  } else if (parent.kind === 'group-calendar') {
    if (!node) throw new DavError(403, 'Events in a group calendar are created in the console; here you can answer them and, as a moderator, change them.', '{DAV:}need-privileges');
    await putGroupEvent(ctx, node, text);
    out = { created: false, etag: null };
  } else if (parent.kind === 'directory') {
    throw new DavError(403, 'The directory is read-only.', '{DAV:}need-privileges');
  } else throw new DavError(405, 'Nothing can be stored here.');
  if (out.etag) res.setHeader('ETag', quoted(out.etag));
  res.status(out.created ? 201 : 204).setHeader('Content-Length', '0');
  res.end();
};

const del: Handler = async (ctx, req, res, segs) => {
  const node = await resolve(ctx, segs);
  if (!node) throw new DavError(404, 'Not found.');
  await preconditions(ctx, req, segs, node, parseIf(req.header('if')), {});
  if (node.kind === 'cal-object' || node.kind === 'card') {
    await need(ctx, node.kind === 'cal-object' ? 'calendars:write' : 'contacts:write', node.label);
    await ctx.s.dav.store.deleteObject(node.coll!, node.obj!);
    await audit(ctx, 'dav.object.deleted', { collection: node.coll!.id, object: node.obj!.id, kind: node.coll!.kind }, undefined, node.label);
  } else if (node.kind === 'calendar' || node.kind === 'book') {
    await need(ctx, node.kind === 'calendar' ? 'calendars:write' : 'contacts:write', node.label);
    await ctx.s.dav.store.deleteCollection(node.coll!);
    await audit(ctx, 'dav.collection.deleted', { collection: node.coll!.id, kind: node.coll!.kind }, { name: node.coll!.name }, node.label);
  } else if (node.kind === 'group-event') await deleteGroupEvent(ctx, node);
  else throw new DavError(403, 'This cannot be deleted over DAV.', '{DAV:}need-privileges');
  res.status(204).end();
};

/** COPY and MOVE of personal calendar objects and contacts between one's own collections of the same kind. */
const copyMove: Handler = async (ctx, req, res, segs) => {
  const move = req.method === 'MOVE';
  const src = await resolve(ctx, segs);
  if (!src) throw new DavError(404, 'Not found.');
  if (src.kind !== 'cal-object' && src.kind !== 'card') throw new DavError(403, `Only calendar objects and contacts can be ${move ? 'moved' : 'copied'} here.`);
  await preconditions(ctx, req, segs, src, parseIf(req.header('if')), {});
  const dsegs = destinationSegs(req.header('destination'));
  if (dsegs.join('/') === segs.join('/')) throw new DavError(403, 'The source and the destination are the same.');
  const parent = await resolve(ctx, dsegs.slice(0, -1));
  if (!parent) throw new DavError(409, 'The destination collection does not exist.');
  if ((src.kind === 'cal-object' && parent.kind !== 'calendar') || (src.kind === 'card' && parent.kind !== 'book')) throw new DavError(403, 'The destination is not a collection of the same kind.');
  const existing = await resolve(ctx, dsegs);
  const overwrite = (req.header('overwrite') ?? 'T').trim().toUpperCase() !== 'F';
  if (existing && !overwrite) throw new DavError(412, 'The destination exists and Overwrite is F.');
  const text = await dataOf(ctx, src);
  const name = dsegs[dsegs.length - 1]!;
  // Moving within one collection keeps the UID: drop the source first so the UID check does not see it.
  if (move && parent.coll!.id === src.coll!.id) {
    await need(ctx, src.kind === 'cal-object' ? 'calendars:write' : 'contacts:write', src.label);
    await ctx.s.dav.store.deleteObject(src.coll!, src.obj!);
  }
  if (existing) await ctx.s.dav.store.deleteObject(existing.coll!, existing.obj!);
  if (src.kind === 'cal-object') await putCalendarObject(ctx, parent, name, null, text);
  else await putCard(ctx, parent, name, null, text);
  if (move && parent.coll!.id !== src.coll!.id) {
    await need(ctx, src.kind === 'cal-object' ? 'calendars:write' : 'contacts:write', src.label);
    await ctx.s.dav.store.deleteObject(src.coll!, src.obj!);
  }
  await audit(ctx, move ? 'dav.object.moved' : 'dav.object.copied', { collection: src.coll!.id, object: src.obj!.id, to: parent.coll!.id }, { name }, src.label);
  res.status(existing ? 204 : 201).setHeader('Content-Length', '0');
  res.end();
};

// ---------- reports ----------

function hrefsOf(body: XmlElement): string[] {
  return kids(body, NS.dav, 'href').map((h) => {
    try {
      return decodeURIComponent(new URL(textOf(h).trim(), 'http://x').pathname).replace(/\/+$/, '');
    } catch {
      return '';
    }
  });
}

/** Members of a collection by decoded name. */
async function members(ctx: DavCtx, n: Node): Promise<Map<string, Node>> {
  return new Map((await children(ctx, n)).map((k) => [k.segs[k.segs.length - 1]!, k]));
}

function dataProps(ctx: DavCtx, preq: PropRequest, body: XmlElement): Map<string, DataProp> {
  const out = new Map<string, DataProp>();
  if (preq.names.includes(C('calendar-data'))) out.set(C('calendar-data'), async (n) => (n.kind === 'cal-object' || n.kind === 'group-event' ? escText(await dataOf(ctx, n)) : undefined));
  if (preq.names.includes(R('address-data'))) {
    const ad = kid(kid(body, NS.dav, 'prop'), NS.card, 'address-data');
    const names = kids(ad, NS.card, 'prop').map((p) => attr(p, 'name') ?? '');
    out.set(R('address-data'), async (n) => (n.kind === 'card' || n.kind === 'dir-card' ? escText(addressData(await dataOf(ctx, n), names.length ? names : null)) : undefined));
  }
  return out;
}

async function parsedOf(ctx: DavCtx, n: Node): Promise<IcsComponent | null> {
  try {
    return parseObject(await dataOf(ctx, n));
  } catch {
    return null;
  }
}

const report: Handler = async (ctx, req, res, segs) => {
  const node = await resolve(ctx, segs);
  if (!node) throw new DavError(404, 'Not found.');
  const body = parseBody(await readBody(req, 1024 * 1024));
  if (!body) throw new DavError(400, 'A REPORT has a body.');
  const name = clarkOf(body);
  const pc = propContext(ctx);
  const target = node.collection ? node : null;
  if (!reportsFor(node).includes(name) && !(name === C('calendar-multiget') && node.kind === 'cal-home') && !(name === R('addressbook-multiget') && node.kind === 'book-home'))
    throw new DavError(403, 'This report is not supported here.', '{DAV:}supported-report');
  const preq: PropRequest = { mode: 'prop', names: kids(kid(body, NS.dav, 'prop')).map(clarkOf), include: [] };
  const extra = dataProps(ctx, preq, body);
  const respond = async (list: Node[], tail = '') => {
    const out: MsResponse[] = [];
    for (const n of list) out.push({ href: hrefOf(n), propstats: await propstats(pc, n, preq, extra) });
    sendXml(res, 207, multistatus(out, tail));
  };

  if (name === D('sync-collection')) {
    if (!supportsSync(node)) throw new DavError(403, 'This collection does not keep a sync token.', '{DAV:}supported-report');
    const level = textOf(kid(body, NS.dav, 'sync-level')).trim() || '1';
    if (level !== '1' && level !== 'infinite') throw new DavError(400, 'sync-level is 1 or infinite.');
    const token = textOf(kid(body, NS.dav, 'sync-token')).trim() || null;
    const r = await sync(ctx, node, token);
    const limit = Number(textOf(kid(kid(body, NS.dav, 'limit'), NS.dav, 'nresults')).trim() || NaN);
    if (Number.isFinite(limit) && limit >= 0 && r.changed.length + r.removed.length > limit) throw new DavError(507, 'More changes than the limit; sync without a limit.', '{DAV:}number-of-matches-within-limits');
    const out: MsResponse[] = [];
    for (const n of r.changed) out.push({ href: hrefOf(n), propstats: await propstats(pc, n, preq, extra) });
    for (const gone of r.removed) out.push({ href: hrefFor([...node.segs, gone], false), status: 404 });
    sendXml(res, 207, multistatus(out, el(D('sync-token'), escText(r.token))));
    return;
  }

  if (name === D('expand-property')) {
    const names = kids(body, NS.dav, 'property').map((p) => clark(attr(p, 'namespace') ?? NS.dav, attr(p, 'name') ?? ''));
    sendXml(res, 207, multistatus([{ href: hrefOf(node), propstats: await propstats(pc, node, { mode: 'prop', names, include: [] }) }]));
    return;
  }

  if (name === C('calendar-multiget') || name === R('addressbook-multiget')) {
    const out: MsResponse[] = [];
    const cache = new Map<string, Map<string, Node> | null>();
    for (const h of hrefsOf(body)) {
      const hsegs = h === BASE || h.startsWith(`${BASE}/`) ? segmentsOf(h) : null;
      if (!hsegs || !hsegs.length) {
        out.push({ href: h, status: 404 });
        continue;
      }
      const parentKey = hsegs.slice(0, -1).join('/');
      if (!cache.has(parentKey)) {
        const p = await resolve(ctx, hsegs.slice(0, -1));
        cache.set(parentKey, p?.collection ? await members(ctx, p) : null);
      }
      const n = cache.get(parentKey)?.get(hsegs[hsegs.length - 1]!);
      if (!n) out.push({ href: hrefFor(hsegs, false), status: 404 });
      else out.push({ href: hrefOf(n), propstats: await propstats(pc, n, preq, extra) });
    }
    sendXml(res, 207, multistatus(out));
    return;
  }

  if (name === C('calendar-query')) {
    const filter = kid(body, NS.cal, 'filter');
    if (!filter) throw new DavError(403, 'A calendar-query has a filter.', '{urn:ietf:params:xml:ns:caldav}valid-filter');
    checkFilter(filter, NS.cal);
    const range = filterRange(filter);
    const comp = filterComponent(filter);
    const zone = node.coll?.time_zone ?? null;
    let candidates: Node[];
    if (!target) candidates = [node];
    else if (node.kind === 'calendar') {
      const rows = await ctx.s.dav.store.objects(node.coll!, { range, component: comp });
      const all = await members(ctx, node);
      candidates = rows.map((o) => all.get(o.name)).filter((x): x is Node => !!x);
    } else candidates = (await children(ctx, node)).filter((n) => !range || !n.event || (Date.parse(n.event.startsAt) < range.end && Date.parse(n.event.endsAt) > range.start - 86_400_000));
    const hits: Node[] = [];
    for (const n of candidates) {
      const root = await parsedOf(ctx, n);
      if (root && calendarFilterMatches(root, filter, zone)) hits.push(n);
    }
    await respond(hits);
    return;
  }

  if (name === R('addressbook-query')) {
    const filter = kid(body, NS.card, 'filter');
    if (!filter) throw new DavError(403, 'An addressbook-query has a filter.', '{urn:ietf:params:xml:ns:carddav}valid-filter');
    checkFilter(filter, NS.card);
    const limit = Number(textOf(kid(kid(body, NS.card, 'limit'), NS.card, 'nresults')).trim() || NaN);
    const hits: Node[] = [];
    for (const n of target ? await children(ctx, node) : [node]) {
      const root = await parsedOf(ctx, n);
      if (root && cardFilterMatches(root, filter)) hits.push(n);
    }
    if (Number.isFinite(limit) && limit >= 0 && hits.length > limit) {
      await respond(hits.slice(0, limit), el(D('response'), el(D('href'), escText(hrefOf(node))) + el(D('status'), statusLine(507)) + el(D('error'), el(D('number-of-matches-within-limits')))));
      return;
    }
    await respond(hits);
    return;
  }

  if (name === C('free-busy-query')) {
    const tr = kid(body, NS.cal, 'time-range');
    const start = parseUtc(attr(tr, 'start'));
    const end = parseUtc(attr(tr, 'end'));
    if (!tr || start == null || end == null || end <= start) throw new DavError(400, 'A free-busy-query has a time-range with a start and an end in UTC.');
    const range: TimeRange = { start, end };
    const busy: { start: number; end: number }[] = [];
    if (node.kind === 'calendar') {
      for (const o of await ctx.s.dav.store.objects(node.coll!, { range, component: 'VEVENT' })) {
        try {
          busy.push(...busyOf(parseObject(await ctx.s.dav.store.body(o)), node.coll!.time_zone));
        } catch {
          // an object that no longer parses is not busy time
        }
      }
    } else for (const n of await children(ctx, node)) if (n.event) busy.push(...[groupEventBusy(n.event)].filter((b): b is { start: number; end: number } => !!b));
    const text = freeBusy(busy, range);
    res.status(200).setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.send(text);
    return;
  }
  throw new DavError(403, 'This report is not supported here.', '{DAV:}supported-report');
};

const options: Handler = async (_ctx, _req, res) => {
  res.setHeader('DAV', DAV_HEADER);
  res.setHeader('Allow', DAV_METHODS.map((m) => m.toUpperCase()).join(', '));
  res.setHeader('MS-Author-Via', 'DAV');
  res.status(200).setHeader('Content-Length', '0');
  res.end();
};

export const HANDLERS: Record<string, Handler> = { OPTIONS: options, GET: get, HEAD: get, PUT: put, DELETE: del, PROPFIND: propfind, PROPPATCH: proppatch, MKCOL: mkcol, MKCALENDAR: mkcalendar, REPORT: report, COPY: copyMove, MOVE: copyMove };

/** Answers a DavError (and the API's problems, mapped) in DAV terms. */
export function davErrors(err: unknown, req: Request, res: Response, next: NextFunction): void {
  let e: DavError | null = err instanceof DavError ? err : null;
  if (!e && err instanceof HttpProblem && err.status < 500) e = new DavError(err.status, err.detail ?? err.title, undefined, err.headers);
  if (!e) return next(err);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  for (const [k, v] of Object.entries(e.headers)) if (!k.startsWith('x-lock-')) res.setHeader(k, v);
  if (e.status === 401) res.setHeader('WWW-Authenticate', REALM);
  const lockRoot = e.headers['x-lock-root'];
  const inner = e.condition ? el(e.condition, lockRoot ? el(D('href'), escText(lockRoot)) : '') : '';
  const body = doc(D('error'), inner + el(clark(NS.me, 'message'), escText(e.message)) + el(clark(NS.me, 'trace-id'), escText(req.traceId)));
  sendXml(res, e.status, body);
}

/** The /dav router and the /.well-known discovery redirects. */
export function davRoutes(s: Services, ext: { handlers?: Partial<Record<string, Handler>>; methods?: readonly string[]; dav?: string } = {}): Router {
  const r = Router();
  const handlers = { ...HANDLERS, ...ext.handlers } as Record<string, Handler>;
  const methods = ext.methods ?? DAV_METHODS;
  const davHeader = ext.dav ?? DAV_HEADER;
  const limiter = new Limiter(s.counters, 'dav', s.cfg.API_RATE_PER_MINUTE, 60_000);

  // RFC 6764: clients find the server from the domain; the root names the principal (current-user-principal).
  const wellKnown = r.route(['/.well-known/caldav', '/.well-known/carddav']) as unknown as Record<string, (h: RequestHandler) => unknown>;
  for (const m of ['get', 'head', 'options', 'propfind']) wellKnown[m]!((_req: Request, res: Response) => res.redirect(301, `${BASE}/`));

  r.use(BASE, davAuthenticate(s));
  const route = r.route([BASE, `${BASE}/*path`]) as unknown as Record<string, (h: RequestHandler) => unknown>;
  const handle: RequestHandler = async (req, res, next) => {
    try {
      const p = req.principal!;
      const lim = await limiter.consume(p.userId);
      if (!lim.allowed) throw new DavError(429, 'Slow down: too many requests.', undefined, { 'Retry-After': String(Math.max(1, Math.ceil(lim.resetMs / 1000))) });
      const path = req.originalUrl.split('?')[0]!;
      const segs = segmentsOf(path);
      const lists = parseIf(req.header('if'));
      const ctx: DavCtx = { s, p, ip: req.ip ?? null, traceId: req.traceId, submitted: submittedTokens(lists) };
      res.setHeader('DAV', davHeader);
      res.setHeader('Cache-Control', 'private, no-store');
      const h = handlers[req.method];
      if (!h) throw new DavError(405, 'Method not allowed.');
      await h(ctx, req, res, segs);
    } catch (err) {
      davErrors(err, req, res, next);
    }
  };
  for (const m of methods) route[m]!(handle);
  r.use(BASE, (_req: Request, _res: Response, next: NextFunction) => next(new DavError(405, 'Method not allowed.')));
  r.use(BASE, (err: unknown, req: Request, res: Response, next: NextFunction) => davErrors(err, req, res, next));
  return r;
}
