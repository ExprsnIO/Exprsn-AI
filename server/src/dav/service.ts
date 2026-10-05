import { clears, type Label } from '../authz/labels.js';
import type { Db } from '../db/knex.js';
import type { Services } from '../services.js';
import { AppPasswordService } from './passwords.js';
import { DavStore, type CollectionKind, type CollectionRow } from './store.js';
import { audit, can, type DavCtx } from './tree.js';

/** The default collections a home gets on first use, so a client has somewhere to save. */
const DEFAULTS: Record<CollectionKind, { slug: string; name: string; components: string[] }> = {
  calendar: { slug: 'personal', name: 'Personal', components: ['VEVENT', 'VTODO'] },
  addressbook: { slug: 'contacts', name: 'Contacts', components: [] }
};

/**
 * CalDAV, CardDAV and WebDAV (B-31, B-32): app passwords, the personal collections and their objects, dead
 * and dead properties. The protocol itself is `dav/handler.ts`; the file store and groups are reached through their
 * own services, so their checks, quarantine and audit apply unchanged.
 */
export class DavService {
  readonly passwords: AppPasswordService;
  readonly store: DavStore;

  constructor(s: () => Services, db: Db, secret: string) {
    this.passwords = new AppPasswordService(db, secret);
    this.store = new DavStore(s);
  }

  /** The caller's own calendars or address books, creating the default one the first time a home is listed. */
  async homeCollections(ctx: DavCtx, kind: CollectionKind): Promise<CollectionRow[]> {
    const rows = await this.store.collections(ctx.p.tenantId, ctx.p.userId, kind);
    if (rows.length || !can(ctx, kind === 'calendar' ? 'calendars:write' : 'contacts:write')) return rows.filter((c) => clears(ctx.p.clearance, c.label));
    // Created once: a second client listing the home at the same moment finds the first one's.
    const d = DEFAULTS[kind];
    const existing = await this.store.bySlug(ctx.p.tenantId, ctx.p.userId, kind, d.slug);
    if (existing) return [existing];
    const c = await this.store.createCollection({ tenantId: ctx.p.tenantId, ownerId: ctx.p.userId, kind, slug: d.slug, name: d.name, components: d.components, label: personalLabel(ctx.p.clearance) });
    await audit(ctx, 'dav.collection.created', { collection: c.id, kind }, { name: c.name, automatic: true }, c.label);
    return [c];
  }
}

/** Personal collections are internal, or public for a user cleared only for public data. */
export const personalLabel = (clearance: Label): Label => (clears(clearance, 'internal') ? 'internal' : 'public');
