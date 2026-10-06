import { createServer } from 'node:http';
import { loadConfig } from './config/index.js';
import { createDb, migrate, pendingMigrations } from './db/knex.js';
import { createApp, type AppState } from './http/app.js';
import { createLogger } from './observability/index.js';
import { attachRealtime } from './realtime/socket.js';
import { attachLabelStream } from './atproto/stream.js';
import { attachRepoStream } from './atproto/pds/sequencer.js';
import { createServices, startSchedules } from './services.js';
import { bootstrap } from './bootstrap.js';
import { schemaStatus } from './db/schema.js';
import { startOpsWatch } from './ops/watch.js';
import { applyStoredOverrides } from './config/settings.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(cfg.LOG_LEVEL, cfg.NODE_ENV === 'development' && process.stdout.isTTY);
  const db = createDb(cfg);

  // Sprint 22 (B-1403): a build older than the database refuses to start rather than run against a schema it does not know.
  const schema = await schemaStatus(db);
  if (schema.state === 'behind') throw new Error(schema.reason ?? 'The database schema is newer than this build');

  if (cfg.DB_MIGRATE_ON_START) {
    const applied = await migrate(db);
    if (applied.length) log.info({ applied }, 'database migrated');
  } else if (await pendingMigrations(db)) {
    throw new Error('Database has pending migrations; run `exprsn-ai migrate` or set DB_MIGRATE_ON_START=true');
  }

  // 1.6.0 (B-4205): approved setting overrides from the database, before anything reads the configuration.
  const overrides = await applyStoredOverrides(cfg, db, log);
  if (overrides.applied.length) {
    log.level = cfg.LOG_LEVEL;
    log.info({ settings: overrides.applied }, 'setting overrides applied');
  }

  const services = createServices(cfg, db, log);
  await bootstrap(services);
  await services.storage.syncStore(); // 1.6.0 (B-4204): a blob store migration in progress or finished

  const state: AppState = { shuttingDown: false };
  const app = createApp(services, state);
  const server = createServer(app);
  server.headersTimeout = 65_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 61_000;
  const realtime = attachRealtime(server, services);
  // Sprint 25 (B-1610): com.atproto.label.subscribeLabels, a plain WebSocket next to Socket.io.
  const labelStream = attachLabelStream(server, services);
  // 1.5.0, Sprint 31 (B-2904): the PDS's com.atproto.sync.subscribeRepos.
  const repoStream = attachRepoStream(server, services);
  if (cfg.WORKERS_ENABLED) {
    services.jobs.start();
    startSchedules(services);
  }
  services.gateway.start();
  const stopWatch = startOpsWatch(services); // Sprint 22: schema handshake, Redis probe, NTP measurement
  services.storage.start(); // 1.6.0 (B-4204): follows the blob store mode
  services.settings.start(); // 1.6.0 (B-4205): reports what this instance reads; applies hot overrides

  const housekeeping = setInterval(() => {
    void Promise.all([services.sessions.purge(), services.throttle.purge(), services.account.purge()]).catch((err) => log.warn({ err }, 'housekeeping failed'));
  }, 15 * 60_000);
  housekeeping.unref();

  await new Promise<void>((resolve) => server.listen(cfg.PORT, cfg.HOST, resolve));
  log.info({ url: cfg.PUBLIC_URL, port: cfg.PORT, db: cfg.DB_CLIENT }, 'exprsn-ai listening');

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    state.shuttingDown = true;
    log.info({ signal }, 'shutting down: draining connections');
    const force = setTimeout(() => {
      log.error('shutdown timed out; exiting');
      process.exit(1);
    }, 25_000);
    force.unref();
    clearInterval(housekeeping);
    stopWatch();
    server.closeIdleConnections();
    await labelStream.close();
    await repoStream.close();
    await realtime.close(); // also stops the HTTP server accepting new connections
    await services.close();
    await db.destroy();
    log.info('stopped');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => log.error({ err }, 'unhandled rejection'));
}

main().catch((err: Error) => {
  process.stderr.write(`exprsn-ai failed to start: ${err.message}\n`);
  process.exit(1);
});
