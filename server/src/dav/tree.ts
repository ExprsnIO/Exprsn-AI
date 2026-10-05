import { createHash } from 'node:crypto';
import { clears, LABELS, type Label } from '../authz/labels.js';
import { authorize, type Principal } from '../authz/policy.js';
import type { Permission } from '../authz/permissions.js';
import { actorFrom } from '../audit/chain.js';
import type { Access } from '../groups/service.js';
import type { UserRow } from '../repos/users.js';
import type { Services } from '../services.js';
import type { CollectionRow, ObjectRow } from './store.js';
import { DavError } from './xml.js';

/*
 * The DAV namespace (B-3101): every path under /dav resolves to a node, built from the same services and checks as
 * the API. The tree:
 *
 *   /dav/                                     root (current-user-principal)
 *   /dav/principals/<user>/                   the caller's principal (only their own)
 *   /dav/calendars/<user>/                    calendar home: personal calendars and the calendars of their groups
 *   /dav/calendars/<user>/<cal>/<name>.ics    a personal calendar object
 *   /dav/calendars/<user>/group-<id>/<event>.ics   a group event (B-2502), with the attendees and the caller's RSVP
 *   /dav/addressbooks/<user>/                 address book home: the directory and personal address books
 *   /dav/addressbooks/<user>/directory/<user>.vcf  a directory entry (read-only, clearance-filtered)
 *   /dav/addressbooks/<user>/<book>/<name>.vcf     a personal contact
 *
 * Paths name the caller's own homes only: another user's id answers 404, so nothing tells ids apart.
 */

export const BASE = '/dav';
export const DIRECTORY = 'directory';
export const GROUP_PREFIX = 'group-';

export interface DavCtx {
  s: Services;
  p: Principal;
  ip: string | null;
  traceId: string;
  /** Lock tokens the If header names. */
  submitted: Set<string>;
}

export type Kind =
  | 'root'
  | 'principals'
  | 'principal'
  | 'calendars'
  | 'cal-home'
  | 'calendar'
  | 'group-calendar'
  | 'cal-object'
  | 'group-event'
  | 'addressbooks'
  | 'book-home'
  | 'book'
  | 'directory'
  | 'card'
  | 'dir-card';

export type EventView = Awaited<ReturnType<Services['calendar']['eventView']>>;

export interface Node {
  kind: Kind;
  /** Decoded path segments under /dav. */
  segs: string[];
  collection: boolean;
  /** Clark names in DAV:resourcetype. */
  types: string[];
  displayName: string | null;
  /** Without quotes. */
  etag: string | null;
  modified: number | null;
  created: number | null;
  contentType: string | null;
  length: number | null;
  /** The resource key dead properties are stored under, or null when the node takes none. */
  deadKey: string | null;
  /** The caller may change it (DAV:write in current-user-privilege-set). */
  writable: boolean;
  label?: Label;
  coll?: CollectionRow;
  obj?: ObjectRow;
  access?: Access;
  event?: EventView;
  user?: UserRow;
}

const encodeSeg = (s: string): string => encodeURIComponent(s).replace(/%40/g, '@').replace(/%2B/gi, '+').replace(/%3A/gi, ':').replace(/%7E/gi, '~');

export const hrefFor = (segs: string[], collection: boolean): string => `${BASE}/${segs.map(encodeSeg).join('/')}${collection && segs.length ? '/' : ''}`;
export const hrefOf = (n: Pick<Node, 'segs' | 'collection'>): string => hrefFor(n.segs, n.collection);
/** The decoded path without a trailing slash, as locks store it. */
export const pathOf = (segs: string[]): string => (segs.length ? `${BASE}/${segs.join('/')}` : BASE);

/** Splits a request path under /dav into decoded segments; `..`, `.` and empty segments are refused. */
export function segmentsOf(urlPath: string): string[] {
  const rest = urlPath.slice(BASE.length).replace(/^\/+/, '').replace(/\/+$/, '');
  if (!rest) return [];
  return rest.split('/').map((x) => {
    let d: string;
    try {
      d = decodeURIComponent(x);
    } catch {
      throw new DavError(400, 'The path is not valid percent-encoding.');
    }
    if (!d || d === '.' || d === '..' || d.includes('/') || d.includes('\0')) throw new DavError(400, 'The path has an invalid segment.');
    return d;
  });
}

/** The path segments of a Destination header (an absolute URL or path on this server, under /dav). */
export function destinationSegs(h: string | undefined): string[] {
  if (!h) throw new DavError(400, 'A Destination header is required.');
  let p: string;
  try {
    p = new URL(h, 'http://localhost').pathname;
  } catch {
    throw new DavError(400, 'The Destination header is not a URL.');
  }
  if (p !== BASE && !p.startsWith(`${BASE}/`)) throw new DavError(502, 'The destination is not on this DAV server.');
  return segmentsOf(p);
}

const base = (kind: Kind, segs: string[], o: Partial<Node> = {}): Node => ({
  kind,
  segs,
  collection: true,
  types: ['{DAV:}collection'],
  displayName: null,
  etag: null,
  modified: null,
  created: null,
  contentType: null,
  length: null,
  deadKey: null,
  writable: false,
  ...o
});

// ---------- permissions ----------

/** Does the caller hold a permission (role, credential scope, tenant, clearance for a label)? */
export function can(ctx: DavCtx, perm: Permission, label?: Label): boolean {
  return authorize(ctx.p, perm, { tenantId: ctx.p.tenantId, ...(label ? { label } : {}) }).allow;
}

/** Requires a permission; a denial is audited as on the API and answered 403 with DAV:need-privileges. */
export async function need(ctx: DavCtx, perm: Permission, label?: Label): Promise<void> {
  const d = authorize(ctx.p, perm, { tenantId: ctx.p.tenantId, ...(label ? { label } : {}) });
  if (d.allow) return;
  await ctx.s.denials.record(`${ctx.p.tenantId}:${ctx.p.userId}`, {
    tenantId: ctx.p.tenantId,
    action: 'authz.denied',
    kind: 'decision',
    actor: actorFrom(ctx.p, ctx.ip),
    target: { method: 'DAV', path: BASE },
    decision: { ...d, clearance: ctx.p.clearance, roles: ctx.p.roles },
    traceId: ctx.traceId
  });
  throw new DavError(403, d.reason, '{DAV:}need-privileges');
}

export async function audit(ctx: DavCtx, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>, label?: Label): Promise<void> {
  await ctx.s.audit.append({ tenantId: ctx.p.tenantId, action, kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target, ...(label ? { label } : {}), ...(detail ? { detail } : {}), traceId: ctx.traceId });
}

// ---------- calendar and contact helpers ----------

/** The caller's calendar user addresses: their email, and a URN for accounts without one. */
export function addressesOf(u: { id: string; email: string | null }): string[] {
  return [...(u.email ? [`mailto:${u.email}`] : []), `urn:x-exprsn:user:${u.id}`];
}

export const primaryAddress = (u: { id: string; email: string | null }): string => addressesOf(u)[0]!;

const hash = (...parts: unknown[]) => createHash('sha256').update(parts.map(String).join('\n')).digest('hex').slice(0, 32);

/** RSVP counts and latest change per event (for ETags that move when anyone answers). */
async function rsvpStamps(ctx: DavCtx, ids: string[]): Promise<Map<string, { n: number; at: number }>> {
  const out = new Map<string, { n: number; at: number }>();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = (await ctx.s.db('group_event_rsvps').whereIn('event_id', ids.slice(i, i + 500)).groupBy('event_id').select('event_id').count({ n: '*' }).max({ at: 'updated_at' })) as { event_id: string; n: unknown; at: unknown }[];
    for (const r of rows) out.set(r.event_id, { n: Number(r.n), at: Number(r.at ?? 0) });
  }
  return out;
}

export async function groupEventNodes(ctx: DavCtx, parent: string[], a: Access): Promise<Node[]> {
  const views = (await ctx.s.calendar.list(ctx.p, a.group.id, { includeCancelled: true })).filter((e) => e.state !== 'hidden');
  const stamps = await rsvpStamps(ctx, views.map((e) => e.id));
  return views.map((e) => eventNode(ctx, parent, a, e, stamps.get(e.id)));
}

function eventNode(ctx: DavCtx, parent: string[], a: Access, e: EventView, st?: { n: number; at: number }): Node {
  return base('group-event', [...parent, `${e.id}.ics`], {
    collection: false,
    types: [],
    displayName: null,
    etag: hash('ev1', e.id, e.sequence, e.updatedAt, e.state, st?.n ?? 0, st?.at ?? 0, ctx.p.userId),
    modified: Math.max(e.updatedAt, st?.at ?? 0),
    created: e.createdAt,
    contentType: 'text/calendar; charset=utf-8; component=VEVENT',
    writable: true,
    label: e.label,
    access: a,
    event: e
  });
}

/** The directory entries the caller may see: active users of the tenant cleared no higher than the caller. */
export async function directoryUsers(ctx: DavCtx, ids?: string[]): Promise<UserRow[]> {
  const allowed = LABELS.filter((l) => clears(ctx.p.clearance, l));
  const q = ctx.s.db('users').where({ tenant_id: ctx.p.tenantId, state: 'active' }).whereIn('clearance', allowed);
  if (ids) q.whereIn('id', ids.length ? ids : ['-']);
  return ((await q.orderBy('display_name').limit(20_000)) as Record<string, unknown>[]).map((r) => ({ ...(r as unknown as UserRow), created_at: Number(r.created_at), updated_at: Number(r.updated_at) }));
}

export const contactLabel = (u: Pick<UserRow, 'clearance'>): Label => (LABELS.includes(u.clearance) ? u.clearance : 'restricted');

export function dirCardNode(parent: string[], u: UserRow): Node {
  return base('dir-card', [...parent, `${u.id}.vcf`], { collection: false, types: [], etag: hash('dc1', u.id, u.updated_at, u.display_name, u.email ?? ''), modified: u.updated_at, created: u.created_at, contentType: 'text/vcard; charset=utf-8', label: contactLabel(u), user: u });
}

// ---------- resolution ----------

export interface Homes {
  calendars: () => Promise<CollectionRow[]>;
  books: () => Promise<CollectionRow[]>;
}

/** The caller's group calendars: groups they belong to (or manage) and may read. */
export async function memberGroups(ctx: DavCtx): Promise<Access[]> {
  if (!can(ctx, 'groups:read')) return [];
  const list = await ctx.s.groups.list(ctx.p, { mine: true });
  const out: Access[] = [];
  for (const g of list) {
    const a = await ctx.s.groups.accessOrNull(ctx.p, g.id);
    if (a?.read && a.group.state === 'active') out.push(a);
  }
  return out;
}

export function groupCalendarNode(ctx: DavCtx, a: Access): Node {
  return base('group-calendar', ['calendars', ctx.p.userId, `${GROUP_PREFIX}${a.group.id}`], {
    types: ['{DAV:}collection', '{urn:ietf:params:xml:ns:caldav}calendar'],
    displayName: a.group.name,
    modified: a.group.updated_at,
    created: a.group.created_at,
    writable: can(ctx, 'groups:write'),
    // Dead properties (a colour, an order) are the caller's own view of a shared calendar.
    deadKey: `gcal:${hash('gcal', a.group.id, ctx.p.userId)}`,
    label: a.group.label,
    access: a
  });
}

export function collectionNode(ctx: DavCtx, c: CollectionRow): Node {
  const cal = c.kind === 'calendar';
  return base(cal ? 'calendar' : 'book', [cal ? 'calendars' : 'addressbooks', ctx.p.userId, c.slug], {
    types: ['{DAV:}collection', cal ? '{urn:ietf:params:xml:ns:caldav}calendar' : '{urn:ietf:params:xml:ns:carddav}addressbook'],
    displayName: c.name,
    modified: c.updated_at,
    created: c.created_at,
    deadKey: `coll:${c.id}`,
    writable: can(ctx, cal ? 'calendars:write' : 'contacts:write', c.label),
    label: c.label,
    coll: c
  });
}

export function objectNode(ctx: DavCtx, parent: Node, o: ObjectRow): Node {
  const cal = parent.kind === 'calendar';
  return base(cal ? 'cal-object' : 'card', [...parent.segs, o.name], {
    collection: false,
    types: [],
    etag: o.etag,
    modified: o.updated_at,
    created: o.created_at,
    contentType: cal ? `text/calendar; charset=utf-8${o.component ? `; component=${o.component}` : ''}` : 'text/vcard; charset=utf-8',
    length: o.size,
    writable: parent.writable,
    label: parent.label,
    coll: parent.coll,
    obj: o
  });
}

/** Resolves a path to a node the caller may see, or null (404). Permissions per area are checked here. */
export async function resolve(ctx: DavCtx, segs: string[]): Promise<Node | null> {
  const s = ctx.s;
  const [top, owner, third, fourth, ...rest] = segs;
  if (!top) return base('root', [], { displayName: 'Exprsn-AI' });
  if (top === 'principals') {
    if (!owner) return base('principals', ['principals'], { displayName: 'Principals' });
    if (owner !== ctx.p.userId || third) return null;
    return base('principal', ['principals', owner], { types: ['{DAV:}collection', '{DAV:}principal'], displayName: ctx.p.displayName });
  }
  if (top === 'calendars') {
    if (!owner) return base('calendars', ['calendars'], { displayName: 'Calendars' });
    if (owner !== ctx.p.userId) return null;
    if (!can(ctx, 'calendars:read') && !can(ctx, 'groups:read')) await need(ctx, 'calendars:read');
    if (!third) return base('cal-home', ['calendars', owner], { displayName: 'Calendars', writable: can(ctx, 'calendars:write') });
    let coll: Node;
    if (third.startsWith(GROUP_PREFIX)) {
      if (!can(ctx, 'groups:read')) return null;
      const a = await s.groups.accessOrNull(ctx.p, third.slice(GROUP_PREFIX.length));
      if (!a?.read || a.group.state !== 'active') return null;
      coll = groupCalendarNode(ctx, a);
      if (!fourth) return rest.length ? null : coll;
      if (rest.length || !fourth.endsWith('.ics')) return null;
      const id = fourth.slice(0, -4);
      if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return null;
      const all = await groupEventNodes(ctx, coll.segs, a);
      return all.find((e) => e.event!.id === id) ?? null;
    }
    if (!can(ctx, 'calendars:read')) return null;
    const c = await s.dav.store.bySlug(ctx.p.tenantId, ctx.p.userId, 'calendar', third);
    if (!c || !clears(ctx.p.clearance, c.label)) return null;
    coll = collectionNode(ctx, c);
    if (!fourth) return rest.length ? null : coll;
    if (rest.length) return null;
    const o = await s.dav.store.object(c, fourth);
    return o ? objectNode(ctx, coll, o) : null;
  }
  if (top === 'addressbooks') {
    if (!owner) return base('addressbooks', ['addressbooks'], { displayName: 'Address books' });
    if (owner !== ctx.p.userId) return null;
    await need(ctx, 'contacts:read');
    if (!third) return base('book-home', ['addressbooks', owner], { displayName: 'Address books', writable: can(ctx, 'contacts:write') });
    if (third === DIRECTORY) {
      const dir = base('directory', ['addressbooks', owner, DIRECTORY], { types: ['{DAV:}collection', '{urn:ietf:params:xml:ns:carddav}addressbook'], displayName: 'Directory' });
      if (!fourth) return rest.length ? null : dir;
      if (rest.length || !fourth.endsWith('.vcf')) return null;
      const id = fourth.slice(0, -4);
      if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return null;
      const [u] = await directoryUsers(ctx, [id]);
      return u ? dirCardNode(dir.segs, u) : null;
    }
    const c = await s.dav.store.bySlug(ctx.p.tenantId, ctx.p.userId, 'addressbook', third);
    if (!c || !clears(ctx.p.clearance, c.label)) return null;
    const coll = collectionNode(ctx, c);
    if (!fourth) return rest.length ? null : coll;
    if (rest.length) return null;
    const o = await s.dav.store.object(c, fourth);
    return o ? objectNode(ctx, coll, o) : null;
  }
  return null;
}

/** The children of a collection the caller may see. */
export async function children(ctx: DavCtx, n: Node): Promise<Node[]> {
  const s = ctx.s;
  const me = ctx.p.userId;
  switch (n.kind) {
    case 'root':
      return [base('principals', ['principals'], { displayName: 'Principals' }), base('calendars', ['calendars'], { displayName: 'Calendars' }), base('addressbooks', ['addressbooks'], { displayName: 'Address books' })];
    case 'principals':
      return [base('principal', ['principals', me], { types: ['{DAV:}collection', '{DAV:}principal'], displayName: ctx.p.displayName })];
    case 'calendars':
      return can(ctx, 'calendars:read') || can(ctx, 'groups:read') ? [base('cal-home', ['calendars', me], { displayName: 'Calendars', writable: can(ctx, 'calendars:write') })] : [];
    case 'addressbooks':
      return can(ctx, 'contacts:read') ? [base('book-home', ['addressbooks', me], { displayName: 'Address books', writable: can(ctx, 'contacts:write') })] : [];
    case 'cal-home': {
      const out: Node[] = [];
      if (can(ctx, 'calendars:read')) out.push(...(await s.dav.homeCollections(ctx, 'calendar')).map((c) => collectionNode(ctx, c)));
      out.push(...(await memberGroups(ctx)).map((a) => groupCalendarNode(ctx, a)));
      return out;
    }
    case 'book-home':
      return [base('directory', ['addressbooks', me, DIRECTORY], { types: ['{DAV:}collection', '{urn:ietf:params:xml:ns:carddav}addressbook'], displayName: 'Directory' }), ...(await s.dav.homeCollections(ctx, 'addressbook')).map((c) => collectionNode(ctx, c))];
    case 'calendar':
    case 'book':
      return (await s.dav.store.objects(n.coll!)).map((o) => objectNode(ctx, n, o));
    case 'group-calendar':
      return groupEventNodes(ctx, n.segs, n.access!);
    case 'directory':
      return (await directoryUsers(ctx)).map((u) => dirCardNode(n.segs, u));
    default:
      return [];
  }
}
