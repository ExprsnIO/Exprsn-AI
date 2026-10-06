import { Router } from 'express';
import { safeEqual } from '../crypto/index.js';
import { notFound, unauthorized } from '../http/problem.js';
import type { Services } from '../services.js';
import { readiness } from '../ops/instances.js';

export function healthRoutes(s: Services, state: { shuttingDown: boolean }): Router {
  const r = Router();

  /** Liveness: the process is up and the event loop answers. */
  r.get('/healthz', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: 'ok' });
  });

  /**
   * Readiness: database reachable and fully migrated, KMS and blob store answering, and not draining. The endpoint
   * is public, so a failing dependency is reported as "unavailable" and its error (hosts, paths, drivers) is logged.
   */
  r.get('/readyz', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    // 1.6.0 (B-4202): the same checks the instance heartbeat records for the Overview; a drained instance is not ready.
    const { ok, checks } = await readiness(s, state.shuttingDown);
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
