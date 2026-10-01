# Observability

Dashboards and alert rules for the server's `/metrics` (Sprint 22, B-1402), and how tracing fits in.

| Path | What it is |
| --- | --- |
| `prometheus/exprsn-ai.rules.yml` | Recording rules and alerts: error rate, latency, event loop lag, memory, failed sign-ins, job backlog and failures, rate limits counting per instance, an instance older than the schema, zone policy drift and apply failures, clock skew, dropped trace spans |
| `prometheus/exprsn-ai.rules.test.yml` | `promtool test rules` cases for some of the alerts |
| `grafana/exprsn-ai-overview.json` | Traffic, 5xx share, request time percentiles, slowest routes, sign-ins, sockets, CPU, memory, event loop |
| `grafana/exprsn-ai-operations.json` | Rate-limit sharing, instances behind the schema, zone drift, NTP offset, jobs, trace export |

What to do when an alert fires: [docs/runbooks/alerts.md](../../docs/runbooks/alerts.md).

## Prometheus

Scrape `/metrics` with the bearer token (`METRICS_TOKEN`); the Helm chart's ServiceMonitor does this when
`serviceMonitor.enabled`. Then load the rules:

```yaml
# prometheus.yml
rule_files:
  - /etc/prometheus/rules/exprsn-ai.rules.yml
```

With the Prometheus Operator, wrap the `groups:` list in a PrometheusRule:

```sh
kubectl -n monitoring create configmap exprsn-ai-rules --from-file=deploy/observability/prometheus/exprsn-ai.rules.yml   # plain Prometheus
# or: a PrometheusRule whose spec is the file's content (spec.groups)
```

Check them as CI does:

```sh
docker run --rm -v "$PWD/deploy/observability/prometheus:/rules:ro" -w /rules --entrypoint /bin/promtool \
  prom/prometheus:v3.5.0 check rules exprsn-ai.rules.yml
docker run --rm -v "$PWD/deploy/observability/prometheus:/rules:ro" -w /rules --entrypoint /bin/promtool \
  prom/prometheus:v3.5.0 test rules exprsn-ai.rules.test.yml
```

## Grafana

Import each JSON file (Dashboards > New > Import), or provision them from a ConfigMap with the Grafana sidecar
(`grafana_dashboard: "1"` label). Both have a `datasource` variable (pick the Prometheus that scrapes the server) and a
`job` variable.

## Tracing

Set `OTEL_EXPORTER_OTLP_ENDPOINT` to an OTLP/HTTP receiver (an OpenTelemetry Collector on port 4318, Grafana Tempo,
Jaeger). The server exports JSON spans itself, without the OpenTelemetry SDK; see `docs/deploy.md` for the settings and
`server/src/observability/tracing.ts` for the attribute allow-list. A trace id from a log line, an error's problem
details or the `X-Trace-Id` header finds the trace.
