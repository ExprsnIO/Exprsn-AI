import client from 'prom-client';
import type { Services } from '../services.js';
import { PROVIDERS } from './types.js';

/*
 * 1.9.99-final, Sprint 62 (B-10606): the spend anomaly metrics, beside the cloud plane's (`cloud-metrics.ts`). Labels
 * are providers only, never an account, a deployment or a tenant.
 *
 *   exprsn_cloud_anomalies_total{provider}   anomalies detected (counted where they are stored, `anomalies.ts`); a
 *                                            repeat inside an acknowledgement's quiet days is not counted
 *   exprsn_cloud_anomalies_open{provider}    anomalies still open whose day is in the last 7 days, read from the
 *                                            database at each scrape on every instance (rules take max without instance)
 */

export interface AnomalyMetrics {
  detected(provider: string): void;
}

const byRegistry = new WeakMap<client.Registry, AnomalyMetrics>();
const gauges = new WeakSet<client.Registry>();
const DAY = 86_400_000;

export function anomalyMetrics(registry: client.Registry): AnomalyMetrics {
  const have = byRegistry.get(registry);
  if (have) return have;
  const c = new client.Counter({ name: 'exprsn_cloud_anomalies_total', help: 'Cloud spend anomalies detected: a service\'s daily spend in an account well above its 14-day baseline, by provider (B-10606)', labelNames: ['provider'], registers: [registry] });
  const m: AnomalyMetrics = { detected: (provider) => c.inc({ provider }) };
  byRegistry.set(registry, m);
  return m;
}

/** The counter and the scrape-time gauge, registered at start (from `registerCloudMetrics`); idempotent. */
export function registerAnomalyMetrics(s: Services): void {
  const registry = s.metrics.registry;
  anomalyMetrics(registry);
  if (gauges.has(registry)) return;
  gauges.add(registry);
  new client.Gauge({
    name: 'exprsn_cloud_anomalies_open',
    help: 'Open cloud spend anomalies (not acknowledged) whose day is in the last 7 days, by provider (B-10606)',
    labelNames: ['provider'],
    registers: [registry],
    async collect() {
      try {
        const since = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10);
        const rows = (await s.db('cloud_anomalies').where({ state: 'open' }).where('day', '>=', since).groupBy('provider').select('provider').count({ n: '*' })) as { provider: string; n: number | string }[];
        this.reset();
        for (const p of PROVIDERS) this.set({ provider: p }, 0);
        for (const r of rows) this.set({ provider: r.provider }, Number(r.n));
      } catch {
        // migration 166 not applied yet, or the database is down
      }
    }
  });
}
