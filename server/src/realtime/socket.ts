import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { loadPrincipal, sessionTokenFrom } from '../http/middleware.js';
import type { Principal } from '../authz/policy.js';
import { EVENTS, type Services } from '../services.js';

export interface SocketData {
  principal: Principal;
  sessionId: string;
  token: string;
}

export type Realtime = Server<Record<string, never>, Record<string, never>, Record<string, never>, SocketData>;

export const rooms = {
  user: (id: string) => `user:${id}`,
  tenant: (id: string) => `tenant:${id}`,
  session: (id: string) => `session:${id}`
};

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
    void socket.join([rooms.user(d.principal.userId), rooms.tenant(d.principal.tenantId), rooms.session(d.sessionId)]);
    s.metrics.socketConnections.inc();
    socket.on('disconnect', () => s.metrics.socketConnections.dec());
    // Clients may not choose rooms: membership is decided on the server from the principal.
    socket.emit('ready' as never, { user: d.principal.userId, tenant: d.principal.tenantSlug } as never);
  });

  const onRevoked = (ids: string[]) => {
    for (const id of ids) {
      io.to(rooms.session(id)).emit('session.revoked' as never);
      io.in(rooms.session(id)).disconnectSockets(true);
    }
  };
  s.events.on(EVENTS.sessionsRevoked, onRevoked);

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
      s.events.off(EVENTS.sessionsRevoked, onRevoked);
      io.disconnectSockets(true);
      await new Promise<void>((resolve) => io.close(() => resolve()));
    }
  };
}
