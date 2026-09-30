import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { loadPrincipal, sessionTokenFrom } from '../http/middleware.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { TOPICS } from '../platform/bus.js';
import type { JobProgressEvent } from '../platform/jobs.js';
import type { Services } from '../services.js';

export interface SocketData {
  principal: Principal;
  sessionId: string;
  token: string;
}

export type Realtime = Server<Record<string, never>, Record<string, never>, Record<string, never>, SocketData>;

export const rooms = {
  user: (id: string) => `user:${id}`,
  tenant: (id: string) => `tenant:${id}`,
  session: (id: string) => `session:${id}`,
  /** Holders of a permission in a tenant, for admin-screen updates (pool state, job queues). */
  perm: (tenantId: string, perm: string) => `perm:${tenantId}:${perm}`,
  /** Holders of a permission in any tenant, for platform-wide resources such as pools. */
  platformPerm: (perm: string) => `perm:*:${perm}`
};

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
  });

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
    s.bus.on<{ userId: string; event: string; data: unknown }>(TOPICS.chatEvent, (e) => {
      io.local.to(rooms.user(e.userId)).emit(e.event as never, e.data as never);
    }),
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
