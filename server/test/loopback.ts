import { createServer, type RequestListener, type Server } from 'node:http';

/**
 * Test apps served on 127.0.0.1 before SuperTest sees them. SuperTest's own server listens on the wildcard address,
 * and on macOS another process (an Ollama model runner, for one) may then bind 127.0.0.1 on that same port and take
 * the requests meant for the test. A server bound to 127.0.0.1 first cannot be shadowed that way: the second bind is
 * refused. `setup-loopback.ts` makes `request(app)` use the server registered here.
 */
const servers = new WeakMap<object, Server>();

export async function serveOnLoopback(app: RequestListener): Promise<Server> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  servers.set(app, server);
  return server;
}

export const loopbackServerFor = (app: unknown): Server | undefined => (typeof app === 'function' ? servers.get(app) : undefined);

export async function closeLoopback(app: object): Promise<void> {
  const server = servers.get(app);
  if (!server) return;
  servers.delete(app);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
