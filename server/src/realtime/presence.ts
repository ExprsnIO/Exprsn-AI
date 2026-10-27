import type { Socket } from 'socket.io';
import { z } from 'zod';
import type { Principal } from '../authz/policy.js';
import { TOPICS, type MembershipEvent } from '../platform/bus.js';
import { MAX_WATCH, type PresenceEvent } from '../profiles/presence.js';
import type { SocialRelationEvent } from '../social/service.js';
import type { Services } from '../services.js';

/*
 * Presence over the console's socket (B-5802, on the B-2603 sockets):
 *
 * - Every authenticated socket counts as a connection of its person (`PresenceService.connected`), until it closes.
 * - `presence.idle {idle}`: the console says its person went idle (no input for five minutes, or the page hidden) or
 *   came back; with every socket idle, an `auto` status reads away.
 * - `presence.watch {userIds}`: the people this socket wants to hear about (replacing the previous set, at most 200).
 *   The server keeps those the caller may see (`visibleAmong`: a shared workspace, no block), joins their presence
 *   rooms and answers their statuses. Clients never name rooms.
 * - `presence.changed {userId, status, at}`: relayed from `TOPICS.presence` to the person's presence room, without
 *   the user rooms of people in a block with them, and to the person's own sockets.
 * - A block made between two people takes each out of the other's presence room at once; losing a workspace checks
 *   the socket's watch again.
 */

export const presenceRoom = (tenantId: string, userId: string) => `presence:${tenantId}:${userId}`;

interface Data {
  principal: Principal;
  presenceWatch?: Set<string>;
}

interface Io {
  of(nsp: '/'): { adapter: { rooms: Map<string, Set<string>> }; sockets: Map<string, Socket> };
  local: { to(room: string | string[]): { except(room: string | string[]): { emit(ev: string, data: unknown): void }; emit(ev: string, data: unknown): void } };
}

const id = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
const watchMsg = z.object({ userIds: z.array(id).max(MAX_WATCH) }).strict();
const idleMsg = z.object({ idle: z.boolean() }).strict();

export function attachPresence(io: Io, s: Services, userRoom: (userId: string) => string): { onConnection(socket: Socket): void; offs: (() => void)[] } {
  const socketsOf = (userId: string): [Socket, Data][] => {
    const out: [Socket, Data][] = [];
    for (const sid of io.of('/').adapter.rooms.get(userRoom(userId)) ?? []) {
      const socket = io.of('/').sockets.get(sid);
      const d = socket?.data as Data | undefined;
      if (socket && d) out.push([socket, d]);
    }
    return out;
  };

  const unwatch = (socket: Socket, d: Data, userId: string) => {
    if (!d.presenceWatch?.delete(userId)) return;
    void socket.leave(presenceRoom(d.principal.tenantId, userId));
  };

  const offs = [
    s.bus.on<PresenceEvent>(TOPICS.presence, (e) => {
      if (!e?.tenantId || !e.userId) return;
      const data = { userId: e.userId, status: e.status, at: e.at };
      const to = io.local.to([presenceRoom(e.tenantId, e.userId), userRoom(e.userId)]);
      const except = (Array.isArray(e.exceptUserIds) ? e.exceptUserIds : []).map(userRoom);
      (except.length ? to.except(except) : to).emit('presence.changed', data);
    }),
    // A block, at once, both ways: neither hears the other's presence from now on.
    s.bus.on<SocialRelationEvent>(TOPICS.socialRelation, (e) => {
      if (e.kind !== 'block' || !e.on) return;
      for (const [socket, d] of socketsOf(e.userId)) if (d.principal.tenantId === e.tenantId) unwatch(socket, d, e.targetId);
      for (const [socket, d] of socketsOf(e.targetId)) if (d.principal.tenantId === e.tenantId) unwatch(socket, d, e.userId);
    }),
    // Left workspaces: keep watching only those still visible.
    s.bus.on<MembershipEvent>(TOPICS.workspaceMembership, (e) => {
      for (const [socket, d] of socketsOf(e.userId)) {
        if (d.principal.tenantId !== e.tenantId || !d.presenceWatch?.size) continue;
        const watched = [...d.presenceWatch];
        void s.presence
          .visibleAmong(d.principal, watched)
          .then((ok) => {
            for (const u of watched) if (!ok.has(u)) unwatch(socket, d, u);
          })
          .catch(() => watched.forEach((u) => unwatch(socket, d, u)));
      }
    })
  ];

  const onConnection = (socket: Socket) => {
    const d = socket.data as Data;
    const p = d.principal;
    void s.presence.connected(p.tenantId, p.userId, socket.id);
    socket.on('disconnect', () => void s.presence.disconnected(p.tenantId, p.userId, socket.id));
    socket.on('presence.idle', (msg: unknown) => {
      const parsed = idleMsg.safeParse(msg);
      if (parsed.success) void s.presence.activity(p.tenantId, p.userId, socket.id, parsed.data.idle);
    });
    socket.on('presence.watch', async (msg: unknown, ack?: (r: unknown) => void) => {
      const reply = typeof ack === 'function' ? ack : () => undefined;
      const parsed = watchMsg.safeParse(msg);
      if (!parsed.success) return reply({ ok: false, error: `Name at most ${MAX_WATCH} user ids.` });
      try {
        const visible = await s.presence.visibleAmong(d.principal, parsed.data.userIds);
        if (!socket.connected) return reply({ ok: false, error: 'Disconnected.' });
        d.presenceWatch ??= new Set();
        for (const u of [...d.presenceWatch]) if (!visible.has(u)) unwatch(socket, d, u);
        const fresh = [...visible].filter((u) => !d.presenceWatch!.has(u));
        for (const u of fresh) d.presenceWatch.add(u);
        if (fresh.length) await socket.join(fresh.map((u) => presenceRoom(p.tenantId, u)));
        const eff = await s.presence.effective(p.tenantId, [...visible]);
        reply({ ok: true, statuses: Object.fromEntries(eff) });
      } catch {
        reply({ ok: false, error: 'Presence not available.' });
      }
    });
    socket.on('presence.unwatch', () => {
      for (const u of [...(d.presenceWatch ?? [])]) unwatch(socket, d, u);
    });
  };

  return { onConnection, offs };
}
