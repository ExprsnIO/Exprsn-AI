import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { loadPrincipal, sessionTokenFrom } from '../http/middleware.js';
import { z } from 'zod';
import { clears } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import type { ShareAccessEvent } from '../chat/sharing.js';
import { TOPICS, type MembershipEvent } from '../platform/bus.js';
import type { JobProgressEvent } from '../platform/jobs.js';
import type { Services } from '../services.js';

export interface SocketData {
  principal: Principal;
  sessionId: string;
  token: string;
  /** Sprint 16: shared conversations this socket watches, with the share that let it in. */
  watching?: Map<string, string>;
  /** Sprint 21 (B-1305): the workspace of each watch that came through a workspace share. */
  watchingVia?: Map<string, string>;
}

export type Realtime = Server<Record<string, never>, Record<string, never>, Record<string, never>, SocketData>;

export const rooms = {
  user: (id: string) => `user:${id}`,
  tenant: (id: string) => `tenant:${id}`,
  session: (id: string) => `session:${id}`,
  /** Holders of a permission in a tenant, for admin-screen updates (pool state, job queues). */
  perm: (tenantId: string, perm: string) => `perm:${tenantId}:${perm}`,
  /** Holders of a permission in any tenant, for platform-wide resources such as pools. */
  platformPerm: (perm: string) => `perm:*:${perm}`,
  /** Readers watching a shared conversation stream (Sprint 16); joined only after the server checked the share. */
  shared: (tenantId: string, conversationId: string) => `shared:${tenantId}:${conversationId}`
};

/** Chat events readers of a shared conversation receive, reduced to what the transcript shows (no thinking). */
const SHARED_EVENTS = new Set(['chat.chunk', 'chat.status', 'chat.done', 'chat.released']);
const MAX_WATCHED = 20;

function forReaders(event: string, data: Record<string, unknown>): Record<string, unknown> | null {
  const ids = { conversationId: data.conversationId, messageId: data.messageId };
  if (event === 'chat.chunk') {
    if (!data.delta && !data.tool) return null;
    return { ...ids, seq: data.seq, ...(data.delta ? { delta: data.delta } : {}), ...(data.tool ? { tool: data.tool } : {}) };
  }
  return { ...ids, state: data.state, ...(data.seq != null ? { seq: data.seq } : {}), ...(data.answerId ? { answerId: data.answerId } : {}) };
}

/** Permissions whose holders receive live admin updates. */
const LIVE_PERMS = ['pools:manage', 'models:manage', 'audit:read', 'tenant:manage', 'flags:review', 'tools:manage', 'zones:manage', 'training:manage'] as const;

/**
 * Socket.io on the same HTTP server (path /socket.io), authenticated by the session cookie at handshake.
 * Only same-origin browsers with a fully signed-in session connect. Each socket joins its user, tenant and session
 * rooms; server code publishes job progress, notifications and stream tokens into those rooms (Sprint 2 onwards).
 * Revoking a session disconnects its sockets at once; sessions are also re-checked every minute for idle expiry.
 */
export function attachRealtime(server: HttpServer, s: Services): { io: Realtime; close: () => Promise<void> } {
  const io: Realtime = new Server(server, {
    path: '/socket.io',
    serveClient: true, // serves /socket.io/socket.io.min.js to the console
    cors: { origin: s.cfg.ORIGIN, credentials: true },
    allowRequest: (req, cb) => cb(null, !req.headers.origin || req.headers.origin === s.cfg.ORIGIN),
    maxHttpBufferSize: 64 * 1024,
    pingInterval: 25_000,
    pingTimeout: 20_000
  });

  // More than one instance: rooms and broadcasts span instances through Redis.
  let pub: Redis | null = null;
  let sub: Redis | null = null;
  if (s.cfg.REDIS_URL) {
    pub = new Redis(s.cfg.REDIS_URL);
    sub = pub.duplicate();
    pub.on('error', (err) => s.log.warn({ err: err.message }, 'socket.io redis error'));
    sub.on('error', (err) => s.log.warn({ err: err.message }, 'socket.io redis error'));
    io.adapter(createAdapter(pub, sub));
  }

  io.use(async (socket, next) => {
    try {
      const token = sessionTokenFrom(socket.handshake.headers.cookie, s.cfg.COOKIE_SECURE);
      const session = token ? await s.sessions.resolve(token) : null;
      if (!token || !session || session.stage !== 'active') return next(new Error('unauthorized'));
      const principal = await loadPrincipal(s, session.tenant_id, session.user_id, { session });
      if (!principal) return next(new Error('unauthorized'));
      socket.data = { principal, sessionId: session.id, token };
      next();
    } catch (err) {
      s.log.warn({ err }, 'socket handshake failed');
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const d = socket.data as SocketData;
    const perms = effectivePermissions(d.principal);
    const permRooms = LIVE_PERMS.filter((x) => perms.has(x)).flatMap((x) => [rooms.perm(d.principal.tenantId, x), rooms.platformPerm(x)]);
    void socket.join([rooms.user(d.principal.userId), rooms.tenant(d.principal.tenantId), rooms.session(d.sessionId), ...permRooms]);
    s.metrics.socketConnections.inc();
    socket.on('disconnect', () => s.metrics.socketConnections.dec());
    // Clients may not choose rooms: membership is decided on the server from the principal.
    socket.emit('ready' as never, { user: d.principal.userId, tenant: d.principal.tenantSlug } as never);

    // Sprint 16 (B-705): a reader asks to watch a conversation shared with them. The server checks the share and the
    // reader's clearance now, and decides the room; the owner already hears their own conversation.
    socket.on('shared.watch' as never, (async (msg: unknown, ack?: (r: unknown) => void) => {
      const reply = typeof ack === 'function' ? ack : () => undefined;
      try {
        const id = z.string().length(26).parse((msg as { conversationId?: unknown } | null)?.conversationId);
        const { c, via } = await s.sharing.readable(d.principal, id);
        if (via === 'owner') return reply({ ok: true, owner: true });
        d.watching ??= new Map();
        if (!d.watching.has(c.id) && d.watching.size >= MAX_WATCHED) return reply({ ok: false, error: 'Watching too many shared conversations at once.' });
        d.watching.set(c.id, via.id);
        d.watchingVia ??= new Map();
        if (via.kind === 'workspace' && via.workspace_id) d.watchingVia.set(c.id, via.workspace_id);
        else d.watchingVia.delete(c.id);
        await socket.join(rooms.shared(c.tenant_id, c.id));
        reply({ ok: true, label: c.label });
      } catch {
        reply({ ok: false, error: 'Not shared with you.' });
      }
    }) as never);
    socket.on('shared.unwatch' as never, ((msg: unknown) => {
      const id = (msg as { conversationId?: unknown } | null)?.conversationId;
      if (typeof id !== 'string' || !d.watching?.has(id)) return;
      d.watching.delete(id);
      d.watchingVia?.delete(id);
      void socket.leave(rooms.shared(d.principal.tenantId, id));
    }) as never);
  });

  /**
   * Access to a shared conversation may have ended. Readers leave the room at once (synchronously, before any further
   * chunk is relayed); those still entitled through another share are let back in after a fresh check.
   */
  const recheck = (e: ShareAccessEvent) => {
    const room = rooms.shared(e.tenantId, e.conversationId);
    const ids = io.of('/').adapter.rooms.get(room);
    if (!ids) return;
    for (const sid of [...ids]) {
      const socket = io.of('/').sockets.get(sid);
      const d = socket?.data as SocketData | undefined;
      if (!socket || !d) continue;
      const via = d.watching?.get(e.conversationId);
      const affected = (e.shareId && via === e.shareId) || (e.label && !clears(d.principal.clearance, e.label));
      if (!affected) continue;
      void socket.leave(room);
      d.watching?.delete(e.conversationId);
      d.watchingVia?.delete(e.conversationId);
      void s.sharing
        .readable(d.principal, e.conversationId)
        .then(async ({ via: again }) => {
          if (again === 'owner' || !socket.connected) return;
          d.watching?.set(e.conversationId, again.id);
          if (again.kind === 'workspace' && again.workspace_id) d.watchingVia?.set(e.conversationId, again.workspace_id);
          await socket.join(room);
        })
        .catch(() => (socket as unknown as Socket).emit('shared.revoked', { conversationId: e.conversationId }));
    }
  };

  /**
   * Sprint 21 (B-1305): a user left workspaces. Their watches through a share to one of those workspaces end at once
   * (the room is left before any further chunk is relayed); one still allowed another way (a direct share, another
   * workspace) is let back in after a fresh check, as for a revoked share.
   */
  const membership = (e: MembershipEvent) => {
    const ids = io.of('/').adapter.rooms.get(rooms.user(e.userId));
    if (!ids) return;
    const lost = new Set(e.workspaceIds);
    for (const sid of [...ids]) {
      const socket = io.of('/').sockets.get(sid);
      const d = socket?.data as SocketData | undefined;
      if (!socket || !d?.watchingVia || d.principal.tenantId !== e.tenantId) continue;
      for (const [conversationId, ws] of [...d.watchingVia]) {
        if (!lost.has(ws)) continue;
        const room = rooms.shared(e.tenantId, conversationId);
        void socket.leave(room);
        d.watching?.delete(conversationId);
        d.watchingVia.delete(conversationId);
        void s.sharing
          .readable(d.principal, conversationId)
          .then(async ({ via: again }) => {
            if (again === 'owner' || !socket.connected) return;
            d.watching?.set(conversationId, again.id);
            if (again.kind === 'workspace' && again.workspace_id) d.watchingVia?.set(conversationId, again.workspace_id);
            await socket.join(room);
          })
          .catch(() => (socket as unknown as Socket).emit('shared.revoked', { conversationId }));
      }
    }
  };

  // Every instance hears revocations through the bus and closes the sockets it holds.
  const offs = [
    s.bus.on<string[]>(TOPICS.sessionsRevoked, (ids) => {
      for (const id of ids) {
        io.local.to(rooms.session(id)).emit('session.revoked' as never);
        io.local.in(rooms.session(id)).disconnectSockets(true);
      }
    }),
    // Job progress goes to the submitter's sockets; the adapter carries it to other instances.
    s.bus.on<JobProgressEvent>(TOPICS.jobProgress, (e) => {
      if (e.createdBy) io.to(rooms.user(e.createdBy)).emit('job.progress' as never, e as never);
    }),
    s.bus.on<{ userId: string; notification: unknown }>(TOPICS.notification, (e) => {
      io.local.to(rooms.user(e.userId)).emit('notification' as never, e.notification as never);
    }),
    s.bus.on<{ userId: string; tenantId?: string; event: string; data: Record<string, unknown> }>(TOPICS.chatEvent, (e) => {
      io.local.to(rooms.user(e.userId)).emit(e.event as never, e.data as never);
      // Readers of a shared conversation (Sprint 16): the answer text as it is released, nothing else.
      if (e.tenantId && typeof e.data?.conversationId === 'string' && SHARED_EVENTS.has(e.event)) {
        const data = forReaders(e.event, e.data);
        if (data) io.local.to(rooms.shared(e.tenantId, e.data.conversationId)).except(rooms.user(e.userId)).emit(e.event as never, data as never);
      }
    }),
    s.bus.on<ShareAccessEvent>(TOPICS.shareAccess, (e) => recheck(e)),
    s.bus.on<MembershipEvent>(TOPICS.workspaceMembership, (e) => membership(e)),
    s.bus.on<{ tenantId: string | null; perm: string; event: string; data: unknown }>(TOPICS.poolState, (e) => {
      io.local.to(e.tenantId ? rooms.perm(e.tenantId, e.perm) : rooms.platformPerm(e.perm)).emit(e.event as never, e.data as never);
    }),
    // Agent-run steps and script runs: to the owner, and waiting approvals to the tenant's tool admins.
    s.bus.on<{ userId?: string; tenantId?: string; perm?: string; event: string; data: unknown }>(TOPICS.runEvent, (e) => {
      if (e.userId) io.local.to(rooms.user(e.userId)).emit(e.event as never, e.data as never);
      else if (e.tenantId && e.perm) io.local.to(rooms.perm(e.tenantId, e.perm)).emit(e.event as never, e.data as never);
    })
  ];

  const sweep = setInterval(async () => {
    for (const [, socket] of io.of('/').sockets) {
      const d = socket.data as SocketData | undefined;
      if (!d) continue;
      const live = await s.sessions.resolve(d.token).catch(() => null);
      if (!live) socket.disconnect(true);
    }
  }, 60_000);
  sweep.unref();

  return {
    io,
    close: async () => {
      clearInterval(sweep);
      for (const off of offs) off();
      io.disconnectSockets(true);
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await Promise.all([pub?.quit().catch(() => undefined), sub?.quit().catch(() => undefined)]);
    }
  };
}
