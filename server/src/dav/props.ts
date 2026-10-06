import { MAX_OBJECT_BYTES } from './ics.js';
import { BASE, can, hrefFor, type DavCtx, type Node } from './tree.js';
import { el, escText, href, NS } from './xml.js';

/*
 * Live properties (RFC 4918 15, RFC 3744 for the privilege set, RFC 6578 sync tokens, RFC 4791 and
 * RFC 6352 for calendars and address books, and the calendarserver.org and Apple extensions clients ask for).
 */

const D = (l: string) => `{${NS.dav}}${l}`;
const C = (l: string) => `{${NS.cal}}${l}`;
const R = (l: string) => `{${NS.card}}${l}`;
const CS = (l: string) => `{${NS.cs}}${l}`;
const IC = (l: string) => `{${NS.ical}}${l}`;

/** Live properties a client may not set (PROPPATCH answers 403 DAV:cannot-modify-protected-property). */
export const PROTECTED = new Set([
  D('resourcetype'), D('getetag'), D('getlastmodified'), D('creationdate'), D('getcontentlength'), D('getcontenttype'), D('lockdiscovery'), D('supportedlock'),
  D('current-user-principal'), D('current-user-privilege-set'), D('principal-URL'), D('owner'), D('principal-collection-set'), D('supported-report-set'), D('sync-token'),
  D('quota-available-bytes'), D('quota-used-bytes'), CS('getctag'), C('calendar-home-set'), C('calendar-user-address-set'), R('addressbook-home-set'),
  C('supported-calendar-component-set'), C('supported-calendar-data'), C('max-resource-size'), R('supported-address-data'), R('max-resource-size'), CS('email-address-set'),
  C('calendar-data'), R('address-data')
]);

/** Live properties that PROPPATCH changes on a personal calendar or address book. */
export const COLLECTION_SETTABLE = new Set([D('displayname'), C('calendar-description'), R('addressbook-description'), IC('calendar-color'), C('calendar-timezone')]);

const SYNC_KINDS = new Set(['calendar', 'group-calendar', 'book', 'directory']);

export const supportsSync = (n: Node): boolean => SYNC_KINDS.has(n.kind);

export function reportsFor(n: Node): string[] {
  const out = [D('expand-property')];
  if (n.kind === 'calendar' || n.kind === 'group-calendar') out.push(C('calendar-query'), C('calendar-multiget'), C('free-busy-query'));
  if (n.kind === 'book' || n.kind === 'directory') out.push(R('addressbook-query'), R('addressbook-multiget'));
  if (supportsSync(n)) out.push(D('sync-collection'));
  return out;
}

const principalHref = (ctx: DavCtx) => hrefFor(['principals', ctx.p.userId], true);
const httpDate = (ms: number) => new Date(ms).toUTCString();

export interface PropContext {
  ctx: DavCtx;
  /** Sync token for collections that keep one (computed once per collection). */
  syncToken?: (n: Node) => Promise<string | null>;
}

/** The names of the live properties a node has (for allprop and propname). */
export function liveNames(n: Node, o: { allprop?: boolean } = {}): string[] {
  const out = [D('resourcetype'), D('current-user-principal'), D('current-user-privilege-set'), D('supported-report-set')];
  if (n.displayName != null) out.push(D('displayname'));
  if (n.etag) out.push(D('getetag'));
  if (n.modified != null) out.push(D('getlastmodified'));
  if (n.created != null) out.push(D('creationdate'));
  if (!n.collection) out.push(D('getcontenttype'));
  if (!n.collection && n.length != null) out.push(D('getcontentlength'));
  if (n.kind === 'principal') out.push(D('principal-URL'), C('calendar-home-set'), R('addressbook-home-set'), C('calendar-user-address-set'), CS('email-address-set'), D('principal-collection-set'));
  if (n.kind === 'root') out.push(D('principal-collection-set'));
  if (n.kind === 'cal-home' || n.kind === 'book-home' || n.kind === 'calendar' || n.kind === 'book' || n.kind === 'principal') out.push(D('owner'));
  if (supportsSync(n)) out.push(D('sync-token'), CS('getctag'));
  if (n.kind === 'calendar' || n.kind === 'group-calendar') out.push(C('supported-calendar-component-set'), C('supported-calendar-data'), C('max-resource-size'), C('calendar-description'), IC('calendar-color'));
  if (n.kind === 'book' || n.kind === 'directory') out.push(R('supported-address-data'), R('max-resource-size'), R('addressbook-description'));
  // allprop leaves out what is expensive or only meaningful when asked for (RFC 4918 9.1).
  if (o.allprop) return out.filter((x) => ![D('current-user-privilege-set'), D('supported-report-set'), C('calendar-description'), IC('calendar-color'), R('addressbook-description')].includes(x));
  return out;
}

/** A live property's inner XML, or undefined when the node does not have it (404 in the propstat). */
export async function liveValue(pc: PropContext, n: Node, name: string): Promise<string | undefined> {
  const { ctx } = pc;
  switch (name) {
    case D('resourcetype'):
      return n.types.filter((t) => t !== D('collection') || n.collection).map((t) => el(t)).join('');
    case D('displayname'):
      return n.displayName != null ? escText(n.displayName) : undefined;
    case D('getetag'):
      return n.etag ? escText(`"${n.etag}"`) : undefined;
    case D('getlastmodified'):
      return n.modified != null ? httpDate(n.modified) : undefined;
    case D('creationdate'):
      return n.created != null ? new Date(n.created).toISOString() : undefined;
    case D('getcontenttype'):
      return !n.collection && n.contentType ? escText(n.contentType) : undefined;
    case D('getcontentlength'):
      return !n.collection && n.length != null ? String(n.length) : undefined;
    case D('current-user-principal'):
      return href(principalHref(ctx));
    case D('principal-URL'):
      return n.kind === 'principal' ? href(principalHref(ctx)) : undefined;
    case D('principal-collection-set'):
      return n.kind === 'principal' || n.kind === 'root' ? href(`${BASE}/principals/`) : undefined;
    case D('owner'):
      return ['cal-home', 'book-home', 'calendar', 'book', 'principal'].includes(n.kind) ? href(principalHref(ctx)) : undefined;
    case D('current-user-privilege-set'): {
      const privs = ['read', 'read-current-user-privilege-set', ...(n.writable ? ['write', 'write-properties', 'write-content', 'bind', 'unbind'] : [])];
      if (!n.writable && n.deadKey) privs.push('write-properties');
      return privs.map((p) => el(D('privilege'), el(D(p)))).join('');
    }
    case D('supported-report-set'):
      return reportsFor(n)
        .map((r) => el(D('supported-report'), el(D('report'), el(r))))
        .join('');
    case D('sync-token'):
    case CS('getctag'): {
      if (!supportsSync(n) || !pc.syncToken) return undefined;
      const t = await pc.syncToken(n);
      return t ? escText(t) : undefined;
    }
    case C('calendar-home-set'):
      return n.kind === 'principal' && (can(ctx, 'calendars:read') || can(ctx, 'groups:read')) ? href(hrefFor(['calendars', ctx.p.userId], true)) : undefined;
    case R('addressbook-home-set'):
      return n.kind === 'principal' && can(ctx, 'contacts:read') ? href(hrefFor(['addressbooks', ctx.p.userId], true)) : undefined;
    case C('calendar-user-address-set'): {
      if (n.kind !== 'principal') return undefined;
      const u = await ctx.s.users.get(ctx.p.tenantId, ctx.p.userId);
      return [...(u?.email ? [`mailto:${u.email}`] : []), `urn:x-exprsn:user:${ctx.p.userId}`, principalHref(ctx)].map((a) => href(a)).join('');
    }
    case CS('email-address-set'): {
      if (n.kind !== 'principal') return undefined;
      const u = await ctx.s.users.get(ctx.p.tenantId, ctx.p.userId);
      return u?.email ? el(CS('email-address'), escText(u.email)) : '';
    }
    case C('supported-calendar-component-set'): {
      if (n.kind === 'group-calendar') return '<cal:comp name="VEVENT"/>';
      if (n.kind !== 'calendar') return undefined;
      const comps = (n.coll!.components || 'VEVENT,VTODO').split(',').filter(Boolean);
      return comps.map((c) => `<cal:comp name="${escText(c)}"/>`).join('');
    }
    case C('supported-calendar-data'):
      return n.kind === 'calendar' || n.kind === 'group-calendar' ? '<cal:calendar-data content-type="text/calendar" version="2.0"/>' : undefined;
    case R('supported-address-data'):
      return n.kind === 'book' || n.kind === 'directory' ? '<card:address-data-type content-type="text/vcard" version="3.0"/><card:address-data-type content-type="text/vcard" version="4.0"/>' : undefined;
    case C('max-resource-size'):
      return n.kind === 'calendar' || n.kind === 'group-calendar' ? String(MAX_OBJECT_BYTES) : undefined;
    case R('max-resource-size'):
      return n.kind === 'book' || n.kind === 'directory' ? String(MAX_OBJECT_BYTES) : undefined;
    case C('calendar-description'):
    case R('addressbook-description'): {
      if (n.coll && ((name === C('calendar-description') && n.kind === 'calendar') || (name === R('addressbook-description') && n.kind === 'book'))) {
        const d = await ctx.s.dav.store.description(n.coll);
        return d == null ? undefined : escText(d);
      }
      if (n.kind === 'directory' && name === R('addressbook-description')) return escText('People who share a workspace with you, as far as your clearance allows');
      return undefined;
    }
    case IC('calendar-color'):
      return n.kind === 'calendar' && n.coll?.color ? escText(n.coll.color) : undefined;
    default:
      return undefined;
  }
}

