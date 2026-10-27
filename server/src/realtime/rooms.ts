import type { Socket } from 'socket.io';
import { z } from 'zod';
import { clears, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { TOPICS, type Bus, type MembershipEvent } from '../platform/bus.js';

/*
 * Realtime rooms for the 1.4.0 domains (B-2101): messaging conversations, groups, feeds and customer-service
 * channels. The mechanism is the one shared conversations use (B-705, B-1305), made generic:
 *
 * - A client asks to join (`room.join { kind, id }`); the domain's authoriser decides from the principal, now, and
 *   the server picks the room name. Clients never name rooms. A kind with no authoriser registered admits nobody.
 * - Domains publish into a room through the bus (`RoomRegistry.emit`), so every instance relays to the sockets it
 *   holds.
 * - When access may have ended (a member removed, a label raised, the object deleted) the domain publishes a
 *   `RoomAccessEvent`. Sockets named by it (by user or by clearance) leave the room at once, synchronously, before any
 *   further event is relayed; then each is checked again and let back in if it is still entitled another way, or told
 *   `room.closed`. Losing a workspace (`workspace.membership`) does the same for rooms admitted through it.
 */

export const ROOM_KINDS = ['conversation', 'group', 'feed', 'channel'] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];

/** What an authoriser grants: the label of what the room carries and the workspace that let the user in. */
export interface RoomGrant {
  label: Label;
  workspaceId?: string | null;
}

/** Decides, from the principal, whether it may be in the room for this object; null refuses. */
export type RoomAuthorizer = (p: Principal, id: string) => Promise<RoomGrant | null>;

/**
 * A signal a client sends into a room it is in (`room.signal {kind, id, signal, data}`): typing, delivery and read
 * receipts. The domain decides what, if anything, to relay; it never trusts the client to name recipients.
 */
export type RoomSignalHandler = (p: Principal, id: string, signal: string, data: Record<string, unknown>) => Promise<void>;

/** Called when a socket joins a room (after its authoriser admitted it) and when it leaves or disconnects. */
export interface RoomPresenceHooks {
  joined?(p: Principal, id: string): Promise<void>;
  left?(p: Principal, id: string): Promise<void>;
}

export interface RoomAccessEvent {
  tenantId: string;
  kind: RoomKind;
  id: string;
  /** These users' sockets leave at once (then are checked again). */
  userIds?: string[];
  /** Sockets whose clearance does not reach this label leave at once (then are checked again). */
  label?: Label;
}

export interface RoomEvent {
  tenantId: string;
  kind: RoomKind;
  id: string;
  /** The socket event name; it must start with `<kind>.` so a domain cannot impersonate platform events. */
  event: string;
  data: Record<string, unknown>;
  /** Not to this user's sockets (the author already has it). */
  exceptUserId?: string;
  /**
   * Not to these users' sockets either (1.4.0, B-2603 and B-2702: people in a block with the actor, from
   * `SocialService.emitToRoom`). Decided where the event is raised, so every instance relays the same filtered event.
   */
  exceptUserIds?: string[];
}

export const MAX_ROOMS_PER_SOCKET = 50;
const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const EVENT = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/;

export const roomName = (tenantId: string, kind: RoomKind, id: string) => `room:${kind}:${tenantId}:${id}`;

/** One kind's numbers on this instance (B-4206, Social and messaging › Realtime). */
export interface RoomKindStats {
  kind: RoomKind;
  rooms: number;
  sockets: number;
  /** Signals relayed per minute, the last 12 minutes, oldest first. */
  signalsPerMinute: number[];
  /** Signals refused by ROOM_SIGNALS_PER_MINUTE in the last hour. */
  refusedLastHour: number;
}

const MINUTE = 60_000;

/**
 * 1.6.0 (B-4206): counters for the Realtime tab, kept per instance in memory: signals relayed and refused per room kind
 * by the minute (an hour of buckets), socket authentication failures in the last hour, and an inspector that
 * `attachRooms` sets to count the rooms and sockets this instance holds. Nothing here names a user or a room.
 */
export class RoomStats {
  private readonly buckets = new Map<RoomKind, { minute: number; signals: number; refused: number }[]>();
  private failures: number[] = [];
  inspector: (() => { byKind: Map<RoomKind, { rooms: number; sockets: number }>; sockets: number }) | null = null;

  private bucket(kind: RoomKind, now: number) {
    const minute = Math.floor(now / MINUTE);
    const list = this.buckets.get(kind) ?? [];
    let b = list[list.length - 1];
    if (!b || b.minute !== minute) {
      b = { minute, signals: 0, refused: 0 };
      list.push(b);
      while (list.length && list[0]!.minute <= minute - 60) list.shift();
      this.buckets.set(kind, list);
    }
    return b;
  }

  signal(kind: RoomKind, now = Date.now()): void {
    this.bucket(kind, now).signals++;
  }

  refused(kind: RoomKind, now = Date.now()): void {
    this.bucket(kind, now).refused++;
  }

  authFailed(now = Date.now()): void {
    this.failures.push(now);
    if (this.failures.length > 10_000) this.failures = this.failures.slice(-5000);
  }

  snapshot(now = Date.now()): { kinds: RoomKindStats[]; sockets: number; authFailuresLastHour: number } {
    const minute = Math.floor(now / MINUTE);
    const live = this.inspector?.() ?? { byKind: new Map(), sockets: 0 };
    this.failures = this.failures.filter((t) => t > now - 60 * MINUTE);
    const kinds = ROOM_KINDS.map((kind) => {
      const list = (this.buckets.get(kind) ?? []).filter((b) => b.minute > minute - 60);
      const spark = Array.from({ length: 12 }, (_, i) => list.find((b) => b.minute === minute - 11 + i)?.signals ?? 0);
      const n = live.byKind.get(kind) ?? { rooms: 0, sockets: 0 };
      return { kind, rooms: n.rooms, sockets: n.sockets, signalsPerMinute: spark, refusedLastHour: list.reduce((a, b) => a + b.refused, 0) };
    });
    return { kinds, sockets: live.sockets, authFailuresLastHour: this.failures.length };
  }
}

/** The authorisers domains register (on `s.rooms`) and the helpers they publish with. */
export class RoomRegistry {
  /** 1.6.0 (B-4206): this instance's room counters. */
  readonly stats = new RoomStats();
  private readonly authorizers = new Map<RoomKind, RoomAuthorizer>();
  private readonly signals = new Map<RoomKind, RoomSignalHandler>();
  private readonly presence = new Map<RoomKind, RoomPresenceHooks>();

  constructor(private readonly bus: Bus) {}

  register(kind: RoomKind, authorize: RoomAuthorizer): () => void {
    if (!(ROOM_KINDS as readonly string[]).includes(kind)) throw new Error(`Unknown room kind ${kind}`);
    if (this.authorizers.has(kind)) throw new Error(`Rooms of kind ${kind} already have an authoriser`);
    this.authorizers.set(kind, authorize);
    return () => {
      if (this.authorizers.get(kind) === authorize) this.authorizers.delete(kind);
    };
  }

  /** Handles the signals clients send into rooms of this kind (1.4.0, B-2603); kinds without one ignore signals. */
  onSignal(kind: RoomKind, handler: RoomSignalHandler): () => void {
    if (this.signals.has(kind)) throw new Error(`Rooms of kind ${kind} already have a signal handler`);
    this.signals.set(kind, handler);
    return () => {
      if (this.signals.get(kind) === handler) this.signals.delete(kind);
    };
  }

  /** Hooks for sockets joining and leaving rooms of this kind (presence, B-2603). */
  onPresence(kind: RoomKind, hooks: RoomPresenceHooks): () => void {
    if (this.presence.has(kind)) throw new Error(`Rooms of kind ${kind} already have presence hooks`);
    this.presence.set(kind, hooks);
    return () => {
      if (this.presence.get(kind) === hooks) this.presence.delete(kind);
    };
  }

  async signal(p: Principal, kind: RoomKind, id: string, signal: string, data: Record<string, unknown>): Promise<boolean> {
    const fn = this.signals.get(kind);
    if (!fn) return false;
    await fn(p, id, signal, data);
    return true;
  }

  async joined(p: Principal, kind: RoomKind, id: string): Promise<void> {
    await this.presence.get(kind)?.joined?.(p, id);
  }

  async left(p: Principal, kind: RoomKind, id: string): Promise<void> {
    await this.presence.get(kind)?.left?.(p, id);
  }

  async authorize(p: Principal, kind: RoomKind, id: string): Promise<RoomGrant | null> {
    const fn = this.authorizers.get(kind);
    if (!fn) return null;
    const g = await fn(p, id);
    // The grant's label is checked here too: an authoriser cannot let a socket hear above its clearance.
    return g && clears(p.clearance, g.label) ? g : null;
  }

  /** Relays an event to every socket in the room, on every instance. */
  emit(e: RoomEvent): void {
    if (!e.event.startsWith(`${e.kind}.`) || !EVENT.test(e.event)) throw new Error(`Room events of kind ${e.kind} are named ${e.kind}.<name>`);
    this.bus.publish(TOPICS.roomEvent, e);
  }

  /** Access to a room may have ended: the named sockets leave at once and are checked again. */
  accessChanged(e: RoomAccessEvent): void {
    this.bus.publish(TOPICS.roomAccess, e);
  }
}

export interface RoomSocketData {
  principal: Principal;
  /** Domain rooms this socket is in, by room name, with the grant that let it in. */
  rooms?: Map<string, { kind: RoomKind; id: string; grant: RoomGrant }>;
}

interface Io {
  of(nsp: '/'): { adapter: { rooms: Map<string, Set<string>> }; sockets: Map<string, Socket> };
  local: { to(room: string): { except(room: string | string[]): { emit(ev: string, data: unknown): void }; emit(ev: string, data: unknown): void } };
}

const joinMsg = z.object({ kind: z.enum(ROOM_KINDS), id: z.string().regex(ID) }).strict();
const signalMsg = z.object({ kind: z.enum(ROOM_KINDS), id: z.string().regex(ID), signal: z.string().regex(/^[a-z][a-z-]{0,30}$/), data: z.record(z.string(), z.unknown()).optional() }).strict();

/**
 * Wires the room protocol into Socket.io: `room.join` and `room.leave` from clients, room events and access changes
 * from the bus, and workspace membership changes. Returns the bus unsubscribers.
 */
export function attachRooms(io: Io, registry: RoomRegistry, bus: Bus, userRoom: (userId: string) => string, log: { warn(o: object, m: string): void }, opts: { signalsPerMinute?: number } = {}): { onConnection(socket: Socket): void; offs: (() => void)[] } {
  const signalsPerMinute = opts.signalsPerMinute ?? 60;
  // 1.6.0 (B-4206): the Realtime tab counts the rooms and sockets this instance holds, by kind.
  registry.stats.inspector = () => {
    const byKind = new Map<RoomKind, { rooms: number; sockets: number }>();
    const sids = new Map<RoomKind, Set<string>>();
    for (const [name, members] of io.of('/').adapter.rooms) {
      if (!name.startsWith('room:')) continue;
      const kind = name.split(':')[1] as RoomKind;
      if (!(ROOM_KINDS as readonly string[]).includes(kind)) continue;
      const e = byKind.get(kind) ?? { rooms: 0, sockets: 0 };
      e.rooms++;
      byKind.set(kind, e);
      const set = sids.get(kind) ?? new Set<string>();
      for (const sid of members) set.add(sid);
      sids.set(kind, set);
    }
    for (const [kind, set] of sids) byKind.get(kind)!.sockets = set.size;
    return { byKind, sockets: io.of('/').sockets.size };
  };
  const presence = (fn: 'joined' | 'left', p: Principal, kind: RoomKind, id: string) => {
    void registry[fn](p, kind, id).catch((err: unknown) => log.warn({ err, kind }, `room ${fn} hook failed`));
  };
  const recheck = (socket: Socket, d: RoomSocketData, room: string, kind: RoomKind, id: string) => {
    void registry
      .authorize(d.principal, kind, id)
      .then(async (g) => {
        if (!socket.connected) return;
        if (!g) {
          socket.emit('room.closed', { kind, id });
          return;
        }
        d.rooms ??= new Map();
        d.rooms.set(room, { kind, id, grant: g });
        await socket.join(room);
      })
      .catch((err: unknown) => {
        log.warn({ err, kind }, 'room re-check failed');
        socket.emit('room.closed', { kind, id });
      });
  };

  /** Leaves at once (synchronously: no relayed event can slip in between), then checks again. */
  const evict = (socket: Socket, d: RoomSocketData, room: string, kind: RoomKind, id: string) => {
    void socket.leave(room);
    d.rooms?.delete(room);
    recheck(socket, d, room, kind, id);
  };

  const confirm = (socket: Socket, d: RoomSocketData, room: string, kind: RoomKind, id: string) => {
    void registry
      .authorize(d.principal, kind, id)
      .catch(() => null)
      .then((g) => {
        if (g) {
          d.rooms?.set(room, { kind, id, grant: g });
          return;
        }
        void socket.leave(room);
        d.rooms?.delete(room);
        socket.emit('room.closed', { kind, id });
      });
  };

  const socketsIn = (room: string): [Socket, RoomSocketData][] => {
    const ids = io.of('/').adapter.rooms.get(room);
    if (!ids) return [];
    const out: [Socket, RoomSocketData][] = [];
    for (const sid of [...ids]) {
      const socket = io.of('/').sockets.get(sid);
      const d = socket?.data as RoomSocketData | undefined;
      if (socket && d) out.push([socket, d]);
    }
    return out;
  };

  const offs = [
    bus.on<RoomEvent>(TOPICS.roomEvent, (e) => {
      if (!e?.event?.startsWith(`${e.kind}.`) || !EVENT.test(e.event)) return;
      const to = io.local.to(roomName(e.tenantId, e.kind, e.id));
      const except = [...(e.exceptUserId ? [e.exceptUserId] : []), ...(Array.isArray(e.exceptUserIds) ? e.exceptUserIds : [])].map(userRoom);
      (except.length ? to.except(except) : to).emit(e.event, { kind: e.kind, id: e.id, ...e.data });
    }),
    bus.on<RoomAccessEvent>(TOPICS.roomAccess, (e) => {
      const room = roomName(e.tenantId, e.kind, e.id);
      const users = e.userIds ? new Set(e.userIds) : null;
      for (const [socket, d] of socketsIn(room)) {
        const named = (users && users.has(d.principal.userId)) || (e.label && !clears(d.principal.clearance, e.label));
        if (named) evict(socket, d, room, e.kind, e.id);
        // Nobody named: everyone is checked again where they are, and only those refused leave.
        else if (!users && !e.label) confirm(socket, d, room, e.kind, e.id);
      }
    }),
    bus.on<MembershipEvent>(TOPICS.workspaceMembership, (e) => {
      const lost = new Set(e.workspaceIds);
      for (const [socket, d] of socketsIn(userRoom(e.userId))) {
        if (d.principal.tenantId !== e.tenantId || !d.rooms) continue;
        for (const [room, r] of [...d.rooms]) if (r.grant.workspaceId && lost.has(r.grant.workspaceId)) evict(socket, d, room, r.kind, r.id);
      }
    })
  ];

  const onConnection = (socket: Socket) => {
    const d = socket.data as RoomSocketData;
    socket.on('room.join', async (msg: unknown, ack?: (r: unknown) => void) => {
      const reply = typeof ack === 'function' ? ack : () => undefined;
      const parsed = joinMsg.safeParse(msg);
      if (!parsed.success) return reply({ ok: false, error: 'Name a room kind and an id.' });
      const { kind, id } = parsed.data;
      const room = roomName(d.principal.tenantId, kind, id);
      d.rooms ??= new Map();
      if (!d.rooms.has(room) && d.rooms.size >= MAX_ROOMS_PER_SOCKET) return reply({ ok: false, error: 'In too many rooms at once.' });
      try {
        const g = await registry.authorize(d.principal, kind, id);
        if (!g || !socket.connected) return reply({ ok: false, error: 'Not available to you.' });
        const fresh = !d.rooms.has(room);
        d.rooms.set(room, { kind, id, grant: g });
        await socket.join(room);
        reply({ ok: true, label: g.label });
        if (fresh) presence('joined', d.principal, kind, id);
      } catch (err) {
        log.warn({ err, kind }, 'room join failed');
        reply({ ok: false, error: 'Not available to you.' });
      }
    });
    socket.on('room.leave', (msg: unknown) => {
      const parsed = joinMsg.safeParse(msg);
      if (!parsed.success) return;
      const room = roomName(d.principal.tenantId, parsed.data.kind, parsed.data.id);
      if (!d.rooms?.delete(room)) return;
      void socket.leave(room);
      presence('left', d.principal, parsed.data.kind, parsed.data.id);
    });
    // B-2603: signals into a room the socket is in now (typing, receipts), at most `signalsPerMinute` a minute.
    let budget = { start: Date.now(), n: 0 };
    socket.on('room.signal', async (msg: unknown, ack?: (r: unknown) => void) => {
      const reply = typeof ack === 'function' ? ack : () => undefined;
      const parsed = signalMsg.safeParse(msg);
      if (!parsed.success) return reply({ ok: false, error: 'Name a room kind, an id and a signal.' });
      const { kind, id, signal, data } = parsed.data;
      if (!d.rooms?.has(roomName(d.principal.tenantId, kind, id))) return reply({ ok: false, error: 'Join the room first.' });
      const now = Date.now();
      if (now - budget.start >= 60_000) budget = { start: now, n: 0 };
      if (++budget.n > signalsPerMinute) {
        registry.stats.refused(kind, now);
        return reply({ ok: false, error: 'Too many signals; slow down.' });
      }
      registry.stats.signal(kind, now);
      try {
        reply({ ok: await registry.signal(d.principal, kind, id, signal, data ?? {}) });
      } catch (err) {
        log.warn({ err, kind, signal }, 'room signal failed');
        reply({ ok: false, error: 'Signal refused.' });
      }
    });
    socket.on('disconnect', () => {
      for (const r of d.rooms?.values() ?? []) presence('left', d.principal, r.kind, r.id);
    });
  };

  return { onConnection, offs };
}
