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
import { redisRequirement } from './ops/redis-required.js';
import { bootStep, openVault } from './ops/boot.js';

async function main(): Promise<void> {
  // 1.7.0 (B-9202): the start order, each step named: configuration, database, KMS, data keys, the vault's platform
  // scope, sessions and API keys, then the authentication middleware. A step that fails stops the process.
  const cfg = await bootStep('configuration', () => loadConfig());
  const log = createLogger(cfg.LOG_LEVEL, cfg.NODE_ENV === 'development' && process.stdout.isTTY);
  const db = createDb(cfg);

  // Sprint 22 (B-1403): a build older than the database refuses to start rather than run against a schema it does not know.
  await bootStep('database', async () => {
    const schema = await schemaStatus(db);
    if (schema.state === 'behind') throw new Error(schema.reason ?? 'The database schema is newer than this build');

    if (cfg.DB_MIGRATE_ON_START) {
      const applied = await migrate(db);
      if (applied.length) log.info({ applied }, 'database migrated');
    } else if (await pendingMigrations(db)) {
      throw new Error('Database has pending migrations; run `exprsn-ai migrate` or set DB_MIGRATE_ON_START=true');
    }
  });

  // 1.6.0 (B-4205): approved setting overrides from the database, before anything reads the configuration.
  const overrides = await applyStoredOverrides(cfg, db, log);
  if (overrides.applied.length) {
    log.level = cfg.LOG_LEVEL;
    log.info({ settings: overrides.applied }, 'setting overrides applied');
  }

  const services = createServices(cfg, db, log);
  // 1.7.0 (B-9001, D17): more than one process on this database needs Redis; say why and stop before serving.
  const needsRedis = await redisRequirement(cfg, db, { id: services.instances.id }, services.instances.staleMs);
  if (needsRedis) {
    await services.close().catch(() => undefined);
    throw new Error(needsRedis);
  }
  await bootstrap(services);
  // 1.7.0 (B-9202): after the default tenant exists (the platform scope's audit entries go to its chain), before the app.
  try {
    log.info({ steps: await openVault(services) }, 'vault open');
  } catch (err) {
    await services.close().catch(() => undefined);
    throw err;
  }
  await services.storage.syncStore(); // 1.6.0 (B-4204): a blob store migration in progress or finished

  const state: AppState = { shuttingDown: false };
  const app = await bootStep('authentication', () => createApp(services, state));
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
  services.cloud.autoscale.start(); // 1.9.99-final, Sprint 60 (B-10402): scale-to-zero and autoscale of cloud GPU pools, every 30 s
  const stopWatch = startOpsWatch(services); // Sprint 22: schema handshake, Redis probe, NTP measurement
  services.storage.start(); // 1.6.0 (B-4204): follows the blob store mode
  services.settings.start(); // 1.6.0 (B-4205): reports what this instance reads; applies hot overrides

  const housekeeping = setInterval(() => {
    void Promise.all([services.sessions.purge(), services.apiKeys.reconcileLeases(), services.throttle.purge(), services.account.purge()]).catch((err) => log.warn({ err }, 'housekeeping failed'));
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
