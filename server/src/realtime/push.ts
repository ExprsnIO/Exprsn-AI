import type { Socket } from 'socket.io';
import { z } from 'zod';
import type { Principal } from '../authz/policy.js';
import { ACK_TOPIC, SOCKET_TOPIC, type SocketPush } from '../push/service.js';
import type { Services } from '../services.js';

/*
 * 1.9.0 (B-151, B-152): push over the console's own socket. A `push.socket` bus event (from the delivery job on any
 * instance) is emitted as `push.notification {deliveryId, notification}` to the recipient's sockets on this instance,
 * with a Socket.IO acknowledgement; the first socket that acknowledges (the callback, or `push.ack {deliveryId}`)
 * publishes `push.ack` with the socket's own user, so only the recipient can mark a delivery acknowledged.
 */

interface Data {
  principal: Principal;
}

interface Io {
  of(nsp: '/'): { adapter: { rooms: Map<string, Set<string>> }; sockets: Map<string, Socket> };
}

const ackMsg = z.object({ deliveryId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/) }).strict();

export function attachPushChannel(io: Io, s: Services, userRoom: (userId: string) => string): { onConnection(socket: Socket): void; offs: (() => void)[] } {
  const ack = (d: Data, deliveryId: string) => s.bus.publish(ACK_TOPIC, { deliveryId, userId: d.principal.userId });
  const offs = [
    s.bus.on<SocketPush>(SOCKET_TOPIC, (e) => {
      if (!e?.deliveryId || !e.userId) return;
      for (const sid of io.of('/').adapter.rooms.get(userRoom(e.userId)) ?? []) {
        const socket = io.of('/').sockets.get(sid);
        const d = socket?.data as Data | undefined;
        if (!socket || !d || d.principal.tenantId !== e.tenantId || d.principal.userId !== e.userId) continue;
        socket.timeout(60_000).emit('push.notification', { deliveryId: e.deliveryId, notification: e.notification }, (err: unknown) => {
          if (!err) ack(d, e.deliveryId);
        });
      }
    })
  ];
  return {
    onConnection(socket: Socket) {
      socket.on('push.ack', (msg: unknown) => {
        const r = ackMsg.safeParse(msg);
        const d = socket.data as Data | undefined;
        if (r.success && d) ack(d, r.data.deliveryId);
      });
    },
    offs
  };
}
