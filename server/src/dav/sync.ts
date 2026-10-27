import { createHash } from 'node:crypto';
import { TOMBSTONE_DAYS } from './store.js';
import { children, type DavCtx, type Node } from './tree.js';
import { DavError } from './xml.js';

/*
 * Sync tokens (RFC 6578) and CalDAV/CardDAV collection tags.
 *
 * - Personal calendars and address books keep a change counter: the token names the collection, the counter and when
 *   it was issued; changes are the objects whose counter moved past it, removals come from tombstones. A token older
 *   than TOMBSTONE_DAYS is refused (DAV:valid-sync-token), so the client syncs afresh rather than missing a removal.
 * - Group calendars and the directory are views of other data (events and RSVPs, users), without a log. Their token
 *   is a time and a digest of the items that existed then; changes are the items changed since that time. When an
 *   item that existed then is gone now (cancelled events stay, hidden ones and people who left or whose clearance
 *   rose go), the digest no longer matches and the token is refused, so the client fetches the whole collection.
 */

const PREFIX = 'https://exprsn.ai/ns/sync/';
const SETTLE_MS = 2000;

const digest = (ids: string[]): string => createHash('sha256').update([...ids].sort().join('\n')).digest('hex').slice(0, 24);

export interface SyncResult {
  token: string;
  changed: Node[];
  removed: string[];
}

const refuse = () => new DavError(403, 'The sync token is not valid for this collection any more; sync again from the start.', '{DAV:}valid-sync-token');

function parse(token: string, collection: string): string[] {
  if (!token.startsWith(PREFIX)) throw refuse();
  const parts = token.slice(PREFIX.length).split('/');
  if (parts[0] !== collection) throw refuse();
  const issued = Number(parts[parts.length - 1]);
  if (!Number.isFinite(issued) || issued < Date.now() - TOMBSTONE_DAYS * 86_400_000 || issued > Date.now() + 60_000) throw refuse();
  return parts.slice(1, -1);
}

/** The collection's current token (also its CalendarServer getctag). */
export async function currentToken(ctx: DavCtx, n: Node): Promise<string> {
  return (await sync(ctx, n, null, { tokenOnly: true })).token;
}

/** The changes since a token (all members for none) and the new token. */
export async function sync(ctx: DavCtx, n: Node, token: string | null, o: { tokenOnly?: boolean } = {}): Promise<SyncResult> {
  const now = Date.now();
  if (n.coll) {
    const c = n.coll;
    const fresh = await ctx.s.dav.store.collection(c.tenant_id, c.id);
    const seq = fresh?.sync_seq ?? c.sync_seq;
    const next = `${PREFIX}${c.id}/${seq}/${now}`;
    if (o.tokenOnly) return { token: next, changed: [], removed: [] };
    if (!token) return { token: next, changed: await children(ctx, n), removed: [] };
    const [s] = parse(token, c.id);
    const since = Number(s);
    if (!Number.isInteger(since) || since < 0 || since > seq) throw refuse();
    const { changed, removed } = await ctx.s.dav.store.changesSince(c, since);
    const names = new Set(changed.map((x) => x.name));
    const kids = (await children(ctx, n)).filter((k) => names.has(k.segs[k.segs.length - 1]!));
    return { token: next, changed: kids, removed };
  }
  // A view: group events or the directory.
  const id = n.kind === 'directory' ? `dir-${ctx.p.userId}` : `grp-${n.access!.group.id}-${ctx.p.userId}`;
  const items = await children(ctx, n);
  const at = now - SETTLE_MS;
  const name = (k: Node) => k.segs[k.segs.length - 1]!;
  const next = `${PREFIX}${id}/${at}/${digest(items.filter((k) => (k.created ?? 0) <= at).map(name))}/${now}`;
  if (o.tokenOnly || !token) return { token: next, changed: o.tokenOnly ? [] : items, removed: [] };
  const [t, d] = parse(token, id);
  const since = Number(t);
  if (!Number.isFinite(since)) throw refuse();
  // Every item that existed at the token's time must still be here; otherwise refuse (a removal we cannot name).
  if (digest(items.filter((k) => (k.created ?? 0) <= since).map(name)) !== d) throw refuse();
  return { token: next, changed: items.filter((k) => (k.modified ?? now) > since), removed: [] };
}
