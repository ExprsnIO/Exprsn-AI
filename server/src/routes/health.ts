import { Router } from 'express';
import { safeEqual } from '../crypto/index.js';
import { notFound, unauthorized } from '../http/problem.js';
import type { Services } from '../services.js';

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
    const checks: Record<string, string> = {};
    let ok = !state.shuttingDown;
    checks.shutdown = state.shuttingDown ? 'draining' : 'ok';
    try {
      await s.db.raw('select 1');
      checks.database = 'ok';
      // Sprint 22 (B-1403): the schema handshake. An instance older than the database says so and is not ready.
      const st = await s.schema.check();
      checks.migrations = st.pending.length ? `${st.pending.length} pending` : 'ok';
      checks.schema = st.state === 'behind' ? `behind: ${st.reason}` : 'ok';
      if (st.state !== 'current') ok = false;
    } catch (err) {
      s.log.warn({ err: (err as Error).message }, 'readiness: database unavailable');
      checks.database = 'unavailable';
      ok = false;
    }
    // Without the KMS nothing sealed opens; without the blob store exports, attachments and checkpoints fail.
    const [kms, blobs] = await Promise.all([s.kms.health(), s.blobs.health()]);
    if (!kms.ok) s.log.warn({ detail: kms.detail }, 'readiness: KMS unavailable');
    if (!blobs.ok) s.log.warn({ detail: blobs.detail }, 'readiness: blob store unavailable');
    checks.kms = kms.ok ? 'ok' : 'unavailable';
    checks.blobs = blobs.ok ? 'ok' : 'unavailable';
    if (!kms.ok || !blobs.ok) ok = false;
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
