import { foldLine } from '../groups/ical.js';
import type { UserRow } from '../repos/users.js';
import { escapeText, IcsError, MAX_OBJECT_BYTES, parseObject, prop, serialise, type IcsComponent } from './ics.js';
import { audit, need, type DavCtx, type Node } from './tree.js';
import { DavError } from './xml.js';

/*
 * CardDAV (RFC 6352), B-3103: the directory as a read-only address book, and personal address books.
 *
 * The directory lists the tenant's active users whose clearance is at or below the caller's: a person's entry
 * carries their clearance as its label, so a contact above the caller's clearance is never returned, listed, synced
 * or matched by a query. Entries hold the name, username and email only (vCard 3.0, which every client reads).
 */

const invalid = (msg: string, condition = '{urn:ietf:params:xml:ns:carddav}valid-address-data') => new DavError(403, msg, condition);

/** A directory entry as a vCard 3.0. */
export function directoryCard(u: Pick<UserRow, 'id' | 'username' | 'display_name' | 'email' | 'updated_at'>, org: string): string {
  const parts = u.display_name.trim().split(/\s+/);
  const family = parts.length > 1 ? parts[parts.length - 1]! : '';
  const given = parts.length > 1 ? parts.slice(0, -1).join(' ') : (parts[0] ?? '');
  const rev = new Date(u.updated_at).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', 'PRODID:-//Exprsn-AI//CardDAV 1.5//EN', `UID:${escapeText(u.id)}`, `FN:${escapeText(u.display_name)}`, `N:${escapeText(family)};${escapeText(given)};;;`, `NICKNAME:${escapeText(u.username)}`, ...(u.email ? [`EMAIL;TYPE=INTERNET:${escapeText(u.email)}`] : []), `ORG:${escapeText(org)}`, `REV:${rev}`, 'END:VCARD'];
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/** Parses and checks a vCard for a personal address book. */
export function validateCard(text: string): { root: IcsComponent; uid: string } {
  if (Buffer.byteLength(text, 'utf8') > MAX_OBJECT_BYTES) throw new DavError(403, 'The vCard is too large.', '{urn:ietf:params:xml:ns:carddav}max-resource-size');
  let root: IcsComponent;
  try {
    root = parseObject(text);
  } catch (err) {
    if (err instanceof IcsError) throw invalid(`The body is not a valid vCard: ${err.message}`);
    throw err;
  }
  if (root.name !== 'VCARD') throw invalid('The body is not a VCARD.');
  const version = prop(root, 'VERSION')?.value.trim();
  if (version !== '3.0' && version !== '4.0') throw new DavError(403, 'vCard 3.0 and 4.0 are accepted.', '{urn:ietf:params:xml:ns:carddav}supported-address-data');
  const uid = prop(root, 'UID')?.value.trim();
  if (!uid) throw invalid('A vCard in an address book carries a UID.');
  if (!prop(root, 'FN')) throw invalid('A vCard carries FN.');
  return { root, uid };
}

/** Writes a personal contact (new, or replacing `existing`). */
export async function putCard(ctx: DavCtx, coll: Node, name: string, existing: Node | null, text: string): Promise<{ created: boolean; etag: string }> {
  await need(ctx, 'contacts:write', coll.label);
  const c = coll.coll!;
  const { uid } = validateCard(text);
  const clash = await ctx.s.dav.store.byUid(c, uid);
  if (clash && clash.name !== name) throw new DavError(403, 'Another contact in this address book has the same UID.', '{urn:ietf:params:xml:ns:carddav}no-uid-conflict');
  const row = await ctx.s.dav.store.putObject(c, { name, uid, component: 'VCARD', startsAt: null, endsAt: null, body: text.replace(/\r?\n/g, '\r\n') }, existing?.obj ?? null);
  await audit(ctx, existing ? 'dav.object.updated' : 'dav.object.created', { collection: c.id, object: row.id, kind: 'addressbook' }, { size: row.size }, c.label);
  return { created: !existing, etag: row.etag };
}

/**
 * The address-data a REPORT asked for (RFC 6352 10.4): the whole card, or only the named properties (VERSION, UID and
 * FN always stay, so the card stays valid).
 */
export function addressData(text: string, names: string[] | null): string {
  if (!names) return text;
  try {
    const root = parseObject(text);
    const keep = new Set([...names.map((n) => n.toUpperCase()), 'VERSION', 'UID', 'FN']);
    return serialise({ ...root, props: root.props.filter((p) => keep.has(p.name)) });
  } catch {
    return text;
  }
}
