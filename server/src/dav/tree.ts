import { createHash } from 'node:crypto';
import { clears, labelRank, LABELS, type Label } from '../authz/labels.js';
import { authorize, type Principal } from '../authz/policy.js';
import type { Permission } from '../authz/permissions.js';
import type { FileRow, FolderRow } from '../files/service.js';
import { workspacesFor } from '../http/middleware.js';
import type { Workspace } from '../repos/tenants.js';
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
 *   /dav/files/                               the workspaces the caller may act in, and ~shared (shared with them)
 *   /dav/files/<workspace>/<folder>/…/<file>  the file store (B-24, B-32)
 *
 * Paths name the caller's own homes only: another user's id answers 404, so nothing tells ids apart.
 */

export const BASE = '/dav';
export const SHARED = '~shared';
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
  | 'dir-card'
  | 'files'
  | 'workspace'
  | 'shared'
  | 'folder'
  | 'file';

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
  ws?: Workspace;
  folder?: FolderRow | null;
  file?: FileRow;
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

/**
 * The directory entries the caller may see: active users of the tenant cleared no higher than the caller who share a
 * workspace with them (owner's decision, 2026-10-05), as messaging and groups scope people. A workspace open to the
 * whole tenant includes every active user, so a caller with one sees everyone the clearance allows.
 */
export async function directoryUsers(ctx: DavCtx, ids?: string[]): Promise<UserRow[]> {
  const allowed = LABELS.filter((l) => clears(ctx.p.clearance, l));
  const mine = await workspacesFor(ctx.s, ctx.p);
  const q = ctx.s.db('users').where({ tenant_id: ctx.p.tenantId, state: 'active' }).whereIn('clearance', allowed);
  if (!mine.some((w) => w.visibility === 'tenant')) {
    const members = ctx.s.db('workspace_members').whereIn('workspace_id', mine.length ? mine.map((w) => w.id) : ['-']).select('user_id');
    q.where((w) => w.whereIn('id', members).orWhere('id', ctx.p.userId));
  }
  if (ids) q.whereIn('id', ids.length ? ids : ['-']);
  return ((await q.orderBy('display_name').limit(20_000)) as Record<string, unknown>[]).map((r) => ({ ...(r as unknown as UserRow), created_at: Number(r.created_at), updated_at: Number(r.updated_at) }));
}

export const contactLabel = (u: Pick<UserRow, 'clearance'>): Label => (LABELS.includes(u.clearance) ? u.clearance : 'restricted');

export function dirCardNode(parent: string[], u: UserRow): Node {
  return base('dir-card', [...parent, `${u.id}.vcf`], { collection: false, types: [], etag: hash('dc1', u.id, u.updated_at, u.display_name, u.email ?? ''), modified: u.updated_at, created: u.created_at, contentType: 'text/vcard; charset=utf-8', label: contactLabel(u), user: u });
}

// ---------- files ----------

/** The workspaces the caller may act in, by href segment (slug, else id). */
export async function workspacesBySeg(ctx: DavCtx): Promise<Map<string, Workspace>> {
  const out = new Map<string, Workspace>();
  for (const w of await workspacesFor(ctx.s, ctx.p)) if (w.state === 'active') out.set(w.slug || w.id, w);
  return out;
}

const fileFrom = (r: Record<string, unknown>): FileRow => ({ ...(r as unknown as FileRow), current_version: r.current_version == null ? null : Number(r.current_version), size: Number(r.size), created_at: Number(r.created_at), updated_at: Number(r.updated_at), trashed_at: r.trashed_at == null ? null : Number(r.trashed_at), purge_after: null });
const folderFrom = (r: Record<string, unknown>): FolderRow => ({ ...(r as unknown as FolderRow), created_at: Number(r.created_at), updated_at: Number(r.updated_at), trashed_at: null, purge_after: null });

export const fileEtag = (f: FileRow): string => (f.current_version != null ? hash('f1', f.id, f.current_version, f.size) : hash('fp', f.id, f.updated_at));

export function fileNode(ctx: DavCtx, parent: string[], f: FileRow, o: { name?: string; shared?: boolean } = {}): Node {
  return base('file', [...parent, o.name ?? f.name], {
    collection: false,
    types: [],
    displayName: f.name,
    etag: fileEtag(f),
    modified: f.updated_at,
    created: f.created_at,
    contentType: f.type ?? 'application/octet-stream',
    length: f.size,
    deadKey: `file:${f.id}`,
    writable: !o.shared && can(ctx, 'files:write', f.label),
    label: f.label,
    file: f
  });
}

export function folderNode(ctx: DavCtx, parent: string[], ws: Workspace, f: FolderRow): Node {
  return base('folder', [...parent, f.name], { displayName: f.name, modified: f.updated_at, created: f.created_at, deadKey: `folder:${f.id}`, writable: can(ctx, 'files:write'), ws, folder: f });
}

export function workspaceNode(ctx: DavCtx, seg: string, ws: Workspace): Node {
  return base('workspace', ['files', seg], { displayName: ws.name, modified: ws.updated_at ?? ws.created_at, created: ws.created_at, writable: can(ctx, 'files:write'), ws, folder: null });
}

/** A folder's (or the workspace root's) folders and readable files, in name order. */
export async function folderChildren(ctx: DavCtx, n: Node): Promise<Node[]> {
  const ws = n.ws!;
  const parentId = n.folder?.id ?? null;
  const folders = ((await ctx.s.db('file_folders').where({ tenant_id: ctx.p.tenantId, workspace_id: ws.id, parent_id: parentId }).whereNull('trashed_at').orderBy('name')) as Record<string, unknown>[]).map(folderFrom);
  const files = ((await ctx.s.db('files').where({ tenant_id: ctx.p.tenantId, workspace_id: ws.id, folder_id: parentId }).whereNull('trashed_at').whereNot({ state: 'rejected' }).whereIn('label', LABELS.filter((l) => clears(ctx.p.clearance, l))).orderBy('name_lower')) as Record<string, unknown>[]).map(fileFrom);
  return [...folders.map((f) => folderNode(ctx, n.segs, ws, f)), ...files.map((f) => fileNode(ctx, n.segs, f))];
}

/** A folder by name (names are unique without regard to case among a folder's folders and files). */
export async function folderByName(ctx: DavCtx, ws: Workspace, parentId: string | null, name: string): Promise<FolderRow | null> {
  const rows = (await ctx.s.db('file_folders').where({ tenant_id: ctx.p.tenantId, workspace_id: ws.id, parent_id: parentId }).whereNull('trashed_at').whereRaw('lower(name) = ?', [name.toLowerCase()]).limit(2)) as Record<string, unknown>[];
  const exact = rows.find((r) => r.name === name) ?? rows[0];
  return exact ? folderFrom(exact) : null;
}

export async function fileByName(ctx: DavCtx, ws: Workspace, folderId: string | null, name: string): Promise<FileRow | null> {
  const r = await ctx.s.db('files').where({ tenant_id: ctx.p.tenantId, workspace_id: ws.id, folder_id: folderId, name_lower: name.toLowerCase() }).whereNull('trashed_at').whereNot({ state: 'rejected' }).first();
  return r ? fileFrom(r) : null;
}

/** Files shared with the caller, under unique names (a second file of the same name gets " (2)"). */
export async function sharedNodes(ctx: DavCtx): Promise<Node[]> {
  const list = await ctx.s.files.sharedWithMe(ctx.p);
  const seen = new Map<string, number>();
  const out: Node[] = [];
  for (const v of list) {
    const row = await ctx.s.db('files').where({ tenant_id: ctx.p.tenantId, id: v.id }).first();
    if (!row) continue;
    const f = fileFrom(row);
    if (f.state !== 'ready') continue;
    const k = f.name.toLowerCase();
    const i = (seen.get(k) ?? 0) + 1;
    seen.set(k, i);
    const dot = f.name.lastIndexOf('.');
    const name = i === 1 ? f.name : dot > 0 ? `${f.name.slice(0, dot)} (${i})${f.name.slice(dot)}` : `${f.name} (${i})`;
    out.push(fileNode(ctx, ['files', SHARED], f, { name, shared: true }));
  }
  return out;
}

// ---------- resolution ----------

export interface Homes {
  calendars: () => Promise<CollectionRow[]>;
  books: () => Promise<CollectionRow[]>;
}

/** The caller's group calendars: groups they belong to (or manage) and may read. */
export async function memberGroups(ctx: DavCtx): Promise<Access[]> {
  if (!can(ctx, 'groups:read')) return [];
  const list = await ctx.s.groups.list(ctx.p, { mine: true, includeChannels: true });
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
  if (top === 'files') {
    await need(ctx, 'files:read');
    if (!owner) return base('files', ['files'], { displayName: 'Files' });
    if (owner === SHARED) {
      const shared = base('shared', ['files', SHARED], { displayName: 'Shared with me' });
      if (!third) return shared;
      if (fourth) return null;
      return (await sharedNodes(ctx)).find((n) => n.segs[2]!.toLowerCase() === third.toLowerCase()) ?? null;
    }
    const ws = (await workspacesBySeg(ctx)).get(owner);
    if (!ws) return null;
    let node = workspaceNode(ctx, owner, ws);
    const names = segs.slice(2);
    for (let i = 0; i < names.length; i++) {
      const name = names[i]!;
      const f = await folderByName(ctx, ws, node.folder?.id ?? null, name);
      if (f) {
        node = folderNode(ctx, node.segs, ws, f);
        continue;
      }
      if (i !== names.length - 1) return null;
      const file = await fileByName(ctx, ws, node.folder?.id ?? null, name);
      if (!file || !clears(ctx.p.clearance, file.label)) return null;
      return fileNode(ctx, node.segs, file);
    }
    return node;
  }
  return null;
}

/** The children of a collection the caller may see. */
export async function children(ctx: DavCtx, n: Node): Promise<Node[]> {
  const s = ctx.s;
  const me = ctx.p.userId;
  switch (n.kind) {
    case 'root':
      return [base('principals', ['principals'], { displayName: 'Principals' }), base('calendars', ['calendars'], { displayName: 'Calendars' }), base('addressbooks', ['addressbooks'], { displayName: 'Address books' }), ...(can(ctx, 'files:read') ? [base('files', ['files'], { displayName: 'Files' })] : [])];
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
    case 'files': {
      const out = [...(await workspacesBySeg(ctx)).entries()].map(([seg, w]) => workspaceNode(ctx, seg, w));
      out.push(base('shared', ['files', SHARED], { displayName: 'Shared with me' }));
      return out;
    }
    case 'shared':
      return sharedNodes(ctx);
    case 'workspace':
    case 'folder':
      return folderChildren(ctx, n);
    default:
      return [];
  }
}

/** The label a new file gets: internal, or lower when the uploader's clearance or the workspace ceiling is lower. */
export function defaultFileLabel(p: Principal, ws: Workspace): Label {
  return LABELS.filter((l) => labelRank(l) <= labelRank('internal') && clears(p.clearance, l) && labelRank(l) <= labelRank(ws.label_ceiling)).pop() ?? 'public';
}
