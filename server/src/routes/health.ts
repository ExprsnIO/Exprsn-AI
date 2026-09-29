import { Router } from 'express';
import { safeEqual } from '../crypto/index.js';
import { pendingMigrations } from '../db/knex.js';
import { notFound, unauthorized } from '../http/problem.js';
import type { Services } from '../services.js';

export function healthRoutes(s: Services, state: { shuttingDown: boolean }): Router {
  const r = Router();

  /** Liveness: the process is up and the event loop answers. */
  r.get('/healthz', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: 'ok' });
  });

  /** Readiness: database reachable and fully migrated, and not draining. */
  r.get('/readyz', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const checks: Record<string, string> = {};
    let ok = !state.shuttingDown;
    checks.shutdown = state.shuttingDown ? 'draining' : 'ok';
    try {
      await s.db.raw('select 1');
      checks.database = 'ok';
      const pending = await pendingMigrations(s.db);
      checks.migrations = pending ? `${pending} pending` : 'ok';
      if (pending) ok = false;
    } catch (err) {
      checks.database = (err as Error).message;
      ok = false;
    }
    res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not ready', checks });
  });

  /** Prometheus metrics. Needs METRICS_TOKEN as a bearer token; without one it is served only outside production. */
  r.get('/metrics', async (req, res) => {
    const token = s.cfg.METRICS_TOKEN;
    if (token) {
      const presented = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? '';
      if (!safeEqual(presented, token)) throw unauthorized('Metrics need the metrics token.');
    } else if (s.cfg.NODE_ENV === 'production') {
      throw notFound('Metrics endpoint');
    }
    res.setHeader('Content-Type', s.metrics.registry.contentType);
    res.send(await s.metrics.registry.metrics());
  });

  return r;
}
