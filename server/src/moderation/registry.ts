import { createHash } from 'node:crypto';
import { clears, isLabel, type Label } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import type { Db } from '../db/knex.js';
import type { DataKeys } from '../platform/datakeys.js';

/*
 * The moderated-object registry (B-1902). Moderation never writes another domain's tables by guesswork: each domain
 * registers a handler for its object type that resolves an object (tenant, workspace, label, owner, state), says
 * whether a person may see it (to report it), gives the text a check inspects, and hides or restores it with a
 * compare-and-set on its own state. Ported from exprsn-platform's UGC sink registry (ADR 0004), in-process: a domain
 * that ships later (posts, files, records, group content) registers here and moderation works for it unchanged.
 * Types without a handler can still be checked (B-1901) with the text and workspace given by the caller.
 */

export interface ModeratedObject {
  type: string;
  id: string;
  tenantId: string;
  workspaceId: string | null;
  label: Label;
  /** Whose object it is: the person told about an action, and who may appeal it. */
  ownerId: string | null;
  /** The domain's own state (hidden objects have `hidden`). */
  state: string | null;
  /** A conversation to link the flag to (messages). */
  conversationId?: string | null;
}

export interface ObjectHandler {
  type: string;
  description: string;
  resolve(tenantId: string, id: string): Promise<ModeratedObject | null>;
  /** May this person see the object (and so report it)? Workspaces are the ones they may act in. */
  canRead(p: Principal, o: ModeratedObject, workspaces: string[]): Promise<boolean>;
  /** The text a check inspects (opened from its sealed form). */
  text?(o: ModeratedObject): Promise<string>;
  /** Hides the object; returns the state it had, or null when it could not be hidden (gone, or already hidden). */
  hide?(o: ModeratedObject): Promise<string | null>;
  /** Puts the state back when the object is still hidden; false when it was not (deleted or changed meanwhile). */
  restore?(o: ModeratedObject, prev: string): Promise<boolean>;
}

/** The type names a domain may register: lower case, digits, dots and hyphens. */
export const OBJECT_TYPE = /^[a-z][a-z0-9.-]{0,29}$/;

export const objectHash = (type: string, id: string): string => createHash('sha256').update(`${type}\n${id}`).digest('hex');

/** The id a flag records as its source: the object id, or its hash when it is longer than the flag column. */
export const sourceIdFor = (type: string, id: string): string => (id.length <= 100 ? id : `h:${objectHash(type, id)}`);

export class ObjectRegistry {
  private readonly handlers = new Map<string, ObjectHandler>();

  register(h: ObjectHandler): void {
    if (!OBJECT_TYPE.test(h.type)) throw new Error(`Bad moderated object type ${h.type}`);
    if (this.handlers.has(h.type)) throw new Error(`Moderated object type ${h.type} is already registered`);
    this.handlers.set(h.type, h);
  }

  get(type: string): ObjectHandler | undefined {
    return this.handlers.get(type);
  }

  list(): { type: string; description: string; hide: boolean; text: boolean }[] {
    return [...this.handlers.values()].map((h) => ({ type: h.type, description: h.description, hide: !!h.hide, text: !!h.text })).sort((a, b) => a.type.localeCompare(b.type));
  }
}

const label = (v: unknown): Label => (isLabel(v) ? v : 'internal');
const inWorkspace = (o: ModeratedObject, workspaces: string[]) => !o.workspaceId || workspaces.includes(o.workspaceId);

/** Hides with a compare-and-set on the state column: only when the state is still the one read. */
async function casHide(db: Db, table: string, o: ModeratedObject, refuse: string[] = []): Promise<string | null> {
  if (!o.state || o.state === 'hidden' || refuse.includes(o.state)) return null;
  const n = await db(table).where({ id: o.id, tenant_id: o.tenantId, state: o.state }).update({ state: 'hidden' });
  return n ? o.state : null;
}

async function casRestore(db: Db, table: string, o: ModeratedObject, prev: string): Promise<boolean> {
  return (await db(table).where({ id: o.id, tenant_id: o.tenantId, state: 'hidden' }).update({ state: prev })) > 0;
}

/**
 * The types that exist today: chat conversations and messages, knowledge documents, media assets and generated
 * images. Domains added later call `registry.register` from their own service.
 */
export function registerBuiltInTypes(r: ObjectRegistry, d: { db: Db; keys: DataKeys }): void {
  const { db, keys } = d;
  const open = async (tenantId: string, sealed: string | null, aad: string): Promise<string> => (sealed ? ((await keys.open(tenantId, sealed, aad)) ?? '') : '');

  r.register({
    type: 'conversation',
    description: 'A chat conversation (reported as a whole; its messages are moderated one by one)',
    resolve: async (tenantId, id) => {
      const c = (await db('conversations').where({ tenant_id: tenantId, id }).first()) as { id: string; workspace_id: string | null; user_id: string; label: string; archived_at: unknown } | undefined;
      return c ? { type: 'conversation', id: c.id, tenantId, workspaceId: c.workspace_id, label: label(c.label), ownerId: c.user_id, state: c.archived_at == null ? 'active' : 'archived', conversationId: c.id } : null;
    },
    canRead: async (p, o) => o.ownerId === p.userId && clears(p.clearance, o.label),
    text: async (o) => {
      const c = (await db('conversations').where({ id: o.id }).first('title')) as { title: string | null } | undefined;
      return open(o.tenantId, c?.title ?? null, `title:${o.id}`);
    }
  });

  r.register({
    type: 'message',
    description: 'A chat message (a question or an answer)',
    resolve: async (tenantId, id) => {
      const m = (await db('messages as m').join('conversations as c', 'c.id', 'm.conversation_id').where({ 'm.tenant_id': tenantId, 'm.id': id }).first('m.id', 'm.state', 'm.label', 'c.id as conversation_id', 'c.workspace_id', 'c.user_id')) as { id: string; state: string; label: string; conversation_id: string; workspace_id: string | null; user_id: string } | undefined;
      return m ? { type: 'message', id: m.id, tenantId, workspaceId: m.workspace_id, label: label(m.label), ownerId: m.user_id, state: m.state, conversationId: m.conversation_id } : null;
    },
    // Conversations are their owner's; a reviewer in the workspace may report what they were shown in the queue.
    canRead: async (p, o, workspaces) => clears(p.clearance, o.label) && (o.ownerId === p.userId || (effectivePermissions(p).has('flags:review') && inWorkspace(o, workspaces))),
    text: async (o) => {
      const m = (await db('messages').where({ id: o.id }).first('content')) as { content: string | null } | undefined;
      return open(o.tenantId, m?.content ?? null, `content:${o.id}`);
    },
    // Messages still being written, held or withdrawn are left to the chat service's own review.
    hide: (o) => casHide(db, 'messages', o, ['queued', 'streaming', 'held', 'awaiting']),
    restore: (o, prev) => casRestore(db, 'messages', o, prev)
  });

  r.register({
    type: 'knowledge-document',
    description: 'A document in a knowledge base (hidden documents are left out of search and retrieval)',
    resolve: async (tenantId, id) => {
      const doc = (await db('knowledge_documents as d').join('knowledge_bases as b', 'b.id', 'd.kb_id').join('knowledge_sources as s', 's.id', 'd.source_id').where({ 'd.tenant_id': tenantId, 'd.id': id }).first('d.id', 'd.state', 'd.label', 'b.workspace_id', 's.created_by')) as { id: string; state: string; label: string; workspace_id: string | null; created_by: string | null } | undefined;
      return doc ? { type: 'knowledge-document', id: doc.id, tenantId, workspaceId: doc.workspace_id, label: label(doc.label), ownerId: doc.created_by, state: doc.state } : null;
    },
    canRead: async (p, o, workspaces) => {
      const perms = effectivePermissions(p);
      return (perms.has('knowledge:read') || perms.has('knowledge:manage')) && clears(p.clearance, o.label) && inWorkspace(o, workspaces);
    },
    text: async (o) => {
      const doc = (await db('knowledge_documents').where({ id: o.id }).first('name')) as { name: string } | undefined;
      return doc?.name ?? '';
    },
    hide: (o) => casHide(db, 'knowledge_documents', o, ['removed', 'rejected', 'quarantined', 'scanning']),
    restore: (o, prev) => casRestore(db, 'knowledge_documents', o, prev)
  });

  r.register({
    type: 'media-asset',
    description: 'An uploaded media file (hidden assets cannot be downloaded or processed)',
    resolve: async (tenantId, id) => {
      const a = (await db('media_assets').where({ tenant_id: tenantId, id }).first('id', 'state', 'label', 'workspace_id', 'user_id')) as { id: string; state: string; label: string; workspace_id: string | null; user_id: string } | undefined;
      return a ? { type: 'media-asset', id: a.id, tenantId, workspaceId: a.workspace_id, label: label(a.label), ownerId: a.user_id, state: a.state } : null;
    },
    canRead: async (p, o, workspaces) => clears(p.clearance, o.label) && (o.ownerId === p.userId || (!!o.workspaceId && workspaces.includes(o.workspaceId))),
    text: async (o) => {
      const a = (await db('media_assets').where({ id: o.id }).first('name')) as { name: string } | undefined;
      return a?.name ?? '';
    },
    hide: (o) => casHide(db, 'media_assets', o, ['quarantined', 'probing']),
    restore: (o, prev) => casRestore(db, 'media_assets', o, prev)
  });

  r.register({
    type: 'image',
    description: 'A generated image (hidden images cannot be downloaded)',
    resolve: async (tenantId, id) => {
      const i = (await db('image_jobs').where({ tenant_id: tenantId, id }).first('id', 'state', 'label', 'workspace_id', 'user_id')) as { id: string; state: string; label: string; workspace_id: string | null; user_id: string } | undefined;
      return i ? { type: 'image', id: i.id, tenantId, workspaceId: i.workspace_id, label: label(i.label), ownerId: i.user_id, state: i.state } : null;
    },
    canRead: async (p, o, workspaces) => clears(p.clearance, o.label) && (o.ownerId === p.userId || (!!o.workspaceId && workspaces.includes(o.workspaceId))),
    text: async (o) => {
      const i = (await db('image_jobs').where({ id: o.id }).first('prompt')) as { prompt: string | null } | undefined;
      return open(o.tenantId, i?.prompt ?? null, `imgprompt:${o.id}`);
    },
    hide: (o) => casHide(db, 'image_jobs', o, ['queued', 'running']),
    restore: (o, prev) => casRestore(db, 'image_jobs', o, prev)
  });
}
