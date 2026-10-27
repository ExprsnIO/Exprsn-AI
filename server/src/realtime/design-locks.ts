import { hostname } from 'node:os';
import type { Socket } from 'socket.io';
import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom, isUniqueViolation, type AuditActor } from '../audit/chain.js';
import { clears, highest, type Label } from '../authz/labels.js';
import { rolesRequireMfa, type Permission } from '../authz/permissions.js';
import { authorize, type Principal } from '../authz/policy.js';
import { workspacesFor } from '../http/middleware.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';

/*
 * 1.8.0, Sprint 47 (B-140): presence and soft locks in the designers (the workflow designer, the app-flow canvas, the
 * form editor and the entity designer).
 *
 * Presence. A console that opens a design object asks the server (`design.open {kind, id, app?}` on its socket). The
 * server resolves the object from the socket's principal, now: the kind's read right (below), the object visible in
 * one of the person's workspaces (and group, for app entities) and its label within their clearance; anything else is
 * answered "not available" whether it exists or not. Only then does the socket join the object's room, which the
 * server names; clients never name rooms. The socket's row in `design_viewers` is refreshed by the console's
 * heartbeat (`design.heartbeat`, which also checks access again and evicts a socket that lost it) and deleted on
 * close and disconnect; rows an instance left behind are swept after the viewer lease. Every change publishes the
 * object's state (viewers, lock) on the bus, and each instance relays it to the sockets it holds in the room, so this
 * works across instances (the Socket.io Redis adapter is not needed for it: the rows and the bus are).
 *
 * Soft lock. The first editor to change something takes the edit lock (`design.lock`, or POST
 * /api/design-locks/:kind/:id). One conditional write on `design_locks` decides between two takers on any instances.
 * The holder's heartbeat pushes `expires_at` forward; the lock goes on save (the save routes call `releaseOnSave`),
 * on close, on disconnect, or when it expires. Someone else with the kind's manage right may take it over (the
 * holder's sockets are told `design.lock.lost`, and the console keeps their unsaved state on that device); a tenant
 * admin (`tenant:manage`) may break it. Saves check `assertCanSave`: a live lock held by another person refuses the
 * save with 409 naming them; the optimistic revision checks of the designs stay as the last guard. A save with no
 * lock held by anyone is allowed (API clients, older consoles).
 *
 * Rights per kind: presence needs the read right (`agents:run` for workflows, as reading a workflow does; `apps:design`
 * for app flows, as reading flows does; `records:read` for forms and entities, as reading them does), the lock the
 * manage right (`workflows:manage`; `apps:design` and `workflows:manage` for flows, which save their workflow;
 * `apps:design` for forms and entities). Audited `design.lock.taken`, `.released`, `.taken_over`, `.broken`.
 */

export const DESIGN_KINDS = ['workflow', 'app-flow', 'app-form', 'app-entity'] as const;
export type DesignKind = (typeof DESIGN_KINDS)[number];

const READ: Record<DesignKind, Permission> = { workflow: 'agents:run', 'app-flow': 'apps:design', 'app-form': 'records:read', 'app-entity': 'records:read' };
const MANAGE: Record<DesignKind, Permission[]> = { workflow: ['workflows:manage'], 'app-flow': ['apps:design', 'workflows:manage'], 'app-form': ['apps:design'], 'app-entity': ['apps:design'] };
/** Breaking someone's lock without taking it is for tenant admins. */
export const BREAK_PERMISSION: Permission = 'tenant:manage';

export const DESIGN_TOPIC = 'design.state';
export const designRoom = (tenantId: string, kind: DesignKind, id: string) => `design:${kind}:${tenantId}:${id}`;
const MAX_OPEN_PER_SOCKET = 20;
const ID26 = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export interface DesignRef {
  kind: DesignKind;
  id: string;
  /** The app (id or name) of an app flow, form or entity. */
  app?: string | undefined;
}

export interface DesignObject {
  kind: DesignKind;
  id: string;
  tenantId: string;
  label: Label;
  title: string;
  appId: string | null;
}

interface LockRow {
  tenant_id: string;
  kind: DesignKind;
  object_id: string;
  label: Label;
  title: string;
  user_id: string;
  user_name: string;
  session_id: string | null;
  socket_id: string | null;
  instance_id: string;
  acquired_at: number;
  renewed_at: number;
  expires_at: number;
}

export interface LockView {
  userId: string;
  name: string;
  since: number;
  expiresAt: number;
  /** `socket` when taken from a console's socket (released on its disconnect), `api` when taken through REST. */
  via: 'socket' | 'api';
}

export interface Viewer {
  userId: string;
  name: string;
  since: number;
}

/** What every instance relays to the sockets in the object's room. */
export interface DesignEvent {
  tenantId: string;
  kind: DesignKind;
  id: string;
  viewers: Viewer[];
  lock: (LockView & { socketId: string | null }) | null;
  /** Someone lost the lock (taken over, broken): their sockets are told. */
  lost?: { userId: string; socketId: string | null; by: { userId: string; name: string } | null; reason: 'taken_over' | 'broken' | 'moved' };
}

export interface LockCtx {
  socketId?: string | null;
  ip?: string | null;
  traceId?: string | null;
}

export interface DesignLockOptions {
  /** A viewer row not refreshed for this long is gone (the console beats every 15 seconds). */
  viewerTtlMs: number;
  /** A lock not renewed for this long has expired. */
  lockTtlMs: number;
  /** How often this instance sweeps expired rows; 0 turns the sweep off (tests call `sweep`). */
  sweepMs: number;
}

const n = (v: unknown) => Number(v);
const lockFrom = (r: Record<string, unknown>): LockRow => ({ ...(r as unknown as LockRow), acquired_at: n(r.acquired_at), renewed_at: n(r.renewed_at), expires_at: n(r.expires_at) });
const view = (r: LockRow): LockView => ({ userId: r.user_id, name: r.user_name, since: r.acquired_at, expiresAt: r.expires_at, via: r.socket_id ? 'socket' : 'api' });
const nameOf = (p: Principal) => (p.displayName || p.username || 'someone').slice(0, 200);

export class DesignLocks {
  readonly instanceId = `${hostname()}:${process.pid}:${ulid().slice(-8)}`;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly s: () => Services,
    readonly opts: DesignLockOptions = { viewerTtlMs: 45_000, lockTtlMs: 60_000, sweepMs: 15_000 }
  ) {}

  private get db() {
    return this.s().db;
  }

  start(): void {
    if (this.timer || this.opts.sweepMs <= 0) return;
    this.timer = setInterval(() => void this.sweep().catch((err: unknown) => this.s().log.warn({ err }, 'design lock sweep failed')), this.opts.sweepMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.db('design_viewers').where({ instance_id: this.instanceId }).delete().catch(() => undefined);
  }

  // ---------- rights and objects ----------

  /** As `requirePermission` decides: the role grants it, and admin roles come with a second factor. */
  may(p: Principal, perm: Permission): boolean {
    if (!authorize(p, perm).allow) return false;
    return !(p.kind === 'user' && !p.mfa && rolesRequireMfa(p.roles, p.tenantId));
  }

  canRead(p: Principal, kind: DesignKind): boolean {
    return this.may(p, READ[kind]);
  }

  canManage(p: Principal, kind: DesignKind): boolean {
    return MANAGE[kind].every((perm) => this.may(p, perm));
  }

  canBreak(p: Principal): boolean {
    return this.may(p, BREAK_PERMISSION);
  }

  readPermission(kind: DesignKind): Permission {
    return READ[kind];
  }

  managePermissions(kind: DesignKind): Permission[] {
    return MANAGE[kind];
  }

  /**
   * The object, as the principal may see it now, or 404 (also for an object above their clearance or outside their
   * workspaces, so its existence is not told). A principal without the kind's read right gets 403 first.
   */
  async resolve(p: Principal, ref: DesignRef): Promise<DesignObject> {
    if (!this.canRead(p, ref.kind)) throw forbidden(`Seeing who has this open needs ${READ[ref.kind]}.`, { step: 'role', action: READ[ref.kind] });
    const out = await this.find(p, ref).catch((err: unknown) => {
      if (err instanceof HttpProblem && (err.status === 404 || err.status === 403)) return null;
      throw err;
    });
    if (!out || !clears(p.clearance, out.label)) throw notFound(ref.kind === 'workflow' ? 'Workflow' : ref.kind === 'app-flow' ? 'Flow' : ref.kind === 'app-form' ? 'Form' : 'Entity');
    return out;
  }

  private async find(p: Principal, ref: DesignRef): Promise<DesignObject | null> {
    const s = this.s();
    if (ref.kind === 'workflow') {
      // A socket's principal has no current workspace: the workflow is looked up by id and seen from its own
      // workspace, which must be one of the person's.
      let at = p;
      if (!p.workspaceId) {
        if (!ID26.test(ref.id)) return null;
        const row = (await this.db('workflows').where({ tenant_id: p.tenantId, id: ref.id }).first('workspace_id')) as { workspace_id: string | null } | undefined;
        if (!row) return null;
        if (row.workspace_id && !(await workspacesFor(s, p)).some((w) => w.id === row.workspace_id)) return null;
        at = { ...p, workspaceId: row.workspace_id };
      }
      const w = await s.workflows.workflow(at, ref.id);
      return { kind: 'workflow', id: w.id, tenantId: w.tenant_id, label: w.label, title: w.name, appId: null };
    }
    if (!ref.app) return null;
    const app = await s.apps.app(p, ref.app);
    if (ref.kind === 'app-entity') {
      const e = await s.apps.entityOf(app, ref.id);
      if (!(await s.apps.groupScope.admits(p, (e as { group_id?: string | null }).group_id ?? null))) return null;
      return { kind: 'app-entity', id: e.id, tenantId: app.tenant_id, label: highest(app.label, e.label), title: e.title || e.name, appId: app.id };
    }
    if (ref.kind === 'app-form') {
      const { entity, form } = await s.apps.forms.form(p, app.id, ref.id);
      return { kind: 'app-form', id: form.id, tenantId: app.tenant_id, label: highest(app.label, entity.label), title: form.title || form.name, appId: app.id };
    }
    const r = (await this.db('app_flows').where({ app_id: app.id }).andWhere((q) => q.where({ id: ref.id }).orWhere({ name: ref.id })).first('id', 'name', 'title', 'entity_id')) as { id: string; name: string; title: string | null; entity_id: string } | undefined;
    if (!r) return null;
    const e = await s.apps.entityById(app.tenant_id, r.entity_id);
    return { kind: 'app-flow', id: r.id, tenantId: app.tenant_id, label: highest(app.label, e?.label ?? app.label), title: r.title || r.name, appId: app.id };
  }

  // ---------- state ----------

  private async lockRow(tenantId: string, kind: DesignKind, id: string): Promise<LockRow | null> {
    const r = (await this.db('design_locks').where({ tenant_id: tenantId, kind, object_id: id }).first()) as Record<string, unknown> | undefined;
    return r ? lockFrom(r) : null;
  }

  /** The live lock (an expired row holds nothing). */
  async lockOf(tenantId: string, kind: DesignKind, id: string): Promise<LockRow | null> {
    const r = await this.lockRow(tenantId, kind, id);
    return r && r.expires_at > Date.now() ? r : null;
  }

  async viewers(tenantId: string, kind: DesignKind, id: string): Promise<Viewer[]> {
    const rows = (await this.db('design_viewers').where({ tenant_id: tenantId, kind, object_id: id }).andWhere('seen_at', '>=', Date.now() - this.opts.viewerTtlMs).orderBy('opened_at').select('user_id', 'user_name', 'opened_at')) as { user_id: string; user_name: string; opened_at: number | string }[];
    const out = new Map<string, Viewer>();
    for (const r of rows) if (!out.has(r.user_id)) out.set(r.user_id, { userId: r.user_id, name: r.user_name, since: n(r.opened_at) });
    return [...out.values()];
  }

  async state(tenantId: string, kind: DesignKind, id: string): Promise<Omit<DesignEvent, 'lost'>> {
    const lock = await this.lockOf(tenantId, kind, id);
    return { tenantId, kind, id, viewers: await this.viewers(tenantId, kind, id), lock: lock ? { ...view(lock), socketId: lock.socket_id } : null };
  }

  private async publish(tenantId: string, kind: DesignKind, id: string, lost?: DesignEvent['lost']): Promise<void> {
    const st = await this.state(tenantId, kind, id);
    this.s().bus.publish(DESIGN_TOPIC, { ...st, ...(lost ? { lost } : {}) } satisfies DesignEvent);
  }

  private audit(tenantId: string, action: string, actor: AuditActor, o: { kind: DesignKind; id: string; label: Label; title: string }, detail: Record<string, unknown>, traceId?: string | null, system = false) {
    return this.s().audit.append({ tenantId, action, kind: system ? 'system' : 'admin', actor, target: { design: o.kind, object: o.id, title: o.title }, label: o.label, detail, traceId: traceId ?? null });
  }

  // ---------- presence ----------

  async open(p: Principal, obj: DesignObject, socketId: string): Promise<void> {
    const t = Date.now();
    const where = { socket_id: socketId, kind: obj.kind, object_id: obj.id };
    const values = { tenant_id: obj.tenantId, user_id: p.userId, user_name: nameOf(p), instance_id: this.instanceId, seen_at: t };
    const updated = await this.db('design_viewers').where(where).update(values);
    if (!updated) {
      try {
        await this.db('design_viewers').insert({ ...where, ...values, opened_at: t });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        await this.db('design_viewers').where(where).update(values);
      }
    }
    await this.publish(obj.tenantId, obj.kind, obj.id);
  }

  /** The socket closed the object (or lost access, or disconnected): its viewer row and any lock it holds go. */
  async close(p: Principal, obj: Pick<DesignObject, 'kind' | 'id' | 'tenantId' | 'label' | 'title'>, socketId: string, reason: 'close' | 'disconnect' | 'access'): Promise<void> {
    await this.db('design_viewers').where({ socket_id: socketId, kind: obj.kind, object_id: obj.id }).delete();
    const lock = await this.lockRow(obj.tenantId, obj.kind, obj.id);
    if (lock && lock.socket_id === socketId) {
      const gone = await this.db('design_locks').where({ tenant_id: obj.tenantId, kind: obj.kind, object_id: obj.id, socket_id: socketId }).delete();
      if (gone && lock.expires_at > Date.now()) await this.audit(obj.tenantId, 'design.lock.released', actorFrom(p, null), obj, { reason });
    }
    await this.publish(obj.tenantId, obj.kind, obj.id);
  }

  /** The console's heartbeat: the viewer row stays fresh, and a lock this socket holds is renewed. */
  async heartbeat(obj: DesignObject, socketId: string): Promise<void> {
    const t = Date.now();
    await this.db('design_viewers').where({ socket_id: socketId, kind: obj.kind, object_id: obj.id }).update({ seen_at: t });
    await this.db('design_locks').where({ tenant_id: obj.tenantId, kind: obj.kind, object_id: obj.id, socket_id: socketId }).andWhere('expires_at', '>', t).update({ renewed_at: t, expires_at: t + this.opts.lockTtlMs });
  }

  // ---------- the lock ----------

  /**
   * Takes the edit lock, or renews it for its holder. A live lock held by someone else is refused unless `takeover`
   * (the caller confirmed). Returns the lock as it now stands; `ok: false` names who holds it.
   */
  async acquire(p: Principal, obj: DesignObject, o: LockCtx & { takeover?: boolean } = {}): Promise<{ ok: boolean; lock: LockView | null; tookOver?: boolean }> {
    if (!this.canManage(p, obj.kind)) throw forbidden(`Editing this needs ${MANAGE[obj.kind].join(' and ')}.`, { step: 'role', action: MANAGE[obj.kind][0] });
    const pk = { tenant_id: obj.tenantId, kind: obj.kind, object_id: obj.id };
    for (let attempt = 0; attempt < 4; attempt++) {
      const now = Date.now();
      const row = await this.lockRow(obj.tenantId, obj.kind, obj.id);
      const live = !!row && row.expires_at > now;
      if (live && row.user_id !== p.userId && !o.takeover) return { ok: false, lock: view(row) };
      const values = { label: obj.label, title: obj.title.slice(0, 200), user_id: p.userId, user_name: nameOf(p), session_id: p.sessionId ?? null, socket_id: o.socketId ?? null, instance_id: this.instanceId, renewed_at: now, expires_at: now + this.opts.lockTtlMs };
      if (!row) {
        try {
          await this.db('design_locks').insert({ ...pk, ...values, acquired_at: now });
        } catch (err) {
          if (isUniqueViolation(err)) continue;
          throw err;
        }
        await this.audit(obj.tenantId, 'design.lock.taken', actorFrom(p, o.ip ?? null), obj, { via: o.socketId ? 'socket' : 'api' }, o.traceId);
        await this.publish(obj.tenantId, obj.kind, obj.id);
        return { ok: true, lock: { userId: p.userId, name: values.user_name, since: now, expiresAt: values.expires_at, via: o.socketId ? 'socket' : 'api' } };
      }
      const same = live && row.user_id === p.userId;
      // One conditional write on what was read: of two takers on any instances, one wins and the other reads again.
      const changed = await this.db('design_locks').where(pk).andWhere({ user_id: row.user_id, expires_at: row.expires_at }).update({ ...values, acquired_at: same ? row.acquired_at : now });
      if (!changed) continue;
      const tookOver = live && row.user_id !== p.userId;
      if (!live) await this.audit(obj.tenantId, 'design.lock.taken', actorFrom(p, o.ip ?? null), obj, { via: o.socketId ? 'socket' : 'api' }, o.traceId);
      else if (tookOver) await this.audit(obj.tenantId, 'design.lock.taken_over', actorFrom(p, o.ip ?? null), obj, { from: { user: row.user_id, name: row.user_name }, heldSince: row.acquired_at }, o.traceId);
      // The same person in another tab moves the lock to this one; that tab hears it like a takeover, quietly.
      const lost: DesignEvent['lost'] = tookOver ? { userId: row.user_id, socketId: row.socket_id, by: { userId: p.userId, name: values.user_name }, reason: 'taken_over' } : same && row.socket_id && row.socket_id !== (o.socketId ?? null) ? { userId: row.user_id, socketId: row.socket_id, by: { userId: p.userId, name: values.user_name }, reason: 'moved' } : undefined;
      await this.publish(obj.tenantId, obj.kind, obj.id, lost);
      return { ok: true, lock: { userId: p.userId, name: values.user_name, since: same ? row.acquired_at : now, expiresAt: values.expires_at, via: o.socketId ? 'socket' : 'api' }, ...(tookOver ? { tookOver } : {}) };
    }
    throw conflict('The edit lock changed while taking it. Try again.');
  }

  /** Releases the caller's own lock (from this socket only, when one is named). Returns whether one was released. */
  async release(p: Principal, obj: Pick<DesignObject, 'kind' | 'id' | 'tenantId' | 'label' | 'title'>, reason: 'release' | 'save' | 'close', o: LockCtx = {}): Promise<boolean> {
    const lock = await this.lockOf(obj.tenantId, obj.kind, obj.id);
    if (!lock || lock.user_id !== p.userId || (o.socketId && lock.socket_id !== o.socketId)) return false;
    const gone = await this.db('design_locks').where({ tenant_id: obj.tenantId, kind: obj.kind, object_id: obj.id, user_id: p.userId, expires_at: lock.expires_at }).delete();
    if (!gone) return false;
    await this.audit(obj.tenantId, 'design.lock.released', actorFrom(p, o.ip ?? null), obj, { reason, heldSince: lock.acquired_at }, o.traceId);
    await this.publish(obj.tenantId, obj.kind, obj.id);
    return true;
  }

  /**
   * Called by a design's save route before it writes: a live lock held by someone else refuses the save (409 with
   * who holds it, since when). No lock, or the caller's own, lets it through.
   */
  async assertCanSave(p: Principal, kind: DesignKind, tenantId: string, id: string): Promise<void> {
    const lock = await this.lockOf(tenantId, kind, id);
    if (!lock || lock.user_id === p.userId) return;
    throw new HttpProblem(409, 'Being edited', `${lock.user_name} is editing this since ${new Date(lock.acquired_at).toISOString()}. Their edit lock must be released, expire or be taken over before you save.`, { extensions: { lock: view(lock), design: kind } });
  }

  /** After a successful save: the saver's lock is released (they take it again with their next change). */
  async releaseOnSave(p: Principal, kind: DesignKind, obj: { tenantId: string; id: string; label: Label; title: string }, o: LockCtx = {}): Promise<void> {
    await this.release(p, { kind, ...obj }, 'save', o).catch((err: unknown) => this.s().log.warn({ err, kind }, 'design lock not released after save'));
  }

  /** A tenant admin removes someone's lock without taking it. */
  async breakLock(p: Principal, kind: DesignKind, id: string, o: LockCtx = {}): Promise<LockView> {
    if (!this.canBreak(p)) throw forbidden(`Breaking an edit lock needs ${BREAK_PERMISSION}.`, { step: 'role', action: BREAK_PERMISSION });
    const lock = await this.lockOf(p.tenantId, kind, id);
    if (!lock || !clears(p.clearance, lock.label)) throw notFound('Edit lock');
    const gone = await this.db('design_locks').where({ tenant_id: p.tenantId, kind, object_id: id, user_id: lock.user_id, expires_at: lock.expires_at }).delete();
    if (!gone) throw notFound('Edit lock');
    await this.audit(p.tenantId, 'design.lock.broken', actorFrom(p, o.ip ?? null), { kind, id, label: lock.label, title: lock.title }, { holder: { user: lock.user_id, name: lock.user_name }, heldSince: lock.acquired_at }, o.traceId);
    await this.publish(p.tenantId, kind, id, { userId: lock.user_id, socketId: lock.socket_id, by: { userId: p.userId, name: nameOf(p) }, reason: 'broken' });
    return view(lock);
  }

  /** Live locks in the caller's tenant within their clearance, for tenant admins. */
  async list(p: Principal): Promise<(LockView & { kind: DesignKind; id: string; title: string; label: Label })[]> {
    const rows = ((await this.db('design_locks').where({ tenant_id: p.tenantId }).andWhere('expires_at', '>', Date.now()).orderBy('acquired_at')) as Record<string, unknown>[]).map(lockFrom);
    return rows.filter((r) => clears(p.clearance, r.label)).map((r) => ({ kind: r.kind, id: r.object_id, title: r.title, label: r.label, ...view(r) }));
  }

  // ---------- sweeping ----------

  /** Viewer rows past their lease and expired locks go; the objects they belonged to publish their new state. */
  async sweep(): Promise<void> {
    const now = Date.now();
    const touched = new Map<string, { tenantId: string; kind: DesignKind; id: string }>();
    const stale = (await this.db('design_viewers').where('seen_at', '<', now - this.opts.viewerTtlMs).select('socket_id', 'tenant_id', 'kind', 'object_id')) as { socket_id: string; tenant_id: string; kind: DesignKind; object_id: string }[];
    for (const r of stale) {
      const gone = await this.db('design_viewers').where({ socket_id: r.socket_id, kind: r.kind, object_id: r.object_id }).andWhere('seen_at', '<', now - this.opts.viewerTtlMs).delete();
      if (gone) touched.set(`${r.tenant_id}:${r.kind}:${r.object_id}`, { tenantId: r.tenant_id, kind: r.kind, id: r.object_id });
    }
    const expired = ((await this.db('design_locks').where('expires_at', '<=', now)) as Record<string, unknown>[]).map(lockFrom);
    for (const r of expired) {
      const gone = await this.db('design_locks').where({ tenant_id: r.tenant_id, kind: r.kind, object_id: r.object_id, expires_at: r.expires_at }).delete();
      if (!gone) continue;
      await this.audit(r.tenant_id, 'design.lock.released', { service: 'design-locks' }, { kind: r.kind, id: r.object_id, label: r.label, title: r.title }, { reason: 'expired', holder: { user: r.user_id, name: r.user_name }, heldSince: r.acquired_at }, null, true);
      touched.set(`${r.tenant_id}:${r.kind}:${r.object_id}`, { tenantId: r.tenant_id, kind: r.kind, id: r.object_id });
    }
    for (const t of touched.values()) await this.publish(t.tenantId, t.kind, t.id);
  }
}

// ---------- the socket protocol ----------

interface Data {
  principal: Principal;
  /** Design objects this socket has open, by `<kind>:<id>`, with the reference it opened them by. */
  designs?: Map<string, { ref: DesignRef; obj: DesignObject }>;
}

interface Io {
  of(nsp: '/'): { adapter: { rooms: Map<string, Set<string>> }; sockets: Map<string, Socket> };
}

const kindSchema = z.enum(DESIGN_KINDS);
const openMsg = z.object({ kind: kindSchema, id: z.string().min(1).max(63), app: z.string().min(1).max(63).optional() }).strict();
const objMsg = z.object({ kind: kindSchema, id: z.string().regex(ID26) }).strict();
const lockMsg = z.object({ kind: kindSchema, id: z.string().regex(ID26), takeover: z.boolean().optional() }).strict();

/** The state as one socket hears it: whether the lock is its own (this socket) or its person's (another tab). */
export function forSocket(e: Omit<DesignEvent, 'lost' | 'tenantId'>, socketId: string, userId: string) {
  return {
    kind: e.kind,
    id: e.id,
    viewers: e.viewers.map((v) => ({ ...v, you: v.userId === userId })),
    lock: e.lock ? { userId: e.lock.userId, name: e.lock.name, since: e.lock.since, expiresAt: e.lock.expiresAt, via: e.lock.via, mine: !!e.lock.socketId && e.lock.socketId === socketId, you: e.lock.userId === userId } : null
  };
}

/**
 * Wires the design presence protocol into Socket.io: `design.open`, `design.heartbeat`, `design.lock`,
 * `design.unlock` and `design.close` from consoles; `design.state`, `design.lock.lost` and `design.closed` to them.
 */
export function attachDesignLocks(io: Io, s: Services): { onConnection(socket: Socket): void; offs: (() => void)[] } {
  const locks = s.designLocks;
  const key = (kind: DesignKind, id: string) => `${kind}:${id}`;

  const offs = [
    s.bus.on<DesignEvent>(DESIGN_TOPIC, (e) => {
      if (!e?.tenantId || !(DESIGN_KINDS as readonly string[]).includes(e.kind)) return;
      for (const sid of io.of('/').adapter.rooms.get(designRoom(e.tenantId, e.kind, e.id)) ?? []) {
        const socket = io.of('/').sockets.get(sid);
        const d = socket?.data as Data | undefined;
        if (!socket || !d || d.principal.tenantId !== e.tenantId) continue;
        socket.emit('design.state', forSocket(e, sid, d.principal.userId));
        const l = e.lost;
        if (l && l.userId === d.principal.userId && (l.socketId ? l.socketId === sid : true)) socket.emit('design.lock.lost', { kind: e.kind, id: e.id, by: l.by, reason: l.reason });
      }
    })
  ];

  const onConnection = (socket: Socket) => {
    const d = socket.data as Data;
    let budget = { start: Date.now(), n: 0 };
    const within = () => {
      const now = Date.now();
      if (now - budget.start >= 60_000) budget = { start: now, n: 0 };
      return ++budget.n <= 120;
    };
    const evict = async (k: string) => {
      const o = d.designs?.get(k);
      if (!o) return;
      d.designs!.delete(k);
      void socket.leave(designRoom(o.obj.tenantId, o.obj.kind, o.obj.id));
      socket.emit('design.closed', { kind: o.obj.kind, id: o.obj.id });
      await locks.close(d.principal, o.obj, socket.id, 'access');
    };
    const reply = (ack: unknown) => (typeof ack === 'function' ? (ack as (r: unknown) => void) : () => undefined);
    const fail = (err: unknown, done: (r: unknown) => void, what: string) => {
      if (!(err instanceof HttpProblem)) s.log.warn({ err }, `design ${what} failed`);
      done({ ok: false, error: err instanceof HttpProblem && err.status === 403 ? err.detail : 'Not available to you.' });
    };

    socket.on('design.open', async (msg: unknown, ack?: unknown) => {
      const done = reply(ack);
      const parsed = openMsg.safeParse(msg);
      if (!parsed.success) return done({ ok: false, error: 'Name a design kind and an id.' });
      if (!within()) return done({ ok: false, error: 'Too many requests; slow down.' });
      d.designs ??= new Map();
      try {
        const ref: DesignRef = { kind: parsed.data.kind, id: parsed.data.id, ...(parsed.data.app ? { app: parsed.data.app } : {}) };
        const obj = await locks.resolve(d.principal, ref);
        const k = key(obj.kind, obj.id);
        if (!d.designs.has(k) && d.designs.size >= MAX_OPEN_PER_SOCKET) return done({ ok: false, error: 'Too many designs open at once.' });
        if (!socket.connected) return done({ ok: false, error: 'Disconnected.' });
        d.designs.set(k, { ref, obj });
        await socket.join(designRoom(obj.tenantId, obj.kind, obj.id));
        await locks.open(d.principal, obj, socket.id);
        const st = await locks.state(obj.tenantId, obj.kind, obj.id);
        done({ ok: true, title: obj.title, label: obj.label, canManage: locks.canManage(d.principal, obj.kind), canBreak: locks.canBreak(d.principal), ...forSocket(st, socket.id, d.principal.userId) });
      } catch (err) {
        fail(err, done, 'open');
      }
    });

    socket.on('design.heartbeat', async (msg: unknown, ack?: unknown) => {
      const done = reply(ack);
      const parsed = objMsg.safeParse(msg);
      if (!parsed.success) return done({ ok: false, error: 'Name a design kind and an id.' });
      const k = key(parsed.data.kind, parsed.data.id);
      const o = d.designs?.get(k);
      if (!o) return done({ ok: false, error: 'Open it first.' });
      try {
        // Access is checked again: a label raised above the clearance, or a lost workspace, ends the watch.
        const obj = await locks.resolve(d.principal, o.ref).catch(() => null);
        if (!obj || obj.id !== o.obj.id) {
          await evict(k);
          return done({ ok: false, error: 'Not available to you.' });
        }
        o.obj = obj;
        await locks.heartbeat(obj, socket.id);
        done({ ok: true, ...forSocket(await locks.state(obj.tenantId, obj.kind, obj.id), socket.id, d.principal.userId) });
      } catch (err) {
        fail(err, done, 'heartbeat');
      }
    });

    socket.on('design.lock', async (msg: unknown, ack?: unknown) => {
      const done = reply(ack);
      const parsed = lockMsg.safeParse(msg);
      if (!parsed.success) return done({ ok: false, error: 'Name a design kind and an id.' });
      if (!within()) return done({ ok: false, error: 'Too many requests; slow down.' });
      const o = d.designs?.get(key(parsed.data.kind, parsed.data.id));
      if (!o) return done({ ok: false, error: 'Open it first.' });
      try {
        const obj = await locks.resolve(d.principal, o.ref);
        o.obj = obj;
        const out = await locks.acquire(d.principal, obj, { socketId: socket.id, takeover: !!parsed.data.takeover, ip: socket.handshake.address ?? null });
        done({ ok: out.ok, ...forSocket(await locks.state(obj.tenantId, obj.kind, obj.id), socket.id, d.principal.userId), ...(out.ok ? {} : { error: `${out.lock?.name ?? 'Someone'} is editing this.` }) });
      } catch (err) {
        fail(err, done, 'lock');
      }
    });

    socket.on('design.unlock', async (msg: unknown, ack?: unknown) => {
      const done = reply(ack);
      const parsed = objMsg.safeParse(msg);
      if (!parsed.success) return done({ ok: false });
      const o = d.designs?.get(key(parsed.data.kind, parsed.data.id));
      if (!o) return done({ ok: false });
      try {
        done({ ok: await locks.release(d.principal, o.obj, 'release', { socketId: socket.id, ip: socket.handshake.address ?? null }) });
      } catch (err) {
        fail(err, done, 'unlock');
      }
    });

    socket.on('design.close', async (msg: unknown) => {
      const parsed = objMsg.safeParse(msg);
      if (!parsed.success) return;
      const k = key(parsed.data.kind, parsed.data.id);
      const o = d.designs?.get(k);
      if (!o) return;
      d.designs!.delete(k);
      void socket.leave(designRoom(o.obj.tenantId, o.obj.kind, o.obj.id));
      await locks.close(d.principal, o.obj, socket.id, 'close').catch((err: unknown) => s.log.warn({ err }, 'design close failed'));
    });

    socket.on('disconnect', () => {
      for (const o of d.designs?.values() ?? []) void locks.close(d.principal, o.obj, socket.id, 'disconnect').catch(() => undefined);
      d.designs?.clear();
    });
  };

  return { onConnection, offs };
}
