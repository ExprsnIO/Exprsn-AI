import client from 'prom-client';
import { registerCloudMetrics } from '../cloud/cloud-metrics.js';
import type { Services } from '../services.js';

/*
 * Sprint 22: operational gauges and counters for the dashboards and alert rules in deploy/observability/ (B-1402),
 * read when Prometheus scrapes. Each value is a count or a state, never tenant data.
 */
export function registerOpsMetrics(s: Services): void {
  const registers = [s.metrics.registry];

  new client.Gauge({
    name: 'exprsn_jobs',
    help: 'Jobs by state (queued, running, failed in the last hour)',
    labelNames: ['state'],
    registers,
    async collect() {
      try {
        const rows = (await s.db('jobs').whereIn('state', ['queued', 'running']).groupBy('state').select('state').count({ n: '*' })) as { state: string; n: number | string }[];
        const failed = (await s.db('jobs').where({ state: 'failed' }).andWhere('finished_at', '>=', Date.now() - 3_600_000).count({ n: '*' }).first()) as { n?: number | string } | undefined;
        this.reset();
        this.set({ state: 'queued' }, 0);
        this.set({ state: 'running' }, 0);
        for (const r of rows) this.set({ state: r.state }, Number(r.n));
        this.set({ state: 'failed_1h' }, Number(failed?.n ?? 0));
      } catch {
        // the database is down: the readiness probe and the HTTP error rate say so
      }
    }
  });

  new client.Gauge({
    name: 'exprsn_jobs_oldest_queued_seconds',
    help: 'Age of the oldest job due and still queued',
    registers,
    async collect() {
      try {
        const r = (await s.db('jobs').where({ state: 'queued' }).andWhere('run_at', '<=', Date.now()).min({ t: 'run_at' }).first()) as { t?: number | string | null } | undefined;
        this.set(r?.t ? Math.max(0, (Date.now() - Number(r.t)) / 1000) : 0);
      } catch {
        /* see above */
      }
    }
  });

  new client.Gauge({
    name: 'exprsn_ratelimit_degraded',
    help: '1 while Redis is configured but not answering, so rate limits count per instance (B-1407)',
    registers,
    collect() {
      this.set(s.counters.health?.().degraded ? 1 : 0);
    }
  });

  new client.Counter({
    name: 'exprsn_ratelimit_fallback_hits_total',
    help: 'Rate-limit hits counted in memory because Redis failed',
    registers,
    collect() {
      this.reset();
      this.inc(s.counters.health?.().fallbacks ?? 0);
    }
  });

  new client.Gauge({
    name: 'exprsn_schema_behind',
    help: '1 when the database has migrations this build does not know; the instance takes no jobs (B-1403)',
    registers,
    collect() {
      this.set(s.schema.refusal() ? 1 : 0);
    }
  });

  new client.Counter({
    name: 'exprsn_trace_spans_total',
    help: 'Spans handled by the OTLP exporter, by outcome: exported, dropped (queue full) or failed (collector refused) (B-1401)',
    labelNames: ['outcome'],
    registers,
    collect() {
      const st = s.tracer.stats;
      this.reset();
      this.inc({ outcome: 'exported' }, st.exported);
      this.inc({ outcome: 'dropped' }, st.dropped);
      this.inc({ outcome: 'failed' }, st.failed);
    }
  });

  new client.Gauge({
    name: 'exprsn_trace_spans_queued',
    help: 'Spans waiting for export',
    registers,
    collect() {
      this.set(s.tracer.stats.queued);
    }
  });

  new client.Gauge({
    name: 'exprsn_zone_cluster_objects',
    help: 'Zone NetworkPolicies applied in-cluster, by state (B-1405)',
    labelNames: ['state'],
    registers,
    async collect() {
      try {
        const rows = (await s.db('zone_cluster_objects').groupBy('state').select('state').count({ n: '*' })) as { state: string; n: number | string }[];
        this.reset();
        for (const st of ['applied', 'drift', 'missing', 'error', 'pending']) this.set({ state: st }, 0);
        for (const r of rows) this.set({ state: r.state }, Number(r.n));
      } catch {
        /* see above */
      }
    }
  });

  new client.Gauge({
    name: 'exprsn_clock_offset_seconds',
    help: 'The last clock offset measured against the NTP servers (median), in seconds (B-1406)',
    registers,
    collect() {
      const v = s.ops.lastClockOffsetMs;
      if (v != null) this.set(v / 1000);
    }
  });

  // 1.9.0 (B-152): push deliveries per provider: outcomes and send latency (labels are the kind and the provider's id).
  const pushSends = new client.Counter({ name: 'exprsn_push_deliveries_total', help: 'Push and socket deliveries by provider kind, provider and outcome (sent, failed, dropped, retrying) (B-152)', labelNames: ['kind', 'provider', 'outcome'], registers });
  const pushLatency = new client.Histogram({ name: 'exprsn_push_send_seconds', help: 'Time to a provider\'s answer, or to a socket acknowledgement, per provider (B-152)', labelNames: ['kind', 'provider'], buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10], registers });
  s.push.onSend = (e) => {
    pushSends.inc({ kind: e.kind, provider: e.providerId, outcome: e.outcome });
    pushLatency.observe({ kind: e.kind, provider: e.providerId }, e.latencyMs / 1000);
  };

  // 1.9.99-final (B-10702): the cloud plane's operations, applies, drift, budgets and GPU nodes (`cloud/cloud-metrics.ts`).
  registerCloudMetrics(s);
}
